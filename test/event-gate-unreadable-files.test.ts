/**
 * The gate's files when they can't be read. A wake-rule change starts from the
 * rules in force when gate.json is there but won't load, and it used to write
 * them straight over the file, so whatever the file held, such as an
 * operator's unfinished edit, was lost. Now a copy of the file is kept first,
 * at gate.json.unreadable-<UTC time>, gate.json is written in place, and the
 * change says where the copy is. Both files are reloaded by their text, and
 * each file's current problem shows once in gate_status.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, {
  chmodSync, chownSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo, UnreadableConfigKept } from '../src/gate/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** 2026-10-15T02:59:05.250Z, so a kept copy is named gate.json.unreadable-20261015T025905Z. */
const AT = Date.UTC(2026, 9, 15, 2, 59, 5, 250);
const BROKEN = '{"default": "defer", "policies": [{"name": "half-made",';
const RULES: GateConfig = {
  default: 'defer',
  policies: [{ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }],
};
const QUIET: GateConfig = { default: 'always', policies: [{ name: 'quiet', match: {}, behavior: { debounce: 60000 } }] };
const INCOMING: GateEventInfo = { content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags: [] };
/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const GRIN = '\u{1F600}';
const NO_CHMOD = process.platform === 'win32' || process.getuid?.() === 0;
/** A group this process is in besides its own, which a gate.json can be shared through. */
const OTHER_GROUP = process.platform === 'win32' ? undefined : process.getgroups?.().find((g) => g !== process.getegid?.());

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-unreadable-'));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeGate(
  dir: string,
  opts: { config?: GateConfig; privileged?: string; now?: () => number; traces?: Array<{ type: string; [k: string]: unknown }> } = {},
) {
  const configPath = join(dir, 'gate.json');
  if (opts.config) writeFileSync(configPath, JSON.stringify(opts.config));
  const privilegedUsersPath = join(dir, 'privileged.json');
  if (opts.privileged !== undefined) writeFileSync(privilegedUsersPath, opts.privileged);
  const gate = new EventGate({
    configPath,
    privilegedUsersPath,
    emitTrace: (e) => { opts.traces?.push(e); },
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
    now: opts.now ?? (() => AT),
  });
  return { gate, configPath, privilegedUsersPath };
}

const onDisk = (path: string): GateConfig => JSON.parse(readFileSync(path, 'utf-8')) as GateConfig;
const keptFiles = (dir: string): string[] => readdirSync(dir).filter((f) => f.startsWith('gate.json.unreadable-')).sort();
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const renamedRules = (name: string): string => JSON.stringify({ ...RULES, policies: [{ ...RULES.policies[0]!, name }] });
/** What a call threw, so a test can restore a mode before it asserts. */
function thrownBy(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '(nothing was thrown)';
}

test('a change over a gate.json that will not load keeps a copy first, then writes the rules in force with the change', (t) => {
  const dir = tempDir(t);
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const { gate, configPath } = makeGate(dir, { config: RULES, traces });
  const logged = t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);
  assert.deepEqual(gate.getStatus().keptCopies, []);

  const kept: UnreadableConfigKept[] = [];
  gate.addPolicy({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' }, { onUnreadableKept: (k) => kept.push(k) });

  const keptPath = join(dir, 'gate.json.unreadable-20261015T025905Z');
  assert.equal(readFileSync(keptPath, 'utf-8'), BROKEN, 'the unreadable file is kept, byte for byte');
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'ambient']);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.keptPath, keptPath);
  assert.match(kept[0]!.reason, /JSON/, 'the reason is why it could not be loaded');
  assert.deepEqual(gate.getStatus().errors, [], 'gate.json loads again');
  const keptTraces = traces.filter((e) => e.type === 'gate:config-kept');
  assert.equal(keptTraces.length, 1);
  assert.equal(keptTraces[0]!.keptPath, keptPath);
  assert.equal(keptTraces[0]!.error, kept[0]!.reason);
  assert.deepEqual(
    logged.mock.calls.map((c) => c.arguments[0]),
    [
      `[gate] ${configPath} couldn't be used (${kept[0]!.reason}), so what it holds isn't in force`,
      `[gate] ${configPath} couldn't be used (${kept[0]!.reason}); kept a copy at ${keptPath} before writing the rules in force`,
    ],
    'the failed load is logged once, then the copy',
  );

  // A second unreadable file in the same second takes the next free name, by removePolicy.
  writeFileSync(configPath, `${BROKEN} "second"`);
  assert.equal(gate.removePolicy('ambient', { onUnreadableKept: (k) => kept.push(k) }), true);
  assert.deepEqual(keptFiles(dir), ['gate.json.unreadable-20261015T025905Z', 'gate.json.unreadable-20261015T025905Z-2']);
  assert.equal(readFileSync(keptPath, 'utf-8'), BROKEN, 'the first copy is not replaced');
  assert.equal(readFileSync(`${keptPath}-2`, 'utf-8'), `${BROKEN} "second"`);
  assert.equal(kept[1]!.keptPath, `${keptPath}-2`);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions']);

  // gate_status lists each copy, with what to do with it, until it's removed.
  const told = ": a copy of gate.json, kept when it couldn't be used. Nothing in it is in force. "
    + "To use it, fix it and copy it over gate.json. Once it isn't needed, remove it.";
  assert.deepEqual(gate.getStatus().keptCopies, [`${keptPath}${told}`, `${keptPath}-2${told}`]);
  rmSync(keptPath);
  assert.deepEqual(gate.getStatus().keptCopies, [`${keptPath}-2${told}`]);
});

