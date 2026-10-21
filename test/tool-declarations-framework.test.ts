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
import { AgentFramework, isSystemChangeMessage, type Agent, type ToolCall } from '../src/index.js';
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
      const heads = framework as unknown as { headDeclarations: { read(name: string): unknown }; disposeConversationAgent(name: string): void };
      assert.notEqual(heads.headDeclarations.read('alpha-fork'), null);
      heads.disposeConversationAgent('alpha-fork');
      assert.equal(heads.headDeclarations.read('alpha-fork'), null, 'a closed fork\'s head goes with it');
      assert.notEqual(heads.headDeclarations.read('alpha'), null);
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
});
