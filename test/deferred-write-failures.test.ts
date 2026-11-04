/**
 * The queue of context writes deferred while quiesced, when its record can't
 * be written or the queue is over the cap: quiesce() writes the queue before
 * it changes the host's mode and, without abandon, refuses when the write
 * fails or the queue is over the cap; elsewhere a write that fails or meets
 * the cap keeps the queue in memory with one ops alert a run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NormalizedRequest, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { JsStore } from '@animalabs/chronicle';

import * as indexExports from '../src/index.js';
import { AgentFramework, ApiServer } from '../src/index.js';
import { setAbandonGraceForTests } from '../src/framework.js';
import { MockMembrane } from './helpers/mock-membrane.js';

/** A stream that ends only when cancelled: a turn that stays alive. */
class HangingStream implements YieldingStream {
  private pendingResolve: (() => void) | null = null;
  private aborted = false;
  cancel(): void { this.aborted = true; this.pendingResolve?.(); }
  provideToolResults(): void {}
  get isWaitingForTools() { return false; }
  get pendingToolCallIds(): string[] { return []; }
  get toolDepth() { return 0; }
  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (!this.aborted) await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    yield { type: 'aborted', reason: 'user' } as StreamEvent;
  }
}
class HangingMembrane extends MockMembrane {
  override streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new HangingStream();
  }
}

interface Alert { kind: string; agentName: string; message: string; data?: Record<string, unknown> }

/** A host on a recovery file or a store only, with what it alerts and logs. */
async function withHost(
  where: 'recovery file' | 'store only',
  fn: (h: {
    framework: AgentFramework;
    membrane: HangingMembrane;
    store: JsStore | undefined;
    queuePath: string;
    hostModePath: string;
    alerts: Alert[];
    errors: string[];
    add(text: string): void;
    liveTurn(): Promise<void>;
    queued(): unknown;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'deferred-write-failures-'));
  const storePath = join(dir, 'store');
  const store = where === 'store only' ? JsStore.openOrCreate({ path: storePath }) : undefined;
  const membrane = new HangingMembrane();
  const framework = await AgentFramework.create({
    ...(store ? { store } : { storePath }),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }],
    modules: [],
  });
  const alerts: Alert[] = [];
  (framework as unknown as { opsAlert: unknown }).opsAlert = (kind: string, agentName: string, message: string, opts?: { data?: Record<string, unknown> }) => {
    alerts.push({ kind, agentName, message, data: opts?.data });
  };
  const errors: string[] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const queuePath = join(storePath, 'recovery', 'deferred-writes.json');
  const textsOf = (pending: unknown): unknown => (Array.isArray(pending)
    ? pending.map((m: { content?: Array<{ text?: string }> }) => m.content?.[0]?.text)
    : pending);
  try {
    await fn({
      framework, membrane, store, queuePath, alerts, errors,
      hostModePath: join(storePath, 'recovery', 'host-mode.json'),
      add: (text) => {
        (framework as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text }]);
      },
      liveTurn: async () => {
        framework.start();
        framework.nudgeAgent('agent', 'operator');
        const deadline = Date.now() + 5_000;
        while (membrane.calls.length < 1) {
          if (Date.now() > deadline) throw new Error('the turn never started');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      },
      // The texts the record lists, or undefined when there's no record.
      queued: () => {
        if (store) {
          const raw = store.getStateJson('framework/deferred-writes') as { pending?: unknown } | unknown[] | null;
          return raw == null ? undefined : textsOf(Array.isArray(raw) ? raw : raw.pending);
        }
        return existsSync(queuePath) ? textsOf((JSON.parse(readFileSync(queuePath, 'utf8')) as { pending: unknown }).pending) : undefined;
      },
    });
  } finally {
    console.error = consoleError;
    rmSync(queuePath, { recursive: true, force: true });
    await framework.stop();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `body` while the store's sync fails when it follows a write of the deferred-write slot. */
async function withFailingSlotSync(body: () => Promise<void> | void): Promise<void> {
  const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
  const sync = proto.sync;
  proto.sync = function (this: JsStore) {
    if (new Error().stack?.includes('writeDeferredWritesSlot')) throw new Error('injected EIO syncing the store');
    return sync.call(this);
  };
  try {
    await body();
  } finally {
    proto.sync = sync;
  }
}

/** A text that alone puts the queue's JSON past the cap, 4 MiB counted as the string's length. */
const OVER_CAP = `big ${'x'.repeat(4 * 1024 * 1024)}`;

test('quiesce() writes a context write deferred behind a turn still alive, though its drain times out', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add('held for the turn');
    assert.equal(h.queued(), undefined, 'memory only while the host serves');
    const status = await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(status.drained, false, 'the turn is still alive');
    assert.deepEqual(h.queued(), ['held for the turn']);
  });
});