test('a gate.json that is JSON the gate refuses whole, for a default other than the three, is not written over or kept', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  const refused = JSON.stringify({ default: 'sometimes', policies: [{ name: 'quick', behavior: 'always' }] });
  writeFileSync(configPath, refused);
  const logged = t.mock.method(console, 'error', () => {});

  // It's the operator's file, edited as written, and what a change writes has to load.
  assert.throws(
    () => gate.addPolicy({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' }),
    {
      message: 'Nothing was saved: with this change, gate.json wouldn\'t be used. gate.json "default" must be "always", "defer", or "skip", '
        + 'got: "sometimes". No change through the gate can bring it into force, so whoever runs this host has to fix gate.json; '
        + 'until then, a change is refused the same way.',
    },
  );
  assert.throws(() => gate.removePolicy('quick'), { message: /^Nothing was saved: with this change, gate\.json wouldn't be used\. gate\.json "default" must be/ });
  assert.equal(readFileSync(configPath, 'utf-8'), refused, 'gate.json is as the operator wrote it');
  assert.deepEqual(keptFiles(dir), [], 'nothing is kept, since nothing is written over it');
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'the rules in force stay');
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments[0]), [
    `[gate] ${configPath} couldn't be used (gate.json "default" must be "always", "defer", or "skip", got: "sometimes"), so what it holds `
    + 'isn\'t in force',
  ], 'once, though it was read three times');
});

test('a gate.json that is not UTF-8 is kept byte for byte', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  // The keep's log line quotes JSON.parse's error, which quotes the decoded text: NULs, for UTF-16.
  t.mock.method(console, 'error', () => {});
  // A half-made edit saved as Latin-1, then a file as Windows PowerShell 5's
  // `>` writes one: UTF-16LE, with a byte order mark.
  const latin1 = Buffer.from('{"default": "defer", "policies": [{"name": "caf\u00e9",', 'latin1');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(RULES), 'utf16le')]);
  writeFileSync(configPath, latin1);
  gate.addPolicy({ name: 'ambient', behavior: 'defer' });
  writeFileSync(configPath, utf16);
  assert.equal(gate.removePolicy('ambient'), true);

  assert.deepEqual(keptFiles(dir), ['gate.json.unreadable-20261015T025905Z', 'gate.json.unreadable-20261015T025905Z-2']);
  assert.deepEqual(readFileSync(join(dir, 'gate.json.unreadable-20261015T025905Z')), latin1);
  assert.deepEqual(readFileSync(join(dir, 'gate.json.unreadable-20261015T025905Z-2')), utf16);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions']);
});

test("a copy has gate.json's group and permission bits: an owner-only file's copy is owner-only, and a group-readable one's stays group-readable", {
  skip: process.platform === 'win32' ? 'needs POSIX permission bits' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  for (const [mode, kept] of [[0o600, 'gate.json.unreadable-20261015T025905Z'], [0o640, 'gate.json.unreadable-20261015T025905Z-2']] as const) {
    writeFileSync(configPath, BROKEN);
    chmodSync(configPath, mode);
    gate.addPolicy({ name: `ambient-${mode.toString(8)}`, behavior: 'defer' });
    const copy = statSync(join(dir, kept));
    assert.equal(copy.mode & 0o777, mode, `the copy of a ${mode.toString(8)} gate.json`);
    assert.equal(copy.gid, statSync(configPath).gid, "and gate.json's group");
  }
});

