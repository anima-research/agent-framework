import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentFramework } from '../src/framework.js';
import { REFUSAL_REACTION_BASELINE } from '../src/refusal-reactions.js';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const ENV_KEY = 'DISCORD_SUPPRESSED_REACTIONS_BASELINE';
const FIXTURE = fileURLToPath(new URL('./fixtures/reaction-baseline-mcpl-server.mjs', import.meta.url));
const MODERN_FIXTURE = fileURLToPath(new URL('./fixtures/modern-mcp-server.mjs', import.meta.url));

function server(overrides: Partial<McplServerConfig> = {}): McplServerConfig {
  return { id: 'probe', command: process.execPath, args: [FIXTURE], ...overrides };
}

function baseline(framework: AgentFramework): readonly string[] {
  // Keep this runtime API assertion compilable against the unfixed source.
  return (framework as unknown as { getPlacedReactionBaseline(): readonly string[] }).getPlacedReactionBaseline();
}

// A refusal for an awareness ledger that can't be read, met by the read a
// connect or restart makes to derive the protective default: the ledger's
// own refusal (as breakLedger leaves it) is the cause. The assertions after
// each refusal say what it left behind.
function accountingRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === 'DiscordAwarenessAccountingError'
    && /Invalid Discord awareness ledger .*: it isn't JSON/.test(error.message);
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

  /** The running framework's own ledger instance (the ledger's one writer). */
  const ledger = (fw: AgentFramework) =>
    (fw as unknown as { discordAwarenessOutbox: DiscordAwarenessOutbox }).discordAwarenessOutbox;

  /**
   * Retain a batch with this marker in the ledger: through the running
   * framework's own instance, or, before one runs, in the file directly.
   */
  async function retain(emoji: string, opts: { activate?: boolean } = {}) {
    const input = {
      agentName: 'resident',
      sourceBranch: 'main',
      targetBranch: 'later-recovery',
      emoji,
      scope: 'all' as const,
      refs: [{ serverId: 'discord', channelId: 'discord:guild:channel', messageId: emoji }],
    };
    const outbox = framework ? ledger(framework) : new DiscordAwarenessOutbox(outboxPath);
    const batch = (await outbox.prepare(input))!;
    if (opts.activate) await outbox.activate(batch.id);
    return batch;
  }

  /**
   * Leave the running framework's ledger unreadable, as a write that failed
   * leaves it when the file can't be read back: every read of it throws
   * until the file reads again.
   */
  function breakLedger(fw: AgentFramework): void {
    writeFileSync(outboxPath, '{broken');
    (ledger(fw) as unknown as { state: unknown }).state = null;
  }

  it('includes default awareness and refusal markers once, with a fresh snapshot', async () => {
    const fw = await create();
    const expected = [...REFUSAL_REACTION_BASELINE, '💤'];
    assert.deepEqual(baseline(fw), expected);
    (baseline(fw) as string[]).push('not-a-framework-marker');
    assert.deepEqual(baseline(fw), expected);
  });

  it('keeps the adapter default alongside configured and retained offline awareness markers', async () => {
    await retain('🫥');
    // An active batch's marker stays covered: its marks can later be removed.
    await retain('👁️', { activate: true });
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
    const first = await retain('<:old_name:123456789012345678>');
    await retain('new_name:123456789012345678');
    await retain('<a:another:123456789012345679>');
    const fw = await create('123456789012345678');
    assert.deepEqual(baseline(fw), [...REFUSAL_REACTION_BASELINE, '💤', '123456789012345678', '123456789012345679']);
    const stored = ledger(fw).batches();
    assert.equal(stored.find((batch) => batch.id === first.id)?.emoji, '<:old_name:123456789012345678>');
  });

  it('preserves Unicode and name tokens while accepting padded full custom markers', async () => {
    await retain('👩‍💻');
    await retain(':name_only:');
    await retain('not:a:custom');
    const fw = await create('  <:mark:123456789012345678>  ');
    assert.deepEqual(baseline(fw), [...REFUSAL_REACTION_BASELINE, '💤', '123456789012345678', '👩‍💻', ':name_only:', 'not:a:custom']);
  });

  it('deduplicates a configured marker already used for refusals', async () => {
    const fw = await create(REFUSAL_REACTION_BASELINE[0]);
    assert.deepEqual(baseline(fw), [...REFUSAL_REACTION_BASELINE, '💤']);
  });

  it('injects the complete default into a real child at framework startup', async () => {
    await retain('🫥');
    const config = server({ env: { BASELINE_TEST_EXTRA: 'preserved' } });
    const fw = await create('🔕', [config]);
    const env = await childEnv(fw);
    assert.deepEqual(new Set(env.baseline?.split(',')), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕', '🫥']));
    assert.equal(env.extra, 'preserved');
    assert.deepEqual(config.env, { BASELINE_TEST_EXTRA: 'preserved' }, 'caller config stays unchanged');
  });

  it('injects the baseline with command + URL and stdio transport', async () => {
    const fw = await create('🔕', [server({ url: 'ws://127.0.0.1:1', transport: 'stdio' })]);
    const env = await childEnv(fw);
    assert.deepEqual(new Set(env.baseline?.split(',')), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕']));
  });

  it('refuses command + URL with no transport before spawning anything', async () => {
    // Which of the two the configuration means is ambiguous, so its binding
    // is refused: nothing is launched, and no baseline is derived for it.
    const fw = await create('🔕');
    await assert.rejects(
      () => fw.connectMcplServer(server({ url: 'ws://127.0.0.1:1' })),
      /"command" and "url" are both set, and no "transport" says which one to use/,
    );
    const registry = (fw as unknown as { mcplServerRegistry: { getServer(id: string): unknown } | null }).mcplServerRegistry;
    assert.equal(registry?.getServer('probe') ?? null, null, 'nothing is registered or spawned');
  });

  it('derives the default on runtime connect, including newly retained ledger markers', async () => {
    const fw = await create('🔕');
    await retain('🫥');
    await fw.connectMcplServer(server());
    const env = await childEnv(fw);
    assert.deepEqual(new Set(env.baseline?.split(',')), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕', '🫥']));
    await retain('👁️');
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
    await retain('🫥');
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

  it("a reconnect while the ledger can't be read fails as a reconnect, and the child comes back once it can", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const fw = await create(undefined, [server({ reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 20 })]);
    const connection = (fw as unknown as {
      mcplServerRegistry: { getServer(id: string): {
        isConnected: boolean;
        sendToolsCall(name: string, args: {}): Promise<unknown>;
        on(event: 'reconnect-failed', listener: (params: { error: string }) => void): void;
      } };
    }).mcplServerRegistry.getServer('probe');
    const failures: string[] = [];
    connection.on('reconnect-failed', ({ error }) => { failures.push(error); });
    breakLedger(fw);
    // Each spawn derives the child's default from the ledger, which, with its
    // document dropped (breakLedger), is read from the file, so a reconnect
    // fails there, and its failure is recorded with the same configuration.
    await connection.sendToolsCall('crash', {}).catch(() => {});
    const waitFor = async (condition: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!condition()) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await waitFor(() => logged.some((line) => line.startsWith('MCPL server "probe" reconnect failed: ')), 'a failed reconnect to be logged');
    assert.ok(
      logged.includes(`MCPL server "probe" reconnect failed: [withheld: the server's configuration couldn't be read to redact this]`),
      logged.join('\n'),
    );
    // The failure is reported, with its cause, for the framework to record.
    assert.match(failures[0] ?? '', /reaction-baseline ledger read/);
    // The attempts go on, so the child comes back once the ledger reads.
    rmSync(outboxPath, { force: true });
    await waitFor(() => connection.isConnected, 'the child to come back');
    assert.ok((await childEnv(fw)).baseline, 'the respawned child answers, with a default');
  });

  it("startup goes on past a server whose configuration a host passed can't be read, and logs its failed connect withheld", async (t) => {
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    // The connect reads env for the child's default, and fails; startup's
    // catch for it records the failure with the same configuration.
    const unreadable = server();
    Object.defineProperty(unreadable, 'env', { enumerable: true, get() { throw new Error('the host cannot read it'); } });
    const fw = await create(undefined, [unreadable]);
    assert.ok(
      logged.includes(`Failed to connect MCPL server "probe": [withheld: the server's configuration couldn't be read to redact this]`),
      logged.join('\n'),
    );
    assert.equal(fw.listMcplServers().some((s) => s.connected), false);
  });

  it('a restart refuses on an unreadable ledger when it derives the default, and leaves the child up', async () => {
    const fw = await create(undefined, [server()]);
    breakLedger(fw);
    await assert.rejects(() => fw.restartMcplServer('probe'), accountingRefusal);
    // A restart that stopped the child leaves no server to ask.
    assert.ok(await childEnv(fw).catch(() => undefined), 'the running child still answers');
  });

  it('a server with its own baseline, or a WebSocket one, connects and restarts whatever the ledger\'s state', async () => {
    // Only a connect that derives the protective default reads the ledger:
    // awareness never gates MCPL.
    const fw = await create(undefined, [server({ env: { [ENV_KEY]: '🟪' } })]);
    breakLedger(fw);
    assert.throws(() => baseline(fw), accountingRefusal, 'the ledger is unreadable');
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

  it('a server that inherits its baseline from the host connects and restarts whatever the ledger\'s state', async (t) => {
    const previous = process.env[ENV_KEY];
    process.env[ENV_KEY] = '🟦';
    t.after(() => {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    });
    const fw = await create(undefined, [server({ inheritEnv: true })]);
    breakLedger(fw);
    await fw.restartMcplServer('probe');
    assert.equal((await childEnv(fw)).baseline, '🟦', 'restarted with the inherited baseline');
    await fw.disconnectMcplServer('probe');
    await fw.connectMcplServer(server({ inheritEnv: true }));
    assert.equal((await childEnv(fw)).baseline, '🟦', 'connected with the inherited baseline');
  });

  it('a child that takes the default is not respawned while the ledger is unreadable: each reconnect fails and is retried', async () => {
    const fw = await create(undefined, [server({ reconnect: true, reconnectIntervalMs: 20, reconnectMaxIntervalMs: 20 })]);
    const failures: string[] = [];
    fw.onTrace((event) => {
      if (event.type === 'mcpl:server-connect-failed') failures.push(String((event as { error?: unknown }).error));
    });
    breakLedger(fw);
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
      assert.match(failure, /Discord awareness accounting failed during .*Invalid Discord awareness ledger .*: it isn't JSON/);
    }
    assert.equal(registry.getServer('probe').isConnected, false, 'no child was spawned without the default');
    assert.equal(registry.getServer('probe').willReconnect, true, 'and it keeps retrying');
  });

  it('a modern server connects and restarts on a corrupt ledger, which it never reads', async () => {
    // A modern connection has no reaction default, so the ledger is no
    // reason to refuse it.
    const fw = await create();
    const modern = (id: string): McplServerConfig => ({
      id, command: process.execPath, args: [MODERN_FIXTURE, join(dir, `${id}-starts.log`), join(dir, `${id}-events.log`)], protocol: 'modern',
    });
    await fw.connectMcplServer(modern('modern'));
    breakLedger(fw);
    await fw.restartMcplServer('modern');
    await fw.connectMcplServer(modern('second'));
    assert.deepEqual(fw.listMcplServers().map((s) => [s.id, s.connected]).sort(), [['modern', true], ['second', true]]);
    // A legacy connect that derives the default still refuses on it.
    await assert.rejects(() => fw.connectMcplServer(server()), accountingRefusal);
  });

  it('passes a URL-only WebSocket config through unchanged', async () => {
    const fw = await create();
    // Bring up the MCPL subsystem as a first runtime connect does.
    await (fw as unknown as { initializeMcpl(servers: McplServerConfig[]): Promise<void> }).initializeMcpl([]);
    const registry = (fw as unknown as { mcplServerRegistry: { addServer(config: unknown): Promise<unknown> } }).mcplServerRegistry;
    registry.addServer = async () => { throw new Error('stop before connecting'); };
    const config: McplServerConfig = { id: 'remote', url: 'ws://127.0.0.1:1' };
    await assert.rejects(() => fw.connectMcplServer(config), /stop before connecting/);
    assert.deepEqual(config, { id: 'remote', url: 'ws://127.0.0.1:1' }, "the caller's config as it was: no env added");
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

  it('fails explicitly on an unreadable ledger rather than deriving an incomplete default', async () => {
    const fw = await create(undefined, [server()]);
    breakLedger(fw);
    assert.throws(() => baseline(fw), accountingRefusal);
    const internals = fw as unknown as {
      mcplServerRegistry: { getServer(id: string): unknown };
      mcplServerConfigs: Map<string, unknown>;
      mcplPrefixMap: Map<string, string>;
    };
    assert.equal(internals.mcplPrefixMap.get('mcpl--probe'), 'probe', 'a connected server has its tool routing');
    await fw.disconnectMcplServer('probe');
    // A connect that derives the default reads the ledger before it
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
