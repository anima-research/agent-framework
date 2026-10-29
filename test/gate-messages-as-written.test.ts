import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { EventGate, formatShadowWarning } from '../src/gate/event-gate.js';
import type { GateConfig } from '../src/gate/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const RULES: GateConfig = {
  default: 'always',
  policies: [{ name: 'mentions', match: { tagsAny: ['chat:addressed'] }, behavior: 'always' }],
};
const CONTROL = /[\u0000-\u001f\u0085\u2028\u2029]/;
const ESCAPED_TWICE = /\\\\u/;
const UTF16 = Buffer.from(`\ufeff${JSON.stringify(RULES)}`, 'utf16le');

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-as-written-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeGate(dir: string, privileged?: string | Buffer, traces: Array<{ type: string; error?: string }> = []) {
  const configPath = join(dir, 'gate.json');
  const privilegedUsersPath = join(dir, 'privileged.json');
  if (privileged !== undefined) writeFileSync(privilegedUsersPath, privileged);
  const gate = new EventGate({
    configPath,
    privilegedUsersPath,
    emitTrace: (event) => { traces.push(event as { type: string; error?: string }); },
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
  return { gate, configPath, privilegedUsersPath };
}

async function agent(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-as-written-'));
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    modules: [],
    gate: { configPath: join(dir, 'gate.json'), config: RULES },
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = async (input: Record<string, unknown>, tool = 'wake_add_rule'): Promise<{ isError: boolean; text: string }> => {
    const sent = tool === 'wake_add_rule' ? { name: 'watch', ...input } : input;
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'call', name: tool, input: sent }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    framework.nudgeAgent('scout');
    await framework.runUntilIdle();
    const results = membrane.lastStream!.receivedToolResults;
    const { content, isError } = results[results.length - 1]![0] as { content: unknown; isError?: boolean };
    return { isError: isError === true, text: typeof content === 'string' ? content : JSON.stringify(content) };
  };
  const refusal = async (input: Record<string, unknown>, tool?: string): Promise<string> => {
    const { isError, text } = await call(input, tool);
    assert.ok(isError, text);
    return text;
  };
  return { call, refusal, dir };
}

function assertParts(text: string, parts: { notDone: RegExp; field: RegExp; next: RegExp }): void {
  assert.match(text, parts.notDone, 'it says what didn\'t happen');
  assert.match(text, parts.field, 'it names the field as the caller wrote it');
  assert.match(text, parts.next, 'it says what to do');
}

test("wake_add_rule's refusals name the parameters the agent sent, not gate.json's fields", async (t) => {
  const { call } = await agent(t);
  const cases: Array<[Record<string, unknown>, RegExp, RegExp, RegExp]> = [
    [{ debounceMs: 50 }, /^Rule "watch" wasn't saved: debounceMs is 50 ms/, /100 ms minimum/, /behavior\.debounce/],
    [{ debounceMs: 400000 }, /debounceMs is 400000 ms/, /300000 ms maximum/, /behavior\.debounce/],
    [{ rateLimit: { tokens: 0, refillIntervalMs: 1000 } }, /rateLimit\.tokens is 0/, /a positive number is needed/, /behavior\.rate_limit/],
    [{ rateLimit: 5 }, /rateLimit is 5/, /such as \{"tokens": 3/, /behavior\.rate_limit/],
    [{ passiveSample: { every: 0 } }, /passiveSample\.every is 0/, /under 1/, /behavior\.passive_sample/],
    [{ passiveSample: { every: 2, keyby: 'channelId' } }, /passiveSample has "keyby"/, /did you mean "keyBy"/, /behavior\.passive_sample/],
  ];
  for (const [input, field, next, gateName] of cases) {
    const { isError, text } = await call(input);
    assert.ok(isError, JSON.stringify(input));
    assertParts(text, { notDone: /wasn't saved/, field, next });
    assert.doesNotMatch(text, gateName, `${JSON.stringify(input)} names no field the agent didn't write`);
  }
  const asFile = await call({ behavior: { debounce: 50 } });
  assertParts(asFile.text, { notDone: /wasn't saved/, field: /behavior\.debounce is 50 ms/, next: /100 ms minimum/ });
  assert.doesNotMatch(asFile.text, /debounceMs/);
});

test('a passthrough the behavior can\'t use names both as the caller wrote them, and to leave it out', async (t) => {
  const { refusal } = await agent(t);
  const debounced = await refusal({ debounceMs: 60000, passthrough: true });
  assertParts(debounced, {
    notDone: /wasn't saved/, field: /passthrough is true, .*rateLimit or passiveSample.*with debounceMs/, next: /leave passthrough out/,
  });
  assert.doesNotMatch(debounced, /debounce:60000|rate_limit|passive_sample/);
  const always = await refusal({ behavior: 'always', passthrough: true });
  assertParts(always, { notDone: /wasn't saved/, field: /with behavior "always"/, next: /leave passthrough out/ });

  const gate = makeGate(tempDir(t)).gate;
  const inFile = (() => {
    try {
      gate.addPolicy({ name: 'r', behavior: { debounce: 60000 }, passthrough: true });
    } catch (err) {
      return (err as Error).message;
    }
    return '(saved)';
  })();
  assertParts(inFile, {
    notDone: /wasn't saved/, field: /behavior\.rate_limit or behavior\.passive_sample.*with behavior\.debounce/, next: /leave passthrough out/,
  });
});

test('a placement that names no rule says nothing was saved, names insertBefore or insertAfter, and the way on', async (t) => {
  const { call } = await agent(t);
  for (const field of ['insertBefore', 'insertAfter']) {
    const { isError, text } = await call({ behavior: 'defer', [field]: 'missing' });
    assert.ok(isError);
    assertParts(text, {
      notDone: /^Rule "watch" wasn't saved/,
      field: new RegExp(`${field} is "missing", and no rule has that name`),
      next: new RegExp(`The other rules are "mentions"\\. Give ${field} one of those, or leave it out to add the rule at the end`),
    });
    assert.doesNotMatch(text, /addPolicy|anchor|position/);
  }
  const alone = await call({ name: 'mentions', behavior: 'defer', insertAfter: 'missing' });
  assertParts(alone.text, { notDone: /wasn't saved/, field: /insertAfter is "missing"/, next: /There are no other rules, so leave insertAfter out/ });
});

test("a placement naming the rule being saved, or one that isn't a rule's name, says nothing was saved and the way on", async (t) => {
  const { call } = await agent(t);
  const itself = await call({ name: 'mentions', behavior: 'defer', insertBefore: 'mentions' });
  assert.ok(itself.isError);
  assertParts(itself.text, {
    notDone: /^Rule "mentions" wasn't saved/,
    field: /insertBefore is "mentions", the rule being saved, and a rule can't be placed beside itself/,
    next: /There are no other rules, so leave insertBefore out to replace the rule where it is\./,
  });

  for (const field of ['insertBefore', 'insertAfter']) {
    const { isError, text } = await call({ behavior: 'defer', [field]: 3 });
    assert.ok(isError);
    assertParts(text, {
      notDone: /nothing was saved/,
      field: new RegExp(`${field} must be the name of a rule, and it's 3`),
      next: new RegExp(`The rules are "mentions"\\. Give ${field} one of them, or leave it out to add the rule at the end`),
    });
  }
});

test("the wake-rule tools' own refusals say nothing was saved or removed, with the parameters as sent", async (t) => {
  const { refusal } = await agent(t);
  assertParts(await refusal({}), {
    notDone: /nothing was saved/, field: /got no behavior/, next: /Give one of behavior \("always", "defer" or "skip"\), debounceMs, rateLimit, passiveSample or judge\./,
  });
  assertParts(await refusal({ debounceMs: 60000, rateLimit: { tokens: 1, refillIntervalMs: 1000 } }), {
    notDone: /nothing was saved/, field: /more than one behavior \(debounceMs, rateLimit\)/, next: /Give only one of them/,
  });
  assertParts(await refusal({ behavior: 'defer', position: 'prepend', insertBefore: 'mentions' }), {
    notDone: /nothing was saved/, field: /more than one placement \(position, insertBefore\)/, next: /Give only one of them/,
  });
  assertParts(await refusal({}, 'wake_remove_rule'), {
    notDone: /nothing was removed/, field: /name is missing/, next: /the name of a rule is needed, so nothing was removed\. The rules are "mentions"\./,
  });
});

test('a regular expression the gate can\'t read is refused with the way on', async (t) => {
  const { refusal } = await agent(t);
  assertParts(await refusal({ behavior: 'defer', match: { filter: { type: 'regex', pattern: '(' } } }), {
    notDone: /wasn't saved/,
    field: /match\.filter\.pattern isn't a regular expression the gate can read/,
    next: /fix it, or give match\.filter\.type "text"/,
  });
});

test('what an agent reads calls a rule a rule', async (t) => {
  const { call } = await agent(t);
  for (const input of [{ debounceMs: 50 }, { name: '', behavior: 'defer' }, { behavior: 'defer', insertBefore: 'missing' }]) {
    const { text } = await call(input);
    assert.doesNotMatch(text, /\bpolicy\b/i, JSON.stringify(input));
  }
  const dir = tempDir(t);
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ policies: [{ name: 'quiet', behavior: { debounce: 'soon' } }, { behavior: 'skip' }] }));
  const { gate } = makeGate(dir);
  const errors = gate.getStatus().errors.join(' ');
  assert.match(errors, /Rule "quiet" is left out/);
  assert.match(errors, /The 2nd rule is left out/);
  assert.doesNotMatch(errors, /\bpolicy\b/i);
});

test("gate.json that won't load names gate.json and its path, what runs meanwhile, and what makes it load", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'gate.json'), JSON.stringify(RULES));
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const later = () => t.mock.timers.tick(2000);
  const { gate, configPath } = makeGate(dir);
  t.mock.method(console, 'error', () => {});
  const at = configPath.replace(/[.\\]/g, '\\$&');
  const errorAfter = (text: string): string => {
    writeFileSync(configPath, text);
    later();
    gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags: [] });
    return gate.getStatus().errors[0]!;
  };
  const notJson = errorAfter('{"policies": [');
  assertParts(notJson, {
    notDone: /So what gate\.json holds isn't in force, and the gate runs the rules of the last gate\.json it used\./,
    field: new RegExp(`^gate\\.json, at ${at}, isn't JSON: "`),
    next: /Once it's JSON, the gate reads it again/,
  });

  rmSync(configPath);
  mkdirSync(configPath);
  later();
  gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags: [] });
  const unreadable = gate.getStatus().errors[0]!;
  assertParts(unreadable, {
    notDone: /So what gate\.json holds isn't in force/,
    field: /^gate\.json, at .*gate\.json, can't be read: "EISDIR/,
    next: /Whoever runs this host can make it a file the gate can read/,
  });
});

test("the [gate] line and a refused change name what to do over a gate.json that isn't JSON, and the change names its path", (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'gate.json'), JSON.stringify(RULES));
  const { gate, configPath } = makeGate(dir);
  const logged = t.mock.method(console, 'error', () => {});
  const at = configPath.replace(/[.\\]/g, '\\$&');
  writeFileSync(configPath, '{"policies": [');
  const thrown = (() => {
    try {
      gate.addPolicy({ name: 'r', behavior: 'defer' });
    } catch (err) {
      return (err as Error).message;
    }
    return '(saved)';
  })();
  const line = String(logged.mock.calls.at(-1)!.arguments[0]);
  assertParts(line, { notDone: /so what it holds isn't in force/, field: /^\[gate\] .*gate\.json couldn't be used \("/, next: /Once it's JSON, the gate reads it again/ });
  assertParts(thrown, { notDone: /nothing was saved/, field: new RegExp(`^gate\\.json, at ${at}, isn't JSON the gate can read`), next: /Until gate\.json is JSON/ });
});

test('a gate.json the gate refuses names its path, what runs meanwhile, and that a mended file is read again', (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'gate.json'), JSON.stringify({ default: 'wake' }));
  const { gate, configPath } = makeGate(dir);
  t.mock.method(console, 'error', () => {});
  const at = configPath.replace(/[.\\]/g, '\\$&');
  const refused = gate.getStatus().errors[0]!;
  assertParts(refused, {
    notDone: /So what gate\.json holds isn't in force/,
    field: new RegExp(`^gate\\.json, at ${at}, "default" must be "always", "defer", or "skip", got: "wake"`),
    next: /Once gate\.json is mended, the gate reads it again at its next check for changes\./,
  });
});

