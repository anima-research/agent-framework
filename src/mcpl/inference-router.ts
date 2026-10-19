/**
 * InferenceRouter — handles inference/request from MCPL servers.
 *
 * Servers can ask the host to run inference on their behalf. This router
 * validates permissions, resolves the target model via routing policy,
 * runs inference through membrane, and optionally streams chunks back.
 *
 * Spec reference: Section 11 (Server-Initiated Inference).
 */

import type {
  Membrane,
  ContentBlock,
  NormalizedRequest,
  NormalizedResponse,
  StopReason,
  ToolCall,
} from '@animalabs/membrane';

import type {
  McplInferenceRequestParams,
  McplInferenceRequestResult,
  InferenceChunkParams,
  InferenceRoutingPolicy,
} from './types.js';
import type { FeatureSetManager } from './feature-set-manager.js';
import { McplFeatureSetError } from './feature-set-manager.js';
import type { HookOrchestrator } from './hook-orchestrator.js';

// ============================================================================
// Responder interface
// ============================================================================

/** Minimal responder interface for sending JSON-RPC results back. */
interface Responder {
  respond(result: McplInferenceRequestResult): void;
  respondError(code: number, message: string, data?: unknown): void;
  /** The JSON-RPC request ID, used for streaming chunk correlation. */
  requestId?: string | number;
  /** Sends a streamed chunk on the transport the request came on, as its
   *  answer is sent. */
  sendChunk?(params: InferenceChunkParams): void;
}

// ============================================================================
// Wildcard matching (same logic as feature-set-manager)
// ============================================================================

/**
 * Simple glob match: split on `.`, `*` matches any single segment.
 */
function wildcardMatch(pattern: string, name: string): boolean {
  const patternParts = pattern.split('.');
  const nameParts = name.split('.');

  if (patternParts.length !== nameParts.length) {
    return false;
  }

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p === '*') {
      continue;
    }
    if (p !== nameParts[i]) {
      return false;
    }
  }

  return true;
}

// ============================================================================
// Results
// ============================================================================

/**
 * The inference/request result for a completed inference, the same for both
 * modes: the response's text, the model that served it, why it stopped, and
 * its usage.
 *
 * A response MCPL can't report as a completion throws, and is answered with
 * the error: one the provider ended with an error, one where the model wrote a
 * tool call, since inference/request offers the model none, and one with a
 * stop reason FinishReason has no value for (see finishReasonFor).
 */
function resultFrom(response: NormalizedResponse, routedModel: string): McplInferenceRequestResult {
  // A provider can end an inference with finish_reason 'error' and no error
  // object. membrane 0.5.87's OpenAI-style adapters fail a stream on a frame
  // that carries one, as OpenRouter's mid-stream error does, but pass the token
  // alone through, and membrane, having no stop reason for it, normalizes it
  // to end_turn and keeps it as providerReason.
  if (response.details.stop.providerReason === 'error') {
    throw new Error("The provider ended the inference with an error (finish_reason 'error')");
  }
  // membrane's yielding stream lists a native tool call in toolCalls only
  // when the stop was tool_use, so a tool_use block cut off by another stop is
  // only in the content. membrane's complete() lists every tool_use block in
  // toolCalls, whatever the stop.
  const toolUses = response.content.filter((b: ContentBlock): b is ContentBlock & { type: 'tool_use' } => b.type === 'tool_use');
  if (response.toolCalls.length > 0 || toolUses.length > 0) {
    throw toolCallError(response.toolCalls.length > 0 ? response.toolCalls : toolUses);
  }
  // In XML tool mode membrane reads tool calls out of the text. Markup it
  // reads no call from still shows in how the output ended: with a tool-call
  // block still open (a call cut off at max_tokens, or an opening tag written
  // in prose), or at `</function_calls>`, the stop sequence XML tool mode adds
  // so that it can run calls (inference/request asks for no stop sequence of
  // its own). Either way the markup is in the text.
  if (response.details.stop.unclosedToolBlock) {
    throw new Error("The model's output ended with a tool-call block still open, and inference/request offers no tools");
  }
  if (response.details.stop.triggeredSequence === '</function_calls>') {
    throw new Error('The model wrote tool-call markup, and inference/request offers no tools');
  }
  return {
    content: response.content
      .filter((b: ContentBlock): b is ContentBlock & { type: 'text' } => b.type === 'text')
      .map((b) => b.text)
      .join(''),
    // Spec §11.3: the actual model used, which can differ from the routed one
    // where routing or fallback applies. When membrane names none, the routed
    // model is the only one there is to report.
    model: actualModelOf(response) ?? routedModel,
    finishReason: finishReasonFor(response.stopReason),
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
  };
}

