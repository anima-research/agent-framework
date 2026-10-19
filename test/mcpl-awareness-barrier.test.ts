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
import { EventEmitter } from 'node:events';

import { AgentFramework } from '../src/framework.js';
import { McplServerConnection } from '../src/mcpl/server-connection.js';
import { CapabilityGrant } from '../src/mcpl/capability-grant.js';
import { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
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
    assert.match(entry.lastError ?? '', /didn't answer within/);
    assert.match(entry.lastError ?? '', /took effect is unknown/i);
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

test('a reconnect gate opens only after re-registration, even when the awareness drain settles first', async () => {
  // The gate is global: marks pending for one server keep every data plane
  // paused. Here the reconnecting server's re-registration (its §5.3 policy
  // reply) is held while another server's drain finishes. The reconnecting
  // server's data must wait for its grant, not only for the drain.
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-reconnect-grant-'));
  const outboxPath = join(dir, 'awareness.json');
  const statusPath = join(dir, 'status.jsonl');
  const crashPath = join(dir, 'crash');
  const policyHoldPath = join(dir, 'release-policy');
  const server = (id: 'discord' | 'heartbeat', env: Record<string, string>, reconnect = false): McplServerConfig => ({
    id,
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 0,
    env: { STATUS_PATH: statusPath, LEDGER_PATH: outboxPath, SERVER_ID: id, ...env },
    enabledFeatureSets: ['chat'],
    ...(reconnect ? { reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 20 } : {}),
  });
  const outbox = new DiscordAwarenessOutbox(outboxPath);
  let framework: AgentFramework | undefined;
  try {
    framework = await AgentFramework.create({
      storePath: join(dir, 'store'),
      discordAwarenessOutboxPath: outboxPath,
      discordAwarenessDeadlineMs: 1_000,
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'assistant', model: 'test', systemPrompt: 'test' }],
      modules: [],
      mcplServers: [
        server('discord', {}),
        server('heartbeat', {
          CRASH_PATH: crashPath,
          GENERATION_PATH: join(dir, 'heartbeat-generation'),
          POLICY_HOLD_PATH: policyHoldPath,
        }, true),
      ],
    });
    await waitFor('both servers\' startup data answered', () => ['discord', 'heartbeat'].every((id) =>
      records(statusPath).some((r) => r.serverId === id && r.generation === 1 && r.event === 'push-response')));

    // A mark pending for discord, then the heartbeat server drops and comes back.
    const batch = outbox.prepare({
      agentName: 'assistant',
      sourceBranch: 'source',
      targetBranch: 'main',
      activationPolicy: 'explicit',
      refs: [{ serverId: 'discord', channelId: 'discord:guild:startup', messageId: 'message-3' }],
    });
    assert.ok(batch);
    outbox.activate(batch.id);
    writeFileSync(crashPath, 'crash');

    await waitFor('the reconnect generation\'s policy held', () =>
      records(statusPath).some((r) => r.serverId === 'heartbeat' && r.generation === 2 && r.event === 'policy-held'));
    assert.ok(
      records(statusPath).some((r) => r.serverId === 'heartbeat' && r.generation === 2 && r.event === 'data-request-sent'),
      'the reconnected server has already sent the data its grant must hold',
    );
    await waitFor('discord\'s mark delivered while re-registration is held', () =>
      outbox.batches()[0]?.refs[0]?.deliveryStatus === 'applied');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(
      records(statusPath).some((r) => r.serverId === 'heartbeat' && r.generation === 2 && r.event === 'push-response'),
      false,
      'the reconnected server\'s data waits for its grant, though the drain has settled',
    );

    writeFileSync(policyHoldPath, 'release');
    await waitFor('the reconnected server\'s data after its grant', () =>
      records(statusPath).some((r) => r.serverId === 'heartbeat' && r.generation === 2 && r.event === 'push-response'));
    const push = records(statusPath).find((r) => r.serverId === 'heartbeat' && r.generation === 2 && r.event === 'push-response');
    assert.equal(push?.accepted, true, 'delivered under the re-established grant, not rejected fail-closed');
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

/** A second fixture server, `heartbeat`, for a framework to serve from create(). */
function heartbeatConfig(dir: string, overrides: Partial<McplServerConfig> = {}): McplServerConfig {
  return {
    id: 'heartbeat',
    command: process.execPath,
    args: [FIXTURE],
    requestTimeoutMs: 1_000,
    env: {
      SERVER_ID: 'heartbeat',
      STATUS_PATH: join(dir, 'heartbeat-status.jsonl'),
      GENERATION_PATH: join(dir, 'heartbeat-generation'),
    },
    enabledFeatureSets: ['chat'],
    ...overrides,
  };
}

/**
 * A framework serving `heartbeat`, then a runtime connect of `discord` whose
 * first connect fails, so the registry holds a reconnect stub, and whose
 * awareness accounting then fails (recordFailure throws). Serving another
 * server brings MCPL up at create(), so the runtime connect is the one that
 * accounts for the pending work: brought up lazily by that connect, MCPL
 * would account for it in its own startup barrier first. A failure after
 * create() stops the framework, so no child outlives the test.
 */
async function failRuntimeConnectWhileServing(dir: string, heartbeatOverrides: Partial<McplServerConfig> = {}) {
  const statusPath = join(dir, 'status.jsonl');
  const heartbeatStatusPath = join(dir, 'heartbeat-status.jsonl');
  const { outboxPath, config } = frameworkConfig(dir, {
    STATUS_PATH: statusPath,
    LEDGER_PATH: join(dir, 'awareness.json'),
    GENERATION_PATH: join(dir, 'generation'),
    FAIL_INITIAL_GENERATION: '1',
  }, 1_000, {
    reconnect: true,
    // A stub waiting a minute for its retry is down between retries when the
    // accounting failure closes it: the close that emits no 'close'.
    reconnectIntervalMs: 60_000,
    reconnectMaxIntervalMs: 60_000,
  });
  const discord = config.mcplServers[0]!;
  const heartbeat = heartbeatConfig(dir, heartbeatOverrides);
  const framework = await AgentFramework.create({ ...config, mcplServers: [heartbeat] });
  try {
    const traces: Array<{ type: string; serverId?: string; error?: string }> = [];
    framework.onTrace((event) => traces.push(event as never));
    preparePending(outboxPath);
    const prototype = DiscordAwarenessOutbox.prototype as any;
    const original = prototype.recordFailure;
    prototype.recordFailure = () => { throw new Error('injected recordFailure write failure'); };
    try {
      await assert.rejects(
        framework.connectMcplServer(discord),
        /awareness accounting failed.*injected recordFailure write failure/i,
      );
    } finally {
      prototype.recordFailure = original;
    }
    assert.equal(
      records(statusPath).filter((record) => record.event === 'initial-connect-failure').length,
      1,
      'the first connect failed, so the registry held a reconnect stub',
    );
    // The catch closes the refused connection before it fails the gate, so
    // the gate's failure finds it gone from the registry and doesn't trace or
    // recycle it.
    assert.equal(
      traces.some((trace) => trace.type === 'mcpl:server-error'
        && trace.serverId === discord.id
        && /accounting unhealthy/.test(trace.error ?? '')),
      false,
      'the refused connection was out of the registry when the gate failed',
    );
    return { framework, discord, heartbeatStatusPath, traces };
  } catch (error) {
    await framework.stop();
    throw error;
  }
}

test('a runtime connect whose awareness accounting fails frees the id of the reconnect stub it closed, and closes a running server without reconnect: true for good', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-runtime-stub-'));
  let framework: AgentFramework | undefined;

  try {
    const failed = await failRuntimeConnectWhileServing(dir);
    framework = failed.framework;

    // The running server has no reconnect: true, so the failed gate's
    // recycle closed it for good: neither connected and held, nor retrying.
    await waitFor('the running server closed for good', () => {
      const heartbeat = failed.framework.listMcplServers().find((server) => server.id === 'heartbeat');
      return heartbeat !== undefined && !heartbeat.connected && !heartbeat.retrying;
    }, 10_000);

    // Connecting the id again reaches the server: a stub left registered
    // would fail this connect as already registered.
    await framework.connectMcplServer(failed.discord);
    assert.equal(framework.listMcplServers().find((server) => server.id === 'discord')?.connected, true);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runtime connect whose awareness accounting fails fails its gate, so a running server is recycled rather than held', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-runtime-gate-'));
  let framework: AgentFramework | undefined;

  try {
    const failed = await failRuntimeConnectWhileServing(dir, {
      reconnect: true,
      reconnectIntervalMs: 20,
      reconnectMaxIntervalMs: 20,
    });
    framework = failed.framework;
    assert.ok(
      failed.traces.some((trace) => trace.type === 'mcpl:server-error'
        && trace.serverId === 'heartbeat'
        && /accounting unhealthy/.test(trace.error ?? '')),
      'the gate failed for the running server, as a failed gate on the other runtime paths does',
    );

    // Recycled, the server reconnects, and its data flows once its
    // reconnect's accounting succeeds: the new process's startup push is
    // answered.
    await waitFor('the recycled server\'s startup push answered', () =>
      records(failed.heartbeatStatusPath).some((record) =>
        record.generation === 2 && record.event === 'push-response'), 10_000);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A framework serving `heartbeat`, then a runtime connect of `discord` whose
 * awareness accounting succeeds and whose §5.3 policy registration throws
 * (initializeServer made to throw for it). With `closeFails`, the close that
 * follows fails once in its transport close, after close() has marked the
 * connection closed for good, as a real one fails. Returns the framework with
 * every patch undone; a failure before then stops it.
 */
async function failPolicyRegistrationWhileServing(dir: string, closeFails: boolean) {
  const { config } = frameworkConfig(dir, {
    STATUS_PATH: join(dir, 'status.jsonl'),
    LEDGER_PATH: join(dir, 'awareness.json'),
    GENERATION_PATH: join(dir, 'generation'),
  });
  const discord = config.mcplServers[0]!;
  const framework = await AgentFramework.create({ ...config, mcplServers: [heartbeatConfig(dir)] });
  try {
    const traces: Array<{ type: string; serverId?: string; error?: string }> = [];
    framework.onTrace((event) => traces.push(event as never));
    // Which servers' tools the framework asks to relist.
    const lists = framework as unknown as { handleToolsListChanged(id: string): void };
    const relist = lists.handleToolsListChanged.bind(framework);
    const refreshed: string[] = [];
    lists.handleToolsListChanged = (id: string) => { refreshed.push(id); relist(id); };
    const features = FeatureSetManager.prototype as any;
    const initializeServer = features.initializeServer;
    features.initializeServer = function (this: unknown, serverId: string, ...rest: unknown[]) {
      if (serverId === discord.id) throw new Error('injected policy registration failure');
      return initializeServer.call(this, serverId, ...rest);
    };
    // Whether its exchange's marker still held the failing connection's
    // planes when its close began, which marks it closed for good.
    const exchanges = (framework as unknown as { mcplPolicyExchanges: WeakMap<object, number> }).mcplPolicyExchanges;
    const markedAtClose: boolean[] = [];
    const connections = McplServerConnection.prototype as any;
    const close = connections.close;
    let closeFailed = false;
    connections.close = function (this: any) {
      if (this.id === discord.id) markedAtClose.push(exchanges.get(this) === this.transportEpoch);
      if (closeFails && this.id === discord.id && !closeFailed && this.transport) {
        closeFailed = true;
        const transport = this.transport;
        const transportClose = transport.close;
        transport.close = () => {
          transport.close = transportClose;
          return Promise.reject(new Error('injected close failure'));
        };
      }
      return close.call(this);
    };
    try {
      // The connect reports its own failure, not the close's.
      await assert.rejects(framework.connectMcplServer(discord), /injected policy registration failure/);
    } finally {
      features.initializeServer = initializeServer;
      connections.close = close;
    }
    assert.equal(closeFailed, closeFails, 'the close failed only when asked to');
    // So no gate, such as a resume finishing meanwhile, could ready it
    // between its exchange's end and its close.
    assert.deepEqual(markedAtClose, [true], 'it was closed once, while its exchange still held its planes');
    const internals = framework as unknown as {
      discordAwarenessBarrier: unknown;
      mcplServerRegistry: { getServer(id: string): unknown };
    };
    assert.equal(internals.discordAwarenessBarrier, null, 'the failed connect completed the gate it installed');
    const running = internals.mcplServerRegistry.getServer('heartbeat') as { isConnected: boolean; dataPlaneReady: boolean };
    assert.equal(running.isConnected, true, 'accounting succeeded, so the running server was not recycled');
    assert.equal(running.dataPlaneReady, true, 'the running server\'s data flows');
    assert.equal(
      traces.some((trace) => trace.type === 'mcpl:server-error' && /accounting unhealthy/.test(trace.error ?? '')),
      false,
      'no gate failed',
    );
    return { framework, discord, registry: internals.mcplServerRegistry, refreshed };
  } catch (error) {
    await framework.stop();
    throw error;
  }
}

test('a runtime connect whose policy registration throws closes its connection for good and completes its gate, so a running server keeps its data', async () => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-runtime-policy-'));
  let framework: AgentFramework | undefined;

  try {
    const failed = await failPolicyRegistrationWhileServing(dir, false);
    framework = failed.framework;
    assert.equal(failed.registry.getServer(failed.discord.id), null, 'the half-registered connection was closed for good');

    // Connecting the id again reaches the server.
    await framework.connectMcplServer(failed.discord);
    assert.equal(framework.listMcplServers().find((server) => server.id === failed.discord.id)?.connected, true);
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runtime connect whose policy registration throws and whose close then fails keeps that connection registered and paused through later gates, and logs the close', async (t) => {
  mkdirSync(TEST_ROOT, { recursive: true });
  const dir = mkdtempSync(join(TEST_ROOT, 'awareness-runtime-policy-close-'));
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  let framework: AgentFramework | undefined;

  try {
    const failed = await failPolicyRegistrationWhileServing(dir, true);
    framework = failed.framework;
    // A close that fails keeps the entry, so a later disconnect, restart or
    // shutdown can close it again. Closed for good, it readies nothing: not
    // at this connect's completion, and not at a later gate's.
    const refused = failed.registry.getServer(failed.discord.id) as { dataPlaneReady: boolean; willReconnect: boolean } | null;
    assert.ok(refused, 'the connection whose close failed is still registered');
    assert.equal(refused.willReconnect, false, 'its close had disarmed it before the transport close failed');
    assert.equal(refused.dataPlaneReady, false, 'the gate\'s completion left the refused connection paused');
    assert.ok(failed.refreshed.includes(failed.discord.id), 'a refresh of the tool list was asked for though its close failed');
    await failed.framework.syncDiscordAwarenessMarkers();
    assert.equal(refused.dataPlaneReady, false, 'a later gate\'s completion leaves it paused too');
    assert.ok(
      logged.some((line) => line.includes(`could not close MCPL server "${failed.discord.id}" after its policy registration failed`)
        && line.includes('injected close failure')),
      'the failed close was logged',
    );
  } finally {
    await framework?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  framework.mcplPolicyExchanges = new WeakMap();
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

test('while the host stops, a failed gate lets out what a running connection held, and nothing of one closed for good', async () => {
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplPolicyExchanges = new WeakMap();
  framework.discordAwarenessBarrier = null;
  framework.discordAwarenessBarrierGeneration = 0;
  framework.beginDiscordAwarenessBarrier = () => ({ requiresBarrier: true, promise: new Promise(() => {}) });
  framework.queue = { isClosed: true }; // stop() has closed the queue
  framework.emitTrace = () => {};
  const running = Reflect.construct(McplServerConnection, ['running', null, null]) as McplServerConnection;
  const closing = Reflect.construct(McplServerConnection, ['closing', null, null]) as McplServerConnection;
  framework.mcplServerRegistry = { getAllServers: () => [running, closing] };
  const delivered: string[] = [];
  for (const connection of [running, closing]) {
    connection.on('stderr', () => delivered.push(`${connection.id} control`));
    connection.on('held-data', () => delivered.push(`${connection.id} data`));
  }

  // Each connection holds a control event and a data event behind the gate.
  const barrier = framework.installMcplDataPlaneGate();
  for (const connection of [running, closing]) {
    connection.emit('stderr', 'a line');
    connection.emit('held-data', {});
  }
  assert.deepEqual(delivered, []);

  // closeAll has begun closing one of them, and that close is still under
  // way while the gate is released and then failed: close() closes the
  // connection for good as it starts.
  const closed = closing.close();
  framework.releaseMcplDataPlaneGate(barrier);
  assert.deepEqual(delivered, ['running control'], 'only the running connection lets out its control traffic');
  await framework.failMcplDataPlaneGate(barrier, 'test sync', new Error('accounting failed'));
  assert.equal(framework.discordAwarenessBarrier, null, 'the stopping host released the failed gate');
  assert.deepEqual(delivered, ['running control', 'running data'],
    'the running connection\'s held data reaches its listeners, and the closing one lets out nothing');
  await closed;
});

test('overlapping reconnect/list-change generations release only the newest barrier', async () => {
  const reconnectDrain = deferred<any>();
  const listChangeDrain = deferred<any>();
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.mcplPolicyExchanges = new WeakMap();
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

test('inbound handlers wait out a generation installed while they wait', async () => {
  const framework = Object.create(AgentFramework.prototype) as any;
  const first = deferred<any>();
  const second = deferred<any>();
  framework.discordAwarenessBarrier = { generation: 1, requiresBarrier: true, promise: first.promise };
  const handled: string[] = [];
  framework.pushHandler = { handlePushEvent: async () => { handled.push('push-event'); } };
  framework.inferenceRouter = { handleInferenceRequest: async () => { handled.push('inference-request'); } };
  framework.channelRegistry = { handleIncoming: async () => { handled.push('channels-incoming'); } };
  framework.handleHostCommand = async () => { handled.push('host-command'); return { ok: true }; };
  const connection = new EventEmitter() as any;
  connection.id = 'discord';
  framework.wireMcplEvents(connection, { id: 'discord' });
  const responder = { id: 1, respond: () => {}, respondError: () => {} };
  for (const event of ['push-event', 'inference-request', 'channels-incoming', 'host-command']) {
    connection.emit(event, {}, responder);
  }

  // A newer generation is armed while the handlers wait on the first.
  framework.discordAwarenessBarrier = { generation: 2, requiresBarrier: true, promise: second.promise };
  first.resolve({ status: 'delivered', delivered: 0, failed: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(handled, [], 'no handler runs behind the newer generation');

  framework.discordAwarenessBarrier = null;
  second.resolve({ status: 'delivered', delivered: 0, failed: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(handled.sort(), ['channels-incoming', 'host-command', 'inference-request', 'push-event']);
});

test('an inbound handler waiting on a generation that fails refuses its request and never runs it', async () => {
  // A generation fails when the awareness ledger can't be read or written, so
  // its marks were not all attempted: nothing that waited behind it may run,
  // and each request is answered with the failure rather than left waiting.
  const framework = Object.create(AgentFramework.prototype) as any;
  // Each refused request is reported as a handler failure, through
  // emitTrace, which iterates the trace listeners a constructed framework
  // always has (#318's registrations, which onTrace makes).
  framework.traceListeners = [];
  const failing = deferred<any>();
  framework.discordAwarenessBarrier = { generation: 1, requiresBarrier: true, promise: failing.promise };
  const handled: string[] = [];
  framework.pushHandler = { handlePushEvent: async () => { handled.push('push-event'); } };
  framework.inferenceRouter = { handleInferenceRequest: async () => { handled.push('inference-request'); } };
  framework.channelRegistry = { handleIncoming: async () => { handled.push('channels-incoming'); } };
  framework.handleHostCommand = async () => { handled.push('host-command'); return { ok: true }; };
  const connection = new EventEmitter() as any;
  connection.id = 'discord';
  framework.wireMcplEvents(connection, { id: 'discord' });
  const answers: Array<{ event: string; code?: number; result?: unknown }> = [];
  for (const event of ['push-event', 'inference-request', 'channels-incoming', 'host-command']) {
    connection.emit(event, {}, {
      id: 1,
      respond: (result: unknown) => { answers.push({ event, result }); },
      respondError: (code: number) => { answers.push({ event, code }); },
    });
  }

  failing.reject(new Error('injected accounting failure'));
  await waitFor('every request to be answered', () => answers.length === 4);
  assert.deepEqual(handled, [], 'nothing runs behind a failed generation');
  assert.deepEqual(
    answers.sort((a, b) => a.event.localeCompare(b.event)),
    ['channels-incoming', 'host-command', 'inference-request', 'push-event'].map((event) => ({ event, code: -32603 })),
    'each request is refused with the failure',
  );
});

test('with no generation current, an inbound event is handled in the turn it arrives', () => {
  // The push coalescer orders a push against its retraction by arrival, so a
  // handler with no gate to wait out must not yield first.
  const framework = Object.create(AgentFramework.prototype) as any;
  framework.discordAwarenessBarrier = null;
  const handled: string[] = [];
  framework.pushHandler = { handlePushEvent: async () => { handled.push('push-event'); } };
  framework.inferenceRouter = { handleInferenceRequest: async () => { handled.push('inference-request'); } };
  framework.channelRegistry = { handleIncoming: async () => { handled.push('channels-incoming'); } };
  framework.handleHostCommand = async () => { handled.push('host-command'); return { ok: true }; };
  const connection = new EventEmitter() as any;
  connection.id = 'discord';
  framework.wireMcplEvents(connection, { id: 'discord' });
  const responder = { id: 1, respond: () => {}, respondError: () => {} };
  for (const event of ['push-event', 'inference-request', 'channels-incoming', 'host-command']) {
    connection.emit(event, {}, responder);
  }
  assert.deepEqual(handled.sort(), ['channels-incoming', 'host-command', 'inference-request', 'push-event']);
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
