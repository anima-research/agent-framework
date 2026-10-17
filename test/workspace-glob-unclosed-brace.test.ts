/**
 * A brace form the glob conversion can't read is refused, by workspace--glob
 * and by workspace--grep's glob filter: a `{` that never closes, a group
 * inside another, and a group with no `,`. Before, converting a pattern whose
 * `{` never closed never finished: the call never answered, and its process
 * handled nothing else.
 * Each call here runs in a child process, since a loop like that would block
 * this process's own timers too. A child that hasn't answered within 60 s is
 * killed, and its test fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKSPACE = new URL('../src/modules/workspace/index.js', import.meta.url).href;
const HANG_GUARD_MS = 60_000;

interface Answer { success: boolean; isError?: boolean; error?: string; data?: unknown }

/** One workspace tool call, made in a child process against a mount `project`
 *  holding `src/a.ts`, `src/c.ts` and `lib/b.ts`. Returns its result, or null
 *  when the child hasn't answered within HANG_GUARD_MS and has been killed. */
function callInChild(name: 'glob' | 'grep', input: Record<string, unknown>): Answer | null {
  const dir = mkdtempSync(join(tmpdir(), 'glob-unclosed-brace-'));
  const script = join(dir, 'child.mjs');
  writeFileSync(script, `
    import { createRequire } from 'node:module';
    import { mkdirSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const { JsStore } = createRequire(${JSON.stringify(import.meta.url)})('@animalabs/chronicle');
    const { WorkspaceModule } = await import(${JSON.stringify(WORKSPACE)});
    const dir = ${JSON.stringify(dir)};
    for (const [folder, file] of [['src', 'a.ts'], ['src', 'c.ts'], ['lib', 'b.ts']]) {
      mkdirSync(join(dir, 'mount', folder), { recursive: true });
      writeFileSync(join(dir, 'mount', folder, file), 'export const x = 1;');
    }
    const store = JsStore.openOrCreate({ path: join(dir, 'store') });
    const workspace = new WorkspaceModule({
      mounts: [{ name: 'project', path: join(dir, 'mount'), mode: 'read-write', watch: 'never' }],
    });
    workspace.initStore(store);
    const result = await workspace.handleToolCall({ id: 'c', name: ${JSON.stringify(name)}, input: ${JSON.stringify(input)} });
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  `);
  try {
    // SIGKILL: a loop that never yields would never run a SIGTERM handler
    // that something in the child's modules had installed, so SIGTERM could
    // leave the child alive and this call waiting on it.
    const child = spawnSync(process.execPath, [script], { timeout: HANG_GUARD_MS, killSignal: 'SIGKILL', encoding: 'utf8' });
    const error = child.error as NodeJS.ErrnoException | undefined;
    if (error?.code === 'ETIMEDOUT') return null;
    if (error) throw new Error(`the child couldn't run: ${error.message}`);
    try {
      return JSON.parse(child.stdout) as Answer;
    } catch {
      throw new Error(`the child wrote no result (exit ${child.status}, signal ${child.signal}): ${child.stdout}${child.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const UNCLOSED = 'has a "{" with no closing "}"';
const NESTED = 'has a "{" group inside another; put all its alternatives in one group';
const NO_COMMA = 'has a "{" group with no ","; a group needs two or more alternatives, separated by ","';

/** A call that answers within the guard, refusing `pattern` for `problem` in the words the agent gets. */
function assertRefused(name: 'glob' | 'grep', input: Record<string, unknown>, pattern: string, problem: string): void {
  const answer = callInChild(name, input);
  assert.ok(answer, `${name} with ${JSON.stringify(input)} didn't answer within ${HANG_GUARD_MS / 1000} s`);
  assert.equal(answer.success, false, JSON.stringify(answer));
  assert.equal(answer.isError, true);
  assert.equal(
    answer.error,
    `Error: glob pattern ${JSON.stringify(pattern)} ${problem}. To match a "{" in a name, put "?" in its place.`,
  );
}

test('glob refuses a pattern whose "{" never closes', () => {
  assertRefused('glob', { pattern: 'src/{a,b' }, 'src/{a,b', UNCLOSED);
});

test('grep refuses a glob filter whose "{" never closes', () => {
  assertRefused('grep', { pattern: 'export', glob: 'src/{a,b' }, 'src/{a,b', UNCLOSED);
});

test('a "{" that never closes is named as that, with a closed group after it', () => {
  // The closed `{ts,tsx}` doesn't close the first "{", so this isn't a group inside another.
  assertRefused('glob', { pattern: 'src/{a,b/*.{ts,tsx}' }, 'src/{a,b/*.{ts,tsx}', UNCLOSED);
});

test('glob and grep refuse a group inside another', () => {
  assertRefused('glob', { pattern: 'src/{a,{b,c}}.ts' }, 'src/{a,{b,c}}.ts', NESTED);
  assertRefused('grep', { pattern: 'export', glob: 'src/{a,{b,c}}.ts' }, 'src/{a,{b,c}}.ts', NESTED);
});

test('glob and grep refuse a group with no ",", an empty one included', () => {
  // Read as a choice of one, `{a}` lost its braces and `{}` matched nothing in their place.
  assertRefused('glob', { pattern: 'src/{a}.ts' }, 'src/{a}.ts', NO_COMMA);
  assertRefused('grep', { pattern: 'export', glob: 'src/{}a.ts' }, 'src/{}a.ts', NO_COMMA);
});

test('groups that close still match, each by its own braces (control)', () => {
  // lib/b.ts matches only through each group's second alternative, and src/c.ts through neither.
  const glob = callInChild('glob', { pattern: '{src,lib}/{a,b}.ts' });
  assert.ok(glob, `glob with "{src,lib}/{a,b}.ts" didn't answer within ${HANG_GUARD_MS / 1000} s`);
  assert.equal(glob.success, true, JSON.stringify(glob));
  assert.deepEqual(
    (glob.data as { matches: Array<{ path: string }> }).matches.map((m) => m.path),
    ['project/lib/b.ts', 'project/src/a.ts'],
  );
  const grep = callInChild('grep', { pattern: 'export', glob: '{src,lib}/{a,b}.ts' });
  assert.ok(grep, `grep with the glob "{src,lib}/{a,b}.ts" didn't answer within ${HANG_GUARD_MS / 1000} s`);
  assert.equal(grep.success, true, JSON.stringify(grep));
  assert.deepEqual(
    (grep.data as { results: Array<{ file: string }> }).results.map((r) => r.file).sort(),
    ['project/lib/b.ts', 'project/src/a.ts'],
  );
});
