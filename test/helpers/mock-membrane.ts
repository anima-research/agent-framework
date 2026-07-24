/**
 * Shared test helpers: mock Membrane + yielding stream.
 *
 * Mirrors the local mocks in framework.test.ts (kept duplicated there to
 * avoid churn); new test files should import from here.
 */

import type {
  NormalizedRequest,
  NormalizedResponse,
  ContentBlock,
  YieldingStream,
  StreamEvent,
} from '@animalabs/membrane';

export function createMockResponse(
  content: ContentBlock[],
  stopReason: NormalizedResponse['stopReason'] = 'end_turn',
): NormalizedResponse {
  const rawText = content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const toolCalls = content
    .filter((b): b is ContentBlock & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));

  return {
    content,
    stopReason,
    rawAssistantText: rawText,
    toolCalls,
    toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: {
      raw: {},
    },
  } as unknown as NormalizedResponse;
}

/**
 * Mock yielding stream: first response starts the stream, subsequent
 * responses resume after each tool round.
 */
export class MockYieldingStream implements YieldingStream {
  private events: StreamEvent[] = [];
  private _done = false;
  private _isWaitingForTools = false;
  private _pendingToolCallIds: string[] = [];
  private _toolDepth = 0;
  private pendingResolve: (() => void) | null = null;
  receivedToolResults: unknown[][] = [];
  /** Options passed alongside each provideToolResults call (mid-turn injection). */
  receivedToolResultOptions: Array<
    { injectedMessages?: Array<{ participant?: string; content: unknown[] }> } | undefined
  > = [];

  constructor(
    private responses: NormalizedResponse[],
    /** Mirrors membrane's emitBlocks stream option: block boundary events
     *  are emitted only when the caller asked for them. Respecting the flag
     *  here means every block-dependent test (bridge, e2e) doubles as a
     *  regression pin on the agent actually requesting blocks. */
    private readonly emitBlocks: boolean = true,
  ) {
    this.processResponse(0);
  }

  private processResponse(index: number): void {
    const response = this.responses[index];
    if (!response) {
      this._done = true;
      return;
    }

    const text = response.rawAssistantText;
    if (text) {
      if (this.emitBlocks) {
        this.events.push({
          type: 'block',
          event: { event: 'block_start', index: 0, block: { type: 'text' } },
        } as StreamEvent);
      }
      this.events.push({
        type: 'tokens',
        content: text,
        meta: { type: 'text', visible: true, blockIndex: 0 },
      } as StreamEvent);
      if (this.emitBlocks) {
        this.events.push({
          type: 'block',
          event: { event: 'block_complete', index: 0, block: { type: 'text', content: text } },
        } as StreamEvent);
      }
    }

    if (response.usage) {
      this.events.push({ type: 'usage', usage: response.usage } as StreamEvent);
    }

    if (response.toolCalls.length > 0) {
      this._isWaitingForTools = true;
      this._pendingToolCallIds = response.toolCalls.map((c) => c.id);
      this.events.push({
        type: 'tool-calls',
        calls: response.toolCalls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input as Record<string, unknown>,
        })),
        context: {
          rawText: '',
          preamble: '',
          depth: this._toolDepth,
          previousResults: [],
          accumulated: '',
          // membrane ≥0.5.64: verbatim blocks of the current round, in
          // provider order — lets the framework store the assistant turn
          // verbatim and (≥0.5.72) route the round's prose live.
          roundContent: response.content,
        },
      } as StreamEvent);
    } else {
      this.events.push({ type: 'complete', response } as StreamEvent);
      this._done = true;
    }
  }

  provideToolResults(
    results: unknown[],
    options?: { injectedMessages?: Array<{ participant?: string; content: unknown[] }> },
  ): void {
    if (!this._isWaitingForTools) throw new Error('Not waiting for tools');
    this.receivedToolResults.push(results);
    this.receivedToolResultOptions.push(options);
    this._isWaitingForTools = false;
    this._pendingToolCallIds = [];
    this._toolDepth++;
    this.processResponse(this._toolDepth);
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
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve();
    }
  }

  get isWaitingForTools() { return this._isWaitingForTools; }
  get pendingToolCallIds() { return [...this._pendingToolCallIds]; }
  get toolDepth() { return this._toolDepth; }

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

export class MockMembrane {
  responses: NormalizedResponse[] = [];
  calls: NormalizedRequest[] = [];
  lastStream: MockYieldingStream | null = null;
  private responseIndex = 0;

  pushResponse(response: NormalizedResponse): void {
    this.responses.push(response);
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    if (this.responseIndex >= this.responses.length) {
      return createMockResponse([{ type: 'text', text: 'Default response' }]);
    }
    return this.responses[this.responseIndex++];
  }

  streamYielding(request: NormalizedRequest, options?: unknown): YieldingStream {
    this.calls.push(request);
    const remaining = this.responses.slice(this.responseIndex);
    this.responseIndex = this.responses.length;
    // Honor emitBlocks like the real membrane (default true) — see the
    // MockYieldingStream constructor note.
    const emitBlocks = (options as { emitBlocks?: boolean } | undefined)?.emitBlocks ?? true;
    const stream = new MockYieldingStream(remaining, emitBlocks);
    this.lastStream = stream;
    return stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}
