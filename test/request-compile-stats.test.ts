/**
 * A preview's request carries the render stats of the dry compile that built
 * it (`getRequestCompileStats`), so a host can show what the next request
 * would hold, by kind, without sending it (connectome-host#425). The stats
 * read back for a request are that compile's, whatever was compiled since.
 * Needs context-manager 0.20.1 or later, whose compiles carry render stats,
 * and is skipped with 0.20.0, which agent-framework's range allows; with
 * 0.20.0, the last test checks that a preview's stats are null instead.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, KnowledgeStrategy, PassthroughStrategy, type CompileResult, type ContextManager } from '@animalabs/context-manager';
import { AgentFramework, type Module } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** A module whose gatherContext gives one injection, as a preview with
 *  `injections: true` gathers it. */
class Injecting implements Module {
  readonly name = 'injecting';
  async start() {}
  async stop() {}
  getTools() { return []; }
  async handleToolCall() { return { success: false, isError: true, error: 'no tools' }; }
  async onProcess() { return {}; }
  async gatherContext() {
    return [{ namespace: 'injecting', position: 'beforeUser' as const, content: [{ type: 'text' as const, text: 'gathered context' }] }];
  }
}

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'request-compile-stats-'));
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: new MockMembrane().asMembrane(),
    agents: [
      { name: 'agent', model: 'test-model', systemPrompt: 'test', strategy: new AutobiographicalStrategy() },
      { name: 'plain', model: 'test-model', systemPrompt: 'test', strategy: new PassthroughStrategy() },
      { name: 'knowing', model: 'test-model', systemPrompt: 'test', strategy: new KnowledgeStrategy() },
    ],
    modules: [new Injecting()],
  });
  return {
    framework,
    async close() { await framework.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A compile's result, with context-manager 0.20.1's `renderStats` read
 *  structurally, as `agent.ts` reads it. */
type Compiled = CompileResult & { renderStats?: unknown };

/** Every result `cm.compile` returns, in order. */
function recordResults(cm: ContextManager): Compiled[] {
  const results: Compiled[] = [];
  const original = cm.compile.bind(cm);
  (cm as unknown as { compile: (...args: unknown[]) => Promise<CompileResult> }).compile = async (...args: unknown[]) => {
    const result = await (original as (...a: unknown[]) => Promise<CompileResult>)(...args);
    results.push(result);
    return result;
  };
  return results;
}

const say = (cm: ContextManager, participant: string, text: string) => cm.addMessage(participant, [{ type: 'text', text }]);

/** What a select chose, by bucket: the stats without the parts that can
 *  differ between two compiles of the same selection, such as a plan's
 *  timings. */
const chosen = (s: NonNullable<ReturnType<AgentFramework['getRequestCompileStats']>>) =>
  ({ head: s.head, tail: s.tail, middleRaw: s.middleRaw, summaries: s.summaries, total: s.total });

/** The installed context-manager's version, from its own package.json. */
function contextManagerVersion(): string {
  let dir = new URL('.', import.meta.resolve('@animalabs/context-manager'));
  for (;;) {
    const file = new URL('package.json', dir);
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version: string };
      if (pkg.name === '@animalabs/context-manager') return pkg.version;
    }
    const up = new URL('..', dir);
    if (up.href === dir.href) throw new Error('found no package.json for @animalabs/context-manager');
    dir = up;
  }
}

