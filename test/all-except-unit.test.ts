/**
 * The all-except scope's own rules, on the coordinator alone: exhausting the
 * wake budget pauses the reader rather than ending the hold (#232 §3.2, the
 * decision carried from the issue), and a scope whose deadline passed while
 * the process was down is released at resume.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

function harness() {
  const state = new Map<string, unknown>();
  const wakes: string[] = [];
  const messages: Array<{ participant: string; text: string; forAgent?: string }> = [];
  const traces: string[] = [];
  const registry = {
    getTuneOutState: () => null,
    listChannelsRaw: () => [{ serverId: 'disc', descriptor: { id: 'work' } }, { serverId: 'disc', descriptor: { id: 'noisy' } }],
    readCoordinatorState: (id: string) => state.get(id) ?? null,
    writeCoordinatorState: (id: string, value: unknown) => { state.set(id, value); },
  } as unknown as ChannelRegistry;
  const servers = { getServer: () => undefined } as unknown as McplServerRegistry;
  const hooks = {
    addMessage: (participant: string, content: Array<{ type: string; text?: string }>, _m: unknown, forAgent?: string) => {
      messages.push({ participant, text: content.map((b) => b.text ?? '').join(''), forAgent });
      return 'id';
    },
    requestInference: (agentName: string) => { wakes.push(agentName); },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => [],
    currentSequence: () => 1,
    setSubconsciousAnchor: () => {},
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: (e: { type: string }) => { traces.push(e.type); },
  } as unknown as TuneOutFrameworkHooks;
  const make = () => new TuneOutCoordinator(registry, servers, hooks);
  return { make, state, wakes, messages, traces };
}

describe('all-except scope on the coordinator', () => {
  it('exhausting the wake budget pauses reader wakes; the hold stays', () => {
    const h = harness();
    const c = h.make();
    const r = c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120, maxWakes: 1 }, 'agent-tool');
    assert.ok(r.ok);
    const fire = (c as unknown as { fireWake(s: string, ch: string, n: number): void }).fireWake.bind(c);
    fire('disc', 'noisy', 1);
    assert.deepEqual(h.wakes, ['Subconscious'], 'the first wake reaches the reader');
    assert.equal(c.getAllExcept()!.wakeCount, 1, 'counted durably');
    fire('disc', 'noisy', 1);
    assert.deepEqual(h.wakes, ['Subconscious'], 'the second is paused, not delivered');
    assert.ok(c.getAllExcept(), 'the scope is still in force');
    assert.ok(h.traces.includes('tune-out:wake-budget-paused'));
    c.stop();
  });

  it('a scope whose deadline passed while the process was down is released at resume', () => {
    const h = harness();
    const first = h.make();
    assert.ok(first.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    first.stop();
    // Age the durable record past its deadline, as a long outage would.
    const id = [...h.state.keys()].find((k) => k.endsWith('/all-except'))!;
    const record = h.state.get(id) as { params: { expiresAtMs: number } };
    record.params.expiresAtMs = Date.now() - 1000;
    const second = h.make();
    second.resumeActiveEpochs();
    assert.equal(second.getAllExcept(), null, 'released');
    assert.ok(h.messages.some((m) => /all channels except work released — duration elapsed/.test(m.text)), 'the release reached the resident');
    assert.ok(h.wakes.includes('scout'), 'and woke them');
    second.stop();
  });
});
