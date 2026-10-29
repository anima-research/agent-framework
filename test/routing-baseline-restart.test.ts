/**
 * The routing announcement after a restart compares with what the agent was
 * last told before it, not with nothing: told its speech lands in a channel,
 * a later turn with no locus says it no longer does.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentFramework } from '../src/index.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { fixture } from './helpers/coalescing-fixture.js';
import { registerOpen, incoming, has, stored, textOf, MENTION, channellessTurnLocus } from './helpers/admission.js';

const storedBaselines = (framework: AgentFramework): Record<string, unknown> =>
  ((framework as unknown as { store: { getStateJson(id: string): unknown } }).store.getStateJson('framework/state') as
    { announcedLoci?: Record<string, unknown> } | null)?.announcedLoci ?? {};

describe('the routing announcement across a restart', () => {
  it('a turn with no locus after a restart is told so, when the agent was last told of a channel', async () => {
    const f = await fixture();
    try {
      await registerOpen(f, 'work');
      f.alwaysRespond();
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      assert.ok(has(f, 'Your plain speech now lands in'), 'told of the channel before the restart');
      await f.framework.stop();
      await f.create();
      assert.equal(await channellessTurnLocus(f), null);
      assert.ok(has(f, 'Your plain speech currently goes to no channel'), 'told it no longer lands there');
      // That announcement is stored too, so the boot after it doesn't tell it again.
      await f.framework.stop();
      await f.create();
      assert.equal(await channellessTurnLocus(f), null);
      const told = stored(f).filter((m) => textOf(m).includes('Your plain speech currently goes to no channel')).length;
      assert.equal(told, 1, 'told once, across the next boot');
    } finally { await f.close(); }
  });

  it('a resident declared by configuration keeps its baseline through stopAgent and the next boot', async () => {
    const f = await fixture({ agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }, { name: 'aide', model: 'test', systemPrompt: 'test' }] });
    try {
      await registerOpen(f, 'work');
      const wake = (channelId?: string) => (f.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'aide', reason: 'test', source: 'test', timestamp: Date.now(), ...(channelId ? { channelId } : {}),
      });
      wake('work');
      await f.turn();
      const told = (text: string) => stored(f, 'aide').some((m) => textOf(m).includes(text));
      assert.ok(told('Your plain speech now lands in'), 'premise: aide was told of the channel');
      f.framework.stopAgent('aide');
      await f.framework.stop();
      await f.create();
      assert.ok(f.framework.getAgent('aide'), 'premise: aide is back at the boot');
      wake();
      await f.turn();
      assert.ok(told('Your plain speech currently goes to no channel'), 'told it no longer lands there');
    } finally { await f.close(); }
  });

  it("a conversation fork's baseline goes when the fork ends", async () => {
    const f = await fixture({ framework: { conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } } } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work');
      f.alwaysRespond();
      await incoming(f, 'work', 'w1', 'agent, are you there?', MENTION);
      await f.framework.runUntilIdle();
      const fork = f.framework.getConversationRouter()!.getBinding({ serverId: 'editor', channelId: 'work' })?.agentName;
      assert.ok(fork, 'premise: the message spawned a fork');
      assert.ok(stored(f, fork).some((m) => textOf(m).includes('Your plain speech now lands in work')), 'premise: its first turn was told of its home');
      assert.ok(Object.hasOwn(storedBaselines(f.framework), fork), "premise: and the fork's baseline is stored");
      (f.framework as unknown as { disposeConversationAgent(name: string): void }).disposeConversationAgent(fork);
      assert.ok(!Object.hasOwn(storedBaselines(f.framework), fork), 'its baseline went with it');
    } finally { await f.close(); }
  });

  it("a fresh resident's turn with no locus says nothing about routing, after a restart too", async () => {
    const f = await fixture();
    try {
      assert.equal(await channellessTurnLocus(f), null);
      await f.framework.stop();
      await f.create();
      assert.equal(await channellessTurnLocus(f), null);
      assert.ok(!has(f, '[routing]'), 'no routing notice');
      assert.ok(!Object.hasOwn(storedBaselines(f.framework), 'agent'), 'and a quiet start stores nothing');
    } finally { await f.close(); }
  });

  it("an ephemeral run's baseline goes when the run ends, though it opened a channel", async () => {
    const f = await fixture();
    try {
      await f.send('channels/register', {
        channels: [{ id: 'work', type: 'discord', label: 'work', initiallyOpen: false, metadata: { channelType: 'guild_text' } }],
      });
      const fw = f.framework as unknown as { rememberAnnouncedLocus(name: string, locus: unknown): void };
      const remember = fw.rememberAnnouncedLocus.bind(fw);
      const told: string[] = [];
      fw.rememberAnnouncedLocus = (name: string, locus: unknown) => { told.push(name); remember(name, locus); };
      f.membrane.responses.length = 0; // the fixture pre-scripts an `ok`
      (f.membrane as unknown as { responseIndex: number }).responseIndex = 0;
      f.membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'o1', name: 'channel_open', input: { channelId: 'work' } }], 'tool_use'));
      f.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'done' }]));
      const created = await f.framework.createEphemeralAgent({ name: 'run-1', model: 'test', systemPrompt: 'Do the task.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const run = f.framework.runEphemeralToCompletion(created.agent, created.contextManager);
      f.framework.start();
      await run;
      assert.ok(told.includes('run-1'), 'premise: the run was told of the channel it opened, and its baseline written');
      assert.ok(!Object.hasOwn(storedBaselines(f.framework), 'run-1'), 'its baseline went with it');
    } finally { await f.close(); }
  });
});