/**
 * The model membrane says served the response, or undefined when it names
 * none. membrane's type says it always names one, but some of its adapters
 * pass the provider's own value through as it is, which can be empty.
 */
function actualModelOf(response: NormalizedResponse): string | undefined {
  return response.details.model.actual || undefined;
}

/**
 * MCPL's finishReason for membrane's stop reason. Spec §11.3 closes
 * FinishReason at these three, so any other stop throws: `end_turn` for a
 * refusal, or for a turn membrane's resumption guard ended (`no_progress`,
 * `round_limit`), would tell the server the model had finished.
 */
function finishReasonFor(stopReason: StopReason): McplInferenceRequestResult['finishReason'] {
  switch (stopReason) {
    case 'end_turn':
    case 'max_tokens':
    case 'stop_sequence':
      return stopReason;
    default:
      throw new Error(
        `The inference ended with stop reason '${stopReason}', for which inference/request has no finishReason`,
      );
  }
}

/** The error for a model that called a tool, which inference/request doesn't offer. */
function toolCallError(calls: Array<Pick<ToolCall, 'name'>>): Error {
  const names = calls.map((call) => call.name).join(', ');
  return new Error(`The model called a tool (${names}), and inference/request offers none`);
}

// ============================================================================
// Constants
// ============================================================================

/** Default max tokens when not specified in preferences. */
const DEFAULT_MAX_TOKENS = 4096;

// ============================================================================
// InferenceRouter
// ============================================================================

export class InferenceRouter {
  private membrane: Membrane;
  private hookOrchestrator: HookOrchestrator;
  private featureSetManager: FeatureSetManager;
  private routingPolicy: InferenceRoutingPolicy | null;
  private emitTraceFn: (event: { type: string; [key: string]: unknown }) => void;

  constructor(
    membrane: Membrane,
    hookOrchestrator: HookOrchestrator,
    featureSetManager: FeatureSetManager,
    routingPolicy: InferenceRoutingPolicy | null,
    emitTraceFn: (event: { type: string; [key: string]: unknown }) => void,
  ) {
    this.membrane = membrane;
    this.hookOrchestrator = hookOrchestrator;
    this.featureSetManager = featureSetManager;
    this.routingPolicy = routingPolicy;
    this.emitTraceFn = emitTraceFn;
  }

  /**
   * Handle an inference/request from an MCPL server.
   *
   * 1. Validate feature set
   * 2. Check loop prevention (reject if inside a hook)
   * 3. Resolve model from routing policy
   * 4. Build membrane request
   * 5. Run inference, streaming its visible text as chunks when asked
   * 6. Answer with the result, or with the error for any ending that isn't
   *    a completion
   */
  async handleInferenceRequest(
    serverId: string,
    params: McplInferenceRequestParams,
    responder: Responder,
  ): Promise<void> {
    // 1. Validate feature set
    try {
      this.featureSetManager.validateInbound(serverId, params.featureSet);
    } catch (err) {
      const message = err instanceof McplFeatureSetError
        ? err.message
        : 'Feature set validation failed';
      const code = err instanceof McplFeatureSetError ? err.code : -32600;
      responder.respondError(code, message);
      return;
    }

    // 2. Loop prevention: reject if inside a hook
    if (this.hookOrchestrator.isInHook) {
      responder.respondError(
        -32600,
        'Cannot process inference request during hook execution',
      );
      return;
    }

    // 3. Resolve model
    const model = this.resolveModel(
      params.featureSet,
      params.conversationId,
    );

    // Emit trace: inference start
    this.emitTraceFn({
      type: 'mcpl:inference_start',
      serverId,
      featureSet: params.featureSet,
      model,
      stream: params.stream ?? false,
    });

    // 4. Build membrane-compatible request
    const messages: NormalizedRequest['messages'] = params.messages.map((msg) => ({
      participant: msg.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text' as const, text: msg.content }],
    }));

    const request: NormalizedRequest = {
      messages,
      config: {
        model,
        maxTokens: params.preferences?.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: params.preferences?.temperature,
      },
    };

    // Streaming needs a way to send chunks and an id to tag them with;
    // without either, the request is answered whole.
    const sendChunk = params.stream ? responder.sendChunk?.bind(responder) : undefined;
    const chunkRequestId = sendChunk ? responder.requestId : undefined;
    const streamed = chunkRequestId != null;

    try {
      // 5. Run inference. Both modes end in membrane's response, and one
      // builder makes the result from it.
      const response = chunkRequestId != null
        ? await this.streamResponse(request, chunkRequestId, sendChunk!)
        : await this.membrane.complete(request);

      // 6. Answer
      const result = resultFrom(response, model);
      const actualModel = actualModelOf(response);

      this.emitTraceFn({
        type: 'mcpl:inference_complete',
        serverId,
        // The routed model, as inference_start has it. actualModel is the one
        // the result reports, left out when membrane named none.
        model,
        ...(actualModel !== undefined ? { actualModel } : {}),
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        streamed,
      });

      responder.respond(result);
    } catch (err) {
      // Every ending that isn't a completion lands here, in either mode:
      // membrane's error, a stream that stopped early, a tool call, or a
      // stop FinishReason can't name. The answer is the JSON-RPC error, never
      // a result carrying what arrived.
      this.emitTraceFn({
        type: 'mcpl:inference_fail',
        serverId,
        model,
        error: err instanceof Error ? err.message : String(err),
        streamed,
      });

      responder.respondError(
        -32603,
        err instanceof Error ? err.message : 'Inference failed',
      );
    }
  }

