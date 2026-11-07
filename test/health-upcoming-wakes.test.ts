/**
 * healthSnapshot's upcomingWakes: what an operator's dashboard reads as "next
 * wake". It goes to observers granted health alone, so it must say when and
 * what kind without quoting anything the agent wrote.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

type Wake = { at?: number; kind?: string; certain: boolean };

async function frameworkWith(t: { after(fn: () => Promise<void> | void): void }, heartbeat?: unknown) {
  const own = mkdtempSync(join(tmpdir(), 'health-wakes-'));
  const framework = await AgentFramework.create({
    storePath: join(own, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 's', proseRouting: 'disabled' }],
    modules: [],
    ...(heartbeat !== undefined ? { heartbeat: heartbeat as true } : {}),
    gate: { configPath: join(own, 'gate.json'), config: { policies: [] } },
  });
  t.after(async () => { await framework.stop(); rmSync(own, { recursive: true, force: true }); });
  const internals = framework as unknown as {
    heartbeat: { start(): void; handleToolCall(name: string, input: unknown): { success: boolean } };
    eventGate: {
      addPolicy(p: unknown): void;
      evaluate(info: unknown): unknown;
      armSelfWake(agent: string, seconds: number): void;
      setSleep(seconds: number, note?: string, agent?: string): unknown;
    };
    pendingRequests: Array<{ agentName: string; reason: string }>;
    mcplServerConfigs: Map<string, { id: string }>;
    upcomingWakesFor(agentName: string): unknown;
  };
  if (heartbeat !== undefined) internals.heartbeat.start();
  const wakes = (): Wake[] | undefined => {
    const snapshot = framework.healthSnapshot() as { agents: Array<{ name: string; upcomingWakes?: Wake[] }> };
    return snapshot.agents.find((a) => a.name === 'scout')!.upcomingWakes;
  };
  return { framework, internals, wakes };
}

describe('healthSnapshot: upcomingWakes', () => {
  it('reports an empty list when nothing is due', async (t) => {
    const { wakes } = await frameworkWith(t);
    assert.deepEqual(wakes(), []);
  });

  it("lists the heartbeat's tick and reminders, soonest first, with no reminder text", async (t) => {
    const secret = 'the words only the agent should read';
    const { framework, internals, wakes } = await frameworkWith(t, { defaults: { intervalSeconds: 600 } });
    const before = Date.now();
    assert.equal(internals.heartbeat.handleToolCall('heartbeat--reminder_add', { message: secret, inMinutes: 5 }).success, true);
    const after = Date.now();
    const listed = wakes()!;
    assert.deepEqual(listed.map((w) => [w.kind, w.certain]), [['reminder', true], ['heartbeat', true]]);
    assert.ok(listed[0]!.at! >= before + 300_000 && listed[0]!.at! <= after + 300_000, 'the reminder is due in five minutes');
    assert.ok(listed[0]!.at! < listed[1]!.at!, 'soonest first');
    for (const wake of listed) assert.deepEqual(Object.keys(wake).sort(), ['at', 'certain', 'kind']);
    assert.ok(!JSON.stringify(framework.healthSnapshot()).includes(secret));
  });

  it("lists the gate's self-wake and a sleep's end, and marks a tick the agent's rules would hold back", async (t) => {
    const { internals, wakes } = await frameworkWith(t, { defaults: { intervalSeconds: 3600 } });
    internals.eventGate.armSelfWake('scout', 60);
    internals.eventGate.setSleep(300, undefined, 'scout');
    internals.eventGate.addPolicy({ name: 'no-ticks', match: { scope: ['mcpl:push-event'], source: 'heartbeat' }, behavior: 'skip' });
    assert.deepEqual(wakes()!.map((w) => [w.kind, w.certain]), [
      ['self-wake', true],
      ['sleep-end', true],
      ['heartbeat', false],
    ]);
  });

  it("quotes no rule name from a gate wake's description", async (t) => {
    const rule = 'a-rule-name-the-agent-chose';
    const { framework, internals, wakes } = await frameworkWith(t);
    internals.eventGate.addPolicy({ name: rule, match: { scope: ['workspace:modified'] }, behavior: { debounce: 60000 } });
    internals.eventGate.evaluate({ content: 'notes.md', eventType: 'workspace:modified', serverId: '', channelId: '' });
    const [wake] = wakes()!;
    assert.equal(wake!.kind, 'debounce');
    assert.deepEqual(Object.keys(wake!).sort(), ['at', 'certain', 'kind']);
    assert.ok(!JSON.stringify(framework.healthSnapshot()).includes(rule));
  });

  it('lists a queued wake first, with no time and without its reason', async (t) => {
    const reason = 'a reason that quotes a channel';
    const { framework, internals, wakes } = await frameworkWith(t, { defaults: { intervalSeconds: 3600 } });
    internals.pendingRequests.push({ agentName: 'scout', reason });
    const listed = wakes()!;
    internals.pendingRequests.length = 0;
    assert.deepEqual(listed[0], { kind: 'queued', certain: true });
    assert.equal(listed[1]!.kind, 'heartbeat');
    internals.pendingRequests.push({ agentName: 'scout', reason });
    const text = JSON.stringify(framework.healthSnapshot());
    internals.pendingRequests.length = 0;
    assert.ok(!text.includes(reason));
  });

  it('lists at most eight, the soonest', async (t) => {
    const { internals, wakes } = await frameworkWith(t, { defaults: { intervalSeconds: 3600 } });
    const before = Date.now();
    for (let i = 12; i >= 1; i--) {
      assert.equal(internals.heartbeat.handleToolCall('heartbeat--reminder_add', { message: `r${i}`, inMinutes: i }).success, true);
    }
    assert.deepEqual(wakes()!.map((w) => Math.round((w.at! - before) / 60_000)), [1, 2, 3, 4, 5, 6, 7, 8]);
    // The gate's wakes are read after the heartbeat's, and the soonest still leads.
    internals.eventGate.armSelfWake('scout', 30);
    const listed = wakes()!;
    assert.equal(listed[0]!.kind, 'self-wake');
    assert.deepEqual(listed.slice(1).map((w) => Math.round((w.at! - before) / 60_000)), [1, 2, 3, 4, 5, 6, 7]);
  });

  it('leaves out a wake whose time is given in words, so it pushes no timed wake past the eight', async (t) => {
    const { internals, wakes } = await frameworkWith(t, { defaults: { intervalSeconds: 3600 } });
    const gate = internals.eventGate as unknown as {
      inferenceBuffer: Array<Record<string, unknown>>;
      upcomingWakes(agentNames: string[]): Array<{ at?: number; when?: string }>;
    };
    const before = Date.now();
    for (let i = 8; i >= 1; i--) {
      assert.equal(internals.heartbeat.handleToolCall('heartbeat--reminder_add', { message: `r${i}`, inMinutes: i }).success, true);
    }
    gate.inferenceBuffer.push({ policyName: 'files', eventType: 'workspace:modified', content: 'notes.md', timestamp: Date.now(), addressed: false });
    try {
      assert.ok(gate.upcomingWakes(['scout']).some((w) => w.at === undefined && w.when !== undefined), 'premise: the gate lists one, events buffered behind a turn');
      assert.deepEqual(wakes()!.map((w) => Math.round((w.at! - before) / 60_000)), [1, 2, 3, 4, 5, 6, 7, 8]);
    } finally {
      gate.inferenceBuffer.length = 0;
    }
  });

  it('leaves the field out when the read throws, says why, and so reads as unknown and not as nothing due', async (t) => {
    const { internals, wakes } = await frameworkWith(t, { defaults: { intervalSeconds: 3600 } });
    internals.upcomingWakesFor = () => { throw new Error('the read failed'); };
    const logged = t.mock.method(console, 'error', () => {});
    assert.equal(wakes(), undefined);
    assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes('scout') && String(call.arguments[0]).includes('the read failed')));
  });

  it("leaves the field out when the heartbeat is heartbeat-mcpl, whose next tick it can't see", async (t) => {
    const { internals, wakes } = await frameworkWith(t);
    internals.eventGate.armSelfWake('scout', 60);
    assert.equal(wakes()!.length, 1, 'premise: it reports without the server');
    internals.mcplServerConfigs.set('heartbeat', { id: 'heartbeat' });
    assert.equal(wakes(), undefined);
    internals.mcplServerConfigs.delete('heartbeat');
    internals.mcplServerConfigs.set('another', { id: 'another' });
    assert.equal(wakes()!.length, 1, 'another server is no heartbeat');
  });
});
