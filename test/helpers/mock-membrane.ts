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
    .filter((b): b is ContentBlock & { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; unparseableInput?: string } => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input, ...(b.unparseableInput !== undefined ? { unparseableInput: b.unparseableInput } : {}) }));

  return {
    content,
    stopReason,
    rawAssistantText: rawText,
    toolCalls,
    toolResults: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    details: {
      raw: {},
      // membrane's type requires stop details and model information on
      // every response, and the MCPL inference router reads both.
      stop: { reason: stopReason, wasTruncated: false },
      model: { requested: 'mock-model', actual: 'mock-model', provider: 'mock' },
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

  /**
   * @param supportsInjectedMessages what each tool-calls event declares, as
   *   membrane does: true on its native path, the default here, and false on
   *   its XML prefill path; 'undeclared' leaves the field out.
   */
  constructor(private responses: NormalizedResponse[], private supportsInjectedMessages: boolean | 'undeclared' = true) {
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
      this.events.push({
        type: 'block',
        event: { event: 'block_start', index: 0, block: { type: 'text' } },
      } as StreamEvent);
      this.events.push({
        type: 'tokens',
        content: text,
        meta: { type: 'text', visible: true, blockIndex: 0 },
      } as StreamEvent);
      this.events.push({
        type: 'block',
        event: { event: 'block_complete', index: 0, block: { type: 'text', content: text } },
      } as StreamEvent);
    }

    if (response.usage) {
      // A response may carry the round report its usage event closes
      // (`round`, a test-only field), as membrane 0.6.0's yielding streams
      // send it.
      const round = (response as { round?: unknown }).round;
      this.events.push({ type: 'usage', usage: response.usage, ...(round ? { round } : {}) } as StreamEvent);
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
          ...(tc.unparseableInput !== undefined ? { unparseableInput: tc.unparseableInput } : {}),
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
          ...(this.supportsInjectedMessages === 'undeclared' ? {} : { supportsInjectedMessages: this.supportsInjectedMessages }),
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

/**
 * A stream that yields nothing until `released` settles, cancel included: a
 * stream whose teardown stop() has to wait for.
 */
export class HeldStream extends MockYieldingStream {
  constructor(private readonly released: Promise<void>, responses: NormalizedResponse[]) {
    super(responses);
  }

  override async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    await this.released;
    const inner = super[Symbol.asyncIterator]();
    for (let next = await inner.next(); !next.done; next = await inner.next()) yield next.value;
  }
}

export class MockMembrane {
  responses: NormalizedResponse[] = [];
  calls: NormalizedRequest[] = [];
  lastStream: MockYieldingStream | null = null;
  /** What the streams' tool-calls events declare (see MockYieldingStream). */
  supportsInjectedMessages: boolean | 'undeclared' = true;
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

  /** The direct Agent API's call, recorded and answered as complete is. */
  async stream(request: NormalizedRequest, _options?: unknown): Promise<NormalizedResponse> {
    return this.complete(request);
  }

  streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const remaining = this.responses.slice(this.responseIndex);
    this.responseIndex = this.responses.length;
    const stream = new MockYieldingStream(remaining, this.supportsInjectedMessages);
    this.lastStream = stream;
    return stream;
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}
