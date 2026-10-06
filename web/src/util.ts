import type { CapturedRequest } from './feed';

export function prettyBody(r: CapturedRequest): { text: string; json: boolean } {
  if (r.bodyEncoding === 'base64') return { text: `<${r.size} bytes of binary data, base64>\n${r.body}`, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(r.body), null, 2), json: true };
  } catch {
    return { text: r.body, json: false };
  }
}

export function asCurl(r: CapturedRequest, url: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const skip = /^(host|content-length|connection|accept-encoding)$/i;
  const parts = [`curl -X ${r.method} ${q(url + r.path.replace(/^\/$/, '') + r.query)}`];
  for (const [k, v] of Object.entries(r.headers)) if (!skip.test(k)) parts.push(`-H ${q(`${k}: ${v}`)}`);
  if (r.body && r.bodyEncoding === 'utf8') parts.push(`--data-raw ${q(r.body)}`);
  return parts.join(' \\\n  ');
}

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function bytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1 << 20 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

/** Tiny dependency-free JSON highlighter: escapes first, then wraps tokens. */
export function highlightJSON(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, (m, str, colon, lit) => {
    if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`;
    if (lit) return `<span class="l">${m}</span>`;
    return `<span class="n">${m}</span>`;
  });
}
