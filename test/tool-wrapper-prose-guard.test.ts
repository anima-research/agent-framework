import test from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock } from '@animalabs/membrane';
import { detectKnownToolWrapperProse } from '../src/tool-wrapper-prose-guard.js';

const known = new Set(['mcpl--heartbeat--heartbeat_status', 'skip_reply']);
const text = (value: string): ContentBlock[] => [{ type: 'text', text: value }];

test('whole-response known-tool prose guard: matches paired heartbeat wrapper', () => {
  assert.equal(detectKnownToolWrapperProse(text('<mcpl--heartbeat--heartbeat_status>\n</mcpl--heartbeat--heartbeat_status>'), known), 'mcpl--heartbeat--heartbeat_status');
});
test('whole-response known-tool prose guard: matches self-closing and legacy invoke wrappers', () => {
  assert.equal(detectKnownToolWrapperProse(text('<skip_reply/>'), known), 'skip_reply');
  assert.equal(detectKnownToolWrapperProse(text('<invoke><tool name="skip_reply"/></invoke>'), known), 'skip_reply');
  assert.equal(detectKnownToolWrapperProse(text('<invoke><tool name="skip_reply"><parameter name="reason">quiet</parameter></tool></invoke>'), known), 'skip_reply');
});
test('whole-response known-tool prose guard: allows signed thinking before only visible wrapper', () => {
  const blocks = [{ type: 'thinking', thinking: 'private', signature: 'sig' }, ...text('<skip_reply/>')] as ContentBlock[];
  assert.equal(detectKnownToolWrapperProse(blocks, known), 'skip_reply');
});
test('whole-response known-tool prose guard: unknown tools do not match', () => {
  assert.equal(detectKnownToolWrapperProse(text('<delete_everything/>'), known), null);
});
test('whole-response known-tool prose guard: quotation, code, mixed prose, and partial wrappers do not match', () => {
  for (const value of ['The form `<skip_reply/>` is malformed.','```xml\n<skip_reply/>\n```','<skip_reply/>\nI tried to be quiet.','prefix <skip_reply/>','<skip_reply>','<skip_reply></other>']) {
    assert.equal(detectKnownToolWrapperProse(text(value), known), null, value);
  }
});
test('whole-response known-tool prose guard: real structured calls do not match', () => {
  const blocks = [{ type: 'tool_use', id: 't1', name: 'skip_reply', input: {} }] as ContentBlock[];
  assert.equal(detectKnownToolWrapperProse(blocks, known), null);
});
test('whole-response known-tool prose guard: empty prose and empty surface do not match', () => {
  assert.equal(detectKnownToolWrapperProse(text('  '), known), null);
  assert.equal(detectKnownToolWrapperProse(text('<skip_reply/>'), new Set()), null);
});
