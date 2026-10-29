import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnthropicAdapter, Membrane, MembraneError, NativeFormatter, OpenAICompatibleAdapter } from '@animalabs/membrane';
import { PROGRESS_BOUNDS, type ProgressBounds } from '@animalabs/membrane/progress-bounds';
import { MEMBRANE_RETRY_SETTINGS, type RetrySettings } from '@animalabs/membrane/retry';

import { AgentFramework, DefaultErrorPolicy, FLAT_MINIMUM_MS } from '../src/index.js';
import type { ErrorAction, EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, ToolCall, ToolDefinition, ToolResult } from '../src/index.js';
import type { InferenceRouter } from '../src/mcpl/inference-router.js';

type Play =
  | 'whole' | 'error500' | 'error408' | 'tool-use' | 'refusal'
  | 'quiet-before-content' | 'silent-after-start' | 'pings-after-content' | 'deltas-after-content' | 'think-then-pings' | 'content-then-think'
  | 'openai-comments' | 'openai-headers-only'
  | 'no-headers' | 'body-trickle';

const TICK_MS = 50;

// The file runs on one stepped clock: node:test's mocked setTimeout,
// setInterval and Date, with performance.now (which membrane's bounds compare
// against, and mock.timers doesn't cover) read from the same mocked Date, from
// a whole millisecond. The sockets to the stand-in provider stay real. The
// clock moves STEP_MS once per turn of the real event loop, and not while a
// file or lookup request is in flight. The stand-in runs in this process over
// loopback, so reading what it writes takes loop turns, not wall time, and
// the shortest bound here is 60 turns: a verdict rests on loop turns, not on
// the machine's load.
//
// It's one clock for the file because a clock reset between tests left later
// turns with failed calls or tool rounds unable to stop, and a fractional
// performance.now base froze some runs of the file outright: both by runs,
// their causes unread.
const STEP_MS = 5;
const REAL_WORK = /^(FSReq|GetAddrInfo|GetNameInfo)/;
const realSetImmediate = setImmediate;
let clockRuns = false;
before(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const dateBase = Date.now();
  const perfBase = Math.floor(performance.now());
  Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: () => perfBase + (Date.now() - dateBase) });
  clockRuns = true;
  const step = (): void => {
    if (!clockRuns) return;
    try {
      if (!process.getActiveResourcesInfo().some((kind) => REAL_WORK.test(kind))) mock.timers.tick(STEP_MS);
    } finally {
      realSetImmediate(step);
    }
  };
  realSetImmediate(step);
});
after(() => {
  clockRuns = false;
  mock.timers.reset();
  delete (performance as { now?: unknown }).now;
});
const NOT_ENDED = Symbol('not ended');
const within = <T>(work: Promise<T>, ms: number): Promise<T | typeof NOT_ENDED> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([work, new Promise<typeof NOT_ENDED>((resolve) => { timer = setTimeout(() => resolve(NOT_ENDED), ms); })])
    .finally(() => clearTimeout(timer));
};
const until = async (check: () => boolean, what: string, ms = 8_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const SHORT = { progressBounds: { beforeContentMs: 300, betweenEventsMs: 300, thinkTokensPerSecond: 1_000_000 }, flatMinimumMs: 400 };
const SHORT_WITH_RATE = (thinkTokensPerSecond: number) => ({ ...SHORT, progressBounds: { ...SHORT.progressBounds, thinkTokensPerSecond } });

const sse = (type: string, data: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const START = sse('message_start', { message: { id: 'msg_t', type: 'message', role: 'assistant', model: 't', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
const TEXT_START = sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
const delta = (text: string) => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
const ending = (stopReason: string) => sse('content_block_stop', { index: 0 }) + sse('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }) + sse('message_stop', {});
const OPENAI_CHUNK = `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 't', choices: [{ index: 0, delta: { role: 'assistant', content: 'Thinking it over' }, finish_reason: null }] })}\n\n`;

interface Provider { base: string; requests: () => number; arrivals: number[]; close: () => Promise<void> }

async function provider(plays: Play[]): Promise<Provider> {
  let n = 0;
  const arrivals: number[] = [];
  const timers = new Set<ReturnType<typeof setInterval>>();
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      if (String(req.url).includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 10 }));
        return;
      }
      const play = plays[Math.min(n, plays.length - 1)]!;
      n += 1;
      arrivals.push(Date.now());
      const every = (write: () => void) => {
        const timer = setInterval(write, TICK_MS);
        timers.add(timer);
        res.on('close', () => clearInterval(timer));
      };
      const stream = () => res.writeHead(200, { 'content-type': 'text/event-stream' });
      switch (play) {
        case 'whole':
          stream();
          res.end(START + TEXT_START + delta('The answer.') + ending('end_turn'));
          return;
        case 'refusal':
          stream();
          res.end(START + TEXT_START + delta('I can') + ending('refusal'));
          return;
        case 'tool-use':
          stream();
          res.end(START +
            sse('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${n}`, name: 'look', input: {} } }) +
            sse('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }) +
            ending('tool_use'));
          return;
        case 'error408':
          res.writeHead(408, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'timeout_error', message: 'stand-in request timeout' } }));
          return;
        case 'error500':
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stand-in internal error' } }));
          return;
        case 'quiet-before-content':
          stream();
          res.write(START);
          every(() => res.write(sse('ping', {})));
          return;
        case 'silent-after-start':
          stream();
          res.write(START);
          return;
        case 'pings-after-content':
          stream();
          res.write(START + TEXT_START + delta('Thinking it over'));
          every(() => res.write(sse('ping', {})));
          return;
        case 'deltas-after-content':
          stream();
          res.write(START + TEXT_START + delta('Thinking it over'));
          every(() => res.write(delta('.')));
          return;
        case 'content-then-think':
          stream();
          res.write(START + TEXT_START + delta('Thinking it over') + sse('content_block_stop', { index: 0 }) + sse('content_block_start', { index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } }));
          every(() => res.write(sse('ping', {})));
          return;
        case 'think-then-pings':
          stream();
          res.write(START + sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }));
          every(() => res.write(sse('ping', {})));
          return;
        case 'openai-comments':
          stream();
          res.write(OPENAI_CHUNK);
          every(() => res.write(': keepalive\n\n'));
          return;
        case 'openai-headers-only':
          stream();
          res.flushHeaders();
          return;
        case 'no-headers':
          return;
        case 'body-trickle':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{');
          every(() => res.write(' '));
          return;
      }
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => n,
    arrivals,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

class Asker implements Module {
  readonly name = 'asker';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return [{ name: 'look', description: 'Look around', inputSchema: { type: 'object', properties: {} } }]; }
  async handleToolCall(_call: ToolCall): Promise<ToolResult> { return { success: true, data: { saw: 'a quiet room' } }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return { addMessages: [{ participant: 'Antra', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }], requestInference: true };
  }
}

