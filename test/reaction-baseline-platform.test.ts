import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import type { McplServerConfig } from '../src/mcpl/types.js';

const KEY = 'DISCORD_SUPPRESSED_REACTIONS_BASELINE';

/** Exercise the real default-injection boundary, intercepting immediately
 * before connection/spawn. Platform/env overrides are synchronous and restored
 * before awaiting anything, so asynchronous work sees the real process state. */
async function connectionEnv(
  platform: NodeJS.Platform,
  env: Record<string, string>,
  inheritEnv = false,
  parentEnv?: NodeJS.ProcessEnv,
  transportConfig: Pick<McplServerConfig, 'url' | 'transport'> = {},
): Promise<Record<string, string>> {
  let captured: McplServerConfig | undefined;
  const stopBeforeSpawn = new Error('captured before spawn');
  const framework = Object.assign(Object.create(AgentFramework.prototype), {
    mcplHostCapabilities: {},
    mcplPrefixMap: new Map(),
    mcplServerConfigs: new Map(),
    channelRegistry: null,
    discordAwarenessOutbox: null,
    discordAwarenessEmoji: '🔕',
    mcplServerRegistry: {
      async addServer(config: McplServerConfig) {
        captured = config;
        throw stopBeforeSpawn;
      },
    },
  }) as AgentFramework;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const originalParentEnv = Object.getOwnPropertyDescriptor(process, 'env')!;
  const originalEnv = { ...env };
  let connection: Promise<void>;
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    if (parentEnv) Object.defineProperty(process, 'env', { ...originalParentEnv, value: parentEnv });
    connection = (framework as unknown as {
      connectMcplServerInternal(config: McplServerConfig): Promise<void>;
    }).connectMcplServerInternal({ id: 'probe', command: 'unused', env, inheritEnv, ...transportConfig });
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
    Object.defineProperty(process, 'env', originalParentEnv);
  }
  await assert.rejects(connection!, (error) => error === stopBeforeSpawn);
  assert.deepEqual(env, originalEnv, 'connection composition must not mutate the caller env');
  assert.ok(captured?.env);
  return captured.env;
}

for (const inheritEnv of [false, true]) {
  test('Windows reaction baseline honors declared case variants, inheritEnv=' + inheritEnv, async () => {
    const cases: Array<Record<string, string>> = [
      { [KEY.toLowerCase()]: '' },
      { Discord_Suppressed_Reactions_Baseline: '🟪' },
      { [KEY]: 'first', [KEY.toLowerCase()]: '' },
      { [KEY.toLowerCase()]: 'first', [KEY]: 'last' },
    ];
    for (const env of cases) {
      const expected = Object.values(env).at(-1);
      const composed = await connectionEnv('win32', env, inheritEnv);
      // Node's Windows spawn sorts and keeps the first spelling of a folded
      // name. The chosen value must survive that step as well as #205's merge.
      const emittedKey = Object.keys(composed).sort().find((key) => key.toUpperCase() === KEY)!;
      assert.equal(composed[emittedKey], expected);
      assert.equal(composed[KEY], expected, 'a generated default must not replace an explicit choice');
    }
  });
}

test('Windows inherited-only baseline lookup handles case-sensitive worker env copies', async () => {
  for (const value of ['', '🟪']) {
    const parents: NodeJS.ProcessEnv[] = [
      { [KEY.toLowerCase()]: value },
      { Discord_Suppressed_Reactions_Baseline: value },
      { [KEY]: 'first', [KEY.toLowerCase()]: value },
      { [KEY.toLowerCase()]: 'first', [KEY]: value },
    ];
    for (const parent of parents) {
      const composed = await connectionEnv('win32', {}, true, parent);
      assert.equal(composed[KEY], value);
    }
  }
});

test('inherited-only baseline lookup remains opt-in and POSIX case-sensitive', async () => {
  for (const [platform, inheritEnv] of [['win32', false], ['linux', true]] as const) {
    const composed = await connectionEnv(platform, {}, inheritEnv, { [KEY.toLowerCase()]: '' });
    assert.ok(composed[KEY]!.split(',').includes('💤'));
  }
  const explicitPosix = await connectionEnv('linux', {}, true, { [KEY]: '' });
  assert.equal(explicitPosix[KEY], '');
});

test('explicit WebSocket selection leaves its env alone even when a command is also present', async () => {
  const env = { EXTRA: 'value' };
  const composed = await connectionEnv('linux', env, false, undefined, { transport: 'websocket', url: 'ws://unused' });
  assert.deepEqual(composed, env);
});

test('POSIX reaction baseline keeps differently cased env names distinct', async () => {
  const composed = await connectionEnv('linux', { [KEY.toLowerCase()]: '' });
  assert.equal(composed[KEY.toLowerCase()], '');
  assert.ok(composed[KEY]!.split(',').includes('💤'));
  assert.ok(composed[KEY]!.split(',').includes('🔕'));
});