for (const where of ['recovery file', 'store only'] as const) {
  test(`${where}: a quiesce() whose write of the queue fails is refused with the host serving, naming its ways out, and the next quiesce() writes the queue`, async () => {
    await withHost(where, async (h) => {
      await h.liveTurn();
      h.add('held for the turn');
      const quiesce = () => h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
      const waysOut = ". So the queue as it stands, 1 deferred context write(s), isn't on disk. Once the record can " +
        'be written, quiesce again, or quiesce with abandon: true, which cancels the turns still streaming, to go on ' +
        'with the queue in memory, and resume before any restart.';
      if (where === 'recovery file') {
        mkdirSync(h.queuePath, { recursive: true });
        const refusal = await quiesce().then(() => undefined, (error: unknown) => error as Error & { cause?: NodeJS.ErrnoException });
        assert.equal(refusal?.name, 'QuiesceBlockedError');
        assert.equal(refusal?.cause?.code, 'EISDIR', 'the failed write is its cause');
        assert.ok(refusal?.message.startsWith(`quiesce refused: writing ${h.queuePath} failed: ${h.queuePath} was left as it was: `), refusal?.message);
        assert.ok(refusal?.message.endsWith(waysOut), refusal?.message);
        rmSync(h.queuePath, { recursive: true });
      } else {
        await withFailingSlotSync(() => assert.rejects(quiesce(), {
          name: 'QuiesceBlockedError',
          message: "quiesce refused: writing the store's framework/deferred-writes slot failed: injected EIO syncing the store" +
            waysOut,
        }));
      }
      const status = h.framework.getHostModeStatus();
      assert.equal(status.quiesced, false, 'the host is still serving');
      assert.equal(status.reason, undefined);
      assert.equal(status.since, undefined);
      assert.equal(status.deferredWrites, 1, 'the write is still queued');
      if (where === 'recovery file') {
        assert.equal(existsSync(h.hostModePath), false, 'no host-mode record was written');
      } else {
        assert.equal((h.store!.getStateJson('framework/state') as { hostMode?: unknown } | null)?.hostMode, undefined, 'no host-mode record was written');
      }
      assert.deepEqual(h.alerts, [], 'the caller hears it, so no alert');

      h.add('also held');
      if (where === 'recovery file') {
        assert.equal(h.queued(), undefined, 'the queue is still in memory only, as on a serving host before');
      } else {
        // The slot was set before its sync failed, so a later sync could put it on disk: the queue stays mirrored.
        assert.deepEqual(h.queued(), ['held for the turn', 'also held'], 'the next change rewrites the slot');
      }

      await quiesce();
      assert.equal(h.framework.getHostModeStatus().quiesced, true);
      assert.deepEqual(h.queued(), ['held for the turn', 'also held']);
    });
  });
}

