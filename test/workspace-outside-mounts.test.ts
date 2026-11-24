import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import { AgentFramework } from '../src/framework.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import type { WorkspaceConfig } from '../src/modules/workspace/types.js';
import type { ProcessEvent, ToolResult } from '../src/types/events.js';
import type { EventResponse, Module } from '../src/types/module.js';
import { MockMembrane, createMockResponse as createStreamResponse } from './helpers/mock-membrane.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==', 'base64');

const READS_OUTSIDE = 'With an absolute path, or one that starts with "~/", it reads a file outside the mounts, as it is on disk now. '
  + "One that lies in a mount's directory is read as that mount's file.";
const WRITES_OUTSIDE = 'With an absolute path, or one that starts with "~/", it writes a file outside the mounts: on disk when the call answers, in directories made as needed, '
  + "and an undo or other head move leaves it there. One that lies in a mount's directory is written as that mount's file.";
const PATH_OUTSIDE = ', or an absolute path for a file outside the mounts';

/** A workspace with one mount, `work`, and a directory beside it that no mount holds. */
function setup(t: TestContext, outsideMounts?: WorkspaceConfig['outsideMounts'], mode: 'read-write' | 'read-only' = 'read-write') {
  // Real, since the module resolves what it is given and macOS's tmpdir is a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'af-outside-')));
  const mountDir = join(root, 'mount');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(mountDir);
  mkdirSync(elsewhere);
  const store = JsStore.openOrCreate({ path: join(root, 'workspace.chronicle') });
  const workspace = new WorkspaceModule({
    mounts: [{ name: 'work', path: mountDir, mode, watch: 'never' }],
    ...(outsideMounts !== undefined ? { outsideMounts } : {}),
  });
  workspace.initStore(store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const call = (name: string, input: Record<string, unknown>): Promise<ToolResult> => workspace.handleToolCall({ id: name, name, input });
  return { root, mountDir, elsewhere, workspace, call };
}

const textOf = (result: ToolResult): string => (result.data as Array<{ type: string; text: string }>)[0]!.text;
const tool = (workspace: WorkspaceModule, name: string) => workspace.getTools().find((entry) => entry.name === name)!;
const pathOf = (workspace: WorkspaceModule, name: string) =>
  (tool(workspace, name).inputSchema as unknown as { properties: { path: { description: string } } }).properties.path.description;

test('without the setting, an absolute path is refused as it always was, and the tools say nothing of one', async (t) => {
  const { elsewhere, workspace, call } = setup(t);
  const file = join(elsewhere, 'note.txt');
  writeFileSync(file, 'outside\n');

  for (const [name, input] of [['read', { path: file }], ['read_image', { path: file }], ['write', { path: file, content: 'new\n' }]] as const) {
    const result = await call(name, input);
    assert.equal(result.isError, true, name);
    assert.match(String(result.error), /doesn't start with a mount's name, and a path starts with its mount's name; the mounts are "work"\./, name);
  }
  assert.equal(readFileSync(file, 'utf8'), 'outside\n');

  assert.equal(tool(workspace, 'read_image').description, 'Read an image file from the workspace and return native image content.');
  assert.equal(tool(workspace, 'write').description, 'Create or overwrite a file in the workspace.');
  assert.ok(!tool(workspace, 'read').description.includes('outside'));
  assert.equal(pathOf(workspace, 'read'), 'File path (mount-prefixed, e.g., "project/src/main.ts")');
  assert.equal(pathOf(workspace, 'read_image'), 'Image file path (mount-prefixed, e.g., "project/assets/logo.png")');
  assert.equal(pathOf(workspace, 'write'), 'File path (mount-prefixed)');
});

test("'read-only' lets read and read_image take a file outside the mounts, and their descriptions say so; write's stays as it was", async (t) => {
  const { elsewhere, workspace, call } = setup(t, 'read-only');
  const note = join(elsewhere, 'note.txt');
  const image = join(elsewhere, 'shot.png');
  writeFileSync(note, 'first\nsecond\n');
  writeFileSync(image, PNG);

  const read = await call('read', { path: note });
  assert.equal(read.success, true, String(read.error));
  assert.match(textOf(read), new RegExp(`^path: ${note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  assert.match(textOf(read), /first\n.*second/s);

  const seen = await call('read_image', { path: image });
  assert.deepEqual(seen.data, [
    { type: 'text', text: `Path: ${image}\nMIME: image/png\nBytes: ${PNG.byteLength}` },
    { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
  ]);

  assert.ok(tool(workspace, 'read').description.endsWith(` ${READS_OUTSIDE}`));
  assert.equal(tool(workspace, 'read_image').description, `Read an image file from the workspace and return native image content. ${READS_OUTSIDE}`);
  assert.equal(pathOf(workspace, 'read'), `File path (mount-prefixed, e.g., "project/src/main.ts")${PATH_OUTSIDE}`);
  assert.equal(pathOf(workspace, 'read_image'), `Image file path (mount-prefixed, e.g., "project/assets/logo.png")${PATH_OUTSIDE}`);
  assert.equal(tool(workspace, 'write').description, 'Create or overwrite a file in the workspace.');
  assert.equal(pathOf(workspace, 'write'), 'File path (mount-prefixed)');

  const written = await call('write', { path: note, content: 'changed\n' });
  assert.equal(written.isError, true);
  assert.equal(written.error, `The write did nothing: ${JSON.stringify(note)} lies outside the mounts, where this workspace reads files and doesn't write them. `
    + "Calling again won't change that; whoever runs this host can set the workspace's outsideMounts to 'read-write'.");
  assert.equal(readFileSync(note, 'utf8'), 'first\nsecond\n');
});

test("'read-write' lets write take one too: in place, with its directories made and an existing file's mode kept", async (t) => {
  const { elsewhere, workspace, call } = setup(t, 'read-write');
  const fresh = join(elsewhere, 'made', 'on', 'the', 'way.txt');
  const written = await call('write', { path: fresh, content: 'hello\n' });
  assert.equal(written.success, true, String(written.error));
  assert.deepEqual({ ...(written.data as Record<string, unknown>), hash: undefined }, { path: fresh, size: 6, hash: undefined, disk: 'done' });
  assert.equal(readFileSync(fresh, 'utf8'), 'hello\n');

  const script = join(elsewhere, 'run.sh');
  writeFileSync(script, '#!/bin/sh\n');
  chmodSync(script, 0o750);
  assert.equal((await call('write', { path: script, content: '#!/bin/sh\necho hi\n' })).success, true);
  assert.equal(readFileSync(script, 'utf8'), '#!/bin/sh\necho hi\n');
  assert.equal(statSync(script).mode & 0o777, 0o750);

  assert.equal(tool(workspace, 'write').description, `Create or overwrite a file in the workspace. ${WRITES_OUTSIDE}`);
  assert.equal(pathOf(workspace, 'write'), `File path (mount-prefixed)${PATH_OUTSIDE}`);
  assert.ok(tool(workspace, 'read').description.endsWith(` ${READS_OUTSIDE}`));
});

test("an absolute path that lies in a mount's directory is that mount's file, by the mount's own rules", async (t) => {
  const { mountDir, call } = setup(t, 'read-write', 'read-only');
  writeFileSync(join(mountDir, 'kept.txt'), 'the mount holds this\n');
  writeFileSync(join(mountDir, 'tiny.png'), PNG);

  const read = await call('read', { path: join(mountDir, 'kept.txt') });
  assert.equal(read.success, true, String(read.error));
  assert.match(textOf(read), /^path: work\/kept\.txt\n/);
  const seen = await call('read_image', { path: join(mountDir, 'tiny.png') });
  assert.equal((seen.data as Array<{ text?: string }>)[0]!.text, `Path: work/tiny.png\nMIME: image/png\nBytes: ${PNG.byteLength}`);

  // The mount is read-only, and the setting doesn't write through it.
  const written = await call('write', { path: join(mountDir, 'kept.txt'), content: 'replaced\n' });
  assert.equal(written.isError, true);
  assert.match(String(written.error), /read-only/);
  assert.equal(readFileSync(join(mountDir, 'kept.txt'), 'utf8'), 'the mount holds this\n');
  const root = await call('read', { path: mountDir });
  assert.match(String(root.error), /names the root of mount "work"/);
});

test('a path that starts with "~/" is read from the home directory', async (t) => {
  const { root, call } = setup(t, 'read-only');
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; });
  writeFileSync(join(root, 'elsewhere', 'home.txt'), 'from home\n');

  const read = await call('read', { path: '~/elsewhere/home.txt' });
  assert.equal(read.success, true, String(read.error));
  assert.match(textOf(read), /^path: ~\/elsewhere\/home\.txt\n/);
  assert.match(textOf(read), /from home/);
  // A home-directory path into a mount is the mount's file too.
  writeFileSync(join(root, 'mount', 'in.txt'), 'in the mount\n');
  assert.match(textOf(await call('read', { path: '~/mount/in.txt' })), /^path: work\/in\.txt\n/);
});

test('what is outside and cannot be shown is refused in words that name it', async (t) => {
  const { elsewhere, call } = setup(t, 'read-write');
  const missing = join(elsewhere, 'missing.txt');
  assert.equal((await call('read', { path: missing })).error, `The read did nothing: there's no file at ${JSON.stringify(missing)}.`);
  assert.equal((await call('read_image', { path: missing })).error, `The read_image did nothing: there's no file at ${JSON.stringify(missing)}.`);
  assert.equal((await call('read', { path: elsewhere })).error, `The read did nothing: ${JSON.stringify(elsewhere)} is a directory, so read has nothing of it to show.`);

  const big = join(elsewhere, 'big.txt');
  writeFileSync(big, '');
  truncateSync(big, 5 * 1024 * 1024 + 1);
  assert.equal((await call('read', { path: big })).error,
    `The read did nothing: ${JSON.stringify(big)} is 5,242,881 bytes, past the 5,242,880-byte limit on a file outside the mounts, so read doesn't show it, or any page of it.`);
  assert.equal((await call('read_image', { path: big })).error,
    `The read_image did nothing: ${JSON.stringify(big)} is 5,242,881 bytes, past the 5,242,880-byte limit on a file outside the mounts, so read_image doesn't show it.`);
  const tooMuch = await call('write', { path: join(elsewhere, 'too-much.txt'), content: 'x'.repeat(5 * 1024 * 1024 + 1) });
  assert.equal(tooMuch.error, `The write did nothing: ${JSON.stringify(join(elsewhere, 'too-much.txt'))} would be 5,242,881 bytes, past the 5,242,880-byte limit on a file outside the mounts. Content within the limit is written.`);
  assert.equal(existsSync(join(elsewhere, 'too-much.txt')), false);

  const image = join(elsewhere, 'shot.png');
  writeFileSync(image, PNG);
  assert.equal((await call('read', { path: image })).error,
    `The read did nothing: ${JSON.stringify(image)} is binary, so read doesn't show it as text. read_image shows it, if its data holds together as an image.`);
  const text = join(elsewhere, 'note.txt');
  writeFileSync(text, 'words\n');
  assert.match(String((await call('read_image', { path: text })).error), /isn't a PNG, JPEG, GIF or WebP image/);

  // A paged read of a file over the limit is refused as the whole file is.
  assert.match(String((await call('read', { path: big, offset: 1, limit: 10 })).error), /so read doesn't show it, or any page of it\.$/);

  mkdirSync(join(elsewhere, 'taken'));
  assert.equal((await call('write', { path: join(elsewhere, 'taken'), content: 'x' })).error,
    `The write did nothing: ${JSON.stringify(join(elsewhere, 'taken'))} is a directory, so there's no file there to write.`);
  // A write the system refuses says the file's state isn't known, since it's written in place.
  const sealed = join(elsewhere, 'sealed.txt');
  writeFileSync(sealed, 'old\n');
  chmodSync(sealed, 0o444);
  if (process.getuid?.() !== 0) {
    assert.equal((await call('write', { path: sealed, content: 'new\n' })).error,
      `The write to ${JSON.stringify(sealed)} failed: permission denied. A write in place can stop partway, so what the file holds now isn't known: read it to see. `
      + "Calling again won't change that; whoever runs this host can change the permissions.");
  }
});

test('a pipe outside the mounts is refused at once, read or written, and holds no call', { skip: process.platform === 'win32' }, async (t) => {
  const { elsewhere, call } = setup(t, 'read-write');
  const pipe = join(elsewhere, 'pipe');
  execFileSync('mkfifo', [pipe]);
  const quoted = JSON.stringify(pipe);
  assert.equal((await call('read', { path: pipe })).error, `The read did nothing: ${quoted} is not a regular file, so read has nothing of it to show.`);
  assert.equal((await call('read_image', { path: pipe })).error, `The read_image did nothing: ${quoted} is not a regular file, so read_image has nothing of it to show.`);
  assert.equal((await call('write', { path: pipe, content: 'x' })).error, `The write did nothing: ${quoted} is not a regular file, so there's no file there to write.`);
});

test('a link is followed: one that leads into a mount reaches the mount and its rules, and one to a file outside is read and written through', async (t) => {
  const { mountDir, elsewhere, call } = setup(t, 'read-write', 'read-only');
  writeFileSync(join(mountDir, 'kept.txt'), 'the mount holds this\n');
  symlinkSync(mountDir, join(elsewhere, 'alias'));
  const aliased = join(elsewhere, 'alias', 'kept.txt');
  assert.match(textOf(await call('read', { path: aliased })), /^path: work\/kept\.txt\n/);
  const refused = await call('write', { path: aliased, content: 'replaced\n' });
  assert.equal(refused.isError, true);
  assert.match(String(refused.error), /read-only/);
  // A file that doesn't exist yet is placed by its nearest directory, so a new one can't be made in the mount this way either.
  assert.match(String((await call('write', { path: join(elsewhere, 'alias', 'new.txt'), content: 'x' })).error), /read-only/);
  assert.equal(existsSync(join(mountDir, 'new.txt')), false);
  assert.equal(readFileSync(join(mountDir, 'kept.txt'), 'utf8'), 'the mount holds this\n');

  const target = join(elsewhere, 'target.txt');
  const link = join(elsewhere, 'link.txt');
  writeFileSync(target, 'before\n');
  symlinkSync(target, link);
  assert.match(textOf(await call('read', { path: link })), /before/);
  assert.equal((await call('write', { path: link, content: 'after\n' })).success, true);
  assert.equal(readFileSync(target, 'utf8'), 'after\n');
  assert.equal(lstatSync(link).isSymbolicLink(), true);
});

test("a generated file's absolute path is the generated file, read and refused as its mount path is", async (t) => {
  const { mountDir, workspace } = setup(t, 'read-write');
  workspace.registerGeneratedTextFile('work/generated.txt', () => 'made at each read\n', 'scout');
  const as = (agent: string, name: string, path: string, more: Record<string, unknown> = {}) =>
    workspace.handleToolCall({ id: name, name, input: { path, ...more }, callerAgentName: agent });
  const absolute = join(mountDir, 'generated.txt');

  assert.match(textOf(await as('scout', 'read', absolute)), /made at each read/);
  for (const [agent, name, more] of [['other', 'read', {}], ['scout', 'write', { content: 'mine now\n' }], ['scout', 'read_image', {}]] as const) {
    const byMount = await as(agent, name, 'work/generated.txt', more);
    assert.equal(byMount.isError, true, `${agent} ${name}`);
    assert.equal((await as(agent, name, absolute, more)).error, byMount.error, `${agent} ${name}`);
  }
  assert.equal(existsSync(absolute), false);
});

test("before the store is in, an absolute path in a mount is still the mount's, and isn't written around it", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'af-outside-early-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'mount'));
  const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: join(root, 'mount'), mode: 'read-only', watch: 'never' }], outsideMounts: 'read-write' });
  const written = await workspace.handleToolCall({ id: 'write', name: 'write', input: { path: join(root, 'mount', 'early.txt'), content: 'x' } });
  assert.equal(written.isError, true);
  assert.equal(existsSync(join(root, 'mount', 'early.txt')), false);
});

