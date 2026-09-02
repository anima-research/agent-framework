/**
 * Unit tests for the tool-result history serializer.
 *
 * Run: node --import tsx --test test/tool-result-history.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { toolResultDataToHistoryString } from '../src/tool-result-history.js';

test('text-only MCP content array: blocks join with newlines', () => {
  const data = [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ];
  assert.equal(toolResultDataToHistoryString(data), 'first\nsecond');
});

test('image block becomes placeholder, not base64', () => {
  // 1MB of base64 = ~750KB of decoded bytes
  const fakeBase64 = 'A'.repeat(1024 * 1024);
  const data = [
    { type: 'text', text: 'Fetched x.png:' },
    { type: 'image', data: fakeBase64, mimeType: 'image/png' },
  ];
  const out = toolResultDataToHistoryString(data);
  assert.ok(out.includes('Fetched x.png:'));
  assert.ok(out.includes('[image: image/png,'));
  assert.ok(!out.includes(fakeBase64), 'base64 payload must NOT appear in history string');
  assert.ok(out.length < 200, `expected small string, got ${out.length} chars`);
});

test('size formatter: bytes / KB / MB', () => {
  const tiny = toolResultDataToHistoryString([{ type: 'image', data: 'A'.repeat(16), mimeType: 'image/png' }]);
  assert.match(tiny, /\[image: image\/png, \d+B\]/);
  const kb = toolResultDataToHistoryString([{ type: 'image', data: 'A'.repeat(10 * 1024), mimeType: 'image/png' }]);
  assert.match(kb, /\[image: image\/png, ~\d+KB\]/);
  const mb = toolResultDataToHistoryString([{ type: 'image', data: 'A'.repeat(2 * 1024 * 1024), mimeType: 'image/png' }]);
  assert.match(mb, /\[image: image\/png, ~\d+\.\d+MB\]/);
});

test('unknown block shape falls back to JSON', () => {
  const data = [{ type: 'mystery', payload: 42 }];
  assert.equal(toolResultDataToHistoryString(data), JSON.stringify(data));
});

test('mixed known + unknown block shape falls back to JSON (all-or-nothing)', () => {
  const data = [
    { type: 'text', text: 'fine' },
    { type: 'audio', data: 'XX', mimeType: 'audio/mpeg' },
  ];
  assert.equal(toolResultDataToHistoryString(data), JSON.stringify(data));
});

test('non-array data: JSON stringify', () => {
  assert.equal(toolResultDataToHistoryString({ ok: true }), '{"ok":true}');
  assert.equal(toolResultDataToHistoryString('hello'), '"hello"');
  assert.equal(toolResultDataToHistoryString(42), '42');
  assert.equal(toolResultDataToHistoryString(undefined), undefined as any); // JSON.stringify(undefined) === undefined
});

test('maxChars truncates the resulting string with a marker', () => {
  const data = [{ type: 'text', text: 'a'.repeat(1000) }];
  const out = toolResultDataToHistoryString(data, 100);
  assert.ok(out.length < 1000);
  assert.match(out, /\[truncated — original was \d+ chars\]/);
});

test('maxChars does NOT truncate the placeholder itself (image is summarized, not chopped)', () => {
  // 4MB of base64 → ~3MB decoded, comfortably across the MB threshold.
  const fakeBase64 = 'A'.repeat(4 * 1024 * 1024);
  const data = [{ type: 'image', data: fakeBase64, mimeType: 'image/png' }];
  const out = toolResultDataToHistoryString(data, 50_000);
  // The placeholder is ~30 chars regardless of input size; maxChars=50_000 leaves it untouched.
  assert.match(out, /\[image: image\/png, ~\d+\.\d+MB\]/);
  assert.ok(!out.includes('truncated'));
  assert.ok(out.length < 100);
});

test('null entry in array falls back to JSON', () => {
  const data = [{ type: 'text', text: 'x' }, null];
  assert.equal(toolResultDataToHistoryString(data), JSON.stringify(data));
});

test('empty array: empty string', () => {
  assert.equal(toolResultDataToHistoryString([]), '');
});

// ── RFC-005 bulk content references (vst-mcpl is the live emitter) ──

const RFC005_REF = {
  type: 'resource',
  uri: 'https://mythoss-mac-mini.tail01efee.ts.net/files?path=%2Fchord.wav',
  mimeType: 'audio/wav',
  sizeBytes: 4233704,
  digest: 'sha256:' + 'A'.repeat(43),
  name: 'chord.wav',
  disposition: 'never',
};

test('RFC-005 resource block becomes a stub, never JSON, never the URI', () => {
  const data = [
    { type: 'text', text: '{"peak":0.6}' },
    RFC005_REF,
  ];
  const out = toolResultDataToHistoryString(data);
  assert.ok(out.includes('{"peak":0.6}'));
  assert.ok(out.includes('chord.wav') && out.includes('audio/wav'), out);
  assert.ok(/\[ref_[a-z0-9_]+\]/.test(out), 'stub must carry a reference id');
  assert.ok(!out.includes('mythoss-mac-mini'), 'raw URI leaked under disposition:never');
  assert.ok(!out.includes('"type":"resource"'), 'raw block JSON leaked');
});

test('RFC-005: oversized metadata cannot inflate the history string (vector 17)', () => {
  const data = [{ ...RFC005_REF, name: 'x'.repeat(1_000_000) }];
  const out = toolResultDataToHistoryString(data);
  assert.ok(out.length < 600, `stub is ${out.length} chars`);
});

test('RFC-005: uri-form audio with disposition stubs like a resource', () => {
  const data = [{ type: 'audio', uri: 'https://x/y.wav', sizeBytes: 10, disposition: 'ref' }];
  const out = toolResultDataToHistoryString(data);
  assert.ok(/\[ref_[a-z0-9_]+\]/.test(out));
  assert.ok(!out.includes('https://x/y.wav'), 'default policy is the opaque id');
});

test('RFC-005: invalid sizeBytes is dropped as a field, block still stubs (vector 15)', () => {
  const data = [{ ...RFC005_REF, sizeBytes: -1 }];
  const out = toolResultDataToHistoryString(data);
  assert.ok(/\[ref_[a-z0-9_]+\]/.test(out));
  assert.ok(!out.includes('claimed'), 'rejected sizeBytes must not be rendered');
  assert.ok(!out.includes('mythoss-mac-mini'), 'never survives field rejection');
});

test('RFC-005 vector 2: inline data claiming bulk disposition is withheld', () => {
  const fakeBase64 = 'A'.repeat(4096);
  const data = [{ type: 'image', data: fakeBase64, mimeType: 'image/png', disposition: 'never' }];
  const out = toolResultDataToHistoryString(data);
  assert.ok(out.includes('withheld'), out.slice(0, 120));
  assert.ok(!out.includes(fakeBase64), 'inline data leaked through bulk disposition');
  assert.ok(!out.includes('[image:'), 'must not render as a normal image');
});

test('RFC-005: reference ids are stable across serializations (§5)', () => {
  const data = [RFC005_REF];
  const id = (s: string) => s.match(/\[(ref_[a-z0-9_]+)\]/)?.[1];
  const first = id(toolResultDataToHistoryString(data));
  const second = id(toolResultDataToHistoryString(data));
  assert.ok(first, 'no ref id in stub');
  assert.equal(first, second, 'same reference must keep one id (wire + history serialize twice)');
});

test('RFC-005: invalid disposition value on uri-form still stubs (conservative)', () => {
  const data = [{ ...RFC005_REF, disposition: 'inline-ok' }];
  const out = toolResultDataToHistoryString(data);
  assert.ok(/\[ref_[a-z0-9_]+\]/.test(out));
  assert.ok(!out.includes('"type":"resource"'));
});
