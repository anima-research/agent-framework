import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';

// `journal` — private long-form notes (sill, 2026-09-19). Long prose kept in
// `skip_reply.reason` / `think.content` gets every memory-compression request
// over that history refused; a note-taking tool does not. context-manager's
// tool-prose hoist rung rewrites old history into calls to this tool and
// mirrors its result wording (DEFAULT_TOOL_PROSE_RESULT) — the literal below
// is that contract.

function makeRegistry(): ChannelRegistry {
  return new ChannelRegistry({} as McplServerRegistry, {} as FeatureSetManager, () => {}, () => {}, {});
}

test('journal is a declared tool with a required content argument', () => {
  const tool = makeRegistry().getChannelTools().find((t) => t.name === 'journal');
  assert.ok(tool, 'journal is exposed');
  assert.deepEqual((tool!.inputSchema as { required: string[] }).required, ['content']);
  assert.match(tool!.description, /NOT sent/);
});

test('journal records privately: no echo, does not end the turn, wording matches the context-manager mirror', async () => {
  const entry = 'a long private reflection '.repeat(40);
  const result = await makeRegistry().handleChannelToolCall('journal', { content: entry });
  assert.equal(result.success, true);
  assert.equal((result as { endTurn?: boolean }).endTurn, undefined, 'journal must not end the turn');
  assert.equal(
    JSON.stringify(result.data),
    '{"recorded":true,"note":"Journal entry recorded (private — not sent anywhere)."}',
  );
  assert.ok(!JSON.stringify(result).includes(entry.slice(0, 40)), 'entry is not echoed back');
});

test('skip_reply.reason asks for one short line and points at journal', () => {
  const tool = makeRegistry().getChannelTools().find((t) => t.name === 'skip_reply')!;
  const reason = tool.inputSchema.properties!.reason!.description ?? '';
  assert.match(reason, /short line/);
  assert.match(reason, /journal\(\)/);
});
