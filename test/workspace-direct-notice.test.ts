/**
 * The head-move notice on a writable direct mount: after the store's head
 * moves away from an agent's latest direct write, through undoLastTurn or a
 * context-manager branch switch as connectome-host's /undo makes one, the
 * framework stores, at the agent's next start, one notice that those writes
 * are still on disk, and that start's request carries it. Whether it was
 * given is judged by the notice's own presence in the history.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import { AgentFramework } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { directWriteTestSeam } from '../src/modules/workspace/direct-write.js';
import type { MountConfig } from '../src/modules/workspace/types.js';
import type { Module, ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolCall, ToolDefinition, ToolResult } from '../src/types/events.js';
import type { TraceEvent } from '../src/types/trace.js';
import { MockMembrane, MockYieldingStream, createMockResponse } from './helpers/mock-membrane.js';

const NOTICE = 'from turns the history no longer holds are still on disk';
const TEXT = "[workspace] Writes to `ref` from turns the history no longer holds are still on disk. If it's a git checkout, "
  + '`git status` and `git diff` show them; a `git checkout` of a file drops every unstaged change in it, including the ones the history still holds.';

/** A turn's script: its responses, one per round, and the tool round after which its stream fails, so the framework's retry starts again. */
type Script = { responses: NormalizedResponse[]; failAfterRound?: number };

/** A stream that fails once its tools have answered `failAfterRound` rounds. */
class FailingStream extends MockYieldingStream {
  constructor(responses: NormalizedResponse[], private readonly failAfterRound?: number) {
    super(responses);
  }

  override provideToolResults(results: unknown[], options?: Parameters<MockYieldingStream['provideToolResults']>[1]): void {
    super.provideToolResults(results, options);
    if (this.toolDepth === this.failAfterRound) {
      (this as unknown as { events: unknown[] }).events.push({ type: 'error', error: new Error('socket hang up') });
    }
  }
}

/** Each agent's turns in order, by its system prompt (`zz-agent-<name>`), wherever the request carries it. */
class ScriptedMembrane extends MockMembrane {
  readonly scripts = new Map<string, Script[]>();

  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const agent = /zz-agent-(\w+)/.exec(JSON.stringify(request))?.[1] ?? '';
    const script = this.scripts.get(agent)?.shift() ?? { responses: [createMockResponse([{ type: 'text', text: 'ok' }])] };
    const stream = new FailingStream(script.responses, script.failAfterRound);
    this.lastStream = stream;
    return stream as unknown as YieldingStream;
  }
}

/** A tool that moves the store's head the way the test says, called from inside a turn. */
class Mover implements Module {
  readonly name = 'mover';
  move: () => Promise<void> = async () => {};
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'move', description: 'move the head', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> {
    await this.move();
    return { success: true, data: { moved: true } };
  }
  async onProcess(_event: ProcessEvent) {
    return {};
  }
}

const say = (text: string) => createMockResponse([{ type: 'text', text }]);
let toolIds = 0;
const use = (name: string, input: Record<string, unknown>) => createMockResponse([{ type: 'tool_use', id: `t${++toolIds}`, name, input }], 'tool_use');
const write = (path: string, content: string) => use('workspace--write', { path: `ref/${path}`, content });

type Cm = {
  addMessage: (...args: unknown[]) => string;
  getAllMessages(): Array<{ id: string; metadata?: Record<string, unknown> }>;
  branchAt(id: string, name: string): string;
  switchBranch(name: string): Promise<void>;
};

class Harness {
  readonly dir = mkdtempSync(join(tmpdir(), 'af-ws-direct-notice-'));
  readonly work = join(this.dir, 'work');
  readonly membrane = new ScriptedMembrane();
  readonly mover = new Mover();
  framework!: AgentFramework;
  workspace!: WorkspaceModule;
  traces: TraceEvent[] = [];
  private users = 0;

  constructor(readonly agents: string[] = ['scout'], readonly options: { presentationIndex?: boolean } = {}) {
    mkdirSync(this.work, { recursive: true });
  }

