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

function server(overrides: Partial<McplServerConfig> = {}): McplServerConfig {
  return { id: 'probe', command: process.execPath, args: [FIXTURE], ...overrides };
}

function baseline(framework: AgentFramework): readonly string[] {
  // Keep this runtime API assertion compilable against the unfixed source.
  return (framework as unknown as { getPlacedReactionBaseline(): readonly string[] }).getPlacedReactionBaseline();
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
    // A corrupt-ledger test must not leave teardown trying to reconcile it.
    rmSync(outboxPath, { force: true });
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

  function retain(emoji: string) {
    const outbox = new DiscordAwarenessOutbox(outboxPath);
    return outbox.prepare({
      agentName: 'resident',
      sourceBranch: 'main',
      targetBranch: 'later-recovery',
      emoji,
      refs: [{ serverId: 'discord', channelId: 'discord:guild:channel', messageId: emoji }],
    })!;
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
    const completed = retain('👁️');
    const outbox = new DiscordAwarenessOutbox(outboxPath);
    outbox.activate(completed.id);
    outbox.recordSuccess(completed.id, completed.refs[0]!, 'add');
    const fw = await create('🔕');
    assert.deepEqual(new Set(baseline(fw)), new Set([...REFUSAL_REACTION_BASELINE, '💤', '🔕', '🫥', '👁️']));
    assert.equal(baseline(fw).length, new Set(baseline(fw)).size);
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

  for (const value of ['🟪', '']) {
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
    process.env[ENV_KEY] = '';
    t.after(() => {
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    });
    const fw = await create(undefined, [server()]);
    assert.equal((await childEnv(fw)).baseline, baseline(fw).join(','));
    await fw.disconnectMcplServer('probe');
    await fw.connectMcplServer(server({ inheritEnv: true, env: { [ENV_KEY]: '🟪' } }));
    assert.equal((await childEnv(fw)).baseline, '🟪');
  });

  it('fails explicitly on a corrupt retained ledger rather than deriving an incomplete default', async () => {
    const fw = await create(undefined, [server()]);
    writeFileSync(outboxPath, '{broken');
    assert.throws(() => baseline(fw), /Discord awareness.*ledger/i);
    await fw.disconnectMcplServer('probe');
    await assert.rejects(() => fw.connectMcplServer(server()), /Discord awareness.*ledger/i);
  });
});
