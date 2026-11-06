/**
 * The one-release importer (#291, AF-6): a store a release before #291 left
 * with writes still in its deferred queue boots, stores each of them once,
 * in the order they arrived (a gone agent's are passed on or dropped,
 * logged; one whose landing can't be checked, or whose store write throws,
 * is kept, with what follows it for that agent, for the next boot; one
 * context-manager refuses as malformed is dropped, logged, as the queue's
 * flush dropped it), and
 * rewrites the record with what it kept. A second boot imports only that.
 * Each case here writes the record by hand, as such a
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
import { ContextManager as StoreWindow, PassthroughStrategy } from '@animalabs/context-manager';
import { residentContextOptions } from '../src/context-options.js';
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
  // A first boot makes the store and every agent's window, which a release
  // before #291 never wrote (it kept no window index); a store such a
  // release left, with no index, is its own case below.
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

  // The stores above were made by this release, every window written down
  // already. A release before #291 kept no window index: its store's rows
  // are in the agent's slot and nothing more, beside the queue it left.
  for (const quiesced of [false, true]) {
    it(`a ${quiesced ? 'quiesced' : 'serving'} boot of a store an earlier release left with no window index writes the window down and stores its queue into it${quiesced ? ' at resume' : ''}`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'deferred-import-legacy-'));
      const storePath = join(dir, 'store');
      try {
        {
          const store = JsStore.openOrCreate({ path: storePath });
          const cm = await StoreWindow.open({ store, ...residentContextOptions('agent'), strategy: new PassthroughStrategy() });
          for (const t of ['old-1', 'old-2']) cm.addMessage('someone', text(t), {});
          assert.equal(cm.windowMode(), 'legacy', 'setup: the store predates the index');
          cm.close();
          store.close();
        }
        const recovery = join(storePath, 'recovery');
        mkdirSync(recovery, { recursive: true });
        writeFileSync(join(recovery, 'deferred-writes.json'), JSON.stringify({ version: 2, pending: [entry('q1', 1, 'queued-1')] }));
        if (quiesced) writeFileSync(join(recovery, 'host-mode.json'), JSON.stringify({ version: 1, quiesced: true, reason: 'surgery', since: Date.now() }));
        const framework = await AgentFramework.create({
          storePath, membrane: new MockMembrane().asMembrane(), modules: [], syncIntervalMs: 0,
          agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'You are agent.' }],
        } as Parameters<typeof AgentFramework.create>[0]);
        try {
          const cm = framework.getAgent('agent')!.getContextManager();
          assert.equal(cm.windowMode(), 'presented', 'written down at registration');
          const queued = withText(framework, 'queued-1');
          assert.deepEqual(queued.map(writeIdOf), ['q1'], 'stored once, under its queued id');
          assert.deepEqual(JSON.parse(readFileSync(join(recovery, 'deferred-writes.json'), 'utf8')), { version: 1, pending: [] }, 'the record is cleared');
          const olds = rowsOf(framework).filter((m) => /^old-\d$/.test(textOf(m)));
          assert.deepEqual(olds.map((m) => cm.windowStatusOf(m.id)), ['in', 'in'], "the earlier release's rows are in the window");
          assert.deepEqual(queued.map((m) => cm.windowStatusOf(m.id)), [quiesced ? 'out' : 'in'], quiesced ? 'the quiesce keeps the import out' : 'and the import, by the boot\'s pass');
          if (quiesced) {
            await framework.resume();
            assert.deepEqual(queued.map((m) => cm.windowStatusOf(m.id)), ['in'], 'resume presents it');
          }
          const { messages } = await cm.compile();
          assert.deepEqual(messages.map((m) => JSON.stringify(m.content)).filter((c) => /old-\d|queued-1/.test(c)).map((c) => /old-\d|queued-1/.exec(c)![0]),
            ['old-1', 'old-2', 'queued-1'], 'the compile carries the earlier rows, then the import');
        } finally { await framework.stop(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

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

  // The record as the releases before the importer wrote it: version 1,
  // each entry its id, participant and content, with no seq and no heldAt
  // (host-quiesce.test.ts's stranded-queue case booted on this shape; review2
  // J-AF18). Only the queued writes are stored, in the record's order.
  it('a serving boot stores a version-1 record of seq-less entries, exactly those writes, in its order', async () => {
    const h = await host();
    try {
      let framework = await h.boot();
      let before: number;
      try { before = rowsOf(framework).length; } finally { await framework.stop(); }
      mkdirSync(join(h.storePath, 'recovery'), { recursive: true });
      writeFileSync(join(h.storePath, 'recovery', 'deferred-writes.json'), JSON.stringify({
        version: 1,
        pending: [
          { id: 'stranded-1', participant: 'user', content: text('stranded') },
          { id: 'stranded-2', participant: 'user', content: text('stranded after it') },
        ],
      }));
      framework = await h.boot();
      try {
        assert.equal(framework.getHostModeStatus().quiesced, false);
        const imported = rowsOf(framework).slice(before);
        assert.deepEqual(imported.map(textOf), ['stranded', 'stranded after it'], 'exactly the queued writes, in order');
        assert.deepEqual(imported.map(writeIdOf), ['stranded-1', 'stranded-2']);
        const cm = framework.getAgent('agent')!.getContextManager();
        assert.deepEqual(imported.map((m) => cm.windowStatusOf(m.id)), ['in', 'in']);
        assert.deepEqual(h.readQueue(), { version: 1, pending: [] }, 'the record is cleared');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try { assert.deepEqual(rowsOf(framework).slice(before).map(textOf), ['stranded', 'stranded after it'], 'a second boot stores nothing'); } finally { await framework.stop(); }
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

  describe("a write whose landing is unknown, looked up while context-manager's query throws, as a blob missing from another message makes it throw", () => {
    type Window = { messages: unknown[] };
    type Cm = {
      queryMessages(...args: unknown[]): unknown;
      getMessageWindow(offset: number, limit: number, opts?: { resolveBlobs?: boolean }): Window;
    };
    /** `short`: the blob-free scan comes back a row short; `'unreadable'`: it
     *  finds the row, and the read of that row with its blobs throws. */
    async function bootWithLookupFailing(h: Host, short: boolean | 'unreadable'): Promise<AgentFramework> {
      const proto = AgentFramework.prototype as unknown as { landedCopiesById(agent: { getContextManager(): unknown }, id: string): unknown };
      const original = proto.landedCopiesById;
      proto.landedCopiesById = function (agent, id) {
        const cm = agent.getContextManager() as Cm;
        const query = cm.queryMessages;
        const read = cm.getMessageWindow;
        cm.queryMessages = () => { throw new Error('Blob not found: 0123'); };
        if (short === 'unreadable') {
          cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
            if (opts?.resolveBlobs === false) return read.call(this, offset, limit, opts);
            throw new Error('Blob not found: 4567');
          };
        } else if (short) {
          cm.getMessageWindow = function (this: unknown, offset, limit, opts) {
            const window = read.call(this, offset, limit, opts);
            return opts?.resolveBlobs === false ? { ...window, messages: window.messages.slice(1) } : window;
          };
        }
        try {
          return original.call(this, agent, id);
        } finally {
          cm.queryMessages = query;
          cm.getMessageWindow = read;
        }
      };
      try { return await h.boot(); } finally { proto.landedCopiesById = original; }
    }

    /** `ahead`: rows stored before the write, so the scan finds it past its
     *  first window; `image`: an image block in the write, whose blob the
     *  read of its stored copy resolves. */
    async function storedEarlier(h: Host, options: { ahead?: number; image?: boolean } = {}): Promise<number> {
      const framework = await h.boot();
      try {
        const cm = framework.getAgent('agent')!.getContextManager();
        for (let i = 0; i < (options.ahead ?? 0); i++) cm.addMessage('user', text(`ahead ${i}`));
        const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
        const image = { type: 'image', source: { type: 'base64', data: PNG, mediaType: 'image/png' } } as ContentBlock;
        cm.addMessage('user', [...text('found earlier'), ...(options.image ? [image] : [])], { deferredWriteId: 'u1' } as never);
        return cm.getMessageCount();
      } finally { await framework.stop(); }
    }

    it('is found by a blob-free scan of the branch, and not stored again', async () => {
      const h = await host();
      try {
        const count = await storedEarlier(h);
        h.writeQueue([
          entry('u1', 1, 'found earlier', { landing: 'unknown' }),
          entry('u2', 2, 'behind it'),
        ], { agent: count });
        const framework = await bootWithLookupFailing(h, false);
        try {
          assert.equal(withText(framework, 'found earlier').length, 1, 'not stored again');
          assert.equal(withText(framework, 'behind it').length, 1, 'what follows it is stored');
          assert.deepEqual(h.readQueue().pending, []);
        } finally { await framework.stop(); }
      } finally { h.close(); }
    });

    // The scan reads the store in windows of 500 rows (landedPositions).
    it('is found past the scan\'s first window, its stored copy read with its image, and not stored again', async () => {
      const h = await host();
      try {
        const count = await storedEarlier(h, { ahead: 600, image: true });
        assert.ok(count > 600, 'premise: the write is stored past the first window of the scan');
        h.writeQueue([
          entry('u1', 1, 'found earlier', { landing: 'unknown' }),
          entry('u2', 2, 'behind it'),
        ], { agent: count });
        const framework = await bootWithLookupFailing(h, false);
        try {
          assert.equal(withText(framework, 'found earlier').length, 1, 'found, and not stored again');
          assert.equal(withText(framework, 'behind it').length, 1, 'what follows it is stored');
          assert.deepEqual(h.readQueue().pending, [], 'nothing kept: its copy was read, image and all');
        } finally { await framework.stop(); }
      } finally { h.close(); }
    });

    it("whose blob-free scan comes back short, is kept with what follows it for the next boot, as a store that can't be searched, and not stored again", async () => {
      const h = await host();
      try {
        const count = await storedEarlier(h);
        h.writeQueue([
          entry('u1', 1, 'found earlier', { landing: 'unknown' }),
          entry('u2', 2, 'behind it'),
        ], { agent: count });
        const errors: string[] = [];
        const quiet = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        let framework: AgentFramework;
        try { framework = await bootWithLookupFailing(h, true); } finally { console.error = quiet; }
        try {
          assert.equal(withText(framework, 'found earlier').length, 1, 'not taken as absent and stored again');
          assert.equal(withText(framework, 'behind it').length, 0, 'held behind it');
          assert.deepEqual(h.readQueue().pending.map((m) => m.id), ['u1', 'u2'], 'left for the next boot, in order');
          assert.ok(errors.some((e) => e.includes("could not search agent's store for deferred write u1") && e.includes('Blob not found: 0123')), errors.join('\n'));
        } finally { await framework.stop(); }
        framework = await h.boot();
        try {
          assert.equal(withText(framework, 'found earlier').length, 1, 'once, when the next boot can search');
          assert.equal(withText(framework, 'behind it').length, 1);
          assert.deepEqual(h.readQueue().pending, []);
        } finally { await framework.stop(); }
      } finally { h.close(); }
    });

    it("whose blob-free scan finds it but whose stored copy can't be read, is kept with what follows it for the next boot, and not stored again", async () => {
      const h = await host();
      try {
        const count = await storedEarlier(h);
        h.writeQueue([
          entry('u1', 1, 'found earlier', { landing: 'unknown' }),
          entry('u2', 2, 'behind it'),
        ], { agent: count });
        const errors: string[] = [];
        const quiet = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        let framework: AgentFramework;
        try { framework = await bootWithLookupFailing(h, 'unreadable'); } finally { console.error = quiet; }
        try {
          assert.equal(withText(framework, 'found earlier').length, 1, 'not taken as absent and stored again');
          assert.equal(withText(framework, 'behind it').length, 0, 'held behind it');
          assert.deepEqual(h.readQueue().pending.map((m) => m.id), ['u1', 'u2'], 'left for the next boot, in order');
          assert.ok(errors.some((e) => e.includes("found deferred write u1 in agent's store, but could not read its stored copy")
            && e.includes('Blob not found: 4567')), errors.join('\n'));
        } finally { await framework.stop(); }
        framework = await h.boot();
        try {
          assert.equal(withText(framework, 'found earlier').length, 1, 'once, when the next boot can read it');
          assert.equal(withText(framework, 'behind it').length, 1);
          assert.deepEqual(h.readQueue().pending, []);
        } finally { await framework.stop(); }
      } finally { h.close(); }
    });
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

  // The import's own store write failing (not its lookup): the write and
  // what follows it for that agent stay queued, the other agents' go on.
  it("keeps a write whose store throws, and what follows it for that agent, for the next boot, logged, and stores the other agents'", async () => {
    const h = await host([{ name: 'mira' }, { name: 'oren' }]);
    const proto = StoreWindow.prototype as unknown as { addMessage(participant: string, content: ContentBlock[], ...rest: unknown[]): unknown };
    const original = proto.addMessage;
    const errors: string[] = [];
    const quiet = console.error;
    try {
      h.writeQueue([
        entry('k1', 1, 'unstorable', { forAgent: 'oren' }),
        entry('k2', 2, 'behind it', { forAgent: 'oren' }),
        entry('k3', 3, 'for mira', { forAgent: 'mira' }),
      ]);
      let refused = 0;
      proto.addMessage = function (this: unknown, participant, content, ...rest) {
        if (JSON.stringify(content).includes('unstorable')) { refused++; throw new Error('zz-store-write-failed'); }
        return original.call(this, participant, content, ...rest);
      };
      console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
      let framework: AgentFramework;
      try { framework = await h.boot(); } finally { proto.addMessage = original; console.error = quiet; }
      try {
        assert.equal(refused, 1, "premise: k1's store write threw");
        assert.equal(withText(framework, 'for mira', 'mira').length, 1, 'another agent goes on');
        assert.equal(withText(framework, 'unstorable', 'oren').length, 0);
        assert.equal(withText(framework, 'behind it', 'oren').length, 0, 'held behind the write it follows');
        assert.deepEqual(h.readQueue().pending.map((m) => m.id), ['k1', 'k2'], 'left for the next boot, in order');
        assert.ok(errors.some((e) => e.includes('a context write an earlier version queued could not be stored, so it and what follows it for oren stay queued for the next boot')
          && e.includes('zz-store-write-failed')), errors.join('\n'));
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.deepEqual(rowsOf(framework, 'oren').map(textOf).filter((t) => ['unstorable', 'behind it'].includes(t)), ['unstorable', 'behind it'], 'each once, in order');
        assert.equal(withText(framework, 'for mira', 'mira').length, 1, 'once');
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally {
      proto.addMessage = original;
      console.error = quiet;
      h.close();
    }
  });

  // AF #844 bot review 3, finding 89: the cut is per agent whatever the
  // write's kind, so a queued tool_use whose store throws keeps its
  // tool_result from being stored alone (main's deferred-window-only case).
  it("keeps a queued tool_result behind its tool_use whose store throws, and the next boot stores the pair once, in order", async () => {
    const h = await host([{ name: 'mira' }, { name: 'oren' }]);
    const proto = StoreWindow.prototype as unknown as { addMessage(participant: string, content: ContentBlock[], ...rest: unknown[]): unknown };
    const original = proto.addMessage;
    const quiet = console.error;
    const pairOf = (framework: AgentFramework) => rowsOf(framework, 'oren')
      .filter((m) => ['p1', 'p2'].includes(String(writeIdOf(m)))).map((m) => m.content[0]!.type);
    try {
      h.writeQueue([
        { id: 'p1', seq: 1, participant: 'oren', forAgent: 'oren', content: [{ type: 'tool_use', id: 'tu-9', name: 'files--read', input: {} }], heldAt: 1_700_000_000_000 },
        { id: 'p2', seq: 2, participant: 'user', forAgent: 'oren', content: [{ type: 'tool_result', toolUseId: 'tu-9', content: 'ok' }], heldAt: 1_700_000_000_000 },
      ]);
      let refused = 0;
      proto.addMessage = function (this: unknown, participant, content, ...rest) {
        if (content.some((b) => b.type === 'tool_use') && refused === 0) { refused++; throw new Error('zz-store-write-failed'); }
        return original.call(this, participant, content, ...rest);
      };
      console.error = () => {};
      let framework: AgentFramework;
      try { framework = await h.boot(); } finally { proto.addMessage = original; console.error = quiet; }
      try {
        assert.equal(refused, 1, "premise: the tool_use's store write threw");
        assert.deepEqual(pairOf(framework), [], 'its tool_result is not stored alone');
        assert.deepEqual(h.readQueue().pending.map((m) => m.id), ['p1', 'p2'], 'both left for the next boot, in order');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.deepEqual(pairOf(framework), ['tool_use', 'tool_result'], 'the pair once, in order');
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally {
      proto.addMessage = original;
      console.error = quiet;
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

  // A release with the audience stamp stamped a module's write for a run or
  // a fork as that agent's before queueing it. Passed to the primary at
  // import, the write is stamped for the primary: with the gone run's stamp
  // no window would take it, while the log says it was passed (review2
  // J-AF9). The unstamped twin, from a release before the stamp, goes the
  // same way.
  it("passes a gone run's stamped module write to the primary stamped for the primary, into its window", async () => {
    const h = await host();
    const errors: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    try {
      h.writeQueue([
        entry('pr1', 1, 'a module write for the run', {
          participant: 'module-x', forAgent: 'run-1', metadata: { primaryIfUnread: true, audience: ['run-1'] },
        }),
        entry('pr2', 2, 'an unstamped module write for the run', {
          participant: 'module-x', forAgent: 'run-1', metadata: { primaryIfUnread: true },
        }),
      ]);
      const framework = await h.boot();
      try {
        const cm = framework.getAgent('agent')!.getContextManager();
        const passed = rowsOf(framework).filter((m) => ['pr1', 'pr2'].includes(String(writeIdOf(m))));
        assert.deepEqual(passed.map(textOf), ['a module write for the run', 'an unstamped module write for the run']);
        assert.deepEqual(passed.map((m) => m.participant), ['module-x', 'module-x'], 'as the write itself');
        assert.deepEqual(passed.map((m) => audienceOf(m.metadata)?.audience), [['agent'], ['agent']], "the primary's alone");
        assert.deepEqual(passed.map((m) => (m.metadata as Record<string, unknown>).primaryIfUnread), [undefined, undefined], 'without the mark');
        assert.deepEqual(passed.map((m) => cm.windowStatusOf(m.id)), ['in', 'in'], "in the primary's window after the boot");
        assert.deepEqual(h.readQueue().pending, []);
        assert.ok(errors.some((e) => /2 notice\(s\) queued for an agent that has ended were passed to the primary/.test(e)), errors.join('\n'));
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
        // Released as the importer stored it, the mail has no redelivery to
        // wake its recipient: the boot's pass asks the wake its delivery did.
        const pending = (framework as unknown as { pendingRequests: Array<{ agentName: string; reason: string; source: string }> }).pendingRequests;
        assert.deepEqual(pending.map((r) => [r.agentName, r.reason, r.source]), [['agent', 'agent-message:helper', 'dendrite']]);
      } finally { await framework.stop(); }
    } finally { h.close(); }
  });

  // AF #844 bot review finding 28: the boot's check of held mail releases
  // it on a copy in the recipient's store only once the store has synced:
  // after an import whose sync failed, the copy may be in memory only.
  it("keeps imported mail held when the store doesn't sync before the boot would release it on the unsynced copy", async () => {
    const h = await host();
    const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
    const sync = proto.sync;
    const quiet = console.error;
    try {
      let framework = await h.boot();
      let mailId: string;
      try {
        const registry = (framework as unknown as { registry: { holdMail(mail: Record<string, unknown>): { id: string } } }).registry;
        mailId = registry.holdMail({ kind: 'message', from: { agent: 'helper', incarnation: 1 }, to: 'agent', content: text('unsynced mail') }).id;
      } finally { await framework.stop(); }
      h.writeQueue([entry('mail-2', 1, 'unsynced mail', {
        participant: 'helper', forAgent: 'agent',
        metadata: { kind: 'agent-message', dendrite: { mailId, kind: 'message', from: { agent: 'helper', incarnation: 1 }, to: 'agent' } },
      })]);
      // Every sync from the import on fails, through the boot's check of held mail.
      // AF #844 bot review 4, finding 45: the held-mail check's own sync is
      // counted, so a boot that skipped that check after the failed import
      // (and left the mail held for the later boot) fails here.
      let heldMailSyncsRefused = 0;
      proto.sync = function (this: JsStore) {
        const stack = new Error().stack ?? '';
        if (stack.includes('importPersistedDeferredWrites') || stack.includes('deliverHeldMail')) {
          if (stack.includes('deliverHeldMail')) heldMailSyncsRefused++;
          throw Object.assign(new Error('injected EIO syncing'), { code: 'EIO' });
        }
        return sync.call(this);
      };
      console.error = () => {};
      try { framework = await h.boot(); } finally { proto.sync = sync; console.error = quiet; }
      assert.ok(heldMailSyncsRefused > 0, "the boot's check of held mail reached its sync, which was refused");
      try {
        assert.equal(withText(framework, 'unsynced mail').length, 1, 'the import stored it, in memory');
        assert.deepEqual(framework.listHeldMail().map((m) => m.id), [mailId], 'the mail stays held: its copy never reached the disk');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.equal(withText(framework, 'unsynced mail').length, 1, 'the next boot finds the copy and delivers no second one');
        assert.deepEqual(framework.listHeldMail(), [], 'and releases it, synced');
      } finally { await framework.stop(); }
    } finally {
      proto.sync = sync;
      console.error = quiet;
      h.close();
    }
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
      assert.equal(left, 0, "the injected failure fired, at the importer's sync");
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

  // AF #844 bot review finding 25: an entry with no id is given one as it is
  // read, and the record names it by that id before any of it is stored, so
  // a boot that ends before the record is cleared, or whose sync fails,
  // leaves a record the next boot finds the copy by.
  it("names an id-less write by the id it is given before storing it, so a boot whose sync fails and the next store it once", async () => {
    const h = await host();
    const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
    const sync = proto.sync;
    const quiet = console.error;
    try {
      h.writeQueue([{ seq: 1, participant: 'user', content: text('no id given') }, entry('k1', 2, 'with an id')]);
      let failSyncs = true;
      proto.sync = function (this: JsStore) {
        if (failSyncs && new Error().stack?.includes('importPersistedDeferredWrites')) {
          failSyncs = false;
          throw Object.assign(new Error('injected EIO syncing'), { code: 'EIO' });
        }
        return sync.call(this);
      };
      console.error = () => {};
      let framework: AgentFramework;
      try { framework = await h.boot(); } finally { proto.sync = sync; console.error = quiet; }
      let given: unknown;
      try {
        const [row] = withText(framework, 'no id given');
        assert.ok(row, 'stored in memory');
        given = writeIdOf(row);
        assert.deepEqual(h.readQueue().pending.map((m) => m.id), [given, 'k1'], 'the record names it by the id it was stored under');
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.equal(withText(framework, 'no id given').length, 1, 'skipped by that id, not stored twice');
        assert.equal(withText(framework, 'with an id').length, 1);
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally {
      proto.sync = sync;
      console.error = quiet;
      h.close();
    }
  });

  it("keeps an id-less write for the next boot, with what follows it for its agent, when the record can't be written with its id first", async () => {
    const h = await host();
    const proto = AgentFramework.prototype as unknown as { writeRecoveryFile(this: unknown, path: string, document: unknown): void };
    const write = proto.writeRecoveryFile;
    const lines: string[] = [];
    const quiet = console.error;
    try {
      h.writeQueue([entry('k0', 1, 'before it'), { seq: 2, participant: 'user', content: text('no id given') }, entry('k2', 3, 'after it')]);
      let refuse = true;
      proto.writeRecoveryFile = function (this: unknown, path: string, document: unknown) {
        if (refuse && path.endsWith('deferred-writes.json')) {
          refuse = false;
          throw Object.assign(new Error('injected EIO writing'), { code: 'EIO' });
        }
        write.call(this, path, document);
      };
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      let framework: AgentFramework;
      try { framework = await h.boot(); } finally { proto.writeRecoveryFile = write; console.error = quiet; }
      try {
        assert.equal(withText(framework, 'before it').length, 1, 'a write ahead of it is stored');
        assert.deepEqual(withText(framework, 'no id given'), [], 'it is not stored under an id the record lacks');
        assert.deepEqual(withText(framework, 'after it'), [], 'nor what follows it for its agent');
        const left = h.readQueue().pending;
        assert.deepEqual(left.map((m) => (m.content as Array<{ text: string }>)[0]!.text), ['no id given', 'after it'], 'both stay queued');
        assert.match(String(left[0]!.id), /^[0-9a-f-]{36}$/, 'the one with no id under the id it was given');
        assert.ok(lines.some((l) => l.includes('no id given') || l.includes('stay queued')), lines.join('\n'));
      } finally { await framework.stop(); }
      framework = await h.boot();
      try {
        assert.deepEqual(rowsOf(framework).filter((m) => ['before it', 'no id given', 'after it'].includes(textOf(m))).map(textOf),
          ['before it', 'no id given', 'after it'], 'the next boot stores them once each, in order');
        assert.deepEqual(h.readQueue().pending, []);
      } finally { await framework.stop(); }
    } finally {
      proto.writeRecoveryFile = write;
      console.error = quiet;
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
  // The crash cases above run on stores this release made. One an earlier
  // release left has no window index: the crashed boot wrote it down and
  // stored the queue, and the next boot finds the rows and the record both.
  it('a process exit after the sync, before the record is cleared, on a store an earlier release left with no window index, stores the write once, after the earlier rows in the window', { timeout: 600_000 }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'deferred-import-legacy-crash-'));
    const storePath = join(dir, 'store');
    try {
      {
        const store = JsStore.openOrCreate({ path: storePath });
        const cm = await StoreWindow.open({ store, ...residentContextOptions('agent'), strategy: new PassthroughStrategy() });
        for (const t of ['old-1', 'old-2']) cm.addMessage('someone', text(t), {});
        assert.equal(cm.windowMode(), 'legacy', 'setup: the store predates the index');
        cm.close();
        store.close();
      }
      const recovery = join(storePath, 'recovery');
      mkdirSync(recovery, { recursive: true });
      writeFileSync(join(recovery, 'deferred-writes.json'), JSON.stringify({ version: 2, pending: [entry('q1', 1, 'queued-1')] }));
      const child = await runChild(storePath, 'before-rewrite', t.signal);
      assert.equal(child.status, 0, `the child exited where it was told (stderr: ${child.stderr.slice(-800)})`);
      const boot = () => AgentFramework.create({
        storePath, membrane: new MockMembrane().asMembrane(), modules: [], syncIntervalMs: 0,
        agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'You are agent.' }],
      } as Parameters<typeof AgentFramework.create>[0]);
      for (const pass of ['the next boot', 'another boot']) {
        const framework = await boot();
        try {
          const cm = framework.getAgent('agent')!.getContextManager();
          assert.equal(cm.windowMode(), 'presented', `${pass}: the window is written down`);
          assert.deepEqual(withText(framework, 'queued-1').map(writeIdOf), ['q1'], `${pass}: stored once, under its queued id`);
          assert.deepEqual(JSON.parse(readFileSync(join(recovery, 'deferred-writes.json'), 'utf8')), { version: 1, pending: [] }, `${pass}: the record is cleared`);
          assert.deepEqual(cm.getPresentedMessages().map(textOf).filter((x) => /^old-\d$|^queued-1$/.test(x)), ['old-1', 'old-2', 'queued-1'],
            `${pass}: the window holds the earlier rows, then the write`);
        } finally { await framework.stop(); }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  for (const crash of CRASHES) {
    // The suite's own timeout: the 2,101-write case passes in seconds alone,
    // and ran past 120 s on a loaded full-suite run (review2 J-AF38).
    it(`a process exit ${crash.label} loses no queued write and stores none twice`, { timeout: 600_000 }, async (t) => {
      const h = await host();
      try {
        h.quiesceRecord();
        h.writeQueue(Array.from({ length: crash.count }, (_, i) => entry(`x${i}`, i + 1, `CRASH-${i}`)));
        const child = await runChild(h.storePath, crash.mode, t.signal);
        assert.equal(child.status, 0, `the child exited where it was told (stderr: ${child.stderr.slice(-800)})`);
        const want = Array.from({ length: crash.count }, (_, i) => `CRASH-${i}`);
        const crashed = (f: AgentFramework) => rowsOf(f).map(textOf).filter((x) => x.startsWith('CRASH-'));
        if (crash.mode !== 'mid-import') {
          // AF #844 bot review 4, finding 44: the child exited past the
          // importer's sync (it exits 4 where the record's write comes with
          // no sync since the last imported write), so every row is on disk
          // before the next boot opens the store: read it there, past any
          // framework, so the next boot is shown to store none of them twice
          // rather than to store them once.
          const store = JsStore.openOrCreate({ path: h.storePath });
          try {
            const cm = await StoreWindow.open({ store, ...residentContextOptions('agent'), strategy: new PassthroughStrategy() });
            try {
              assert.deepEqual(cm.getAllMessages().map(textOf).filter((x) => x.startsWith('CRASH-')), want, 'every row is on disk before the next boot');
            } finally { cm.close(); }
          } finally { store.close(); }
        }
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
