/**
 * The gate's files when they can't be read. A wake-rule change starts from the
 * rules in force when gate.json is there but won't load, and it used to write
 * them straight over the file, so whatever the file held, such as an
 * operator's unfinished edit, was lost. Now a change over a gate.json that
 * can't be read or isn't JSON is refused, naming why and what the gate runs
 * meanwhile, and nothing is written over it. Both files are reloaded by their
 * text, and each file's current problem shows once in gate_status.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateConfig, GateEventInfo } from '../src/gate/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

/** 2026-10-15T02:59:05.250Z. */
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
/** JSON.parse's error for `text`, as gate.json's load names it. */
function parseError(text: string): string {
  try {
    JSON.parse(text);
  } catch (err) {
    return (err as Error).message;
  }
  return '(it parsed)';
}
/** A change's refusal over a gate.json that isn't JSON, where the gate runs `runs`. */
const notJson = (error: string, runs = 'the rules of the last gate.json it used'): string =>
  `gate.json isn't JSON the gate can read (${error}), so a change can't edit its rules without writing over what it holds, and `
  + `nothing was saved. Meanwhile the gate runs ${runs}. Until gate.json is JSON, a change is refused the same way.`;

test("a change over a gate.json that isn't JSON is refused, naming the parse error and what runs, and nothing is written over it", (t) => {
  const dir = tempDir(t);
  const traces: Array<{ type: string; [k: string]: unknown }> = [];
  const { gate, configPath } = makeGate(dir, { config: RULES, traces });
  const logged = t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);

  const refused = notJson(parseError(BROKEN));
  assert.throws(() => gate.addPolicy({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' }), { message: refused });
  // A removal is refused the same way, of a rule in force or of any other name, since the file may hold it.
  assert.throws(() => gate.removePolicy('mentions'), { message: refused });
  assert.throws(() => gate.removePolicy('absent'), { message: refused });
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN, 'what gate.json holds stays');
  assert.deepEqual(readdirSync(dir), ['gate.json'], 'and nothing is written beside it');
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'the rules in force stay');
  assert.deepEqual(traces.filter((e) => e.type.startsWith('gate:policy-')), [], 'no change is traced');
  assert.deepEqual(
    logged.mock.calls.map((c) => c.arguments[0]),
    [`[gate] ${configPath} couldn't be used (${parseError(BROKEN)}), so what it holds isn't in force`],
    'the failed load is logged once, though it was read four times',
  );

  // Once gate.json is JSON again, a change is written.
  writeFileSync(configPath, JSON.stringify(RULES));
  gate.addPolicy({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' });
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'ambient']);
});

test('a gate.json that is JSON the gate refuses whole, for a default other than the three, is not written over', (t) => {
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
        + 'got: "sometimes". No change through the gate can bring it into force, so gate.json has to be fixed by an edit of its own; '
        + 'until then, a change is refused the same way.',
    },
  );
  assert.throws(() => gate.removePolicy('quick'), { message: /^Nothing was saved: with this change, gate\.json wouldn't be used\. gate\.json "default" must be/ });
  assert.equal(readFileSync(configPath, 'utf-8'), refused, 'gate.json is as the operator wrote it');
  assert.deepEqual(readdirSync(dir), ['gate.json'], 'nothing is written beside it');
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'the rules in force stay');
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments[0]), [
    `[gate] ${configPath} couldn't be used (gate.json "default" must be "always", "defer", or "skip", got: "sometimes"), so what it holds `
    + 'isn\'t in force',
  ], 'once, though it was read three times');
});

