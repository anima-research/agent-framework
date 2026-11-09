import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventResponse, Module, ProcessEvent, ToolDefinition, ToolResult } from '../src/index.js';
import { AgentFramework, PassthroughStrategy } from '../src/index.js';
import { DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS, nonErrorResultText, truncateForHistory } from '../src/tool-result-history.js';
import { keptWhenWithheld } from '../src/tool-result-guard.js';
import { TOOL_RESULT_NOTICE_ROOM, parseImagePlaceholders } from '../src/tool-image-ledger.js';
import { WorkspaceModule } from '../src/modules/workspace/index.js';
import { createMockResponse, MockMembrane } from './helpers/mock-membrane.js';

const lines = (n: number, tag = 'line'): string =>
  Array.from({ length: n }, (_, i) => `${tag} ${String(i).padStart(6, '0')} ${'x'.repeat(59 - tag.length - 8)}`).join('\n');
const LINE = 60;

function elided(text: string): { h: number; e: number; m: number } {
  const found = text.match(/chars (\d+) to (\d+) of (?:these fields' )?(\d+) elided here/);
  assert.ok(found, `a marker naming the elided chars: ${text.slice(0, 200)} … ${text.slice(-200)}`);
  return { h: Number(found[1]), e: Number(found[2]), m: Number(found[3]) };
}

function headMarkerTail(copy: string, whole: string, between = /^\n\n\[truncated — [^\n]*\]\n$/): { h: number; e: number; m: number } {
  const at = elided(copy);
  assert.equal(at.m, whole.length, 'the marker counts the whole');
  assert.ok(at.h > 0 && at.e > at.h && at.e < at.m, `a head, a middle and a tail: ${JSON.stringify(at)}`);
  assert.ok(copy.startsWith(whole.slice(0, at.h)), 'the copy starts with the head the marker names');
  assert.ok(copy.endsWith(whole.slice(at.e)), 'and ends with the tail it names');
  assert.match(copy.slice(at.h, copy.length - (at.m - at.e)), between, 'with one marker between them');
  return at;
}

class CannedToolModule implements Module {
  readonly name = 'canned';
  constructor(private result: ToolResult) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'fetch', description: 'Returns the canned payload.', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    return this.result;
  }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return { addMessages: [{ participant: 'User', content: (event as { content: unknown }).content as never }], requestInference: true };
    }
    return {};
  }
}

class BoundedStrategy extends PassthroughStrategy {
  readonly maxMessageTokens = 1000;
}

interface Turn {
  framework: AgentFramework;
  membrane: MockMembrane;
  workspace: WorkspaceModule | null;
  tempDir: string;
}

async function startTurn(opts: { result: ToolResult; withWorkspace: boolean; workspaceMaxFileSize?: number; bounded?: boolean }): Promise<Turn> {
  const tempDir = mkdtempSync(join(tmpdir(), 'head-tail-'));
  const membrane = new MockMembrane();
  membrane.pushResponse(createMockResponse([
    { type: 'text', text: 'Fetching.' },
    { type: 'tool_use', id: 'call_fetch', name: 'canned--fetch', input: {} },
  ], 'tool_use'));
  membrane.pushResponse(createMockResponse([{ type: 'text', text: 'Handled.' }]));
  const modules: Module[] = [new CannedToolModule(opts.result)];
  let workspace: WorkspaceModule | null = null;
  if (opts.withWorkspace) {
    const mountDir = join(tempDir, 'mount');
    mkdirSync(mountDir, { recursive: true });
    workspace = new WorkspaceModule({
      mounts: [{
        name: 'files', path: mountDir, mode: 'read-write', watch: 'never',
        ...(opts.workspaceMaxFileSize !== undefined ? { maxFileSize: opts.workspaceMaxFileSize } : {}),
      }],
    });
    modules.push(workspace as unknown as Module);
  }
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'store'),
    membrane: membrane.asMembrane(),
    agents: [{
      name: 'prime', model: 'test-model', systemPrompt: 'You are prime.', allowedTools: 'all',
      ...(opts.bounded ? { strategy: new BoundedStrategy() as never } : {}),
    }],
    modules,
    syncIntervalMs: 0,
  });
  workspace?.initStore(framework.getStore());
  framework.start();
  framework.pushEvent({
    type: 'external-message', source: 'test', content: [{ type: 'text', text: 'fetch it' }], metadata: {}, triggerInference: true,
  } as unknown as ProcessEvent);
  return { framework, membrane, workspace, tempDir };
}

