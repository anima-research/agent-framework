/**
 * An agent's effort, from `FrameworkConfig.effort`: a level, or a function of the agent's name and model asked at
 * each request. The request's top-level `output_config.effort` stays the agent's base, and a change travels as one
 * effort-only `system_change` row stored directly after new user input, so the prompt cache before it still holds.
 * Each test reads what the provider was handed, through a real context-manager compile.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as membrane from '@animalabs/membrane';
import { MembraneError } from '@animalabs/membrane';
import type { ContentBlock, NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';

import { AgentFramework } from '../src/index.js';
import type { ErrorAction, EventResponse, Module, ModuleContextInjection, ProcessEvent, ToolCall, TraceEvent } from '../src/index.js';
import { HistoryModule } from '../src/modules/history/index.js';
import { createMockResponse, MockMembrane, MockYieldingStream } from './helpers/mock-membrane.js';

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Membrane sends an effort-only `system_change` from the release that exports `SYSTEM_CHANGE_EFFORT` (0.10.0). */
const ROWS = (membrane as unknown as Record<string, unknown>).SYSTEM_CHANGE_EFFORT === true;
/** For a test of effort rows: skipped where the installed membrane sends none, as on CI's 0.8 and 0.9 floor legs. */
const NEEDS_ROWS = ROWS ? false : 'the installed membrane exports no SYSTEM_CHANGE_EFFORT, so it sends no effort rows';

const effortBlock = (effort: Level) => ({ type: 'system_change', effort }) as unknown as ContentBlock;
const isEffortBlock = (b: ContentBlock) => b.type === 'system_change' && (b as { effort?: unknown }).effort !== undefined;
/** The effort rows a request carries: where, which level, under which participant. */
const effortRows = (request: NormalizedRequest) => request.messages.flatMap((m, at) =>
  m.content.filter(isEffortBlock).map((b) => ({ at, effort: (b as unknown as { effort: string }).effort, participant: m.participant })));
const topLevel = (request: NormalizedRequest) =>
  (request.providerParams as { output_config?: { effort?: unknown } } | undefined)?.output_config?.effort;
const textOf = (m: { content: readonly ContentBlock[] }) =>
  m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('');
const indexOfText = (request: NormalizedRequest, text: string) => request.messages.findIndex((m) => textOf(m).includes(text));
const storedEffortRows = (framework: AgentFramework, agent = 'agent') =>
  framework.getAgent(agent)!.getContextManager().getAllMessages().filter((m) => m.content.some(isEffortBlock));

const refusal = (systemChangeRefused: boolean) => new MembraneError({
  type: 'invalid_request', retryable: false, httpStatus: 400,
  message: 'output_config.effort requires a model that supports per-turn effort; this model does not',
  rawError: undefined, ...(systemChangeRefused ? { systemChangeRefused: true } : {}),
} as never);

class ErrorStream implements YieldingStream {
  isWaitingForTools = false;
  pendingToolCallIds: string[] = [];
  toolDepth = 0;
  isCancelled = false;
  constructor(private readonly error: Error) {}
  provideToolResults(): void { throw new Error('not waiting'); }
  cancel(): void { this.isCancelled = true; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    yield { type: 'error', error: this.error } as StreamEvent;
  }
}

/** Records each request, whose it is, and answers each stream with one reply, or with what `fail` gives first. */
class Provider extends MockMembrane {
  fail?: (request: NormalizedRequest) => Error | undefined;
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    const error = this.fail?.(request);
    if (error) return new ErrorStream(error);
    const response = createMockResponse([{ type: 'text', text: `Reply ${this.calls.length}.` }]);
    const stream = new MockYieldingStream([response]);
    this.lastStream = stream;
    return stream;
  }
  /** The requests that carry `text`: a derived agent's, by its framing. */
  carrying(text: string): NormalizedRequest[] {
    return this.calls.filter((r) => indexOfText(r, text) >= 0);
  }
}