// 0.20.0 is the one version agent-framework's range allows whose compiles
// carry no render stats. Every other version runs these tests, so one that
// stops carrying them fails here rather than being skipped.
describe('the render stats of the dry compile behind a preview', {
  skip: contextManagerVersion() === '0.20.0' ? 'needs context-manager 0.20.1, whose compiles carry render stats' : false,
}, () => {
  it('are the ones the compile that built each request returned, and a later preview or live compile leaves an earlier request\'s alone', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      const cm = agent.getContextManager();
      const results = recordResults(cm);
      say(cm, 'user', 'the first thing said');
      const first = await x.framework.previewActivation('agent');
      const firstStats = x.framework.getRequestCompileStats(first);
      assert.ok(firstStats, 'the autobiographical strategy records stats for a dry compile');
      assert.equal(firstStats, results[0]!.renderStats, "the first request's are its own compile's");
      const asRead = structuredClone(firstStats);

      say(cm, 'agent', 'an answer');
      say(cm, 'user', 'and something more');
      const second = await x.framework.previewActivation('agent');
      const secondStats = x.framework.getRequestCompileStats(second);
      assert.equal(secondStats, results[1]!.renderStats, "the second request's are its own compile's");
      assert.ok(secondStats!.total.messages > asRead.total.messages, 'setup: the second compile selected more than the first');

      // A live compile, as a turn's request makes it, between the preview and the read.
      say(cm, 'agent', 'a later answer');
      await agent.buildActivationRequest([]);
      assert.ok(results[2]!.renderStats, 'setup: the live compile has stats of its own');

      assert.equal(x.framework.getRequestCompileStats(first), firstStats, 'the first request still reads its own compile\'s stats');
      assert.deepEqual(firstStats, asRead, 'and the later preview and live compile left them as they were');

      // previewActivation's other path, which gathers injections first.
      const gathering = await x.framework.previewActivation('agent', { injections: true });
      assert.ok(results[3]!.renderStats, 'setup: the gathering preview\'s compile has stats');
      assert.equal(x.framework.getRequestCompileStats(gathering), results[3]!.renderStats, "a preview that gathers injections reads back its own compile's");
    } finally { await x.close(); }
  });

  it('are null for a request built to be sent, an object no compile built, and an agent whose strategy records none', async () => {
    const x = await make();
    try {
      const agent = x.framework.getAgent('agent')!;
      say(agent.getContextManager(), 'user', 'something to compile');
      const results = recordResults(agent.getContextManager());
      // buildActivationRequest without dryRun runs the assembly a sent
      // request goes through, with a live compile: its stats exist, and the
      // accessor keeps none for it.
      const sent = await agent.buildActivationRequest([]);
      assert.ok(results[0]!.renderStats, 'setup: the sent compile has stats of its own');
      assert.equal(x.framework.getRequestCompileStats(sent), null);
      assert.equal(x.framework.getRequestCompileStats({}), null);

      const plain = x.framework.getAgent('plain')!.getContextManager();
      say(plain, 'user', 'something to compile');
      const plainResults = recordResults(plain);
      const plainPreview = await x.framework.previewActivation('plain');
      assert.equal(plainResults.length, 1, 'setup: the passthrough preview compiled');
      assert.equal(plainResults[0]!.renderStats, undefined, 'setup: a passthrough compile carries no stats');
      assert.equal(x.framework.getRequestCompileStats(plainPreview), null);
    } finally { await x.close(); }
  });

  it('count what the select chose: not the injections or turns added after it, but a message the agent drops after it', async () => {
    const x = await make();
    try {
      const cm = x.framework.getAgent('agent')!.getContextManager();
      say(cm, 'user', 'a question');
      const before = await x.framework.previewActivation('agent');
      const beforeStats = x.framework.getRequestCompileStats(before)!;

      // Context-manager merges gathered injections in after its select.
      const gathering = await x.framework.previewActivation('agent', { injections: true });
      assert.ok(JSON.stringify(gathering.messages).includes('gathered context'), 'setup: the injection reached the request');
      assert.deepEqual(chosen(x.framework.getRequestCompileStats(gathering)!), chosen(beforeStats), 'the injection is not counted');

      // The agent drops a message left holding only blank text after the compile.
      say(cm, 'user', '   ');
      const blank = await x.framework.previewActivation('agent');
      assert.equal(blank.messages.length, before.messages.length, 'setup: the agent dropped the blank message');
      assert.equal(x.framework.getRequestCompileStats(blank)!.total.messages, beforeStats.total.messages + 1, 'the dropped message is counted');

      // A request that would end on the agent's own message gets a [Continue] turn after the compile.
      say(cm, 'agent', 'an answer');
      const continued = await x.framework.previewActivation('agent');
      assert.equal(continued.messages.length, blank.messages.length + 2, 'setup: the answer and a [Continue] turn');
      assert.equal(x.framework.getRequestCompileStats(continued)!.total.messages, beforeStats.total.messages + 2, 'the answer is counted and [Continue] is not');
    } finally { await x.close(); }
  });

  it('come from the knowledge strategy too, which records them as the autobiographical one it extends does', async () => {
    const x = await make();
    try {
      const cm = x.framework.getAgent('knowing')!.getContextManager();
      say(cm, 'user', 'something to compile');
      const results = recordResults(cm);
      const preview = await x.framework.previewActivation('knowing');
      assert.ok(results[0]!.renderStats, 'setup: the knowledge strategy\'s compile has stats');
      assert.equal(x.framework.getRequestCompileStats(preview), results[0]!.renderStats);
    } finally { await x.close(); }
  });
});

describe('the render stats behind a preview, with context-manager 0.20.0', {
  skip: contextManagerVersion() === '0.20.0' ? false : 'runs only with context-manager 0.20.0, which CI does not install',
}, () => {
  it('are null, since its compiles carry none', async () => {
    const x = await make();
    try {
      const cm = x.framework.getAgent('agent')!.getContextManager();
      say(cm, 'user', 'something to compile');
      const results = recordResults(cm);
      const preview = await x.framework.previewActivation('agent');
      assert.equal(results.length, 1, 'setup: the preview compiled');
      assert.equal(results[0]!.renderStats, undefined, 'setup: the compile carries no stats');
      assert.equal(x.framework.getRequestCompileStats(preview), null);
    } finally { await x.close(); }
  });
});
