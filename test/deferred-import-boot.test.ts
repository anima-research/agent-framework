/**
 * The one-release importer (#291, AF-6): a store a release before #291 left
 * with writes still in its deferred queue boots, stores each of them once,
 * in the order they arrived, and clears the queue's record. A second boot
 * imports nothing. Each case here writes the record by hand, as such a
 * release left it (recovery/deferred-writes.json, or the store's
 * framework/deferred-writes slot), since this release keeps no queue to
 * leave one. The reader's own rules are deferred-import.test.ts; the crash
 * cases run in a child process (helpers/deferred-import-crash-child.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import type { StoredMessage } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import { audienceOf } from '../src/dendrite/audience.js';
import type { AgentConfig } from '../src/types/index.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { fixture as mcplFixture, TS } from './helpers/coalescing-fixture.js';
import { coalescingSubjectKey } from '../src/mcpl/push-coalescer.js';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const textOf = (m: StoredMessage): string => (m.content[0] as { text?: string } | undefined)?.text ?? `[${m.content[0]?.type}]`;

interface Host {
  dir: string;
  storePath: string;
  boot(extra?: { agents?: Array<Partial<AgentConfig> & { name: string }> }): Promise<AgentFramework>;
  /** The queue a release before #291 left, as its recovery file holds it. */
  writeQueue(pending: unknown[], scanFrom?: Record<string, number>): void;
  readQueue(): { version: number; pending: Array<Record<string, unknown>> };
  quiesceRecord(): void;
  close(): void;
}

const AGENTS = [{ name: 'agent' }];

async function host(agents: Array<Partial<AgentConfig> & { name: string }> = AGENTS): Promise<Host> {
  const dir = mkdtempSync(join(tmpdir(), 'deferred-import-'));
  const storePath = join(dir, 'store');
  const recovery = join(storePath, 'recovery');
  const boot: Host['boot'] = async (extra) => {
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: (extra?.agents ?? agents).map((a) => ({ model: 'test-model', systemPrompt: `You are ${a.name}.`, ...a })) as AgentConfig[],
      modules: [],
      syncIntervalMs: 0,
    } as Parameters<typeof AgentFramework.create>[0]);
    return framework;
  };
  // A first boot makes the store and every agent's window, as the earlier
  // release's process did.
  await (await boot()).stop();
  return {
    dir,
    storePath,
    boot,
    writeQueue(pending, scanFrom) {
      mkdirSync(recovery, { recursive: true });
      writeFileSync(join(recovery, 'deferred-writes.json'), JSON.stringify({ version: 2, pending, ...(scanFrom ? { scanFrom } : {}) }));
    },
    readQueue() {
      return JSON.parse(readFileSync(join(recovery, 'deferred-writes.json'), 'utf8')) as ReturnType<Host['readQueue']>;
    },
    quiesceRecord() {
      mkdirSync(recovery, { recursive: true });
      writeFileSync(join(recovery, 'host-mode.json'), JSON.stringify({ version: 1, quiesced: true, reason: 'surgery', since: Date.now() }));
    },
    close() { rmSync(dir, { recursive: true, force: true }); },
  };
}

const rowsOf = (framework: AgentFramework, agent = 'agent'): StoredMessage[] =>
  framework.getAgent(agent)!.getContextManager().getAllMessages();
const withText = (framework: AgentFramework, needle: string, agent = 'agent'): StoredMessage[] =>
  rowsOf(framework, agent).filter((m) => JSON.stringify(m.content).includes(needle));
const writeIdOf = (m: StoredMessage): unknown => (m.metadata as { deferredWriteId?: unknown } | undefined)?.deferredWriteId;
const entry = (id: string, seq: number, t: string, more: Record<string, unknown> = {}) => ({ id, seq, participant: 'user', content: text(t), heldAt: 1_700_000_000_000, ...more });