class Recording extends Membrane {
  readonly sent: Array<{ kind: 'stream' | 'complete'; options: Record<string, unknown> | undefined }> = [];
  override streamYielding(...args: Parameters<Membrane['streamYielding']>) {
    this.sent.push({ kind: 'stream', options: args[1] as Record<string, unknown> | undefined });
    return super.streamYielding(...args);
  }
  override complete(...args: Parameters<Membrane['complete']>) {
    this.sent.push({ kind: 'complete', options: args[1] as Record<string, unknown> | undefined });
    return super.complete(...args);
  }
}

class WatchdogsAt200ms extends Membrane {
  override streamYielding(...args: Parameters<Membrane['streamYielding']>) {
    return super.streamYielding(args[0], { ...args[1], idleTimeoutMs: 200, firstEventTimeoutMs: 200 } as Parameters<Membrane['streamYielding']>[1]);
  }
}

const adapterFor = (stand: Provider, openai = false) => openai
  ? new OpenAICompatibleAdapter({ apiKey: 'test-key', baseURL: stand.base } as never)
  : new AnthropicAdapter({ apiKey: 'test-key', baseURL: stand.base, cacheKeepalive: { enabled: false } } as never);

async function framework(stand: Provider, options: { openai?: boolean; inferenceBounds?: unknown; agent?: Record<string, unknown>; errors?: Error[]; membrane?: Membrane; retries?: RetrySettings; rearmMs?: number[] } = {}) {
  const policy = new DefaultErrorPolicy(options.retries);
  return AgentFramework.create({
    storePath: join(mkdtempSync(join(tmpdir(), 'af-bounds-')), 'store.chronicle'),
    membrane: options.membrane ?? new Membrane(adapterFor(stand, options.openai)),
    agents: [{ name: 'resident', model: options.openai ? 'gpt-test' : 'claude-opus-5-5', systemPrompt: 'You are a resident.', maxTokens: 4096, ...options.agent } as never],
    modules: [new Asker()],
    syncIntervalMs: 0,
    maintenanceIntervalMs: 0,
    ...(options.rearmMs ? { exhaustedTurnRearmMs: options.rearmMs } : {}),
    errorPolicy: {
      maxRetries: policy.maxRetries,
      onInferenceError(error: Error, agentName: string, attempt: number): ErrorAction {
        options.errors?.push(error);
        return policy.onInferenceError(error, agentName, attempt);
      },
    },
    ...('inferenceBounds' in options ? (options.inferenceBounds === undefined ? {} : { inferenceBounds: options.inferenceBounds as never }) : { inferenceBounds: SHORT }),
  });
}

interface Turn {
  requests: number;
  arrivals: number[];
  traces: Array<{ type: string; error?: unknown }>;
  markers: string[];
  errors: Error[];
  idle: boolean;
  endedAt: number;
}

