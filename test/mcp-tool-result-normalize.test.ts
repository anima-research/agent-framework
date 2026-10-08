/**
 * The standard reading of an MCP tool result (room-284, shelf-487): the
 * content array is the model's view, and `structuredContent` the
 * programmatic one, kept by presence. A payload the model can't take is
 * saved and described by a bounded stub; nothing is fetched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStandardToolResult, type SaveToolPayload } from '../src/mcpl/tool-result-normalize.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

function recordingSave(): { save: SaveToolPayload; saved: Array<{ fileName: string; bytes: string; mimeType: string }> } {
  const saved: Array<{ fileName: string; bytes: string; mimeType: string }> = [];
  return {
    saved,
    save: async (fileName, bytes, mimeType) => {
      saved.push({ fileName, bytes: bytes.toString('utf8'), mimeType });
      return `home/tool-results/${fileName}`;
    },
  };
}

test('text only: the joined string, as before, and no structured field', async () => {
  const r = await normalizeStandardToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, 'L', null);
  assert.deepEqual(r, { success: true, data: 'a\nb', isError: false });
  assert.ok(!('structured' in r));
});

test('structured only: the model sees it as JSON, programs get the value', async () => {
  const r = await normalizeStandardToolResult({ content: [], structuredContent: { answer: 42, ok: false, nothing: null } }, 'L', null);
  assert.equal(r.success, true);
  assert.equal(r.data, '{"answer":42,"ok":false,"nothing":null}');
  assert.deepEqual(r.structured, { answer: 42, ok: false, nothing: null });
});

test('falsy structured values are values: 0, false and null are kept and shown', async () => {
  for (const value of [0, false, null, '']) {
    const r = await normalizeStandardToolResult({ content: [], structuredContent: value }, 'L', null);
    assert.ok('structured' in r, String(value));
    assert.equal(r.structured, value);
    assert.equal(r.data, JSON.stringify(value));
  }
});

test('text plus structured: the server chose the model\'s text; structured rides beside it', async () => {
  const r = await normalizeStandardToolResult({
    content: [{ type: 'text', text: 'Found 2 rows.' }],
    structuredContent: { rows: [{ id: 1 }, { id: 2 }] },
  }, 'L', null);
  assert.equal(r.data, 'Found 2 rows.');
  assert.deepEqual(r.structured, { rows: [{ id: 1 }, { id: 2 }] });
});

test('an inline image stays native: the array is kept', async () => {
  const r = await normalizeStandardToolResult({
    content: [{ type: 'text', text: 'see' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }],
  }, 'L', null);
  assert.deepEqual(r.data, [{ type: 'text', text: 'see' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
});

test('audio and binary resources are saved to the workspace and described', async () => {
  const { save, saved } = recordingSave();
  const r = await normalizeStandardToolResult({
    content: [
      { type: 'audio', data: b64('RIFFdata'), mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri: 'memo://bin', mimeType: 'application/octet-stream', blob: b64('binary!') } },
    ],
  }, '2026-10-08-call1', save);
  assert.deepEqual(saved, [
    { fileName: '2026-10-08-call1-1.wav', bytes: 'RIFFdata', mimeType: 'audio/wav' },
    { fileName: '2026-10-08-call1-2.bin', bytes: 'binary!', mimeType: 'application/octet-stream' },
  ]);
  assert.equal(r.data,
    '[audio: audio/wav, 8 B, saved to workspace file home/tool-results/2026-10-08-call1-1.wav]\n' +
    '[resource memo://bin: application/octet-stream, 7 B, saved to workspace file home/tool-results/2026-10-08-call1-2.bin]');
});

test('without a workspace the stub says the payload was not shown, and why', async () => {
  const r = await normalizeStandardToolResult({ content: [{ type: 'audio', data: b64('x'), mimeType: 'audio/mpeg' }] }, 'L', null);
  assert.equal(r.data, "[audio: audio/mpeg, 1 B. Not shown: the model can't take this type, and no workspace is mounted to save it]");
});

test('a resource link is shown as a reference and never fetched; embedded text is shown', async () => {
  const r = await normalizeStandardToolResult({
    content: [
      { type: 'resource_link', uri: 'file:///srv/report.pdf', name: 'report.pdf', mimeType: 'application/pdf' },
      { type: 'resource', resource: { uri: 'memo://note', mimeType: 'text/plain', text: 'embedded note text' } },
    ],
  }, 'L', null);
  assert.equal(r.data,
    '[resource link "report.pdf": file:///srv/report.pdf, application/pdf; not fetched]\n' +
    '[resource memo://note, text/plain]\nembedded note text');
});

test('a tool error is a failure with its text; structured survives', async () => {
  const r = await normalizeStandardToolResult({ content: [{ type: 'text', text: 'nope' }], isError: true, structuredContent: { code: 7 } }, 'L', null);
  assert.deepEqual(r, { success: false, error: 'nope', isError: true, structured: { code: 7 } });
});

test('an unknown block is shown as data, and stub fields are bounded', async () => {
  const long = `memo://${'x'.repeat(1000)}`;
  const r = await normalizeStandardToolResult({
    content: [{ type: 'hologram', depth: 3 }, { type: 'resource_link', uri: long }],
  }, 'L', null);
  const [unknown, link] = String(r.data).split('\n');
  assert.equal(unknown, '{"type":"hologram","depth":3}');
  assert.ok(link!.length < 260, `bounded: ${link!.length}`);
  assert.match(link!, /…; not fetched\]$/);
});
