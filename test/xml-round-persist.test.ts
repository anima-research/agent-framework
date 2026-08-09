/**
 * XML-mode per-round persist: the framework must store each round's text
 * exactly once.
 *
 * Regression for the Evander 2026-08-08 scaffold-leak pyramid: membrane's
 * `ToolContext.preamble` is CUMULATIVE in XML mode (whole turn so far,
 * including harness-injected <function_results> XML). The per-round persist
 * fallback stored it per round, so a 3-call turn wrote round-1's text 3×,
 * round-2's 2×, and re-persisted injected results as the agent's own words —
 * which the anthropic-xml formatter then replayed to the model as
 * scaffold-in-its-own-voice.
 *
 * With membrane ≥0.5.79 the context carries `roundPreamble` (this round's
 * delta only) and the framework must prefer it. With an older membrane
 * (no `roundPreamble`) the cumulative fallback remains — pinned here so the
 * compat shape stays visible and deliberate.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  NormalizedRequest,
  NormalizedResponse,
  YieldingStream,
  StreamEvent,
} from '@animalabs/membrane';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessEvent,
  EventResponse,
  ToolDefinition,
  ToolCall,
  ToolResult,
} from '../src/index.js';
import { AgentFramework } from '../src/index.js';

const R1 = 'ROUND_ONE_TEXT_alpha';
const R2 = 'ROUND_TWO_TEXT_beta';
const FINAL = 'FINAL_TEXT_gamma';
const INJECTED = 'INJECTED_RESULTS_XML_delta';

const RAW1 = '<function_calls><invoke name="test--echo"><parameter name="message">round1</parameter></invoke></function_calls>';
const RAW2 = '<function_calls><invoke name="test--echo"><parameter name="message">round2</parameter></invoke></function_calls>';

interface XmlRound {
  /** Model text of this round (before its call). */
  text: string;
  rawText: string;
  callId: string;
  callInput: Record<string, unknown>;
}

/**
 * Mock yielding stream simulating membrane's XML tool mode: tool-calls
 * events carry NO roundContent; `preamble` is cumulative (with injected
 * results XML between rounds), `roundPreamble` optionally carries the
 * per-round delta.
 */
class XmlMockStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private _done = false;
  private _isWaitingForTools = false;
  private _round = 0;
  private pendingResolve: (() => void) | null = null;

  constructor(
    private rounds: XmlRound[],
    private finalText: string,
    private withRoundPreamble: boolean,
  ) {
    this.emitRound();
  }

  private cumulativePreamble(uptoRound: number): string {
    // preamble before round N's call = r0 text + raw0 + injected results +
    // r1 text + ... + rN text (matches membrane: beforeText minus prefill).
    let out = '';
    for (let i = 0; i < uptoRound; i++) {
      out += this.rounds[i]!.text + '\n' + this.rounds[i]!.rawText +
        `\n<function_results>${INJECTED}</function_results>\n`;
    }
    out += this.rounds[uptoRound]!.text + '\n';
    return out;
  }

  private emitRound(): void {
    const round = this.rounds[this._round];
    if (!round) {
      const response = {
        content: [{ type: 'text', text: this.finalText }],
        stopReason: 'end_turn',
        rawAssistantText: this.finalText,
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 10, outputTokens: 5 },
        details: { raw: {} },
      } as unknown as NormalizedResponse;
      this.events.push({ type: 'complete', response } as StreamEvent);
      this._done = true;
      return;
    }

    this._isWaitingForTools = true;
    this.events.push({
      type: 'tool-calls',
      calls: [{ id: round.callId, name: 'test--echo', input: round.callInput }],
      context: {
        rawText: round.rawText,
        preamble: this.cumulativePreamble(this._round),
        depth: this._round,
        previousResults: [],
        accumulated: this.cumulativePreamble(this._round) + round.rawText,
        ...(this.withRoundPreamble ? { roundPreamble: round.text + '\n' } : {}),
      },
    } as StreamEvent);
  }

  provideToolResults(_results: unknown[]): void {
    if (!this._isWaitingForTools) throw new Error('Not waiting for tools');
    this._isWaitingForTools = false;
    this._round++;
    this.emitRound();
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }
  }

  cancel(): void {
    this._done = true;
    this.events.push({ type: 'aborted', reason: 'user' } as StreamEvent);
    if (this.pendingResolve) {
      const r = this.pendingResolve;
      this.pendingResolve = null;
      r();
    }
  }

  get isWaitingForTools() { return this._isWaitingForTools; }
  get pendingToolCallIds(): string[] {
    const round = this.rounds[this._round];
    return this._isWaitingForTools && round ? [round.callId] : [];
  }
  get toolDepth() { return this._round; }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    while (true) {
      while (this.events.length > 0) {
        const event = this.events.shift()!;
        yield event;
        if (event.type === 'complete' || event.type === 'error' || event.type === 'aborted') {
          return;
        }
      }
      if (this._done) return;
      await new Promise<void>((resolve) => { this.pendingResolve = resolve; });
    }
  }
}

