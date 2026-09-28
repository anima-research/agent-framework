/**
 * The code-execution child runs MODEL-AUTHORED code. It must not inherit the
 * host's secrets any more than an MCPL connector child does (#175): on a
 * multi-resident host the .env carries provider keys and every bot's token,
 * and `os.environ` would hand all of them to any agent with code_execution.
 * Same operating allowlist as stdio MCPL children, plus the runner's own
 * declared env; `inheritEnv: true` restores full inheritance.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PyRunner } from '../src/index.js';

test('model-authored python does not see a host secret', async () => {
  const key = 'AF_CODE_EXEC_TEST_HOST_SECRET';
  process.env[key] = 'must-not-leak';
  const runner = new PyRunner({ onToolCall: async () => '' });
  try {
    const r = await runner.exec(`import os; print(repr(os.environ.get(${JSON.stringify(key)})))`, []);
    assert.equal(r.returnCode, 0, r.stderr);
    assert.match(r.stdout, /None/, `the code-execution child inherited a host secret: ${r.stdout.trim()}`);
  } finally {
    runner.dispose();
    delete process.env[key];
  }
});

test('declared env reaches the interpreter; inheritEnv restores the host env', async () => {
  const key = 'AF_CODE_EXEC_TEST_HOST_SECRET';
  process.env[key] = 'must-not-leak';
  const declared = new PyRunner({ onToolCall: async () => '', env: { AF_CODE_EXEC_DECLARED: 'yes' } });
  const inheriting = new PyRunner({ onToolCall: async () => '', inheritEnv: true });
  try {
    const d = await declared.exec(`import os; print(os.environ.get('AF_CODE_EXEC_DECLARED'), repr(os.environ.get(${JSON.stringify(key)})))`, []);
    assert.match(d.stdout, /^yes None/m, d.stdout + d.stderr);
    const i = await inheriting.exec(`import os; print(repr(os.environ.get(${JSON.stringify(key)})))`, []);
    assert.match(i.stdout, /must-not-leak/, i.stdout + i.stderr);
  } finally {
    declared.dispose(); inheriting.dispose();
    delete process.env[key];
  }
});
