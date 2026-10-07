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
 * startup is still staging other servers).
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
    // Mira-1605's reproduction (room-245): `retry` fails its first connect;
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
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'You are a resident.' }],
      modules: [],
      maintenanceIntervalMs: 0,
      mcplServers: [
        server('retry', { FAIL_FIRST_PATH: join(dir, 'failed-once'), POLICY_PENDING_PATH: pending, POLICY_RELEASE_PATH: release }),
        server('stager', { INITIALIZE_AFTER_PATH: pending }),
      ],
    });
    const retry = () => serverEvents(eventsPath).filter((e) => e.role === 'retry');
    // Startup has opened every plane it may; the retry's policy is still held.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(retry().some((e) => e.event === 'policy-held'), `events: ${JSON.stringify(retry())}`);
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
  });
});

describe('MCPL reconnect: a pending policy exchange holds its planes', () => {
  /** A framework stub with one connection whose policy answers are deferred. */
  function harness() {
    const answers: Array<(receipt: { accepted: true }) => void> = [];
    let opened = 0;
    const connection = Object.assign(new EventEmitter(), {
      id: 'srv',
      transportEpoch: 0,
      capabilities: { version: '0.5', pushEvents: true, featureSets: { chat: { description: 'chat', uses: ['pushEvents'] } } },
      mcpToolsAdvertised: false,
      establishGrant: () => {},
      sendFeatureSetsUpdateRequest: () => new Promise<{ accepted: true }>((resolve) => { answers.push(resolve); }),
      ready: () => { opened++; },
      readyControlPlane: () => { opened++; },
    });
    const fw = Object.create(AgentFramework.prototype) as any;
    fw.traceListeners = [];
    fw.mcplPolicyExchanges = new WeakMap();
    fw.mcplServerConfigs = new Map([['srv', { id: 'srv', command: 'unused', enabledFeatureSets: ['chat'] }]]);
    fw.featureSetManager = new FeatureSetManager();
    fw.checkpointManager = null;
    fw.mcplServerRegistry = { getAllServers: () => [connection], getServer: () => connection };
    fw.handleToolsListChanged = () => {};
    fw.wireMcplEvents(connection);
    return {
      fw,
      connection,
      answers,
      opened: () => opened,
      reconnect: () => { connection.transportEpoch++; connection.emit('reconnect', { attempts: 1 }); },
    };
  }

  it('no other opener (startup\'s staged open, resume) releases a reconnect\'s traffic before its exchange settles', async () => {
    const h = harness();
    h.reconnect();
    h.fw.readyMcplPlanes(); // startup's open of every connection, or resume()
    assert.equal(h.opened(), 0, 'held while the policy exchange is in flight');
    h.answers[0]({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.opened(), 1, 'opened by the reconnect once its exchange settled');
    h.fw.readyMcplPlanes();
    assert.equal(h.opened(), 2, 'and no longer held');
  });

  it('a superseded exchange never opens the planes of the transport that replaced it', async () => {
    const h = harness();
    h.reconnect();
    h.reconnect(); // the first fresh transport died; a newer one is exchanging
    h.answers[0]({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    h.fw.readyMcplPlanes();
    assert.equal(h.opened(), 0, 'the newer exchange is still in flight');
    h.answers[1]({ accepted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.opened(), 1);
  });
});
