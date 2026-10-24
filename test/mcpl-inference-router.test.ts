/**
 * MCPL inference/request: the router answers each way an inference can end.
 *
 * A server gets a result only for a completed inference whose stop MCPL can
 * name (SPEC §11.3 closes FinishReason at end_turn, max_tokens and
 * stop_sequence). Every other ending is answered with the JSON-RPC error the
 * non-streaming path has always sent (-32603, the cause in its message). A
 * streamed request's result is built from membrane's response as a
 * non-streamed one's is, after chunks of the text membrane marks visible
 * (§11.4). A result names the model that served it, which §11.3 defines as
 * the actual model used, and the completion trace names it beside the routed
 * one.
 *
 * The router runs on a real Membrane here, with a scripted provider adapter,
 * so each case meets membrane's own streams: its `error` and `aborted`
 * events, its `tool-calls` handshake, and the stop reasons and usage its
 * response carries. The cases any provider can play run in both tool modes a
 * host configures (connectome-host's recipe formatter: AnthropicXmlFormatter
 * pinned to XML, or NativeFormatter), since membrane streams each through its
 * own path. The tool-call markup and thinking cases run in XML mode and the
 * cut-off tool_use block in native mode, where each arises; the stop reasons
 * a provider can't play, and a stream with no terminal event, use stand-ins.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AnthropicAdapter, AnthropicXmlFormatter, Membrane, NativeFormatter, TimeoutAbortError } from '@animalabs/membrane';
import type {
  NormalizedRequest,
  NormalizedResponse,
  ProviderAdapter,
  ProviderResponse,
  StreamCallbacks,
  YieldingStream,
} from '@animalabs/membrane';
import { InferenceRouter } from '../src/mcpl/inference-router.js';
import type { FeatureSetManager } from '../src/mcpl/feature-set-manager.js';
import type { HookOrchestrator } from '../src/mcpl/hook-orchestrator.js';
import type { InferenceChunkParams, InferenceRoutingPolicy, McplInferenceRequestResult } from '../src/mcpl/types.js';

/** What the scripted provider streams, and how its call ends. */
type Script =
  | {
    chunks: string[];
    stopReason: string;
    stopSequence?: string;
    /** The provider's own stop token, as an adapter reports it. */
    providerStopReason?: string;
    /** A native tool_use block after the text. */
    toolUse?: string;
    /** The model the provider says served the call: `scripted-model` unless given. */
    servedModel?: string;
  }
  | { chunks: string[]; fails: Error };

type Mode = 'native' | 'xml';

const USAGE = { inputTokens: 11, outputTokens: 7 };

/** A provider that plays one script, streamed or whole. */
class ScriptedAdapter implements ProviderAdapter {
  readonly name = 'scripted';
  readonly usageCacheConvention = 'cache-excluded' as const;

  constructor(private readonly script: Script) {}

  supportsModel(): boolean {
    return true;
  }

  async complete(): Promise<ProviderResponse> {
    if ('fails' in this.script) throw this.script.fails;
    return this.response(this.script.chunks.join(''));
  }

  async stream(_request: unknown, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    for (const chunk of this.script.chunks) callbacks.onChunk(chunk);
    if ('fails' in this.script) throw this.script.fails;
    return this.response(this.script.chunks.join(''));
  }

  private response(text: string): ProviderResponse {
    const script = this.script as Extract<Script, { stopReason: string }>;
    return {
      content: [
        { type: 'text', text },
        ...(script.toolUse ? [{ type: 'tool_use', id: 'toolu_1', name: script.toolUse, input: { q: 'memories' } }] : []),
      ],
      stopReason: script.stopReason,
      ...(script.stopSequence ? { stopSequence: script.stopSequence } : {}),
      ...(script.providerStopReason ? { providerStopReason: script.providerStopReason } : {}),
      usage: { ...USAGE },
      model: script.servedModel ?? 'scripted-model',
      rawRequest: null,
      raw: null,
    };
  }
}

interface Answer {
  result?: McplInferenceRequestResult;
  error?: { code: number; message: string };
  chunks: InferenceChunkParams[];
  /**
   * What reached the server, in the order it was sent: `chunk:` and the text
   * of consecutive chunks joined, then `result:` and its content or `error:`
   * and its message.
   */
  sent: string[];
  traces: Array<{ type: string; [key: string]: unknown }>;
  /** The stream the router opened, when it streamed. */
  stream?: YieldingStream;
}