  async open(): Promise<void> {
    this.workspace = new WorkspaceModule({ mounts: [{ name: 'ref', path: this.work, backend: 'direct' } as MountConfig] });
    this.framework = await AgentFramework.create({
      storePath: join(this.dir, 'store'),
      membrane: this.membrane.asMembrane(),
      agents: this.agents.map((name) => ({ name, model: 'test-model', systemPrompt: `zz-agent-${name}` })),
      modules: [this.workspace, this.mover],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      errorPolicy: { maxRetries: 1, onInferenceError: (_error: Error, _agent: string, attempt: number) => (attempt < 1 ? { retry: true, delayMs: 0 } : { retry: false }) },
      ...(this.options.presentationIndex ? { presentationIndex: true } : {}),
    });
    // As a host gives the workspace its store (connectome-host's index.ts).
    this.workspace.initStore(this.framework.getStore());
    this.traces = [];
    this.framework.onTrace((event) => this.traces.push(event));
    this.framework.start();
  }

  async close(): Promise<void> {
    await this.framework.stop();
  }

  cm(agent = 'scout'): Cm {
    return this.framework.getAgent(agent)!.getContextManager() as unknown as Cm;
  }

  /**
   * One turn of `agent`'s, with its scripts, and the requests it made;
   * started by a user message unless `user` is false, for the request's
   * `reason` (a resuming one, such as 'context_budget_restart', continues
   * the agent's logical turn).
   */
  async turn(scripts: Script[] | NormalizedResponse[], agent = 'scout', { user = true, reason = 'zz' }: { user?: boolean; reason?: string } = {}): Promise<NormalizedRequest[]> {
    const list = (scripts as Array<Script | NormalizedResponse>).every((s) => 'responses' in s) ? scripts as Script[] : [{ responses: scripts as NormalizedResponse[] }];
    this.membrane.scripts.set(agent, [...(this.membrane.scripts.get(agent) ?? []), ...list]);
    const done = () => this.traces.filter((e) => e.type === 'inference:completed' && (e as { agentName?: string }).agentName === agent).length;
    const before = done();
    const calls = this.membrane.calls.length;
    if (user) this.cm(agent).addMessage('user', [{ type: 'text', text: `zz-user-${++this.users}` }], { channelId: 'zz' });
    (this.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({ agentName: agent, reason, source: 'test', timestamp: Date.now() });
    const end = Date.now() + 10_000;
    // Its inference done, and the agent idle again, its turn torn down.
    const idle = () => this.framework.getAgent(agent)!.state.status === 'idle';
    while (done() <= before || !idle()) {
      if (Date.now() > end) throw new Error(`timed out on ${agent}'s turn; traces: ${this.traces.slice(-20).map((e) => e.type).join(', ')}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.membrane.calls.slice(calls);
  }

  /** The notices in the agent's history on the branch it's on now. */
  notices(agent = 'scout'): string[] {
    return this.cm(agent).getAllMessages().filter((m) => m.metadata?.kind === 'workspace-head-move').map((m) => m.id);
  }

  /** The id of the agent's newest message now. */
  newest(agent = 'scout'): string {
    return this.cm(agent).getAllMessages().at(-1)!.id;
  }

  /** A context-manager branch at `id`, switched to, as connectome-host's /undo makes one. */
  async branchBack(id: string, agent = 'scout'): Promise<void> {
    const name = this.cm(agent).branchAt(id, `zz-back-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await this.cm(agent).switchBranch(name);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const carries = (request: NormalizedRequest | undefined) => JSON.stringify(request?.messages ?? []).includes(NOTICE);

async function harness(t: { after: (fn: () => Promise<void>) => void }, agents?: string[], options?: { presentationIndex?: boolean }): Promise<Harness> {
  const h = new Harness(agents, options);
  await h.open();
  t.after(async () => {
    await h.framework.stop().catch(() => {});
    h.cleanup();
  });
  return h;
}

test("an undo of the turn that wrote a direct mount gives the notice once, at the next start, and that start's request carries it", async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  assert.equal(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(h.framework.undoLastTurn('scout').undone, true);

  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 1);
  const stored = h.cm().getAllMessages().find((m) => m.metadata?.kind === 'workspace-head-move')!;
  // A notice about the agent's own writes is its own row (#291's audience stamp).
  assert.deepEqual(stored.metadata, { system: true, kind: 'workspace-head-move', mounts: ['ref'], audience: ['scout'], ownRowOf: 'scout' });
  assert.match(JSON.stringify(first!.messages), new RegExp(TEXT.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&').slice(0, 60)));
  // Later starts carry the one notice in its place, and store no other.
  const [later] = await h.turn([say('still here')]);
  assert.equal(carries(later), true);
  assert.equal(h.notices().length, 1);
  assert.equal(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'one\n', 'disk keeps the write');
});

// With the presentation index (#291) an undo moves no branch: it takes the
// turn out of the agent's window, and the workspace asks the window
// (useWindow) whether the turn that wrote is still in it.
test("on the window, an undo of the turn that wrote a direct mount moves no branch and gives the notice once, at the next start, and that start's request carries it", async (t) => {
  const h = await harness(t, undefined, { presentationIndex: true });
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  const undone = h.framework.undoLastTurn('scout');
  assert.equal(undone.undone, true);
  assert.equal(undone.fromBranch, undone.toBranch, 'no branch moved');
  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 1);
  const [later] = await h.turn([say('still here')]);
  assert.equal(carries(later), true, 'later starts carry the one notice in its place');
  assert.equal(h.notices().length, 1, 'and store no other');
  assert.equal(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'one\n', 'disk keeps the write');
});

test('on the window, a redo of the turn that wrote finds nothing due, and a head that never moved stores no notice', async (t) => {
  const h = await harness(t, undefined, { presentationIndex: true });
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.turn([say('again')]);
  assert.equal(h.notices().length, 0, "the window holds the turn that wrote");
  assert.equal(h.framework.undoLastTurn('scout').undone, true, "the later turn's undo");
  assert.equal(h.framework.undoLastTurn('scout').undone, true, "the writing turn's undo");
  assert.equal(h.framework.redo('scout').redone, true);
  const [request] = await h.turn([say('back')]);
  assert.equal(carries(request), false);
  assert.equal(h.notices().length, 0);
});

test('an undo whose fork lands at exactly the store head the write saw gives the notice', async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const written = await h.framework.executeToolCall({ id: 'direct-1', name: 'workspace--write', input: { path: 'ref/a.txt', content: 'one\n' }, callerAgentName: 'scout' } as Parameters<AgentFramework['executeToolCall']>[0]);
  assert.equal(written.success, true, written.error);
  const head = (h.workspace as unknown as { directHeads: Map<string, Map<string, { after: number }>> }).directHeads.get('ref')!.get('scout')!;
  // A turn with nothing recorded between the write and its start.
  await h.turn([say('nothing new')], 'scout', { user: false });
  const checkpoint = (h.framework as unknown as { getTurnCheckpoints(agent: string): Array<{ sequenceBefore: number }> }).getTurnCheckpoints('scout').at(-1)!;
  assert.equal(checkpoint.sequenceBefore, head.after, 'the undo forks at exactly the head the write saw');
  assert.equal(h.framework.undoLastTurn('scout').undone, true);
  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
});

for (const [tool, input, landed] of [
  ['edit', { path: 'ref/a.txt', oldString: 'zero', newString: 'one' }, (h: Harness) => readFileSync(join(h.work, 'a.txt'), 'utf8') === 'one\n'],
  ['edit_many', { edits: [{ path: 'ref/a.txt', oldString: 'zero', newString: 'one' }] }, (h: Harness) => readFileSync(join(h.work, 'a.txt'), 'utf8') === 'one\n'],
  ['delete', { path: 'ref/a.txt' }, (h: Harness) => !existsSync(join(h.work, 'a.txt'))],
] as const) {
  test(`an undo of a turn whose ${tool} landed on a direct mount gives the notice`, async (t) => {
    const h = await harness(t);
    writeFileSync(join(h.work, 'a.txt'), 'zero\n');
    await h.turn([use(`workspace--${tool}`, input), say('done')]);
    assert.equal(landed(h), true, `the ${tool} landed`);
    assert.equal(h.framework.undoLastTurn('scout').undone, true);
    const [first] = await h.turn([say('back')]);
    assert.equal(carries(first), true);
  });
}

test("an edit_many that wrote some of its files before a rename failed counts as the agent's write", async (t) => {
  const h = await harness(t);
  writeFileSync(join(h.work, 'a.txt'), 'zero\n');
  writeFileSync(join(h.work, 'b.txt'), 'zero\n');
  directWriteTestSeam.beforeRename = (path) => {
    if (path.endsWith('b.txt')) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
  };
  t.after(() => { directWriteTestSeam.beforeRename = undefined; });
  await h.turn([use('workspace--edit_many', { edits: ['a', 'b'].map((n) => ({ path: `ref/${n}.txt`, oldString: 'zero', newString: 'one' })) }), say('partly')]);
  assert.deepEqual(['a', 'b'].map((n) => readFileSync(join(h.work, `${n}.txt`), 'utf8')), ['one\n', 'zero\n']);
  assert.equal(h.framework.undoLastTurn('scout').undone, true);
  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
});

test("writeBinary counts as an agent's write only where it names the agent", async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const first = h.newest();
  await h.turn([say('again')]);
  const anonymous = await h.workspace.writeBinary('ref/anonymous.bin', Buffer.from([1, 2, 3]), 'application/octet-stream');
  assert.equal(anonymous.success, true, anonymous.error);
  await h.branchBack(first);
  assert.equal(h.workspace.headMoveNotice('scout'), null, 'a write that names no agent tells no one');
  await h.turn([say('on the new branch')]);
  const named = await h.workspace.writeBinary('ref/named.bin', Buffer.from([4, 5, 6]), 'application/octet-stream', { agentName: 'scout' });
  assert.equal(named.success, true, named.error);
  assert.equal(h.workspace.headMoveNotice('scout'), null, 'its own branch holds it');
  await h.branchBack(first);
  assert.deepEqual(h.workspace.headMoveNotice('scout')?.mounts, ['ref']);
});

test('a resuming start checks for the notice too, and its request carries it', async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  assert.equal(h.framework.undoLastTurn('scout').undone, true);
  const [first] = await h.turn([say('resumed')], 'scout', { user: false, reason: 'context_budget_restart' });
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 1);
});

test("the notice's text is the one sentence, naming the mount", async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  h.framework.undoLastTurn('scout');
  assert.deepEqual(h.workspace.headMoveNotice('scout'), { text: TEXT, mounts: ['ref'] });
});