class XmlMockMembrane {
  constructor(private withRoundPreamble: boolean) {}
  calls: NormalizedRequest[] = [];

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    throw new Error('not used');
  }

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    return new XmlMockStream(
      [
        { text: R1, rawText: RAW1, callId: 'call_1', callInput: { message: 'round1' } },
        { text: R2, rawText: RAW2, callId: 'call_2', callInput: { message: 'round2' } },
      ],
      FINAL,
      this.withRoundPreamble,
    );
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

class EchoModule implements Module {
  readonly name = 'test';
  async start(_ctx: ModuleContext): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{
      name: 'echo',
      description: 'Echoes the input',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string', description: 'Message to echo' } },
        required: ['message'],
      },
    }];
  }
  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const input = call.input as { message: string };
    return { success: true, data: { echoed: input.message } };
  }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type === 'external-message') {
      return {
        addMessages: [{ participant: 'User', content: [{ type: 'text' as const, text: String(event.content) }] }],
        requestInference: true,
      };
    }
    return {};
  }
}

async function runTurn(withRoundPreamble: boolean): Promise<string> {
  const tempDir = mkdtempSync(join(tmpdir(), 'xml-round-persist-'));
  const membrane = new XmlMockMembrane(withRoundPreamble);
  const framework = await AgentFramework.create({
    storePath: join(tempDir, 'test.chronicle'),
    membrane: membrane.asMembrane(),
    agents: [{ name: 'assistant', model: 'test-model', systemPrompt: 'Test' }],
    modules: [new EchoModule()],
  });
  try {
    framework.pushEvent({
      type: 'external-message',
      source: 'test',
      content: 'Do two echoes',
      metadata: {},
    });
    await framework.runUntilIdle();

    const cm = framework.getAgent('assistant')!.getContextManager();
    const msgs = (cm.queryMessages({}).messages ?? []) as Array<{
      content: Array<{ type: string; text?: string }>;
    }>;
    return msgs
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n---\n');
  } finally {
    await framework.stop();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('XML-mode per-round persist (scaffold-leak pyramid regression)', () => {
  it('stores each round exactly once when membrane provides roundPreamble', async () => {
    const storedText = await runTurn(true);
    assert.strictEqual(count(storedText, R1), 1, `round-1 text stored once, got: ${count(storedText, R1)}`);
    assert.strictEqual(count(storedText, R2), 1, 'round-2 text stored once');
    assert.strictEqual(count(storedText, FINAL), 1, 'final text stored once');
    assert.strictEqual(
      count(storedText, INJECTED), 0,
      'injected <function_results> XML must never persist as agent text',
    );
  });

  it('legacy membrane without roundPreamble keeps the cumulative fallback (pinned)', async () => {
    const storedText = await runTurn(false);
    // The old shape, deliberately pinned: round-1 in rounds 1+2 = 2 copies,
    // injected results re-persisted once. When the fleet's membrane floor
    // reaches 0.5.79 this contract can be dropped along with the fallback.
    assert.strictEqual(count(storedText, R1), 2, 'cumulative fallback: round-1 text twice');
    assert.strictEqual(count(storedText, R2), 1, 'round-2 text once');
    assert.strictEqual(count(storedText, INJECTED), 1, 'injected XML persisted once by fallback');
  });
});
