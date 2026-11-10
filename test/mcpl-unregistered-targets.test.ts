import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const DEBOUNCE = { debounce: 60_000 };
const JUDGE = { judge: { debounceMs: 60_000, instructions: 'Wake me for questions.' } };
const rule = (scope: string, behavior: unknown) => [{ name: 'batch', match: { scope: [scope] }, behavior }];

async function boot(policies: unknown[], opts: { routing?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mcpl-unregistered-'));
  const membrane = new MockMembrane();
  for (let k = 0; k < 4; k++) membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Hi alice!' }]));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' }],
    modules: [],
    ...(opts.routing ? { conversations: { templateAgent: 'trunk' } } : {}),
    gate: { onboarding: false, config: { policies, default: 'always' } },
  } as never);
  const turns: string[] = [];
  framework.onTrace((e) => { if (e.type === 'inference:started') turns.push((e as { agentName: string }).agentName); });
  const close = async () => { await framework.stop(); rmSync(dir, { recursive: true, force: true }); };
  return { framework, membrane, turns, close };
}

const internals = (f: AgentFramework) => f as unknown as {
  pendingRequests: Array<{ agentName: string; reason: string }>;
  eventGate: { debounceTimers: Map<string, unknown> };
  handleMcplPushEvent(event: unknown): unknown;
  tuneOutCoordinator: unknown;
  admitInbound(env: Record<string, unknown>): { wake: boolean; gatePass: boolean; held: unknown };
};

const dm = (targetAgents: string[]) => ({
  type: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'slack:D1', messageId: `m-${Math.random().toString(36).slice(2)}`,
  author: { id: 'U1', name: 'alice' }, content: [{ type: 'text', text: 'hello there' }], timestamp: new Date().toISOString(),
  metadata: { mentioned: false, channel_type: 'im' }, triggerInference: true, targetAgents,
}) as unknown as ProcessEvent;

const push = (targetAgents: string[]) => ({
  type: 'mcpl:push-event', serverId: 'notes', featureSet: 'notes', eventId: `ev-${Math.random().toString(36).slice(2)}`,
  content: [{ type: 'text', text: 'hi' }], timestamp: new Date().toISOString(), inferenceId: `inf-${Math.random().toString(36).slice(2)}`,
  triggerInference: true, targetAgents,
});

describe('an MCPL event none of whose targets is on this host', () => {
  for (const [label, behavior] of [['debounce', DEBOUNCE], ['judge', JUDGE]] as const) {
    it(`under a ${label} rule, a DM routed to a conversation fork wakes no one, as on main`, async () => {
      const { framework, membrane, turns, close } = await boot(rule('mcpl:channel-incoming', behavior), { routing: true });
      try {
        framework.pushEvent(dm(['nobody-home']));
        await framework.runUntilIdle();
        assert.ok(framework.getAllAgents().some((a) => a.name !== 'trunk'), 'premise: the DM is routed to its fork');
        assert.equal(internals(framework).eventGate.debounceTimers.size, 0, 'it joins no batch');
        assert.deepEqual(turns, [], 'no turn runs');
        assert.equal(membrane.calls.length, 0);
      } finally { await close(); }
    });
  }

  it('under always, the DM routed to a conversation fork wakes the fork, as on main', async () => {
    const { framework, turns, close } = await boot([], { routing: true });
    try {
      framework.pushEvent(dm(['nobody-home']));
      await framework.runUntilIdle();
      assert.equal(turns.length, 1);
      assert.notEqual(turns[0], 'trunk', "the fork's turn");
    } finally { await close(); }
  });

  it('under a debounce rule, a push queues no request, as on main', async () => {
    const { framework, close } = await boot(rule('mcpl:push-event', DEBOUNCE));
    const i = internals(framework);
    try {
      await i.handleMcplPushEvent(push(['nobody-home']));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(i.eventGate.debounceTimers.size, 0, 'it joins no batch');
      assert.deepEqual(i.pendingRequests.map((r) => r.agentName), []);
    } finally { await close(); }
  });

  for (const [label, behavior, pass] of [['judge', JUDGE, false], ['debounce', DEBOUNCE, true]] as const) {
    it(`held, under a ${label} rule, the hold is told the gate ${pass ? 'would' : "wouldn't"} have woken anyone, as on main`, async () => {
      const { framework, close } = await boot(rule('mcpl:channel-incoming', behavior));
      const i = internals(framework);
      const coordinator = i.tuneOutCoordinator;
      i.tuneOutCoordinator = { holdFor: () => ({ epochId: 'e1' }) };
      try {
        const decision = i.admitInbound({
          lane: 'channel', serverId: 'srv', channelId: 'srv:c1', messageId: 'm1', addressed: true, vetoed: false,
          tags: ['chat:addressed'], targetAgents: ['nobody-home'], gateContent: 'hi',
          gateMetadata: { eventType: 'mcpl:channel-incoming', serverId: 'srv', channelId: 'srv:c1' },
        });
        assert.ok(decision.held, 'premise: the event is held');
        assert.equal(decision.wake, false);
        assert.equal(decision.gatePass, pass);
      } finally {
        i.tuneOutCoordinator = coordinator;
        await close();
      }
    });
  }
});
