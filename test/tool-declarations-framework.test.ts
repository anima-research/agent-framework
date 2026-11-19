import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedMessage, ToolDefinition } from '@animalabs/membrane';

import { AgentFramework, audienceOf, taskForkSpec, type Agent, type AgentSpec } from '../src/index.js';
import { isSystemChangeMessage } from '../src/system-changes.js';
import type { TraceEvent } from '../src/types/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { foldOf, now } from './helpers/declared.js';

const tool = (name: string): ToolDefinition => ({
  name,
  description: `${name} does a thing`,
  inputSchema: { type: 'object', properties: {} },
});

const prompt = (text: string) => `${text}\n${'Follow the task, and say what you did. '.repeat(2000)}`;
/** The model the test membrane says takes no change in its context; every other model takes one. */
const TAKES_NONE = 'model-that-takes-no-change';
const resident = (name: string) => ({
  name,
  model: 'test-model',
  systemPrompt: prompt(`You are ${name}.`),
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
  const membrane = new MockMembrane();
  membrane.takesToolOrSystemChanges = (model: string) => model !== TAKES_NONE;
  const framework = await AgentFramework.create({
    storePath: path,
    membrane: membrane.asMembrane(),
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

describe('a change of tools or system text in the framework', () => {
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

  it("takes a host's change row out of every resident's window when one resident's move takes it from the slot they share, traced as `head-moved`", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      const row = (framework as unknown as { addMessage(participant: string, content: ContentBlock[]): string }).addMessage('system', [{ type: 'system_change', defineTools: [tool('h')] }]);
      assert.equal(beta.getContextManager().windowStatusOf(row as never), 'in', "the premise: beta's window holds the host's row");
      await alpha.buildActivationRequest([tool('a')], system('v2'));
      assert.equal(alpha.getContextManager().getMessage(row as never), null, "the premise: alpha's move took the row from the slot");
      assert.equal(beta.getContextManager().ordinalOf(row as never), undefined, "beta's window lets it go");
      const retracted = traces.filter((t) => t.type === 'presentation:retracted' && (t as { agentName: string }).agentName === 'beta') as unknown as Array<{ reason: string; messageIds: string[] }>;
      assert.deepEqual(retracted.map((t) => [t.reason, t.messageIds]), [['head-moved', [row]]]);
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

  it("counts a change row among host /undo N's messages, as any row, and the next request declares the change again", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'one');
      await alpha.buildActivationRequest([tool('a')]);
      say(framework, alpha, 'alpha', 'two');
      say(framework, alpha, 'user', 'three');
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      say(framework, alpha, 'alpha', 'four');
      const shown = alpha.getContextManager().getPresentedMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.deepEqual(shown, ['one', 'two', 'three', 'change', 'four'], 'the premise: the change is stored and shown between three and four');
      const host = framework as unknown as { handleHostCommand(server: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> };
      const tooMany = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 5 });
      assert.match(tooMany.error ?? '', /history has 5;/, 'the four messages and the change');
      const result = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 2 }) as { ok: boolean; error?: string; messagesRemoved?: number };
      assert.equal(result.ok, true, result.error);
      assert.equal(result.messagesRemoved, 2, 'two messages, as asked');
      const left = alpha.getContextManager().getAllMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.deepEqual(left, ['one', 'two', 'three'], 'four went, and the change before it');
      const request = await alpha.buildActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'declared again');
      assert.deepEqual(foldOf(request), now([tool('a'), tool('b')], prompt('You are alpha.')));
    });
  });

  it('raises an operator line when the changes force the head to move, naming the thinking it sets aside as `binds` says', async () => {
    const wide = { ...tool('b'), description: 'b does a thing. '.repeat(2000) };
    const hasThinking = (messages: readonly NormalizedMessage[]) => messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking'));
    for (const [binding, clause] of [
      [undefined, /: one whole write, and the thinking the request held set aside only with thinkingBinding\.binds: true; left out, the request still carries it, under a prefix it wasn't signed under: with thinkingBinding\.dropBlock the provider drops it from each request that carries it, and without it an account that enforces the binding refuses each such request and one that doesn't decides for itself$/],
      [{ binds: true, dropBlock: true }, /: one whole write, and the thinking the request held set aside$/],
    ] as const) {
      await withFramework([{ ...resident('alpha'), ...(binding ? { thinkingBinding: binding } : {}) }], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        store(framework, alpha, 'alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
        await alpha.buildActivationRequest([tool('a')]);
        const declared = await alpha.buildActivationRequest([tool('a'), wide]);
        assert.ok(hasThinking(declared.messages), `${JSON.stringify(binding)}: a declared change keeps the thinking before it`);
        const request = await alpha.buildActivationRequest([tool('a'), wide]);
        assert.deepEqual(request.tools?.map((t) => t.name), ['a', 'b'], 'past a fifth, the head moved');
        assert.equal(hasThinking(request.messages), !binding, `${JSON.stringify(binding)}: with binds, the compile for the new head leaves the thinking out`);
        const moved = traces.filter((t) => t.type === 'head:moved' && (t as { why: string }).why === 'consolidated');
        assert.equal(moved.length, 1);
        assert.equal((moved[0] as { forced?: string }).forced, 'share');
        const alerts = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-consolidated') as { message: string; data?: { changeChars?: number; requestChars?: number; forced?: string } }[];
        assert.equal(alerts.length, 1);
        const { changeChars, requestChars } = moved[0] as { changeChars?: number; requestChars?: number };
        assert.equal(changeChars, JSON.stringify({ type: 'system_change', defineTools: [wide] }).length, 'the change, in characters of JSON');
        assert.ok(changeChars! * 5 >= requestChars!, 'the premise: at least a fifth of the request');
        assert.match(alerts[0]!.message, new RegExp(`reached ${changeChars} characters of JSON, at least a fifth of the request's ${requestChars},`));
        assert.match(alerts[0]!.message, clause);
        assert.deepEqual(alerts[0]!.data, { forced: 'share', changesRemoved: 1, changeChars, requestChars });
        await alpha.buildActivationRequest([tool('a'), wide]);
      });
    }
  });

  it("raises an operator line for a move forced past a fifth, naming no thinking for a model whose `binds` is false, and one for a move forced by the budget", async () => {
    for (const [binding, clause] of [[{ binds: false }, /: one whole write$/], [undefined, /set aside only with thinkingBinding\.binds: true; left out, the request still carries it, under a prefix it wasn't signed under: with thinkingBinding\.dropBlock the provider drops it from each request that carries it, and without it an account that enforces the binding refuses each such request and one that doesn't decides for itself$/]] as const) {
      await withFramework([{ ...resident('alpha'), ...(binding ? { thinkingBinding: binding } : {}) }], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        const wide = { ...tool('b'), description: 'b does a thing. '.repeat(2000) };
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), wide]);
        await alpha.buildActivationRequest([tool('a'), wide]);
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

  it("takes the agent's record and its change rows out once it's built again on a model that takes no change, and a reply after keeps its thinking, with `binds: true`", async () => {
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
      await withFramework([{ ...resident('alpha'), model: TAKES_NONE, thinkingBinding: binding }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        const heads = framework as unknown as { headDeclarations: { read(name: string): unknown } };
        assert.ok(heads.headDeclarations.read('alpha'), 'the premise: its record from its period on a model that takes a change');
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
      assert.equal(replaced.system, `${prompt('You are alpha.')}\nv2`, 'the head moved');
      assert.equal(hasThinking(replaced.messages), false, 'and the compile for it left the thinking out');
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
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
      const { agent: child } = await framework.createEphemeralAgent({ ...resident(name), systemPrompt: prompt('You are alpha.'), ...parentConfig } as never, spec);
      for (const m of messages) store(framework, child, m.participant, m.content);
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
        const { agent: child } = await framework.createEphemeralAgent({ ...resident('host-child'), systemPrompt: prompt('You are the child.') } as never, spec);
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
          const { agent: child } = await framework.createEphemeralAgent({ ...resident('host-child'), systemPrompt: prompt('You are alpha.') } as never, spec);
          adopt(framework, child);
          const request = await child.buildActivationRequest([...childTools]);
          assert.deepEqual(readTools(request), childTools.map((t) => t.name).sort(), `with ${parentTools.length} tools on its parent's branch, the model reads the child's own`);
        });
      }
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

    it("reads the parent's head as creation begins, so a head the parent moves while the child's context opens costs the child one declaration, never a change carried twice", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const pending = framework.createEphemeralAgent({ ...resident('child'), systemPrompt: prompt('You are alpha.') } as never, inheriting('child', 'alpha'));
        const heads = framework as unknown as { headDeclarations: { write(name: string, head: unknown): void } };
        heads.headDeclarations.write('alpha', { tools: [tool('a'), tool('b')], system: [prompt('You are alpha.')] });
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
        const seeded = (await framework.createEphemeralAgent({ ...resident('seeded'), systemPrompt: prompt('You are alpha.') } as never, spec)).agent;
        const unseeded = (await framework.createEphemeralAgent({ ...resident('unseeded'), systemPrompt: prompt('You are alpha.') } as never)).agent;
        for (const child of [seeded, unseeded]) store(framework, child, 'user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        for (const child of [seeded, unseeded]) adopt(framework, child);
        const [a, b] = [await seeded.buildActivationRequest([tool('x')]), await unseeded.buildActivationRequest([tool('x')])];
        assert.deepEqual([a.tools, a.messages], [b.tools, b.messages]);
      });
    });

    it("gives a child nothing from an inherit naming no running agent, so it starts as an unseeded child does", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const seeded = (await framework.createEphemeralAgent({ ...resident('seeded'), systemPrompt: prompt('You are alpha.') } as never, inheriting('seeded', 'nobody'))).agent;
        const unseeded = (await framework.createEphemeralAgent({ ...resident('unseeded'), systemPrompt: prompt('You are alpha.') } as never)).agent;
        for (const child of [seeded, unseeded]) store(framework, child, 'user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        for (const child of [seeded, unseeded]) adopt(framework, child);
        const [a, b] = [await seeded.buildActivationRequest([tool('x')]), await unseeded.buildActivationRequest([tool('x')])];
        assert.deepEqual([a.tools, a.messages], [b.tools, b.messages]);
      });
    });

  });

  it("hides the residents' changes from the subconscious, which reads their slot", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(framework, alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      const second = await alpha.buildActivationRequest([tool('a'), tool('b')]);
      assert.notDeepEqual(changesIn(second.messages), [], "the premise: alpha's second request declares its change");
      assert.equal(storedChanges(alpha, 'alpha'), 1, 'and alpha stored it in the slot the subconscious reads');
      const subconscious = framework.getAgent('Subconscious')!;
      const request = await subconscious.buildActivationRequest([tool('think')]);
      assert.deepEqual(changesIn(request.messages), [], "alpha's change declares alpha's tools");
      assert.ok(request.messages.some((m) => (m.content[0] as { text?: string }).text === 'hello'), 'while the conversation reads through');
    }, undefined, { subconscious: { enabled: true, systemPrompt: prompt('You attend.') } });
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

  it("moves a resident's head when the store won't take its change row, as during another resident's tool call, and its request folds to what it has now", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const heads = framework as unknown as { headDeclarations: { read(name: string): { tools: ToolDefinition[] } | null } };
      say(framework, alpha, 'user', 'hello');
      await beta.buildActivationRequest([tool('x')]);
      store(framework, alpha, 'alpha', [{ type: 'tool_use', id: 'call-1', name: 'a', input: {} } as ContentBlock]);
      const request = await beta.buildActivationRequest([tool('x'), tool('y')]);
      assert.deepEqual(foldOf(request), now([tool('x'), tool('y')], prompt('You are beta.')), "beta's request folds to its tools now");
      assert.deepEqual(changesIn(request.messages), [], 'with no change row');
      assert.equal(beta.getContextManager().getAllMessages().filter(isSystemChangeMessage).length, 0, 'none stored between the call and its result');
      assert.deepEqual(heads.headDeclarations.read('beta')!.tools, [tool('x'), tool('y')], 'the head moved');
      assert.deepEqual(traces.filter((t) => t.type === 'head:moved' && (t as { agentName: string }).agentName === 'beta').map((t) => (t as { why: string }).why), ['adopted', 'unstored']);
    });
  });

  describe('the recorded heads in the store', () => {
    type Store = { setStateJson(id: string, value: unknown): unknown; getStateJson(id: string): unknown };
    type Internals = { store: Store; headDeclarations: { read(name: string): unknown; write(name: string, head: unknown): void } };
    const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
    async function statesWritten(store: Store, run: () => Promise<unknown>): Promise<string[]> {
      const written: string[] = [];
      const set = store.setStateJson.bind(store);
      store.setStateJson = (id, value) => { written.push(id); return set(id, value); };
      try { await run(); } finally { store.setStateJson = set; }
      return written;
    }

    it("goes in the fallback form while its head can't be stored, and moves once it can", async () => {
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
            assert.deepEqual(foldOf(held), now([tool('a'), tool('b')], `${prompt('You are alpha.')}\nv2`), `request ${n}: what alpha has now`);
            assert.deepEqual(changesIn(held.messages), [], `request ${n}: with no change row`);
            assert.equal(storedChanges(alpha, 'alpha'), 1, `request ${n}: its change stays stored`);
          }
        } finally {
          internals.store.setStateJson = set;
        }
        const next = await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
        assert.deepEqual(next.tools, [tool('a'), tool('b')], 'once it stores, the replacement moves the head');
        assert.deepEqual(changesIn(next.messages), [], 'and takes the change it now holds');
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
        internals.headDeclarations.write('alpha', { tools: [tool('b')], system: [prompt('You are alpha.')] });
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
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const errors: string[] = [];
        const error = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        let request: Awaited<ReturnType<Agent['buildActivationRequest']>>;
        try { request = await alpha.buildActivationRequest([tool('a'), tool('c')]); } finally { console.error = error; }
        assert.deepEqual(request.tools, [tool('a'), tool('c')], 'what is current');
        assert.deepEqual(traces.filter((t) => t.type === 'head:moved').map((t) => (t as { why: string }).why), ['adopted']);
        assert.deepEqual(errors, ["[head-declarations] alpha: the recorded head isn't one, so it was set aside: the agent's next request on a model that takes a change records its current tools and system text as its head, and takes out the change rows its compile holds, once the store takes the write"]);
        assert.deepEqual((internals.store.getStateJson('framework/head-declarations/alpha') as { tools: ToolDefinition[] }).tools, [tool('a'), tool('c')], 'and the record is a head again');
        assert.deepEqual((internals.headDeclarations.read('beta') as { tools: ToolDefinition[] }).tools, [tool('b')], "beta's stays");
      });
    });

    it("clears a record it set aside when an agent kept to its head deletes its head", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as Internals;
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.equal(storedChanges(alpha, 'alpha'), 1, 'the premise: its own change row, so a request on the head deletes its head');
        internals.store.setStateJson('framework/head-declarations/alpha', { tools: 'not a list', system: [] });
        alpha.keepToHeadUntilBuiltAgain();
        const error = console.error;
        console.error = () => {};
        try { await alpha.buildActivationRequest([tool('a'), tool('b')]); } finally { console.error = error; }
        assert.equal(storedChanges(alpha, 'alpha'), 0, 'its change row went with the head');
        assert.equal(internals.store.getStateJson('framework/head-declarations/alpha'), null, 'and the record it set aside is cleared, not answered from memory');
      });
    });

    it("says, when an agent's first head can't be stored, that its requests go on its current head without its own change rows", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const internals = framework as unknown as Internals;
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        const set = internals.store.setStateJson.bind(internals.store);
        internals.store.setStateJson = (id, value) => {
          if (id === 'framework/head-declarations/alpha') throw new Error('no space left on device');
          return set(id, value);
        };
        const errors: string[] = [];
        const error = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
        try {
          await alpha.buildActivationRequest([tool('a')]);
        } finally {
          console.error = error;
          internals.store.setStateJson = set;
        }
        assert.ok(errors.some((e) => e.startsWith('[head-declarations] alpha: the head could not be stored, and none is recorded, so its requests go on its current head with no change row until a later request stores it:')), errors.join('\n'));
        assert.ok(!errors.some((e) => e.includes('what was recorded stays')), 'and not that a recorded head stays');
      });
    });

    it("sends the current head while an agent's record can't be read, saying so once, and records it again", async () => {
      await withFramework([resident('alpha'), resident('beta')], async (framework) => {
        const internals = framework as unknown as Internals;
        const [alpha, beta] = [framework.getAgent('alpha')!, framework.getAgent('beta')!];
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.equal(storedChanges(alpha, 'alpha'), 1, 'the premise: alpha declared a change of its own');
        await beta.buildActivationRequest([tool('b')]);
        const get = internals.store.getStateJson.bind(internals.store);
        internals.store.getStateJson = (id) => {
          if (id === 'framework/head-declarations/alpha') throw new Error('unreadable');
          return get(id);
        };
        const errors: string[] = [];
        const error = console.error;
        console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
        try {
          const request = await alpha.buildActivationRequest([tool('a'), tool('c')]);
          assert.deepEqual(request.tools, [tool('a'), tool('c')], 'what is current');
          assert.deepEqual(changesIn(request.messages), [], 'with its own change row taken out of the request');
          assert.equal(storedChanges(alpha, 'alpha'), 0, 'and out of its context');
          await alpha.buildActivationRequest([tool('a'), tool('c')]);
        } finally {
          console.error = error;
          internals.store.getStateJson = get;
        }
        assert.deepEqual(errors, ['[head-declarations] alpha: the recorded head could not be read, so its requests go on its current head with no change row, and it records that head once it can; a record that reads again before then is the head its next request declares from:'], 'said once on the branch');
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
      assert.deepEqual(internals.headDeclarations.read('alpha')!.system, [prompt('You are alpha.'), 'v2']);
      const host = framework as unknown as { handleHostCommand(server: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> };
      const undone = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 2 });
      assert.equal(undone.ok, true, undone.error);
      assert.deepEqual(internals.headDeclarations.read('alpha')!.system, [prompt('You are alpha.'), 'v1'], "the undo's branch has the head from before the move");
    });
  });

  it('forgets for good a head deleted on a model that takes no change: a restart on one that takes them adopts afresh', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-declarations-delete-'));
    const storePath = join(tempDir, 'store.chronicle');
    try {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(framework, alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
      }, storePath);
      await withFramework([{ ...resident('alpha'), model: TAKES_NONE }], async (framework) => {
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

  it("folds a host's change row in the residents' shared slot into each resident's request; the subconscious, whose context can't remove it, goes out without change rows; and a resident's move takes it from the slot", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const subconscious = framework.getAgent('Subconscious')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(framework, alpha, 'user', 'hello, both');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      await beta.buildActivationRequest([tool('x')]);
      const hostChange: ContentBlock[] = [{ type: 'system_change', defineTools: [tool('h')] }];
      const hostRow = (framework as unknown as { addMessage(participant: string, content: ContentBlock[]): string }).addMessage('system', hostChange);
      assert.ok(audienceOf(alpha.getContextManager().getMessage(hostRow as never)!.metadata), "the premise: the host's untargeted write is stamped for the residents");
      const alphaRequest = await alpha.buildActivationRequest([tool('a')], system('v1'));
      assert.deepEqual(changesIn(alphaRequest.messages), [hostChange, [{ type: 'system_change', removeTools: ['h'] }]], "alpha's request carries the host's row, and declares that alpha doesn't hold h");
      assert.deepEqual(foldOf(alphaRequest), now([tool('a')], `${prompt('You are alpha.')}\nv1`));
      const betaRequest = await beta.buildActivationRequest([tool('x')]);
      assert.deepEqual(foldOf(betaRequest), now([tool('x')], prompt('You are beta.')), "beta's folds to its own tools too");
      const subRequest = await subconscious.buildActivationRequest([tool('think')]);
      assert.deepEqual(changesIn(subRequest.messages), [], "the subconscious's goes out with no change row");
      assert.deepEqual(foldOf(subRequest), now([tool('think')], prompt('You attend.')));
      assert.ok(subRequest.messages.some((m) => (m.content[0] as { text?: string }).text === 'hello, both'), 'while the conversation reads through');
      assert.ok(alpha.getContextManager().getMessage(hostRow as never), "the host's row stays in the slot the subconscious only reads");
      await alpha.buildActivationRequest([tool('a')], system('v2'));
      assert.equal(alpha.getContextManager().getMessage(hostRow as never), null, "alpha's move took the host's row from the slot");
      assert.deepEqual(foldOf(await beta.buildActivationRequest([tool('x')])), now([tool('x')], prompt('You are beta.')), 'and beta still folds to its own tools');
    }, undefined, { subconscious: { enabled: true, systemPrompt: prompt('You attend.') } });
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
    }, undefined, { subconscious: { enabled: true, systemPrompt: prompt('You attend.') } });
  });
});
