import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedMessage, ToolDefinition } from '@animalabs/membrane';

import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import { AgentFramework, isSystemChangeMessage, systemChangeMetadata, taskForkSpec, type Agent, type AgentSpec, type ToolCall } from '../src/index.js';
import { HistoryModule } from '../src/modules/history/index.js';
import type { TraceEvent } from '../src/types/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const tool = (name: string): ToolDefinition => ({
  name,
  description: `${name} does a thing`,
  inputSchema: { type: 'object', properties: {} },
});

const resident = (name: string) => ({
  name,
  model: 'test-model',
  systemPrompt: `You are ${name}.`,
  toolDeclarations: 'entries' as const,
});

const isChange = (m: { content: readonly unknown[] }) => m.content.some((b) => (b as { type?: string }).type === 'system_change');
const changesIn = (messages: readonly NormalizedMessage[]) => messages.filter(isChange).map((m) => m.content);
const storedChanges = (agent: Agent, owner: string) =>
  agent.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: owner } }).messages.length;

async function withFramework<T>(
  agents: Array<Record<string, unknown>>,
  run: (framework: AgentFramework, storePath: string) => Promise<T>,
  storePath?: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const tempDir = storePath ? undefined : mkdtempSync(join(tmpdir(), 'tool-declarations-'));
  const path = storePath ?? join(tempDir!, 'store.chronicle');
  const framework = await AgentFramework.create({
    storePath: path,
    membrane: new MockMembrane().asMembrane(),
    agents,
    modules: [],
    syncIntervalMs: 0,
    ...extra,
  } as never);
  try {
    return await run(framework, path);
  } finally {
    await framework.stop();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

type Assembling = {
  assembleActivationRequest(tools: ToolDefinition[]): Promise<{
    request: { messages: NormalizedMessage[] };
    compiled: { provenance?: { compileId?: string } };
    binding: { identity?: unknown };
  }>;
};

const store = (framework: AgentFramework, agent: Agent, participant: string, content: ContentBlock[], metadata?: unknown) => {
  const id = agent.getContextManager().addMessage(participant, content, metadata as never);
  (framework as unknown as { presentation: { afterStore(agent: Agent, ids: unknown[]): void } }).presentation.afterStore(agent, [id]);
  return id;
};
const say = (framework: AgentFramework, agent: Agent, participant: string, text: string) =>
  store(framework, agent, participant, [{ type: 'text', text } as ContentBlock]);
const adopt = (framework: AgentFramework, agent: Agent) => (framework as unknown as { adoptPresentation(agent: Agent): void }).adoptPresentation(agent);

describe('toolDeclarations in the framework', () => {
  it('keeps each resident\'s system changes its own in the slot they share, and traces them', async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      say(framework, alpha, 'user', 'hello, both');
      await alpha.buildActivationRequest([tool('a')]);
      await beta.buildActivationRequest([tool('x')]);

      const alphaRequest = await alpha.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(changesIn(alphaRequest.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]]);
      const betaRequest = await beta.buildActivationRequest([tool('x')]);
      assert.deepEqual(changesIn(betaRequest.messages), [], "beta doesn't read alpha's change as its own");
      assert.deepEqual(betaRequest.tools, [tool('x')]);
      assert.deepEqual(changesIn((await alpha.buildActivationRequest([tool('a'), tool('b')])).messages).length, 1, 'nor appends a correction alpha would read');

      const heads = traces.filter((t) => t.type === 'head:declared' || t.type === 'head:moved')
        .map((t) => ({ type: t.type, agentName: (t as { agentName: string }).agentName }));
      assert.deepEqual(heads, [
        { type: 'head:moved', agentName: 'alpha' },
        { type: 'head:moved', agentName: 'beta' },
        { type: 'head:declared', agentName: 'alpha' },
      ]);
    });
  });

  it("leaves a resident's change row out of a co-resident's window, as another agent's own row", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const [row] = alpha.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: 'alpha' } }).messages;
      assert.ok(row, "the premise: alpha's change row is stored");
      assert.ok(beta.getContextManager().getPresentedMessages().some((m) => (m.content[0] as { text?: string }).text === 'hello'), "the premise: beta's window holds the slot's conversation");
      assert.equal(alpha.getContextManager().windowStatusOf(row!.id), 'in', "alpha's window holds its own change");
      assert.notEqual(beta.getContextManager().windowStatusOf(row!.id), 'in', "and beta's leaves it out");
    });
  });

  it("takes a resident's change row out of the window of a resident that observes it, when a move of its head removes it, traced as `head-moved`", async () => {
    await withFramework([resident('alpha'), { ...resident('beta'), observes: ['alpha'] }], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
      const [row] = alpha.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: 'alpha' } }).messages;
      assert.ok(row, "the premise: alpha's change row is stored");
      assert.equal(beta.getContextManager().windowStatusOf(row!.id), 'in', 'the premise: beta, which observes alpha, is shown it');
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
      assert.equal(storedChanges(alpha, 'alpha'), 0, "the premise: the replacement moved alpha's head and took the row out");
      assert.equal(beta.getContextManager().ordinalOf(row!.id), undefined, "beta's window lets it go");
      const retracted = traces.filter((t) => t.type === 'presentation:retracted' && (t as { agentName: string }).agentName === 'beta') as unknown as Array<{ reason: string; messageIds: string[] }>;
      assert.deepEqual(retracted.map((t) => [t.reason, t.messageIds]), [['head-moved', [row!.id]]]);
    });
  });

  it('keeps a resident\'s recorded head across a restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-declarations-restart-'));
    const storePath = join(tempDir, 'store.chronicle');
    try {
      let before: NormalizedMessage[] = [];
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        before = (await alpha.buildActivationRequest([tool('a'), tool('b')])).messages;
      }, storePath);
      await withFramework([resident('alpha')], async (framework) => {
        const request = await framework.getAgent('alpha')!.buildActivationRequest([tool('b'), tool('a')]);
        assert.deepEqual(request.tools, [tool('a')], 'the head recorded before the restart');
        assert.deepEqual(changesIn(request.messages), changesIn(before), 'and no new change');
      }, storePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("counts host /undo N in the conversation's messages, taking a change among them with them", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'one');
      await alpha.buildActivationRequest([tool('a')]);
      say(framework, alpha, 'alpha', 'two');
      say(framework, alpha, 'user', 'three');
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      say(framework, alpha, 'alpha', 'four');
      const host = framework as unknown as { handleHostCommand(server: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> };
      const tooMany = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 4 });
      assert.match(tooMany.error ?? '', /history has 4;/, 'the conversation\'s four messages, the change uncounted');
      const result = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 2 }) as { ok: boolean; error?: string; messagesRemoved?: number };
      assert.equal(result.ok, true, result.error);
      assert.equal(result.messagesRemoved, 2, 'two messages, as asked');
      const left = alpha.getContextManager().getAllMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.deepEqual(left, ['one', 'two'], 'three and four went, and the change between them');
    });
  });

  it('raises an operator line when the changes force the head to move, naming the thinking it sets aside as `binds` says', async () => {
    const hasThinking = (messages: readonly NormalizedMessage[]) => messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking'));
    for (const [binding, clause] of [
      [undefined, /: one whole write, and the thinking the request held set aside if its model binds it$/],
      [{ binds: true, dropBlock: true }, /: one whole write, and the thinking the request held set aside$/],
    ] as const) {
      await withFramework([{ ...resident('alpha'), ...(binding ? { thinkingBinding: binding } : {}) }], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        store(framework, alpha, 'alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
        await alpha.buildActivationRequest([tool('a')]);
        const declared = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.ok(hasThinking(declared.messages), `${JSON.stringify(binding)}: a declared change keeps the thinking before it`);
        alpha.noteResponseInput(10);
        const request = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools?.map((t) => t.name), ['a', 'b'], 'past a fifth, the head moved');
        assert.equal(hasThinking(request.messages), !binding, `${JSON.stringify(binding)}: with binds, the compile for the new head leaves the thinking out`);
        const moved = traces.filter((t) => t.type === 'head:moved' && (t as { why: string }).why === 'consolidated');
        assert.equal(moved.length, 1);
        assert.equal((moved[0] as { forced?: string }).forced, 'share');
        const alerts = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-consolidated') as { message: string; data?: { inputTokens?: number; forced?: string } }[];
        assert.equal(alerts.length, 1);
        assert.match(alerts[0]!.message, /a fifth of the last response's 10/);
        assert.match(alerts[0]!.message, clause);
        assert.equal(alerts[0]!.data?.inputTokens, 10);
        assert.equal(alerts[0]!.data?.forced, 'share');
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
      });
    }
  });

  it("raises an operator line for a move forced by the budget, and names no thinking for a model whose `binds` is false", async () => {
    for (const [binding, clause] of [[{ binds: false }, /: one whole write$/], [undefined, /set aside if its model binds it$/]] as const) {
      await withFramework([{ ...resident('alpha'), ...(binding ? { thinkingBinding: binding } : {}) }], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        alpha.noteResponseInput(10);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        const share = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-consolidated') as { message: string }[];
        assert.equal(share.length, 1, `${JSON.stringify(binding)}: forced by its share`);
        assert.match(share[0]!.message, clause, JSON.stringify(binding));
      });
    }
    await withFramework([resident('alpha')], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      (alpha as unknown as { onHeadEvent(e: unknown): void }).onHeadEvent({ type: 'head:moved', why: 'consolidated', changesRemoved: 2, forced: 'budget' });
      const alerts = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-consolidated') as { message: string; data?: Record<string, unknown> }[];
      assert.equal(alerts.length, 1);
      assert.match(alerts[0]!.message, /^a compile was refused over budget, or for dropping messages no summary covers, with 2 system changes kept, so the head took them and the compile ran again: one whole write/);
      assert.deepEqual(alerts[0]!.data, { forced: 'budget', changesRemoved: 2 });
    });
  });

  it("builds a declared change's request from the compile that wrote the record, so a note under it is taken, with `binds: true`", async () => {
    await withFramework([{ ...resident('alpha'), thinkingBinding: { binds: true, dropBlock: true } }], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      const assembled = await (alpha as unknown as Assembling).assembleActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(changesIn(assembled.request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'declared');
      assert.equal(alpha.getContextManager().noteRequestSent([], assembled.binding.identity as never, assembled.compiled.provenance!.compileId!), true,
        'a note under its compile is taken: that compile wrote the record');
    });
  });

  it("takes the agent's record and its own change rows out once it's built again on the head, and a reply after keeps its thinking, with `binds: true`", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-declarations-onhead-'));
    const storePath = join(tempDir, 'store.chronicle');
    const binding = { binds: true, dropBlock: true };
    try {
      await withFramework([{ ...resident('alpha'), thinkingBinding: binding }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.equal(storedChanges(alpha, 'alpha'), 1, 'the premise: its change row is stored');
      }, storePath);
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head', thinkingBinding: binding }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        const heads = framework as unknown as { headDeclarations: { read(name: string): unknown } };
        assert.ok(heads.headDeclarations.read('alpha'), "the premise: its record from the 'entries' period");
        const assembled = await (alpha as unknown as Assembling).assembleActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(assembled.request.messages), []);
        const cm = alpha.getContextManager();
        assert.equal(cm.getAllMessages().filter(isChange).length, 0, 'the change row went');
        assert.equal(heads.headDeclarations.read('alpha'), null, 'and its record');
        const reply = store(framework, alpha, 'alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
        assert.equal(cm.noteRequestSent([reply], assembled.binding.identity as never, assembled.compiled.provenance!.compileId!), true);
        const next = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.ok(next.messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking')), 'the reply keeps its thinking at the next compile');
      }, storePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("compiles again on the head once it takes its own change rows out, kept to its head after a refusal, so a reply after keeps its thinking, with `binds: true`", async () => {
    await withFramework([{ ...resident('alpha'), thinkingBinding: { binds: true, dropBlock: true } }], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      assert.equal(storedChanges(alpha, 'alpha'), 1, 'the premise: its change row is stored');
      alpha.keepToHeadUntilBuiltAgain();
      const assembled = await (alpha as unknown as Assembling).assembleActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(changesIn(assembled.request.messages), []);
      const cm = alpha.getContextManager();
      assert.equal(cm.getAllMessages().filter(isChange).length, 0, 'its change row went');
      const reply = store(framework, alpha, 'alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
      assert.equal(cm.noteRequestSent([reply], assembled.binding.identity as never, assembled.compiled.provenance!.compileId!), true);
      const next = await alpha.buildActivationRequest([tool('a'), tool('b')]);
      assert.ok(next.messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking')), 'the reply keeps its thinking at the next compile');
    });
  });

  it('leaves out the thinking a replacement of the head sets aside, with `binds: true`, and keeps it past a declared change', async () => {
    const hasThinking = (messages: readonly NormalizedMessage[]) => messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking'));
    await withFramework([{ ...resident('alpha'), thinkingBinding: { binds: true, dropBlock: true } }], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello');
      store(framework, alpha, 'alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
      say(framework, alpha, 'user', 'and then');
      assert.ok(hasThinking((await alpha.buildActivationRequest([tool('a')], system('v1'))).messages), 'adopted');
      assert.ok(hasThinking((await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'))).messages), 'a declared change');
      const replaced = await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
      assert.equal(replaced.system, 'You are alpha.\nv2', 'the head moved');
      assert.equal(hasThinking(replaced.messages), false, 'and the compile for it left the thinking out');
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
    });
  });

  describe("an agent's own change rows", () => {
    it("include those stamped with one of its selfParticipants: its view keeps one and its head counts it as declared", async () => {
      await withFramework([{ ...resident('alpha'), selfParticipants: ['alpha-old'] }], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        store(framework, alpha, 'system', [{ type: 'system_change', defineTools: [tool('b')] }] as never, systemChangeMetadata('alpha-old') as never);
        const request = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'the change goes out once');
        assert.equal(alpha.getContextManager().getAllMessages().filter((m) => isSystemChangeMessage(m)).length, 1, 'and nothing is declared again');
        assert.deepEqual(traces.filter((t) => t.type === 'head:declared'), [], 'no declaration');
      });
    });

    it("are stamped with change metadata: a host's change row whose metadata names an agent but isn't change metadata stays in every resident's view", async () => {
      await withFramework([resident('alpha'), resident('beta')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        store(framework, alpha, 'system', [{ type: 'system_change', defineTools: [tool('h')] }] as never, { agent: 'beta' } as never);
        for (const name of ['alpha', 'beta']) {
          const compiled = await framework.getAgent(name)!.getContextManager().compile(undefined, undefined, { dryRun: true });
          assert.deepEqual(changesIn(compiled.messages), [[{ type: 'system_change', defineTools: [tool('h')] }]], `in ${name}'s view`);
        }
      });
    });
  });

  describe("an ephemeral agent that continues another's context", () => {
    const inheriting = (name: string, parent: string): Omit<AgentSpec, 'name'> => {
      const { name: _name, ...spec } = taskForkSpec(name, { parent });
      return spec;
    };
    async function forked(framework: AgentFramework, parentConfig: Record<string, unknown>, spec: Omit<AgentSpec, 'name'> | undefined, name: string) {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const { messages } = await alpha.getContextManager().compile(undefined, undefined, { dryRun: true });
      const { agent: child } = await framework.createEphemeralAgent({ ...resident(name), systemPrompt: 'You are alpha.', ...parentConfig } as never, spec);
      for (const m of messages) {
        if (isSystemChangeMessage(m)) store(framework, child, m.participant, m.content, systemChangeMetadata(name) as never);
        else store(framework, child, m.participant, m.content);
      }
      adopt(framework, child);
      return { alpha, child };
    }

    it("starts the child on its parent's head, so its first request carries the parent's prefix and declares nothing", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const { child } = await forked(framework, {}, inheriting('alpha-child', 'alpha'), 'alpha-child');
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], "the parent's recorded head");
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], "and the parent's change, once");
        assert.deepEqual(traces.filter((t) => (t as { agentName?: string }).agentName === 'alpha-child' && t.type.startsWith('head:')), [], 'no adoption, no declaration');
      });
    });

    it("takes its parent's change off a host's shared child's branch once the child moves to a head of its own", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        const { name: _name, ...spec } = taskForkSpec('host-child', { parent: 'alpha', inherit: { mode: 'shared' } });
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('host-child'), systemPrompt: 'You are the child.' } as never, spec);
        assert.equal(storedChanges(child, 'alpha'), 1, "the premise: the child's branch holds its parent's change");
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('c')]);
        assert.deepEqual(request.tools, [tool('c')], 'its own head');
        assert.deepEqual(changesIn(request.messages), [], "and none of its parent's declarations");
        assert.equal(storedChanges(child, 'alpha'), 0, "taken off the child's branch");
        assert.equal(storedChanges(alpha, 'alpha'), 1, "and the parent's own context as it was");
      });
    });

    it("declares to a host's shared child on its parent's head what its parent's change rows say that it doesn't hold, in both directions", async () => {
      const readTools = (request: { tools?: ToolDefinition[]; messages: readonly NormalizedMessage[] }) => {
        const names = new Set((request.tools ?? []).map((t) => t.name));
        for (const block of request.messages.flatMap((m) => m.content) as Array<{ type: string; removeTools?: string[]; defineTools?: ToolDefinition[] }>) {
          if (block.type !== 'system_change') continue;
          for (const name of block.removeTools ?? []) names.delete(name);
          for (const t of block.defineTools ?? []) names.add(t.name);
        }
        return [...names].sort();
      };
      for (const [parentTools, childTools] of [[[tool('a'), tool('b')], [tool('a')]], [[tool('a')], [tool('a'), tool('b')]]] as const) {
        await withFramework([resident('alpha')], async (framework) => {
          const alpha = framework.getAgent('alpha')!;
          say(framework, alpha, 'user', 'hello');
          await alpha.buildActivationRequest([...childTools]);
          await alpha.buildActivationRequest([...parentTools]);
          assert.equal(storedChanges(alpha, 'alpha'), 1, "the premise: the parent's change is stored");
          const { name: _name, ...spec } = taskForkSpec('host-child', { parent: 'alpha', inherit: { mode: 'shared' } });
          const { agent: child } = await framework.createEphemeralAgent({ ...resident('host-child'), systemPrompt: 'You are alpha.' } as never, spec);
          adopt(framework, child);
          const request = await child.buildActivationRequest([...childTools]);
          assert.deepEqual(readTools(request), childTools.map((t) => t.name).sort(), `with ${parentTools.length} tools on its parent's branch, the model reads the child's own`);
        });
      }
    });

    it("shows none of its parent's change rows in a dry move of a host's shared child to a head of its own", async () => {
      await withFramework([{ ...resident('alpha'), selfParticipants: ['alpha-old'] }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        store(framework, alpha, 'system', [{ type: 'system_change', defineTools: [tool('o')] }] as never, systemChangeMetadata('alpha-old') as never);
        const { name: _name, ...spec } = taskForkSpec('host-child', { parent: 'alpha', inherit: { mode: 'shared' } });
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('host-child'), systemPrompt: 'You are the child.' } as never, spec);
        assert.equal(storedChanges(child, 'alpha') + storedChanges(child, 'alpha-old'), 2, "the premise: the child's branch holds both of its parent's rows");
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('c')], undefined, undefined, undefined, { dryRun: true });
        assert.deepEqual(changesIn(request.messages), [], "none of its parent's rows, under either of its names");
        assert.equal(storedChanges(child, 'alpha') + storedChanges(child, 'alpha-old'), 2, 'and a dry run stores nothing');
      });
    });

    it("sends its parent's added block once to a host's shared child at a checkpoint (atSequence) with its parent's prompt, tools and block", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        const block = { namespace: 'module', position: 'system' as const, content: [{ type: 'text' as const, text: 'ALPHA ADDED BLOCK' }] };
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a')], [block]);
        const [row] = alpha.getContextManager().queryMessages({ metadata: { kind: 'system-change', agent: 'alpha' } }).messages;
        assert.ok(row, "the premise: alpha's added block is a change row");
        const atSequence = alpha.getContextManager().getMessage(row!.id)!.sequence;
        const { name: _name, ...spec } = taskForkSpec('checkpoint-child', { parent: 'alpha', inherit: { mode: 'shared', atSequence } });
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('checkpoint-child'), systemPrompt: 'You are alpha.' } as never, spec);
        assert.equal(storedChanges(child, 'alpha'), 1, "the premise: the child's branch holds its parent's change");
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('a')], [block]);
        assert.equal(JSON.stringify({ system: request.system, messages: request.messages }).split('ALPHA ADDED BLOCK').length - 1, 1, 'the block goes out once');
        assert.equal(storedChanges(child, 'alpha'), 0, "its adoption took its parent's change off its branch");
      });
    });

    it("carries its parent's change once in a host's shared child, whose own participants don't include its parent", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        const { name: _name, ...spec } = taskForkSpec('host-child', { parent: 'alpha', inherit: { mode: 'shared' } });
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('host-child'), systemPrompt: 'You are alpha.' } as never, spec);
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], "the parent's recorded head");
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], "and the parent's change, once");
        assert.deepEqual(traces.filter((t) => (t as { agentName?: string }).agentName === 'host-child' && t.type === 'head:declared'), [], 'nothing declared again');
      });
    });

    it("carries a change the host copied without stamping it once: the copy is in the request, so the child doesn't declare it again", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        const { messages } = await alpha.getContextManager().compile(undefined, undefined, { dryRun: true });
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('copy-child'), systemPrompt: 'You are alpha.' } as never, inheriting('copy-child', 'alpha'));
        for (const m of messages) store(framework, child, m.participant, m.content);
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], "the copied change, once");
        assert.deepEqual(traces.filter((t) => (t as { agentName?: string }).agentName === 'copy-child' && t.type === 'head:declared'), [], 'nothing declared again');
      });
    });

    it("keeps the child's head its own: neither one's moves reach the other's record", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const { alpha, child } = await forked(framework, {}, inheriting('alpha-child', 'alpha'), 'alpha-child');
        await child.buildActivationRequest([tool('a'), tool('b'), tool('c')]);
        const heads = framework as unknown as { headDeclarations: { read(name: string): { tools: { name: string }[] } | null } };
        assert.deepEqual(heads.headDeclarations.read('alpha')!.tools.map((t) => t.name), ['a'], "the child's change left the parent's record");
        const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
        await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
        await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
        assert.deepEqual(heads.headDeclarations.read('alpha')!.tools.map((t) => t.name), ['a', 'b'], 'the parent moved its head');
        const again = await child.buildActivationRequest([tool('a'), tool('b'), tool('c')]);
        assert.deepEqual(again.tools, [tool('a')], "and the child's record stayed as it was copied");
        const parentRecord = JSON.stringify(heads.headDeclarations.read('alpha'));
        await child.buildActivationRequest([tool('a'), tool('b'), tool('c')], system('c1'));
        const moved = await child.buildActivationRequest([tool('a'), tool('b'), tool('c')], system('c2'));
        assert.deepEqual(moved.tools, [tool('a'), tool('b'), tool('c')], 'the child moved its head');
        assert.equal(JSON.stringify(heads.headDeclarations.read('alpha')), parentRecord, "and the parent's record stayed as it was");
      });
    });

    it("gives a child nothing from a parent on its head, so it starts as an unseeded child does", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const heads = framework as unknown as { headDeclarations: { write(name: string, head: unknown): void } };
        heads.headDeclarations.write('alpha', { tools: [tool('old')], system: ['You are alpha.'] });
        const seeded = (await framework.createEphemeralAgent({ ...resident('seeded'), systemPrompt: 'You are alpha.' } as never, inheriting('seeded', 'alpha'))).agent;
        const unseeded = (await framework.createEphemeralAgent({ ...resident('unseeded'), systemPrompt: 'You are alpha.' } as never)).agent;
        for (const child of [seeded, unseeded]) store(framework, child, 'user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        for (const child of [seeded, unseeded]) adopt(framework, child);
        const [a, b] = [await seeded.buildActivationRequest([tool('x')]), await unseeded.buildActivationRequest([tool('x')])];
        assert.deepEqual([a.tools, a.messages], [b.tools, b.messages]);
      });
    });

    it("keeps the child's head as recorded when what the parent's request carries is changed in place", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const { alpha, child } = await forked(framework, {}, inheriting('alpha-child', 'alpha'), 'alpha-child');
        const parentRequest = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        parentRequest.tools![0]!.description = 'changed in place, as a hook might';
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], "the child's head as copied");
      });
    });

    it("reads the parent's head as creation begins, so a head the parent moves while the child's context opens costs the child one declaration, never a change carried twice", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const pending = framework.createEphemeralAgent({ ...resident('child'), systemPrompt: 'You are alpha.' } as never, inheriting('child', 'alpha'));
        const heads = framework as unknown as { headDeclarations: { write(name: string, head: unknown): void } };
        heads.headDeclarations.write('alpha', { tools: [tool('a'), tool('b')], system: ['You are alpha.'] });
        const { agent: child } = await pending;
        store(framework, child, 'user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], "the parent's head as creation began");
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'and the difference declared once');
      });
    });

    it("gives a child nothing from an inherit at a checkpoint of the caller's (atSequence), whose head isn't recorded, so it starts as an unseeded child does", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const spec = { ...inheriting('seeded', 'alpha'), inherit: { from: 'alpha', mode: 'copy' as const, atSequence: 1 } };
        const seeded = (await framework.createEphemeralAgent({ ...resident('seeded'), systemPrompt: 'You are alpha.' } as never, spec)).agent;
        const unseeded = (await framework.createEphemeralAgent({ ...resident('unseeded'), systemPrompt: 'You are alpha.' } as never)).agent;
        for (const child of [seeded, unseeded]) store(framework, child, 'user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        for (const child of [seeded, unseeded]) adopt(framework, child);
        const [a, b] = [await seeded.buildActivationRequest([tool('x')]), await unseeded.buildActivationRequest([tool('x')])];
        assert.deepEqual([a.tools, a.messages], [b.tools, b.messages]);
      });
    });

    it("gives a child nothing from an inherit naming no running agent, so it starts as an unseeded child does", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const seeded = (await framework.createEphemeralAgent({ ...resident('seeded'), systemPrompt: 'You are alpha.' } as never, inheriting('seeded', 'nobody'))).agent;
        const unseeded = (await framework.createEphemeralAgent({ ...resident('unseeded'), systemPrompt: 'You are alpha.' } as never)).agent;
        for (const child of [seeded, unseeded]) store(framework, child, 'user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        for (const child of [seeded, unseeded]) adopt(framework, child);
        const [a, b] = [await seeded.buildActivationRequest([tool('x')]), await unseeded.buildActivationRequest([tool('x')])];
        assert.deepEqual([a.tools, a.messages], [b.tools, b.messages]);
      });
    });

    it("declares a shared child's change though the call its parent made it from is still open on the parent's branch", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        store(framework, alpha, 'alpha', [{ type: 'tool_use', id: 'spawn', name: 'a', input: {} } as ContentBlock]);
        const { agent: child } = await framework.deriveAgent({ name: 'alpha-child', from: 'alpha' });
        say(framework, child, 'user', 'Do the task.');
        adopt(framework, child);
        await child.buildActivationRequest([tool('a')]);
        await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.equal(storedChanges(child, 'alpha-child'), 1, "its parent's open call isn't one the child waits on");
      });
    });

    for (const [how, config] of [['on the head', { toolDeclarations: 'head' }], ['at a move of its head', { systemPrompt: 'You are the child.' }]] as const) {
      it(`a shared child that removes its own change rows ${how} takes its parent's from its own branch, and leaves its parent's context as it was`, async () => {
        await withFramework([resident('alpha')], async (framework) => {
          const alpha = framework.getAgent('alpha')!;
          say(framework, alpha, 'user', 'hello');
          await alpha.buildActivationRequest([tool('a')]);
          await alpha.buildActivationRequest([tool('a'), tool('b')]);
          const dry = (agent: Agent) => agent.getContextManager().compile(undefined, undefined, { dryRun: true }).then((c) => c.messages);
          const rowsBefore = alpha.getContextManager().getAllMessages().map((m) => m.id);
          const compiledBefore = await dry(alpha);
          assert.equal(storedChanges(alpha, 'alpha'), 1, "the premise: the parent's change is stored");
          const { agent: child } = await framework.deriveAgent({ name: 'alpha-child', from: 'alpha', config });
          assert.equal(storedChanges(child, 'alpha'), 1, "the premise: the child's branch holds its parent's change");
          adopt(framework, child);
          await child.buildActivationRequest([tool('a'), tool('b')]);
          assert.deepEqual(changesIn(await dry(child)), [], "the premise: the child's context holds no change row now, its parent's own taken as its own");
          assert.deepEqual([storedChanges(child, 'alpha'), storedChanges(child, 'alpha-child')], [0, 0], "taken out of the child's branch, not only out of its compile");
          assert.deepEqual(alpha.getContextManager().getAllMessages().map((m) => m.id), rowsBefore, "the parent's stored rows as they were");
          assert.deepEqual(await dry(alpha), compiledBefore, 'and its compile');
        });
      });
    }

    for (const mode of ['shared', 'copy'] as const) {
      it(`starts a child deriveAgent makes (${mode}) on its parent's head, so its first request carries the parent's prefix and declares nothing`, async () => {
        await withFramework([resident('alpha')], async (framework) => {
          const traces: TraceEvent[] = [];
          framework.onTrace((event) => { traces.push(event); });
          const alpha = framework.getAgent('alpha')!;
          say(framework, alpha, 'user', 'hello');
          await alpha.buildActivationRequest([tool('a')]);
          await alpha.buildActivationRequest([tool('a'), tool('b')]);
          const { agent: child } = await framework.deriveAgent({ name: 'alpha-child', from: 'alpha', mode });
          adopt(framework, child);
          const request = await child.buildActivationRequest([tool('a'), tool('b')]);
          assert.deepEqual(request.tools, [tool('a')], "the parent's recorded head");
          assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], "and the parent's change, once");
          assert.deepEqual(traces.filter((t) => (t as { agentName?: string }).agentName === 'alpha-child' && t.type.startsWith('head:')), [], 'no adoption, no declaration');
        });
      });
    }

    it("takes a copied change of its parent's out of the child's context when the child's head moves", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')], system('v1'));
        await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
        const { agent: child } = await framework.deriveAgent({ name: 'alpha-child', from: 'alpha', mode: 'copy' });
        adopt(framework, child);
        assert.deepEqual(changesIn((await child.buildActivationRequest([tool('a'), tool('b')], system('v1'))).messages),
          [[{ type: 'system_change', defineTools: [tool('b')] }]], "the premise: the parent's change, copied");
        const moved = await child.buildActivationRequest([tool('a'), tool('b')], system('v2'));
        assert.deepEqual(moved.tools, [tool('a'), tool('b')], "a replacement moved the child's head");
        assert.deepEqual(changesIn(moved.messages), [], 'and took the copied change with it');
      });
    });
  });

  it("reports after host /undo the last conversational message the agent sees, not a change after it", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'one');
      await alpha.buildActivationRequest([tool('a')]);
      say(framework, alpha, 'alpha', 'two');
      say(framework, alpha, 'user', 'three');
      say(framework, alpha, 'alpha', 'four');
      const host = framework as unknown as { handleHostCommand(server: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string; lastVisible?: { participant?: string; preview?: string } | null }> };
      const result = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 1 });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.lastVisible?.participant, 'user', JSON.stringify(result.lastVisible));
      assert.match(result.lastVisible?.preview ?? '', /three/);
    });
  });

  it("starts a fork from its template's head and changes, and declares only the fork's own difference", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const internals = framework as unknown as { createConversationAgent(name: string, channelId: string): Promise<Agent> };
      const fork = await internals.createConversationAgent('alpha-fork', 'chanA');
      const rows = fork.getContextManager().getAllMessages().filter(isChange);
      assert.equal(rows.length, 1, "the template's change, copied");
      assert.deepEqual(rows[0]!.metadata, { system: true, kind: 'system-change', agent: 'alpha-fork', audience: ['alpha-fork'], ownRowOf: 'alpha-fork' }, 'as the fork\'s own');
      const request = await fork.buildActivationRequest([tool('a'), tool('b'), tool('c')]);
      assert.deepEqual(request.tools, [tool('a')], "the template's head");
      assert.deepEqual(changesIn(request.messages), [
        [{ type: 'system_change', defineTools: [tool('b')] }],
        [{ type: 'system_change', defineTools: [tool('c')] }],
      ], 'its template\'s change, then its own');
      const heads = framework as unknown as { headDeclarations: { read(name: string): unknown }; disposeConversationAgent(name: string): void; headDeclarationCache: { heads: Map<string, unknown> } | null };
      assert.notEqual(heads.headDeclarations.read('alpha-fork'), null);
      heads.disposeConversationAgent('alpha-fork');
      assert.equal(heads.headDeclarationCache?.heads.has('alpha-fork'), false, "a closed fork's head leaves memory");
      assert.notEqual(heads.headDeclarations.read('alpha-fork'), null, "and stays in the store, as the rest of its data does");
      assert.notEqual(heads.headDeclarations.read('alpha'), null);
    }, undefined, { conversations: { templateAgent: 'alpha' } });
  });

  it("reads the template's head as a fork's creation begins, so a head the template moves meanwhile costs the fork one declaration, never a change carried twice", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      const internals = framework as unknown as { createConversationAgent(name: string, channelId: string): Promise<Agent>; headDeclarations: { write(name: string, head: unknown): void } };
      const pending = internals.createConversationAgent('alpha-fork', 'chanA');
      internals.headDeclarations.write('alpha', { tools: [tool('a'), tool('b')], system: ['You are alpha.'] });
      const fork = await pending;
      const request = await fork.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(request.tools, [tool('a')], "the template's head as creation began");
      assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'and the difference declared once');
    }, undefined, { conversations: { templateAgent: 'alpha' } });
  });

  it("copies a host's change row into a fork as no agent's own, so the fork's moves leave it", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      const hostChange = [{ type: 'system_change', defineTools: [tool('h')] }] as unknown as ContentBlock[];
      store(framework, alpha, 'system', hostChange);
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
      const internals = framework as unknown as { createConversationAgent(name: string, channelId: string): Promise<Agent> };
      const fork = await internals.createConversationAgent('alpha-fork', 'chanA');
      const owners = () => fork.getContextManager().getAllMessages().filter(isChange).map((m) => (m.metadata as { agent?: string } | undefined)?.agent ?? 'host');
      assert.deepEqual(owners(), ['host', 'alpha-fork'], "the host's row copied as no agent's own, the template's as the fork's");
      await fork.buildActivationRequest([tool('a'), tool('b')], system('v2'));
      assert.deepEqual(owners(), ['host'], "the fork's move took its own row and left the host's");
    }, undefined, { conversations: { templateAgent: 'alpha' } });
  });

  it("hides the residents' changes from the subconscious, which reads their slot", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const subconscious = framework.getAgent('Subconscious')!;
      const request = await subconscious.buildActivationRequest([tool('think')]);
      assert.deepEqual(changesIn(request.messages), [], "alpha's change declares alpha's tools");
      assert.ok(request.messages.some((m) => (m.content[0] as { text?: string }).text === 'hello'), 'while the conversation reads through');
    }, undefined, { subconscious: { enabled: true, systemPrompt: 'You attend.' } });
  });

  it('leaves a change row out of the poisoned-history shed, which takes turns', async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      say(framework, alpha, 'alpha', 'a reply');
      say(framework, alpha, 'user', 'go on');
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const internals = framework as unknown as { shedNewestTurn(agent: Agent): unknown };
      internals.shedNewestTurn(alpha);
      const left = alpha.getContextManager().getPresentedMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.ok(left.includes('change'), `the change stayed: ${JSON.stringify(left)}`);
      assert.ok(!left.includes('go on'), 'the newest turn went');
    });
  });

  it('passes over a change row a host stored without metadata in the poisoned-history shed, as it does a stamped one', async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      say(framework, alpha, 'alpha', 'a reply');
      say(framework, alpha, 'user', 'go on');
      store(framework, alpha, 'system', [{ type: 'system_change', defineTools: [tool('x')] } as ContentBlock]);
      const internals = framework as unknown as { shedNewestTurn(agent: Agent): unknown };
      internals.shedNewestTurn(alpha);
      const left = alpha.getContextManager().getPresentedMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.deepEqual(left, ['hello', 'a reply', 'change'], 'the newest turn went, and the change stayed');
    });
  });

  it("leaves another resident's change rows be when one resident moves its head", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello, both');
      await alpha.buildActivationRequest([tool('a')]);
      await beta.buildActivationRequest([tool('x')], system('v1'));
      await beta.buildActivationRequest([tool('x'), tool('y')], system('v1'));
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual([storedChanges(alpha, 'alpha'), storedChanges(beta, 'beta')], [1, 1], 'the premise: each has a change of its own stored');
      await beta.buildActivationRequest([tool('x'), tool('y')], system('v2'));
      assert.deepEqual([storedChanges(alpha, 'alpha'), storedChanges(beta, 'beta')], [1, 0], "beta's move took only its own, and alpha's change stays");
      const owners = alpha.getContextManager().getAllMessages().filter(isChange).map((m) => (m.metadata as { agent?: string }).agent);
      assert.deepEqual(owners, ['alpha'], "alpha's view keeps its own");
    });
  });

  it("ends a resident's request kept to its head on its own turn and `[Continue]`, though a host's change row follows the turn", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      say(framework, alpha, 'alpha', 'my reply');
      store(framework, alpha, 'system', [{ type: 'system_change', defineTools: [tool('h')] } as unknown as ContentBlock]);
      alpha.keepToHeadUntilBuiltAgain();
      const request = await alpha.buildActivationRequest([tool('a')]);
      assert.deepEqual(request.messages.slice(-2).map((m) => (m.content[0] as { text?: string }).text), ['my reply', '[Continue]']);
    });
  });

  it("waits to declare while the shared slot ends on another resident's call, and declares after its result", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const cm = alpha.getContextManager();
      say(framework, alpha, 'user', 'hello');
      await beta.buildActivationRequest([tool('x')]);
      store(framework, alpha, 'alpha', [{ type: 'tool_use', id: 'call-1', name: 'a', input: {} } as ContentBlock]);
      await beta.buildActivationRequest([tool('x'), tool('y')]);
      assert.equal(cm.getAllMessages().filter(isSystemChangeMessage).length, 0, 'nothing declared while the call waits');
      store(framework, alpha, 'user', [{ type: 'tool_result', toolUseId: 'call-1', content: 'ok' } as ContentBlock]);
      await beta.buildActivationRequest([tool('x'), tool('y')]);
      const all = cm.getAllMessages();
      assert.equal(all.filter(isSystemChangeMessage).length, 1, 'declared once the result is in');
      assert.ok(isSystemChangeMessage(all.at(-1)!), 'after the result');
      assert.equal((all.at(-2)!.content[0] as { type?: string }).type, 'tool_result');
    });
  });

  describe('the recorded heads in the store', () => {
    type Store = { setStateJson(id: string, value: unknown): unknown; getStateJson(id: string): unknown };
    type Internals = { store: Store; headDeclarationCache: unknown; headDeclarations: { read(name: string): unknown; write(name: string, head: unknown): void } };
    const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
    async function statesWritten(store: Store, run: () => Promise<unknown>): Promise<string[]> {
      const written: string[] = [];
      const set = store.setStateJson.bind(store);
      store.setStateJson = (id, value) => { written.push(id); return set(id, value); };
      try { await run(); } finally { store.setStateJson = set; }
      return written;
    }

    it("keeps each agent's head in a state of its own, so one agent's write leaves the others' unwritten", async () => {
      await withFramework([resident('alpha'), resident('beta')], async (framework) => {
        const internals = framework as unknown as Internals;
        const [alpha, beta] = [framework.getAgent('alpha')!, framework.getAgent('beta')!];
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')], system('v1'));
        await beta.buildActivationRequest([tool('b')]);
        const betaHead = internals.store.getStateJson('framework/head-declarations/beta');
        const written = await statesWritten(internals.store, () => alpha.buildActivationRequest([tool('a')], system('v2')));
        assert.deepEqual(written, ['framework/head-declarations/alpha'], "alpha's replacement writes alpha's state alone");
        assert.deepEqual((internals.store.getStateJson('framework/head-declarations/alpha') as { system: string[] }).system, ['You are alpha.', 'v2']);
        assert.deepEqual(internals.store.getStateJson('framework/head-declarations/beta'), betaHead);
      });
    });

    it("moves nothing while its head can't be stored, and keeps its change with the recorded head", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as Internals;
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')], system('v1'));
        await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
        const set = internals.store.setStateJson.bind(internals.store);
        internals.store.setStateJson = (id, value) => {
          if (id === 'framework/head-declarations/alpha') throw new Error('no space left on device');
          return set(id, value);
        };
        try {
          for (const n of [1, 2]) {
            const held = await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
            assert.deepEqual(held.tools, [tool('a')], `request ${n}: the recorded head goes out`);
            assert.deepEqual(changesIn(held.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], `request ${n}: with its change`);
          }
        } finally {
          internals.store.setStateJson = set;
        }
        const next = await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
        assert.deepEqual(next.tools, [tool('a'), tool('b')], 'once it stores, the replacement moves the head');
        assert.deepEqual(changesIn(next.messages), [], 'and takes the change it now holds');
      });
    });

    it("registers an agent's state at its first write, and none for an agent on its head", async () => {
      const registered: string[] = [];
      await withFramework([resident('alpha'), { ...resident('beta'), toolDeclarations: 'head' }], async (framework) => {
        const internals = framework as unknown as Internals & { store: { registerState(r: { id: string }): void } };
        const register = internals.store.registerState.bind(internals.store);
        internals.store.registerState = (r) => { registered.push(r.id); return register(r); };
        const [alpha, beta] = [framework.getAgent('alpha')!, framework.getAgent('beta')!];
        say(framework, alpha, 'user', 'hello');
        await beta.buildActivationRequest([tool('b')]);
        await beta.buildActivationRequest([tool('b'), tool('c')]);
        assert.deepEqual(registered.filter((id) => id.startsWith('framework/head-declarations')), [], 'beta, on its head, registers nothing');
        assert.equal(internals.headDeclarations.read('beta'), null, 'and reads no record');
        await alpha.buildActivationRequest([tool('a')]);
        assert.deepEqual(registered.filter((id) => id.startsWith('framework/head-declarations')), ['framework/head-declarations/alpha'], "alpha's state, at its adoption");
      });
    });

    it('makes no write that would change nothing', async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as Internals;
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const recorded = JSON.parse(JSON.stringify(internals.headDeclarations.read('alpha')));
        assert.deepEqual(await statesWritten(internals.store, async () => internals.headDeclarations.write('alpha', recorded)), []);
        assert.deepEqual(await statesWritten(internals.store, async () => internals.headDeclarations.write('alpha', { ...recorded, system: ['other'] })), ['framework/head-declarations/alpha']);
      });
    });

    it("reads each agent's record once a branch", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as Internals & { store: { createBranch(n: string, from?: string): unknown; switchBranch(n: string): unknown; currentBranch(): { name: string } } };
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        let reads = 0;
        const get = internals.store.getStateJson.bind(internals.store);
        internals.store.getStateJson = (id) => { if (id === 'framework/head-declarations/alpha') reads++; return get(id); };
        try {
          internals.headDeclarationCache = null;
          for (let i = 0; i < 3; i++) await alpha.buildActivationRequest([tool('a')]);
          assert.equal(reads, 1, 'once on this branch');
          const main = internals.store.currentBranch().name;
          internals.store.createBranch('elsewhere', main);
          internals.store.switchBranch('elsewhere');
          for (let i = 0; i < 2; i++) internals.headDeclarations.read('alpha');
          assert.equal(reads, 2, 'and once on another');
          internals.store.switchBranch(main);
        } finally {
          internals.store.getStateJson = get;
        }
      });
    });

    it("reads a branch's own record, though another branch of the same name came before it", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as Internals & { store: { createBranch(n: string, from?: string): unknown; switchBranch(n: string): unknown; deleteBranch(n: string): void; currentBranch(): { name: string } } };
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const main = internals.store.currentBranch().name;
        internals.store.createBranch('trial', main);
        internals.store.switchBranch('trial');
        internals.headDeclarations.write('alpha', { tools: [tool('b')], system: ['You are alpha.'] });
        internals.store.switchBranch(main);
        internals.store.deleteBranch('trial');
        internals.store.createBranch('trial', main);
        internals.store.switchBranch('trial');
        assert.deepEqual((internals.headDeclarations.read('alpha') as { tools: ToolDefinition[] }).tools, [tool('a')], "the new branch's record, made from main's");
        internals.store.switchBranch(main);
      });
    });

    it("sets aside a record that isn't a head, and the agent adopts again", async () => {
      await withFramework([resident('alpha'), resident('beta')], async (framework) => {
        const internals = framework as unknown as Internals;
        const [alpha, beta] = [framework.getAgent('alpha')!, framework.getAgent('beta')!];
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await beta.buildActivationRequest([tool('b')]);
        internals.store.setStateJson('framework/head-declarations/alpha', { tools: 'not a list', system: [] });
        internals.headDeclarationCache = null;
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const errors: string[] = [];
        const error = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        let request: Awaited<ReturnType<Agent['buildActivationRequest']>>;
        try { request = await alpha.buildActivationRequest([tool('a'), tool('c')]); } finally { console.error = error; }
        assert.deepEqual(request.tools, [tool('a'), tool('c')], 'what is current');
        assert.deepEqual(traces.filter((t) => t.type === 'head:moved').map((t) => (t as { why: string }).why), ['adopted']);
        assert.deepEqual(errors, ["[head-declarations] alpha: the recorded head isn't one, so it was set aside"]);
        assert.deepEqual((internals.store.getStateJson('framework/head-declarations/alpha') as { tools: ToolDefinition[] }).tools, [tool('a'), tool('c')], 'and the record is a head again');
        assert.deepEqual((internals.headDeclarations.read('beta') as { tools: ToolDefinition[] }).tools, [tool('b')], "beta's stays");
      });
    });

    it("sends the current head while an agent's record can't be read, saying so once, and records it again", async () => {
      await withFramework([resident('alpha'), resident('beta')], async (framework) => {
        const internals = framework as unknown as Internals;
        const [alpha, beta] = [framework.getAgent('alpha')!, framework.getAgent('beta')!];
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await beta.buildActivationRequest([tool('b')]);
        const get = internals.store.getStateJson.bind(internals.store);
        internals.store.getStateJson = (id) => {
          if (id === 'framework/head-declarations/alpha') throw new Error('unreadable');
          return get(id);
        };
        internals.headDeclarationCache = null;
        const errors: string[] = [];
        const error = console.error;
        console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
        try {
          const request = await alpha.buildActivationRequest([tool('a'), tool('c')]);
          assert.deepEqual(request.tools, [tool('a'), tool('c')], 'what is current');
          assert.deepEqual(changesIn(request.messages), []);
          internals.headDeclarationCache = null;
          await alpha.buildActivationRequest([tool('a'), tool('c')]);
        } finally {
          console.error = error;
          internals.store.getStateJson = get;
        }
        assert.deepEqual(errors, ['[head-declarations] alpha: the recorded head could not be read, so its requests go on its current head, which it records in its place once it can:'], 'said once on the branch');
        assert.deepEqual((get('framework/head-declarations/alpha') as { tools: ToolDefinition[] }).tools, [tool('a'), tool('c')], 'the record is written again');
        assert.deepEqual((internals.headDeclarations.read('beta') as { tools: ToolDefinition[] }).tools, [tool('b')], "beta's is read as before");
      });
    });
  });

  it("reads the recorded heads again after a branch switch, as the branch has them", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'zero');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      say(framework, alpha, 'user', 'one');
      say(framework, alpha, 'alpha', 'two');
      say(framework, alpha, 'user', 'three');
      await alpha.buildActivationRequest([tool('a')], system('v2'));
      const internals = framework as unknown as { headDeclarations: { read(name: string): { system: string[] } | null } };
      assert.deepEqual(internals.headDeclarations.read('alpha')!.system, ['You are alpha.', 'v2']);
      const host = framework as unknown as { handleHostCommand(server: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> };
      const undone = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 2 });
      assert.equal(undone.ok, true, undone.error);
      assert.deepEqual(internals.headDeclarations.read('alpha')!.system, ['You are alpha.', 'v1'], "the undo's branch has the head from before the move");
    });
  });

  it('forgets a head deleted on the head for good: a restart under entries adopts afresh', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-declarations-delete-'));
    const storePath = join(tempDir, 'store.chronicle');
    try {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
      }, storePath);
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        await framework.getAgent('alpha')!.buildActivationRequest([tool('a')]);
      }, storePath);
      await withFramework([resident('alpha')], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const request = await framework.getAgent('alpha')!.buildActivationRequest([tool('b')]);
        assert.deepEqual(request.tools, [tool('b')], 'no record survived');
        assert.deepEqual(traces.filter((t) => t.type === 'head:moved').map((t) => (t as { why: string }).why), ['adopted']);
      }, storePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('puts a subconscious on another model than its principal on its head', async () => {
    for (const [model, want] of [['test-model', 'entries'], ['another-model', 'head']] as const) {
      await withFramework([resident('alpha')], async (framework) => {
        assert.equal(framework.getAgent('Subconscious')!.toolDeclarations, want, model);
      }, undefined, { subconscious: { enabled: true, systemPrompt: 'You attend.', model } });
    }
  });

  describe('a reader fork', () => {
    const forkOf = async (framework: AgentFramework): Promise<Agent> => {
      const derive = framework.deriveAgent.bind(framework);
      let derived: Promise<Agent> | undefined;
      framework.deriveAgent = (options) => {
        const fork = derive(options);
        derived = fork.then((made) => made.agent);
        return fork;
      };
      framework.runEphemeralToCompletion = async () => ({ speech: '', toolCallsCount: 0 });
      (framework as unknown as { invokeReaderFork(invocation: unknown): void }).invokeReaderFork({
        serverId: 'disc', channelId: 'disc:guild:noisy', epochId: 'epoch-0001', trigger: 'wake',
        notice: '[Tune-out wake]', backlog: [], queued: [], dispositions: null,
      });
      assert.ok(derived, 'the invocation derives a fork');
      return derived;
    };
    const declared = async (framework: AgentFramework, alpha: Agent) => {
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
    };
    const changeB = [[{ type: 'system_change', defineTools: [tool('b')] }]];

    it("on another model than its principal sends no change row, and the principal's change stays where it was", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        await declared(framework, alpha);
        const request = await (await forkOf(framework)).buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(request.messages), [], "no change row goes to the other model");
        assert.deepEqual(request.tools, [tool('a'), tool('b')], 'its head carries the tools as they are');
        assert.deepEqual(changesIn((await alpha.buildActivationRequest([tool('a'), tool('b')])).messages), changeB, "the principal's next request still carries its change");
      }, undefined, { subconscious: { enabled: true, reader: 'forks', voice: 'v', model: 'another-model' } });
    });

    it("on its principal's own model sends the principal's change as stored", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        await declared(framework, framework.getAgent('alpha')!);
        const request = await (await forkOf(framework)).buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(request.messages), changeB);
        assert.deepEqual(request.tools, [tool('a')], "the principal's recorded head");
      }, undefined, { subconscious: { enabled: true, reader: 'forks', voice: 'v', model: 'test-model' } });
    });

    it('of a principal on its head, on its own model, declares on its head too', async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        say(framework, framework.getAgent('alpha')!, 'user', 'hello');
        const fork = await forkOf(framework);
        await fork.buildActivationRequest([tool('a')]);
        const request = await fork.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(request.messages), [], 'no change row');
        assert.deepEqual(request.tools, [tool('a'), tool('b')], 'the tools as they are, on its head');
      }, undefined, { subconscious: { enabled: true, reader: 'forks', voice: 'v', model: 'test-model' } });
    });
  });

  it("shows a change in history's tools as made, never what it declared, raw or as text", async () => {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 20, 6, i));
    const rows = [
      { id: 'm1', sequence: 1, participant: 'user', content: [{ type: 'text', text: 'hello' }], timestamp: at(0) },
      {
        id: 'm2', sequence: 2, participant: 'system', timestamp: at(1),
        content: [{ type: 'system_change', removeTools: ['old_secret_tool'], defineTools: [tool('new_secret_tool')], addSystem: ['PRIVATE INSTRUCTIONS'] }],
        metadata: { system: true, kind: 'system-change', agent: 'alpha' },
      },
    ] as unknown as StoredMessage[];
    const mod = new HistoryModule();
    mod.bind({
      queryMessagesByTime: () => ({ messages: rows, matchedCount: rows.length }),
      queryMessagesByTimeAndChannel: () => ({ messages: rows, matchedCount: rows.length }),
      getMessage: (id: string) => rows.find((r) => r.id === id) ?? null,
      getMessageCount: () => rows.length,
      getMessageWindow: (offset: number, limit: number) => ({ messages: rows.slice(offset, offset + limit) }),
    } as unknown as ContextManager);
    for (const format of ['text', 'raw']) {
      const result = await mod.handleToolCall({ id: 't', name: 'extract', input: { limit: 10, format }, callerAgentName: 'beta' } as ToolCall);
      assert.equal(result.success, true, result.error);
      const shown = JSON.stringify(result.data);
      assert.ok(shown.includes(format === 'text' ? '[system change]' : '"system_change"'), `${format}: ${shown}`);
      for (const secret of ['secret_tool', 'PRIVATE INSTRUCTIONS']) assert.ok(!shown.includes(secret), `${format}: ${secret} withheld: ${shown}`);
      assert.ok(shown.includes('hello'), `${format}: the conversation reads through`);
    }
  });

  it("sends a host's change row, stored without an agent's metadata in the residents' shared slot, to each 'entries' resident as stored, and not to the subconscious, and a resident's move leaves it", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello, both');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      await beta.buildActivationRequest([tool('x')]);
      const hostChange = [{ type: 'system_change', defineTools: [tool('h')] }] as unknown as ContentBlock[];
      store(framework, alpha, 'system', hostChange);
      assert.deepEqual(changesIn((await alpha.buildActivationRequest([tool('a')], system('v1'))).messages), [hostChange], "alpha's request carries the host's row");
      assert.deepEqual(changesIn((await beta.buildActivationRequest([tool('x')])).messages), [hostChange], "and so does beta's");
      const subconscious = await framework.getAgent('Subconscious')!.buildActivationRequest([tool('think')]);
      assert.deepEqual(changesIn(subconscious.messages), [], "the subconscious's doesn't: the host's row declares the residents' tools");
      assert.ok(subconscious.messages.some((m) => (m.content[0] as { text?: string }).text === 'hello, both'), 'while the conversation reads through');
      const owners = () => alpha.getContextManager().getAllMessages().filter(isChange).map((m) => (m.metadata as { agent?: string } | undefined)?.agent ?? 'host');
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
      assert.deepEqual(owners(), ['host', 'alpha'], 'alpha declared b as a row of its own');
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
      assert.deepEqual(owners(), ['host'], "alpha's move took its own change and left the host's");
      assert.deepEqual(changesIn((await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'))).messages), [hostChange], 'which still goes out as stored');
    }, undefined, { subconscious: { enabled: true, systemPrompt: 'You attend.' } });
  });

  it("lets a host's row that adds system text a resident doesn't hold cause no move and no declaration, request after request", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      const hostChange = [{ type: 'system_change', addSystem: ['HOST TEXT'] }] as unknown as ContentBlock[];
      store(framework, alpha, 'system', hostChange);
      const before = traces.length;
      for (const n of [1, 2]) {
        const request = await alpha.buildActivationRequest([tool('a')]);
        assert.deepEqual(changesIn(request.messages), [hostChange], `request ${n} carries the host's row as stored`);
      }
      assert.deepEqual(traces.slice(before).filter((t) => t.type.startsWith('head:')), [], 'no move and no declaration');
    });
  });

  for (const order of ['a change, then a stored injection', 'a stored injection, then a change', 'a stored injection, then a change a dry run shows'] as const) {
    it(`ends a resident's request on its own turn past ${order} after it, with its [Continue] last`, async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        const store = (framework as unknown as { storeInjections(agent: Agent, injections: unknown[]): unknown });
        const lesson = { namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: 'LESSON' }] };
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        say(framework, alpha, 'alpha', 'my reply');
        if (order === 'a change, then a stored injection') {
          await alpha.buildActivationRequest([tool('a'), tool('b')]);
          store.storeInjections(alpha, [lesson]);
        } else {
          store.storeInjections(alpha, [lesson]);
        }
        const request = await alpha.buildActivationRequest([tool('a'), tool('b')], undefined, undefined, undefined, { dryRun: order === 'a stored injection, then a change a dry run shows' });
        const shown = request.messages.map((m) => (isChange(m) ? 'change' : m.content.map((b) => (b as { text?: string }).text ?? '').join('')));
        assert.deepEqual(shown.slice(shown.indexOf('my reply')), [
          'my reply',
          ...(order === 'a change, then a stored injection' ? ['change', 'LESSON'] : ['LESSON', 'change']),
          '[Continue]',
        ]);
      });
    });
  }

  it("ends a resident's request on its own turn on the head, where a host's change row after it is left out, with its [Continue] last", async () => {
    await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      say(framework, alpha, 'alpha', 'my reply');
      store(framework, alpha, 'system', [{ type: 'system_change', defineTools: [tool('h')] }] as unknown as ContentBlock[]);
      const request = await alpha.buildActivationRequest([tool('a')]);
      const shown = request.messages.map((m) => (isChange(m) ? 'change' : m.content.map((b) => (b as { text?: string }).text ?? '').join('')));
      assert.deepEqual(shown.slice(shown.indexOf('my reply')), ['my reply', '[Continue]']);
    });
  });

  describe("a 'head' agent's compile, which leaves every change row out, as its request does", () => {
    const bulky = (name: string) => [{ type: 'system_change', defineTools: [{ ...tool(name), description: `${name} `.repeat(20000) }] }] as unknown as ContentBlock[];
    const tight = { contextBudgetTokens: 20000 };
    const lastText = (messages: readonly NormalizedMessage[]) => (messages.at(-1)!.content[0] as { text?: string }).text;
    const internals = (framework: AgentFramework) => framework as unknown as { createConversationAgent(name: string, channelId: string): Promise<Agent> };

    it("sends a resident's request beside a host's change rows that alone exceed its budget", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head', ...tight }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        store(framework, alpha, 'system', bulky('h1'));
        store(framework, alpha, 'system', bulky('h2'));
        say(framework, alpha, 'user', 'hello');
        const request = await alpha.buildActivationRequest([tool('a')]);
        assert.deepEqual(changesIn(request.messages), []);
        assert.equal(lastText(request.messages), 'hello');
      });
    });

    it("sends an isolated ephemeral agent's request beside a host's change rows that alone exceed its budget", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const { agent } = await framework.createEphemeralAgent({ name: 'solo', model: 'test-model', systemPrompt: 'You work alone.', ...tight } as never);
        store(framework, agent, 'system', bulky('h1'));
        store(framework, agent, 'system', bulky('h2'));
        say(framework, agent, 'user', 'hello');
        adopt(framework, agent);
        const request = await agent.buildActivationRequest([tool('a')]);
        assert.deepEqual(changesIn(request.messages), []);
        assert.equal(lastText(request.messages), 'hello');
      });
    });

    it("sends a host's shared child's request beside a host's change rows in its parent's context that alone exceed its budget", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        store(framework, alpha, 'system', bulky('h1'));
        store(framework, alpha, 'system', bulky('h2'));
        say(framework, alpha, 'user', 'hello');
        const { name: _name, ...spec } = taskForkSpec('host-child', { parent: 'alpha', inherit: { mode: 'shared' } });
        const { agent: child } = await framework.createEphemeralAgent({ name: 'host-child', model: 'test-model', systemPrompt: 'You are alpha.', ...tight } as never, spec);
        adopt(framework, child);
        const request = await child.buildActivationRequest([tool('a')]);
        assert.deepEqual(changesIn(request.messages), []);
        assert.equal(lastText(request.messages), 'hello');
      });
    });

    it("sends a conversation fork's request beside a host's change rows that alone exceed its budget", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head', ...tight }], async (framework) => {
        say(framework, framework.getAgent('alpha')!, 'user', 'hello');
        const fork = await internals(framework).createConversationAgent('alpha-fork', 'chanA');
        store(framework, fork, 'system', bulky('h1'));
        store(framework, fork, 'system', bulky('h2'));
        say(framework, fork, 'user', 'and you');
        const request = await fork.buildActivationRequest([tool('a')]);
        assert.deepEqual(changesIn(request.messages), []);
        assert.equal(lastText(request.messages), 'and you');
      }, undefined, { conversations: { templateAgent: 'alpha' } });
    });

    it("leaves an 'entries' child of a 'head' conversation fork, which has no view, its own change, declared once", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        say(framework, framework.getAgent('alpha')!, 'user', 'hello');
        await internals(framework).createConversationAgent('alpha-fork', 'chanA');
        const { name: _name, ...spec } = taskForkSpec('fork-child', { parent: 'alpha-fork', inherit: { mode: 'shared' } });
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('fork-child'), systemPrompt: 'You are alpha.' } as never, spec);
        adopt(framework, child);
        await child.buildActivationRequest([tool('a')]);
        await child.buildActivationRequest([tool('a'), tool('b')]);
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'its own change, once');
        const own = child.getContextManager().getAllMessages().filter(isChange).filter((m) => (m.metadata as { agent?: string } | undefined)?.agent === 'fork-child');
        assert.equal(own.length, 1, 'and stored once');
      }, undefined, { conversations: { templateAgent: 'alpha' } });
    });

    it("keeps its own change rows on the head while its record can't be cleared, and takes both out once it can", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as { store: { setStateJson(id: string, value: unknown): unknown }; headDeclarations: { read(name: string): unknown } };
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        alpha.keepToHeadUntilBuiltAgain();
        const rows = () => alpha.getContextManager().getAllMessages().filter(isChange).length;
        const set = internals.store.setStateJson.bind(internals.store);
        internals.store.setStateJson = (id, value) => {
          if (id === 'framework/head-declarations/alpha') throw new Error('no space left on device');
          return set(id, value);
        };
        try {
          await alpha.buildActivationRequest([tool('a'), tool('b')]);
          assert.equal(rows(), 1, 'its row stays with the record');
          assert.ok(internals.headDeclarations.read('alpha'), 'and the record stays');
        } finally {
          internals.store.setStateJson = set;
        }
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.equal(rows(), 0, 'once the record clears, its row goes');
        assert.equal(internals.headDeclarations.read('alpha'), null);
      });
    });

    it("shows a host's change row in an inspection of a live 'head' resident, whose compile leaves it out", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        const hostChange = [{ type: 'system_change', defineTools: [tool('h')] }] as unknown as ContentBlock[];
        store(framework, alpha, 'system', hostChange);
        const compiledChanges = async (cm: ContextManager) => changesIn((await cm.compile(undefined, undefined, { dryRun: true })).messages);
        assert.deepEqual(await compiledChanges(alpha.getContextManager()), [], "the premise: alpha's compile leaves it out");
        assert.deepEqual(await compiledChanges(await framework.inspectAgentContext('alpha')), [hostChange], 'inspected, it shows as stored');
      });
    });
  });

  it("keeps the subconscious's own declared change in its view, so it declares it once", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      const subconscious = framework.getAgent('Subconscious')!;
      await subconscious.buildActivationRequest([tool('think')]);
      await subconscious.buildActivationRequest([tool('think'), tool('ponder')]);
      const request = await subconscious.buildActivationRequest([tool('think'), tool('ponder')]);
      assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('ponder')] }]], 'its own change, once');
      const own = subconscious.getContextManager().getAllMessages().filter(isChange).filter((m) => (m.metadata as { agent?: string } | undefined)?.agent === 'Subconscious');
      assert.equal(own.length, 1, 'stored once');
    }, undefined, { subconscious: { enabled: true, systemPrompt: 'You attend.' } });
  });
});