test("a context-manager branch switch away from the agent's latest direct write, as connectome-host's /undo makes one, gives the notice", async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const before = h.newest();
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.branchBack(before);
  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 1);
});

test('a head that never moved stores no notice, a write turn\'s own rounds included', async (t) => {
  const h = await harness(t);
  const requests = await h.turn([write('a.txt', 'one\n'), write('b.txt', 'two\n'), say('wrote them')]);
  // The writes landed, and the agent's position is the second's.
  assert.deepEqual(['a.txt', 'b.txt'].map((f) => readFileSync(join(h.work, f), 'utf8')), ['one\n', 'two\n']);
  assert.ok((h.workspace as unknown as { directHeads: Map<string, Map<string, unknown>> }).directHeads.get('ref')?.has('scout'));
  requests.push(...await h.turn([say('and again')]));
  assert.deepEqual(requests.map(carries), requests.map(() => false));
  assert.deepEqual(h.notices(), []);
  assert.equal(h.workspace.headMoveNotice('scout'), null);
});

test('a redo back to the branch that holds the latest write finds nothing due', async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  h.framework.undoLastTurn('scout');
  assert.notEqual(h.workspace.headMoveNotice('scout'), null);
  assert.equal(h.framework.redo('scout').redone, true);
  assert.equal(h.workspace.headMoveNotice('scout'), null);
  const [first] = await h.turn([say('forward')]);
  assert.equal(carries(first), false);
  assert.deepEqual(h.notices(), []);
});

