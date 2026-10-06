import { describe, expect, test } from 'vitest';
import { merge, type CapturedRequest } from './feed';

const req = (id: number) => ({ id, method: 'POST', path: `/${id}` }) as CapturedRequest;

describe('merge', () => {
  test('keeps newest first and drops duplicates from a resumed stream', () => {
    const list = merge([], [req(1), req(2)]);
    expect(merge(list, [req(2), req(3)]).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  test('returns the same array when nothing is new, so React can bail out', () => {
    const list = merge([], [req(1)]);
    expect(merge(list, [req(1)])).toBe(list);
  });

  test('caps memory', () => {
    const many = Array.from({ length: 50 }, (_, i) => req(i + 1));
    const out = merge([], many, 10);
    expect(out).toHaveLength(10);
    expect(out[0].id).toBe(50);
  });
});
