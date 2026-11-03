/**
 * At boot, a stored state that can't be read, or that reads as something this
 * code doesn't read as that state, is a refusal that names it, not an empty
 * state. Taken as empty, each was lost or ignored: a quiesced host booted
 * serving and landed its deferred writes mid-surgery; a deferred-write queue
 * restored nothing and the next deferral replaced it; a deferred write that
 * had landed before its ack landed again when an agent's context couldn't be
 * scanned; usage totals started at zero and the next inference stored zeros
 * over them; an agent's settings booted at its recipe's and the next change
 * stored over the record; coalesced work acknowledged before a crash was never
 * delivered, and the next receipt or flush replaced what was stored. Each
 * refusal leaves the state as it was, so the next boot that can read it
 * restores it. The inline caps' failed read loses nothing, since setting a cap
 * reads them again, so it is logged and boot goes on. Nothing stored still
 * reads as empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '@animalabs/context-manager';
import { AgentFramework } from '../src/index.js';
import type { FrameworkConfig } from '../src/types/framework.js';
import type { McplServerConfig } from '../src/mcpl/types.js';
import { MockMembrane } from './helpers/mock-membrane.js';
import { fixture, crash } from './helpers/coalescing-fixture.js';
import { rejectsBuild } from './helpers/failed-create.js';
import { isStateExistsError } from '../src/module-registry.js';
import { CheckpointManager } from '../src/mcpl/checkpoint-manager.js';

/** An I/O error from a store read of `stateId` by the framework's `reader`,
 *  `times` times, as a failing disk would give. */
function failStoreRead(stateId: string, reader: string, times = 1): () => void {
  const proto = JsStore.prototype as unknown as { getStateJson(this: JsStore, id: string): unknown };
  const original = proto.getStateJson;
  let left = times;
  proto.getStateJson = function (this: JsStore, id: string) {
    if (id === stateId && left > 0 && new Error().stack?.includes(reader)) {
      left--;
      throw Object.assign(new Error(`injected EIO reading ${id}`), { code: 'EIO' });
    }
    return original.call(this, id);
  };
  return () => { proto.getStateJson = original; };
}

/** An I/O error from the next read of the recovery file whose path ends in `name`. */
function failRecoveryRead(name: string): () => void {
  const proto = AgentFramework.prototype as unknown as { readRecoveryFile(path: string): unknown };
  const original = proto.readRecoveryFile;
  let left = 1;
  proto.readRecoveryFile = function (this: unknown, path: string) {
    if (path.endsWith(name) && left > 0) {
      left--;
      throw Object.assign(new Error(`injected EIO reading ${name}`), { code: 'EIO' });
    }
    return original.call(this, path);
  };
  return () => { proto.readRecoveryFile = original; };
}

function quietErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.error = original; } };
}

const agents = [{ name: 'agent', model: 'test-model', systemPrompt: 'test' }];
const config = (storePath: string): FrameworkConfig =>
  ({ storePath, membrane: new MockMembrane().asMembrane(), agents, modules: [] }) as unknown as FrameworkConfig;
const texts = (f: AgentFramework): string[] =>
  f.getAgent('agent')!.getContextManager().getAllMessages().map((m) => (m.content[0] as { text?: string } | undefined)?.text ?? '');

/** A store directory removed after `body`, which receives its storePath. */
function inStoreDir(prefix: string, body: (storePath: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    try { await body(join(dir, 'store')); } finally { rmSync(dir, { recursive: true, force: true }); }
  };
}

/** Write `framework/state` while no framework holds the store. */
function seedFrameworkState(storePath: string, state: Record<string, unknown>): void {
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    try {
      store.registerState({ id: 'framework/state', strategy: 'snapshot' });
    } catch (error) {
      if (!isStateExistsError(error)) throw error;
    }
    store.setStateJson('framework/state', state);
  } finally { store.close(); }
}
function readState(storePath: string, stateId: string): unknown {
  const store = JsStore.openOrCreate({ path: storePath });
  try { return store.getStateJson(stateId); } finally { store.close(); }
}

/** Quiesce with one write deferred, and stop. */
async function quiescedWithAWrite(storePath: string, text = 'said during surgery'): Promise<void> {
  const f = await AgentFramework.create(config(storePath));
  try {
    await f.quiesce({ reason: 'surgery' });
    (f as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text }]);
  } finally { await f.stop(); }
}

// ---------------------------------------------------------------------------
// Host mode
// ---------------------------------------------------------------------------

test("a host-mode file that can't be read fails create(), and the next boot is quiesced with its writes", inStoreDir('boot-read-hostmode-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'host-mode.json');
  const before = readFileSync(file, 'utf8');
  const restore = failRecoveryRead('host-mode.json');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the host mode \\(${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\) could not be read: injected EIO reading host-mode\\.json\\. ` +
      `The framework doesn't start without it, since a host quiesced for maintenance would boot serving\\. ` +
      `The file is unchanged, and the framework starts once it can be read\\.$`,
    ));
  } finally { restore(); }
  assert.equal(readFileSync(file, 'utf8'), before, 'the file is as it was');
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().quiesced, true);
    assert.equal(f.getHostModeStatus().deferredWrites, 1);
    assert.ok(!texts(f).includes('said during surgery'), 'the deferred write waits for resume');
  } finally { await f.stop(); }
}));

test('a host-mode file that holds no record, text that isn\'t JSON, or a record whose quiesced is not a boolean, fails create(), naming what it holds', inStoreDir('boot-read-hostmode-form-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'host-mode.json');
  const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  for (const [content, holds] of [
    ['["quiesced"]', literal('holds an array, not a host-mode record')],
    ['null', literal('holds null, not a host-mode record')],
    ['{"version":1,"quiesced":"yes"}', literal('is a record whose quiesced is a string, not true or false')],
    ['{"version":1}', literal('is a record whose quiesced is missing, not true or false')],
    // The parser's own words differ between Node versions.
    ['{"version":1,"quiesced":tr', "holds text that isn't JSON: .+"],
  ]) {
    writeFileSync(file, content);
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the host mode \\(.*host-mode\\.json\\) ${holds}\\. The framework doesn't start without it, ` +
      `since a host quiesced for maintenance would boot serving\\. The file is unchanged, and the framework starts once it holds a ` +
      `host-mode record, such as \\{"version":1,"quiesced":true\\} to boot quiesced or \\{"version":1,"quiesced":false\\} to serve\\. ` +
      `Removing it doesn't help: without the file, host mode is read from framework/state, which a quiesce doesn't write, so a ` +
      `quiesced host would boot serving\\.$`,
    ), content);
    assert.equal(readFileSync(file, 'utf8'), content, `${content}: the file is as it was`);
  }
}));

