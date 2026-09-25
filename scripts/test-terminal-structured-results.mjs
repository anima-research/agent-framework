#!/usr/bin/env node
// Optional cross-repository acceptance: real termd, host, shell and Python;
// MockMembrane supplies no model responses. Both repositories must be built.
// node scripts/test-terminal-structured-results.mjs /path/to/terminal-sessions-mcp
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentFramework } from '../dist/src/index.js';
import { MockMembrane } from '../dist/test/helpers/mock-membrane.js';

if (!process.argv[2]) throw new Error('Usage: node scripts/test-terminal-structured-results.mjs /path/to/terminal-sessions-mcp');
const termRoot = resolve(process.argv[2]);
const load = (file) => import(pathToFileURL(join(termRoot, 'next/dist/src', file)).href);
const { App } = await load('api/app.js');
const { SessionRegistry } = await load('api/registry.js');
const { TokenMapResolver } = await load('api/principals.js');
const { NodePtyBackend } = await load('backends/node-pty.js');
const { TermServer } = await load('transport/server.js');

const dir = mkdtempSync(join(tmpdir(), 'af-terminal-structured-'));
const registry = new SessionRegistry({ dataDir: join(dir, 'terminal'), backend: new NodePtyBackend(), defaultShell: '/bin/bash', noUserRc: true });
const app = new App({ registry });
const server = new TermServer({ app, resolver: new TokenMapResolver({ tokens: { test: 'agent:acceptance@test' } }), host: '127.0.0.1', port: 0, version: 'acceptance' });
let framework;
try {
  const { port } = await server.listen();
  const membrane = new MockMembrane();
  framework = await AgentFramework.create({
    storePath: join(dir, 'af.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'worker', model: 'test-model', systemPrompt: 'test' }],
    modules: [], syncIntervalMs: 0, codeExecution: { enabled: true },
    // Only tool calls here. Completion wake/delivery is a separate acceptance
    // contract, exercised by terminal-sessions' next/acceptance/ scripts.
    mcplServers: [{ id: 'terminal', url: `ws://127.0.0.1:${port}/?resultText=transcript`, token: 'test', toolPrefix: 'terminal', enabledFeatureSets: ['terminal.core'] }],
  });
  framework.start();
  const execute = (name, input) => framework.executeToolCall({ id: `accept-${name}`, name, input, callerAgentName: 'worker' });
  const python = async (code) => {
    const result = await execute('code_execution', { code });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.data.return_code, 0, result.data.stderr);
    return result.data.stdout;
  };

  const direct = await execute('terminal--run', { session: 'acceptance', target: 'process', command: 'printf direct-readable', wait: 5000 });
  assert.equal(direct.success, true);
  assert.equal(direct.structuredContent.state, 'exited');
  assert.match(JSON.stringify(direct.data), /direct-readable/);
  assert.ok(!JSON.stringify(direct.data).includes('nextCursor'), 'transcript mode is in effect');
  console.log('PASS: direct calls retain both transcript and structured envelope');

  // A file barrier keeps the command alive deterministically until Python
  // has finished observing it, without racing a short wall-clock sleep.
  const barrier = join(dir, 'release');
  const command = `while [ ! -f '${barrier}' ]; do sleep 0.05; done; printf python-structured`;
  const first = await python([
    'import json',
    `r = json.loads(await terminal__run(${JSON.stringify({ session: 'acceptance', target: 'process', command, wait: 0 })}))`,
    'assert r["state"] == "running", r',
    'assert r["runId"] and "nextCursor" in r["output"] and "truncated" in r["output"], r',
    'print(json.dumps({"runId": r["runId"], "state": r["state"]}))',
  ].join('\n'));
  assert.equal(JSON.parse(first).state, 'running');
  console.log('PASS: Python finishes with a running terminal Run and a retained runId');

  const second = await python([
    'from pathlib import Path',
    `Path(${JSON.stringify(barrier)}).touch()`,
    'done = json.loads(await terminal__await({"runId": r["runId"], "wait": 5000}))',
    'assert done["state"] == "exited" and done["exit"] == 0, done',
    'assert "python-structured" in done["output"]["text"], done',
    'print(json.dumps({"runId": done["runId"], "state": done["state"], "exit": done["exit"]}))',
  ].join('\n'));
  assert.equal(JSON.parse(second).runId, JSON.parse(first).runId);
  assert.equal(membrane.calls.length, 0, 'this test uses no live model');
  console.log('PASS: a later Python call awaits the same terminal Run and reads its exit');
} finally {
  await framework?.stop();
  await server.close();
  await registry.closeAll();
  rmSync(dir, { recursive: true, force: true });
}
