/**
 * The standard reading of an MCP tool result: the content array is the
 * model's view, and `structuredContent` the programmatic one, kept by
 * presence. A payload the model can't take is saved and described by a
 * bounded stub; nothing is fetched, and nothing is dropped silently.
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

test('a payload that cannot be retained makes the result a failure to materialize, not a success', async () => {
  const r = await normalizeStandardToolResult({
    content: [{ type: 'text', text: 'here is the clip' }, { type: 'audio', data: b64('x'), mimeType: 'audio/mpeg' }],
  }, 'L', null);
  assert.equal(r.success, false);
  assert.equal(r.isError, true);
  assert.equal(r.error,
    '[result incomplete: 1 payload(s) could not be retained, so this result is not complete; the tool may already have completed]\n' +
    'here is the clip\n' +
    "[audio: audio/mpeg, 1 B. Not retained: the model can't take this type, and no workspace is mounted to save it]");
  const failedSave = await normalizeStandardToolResult(
    { content: [{ type: 'resource', resource: { uri: 'memo://b', blob: b64('zz') } }] },
    'L',
    async () => null,
  );
  assert.equal(failedSave.success, false);
  assert.match(failedSave.error!, /saving it to the workspace failed/);
});

test('generated stubs are not the server\'s text: structured still shows beside them', async () => {
  const r = await normalizeStandardToolResult({
    content: [{ type: 'resource_link', uri: 'file:///r.csv', name: 'r.csv' }],
    structuredContent: { rows: 3 },
  }, 'L', null);
  assert.equal(r.data, '[resource link "r.csv": file:///r.csv; not fetched]\n{"rows":3}');
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
  const r = await normalizeStandardToolResult({
    content: [{ type: 'hologram', depth: 3 }, { type: 'resource_link', uri: 'memo://r', name: 'n'.repeat(1000) }],
  }, 'L', null);
  const [unknown, link] = String(r.data).split('\n');
  assert.equal(unknown, '{"type":"hologram","depth":3}');
  assert.equal(link, `[resource link "${'n'.repeat(200)}…": memo://r; not fetched]`);
});

test('a large unknown block is bounded like a stub field, saying how much was left out', async () => {
  const r = await normalizeStandardToolResult({ content: [{ type: 'hologram', blob: 'x'.repeat(10_000) }] }, 'L', null);
  const json = JSON.stringify({ type: 'hologram', blob: 'x'.repeat(10_000) });
  assert.equal(r.data, `${json.slice(0, 200)}… [${json.length - 200} more characters of this block left out]`);
});

test('a URI is bounded loosely: a real one survives whole, a pathological one is cut', async () => {
  const real = `https://example.com/report?${'q'.repeat(1500)}`;
  const huge = `memo://${'x'.repeat(5000)}`;
  const r = await normalizeStandardToolResult({
    content: [{ type: 'resource_link', uri: real }, { type: 'resource_link', uri: huge }],
  }, 'L', null);
  const [whole, cut] = String(r.data).split('\n');
  assert.equal(whole, `[resource link: ${real}; not fetched]`);
  assert.equal(cut, `[resource link: ${huge.slice(0, 2048)}…; not fetched]`);
});

test('in a failed result an inline image is saved and named, or marked not retained, never dropped', async () => {
  const { save, saved } = recordingSave();
  const r = await normalizeStandardToolResult({
    content: [{ type: 'text', text: 'render failed' }, { type: 'image', data: b64('partial'), mimeType: 'image/png' }],
    isError: true,
  }, 'L', save);
  assert.equal(r.success, false);
  assert.deepEqual(saved, [{ fileName: 'L-1.png', bytes: 'partial', mimeType: 'image/png' }]);
  assert.equal(r.error,
    'render failed\n' +
    '[image: image/png, 7 B, saved to workspace file home/tool-results/L-1.png; not shown inline: a failed result is read as its text alone]');

  const unsaved = await normalizeStandardToolResult({
    content: [{ type: 'image', data: b64('png'), mimeType: 'image/png' }],
    isError: true,
  }, 'L', null);
  assert.equal(unsaved.error,
    '[image: image/png, 3 B. Not retained: a failed result is read as its text alone, and no workspace is mounted to save it]');

  // A payload lost beside it makes the result a failure too: the image is
  // then a payload like the audio, and both are counted.
  const lost = await normalizeStandardToolResult({
    content: [{ type: 'image', data: b64('png'), mimeType: 'image/png' }, { type: 'audio', data: b64('wav'), mimeType: 'audio/wav' }],
  }, 'L', null);
  assert.equal(lost.success, false);
  assert.match(lost.error!, /^\[result incomplete: 2 payload\(s\) could not be retained/);
  assert.match(lost.error!, /\[image: image\/png, 3 B\. Not retained: a failed result is read as its text alone/);
});

test('image and audio with inline data but no mimeType are payloads of no known type, saved', async () => {
  const { save, saved } = recordingSave();
  const r = await normalizeStandardToolResult({ content: [{ type: 'image', data: b64('img') }, { type: 'audio', data: b64('aud') }] }, 'L', save);
  assert.deepEqual(saved.map((p) => [p.fileName, p.bytes, p.mimeType]), [
    ['L-1.bin', 'img', 'application/octet-stream'],
    ['L-2.bin', 'aud', 'application/octet-stream'],
  ]);
  assert.equal(r.success, true);
  assert.equal(r.data,
    '[image: application/octet-stream, 3 B, saved to workspace file home/tool-results/L-1.bin]\n' +
    '[audio: application/octet-stream, 3 B, saved to workspace file home/tool-results/L-2.bin]');
});

test("an image a provider can't take inline is saved: another type, or over the per-image size", async () => {
  const { save, saved } = recordingSave();
  const atLimit = Buffer.alloc(5 * 1024 * 1024, 1).toString('base64');
  const overLimit = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString('base64');
  const r = await normalizeStandardToolResult({
    content: [
      { type: 'image', data: b64('tiff'), mimeType: 'image/tiff' },
      { type: 'image', data: overLimit, mimeType: 'image/png' },
      { type: 'image', data: atLimit, mimeType: 'image/png' },
      { type: 'image', data: b64('ok'), mimeType: 'IMAGE/JPEG; q=1' },
    ],
  }, 'L', save);
  assert.deepEqual(saved.map((p) => [p.fileName, p.mimeType]), [['L-1.tiff', 'image/tiff'], ['L-2.png', 'image/png']]);
  const data = r.data as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  assert.equal(data[0]!.text, '[image: image/tiff, 4 B, saved to workspace file home/tool-results/L-1.tiff]');
  assert.equal(data[1]!.text,
    '[image: image/png, 5.0 MB, saved to workspace file home/tool-results/L-2.png; not shown inline: over the 5.0 MB a model takes per image]');
  assert.deepEqual(data[2], { type: 'image', data: atLimit, mimeType: 'image/png' }, 'exactly at the limit stays native');
  assert.deepEqual(data[3], { type: 'image', data: b64('ok'), mimeType: 'image/jpeg' }, 'a type a provider takes, in its canonical spelling');
});

test("a native image is passed without its encoding's line wrapping", async () => {
  const flat = b64('a small png, wrapped');
  const wrapped = flat.replace(/(.{8})/g, '$1\r\n');
  assert.notEqual(wrapped, flat);
  const r = await normalizeStandardToolResult({ content: [{ type: 'image', data: wrapped, mimeType: 'image/png' }] }, 'L', null);
  assert.deepEqual(r.data, [{ type: 'image', data: flat, mimeType: 'image/png' }]);
});

test('a save that rejects is a lost payload, and why it failed is logged', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); });
  const r = await normalizeStandardToolResult(
    { content: [{ type: 'audio', data: b64('clip'), mimeType: 'audio/wav' }] },
    'L',
    async () => { throw new Error('disk gone'); },
  );
  assert.equal(r.success, false);
  assert.match(r.error!, /\[audio: audio\/wav, 4 B\. Not retained: the model can't take this type, and saving it to the workspace failed\]/);
  const saves = logged.filter((line) => line.startsWith('[mcp] saving tool payload'));
  assert.equal(saves.length, 1, logged.join('\n'));
  assert.match(saves[0]!, /saving tool payload L-1\.wav \(audio, "audio\/wav", 4 B\) failed: disk gone/);
});

test('malformed content: a bad entry is named and left out; content that is not a list is a malformed result', async () => {
  const r = await normalizeStandardToolResult({ content: [{ type: 'text', text: 'ok' }, null, 'stray', { type: 'text', text: 42 }] }, 'L', null);
  assert.equal(r.success, true);
  assert.equal(r.data,
    'ok\n[malformed content entry, left out: null]\n[malformed content entry, left out: stray]\n' +
    '[malformed text block, left out: its text is not a string]');

  const notList = await normalizeStandardToolResult({ content: { type: 'text', text: 'a block, not a list' }, structuredContent: { n: 1 } }, 'L', null);
  assert.deepEqual(notList, {
    success: false,
    error: '[malformed result: its content is not a list of blocks; the tool may already have completed]\n{"n":1}',
    isError: true,
    structured: { n: 1 },
  });

  // Absent content is no content, as a structured-only result may send it.
  const absent = await normalizeStandardToolResult({ structuredContent: { n: 1 } }, 'L', null);
  assert.equal(absent.success, true);
  assert.equal(absent.data, '{"n":1}');
});

test("stub text never splits a surrogate pair, and a wrapped payload's size counts only its bytes", async () => {
  // One ASCII character first, so a cut by UTF-16 units would land inside a pair.
  const r = await normalizeStandardToolResult({ content: [{ type: 'resource_link', uri: 'memo://x', name: `a${'😀'.repeat(300)}` }] }, 'L', null);
  assert.equal(r.data, `[resource link "a${'😀'.repeat(199)}…": memo://x; not fetched]`);

  const wrapped = b64('hello world').replace(/(.{4})/g, '$1\r\n');
  const sized = await normalizeStandardToolResult({ content: [{ type: 'audio', data: wrapped, mimeType: 'audio/wav' }] }, 'L', null);
  assert.match(sized.error!, /\[audio: audio\/wav, 11 B\. Not retained/);
});

test("a subtype named like one of Object.prototype's members is just a name", async () => {
  const { save, saved } = recordingSave();
  await normalizeStandardToolResult({
    content: [
      { type: 'audio', data: b64('a'), mimeType: 'audio/constructor' },
      { type: 'audio', data: b64('b'), mimeType: 'audio/__proto__' },
    ],
  }, 'L', save);
  assert.deepEqual(saved.map((p) => p.fileName), ['L-1.bin', 'L-2.proto']);
});