/** Ask the router for one inference, played by `script` on a real Membrane. */
async function ask(
  script: Script,
  opts: { stream: boolean; mode: Mode; policy?: InferenceRoutingPolicy; noChunkSender?: boolean },
): Promise<Answer> {
  const membrane = new Membrane(new ScriptedAdapter(script), {
    formatter: opts.mode === 'xml' ? new AnthropicXmlFormatter({ toolMode: 'xml' }) : new NativeFormatter(),
  });
  const answer: Answer = { chunks: [], sent: [], traces: [] };
  const streamYielding = membrane.streamYielding.bind(membrane);
  membrane.streamYielding = (request: NormalizedRequest) => {
    answer.stream = streamYielding(request);
    return answer.stream;
  };
  return askWith(membrane, opts.stream, answer, opts.policy, opts.noChunkSender);
}

/** Ask a router built on `membrane`, routing by `policy` (none given: a policy
 *  whose default is `default`), for one inference. */
async function askWith(
  membrane: Membrane,
  stream: boolean,
  answer: Answer = { chunks: [], sent: [], traces: [] },
  policy?: InferenceRoutingPolicy,
  noChunkSender = false,
): Promise<Answer> {
  const router = new InferenceRouter(
    membrane,
    { isInHook: false } as unknown as HookOrchestrator,
    { validateInbound: () => {} } as unknown as FeatureSetManager,
    policy ?? { default: 'default' },
    (event) => { answer.traces.push(event); },
  );

  await router.handleInferenceRequest('scripted-server', {
    featureSet: 'memory.consolidation',
    stream,
    messages: [{ role: 'user', content: 'Summarize these memories.' }],
  }, {
    requestId: 7,
    respond: (result) => {
      answer.result = result;
      answer.sent.push(`result:${result.content}`);
    },
    respondError: (code, message) => {
      answer.error = { code, message };
      answer.sent.push(`error:${message}`);
    },
    ...(noChunkSender ? {} : {
      sendChunk: (params: InferenceChunkParams) => {
        answer.chunks.push(params);
        const last = answer.sent.length - 1;
        if (answer.sent[last]?.startsWith('chunk:')) answer.sent[last] += params.delta;
        else answer.sent.push(`chunk:${params.delta}`);
      },
    }),
  });

  // Every answer is traced: an error by mcpl:inference_fail with its message,
  // a result by mcpl:inference_complete.
  const last = answer.traces.at(-1);
  if (answer.error) {
    assert.deepStrictEqual([last?.type, last?.error], ['mcpl:inference_fail', answer.error.message]);
  } else {
    assert.strictEqual(last?.type, 'mcpl:inference_complete');
  }
  return answer;
}

const unnamedStop = (stopReason: string) =>
  `The inference ended with stop reason '${stopReason}', for which inference/request has no finishReason`;
const REFUSED = unnamedStop('refusal');
const CALLED_A_TOOL = 'The model called a tool (search), and inference/request offers none';
const OPEN_TOOL_BLOCK = "The model's output ended with a tool-call block still open, and inference/request offers no tools";
const TOOL_MARKUP = 'The model wrote tool-call markup, and inference/request offers no tools';
const PROVIDER_ERROR = "The provider ended the inference with an error (finish_reason 'error')";

/**
 * A provider that fails partway through and says so only with finish_reason
 * 'error' in its last chunk, with no error object: membrane's
 * OpenAI-compatible adapters report the token as both their stop reason and
 * the provider's own.
 */
const PROVIDER_FAILED_PARTWAY: Script = { chunks: ['A summ'], stopReason: 'error', providerStopReason: 'error' };

/**
 * The success trace for a completion played with USAGE: the routed model,
 * `default` from askWith's own policy, and the one the provider served.
 */
const completeTrace = (streamed: boolean) => ({
  type: 'mcpl:inference_complete', serverId: 'scripted-server', model: 'default', actualModel: 'scripted-model', ...USAGE, streamed,
});

/** A tool call as a model writes it in XML mode, which stops at the closing tag. */
const TOOL_CALL: Script = {
  chunks: [
    'Let me look that up.\n',
    '<function_calls>\n<invoke name="search">\n<parameter name="q">memories</parameter>\n</invoke>\n',
  ],
  stopReason: 'stop_sequence',
  stopSequence: '</function_calls>',
};

