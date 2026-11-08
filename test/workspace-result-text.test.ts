/**
 * What a model reads of read's, grep's, edit's and edit_many's answers: their
 * text (result-text.ts), a header of the answer's fields and its labelled
 * sections, with the fields themselves beside it for a script. A page or a
 * receipt is held to the call's result limit as that text measures it, and a
 * value holding a line break is written as a JSON string, so it can't start a
 * line that reads as the answer's own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/index.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { type GrepAnswer, grepText, shownValue } from '../src/modules/workspace/result-text.js';
import { decodeForEdit, planFile } from '../src/modules/workspace/edit-plan.js';
import { editReceipt } from '../src/modules/workspace/edit-text.js';
import type { EventResponse, Module, ModuleContext } from '../src/types/module.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';
import { MockMembrane, createMockResponse } from './helpers/mock-membrane.js';

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

interface Env {
  /** A tool's answer, which must succeed, with the call's result limit if given. */
  call(name: string, input: Record<string, unknown>, resultMaxChars?: number): Promise<ToolResult>;
  /** A file written to the mount's directory on disk, which the workspace hasn't stored. */
  disk(path: string, content: string | Buffer): void;
  /** A file the workspace stores and disk holds alike. */
  synced(path: string, content: string): Promise<void>;
}

/** A workspace with a mount `work`, and, where asked, a mount `inner` in its directory `inner`. */
async function withWorkspace(fn: (env: Env) => Promise<void>, opts: { nested?: boolean } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'workspace-result-text-'));
  const dir = join(root, 'work');
  mkdirSync(join(dir, 'inner'), { recursive: true });
  const store = JsStore.openOrCreate({ path: join(root, 'ws.chronicle') });
  const workspace = new WorkspaceModule({ mounts: [
    { name: 'work', path: dir, mode: 'read-write', watch: 'never' },
    ...(opts.nested ? [{ name: 'inner', path: join(dir, 'inner'), mode: 'read-write' as const, watch: 'never' as const }] : []),
  ] });
  workspace.initStore(store);
  await workspace.start({ isRestart: false, getState: () => null, setState: () => {}, pushEvent: () => {} } as unknown as ModuleContext);
  let n = 0;
  const call = async (name: string, input: Record<string, unknown>, resultMaxChars?: number) => {
    const result = await workspace.handleToolCall({ id: `call-${n++}`, name, input, ...(resultMaxChars !== undefined ? { resultMaxChars } : {}) });
    assert.equal(result.success, true, `${name}: ${result.error}`);
    return result;
  };
  const disk = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  try {
    await fn({
      call,
      disk,
      synced: async (path, content) => {
        await call('write', { path: `work/${path}`, content });
        await call('materialize', { path: `work/${path}` });
      },
    });
  } finally {
    await workspace.stop().catch(() => {});
    if (!store.isClosed()) store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** The text an answer gives the model: its one text block. */
function textOf(result: ToolResult): string {
  assert.ok(Array.isArray(result.data), 'the answer is a list of blocks');
  assert.equal(result.data.length, 1, 'one block');
  const [block] = result.data as Array<{ type: string; text: string }>;
  assert.equal(block!.type, 'text');
  return block!.text;
}

const fields = <T>(result: ToolResult): T => result.structured as T;

test('read answers a line page as its fields, one to a line, and its numbered lines under content', async () => {
  await withWorkspace(async ({ call, disk }) => {
    disk('a.txt', 'alpha\nbeta\ngamma\n');
    const page = await call('read', { path: 'work/a.txt' }, 24_000);
    assert.equal(textOf(page), 'path: work/a.txt\ntotalLines: 3\nfromLine: 1\ntoLine: 3\n--- content ---\n     1\talpha\n     2\tbeta\n     3\tgamma');
    assert.deepEqual(fields(page), { path: 'work/a.txt', totalLines: 3, fromLine: 1, toLine: 3, content: '     1\talpha\n     2\tbeta\n     3\tgamma' });

    disk('crlf.txt', 'one\r\ntwo\r\n');
    const crlf = await call('read', { path: 'work/crlf.txt', offset: 2 }, 24_000);
    assert.equal(textOf(crlf), 'path: work/crlf.txt\ntotalLines: 2\nfromLine: 2\ntoLine: 2\n'
      + 'note: Line ends are CRLF, shown without the CR. An edit matches text as read shows it, and keeps the CRLF ends.\n'
      + '--- content ---\n     2\ttwo');

    // A page with no lines has no content section.
    disk('empty.txt', '');
    assert.equal(textOf(await call('read', { path: 'work/empty.txt' }, 24_000)), 'path: work/empty.txt\ntotalLines: 0');
  });
});

test("a character page names nextOffsetChars, null at the file's end, and shows the file's characters as they are", async () => {
  await withWorkspace(async ({ call, disk }) => {
    const raw = 'one\r\ntwo \u001b[1mbold\u001b[0m\r\n';
    disk('log.txt', raw);
    const first = await call('read', { path: 'work/log.txt', offsetChars: 0, limitChars: 5 }, 24_000);
    assert.equal(textOf(first), `path: work/log.txt\ntotalChars: ${raw.length}\noffsetChars: 0\nnextOffsetChars: 5\n--- content ---\none\r\n`);
    // A control character reaches the model as itself, where JSON wrote an escape.
    const rest = await call('read', { path: 'work/log.txt', offsetChars: 5, limitChars: 100 }, 24_000);
    assert.equal(textOf(rest), `path: work/log.txt\ntotalChars: ${raw.length}\noffsetChars: 5\nnextOffsetChars: null\n--- content ---\n${raw.slice(5)}`);
    assert.deepEqual(fields(rest), { path: 'work/log.txt', totalChars: raw.length, offsetChars: 5, nextOffsetChars: null, content: raw.slice(5) });
    // Past the end, the page is its fields alone.
    const end = await call('read', { path: 'work/log.txt', offsetChars: raw.length }, 24_000);
    assert.equal(textOf(end), `path: work/log.txt\ntotalChars: ${raw.length}\noffsetChars: ${raw.length}\nnextOffsetChars: null`);
  });
});

test("a line page is the longest whose text fits the call's limit, however JSON would write its lines", async () => {
  await withWorkspace(async ({ call, disk }) => {
    // Quotes and backslashes, which JSON writes as two characters each.
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} "${'\\"'.repeat(20)}"`);
    disk('quoted.txt', `${lines.join('\n')}\n`);
    for (const limit of [2_000, 2_001, 5_000]) {
      const page = await call('read', { path: 'work/quoted.txt' }, limit);
      const text = textOf(page);
      const { toLine } = fields<{ toLine: number }>(page);
      assert.ok(text.length <= limit, `the page's text, ${text.length}, fits ${limit}`);
      assert.ok(JSON.stringify(fields(page)).length > limit, 'as JSON the same page would pass the limit');
      // The next line, after its line feed, with the stop note's two numbers a
      // digit longer at most, would pass it.
      const next = `${String(toLine + 1).padStart(6)}\t${lines[toLine]}`;
      assert.ok(text.length + 1 + next.length > limit - 2, `line ${toLine + 1} doesn't fit beside the page's ${text.length}`);
      assert.match(text, new RegExp(`note: Stopped at line ${toLine} to stay within the ${limit}-character result limit \\(file has 400\\)\\. Continue with offset=${toLine + 1}\\.\n--- content ---\n`));
    }
  });
});