test("a recovery file that can't be reached, not only one that won't read, fails create(), and doesn't read as absent", inStoreDir('boot-read-hostmode-enotdir-', async (storePath) => {
  // A file where the host-mode file's directory should be makes its read fail
  // with ENOTDIR, an error existsSync answers false for, as it does EACCES.
  const dir = join(storePath, '..', 'host-mode-dir');
  const withPath = (): FrameworkConfig => ({ ...config(storePath), hostModePath: join(dir, 'host-mode.json') }) as FrameworkConfig;
  const first = await AgentFramework.create(withPath());
  try { await first.quiesce({ reason: 'surgery' }); } finally { await first.stop(); }
  renameSync(dir, `${dir}.aside`);
  writeFileSync(dir, 'not a directory');
  try {
    await rejectsBuild(() => AgentFramework.create(withPath()), /^the host mode \(.*host-mode-dir\/host-mode\.json\) could not be read: ENOTDIR\b.*The file is unchanged, and the framework starts once it can be read\.$/);
  } finally {
    rmSync(dir);
    renameSync(`${dir}.aside`, dir);
  }
  const f = await AgentFramework.create(withPath());
  try { assert.equal(f.getHostModeStatus().quiesced, true); } finally { await f.stop(); }
}));

test("a deferred-writes file that can't be reached fails create(), and doesn't read as absent", inStoreDir('boot-read-deferred-enotdir-', async (storePath) => {
  // As for the host-mode file: ENOTDIR from a file where the queue file's directory should be.
  const dir = join(storePath, '..', 'deferred-dir');
  const withPath = (): FrameworkConfig => ({ ...config(storePath), deferredWritesPath: join(dir, 'deferred-writes.json') }) as FrameworkConfig;
  const first = await AgentFramework.create(withPath());
  try {
    await first.quiesce({ reason: 'surgery' });
    (first as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text: 'said during surgery' }]);
  } finally { await first.stop(); }
  renameSync(dir, `${dir}.aside`);
  writeFileSync(dir, 'not a directory');
  try {
    await rejectsBuild(() => AgentFramework.create(withPath()), /^the deferred context writes \(.*deferred-dir\/deferred-writes\.json\) could not be read: ENOTDIR\b.*The file is unchanged, and the framework starts once it can be read\.$/);
  } finally {
    rmSync(dir);
    renameSync(`${dir}.aside`, dir);
  }
  const f = await AgentFramework.create(withPath());
  try { assert.equal(f.getHostModeStatus().deferredWrites, 1, 'the next reachable boot restores the queue'); } finally { await f.stop(); }
}));

test("with no recovery file, a host mode that can't be read from framework/state fails create()", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boot-read-hostmode-slot-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  // A store passed in, with no recovery paths, keeps host mode in framework/state.
  const slotConfig = () => ({ store, membrane: new MockMembrane().asMembrane(), agents, modules: [] }) as unknown as FrameworkConfig;
  try {
    const first = await AgentFramework.create(slotConfig());
    await first.quiesce({ reason: 'surgery' });
    await first.stop();
    const restore = failStoreRead('framework/state', 'readHostMode');
    try {
      await rejectsBuild(() => AgentFramework.create(slotConfig()), /^the host mode \(framework\/state, hostMode\) could not be read: injected EIO reading framework\/state\. The framework doesn't start without it, since a host quiesced for maintenance would boot serving\. It's unchanged, and the framework starts once it can be read\.$/);
    } finally { restore(); }
    const f = await AgentFramework.create(slotConfig());
    try { assert.equal(f.getHostModeStatus().quiesced, true); } finally { await f.stop(); }
    for (const [hostMode, holds] of [['quiesced', 'holds a string'], [null, 'holds null']] as const) {
      store.setStateJson('framework/state', { ...(store.getStateJson('framework/state') as object), hostMode });
      await rejectsBuild(() => AgentFramework.create(slotConfig()), new RegExp(
        `^the host mode \\(framework/state, hostMode\\) ${holds}, not a host-mode record\\. The framework doesn't start without it, ` +
        `since a host quiesced for maintenance would boot serving\\. It's unchanged, and starting again won't help until it's repaired\\.$`,
      ), String(hostMode));
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Deferred writes
// ---------------------------------------------------------------------------

test("a deferred-write queue that can't be read fails create(), and the next boot lands its writes at resume", inStoreDir('boot-read-deferred-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'deferred-writes.json');
  const before = readFileSync(file, 'utf8');
  const restore = failRecoveryRead('deferred-writes.json');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the deferred context writes \(.*deferred-writes\.json\) could not be read: injected EIO reading deferred-writes\.json\. The framework doesn't start without them, since the next deferral would replace the stored queue\. The file is unchanged, and the framework starts once it can be read\.$/);
  } finally { restore(); }
  assert.equal(readFileSync(file, 'utf8'), before, 'the queue is as it was');
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().deferredWrites, 1);
    await f.resume();
    assert.deepEqual(texts(f).filter((t) => t === 'said during surgery').length, 1);
  } finally { await f.stop(); }
}));

test("a deferred-write queue that isn't a queue, or isn't JSON, fails create(), naming what it holds", inStoreDir('boot-read-deferred-form-', async (storePath) => {
  await quiescedWithAWrite(storePath);
  const file = join(storePath, 'recovery', 'deferred-writes.json');
  for (const [content, holds] of [
    ['"pending"', 'hold a string, not a queue of writes'],
    ['null', 'hold null, not a queue of writes'],
    ['{"version":2,"pending":{"0":{}}}', 'hold an object whose pending is an object, not a list of writes'],
    ['{"version":2}', 'hold an object whose pending is missing, not a list of writes'],
    // The parser's own words differ between Node versions.
    ['{"version":2,', "hold text that isn't JSON: .+"],
  ] as const) {
    writeFileSync(file, content);
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the deferred context writes \\(.*deferred-writes\\.json\\) ${holds}\\. The framework doesn't start without them, since the next ` +
      `deferral would replace the stored queue\\. The file is unchanged, and the framework starts once it holds a queue of writes, ` +
      `such as \\{"version":1,"pending":\\[\\]\\} for none\\. Removing it reads the queue from framework/deferred-writes instead, ` +
      `which the file's writes don't keep, so it restores whatever older queue is there, or none\\.$`,
    ), content);
    assert.equal(readFileSync(file, 'utf8'), content, `${content}: the file is as it was`);
  }
}));

