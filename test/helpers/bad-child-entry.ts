/**
 * A child that breaks the protocol, or tests the parent's reading of it, chosen
 * by argv: garbage on fd 3, a frame that isn't a message, a result frame (which
 * only a parent sends), an empty frame, or an exit with no ending; a script
 * stopped with no stop asked, or a stop answered with a reason of the child's
 * own; an ending written after the child's process has exited, by a process
 * of its own that holds fd 3; more calls at once than a script may have out, a
 * call to a name that isn't a tool, an id named again before its answer was
 * seen, a seen for a call never answered, or more wakes than the cap; a frame
 * cut off at the channel's end; an ending, and then a process that stays; a
 * crash whose stderr comes late; a call sent after a stop was asked; an answer
 * never seen before a stop; a call whose arguments, or a wake whose payload,
 * passes its cap, which the prelude would have refused; a failure whose name,
 * message and stack are far past what a return shows; and its environment on
 * stderr.
 */
import { spawn } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import { encodeFrame, encodeResultFrame, FrameDecoder, MAX_FRAME_BYTES } from '../../src/code-execution/isolate/frames.js';
import { MAX_ARGUMENT_VALUES, MAX_WAKE_PAYLOAD_BYTES } from '../../src/code-execution/isolate/protocol.js';
import { MAX_BATCH_CHARS } from '../../src/code-execution/isolate/output.js';