test("a character page stops where its text reaches the call's limit, and never inside a surrogate pair", async () => {
  await withWorkspace(async ({ call, disk }) => {
    const quoted = '"\\'.repeat(1_500);
    disk('quoted.txt', quoted);
    const page = await call('read', { path: 'work/quoted.txt', offsetChars: 0, limitChars: 3_000 }, 1_000);
    const text = textOf(page);
    assert.ok(text.length <= 1_000 && text.length >= 995, `the page's text, ${text.length}, fills the limit of 1,000`);
    const { nextOffsetChars } = fields<{ nextOffsetChars: number }>(page);
    assert.match(text, new RegExp(`^note: Stopped at character ${nextOffsetChars} to stay within the 1000-character result limit; read the rest of what you asked for with offsetChars=${nextOffsetChars} and limitChars=${3_000 - nextOffsetChars}\\.$`, 'm'));

    // Every other code unit starts a pair: at one of two limits a unit apart,
    // the page's end falls inside one, and the page stops before it.
    disk('emoji.txt', '😀'.repeat(1_500));
    for (const limit of [1_000, 1_001]) {
      const emoji = await call('read', { path: 'work/emoji.txt', offsetChars: 0, limitChars: 3_000 }, limit);
      const { content, nextOffsetChars: next } = fields<{ content: string; nextOffsetChars: number }>(emoji);
      assert.equal(next % 2, 0, `at ${limit}, the page ends between pairs`);
      assert.equal(content, '😀'.repeat(next / 2));
      assert.ok(textOf(emoji).length <= limit && textOf(emoji).length >= limit - 6);
    }
  });
});