/** A tool call the model was still writing when max_tokens cut it off. */
const CUT_OFF_TOOL_CALL: Script = {
  chunks: ['Let me look that up.\n', '<function_calls>\n<invoke name="search">\n<parameter name="q">mem'],
  stopReason: 'max_tokens',
};

/** Tool-call blocks membrane reads no call from, each stopped at the closing tag. */
const UNREADABLE_TOOL_BLOCKS: Record<string, Script> = {
  'an empty block': {
    chunks: ['Let me look that up.\n', '<function_calls>\n'],
    stopReason: 'stop_sequence',
    stopSequence: '</function_calls>',
  },
  'an invoke with no name': {
    chunks: ['Let me look that up.\n', '<function_calls>\n<invoke>\n<parameter name="q">memories</parameter>\n</invoke>\n'],
    stopReason: 'stop_sequence',
    stopSequence: '</function_calls>',
  },
};

/** A completion that names the opening tag in prose, and ends its turn. */
const TAG_IN_PROSE: Script = {
  chunks: ['In XML tool mode the model wraps its calls in ', '<function_calls> tags.'],
  stopReason: 'end_turn',
};

for (const mode of ['native', 'xml'] as const) {
  describe(`MCPL inference router, ${mode} mode: a streamed request`, () => {
    it('answers a streamed request whole when its responder carries no chunk sender', async () => {
      const answer = await ask({ chunks: ['Hello ', 'world'], stopReason: 'end_turn' }, { stream: true, mode, noChunkSender: true });
      assert.strictEqual(answer.error, undefined);
      assert.deepStrictEqual(answer.sent, ['result:Hello world']);
      assert.deepStrictEqual(answer.chunks, []);
    });

    it('answers a completed stream with its text, after chunks that join up to it (control)', async () => {
      const answer = await ask({ chunks: ['Hello ', 'world'], stopReason: 'end_turn' }, { stream: true, mode });

      assert.strictEqual(answer.error, undefined);
      assert.strictEqual(answer.result?.content, 'Hello world');
      assert.strictEqual(answer.result?.finishReason, 'end_turn');
      assert.deepStrictEqual(answer.sent, ['chunk:Hello world', 'result:Hello world']);
      assert.ok(answer.chunks.every((chunk, i) => chunk.requestId === 7 && chunk.index === i));
    });

    it("answers with the response's finish reason and usage, not end_turn and zeros", async () => {
      const answer = await ask({ chunks: ['A summary that ran'], stopReason: 'max_tokens' }, { stream: true, mode });

      assert.strictEqual(answer.error, undefined);
      assert.strictEqual(answer.result?.finishReason, 'max_tokens');
      assert.deepStrictEqual(answer.result?.usage, USAGE);
      assert.deepStrictEqual(answer.traces.at(-1), completeTrace(true));
    });

    it('answers with the model that served the inference, not the routed one', async () => {
      const answer = await ask({ chunks: ['Hello world'], stopReason: 'end_turn' }, { stream: true, mode });

      assert.strictEqual(answer.result?.model, 'scripted-model');
      assert.strictEqual(answer.traces[0]?.model, 'default');
    });

    it('answers a stop at a stop sequence with stop_sequence', async () => {
      const answer = await ask(
        { chunks: ['They met twice.'], stopReason: 'stop_sequence', stopSequence: '\nuser:' },
        { stream: true, mode },
      );

      assert.strictEqual(answer.error, undefined);
      assert.strictEqual(answer.result?.content, 'They met twice.');
      assert.strictEqual(answer.result?.finishReason, 'stop_sequence');
    });

    it('answers a stream that failed partway with the error, not the partial text', async () => {
      const answer = await ask({ chunks: ['A summ'], fails: new Error('upstream connection reset') }, { stream: true, mode });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: 'upstream connection reset' });
      assert.deepStrictEqual(answer.sent, ['chunk:A summ', 'error:upstream connection reset']);
      assert.deepStrictEqual(answer.traces.map((trace) => trace.type), ['mcpl:inference_start', 'mcpl:inference_fail']);
      assert.deepStrictEqual(answer.traces.at(-1), {
        type: 'mcpl:inference_fail', serverId: 'scripted-server', model: 'default', error: 'upstream connection reset', streamed: true,
      });
    });

    it('answers a stream that stopped before it finished with the error', async () => {
      const answer = await ask(
        { chunks: ['A summ'], fails: new TimeoutAbortError('no event for 120000ms') },
        { stream: true, mode },
      );

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: 'The inference stopped before it finished (timeout)' });
      assert.deepStrictEqual(answer.sent, ['chunk:A summ', 'error:The inference stopped before it finished (timeout)']);
    });

    it('answers a refusal with the error, not end_turn', async () => {
      const answer = await ask({ chunks: ['I can'], stopReason: 'refusal' }, { stream: true, mode });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: REFUSED });
    });

    it("answers a provider's finish_reason 'error' with the error, not end_turn and the partial text", async () => {
      const answer = await ask(PROVIDER_FAILED_PARTWAY, { stream: true, mode });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: PROVIDER_ERROR });
      assert.deepStrictEqual(answer.sent, ['chunk:A summ', `error:${PROVIDER_ERROR}`]);
    });
  });

  describe(`MCPL inference router, ${mode} mode: a request answered whole`, () => {
    it('answers a completion with its text, the model that served it, its finish reason and usage', async () => {
      const answer = await ask({ chunks: ['Hello world'], stopReason: 'end_turn' }, { stream: false, mode });

      assert.deepStrictEqual(answer.result, {
        content: 'Hello world',
        model: 'scripted-model',
        finishReason: 'end_turn',
        usage: USAGE,
      });
      assert.deepStrictEqual(answer.chunks, []);
    });

    it('answers with the routed model when membrane names none, and traces no actualModel (control)', async () => {
      // A policy of the test's own, so the routed model is visibly the one it
      // chose rather than askWith's `default`.
      const answer = await ask(
        { chunks: ['Hello world'], stopReason: 'end_turn', servedModel: '' },
        { stream: false, mode, policy: { default: 'house-summarizer' } },
      );

      assert.strictEqual(answer.result?.model, 'house-summarizer');
      assert.deepStrictEqual(answer.traces.at(-1), {
        type: 'mcpl:inference_complete', serverId: 'scripted-server', model: 'house-summarizer', ...USAGE, streamed: false,
      });
    });

    it('traces a completion as not streamed', async () => {
      const answer = await ask({ chunks: ['Hello world'], stopReason: 'end_turn' }, { stream: false, mode });

      assert.deepStrictEqual(answer.traces.at(-1), completeTrace(false));
    });

    it('answers a provider error with the error, its cause in the message (control)', async () => {
      const answer = await ask({ chunks: [], fails: new Error('upstream connection reset') }, { stream: false, mode });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: 'upstream connection reset' });
    });

    it('answers a refusal with the error, not end_turn', async () => {
      const answer = await ask({ chunks: ['I can'], stopReason: 'refusal' }, { stream: false, mode });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: REFUSED });
      assert.deepStrictEqual(answer.traces.at(-1), {
        type: 'mcpl:inference_fail', serverId: 'scripted-server', model: 'default', error: REFUSED, streamed: false,
      });
    });

    it("answers a provider's finish_reason 'error' with the error, not end_turn and the partial text", async () => {
      const answer = await ask(PROVIDER_FAILED_PARTWAY, { stream: false, mode });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: PROVIDER_ERROR });
    });
  });
}