test("a copy of a gate.json shared through another of this process's groups takes that group, so the group can read it", {
  skip: OTHER_GROUP === undefined ? 'needs a group this process is in besides its own' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);
  chmodSync(configPath, 0o640);
  try {
    chownSync(configPath, -1, OTHER_GROUP!);
  } catch (err) {
    t.skip(`gate.json can't be given group ${OTHER_GROUP} here (${(err as Error).message})`);
    return;
  }

  gate.addPolicy({ name: 'ambient', behavior: 'defer' });

  const copy = statSync(join(dir, 'gate.json.unreadable-20261015T025905Z'));
  assert.equal(copy.gid, OTHER_GROUP, "the copy has gate.json's group, not this process's own");
  assert.equal(copy.mode & 0o777, 0o640, 'and its bits');
});

test("a copy takes gate.json's group and bits where chown refuses -1 for its owner, as Bun 1.3.14 does", {
  skip: process.platform === 'win32' ? 'needs POSIX permission bits' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);
  chmodSync(configPath, 0o640);
  const original = fs.chownSync;
  const chown = t.mock.method(fs, 'chownSync', (path: unknown, uid: number, gid: number) => {
    if (uid === -1) throw Object.assign(new Error(`EPERM: operation not permitted, chown '${String(path)}'`), { code: 'EPERM', syscall: 'chown' });
    original(path as string, uid, gid);
  });
  syncBuiltinESMExports();
  try {
    gate.addPolicy({ name: 'ambient', behavior: 'defer' });
  } finally {
    chown.mock.restore();
    syncBuiltinESMExports();
  }

  const copy = statSync(join(dir, 'gate.json.unreadable-20261015T025905Z'));
  assert.equal(copy.gid, statSync(configPath).gid, "the copy has gate.json's group");
  assert.equal(copy.mode & 0o777, 0o640, 'and its bits');
});

test("a copy that can't take gate.json's group stays owner-only", {
  skip: process.platform === 'win32' ? 'needs POSIX permission bits' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);
  chmodSync(configPath, 0o640);
  // chown refuses a group this process isn't in with EPERM.
  const chown = t.mock.method(fs, 'chownSync', (path: unknown) => {
    throw Object.assign(new Error(`EPERM: operation not permitted, chown '${String(path)}'`), { code: 'EPERM', syscall: 'chown' });
  });
  syncBuiltinESMExports();
  try {
    gate.addPolicy({ name: 'ambient', behavior: 'defer' });
  } finally {
    chown.mock.restore();
    syncBuiltinESMExports();
  }

  assert.equal(chown.mock.callCount(), 1, 'the copy was to take the group');
  const copy = statSync(join(dir, 'gate.json.unreadable-20261015T025905Z'));
  assert.equal(copy.mode & 0o777, 0o600, "so it stays owner-only, without gate.json's bits");
});

test("a copy of a gate.json that's a link stays owner-only, since a directory on the way to its file may be what closes it", {
  skip: process.platform === 'win32' ? 'needs a symlink and POSIX permission bits' : false,
}, (t) => {
  const dir = tempDir(t);
  // Its file is open to anyone (0644), inside a directory closed to all but its owner (0700).
  const closed = join(dir, 'closed');
  fs.mkdirSync(closed, { mode: 0o700 });
  const target = join(closed, 'real-gate.json');
  writeFileSync(target, JSON.stringify(RULES));
  chmodSync(target, 0o644);
  const configPath = join(dir, 'gate.json');
  symlinkSync(target, configPath);
  const { gate } = makeGate(dir);
  t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);

  gate.addPolicy({ name: 'ambient', behavior: 'defer' });

  const copy = statSync(join(dir, 'gate.json.unreadable-20261015T025905Z'));
  assert.equal(copy.mode & 0o777, 0o600, 'the copy beside the link is owner-only');
  assert.equal(statSync(target).mode & 0o777, 0o644, 'while the file it points to keeps its mode');
  assert.equal(readFileSync(join(dir, 'gate.json.unreadable-20261015T025905Z'), 'utf-8'), BROKEN, 'and the copy holds what gate.json held');
});

test('keeping a copy leaves a symlinked gate.json pointing at its file, which keeps its mode and takes the change', {
  skip: process.platform === 'win32' ? 'needs a symlink' : false,
}, (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'real-gate.json');
  writeFileSync(target, JSON.stringify(RULES));
  chmodSync(target, 0o640);
  const configPath = join(dir, 'gate.json');
  symlinkSync(target, configPath);
  const { gate } = makeGate(dir);
  writeFileSync(configPath, BROKEN);

  gate.addPolicy({ name: 'ambient', behavior: 'defer' });

  assert.ok(lstatSync(configPath).isSymbolicLink(), 'gate.json is still the link');
  assert.equal(statSync(target).mode & 0o777, 0o640, 'its file keeps its mode');
  assert.deepEqual(onDisk(target).policies.map((p) => p.name), ['mentions', 'ambient'], 'and holds the change');
  assert.equal(readFileSync(join(dir, 'gate.json.unreadable-20261015T025905Z'), 'utf-8'), BROKEN);
});

