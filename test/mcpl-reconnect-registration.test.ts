/**
 * A reconnected MCPL server's control traffic waits for its new grant.
 *
 * A transport boundary resets the server's grant: a fresh initialize is a
 * fresh §5.3 policy epoch. A chat bridge registers its channels right after
 * initialize, before the host's policy Request has been answered. If that
 * registration reaches admission while the grant is still empty, it is
 * refused (-32002) and never replayed, and the route's incoming messages are
 * then unknown channels until the server happens to register again. Initial
 * connect holds both planes until the grant is established; a reconnect must
 * hold them too, both for a connection that was already open (an ordinary
 * disconnect) and for a stub that had never opened (a first reconnect while
 * startup is still staging other servers), and whatever gate completes
 * meanwhile, since each gate's completion opens every connection's planes.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentFramework } from '../src/index.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import { McplServerRegistry } from '../src/mcpl/server-registry.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));

interface ServerEvent {
  event: string;
  role: string;
  pid: number;
  error?: { code: number; message: string } | null;
}

function serverEvents(path: string): ServerEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as ServerEvent);
}

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** A module that records every trace from the framework's start. */
function traceWatcher(traces: unknown[]) {
  return {
    name: 'trace-watcher',
    async start(ctx: { onTrace(listener: (event: unknown) => void): void }) { ctx.onTrace((event) => traces.push(event)); },
    async stop() {},
    getTools: () => [],
    async handleToolCall() { return { success: false, error: 'no tools', isError: true }; },
    async onProcess() { return {}; },
  } as never;
}