/** Turns an external message into a user message and a request for inference; one marked `poke` only asks. */
class InputModule implements Module {
  readonly name = 'input';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall(_call: ToolCall) { return { success: false, isError: true, error: 'none' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    const metadata = (event as { metadata?: { poke?: boolean; quiet?: boolean; to?: string } }).metadata;
    if (metadata?.poke) return { requestInference: true };
    return {
      addMessages: [{ participant: 'User', content: [{ type: 'text', text: String(event.content) }] }],
      requestInference: metadata?.to ? [metadata.to] : !metadata?.quiet,
    };
  }
}

/** Input as InputModule takes it, and a stored context injection after it each turn, its text new each time. */
class InjectingInput extends InputModule {
  private gathered = 0;
  async gatherContext(): Promise<ModuleContextInjection[]> {
    return [{ namespace: 'notes', position: 'afterUser', content: [{ type: 'text', text: `Note ${++this.gathered}.` }] }];
  }
}

/** A policy that records each error it's asked about with its attempt, and answers as `answer` does. */
class RecordingPolicy {
  readonly asked: Error[] = [];
  readonly attempts: number[] = [];
  maxRetries = 3;
  constructor(private readonly answer: (error: Error) => ErrorAction = () => ({ retry: false })) {}
  onInferenceError(error: Error, _agent: string, attempt: number): ErrorAction {
    this.asked.push(error);
    this.attempts.push(attempt);
    return this.answer(error);
  }
}

const dirs: string[] = [];
const frameworks: AgentFramework[] = [];
const cleanup = async () => {
  for (const framework of frameworks.splice(0)) await framework.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};

/** A resident named `agent` on `claude-opus-5-5`, with `effort` as FrameworkConfig.effort where given. */
async function resident(opts: {
  effort?: unknown;
  dir?: string;
  provider?: Provider;
  agent?: Record<string, unknown>;
  errorPolicy?: RecordingPolicy;
  input?: Module;
} = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'af-effort-'));
  if (!opts.dir) dirs.push(dir);
  const provider = opts.provider ?? new Provider();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store.chronicle'), membrane: provider.asMembrane(),
    agents: [{ name: 'agent', model: 'claude-opus-5-5', systemPrompt: 'test', proseRouting: 'disabled', ...opts.agent }],
    modules: [opts.input ?? new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.errorPolicy ? { errorPolicy: opts.errorPolicy } : {}),
  } as never);
  frameworks.push(framework);
  const completed: TraceEvent[] = [];
  const exhausted: TraceEvent[] = [];
  framework.onTrace((event) => {
    if (event.type === 'inference:completed') completed.push(event);
    if (event.type === 'inference:exhausted') exhausted.push(event);
  });
  framework.start();
  const settle = async (before: number, what: string) => {
    await framework.runUntilIdle();
    for (const until = Date.now() + 10_000; completed.length + exhausted.length === before && Date.now() < until;) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(completed.length + exhausted.length > before, `${what} ended`);
  };
  /** A turn on new user input `text`. */
  const turn = async (text: string) => {
    const before = completed.length + exhausted.length;
    framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: {} } as never);
    await settle(before, `the turn for "${text}"`);
  };
  /** A turn with no new input: the request ends on the agent's own message, so it carries [Continue]. */
  const poke = async () => {
    const before = completed.length + exhausted.length;
    framework.pushEvent({ type: 'external-message', source: 'test', content: '', metadata: { poke: true } } as never);
    await settle(before, 'the poked turn');
  };
  const stop = async () => {
    frameworks.splice(frameworks.indexOf(framework), 1);
    await framework.stop();
  };
  return { framework, provider, turn, poke, stop, dir, completed, exhausted };
}