test("a quiesce() whose record write fails after the queue's leaves the host serving with the queue written, and the next quiesce() quiesces", async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add('held for the turn');
    const proto = AgentFramework.prototype as unknown as { writeRecoveryFile(this: unknown, path: string, document: unknown): void };
    const write = proto.writeRecoveryFile;
    proto.writeRecoveryFile = function (this: unknown, path: string, document: unknown) {
      if (path.endsWith('host-mode.json')) throw Object.assign(new Error('injected EACCES writing host-mode.json'), { code: 'EACCES' });
      return write.call(this, path, document);
    };
    try {
      await assert.rejects(h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 }), { code: 'EACCES' });
    } finally {
      proto.writeRecoveryFile = write;
    }
    assert.equal(h.framework.getHostModeStatus().quiesced, false, 'the host is still serving');
    assert.equal(existsSync(h.hostModePath), false, 'no host-mode record was written');
    assert.deepEqual(h.queued(), ['held for the turn'], 'the queue was written first');
    h.add('also held');
    assert.deepEqual(h.queued(), ['held for the turn', 'also held'], 'and stays mirrored: the next change rewrites it');

    // A failed write on the serving host raises the alert with no advice to resume.
    rmSync(h.queuePath);
    mkdirSync(h.queuePath);
    h.add('third');
    assert.equal(h.alerts.length, 1);
    assert.ok(h.alerts[0]!.message.endsWith("3 deferred context write(s), isn't on disk"), h.alerts[0]!.message);
    rmSync(h.queuePath, { recursive: true });

    await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    assert.equal(h.framework.getHostModeStatus().quiesced, true);
  });
});

test('a quiesce() on a quiesced host writes the queue first: a plain one whose write fails is refused, one with abandon goes on past the failure and runs its abandon, and one whose write succeeds says the record has caught up', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
    mkdirSync(h.queuePath, { recursive: true });
    h.add('during surgery');
    assert.equal(h.alerts.length, 1, 'the deferral\'s failed write raised the alert');

    await assert.rejects(h.framework.quiesce(), (error: Error & { cause?: NodeJS.ErrnoException }) =>
      error.name === 'QuiesceBlockedError' && error.cause?.code === 'EISDIR');
    assert.equal(h.framework.getHostModeStatus().activeTurns, 1, 'the turn is still alive');

    const status = await h.framework.quiesce({ abandon: true, timeoutMs: 1_000 });
    assert.equal(status.quiesced, true);
    assert.equal(status.activeTurns, 0, 'the abandon ran');
    assert.equal(h.alerts.length, 1, 'within the run the deferral began, with no second alert');

    rmSync(h.queuePath, { recursive: true });
    // Nothing writes the queue now but quiesce()'s own write.
    await h.framework.quiesce();
    assert.deepEqual(h.queued(), ['during surgery']);
    assert.ok(
      h.errors.includes(`[host-mode] ${h.queuePath} written again: it holds the queue's 1 deferred context write(s)`),
      h.errors.join('\n'),
    );
    assert.equal(h.alerts.length, 1, 'a quiesce() raises no alert of its own');
  });
});

test('a first quiesce({ abandon: true }) whose write fails goes on with the queue in memory, its alert says to resume before any restart, and resume() lands the write', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add('held for the turn');
    mkdirSync(h.queuePath, { recursive: true });
    const status = await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000, abandon: true });
    assert.equal(status.quiesced, true);
    assert.equal(status.activeTurns, 0, 'the abandon ran');
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]!.data?.code, 'EISDIR');
    assert.ok(h.alerts[0]!.message.endsWith('. Resume before any restart'), h.alerts[0]!.message);
    assert.ok(h.errors.some((l) => l.startsWith('[host-mode] failed to persist deferred context writes; quiesce goes on ' +
      'with them in memory, so resume before any restart:')), h.errors.join('\n'));

    rmSync(h.queuePath, { recursive: true });
    await h.framework.resume();
    const texts = h.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .map((m) => (m.content[0] as { text?: string } | undefined)?.text);
    assert.ok(texts.includes('held for the turn'), 'the write landed');
    assert.deepEqual(h.queued(), [], 'the record is cleared');
  });
});