test('a setting that is neither value is refused when the module is made', () => {
  assert.throws(
    () => new WorkspaceModule({ mounts: [], outsideMounts: true as unknown as 'read-write' }),
    /^Error: \[workspace\] outsideMounts must be 'read-only' or 'read-write', not true$/,
  );
});

test("the framework's own read_image says what the workspace's does", async (t) => {
  const idle = () => {
    const response = {
      content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn' as const, rawAssistantText: 'ok', toolCalls: [], toolResults: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      details: {
        stop: { reason: 'end_turn' as const, wasTruncated: false }, usage: { inputTokens: 1, outputTokens: 1 }, timing: { totalDurationMs: 1, attempts: 1 },
        model: { requested: 'mock', actual: 'mock', provider: 'mock' }, cache: { markersInRequest: 0, tokensCreated: 0, tokensRead: 0, hitRatio: 0 },
      },
      raw: { request: {}, response: {} },
    };
    return {
      async complete() { return response; },
      streamYielding() { return { async *[Symbol.asyncIterator]() { yield { type: 'complete', response }; } }; },
    } as unknown as import('@animalabs/membrane').Membrane;
  };
  const described = async (outsideMounts?: WorkspaceConfig['outsideMounts']) => {
    const root = mkdtempSync(join(tmpdir(), 'af-outside-fw-'));
    const framework = await AgentFramework.create({
      storePath: join(root, 'framework.chronicle'),
      membrane: idle(),
      agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
      modules: [new WorkspaceModule({ mounts: [{ name: 'work', path: join(root, 'mount'), mode: 'read-write', watch: 'never' }], ...(outsideMounts ? { outsideMounts } : {}) })],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
    });
    t.after(async () => {
      await framework.stop();
      rmSync(root, { recursive: true, force: true });
    });
    const found = framework.getAllTools().find((entry) => entry.name === 'read_image')!;
    return { description: found.description, path: (found.inputSchema as unknown as { properties: { path: { description: string } } }).properties.path.description };
  };

  const plain = await described();
  assert.ok(!plain.description.includes('outside'));
  assert.equal(plain.path, 'Mount-prefixed image path, e.g. "project/photos/name.png".');
  const outside = await described('read-only');
  assert.equal(outside.description, `${plain.description} ${READS_OUTSIDE}`);
  assert.equal(outside.path, `Mount-prefixed image path, e.g. "project/photos/name.png"${PATH_OUTSIDE}.`);
});

