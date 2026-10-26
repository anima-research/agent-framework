/**
 * toMembraneToolResult (6.6): JSON.stringify(undefined) returns the VALUE
 * undefined, not a string — a tool returning `{ success: true }` with no data
 * plus a configured maxChars cap used to throw a TypeError on content.length
 * mid-turn. It must degrade to a safe empty string instead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import { NON_STRING_TEXT_PLACEHOLDER } from '../src/mcpl/visible-content.js';

function makeFw() {
  return Object.create(AgentFramework.prototype) as any;
}

test('undefined data + maxChars cap: no throw, content is a safe string', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-1', { success: true }, 1000);
  assert.equal(result.toolUseId, 'call-1');
  assert.equal(result.isError, false);
  assert.equal(result.content, '');
});

test('undefined data without a cap also yields a string (never the value undefined)', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-2', { success: true, data: undefined });
  assert.equal(typeof result.content, 'string');
});

test('normal data is still stringified and truncated by the cap', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-3', { success: true, data: { v: 'y'.repeat(500) } }, 100);
  assert.equal(typeof result.content, 'string');
  assert.match(result.content, /\[truncated — original was \d+ chars\]/);
});

test('error results pass through unchanged', () => {
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-4', { success: false, error: 'boom', isError: true }, 100);
  assert.equal(result.isError, true);
  assert.equal(result.content, 'boom');
});

test('beside an image, a text block whose text is not a string shows the placeholder, and a reference is still a stub', () => {
  // The native blocks used to give way to the JSON fallback, which sent the
  // image as base64 text and the reference's uri as it was.
  const fw = makeFw();
  const result = fw.toMembraneToolResult('call-5', { success: true, data: [
    { type: 'text', text: { a: 1 } },
    { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    { type: 'resource', uri: 'https://signed.example/f?token=RAW_TOKEN', mimeType: 'text/plain', sizeBytes: 10, name: 'f.txt', disposition: 'never' },
  ] });
  assert.ok(Array.isArray(result.content), String(result.content).slice(0, 200));
  assert.deepEqual(result.content[0], { type: 'text', text: NON_STRING_TEXT_PLACEHOLDER });
  assert.equal(result.content[1].type, 'image');
  assert.ok(result.content[2].text.startsWith('[ref_'), result.content[2].text);
  assert.ok(!JSON.stringify(result.content).includes('RAW_TOKEN'));
});