async function turn(plays: Play[], options: { openai?: boolean; inferenceBounds?: unknown; agent?: Record<string, unknown>; waitMs?: number; stopInFirstWait?: boolean; membrane?: (stand: Provider) => Membrane; retries?: RetrySettings; rearmMs?: number[]; untilRequests?: number } = {}): Promise<Turn & { stoppedInWait?: boolean; requestsWhenStopped?: number }> {
  const stand = await provider(plays);
  const errors: Error[] = [];
  const { membrane: makeMembrane, untilRequests, ...rest } = options;
  const fw = await framework(stand, { ...rest, errors, ...(makeMembrane ? { membrane: makeMembrane(stand) } : {}) });
  const traces: Turn['traces'] = [];
  fw.onTrace((event) => {
    const type = (event as { type: string }).type;
    if (type.startsWith('inference:') && type !== 'inference:tokens') traces.push({ type, error: (event as { error?: unknown }).error });
  });
  const error = console.error;
  console.error = () => {};
  let idle = false;
  let stoppedInWait: boolean | undefined;
  let requestsWhenStopped: number | undefined;
  try {
    fw.start();
    fw.pushEvent({ type: 'external-message', source: 'test', content: 'Hello?', metadata: {} } as unknown as ProcessEvent);
    if (options.stopInFirstWait) {
      await until(() => traces.some((t) => t.type === 'inference:waiting'), 'the first wait to send a cut call again');
      requestsWhenStopped = stand.requests();
      stoppedInWait = Boolean(fw.abortInference('resident', 'the test stops it during its wait to retry'));
      await fw.runUntilIdle();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'And now?', metadata: {} } as unknown as ProcessEvent);
    }
    if (untilRequests !== undefined) {
      await until(() => stand.requests() >= untilRequests, `request ${untilRequests}`, 15_000);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    idle = (await within(fw.runUntilIdle().then(() => 'idle' as const), options.waitMs ?? 15_000)) === 'idle';
    const endedAt = Date.now();
    const rows = (fw.getAgent('resident')!.getContextManager() as unknown as { getAllMessages(): Array<{ content: Array<{ type: string; text?: string }> }> }).getAllMessages();
    const markers = rows.flatMap((row) => row.content).flatMap((block) => block.type === 'text' && block.text?.startsWith('[inference-failed]') ? [block.text] : []);
    return { requests: stand.requests(), arrivals: [...stand.arrivals], traces, markers, errors, idle, endedAt, stoppedInWait, requestsWhenStopped };
  } finally {
    console.error = error;
    await fw.stop();
    await stand.close();
  }
}

const exhausted = (t: Turn) => t.traces.filter((e) => e.type === 'inference:exhausted');
const completed = (t: Turn) => t.traces.filter((e) => e.type === 'inference:completed');
const gap = (t: Turn, i: number) => t.arrivals[i + 1]! - t.arrivals[i]!;