describe('FrameworkConfig.effort: the base on top, a change as a row', () => {
  it('sends a level as the top-level effort, and no row while it doesn\'t change', async () => {
    try {
      const { provider, turn } = await resident({ effort: 'high' });
      await turn('One.');
      await turn('Two.');
      assert.deepEqual(provider.calls.map(topLevel), ['high', 'high']);
      assert.deepEqual(provider.calls.map(effortRows), [[], []]);
    } finally { await cleanup(); }
  });

  it('sends a change as one row right after the new input, under the same top level, and in place from then on', { skip: NEEDS_ROWS }, async () => {
    try {
      let live: Level = 'high';
      const { framework, provider, turn } = await resident({ effort: () => live });
      await turn('One.');
      live = 'low';
      await turn('Two.');
      const [, second] = provider.calls;
      assert.equal(topLevel(second!), 'high', 'the top level stays the base');
      assert.deepEqual(effortRows(second!), [{ at: indexOfText(second!, 'Two.') + 1, effort: 'low', participant: 'system' }],
        'one row, directly after the new input');
      assert.equal(second!.messages.length - 1, indexOfText(second!, 'Two.') + 1, 'the request ends on it');

      await turn('Three.');
      const third = provider.calls[2]!;
      assert.equal(topLevel(third), 'high');
      assert.deepEqual(effortRows(third).map((r) => r.effort), ['low'], 'no second row');
      assert.deepEqual(third.messages.slice(0, second!.messages.length), second!.messages, 'what the second request sent is the third\'s prefix');
      assert.ok(textOf(third.messages[second!.messages.length]!).includes('Reply 2.'), 'the reply that ran at low follows its row');
      assert.equal(storedEffortRows(framework).length, 1, 'one row stored');
    } finally { await cleanup(); }
  });

  it('holds a change made where the request doesn\'t end on new input until the next input', { skip: NEEDS_ROWS }, async () => {
    try {
      let live: Level = 'high';
      const { provider, turn, poke } = await resident({ effort: () => live });
      await turn('One.');
      live = 'low';
      await poke();
      assert.equal(provider.calls.length, 2, 'premise: the poke ran a turn');
      const poked = provider.calls[1]!;
      assert.equal(topLevel(poked), 'high');
      assert.deepEqual(effortRows(poked), [], 'no row on a request that ends on [Continue]');
      await turn('Two.');
      const next = provider.calls[2]!;
      assert.deepEqual(effortRows(next), [{ at: indexOfText(next, 'Two.') + 1, effort: 'low', participant: 'system' }]);
    } finally { await cleanup(); }
  });

  it('holds a change on a request that ends on [Continue] after the agent\'s own stored context injection', { skip: NEEDS_ROWS }, async () => {
    try {
      let live: Level = 'high';
      const { provider, turn, poke } = await resident({ effort: () => live, input: new InjectingInput() });
      await turn('One.');
      live = 'low';
      await poke();
      assert.equal(provider.calls.length, 2, 'premise: the poke ran a turn');
      const poked = provider.calls[1]!;
      assert.ok(poked.messages.some((m) => textOf(m).includes('Note 2.')), 'premise: the poked request carries the injection stored at its start');
      assert.deepEqual(effortRows(poked), [], 'no row');
      await turn('Two.');
      assert.deepEqual(effortRows(provider.calls[2]!).map((r) => r.effort), ['low'], 'the next input carries it');
    } finally { await cleanup(); }
  });

  it('sends no top level and no row while the function answers undefined, and a level after that travels as a row', { skip: NEEDS_ROWS }, async () => {
    try {
      let live: Level | undefined = 'high';
      const { framework, provider, turn } = await resident({ effort: () => live });
      await turn('One.');
      live = 'low';
      await turn('Two.');
      assert.deepEqual(provider.calls.map(topLevel), ['high', 'high']);
      live = undefined;
      await turn('Three.');
      const third = provider.calls[2]!;
      assert.equal(topLevel(third), undefined, 'no top-level effort');
      assert.deepEqual(effortRows(third), [], 'the stored row is left out');
      live = 'low';
      await turn('Four.');
      const fourth = provider.calls[3]!;
      assert.equal(topLevel(fourth), undefined, 'the base is none from Three on');
      assert.deepEqual(effortRows(fourth).map((r) => r.effort), ['low'], 'the stored row is back, and in force: no new one');
      assert.equal(storedEffortRows(framework).length, 1);
    } finally { await cleanup(); }
  });

  it('keeps the base across a restart', { skip: NEEDS_ROWS }, async () => {
    try {
      const dir = mkdtempSync(join(tmpdir(), 'af-effort-restart-'));
      dirs.push(dir);
      const first = await resident({ effort: 'high', dir });
      await first.turn('One.');
      await first.stop();
      const second = await resident({ effort: 'low', dir });
      await second.turn('Two.');
      const after = second.provider.calls[0]!;
      assert.equal(topLevel(after), 'high', 'the base recorded before the restart');
      assert.deepEqual(effortRows(after), [{ at: indexOfText(after, 'Two.') + 1, effort: 'low', participant: 'system' }]);
    } finally { await cleanup(); }
  });

  it('keeps a base per branch: a branch made before the base starts its own, and the first branch keeps its base', { skip: NEEDS_ROWS }, async () => {
    try {
      let live: Level = 'high';
      const { framework, provider, turn } = await resident({ effort: () => live });
      const store = framework.getStore();
      const main = store.currentBranch().name;
      store.createBranch('side', main);
      await turn('One.');
      live = 'low';
      await framework.switchBranch('side');
      await turn('Two.');
      await framework.switchBranch(main);
      await turn('Three.');
      assert.deepEqual(provider.calls.map(topLevel), ['high', 'low', 'high'], 'side starts its base at the live level; main keeps its own');
      assert.deepEqual(effortRows(provider.calls[1]!), [], 'no row on side, whose base is the live level');
      const third = provider.calls[2]!;
      assert.deepEqual(effortRows(third), [{ at: indexOfText(third, 'Three.') + 1, effort: 'low', participant: 'system' }]);
    } finally { await cleanup(); }
  });

  it('changes nothing without FrameworkConfig.effort: a stored effort row goes as stored, with no top level added', async () => {
    try {
      const { framework, provider, turn } = await resident({ agent: { providerParams: { output_config: { effort: 'medium' } } } });
      await turn('One.');
      framework.getAgent('agent')!.getContextManager().addMessage('system', [effortBlock('low')]);
      await turn('Two.');
      assert.deepEqual(provider.calls.map(topLevel), ['medium', 'medium'], 'the host\'s own providerParams, as given');
      assert.deepEqual(effortRows(provider.calls[1]!).map((r) => r.effort), ['low']);
    } finally { await cleanup(); }
  });
});