test("with no recovery file, a deferred-write queue that can't be read, or isn't a queue, fails create()", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boot-read-deferred-slot-'));
  const store = JsStore.openOrCreate({ path: join(dir, 'store') });
  // A store passed in, with no recovery paths, keeps the queue in framework/deferred-writes.
  const slotConfig = () => ({ store, membrane: new MockMembrane().asMembrane(), agents, modules: [] }) as unknown as FrameworkConfig;
  try {
    const first = await AgentFramework.create(slotConfig());
    await first.quiesce({ reason: 'surgery' });
    (first as unknown as { addMessage(p: string, c: unknown[]): unknown }).addMessage('user', [{ type: 'text', text: 'said during surgery' }]);
    await first.stop();
    const queue = store.getStateJson('framework/deferred-writes');
    const restore = failStoreRead('framework/deferred-writes', 'restorePersistedDeferredWrites');
    try {
      await rejectsBuild(() => AgentFramework.create(slotConfig()), /^the deferred context writes \(framework\/deferred-writes\) could not be read: injected EIO reading framework\/deferred-writes\. The framework doesn't start without them, since the next deferral would replace the stored queue\. They're unchanged, and the framework starts once they can be read\.$/);
    } finally { restore(); }
    assert.deepEqual(store.getStateJson('framework/deferred-writes'), queue, 'the queue is as it was');
    const f = await AgentFramework.create(slotConfig());
    try { assert.equal(f.getHostModeStatus().deferredWrites, 1); } finally { await f.stop(); }
    store.setStateJson('framework/deferred-writes', 'pending');
    await rejectsBuild(() => AgentFramework.create(slotConfig()), /^the deferred context writes \(framework\/deferred-writes\) hold a string, not a queue of writes\. The framework doesn't start without them, since the next deferral would replace the stored queue\. They're unchanged, and starting again won't help until they're repaired\.$/);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a deferred write whose agent's context can't be scanned fails create(), and the next boot doesn't land it twice", inStoreDir('boot-read-deferred-landed-', async (storePath) => {
  // A write that landed before its ack: in the queue, and in the context with its id.
  await quiescedWithAWrite(storePath);
  const [queued] = JSON.parse(readFileSync(join(storePath, 'recovery', 'deferred-writes.json'), 'utf8')).pending as Array<{ id: string }>;
  const staging = await AgentFramework.create(config(storePath));
  try {
    staging.getAgent('agent')!.getContextManager()
      .addMessage('user', [{ type: 'text', text: 'said during surgery' }], { deferredWriteId: queued!.id } as never);
  } finally { await staging.stop(); }
  // A crash between a write landing and its ack leaves the receipt its
  // hand-off recorded, from before the copy landed. Staging's stop handed the
  // queue off again from after the copy, so the receipt goes back to where
  // the agent's context began.
  const queueFile = join(storePath, 'recovery', 'deferred-writes.json');
  writeFileSync(queueFile, JSON.stringify({ ...JSON.parse(readFileSync(queueFile, 'utf8')), scanFrom: { agent: 0 } }));
  const proto = ContextManager.prototype as unknown as { getMessageCount(this: ContextManager): number };
  const original = proto.getMessageCount;
  proto.getMessageCount = function (this: ContextManager) {
    if (new Error().stack?.includes('landedDeferredWriteIds')) throw new Error('injected EIO scanning the context');
    return original.call(this);
  };
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the deferred context writes \(.*deferred-writes\.json\) can't be checked for writes that already landed: agent's context could not be read: injected EIO scanning the context\. The framework doesn't start without that check, since a write that landed before its ack would land a second time\. The queue is unchanged, and the framework starts once that context can be read\.$/);
  } finally { proto.getMessageCount = original; }
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().deferredWrites, 0, 'the landed write is skipped');
    await f.resume();
    assert.equal(texts(f).filter((t) => t === 'said during surgery').length, 1, 'it is in the context once');
  } finally { await f.stop(); }
}));

// ---------------------------------------------------------------------------
// Usage totals
// ---------------------------------------------------------------------------

const storedUsage = {
  totals: { inputTokens: 1000, outputTokens: 500 },
  inferenceCount: 7,
  byAgent: [{ agentName: 'agent', usage: { inputTokens: 1000, outputTokens: 500 }, inferenceCount: 7 }],
};

test("usage totals that can't be read fail create(), and the next boot restores them", inStoreDir('boot-read-usage-', async (storePath) => {
  seedFrameworkState(storePath, { usage: storedUsage });
  const restore = failStoreRead('framework/state', 'restoreUsageState');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the usage totals \(framework\/state, usage\) could not be read: injected EIO reading framework\/state\. The framework doesn't start without them, since the next inference would store fresh totals over them\. They're unchanged, and the framework starts once they can be read\.$/);
  } finally { restore(); }
  assert.deepEqual((readState(storePath, 'framework/state') as { usage: unknown }).usage, storedUsage);
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getSessionUsage().totals.inputTokens, 1000);
    assert.equal(f.getSessionUsage().totals.outputTokens, 500);
  } finally { await f.stop(); }
}));

test("usage totals that aren't a usage record fail create(), naming what they are", inStoreDir('boot-read-usage-form-', async (storePath) => {
  for (const [usage, are] of [
    [{ totals: 'lots' }, "are a record whose totals aren't token counts"],
    [[storedUsage], 'are an array, not a usage record'],
    [null, 'are null, not a usage record'],
    [{ ...storedUsage, byAgent: 'agent' }, "are a record whose byAgent isn't a list"],
  ] as const) {
    seedFrameworkState(storePath, { usage });
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the usage totals \\(framework/state, usage\\) ${are}\\. The framework doesn't start without them, since the next inference ` +
      `would store fresh totals over them\\. They're unchanged, and starting again won't help until they're repaired\\.$`,
    ), JSON.stringify(usage));
    assert.deepEqual((readState(storePath, 'framework/state') as { usage: unknown }).usage, usage);
  }
}));

