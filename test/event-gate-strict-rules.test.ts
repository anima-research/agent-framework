/**
 * Every problem a wake rule has is named. A behavior the gate doesn't know was
 * saved as "always"; a match field of the wrong type was dropped, widening the
 * rule; a field name one slip from one the gate reads, or a field it reads at
 * another level, was ignored, so the field meant was missing. gate.json and
 * the host's starting rules are what a deployment runs, so there a rule with a
 * problem is read the way earlier releases read it, and named, and no event
 * that woke the agent goes quiet; a rule they refused is left out, and the
 * rest loads, unless under a default that holds events back it leaves out a
 * rule that could wake the agent. addPolicy, behind wake_add_rule, refuses any
 * problem, since its caller is there to fix it. A field name near none the
 * gate reads, and read nowhere, changes nothing, so it loads, and is named.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentFramework } from '../src/index.js';
import { EventGate } from '../src/gate/event-gate.js';
import type { GateBehavior, GateConfig, GateEventInfo, GatePolicy } from '../src/gate/types.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-strict-'));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeGate(dir: string, opts: { file?: unknown; initialConfig?: unknown } = {}) {
  const configPath = join(dir, 'gate.json');
  if (opts.file !== undefined) {
    writeFileSync(configPath, typeof opts.file === 'string' ? opts.file : JSON.stringify(opts.file));
  }
  const gate = new EventGate({
    configPath,
    ...(opts.initialConfig !== undefined ? { initialConfig: opts.initialConfig as GateConfig } : {}),
    emitTrace: () => {},
    addMessage: () => '',
    requestInference: () => {},
    getAgentNames: () => ['agent'],
  });
  return { gate, configPath };
}

const onDisk = (path: string): GateConfig & Record<string, unknown> => JSON.parse(readFileSync(path, 'utf-8')) as GateConfig & Record<string, unknown>;
const names = (gate: EventGate): string[] => gate.getStatus().policies.map((p) => p.name);
const behaviors = (gate: EventGate): GateBehavior[] => gate.getStatus().policies.map((p) => p.behavior);
/** A rule of `fields` added through addPolicy: the refusal's message, or null when it was saved. */
const refusal = (gate: EventGate, fields: Record<string, unknown>): string | null => {
  try {
    gate.addPolicy({ name: 'r', ...fields });
    return null;
  } catch (err) {
    return (err as Error).message;
  }
};
const permissionsHold = process.platform !== 'win32' && process.getuid?.() !== 0;

const BEHAVIORS = '"always", "defer" or "skip", or an object holding one of "debounce", "rate_limit", "passive_sample" and "judge"';
/** A character outside the Basic Multilingual Plane: one code point, two UTF-16 units. */
const GRIN = '\u{1F600}';
const POLICY_FIELDS = '"name", "match", "behavior", "resets" and "passthrough"';
const MATCH_FIELDS = '"scope", "source", "channel", "mount", "pathGlob", "tagsAny", "tagsAll", "tagsNone", "metadataTrue" and "filter"';
const MENTIONS = { name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' };
const event = (tags: string[], eventType = 'mcpl:channel-incoming'): GateEventInfo =>
  ({ content: 'release notes', eventType, serverId: 'discord', channelId: 'c1', tags });
const MENTION = event(['chat:mention']);
/** gate_status's entry for a gate.json that isn't used: its error, with what's in force instead. */
const unused = (configPath: string, error: string, runs: string): string =>
  `gate.json, at ${configPath},${error.slice('gate.json'.length)}${/[.?!]$/.test(error) ? '' : '.'} So what gate.json holds isn't in force, `
  + `and the gate runs ${runs}. Once gate.json is mended, the gate reads it again at its next check for changes.`;
const notJsonShown = (configPath: string, parsed: string, runs: string): string =>
  `gate.json, at ${configPath}, isn't JSON: ${JSON.stringify(parsed)}. So what gate.json holds isn't in force, and the gate runs ${runs}. `
  + "Once it's JSON, the gate reads it again at its next check for changes.";
const RUNS_DEFAULT = 'no rules: every event gets the default, "always"';
const RUNS_LAST = 'the rules of the last gate.json it used';
/** What a rule whose match is left with nothing that narrows it says, once something in the match was named. */
const everyEvent = (where: string): string => `${where}: nothing left in match narrows the rule, so it matches every event.`;
/** The same in a refusal, of the rule read as earlier releases read it, since that's why what's wrong in its match matters. */
const everyEventIfSaved = (): string => "Read without what's wrong in its match, as earlier releases read it, the rule would match every event.";

test('addPolicy refuses a rule with any problem, naming every one, and saves nothing', (t) => {
  const { gate, configPath } = makeGate(tempDir(t));
  const all = ` ${everyEventIfSaved()}`;
  const cases: Array<[Record<string, unknown>, string | RegExp, string?]> = [
    // A behavior the gate doesn't know was saved as "always".
    [{ behavior: 'deffer' }, `behavior is "deffer", where ${BEHAVIORS} is needed`],
    [{ behavior: '{"debounce": 60000}' }, `behavior is "{\\"debounce\\": 60000}", where ${BEHAVIORS} is needed`],
    [{ behavior: 42 }, `behavior is 42, where ${BEHAVIORS} is needed`],
    [{ behavior: ['always'] }, `behavior is ["always"], where ${BEHAVIORS} is needed`],
    // A long value is quoted to 77 UTF-16 units: after `"a`, the 77th is the first half of the 38th pair, so one fewer.
    [{ behavior: `a${GRIN.repeat(50)}` }, `behavior is "a${GRIN.repeat(37)}..., where ${BEHAVIORS} is needed`],
    [{ behavior: { debounce: 1000, rate_limit: { tokens: 1, refillIntervalMs: 1000 } } }, 'behavior holds "debounce" and "rate_limit", and a rule has one behavior'],
    // NaN passes every comparison of a range check, and JSON writes it as null.
    [{ behavior: { debounce: NaN } }, 'behavior.debounce is NaN, where a number of milliseconds is needed, such as 60000'],
    [{ behavior: { debounce: '60000' } }, 'behavior.debounce is "60000", where a number of milliseconds is needed, such as 60000'],
    [{ behavior: { debounce: 50 } }, 'behavior.debounce is 50 ms, under the 100 ms minimum'],
    [{ behavior: { debounce: 0 } }, 'behavior.debounce is 0 ms, under the 100 ms minimum'],
    [{ behavior: { debounce: 500000 } }, 'behavior.debounce is 500000 ms, over the 300000 ms maximum'],
    [{ behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } } }, 'behavior.rate_limit.tokens is 0, where a positive number is needed'],
    [{ behavior: { rate_limit: { tokens: 1, refillIntervalMs: 0 } } }, 'behavior.rate_limit.refillIntervalMs is 0, where a positive number of milliseconds is needed'],
    [{ behavior: { rate_limit: { tokens: 1, refillIntervalMs: -1000 } } }, 'behavior.rate_limit.refillIntervalMs is -1000, where a positive number of milliseconds is needed'],
    [{ behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000, keyBy: 3 } } }, 'behavior.rate_limit.keyBy is 3, where a field name is needed, such as "channelId"'],
    [{ behavior: { passive_sample: { every: 0 } } }, 'behavior.passive_sample.every is 0, under 1'],
    [{ behavior: { passive_sample: { every: 2.5 } } }, 'behavior.passive_sample.every is 2.5, not a whole number'],
    // A match field of the wrong type, or an entry of one in a list, was dropped, widening the rule:
    // left with nothing that narrows it, the rule matches every event, and says so.
    [{ match: 'discord' }, 'match is "discord", where an object is needed, such as {"source": "discord"}'],
    [{ match: { scope: 'mcpl:channel-incoming' } }, 'match.scope is "mcpl:channel-incoming", where a list of event types is needed, such as ["mcpl:channel-incoming"]', all],
    [{ match: { scope: [''] } }, 'match.scope holds "", and no event\'s type is ""'],
    [{ match: { tagsAny: 'chat:ambient' } }, 'match.tagsAny is "chat:ambient", where a list of non-empty strings is needed, such as ["chat:ambient"]', all],
    [{ match: { tagsAll: [3] } }, 'match.tagsAll holds 3, where each entry is a non-empty string', all],
    [{ match: { tagsNone: [''] } }, 'match.tagsNone holds "", where each entry is a non-empty string', all],
    [{ match: { metadataTrue: 'mentioned' } }, 'match.metadataTrue is "mentioned", where a list of non-empty strings is needed, such as ["mentioned"]', all],
    [{ match: { source: 3 } }, 'match.source is 3, where a string is needed, such as "discord"', all],
    [{ match: { channel: 12345 } }, 'match.channel is 12345, where a string is needed, such as "discord:*:12345"', all],
    [{ match: { mount: [] } }, 'match.mount is [], where a string is needed, such as "project"', all],
    [{ match: { filter: 'release' } }, 'match.filter is "release", where an object is needed, such as {"type": "text", "pattern": "release"}', all],
    [{ match: { filter: { type: 'glob', pattern: 'release*' } } }, 'match.filter.type is "glob", where "text" or "regex" is needed', all],
    [{ match: { filter: { type: 'text' } } }, 'match.filter.pattern is missing, where the text or regular expression to look for is needed', all],
    [{ match: { filter: { type: 'regex', pattern: '(' } } }, /^match\.filter\.pattern isn't a regular expression the gate can read \("Invalid regular expression: .+"\), so fix it, or give match\.filter\.type "text" to look for the pattern as plain text$/],
    [{ resets: 'other-rule' }, 'resets is "other-rule", where a list of rule names is needed, such as ["other-rule"]'],
    [{ resets: ['other-rule', ''] }, 'resets holds "", where each entry is a rule\'s name'],
    [{ behavior: { passive_sample: { every: 3 } }, passthrough: 'true' }, 'passthrough is "true", where true or false is needed'],
    [{ behavior: 'always', passthrough: true }, 'passthrough is true, and only a behavior.rate_limit or behavior.passive_sample rule passes on an event it matches without waking on it; with behavior "always", leave passthrough out'],
  ];
  for (const [fields, problem, also] of cases) {
    const message = refusal(gate, fields) ?? 'saved';
    if (typeof problem === 'string') assert.equal(message, `Rule "r" wasn't saved: ${problem}.${also ?? ''}`, JSON.stringify(fields));
    else assert.match(message.replace(/^Rule "r" wasn't saved: /, '').replace(/\.$/, ''), problem, JSON.stringify(fields));
  }
  // Every problem is named, not only the first, with the fields that do nothing.
  assert.equal(
    refusal(gate, { match: { tagsAny: 'x', scope: [''] }, behavior: { debounce: 50 }, comment: 'c' }),
    'Rule "r" wasn\'t saved: behavior.debounce is 50 ms, under the 100 ms minimum; match.scope holds "", and no event\'s type is ""; '
    + 'match.tagsAny is "x", where a list of non-empty strings is needed, such as ["chat:ambient"]. '
    + `Rule "r" has "comment", which the gate doesn't read, so it does nothing. Its fields are ${POLICY_FIELDS}.`,
  );
  assert.throws(() => gate.addPolicy({ match: {}, behavior: 'always' }), { message: 'A rule wasn\'t saved: it has no "name".' });
  assert.throws(() => gate.addPolicy('dm'), {
    message: 'A rule wasn\'t saved: it\'s "dm", where a rule is an object, such as {"name": "my-rule", "behavior": "always"}.',
  });
  assert.equal(existsSync(configPath), false, 'nothing was written');

  // An absent behavior is "always", and empty lists mean no constraint, as before.
  assert.equal(refusal(gate, { match: { scope: [], tagsAny: [], metadataTrue: [] }, resets: [] }), null);
  assert.deepEqual(onDisk(configPath).policies, [{ name: 'r', match: { scope: [] }, behavior: 'always' }]);
});

test('a field name one slip from one the gate reads is a problem at every level, named with every field it could be meant for', (t) => {
  const { gate } = makeGate(tempDir(t));
  const all = ` ${everyEventIfSaved()}`;
  const cases: Array<[Record<string, unknown>, string, string?]> = [
    [{ behavior: 'always', reset: ['a'] }, 'it has "reset" (did you mean "resets"?), which the gate doesn\'t read'],
    [{ match: { chanel: 'discord:*:1' } }, 'match has "chanel" (did you mean "channel"?), which the gate doesn\'t read', all],
    [
      { match: { filter: { type: 'text', patern: 'x' } } },
      'match.filter has "patern" (did you mean "pattern"?), which the gate doesn\'t read; '
      + 'match.filter.pattern is missing, where the text or regular expression to look for is needed',
      all,
    ],
    [
      { behavior: { debounc: 1000 } },
      'behavior has "debounc" (did you mean "debounce"?), which the gate doesn\'t read; behavior holds none of "debounce", "rate_limit", "passive_sample" and "judge"',
    ],
    [{ behavior: { rate_limit: { tokens: 1, refillIntervalMs: 1000, keyby: 'channelId' } } }, 'behavior.rate_limit has "keyby" (did you mean "keyBy"?), which the gate doesn\'t read'],
    [
      { behavior: { passive_sample: { evrey: 2 } } },
      'behavior.passive_sample has "evrey" (did you mean "every"?), which the gate doesn\'t read; '
      + 'behavior.passive_sample.every is missing, where a whole number of 1 or more is needed',
    ],
    // A part of a name is a shortened attempt at it, and each name it's part of is named.
    [{ match: { tags: ['chat:dm'] } }, 'match has "tags" (did you mean "tagsAny", "tagsAll" or "tagsNone"?), which the gate doesn\'t read', all],
    [
      { behavior: { rate_limit: { tokens: 1, interval: 1000 } } },
      'behavior.rate_limit has "interval" (did you mean "refillIntervalMs"?), which the gate doesn\'t read; '
      + 'behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed',
    ],
    // A name holding a field's whole name, where the rule doesn't give that field, is the field under another name,
    // at every level, and one holding two is a slip of each the rule doesn't give.
    [{ behavior: 'skip', matchTags: ['chat:ambient'] }, 'it has "matchTags" (did you mean "match"?), which the gate doesn\'t read'],
    [{ match: { channelId: 'discord:*:1' } }, 'match has "channelId" (did you mean "channel"?), which the gate doesn\'t read', all],
    [
      { behavior: { debounceMs: 60000 } },
      'behavior has "debounceMs" (did you mean "debounce"?), which the gate doesn\'t read; behavior holds none of "debounce", "rate_limit", "passive_sample" and "judge"',
    ],
    [
      { behavior: { rate_limit: { tokensPerHour: 5, refillIntervalMs: 60000 } } },
      'behavior.rate_limit has "tokensPerHour" (did you mean "tokens"?), which the gate doesn\'t read; '
      + 'behavior.rate_limit.tokens is missing, where a positive number is needed',
    ],
    [{ matchBehavior: 'skip' }, 'it has "matchBehavior" (did you mean "match" or "behavior"?), which the gate doesn\'t read'],
    [{ match: { tagsAny: ['chat:dm'] }, matchBehavior: 'skip' }, 'it has "matchBehavior" (did you mean "behavior"?), which the gate doesn\'t read'],
  ];
  for (const [fields, problem, also] of cases) {
    assert.equal(refusal(gate, fields), `Rule "r" wasn't saved: ${problem}.${also ?? ''}`, JSON.stringify(fields));
  }
  assert.throws(() => gate.addPolicy({ nmae: 'dm', behavior: 'always' }), {
    message: 'A rule wasn\'t saved: it has "nmae" (did you mean "name"?), which the gate doesn\'t read; it has no "name".',
  }, 'a slip of the name is named as one, beside the name it leaves missing');
});

test('in gate.json, a rule with a problem is read the way earlier releases read it, with a note, and wakes where they woke', (t) => {
  // Each under a "skip" default, so what the rule wakes on is all that wakes.
  const cases: Array<{ rule: Record<string, unknown>; read: GateBehavior; note: string; matchesAll?: true; wakes: Array<[GateEventInfo, boolean]> }> = [
    {
      rule: { name: 'x', match: { tagsAny: ['chat:ambient'] }, behavior: 'deffer' },
      read: 'always',
      note: `behavior is "deffer", where ${BEHAVIORS} is needed, so it's read as "always"`,
      wakes: [[event(['chat:ambient']), true], [event(['chat:bot']), false]],
    },
    {
      // XML tool mode once saved the object form as this text.
      rule: { name: 'x', match: { tagsAny: ['chat:ambient'] }, behavior: '{"debounce": 60000}' },
      read: 'always',
      note: `behavior is "{\\"debounce\\": 60000}", where ${BEHAVIORS} is needed, so it's read as "always"`,
      wakes: [[event(['chat:ambient']), true]],
    },
    {
      rule: { name: 'x', behaviour: 'skip', match: { tagsAny: ['chat:ambient'] } },
      read: 'always',
      note: 'it has "behaviour" (did you mean "behavior"?), which the gate doesn\'t read, so the rule\'s behavior is "always"',
      wakes: [[event(['chat:ambient']), true]],
    },
    {
      rule: { name: 'x', match: 'chat:ambient', behavior: 'always' },
      read: 'always',
      note: 'match is "chat:ambient", where an object is needed, such as {"source": "discord"}, so the rule matches every event',
      wakes: [[MENTION, true], [event([], 'timer:fired'), true]],
    },
    {
      rule: { name: 'x', match: { tagsAny: 'chat:ambient', source: 3 }, behavior: 'always' },
      read: 'always',
      note: 'match.source is 3, where a string is needed, such as "discord", so the rule is read without it; '
        + 'match.tagsAny is "chat:ambient", where a list of non-empty strings is needed, such as ["chat:ambient"], so the rule is read without it',
      matchesAll: true,
      wakes: [[MENTION, true]],
    },
    {
      rule: { name: 'x', match: { tagsAll: ['chat:reply', ''], filter: { type: 'glob', pattern: 'x*' } }, behavior: 'always', resets: 'other' },
      read: 'always',
      note: 'match.tagsAll holds "", where each entry is a non-empty string, so that entry is dropped; '
        + 'match.filter.type is "glob", where "text" or "regex" is needed, so the rule is read without its filter; '
        + 'resets is "other", where a list of rule names is needed, such as ["other-rule"], so the rule resets no other',
      wakes: [[event(['chat:reply']), true], [event(['chat:bot']), false]],
    },
    {
      // Of two kinds, the first of debounce, rate_limit and passive_sample was read, whatever the order.
      rule: { name: 'x', behavior: { passive_sample: { every: 3 }, rate_limit: { tokens: 1, refillIntervalMs: 60000 } } },
      read: { rate_limit: { tokens: 1, refillIntervalMs: 60000 } },
      note: 'behavior holds "rate_limit" and "passive_sample", and a rule has one behavior, so only its "rate_limit" is read',
      wakes: [[MENTION, true], [MENTION, false]],
    },
    {
      rule: { name: 'x', behavior: { rate_limit: { tokens: 1, refillIntervalMs: 60000, keyby: 'channelId' } } },
      read: { rate_limit: { tokens: 1, refillIntervalMs: 60000 } },
      note: 'behavior.rate_limit has "keyby" (did you mean "keyBy"?), which the gate doesn\'t read, so it does nothing',
      wakes: [[MENTION, true], [{ ...MENTION, channelId: 'c2' }, false]],
    },
    {
      rule: { name: 'x', behavior: { rate_limit: { tokens: 1, refillIntervalMs: 60000, keyBy: 3 } } },
      read: { rate_limit: { tokens: 1, refillIntervalMs: 60000 } },
      note: 'behavior.rate_limit.keyBy is 3, where a field name is needed, such as "channelId", so it does nothing, '
        + 'and every event the rule matches shares one bucket',
      wakes: [[MENTION, true], [MENTION, false]],
    },
    {
      // `pasthrough` made a governor consume the events it should let fall
      // through (af#105). It holds back what it held back, and is named.
      rule: { name: 'x', behavior: { passive_sample: { every: 2 } }, pasthrough: true },
      read: { passive_sample: { every: 2 } },
      note: 'it has "pasthrough" (did you mean "passthrough"?), which the gate doesn\'t read, so it does nothing',
      wakes: [[MENTION, false], [MENTION, true]],
    },
    {
      // An empty scope entry only narrows a rule, so it's read so whatever the rule does.
      rule: { name: 'x', match: { scope: [''] }, behavior: 'skip' },
      read: 'skip',
      note: 'match.scope holds "", and no event\'s type is "", so the rule matches no event',
      wakes: [[MENTION, true]],
    },
  ];
  for (const { rule, read, note, matchesAll, wakes } of cases) {
    const { gate } = makeGate(tempDir(t), { file: { default: 'skip', policies: [rule, MENTIONS] } });
    assert.deepEqual(behaviors(gate), [read, 'always'], JSON.stringify(rule));
    const said = `gate.json loaded. Rule "x": ${note}.${matchesAll ? ` ${everyEvent('Rule "x"')}` : ''}`;
    assert.deepEqual(gate.getStatus().errors, [said], JSON.stringify(rule));
    assert.deepEqual(wakes.map(([e]) => gate.evaluate(e).trigger), wakes.map(([, woke]) => woke), JSON.stringify(rule));
    gate.dispose();
  }
});

