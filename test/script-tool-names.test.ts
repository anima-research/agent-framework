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
  assert.deepEqual(read('await say ({})'), { names: ['say'], reachable: [] }, 'a space before the call');
});

test('no tools names nothing', () => {
  assert.deepEqual([...scriptToolNames('await say({})', []).names], []);
  assert.deepEqual([...scriptToolNames('await say({})', []).reachable], []);
});

test('an alias, a definition or a kept key leaves the tool reachable', () => {
  assert.deepEqual(read('post = test__send_message'), { names: ['send_message'], reachable: ['send_message'] });
  assert.deepEqual(read('async def post():\n    await test__send_message({})'),
    { names: ['send_message'], reachable: ['send_message'] });
  assert.deepEqual(read('quiet = lambda: skip_reply({})'), { names: ['skip_reply'], reachable: ['skip_reply'] });
  assert.deepEqual(read('name = "test--send_message"'), { names: ['send_message'], reachable: ['send_message'] });
  assert.deepEqual(read('name = "say"'), { names: ['say'], reachable: ['say'] }, 'a bare whole name, as a key kept in a variable');
});

test('a key is a whole tool name, optionally namespaced, not a sentence that ends in one', () => {
  assert.deepEqual(read('print("to speak, call world--say")'), { names: ['say'], reachable: [] });
  assert.deepEqual(read('print("use mcpl__world__say")'), { names: ['say'], reachable: [] });
  assert.deepEqual(read('k = "mcpl__world__say"'), { names: ['say'], reachable: ['say'] });
  // A prefix can hold punctuation besides `-` and `_`.
  assert.deepEqual(read('post = tools["mcpl--zulip.work--say"]'), { names: ['say'], reachable: ['say'] }, 'a `.` in the prefix');
  assert.deepEqual(read('post = tools["discord:v1--say"]'), { names: ['say'], reachable: ['say'] }, 'a `:` in the prefix');
});

test("a direct call outside a definition leaves nothing reachable, beside a definition that doesn't use the tool", () => {
  assert.deepEqual(read('def fmt(x):\n    return x\nawait say({"text": fmt("hi")})'), { names: ['say'], reachable: [] });
  assert.deepEqual(read('await say(sorted(xs, key=lambda x: x))'), { names: ['say'], reachable: [] }, 'a lambda after the call');
  assert.deepEqual(read('k = lambda x: x\nawait say({})'), { names: ['say'], reachable: [] }, "a lambda's span ends with its logical line");
  // A line that opens with a string stands where it's written: at column 0 it
  // ends the def before it, as Python reads it.
  assert.deepEqual(read('def f():\n    return 1\n"%s" % say({})'), { names: ['say'], reachable: [] }, 'a call on a line that opens with a string');
  assert.deepEqual(read('def f():\n    return 1\n"""note"""\nawait say({})'), { names: ['say'], reachable: [] }, 'a string-only line after a def');
  assert.deepEqual(read('def f():\n# a comment at column 0\n    await say({})'), { names: ['say'], reachable: ['say'] }, "a comment doesn't end a def");
  assert.deepEqual(read('def f():\n    return "("\nawait say({})'), { names: ['say'], reachable: [] }, "a bracket in a string continues no line");
  assert.deepEqual(read('print("a lambda"); await say({})'), { names: ['say'], reachable: [] }, "a lambda in a string isn't one");
});

test('a name inside a definition is reachable, a called key included, whatever lines the definition spans', () => {
  assert.deepEqual(read('def go():\n    return tools["say"]({})'), { names: ['say'], reachable: ['say'] });
  // A header over several lines, and a body line continued inside brackets at
  // no indentation, as Python allows; the call after the definition is direct.
  assert.deepEqual(read('async def post(\n    text,\n):\n    x = [\n1,\n]\n    await say({"text": text})\nawait skip_reply({})'),
    { names: ['say', 'skip_reply'], reachable: ['say'] });
  assert.deepEqual(read('class Poster:\n    async def go(self):\n        await send_message({})\n\nawait think({})'),
    { names: ['send_message', 'think'], reachable: ['send_message'] });
  // A line a string literal carries over continues its statement, whatever its
  // indentation (Ramona-2416); so does a blank line written with \r\n.
  assert.deepEqual(read('if True:\n    def f():\n        q = """\n"""; await say({})'), { names: ['say'], reachable: ['say'] }, 'a line opened inside a triple-quoted string');
  assert.deepEqual(read('if True:\n    def f():\n        q = "a\\\n"; await say({})'), { names: ['say'], reachable: ['say'] }, 'a line opened inside a backslash-continued string');
  assert.deepEqual(read('def f():\r\n    x = 1\r\n\r\n    # a note\r\n    await say({})\r\n'), { names: ['say'], reachable: ['say'] }, 'a blank \\r\\n line and a comment');
  // A backslash at a line's end continues it in code too.
  assert.deepEqual(read('def f():\n    x = 1 + \\\n2; await say({})'), { names: ['say'], reachable: ['say'] }, 'a line continued by a backslash in code');
  // ...a header's too: `async \` with `def` on the next line is one `async def`.
  assert.deepEqual(read('async \\\ndef quiet():\n    await skip_reply({})\nawait say({})'), { names: ['say', 'skip_reply'], reachable: ['skip_reply'] }, 'async joined to def by a backslash');
  assert.deepEqual(read('async \\\n    \\\n  def quiet():\n    await skip_reply({})'), { names: ['skip_reply'], reachable: ['skip_reply'] }, 'a header over two backslash joins');
  assert.deepEqual(read('f = (lambda x:\n    say(x))'), { names: ['say'], reachable: ['say'] }, "a lambda's body on its continued line");
});