test('usage totals an earlier release wrote with a null count, or with a byAgent entry that is not an agent, restore', inStoreDir('boot-read-usage-null-', async (storePath) => {
  // A NaN total, which a provider's usage without a count made, is stored as null.
  seedFrameworkState(storePath, { usage: {
    totals: { inputTokens: null, outputTokens: 500 },
    inferenceCount: 7,
    byAgent: [null, { agentName: 'agent', usage: { inputTokens: 1000, outputTokens: null }, inferenceCount: 7 }],
  } });
  const f = await AgentFramework.create(config(storePath));
  try {
    const usage = f.getSessionUsage();
    assert.equal(usage.totals.inputTokens, 0);
    assert.equal(usage.totals.outputTokens, 500);
    assert.deepEqual(usage.byAgent.map((a) => [a.agentName, a.usage.inputTokens, a.usage.outputTokens]), [['agent', 1000, 0]]);
  } finally { await f.stop(); }
}));

test('a framework/state that is not an object fails create(), naming it, and is left as it was', inStoreDir('boot-read-state-root-', async (storePath) => {
  const seed = JsStore.openOrCreate({ path: storePath });
  try {
    seed.registerState({ id: 'framework/state', strategy: 'snapshot' });
    seed.setStateJson('framework/state', 'usage');
  } finally { seed.close(); }
  await rejectsBuild(() => AgentFramework.create(config(storePath)), /^framework\/state holds a string, not an object\. The framework doesn't start on it, since its first write would replace it and everything it keeps, such as the usage totals and each agent's settings\. It's unchanged, and starting again won't help until it's repaired\.$/);
  assert.equal(readState(storePath, 'framework/state'), 'usage');
}));

// ---------------------------------------------------------------------------
// Inline caps
// ---------------------------------------------------------------------------

test("inline caps that can't be read are logged, boot goes on, and setting one keeps the others stored", inStoreDir('boot-read-caps-', async (storePath) => {
  seedFrameworkState(storePath, { toolResultInlineCaps: { agent: 5000 } });
  const twoAgents = { ...config(storePath), agents: [...agents, { name: 'other', model: 'test-model', systemPrompt: 'test' }] } as FrameworkConfig;
  const restore = failStoreRead('framework/state', 'readPersistedToolResultInlineCaps');
  const log = quietErrors();
  let f: AgentFramework;
  try {
    f = await AgentFramework.create(twoAgents);
  } finally { restore(); log.restore(); }
  try {
    assert.ok(
      log.lines.some((l) => l.includes(
        "[agent-settings] the persisted tool_result_inline_max_chars caps (framework/state) could not be read: injected EIO reading framework/state; they don't apply until a restart, and setting one keeps the others stored",
      )),
      log.lines.join('\n'),
    );
    const settings = (f as unknown as {
      collectAgentSettingsExtensions(): Map<string, {
        get(agentName: string): Record<string, unknown>;
        update(agentName: string, patch: Record<string, unknown>): unknown;
      }>;
    }).collectAgentSettingsExtensions().get('_framework')!;
    assert.equal(settings.get('agent').tool_result_inline_max_chars, null, "the stored cap doesn't apply");
    settings.update('other', { tool_result_inline_max_chars: 2000 });
  } finally { await f.stop(); }
  assert.deepEqual((readState(storePath, 'framework/state') as { toolResultInlineCaps: unknown }).toolResultInlineCaps, { agent: 5000, other: 2000 });
}));

test("a stored inline cap that can't become a number is dropped, loudly, and the others apply", inStoreDir('boot-read-caps-entry-', async (storePath) => {
  // Number() throws for an object it can't make a primitive of.
  seedFrameworkState(storePath, { toolResultInlineCaps: { agent: { toString: null }, other: 5000 } });
  const twoAgents = { ...config(storePath), agents: [...agents, { name: 'other', model: 'test-model', systemPrompt: 'test' }] } as FrameworkConfig;
  const log = quietErrors();
  let f: AgentFramework;
  try {
    f = await AgentFramework.create(twoAgents);
  } finally { log.restore(); }
  try {
    assert.ok(
      log.lines.some((l) => l.includes(`[agent-settings] dropping invalid persisted tool_result_inline_max_chars for 'agent': {"toString":null}`)),
      log.lines.join('\n'),
    );
    const settings = (f as unknown as {
      collectAgentSettingsExtensions(): Map<string, { get(agentName: string): Record<string, unknown> }>;
    }).collectAgentSettingsExtensions().get('_framework')!;
    assert.equal(settings.get('agent').tool_result_inline_max_chars, null);
    assert.equal(settings.get('other').tool_result_inline_max_chars, 5000);
  } finally { await f.stop(); }
}));

// ---------------------------------------------------------------------------
// Tool-result guards
// ---------------------------------------------------------------------------

const guardOf = (f: AgentFramework, name: string): boolean | undefined =>
  (f.getAgent(name) as unknown as { toolResultGuard: { settingOverride?: boolean } }).toolResultGuard.settingOverride;

test("tool-result guards that can't be read, or that aren't an object, fail create(), naming them, and are left as they were", inStoreDir('boot-read-guards-', async (storePath) => {
  const first = await AgentFramework.create(config(storePath));
  await first.stop();
  seedFrameworkState(storePath, { toolResultGuards: { agent: true } });
  const restore = failStoreRead('framework/state', 'adoptToolResultGuard');
  try {
    await rejectsBuild(() => AgentFramework.create(config(storePath)), /^the tool-result guards \(framework\/state, toolResultGuards\) could not be read: injected EIO reading framework\/state\. Agent "agent" isn't created, since without them it would take its recipe's guard\. They're unchanged, and it's created once they can be read\.$/);
  } finally { restore(); }
  const f = await AgentFramework.create(config(storePath));
  try { assert.equal(guardOf(f, 'agent'), true, 'the next boot restores the guard'); } finally { await f.stop(); }
  for (const [guards, are] of [['agent', 'a string'], [null, 'null'], [[true], 'an array']] as const) {
    seedFrameworkState(storePath, { toolResultGuards: guards });
    await rejectsBuild(() => AgentFramework.create(config(storePath)), new RegExp(
      `^the tool-result guards \\(framework/state, toolResultGuards\\) are ${are}, not an object of agents' guards\\. Agent "agent" isn't ` +
      `created, since without them it would take its recipe's guard and the next guard change would store over them\\. They're ` +
      `unchanged, and creating it again won't help until the host's operator repairs them\\.$`,
    ), JSON.stringify(guards));
    assert.deepEqual((readState(storePath, 'framework/state') as { toolResultGuards: unknown }).toolResultGuards, guards);
  }
}));

// ---------------------------------------------------------------------------
// Coalescing
// ---------------------------------------------------------------------------

test("coalescing receipts that can't be read fail create(), and the next boot delivers the acknowledged work", async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('1', 'accepted_before_crash', { deferred: true, data: { k: 'v' } });
  const original = await f.send('push/event', params);
  await crash(f);
  const restore = failStoreRead('mcpl/coalescing-recent', 'restorePushCoalescer');
  try {
    await rejectsBuild(() => f.create(), /^the coalescing receipts since the last snapshot \(mcpl\/coalescing-recent\) could not be read: injected EIO reading mcpl\/coalescing-recent\. MCPL doesn't start without them, and neither does create\(\) with MCPL servers configured, nor a first connectMcplServer\(\), since the next coalesced push or message would replace them\. They're unchanged, and MCPL starts once they can be read\.$/);
  } finally { restore(); }
  await f.create();
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, original.result, 'the receipt survived');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'the accepted work was delivered');
  assert.ok(f.lastRequest().includes('accepted_before_crash'));
});