describe('the deferred-write importer (#291, AF-6)', () => {
  it('a quiesced boot stores the queue an earlier release left, in the order it arrived, and the window takes it at resume', async () => {
    const h = await host();
    try {
      h.quiesceRecord();
      h.writeQueue([entry('w3', 3, 'third'), entry('w1', 1, 'first'), entry('w2', 2, 'second')]);
      let framework = await h.boot();
      try {
        assert.equal(framework.getHostModeStatus().quiesced, true);
        const stored = rowsOf(framework).filter((m) => ['first', 'second', 'third'].includes(textOf(m)));
        assert.deepEqual(stored.map(textOf), ['first', 'second', 'third'], 'stored at boot, in seq order');
        assert.deepEqual(stored.map(writeIdOf), ['w1', 'w2', 'w3'], 'each under its queued id');
        const cm = framework.getAgent('agent')!.getContextManager();
        assert.deepEqual(stored.map((m) => cm.windowStatusOf(m.id)), ['out', 'out', 'out'], 'the quiesce keeps them out of the window');
        assert.deepEqual(h.readQueue(), { version: 1, pending: [] }, 'the record is cleared');
        assert.equal(framework.getHostModeStatus().deferredWrites, 0);
        await framework.resume();
        assert.deepEqual(stored.map((m) => cm.windowStatusOf(m.id)), ['in', 'in', 'in']);
        const { messages } = await cm.compile();
        const sent = messages.map((m) => JSON.stringify(m.content)).filter((c) => /first|second|third/.test(c));
        assert.deepEqual(sent.map((c) => /first|second|third/.exec(c)![0]), ['first', 'second', 'third'], 'the compile carries them in the order they arrived');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.deepEqual(withText(framework, 'first').length, 1, 'a second boot imports nothing');
        assert.deepEqual(withText(framework, 'third').length, 1);
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  // host-quiesce.test.ts's case of a queue stranded beside a cleared
  // host-mode record, ported to this importer, was this case's twin; its
  // record and checks are here.
  it('a serving boot stores a mirrored queue once, in the window by the boot\'s pass, and a second boot stores nothing', async () => {
    const h = await host();
    try {
      h.writeQueue([entry('m1', 1, 'mirrored')]);
      // The state an older build could leave behind: the host-mode record
      // cleared, the queue not.
      writeFileSync(join(h.storePath, 'recovery', 'host-mode.json'), JSON.stringify({ version: 1, quiesced: false }));
      let framework = await h.boot();
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); }, { replay: true });
      try {
        assert.equal(framework.getHostModeStatus().quiesced, false, 'a serving boot');
        assert.equal(framework.getHostModeStatus().deferredWrites, 0, 'nothing is held');
        assert.deepEqual(h.readQueue().pending, [], 'the record is cleared');
        const [row] = withText(framework, 'mirrored');
        assert.ok(row);
        assert.equal(framework.getAgent('agent')!.getContextManager().windowStatusOf(row.id), 'in', 'presented at rest by the boot pass');
        assert.ok(traces.some((e) => e.type === 'message:added' && (e as { source?: string }).source === 'deferred-import' && (e as { messageId?: string }).messageId === row.id));
        assert.deepEqual(audienceOf(row.metadata)?.audience, ['agent'], 'an unstamped write is stamped as addMessage stamps one');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try { assert.equal(withText(framework, 'mirrored').length, 1); } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it('skips a write that landed before its ack, by its id', async () => {
    const h = await host();
    try {
      // What an interrupted flush left: the write stored, its ack not written.
      let framework = await h.boot();
      try {
        framework.getAgent('agent')!.getContextManager().addMessage('user', text('landed already'), { deferredWriteId: 'l1' } as never);
      } finally { await framework.stop(); }
      h.writeQueue([entry('l1', 1, 'landed already'), entry('l2', 2, 'not yet')]);
      framework = await h.boot();
      try {
        assert.equal(withText(framework, 'landed already').length, 1, 'not stored twice');
        assert.equal(withText(framework, 'not yet').length, 1);
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it("looks a write whose landing is unknown up across the whole branch: found, it isn't stored again; absent, it's stored once", async () => {
    const h = await host();
    try {
      let framework = await h.boot();
      let count: number;
      try {
        const cm = framework.getAgent('agent')!.getContextManager();
        cm.addMessage('user', text('found earlier'), { deferredWriteId: 'u1' } as never);
        // The record's scan starts after it, as a later hand-off's position did.
        count = cm.getMessageCount();
      } finally { await framework.stop(); }
      h.writeQueue([
        entry('u1', 1, 'found earlier', { landing: 'unknown' }),
        entry('u2', 2, 'never landed', { landing: 'unknown' }),
      ], { agent: count });
      framework = await h.boot();
      try {
        assert.equal(withText(framework, 'found earlier').length, 1);
        assert.equal(withText(framework, 'never landed').length, 1);
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it("keeps a write whose store can't be searched, and what follows it for that agent, for the next boot, and stores the other agents'", async () => {
    const h = await host([{ name: 'mira' }, { name: 'oren' }]);
    const proto = AgentFramework.prototype as unknown as { landedCopiesById(agent: { name: string }, id: string): unknown };
    const original = proto.landedCopiesById;
    try {
      h.writeQueue([
        entry('k1', 1, 'unsearchable', { landing: 'unknown', forAgent: 'oren' }),
        entry('k2', 2, 'behind it', { forAgent: 'oren' }),
        entry('k3', 3, 'for mira', { forAgent: 'mira' }),
      ]);
      proto.landedCopiesById = function (agent, id) {
        return id === 'k1' ? undefined : original.call(this, agent, id);
      };
      let framework: AgentFramework;
      try { framework = await h.boot(); } finally { proto.landedCopiesById = original; }
      try {
        assert.equal(withText(framework, 'for mira', 'mira').length, 1, 'another agent goes on');
        assert.equal(withText(framework, 'unsearchable', 'oren').length, 0);
        assert.equal(withText(framework, 'behind it', 'oren').length, 0, 'held behind the write it follows');
        assert.deepEqual(h.readQueue().pending.map((m) => m.id), ['k1', 'k2'], 'left for the next boot, in order');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.deepEqual(rowsOf(framework, 'oren').map(textOf).filter((t) => ['unsearchable', 'behind it'].includes(t)), ['unsearchable', 'behind it']);
        assert.equal(withText(framework, 'for mira', 'mira').length, 1, 'once');
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally {
      proto.landedCopiesById = original;
      h.close();
    }
  });

  it("passes a gone agent's failed reply to the primary as its notice, under the write's id, and drops its other writes, logged", async () => {
    const h = await host();
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      h.writeQueue([
        entry('g1', 1, '[discord-send-failed] Your previous reply (12 chars) could not be delivered.', {
          forAgent: 'conversation-gone', metadata: { system: true, kind: 'discord-send-failed', channelId: 'room', reason: 'no registered channel', textLen: 12 },
        }),
        entry('g2', 2, 'an ordinary write', { forAgent: 'conversation-gone' }),
      ]);
      const framework = await h.boot();
      try {
        const told = withText(framework, 'has ended');
        assert.equal(told.length, 1);
        assert.match(textOf(told[0]!), /A reply by conversation-gone \(12 chars\) could not be delivered to room \(no registered channel\)\. Nothing was posted\. conversation-gone has ended\./);
        assert.equal(writeIdOf(told[0]!), 'g1');
        assert.deepEqual(audienceOf(told[0]!.metadata)?.audience, ['agent'], "the primary's alone");
        assert.equal(withText(framework, 'an ordinary write').length, 0);
        assert.ok(errors.some((e) => /queued for conversation-gone, which is no longer registered, was dropped: g2/.test(e)), errors.join('\n'));
      } finally { await framework.stop(); }
    } finally {
      console.error = error;
      h.close();
    }
  });

  it('releases the mail an imported write carries as it is stored, so the boot delivers it no second time', async () => {
    const h = await host();
    try {
      let framework = await h.boot();
      let mailId: string;
      try {
        // Mail an earlier release held while its write waited in the queue.
        const registry = (framework as unknown as { registry: { holdMail(mail: Record<string, unknown>): { id: string } } }).registry;
        mailId = registry.holdMail({ kind: 'message', from: { agent: 'helper', incarnation: 1 }, to: 'agent', content: text('queued mail') }).id;
      } finally { await framework.stop(); }
      h.writeQueue([entry('mail-1', 1, 'queued mail', {
        participant: 'helper', forAgent: 'agent',
        metadata: { kind: 'agent-message', dendrite: { mailId, kind: 'message', from: { agent: 'helper', incarnation: 1 }, to: 'agent' } },
      })]);
      framework = await h.boot();
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); }, { replay: true });
      try {
        assert.deepEqual(framework.listHeldMail(), [], 'released');
        assert.deepEqual(
          traces.filter((e) => e.type === 'dendrite:mail-delivered').map((e) => [(e as { mailId?: string }).mailId, (e as { to?: string }).to]),
          [[mailId, 'agent']],
          'as the importer stored it',
        );
        assert.equal(withText(framework, 'queued mail').length, 1, 'stored once: the boot delivered no second copy');
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it("owes a tune-out release's agent the wake its cancel requested", async () => {
    const h = await host();
    try {
      h.writeQueue([entry('t1', 1, '[Tune-out: #room cancelled]', { metadata: { system: true, kind: 'tune-out-cancel', channelId: 'room' } })]);
      const framework = await h.boot();
      try {
        const pending = (framework as unknown as { pendingRequests: Array<{ agentName: string; reason: string; source: string }> }).pendingRequests;
        assert.ok(pending.some((r) => r.agentName === 'agent' && r.reason === 'tune-out released (restored)' && r.source === 'tune-out'), JSON.stringify(pending));
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it("stamps a tool-block pair an earlier release queued as its agent's own round, which the window takes even while quiesced", async () => {
    const h = await host();
    try {
      h.quiesceRecord();
      h.writeQueue([
        { id: 'p1', seq: 1, participant: 'agent', forAgent: 'agent', content: [{ type: 'tool_use', id: 'tu-1', name: 'files--read', input: {} }] },
        { id: 'p2', seq: 2, participant: 'user', forAgent: 'agent', content: [{ type: 'tool_result', toolUseId: 'tu-1', content: 'ok' }] },
        entry('p3', 3, 'someone else'),
      ]);
      const framework = await h.boot();
      try {
        const cm = framework.getAgent('agent')!.getContextManager();
        const pair = rowsOf(framework).filter((m) => ['p1', 'p2'].includes(String(writeIdOf(m))));
        assert.equal(pair.length, 2);
        for (const row of pair) {
          assert.equal(audienceOf(row.metadata)?.ownRowOf, 'agent');
          assert.equal(cm.windowStatusOf(row.id), 'in', 'own rows are presented whatever the quiesce');
        }
        const [other] = withText(framework, 'someone else');
        assert.equal(cm.windowStatusOf(other!.id), 'out', "another writer's row waits for resume");
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it('writes no clock row at a quiesced boot before what it imports', async () => {
    const agents = [{ name: 'agent', clock: { intervalMinutes: 10 } } as Partial<AgentConfig> & { name: string }];
    const h = await host(agents);
    try {
      h.quiesceRecord();
      h.writeQueue([entry('c1', 1, 'during surgery')]);
      const framework = await h.boot({ agents });
      try {
        const rows = rowsOf(framework);
        const at = rows.findIndex((m) => textOf(m) === 'during surgery');
        assert.ok(at >= 0);
        const before = rows[at - 1];
        assert.notEqual((before?.metadata as { kind?: unknown } | undefined)?.kind, 'clock', 'no clock row right before it');
        assert.equal(rows.slice(-3).filter((m) => (m.metadata as { kind?: unknown } | undefined)?.kind === 'clock').length, 0);
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  it("keeps the record when the store doesn't sync after the import, and the next boot skips what landed", async () => {
    const h = await host();
    const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
    const sync = proto.sync;
    try {
      h.writeQueue([entry('s1', 1, 'synced later')]);
      let left = 1;
      proto.sync = function (this: JsStore) {
        if (left > 0 && new Error().stack?.includes('importPersistedDeferredWrites')) {
          left--;
          throw Object.assign(new Error('injected EIO syncing'), { code: 'EIO' });
        }
        return sync.call(this);
      };
      let framework: AgentFramework;
      try { framework = await h.boot(); } finally { proto.sync = sync; }
      try {
        assert.equal(withText(framework, 'synced later').length, 1, 'stored in memory');
        assert.deepEqual(h.readQueue().pending.map((m) => m.id), ['s1'], 'the record is as it was');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.equal(withText(framework, 'synced later').length, 1, 'skipped by its id, not stored twice');
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally {
      proto.sync = sync;
      h.close();
    }
  });

  it("imports the queue from the store's slot, where a store with no recovery file kept it, and clears it there", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'deferred-import-slot-'));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const boot = () => AgentFramework.create({
      store, membrane: new MockMembrane().asMembrane(), modules: [], syncIntervalMs: 0,
      agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    } as Parameters<typeof AgentFramework.create>[0]);
    try {
      await (await boot()).stop();
      store.setStateJson('framework/deferred-writes', [{ participant: 'user', content: text('from the slot') }]);
      let framework = await boot();
      try {
        assert.equal(withText(framework, 'from the slot').length, 1);
        assert.deepEqual(store.getStateJson('framework/deferred-writes'), []);
      } finally { await framework.stop(); }
      framework = await boot();
      try { assert.equal(withText(framework, 'from the slot').length, 1); } finally { await framework.stop(); }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A coalesced render whose completion snapshot a crash lost, its batch
  // restored as rendering, while its delivery waited in an earlier release's
  // queue: the importer stores the delivery before MCPL starts, so the
  // coalescer's restore finds it published (wasPublished) and doesn't deliver
  // its fallback a second time. The control, with nothing queued, keeps the
  // batch for its fallback.
  for (const queued of [true, false]) {
    it(`a render the queue held is published by the time the coalescer restores${queued ? '' : ' (a control: nothing queued)'}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'deferred-import-mcpl-'));
      const scope = { kind: 'featureSet' as const, id: 'doc' };
      const subject = coalescingSubjectKey('editor', 'editor', scope, 'document');
      const latest = {
        serverId: 'editor', binding: 'editor', featureSet: 'doc', scope, key: 'document', eventId: 'ev-1', timestamp: TS,
        retract: false, deferred: true, initial: false, content: [{ type: 'text', text: 'document_diff' }],
        event: { lane: 'push', event: { triggerInference: false } },
      };
      // The store an earlier release left: the snapshot with the batch
      // rendering, and (with `queued`) the render's delivery in the queue.
      const first = await AgentFramework.create({
        storePath: join(dir, 'store'), membrane: new MockMembrane().asMembrane(), modules: [], syncIntervalMs: 0,
        agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }],
      } as Parameters<typeof AgentFramework.create>[0]);
      first.getStore().setStateJson('mcpl/coalescing', {
        version: 1, receipts: [],
        subjects: [{ subject, history: 'none', batch: { latest, notices: [], dropped: 0, rendering: true } }],
      });
      await first.stop();
      if (queued) {
        mkdirSync(join(dir, 'store', 'recovery'), { recursive: true });
        writeFileSync(join(dir, 'store', 'recovery', 'deferred-writes.json'), JSON.stringify({ version: 2, pending: [
          entry('r1', 1, 'the rendered diff', { metadata: { coalescingSubject: subject, eventId: 'ev-1' } }),
        ] }));
      }
      const f = await mcplFixture({ dir });
      try {
        const coalescer = (f.framework as unknown as { pushCoalescer: { pendingBatchOccurrences(): Array<{ eventId: string }> } }).pushCoalescer;
        assert.deepEqual(coalescer.pendingBatchOccurrences().map((o) => o.eventId), queued ? [] : ['ev-1'],
          queued ? 'published: the imported delivery settles the batch' : 'the batch waits for its fallback');
        assert.equal(withText(f.framework, 'the rendered diff').length, queued ? 1 : 0);
      } finally { await f.close(); }
    });
  }

  // Crash cases: a child process boots on a store with a queue and exits
  // hard mid-import (helpers/deferred-import-crash-child.ts).
  const CRASH_CHILD = fileURLToPath(new URL('./helpers/deferred-import-crash-child.js', import.meta.url));
  const runChild = (storePath: string, mode: string, signal: AbortSignal): Promise<{ status: number | null; stderr: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CRASH_CHILD, storePath, mode], { signal, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stderr }));
    });
  const CRASHES = [
    { mode: 'mid-import', label: 'after two of four writes are stored, before the sync', count: 4 },
    { mode: 'before-rewrite', label: 'after the sync, before the record is cleared', count: 4 },
    { mode: 'big-before-rewrite', label: 'after a 2,101-write import synced, before the record is cleared', count: 2_101 },
  ] as const;
  for (const crash of CRASHES) {
    it(`a process exit ${crash.label} loses no queued write and stores none twice`, { timeout: 120_000 }, async (t) => {
      const h = await host();
      try {
        h.quiesceRecord();
        h.writeQueue(Array.from({ length: crash.count }, (_, i) => entry(`x${i}`, i + 1, `CRASH-${i}`)));
        const child = await runChild(h.storePath, crash.mode, t.signal);
        assert.equal(child.status, 0, `the child exited where it was told (stderr: ${child.stderr.slice(-800)})`);
        const want = Array.from({ length: crash.count }, (_, i) => `CRASH-${i}`);
        const crashed = (f: AgentFramework) => rowsOf(f).map(textOf).filter((x) => x.startsWith('CRASH-'));
        let framework = await h.boot();
        try {
          assert.equal(framework.getHostModeStatus().quiesced, true);
          assert.deepEqual(crashed(framework), want, 'each once, in order');
          assert.deepEqual(h.readQueue().pending, []);
        } finally { await framework.stop(); }
        framework = await h.boot();
        try { assert.deepEqual(crashed(framework), want, 'still each once after another boot'); } finally { await framework.stop(); }
      } finally { h.close(); }
    });
  }
});
