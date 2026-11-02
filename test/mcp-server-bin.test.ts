// The `agent-framework-mcp` command as an install runs it: npm links
// node_modules/.bin/agent-framework-mcp to the built file and makes that file
// executable, and the shell runs the link through the file's `#!` line. Run
// that way, or by the file's own path as this repository's mcp-wrapper.sh
// runs it, the server starts: it connects to the WebSocket API before it
// reads stdin, so a connection to a stand-in API shows it started, and
// closing stdin ends it. The server's class lives in a module of its own,
// which the package root exports, so importing or bundling the package starts
// nothing, under any name.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

// The compiled test sits in dist/test/, beside dist/src/.
const BIN = fileURLToPath(new URL('../src/api/mcp-server.js', import.meta.url));
const CORE = fileURLToPath(new URL('../src/api/mcp-server-core.js', import.meta.url));
const LINE_READER = fileURLToPath(new URL('../src/line-reader.js', import.meta.url));
const ROOT_MODULE = fileURLToPath(new URL('../src/index.js', import.meta.url));
// The repository root, from which mcp-wrapper.sh runs the built file.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const LONGER_THAN_ANY_START_MS = 60_000;
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for the WebSocket API that counts the connections it gets. */
async function standInApi(): Promise<{ url: string; connections: () => number; connected: Promise<void>; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  let count = 0;
  const connected = new Promise<void>((resolve) => wss.on('connection', () => { count += 1; resolve(); }));
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    connections: () => count,
    connected,
    close: () => new Promise<void>((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => resolve());
    }),
  };
}

/** Runs `file` with `args`, stdin open until `endStdin`, and resolves with its exit code and stderr. */
function start(file: string, args: string[], env: Record<string, string>, cwd?: string) {
  const child = spawn(file, args, { cwd, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, stderr }));
  });
  child.stdin.on('error', () => {});
  return { endStdin: () => child.stdin.end(), writeStdin: (chunk: Buffer) => child.stdin.write(chunk), kill: () => child.kill(), exited };
}

function within<T>(promise: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(
      () => reject(new Error(`${what} within ${LONGER_THAN_ANY_START_MS} ms`)), LONGER_THAN_ANY_START_MS).unref()),
  ]);
}

test("the built command's first line is a '#!' line for node", () => {
  assert.equal(readFileSync(BIN, 'utf8').split('\n', 1)[0], '#!/usr/bin/env node');
});

test("run through npm's link, or by its own path, the command starts the server, and ends when stdin closes", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-bin-'));
  made.push(dir);
  mkdirSync(join(dir, '.bin'));
  const link = join(dir, '.bin', 'agent-framework-mcp');
  symlinkSync(BIN, link);
  chmodSync(BIN, 0o755); // as npm does to a bin's file when it links it
  const ways: Array<[string, string, string[], string | undefined]> = [
    ["through npm's link, by its '#!' line", link, [], undefined],
    ['by its own path, relative, as mcp-wrapper.sh runs it', process.execPath, ['dist/src/api/mcp-server.js'], ROOT],
  ];
  for (const [how, file, args, cwd] of ways) {
    const api = await standInApi();
    const run = start(file, args, { AGENT_FRAMEWORK_WS_URL: api.url }, cwd);
    try {
      try {
        await within(api.connected, `${how}: the server connected to the stand-in API`);
      } catch (error) {
        run.kill();
        throw new Error(`${(error as Error).message}; stderr: ${(await run.exited).stderr}`);
      }
      run.endStdin();
      const { code } = await within(run.exited, `${how}: the server exited after stdin closed`);
      assert.equal(code, 0, how);
      assert.equal(api.connections(), 1, how);
    } finally {
      run.kill();
      await api.close();
    }
  }
});