test("a coalescing snapshot that can't be read fails create(), and the next boot renders its batch", async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'pending_before_crash', { deferred: true }));
  (f.framework as unknown as { flushCoalescingSnapshot(): void }).flushCoalescingSnapshot();
  await crash(f);
  const restore = failStoreRead('mcpl/coalescing', 'restorePushCoalescer');
  try {
    await rejectsBuild(() => f.create(), /^the coalescing receipts and batches \(mcpl\/coalescing\) could not be read: injected EIO reading mcpl\/coalescing\. MCPL doesn't start without them/);
  } finally { restore(); }
  await f.create();
  await f.framework.runUntilIdle();
  assert.equal(f.renders.length, 1, 'the restored batch was rendered');
  assert.ok(f.lastRequest().includes('document_diff'));
});

test("coalescing receipts whose delivery an agent's context can't confirm fail create(), and the next boot delivers once", async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('1', 'accepted_before_crash', { deferred: true, data: { k: 'v' } });
  const original = await f.send('push/event', params);
  await crash(f);
  // Restoring a receipt asks every agent's context whether its occurrence was delivered.
  const proto = ContextManager.prototype as unknown as { getAllMessages(this: ContextManager): unknown[] };
  const real = proto.getAllMessages;
  proto.getAllMessages = function (this: ContextManager) {
    if (new Error().stack?.includes('wasPublished')) throw new Error('injected EIO reading the context');
    return real.call(this);
  };
  try {
    await rejectsBuild(() => f.create(), /^the coalescing receipts since the last snapshot \(mcpl\/coalescing-recent\) can't be checked for occurrences already delivered: agent's context could not be read: injected EIO reading the context\. MCPL doesn't start without that check, and neither does create\(\) with MCPL servers configured, nor a first connectMcplServer\(\), since an occurrence delivered before the restart would be delivered again\. They're unchanged, and MCPL starts once that context can be read\.$/);
  } finally { proto.getAllMessages = real; }
  await f.create();
  const retry = await f.send('push/event', params);
  assert.deepEqual(retry.result, original.result, 'the receipt survived');
  await f.framework.runUntilIdle();
  assert.equal(f.membrane.calls.length, 1, 'the accepted work was delivered once');
});

test("coalescing state this code doesn't read fails create(), naming what it is, and is left as it was", async (t) => {
  const f = await fixture(); t.after(f.close);
  await f.send('push/event', f.params('1', 'pending', { deferred: true }));
  (f.framework as unknown as { flushCoalescingSnapshot(): void }).flushCoalescingSnapshot();
  await crash(f);
  const storePath = join(f.dir, 'store');
  const snapshot = readState(storePath, 'mcpl/coalescing') as Record<string, unknown>;
  const cases: Array<[string, string, unknown, string]> = [
    ['a version 2 snapshot', 'mcpl/coalescing', { ...snapshot, version: 2 }, "receipts and batches \\(mcpl/coalescing\\) are a version 2 snapshot, which this version of agent-framework doesn't read\\. MCPL doesn't start without them, and neither does create\\(\\) with MCPL servers configured, nor a first connectMcplServer\\(\\), since the next coalesced push or message would replace them\\. They're unchanged, and the version that wrote them reads them\\.$"],
    ['a snapshot whose version is a string', 'mcpl/coalescing', { ...snapshot, version: '1' }, "receipts and batches \\(mcpl/coalescing\\) are a snapshot whose version is a string, not 1\\. .* They're unchanged, and starting again won't help until they're repaired\\.$"],
    ['a snapshot with no version', 'mcpl/coalescing', { receipts: [], subjects: [] }, 'receipts and batches \\(mcpl/coalescing\\) are an object with no snapshot version\\.'],
    ['a snapshot that is an array', 'mcpl/coalescing', [snapshot], 'receipts and batches \\(mcpl/coalescing\\) are an array with no snapshot version\\.'],
    ['a snapshot restore throws on', 'mcpl/coalescing', { ...snapshot, subjects: 5 }, 'receipts and batches \\(mcpl/coalescing\\) could not be restored: .*\\. MCPL doesn\'t start'],
    ['receipts that are an object', 'mcpl/coalescing-recent', { 0: 'receipt' }, 'receipts since the last snapshot \\(mcpl/coalescing-recent\\) are an object, not a list of receipts\\.'],
    ['receipts restoreReceipts throws on', 'mcpl/coalescing-recent', [null], 'receipts since the last snapshot \\(mcpl/coalescing-recent\\) could not be restored: .*\\. MCPL doesn\'t start'],
  ];
  for (const [name, stateId, value, says] of cases) {
    const store = JsStore.openOrCreate({ path: storePath });
    const previous = store.getStateJson(stateId);
    store.setStateJson(stateId, value);
    store.close();
    await rejectsBuild(() => f.create(), new RegExp(`^the coalescing ${says}`), name);
    assert.deepEqual(readState(storePath, stateId), value, `${name}: left as it was`);
    const reset = JsStore.openOrCreate({ path: storePath });
    reset.setStateJson(stateId, previous);
    reset.close();
  }
});

// ---------------------------------------------------------------------------
// MCPL checkpoints
// ---------------------------------------------------------------------------

