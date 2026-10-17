import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { REFUSAL_REACTION_BASELINE } from '../src/refusal-reactions.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const ENV_KEY = 'DISCORD_SUPPRESSED_REACTIONS_BASELINE';
const FIXTURE = fileURLToPath(new URL('./fixtures/reaction-baseline-mcpl-server.mjs', import.meta.url));

function server(overrides: Partial<McplServerConfig> = {}): McplServerConfig {
  return { id: 'probe', command: process.execPath, args: [FIXTURE], ...overrides };
}

function baseline(framework: AgentFramework): readonly string[] {
  // Keep this runtime API assertion compilable against the unfixed source.
  return (framework as unknown as { getPlacedReactionBaseline(): readonly string[] }).getPlacedReactionBaseline();
}

// A refusal for an awareness journal that can't be read, met by the read a
// connect or restart makes to derive the protective default: the journal's
// own refusal (as breakJournal leaves it) is the cause. The assertions after
// each refusal say what it left behind.
function accountingRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'DiscordAwarenessAccountingError'
    && /The Discord awareness journal can't be read in this process/.test(error.message);
}

async function childEnv(framework: AgentFramework) {
  const registry = (framework as unknown as {
    mcplServerRegistry: { getServer(id: string): { sendToolsCall(name: string, args: {}): Promise<{ content: Array<{ text?: string }> }> } };
  }).mcplServerRegistry;
  const result = await registry.getServer('probe').sendToolsCall('read_env', {});
  return JSON.parse(result.content[0]!.text!) as { baseline?: string; extra?: string };
}

