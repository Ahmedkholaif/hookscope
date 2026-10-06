import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureStatus = 'valid' | 'invalid' | 'expired' | 'malformed' | 'unsigned' | 'no-secret';

/**
 * Verifies a hookline signature header ("t=<unix>,v1=<hex>[,v1=<hex>…]").
 * HMAC-SHA256 over "<t>.<raw body>", compared in constant time, with a
 * replay window. Several v1 values are allowed so secrets can be rotated.
 * This is a port of github.com/Ahmedkholaif/hookline/signature.
 */
export function verifySignature(
  secret: string | undefined,
  header: string | undefined,
  body: Buffer,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): SignatureStatus {
  if (!header) return 'unsigned';
  if (!secret) return 'no-secret';

  let t: string | undefined;
  const sigs: Buffer[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) return 'malformed';
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') {
      if (!/^[0-9a-f]+$/i.test(v) || v.length % 2) return 'malformed';
      sigs.push(Buffer.from(v, 'hex'));
    }
  }
  if (!t || !/^\d+$/.test(t) || sigs.length === 0) return 'malformed';
  if (Math.abs(nowSec - Number(t)) > toleranceSec) return 'expired';

  const want = createHmac('sha256', secret).update(`${t}.`).update(body).digest();
  return sigs.some((s) => s.length === want.length && timingSafeEqual(s, want)) ? 'valid' : 'invalid';
}
