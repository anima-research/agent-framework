/**
 * A failed read or write of the framework's own state is a failure, not an
 * empty state or a success. The tune-out coordinator's dispositions and the
 * conversation router's generation counters are each a map the framework
 * writes back whole, so a failed read taken as empty lost what was stored:
 * the subconscious compiled without its dispositions until a restart, and the
 * next noted disposition replaced the stored map; a restarted router reused
 * generation 1's agent name, reopening that engagement's namespace, and wrote
 * its counters back down. A counter whose write failed was logged and the
 * spawn went on, so the next restart reused that fork's name too. Nothing
 * stored reads as null, and still reads as empty.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/index.js';
import type { ProcessEvent, TraceEvent } from '../src/index.js';
import { ensureStateRegistered } from '../src/module-registry.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { TuneOutCoordinator, type TuneOutFrameworkHooks } from '../src/tune-out/coordinator.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';
import { fixture } from './helpers/coalescing-fixture.js';
import { forkAgentName } from '../src/mcpl/conversation-router.js';

/** A real store whose getStateJson fails for one id, as an I/O error would,
 *  the first `times` times it is asked while `failing()` holds. */
function failingReadOn(store: JsStore, failId: string, times = Infinity, failing = () => true): JsStore {
  let left = times;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'getStateJson') {
        return (stateId: string) => {
          if (stateId === failId && left > 0 && failing()) {
            left--;
            throw Object.assign(new Error(`injected EIO reading ${stateId}`), { code: 'EIO' });
          }
          return target.getStateJson(stateId);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** A real store whose setStateJson fails for one id, as an I/O error would,
 *  the first `times` times it is asked; `failed.count` counts the failures. */
function failingWriteOn(store: JsStore, failId: string, times = Infinity, failed = { count: 0 }): JsStore {
  let left = times;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'setStateJson') {
        return (stateId: string, value: unknown) => {
          if (stateId === failId && left > 0) {
            left--;
            failed.count++;
            throw Object.assign(new Error(`injected EIO writing ${stateId}`), { code: 'EIO' });
          }
          return target.setStateJson(stateId, value);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function withStore(prefix: string, body: (store: JsStore, dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    try {
      await body(store, dir);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** A gate a test opens itself, and a wait for a condition the code under
 *  test makes true (no fixed timers standing in for events). */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}
async function until(check: () => boolean, what: string, ms = 2000) {
  for (let waited = 0; waited < ms && !check(); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), `timed out waiting until ${what}`);
}

const DISPOSITIONS = 'subconscious/scout/dispositions';

describe("the tune-out coordinator's stored dispositions", () => {
  const stored = { antra: 'pings always escalate' };

  const channelRegistry = (store: JsStore) => new ChannelRegistry(
    { getServer: (_id: string) => null } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { store },
  );
  const coordinatorOver = (store: JsStore) => new TuneOutCoordinator(
    channelRegistry(store),
    {} as McplServerRegistry,
    {
      addMessage: () => '',
      requestInference: () => {},
      subconsciousName: () => 'Subconscious',
      primaryName: () => 'scout',
      getStoredMessages: () => [],
      currentSequence: () => 1,
      setSubconsciousAnchor: () => {},
      isForkBound: () => false,
      isPrivilegedAuthor: () => false,
      allowChannelSpeech: () => false,
      emitTrace: () => {},
    } as unknown as TuneOutFrameworkHooks,
  );
  const unreadable = /^Error: the stored dispositions \(subconscious\/scout\/dispositions\) could not be read: injected EIO reading subconscious\/scout\/dispositions$/;
  const unstorable = /^Error: the dispositions \(subconscious\/scout\/dispositions\) could not be stored: injected EIO writing subconscious\/scout\/dispositions$/;
  /** What note_disposition answers the subconscious when its note fails. */
  const notRecorded = (key: string, storeError: string) => ({
    success: false,
    isError: true,
    error: `The change to the disposition ${JSON.stringify(key)} wasn't recorded, so the dispositions stay as they were. ` +
      `Noting it again may work once the store can be read and written. The store's error: ${storeError}`,
  });

  it('a failed read throws rather than showing none, and the next read finds them', withStore('state-read-dispositions-', (store) => {
    channelRegistry(store).writeCoordinatorState(DISPOSITIONS, stored);
    const coordinator = coordinatorOver(failingReadOn(store, DISPOSITIONS, 1));
    try {
      assert.throws(() => coordinator.getDispositionsInjection(), unreadable);
      assert.match(coordinator.getDispositionsInjection()!.content[0].text, /- antra: pings always escalate/);
    } finally {
      coordinator.stop();
    }
  }));

  it('a disposition noted while they can\'t be read writes nothing over them', withStore('state-read-dispositions-note-', async (store) => {
    channelRegistry(store).writeCoordinatorState(DISPOSITIONS, stored);
    const coordinator = coordinatorOver(failingReadOn(store, DISPOSITIONS, 2));
    try {
      assert.throws(() => coordinator.noteDisposition('release-bot', 'ignore'), unreadable);
      // The subconscious's tool answers that the note wasn't recorded.
      assert.deepEqual(
        await coordinator.handleSubconsciousTool('note_disposition', { key: 'release-bot', text: 'ignore' }),
        notRecorded('release-bot', 'the stored dispositions (subconscious/scout/dispositions) could not be read: injected EIO reading subconscious/scout/dispositions'),
      );
      assert.deepEqual(store.getStateJson(DISPOSITIONS), stored);
      coordinator.noteDisposition('release-bot', 'ignore');
      assert.deepEqual(store.getStateJson(DISPOSITIONS), { ...stored, 'release-bot': 'ignore' });
    } finally {
      coordinator.stop();
    }
  }));

  it('a disposition whose write fails is in effect nowhere, and a later note doesn\'t store it', withStore('state-write-dispositions-', async (store) => {
    channelRegistry(store).writeCoordinatorState(DISPOSITIONS, stored);
    const coordinator = coordinatorOver(failingWriteOn(store, DISPOSITIONS, 2));
    try {
      assert.throws(() => coordinator.noteDisposition('release-bot', 'ignore'), unstorable);
      assert.deepEqual(
        await coordinator.handleSubconsciousTool('note_disposition', { key: 'antra', text: '' }),
        notRecorded('antra', 'the dispositions (subconscious/scout/dispositions) could not be stored: injected EIO writing subconscious/scout/dispositions'),
      );
      // Neither the failed note nor the failed removal is in what the subconscious compiles.
      assert.equal(coordinator.getDispositionsInjection()!.content[0].text, '[Standing dispositions]\n- antra: pings always escalate');
      assert.deepEqual(store.getStateJson(DISPOSITIONS), stored);
      coordinator.noteDisposition('ci', 'summarize');
      assert.deepEqual(store.getStateJson(DISPOSITIONS), { ...stored, ci: 'summarize' });
    } finally {
      coordinator.stop();
    }
  }));

  it('nothing stored still reads as no dispositions', withStore('state-read-dispositions-none-', (store) => {
    const coordinator = coordinatorOver(store);
    try {
      assert.equal(coordinator.getDispositionsInjection(), null);
    } finally {
      coordinator.stop();
    }
  }));

  it("the subconscious's turn fails with the read error, and nothing reaches the provider", withStore('state-read-dispositions-turn-', async (store, dir) => {
    // tune-out-e2e's setup: a real MCPL channel tuned out, and an addressed
    // message that wakes the subconscious.
    const commandPath = join(dir, 'commands.txt');
    writeFileSync(commandPath, '');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Noted.' }]));
    const failures: string[] = [];
    const framework = await AgentFramework.create({
      store: failingReadOn(store, DISPOSITIONS),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      subconscious: { enabled: true, systemPrompt: 'You are the Subconscious.' },
      mcplServers: [{
        id: 'disc',
        command: process.execPath,
        args: [join(import.meta.dirname, 'fixtures/tune-out-mcpl-server.mjs')],
        env: { STATUS_PATH: join(dir, 'status.jsonl'), COMMAND_PATH: commandPath },
      }],
      modules: [],
      // One attempt: the default policy would retry it, reading the store again each time.
      errorPolicy: { maxRetries: 0, onInferenceError: () => ({ retry: false }) },
    });
    framework.onTrace((e: TraceEvent) => {
      const event = e as { type: string; agentName?: string; error?: string };
      if (event.type === 'inference:failed' && event.agentName === 'Subconscious') failures.push(event.error ?? '');
    });
    try {
      await framework.start();
      const internals = framework as unknown as {
        tuneOutCoordinator: TuneOutCoordinator;
        channelRegistry: { listChannelsRaw(): unknown[] };
      };
      await until(() => internals.channelRegistry.listChannelsRaw().length > 0, 'the channel is registered', 15_000);
      internals.tuneOutCoordinator.enter('disc', 'disc:guild:noisy', { cadenceSeconds: 3600, backlogCap: 2, maxWakes: 5 }, 'agent-tool');
      appendFileSync(commandPath, 'addressed m1 hey scout, quick question\n');
      await until(() => failures.length > 0, "the subconscious's wake turn has failed", 15_000);
      assert.deepEqual(failures, [
        'the stored dispositions (subconscious/scout/dispositions) could not be read: injected EIO reading subconscious/scout/dispositions',
      ]);
      assert.equal(membrane.calls.length, 0, 'nothing reached the provider');
    } finally {
      await framework.stop();
    }
  }));
});

describe("the conversation router's generation counters", () => {
  const ROUTER = 'framework/conversation-router';
  const trunk = { name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' };
  const unreadable = /^Error: the conversation router's generation counters \(framework\/conversation-router\) could not be read: injected EIO reading framework\/conversation-router$/;

  it('AgentFramework.create() fails when they can\'t be read, and writes nothing over them', withStore('state-read-router-', async (store) => {
    ensureStateRegistered(store, { id: ROUTER, strategy: 'snapshot' });
    store.setStateJson(ROUTER, { generations: { C1: 2 } });
    await assert.rejects(
      AgentFramework.create({
        store: failingReadOn(store, ROUTER),
        membrane: new MockMembrane().asMembrane(),
        agents: [trunk],
        modules: [],
        syncIntervalMs: 0,
        conversations: { templateAgent: 'trunk' },
      }),
      unreadable,
    );
    assert.deepEqual(store.getStateJson(ROUTER), { generations: { C1: 2 } });
  }));

  it('a create() that fails on them closes the store it opened, so the next opens it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-read-router-path-'));
    const storePath = join(dir, 'store');
    const config = {
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [trunk],
      modules: [],
      syncIntervalMs: 0,
      conversations: { templateAgent: 'trunk' },
    };
    const read = JsStore.prototype.getStateJson;
    const close = JsStore.prototype.close;
    let closes = 0;
    JsStore.prototype.getStateJson = function (this: JsStore, stateId: string) {
      if (stateId === ROUTER) throw Object.assign(new Error(`injected EIO reading ${stateId}`), { code: 'EIO' });
      return read.call(this, stateId);
    };
    JsStore.prototype.close = function (this: JsStore) {
      closes++;
      return close.call(this);
    };
    try {
      await assert.rejects(AgentFramework.create(config), unreadable);
    } finally {
      JsStore.prototype.getStateJson = read;
      JsStore.prototype.close = close;
    }
    assert.equal(closes, 1, 'the store create() opened is closed');
    try {
      const framework = await AgentFramework.create(config);
      await framework.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A direct message on `channelId`, which binds a fork on its first
   *  message. `triggers: false` leaves the fork's turn out. */
  const directMessage = (text: string, channelId = 'slack:D9', triggers = true): ProcessEvent => ({
    type: 'mcpl:channel-incoming',
    serverId: 'srv',
    channelId,
    messageId: `m-${text}`,
    author: { id: 'U1', name: 'alice' },
    content: [{ type: 'text', text }],
    timestamp: new Date().toISOString(),
    metadata: { mentioned: false, channel_type: 'im' },
    triggerInference: triggers,
  }) as unknown as ProcessEvent;

  it('a spawn whose counter can\'t be stored is refused, and the next spawn stores it first', withStore('state-write-router-', async (store) => {
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      store: failingWriteOn(store, ROUTER, 1),
      membrane: membrane.asMembrane(),
      agents: [trunk],
      modules: [],
      syncIntervalMs: 0,
      conversations: { templateAgent: 'trunk' },
    });
    const refusals: string[] = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'mcpl:conversation-spawn-failed') refusals.push((e as { error: string }).error);
    });
    // Answers for every turn either message could start, so a fork that is
    // spawned anyway runs to its end rather than waiting on the provider.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'hi again' }]));
    try {
      framework.pushEvent(directMessage('one'));
      await framework.runUntilIdle();
      assert.equal(framework.getAgent(forkAgentName('conversation', 'srv', 'slack:D9', 1)), null, 'no fork without its counter stored');
      assert.deepEqual(refusals, [
        "the conversation router's generation counters (framework/conversation-router) could not be stored: injected EIO writing framework/conversation-router",
      ]);
      assert.equal(store.getStateJson(ROUTER), null);

      framework.pushEvent(directMessage('two'));
      await framework.runUntilIdle();
      assert.ok(framework.getAgent(forkAgentName('conversation', 'srv', 'slack:D9', 1)), 'the next qualifying message spawns it');
      assert.deepEqual(store.getStateJson(ROUTER), { generations: { 'slack:D9': 1 } });
    } finally {
      await framework.stop();
    }
  }));

  it('a spawn whose counters can\'t be read is refused, and the stored counters stay', withStore('state-read-router-spawn-', async (store) => {
    ensureStateRegistered(store, { id: ROUTER, strategy: 'snapshot' });
    store.setStateJson(ROUTER, { generations: { 'slack:D1': 3 } });
    let failing = false;
    const framework = await AgentFramework.create({
      store: failingReadOn(store, ROUTER, Infinity, () => failing),
      membrane: new MockMembrane().asMembrane(),
      agents: [trunk],
      modules: [],
      syncIntervalMs: 0,
      conversations: { templateAgent: 'trunk' },
    });
    const refusals: string[] = [];
    framework.onTrace((e: TraceEvent) => {
      if (e.type === 'mcpl:conversation-spawn-failed') refusals.push((e as { error: string }).error);
    });
    try {
      failing = true;
      framework.pushEvent(directMessage('one', 'slack:D9', false));
      await framework.runUntilIdle();
      failing = false;
      assert.equal(framework.getAgent(forkAgentName('conversation', 'srv', 'slack:D9', 1)), null, 'no fork without its counter stored');
      assert.deepEqual(refusals, [
        "the conversation router's generation counters (framework/conversation-router) could not be read: injected EIO reading framework/conversation-router",
      ]);
      assert.deepEqual(store.getStateJson(ROUTER), { generations: { 'slack:D1': 3 } });
    } finally {
      await framework.stop();
    }
  }));

  it('each counter keeps its highest value, stored or the router\'s', withStore('state-write-router-merge-', async (store) => {
    ensureStateRegistered(store, { id: ROUTER, strategy: 'snapshot' });
    store.setStateJson(ROUTER, { generations: { 'slack:A': 2 } });
    const framework = await AgentFramework.create({
      store,
      membrane: new MockMembrane().asMembrane(),
      agents: [trunk],
      modules: [],
      syncIntervalMs: 0,
      conversations: { templateAgent: 'trunk' },
    });
    try {
      // The router has slack:A at 2. A store that reads lower, as a branch
      // with older counters would, and one that is ahead for slack:B.
      store.setStateJson(ROUTER, { generations: { 'slack:A': 1, 'slack:B': 5 } });
      framework.pushEvent(directMessage('one', 'slack:C', false));
      await framework.runUntilIdle();
      assert.ok(framework.getAgent(forkAgentName('conversation', 'srv', 'slack:C', 1)));
      assert.deepEqual(store.getStateJson(ROUTER), { generations: { 'slack:A': 2, 'slack:B': 5, 'slack:C': 1 } });
      // A channel id that names an Object.prototype member is a key like any other.
      framework.pushEvent(directMessage('two', 'constructor', false));
      await framework.runUntilIdle();
      assert.deepEqual(store.getStateJson(ROUTER), { generations: { 'slack:A': 2, 'slack:B': 5, 'slack:C': 1, constructor: 1 } });
    } finally {
      await framework.stop();
    }
  }));

  it('a batch whose fork\'s counter can\'t be stored spawns no fork', withStore('state-write-router-batch-', async (store) => {
    const failedWrites = { count: 0 };
    const f = await fixture({
      framework: {
        store: failingWriteOn(store, ROUTER, Infinity, failedWrites),
        conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'always' } },
      } as never,
      server: { shouldTriggerInference: () => true },
    });
    try {
      await f.register();
      await f.send('push/event', f.params('1', 'fallback', { deferred: true, channelId: 'chat', key: 'activity' }));
      f.alwaysRespond();
      await f.framework.runUntilIdle();
      assert.ok(failedWrites.count > 0, "the batch reached its fork's spawn and tried to store the counter");
      const router = (f.framework as unknown as {
        conversationRouter: { getBinding(channel: { serverId: string; channelId: string }): unknown };
      }).conversationRouter;
      assert.equal(router.getBinding({ serverId: 'editor', channelId: 'chat' }), undefined, 'no fork was bound');
      assert.equal(f.framework.getAgent(forkAgentName('conversation', 'editor', 'chat', 1)), null);
      assert.equal(store.getStateJson(ROUTER), null);
    } finally {
      await f.close();
    }
  }));

  it("two spawns in flight on different channels keep both counters", withStore('state-write-router-inflight-', async (store) => {
    // Both spawns wait in their forks' seed, which compiles the template only
    // once its withheld results are saved: the template's aborted batch is
    // held mid-annotation until the test opens the gate.
    const f = await fixture({
      agents: [{ name: 'agent', model: 'test', systemPrompt: 'system', toolResultGuard: true }],
      framework: {
        store,
        conversations: { templateAgent: 'agent', bind: { channel: 'always' }, trigger: { channel: 'mention' } },
      } as never,
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
    const unscripted: number[] = [];
    let calls = 0;
    (f.membrane as unknown as { stream: () => Promise<unknown> }).stream = async () => {
      calls++;
      const response = responses.shift();
      if (!response) {
        unscripted.push(calls);
        throw new Error('unexpected inference');
      }
      return response;
    };
    try {
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
      await f.send('channels/register', { channels: ['chat', 'side'].map((id) => ({
        id, type: 'discord', label: id, metadata: { channelType: 'guild_text' },
      })) });
      // A plain message for one channel, through the event queue, and a
      // coalesced one for the other, through the coalescer.
      await f.send('channels/incoming', { messages: [{
        channelId: 'chat', messageId: 'p1', timestamp: new Date().toISOString(), author: { id: 'u', name: 'User' },
        content: [{ type: 'text', text: 'plain' }],
      }] });
      const queue = f.framework.runUntilIdle();
      await until(() => seeds.calls === 1, "the first spawn waits in its fork's seed");
      const coalesced = f.send('channels/incoming', { messages: [f.channel('e2', 'coalesced', { initial: true }, 'side', 'm2')] });
      await until(() => seeds.calls === 2, "the second spawn waits in its fork's seed");
      assert.deepEqual(store.getStateJson(ROUTER), { generations: { chat: 1, side: 1 } }, 'both stored while neither is bound');
      write.open();
      await Promise.all([queue, coalesced]);
      assert.ok(f.framework.getAgent(forkAgentName('conversation', 'editor', 'chat', 1)));
      assert.ok(f.framework.getAgent(forkAgentName('conversation', 'editor', 'side', 1)));
      assert.deepEqual(store.getStateJson(ROUTER), { generations: { chat: 1, side: 1 } });
      assert.deepEqual(unscripted, [], 'every inference the framework asked for was one the test scripted');
    } finally {
      write.open();
      await f.close();
    }
  }));
});
