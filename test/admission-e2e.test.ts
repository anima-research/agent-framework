/**
 * The admission stage (issue #232 §3.5, Dendrite §D): one decision per
 * inbound event per recipient, taken before any side effect. These are the
 * #232 gap probes as regression tests — each `it` names the gap it closes.
 *
 * Harness: the RFC-006 loopback MCPL server and a mocked model. The event
 * loop is driven explicitly (`runUntilIdle`), so every wake that is expected
 * has a scripted response and every wake that is not shows up as a hang-free
 * `membrane.calls` count. The persistent subconscious is the reader unless a
 * test says otherwise.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, eventually } from './helpers/coalescing-fixture.js';
import { GateModule } from './helpers/dendrite.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import {
  type Stored, SUB, internals, textOf, stored, held, has, find, inWindow, AMBIENT, MENTION,
  incoming, dm, registerOpen, enter, settle, channellessTurnLocus, blockInTool,
} from './helpers/admission.js';

describe('admission: the hold is decided once, before any side effect', () => {
  it('gap 1 — tuning out a DM holds the next DM (the push-event lane consults the hold)', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await dm(f, 'dm-0', 'first dm');
      await f.turn();
      assert.ok(has(f, 'first dm'));
      const callsBefore = f.membrane.calls.length;
      assert.ok(callsBefore >= 1, 'the first DM woke the resident');

      enter(f, 'discord:dm:777');
      await dm(f, 'dm-1', 'second dm');
      await settle(f);
      assert.ok(held(find(f, 'second dm')), 'the second DM carries the hold record');
      const compiled = await f.framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(!compiled.messages.some((m) => textOf(m as Stored).includes('second dm')), 'a held DM is not in the resident\'s view');
    } finally { await f.close(); }
  });

  it('gap 2 — held traffic never moves the speech locus; under the default rule no inbound traffic does', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      await incoming(f, 'work', 'w1', 'hello from work');
      await f.turn();
      assert.ok(has(f, 'hello from work'));
      // `speech.locus: 'delivery'` (default): a turn nothing delivered into
      // (a heartbeat here) has no locus — not the last channel that spoke.
      assert.equal(await channellessTurnLocus(f), null, 'no global latest-inbound locus');
      assert.ok(has(f, 'no channel'), 'the resident is told their prose stays private');

      enter(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      assert.ok(held(find(f, 'noise')));
      assert.notEqual(internals(f).channelRegistry.getDefaultPublishChannel(), 'noisy', 'held traffic is not "the latest inbound" either');
      assert.equal(await channellessTurnLocus(f), null);
    } finally { await f.close(); }
  });

  it('gap 2 (legacy rule) — `speech.locus: "latest-inbound"`: delivered traffic moves the locus, held traffic does not', async () => {
    const f = await fixture({ framework: { subconscious: SUB, speech: { locus: 'latest-inbound' } } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      await incoming(f, 'work', 'w1', 'hello from work');
      await f.turn();
      assert.equal(await channellessTurnLocus(f), 'work', 'legacy: the last delivered channel is the fallback locus');

      enter(f, 'noisy');
      await incoming(f, 'noisy', 'n1', 'noise');
      await settle(f);
      assert.equal(await channellessTurnLocus(f), 'work', 'held traffic did not move it');
    } finally { await f.close(); }
  });

  it('gap 3 — a debounce policy never queues a held mention; the reader still gets the gate\'s verdict', async () => {
    const f = await fixture({
      framework: {
        subconscious: SUB,
        gate: { config: { default: 'always', policies: [
          { name: 'noisy-debounce', match: { scope: ['mcpl:channel-incoming'], channel: 'noisy' }, behavior: { debounce: 60_000 } },
        ] } },
      } as Partial<FrameworkConfig>,
    });
    try {
      await registerOpen(f, 'noisy');
      const gate = internals(f).eventGate!;
      // Control: not held → the debounce batches the mention, nobody wakes yet.
      await incoming(f, 'noisy', 'c1', 'hey agent', MENTION);
      await settle(f);
      assert.ok(has(f, 'hey agent'));
      assert.equal(gate.debounceTimers.size, 1, 'control: the gate batched the mention');
      gate.debounceTimers.forEach((s) => clearTimeout((s as { timer: ReturnType<typeof setTimeout> }).timer));
      gate.debounceTimers.clear();

      enter(f, 'noisy');
      await incoming(f, 'noisy', 'h1', 'agent, you there?', MENTION);
      await settle(f);
      assert.ok(held(find(f, 'you there')));
      assert.equal(gate.debounceTimers.size, 0, 'a held mention is not batched for the resident');
      const coordinator = internals(f).tuneOutCoordinator as unknown as { pendingWakes: Map<string, unknown> };
      assert.equal(coordinator.pendingWakes.size, 1, 'the reader wake is scheduled: the gate\'s verdict (would wake) reached the coordinator');
    } finally { await f.close(); }
  });

  it('gap 4 — the release names non-text blocks instead of dropping them', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'i1', '', AMBIENT, [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
      await incoming(f, 'noisy', 'i2', '', AMBIENT, [
        { type: 'text', text: 'look at this' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ]);
      await settle(f);
      assert.equal(stored(f).filter(held).length, 2, 'two held messages');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      const release = textOf(find(f, '<tuned-out-backlog'));
      assert.match(release, /antra: \[image\]/, 'an image-only message names its image');
      assert.match(release, /antra: look at this \[image\]/, 'a captioned image keeps both');
    } finally { await f.close(); }
  });

  // A held message is stored at once, whatever the resident's turn (#291):
  // it was deferred behind the turn and stored at its tool boundary, and is
  // now in the store while the tool still waits, so its reader has it.
  it('gap 5 — a held message arriving mid-turn is stored at once, not injected into the live turn', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy');
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'held while acting');
      await eventually(() => has(f, 'held while acting'), 'held message stored while the tool waits');
      gate.release('g1');
      await loop;
      assert.ok(held(find(f, 'held while acting')), 'stored with the hold record');
      const injected = f.membrane.lastStream!.receivedToolResultOptions
        .flatMap((o) => o?.injectedMessages ?? [])
        .map((m) => JSON.stringify(m.content));
      assert.ok(!injected.some((s) => s.includes('held while acting')), 'the live turn never saw the held message');
      const compiled = await f.framework.getAgent('agent')!.getContextManager().compile();
      assert.ok(!compiled.messages.some((m) => textOf(m as Stored).includes('held while acting')), 'nor does the next compile');
    } finally { await f.close(); }
  });

  // A held message arriving mid-turn is stored at once now (#291), so the
  // release reads it from the record, as it does one stored while quiesced
  // (the twin below).
  it('gap 7 — a held message stored mid-turn, before the cancel, is in the release', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'deferred and held');
      await eventually(() => has(f, 'deferred and held'), 'held message stored mid-turn');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      // The cancel wakes the resident (after this turn) and the reader; the
      // mock answers every further request so neither wake is left streaming.
      f.alwaysRespond();
      gate.release('g1');
      await loop;
      const release = textOf(find(f, '<tuned-out-backlog'));
      assert.match(release, /messages=1/, 'the deferred message is counted');
      assert.match(release, /antra: deferred and held/, 'and listed');
    } finally { await f.close(); }
  });

  // Ported for #291: a write while quiesced is stored at once, where this
  // test once had the quiesce queue it and the release read the queue.
  it('gap 7 (quiesce) — a held message stored while quiesced is in a release made during it', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const epochId = internals(f).channelRegistry.getTuneOutState('editor', 'noisy')!.params.epochId;
      await f.framework.quiesce();
      // As admission stores a held message (a quiesce pauses the MCPL data
      // plane, so this one comes in past it), for the primary.
      (f.framework as unknown as { addMessage(p: string, c: unknown[], m: Record<string, unknown>): string })
        .addMessage('antra', [{ type: 'text', text: 'stored while quiesced' }], {
          tuneOut: { epochId }, channelId: 'noisy', serverId: 'editor', author: { id: 'U1', name: 'antra' },
        });
      assert.ok(has(f, 'stored while quiesced'), 'premise: stored at once');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      f.alwaysRespond();
      await f.framework.resume();
      await eventually(() => has(f, '<tuned-out-backlog'), 'the release lands at resume');
      const release = textOf(find(f, '<tuned-out-backlog'));
      assert.match(release, /messages=1/, 'the message is counted');
      assert.match(release, /antra: stored while quiesced/, 'and listed');
    } finally { await f.close(); }
  });

  // Ported for #291: a release made behind a live turn is stored at once, so
  // nothing waits in memory for a crash to lose, and no queue file is
  // written. This test once checked the release was persisted in the
  // deferral queue's recovery file and re-woke the resident at the boot
  // that found it; such a file an earlier release left is the importer's
  // now (deferred-import-boot.test.ts).
  it('gap 6 — a release made behind a live turn is stored at once, with no queue file, and enters the window once the turn ends', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    const recovery = join(f.dir, 'store', 'recovery', 'deferred-writes.json');
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'held before the crash');
      await eventually(() => has(f, 'held before the crash'), 'held message stored');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      assert.match(textOf(find(f, '<tuned-out-backlog')), /antra: held before the crash/, 'the release is stored while the tool waits');
      assert.equal(inWindow(f, '<tuned-out-backlog'), false, "out of the live turn's window");
      assert.equal(existsSync(recovery), false, 'no queue file is written');
      f.alwaysRespond();
      gate.release('g1');
      await loop;
      await eventually(() => inWindow(f, '<tuned-out-backlog'), 'the release enters the window once the turn ends');
    } finally { await f.close(); }
  });

  // The release is stored at once (#291), and made durable by the cancel, but
  // the wake it asks for is in memory: a process that ends while the
  // resident's turn is alive, the release still out of its window, owes the
  // resident that wake at the next boot (AF-6's wakeForUnpresentedTuneOutRows,
  // where an earlier release restored it from its persisted queue).
  it('gap 6 — a release stored behind a live turn that a crash cut off re-wakes the resident at the next boot, and its turn reads it', async () => {
    const gate = new GateModule();
    const f = await fixture({ framework: { subconscious: SUB, modules: [gate] } as Partial<FrameworkConfig> });
    const crashed = mkdtempSync(join(tmpdir(), 'admission-reboot-'));
    try {
      await registerOpen(f, 'work', 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      const { loop } = await blockInTool(f, gate);
      await incoming(f, 'noisy', 'n1', 'held before the crash');
      await eventually(() => has(f, 'held before the crash'), 'held message stored');
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      assert.equal(inWindow(f, '<tuned-out-backlog'), false, "out of the live turn's window");
      // The process ends here, the turn still alive: the store is what the
      // cancel's sync left.
      cpSync(join(f.dir, 'store'), join(crashed, 'store'), { recursive: true });
      f.alwaysRespond();
      gate.release('g1');
      await loop;
    } finally { await f.close(); }

    const g = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig>, dir: crashed });
    try {
      const pending = internals(g).pendingRequests;
      assert.deepEqual(pending.filter((r) => r.agentName === 'agent' && /tune-out released/.test(r.reason)).length, 1,
        'the release owes the resident its wake, once');
      assert.equal(inWindow(g, '<tuned-out-backlog'), true, 'the boot presents it at rest');
      await g.turn();
      assert.match(g.lastRequest(), /tuned-out-backlog[^]*antra: held before the crash/, "the wake's turn reads the release");
    } finally { await g.close(); }
  });

  it('a boot asks no wake for a release the resident was shown before the process ended', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    const ended = mkdtempSync(join(tmpdir(), 'admission-reboot-'));
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'n1', 'held while idle');
      await settle(f);
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      assert.equal(inWindow(f, '<tuned-out-backlog'), true, 'presented at rest: no turn of the resident was alive');
      cpSync(join(f.dir, 'store'), join(ended, 'store'), { recursive: true });
    } finally { await f.close(); }

    const g = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig>, dir: ended });
    try {
      assert.equal(internals(g).pendingRequests.some((r) => /tune-out released/.test(r.reason)), false,
        'its wake ran or was lost with the process, as before #291');
    } finally { await g.close(); }
  });

  it('gap 9 — channel_close on a tuned-out channel is refused: its cancel is what ends the hold, and the release follows', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'n1', 'held before close');
      await settle(f);
      assert.equal(stored(f).filter(held).length, 1);
      // main's rule: a tuned-out channel's decision is the tune-out; a close
      // recorded over it would end it without its cancel, so the backlog it
      // diverted would never reach the agent. The close is refused and says so.
      const result = await f.framework.executeToolCall({ id: 'c1', name: 'channel_close', input: { channelId: 'noisy' }, callerAgentName: 'agent' } as never);
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /is tuned out: its messages go to the subconscious, and channel_close doesn't change that/);
      assert.equal(internals(f).channelRegistry.getDesiredState('editor', 'noisy'), 'tuned-out', 'nothing changed');
      assert.equal(stored(f).filter(held).length, 1, 'the held message is still held');
      // The cancel ends it, with the release — and the channel can be closed after.
      assert.ok(internals(f).tuneOutCoordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      assert.equal(internals(f).channelRegistry.getTuneOutState('editor', 'noisy'), null, 'the epoch ended');
      assert.match(textOf(find(f, '<tuned-out-backlog')), /antra: held before close/, 'the release was delivered');
      const closed = await f.framework.executeToolCall({ id: 'c2', name: 'channel_close', input: { channelId: 'noisy' }, callerAgentName: 'agent' } as never);
      assert.ok(closed.success, closed.error);
      assert.equal(internals(f).channelRegistry.getDesiredState('editor', 'noisy'), 'closed');
    } finally { await f.close(); }
  });

  it('gap 10 / §3.3 — without a reader, tune-out is a silent hold that still releases', async () => {
    const f = await fixture({ framework: { tuneOut: { enabled: true } } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      const coordinator = internals(f).tuneOutCoordinator;
      assert.ok(coordinator, 'the coordinator exists without a subconscious');
      enter(f, 'noisy', { backlogCap: 10 });
      await incoming(f, 'noisy', 'n1', 'agent?', MENTION);
      await settle(f);
      assert.equal(stored(f).filter(held).length, 1, 'held');
      assert.ok(coordinator!.cancel('editor', 'noisy', 'agent-tool', 'test').ok);
      assert.match(textOf(find(f, '<tuned-out-backlog')), /antra: agent\?/, 'the release reaches the resident');
    } finally { await f.close(); }
  });

  it('gap 8 — the tune_out tool refuses an ambiguous channel id and takes serverId', async () => {
    const f = await fixture({ framework: { subconscious: SUB } as Partial<FrameworkConfig> });
    try {
      await registerOpen(f, 'noisy');
      const i = internals(f);
      // A second server with the same channel id.
      i.channelRegistry.channels.set('other:noisy', { serverId: 'other', descriptor: { id: 'noisy', type: 'discord', label: 'noisy' }, open: true });
      const ambiguous = await i.handleTuneOutTool('agent', { channelId: 'noisy' });
      assert.equal(ambiguous.success, false);
      assert.match(ambiguous.error ?? '', /ambiguous|is on more than one server/);
      const resolved = await i.handleTuneOutTool('agent', { channelId: 'noisy', serverId: 'editor' });
      assert.ok(resolved.success, resolved.error);
      assert.ok(i.channelRegistry.getTuneOutState('editor', 'noisy'));
    } finally { await f.close(); }
  });
});
