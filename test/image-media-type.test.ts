import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctImageMediaTypes } from '../src/image-media-type.js';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

test('corrects a PNG labelled image/webp, including inside tool_result, without mutating input', () => {
  const img = { type: 'image', source: { type: 'base64', data: PNG_B64, mediaType: 'image/webp' } };
  const messages = [
    { participant: 'user', content: [{ type: 'text', text: 'look' }, img] },
    { participant: 'user', content: [{ type: 'tool_result', toolUseId: 't', content: [img] }] },
  ] as never;
  const out = correctImageMediaTypes(messages) as unknown as Array<{ content: any[] }>;
  assert.equal(out[0].content[1].source.mediaType, 'image/png');
  assert.equal(out[1].content[0].content[0].source.mediaType, 'image/png');
  assert.equal(img.source.mediaType, 'image/webp', 'stored block untouched');
});

test('leaves correct and unknown images alone (same objects)', () => {
  const messages = [{ participant: 'user', content: [
    { type: 'image', source: { type: 'base64', data: PNG_B64, mediaType: 'image/png' } },
    { type: 'image', source: { type: 'base64', data: 'AAAA', mediaType: 'image/png' } },
  ] }] as never;
  assert.equal(correctImageMediaTypes(messages)[0], (messages as any)[0]);
});
