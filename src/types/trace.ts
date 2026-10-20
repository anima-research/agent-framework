import type { ProcessEvent } from './events.js';
import type { ModuleProcessResponse } from './framework.js';
import type { SessionUsage } from '../usage/types.js';
import type { DraftReason } from '../prose-drafts.js';

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
       * The turn's locus as this stream starts (locus and hybrid mode): where
       * its unprefixed plain prose is published, unless a hybrid `>>>`
       * destination takes it, or a re-pin or a `channel_open` moves the locus
       * later in the turn. Omitted for a turn with no locus: explicit and
       * disabled mode, a silent turn, a private turn, and a heartbeat with
       * no default channel. Observability only, like
       * every trace field; lets external taps (e.g. a TTS relay) tag the
       * whole activation with its channel without re-deriving routing.
       */
      channelId?: string;
      /** True for a control-plane wake that must not surface typing/prose. */
      silent?: boolean;
    })
  | (TraceEventBase & {
      /**
       * The model answered and the turn ended: with the stream's final
       * response, or with a tool result carrying `endTurn`, which
       * `inference:turn_ended` then follows. `tokenUsage` is the stream's
       * usage, cumulative across its rounds.
       */
      type: 'inference:completed';
      agentName: string;
      durationMs: number;
      tokenUsage?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
    })
  | (TraceEventBase & {
      type: 'inference:aborted';
      agentName: string;
      /** How long this start of the turn ran; after a context-budget restart, from the restart. */
      durationMs: number;
      /**
       * Why the turn ended unfinished: the reason its canceller gave
       * `abortInference` or `Agent.cancelStream` (`'user'` when it gave
       * none), `'shutdown'` for a turn `stop()` cancelled,
       * `'quiesce_abandoned'` for a turn an operator quiesce abandoned, or,
       * for a turn dropped before it sent anything (its agent replaced or
       * removed, or the framework stopping or restarted), a sentence saying
       * which.
       */
      reason?: string;
    })
  | (TraceEventBase & {
      type: 'inference:failed';
      agentName: string;
      /** The failure's message, bounded as every trace event's `error` is (2,000 characters). */
      error: string;
      /** Bounded like `error`. */
      stack?: string;
    })
  | (TraceEventBase & {
      type: 'inference:exhausted';
      agentName: string;
      /** The failure's message, bounded as every trace event's `error` is (2,000 characters). */
      error: string;
      /** Whether membrane classified the failure as retryable (observability). */
      retryable?: boolean;
      /**
       * The membrane error type (e.g. 'invalid_request', 'auth', 'context_length'),
       * at most 128 characters. The poison-history breaker fires only on
       * 'invalid_request' at HTTP 400, 413 or 422 or with no status, and on
       * 'context_length' at 413 (shedMayHelp).
       */
      errorType?: string;
      /** The provider's HTTP status, when the failure carried one. */
      httpStatus?: number;
      /** The provider's own error code, when it sent one (at most 128 characters). */
      providerErrorCode?: string;
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
      /** The channel this stream shows typing in, the conversation the turn
       *  is attending. Locus and hybrid mode: the turn's locus, which an
       *  addressed re-pin or the agent's own `channel_open` can move between
       *  rounds, so it can change within one stream; the indicator and these
       *  traces follow it from the next round on, at the model's first
       *  content in it or its retry after a refusal, and a tool result the
       *  boundary reports carries the channel of the round it answers. In
       *  hybrid mode a `>>>` envelope can send the text itself elsewhere.
       *  Explicit mode: the channel the start's wake came from. */
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
      /** The channel this stream shows typing in, the conversation the turn
       *  is attending. Locus and hybrid mode: the turn's locus, which an
       *  addressed re-pin or the agent's own `channel_open` can move between
       *  rounds, so it can change within one stream; the indicator and these
       *  traces follow it from the next round on, at the model's first
       *  content in it or its retry after a refusal, and a tool result the
       *  boundary reports carries the channel of the round it answers. In
       *  hybrid mode a `>>>` envelope can send the text itself elsewhere.
       *  Explicit mode: the channel the start's wake came from. */
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
  | (TraceEventBase & {
      /**
       * Prose that delivery published, sent once the publish succeeds: the
       * outgoing stream's chunk (MCPL Spec 14.3 `channels/outgoing/chunk`),
       * emitted whether or not the channel's server takes the stream. It
       * carries only what was published, so a consumer that speaks or shows
       * it, such as a voice relay, never gets text that delivery withholds (a
       * `skip_reply`, a silencing send, a private `think`, a hold, a bounce,
       * a draft) or a publish the server didn't confirm (`delivered: true`):
       * one refused before sending, one that threw, timed out or got an
       * error answer, one the server reported undelivered
       * (`delivered: false`), and one whose reply leaves `delivered` out.
       * `inference:tokens` stays the model's text as it is written (held, as
       * before, while a tool-result guard's batch is pending). A later
       * publish to the same destination, a server and its channel, by the
       * same stream opens with a paragraph break (`\n\n`), so a
       * destination's chunks joined in `index` order are its text, its
       * messages kept apart.
       * `mcpl:speech-routed` also reports speech publishes, with no stream
       * id, index or end, each once delivered: deliverSpeech's, the `sleep`
       * tool's announcement among them, and a subconscious's
       * `speak_in_channel`'s. A relay that voices the agent's prose takes
       * this trace, with `inference:published_complete`, and not
       * `mcpl:speech-routed` as well, and takes each message's id from its
       * `messageId` to edit what it voiced.
       */
      type: 'inference:published';
      agentName: string;
      /** The server the prose is published to, and its channel there: two
       *  servers' channels with the same id are two destinations. */
      serverId: string;
      channelId: string;
      /** The stream's id, shared with its `channels/outgoing/*` notifications. */
      inferenceId: string;
      /** Increases by one per chunk of the stream, across its channels. */
      index: number;
      text: string;
      /** The id the channel's server returned for this chunk's publish
       *  (`ChannelsPublishResult.messageId`); absent when it returned none.
       *  Each chunk is one publish, so each carries its own. */
      messageId?: string;
    })
  | (TraceEventBase & {
      /**
       * A stream's end for one destination it published to, a server and
       * its channel, emitted on every exit path once the stream has ended
       * and its deliveries have run, or, when the host stops, before its
       * connections close: `text` is everything its `inference:published`
       * chunks carried there by then, and none follows it. Like those
       * chunks, it's emitted whether or not that server takes the stream,
       * or registers the channel still; the MCPL
       * `channels/outgoing/complete` goes to the server only when it does.
       */
      type: 'inference:published_complete';
      agentName: string;
      serverId: string;
      channelId: string;
      inferenceId: string;
      text: string;
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
       * A module's onToolBatchComplete threw or outlasted its bound; the
       * round went on without it.
       */
      type: 'module:batch_hook_failed';
      agentName: string;
      module: string;
      error: string;
    })
  | (TraceEventBase & {
      /**
       * The workspace had a writable mount without an include, where spills
       * go, but the oversized-result spill write failed (size cap, storeBlob failure, …) — the over-cap tail was NOT
       * retained. Distinct from the no-workspace fallback, which is silent
       * by design (nothing unexpected happened), whether the setup has no
       * writable mount or every writable mount has an include, as configured.
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
  /** An unread message withdrawn or replaced by its sender (RFC-006). */
  | (TraceEventBase & {
      type: 'message:removed';
      messageId: string;
      source: string;
    })
  /** A push/event refused at the MCPL boundary: visibly-empty content
   *  (`empty-content`, answered -32602, with no `field` or `detail`), or a
   *  coalesced occurrence the host refused. A refused occurrence's reason
   *  follows the code the producer was answered with: `coalesce-invalid` when
   *  the occurrence was the producer's to fix (-32602 malformed; -32017 or
   *  -32023 for a channel not permitted or not registered), `coalesce-failed`
   *  when the host itself failed (-32000, -32603). Its trace carries the
   *  error's message in `detail`, and the failing `field` when the error
   *  names one, and `channelId` when the push is refused for its channel
   *  (-32017, -32023), so each refusal names its channel even while repeats
   *  of its line are held back. An `eventId` that is missing or isn't a
   *  string is traced as `''`. A push refused for its feature set, or as a
   *  duplicate, gets a `[push-event-rejected]` line and no trace. */
  | (TraceEventBase & {
      type: 'mcpl:push-event-rejected';
      serverId: string;
      eventId: string;
      featureSet: string;
      reason: string;
      field?: string;
      channelId?: string;
      detail?: string;
    })
  /** A channels/incoming message refused at the MCPL boundary: an
   *  unregistered channel (`unknown-channel`, §14.5), visibly-empty content
   *  (`empty-content`), or a coalesced item the host refused
   *  (`coalesce-invalid` / `coalesce-failed`, with `detail`, and `field` when
   *  the error names one, as for a push). A coalesced item refused with
   *  -32602 (malformed) is answered `coalesce_invalid`, and one refused
   *  otherwise (-32000, or an internal error) with the error's own message.
   *  `messageId` is set whenever the message carries one. An uncoalesced
   *  message without a channelId or messageId is answered `invalid
   *  channel/message identity`, with no line and no trace. */
  | (TraceEventBase & {
      type: 'mcpl:channel-incoming-rejected';
      serverId: string;
      channelId: string;
      messageId?: string;
      reason: string;
      field?: string;
      detail?: string;
    })
  /** MCPL content with nothing model-visible reached the store/wake site
   *  (module-emitted or coalescer-delivered) and was dropped: no row, no wake. */
  | (TraceEventBase & {
      type: 'mcpl:empty-content-dropped';
      lane: 'push' | 'channel';
      serverId: string;
      eventId?: string;
      channelId?: string;
      messageId?: string;
    })
  /** RFC-006 coalescing decision record (received / displaced / removed /
   *  rendered / revoked / render-cancelled / late-render / render-failed).
   *  A late-render whose push/render had already timed out, its fallback
   *  materialized, is recorded by the connection's wiring rather than the
   *  coalescer: it names `serverId`, `featureSet`, `key` and, for a
   *  channel-scoped subject, `channelId` instead of `subject`, carries a late
   *  JSON-RPC error as `error` (`[code] message`, bounded), and its `eventId`
   *  links it to the batch's render-failed. */
  | (TraceEventBase & {
      type: 'mcpl:coalescing';
      kind: string;
      subject?: string;
      eventId?: string;
      [key: string]: unknown;
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

  // Operator-initiated mutation (rollback/suppress/undo/hide/settings/quiesce…).
  // Mirrors the durable operator-actions.jsonl record so live UIs see the
  // same entry the file keeps.
  | (TraceEventBase & {
      type: 'operator:action';
      agentName?: string;
      kind: string;
      requester?: { via: string; name?: string; id?: string };
      note?: string;
      params?: Record<string, unknown>;
      result?: Record<string, unknown>;
      error?: string;
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
  // delivered prose segment, and one per publish the subconscious's
  // speak_in_channel delivers (ChannelRegistry.publishForAgent): that one's
  // conversationId is the speaking agent's name, and it carries no
  // messageId. `text` is the segment verbatim — the same content
  // already on the bus chunk-by-chunk via inference:tokens, and mcpl:* traces
  // are 'ops'-scoped on the webui wire — and `messageId` is the surface's id
  // for the posted message (on routeSpeech's traces, when the MCPL server
  // reports one). Together they give external taps the (channelId,
  // messageId, text) tuple needed to edit a just-posted message, e.g. a TTS
  // interruption truncating a reply to the words actually voiced.
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
      /** Surface message id (e.g. Discord message id), when reported, on
       *  routeSpeech's traces. speak_in_channel's carry none. */
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
      /** `failed`: nothing was posted; `unknown`: the request was dispatched
       *  and no valid receipt came back, so it may have been. */
      outcome?: 'failed' | 'unknown';
      /** The connector error's structured data, bounded (connectorText),
       *  when it sent some: it may say what a multi-part send posted. */
      detail?: string;
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
      /** The pair was queued behind a turn that replaced the puppet's
       *  reservation (provider-admission re-entry) instead of stored
       *  directly; it lands at that turn's end flush. */
      deferred?: boolean;
    })

  // MCPL server connection lifecycle (spawn / handshake / reconnect health).
  // Previously these outcomes were visible only on the host process's own
  // stderr, so a server that lost the boot handshake race just went missing.
  | (TraceEventBase & {
      type: 'mcpl:server-connect-failed';
      serverId: string;
      error: string;
      /** The last of the server's stderr, when its handshake failed by its
       *  transport closing, a transport error or its timeout and it had
       *  written any: the server's own text, which `error` never carries. A
       *  transport that failed its handshake was never wired, so its lines
       *  never reached `mcpl:server-stderr`. */
      stderrTail?: string;
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
      /** Why the transport closed, in its own words, such as `child process
       *  exited, and its pipe failed with write EPIPE` or `closed by host`;
       *  null when it gave none, or when its reason is a WebSocket server's
       *  own close text, which stays off the trace. */
      reason: string | null;
      /** True when a background reconnect loop will revive the connection. */
      willReconnect: boolean;
    })
  | (TraceEventBase & {
      type: 'mcpl:server-error';
      serverId: string;
      error: string;
    })
  // Configuration that is accepted but silently does nothing. Each mirrors
  // a console line, so hosts that keep per-server logs from the trace bus
  // see it too.
  | (TraceEventBase & {
      /** §5.3/§6.7: the server refused the host's policy Request. */
      type: 'mcpl:policy-refused';
      serverId: string;
      /** The initial policy at connect, or the re-negotiation after a manifest change. */
      phase: 'initial' | 'manifest-change';
      reason: string | null;
      /** `close`: the host closed the connection. `mcp-only`: the grant
       *  stays empty and only plain MCP tools work. */
      fallback: 'close' | 'mcp-only';
    })
  | (TraceEventBase & {
      /** §6.4 derivation disabled a declared feature set. */
      type: 'mcpl:feature-set-disabled';
      serverId: string;
      featureSet: string;
      /** `invalid_uses`: `uses` absent, empty or unrecognized.
       *  `missing_capabilities`: `uses` names capabilities the grant lacks. */
      reason: 'invalid_uses' | 'missing_capabilities';
      /** True when config selected the set (enabledFeatureSets omitted or
       *  matching it, and not disabledFeatureSets): derivation overrode it. */
      selectedByConfig: boolean;
      /** invalid_uses: the unrecognized entries (empty when `uses` was absent or empty). */
      unrecognized?: string[];
      /** missing_capabilities: the capability paths the grant lacks. */
      missing?: string[];
    })
  | (TraceEventBase & {
      /** An operator tool-name pattern matches no model-facing tool. Emitted
       *  once per pattern, after the servers it could name have listed. */
      type: 'mcpl:tool-pattern-unmatched';
      /** `toolClassOverrides`, `toolLifecycle.observe.tools` or `toolLifecycle.inputs.tools`. */
      setting: string;
      /** The server whose toolLifecycle config holds the pattern. */
      serverId?: string;
      pattern: string;
      /** The pattern rewritten under the server's actual tool prefix. */
      suggestion?: string;
      hint: string;
    })
  | (TraceEventBase & {
      /** An inbound RPC request/notification handler failed: it threw or
       *  rejected, or it resolved after a reply write of its own failed or
       *  after it tried to answer a second time. */
      type: 'mcpl:request-handler-error';
      serverId: string;
      /** Connection event name, e.g. channels-register or push-event. */
      event: string;
      /** The request's id when it is a number, or a string id bounded as the
       *  other texts here are: control, format and line-separator characters
       *  replaced, and cut after 500 code points, with "…" marking the cut.
       *  Absent for a notification, for a request whose id is neither, and
       *  for a request form of mcpl/manifestChanged or
       *  notifications/tools/list_changed, which is answered as it's admitted
       *  and then handled as the notification is. */
      requestId?: string | number;
      /** Whether a reply write of the handler's returned: true once one
       *  did. On a connection that had already closed, that write dropped
       *  the reply, as the connection then drops every reply, so nothing
       *  reached the server. A write that throws, as one that can't be
       *  encoded does, sends nothing. When it's false and the responder
       *  can send an error reply (it has respondError), the host sent -32603
       *  "Internal error" itself, or -32000 while it stops, unless
       *  `responseError` says that reply failed. A connection that has
       *  already closed drops that reply, as it drops every reply, with no
       *  `responseError`. */
      responseAttempted: boolean;
      /** The handler's own error when it threw or rejected; otherwise the
       *  reply write that failed and that it swallowed, or that it tried to
       *  answer a second time. */
      error: string;
      /** A reply write that failed, when the handler then failed with an
       *  error of its own (which is `error`). */
      responseFailure?: string;
      /** What the handler tried to send after a reply was already attempted:
       *  refused, never written. A result, or an error reply with its code
       *  and (bounded) message. */
      refusedResponse?: { kind: 'result' } | { kind: 'error'; code: number; message: string };
      /** Failure while trying to send the internal-error response. */
      responseError?: string;
    })
  | (TraceEventBase & {
      type: 'mcpl:orphaned-response';
      serverId: string;
      /** The JSON-RPC id of the late response, whose request had already timed out or been ended by its transport's close. */
      responseId: string | number;
      /** Original request method when retained for mandatory-deadline visibility. */
      method?: string;
      /** True when the dropped response carried host-managed `state`. */
      hadState: boolean;
      /** True when the dropped response carried a server-managed `checkpoint`. */
      hadCheckpoint: boolean;
      /** A late JSON-RPC error, as `[code] message`, bounded. */
      error?: string;
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
      /** At most 2,000 characters. */
      message: string;
      /** Kind-specific structured payload (mirrors the failures.log record),
       *  bounded field by field as that record is. */
      data?: Record<string, unknown>;
    })

  // Host quiesce/maintenance mode (issue #122)
  | (TraceEventBase & {
      type: 'host:quiesce';
      reason?: string;
      /** Whether all turns settled within the drain window. */
      drained: boolean;
      /** Turns still alive at return (0 unless the drain timed out). */
      activeTurns: number;
      /** Wakes still parked on provider admission at return (see HostModeStatus). */
      parkedAdmissions?: number;
      /** True when undrained turns were force-cancelled (abandon). */
      abandoned?: boolean;
      /** Agents whose turn the abandon had not ended when its grace ran out: a token held with no stream and no check ahead (a puppet tool turn, a store surgery's reservation, a turn finishing its last delivery), or a turn that hadn't reached its next check, the tool-result guard's wait for its speech included. A turn whose stream the abandon cancelled while it was still streaming isn't listed, even one still running when the grace ran out. */
      unabandonable?: string[];
    })
  | (TraceEventBase & {
      type: 'host:resume';
      /** True when a failing feasibility verdict was overridden. */
      forced?: boolean;
      /** Gated inference requests released back to the scheduler. */
      releasedRequests: number;
    })
  | (TraceEventBase & {
      type: 'host:quiesced_boot';
      reason?: string;
      since?: number;
    })

  // Inbound acceptance observation (mcpl/inbound-source.ts): an installed
  // InboundAcceptanceObserver threw. Delivery is unaffected; the observer's
  // own coverage is interrupted for that acceptance.
  | (TraceEventBase & {
      type: 'inbound:observer-failed';
      /** Envelope kind of the acceptance the observer failed on. */
      kind: 'channel' | 'unscoped' | 'surface';
      error: string;
    })

  // Held prose drafts (src/prose-drafts.ts): plain speech kept privately
  // instead of sent; a resident's explicit resend; a deliberate dismissal.
  | (TraceEventBase & {
      type: 'prose:drafts-held';
      agentName: string;
      reason: DraftReason;
      draftIds: string[];
      textLen: number;
    })
  | (TraceEventBase & {
      type: 'prose:draft-resent';
      agentName: string;
      draftId: string;
      status: 'delivered' | 'failed' | 'unknown';
      serverId: string;
      channelId: string;
      messageId?: string;
    })
  | (TraceEventBase & {
      type: 'prose:drafts-dismissed';
      agentName: string;
      draftIds: string[];
    });

/**
 * Listener for trace events.
 */
export type TraceEventListener = (event: TraceEvent) => void;
