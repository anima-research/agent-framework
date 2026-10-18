import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentFramework } from '../src/framework.js';
import { buildChildEnv } from '../src/mcpl/transport.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { REFUSAL_REACTION_BASELINE } from '../src/refusal-reactions.js';

const KEY = 'DISCORD_SUPPRESSED_REACTIONS_BASELINE';
/** The framework's protective default for the stub below (awareness emoji 🔕, no ledger). */
const DEFAULT = [...REFUSAL_REACTION_BASELINE, '💤', '🔕'].join(',');

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

/** The value a Windows child gets: the composed env through buildChildEnv's
 * win32 merge with the host env, which leaves one spelling of each name. */
function windowsChildValue(composed: Record<string, string>, inheritEnv: boolean, host: NodeJS.ProcessEnv): string | undefined {
  const child = buildChildEnv({ env: composed, inheritEnv }, host, 'win32');
  const spellings = Object.keys(child).filter((key) => key.toUpperCase() === KEY);
  assert.equal(spellings.length, 1, `one spelling reaches the child: ${spellings.join(', ')}`);
  return child[spellings[0]!];
}

for (const inheritEnv of [false, true]) {
  test('Windows reaction baseline honors declared case variants, inheritEnv=' + inheritEnv, async () => {
    // A blank value counts as unset: where the spelling Node's spawn keeps is
    // blank, the child gets the protective default.
    const cases: Array<{ env: Record<string, string>; expected: string }> = [
      { env: { [KEY.toLowerCase()]: '' }, expected: DEFAULT },
      { env: { Discord_Suppressed_Reactions_Baseline: '🟪' }, expected: '🟪' },
      { env: { [KEY]: 'upper', [KEY.toLowerCase()]: '' }, expected: 'upper' },
      { env: { [KEY.toLowerCase()]: '', [KEY]: 'upper' }, expected: 'upper' },
      { env: { [KEY]: '', [KEY.toLowerCase()]: 'lower' }, expected: DEFAULT },
      { env: { [KEY.toLowerCase()]: 'lower', [KEY]: '' }, expected: DEFAULT },
    ];
    for (const { env, expected } of cases) {
      const composed = await connectionEnv('win32', env, inheritEnv);
      // The chosen value must survive the spawn's own merge (#205), which
      // keeps the first spelling of a folded name within each source.
      assert.equal(windowsChildValue(composed, inheritEnv, process.env), expected);
      assert.equal(composed[KEY], expected, 'a generated default must not replace an explicit choice');
    }
  });
}

test('Windows inherited-only baseline lookup handles case-sensitive worker env copies', async () => {
  for (const value of ['', '🟪']) {
    // A blank inherited value counts as unset, like a blank declared one.
    const kept = value === '' ? DEFAULT : value;
    const cases: Array<{ parent: NodeJS.ProcessEnv; expected: string }> = [
      { parent: { [KEY.toLowerCase()]: value }, expected: kept },
      { parent: { Discord_Suppressed_Reactions_Baseline: value }, expected: kept },
      { parent: { [KEY]: 'upper', [KEY.toLowerCase()]: value }, expected: 'upper' },
      { parent: { [KEY.toLowerCase()]: value, [KEY]: 'upper' }, expected: 'upper' },
      { parent: { [KEY]: value, [KEY.toLowerCase()]: 'lower' }, expected: kept },
      { parent: { [KEY.toLowerCase()]: 'lower', [KEY]: value }, expected: kept },
    ];
    for (const { parent, expected } of cases) {
      const composed = await connectionEnv('win32', {}, true, parent);
      assert.equal(composed[KEY], expected);
      assert.equal(windowsChildValue(composed, true, parent), expected);
    }
  }
});

test('Windows chooses duplicate spellings within each source, then declared over inherited', async () => {
  const parent = { [KEY]: 'host-upper', [KEY.toLowerCase()]: 'host-lower' };
  const composed = await connectionEnv('win32', { [KEY.toLowerCase()]: '', [KEY]: 'declared-upper' }, true, parent);
  assert.equal(composed[KEY], 'declared-upper');
  assert.equal(windowsChildValue(composed, true, parent), 'declared-upper');
  const singleDeclared = await connectionEnv('win32', { [KEY.toLowerCase()]: '' }, true, parent);
  assert.equal(singleDeclared[KEY], 'host-upper', 'a blank declared value is unset, so the inherited choice stands');
  assert.equal(windowsChildValue(singleDeclared, true, parent), 'host-upper');
});

test('inherited-only baseline lookup remains opt-in and POSIX case-sensitive', async () => {
  for (const [platform, inheritEnv] of [['win32', false], ['linux', true]] as const) {
    const composed = await connectionEnv(platform, {}, inheritEnv, { [KEY.toLowerCase()]: '' });
    assert.ok(composed[KEY]!.split(',').includes('💤'));
  }
  const explicitPosix = await connectionEnv('linux', {}, true, { [KEY]: '' });
  assert.equal(explicitPosix[KEY], DEFAULT, 'a blank inherited value is unset');
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

test('an inheritEnv that is not true never reads the host baseline: the protective default stands', async () => {
  // create() and connectMcplServer refuse such a value; this is the read a
  // config reaching connectMcplServerInternal unchecked would meet.
  for (const inheritEnv of ['false', 'true', 1]) {
    const composed = await connectionEnv('linux', {}, inheritEnv as unknown as boolean, { [KEY]: '🟦' });
    assert.equal(composed[KEY], DEFAULT, JSON.stringify(inheritEnv));
  }
  const inherited = await connectionEnv('linux', {}, true, { [KEY]: '🟦' });
  assert.equal(inherited[KEY], '🟦', 'true still inherits it');
});
