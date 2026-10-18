import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unknownToolMessage } from '../src/modules/unknown-tool.js';

// What a bundled module answers for a tool name it doesn't route, which the
// discord, health, api and history modules share: the whole name, that
// nothing ran, and the module's own tools, read from its getTools().
test('an unknown module tool is named whole, nothing ran, and the module\'s own tools are listed', () => {
  assert.equal(unknownToolMessage('api', 'send', []),
    'There\'s no tool "api--send", so nothing ran. The api module has no tools of its own: every tool you can call is in your tool list.');
  assert.equal(unknownToolMessage('health', 'status', [{ name: 'snapshot' }]),
    'There\'s no tool "health--status", so nothing ran. The health module\'s one tool is health--snapshot.');
  assert.equal(unknownToolMessage('history', 'serch', [{ name: 'search' }, { name: 'read' }, { name: 'extract' }]),
    'There\'s no tool "history--serch", so nothing ran. The history module\'s tools are history--search, history--read and history--extract.');
});
