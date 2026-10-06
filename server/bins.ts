import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SignatureStatus } from './signature.js';

export interface CapturedRequest {
  id: number; // monotonic per bin; doubles as the SSE event id
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
  ip: string;
  receivedAt: string;
  signature: SignatureStatus;
  respondedWith: number;
}

export interface BinSettings {
  /** Verify hookline signatures with this endpoint secret. */
  secret?: string;
  /** Status code to answer captured requests with (simulate a failing receiver). */
  status: number;
  /** Artificial latency before answering, in ms (simulate a slow receiver). */
  delayMs: number;
}

/**
 * One inspection bin: settings, a bounded ring buffer of recent requests, and
 * an emitter that fans every capture out to all live subscribers (SSE).
 */
export class Bin extends EventEmitter<{ request: [CapturedRequest] }> {
  readonly id = randomBytes(6).toString('base64url');
  readonly createdAt = new Date().toISOString();
  settings: BinSettings = { status: 200, delayMs: 0 };
  lastUsed = Date.now();
  private seq = 0;
  private ring: CapturedRequest[] = [];

  constructor(private readonly capacity: number) {
    super();
    this.setMaxListeners(0); // one listener per connected browser tab
  }

  add(req: Omit<CapturedRequest, 'id'>): CapturedRequest {
    const r = { ...req, id: ++this.seq };
    this.ring.push(r);
    if (this.ring.length > this.capacity) this.ring.shift();
    this.lastUsed = Date.now();
    this.emit('request', r);
    return r;
  }

  /** Requests newer than `afterId`, oldest first: used to resume an SSE stream. */
  since(afterId: number): CapturedRequest[] {
    return this.ring.filter((r) => r.id > afterId);
  }

  list(): CapturedRequest[] {
    return [...this.ring].reverse();
  }

  get(id: number) {
    return this.ring.find((r) => r.id === id);
  }

  clear() {
    this.ring = [];
  }

  toJSON() {
    const { secret, ...rest } = this.settings;
    return { id: this.id, createdAt: this.createdAt, settings: { ...rest, verifiesSignatures: Boolean(secret) }, count: this.ring.length };
  }
}

/** All bins, in memory. Least-recently-used bins are evicted past `maxBins`. */
export class BinStore {
  private bins = new Map<string, Bin>();

  constructor(
    private readonly maxBins = 1000,
    private readonly perBin = 200,
  ) {}

  create(): Bin {
    const bin = new Bin(this.perBin);
    this.bins.set(bin.id, bin);
    if (this.bins.size > this.maxBins) {
      const oldest = [...this.bins.values()].reduce((a, b) => (a.lastUsed <= b.lastUsed ? a : b));
      this.bins.delete(oldest.id);
    }
    return bin;
  }

  get(id: string) {
    const bin = this.bins.get(id);
    if (bin) bin.lastUsed = Date.now();
    return bin;
  }
}