describe('FrameworkConfig.effort: a membrane that sends no effort rows', { skip: ROWS && 'the installed membrane exports SYSTEM_CHANGE_EFFORT' }, () => {
  it('sends the live effort on top at each request, and stores and sends no row', async () => {
    try {
      let live: Level | undefined = 'high';
      const { framework, provider, turn } = await resident({ effort: () => live });
      await turn('One.');
      live = 'low';
      await turn('Two.');
      live = undefined;
      await turn('Three.');
      assert.deepEqual(provider.calls.map(topLevel), ['high', 'low', undefined]);
      assert.deepEqual(provider.calls.map(effortRows), [[], [], []]);
      assert.equal(storedEffortRows(framework).length, 0);
    } finally { await cleanup(); }
  });
});

describe('FrameworkConfig.effort: every agent', () => {
  it('asks a function with each agent\'s name and model, derived agents included, at each request', async () => {
    try {
      let live: Level = 'high';
      const asked: Array<{ name: string; model: string }> = [];
      const effort = (agent: { name: string; model: string }) => {
        asked.push({ name: agent.name, model: agent.model });
        return agent.model === 'claude-sonnet-4-6' ? undefined : live;
      };
      const { framework, provider, turn } = await resident({ effort });
      await turn('One.');
      live = 'low';
      await turn('Two.');
      const reader = await framework.deriveAgent({
        name: 'reader', from: 'agent', config: { model: 'claude-sonnet-4-6' },
        framing: [{ participant: 'user', content: [{ type: 'text', text: 'Read it.' }] }],
      });
      await framework.runEphemeralToCompletion(reader.agent, reader.contextManager);
      const [read] = provider.carrying('Read it.');
      assert.ok(read, 'the reader sent a request');
      assert.equal(topLevel(read!), undefined);
      assert.deepEqual(effortRows(read!), [], 'the resident\'s row is left out');
      const worker = await framework.deriveAgent({
        name: 'worker', from: 'agent', config: { model: 'claude-opus-5' },
        framing: [{ participant: 'user', content: [{ type: 'text', text: 'Work.' }] }],
      });
      await framework.runEphemeralToCompletion(worker.agent, worker.contextManager);
      const [work] = provider.carrying('Work.');
      assert.equal(topLevel(work!), 'low');
      assert.ok(asked.some((a) => a.name === 'reader' && a.model === 'claude-sonnet-4-6'));
      assert.ok(asked.some((a) => a.name === 'worker' && a.model === 'claude-opus-5'));
      assert.ok(asked.filter((a) => a.name === 'agent').length >= 2, 'asked at each of the resident\'s requests');
    } finally { await cleanup(); }
  });

  it('gives a derived agent on its parent\'s model the parent\'s base, so it sends what the parent sends', { skip: NEEDS_ROWS }, async () => {
    try {
      let live: Level = 'high';
      const { framework, provider, turn } = await resident({ effort: () => live });
      await turn('One.');
      live = 'low';
      await turn('Two.');
      const fork = await framework.deriveAgent({
        name: 'fork', from: 'agent',
        framing: [{ participant: 'user', content: [{ type: 'text', text: 'Fork.' }] }],
      });
      await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
      const [forked] = provider.carrying('Fork.');
      assert.equal(topLevel(forked!), 'high', 'the parent\'s base, not the level when it was derived');
      assert.deepEqual(effortRows(forked!).map((r) => r.effort), ['low'], 'the parent\'s row, and no new one');
    } finally { await cleanup(); }
  });

  it('refuses an agent given output_config.effort in providerParams while FrameworkConfig.effort is set, naming both', async () => {
    try {
      await assert.rejects(
        resident({ effort: 'high', agent: { providerParams: { output_config: { effort: 'low' } } } }),
        (error: Error) => /providerParams\.output_config\.effort/.test(error.message) && /FrameworkConfig\.effort/.test(error.message),
        'at create',
      );
      const { framework } = await resident({ effort: 'high' });
      await assert.rejects(
        framework.createEphemeralAgent({
          name: 'worker', model: 'claude-opus-5-5', systemPrompt: 'Work.',
          providerParams: { output_config: { effort: 'low' } },
        } as never),
        (error: Error) => /providerParams\.output_config\.effort/.test(error.message) && /FrameworkConfig\.effort/.test(error.message),
        'at createEphemeralAgent',
      );
      await assert.rejects(
        framework.deriveAgent({ name: 'fork', from: 'agent', config: { providerParams: { output_config: { effort: 'low' } } } }),
        (error: Error) => /providerParams\.output_config\.effort/.test(error.message) && /FrameworkConfig\.effort/.test(error.message),
        'at deriveAgent',
      );
    } finally { await cleanup(); }
  });
});

