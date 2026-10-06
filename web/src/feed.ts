import type { CapturedRequest } from '../../server/bins';

export type { CapturedRequest };
export type ConnState = 'connecting' | 'live' | 'reconnecting';
export type Snapshot = { requests: CapturedRequest[]; conn: ConnState };

export const MAX_ITEMS = 200;

/**
 * Merges incoming captures into a newest-first list: de-duplicated by id
 * (a resumed stream may repeat what an initial fetch already returned) and
 * capped. Returns the same array when nothing changed so React can skip renders.
 */
export function merge(list: CapturedRequest[], incoming: CapturedRequest[], cap = MAX_ITEMS): CapturedRequest[] {
  const known = new Set(list.map((r) => r.id));
  const fresh = incoming.filter((r) => !known.has(r.id));
  if (fresh.length === 0) return list;
  return [...fresh, ...list].sort((a, b) => b.id - a.id).slice(0, cap);
}

/**
 * A live feed of one bin, shaped as an external store for React's
 * useSyncExternalStore: it loads history, then subscribes over Server-Sent
 * Events. EventSource reconnects by itself and sends Last-Event-ID, so the
 * server replays anything missed while the connection was down.
 */
export class BinFeed {
  private snap: Snapshot = { requests: [], conn: 'connecting' };
  private listeners = new Set<() => void>();
  private es?: EventSource;
  private closed = false;

  constructor(readonly binId: string) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    if (this.listeners.size === 1) void this.open();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.close();
    };
  };

  getSnapshot = () => this.snap;

  private set(next: Partial<Snapshot>) {
    const merged = { ...this.snap, ...next };
    if (merged.requests === this.snap.requests && merged.conn === this.snap.conn) return;
    this.snap = merged;
    this.listeners.forEach((l) => l());
  }

  private async open() {
    this.closed = false;
    const res = await fetch(`/api/bins/${this.binId}/requests`);
    if (!res.ok || this.closed) return;
    const { requests } = (await res.json()) as { requests: CapturedRequest[] };
    this.set({ requests: merge(this.snap.requests, requests) });

    const after = this.snap.requests[0]?.id ?? 0;
    this.es = new EventSource(`/api/bins/${this.binId}/stream?after=${after}`);
    this.es.onopen = () => this.set({ conn: 'live' });
    this.es.onerror = () => this.set({ conn: 'reconnecting' });
    this.es.addEventListener('request', (e) => {
      this.set({ requests: merge(this.snap.requests, [JSON.parse((e as MessageEvent).data)]) });
    });
  }

  close() {
    this.closed = true;
    this.es?.close();
  }

  clearLocal() {
    this.set({ requests: [] });
  }
}