test("a move to a branch that doesn't carry the notice gives it again", async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  h.framework.undoLastTurn('scout');
  await h.turn([say('back')]);
  const [told] = h.notices();
  assert.ok(told);
  // Back to before the notice: the history holds neither the write nor it.
  const messages = h.cm().getAllMessages();
  const at = messages.findIndex((m) => m.id === told);
  await h.branchBack(messages[at - 1]!.id);
  assert.deepEqual(h.notices(), []);
  const [first] = await h.turn([say('back again')]);
  assert.equal(carries(first), true);
  const [again] = h.notices();
  assert.ok(again && again !== told);
});

test('a write after a notice advances the position and clears the notice, so an undo of that write gives the notice again', async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  h.framework.undoLastTurn('scout');
  await h.turn([say('back')]);
  assert.equal(h.notices().length, 1);
  await h.turn([write('b.txt', 'two\n'), say('wrote another')]);
  assert.equal(h.workspace.headMoveNotice('scout'), null);
  // The undo removes the second write's turn and keeps the notice before it.
  assert.equal(h.framework.undoLastTurn('scout').undone, true);
  assert.equal(h.notices().length, 1);
  const [first] = await h.turn([say('back once more')]);
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 2);
});

test('a head moved under a running turn gives the notice at that turn\'s continuing start, and that start\'s request carries it', async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const before = h.newest();
  h.mover.move = () => h.branchBack(before);
  // The stream fails after the move, so the framework's retry starts the turn again.
  const requests = await h.turn([
    { responses: [write('a.txt', 'one\n'), use('mover--move', {})], failAfterRound: 2 },
    { responses: [say('recovered')] },
  ]);
  const retried = h.traces.filter((e) => e.type === 'inference:started' && (e as { agentName?: string }).agentName === 'scout').length;
  assert.ok(retried >= 3, `the retry started (${retried} starts)`);
  assert.deepEqual(requests.map(carries), [false, true]);
  assert.equal(h.notices().length, 1);
});