describe('FrameworkConfig.effort: a model that refuses effort rows', { skip: NEEDS_ROWS }, () => {
  it('retries a marked refusal of a request carrying a row at once, without rows and with the live effort on top', async () => {
    try {
      let live: Level = 'high';
      const errorPolicy = new RecordingPolicy();
      const provider = new Provider();
      const { framework, turn, exhausted } = await resident({ effort: () => live, provider, errorPolicy });
      await turn('One.');
      live = 'low';
      provider.fail = (request) => (effortRows(request).length > 0 ? refusal(true) : undefined);
      await turn('Two.');
      assert.equal(provider.calls.length, 3, 'the refused request and its retry');
      assert.deepEqual(effortRows(provider.calls[1]!).map((r) => r.effort), ['low'], 'premise: the refused request carried the row');
      const retry = provider.calls[2]!;
      assert.deepEqual(effortRows(retry), [], 'the retry carries no row');
      assert.equal(topLevel(retry), 'low', 'and the live effort on top');
      assert.deepEqual(errorPolicy.asked, [], 'the error policy wasn\'t asked');
      assert.deepEqual(exhausted, [], 'the turn didn\'t fail');

      await turn('Three.');
      const later = provider.calls[3]!;
      assert.deepEqual(effortRows(later), [], 'no rows from then on');
      assert.equal(topLevel(later), 'low');
      live = 'medium';
      await turn('Four.');
      assert.equal(topLevel(provider.calls[4]!), 'medium', 'a change goes on top');
      assert.equal(storedEffortRows(framework).length, 1, 'and writes no row');
    } finally { await cleanup(); }
  });

  it('doesn\'t count the retry after a marked refusal as one of the error policy\'s attempts', async () => {
    try {
      let live: Level = 'high';
      const errorPolicy = new RecordingPolicy(() => ({ retry: false }));
      const provider = new Provider();
      const { turn } = await resident({ effort: () => live, provider, errorPolicy });
      await turn('One.');
      live = 'low';
      provider.fail = (request) => {
        if (effortRows(request).length > 0) return refusal(true);
        return provider.calls.length === 3
          ? new MembraneError({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error', rawError: undefined } as never)
          : undefined;
      };
      await turn('Two.');
      assert.equal(provider.calls.length, 3, 'premise: the refused request, then its retry, which fails');
      assert.deepEqual(errorPolicy.attempts, [0], 'the retry\'s failure is the turn\'s first for the policy');
    } finally { await cleanup(); }
  });

  it('leaves a refusal without the mark to the error policy', async () => {
    try {
      let live: Level = 'high';
      const errorPolicy = new RecordingPolicy();
      const provider = new Provider();
      const { turn, exhausted } = await resident({ effort: () => live, provider, errorPolicy });
      await turn('One.');
      live = 'low';
      provider.fail = (request) => (effortRows(request).length > 0 && provider.calls.length === 2 ? refusal(false) : undefined);
      await turn('Two.');
      assert.equal(provider.calls.length, 2, 'no retry at once');
      assert.equal(errorPolicy.asked.length, 1, 'the policy was asked');
      assert.equal(exhausted.length, 1);
      await turn('Three.');
      assert.deepEqual(effortRows(provider.calls[2]!).map((r) => r.effort), ['low'], 'rows go on');
    } finally { await cleanup(); }
  });

  it('leaves a marked refusal of a request carrying no row to the error policy', async () => {
    try {
      const errorPolicy = new RecordingPolicy();
      const provider = new Provider();
      provider.fail = () => (provider.calls.length === 1 ? refusal(true) : undefined);
      const { turn, exhausted } = await resident({ effort: 'high', provider, errorPolicy });
      await turn('One.');
      assert.equal(provider.calls.length, 1);
      assert.equal(errorPolicy.asked.length, 1);
      assert.equal(exhausted.length, 1);
    } finally { await cleanup(); }
  });

  it('stores a row once: a retry of the turn that wrote it carries the same row', async () => {
    try {
      let live: Level = 'high';
      let failures = 1;
      const errorPolicy = new RecordingPolicy(() => ({ retry: true, delayMs: 0 }));
      const provider = new Provider();
      const { framework, turn } = await resident({ effort: () => live, provider, errorPolicy });
      await turn('One.');
      live = 'low';
      provider.fail = () => (provider.calls.length === 2 && failures-- > 0
        ? new MembraneError({ type: 'server', retryable: true, httpStatus: 529, message: 'overloaded_error', rawError: undefined } as never)
        : undefined);
      await turn('Two.');
      assert.equal(provider.calls.length, 3, 'the failed request and its retry');
      assert.deepEqual(effortRows(provider.calls[2]!).map((r) => r.effort), ['low']);
      assert.equal(storedEffortRows(framework).length, 1);
    } finally { await cleanup(); }
  });
});

describe('FrameworkConfig.effort: previews and the direct API', { skip: NEEDS_ROWS }, () => {
  it('previews the row a start would write, unstored, under the base', async () => {
    try {
      let live: Level = 'high';
      const { framework, turn } = await resident({ effort: () => live });
      await turn('One.');
      live = 'low';
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'Two.', metadata: { quiet: true } } as never);
      await framework.runUntilIdle();
      const preview = await framework.previewActivation('agent');
      assert.ok(indexOfText(preview, 'Two.') >= 0, 'premise: the preview holds the new input');
      assert.equal(topLevel(preview), 'high');
      assert.deepEqual(effortRows(preview).map((r) => r.effort), ['low']);
      assert.equal(effortRows(preview)[0]!.at, preview.messages.length - 1, 'last, after the input');
      assert.equal(storedEffortRows(framework).length, 0, 'nothing stored');
    } finally { await cleanup(); }
  });

  it('sends a direct call what a turn would carry, writing no row and recording no base', async () => {
    try {
      let live: Level | undefined = 'high';
      const { framework, provider, turn } = await resident({ effort: () => live });
      const agent = framework.getAgent('agent')!;
      const direct = async () => {
        const before = provider.calls.length;
        await agent.runInference([]);
        return provider.calls.slice(before).at(-1)!;
      };
      live = 'medium';
      agent.getContextManager().addMessage('User', [{ type: 'text', text: 'Zero.' }]);
      assert.equal(topLevel(await direct()), 'medium');
      live = 'high';
      await turn('One.');
      assert.equal(topLevel(provider.calls.at(-1)!), 'high', 'the turn started the base, not the direct call');
      live = 'low';
      await turn('Two.');
      const sent = await direct();
      assert.equal(topLevel(sent), 'high');
      assert.deepEqual(effortRows(sent).map((r) => r.effort), ['low']);
      assert.equal(storedEffortRows(framework).length, 1, 'no row written');
      live = undefined;
      const none = await direct();
      assert.equal(topLevel(none), undefined);
      assert.deepEqual(effortRows(none), []);
    } finally { await cleanup(); }
  });
});