test('nothing is kept, and an unreadable gate.json stays as it was, when nothing is written over it', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  writeFileSync(configPath, BROKEN);

  // A placement the change can't make refuses before anything is written.
  assert.throws(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }, { position: { before: 'missing' } }), /no policy named "missing"/);
  // Removing a rule that isn't there writes nothing.
  assert.equal(gate.removePolicy('missing'), false);

  assert.deepEqual(keptFiles(dir), []);
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
});

test('a missing gate.json is written with nothing kept', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir);
  gate.addPolicy({ name: 'ambient', behavior: 'defer' });
  assert.deepEqual(keptFiles(dir), []);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['ambient']);
});

test('a gate.json the gate cannot read at all refuses a change, since there is nothing to keep', {
  skip: NO_CHMOD ? 'needs a file the test user cannot read' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  writeFileSync(configPath, BROKEN);
  chmodSync(configPath, 0o000);
  const thrown = thrownBy(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }));
  chmodSync(configPath, 0o644);

  assert.match(
    thrown,
    /^gate\.json couldn't be read \(EACCES: .*\), so it can't be kept, and nothing was written over it\. Whoever runs this host can make gate\.json readable; until then, a change is refused the same way\.$/,
  );
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
  assert.deepEqual(keptFiles(dir), []);
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentions'], 'the rules in force stay');
});

test('when a copy of the unreadable gate.json cannot be kept, nothing is written, and the rule stays with its pending batch', {
  skip: NO_CHMOD ? 'needs a directory the test user cannot write to' : false,
}, (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, JSON.stringify(QUIET));
  const wakes: string[] = [];
  const gate = new EventGate({
    configPath,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: (agent) => { wakes.push(agent); },
    getAgentNames: () => ['agent'],
    now: () => AT,
  });
  t.after(() => gate.dispose());
  assert.equal(gate.evaluate(INCOMING).trigger, false, 'the event waits in the debounce batch');
  writeFileSync(configPath, BROKEN);
  chmodSync(dir, 0o555);
  const thrown = thrownBy(() => gate.removePolicy('quiet'));
  chmodSync(dir, 0o755);

  assert.match(
    thrown,
    /^gate\.json couldn't be used \(.*\), and keeping a copy of it at .*gate\.json\.unreadable-20261015T025905Z failed \(EACCES: .*\), so nothing was written\.$/,
  );
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
  assert.deepEqual(keptFiles(dir), []);
  const [quiet] = gate.getStatus().policies;
  assert.equal(quiet?.name, 'quiet', 'the rule stays in force');
  assert.equal(quiet?.debounceState?.pendingCount, 1, 'its batch is still pending');
  assert.deepEqual(wakes, [], 'and was not delivered');
});

test('a write that fails after the copy is kept names the copy', {
  skip: NO_CHMOD ? 'needs a file the test user cannot write' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  writeFileSync(configPath, BROKEN);
  chmodSync(configPath, 0o444);
  const thrown = thrownBy(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }));
  chmodSync(configPath, 0o644);

  const keptPath = join(dir, 'gate.json.unreadable-20261015T025905Z');
  // The write's error is a sentence of its own before the copy's.
  assert.match(thrown, new RegExp(`EACCES: permission denied, open '${escaped(configPath)}'\\. A copy of what gate\\.json held when it couldn't be used is kept at ${escaped(keptPath)}\\.$`));
  assert.equal(readFileSync(keptPath, 'utf-8'), BROKEN);
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN, 'the write failed opening gate.json, so it is as it was');
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentions'], 'the rules in force stay');
});

test('a remove whose write fails changes nothing: the rule stays, with its pending debounce batch', {
  skip: NO_CHMOD ? 'needs a file the test user cannot write' : false,
}, (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, JSON.stringify(QUIET));
  const wakes: string[] = [];
  const gate = new EventGate({
    configPath,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: (agent) => { wakes.push(agent); },
    getAgentNames: () => ['agent'],
    now: () => AT,
  });
  t.after(() => gate.dispose());
  assert.equal(gate.evaluate(INCOMING).trigger, false);
  chmodSync(configPath, 0o444);

  const thrown = thrownBy(() => gate.removePolicy('quiet'));
  chmodSync(configPath, 0o644);
  assert.match(thrown, /EACCES/);
  const [quiet] = gate.getStatus().policies;
  assert.equal(quiet?.name, 'quiet', 'the rule stays in force');
  assert.equal(quiet?.debounceState?.pendingCount, 1, 'its batch is still pending');
  assert.deepEqual(wakes, [], 'and was not delivered');
});

