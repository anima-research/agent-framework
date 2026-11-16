/**
 * `chat:system` notices (MCPL RFC-001 rev 3): an event about the place a
 * conversation happens in (someone joined, a pin, a world's weather changing),
 * not a message anyone sent.
 *
 * The case that motivated it: a world's forecast line arrived tagged
 * `chat:ambient`, the tag for overheard chatter. A heartbeat turn with no
 * channel of its own took the most recent inbound message's channel for its
 * plain speech, and a reply meant for a private conversation was spoken
 * aloud in the world. A notice must never decide where the agent's plain
 * speech goes: it doesn't retarget the default publish channel (see
 * channel-registry-routing), doesn't move a turn's pin mid-turn (see
 * present-while-acting), and doesn't name the channel of a turn it wakes
 * (here).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import type { InferenceRequest } from '../src/index.js';
import { expandCoreTags, isMarkerTagged, isSystemNotice } from '../src/mcpl/tags.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

describe('chat:system tag rules', () => {
  it('a notice is a marker, not a conversational message', () => {
    assert.equal(isSystemNotice(['chat:ambient', 'chat:system', 'eidoverse:weather']), true);
    assert.equal(isMarkerTagged(['chat:ambient', 'chat:system'], false), true);
    assert.equal(isMarkerTagged(['chat:ambient', 'chat:system'], true), true, 'first view makes an edit a message, never a notice');
    assert.equal(isSystemNotice(['chat:ambient']), false);
    assert.equal(isMarkerTagged(['chat:ambient'], false), false, 'overheard chatter is still conversation');
  });

  it('expansion keeps chat:system on a notice, alongside chat:ambient', () => {
    assert.deepEqual(expandCoreTags(['chat:ambient', 'chat:system', 'eidoverse:weather']),
      ['chat:ambient', 'chat:system', 'eidoverse:weather']);
  });

  it('chat:system is its own facet: addressing leaves it standing, so a notice in a DM is still a notice', () => {
    // chat:dm ⇒ chat:addressed by place: a pin in a DM is addressed and
    // still nobody's speech.
    const pinInDm = expandCoreTags(['chat:dm', 'chat:system']);
    assert.deepEqual(pinInDm, ['chat:dm', 'chat:addressed', 'chat:private', 'chat:system']);
    assert.equal(isMarkerTagged(pinInDm, false), true, 'it still steers nothing');
    assert.deepEqual(expandCoreTags(['chat:ambient', 'chat:system', 'chat:mention']), ['chat:system', 'chat:mention', 'chat:addressed'],
      'addressed still drops ambient, and only ambient');
  });
});

function internals(framework: AgentFramework) {
  return framework as unknown as {
    pendingRequests: InferenceRequest[];
    processInferenceRequests(): Promise<void>;
    startAgentStream(agent: unknown, trigger?: InferenceRequest): Promise<void>;
    handleMcplChannelIncoming(event: Record<string, unknown>): Promise<void>;
  };
}

describe('chat:system wakes name no channel for the turn', () => {
  let tempDir: string;
  let membrane: MockMembrane;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chat-system-test-'));
    membrane = new MockMembrane();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function makeFramework(gate?: Parameters<typeof AgentFramework.create>[0]['gate']) {
    return AgentFramework.create({
      storePath: join(tempDir, gate ? 'gated.chronicle' : 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      modules: [],
      ...(gate ? { gate } : {}),
    });
  }

  /** The merged trigger handed to the turn's start. */
  function spy(framework: AgentFramework) {
    const i = internals(framework);
    const captured: { handed?: InferenceRequest } = {};
    const orig = i.startAgentStream.bind(framework);
    i.startAgentStream = async (agent: unknown, trigger?: InferenceRequest) => {
      captured.handed = trigger;
      return orig(agent, trigger);
    };
    return captured;
  }

  function incoming(tags: string[], text: string): Record<string, unknown> {
    return {
      type: 'mcpl:channel-incoming',
      serverId: 'eidoverse',
      channelId: 'world:commons',
      messageId: `m-${Math.random().toString(36).slice(2)}`,
      author: { id: 'world', name: 'commons' },
      content: [{ type: 'text', text }],
      timestamp: new Date().toISOString(),
      metadata: {},
      tags,
      triggerInference: true,
    };
  }

  it('the incoming path marks a notice wake, and only a notice', async () => {
    const framework = await makeFramework();
    const i = internals(framework);
    await i.handleMcplChannelIncoming(incoming(['chat:ambient', 'chat:system', 'eidoverse:weather'], '* world weather: clear'));
    await i.handleMcplChannelIncoming(incoming(['chat:ambient'], 'someone talking nearby'));
    assert.equal(i.pendingRequests.length, 2);
    assert.equal(i.pendingRequests[0]!.systemNotice, true, 'the weather line is a notice');
    assert.equal(i.pendingRequests[0]!.channelId, 'world:commons', 'it still says where it came from');
    assert.equal(i.pendingRequests[1]!.systemNotice, undefined, 'overheard speech is not');
    i.pendingRequests.length = 0;
    await framework.stop();
  });

  it('the push lane marks a notice wake too', async () => {
    const framework = await makeFramework();
    const i = internals(framework) as unknown as {
      pendingRequests: InferenceRequest[];
      handleMcplPushEvent(event: Record<string, unknown>): unknown;
    };
    const push = (tags: string[]) => i.handleMcplPushEvent({
      type: 'mcpl:push-event', serverId: 'body', featureSet: 'body.home', eventId: `e-${Math.random()}`,
      timestamp: new Date().toISOString(), content: [{ type: 'text', text: 'plugin synced' }],
      origin: {}, tags, triggerInference: true,
    });
    await push(['chat:ambient', 'chat:system']);
    await push(['chat:ambient']);
    assert.equal(i.pendingRequests.length, 2);
    assert.equal(i.pendingRequests[0]!.systemNotice, true);
    assert.equal(i.pendingRequests[1]!.systemNotice, undefined);
    i.pendingRequests.length = 0;
    await framework.stop();
  });

  it('a newer notice does not outrank an older message for the turn\'s channel', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t,
        channelId: 'discord:g:room', counterparty: 'discord:user:alice', addressed: false, ambient: true },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'eidoverse', timestamp: t + 1,
        channelId: 'world:commons', channelServerId: 'eidoverse', addressed: false, ambient: true, systemNotice: true },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, 'discord:g:room', 'the message names the channel, not the newer notice');
    assert.notEqual(captured.handed?.systemNotice, true);
    await framework.stop();
  });

  it('a turn a notice wakes alone has no channel of its own, as a heartbeat does', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'eidoverse', timestamp: Date.now(),
        channelId: 'world:commons', channelServerId: 'eidoverse', addressed: false, ambient: true, systemNotice: true },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, undefined, 'no channel: the turn takes the global fallback');
    assert.equal(captured.handed?.channelServerId, undefined);
    await framework.stop();
  });

  it('a notice leading the batch lends its mark to nothing: the merged start keeps the message\'s channel unmarked', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    const framework = await makeFramework();
    const i = internals(framework);
    const captured = spy(framework);
    const t = Date.now();
    i.pendingRequests.push(
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'eidoverse', timestamp: t,
        channelId: 'world:commons', channelServerId: 'eidoverse', addressed: false, ambient: true, systemNotice: true },
      { agentName: 'scout', reason: 'mcpl:channel-incoming', source: 'discord', timestamp: t + 1,
        channelId: 'discord:dm:alice', addressed: true, counterparty: 'discord:user:alice' },
    );
    await i.processInferenceRequests();
    await framework.runUntilIdle();
    assert.equal(captured.handed?.channelId, 'discord:dm:alice');
    assert.notEqual(captured.handed?.systemNotice, true,
      'merged again, a start marked as a notice would hide the DM\'s channel from the selection');
    await framework.stop();
  });

  it('a notice the gate batches stamps its turn as the same notice woken directly does', async () => {
    const stamp = async (gated: boolean) => {
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
      const framework = await makeFramework(gated
        ? { config: { policies: [{ name: 'batch', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 50 } }], default: 'skip' } }
        : undefined);
      const i = internals(framework);
      let stamped: InferenceRequest | undefined;
      const start = i.startAgentStream.bind(framework);
      i.startAgentStream = async (agent: unknown, trigger?: InferenceRequest) => {
        const started = start(agent, trigger);
        stamped = framework.getActiveTurnTrigger('scout');
        return started;
      };
      await i.handleMcplChannelIncoming(incoming(['chat:ambient', 'chat:system'], 'pat joined'));
      const deadline = Date.now() + 10_000;
      while (i.pendingRequests.length === 0) {
        assert.ok(Date.now() < deadline, 'the notice woke the agent');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(i.pendingRequests[0]!.reason, gated ? 'gate:debounce' : 'mcpl:channel-incoming');
      await i.processInferenceRequests();
      await framework.runUntilIdle();
      await framework.stop();
      assert.ok(stamped, 'the turn exposed its trigger');
      return { channelId: stamped.channelId, wakeChannelId: stamped.wakeChannelId, counterparty: stamped.counterparty };
    };
    const direct = await stamp(false);
    assert.equal(direct.counterparty, 'eidoverse:user:world', "premise: the direct path keeps the notice's author");
    assert.deepEqual(await stamp(true), direct);
  });
});