test("grep answers each version of a file it matched as a section, a match as N: and its context as N-, then what it skipped", async () => {
  await withWorkspace(async ({ call, disk, synced }) => {
    await synced('a.txt', 'needle one\nhay\nneedle again');
    await synced('b.txt', 'nothing');
    disk('b.txt', 'needle on disk');
    await call('write', { path: 'work/b.txt', content: 'needle in the workspace' });
    await synced('c.txt', 'x\r\nneedle crlf\r\n');
    disk('shot.png', ONE_PX_PNG);
    const found = await call('grep', { pattern: 'needle' }, 24_000);
    assert.equal(textOf(found), [
      'pattern: needle',
      'totalMatches: 5',
      '--- work/a.txt: workspace (synced) ---',
      '     1:needle one',
      '     3:needle again',
      '--- work/b.txt: workspace (conflict) ---',
      '     1:needle in the workspace',
      '--- work/b.txt: conflicting-disk (conflict) ---',
      '     1:needle on disk',
      '--- work/c.txt: workspace (synced); lineEndings: CRLF ---',
      '     2:needle crlf',
      '--- skipped ---',
      'work/shot.png: disk-only: binary or over the size limit, never stored (70 bytes, image/png)',
    ].join('\n'));
    assert.deepEqual(fields<{ results: Array<{ file: string; version: string }> }>(found).results.map((r) => `${r.file} ${r.version}`),
      ['work/a.txt workspace', 'work/b.txt workspace', 'work/b.txt conflicting-disk', 'work/c.txt workspace']);

    // Context starts at the file's first line at the earliest, and a window
    // that begins where the run before it ends goes on in the same run.
    const context = await call('grep', { pattern: 'needle', path: 'work/a.txt', contextBefore: 1 }, 24_000);
    assert.equal(textOf(context), [
      'pattern: needle',
      'totalMatches: 2',
      '--- work/a.txt: workspace (synced) ---',
      '     1:needle one',
      '     2-hay',
      '     3:needle again',
    ].join('\n'));
    const after = await call('grep', { pattern: 'one', path: 'work/a.txt', contextAfter: 1 }, 24_000);
    assert.match(textOf(after), /\n {5}1:needle one\n {5}2-hay$/);

    // A pattern that matches nothing is its header alone, with a note where it has one.
    assert.equal(textOf(await call('grep', { pattern: 'no such text', path: 'work/a.txt' }, 24_000)), 'pattern: no such text\ntotalMatches: 0');
    assert.match(textOf(await call('grep', { pattern: 'crlf\\r', path: 'work/c.txt' }, 24_000)),
      /^pattern: crlf\\r\ntotalMatches: 0\nnote: The pattern names a CR, and 1 file searched has CRLF line ends: [^\n]*$/);
  });
});