test('a new gate.json that a read only looked at, as listPolicyNames does, is still applied by the next reload', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  writeFileSync(configPath, renamedRules('mentionz'));

  assert.deepEqual(gate.listPolicyNames(), ['mentionz'], 'the listing shows the file');
  assert.equal(gate.removePolicy('missing'), false, 'a remove that finds nothing writes nothing');
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentions'], 'neither applied it');
  gate.evaluate(INCOMING);
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentionz'], 'the next reload does');
});

test("gate.json's reload: unchanged text is not applied again, a check within a second is skipped, and a clock stepped back checks at once", (t) => {
  const dir = tempDir(t);
  const traces: Array<{ type: string }> = [];
  const { gate, configPath } = makeGate(dir, { config: RULES, traces });
  const lastCheckAt = (at: number) => { (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = at; };
  const names = () => gate.getStatus().policies.map((p) => p.name);
  const reloads = () => traces.filter((e) => e.type === 'gate:config-reloaded').length;

  writeFileSync(configPath, renamedRules('one'));
  gate.evaluate(INCOMING);
  assert.deepEqual(names(), ['one']);
  assert.equal(reloads(), 1);

  lastCheckAt(0);
  gate.evaluate(INCOMING);
  assert.equal(reloads(), 1, 'the text in force is not applied again');

  lastCheckAt(Date.now());
  writeFileSync(configPath, renamedRules('two'));
  gate.evaluate(INCOMING);
  assert.deepEqual(names(), ['one'], 'within a second of the last check, the file is not read');

  lastCheckAt(Date.now() + 600_000);
  gate.evaluate(INCOMING);
  assert.deepEqual(names(), ['two'], 'a clock stepped back since the last check checks at once');
});

test('gate.json is reloaded when its text changes, whatever its mtime and size', (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'gate.json');
  const second = Math.floor(AT / 1000);
  writeFileSync(configPath, JSON.stringify(RULES));
  utimesSync(configPath, second, second);
  const { gate } = makeGate(dir);

  // New text of the same length, mtime set back: as two writes in one clock tick leave it.
  writeFileSync(configPath, renamedRules('mentionz'));
  utimesSync(configPath, second, second);
  gate.evaluate(INCOMING);
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentionz']);
});

test('a gate.json that could not be read is read again once it can be, though its text and stat are unchanged', {
  skip: NO_CHMOD ? 'needs a file the test user cannot read' : false,
}, (t) => {
  const dir = tempDir(t);
  const traces: Array<{ type: string }> = [];
  const { gate, configPath } = makeGate(dir, { config: RULES, traces });
  chmodSync(configPath, 0o000);
  const names = gate.listPolicyNames();
  const errors = gate.getStatus().errors;
  chmodSync(configPath, 0o644);
  assert.deepEqual(names, ['mentions'], 'the rules in force stay');
  assert.equal(errors.length, 1, JSON.stringify(errors));

  gate.evaluate(INCOMING);
  assert.deepEqual(gate.getStatus().errors, [], 'the reload read it again');
  assert.equal(traces.filter((e) => e.type === 'gate:config-reloaded').length, 0, 'it holds the text in force, so nothing was applied');
});

test('a gate.json that is removed takes its error with it, and the rules in force stay', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  writeFileSync(configPath, BROKEN);
  assert.deepEqual(gate.listPolicyNames(), ['mentions']);
  // Its entry says what's in force instead, so it reads on its own.
  let parsed = '';
  try {
    JSON.parse(BROKEN);
  } catch (err) {
    parsed = (err as Error).message;
  }
  assert.deepEqual(gate.getStatus().errors, [
    `${parsed}. So what gate.json holds isn't in force, and the gate runs the rules of the last gate.json it used.`,
  ]);

  rmSync(configPath);
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'the rules in force stay');
  assert.deepEqual(gate.getStatus().errors, [], 'a missing gate.json is no problem with it');
});

test('a file the gate cannot reach, its directory closed off, is an error rather than a missing file, and what is in force stays', {
  skip: NO_CHMOD ? 'needs a directory the test user cannot search' : false,
}, (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate } = makeGate(dir, { config: RULES, privileged: '["u1"]', now: () => now });
  chmodSync(dir, 0o000);
  now += 2_000;
  const privileged = gate.isPrivilegedUser('u1');
  gate.evaluate(INCOMING);
  const { policies, errors } = gate.getStatus();
  chmodSync(dir, 0o755);

  assert.equal(privileged, true, 'the privileged list that loaded stays');
  assert.deepEqual(policies.map((p) => p.name), ['mentions'], 'the rules in force stay');
  assert.equal(errors.length, 2, JSON.stringify(errors));
  assert.match(errors[0]!, /EACCES/);
  assert.match(errors[1]!, /^Failed to load privileged-users file: EACCES/);
});

