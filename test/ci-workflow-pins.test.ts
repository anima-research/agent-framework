/**
 * Two things ci.yml decides from what a test can read:
 *
 * - How many test files run at once. ci.yml's Build & Test and publish.yml's
 *   Test step run the suite through scripts/test-as-ci.mjs, which runs npm
 *   test with AF_TEST_CONCURRENCY at twice the machine's cores, and npm test
 *   passes it on as --test-concurrency only when it is set. If a workflow ran
 *   npm test another way, or either side dropped the variable, the suite would
 *   go back to Node's default of one file fewer than the cores, and nothing
 *   else would fail: these tests do. The script exits as npm test does, so a
 *   failing suite fails the step.
 * - When a pull request runs code_execution's Bun legs on macOS. The
 *   `changes` job runs them when the diff matches a filter. Every file those
 *   tests import or load by path, directly or through others, must match it,
 *   or a change to that file skips the legs that test it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');
const exists = (path: string) => existsSync(new URL(path, ROOT));

/** A line that runs npm test, however it's spelled: `npm test`, `npm run test`, `npm t`, with arguments or not. */
const NPM_TEST_LINE = /^\s*(?:run: )?npm (?:run )?(?:test|t)\b(?!:)/m;

/** The steps of a workflow file that run `npm test`, each as its text from its `- name:` line to the next step's. */
function npmTestSteps(workflow: string): string[] {
  const steps = workflow.split(/\n(?= {6}- (?:name|uses):)/);
  return steps.filter((step) => NPM_TEST_LINE.test(step));
}

test("npm test passes AF_TEST_CONCURRENCY as --test-concurrency, only when it's set, before --test-timeout", () => {
  const npmTest = (JSON.parse(read('package.json')) as { scripts: { test: string } }).scripts.test;
  assert.match(
    npmTest,
    / --test-force-exit \$\{AF_TEST_CONCURRENCY:\+--test-concurrency=\$AF_TEST_CONCURRENCY\} --test-timeout=/,
  );
});

for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/publish.yml']) {
  test(`${workflow} runs the suite through scripts/test-as-ci.mjs, and no step runs npm test itself`, () => {
    const text = read(workflow);
    assert.match(text, /^\s*run: node scripts\/test-as-ci\.mjs\s*$/m);
    assert.deepEqual(npmTestSteps(text), [], `${workflow} has no step that runs npm test`);
  });
}

/** Runs scripts/test-as-ci.mjs with an `npm` ahead of PATH that writes its arguments and AF_TEST_CONCURRENCY to a
 *  file, then runs `then`; and returns how the script ended and what that npm saw. */
function testAsCi(then: string, callerWidth?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'test-as-ci-'));
  try {
    const seen = join(dir, 'seen');
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nprintf '%s|%s' "$*" "$AF_TEST_CONCURRENCY" > '${seen}'\n${then}\n`);
    chmodSync(join(dir, 'npm'), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ''}` };
    if (callerWidth === undefined) delete env.AF_TEST_CONCURRENCY;
    else env.AF_TEST_CONCURRENCY = callerWidth;
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/test-as-ci.mjs', ROOT))], { cwd: dir, env, encoding: 'utf8' });
    const [args, width] = existsSync(seen) ? readFileSync(seen, 'utf8').split('|') : [];
    return { status: run.status, signal: run.signal, stdout: run.stdout, args, width };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('scripts/test-as-ci.mjs runs npm test at the width it reports, whatever the caller set', () => {
  for (const callerWidth of [undefined, '1']) {
    const run = testAsCi('exit 0', callerWidth);
    assert.equal(run.status, 0, `exits 0 when npm test does (caller's width ${callerWidth})`);
    assert.equal(run.args, 'test');
    const reported = /test files at once: (\d+)$/m.exec(run.stdout)?.[1];
    assert.ok(reported && Number(reported) > 0, `reports a width: ${run.stdout}`);
    assert.equal(run.width, reported, 'npm test gets the width the script reports');
    if (callerWidth !== undefined) assert.notEqual(run.width, callerWidth, "npm test doesn't get the caller's width");
  }
});

