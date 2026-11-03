/** The isolate's settings: defaults, each key the Python runner took refused by name, and values out of range. */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildCodeExecutionToolDefinition, bunVersionProblem, DEFAULT_SETTINGS, isolateSettings, validateCodeExecutionConfig } from '../src/code-execution/tool-definition.js';

test('an empty configuration takes every default, each the value the docs give', () => {
  assert.deepEqual(isolateSettings({ enabled: true }), DEFAULT_SETTINGS);
  // The values the docs and the tool's description promise, pinned here rather than read back from the implementation.
  assert.deepEqual(DEFAULT_SETTINGS, {
    yieldMs: 30_000,
    maxYieldMs: 600_000,
    scriptLifetimeMs: 86_400_000,
    maxRunningScripts: 3,
    maxScriptChildren: 16,
    toolCallTimeoutMs: 270_000,
    wakeMinIntervalMs: 60_000,
    maxWakesPerScript: 100,
    memoryMaxBytes: 128 * 1024 * 1024,
  });
});

for (const [key, replacement] of [
  ['pythonPath', /no interpreter to name/],
  ['idleReclaimMs', /nothing to reclaim/],
  ['env', /no environment/],
  ['inheritEnv', /no environment/],
  ['scriptTimeoutMs', /set yieldMs/],
  ['maxScriptTimeoutMs', /set maxYieldMs/],
  ['backgroundMaxLifetimeMs', /set scriptLifetimeMs/],
  ['maxBackgroundScripts', /set maxRunningScripts/],
] as const) {
  test(`codeExecution.${key} is refused, naming what to do instead`, () => {
    assert.throws(() => isolateSettings({ enabled: true, [key]: key === 'inheritEnv' ? true : 1000 }), (e: Error) =>
      e.message.startsWith(`codeExecution.${key} is no longer read:`) && replacement.test(e.message));
  });
}

test('values out of range are refused by name', () => {
  assert.throws(() => isolateSettings({ yieldMs: -1 }), /codeExecution\.yieldMs must be a whole number/);
  assert.throws(() => isolateSettings({ yieldMs: 1.5 }), /codeExecution\.yieldMs must be a whole number/);
  assert.throws(() => isolateSettings({ maxYieldMs: 2_147_483_648 }), /at most 2147483647 ms/);
  assert.throws(() => isolateSettings({ yieldMs: 60_000, maxYieldMs: 30_000 }), /must be at least yieldMs/);
  assert.throws(() => isolateSettings({ maxRunningScripts: 0 }), /at least 1/);
  assert.throws(() => isolateSettings({ memoryMaxBytes: 100_000_000 }), /whole number of 64 KiB pages/);
  assert.throws(() => isolateSettings({ memoryMaxBytes: 2 * 1024 * 1024 }), /from 4194304 \(4 MiB\)/);
  assert.throws(() => isolateSettings({ memoryMaxBytes: 2 * 1024 * 1024 * 1024 + 64 * 1024 }), /to 2147483648 \(2 GiB\)/);
  assert.throws(() => isolateSettings({ maxScriptChildren: 0 }), /at least 1/);
  assert.equal(isolateSettings({ memoryMaxBytes: 64 * 1024 * 1024 }).memoryMaxBytes, 64 * 1024 * 1024);
});

test("the description says the settings' values", () => {
  const description = buildCodeExecutionToolDefinition({ enabled: true, memoryMaxBytes: 256 * 1024 * 1024, maxRunningScripts: 5, toolCallTimeoutMs: 90_000 }).description;
  assert.match(description, /A script has 256 MiB of memory\./);
  assert.match(description, /You may have 5 scripts running at once\./);
  assert.match(description, /default 30 s, at most 10 min/);
  assert.match(description, /its limit of 24 h/);
  assert.match(description, /up to 4 MiB of JSON with at most 100,000 values/);
  assert.match(description, /a payload of at most 64 KiB of JSON/);
  assert.match(description, /up to 16 are out at once/);
  assert.match(description, /A call out that gets no answer within 90 s throws a TimeoutError that says whether it was sent: one never sent did nothing, but one sent may still take effect/);
  assert.match(description, /The value comes back as JSON, and past 8,000 characters as its first and last 4,000\./);
  // A duration that isn't a whole second is said exactly.
  assert.match(buildCodeExecutionToolDefinition({ enabled: true, yieldMs: 1_500 }).description, /default 1\.5 s, at most 10 min/);
});

