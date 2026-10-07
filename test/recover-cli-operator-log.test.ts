/**
 * `agent-framework-recover` records its acts in the store's operator log.
 *
 * The live surfaces record every operator mutation (who asked, from where,
 * what it did) in `<store>/operator-actions.jsonl`. The CLI acts on the same
 * store while the host is stopped: an offline recovery, which can choose to
 * publish awareness marks, and the awareness controls (cancel, retract,
 * release). Each is recorded the same way, done or refused, so the history
 * says who chose to publish or stop marks whichever surface they used. A dry
 * run and a list change nothing and record nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { DiscordAwarenessOutbox } from '../src/recovery/discord-awareness-outbox.js';
import type { OperatorLogEntry } from '../src/operator-log.js';

const CLI = fileURLToPath(new URL('../src/recovery/recover-cli.js', import.meta.url));

function recover(storePath: string, ...args: string[]) {
  const run = spawnSync(process.execPath, [CLI, '--store', storePath, ...args], { encoding: 'utf8' });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function operatorLog(storePath: string): OperatorLogEntry[] {
  const path = join(storePath, 'operator-actions.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as OperatorLogEntry);
}

const ref = (messageId: string) => ({ serverId: 'discord', channelId: 'discord:g1:c1', messageId });

test('the offline awareness controls record each act in the operator log, done or refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const outbox = new DiscordAwarenessOutbox(store);
    const batch = outbox.prepare({
      agentName: 'cairn', sourceBranch: 'main', targetBranch: 'rollback/cairn/1', refs: [ref('m1'), ref('m2')], scope: 'all',
    })!;
    outbox.activate(batch.id);
    store.close();

    const listed = recover(storePath, '--awareness', 'list');
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(operatorLog(storePath), [], 'a list changes nothing and records nothing');

    const cancelled = recover(storePath, '--awareness', 'cancel', batch.id);
    assert.equal(cancelled.status, 0, cancelled.stderr);
    const receipt = JSON.parse(cancelled.stdout) as Record<string, unknown>;
    assert.equal(receipt.cancelled, 2);

    const retracted = recover(storePath, '--awareness', 'retract', 'all');
    assert.equal(retracted.status, 0, retracted.stderr);

    const refused = recover(storePath, '--awareness', 'release', batch.id);
    assert.equal(refused.status, 1, 'releasing a batch that is not held is refused');

    const entries = operatorLog(storePath);
    assert.deepEqual(entries.map((entry) => entry.kind), ['awareness-cancel', 'awareness-retract', 'awareness-release']);
    for (const entry of entries) {
      assert.equal(entry.agent, '*');
      assert.equal(entry.requester?.via, 'cli');
      assert.ok(entry.at);
    }
    assert.deepEqual(entries[0].params, { target: batch.id });
    assert.deepEqual(entries[0].result, receipt);
    assert.deepEqual(entries[1].params, { target: 'all' });
    assert.equal(entries[1].result?.removalsQueued, 2);
    assert.deepEqual(entries[2].params, { batchId: batch.id });
    assert.equal(entries[2].result, undefined);
    assert.match(entries[2].error ?? '', /is active, not held/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an offline recovery records its marks choice and receipt in the operator log; a dry run records nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'recover-cli-log-'));
  const storePath = join(dir, 'store');
  try {
    const store = JsStore.openOrCreate({ path: storePath });
    const cm = await ContextManager.open({ store, namespace: 'agents/cairn' });
    cm.addMessage('user', [{ type: 'text', text: 'safe' }], { ...ref('m-safe') });
    cm.addMessage('user', [{ type: 'text', text: 'one' }], { ...ref('m-1'), tags: ['chat:addressed'] });
    cm.addMessage('user', [{ type: 'text', text: 'two' }], { ...ref('m-2'), tags: ['chat:ambient'] });
    cm.close();
    store.close();

    const dry = recover(storePath, '--agent', 'cairn', '--message-id', 'm-safe', '--marks', 'addressed', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(operatorLog(storePath), [], 'a dry run changes nothing and records nothing');

    const done = recover(storePath, '--agent', 'cairn', '--message-id', 'm-safe', '--marks', 'addressed', '--branch', 'recovery/cairn/1');
    assert.equal(done.status, 0, done.stderr);
    const output = JSON.parse(done.stdout) as { markers: Record<string, unknown> };

    const again = recover(storePath, '--agent', 'cairn', '--message-id', 'm-safe', '--branch', 'main');
    assert.equal(again.status, 1, 'a recovery onto an existing branch is refused');

    const [recorded, refused, ...rest] = operatorLog(storePath);
    assert.equal(rest.length, 0);
    assert.equal(recorded.kind, 'recovery');
    assert.equal(recorded.agent, 'cairn');
    assert.equal(recorded.requester?.via, 'cli');
    assert.deepEqual(recorded.params, { messageId: 'm-safe', marks: { scope: 'addressed' } });
    assert.deepEqual(recorded.result, {
      sourceBranch: 'main',
      targetBranch: 'recovery/cairn/1',
      messagesRemoved: 2,
      messagesSuppressed: 0,
      discordRefs: 2,
      markers: output.markers,
    });
    assert.equal((recorded.result?.markers as { status: string; queued: number }).status, 'queued');
    assert.equal((recorded.result?.markers as { status: string; queued: number }).queued, 1);

    assert.equal(refused.kind, 'recovery');
    assert.deepEqual(refused.params, { messageId: 'm-safe', marks: 'none' });
    assert.match(refused.error ?? '', /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
