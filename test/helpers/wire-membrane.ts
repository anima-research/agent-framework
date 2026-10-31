/**
 * A membrane that records what went on the wire, per agent, for tests that
 * check a request against the agent's window (#291's window = wire): every
 * stream's first request, and what each later round of it carried after
 * that (the round itself, its results and the rows injected with them, then
 * the final reply). Each agent's activations are scripted apart, so turns
 * of several agents can interleave.
 *
 * Also the signed-round builders the thinking-binding tests share
 * (sent-rows.test.ts): a round with a call, a final reply, and the
 * cumulative response membrane gives at a stream's end.
 */
import type { ContentBlock, Membrane, NormalizedRequest, NormalizedResponse, StreamEvent, YieldingStream } from '@animalabs/membrane';
import { createMockResponse, MockYieldingStream } from './mock-membrane.js';

const text = (t: string) => ({ type: 'text', text: t }) as ContentBlock;
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'test--echo', input: {} }) as ContentBlock;
const usage = { inputTokens: 100, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 };

/** A signed thinking block, as a model that binds its thinking returns one. */
export const signed = (signature: string, tokenEstimate?: number) =>
  ({ type: 'thinking', thinking: '', signature, ...(tokenEstimate !== undefined ? { tokenEstimate } : {}) }) as ContentBlock;

/** A round: `content`, then a call of `tool` (`test--<tool>`, or a name that has its module's prefix) with `input`. */
export const round = (id: string, content: ContentBlock[], tool = 'echo', input: object = {}): NormalizedResponse =>
  Object.assign(createMockResponse([
    ...content, { type: 'tool_use', name: tool.includes('--') ? tool : `test--${tool}`, id, input } as ContentBlock,
  ], 'tool_use'), { usage });

/** A final reply, with its usage reported in its details as membrane gives it. */
export const final = (content: ContentBlock[] = [signed('sig-3'), text('Done.')]): NormalizedResponse => {
  const response = Object.assign(createMockResponse(content), { usage });
  response.details!.usage = usage;
  return response;
};

/** The stream's complete, as membrane gives it: every round's blocks, each round's results after its calls, then the
 *  last reply's (`last`, none for a stream that ends on its last results). */
export const cumulative = (first: ContentBlock[], last: ContentBlock[] = [signed('sig-3'), text('Done.')]): NormalizedResponse => {
  const toolResult = (id: string) => ({ type: 'tool_result', toolUseId: id, content: '{"echoed":true}' }) as ContentBlock;
  const response = final([...first, toolUse('c1'), toolResult('c1'), signed('sig-2'), text('Again.'), toolUse('c2'), toolResult('c2'), ...last]);
  response.toolCalls = [];
  return response;
};

/** One stream the membrane opened: whose, its first request, and the stream. */
export interface WireStream {
  agent: string;
  request: NormalizedRequest;
  stream: MockYieldingStream;
  /** The responses it was scripted with, in order. */
  activation: NormalizedResponse[];
}

/**
 * Each agent's activations, in order (`script`); an agent with none left
 * answers `final()`. Streams declare that they carry injected messages, as
 * membrane's native path does.
 */
export class WireMembrane {
  readonly calls: NormalizedRequest[] = [];
  readonly streams: WireStream[] = [];
  /** Whose request it is: by default the participant it assigns the assistant role. */
  identify: (request: NormalizedRequest) => string = (request) => request.assistantParticipant ?? 'unknown';
  /** Told of each request as it is made, before its stream is built. */
  onRequest?: (agent: string, request: NormalizedRequest) => void;
  private readonly scripts = new Map<string, NormalizedResponse[][]>();
  private readonly holds = new Map<string, Promise<void>>();

  /** Queue one activation (one stream's responses) for `agent`. */
  script(agent: string, ...activation: NormalizedResponse[]): void {
    const queue = this.scripts.get(agent) ?? [];
    queue.push(activation);
    this.scripts.set(agent, queue);
  }

  /**
   * Hold `agent`'s next stream: its request is made and recorded, so its
   * turn is alive, but the stream yields nothing until `released` settles.
   */
  hold(agent: string, released: Promise<void>): void {
    this.holds.set(agent, released);
  }

  /** The requests `agent` made, in order. */
  callsFor(agent: string): NormalizedRequest[] {
    return this.streams.filter((s) => s.agent === agent).map((s) => s.request);
  }

  streamYielding(request: NormalizedRequest, _options?: unknown): YieldingStream {
    this.calls.push(request);
    const agent = this.identify(request);
    this.onRequest?.(agent, request);
    const activation = this.scripts.get(agent)?.shift() ?? [final()];
    const stream = new MockYieldingStream(activation, true);
    const released = this.holds.get(agent);
    if (released) {
      this.holds.delete(agent);
      const events = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* (): AsyncGenerator<StreamEvent> {
        await released;
        const inner = events();
        for (let next = await inner.next(); !next.done; next = await inner.next()) yield next.value;
      };
    }
    this.streams.push({ agent, request, stream, activation });
    return stream;
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    return final([text('(complete)')]);
  }

  async stream(request: NormalizedRequest, _options?: unknown): Promise<NormalizedResponse> {
    return this.complete(request);
  }

  asMembrane(): Membrane {
    return this as unknown as Membrane;
  }
}

/**
 * What one stream put on the wire, in order: its first request's messages,
 * then for each round it gave results to, the round's own blocks, the
 * results it was given and the rows injected with them, and then the final
 * reply when it ended on one.
 */
export function wireOf(s: Pick<WireStream, 'request' | 'stream' | 'activation'>): Array<{ participant?: string; content: unknown[] }> {
  const wire: Array<{ participant?: string; content: unknown[] }> = s.request.messages.map((m) => ({
    participant: m.participant, content: m.content as unknown[],
  }));
  const rounds = s.stream.receivedToolResults.length;
  for (let k = 0; k < rounds; k++) {
    const response = s.activation[k];
    if (response) wire.push({ participant: s.request.assistantParticipant, content: response.content as unknown[] });
    wire.push({ content: s.stream.receivedToolResults[k]! });
    for (const injected of s.stream.receivedToolResultOptions[k]?.injectedMessages ?? []) wire.push(injected);
  }
  const last = s.activation[rounds];
  if (last && last.toolCalls.length === 0) wire.push({ participant: s.request.assistantParticipant, content: last.content as unknown[] });
  return wire;
}
