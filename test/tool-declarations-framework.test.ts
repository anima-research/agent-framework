/**
 * toolDeclarations where the framework meets it: the recorded heads
 * outlive a restart, residents sharing one message slot each read only their
 * own system changes, a fork starts from its template's head and changes,
 * host `/undo N` counts the conversation's messages, the poisoned-history
 * shed leaves a change row be, and history's tools label one.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, NormalizedMessage, ToolDefinition } from '@animalabs/membrane';

import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import { AgentFramework, isSystemChangeMessage, systemChangeMetadata, type Agent, type ToolCall } from '../src/index.js';
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

/** The assembly, for what it returns beside the request: the compile it was built from and the binding its stream notes with. */
type Assembling = {
  assembleActivationRequest(tools: ToolDefinition[]): Promise<{
    request: { messages: NormalizedMessage[] };
    compiled: { provenance?: { compileId?: string } };
    binding: { identity?: unknown };
  }>;
};

const say = (agent: Agent, participant: string, text: string) =>
  agent.getContextManager().addMessage(participant, [{ type: 'text', text } as ContentBlock]);

describe('toolDeclarations in the framework', () => {
  it('keeps each resident\'s system changes its own in the slot they share, and traces them', async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const traces: TraceEvent[] = [];
      framework.onTrace((event) => { traces.push(event); });
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      say(alpha, 'user', 'hello, both');
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

  it('keeps a resident\'s recorded head across a restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-declarations-restart-'));
    const storePath = join(tempDir, 'store.chronicle');
    try {
      let before: NormalizedMessage[] = [];
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(alpha, 'user', 'hello');
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
      say(alpha, 'user', 'one');
      await alpha.buildActivationRequest([tool('a')]);
      say(alpha, 'alpha', 'two');
      say(alpha, 'user', 'three');
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      say(alpha, 'alpha', 'four');
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
    // Left out, `binds` counts as a model that may bind, and the context manager keeps no
    // record, so the compile keeps the reply's thinking. With `binds: true` and the drop
    // control, the record keeps a reply stored before it began, and a move of the head
    // changes the digests the compile is told, so that compile leaves the thinking out.
    for (const [binding, clause] of [
      [undefined, /: one whole write, and the thinking the request held set aside if its model binds it$/],
      [{ binds: true, dropBlock: true }, /: one whole write, and the thinking the request held set aside$/],
    ] as const) {
      await withFramework([{ ...resident('alpha'), ...(binding ? { thinkingBinding: binding } : {}) }], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const alpha = framework.getAgent('alpha')!;
        say(alpha, 'user', 'hello');
        // A reply's thinking before the change, so no compile is free for a binding model.
        alpha.getContextManager().addMessage('alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
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
        say(alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
        // Past a fifth with no free compile: the declared change is in the last committing compile, so nothing re-renders it.
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
      // The move the budget forces, as the agent reports it.
      (alpha as unknown as { onHeadEvent(e: unknown): void }).onHeadEvent({ type: 'head:moved', why: 'consolidated', changesRemoved: 2, forced: 'budget' });
      const alerts = traces.filter((t) => t.type === 'ops:alert' && (t as { kind: string }).kind === 'head-consolidated') as { message: string; data?: Record<string, unknown> }[];
      assert.equal(alerts.length, 1);
      assert.match(alerts[0]!.message, /^a compile was refused over budget with 2 system changes kept, so the head took them and the compile ran again: one whole write/);
      assert.deepEqual(alerts[0]!.data, { forced: 'budget', changesRemoved: 2 });
    });
  });

  it("builds a declared change's request from the compile that wrote the record, so a note under it is taken, with `binds: true`", async () => {
    await withFramework([{ ...resident('alpha'), thinkingBinding: { binds: true, dropBlock: true } }], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      const assembled = await (alpha as unknown as Assembling).assembleActivationRequest([tool('a'), tool('b')]);
      assert.deepEqual(changesIn(assembled.request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], 'declared');
      assert.equal(alpha.getContextManager().noteRequestSent([], assembled.binding.identity as never, assembled.compiled.provenance!.compileId!), true,
        'a note under its compile is taken: that compile wrote the record');
    });
  });

  it("compiles again on the head once it takes the agent's own change rows out, so a reply after keeps its thinking, with `binds: true`", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'tool-declarations-onhead-'));
    const storePath = join(tempDir, 'store.chronicle');
    const binding = { binds: true, dropBlock: true };
    try {
      await withFramework([{ ...resident('alpha'), thinkingBinding: binding }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        await alpha.buildActivationRequest([tool('a'), tool('b')]);
      }, storePath);
      // The same agent built on its head: its change row from the 'entries' period goes.
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head', thinkingBinding: binding }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        const assembled = await (alpha as unknown as Assembling).assembleActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(changesIn(assembled.request.messages), []);
        const cm = alpha.getContextManager();
        assert.equal(cm.getAllMessages().filter(isChange).length, 0, 'the change row went');
        // The reply, as its stream stores it and notes it.
        const reply = cm.addMessage('alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
        assert.equal(cm.noteRequestSent([reply], assembled.binding.identity as never, assembled.compiled.provenance!.compileId!), true);
        const next = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        assert.ok(next.messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking')), 'the reply keeps its thinking at the next compile');
      }, storePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('leaves out the thinking a replacement of the head sets aside, with `binds: true`, and keeps it past a declared change', async () => {
    const hasThinking = (messages: readonly NormalizedMessage[]) => messages.some((m) => m.content.some((b) => (b as { type?: string }).type === 'thinking'));
    await withFramework([{ ...resident('alpha'), thinkingBinding: { binds: true, dropBlock: true } }], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(alpha, 'user', 'hello');
      alpha.getContextManager().addMessage('alpha', [{ type: 'thinking', thinking: 'why', signature: 's' } as ContentBlock, { type: 'text', text: 'so' } as ContentBlock]);
      say(alpha, 'user', 'and then');
      assert.ok(hasThinking((await alpha.buildActivationRequest([tool('a')], system('v1'))).messages), 'adopted');
      assert.ok(hasThinking((await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'))).messages), 'a declared change');
      const replaced = await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
      assert.equal(replaced.system, 'You are alpha.\nv2', 'the head moved');
      assert.equal(hasThinking(replaced.messages), false, 'and the compile for it left the thinking out');
      await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2'));
    });
  });

  describe("an ephemeral agent's headFrom", () => {
    /** A resident with one declared change, and an ephemeral child seeded with its compiled rows, as a host's fork seeds one. */
    async function forked(framework: AgentFramework, parentConfig: Record<string, unknown>, options: { headFrom?: string }, name: string) {
      const alpha = framework.getAgent('alpha')!;
      say(alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const { messages } = await alpha.getContextManager().compile(undefined, undefined, { dryRun: true });
      // A fork shares its parent's system prompt.
      const { agent: child } = await framework.createEphemeralAgent({ ...resident(name), systemPrompt: 'You are alpha.', ...parentConfig } as never, options);
      for (const m of messages) {
        if (isSystemChangeMessage(m)) child.getContextManager().addMessage(m.participant, m.content, systemChangeMetadata(name) as never);
        else child.getContextManager().addMessage(m.participant, m.content);
      }
      return { alpha, child };
    }

    it("starts the child on its parent's head, so its first request carries the parent's prefix and declares nothing", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const traces: TraceEvent[] = [];
        framework.onTrace((event) => { traces.push(event); });
        const { child } = await forked(framework, {}, { headFrom: 'alpha' }, 'alpha-child');
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], "the parent's recorded head");
        assert.deepEqual(changesIn(request.messages), [[{ type: 'system_change', defineTools: [tool('b')] }]], "and the parent's change, once");
        assert.deepEqual(traces.filter((t) => (t as { agentName?: string }).agentName === 'alpha-child' && t.type.startsWith('head:')), [], 'no adoption, no declaration');
      });
    });

    it("keeps the child's head its own: neither one's moves reach the other's record", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const { alpha, child } = await forked(framework, {}, { headFrom: 'alpha' }, 'alpha-child');
        await child.buildActivationRequest([tool('a'), tool('b'), tool('c')]);
        const heads = framework as unknown as { headDeclarations: { read(name: string): { tools: { name: string }[] } | null } };
        assert.deepEqual(heads.headDeclarations.read('alpha')!.tools.map((t) => t.name), ['a'], "the child's change left the parent's record");
        const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
        await alpha.buildActivationRequest([tool('a'), tool('b')], system('v1'));
        await alpha.buildActivationRequest([tool('a'), tool('b')], system('v2')); // a replacement moves the parent's head
        assert.deepEqual(heads.headDeclarations.read('alpha')!.tools.map((t) => t.name), ['a', 'b'], 'the parent moved its head');
        const again = await child.buildActivationRequest([tool('a'), tool('b'), tool('c')]);
        assert.deepEqual(again.tools, [tool('a')], "and the child's record stayed as it was copied");
      });
    });

    it("gives a child nothing from a parent on its head, so it starts as an unseeded child does", async () => {
      await withFramework([{ ...resident('alpha'), toolDeclarations: 'head' }], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        // A record left from an earlier 'entries' period, not yet deleted by a request on the head.
        const heads = framework as unknown as { headDeclarations: { write(name: string, head: unknown): void } };
        heads.headDeclarations.write('alpha', { tools: [tool('old')], system: ['You are alpha.'] });
        // Both children share the parent's system prompt, as forks do.
        const seeded = (await framework.createEphemeralAgent({ ...resident('seeded'), systemPrompt: 'You are alpha.' } as never, { headFrom: 'alpha' })).agent;
        const unseeded = (await framework.createEphemeralAgent({ ...resident('unseeded'), systemPrompt: 'You are alpha.' } as never)).agent;
        for (const child of [seeded, unseeded]) child.getContextManager().addMessage('user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        const [a, b] = [await seeded.buildActivationRequest([tool('x')]), await unseeded.buildActivationRequest([tool('x')])];
        assert.deepEqual([a.tools, a.messages], [b.tools, b.messages]);
      });
    });

    it("keeps the child's head as recorded when what the parent's request carries is changed in place", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const { alpha, child } = await forked(framework, {}, { headFrom: 'alpha' }, 'alpha-child');
        const parentRequest = await alpha.buildActivationRequest([tool('a'), tool('b')]);
        parentRequest.tools![0]!.description = 'changed in place, as a hook might';
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a')], "the child's head as copied");
      });
    });

    it("reads the parent's head once the child's context is open, the nearest point to the host's copy of the parent's messages", async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        say(alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        const pending = framework.createEphemeralAgent({ ...resident('child'), systemPrompt: 'You are alpha.' } as never, { headFrom: 'alpha' });
        // The parent's head moves while the child's context opens.
        const heads = framework as unknown as { headDeclarations: { write(name: string, head: unknown): void } };
        heads.headDeclarations.write('alpha', { tools: [tool('a'), tool('b')], system: ['You are alpha.'] });
        const { agent: child } = await pending;
        child.getContextManager().addMessage('user', [{ type: 'text', text: 'hello' } as ContentBlock]);
        const request = await child.buildActivationRequest([tool('a'), tool('b')]);
        assert.deepEqual(request.tools, [tool('a'), tool('b')], "the parent's head as moved");
        assert.deepEqual(changesIn(request.messages), [], 'with nothing to declare');
      });
    });

    it('refuses a headFrom that names no running agent, naming it', async () => {
      await withFramework([resident('alpha')], async (framework) => {
        await assert.rejects(framework.createEphemeralAgent(resident('child') as never, { headFrom: 'nobody' }), /headFrom names no running agent: "nobody"/);
      });
    });
  });

  it("reports after host /undo the last conversational message the agent sees, not a change after it", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(alpha, 'user', 'one');
      await alpha.buildActivationRequest([tool('a')]);
      say(alpha, 'alpha', 'two');
      say(alpha, 'user', 'three');
      say(alpha, 'alpha', 'four');
      const host = framework as unknown as { handleHostCommand(server: string, params: Record<string, unknown>): Promise<{ ok: boolean; error?: string; lastVisible?: { participant?: string; preview?: string } | null }> };
      // The preview after the undo ends on 'three', then the change declaring the framework's own
      // tools (none) where the recorded head has `a`.
      const result = await host.handleHostCommand('test', { command: 'undo', agentName: 'alpha', messages: 1 });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.lastVisible?.participant, 'user', JSON.stringify(result.lastVisible));
      assert.match(result.lastVisible?.preview ?? '', /three/);
    });
  });

  it("starts a fork from its template's head and changes, and declares only the fork's own difference", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const internals = framework as unknown as { createConversationAgent(name: string, channelId: string): Promise<Agent> };
      const fork = await internals.createConversationAgent('alpha-fork', 'chanA');
      const rows = fork.getContextManager().getAllMessages().filter(isChange);
      assert.equal(rows.length, 1, "the template's change, copied");
      assert.deepEqual(rows[0]!.metadata, { system: true, kind: 'system-change', agent: 'alpha-fork' }, 'as the fork\'s own');
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

  it("copies a host's change row into a fork as no agent's own, so the fork's moves leave it", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      const hostChange = [{ type: 'system_change', defineTools: [tool('h')] }] as unknown as ContentBlock[];
      alpha.getContextManager().addMessage('system', hostChange);
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
      say(alpha, 'user', 'hello');
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
      say(alpha, 'user', 'hello');
      await alpha.buildActivationRequest([tool('a')]);
      say(alpha, 'alpha', 'a reply');
      say(alpha, 'user', 'go on');
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      const internals = framework as unknown as { shedNewestTurn(agent: Agent): unknown };
      internals.shedNewestTurn(alpha);
      const left = alpha.getContextManager().getAllMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.ok(left.includes('change'), `the change stayed: ${JSON.stringify(left)}`);
      assert.ok(!left.includes('go on'), 'the newest turn went');
    });
  });

  it('passes over a change row a host stored without metadata in the poisoned-history shed, as it does a stamped one', async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      say(alpha, 'user', 'hello');
      say(alpha, 'alpha', 'a reply');
      say(alpha, 'user', 'go on');
      alpha.getContextManager().addMessage('system', [{ type: 'system_change', defineTools: [tool('x')] } as ContentBlock]);
      const internals = framework as unknown as { shedNewestTurn(agent: Agent): unknown };
      internals.shedNewestTurn(alpha);
      const left = alpha.getContextManager().getAllMessages().map((m) => (isChange(m) ? 'change' : (m.content[0] as { text: string }).text));
      assert.deepEqual(left, ['hello', 'a reply', 'change'], 'the newest turn went, and the change stayed');
    });
  });

  it("leaves another resident's change rows be when one resident moves its head", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      say(alpha, 'user', 'hello, both');
      await alpha.buildActivationRequest([tool('a')]);
      await beta.buildActivationRequest([tool('x')], [{ namespace: 'm', position: 'system', content: [{ type: 'text', text: 'v1' }] }] as never);
      await alpha.buildActivationRequest([tool('a'), tool('b')]);
      await beta.buildActivationRequest([tool('x')], [{ namespace: 'm', position: 'system', content: [{ type: 'text', text: 'v2' }] }] as never);
      const owners = alpha.getContextManager().getAllMessages().filter(isChange).map((m) => (m.metadata as { agent?: string }).agent);
      assert.deepEqual(owners, ['alpha'], "beta's move took only its own, and alpha's change stays");
    });
  });

  it("waits to declare while the shared slot ends on another resident's call, and declares after its result", async () => {
    await withFramework([resident('alpha'), resident('beta')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const beta = framework.getAgent('beta')!;
      const cm = alpha.getContextManager();
      say(alpha, 'user', 'hello');
      await beta.buildActivationRequest([tool('x')]);
      cm.addMessage('alpha', [{ type: 'tool_use', id: 'call-1', name: 'a', input: {} } as ContentBlock]);
      // A change right after a call, whoever made it, would stand between it and its result: beta's waits.
      await beta.buildActivationRequest([tool('x'), tool('y')]);
      assert.equal(cm.getAllMessages().filter(isSystemChangeMessage).length, 0, 'nothing declared while the call waits');
      cm.addMessage('user', [{ type: 'tool_result', toolUseId: 'call-1', content: 'ok' } as ContentBlock]);
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
    /** The ids of the states written while `run` runs. */
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
        say(alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')], system('v1'));
        await beta.buildActivationRequest([tool('b')]);
        const betaHead = internals.store.getStateJson('framework/head-declarations/beta');
        const written = await statesWritten(internals.store, () => alpha.buildActivationRequest([tool('a')], system('v2')));
        assert.deepEqual(written, ['framework/head-declarations/alpha'], "alpha's replacement writes alpha's state alone");
        assert.deepEqual((internals.store.getStateJson('framework/head-declarations/alpha') as { system: string[] }).system, ['You are alpha.', 'v2']);
        assert.deepEqual(internals.store.getStateJson('framework/head-declarations/beta'), betaHead);
      });
    });

    it("registers an agent's state at its first write, and none for an agent on its head", async () => {
      const registered: string[] = [];
      await withFramework([resident('alpha'), { ...resident('beta'), toolDeclarations: 'head' }], async (framework) => {
        const internals = framework as unknown as Internals & { store: { registerState(r: { id: string }): void } };
        const register = internals.store.registerState.bind(internals.store);
        internals.store.registerState = (r) => { registered.push(r.id); return register(r); };
        const [alpha, beta] = [framework.getAgent('alpha')!, framework.getAgent('beta')!];
        say(alpha, 'user', 'hello');
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
        say(alpha, 'user', 'hello');
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
        say(alpha, 'user', 'hello');
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
        say(alpha, 'user', 'hello');
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
        say(alpha, 'user', 'hello');
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
        say(alpha, 'user', 'hello');
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
        assert.deepEqual(errors, ['[head-declarations] alpha: the recorded head could not be read:'], 'said once on the branch');
        assert.deepEqual((get('framework/head-declarations/alpha') as { tools: ToolDefinition[] }).tools, [tool('a'), tool('c')], 'the record is written again');
        assert.deepEqual((internals.headDeclarations.read('beta') as { tools: ToolDefinition[] }).tools, [tool('b')], "beta's is read as before");
      });
    });
  });

  it("reads the recorded heads again after a branch switch, as the branch has them", async () => {
    await withFramework([resident('alpha')], async (framework) => {
      const alpha = framework.getAgent('alpha')!;
      const system = (text: string) => [{ namespace: 'm', position: 'system', content: [{ type: 'text', text }] }] as never;
      say(alpha, 'user', 'zero');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      say(alpha, 'user', 'one');
      say(alpha, 'alpha', 'two');
      say(alpha, 'user', 'three');
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
        say(alpha, 'user', 'hello');
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
      say(alpha, 'user', 'hello, both');
      await alpha.buildActivationRequest([tool('a')], system('v1'));
      await beta.buildActivationRequest([tool('x')]);
      const hostChange = [{ type: 'system_change', defineTools: [tool('h')] }] as unknown as ContentBlock[];
      alpha.getContextManager().addMessage('system', hostChange);
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

  for (const order of ['a change, then a stored injection', 'a stored injection, then a change', 'a stored injection, then a change a dry run shows'] as const) {
    it(`ends a resident's request on its own turn past ${order} after it, with its [Continue] last`, async () => {
      await withFramework([resident('alpha')], async (framework) => {
        const alpha = framework.getAgent('alpha')!;
        const store = (framework as unknown as { storeInjections(agent: Agent, injections: unknown[]): unknown });
        const lesson = { namespace: 'lessons', position: 'afterUser', content: [{ type: 'text', text: 'LESSON' }] };
        say(alpha, 'user', 'hello');
        await alpha.buildActivationRequest([tool('a')]);
        say(alpha, 'alpha', 'my reply');
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
});
