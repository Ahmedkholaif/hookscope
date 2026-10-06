import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { Bin, BinStore, type CapturedRequest } from './bins.js';
import { verifySignature } from './signature.js';

export interface Options {
  maxBodyBytes?: number; // larger captures get 413
  storedBodyBytes?: number; // bodies are stored up to this size, then truncated
  rateLimit?: { perSecond: number; burst: number }; // per client IP, on the capture endpoint
  slowClientBytes?: number; // SSE buffer limit before a slow consumer is dropped
  heartbeatMs?: number;
  staticDir?: string; // built React app
}

const SAFE_STATUS = new Set([200, 201, 202, 204, 400, 401, 404, 409, 410, 429, 500, 502, 503, 504]);

/**
 * hookscope's HTTP server, built on node:http only (no framework, no runtime
 * dependencies). Node is good at exactly this kind of work: lots of
 * concurrent, mostly idle connections (SSE), streaming bodies with
 * backpressure, and fanning events out from one emitter to many sockets.
 */
export function createApp(opts: Options = {}) {
  const maxBody = opts.maxBodyBytes ?? 1 << 20;
  const storedBody = opts.storedBodyBytes ?? 256 << 10;
  const rate = opts.rateLimit ?? { perSecond: 50, burst: 100 };
  const slowClient = opts.slowClientBytes ?? 1 << 20;
  const store = new BinStore();
  const buckets = new Map<string, { tokens: number; at: number }>();
  const streams = new Set<ServerResponse>();

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
      if (!(err instanceof BodyTooLarge)) console.error(err);
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    // ---- capture: ANY /h/:bin[/anything]
    if (parts[0] === 'h' && parts[1]) return capture(req, res, url, parts[1], '/' + parts.slice(2).join('/'));

    // ---- API
    if (parts[0] === 'api' && parts[1] === 'bins') {
      if (parts.length === 2 && req.method === 'POST') return json(res, 201, store.create());
      const bin = parts[2] ? store.get(parts[2]) : undefined;
      if (!bin) return json(res, 404, { error: 'bin not found' });
      const [, , , sub, rid, action] = parts;

      if (!sub && req.method === 'GET') return json(res, 200, bin);
      if (!sub && req.method === 'PATCH') return updateSettings(req, res, bin);
      if (sub === 'stream' && req.method === 'GET') return stream(req, res, bin);
      if (sub === 'requests' && !rid && req.method === 'GET') return json(res, 200, { requests: bin.list() });
      if (sub === 'requests' && !rid && req.method === 'DELETE') {
        bin.clear();
        return void res.writeHead(204).end();
      }
      if (sub === 'requests' && rid && action === 'replay' && req.method === 'POST') return replay(req, res, bin, Number(rid));
      return json(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET' && opts.staticDir) return serveStatic(res, opts.staticDir, url.pathname);
    json(res, 404, { error: 'not found' });
  }

  // Streams the body in chunks and stops reading the moment it exceeds the
  // limit, so an oversized upload can't make the process buffer it.
  async function readBody(req: IncomingMessage, limit = maxBody): Promise<Buffer> {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) throw new BodyTooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) throw new BodyTooLarge();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  async function capture(req: IncomingMessage, res: ServerResponse, url: URL, binId: string, path: string) {
    const bin = store.get(binId);
    if (!bin) return json(res, 404, { error: 'bin not found' });
    const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() || req.socket.remoteAddress || '';
    if (!allow(ip)) return json(res, 429, { error: 'rate limited' }, { 'Retry-After': '1' });

    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (err) {
      if (err instanceof BodyTooLarge) {
        res.setHeader('Connection', 'close');
        return json(res, 413, { error: `body exceeds ${maxBody} bytes` });
      }
      throw err;
    }

    const { status, delayMs, secret } = bin.settings;
    const stored = body.subarray(0, storedBody);
    const text = stored.toString('utf8');
    const isText = Buffer.from(text, 'utf8').equals(stored);
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]] = req.rawHeaders[i + 1];

    bin.add({
      method: req.method ?? 'GET',
      path,
      query: url.search,
      headers,
      body: isText ? text : stored.toString('base64'),
      bodyEncoding: isText ? 'utf8' : 'base64',
      size: body.length,
      truncated: body.length > storedBody,
      ip,
      receivedAt: new Date().toISOString(),
      signature: verifySignature(secret, req.headers['hookline-signature'] as string | undefined, body),
      respondedWith: status,
    });

    if (delayMs) await sleep(delayMs);
    json(res, status, { ok: status < 300, bin: bin.id }, status === 429 || status === 503 ? { 'Retry-After': '5' } : {});
  }

  async function updateSettings(req: IncomingMessage, res: ServerResponse, bin: Bin) {
    let patch: Partial<{ status: number; delayMs: number; secret: string | null }>;
    try {
      patch = JSON.parse((await readBody(req, 4096)).toString() || '{}');
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    if (patch.status !== undefined && !SAFE_STATUS.has(patch.status)) return json(res, 422, { error: `status must be one of ${[...SAFE_STATUS]}` });
    if (patch.delayMs !== undefined && !(Number.isInteger(patch.delayMs) && patch.delayMs >= 0 && patch.delayMs <= 30_000)) {
      return json(res, 422, { error: 'delayMs must be 0-30000' });
    }
    if (patch.status !== undefined) bin.settings.status = patch.status;
    if (patch.delayMs !== undefined) bin.settings.delayMs = patch.delayMs;
    if (patch.secret !== undefined) bin.settings.secret = patch.secret || undefined;
    json(res, 200, bin);
  }

  /**
   * Server-Sent Events. On (re)connect the browser's EventSource sends
   * Last-Event-ID automatically, and we replay what it missed from the ring
   * buffer, so a dropped connection loses nothing. A client that can't keep
   * up (its socket buffer passes `slowClient` bytes) is disconnected instead
   * of growing server memory without bound; it reconnects and resumes.
   */
  function stream(req: IncomingMessage, res: ServerResponse, bin: Bin) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');

    const send = (r: CapturedRequest) => {
      if (res.writableLength > slowClient) return res.destroy();
      res.write(`id: ${r.id}\nevent: request\ndata: ${JSON.stringify(r)}\n\n`);
    };
    const lastId = Number(req.headers['last-event-id'] ?? new URL(req.url!, 'http://x').searchParams.get('after') ?? 0);
    if (lastId) for (const r of bin.since(lastId)) send(r);

    const beat = setInterval(() => res.write(': ping\n\n'), opts.heartbeatMs ?? 15_000);
    bin.on('request', send);
    streams.add(res);
    res.on('close', () => {
      clearInterval(beat);
      bin.off('request', send);
      streams.delete(res);
    });
  }

  async function replay(req: IncomingMessage, res: ServerResponse, bin: Bin, rid: number) {
    const original = bin.get(rid);
    if (!original) return json(res, 404, { error: 'request not found' });
    let target: URL;
    try {
      target = new URL(JSON.parse((await readBody(req, 4096)).toString()).url);
      if (!/^https?:$/.test(target.protocol)) throw new Error();
    } catch {
      return json(res, 422, { error: 'url must be an absolute http(s) URL' });
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(original.headers)) {
      if (!/^(host|content-length|connection|transfer-encoding|keep-alive)$/i.test(k)) headers.set(k, v);
    }
    const body = ['GET', 'HEAD'].includes(original.method) ? undefined : Buffer.from(original.body, original.bodyEncoding);
    const started = performance.now();
    try {
      const r = await fetch(target, { method: original.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      const text = await r.text();
      json(res, 200, { status: r.status, ms: Math.round(performance.now() - started), body: text.slice(0, 2000) });
    } catch (err) {
      json(res, 502, { error: `replay failed: ${(err as Error).message}`, ms: Math.round(performance.now() - started) });
    }
  }

  // Token bucket per client IP.
  function allow(ip: string): boolean {
    const now = Date.now();
    const b = buckets.get(ip) ?? { tokens: rate.burst, at: now };
    b.tokens = Math.min(rate.burst, b.tokens + ((now - b.at) / 1000) * rate.perSecond);
    b.at = now;
    buckets.set(ip, b);
    if (buckets.size > 10_000) buckets.clear(); // crude bound; fine for a dev tool
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Ends every SSE stream so server.close() can complete (graceful shutdown). */
  function closeStreams() {
    for (const res of streams) res.end('event: bye\ndata: {}\n\n');
  }

  return { server: server as Server, store, closeStreams };
}

class BodyTooLarge extends Error {}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers });
  res.end(data);
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

// Streams files from the React build. Hashed assets are cached forever;
// unknown paths fall back to index.html for client-side routing.
async function serveStatic(res: ServerResponse, root: string, pathname: string) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, rel);
  if (!file.startsWith(root)) return json(res, 403, { error: 'forbidden' });
  let info = await stat(file).catch(() => null);
  if (!info || info.isDirectory()) {
    file = join(root, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) return json(res, 404, { error: 'not found' });
  }
  const immutable = file.includes(`${join(root, 'assets')}`);
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  await pipeline(createReadStream(file), res);
}