test('the privileged-users file says its path, who is privileged meanwhile, and what to do', (t) => {
  const dir = tempDir(t);
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const later = () => t.mock.timers.tick(2000);
  const { gate, privilegedUsersPath } = makeGate(dir, '{"userIds": [');
  const atStart = gate.getStatus().errors.find((e) => e.includes('privileged-users'))!;
  assertParts(atStart, {
    notDone: /so no one is privileged/,
    field: new RegExp(`^The privileged-users file, at ${privilegedUsersPath.replace(/[.\\]/g, '\\$&')}, isn't JSON: "`),
    next: /Once it holds a list of user ids, the gate loads it.*Replacing it with a file holding \[\], or removing it, makes no one privileged at the gate's next check for changes\./,
  });

  const current = (): string => {
    later();
    gate.isPrivilegedUser('u1');
    return gate.getStatus().errors.find((e) => e.includes('privileged-users')) ?? '(none)';
  };
  const errorAfter = (text: string): string => {
    writeFileSync(privilegedUsersPath, text);
    return current();
  };
  assert.equal(errorAfter('["u1", "u2"]'), '(none)');
  const broken = errorAfter('["u1"');
  assertParts(broken, {
    notDone: /so the 2 ids of the list that last loaded stay privileged/, field: /isn't JSON/, next: /Replacing it with a file holding \[\], or removing it/,
  });
  assert.ok(gate.isPrivilegedUser('u1'), 'as they do');
  const noList = errorAfter('{"users": ["u1"]}');
  assertParts(noList, { notDone: /stay privileged/, field: /holds no list of user ids/, next: /Once it holds a list of user ids/ });

  rmSync(privilegedUsersPath);
  mkdirSync(privilegedUsersPath);
  assertParts(current(), {
    notDone: /the 2 ids of the list that last loaded stay privileged/,
    field: /can't be read: "EISDIR/,
    next: /Whoever runs this host can make it a file the gate can read.*Replacing it with a file holding \[\], or removing it/,
  });
});