test("grep's answer ends with the places it couldn't search, each with why", async () => {
  await withWorkspace(async ({ call }) => {
    const answer = await call('grep', { pattern: 'needle', path: 'work/inner' }, 24_000);
    const { incomplete } = fields<{ incomplete: Array<{ path: string; reason: string }> }>(answer);
    assert.equal(incomplete.length, 1);
    assert.equal(textOf(answer), `pattern: needle\ntotalMatches: 0\n--- incomplete ---\nwork/inner: ${incomplete[0]!.reason}`);
  }, { nested: true });
});

test('edit and edit_many answer their counts and notes, the files edit_many changed, and the changed regions last', async () => {
  await withWorkspace(async ({ call, synced }) => {
    await synced('a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n');
    await synced('b.txt', 'alpha\r\nbeta\r\n');
    const edit = await call('edit', { path: 'work/a.txt', oldString: 'four', newString: 'FOUR' }, 24_000);
    const done = fields<{ size: number; changed: string }>(edit);
    assert.equal(done.changed, '     2\ttwo\n     3\tthree\n     4\tFOUR\n     5\tfive\n     6\tsix');
    assert.equal(textOf(edit), `path: work/a.txt\nsize: ${done.size}\nreplacements: 1\ndisk: waits for materialize\n--- changed ---\n${done.changed}`);

    const many = await call('edit_many', { edits: [
      { path: 'work/a.txt', oldString: 'one', newString: 'ONE' },
      { path: 'work/b.txt', oldString: 'beta', newString: 'BETA' },
    ] }, 24_000);
    const both = fields<{ files: Array<{ size: number }>; changed: string }>(many);
    assert.equal(both.changed, 'work/a.txt\n     1\tONE\n     2\ttwo\n     3\tthree\n\nwork/b.txt\n     1\talpha\n     2\tBETA');
    assert.equal(textOf(many), [
      'edits: 2',
      'replacements: 2',
      'disk: waits for materialize',
      '--- files ---',
      `work/a.txt: size ${both.files[0]!.size}, replacements 1, edits 1`,
      `work/b.txt: size ${both.files[1]!.size}, replacements 1, edits 2. The file's CRLF line ends are kept.`,
      '--- changed ---',
      both.changed,
    ].join('\n'));
  });
});

