import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/awareness-barrier-mcpl-server.mjs', import.meta.url));
const TEST_ROOT = join(process.cwd(), '.test-tmp');

interface StatusRecord {
  event: string;
  generation: number;
  serverId?: string;
  accepted?: boolean;
  ledgerStatus?: string;
  method?: string;
  ordinal?: number;
}

function records(path: string): StatusRecord[] {
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StatusRecord);
  } catch {
    return [];
  }
}

async function waitFor(
  description: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function preparePending(outboxPath: string): DiscordAwarenessOutbox {
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  const batch = outbox.prepare({
    agentName: 'assistant',
    sourceBranch: 'source',
    targetBranch: 'main',
    activationPolicy: 'explicit',
    refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-1' }],
  });
  assert.ok(batch);
  outbox.activate(batch.id);
  return outbox;
}

function frameworkConfig(
  dir: string,
  extraEnv: Record<string, string> = {},
  requestTimeoutMs = 1_000,
  serverOverrides: Partial<McplServerConfig> = {},
  awarenessDeadlineMs = 1_000,
) {
  const outboxPath = join(dir, 'awareness.json');
  return {
    outboxPath,
    config: {
      storePath: join(dir, 'store'),
      discordAwarenessOutboxPath: outboxPath,
      discordAwarenessDeadlineMs: awarenessDeadlineMs,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
      modules: [],
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        requestTimeoutMs,
        env: extraEnv,
        enabledFeatureSets: ['chat'],
        ...serverOverrides,
      }],
    },
  };
}

function twoServerFrameworkConfig(
  dir: string,
  order: 'heartbeat-first' | 'discord-first',
  dataMethod: typeof DATA_METHODS[number],
  runtime = false,
) {
  const outboxPath = join(dir, 'awareness.json');
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const listChangePath = join(dir, 'list-change');
  const arrivalPath = join(dir, 'heartbeat-arrival');
  const server = (id: 'heartbeat' | 'discord'): McplServerConfig => ({
    id,
    command: process.execPath,
    args: [FIXTURE],
    // The host/command matrix leg models the legitimate slash-command relay:
    // host-owned authority is the operator's config decision (PR #79
    // blocker 9), so the test config makes it, exactly as the fleet's
    // discord config will at rollout.
    allowHostCommands: true,
    requestTimeoutMs: 0,
    env: {
      STATUS_PATH: statusPath,
      LEDGER_PATH: outboxPath,
      SERVER_ID: id,
      DATA_METHOD: dataMethod,
      ...(id === 'discord'
        ? { RELEASE_PATH: releasePath, WAIT_FOR_ARRIVAL_PATH: arrivalPath }
        : { ARRIVAL_PATH: arrivalPath }),
      ...(runtime && id === 'heartbeat' ? { LIST_CHANGE_PATH: listChangePath } : {}),
    },
    enabledFeatureSets: ['chat'],
  });
  const servers = order === 'heartbeat-first'
    ? [server('heartbeat'), server('discord')]
    : [server('discord'), server('heartbeat')];
  return {
    outboxPath,
    statusPath,
    releasePath,
    listChangePath,
    config: {
      storePath: join(dir, 'store'),
      discordAwarenessOutboxPath: outboxPath,
      discordAwarenessDeadlineMs: 1_000,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
      modules: [],
      mcplServers: servers,
    },
  };
}

const DATA_METHODS = [
  'push/event',
  'inference/request',
  'channels/incoming',
  'host/command',
] as const;