describe('placed-reaction baseline', () => {
  let dir: string;
  let outboxPath: string;
  let framework: AgentFramework | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'placed-reactions-'));
    outboxPath = join(dir, 'outbox.json');
  });

  afterEach(async () => {
    await framework?.stop();
    framework = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function create(emoji?: string, servers: McplServerConfig[] = []) {
    framework = await AgentFramework.create({
      storePath: join(dir, 'test.chronicle'),
      membrane: new MockMembrane().asMembrane(),
      agents: [{ name: 'resident', model: 'test-model', systemPrompt: 'Resident.' }],
      modules: [],
      discordAwarenessOutboxPath: outboxPath,
      discordAwarenessEmoji: emoji,
      mcplServers: servers,
    });
    return framework;
  }

  /** The running framework's own journal instance (the journal's one writer). */
  const journal = (fw: AgentFramework) =>
    (fw as unknown as { discordAwarenessOutbox: DiscordAwarenessOutbox }).discordAwarenessOutbox;

  /**
   * Retain a batch with this marker in the store's journal: through the
   * running framework's own journal, or, before one runs, in the store
   * directly.
   */
  function retain(emoji: string, opts: { activate?: boolean } = {}) {
    const input = {
      agentName: 'resident',
      sourceBranch: 'main',
      targetBranch: 'later-recovery',
      emoji,
      scope: 'all' as const,
      refs: [{ serverId: 'discord', channelId: 'discord:guild:channel', messageId: emoji }],
    };
    const prepareIn = (outbox: DiscordAwarenessOutbox) => {
      const batch = outbox.prepare(input)!;
      if (opts.activate) outbox.activate(batch.id);
      return batch;
    };
    if (framework) return prepareIn(journal(framework));
    const store = JsStore.openOrCreate({ path: join(dir, 'test.chronicle') });
    try {
      return prepareIn(new DiscordAwarenessOutbox(store));
    } finally {
      store.close();
    }
  }

  /**
   * Leave the running framework's journal unreadable for the rest of this
   * process, as an append that threw inside the store does (RecordJournal's
   * needsReopen): every read of it throws from now on.
   */
  function breakJournal(fw: AgentFramework): void {
    (journal(fw) as unknown as { journal: { unreadable: unknown } }).journal.unreadable =
      new Error('an append threw inside the store');
  }

  it('includes default awareness and refusal markers once, with a fresh snapshot', async () => {
    const fw = await create();
    const expected = [...REFUSAL_REACTION_BASELINE, '💤'];
    assert.deepEqual(baseline(fw), expected);
    (baseline(fw) as string[]).push('not-a-framework-marker');
    assert.deepEqual(baseline(fw), expected);
  });

  it('keeps the adapter default alongside configured and retained offline awareness markers', async () => {
    retain('🫥');
    // An active batch's marker stays covered: its marks can later be removed.
    retain('👁️', { activate: true });
    const fw = await create('🔕');
    assert.deepEqual(new Set(baseline(fw)), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕', '🫥', '👁️']));
    assert.equal(baseline(fw).length, new Set(baseline(fw)).size);
  });

  for (const emoji of ['<:mark:123456789012345678>', '<a:mark:123456789012345678>', 'mark:123456789012345678', 'a:mark:123456789012345678']) {
    it('injects a stable custom-emote ID for configured marker ' + emoji, async () => {
      const fw = await create(emoji, [server()]);
      const expected = [...REFUSAL_REACTION_BASELINE, '💤', '123456789012345678'];
      assert.deepEqual(baseline(fw), expected);
      assert.equal((await childEnv(fw)).baseline, expected.join(','));
    });
  }

  it('canonicalizes retained custom markers before deduplication without changing the ledger', async () => {
    const first = retain('<:old_name:123456789012345678>');
    retain('new_name:123456789012345678');
    retain('<a:another:123456789012345679>');
    const fw = await create('123456789012345678');
    assert.deepEqual(baseline(fw), [...REFUSAL_REACTION_BASELINE, '💤', '123456789012345678', '123456789012345679']);
    const stored = journal(fw).batches();
    assert.equal(stored.find((batch) => batch.id === first.id)?.emoji, '<:old_name:123456789012345678>');
  });

  it('preserves Unicode and name tokens while accepting padded full custom markers', async () => {
    retain('👩‍💻');
    retain(':name_only:');
    retain('not:a:custom');
    const fw = await create('  <:mark:123456789012345678>  ');
    assert.deepEqual(baseline(fw), [...REFUSAL_REACTION_BASELINE, '💤', '123456789012345678', '👩‍💻', ':name_only:', 'not:a:custom']);
  });

  it('deduplicates a configured marker already used for refusals', async () => {
    const fw = await create(REFUSAL_REACTION_BASELINE[0]);
    assert.deepEqual(baseline(fw), [...REFUSAL_REACTION_BASELINE, '💤']);
  });

  it('injects the complete default into a real child at framework startup', async () => {
    retain('🫥');
    const config = server({ env: { BASELINE_TEST_EXTRA: 'preserved' } });
    const fw = await create('🔕', [config]);
    const env = await childEnv(fw);
    assert.deepEqual(new Set(env.baseline?.split(',')), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕', '🫥']));
    assert.equal(env.extra, 'preserved');
    assert.deepEqual(config.env, { BASELINE_TEST_EXTRA: 'preserved' }, 'caller config stays unchanged');
  });

  for (const transport of [undefined, 'stdio'] as const) {
    it('injects the baseline with command + URL and ' + (transport ?? 'implicit') + ' transport', async () => {
      const fw = await create('🔕', [server({ url: 'ws://127.0.0.1:1', transport })]);
      const env = await childEnv(fw);
      assert.deepEqual(new Set(env.baseline?.split(',')), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕']));
    });
  }

  it('derives the default on runtime connect, including newly retained ledger markers', async () => {
    const fw = await create('🔕');
    retain('🫥');
    await fw.connectMcplServer(server());
    const env = await childEnv(fw);
    assert.deepEqual(new Set(env.baseline?.split(',')), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕', '🫥']));
    retain('👁️');
    await fw.restartMcplServer('probe');
    assert.ok((await childEnv(fw)).baseline?.split(',').includes('👁️'), 'restart recomputes a default rather than retaining it as an explicit override');
  });

  for (const value of ['🟪', '<:operator_choice:123456789012345678>']) {
    it('preserves an explicit server baseline ' + JSON.stringify(value), async () => {
      const fw = await create(undefined, [server({ env: { [ENV_KEY]: value } })]);
      assert.equal((await childEnv(fw)).baseline, value);
    });

    it('preserves an intentionally inherited baseline ' + JSON.stringify(value), async (t) => {
      const previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = previous;
      });
      const fw = await create(undefined, [server({ inheritEnv: true })]);
      assert.equal((await childEnv(fw)).baseline, value);
    });
  }

  it('does not use an unrequested parent override; explicit server env wins over inheritance', async (t) => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = '🟥';
    t.after(() => {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    });
    const fw = await create(undefined, [server()]);
    // The literal default, not the function under test's own report.
    assert.equal((await childEnv(fw)).baseline, [...REFUSAL_REACTION_BASELINE, '💤'].join(','));
    await fw.disconnectMcplServer('probe');
    await fw.connectMcplServer(server({ inheritEnv: true, env: { [ENV_KEY]: '🟪' } }));
    assert.equal((await childEnv(fw)).baseline, '🟪');
  });

  it('reads a non-string declared baseline as the child sees it, rather than failing the connect, and a null as unset', async () => {
    // A config loaded from JSON can carry a number despite the type; spawn
    // writes it as its string form.
    const fw = await create(undefined, [server({ env: { [ENV_KEY]: 7 as unknown as string } })]);
    assert.equal((await childEnv(fw)).baseline, '7');
    // A null means no value: the derived default, not spawn's "null".
    await fw.disconnectMcplServer('probe');
    await fw.connectMcplServer(server({ env: { [ENV_KEY]: null as unknown as string } }));
    assert.equal((await childEnv(fw)).baseline, [...REFUSAL_REACTION_BASELINE, '💤'].join(','));
  });

  // discord-mcpl's parser (`parseSuppressionEnvTokens`) splits a value on
  // commas, trims each token, and keeps one when `normalizeReactionEmoji`
  // (discord-mcpl `src/filters.ts`) leaves something of it: that strips
  // U+FE0F, trims, and strips one leading and one trailing colon. A value it
  // reads as no tokens turns suppression off, so inherited by accident (an
  // empty variable, or `${A},${B}` or `:${NAME}:` with the variables empty)
  // it would turn the protective default off: such a value counts as unset.
  // A value it keeps a token of stays the operator's.
  for (const [value, tokens] of [
    ['', false],
    ['  ', false],
    [',', false],
    [' , ', false],
    [':', false],
    ['::', false],
    ['::,::', false],
    [' : , :: ', false],
    ['\uFE0F', false],
    // The adapter trims again after stripping U+FE0F, and only then strips
    // the colon.
    ['\uFE0F :', false],
    [':sigil:', true],
    ['sigil', true],
    ['🟪', true],
    ['<:mark:123456789012345678>', true],
    // One colon from each end leaves ':'.
    [':::', true],
  ] as const) {
    const name = JSON.stringify(value).replace(/\uFE0F/g, '\\uFE0F');
    it(`a baseline ${name}, declared or inherited, ${tokens ? 'stays the operator\'s' : 'has no tokens and counts as unset'}`, async (t) => {
      const previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[ENV_KEY];
        else process.env[ENV_KEY] = previous;
      });
      const expected = tokens ? value : [...REFUSAL_REACTION_BASELINE, '💤'].join(',');
      const fw = await create(undefined, [server({ env: { [ENV_KEY]: value } })]);
      assert.equal((await childEnv(fw)).baseline, expected, 'declared');
      await fw.disconnectMcplServer('probe');
      await fw.connectMcplServer(server({ inheritEnv: true }));
      assert.equal((await childEnv(fw)).baseline, expected, 'inherited');
    });
  }

  it("says at connect when an operator's value replaces the protective default", async (t) => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    t.after(() => { console.error = original; });
    const fw = await create(undefined, [server({ env: { [ENV_KEY]: '🟪' } })]);
    console.error = original;
    assert.ok(lines.some((line) => line.includes('[mcpl] probe: DISCORD_SUPPRESSED_REACTIONS_BASELINE from its env replaces the framework') ), lines.join('\n'));
    assert.equal((await childEnv(fw)).baseline, '🟪');
  });

  it('a reconnect respawns the child with a default derived at that spawn', async () => {
    const fw = await create(undefined, [server({ reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 20 })]);
    assert.equal((await childEnv(fw)).baseline?.split(',').includes('🫥'), false);
    retain('🫥');
    const registry = (fw as unknown as {
      mcplServerRegistry: { getServer(id: string): { sendToolsCall(name: string, args: {}): Promise<unknown> } };
    }).mcplServerRegistry;
    await registry.getServer('probe').sendToolsCall('crash', {}).catch(() => {});
    let env: { baseline?: string } | undefined;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      env = await childEnv(fw).catch(() => undefined);
      if (env) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(env, 'the child came back');
    assert.ok(env.baseline?.split(',').includes('🫥'), `the respawned child has the marker retained since: ${env.baseline}`);
  });

  it('a restart refuses on an unreadable journal when it derives the default, and leaves the child up', async () => {
    const fw = await create(undefined, [server()]);
    breakJournal(fw);
    await assert.rejects(() => fw.restartMcplServer('probe'), accountingRefusal);
    // A restart that stopped the child leaves no server to ask.
    assert.ok(await childEnv(fw).catch(() => undefined), 'the running child still answers');
  });

  it('a server with its own baseline, or a WebSocket one, connects and restarts whatever the journal\'s state', async () => {
    // Only a connect that derives the protective default reads the journal:
    // awareness never gates MCPL.
    const fw = await create(undefined, [server({ env: { [ENV_KEY]: '🟪' } })]);
    breakJournal(fw);
    assert.throws(() => baseline(fw), accountingRefusal, 'the journal is unreadable');
    await fw.restartMcplServer('probe');
    assert.equal((await childEnv(fw)).baseline, '🟪', 'restarted with its own baseline');
    await fw.disconnectMcplServer('probe');
    await fw.connectMcplServer(server({ reconnect: true, env: { [ENV_KEY]: '🟪' } }));
    assert.equal((await childEnv(fw)).baseline, '🟪', 'connected with its own baseline');
    // A WebSocket server owns its environment, so its connect reads nothing
    // either: it gets as far as the transport.
    await assert.rejects(
      () => fw.connectMcplServer({ id: 'remote', url: 'ws://127.0.0.1:1' }),
      /MCPL server "remote" WebSocket connect failed/,
    );
  });

  it('a server that inherits its baseline from the host connects and restarts whatever the journal\'s state', async (t) => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = '🟦';
    t.after(() => {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    });
    const fw = await create(undefined, [server({ inheritEnv: true })]);
    breakJournal(fw);
    await fw.restartMcplServer('probe');
    assert.equal((await childEnv(fw)).baseline, '🟦', 'restarted with the inherited baseline');
    await fw.disconnectMcplServer('probe');
    await fw.connectMcplServer(server({ inheritEnv: true }));
    assert.equal((await childEnv(fw)).baseline, '🟦', 'connected with the inherited baseline');
  });

  it('a child that takes the default is not respawned while the journal is unreadable: each reconnect fails and is retried', async () => {
    const fw = await create(undefined, [server({ reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 20 })]);
    const failures: string[] = [];
    fw.onTrace((event) => {
      if (event.type === 'mcpl:server-connect-failed') failures.push(String((event as { error?: unknown }).error));
    });
    breakJournal(fw);
    const registry = (fw as unknown as {
      mcplServerRegistry: {
        getServer(id: string): { sendToolsCall(name: string, args: {}): Promise<unknown>; isConnected: boolean; willReconnect: boolean };
      };
    }).mcplServerRegistry;
    await registry.getServer('probe').sendToolsCall('crash', {}).catch(() => {});
    const deadline = Date.now() + 5_000;
    while (failures.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(failures.length >= 2, `each attempt fails and the next is scheduled: ${failures.join(' | ')}`);
    for (const failure of failures) {
      assert.match(failure, /Discord awareness accounting failed during .*The Discord awareness journal can't be read in this process/);
    }
    assert.equal(registry.getServer('probe').isConnected, false, 'no child was spawned without the default');
    assert.equal(registry.getServer('probe').willReconnect, true, 'and it keeps retrying');
  });

  it('passes a URL-only WebSocket config through unchanged', async () => {
    const fw = await create();
    // Bring up the MCPL subsystem as a first runtime connect does.
    await (fw as unknown as { initializeMcpl(servers: McplServerConfig[]): Promise<void> }).initializeMcpl([]);
    let added: unknown;
    const registry = (fw as unknown as { mcplServerRegistry: { addServer(config: unknown): Promise<unknown> } }).mcplServerRegistry;
    registry.addServer = async (config: unknown) => { added = config; throw new Error('stop before connecting'); };
    const config: McplServerConfig = { id: 'remote', url: 'ws://127.0.0.1:1' };
    await assert.rejects(() => fw.connectMcplServer(config), /stop before connecting/);
    assert.equal(added, config, 'the same object');
    assert.equal(config.env, undefined, 'no env added');
  });

  for (const [marker, converted] of [
    [`<:mark:${'1'.repeat(16)}>`, false],
    [`<:mark:${'1'.repeat(17)}>`, true],
    [`mark:${'2'.repeat(20)}`, true],
    [`<:mark:${'3'.repeat(21)}>`, false],
    [`mark:${'4'.repeat(16)}`, false],
    [`<:mark:${'5'.repeat(20)}>`, true],
    [`mark:${'6'.repeat(17)}`, true],
    [`mark:${'7'.repeat(21)}`, false],
    ['a:b:1', false],
  ] as const) {
    it(`a custom marker ${marker} is ${converted ? '' : 'not '}reduced to its ID`, async () => {
      const fw = await create(marker);
      const id = /(\d+)>?$/.exec(marker)![1];
      assert.equal(baseline(fw).at(-1), converted ? id : marker);
    });
  }

  it('fails explicitly on an unreadable journal rather than deriving an incomplete default', async () => {
    const fw = await create(undefined, [server()]);
    breakJournal(fw);
    assert.throws(() => baseline(fw), accountingRefusal);
    const internals = fw as unknown as {
      mcplServerRegistry: { getServer(id: string): unknown };
      mcplServerConfigs: Map<string, unknown>;
      mcplPrefixMap: Map<string, string>;
    };
    assert.equal(internals.mcplPrefixMap.get('mcpl--probe'), 'probe', 'a connected server has its tool routing');
    await fw.disconnectMcplServer('probe');
    // A connect that derives the default reads the journal before it
    // registers anything: a reconnecting server would otherwise be left
    // registered as a closed stub that blocks a retried connect.
    for (const config of [server(), server({ reconnect: true })]) {
      await assert.rejects(() => fw.connectMcplServer(config), accountingRefusal);
      assert.equal(internals.mcplServerRegistry.getServer('probe'), null, 'no connection is left registered');
      assert.equal(internals.mcplServerConfigs.has('probe'), false, 'no config is left registered');
      assert.equal(internals.mcplPrefixMap.has('mcpl--probe'), false, 'no tool routing is left registered');
    }
  });
});