describe('inference bounds: a stalled turn call ends at its bound', () => {
  it('an Anthropic stream with no content ends at beforeContentMs, gets one fresh call 1 s later, and the turn then ends as a timeout', async () => {
    const t = await turn(['quiet-before-content']);
    assert.equal(t.idle, true);
    assert.equal(t.requests, 2);
    assert.equal(exhausted(t).length, 1);
    assert.match(String(exhausted(t)[0]!.error), /^No content within 0\.3s of the send/);
    assert.match(String(exhausted(t)[0]!.error), /\(the host's setting for this bound: `inferenceBounds\.progressBounds\.beforeContentMs`\)$/);
    assert.ok(gap(t, 0) >= 1_250 && gap(t, 0) < 1_450, `the fresh call came ${gap(t, 0)} ms after the first, its 0.3 s bound and the 1 s wait`);
  });

  it('an Anthropic stream that only pings after content ends at betweenEventsMs, twice', async () => {
    const t = await turn(['pings-after-content']);
    assert.equal(t.requests, 2);
    assert.match(String(exhausted(t)[0]!.error), /^No provider event within 0\.3s/);
    assert.match(String(exhausted(t)[0]!.error), /\(the host's setting for this bound: `inferenceBounds\.progressBounds\.betweenEventsMs`\)$/);
  });

  it('a thinking block that starts before content gets its allowance, max_tokens at thinkTokensPerSecond, not beforeContentMs', async () => {
    const t = await turn(['think-then-pings'], { inferenceBounds: SHORT_WITH_RATE(2_048) });
    assert.equal(t.requests, 2);
    assert.match(String(exhausted(t)[0]!.error), /^No content within 2s of a thinking block's start \(max_tokens 4096 at 2048 tokens a second\)/);
    assert.match(String(exhausted(t)[0]!.error), /\(the host's setting for this bound: `inferenceBounds\.progressBounds\.thinkTokensPerSecond`\)$/);
    assert.ok(gap(t, 0) >= 2_900 && gap(t, 0) < 3_100, `the fresh call came ${gap(t, 0)} ms after the first, its 2 s allowance and the 1 s wait`);
  });

  it('a thinking block that starts after content gets its allowance in place of betweenEventsMs when that is longer', async () => {
    const t = await turn(['content-then-think'], { inferenceBounds: SHORT_WITH_RATE(2_048) });
    assert.equal(t.requests, 2);
    assert.match(String(exhausted(t)[0]!.error), /^No provider event within 2s of a thinking block's start \(max_tokens 4096 at 2048 tokens a second\)/);
    assert.match(String(exhausted(t)[0]!.error), /\(the host's setting for this bound: `inferenceBounds\.progressBounds\.thinkTokensPerSecond`\)$/);
    assert.ok(gap(t, 0) >= 2_900 && gap(t, 0) < 3_100, `the fresh call came ${gap(t, 0)} ms after the first, its 2 s allowance and the 1 s wait`);
  });

  it('an OpenAI-compatible stream that sends only keepalive comments ends at the flat bound, twice', async () => {
    const t = await turn(['openai-comments'], { openai: true });
    assert.equal(t.idle, true);
    assert.equal(t.requests, 2);
    assert.equal(exhausted(t).length, 1);
    assert.match(String(exhausted(t)[0]!.error), /^No provider progress within 1300ms/);
    assert.match(String(exhausted(t)[0]!.error), /\(the host's setting for this bound: `inferenceBounds\.flatMinimumMs`\)$/);
    assert.ok(gap(t, 0) >= 2_250 && gap(t, 0) < 2_450, `the fresh call came ${gap(t, 0)} ms after the first, its 1.3 s flat bound and the 1 s wait`);
  });

  it('an OpenAI-compatible stream that sends its headers and no event ends at the flat bound from its send', async () => {
    const t = await turn(['openai-headers-only'], { openai: true });
    assert.equal(t.requests, 2);
    assert.match(String(exhausted(t)[0]!.error), /^No provider progress within 1300ms/);
  });

  it('a deadline expiry membrane throws on a turn gets one fresh call, and the turn then ends', async () => {
    const t = await turn(['silent-after-start'], {
      inferenceBounds: { ...SHORT, progressBounds: { ...SHORT.progressBounds, beforeContentMs: 5_000, betweenEventsMs: 5_000 } },
      membrane: (stand) => new WatchdogsAt200ms(adapterFor(stand)),
    });
    assert.equal(t.requests, 2);
    assert.equal(exhausted(t).length, 1);
    assert.equal(t.errors.length, 2);
    for (const thrown of t.errors) {
      assert.ok(thrown instanceof MembraneError && thrown.type === 'timeout' && thrown.retryable === true, String(thrown));
      assert.equal((thrown as unknown as Record<symbol, unknown>)[Symbol.for('membrane.deadlineExpiry')], true);
    }
  });

  it('flatMinimumMs sets the flat bound\'s least', async () => {
    const t = await turn(['openai-comments'], { openai: true, inferenceBounds: { ...SHORT, flatMinimumMs: 2_000 } });
    assert.equal(t.requests, 2);
    assert.match(String(exhausted(t)[0]!.error), /^No provider progress within 2000ms/);
  });

  it('the flat bound takes beforeContentMs as its setup when that\'s the larger', async () => {
    const t = await turn(['openai-comments'], { openai: true, inferenceBounds: { ...SHORT, progressBounds: { ...SHORT.progressBounds, beforeContentMs: 1_500 } } });
    assert.equal(t.requests, 2);
    assert.match(String(exhausted(t)[0]!.error), /^No provider progress within 2500ms/);
  });

  it('a fresh call that answers completes the turn, with no failure marker', async () => {
    const t = await turn(['quiet-before-content', 'whole']);
    assert.equal(t.requests, 2);
    assert.equal(completed(t).length, 1);
    assert.equal(exhausted(t).length, 0);
    assert.deepEqual(t.markers, []);
  });

  it('a cut gets its fresh call whatever other failures the turn had before it', async () => {
    const t = await turn(['error500', 'error500', 'quiet-before-content', 'whole']);
    assert.equal(t.requests, 4);
    assert.equal(completed(t).length, 1);
  });

  it('a cut gets its fresh call after an earlier round\'s cut was answered by its own fresh call', async () => {
    const t = await turn(['quiet-before-content', 'tool-use', 'quiet-before-content', 'whole']);
    assert.equal(t.requests, 4);
    assert.equal(completed(t).length, 1);
  });

  it('a cut gets its fresh call when another failure came between it and an earlier cut', async () => {
    const t = await turn(['quiet-before-content', 'error500', 'quiet-before-content', 'whole']);
    assert.equal(t.requests, 4);
    assert.equal(completed(t).length, 1);
  });

  it('a fresh call refused, sent again by membrane and cut is the same request\'s second cut, so the turn ends', async () => {
    const t = await turn(['quiet-before-content', 'refusal', 'quiet-before-content', 'whole'], { agent: { refusalHandling: { retries: 1 } } });
    assert.equal(t.requests, 3);
    assert.equal(exhausted(t).length, 1);
    assert.equal(completed(t).length, 0);
    assert.equal(t.markers.length, 1);
    assert.match(t.markers[0]!, /The call was made again, and it timed out again\./, 'membrane\'s re-send is inside the one fresh call');
  });

  it('a cut counts among the turn\'s tries for its other failures, as every failure does', async () => {
    const t = await turn(['quiet-before-content', 'error500', 'error500', 'whole']);
    assert.equal(t.requests, 3);
    assert.equal(exhausted(t).length, 1);
    assert.match(String(exhausted(t)[0]!.error), /stand-in internal error/);
    assert.equal(t.markers.length, 1);
    assert.doesNotMatch(t.markers[0]!, /made again/, 'the turn ended on a 500, not on a fresh call that timed out');
  });

  it('a turn sent again after its retries ran out gets no fresh call for a cut before a round of it has run, as for any failure', async () => {
    const t = await turn(['error500', 'error500', 'error500', 'quiet-before-content', 'whole'], { rearmMs: [100], untilRequests: 4 });
    assert.equal(t.requests, 4, 'three 500s, then the re-armed send, cut once and not sent again');
    assert.equal(completed(t).length, 0);
    assert.match(String(exhausted(t).at(-1)!.error), /^No content within 0\.3s of the send/);
  });

  it('a turn sent again after its retries ran out gets its fresh call for a cut once a round of it has run', async () => {
    const t = await turn(['error500', 'error500', 'error500', 'tool-use', 'quiet-before-content', 'whole'], { rearmMs: [100], untilRequests: 6 });
    assert.equal(t.requests, 6, 'three 500s, the re-armed send\'s tool round, its cut call and that call\'s fresh call');
    assert.equal(completed(t).length, 1);
  });

  it('a turn stopped while it waits to send a cut call again leaves the next turn its own fresh call', async () => {
    const t = await turn(['quiet-before-content', 'quiet-before-content', 'whole'], { stopInFirstWait: true });
    assert.equal(t.requestsWhenStopped, 1);
    assert.equal(t.stoppedInWait, true);
    assert.equal(t.requests, 3);
    assert.equal(completed(t).length, 1);
    assert.equal(exhausted(t).length, 0);
    assert.deepEqual(t.markers, []);
  });

  it('a bound\'s cut reaches the error policy as a timeout that isn\'t retryable, carries membrane\'s deadline mark and names the bound', async () => {
    const t = await turn(['quiet-before-content']);
    assert.equal(t.errors.length, 2);
    for (const cut of t.errors) {
      assert.ok(cut instanceof MembraneError);
      assert.equal(cut.type, 'timeout');
      assert.equal(cut.retryable, false);
      assert.equal((cut as unknown as Record<symbol, unknown>)[Symbol.for('membrane.deadlineExpiry')], true);
      assert.match(cut.message, /^No content within 0\.3s of the send/);
    }
  });

  it('a turn its cuts end tells the agent the call timed out, that the call was made again and timed out again, why, the host setting for that bound, and that a reply still owed can be given now', async () => {
    const t = await turn(['quiet-before-content']);
    assert.equal(t.markers.length, 1);
    assert.match(t.markers[0]!, /^\[inference-failed\] Your previous turn did not complete: the model call timed out and produced no response, so nothing was sent\. The call was made again, and it timed out again\. Reason: No content within 0\.3s of the send/);
    assert.match(t.markers[0]!, /\(the host's setting for this bound: `inferenceBounds\.progressBounds\.beforeContentMs`\)\. If a reply is still owed from that turn, you can give it now\.$/);
  });

  it('a host schedule that gives a deadline expiry two fresh calls says the call was made again, with no count', async () => {
    const retries = { ...MEMBRANE_RETRY_SETTINGS, deadline: { maxAttempts: 3, firstDelayMs: 50, multiplier: 1, maxDelayMs: 50, statedWaitCeilingMs: null } } as RetrySettings;
    const t = await turn(['quiet-before-content', 'quiet-before-content', 'quiet-before-content', 'whole'], { retries });
    assert.equal(t.requests, 3);
    assert.equal(t.markers.length, 1);
    assert.match(t.markers[0]!, /so nothing was sent\. The call was made again, and it timed out again\. Reason: /);
    assert.doesNotMatch(t.markers[0]!, /once more|more times/);
  });

  it('a turn whose cuts come either side of another failure says the call was made again and timed out again, with no count', async () => {
    const t = await turn(['quiet-before-content', 'error500', 'quiet-before-content', 'quiet-before-content', 'whole']);
    assert.equal(t.requests, 4, 'a cut, its fresh call\'s 500, a retry cut, and that cut\'s fresh call cut too');
    assert.equal(t.markers.length, 1);
    assert.match(t.markers[0]!, /so nothing was sent\. The call was made again, and it timed out again\. Reason: No content within 0\.3s of the send/);
    assert.doesNotMatch(t.markers[0]!, /once more|more times/);
  });

  it('a timeout that got no fresh call, such as an HTTP 408, says neither that it was sent again nor more than its cause', async () => {
    const t = await turn(['error408']);
    assert.equal(t.requests, 3);
    assert.equal(t.markers.length, 1);
    assert.match(t.markers[0]!, /^\[inference-failed\] Your previous turn did not complete: the model call timed out \(timeout, HTTP 408\) and produced no response, so nothing was sent\. Reason: /);
    assert.doesNotMatch(t.markers[0]!, /made again/);
    assert.match(t.markers[0]!, /\. If a reply is still owed from that turn, you can give it now\.$/);
  });

  it('a turn cut after a tool round tells the agent its last call timed out and its earlier rounds ran', async () => {
    const t = await turn(['tool-use', 'quiet-before-content']);
    assert.equal(t.requests, 3);
    assert.equal(t.markers.length, 1);
    assert.match(t.markers[0]!, /^\[inference-failed\] Your previous turn did not complete: its last call timed out\. The call was made again, and it timed out again\. Its earlier rounds ran, and their tool calls ran as their results show\./);
    assert.match(t.markers[0]!, /Reason: No content within 0\.3s of the send/);
    assert.match(t.markers[0]!, /\. If a reply is still owed from that turn, you can give it now\.$/);
  });

  it('a stream that keeps sending content is not ended by any progress bound', async () => {
    const t = await turn(['deltas-after-content'], { waitMs: 5_000, inferenceBounds: { ...SHORT, progressBounds: { ...SHORT.progressBounds, betweenEventsMs: 1_000 } } });
    assert.equal(t.idle, false);
    assert.equal(t.requests, 1);
    assert.ok(t.endedAt - t.arrivals[0]! >= 4_000, `the turn was still in its one call ${t.endedAt - t.arrivals[0]!} ms after it arrived, twice its 2 s flat bound`);
  });

  it('inferenceBounds: false sets none of these bounds on a turn', async () => {
    let recording: Recording | undefined;
    const t = await turn(['quiet-before-content'], { inferenceBounds: false, waitMs: 3_000, membrane: (stand) => (recording = new Recording(adapterFor(stand))) });
    assert.equal(t.idle, false);
    assert.equal(t.requests, 1);
    const stream = recording!.sent.find((s) => s.kind === 'stream')!;
    assert.equal(stream.options?.progressBounds, undefined);
    assert.equal(stream.options?.progressTimeoutMs, undefined);
  });
});

describe('inference bounds: what a host sets', () => {
  for (const [given, field] of [
    [{ progressBounds: { beforeContentMs: -1 } }, 'inferenceBounds.progressBounds.beforeContentMs'],
    [{ progressBounds: { betweenEventsMs: 'soon' } }, 'inferenceBounds.progressBounds.betweenEventsMs'],
    [{ progressBounds: { thinkTokensPerSecond: 0 } }, 'inferenceBounds.progressBounds.thinkTokensPerSecond'],
    [{ progressBounds: 5 }, 'inferenceBounds.progressBounds'],
    [{ progressBounds: null }, 'inferenceBounds.progressBounds'],
    [{ flatMinimumMs: 0 }, 'inferenceBounds.flatMinimumMs'],
    [{ flatMinimumMs: -5 }, 'inferenceBounds.flatMinimumMs'],
    [{ flatMinimumMs: Infinity }, 'inferenceBounds.flatMinimumMs'],
    [{ flatMinimumMs: NaN }, 'inferenceBounds.flatMinimumMs'],
    [{ flatMinimumMs: '5' }, 'inferenceBounds.flatMinimumMs'],
    [{ flatMinimumMs: null }, 'inferenceBounds.flatMinimumMs'],
    ['on', 'inferenceBounds'],
  ] as const) {
    it(`${JSON.stringify(given)} is refused at create, naming ${field}, before a store is opened`, async () => {
      const storePath = join(mkdtempSync(join(tmpdir(), 'af-bounds-')), 'store.chronicle');
      await assert.rejects(
        AgentFramework.create({
          storePath,
          membrane: new Membrane(new AnthropicAdapter({ apiKey: 'k' } as never)),
          agents: [{ name: 'resident', model: 'claude-opus-5-5', systemPrompt: 'x' } as never],
          modules: [],
          inferenceBounds: given as never,
        }),
        (error: Error) => error.message.startsWith(`[agent-framework] ${field}`),
      );
      assert.equal(existsSync(storePath), false);
    });
  }

  it('with no inferenceBounds a turn\'s stream is sent membrane\'s progress bounds and the 1,862 s flat minimum, and compression the whole-call bound', async () => {
    const stand = await provider(['whole']);
    const membrane = new Recording(adapterFor(stand));
    const fw = await framework(stand, { inferenceBounds: undefined, membrane });
    try {
      fw.start();
      fw.pushEvent({ type: 'external-message', source: 'test', content: 'Hello?', metadata: {} } as unknown as ProcessEvent);
      await fw.runUntilIdle();
      const compression = (fw.getAgent('resident')!.getContextManager() as unknown as { membrane: Membrane }).membrane;
      await compression.complete({ messages: [{ participant: 'user', content: [{ type: 'text', text: 'Summarize.' }] }], config: { model: 'claude-opus-5-5', maxTokens: 16_000 } } as never, { formatter: new NativeFormatter() } as never)
        .catch(() => 'the stand-in answers in a stream, which a non-streamed call can\'t read; the options it was sent are what this checks');
    } finally {
      await fw.stop();
      await stand.close();
    }
    const stream = membrane.sent.find((s) => s.kind === 'stream')!;
    assert.deepEqual({ ...(stream.options!.progressBounds as ProgressBounds) }, { ...PROGRESS_BOUNDS });
    assert.equal(stream.options!.progressTimeoutMs, FLAT_MINIMUM_MS);
    assert.equal(FLAT_MINIMUM_MS, 1_862_000);
    const complete = membrane.sent.find((s) => s.kind === 'complete')!;
    assert.equal(complete.options!.progressTimeoutMs, 334_000, '150 s, plus 16,000 tokens at 87 a second');
  });
});

describe('inference bounds: a whole non-streamed call', () => {
  async function auxiliary(play: Play, inferenceBounds: unknown, options: { callerOptions?: Record<string, unknown>; maxTokens?: number | null; through?: 'compression' | 'judge' } = {}) {
    const stand = await provider([play]);
    const recording = new Recording(adapterFor(stand));
    const fw = await framework(stand, { inferenceBounds, membrane: recording });
    const membrane = options.through === 'judge'
      ? (fw as unknown as { judgeMembraneFor(name: string): Membrane }).judgeMembraneFor('resident')
      : (fw.getAgent('resident')!.getContextManager() as unknown as { membrane: Membrane }).membrane;
    const maxTokens = options.maxTokens === undefined ? 4096 : options.maxTokens;
    const sentAt = Date.now();
    try {
      const ended = await within(membrane.complete({
        messages: [{ participant: 'user', content: [{ type: 'text', text: 'Summarize.' }] }],
        config: { model: 'claude-opus-5-5', ...(maxTokens === null ? {} : { maxTokens }) },
      } as never, { formatter: new NativeFormatter(), ...options.callerOptions } as never), 8_000);
      return { threw: ended === NOT_ENDED ? 'still waiting' : undefined as unknown, endedAfterMs: Date.now() - sentAt, requests: stand.requests(), sent: recording.sent.find((c) => c.kind === 'complete')?.options };
    } catch (error) {
      return { threw: error, endedAfterMs: Date.now() - sentAt, requests: stand.requests(), sent: recording.sent.find((c) => c.kind === 'complete')?.options };
    } finally {
      await fw.stop();
      await stand.close();
    }
  }
  // On the stepped clock a call's end is exact to a few steps, so the bound is
  // checked by when the call ended as well as by membrane's message.
  const timedOutWithin = ({ threw, endedAfterMs }: { threw: unknown; endedAfterMs: number }, ms: number) => {
    assert.ok(threw instanceof MembraneError && threw.type === 'timeout', String(threw));
    assert.match(threw.message, new RegExp(`^No provider progress within ${ms}ms`));
    assert.ok(endedAfterMs >= ms && endedAfterMs < ms + 100, `the call ended ${endedAfterMs} ms after its send, against its ${ms} ms bound`);
  };

  for (const play of ['no-headers', 'body-trickle'] as const) {
    it(`a resident's compression call to a provider that ${play === 'no-headers' ? 'never answers' : 'trickles its body'} ends at its setup plus its allowance, as a timeout that isn't retryable`, async () => {
      const call = await auxiliary(play, SHORT);
      timedOutWithin(call, 1_300);
      assert.equal((call.threw as MembraneError).retryable, false);
    });
  }

  it('the reply judge\'s call ends at the same bound', async () => {
    const call = await auxiliary('no-headers', SHORT, { through: 'judge' });
    timedOutWithin(call, 1_300);
  });

  it('the allowance is max_tokens at thinkTokensPerSecond', async () => {
    const call = await auxiliary('no-headers', SHORT_WITH_RATE(4_096), { maxTokens: 12_288 });
    timedOutWithin(call, 3_300);
  });

  it('the setup term is beforeContentMs when that\'s the larger', async () => {
    const call = await auxiliary('no-headers', { ...SHORT, progressBounds: { ...SHORT.progressBounds, beforeContentMs: 1_500 } });
    timedOutWithin(call, 2_500);
  });

  it('a call that names no max_tokens ends at the larger of the setup term and the flat minimum', async () => {
    const call = await auxiliary('no-headers', { ...SHORT, flatMinimumMs: 2_000 }, { maxTokens: null });
    timedOutWithin(call, 2_000);
    const setupLarger = await auxiliary('no-headers', { ...SHORT, progressBounds: { ...SHORT.progressBounds, beforeContentMs: 1_500 } }, { maxTokens: null });
    timedOutWithin(setupLarger, 1_500);
  });

  it('a caller\'s own progressTimeoutMs is kept in place of the framework\'s', async () => {
    const call = await auxiliary('no-headers', SHORT, { callerOptions: { progressTimeoutMs: 2_500 } });
    timedOutWithin(call, 2_500);
  });

  it('a caller\'s progressBounds, which complete() doesn\'t read, are passed on beside the framework\'s bound', async () => {
    const call = await auxiliary('no-headers', SHORT, { callerOptions: { progressBounds: { beforeContentMs: 60_000 } } });
    const sent = call.sent;
    timedOutWithin(call, 1_300);
    assert.deepEqual(sent?.progressBounds, { beforeContentMs: 60_000 });
    assert.equal(sent?.progressTimeoutMs, 1_300);
  });

  it('inferenceBounds: false sets no bound on a compression call', async () => {
    const { threw, requests, sent } = await auxiliary('no-headers', false);
    assert.equal(requests, 1);
    assert.equal(threw, 'still waiting', 'not ended in 8 s, past every bound SHORT would set');
    assert.equal(sent?.progressTimeoutMs, undefined);
  });
});

describe('inference bounds: an MCPL server\'s inference request', () => {
  async function mcpl(play: Play, options: { stream: boolean; openai?: boolean; inferenceBounds?: unknown }) {
    const stand = await provider([play]);
    const recording = new Recording(adapterFor(stand, options.openai));
    const fw = await framework(stand, { openai: options.openai, membrane: recording, inferenceBounds: 'inferenceBounds' in options ? options.inferenceBounds : SHORT });
    await (fw as unknown as { initializeMcpl(servers: unknown[], routing: unknown): Promise<void> }).initializeMcpl([], { default: options.openai ? 'gpt-test' : 'claude-opus-5-5' });
    const router = (fw as unknown as { inferenceRouter: InferenceRouter }).inferenceRouter;
    (router as unknown as { featureSetManager: unknown }).featureSetManager = { validateInbound: () => {} };
    let answered: { result?: unknown; error?: string } = {};
    const sentAt = Date.now();
    let answeredAfterMs = -1;
    try {
      const ended = await within(router.handleInferenceRequest('a-server', {
        featureSet: 'memory.consolidation',
        stream: options.stream,
        messages: [{ role: 'user', content: 'Summarize.' }],
        preferences: { maxTokens: 4096 },
      } as never, {
        requestId: 1,
        respond: (result: unknown) => { answered = { result }; },
        respondError: (_code: number, message: string) => { answered = { error: message }; answeredAfterMs = Date.now() - sentAt; },
        sendChunk: () => {},
      } as never), 8_000);
      if (ended === NOT_ENDED) answered = { error: 'still waiting' };
    } finally {
      await fw.stop();
      await stand.close();
    }
    return { answered, answeredAfterMs, requests: stand.requests(), sent: recording.sent.at(-1)?.options };
  }

  it('a non-streamed request ends at its whole-call bound, and the server is told the bound', async () => {
    const { answered, answeredAfterMs, requests } = await mcpl('no-headers', { stream: false });
    assert.equal(requests, 1);
    assert.match(String(answered.error), /^No provider progress within 1300ms/);
    assert.ok(answeredAfterMs >= 1_300 && answeredAfterMs < 1_400, `answered ${answeredAfterMs} ms after the request`);
  });

  it('a streamed request on an adapter that reports content ends at its phase bound, and the server is told the bound', async () => {
    const { answered, answeredAfterMs, requests } = await mcpl('quiet-before-content', { stream: true });
    assert.equal(requests, 1);
    assert.ok(answeredAfterMs >= 300 && answeredAfterMs < 400, `answered ${answeredAfterMs} ms after the request`);
    assert.match(String(answered.error), /^The inference stopped before it finished \(timeout: No content within 0\.3s of the send/);
    assert.match(String(answered.error), /\(the host's setting for this bound: `inferenceBounds\.progressBounds\.beforeContentMs`\)\)$/);
  });

  it('a streamed request on an adapter that doesn\'t ends at the flat bound', async () => {
    const { answered, answeredAfterMs, requests } = await mcpl('openai-comments', { stream: true, openai: true });
    assert.equal(requests, 1);
    assert.ok(answeredAfterMs >= 1_300 && answeredAfterMs < 1_400, `answered ${answeredAfterMs} ms after the request`);
    assert.match(String(answered.error), /^The inference stopped before it finished \(timeout: No provider progress within 1300ms/);
    assert.match(String(answered.error), /\(the host's setting for this bound: `inferenceBounds\.flatMinimumMs`\)\)$/);
  });

  for (const stream of [false, true]) {
    it(`inferenceBounds: false sets no bound on an MCPL ${stream ? 'streamed' : 'non-streamed'} request`, async () => {
      const { answered, requests, sent } = await mcpl(stream ? 'quiet-before-content' : 'no-headers', { stream, inferenceBounds: false });
      assert.equal(requests, 1);
      assert.equal(answered.error, 'still waiting', 'not ended in 8 s, past every bound SHORT would set');
      assert.equal(sent?.progressTimeoutMs, undefined);
      assert.equal(sent?.progressBounds, undefined);
    });
  }
});

describe('inference bounds: the deadline class', () => {
  async function markedByMembrane(): Promise<Error> {
    const stand = await provider(['silent-after-start']);
    try {
      const stream = new Membrane(adapterFor(stand)).streamYielding(
        { messages: [{ participant: 'user', content: [{ type: 'text', text: 'hi' }] }], config: { model: 'claude-opus-5-5', maxTokens: 100 } } as never,
        { retry: false, idleTimeoutMs: 200, firstEventTimeoutMs: 200 } as never,
      );
      for await (const event of stream) {
        if (event.type === 'error') return (event as { error: Error }).error;
        if (event.type === 'complete' || event.type === 'aborted') break;
      }
      throw new Error('membrane ended the stream without an error');
    } finally {
      await stand.close();
    }
  }
  const delays = (policy: DefaultErrorPolicy, error: Error) => {
    const out: number[] = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      const action = policy.onInferenceError(error, 'resident', attempt);
      if (!action.retry) return out;
      out.push(action.delayMs);
    }
    throw new Error('the policy never stopped');
  };

  it('a deadline expiry membrane marks itself gets one fresh call, 1 s later', async () => {
    const marked = await markedByMembrane();
    assert.ok(marked instanceof MembraneError && marked.type === 'timeout' && marked.retryable === true, String(marked));
    assert.deepEqual(delays(new DefaultErrorPolicy(), marked), [1_000]);
  });

  it('a host\'s own deadline schedule is used for one', async () => {
    const marked = await markedByMembrane();
    const settings = { ...MEMBRANE_RETRY_SETTINGS, deadline: { maxAttempts: 3, firstDelayMs: 500, multiplier: 2, maxDelayMs: 5_000, statedWaitCeilingMs: null } } as RetrySettings;
    assert.deepEqual(delays(new DefaultErrorPolicy(settings), marked), [500, 1_000]);
  });

  it('settings with no deadline schedule give one their base schedule', async () => {
    const marked = await markedByMembrane();
    const { deadline: _none, ...settings } = MEMBRANE_RETRY_SETTINGS as RetrySettings;
    assert.deepEqual(delays(new DefaultErrorPolicy(settings as RetrySettings), marked), [1_000, 2_000]);
    assert.deepEqual(delays(new DefaultErrorPolicy(settings as RetrySettings), new MembraneError({ type: 'server', retryable: true, message: 'x', rawError: undefined })), [1_000, 2_000]);
  });

  it('an agent ended through the registry takes its count of deadline cuts with it', async () => {
    const stand = await provider([]);
    const agent = { model: 'claude-opus-5-5', systemPrompt: 'You are a resident.', maxTokens: 4096 };
    const fw = await AgentFramework.create({
      storePath: join(mkdtempSync(join(tmpdir(), 'af-bounds-')), 'store.chronicle'),
      membrane: new Membrane(adapterFor(stand)),
      agents: [{ name: 'resident', ...agent } as never, { name: 'second', ...agent } as never],
      modules: [new Asker()],
      syncIntervalMs: 0,
      maintenanceIntervalMs: 0,
      inferenceBounds: SHORT,
    });
    try {
      const counts = (fw as unknown as { deadlineCuts: Map<string, number> }).deadlineCuts;
      // Set as a cut that gets its fresh call sets it, so the release's clear is pinned.
      counts.set('second', 1);
      fw.stopAgent('second', { by: 'test' });
      assert.equal(counts.has('second'), false);
    } finally {
      await fw.stop();
      await stand.close();
    }
  });
});