test("in gate.json, a rule earlier releases refused is left out, and the rest of the file loads", (t) => {
  // Earlier releases refused each of these, and so the whole file. Under
  // "always", the rest of it loads now.
  const refused: Array<[unknown, string]> = [
    ['every-mention', 'The 1st rule is left out: it\'s "every-mention", where a rule is an object, such as {"name": "my-rule", "behavior": "always"}.'],
    [{ match: {}, behavior: 'always' }, 'The 1st rule is left out: it has no "name".'],
    [{ name: 'x', behavior: [] }, `Rule "x" is left out: behavior is [], where ${BEHAVIORS} is needed.`],
    [{ name: 'x', behavior: { debouce: 60000 } }, 'Rule "x" is left out: behavior has "debouce" (did you mean "debounce"?), which the gate doesn\'t read; behavior holds none of "debounce", "rate_limit", "passive_sample" and "judge".'],
    [{ name: 'x', behavior: { debounce: '60000' } }, 'Rule "x" is left out: behavior.debounce is "60000", where a number of milliseconds is needed, such as 60000.'],
    [{ name: 'x', behavior: { rate_limit: { tokens: 3 } } }, 'Rule "x" is left out: behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed.'],
    [{ name: 'x', behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } } }, 'Rule "x" is left out: behavior.rate_limit.tokens is 0, where a positive number is needed.'],
    [{ name: 'x', behavior: { passive_sample: { every: '3' } } }, 'Rule "x" is left out: behavior.passive_sample.every is "3", where a whole number of 1 or more is needed.'],
    [{ name: 'x', behavior: 'always', match: { filter: { type: 'regex', pattern: 'a[' } } }, 'Rule "x" is left out: match.filter.pattern isn\'t a regular expression the gate can read'],
    [{ name: 'x', behavior: { rate_limit: { tokens: 3, refillIntervalMs: 1000 } }, passthrough: 'true' }, 'Rule "x" is left out: passthrough is "true", where true or false is needed.'],
    [{ name: 'x', behavior: 'always', passthrough: true }, 'Rule "x" is left out: passthrough is true, and only a behavior.rate_limit or behavior.passive_sample rule passes on an event it matches without waking on it; with behavior "always", leave passthrough out.'],
  ];
  // Ones earlier releases refused that wake on none of what they match, that
  // skip or defer or are a rate limit with no tokens: left out, they hold back
  // nothing they were written to wake on, so under "skip" the rest loads.
  const quiet: Array<[unknown, string]> = [
    [{ match: {}, behavior: 'skip' }, 'The 1st rule is left out: it has no "name".'],
    [
      { name: 'x', behavior: 'defer', passthrough: true },
      'Rule "x" is left out: passthrough is true, and only a behavior.rate_limit or behavior.passive_sample rule passes on an event it matches without waking on it; with behavior "defer", leave passthrough out.',
    ],
    [{ name: 'x', behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } } }, 'Rule "x" is left out: behavior.rate_limit.tokens is 0, where a positive number is needed.'],
    [{ name: 'x', behavior: { rate_limit: { tokens: -2, refillIntervalMs: 1000 } } }, 'Rule "x" is left out: behavior.rate_limit.tokens is -2, where a positive number is needed.'],
  ];
  for (const [cases, defaultBehavior] of [[refused, 'always'], [quiet, 'skip']] as const) {
    for (const [rule, said] of cases) {
      const { gate } = makeGate(tempDir(t), { file: { default: defaultBehavior, policies: [rule, MENTIONS] } });
      assert.deepEqual(names(gate), ['mentions'], JSON.stringify(rule));
      assert.equal(gate.getStatus().configSource, 'file');
      assert.ok((gate.getStatus().errors[0] ?? '').startsWith(`gate.json loaded. ${said}`), `${JSON.stringify(rule)}: ${gate.getStatus().errors[0]}`);
      assert.equal(gate.getStatus().errors.length, 1);
      // A mention wakes the agent, where the whole file used to be refused, and a
      // start then ran a recipe's starting rules in its place.
      assert.equal(gate.evaluate(MENTION).trigger, true, JSON.stringify(rule));
    }
  }
});

test('a rule that skips or defers is read past a problem as earlier releases read it, holding back what they held back, so the rules after it see what they saw', (t) => {
  const cases: Array<[unknown, string, boolean]> = [
    [
      { name: 'x', match: { tagsAny: 'chat:mention' }, behavior: 'skip' },
      'Rule "x": match.tagsAny is "chat:mention", where a list of non-empty strings is needed, such as ["chat:ambient"], so the rule is '
      + `read without it. Read so, it skips every event it now matches, as earlier releases did. ${everyEvent('Rule "x"')}`,
      false,
    ],
    [
      { name: 'x', match: { chanel: 'discord:*:1' }, behavior: 'defer' },
      'Rule "x": match has "chanel" (did you mean "channel"?), which the gate doesn\'t read, so it does nothing. '
      + `Read so, it defers every event it now matches, as earlier releases did. ${everyEvent('Rule "x"')}`,
      false,
    ],
    [
      { name: 'x', match: { scope: ['', 5] }, behavior: 'skip' },
      'Rule "x": match.scope holds 5, which isn\'t an event type, so that entry is dropped; match.scope holds "", and no event\'s type is "", '
      + 'so the rule matches no event. Read so, it skips every event it now matches, as earlier releases did.',
      true,
    ],
  ];
  for (const [rule, said, mentionWakes] of cases) {
    const { gate } = makeGate(tempDir(t), { file: { default: 'skip', policies: [rule, MENTIONS] } });
    assert.deepEqual(names(gate), ['x', 'mentions'], JSON.stringify(rule));
    assert.deepEqual(gate.getStatus().errors, [`gate.json loaded. ${said}`], JSON.stringify(rule));
    assert.equal(gate.evaluate(MENTION).trigger, mentionWakes, `${JSON.stringify(rule)}: as earlier releases woke on it`);
    gate.dispose();
  }

  // A rate limit after it spends its tokens only on what reaches it, as before:
  // left out, the rule that skips Discord's posts would let one take the token,
  // and the Zulip post that woke the agent before would go quiet.
  const bots = { name: 'bots', match: { source: 'discord', tagsAny: 'chat:bot' }, behavior: 'skip' };
  const limit = { name: 'limit', match: {}, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000 } } };
  const { gate } = makeGate(tempDir(t), { file: { default: 'skip', policies: [bots, limit] } });
  const zulip: GateEventInfo = { content: 'release notes', eventType: 'mcpl:channel-incoming', serverId: 'zulip', channelId: 'z1', tags: [] };
  assert.deepEqual([event([]), zulip, event([])].map((e) => gate.evaluate(e).trigger), [false, true, false]);
  gate.dispose();
});