test('a queue over the cap is refused by a quiesce() without abandon, with the host as it was, naming the cap and the ways out', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add(OVER_CAP);
    await assert.rejects(h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 }), {
      name: 'QuiesceBlockedError',
      message: `quiesce refused: the queue's 1 deferred context write(s) come to more than 4194304 characters of JSON, ` +
        `the cap, so ${h.queuePath} can't hold them, and a restart would lose them. Quiesce again once they have landed, ` +
        'or quiesce with abandon: true to end the turns they wait for, then resume so they land, and quiesce again. ' +
        "The abandon's answer lists a turn it hasn't ended within its grace as unabandonable, and its writes land once it has ended and " +
        'the host is serving.',
    });
    assert.equal(h.framework.getHostModeStatus().quiesced, false, 'the host is still serving');
    assert.equal(h.framework.getHostModeStatus().activeTurns, 1, 'the turn is still alive');
    assert.equal(existsSync(h.hostModePath), false, 'no host-mode record was written');
    assert.equal(h.queued(), undefined, 'and no queue');
  });
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    h.add('small');
    h.add(OVER_CAP);
    await assert.rejects(h.framework.quiesce({ reason: 'surgery' }), {
      message: `quiesce refused: the queue's 2 deferred context write(s) come to more than 4194304 characters of JSON, ` +
        `the cap, so ${h.queuePath} can't hold them, and a restart would lose them. Resume so they land, then quiesce ` +
        'again. A write held for a turn still alive stays queued through a resume, so to end a turn that won\'t, ' +
        "quiesce with abandon: true before resuming. The abandon's answer lists a turn it hasn't ended within its grace as unabandonable, " +
        'and its writes land once it has ended and the host is serving.',
    });
    assert.equal(h.framework.getHostModeStatus().quiesced, true, 'still quiesced');
    assert.deepEqual(h.queued(), ['small'], 'the record keeps what it last held');
    const alerts = h.alerts.length;
    const repeat = await h.framework.quiesce({ reason: 'surgery', abandon: true });
    assert.equal(repeat.quiesced, true, 'a repeat with abandon goes past the cap');
    assert.equal(h.alerts.length, alerts, 'within the run the deferral began, with no second alert');
  });
});

test('a refusal over the cap answers host/command with ok: false and the HTTP route with a 409, each with the host mode, as resume()\'s refusal does, and each passes abandon on', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add(OVER_CAP);
    type Params = { command: string; timeoutMs?: number; abandon?: boolean };
    const hostCommand = (params: Params) => (h.framework as unknown as {
      handleHostCommand(serverId: string, params: Params): Promise<{
        ok: boolean; error?: string; hostMode?: { quiesced: boolean };
      }>;
    }).handleHostCommand('test-server', params);
    const answer = await hostCommand({ command: 'quiesce', timeoutMs: 1_000 });
    assert.equal(answer.ok, false);
    assert.match(answer.error ?? '', /^quiesce refused: /);
    assert.equal(answer.hostMode?.quiesced, false);

    const server = new ApiServer(h.framework, { port: 0, host: '127.0.0.1' });
    await server.start();
    try {
      const port = (server as unknown as { httpServer: { address(): { port: number } } }).httpServer.address().port;
      const post = (query: string) => fetch(`http://127.0.0.1:${port}/quiesce?${query}`, { method: 'POST', headers: { 'x-admin-token': 'any' } });
      const response = await post('timeoutMs=1000');
      assert.equal(response.status, 409);
      const body = await response.json() as { error: string; hostMode: { quiesced: boolean } };
      assert.match(body.error, /^quiesce refused: /);
      assert.equal(body.hostMode.quiesced, false);

      // The way out the refusal names, through each ingress: host/command on the serving host, then the HTTP
      // route on the quiesced one, where a plain repeat is refused too.
      const abandoned = await hostCommand({ command: 'quiesce', timeoutMs: 1_000, abandon: true });
      assert.equal(abandoned.ok, true, abandoned.error);
      assert.equal(abandoned.hostMode?.quiesced, true);
      const plain = await post('timeoutMs=1000');
      assert.equal(plain.status, 409);
      await plain.text();
      const repeat = await post('timeoutMs=1000&abandon=true');
      assert.equal(repeat.status, 200);
      assert.equal((await repeat.json() as { quiesced: boolean }).quiesced, true);
    } finally {
      await server.stop();
    }
    // Exported, as ResumeBlockedError is (read by name so this file builds against main's exports too).
    const Blocked = (indexExports as unknown as Record<string, unknown>).QuiesceBlockedError as (new (...args: never[]) => Error) | undefined;
    assert.equal(typeof Blocked, 'function', 'QuiesceBlockedError is exported');
    await assert.rejects(h.framework.quiesce({ timeoutMs: 1_000 }), (error) => error instanceof Blocked!);
  });
});

