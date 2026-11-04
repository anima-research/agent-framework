/**
 * A script's child started as the runner starts one, under this process, which
 * names itself the child's parent. Once the guest says it's running, by an
 * output frame on fd 3, this prints the child's pid; the orphan test then
 * kills this process, so the child is orphaned for real, mid-run.
 */
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { encodeFrame, FrameDecoder } from '../../src/code-execution/isolate/frames.js';

const [entry] = process.argv.slice(2);
const child = spawn(process.execPath, [entry!], { stdio: ['pipe', 'ignore', 'ignore', 'pipe'], cwd: process.env.CHILD_DIR, env: {} });
child.stdin!.write(encodeFrame({ ...JSON.parse(process.env.START!), parentPid: process.pid }));
const decoder = new FrameDecoder();
let told = false;
(child.stdio[3] as Readable).on('data', (chunk: Buffer) => {
  for (const frame of decoder.push(chunk)) {
    if (!told && (frame as { t?: string }).t === 'out') {
      told = true;
      process.stdout.write(`${child.pid}\n`);
    }
  }
});
child.on('close', (code, signal) => {
  if (told) return;
  process.stderr.write(`the child exited before its first output: code ${code}, signal ${signal}\n`);
  process.exit(1);
});
setInterval(() => {}, 60_000);
