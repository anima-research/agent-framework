/**
 * Batched (debounced) wakes and outbound routing, end to end over a real MCPL
 * child: a DM push event (raw snowflake channel id, as discord-mcpl sends it)
 * and ambient channel traffic land in the same debounce window.
 *
 * Before: a batched wake carried no channel, so the turn froze on the
 * process-global most-recent-inbound channel. channels/incoming retargets
 * that; a DM push event never does. Either order misrouted the DM reply:
 *   - ambient AFTER the DM: the ambient channel became the fallback;
 *   - ambient BEFORE the DM: the DM never displaced it.
 * Now a batch containing an addressed message routes to that message's
 * registered channel; an ambient-only batch keeps the legacy fallback.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentFramework } from '../src/index.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const FIXTURE = join(import.meta.dirname, 'fixtures/wake-locus-mcpl-server.mjs');
const ROOM = 'discord:g1:room';
const GENERAL = 'discord:g1:general';
const RAW_DM = '1548000000000000001';
const DM = `discord:dm:${RAW_DM}`;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describe('batched wake routing', () => {
  let tempDir: string;
  let statusPath: string;
  let commandPath: string;
  let membrane: MockMembrane;
  let framework: AgentFramework;
  let n = 0;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'wake-locus-'));
    statusPath = join(tempDir, 'status.jsonl');
    commandPath = join(tempDir, 'commands.txt');
    writeFileSync(commandPath, '');
    membrane = new MockMembrane();
    framework = await AgentFramework.create({
      storePath: join(tempDir, 'test.chronicle'),
      membrane: membrane.asMembrane(),
      agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.' }],
      gate: {
        config: {
          policies: [{
            name: 'batch',
            match: { scope: ['mcpl:channel-incoming', 'mcpl:push-event'] },
            behavior: { debounce: 400 },
          }],
          default: 'skip',
        },
      },
      mcplServers: [{
        id: 'discord',
        command: process.execPath,
        args: [FIXTURE],
        env: { STATUS_PATH: statusPath, COMMAND_PATH: commandPath },
      }],
      modules: [],
    });
    await framework.start();
    const registry = (framework as unknown as { channelRegistry: { listChannelsRaw(): unknown[] } }).channelRegistry;
    await waitFor(() => registry.listChannelsRaw().length >= 2, 'channel registration');
  });

  afterEach(async () => {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const command = (line: string): void => appendFileSync(commandPath, line + '\n');
  const dm = (text: string): void => command(`dm ev-${++n} 134 ${RAW_DM} ${text}`);
  const incoming = (channelId: string, mode: 'ambient' | 'addressed', text: string): void =>
    command(`incoming ${channelId} m-${++n} ${mode} ${text}`);
  const sent = (event: string): number => !existsSync(statusPath) ? 0
    : readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .filter((l) => (JSON.parse(l) as { event: string }).event === event).length;
  const publishes = (): string[] => !existsSync(statusPath) ? []
    : readFileSync(statusPath, 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { event: string; channelId?: string })
      .filter((e) => e.event === 'publish')
      .map((e) => e.channelId!);

  it('a DM followed one beat later by ambient chatter elsewhere: the reply goes to the DM', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the DM' }]));
    dm('are you there?');
    await waitFor(() => sent('dm-sent') === 1, 'dm sent');
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [DM]);
  });

  it('ambient chatter followed by a DM in the same window: the reply goes to the DM', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the DM' }]));
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => sent('incoming-sent') === 1, 'ambient sent');
    dm('quick question');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [DM]);
  });

  it('a mention in one channel then ambient chatter in another: the reply goes to the mention', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'answering the mention' }]));
    incoming(ROOM, 'addressed', '@scout hello');
    await waitFor(() => sent('incoming-sent') === 1, 'mention sent');
    incoming(GENERAL, 'ambient', 'unrelated chatter');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [ROOM]);
  });

  it('an ambient-only batch keeps the legacy fallback (most recent inbound)', async () => {
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'joining in' }]));
    incoming(ROOM, 'ambient', 'first');
    await waitFor(() => sent('incoming-sent') === 1, 'first sent');
    incoming(GENERAL, 'ambient', 'second');
    await waitFor(() => publishes().length >= 1, 'reply published');
    assert.deepEqual(publishes(), [GENERAL]);
  });
});