for (const order of ['heartbeat-first', 'discord-first'] as const) {
  for (const dataMethod of DATA_METHODS) test(
    `startup globally gates ${dataMethod} with ${order} config`,
    async () => {
      mkdirSync(TEST_ROOT, { recursive: true });
      const dir = mkdtempSync(join(TEST_ROOT, 'awareness-startup-'));
      const { outboxPath, statusPath, releasePath, config } = twoServerFrameworkConfig(
        dir,
        order,
        dataMethod,
      );
      const outbox = preparePending(outboxPath);
      let framework: AgentFramework | undefined;
      let createSettled = false;
      const creating = AgentFramework.create(config).then((created) => {
        framework = created;
        createSettled = true;
        return created;
      });

      try {
        await waitFor('registration and a second control response', () => {
          const events = records(statusPath)
            .filter((record) => record.serverId === 'discord')
            .map((record) => record.event);
          return events.includes('registration-response')
            && events.includes('control-response-during-barrier');
        });

        const discordOrdering = records(statusPath)
          .filter((record) => record.serverId === 'discord')
          .map((record) => record.event)
          .filter((event) => [
            'reaction-queued-before-registration',
            'registration-response',
            'reaction-call',
          ].includes(event));
        assert.deepEqual(discordOrdering, [
          'reaction-queued-before-registration',
          'registration-response',
          'reaction-call',
        ]);
        const allStatus = records(statusPath);
        const heartbeatArrival = allStatus.findIndex((record) =>
          record.serverId === 'heartbeat' && record.event === 'data-request-sent');
        const discordDrain = allStatus.findIndex((record) =>
          record.serverId === 'discord' && record.event === 'reaction-queued-before-registration');
        assert.ok(
          heartbeatArrival >= 0 && heartbeatArrival < discordDrain,
          'non-Discord data arrives before Discord registration/drain starts',
        );

        assert.equal(createSettled, false, 'framework readiness must wait for the marker outcome');
        assert.equal(
          records(statusPath).some((record) =>
            record.serverId === 'heartbeat' && record.event === 'push-response'),
          false,
          `non-Discord ${dataMethod} must remain held while the Discord marker is pending`,
        );
        assert.equal(outbox.pending('discord').length, 1);

        writeFileSync(releasePath, 'release');
        await creating;
        await waitFor('gated push response', () =>
          records(statusPath).some((record) =>
            record.serverId === 'heartbeat' && record.event === 'push-response'));

        const status = records(statusPath);
        const push = status.find((record) =>
          record.serverId === 'heartbeat' && record.event === 'push-response');
        assert.equal(push?.method, dataMethod);
        assert.equal(push?.accepted, true);
        assert.equal(push?.ledgerStatus, 'applied', 'push released only after durable success');
        assert.equal(outbox.pending('discord').length, 0);
        assert.equal(status.filter((record) =>
          record.serverId === 'discord' && record.event === 'reaction-call').length, 1);
      } finally {
        await framework?.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
}

test('mandatory awareness deadline survives requestTimeoutMs: 0 and durably releases startup', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-timeout-'));
  const statusPath = join(dir, 'status.jsonl');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    FAIL_REACTION: '1',
  }, 0, {}, 60);
  const outbox = preparePending(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    await waitFor('push response after timeout accounting', () =>
      records(statusPath).some((record) => record.event === 'push-response'));

    const entry = outbox.batches()[0]!.refs[0]!;
    assert.equal(entry.deliveryStatus, 'pending');
    assert.equal(entry.attempts, 1);
    assert.match(entry.lastError ?? '', /did not respond to tools\/call/);
    assert.match(entry.lastError ?? '', /outcome is unknown/i);
    assert.equal(records(statusPath).filter((record) => record.event === 'reaction-call').length, 1);
    const push = records(statusPath).find((record) => record.event === 'push-response');
    assert.equal(push?.ledgerStatus, 'pending', 'failure was durable before inference release');
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('permanent marker failure is durably accounted before startup data is released', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-permanent-'));
  const statusPath = join(dir, 'status.jsonl');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    PERMANENT_REACTION: '1',
  });
  const outbox = preparePending(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    await waitFor('data response after permanent failure accounting', () =>
      records(statusPath).some((record) => record.event === 'push-response'));

    const entry = outbox.batches()[0]!.refs[0]!;
    assert.equal(entry.deliveryStatus, 'permanent-failure');
    assert.equal(entry.attempts, 1);
    assert.match(entry.lastError ?? '', /Unknown Message/);
    const response = records(statusPath).find((record) => record.event === 'push-response');
    assert.equal(response?.ledgerStatus, 'permanent-failure');
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initial reconnect stub durably records unavailable work, then retries behind a fresh gate', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-initial-unavailable-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const generationPath = join(dir, 'generation');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
    GENERATION_PATH: generationPath,
    FAIL_INITIAL_GENERATION: '1',
  }, 1_000, {
    reconnect: true,
    reconnectIntervalMs: 100,
    reconnectMaxIntervalMs: 100,
  });
  const outbox = preparePending(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    const deferred = outbox.batches()[0]!.refs[0]!;
    assert.equal(deferred.deliveryStatus, 'pending');
    assert.equal(deferred.attempts, 1, 'ready state must include a durable unavailable attempt');
    assert.match(deferred.lastError ?? '', /not attempted.*connection unavailable/i);

    await waitFor('successful reconnect registration and awareness call', () => {
      const second = records(statusPath).filter((record) => record.generation === 2);
      return second.some((record) => record.event === 'registration-response')
        && second.some((record) => record.event === 'reaction-call');
    });
    assert.equal(
      records(statusPath).some((record) =>
        record.generation === 2 && record.event === 'push-response'),
      false,
      'reconnect data remains behind the newly installed awareness gate',
    );

    writeFileSync(releasePath, 'release');
    await waitFor('reconnected data after durable marker success', () =>
      records(statusPath).some((record) =>
        record.generation === 2 && record.event === 'push-response'));
    assert.equal(outbox.pending('discord').length, 0);
    assert.equal(outbox.batches()[0]!.refs[0]!.attempts, 2);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/list_changed installs the data gate before a following push', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-list-change-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const listChangePath = join(dir, 'list-change');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
    LIST_CHANGE_PATH: listChangePath,
  });
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    await waitFor('initial zero-pending push response', () =>
      records(statusPath).some((record) => record.event === 'push-response'));

    const batch = outbox.prepare({
      agentName: 'assistant',
      sourceBranch: 'source',
      targetBranch: 'main',
      activationPolicy: 'explicit',
      refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-list' }],
    });
    assert.ok(batch);
    outbox.activate(batch.id);
    writeFileSync(listChangePath, 'change');

    await waitFor('control response while list-change barrier is pending', () => {
      const status = records(statusPath);
      return status.some((record) => record.event === 'tools-list-changed-notification')
        && status.some((record) => record.event === 'control-response-during-barrier');
    });
    assert.equal(
      records(statusPath).some((record) => record.event === 'list-change-push-response'),
      false,
    );

    writeFileSync(releasePath, 'release');
    await waitFor('list-change gated push response', () =>
      records(statusPath).some((record) => record.event === 'list-change-push-response'));
    const push = records(statusPath).find((record) => record.event === 'list-change-push-response');
    assert.equal(push?.ledgerStatus, 'applied');
    assert.equal(outbox.pending('discord').length, 0);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const dataMethod of DATA_METHODS) test(
  `runtime awareness generation globally gates non-Discord ${dataMethod}`,
  async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TEST_ROOT, 'awareness-runtime-global-'));
    const {
      outboxPath,
      statusPath,
      releasePath,
      listChangePath,
      config,
    } = twoServerFrameworkConfig(dir, 'discord-first', dataMethod, true);
    const outbox = new DiscordAwarenessOutbox(outboxPath);
    let framework: AgentFramework | undefined;

    try {
      framework = await AgentFramework.create(config);
      await waitFor('both initial data responses', () => {
        const initial = records(statusPath).filter((record) => record.event === 'push-response');
        return initial.some((record) => record.serverId === 'discord')
          && initial.some((record) => record.serverId === 'heartbeat');
      });

      const batch = outbox.prepare({
        agentName: 'assistant',
        sourceBranch: 'source',
        targetBranch: 'main',
        activationPolicy: 'explicit',
        refs: [{
          serverId: 'discord',
          channelId: 'discord:guild:startup',
          messageId: `runtime-global-${dataMethod}`,
        }],
      });
      assert.ok(batch);
      outbox.activate(batch.id);
      writeFileSync(listChangePath, 'change');

      await waitFor('Discord marker call for heartbeat generation', () =>
        records(statusPath).some((record) =>
          record.serverId === 'discord' && record.event === 'reaction-call'));
      assert.equal(
        records(statusPath).some((record) =>
          record.serverId === 'heartbeat' && record.event === 'list-change-push-response'),
        false,
        `fresh heartbeat ${dataMethod} must wait for Discord accounting`,
      );

      writeFileSync(releasePath, 'release');
      await waitFor('globally gated runtime response', () =>
        records(statusPath).some((record) =>
          record.serverId === 'heartbeat' && record.event === 'list-change-push-response'));
      const response = records(statusPath).find((record) =>
        record.serverId === 'heartbeat' && record.event === 'list-change-push-response');
      assert.equal(response?.method, dataMethod);
      assert.equal(response?.ledgerStatus, 'applied');
      assert.equal(outbox.pending('discord').length, 0);
    } finally {
      await framework?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('reconnect pauses fresh inbound data but permits registration and awareness tool service', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-reconnect-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const crashPath = join(dir, 'crash');
  const generationPath = join(dir, 'generation');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
    CRASH_PATH: crashPath,
    GENERATION_PATH: generationPath,
  }, 1_000, {
    reconnect: true,
    reconnectIntervalMs: 20,
    reconnectMaxIntervalMs: 20,
  });
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    // No startup marker: this path must release push responders synchronously.
    framework = await AgentFramework.create(config);
    await waitFor('initial synchronous push response', () =>
      records(statusPath).some((record) => record.generation === 1 && record.event === 'push-response'));

    const batch = outbox.prepare({
      agentName: 'assistant',
      sourceBranch: 'source',
      targetBranch: 'main',
      activationPolicy: 'explicit',
      refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-2' }],
    });
    assert.ok(batch);
    outbox.activate(batch.id);
    writeFileSync(crashPath, 'crash');

    await waitFor('reconnect control plane during pending barrier', () => {
      const second = records(statusPath).filter((record) => record.generation === 2);
      return second.some((record) => record.event === 'registration-response')
        && second.some((record) => record.event === 'control-response-during-barrier');
    });
    assert.equal(
      records(statusPath).some((record) => record.generation === 2 && record.event === 'push-response'),
      false,
      'fresh reconnect data must not pass the new gate',
    );

    writeFileSync(releasePath, 'release');
    await waitFor('reconnect gated push response', () =>
      records(statusPath).some((record) => record.generation === 2 && record.event === 'push-response'));
    const push = records(statusPath).find(
      (record) => record.generation === 2 && record.event === 'push-response',
    );
    assert.equal(push?.ledgerStatus, 'applied');
    assert.equal(outbox.pending('discord').length, 0);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup fails explicitly when awareness reconciliation throws', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-reconcile-failure-'));
  const statusPath = join(dir, 'status.jsonl');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
  });
  preparePending(outboxPath);

  const prototype = DiscordAwarenessOutbox.prototype as any;
  const original = prototype.reconcileForBranch;
  let calls = 0;
  prototype.reconcileForBranch = function (...args: unknown[]) {
    calls++;
    if (calls === 2) throw new Error('injected reconcile failure');
    return original.apply(this, args);
  };
  try {
    await assert.rejects(
      AgentFramework.create(config),
      /awareness accounting failed.*injected reconcile failure/i,
    );
    assert.equal(
      records(statusPath).some((record) => record.event === 'push-response'),
      false,
      'failed startup never reports a released data plane',
    );
  } finally {
    prototype.reconcileForBranch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startup fails explicitly when the awareness ledger read throws', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-read-failure-'));
  const { outboxPath, config } = frameworkConfig(dir);
  preparePending(outboxPath);

  const prototype = DiscordAwarenessOutbox.prototype as any;
  const original = prototype.pending;
  prototype.pending = () => { throw new Error('injected read failure'); };
  try {
    await assert.rejects(
      AgentFramework.create(config),
      /awareness accounting failed.*injected read failure/i,
    );
  } finally {
    prototype.pending = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const writeMethod of ['recordSuccess', 'recordFailure'] as const) test(
  `startup fails explicitly when ${writeMethod} cannot persist`,
  async () => {
    mkdirSync(TEST_ROOT, { recursive: true });
    const dir = mkdtempSync(join(TEST_ROOT, `awareness-${writeMethod}-failure-`));
    const statusPath = join(dir, 'status.jsonl');
    const { outboxPath, config } = frameworkConfig(dir, {
      STATUS_PATH: statusPath,
      LEDGER_PATH: join(dir, 'awareness.json'),
      ...(writeMethod === 'recordFailure' ? { PERMANENT_REACTION: '1' } : {}),
    });
    preparePending(outboxPath);

    const prototype = DiscordAwarenessOutbox.prototype as any;
    const original = prototype[writeMethod];
    prototype[writeMethod] = () => { throw new Error(`injected ${writeMethod} write failure`); };
    try {
      await assert.rejects(
        AgentFramework.create(config),
        new RegExp(`awareness accounting failed.*injected ${writeMethod} write failure`, 'i'),
      );
      assert.equal(
        records(statusPath).some((record) => record.event === 'push-response'),
        false,
      );
    } finally {
      prototype[writeMethod] = original;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test('runtime reconciliation failure recycles the connection and keeps fresh data gated', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-runtime-accounting-'));
  const statusPath = join(dir, 'status.jsonl');
  const releasePath = join(dir, 'release');
  const listChangePath = join(dir, 'list-change');
  const generationPath = join(dir, 'generation');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    RELEASE_PATH: releasePath,
    LIST_CHANGE_PATH: listChangePath,
    GENERATION_PATH: generationPath,
  }, 1_000, {
    reconnect: true,
    reconnectIntervalMs: 20,
    reconnectMaxIntervalMs: 20,
  });
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  let framework: AgentFramework | undefined;

  try {
    framework = await AgentFramework.create(config);
    await waitFor('initial response', () =>
      records(statusPath).some((record) => record.event === 'push-response'));
    const batch = outbox.prepare({
      agentName: 'assistant',
      sourceBranch: 'source',
      targetBranch: 'main',
      activationPolicy: 'explicit',
      refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'runtime-fail' }],
    })!;
    outbox.activate(batch.id);

    const prototype = DiscordAwarenessOutbox.prototype as any;
    const original = prototype.reconcileForBranch;
    let injected = false;
    prototype.reconcileForBranch = function (...args: unknown[]) {
      if (!injected) {
        injected = true;
        throw new Error('injected runtime reconcile failure');
      }
      return original.apply(this, args);
    };
    try {
      writeFileSync(listChangePath, 'change');
      await waitFor('replacement connection awareness call', () =>
        records(statusPath).some((record) =>
          record.generation === 2 && record.event === 'reaction-call'));
    } finally {
      prototype.reconcileForBranch = original;
    }

    assert.equal(
      records(statusPath).some((record) =>
        record.generation === 2 && record.event === 'push-response'),
      false,
    );
    writeFileSync(releasePath, 'release');
    await waitFor('replacement connection data release', () =>
      records(statusPath).some((record) =>
        record.generation === 2 && record.event === 'push-response'));
    assert.equal(outbox.pending('discord').length, 0);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a control flush that installs a newer generation cannot be released by the old barrier', async () => {
  const oldDrain = deferred<any>();
  const newDrain = deferred<any>();
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.discordAwarenessBarrier = null;
  framework.discordAwarenessBarrierGeneration = 0;
  const drains = [oldDrain.promise, newDrain.promise];
  framework.beginDiscordAwarenessBarrier = () => ({
    requiresBarrier: true,
    promise: drains.shift(),
  });

  let readyCalls = 0;
  let newer: any;
  const connection = {
    id: 'discord',
    pauseDataPlane: () => {},
    ready: () => { readyCalls++; },
    readyControlPlane: () => {
      if (newer) return;
      newer = framework.installMcplDataPlaneGate();
      framework.releaseMcplDataPlaneGate(newer);
    },
  };
  framework.mcplServerRegistry = { getAllServers: () => [connection] };

  const older = framework.installMcplDataPlaneGate();
  framework.releaseMcplDataPlaneGate(older);
  assert.equal(newer.generation, older.generation + 1);

  oldDrain.resolve({ status: 'delivered', delivered: 1, failed: 0 });
  await older.promise;
  assert.equal(framework.completeMcplDataPlaneGate(older), false);
  assert.equal(readyCalls, 0, 'old completion leaves fresh data held');

  newDrain.resolve({ status: 'delivered', delivered: 1, failed: 0 });
  await newer.promise;
  assert.equal(framework.completeMcplDataPlaneGate(newer), true);
  assert.equal(readyCalls, 1);
});

