import { describe, expect, test } from 'vitest';
import type { CapturedRequest } from './feed';
import { ago, asCurl, highlightJSON, prettyBody } from './util';

const base: CapturedRequest = {
  id: 1, method: 'POST', path: '/hooks', query: '?a=1', headers: { 'Content-Type': 'application/json', Host: 'x' },
  body: '', bodyEncoding: 'utf8', size: 0, truncated: false, ip: '127.0.0.1', receivedAt: '2026-01-01T00:00:00Z',
  signature: 'unsigned', respondedWith: 200,
};

describe('highlightJSON', () => {
  test('escapes HTML before adding markup (captured bodies are untrusted)', () => {
    const out = highlightJSON('{"x":"<img src=x onerror=alert(1)>"}');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
  test('tags keys, strings, numbers and literals', () => {
    expect(highlightJSON('{"a": 1, "b": true}')).toBe('{<span class="k">"a"</span>: <span class="n">1</span>, <span class="k">"b"</span>: <span class="l">true</span>}');
  });
});

describe('asCurl', () => {
  test('reproduces the request and quotes safely for the shell', () => {
    const curl = asCurl({ ...base, body: `{"msg":"it's"}` }, 'http://localhost:4000/h/abc');
    expect(curl).toContain(`curl -X POST 'http://localhost:4000/h/abc/hooks?a=1'`);
    expect(curl).toContain(`-H 'Content-Type: application/json'`);
    expect(curl).not.toContain('Host:');
    expect(curl).toContain(`--data-raw '{"msg":"it'\\''s"}'`);
  });
});

test('prettyBody formats JSON and labels binary', () => {
  expect(prettyBody({ ...base, body: '{"a":1}' })).toEqual({ text: '{\n  "a": 1\n}', json: true });
  expect(prettyBody({ ...base, body: 'AA==', bodyEncoding: 'base64', size: 1 }).json).toBe(false);
});

test('ago', () => {
  const now = Date.parse('2026-01-01T00:10:00Z');
  expect(ago('2026-01-01T00:09:58Z', now)).toBe('just now');
  expect(ago('2026-01-01T00:09:00Z', now)).toBe('1m ago');
});