// A native tool call arrives as a typed tool_use block. membrane's yielding
// stream lists it in toolCalls only when the stop is tool_use, so a streamed
// block cut off by another stop is only in the content, and only the router's
// check of the content answers it. membrane's complete() lists every tool_use
// block in toolCalls as well as in the content, so the router's checks of
// toolCalls and of the content each answer the case that isn't streamed, which
// makes it a control for each check.
describe('MCPL inference router, native mode: a tool_use block', () => {
  for (const stream of [true, false]) {
    const how = stream ? 'streamed' : 'not streamed (a control: either check answers it)';
    it(`answers a tool_use block cut off at max_tokens with the error, ${how}`, async () => {
      const answer = await ask(
        { chunks: ['Let me look that up.'], stopReason: 'max_tokens', toolUse: 'search' },
        { stream, mode: 'native' },
      );

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: CALLED_A_TOOL });
    });
  }
});

// A model's tool call and its <thinking> are parsed out of the text only in
// XML mode; in native mode they arrive as typed blocks the provider sends.
describe('MCPL inference router, xml mode: what the text carries', () => {
  it('answers a streamed tool call with the error, and leaves no stream waiting for results', { timeout: 5_000 }, async () => {
    const answer = await ask(TOOL_CALL, { stream: true, mode: 'xml' });

    assert.strictEqual(answer.result, undefined);
    assert.deepStrictEqual(answer.error, { code: -32603, message: CALLED_A_TOOL });
    assert.strictEqual(answer.stream?.isWaitingForTools, false);
    assert.deepStrictEqual(answer.sent, ['chunk:Let me look that up.\n', `error:${CALLED_A_TOOL}`]);
  });

  it('answers a tool call with the error, not its markup as content, when not streamed', async () => {
    const answer = await ask(TOOL_CALL, { stream: false, mode: 'xml' });

    assert.strictEqual(answer.result, undefined);
    assert.deepStrictEqual(answer.error, { code: -32603, message: CALLED_A_TOOL });
  });

  it('answers a tool call cut off partway with the error, streamed', async () => {
    const answer = await ask(CUT_OFF_TOOL_CALL, { stream: true, mode: 'xml' });

    assert.strictEqual(answer.result, undefined);
    assert.deepStrictEqual(answer.error, { code: -32603, message: OPEN_TOOL_BLOCK });
  });

  it('answers a tool call cut off partway with the error, not its markup as content, when not streamed', async () => {
    const answer = await ask(CUT_OFF_TOOL_CALL, { stream: false, mode: 'xml' });

    assert.strictEqual(answer.result, undefined);
    assert.deepStrictEqual(answer.error, { code: -32603, message: OPEN_TOOL_BLOCK });
  });

  for (const stream of [true, false]) {
    const how = stream ? 'streamed' : 'not streamed';

    for (const [shape, script] of Object.entries(UNREADABLE_TOOL_BLOCKS)) {
      it(`answers a tool-call block membrane reads no call from (${shape}) with the error, ${how}`, async () => {
        const answer = await ask(script, { stream, mode: 'xml' });

        assert.strictEqual(answer.result, undefined);
        assert.deepStrictEqual(answer.error, { code: -32603, message: TOOL_MARKUP });
      });
    }

    it(`answers prose that opens a tool-call block and never closes it with the error, ${how}`, async () => {
      const answer = await ask(TAG_IN_PROSE, { stream, mode: 'xml' });

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: OPEN_TOOL_BLOCK });
    });
  }

  it('streams only visible text, leaving thinking out of the chunks and the content', async () => {
    const answer = await ask({
      chunks: ['<thinking>Which memories matter?</thinking>', 'They met twice.'],
      stopReason: 'end_turn',
    }, { stream: true, mode: 'xml' });

    assert.strictEqual(answer.result?.content, 'They met twice.');
    assert.deepStrictEqual(answer.sent, ['chunk:They met twice.', 'result:They met twice.']);
  });
});