test("under a default that holds events back, a file that leaves out a rule that could wake the agent isn't used, as earlier releases didn't use it", (t) => {
  // A mention rule earlier releases refused, beside one that still wakes: read
  // without it, the file would hold back the mentions it was written to wake on.
  const broken = { name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: [] };
  const dms = { name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always' };
  const notUsed = 'gate.json leaves out a rule that could wake the agent, and under its default, "skip", what it was written to wake it on '
    + `would be held back. Rule "mentions" is left out: behavior is [], where ${BEHAVIORS} is needed.`;

  // At a start, the host's starting rules run in its place, as before.
  const recipe = { default: 'skip', policies: [{ ...MENTIONS, name: 'recipe-mentions' }] };
  const started = makeGate(tempDir(t), { file: { default: 'skip', policies: [broken, dms] }, initialConfig: recipe });
  assert.deepEqual(started.gate.getStatus().errors, [unused(started.configPath, notUsed, "the host's starting rules")]);
  assert.equal(started.gate.getStatus().configSource, 'initial');
  assert.equal(started.gate.evaluate(MENTION).trigger, true);
  started.gate.dispose();
  // With no starting rules, the gate's default, which wakes on every event.
  const bare = makeGate(tempDir(t), { file: { default: 'skip', policies: [broken, dms] } });
  assert.equal(bare.gate.getStatus().configSource, 'default');
  assert.equal(bare.gate.evaluate(MENTION).trigger, true);
  // At a reload, the rules in force stay.
  const reload = (file: unknown): void => {
    writeFileSync(bare.configPath, JSON.stringify(file));
    (bare.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    bare.gate.evaluate(event([]));
  };
  reload({ default: 'skip', policies: [MENTIONS, dms] });
  reload({ default: 'skip', policies: [broken, dms] });
  assert.deepEqual(names(bare.gate), ['mentions', 'dms']);
  assert.equal(bare.gate.evaluate(MENTION).trigger, true, 'the mentions rule in force still wakes');
  assert.deepEqual(bare.gate.getStatus().errors, [unused(bare.configPath, notUsed, RUNS_LAST)]);
  bare.gate.dispose();

  // Under "defer" too, naming each such rule.
  const two = makeGate(tempDir(t), { file: { default: 'defer', policies: [broken, { name: 'fast', behavior: { debounce: 'soon' } }] } });
  assert.deepEqual(two.gate.getStatus().errors, [unused(
    two.configPath,
    'gate.json leaves out rules that could wake the agent, and under its default, "defer", what they were written to wake it on would '
    + `be held back. Rule "mentions" is left out: behavior is [], where ${BEHAVIORS} is needed. `
    + 'Rule "fast" is left out: behavior.debounce is "soon", where a number of milliseconds is needed, such as 60000.',
    RUNS_DEFAULT,
  )]);
  two.gate.dispose();

  // The host's starting rules the same way: the start runs no rules, which hears every event, in their place.
  const userInput = { name: 'user-input', match: { scope: ['user:message'] }, behavior: 'always' };
  const raw = { name: 'raw', match: {}, behavior: { rate_limit: { tokens: 3 } } };
  const rawSaid = 'Rule "raw" is left out: behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed.';
  const starting = makeGate(tempDir(t), { initialConfig: { default: 'skip', policies: [userInput, raw] } });
  assert.deepEqual(starting.gate.getStatus().errors, [
    'At start, the host\'s starting rules weren\'t used: the starting config leaves out a rule that could wake the agent, and under its '
    + `default, "skip", what it was written to wake it on would be held back. ${rawSaid} `
    + 'The gate started with no rules, as on a host without starting rules.',
  ]);
  assert.equal(existsSync(starting.configPath), false, 'nothing was seeded');
  assert.equal(starting.gate.evaluate(event([], 'user:message')).trigger, true);
  starting.gate.dispose();

  // A later start doesn't add starting rules that would leave gate.json unused, and says why.
  const later = makeGate(tempDir(t), { file: { default: 'skip', policies: [MENTIONS] }, initialConfig: { policies: [userInput, raw] } });
  assert.deepEqual(onDisk(later.configPath), { default: 'skip', policies: [MENTIONS] }, 'nothing was written');
  assert.deepEqual(names(later.gate), ['mentions']);
  assert.deepEqual(later.gate.getStatus().errors, [
    `In the host's starting rules, ${rawSaid} At start, the host's starting rules "user-input" and "raw" couldn't be added to gate.json `
    + '(with them, gate.json would leave out a rule that could wake the agent, and under its default, "skip", it wouldn\'t be used), '
    + 'so they weren\'t put in force. A start adds them once what kept them out is fixed.',
  ]);
  later.gate.dispose();
});

test("a change over a gate.json that's JSON the gate doesn't use edits it as written, and is saved only once it loads, so mending the rule that keeps it out brings it into force", (t) => {
  // The operator's file, sound but for one rule that could wake the agent, out of force under "defer".
  const dms = { name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always' };
  const ambient = { name: 'quiet-ambient', match: { tagsAny: ['chat:ambient'] }, behavior: { debounce: '60000' } };
  const operators = { _comment: 'mine', default: 'defer', policies: [dms, ambient] };
  const ambientSaid = 'Rule "quiet-ambient" is left out: behavior.debounce is "60000", where a number of milliseconds is needed, such as 60000.';
  const mends = 'Replacing or removing "quiet-ambient" by name would bring gate.json into force.';
  const hostOnly = 'No change through the gate can bring it into force, so gate.json has to be fixed by an edit of its own; until '
    + 'then, a change is refused the same way.';
  const notSaved = (path: string, said: string, remedy = mends): string => `Nothing was saved: with this change, gate.json, at ${path}, wouldn't be used. gate.json `
    + `leaves out a rule that could wake the agent, and under its default, "defer", what it was written to wake it on would be held back. ${said} ${remedy}`;
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { file: operators });
  const written = readFileSync(configPath, 'utf-8');
  assert.equal(gate.getStatus().configSource, 'default');

  // A change that doesn't mend it is refused, naming what keeps it out: nothing is written over the file, or kept.
  assert.throws(() => gate.addPolicy({ name: 'added', match: { source: 'x' }, behavior: 'skip' }), { message: notSaved(configPath, ambientSaid) });
  assert.throws(() => gate.removePolicy('dms'), { message: notSaved(configPath, ambientSaid) });
  assert.equal(gate.removePolicy('absent'), false, 'a removal of a rule it lacks writes nothing');
  assert.equal(readFileSync(configPath, 'utf-8'), written, 'gate.json is as the operator wrote it');
  assert.deepEqual(readdirSync(dir), ['gate.json'], 'nothing is written beside it');
  assert.equal(gate.getStatus().configSource, 'default', 'the rules in force stay');

  // Replacing that rule by name mends it: the file loads, as written apart from the rule replaced.
  gate.addPolicy({ ...ambient, behavior: { debounce: 60000 } });
  assert.deepEqual(onDisk(configPath), { ...operators, policies: [dms, { ...ambient, behavior: { debounce: 60000 } }] });
  assert.equal(gate.getStatus().configSource, 'file');
  assert.deepEqual(names(gate), ['dms', 'quiet-ambient']);
  assert.deepEqual(gate.getStatus().errors, ['gate.json loaded. gate.json has "_comment", which the gate doesn\'t read, so it does nothing. '
    + 'Its fields are "default" and "policies".']);
  gate.dispose();

  // So does removing it by name.
  const removing = makeGate(tempDir(t), { file: operators });
  assert.equal(removing.gate.removePolicy('quiet-ambient'), true);
  assert.deepEqual(onDisk(removing.configPath), { ...operators, policies: [dms] });
  assert.deepEqual(names(removing.gate), ['dms']);
  removing.gate.dispose();

  // A mend that leaves another such rule is refused, naming that one, not the rule it mended,
  // and no one change can mend two.
  const mentions = { name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: [] };
  const two = makeGate(tempDir(t), { file: { ...operators, policies: [dms, ambient, mentions] } });
  const twoWritten = readFileSync(two.configPath, 'utf-8');
  assert.throws(
    () => two.gate.addPolicy({ ...ambient, behavior: { debounce: 60000 } }),
    { message: notSaved(two.configPath, `Rule "mentions" is left out: behavior is [], where ${BEHAVIORS} is needed.`, hostOnly) },
  );
  assert.equal(readFileSync(two.configPath, 'utf-8'), twoWritten);
  two.gate.dispose();
  // Nor a rule with no name, which no change can name.
  const unnamed = makeGate(tempDir(t), { file: { ...operators, policies: [dms, { match: {}, behavior: 'always' }] } });
  assert.throws(
    () => unnamed.gate.addPolicy({ name: 'added', behavior: 'always' }),
    { message: notSaved(unnamed.configPath, 'The 2nd rule is left out: it has no "name".', hostOnly) },
  );
  unnamed.gate.dispose();
  // Where another rule has its name, the refusal says what a change by that
  // name does, rather than name one that would replace the sound rule, or
  // remove it too. A removal of them both leaves "dms", so it's offered.
  const shared = makeGate(tempDir(t), { file: { ...operators, policies: [dms, { ...ambient, behavior: 'always' }, ambient] } });
  const sharedWritten = readFileSync(shared.configPath, 'utf-8');
  const sharedSaid = notSaved(
    shared.configPath,
    ambientSaid,
    'gate.json has 2 rules named "quiet-ambient", and a change by that name replaces the first of them or removes them all.',
  );
  assert.throws(() => shared.gate.addPolicy({ name: 'added', behavior: 'always' }), { message: sharedSaid });
  // As it says: replacing it, mended, takes the sound rule, and the file stays out.
  assert.throws(() => shared.gate.addPolicy({ ...ambient, behavior: { debounce: 60000 } }), { message: sharedSaid });
  assert.equal(readFileSync(shared.configPath, 'utf-8'), sharedWritten);
  shared.gate.dispose();

  // JSON with no rule list to edit is refused as a loaded file with none is, whatever its default, saying what runs.
  const noList = (file: unknown, what: string, runs: string) => {
    const d = tempDir(t);
    const { gate: g, configPath: path } = makeGate(d, { file });
    const before = readFileSync(path, 'utf-8');
    assert.throws(() => g.addPolicy({ name: 'added', behavior: 'always' }), {
      message: `${what}, so it has no list of rules a change could edit without writing over what it holds, and nothing was `
        + `saved. Meanwhile the gate runs ${runs}. Until gate.json, at ${path}, is an object whose "policies" is a list holding `
        + 'its rules, a change is refused the same way.',
    });
    assert.equal(readFileSync(path, 'utf-8'), before);
    assert.deepEqual(readdirSync(d), ['gate.json']);
    g.dispose();
  };
  // A "policies" that isn't a list and holds something, where a change would write over it; one holding nothing
  // writes no rules, as [] does, and a change writes the list there (the labels below).
  // It loads with no rules under its default, which is what runs.
  noList({ default: 'skip', policies: { name: 'r', behavior: 'always' } }, 'gate.json\'s "policies" is {"name":"r","behavior":"always"}',
    'no rules: every event gets the default, "skip"');
  // It isn't used, and with no starting rules, a start runs none.
  noList(5, 'gate.json is 5', 'no rules: every event gets the default, "always"');
});

test("gate.json's own problems: a list, a policies that isn't one, a slip of it, a name the gate doesn't read and a rule's fields at the top load as earlier releases read them, under the file's default", (t) => {
  const policiesNeeded = 'where a list of rules is needed, such as [{"name": "my-rule", "behavior": "always"}]';
  const noRules = (defaultBehavior: string): string => defaultBehavior === 'always'
    ? 'it has no rules, so every event gets the default, "always"'
    : `it has no rules, so under its default, "${defaultBehavior}", every event is held back`;
  const unread = (key: string) => `gate.json has "${key}", which the gate doesn't read, so it does nothing. Its fields are "default" and "policies".`;
  const read: Array<[unknown, string, string]> = [
    [
      [{ name: 'dm', behavior: 'always' }],
      'always',
      'gate.json is a list, where an object is needed, such as {"policies": [{"name": "my-rule", "behavior": "always"}]}, so none of it is read, '
      + 'and every event gets the default, "always".',
    ],
    [{ policies: { name: 'r', behavior: 'always' } }, 'always', `gate.json's "policies" is {"name":"r","behavior":"always"}, ${policiesNeeded}, and ${noRules('always')}.`],
    [{ polices: [{ name: 'dm', behavior: 'always' }] }, 'always', `gate.json has "polices" (did you mean "policies"?), which the gate doesn't read, and ${noRules('always')}.`],
    // A list holding a rule, under a name further from "policies" than a slip, is a name like any other.
    [{ rules: [{ name: 'dm', behavior: 'always' }] }, 'always', unread('rules')],
    [{ defualt: 'skip', policies: [] }, 'always', 'gate.json has "defualt" (did you mean "default"?), which the gate doesn\'t read, so its default is "always".'],
    // A "policies" holding nothing writes no rules, as [] does, and beside one a slip holding rules is read as it is with none.
    [{ policies: {} }, 'always', `gate.json's "policies" is {}, ${policiesNeeded}, and ${noRules('always')}.`],
    [
      { policies: [], polices: [{ name: 'dm', behavior: 'always' }] },
      'always',
      `gate.json has "polices" (did you mean "policies"?), which the gate doesn't read, and ${noRules('always')}.`,
    ],
  ];
  for (const [file, defaultBehavior, said] of read) {
    const { gate } = makeGate(tempDir(t), { file });
    assert.deepEqual(gate.getStatus().errors, [`gate.json loaded. ${said}`], JSON.stringify(file));
    assert.equal(gate.getStatus().configSource, 'file');
    assert.equal(gate.getStatus().default, defaultBehavior);
    assert.deepEqual(names(gate), []);
  }

  // What earlier releases refused whole, it doesn't use.
  const refused: Array<[unknown, string]> = [
    [{ default: 'sometimes', policies: [] }, 'gate.json "default" must be "always", "defer", or "skip", got: "sometimes"'],
    ['"skip"', 'gate.json must be a JSON object'],
  ];
  for (const [file, error] of refused) {
    const { gate, configPath } = makeGate(tempDir(t), { file });
    // gate_status says what's in force instead.
    assert.deepEqual(gate.getStatus().errors, [unused(configPath, error, RUNS_DEFAULT)], JSON.stringify(file));
    assert.equal(gate.getStatus().configSource, 'default', 'the gate runs its default, not the file');
    assert.equal(gate.getStatus().default, 'always');
    // At a reload, the rules in force stay.
    writeFileSync(configPath, JSON.stringify({ default: 'skip', policies: [MENTIONS] }));
    gate.evaluate(MENTION);
    writeFileSync(configPath, typeof file === 'string' ? file : JSON.stringify(file));
    (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    gate.evaluate(MENTION);
    assert.deepEqual(names(gate), ['mentions'], JSON.stringify(file));
    assert.deepEqual(gate.getStatus().errors, [unused(configPath, error, RUNS_LAST)]);
  }

  // Beside "policies", a list under a name the gate doesn't read is a name like any other.
  const { gate: beside } = makeGate(tempDir(t), { file: { policies: [MENTIONS], rules: [{ name: 'dm', behavior: 'always' }] } });
  assert.deepEqual(names(beside), ['mentions']);
  assert.deepEqual(beside.getStatus().errors, [`gate.json loaded. ${unread('rules')}`]);
  beside.dispose();

  // Under "always", a rule's fields at the top are read as written, and named; beside a list holding rules, so they are under "skip".
  const misplacedRule = 'gate.json has "name" and "behavior", fields of a rule, which the gate doesn\'t read here, so they do nothing.';
  const dms = { name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always' };
  for (const [file, rules, wakes] of [
    [{ name: 'mentions', behavior: 'skip' }, [], true],
    [{ default: 'skip', policies: [dms], name: 'mentions', behavior: 'always' }, ['dms'], false],
  ] as const) {
    const { gate } = makeGate(tempDir(t), { file });
    assert.deepEqual(gate.getStatus().errors, [`gate.json loaded. ${misplacedRule}`], JSON.stringify(file));
    assert.deepEqual(names(gate), rules);
    assert.equal(gate.evaluate(MENTION).trigger, wakes, JSON.stringify(file));
    gate.dispose();
  }

  // Under "skip" or "defer", a file earlier releases loaded loads as they read
  // it: a slip of "policies", a list under a name the gate doesn't read
  // (rules parked there, labels, or both), a rule's fields at the top, a label
  // named like one, and a "policies" that isn't a list each do nothing, and a
  // note names each without calling a parked list a slip. With no rules, it
  // holds back every event, as it did; nothing in a name tells a parked list
  // from a misplaced one, and leaving the file out of force at a start would
  // run the host's starting rules, or wake on every event, in its place. A
  // change keeps each as written, and adds a "policies" list beside it, in
  // which the rule it adds is in force.
  const misplaced = (shown: string, one = true) => `gate.json has ${shown}, which the gate doesn't read here, so ${one ? 'it does' : 'they do'} nothing.`;
  const quiet: Array<[Record<string, unknown>, string[]]> = [
    // Rules under a slip of "policies", or under a name further from it, among labels or alone,
    [{ default: 'defer', polices: [{ name: 'dm', behavior: 'always' }] }, [`gate.json has "polices" (did you mean "policies"?), which the gate doesn't read, and ${noRules('defer')}.`]],
    [{ default: 'skip', policy: [MENTIONS] }, [unread('policy')]],
    [{ default: 'skip', notes: [{ date: '2026-10-01' }, MENTIONS] }, [unread('notes')]],
    [{ default: 'skip', policies: [], disabled: [MENTIONS] }, [unread('disabled')]],
    [
      { default: 'skip', policies: [], history: [{ date: '2026-10-01', source: 'ops', text: 'muted for the offsite' }] },
      [unread('history')],
    ],
    // a rule's fields at the top, or a field of its match or behavior,
    [{ default: 'skip', ...MENTIONS }, [misplaced('"name", "match" and "behavior", fields of a rule', false)]],
    [{ default: 'skip', tagsAny: ['chat:dm'] }, [misplaced('"tagsAny", a field of "match"')]],
    [{ default: 'defer', channel: 'ops-room' }, [misplaced('"channel", a field of "match"')]],
    [{ default: 'defer', tokens: 3, refillIntervalMs: 60000 }, [misplaced('"tokens" and "refillIntervalMs", fields of "behavior.rate_limit"', false)]],
    [
      { default: 'skip', keyBy: 'channel', tokens: 3 },
      [misplaced('"keyBy", a field of "behavior.rate_limit" and "behavior.passive_sample"'), misplaced('"tokens", a field of "behavior.rate_limit"')],
    ],
    [{ default: 'skip', type: 'regex', pattern: 'urgent' }, [misplaced('"type" and "pattern", fields of "match.filter"', false)]],
    [{ default: 'skip', passthrough: false }, [misplaced('"passthrough", a field of a rule')]],
    [{ default: 'defer', tokens: 0 }, [misplaced('"tokens", a field of "behavior.rate_limit"')]],
    [{ default: 'skip', rate_limit: {} }, [misplaced('"rate_limit", a field of "behavior"')]],
    [{ default: 'skip', behavior: [] }, [misplaced('"behavior", a field of a rule')]],
    // labels with a field's name, or none,
    [{ name: 'quiet-hours', default: 'skip' }, [misplaced('"name", a field of a rule')]],
    [{ source: 'written by ops', default: 'skip' }, [misplaced('"source", a field of "match"')]],
    [{ comment: 'written by ops', default: 'skip' }, [unread('comment')]],
    [{ default: 'skip', notes: ['muted during the launch'] }, [unread('notes')]],
    [{ default: 'skip', comments: ['quiet for now'] }, [unread('comments')]],
    [{ default: 'skip', policy: [] }, [unread('policy')]],
    // and each beside a "policies" holding nothing, which writes no rules, as one left out does,
    [
      { default: 'skip', policies: {}, polices: [MENTIONS] },
      [
        `gate.json has "polices" (did you mean "policies"?), which the gate doesn't read, and ${noRules('skip')}.`,
        `gate.json's "policies" is {}, ${policiesNeeded}, and ${noRules('skip')}.`,
      ],
    ],
    [{ default: 'defer', policies: [], rules: [MENTIONS] }, [unread('rules')]],
    [{ default: 'skip', policies: [], ...MENTIONS }, [misplaced('"name", "match" and "behavior", fields of a rule', false)]],
    // or a slip of it holding nothing.
    [{ default: 'skip', polices: [] }, [`gate.json has "polices" (did you mean "policies"?), which the gate doesn't read, and ${noRules('skip')}.`]],
    [{ default: 'defer', policies: { a: [] } }, [`gate.json's "policies" is {"a":[]}, ${policiesNeeded}, and ${noRules('defer')}.`]],
    [{ default: 'skip', policies: { a: null, b: '' } }, [`gate.json's "policies" is {"a":null,"b":""}, ${policiesNeeded}, and ${noRules('skip')}.`]],
  ];
  for (const [file, said] of quiet) {
    const { gate, configPath } = makeGate(tempDir(t), { file });
    assert.deepEqual(gate.getStatus().errors, [`gate.json loaded. ${said.join(' ')}`], JSON.stringify(file));
    assert.equal(gate.getStatus().configSource, 'file');
    assert.equal(gate.getStatus().default, file.default);
    assert.deepEqual(names(gate), []);
    assert.equal(gate.evaluate(MENTION).trigger, false, JSON.stringify(file));
    gate.addPolicy(MENTIONS);
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf-8')), { ...file, policies: [MENTIONS] }, JSON.stringify(file));
    assert.equal(gate.evaluate(MENTION).trigger, true, JSON.stringify(file));
    gate.dispose();
  }

  // So does a "policies" that isn't a list and holds something, which a change refuses to write over.
  const { gate: notList } = makeGate(tempDir(t), { file: { default: 'skip', policies: { name: 'r', behavior: 'always' } } });
  assert.deepEqual(notList.getStatus().errors, [
    `gate.json loaded. gate.json's "policies" is {"name":"r","behavior":"always"}, ${policiesNeeded}, and ${noRules('skip')}.`,
  ]);
  assert.equal(notList.getStatus().configSource, 'file');
  assert.equal(notList.evaluate(MENTION).trigger, false);
  notList.dispose();
});

test("gate_status's entry for a gate.json the gate can't use says what's in force until it can use one again: the text in force, or new text; a change is refused", (t) => {
  const noted = { comment: 'ops', policies: [MENTIONS] };
  const { gate, configPath } = makeGate(tempDir(t), { file: noted });
  const said = (key: string) => `gate.json loaded. gate.json has "${key}", which the gate doesn't read, so it does nothing. Its fields are "default" and "policies".`;
  const reload = () => {
    (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    gate.evaluate(MENTION);
  };
  const broken = '{"policies": [';
  let parsed = '';
  try {
    JSON.parse(broken);
  } catch (err) {
    parsed = (err as Error).message;
  }
  const notUsed = (): void => {
    writeFileSync(configPath, broken);
    reload();
    assert.deepEqual(gate.getStatus().errors, [notJsonShown(configPath, parsed, RUNS_LAST)]);
  };
  notUsed();
  writeFileSync(configPath, JSON.stringify(noted));
  reload();
  assert.deepEqual(gate.getStatus().errors, [said('comment')], 'the text in force again');
  notUsed();
  writeFileSync(configPath, JSON.stringify({ why: 'x', policies: [MENTIONS] }));
  reload();
  assert.deepEqual(gate.getStatus().errors, [said('why')], 'new text that loads');
  notUsed();
  // A change isn't written over a file that isn't JSON, so the entry stays, and so do the rules in force.
  assert.throws(() => gate.addPolicy({ name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always' }), { message: /^gate\.json, at .*, isn't JSON the gate can read \(/ });
  assert.deepEqual(gate.getStatus().errors, [notJsonShown(configPath, parsed, RUNS_LAST)]);
  assert.equal(readFileSync(configPath, 'utf-8'), broken);
  assert.deepEqual(names(gate), ['mentions']);
});

test("an onIgnoredFields that throws is logged once the change is made and traced, and the change answers as made", (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  const configPath = join(tempDir(t), 'gate.json');
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [] }));
  const traced: string[] = [];
  const gate = new EventGate({
    configPath, addMessage: () => '', requestInference: () => {}, getAgentNames: () => ['agent'],
    emitTrace: (e) => { traced.push((e as { type: string }).type); },
  });
  t.after(() => gate.dispose());
  let seen: string[] = [];
  const saved = gate.addPolicy({ ...MENTIONS, comment: 'mine' }, {
    onIgnoredFields: () => { seen = [...traced]; throw new Error('the host could not record it'); },
  });
  assert.equal(saved.name, 'mentions', 'addPolicy returns the rule it saved');
  assert.deepEqual(onDisk(configPath).policies, [MENTIONS]);
  assert.ok(seen.includes('gate:policy-added'), 'the callback runs once the change is traced');
  assert.deepEqual(logged, ['[gate] onIgnoredFields threw once the change was made, and the change stands: the host could not record it']);

  // A thrown value whose text can't be read is named as such.
  const unprintable = { toString(): string { throw new Error('no text'); } };
  gate.addPolicy({ name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always', comment: 'mine' }, {
    onIgnoredFields: () => { throw unprintable; },
  });
  assert.equal(logged[1], '[gate] onIgnoredFields threw once the change was made, and the change stands: a value that could not be printed');
});

test('a null or "" is a field left out, and each "" is named, with what leaving it out does where that\'s more than no constraint', (t) => {
  const { gate, configPath } = makeGate(tempDir(t));
  let ignored: string[] = [];
  const add = (rule: Record<string, unknown>) => gate.addPolicy(rule, { onIgnoredFields: (notes) => { ignored = notes; } });

  add({ name: 'quiet', match: { channel: '', pathGlob: null, filter: { type: 'text', pattern: '' } }, behavior: '' });
  assert.deepEqual(onDisk(configPath).policies.find((p) => p.name === 'quiet'), { name: 'quiet', match: {}, behavior: 'always' });
  assert.deepEqual(ignored, [
    'Rule "quiet" has "behavior" as "", so it\'s left out: a rule without one has the behavior "always".',
    'Rule "quiet": match has "channel" as "", so it\'s left out.',
    'Rule "quiet": match.filter\'s pattern is "", so the filter narrows nothing, and it\'s left out.',
    // A match left with nothing that narrows it, once its fields are read, matches every event.
    'Rule "quiet": nothing left in match narrows the rule, so it matches every event.',
  ]);
  add({ name: 'sampled', behavior: { passive_sample: { every: 2, keyBy: '' } }, resets: null, passthrough: null });
  assert.deepEqual(onDisk(configPath).policies.find((p) => p.name === 'sampled'), { name: 'sampled', match: {}, behavior: { passive_sample: { every: 2 } } });
  assert.deepEqual(ignored, ['Rule "sampled": behavior.passive_sample has "keyBy" as "", so it\'s left out: every event the rule matches shares one count.']);
  add({ name: 'limited', behavior: { rate_limit: { tokens: 2, refillIntervalMs: 1000, keyBy: '' } } });
  assert.deepEqual(ignored, ['Rule "limited": behavior.rate_limit has "keyBy" as "", so it\'s left out: every event the rule matches shares one bucket.']);
  // A filter's type the gate can't read is a problem, though its "" pattern narrows nothing either way.
  assert.equal(
    refusal(gate, { match: { filter: { type: 'bogus', pattern: '' } } }),
    'Rule "r" wasn\'t saved: match.filter.type is "bogus", where "text" or "regex" is needed. '
    + 'Rule "r": match.filter\'s pattern is "", so the filter narrows nothing, and it\'s left out. '
    + everyEventIfSaved(),
  );
  // So does one whose list entries are all dropped, or whose only other field does nothing.
  for (const [match, said] of [
    [{ tagsAny: [''] }, 'match.tagsAny holds "", where each entry is a non-empty string'],
    [{ scope: [5] }, 'match.scope holds 5, which isn\'t an event type'],
    // An empty list beside them is no constraint, as earlier releases read one, and narrows nothing.
    [{ metadataTrue: [], tagsAny: [], tagsAll: [], tagsNone: [], channel: 12345 }, 'match.channel is 12345, where a string is needed, such as "discord:*:12345"'],
  ] as const) {
    assert.equal(
      refusal(gate, { match }),
      `Rule "r" wasn't saved: ${said}. ${everyEventIfSaved()}`,
      JSON.stringify(match),
    );
  }
  add({ name: 'noted', match: { source: '', comment: 'x' } });
  assert.deepEqual(ignored, [
    'Rule "noted": match has "source" as "", so it\'s left out.',
    `Rule "noted": match has "comment", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}.`,
    'Rule "noted": nothing left in match narrows the rule, so it matches every event.',
  ]);
  // Empty lists alone always meant no constraint, so they say nothing, and neither does an empty match.
  ignored = [];
  add({ name: 'open', match: { scope: [], tagsAny: [] } });
  add({ name: 'any', match: {} });
  assert.deepEqual(ignored, []);

  // In gate.json too: a null loads as left out, and a "" with a note.
  const { gate: loaded } = makeGate(tempDir(t), {
    file: { default: null, policies: [{ name: 'dm', match: null, behavior: null, resets: null }, { name: 'any', match: { source: '' } }] },
  });
  assert.deepEqual(loaded.getStatus().policies.map((p) => [p.name, p.behavior]), [['dm', 'always'], ['any', 'always']]);
  assert.equal(loaded.getStatus().default, 'always');
  // A match left with nothing matches every event, and says so.
  assert.deepEqual(loaded.getStatus().errors, [
    'gate.json loaded. Rule "any": match has "source" as "", so it\'s left out. '
    + 'Rule "any": nothing left in match narrows the rule, so it matches every event.',
  ]);
  // A file that writes no rules is quiet as written, as before, and a "" says what that does under its default.
  const { gate: bare } = makeGate(tempDir(t), { file: { default: 'skip', policies: null } });
  assert.deepEqual(names(bare), []);
  assert.deepEqual(bare.getStatus().errors, []);
  assert.equal(bare.getStatus().default, 'skip');
  for (const [file, does] of [
    [{ default: 'skip', policies: '' }, 'it has no rules, so under its default, "skip", every event is held back'],
    [{ default: 'defer', policies: '' }, 'it has no rules, so under its default, "defer", every event is held back'],
    [{ policies: '' }, 'it has no rules, so every event gets the default, "always"'],
  ] as const) {
    const { gate: none } = makeGate(tempDir(t), { file });
    assert.deepEqual(none.getStatus().errors, [`gate.json loaded. gate.json has "policies" as "", so it's left out: ${does}.`]);
    assert.equal(none.evaluate(MENTION).trigger, !('default' in file));
    none.dispose();
  }
  // A "" that leaves a rule matching every event, or gate.json's default "always", says so.
  const { gate: wide } = makeGate(tempDir(t), { file: { default: '', policies: [{ name: 'every', match: '', behavior: 'skip' }] } });
  assert.deepEqual(wide.getStatus().errors, [
    'gate.json loaded. gate.json has "default" as "", so it\'s left out: its default is "always". '
    + 'Rule "every" has "match" as "", so it\'s left out: a rule without one matches every event.',
  ]);
  assert.equal(wide.getStatus().default, 'always');
});

test('a field name near none the gate reads loads, and is named', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, {
    file: { comment: 'ops', policies: [{ name: 'dm', match: { note: 'why', tagsAny: ['chat:dm'] }, behavior: 'always', comment: 'x' }] },
  });
  assert.deepEqual(names(gate), ['dm']);
  assert.equal(
    gate.getStatus().errors[0],
    'gate.json loaded. gate.json has "comment", which the gate doesn\'t read, so it does nothing. Its fields are "default" and "policies". '
    + `Rule "dm" has "comment", which the gate doesn't read, so it does nothing. Its fields are ${POLICY_FIELDS}. `
    + `Rule "dm": match has "note", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}.`,
  );

  let ignored: string[] = [];
  gate.addPolicy({ name: 'mentions', match: { tagsAny: ['chat:mention'], label: 'm' }, behavior: 'always' }, {
    onIgnoredFields: (notes) => { ignored = notes; },
  });
  assert.deepEqual(ignored, [`Rule "mentions": match has "label", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}.`]);
  const [note] = gate.getStatus().errors;
  assert.match(note ?? '', /^gate\.json loaded\. gate\.json has "comment"/, 'the rules the write left alone keep what they hold, and their notes');
  assert.equal(onDisk(configPath).comment, 'ops');
  assert.equal(JSON.stringify(onDisk(configPath)).includes('"label"'), false, 'the rule written leaves out what does nothing');

  // A caller that doesn't take the notes still gets them said, in the log.
  const logged = t.mock.method(console, 'error', () => {});
  gate.addPolicy({ name: 'quiet', match: { why: 'night' }, behavior: 'defer' });
  assert.deepEqual(logged.mock.calls.map((c) => c.arguments[0]), [
    `[gate] Rule "quiet": match has "why", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}. `
    + everyEvent('Rule "quiet"'),
  ]);
  logged.mock.restore();

  // A field the gate doesn't read is named with the refusal of its rule too,
  // since it's often the one a missing field was meant to be.
  assert.equal(
    refusal(gate, { behavior: { rate_limit: { tokens: 5, refillEveryMs: 60000 } } }),
    'Rule "r" wasn\'t saved: behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed. '
    + 'Rule "r": behavior.rate_limit has "refillEveryMs", which the gate doesn\'t read, so it does nothing. Its fields are "tokens", "refillIntervalMs" and "keyBy".',
  );
});

test("a name holding a field's whole name is the field under another name where the rule doesn't give it, and an extra beside it; at gate.json's top, a name that does nothing", (t) => {
  // In gate.json, a rule's slip is read as the field left out, as earlier releases read it.
  const ops = { name: 'ops', match: { channel: 'discord:*:1', channelNote: 'the ops room' }, behavior: 'always' };
  const quiet = { name: 'quiet', matchTags: ['chat:ambient'], behavior: 'skip' };
  const { gate } = makeGate(tempDir(t), { file: { defaultBehavior: 'skip', policies: [ops, quiet] } });
  assert.deepEqual(names(gate), ['ops', 'quiet']);
  assert.equal(
    gate.getStatus().errors[0],
    'gate.json loaded. gate.json has "defaultBehavior", which the gate doesn\'t read, so it does nothing. Its fields are "default" and "policies". '
    + `Rule "ops": match has "channelNote", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}. `
    + 'Rule "quiet": it has "matchTags" (did you mean "match"?), which the gate doesn\'t read, so the rule matches every event. '
    + 'Read so, it skips every event it now matches, as earlier releases did.',
  );
  assert.equal(gate.evaluate(MENTION).trigger, false, '"quiet" skips every event');
  // A change refuses the slip, and takes the extra beside its field, naming it.
  assert.equal(refusal(gate, quiet), 'Rule "quiet" wasn\'t saved: it has "matchTags" (did you mean "match"?), which the gate doesn\'t read.');
  let ignored: string[] = [];
  gate.addPolicy({ ...ops, name: 'ops2' }, { onIgnoredFields: (notes) => { ignored = notes; } });
  assert.deepEqual(ignored, [`Rule "ops2": match has "channelNote", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}.`]);

  // At gate.json's top, a name holding "policies" can be a label of the file,
  // so a file that holds every event back with one is used, as before.
  const held = makeGate(tempDir(t), { file: { default: 'skip', policiesUpdated: '2026-10-17' } });
  assert.equal(held.gate.getStatus().configSource, 'file');
  assert.equal(held.gate.evaluate(MENTION).trigger, false, 'every event is held back, as written');
  assert.equal(
    held.gate.getStatus().errors[0],
    'gate.json loaded. gate.json has "policiesUpdated", which the gate doesn\'t read, so it does nothing. Its fields are "default" and "policies".',
  );
});

test("a field the gate reads at another level is a problem naming where it's read: a load reads past it as earlier releases did, and a change refuses it", (t) => {
  const { gate, configPath } = makeGate(tempDir(t), {
    file: {
      name: 'top',
      policies: [
        { name: 'quiet', tagsAny: ['chat:ambient'], behavior: 'skip' },
        { name: 'ambient', match: { tagsAny: ['chat:ambient'], pattern: 'release' }, behavior: 'skip' },
        { name: 'limited', tokens: 3, refillIntervalMs: 60000 },
        { name: 'keyed', match: { keyBy: 'channelId', behavior: 'skip' }, default: 'skip' },
        // With no match or no behavior, a field of the filter, of a behavior, or of a sample says what its absence does.
        { name: 'filtered', pattern: 'release', behavior: 'skip' },
        { name: 'settling', debounce: 60000 },
        { name: 'sampled', every: 3 },
        MENTIONS,
      ],
    },
  });
  const hereNot = "which the gate doesn't read here";
  const holds = 'Read so, it skips every event it now matches, as earlier releases did.';
  assert.deepEqual(
    names(gate), ['quiet', 'ambient', 'limited', 'keyed', 'filtered', 'settling', 'sampled', 'mentions'], 'each is in force as earlier releases read it',
  );
  assert.deepEqual(gate.getStatus().errors, [
    `gate.json loaded. gate.json has "name", a field of a rule, ${hereNot}, so it does nothing. `
    + `Rule "quiet": it has "tagsAny", a field of "match", ${hereNot}, so the rule matches every event. ${holds} `
    + `Rule "ambient": match has "pattern", a field of "match.filter", ${hereNot}, so it does nothing. ${holds} `
    + `Rule "limited": it has "tokens" and "refillIntervalMs", fields of "behavior.rate_limit", ${hereNot}, so the rule's behavior is "always". `
    + `Rule "keyed": it has "default", a field of gate.json, ${hereNot}, so it does nothing; `
    + `match has "keyBy", a field of "behavior.rate_limit" and "behavior.passive_sample", ${hereNot}, so it does nothing; `
    + `match has "behavior", a field of a rule, ${hereNot}, so it does nothing. `
    + 'Rule "keyed": nothing left in match narrows the rule, so it matches every event. '
    + `Rule "filtered": it has "pattern", a field of "match.filter", ${hereNot}, so the rule matches every event. ${holds} `
    + `Rule "settling": it has "debounce", a field of "behavior", ${hereNot}, so the rule's behavior is "always". `
    + `Rule "sampled": it has "every", a field of "behavior.passive_sample", ${hereNot}, so the rule's behavior is "always".`,
  ]);
  // As earlier releases read it, "quiet" matches every event and skips it, a mention included.
  assert.equal(gate.evaluate(MENTION).trigger, false);
  // Each is read as they read it: a field at another level gives no behavior, and no match.
  assert.deepEqual(gate.getStatus().policies.map((p) => [p.name, p.behavior]), [
    ['quiet', 'skip'], ['ambient', 'skip'], ['limited', 'always'], ['keyed', 'always'], ['filtered', 'skip'], ['settling', 'always'],
    ['sampled', 'always'], ['mentions', 'always'],
  ]);
  // So "filtered", alone, skips an event that doesn't hold its pattern too.
  const { gate: filtered } = makeGate(tempDir(t), { file: { policies: [{ name: 'filtered', pattern: 'release', behavior: 'skip' }] } });
  assert.equal(filtered.evaluate({ ...MENTION, content: 'standup notes' }).trigger, false);
  filtered.dispose();

  // A change, whose caller is there to fix it, refuses each, naming where it's read.
  const before = readFileSync(configPath, 'utf-8');
  for (const [fields, problem] of [
    [{ tagsAny: ['chat:ambient'], behavior: 'skip' }, `it has "tagsAny", a field of "match", ${hereNot}`],
    [{ match: { tagsAny: ['chat:ambient'], pattern: 'release' }, behavior: 'skip' }, `match has "pattern", a field of "match.filter", ${hereNot}`],
    [{ debounce: 60000 }, `it has "debounce", a field of "behavior", ${hereNot}`],
    [{ behavior: { rate_limit: { tokens: 3, refillIntervalMs: 60000, every: 2 } } }, `behavior.rate_limit has "every", a field of "behavior.passive_sample", ${hereNot}`],
  ] as const) {
    assert.equal(refusal(gate, fields), `Rule "r" wasn't saved: ${problem}.`, JSON.stringify(fields));
  }
  assert.equal(readFileSync(configPath, 'utf-8'), before, 'nothing was saved');

  // In the host's starting rules, the file's own field is named as the starting config's.
  const { gate: started } = makeGate(tempDir(t), { initialConfig: { default: 'skip', policies: [{ ...MENTIONS, default: 'skip' }] } });
  assert.deepEqual(started.getStatus().errors, [
    `gate.json loaded. Rule "mentions": it has "default", a field of gate.json, ${hereNot}, so it does nothing.`,
    `In the host's starting rules, Rule "mentions": it has "default", a field of the starting config, ${hereNot}, so it does nothing.`,
  ]);
  assert.equal(started.evaluate(MENTION).trigger, true);
  started.dispose();
});

test("gate.json's notes stay with the text in force, though a look at other text cleared them", (t) => {
  const dir = tempDir(t);
  const noted = JSON.stringify({ comment: 'ops', policies: [{ name: 'dm', match: { tagsAny: ['chat:dm'] }, behavior: 'always' }] });
  const { gate, configPath } = makeGate(dir, { file: noted });
  const [note] = gate.getStatus().errors;
  assert.match(note ?? '', /^gate\.json loaded\. gate\.json has "comment"/);

  // Other text, looked at but not applied, then the text in force again.
  writeFileSync(configPath, JSON.stringify({ policies: [{ name: 'dm', match: { tagsAny: ['chat:dm'] }, behavior: 'always' }] }));
  gate.listPolicyNames();
  assert.deepEqual(gate.getStatus().errors, [], 'the look names what the file then held');
  writeFileSync(configPath, noted);
  gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags: [] });
  assert.deepEqual(gate.getStatus().errors, [note], "the reload finds the text in force, with its note");
});

