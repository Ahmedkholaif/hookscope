import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createApp, type Options } from './app.js';
import { verifySignature } from './signature.js';

const servers: { close(): void }[] = [];
after(() => servers.forEach((s) => s.close()));

async function start(opts: Options = {}) {
  const app = createApp({ heartbeatMs: 50, ...opts });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r));
  servers.push({ close: () => (app.closeStreams(), app.server.closeAllConnections(), app.server.close()) });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const bin = (await (await fetch(`${base}/api/bins`, { method: 'POST' })).json()).id as string;
  return { base, bin, app };
}

/** Reads SSE events from a stream until `n` request events arrive. */
async function readEvents(url: string, n: number, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(url, { headers, signal: ctrl.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { id: number; data: any }[] = [];
  let buf = '';
  const ready = new Promise<void>((resolve) => setTimeout(resolve, 30)); // let the subscription register
  const done = (async () => {
    while (events.length < n) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (id && /^event: request$/m.test(block)) events.push({ id: Number(id), data: JSON.parse(data!) });
      }
    }
    ctrl.abort();
    return events;
  })();
  return { ready, done };
}

test('captures method, path, query, headers and body', async () => {
  const { base, bin } = await start();
  const r = await fetch(`${base}/h/${bin}/stripe/events?x=1`, { method: 'POST', headers: { 'X-Custom': 'yes', 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(r.status, 200);
  const { requests } = await (await fetch(`${base}/api/bins/${bin}/requests`)).json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].path, '/stripe/events');
  assert.equal(requests[0].query, '?x=1');
  assert.equal(requests[0].headers['X-Custom'], 'yes');
  assert.equal(requests[0].body, '{"a":1}');
  assert.equal(requests[0].signature, 'unsigned');
});

test('binary bodies are kept as base64', async () => {
  const { base, bin } = await start();
  await fetch(`${base}/h/${bin}`, { method: 'PUT', body: Buffer.from([0xff, 0x00, 0xfe]) });
  const [r] = (await (await fetch(`${base}/api/bins/${bin}/requests`)).json()).requests;
  assert.equal(r.bodyEncoding, 'base64');
  assert.deepEqual([...Buffer.from(r.body, 'base64')], [0xff, 0x00, 0xfe]);
});

test('live stream pushes captures to every subscriber', async () => {
  const { base, bin } = await start();
  const a = await readEvents(`${base}/api/bins/${bin}/stream`, 2);
  const b = await readEvents(`${base}/api/bins/${bin}/stream`, 2);
  await Promise.all([a.ready, b.ready]);
  await fetch(`${base}/h/${bin}/one`, { method: 'POST', body: '1' });
  await fetch(`${base}/h/${bin}/two`, { method: 'POST', body: '2' });
  for (const s of [a, b]) assert.deepEqual((await s.done).map((e) => e.data.path), ['/one', '/two']);
});

test('reconnecting with Last-Event-ID resumes without gaps', async () => {
  const { base, bin } = await start();
  for (const p of ['a', 'b', 'c']) await fetch(`${base}/h/${bin}/${p}`, { method: 'POST' });
  const s = await readEvents(`${base}/api/bins/${bin}/stream`, 2, { 'Last-Event-ID': '1' });
  assert.deepEqual((await s.done).map((e) => [e.id, e.data.path]), [[2, '/b'], [3, '/c']]);
});

test('oversized bodies are rejected without buffering them', async () => {
  const { base, bin } = await start({ maxBodyBytes: 1024 });
  const r = await fetch(`${base}/h/${bin}`, { method: 'POST', body: 'x'.repeat(5000) });
  assert.equal(r.status, 413);
  assert.equal((await (await fetch(`${base}/api/bins/${bin}/requests`)).json()).requests.length, 0);
});

test('verifies hookline signatures (vector from the Go implementation)', () => {
  const body = Buffer.from('{"id":"evt_1","type":"invoice.paid","data":{"amount":1999}}');
  const header =
    't=1800000000,v1=74d132aa5e9113ddf4dd7bd820df6b286ca34af664a680c2448625d07d97eac6,v1=d8169afbfac66a1457079401d3319d217096815e0eaf69eb9d6debac99e2dfaf';
  const now = 1_800_000_000;
  assert.equal(verifySignature('whsec_test', header, body, 300, now), 'valid');
  assert.equal(verifySignature('whsec_old', header, body, 300, now), 'valid'); // rotated secret
  assert.equal(verifySignature('whsec_wrong', header, body, 300, now), 'invalid');
  assert.equal(verifySignature('whsec_test', header, Buffer.from('{"tampered":true}'), 300, now), 'invalid');
  assert.equal(verifySignature('whsec_test', header, body, 300, now + 301), 'expired');
  assert.equal(verifySignature('whsec_test', 'garbage', body, 300, now), 'malformed');
  assert.equal(verifySignature(undefined, header, body, 300, now), 'no-secret');
});

test('simulated failures: status and latency are configurable per bin', async () => {
  const { base, bin } = await start();
  const patch = await fetch(`${base}/api/bins/${bin}`, { method: 'PATCH', body: JSON.stringify({ status: 503, delayMs: 120 }) });
  assert.equal(patch.status, 200);
  const t0 = performance.now();
  const r = await fetch(`${base}/h/${bin}`, { method: 'POST' });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '5');
  assert.ok(performance.now() - t0 >= 110);
  assert.equal((await fetch(`${base}/api/bins/${bin}`, { method: 'PATCH', body: '{"status":999}' })).status, 422);
});

test('replays a captured request to another URL', async () => {
  const { base, bin } = await start();
  let seen: { method?: string; body: string; header?: string } = { body: '' };
  const target = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen = { method: req.method, body, header: req.headers['x-trace'] as string };
    res.writeHead(202).end('accepted');
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  servers.push(target);

  await fetch(`${base}/h/${bin}`, { method: 'POST', headers: { 'X-Trace': 'abc' }, body: '{"hello":"world"}' });
  const r = await fetch(`${base}/api/bins/${bin}/requests/1/replay`, {
    method: 'POST',
    body: JSON.stringify({ url: `http://127.0.0.1:${(target.address() as AddressInfo).port}/hook` }),
  });
  const out = await r.json();
  assert.equal(out.status, 202);
  assert.equal(out.body, 'accepted');
  assert.deepEqual(seen, { method: 'POST', body: '{"hello":"world"}', header: 'abc' });
});

test('rate limits each client IP with a token bucket', async () => {
  const { base, bin } = await start({ rateLimit: { perSecond: 1, burst: 3 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${base}/h/${bin}`, { method: 'POST' })).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test('unknown bins 404', async () => {
  const { base } = await start();
  assert.equal((await fetch(`${base}/h/nope`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/bins/nope/stream`)).status, 404);
});