const how = process.argv[2];
const call = (id: number, name = 'echo', args = '{}') => writeSync(3, encodeFrame({ t: 'call', id, name, args }));
/** The parent's frames, each handed to `on`, for the modes that answer them. */
function parentFrames(on: (frame: { t: string; id?: number }) => void): void {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES, true);
  process.stdin.on('data', (chunk: Buffer) => {
    for (const value of decoder.push(chunk)) on(value as { t: string; id?: number });
  });
}
const SELF_TIMED = new Set([
  'stopped-as-agent', 'finished-then-hold', 'call-after-stop', 'no-seen-then-stop', 'late-stderr',
  'seen-queued', 'half-frame-on-stop', 'reuse-after-answer', 'wakes-then-ignore-stop', 'exit-holding-fd3', 'wakes-then-exit-holding-fd3',
  'reuse-timed-out-id', 'wakes-after-stop', 'calls-then-exit-on-gate', 'late-call', 'wake-then-exit-on-gate', 'wakes-then-garbage-on-gate',
]);
/** A process of its own that holds this one's fd 3 for `ms` after this one has gone, writing nothing. */
const holdFd3 = (ms: number) => spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: ['ignore', 'ignore', 'ignore', 3] }).unref();
/** As holdFd3, until the file `gate` appears, and 20 s at most. */
const holdFd3Until = (gate: string) => spawn(process.execPath, ['-e', [
  "const fs = require('node:fs');",
  `setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) process.exit(0); }, 10);`,
  'setTimeout(() => process.exit(0), 20000);',
].join('\n')], { stdio: ['ignore', 'ignore', 'ignore', 3] }).unref();
if (how === 'stopped-as-agent') {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES, true);
  process.stdin.on('data', (chunk: Buffer) => {
    for (const value of decoder.push(chunk)) {
      if ((value as { t?: string }).t !== 'stop') continue;
      writeSync(3, encodeFrame({ t: 'end', how: 'stopped', reason: 'agent' }));
      process.exit(0);
    }
  });
} else if (how === 'held-fd3') {
  // fd 3 stays open for 10 s after this process has gone, held by a process of its own, which writes nothing.
  const held = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10_000)'], { stdio: ['ignore', 'ignore', 'ignore', 3] });
  held.unref();
} else if (how === 'late-end') {
  // The ending comes 300 ms after this process has gone, through the fd 3 it shares.
  const late = spawn(process.execPath, ['-e', `setTimeout(() => require('node:fs').writeSync(3, Buffer.from(process.env.FRAME, 'base64')), 300)`], {
    stdio: ['ignore', 'ignore', 'ignore', 3],
    env: { FRAME: encodeFrame({ t: 'end', how: 'finished', value: '"late"' }).toString('base64') },
  });
  late.unref();
}
if (how === 'seventeen-calls') for (let id = 1; id <= 17; id++) call(id);
else if (how === 'undeclared-call') call(1, 'nope');
else if (how === 'reused-id') {
  call(1);
  call(1);
} else if (how === 'unanswered-seen') writeSync(3, encodeFrame({ t: 'seen', id: 5 }));
else if (how === 'wakes-past-cap') for (let id = 1; id <= 3; id++) call(id, '(wake_agent)', 'null');
else if (how === 'args-past-caps') call(1, 'echo', JSON.stringify({ values: new Array(MAX_ARGUMENT_VALUES + 1).fill(0) }));
else if (how === 'wake-past-payload') call(1, '(wake_agent)', JSON.stringify('x'.repeat(MAX_WAKE_PAYLOAD_BYTES + 1)));
else if (how === 'long-failure') {
  writeSync(3, encodeFrame({ t: 'end', how: 'failed', error: { name: 'N'.repeat(100_000), message: 'm'.repeat(100_000), stack: 's'.repeat(100_000) } }));
}
else if (how === 'cut-frame') {
  // A header that announces 100 bytes, and 10 of them.
  const header = Buffer.alloc(4);
  header.writeUInt32BE(100, 0);
  writeSync(3, Buffer.concat([header, Buffer.alloc(10, 0x7b)]));
} else if (how === 'finished-then-hold') {
  writeSync(3, encodeFrame({ t: 'end', how: 'finished', value: '1' }));
  setInterval(() => {}, 60_000);
} else if (how === 'late-stderr') {
  // The words come 300 ms after this process has gone, through the stderr a process of its own holds.
  const late = spawn(process.execPath, ['-e', `setTimeout(() => process.stderr.write('words that came late\\n'), 300)`], { stdio: ['ignore', 'ignore', 2] });
  late.unref();
  process.exit(3);
} else if (how === 'call-after-stop') {
  parentFrames((frame) => {
    if (frame.t !== 'stop') return;
    call(1);
    writeSync(3, encodeFrame({ t: 'end', how: 'stopped' }));
    process.exit(0);
  });
} else if (how === 'no-seen-then-stop') {
  call(1);
  // Its answer comes and is never seen; then the stop.
  parentFrames((frame) => {
    if (frame.t !== 'stop') return;
    writeSync(3, encodeFrame({ t: 'end', how: 'stopped' }));
    process.exit(0);
  });
} else if (how === 'env') process.stderr.write(`${JSON.stringify(Object.keys(process.env))}\n`);
else if (how === 'garbage') writeSync(3, Buffer.from([0xff, 0xff, 0xff, 0xff, 1, 2, 3]));
else if (how === 'not-a-message') writeSync(3, encodeFrame({ t: 'call', id: -1, name: 'x', args: '{}' }));
else if (how === 'result-kind') writeSync(3, encodeResultFrame(1, true, '{}', 1024));
else if (how === 'empty') writeSync(3, Buffer.from([0, 0, 0, 0]));
else if (how === 'silent-exit') process.stderr.write('the child had something to say on its way out\n');
// With a reason of its own, which an earlier version of the protocol took from the child.
else if (how === 'stopped-unasked') writeSync(3, encodeFrame({ t: 'end', how: 'stopped', reason: 'agent' }));
else if (how === 'seen-queued') {
  // Calls with large answers it never reads, so the parent's queue holds the
  // second; once the gate file (argv[3]) appears, a seen for that second answer.
  call(1, 'echo', '{"n":1}');
  call(2, 'echo', '{"n":2}');
  const gate = process.argv[3]!;
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    writeSync(3, encodeFrame({ t: 'seen', id: 2 }));
    setTimeout(() => process.exit(0), 50);
  }, 10);
} else if (how === 'half-frame-on-stop') {
  // Ready once its listener is on; at a stop, half a frame, and then nothing until the grace's kill.
  writeSync(3, encodeFrame({ t: 'out', text: 'ready' }));
  parentFrames((frame) => {
    if (frame.t !== 'stop') return;
    // It says so first, then writes the half frame at once.
    writeSync(3, encodeFrame({ t: 'out', text: 'cutting' }));
    const header = Buffer.alloc(4);
    header.writeUInt32BE(100, 0);
    writeSync(3, Buffer.concat([header, Buffer.alloc(10, 0x7b)]));
  });
  setInterval(() => {}, 60_000);
} else if (how === 'reuse-after-answer') {
  // Call 1, and once its answer has come, call 1 again before saying it was seen.
  call(1);
  parentFrames((frame) => {
    if (frame.t === 'result' && frame.id === 1) call(1);
  });
  setTimeout(() => process.exit(0), 5_000);
} else if (how === 'seen-pending') {
  // A seen for a call whose answer hasn't come.
  call(1, 'slow');
  writeSync(3, encodeFrame({ t: 'seen', id: 1 }));
} else if (how === 'huge-out') writeSync(3, encodeFrame({ t: 'out', text: 'x'.repeat(MAX_BATCH_CHARS + 1) }));
else if (how === 'many-values-frame') writeSync(3, encodeFrame({ t: 'out', text: 'x', more: Array.from({ length: 40 }, () => 0) }));
else if (how === 'wakes-then-ignore-stop') {
  // Two wakes, the second waiting out the spacing; a stop is ignored for 1.5 s.
  call(1, '(wake_agent)', '1');
  call(2, '(wake_agent)', '2');
  parentFrames((frame) => {
    if (frame.t !== 'stop') return;
    setTimeout(() => {
      writeSync(3, encodeFrame({ t: 'end', how: 'stopped' }));
      process.exit(0);
    }, 1_500);
  });
} else if (how === 'exit-holding-fd3') {
  // Gone without an ending, with fd 3 held open for 1.5 s.
  holdFd3(1_500);
  setTimeout(() => process.exit(0), 50);
} else if (how === 'wakes-then-exit-holding-fd3') {
  // Two wakes, the second waiting out the spacing; then gone, with fd 3 held open for 1.5 s.
  call(1, '(wake_agent)', '1');
  call(2, '(wake_agent)', '2');
  holdFd3(1_500);
  setTimeout(() => process.exit(0), 100);
}
if (!SELF_TIMED.has(how)) setTimeout(() => process.exit(how === 'silent-exit' || how === 'env' ? 3 : 0), 50);

