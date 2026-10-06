import { useCallback, useDeferredValue, useEffect, useMemo, useState, useSyncExternalStore, useTransition } from 'react';
import { BinFeed, type CapturedRequest } from './feed';
import { ago, asCurl, bytes, highlightJSON, prettyBody } from './util';

function useHashBin(): [string | null, (id: string) => void] {
  const read = () => /^#\/b\/([\w-]+)$/.exec(location.hash)?.[1] ?? null;
  const id = useSyncExternalStore(
    (fn) => (addEventListener('hashchange', fn), () => removeEventListener('hashchange', fn)),
    read,
  );
  return [id, (next) => (location.hash = `/b/${next}`)];
}

export function App() {
  const [binId, setBin] = useHashBin();
  return binId ? <BinView key={binId} binId={binId} /> : <Landing onCreate={setBin} />;
}

function Landing({ onCreate }: { onCreate: (id: string) => void }) {
  const [pending, start] = useTransition();
  const create = () =>
    start(async () => {
      const res = await fetch('/api/bins', { method: 'POST' });
      onCreate((await res.json()).id);
    });
  return (
    <main className="landing">
      <div className="logo">
        <span className="dot" /> hookscope
      </div>
      <h1>See every webhook, the moment it lands.</h1>
      <p>
        Get a URL, point any webhook sender at it, and watch requests stream in live: headers, bodies, signature checks.
        Replay them anywhere, or make the endpoint fail on purpose to test retries.
      </p>
      <button className="btn big" onClick={create} disabled={pending}>
        {pending ? 'Creating…' : 'Create an inspection URL'}
      </button>
    </main>
  );
}