// membrane's own stops (abort, and XML mode's resumption guards) can't be
// played from a provider here, so a membrane that answers each stop reason
// stands in for them.
describe('MCPL inference router: a stop reason FinishReason has no value for', () => {
  for (const stopReason of ['tool_use', 'pause_turn', 'abort', 'no_progress', 'round_limit'] as const) {
    it(`answers ${stopReason} with the error that names it`, async () => {
      const membrane = {
        complete: async (): Promise<NormalizedResponse> => ({
          content: [{ type: 'text', text: 'A summ' }],
          toolCalls: [],
          stopReason,
          usage: { ...USAGE },
          details: {
            stop: { reason: stopReason, wasTruncated: false },
            model: { requested: 'default', actual: 'scripted-model', provider: 'scripted' },
          },
        }) as unknown as NormalizedResponse,
      } as unknown as Membrane;

      const answer = await askWith(membrane, false);

      assert.strictEqual(answer.result, undefined);
      assert.deepStrictEqual(answer.error, { code: -32603, message: unnamedStop(stopReason) });
    });
  }
});

describe('MCPL inference router: a stream that ends with no terminal event', () => {
  // membrane 0.5.87's yielding stream ends every path with complete, error or
  // aborted, so a stand-in stream plays this one.
  it('answers with the error, after the chunks it sent', async () => {
    const membrane = {
      streamYielding: () => (async function* () {
        yield { type: 'tokens', content: 'Hel', meta: { type: 'text', visible: true, blockIndex: 0 } };
      })(),
    } as unknown as Membrane;

    const answer = await askWith(membrane, true);

    assert.strictEqual(answer.result, undefined);
    assert.deepStrictEqual(answer.error, { code: -32603, message: 'The inference stream ended without a result' });
    assert.deepStrictEqual(answer.sent, ['chunk:Hel', 'error:The inference stream ended without a result']);
  });
});