test('overlapping reconnect/list-change generations release only the newest barrier', async () => {
  const reconnectDrain = deferred<any>();
  const listChangeDrain = deferred<any>();
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.discordAwarenessBarrier = null;
  framework.discordAwarenessBarrierGeneration = 0;
  const drains = [reconnectDrain.promise, listChangeDrain.promise];
  framework.beginDiscordAwarenessBarrier = () => ({
    requiresBarrier: true,
    promise: drains.shift(),
  });
  let readyCalls = 0;
  const connection = {
    id: 'discord',
    pauseDataPlane: () => {},
    readyControlPlane: () => {},
    ready: () => { readyCalls++; },
  };
  framework.mcplServerRegistry = { getAllServers: () => [connection] };

  const reconnectBarrier = framework.installMcplDataPlaneGate();
  framework.releaseMcplDataPlaneGate(reconnectBarrier);
  const listChangeBarrier = framework.installMcplDataPlaneGate();
  framework.releaseMcplDataPlaneGate(listChangeBarrier);

  reconnectDrain.resolve({ status: 'delivered', delivered: 1, failed: 0 });
  await reconnectBarrier.promise;
  framework.completeMcplDataPlaneGate(reconnectBarrier);
  assert.equal(readyCalls, 0, 'reconnect completion cannot bypass overlapping list-change work');

  listChangeDrain.resolve({ status: 'delivered', delivered: 1, failed: 0 });
  await listChangeBarrier.promise;
  framework.completeMcplDataPlaneGate(listChangeBarrier);
  assert.equal(readyCalls, 1);
});

test('synchronous zero-pending flush rechecks the gate after a nested list change', () => {
  const connection = new (McplServerConnection as any)(
    'discord', null, null,
  ) as McplServerConnection;
  // This test exercises plane-flush mechanics, not authorization: admission
  // now enforces the grant (§5.4), so model the post-policy state or the
  // push is correctly discarded before it can count.
  connection.establishGrant(new CapabilityGrant(new Set(['pushEvents']), []));
  let dataDeliveries = 0;
  connection.on('tools-list-changed', () => connection.pauseDataPlane());
  connection.on('push-event', () => { dataDeliveries++; });

  connection.emit('tools-list-changed');
  connection.emit('push-event', {});
  connection.ready();
  assert.equal(
    dataDeliveries,
    0,
    'the nested list-change pause must retain later items from the same ready() snapshot',
  );

  connection.ready();
  assert.equal(dataDeliveries, 1);
});