test('every field the gate writes, it reads back', (t) => {
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir);
  const rules: GatePolicy[] = [
    {
      name: 'governor',
      match: {
        scope: ['mcpl:channel-incoming'], source: 'discord', channel: 'discord:*:12345', mount: 'project',
        pathGlob: 'notes/*.md', metadataTrue: ['mentioned'], tagsAny: ['chat:ambient'], tagsAll: ['chat:message'],
        tagsNone: ['chat:bot'], filter: { type: 'regex', pattern: 'release|deploy' },
      },
      behavior: { rate_limit: { tokens: 5, refillIntervalMs: 60000, keyBy: 'channelId' } },
      resets: ['sampler'],
      passthrough: true,
    },
    { name: 'sampler', match: { filter: { type: 'text', pattern: 'ship' } }, behavior: { passive_sample: { every: 10, keyBy: 'channelId' } }, passthrough: true },
    { name: 'quiet', match: {}, behavior: { debounce: 30000 } },
    { name: 'later', match: {}, behavior: 'defer' },
  ];
  for (const rule of rules) gate.addPolicy(rule);
  const written = onDisk(configPath);
  assert.deepEqual(written.policies, rules);

  const { gate: reread } = makeGate(dir);
  assert.deepEqual(reread.getStatus().errors, []);
  assert.deepEqual(names(reread), rules.map((r) => r.name));
  // What it loaded is what it holds in memory: a later write keeps those rules as they were.
  reread.addPolicy({ name: 'last', behavior: 'always' });
  assert.deepEqual(onDisk(configPath).policies.slice(0, rules.length), rules);
});

test('a change keeps every rule it doesn\'t change as written, problems and unknown fields included, so nothing the operator wrote is lost', (t) => {
  const dir = tempDir(t);
  const theirs = {
    comment: 'ops',
    default: 'skip',
    policies: [
      { name: 'mine', behavior: 'deffer' },
      { name: 'gone', behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } } },
      MENTIONS,
      { name: 'blank', match: { source: '' }, behavior: 'defer', why: 'quiet hours' },
    ],
  };
  const { gate, configPath } = makeGate(dir, { file: theirs });
  const [note] = gate.getStatus().errors;
  assert.match(note ?? '', /^gate\.json loaded\. gate\.json has "comment".* Rule "mine": .* Rule "gone" is left out: .* Rule "blank" has "why"/);

  gate.addPolicy({ name: 'later', behavior: 'defer' });
  assert.deepEqual(onDisk(configPath), { ...theirs, policies: [...theirs.policies, { name: 'later', match: {}, behavior: 'defer' }] });
  assert.deepEqual(names(gate), ['mine', 'mentions', 'blank', 'later']);
  assert.deepEqual(gate.getStatus().errors, [note], 'what gate.json still holds is still named');

  // A rule of a name the file holds is replaced in place, the one left out included, and a rule can anchor on it.
  gate.addPolicy({ name: 'gone', behavior: { rate_limit: { tokens: 2, refillIntervalMs: 1000 } } });
  gate.addPolicy({ name: 'first', behavior: 'always' }, { position: { before: 'gone' } });
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mine', 'first', 'gone', 'mentions', 'blank', 'later']);
  assert.deepEqual(onDisk(configPath).policies[2], { name: 'gone', match: {}, behavior: { rate_limit: { tokens: 2, refillIntervalMs: 1000 } } });
  assert.deepEqual(onDisk(configPath).policies[0], theirs.policies[0], 'the rules it left alone are as written');

  // removePolicy edits the same list: the rest stay as written.
  assert.equal(gate.removePolicy('mine'), true);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['first', 'gone', 'mentions', 'blank', 'later']);
  assert.deepEqual(onDisk(configPath).policies[3], theirs.policies[3]);
  assert.equal(onDisk(configPath).comment, 'ops');
  assert.deepEqual(readdirSync(dir), ['gate.json'], 'nothing else is written beside it');

  // A rule the gate leaves out, which isn't in force, can be removed by name.
  writeFileSync(configPath, JSON.stringify({ policies: [{ name: 'broken', behavior: { rate_limit: { tokens: 0, refillIntervalMs: 1000 } } }, MENTIONS] }));
  assert.equal(gate.removePolicy('broken'), true);
  assert.deepEqual(onDisk(configPath).policies, [MENTIONS]);
});

test('a change refuses, writing nothing, where gate.json has no rule list it could edit without writing over what it holds', (t) => {
  for (const [file, what, defaultBehavior] of [
    [[{ name: 'dm', behavior: 'always' }], 'gate.json is a list', 'always'],
    [{ policies: { name: 'dm', behavior: 'always' } }, 'gate.json\'s "policies" is {"name":"dm","behavior":"always"}', 'always'],
    // Whatever its default: under "skip" it loads holding every event back, and its rules are still the operator's.
    [{ default: 'skip', policies: { name: 'dm', behavior: 'always' } }, 'gate.json\'s "policies" is {"name":"dm","behavior":"always"}', 'skip'],
  ] as Array<[unknown, string, string]>) {
    const { gate, configPath } = makeGate(tempDir(t), { file });
    const before = readFileSync(configPath, 'utf-8');
    // It loads with no rules, so the refusal says every event gets its default.
    const message = `${what}, so it has no list of rules a change could edit without writing over what it holds, and nothing `
      + `was saved. Meanwhile the gate runs no rules: every event gets the default, "${defaultBehavior}". Until gate.json, at `
      + `${configPath}, is an object whose "policies" is a list holding its rules, a change is refused the same way.`;
    assert.throws(() => gate.addPolicy({ name: 'later', behavior: 'defer' }), { message }, JSON.stringify(file));
    // A removal is a change: the file holds "dm", in a form no change can edit,
    // and a name it may not hold is refused the same way, since that can't be told.
    assert.throws(() => gate.removePolicy('dm'), { message }, JSON.stringify(file));
    assert.throws(() => gate.removePolicy('absent'), { message }, JSON.stringify(file));
    assert.equal(readFileSync(configPath, 'utf-8'), before);
    gate.dispose();
  }

  // Rules under a slip of "policies" or under another name, and a rule's
  // fields at the top, are left as written: a change adds a "policies" list
  // beside them, as it adds one to a file with none, and a removal of a name
  // only they hold removes nothing, since the gate holds no rule by it.
  const dm = { name: 'dm', behavior: 'always' };
  for (const file of [
    { polices: [dm] },
    { default: 'skip', polices: [dm] },
    { default: 'skip', policies: {}, polices: [dm] },
    { policies: [], polices: [dm] },
    { policy: [dm] },
    { default: 'skip', rules: [dm] },
    { default: 'defer', policies: [], rules: [dm] },
    { default: 'defer', name: 'dm', behavior: 'always' },
    { default: 'skip', policies: [], name: 'dm', behavior: 'always' },
    { default: 'skip', source: 'written by ops' },
  ] as Array<Record<string, unknown>>) {
    const { gate, configPath } = makeGate(tempDir(t), { file });
    const before = readFileSync(configPath, 'utf-8');
    assert.equal(gate.removePolicy('dm'), false, JSON.stringify(file));
    assert.equal(readFileSync(configPath, 'utf-8'), before);
    gate.addPolicy({ name: 'later', behavior: 'defer' });
    assert.deepEqual(onDisk(configPath), { ...file, policies: [{ name: 'later', match: {}, behavior: 'defer' }] }, JSON.stringify(file));
    assert.deepEqual(names(gate), ['later']);
    gate.dispose();
  }
});

test("the host's starting rules are read rule by rule: a first start writes them as given and runs each as read, leaving out only what it must", (t) => {
  const usable: GateConfig = { default: 'skip', policies: [{ name: 'user-input', match: { scope: ['user:message'] }, behavior: 'always' }] };
  const clean = makeGate(tempDir(t), { initialConfig: usable });
  assert.deepEqual(onDisk(clean.configPath), usable, 'as given');
  assert.deepEqual(clean.gate.getStatus().errors, []);
  assert.equal(clean.gate.getStatus().configSource, 'file');

  const userInput = { name: 'user-input', match: { scope: ['user:message'] }, behavior: 'always', comment: 'from the recipe' };
  const starting = {
    default: 'skip',
    policies: [
      userInput,
      { name: 'typo', match: { tagsAny: ['chat:ambient'] }, behavior: 'deffer' },
      { name: 'quiet', match: { tagsAny: 'chat:bot' }, behavior: 'skip' },
      { name: 'fast', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 50 } },
    ],
  };
  const { gate, configPath } = makeGate(tempDir(t), { initialConfig: starting });
  // Each is read on its own: the user's input wakes the agent, a typo is read as
  // "always", a rule that skips with a problem as it was, and a debounce out of
  // range at its bound.
  assert.deepEqual(names(gate), ['user-input', 'typo', 'quiet', 'fast']);
  assert.equal(gate.evaluate(event([], 'user:message')).trigger, true);
  assert.equal(gate.evaluate(event(['chat:ambient'])).trigger, true);
  // gate.json holds them as given, and is read the same way, so its load names each problem as the start does.
  assert.deepEqual(onDisk(configPath), starting);
  const said = `Rule "user-input" has "comment", which the gate doesn't read, so it does nothing. Its fields are ${POLICY_FIELDS}. `
    + `Rule "typo": behavior is "deffer", where ${BEHAVIORS} is needed, so it's read as "always". `
    + 'Rule "quiet": match.tagsAny is "chat:bot", where a list of non-empty strings is needed, such as ["chat:ambient"], so the rule is '
    + `read without it. Read so, it skips every event it now matches, as earlier releases did. ${everyEvent('Rule "quiet"')} `
    + 'Rule "fast": behavior.debounce is 50 ms, under the 100 ms minimum, so it\'s read as 100 ms.';
  assert.deepEqual(gate.getStatus().errors, [`gate.json loaded. ${said}`, `In the host's starting rules, ${said}`]);
  gate.dispose();

  // The starting config as a whole is read as gate.json is: one whose
  // "policies" isn't a list loads with no rules under its default, as it ran,
  // and gate.json holds it as given,
  const notList = { default: 'skip', policies: { name: 'user-input' } };
  const whole = makeGate(tempDir(t), { initialConfig: notList });
  const noList = '"policies" is {"name":"user-input"}, where a list of rules is needed, such as [{"name": "my-rule", "behavior": "always"}], '
    + 'and it has no rules, so under its default, "skip", every event is held back.';
  assert.deepEqual(whole.gate.getStatus().errors, [`gate.json loaded. gate.json's ${noList}`, `In the host's starting rules, The starting config's ${noList}`]);
  assert.deepEqual(onDisk(whole.configPath), notList);
  assert.equal(whole.gate.evaluate(event([], 'user:message')).trigger, false);
  whole.gate.dispose();
  // and one that leaves out a rule that could wake the agent, under a default that holds events back, isn't used.
  const leavesOut = makeGate(tempDir(t), { initialConfig: { default: 'skip', policies: [{ name: 'user-input', behavior: [] }] } });
  assert.deepEqual(leavesOut.gate.getStatus().errors, [
    'At start, the host\'s starting rules weren\'t used: the starting config leaves out a rule that could wake the agent, and under its '
    + `default, "skip", what it was written to wake it on would be held back. Rule "user-input" is left out: behavior is [], where ${BEHAVIORS} `
    + 'is needed. The gate started with no rules, as on a host without starting rules.',
  ]);
  assert.equal(existsSync(leavesOut.configPath), false);
  leavesOut.gate.dispose();
  // One that's a list loaded as no rules under "always", which wakes, so it's read that way.
  const list = makeGate(tempDir(t), { initialConfig: [usable.policies[0]] });
  assert.deepEqual(onDisk(list.configPath), [usable.policies[0]]);
  assert.deepEqual(names(list.gate), []);
  const isList = 'is a list, where an object is needed, such as {"policies": [{"name": "my-rule", "behavior": "always"}]}, so none of it '
    + 'is read, and every event gets the default, "always".';
  assert.deepEqual(list.gate.getStatus().errors, [`gate.json loaded. gate.json ${isList}`, `In the host's starting rules, The starting config ${isList}`]);
});

test('a first start that can\'t create gate.json runs the starting rules, and says they aren\'t saved in it until it\'s written', {
  skip: permissionsHold ? false : 'needs file permissions that hold (not Windows, not root)',
}, (t) => {
  const dir = tempDir(t);
  chmodSync(dir, 0o555);
  const starting: GateConfig = { default: 'skip', policies: [{ name: 'user-input', match: { scope: ['user:message'] }, behavior: 'always' }] };
  const { gate, configPath } = makeGate(dir, { initialConfig: starting });
  assert.equal(existsSync(configPath), false);
  const status = gate.getStatus();
  assert.equal(status.configSource, 'initial');
  assert.equal(status.default, 'skip');
  assert.deepEqual(names(gate), ['user-input']);
  assert.equal(status.errors.length, 1);
  assert.match(status.errors[0]!, /^At start, gate\.json couldn't be created \(EACCES[^)]*\), so the host's starting rules are in force but aren't saved in it\. Whoever runs this host can fix what keeps it from being written\.$/);

  // Someone writes gate.json, and a reload applies it: the rules in force are its own.
  chmodSync(dir, 0o755);
  writeFileSync(configPath, JSON.stringify(starting));
  gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags: [] });
  assert.equal(gate.getStatus().configSource, 'file');
  assert.deepEqual(gate.getStatus().errors, [], 'nothing in force is unsaved now');
});

test('a first start whose write of the starting rules fails partway runs them, and says gate.json may be part-written', (t) => {
  const dir = tempDir(t);
  const starting: GateConfig = { default: 'skip', policies: [{ name: 'user-input', match: { scope: ['user:message'] }, behavior: 'always' }] };
  const original = fs.writeFileSync;
  // The disk fills partway through the seed's write.
  const write = t.mock.method(fs, 'writeFileSync', (path: unknown, data: unknown) => {
    original(path as string, typeof data === 'string' ? data.slice(0, Math.floor(data.length / 2)) : '');
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
  });
  syncBuiltinESMExports();
  let gate: EventGate;
  let configPath: string;
  try {
    ({ gate, configPath } = makeGate(dir, { initialConfig: starting }));
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(gate.getStatus().configSource, 'initial');
  assert.deepEqual(names(gate), ['user-input']);
  const [fileError, unsaved, ...rest] = gate.getStatus().errors;
  // The part-written file's own error: what JSON.parse says of the half the write left.
  let parsed = '';
  try {
    JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    parsed = (err as Error).message;
  }
  assert.notEqual(parsed, '', 'the half written is not JSON');
  assert.equal(fileError, notJsonShown(configPath, parsed, "the host's starting rules"));
  assert.equal(unsaved, 'At start, writing the host\'s starting rules to gate.json failed partway (ENOSPC: no space left on device, write), so '
    + 'gate.json may be left part-written. The starting rules are in force but aren\'t saved in it, and a restart before gate.json '
    + 'is fixed starts from them too. Whoever runs this host can fix what kept it from being written, and gate.json.');
  assert.deepEqual(rest, []);
});

test("a later start adds the starting rules gate.json lacks by name, as given, keeping its own as written; one that can't load runs the starting rules", (t) => {
  const tickets = { name: 'tickets', match: { scope: ['workspace:modified'] }, behavior: 'always' };
  const reviews = { name: 'reviews', match: {}, behavior: 'wake' };
  const quick = { name: 'quick', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 50 } };
  const starting = { default: 'skip', policies: [{ name: 'user-input', match: {}, behavior: 'always' }, tickets, reviews, quick] };
  const read = `Rule "reviews": behavior is "wake", where ${BEHAVIORS} is needed, so it's read as "always". `
    + 'Rule "quick": behavior.debounce is 50 ms, under the 100 ms minimum, so it\'s read as 100 ms.';
  const added = makeGate(tempDir(t), { file: { default: 'skip', policies: [{ name: 'user-input', match: {}, behavior: 'always' }] }, initialConfig: starting });
  assert.deepEqual(onDisk(added.configPath).policies, starting.policies);
  assert.deepEqual(names(added.gate), ['user-input', 'tickets', 'reviews', 'quick']);
  assert.deepEqual(added.gate.getStatus().errors, [`gate.json loaded. ${read}`, `In the host's starting rules, ${read}`]);
  added.gate.dispose();

  // gate.json's own rules stay as written, problems included, and the starting rules it lacks join them.
  const theirs = { default: 'skip', policies: [{ name: 'mine', behavior: 'deffer' }, { name: 'gone', behavior: 'defer', passthrough: true }] };
  const over = makeGate(tempDir(t), { file: theirs, initialConfig: { default: 'skip', policies: [tickets] } });
  assert.deepEqual(onDisk(over.configPath), { ...theirs, policies: [...theirs.policies, tickets] });
  assert.deepEqual(names(over.gate), ['mine', 'tickets']);
  assert.match(over.gate.getStatus().errors[0] ?? '', /^gate\.json loaded\. Rule "mine": .* Rule "gone" is left out: /);

  // A "policies" holding nothing writes no rules, as [] does, so the starting rules go in its place.
  const empty = makeGate(tempDir(t), { file: { default: 'always', policies: {} }, initialConfig: { default: 'skip', policies: [tickets] } });
  assert.deepEqual(onDisk(empty.configPath), { default: 'always', policies: [tickets] });
  assert.deepEqual(names(empty.gate), ['tickets']);
  empty.gate.dispose();

  const unloadable = makeGate(tempDir(t), { file: '{"policies": [', initialConfig: starting });
  const status = unloadable.gate.getStatus();
  assert.equal(status.configSource, 'initial', 'the starting rules, where it used to say "default"');
  assert.equal(status.default, 'skip');
  assert.deepEqual(names(unloadable.gate), ['user-input', 'tickets', 'reviews', 'quick']);
  unloadable.gate.dispose();
});