describe('MCPL inference router: a request the routing policy names no model for', () => {
  /** A router with `policy`, and a membrane that records what reaches it. */
  function refusingRouter(policy: InferenceRoutingPolicy | null) {
    const reached: NormalizedRequest[] = [];
    const traces: Array<{ type: string; [key: string]: unknown }> = [];
    const membrane = {
      complete: async (request: NormalizedRequest): Promise<NormalizedResponse> => {
        reached.push(request);
        return {
          content: [{ type: 'text', text: 'done' }],
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { ...USAGE },
          details: {
            stop: { reason: 'end_turn', wasTruncated: false },
            model: { requested: request.config.model, actual: request.config.model, provider: 'scripted' },
          },
        } as unknown as NormalizedResponse;
      },
      streamYielding: (request: NormalizedRequest) => {
        reached.push(request);
        throw new Error('not reached in these tests');
      },
    } as unknown as Membrane;
    const router = new InferenceRouter(
      membrane,
      { isInHook: false } as unknown as HookOrchestrator,
      { validateInbound: () => {} } as unknown as FeatureSetManager,
      policy,
      (event) => { traces.push(event); },
    );
    const ask = async (serverId: string, featureSet: string, stream = false, conversationId?: string, noChunks = false) => {
      const answers: Array<{ result?: McplInferenceRequestResult; error?: { code: number; message: string; data?: unknown } }> = [];
      await router.handleInferenceRequest(serverId, {
        featureSet,
        stream,
        ...(conversationId === undefined ? {} : { conversationId }),
        messages: [{ role: 'user', content: 'Summarize these memories.' }],
      }, {
        requestId: 7,
        respond: (result) => { answers.push({ result }); },
        respondError: (code, message, data) => { answers.push({ error: { code, message, data } }); },
        ...(noChunks ? {} : { sendChunk: () => { throw new Error('a refused request sends no chunk'); } }),
      });
      return answers;
    };
    return { ask, reached, traces };
  }

  /** console.error's lines while `run` runs. */
  async function logged(run: () => Promise<void>): Promise<string[]> {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await run();
    } finally {
      console.error = original;
    }
    return lines;
  }

  const NO_POLICY = "inference/request refused: the host sets no inference routing policy (inferenceRouting), so the host has no model to run it on; it stays refused until the host's operator configures one";
  const noModelFor = (featureSet: string) =>
    `inference/request refused: the inference routing policy (inferenceRouting) names no model for feature set ${JSON.stringify(featureSet)}, so the host has no model to run it on; it stays refused until the host's operator configures one`;

  for (const stream of [false, true]) {
    it(`refuses with -32603 naming inferenceRouting when the host sets no policy, and nothing reaches membrane (${stream ? 'streamed' : 'not streamed'})`, async () => {
      const { ask, reached, traces } = refusingRouter(null);
      let answers: Awaited<ReturnType<typeof ask>> = [];
      await logged(async () => { answers = await ask('srv', 'memory.consolidation', stream); });

      // -32603, as the request was answered when it reached the provider
      // with the model `default`; the server's grant can still list
      // inferenceRequest, so not -32002.
      assert.deepStrictEqual(answers, [{ error: { code: -32603, message: NO_POLICY, data: undefined } }]);
      assert.deepStrictEqual(reached, []);
      // The failure a trace watcher saw when this failed at the provider,
      // with no inference_start, since none started.
      assert.deepStrictEqual(traces, [{ type: 'mcpl:inference_fail', serverId: 'srv', model: null, error: NO_POLICY, streamed: stream }]);
    });
  }

  it('logs the refusal once per server, while answering every request', async () => {
    const { ask } = refusingRouter(null);
    const answered: number[] = [];
    const lines = await logged(async () => {
      answered.push((await ask('srv-a', 'memory.consolidation')).length);
      answered.push((await ask('srv-a', 'memory.consolidation')).length);
      answered.push((await ask('srv-a', 'drafts')).length);
      answered.push((await ask('srv-b', 'memory.consolidation')).length);
    });

    assert.deepStrictEqual(answered, [1, 1, 1, 1]);
    assert.deepStrictEqual(lines, [
      '[mcpl] srv-a: inference/request refused: the host sets no inference routing policy (inferenceRouting); set inferenceRouting in the framework config to choose the model server-initiated inference runs on. This line prints once per server; later refusals are answered and traced but not logged.',
      '[mcpl] srv-b: inference/request refused: the host sets no inference routing policy (inferenceRouting); set inferenceRouting in the framework config to choose the model server-initiated inference runs on. This line prints once per server; later refusals are answered and traced but not logged.',
    ]);
  });

  it('traces a refused request that asked to stream but has no way to send chunks as not streamed', async () => {
    const { ask, traces } = refusingRouter(null);
    await logged(async () => { await ask('srv', 'notes', true, undefined, true); });

    assert.deepStrictEqual(traces, [{ type: 'mcpl:inference_fail', serverId: 'srv', model: null, error: NO_POLICY, streamed: false }]);
  });

  it('logs once per server and feature set with a policy, naming what to give it, and the server and feature set as given', async () => {
    const { ask, traces } = refusingRouter({ default: '' });
    const odd = 'notes\u200b=x';
    const server = 'srv\n[mcpl] other: forged';
    const answered: Array<Awaited<ReturnType<typeof ask>>> = [];
    const lines = await logged(async () => {
      answered.push(await ask(server, odd));
      answered.push(await ask(server, odd));
      answered.push(await ask(server, 'drafts'));
      answered.push(await ask('srv-2', odd));
    });

    assert.deepStrictEqual(answered.map((a) => a[0]?.error?.code), [-32603, -32603, -32603, -32603]);
    assert.strictEqual(traces.length, 4, 'every refusal is traced');
    assert.deepStrictEqual(traces[0], { type: 'mcpl:inference_fail', serverId: server, model: null, error: noModelFor(odd), streamed: false });
    assert.strictEqual(lines.length, 3, lines.join('\n'));
    assert.match(lines[2]!, /^\[mcpl\] srv-2: /);
    assert.ok(lines[0]!.includes('; give it a default, or a byFeature or wildcards entry for that feature set. This line prints once per server and feature set; later refusals are answered and traced but not logged.'), lines[0]);
    assert.ok(lines[1]!.includes('names no model for feature set drafts;'), lines[1]);
    assert.ok(!lines[0]!.includes('\u200b'), 'the invisible character is shown escaped');
    const shown = /feature set ("[^"]*")/.exec(lines[0]!)![1]!;
    assert.strictEqual(JSON.parse(shown), odd, 'the operator can read back exactly the name the server sent');
    assert.ok(!lines[0]!.includes('\n'), 'one line, whatever the server id holds');
    const shownServer = /^\[mcpl\] ("[^"]*"): /.exec(lines[0]!)![1]!;
    assert.strictEqual(JSON.parse(shownServer), server);
  });

  it('takes a conversation override over byFeature, byFeature over wildcards, and the first matching wildcard over a later one', async () => {
    const { ask, reached } = refusingRouter({
      default: 'by-default',
      overrides: { 'conv-1': 'by-override', '': 'by-empty-id' },
      byFeature: { 'memory.summary': 'by-feature' },
      wildcards: { 'memory.*': 'first-wildcard', '*.digest': 'second-wildcard' },
    });
    await logged(async () => {
      await ask('srv', 'memory.summary', false, 'conv-1');
      await ask('srv', 'memory.summary');
      await ask('srv', 'memory.digest');
      await ask('srv', 'notes');
      await ask('srv', 'notes', false, '');
    });

    assert.deepStrictEqual(reached.map((r) => r.config.model), ['by-override', 'by-feature', 'first-wildcard', 'by-default', 'by-default']);
  });

  it('refuses a feature set a policy with no default names no model for, and runs one it names', async () => {
    const { ask, reached } = refusingRouter({ default: '', byFeature: { 'memory.consolidation': 'house-summarizer' } });
    let unnamed: Awaited<ReturnType<typeof ask>> = [];
    let named: Awaited<ReturnType<typeof ask>> = [];
    const lines = await logged(async () => {
      unnamed = await ask('srv', 'notes');
      named = await ask('srv', 'memory.consolidation');
    });

    assert.deepStrictEqual(unnamed, [{ error: { code: -32603, message: noModelFor('notes'), data: undefined } }]);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(reached.map((r) => r.config.model), ['house-summarizer']);
    assert.strictEqual(named[0]?.result?.model, 'house-summarizer');
  });

  it('routes by the first wildcard that names a model, passing over empty and non-string entries as a missing one is', async () => {
    const { ask, reached } = refusingRouter({
      default: 'house-default',
      overrides: { 'conv-1': '', 'conv-2': {} as unknown as string },
      byFeature: { notes: '', drafts: 5 as unknown as string },
      wildcards: { 'memory.*': 7 as unknown as string, '*.consolidation': 'wild-model' },
    });
    await logged(async () => {
      await ask('srv', 'memory.consolidation');
      await ask('srv', 'notes', false, 'conv-1');
      await ask('srv', 'drafts', false, 'conv-2');
    });

    assert.deepStrictEqual(reached.map((r) => r.config.model), ['wild-model', 'house-default', 'house-default']);
  });

  it('refuses a default that is not a string, and nothing reaches membrane', async () => {
    const { ask, reached } = refusingRouter({ default: 5 as unknown as string });
    let answers: Awaited<ReturnType<typeof ask>> = [];
    await logged(async () => { answers = await ask('srv', 'notes'); });

    assert.deepStrictEqual(answers, [{ error: { code: -32603, message: noModelFor('notes'), data: undefined } }]);
    assert.deepStrictEqual(reached, []);
  });

  it('refuses when the only matching wildcard is empty and the default is empty, and nothing reaches membrane', async () => {
    const { ask, reached } = refusingRouter({ default: '', wildcards: { 'memory.*': '' } });
    let answers: Awaited<ReturnType<typeof ask>> = [];
    await logged(async () => { answers = await ask('srv', 'memory.consolidation'); });

    assert.deepStrictEqual(answers, [{ error: { code: -32603, message: noModelFor('memory.consolidation'), data: undefined } }]);
    assert.deepStrictEqual(reached, []);
  });

  it("never reads a model from Object.prototype for a server's conversation id or feature set", async () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      const empty = refusingRouter({ default: '', overrides: {}, byFeature: {} });
      let answers: Awaited<ReturnType<typeof empty.ask>> = [];
      await logged(async () => { answers = await empty.ask('srv', key, false, key); });
      assert.deepStrictEqual(answers, [{ error: { code: -32603, message: noModelFor(key), data: undefined } }], key);
      assert.deepStrictEqual(empty.reached, [], key);

      const routed = refusingRouter({ default: 'house-default', overrides: {}, byFeature: {} });
      await logged(async () => { await routed.ask('srv', key, false, key); });
      assert.deepStrictEqual(routed.reached.map((r) => r.config.model), ['house-default'], key);
    }
  });

  it("sends nothing to the provider for a host with no policy, where it sent the model 'default' (the reported 404)", async () => {
    // As reported: a real Membrane on its Anthropic adapter, the client
    // replaced so a sent request is recorded rather than answered 404.
    const sent: Array<{ model?: unknown }> = [];
    const adapter = new AnthropicAdapter({ apiKey: 'test' } as never);
    (adapter as unknown as { client: unknown }).client = {
      messages: {
        create: async (request: { model?: unknown }) => {
          sent.push(request);
          return {
            id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn', stop_sequence: null, model: request.model, usage: { input_tokens: 1, output_tokens: 1 },
          };
        },
      },
    };
    const router = new InferenceRouter(
      new Membrane(adapter as never, {} as never),
      { isInHook: false } as unknown as HookOrchestrator,
      { validateInbound: () => {} } as unknown as FeatureSetManager,
      null,
      () => {},
    );
    const answers: unknown[] = [];
    await logged(async () => {
      await router.handleInferenceRequest('srv', { featureSet: 'notes', messages: [{ role: 'user', content: 'hi' }] }, {
        respond: (result) => { answers.push({ result }); },
        respondError: (code, message) => { answers.push({ code, message }); },
      });
    });

    assert.deepStrictEqual(sent.map((r) => r.model), []);
    assert.deepStrictEqual(answers, [{ code: -32603, message: NO_POLICY }]);
  });
});