test("a class's own body runs as the class statement does, so a direct call there leaves nothing reachable", () => {
  assert.deepEqual(read('class A:\n    say({})'), { names: ['say'], reachable: [] });
  assert.deepEqual(read('class A:\n    post = say'), { names: ['say'], reachable: ['say'] }, 'an alias kept on the class');
});

test("a name at a line's end, before a line that opens with a bracket, is a reference, not a call", () => {
  assert.deepEqual(read('alias = say\n(print("x"))'), { names: ['say'], reachable: ['say'] });
  assert.deepEqual(read('post = tools["say"]\n(print("x"))'), { names: ['say'], reachable: ['say'] }, 'a key, likewise');
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

test('a name right after an escape in a string counts, as the string run as code would call it', () => {
  assert.deepEqual(read('exec("x = 1\\nsay({})")'), { names: ['say'], reachable: [] });
  for (const escape of ['\\x0a', '\\u000a', '\\U0000000a', '\\N{LINE FEED}', '\\012']) {
    assert.deepEqual(read(`exec("x = 1${escape}say({})")`), { names: ['say'], reachable: [] }, escape);
  }
});

test("an f-string's call inside its braces counts for its own round but leaves nothing reachable", () => {
  assert.deepEqual(read('print(f"result: {say({\'text\': \'hi\'})}")'), { names: ['say'], reachable: [] });
});

test('a # inside a string starts no comment', () => {
  assert.deepEqual(read('label = "say #3"; post = test__send_message'),
    { names: ['say', 'send_message'], reachable: ['send_message'] });
});

test("a string in one quote mark, not three, ends at its line's end, so a stray quote can't take the rest of the script", () => {
  assert.deepEqual(read('x = "unclosed\npost = test__send_message'), { names: ['send_message'], reachable: ['send_message'] });
  assert.deepEqual(read("x = 'unclosed\npost = test__send_message"), { names: ['send_message'], reachable: ['send_message'] });
});

test("what goes unseen: a name the code doesn't spell out, an enumeration, code from a file, a call in a string's text inside a definition, a call that outlives its script, an alias made inside a string or an f-string's field, code kept in a string", () => {
  assert.deepEqual(read('name = "skip" + "_reply"\nawait tools[name]({})'), { names: [], reachable: [] }, 'built at runtime');
  assert.deepEqual(read('await tools["s\\x61y"]({})'), { names: [], reachable: [] }, 'written with escapes');
  assert.deepEqual(read('fns = list(tools.values())'), { names: [], reachable: [] }, 'an enumeration');
  assert.deepEqual(read('exec(open("helper.py").read())'), { names: [], reachable: [] }, 'code from a file');
  assert.deepEqual(read('def f():\n    exec("say({})")'), { names: ['say'], reachable: [] }, "a call in a string's text inside a definition");
  assert.deepEqual(read('pending = say({"text": "hi"})'), { names: ['say'], reachable: [] }, 'a call made here...');
  assert.deepEqual(read('await pending'), { names: [], reachable: [] }, '...and awaited later');
  assert.deepEqual(read('asyncio.create_task(say({"text": "hi"}))'), { names: ['say'], reachable: [] }, 'a call scheduled as a task');
  assert.deepEqual(read('gen = (say({"text": m}) for m in msgs)'), { names: ['say'], reachable: [] }, 'a call left in a generator expression');
  assert.deepEqual(read('exec("post = say")'), { names: ['say'], reachable: [] }, 'an alias made inside a string the script runs');
  assert.deepEqual(read('print(f"{(post := say)}")'), { names: ['say'], reachable: [] }, "an alias made inside an f-string's field");
  assert.deepEqual(read('later = "say({\'text\': \'hi\'})"'), { names: ['say'], reachable: [] }, 'code kept in a string...');
  assert.deepEqual(read('await eval(later)'), { names: [], reachable: [] }, '...and run later');
});