test("MCPL checkpoint trees that can't be read, or that aren't checkpoint trees, fail create(), and are left as they were", async (t) => {
  const f = await fixture(); t.after(f.close);
  await crash(f);
  const storePath = join(f.dir, 'store');
  const restore = failStoreRead('mcpl/checkpoints', 'loadFromStore');
  try {
    await rejectsBuild(() => f.create(), /^the MCPL checkpoint trees \(mcpl\/checkpoints\) could not be read: injected EIO reading mcpl\/checkpoints\. MCPL doesn't start without them, and neither does create\(\) with MCPL servers configured, nor a first connectMcplServer\(\), since the next feature set registered would store over them\. They're unchanged, and MCPL starts once they can be read\.$/);
  } finally { restore(); }
  const before = readState(storePath, 'mcpl/checkpoints');
  for (const [name, value, are] of [
    ['an object without trees', { tree: {} }, 'an object whose trees is missing'],
    ['an array', [{ trees: {} }], 'an array'],
    ['trees that are a string', { trees: 'srv:doc' }, 'an object whose trees is a string'],
  ] as const) {
    const store = JsStore.openOrCreate({ path: storePath });
    store.setStateJson('mcpl/checkpoints', value);
    store.close();
    await rejectsBuild(() => f.create(), new RegExp(
      `^the MCPL checkpoint trees \\(mcpl/checkpoints\\) are ${are}, not checkpoint trees\\. MCPL doesn't start without them, .*` +
      `They're unchanged, and starting again won't help until they're repaired\\.$`,
    ), name);
    assert.deepEqual(readState(storePath, 'mcpl/checkpoints'), value, `${name}: left as it was`);
  }
  const reset = JsStore.openOrCreate({ path: storePath });
  reset.setStateJson('mcpl/checkpoints', before);
  reset.close();
  await f.create();
});

test("an unreadable checkpoint store's error is quoted to 500 characters, counted in code points, without halving a surrogate pair", inStoreDir('boot-read-long-error-', async (storePath) => {
  const store = JsStore.openOrCreate({ path: storePath });
  // 499 characters, then an emoji whose two UTF-16 units straddle unit 500.
  // Counted in code points, the emoji is the 500th character.
  const message = `${'x'.repeat(499)}😀 and more`;
  const proto = JsStore.prototype as unknown as { getStateJson(this: JsStore, id: string): unknown };
  const original = proto.getStateJson;
  proto.getStateJson = function (this: JsStore, id: string) {
    if (id === 'mcpl/checkpoints') throw new Error(message);
    return original.call(this, id);
  };
  try {
    assert.throws(() => new CheckpointManager(store, () => {}), (error: Error) => {
      assert.ok(
        error.message.startsWith(`the MCPL checkpoint trees (mcpl/checkpoints) could not be read: ${'x'.repeat(499)}😀… (509 characters). MCPL doesn't start`),
        `the cut keeps the emoji whole, and the count is of code points: …${JSON.stringify(error.message.slice(555, 600))}`,
      );
      return true;
    });
  } finally {
    proto.getStateJson = original;
    store.close();
  }
}));

/** A stored host-managed checkpoint tree for `server`'s `featureSet`, holding `state`, as the checkpoint manager stores them. */
function seedHostManaged(storePath: string, server: string, featureSet: string, state: unknown): void {
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    for (const id of ['mcpl/checkpoints', `mcpl/state/${server}/${featureSet}`]) {
      try { store.registerState({ id, strategy: 'snapshot' }); } catch (error) { if (!isStateExistsError(error)) throw error; }
    }
    store.setStateJson('mcpl/checkpoints', { trees: { [`${server}:${featureSet}`]: {
      hostState: true, rollback: false, current: 'c1', nodes: { c1: { parent: null, children: [], data: state } },
    } } });
    store.setStateJson(`mcpl/state/${server}/${featureSet}`, state);
  } finally { store.close(); }
}

/** The refusal of a host-managed state read before its server connects, or, with `registration`, when its feature set registers. */
const hostStateUnreadable = (server: string, featureSet: string, when: 'before-connect' | 'registration' = 'before-connect'): RegExp => new RegExp(
  `^the host-managed state of feature set "${featureSet}" on MCPL server "${server}" \\(mcpl/state/${server}/${featureSet}\\) could not ` +
  `be registered or read: injected EIO reading mcpl/state/${server}/${featureSet}\\. ` +
  (when === 'before-connect'
    ? `Neither create\\(\\) with the server configured nor a connectMcplServer\\(\\) of it goes on without it, since the feature set's ` +
      `next checkpoint would store over it\\. It's unchanged, and they go on once it can be read\\.$`
    : `The feature set isn't registered without it, since its next checkpoint would store over it, so the server's connect ` +
      `fails\\. It's unchanged, and it's read again when the feature set next registers\\.$`),
);

test("at boot, a configured server's restored host-managed state that can't be read fails create() before any server connects, and the next boot reads it", async (t) => {
  // The fixture declares `doc` with neither hostState nor rollback, so it never
  // registers with the checkpoint manager: its stored tree is read at MCPL's start.
  const f = await fixture(); t.after(f.close);
  await crash(f);
  const storePath = join(f.dir, 'store');
  seedHostManaged(storePath, 'editor', 'doc', { count: 1 });
  const initializes = f.hostCaps.length;
  const restore = failStoreRead('mcpl/state/editor/doc', 'loadHostState');
  try {
    await rejectsBuild(() => f.create(), hostStateUnreadable('editor', 'doc'));
  } finally { restore(); }
  assert.equal(f.hostCaps.length, initializes, 'no server connected: the fixture saw no initialize');
  assert.deepEqual(readState(storePath, 'mcpl/state/editor/doc'), { count: 1 }, 'the state is as it was');
  await f.create();
  const checkpoints = (f.framework as unknown as { checkpointManager: CheckpointManager }).checkpointManager;
  assert.deepEqual(checkpoints.getCurrentState('editor', 'doc'), { count: 1 }, 'the next boot reads it');
});

test("at a runtime connect, a restored host-managed state that can't be read fails the connect before the server is added, and the next connect reads it", async (t) => {
  const f = await fixture(); t.after(f.close);
  await crash(f);
  const storePath = join(f.dir, 'store');
  seedHostManaged(storePath, 'editor', 'doc', { count: 1 });
  // With no MCPL servers configured, the subsystem comes up at the first connect.
  const framework = await AgentFramework.create({
    storePath, membrane: f.membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
  } as unknown as FrameworkConfig);
  try {
    const server = { id: 'editor', url: `ws://127.0.0.1:${f.port}`, enabledFeatureSets: ['doc'] } as McplServerConfig;
    const internals = framework as unknown as {
      mcplServerRegistry: { getServer(id: string): unknown } | null;
      checkpointManager: CheckpointManager | null;
    };
    const restore = failStoreRead('mcpl/state/editor/doc', 'loadHostState');
    try {
      await assert.rejects(framework.connectMcplServer(server), { message: hostStateUnreadable('editor', 'doc') });
    } finally { restore(); }
    // The first connect brought MCPL up, and the read failed before the server was added.
    assert.equal(internals.mcplServerRegistry?.getServer('editor'), null, 'the server was not added');
    await framework.connectMcplServer(server);
    assert.ok(internals.mcplServerRegistry?.getServer('editor'), 'the next connect adds it');
    assert.deepEqual(internals.checkpointManager?.getCurrentState('editor', 'doc'), { count: 1 }, 'and reads its state');
  } finally { await framework.stop(); }
});