describe('FrameworkConfig.effort: the thinking binding', () => {
  it('leaves effort out of the identity: a stored reply keeps its thinking after the switch to FrameworkConfig.effort', async () => {
    try {
      const dir = mkdtempSync(join(tmpdir(), 'af-effort-binding-'));
      dirs.push(dir);
      const SIG = 'sig-earlier'.repeat(12);
      const agent = { thinking: { enabled: true, budgetTokens: 1024 }, thinkingBinding: { binds: true, dropBlock: true } };
      const signed = (request: NormalizedRequest) => request.messages.some((m) =>
        m.content.some((b) => (b as { signature?: unknown }).signature === SIG));
      const before = await resident({ dir, agent });
      const cm = before.framework.getAgent('agent')!.getContextManager();
      cm.addMessage('User', [{ type: 'text', text: 'Earlier.' }]);
      cm.addMessage('agent', [{ type: 'thinking', thinking: '', signature: SIG } as ContentBlock, { type: 'text', text: 'Earlier reply.' }]);
      await before.turn('One.');
      assert.ok(signed(before.provider.calls[0]!), 'premise: sent with its thinking before the switch');
      await before.stop();
      let live: Level = 'high';
      const after = await resident({ dir, agent, effort: () => live });
      await after.turn('Two.');
      live = 'low';
      await after.turn('Three.');
      assert.deepEqual(after.provider.calls.map(signed), [true, true], 'the stored reply keeps its thinking');
    } finally { await cleanup(); }
  });
});