test('a write made after the head moved under its turn leaves the position where it was, and the next start\'s notice covers it', async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const before = h.newest();
  h.mover.move = () => h.branchBack(before);
  await h.turn([write('a.txt', 'one\n'), use('mover--move', {}), write('b.txt', 'two\n'), say('done')]);
  assert.equal(readFileSync(join(h.work, 'b.txt'), 'utf8'), 'two\n');
  const [first] = await h.turn([say('next')]);
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 1);
  // A write the history then holds the notice for moves the position on.
  await h.turn([write('c.txt', 'three\n'), say('wrote c')]);
  const [after] = await h.turn([say('and on')]);
  assert.equal(carries(after), true, 'the one notice stays in its place');
  assert.equal(h.notices().length, 1);
});

test('a fork after the latest write, and a fork of that fork, hold it, so nothing is due', async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  assert.ok((h.workspace as unknown as { directHeads: Map<string, Map<string, unknown>> }).directHeads.get('ref')?.has('scout'), 'the write has a position');
  await h.turn([say('later')]);
  await h.branchBack(h.newest());
  assert.equal(h.workspace.headMoveNotice('scout'), null, 'a fork after the write holds it');
  await h.turn([say('on the fork')]);
  await h.branchBack(h.newest());
  assert.equal(h.workspace.headMoveNotice('scout'), null, 'and so does a fork of that fork, after the write too');
  const [first] = await h.turn([say('two forks on')]);
  assert.equal(carries(first), false);
});

test("an undo that drops one agent's direct write and keeps another's tells only the one whose write it dropped", async (t) => {
  const h = await harness(t, ['scout', 'helper']);
  await h.turn([write('h.txt', 'helper\n'), say('helped')], 'helper');
  await h.turn([write('s.txt', 'scout\n'), say('scouted')], 'scout');
  const heads = (h.workspace as unknown as { directHeads: Map<string, Map<string, unknown>> }).directHeads.get('ref');
  assert.ok(heads?.has('helper') && heads.has('scout'), 'both writes have positions');
  assert.equal(h.framework.undoLastTurn('scout').undone, true);
  assert.equal(h.workspace.headMoveNotice('helper'), null, "the helper's write came before the fork");
  assert.deepEqual(h.workspace.headMoveNotice('scout')?.mounts, ['ref']);
  const [helper] = await h.turn([say('still helping')], 'helper');
  assert.equal(carries(helper), false);
  const [scout] = await h.turn([say('back')], 'scout');
  assert.equal(carries(scout), true);
});

test("a head-move check that throws, or a notice that can't be stored, is logged, the turn goes on, and the next start gives the notice", async (t) => {
  const h = await harness(t);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  assert.equal(h.framework.undoLastTurn('scout').undone, true);
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(String(args[0])); };
  const check = h.workspace.headMoveNotice.bind(h.workspace);
  const cm = h.cm() as unknown as { addMessage: (...args: unknown[]) => string };
  const add = cm.addMessage.bind(cm);
  try {
    h.workspace.headMoveNotice = () => { throw new Error('zz-check-failed'); };
    const [first] = await h.turn([say('on anyway')]);
    assert.equal(carries(first), false);
    assert.ok(logged.some((line) => line.includes('head-move check failed')), 'the check failure is logged');
    h.workspace.headMoveNotice = check;
    // The notice's own store fails, once.
    let failed = false;
    cm.addMessage = (...args: unknown[]) => {
      if (!failed && (args[2] as { kind?: string } | undefined)?.kind === 'workspace-head-move') {
        failed = true;
        throw new Error('zz-store-failed');
      }
      return add(...args);
    };
    const [second] = await h.turn([say('on again')]);
    assert.equal(failed, true);
    assert.equal(carries(second), false);
    assert.ok(logged.some((line) => line.includes('head-move notice failed')), 'the store failure is logged');
  } finally {
    console.error = error;
    h.workspace.headMoveNotice = check;
    cm.addMessage = add;
  }
  // Nothing marked it given, so the next start gives it.
  const [next] = await h.turn([say('and now')]);
  assert.equal(carries(next), true);
  assert.equal(h.notices().length, 1);
});

