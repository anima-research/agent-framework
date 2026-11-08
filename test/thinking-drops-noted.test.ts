/**
 * Telling the context manager which stored replies' thinking the provider dropped. A call whose report names a
 * dropped block of a stored reply hands that reply's bodies, as the stream start's `placeDrops` gives them, to
 * the context manager's `noteThinkingDropped` with the id of the compile the stream was built from, so its
 * thinking-binding record leaves them without their thinking from the next compile on. A note that throws doesn't
 * end the stream.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, DetailedUsage, NormalizedRequest, NormalizedResponse, ThinkingBindingEntry, YieldingStream } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import type { EventResponse, Module, ProcessEvent, ToolCall, TraceEvent } from '../src/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

const SIG = 'sig-earlier'.repeat(12);
const usage = (input: number): DetailedUsage => ({ inputTokens: input, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 });
const entry = (fields: Partial<ThinkingBindingEntry> = {}): ThinkingBindingEntry =>
  ({ reason: 'prefix_binding_mismatch', path: 'messages.0.content.0', ...fields });
const signedAt = (request: NormalizedRequest, signature: string): Array<{ message: number; block: number }> => {
  const at: Array<{ message: number; block: number }> = [];
  request.messages.forEach((m, message) => m.content.forEach((b, block) => {
    if ((b as { signature?: unknown }).signature === signature) at.push({ message, block });
  }));
  return at;
};
/** A call's response, with a thinking report of `dropped`, or none where it's null. */
const withThinking = (response: NormalizedResponse, input: number, dropped: ThinkingBindingEntry[] | null): NormalizedResponse =>
  Object.assign(response, { usage: usage(input), ...(dropped ? { round: { thinking: { dropped, mismatchAllowed: [] } } } : {}) });
const toolRound = (input: number, dropped: ThinkingBindingEntry[] | null, id: string) =>
  withThinking(createMockResponse([{ type: 'tool_use', name: 'test--echo', id, input: {} }], 'tool_use'), input, dropped);
const final = (input: number, dropped: ThinkingBindingEntry[] | null, text = 'Done.') => {
  const response = withThinking(createMockResponse([{ type: 'text', text }]), input, dropped);
  response.details!.usage = response.usage;
  return response;
};

class Tools implements Module {
  readonly name = 'test';
  async start() {}
  async stop() {}
  async onProcess() { return {}; }
  getTools() { return [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' as const, properties: {} } }]; }
  async handleToolCall(_call: ToolCall) { return { success: true, data: {} }; }
}

/** Answers one stream with the responses `script` builds from where the stored reply's signed block sits. */
class ScriptedMembrane extends MockMembrane {
  constructor(private readonly script: (at: { message: number; block: number }) => NormalizedResponse[]) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const [at] = signedAt(request, SIG);
    assert.ok(at, 'the request carries the stored reply\'s signed block');
    const stream = new MockYieldingStream(this.script(at));
    this.lastStream = stream;
    return stream;
  }
}

type Noted = { messageIds: string[]; compileId: string };

/** One three-call stream of an agent whose stored earlier reply carries a signed block, each call dropping what
 *  `drops` says; `note` is what the context manager's noteThinkingDropped does after recording the note. */
async function stream(opts: {
  drops: (at: { message: number; block: number }) => Array<ThinkingBindingEntry[] | null>;
  note: 'return' | 'throw';
}) {
  const dir = mkdtempSync(join(tmpdir(), 'af-thinking-noted-'));
  const membrane = new ScriptedMembrane((at) => {
    const [first = [], second = [], third = []] = opts.drops(at);
    return [toolRound(100, first, 'c1'), toolRound(110, second, 'c2'), final(120, third)];
  });
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: membrane.asMembrane(), agents: [], modules: [new Tools()], syncIntervalMs: 0,
  });
  const failed: TraceEvent[] = [];
  framework.onTrace((event) => { if (event.type === 'inference:failed') failed.push(event); });
  framework.start();
  try {
    const { agent, contextManager } = await framework.createEphemeralAgent({
      name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Do the task.', allowedTools: 'all', proseRouting: 'disabled',
      thinking: { enabled: true, budgetTokens: 1024 }, thinkingBinding: { binds: true, dropBlock: true },
    } as never);
    contextManager.addMessage('user', [{ type: 'text', text: 'Earlier.' }]);
    const earlier = contextManager.addMessage('worker', [{ type: 'thinking', thinking: '', signature: SIG } as never, { type: 'text', text: 'Earlier reply.' }]);
    contextManager.addMessage('user', [{ type: 'text', text: 'Run once.' }]);
    const noted: Noted[] = [];
    (contextManager as unknown as { noteThinkingDropped: (ids: readonly string[], compileId: string) => boolean }).noteThinkingDropped =
      (messageIds, compileId) => {
        noted.push({ messageIds: [...messageIds], compileId });
        if (opts.note === 'throw') throw new Error('the store is gone');
        return true;
      };
    const compileIds: string[] = [];
    const compile = contextManager.compile.bind(contextManager);
    contextManager.compile = (async (budget, injections, o) => {
      const result = await compile(budget, injections, o);
      if ((o as { dryRun?: boolean } | undefined)?.dryRun !== true && result.provenance) compileIds.push(result.provenance.compileId);
      return result;
    }) as typeof compile;
    await framework.runEphemeralToCompletion(agent, contextManager);
    return { noted, compileIds, earlier, calls: membrane.calls.length, failed };
  } finally {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a call\'s dropped stored-reply thinking, noted to the context manager', () => {
  const dropped = (at: { message: number; block: number }) => entry({ message: at.message, block: at.block });

  it('hands each call\'s reply drops\' bodies to noteThinkingDropped, with the stream\'s compile id, and no other kind\'s', async () => {
    // Call 1 drops the stored reply's block twice over (two entries naming it), a block of the stream's own first
    // round, and one it can't place; call 2 drops the stored reply's again; call 3 drops nothing.
    const { noted, compileIds, earlier, calls } = await stream({
      note: 'return',
      drops: (at) => [[dropped(at), dropped(at), entry({ message: 3, block: 0, round: 0 }), entry({ message: 0, block: 0 })], [dropped(at)], []],
    });
    assert.equal(calls, 1, 'one stream');
    assert.equal(compileIds.length, 1, 'premise: one committing compile, the stream\'s');
    // The ids as a set: the record reads its `without` back as one, so repeats change nothing.
    assert.deepEqual(noted.map((note) => ({ messageIds: [...new Set(note.messageIds)], compileId: note.compileId })), [
      { messageIds: [earlier], compileId: compileIds[0] },
      { messageIds: [earlier], compileId: compileIds[0] },
    ], 'the reply\'s body at each call that dropped it, and nothing for the round\'s or the unplaced one');
  });

  it('keeps the stream going when the note throws, and notes again at the next call that drops', async () => {
    const { noted, calls, failed } = await stream({ note: 'throw', drops: (at) => [[dropped(at)], [dropped(at)], []] });
    assert.equal(calls, 1);
    assert.equal(noted.length, 2, 'each call that dropped the reply\'s block still noted it');
    assert.deepEqual(failed, [], 'no inference failed');
  });
});