  // ==========================================================================
  // Private: Model resolution
  // ==========================================================================

  /**
   * Resolve the model to use for an inference request based on routing policy.
   *
   * Priority:
   * 1. Per-conversation override
   * 2. Exact feature set match
   * 3. Wildcard pattern match (first match wins)
   * 4. Default from policy
   * 5. Fallback string 'default'
   */
  private resolveModel(
    featureSet: string,
    conversationId?: string,
  ): string {
    if (!this.routingPolicy) {
      return 'default';
    }

    // Check per-conversation override
    if (conversationId && this.routingPolicy.overrides?.[conversationId]) {
      return this.routingPolicy.overrides[conversationId];
    }

    // Check exact feature set match
    if (this.routingPolicy.byFeature?.[featureSet]) {
      return this.routingPolicy.byFeature[featureSet];
    }

    // Check wildcard patterns
    if (this.routingPolicy.wildcards) {
      for (const [pattern, matchedModel] of Object.entries(this.routingPolicy.wildcards)) {
        if (wildcardMatch(pattern, featureSet)) {
          return matchedModel;
        }
      }
    }

    // Default
    return this.routingPolicy.default;
  }

  // ==========================================================================
  // Private: Streaming
  // ==========================================================================

  /**
   * Run the inference as a stream, sending each visible text delta to the
   * server as an inference/chunk, and return membrane's response once the
   * stream completes.
   *
   * Every other ending throws, so the request is answered with the error
   * rather than with the text that arrived: membrane's `error`, an `aborted`
   * stream, a stream that ends with no terminal event, and `tool-calls`. A
   * stream that has yielded tool calls waits for their results until it is
   * cancelled, and inference/request offers the model no tools. Leaving the
   * loop by return or throw calls the stream's return(), which cancels it,
   * so nothing keeps running once the request is answered.
   */
  private async streamResponse(
    request: NormalizedRequest,
    requestId: string | number,
    sendChunk: (params: InferenceChunkParams) => void,
  ): Promise<NormalizedResponse> {
    const stream = this.membrane.streamYielding(request);
    let index = 0;

    for await (const event of stream) {
      switch (event.type) {
        case 'tokens':
          // Only text membrane marks visible is sent, which leaves out
          // thinking and tool-call markup. The result's content is the
          // response's text blocks, which membrane parses on its own, so in
          // XML tool mode the chunks can miss text the content holds: prose
          // naming a tag the stream parser opens a block for, or a thinking
          // block cut off before its close tag.
          if (event.meta.visible) {
            sendChunk({ requestId, index: index++, delta: event.content });
          }
          break;
        case 'tool-calls':
          throw toolCallError(event.calls);
        case 'complete':
          return event.response;
        case 'error':
          throw event.error;
        case 'aborted':
          throw new Error(`The inference stopped before it finished (${event.reason})`);
      }
    }
    throw new Error('The inference stream ended without a result');
  }
}