test("a module taken for the workspace that can't record a notice as given is given none, and its start goes on", async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const before = h.newest();
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.branchBack(before);
  const workspace = h.workspace as unknown as { headMoveNoticeStored?: unknown };
  workspace.headMoveNoticeStored = undefined;
  try {
    const [first] = await h.turn([say('back')]);
    assert.equal(carries(first), false);
    assert.deepEqual(h.notices(), []);
  } finally {
    delete workspace.headMoveNoticeStored;
  }
  const [next] = await h.turn([say('and now')]);
  assert.equal(carries(next), true);
});

test("a stored notice is marked given before its trace, so a trace that throws neither fails the start nor gives the notice twice", async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const before = h.newest();
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.branchBack(before);
  const inner = h.framework as unknown as { emitTrace: (event: { type: string; source?: string }) => void };
  const emit = inner.emitTrace.bind(h.framework);
  let thrown = 0;
  inner.emitTrace = (event) => {
    if (event.source === 'workspace-head-move') {
      thrown++;
      throw new Error('zz-trace-failed');
    }
    emit(event);
  };
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(String(args[0])); };
  try {
    const [first] = await h.turn([say('back')]);
    assert.equal(thrown, 1);
    assert.equal(carries(first), true);
    assert.ok(logged.some((line) => line.includes('head-move notice trace failed')), 'the trace failure is logged');
  } finally {
    console.error = error;
    inner.emitTrace = emit;
  }
  await h.turn([say('again')]);
  assert.equal(h.notices().length, 1);
});