test("a rule gate.json holds keeps its name from the host's starting rules, read past a problem or left out, through a change and the next start", (t) => {
  // The recipe seeds a rule that skips all ambient chat; the operator narrowed
  // it to Zulip, with an empty entry the gate drops, as it did before. Under
  // the operator's "always" default, Discord's ambient chat woke the agent
  // before, and must still: the recipe's rule of that name isn't added.
  const recipe = { default: 'skip', policies: [{ name: 'ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'skip' }] };
  const operators = { name: 'ambient', match: { source: 'zulip', tagsAny: ['chat:ambient', ''] }, behavior: 'skip' };
  const dir = tempDir(t);
  const { gate, configPath } = makeGate(dir, { file: { default: 'always', policies: [operators] }, initialConfig: recipe });
  assert.deepEqual(onDisk(configPath).policies, [operators], 'nothing was added');
  assert.deepEqual(names(gate), ['ambient']);
  assert.equal(gate.evaluate({ ...event(['chat:ambient']), serverId: 'zulip' }).trigger, false, 'Zulip\'s ambient chat is skipped, as before');
  const discordAmbient = event(['chat:ambient']);
  assert.equal(gate.evaluate(discordAmbient).trigger, true);

  // A change keeps the operator's rule as written, so the next start still finds its name.
  gate.addPolicy({ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' });
  assert.deepEqual(onDisk(configPath).policies[0], operators);
  const { gate: restarted } = makeGate(dir, { initialConfig: recipe });
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['ambient', 'mentions']);
  assert.equal(restarted.evaluate(discordAmbient).trigger, true);

  // A change over a gate.json that won't load, mid-edit, is refused, and the edit stays as it is.
  const midEdit = '{"default": "always", "policies": [';
  writeFileSync(configPath, midEdit);
  assert.throws(() => restarted.addPolicy({ name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always' }), { message: /^gate\.json, at .*, isn't JSON the gate can read \(/ });
  assert.equal(readFileSync(configPath, 'utf-8'), midEdit);
  // Once gate.json is gone, a change edits the text whose rules are in force, as written, so the operator's rule keeps its name.
  rmSync(configPath);
  restarted.addPolicy({ name: 'dms', match: { tagsAny: ['chat:dm'] }, behavior: 'always' });
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['ambient', 'mentions', 'dms']);
  assert.deepEqual(onDisk(configPath).policies[0], operators);
  const { gate: again } = makeGate(dir, { initialConfig: recipe });
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['ambient', 'mentions', 'dms'], 'nothing was added');
  assert.equal(again.evaluate(discordAmbient).trigger, true);
  // And a removal, once gate.json is gone, finds the rule that text holds, by its name.
  rmSync(configPath);
  assert.equal(again.removePolicy('ambient'), true);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'dms']);

  // A rule the gate leaves out holds its name too: here one that skips with a
  // passthrough, which earlier releases refused, so Discord's ambient chat wakes
  // the agent under "always" rather than meeting the recipe's rule.
  const leftOut = { name: 'ambient', match: { source: 'zulip' }, behavior: 'skip', passthrough: true };
  const held = makeGate(tempDir(t), { file: { default: 'always', policies: [leftOut] }, initialConfig: recipe });
  assert.deepEqual(onDisk(held.configPath).policies, [leftOut], 'nothing was added');
  assert.deepEqual(names(held.gate), []);
  assert.equal(held.gate.evaluate(discordAmbient).trigger, true);
  held.gate.dispose();
});

test("a later start over a gate.json with no rule list it could add to without writing over what it holds runs the starting rules it lacks beside it, under its default and unsaved, and says so until gate.json changes and loads; where they can't run beside it, gate.json isn't used at that start, which runs as one without it does", (t) => {
  const unsaved = (rules: string, why: string, defaultBehavior: string): string =>
    `At start, the host's starting rules ${rules} couldn't be added to gate.json (${why}, so there's no list of rules to add them to `
    + `without writing over what it holds). The gate runs them under gate.json's default, "${defaultBehavior}", as if gate.json held `
    + "them, but they aren't saved in it: once gate.json changes and loads, what it holds is in force instead. Once gate.json has a "
    + 'list of rules under "policies", a start adds them to it, as to any gate.json with a list.';
  const notPut = (rules: string, why: string): string =>
    `At start, the host's starting rules ${rules} couldn't be added to gate.json (${why}), so they weren't put in force. `
    + 'A start adds them once what kept them out is fixed.';
  const listRead = 'gate.json is a list, where an object is needed, such as {"policies": [{"name": "my-rule", "behavior": "always"}]}, '
    + 'so none of it is read, and ';
  const noListWhy = 'so there\'s no list of rules to add them to without writing over what it holds';

  // A list, read as no rules under "always": the starting rule that skips ambient chat runs, as it did once written over the file.
  // One the starting rules leave out, under their own "always", is named so there, and not as one that runs.
  const quietAmbient = { name: 'quiet-ambient', match: { tagsAny: ['chat:ambient'] }, behavior: 'skip' };
  const limited = { name: 'limited', match: {}, behavior: { rate_limit: { refillIntervalMs: 60000 } } };
  const { gate, configPath } = makeGate(tempDir(t), {
    file: [{ name: 'dm', behavior: 'always' }],
    initialConfig: { default: 'always', policies: [quietAmbient, limited] },
  });
  assert.deepEqual(onDisk(configPath), [{ name: 'dm', behavior: 'always' }], 'gate.json is as it was');
  // What the start says, before any event or reload check.
  const errors = gate.getStatus().errors;
  assert.deepEqual(names(gate), ['quiet-ambient']);
  assert.equal(gate.evaluate(event(['chat:ambient'])).trigger, false, 'ambient chat is skipped');
  assert.equal(gate.evaluate(MENTION).trigger, true, 'and the rest gets gate.json\'s default, "always"');
  assert.equal(gate.getStatus().configSource, 'initial', 'what runs is the host\'s starting rules');
  assert.equal(errors[0], `gate.json loaded. ${listRead}the gate runs the host's starting rules beside it, under the default, "always".`);
  assert.ok(errors[1]!.startsWith('In the host\'s starting rules, Rule "limited" is left out'), errors[1]);
  assert.equal(errors[2], unsaved('"quiet-ambient"', 'gate.json is a list', 'always'));
  assert.equal(errors.length, 3);
  gate.dispose();

  // A "policies" that isn't a list, under "skip": the mention rule wakes the agent, as it did once written over the file.
  const object = { default: 'skip', policies: { name: 'dm', behavior: 'always' } };
  const shown = 'gate.json\'s "policies" is {"name":"dm","behavior":"always"}';
  const noList = makeGate(tempDir(t), { file: object, initialConfig: { default: 'skip', policies: [MENTIONS] } });
  t.after(() => noList.gate.dispose());
  assert.deepEqual(onDisk(noList.configPath), object, 'gate.json is as it was');
  assert.equal(noList.gate.evaluate(MENTION).trigger, true);
  const said = [
    `gate.json loaded. ${shown}, where a list of rules is needed, such as [{"name": "my-rule", "behavior": "always"}], and it has no rules, `
    + 'so the gate runs the host\'s starting rules beside it, under its default, "skip".',
    unsaved('"mentions"', shown, 'skip'),
  ];
  assert.deepEqual(noList.gate.getStatus().errors, said);
  // A change, refused for want of a list, leaves gate.json's entry saying what's in force, and a listing names the rules in force.
  assert.throws(() => noList.gate.addPolicy({ name: 'dm', behavior: 'always' }),
    /so it has no list of rules a change could edit .* Meanwhile the gate runs the host's starting rules\. /);
  assert.deepEqual(noList.gate.getStatus().errors, said);
  assert.deepEqual(noList.gate.listPolicyNames(), ['mentions']);
  // A reload that finds gate.json unchanged keeps them, and says so still.
  (noList.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(noList.gate.evaluate(MENTION).trigger, true);
  assert.deepEqual(noList.gate.getStatus().errors, said);
  // So does one that finds it changed to text that won't load, which names the starting rules as what runs.
  writeFileSync(noList.configPath, '{"default": "skip", "policies": [');
  (noList.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(noList.gate.evaluate(MENTION).trigger, true);
  const [unloadable, ...rest] = noList.gate.getStatus().errors;
  assert.match(unloadable!, /So what gate\.json holds isn't in force, and the gate runs the host's starting rules\. Once it's JSON, the gate reads it again at its next check for changes\.$/);
  assert.deepEqual(rest, [said[1]]);
  // Once gate.json changes and loads, what it holds is in force instead.
  writeFileSync(noList.configPath, JSON.stringify({ default: 'skip', policies: [] }));
  (noList.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(noList.gate.evaluate(MENTION).trigger, false);
  assert.deepEqual(names(noList.gate), []);
  assert.deepEqual(noList.gate.getStatus().errors, []);

  // Where, under gate.json's default, one of them left out could wake the agent, gate.json isn't used at this start, which
  // runs the starting rules under their own default, as one without gate.json does, and as earlier releases did once what
  // they wrote over it wouldn't load.
  const without = makeGate(tempDir(t), { file: object, initialConfig: { default: 'always', policies: [limited, MENTIONS] } });
  t.after(() => without.gate.dispose());
  assert.deepEqual(onDisk(without.configPath), object, 'gate.json is as it was');
  const withoutSaid = without.gate.getStatus().errors;
  assert.deepEqual(names(without.gate), ['mentions']);
  assert.equal(without.gate.evaluate(MENTION).trigger, true);
  assert.equal(without.gate.evaluate(event(['chat:ambient'])).trigger, true, 'and the rest gets their default, "always"');
  assert.equal(without.gate.getStatus().configSource, 'initial');
  const fixLimited = 'Giving gate.json rules under "policies", or fixing "limited" in the starting rules, puts it in use '
    + '(a fix to the starting rules, at the next start)';
  assert.equal(withoutSaid[0], `gate.json loaded. ${shown}, where a list of rules is needed, such as [{"name": "my-rule", "behavior": "always"}], `
    + 'and it has no rules, so it isn\'t used at this start: under its default, "skip", the host\'s starting rules would '
    + 'leave out "limited", which could wake the agent, so the gate runs the starting rules under their own default, "always", as '
    + `a start without gate.json does. ${fixLimited}.`);
  assert.ok(withoutSaid[1]!.startsWith('In the host\'s starting rules, Rule "limited" is left out'), withoutSaid[1]);
  assert.equal(withoutSaid[2], 'At start, gate.json, which has no rules the gate reads, wasn\'t used: under its default, "skip", the host\'s starting '
    + 'rules would leave out "limited", which could wake the agent. The gate runs the starting rules under their own default, '
    + '"always", as a start without gate.json does, but they aren\'t saved in it: once gate.json changes and loads, what it holds '
    + `is in force instead. ${fixLimited}.`);
  assert.equal(withoutSaid.length, 3);
  // A reload that finds gate.json unchanged keeps them, and says so still; once it changes and loads, what it holds is in force.
  (without.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(without.gate.evaluate(event(['chat:ambient'])).trigger, true);
  assert.deepEqual(without.gate.getStatus().errors, withoutSaid);
  writeFileSync(without.configPath, JSON.stringify({ default: 'skip', policies: [] }));
  (without.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(without.gate.evaluate(MENTION).trigger, false);
  assert.equal(without.gate.getStatus().configSource, 'file');
  assert.deepEqual(without.gate.getStatus().errors, [withoutSaid[1]]);

  // Starting rules refused whole under their own "skip" leave nothing to run beside it, so gate.json, whose "skip" would hold
  // back every event, isn't used at this start either, and it runs no rules, as one without gate.json does.
  const neither = makeGate(tempDir(t), { file: object, initialConfig: { default: 'skip', policies: [limited, MENTIONS] } });
  t.after(() => neither.gate.dispose());
  assert.deepEqual(onDisk(neither.configPath), object, 'gate.json is as it was');
  const neitherSaid = neither.gate.getStatus().errors;
  assert.deepEqual(names(neither.gate), []);
  assert.equal(neither.gate.evaluate(event(['chat:ambient'])).trigger, true, 'every event wakes the agent');
  assert.equal(neither.gate.getStatus().configSource, 'default');
  const fixStarting = 'Giving gate.json rules under "policies", or fixing the starting rules, puts rules in force (a fix to the '
    + 'starting rules, at the next start).';
  assert.equal(neitherSaid[0], `gate.json loaded. ${shown}, where a list of rules is needed, such as [{"name": "my-rule", "behavior": "always"}], `
    + 'and it has no rules, so under its default, "skip", it would hold back every event: it isn\'t used at this start, and the gate '
    + `runs no rules, as a start without gate.json does, so every event gets the default, "always". ${fixStarting}`);
  assert.ok(neitherSaid[1]!.startsWith('At start, the host\'s starting rules weren\'t used: the starting config leaves out a rule'), neitherSaid[1]);
  assert.ok(neitherSaid[1]!.endsWith(' gate.json, which has no rules the gate reads, wasn\'t used either: under its default, "skip", it would hold back '
    + `every event, so the gate started with no rules, as a start without gate.json does. ${fixStarting}`), neitherSaid[1]);
  assert.equal(neitherSaid.length, 2);

  // Where every one of them is left out, none runs; and where the starting rules aren't used beside a gate.json whose
  // default is "always", which holds nothing back, gate.json's own reading runs: no rules, every event waking the agent.
  const allOut = makeGate(tempDir(t), { file: [{ name: 'dm', behavior: 'always' }], initialConfig: { default: 'always', policies: [limited] } });
  assert.deepEqual(names(allOut.gate), []);
  assert.ok(allOut.gate.getStatus().errors.some((e) => e.endsWith(notPut('"limited"', `gate.json is a list, ${noListWhy}`))),
    JSON.stringify(allOut.gate.getStatus().errors));
  allOut.gate.dispose();
  const notUsed = makeGate(tempDir(t), { file: { policies: object.policies }, initialConfig: { default: 'skip', policies: [limited, MENTIONS] } });
  assert.deepEqual(names(notUsed.gate), []);
  assert.ok(notUsed.gate.getStatus().errors.some((e) => e.includes("The gate started with gate.json's rules.")), JSON.stringify(notUsed.gate.getStatus().errors));
  assert.equal(notUsed.gate.evaluate(event(['chat:ambient'])).trigger, true);
  notUsed.gate.dispose();
  // And beside a gate.json with a list of its own, starting rules refused whole leave its rules in force, under "skip" too.
  const ownList = makeGate(tempDir(t), { file: { default: 'skip', policies: [MENTIONS] }, initialConfig: { default: 'skip', policies: [limited, MENTIONS] } });
  assert.deepEqual(names(ownList.gate), ['mentions']);
  assert.equal(ownList.gate.getStatus().configSource, 'file');
  assert.ok(ownList.gate.getStatus().errors.some((e) => e.includes("The gate started with gate.json's rules.")), JSON.stringify(ownList.gate.getStatus().errors));
  ownList.gate.dispose();

  // Beside rules under a name it doesn't read, which stay as written, it adds them in a "policies" list, as to a file with none.
  const theirs = { rules: [{ name: 'dm', behavior: 'always' }] };
  const userInput = { name: 'user-input', match: {}, behavior: 'always' };
  const beside = makeGate(tempDir(t), { file: theirs, initialConfig: { default: 'skip', policies: [userInput] } });
  assert.deepEqual(onDisk(beside.configPath), { ...theirs, policies: [userInput] });
  assert.deepEqual(names(beside.gate), ['user-input']);
  beside.gate.dispose();
});

test("a later start over a gate.json with a rule list but no rules of its own, where a starting rule that could wake the agent under its default can't be put in force or the starting rules are refused whole, runs as one without gate.json does and refuses a change until gate.json changes; one with rules of its own keeps them in force", (t) => {
  const limited = { name: 'limited', match: {}, behavior: { rate_limit: { refillIntervalMs: 60000 } } };
  const quiet = { name: 'quiet', match: {}, behavior: { rate_limit: { tokens: 0, refillIntervalMs: 60000 } } };
  // What gate.json's note says after "it has no rules, so", and the start's entry, for each reason starting rules can't be
  // put in force and what would put them in force.
  // A fix to the starting rules puts gate.json in use from the next start.
  const next = (fix: string): string => (fix.includes(' in the starting rules') ? ' (a fix to the starting rules, at the next start)' : '');
  const notUsedFor = (why: string, fix: string): string => `it isn't used at this start: under its default, "skip", ${why}, so `
    + 'the gate runs the starting rules under their own default, "always", as a start without gate.json does. Giving gate.json '
    + `rules under "policies", or ${fix}, puts it in use${next(fix)}`;
  const startSaidFor = (why: string, fix: string): string => `At start, gate.json, which has no rules the gate reads, wasn't used: under its default, `
    + `"skip", ${why}. The gate runs the starting rules under their own default, "always", as a start without gate.json does, but `
    + 'they aren\'t saved in it: once gate.json changes and loads, what it holds is in force instead. Giving gate.json rules '
    + `under "policies", or ${fix}, puts it in use${next(fix)}.`;
  const limitedOut = 'the host\'s starting rules would leave out "limited", which could wake the agent';
  const notUsed = notUsedFor(limitedOut, 'fixing "limited" in the starting rules');
  const startSaid = startSaidFor(limitedOut, 'fixing "limited" in the starting rules');
  const refusedRunning = (runs: string, path: string): string => `gate.json, at ${path}, isn't used at this start, which runs as one without it does, and `
    + `a change would put gate.json's rules in force in place of what that runs, so nothing was saved. Meanwhile the gate runs ${runs}. `
    + 'gate_status says what keeps gate.json out of use and what would put it in use, such as giving it rules under "policies", or '
    + 'fixing the starting rules, which whoever runs this host can do, for the next start; until then, a change is refused the same way.';
  // Where the start runs the host's starting rules in gate.json's place.
  const refused = (path: string): string => refusedRunning("the host's starting rules", path);

  // An empty list, a "policies" left out, "" or holding nothing, and a list holding only a rule the gate leaves out: none
  // has rules of its own, so under its "skip", beside starting rules under "always" with one left out that could wake the
  // agent, it isn't used at this start, which runs them, as earlier releases did once what they added to it wouldn't load.
  const cases: Array<[unknown, string]> = [
    [{ default: 'skip', policies: [] }, `gate.json loaded. gate.json has no rules, so ${notUsed}.`],
    [{ default: 'skip' }, `gate.json loaded. gate.json has no rules, so ${notUsed}.`],
    [{ default: 'skip', policies: '' }, `gate.json loaded. gate.json has "policies" as "", so it's left out: it has no rules, so ${notUsed}.`],
    [{ default: 'skip', policies: {} }, 'gate.json loaded. gate.json\'s "policies" is {}, where a list of rules is needed, such as '
      + `[{"name": "my-rule", "behavior": "always"}], and it has no rules, so ${notUsed}.`],
    [{ default: 'skip', policies: [quiet] }, 'gate.json loaded. Rule "quiet" is left out: behavior.rate_limit.tokens is 0, where a positive '
      + `number is needed. gate.json has no rules but ones the gate leaves out, so ${notUsed}.`],
  ];
  for (const [file, said] of cases) {
    const { gate, configPath } = makeGate(tempDir(t), { file, initialConfig: { default: 'always', policies: [limited, MENTIONS] } });
    t.after(() => gate.dispose());
    const written = readFileSync(configPath, 'utf-8');
    const errors = gate.getStatus().errors;
    assert.equal(errors[0], said);
    assert.ok(errors[1]!.startsWith('In the host\'s starting rules, Rule "limited" is left out'), errors[1]);
    assert.equal(errors[2], startSaid);
    assert.equal(errors.length, 3);
    assert.deepEqual(names(gate), ['mentions']);
    assert.equal(gate.getStatus().configSource, 'initial');
    assert.equal(gate.evaluate(MENTION).trigger, true);
    assert.equal(gate.evaluate(event(['chat:ambient'])).trigger, true, 'and the rest gets their default, "always"');
    // A change is refused, as it would put gate.json's rules in force in place of the starting rules, and gate.json, its
    // entry and the rules in force stay as they were.
    assert.throws(() => gate.addPolicy({ name: 'dm', behavior: 'always' }), { message: refused(configPath) });
    assert.throws(() => gate.removePolicy('mentions'), { message: refused(configPath) });
    assert.equal(readFileSync(configPath, 'utf-8'), written, 'gate.json is as it was');
    assert.deepEqual(gate.getStatus().errors, errors);
    assert.deepEqual(gate.listPolicyNames(), ['mentions']);
    // A reload that finds gate.json unchanged keeps them, and a change is refused still.
    (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    assert.equal(gate.evaluate(event(['chat:ambient'])).trigger, true);
    assert.deepEqual(gate.getStatus().errors, errors);
    assert.throws(() => gate.addPolicy({ name: 'dm', behavior: 'always' }), { message: refused(configPath) });
  }

  // Once gate.json changes, a change edits what it holds, and what it writes is in force, before a reload has applied it too.
  const given = makeGate(tempDir(t), { file: { default: 'skip', policies: [] }, initialConfig: { default: 'always', policies: [limited, MENTIONS] } });
  t.after(() => given.gate.dispose());
  writeFileSync(given.configPath, JSON.stringify({ default: 'skip', policies: [MENTIONS] }));
  given.gate.addPolicy({ name: 'dm', match: { tagsAny: ['chat:dm'] }, behavior: 'always' });
  assert.deepEqual(onDisk(given.configPath).policies.map((rule) => rule.name), ['mentions', 'dm']);
  assert.deepEqual(names(given.gate), ['mentions', 'dm']);
  assert.equal(given.gate.getStatus().configSource, 'file');
  assert.equal(given.gate.evaluate(event(['chat:ambient'])).trigger, false, 'gate.json\'s "skip" holds back the rest');
  const givenSaid = given.gate.getStatus().errors;
  assert.equal(givenSaid.length, 1, 'the start\'s entry for gate.json not used goes');
  assert.ok(givenSaid[0]!.startsWith('In the host\'s starting rules, Rule "limited" is left out'), givenSaid[0]);

  // Once gate.json is removed, a change edits the rules in force, the starting rules as read, as one does where gate.json
  // is missing, and writes them with it, rather than gate.json's empty list, which would leave the new rule alone in force.
  const removed = makeGate(tempDir(t), { file: { default: 'skip', policies: [] }, initialConfig: { default: 'always', policies: [limited, MENTIONS] } });
  t.after(() => removed.gate.dispose());
  rmSync(removed.configPath);
  removed.gate.addPolicy({ name: 'dm', match: { tagsAny: ['chat:dm'] }, behavior: 'always' });
  assert.deepEqual(onDisk(removed.configPath).policies.map((rule) => rule.name), ['mentions', 'dm']);
  assert.equal(onDisk(removed.configPath).default, 'always');
  assert.deepEqual(names(removed.gate), ['mentions', 'dm']);
  assert.equal(removed.gate.evaluate(event(['chat:ambient'])).trigger, true);

  // A starting rule with no name, which the gate leaves out and a start can't add by name, counts as one left out, where
  // earlier releases wrote it into the list as given and couldn't load what they wrote.
  const nameless = makeGate(tempDir(t), {
    file: { default: 'skip', policies: [] },
    initialConfig: { default: 'always', policies: [{ match: { tagsAny: ['chat:dm'] }, behavior: 'always' }, MENTIONS] },
  });
  t.after(() => nameless.gate.dispose());
  const namelessOut = 'the host\'s starting rules would leave out one with no name, which could wake the agent';
  const namelessSaid = nameless.gate.getStatus().errors;
  assert.equal(namelessSaid[0], `gate.json loaded. gate.json has no rules, so ${notUsedFor(namelessOut, 'fixing one with no name in the starting rules')}.`);
  assert.ok(namelessSaid[1]!.startsWith('In the host\'s starting rules, The 1st rule is left out'), namelessSaid[1]);
  assert.equal(namelessSaid[2], startSaidFor(namelessOut, 'fixing one with no name in the starting rules'));
  assert.equal(namelessSaid.length, 3);
  assert.deepEqual(names(nameless.gate), ['mentions']);
  assert.equal(nameless.gate.evaluate(event(['chat:dm'])).trigger, true, 'a direct message wakes the agent, as the starting rules\' "always" has it');
  assert.deepEqual(onDisk(nameless.configPath), { default: 'skip', policies: [] }, 'nothing was written');

  // So does a starting rule whose name gate.json holds only in a rule the gate leaves out, which keeps the host's rule of
  // that name out, where earlier releases didn't load gate.json at all, refusing that rule; one that wakes on none of what
  // it matches doesn't.
  const heldQuiet = { name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: { rate_limit: { tokens: 0, refillIntervalMs: 60000 } } };
  const held = makeGate(tempDir(t), { file: { default: 'skip', policies: [heldQuiet] }, initialConfig: { default: 'always', policies: [MENTIONS] } });
  t.after(() => held.gate.dispose());
  const heldOut = 'the host\'s "mentions", which could wake the agent, would be kept out by gate.json\'s rule of that name, which the gate '
    + 'leaves out';
  const heldSaid = held.gate.getStatus().errors;
  assert.equal(heldSaid[0], 'gate.json loaded. Rule "mentions" is left out: behavior.rate_limit.tokens is 0, where a positive number is '
    + `needed. gate.json has no rules but ones the gate leaves out, so ${notUsedFor(heldOut, 'fixing gate.json\'s "mentions"')}.`);
  assert.equal(heldSaid[1], startSaidFor(heldOut, 'fixing gate.json\'s "mentions"'));
  assert.equal(heldSaid.length, 2);
  assert.deepEqual(names(held.gate), ['mentions']);
  assert.equal(held.gate.getStatus().configSource, 'initial');
  assert.equal(held.gate.evaluate(MENTION).trigger, true);
  const heldSkips = makeGate(tempDir(t), {
    file: { default: 'skip', policies: [heldQuiet] },
    initialConfig: { default: 'always', policies: [{ ...MENTIONS, behavior: 'skip' }] },
  });
  t.after(() => heldSkips.gate.dispose());
  assert.equal(heldSkips.gate.getStatus().configSource, 'file');
  assert.deepEqual(names(heldSkips.gate), []);

  // A starting rule left out that wakes on none of what it matches, such as a rate limit of 0 tokens, doesn't count:
  // gate.json is used, and the reconcile writes it into the list beside the rest.
  const quietOut = makeGate(tempDir(t), { file: { default: 'skip', policies: [] }, initialConfig: { default: 'always', policies: [quiet, MENTIONS] } });
  t.after(() => quietOut.gate.dispose());
  assert.equal(quietOut.gate.getStatus().configSource, 'file');
  assert.deepEqual(names(quietOut.gate), ['mentions']);
  assert.deepEqual(onDisk(quietOut.configPath).policies.map((rule) => rule.name), ['quiet', 'mentions']);

  // Several at once: each named, those with no name counted, and each way back given.
  const keptOut = (name: string) => ({ name, match: {}, behavior: { rate_limit: { tokens: 0, refillIntervalMs: 60000 } } });
  const wakes = (name: string) => ({ name, match: { tagsAny: [`chat:${name}`] }, behavior: 'always' });
  const several = makeGate(tempDir(t), {
    file: { default: 'skip', policies: [keptOut('dm'), keptOut('thread')] },
    initialConfig: {
      default: 'always',
      policies: [wakes('dm'), wakes('thread'), limited, { behavior: 'always' }, { match: { tagsAny: ['chat:ambient'] }, behavior: 'always' }, MENTIONS],
    },
  });
  t.after(() => several.gate.dispose());
  const severalOut = 'the host\'s starting rules would leave out "limited" and 2 with no name, which could wake the agent, and the host\'s '
    + '"dm" and "thread", which could wake the agent, would be kept out by gate.json\'s rules of those names, which the gate leaves out';
  const severalFix = 'both fixing "limited" and 2 with no name in the starting rules, and fixing gate.json\'s "dm" and "thread"';
  const severalSaid = several.gate.getStatus().errors;
  assert.ok(severalSaid[0]!.endsWith(`gate.json has no rules but ones the gate leaves out, so ${notUsedFor(severalOut, severalFix)}.`), severalSaid[0]);
  assert.equal(severalSaid[severalSaid.length - 1], startSaidFor(severalOut, severalFix));
  assert.deepEqual(names(several.gate), ['dm', 'thread', 'mentions']);

  // Starting rules refused whole under their own "skip" beside an empty list: no rules, every event waking the agent, as
  // at a start without gate.json, where gate.json's "skip" would hold back every event; a change is refused here too.
  const fixStarting = 'Giving gate.json rules under "policies", or fixing the starting rules, puts rules in force (a fix to the '
    + 'starting rules, at the next start).';
  const neither = makeGate(tempDir(t), { file: { default: 'skip', policies: [] }, initialConfig: { default: 'skip', policies: [limited, MENTIONS] } });
  t.after(() => neither.gate.dispose());
  const neitherSaid = neither.gate.getStatus().errors;
  assert.equal(neitherSaid[0], 'gate.json loaded. gate.json has no rules, so under its default, "skip", it would hold back every event: it '
    + 'isn\'t used at this start, and the gate runs no rules, as a start without gate.json does, so every event gets the default, '
    + `"always". ${fixStarting}`);
  assert.ok(neitherSaid[1]!.endsWith(' gate.json, which has no rules the gate reads, wasn\'t used either: under its default, "skip", it would hold back '
    + `every event, so the gate started with no rules, as a start without gate.json does. ${fixStarting}`), neitherSaid[1]);
  assert.equal(neitherSaid.length, 2);
  assert.deepEqual(names(neither.gate), []);
  assert.equal(neither.gate.getStatus().configSource, 'default');
  assert.equal(neither.gate.evaluate(event(['chat:ambient'])).trigger, true, 'every event wakes the agent');
  assert.throws(() => neither.gate.addPolicy({ name: 'dm', behavior: 'always' }), {
    message: refusedRunning('no rules: every event gets the default, "always"', neither.configPath),
  });

  // With a rule of its own, gate.json's rules stay in force, without the starting rules a write would leave it unused with.
  const own = { name: 'own', match: { tagsAny: ['chat:dm'] }, behavior: 'always' };
  const kept = makeGate(tempDir(t), { file: { default: 'skip', policies: [own] }, initialConfig: { default: 'always', policies: [limited, MENTIONS] } });
  t.after(() => kept.gate.dispose());
  assert.deepEqual(onDisk(kept.configPath), { default: 'skip', policies: [own] }, 'nothing was written');
  assert.deepEqual(names(kept.gate), ['own']);
  assert.equal(kept.gate.getStatus().configSource, 'file');
  assert.equal(kept.gate.evaluate(MENTION).trigger, false);
  assert.ok(kept.gate.getStatus().errors.some((e) => e.endsWith('At start, the host\'s starting rules "limited" and "mentions" couldn\'t be '
    + 'added to gate.json (with them, gate.json would leave out a rule that could wake the agent, and under its default, "skip", it '
    + 'wouldn\'t be used), so they weren\'t put in force. A start adds them once what kept them out is fixed.')),
    JSON.stringify(kept.gate.getStatus().errors));
});

test("numbers the gate's range refuses are read with a note, in the starting rules and gate.json: a debounce at its nearest bound, a refill interval of 0 as refilling at once, and the rest the way they ran; addPolicy still refuses them", (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  // A debounce out of range ran as written in the starting rules: read at its
  // bound, its batch goes out later or sooner, and every event in it is still delivered.
  const fast = { name: 'fast', match: { scope: ['mcpl:channel-incoming'] }, behavior: { debounce: 50 } };
  const slow = { name: 'slow', match: { scope: ['mcpl:push-event'] }, behavior: { debounce: 500000 } };
  const none = { name: 'none', match: { scope: ['workspace:modified'] }, behavior: { debounce: 0 } };
  // It sampled when its count reached the step: at or under 0, every event, as 1 does; a fraction, as its next whole number.
  const each = { name: 'each', match: { scope: ['timer:fired'] }, behavior: { passive_sample: { every: 0 } } };
  const third = { name: 'third', match: { scope: ['chat:ambient'] }, behavior: { passive_sample: { every: 2.5, keyBy: 'channelId' } } };
  // A bucket whose refill interval is 0 refills at once, so the rule limits
  // nothing; earlier releases refilled it once, then never.
  const refills = { name: 'refills', match: { scope: ['heartbeat'] }, behavior: { rate_limit: { tokens: 2, refillIntervalMs: 0 } } };
  const starting = { default: 'skip', policies: [fast, slow, none, each, third, refills] };
  const asRead = [
    { debounce: 100 }, { debounce: 300000 }, { debounce: 100 },
    { passive_sample: { every: 1 } }, { passive_sample: { every: 3, keyBy: 'channelId' } }, { rate_limit: { tokens: 2, refillIntervalMs: 0 } },
  ];
  const read = 'Rule "fast": behavior.debounce is 50 ms, under the 100 ms minimum, so it\'s read as 100 ms. '
    + 'Rule "slow": behavior.debounce is 500000 ms, over the 300000 ms maximum, so it\'s read as 300000 ms. '
    + 'Rule "none": behavior.debounce is 0 ms, under the 100 ms minimum, so it\'s read as 100 ms. '
    + 'Rule "each": behavior.passive_sample.every is 0, under 1, so it\'s read as 1. '
    + 'Rule "third": behavior.passive_sample.every is 2.5, not a whole number, so it\'s read as 3. '
    + 'Rule "refills": behavior.rate_limit.refillIntervalMs is 0, where a positive number of milliseconds is needed, so its tokens refill at '
    + 'once, and it limits nothing it matches.';

  // A first start writes them as given, runs them as read, and says so in errors and the log, for the start and for gate.json.
  const first = makeGate(tempDir(t), { initialConfig: starting });
  assert.deepEqual(behaviors(first.gate), asRead);
  assert.deepEqual(onDisk(first.configPath), starting, 'written as given');
  assert.equal(first.gate.getStatus().configSource, 'file');
  const atStart = `In the host's starting rules, ${read}`;
  assert.deepEqual(first.gate.getStatus().errors, [`gate.json loaded. ${read}`, atStart]);
  assert.ok(logged.includes(`[gate] ${atStart}`), 'the log says it too');
  first.gate.dispose();

  // A gate.json holding them, as earlier releases seeded such rules: it loads, read the same way, with its own note.
  logged.length = 0;
  const upgraded = makeGate(tempDir(t), { file: starting, initialConfig: starting });
  assert.deepEqual(behaviors(upgraded.gate), asRead);
  assert.equal(upgraded.gate.getStatus().configSource, 'file');
  const loaded = `gate.json loaded. ${read}`;
  assert.deepEqual(upgraded.gate.getStatus().errors, [loaded, atStart]);
  assert.ok(logged.includes(`[gate] ${loaded}`), 'the log says it too');

  // addPolicy, behind wake_add_rule, still refuses one: its caller is there to fix it, and nothing is saved.
  assert.equal(refusal(upgraded.gate, { behavior: { debounce: 50 } }), 'Rule "r" wasn\'t saved: behavior.debounce is 50 ms, under the 100 ms minimum.');
  assert.equal(refusal(upgraded.gate, { behavior: { passive_sample: { every: 0 } } }), 'Rule "r" wasn\'t saved: behavior.passive_sample.every is 0, under 1.');
  assert.deepEqual(onDisk(upgraded.configPath), starting, 'nothing was written');

  // New text holding one, applied by a reload, says so in errors and the log the same way.
  logged.length = 0;
  writeFileSync(upgraded.configPath, JSON.stringify({ default: 'skip', policies: [fast] }));
  (upgraded.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  upgraded.gate.evaluate(event([], 'workspace:modified'));
  const reloaded = 'gate.json loaded. Rule "fast": behavior.debounce is 50 ms, under the 100 ms minimum, so it\'s read as 100 ms.';
  assert.deepEqual(behaviors(upgraded.gate), [{ debounce: 100 }]);
  assert.deepEqual(upgraded.gate.getStatus().errors, [reloaded, atStart]);
  assert.ok(logged.includes(`[gate] ${reloaded}`), 'the log says it too');
  upgraded.gate.dispose();

  // A rule with a number and another problem is read past both.
  const both = makeGate(tempDir(t), { file: { policies: [{ name: 'both', match: { scope: 'chat' }, behavior: { debounce: 50 } }] } });
  assert.deepEqual(both.gate.getStatus().errors, [
    'gate.json loaded. Rule "both": behavior.debounce is 50 ms, under the 100 ms minimum, so it\'s read as 100 ms; '
    + 'match.scope is "chat", where a list of event types is needed, such as ["mcpl:channel-incoming"], so the rule matches every type of event. '
    + everyEvent('Rule "both"'),
  ]);
  both.gate.dispose();
});

test('what the start did stays in errors until the next start, through writes and new text', {
  skip: permissionsHold ? false : 'needs file permissions that hold (not Windows, not root)',
}, (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, JSON.stringify({ default: 'skip', policies: [] }));
  chmodSync(configPath, 0o444);
  const { gate } = makeGate(dir, {
    initialConfig: { default: 'skip', policies: [{ name: 'user-input', match: {}, behavior: 'always' }] },
  });
  const errors = gate.getStatus().errors;
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /^At start, the host's starting rules "user-input" couldn't be added to gate\.json \(EACCES[^)]*\), so they weren't put in force\. Whoever runs this host can fix what kept them from being written\.$/);
  assert.deepEqual(names(gate), [], 'gate.json\'s rules are in force');

  chmodSync(configPath, 0o644);
  gate.addPolicy({ name: 'other', behavior: 'always' });
  assert.deepEqual(gate.getStatus().errors, errors, 'a write of another rule leaves the start as it was');

  const again = makeGate(tempDir(t), {
    initialConfig: { default: 'skip', policies: [{ name: 'user-input', match: {}, behavior: 'deffer' }] },
  });
  const typo = `Rule "user-input": behavior is "deffer", where ${BEHAVIORS} is needed, so it's read as "always".`;
  assert.deepEqual(again.gate.getStatus().errors, [`gate.json loaded. ${typo}`, `In the host's starting rules, ${typo}`]);
  writeFileSync(again.configPath, JSON.stringify({ policies: [{ name: 'user-input', behavior: 'defer' }] }));
  again.gate.evaluate({ content: 'x', eventType: 'mcpl:channel-incoming', serverId: 'discord', channelId: 'c1', tags: [] });
  assert.deepEqual(behaviors(again.gate), ['defer'], 'the reload applied the new text');
  assert.deepEqual(again.gate.getStatus().errors, [`In the host's starting rules, ${typo}`], 'gate.json\'s note went with its text, and what the start said still stands');
});

test('a reconcile whose write leaves gate.json unable to load runs what it read and what it was adding, and says gate.json may be part-written', (t) => {
  const dir = tempDir(t);
  const configPath = join(dir, 'gate.json');
  const userInput = { name: 'user-input', match: {}, behavior: 'always' };
  const mine = { name: 'mine', match: {}, behavior: 'defer' };
  // A rule the gate leaves out, which a change must still write back as written.
  const held = { name: 'held', behavior: 'defer', passthrough: true };
  const tickets = { name: 'tickets', match: { scope: ['workspace:modified'] }, behavior: 'always' };
  writeFileSync(configPath, JSON.stringify({ comment: 'ops', default: 'skip', policies: [userInput, mine, held] }));
  /** A start whose reconcile write puts half its text in place, then fails as `syscall` reports; and the whole text it was writing. */
  const original = fs.writeFileSync;
  let writing = '';
  const failingStart = (at: string, syscall: string, error: string, starting: GateConfig): EventGate => {
    const write = t.mock.method(fs, 'writeFileSync', (path: unknown, data: unknown) => {
      writing = typeof data === 'string' ? data : '';
      original(path as string, writing.slice(0, Math.floor(writing.length / 2)));
      throw Object.assign(new Error(error), { code: error.split(':')[0], syscall });
    });
    syncBuiltinESMExports();
    try {
      return makeGate(at, { initialConfig: starting }).gate;
    } finally {
      write.mock.restore();
      syncBuiltinESMExports();
    }
  };
  // The disk fills partway through the reconcile's write.
  const gate = failingStart(dir, 'write', 'ENOSPC: no space left on device, write', { default: 'skip', policies: [userInput, tickets] } as GateConfig);

  // The recipe's rule "tickets" takes its recipe place, after "user-input" and ahead of gate.json's own "mine" (the
  // start's merge against the recipe last applied), where an append put it last.
  assert.deepEqual(names(gate), ['user-input', 'tickets', 'mine'], 'what it read, and what it was adding');
  assert.equal(gate.getStatus().configSource, 'file');
  const [fileError, unsaved, ...rest] = gate.getStatus().errors;
  // gate.json's entry says what's in force, as the start's entry beside it does.
  let parsed = '';
  try {
    JSON.parse(writing.slice(0, Math.floor(writing.length / 2)));
  } catch (err) {
    parsed = (err as Error).message;
  }
  assert.equal(fileError, notJsonShown(configPath, parsed, 'the rules it read from gate.json at start and the ones it was adding'));
  const partway = (error: string, read = '.'): string => `At start, adding the host's starting rules "tickets" to gate.json failed partway (${error}), so `
    + `gate.json may be left part-written. The gate runs the rules it read from gate.json and the ones it was adding, which aren't saved${read} `
    + 'A restart before gate.json is fixed starts from the host\'s starting rules. Whoever runs this host can fix what kept it '
    + 'from being written, and gate.json.';
  // gate.json's own entry is now its load error, so the start's names what those rules hold that the gate reads past or leaves out.
  assert.equal(unsaved, partway(
    'ENOSPC: no space left on device, write',
    ', read as a load reads them: gate.json has "comment", which the gate doesn\'t read, so it does nothing. Its fields are "default" and '
    + '"policies". Rule "held" is left out: passthrough is true, and only a behavior.rate_limit or behavior.passive_sample rule '
    + 'passes on an event it matches without waking on it; with behavior "defer", leave passthrough out.',
  ));
  assert.deepEqual(rest, []);
  // The rules it was adding are read with them, a problem of their own included.
  const addedDir = tempDir(t);
  writeFileSync(join(addedDir, 'gate.json'), JSON.stringify({ default: 'skip', policies: [userInput] }));
  const added = failingStart(addedDir, 'write', 'ENOSPC: no space left on device, write', {
    default: 'skip', policies: [userInput, { ...tickets, note: 'from the recipe' }],
  } as GateConfig);
  const addedUnread = `Rule "tickets" has "note", which the gate doesn't read, so it does nothing. Its fields are ${POLICY_FIELDS}.`;
  assert.deepEqual(added.getStatus().errors.slice(1), [
    `In the host's starting rules, ${addedUnread}`,
    partway('ENOSPC: no space left on device, write', `, read as a load reads them: ${addedUnread}`),
  ]);
  added.dispose();

  // A wake-rule change is refused while gate.json holds what the write left, which isn't JSON: it names the parse error and
  // what runs, writes nothing, and the rules in force keep running. A removal of a rule in force is refused the same way.
  const left = readFileSync(configPath);
  assert.throws(() => gate.addPolicy({ name: 'later', behavior: 'defer' }), {
    message: `gate.json, at ${configPath}, isn't JSON the gate can read (${JSON.stringify(parsed)}), so a change can't edit its rules without `
      + 'writing over what it holds, and nothing was saved. Meanwhile the gate runs the rules it read from gate.json at start and the ones '
      + 'it was adding. Until gate.json is JSON, a change is refused the same way.',
  });
  assert.throws(() => gate.removePolicy('mine'), { message: /^gate\.json, at .*, isn't JSON the gate can read \(/ });
  assert.deepEqual(readFileSync(configPath), left);
  assert.deepEqual(names(gate), ['user-input', 'tickets', 'mine']);
  // Once gate.json is gone, a change edits the text that write was writing, so gate.json's own fields and the rule the
  // gate leaves out are written back as written; and once it's written, nothing the start ran is unsaved.
  rmSync(configPath);
  gate.addPolicy({ name: 'later', behavior: 'defer' });
  const rewritten = onDisk(configPath);
  assert.equal(rewritten.comment, 'ops');
  assert.deepEqual(rewritten.policies.map((rule) => rule.name), ['user-input', 'tickets', 'mine', 'held', 'later']);
  assert.ok(!gate.getStatus().errors.some((said) => said.startsWith('At start, adding')), gate.getStatus().errors.join(' | '));

  // A write that fails at its close, after it wrote, may have left gate.json part-written too.
  const closedDir = tempDir(t);
  writeFileSync(join(closedDir, 'gate.json'), JSON.stringify({ default: 'skip', policies: [userInput] }));
  const closed = failingStart(closedDir, 'close', 'EIO: i/o error, close', { default: 'skip', policies: [userInput, tickets] } as GateConfig);
  assert.equal(closed.getStatus().errors[1], partway('EIO: i/o error, close'));
  // Once gate.json holds what the reconcile was writing, a reload finds the text in force, and nothing is unsaved.
  writeFileSync(join(closedDir, 'gate.json'), writing);
  (closed as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  closed.evaluate(event([]));
  assert.deepEqual(closed.getStatus().errors, []);
  assert.deepEqual(names(closed), ['user-input', 'tickets']);

  // A write that fails only after its whole text landed, at close, added the
  // rules after all, one the gate leaves out included, so nothing is said of adding them.
  const landedDir = tempDir(t);
  const landedPath = join(landedDir, 'gate.json');
  writeFileSync(landedPath, JSON.stringify({ default: 'skip', policies: [userInput] }));
  const closing = t.mock.method(fs, 'writeFileSync', (path: unknown, data: unknown) => {
    original(path as string, data as string);
    throw Object.assign(new Error('EIO: i/o error, close'), { code: 'EIO', syscall: 'close' });
  });
  syncBuiltinESMExports();
  const muted = { name: 'muted', behavior: 'skip', passthrough: true };
  const { gate: landed } = makeGate(landedDir, { initialConfig: { default: 'skip', policies: [userInput, tickets, muted] } });
  closing.mock.restore();
  syncBuiltinESMExports();
  assert.deepEqual(names(landed), ['user-input', 'tickets']);
  const mutedSaid = 'Rule "muted" is left out: passthrough is true, and only a behavior.rate_limit or behavior.passive_sample rule '
    + 'passes on an event it matches without waking on it; with behavior "skip", leave passthrough out.';
  assert.deepEqual(landed.getStatus().errors, [`gate.json loaded. ${mutedSaid}`, `In the host's starting rules, ${mutedSaid}`]);
});

test('a gate.json saved with a BOM reads as the same file without one: at a later start beside it, through a wake_add_rule, and as the text in force once it is gone', async (t) => {
  // UTF-8 with a leading U+FEFF, as some Windows editors save it. A later start
  // over a gate.json with no rule list runs the host's starting rules beside it,
  // and its note is read from the file's text.
  const besideText = JSON.stringify({ default: 'skip', policies: 'x' });
  const starting = { default: 'always', policies: [MENTIONS] };
  const plain = makeGate(tempDir(t), { file: besideText, initialConfig: starting });
  const bom = makeGate(tempDir(t), { file: `\uFEFF${besideText}`, initialConfig: starting });
  t.after(() => { plain.gate.dispose(); bom.gate.dispose(); });
  assert.equal(bom.gate.getStatus().configSource, 'initial');
  assert.deepEqual(names(bom.gate), ['mentions']);
  assert.deepEqual(bom.gate.getStatus().errors, plain.gate.getStatus().errors);

  // Once a BOM gate.json that loaded is gone, a change builds on its text,
  // the text in force, so the rule its operator added by hand stays.
  const byHand = { name: 'by-hand', match: { tagsAny: ['chat:dm'] }, behavior: 'always' };
  const handText = `\uFEFF${JSON.stringify({ default: 'defer', policies: [MENTIONS, byHand] }, null, 2)}`;
  const gone = makeGate(tempDir(t), { file: handText });
  t.after(() => gone.gate.dispose());
  rmSync(gone.configPath);
  gone.gate.addPolicy({ name: 'watch', match: { tagsAny: ['chat:watch'] }, behavior: 'always' });
  assert.deepEqual(onDisk(gone.configPath).policies.map((p) => p.name), ['mentions', 'by-hand', 'watch']);

  // Through wake_add_rule, the file is edited: the rule added by hand stays,
  // and nothing is kept.
  const dir = mkdtempSync(join(tmpdir(), 'gate-strict-'));
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, handText);
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    modules: [],
    gate: { configPath },
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  membrane.pushResponse(createMockResponse(
    [{ type: 'tool_use', id: 'add', name: 'wake_add_rule', input: { name: 'watch', match: { tagsAny: ['chat:watch'] }, behavior: 'always' } }],
    'tool_use',
  ));
  membrane.pushResponse(createMockResponse([]));
  const before = readdirSync(dir).sort();
  assert.equal(framework.nudgeAgent('scout').ok, true);
  await framework.runUntilIdle();
  const [round] = membrane.lastStream!.receivedToolResults as Array<Array<{ content: string; isError: boolean }>>;
  assert.equal(round![0]!.isError, false, round![0]!.content);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'by-hand', 'watch']);
  assert.deepEqual(readdirSync(dir).sort(), before, 'the file is written in place; nothing is moved aside');
});

test('wake_add_rule refuses a behavior, or a placement, of the wrong kind in its own terms, names fields it left out, and keeps the rules it didn\'t change', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-strict-'));
  const configPath = join(dir, 'gate.json');
  const membrane = new MockMembrane();
  const framework = await AgentFramework.create({
    storePath: join(dir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'scout', model: 'test-model', systemPrompt: 'You are scout.', proseRouting: 'disabled' }],
    modules: [],
    gate: { configPath, config: { default: 'defer', policies: [{ name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'always' }] } },
  });
  t.after(async () => {
    await framework.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** One turn making the call; the result the model is sent. */
  const call = async (input: Record<string, unknown>) => {
    membrane.pushResponse(createMockResponse([{ type: 'tool_use', id: 'add', name: 'wake_add_rule', input }], 'tool_use'));
    membrane.pushResponse(createMockResponse([]));
    assert.equal(framework.nudgeAgent('scout').ok, true);
    await framework.runUntilIdle();
    const [round] = membrane.lastStream!.receivedToolResults as Array<Array<{ content: string; isError: boolean }>>;
    return round![0]!;
  };

  const timing = 'so nothing was saved. For a debounce, a rate limit, sampling or the reply judge, give debounceMs, rateLimit, passiveSample or judge instead of behavior.';
  // XML tool mode parses `behavior` by its declared type, a string, so the
  // object form arrives as text.
  for (const [behavior, shown] of [['{"debounce": 60000}', '"{\\"debounce\\": 60000}"'], ['deffer', '"deffer"'], [5, '5'], [['always'], '["always"]']] as const) {
    const result = await call({ name: 'watch', behavior });
    assert.equal(result.isError, true);
    assert.match(result.content, new RegExp(`wake_add_rule: behavior must be "always", "defer" or "skip", and it's ${shown.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}, ${timing.replace(/[.]/g, '\\.')}`));
  }
  const top = await call({ name: 'watch', behavior: 'defer', position: 'top' });
  assert.equal(top.isError, true);
  assert.match(top.content, /wake_add_rule: position must be "append" or "prepend", and it's "top", so nothing was saved\. To place the rule next to another, give insertBefore or insertAfter with that rule's name\./);
  for (const field of ['insertBefore', 'insertAfter']) {
    const anchor = await call({ name: 'watch', behavior: 'defer', [field]: 3 });
    assert.equal(anchor.isError, true);
    assert.match(anchor.content, new RegExp(`wake_add_rule: ${field} must be the name of a rule, and it's 3, so nothing was saved\\. The other rules a change edits are "mentions"\\. Give ${field} one of them`));
  }
  // A name no rule has was refused before this change too, by the gate.
  const absent = await call({ name: 'watch', behavior: 'defer', insertAfter: 'nope' });
  assert.equal(absent.isError, true);
  assert.match(absent.content, /^Rule "watch" wasn't saved: insertAfter is "nope", and no rule has that name\. The other rules are "mentions"\./);
  // Its own parameters are checked as a rule's fields are: a slip is refused.
  const before = readFileSync(configPath, 'utf-8');
  const parameters = '"name", "match", "behavior", "debounceMs", "rateLimit", "passiveSample", "judge", "position", "insertBefore", '
    + '"insertAfter", "passthrough" and "resets"';
  const slip = await call({ name: 'watch', passiveSample: { every: 10 }, pasthrough: true });
  assert.equal(slip.isError, true);
  assert.ok(
    slip.content.includes(
      `wake_add_rule has "pasthrough" (did you mean "passthrough"?), which it doesn't take, so nothing was saved. Its parameters are ${parameters}.`,
    ),
    slip.content,
  );
  // So is a name holding a parameter's whole name where the call doesn't give that parameter: it's the parameter under
  // another name, and the rule would be saved without it.
  const held = await call({ name: 'watch', matches: { tagsAny: ['chat:ambient'] }, behavior: 'skip' });
  assert.equal(held.isError, true);
  assert.ok(
    held.content.includes(`wake_add_rule has "matches" (did you mean "match"?), which it doesn't take, so nothing was saved. Its parameters are ${parameters}.`),
    held.content,
  );
  // So is a field of one of its object parameters given on its own, which the rule would be saved without, naming that parameter.
  const loose = await call({ name: 'watch', tagsAny: ['chat:ambient'], behavior: 'skip' });
  assert.equal(loose.isError, true);
  assert.ok(
    loose.content.includes(`wake_add_rule has "tagsAny", a field of "match", which it doesn't take here, so nothing was saved. `
      + `Put it in "match": {"tagsAny": ["chat:ambient"]}. Its parameters are ${parameters}.`),
    loose.content,
  );
  // A value too long to show whole isn't shown as one the call could give: the parameter is named alone.
  const long = await call({ name: 'watch', channel: `discord:*:${'1'.repeat(90)}`, behavior: 'skip' });
  assert.equal(long.isError, true);
  assert.ok(
    long.content.includes(`wake_add_rule has "channel", a field of "match", which it doesn't take here, so nothing was saved. `
      + `Put it in "match". Its parameters are ${parameters}.`),
    long.content,
  );
  // Of two fields of one parameter, one too long to show whole: the parameter is named alone.
  const longer = await call({ name: 'watch', tagsAny: ['chat:ambient'], channel: `discord:*:${'1'.repeat(90)}`, behavior: 'skip' });
  assert.equal(longer.isError, true);
  assert.ok(
    longer.content.includes(`wake_add_rule has "tagsAny" and "channel", fields of "match", which it doesn't take here, so nothing `
      + `was saved. Put them in "match". Its parameters are ${parameters}.`),
    longer.content,
  );
  // Two fields of one parameter are shown there together.
  const both = await call({ name: 'watch', tagsAny: ['chat:ambient'], source: 'discord', behavior: 'skip' });
  assert.equal(both.isError, true);
  assert.ok(
    both.content.includes(`wake_add_rule has "tagsAny" and "source", fields of "match", which it doesn't take here, so nothing was `
      + `saved. Put them in "match": {"tagsAny": ["chat:ambient"], "source": "discord"}. Its parameters are ${parameters}.`),
    both.content,
  );
  const limits = await call({ name: 'watch', behavior: 'always', tokens: 3, keyBy: 'channelId' });
  assert.equal(limits.isError, true);
  assert.ok(
    limits.content.includes(
      'wake_add_rule has "tokens", a field of "rateLimit", which it doesn\'t take here, and "keyBy", a field of "rateLimit" and '
      + '"passiveSample", which it doesn\'t take here, so nothing was saved. Put it in "rateLimit": {"tokens": 3}. '
      + `Its parameters are ${parameters}.`,
    ),
    limits.content,
  );
  const filtered = await call({ name: 'watch', pattern: 'release', behavior: 'skip' });
  assert.equal(filtered.isError, true);
  assert.ok(
    filtered.content.includes(`wake_add_rule has "pattern", a field of "match.filter", which it doesn't take here, so nothing was saved. `
      + 'Put it in "match.filter": {"pattern": "release"}. Its parameters are'),
    filtered.content,
  );
  // One inside match is the gate's to refuse, as it refuses a rule's field at another level.
  const inMatch = await call({ name: 'watch', match: { pattern: 'release' }, behavior: 'skip' });
  assert.equal(inMatch.isError, true);
  assert.ok(
    inMatch.content.includes(
      'Rule "watch" wasn\'t saved: match has "pattern", a field of "match.filter", which the gate doesn\'t read here. '
      + everyEventIfSaved(),
    ),
    inMatch.content,
  );
  // A refusal names what else the call held that it doesn't take, so the call that follows doesn't count on it:
  // beside a slip, in the same sentence; beside its own refusal or the gate's, as the note a saved rule gets.
  const slipAndMore = await call({ name: 'watch', passiveSample: { every: 10 }, pasthrough: true, comment: 'for the launch' });
  assert.equal(slipAndMore.isError, true);
  assert.ok(
    slipAndMore.content.includes(
      'wake_add_rule has "pasthrough" (did you mean "passthrough"?), which it doesn\'t take, and "comment", which it doesn\'t take, '
      + `so nothing was saved. Its parameters are ${parameters}.`,
    ),
    slipAndMore.content,
  );
  const unreadNote = `wake_add_rule has "comment", which it doesn't take, so it does nothing. Its parameters are ${parameters}.`;
  const typo = await call({ name: 'watch', comment: 'for the launch', behavior: 'deffer' });
  assert.equal(typo.isError, true);
  assert.ok(typo.content.endsWith(`${timing} ${unreadNote}`), typo.content);
  const gateRefuses = await call({ name: 'watch', comment: 'for the launch', match: { tagsAny: 'chat:ambient' }, behavior: 'skip' });
  assert.equal(gateRefuses.isError, true);
  assert.ok(gateRefuses.content.startsWith('Rule "watch" wasn\'t saved:'), gateRefuses.content);
  assert.ok(gateRefuses.content.endsWith(unreadNote), gateRefuses.content);
  // The gate's refusal of an anchor it doesn't hold ends in a stop of its own, and the note follows it.
  const noAnchor = await call({ name: 'watch', comment: 'for the launch', insertBefore: 'nowhere', behavior: 'always' });
  assert.equal(noAnchor.isError, true);
  assert.ok(noAnchor.content.endsWith(`where it is. ${unreadNote}`), noAnchor.content);
  assert.equal(readFileSync(configPath, 'utf-8'), before, 'none of those refusals saved anything');
  // A rule with a problem is refused by the gate, naming each.
  const wide = await call({ name: 'watch', match: { tagsAny: 'chat:ambient' }, debounceMs: 50 });
  assert.equal(wide.isError, true);
  assert.ok(
    wide.content.includes(
      'Rule "watch" wasn\'t saved: debounceMs is 50 ms, under the 100 ms minimum; '
      + 'match.tagsAny is "chat:ambient", where a list of non-empty strings is needed, such as ["chat:ambient"].',
    ),
    wide.content,
  );
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions'], 'nothing was saved');

  // A null or "" parameter is left out, so a null behavior beside debounceMs is
  // no second behavior, and another name is named, as "why" is.
  const leftOut = await call({ name: 'quiet', behavior: null, debounceMs: 60000, position: null, insertBefore: '', why: 'night' });
  assert.equal(leftOut.isError, false, leftOut.content);
  assert.deepEqual(JSON.parse(leftOut.content).ignoredFields, [
    'wake_add_rule has "insertBefore" as "", so it\'s left out.',
    `wake_add_rule has "why", which it doesn't take, so it does nothing. Its parameters are ${parameters}.`,
  ]);
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions', 'quiet'], 'appended, as with no placement');
  // Beside the parameter it holds, such a name is an extra that explains it, named and saved without.
  const beside = await call({ name: 'beside', match: { tagsAny: ['chat:ambient'] }, matchNote: 'the ambient ones', behavior: 'skip' });
  assert.equal(beside.isError, false, beside.content);
  assert.deepEqual(JSON.parse(beside.content).ignoredFields, [
    `wake_add_rule has "matchNote", which it doesn't take, so it does nothing. Its parameters are ${parameters}.`,
  ]);
  // A "" match is a match left out, which matches every event, and the note says so.
  const everything = await call({ name: 'loud', match: '', behavior: 'always' });
  assert.equal(everything.isError, false, everything.content);
  assert.deepEqual(JSON.parse(everything.content).ignoredFields, ['wake_add_rule has "match" as "", so it\'s left out: the rule matches every event.']);

  const saved = await call({ name: 'watch', match: { tagsAny: ['chat:ambient'], why: 'quiet hours' }, debounceMs: 60000 });
  assert.equal(saved.isError, false);
  assert.deepEqual(JSON.parse(saved.content).ignoredFields, [
    `Rule "watch": match has "why", which the gate doesn't read, so it does nothing. Its fields are ${MATCH_FIELDS}.`,
  ]);
  assert.deepEqual(onDisk(configPath).policies.find((p) => p.name === 'watch'), { name: 'watch', match: { tagsAny: ['chat:ambient'] }, behavior: { debounce: 60000 } });
  const none = await call({ name: 'watch', behavior: null });
  assert.equal(none.isError, true, 'a null behavior is one left out, and the tool needs one');
  assert.match(none.content, /wake_add_rule got no behavior, so nothing was saved/);

  const description = framework.getAllTools().find((tool) => tool.name === 'wake_add_rule')!.description;
  assert.ok(description.includes('debounceMs: 60000'), 'the example uses the shorthand, which works in both tool modes');
  assert.ok(!description.includes('behavior: { debounce'), 'and no longer the object form');
  // A removed rule's batch goes the way its timer's would, held while the agent's turn runs.
  const removing = framework.getAllTools().find((tool) => tool.name === 'wake_remove_rule')!.description;
  assert.ok(removing.includes('is still delivered, held while your turn runs, as its timer would deliver it'), removing);
  assert.ok(!removing.includes('delivered first'), removing);
  // Each of the description's examples, made as the call it shows, is saved as it reads.
  const examples = [...description.matchAll(/`(\{ name: "[^`]+\})`/g)]
    .map((m) => new Function(`return (${m[1]});`)() as Record<string, unknown>);
  assert.deepEqual(examples.map((e) => e.name), ['watch-notes', 'watch-cairn', 'ambient-judged']);
  for (const example of examples) {
    const result = await call(example);
    assert.equal(result.isError, false, result.content);
    assert.equal(JSON.parse(result.content).ignoredFields, undefined, 'every field it gives is read');
  }
  assert.deepEqual(onDisk(configPath).policies.slice(-3), [
    { name: 'watch-notes', match: { scope: ['workspace:modified'], mount: 'project', pathGlob: 'notes/*.md' }, behavior: 'always' },
    { name: 'watch-cairn', match: { source: 'discord', channel: 'discord:*:12345', tagsAny: ['chat:ambient'] }, behavior: { debounce: 60000 } },
    {
      name: 'ambient-judged',
      match: { tagsAny: ['chat:ambient'] },
      behavior: {
        judge: {
          debounceMs: 20000,
          maxWaitMs: 120000,
          instructions: 'Wake me when someone asks me something or the talk turns to the garden; let banter between others go by.',
        },
      },
    },
  ]);

  // A change over a gate.json with problems keeps them as written.
  const theirs = { name: 'mentions', match: { tagsAny: ['chat:mention'] }, behavior: 'deffer' };
  writeFileSync(configPath, JSON.stringify({ default: 'defer', policies: [theirs] }));
  const over = await call({ name: 'later', behavior: 'defer' });
  assert.equal(over.isError, false, over.content);
  assert.deepEqual(onDisk(configPath).policies, [theirs, { name: 'later', match: {}, behavior: 'defer' }]);
});

test('"__proto__" in a rule is a field the gate doesn\'t read: it narrows nothing, and is named', (t) => {
  const dir = tempDir(t);
  t.mock.method(console, 'error', () => {});
  // Written as JSON text: in a JavaScript object literal, "__proto__" sets the object's prototype instead.
  const { gate } = makeGate(dir, {
    file: '{"default": "skip", "policies": [{"name": "all", "match": {"__proto__": {"source": "slack"}}, "behavior": "always"}]}',
  });

  assert.equal(gate.probe(event(['chat:ambient'])).trigger, true, 'an event from discord wakes the agent, as the rule matches every event');
  const said = gate.getStatus().errors[0] ?? '';
  assert.ok(said.includes(`Rule "all": match has "__proto__", which the gate doesn't read, so it does nothing.`), said);
  assert.ok(said.includes(everyEvent('Rule "all"')), said);
});

test('a "" field named like one every object inherits, such as "constructor", is left out with the plain note', (t) => {
  const dir = tempDir(t);
  t.mock.method(console, 'error', () => {});
  const { gate } = makeGate(dir, {
    file: '{"default": "always", "policies": [{"name": "plain", "constructor": "", "match": {"__proto__": "", "toString": ""}, "behavior": "always"}]}',
  });

  const said = gate.getStatus().errors[0] ?? '';
  assert.ok(said.includes(`Rule "plain" has "constructor" as "", so it's left out.`), said);
  assert.ok(said.includes(`Rule "plain": match has "__proto__" and "toString" as "", so they're left out.`), said);
});

test('a write clears the state of a rule it leaves out or gives another behavior, as a reload does', (t) => {
  const dir = tempDir(t);
  t.mock.method(console, 'error', () => {});
  const limited = (tokens: number) => ({ name: 'limited', match: { tagsAny: ['chat:ambient'] }, behavior: { rate_limit: { tokens, refillIntervalMs: 3_600_000 } } });
  const ambient = event(['chat:ambient']);
  const reload = (gate: EventGate) => {
    (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
    (gate as unknown as { reloadIfChanged(): void }).reloadIfChanged();
  };

  // Left out: gate.json is edited to no tokens, and a change is made before a reload reads it.
  const out = makeGate(dir, { file: { default: 'always', policies: [limited(1)] } });
  assert.equal(out.gate.evaluate(ambient).trigger, true, 'its one token');
  assert.equal(out.gate.evaluate(ambient).trigger, false, 'spent');
  writeFileSync(out.configPath, JSON.stringify({ default: 'always', policies: [limited(0)] }));
  out.gate.addPolicy(MENTIONS);
  assert.deepEqual(names(out.gate), ['mentions'], 'the write leaves the rule with no tokens out');
  // gate.json then gives it five, and the reload takes it for a new rule, with a bucket of its own.
  writeFileSync(out.configPath, JSON.stringify({ default: 'always', policies: [limited(5), MENTIONS] }));
  reload(out.gate);
  assert.equal(out.gate.getStatus().policies.find((p) => p.name === 'limited')?.matchCount, 0, 'and with no counts of the rule it was');
  assert.equal(out.gate.evaluate(ambient).trigger, true, 'the restored rule starts with its five tokens, not the spent bucket');

  // Given another behavior: gate.json is edited to two tokens, and a change is made before a reload reads it.
  const changed = makeGate(tempDir(t), { file: { default: 'always', policies: [limited(1)] } });
  assert.equal(changed.gate.evaluate(ambient).trigger, true, 'its one token');
  assert.equal(changed.gate.evaluate(ambient).trigger, false, 'spent');
  writeFileSync(changed.configPath, JSON.stringify({ default: 'always', policies: [limited(2)] }));
  changed.gate.addPolicy(MENTIONS);
  assert.deepEqual(behaviors(changed.gate)[0], limited(2).behavior);
  assert.equal(changed.gate.evaluate(ambient).trigger, true, 'the rule runs on two fresh tokens, not the spent bucket');

  // Left out at a reload, as the write does it: gate.json is edited to drop the spent rule, then to restore it.
  const reloaded = makeGate(tempDir(t), { file: { default: 'always', policies: [limited(1)] } });
  assert.equal(reloaded.gate.evaluate(ambient).trigger, true, 'its one token');
  assert.equal(reloaded.gate.evaluate(ambient).trigger, false, 'spent');
  writeFileSync(reloaded.configPath, JSON.stringify({ default: 'always', policies: [MENTIONS] }));
  reload(reloaded.gate);
  assert.deepEqual(names(reloaded.gate), ['mentions'], 'the reload leaves the rule out');
  writeFileSync(reloaded.configPath, JSON.stringify({ default: 'always', policies: [limited(1), MENTIONS] }));
  reload(reloaded.gate);
  assert.equal(reloaded.gate.getStatus().policies.find((p) => p.name === 'limited')?.matchCount, 0, 'restored with no counts of the rule it was');
  assert.equal(reloaded.gate.evaluate(ambient).trigger, true, 'and with a token of its own, not the spent bucket');
});

test('rules that share a name keep their state through a write that leaves them as they were, in order, and lose it where one changes', (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // A debounce for Discord, and a rule of the same name that skips Zulip: they share the name's state.
  const discord = { name: 'dup', match: { source: 'discord' }, behavior: { debounce: 1000 } };
  const zulip = { name: 'dup', match: { source: 'zulip' }, behavior: 'skip' };
  const configPath = join(tempDir(t), 'gate.json');
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [discord, zulip] }));
  const wakes: string[] = [];
  const gate = new EventGate({
    configPath, emitTrace: () => {}, addMessage: () => '', getAgentNames: () => ['agent'],
    requestInference: (agent) => { wakes.push(agent); },
  });
  t.after(() => gate.dispose());
  assert.equal(gate.evaluate(event(['chat:ambient'])).trigger, false, 'the event waits in the debounce batch');
  // A write that changes neither keeps the batch on its timer.
  gate.addPolicy(MENTIONS);
  assert.deepEqual(wakes, [], 'the batch still waits');
  // Giving the first the second's behavior changes the name's rules, so its
  // state goes, and the batch is sent as its timer would have sent it.
  gate.addPolicy({ ...discord, behavior: 'skip' });
  assert.deepEqual(onDisk(configPath).policies, [{ ...discord, behavior: 'skip' }, zulip, MENTIONS]);
  assert.deepEqual(wakes, ['agent'], 'the batch is sent once the rule no longer batches');
  t.mock.timers.tick(1000);
  assert.deepEqual(wakes, ['agent'], 'and its timer sends nothing more');

  // Swapping two such rules' behaviors changes them too, though the same behaviors remain: a reload sends the batch.
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [discord, zulip] }));
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  (gate as unknown as { reloadIfChanged(): void }).reloadIfChanged();
  assert.equal(gate.evaluate(event(['chat:ambient'])).trigger, false, 'a new batch waits');
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [{ ...discord, behavior: 'skip' }, { ...zulip, behavior: { debounce: 1000 } }] }));
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  (gate as unknown as { reloadIfChanged(): void }).reloadIfChanged();
  assert.deepEqual(wakes, ['agent', 'agent'], 'the batch is sent once the rules swap behaviors');
});

test("a batch whose delivery throws is named in the log and dropped, whether its timer sends it or it was held for an agent's turn", async (t) => {
  const dir = tempDir(t);
  const logged: string[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const configPath = join(dir, 'gate.json');
  const quiet = { name: 'quiet', match: {}, behavior: { debounce: 1000 } };
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [quiet] }));
  let fails = true;
  let attempts = 0;
  const wakes: string[] = [];
  const delivered: string[] = [];
  const gate = new EventGate({
    configPath, getAgentNames: () => ['agent'],
    emitTrace: (e) => { if (e.type === 'gate:debounce-delivered') delivered.push(String(e.policyName)); },
    addMessage: () => { attempts++; if (fails) throw new Error('no agent to deliver to'); return ''; },
    requestInference: (agent) => { wakes.push(agent); },
  });
  t.after(() => gate.dispose());

  // Its timer sends it: thrown there, it would be uncaught. A batch that's dropped isn't traced as delivered.
  assert.equal(gate.evaluate(MENTION).trigger, false, 'the event waits in the debounce batch');
  gate.evaluate(MENTION);
  t.mock.timers.tick(1000);
  assert.deepEqual(logged, ['[gate] Rule "quiet": its pending batch of 2 events couldn\'t be delivered (no agent to deliver to), so the batch is dropped']);
  assert.deepEqual(delivered, []);

  // Held for the turn of the agent whose wake_add_rule changed the rule, and sent once it ends.
  logged.length = 0;
  gate.evaluate(MENTION);
  gate.evaluate(MENTION);
  gate.onInferenceStarted('agent');
  gate.addPolicy({ ...quiet, behavior: 'always' });
  gate.onInferenceEnded('agent');
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  assert.deepEqual(logged, [
    '[gate] 2 events held for an agent\'s turn or the host\'s quiesce couldn\'t be delivered (no agent to deliver to), so they\'re dropped',
  ]);
  assert.deepEqual(wakes, []);
  // Dropped, not kept: the end of the next turn sends nothing.
  const tried = attempts;
  gate.onInferenceStarted('agent');
  gate.onInferenceEnded('agent');
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  assert.equal(attempts, tried, 'nothing held is sent again');

  // Held while the host was quiesced, and sent once it resumes: one event, named so.
  logged.length = 0;
  gate.addPolicy(quiet);
  gate.setQuiesced(true);
  gate.evaluate(MENTION);
  t.mock.timers.tick(1000);
  gate.setQuiesced(false);
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  assert.deepEqual(logged, [
    '[gate] 1 event held for an agent\'s turn or the host\'s quiesce couldn\'t be delivered (no agent to deliver to), so it\'s dropped',
  ]);

  // Once delivery works, the next batch goes out, and is traced as delivered.
  fails = false;
  gate.evaluate(MENTION);
  t.mock.timers.tick(1000);
  assert.deepEqual(wakes, ['agent']);
  assert.deepEqual(delivered, ['quiet']);
});