test("the start's failure to reconcile gate.json shows beside a gate.json that loads, and stays until the next start", {
  skip: NO_CHMOD ? 'needs a file the test user cannot write' : false,
}, (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, JSON.stringify(RULES));
  chmodSync(configPath, 0o444);
  const initialConfig: GateConfig = {
    ...RULES,
    policies: [...RULES.policies, { name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' }],
  };
  const gate = new EventGate({
    configPath,
    initialConfig,
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
    now: () => AT,
  });
  chmodSync(configPath, 0o644);

  const errors = gate.getStatus().errors;
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0]!, /^At start, the host's starting rules "ambient" couldn't be added to gate\.json \(EACCES[^)]*\), so they weren't put in force\.$/);
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentions'], 'gate.json loaded, without the starting rule it could not add');

  // A spell when gate.json can't be read, then the same text again: nothing new decides the rules, so the error stays.
  chmodSync(configPath, 0o000);
  gate.evaluate(INCOMING);
  const whileUnreadable = gate.getStatus().errors.length;
  chmodSync(configPath, 0o644);
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  gate.evaluate(INCOMING);
  assert.equal(whileUnreadable, 2, "gate.json's own error joins it");
  assert.deepEqual(gate.getStatus().errors, errors, 'the same text read again leaves only the startup\'s error');

  writeFileSync(configPath, JSON.stringify({ ...RULES, default: 'skip' }));
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  gate.evaluate(INCOMING);
  assert.deepEqual(gate.getStatus().errors, errors, "new text decides the rules now, and the start's notice still says what it did");
});

test('an unreadable gate.json read again unchanged is traced and logged once, and again once it fails another way', (t) => {
  const dir = tempDir(t);
  const traces: Array<{ type: string }> = [];
  const { gate, configPath } = makeGate(dir, { config: RULES, traces });
  const logged = t.mock.method(console, 'error', () => {});
  const loadLines = () => logged.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.startsWith(`[gate] ${configPath} couldn't be used (`));
  writeFileSync(configPath, BROKEN);
  for (let i = 0; i < 3; i++) gate.listPolicyNames();
  assert.equal(traces.filter((e) => e.type === 'gate:config-error').length, 1);
  assert.equal(loadLines().length, 1);
  assert.match(loadLines()[0]!, /JSON.*\), so what it holds isn't in force$/);

  writeFileSync(configPath, '[1,');
  for (let i = 0; i < 3; i++) gate.listPolicyNames();
  assert.equal(traces.filter((e) => e.type === 'gate:config-error').length, 2);
  assert.equal(loadLines().length, 2, 'a new error is logged once too');
});

test('a privileged-users file that parses but holds no list is its error, and the last list that loaded stays', (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1"]', now: () => now });
  const check = (id: string) => {
    now += 2_000; // past the reload throttle
    return gate.isPrivilegedUser(id);
  };
  for (const shape of ['{"users": ["u2"]}', '"u2"', '{"userIds": "u2"}', 'null']) {
    writeFileSync(privilegedUsersPath, shape);
    assert.equal(check('u1'), true, `the last list that loaded stays, with ${shape}`);
    assert.equal(gate.isPrivilegedUser('u2'), false);
    assert.deepEqual(
      gate.getStatus().errors,
      ['Failed to load privileged-users file: expected a list of user ids, or {"userIds": [...]}'],
      shape,
    );
  }
  writeFileSync(privilegedUsersPath, '{"userIds": ["u2", 3]}');
  assert.equal(check('u2'), true);
  assert.equal(gate.isPrivilegedUser('3'), true);
  assert.deepEqual(gate.getStatus().errors, []);
});

test('a privileged-users list loads entry by entry: what is not a user id is skipped and named, and a number too large to read exactly is never loaded', (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1"]', now: () => now });
  writeFileSync(privilegedUsersPath, '["u2", "", 12345678901234567890, {"id": "u3"}, 7]');
  now += 2_000;

  assert.equal(gate.isPrivilegedUser('u2'), true);
  assert.equal(gate.isPrivilegedUser('7'), true);
  assert.equal(gate.isPrivilegedUser('u1'), false, "the list is the file's");
  const rounded = String(JSON.parse('12345678901234567890'));
  assert.equal(gate.isPrivilegedUser(rounded), false, 'the rounded number, which could be someone else, is not loaded');
  assert.deepEqual(gate.getStatus().errors, [
    `3 entries in the privileged-users file aren't user ids, so they were skipped: "", ${rounded} (a number this large can't `
    + 'be read exactly: write the id as a string, in quotes), {"id":"u3"}. A user id is a non-empty string, or a safe integer '
    + '(a whole number within 2^53 - 1 of zero); 2 ids did load.',
  ]);
});