describe('MCPL reconnect and channel registration', () => {
  let dir: string;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcpl-reconnect-registration-'));
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('a server that registers right after initialize is registered again after an ordinary reconnect', async () => {
    const eventsPath = join(dir, 'events.jsonl');
    const crashPath = join(dir, 'crash');
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      mcplServers: [{
        id: 'chat',
        command: process.execPath,
        args: [FIXTURE],
        env: { EVENTS_PATH: eventsPath, CRASH_PATH: crashPath },
        enabledFeatureSets: ['chat'],
        reconnect: true,
        reconnectIntervalMs: 50,
      }],
    });
    const answers = () => serverEvents(eventsPath).filter((e) => e.event === 'register-answered');

    await waitFor('the first registration answer', () => answers().length === 1);
    assert.equal(answers()[0].error, null, 'initial connect admits the registration against the established grant');

    // The server process dies; the host reconnects to a fresh one, which
    // registers again before the host's new policy Request is answered.
    writeFileSync(crashPath, '');
    await waitFor('the registration answer after the reconnect', () => answers().length === 2);
    const [first, second] = answers();
    assert.notEqual(second.pid, first.pid, 'a fresh server process registered');
    assert.equal(
      second.error,
      null,
      `the reconnected server's registration waits for its new grant instead of being refused: ${JSON.stringify(second.error)}`,
    );
  });

  it('a first reconnect during staged startup keeps its registration held through startup\'s open of every plane', async () => {
    // The race as it was reproduced: `retry` fails its first connect;
    // its retry reconnects while `stager` is still staging, and holds its
    // policy answer; `stager` answers initialize only once that policy is
    // pending, so startup's final open of every connection's planes runs
    // while the retry's exchange is still in flight.
    const eventsPath = join(dir, 'events.jsonl');
    const pending = join(dir, 'policy-pending');
    const release = join(dir, 'policy-release');
    const server = (id: string, env: Record<string, string>) => ({
      id,
      command: process.execPath,
      args: [FIXTURE],
      env: { EVENTS_PATH: eventsPath, ROLE: id, ...env },
      enabledFeatureSets: ['chat'],
      ...(id === 'retry' ? { reconnect: true, reconnectIntervalMs: 20 } : {}),
    });
    // Record each gate completion that opens every connection's planes
    // (startup's staged open among them), and whether the retry's exchange
    // was in flight then.
    const opensOfEvery: boolean[] = [];
    const proto = AgentFramework.prototype as unknown as { completeMcplDataPlaneGate: (barrier: unknown) => boolean };
    const completeMcplDataPlaneGate = proto.completeMcplDataPlaneGate;
    proto.completeMcplDataPlaneGate = function (this: any, barrier: unknown) {
      if (this.discordAwarenessBarrier === barrier) {
        const retryConnection = this.mcplServerRegistry?.getServer('retry');
        opensOfEvery.push(!!retryConnection && this.mcplPolicyExchanges.get(retryConnection) === retryConnection.transportEpoch);
      }
      return completeMcplDataPlaneGate.call(this, barrier);
    };
    const traces: Array<{ type: string; moduleName?: string }> = [];
    try {
      framework = await AgentFramework.create({
        storePath: join(dir, 'store'),
        membrane: new MockMembrane().asMembrane(),
        agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
        modules: [traceWatcher(traces)],
        maintenanceIntervalMs: 0,
        mcplServers: [
          server('retry', { FAIL_FIRST_PATH: join(dir, 'failed-once'), POLICY_PENDING_PATH: pending, POLICY_RELEASE_PATH: release }),
          server('stager', { INITIALIZE_AFTER_PATH: pending }),
        ],
      });
    } finally {
      proto.completeMcplDataPlaneGate = completeMcplDataPlaneGate;
    }
    const retry = () => serverEvents(eventsPath).filter((e) => e.role === 'retry');
    await waitFor('the retry\'s policy answer held', () => retry().some((e) => e.event === 'policy-held'));
    assert.ok(opensOfEvery.includes(true), `a gate opened every connection's planes while the retry's exchange was in flight: ${JSON.stringify(opensOfEvery)}`);
    assert.equal(
      retry().find((e) => e.event === 'register-answered'),
      undefined,
      `its registration is not answered while its policy exchange is in flight: ${JSON.stringify(retry())}`,
    );

    writeFileSync(release, '1');
    await waitFor('the retry\'s registration answer', () => retry().some((e) => e.event === 'register-answered'));
    const steps = retry().map((e) => e.event);
    const answer = retry().find((e) => e.event === 'register-answered')!;
    assert.equal(answer.error, null, `admitted against the new grant: ${JSON.stringify(answer.error)}`);
    assert.ok(steps.indexOf('policy-answered') < steps.indexOf('register-answered'), `steps: ${steps.join(', ')}`);
    // Startup registered `retry` as a stub with no transport, so only its
    // reconnect announces it.
    const announced = () => traces.filter((trace) => trace.type === 'module:added' && trace.moduleName === 'mcpl:retry').length;
    await waitFor('the retry announced by its reconnect', () => announced() > 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(announced(), 1);
  });

  it('the registry runs onRegister before it registers the connection, so no gate sees a connect before its exchange is marked', async () => {
    const registry = new McplServerRegistry();
    const registeredAtCall: boolean[] = [];
    try {
      const connection = await registry.addServer(
        { id: 'chat', command: process.execPath, args: [FIXTURE], env: { EVENTS_PATH: join(dir, 'events.jsonl') } },
        { version: '0.5', pushEvents: true, featureSets: true },
        undefined,
        () => { registeredAtCall.push(registry.getServer('chat') !== null || registry.getAllServers().length > 0); },
      );
      assert.deepEqual(registeredAtCall, [false]);
      assert.equal(registry.getServer('chat'), connection);
    } finally {
      await registry.closeAll();
    }
  });

  it("a staged connect's exchange holds its planes though another server's reconnect completes its gate meanwhile", async () => {
    // `retry` fails its first connect and reconnects while `stager`'s staged
    // policy answer is held; the retry's gate completes then, opening every
    // connection's planes but the one whose exchange is in flight.
    const eventsPath = join(dir, 'events.jsonl');
    const pending = join(dir, 'policy-pending');
    const release = join(dir, 'policy-release');
    const server = (id: string, env: Record<string, string>) => ({
      id,
      command: process.execPath,
      args: [FIXTURE],
      env: { EVENTS_PATH: eventsPath, ROLE: id, ...env },
      enabledFeatureSets: ['chat'],
      ...(id === 'retry' ? { reconnect: true, reconnectIntervalMs: 20 } : {}),
    });
    const traces: Array<{ type: string; serverId?: string }> = [];
    const creating = AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [traceWatcher(traces)],
      maintenanceIntervalMs: 0,
      mcplServers: [
        server('retry', { FAIL_FIRST_PATH: join(dir, 'failed-once') }),
        server('stager', { POLICY_PENDING_PATH: pending, POLICY_RELEASE_PATH: release }),
      ],
    });
    try {
      const events = (role: string) => serverEvents(eventsPath).filter((e) => e.role === role);
      await waitFor("the stager's policy answer held", () => events('stager').some((e) => e.event === 'policy-held'));
      await waitFor("the retry's registration answer", () => events('retry').some((e) => e.event === 'register-answered'));
      assert.equal(events('retry').find((e) => e.event === 'register-answered')!.error, null);
      assert.equal(
        events('stager').find((e) => e.event === 'register-answered'),
        undefined,
        `its registration is not answered while its staged exchange is in flight: ${JSON.stringify(events('stager'))}`,
      );
    } finally {
      writeFileSync(release, '1');
      framework = await creating;
    }
    const events = (role: string) => serverEvents(eventsPath).filter((e) => e.role === role);
    await waitFor("the stager's registration answer", () => events('stager').some((e) => e.event === 'register-answered'));
    assert.equal(events('stager').find((e) => e.event === 'register-answered')!.error, null, 'admitted against its grant');
  });
});