test("a connect of a server already connected is refused as before, without reading its trees again", async (t) => {
  const f = await fixture(); t.after(f.close);
  await crash(f);
  // A host-managed tree whose stored state holds nothing, so it holds no state in memory once read.
  seedHostManaged(join(f.dir, 'store'), 'editor', 'notes', null);
  await f.create();
  const server = { id: 'editor', url: `ws://127.0.0.1:${f.port}`, enabledFeatureSets: ['doc'] } as McplServerConfig;
  const restore = failStoreRead('mcpl/state/editor/notes', 'loadHostState');
  try {
    await assert.rejects(f.framework.connectMcplServer(server), { message: 'MCPL server "editor" is already registered' });
  } finally { restore(); }
});

test('a host-managed feature set restored from the store has its state read by loadHostStates, so its next patch applies to it', inStoreDir('boot-read-host-state-', async (storePath) => {
  const noop = () => {};
  const first = JsStore.openOrCreate({ path: storePath });
  try {
    const checkpoints = new CheckpointManager(first, noop);
    checkpoints.registerFeatureSet('srv', 'doc', { hostState: true, rollback: false });
    checkpoints.recordCheckpoint('srv', 'doc', { checkpoint: 'c1', data: { count: 1 } } as never);
  } finally { first.close(); }
  // A restart: the store opened again, its trees restored, their states read before the server connects, and the feature set registered again.
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    const checkpoints = new CheckpointManager(store, noop);
    assert.equal(checkpoints.getCurrentState('srv', 'doc'), undefined, 'restored, the tree holds no state until it is read');
    checkpoints.loadHostStates('srv');
    checkpoints.registerFeatureSet('srv', 'doc', { hostState: true, rollback: false });
    assert.deepEqual(checkpoints.getCurrentState('srv', 'doc'), { count: 1 });
    checkpoints.recordCheckpoint('srv', 'doc', { checkpoint: 'c2', parent: 'c1', patch: [{ op: 'add', path: '/other', value: 2 }] } as never);
    assert.deepEqual(store.getStateJson('mcpl/state/srv/doc'), { count: 1, other: 2 });
  } finally { store.close(); }
}));

test("loadHostStates loads its own server's host state, not another server's, and leaves a state already in memory as it is", inStoreDir('boot-read-host-state-scope-', async (storePath) => {
  const noop = () => {};
  const first = JsStore.openOrCreate({ path: storePath });
  try {
    const checkpoints = new CheckpointManager(first, noop);
    checkpoints.registerFeatureSet('srv', 'doc', { hostState: true, rollback: false });
    checkpoints.recordCheckpoint('srv', 'doc', { checkpoint: 'c1', data: { count: 1 } } as never);
    checkpoints.registerFeatureSet('other', 'doc', { hostState: true, rollback: false });
    checkpoints.recordCheckpoint('other', 'doc', { checkpoint: 'c1', data: { count: 2 } } as never);
    // A rollback-only tree keeps no host-managed state.
    checkpoints.registerFeatureSet('srv', 'undo', { hostState: false, rollback: true });
  } finally { first.close(); }
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    const checkpoints = new CheckpointManager(store, noop);
    checkpoints.loadHostStates('srv');
    assert.deepEqual(checkpoints.getCurrentState('srv', 'doc'), { count: 1 }, "srv's host-managed tree is loaded");
    assert.equal(checkpoints.getCurrentState('other', 'doc'), undefined, "another server's tree waits for its own connect");
    // A state already in memory, as a connected server's is, isn't read
    // again: a newer stored state doesn't replace it.
    const writer = new CheckpointManager(store, noop);
    writer.registerFeatureSet('srv', 'doc', { hostState: true, rollback: false });
    writer.recordCheckpoint('srv', 'doc', { checkpoint: 'c2', data: { count: 9 } } as never);
    checkpoints.loadHostStates('srv');
    assert.deepEqual(checkpoints.getCurrentState('srv', 'doc'), { count: 1 }, 'the state in memory stands');
  } finally {
    store.close();
  }
}));

test("a host-managed feature set's state that can't be read fails loadHostStates for a restored tree, or the registration for a first-time one, naming it, and the next one reads it", inStoreDir('boot-read-host-state-read-', async (storePath) => {
  const noop = () => {};
  const first = JsStore.openOrCreate({ path: storePath });
  try {
    const checkpoints = new CheckpointManager(first, noop);
    checkpoints.registerFeatureSet('srv', 'doc', { hostState: true, rollback: false });
    checkpoints.recordCheckpoint('srv', 'doc', { checkpoint: 'c1', data: { count: 1 } } as never);
    // A second feature set's state, stored with no tree: its first registration reads it.
    first.registerState({ id: 'mcpl/state/srv/notes', strategy: 'snapshot' });
    first.setStateJson('mcpl/state/srv/notes', { count: 3 });
  } finally { first.close(); }
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    const checkpoints = new CheckpointManager(store, noop);
    // `doc` is a tree restored from the store, read by loadHostStates; `notes`
    // is registered for the first time, and read by its registration.
    const reads = {
      doc: () => checkpoints.loadHostStates('srv'),
      notes: () => checkpoints.registerFeatureSet('srv', 'notes', { hostState: true, rollback: false }),
    };
    for (const [featureSet, state] of [['doc', { count: 1 }], ['notes', { count: 3 }]] as const) {
      const stateId = `mcpl/state/srv/${featureSet}`;
      const restore = failStoreRead(stateId, 'loadHostState');
      try {
        assert.throws(reads[featureSet], {
          message: hostStateUnreadable('srv', featureSet, featureSet === 'doc' ? 'before-connect' : 'registration'),
        });
      } finally { restore(); }
      reads[featureSet]();
      assert.deepEqual(checkpoints.getCurrentState('srv', featureSet), state, `${featureSet}: the next one reads it`);
    }
    // The registration that failed held no tree, so the next one registered it whole, stored tree included.
    const trees = (store.getStateJson('mcpl/checkpoints') as { trees: Record<string, unknown> }).trees;
    assert.ok(trees['srv:notes'], 'the first-time feature set is in the stored trees');
  } finally { store.close(); }
}));

