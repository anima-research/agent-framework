/**
 * The all-except scope's own rules, on the coordinator alone: exhausting the
 * wake budget pauses the reader rather than ending the hold (#232 §3.2, the
 * decision carried from the issue), a scope whose deadline passed while
 * the process was down is released at resume, and a message a surgery's hold
 * keeps in memory is counted and released with those stored (#232 gap 7).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import type { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';

type Held = { id?: string; participant: string; content: Array<{ type: string; text?: string }>; metadata?: Record<string, unknown> };

/** `stored`: the primary's stored messages; `kept`: the writes a surgery's
 *  hold keeps in memory; `writesHeld`: the framework's hook, which a
 *  surgery's hold makes true (left out, no write is taken to be held). */
function harness(held: { stored?: Held[]; kept?: Held[]; writesHeld?: () => boolean } = {}) {
  const stored = held.stored ?? [];
  const kept = held.kept ?? [];
  const state = new Map<string, unknown>();
  const wakes: string[] = [];
  const messages: Array<{ participant: string; text: string; forAgent?: string }> = [];
  const traces: string[] = [];
  const fail = { read: false, write: false, addMessage: false, commit: false, wake: false };
  const anchors: number[] = [];
  const registry = {
    getTuneOutState: () => null,
    // Each channel is shown by its id where no other server registers it,
    // and with its server where two do (general, on disc and slack).
    nameShown: (ref: { serverId: string; channelId: string }) => (ref.channelId === 'general' ? `${ref.channelId} (${ref.serverId})` : ref.channelId),
    listChannelsRaw: () => [
      { serverId: 'disc', descriptor: { id: 'work' } }, { serverId: 'disc', descriptor: { id: 'noisy' } },
      { serverId: 'disc', descriptor: { id: 'general' } }, { serverId: 'slack', descriptor: { id: 'general' } },
    ],
    readCoordinatorState: (id: string) => {
      if (fail.read) throw new Error('store unreadable');
      return state.get(id) ?? null;
    },
    writeCoordinatorState: (id: string, value: unknown) => {
      if (fail.write) throw new Error('store write failed');
      state.set(id, value);
    },
  } as unknown as ChannelRegistry;
  const servers = { getServer: () => undefined } as unknown as McplServerRegistry;
  const hooks = {
    addMessage: (participant: string, content: Array<{ type: string; text?: string }>, metadata: Record<string, unknown> | undefined, forAgent?: string) => {
      if (fail.addMessage) throw new Error('context write failed');
      messages.push({ participant, text: content.map((b) => b.text ?? '').join(''), forAgent });
      if (!forAgent && metadata) stored.push({ participant, content, metadata });
      return 'id';
    },
    commitDeliveries: () => !fail.commit,
    requestInference: (agentName: string) => {
      if (fail.wake) throw new Error('the wake request failed');
      wakes.push(agentName);
    },
    subconsciousName: () => 'Subconscious',
    primaryName: () => 'scout',
    getStoredMessages: () => stored,
    getSurgeryHeldMessages: () => kept,
    currentSequence: () => 1,
    setSubconsciousAnchor: (start: { sequence: number }) => { anchors.push(start.sequence); },
    isForkBound: () => false,
    isPrivilegedAuthor: () => false,
    allowChannelSpeech: () => false,
    emitTrace: (e: { type: string }) => { traces.push(e.type); },
    ...(held.writesHeld ? { writesHeld: held.writesHeld } : {}),
  } as unknown as TuneOutFrameworkHooks;
  const make = () => new TuneOutCoordinator(registry, servers, hooks);
  return { make, state, wakes, messages, traces, fail, stored, anchors };
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

  it("two servers' channels that share an id are counted and released apart", () => {
    const stored: Held[] = [];
    const h = harness({ stored });
    const c = h.make();
    const r = c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120, backlogCap: 1 }, 'agent-tool');
    assert.ok(r.ok);
    const epochId = c.getAllExcept()!.params.epochId;
    const held = (serverId: string, text: string) => stored.push({
      participant: 'user', content: [{ type: 'text', text }],
      metadata: { channelId: 'general', serverId, tuneOut: { epochId } },
    });
    held('disc', 'one on disc');
    held('disc', 'two on disc');
    held('slack', 'one on slack');
    assert.deepEqual(c.check().allExcept!.held, { 'general (disc)': 2, 'general (slack)': 1 });
    assert.ok(c.cancelAllExcept('agent-tool', 'test').ok);
    const release = h.messages.find((m) => /released/.test(m.text))!.text;
    assert.equal(release.split('<tuned-out-backlog ').length - 1, 2, release);
    assert.ok(release.includes('two on disc') && release.includes('one on slack'), 'each channel keeps its own cap of one');
    assert.ok(!release.includes('one on disc'), "disc's older message is past its cap");
    c.stop();
  });

  it('a scope whose deadline passed while the process was down and whose release fails at the start stays in force, arms its retry, and the start goes on', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    t.mock.method(console, 'error', () => {});
    const h = harness();
    const first = h.make();
    assert.ok(first.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    first.stop();
    const id = [...h.state.keys()].find((k) => k.endsWith('/all-except'))!;
    const record = h.state.get(id) as { params: { expiresAtMs: number } };
    record.params.expiresAtMs = Date.now() - 1000;
    h.fail.commit = true;
    const second = h.make();
    assert.doesNotThrow(() => second.resumeActiveEpochs());
    assert.ok(second.getAllExcept(), 'the hold stays in force');
    h.fail.commit = false;
    t.mock.timers.tick(60_000);
    assert.equal(second.getAllExcept(), null, 'its retry released it');
    const releases = h.messages.filter((m) => /all channels except work released — duration elapsed/.test(m.text));
    assert.equal(releases.length, 1, 'the resident got the release once');
    second.stop();
  });

  it('a scope whose deadline passed while the process was down and whose release ends it at the start but then fails a later step is treated as ended, with no retry, and the start goes on', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
    const errors = t.mock.method(console, 'error', () => {});
    const h = harness();
    const first = h.make();
    assert.ok(first.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    first.stop();
    const id = [...h.state.keys()].find((k) => k.endsWith('/all-except'))!;
    const record = h.state.get(id) as { params: { expiresAtMs: number } };
    record.params.expiresAtMs = Date.now() - 1000;
    h.fail.wake = true;
    h.anchors.length = 0;
    const second = h.make();
    let releases = 0;
    const release = second.cancelAllExcept.bind(second);
    second.cancelAllExcept = (...args: Parameters<TuneOutCoordinator['cancelAllExcept']>) => { releases++; return release(...args); };
    assert.doesNotThrow(() => second.resumeActiveEpochs());
    assert.equal(second.getAllExcept(), null, 'its end was recorded');
    assert.deepEqual(h.anchors, [], 'no hold in force anchors the subconscious');
    const said = errors.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.match(said, /its release ended it, but a step after the end failed/);
    assert.ok(!/stays in force/.test(said), said);
    h.fail.wake = false;
    t.mock.timers.tick(10 * 60_000);
    second.stop();
    assert.equal(releases, 1, 'nothing tries to release it again');
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

  // Review 2, J-AF29: the hold's writes are stored only at its release, so
  // the scope read the record alone and left them out of its counts and its
  // release. A check during the hold counts them. A framework cancel waits
  // for the release (writesHeld, the next test); one goes on during the
  // hold only where asking whether writes are held throws, and it is that
  // release that reads the writes the hold keeps beside those stored.
  it("counts a held message a surgery's hold keeps in memory, and a cancel that goes on during the hold, asking whether writes are held having thrown, releases it after those stored", () => {
    const stored: Held[] = [];
    const kept: Held[] = [];
    const h = harness({ stored, kept, writesHeld: () => { throw new Error('the hold could not be asked about'); } });
    const c = h.make();
    const r = c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool');
    assert.ok(r.ok);
    const epochId = c.getAllExcept()!.params.epochId;
    const message = (t: string): Held => ({
      participant: 'user', content: [{ type: 'text', text: t }],
      metadata: { tuneOut: { epochId }, channelId: 'noisy', serverId: 'disc', author: { name: 'antra' } },
    });
    stored.push(message('N1 stored'));
    kept.push(message('N2 kept by the hold'));
    assert.deepEqual(c.check().allExcept?.held, { noisy: 2 }, 'a check counts the kept one with the stored one');
    assert.ok(c.cancelAllExcept('duration', 'duration elapsed').ok);
    const release = h.messages.find((m) => /all channels except work released/.test(m.text))!.text;
    assert.match(release, /2 messages held in 1 channel/, 'the release counts it');
    assert.match(release, /messages=2>\nantra: N1 stored\nantra: N2 kept by the hold/, 'and lists it, after the stored one');
    c.stop();
  });

  it("a cancel of the scope asked for during a surgery's hold waits, the hold in force, and at the release counts and lists what the hold kept, stored by then", () => {
    const stored: Held[] = [];
    const kept: Held[] = [];
    let held = true;
    const h = harness({ stored, kept, writesHeld: () => held });
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120, backlogCap: 10 }, 'agent-tool').ok);
    const epochId = c.getAllExcept()!.params.epochId;
    const message = (t: string): Held => ({
      participant: 'user', content: [{ type: 'text', text: t }],
      metadata: { tuneOut: { epochId }, channelId: 'noisy', serverId: 'disc', author: { name: 'antra' } },
    });
    stored.push(message('N1 stored'));
    kept.push(message('N2 kept by the hold'));
    assert.deepEqual(c.cancelAllExcept('duration', 'duration elapsed'), { ok: true, deferred: true }, 'it waits');
    assert.ok(c.getAllExcept(), 'the hold stays in force');
    assert.ok(!h.messages.some((m) => /all channels except work released/.test(m.text)), 'and nothing is released during the surgery');
    // The release stores what the hold kept, then runs the cancels that waited.
    held = false;
    stored.push(...kept.splice(0));
    c.runDeferredCancels();
    assert.equal(c.getAllExcept(), null, 'it ends at the release');
    const release = h.messages.find((m) => /all channels except work released/.test(m.text))!.text;
    assert.match(release, /messages=2>\nantra: N1 stored\nantra: N2 kept by the hold/, 'it lists the kept message, stored by then, after the stored one');
    c.stop();
  });

  it('a stored hold that can\'t be read is not taken for no hold, and the next read tries again', () => {
    const h = harness();
    const first = h.make();
    assert.ok(first.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    first.stop();
    h.fail.read = true;
    const second = h.make();
    assert.throws(() => second.resumeActiveEpochs(), /store unreadable/, 'resume refuses rather than resume with no hold');
    h.fail.read = false;
    assert.equal(second.getAllExcept()?.params.except.channelId, 'work', 'the failure was not remembered as no hold');
    assert.ok(second.holdFor('disc', 'noisy'), 'and the hold holds');
    second.stop();
  });

  it('a stored record that isn\'t a hold\'s is refused, not read as no hold', () => {
    const h = harness();
    const c = h.make();
    h.state.set('tune-out/scout/all-except', { params: { except: 'not a hold' } });
    assert.throws(() => c.getAllExcept(), /is not a hold's record/);
    assert.ok(h.state.has('tune-out/scout/all-except'), 'left as it is');
    c.stop();
  });

  it('an entry whose write fails leaves no hold in memory', () => {
    const h = harness();
    const c = h.make();
    h.fail.write = true;
    assert.throws(() => c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool'), /store write failed/);
    h.fail.write = false;
    assert.equal(c.getAllExcept(), null, 'memory agrees with the store');
    assert.equal(c.holdFor('disc', 'noisy'), null);
    c.stop();
  });

  it('a release that fails to be recorded leaves the hold in force, to release again', () => {
    const h = harness();
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    h.fail.addMessage = true;
    assert.throws(() => c.cancelAllExcept('agent-tool', 'done'), /context write failed/);
    h.fail.addMessage = false;
    assert.ok(c.getAllExcept(), 'the hold is still in force');
    assert.ok([...h.state.values()].some((v) => v !== null), 'and still stored');
    const again = c.cancelAllExcept('agent-tool', 'done');
    assert.ok(again.ok);
    assert.equal(c.getAllExcept(), null);
    assert.ok(h.messages.some((m) => /all channels except work released — done/.test(m.text)), 'the release reached the resident');
    c.stop();
  });

  it('a release whose hold fails to clear is delivered once, however often the clear is retried', () => {
    const h = harness();
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    h.fail.write = true;
    assert.throws(() => c.cancelAllExcept('duration', 'duration elapsed'), /store write failed/);
    assert.throws(() => c.cancelAllExcept('duration', 'duration elapsed'), /store write failed/);
    assert.ok(c.getAllExcept(), 'the hold is still in force while its end is not recorded');
    h.fail.write = false;
    assert.ok(c.cancelAllExcept('duration', 'duration elapsed').ok);
    assert.equal(c.getAllExcept(), null);
    const releases = h.messages.filter((m) => /all channels except work released/.test(m.text));
    assert.equal(releases.length, 1, 'the resident got the release once');
    c.stop();
  });

  it('a message held while the clear keeps failing reaches the resident once, and every message the first release showed is shown once', () => {
    const stored: Held[] = [];
    const h = harness({ stored });
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    const epochId = c.getAllExcept()!.params.epochId;
    const row = (id: string, text: string) => ({
      id,
      participant: 'user',
      content: [{ type: 'text', text }],
      metadata: { author: { name: 'Bo' }, serverId: 'disc', channelId: 'noisy', tuneOut: { epochId } },
    });
    stored.push(row('s1', 'first held'));
    h.fail.write = true;
    assert.throws(() => c.cancelAllExcept('duration', 'duration elapsed'), /store write failed/);
    assert.deepEqual(
      h.messages.filter((m) => /all channels except work released/.test(m.text)).map((m) => m.text.includes('first held')),
      [true],
      'the first release was written before the clear threw',
    );
    stored.push(row('s2', 'held after the first release'));
    h.fail.write = false;
    assert.ok(c.cancelAllExcept('duration', 'duration elapsed').ok);
    const all = h.messages.filter((m) => /all channels except work released/.test(m.text)).map((m) => m.text).join('\n');
    for (const line of ['first held', 'held after the first release']) {
      assert.equal(all.split(line).length - 1, 1, `the resident is shown "${line}" once: ${all}`);
    }
    c.stop();
  });

  it('after a restart between a written release and a failed clear, the next release shows nothing a second time and clears the hold', () => {
    const stored: Held[] = [];
    const h = harness({ stored });
    const before = h.make();
    assert.ok(before.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    const epochId = before.getAllExcept()!.params.epochId;
    stored.push({
      id: 's1',
      participant: 'user',
      content: [{ type: 'text', text: 'held before the restart' }],
      metadata: { author: { name: 'Bo' }, serverId: 'disc', channelId: 'noisy', tuneOut: { epochId } },
    });
    h.fail.write = true;
    assert.throws(() => before.cancelAllExcept('duration', 'duration elapsed'), /store write failed/);
    before.stop();
    h.fail.write = false;
    const after = h.make();
    assert.ok(after.getAllExcept(), 'the hold is still on record');
    assert.ok(after.cancelAllExcept('duration', 'duration elapsed').ok);
    assert.equal(after.getAllExcept(), null);
    const shown = h.messages.filter((m) => /all channels except work released/.test(m.text)).map((m) => m.text).join('\n');
    assert.equal(shown.split('held before the restart').length - 1, 1, shown);
    after.stop();
  });

  it("the release's record says how many held messages it covered and how many its dumps left out", () => {
    const stored: Held[] = [];
    const h = harness({ stored });
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120, backlogCap: 1 }, 'agent-tool').ok);
    const epochId = c.getAllExcept()!.params.epochId;
    for (const [i, channelId] of ['noisy', 'noisy', 'noisy', 'general'].entries()) {
      stored.push({
        id: `s${i}`,
        participant: 'user',
        content: [{ type: 'text', text: `held ${i}` }],
        metadata: { author: { name: 'Bo' }, serverId: 'disc', channelId, tuneOut: { epochId } },
      });
    }
    assert.ok(c.cancelAllExcept('duration', 'duration elapsed').ok);
    const release = stored.find((m) => m.metadata?.kind === 'tune-out-cancel');
    const record = release?.metadata?.released as { total: number; truncated: number } | undefined;
    assert.deepEqual({ total: record?.total, truncated: record?.truncated }, { total: 4, truncated: 2 });
    c.stop();
  });

  it('a release that could not be made durable leaves the hold in force, and its retry clears it with the release written once', () => {
    const h = harness();
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    h.fail.commit = true;
    assert.throws(() => c.cancelAllExcept('duration', 'duration elapsed'), /could not be made durable/);
    assert.ok(c.getAllExcept(), 'the hold is still in force');
    h.fail.commit = false;
    assert.ok(c.cancelAllExcept('duration', 'duration elapsed').ok);
    assert.equal(c.getAllExcept(), null);
    const releases = h.messages.filter((m) => /all channels except work released/.test(m.text));
    assert.equal(releases.length, 1, 'the resident got the release once');
    c.stop();
  });

  it('a fractional backlog cap counts whole messages, as a channel\'s does: below one shows none', () => {
    const h = harness();
    const c = h.make();
    assert.ok(c.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120, backlogCap: 0.5 }, 'agent-tool').ok);
    assert.equal(c.getAllExcept()!.params.backlogCap, 0);
    c.stop();
  });

  it('a hold stored with a fractional cap, before entry floored it, still releases whole messages', () => {
    const h = harness();
    const first = h.make();
    assert.ok(first.enterAllExcept({ serverId: 'disc', channelId: 'work' }, { durationSeconds: 120 }, 'agent-tool').ok);
    first.stop();
    const id = [...h.state.keys()].find((k) => k.endsWith('/all-except'))!;
    const record = h.state.get(id) as { params: { backlogCap: number; epochId: string } };
    record.params.backlogCap = 0.5;
    for (const text of ['held one', 'held two']) {
      h.stored.push({ participant: 'u', content: [{ type: 'text', text }], metadata: { channelId: 'noisy', serverId: 'disc', tuneOut: { epochId: record.params.epochId } } });
    }
    const second = h.make();
    assert.ok(second.cancelAllExcept('agent-tool', 'done').ok);
    const release = h.messages.find((m) => /released — done/.test(m.text))!;
    assert.match(release.text, /messages=2/);
    assert.doesNotMatch(release.text, /held one|held two/, 'a cap below one shows no message');
    second.stop();
  });
});