test('a skipped privileged-users entry is quoted cut at 39 UTF-16 units, here at 38 rather than split a surrogate pair', (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1"]', now: () => now });
  writeFileSync(privilegedUsersPath, JSON.stringify(['u2', [GRIN.repeat(25)]]));
  now += 2_000;

  assert.equal(gate.isPrivilegedUser('u2'), true);
  // As JSON the entry is 54 units, and its 39th is the first half of the 19th pair, so the quote keeps 38.
  assert.deepEqual(gate.getStatus().errors, [
    `1 entry in the privileged-users file isn't a user id, so it was skipped: ["${GRIN.repeat(18)}…. A user id is a `
    + 'non-empty string, or a safe integer (a whole number within 2^53 - 1 of zero); 1 id did load.',
  ]);
});

test("a privileged-users file that isn't JSON keeps the last list that loaded, with its error once, until it changes", (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1"]', now: () => now });
  const failures = () => gate.getStatus().errors.filter((e) => e.startsWith('Failed to load privileged-users file'));
  const check = (id: string) => {
    now += 2_000; // past the reload throttle
    return gate.isPrivilegedUser(id);
  };

  writeFileSync(privilegedUsersPath, '["u1", ');
  for (let i = 0; i < 5; i++) assert.equal(check('u1'), true, 'the last list that loaded stays in effect');
  assert.equal(failures().length, 1, `one error, not one per call: ${JSON.stringify(gate.getStatus().errors)}`);

  writeFileSync(privilegedUsersPath, '["u1", "u2", ');
  assert.equal(check('u1'), true);
  assert.equal(failures().length, 1, 'a second failed load replaces the first error');

  writeFileSync(privilegedUsersPath, '["u2"]');
  assert.equal(check('u2'), true, 'a changed file is read again');
  assert.equal(gate.isPrivilegedUser('u1'), false);
  assert.deepEqual(failures(), [], 'its error goes once it loads');

  writeFileSync(privilegedUsersPath, '["u2", ');
  assert.equal(check('u2'), true);
  rmSync(privilegedUsersPath);
  assert.equal(check('u2'), false, 'with no file, no one is privileged');
  assert.deepEqual(failures(), [], 'and there is no error');
});

test('the privileged-users file is read at most once a second, and at once after the clock steps back', (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1"]', now: () => now });
  now += 2_000;
  assert.equal(gate.isPrivilegedUser('u1'), true);

  writeFileSync(privilegedUsersPath, '["u2"]');
  now += 500;
  assert.equal(gate.isPrivilegedUser('u2'), false, 'within a second of the last check, the change is not seen yet');
  now += 500;
  assert.equal(gate.isPrivilegedUser('u2'), true, 'a second after it, it is');

  writeFileSync(privilegedUsersPath, '["u3"]');
  now -= 600_000;
  assert.equal(gate.isPrivilegedUser('u3'), true, 'a clock stepped back since the last check checks at once');
});

test('a privileged-users file whose text changes is read again whatever its mtime and size, and a chmod that repairs it is noticed', {
  skip: NO_CHMOD ? 'needs a file the test user cannot read' : false,
}, (t) => {
  const dir = tempDir(t);
  const privilegedUsersPath = join(dir, 'privileged.json');
  const second = Math.floor(AT / 1000); // a whole second, so the mtime set back is exactly the one first read
  writeFileSync(privilegedUsersPath, '["u1"]');
  utimesSync(privilegedUsersPath, second, second);
  let now = AT;
  const { gate } = makeGate(dir, { config: RULES, now: () => now });
  const check = (id: string) => {
    now += 2_000; // past the reload throttle
    return gate.isPrivilegedUser(id);
  };

  // New text, same size, mtime set back: as two writes in one clock tick leave it.
  writeFileSync(privilegedUsersPath, '["u2"]');
  utimesSync(privilegedUsersPath, second, second);
  assert.equal(statSync(privilegedUsersPath).mtimeMs, second * 1000);
  assert.equal(check('u2'), true);

  chmodSync(privilegedUsersPath, 0o000);
  const whileUnreadable = check('u2');
  const errorsWhileUnreadable = gate.getStatus().errors;
  chmodSync(privilegedUsersPath, 0o644);
  assert.equal(whileUnreadable, true, 'the last list that loaded stays');
  assert.equal(errorsWhileUnreadable.length, 1, JSON.stringify(errorsWhileUnreadable));

  // Readable again, with the same text and stat as before: noticed at the next check.
  assert.equal(check('u2'), true);
  assert.deepEqual(gate.getStatus().errors, []);
});

