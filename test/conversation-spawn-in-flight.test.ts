/**
 * A channel's fork is spawned once, and every message that arrives on the
 * channel while it is being spawned goes where it would have gone just after.
 * The event queue and the coalescer each handle their messages one at a time,
 * but they run beside each other, and a spawn can wait, as a fork's seed waits
 * for its template's annotations. A routing that decided on the same spawn
 * meanwhile used to spawn the same name again, which failed ("already
 * registered or reserved"), and a message that didn't qualify on its own was
 * dropped as unrouted; either way its message was lost. Now a routing on that
 * channel waits for the spawn in flight and decides then: into the fork once
 * it is bound, or, if the spawn failed, as a message arriving next would.
 *
 * Each test holds the template's aborted batch mid-annotation (its spill
 * waits on a gate), so the first routing's spawn waits in its seed until the
 * test opens the gate. Where a fork's turn runs (a mention, or a batch's
 * wake), the fixture's membrane answers it.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceEvent } from '../src/index.js';
import { createMockResponse } from './helpers/mock-membrane.js';
import { fixture } from './helpers/coalescing-fixture.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';

const unscripted: string[] = [];
afterEach(() => {
  assert.deepEqual(unscripted.splice(0), [], 'every inference the framework asked for was one the test scripted');
});

/** The fixture's channel `chat` is on its server `editor`. */
const FORK = forkAgentName('conversation', 'editor', 'chat', 1);
const NEXT_FORK = forkAgentName('conversation', 'editor', 'chat', 2);

