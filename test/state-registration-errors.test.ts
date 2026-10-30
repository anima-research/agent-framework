/**
 * Registering a state treats "already exists" as done, since a store reopened
 * after a restart already holds the state. Every other failure, such as a
 * closed store or an I/O error, reaches the caller of the call that
 * registered it, rather than surfacing at a later write with another call's
 * name in its error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import type {
  FrameworkConfig,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';
import { ensureStateRegistered, isStateExistsError } from '../src/module-registry.js';
import { ToolResultGuard, TOOL_RESULT_GUARD_AUDIT_STATE } from '../src/tool-result-guard.js';
import { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';
import { ChannelRegistry } from '../src/mcpl/channel-registry.js';
import type { McplServerRegistry } from '../src/mcpl/server-registry.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** assert.throws and assert.rejects test a RegExp against the error's
 *  toString(): the failure names the state, then gives the store's error. */
function injected(id: string): RegExp {
  const escaped = id.replace(/[/.]/g, '\\$&');
  return new RegExp(`^Error: Registering state '${escaped}' failed: injected EIO registering ${escaped}$`);
}

/** loadHostState's refusal for a feature set's host state at registration:
 *  it says what the failure stops, and its cause is the helper's error. */
function hostStateRefused(error: unknown): boolean {
  assert.match(
    String(error),
    /^Error: the host-managed state of feature set "fs" on MCPL server "srv" \(mcpl\/state\/srv\/fs\) could not be registered or read: Registering state 'mcpl\/state\/srv\/fs' failed: injected EIO registering mcpl\/state\/srv\/fs\. The feature set isn't registered without it, /,
  );
  assert.match(String((error as Error).cause), injected('mcpl/state/srv/fs'));
  return true;
}

type FailingStore = JsStore & { readonly registrations: string[] };

/** A real store whose registerState fails for one id, as an I/O error would:
 *  every time, or only the first `times` times. `registrations` lists each
 *  id registerState was called with, in order. */
function failingOn(store: JsStore, failId: string, times = Infinity): FailingStore {
  const registrations: string[] = [];
  let failures = 0;
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'registrations') return registrations;
      if (prop === 'registerState') {
        return (registration: Parameters<JsStore['registerState']>[0]) => {
          registrations.push(registration.id);
          if (registration.id === failId && failures < times) {
            failures++;
            throw Object.assign(new Error(`injected EIO registering ${registration.id}`), { code: 'EIO' });
          }
          target.registerState(registration);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as FailingStore;
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

function probeModule(name: string, onStart?: (ctx: ModuleContext) => void): Module {
  return {
    name,
    async start(ctx: ModuleContext) { onStart?.(ctx); },
    async stop() {},
    getTools(): ToolDefinition[] { return []; },
    async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true }; },
    async onProcess(_event: ProcessEvent, _state: ProcessState): Promise<EventResponse> { return {}; },
  };
}

