import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { FrameworkConfig } from '../src/types/framework.js';
import { fixture, crash } from './helpers/coalescing-fixture.js';

const conversations = {
  templateAgent: 'agent',
  bind: { channel: 'always' as const },
  trigger: { channel: 'always' as const },
  idleTtlMs: 60_000,
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setup(t: TestContext, options: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture({
    ...options,
    framework: { conversations, ...options.framework },
  });
  t.after(f.close);
  f.alwaysRespond();
  await f.register();
  return f;
}

function plain(f: Fixture, id: string, text: string, extra: Record<string, unknown> = {}) {
  const { coalesce: _coalesce, ...message } = f.channel(id, text, {}, 'chat', id);
  return { ...message, ...extra };
}

async function sendPlain(f: Fixture, id: string, text: string, extra: Record<string, unknown> = {}) {
  const result = await f.send('channels/incoming', { messages: [plain(f, id, text, extra)] });
  assert.equal(result.result.results[0].accepted, true);
  await f.framework.runUntilIdle();
}

for (const [label, identity] of [
  ['self tag', { tags: ['chat:from-self'], author: { id: 'self', name: 'Self' } }],
  ['matching botUserId', { tags: ['chat:from-bot'], author: { id: 'self', name: 'Self' }, metadata: { botUserId: 'self' } }],
] as const) {
  test('conversation echoes identified by ' + label + ' keep context but do not wake, touch, or rebind', async (t) => {
    const f = await setup(t);
    await sendPlain(f, 'human', 'counterpart starts engagement');
    const router = f.framework.getConversationRouter()!;
    const binding = router.getBinding('chat')!;
    const oldActivity = Date.now() - 1000;
    binding.lastActivity = oldActivity;
    const calls = f.membrane.calls.length;

    await sendPlain(f, 'echo', 'self echo retained', identity);
    assert.equal(binding.lastActivity, oldActivity, 'self speech must not renew idle lifetime');
    assert.equal(f.membrane.calls.length, calls, 'self echoes do not request inference');
    assert(f.context(binding.agentName).includes('self echo retained'), 'bound context retains accepted echoes');
    assert.deepEqual(router.expired(oldActivity + conversations.idleTtlMs + 1), [binding]);

    router.unbind('chat');
    await sendPlain(f, 'late-echo', 'self echo after engagement', identity);
    assert.equal(router.getBinding('chat'), undefined, 'self echoes cannot create another engagement');
    assert.equal(router.exportGenerations().chat, 1, 'no generation consumed by the echo');
    assert.equal(f.membrane.calls.length, calls);
  });
}

test('other bots and unknown self identity remain legitimate conversation activity', async (t) => {
  const f = await setup(t);
  await sendPlain(f, 'human', 'first');
  const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
  for (const [id, botUserId] of [['other-bot', 'self'], ['', '']] as const) {
    binding.lastActivity = 1;
    const calls = f.membrane.calls.length;
    const before = Date.now();
    await sendPlain(f, 'message-' + id, 'counterpart ' + id, {
      tags: ['chat:from-bot'], author: { id, name: 'Counterpart' }, metadata: { botUserId },
    });
    assert(binding.lastActivity >= before, 'being a bot or having an empty ID is not self identity');
    assert.equal(f.membrane.calls.length, calls + 1);
  }
});

test('coalesced self replacement retains its receipt and fixed-audience context without renewing activity', async (t) => {
  let filterCalls = 0;
  const f = await setup(t, { server: { shouldTriggerInference: () => { filterCalls++; return false; } } });
  await f.send('channels/incoming', { messages: [f.channel('first', 'unread original', { initial: true })] });
  const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
  binding.lastActivity = 1;
  const echo = {
    ...f.channel('edit', 'self replacement'),
    tags: ['chat:from-self'], author: { id: 'self', name: 'Self' },
  };
  const result = await f.send('channels/incoming', { messages: [echo] });
  assert.equal(result.result.results[0].coalesce.outcome, 'replaced');
  assert.equal(binding.lastActivity, 1, 'fixed-audience delivery also skips self activity');
  assert(f.context(binding.agentName).includes('self replacement'));
  assert(!f.context(binding.agentName).includes('unread original'));
  const retry = await f.send('channels/incoming', { messages: [echo] });
  assert.deepEqual(retry.result, result.result, 'coalescing retry keeps its receipt');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0);
  assert.equal(filterCalls, 1, 'self echoes bypass callbacks that can schedule delayed gate work');
});

