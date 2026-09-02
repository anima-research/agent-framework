/**
 * RFC-005 treatment on the push lane's block converter — the RFC's priority
 * lane (unilateral context entry, vector 8's substrate).
 *
 * Run: node --import tsx --test test/mcpl-push-convert.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { convertBlock } from '../src/mcpl/push-handler.js';
import type { McplContentBlock } from '../src/mcpl/types.js';

const t = (b: unknown) => convertBlock(b as McplContentBlock) as { type: string; text?: string; source?: { type: string } };

test('resource block converts to a bounded stub, never the raw uri', () => {
  const out = t({ type: 'resource', uri: 'https://host/files?path=x.wav', mimeType: 'audio/wav',
    sizeBytes: 1000, name: 'x.wav', disposition: 'never' });
  assert.equal(out.type, 'text');
  assert.ok(/\[ref_[a-z0-9_]+\]/.test(out.text!));
  assert.ok(!out.text!.includes('https://host'), 'uri leaked into push content');
});

test('vector 2: inline image data claiming disposition is withheld on the push lane', () => {
  const out = t({ type: 'image', data: 'AAAA', mimeType: 'image/png', disposition: 'never' });
  assert.equal(out.type, 'text');
  assert.ok(out.text!.includes('withheld'));
});

test('undecorated inline image keeps native handling (absent testimony = host default)', () => {
  const out = t({ type: 'image', data: 'AAAA', mimeType: 'image/png' });
  assert.equal(out.type, 'image');
});

test('uri-form image with disposition stubs instead of becoming a provider url source', () => {
  const out = t({ type: 'image', uri: 'https://host/img.png', disposition: 'ref' });
  assert.equal(out.type, 'text');
  assert.ok(/\[ref_/.test(out.text!));
});

test('undecorated uri-form image keeps url-source handling (behavior preserved)', () => {
  const out = t({ type: 'image', uri: 'https://host/img.png' });
  assert.equal(out.type, 'image');
  assert.equal(out.source?.type, 'url');
});

test('unknown block type fails visibly, never undefined', () => {
  const out = t({ type: 'holo', frames: 9000 });
  assert.equal(out.type, 'text');
  assert.ok(out.text!.includes('unrecognized content block'));
});