test("an agent's bare read_image call for a file outside the mounts puts the picture in its live round", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'af-outside-live-')));
  mkdirSync(join(root, 'mount'));
  const shot = join(root, 'shot.png');
  writeFileSync(shot, PNG);

  const membrane = new MockMembrane();
  membrane.pushResponse(createStreamResponse([{ type: 'tool_use', id: 'look-1', name: 'read_image', input: { path: shot } }], 'tool_use'));
  membrane.pushResponse(createStreamResponse([{ type: 'text', text: 'Seen.' }]));
  const workspace = new WorkspaceModule({ mounts: [{ name: 'work', path: join(root, 'mount'), mode: 'read-write', watch: 'never' }], outsideMounts: 'read-only' });
  const kick: Module = {
    name: 'kick',
    async start() {},
    async stop() {},
    getTools: () => [],
    handleToolCall: async () => ({ success: false, error: 'unexpected tool call', isError: true }),
    onProcess: async (event: ProcessEvent): Promise<EventResponse> => (event.type === 'external-message' ? { requestInference: true } : {}),
  };
  const framework = await AgentFramework.create({
    storePath: join(root, 'framework.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'mock', systemPrompt: 'test' }],
    modules: [workspace, kick],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
  });
  workspace.initStore(framework.getStore());
  t.after(async () => {
    await framework.stop().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  });

  framework.pushEvent({ type: 'external-message', source: 'test', content: 'Look at the shot', metadata: {} });
  await framework.runUntilIdle();

  const live = membrane.lastStream?.receivedToolResults[0] as Array<{
    toolUseId: string; isError: boolean; content: Array<{ type: string; source?: { data: string; mediaType: string } }>;
  }> | undefined;
  assert.ok(live, 'the tool result reaches the live round');
  assert.equal(live[0]!.toolUseId, 'look-1');
  assert.equal(live[0]!.isError, false);
  const image = live[0]!.content.find((block) => block.type === 'image');
  assert.equal(image?.source?.data, PNG.toString('base64'));
  assert.equal(image?.source?.mediaType, 'image/png');
});