for (const [label, identity] of [
  ['self tag', { tags: ['chat:from-self'] }],
  ['matching botUserId', { tags: ['chat:from-bot'], origin: { authorId: 'self', botUserId: 'self' } }],
] as const) {
  test('deferred channel-scoped ' + label + ' cannot pre-spawn a fork or arm a trigger callback', async (t) => {
    let filterCalls = 0;
    const f = await setup(t, { server: { shouldTriggerInference: () => { filterCalls++; return true; } } });
    const result = await f.send('push/event', {
      ...f.params('self', 'self fallback', { channelId: 'chat', key: 'self', deferred: true, initial: true }),
      ...identity,
    });
    assert.equal(result.result.accepted, true);
    assert.equal(f.framework.getConversationRouter()!.getBinding('chat'), undefined);
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 0);
    assert.equal(filterCalls, 0);

    // Assembly for unrelated work also asks the coalescer for audiences.
    f.framework.nudgeAgent('agent', 'test');
    await f.framework.runUntilIdle();
    assert.equal(f.framework.getConversationRouter()!.getBinding('chat'), undefined);
    assert.equal(f.renders.length, 0, 'an unbound self batch has no fork to render for');
    assert(!f.context().includes('self fallback'));
  });
}

test('self batches restored with an old wake verdict cannot create a conversation fork', async (t) => {
  const config: Partial<FrameworkConfig> = {};
  const f = await fixture({ framework: config, server: { shouldTriggerInference: () => true } });
  t.after(f.close);
  f.alwaysRespond();
  await f.register();
  await f.send('push/event', {
    ...f.params('old-self', 'old self fallback', { channelId: 'chat', key: 'self', deferred: true }),
    tags: ['chat:from-self'],
  });
  // This snapshot predates conversation self filtering and carries triggerInference=true.
  await f.framework.stop();
  config.conversations = conversations;
  await f.create();
  await f.register();
  await f.framework.runUntilIdle();
  assert.equal(f.framework.getConversationRouter()!.getBinding('chat'), undefined);
  assert.equal(f.membrane.calls.length, 0, 'replay cannot reuse the old self wake verdict');
  f.framework.nudgeAgent('agent', 'test');
  await f.framework.runUntilIdle();
  assert.equal(f.framework.getConversationRouter()!.getBinding('chat'), undefined);
  assert.equal(f.renders.length, 0);
});

test('a bound self batch renders on an independent turn without refreshing lifetime or adding a wake', async (t) => {
  const f = await setup(t);
  await sendPlain(f, 'human', 'first');
  const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
  binding.lastActivity = Date.now() - 1000;
  const activity = binding.lastActivity;
  const calls = f.membrane.calls.length;
  await f.send('push/event', {
    ...f.params('self', 'self fallback', { channelId: 'chat', key: 'self', deferred: true }),
    tags: ['chat:from-self'],
  });
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, calls, 'self does not wake the bound fork');
  assert.equal(f.renders.length, 0);

  f.framework.nudgeAgent(binding.agentName, 'test');
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'accepted self context remains available to a later independent turn');
  assert(f.context(binding.agentName).includes('document_diff'));
  assert.equal(binding.lastActivity, activity);
  assert.equal(f.membrane.calls.length, calls + 1);
});