test('while the agent sleeps, a user added to the privileged-users file wakes it once the file is read again, and no one else does', (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1", ""]', now: () => now });
  t.after(() => {
    gate.clearSleep();
    gate.dispose();
  });
  gate.setSleep(600);
  const from = (id: string) => gate.evaluate({ ...INCOMING, tags: ['chat:mention'], metadata: { author: { id } } }).policyName;

  assert.equal(from('u2'), 'asleep');
  assert.equal(from(''), 'asleep', 'an empty id is no one');
  assert.equal(from('u1'), 'mentions', 'a privileged user is let through to the rules');

  writeFileSync(privilegedUsersPath, '["u2"]');
  now += 2_000;
  assert.equal(from('u2'), 'mentions');
  assert.equal(from('u1'), 'asleep');
});

test('gate_status reads both files again before it answers, so a repair shows without any event', async (t) => {
  const dir = tempDir(t);
  let now = AT;
  const { gate, configPath, privilegedUsersPath } = makeGate(dir, { config: RULES, privileged: '["u1", ', now: () => now });
  writeFileSync(configPath, BROKEN);
  const status = async () => (await gate.handleToolCall()).data!;

  assert.equal((await status()).errors.length, 2, 'both files are read, and neither loads');

  writeFileSync(configPath, renamedRules('mentionz'));
  writeFileSync(privilegedUsersPath, '["u1"]');
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  now += 2_000;
  const repaired = await status();
  assert.deepEqual(repaired.errors, []);
  assert.deepEqual(repaired.policies.map((p) => p.name), ['mentionz']);
});

test("a gate.json that won't load and a privileged-users file that won't load each show their own error", (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES, privileged: '{"userIds": [' });
  writeFileSync(configPath, BROKEN);
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'the rules in force stay');

  const errors = gate.getStatus().errors;
  assert.equal(errors.length, 2, JSON.stringify(errors));
  assert.ok(errors[1]!.startsWith('Failed to load privileged-users file'), 'the gate.json load kept the privileged-users error');

  writeFileSync(configPath, JSON.stringify(RULES));
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'gate.json loads again');
  assert.deepEqual(gate.getStatus().errors, [errors[1]], 'and that clears only its own error');
});

test('wake_add_rule and wake_remove_rule tell the agent where the copy of an unreadable gate.json is', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-unreadable-'));
  const configPath = join(dir, 'gate.json');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    modules: [],
    gate: { configPath, config: RULES },
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One turn making `call`, over a gate.json that won't load; the result the model is sent. */
  const callOverUnreadable = async (call: { id: string; name: string; input: Record<string, unknown> }, broken: string) => {
    writeFileSync(configPath, broken);
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', ...call }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    assert.equal(framework.nudgeAgent('scout').ok, true);
    await framework.runUntilIdle();
    const [round] = membrane.lastStream!.receivedToolResults as Array<Array<{ content: string; isError: boolean }>>;
    return round![0]!;
  };
  const added = await callOverUnreadable({ id: 'add', name: 'wake_add_rule', input: { name: 'ambient', behavior: 'defer' } }, BROKEN);
  const removed = await callOverUnreadable({ id: 'remove', name: 'wake_remove_rule', input: { name: 'ambient' } }, `${BROKEN} "again"`);

  const [first, second] = keptFiles(dir);
  assert.ok(first && second, `two kept copies: ${JSON.stringify(keptFiles(dir))}`);
  assert.equal(readFileSync(join(dir, first), 'utf-8'), BROKEN);
  assert.equal(readFileSync(join(dir, second), 'utf-8'), `${BROKEN} "again"`);
  const note = (kept: string) => new RegExp(
    `^gate\\.json couldn't be used \\(.*\\), so a copy of it was kept at ${escaped(join(dir, kept))}, and gate\\.json now holds `
    + 'the rules that were in force, with this change\\. What the copy holds is not in force; whoever runs this host can '
    + 'restore rules from it\\.$',
  );
  assert.equal(added.isError, false);
  assert.match(JSON.parse(added.content).keptUnreadable, note(first));
  assert.equal(removed.isError, false);
  assert.match(JSON.parse(removed.content).keptUnreadable, note(second));
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions']);
});