test('a queue over the cap held for a turn whose stream never ends: a plain quiesce() refuses, quiesce({ abandon: true }) goes on with the alert, and after resume() the writes land', async () => {
  await withHost('recovery file', async (h) => {
    await h.liveTurn();
    h.add(OVER_CAP);
    await assert.rejects(h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 }),
      { name: 'QuiesceBlockedError', message: /^quiesce refused: / });
    assert.equal(h.framework.getHostModeStatus().quiesced, false);
    assert.equal(h.alerts.length, 0, 'a refusal raises no alert');

    const status = await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000, abandon: true });
    assert.equal(status.quiesced, true);
    assert.equal(status.activeTurns, 0, 'the abandon ended the turn');
    assert.equal(h.alerts.length, 1);
    assert.deepEqual(h.alerts[0]!.data, { record: h.queuePath, queued: 1, capCharacters: 4 * 1024 * 1024 });
    assert.ok(h.alerts[0]!.message.endsWith('. Resume before any restart'), h.alerts[0]!.message);
    assert.equal(h.queued(), undefined, 'nothing of the queue over the cap is written');

    await h.framework.resume();
    const texts = h.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .map((m) => (m.content[0] as { text?: string } | undefined)?.text);
    assert.ok(texts.includes(OVER_CAP), 'the write landed');
    assert.equal(h.framework.getHostModeStatus().deferredWrites, 0);
    assert.deepEqual(h.queued(), [], 'the record is cleared');
    assert.ok(h.errors.some((l) => l.startsWith(`[host-mode] ${h.queuePath} written again:`)), h.errors.join('\n'));
  });
});

test('a turn the abandon can\'t cancel, a token with no stream, is listed as unabandonable with its write still queued, and a resume after it ends lands the write', async () => {
  await withHost('recovery file', async (h) => {
    // A turn between dequeue and stream registration: its token is held, and there's no stream to cancel.
    const tokens = (h.framework as unknown as { activeTurnTokens: Map<string, object> }).activeTurnTokens;
    tokens.set('agent', {});
    // The token is held until the quiesce has returned, so no turn can end
    // within the abandon's grace, and a short one only brings its report sooner.
    setAbandonGraceForTests(h.framework, 50);
    try {
      h.add(OVER_CAP);
      const status = await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000, abandon: true });
      assert.equal(status.quiesced, true);
      assert.deepEqual(status.unabandonable, ['agent']);
      assert.equal(status.deferredWrites, 1, 'its write is still queued');
      assert.equal(h.alerts.length, 1, 'the cap\'s alert');
    } finally {
      tokens.delete('agent'); // the turn ends
    }
    await h.framework.resume();
    const texts = h.framework.getAgent('agent')!.getContextManager().getAllMessages()
      .map((m) => (m.content[0] as { text?: string } | undefined)?.text);
    assert.ok(texts.includes(OVER_CAP), 'the write landed');
    assert.equal(h.framework.getHostModeStatus().deferredWrites, 0);
  });
});