test('a mixed deferred batch retains fresh counterpart activity, but old rendered text cannot revive a self-only batch', async (t) => {
  const f = await setup(t);
  await sendPlain(f, 'start', 'initial counterpart');
  const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
  binding.lastActivity = 1;
  const calls = f.membrane.calls.length;
  const before = Date.now();
  await f.send('push/event', {
    ...f.params('counterpart', 'fresh counterpart', { channelId: 'chat', key: 'mixed', deferred: true }),
    tags: ['chat:from-human'], origin: { authorId: 'human' },
  });
  await f.send('push/event', {
    ...f.params('self', 'self addition', { channelId: 'chat', key: 'mixed', deferred: true }),
    tags: ['chat:from-self'], origin: { authorId: 'self' },
  });
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, calls + 1, 'self must preserve the pending counterpart wake');
  assert(binding.lastActivity >= before, 'fresh counterpart activity in the batch still counts');

  binding.lastActivity = 1;
  const afterMixed = f.membrane.calls.length;
  f.renderer(async () => ({ content: [{ type: 'text', text: 'older counterpart history plus self update' }] }));
  await f.send('push/event', {
    ...f.params('self-only', 'self fallback', { channelId: 'chat', key: 'mixed', deferred: true }),
    tags: ['chat:from-self'],
  });
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, afterMixed);
  f.framework.nudgeAgent(binding.agentName, 'test');
  await f.framework.runUntilIdle();
  assert(f.context(binding.agentName).includes('older counterpart history'));
  assert.equal(binding.lastActivity, 1, 'rendered historical prose is not fresh counterpart activity');
});

for (const recovery of ['snapshot', 'receipt bridge'] as const) {
  test('mixed batch counterpart cause survives ' + recovery + ' recovery after a later self echo', async (t) => {
    const f = await setup(t);
    await sendPlain(f, 'start', 'initial counterpart');
    const calls = f.membrane.calls.length;
    await f.send('push/event', {
      ...f.params('counterpart', 'fresh counterpart', { channelId: 'chat', key: 'mixed', deferred: true }),
      tags: ['chat:from-human'], origin: { authorId: 'human' },
    });
    await f.send('push/event', {
      ...f.params('self', 'self addition', { channelId: 'chat', key: 'mixed', deferred: true }),
      tags: ['chat:from-self'], origin: { authorId: 'self' },
    });
    if (recovery === 'snapshot') await f.framework.stop();
    else await crash(f);
    await f.create();
    await f.register();
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, calls + 1, 'restart recovers the counterpart cause, not the last self verdict');
    assert(f.framework.getConversationRouter()!.getBinding('chat'));
    // Receipt recovery takes the retained fallback rather than repeating a render.
    assert.equal(f.renders.length, recovery === 'snapshot' ? 1 : 0);
  });
}


test('an unknown counterpart identity cannot become self when a later echo supplies the subject author', async (t) => {
  const f = await setup(t);
  await sendPlain(f, 'start', 'initial counterpart');
  const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
  binding.lastActivity = 1;
  const calls = f.membrane.calls.length;
  await f.send('push/event', {
    ...f.params('unknown', 'fresh unknown counterpart', { channelId: 'chat', key: 'mixed', deferred: true }),
    tags: ['chat:from-bot'], origin: { botUserId: 'self' },
  });
  await f.send('push/event', {
    ...f.params('self', 'self addition', { channelId: 'chat', key: 'mixed', deferred: true }),
    tags: ['chat:from-self'], origin: { authorId: 'self', botUserId: 'self' },
  });
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, calls + 1, 'later identity must not reclassify the pending cause');
  assert(binding.lastActivity > 1);
});

test('a later genuine counterpart no-wake verdict supersedes the earlier cause, and self cannot revive it', async (t) => {
  const f = await setup(t, { server: { shouldTriggerInference: (text: string) => text !== 'quiet counterpart' } });
  await sendPlain(f, 'start', 'initial counterpart');
  const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
  const activity = Date.now() - 1000;
  binding.lastActivity = activity;
  const calls = f.membrane.calls.length;
  for (const [id, text, tags] of [
    ['wake', 'counterpart wake', ['chat:from-human']],
    ['quiet', 'quiet counterpart', ['chat:from-human']],
    ['self', 'self addition', ['chat:from-self']],
  ] as const) {
    await f.send('push/event', { ...f.params(id, text, { channelId: 'chat', key: 'mixed', deferred: true }), tags });
  }
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, calls, 'the superseded wake is not sticky');
  assert.equal(binding.lastActivity, activity);
  f.framework.nudgeAgent(binding.agentName, 'test');
  await f.framework.runUntilIdle();
  assert(binding.lastActivity > activity, 'the quiet counterpart is still fresh activity when delivered');
});