test('a behavior holding two kinds names the problems of the kind it doesn\'t read too, and loads as before', (t) => {
  const dir = tempDir(t);
  t.mock.method(console, 'error', () => {});
  const both = { debounce: 50, rate_limit: { tokens: 'bad' } };
  const { gate } = makeGate(dir, { file: { default: 'always', policies: [] } });

  assert.equal(
    refusal(gate, { behavior: both }),
    'Rule "r" wasn\'t saved: behavior holds "debounce" and "rate_limit", and a rule has one behavior; '
      + 'behavior.debounce is 50 ms, under the 100 ms minimum; '
      + 'behavior.rate_limit.tokens is "bad", where a positive number is needed; '
      + 'behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed.',
  );

  // gate.json's rule is read as its debounce, as before, and each problem is named, the kind read first.
  const loaded = makeGate(tempDir(t), { file: { default: 'always', policies: [{ name: 'both', behavior: both }] } });
  assert.deepEqual(behaviors(loaded.gate), [{ debounce: 100 }]);
  const said = loaded.gate.getStatus().errors[0] ?? '';
  assert.ok(
    said.includes(
      'Rule "both": behavior holds "debounce" and "rate_limit", and a rule has one behavior, so only its "debounce" is read; '
      + 'behavior.debounce is 50 ms, under the 100 ms minimum, so it\'s read as 100 ms; '
      + 'behavior.rate_limit.tokens is "bad", where a positive number is needed, which goes unread with the rest of "rate_limit"; '
      + 'behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed, which goes unread with the rest of "rate_limit".',
    ),
    said,
  );

  // Three, written in another order: debounce is read, then each other kind's problems follow, rate_limit's then passive_sample's.
  const three = { passive_sample: { every: 0.5 }, rate_limit: { tokens: 'bad' }, debounce: 50 };
  assert.equal(
    refusal(gate, { behavior: three }),
    'Rule "r" wasn\'t saved: behavior holds "debounce", "rate_limit" and "passive_sample", and a rule has one behavior; '
      + 'behavior.debounce is 50 ms, under the 100 ms minimum; '
      + 'behavior.rate_limit.tokens is "bad", where a positive number is needed; '
      + 'behavior.rate_limit.refillIntervalMs is missing, where a positive number of milliseconds is needed; '
      + 'behavior.passive_sample.every is 0.5, not a whole number.',
  );
  const loadedThree = makeGate(tempDir(t), { file: { default: 'always', policies: [{ name: 'three', behavior: three }] } });
  assert.deepEqual(behaviors(loadedThree.gate), [{ debounce: 100 }]);
  const saidThree = loadedThree.gate.getStatus().errors[0] ?? '';
  assert.ok(
    saidThree.includes(
      'which goes unread with the rest of "rate_limit"; '
      + 'behavior.passive_sample.every is 0.5, not a whole number, which goes unread with the rest of "passive_sample".',
    ),
    saidThree,
  );
});