describe('ensureStateRegistered', () => {
  it('treats a state that already exists as registered', withStore('state-reg-exists-', (store) => {
    ensureStateRegistered(store, { id: 'probe/state', strategy: 'snapshot' });
    // The store's own answer to a second registration is the one the helper
    // takes as done.
    assert.throws(
      () => store.registerState({ id: 'probe/state', strategy: 'snapshot' }),
      (error: unknown) => isStateExistsError(error),
    );
    ensureStateRegistered(store, { id: 'probe/state', strategy: 'snapshot' });
    store.setStateJson('probe/state', { ok: true });
    assert.deepEqual(store.getStateJson('probe/state'), { ok: true });
  }));

  it("throws every other failure, naming the state, with the store's error as its cause", withStore('state-reg-other-', (store) => {
    assert.throws(
      () => ensureStateRegistered(failingOn(store, 'probe/state'), { id: 'probe/state', strategy: 'snapshot' }),
      (error: unknown) => injected('probe/state').test(String(error))
        && (error as Error).cause instanceof Error
        && ((error as Error).cause as { code?: string }).code === 'EIO',
    );
  }));

  it("throws a closed store's failure, rather than taking it for 'already exists'", () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-reg-closed-'));
    try {
      const store = JsStore.openOrCreate({ path: join(dir, 'store') });
      store.close();
      assert.throws(
        () => ensureStateRegistered(store, { id: 'probe/closed', strategy: 'snapshot' }),
        (error: unknown) => error instanceof Error
          && error.message.startsWith("Registering state 'probe/closed' failed: ")
          && !isStateExistsError(error.cause),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AgentFramework.create() lets a failed registration through', () => {
  const trunk = { name: 'trunk', model: 'test-model', systemPrompt: 'You are the trunk.' };
  const cases: Array<{ id: string; config?: Partial<FrameworkConfig> }> = [
    { id: 'framework/state' },
    { id: 'framework/deferred-writes' },
    { id: 'mcpl/coalescing' },
    { id: 'mcpl/coalescing-recent' },
    { id: 'framework/inference-log' },
    { id: 'framework/turn-checkpoints/tree' },
    { id: 'framework/process-log', config: { processLogging: { persist: true } } },
    { id: 'framework/conversation-router', config: { agents: [trunk], conversations: { templateAgent: 'trunk' } } },
    { id: 'modules/probe/state', config: { modules: [probeModule('probe')] } },
    { id: 'modules/probe/events', config: { modules: [probeModule('probe', (ctx) => ctx.registerLogState('events'))] } },
  ];
  for (const { id, config } of cases) {
    it(`fails when ${id} can't be registered`, withStore('state-reg-create-', async (store) => {
      let framework: AgentFramework | undefined;
      try {
        await assert.rejects(
          async () => {
            framework = await AgentFramework.create({
              store: failingOn(store, id),
              membrane: new MockMembrane().asMembrane(),
              agents: [],
              modules: [],
              syncIntervalMs: 0,
              ...config,
            });
          },
          injected(id),
        );
      } finally {
        await framework?.stop();
      }
    }));
  }
});

describe('MCPL state lets a failed registration through', () => {
  it('a checkpoint manager', withStore('state-reg-checkpoints-', (store) => {
    assert.throws(() => new CheckpointManager(failingOn(store, 'mcpl/checkpoints'), () => {}), injected('mcpl/checkpoints'));
  }));

  it("a feature set's host state", withStore('state-reg-hoststate-', (store) => {
    const manager = new CheckpointManager(failingOn(store, 'mcpl/state/srv/fs'), () => {});
    assert.throws(
      () => manager.registerFeatureSet('srv', 'fs', { hostState: true, rollback: false }),
      hostStateRefused,
    );
  }));

  it("a feature set whose host state failed to register is registered by the next call, with its stored state", withStore('state-reg-hoststate-retry-', (store) => {
    // A host state stored before, as a reconnect's re-run finds it.
    store.registerState({ id: 'mcpl/state/srv/fs', strategy: 'snapshot' });
    store.setStateJson('mcpl/state/srv/fs', { cursor: 7 });
    const flaky = failingOn(store, 'mcpl/state/srv/fs', 1);
    const manager = new CheckpointManager(flaky, () => {});
    assert.throws(
      () => manager.registerFeatureSet('srv', 'fs', { hostState: true, rollback: false }),
      hostStateRefused,
    );
    assert.equal(manager.isHostManaged('srv', 'fs'), false, 'a failed call records nothing');
    manager.registerFeatureSet('srv', 'fs', { hostState: true, rollback: false });
    assert.equal(manager.isHostManaged('srv', 'fs'), true);
    assert.deepEqual(manager.getCurrentState('srv', 'fs'), { cursor: 7 });
    assert.equal(flaky.registrations.filter((id) => id === 'mcpl/state/srv/fs').length, 2);
  }));

  const channelRegistry = (store: JsStore) => new ChannelRegistry(
    { getServer: (_id: string) => null } as unknown as McplServerRegistry,
    {} as FeatureSetManager,
    () => {},
    () => {},
    { store },
  );

  for (const id of ['mcpl/channel-lifecycle', 'mcpl/channel-label-history']) {
    it(`a channel registry's ${id}`, withStore('state-reg-channels-', (store) => {
      assert.throws(() => channelRegistry(failingOn(store, id)), injected(id));
    }));
  }

  it("the tune-out coordinator's state, read and written", withStore('state-reg-coordinator-', (store) => {
    const registry = channelRegistry(failingOn(store, 'tune-out/probe'));
    assert.throws(() => registry.readCoordinatorState('tune-out/probe'), injected('tune-out/probe'));
    assert.throws(() => registry.writeCoordinatorState('tune-out/probe', { a: 'b' }), injected('tune-out/probe'));
  }));
});

describe("the workspace's mount state lets a failed registration through", () => {
  for (const id of ['workspace/files/tree', 'workspace/files/intent']) {
    it(id, withStore('state-reg-workspace-', (store, dir) => {
      const workspace = new WorkspaceModule({
        mounts: [{ name: 'files', path: join(dir, 'files'), mode: 'read-write', watch: 'never' }],
      });
      assert.throws(() => workspace.initStore(failingOn(store, id)), injected(id));
    }));
  }

  it('a failed initStore leaves the module knowing no mount, and the next initStore takes them all', withStore('state-reg-workspace-whole-', (store, dir) => {
    const workspace = new WorkspaceModule({
      mounts: [
        { name: 'files', path: join(dir, 'files'), mode: 'read-write', watch: 'never' },
        { name: 'more', path: join(dir, 'more'), mode: 'read-write', watch: 'never' },
      ],
    });
    assert.throws(() => workspace.initStore(failingOn(store, 'workspace/more/tree')), injected('workspace/more/tree'));
    assert.equal(workspace.resolveAbsolutePath('files/a.txt'), null, 'the first mount was not taken either');
    workspace.initStore(store);
    assert.equal(workspace.resolveAbsolutePath('files/a.txt'), join(dir, 'files', 'a.txt'));
    assert.equal(workspace.resolveAbsolutePath('more/b.txt'), join(dir, 'more', 'b.txt'));
  }));
});

describe('a state registered on first use lets a failed registration through, and registers on the next use', () => {
  it("a module's log state", withStore('state-reg-logstate-', async (store) => {
    let first: unknown;
    let beforeRegistered: unknown;
    let framework: AgentFramework | undefined;
    try {
      framework = await AgentFramework.create({
        store: failingOn(store, 'modules/probe/events', 1),
        membrane: new MockMembrane().asMembrane(),
        agents: [],
        syncIntervalMs: 0,
        modules: [probeModule('probe', (ctx) => {
          try { ctx.registerLogState('events'); } catch (error) { first = error; }
          try { ctx.appendToLog('events', 1); } catch (error) { beforeRegistered = error; }
          ctx.registerLogState('events');
          ctx.appendToLog('events', 2);
        })],
      });
      assert.match(String(first), injected('modules/probe/events'));
      assert.match(String(beforeRegistered), /Module log state 'events' is not registered/);
      assert.deepEqual(store.getStateJson('modules/probe/events'), [2]);
    } finally {
      await framework?.stop();
    }
  }));

  it("the tool-result guard's audit state", withStore('state-reg-guard-', async (store) => {
    const cm = await ContextManager.open({ store, namespace: 'agents/probe' });
    const flaky = failingOn(store, TOOL_RESULT_GUARD_AUDIT_STATE, 1);
    (cm as unknown as { getStore(): JsStore }).getStore = () => flaky;
    cm.addMessage('probe', [{ type: 'tool_use', id: 'tu-1', name: 'search', input: {} }]);
    const guard = new ToolResultGuard('probe', cm, true);
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      guard.storeResults(
        [{ type: 'tool_result', toolUseId: 'tu-1', content: 'out' }],
        [{ toolUseId: 'tu-1', content: 'out' }],
        [],
        undefined,
        undefined,
      );
    } finally {
      console.error = realError;
    }
    // The staged record's write failed with the registration, naming the
    // state; the record stayed queued, and the next write registered the
    // state again before writing both records.
    assert.ok(
      logged.some((args) => args.some((arg) => injected(TOOL_RESULT_GUARD_AUDIT_STATE).test(String(arg)))),
      'the failed registration is logged, naming the state',
    );
    assert.equal(flaky.registrations.filter((id) => id === TOOL_RESULT_GUARD_AUDIT_STATE).length, 2);
    const audit = store.getStateJson(TOOL_RESULT_GUARD_AUDIT_STATE) as Array<{ type: string }>;
    assert.deepEqual(audit.map((record) => record.type), ['staged', 'linked']);
  }));
});