for (const where of ['recovery file', 'store only'] as const) {
  test(`${where}: writes resume() landed over the cap, whose store sync failed, are acked by the next quiesce() once the store syncs, rather than refused`, async () => {
    await withHost(where, async (h) => {
      await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
      h.add(OVER_CAP);
      assert.equal(h.alerts.length, 1, "the cap's alert");

      // resume() lands the write, and its ack's sync fails.
      const proto = JsStore.prototype as unknown as { sync(this: JsStore): void };
      const sync = proto.sync;
      proto.sync = function (this: JsStore) {
        if (new Error().stack?.includes('ackDeferredWrites')) throw new Error('injected EIO syncing the store');
        return sync.call(this);
      };
      try {
        await h.framework.resume();
      } finally {
        proto.sync = sync;
      }
      assert.equal(h.framework.getHostModeStatus().quiesced, false);
      const texts = h.framework.getAgent('agent')!.getContextManager().getAllMessages()
        .map((m) => (m.content[0] as { text?: string } | undefined)?.text);
      assert.ok(texts.includes(OVER_CAP), 'the write landed');
      assert.ok(h.errors.some((l) => l.startsWith('[host-mode] chronicle sync failed — 1 flushed deferred write(s) stay ' +
        'in the recovery queue until a sync succeeds:')), h.errors.join('\n'));

      const status = await h.framework.quiesce({ reason: 'surgery', timeoutMs: 1_000 });
      assert.equal(status.quiesced, true);
      assert.deepEqual(h.queued(), [], 'the record holds none of it');
      assert.equal(h.alerts.length, 1, 'no alert since');
    });
  });
}

test('a deferral whose write fails while quiesced keeps the write in memory, raises one ops alert a run, and logs a line once a write succeeds', async () => {
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    mkdirSync(h.queuePath, { recursive: true });
    h.add('one');
    h.add('two');
    assert.equal(h.framework.getHostModeStatus().deferredWrites, 2, 'both are held');
    assert.equal(h.errors.filter((l) => l.startsWith('[host-mode] failed to persist deferred context writes:')).length, 2, 'each failure has its line');
    assert.equal(h.alerts.length, 1, 'one alert for the run');
    const [alert] = h.alerts;
    assert.equal(alert!.kind, 'deferred-writes');
    assert.equal(alert!.agentName, 'framework');
    assert.match(alert!.message, new RegExp(
      `^writing ${h.queuePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed: .*EISDIR.*\\. The queue's next change writes ` +
      `it again, and until a write of it succeeds, the queue as it stands, 1 deferred context write\\(s\\), isn't ` +
      `on disk\\. Resume before any restart$`,
    ));
    assert.deepEqual(alert!.data, { record: h.queuePath, queued: 1, code: 'EISDIR' });

    rmSync(h.queuePath, { recursive: true });
    h.add('three');
    assert.deepEqual(h.queued(), ['one', 'two', 'three'], 'the next write carries the writes held in memory');
    assert.ok(
      h.errors.includes(`[host-mode] ${h.queuePath} written again: it holds the queue's 3 deferred context write(s)`),
      h.errors.join('\n'),
    );

    rmSync(h.queuePath);
    mkdirSync(h.queuePath);
    h.add('four');
    assert.equal(h.alerts.length, 2, 'a new run raises a new alert');
  });
});