/** A gate a test opens itself, and a wait for a condition the code under
 *  test makes true (no fixed timers standing in for events). */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting until ${what}`);
}

/** A plain channels/incoming message for `chat`: no coalesce, so the event
 *  queue delivers it. Not a mention unless `metadata` says so. */
const plain = (messageId: string, text: string, metadata?: Record<string, unknown>) => ({
  channelId: 'chat', messageId, timestamp: new Date().toISOString(), author: { id: 'u', name: 'User' },
  content: [{ type: 'text', text }], ...(metadata ? { metadata } : {}),
});

/** A deferred channel-scoped batch for `chat`, whose wake looks up its
 *  audience, spawning the fork if none is bound. */
const BATCH_FLAGS = { deferred: true, channelId: 'chat', key: 'activity' };

/**
 * The coalescing fixture with conversation routing (by default on every
 * channel message, triggering only on a mention) and the template's aborted
 * batch held mid-annotation. `seeds` counts the template's compiles that wait
 * for its annotations, a fork's seed among them; `routings` counts routings
 * of incoming channel messages and `audiences` a batch's audience lookups;
 * `failures`, `spawned` and `unrouted` collect the routing traces.
 */
async function heldTemplate(options: { server?: Record<string, unknown>; conversations?: Record<string, unknown> } = {}) {
  const f = await fixture({
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'system', toolResultGuard: true }],
    framework: {
      conversations: options.conversations ?? { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'mention' } },
    } as never,
    server: options.server ?? {},
  });
  const write = gate();
  let spills = 0;
  (f.framework as unknown as { spillWithheld: () => Promise<null> }).spillWithheld = async () => {
    spills++;
    await write.opened;
    return null;
  };
  const responses: unknown[] = [
    createMockResponse([{ type: 'tool_use', id: 'one', name: 'test--read', input: {} }], 'tool_use'),
    { aborted: true, reason: 'test-abort' },
  ];
  let calls = 0;
  (f.membrane as unknown as { stream: () => Promise<unknown> }).stream = async () => {
    calls++;
    const response = responses.shift();
    if (!response) {
      unscripted.push(`call ${calls}`);
      throw new Error('unexpected inference');
    }
    return response;
  };
  const template = f.framework.getAgent('agent')!;
  template.getContextManager().addMessage('user', [{ type: 'text', text: 'read' }]);
  await template.runInference(f.framework.getAllTools());
  template.provideToolResult('one', { success: true, data: 'original' });
  assert.equal((await template.runInference(f.framework.getAllTools())).aborted, true);
  await until(() => spills === 1, "the template's aborted batch is being annotated");

  const seeds = { calls: 0 };
  const guard = template.toolResultGuard;
  const afterAnnotations = guard.afterAnnotations.bind(guard);
  guard.afterAnnotations = (read) => { seeds.calls++; return afterAnnotations(read); };
  const internals = f.framework as unknown as {
    routeConversationIncoming: (...args: unknown[]) => Promise<unknown>;
    coalescedAudience: (...args: unknown[]) => Promise<string[]>;
  };
  const routings = { calls: 0 };
  const route = internals.routeConversationIncoming.bind(f.framework);
  internals.routeConversationIncoming = (...args) => { routings.calls++; return route(...args); };
  const audiences = { calls: 0 };
  const audience = internals.coalescedAudience.bind(f.framework);
  internals.coalescedAudience = (...args) => { audiences.calls++; return audience(...args); };
  const failures: string[] = [];
  const spawned: string[] = [];
  const unrouted: string[] = [];
  f.framework.onTrace((e: TraceEvent) => {
    if (e.type === 'mcpl:conversation-spawn-failed') failures.push((e as { error: string }).error);
    if (e.type === 'mcpl:conversation-spawned') spawned.push((e as { agentName: string }).agentName);
    if (e.type === 'mcpl:conversation-unrouted') unrouted.push((e as { messageId: string }).messageId);
  });
  await f.register('chat');
  const holds = (text: string) => JSON.stringify(f.framework.getAgent(FORK)?.getContextManager().getAllMessages() ?? []).includes(text);
  return { f, write, seeds, routings, audiences, failures, spawned, unrouted, holds };
}

/** The template's next compile, the first spawn's seed, fails once. */
function failNextSeed(t: Awaited<ReturnType<typeof heldTemplate>>) {
  const manager = t.f.framework.getAgent('agent')!.getContextManager();
  const compile = manager.compile.bind(manager);
  let failNext = true;
  manager.compile = ((...args: Parameters<typeof compile>) => {
    if (!failNext) return compile(...args);
    failNext = false;
    return Promise.reject(new Error('the template could not be compiled (test)'));
  }) as typeof compile;
}

describe('messages on a channel whose fork is being spawned', () => {
  it('a coalesced message routed while a plain message spawns the fork goes into that fork', async () => {
    const t = await heldTemplate();
    try {
      await t.f.send('channels/incoming', { messages: [plain('p1', 'first-plain')] });
      const queue = t.f.framework.runUntilIdle();
      await until(() => t.seeds.calls > 0, "the plain message's spawn waits for its seed");
      const coalesced = t.f.send('channels/incoming', { messages: [t.f.channel('e2', 'second-coalesced', { initial: true }, 'chat', 'm2')] });
      await until(() => t.routings.calls === 2, 'the coalesced message is being routed');
      t.write.open();
      await Promise.all([queue, coalesced]);
      assert.deepEqual(t.failures, []);
      assert.deepEqual(t.spawned, [FORK], 'one spawn');
      assert.equal(t.f.framework.getAgent(NEXT_FORK), null);
      assert.ok(t.holds('first-plain'), 'the fork holds the plain message');
      assert.ok(t.holds('second-coalesced'), 'and the coalesced one');
    } finally {
      t.write.open();
      await t.f.close();
    }
  });

  it('an unmentioned message routed while a mention spawns the fork goes into that fork', async () => {
    const t = await heldTemplate({ conversations: { templateAgent: 'agent', bind: { channel: 'mention' }, trigger: { channel: 'mention' } } });
    t.f.alwaysRespond();
    try {
      await t.f.send('channels/incoming', { messages: [plain('p1', 'first-mention', { mentioned: true })] });
      const queue = t.f.framework.runUntilIdle();
      await until(() => t.seeds.calls > 0, "the mention's spawn waits for its seed");
      // On its own it wouldn't bind the channel, so it decides `unbound`
      // unless it waits for the fork.
      const coalesced = t.f.send('channels/incoming', { messages: [t.f.channel('e2', 'second-unmentioned', { initial: true }, 'chat', 'm2')] });
      await until(() => t.routings.calls === 2, 'the unmentioned message is being routed');
      t.write.open();
      await Promise.all([queue, coalesced]);
      await t.f.framework.runUntilIdle();
      assert.deepEqual(t.unrouted, [], 'nothing was dropped as unrouted');
      assert.deepEqual(t.spawned, [FORK]);
      assert.ok(t.holds('first-mention'), 'the fork holds the mention');
      assert.ok(t.holds('second-unmentioned'), 'and the unmentioned message');
    } finally {
      t.write.open();
      await t.f.close();
    }
  });

  it("a plain message routed while a batch's audience spawns the fork goes into that fork", async () => {
    const t = await heldTemplate({ server: { shouldTriggerInference: () => true } });
    t.f.alwaysRespond();
    try {
      const pushed = t.f.send('push/event', t.f.params('b1', 'batch', BATCH_FLAGS));
      await until(() => t.seeds.calls > 0, "the batch's spawn waits for its seed");
      await t.f.send('channels/incoming', { messages: [plain('p1', 'plain-during-batch')] });
      const queue = t.f.framework.runUntilIdle();
      await until(() => t.routings.calls === 1, 'the plain message is being routed');
      t.write.open();
      await Promise.all([pushed, queue]);
      await t.f.framework.runUntilIdle();
      assert.deepEqual(t.failures, []);
      assert.ok(t.f.framework.getAgent(FORK), "the batch's audience spawned the fork");
      assert.equal(t.f.framework.getAgent(NEXT_FORK), null);
      assert.ok(t.holds('plain-during-batch'), 'the fork holds the plain message');
    } finally {
      t.write.open();
      await t.f.close();
    }
  });

  it("a batch whose audience is looked up while a plain message spawns the fork wakes that fork", async () => {
    const t = await heldTemplate({ server: { shouldTriggerInference: () => true } });
    t.f.alwaysRespond();
    try {
      await t.f.send('channels/incoming', { messages: [plain('p1', 'first-plain')] });
      const queue = t.f.framework.runUntilIdle();
      await until(() => t.seeds.calls > 0, "the plain message's spawn waits for its seed");
      const pushed = t.f.send('push/event', t.f.params('b1', 'batch', BATCH_FLAGS));
      await until(() => t.audiences.calls > 0, "the batch's audience is being looked up");
      t.write.open();
      await Promise.all([queue, pushed]);
      await t.f.framework.runUntilIdle();
      assert.deepEqual(t.spawned, [FORK], 'one spawn');
      assert.equal(t.f.framework.getAgent(NEXT_FORK), null);
      assert.ok(t.holds('first-plain'), 'the fork holds the plain message');
      assert.ok(t.holds('document_diff'), "and the batch it was woken for, as rendered at the fork's turn");
    } finally {
      t.write.open();
      await t.f.close();
    }
  });

  it('a coalesced message waiting on a spawn that fails proposes the spawn itself', async () => {
    const t = await heldTemplate();
    failNextSeed(t);
    try {
      await t.f.send('channels/incoming', { messages: [plain('p1', 'first-plain')] });
      const queue = t.f.framework.runUntilIdle();
      await until(() => t.seeds.calls > 0, "the plain message's spawn waits for its seed");
      const coalesced = t.f.send('channels/incoming', { messages: [t.f.channel('e2', 'second-coalesced', { initial: true }, 'chat', 'm2')] });
      await until(() => t.routings.calls === 2, 'the coalesced message is being routed');
      t.write.open();
      await Promise.all([queue, coalesced]);
      assert.deepEqual(t.failures, ['the template could not be compiled (test)'], "the first spawn's failure, traced");
      assert.deepEqual(t.spawned, [FORK], "the waiting routing's own spawn");
      assert.ok(t.holds('second-coalesced'), 'the fork holds the waiting message');
      assert.equal(t.holds('first-plain'), false, "the failed spawn's message isn't in it, as before");
    } finally {
      t.write.open();
      await t.f.close();
    }
  });

  it("a plain message waiting on a batch's spawn that fails proposes the spawn itself", async () => {
    const t = await heldTemplate({ server: { shouldTriggerInference: () => true } });
    t.f.alwaysRespond();
    failNextSeed(t);
    try {
      const pushed = t.f.send('push/event', t.f.params('b1', 'batch', BATCH_FLAGS));
      await until(() => t.seeds.calls > 0, "the batch's spawn waits for its seed");
      await t.f.send('channels/incoming', { messages: [plain('p1', 'plain-after-batch')] });
      const queue = t.f.framework.runUntilIdle();
      await until(() => t.routings.calls === 1, 'the plain message is being routed');
      t.write.open();
      await Promise.all([pushed, queue]);
      // The batch's failed spawn is logged on its path, not traced.
      assert.deepEqual(t.failures, []);
      assert.deepEqual(t.spawned, [FORK], "the waiting message's own spawn");
      assert.ok(t.holds('plain-after-batch'), 'the fork holds the waiting message');
    } finally {
      t.write.open();
      await t.f.close();
    }
  });
});