test('a history lookup that throws decides nothing at a start, and leaves the position where it was at a write, which still lands', async (t) => {
  const h = await harness(t);
  await h.turn([say('hello')]);
  const before = h.newest();
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.branchBack(before);
  await h.turn([say('back')]);
  const [told] = h.notices();
  assert.ok(told, 'the notice is stored, so later checks ask the history for it');
  // Back to before the notice too: the history holds neither the write nor it.
  const messages = h.cm().getAllMessages();
  await h.branchBack(messages[messages.findIndex((m) => m.id === told) - 1]!.id);
  const heads = (h.workspace as unknown as { directHeads: Map<string, Map<string, { branchId: string; after: number }>> }).directHeads;
  const position = { ...heads.get('ref')!.get('scout')! };
  const logged: string[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { logged.push(String(args[0])); };
  const lookup = (h.framework as unknown as { agents: Map<string, { getContextManager(): { getMessage(id: string): unknown } }> }).agents;
  try {
    h.workspace.useHistory(() => { throw new Error('zz-lookup-failed'); });
    // At a start, no notice.
    const [first] = await h.turn([say('unreadable')]);
    assert.equal(carries(first), false);
    assert.deepEqual(h.notices(), []);
    // At a write, the write lands and its position stays.
    const written = await h.framework.executeToolCall({ id: 'direct-lookup', name: 'workspace--write', input: { path: 'ref/b.txt', content: 'two\n' }, callerAgentName: 'scout' } as Parameters<AgentFramework['executeToolCall']>[0]);
    assert.equal(written.success, true, written.error);
    assert.equal(readFileSync(join(h.work, 'b.txt'), 'utf8'), 'two\n');
    assert.deepEqual({ ...heads.get('ref')!.get('scout')! }, position);
    assert.ok(logged.some((line) => line.includes('history lookup for the head-move notice failed')));
  } finally {
    console.error = error;
    // The framework's own lookup again.
    h.workspace.useHistory((agent, id) => lookup.get(agent)?.getContextManager().getMessage(id) != null);
  }
  // The next start whose lookup answers decides: exactly one notice.
  const [second] = await h.turn([say('readable')]);
  assert.equal(carries(second), true);
  assert.equal(h.notices().length, 1);
});

test("each agent is told only of its own direct writes", async (t) => {
  const h = await harness(t, ['scout', 'helper']);
  await h.turn([write('a.txt', 'one\n'), say('wrote it')], 'scout');
  await h.turn([say('helping')], 'helper');
  h.framework.undoLastTurn('scout');
  const [helper] = await h.turn([say('still helping')], 'helper');
  assert.equal(carries(helper), false);
  assert.deepEqual(h.notices('helper'), []);
  const [scout] = await h.turn([say('back')], 'scout');
  assert.equal(carries(scout), true);
});

test("the framework's own files pass over a mount running direct, and a host whose only writable mount runs direct keeps none", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'af-ws-direct-spill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let stores = 0;
  const place = async (mounts: MountConfig[]): Promise<{ path: string | null; why: string }> => {
    for (const mount of mounts) mkdirSync(mount.path, { recursive: true });
    const workspace = new WorkspaceModule({ mounts });
    const framework = await AgentFramework.create({
      storePath: join(dir, `store-${++stores}`),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'zz-agent-scout' }],
      modules: [workspace],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    workspace.initStore(framework.getStore());
    try {
      const inner = framework as unknown as { toolResultFilePlace(label: string): { path: string } | null; noFileMountText(): string };
      return { path: inner.toolResultFilePlace('zz')?.path ?? null, why: inner.noFileMountText() };
    } finally {
      await framework.stop();
    }
  };
  const direct = { name: 'ref', path: join(dir, 'checkout'), backend: 'direct' } as MountConfig;
  const scratch: MountConfig = { name: 'scratch', path: join(dir, 'scratch'), mode: 'read-write', watch: 'never' };
  assert.match(String((await place([direct, scratch])).path), /^scratch\/tool-results\//);
  // With only a direct mount, its words say why none keeps the file, and
  // with none at all, they're the ones a host with no writable mount gets.
  assert.deepEqual(await place([direct]), { path: null, why: 'no writable workspace mount without an include that keeps its files in the store' });
  assert.deepEqual(await place([{ ...scratch, mode: 'read-only' }]), { path: null, why: 'no writable workspace mount without an include' });
  // A direct mount that couldn't hold the files anyway doesn't change the words.
  assert.deepEqual(await place([{ ...direct, mode: 'read-only' }]), { path: null, why: 'no writable workspace mount without an include' });
  assert.deepEqual(await place([{ ...direct, include: ['src/**'] }]), { path: null, why: 'no writable workspace mount without an include' });
});

test('the position survives a restart onto a branch forked before the write, as an offline rollback makes one, and the notice comes', async (t) => {
  const h = new Harness();
  t.after(() => h.cleanup());
  await h.open();
  await h.turn([say('hello')]);
  const store = h.framework.getStore();
  const from = store.currentBranch().name;
  const before = store.currentSequence();
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.close();
  // The rollback, with the framework stopped: a branch at the store's head
  // before the write's turn, made current.
  const offline = JsStore.openOrCreate({ path: join(h.dir, 'store') });
  offline.createBranchAt('zz-rolled-back', from, before);
  offline.switchBranch('zz-rolled-back');
  offline.close();
  await h.open();
  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
  assert.equal(readFileSync(join(h.work, 'a.txt'), 'utf8'), 'one\n');
  await h.close();
});

test('the position and the notice survive a clean restart, through the stop-time save', async (t) => {
  const h = new Harness();
  t.after(() => h.cleanup());
  await h.open();
  await h.turn([say('hello')]);
  const before = h.newest();
  await h.turn([write('a.txt', 'one\n'), say('wrote it')]);
  await h.close();

  // The position, saved at stop(): a move after the restart gives the notice.
  await h.open();
  await h.branchBack(before);
  const [first] = await h.turn([say('back')]);
  assert.equal(carries(first), true);
  assert.equal(h.notices().length, 1);
  await h.close();

  // The notice's id, saved at stop(): the next start finds it held.
  await h.open();
  assert.equal(h.workspace.headMoveNotice('scout'), null);
  const [next] = await h.turn([say('on')]);
  assert.equal(carries(next), true);
  assert.equal(h.notices().length, 1);
  await h.close();
});
