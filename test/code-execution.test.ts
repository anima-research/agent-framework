/**
 * Client-side programmatic tool calling (code_execution) tests.
 *
 * PyRunner tests spawn a REAL python3 subprocess — the protocol, top-level
 * await, tool-function injection, timeout, and deadline behavior are all
 * exercised end-to-end. Framework tests drive a full agent turn through the
 * MockMembrane and assert the load-bearing invariant: inner tool results
 * reach the running script but never the model-facing tool_result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ChildProcess, execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Writable } from 'node:stream';
import type {
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ScriptToolResult,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../src/index.js';
import { AgentFramework, PYTHON_RUNTIME_SOURCE, PyRunner, buildInjectedTools } from '../src/index.js';
import { OutputStream } from '../src/code-execution/py-runner.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';
import type { ContentBlock } from '@animalabs/membrane';
import { PYTC_STOP_ROWS_DRIVER } from './helpers/pytc-stop-rows.js';
import { UNREACHED_WATCHDOG, silenceRun } from './helpers/run-watchdog.js';

const ECHO_TOOLS: { pyName: string; toolName: string }[] = [
  { pyName: 'test__echo', toolName: 'test--echo' },
];

/** Wait for a condition, failing after 10 s rather than hanging the run. */
const until = async (cond: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Wait for a promise, failing after 10 s rather than hanging the run. */
const within = <T>(promise: Promise<T>, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

/** Whether a process is still there to signal. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** What a script's result says when its interpreter exits under it (py-runner's
 *  interpreterExit), for `how` such as "exited with code 3" or "was ended by SIGKILL",
 *  with `check` for the advice's first step after a crash's signal. */
const exitedUnder = (how: string, background = false, check?: string): string =>
  `script stopped: the Python interpreter ${how} while it ran, so the rest of the script didn't run`
  + `${background ? '' : ', and variables from earlier scripts are gone'}. Tool calls it had already made keep their effects, `
  + `so check them before you run it again in a new interpreter. If it stops the same way, ${check ?? 'check whether the script itself '
  + `ends the process, for example ${
    how === 'was ended by SIGKILL' ? 'by using too much memory' : how.startsWith('was ended by') ? 'with os.kill()' : 'with os._exit()'}`
  }; if not, ask whoever runs this host.`;

/** The advice's first step after a crash's signal, with faulthandler's traceback above it, and without. */
const NATIVE_CRASH = 'check the traceback above for the call that crashed in native code, such as an extension module the script uses';
const NATIVE_CRASH_UNSEEN = 'check whether native code the script calls crashes, such as an extension module it uses';

/**
 * What a script's result says when its interpreter exits after the script's own
 * result came, before all of its output arrived (py-runner's interpreterExit,
 * ended), with the advice for a runtime that ended itself over `taken`, if given,
 * and `check` for the advice's first step after a crash's signal, as exitedUnder's.
 */
const exitedAfterEnd = (how: string, taken?: string, background = false, check?: string): string =>
  `script ended, but the Python interpreter ${how} before all of its output reached the host, so some of it may be missing`
  + `${background ? '' : ', and variables from earlier scripts are gone'}. If it happens again, `
  + (taken
    ? `check whether the script closes, shuts down or replaces ${taken}, as the runtime's line above says`
    : check ?? `check whether the script itself ends the process, for example ${
      how === 'was ended by SIGKILL' ? 'by using too much memory' : how.startsWith('was ended by') ? 'with os.kill()' : 'with os._exit()'}`)
  + '; if not, ask whoever runs this host.';

/** The result's text after the runtime ended itself because a script took one of its file descriptors. */
const runtimeLost = (taken: string): string =>
  "script stopped: the Python interpreter exited with code 70 while it ran, so the rest of the script didn't run, and variables "
  + 'from earlier scripts are gone. Tool calls it had already made keep their effects, so check them before you run it again in '
  + `a new interpreter. If it stops the same way, check whether the script closes, shuts down or replaces ${taken}, as the runtime's line above `
  + 'says; if not, ask whoever runs this host.';

describe('buildInjectedTools', () => {
  it('sanitizes -- to __ and keeps valid identifiers', () => {
    const injected = buildInjectedTools(['mcpl--discord--send_message', 'think']);
    assert.deepStrictEqual(injected, [
      { pyName: 'mcpl__discord__send_message', toolName: 'mcpl--discord--send_message' },
      { pyName: 'think', toolName: 'think' },
    ]);
  });

  it('sanitizes single hyphens inside segments (live fleet names)', () => {
    // Found on the first Mica canary run: module/server ids with single
    // hyphens were skipped entirely. They must inject.
    const injected = buildInjectedTools([
      'mcpl-admin--mcpl_deploy',
      'mcpl--dog-events--dog_events_status',
      'channel-mode--set_channel_mode',
    ]);
    assert.deepStrictEqual(injected, [
      { pyName: 'mcpl_admin__mcpl_deploy', toolName: 'mcpl-admin--mcpl_deploy' },
      { pyName: 'mcpl__dog_events__dog_events_status', toolName: 'mcpl--dog-events--dog_events_status' },
      { pyName: 'channel_mode__set_channel_mode', toolName: 'channel-mode--set_channel_mode' },
    ]);
  });

  it('prefixes a leading digit', () => {
    const injected = buildInjectedTools(['3d-tools--render']);
    assert.deepStrictEqual(injected, [{ pyName: '_3d_tools__render', toolName: '3d-tools--render' }]);
  });

  it('skips colliding sanitized names loudly (first wins)', () => {
    const logs: string[] = [];
    const injected = buildInjectedTools(['a--b', 'a__b'], (m) => logs.push(m));
    assert.deepStrictEqual(injected, [{ pyName: 'a__b', toolName: 'a--b' }]);
    assert.strictEqual(logs.length, 1);
    assert.match(logs[0], /collides/);
  });
});

describe("OutputStream: what a pipe brings while no script of its interpreter runs", () => {
  const head = 'stdout while its interpreter runs no script: ';
  const dropped = `${head}past 65536 characters of the log, so the host drops what follows while its interpreter runs no script`;
  const open = () => {
    const pipe = new PassThrough();
    const logged: string[] = [];
    const stream = new OutputStream('stdout', pipe, (line) => logged.push(line), () => {});
    return { pipe, logged, stream };
  };
  /** Each piece as a chunk of its own, read before the next is written. */
  const feed = async (pipe: PassThrough, pieces: string[]) => {
    for (const piece of pieces) {
      pipe.write(piece);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const logChars = (logged: string[]) => logged.filter((l) => l !== dropped).reduce((sum, l) => sum + l.length, 0);

  it('logs pieces cut at 2,000 characters, from its start, in lines of 65,536 characters in all, the last cut to fit, then one line dropping the rest', async () => {
    const { pipe, logged } = open();
    await feed(pipe, Array.from({ length: 40 }, (_, i) => `${i} `.padEnd(3000, 'y')));
    assert.strictEqual(logged[0], `${head}0 ${'y'.repeat(1998)} [… 1000 more characters]`);
    assert.strictEqual(logged.filter((l) => l === dropped).length, 1);
    assert.strictEqual(logged.at(-1), dropped);
    assert.strictEqual(logChars(logged), 65_536);
  });

  it("charges each line its whole length, so many small writes take no more of the log", async () => {
    const { pipe, logged } = open();
    await feed(pipe, Array.from({ length: 3000 }, () => 'x'));
    assert.strictEqual(logged.at(-1), dropped);
    assert.ok(logChars(logged) <= 65_536, `${logChars(logged)}`);
  });

  it('renews the share as an exec begins, and keeps the exec its own output', async () => {
    const { pipe, logged, stream } = open();
    await feed(pipe, Array.from({ length: 40 }, () => 'y'.repeat(3000)));
    assert.strictEqual(logged.at(-1), dropped);
    const mark = Buffer.from('\x1emark\x1e');
    stream.begin(mark, null);
    await feed(pipe, ["the exec's own", mark.toString()]);
    assert.strictEqual(stream.take(), "the exec's own");
    await feed(pipe, ['after it\n']);
    assert.strictEqual(logged.at(-1), `${head}after it`);
  });

  it('cuts no surrogate pair in half', async () => {
    const { pipe, logged } = open();
    await feed(pipe, [`${'a'.repeat(1999)}\u{1F600}${'b'.repeat(10)}`]);
    assert.strictEqual(logged[0], `${head}${'a'.repeat(1999)} [… 12 more characters]`);
  });

  it("reads a live interpreter's pipe at full speed, and a torn-down one's at about 1 MiB a second, pausing after each chunk, whitespace too", async () => {
    const live = open();
    await feed(live.pipe, ['\n'.repeat(65_536)]);
    assert.strictEqual(live.pipe.isPaused(), false);
    const retired = open();
    retired.stream.retire();
    await feed(retired.pipe, ['\n'.repeat(65_536)]);
    assert.strictEqual(retired.pipe.isPaused(), true);
    // 65,536 bytes at 1 MiB a second: 62.5 ms.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.strictEqual(retired.pipe.isPaused(), false);
  });

  it("holds a torn-down pipe back again when something else resumes it during a wait, as Node does when a child exits, and charges what came then", async () => {
    const { pipe, stream } = open();
    stream.retire();
    await feed(pipe, ['\n'.repeat(65_536)]);
    assert.strictEqual(pipe.isPaused(), true);
    pipe.resume();
    await feed(pipe, ['\n'.repeat(65_536)]);
    assert.strictEqual(pipe.isPaused(), true);
    // The two pieces take 125 ms at 1 MiB a second, so the pipe is still held
    // back once the first piece's 63 ms have passed.
    await new Promise((resolve) => setTimeout(resolve, 95));
    assert.strictEqual(pipe.isPaused(), true);
    await until(() => !pipe.isPaused(), 'the pipe to be read again');
  });
});

describe('PyRunner (real python3)', () => {
  it("no two runners' interpreters share a number, so a mark keyed by one can't match another's", async () => {
    const first = new PyRunner({ onToolCall: async () => '' });
    const second = new PyRunner({ onToolCall: async () => '' });
    try {
      assert.strictEqual(first.interpreter, null, 'no interpreter before the first script');
      await first.exec('x = 1', []);
      await second.exec('x = 1', []);
      assert.notStrictEqual(first.interpreter, null);
      assert.notStrictEqual(second.interpreter, null);
      assert.notStrictEqual(first.interpreter, second.interpreter, 'each interpreter has its own number');
    } finally {
      first.dispose();
      second.dispose();
    }
    assert.strictEqual(first.interpreter, null, 'and none once the runner is disposed');
  });

  it('an interpreter killed by a signal the runner didn\'t send has no number: it is gone', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      await runner.exec('x = 1', []);
      const child = (runner as unknown as { child: import('node:child_process').ChildProcess }).child;
      assert.notStrictEqual(runner.interpreter, null, 'live while it runs');
      const exited = new Promise((resolve) => child.once('exit', resolve));
      process.kill(child.pid!, 'SIGKILL');
      await exited;
      assert.equal(child.killed, false, 'the runner sent no signal');
      assert.strictEqual(runner.interpreter, null, 'and once the signal ended it, none is live');
    } finally {
      runner.dispose();
    }
  });

  it('runs a script and returns stdout', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("hello from python")', []);
      assert.strictEqual(result.returnCode, 0);
      assert.match(result.stdout, /hello from python/);
      assert.strictEqual(result.stderr, '');
    } finally {
      runner.dispose();
    }
  });

  it('round-trips a tool call as an awaited async function', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const runner = new PyRunner({
      onToolCall: async (name, args) => {
        calls.push({ name, args });
        return JSON.stringify({ echoed: args });
      },
    });
    try {
      const result = await runner.exec(
        [
          'import json',
          'r = json.loads(await test__echo({"message": "alpha"}))',
          'print("echoed:", r["echoed"]["message"])',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /echoed: alpha/);
      assert.deepStrictEqual(calls, [{ name: 'test--echo', args: { message: 'alpha' } }]);
    } finally {
      runner.dispose();
    }
  });

  it('gives a script each result as its string, with .is_error and .structured beside it', async () => {
    const structured = JSON.stringify({ content: [], structuredContent: { rows: [1, 2] }, isError: false });
    const oversized = JSON.stringify({ isError: true, oversized: { chars: 9, savedTo: null } });
    const results: Record<string, string | ScriptToolResult> = {
      failed: { text: 'Error: boom', isError: true },
      // Text that merely starts like an error, the case .is_error is for.
      textlike: { text: 'Error: a line of the file, not a failure', isError: false },
      structured: { text: structured, isError: false, structuredJson: true },
      oversized: { text: oversized, isError: true, structuredJson: true },
      // A handler that returns a plain string says nothing about it.
      plain: 'a string, nothing said',
      // Unmarked text holding a structuredContent key is still text.
      jsonlike: { text: '{"structuredContent": {"a": 1}}', isError: false },
    };
    const runner = new PyRunner({
      onToolCall: async (_name, args) => {
        if (args.kind === 'rejects') throw new Error('handler broke');
        // A JS handler can resolve with what its type rules out; the call is
        // still answered, as before this change.
        if (args.kind === 'nothing') return undefined as unknown as string;
        return results[String(args.kind)]!;
      },
    });
    try {
      const result = await runner.exec(
        [
          'import copy, json, pickle',
          'out = {}',
          'for kind in ["failed", "textlike", "structured", "oversized", "plain", "rejects", "jsonlike", "nothing"]:',
          '    r = await test__echo({"kind": kind})',
          '    out[kind] = {"text": str(r), "is_error": r.is_error, "structured": r.structured,',
          '                 "type": type(r).__name__, "is_str": isinstance(r, str)}',
          'r = await test__echo({"kind": "structured"})',
          'out["parsed"] = json.loads(r)["structuredContent"]',
          'out["copies"] = [[c.is_error, c.structured, c == r] for c in (copy.copy(r), pickle.loads(pickle.dumps(r)))]',
          'key = await test__echo({"kind": "plain"})',
          'try:',
          '    await test__echo({key: 1}, extra=2)',
          'except TypeError as e:',
          '    out["refusal"] = str(e)',
          'print(json.dumps(out))',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      const out = JSON.parse(result.stdout) as Record<string, unknown>;
      const seen = (text: string, isError: boolean | null, value: unknown) =>
        ({ text, is_error: isError, structured: value, type: 'ToolResult', is_str: true });
      assert.deepStrictEqual(out.failed, seen('Error: boom', true, null));
      assert.deepStrictEqual(out.textlike, seen('Error: a line of the file, not a failure', false, null));
      assert.deepStrictEqual(out.structured, seen(structured, false, { rows: [1, 2] }));
      // Marked as a structured result's object, but holding no
      // structuredContent: none to read.
      assert.deepStrictEqual(out.oversized, seen(oversized, true, null));
      assert.deepStrictEqual(out.plain, seen('a string, nothing said', null, null));
      // A handler that rejects reaches the script as an error, flagged.
      assert.deepStrictEqual(out.rejects, seen('Error: handler broke', true, null));
      // The string is unchanged for code that parses it itself.
      assert.deepStrictEqual(out.parsed, { rows: [1, 2] });
      // copy and pickle keep both attributes.
      assert.deepStrictEqual(out.copies, [[false, { rows: [1, 2] }, true], [false, { rows: [1, 2] }, true]]);
      assert.deepStrictEqual(out.jsonlike, seen('{"structuredContent": {"a": 1}}', false, null));
      assert.deepStrictEqual(out.nothing, seen('', null, null));
      // A refusal shows a key that is a tool's result as its text, the key the
      // agent has to write, as it shows any str key.
      assert.match(String(out.refusal), /\{'a string, nothing said': <int>, 'extra': <int>\}/);
    } finally {
      runner.dispose();
    }
  });

  it('supports the exact-name tools[...] escape hatch', async () => {
    const runner = new PyRunner({
      onToolCall: async (_name, args) => `got:${String(args.v)}`,
    });
    try {
      const result = await runner.exec(
        'print(await tools["test--echo"]({"v": 7}))',
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /got:7/);
    } finally {
      runner.dispose();
    }
  });

  it('runs parallel tool calls via asyncio.gather', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = new PyRunner({
      onToolCall: async (_name, args) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 150));
        inFlight--;
        return String(args.i);
      },
    });
    try {
      const result = await runner.exec(
        [
          'import asyncio',
          'results = await asyncio.gather(*(test__echo({"i": i}) for i in range(3)))',
          'print(",".join(results))',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /0,1,2/);
      assert.ok(maxInFlight >= 2, `expected parallel dispatch, max in flight was ${maxInFlight}`);
    } finally {
      runner.dispose();
    }
  });

  it('persists interpreter state across execs (container-reuse semantics)', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('x = 41', []);
      assert.strictEqual(first.returnCode, 0, first.stderr);
      const second = await runner.exec('print(x + 1)', []);
      assert.strictEqual(second.returnCode, 0, second.stderr);
      assert.match(second.stdout, /42/);
    } finally {
      runner.dispose();
    }
  });

  it("a script's own sys.exit() ends only the script, with its traceback, and the interpreter goes on", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('kept = 5\nimport sys\nsys.exit(3)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /SystemExit: 3\n$/);
      const next = await runner.exec('print(kept)', []);
      assert.strictEqual(next.stdout, '5\n');
    } finally {
      runner.dispose();
    }
  });

  it('reports script exceptions as a traceback with return_code 1', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('raise ValueError("boom")', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /ValueError: boom/);
      assert.match(result.stderr, /Traceback/);
    } finally {
      runner.dispose();
    }
  });

  it('delivers tool errors as plain strings the script can handle', async () => {
    const runner = new PyRunner({
      onToolCall: async () => 'Error: Query timeout - table lock exceeded',
    });
    try {
      const result = await runner.exec(
        [
          'r = await test__echo({})',
          'if r.startswith("Error:"):',
          '    print("handled:", r)',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /handled: Error: Query timeout/);
    } finally {
      runner.dispose();
    }
  });

  it('raises TimeoutError inside the script when a tool call gets no response', async () => {
    const runner = new PyRunner({
      toolCallTimeoutMs: 1000,
      onToolCall: () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    });
    try {
      const result = await runner.exec('await test__echo({})', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /TimeoutError: Calling tool \['test--echo'\] timed out/);
    } finally {
      runner.dispose();
    }
  });

  it('cancels a script that exceeds the deadline', async () => {
    const runner = new PyRunner({
      scriptTimeoutMs: 1000,
      onToolCall: async () => '',
    });
    try {
      const started = Date.now();
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(60)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /cancelled by host/);
      assert.ok(Date.now() - started < 15_000, 'deadline cancel took too long');
    } finally {
      runner.dispose();
    }
  });

  it('abort() settles a running script and reclaims the interpreter', async () => {
    let called!: () => void;
    const running = new Promise<void>((resolve) => {
      called = resolve;
    });
    const runner = new PyRunner({
      onToolCall: async () => {
        called();
        return 'echo';
      },
    });
    try {
      const pending = runner.exec('marker = 1\nawait test__echo({})\nimport asyncio\nawait asyncio.sleep(60)', ECHO_TOOLS);
      // The script's tool call says it's running. An exec that settles first,
      // or a call that never comes, fails the test rather than leaving it waiting.
      await within(
        Promise.race([
          running,
          pending.then((r) => assert.fail(`the exec settled before its script called its tool: ${r.stderr}`)),
        ]),
        'the script to call its tool',
      );
      assert.strictEqual(runner.busy, true);
      runner.abort('test abort');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, /aborted by host: test abort/);
      // Runner remains usable after reclaim, in a fresh interpreter: the
      // aborted script's state is gone.
      const after = await runner.exec('try:\n    marker\n    print("kept")\nexcept NameError:\n    print("fresh")', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, 'fresh\n');
    } finally {
      runner.dispose();
    }
  });

  it('rejects concurrent execs on one runner', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      await new Promise((r) => setTimeout(r, 300));
      const second = await runner.exec('print("nope")', []);
      assert.strictEqual(second.returnCode, 1);
      assert.strictEqual(second.stderr, "script didn't run: another code_execution script of yours is already running, and they run one at a time. "
        + 'Run this one again once that one has finished, or combine the two into one script.');
      runner.abort('cleanup');
      await first;
    } finally {
      runner.dispose();
    }
  });

  it('rejects a second exec issued before the first has started (same tick)', async () => {
    // exec() awaits the interpreter, so a claim made only after that await
    // would let two execs in at once.
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (const warm of [false, true]) {
        const first = runner.exec('import asyncio\nawait asyncio.sleep(0.2)\nprint("first ran")', []);
        const second = runner.exec('print("second ran")', []);
        const [a, b] = await Promise.race([
          Promise.all([first, second]),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`warm=${warm}: an exec never settled`)), 10_000)),
        ]);
        assert.strictEqual(b.returnCode, 1, `warm=${warm}`);
        assert.match(b.stderr, /already running/);
        assert.strictEqual(a.returnCode, 0, `warm=${warm}: ${a.stderr}`);
        assert.match(a.stdout, /first ran/);
        assert.ok(!a.stdout.includes('second ran') && !b.stdout.includes('second ran'));
      }
    } finally {
      runner.dispose();
    }
  });

  it('fails gracefully when the python binary is missing, and says code_execution can\'t run here', async () => {
    const runner = new PyRunner({
      pythonPath: '/definitely/not/a/python',
      onToolCall: async () => '',
    });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stderr, "script didn't run: this host can't start its Python interpreter, /definitely/not/a/python (ENOENT), "
        + "so code_execution can't run scripts here until whoever runs this host installs it or points this host at one. Calling it again before then fails the same way.");
    } finally {
      runner.dispose();
    }
  });

  it('an interpreter path that is no program, or that runs through a file, says which, and only the first rules out trying again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-start-'));
    const notExecutable = join(dir, 'python3');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
    const noExec = new PyRunner({ pythonPath: notExecutable, onToolCall: async () => '' });
    const throughFile = new PyRunner({ pythonPath: join(notExecutable, 'python3'), onToolCall: async () => '' });
    try {
      assert.strictEqual((await noExec.exec('print(1)', [])).stderr, `script didn't run: this host can't start its Python interpreter, ${notExecutable} (EACCES), `
        + "so code_execution can't run scripts here until whoever runs this host makes it executable or points this host at another. Calling it again before then fails the same way.");
      assert.strictEqual((await throughFile.exec('print(1)', [])).stderr, `script didn't run: the Python interpreter, ${join(notExecutable, 'python3')}, `
        + "couldn't be started (ENOTDIR), so none of the script ran. Run it again; if it fails the same way, ask whoever runs this host.");
    } finally {
      noExec.dispose();
      throughFile.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a runtime whose files can't be written says so, with the error's path cut at 500 characters, not that the interpreter failed", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-files-'));
    // Nested past 500 characters, so Node's message, which quotes the path, is cut.
    const missing = join(dir, ...Array.from({ length: 6 }, () => 'm'.repeat(90)));
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = missing;
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.returnCode, 1);
      const message = `ENOENT: no such file or directory, mkdtemp '${join(missing, 'af-pytc-XXXXXX')}'`;
      assert.ok(message.length > 500, 'the message is long enough to be cut');
      assert.strictEqual(result.stderr, "script didn't run: this host couldn't create or write the files its Python runtime starts from ("
        + `${message.slice(0, 500)}… (${message.length} characters)), so none of the script ran. Run it again; if it fails the same way, ask whoever runs this host.`);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interpreter that exits as it starts: nothing in the script ran, and one more try is worth it', async () => {
    // Node, given the runtime's Python source, exits on its syntax at once.
    const runner = new PyRunner({ pythonPath: process.execPath, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.returnCode, 1);
      // What Node wrote as it refused the file follows, its paths and line numbers its own.
      const said = `script didn't run: the Python interpreter, ${process.execPath}, exited as it started, so none of the script ran. `
        + 'Run it again; if it fails the same way, ask whoever runs this host. It wrote to stderr: ';
      assert.ok(result.stderr.startsWith(said), result.stderr);
      assert.match(result.stderr.slice(said.length), /ERR_UNKNOWN_FILE_EXTENSION/);
    } finally {
      runner.dispose();
    }
  });

  it('an interpreter that exits under a script says the rest didn\'t run and its state is gone', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      assert.strictEqual((await runner.exec('x = 41', [])).returnCode, 0);
      const result = await runner.exec('import os\nos._exit(3)', []);
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stderr, "script stopped: the Python interpreter exited with code 3 while it ran, so the rest of the script didn't run, "
        + 'and variables from earlier scripts are gone. Tool calls it had already made keep their effects, so check them before you run it again in a new interpreter. '
        + 'If it stops the same way, check whether the script itself ends the process, for example with os._exit(); if not, ask whoever runs this host.');
      assert.match((await runner.exec('print(x)', [])).stderr, /NameError: name 'x' is not defined/);
      const killed = await runner.exec('import os, signal\nos.kill(os.getpid(), signal.SIGKILL)', []);
      assert.strictEqual(killed.stderr, "script stopped: the Python interpreter was ended by SIGKILL while it ran, so the rest of the script didn't run, "
        + 'and variables from earlier scripts are gone. Tool calls it had already made keep their effects, so check them before you run it again in a new interpreter. '
        + 'If it stops the same way, check whether the script itself ends the process, for example by using too much memory; if not, ask whoever runs this host.');
    } finally {
      runner.dispose();
    }
  });

  it('a tool function given keyword arguments or a non-dict is not called, and says the dict to write', async () => {
    const calls: string[] = [];
    const runner = new PyRunner({ onToolCall: async (name) => { calls.push(name); return ''; } });
    try {
      const result = await runner.exec(
        [
          'class Loud(str):',
          '    def __repr__(self):',
          '        raise RuntimeError("repr ran")',
          'class Int(int):',
          '    def __repr__(self):',
          '        raise RuntimeError("repr ran")',
          'class Meta(type):',
          '    def __eq__(cls, other):',
          '        raise RuntimeError("metaclass __eq__ ran")',
          '    __hash__ = type.__hash__',
          '    @property',
          '    def __name__(cls):',
          '        raise RuntimeError("metaclass __name__ ran")',
          'class Odd(metaclass=Meta):',
          '    def __repr__(self):',
          '        raise RuntimeError("repr ran")',
          'for call in (lambda: test__echo(message="alpha", limit=5, items=[1]), lambda: test__echo({"message": "alpha"}, limit=5), lambda: test__echo("alpha"),',
          '             lambda: test__echo("alpha", limit=5),',
          '             lambda: test__echo(text=Loud("x"), n=Int(3)), lambda: test__echo({Int(4): "a"}, n=1),',
          '             lambda: test__echo({"k" * 61: 1, "j" * 60: 2}, n=1), lambda: test__echo(Odd(), n=1)):',
          '    try:',
          '        await call()',
          '    except TypeError as e:',
          '        print(e)',
        ].join('\n'),
        ECHO_TOOLS,
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.deepStrictEqual(result.stdout.trimEnd().split('\n'), [
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo({'message': <str>, 'limit': <int>, 'items': <list>})",
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo({'message': <str>, 'limit': <int>})",
        "test__echo wasn't called: a tool function takes one dict of arguments, such as await test__echo({...}), and this call gave it <str>",
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, and this call also gave it <str>, "
          + 'so put every argument in one dict: await test__echo({...})',
        // A value of a subclass is shown by its type: its own __repr__ never runs.
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo({'text': <Loud>, 'n': <Int>})",
        // A key that isn't a str is shown as a value is, so its __repr__ doesn't run either.
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo({<Int>: <str>, 'n': <int>})",
        // A str key is shown whole up to 60 characters, and past that by its type.
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo("
          + `{<str>: <int>, '${'j'.repeat(60)}': <int>, 'n': <int>})`,
        // A class's metaclass code doesn't run either: its type is named through type's own descriptor.
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, and this call also gave it <Odd>, "
          + 'so put every argument in one dict: await test__echo({...})',
      ]);
      assert.deepStrictEqual(calls, []);
    } finally {
      runner.dispose();
    }
  });

  it('a tool function takes args= on its own as the dict, and None either way as no arguments, as it always has', async () => {
    const calls: unknown[] = [];
    const runner = new PyRunner({ onToolCall: async (_name, args) => { calls.push(args); return 'ok'; } });
    try {
      const result = await runner.exec([
        'await test__echo(None)',
        'await test__echo(args=None)',
        'await test__echo(args={"message": "a"})',
        'await test__echo({"message": "b"})',
      ].join('\n'), ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.deepStrictEqual(calls, [{}, {}, { message: 'a' }, { message: 'b' }]);
    } finally {
      runner.dispose();
    }
  });

  it('a keyword named args beside other keywords stays in the dict to write, and two positional arguments are refused', async () => {
    const runner = new PyRunner({ onToolCall: async () => 'called' });
    try {
      const result = await runner.exec([
        'for call in (lambda: test__echo(message="alpha", args={"limit": 5}), lambda: test__echo({"message": "alpha"}, args={"limit": 5}),',
        '             lambda: test__echo(args="notes.md"), lambda: test__echo({"a": 1}, {"b": 2})):',
        '    try:',
        '        await call()',
        '    except TypeError as e:',
        '        print(e)',
      ].join('\n'), ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.deepStrictEqual(result.stdout.trimEnd().split('\n'), [
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo({'message': <str>, 'args': <dict>})",
        "test__echo wasn't called: a tool function takes one dict of arguments, not keyword arguments, so write await test__echo({'message': <str>, 'args': <dict>})",
        "test__echo wasn't called: a tool function takes one dict of arguments, such as await test__echo({...}), and this call gave it <str>",
        "test__echo wasn't called: a tool function takes one dict of arguments, such as await test__echo({...}), and this call gave it 2 positional arguments",
      ]);
    } finally {
      runner.dispose();
    }
  });
});

// While the interpreter starts, the exec has claimed the runner but its
// script hasn't been sent. An abort or a dispose then settles the exec, and
// the script never runs.
describe('PyRunner: an abort or dispose while the interpreter starts (real python3)', () => {
  /** An executable standing in for python3: a shell script with the given body. */
  const standIn = (body: string): { path: string; dir: string; done: () => void } => {
    const dir = mkdtempSync(join(tmpdir(), 'af-pytc-standin-'));
    const path = join(dir, 'python3');
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return { path, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
  };
  // The stand-ins are shell scripts.
  const posix = { skip: process.platform === 'win32' ? 'the stand-ins need /bin/sh' : false };
  // A write's failure comes back through the event loop: two turns of it.
  const turns = () => new Promise<void>((r) => setImmediate(() => setImmediate(r)));

  it('an abort settles the exec at once, and its script never runs', async () => {
    const calls: string[] = [];
    const runner = new PyRunner({
      onToolCall: async (name) => {
        calls.push(name);
        return 'echo';
      },
    });
    try {
      const started = Date.now();
      const pending = runner.exec('await test__echo({})\nimport asyncio\nawait asyncio.sleep(2)', ECHO_TOOLS);
      assert.strictEqual(runner.busy, true);
      runner.abort('turn abandoned');
      assert.strictEqual(runner.busy, false, 'the next turn can run a script');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, /aborted by host: turn abandoned/);
      // Waiting on the killed interpreter's readiness would take its 15 s start timeout.
      const took = Date.now() - started;
      assert.ok(took < 10_000, `settled after ${took} ms`);
      const after = await runner.exec('print("alive")', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, 'alive\n');
      assert.deepStrictEqual(calls, [], 'the aborted script never ran');
    } finally {
      runner.dispose();
    }
  });

  it('an abort while the interpreter is still starting settles the exec and kills the interpreter', posix, async () => {
    // The flaky abort test's case, an abort that lands while the interpreter
    // starts. The stand-in writes its pid and never says it's ready, so the
    // abort lands while it starts, however late it comes.
    const never = standIn('echo $$ > "$(dirname "$0")/pid"\nexec sleep 30');
    const runner = new PyRunner({ pythonPath: never.path, onToolCall: async () => '' });
    try {
      const pending = runner.exec('print("ran")', []);
      const pidFile = join(never.dir, 'pid');
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').endsWith('\n'), 'the interpreter to start');
      const pid = Number(readFileSync(pidFile, 'utf8'));
      assert.strictEqual(runner.busy, true);
      runner.abort('test abort');
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, 'script aborted by host: test abort');
      assert.strictEqual(result.stdout, '');
      // Left running, the stand-in would sleep on for 30 s.
      await until(() => !alive(pid), 'the starting interpreter to be killed');
    } finally {
      runner.dispose();
      never.done();
    }
  });

  it('a second exec, issued on the tick an abort settles the first, runs whole in a fresh interpreter', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      runner.abort('turn abandoned');
      const second = runner.exec('print("second")', []);
      const [a, b] = await Promise.all([first, second]);
      assert.strictEqual(a.aborted, true);
      assert.match(a.stderr, /aborted by host: turn abandoned/);
      assert.strictEqual(b.returnCode, 0, b.stderr);
      assert.strictEqual(b.stdout, 'second\n');
    } finally {
      runner.dispose();
    }
  });

  it('an abort on a warm interpreter, on the tick exec is called, settles it before its script is sent', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      await runner.exec('print("warm")', []);
      const first = runner.exec('import asyncio\nawait asyncio.sleep(2)', [], undefined, { deadlineMs: 300 });
      runner.abort('turn abandoned');
      const stopped = await first;
      assert.strictEqual(stopped.aborted, true);
      assert.match(stopped.stderr, /aborted by host: turn abandoned/);
      // Had the aborted exec gone on to arm its deadline, that would interrupt
      // this next script at 300 ms.
      const next = await runner.exec('import asyncio\nawait asyncio.sleep(1)\nprint("whole")', []);
      assert.strictEqual(next.returnCode, 0, next.stderr);
      assert.strictEqual(next.stdout, 'whole\n');
    } finally {
      runner.dispose();
    }
  });

  const stops: [string, (runner: PyRunner) => void, RegExp][] = [
    ['a dispose', (runner) => runner.dispose(), /^code_execution runner disposed$/],
    [
      'an abort then a dispose (a background cancel)',
      (runner) => {
        runner.abort('cancelled by agent');
        runner.dispose();
      },
      /^script aborted by host: cancelled by agent$/,
    ],
  ];
  for (const [how, stop, says] of stops) {
    it(`${how} settles the exec at once`, async () => {
      const runner = new PyRunner({ onToolCall: async () => '' });
      const started = Date.now();
      const pending = runner.exec('import asyncio\nawait asyncio.sleep(2)', []);
      stop(runner);
      const result = await pending;
      assert.strictEqual(result.aborted, true);
      assert.match(result.stderr, says);
      // Waiting on the killed interpreter's readiness would take its 15 s start timeout.
      const took = Date.now() - started;
      assert.ok(took < 10_000, `settled after ${took} ms`);
    });
  }

  it('an abort while an interpreter that has stopped reading its input starts throws nothing', posix, async () => {
    // The stand-in closes fd 3, where the host's messages arrive, says so, and
    // never gets ready, so the abort's write meets a pipe nobody reads.
    const closed = standIn('exec 3<&-\ntouch "$(dirname "$0")/closed"\nexec sleep 30');
    const runner = new PyRunner({ pythonPath: closed.path, onToolCall: async () => '' });
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const pending = runner.exec('print(1)', []);
      await until(() => existsSync(join(closed.dir, 'closed')), 'the stand-in to close its input');
      runner.abort('turn abandoned');
      const result = await pending;
      assert.strictEqual(result.stderr, 'script aborted by host: turn abandoned');
      // An unheard write error would fail this test as an uncaught exception.
      await turns();
      // The abort tore the interpreter down, so its failed write isn't news.
      assert.deepStrictEqual(logged.filter((l) => l.includes('messages to the python runtime failed')), []);
    } finally {
      console.error = consoleError;
      runner.dispose();
      closed.done();
    }
  });

  it("an exec whose interpreter has stopped reading its input but runs on is settled at the failed write", posix, async () => {
    // As after a script closes file descriptor 3, where the host's messages
    // arrive: the interpreter is alive, and the exec's own writes, the init
    // and the exec, meet a pipe nobody reads. Left running, the exec would
    // wait out its 10-minute time limit.
    const closes = standIn(`exec 3<&-\necho '{"op":"ready"}' >&4\nexec sleep 30`);
    const runner = new PyRunner({ pythonPath: closes.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exec to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(
        result.stderr,
        "script stopped: the Python interpreter stopped reading the host's messages, so the host ended it and the rest of the script didn't run, "
          + 'and variables from earlier scripts are gone. Tool calls it had already made keep their effects, so check them before you run it again '
          + 'in a new interpreter. If it stops the same way, check whether the script closes, shuts down or replaces file descriptor 3, '
          + "where the host's messages arrive; if not, ask whoever runs this host.",
      );
      assert.strictEqual(runner.busy, false);
      await turns();
      // A background script has its interpreter to itself, so it isn't told of earlier scripts.
      const background = await within(
        runner.exec('print(1)', [], { logPath: null, lifetimeMs: 30_000, onWake: async () => null }),
        'the background exec to settle',
      );
      assert.match(background.stderr, /^script stopped: the Python interpreter stopped reading the host's messages, so the host ended it and the rest of the script didn't run\. Tool calls/);
    } finally {
      runner.dispose();
      closes.done();
    }
  });

  it("an abort or a dispose on the tick exec is called, with an interpreter that can't be spawned, kills no child without a pid", async () => {
    // A failed spawn's child has no pid, and its exitCode stays null until
    // Node's 'error' for it, a tick later. A kill() in that tick signals
    // whatever pid Node's handle held: in a fresh Node 20 process that was 0,
    // the caller's own process group. So the stub records such a kill
    // instead, and passes on only a child's with a pid.
    const kill = ChildProcess.prototype.kill;
    const pidless: (NodeJS.Signals | number | undefined)[] = [];
    ChildProcess.prototype.kill = function (this: ChildProcess, signal?: NodeJS.Signals | number) {
      if (this.pid === undefined) {
        pidless.push(signal);
        return false;
      }
      return kill.call(this, signal);
    };
    try {
      for (const stop of ['abort', 'dispose'] as const) {
        const runner = new PyRunner({ pythonPath: '/definitely/not/a/python', onToolCall: async () => '' });
        try {
          const pending = runner.exec('print(1)', []);
          if (stop === 'abort') runner.abort('stopped on the spawn tick');
          else runner.dispose();
          const result = await within(pending, `the exec stopped by ${stop}`);
          assert.strictEqual(result.aborted, true, stop);
          assert.strictEqual(
            result.stderr,
            stop === 'abort' ? 'script aborted by host: stopped on the spawn tick' : 'code_execution runner disposed',
          );
          assert.deepStrictEqual(pidless, [], `${stop}: a kill reached a child with no pid`);
        } finally {
          runner.dispose();
        }
      }
    } finally {
      ChildProcess.prototype.kill = kill;
    }
  });

  it('an interpreter that exits before it is ready still reads as a failed start', posix, async () => {
    const exits = standIn('exit 3');
    const runner = new PyRunner({ pythonPath: exits.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(
        result.stderr,
        `script didn't run: the Python interpreter, ${exits.path}, exited as it started, so none of the script ran. `
          + 'Run it again; if it fails the same way, ask whoever runs this host.',
      );
    } finally {
      runner.dispose();
      exits.done();
    }
  });

  it("an interpreter whose wrapper doesn't pass fds 3 and 4 on says so as its start fails", posix, async () => {
    const rows: [string, string][] = [
      ['3<&- 4<&-', "its file descriptors 3 and 4 aren't open"],
      ['3<&-', "its file descriptor 3 isn't open"],
      ['4<&-', "its file descriptor 4 isn't open"],
    ];
    for (const [drops, which] of rows) {
      const wraps = standIn(`exec ${drops}\nexec python3 "$@"`);
      const runner = new PyRunner({ pythonPath: wraps.path, onToolCall: async () => '' });
      try {
        const result = await within(runner.exec('print(1)', []), `the failed start (${drops})`);
        assert.strictEqual(result.aborted, true, drops);
        assert.strictEqual(
          result.stderr,
          `script didn't run: the Python interpreter, ${wraps.path}, exited as it started, saying: ` +
            `The host's channel didn't reach this Python interpreter: ${which}, as when the host's pythonPath ` +
            "starts Python through a wrapper that doesn't pass both file descriptors 3 and 4 on, such as a container, or " +
            "sudo with its default settings. code_execution can't run scripts here until whoever runs this host " +
            'changes that, so calling it again fails the same way.',
          drops,
        );
      } finally {
        runner.dispose();
        wraps.done();
      }
    }
  });

  it("a wrapper's own exit 78 has its words end the result, with no claim about the channel, and a silent one gets the general text", posix, async () => {
    const own = standIn('echo "no container here" >&2\nexit 78');
    const silent = standIn('exit 78');
    const runner = new PyRunner({ pythonPath: own.path, onToolCall: async () => '' });
    const silentRunner = new PyRunner({ pythonPath: silent.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.stderr, `script didn't run: the Python interpreter, ${own.path}, exited as it started, saying: no container here`);
      const quiet = await silentRunner.exec('print(1)', []);
      assert.strictEqual(
        quiet.stderr,
        `script didn't run: the Python interpreter, ${silent.path}, exited as it started, so none of the script ran. `
          + 'Run it again; if it fails the same way, ask whoever runs this host.',
      );
    } finally {
      runner.dispose();
      silentRunner.dispose();
      own.done();
      silent.done();
    }
  });

  it("a failed start's stderr keeps up to its last 2,000 characters, marked where they're cut, and a pair's half never starts it", posix, async () => {
    const base = (path: string) =>
      `script didn't run: the Python interpreter, ${path}, exited as it started, so none of the script ran. `
      + 'Run it again; if it fails the same way, ask whoever runs this host. It wrote to stderr: ';
    // A traceback's last line is at its end, past where a cut of its head would stop.
    const long = standIn(`head -c 3000 /dev/zero | tr '\\0' x >&2\nprintf '\\nthe last line\\n' >&2\nexit 3`);
    // An emoji is two UTF-16 units, and the cut falls between them.
    const split = standIn(`printf '\\360\\237\\230\\200' >&2\nhead -c 1999 /dev/zero | tr '\\0' x >&2\nexit 3`);
    const runner = new PyRunner({ pythonPath: long.path, onToolCall: async () => '' });
    const splitRunner = new PyRunner({ pythonPath: split.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.stderr, `${base(long.path)}…${`${'x'.repeat(3000)}\nthe last line\n`.slice(-2000).trim()}`);
      const cut = await splitRunner.exec('print(1)', []);
      assert.strictEqual(cut.stderr, `${base(split.path)}…${'x'.repeat(1999)}`);
    } finally {
      runner.dispose();
      splitRunner.dispose();
      long.done();
      split.done();
    }
  });

  it('an interpreter ended by a signal as it starts says which', posix, async () => {
    const killed = standIn('kill -9 $$');
    const runner = new PyRunner({ pythonPath: killed.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(
        result.stderr,
        `script didn't run: the Python interpreter, ${killed.path}, was ended by SIGKILL as it started, so none of the script ran. `
          + 'Run it again; if it fails the same way, ask whoever runs this host.',
      );
    } finally {
      runner.dispose();
      killed.done();
    }
  });

  it('an interpreter that exits before it is ready says why, from what it wrote to stderr', posix, async () => {
    const says = standIn('echo "no runtime here" >&2\nexit 3');
    const runner = new PyRunner({ pythonPath: says.path, onToolCall: async () => '' });
    try {
      const result = await runner.exec('print(1)', []);
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(
        result.stderr,
        `script didn't run: the Python interpreter, ${says.path}, exited as it started, so none of the script ran. `
          + 'Run it again; if it fails the same way, ask whoever runs this host. It wrote to stderr: no runtime here',
      );
    } finally {
      runner.dispose();
      says.done();
    }
  });

  // A stand-in that takes the exec, then exits leaving a child that does one
  // thing once the stand-in has been reaped, which is when Node reports the
  // exit: what the child sends arrives after the exit, every time.
  const exitsThenChild = (child: string, childFds: string) =>
    standIn([
      `echo '{"op":"ready"}' >&4`,
      'read -r init <&3',
      'read -r exec <&3',
      'parent=$$',
      `(while kill -0 "$parent" 2>/dev/null; do :; done; ${child}) ${childFds} &`,
      'exit 3',
    ].join('\n'));

  it("what an interpreter's output pipes carry after its exit is still in the result", posix, async () => {
    const late = exitsThenChild('echo "last words" >&2', '>/dev/null 3<&- 4<&-');
    const runner = new PyRunner({ pythonPath: late.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, `last words\n${exitedUnder('exited with code 3')}`);
    } finally {
      runner.dispose();
      late.done();
    }
  });

  it("what an exited interpreter wrote is read before its exec settles, even when the host was busy past the grace", posix, async () => {
    const late = exitsThenChild('echo "last words" >&2', '>/dev/null 3<&- 4<&-');
    // The host's event loop is busy for 400 ms from the exit, longer than the
    // 200 ms grace, while the child writes; then the expired grace timer runs
    // before the loop reads the pipes.
    const proto = ChildProcess.prototype as unknown as { emit: (event: string | symbol, ...args: unknown[]) => boolean };
    const own = Object.prototype.hasOwnProperty.call(proto, 'emit');
    const emit = proto.emit;
    proto.emit = function (this: unknown, event: string | symbol, ...args: unknown[]) {
      const handled = emit.call(this, event, ...args);
      if (event === 'exit') {
        const busyUntil = performance.now() + 400;
        while (performance.now() < busyUntil) {
          // busy
        }
      }
      return handled;
    };
    const runner = new PyRunner({ pythonPath: late.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.stderr, `last words\n${exitedUnder('exited with code 3')}`);
    } finally {
      if (own) proto.emit = emit;
      else delete (proto as { emit?: unknown }).emit;
      runner.dispose();
      late.done();
    }
  });

  it('an interpreter that dies just after its messages stop reaching it reads as its own exit, not as one the host killed', posix, async () => {
    // It reads the init, closes fd 3 with the exec unread, which breaks the
    // host's end of it, and kills itself 20 ms later: within the host's grace
    // for its own exit, so the host doesn't take it for a deaf interpreter.
    const dies = standIn([`echo '{"op":"ready"}' >&4`, 'read -r init <&3', 'exec 3<&-', 'sleep 0.02', 'kill -9 $$'].join('\n'));
    const runner = new PyRunner({ pythonPath: dies.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stderr, exitedUnder('was ended by SIGKILL'));
    } finally {
      runner.dispose();
      dies.done();
    }
  });

  it("an exec's result that arrives after its interpreter's exit keeps the script's own return code", posix, async () => {
    const late = exitsThenChild(`echo '{"op":"exec_result","id":"e1","return_code":5}' >&4`, '>/dev/null 2>&1 3<&-');
    const runner = new PyRunner({ pythonPath: late.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exit to settle');
      assert.strictEqual(result.returnCode, 5);
      assert.strictEqual(result.aborted, true);
      // Its result says the script ended.
      assert.strictEqual(result.stderr, exitedAfterEnd('exited with code 3'));
    } finally {
      runner.dispose();
      late.done();
    }
  });

  it('an end mark, or a character, split across two reads is still found whole', posix, async () => {
    // A Python stand-in that writes "é" in two pieces, then the end mark in
    // two, each landing in a read of its own.
    const split = standIn('exec python3 "$(dirname "$0")/split.py"');
    writeFileSync(
      join(split.dir, 'split.py'),
      [
        'import json, os, time',
        'out = open(4, "w", encoding="utf-8")',
        'out.write(\'{"op": "ready"}\\n\')',
        'out.flush()',
        'for line in open(3, encoding="utf-8"):',
        '    msg = json.loads(line)',
        '    if msg.get("op") != "exec":',
        '        continue',
        '    mark = msg["mark"].encode("utf-8")',
        '    for piece in (b"caf\\xc3", b"\\xa9\\n" + mark[:5], mark[5:]):',
        '        os.write(1, piece)',
        '        time.sleep(0.2)',
        '    os.write(2, mark)',
        '    out.write(json.dumps({"op": "exec_result", "id": msg["id"], "return_code": 0}) + "\\n")',
        '    out.flush()',
      ].join('\n'),
    );
    const runner = new PyRunner({ pythonPath: split.path, onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('print(1)', []), 'the exec to settle');
      assert.deepStrictEqual(result, { stdout: 'café\n', stderr: '', returnCode: 0 });
    } finally {
      runner.dispose();
      split.done();
    }
  });
});

// The protocol has fds of its own, 3 and 4; fd 0 is /dev/null, and the host
// reads fds 1 and 2 itself. So what a script's commands write lands where its
// prints do, reaches the host whatever then happens to the interpreter, and
// nothing a script or a command does with fds 0 to 2 reaches the protocol.
describe("PyRunner: a script's output, read by the host (real python3)", { skip: process.platform === 'win32' ? 'the scripts run POSIX commands' : false }, () => {
  /** Lines the runner logs, while fn runs. */
  const logging = async (fn: (logged: string[]) => Promise<void>) => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      await fn(logged);
    } finally {
      console.error = consoleError;
    }
  };

  it("a command's output reaches the result, in order with the script's own on each stream", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec(
        'import os, sys\nprint("p1")\nos.system("echo child-out; echo child-err 1>&2")\nprint("p2")\nprint("e1", file=sys.stderr)\nsys.stdout.write("no newline")',
        [],
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, 'p1\nchild-out\np2\nno newline');
      assert.strictEqual(result.stderr, 'child-err\ne1\n');
    } finally {
      runner.dispose();
    }
  });

  for (const [how, stop, why] of [
    ['an abort', (runner: PyRunner) => runner.abort('test abort'), 'script aborted by host: test abort'],
    ['a dispose', (runner: PyRunner) => runner.dispose(), 'code_execution runner disposed'],
  ] as const) {
    it(`${how} keeps in the result what a running script wrote before it`, async () => {
      let calls = 0;
      let called!: () => void;
      const running = new Promise<void>((resolve) => {
        called = resolve;
      });
      // The second call comes only after the host has answered the first, so
      // the line printed before either has reached the host by then.
      const runner = new PyRunner({
        onToolCall: async () => {
          if (++calls === 2) called();
          return 'echo';
        },
      });
      try {
        const pending = runner.exec(
          'print("before")\nawait test__echo({})\nawait test__echo({})\nimport asyncio\nawait asyncio.sleep(60)',
          ECHO_TOOLS,
        );
        await within(
          Promise.race([running, pending.then((r) => assert.fail(`the exec settled before its second tool call: ${r.stderr}`))]),
          'the script to call its tool twice',
        );
        stop(runner);
        const result = await pending;
        assert.deepStrictEqual(
          { stdout: result.stdout, stderr: result.stderr, aborted: result.aborted },
          { stdout: 'before\n', stderr: why, aborted: true },
        );
      } finally {
        runner.dispose();
      }
    });
  }

  it('a lone surrogate a script prints comes back escaped, as backslashreplace writes it', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('import sys\nprint("a\\udcffb")\nprint("c\\udcffd", file=sys.stderr)', []);
      assert.deepStrictEqual(
        { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
        { stdout: 'a\\udcffb\n', stderr: 'c\\udcffd\n', returnCode: 0 },
      );
    } finally {
      runner.dispose();
    }
  });

  it("a command reading its input gets its end at once, and no command holds the protocol's fds", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // /dev/fd/N is there only while the process looking holds fd N.
      const held = `import os; print("held:", [fd for fd in (3, 4) if os.path.exists("/dev/fd/%d" % fd)])`;
      const result = await within(
        runner.exec(
          [
            'import os, subprocess, sys',
            'print("cat", subprocess.run(["cat"], timeout=5).returncode)',
            `subprocess.run([sys.executable, "-c", ${JSON.stringify(held)}], close_fds=False)`,
            `os.system(sys.executable + " -c '" + ${JSON.stringify(held)} + "'")`,
            `subprocess.run([sys.executable, "-c", "import os; print('null:', os.path.samestat(os.fstat(0), os.stat(os.devnull)))"])`,
          ].join('\n'),
          [],
        ),
        'the script to finish',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, 'cat 0\nheld: []\nheld: []\nnull: True\n');
    } finally {
      runner.dispose();
    }
  });

  it('a script that closes or redirects fds 0, 1 and 2 leaves the next script its output', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const closes = await within(runner.exec('import os\nos.close(0)\nos.close(1)\nos.close(2)', []), 'the closing script');
      assert.strictEqual(closes.returnCode, 0, closes.stderr);
      // Its fd 0 is /dev/null again: a read gets the end at once.
      const after = await within(runner.exec('import os, sys\nprint(repr(os.read(0, 10)))\nprint("out")\nprint("err", file=sys.stderr)\nos.system("echo cmd")', []), 'the next script');
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, "b''\nout\ncmd\n");
      assert.strictEqual(after.stderr, 'err\n');
      const redirects = await runner.exec('import os\nos.dup2(os.open(os.devnull, os.O_WRONLY), 1)\nprint("lost")', []);
      assert.strictEqual(redirects.stdout, '');
      const back = await runner.exec('print("back")', []);
      assert.strictEqual(back.stdout, 'back\n');
    } finally {
      runner.dispose();
    }
  });

  it('what the script wrote just before it ended is all in its result, and none in the next', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // More than a pipe holds on each stream, so each stream's mark arrives well after the result.
      const big = await runner.exec('import os\nos.write(1, b"x" * 1_500_000)\nos.write(2, b"y" * 1_500_000)', []);
      assert.strictEqual(big.returnCode, 0, big.stderr.slice(-500));
      assert.deepStrictEqual({ stdout: big.stdout.length, stderr: big.stderr.length }, { stdout: 1_500_000, stderr: 1_500_000 });
      const next = await runner.exec('print("next")', []);
      assert.strictEqual(next.stdout, 'next\n');
    } finally {
      runner.dispose();
    }
  });

  it('each stream is cut at 2,000,000 characters, and says so', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('import sys\nsys.stdout.write("x" * 2_000_100)\nsys.stderr.write("y" * 2_000_100)', []);
      assert.strictEqual(result.returnCode, 0, result.stderr.slice(-500));
      assert.strictEqual(result.stdout, `${'x'.repeat(2_000_000)}\n[stdout truncated at 2000000 chars]`);
      assert.strictEqual(result.stderr, `${'y'.repeat(2_000_000)}\n[stderr truncated at 2000000 chars]`);
    } finally {
      runner.dispose();
    }
  });

  it("C code writing under the GIL more than a pipe holds doesn't stop the script", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // ctypes.PyDLL keeps the GIL through the call: a reader inside the
      // interpreter could never drain the pipe, and the write would never return.
      const result = await within(
        runner.exec('import ctypes\nbuf = b"x" * 1048576\nn = ctypes.PyDLL(None).write(1, buf, len(buf))\nprint()\nprint("wrote", n)', []),
        'the write to return',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `${'x'.repeat(1048576)}\nwrote 1048576\n`);
    } finally {
      runner.dispose();
    }
  });

  it('a script killed at its time limit keeps in its result what it and its commands wrote', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500 });
    try {
      const code = [
        'import os, signal, sys, time',
        'signal.signal(signal.SIGINT, signal.SIG_IGN)',
        'print("before")',
        'os.system("echo from-a-command")',
        'sys.stderr.write("partial")',
        'sys.stderr.flush()',
        'time.sleep(60)',
      ].join('\n');
      const killed = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(killed.aborted, true);
      assert.strictEqual(killed.stdout, 'before\nfrom-a-command\n');
      assert.match(killed.stderr, /^partial\nscript stopped: it reached its 1s time limit and did not respond, so it was killed/);
    } finally {
      runner.dispose();
    }
  });

  it('a script killed with output held back, as what could start its end mark or as half a character, keeps that output', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500 });
    try {
      // The end mark starts with \x1e and "pytc", so the host holds back an end
      // that could be its start; it holds half a UTF-8 character too.
      for (const [ends, kept] of [['b"ok\\x1epyt"', 'ok\x1epyt'], ['b"caf\\xc3"', 'caf\ufffd']]) {
        const code = `import os, signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nos.write(1, ${ends})\ntime.sleep(60)`;
        const killed = await within(runner.exec(code, [], undefined, { deadlineMs: 1000 }), `the kill (${JSON.stringify(kept)})`);
        assert.strictEqual(killed.aborted, true);
        assert.strictEqual(killed.stdout, kept);
        assert.match(killed.stderr, /^script stopped: it reached its 1s time limit and did not respond, so it was killed/);
      }
    } finally {
      runner.dispose();
    }
  });

  it("a crash's own text reaches the result and the host's log: a fatal error's, and a segfault's traceback", async () => {
    const crashes: [string, string, RegExp][] = [
      ['a fatal error', 'import ctypes\nprint("before")\nctypes.pythonapi.Py_FatalError(b"probe reason")', /^Fatal Python error: probe reason\n/],
      ['a segfault', 'import ctypes\nprint("before")\nctypes.string_at(0)', /^Fatal Python error: Segmentation fault\n[\s\S]*File "<script>", line 3/],
    ];
    for (const [what, code, says] of crashes) {
      await logging(async (logged) => {
        const runner = new PyRunner({ onToolCall: async () => '' });
        try {
          const result = await within(runner.exec(code, []), what);
          assert.strictEqual(result.aborted, true, what);
          assert.strictEqual(result.stdout, 'before\n', what);
          assert.match(result.stderr, says, what);
          assert.match(result.stderr, /\nscript stopped: the Python interpreter was ended by SIG[A-Z]+ while it ran, [^\n]*$/, what);
          assert.ok(
            logged.some((l) => /exited unexpectedly .*; the last it wrote to stderr: Fatal Python error/.test(l)),
            `${what}: logged ${JSON.stringify(logged)}`,
          );
        } finally {
          runner.dispose();
        }
      });
    }
  });

  it("a signal's advice fits it: the traceback's call after a crash's signal, native code when no traceback came, the script's own os.kill() after another", async () => {
    // Each with where faulthandler's traceback begins in the result, above the advice, or null where none came.
    const header = /^Fatal Python error: /m;
    const cases: [string, string, RegExp | null, string][] = [
      ['a segfault', 'import ctypes\nctypes.string_at(0)', header, exitedUnder('was ended by SIGSEGV', false, NATIVE_CRASH)],
      ['a fatal error', 'import ctypes\nctypes.pythonapi.Py_FatalError(b"probe reason")', header, exitedUnder('was ended by SIGABRT', false, NATIVE_CRASH)],
      ...['SIGBUS', 'SIGFPE', 'SIGILL'].map((sig): [string, string, RegExp, string] =>
        [sig, `import os, signal\nos.kill(os.getpid(), signal.${sig})`, header, exitedUnder(`was ended by ${sig}`, false, NATIVE_CRASH)]),
      // faulthandler doesn't start a line: after a progress bar's, which doesn't end, its first words follow on it.
      ["a segfault after a line the script didn't end", 'import sys, ctypes\nsys.stderr.write("\\r 45%|####      | 45/100")\nsys.stderr.flush()\nctypes.string_at(0)',
        /45\/100Fatal Python error: /, exitedUnder('was ended by SIGSEGV', false, NATIVE_CRASH)],
      ['a segfault with faulthandler disabled', 'import ctypes, faulthandler\nfaulthandler.disable()\nctypes.string_at(0)', null,
        exitedUnder('was ended by SIGSEGV', false, NATIVE_CRASH_UNSEEN)],
      ['SIGTERM', 'import os, signal\nos.kill(os.getpid(), signal.SIGTERM)', null, exitedUnder('was ended by SIGTERM')],
    ];
    for (const [what, code, traceback, says] of cases) {
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        const result = await within(runner.exec(code, []), what);
        assert.strictEqual(result.aborted, true, what);
        if (traceback) {
          assert.match(result.stderr, traceback, what);
          assert.ok(result.stderr.endsWith(`\n${says}`), `${what}: ${JSON.stringify(result.stderr.slice(-600))}`);
        } else {
          assert.strictEqual(result.stderr, says, what);
        }
      } finally {
        runner.dispose();
      }
    }
  });

  it('an interpreter that ends under its script leaves in the result all it wrote', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('import os\nos.write(1, b"x" * 1_000_000)\nos._exit(3)', []), 'the exit to settle');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stdout.length, 1_000_000);
      assert.strictEqual(result.stderr, exitedUnder('exited with code 3'));
    } finally {
      runner.dispose();
    }
  });

  it('a crash settles without waiting for a command it started that still holds its output', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    let command = 0;
    try {
      const result = await within(
        runner.exec('import ctypes, subprocess\nprint(subprocess.Popen(["sleep", "30"]).pid, flush=True)\nctypes.pythonapi.Py_FatalError(b"probe reason")', []),
        'the crash to settle',
      );
      command = Number(result.stdout.trim());
      assert.match(result.stderr, /^Fatal Python error: probe reason\n/);
      // Settled while the command still holds the pipes.
      assert.ok(alive(command), 'the command had ended, so the exec could have waited for it');
    } finally {
      if (command && alive(command)) process.kill(command, 'SIGKILL');
      runner.dispose();
    }
  });

  it("a command left running writes to the host's log between scripts, each piece cut at 2,000 characters, and into the result of a script running when it writes", async () => {
    await logging(async (logged) => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-left-'));
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        // The command writes when each file appears, after its script has
        // returned: a long line, then half of "é"; then, while a later script
        // waits for it, a line that script's result holds. It gives up after 20 s.
        const command = [
          'import os, sys, time',
          'def wait(name):',
          '    for _ in range(400):',
          '        if os.path.exists(os.path.join(sys.argv[1], name)): return',
          '        time.sleep(0.05)',
          '    sys.exit(1)',
          'wait("line")',
          "sys.stdout.write('left-running ' + 'x' * 3000 + '\\n')",
          'wait("half")',
          'os.write(1, b"caf\\xc3")',
          'wait("during")',
          'os.write(1, b"during-line\\n")',
          'open(os.path.join(sys.argv[1], "written"), "w").close()',
        ].join('\n');
        const first = await runner.exec(
          `import subprocess, sys\nsubprocess.Popen([sys.executable, "-c", ${JSON.stringify(command)}, ${JSON.stringify(dir)}])\nprint("started")`,
          [],
        );
        assert.strictEqual(first.stdout, 'started\n');
        writeFileSync(join(dir, 'line'), '');
        await until(() => logged.some((l) => l.includes('stdout while its interpreter runs no script: left-running')), 'its line in the log');
        const line = logged.find((l) => l.includes('stdout while its interpreter runs no script: left-running'));
        assert.match(line ?? '', /stdout while its interpreter runs no script: left-running x{1987} \[… 1013 more characters\]$/);
        writeFileSync(join(dir, 'half'), '');
        await until(() => logged.some((l) => l.endsWith('stdout while its interpreter runs no script: caf')), 'its half character in the log');
        // The half character it left is the log's, not the next script's.
        const next = await runner.exec('print("next")', []);
        assert.strictEqual(next.stdout, 'next\n');
        // What it writes while a script runs is that script's.
        const during = await runner.exec(
          [
            'import os, time',
            `open(os.path.join(${JSON.stringify(dir)}, "during"), "w").close()`,
            'for _ in range(400):',
            `    if os.path.exists(os.path.join(${JSON.stringify(dir)}, "written")): break`,
            '    time.sleep(0.05)',
            'print("after it")',
          ].join('\n'),
          [],
        );
        assert.strictEqual(during.stdout, 'during-line\nafter it\n');
      } finally {
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("a command left running outlives its interpreter's reclaim, writing to the host's log, and a later interpreter's script doesn't get its lines", async () => {
    await logging(async (logged) => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-reclaimed-'));
      const runner = new PyRunner({ onToolCall: async () => '', idleReclaimMs: 50 });
      const flag = (name: string) => writeFileSync(join(dir, name), '');
      let pid = 0;
      try {
        // The command writes when each file appears, once its interpreter has
        // been reclaimed, and makes a file of its own after each write, which
        // it reaches only if the write didn't end it. It gives up after 20 s.
        const command = [
          'import os, sys, time',
          'def wait(name):',
          '    for _ in range(400):',
          '        if os.path.exists(os.path.join(sys.argv[1], name)): return',
          '        time.sleep(0.05)',
          '    sys.exit(1)',
          'wait("reclaimed")',
          'print("after the reclaim", flush=True)',
          'open(os.path.join(sys.argv[1], "wrote"), "w").close()',
          'wait("replaced")',
          'print("while a new interpreter runs a script", flush=True)',
          'open(os.path.join(sys.argv[1], "wrote again"), "w").close()',
        ].join('\n');
        const first = await runner.exec(
          `import subprocess, sys\nprint(subprocess.Popen([sys.executable, "-c", ${JSON.stringify(command)}, ${JSON.stringify(dir)}]).pid)`,
          [],
        );
        pid = Number(first.stdout.trim());
        assert.ok(pid > 0, first.stdout);
        await until(() => logged.some((l) => l.endsWith('reclaiming python interpreter (idle)')), 'the idle reclaim');
        flag('reclaimed');
        await until(() => existsSync(join(dir, 'wrote')), 'the command to write after the reclaim and go on');
        await until(() => logged.some((l) => l.endsWith('stdout while its interpreter runs no script: after the reclaim')), 'its line in the log');
        // A new interpreter's script runs while the command writes again, and
        // returns only once the host has read and logged that line.
        const next = runner.exec(
          [
            'import os, time',
            `open(os.path.join(${JSON.stringify(dir)}, "replaced"), "w").close()`,
            `while not os.path.exists(os.path.join(${JSON.stringify(dir)}, "logged")): time.sleep(0.05)`,
            'print("new")',
          ].join('\n'),
          [],
        );
        await until(() => logged.some((l) => l.endsWith('stdout while its interpreter runs no script: while a new interpreter runs a script')), 'its second line in the log');
        flag('logged');
        assert.strictEqual((await within(next, 'the new script')).stdout, 'new\n');
        await until(() => existsSync(join(dir, 'wrote again')), 'the command to go on after its second write');
      } finally {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("a command writing as its interpreter is torn down is read at about 1 MiB a second from then on, while it goes on writing, neither ended nor held", async () => {
    await logging(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-flood-'));
      const progress = join(dir, 'progress');
      const runner = new PyRunner({ onToolCall: async () => '' });
      let pid = 0;
      try {
        // The command writes without end from its start, saying how much it
        // has written after each write.
        const command = [
          'import os, sys',
          'chunk = b"y\\n" * 32768',
          'n = 0',
          'while True:',
          '    os.write(1, chunk)',
          '    n += len(chunk)',
          '    with open(os.path.join(sys.argv[1], "progress.new"), "w") as f: f.write(str(n))',
          '    os.replace(os.path.join(sys.argv[1], "progress.new"), os.path.join(sys.argv[1], "progress"))',
        ].join('\n');
        const first = await runner.exec(
          `import subprocess, sys\nprint(subprocess.Popen([sys.executable, "-c", ${JSON.stringify(command)}, ${JSON.stringify(dir)}]).pid)`,
          [],
        );
        pid = Number(first.stdout.trim());
        assert.ok(pid > 0, first.stdout);
        const written = () => (existsSync(progress) ? Number(readFileSync(progress, 'utf8')) : 0);
        // In full flow, read as it's written while its interpreter lives.
        await until(() => written() > 16 * 1_048_576, 'the command to write');
        // Nothing is read between this and the teardown, whose kill Node
        // follows, as the interpreter exits, by resuming its pipes.
        const before = written();
        runner.dispose();
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const after = written();
        assert.ok(alive(pid), 'the command ended');
        assert.ok(after > before, 'the command was held');
        // 2 MiB at 1 MiB a second, with what the pipe holds; read at full speed, gigabytes.
        assert.ok(after - before < 4 * 1_048_576, `read at ${after - before} bytes in 2 s`);
      } finally {
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("a script that points fd 1 or fd 2 at the runtime's channel and leaves a partial line still ends, with the line in its result, and keeps its interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      await runner.exec('kept = "kept"', []);
      for (const [fd, to] of [[1, 4], [2, 4], [1, 3]] as const) {
        const what = `fd ${fd} to fd ${to}`;
        const result = await within(
          runner.exec(`import os, sys\nos.dup2(${to}, ${fd})\nprint("x", end="", file=${fd === 1 ? 'sys.stdout' : 'sys.stderr'})`, []),
          what,
        );
        assert.deepStrictEqual(
          { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode, aborted: result.aborted === true },
          { stdout: fd === 1 ? 'x' : '', stderr: fd === 2 ? 'x' : '', returnCode: 0, aborted: false },
          what,
        );
        assert.strictEqual((await within(runner.exec('print(kept)', []), `the next script (${what})`)).stdout, 'kept\n', what);
      }
      // One that fails: its traceback is put back on stderr's pipe before the
      // runtime writes it.
      const failed = await within(runner.exec('import os\nos.dup2(4, 2)\nraise RuntimeError("boom")', []), 'the failing script');
      assert.strictEqual(failed.returnCode, 1);
      assert.match(failed.stderr, /^Traceback \(most recent call last\):\n[\s\S]*\nRuntimeError: boom\n$/);
      assert.strictEqual((await within(runner.exec('print(kept)', []), 'the next script (the failing one)')).stdout, 'kept\n');
      // One that also replaced the runtime's copy of fd 1 with a file of its
      // own: nothing goes into the file, and the check ends the runtime.
      const dir = mkdtempSync(join(tmpdir(), 'pytc-copy-'));
      try {
        const file = join(dir, 'own');
        const replaced = await within(
          runner.exec(
            `import os, __main__\nown = os.open(${JSON.stringify(file)}, os.O_WRONLY | os.O_CREAT)\nos.dup2(own, __main__._STD_OUT)\nos.dup2(4, 1)\nprint("x", end="")`,
            [],
          ),
          'the script that replaced the copy too',
        );
        assert.strictEqual(readFileSync(file, 'utf8'), '');
        assert.ok(replaced.stderr.endsWith(runtimeLost("the runtime's copy of fd 1")), replaced.stderr);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      runner.dispose();
    }
  });

  it("an interpreter that exits as its script ends, seen before the script's end mark is read, says so in the host's log, even once the next script has replaced it", async () => {
    await logging(async (logged) => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-ended-'));
      const runner = new PyRunner({ onToolCall: async () => '' });
      const internals = runner as unknown as { child: ChildProcess | null };
      try {
        await runner.exec('pass', []);
        const child = internals.child!;
        // Its stdout is held back until the host has seen the exit, so the
        // mark there arrives while the host waits for the last of its output,
        // and a command holding the pipes keeps it waiting past the settle.
        child.stdout!.pause();
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        const running = runner.exec(
          [
            'import __main__, os, subprocess',
            `open(${JSON.stringify(join(dir, 'pid'))}, "w").write(str(subprocess.Popen(["sleep", "30"]).pid))`,
            'write_marks = __main__._write_marks',
            'def then_exit(mark):',
            '    write_marks(mark)',
            '    os._exit(0)',
            '__main__._write_marks = then_exit',
            'print("done")',
          ].join('\n'),
          [],
        );
        await within(exited, 'the exit');
        child.stdout!.resume();
        const result = await within(running, 'the script');
        assert.deepStrictEqual({ stdout: result.stdout, returnCode: result.returnCode, aborted: result.aborted === true }, { stdout: 'done\n', returnCode: 0, aborted: false });
        // The next script replaces the dead interpreter before the host has done waiting.
        assert.strictEqual((await within(runner.exec('print("next")', []), 'the next script')).stdout, 'next\n');
        await until(
          () => logged.some((l) => l.endsWith('python runtime exited as its script ended (code=0, signal=none); the next script starts a new one')),
          'the exit in the log',
        );
      } finally {
        const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("an interpreter whose script the host stops while it waits for the last of its output isn't logged as having exited as its script ended", async () => {
    await logging(async (logged) => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-stopped-'));
      const runner = new PyRunner({ onToolCall: async () => '' });
      const internals = runner as unknown as { child: ChildProcess | null };
      try {
        await runner.exec('pass', []);
        const child = internals.child!;
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        // A command holding the pipes keeps the host waiting after the exit.
        const running = runner.exec(
          `import os, subprocess\nopen(${JSON.stringify(join(dir, 'pid'))}, "w").write(str(subprocess.Popen(["sleep", "30"]).pid))\nos._exit(0)`,
          [],
        );
        await within(exited, 'the exit');
        runner.abort('the test stops it');
        const result = await within(running, 'the abort');
        assert.strictEqual(result.aborted, true);
        // Past the host's 200 ms wait for the pipes.
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.ok(!logged.some((l) => l.includes('exited as its script ended')), logged.join('\n'));
      } finally {
        const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
        if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('a writer a script kept from an earlier exec sends its partial line in the exec that wrote it', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      assert.strictEqual((await runner.exec('import sys\nkept = sys.stdout\nprint("one")', [])).stdout, 'one\n');
      assert.strictEqual((await runner.exec('kept.write("partial")', [])).stdout, 'partial');
      assert.strictEqual((await runner.exec('print("three")', [])).stdout, 'three\n');
    } finally {
      runner.dispose();
    }
  });

  it('an interpreter ended by a signal gets no signal from the host once it has been reaped', async () => {
    const kill = process.kill;
    // A pid that kill(pid, 0) no longer finds was reaped, and could be reused.
    const toReaped: number[] = [];
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 'SIGINT') {
        try {
          kill.call(process, pid, 0);
        } catch {
          toReaped.push(pid);
        }
      }
      return kill.call(process, pid, signal);
    }) as typeof process.kill;
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // At its time limit the script ends its interpreter with SIGKILL while a
      // command it started holds the output pipes, so the exec waits out the
      // grace, during which the time limit's repeated SIGINT falls due.
      const code = [
        'import os, signal, subprocess, time',
        'subprocess.Popen(["sleep", "3"])',
        'signal.signal(signal.SIGINT, lambda *_: os.kill(os.getpid(), signal.SIGKILL))',
        'time.sleep(30)',
      ].join('\n');
      const result = await within(runner.exec(code, [], undefined, { deadlineMs: 1000 }), 'the exec to settle');
      assert.ok(result.stderr.startsWith(`${exitedUnder('was ended by SIGKILL')}\n`), result.stderr);
      assert.deepStrictEqual(toReaped, []);
    } finally {
      process.kill = kill;
      runner.dispose();
    }
  });

  it("a script whose stderr is gone still reports, its traceback through the runtime's own line, and the next one's traceback arrives", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const gone = await within(runner.exec('import os\nos.close(2)\nraise ValueError("unheard")', []), 'the script to report');
      assert.strictEqual(gone.returnCode, 1);
      // Its traceback can't go through fd 2, so the runtime's own line carries
      // it, and says what its writer still held couldn't be sent.
      assert.match(
        gone.stderr,
        /^\[pytc-runtime\] Traceback \(most recent call last\):\n[\s\S]*\nValueError: unheard\n\[pytc-runtime\] some of what the script wrote couldn't be sent \(\[Errno 9\] Bad file descriptor\)\n$/,
      );
      const next = await runner.exec('raise ValueError("heard")', []);
      assert.match(next.stderr, /ValueError: heard/);
    } finally {
      runner.dispose();
    }
  });

  it("a script that closes or replaces one of the runtime's own fds ends the interpreter by the end of that script at the latest, saying which", async () => {
    const rows: [string, string, string, RegExp, string][] = [
      ["fd 3, the host's messages", 'import os\nprint("closing")\nos.close(3)', 'closing\n', /cannot read the host's messages any more/, 'fd 3'],
      ["fd 4, the runtime's messages", 'import os\nos.close(4)\nprint("closed")', 'closed\n', /cannot send the host a message any more/, 'fd 4'],
      [
        'fd 4, replaced',
        'import os\nos.dup2(os.open(os.devnull, os.O_WRONLY), 4)\nprint("replaced")',
        'replaced\n',
        /cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go/,
        'fd 4',
      ],
      [
        'fd 4, replaced by a socket',
        'import os, socket\na, b = socket.socketpair()\nos.dup2(a.fileno(), 4)\nprint("replaced")',
        'replaced\n',
        /cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go/,
        'fd 4',
      ],
      [
        'fd 4, replaced before a tool call',
        'import os\nos.dup2(os.open(os.devnull, os.O_WRONLY), 4)\nprint("replaced")\nawait test__echo({})\nprint("called")',
        'replaced\n',
        /cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go/,
        'fd 4',
      ],
      [
        "the runtime's copy of fd 0",
        'import __main__, os\nos.close(__main__._STD_IN)\nprint("closed")',
        'closed\n',
        /cannot give scripts their stdin any more: a script closed, shut down or replaced the runtime's copy of fd 0/,
        "the runtime's copy of fd 0",
      ],
      [
        "the runtime's copy of fd 1",
        'import __main__, os\nos.close(__main__._STD_OUT)\nprint("closed")',
        'closed\n',
        /cannot reach the output pipes any more: a script closed, shut down or replaced the runtime's copy of fd 1/,
        "the runtime's copy of fd 1",
      ],
      [
        "the runtime's copy of fd 2",
        'import __main__, os\nos.close(__main__._STD_ERR)\nprint("closed")',
        'closed\n',
        /cannot reach the output pipes any more: a script closed, shut down or replaced the runtime's copy of fd 2/,
        "the runtime's copy of fd 2",
      ],
    ];
    for (const [what, code, stdout, says, taken] of rows) {
      const runner = new PyRunner({ onToolCall: async () => 'echoed' });
      try {
        // A tool call that waited for its reply would take 270 s, past within's 10 s.
        const result = await within(runner.exec(code, ECHO_TOOLS), what);
        assert.strictEqual(result.aborted, true, what);
        assert.strictEqual(result.stdout, stdout, what);
        assert.match(result.stderr, says, what);
        // The advice names what the runtime's line names.
        assert.ok(result.stderr.endsWith(`; exiting\n${runtimeLost(taken)}`), `${what}: ${result.stderr.slice(-500)}`);
        const next = await within(runner.exec('print("fresh")', []), `the next script (${what})`);
        assert.strictEqual(next.stdout, 'fresh\n', what);
      } finally {
        runner.dispose();
      }
    }
  });

  it("a script that shuts down the socket under fd 1 or fd 4 ends the interpreter at once, saying which, where the fd's checks pass", async () => {
    // A shutdown leaves the fd as it was, so only the write that fails shows it:
    // the end mark's on fd 1's copy, the exec_result's or the tool call's on fd 4.
    const shut = (fd: number) => `socket.socket(fileno=os.dup(${fd})).shutdown(socket.SHUT_WR)`;
    // The end mark's failure comes after the script's result has gone, so that
    // result says the script ended; the others come before it.
    const rows: [string, string, string, RegExp, string][] = [
      [
        'fd 1',
        `import os, socket\nprint("shutting")\n${shut(1)}`,
        'shutting\n',
        /cannot reach the output pipes any more: a script closed, shut down or replaced the runtime's copy of fd 1 \(\[Errno \d+\] [^)\n]+\); exiting/,
        exitedAfterEnd('exited with code 70', "the runtime's copy of fd 1"),
      ],
      [
        'fd 4',
        `import os, socket\n${shut(4)}\nprint("shut")`,
        'shut\n',
        /cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go \(\[Errno \d+\] [^)\n]+\); exiting/,
        runtimeLost('fd 4'),
      ],
      [
        'fd 4, before a tool call',
        `import os, socket\n${shut(4)}\nprint("shut")\nawait test__echo({})\nprint("called")`,
        'shut\n',
        /cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go \(\[Errno \d+\] [^)\n]+\); exiting/,
        runtimeLost('fd 4'),
      ],
    ];
    for (const [what, code, stdout, says, ending] of rows) {
      const runner = new PyRunner({ onToolCall: async () => 'echoed' });
      try {
        // Waiting for a mark or a result that can't come would take the 10-minute limit, past within's 10 s.
        const result = await within(runner.exec(code, ECHO_TOOLS), what);
        assert.strictEqual(result.aborted, true, what);
        assert.strictEqual(result.stdout, stdout, what);
        assert.match(result.stderr, says, what);
        assert.ok(result.stderr.endsWith(`; exiting\n${ending}`), `${what}: ${result.stderr.slice(-500)}`);
        const next = await within(runner.exec('print("fresh")', []), `the next script (${what})`);
        assert.strictEqual(next.stdout, 'fresh\n', what);
      } finally {
        runner.dispose();
      }
    }
  });

  it("a script that shuts down the socket under fd 2 ends the interpreter at once, with the general advice, since the runtime's line can't reach the host", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('import os, socket\nsocket.socket(fileno=os.dup(2)).shutdown(socket.SHUT_WR)\nprint("shut")', []), 'the exit');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stdout, 'shut\n');
      // The end mark's failure comes after the script's result has gone.
      assert.strictEqual(result.stderr, exitedAfterEnd('exited with code 70'));
      assert.strictEqual((await within(runner.exec('print("fresh")', []), 'the next script')).stdout, 'fresh\n');
    } finally {
      runner.dispose();
    }
  });

  it("a script that replaces the runtime's copy of fd 2 with a file is told so through fd 2, and the file gets nothing of the runtime's", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-copy2-'));
    const file = join(dir, 'taken');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec(`import __main__, os\nos.dup2(os.open(${JSON.stringify(file)}, os.O_WRONLY | os.O_CREAT), __main__._STD_ERR)\nprint("replaced")`, []),
        'the replacing script',
      );
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stdout, 'replaced\n');
      assert.match(result.stderr, /cannot reach the output pipes any more: a script closed, shut down or replaced the runtime's copy of fd 2/);
      assert.ok(result.stderr.endsWith(`; exiting\n${runtimeLost("the runtime's copy of fd 2")}`), result.stderr.slice(-500));
      assert.strictEqual(readFileSync(file, 'utf8'), '');
      assert.strictEqual((await within(runner.exec('print("fresh")', []), 'the next script')).stdout, 'fresh\n');
    } finally {
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a script that replaces both the runtime's copy of fd 2 and fd 2 with files gets nothing of the runtime's in either, and the general advice", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-both2-'));
    const copy = join(dir, 'copy');
    const two = join(dir, 'two');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec([
          'import __main__, os',
          `os.dup2(os.open(${JSON.stringify(copy)}, os.O_WRONLY | os.O_CREAT), __main__._STD_ERR)`,
          `os.dup2(os.open(${JSON.stringify(two)}, os.O_WRONLY | os.O_CREAT), 2)`,
          'print("replaced")',
        ].join('\n'), []),
        'the replacing script',
      );
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(result.stdout, 'replaced\n');
      assert.strictEqual(result.stderr, exitedUnder('exited with code 70'));
      assert.deepStrictEqual({ copy: readFileSync(copy, 'utf8'), two: readFileSync(two, 'utf8') }, { copy: '', two: '' });
      assert.strictEqual((await within(runner.exec('print("fresh")', []), 'the next script')).stdout, 'fresh\n');
    } finally {
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a script that points fd 2 at stdout and closes the runtime's copy of fd 2 gets the advice for that copy, from the runtime's line on stdout", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(runner.exec('import __main__, os\nos.dup2(1, 2)\nos.close(__main__._STD_ERR)\nprint("pointed")', []), 'the runtime to end');
      assert.strictEqual(result.aborted, true);
      assert.strictEqual(
        result.stdout,
        "pointed\n[pytc-runtime] cannot reach the output pipes any more: a script closed, shut down or replaced the runtime's copy of fd 2; exiting\n",
      );
      assert.strictEqual(result.stderr, runtimeLost("the runtime's copy of fd 2"));
    } finally {
      runner.dispose();
    }
  });

  it("a script that closes fd 3 while it still waits on the host ends the interpreter when the runtime's reader fails, or reads a file that took the number to its end", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-fd3-'));
    const file = join(dir, 'readable');
    // Empty, so the reader meets its end at once and queues no line of the
    // file's for the runtime's loop, which would log it as a bad line.
    writeFileSync(file, '');
    const runner = new PyRunner({ onToolCall: async () => 'echoed' });
    try {
      // The tool's result can still reach a read already waiting on fd 3; the
      // read after it fails, or reads the file that took the number to its
      // end, while the script sleeps. The sleep outlasts within's 10 s, so the
      // end-of-script check, which says the same, can't be what settles it.
      // The file stays open, held by a global, so it keeps the number.
      for (const [how, takes] of [['closed', ''], ['taken by a readable file', `\nheld = open(${JSON.stringify(file)})`]]) {
        const result = await within(
          runner.exec(`import os, time\nos.close(3)${takes}\nawait test__echo({})\ntime.sleep(30)`, ECHO_TOOLS),
          `the reader to stop, fd 3 ${how}`,
        );
        assert.strictEqual(result.aborted, true, how);
        assert.ok(
          result.stderr.endsWith(`cannot read the host's messages any more: a script closed, shut down or replaced fd 3, where they arrive; exiting\n${runtimeLost('fd 3')}`),
          `${how}: ${result.stderr.slice(-500)}`,
        );
        // The reader names it: it isn't the runtime cancelling the script
        // because the host's messages ended, then finding fd 3 at its end.
        assert.doesNotMatch(result.stderr, /KeyboardInterrupt: script cancelled by host/, how);
      }
    } finally {
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a script that shuts down fd 3's socket for reading ends the interpreter, saying so, rather than reading as cancelled by the host", async () => {
    // The runtime's reader meets the end of fd 3 with fd 3 still the host's,
    // which while a script runs only a script's shutdown makes.
    const shut = 'socket.socket(fileno=os.dup(3)).shutdown(socket.SHUT_RD)';
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (const [how, waits] of [['blocked', 'time.sleep(30)'], ['awaiting', 'await asyncio.sleep(30)']]) {
        const result = await within(
          runner.exec(`import asyncio, os, socket, time\nprint("shutting")\n${shut}\n${waits}`, []),
          `the runtime to end, ${how}`,
        );
        assert.strictEqual(result.aborted, true, how);
        assert.strictEqual(result.stdout, 'shutting\n', how);
        assert.ok(
          result.stderr.endsWith(`cannot read the host's messages any more: a script closed, shut down or replaced fd 3, where they arrive; exiting\n${runtimeLost('fd 3')}`),
          `${how}: ${result.stderr.slice(-500)}`,
        );
        assert.doesNotMatch(result.stderr, /KeyboardInterrupt: script cancelled by host/, how);
      }
    } finally {
      runner.dispose();
    }
  });

  it("a script's own exit keeps the general advice, with the runtime's code or after a line like the runtime's", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const own = await within(runner.exec('import os\nos._exit(70)', []), 'the exit with 70');
      assert.strictEqual(own.stderr, exitedUnder('exited with code 70'));
      // A script that shows such a line, as one reading an old log might, then ends some other way.
      const line = "[pytc-runtime] cannot read the host's messages any more: a script closed, shut down or replaced fd 3, where they arrive; exiting";
      const shown = await within(runner.exec(`import os, sys\nsys.stderr.write(${JSON.stringify(line + '\n')})\nsys.stderr.flush()\nos._exit(3)`, []), 'the exit with 3');
      assert.strictEqual(shown.stderr, `${line}\n${exitedUnder('exited with code 3')}`);
    } finally {
      runner.dispose();
    }
  });

  it("a thread a script left running that replaces fd 4 ends the interpreter as the next script starts, before it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-thread-'));
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The thread waits for a file the test makes once the script has returned.
      const first = await runner.exec(
        [
          'import os, threading, time',
          'def later():',
          `    while not os.path.exists(${JSON.stringify(join(dir, 'go'))}): time.sleep(0.05)`,
          '    os.dup2(os.open(os.devnull, os.O_WRONLY), 4)',
          `    open(${JSON.stringify(join(dir, 'done'))}, "w").close()`,
          'threading.Thread(target=later, daemon=True).start()',
          'print("started")',
        ].join('\n'),
        [],
      );
      assert.strictEqual(first.stdout, 'started\n');
      writeFileSync(join(dir, 'go'), '');
      await until(() => existsSync(join(dir, 'done')), 'the thread to replace fd 4');
      const next = await within(runner.exec('print("ran")', []), 'the next script');
      assert.strictEqual(next.aborted, true);
      assert.strictEqual(next.stdout, '');
      assert.match(next.stderr, /cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go; exiting\n/);
    } finally {
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a process the script forks that runs off the script's end leaves with the exit status Python would give it, without ending the exec", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // Python 3.12 on warns that the runtime's reader thread makes fork() risky.
      const result = await within(
        runner.exec(
          [
            'import os, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)',
            'pid = os.fork()',
            'if pid == 0:',
            '    print("child")',
            '    raise RuntimeError("raised in the child")',
            '_, status = os.waitpid(pid, 0)',
            'print("parent saw", os.WEXITSTATUS(status))',
          ].join('\n'),
          [],
        ),
        'the exec to settle',
      );
      // The child's traceback is its own, and its exit says it raised, as Python's does.
      assert.strictEqual(result.stdout, 'child\nparent saw 1\n');
      assert.match(result.stderr, /^Traceback \(most recent call last\):\n[\s\S]*RuntimeError: raised in the child\n$/);
      assert.strictEqual(result.returnCode, 0);
      // A child's sys.exit() is its exit status, with no traceback, as in Python.
      const exits = await within(
        runner.exec(
          [
            'import os, sys, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)',
            'class Unprintable:',
            '    def __str__(self): raise ValueError("no text")',
            'statuses = []',
            'for code in (3, None, 259, 2 ** 40, "boom", Unprintable()):',
            '    pid = os.fork()',
            '    if pid == 0:',
            '        sys.exit(code)',
            '    statuses.append(os.WEXITSTATUS(os.waitpid(pid, 0)[1]))',
            'print("parent saw", statuses)',
          ].join('\n'),
          [],
        ),
        'the sys.exit children',
      );
      // Python keeps an int's low byte, 3 for 259 and 0 for 2 ** 40, which is
      // too big for os._exit; a code that isn't a number is written, then 1.
      assert.deepStrictEqual(exits, { stdout: 'parent saw [3, 0, 3, 0, 1, 1]\n', stderr: 'boom\n', returnCode: 0 });
      assert.strictEqual((await runner.exec('print("next")', [])).stdout, 'next\n');
    } finally {
      runner.dispose();
    }
  });

  it("a script that detaches its stdout's buffer, keeping the old writer, still settles, and so do forks after it", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec(
          [
            'import io, os, sys, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)',
            'old = sys.stdout',
            'sys.stdout = io.TextIOWrapper(old.detach(), encoding="utf-8", line_buffering=True)',
            'print("after the detach")',
            'pid = os.fork()',
            'if pid == 0:',
            '    os._exit(0)',
            'os.waitpid(pid, 0)',
            'print("after the fork")',
          ].join('\n'),
          [],
        ),
        'the detaching script',
      );
      assert.deepStrictEqual(
        { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
        { stdout: 'after the detach\nafter the fork\n', stderr: '', returnCode: 0 },
      );
    } finally {
      runner.dispose();
    }
  });

  it("a script that closes its stdout's writer settles with what it wrote, with no note, and the next script prints", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec('import sys\nprint("before the close")\nsys.stdout.write("partial")\nsys.stdout.close()', []),
        'the closing script',
      );
      assert.deepStrictEqual(
        { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
        { stdout: 'before the close\npartial', stderr: '', returnCode: 0 },
      );
      assert.strictEqual((await within(runner.exec('print("next")', []), 'the next script')).stdout, 'next\n');
    } finally {
      runner.dispose();
    }
  });

  it("what a kept writer couldn't send when its script ended doesn't reach a later script's result, and the writer still writes", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      await within(runner.exec('import sys\nkept = sys.stderr', []), 'the keeping script');
      const failed = await within(runner.exec('import os\nos.close(2)\nkept.write("unsent")', []), 'the script that closes fd 2');
      assert.match(failed.stderr, /^\[pytc-runtime\] some of what the script wrote couldn't be sent \(\[Errno 9\] [^\n]*\)\n$/);
      const next = await within(runner.exec('print("next")', []), 'the next script');
      assert.deepStrictEqual({ stdout: next.stdout, stderr: next.stderr }, { stdout: 'next\n', stderr: '' });
      const later = await within(runner.exec('kept.write("kept still writes\\n")', []), 'a script writing through the kept writer');
      assert.deepStrictEqual({ stdout: later.stdout, stderr: later.stderr }, { stdout: '', stderr: 'kept still writes\n' });
    } finally {
      runner.dispose();
    }
  });

  it("what a script's own wrapper in sys.stdout couldn't send when its script ended is said and dropped, and the wrapper still writes", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The wrapper sits over the runtime's raw writer, as the detach-and-rewrap idiom leaves it.
      const failed = await within(
        runner.exec('import io, os, sys\nw = io.TextIOWrapper(sys.stdout.detach())\nsys.stdout = w\nprint("held", end="")\nos.close(1)', []),
        'the script that closes fd 1',
      );
      assert.match(failed.stderr, /^\[pytc-runtime\] some of what the script wrote couldn't be sent \(\[Errno 9\] [^\n]*\)\n$/);
      const later = await within(runner.exec('w.write("later\\n")\nw.flush()', []), 'a script writing through the wrapper');
      assert.deepStrictEqual({ stdout: later.stdout, stderr: later.stderr }, { stdout: 'later\n', stderr: '' });
    } finally {
      runner.dispose();
    }
  });

  it("a script that leaves something unhashable in sys.stdout, or None, still settles, with no note", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // Defining __eq__ without __hash__ makes the class unhashable.
      const result = await within(
        runner.exec([
          'import sys',
          'class Out:',
          '    def __eq__(self, other): return self is other',
          '    def write(self, s): return len(s)',
          '    def flush(self): pass',
          'sys.stdout = Out()',
          'print("swallowed")',
        ].join('\n'), []),
        'the script to settle',
      );
      assert.deepStrictEqual({ stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode }, { stdout: '', stderr: '', returnCode: 0 });
      // None, as pythonw leaves it, has nothing to flush.
      const none = await within(runner.exec('import sys\nsys.stdout = None', []), 'the script that sets None');
      assert.deepStrictEqual({ stdout: none.stdout, stderr: none.stderr, returnCode: none.returnCode }, { stdout: '', stderr: '', returnCode: 0 });
    } finally {
      runner.dispose();
    }
  });

  it("a script whose own object in sys.stdout raises an error or SystemExit from its flush still settles with the runtime's note, and keeps its interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const cases: [string, string, string][] = [
        ['an error whose text raises', 'class BadText(Exception):\n    def __str__(self): raise RuntimeError("no text")\nclass Out:\n    def write(self, s): return len(s)\n    def flush(self): raise BadText()', 'BadText'],
        ['a flush that is a raising property', 'class Out:\n    def write(self, s): return len(s)\n    @property\n    def flush(self): raise RuntimeError("no flush")', 'no flush'],
        ['SystemExit', 'class Out:\n    def write(self, s): return len(s)\n    def flush(self): raise SystemExit(3)', '3'],
        ['a SystemExit with no code', 'class Out:\n    def write(self, s): return len(s)\n    def flush(self): raise SystemExit()', 'SystemExit'],
        [
          "an error with no text whose type's metaclass refuses its name",
          'class Meta(type):\n    @property\n    def __name__(cls): raise RuntimeError("no name")\n'
            + 'class Nameless(Exception, metaclass=Meta):\n    pass\n'
            + 'class Out:\n    def write(self, s): return len(s)\n    def flush(self): raise Nameless()',
          'Nameless',
        ],
        [
          'an error whose text is a str of its own that refuses truth and joining',
          'class Hostile(str):\n    def __bool__(self): raise RuntimeError("no truth")\n    def __radd__(self, other): raise RuntimeError("no joining")\n'
            + 'class Odd(Exception):\n    def __str__(self): return Hostile("odd text")\n'
            + 'class Out:\n    def write(self, s): return len(s)\n    def flush(self): raise Odd()',
          'odd text',
        ],
        [
          'an error whose text raises SystemExit',
          'class Exiting(Exception):\n    def __str__(self): raise SystemExit(5)\nclass Out:\n    def write(self, s): return len(s)\n    def flush(self): raise Exiting()',
          'Exiting',
        ],
        [
          "an error with no text whose type's name is a str of its own that refuses joining",
          'class Hostile(str):\n    def __radd__(self, other): raise RuntimeError("no joining")\n'
            + 'class Renamed(Exception):\n    pass\nRenamed.__name__ = Hostile("Renamed")\n'
            + 'class Out:\n    def write(self, s): return len(s)\n    def flush(self): raise Renamed()',
          'Renamed',
        ],
      ];
      for (const [what, defines, said] of cases) {
        const result = await within(runner.exec(`import sys\n${defines}\nsys.stdout = Out()\nkept = "${what}"`, []), what);
        assert.deepStrictEqual(
          { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
          { stdout: '', stderr: `[pytc-runtime] some of what the script wrote couldn't be sent (${said})\n`, returnCode: 0 },
          what,
        );
        assert.strictEqual((await within(runner.exec('print(kept)', []), `the next script (${what})`)).stdout, `${what}\n`, what);
      }
    } finally {
      runner.dispose();
    }
  });

  it("a script that replaces its writers' flush with one that raises an error or SystemExit still settles with a note for each writer, and keeps its interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const cases: [string, string, string][] = [
        ['an error', 'def flush():\n    raise RuntimeError("no flush")', 'no flush'],
        ['SystemExit', 'def flush():\n    raise SystemExit(3)', '3'],
      ];
      for (const [what, defines, said] of cases) {
        // Both writers, so each is flushed and said whatever the other raised.
        const result = await within(runner.exec(`import sys\n${defines}\nsys.stdout.flush = flush\nsys.stderr.flush = flush\nkept = "${what}"`, []), what);
        const note = `[pytc-runtime] some of what the script wrote couldn't be sent (${said})\n`;
        assert.deepStrictEqual(
          { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
          { stdout: '', stderr: note + note, returnCode: 0 },
          what,
        );
        assert.strictEqual((await within(runner.exec('print(kept)', []), `the next script (${what})`)).stdout, `${what}\n`, what);
      }
      // What a writer held when its replaced flush raised is dropped, not sent
      // in a later exec once the script takes its flush back.
      const held = await within(
        runner.exec('import sys\nwriter = sys.stdout\nwriter.write("held")\ndef flush():\n    raise SystemExit("no flush")\nwriter.flush = flush', []),
        'the held line',
      );
      assert.strictEqual(held.stderr, "[pytc-runtime] some of what the script wrote couldn't be sent (no flush)\n");
      const later = await within(runner.exec('del writer.flush\nprint("later")', []), 'the later script');
      assert.deepStrictEqual({ stdout: later.stdout, stderr: later.stderr }, { stdout: 'later\n', stderr: '' });
    } finally {
      runner.dispose();
    }
  });

  it("a script that replaces its stderr writer's write with one that raises anything, SystemExit included, still settles when it fails, and keeps its interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const cases: [string, string][] = [
        ['CancelledError', 'import asyncio\ndef write(s):\n    raise asyncio.CancelledError()'],
        ['SystemExit', 'def write(s):\n    raise SystemExit(4)'],
      ];
      for (const [what, defines] of cases) {
        // The runtime's note of the script's error goes through that write,
        // and when it refuses, through the runtime's own line instead.
        const result = await within(
          runner.exec(`import sys\n${defines}\nsys.stderr.write = write\nkept = "${what}"\nraise RuntimeError("the script's own")`, []),
          what,
        );
        assert.strictEqual(result.returnCode, 1, what);
        assert.match(result.stderr, /^\[pytc-runtime\] Traceback \(most recent call last\):\n[\s\S]*\nRuntimeError: the script's own\n$/, what);
        assert.strictEqual((await within(runner.exec('print(kept)', []), `the next script (${what})`)).stdout, `${what}\n`, what);
      }
    } finally {
      runner.dispose();
    }
  });

  it("a multiprocessing child doesn't send the parent's partial line again", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The child leaves through multiprocessing's own exit, which flushes sys.stdout.
      const result = await within(
        runner.exec(
          [
            'import multiprocessing, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)',
            'print("partial", end="")',
            'child = multiprocessing.get_context("fork").Process(target=lambda: print("|child", end=""))',
            'child.start()',
            'child.join()',
            'print("|parent", child.exitcode)',
          ].join('\n'),
          [],
        ),
        'the multiprocessing script',
      );
      assert.deepStrictEqual(
        { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
        { stdout: 'partial|child|parent 0\n', stderr: '', returnCode: 0 },
      );
    } finally {
      runner.dispose();
    }
  });

  it("a forked process's own partial line arrives as it leaves, and the parent's isn't sent twice", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The parent's partial line is in its writer at each fork; one child
      // leaves through sys.exit() and one runs off the script's end, each with
      // a partial line of its own.
      const result = await within(
        runner.exec(
          [
            'import os, sys, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)',
            'print("partial", end="")',
            'pid = os.fork()',
            'if pid == 0:',
            '    print("|exits", end="")',
            '    sys.exit(0)',
            'os.waitpid(pid, 0)',
            'pid = os.fork()',
            'if pid == 0:',
            '    print("|runs off", end="")',
            'else:',
            '    os.waitpid(pid, 0)',
            '    print("|parent")',
          ].join('\n'),
          [],
        ),
        'the forking script',
      );
      assert.deepStrictEqual(
        { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
        { stdout: 'partial|exits|runs off|parent\n', stderr: '', returnCode: 0 },
      );
    } finally {
      runner.dispose();
    }
  });

  it("a script's own wrapper in sys.stdout sends what the parent held once, at the fork, and what a forked process wrote as it leaves through sys.exit()", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The wrapper holds the parent's "a" at the fork, and the child's line at its exit.
      const result = await within(
        runner.exec(
          [
            'import io, os, sys, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)',
            'sys.stdout = io.TextIOWrapper(sys.stdout.detach())',
            'print("a", end="")',
            'pid = os.fork()',
            'if pid == 0:',
            '    print("child")',
            '    sys.exit(0)',
            'os.waitpid(pid, 0)',
            'print("parent")',
          ].join('\n'),
          [],
        ),
        'the forking script',
      );
      assert.deepStrictEqual(
        { stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode },
        { stdout: 'achild\nparent\n', stderr: '', returnCode: 0 },
      );
    } finally {
      runner.dispose();
    }
  });

  it("a script's ordinary use of fds, its own files, pipes, commands and forks, keeps the interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const busy = await within(
        runner.exec(
          [
            'import os, subprocess, warnings',
            'warnings.simplefilter("ignore", DeprecationWarning)  # fork() beside the runtime\'s reader thread',
            'r, w = os.pipe()',
            'os.write(w, b"x")',
            'os.close(r)',
            'os.close(w)',
            'with open(os.devnull) as f:',
            '    f.read()',
            'subprocess.run(["true"], pass_fds=())',
            'pid = os.fork()',
            'if pid == 0:',
            '    os.closerange(3, 64)',
            '    os._exit(0)',
            'os.waitpid(pid, 0)',
            'kept = 42',
          ].join('\n'),
          [],
        ),
        'the busy script',
      );
      assert.deepStrictEqual(busy, { stdout: '', stderr: '', returnCode: 0 });
      // The same interpreter, with its variables.
      assert.strictEqual((await runner.exec('print(kept)', [])).stdout, '42\n');
    } finally {
      runner.dispose();
    }
  });

  it("a script that changes the mode of fd 1 or fd 3 keeps the interpreter: the check of the runtime's own fds compares which file each is, not its mode, which macOS sets from a socket's state", async () => {
    // Linux lets a script change a socket's mode with fchmod. Where that's refused,
    // the script goes on without it, and on macOS the shutdown tests cover the check.
    for (const fd of [1, 3]) {
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        const changed = await within(
          runner.exec(`import os\ntry:\n    os.fchmod(${fd}, 0o600)\nexcept OSError:\n    pass\nkept = ${fd}\nprint(oct(os.fstat(${fd}).st_mode & 0o777))`, []),
          `fd ${fd}`,
        );
        // On Linux the mode did change, so the check had a change to pass over.
        const mode = process.platform === 'linux' ? '0o600\n' : changed.stdout;
        assert.deepStrictEqual(changed, { stdout: mode, stderr: '', returnCode: 0 }, `fd ${fd}`);
        assert.strictEqual((await within(runner.exec('print(kept)', []), `the next script (fd ${fd})`)).stdout, `${fd}\n`, `fd ${fd}`);
      } finally {
        runner.dispose();
      }
    }
  });

  it('an interpreter that exits while no script runs says so in the host log', async () => {
    await logging(async (logged) => {
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        const first = await runner.exec('import os, threading\nthreading.Timer(0.3, os._exit, (5,)).start()\nprint("armed")', []);
        assert.strictEqual(first.stdout, 'armed\n');
        await until(
          () => logged.some((l) => l.endsWith('python runtime exited while no script ran (code=5, signal=none); the next script starts a new one')),
          'the exit in the log',
        );
        assert.strictEqual((await runner.exec('print("fresh")', [])).stdout, 'fresh\n');
      } finally {
        runner.dispose();
      }
    });
  });

  it('a script whose output pipe a command left non-blocking still writes all of it', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // fds 1 and 2 are one open file with the runtime's copies, so the flag
      // reaches the runtime's own writes too, its end marks among them.
      const result = await within(
        runner.exec('import os\nos.set_blocking(1, False)\nfor i in range(20000):\n    print("x" * 70)\nprint("end")', []),
        'the script to finish',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `${`${'x'.repeat(70)}\n`.repeat(20000)}end\n`);
    } finally {
      runner.dispose();
    }
  });

  it('each script starts with its output pipes blocking, whatever a command left them', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The flag belongs to each pipe's open file, which the command shares with the script.
      const first = await within(
        runner.exec('import os, subprocess, sys\nsubprocess.run([sys.executable, "-c", "import os; os.set_blocking(1, False); os.set_blocking(2, False)"], check=True)\nprint(os.get_blocking(1), os.get_blocking(2))', []),
        'the first script',
      );
      assert.strictEqual(first.stdout, 'False False\n', first.stderr);
      const next = await within(runner.exec('import os\nprint(os.get_blocking(1), os.get_blocking(2))', []), 'the next script');
      assert.strictEqual(next.stdout, 'True True\n', next.stderr);
    } finally {
      runner.dispose();
    }
  });

  it('what a script left in wrappers of its own that it put in sys.stdout and sys.stderr comes back in its result, and not in the next', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // Kept as globals, the wrappers outlive the script, so nothing else flushes them.
      const result = await within(
        runner.exec([
          'import io, sys',
          'out = io.TextIOWrapper(sys.stdout.detach())',
          'err = io.TextIOWrapper(sys.stderr.detach())',
          'sys.stdout, sys.stderr = out, err',
          'print("in the wrapper")',
          'print("in the other", file=sys.stderr)',
        ].join('\n'), []),
        'the script',
      );
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.deepStrictEqual({ stdout: result.stdout, stderr: result.stderr }, { stdout: 'in the wrapper\n', stderr: 'in the other\n' });
      const next = await within(runner.exec('print("next")', []), 'the next script');
      assert.deepStrictEqual({ stdout: next.stdout, stderr: next.stderr }, { stdout: 'next\n', stderr: '' });
    } finally {
      runner.dispose();
    }
  });

  it("an error reading the runtime's messages is logged, not thrown", async () => {
    await logging(async (logged) => {
      const runner = new PyRunner({ onToolCall: async () => '' });
      const thrown: unknown[] = [];
      const onUncaught = (err: unknown) => thrown.push(err);
      try {
        assert.strictEqual((await runner.exec('print("started")', [])).stdout, 'started\n');
        // No script can make the host's read of fd 4 fail, so the test fails it,
        // through the runner's private interpreter.
        const child = (runner as unknown as { child: ChildProcess | null }).child;
        assert.ok(child, 'the interpreter should still run');
        process.on('uncaughtException', onUncaught);
        child.stdio[4]?.destroy(new Error('a probe read error'));
        // The stream's own listener logs the error as readline passes it on, in the same turn.
        await until(() => logged.some((l) => l.includes("reading the python runtime's messages failed: a probe read error")), 'the logged error');
        await new Promise((r) => setImmediate(r));
        assert.deepStrictEqual(thrown, []);
      } finally {
        process.off('uncaughtException', onUncaught);
        runner.dispose();
      }
    });
  });

  it("a thread a script left running prints a lone surrogate between scripts as backslashreplace writes it, into the host's log", async () => {
    await logging(async (logged) => {
      const dir = mkdtempSync(join(tmpdir(), 'pytc-thread-surrogate-'));
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        // The thread prints once the test makes the file, after its script has returned.
        const go = join(dir, 'go');
        const first = await runner.exec([
          'import os, threading, time',
          'def later():',
          `    while not os.path.exists(${JSON.stringify(go)}): time.sleep(0.05)`,
          '    print("between a\\udcffb")',
          'threading.Thread(target=later, daemon=True).start()',
          'print("started")',
        ].join('\n'), []);
        assert.strictEqual(first.stdout, 'started\n');
        writeFileSync(go, '');
        await until(() => logged.some((l) => l.endsWith('stdout while its interpreter runs no script: between a\\udcffb')), "the thread's line in the log");
      } finally {
        runner.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("a host that sends exit and then ends fd 3 while a script waits on the host gets the script cancelled and a clean exit, with no line about fd 3", async () => {
    let called!: () => void;
    const calling = new Promise<void>((r) => {
      called = r;
    });
    // The call is never answered, so the host writes nothing after fd 3's end.
    const runner = new PyRunner({
      onToolCall: () => {
        called();
        return new Promise<string>(() => {});
      },
    });
    try {
      const pending = runner.exec('await test__echo({})', ECHO_TOOLS);
      await within(calling, 'the script to call');
      // PyRunner never sends exit; a host that runs the runtime itself does, through
      // the runner's own channel here.
      const internals = runner as unknown as { send(obj: unknown): void; protoIn: Writable | null; child: ChildProcess | null };
      const child = internals.child;
      assert.ok(child && internals.protoIn, 'the interpreter should be running');
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      internals.send({ op: 'exit' });
      internals.protoIn.end();
      const result = await within(pending, 'the exec to settle');
      assert.strictEqual(await within(exited, 'the interpreter to exit'), 0);
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /KeyboardInterrupt: script cancelled by host/);
      assert.doesNotMatch(result.stderr, /fd 3/);
    } finally {
      runner.dispose();
    }
  });

  it("a host that sends exit and then ends fd 3 while a script blocks gets the script's result and a clean exit, with no line about fd 3", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-exit-then-end-'));
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The script blocks, so the runtime's reader meets the end of fd 3 before the loop
      // takes the exit op, with the script still running.
      const started = join(dir, 'started');
      const pending = runner.exec(`import time\nopen(${JSON.stringify(started)}, "w").close()\ntime.sleep(2)\nprint("slept")`, []);
      await until(() => existsSync(started), 'the script to start');
      // PyRunner never sends exit; a host that runs the runtime itself does, through
      // the runner's own channel here.
      const internals = runner as unknown as { send(obj: unknown): void; protoIn: Writable | null; child: ChildProcess | null };
      const child = internals.child;
      assert.ok(child && internals.protoIn, 'the interpreter should be running');
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      internals.send({ op: 'exit' });
      internals.protoIn.end();
      const result = await within(pending, 'the exec to settle');
      assert.strictEqual(await within(exited, 'the interpreter to exit'), 0);
      assert.deepStrictEqual({ stdout: result.stdout, stderr: result.stderr, returnCode: result.returnCode }, { stdout: 'slept\n', stderr: '', returnCode: 0 });
    } finally {
      runner.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Inner-call ids restart in every interpreter: a result that outlives its
// interpreter must not resolve a call of the one that replaced it.
describe('code_execution inner-call results after the interpreter is replaced (real python3)', () => {
  const stops: Record<string, { code: string; stop?: (runner: PyRunner) => void }> = {
    aborted: { code: 'print(await test__echo({}))', stop: (runner) => runner.abort('turn abandoned') },
    crashed: {
      code: 'import asyncio, os\nasyncio.get_running_loop().call_later(0.2, os._exit, 1)\nprint(await test__echo({}))',
    },
  };

  for (const [how, { code, stop }] of Object.entries(stops)) {
    it(`a late result from a script whose interpreter ${how} does not reach the next script`, async () => {
      const calls: Array<(result: string) => void> = [];
      const runner = new PyRunner({
        onToolCall: () => new Promise<string>((resolve) => calls.push(resolve)),
      });
      const logged: string[] = [];
      const consoleError = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
        consoleError(...args);
      };
      try {
        const first = runner.exec(code, ECHO_TOOLS);
        await until(() => calls.length === 1, 'the first script to call its tool');
        stop?.(runner);
        const stopped = await first;
        assert.strictEqual(stopped.aborted, true, stopped.stderr);

        const second = runner.exec('print(await test__echo({}))', ECHO_TOOLS);
        await until(() => calls.length === 2, 'the second script to call its tool');
        // Both calls are the first of their interpreter.
        calls[0]('stale result of the stopped script');
        await new Promise((r) => setTimeout(r, 300));
        calls[1]('result of this script');
        const result = await second;
        assert.strictEqual(result.returnCode, 0, result.stderr);
        assert.strictEqual(result.stdout, 'result of this script\n');
        assert.ok(
          logged.some((l) => /dropped late result of test--echo call t1: the interpreter that asked for it is gone/.test(l)),
          'the dropped result is logged',
        );
      } finally {
        console.error = consoleError;
        runner.dispose();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Framework integration
// ---------------------------------------------------------------------------

class ScriptToolModule implements Module {
  readonly name = 'test';
  readonly calls: ToolCall[] = [];

  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [
      {
        name: 'echo',
        description: 'Echo input. Returns JSON: {"echoed": <input>}.',
        inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
      },
      {
        name: 'finish',
        description: 'End the turn.',
        inputSchema: { type: 'object', properties: {} },
      },
    ];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    this.calls.push(call);
    const baseName = call.name.includes('--')
      ? call.name.slice(call.name.lastIndexOf('--') + 2)
      : call.name;
    if (baseName === 'finish') {
      return { success: true, data: { finished: true }, endTurn: true };
    }
    return { success: true, data: { echoed: call.input } };
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      const content = Array.isArray((event as { content?: unknown }).content)
        ? ((event as { content: unknown }).content as Array<{ type: string; text?: string }>)
        : [{ type: 'text', text: String((event as { content?: unknown }).content) }];
      return {
        addMessages: [{ participant: 'User', content: content as never }],
        requestInference: true,
      };
    }
    return {};
  }
}

function tempStorePath(prefix: string): { tempDir: string; storePath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), prefix));
  return { tempDir, storePath: join(tempDir, 'store.chronicle') };
}

async function createFrameworkWithCodeExecution(storePath: string, membrane: MockMembrane, module: Module) {
  return AgentFramework.create({
    storePath,
    membrane: membrane.asMembrane(),
    agents: [],
    modules: [module],
    syncIntervalMs: 0,
    codeExecution: { enabled: true },
  });
}

/** A host variable no allowlist names, and a declared one, for the env tests below. */
const HOST_ONLY = 'AF_CODE_EXEC_TEST_HOST_ONLY';
const DECLARED = 'AF_CODE_EXEC_TEST_DECLARED';

describe('framework code_execution integration (real python3)', () => {
  it("a script gets codeExecution.env and not a host variable outside the allowlist", async () => {
    const { tempDir, storePath } = tempStorePath('pytc-env-');
    const membrane = new MockMembrane();
    const code = `import os; print("declared:", os.environ.get("${DECLARED}"), "host:", repr(os.environ.get("${HOST_ONLY}")))`;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_env_1', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, env: { [DECLARED]: 'from-config' } },
    });
    try {
      process.env[HOST_ONLY] = 'host-value';
      const created = await framework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      await promise;
      const wireResult = membrane.lastStream!.receivedToolResults[0][0] as { content: string };
      assert.match(wireResult.content, /declared: from-config host: None/, wireResult.content);
    } finally {
      await framework.stop();
      delete process.env[HOST_ONLY];
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("with codeExecution.inheritEnv: true, a script gets the host's variables beside codeExecution.env", async () => {
    const { tempDir, storePath } = tempStorePath('pytc-envinherit-');
    const membrane = new MockMembrane();
    const code = `import os; print("declared:", os.environ.get("${DECLARED}"), "host:", repr(os.environ.get("${HOST_ONLY}")))`;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_env_2', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Done.' }]));
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, env: { [DECLARED]: 'from-config' }, inheritEnv: true },
    });
    try {
      process.env[HOST_ONLY] = 'host-value';
      const created = await framework.createEphemeralAgent({
        name: 'worker', model: 'test-model', systemPrompt: 'Do the task.', allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      await promise;
      const wireResult = membrane.lastStream!.receivedToolResults[0][0] as { content: string };
      assert.match(wireResult.content, /declared: from-config host: 'host-value'/, wireResult.content);
    } finally {
      await framework.stop();
      delete process.env[HOST_ONLY];
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('create() refuses a codeExecution.inheritEnv that is not a boolean', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-inherit-');
    try {
      await assert.rejects(AgentFramework.create({
        storePath,
        membrane: new MockMembrane().asMembrane(),
        agents: [],
        modules: [new ScriptToolModule()],
        syncIntervalMs: 0,
        codeExecution: { enabled: true, inheritEnv: 'false' as unknown as boolean },
      }), /codeExecution\.inheritEnv must be true or false, unquoted, not a string: /);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('synthesizes the tool only when enabled', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-tools-');
    const membrane = new MockMembrane();
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [],
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
    });
    try {
      assert.ok(!framework.getAllTools().some((t) => t.name === 'code_execution'));
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }

    const { tempDir: tempDir2, storePath: storePath2 } = tempStorePath('pytc-tools2-');
    const membrane2 = new MockMembrane();
    const framework2 = await createFrameworkWithCodeExecution(storePath2, membrane2, new ScriptToolModule());
    try {
      const tool = framework2.getAllTools().find((t) => t.name === 'code_execution');
      assert.ok(tool, 'code_execution tool should be synthesized');
      assert.match(tool.description, /async Python function/);
      assert.match(tool.description, /__/);
    } finally {
      await framework2.stop();
      rmSync(tempDir2, { recursive: true, force: true });
    }
  });

  it('runs a script that calls module tools; intermediates never reach the model', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-run-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();

    const code = [
      'import json',
      'names = []',
      'flags = []',
      'for m in ["alpha", "beta"]:',
      '    raw = await test__echo({"message": m})',
      '    flags.append(raw.is_error)',
      '    r = json.loads(raw)',
      '    names.append(r["echoed"]["message"].upper())',
      'print("summary:", "+".join(names))',
      'print("is_error:", flags)',
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Let me fan out.' },
      { type: 'tool_use', id: 'call_ce_1', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Final answer.' },
    ]));

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'worker',
        model: 'test-model',
        systemPrompt: 'Do the task.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await promise;

      assert.strictEqual(result.speech, 'Final answer.');

      // The module saw both inner calls, dispatched with pytc- IDs (waiter
      // path), not the model's call ID.
      const echoCalls = module.calls.filter((c) => c.name.endsWith('--echo') || c.name === 'echo');
      assert.strictEqual(echoCalls.length, 2);
      for (const call of echoCalls) {
        assert.match(String(call.id), /^pytc-/);
      }

      // The model-facing tool_result carries the script's stdout...
      const stream = membrane.lastStream!;
      assert.strictEqual(stream.receivedToolResults.length, 1);
      const wireResult = stream.receivedToolResults[0][0] as { toolUseId: string; content: string };
      assert.strictEqual(wireResult.toolUseId, 'call_ce_1');
      assert.match(wireResult.content, /summary: ALPHA\+BETA/);
      // Through the framework, each result says it isn't an error (a
      // handler that passed on only the string would make it None).
      assert.match(wireResult.content, /is_error: \[False, False\]/);
      assert.match(wireResult.content, /^exit code: 0\n/);
      // ...and NOT the intermediate tool results.
      assert.ok(
        !wireResult.content.includes('"echoed"'),
        'intermediate tool results must not reach the model-facing result',
      );
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('two code_execution calls in one response: one runs, the other is refused, the turn completes', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-two-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();
    const code = (label: string) => [
      'import asyncio, json',
      `r = json.loads(await test__echo({"message": "${label}"}))`,
      'await asyncio.sleep(0.2)',
      `print("ran:", r["echoed"]["message"])`,
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_two_a', name: 'code_execution', input: { code: code('a') } },
      { type: 'tool_use', id: 'call_two_b', name: 'code_execution', input: { code: code('b') } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Both answered.' }]));

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'pair',
        model: 'test-model',
        systemPrompt: 'Run both.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Go.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the turn never completed')), 15_000)),
      ]);
      assert.strictEqual(result.speech, 'Both answered.');

      const [results] = membrane.lastStream!.receivedToolResults as Array<Array<{ toolUseId: string; content: string }>>;
      const byId = new Map(results.map((r) => [r.toolUseId, r.content]));
      assert.match(byId.get('call_two_a') ?? '', /ran: a/, 'the first script ran');
      assert.match(byId.get('call_two_b') ?? '', /already running/, 'the second was refused');
      assert.ok(!(byId.get('call_two_b') ?? '').includes('ran: b'));
      const echoed = module.calls.filter((c) => c.name.endsWith('--echo') || c.name === 'echo').map((c) => (c.input as { message: string }).message);
      assert.deepStrictEqual(echoed, ['a']);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defers endTurn from inner calls to the code_execution result', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-endturn-');
    const membrane = new MockMembrane();
    const module = new ScriptToolModule();

    const code = [
      'r = await test__finish({})',
      'print("after finish:", r)',
    ].join('\n');

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Finishing via script.' },
      { type: 'tool_use', id: 'call_ce_2', name: 'code_execution', input: { code } },
    ], 'tool_use'));
    // No further response: endTurn must settle the turn without another round.

    const framework = await createFrameworkWithCodeExecution(storePath, membrane, module);
    try {
      const created = await framework.createEphemeralAgent({
        name: 'finisher',
        model: 'test-model',
        systemPrompt: 'Finish.',
        allowedTools: 'all',
      });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'Wrap up.' }]);
      const promise = framework.runEphemeralToCompletion(created.agent, created.contextManager);
      framework.start();
      const result = await promise;

      // The script ran to completion (endTurn was deferred, not applied
      // mid-script), and the turn then ended without another model round.
      const finishCalls = module.calls.filter((c) => c.name.endsWith('--finish') || c.name === 'finish');
      assert.strictEqual(finishCalls.length, 1);
      assert.strictEqual(result.toolCallsCount, 1); // one model-visible call: code_execution
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a stopped script's late end-turn request does not end the next script's turn", async () => {
    let releaseFinish: () => void = () => {};
    const finishReleased = new Promise<void>((resolve) => { releaseFinish = resolve; });
    let finishStarted = false;
    class SlowFinishModule extends ScriptToolModule {
      override async handleToolCall(call: ToolCall): Promise<ToolResult> {
        if (call.name.endsWith('finish')) {
          finishStarted = true;
          await finishReleased;
        }
        return super.handleToolCall(call);
      }
    }
    const { tempDir, storePath } = tempStorePath('pytc-stale-endturn-');
    const framework = await createFrameworkWithCodeExecution(storePath, new MockMembrane(), new SlowFinishModule());
    const run = (input: Record<string, unknown>) =>
      framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
    framework.start();
    try {
      // The first script is stopped at its time limit while its call that ends the turn is running.
      const stopped = await run({ code: 'await test__finish({})', time_limit_ms: 1000 });
      assert.ok(finishStarted);
      assert.match((stopped.structured as { stderr: string }).stderr, /reached its 1s time limit/);
      assert.ok(!stopped.endTurn);

      // The call finishes while the next script runs; its request belonged to the stopped script.
      const next = run({ code: 'import asyncio\nawait asyncio.sleep(1)\nprint("next done")' });
      await new Promise((r) => setTimeout(r, 300));
      releaseFinish();
      const result = await next;
      assert.strictEqual((result.structured as { stdout: string }).stdout, 'next done\n');
      assert.ok(!result.endTurn, "the stopped script's request ended the next script's turn");
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// A round that runs code_execution: its script's calls count as the round's
// ---------------------------------------------------------------------------

describe("a round that runs code_execution is routed once its scripts return (real python3)", () => {
  /** echo, send_message and a `slow` tool held until the test lets it go; each call is logged. */
  class RoundToolModule implements Module {
    readonly name = 'test';
    releaseSlow: () => void = () => {};
    private slowReleased = new Promise<void>((resolve) => { this.releaseSlow = resolve; });
    constructor(private readonly log: string[]) {}
    async start(_ctx: ModuleContext): Promise<void> {}
    async stop(): Promise<void> {}
    getTools(): ToolDefinition[] {
      const tool = (name: string): ToolDefinition => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
      return [tool('echo'), tool('send_message'), tool('slow')];
    }
    async handleToolCall(call: ToolCall): Promise<ToolResult> {
      const name = call.name.includes('--') ? call.name.slice(call.name.lastIndexOf('--') + 2) : call.name;
      this.log.push(`tool:${name}`);
      // A script passes what it saw to echo as a note, for a test to read.
      const note = (call.input as { note?: unknown } | undefined)?.note;
      if (name === 'echo' && typeof note === 'string') this.log.push(`note:${note}`);
      if (name === 'slow') {
        await this.slowReleased;
        this.log.push('slow:returned');
      }
      return { success: true, data: { ok: true } };
    }
    async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
      return event.type === 'external-message'
        ? { addMessages: [{ participant: 'User', content: [{ type: 'text', text: 'go' }] }], requestInference: true }
        : {};
    }
  }

  const CHANNEL_TOOLS = [
    { name: 'skip_reply', description: 'End your turn without sending anything.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'think', description: 'Reason privately.', inputSchema: { type: 'object' as const, properties: { content: { type: 'string' } } } },
    { name: 'channel_open', description: 'Open a channel.', inputSchema: { type: 'object' as const, properties: { channelId: { type: 'string' } } } },
  ];

  async function scriptRound(mode: 'locus' | 'hybrid' | 'explicit' | 'disabled', responses: ReturnType<typeof createMockResponse>[],
    config: { sameRoundThinkTextPolicy?: 'private'; allowedTools?: string[] } = {},
    options: { codeExecution?: boolean; channelPublish?: boolean } = {}) {
    const { tempDir, storePath } = tempStorePath('pytc-round-');
    const membrane = new MockMembrane();
    for (const response of responses) membrane.pushResponse(response);
    const log: string[] = [];
    const module = new RoundToolModule(log);
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Act.', proseRouting: mode, ...config }],
      modules: [module],
      syncIntervalMs: 0,
      ...(options.codeExecution === false ? {} : { codeExecution: { enabled: true } }),
    });
    // The registry stub: skip_reply and think are on the agent's surface, so
    // its scripts get them too, and skip_reply ends the turn as the real one
    // does.
    // What each `>>` label names; a test can rename one while a script runs.
    const directory: Record<string, string> = { '#alpha': 'chan-alpha' };
    (framework as unknown as { channelRegistry: unknown }).channelRegistry = new Proxy({
      resolveLocus: () => 'world:test',
      resolveProseTarget: (spec: string) => (directory[spec] ? { channelId: directory[spec] } : { error: `no channel ${spec}` }),
      routeSpeech: async (_agent: string, text: string, channelId: string | null) => {
        if (!channelId) return null;
        log.push(`publish:${text}@${channelId}`);
        return { delivered: true, serverId: 'stub', channelId };
      },
      // A named or sticky destination posts through deliverSpeech, as with
      // the real registry, which reports the post's outcome.
      deliverSpeech: async (_agent: string, text: string, channelId: string | null) => {
        if (!channelId) return { status: 'failed', reason: 'no channel', at: Date.now() };
        log.push(`publish:${text}@${channelId}`);
        return { status: 'delivered', destination: { serverId: 'stub', channelId }, at: Date.now() };
      },
      resolveDestination: ({ channelId }: { channelId: string }) => ({ destination: { serverId: 'stub', channelId } }),
      // Each delivery hands its stream the destination its publish went to,
      // here the stub's server: a chunk for any other is logged with it, so
      // a delivery that loses its server fails the test.
      sendOutgoingChunk: (to: { serverId: string; channelId: string }, _agent: string, _id: string, _index: number, delta: string) => {
        log.push(`chunk:${delta}@${to.serverId === 'stub' ? to.channelId : `${to.channelId} (server ${to.serverId})`}`);
      },
      handleChannelToolCall: async (name: string, input: Record<string, unknown> | undefined) => {
        log.push(`tool:${name}`);
        if (name === 'skip_reply') return { success: true, endTurn: true, data: { skipped: true, note: 'Turn ended; nothing sent.' } };
        // A successful channel_open moves the turn's locus, as the real one does.
        if (name === 'channel_open') return { success: true, data: { channelId: input?.channelId } };
        return { success: true, data: {} };
      },
      getChannelTools: () => options.channelPublish
        ? [...CHANNEL_TOOLS, { name: 'channel_publish', description: 'Publish.', inputSchema: { type: 'object' as const, properties: { channelId: { type: 'string' }, content: { type: 'string' } } } }]
        : CHANNEL_TOOLS,
      getDefaultPublishChannel: () => null, isChannelOpen: () => true, getDescriptor: () => undefined,
    }, { get: (target, key: string) => (key in target ? (target as Record<string, unknown>)[key] : () => undefined) });
    const run = async () => {
      framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: { channelId: 'world:test' } } as unknown as ProcessEvent);
      await framework.runUntilIdle();
    };
    const done = async () => {
      module.releaseSlow();
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    };
    return { framework, module, log, run, done, directory, membrane };
  }

  const scriptCall = (input: Record<string, unknown>, id = 'ce1') =>
    ({ type: 'tool_use', id, name: 'code_execution', input }) as ContentBlock;
  /** The assistant's open drafts, oldest first, by their words and why each was held. */
  const heldDrafts = (framework: AgentFramework) =>
    (framework as unknown as { proseDrafts: { open(agent: string): Array<{ text: string; reason: string }> } })
      .proseDrafts.open('assistant').map((d) => ({ text: d.text, reason: d.reason })).reverse();
  // A script holds its round only when it can change the round's routing:
  // its code names such a tool (scriptMayRoute). A script given this suffix
  // names skip_reply on a line that never runs, so its round waits for it.
  const HOLDS = '\nif False: await skip_reply({})';
  // An agent whose allowedTools names only code_execution and test--echo: a
  // script reaches any other tool only by forging a call through echo's
  // globals, and the host refuses that call at dispatch.
  const LISTED = { allowedTools: ['code_execution', 'test--echo'] };
  const FORGE = 'make = test__echo.__globals__["_make_tool_fn"]\n';

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) {
    it(`${mode}: a skip_reply inside the script keeps its round's prose from delivery and the stream`, async () => {
      const prose = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: prose },
          scriptCall({ code: 'await skip_reply({})' }),
        ] as ContentBlock[], 'tool_use'),
      ]);
      try {
        await h.run();
        assert.ok(h.log.includes('tool:skip_reply'), 'the script called skip_reply');
        assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
          "the round's prose is kept, as a direct skip_reply keeps it");
      } finally { await h.done(); }
    });

    // With no EventGate, a skip_reply asking for a timed wake is refused, and
    // the turn goes on. Refused inside the script, it counts as a direct one:
    // its own round stays private, and the next round's prose is published.
    it(`${mode}: a skip_reply refused inside the script keeps only its own round private`, async () => {
      const kept = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const said = mode === 'explicit' ? '>>#alpha no timer here, so now' : 'no timer here, so now';
      const to = mode === 'explicit' ? 'chan-alpha' : 'world:test';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: kept },
          scriptCall({ code: 'await skip_reply({"wake_in_seconds": 60})' }),
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: said }] as ContentBlock[]),
      ]);
      try {
        await h.run();
        assert.ok(!h.log.includes('tool:skip_reply'), 'the host refused the call before the registry saw it');
        const published = h.log.filter((e) => e.startsWith('publish:'));
        assert.deepStrictEqual(published, [`publish:no timer here, so now@${to}`],
          "the refused call's round is kept, and the next round's prose is published");
        assert.ok(!h.log.some((e) => e.startsWith('chunk:checking quietly')), "nor does the kept round's prose stream");
      } finally { await h.done(); }
    });

    // A skip_reply the agent's allowedTools leaves out isn't among the
    // script's functions, so the script forges the call, and the host refuses
    // it at dispatch. It counts as a refused direct one does: its own round
    // stays private, and the next round's prose is published.
    it(`${mode}: a skip_reply the allowedTools refuses inside the script keeps only its own round private`, async () => {
      const kept = mode === 'explicit' ? '>>#alpha checking quietly' : 'checking quietly';
      const said = mode === 'explicit' ? '>>#alpha not mine to skip, so now' : 'not mine to skip, so now';
      const to = mode === 'explicit' ? 'chan-alpha' : 'world:test';
      const h = await scriptRound(mode, [
        createMockResponse([
          { type: 'text', text: kept },
          scriptCall({ code: `${FORGE}print(await make("skip_reply", "forged")({}))` }),
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: said }] as ContentBlock[]),
      ], LISTED);
      try {
        await h.run();
        assert.ok(!h.log.includes('tool:skip_reply'), 'the host refused the call before the registry saw it');
        const published = h.log.filter((e) => e.startsWith('publish:'));
        assert.deepStrictEqual(published, [`publish:not mine to skip, so now@${to}`],
          "the refused call's round is kept, and the next round's prose is published");
        assert.ok(!h.log.some((e) => e.startsWith('chunk:checking quietly')), "nor does the kept round's prose stream");
        assert.deepStrictEqual(heldDrafts(h.framework), [], 'and nothing is held as a draft');
      } finally { await h.done(); }
    });
  }

  // A send the agent's allowedTools leaves out posted nothing, so, refused
  // inside the script as a direct one would be, it silences nothing: its round
  // and the next are published, and nothing is held as a draft.
  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a send the allowedTools refuses inside the script silences nothing`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: `${FORGE}print(await make("test--send_message", "forged")({}))` }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], LISTED);
    try {
      await h.run();
      assert.ok(!h.log.includes('tool:send_message'), 'the host refused the send before the module saw it');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:posting the summary@world:test', 'publish:done@world:test'],
        'the round and the next are published, as with no send at all');
      assert.deepStrictEqual(heldDrafts(h.framework), [], 'and nothing is held as a draft');
    } finally { await h.done(); }
  });

  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a send inside the script silences its round and the turn's later prose`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await test__send_message({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the script sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        'the send silences the round and what follows, as a direct send does');
      assert.deepStrictEqual(heldDrafts(h.framework), [
        { text: 'posting the summary', reason: 'explicit-send' },
        { text: 'done', reason: 'explicit-send' },
      ], 'and holds their words as drafts, as a direct send does');
    } finally { await h.done(); }
  });

  // A drafts resend is an explicit send, so it silences its round as
  // send_message does: called from the round's script too. This one names a
  // draft there isn't, so it's refused and sends nothing, as a direct one
  // would be, and still counts, as a direct one does.
  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a drafts resend inside the script holds its round and the turn's later prose as drafts`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'sending the earlier reply again' },
        scriptCall({ code: 'print(await drafts({"action": "resend", "draftIds": ["d-0000000"], "destination": "#alpha"}))' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        'the resend silences the round and what follows, as a direct resend does');
      assert.deepStrictEqual(heldDrafts(h.framework), [
        { text: 'sending the earlier reply again', reason: 'explicit-send' },
        { text: 'done', reason: 'explicit-send' },
      ], 'and their words are held as drafts');
    } finally { await h.done(); }
  });

  // skip_reply's privacy outranks a send's hold, as for direct calls: a
  // round whose script calls both keeps its prose private, and holds no draft.
  for (const mode of ['locus', 'hybrid'] as const) it(`${mode}: a script that sends and calls skip_reply keeps its round's prose private, with no draft`, async () => {
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: 'posting the summary, then going quiet' },
        scriptCall({ code: 'await test__send_message({})\nawait skip_reply({})' }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message') && h.log.includes('tool:skip_reply'), 'the script sent and skipped');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [], 'nothing is published');
      assert.deepStrictEqual(heldDrafts(h.framework), [], 'and the round is kept private, not held as a draft');
    } finally { await h.done(); }
  });

  it("explicit: a send inside the script silences neither its round nor the turn's later prose, as a direct send doesn't", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: '>>#alpha posting the summary' },
        scriptCall({ code: 'await test__send_message({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>#alpha done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the script sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [
        'publish:posting the summary@chan-alpha', 'chunk:posting the summary@chan-alpha',
        'publish:done@chan-alpha', 'chunk:\n\ndone@chan-alpha',
      ], "explicit mode's prefixed prose is deliberate, so a send doesn't silence it");
    } finally { await h.done(); }
  });

  for (const mode of ['locus', 'hybrid', 'explicit'] as const) it(`${mode}: a think inside the script holds its round back under the private same-round policy`, async () => {
    const prefix = mode === 'explicit' ? '>>#alpha ' : '';
    const target = mode === 'explicit' ? 'chan-alpha' : 'world:test';
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: `${prefix}working it through` },
        scriptCall({ code: 'await think({"content": "notes"})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: `${prefix}the answer` }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the script called think');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [`publish:the answer@${target}`],
        'the round beside the think stays private, as with a direct think, and the next round is delivered');
    } finally { await h.done(); }
  });

  it("the round's prose goes out once its script returns, not after a slow tool beside it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'on it' },
        scriptCall({ code: 'print(await test__echo({}))' + HOLDS }),
        { type: 'tool_use', id: 'slow1', name: 'test--slow', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Let the slow tool go once the round's prose has gone out, or after a
    // bound, so a round that waited for it still ends and fails the order.
    const watch = setInterval(() => { if (h.log.includes('publish:on it@world:test')) h.module.releaseSlow(); }, 10);
    // The bound only matters when the code is wrong: a round that waited
    // for the slow tool still ends, and fails the order.
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:on it@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('tool:echo') < at('publish:on it@world:test'), "it waited for the script's own call");
      assert.ok(at('publish:on it@world:test') < at('slow:returned'), 'and not for the slow tool beside it');
      assert.ok(at('publish:on it@world:test') < at('chunk:on it@world:test'), 'and its chunk followed its publish');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a script whose code names no tool that changes routing doesn't hold its round: its prose goes out while the script runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The script waits in its slow call until the round's prose has gone out,
    // or until a bound, so a round that waited for the script still ends.
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  /** Runs a one-script round whose prose should go out while its script waits in a slow call. */
  const publishedWhileScriptRuns = async (mode: 'locus' | 'explicit', code: string) => {
    const prefix = mode === 'explicit' ? '>>#alpha ' : '';
    const target = mode === 'explicit' ? 'chan-alpha' : 'world:test';
    const h = await scriptRound(mode, [
      createMockResponse([
        { type: 'text', text: `${prefix}running the analysis` },
        scriptCall({ code }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: `${prefix}done` }] as ContentBlock[]),
    ]);
    const published = `publish:running the analysis@${target}`;
    const watch = setInterval(() => { if (h.log.includes(published)) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at(published) >= 0, 'the prose was delivered');
      assert.ok(at(published) < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  };

  it("a name inside a longer identifier, as say_hello or my_say, doesn't hold its round", async () => {
    await publishedWhileScriptRuns('locus', 'say_hello = 1\nmy_say = 2\nsend_message_log = []\nawait test__slow({})');
  });

  it("a comment that names a routing tool doesn't hold its round, since Python never runs it", async () => {
    await publishedWhileScriptRuns('locus', 'await test__slow({})  # then skip_reply, or say so');
  });

  it("explicit: a script that names only a send doesn't hold its round, since a send can't change an explicit round's routing", async () => {
    await publishedWhileScriptRuns('explicit', 'await test__slow({})\nif False: await test__send_message({})');
  });

  it("disabled: a script that names skip_reply doesn't hold its round, since nothing is routed", async () => {
    const h = await scriptRound('disabled', [
      createMockResponse([
        { type: 'text', text: 'never routed' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
    let waitedOn: boolean | undefined;
    const watch = setInterval(() => {
      if (!h.log.includes('tool:slow')) return;
      clearInterval(watch);
      waitedOn = rounds.has('assistant');
      h.module.releaseSlow();
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.equal(waitedOn, false, 'no round waited on the script');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [], 'and nothing was published');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a script whose code names a world utterance, as say, holds its round until it returns", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'about to speak' },
        scriptCall({ code: 'await test__slow({})\nif False: await mcpl__world__say({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Once the script is in its slow call, a round routed at its tool-calls
    // event has had its delivery queued long before; with the agent's queued
    // deliveries run, the round must still be unpublished. Then the call goes.
    let publishedWhileRunning: boolean | undefined;
    let checking = false;
    const watch = setInterval(() => {
      if (checking || !h.log.includes('tool:slow')) return;
      checking = true;
      const queued = (h.framework as unknown as { proseSpeechChains: Map<string, Promise<void>> }).proseSpeechChains.get('assistant');
      void Promise.resolve(queued).then(() => {}, () => {}).then(() => {
        publishedWhileRunning = h.log.includes('publish:about to speak@world:test');
        h.module.releaseSlow();
      });
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.equal(publishedWhileRunning, false, "the round wasn't published while its script ran");
      assert.ok(at('slow:returned') < at('publish:about to speak@world:test'), 'it went out once the script had returned');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a tool name a script builds at runtime goes unseen: its round is routed at its tool-calls event, as before scripts counted", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not held' },
        scriptCall({ code: 'name = "skip" + "_reply"\nawait tools[name]({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('tool:skip_reply') >= 0, 'the script called skip_reply by a name it built');
      assert.ok(at('publish:not held@world:test') >= 0,
        "the round was published anyway: its code names no tool that changes routing, so it didn't wait for the skip_reply that would have kept it back");
    } finally { await h.done(); }
  });

  it("under the public same-round policy, a script that calls think doesn't hold its round", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'thinking it over' },
        scriptCall({ code: 'await think({"content": "notes"})\nawait test__slow({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:thinking it over@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:thinking it over@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:thinking it over@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("without code execution, a code_execution call holds nothing: its round is routed at its tool-calls event", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'not a script after all' },
        scriptCall({ code: 'await skip_reply({})' }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], {}, { codeExecution: false });
    try {
      await h.run();
      assert.ok(h.log.includes('publish:not a script after all@world:test'),
        "the call is answered as an unknown tool, whose result settles no round, so the round doesn't wait for it");
    } finally { await h.done(); }
  });

  it("a helper an earlier script defined holds a later script's round: the interpreter ran a script that names a tool that changes routing", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await post()' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the helper sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:defining a helper@world:test'],
        "the send through the helper silences its round and the turn's later prose, as a direct send does");
    } finally { await h.done(); }
  });

  it("a script that only calls a routing tool directly, by name or by key, leaves no mark: a later script's round isn't held for it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'thinking first' },
        scriptCall({ code: 'await think({"content": "notes"})\nawait tools["think"]({"content": "more"})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(!h.log.includes('publish:thinking first@world:test'), 'the round whose script thought stays private');
      assert.ok(at('publish:running the analysis@world:test') >= 0, "the later round's prose was delivered");
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while its script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a key an earlier script kept holds a later script's round, as an alias does", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'keeping a key' },
        scriptCall({ code: 'name = "test--send_message"' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await tools[name]({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the kept key sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:keeping a key@world:test'],
        "the send through the kept key silences its round and the turn's later prose, as a direct send does");
    } finally { await h.done(); }
  });

  it("an alias an earlier script bound to a routing tool holds a later script's round, as a helper does", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'keeping a handle' },
        scriptCall({ code: 'post = test__send_message' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'posting the summary' },
        scriptCall({ code: 'await post({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:send_message'), 'the alias sent');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:keeping a handle@world:test'],
        "the send through the alias silences its round and the turn's later prose, as a direct send does");
    } finally { await h.done(); }
  });

  /** The agent's interpreter mark: the names it holds, or undefined when there is none. */
  const markOf = (framework: AgentFramework) => {
    const mark = (framework as unknown as { scriptRoutingInterpreters: Map<string, { names: Set<string> }> })
      .scriptRoutingInterpreters.get('assistant');
    return mark && [...mark.names].sort();
  };

  it("a script that calls a routing tool directly, beside a definition that doesn't use it, leaves no mark", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'formatting notes' },
        scriptCall({ code: 'def fmt(x):\n    return x.upper()\nawait think({"content": fmt("notes")})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the script thought');
      assert.equal(markOf(h.framework), undefined, 'fmt can still be called, but it reaches no routing tool');
    } finally { await h.done(); }
  });

  it('a later mark in the same interpreter adds its names to the earlier ones', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'keeping a handle' },
        scriptCall({ code: 't = think' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(markOf(h.framework), ['send_message', 'think'], 'the helper the first script left is still there');
    } finally { await h.done(); }
  });

  it('a script the busy runner refuses leaves no mark, though its code would have', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'two scripts at once' },
        scriptCall({ code: 'await test__slow({})' }, 'ce1'),
        scriptCall({ code: 'post = test__send_message' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      // The control: the same script, run alone, marks.
      createMockResponse([
        { type: 'text', text: 'now alone' },
        scriptCall({ code: 'post = test__send_message' }, 'ce3'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // Let the first script go once the second's refusal has come back, and
    // read the mark once the first has finished, before the control runs.
    const results: string[] = [];
    let markAfterRefusal: string[] | undefined = ['unread'];
    h.framework.onTrace((event) => {
      if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') {
        results.push(event.callId);
        if (event.callId === 'ce2') h.module.releaseSlow();
        if (event.callId === 'ce1') markAfterRefusal = markOf(h.framework);
      }
    });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(results, ['ce2', 'ce1', 'ce3'], "the second script was refused while the first ran");
      assert.equal(markAfterRefusal, undefined, 'the refused alias never ran, so it marked nothing');
      assert.deepStrictEqual(markOf(h.framework), ['send_message'], 'the same script, run alone, marks');
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a mark left in an earlier interpreter doesn't hold a round once a newer interpreter runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'starting fresh' },
        scriptCall({ code: 'x = 1' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }, 'ce3'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The helper's interpreter is reclaimed once its script returns; the next
    // script starts a newer one, which is live when the third round is decided.
    h.framework.onTrace((event) => {
      if (event.type === 'tool:completed' && event.callId === 'ce1') {
        const runner = (h.framework as unknown as { codeExecutionRunners: Map<string, { reclaim(why: string): void }> })
          .codeExecutionRunners.get('assistant')!;
        runner.reclaim('test');
      }
    });
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the third round was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while its script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("under the public same-round policy, a helper that calls think doesn't hold a later script's round", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def note():\n    await think({"content": "notes"})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await note()\nawait test__slow({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(h.log.includes('tool:think'), 'the helper thought');
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("under the private same-round policy, a helper that calls think holds a later script's round back", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def note():\n    await think({"content": "notes"})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'working it through' },
        scriptCall({ code: 'await note()' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'the answer' }] as ContentBlock[]),
    ], { sameRoundThinkTextPolicy: 'private' });
    try {
      await h.run();
      assert.ok(h.log.includes('tool:think'), 'the helper thought');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')),
        ['publish:defining a helper@world:test', 'publish:the answer@world:test'],
        'the round whose helper thought stays private, as with a direct think, and the rounds around it are delivered');
    } finally { await h.done(); }
  });

  it("once the interpreter is reclaimed, a script that names no such tool doesn't hold its round, since the helpers went with it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'defining a helper' },
        scriptCall({ code: 'async def post():\n    await test__send_message({})' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([
        { type: 'text', text: 'running the analysis' },
        scriptCall({ code: 'await test__slow({})' }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The interpreter that ran the helper's script is reclaimed once that
    // script returns, as an idle reclaim or a restart would.
    h.framework.onTrace((event) => {
      if (event.type === 'tool:completed' && event.callId === 'ce1') {
        const runner = (h.framework as unknown as { codeExecutionRunners: Map<string, { reclaim(why: string): void }> })
          .codeExecutionRunners.get('assistant')!;
        runner.reclaim('test');
      }
    });
    const watch = setInterval(() => { if (h.log.includes('publish:running the analysis@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:running the analysis@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:running the analysis@world:test') < at('slow:returned'), 'while the script was still running');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a background script's round is routed as soon as the script starts", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'starting a watcher' },
        scriptCall({ code: 'import asyncio\nawait asyncio.sleep(30)', background: true }),
        { type: 'tool_use', id: 'slow1', name: 'test--slow', input: {} },
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const watch = setInterval(() => { if (h.log.includes('publish:starting a watcher@world:test')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('publish:starting a watcher@world:test') >= 0, 'the prose was delivered');
      assert.ok(at('publish:starting a watcher@world:test') < at('slow:returned'), 'without waiting for the slow tool');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a round with two code_execution calls waits for both: the second is refused at once, and the first's later skip_reply still counts", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'two scripts at once' },
        scriptCall({ code: 'await test__slow({})\nawait skip_reply({})' }, 'ce1'),
        scriptCall({ code: 'print("second")' + HOLDS }, 'ce2'),
      ] as ContentBlock[], 'tool_use'),
    ]);
    // Let the first script go once the second's refusal has come back.
    const results: string[] = [];
    h.framework.onTrace((event) => {
      if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') {
        results.push(event.callId);
        if (event.callId === 'ce2') h.module.releaseSlow();
      }
    });
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(results, ['ce2', 'ce1'], "the second script's refusal came back while the first ran");
      assert.ok(h.log.includes('tool:skip_reply'), "the first script's skip_reply ran");
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "the round waited for the first script, so its skip_reply kept the round's prose");
    } finally {
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a background script's calls aren't its round's, even while a foreground script in the round runs", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'still mine to say' },
        scriptCall({ code: 'await test__send_message({})', background: true }, 'bg'),
        scriptCall({ code: 'await test__slow({})' + HOLDS }, 'fg'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // The foreground script holds the round open until the background send has run.
    const watch = setInterval(() => { if (h.log.includes('tool:send_message')) h.module.releaseSlow(); }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      const at = (entry: string) => h.log.indexOf(entry);
      assert.ok(at('tool:send_message') >= 0 && at('tool:send_message') < at('slow:returned'),
        'the background send ran while the round waited on its foreground script');
      assert.ok(h.log.includes('publish:still mine to say@world:test'), "the background send didn't silence the round");
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  // A surface message names a channel, or names none and opens a private turn.
  const surface = (channelId?: string) => ({
    type: 'external-message', source: channelId ? 'bridge' : 'tui', content: 'go', metadata: channelId ? { channelId } : {},
  }) as unknown as ProcessEvent;
  // A private turn's refusal of a channel_publish that names no channel.
  const REFUSED = 'channel_publish requires an explicit channelId';
  // A background watcher: it waits on the slow tool, which a test releases,
  // then publishes naming no channel, and passes the publish's answer to echo.
  const WATCHER = [
    'await test__slow({})',
    'r = await channel_publish({"content": "from the watcher"})',
    'await test__echo({"note": str(r)})',
  ].join('\n');
  type ScriptHarness = Awaited<ReturnType<typeof scriptRound>>;
  type Routing = { nonChannelOrigin?: boolean; triggerChannel?: string };
  const routingInternals = (h: ScriptHarness) => h.framework as unknown as {
    turnRouting: Map<string, Routing>; openLogical: Map<string, unknown>;
  };
  /** Releases the slow tool and runs the framework until every background
   *  script has settled: a script's calls come back as events, which the
   *  test's own runs of the framework process. */
  async function settleWatchers(h: ScriptHarness): Promise<void> {
    const scripts = (h.framework as unknown as { backgroundScripts: Map<string, { status: string }> }).backgroundScripts;
    assert.ok(scripts.size > 0, 'control: a watcher started');
    h.module.releaseSlow();
    for (const deadline = Date.now() + 15_000; [...scripts.values()].some((s) => s.status === 'running');) {
      if (Date.now() > deadline) throw new Error(`the watcher never settled: ${JSON.stringify(h.log)}`);
      await new Promise((r) => setTimeout(r, 25));
      await h.framework.runUntilIdle();
    }
    assert.ok(h.log.includes('slow:returned'), 'control: the watcher was released');
  }
  /** What the watcher's publish answered, as it passed it to echo. */
  const watcherNote = (h: ScriptHarness): string => {
    const note = h.log.find((entry) => entry.startsWith('note:'));
    assert.ok(note !== undefined, `control: the watcher ran to its end: ${JSON.stringify(h.log)}`);
    return note!;
  };

  for (const startedPrivate of [true, false]) {
    it(`a background script's channel_publish is judged by the turn that started it, not by a later ${startedPrivate ? 'channel' : 'private'} turn`, async () => {
      const h = await scriptRound('locus', [
        createMockResponse([scriptCall({ code: WATCHER, background: true }, 'bg')] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'watching' }] as ContentBlock[]),
      ], {}, { channelPublish: true });
      const internals = routingInternals(h);
      try {
        h.framework.pushEvent(surface(startedPrivate ? undefined : 'world:test'));
        await h.framework.runUntilIdle();
        const startRouting = internals.turnRouting.get('assistant');
        // Queued only now: a mock stream takes every response queued when it starts.
        h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the later turn' }] as ContentBlock[]));
        h.framework.pushEvent(surface(startedPrivate ? 'world:test' : undefined));
        await h.framework.runUntilIdle();
        const later = internals.turnRouting.get('assistant');
        assert.ok(later && later !== startRouting, 'control: the later turn ran');
        assert.equal(later!.nonChannelOrigin === true, !startedPrivate, `control: the later turn is ${startedPrivate ? 'a channel' : 'a private'} one`);
        assert.equal(h.log.includes('publish:the later turn@world:test'), startedPrivate, `control: ${JSON.stringify(h.log)}`);
        await settleWatchers(h);
        assert.equal(watcherNote(h).includes(REFUSED), startedPrivate, watcherNote(h));
        assert.equal(h.log.includes('tool:channel_publish'), !startedPrivate, JSON.stringify(h.log));
      } finally {
        await h.done();
      }
    });
  }

  for (const startedPrivate of [true, false]) {
    it(`a background script's channel_open records on the turn that started it, not on a later ${startedPrivate ? 'channel' : 'private'} turn`, async () => {
      const watcher = 'await test__slow({})\nawait channel_open({"channelId": "world:other"})';
      const h = await scriptRound('locus', [
        createMockResponse([scriptCall({ code: watcher, background: true }, 'bg')] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'watching' }] as ContentBlock[]),
      ]);
      const internals = routingInternals(h);
      try {
        h.framework.pushEvent(surface(startedPrivate ? undefined : 'world:test'));
        await h.framework.runUntilIdle();
        const startRouting = internals.turnRouting.get('assistant')!;
        h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'the later turn' }] as ContentBlock[]));
        h.framework.pushEvent(surface(startedPrivate ? 'world:test' : undefined));
        await h.framework.runUntilIdle();
        const later = internals.turnRouting.get('assistant')!;
        assert.ok(later !== startRouting, 'control: the later turn ran');
        const laterTrigger = later.triggerChannel;
        await settleWatchers(h);
        assert.ok(h.log.includes('tool:channel_open'), `control: the watcher opened the channel: ${JSON.stringify(h.log)}`);
        assert.equal(later.triggerChannel, laterTrigger, "the later turn's trigger channel stays as it was");
        assert.equal(startRouting.triggerChannel === 'world:other', !startedPrivate,
          `the turn that started the script records it, unless that turn is private: ${startRouting.triggerChannel}`);
        assert.notEqual((startRouting as { locus?: string }).locus, 'world:other', "the ended turn's locus stays as it was");
      } finally {
        await h.done();
      }
    });
  }

  it("a background script's channel_open moves the locus of the turn that started it while that turn is open", async () => {
    const watcher = 'await test__slow({})\nawait channel_open({"channelId": "world:other"})';
    const h = await scriptRound('locus', [
      createMockResponse([scriptCall({ code: watcher, background: true }, 'bg')] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'watching' }] as ContentBlock[]),
    ]);
    const internals = h.framework as unknown as {
      turnRouting: Map<string, Routing & { locus?: string }>; openLogical: Map<string, unknown>; lastAnnouncedLocus: Map<string, string | null>;
    };
    try {
      h.framework.pushEvent(surface('world:test'));
      await h.framework.runUntilIdle();
      const startRouting = internals.turnRouting.get('assistant')!;
      assert.equal(startRouting.locus, 'world:test', "control: the turn's locus is its room");
      // The turn is still open, between its streams, when the open lands.
      internals.openLogical.set('assistant', startRouting);
      await settleWatchers(h);
      assert.equal(startRouting.locus, 'world:other', "the open moves the open turn's locus");
      assert.equal(internals.lastAnnouncedLocus.get('assistant'), 'world:other', 'and announces it');
    } finally {
      internals.openLogical.delete('assistant');
      await h.done();
    }
  });

  it("a model's script started in a silent tick's stream is judged by the tick's own turn, not by a private turn held open beside it", async () => {
    const code = 'r = await channel_publish({"content": "from the tick"})\nawait test__echo({"note": str(r)})';
    const h = await scriptRound('locus', [createMockResponse([{ type: 'text', text: 'private words' }] as ContentBlock[])], {}, { channelPublish: true });
    const internals = routingInternals(h);
    try {
      h.framework.pushEvent(surface());
      await h.framework.runUntilIdle();
      const privateRouting = internals.turnRouting.get('assistant')!;
      assert.equal(privateRouting.nonChannelOrigin, true, 'control: a private turn ran');
      // The private turn is held open, between its streams, and a silent
      // heartbeat tick starts beside it.
      internals.openLogical.set('assistant', privateRouting);
      h.membrane.pushResponse(createMockResponse([scriptCall({ code }, 'tick-ce')] as ContentBlock[], 'tool_use'));
      h.membrane.pushResponse(createMockResponse([{ type: 'text', text: 'silent words' }] as ContentBlock[]));
      (h.framework as unknown as { pendingRequests: unknown[] }).pendingRequests.push({
        agentName: 'assistant', reason: 'mcpl:push-event', source: 'heartbeat', timestamp: Date.now(), suppressProse: true,
      });
      await h.framework.runUntilIdle();
      const tick = internals.turnRouting.get('assistant')!;
      assert.ok(tick !== privateRouting && tick.nonChannelOrigin !== true, 'control: the tick ran with its own routing');
      assert.ok(!watcherNote(h).includes(REFUSED), watcherNote(h));
      assert.ok(h.log.includes('tool:channel_publish'), JSON.stringify(h.log));
    } finally {
      internals.openLogical.delete('assistant');
      await h.done();
    }
  });

  for (const privateTurn of [true, false]) {
    it(`a foreground script's channel_publish naming no channel is judged by its own ${privateTurn ? 'private' : 'channel'} turn`, async () => {
      const code = 'r = await channel_publish({"content": "from the script"})\nawait test__echo({"note": str(r)})';
      const h = await scriptRound('locus', [
        createMockResponse([scriptCall({ code })] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
      ], {}, { channelPublish: true });
      try {
        h.framework.pushEvent(surface(privateTurn ? undefined : 'world:test'));
        await h.framework.runUntilIdle();
        assert.equal(watcherNote(h).includes(REFUSED), privateTurn, watcherNote(h));
        assert.equal(h.log.includes('tool:channel_publish'), !privateTurn, JSON.stringify(h.log));
      } finally {
        await h.done();
      }
    });
  }

  it("a script that a call made as the agent starts outside any turn is judged by no turn, whatever turn the caller put on the call", async () => {
    const h = await scriptRound('locus', [createMockResponse([{ type: 'text', text: 'private words' }] as ContentBlock[])], {}, { channelPublish: true });
    const internals = routingInternals(h);
    try {
      h.framework.pushEvent(surface());
      await h.framework.runUntilIdle();
      assert.equal(internals.turnRouting.get('assistant')?.nonChannelOrigin, true, "control: the agent's latest turn was private");
      assert.equal(internals.openLogical.has('assistant'), false, 'control: and it has ended');
      // A caller may put a turn on the call (ToolCall.callerTurnId).
      const started = await h.framework.executeToolCall({
        id: 'host-bg', name: 'code_execution', input: { code: WATCHER, background: true }, callerAgentName: 'assistant', callerTurnId: 1,
      } as never);
      assert.equal(started.success, true, JSON.stringify(started));
      await settleWatchers(h);
      assert.ok(!watcherNote(h).includes(REFUSED), watcherNote(h));
      assert.ok(h.log.includes('tool:channel_publish'), JSON.stringify(h.log));
    } finally {
      await h.done();
    }
  });

  it("a script that a call made as the agent starts outside any turn records its channel_open on no turn", async () => {
    const watcher = [
      'await test__slow({})',
      'r = await channel_open({"channelId": "world:other"})',
      'await test__echo({"note": ("error: " if r.is_error else "ok: ") + str(r)})',
    ].join('\n');
    const h = await scriptRound('locus', [createMockResponse([{ type: 'text', text: 'room words' }] as ContentBlock[])]);
    const internals = routingInternals(h);
    try {
      h.framework.pushEvent(surface('world:test'));
      await h.framework.runUntilIdle();
      const latest = internals.turnRouting.get('assistant')!;
      assert.equal(latest.triggerChannel, 'world:test', "control: the agent's latest turn was the room's");
      assert.equal(internals.openLogical.has('assistant'), false, 'control: and it has ended');
      const started = await h.framework.executeToolCall({
        id: 'host-bg', name: 'code_execution', input: { code: watcher, background: true }, callerAgentName: 'assistant',
      } as never);
      assert.equal(started.success, true, JSON.stringify(started));
      await settleWatchers(h);
      assert.ok(h.log.includes('tool:channel_open'), `control: the watcher opened the channel: ${JSON.stringify(h.log)}`);
      assert.ok(watcherNote(h).startsWith('note:ok: ') && watcherNote(h).includes('world:other'), `the script's open succeeded: ${watcherNote(h)}`);
      assert.equal(latest.triggerChannel, 'world:test', "the latest turn's trigger channel stays its own");
    } finally {
      await h.done();
    }
  });

  it("a script that a call made as the agent starts while a private turn is open keeps that turn's rule after it ends, whatever the live routing and the call's turn", async () => {
    const h = await scriptRound('locus', [createMockResponse([{ type: 'text', text: 'private words' }] as ContentBlock[])], {}, { channelPublish: true });
    const internals = routingInternals(h);
    try {
      h.framework.pushEvent(surface());
      await h.framework.runUntilIdle();
      const privateRouting = internals.turnRouting.get('assistant')!;
      assert.equal(privateRouting.nonChannelOrigin, true, 'control: a private turn ran');
      // The private turn is open, and a silent tick that ran beside it left
      // its own routing as the agent's live one.
      internals.openLogical.set('assistant', privateRouting);
      internals.turnRouting.set('assistant', { ...privateRouting, nonChannelOrigin: false });
      const started = await h.framework.executeToolCall({
        id: 'host-bg', name: 'code_execution', input: { code: WATCHER, background: true }, callerAgentName: 'assistant', callerTurnId: 1,
      } as never);
      assert.equal(started.success, true, JSON.stringify(started));
      internals.openLogical.delete('assistant');
      await settleWatchers(h);
      assert.ok(watcherNote(h).includes(REFUSED), watcherNote(h));
      assert.ok(!h.log.includes('tool:channel_publish'), JSON.stringify(h.log));
    } finally {
      await h.done();
    }
  });

  it("locus: a script round's prose goes to the locus it was written for, though the script opens another channel", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'for the room I was in' },
        scriptCall({ code: 'await channel_open({"channelId": "chan-other"})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'now over here' }] as ContentBlock[]),
    ]);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), [
        'publish:for the room I was in@world:test',
        'publish:now over here@chan-other',
      ], 'the open moves later prose, not the round written before it');
    } finally { await h.done(); }
  });

  it("an ephemeral disposed while its round's script runs doesn't publish the round when the script returns", async () => {
    const h = await scriptRound('locus', []);
    const membrane = (h.framework as unknown as { membrane: MockMembrane }).membrane;
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'never decided' },
      scriptCall({ code: 'await test__slow({})' + HOLDS }),
    ] as ContentBlock[], 'tool_use'));
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    try {
      const created = await h.framework.createEphemeralAgent({ name: 'eph-script', model: 'test-model', systemPrompt: 'Act.', allowedTools: 'all' });
      created.contextManager.addMessage('user', [{ type: 'text', text: 'go' }]);
      // The idle watchdog disposes the ephemeral while its script waits in the
      // slow call. Its threshold is too long for python3's start to trip it, so
      // the run is made to look idle only once the script is in the slow call,
      // and the next poll disposes it.
      const run = h.framework.runEphemeralToCompletion(created.agent, created.contextManager, { ...UNREACHED_WATCHDOG, startupTimeoutMs: 15000 });
      const stalled = assert.rejects(run, /stalled/);
      h.framework.start();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !h.log.includes('tool:slow')) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.log.includes('tool:slow'), 'the script reached the slow call');
      silenceRun(h.framework, created.agent.name);
      await stalled;
      // The script now returns, and its result arrives with the framework still running.
      let resulted!: () => void;
      const result = new Promise<void>((resolve) => { resulted = resolve; });
      h.framework.onTrace((event) => {
        if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') resulted();
      });
      h.module.releaseSlow();
      await result;
      await h.framework.runUntilIdle();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "the round's routing was never decided, so the late result publishes nothing");
      assert.ok(lines.some((line) => line.includes('eph-script: round [code_execution] -> 1 prose segment(s) withheld: its stream ended before its scripts returned')),
        "the disposed ephemeral's stream withheld the round as it ended");
    } finally {
      console.error = error;
      await h.done();
    }
  });

  // Each way a stream can stop owning its round while the round's script runs:
  // the agent stops waiting on it, is deregistered, or moves to a newer stream.
  const leaveRound: Record<string, (framework: AgentFramework, agent: { reset(): void }) => void> = {
    'its agent is reset': (_framework, agent) => agent.reset(),
    'its agent is deregistered': (framework) => {
      (framework as unknown as { agents: Map<string, unknown> }).agents.delete('assistant');
    },
    'its agent moves to a newer stream': (_framework, agent) => {
      (agent as unknown as { _streamId: number })._streamId++;
    },
  };
  for (const [how, leave] of Object.entries(leaveRound)) it(`a round is withheld when its script returns if, meanwhile, ${how}`, async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'never decided' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    let stream: { cancel(): void } | undefined;
    let agent: { state: { stream?: { cancel(): void } }; reset(): void } | undefined;
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: { channelId: 'world:test' } } as unknown as ProcessEvent);
      void h.framework.runUntilIdle().catch(() => {});
      const started = Date.now();
      while (!h.log.includes('tool:slow') && Date.now() - started < 15000) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.log.includes('tool:slow'), 'the script reached its slow call');
      // The turn's routing state, whose receipt counts what the turn suppressed.
      const routing = (h.framework as unknown as { turnRouting: Map<string, { suppressed: number; drafts: unknown[] }> }).turnRouting.get('assistant')!;
      const suppressedBefore = routing.suppressed;
      // The stream no longer owns the round, while it lives on.
      agent = h.framework.getAgent('assistant')! as unknown as { state: { stream?: { cancel(): void } }; reset(): void };
      stream = agent.state.stream;
      leave(h.framework, agent);
      let resulted!: () => void;
      const result = new Promise<void>((resolve) => { resulted = resolve; });
      h.framework.onTrace((event) => {
        if ((event.type === 'tool:completed' || event.type === 'tool:failed') && event.tool === 'code_execution') resulted();
      });
      h.module.releaseSlow();
      await result;
      const until = Date.now() + 15000;
      while (Date.now() < until && !lines.some((line) => line.includes('prose segment(s) withheld'))) await new Promise((r) => setTimeout(r, 10));
      assert.ok(lines.some((line) => line.includes('assistant: round [code_execution] -> 1 prose segment(s) withheld: its turn no longer waits on it')),
        'the script result found the round undecidable and withheld it');
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [], 'and published nothing');
      assert.equal(routing.suppressed, suppressedBefore + 1, "and the turn's receipt counts the withheld segment as suppressed");
      assert.deepStrictEqual(routing.drafts, [], 'and holds none of it as a draft, since the script might have kept it private');
    } finally {
      console.error = error;
      stream?.cancel();
      // The departures are simulated, without the bookkeeping a real one does:
      // a real deregistration also clears the name's active stream, and a real
      // newer stream takes that entry over and clears it when it ends. Clear
      // it and settle the agent, so the loop this test started finds the
      // framework idle and the file can exit.
      (h.framework as unknown as { activeStreams: Map<string, unknown> }).activeStreams.delete('assistant');
      agent?.reset();
      await h.done();
    }
  });

  it("a round whose stream is stopped before its script returns is withheld", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'never decided' },
        scriptCall({ code: 'await test__slow({})\nawait skip_reply({})' }),
      ] as ContentBlock[], 'tool_use'),
    ]);
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); error(...args); };
    try {
      h.framework.pushEvent({ type: 'external-message', source: 'test', content: 'go', metadata: { channelId: 'world:test' } } as unknown as ProcessEvent);
      void h.framework.runUntilIdle().catch(() => {});
      // The script is running, held in its slow call.
      const started = Date.now();
      while (!h.log.includes('tool:slow') && Date.now() - started < 15000) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.log.includes('tool:slow'), 'the script reached its slow call');
      await h.framework.stop();
      h.module.releaseSlow();
      await new Promise((r) => setTimeout(r, 50));
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:') || e.startsWith('chunk:')), [],
        "whether the script would have silenced the round is unknown, so its prose isn't sent");
      assert.ok(lines.some((line) => line.includes('1 prose segment(s) withheld: its stream ended before its scripts returned')),
        'and the withheld round is logged, not dropped silently');
    } finally {
      console.error = error;
      await h.done();
    }
  });

  /** A pending round of another stream, as scriptRounds holds one: it records what it was asked to do. */
  const pendingRound = (agent: unknown, pending: string[] = ['elsewhere']) => {
    const asked: string[] = [];
    return {
      asked,
      round: {
        agent, streamId: -1, scripts: new Map<string, string[]>(), pending: new Set(pending),
        route: () => { asked.push('route'); },
        withhold: (why: string) => { asked.push(`withhold: ${why}`); },
      },
    };
  };

  it("a script's result settles only the round that dispatched it, though a newer round waits on the same call id", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the first round' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
    // While the script runs, a newer round comes to wait under the name on a
    // call with the same id, as a provider that reuses ids could make one.
    const newer = pendingRound(h.framework.getAgent('assistant'), ['ce1']);
    let swapped = false;
    const watch = setInterval(() => {
      if (!h.log.includes('tool:slow')) return;
      clearInterval(watch);
      rounds.set('assistant', newer.round);
      swapped = true;
      h.module.releaseSlow();
    }, 10);
    // A script that never reaches its slow call still ends, and fails below.
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.ok(swapped, 'the newer round came to wait while the script ran');
      assert.deepStrictEqual(newer.asked, [], "the first round's result doesn't settle the newer round");
      assert.equal(rounds.get('assistant'), newer.round, 'which still waits');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });

  it("a newer round that doesn't wait displaces an older waiting round, so a call of its own with the same id can't settle it", async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the newer round' },
        scriptCall({ code: 'print("quick")' }, 'ce1'),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    // An older round of another stream still waits on a call with the same
    // id, as a provider that reuses ids could leave one.
    const older = pendingRound({}, ['ce1']);
    (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds.set('assistant', older.round);
    try {
      await h.run();
      assert.deepStrictEqual(older.asked, ['withhold: a newer round replaced it before its scripts returned'],
        "the older round is withheld, and the newer round's result settles nothing of it");
      assert.ok(h.log.includes('publish:the newer round@world:test'), 'and the newer round is routed at once');
    } finally { await h.done(); }
  });

  it('a round registered while another waits under the same agent name withholds the older one', async () => {
    const h = await scriptRound('locus', [
      createMockResponse([
        { type: 'text', text: 'the newer round' },
        scriptCall({ code: 'print("quick")' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
    ]);
    const older = pendingRound({});
    (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds.set('assistant', older.round);
    try {
      await h.run();
      assert.deepStrictEqual(older.asked, ['withhold: a newer round replaced it before its scripts returned'],
        'the older round is withheld, not overwritten silently');
      assert.ok(h.log.includes('publish:the newer round@world:test'), 'and the newer round is routed as usual');
    } finally { await h.done(); }
  });

  // A successor's round comes to wait under the agent's name while this stream
  // runs: one of another agent object of the name, or one of the same agent
  // object's later stream (a restart overlapping this one).
  for (const whose of ['another agent object', "the same agent object's later stream"] as const) {
    it(`a stream's teardown leaves alone a round that belongs to ${whose}`, async () => {
      const h = await scriptRound('locus', [
        createMockResponse([
          { type: 'text', text: 'working' },
          { type: 'tool_use', id: 'r1', name: 'test--echo', input: {} },
        ] as ContentBlock[], 'tool_use'),
        createMockResponse([{ type: 'text', text: 'done' }] as ContentBlock[]),
      ]);
      // pendingRound's round has stream id -1, which no stream has.
      const successor = pendingRound(whose === 'another agent object' ? {} : h.framework.getAgent('assistant'));
      const rounds = (h.framework as unknown as { scriptRounds: Map<string, unknown> }).scriptRounds;
      h.framework.onTrace((event) => {
        if (event.type === 'tool:completed' && event.callId === 'r1') rounds.set('assistant', successor.round);
      });
      try {
        await h.run();
        assert.ok(h.log.includes('publish:done@world:test'), 'the stream ran to its end');
        assert.deepStrictEqual(successor.asked, [], "this stream's teardown doesn't withhold the successor's round");
        assert.equal(rounds.get('assistant'), successor.round, 'nor remove it');
      } finally { await h.done(); }
    });
  }

  it("explicit: a script round goes to the target its `>>` named when the round ended, though the label is renamed while the script runs", async () => {
    const h = await scriptRound('explicit', [
      createMockResponse([
        { type: 'text', text: '>>#alpha written for alpha' },
        scriptCall({ code: 'await test__slow({})' + HOLDS }),
      ] as ContentBlock[], 'tool_use'),
      createMockResponse([{ type: 'text', text: '>>skip_reply done' }] as ContentBlock[]),
    ]);
    // While the script waits in its slow call, #alpha comes to name another channel.
    const watch = setInterval(() => {
      if (h.log.includes('tool:slow')) { h.directory['#alpha'] = 'chan-renamed'; h.module.releaseSlow(); }
    }, 10);
    const bound = setTimeout(() => h.module.releaseSlow(), 15000);
    try {
      await h.run();
      assert.deepStrictEqual(h.log.filter((e) => e.startsWith('publish:')), ['publish:written for alpha@chan-alpha'],
        'the round was admitted when it ended');
    } finally {
      clearInterval(watch);
      clearTimeout(bound);
      await h.done();
    }
  });
});

// ---------------------------------------------------------------------------
// Background scripts (wake_agent) + spill-to-file
// ---------------------------------------------------------------------------

describe('PyRunner background mode (real python3)', () => {
  it('wake_agent reports the caller line and payload; log file journals output', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'nested', 'bg.log');
    const wakes: Array<{ line: number; payload: unknown }> = [];
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = [
        'print("watcher starting")',        // line 1
        'x = 1',                            // line 2
        'await wake_agent({"hit": x})',     // line 3
        'print("after wake")',              // line 4
      ].join('\n');
      const result = await runner.exec(code, [], {
        logPath,
        lifetimeMs: 30_000,
        onWake: async (line, payload) => {
          wakes.push({ line, payload });
          return null;
        },
      });
      assert.strictEqual(result.returnCode, 0, result.tail ?? '');
      assert.strictEqual(wakes.length, 1);
      assert.strictEqual(wakes[0].line, 3);
      assert.deepStrictEqual(wakes[0].payload, { hit: 1 });
      const { readFileSync } = await import('node:fs');
      const log = readFileSync(logPath, 'utf8');
      assert.match(log, /watcher starting/);
      assert.match(log, /after wake/);
      assert.match(result.tail ?? '', /after wake/);
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a refused wake raises RuntimeError inside the script', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('await wake_agent({"n": 1})', [], {
        logPath: null,
        lifetimeMs: 30_000,
        onWake: async () => 'wake limit reached (test)',
      });
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.tail ?? '', /RuntimeError: wake_agent refused by host: wake limit reached/);
    } finally {
      runner.dispose();
    }
  });

  it("the journal holds a script's commands' output and its stderr, in the order written", { skip: process.platform === 'win32' ? 'the script runs POSIX commands' : false }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'bg.log');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = [
        'import os, sys',
        'for i in range(50):',
        '    print("out", i)',
        '    print("err", i, file=sys.stderr)',
        'os.system("echo cmd-out; echo cmd-err 1>&2")',
        'print("done")',
      ].join('\n');
      const result = await runner.exec(code, [], { logPath, lifetimeMs: 30_000, onWake: async () => null });
      assert.strictEqual(result.returnCode, 0, result.tail ?? '');
      const written = `${Array.from({ length: 50 }, (_, i) => `out ${i}\nerr ${i}\n`).join('')}cmd-out\ncmd-err\ndone\n`;
      assert.strictEqual(readFileSync(logPath, 'utf8'), written);
      assert.strictEqual(result.tail, written.slice(-4000));
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a background script whose stderr mark can't be written, after its result, has the runtime's line in its journal and is told it ended, with no word of earlier scripts' variables", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // A shutdown leaves the fd as it was, so only the mark's write fails:
      // stderr's goes first, so the runtime's line still reaches stdout's, the journal's.
      const result = await within(
        runner.exec(
          'import os, socket, __main__\nsocket.socket(fileno=os.dup(__main__._STD_ERR)).shutdown(socket.SHUT_WR)\nprint("shut")',
          [],
          { logPath: null, lifetimeMs: 30_000, onWake: async () => null },
        ),
        'the exit to settle',
      );
      assert.strictEqual(result.aborted, true);
      assert.match(result.tail ?? '', /^shut\n\[pytc-runtime\] cannot reach the output pipes any more: a script closed, shut down or replaced the runtime's copy of fd 2 \(\[Errno \d+\] [^)\n]+\); exiting\n/);
      assert.strictEqual(result.stderr, exitedAfterEnd('exited with code 70', "the runtime's copy of fd 2", true));
    } finally {
      runner.dispose();
    }
  });

  it("a background script that crashes leaves the tail of what it wrote, its crash's text included", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec('import ctypes\nprint("watching")\nctypes.pythonapi.Py_FatalError(b"probe reason")', [], {
          logPath: null,
          lifetimeMs: 30_000,
          onWake: async () => null,
        }),
        'the crash to settle',
      );
      assert.strictEqual(result.aborted, true);
      assert.match(result.tail ?? '', /^watching\nFatal Python error: probe reason\n[\s\S]*\nscript stopped: the Python interpreter was ended by SIGABRT while it ran, so the rest of the script didn't run\. [^\n]*\n$/);
    } finally {
      runner.dispose();
    }
  });

  it("a background script that stops at its lifetime when told to has why in its journal too", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bglife-'));
    const logPath = join(tempDir, 'bg.log');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // It awaits, so the cancel at its lifetime stops it, and the host doesn't kill it.
      const result = await within(
        runner.exec('import asyncio\nprint("watching")\nwhile True:\n    await asyncio.sleep(0.05)', [], { logPath, lifetimeMs: 2000, onWake: async () => null }),
        'the lifetime',
      );
      assert.strictEqual(result.returnCode, 1, result.tail ?? '');
      const note = 'script stopped: it reached its 2s time limit. Tool calls it had already made keep their effects, so check them before running it again.\n';
      assert.strictEqual(result.tail, `watching\n\nKeyboardInterrupt: script cancelled by host\n${note}`);
      assert.strictEqual(readFileSync(logPath, 'utf8'), result.tail);
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a background script's crash text and the runtime's own line go to stdout's pipe, with what it wrote, not to the runtime's copy of fd 2", async () => {
    // With that copy's socket shut down, only stdout's pipe can carry them. In
    // the second case fd 2, which a background script's stderr joins to
    // stdout's pipe, is put elsewhere too, so the runtime can't fall back to it.
    const shut = 'socket.socket(fileno=os.dup(__main__._STD_ERR)).shutdown(socket.SHUT_WR)';
    const cases: [string, string, RegExp][] = [
      ['a segfault', `import __main__, ctypes, os, socket\n${shut}\nprint("watching")\nctypes.string_at(0)`, /^watching\nFatal Python error: Segmentation fault\n/],
      [
        'fd 4 closed',
        `import __main__, os, socket\nos.dup2(os.open(os.devnull, os.O_WRONLY), 2)\n${shut}\nprint("watching")\nos.close(4)`,
        /^watching\n\[pytc-runtime\] cannot send the host a message any more: a script closed, shut down or replaced fd 4, where they go; exiting\n/,
      ],
    ];
    for (const [what, code, says] of cases) {
      const runner = new PyRunner({ onToolCall: async () => '' });
      try {
        const result = await within(runner.exec(code, [], { logPath: null, lifetimeMs: 30_000, onWake: async () => null }), what);
        assert.strictEqual(result.aborted, true, what);
        assert.match(result.tail ?? '', says, what);
      } finally {
        runner.dispose();
      }
    }
  });

  it("a background script that takes one of the runtime's fds is told which, from its journal", async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await within(
        runner.exec('import os\nprint("watching")\nos.close(4)', [], { logPath: null, lifetimeMs: 30_000, onWake: async () => null }),
        'the runtime to end',
      );
      assert.strictEqual(result.aborted, true);
      // A background script has its interpreter to itself, so no earlier script's variables are lost.
      const lost = runtimeLost('fd 4').replace(', and variables from earlier scripts are gone', '');
      assert.ok((result.tail ?? '').endsWith(`; exiting\n${lost}\n`), result.tail ?? '');
    } finally {
      runner.dispose();
    }
  });

  it("a background script's journal has each line as it's written, and ends saying why the script was stopped", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bg-'));
    const logPath = join(tempDir, 'bg.log');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const pending = runner.exec('import asyncio\nprint("watching")\nawait asyncio.sleep(30)', [], {
        logPath,
        lifetimeMs: 60_000,
        onWake: async () => null,
      });
      await until(() => existsSync(logPath) && readFileSync(logPath, 'utf8') === 'watching\n', 'its line in the journal');
      runner.abort('stopped watching');
      const result = await pending;
      assert.strictEqual(result.tail, 'watching\nscript aborted by host: stopped watching\n');
      assert.strictEqual(readFileSync(logPath, 'utf8'), 'watching\nscript aborted by host: stopped watching\n');
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a journal that can't be written says so once in the host's log, and its tail goes on", { skip: process.platform !== 'linux' ? 'writes to /dev/full fail only on Linux' : false }, async () => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The long line takes more than one read, so the journal meets writes after its failure.
      const result = await runner.exec('print("one")\nprint("x" * 70000)\nprint("two")', [], { logPath: '/dev/full', lifetimeMs: 30_000, onWake: async () => null });
      assert.strictEqual(result.returnCode, 0, result.tail);
      assert.strictEqual(result.tail, `one\n${'x'.repeat(70000)}\ntwo\n`.slice(-4000));
      assert.strictEqual(logged.filter((l) => /cannot write the log file any more: .*ENOSPC/.test(l)).length, 1, JSON.stringify(logged));
    } finally {
      console.error = consoleError;
      runner.dispose();
    }
  });

  it("a journal that can't be opened says so once in the host's log, and the script runs with its tail kept", { skip: process.platform === 'win32' ? 'the path is under /dev/null' : false }, async () => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("one")\nprint("two")', [], { logPath: '/dev/null/bg.log', lifetimeMs: 30_000, onWake: async () => null });
      assert.strictEqual(result.returnCode, 0, result.tail);
      assert.strictEqual(result.tail, 'one\ntwo\n');
      assert.strictEqual(logged.filter((l) => l.includes('cannot open log file: ')).length, 1, JSON.stringify(logged));
    } finally {
      console.error = consoleError;
      runner.dispose();
    }
  });

  it("a settled journal leaves no file descriptor of the host's open on its file, whether its script ended or was stopped", { skip: process.platform !== 'linux' ? 'reads /proc/self/fd' : false }, async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-bgclose-'));
    /** The host's fds that point at the file. */
    const holding = (path: string) => readdirSync('/proc/self/fd').filter((fd) => {
      try {
        return readlinkSync(join('/proc/self/fd', fd)) === path;
      } catch {
        return false;
      }
    });
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const ended = join(tempDir, 'ended.log');
      const result = await runner.exec('print("one")', [], { logPath: ended, lifetimeMs: 30_000, onWake: async () => null });
      assert.strictEqual(result.returnCode, 0, result.tail);
      assert.deepStrictEqual(holding(realpathSync(ended)), []);
      const stopped = join(tempDir, 'stopped.log');
      const pending = runner.exec('import asyncio\nprint("watching")\nawait asyncio.sleep(30)', [], { logPath: stopped, lifetimeMs: 60_000, onWake: async () => null });
      await until(() => existsSync(stopped) && readFileSync(stopped, 'utf8') === 'watching\n', 'its line in the journal');
      assert.strictEqual(holding(realpathSync(stopped)).length, 1, 'the journal should be open while its script runs');
      runner.abort('stopped watching');
      await pending;
      assert.deepStrictEqual(holding(realpathSync(stopped)), []);
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("a journal write that a file-size limit cuts short goes on, and its failure says so in the host's log", { skip: process.platform === 'win32' ? 'the limit is set with bash\'s ulimit' : false }, () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-fsize-'));
    const logPath = join(tempDir, 'bg.log');
    try {
      // Under a 64 KiB limit, a host whose journal holds 65,000 bytes gets
      // 1,000 more in one chunk, so the kernel cuts that write short at the
      // limit, and the next one fails. The child's stdout is a stream socket,
      // which doesn't promise one read for a write as a pipe does under
      // PIPE_BUF, but a write this small arrives whole in practice: without
      // writeAll's loop this test fails.
      const script = [
        'import os, sys, time',
        'sys.stdout.write("x" * 64999 + "\\n")',
        'for _ in range(1000):',
        `    if os.path.getsize(${JSON.stringify(logPath)}) >= 65000:`,
        '        break',
        '    time.sleep(0.01)',
        'sys.stdout.write("y" * 999 + "\\n")',
      ].join('\n');
      const host = [
        `const { PyRunner } = await import(${JSON.stringify(new URL('../src/index.js', import.meta.url).href)});`,
        'const logged = [];',
        'console.error = (...args) => { logged.push(args.map(String).join(" ")); };',
        'const runner = new PyRunner({ onToolCall: async () => "" });',
        `const result = await runner.exec(${JSON.stringify(script)}, [], { logPath: ${JSON.stringify(logPath)}, lifetimeMs: 30000, onWake: async () => null });`,
        'runner.dispose();',
        'process.stdout.write(JSON.stringify({ returnCode: result.returnCode, tail: result.tail, logged }));',
      ].join('\n');
      const out = execFileSync('bash', ['-c', 'ulimit -f 64 && exec "$0" --input-type=module -e "$1"', process.execPath, host], { encoding: 'utf8' });
      const { returnCode, tail, logged } = JSON.parse(out) as { returnCode: number; tail: string; logged: string[] };
      assert.strictEqual(returnCode, 0, JSON.stringify(logged));
      const written = `${'x'.repeat(64999)}\n${'y'.repeat(999)}\n`;
      const journal = readFileSync(logPath, 'utf8');
      assert.ok(journal.length >= 65000 && journal.length <= 65536, `${journal.length} bytes`);
      assert.strictEqual(journal, written.slice(0, journal.length));
      assert.strictEqual(tail, written.slice(-4000));
      assert.strictEqual(logged.filter((l) => /cannot write the log file any more: .*EFBIG/.test(l)).length, 1, JSON.stringify(logged));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a journal stops at its 50 MB cap, counted in bytes, with one line saying so, and its tail goes on', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pytc-cap-'));
    const logPath = join(tempDir, 'bg.log');
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // Each "é" is two bytes, so a cap counted in characters would let the file pass 50 MB.
      const result = await runner.exec(
        'import sys\nfor i in range(51):\n    sys.stdout.write("é" * 499999 + "\\n")\nprint("done")',
        [],
        { logPath, lifetimeMs: 60_000, onWake: async () => null },
      );
      assert.strictEqual(result.returnCode, 0, result.tail ?? '');
      const capLine = '\n[log capped at 50000000 bytes]\n';
      const size = statSync(logPath).size;
      // The piece that would pass the cap isn't written, and a piece is one read of the pipe.
      assert.ok(size > 49_900_000 && size <= 50_000_000 + capLine.length, `${size} bytes`);
      const fd = openSync(logPath, 'r');
      const end = Buffer.alloc(capLine.length + 1000);
      readSync(fd, end, 0, end.length, size - end.length);
      closeSync(fd);
      // The read may start inside a character.
      assert.match(end.toString('utf8'), /^\uFFFD?[é\n]+\n\[log capped at 50000000 bytes\]\n$/);
      assert.strictEqual(result.tail, `${'é'.repeat(499999)}\ndone\n`.slice(-4000));
    } finally {
      runner.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('wake_agent is absent in foreground scripts', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('print("wake_agent" in globals())', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /False/);
    } finally {
      runner.dispose();
    }
  });
});

