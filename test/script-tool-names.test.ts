/**
 * scriptToolNames reads a code_execution script as Python reads it: which
 * routing tools it names, which hold its own round, and which it leaves
 * reachable by a later script, which mark the interpreter. code-execution's
 * tests run the gate and the mark through real scripts; these pin the
 * reading itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptToolNames } from '../src/code-execution/script-tool-names.js';

const TOOLS = ['skip_reply', 'send_message', 'say', 'think'];
const read = (script: string) => {
  const { names, reachable } = scriptToolNames(script, TOOLS);
  return { names: [...names].sort(), reachable: [...reachable].sort() };
};

test('a name counts where Python could call it, not inside a longer identifier', () => {
  assert.deepEqual(read('say_hello = 1\nmy_say = 2\nsend_message_log = []'), { names: [], reachable: [] });
  assert.deepEqual(read('await mcpl__world__say({})'), { names: ['say'], reachable: [] });
});

test('a direct call leaves nothing reachable, by name or by key', () => {
  assert.deepEqual(read('await think({"content": "notes"})\nawait tools["think"]({"content": "more"})'),
    { names: ['think'], reachable: [] });
  assert.deepEqual(read('await tools[ "world--say" ] ({})'), { names: ['say'], reachable: [] });
});

test('an alias, a definition or a kept key leaves the tool reachable', () => {
  assert.deepEqual(read('post = test__send_message'), { names: ['send_message'], reachable: ['send_message'] });
  assert.deepEqual(read('async def post():\n    await test__send_message({})'),
    { names: ['send_message'], reachable: ['send_message'] });
  assert.deepEqual(read('quiet = lambda: skip_reply({})'), { names: ['skip_reply'], reachable: ['skip_reply'] });
  assert.deepEqual(read('name = "test--send_message"'), { names: ['send_message'], reachable: ['send_message'] });
});

test('a comment names nothing, and its words are not code', () => {
  assert.deepEqual(read('await test__slow({})  # then skip_reply, or say so'), { names: [], reachable: [] });
  assert.deepEqual(read('say("hi")  # first class result'), { names: ['say'], reachable: [] });
});

test('a sentence in a string counts for its own round but leaves nothing reachable', () => {
  assert.deepEqual(read('# I think this works\ndef fmt(x):\n    return x\nprint("They say the build is green")'),
    { names: ['say'], reachable: [] });
  assert.deepEqual(read('def fmt(result):\n    print(f"I would say {result}")'), { names: ['say'], reachable: [] });
});

test('a triple-quoted string runs across lines, with quotes and # inside it', () => {
  assert.deepEqual(read('note = """They said "skip_reply" # not a comment\nI think"""\npost = test__send_message'),
    { names: ['send_message', 'skip_reply', 'think'], reachable: ['send_message'] });
});

test('in a raw string, a backslash still keeps the quote after it inside the string', () => {
  assert.deepEqual(read('pattern = r"\\" # say"\npost = test__send_message'),
    { names: ['say', 'send_message'], reachable: ['send_message'] });
});

test('an escaped quote stays inside its string', () => {
  assert.deepEqual(read('msg = "she said \\"skip_reply\\" # done"'), { names: ['skip_reply'], reachable: [] });
});

test("an f-string's call inside its braces counts for its own round but leaves nothing reachable", () => {
  assert.deepEqual(read('print(f"result: {say({\'text\': \'hi\'})}")'), { names: ['say'], reachable: [] });
});

test('a # inside a string starts no comment', () => {
  assert.deepEqual(read('label = "say #3"; post = test__send_message'),
    { names: ['say', 'send_message'], reachable: ['send_message'] });
});

test("a string in single quotes ends at its line's end, so a stray quote can't take the rest of the script", () => {
  assert.deepEqual(read('x = "unclosed\npost = test__send_message'), { names: ['send_message'], reachable: ['send_message'] });
});

test("what goes unseen: a name the code doesn't spell out, an enumeration, code from a file, a call awaited later, code kept in a string", () => {
  assert.deepEqual(read('name = "skip" + "_reply"\nawait tools[name]({})'), { names: [], reachable: [] }, 'built at runtime');
  assert.deepEqual(read('await tools["s\\x61y"]({})'), { names: [], reachable: [] }, 'written with escapes');
  assert.deepEqual(read('fns = list(tools.values())'), { names: [], reachable: [] }, 'an enumeration');
  assert.deepEqual(read('exec(open("helper.py").read())'), { names: [], reachable: [] }, 'code from a file');
  assert.deepEqual(read('pending = say({"text": "hi"})'), { names: ['say'], reachable: [] }, 'a call made here...');
  assert.deepEqual(read('await pending'), { names: [], reachable: [] }, '...and awaited later');
  assert.deepEqual(read('later = "say({\'text\': \'hi\'})"'), { names: ['say'], reachable: [] }, 'code kept in a string...');
  assert.deepEqual(read('await eval(later)'), { names: [], reachable: [] }, '...and run later');
});
