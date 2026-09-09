import type { ProcessEvent } from './events.js';
import type { ModuleProcessResponse } from './framework.js';
import type { SessionUsage } from '../usage/types.js';

/**
 * Base for all trace events.
 * TraceEvents are observability-only — they NEVER drive logic.
 */
export interface TraceEventBase {
  /** When this trace was emitted */
  timestamp: number;
  /** Optional correlation ID for distributed tracing */
  traceId?: string;
}

/**
 * Observability events emitted by the framework.
 * Subscribe via framework.onTrace() to monitor system behavior.
 *
 * These are purely informational — use them for:
 * - UI updates (showing inference progress, tool execution)
 * - Logging and debugging
 * - Metrics and monitoring
 * - Broadcasting to WebSocket clients
 *
 * They should NEVER be used to drive application logic.
 * For that, use ProcessEvent via the event queue.
 */
export type TraceEvent =
  // Process lifecycle
  | (TraceEventBase & { type: 'process:received'; processEvent: ProcessEvent })
  | (TraceEventBase & {
      type: 'process:completed';
      processEvent: ProcessEvent;
      responses: ModuleProcessResponse[];
      durationMs: number;
    })

  // Inference lifecycle
  | (TraceEventBase & {
      type: 'inference:started';
      agentName: string;
      /**
       * The turn-frozen outbound locus (see turnLocusPins) — the channel this
       * turn's plain prose will be routed to. Omitted for turns with no locus
       * (heartbeats with no default channel). Observability only, like every
       * trace field; lets external taps (e.g. a TTS relay) tag the whole
       * activation with its channel without re-deriving routing.
       */
      channelId?: string;
    })
  | (TraceEventBase & {
      type: 'inference:completed';
      agentName: string;
      durationMs: number;
      tokenUsage?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
    })
  | (TraceEventBase & {
      type: 'inference:aborted';
      agentName: string;
      durationMs: number;
      reason?: string;
    })
  | (TraceEventBase & {
      type: 'inference:failed';
      agentName: string;
      error: string;
      stack?: string;
    })
  | (TraceEventBase & {
      type: 'inference:exhausted';
      agentName: string;
      error: string;
      /** Whether membrane classified the failure as retryable (observability). */
      retryable?: boolean;
      /**
       * The membrane error type (e.g. 'invalid_request', 'auth', 'context_length').
       * The poison-history breaker fires only on 'invalid_request'.
       */
      errorType?: string;
    })

  // Streaming inference lifecycle
  | (TraceEventBase & {
      type: 'inference:tokens';
      agentName: string;
      content: string;
      /**
       * Which membrane block produced this chunk. Carried verbatim from the
       * membrane's ChunkMeta. Consumers that want to render thinking content
       * distinctly from regular text should switch on this.
       */
      blockType: 'text' | 'thinking' | 'tool_call' | 'tool_result';
      /** 0-indexed block position in the current assistant turn. */
      blockIndex: number;
      /** Turn-frozen outbound locus for this turn (see inference:started). */
      channelId?: string;
    })
  | (TraceEventBase & {
      /**
       * Structural boundary inside the assistant turn — emitted on every
       * block_start / block_complete from the membrane. Use this to switch
       * render lanes (e.g. open a dim "thinking" element on block_start
       * with blockType='thinking', close it on block_complete).
       */
      type: 'inference:content_block';
      agentName: string;
      phase: 'block_start' | 'block_complete';
      blockType: 'text' | 'thinking' | 'tool_call' | 'tool_result';
      blockIndex: number;
      /** Turn-frozen outbound locus for this turn (see inference:started). */
      channelId?: string;
    })
  | (TraceEventBase & {
      type: 'inference:tool_calls_yielded';
      agentName: string;
      calls: Array<{ id: string; name: string; input?: unknown }>;
    })
  | (TraceEventBase & {
      type: 'inference:usage';
      agentName: string;
      tokenUsage: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
    })
  | (TraceEventBase & {
      type: 'inference:stream_resumed';
      agentName: string;
      /** Count of mid-turn messages injected into the resumed round (hear-while-acting). */
      injectedMessages?: number;
    })
  | (TraceEventBase & {
      type: 'inference:stream_restarted';
      agentName: string;
      reason: string;
      inputTokens: number;
      budget: number;
    })
  | (TraceEventBase & {
      type: 'inference:turn_ended';
      agentName: string;
    })

  // Tool lifecycle
  | (TraceEventBase & {
      type: 'tool:started';
      module: string;
      tool: string;
      callId: string;
      input?: unknown;
    })
  | (TraceEventBase & {
      type: 'tool:completed';
      module: string;
      tool: string;
      callId: string;
      durationMs: number;
    })
  | (TraceEventBase & {
      type: 'tool:failed';
      module: string;
      tool: string;
      callId: string;
      error: string;
      stack?: string;
    })
  | (TraceEventBase & {
      type: 'tool:result_dropped';
      agentName: string;
      callId: string;
      agentStatus: string;
      result: unknown;
    })
  | (TraceEventBase & {
      /**
       * A writable workspace existed but the oversized-result spill write
       * failed (size cap, storeBlob failure, …) — the over-cap tail was NOT
       * retained. Distinct from the no-workspace fallback, which is silent
       * by design (nothing unexpected happened).
       */
      type: 'tool:spill_failed';
      label: string;
      path: string;
      contentLength: number;
      error: string;
    })

  // Module lifecycle
  | (TraceEventBase & { type: 'module:added'; moduleName: string })
  | (TraceEventBase & { type: 'module:removed'; moduleName: string })

  // Resident lifecycle
  | (TraceEventBase & {
      type: 'resident:retired';
      agentName: string;
      retiredAt: number;
      /** Whether the terminal lifecycle event was also appended to Chronicle. */
      chronicleRecorded: boolean;
    })

  // Inference request health
  | (TraceEventBase & {
      type: 'inference:request_dropped';
      agentName: string;
      reason: string;
      requestCount: number;
      oldestRequestAge: number;
    })
  | (TraceEventBase & {
      type: 'inference:request_stale';
      agentName: string;
      agentStatus: string;
      requestCount: number;
      oldestRequestAge: number;
    })

  // Message lifecycle
  | (TraceEventBase & {
      type: 'message:added';
      messageId: string;
      source: string;
    })

  // EventGate lifecycle
  | (TraceEventBase & {
      type: 'gate:policy-matched';
      policyName: string;
      behavior: string;
      eventType: string;
      source?: string;
    })
  | (TraceEventBase & {
      type: 'gate:config-error';
      error: string;
      configPath: string;
    })
  | (TraceEventBase & {
      type: 'gate:debounce-delivered';
      policyName: string;
      eventCount: number;
    })
  | (TraceEventBase & {
      type: 'gate:config-reloaded';
      configPath: string;
      policyCount: number;
    })
  | (TraceEventBase & {
      type: 'gate:decision';
      eventType: string;
      serverId?: string;
      channelId?: string;
      matchedPolicy: string | null;
      trigger: boolean;
      behavior: string;
    })

  // Usage lifecycle
  | (TraceEventBase & {
      type: 'usage:updated';
      totals: SessionUsage;
      agentName: string;
      inferenceCount: number;
    })

  // Undo/redo lifecycle
  | (TraceEventBase & {
      type: 'undo:completed';
      agentName: string;
      turnIndex: number;
      fromBranch: string;
      toBranch: string;
    })
  | (TraceEventBase & {
      type: 'redo:completed';
      agentName: string;
      fromBranch: string;
      toBranch: string;
    })

  // MCPL subprocess stderr (one trace per line, for receipts when things break)
  | (TraceEventBase & {
      type: 'mcpl:server-stderr';
      serverId: string;
      line: string;
    })

  // Per-channel conversation routing lifecycle
  | (TraceEventBase & {
      type: 'mcpl:conversation-spawned';
      channelId: string;
      agentName: string;
      generation: number;
      template: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-spawn-failed';
      channelId: string;
      agentName: string;
      error: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-unrouted';
      channelId: string;
      messageId: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-binding-orphaned';
      channelId: string;
      agentName: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-closed';
      channelId: string;
      agentName: string;
      reason: 'idle-ttl';
    })
  | (TraceEventBase & {
      type: 'mcpl:conversation-disposed';
      agentName: string;
      channelId?: string;
    })

  // Host-owned speech routing (ChannelRegistry.routeSpeech). One trace per
  // delivered prose segment. `text` is the segment verbatim — the same content
  // already on the bus chunk-by-chunk via inference:tokens, and mcpl:* traces
  // are 'ops'-scoped on the webui wire — and `messageId` is the surface's id
  // for the posted message (when the MCPL server reports one). Together they
  // give external taps the (channelId, messageId, text) tuple needed to edit
  // a just-posted message, e.g. a TTS interruption truncating a reply to the
  // words actually voiced.
  | (TraceEventBase & {
      type: 'mcpl:speech-routed';
      /** Agent / conversation whose speech was routed. */
      conversationId: string;
      serverId: string;
      channelId: string;
      delivered: boolean;
      textLen: number;
      /** The routed prose segment, verbatim. */
      text: string;
      /** Surface message id (e.g. Discord message id), when reported. */
      messageId?: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:speech-route-failed';
      /** Agent / conversation whose speech failed to route. */
      conversationId: string;
      /** Empty string when the failure was "no locus at all". */
      channelId: string;
      reason: string;
      textLen: number;
    })

  // Admin puppet: an operator executed a tool AS an agent and stored the
  // tool_use + tool_result pair in that agent's window (Framework.
  // puppetToolCall). Provenance lives HERE and in the host log — the stored
  // messages deliberately byte-match a model-initiated call.
  | (TraceEventBase & {
      type: 'puppet:tool-call';
      agentName: string;
      toolName: string;
      toolUseId: string;
      isError: boolean;
      durationMs: number;
    })

  // MCPL server connection lifecycle (spawn / handshake / reconnect health).
  // Previously these outcomes were visible only on the host process's own
  // stderr, so a server that lost the boot handshake race just went missing.
  | (TraceEventBase & {
      type: 'mcpl:server-connect-failed';
      serverId: string;
      error: string;
      /** Ordinal of the failed attempt: 0 is the initial connect, N is the Nth background retry. */
      attempt: number;
      /** True when a background reconnect loop will keep retrying. */
      willRetry: boolean;
    })
  | (TraceEventBase & {
      /** §17.6: the ONE normalized receipt per manifest change — closed
       *  host-derived impact vocabulary, never a server-authored flag. */
      type: 'mcpl:manifest-change-receipt';
      serverId: string;
      revision: string | null;
      announcedDomains: string[];
      impacts: Array<{ impact: string; subject: string; disposition: string }>;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-reconnected';
      serverId: string;
      /** How many attempts the reconnect loop needed (1 = first retry succeeded). */
      attempts: number;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-closed';
      serverId: string;
      /** Child process exit code, or null when killed by signal / closed explicitly. */
      code: number | null;
      /** Signal that terminated the child, if any. */
      signal: string | null;
      /** True when a background reconnect loop will revive the connection. */
      willReconnect: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-error';
      serverId: string;
      error: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:orphaned-response';
      serverId: string;
      /** The JSON-RPC id of the late response whose pending request already timed out. */
      responseId: string | number;
      /** Original request method when retained for mandatory-deadline visibility. */
      method?: string;
      /** True when the dropped response carried host-managed `state`. */
      hadState: boolean;
      /** True when the dropped response carried a server-managed `checkpoint`. */
      hadCheckpoint: boolean;
    })

  // Ops / fleet observability. Everything the framework's opsAlert() escalates
  // (refusals, hard-down, MCPL unreachable, …) mirrored onto the trace bus so
  // authorized observers see alerts on the same wire as the rest of the
  // agent's internal life. Discord (CONNECTOME_OPS_WEBHOOK) is one sink of
  // this stream, not a separate system. See connectome docs/observability.md.
  | (TraceEventBase & {
      type: 'ops:alert';
      /** Alert kind — open set: 'refusal' | 'hard-down' | 'mcpl-down' | … */
      kind: string;
      /** Agent name, or a server/component id for non-agent alerts (e.g. mcpl-down). */
      agentName: string;
      message: string;
      /** Kind-specific structured payload (mirrors the failures.log record). */
      data?: Record<string, unknown>;
    });

/**
 * Listener for trace events.
 */
export type TraceEventListener = (event: TraceEvent) => void;