/** Turns each external message into a user message and a request for inference. */
class InputModule implements Module {
  readonly name = 'input';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }], requestInference: true };
  }
}

/** A provider that binds signed thinking to the conversation before it: every block of `signatures` it's sent,
 *  the replies stored before the branch's record began, which an earlier conversation change left unverifiable,
 *  it drops and reports, and it answers each stream with one reply. */
class DroppingProvider extends MockMembrane {
  readonly sent: Array<Array<{ message: number; block: number }>> = [];
  constructor(private readonly signatures: readonly string[]) { super(); }
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const at = this.signatures.flatMap((signature) => signedAt(request, signature));
    this.sent.push(at);
    const dropped = at.map(({ message, block }) => entry({ path: `messages.${message}.content.${block}`, message, block }));
    const stream = new MockYieldingStream([final(1000 + 10 * this.calls.length, dropped, `Reply ${this.calls.length}.`)]);
    this.lastStream = stream;
    return stream;
  }
}

describe('a resident whose stored replies predate its binding record, and whose provider drops their thinking', () => {
  it('drops them at the first call only: the next calls send none of them, and each gives the calibration its sample', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'af-thinking-noted-e2e-'));
    const signatures = ['sig-a'.repeat(20), 'sig-b'.repeat(20)];
    const provider = new DroppingProvider(signatures);
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: provider.asMembrane(),
      agents: [{ name: 'agent', model: 'claude-opus-5-5', systemPrompt: 'test', proseRouting: 'disabled',
        thinking: { enabled: true, budgetTokens: 1024 }, thinkingBinding: { binds: true, dropBlock: true } } as never],
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    });
    const completed: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'inference:completed') completed.push(event); });
    framework.start();
    try {
      const contextManager = framework.getAgent('agent')!.getContextManager();
      // Replies stored before any compile wrote the branch's binding record: each one's thinking predates it.
      for (const [i, signature] of signatures.entries()) {
        contextManager.addMessage('User', [{ type: 'text', text: `Earlier ${i}.` }]);
        contextManager.addMessage('agent', [{ type: 'thinking', thinking: '', signature } as ContentBlock, { type: 'text', text: `Earlier reply ${i}.` }]);
      }
      const calibrated: number[] = [];
      const strategy = contextManager.getStrategy() as unknown as { reportRealInputTokens?: (n: number) => void };
      strategy.reportRealInputTokens = (n) => { calibrated.push(n); };
      const turn = async (text: string) => {
        const before = completed.length;
        framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as never);
        await framework.runUntilIdle();
        for (const until = Date.now() + 10_000; completed.length === before && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
        assert.equal(completed.length, before + 1, `the turn for "${text}" completed`);
      };

      await turn('One.');
      assert.equal(provider.sent[0]!.length, 2, 'premise: the first call sends both earlier replies\' thinking, and the provider drops both');
      assert.deepEqual(calibrated, [], 'a call that dropped blocks gives no sample');

      await turn('Two.');
      assert.deepEqual(provider.sent[1], [], 'the second call sends neither earlier reply\'s thinking');
      assert.deepEqual(calibrated, [1020], 'and gives the calibration its sample');

      await turn('Three.');
      assert.deepEqual(provider.sent[2], [], 'nor does the third');
      assert.deepEqual(calibrated, [1020, 1030]);
    } finally {
      await framework.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