async function storedResult(framework: AgentFramework, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const msgs = (framework.getAgent('prime')?.getContextManager().queryMessages({}).messages ?? []) as unknown as Array<{
      content: Array<{ type: string; content?: unknown }>;
    }>;
    for (const m of msgs) for (const b of m.content ?? []) if (b.type === 'tool_result') return b.content as string;
  }
  assert.fail('no tool result was stored');
}

async function liveResult(membrane: MockMembrane, timeoutMs = 20_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const wire = membrane.lastStream?.receivedToolResults[0] as Array<{ content: unknown }> | undefined;
    if (wire?.length) return wire[0]!.content;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('no tool result was sent');
}

async function fileText(workspace: WorkspaceModule, path: string): Promise<string> {
  const file = await workspace.readBinary(path);
  assert.ok('data' in file, `the file is readable: ${JSON.stringify(file)}`);
  return (file as { data: Buffer }).data.toString('utf8');
}

async function stop(turn: Turn): Promise<void> {
  await turn.framework.stop();
  rmSync(turn.tempDir, { recursive: true, force: true });
}

describe('an over-long tool result keeps head and tail', () => {
  it('stores head, marker and tail; the marker\'s read returns the elided chars; the live copy is the stored one', async () => {
    const body = lines(1000);
    assert.equal(body.length, 1000 * LINE - 1);
    const turn = await startTurn({ result: { success: true, data: body }, withWorkspace: true });
    try {
      const stored = await storedResult(turn.framework);
      const { h, e, m } = headMarkerTail(stored, body);
      const headShare = Math.floor(DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS * 0.6);
      const tailShare = DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS - headShare;
      assert.ok(h <= headShare && h > headShare - LINE, `head ${h}`);
      assert.ok(m - e <= tailShare && m - e > tailShare - LINE, `tail ${m - e}`);
      assert.equal(body[h - 1], '\n', 'the head ends at a line break');
      assert.equal(body[e - 1], '\n', 'the tail starts a line');
      assert.ok(stored.endsWith(body.split('\n').at(-1)!), 'the last line is kept');
      const path = stored.match(/workspace file (\S+?\.txt)/)?.[1];
      assert.ok(path, 'the marker names the file');
      assert.equal(await fileText(turn.workspace!, path), body, 'the file holds the whole');
      const command = stored.match(/workspace--read (\{[^\n]*?\})/);
      assert.ok(command, 'the marker gives a read');
      const input = JSON.parse(command[1]!) as { path: string; offsetChars: number; limitChars: number };
      assert.equal(input.path, path);
      assert.equal(input.offsetChars, h, 'the read starts where the head ends');
      const until = Number(/until it is null or at least (\d+)/.exec(stored)?.[1]);
      assert.equal(until, e, 'the read stops where the marker says the middle ends');
      let read = '';
      for (let page = 0; ; page++) {
        const result = await turn.framework.executeToolCall({ id: `page-${page}`, name: 'workspace--read', input, callerAgentName: 'prime' });
        assert.equal(result.success, true, result.error);
        const got = result.structured as { content: string; offsetChars: number; nextOffsetChars: number | null };
        assert.equal(got.offsetChars, h + read.length);
        read += got.content;
        if (got.nextOffsetChars === null || got.nextOffsetChars >= until) break;
        input.offsetChars = got.nextOffsetChars;
        assert.ok(page < 100, 'paging ends');
      }
      assert.equal(read.slice(0, e - h), body.slice(h, e), 'the pages start with the elided chars');
      assert.equal(await liveResult(turn.membrane), stored, 'the live copy is the stored copy');
    } finally {
      await stop(turn);
    }
  });

  it('cuts a text block beside an image to head, marker and tail live, the marker naming the file\'s offsets', async () => {
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const body = lines(1000);
    const result: ToolResult = { success: true, data: [{ type: 'image', data: PNG, mimeType: 'image/png' }, { type: 'text', text: body }], dataIsContent: true };
    const turn = await startTurn({ result, withWorkspace: true });
    try {
      const live = await liveResult(turn.membrane) as Array<{ type: string; text?: string }>;
      assert.equal(live[0]!.type, 'image');
      const text = live[1]!.text!;
      const marker = text.match(/\n\n\[truncated — chars (\d+) to (\d+) of (\d+) elided here; full serialized result: workspace file (\S+?\.txt)\]\n/);
      assert.ok(marker, text.slice(14_000, 14_600));
      const [a, b, m] = [Number(marker[1]), Number(marker[2]), Number(marker[3])];
      const whole = await fileText(turn.workspace!, marker[4]!);
      assert.equal(m, whole.length);
      const head = text.slice(0, marker.index);
      const tail = text.slice(marker.index! + marker[0].length);
      assert.ok(tail.length > 0 && body.endsWith(tail), 'the block\'s tail is kept');
      assert.equal(head + whole.slice(a, b) + tail, body, 'the file\'s chars a to b are exactly what the block elided');
    } finally {
      await stop(turn);
    }
  });

  it('re-appends a middle image slot the live copy showed after the marker, and keeps a tail slot in place', async () => {
    const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    const image = { type: 'image', data: PNG, mimeType: 'image/png' };
    const result: ToolResult = {
      success: true,
      data: [{ type: 'text', text: lines(500, 'one') }, image, { type: 'text', text: lines(500, 'two') }, image, { type: 'text', text: 'end of result' }],
      dataIsContent: true,
    };
    const turn = await startTurn({ result, withWorkspace: true });
    try {
      const stored = await storedResult(turn.framework);
      assert.ok(stored.startsWith('one 000000 '), stored.slice(0, 40));
      assert.ok(stored.endsWith('\nend of result'), stored.slice(-200));
      const slots = parseImagePlaceholders(stored);
      assert.equal(slots.length, 2, JSON.stringify(slots));
      const afterMarker = stored.indexOf('\n', stored.indexOf('\n\n[truncated — ') + 2) + 1;
      const between = stored.slice(afterMarker).match(/^(?:\[[^\n]*\]\n)*(?=two \d{6} )/);
      assert.ok(between, `the tail follows the kept slots: ${stored.slice(afterMarker, afterMarker + 300)}`);
      const tailStart = afterMarker + between[0].length;
      assert.ok(slots[0]!.offset >= afterMarker && slots[0]!.offset < tailStart, 'the middle slot sits after the marker, before the tail');
      assert.ok(slots[1]!.offset > tailStart, 'the tail\'s slot stays where it was');
      assert.match(stored.slice(afterMarker, tailStart), /^\[1 image slot\(s\) /, 'one slot was elided');
    } finally {
      await stop(turn);
    }
  });

  it('under a reader\'s bound keeps both ends, the copy within the bound', async () => {
    const body = lines(400).replaceAll('\n', ' ');
    const turn = await startTurn({ result: { success: true, data: body }, withWorkspace: true, bounded: true });
    try {
      const stored = await storedResult(turn.framework);
      const settings = (turn.framework as unknown as {
        collectAgentSettingsExtensions(): Map<string, { get(agentName: string): Record<string, unknown> }>;
      }).collectAgentSettingsExtensions().get('_framework')!.get('prime');
      assert.equal(settings.tool_result_inline_max_chars_clamped_by, 'strategy-bound');
      const bound = settings.tool_result_inline_max_chars_effective as number;
      assert.ok(bound < body.length);
      assert.ok(stored.length <= bound, `stored ${stored.length} of a bound of ${bound}`);
      const { h, e, m } = headMarkerTail(stored, body);
      assert.ok(h + (m - e) <= bound - TOOL_RESULT_NOTICE_ROOM, `kept ${h + m - e}`);
      assert.equal(h, Math.max(1, Math.floor((h + m - e) * 0.6)), `head ${h} tail ${m - e}: 60/40 of what it keeps`);
    } finally {
      await stop(turn);
    }
  });

  it('with no file mount keeps head and tail and says the middle was not retained', async () => {
    const body = lines(1000);
    const turn = await startTurn({ result: { success: true, data: body }, withWorkspace: false });
    try {
      const stored = await storedResult(turn.framework);
      const { h, e, m } = headMarkerTail(stored, body, /^\n\n\[truncated — [^\n]*the middle was not retained\]\n$/);
      assert.ok(h + (m - e) <= DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS);
    } finally {
      await stop(turn);
    }
  });

  it('when the file write fails keeps head and tail and says the middle was not retained', async () => {
    const body = lines(1000);
    const turn = await startTurn({ result: { success: true, data: body }, withWorkspace: true, workspaceMaxFileSize: 1000 });
    try {
      const stored = await storedResult(turn.framework);
      const { h, e, m } = headMarkerTail(stored, body, /^\n\n\[truncated — [^\n]*FAILED[^\n]*the middle was not retained\]\n$/);
      assert.ok(h + (m - e) <= DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS);
    } finally {
      await stop(turn);
    }
  });
});

describe('the copies with no file keep head and tail (truncateForHistory)', () => {
  it('keeps 60/40 of the cap, each end at a line break, the last line kept', () => {
    const text = lines(200);
    const cut = truncateForHistory(text, 2000);
    const { h, e, m } = headMarkerTail(cut, text);
    assert.ok(h <= 1200 && h > 1200 - LINE, `head ${h}`);
    assert.ok(m - e <= 800 && m - e > 800 - LINE, `tail ${m - e}`);
    assert.equal(text[h - 1], '\n');
    assert.equal(text[e - 1], '\n');
    assert.equal(truncateForHistory(text, text.length), text, 'a text at its cap is unchanged');
  });

  it('keeps a whole line at either end when its share ends or starts exactly at a line break', () => {
    const text = 'ninechars\n'.repeat(20);
    const at100 = headMarkerTail(truncateForHistory(text, 100), text);
    assert.deepEqual([at100.h, at100.e], [60, 160], 'a tail starting a line keeps it');
    const at99 = headMarkerTail(truncateForHistory(text, 99), text);
    assert.deepEqual([at99.h, at99.e], [59, 160], 'a head ending at a line break keeps the line');
  });

  it('splits no surrogate pair at either end', () => {
    for (const cap of [1000, 1001, 1002, 1003]) {
      const text = '😀'.repeat(5000);
      const cut = truncateForHistory(text, cap);
      assert.ok(cut.isWellFormed(), `cap ${cap}`);
      headMarkerTail(cut, text);
    }
  });

  it('splits no image slot at either end', () => {
    const slot = '[image: image/png, 1.2KB, ref img_abc_1]';
    assert.equal(slot.length, 40);
    for (let at = 0; at <= 41; at++) {
      const text = 'a'.repeat(600 - at) + slot + 'b'.repeat(960) + slot + 'c'.repeat(360 + at);
      assert.equal(text.length, 2000);
      const cut = truncateForHistory(text, 1000);
      const { h, e } = headMarkerTail(cut, text);
      for (const slot of parseImagePlaceholders(text)) {
        const end = slot.offset + slot.text.length;
        assert.ok(!(slot.offset < h && h < end) && !(slot.offset < e && e < end), `at ${at}: neither end falls inside a slot`);
      }
      const opened = cut.split('[image: ').length - 1;
      assert.equal(parseImagePlaceholders(cut).length, opened, `at ${at}: every slot in the copy is whole`);
    }
  });

  it('moves the head back to a line break that lies within half its share of the head\'s end', () => {
    for (let k = 0; k < 10; k++) {
      const text = 'a'.repeat(k) + '\n' + 'X'.repeat(100);
      const { h } = headMarkerTail(truncateForHistory(text, 17), text);
      const dropped = 10 - (k + 1);
      assert.equal(h, dropped < 5 ? k + 1 : 10, `a break after char ${k}: the head keeps ${dropped < 5 ? 'to the break' : 'its share'}`);
    }
  });

  it('starts the tail past a reference stub its share would split, whatever the reference\'s type', () => {
    const stub = '[ref_1_ab3d] ' + 'notes '.repeat(20) + '— text/plain, 1.2KB claimed — from tool result';
    const text = 'a'.repeat(2000) + '\n' + stub + '\n' + 'z'.repeat(10);
    const start = text.indexOf(stub);
    const end = start + stub.length;
    let inStub = 0;
    let inId = 0;
    for (let cap = 20; cap <= 600; cap++) {
      const raw = text.length - (cap - Math.floor(cap * 0.6));
      if (!(start < raw && raw < end)) continue;
      inStub++;
      if (raw < start + '[ref_1_ab3d]'.length) inId++;
      const { e } = headMarkerTail(truncateForHistory(text, cap), text);
      assert.ok(!(start < e && e < end), `cap ${cap}: the tail starts outside the stub (raw ${raw - start} into it, kept from ${e - start})`);
    }
    assert.ok(inStub > 100 && inId > 0, `premise: the tail's share starts inside the stub, its id included (${inStub}, ${inId})`);
  });

  it('starts no tail on a stub-shaped line that a stub quoted mid-line would make', () => {
    const quoted = '[ref_1_ab3d] cam.png — image/png, 1.2KB claimed — from tool result';
    const text = 'a'.repeat(2000) + '\nseen earlier: ' + quoted + '\n' + 'z'.repeat(10);
    const at = text.indexOf(quoted);
    assert.equal(parseImagePlaceholders(text).length, 0, 'premise: the quoted stub is no slot in the whole');
    let onIt = 0;
    for (let cap = 20; cap <= 600; cap++) {
      if (text.length - (cap - Math.floor(cap * 0.6)) === at) onIt++;
      const cut = truncateForHistory(text, cap);
      headMarkerTail(cut, text);
      assert.equal(parseImagePlaceholders(cut).length, 0, `cap ${cap}: the copy shows no slot the whole doesn't`);
    }
    assert.ok(onIt > 0, "premise: some cap's tail share starts exactly on the quoted stub");
  });

  it('keeps an over-cap error text\'s last line on the history path', () => {
    const error = lines(1000, 'err');
    const text = nonErrorResultText({ error }, 2000);
    headMarkerTail(text, error);
    assert.ok(text.endsWith(error.split('\n').at(-1)!));
  });
});

describe('the stored copy\'s notice', () => {
  it('fits TOOL_RESULT_NOTICE_ROOM at its longest: a seventy-character mount, the longest label and nine-digit offsets', () => {
    const framework = Object.create(AgentFramework.prototype) as {
      spillNotice(kept: { head: number; tail: number }, content: string, shown: null, bound: undefined, readCap: number, written: { path: string }): string;
    };
    const path = `${'m'.repeat(70)}/tool-results/${'l'.repeat(80)}.txt`;
    const content = { length: 999_999_999 } as unknown as string;
    const notice = framework.spillNotice({ head: 123_456_789, tail: 123_456_789 }, content, null, undefined, 1_000_000, { path });
    assert.match(notice, /chars 123456789 to 876543210 of 999999999 elided here/);
    assert.match(notice, /"limitChars":2000\}/, 'the largest page');
    assert.match(notice, /Or raise the inline cap/, 'with the offer to raise');
    assert.ok(notice.length <= TOOL_RESULT_NOTICE_ROOM, `a notice of ${notice.length} in a room of ${TOOL_RESULT_NOTICE_ROOM}`);
  });
});