test('importing the package, or running its server module under the command\'s name, starts nothing; the command\'s path is not importable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-bin-import-'));
  made.push(dir);
  const rootUrl = JSON.stringify(pathToFileURL(ROOT_MODULE).href);
  const entry = join(dir, 'entry.mjs');
  writeFileSync(entry, `const { McpServer } = await import(${rootUrl});\nif (typeof McpServer !== 'function') process.exit(2);\n`);
  // An application bundling the package carries the server's module, never
  // the command: this copy, under the command's file name, with the module it
  // imports at the path it imports it from, and inside the package so it
  // resolves 'ws' as the module does, is that bundle run as the entry point.
  // It used to start the server.
  const bundleDir = join(dirname(CORE), '..', `bundle-${process.pid}`);
  mkdirSync(join(bundleDir, 'api'), { recursive: true });
  made.push(bundleDir);
  const bundle = join(bundleDir, 'api', 'mcp-server.js');
  copyFileSync(CORE, bundle);
  copyFileSync(LINE_READER, join(bundleDir, 'line-reader.js'));
  const cases: Array<[string, string[], string | undefined]> = [
    ['a host that imports the package root, from an entry script of its own', [entry], undefined],
    ['the package root imported under `node -e`', ['--input-type=module', '-e', `await import(${rootUrl});`], undefined],
    ['the server module, bundled under the name mcp-server.js and run as the entry point', [bundle], undefined],
  ];
  for (const [what, args, cwd] of cases) {
    const api = await standInApi();
    const run = start(process.execPath, args, { AGENT_FRAMEWORK_WS_URL: api.url }, cwd);
    try {
      run.endStdin();
      const { code, stderr } = await within(run.exited, `${what}: the run finished`);
      assert.equal(code, 0, `${what}: ${stderr}`);
      assert.equal(stderr, '', what);
      assert.equal(api.connections(), 0, `${what}: nothing connected to the API`);
    } finally {
      run.kill();
      await api.close();
    }
  }
  // A deep import of the command's path, by the package's own name: its
  // `exports` names only the root, so Node refuses it before loading anything.
  const deep = start(process.execPath, ['--input-type=module', '-e', "await import('@animalabs/agent-framework/dist/src/api/mcp-server.js');"], {}, ROOT);
  deep.endStdin();
  const refused = await within(deep.exited, 'the deep import finished');
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test('a request on stdin holding U+2028 or U+2029 inside a string gets its answer, and no parse error', async () => {
  const api = await standInApi();
  const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH ?? '', AGENT_FRAMEWORK_WS_URL: api.url }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await within(api.connected, 'the server connected to the stand-in API');
    let out = '';
    const lastAnswered = new Promise<void>((resolve) => child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.endsWith('\n') && out.includes('"id":9')) resolve();
    }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping', params: { note: 'one\u2028two' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping', params: { note: 'one\u2029two' } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }) + '\n');
    await within(lastAnswered, 'the server answered the last ping');
    const answers = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(answers, [7, 8, 9].map((id) => ({ jsonrpc: '2.0', id, result: {} })));
  } finally {
    child.kill();
    await api.close();
  }
});

test("the command's answers on stdout carry U+2028 and U+2029 escaped, and parse back to the same text", async () => {
  const api = await standInApi();
  const child = spawn(process.execPath, [BIN], { env: { PATH: process.env.PATH ?? '', AGENT_FRAMEWORK_WS_URL: api.url }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await within(api.connected, 'the server connected to the stand-in API');
    let out = '';
    const answered = new Promise<void>((resolve) => child.stdout.on('data', (chunk) => {
      out += String(chunk);
      if (out.endsWith('\n') && out.includes('"id":9')) resolve();
    }));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'no\u2028such\u2029method' }) + '\n');
    await within(answered, 'the server answered');
    assert.equal(/[\u2028\u2029]/.test(out), false, out);
    const answer = JSON.parse(out.trim());
    assert.equal(answer.id, 9);
    assert.equal(answer.error.message, 'Method not found: no\u2028such\u2029method');
  } finally {
    child.kill();
    await api.close();
  }
});

test('a line on stdin longer than 104,857,600 UTF-16 code units ends the server with code 1 and one stderr line naming the bound', async () => {
  const api = await standInApi();
  const run = start(process.execPath, [BIN], { AGENT_FRAMEWORK_WS_URL: api.url });
  try {
    await within(api.connected, 'the server connected to the stand-in API');
    run.writeStdin(Buffer.alloc(104_857_601, 0x78));
    const { code, stderr } = await within(run.exited, 'the server exited after the long line');
    assert.deepEqual({ code, stderr }, { code: 1, stderr: 'MCP server stopped: a line on stdin was longer than 104,857,600 UTF-16 code units\n' });
  } finally {
    run.kill();
    await api.close();
  }
});