test('a rule a write removes has its pending debounce batch delivered', (t) => {
  const dir = tempDir(t);
  t.mock.method(console, 'error', () => {});
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [{ name: 'quiet', match: {}, behavior: { debounce: 60000 } }] }));
  const wakes: string[] = [];
  const inForce: string[][] = [];
  const gate = new EventGate({
    configPath, emitTrace: () => {}, addMessage: () => '', getAgentNames: () => ['agent'],
    requestInference: (agent) => { wakes.push(agent); inForce.push(names(gate)); },
  });
  t.after(() => gate.dispose());
  assert.equal(gate.evaluate(MENTION).trigger, false, 'the event waits in the debounce batch');

  assert.equal(gate.removePolicy('quiet'), true);
  assert.deepEqual(wakes, ['agent'], 'the batch is delivered once the write has removed its rule');
  assert.deepEqual(inForce, [[]], 'and its rule is out of force when the batch is delivered');
  assert.deepEqual(names(gate), []);
});

test("a write that changes a debounce rule sends its batch as the timer would: held while an agent's turn runs", async (t) => {
  const dir = tempDir(t);
  t.mock.method(console, 'error', () => {});
  const configPath = join(dir, 'gate.json');
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [{ name: 'quiet', match: {}, behavior: { debounce: 60000 } }] }));
  const wakes: string[] = [];
  const gate = new EventGate({
    configPath, emitTrace: () => {}, addMessage: () => '', getAgentNames: () => ['agent'],
    requestInference: (agent) => { wakes.push(agent); },
  });
  t.after(() => gate.dispose());
  assert.equal(gate.evaluate(MENTION).trigger, false, 'the event waits in the debounce batch');

  // The agent's turn is the one that calls wake_add_rule.
  gate.onInferenceStarted('agent');
  gate.addPolicy({ name: 'quiet', match: {}, behavior: 'always' });
  assert.deepEqual(wakes, [], 'the batch is held while the turn runs');
  gate.onInferenceEnded('agent');
  await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
  assert.deepEqual(wakes, ['agent'], 'and sent when it ends');
});