describe('a withheld result\'s kept fields keep head and tail (keptWhenWithheld)', () => {
  const SENTINEL = 'zz-unmarked-sentinel';
  const data = {
    secret: SENTINEL.repeat(20),
    path: 'notes/today.md',
    files: Array.from({ length: 200 }, (_, i) => `dir/file-${i}.txt`).concat(['dir/LAST-FILE.txt']),
    after: `${SENTINEL} after`,
  };
  const result = { success: true, data, keepWhenWithheld: ['path', 'files'] } as ToolResult;

  it('keeps the marked fields\' end, within the cap, and never an unmarked field\'s value', () => {
    const whole = keptWhenWithheld(result, undefined)!;
    assert.ok(!whole.includes(SENTINEL));
    for (let cap = 1; cap < whole.length; cap++) {
      const kept = keptWhenWithheld(result, cap)!;
      assert.ok(!kept.includes(SENTINEL), `cap ${cap}: ${kept}`);
      const at = elided(kept);
      assert.equal(at.m, whole.length);
      assert.ok(at.h + (at.m - at.e) <= cap, `cap ${cap}: kept ${at.h + at.m - at.e}`);
      assert.ok(kept.startsWith(whole.slice(0, at.h)) && kept.endsWith(whole.slice(at.e)), `cap ${cap}`);
      if (cap >= 200) assert.ok(kept.includes('LAST-FILE'), `cap ${cap}: the last field's end is kept`);
    }
  });
});