test('a gate.json saved with a BOM loads, so a change edits it, keeping a rule added by hand', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  // UTF-8 with a leading U+FEFF, as some Windows editors save it, holding a rule its operator added by hand.
  const byHand = { name: 'by-hand', match: { tagsAny: ['chat:dm'] }, behavior: 'always' as const };
  writeFileSync(configPath, `\uFEFF${JSON.stringify({ ...RULES, policies: [...RULES.policies, byHand] }, null, 2)}`);

  gate.addPolicy({ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'defer' });
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'by-hand', 'ambient'], 'the rule added by hand stays');
  writeFileSync(configPath, `\uFEFF${readFileSync(configPath, 'utf-8')}`);
  assert.equal(gate.removePolicy('ambient'), true);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'by-hand']);

  assert.deepEqual(readdirSync(dir), ['gate.json']);
  assert.deepEqual(gate.getStatus().errors, []);
});

test("a change over a gate.json that isn't JSON, saved as Latin-1 or as UTF-16, is refused, and the file stays byte for byte", (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  // The failed load's log line quotes JSON.parse's error, which quotes the decoded text: NULs, for UTF-16.
  t.mock.method(console, 'error', () => {});
  // A half-made edit saved as Latin-1, then a file as Windows PowerShell 5's
  // `>` writes one: UTF-16LE, with a byte order mark.
  const latin1 = Buffer.from('{"default": "defer", "policies": [{"name": "caf\u00e9",', 'latin1');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(RULES), 'utf16le')]);
  writeFileSync(configPath, latin1);
  assert.throws(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }), { message: notJson(parseError(latin1.toString('utf-8'))) });
  assert.deepEqual(readFileSync(configPath), latin1);
  writeFileSync(configPath, utf16);
  assert.throws(() => gate.removePolicy('mentions'), { message: notJson(parseError(utf16.toString('utf-8'))) });
  assert.deepEqual(readFileSync(configPath), utf16);

  assert.deepEqual(readdirSync(dir), ['gate.json']);
  assert.deepEqual(gate.listPolicyNames(), ['mentions']);
});

test("over a gate.json that isn't JSON, a change is refused before an anchor or a name is looked for, since the file's own rules can't be read", (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);

  // Not "no policy named": the operator's half-made rule may be the anchor.
  assert.throws(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }, { position: { before: 'half-made' } }), { message: notJson(parseError(BROKEN)) });
  // Not false: the file may hold the rule.
  assert.throws(() => gate.removePolicy('half-made'), { message: notJson(parseError(BROKEN)) });
  // A name that isn't a non-empty string names no rule in any file.
  assert.equal(gate.removePolicy(''), false);

  assert.deepEqual(readdirSync(dir), ['gate.json']);
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
});

test('a missing gate.json is written', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir);
  gate.addPolicy({ name: 'ambient', behavior: 'defer' });
  assert.deepEqual(readdirSync(dir), ['gate.json']);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['ambient']);
});

test('a gate.json the gate cannot read at all refuses a change, naming what runs', {
  skip: NO_CHMOD ? 'needs a file the test user cannot read' : false,
}, (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  writeFileSync(configPath, BROKEN);
  chmodSync(configPath, 0o000);
  const thrown = thrownBy(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }));
  chmodSync(configPath, 0o644);

  assert.match(
    thrown,
    /^gate\.json couldn't be read \(EACCES: .*\), so a change can't edit it, and nothing was written over it\. Meanwhile the gate runs the rules of the last gate\.json it used\. Whoever runs this host can make gate\.json readable; until then, a change is refused the same way\.$/,
  );
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
  assert.deepEqual(readdirSync(dir), ['gate.json']);
  assert.deepEqual(gate.getStatus().policies.map((p) => p.name), ['mentions'], 'the rules in force stay');
});

test('a directory at gate.json\'s path is a gate.json the gate cannot read, so a change is refused', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { config: RULES });
  t.mock.method(console, 'error', () => {});
  rmSync(configPath);
  mkdirSync(configPath);
  assert.throws(() => gate.addPolicy({ name: 'ambient', behavior: 'defer' }), {
    message: /^gate\.json couldn't be read \(EISDIR: [^)]*\), so a change can't edit it, and nothing was written over it\. Meanwhile the gate runs the rules of the last gate\.json it used\. Whoever runs this host can make gate\.json readable; until then, a change is refused the same way\.$/,
  });
  assert.ok(statSync(configPath).isDirectory(), 'nothing was written in its place');
  assert.deepEqual(gate.listPolicyNames(), ['mentions'], 'the rules in force stay');
});