if (how === 'reuse-timed-out-id') {
  // Call 1, and each time its TimeoutError comes, say the script saw it and call 1 again, 20 times.
  let calls = 1;
  call(1, 'slow', '{"hold":true}');
  parentFrames((frame) => {
    if (frame.t !== 'result' || frame.id !== 1 || calls >= 20) return;
    writeSync(3, encodeFrame({ t: 'seen', id: 1 }));
    calls += 1;
    call(1, 'slow', '{"hold":true}');
  });
  setInterval(() => {}, 60_000);
} else if (how === 'wakes-after-stop') {
  // Ready once its listener is on; at a stop, as many wakes as argv[3] says, each with an id of its own, none seen,
  // and then it says it stopped and exits.
  writeSync(3, encodeFrame({ t: 'out', text: 'ready' }));
  parentFrames((frame) => {
    if (frame.t !== 'stop') return;
    for (let id = 1; id <= Number(process.argv[3]); id++) call(id, '(wake_agent)', '"after"');
    writeSync(3, encodeFrame({ t: 'end', how: 'stopped', reason: 'agent' }));
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
} else if (how === 'calls-then-exit-on-gate') {
  // 16 calls the bridge holds, each seen once its TimeoutError comes, which
  // frees its place in the script, and then a 17th, which waits for room in
  // the host; once the gate file (argv[3]) appears, gone, with fd 3 held open for 1.5 s.
  for (let id = 1; id <= 16; id++) call(id, 'slow', `{"hold":true,"i":${id}}`);
  let seen = 0;
  parentFrames((frame) => {
    if (frame.t !== 'result') return;
    writeSync(3, encodeFrame({ t: 'seen', id: frame.id }));
    if (++seen === 16) call(17, 'slow', '{"hold":true,"i":17}');
  });
  const gate = process.argv[3]!;
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    holdFd3(1_500);
    process.exit(0);
  }, 10);
} else if (how === 'late-call') {
  // Gone at once; a process of its own, holding the fd 3 it shares, writes a
  // call frame once the gate file (argv[3]) appears, which the test makes
  // once it has seen this one's exit, and holds fd 3 a little after.
  const late = spawn(process.execPath, ['-e', [
    "const fs = require('node:fs');",
    'const poll = setInterval(() => {',
    '  if (!fs.existsSync(process.env.GATE)) return;',
    '  clearInterval(poll);',
    "  fs.writeSync(3, Buffer.from(process.env.FRAME, 'base64'));",
    '  setTimeout(() => process.exit(0), 300);',
    '}, 10);',
    'setTimeout(() => process.exit(0), 20000);',
  ].join('\n')], {
    stdio: ['ignore', 'ignore', 'ignore', 3],
    env: { FRAME: encodeFrame({ t: 'call', id: 1, name: 'echo', args: '{"late":true}' }).toString('base64'), GATE: process.argv[3]! },
  });
  late.unref();
  process.exit(0);
} else if (how === 'long-value') writeSync(3, encodeFrame({ t: 'end', how: 'finished', value: JSON.stringify('v'.repeat(100_000)) }));
else if (how === 'frame-at-cap') {
  // An ending whose frame's body is exactly the longest a child sends (argv[3] bytes).
  const frame = (n: number) => encodeFrame({ t: 'end', how: 'finished', value: JSON.stringify('v'.repeat(n)) });
  const bodyOf = (n: number) => frame(n).length - 4;
  writeSync(3, frame(Number(process.argv[3]) - bodyOf(0)));
}
else if (how === 'big-arg-string') call(1, 'echo', JSON.stringify({ s: 'x'.repeat(5 * 1024 * 1024) }));
else if (how === 'oversized-frame') {
  // A header naming one byte more than the longest frame a child sends.
  const header = Buffer.alloc(4);
  header.writeUInt32BE(Number(process.argv[3]) + 1, 0);
  writeSync(3, header);
}
if (how === 'wakes-then-garbage-on-gate') {
  // Two wakes, the second waiting out the spacing; once the gate file (argv[3]) appears, a frame the host can't read.
  call(1, '(wake_agent)', '1');
  call(2, '(wake_agent)', '2');
  const gate = process.argv[3]!;
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    writeSync(3, encodeFrame({ t: 'bogus' }));
    // It stays until the host kills it, so its exit can't come before the frame is read.
    setInterval(() => {}, 60_000);
  }, 10);
}
if (how === 'wake-then-exit-on-gate') {
  // Two wakes, the second waiting out the spacing; once the gate file (argv[3]) appears, gone, with fd 3 held open until a second gate file (argv[4]) appears.
  call(1, '(wake_agent)', '1');
  call(2, '(wake_agent)', '2');
  const gate = process.argv[3]!;
  const poll = setInterval(() => {
    if (!existsSync(gate)) return;
    clearInterval(poll);
    holdFd3Until(process.argv[4]!);
    process.exit(0);
  }, 10);
}