test('over the cap while quiesced, the record keeps what it last held, with one ops alert and line a run', async () => {
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    h.add('small');
    h.add(OVER_CAP);
    h.add('after');
    assert.deepEqual(h.queued(), ['small'], 'nothing of the queue over the cap is written');
    assert.equal(h.framework.getHostModeStatus().deferredWrites, 3);
    const message = `the queue's 2 deferred context write(s) come to more than 4194304 characters of JSON, the cap, ` +
      `so ${h.queuePath} isn't written, and a restart before the queue is under the cap and written restores what it ` +
      'last held. Resume before any restart';
    assert.deepEqual(h.alerts, [{
      kind: 'deferred-writes',
      agentName: 'framework',
      message,
      data: { record: h.queuePath, queued: 2, capCharacters: 4 * 1024 * 1024 },
    }]);
    assert.deepEqual(h.errors.filter((l) => l.includes('the cap')), [`[host-mode] ${message}`], 'its line, once');

    // resume() lands the queue and clears the record, which ends the run; the cap met again begins a new one.
    await h.framework.resume();
    await h.framework.quiesce({ reason: 'surgery' });
    h.add(OVER_CAP);
    assert.equal(h.alerts.length, 2, 'a new run raises a new alert');
    assert.equal(h.errors.filter((l) => l.includes('the cap')).length, 2, 'and logs the cap\'s line again');
  });
});

test('a run begun by a failed write logs the cap\'s line when the queue then goes over the cap, with no second alert', async () => {
  await withHost('recovery file', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    mkdirSync(h.queuePath, { recursive: true });
    h.add('small');
    rmSync(h.queuePath, { recursive: true });
    h.add(OVER_CAP);
    assert.equal(h.alerts.length, 1, 'the failed write began the run');
    assert.deepEqual(
      h.errors.filter((l) => l.includes('the cap')),
      [`[host-mode] the queue's 2 deferred context write(s) come to more than 4194304 characters of JSON, the cap, ` +
        `so ${h.queuePath} isn't written, and a restart before the queue is under the cap and written restores what it ` +
        'last held. Resume before any restart'],
    );
    assert.equal(h.queued(), undefined, 'nothing was written');
  });
});

for (const cause of ['a failed write', 'the cap'] as const) {
  test(`when the queue's first write while quiesced is lost to ${cause}, the queue stays mirrored, and resume's writes bring the record up to date`, async () => {
    await withHost('recovery file', async (h) => {
      await h.framework.quiesce({ reason: 'surgery' });
      if (cause === 'a failed write') {
        mkdirSync(h.queuePath, { recursive: true });
        h.add('held');
        rmSync(h.queuePath, { recursive: true });
      } else {
        h.add(OVER_CAP);
      }
      assert.equal(h.alerts.length, 1);
      assert.equal(h.queued(), undefined, 'no record yet');
      await h.framework.resume();
      assert.deepEqual(h.queued(), [], 'the record is cleared once the queue lands');
      assert.ok(h.errors.some((l) => l.startsWith(`[host-mode] ${h.queuePath} written again:`)), h.errors.join('\n'));
    });
  });
}

test('store only, a deferral while quiesced syncs the store after the slot\'s write, and a sync that fails is a failed write', async () => {
  await withHost('store only', async (h) => {
    await h.framework.quiesce({ reason: 'surgery' });
    const proto = JsStore.prototype as unknown as {
      sync(this: JsStore): void;
      setStateJson(this: JsStore, id: string, value: unknown): void;
    };
    const { sync, setStateJson } = proto;
    const calls: string[] = [];
    proto.sync = function (this: JsStore) { calls.push('sync'); return sync.call(this); };
    proto.setStateJson = function (this: JsStore, id: string, value: unknown) { calls.push(`set ${id}`); return setStateJson.call(this, id, value); };
    try {
      h.add('one');
    } finally {
      proto.sync = sync;
      proto.setStateJson = setStateJson;
    }
    assert.deepEqual(calls, ['set framework/deferred-writes', 'sync'], 'the slot is set, then the store synced');
    assert.deepEqual(h.queued(), ['one']);

    await withFailingSlotSync(() => h.add('two'));
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0]!.message,
      "writing the store's framework/deferred-writes slot failed: injected EIO syncing the store. The queue's next " +
      "change writes it again, and until a write of it succeeds, the queue as it stands, 2 deferred context " +
      "write(s), isn't on disk. Resume before any restart");
    assert.deepEqual(h.alerts[0]!.data, { record: "the store's framework/deferred-writes slot", queued: 2 });
  });
});