test("a change writes through a symlinked gate.json to its file, which keeps its mode", {
  skip: process.platform === 'win32' ? 'needs a symlink' : false,
}, (t) => {
  const dir = tempDir(t);
  const target = join(dir, 'real-gate.json');
  writeFileSync(target, JSON.stringify(RULES));
  chmodSync(target, 0o640);
  const configPath = join(dir, 'gate.json');
  symlinkSync(target, configPath);
  const { gate } = makeGate(dir);

  gate.addPolicy({ name: 'ambient', behavior: 'defer' });

  assert.ok(lstatSync(configPath).isSymbolicLink(), 'gate.json is still the link');
  assert.equal(statSync(target).mode & 0o777, 0o640, 'its file keeps its mode');
  assert.deepEqual(onDisk(target).policies.map((p) => p.name), ['mentions', 'ambient'], 'and holds the change');
});

test("a removal refused over a gate.json that isn't JSON leaves the rule in force, with its pending batch", (t) => {
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
  t.mock.method(console, 'error', () => {});
  assert.equal(gate.evaluate(INCOMING).trigger, false, 'the event waits in the debounce batch');
  writeFileSync(configPath, BROKEN);

  assert.throws(() => gate.removePolicy('quiet'), { message: notJson(parseError(BROKEN)) });
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
  const [quiet] = gate.getStatus().policies;
  assert.equal(quiet?.name, 'quiet', 'the rule stays in force');
  assert.equal(quiet?.debounceState?.pendingCount, 1, 'its batch is still pending');
  assert.deepEqual(wakes, [], 'and was not delivered');
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
  // The reload's throttle reads Date.now(): pinned, so a slow write can't carry a check past its second.
  const clock = Date.now() + 10_000;
  t.mock.method(Date, 'now', () => clock);

  writeFileSync(configPath, renamedRules('one'));
  gate.evaluate(INCOMING);
  assert.deepEqual(names(), ['one']);
  assert.equal(reloads(), 1);

  lastCheckAt(0);
  gate.evaluate(INCOMING);
  assert.equal(reloads(), 1, 'the text in force is not applied again');

  lastCheckAt(clock);
  writeFileSync(configPath, renamedRules('two'));
  gate.evaluate(INCOMING);
  assert.deepEqual(names(), ['one'], 'within a second of the last check, the file is not read');

  lastCheckAt(clock + 600_000);
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
  assert.match(errors[0]!, /^At start, the host's starting rules "ambient" couldn't be added to gate\.json \(EACCES[^)]*\), so they weren't put in force\. Whoever runs this host can fix what kept them from being written\.$/);
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

test("wake_add_rule and wake_remove_rule over a gate.json that isn't JSON tell the agent why nothing was saved, and what runs", async (t) => {
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
  t.mock.method(console, 'error', () => {});

  /** One turn making `call`, over a gate.json that isn't JSON; the result the model is sent. */
  const callOverBroken = async (call: { id: string; name: string; input: Record<string, unknown> }) => {
    writeFileSync(configPath, BROKEN);
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', ...call }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    assert.equal(framework.nudgeAgent('scout').ok, true);
    await framework.runUntilIdle();
    const [round] = membrane.lastStream!.receivedToolResults as Array<Array<{ content: string; isError: boolean }>>;
    return round![0]!;
  };
  const added = await callOverBroken({ id: 'add', name: 'wake_add_rule', input: { name: 'ambient', behavior: 'defer' } });
  const removed = await callOverBroken({ id: 'remove', name: 'wake_remove_rule', input: { name: 'mentions' } });

  for (const result of [added, removed]) {
    assert.equal(result.isError, true);
    assert.equal(result.content, notJson(parseError(BROKEN)));
  }
  assert.equal(readFileSync(configPath, 'utf-8'), BROKEN);
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('gate.json')), ['gate.json']);
});