describe('MCPL policy exchanges hold their planes against every gate', () => {
  /**
   * A framework with one connection whose policy answers wait for the test.
   * No awareness outbox is configured, so a gate holds nothing back and
   * completes as it is released, opening every connection it doesn't pass by.
   */
  function harness() {
    const answers: Array<(receipt: { accepted: true }) => void> = [];
    const failures: Array<(error: Error) => void> = [];
    const counts = { opened: 0, controlOnly: 0, granted: 0 };
    let relisted = 0;
    const config = { id: 'srv', command: 'unused', enabledFeatureSets: ['chat'] };
    let registered = false;
    // The awareness accounting each next gate waits on, in order; a gate
    // with none queued has nothing pending.
    const accounting: Array<Promise<unknown>> = [];
    const connection = Object.assign(new EventEmitter(), {
      id: 'srv',
      transportEpoch: 0,
      isConnected: true,
      capabilities: { version: '0.5', pushEvents: true, featureSets: { chat: { description: 'chat', uses: ['pushEvents'] } } },
      mcpToolsAdvertised: false,
      establishGrant: () => { counts.granted++; },
      sendFeatureSetsUpdateRequest: () => new Promise<{ accepted: true }>((resolve, reject) => { answers.push(resolve); failures.push(reject); }),
      ready: () => { counts.opened++; },
      readyControlPlane: () => { counts.controlOnly++; },
      pauseDataPlane: () => {},
    });
    const fw = Object.create(AgentFramework.prototype) as any;
    fw.traceListeners = [];
    fw.mcplPolicyExchanges = new WeakMap();
    fw.discordAwarenessBarrier = null;
    fw.discordAwarenessBarrierGeneration = 0;
    fw.discordAwarenessOutbox = null;
    // A runtime connect of this stdio server derives the protective reaction
    // default; with no outbox here, it covers the configured marker alone.
    fw.discordAwarenessEmoji = '💤';
    fw.quiesced = false;
    fw.mcplServerConfigs = new Map([['srv', config]]);
    fw.mcplPrefixMap = new Map();
    fw.featureSetManager = new FeatureSetManager();
    fw.checkpointManager = null;
    fw.mcplHostCapabilities = { version: '0.5' };
    fw.mcplServerRegistry = {
      getAllServers: () => (registered ? [connection] : []),
      getServer: (id: string) => (registered && id === 'srv' ? connection : null),
      addServer: async (_config: unknown, _caps: unknown, _signal: unknown, onRegister?: (c: unknown) => void) => {
        onRegister?.(connection);
        registered = true;
        return connection;
      },
    };
    fw.handleToolsListChanged = () => { relisted++; };
    fw.beginDiscordAwarenessBarrier = () => {
      const pending = accounting.shift();
      return pending
        ? { requiresBarrier: true, promise: pending }
        : { requiresBarrier: false, promise: Promise.resolve({ status: 'delivered', delivered: 0, failed: 0 }) };
    };
    const traces: string[] = [];
    fw.onTrace((event: { type: string }) => traces.push(event.type));
    return {
      fw,
      connection,
      answers,
      failures,
      counts,
      relisted: () => relisted,
      /** The next gate waits on accounting this test settles. */
      pendingAccounting: () => {
        let settle!: () => void;
        accounting.push(new Promise<unknown>((resolve) => { settle = () => resolve({ status: 'delivered', delivered: 0, failed: 0 }); }));
        return settle;
      },
      /** The next gate's accounting fails with this error. */
      failingAccounting: (error: Error) => {
        const failed = Promise.reject(error);
        failed.catch(() => {});
        accounting.push(failed);
      },
      announced: () => traces.filter((type) => type === 'mcpl:server-reconnected' || type === 'module:added'),
      settle: () => new Promise((resolve) => setImmediate(resolve)),
      /** A connection already serving, with the framework's listeners. */
      serve: () => { registered = true; fw.wireMcplEvents(connection, config); },
      /** What startup's staged open, a resume or an awareness sync does: a
       *  gate over every connection, released and completed. */
      gate: async () => {
        const barrier = fw.installMcplDataPlaneGate();
        fw.releaseMcplDataPlaneGate(barrier);
        await barrier.promise;
        fw.completeMcplDataPlaneGate(barrier);
      },
      /** Another server's tools/list_changed, with nothing pending: its gate
       *  completes as it is released, synchronously. */
      listChange: () => fw.releaseMcplDataPlaneGate(fw.installMcplDataPlaneGate()),
      reconnect: () => { connection.transportEpoch++; connection.isConnected = true; connection.emit('reconnect', { attempts: 1 }); },
      /** The transport closes, as its close handler leaves the connection. */
      drop: () => { connection.transportEpoch++; connection.isConnected = false; },
      connect: () => fw.connectMcplServerInternal(config),
      /** A legacy connect that a disconnect of its id displaced while it ran. */
      connectDisplaced: () => fw.connectHeldMcplServer(config, 'legacy', false, () => true),
    };
  }

  it("no other gate (startup's staged open, a resume) releases a reconnect's traffic before its exchange settles", async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    await h.gate();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'held, both planes, while the policy exchange is in flight');
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 }, 'opened once its exchange settled, though the gate that replaced its own had completed');
    assert.deepEqual(h.announced(), ['mcpl:server-reconnected', 'module:added']);
    await h.gate();
    assert.equal(h.counts.opened, 2, 'and no longer passed by');
  });

  it("another server's list change during a reconnect's exchange doesn't open it either", async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    h.listChange();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 });
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 });
  });

  it('a superseded exchange never opens the planes of the transport that replaced it', async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    h.reconnect(); // the first fresh transport died; a newer one is exchanging
    h.answers[0]({ accepted: true });
    await h.settle();
    // The newer transport is connected, so only the epoch tells the older
    // exchange's transport apart from it.
    assert.deepEqual(h.announced(), [], 'the older exchange announces nothing');
    assert.equal(h.relisted(), 0, 'nor relists the tools');
    await h.gate();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'the older answer grants nothing, and the newer exchange is still in flight');
    h.answers[1]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 });
  });

  it('a transport that drops during its exchange is not announced, and its late answer grants nothing', async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    h.drop();
    h.answers[0]({ accepted: true }); // answered just as the transport went
    await h.settle();
    // Its gate's completion still readies every connection, this one between
    // transports too: what a boundary kept stays held for the next grant
    // (mcpl-reconnect-events pins that), and its own reports go on.
    assert.equal(h.counts.granted, 0, "the dead transport's answer grants nothing");
    assert.deepEqual(h.announced(), [], 'and announces nothing');
    assert.equal(h.relisted(), 0, 'nor relists its tools');
    // The next transport's exchange grants, opens and announces.
    const opened = h.counts.opened;
    h.reconnect();
    h.answers[1]({ accepted: true });
    await h.settle();
    assert.equal(h.counts.granted, 1);
    assert.equal(h.counts.opened, opened + 1);
    assert.deepEqual(h.announced(), ['mcpl:server-reconnected', 'module:added']);
    assert.equal(h.relisted(), 1);
  });

  it('a transport that drops after its exchange, before its awareness drain ends, is not announced', async () => {
    const h = harness();
    h.serve();
    const settleAccounting = h.pendingAccounting(); // the reconnect's own gate waits on a drain
    h.reconnect();
    h.answers[0]({ accepted: true });
    await h.settle();
    h.drop();
    settleAccounting();
    await h.settle();
    assert.deepEqual(h.announced(), [], 'its close reported it gone; the next reconnect announces it');
  });

  it("is announced though a newer gate replaced its own before the drain ended, so a stub's first reconnect is announced", async () => {
    const h = harness();
    h.serve();
    const settleAccounting = h.pendingAccounting(); // the reconnect's own gate waits on a drain
    h.reconnect();
    h.listChange(); // another server's list change replaces it
    h.answers[0]({ accepted: true });
    await h.settle();
    settleAccounting();
    await h.settle();
    assert.deepEqual(h.announced(), ['mcpl:server-reconnected', 'module:added']);
  });

  it("says a policy Request its transport's close ended was ended by the close, not unanswered", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const h = harness();
    h.serve();
    h.reconnect();
    h.drop();
    h.failures[0](new Error('the connection closed'));
    await h.settle();
    assert.ok(logged.some((line) => line.includes('its transport closed during the initial policy Request')), logged.join('\n'));
    assert.equal(logged.some((line) => line.includes('did not answer the initial policy Request')), false);
  });

  it("an exchange that settles while a newer gate holds data opens only its control plane, and that gate's completion its data", async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    const settleAccounting = h.pendingAccounting();
    const sync = h.gate(); // an awareness sync with work pending: its gate releases control planes and holds data
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, "the sync's release passes the exchange by");
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 1, granted: 1 });
    settleAccounting();
    await sync;
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 1, granted: 1 });
  });

  it('a reconnect on a quiesced host opens only the control plane, and a resume the data plane', async () => {
    const h = harness();
    h.serve();
    h.fw.quiesced = true;
    h.reconnect();
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 1, granted: 1 }, 'data stays held for the maintenance window');
    h.fw.quiesced = false;
    await h.gate(); // resume()
    assert.equal(h.counts.opened, 1);
  });

  it("a reconnect whose exchange a gate overtook on a quiesced host opens only its control plane", async () => {
    const h = harness();
    h.serve();
    h.fw.quiesced = true;
    h.reconnect();
    await h.gate();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'held, control plane too, while the exchange is in flight');
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 1, granted: 1 });
  });

  it("a runtime connect's exchange holds its planes against a gate until it settles", async () => {
    const h = harness();
    const connecting = h.connect();
    await h.settle();
    assert.equal(h.answers.length, 1, 'its policy Request is in flight');
    await h.gate(); // a resume during the connect
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'held while the exchange is in flight');
    h.answers[0]({ accepted: true });
    await connecting;
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 }, 'opened by the connect once the grant exists');
  });

  it("a gate that completes as the registry registers a runtime connect passes it by, since the connect marks it at registration", async () => {
    const h = harness();
    const registry = h.fw.mcplServerRegistry;
    const add = registry.addServer;
    registry.addServer = async (...args: unknown[]) => {
      const connection = await add(...args);
      h.listChange(); // completes before the connect's continuation runs
      return connection;
    };
    const connecting = h.connect();
    await h.settle();
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'held by its marker from registration');
    h.answers[0]({ accepted: true });
    await connecting;
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 });
  });

  it("a runtime connect's planes stay held against a gate that completes during its awareness accounting", async () => {
    const h = harness();
    const settleAccounting = h.pendingAccounting();
    const connecting = h.connect();
    await h.settle();
    await h.gate(); // a resume while the connect's accounting runs
    assert.deepEqual(h.counts, { opened: 0, controlOnly: 0, granted: 0 }, 'held before its exchange begins');
    settleAccounting();
    await h.settle();
    h.answers[0]({ accepted: true });
    await connecting;
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 1 });
  });

  it('a runtime connect whose awareness accounting fails is closed while still marked, and no later gate passes it by', async () => {
    const h = harness();
    // A stub, whose first connect failed: closing one already closed leaves
    // its epoch, so its marker would still match had it not lifted.
    h.connection.isConnected = false;
    // A close that fails, which keeps the connection registered; and the host
    // stopping meanwhile, so the failed gate is completed as a completed one
    // is, not recycled.
    h.fw.queue = { isClosed: false };
    const markedAtClose: boolean[] = [];
    h.fw.closeFailedRuntimeConnect = async (connection: { transportEpoch: number }) => {
      markedAtClose.push(h.fw.mcplPolicyExchanges.get(connection) === connection.transportEpoch);
      h.fw.queue.isClosed = true;
    };
    h.failingAccounting(new Error('ledger unreadable'));
    await assert.rejects(h.connect(), /ledger unreadable/);
    assert.deepEqual(markedAtClose, [true], 'closed before its marker lifted');
    // Closed for good, a real connection readies only its own reports, such
    // as a stub's connect-failed: the failed gate's completion reached it.
    assert.equal(h.counts.opened, 1);
  });

  it('a runtime connect that a disconnect displaced lifts its marker after its removal, even a removal that failed', async () => {
    const h = harness();
    h.connection.isConnected = false; // a stub, as above
    let openedDuringRemoval = -1;
    h.fw.mcplServerRegistry.removeServer = async () => {
      await h.gate(); // a gate completing while the removal runs
      openedDuringRemoval = h.counts.opened;
      throw new Error('its child could not be reaped');
    };
    await assert.rejects(h.connectDisplaced(), /it was disconnected while connecting; its cleanup also failed/);
    assert.equal(openedDuringRemoval, 0, 'still marked while its removal ran');
    // Closed for good, a real connection readies only its own reports.
    await h.gate();
    assert.equal(h.counts.opened, 1, 'the next gate reaches it');
  });

  it('a runtime connect whose transport drops during its exchange grants nothing and is not announced', async () => {
    const h = harness();
    const connecting = h.connect();
    await h.settle();
    h.drop();
    h.answers[0]({ accepted: true });
    await connecting;
    assert.equal(h.counts.granted, 0);
    assert.deepEqual(h.announced(), [], 'its reconnect announces it');
  });

  it("a runtime connect whose transport a reconnect replaced during its accounting runs no exchange of its own, and is announced once", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const h = harness();
    const settleAccounting = h.pendingAccounting();
    const connecting = h.connect();
    await h.settle();
    h.reconnect(); // its transport dropped, and the next one is exchanging
    h.answers[0]({ accepted: true });
    await h.settle();
    settleAccounting();
    await h.settle();
    await h.settle();
    const exchanges = h.answers.length;
    if (exchanges > 1) h.answers[1]({ accepted: true }); // so the connect still ends
    await connecting;
    await h.settle();
    assert.equal(exchanges, 1, "one exchange, the reconnect's");
    assert.deepEqual(h.announced(), ['mcpl:server-reconnected', 'module:added'], 'announced once, by the reconnect');
    assert.ok(logged.some((line) => line.includes('its transport closed before its policy exchange')), logged.join('\n'));
  });

  it("a runtime connect whose transport closes during its gate's flush is not announced", async () => {
    const h = harness();
    const ready = h.connection.ready;
    h.connection.ready = () => { ready(); h.drop(); }; // a listener the flush ran closed the transport
    const connecting = h.connect();
    await h.settle();
    h.answers[0]({ accepted: true });
    await connecting;
    assert.equal(h.counts.granted, 1);
    assert.deepEqual(h.announced(), [], 'its close reported it gone; its reconnect announces it');
  });

  it("a reconnect whose transport closes during its release's flush is neither relisted nor announced", async () => {
    const h = harness();
    h.serve();
    const ready = h.connection.ready;
    h.reconnect();
    h.connection.ready = () => { ready(); h.drop(); }; // a listener the flush ran closed the transport
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.equal(h.counts.granted, 1);
    assert.equal(h.relisted(), 0, 'its close reported it gone; the next reconnect relists');
    assert.deepEqual(h.announced(), []);
  });

  it("a reconnect whose policy step throws is opened with its grant empty, as on main, and its marker lifts", async (t) => {
    t.mock.method(console, 'error', () => {});
    const h = harness();
    h.serve();
    h.fw.registerMcplServerFeatures = async () => { throw new Error('the policy step failed'); };
    h.reconnect();
    await h.settle();
    assert.deepEqual(h.counts, { opened: 1, controlOnly: 0, granted: 0 }, 'opened MCP-only by its own gate');
    assert.deepEqual(h.announced(), ['mcpl:server-reconnected', 'module:added'], 'announced once it settles, granted or not');
    await h.gate();
    assert.equal(h.counts.opened, 2, 'and no later gate passes it by');
  });

  for (const [how, settle] of [
    ['is refused', (h: ReturnType<typeof harness>) => h.answers[0]({ accepted: false } as never)],
    ['goes unanswered', (h: ReturnType<typeof harness>) => h.failures[0](new Error('no answer'))],
  ] as const) {
    it(`a reconnect whose policy Request ${how} is announced once it settles, granted or not`, async (t) => {
      t.mock.method(console, 'error', () => {});
      const h = harness();
      h.serve();
      h.reconnect();
      settle(h);
      await h.settle();
      assert.equal(h.counts.opened, 1, 'opened MCP-only');
      assert.deepEqual(h.announced(), ['mcpl:server-reconnected', 'module:added']);
    });
  }

  it("a reconnect whose gate a newer one replaced, and whose transport drops before its exchange settles, is readied between transports", async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    h.listChange(); // replaces its gate and completes, passing the connection by
    h.drop();
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.equal(h.counts.granted, 0, "the dead transport's answer grants nothing");
    assert.equal(h.counts.opened, 1, 'readied, as any gate readies a connection between transports, so its own reports go on');
    assert.deepEqual(h.announced(), []);
  });

  it("a runtime connect whose gate a newer one replaced, and whose transport drops during its exchange, is readied between transports", async () => {
    const h = harness();
    const connecting = h.connect();
    await h.settle();
    h.listChange(); // replaces its gate and completes, passing the connection by
    h.drop();
    h.answers[0]({ accepted: true });
    await connecting;
    assert.equal(h.counts.granted, 0);
    assert.equal(h.counts.opened, 1, 'readied between transports, so its own reports go on');
    assert.deepEqual(h.announced(), []);
  });

  it("a gate that completes after the transport dropped, before its exchange settles, isn't held by that exchange's marker", async () => {
    const h = harness();
    h.serve();
    h.reconnect();
    h.drop(); // its exchange is still in flight, for a transport that is gone
    await h.gate();
    assert.equal(h.counts.opened, 1, 'readied between transports, so its own reports go on');
    h.answers[0]({ accepted: true });
    await h.settle();
    assert.equal(h.counts.granted, 0);
  });
});