test("an edit's receipt is held to the call's limit as its text measures it", async () => {
  await withWorkspace(async ({ call, synced }) => {
    // Lines JSON writes at twice their length: the region fits as text, and wouldn't as JSON.
    const line = (n: number) => `${n} ${'"\\'.repeat(150)}`;
    await synced('q.txt', `${Array.from({ length: 9 }, (_, i) => line(i + 1)).join('\n')}\n`);
    const edit = await call('edit', { path: 'work/q.txt', oldString: '5 "', newString: 'five "' }, 2_000);
    const text = textOf(edit);
    assert.ok(text.length <= 2_000, `the receipt's text, ${text.length}, fits 2,000`);
    assert.ok(JSON.stringify(fields(edit)).length > 2_000, 'as JSON the same receipt would pass the limit');
    assert.match(text, /\n {5}3\t3 "\\[^\n]*\n {5}4\t[^\n]*\n {5}5\tfive "[^\n]*\n {5}6\t[^\n]*\n {5}7\t7 "[^\n]*$/);

    // edit_many lists what fits of its files, and counts the rest.
    const many = Array.from({ length: 40 }, (_, i) => `file-${String(i).padStart(2, '0')}.txt`);
    for (const name of many) await synced(name, 'old\n');
    const listed = await call('edit_many', { edits: many.map((name) => ({ path: `work/${name}`, oldString: 'old', newString: 'new' })) }, 1_000);
    const receipt = fields<{ files: unknown[]; filesNotListed: number }>(listed);
    assert.ok(receipt.filesNotListed > 0 && receipt.files.length > 0, `${receipt.files.length} listed, ${receipt.filesNotListed} not`);
    assert.equal(receipt.files.length + receipt.filesNotListed, 40);
    assert.match(textOf(listed), new RegExp(`^edits: 40\nreplacements: 40\ndisk: waits for materialize\nfilesNotListed: ${receipt.filesNotListed}\n--- files ---\n`));
    assert.ok(textOf(listed).length <= 1_000);
  });
});

test('a value holding a line break is written as a JSON string, so it stays on its line and gives back the path', async () => {
  for (const value of ['a\nb', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\vb', 'a\fb', 'a\u0085b', '\n']) {
    const shown = shownValue(value);
    assert.ok(!/[\n\v\f\r\u0085\u2028\u2029]/.test(shown), `${JSON.stringify(value)} is shown on one line`);
    assert.equal(JSON.parse(shown), value);
  }
  for (const value of ['plain', 'tab\tand \u001b escape', 'a "quoted" word', '']) assert.equal(shownValue(value), value);
  // A value that starts with a quote is quoted, so it can't read as the
  // quoted form of another: `"a\nb"` as written in a file, and a line break
  // between a and b, are shown apart.
  assert.equal(shownValue('"quoted"'), '"\\"quoted\\""');
  assert.equal(shownValue('"a\\nb"'), '"\\"a\\\\nb\\""');
  assert.equal(shownValue('a\nb'), '"a\\nb"');
  for (const value of ['"quoted"', '"a\\nb"', 'a\nb', '"']) assert.equal(JSON.parse(shownValue(value)), value);
  // Every break is escaped: none is left, and the value comes back whole.
  const breaks = shownValue('a\u0085b\u2028c\u2029d\u2028e\vf');
  assert.ok(!/[\n\v\f\r\u0085\u2028\u2029]/.test(breaks), breaks);
  assert.equal(JSON.parse(breaks), 'a\u0085b\u2028c\u2029d\u2028e\vf');
  assert.equal(shownValue(null), 'null');
  assert.equal(shownValue(12), '12');

  await withWorkspace(async ({ call, disk, synced }) => {
    disk('odd\nname.txt', 'needle\n');
    disk('odd\nshot.png', ONE_PX_PNG);
    const quoted = JSON.stringify('work/odd\nname.txt');
    const read = await call('read', { path: 'work/odd\nname.txt' }, 24_000);
    assert.equal(textOf(read), `path: ${quoted}\ntotalLines: 1\nfromLine: 1\ntoLine: 1\n--- content ---\n     1\tneedle`);
    assert.equal(fields<{ path: string }>(read).path, 'work/odd\nname.txt', 'the fields hold the path as it is');
    const grep = await call('grep', { pattern: 'needle' }, 24_000);
    assert.match(textOf(grep), new RegExp(`\n--- ${escape(quoted)}: workspace \\(synced\\) ---\n {5}1:needle\n--- skipped ---\n${escape(JSON.stringify('work/odd\nshot.png'))}: disk-only: `));
    await synced('plain.txt', 'needle\n');
    const many = await call('edit_many', { edits: [
      { path: 'work/odd\nname.txt', oldString: 'needle', newString: 'pin' },
      { path: 'work/plain.txt', oldString: 'needle', newString: 'pin' },
    ] }, 24_000);
    const text = textOf(many);
    assert.match(text, new RegExp(`\n--- files ---\n${escape(quoted)}: size 4, replacements 1, edits 1\nwork/plain.txt: size 4, replacements 1, edits 2\n`));
    assert.match(text, new RegExp(`\n--- changed ---\n${escape(quoted)}\n {5}1\tpin\n\nwork/plain.txt\n {5}1\tpin$`));
  });
});

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test("through the framework, a model's read reaches it and its history as the page's text, and a script's as the text and the page's fields", async () => {
  const root = mkdtempSync(join(tmpdir(), 'workspace-result-text-framework-'));
  const dir = join(root, 'files');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.txt'), 'say "hi"\\n\tthere\n');
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([
    { type: 'tool_use', id: 'call_read', name: 'workspace--read', input: { path: 'files/a.txt' } },
  ], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Read.' }]));
  const workspace = new WorkspaceModule({ mounts: [{ name: 'files', path: dir, mode: 'read-write', watch: 'never' }] });
  // Asks for inference when the message arrives.
  const kick: Module = {
    name: 'kick',
    async start() {},
    async stop() {},
    getTools: () => [],
    handleToolCall: async () => ({ success: false, isError: true, error: 'unexpected tool call' }),
    onProcess: async (event: ProcessEvent): Promise<EventResponse> => (event.type === 'external-message' ? { requestInference: true } : {}),
  };
  const framework = await AgentFramework.create({
    storePath: join(root, 'store.chronicle'), membrane: membrane.asMembrane(),
    agents: [{ name: 'prime', model: 'mock', systemPrompt: 'test' }],
    modules: [workspace, kick], syncIntervalMs: 0, maintenanceIntervalMs: 0,
  });
  workspace.initStore(framework.getStore());
  const text = 'path: files/a.txt\ntotalLines: 1\nfromLine: 1\ntoLine: 1\n--- content ---\n     1\tsay "hi"\\n\tthere';
  try {
    framework.pushEvent({ type: 'external-message', source: 'test', content: 'read it', metadata: {} } as unknown as ProcessEvent);
    await framework.runUntilIdle();
    const messages = (framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{ content: Array<{ type: string; content?: unknown }> }>;
    const stored = messages.flatMap((m) => m.content ?? []).filter((block) => block.type === 'tool_result').map((block) => block.content);
    assert.deepEqual(stored, [text], "the history holds the page's text");
    const wire = membrane.lastStream?.receivedToolResults[0] as Array<{ content: unknown }> | undefined;
    assert.equal(wire?.[0]?.content, text, 'the model reads the same text');

    // A script's call is dispatched as the agent's and answered through the running framework.
    framework.start();
    const internals = framework as unknown as { scriptToolCall(agent: string, tool: string, args: string, context: object): Promise<{ json: string }> };
    const answer = JSON.parse((await internals.scriptToolCall('prime', 'workspace--read', JSON.stringify({ path: 'files/a.txt' }), {})).json);
    assert.deepEqual(answer, {
      content: [{ type: 'text', text }],
      structuredContent: { path: 'files/a.txt', totalLines: 1, fromLine: 1, toLine: 1, content: '     1\tsay "hi"\\n\tthere' },
      isError: false,
    });
  } finally {
    await framework.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("grep's matched and context lines that hold a line break are quoted, and matches whose context meets are one run of lines", async () => {
  await withWorkspace(async ({ call, disk }) => {
    disk('lines.txt', 'one\ntwo \r needle three\nfour\nneedle five\u2028--- skipped ---\nsix\n');
    const quoted = await call('grep', { pattern: 'needle', path: 'work/lines.txt', contextBefore: 1, contextAfter: 1 }, 24_000);
    // The two windows, lines 1 to 3 and 3 to 5, overlap: one run, each line once.
    assert.equal(textOf(quoted), [
      'pattern: needle',
      'totalMatches: 2',
      '--- work/lines.txt: workspace (synced) ---',
      '     1-one',
      '     2:"two \\r needle three"',
      '     3-four',
      '     4:"needle five\\u2028--- skipped ---"',
      '     5-six',
    ].join('\n'));
    // Without context, the matched lines are quoted the same way.
    assert.match(textOf(await call('grep', { pattern: 'needle', path: 'work/lines.txt' }, 24_000)),
      /\n {5}2:"two \\r needle three"\n {5}4:"needle five\\u2028--- skipped ---"$/);
    disk('gap.txt', `${['a', 'needle b', 'c', 'd', 'e', 'f', 'g', 'needle h', 'i'].join('\n')}\n`);
    // Lines left out between two runs: `--` between them.
    assert.match(textOf(await call('grep', { pattern: 'needle', path: 'work/gap.txt', contextBefore: 1, contextAfter: 1 }, 24_000)),
      /\n {5}1-a\n {5}2:needle b\n {5}3-c\n--\n {5}7-g\n {5}8:needle h\n {5}9-i$/);
    disk('touch.txt', 'x\nneedle y\nz\nneedle w\n');
    // A window that takes in the next match, and one that ends where the
    // next begins: one run each time, a match inside another's window
    // marked as a match, and no `--` before a section's first run.
    const touching = ['pattern: needle', 'totalMatches: 2', '--- work/touch.txt: workspace (synced) ---', '     2:needle y', '     3-z', '     4:needle w'].join('\n');
    assert.equal(textOf(await call('grep', { pattern: 'needle', path: 'work/touch.txt', contextAfter: 2 }, 24_000)), touching);
    assert.equal(textOf(await call('grep', { pattern: 'needle', path: 'work/touch.txt', contextAfter: 1 }, 24_000)), touching);
  });
});

test("grep's text quotes a pattern, a note, a skipped file's reason and an incomplete place that hold a line break, and writes a label without a state and a skip's facts as it has them", () => {
  const answer: GrepAnswer = {
    pattern: 'a\nb',
    results: [{ file: 'work/d.txt', version: 'disk', matches: [{ line: 1, text: 'x' }] }],
    totalMatches: 1,
    note: 'see "work/q\nr"',
    skipped: [
      { file: 'work/s', reason: 'gone\nwhere' },
      { file: 'work/t', reason: 'big', size: 9 },
      { file: 'work/u.png', reason: 'img', mimeType: 'image/png' },
    ],
    incomplete: [{ path: 'work/i\nj', reason: 'nested\rmount' }],
  };
  assert.equal(grepText(answer, 0), [
    'pattern: "a\\nb"',
    'totalMatches: 1',
    'note: "see \\"work/q\\nr\\""',
    '--- work/d.txt: disk ---',
    '     1:x',
    '--- skipped ---',
    'work/s: "gone\\nwhere"',
    'work/t: big (9 bytes)',
    'work/u.png: img (image/png)',
    '--- incomplete ---',
    '"work/i\\nj": "nested\\rmount"',
  ].join('\n'));
});

test("a receipt quotes a note and a kept mode that hold a line break, in edit's header and on edit_many's line for the file", () => {
  const bytes = Buffer.from('old\n');
  const planned = planFile(decodeForEdit(bytes)!, bytes, [{ index: 0, oldText: 'old', newText: 'new', expected: 1 }]);
  assert.ok('plan' in planned);
  const file = { path: 'work/a.txt', plan: planned.plan, notes: ['note\nwith a break'], modeKept: 'kept\u2028here' };
  assert.match(textOf(editReceipt('edit', [file], 1, 24_000, 'done')),
    /\nnote: "note\\nwith a break"\nmodeKept: "kept\\u2028here"\n--- changed ---\n/);
  assert.match(textOf(editReceipt('edit_many', [file, { path: 'work/b.txt', plan: planned.plan, notes: [] }], 2, 24_000, 'done')),
    /\n--- files ---\nwork\/a\.txt: size 4, replacements 1, edits 1; modeKept: "kept\\u2028here"\. "note\\nwith a break"\nwork\/b\.txt: size 4, replacements 1, edits 1\n/);
});

test("grep's runs start afresh in each file's section, and a context line holding a line break is quoted", async () => {
  await withWorkspace(async ({ call, disk }) => {
    disk('two/a.txt', 'x\nneedle\n');
    disk('two/b.txt', 'needle\ny\n');
    disk('two/c.txt', 'pre\rcontext\nneedle\n');
    assert.equal(textOf(await call('grep', { pattern: 'needle', path: 'work/two', contextBefore: 1, contextAfter: 1 }, 24_000)), [
      'pattern: needle',
      'totalMatches: 3',
      '--- work/two/a.txt: workspace (synced) ---',
      '     1-x',
      '     2:needle',
      '--- work/two/b.txt: workspace (synced) ---',
      '     1:needle',
      '     2-y',
      '--- work/two/c.txt: workspace (synced) ---',
      '     1-"pre\\rcontext"',
      '     2:needle',
    ].join('\n'));
  });
});