test("at a runtime connect, coalescing state or checkpoint trees that can't be read fail the connect with nothing of MCPL built, and the next connect restores them", async (t) => {
  const f = await fixture(); t.after(f.close);
  const params = f.params('1', 'accepted_before_crash', { deferred: true, data: { k: 'v' } });
  const original = await f.send('push/event', params);
  await crash(f);
  // With no MCPL servers configured, the subsystem comes up at the first connect.
  const framework = await AgentFramework.create({
    storePath: join(f.dir, 'store'), membrane: f.membrane.asMembrane(),
    agents: [{ name: 'agent', model: 'test', systemPrompt: 'test' }], modules: [],
  } as unknown as FrameworkConfig);
  try {
    const server = { id: 'editor', url: `ws://127.0.0.1:${f.port}`, enabledFeatureSets: ['doc'] } as McplServerConfig;
    const store = framework.getStore() as unknown as JsStore;
    const stored = () => ['mcpl/coalescing', 'mcpl/coalescing-recent', 'mcpl/checkpoints'].map((id) => store.getStateJson(id));
    const before = stored();
    const internals = framework as unknown as { mcplServerRegistry: unknown; pushCoalescer: unknown; checkpointManager: unknown };
    for (const [stateId, reader, says] of [
      ['mcpl/coalescing-recent', 'restorePushCoalescer', 'the coalescing receipts since the last snapshot'],
      ['mcpl/coalescing', 'restorePushCoalescer', 'the coalescing receipts and batches'],
      ['mcpl/checkpoints', 'loadFromStore', 'the MCPL checkpoint trees'],
    ] as const) {
      const restore = failStoreRead(stateId, reader);
      try {
        await assert.rejects(framework.connectMcplServer(server), {
          message: new RegExp(`^${says} \\(${stateId}\\) could not be read: injected EIO reading ${stateId}\\. MCPL doesn't start without them`),
        });
      } finally { restore(); }
      assert.equal(internals.mcplServerRegistry, null, `${stateId}: nothing of the MCPL subsystem is built`);
      assert.equal(internals.pushCoalescer, null, `${stateId}: no coalescer is installed`);
      assert.equal(internals.checkpointManager, null, `${stateId}: no checkpoint manager is installed`);
      assert.deepEqual(stored(), before, `${stateId}: the stored state is as it was`);
    }
    await framework.connectMcplServer(server);
    const retry = await f.send('push/event', params);
    assert.deepEqual(retry.result, original.result, 'the receipt survived the refused connects');
  } finally { await framework.stop(); }
});

test('the forms a release wrote boot as before', inStoreDir('boot-read-release-forms-', async (storePath) => {
  // As every release from 0.16.0 writes them, with the head's readers: a
  // resumed host's record, and the queue's cleared and pending forms.
  const recovery = join(storePath, 'recovery');
  const first = await AgentFramework.create(config(storePath));
  await first.stop();
  mkdirSync(recovery, { recursive: true });
  const write = (name: string, doc: unknown) => writeFileSync(join(recovery, name), `${JSON.stringify(doc, null, 2)}\n`);
  const boot = async (check: (f: AgentFramework) => void) => {
    const f = await AgentFramework.create(config(storePath));
    try { check(f); } finally { await f.stop(); }
  };
  write('host-mode.json', { version: 1, quiesced: false, clearedAt: 1 });
  write('deferred-writes.json', { version: 1, pending: [] });
  await boot((f) => {
    assert.equal(f.getHostModeStatus().quiesced, false);
    assert.equal(f.getHostModeStatus().deferredWrites, 0);
  });
  write('host-mode.json', { version: 1, quiesced: true, reason: 'surgery', since: 1 });
  write('deferred-writes.json', {
    version: 2, pending: [{ participant: 'user', content: [{ type: 'text', text: 'queued' }], id: 'w1', seq: 1 }], scanFrom: { agent: 0 },
  });
  await boot((f) => {
    assert.equal(f.getHostModeStatus().quiesced, true);
    assert.equal(f.getHostModeStatus().reason, 'surgery');
    assert.equal(f.getHostModeStatus().deferredWrites, 1);
  });
}));

test('a store from before the recovery files boots from its slots, as before', inStoreDir('boot-read-pre-file-', async (storePath) => {
  // A store from before host-mode.json and deferred-writes.json existed keeps
  // both in the store: framework/state's hostMode, and a bare list of writes.
  const first = await AgentFramework.create(config(storePath));
  await first.stop();
  const store = JsStore.openOrCreate({ path: storePath });
  try {
    store.setStateJson('framework/state', { hostMode: { quiesced: true, reason: 'surgery', since: 1 } });
    store.setStateJson('framework/deferred-writes', [{ participant: 'user', content: [{ type: 'text', text: 'queued' }] }]);
  } finally { store.close(); }
  const f = await AgentFramework.create(config(storePath));
  try {
    assert.equal(f.getHostModeStatus().quiesced, true);
    assert.equal(f.getHostModeStatus().deferredWrites, 1);
  } finally { await f.stop(); }
}));

test('an agent named like an object property has no settings record or guard unless one is stored for it', inStoreDir('boot-read-settings-own-', async (storePath) => {
  seedFrameworkState(storePath, {
    agentRuntimeSettings: { other: { sameRoundThinkTextPolicy: 'private' } },
    toolResultGuards: { other: true },
  });
  const named = { ...config(storePath), agents: [{ name: 'constructor', model: 'test-model', systemPrompt: 'test' }] } as FrameworkConfig;
  const f = await AgentFramework.create(named);
  try {
    assert.ok(f.getAgent('constructor'));
    assert.equal(guardOf(f, 'constructor'), undefined, 'no inherited guard');
  } finally { await f.stop(); }
}));

test('nothing stored reads as empty: a first boot starts serving, with no usage, deferred writes or coalescing history', async (t) => {
  const f = await fixture(); t.after(f.close);
  assert.equal(f.framework.getHostModeStatus().quiesced, false);
  assert.equal(f.framework.getHostModeStatus().deferredWrites, 0);
  assert.equal(f.framework.getSessionUsage().totals.inputTokens, 0);
  const first = await f.send('push/event', f.params('1', 'first', { deferred: true }));
  assert.ok(first.result, 'a push is accepted');
});