test("the definition takes create()'s settings, each left out at its default, and refuses the Python runner's by name", () => {
  const documentedDefaults = {
    enabled: true, yieldMs: 30_000, maxYieldMs: 600_000, scriptLifetimeMs: 86_400_000, maxRunningScripts: 3, maxScriptChildren: 16,
    toolCallTimeoutMs: 270_000, wakeMinIntervalMs: 60_000, maxWakesPerScript: 100, memoryMaxBytes: 128 * 1024 * 1024,
  };
  assert.equal(buildCodeExecutionToolDefinition().description, buildCodeExecutionToolDefinition(documentedDefaults).description);
  assert.equal(buildCodeExecutionToolDefinition({ enabled: true, yieldMs: 5_000 }).description, buildCodeExecutionToolDefinition({ ...documentedDefaults, yieldMs: 5_000 }).description);
  assert.throws(() => buildCodeExecutionToolDefinition({ scriptTimeoutMs: 1_000 } as never), /codeExecution\.scriptTimeoutMs is no longer read: .*yieldMs/);
});

test('code execution needs Bun 1.4.0 or later: the check create() runs refuses it on an older Bun, saying why', () => {
  for (const ok of [null, '1.4.0', '1.4.3', '1.10.0', '2.0.0', '1.4.1-canary.3']) assert.equal(bunVersionProblem(ok), null, String(ok));
  for (const old of ['1.3.14', '1.2.0', '0.9.9']) {
    assert.match(bunVersionProblem(old) ?? '', new RegExp(`^codeExecution needs Bun 1\\.4\\.0 or later, and this host runs Bun ${old.replace(/\./g, '\\.')}, which at some starts loses the pipe`), old);
  }
  // A prerelease of the floor's own version comes before it, and wasn't checked: the refusal says that, not the pipe.
  assert.match(
    bunVersionProblem('1.4.0-canary.12') ?? '',
    /^codeExecution needs Bun 1\.4\.0 or later, and this host runs Bun 1\.4\.0-canary\.12, a build from before 1\.4\.0's release, which hasn't been checked with it: move the host to Bun 1\.4\.0 or later, or run it on Node$/,
  );
  assert.throws(() => validateCodeExecutionConfig({ enabled: true }, '1.3.14'), /codeExecution needs Bun 1\.4\.0 or later.*move the host to Bun 1\.4\.0 or later, or run it on Node/);
  // Only a configuration that turns it on is refused.
  validateCodeExecutionConfig({ enabled: false }, '1.3.14');
  validateCodeExecutionConfig({ enabled: true }, '1.4.3');
  validateCodeExecutionConfig({ enabled: true }, null);
});

test("create()'s check reads the running Bun: refused below 1.4.0, admitted from it, never under Node", () => {
  const bun = (process.versions as Record<string, string | undefined>).bun ?? null;
  const problem = bunVersionProblem(bun);
  if (bun === null) assert.equal(problem, null);
  if (problem === null) validateCodeExecutionConfig({ enabled: true });
  else assert.throws(() => validateCodeExecutionConfig({ enabled: true }), new RegExp(`this host runs Bun ${bun!.replace(/\./g, '\\.')}`));
  // CI runs this file under Bun 1.3.14, 1.4.0 and 1.4.3 as well as Node, so each side is taken somewhere.
  if (bun === '1.3.14') assert.notEqual(problem, null);
});