test("a privileged-users list with an entry that isn't a user id says which ids are privileged, and that the file is read again once it is", (t) => {
  const { gate, privilegedUsersPath } = makeGate(tempDir(t), '["u1", {"id": 2}]');
  const skipped = gate.getStatus().errors.find((e) => e.includes('privileged-users'))!;
  assertParts(skipped, {
    notDone: /the one id that did load is privileged/,
    field: new RegExp(`^1 entry in the privileged-users file, at ${privilegedUsersPath.replace(/[.\\]/g, '\\$&')}, isn't a user id`),
    next: /Once it is a user id, the gate reads the file again at its next check for changes\./,
  });
  assert.ok(gate.isPrivilegedUser('u1') && !gate.isPrivilegedUser('2'), 'as it is');
});

test("text from either file reaches the agent, gate_status and the log with its control characters escaped", async (t) => {
  const { call, dir } = await agent(t);
  const logged = t.mock.method(console, 'error', () => {});
  writeFileSync(join(dir, 'gate.json'), UTF16);
  const refused = (await call({ behavior: 'defer' })).text;
  assert.match(refused, /nothing was saved/);
  assert.doesNotMatch(refused, CONTROL, 'the refusal the agent gets');
  assert.match(refused, /\\u0000/, 'its NULs written as escapes');
  assert.doesNotMatch(refused, ESCAPED_TWICE, 'once');

  const files = tempDir(t);
  writeFileSync(join(files, 'gate.json'), UTF16);
  const { gate } = makeGate(files, Buffer.from('\ufeff["u1"]', 'utf16le'));
  const errors = gate.getStatus().errors;
  assert.equal(errors.length >= 2, true);
  for (const error of errors) {
    assert.doesNotMatch(error, CONTROL, error);
    assert.doesNotMatch(error, ESCAPED_TWICE, error);
  }
  assert.ok(errors.some((e) => e.startsWith('gate.json, at ') && e.includes('\\u0000')));
  assert.ok(errors.some((e) => e.startsWith('The privileged-users file, at ') && e.includes('\\u0000')));
  const lines = logged.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.startsWith('[gate]'));
  assert.ok(lines.some((line) => line.includes('\\u0000')), 'the [gate] line');
  for (const line of lines) assert.doesNotMatch(line, CONTROL, line);

  const named = tempDir(t);
  writeFileSync(join(named, 'gate.json'), JSON.stringify({
    policies: [{ name: 'a\u0007b', match: { 'wh\u0000y': 1, source: 5 }, behavior: 'always' }, { name: 'c', match: { channel: ['x\u2028y'] } }],
  }));
  const notes = makeGate(named).gate.getStatus().errors.join(' ');
  assert.doesNotMatch(notes, CONTROL, notes);
  assert.match(notes, /Rule "a\\u0007b"/);
  assert.match(notes, /"wh\\u0000y"/);
  assert.match(notes, /\\u2028/);
});

test("the gate:config-error trace and a shadow warning carry supplied text escaped once", (t) => {
  t.mock.method(console, 'error', () => {});
  const files = tempDir(t);
  writeFileSync(join(files, 'gate.json'), UTF16);
  const traces: Array<{ type: string; error?: string }> = [];
  makeGate(files, undefined, traces);
  const configErrors = traces.filter((trace) => trace.type === 'gate:config-error');
  assert.ok(configErrors.length > 0, 'gate.json\'s error is traced');
  for (const { error } of configErrors) {
    assert.match(error!, /\\u0000/);
    assert.doesNotMatch(error!, CONTROL, error);
    assert.doesNotMatch(error!, ESCAPED_TWICE, error);
  }

  const shadow = formatShadowWarning({ earlier: 'a', later: 'b', eventTypes: ['t\u0000y'], whole: false, known: true });
  assert.doesNotMatch(shadow, CONTROL, shadow);
  assert.match(shadow, /takes "b"'s t\\u0000y events/);
});