test("a write clears every rule's state before it sends a batch, and sends each batch on its own; one whose delivery throws is named in the log and dropped, and the change returns as made", (t) => {
  const dir = tempDir(t);
  const logged = t.mock.method(console, 'error', () => {});
  const configPath = join(dir, 'gate.json');
  const quiet = { name: 'quiet', match: { tagsAny: ['chat:mention'] }, behavior: { debounce: 60000 } };
  const limited = { name: 'limited', match: { tagsAny: ['chat:ambient'] }, behavior: { rate_limit: { tokens: 1, refillIntervalMs: 3_600_000 } } };
  const later = { name: 'later', match: { tagsAny: ['chat:dm'] }, behavior: { debounce: 60000 } };
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [quiet, limited, later] }));
  // The first delivery can't reach the agent; the next can.
  let deliveries = 0;
  const wakes: string[] = [];
  // Whether limited's bucket is still there as each batch is sent.
  const bucketAtDelivery: boolean[] = [];
  const gate: EventGate = new EventGate({
    configPath, emitTrace: () => {}, getAgentNames: () => ['agent'], requestInference: (agent) => { wakes.push(agent); },
    addMessage: () => {
      bucketAtDelivery.push((gate as unknown as { rateLimitBuckets: Map<string, unknown> }).rateLimitBuckets.has('limited'));
      if (++deliveries === 1) throw new Error('no agent to deliver to');
      return '';
    },
  });
  t.after(() => gate.dispose());
  const ambient = event(['chat:ambient']);
  assert.equal(gate.evaluate(MENTION).trigger, false, "the mention waits in quiet's batch");
  assert.equal(gate.evaluate(event(['chat:dm'])).trigger, false, "and the DM in later's");
  assert.equal(gate.evaluate(ambient).trigger, true, "limited's one token");
  assert.equal(gate.evaluate(ambient).trigger, false, 'spent');

  // gate.json is edited to drop all three, and a change is made before a reload reads it; quiet's batch, sent first, can't be delivered.
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [] }));
  assert.deepEqual(gate.addPolicy(MENTIONS), MENTIONS, 'the change returns as made');
  assert.deepEqual(onDisk(configPath).policies.map((p) => p.name), ['mentions'], 'it was saved');
  assert.deepEqual(names(gate), ['mentions'], 'and is in force');
  assert.deepEqual(
    logged.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.includes('pending batch')),
    ['[gate] Rule "quiet": its pending batch of 1 event couldn\'t be delivered (no agent to deliver to), so the batch is dropped'],
  );
  const state = gate as unknown as { rateLimitBuckets: Map<string, unknown>; debounceTimers: Map<string, unknown> };
  assert.equal(state.rateLimitBuckets.has('limited'), false, "limited's spent bucket is cleared, though quiet's batch came first");
  assert.deepEqual(bucketAtDelivery, [false, false], 'every rule is cleared before any batch is sent');
  assert.equal(state.debounceTimers.has('quiet'), false, "quiet's batch isn't left to be sent again");
  assert.deepEqual(wakes, ['agent'], "later's batch is still sent");
  assert.equal(state.debounceTimers.has('later'), false, 'and nothing is left behind');
});

test("a reload whose pending batch can't be delivered still puts the new rules in force, naming the batch it dropped", (t) => {
  const dir = tempDir(t);
  const logged = t.mock.method(console, 'error', () => {});
  const configPath = join(dir, 'gate.json');
  const quiet = { name: 'quiet', match: { tagsAny: ['chat:mention'] }, behavior: { debounce: 60000 } };
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [quiet] }));
  const gate = new EventGate({
    configPath, emitTrace: () => {}, getAgentNames: () => ['agent'], requestInference: () => {},
    addMessage: () => { throw new Error('no agent to deliver to'); },
  });
  t.after(() => gate.dispose());
  assert.equal(gate.evaluate(MENTION).trigger, false, "the mention waits in quiet's batch");

  // gate.json is edited to drop the rule, and the reload's delivery of its batch throws.
  writeFileSync(configPath, JSON.stringify({ default: 'always', policies: [MENTIONS] }));
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(gate.evaluate(MENTION).trigger, true, 'the new rules are in force, so the mention wakes the agent');
  assert.deepEqual(names(gate), ['mentions']);
  assert.deepEqual(
    logged.mock.calls.map((c) => String(c.arguments[0])).filter((line) => line.includes('pending batch')),
    ['[gate] Rule "quiet": its pending batch of 1 event couldn\'t be delivered (no agent to deliver to), so the batch is dropped'],
  );
  assert.equal((gate as unknown as { debounceTimers: Map<string, unknown> }).debounceTimers.has('quiet'), false, 'nothing is left behind');
});

test("a change whose write of gate.json fails says whether gate.json was changed, and the rules in force stay", (t) => {
  const { gate, configPath } = makeGate(tempDir(t), { file: { policies: [MENTIONS] } });
  const before = readFileSync(configPath, 'utf-8');
  const original = fs.writeFileSync;
  const asWas = (error: string): string => `gate.json couldn't be written (${error}), so nothing was saved: the rules in force and `
    + 'gate.json stay as they were. Whoever runs this host can fix what keeps it from being written.';
  const partway = (error: string): string => `Writing gate.json failed partway (${error}), so the change isn't in force: the rules in `
    + 'force stay as they were. gate.json may hold the whole change, which the gate reads at its next reload; or it may hold part '
    + 'of it or nothing, which the gate can\'t read, and then they stay until gate.json is fixed. Whoever runs this host can fix '
    + 'what kept it from being written, and check what gate.json holds.';
  /** A change whose `call` fails as `syscall` reports, after writing `landed` characters of its text. */
  const failing = (call: 'mkdirSync' | 'writeFileSync', syscall: string, error: string, landed = 0): string => {
    const cause = Object.assign(new Error(error), { code: error.split(':')[0], syscall });
    const mock = t.mock.method(fs, call, (path: unknown, data: unknown) => {
      if (landed > 0) original(path as string, String(data).slice(0, landed));
      throw cause;
    });
    syncBuiltinESMExports();
    let thrown: unknown;
    try {
      gate.addPolicy({ name: 'dm', match: { tagsAny: ['chat:dm'] }, behavior: 'always' });
    } catch (err) {
      thrown = err;
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
    assert.ok(thrown instanceof Error, `the change throws when ${syscall} fails`);
    assert.equal(thrown.cause, cause, 'with the filesystem error as its cause');
    return thrown.message;
  };
  // Its directory or its open fails: nothing was written.
  assert.equal(failing('mkdirSync', 'mkdir', "EACCES: permission denied, mkdir 'state'"), asWas("EACCES: permission denied, mkdir 'state'"));
  assert.equal(failing('writeFileSync', 'open', "EACCES: permission denied, open 'gate.json'"), asWas("EACCES: permission denied, open 'gate.json'"));
  assert.equal(readFileSync(configPath, 'utf-8'), before);
  // It fails partway: what landed is there.
  assert.equal(failing('writeFileSync', 'write', 'ENOSPC: no space left on device, write', 10), partway('ENOSPC: no space left on device, write'));
  assert.equal(readFileSync(configPath, 'utf-8').length, 10);
  assert.deepEqual(names(gate), ['mentions'], 'the rules in force stay');
  // Its close fails after the whole text landed: the next reload reads the change.
  writeFileSync(configPath, before);
  assert.equal(failing('writeFileSync', 'close', 'EIO: i/o error, close', Infinity), partway('EIO: i/o error, close'));
  assert.deepEqual(onDisk(configPath).policies.map((rule) => rule.name), ['mentions', 'dm']);
  (gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  gate.evaluate(MENTION);
  assert.deepEqual(names(gate), ['mentions', 'dm'], 'the next reload reads the whole change');
});

test('a removal by a name that is not a non-empty string finds no rule, so rules gate.json holds with no name stay', (t) => {
  const unnamed = { match: { tagsAny: ['chat:dm'] }, behavior: 'always' };
  const { gate, configPath } = makeGate(tempDir(t), { file: { policies: [MENTIONS, unnamed] } });
  const before = readFileSync(configPath, 'utf-8');
  for (const name of [undefined, '', null, 5]) assert.equal(gate.removePolicy(name as unknown as string), false, String(name));
  assert.equal(readFileSync(configPath, 'utf-8'), before);
});

test("a change that would leave a gate.json the gate doesn't use with no rules in force is refused, since its default would hold back every event", (t) => {
  t.mock.method(console, 'error', () => {});
  // Its one rule names no kind, so the gate leaves it out, and under "skip" doesn't use the file.
  const deafening = { default: 'skip', policies: [{ name: 'x', match: {}, behavior: {} }] };
  const refused = (runs: string, path: string): string => `Nothing was saved: with this change, gate.json, at ${path}, would have no rules the gate `
    + `reads, and its default would hold back every event. Meanwhile the gate runs ${runs}. Replacing "x" by name would bring gate.json into force.`;
  const starting = { default: 'skip', policies: [MENTIONS] };

  // At a later start, which runs the host's starting rules in its place.
  const later = makeGate(tempDir(t), { file: deafening, initialConfig: starting });
  const written = readFileSync(later.configPath, 'utf-8');
  assert.throws(() => later.gate.removePolicy('x'), { message: refused("the host's starting rules", later.configPath) });
  assert.equal(readFileSync(later.configPath, 'utf-8'), written, 'nothing was written');
  assert.equal(later.gate.evaluate(MENTION).trigger, true, 'the starting rules still wake the agent');
  // A replacement that leaves it a rule in force brings it into force.
  later.gate.addPolicy({ name: 'x', match: { tagsAny: ['chat:dm'] }, behavior: 'always' });
  assert.deepEqual(names(later.gate), ['x']);

  // At a reload, which keeps the rules in force.
  const reload = makeGate(tempDir(t), { file: { default: 'skip', policies: [MENTIONS] } });
  writeFileSync(reload.configPath, JSON.stringify(deafening));
  (reload.gate as unknown as { lastReloadCheck: number }).lastReloadCheck = 0;
  assert.equal(reload.gate.evaluate(MENTION).trigger, true);
  assert.match(reload.gate.getStatus().errors.join(' '), /isn't in force/, 'the reload read it');
  assert.deepEqual(names(reload.gate), ['mentions'], 'and kept the rules in force');
  assert.throws(() => reload.gate.removePolicy('x'), { message: refused(RUNS_LAST, reload.configPath) });
  assert.equal(reload.gate.evaluate(MENTION).trigger, true);

  // A removal that leaves only a rule the gate leaves out leaves no rules in force, though the list holds one: a rate
  // limit with no tokens, which wakes on nothing, so it doesn't keep the file out.
  const quietOut = { name: 'q', match: {}, behavior: { rate_limit: { tokens: 0, refillIntervalMs: 60000 } } };
  const leftOnly = makeGate(tempDir(t), { file: { default: 'skip', policies: [deafening.policies[0], quietOut] }, initialConfig: starting });
  assert.throws(() => leftOnly.gate.removePolicy('x'), { message: refused("the host's starting rules", leftOnly.configPath) });
  assert.deepEqual(onDisk(leftOnly.configPath).policies.map((rule) => rule.name), ['x', 'q'], 'nothing was written');

  // Of two rules of one name, a removal takes both, so it isn't offered either.
  const twice = makeGate(tempDir(t), { file: { default: 'skip', policies: [deafening.policies[0], deafening.policies[0]] }, initialConfig: starting });
  assert.throws(() => twice.gate.removePolicy('x'), {
    message: `Nothing was saved: with this change, gate.json, at ${twice.configPath}, would have no rules the gate reads, and its default `
      + 'would hold back every event. Meanwhile the gate runs the host\'s starting rules. gate.json has 2 rules named "x", and a change by that '
      + 'name replaces the first of them.',
  });

  // Beside another rule the removal leaves, it's offered and goes through.
  const beside = makeGate(tempDir(t), { file: { default: 'skip', policies: [{ name: 'x', match: {}, behavior: {} }, MENTIONS] }, initialConfig: starting });
  assert.throws(() => beside.gate.addPolicy({ name: 'y', behavior: 'skip' }), /Replacing or removing "x" by name would bring gate\.json into force\.$/);
  assert.equal(beside.gate.removePolicy('x'), true);
  assert.deepEqual(names(beside.gate), ['mentions']);
});
