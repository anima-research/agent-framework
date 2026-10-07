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
import { AgentFramework } from '../src/index.js';
import { MockMembrane } from './helpers/mock-membrane.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/reregistering-mcpl-server.mjs', import.meta.url));

interface ServerEvent {
  event: string;
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
});