for (const transition of ['withdrawal', 'plain replacement'] as const) {
  test(transition + ' consumes the pending cause before a new self-only batch', async (t) => {
    const f = await setup(t);
    await sendPlain(f, 'start', 'initial counterpart');
    const binding = f.framework.getConversationRouter()!.getBinding('chat')!;
    const activity = Date.now() - 1000;
    binding.lastActivity = activity;
    const calls = f.membrane.calls.length;
    await f.send('push/event', {
      ...f.params('counterpart', 'fresh counterpart', { channelId: 'chat', key: 'mixed', deferred: true }),
      tags: ['chat:from-human'],
    });
    await f.send('push/event', {
      ...f.params('clear', transition === 'withdrawal' ? '' : 'self replacement', {
        channelId: 'chat', key: 'mixed', ...(transition === 'withdrawal' ? { retract: true } : {}),
      }),
      tags: ['chat:from-self'],
    });
    await f.send('push/event', {
      ...f.params('self-only', 'self fallback', { channelId: 'chat', key: 'mixed', deferred: true }),
      tags: ['chat:from-self'],
    });
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, calls);
    f.framework.nudgeAgent(binding.agentName, 'test');
    await f.framework.runUntilIdle();
    assert.equal(binding.lastActivity, activity, 'cleared batch causes cannot leak into later self activity');
  });
}

test('self echoes cannot arm a debounced EventGate wake through either channel lane', async (t) => {
  const f = await setup(t, { framework: { gate: { config: {
    default: 'skip',
    policies: [{
      name: 'debounce-all',
      match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] },
      behavior: { debounce: 20 },
    }],
  } } } });
  await sendPlain(f, 'self-channel', 'self channel', { tags: ['chat:from-self'] });
  await f.send('push/event', {
    ...f.params('self-push', 'self push', { channelId: 'chat', key: 'self', deferred: true }),
    tags: ['chat:from-self'],
  });
  await delay(60);
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 0, 'self must be filtered before gate timers can be scheduled');
  assert.equal(f.framework.getConversationRouter()!.getBinding('chat'), undefined);
});

test('non-channel self push traffic keeps its existing context and wake behavior', async (t) => {
  const f = await setup(t);
  await f.send('push/event', { ...f.params('status', 'background self status'), tags: ['chat:from-self'] });
  await f.framework.runUntilIdle();
  assert(f.context().includes('background self status'));
  assert.equal(f.membrane.calls.length, 1);
});

test('without conversation routing, self channel messages keep existing behavior', async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.alwaysRespond();
  await f.register();
  await sendPlain(f, 'self', 'ordinary primary self echo', { tags: ['chat:from-self'] });
  assert(f.context().includes('ordinary primary self echo'));
  assert.equal(f.membrane.calls.length, 1);
});

for (const delivery of ['serial', 'concurrent'] as const) {
  test('inherited self identity vetoes the trigger callback during ' + delivery + ' admission', async (t) => {
    let filterCalls = 0;
    const f = await setup(t, { server: { shouldTriggerInference: () => { filterCalls++; return true; } } });
    const first = {
      ...f.params('first-self', 'self', { channelId: 'chat', key: 'same-author', deferred: true }),
      origin: { authorId: 'self', botUserId: 'self' },
    };
    const next = {
      ...f.params('next-self', 'self update', { channelId: 'chat', key: 'same-author', deferred: true }),
      origin: { botUserId: 'self' },
    };
    if (delivery === 'serial') {
      await f.send('push/event', first);
      await f.send('push/event', next);
    } else {
      await Promise.all([f.send('push/event', first), f.send('push/event', next)]);
    }
    assert.equal(filterCalls, 0, 'the trigger boundary must use the admitted, inherited self author');
    assert.equal(f.framework.getConversationRouter()!.getBinding('chat'), undefined);
    await f.send('push/event', {
      ...f.params('other', 'other bot update', { channelId: 'chat', key: 'same-author', deferred: true }),
      origin: { authorId: 'other-bot', botUserId: 'self' },
    });
    assert.equal(filterCalls, 1, 'a genuine counterpart still reaches the configured trigger policy');
    await f.framework.runUntilIdle();
    assert.equal(f.membrane.calls.length, 1);
  });
}