function BinView({ binId }: { binId: string }) {
  const feed = useMemo(() => new BinFeed(binId), [binId]);
  const { requests, conn } = useSyncExternalStore(feed.subscribe, feed.getSnapshot);
  const [selectedId, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const deferredFilter = useDeferredValue(filter); // typing stays responsive while a long list filters
  const endpoint = `${location.origin}/h/${binId}`;

  const visible = useMemo(() => {
    const q = deferredFilter.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((r) => `${r.method} ${r.path}${r.query} ${r.body} ${r.signature}`.toLowerCase().includes(q));
  }, [requests, deferredFilter]);

  const selected = visible.find((r) => r.id === selectedId) ?? visible[0] ?? null;

  // j / k to move through the list, like a mail client.
  const move = useCallback(
    (delta: number) => {
      if (!visible.length) return;
      const i = Math.max(0, visible.findIndex((r) => r.id === selected?.id));
      setSelected(visible[Math.min(visible.length - 1, Math.max(0, i + delta))].id);
    },
    [visible, selected],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'j') move(1);
      if (e.key === 'k') move(-1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [move]);

  return (
    <div className="app">
      <header className="top">
        <a className="logo" href="#">
          <span className="dot" /> hookscope
        </a>
        <CopyField value={endpoint} />
        <span className={`conn conn-${conn}`} title="Server-Sent Events connection">
          {conn === 'live' ? '● live' : conn === 'connecting' ? '○ connecting' : '◌ reconnecting…'}
        </span>
      </header>
      <Settings binId={binId} />
      <div className="split">
        <aside className="list">
          <div className="list-head">
            <input placeholder="Filter: method, path, body…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter requests" />
            <span className="muted">{visible.length}</span>
          </div>
          {visible.length === 0 ? (
            <EmptyHint endpoint={endpoint} filtered={Boolean(filter)} />
          ) : (
            <ul>
              {visible.map((r) => (
                <li key={r.id}>
                  <button className={`row ${selected?.id === r.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
                    <span className={`method m-${r.method}`}>{r.method}</span>
                    <span className="path">
                      {r.path}
                      <span className="muted">{r.query}</span>
                    </span>
                    <SigBadge status={r.signature} compact />
                    <time className="muted">{ago(r.receivedAt)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="detail">{selected ? <Detail r={selected} endpoint={endpoint} binId={binId} /> : <div className="muted pad">Waiting for the first request…</div>}</section>
      </div>
    </div>
  );
}

function Detail({ r, endpoint, binId }: { r: CapturedRequest; endpoint: string; binId: string }) {
  const body = prettyBody(r);
  return (
    <div className="pad stack">
      <div className="detail-head">
        <span className={`method m-${r.method}`}>{r.method}</span>
        <code className="grow">
          {r.path}
          {r.query}
        </code>
        <SigBadge status={r.signature} />
      </div>
      <dl className="facts">
        <div><dt>Received</dt><dd>{new Date(r.receivedAt).toLocaleString()}</dd></div>
        <div><dt>From</dt><dd>{r.ip}</dd></div>
        <div><dt>Size</dt><dd>{bytes(r.size)}{r.truncated && ' (truncated)'}</dd></div>
        <div><dt>Answered</dt><dd>HTTP {r.respondedWith}</dd></div>
      </dl>
      <h3>Headers</h3>
      <table className="headers">
        <tbody>
          {Object.entries(r.headers).map(([k, v]) => (
            <tr key={k}>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Body</h3>
      {r.size === 0 ? (
        <p className="muted">Empty body</p>
      ) : body.json ? (
        <pre className="code" dangerouslySetInnerHTML={{ __html: highlightJSON(body.text) }} />
      ) : (
        <pre className="code">{body.text}</pre>
      )}
      <div className="actions">
        <CopyButton label="Copy as cURL" value={asCurl(r, endpoint)} />
      </div>
      <Replay binId={binId} requestId={r.id} />
    </div>
  );
}

function Replay({ binId, requestId }: { binId: string; requestId: number }) {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = () =>
    start(async () => {
      const res = await fetch(`/api/bins/${binId}/requests/${requestId}/replay`, { method: 'POST', body: JSON.stringify({ url }) });
      const out = await res.json();
      setResult(res.ok ? `→ HTTP ${out.status} in ${out.ms} ms` : `✗ ${out.error}`);
    });
  return (
    <div className="replay">
      <h3>Replay</h3>
      <div className="inline">
        <input placeholder="http://localhost:3000/webhooks" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button className="btn" disabled={!url || pending} onClick={run}>
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {result && <p className="muted">{result}</p>}
    </div>
  );
}

const STATUSES = [200, 204, 400, 401, 404, 410, 429, 500, 502, 503, 504];

/** Make the endpoint misbehave on purpose: watch a sender's retries, backoff and circuit breaker live. */
function Settings({ binId }: { binId: string }) {
  const [status, setStatus] = useState(200);
  const [delayMs, setDelay] = useState(0);
  const [secret, setSecret] = useState('');
  const [verifying, setVerifying] = useState(false);
  const save = async (patch: object) => {
    const res = await fetch(`/api/bins/${binId}`, { method: 'PATCH', body: JSON.stringify(patch) });
    if (res.ok) setVerifying((await res.json()).settings.verifiesSignatures);
  };
  // Load the bin's current behaviour, e.g. after a reload while simulating a 503.
  useEffect(() => {
    let live = true;
    fetch(`/api/bins/${binId}`)
      .then((r) => r.json())
      .then(({ settings }) => {
        if (!live) return;
        setStatus(settings.status);
        setDelay(settings.delayMs);
        setVerifying(settings.verifiesSignatures);
      });
    return () => {
      live = false;
    };
  }, [binId]);
  return (
    <div className="settings">
      <label>
        Respond with
        <select value={status} onChange={(e) => (setStatus(+e.target.value), save({ status: +e.target.value }))}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
              {s === 410 ? ' (stop sending)' : s === 429 ? ' (rate limited)' : s >= 500 ? ' (fail)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        Delay
        <select value={delayMs} onChange={(e) => (setDelay(+e.target.value), save({ delayMs: +e.target.value }))}>
          {[0, 250, 1000, 3000, 12000].map((d) => (
            <option key={d} value={d}>
              {d ? `${d} ms` : 'none'}
            </option>
          ))}
        </select>
      </label>
      <label className="grow">
        hookline secret
        <input type="password" placeholder={verifying ? 'secret set · type to replace' : 'whsec_… to verify signatures'} value={secret} onChange={(e) => setSecret(e.target.value)} onBlur={() => save({ secret: secret || null })} />
      </label>
      {status !== 200 && <span className="warn">Simulating HTTP {status}</span>}
    </div>
  );
}

function SigBadge({ status, compact = false }: { status: CapturedRequest['signature']; compact?: boolean }) {
  if (status === 'unsigned' || (compact && status === 'no-secret')) return null;
  const label = { valid: '✓ signed', invalid: '✗ bad signature', expired: '✗ expired', malformed: '✗ malformed', 'no-secret': 'signed · add secret to verify' }[status];
  return <span className={`sig sig-${status}`}>{compact ? label.split(' ')[0] : label}</span>;
}

function EmptyHint({ endpoint, filtered }: { endpoint: string; filtered: boolean }) {
  if (filtered) return <p className="muted pad">No requests match.</p>;
  return (
    <div className="pad stack">
      <p className="muted">Nothing yet. Send something:</p>
      <pre className="code">{`curl -X POST ${endpoint} \\\n  -H 'Content-Type: application/json' \\\n  -d '{"hello":"world"}'`}</pre>
      <p className="muted">Or register it as a hookline endpoint:</p>
      <pre className="code">{`curl localhost:8080/v1/endpoints \\\n  -d '{"url":"${endpoint}"}'`}</pre>
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  return (
    <div className="copyfield">
      <code data-testid="endpoint">{value}</code>
      <CopyButton label="Copy" value={value} />
    </div>
  );
}

function CopyButton({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'Copied ✓' : label}
    </button>
  );
}