describe('framework background scripts + spill (real python3)', () => {
  async function createBgFramework(storePath: string, membrane: MockMembrane, opts?: {
    mountDir?: string;
    codeExecution?: Record<string, unknown>;
  }) {
    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const modules: Module[] = [new ScriptToolModule()];
    let workspace: InstanceType<typeof WorkspaceModule> | null = null;
    if (opts?.mountDir) {
      workspace = new WorkspaceModule({
        mounts: [{ name: 'files', path: opts.mountDir, mode: 'read-write', watch: 'never' }],
      });
      modules.push(workspace as unknown as Module);
    }
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
      }],
      modules,
      syncIntervalMs: 0,
      codeExecution: {
        enabled: true,
        wakeMinIntervalMs: 0,
        ...(opts?.codeExecution ?? {}),
      },
    });
    // Host wiring (fkm does this in production): mounts populate in initStore.
    workspace?.initStore(framework.getStore());
    return framework;
  }

  it('background script detaches, wakes the agent with provenance, and triggers inference', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgfw-');
    const mountDir = join(tempDir, 'mount');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new MockMembrane();

    const bgCode = [
      'import asyncio',
      'await asyncio.sleep(0.2)',
      'r = await test__echo({"message": "bg"})',
      'await wake_agent({"found": "signal", "is_error": r.is_error})',
    ].join('\\n');

    // Turn 1: spawn the background script, then finish the turn.
    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Arming watcher.' },
      { type: 'tool_use', id: 'call_bg1', name: 'code_execution', input: { code: bgCode.split('\\n').join('\n'), background: true } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Watcher armed; resting.' }]));
    // Turn 2 (the wake): agent answers.
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke and handled.' }]));

    const framework = await createBgFramework(storePath, membrane, { mountDir });
    try {
      framework.start();
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'arm a watcher' }],
        metadata: { channelId: 'world:test' },
        triggerInference: true,
      } as unknown as ProcessEvent);

      // Wait for: turn 1 result mentions script started, then wake message lands.
      const deadline = Date.now() + 20_000;
      let wakeMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !wakeMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        wakeMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(wakeMessage, 'wake message should be injected');
      const text = (wakeMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /\[background script bg-\d+\] Woke you/);
      assert.match(text, /line 4 of your script/);
      assert.match(text, /"found": "signal"/);
      // A background script's results carry the flag too (None if only the
      // string were passed on).
      assert.match(text, /"is_error": false/);
      assert.match(text, /workspace file files\/background-scripts\/bg-\d+\.log/);
      assert.match(text, /Script status: still running|Script status/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a background script gets codeExecution.env and not a host variable outside the allowlist', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgenv-');
    const membrane = new MockMembrane();
    const bgCode = `import os\nawait wake_agent({"declared": os.environ.get("${DECLARED}"), "host": os.environ.get("${HOST_ONLY}")})`;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_bgenv', name: 'code_execution', input: { code: bgCode, background: true } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Armed.' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke.' }]));
    const framework = await createBgFramework(storePath, membrane, { codeExecution: { env: { [DECLARED]: 'from-config' } } });
    try {
      process.env[HOST_ONLY] = 'host-value';
      framework.start();
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'arm it' }], metadata: { channelId: 'world:test' }, triggerInference: true,
      } as unknown as ProcessEvent);
      const deadline = Date.now() + 20_000;
      let wakeText = '';
      while (Date.now() < deadline && !wakeText) {
        await new Promise((r) => setTimeout(r, 100));
        const msgs = (framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        const wake = msgs.find((m) => m.metadata?.source === 'background-script');
        wakeText = (wake?.content[0] as { text?: string } | undefined)?.text ?? '';
      }
      assert.match(wakeText, /"declared": "from-config"/, wakeText);
      assert.match(wakeText, /"host": null/, wakeText);
    } finally {
      await framework.stop();
      delete process.env[HOST_ONLY];
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("with codeExecution.inheritEnv: true, a background script gets the host's variables beside codeExecution.env", async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgenvinherit-');
    const membrane = new MockMembrane();
    const bgCode = `import os\nawait wake_agent({"declared": os.environ.get("${DECLARED}"), "host": os.environ.get("${HOST_ONLY}")})`;
    membrane.pushResponse(createMockResponse([
      { type: 'tool_use', id: 'call_bgenv_inherit', name: 'code_execution', input: { code: bgCode, background: true } },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Armed.' }]));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Woke.' }]));
    const framework = await createBgFramework(storePath, membrane, { codeExecution: { env: { [DECLARED]: 'from-config' }, inheritEnv: true } });
    try {
      process.env[HOST_ONLY] = 'host-value';
      framework.start();
      framework.pushEvent({
        type: 'external-message', source: 'test', content: [{ type: 'text', text: 'arm it' }], metadata: { channelId: 'world:test' }, triggerInference: true,
      } as unknown as ProcessEvent);
      const deadline = Date.now() + 20_000;
      let wakeText = '';
      while (Date.now() < deadline && !wakeText) {
        await new Promise((r) => setTimeout(r, 100));
        const msgs = (framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        const wake = msgs.find((m) => m.metadata?.source === 'background-script');
        wakeText = (wake?.content[0] as { text?: string } | undefined)?.text ?? '';
      }
      assert.match(wakeText, /"declared": "from-config"/, wakeText);
      assert.match(wakeText, /"host": "host-value"/, wakeText);
    } finally {
      await framework.stop();
      delete process.env[HOST_ONLY];
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('list and cancel manage the daemon fleet; cap enforced', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bglist-');
    const membrane = new MockMembrane();
    const framework = await createBgFramework(storePath, membrane, {
      codeExecution: { maxBackgroundScripts: 1 },
    });
    try {
      const idle = 'import asyncio\nawait asyncio.sleep(60)';
      const first = await framework.executeToolCall({
        id: 'c1', name: 'code_execution', input: { code: idle, background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(first.success, true, JSON.stringify(first));
      const firstId = (first.data as { script_id: string }).script_id;

      const second = await framework.executeToolCall({
        id: 'c2', name: 'code_execution', input: { code: idle, background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(second.isError, true);
      assert.match(String(second.error), /limit reached/);

      const list = await framework.executeToolCall({
        id: 'c3', name: 'code_execution', input: { action: 'list' }, callerAgentName: 'prime',
      });
      const scripts = (list.data as { background_scripts: Array<{ script_id: string; status: string }> }).background_scripts;
      assert.strictEqual(scripts.filter((s) => s.status === 'running').length, 1);

      const cancel = await framework.executeToolCall({
        id: 'c4', name: 'code_execution', input: { action: 'cancel', script_id: firstId }, callerAgentName: 'prime',
      });
      assert.strictEqual(cancel.success, true);
      assert.strictEqual((cancel.data as { status: string }).status, 'cancelled');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('crashed background script wakes the agent with the error tail', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bgcrash-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const framework = await createBgFramework(storePath, membrane, {});
    try {
      framework.start();
      const started = await framework.executeToolCall({
        id: 'c1',
        name: 'code_execution',
        input: { code: 'import asyncio\nawait asyncio.sleep(0.1)\nraise ValueError("watcher exploded")', background: true },
        callerAgentName: 'prime',
      });
      assert.strictEqual(started.success, true, JSON.stringify(started));

      const deadline = Date.now() + 20_000;
      let crashMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !crashMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        crashMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(crashMessage, 'crash wake should be injected');
      const text = (crashMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /DIED/);
      assert.match(text, /ValueError: watcher exploded/);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a background script stopped at its lifetime is told that is the longest one runs here', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-bglimit-');
    const membrane = new MockMembrane();
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
    const framework = await createBgFramework(storePath, membrane, { codeExecution: { backgroundMaxLifetimeMs: 1000 } });
    try {
      framework.start();
      const started = await framework.executeToolCall({
        id: 'l1',
        name: 'code_execution',
        input: { code: 'import asyncio\nawait asyncio.sleep(60)', background: true },
        callerAgentName: 'prime',
      });
      assert.strictEqual(started.success, true, JSON.stringify(started));
      const deadline = Date.now() + 20_000;
      let stopMessage: { content: ContentBlockLike[] } | null = null;
      while (Date.now() < deadline && !stopMessage) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
        stopMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
      }
      assert.ok(stopMessage, 'the stop should wake the agent');
      const text = (stopMessage.content[0] as { text?: string }).text ?? '';
      assert.match(text, /script stopped: it reached its 1s time limit\./);
      assert.match(text, /1s is the longest a background script runs here; starting it again runs it from the top\./, 'the background ceiling reaches the message');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a dead script\'s last output is cut at 2000 units without halving a surrogate pair', async () => {
    // 1500 emoji, then the traceback. Whichever parity the cut 2000 units
    // from the end has, one of the two runs (with or without one more unit
    // after the emoji) puts it on a pair's second half.
    for (const after of ['', 'x']) {
      const { tempDir, storePath } = tempStorePath('pytc-bgpair-');
      const membrane = new MockMembrane();
      membrane.pushResponse(createMockResponse([{ type: 'text', text: 'noted' }]));
      const framework = await createBgFramework(storePath, membrane, {});
      try {
        framework.start();
        const started = await framework.executeToolCall({
          id: 'c1',
          name: 'code_execution',
          input: {
            code: `import asyncio\nprint("\\U0001F600" * 1500 + "${after}", flush=True)\nawait asyncio.sleep(0.1)\nraise ValueError("done")`,
            background: true,
          },
          callerAgentName: 'prime',
        });
        assert.strictEqual(started.success, true, JSON.stringify(started));

        const deadline = Date.now() + 20_000;
        let crashMessage: { content: ContentBlockLike[] } | null = null;
        while (Date.now() < deadline && !crashMessage) {
          await new Promise((r) => setTimeout(r, 100));
          const cm = framework.getAgent('prime')?.getContextManager();
          const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: ContentBlockLike[]; metadata?: { source?: string } }>;
          crashMessage = msgs.find((m) => m.metadata?.source === 'background-script') ?? null;
        }
        assert.ok(crashMessage, 'crash wake should be injected');
        const text = (crashMessage.content[0] as { text?: string }).text ?? '';
        // A halved pair would be stored as U+FFFD, or kept as a lone surrogate.
        const last = text.split('Last output:\n')[1] ?? '';
        assert.ok(last.startsWith('\u{1F600}'),
          `the last output starts on a whole emoji (after ${JSON.stringify(after)}): ${JSON.stringify(last.slice(0, 4))}`);
        assert.ok(!text.includes('\ufffd') && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text),
          `no half of a pair (after ${JSON.stringify(after)})`);
      } finally {
        await framework.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('oversized tool results spill to a workspace file with a reference', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-spill-');
    const mountDir = join(tempDir, 'mount');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(mountDir, { recursive: true });
    const membrane = new MockMembrane();

    // big module: returns ~600KB (strategy default maxMessageTokens absent →
    // maxChars undefined → no spill). Force the cap via agent_settings-style
    // override path by configuring a small maxMessageTokens on the agent.
    class BigToolModule implements Module {
      readonly name = 'big';
      async start(): Promise<void> {}
      async stop(): Promise<void> {}
      getTools(): ToolDefinition[] {
        return [{ name: 'blob', description: 'Returns JSON: huge string.', inputSchema: { type: 'object', properties: {} } }];
      }
      async handleToolCall(): Promise<ToolResult> {
        return { success: true, data: { blob: 'x'.repeat(600_000) } };
      }
      async onProcess(event: ProcessEvent): Promise<EventResponse> {
        if (event.type === 'external-message') {
          return {
            addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }],
            requestInference: true,
          };
        }
        return {};
      }
    }

    membrane.pushResponse(createMockResponse([
      { type: 'text', text: 'Fetching blob.' },
      { type: 'tool_use', id: 'call_blob', name: 'big--blob', input: {} },
    ], 'tool_use'));
    membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));

    const { WorkspaceModule } = await import('../src/modules/workspace/index.js');
    const spillWorkspace = new WorkspaceModule({
      mounts: [{ name: 'files', path: mountDir, mode: 'read-write', watch: 'never' }],
    });
    const framework = await AgentFramework.create({
      storePath,
      membrane: membrane.asMembrane(),
      agents: [{
        name: 'prime',
        model: 'test-model',
        systemPrompt: 'You are prime.',
        allowedTools: 'all',
        strategy: new CappedPassthroughStrategy() as never,
      }],
      modules: [
        new BigToolModule(),
        spillWorkspace as unknown as Module,
      ],
      syncIntervalMs: 0,
      codeExecution: { enabled: true },
    });
    spillWorkspace.initStore(framework.getStore());
    try {
      framework.start();
      framework.pushEvent({
        type: 'external-message',
        source: 'test',
        content: [{ type: 'text', text: 'get the blob' }],
        metadata: { channelId: 'world:test' },
        triggerInference: true,
      } as unknown as ProcessEvent);

      const deadline = Date.now() + 20_000;
      let toolResultText: string | null = null;
      while (Date.now() < deadline && !toolResultText) {
        await new Promise((r) => setTimeout(r, 100));
        const cm = framework.getAgent('prime')?.getContextManager();
        const msgs = (cm?.queryMessages({}).messages ?? []) as unknown as Array<{ content: Array<{ type: string; content?: string }> }>;
        for (const m of msgs) {
          for (const b of m.content ?? []) {
            if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('[truncated')) {
              toolResultText = b.content;
            }
          }
        }
      }
      assert.ok(toolResultText, 'spilled tool result should be stored');
      assert.match(toolResultText, /full content: workspace file files\/tool-results\//);
      assert.match(toolResultText, /tool_result_inline_max_chars/);
      assert.ok(toolResultText.length < 20_000, 'inline copy must be capped');
      // The full content lives in the chronicle tree — the same place the
      // agent's own read tool looks (disk materialization is async and
      // watch-mode-dependent; not what we're testing here).
      const refMatch = toolResultText.match(/workspace file (files\/tool-results\/\S+\.txt)/);
      assert.ok(refMatch, 'reference should name the spill file');
      const spilledFile = await spillWorkspace.readBinary(refMatch[1]);
      assert.ok('data' in spilledFile, `spill file should be readable: ${JSON.stringify(spilledFile)}`);
      assert.ok((spilledFile as { data: Buffer }).data.byteLength >= 600_000, 'full content in file');
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

type ContentBlockLike = { type: string; text?: string };

import { PassthroughStrategy } from '../src/index.js';
class CappedPassthroughStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

describe('code_execution per-call time limit (time_limit_ms)', () => {
  it('PyRunner: a per-exec deadline replaces scriptTimeoutMs, and the result says the time ran out', async () => {
    const runner = new PyRunner({ scriptTimeoutMs: 600_000, onToolCall: async () => '' });
    try {
      const started = Date.now();
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(60)', [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 15_000, 'the per-exec deadline was not applied');
    } finally {
      runner.dispose();
    }
  });

  // On a deployment without maxScriptTimeoutMs the ceiling is the default, and a
  // larger time_limit_ms would only buy a second run that stops the same way.
  it('PyRunner: a script stopped at its limit is offered a longer one only below the ceiling', async () => {
    const code = 'import asyncio\nawait asyncio.sleep(60)';
    const effects = 'Tool calls it had already made keep their effects, so check them before running it again.';
    const runner = new PyRunner({ onToolCall: async () => '' });
    const background = new PyRunner({ onToolCall: async () => '', idleReclaimMs: 0 });
    const backgroundBelow = new PyRunner({ onToolCall: async () => '', idleReclaimMs: 0 });
    try {
      const below = await runner.exec(code, [], undefined, { deadlineMs: 1000, ceilingMs: 5000 });
      assert.ok(below.stderr.endsWith(`script stopped: it reached its 1s time limit. ${effects} To give it longer, pass time_limit_ms up to 5000 (5s).\n`), below.stderr);
      const at = await runner.exec(code, [], undefined, { deadlineMs: 1000, ceilingMs: 1000 });
      assert.ok(at.stderr.endsWith(`${effects} 1s is the longest a script can run here, so split the work across shorter scripts.\n`), at.stderr);
      const longerInBackground = await runner.exec(code, [], undefined, { deadlineMs: 1000, ceilingMs: 1000, backgroundCeilingMs: 86_400_000 });
      assert.ok(longerInBackground.stderr.endsWith(`${effects} 1s is the longest a script can run here, so split the work across shorter scripts, `
        + 'or run it with background: true, where a script can run up to 24 h.\n'), longerInBackground.stderr);
      const noLongerInBackground = await runner.exec(code, [], undefined, { deadlineMs: 1000, ceilingMs: 1000, backgroundCeilingMs: 1000 });
      assert.ok(noLongerInBackground.stderr.endsWith('so split the work across shorter scripts.\n'), noLongerInBackground.stderr);
      const unknown = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.ok(unknown.stderr.endsWith(`script stopped: it reached its 1s time limit. ${effects}\n`), unknown.stderr);
      const watcher = await background.exec(code, [], { logPath: null, lifetimeMs: 1000, onWake: async () => null }, { ceilingMs: 1000 });
      assert.ok(watcher.stderr.endsWith(`${effects} 1s is the longest a background script runs here; starting it again runs it from the top.\n`), watcher.stderr);
      const shortWatcher = await backgroundBelow.exec(code, [], { logPath: null, lifetimeMs: 1000, onWake: async () => null }, { ceilingMs: 5000 });
      assert.ok(shortWatcher.stderr.endsWith(`${effects} To give it longer, start it with time_limit_ms up to 5000 (5s).\n`), shortWatcher.stderr);
    } finally {
      runner.dispose();
      background.dispose();
      backgroundBelow.dispose();
    }
  });

  it('PyRunner: a script that catches the cancellation and finishes is not reported as stopped', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const code = 'import asyncio\ntry:\n    await asyncio.sleep(60)\nexcept asyncio.CancelledError:\n    print("cleaned up")';
      const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /cleaned up/);
      assert.doesNotMatch(result.stderr, /script stopped/);
    } finally {
      runner.dispose();
    }
  });

  it('PyRunner: a deadline beyond Node timers (~24.8 days) is clamped, not fired at once', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const result = await runner.exec('import asyncio\nawait asyncio.sleep(0.3)\nprint("done")', [], undefined, { deadlineMs: 30 * 86_400_000 });
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.match(result.stdout, /done/);
    } finally {
      runner.dispose();
    }
  });

  it('a ceiling below the default is refused when the framework is created', async () => {
    const { tempDir, storePath } = tempStorePath('pytc-badcfg-');
    try {
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: new MockMembrane().asMembrane(),
          agents: [],
          modules: [],
          syncIntervalMs: 0,
          codeExecution: { enabled: true, scriptTimeoutMs: 600_000, maxScriptTimeoutMs: 60_000 },
        }),
        /maxScriptTimeoutMs \(60000\) must be at least scriptTimeoutMs \(600000\)/,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const createWith = (storePath: string, codeExecution: unknown) =>
    AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents: [],
      modules: [],
      syncIntervalMs: 0,
      codeExecution: codeExecution as never,
    });

  /** create() refuses each config with exactly its message, before anything
   *  opens: no store is left at storePath. */
  async function assertRefused(cases: ReadonlyArray<readonly [unknown, string]>): Promise<void> {
    const { tempDir, storePath } = tempStorePath('pytc-refused-');
    try {
      for (const [codeExecution, message] of cases) {
        await assert.rejects(createWith(storePath, codeExecution), (error: Error) => {
          assert.equal(error.message, message);
          return true;
        });
        assert.equal(existsSync(storePath), false, 'the refused config opened no store');
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('create() refuses a codeExecution.enabled that is not true or false, a quoted "false" included', async () => {
    // A quoted "false" is truthy, so it turned code execution on, and 0 is
    // falsy, so it was read as off without a word. Each message names the
    // value's kind, never the value, since a substituted value can be a
    // credential.
    const whatTrueDoes = 'true gives agents the code_execution tool, which runs their scripts in a python interpreter on the host, '
      + 'and false or leaving it out doesn\'t';
    await assertRefused([
      [{ enabled: 'false' }, `codeExecution.enabled must be true or false, unquoted, not a string: ${whatTrueDoes}`],
      [{ enabled: 'sk-secret-token' }, `codeExecution.enabled must be true or false, unquoted, not a string: ${whatTrueDoes}`],
      [{ enabled: 0 }, `codeExecution.enabled must be true or false, not a number: ${whatTrueDoes}`],
      [{ enabled: { on: true } }, `codeExecution.enabled must be true or false, not an object: ${whatTrueDoes}`],
    ]);
  });

  it('create() refuses a codeExecution that is not an object, null or false, since it would read as off', async () => {
    await assertRefused([
      [true, 'codeExecution must be an object, such as { enabled: true }, not a boolean'],
      ['true', 'codeExecution must be an object, such as { enabled: true }, not a string'],
      [[], 'codeExecution must be an object, such as { enabled: true }, not an array'],
    ]);
  });

  it('a null or false codeExecution, or a null or left-out codeExecution.enabled, counts as off, and a configuration that is off has nothing else checked', async () => {
    // Contradictory limits, and an env or inheritEnv that would be refused,
    // are checked only once code execution is on.
    const contradictory = { scriptTimeoutMs: 600_000, maxScriptTimeoutMs: 60_000 };
    for (const codeExecution of [
      null,
      false,
      { enabled: null, ...contradictory },
      { enabled: false, ...contradictory },
      { ...contradictory },
      { enabled: false, inheritEnv: 'true', env: 7 },
    ]) {
      const { tempDir, storePath } = tempStorePath('pytc-enabled-off-');
      let framework: AgentFramework | undefined;
      try {
        framework = await createWith(storePath, codeExecution);
        assert.equal(framework.getAllTools().some((tool) => tool.name === 'code_execution'), false);
      } finally {
        await framework?.stop();
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  async function withFramework(
    codeExecution: Record<string, unknown>,
    body: (framework: AgentFramework) => Promise<void>,
    agents: Parameters<typeof AgentFramework.create>[0]['agents'] = [],
  ): Promise<void> {
    const { tempDir, storePath } = tempStorePath('pytc-timeout-');
    const framework = await AgentFramework.create({
      storePath,
      membrane: new MockMembrane().asMembrane(),
      agents,
      modules: [new ScriptToolModule()],
      syncIntervalMs: 0,
      codeExecution: { enabled: true, ...codeExecution },
    });
    try {
      await body(framework);
    } finally {
      await framework.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const run = (framework: AgentFramework, input: Record<string, unknown>) =>
    framework.executeToolCall({ id: `ce-${Math.random()}`, name: 'code_execution', input });
  const dataOf = (r: ToolResult) => r.structured as { stdout: string; stderr: string; return_code: number; time_limit_note?: string };

  it('the tool tells the agent its time limit and offers time_limit_ms', async () => {
    await withFramework({ scriptTimeoutMs: 300_000, maxScriptTimeoutMs: 1_800_000 }, async (framework) => {
      const tool = framework.getAllTools().find((t) => t.name === 'code_execution')!;
      assert.match(tool.description, /A foreground script is stopped after 5 min; pass time_limit_ms to set this call's limit \(at most 30 min; a background script runs up to 24 h\)/);
      const props = (tool.inputSchema as { properties: Record<string, { description: string }> }).properties;
      assert.match(props.time_limit_ms.description, /Default 300000, at most 1800000/);
    });
  });

  it('time_limit_ms shortens one call; the deployment default is unchanged for the next', async () => {
    await withFramework({ scriptTimeoutMs: 600_000 }, async (framework) => {
      const short = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', time_limit_ms: 1000 }));
      assert.strictEqual(short.return_code, 1);
      assert.match(short.stderr, /reached its 1s time limit/);
      assert.match(short.stderr, /To give it longer, pass time_limit_ms up to 600000 \(10 min\)\.\n$/, 'the deployment ceiling reaches the message');
      const normal = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(1.5)\nprint("done")' }));
      assert.strictEqual(normal.return_code, 0);
      assert.match(normal.stdout, /done/);
    });
  });

  it('a request above the ceiling is capped, and the result says so', async () => {
    await withFramework({ scriptTimeoutMs: 1000 }, async (framework) => {
      const started = Date.now();
      const r = dataOf(await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', time_limit_ms: 60_000 }));
      assert.strictEqual(r.return_code, 1);
      assert.strictEqual(r.time_limit_note, "time_limit_ms 60000 was capped at 1000, this deployment's maximum");
      assert.match(r.stderr, /1s is the longest a script can run here, so split the work across shorter scripts, or run it with background: true, where a script can run up to 24 h\.\n$/,
        "no larger limit is offered at the ceiling, and the deployment's background lifetime reaches the message");
      assert.ok(Date.now() - started < 15_000, 'the cap was not applied');
    });
  });

  it('at the ceiling, background mode is offered only to an agent that could start a background script', async () => {
    const atCeiling = (framework: AgentFramework, callerAgentName?: string) => framework.executeToolCall({
      id: `ce-${Math.random()}`, name: 'code_execution', input: { code: 'import asyncio\nawait asyncio.sleep(60)' }, ...(callerAgentName ? { callerAgentName } : {}),
    });
    const noOffer = /1s is the longest a script can run here, so split the work across shorter scripts\.\n$/;
    // Background scripts are the primary agent's.
    await withFramework({ scriptTimeoutMs: 1000 }, async (framework) => {
      assert.match(dataOf(await atCeiling(framework, 'prime')).stderr, /, or run it with background: true, where a script can run up to 24 h\.\n$/);
      assert.match(dataOf(await atCeiling(framework, 'other')).stderr, noOffer);
    }, [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }]);
    // A deployment that allows none offers none.
    await withFramework({ scriptTimeoutMs: 1000, maxBackgroundScripts: 0 }, async (framework) => {
      assert.match(dataOf(await atCeiling(framework)).stderr, noOffer);
    });
    // Nor does an agent whose background slots are all taken.
    await withFramework({ scriptTimeoutMs: 1000, maxBackgroundScripts: 1 }, async (framework) => {
      const started = await framework.executeToolCall({
        id: 'bg-1', name: 'code_execution', input: { code: 'import asyncio\nawait asyncio.sleep(60)', background: true }, callerAgentName: 'prime',
      });
      assert.strictEqual(started.success, true, JSON.stringify(started));
      assert.match(dataOf(await atCeiling(framework, 'prime')).stderr, noOffer);
    }, [{ name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all' }]);
  });

  it('maxScriptTimeoutMs lets an agent ask for longer than the default', async () => {
    await withFramework({ scriptTimeoutMs: 1000, maxScriptTimeoutMs: 10_000 }, async (framework) => {
      const code = 'import asyncio\nawait asyncio.sleep(2)\nprint("long done")';
      const defaulted = dataOf(await run(framework, { code }));
      assert.strictEqual(defaulted.return_code, 1, 'without time_limit_ms the 1s default applies');
      const longer = dataOf(await run(framework, { code, time_limit_ms: 5000 }));
      assert.strictEqual(longer.return_code, 0);
      assert.match(longer.stdout, /long done/);
      assert.strictEqual(longer.time_limit_note, undefined);
    });
  });

  it('an invalid time_limit_ms is refused before anything runs', async () => {
    await withFramework({}, async (framework) => {
      for (const time_limit_ms of ['soon', 10, -5, Number.NaN]) {
        const r = await run(framework, { code: 'print("ran")', time_limit_ms });
        assert.strictEqual(r.success, false, String(time_limit_ms));
        assert.match(String(r.error), /time_limit_ms/);
      }
    });
  });

  it('a background script: time_limit_ms shortens its lifetime, capped at the lifetime ceiling', async () => {
    await withFramework({ backgroundMaxLifetimeMs: 1500 }, async (framework) => {
      const r = await run(framework, { code: 'import asyncio\nawait asyncio.sleep(60)', background: true, time_limit_ms: 60_000 });
      assert.strictEqual(r.success, true);
      const data = r.data as { script_id: string; time_limit_note?: string; lifetime: string };
      assert.strictEqual(data.time_limit_note, "time_limit_ms 60000 was capped at 1500, this deployment's maximum");
      assert.strictEqual(data.lifetime, '2s', 'a short lifetime is reported exactly, not rounded to 0 hours');
      let status = 'running';
      const until = Date.now() + 15_000;
      while (status === 'running' && Date.now() < until) {
        await new Promise((res) => setTimeout(res, 200));
        const listed = (await run(framework, { action: 'list' })).data as { background_scripts: Array<{ script_id: string; status: string }> };
        status = listed.background_scripts.find((s) => s.script_id === data.script_id)?.status ?? 'gone';
      }
      assert.strictEqual(status, 'died', 'the script was stopped at its capped lifetime');
    });
  });
});

// The deadline's cancel op is an asyncio cancellation, which lands only when a
// script awaits; the SIGINT that follows it stops blocking code (#235 F3).
describe('code_execution time limit vs blocking code (real python3)', { skip: process.platform === 'win32' }, () => {
  const pidOf = (stdout: string) => /pid=(\d+)/.exec(stdout)?.[1];

  it('blocking code stops at the time limit, keeping its output, and the interpreter survives', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      const pid = pidOf(first.stdout);
      assert.ok(pid, first.stdout);
      const blocking: Record<string, string> = {
        sleep: 'import time\nprint("before")\ntime.sleep(60)\nprint("after")',
        'busy loop': 'print("before")\nn = 0\nwhile True:\n    n += 1\nprint("after")',
        'blocking read': 'import socket\nprint("before")\na, b = socket.socketpair()\na.recv(1)\nprint("after")',
      };
      for (const [shape, code] of Object.entries(blocking)) {
        const started = Date.now();
        const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
        const elapsed = Date.now() - started;
        assert.strictEqual(result.returnCode, 1, shape);
        assert.strictEqual(result.aborted, undefined, `${shape}: interrupted, not killed`);
        assert.strictEqual(result.stdout, 'before\n', `${shape}: output before the limit is kept`);
        assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/, shape);
        assert.match(result.stderr, /script stopped: it reached its 1s time limit/, shape);
        assert.match(result.stderr, /File "<script>", line \d+/, `${shape}: says where the script was`);
        assert.doesNotMatch(result.stderr, /runtime\.py/, `${shape}: no runtime frames`);
        assert.ok(elapsed < 5000, `${shape}: stopped at the limit, not the kill grace (${elapsed}ms)`);
      }
      const last = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      assert.strictEqual(pidOf(last.stdout), pid, 'same interpreter: nothing was killed');
    } finally {
      runner.dispose();
    }
  });

  it('variables survive an interrupted script', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const set = await runner.exec('x = 41', []);
      assert.strictEqual(set.returnCode, 0, set.stderr);
      const stopped = await runner.exec('import time\ny = 1\ntime.sleep(60)', [], undefined, { deadlineMs: 1000 });
      assert.match(stopped.stderr, /reached its 1s time limit/);
      const after = await runner.exec('print(x + y)', []);
      assert.strictEqual(after.returnCode, 0, after.stderr);
      assert.strictEqual(after.stdout, '42\n');
    } finally {
      runner.dispose();
    }
  });

  it('a script waiting on an await is still stopped by the cancel', async () => {
    const runner = new PyRunner({
      onToolCall: () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
    });
    try {
      const started = Date.now();
      const result = await runner.exec('print("before")\nawait test__echo({})\nprint("after")', ECHO_TOOLS, undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stdout, 'before\n');
      assert.match(result.stderr, /KeyboardInterrupt: script cancelled by host/);
      assert.doesNotMatch(result.stderr, /interrupted by host/);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 5000, 'stopped at the limit');
    } finally {
      runner.dispose();
    }
  });

  it('SIGINT between scripts does nothing', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const first = await runner.exec('import os\nx = 1\nprint(f"pid={os.getpid()}")', []);
      const pid = Number(pidOf(first.stdout));
      assert.ok(pid > 0, first.stdout);
      process.kill(pid, 'SIGINT');
      await new Promise((r) => setTimeout(r, 200));
      const result = await runner.exec('print(x)\nprint(f"pid={os.getpid()}")', []);
      assert.strictEqual(result.returnCode, 0, result.stderr);
      assert.strictEqual(result.stdout, `1\npid=${pid}\n`);
    } finally {
      runner.dispose();
    }
  });

  it('SIGINT while a script waits cancels it before it can resume into blocking code', async () => {
    let pid = 0;
    const runner = new PyRunner({
      onToolCall: async () => {
        // The script is suspended on this call. The signal arrives with no cancel op behind it;
        // the result does, and the script would then block.
        process.kill(pid, 'SIGINT');
        await new Promise((r) => setTimeout(r, 200));
        return 'tool ok';
      },
    });
    try {
      const first = await runner.exec('import os\nprint(f"pid={os.getpid()}")', []);
      pid = Number(pidOf(first.stdout));
      assert.ok(pid > 0, first.stdout);
      const started = Date.now();
      const result = await runner.exec('import time\nprint(await test__echo({}))\ntime.sleep(30)', ECHO_TOOLS);
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(result.stdout, '');
      // Cancelled at its await (or, if the signal beat the script to it, interrupted there).
      assert.match(result.stderr, /KeyboardInterrupt: script (cancelled|interrupted) by host/);
      assert.ok(Date.now() - started < 5000, 'stopped at once, not after the blocking call');
      const after = await runner.exec('print(f"pid={os.getpid()}")', []);
      assert.strictEqual(after.stdout, `pid=${pid}\n`, 'same interpreter');
    } finally {
      runner.dispose();
    }
  });

  it('a script that resumes from an await into blocking code at its limit is stopped', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      for (let i = 0; i < 3; i++) {
        const started = Date.now();
        const result = await runner.exec('import asyncio, time\nawait asyncio.sleep(1)\ntime.sleep(5)\nprint("after")', [], undefined, { deadlineMs: 1000 });
        assert.strictEqual(result.returnCode, 1, result.stderr);
        assert.strictEqual(result.stdout, '');
        assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
        assert.ok(Date.now() - started < 3000, `stopped at the limit (${Date.now() - started}ms)`);
      }
    } finally {
      runner.dispose();
    }
  });

  it("a time limit's signal that lands in the flush before a fork, in a script's own sys.stdout, stops the script after the fork, keeping its interpreter", async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 3000 });
    try {
      assert.strictEqual((await runner.exec('kept = 41', [])).returnCode, 0);
      // The script's own sys.stdout holds the flush before the fork until the
      // limit's first signal has landed in it, and says how the runtime took it.
      const code = [
        'import os, sys, time, warnings, __main__',
        'warnings.simplefilter("ignore", DeprecationWarning)',
        'class Out:',
        '    slow = False',
        '    def write(self, s): return len(s)',
        '    def flush(self):',
        '        if Out.slow:',
        '            for _ in range(1000):',
        '                if __main__._stop.state != __main__._PENDING: break',
        '                time.sleep(0.01)',
        '            os.write(1, ("in the flush, the stop was " + __main__._stop.state + "\\n").encode())',
        'sys.stdout = Out()',
        'Out.slow = True',
        'pid = os.fork()',
        'if pid == 0:',
        '    os._exit(0)',
        'Out.slow = False',
        'os.waitpid(pid, 0)',
        'time.sleep(30)',
      ].join('\n');
      const result = await within(runner.exec(code, [], undefined, { deadlineMs: 1000 }), 'the script to stop');
      assert.strictEqual(result.stdout, 'in the flush, the stop was requested\n');
      assert.strictEqual(result.returnCode, 1, result.stderr);
      assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/);
      assert.doesNotMatch(result.stderr, /couldn't be sent|killed/);
      assert.strictEqual((await runner.exec('print(kept)', [])).stdout, '41\n', 'the same interpreter');
    } finally {
      runner.dispose();
    }
  });

  it("the runtime's stop table: each place a signal or cancel op can land stops the script once", () => {
    const dir = mkdtempSync(join(tmpdir(), 'pytc-stop-rows-'));
    try {
      writeFileSync(join(dir, 'runtime.py'), PYTHON_RUNTIME_SOURCE);
      writeFileSync(join(dir, 'driver.py'), PYTC_STOP_ROWS_DRIVER);
      type Row = { rc: number | null; tail: string; secs: number; ops: string[] };
      const rows = JSON.parse(
        execFileSync('python3', [join(dir, 'driver.py'), join(dir, 'runtime.py')], { encoding: 'utf8', timeout: 60_000 }),
      ) as Record<string, Row>;
      const printed = (row: Row, line: string) => row.tail.split('\n').includes(line);
      const interrupted = /KeyboardInterrupt: script interrupted by host/;
      const cancelled = /KeyboardInterrupt: script cancelled by host/;
      const stopped = (name: string, how: RegExp, has: string[] = [], hasNot: string[] = []) => {
        const row = rows[name];
        assert.ok(row, name);
        assert.strictEqual(row.rc, 1, `${name}: ${row.tail}`);
        assert.match(row.tail, how, name);
        for (const w of has) assert.ok(printed(row, w), `${name}: printed ${w}`);
        for (const w of hasNot) assert.ok(!printed(row, w), `${name}: did not print ${w}`);
        assert.ok(row.secs < 2, `${name}: stopped at once (${row.secs}s)`);
      };
      const finished = (name: string, has: string[]) => {
        const row = rows[name];
        assert.ok(row, name);
        assert.strictEqual(row.rc, 0, `${name}: ${row.tail}`);
        for (const w of has) assert.ok(printed(row, w), `${name}: printed ${w}`);
        assert.doesNotMatch(row.tail, /by host/, `${name}: never stopped (again) by us`);
      };

      stopped('1 own code', interrupted, ['a'], ['b']);
      stopped('2 waiting on an await', cancelled, [], ['b']);
      // Cancelling inside the handler here raised InvalidStateError out of main().
      stopped('3 mid-dispatch, reply behind', cancelled, [], ['woke']);
      stopped('4 protocol write', cancelled, [], ['b']);
      assert.ok(rows['4 protocol write'].ops.includes('tool_call'), 'the protocol line stayed whole');
      stopped('5 reply ahead, then await', cancelled, ['woke'], ['b']);
      // Interrupted in its blocking code; the queued cancellation must not cut its cleanup short.
      finished('6 reply ahead, then block', ['woke', 'cleaned']);
      finished('7 reply ahead, then finish', ['woke']);
      finished('7 next script', ['ok']);
      stopped('8 before start, signal', cancelled, [], ['ran']);
      // The cancel op before the script started used to leave it reporting nothing.
      stopped('8 before start, cancel op', cancelled, [], ['ran']);
      finished('9 cancel op first', ['cleaned']);
      finished('10 after delivery', ['cleaned']);
      finished('11 reporting', ['done']);
      finished('12 between scripts', ['ok']);
      if (rows['13 next script blocks']) {
        // Python 3.12+: an eager task factory left installed by an earlier script.
        finished('13 eager task factory installed', ['installed']);
        stopped('13 next script blocks', interrupted, ['a'], ['b']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an eager task factory installed by an earlier script does not hide the next one from the deadline', async (t) => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 3000 });
    try {
      const install = await runner.exec(
        'import asyncio, sys\nif sys.version_info >= (3, 12):\n    asyncio.get_running_loop().set_task_factory(asyncio.eager_task_factory)\n    print("installed")',
        [],
      );
      assert.strictEqual(install.returnCode, 0, install.stderr);
      if (install.stdout !== 'installed\n') {
        t.skip('asyncio.eager_task_factory needs Python 3.12+');
        return;
      }
      const started = Date.now();
      const result = await runner.exec('import time\nprint("before")\ntime.sleep(30)', [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.aborted, undefined, 'interrupted, not killed');
      assert.strictEqual(result.stdout, 'before\n');
      assert.match(result.stderr, /KeyboardInterrupt: script interrupted by host/);
      assert.match(result.stderr, /script stopped: it reached its 1s time limit/);
      assert.ok(Date.now() - started < 2500, `stopped at the limit (${Date.now() - started}ms)`);
    } finally {
      runner.dispose();
    }
  });

  it('a script that ignores the interrupt is killed after the grace, and its interpreter state is gone', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500 });
    try {
      assert.strictEqual((await runner.exec('x = 41', [])).returnCode, 0);
      const code = 'import time\ntry:\n    time.sleep(60)\nexcept KeyboardInterrupt:\n    time.sleep(60)';
      const started = Date.now();
      const killed = await runner.exec(code, [], undefined, { deadlineMs: 1000, ceilingMs: 2000 });
      assert.strictEqual(killed.aborted, true);
      assert.strictEqual(killed.returnCode, 1);
      assert.strictEqual(
        killed.stderr,
        'script stopped: it reached its 1s time limit and did not respond, so it was killed and the interpreter restarted (variables from earlier scripts are gone). '
          + 'Tool calls it had already made keep their effects, so check them before running it again. To give it longer, pass time_limit_ms up to 2000 (2s).',
      );
      assert.ok(Date.now() - started < 5000, `killed after the grace (${Date.now() - started}ms)`);
      const after = await runner.exec('print(x)', []);
      assert.strictEqual(after.returnCode, 1);
      assert.match(after.stderr, /NameError: name 'x' is not defined/);
    } finally {
      runner.dispose();
    }
  });

  it('a background script killed at its lifetime is not told of an interpreter it never shared', async () => {
    const runner = new PyRunner({ onToolCall: async () => '', cancelGraceMs: 500, idleReclaimMs: 0 });
    try {
      const code = 'import time\ntry:\n    time.sleep(60)\nexcept KeyboardInterrupt:\n    time.sleep(60)';
      const killed = await runner.exec(code, [], { logPath: null, lifetimeMs: 1000, onWake: async () => null }, { ceilingMs: 1000 });
      assert.strictEqual(killed.aborted, true);
      assert.strictEqual(
        killed.stderr,
        'script stopped: it reached its 1s time limit and did not respond, so it was killed. Tool calls it had already made keep their effects, '
          + 'so check them before running it again. 1s is the longest a background script runs here; starting it again runs it from the top.',
      );
    } finally {
      runner.dispose();
    }
  });

  it('a background script whose interpreter exits under it is not told of earlier scripts\' variables', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      const exited = await runner.exec('import os\nos._exit(3)', [], { logPath: null, lifetimeMs: 60_000, onWake: async () => null });
      assert.strictEqual(exited.returnCode, 1);
      assert.strictEqual(exited.stderr, "script stopped: the Python interpreter exited with code 3 while it ran, so the rest of the script didn't run. "
        + 'Tool calls it had already made keep their effects, so check them before you run it again in a new interpreter. '
        + 'If it stops the same way, check whether the script itself ends the process, for example with os._exit(); if not, ask whoever runs this host.');
    } finally {
      runner.dispose();
    }
  });

  it('the time-limit note starts on a line of its own after an interpreter exit, whose text ends without one', async () => {
    const runner = new PyRunner({ onToolCall: async () => '' });
    try {
      // The interrupt at the limit ends the interpreter, so the exit handler settles the exec.
      const code = 'import os, signal, time\nsignal.signal(signal.SIGINT, lambda *_: os._exit(3))\ntime.sleep(30)';
      const result = await runner.exec(code, [], undefined, { deadlineMs: 1000 });
      assert.strictEqual(result.returnCode, 1);
      assert.strictEqual(
        result.stderr,
        "script stopped: the Python interpreter exited with code 3 while it ran, so the rest of the script didn't run, "
          + 'and variables from earlier scripts are gone. Tool calls it had already made keep their effects, so check them before you run it again '
          + 'in a new interpreter. If it stops the same way, check whether the script itself ends the process, for example with os._exit(); '
          + 'if not, ask whoever runs this host.\n'
          + 'script stopped: it reached its 1s time limit. Tool calls it had already made keep their effects, so check them before running it again.\n',
      );
    } finally {
      runner.dispose();
    }
  });
});