describe('the history tool and effort rows', () => {
  it('labels an effort row by what it does, and any other system change as before', async () => {
    try {
      const { framework, turn } = await resident({ effort: 'high' });
      await turn('One.');
      const cm = framework.getAgent('agent')!.getContextManager();
      cm.addMessage('system', [effortBlock('low')]);
      cm.addMessage('system', [{ type: 'system_change', addSystem: ['Be brief.'] } as unknown as ContentBlock]);
      const history = new HistoryModule();
      history.bind(cm);
      const result = await history.handleToolCall({ id: 't', name: 'extract', input: { limit: 10 } } as ToolCall);
      assert.equal(result.success, true, result.error);
      const contents = ((result.data as { messages: Array<{ content?: string; text?: string }> }).messages)
        .map((m) => String(m.content ?? m.text));
      assert.ok(contents.some((c) => c.includes('[effort: low from here]')), contents.join(' | '));
      assert.ok(contents.some((c) => c.includes('[system_change]')), contents.join(' | '));
    } finally { await cleanup(); }
  });
});


describe('FrameworkConfig.effort: two agents on one store', { skip: NEEDS_ROWS }, () => {
  async function pair() {
    const dir = mkdtempSync(join(tmpdir(), 'af-effort-two-'));
    dirs.push(dir);
    const provider = new Provider();
    const live: Record<string, Level> = { alpha: 'high', beta: 'high' };
    const framework = await AgentFramework.create({
      storePath: join(dir, 'store.chronicle'), membrane: provider.asMembrane(),
      agents: ['alpha', 'beta'].map((name) => ({ name, model: 'claude-opus-5-5', systemPrompt: 'test', proseRouting: 'disabled' })),
      modules: [new InputModule()], syncIntervalMs: 0, maintenanceIntervalMs: 0,
      effort: (agent: { name: string }) => live[agent.name],
    } as never);
    frameworks.push(framework);
    const ended: TraceEvent[] = [];
    framework.onTrace((event) => { if (event.type === 'inference:completed' || event.type === 'inference:exhausted') ended.push(event); });
    framework.start();
    const turn = async (to: string, text: string) => {
      const before = ended.length;
      framework.pushEvent({ type: 'external-message', source: 'test', content: text, metadata: { to } } as never);
      await framework.runUntilIdle();
      for (const until = Date.now() + 10_000; ended.length === before && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
      assert.ok(ended.length > before, `${to}'s turn for "${text}" ended`);
    };
    const last = (agent: string) => provider.calls.filter((r) => r.assistantParticipant === agent).at(-1)!;
    return { provider, live, turn, last };
  }

  it('sends an agent only its own effort rows, and reads its own as in force', async () => {
    try {
      const { live, turn, last } = await pair();
      await turn('alpha', 'One.');
      await turn('beta', 'Two.');
      live.alpha = 'low';
      await turn('alpha', 'Three.');
      assert.deepEqual(effortRows(last('alpha')).map((r) => r.effort), ['low'], 'premise: alpha wrote its row');
      await turn('beta', 'Four.');
      assert.ok(indexOfText(last('beta'), 'Four.') >= 0, 'premise: beta\'s request carries its input');
      assert.deepEqual(effortRows(last('beta')), [], 'beta is sent none of alpha\'s rows, and writes none of its own');
      assert.equal(topLevel(last('beta')), 'high');
    } finally { await cleanup(); }
  });

  it('keeps sending another agent\'s rows on the same model after one agent\'s rows are refused', async () => {
    try {
      const { provider, live, turn, last } = await pair();
      provider.fail = (request) => (request.assistantParticipant === 'alpha' && effortRows(request).length > 0 ? refusal(true) : undefined);
      await turn('alpha', 'One.');
      await turn('beta', 'Two.');
      live.alpha = 'low';
      await turn('alpha', 'Three.');
      assert.deepEqual(effortRows(last('alpha')), [], 'premise: alpha\'s rows were refused, and its retry carries none');
      assert.equal(topLevel(last('alpha')), 'low');
      live.beta = 'low';
      await turn('beta', 'Four.');
      assert.deepEqual(effortRows(last('beta')).map((r) => r.effort), ['low'], 'beta still sends its row');
      assert.equal(topLevel(last('beta')), 'high', 'under its base');
    } finally { await cleanup(); }
  });
});