test('scripts/test-as-ci.mjs fails when npm test fails', () => {
  assert.equal(testAsCi('exit 3').status, 3, 'exits with npm test\'s status');
  const killed = testAsCi('kill -TERM $$');
  assert.notEqual(killed.status, 0, `fails when npm test is killed by a signal: ${JSON.stringify(killed)}`);
});

/** The ERE the `changes` job matches the pull request's changed paths against for Bun's macOS legs. */
function bunMacosFilter(): RegExp {
  const ci = read('.github/workflows/ci.yml');
  const matches = [...ci.matchAll(/grep -qE '([^']+)'/g)];
  assert.equal(matches.length, 1, "ci.yml's changes job has one path filter");
  return new RegExp(matches[0][1]);
}

/** The test files the Bun job runs, from its `for f in …; do` line, globs expanded against test/. */
function bunTestFiles(): string[] {
  const ci = read('.github/workflows/ci.yml');
  const loop = /^\s*for f in (.+); do$/m.exec(ci.slice(ci.indexOf('code-execution-bun:')));
  assert.ok(loop, "the Bun job's for loop over its test files");
  const tests = readdirSync(new URL('test/', ROOT));
  return loop[1].split(/\s+/).flatMap((pattern) => {
    assert.ok(pattern.startsWith('test/') && !pattern.slice(5).includes('/'), `a file in test/: ${pattern}`);
    const glob = new RegExp(`^${pattern.slice(5).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    const files = tests.filter((name) => glob.test(name)).map((name) => `test/${name}`);
    assert.ok(files.length > 0, `${pattern} matches a file`);
    return files;
  });
}

/**
 * Repository paths a TypeScript file reaches by a relative specifier: what it imports (`from`, `import()`, a
 * side-effect `import '…'`) and what it loads by path (`new URL('…', import.meta.url)`, such as the child
 * entries the isolate spawns). A `.js` specifier is read as its `.ts` source; a template such as
 * `./child-entry${ext}` is read up to the `${`, as its `.ts` file when that exists.
 */
function relativeReferences(file: string): string[] {
  const source = read(file);
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew URL\(\s*)['"`](\.\.?\/[^'"`$]*)/g;
  return [...source.matchAll(pattern)]
    .map((m) => m[1])
    .filter((specifier) => !specifier.endsWith('/'))
    .map((specifier) => {
      const path = normalize(join(dirname(file), specifier));
      if (path.endsWith('.js') && exists(path.replace(/\.js$/, '.ts'))) return path.replace(/\.js$/, '.ts');
      if (!/\.[a-z]+$/.test(path) && exists(`${path}.ts`)) return `${path}.ts`;
      return path;
    });
}

test("every file code_execution's Bun tests import or load by path, directly or through others, matches the macOS filter", () => {
  const filter = bunMacosFilter();
  const seen = new Set<string>();
  const queue = bunTestFiles();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.ts') && exists(file)) queue.push(...relativeReferences(file));
  }
  assert.ok([...seen].some((file) => file.startsWith('src/')), 'the walk reaches source files');
  for (const loaded of ['src/code-execution/isolate/child-entry.ts', 'test/helpers/fake-child-entry.ts', 'src/code-execution/quickjs.wasm']) {
    assert.ok(seen.has(loaded), `the walk reaches ${loaded}, which is loaded by path, not imported`);
  }
  const outside = [...seen].filter((file) => !filter.test(file)).sort();
  assert.deepEqual(outside, [], 'files the Bun tests run that a pull request could change without running them on macOS');
  for (const config of ['tsconfig.json', 'package.json', '.github/workflows/ci.yml']) {
    assert.ok(filter.test(config), `${config} matches`);
  }
});

test("the macOS filter leaves out what Bun's tests don't run", () => {
  const filter = bunMacosFilter();
  for (const path of ['README.md', 'changelog.d/x.changed.md', 'test/event-gate.test.ts', 'ui/package.json', '.github/workflows/publish.yml']) {
    assert.ok(!filter.test(path), `${path} doesn't match`);
  }
});
