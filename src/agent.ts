import { NOTICE_TAG } from './notice-tags.js';
import { heartbeatToolAlias } from './heartbeat/heartbeat.js';
import type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock, ThinkingBindingEntry, YieldingStream } from '@animalabs/membrane';
import { isAbortedResponse } from '@animalabs/membrane';
import { streamBounds, type InferenceBounds } from './inference-bounds.js';
import type { CacheWireReceipt, KvUnifiedRequestHooks } from './kv-unified-wire.js';
import { ToolResultGuard } from './tool-result-guard.js';
import { withoutTokenEstimates } from './thinking-token-stamp.js';
import { placeThinkingDrops, type CompiledForRequest, type PlacedDrop } from './thinking-drops.js';
import { carriedBlock, type SentRow } from './sent-rows.js';
import { injectionsAsStored } from './text-as-stored.js';
import { stableHash } from './stable-hash.js';
import { hasRenderedContent, storedInjectionMarkOf } from './stored-injections.js';
import { assertBooleanSetting, holdsSettings, kindOf } from './config-checks.js';
import {
  CONTINUE_ROW,
  continueTurn,
  indexRequestOnlyRows,
  renderRequestOnlyRows,
  silentHeartbeatSeparatorTurn,
  tickKey,
  toolLoopPrompt,
  type RequestOnlyPrompt,
  type RequestOnlyRowIndex,
  type SilentHeartbeatTick,
  type StoredRowLike,
} from './silent-heartbeat.js';
import { randomUUID } from 'node:crypto';
import { resolveClockConfig, type ResolvedClockConfig } from './clock-rows.js';
import {
  nonErrorResultText,
  truncateForHistory,
  DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS,
} from './tool-result-history.js';

export interface ActivationRequestOptions {
  /** The silent heartbeat tick this request answers, if any. */
  silentHeartbeat?: SilentHeartbeatTick;
  /** A request that will never be sent (a preview): compile it as a dry
   *  run (see `compileWithInjections` for what that leaves alone). */
  dryRun?: boolean;
  /** Messages added to the compile's: a preview's stand-in for the context
   *  injections a start would store before its compile
   *  (stored-injections.ts), put where that compile would render them, as
   *  the window's newest rows. A preview stores nothing, so the compile
   *  doesn't weigh them against the budget or shape them as it would the
   *  stored rows. */
  appendedMessages?: NormalizedMessage[];
  /** `false`: the caller retries this stream's failures itself, so membrane
   *  sends a failed round once and hands the error up. The framework's turns
   *  pass it (its errorPolicy is their retry layer); a direct caller of
   *  startStream keeps membrane's retries. */
  membraneRetries?: boolean;
  /** The framework's inferenceBounds, resolved: the stream gets their phase
   *  bounds and flat bound. None when left out. */
  inferenceBounds?: InferenceBounds | null;
}

/** A compile's render stats, as context-manager's `getRenderStats()` types
 *  them; each compile carries its own, where the strategy records them, in
 *  `CompileResult.renderStats`. */
export type RenderStats = NonNullable<ReturnType<ContextManager['getRenderStats']>>;

/** The render stats of the dry compile behind each request a dry run
 *  assembled (`assembleActivationRequest` with `dryRun`), by that request.
 *  A request that is sent has none here. Read through the framework's
 *  `getRequestCompileStats`. */
const dryCompileStats = new WeakMap<object, RenderStats | undefined>();

/** The render stats of the dry compile that built `request`, or null: see
 *  `AgentFramework.getRequestCompileStats`. */
export function dryCompileStatsOf(request: object): RenderStats | null {
  return dryCompileStats.get(request) ?? null;
}

/**
 * What a compile is told when the agent's model binds its thinking: `compile()`'s options for a context manager
 * that keeps a thinking-binding record, as agent-framework holds the binding (with the participant whose messages
 * are the agent's own replies) and as digests of the request's head (bindingCompileOptions).
 */
export interface BindingCompileOptions {
  thinkingBinding?: { binds: boolean; dropBlock: boolean; participant: string };
  identity?: RequestIdentity;
}

export interface StartStreamResult {
  stream: YieldingStream;
  request: NormalizedRequest;
  /** The request-only `[Continue]` prompt this request's reply follows, if
   *  any, read from the request: a new one when it ends on `[Continue]`;
   *  else, when it ends on tool results, or on tool results and then
   *  stored context injections alone, the prompt of the reply that called
   *  those tools (`toolLoopPrompt`); else none. The framework stamps the
   *  reply's rows with it (`metadata.promptedBy`), for later compiles to
   *  render it before them. */
  continuePrompt?: RequestOnlyPrompt;
  takeKvSubmission?: () => { submissionId: string; wireReceipt: CacheWireReceipt } | undefined;
  drainKvSubmissionIds?: () => string[];
  /** Where each block a call of this stream reports the provider dropped came from: a stored reply this
   *  request's compile rendered, a round the stream appended, or neither (placeThinkingDrops). Optional, so a
   *  stand-in for the stream start needn't supply it; without it, no drop can be placed. */
  placeDrops?: (entries: readonly ThinkingBindingEntry[]) => PlacedDrop[];
  /** The compile's `thinkingRecordedAfter`, when it gave one: a reply stored at or below it predates the branch's
   *  thinking-binding record, so the provider may drop its thinking with no strip having missed. */
  thinkingRecordedAfter?: number;
  /** The key (`branchKey`) of the branch the compile read, when its provenance names one. */
  thinkingBranch?: string;
  /** Tells the context manager what the stream's later rounds carried after the compiled messages, every round so
   *  far in sent order, with this request's head (context-manager's `noteRequestSent`). Present only where the
   *  model binds its thinking and the context manager keeps a record it can be told of. */
  noteRequestSent?: (rows: readonly SentRow[]) => boolean;
  /** The stored bodies the request's compile carried, by each body's first message id (its provenance's raw bodies).
   *  Absent when the compile reports no provenance. */
  carriedBodies?: ReadonlySet<MessageId>;
}
import type {
  ContextManager,
  TokenBudget,
  ContextInjection,
  CompileResult,
  HotContextSettingsStatus,
  HotContextSettingsUpdate,
  MessageId,
  MessageMetadata,
  RequestIdentity,
  ThinkingStrip,
} from '@animalabs/context-manager';
import type {
  AgentConfig,
  AutoContinueConfig,
  AgentState,
  SameRoundThinkTextPolicy,
  SameRoundThinkTextPolicySource,
  PendingToolCall,
  CompletedToolCall,
  ToolCallId,
  ToolCall,
  ToolResult,
  ToolDefinition,
  AgentInfo,
  InferenceResult,
  InferenceOptions,
  AgentRuntimeSettingsPatch,
  AgentRuntimeSettingsSnapshot,
  AgentRuntimeSettingsOverrides,
} from './types/index.js';


/**
 * Whether a request's messages, as sanitized, end on `agentName`'s own
 * message, apart from `injectionTail` stored context injections after it
 * (counted over the messages the sanitizer keeps).
 */
function endsOnOwnMessage(messages: NormalizedMessage[], agentName: string, injectionTail: number): boolean {
  const own = messages[messages.length - 1 - injectionTail];
  return own !== undefined && own.participant === agentName
    && messages.slice(messages.length - injectionTail).every((m) => m.participant.startsWith('system_context:'));
}

/** A digest of a value as a request's JSON carries it (a field whose value is undefined left out, as the wire leaves
 *  it out), key order aside: the head digests the thinking binding compares, so a change on the wire changes one. */
function wireDigest(value: unknown): string {
  return stableHash(JSON.parse(JSON.stringify(value) ?? 'null'));
}

const DEFAULT_CONTEXT_BUDGET_TOKENS = 100_000;
const DEFAULT_TRANSITION_PACE_TOKENS = 16_000;
const DEFAULT_SAME_ROUND_THINK_TEXT_POLICY: SameRoundThinkTextPolicy = 'public';
const TURN_INPUTS_PIN = 'agent-framework:turn-inputs';

export function assertThinkingBinding(setting: string, value: AgentConfig['thinkingBinding']): void {
  if (holdsSettings(setting, value, '{ binds: true, dropBlock: true }')) {
    assertBooleanSetting(
      `${setting}.dropBlock`,
      value.dropBlock,
      'true asks the provider to drop a signed thinking block whose earlier conversation changed rather than refuse the request, ' +
        'and false or leaving it out sends nothing, so the account\'s default applies',
    );
    assertBooleanSetting(
      `${setting}.binds`,
      value.binds,
      'true says the model binds its signed thinking to the conversation before it, so each compile tells the context manager so, ' +
        'and false or leaving it out compiles as before',
    );
  }
}

/**
 * Refuse an agent config whose `promptCaching`, `toolResultGuard`,
 * `toolWrapperProseGuard`, `thinking.enabled`, `thinkingBinding.dropBlock`,
 * `thinkingBinding.binds` or `refusalHandling.autoRewind` holds anything but true or false
 * (assertBooleanSetting, where null counts as left out), or whose `thinking`, `thinkingBinding` or
 * `refusalHandling` is anything but an object, null or false (holdsSettings),
 * or whose `autoContinue` resolveAutoContinue refuses. The constructor runs it
 * first, so the rule holds wherever an Agent is built. `create()` also runs it
 * for each of its agents before anything opens, and `createEphemeralAgent`
 * before it reserves the name, so a refusal there leaves nothing behind.
 * Membrane reads `thinking.enabled`, and the refusal is here because the
 * setting is AgentConfig's.
 */
export function assertAgentSwitches(config: AgentConfig): void {
  const agent = `Agent "${config.name}"`;
  assertBooleanSetting(
    `${agent} promptCaching`,
    config.promptCaching,
    'true or leaving it out marks requests for prompt caching, and false leaves the markers off, for transports that refuse them',
  );
  if (holdsSettings(`${agent} thinking`, config.thinking, '{ enabled: true }')) {
    assertBooleanSetting(
      `${agent} thinking.enabled`,
      config.thinking.enabled,
      'true asks the provider for extended thinking, and false or leaving it out doesn\'t',
    );
  }
  assertThinkingBinding(`${agent} thinkingBinding`, config.thinkingBinding);
  if (holdsSettings(`${agent} refusalHandling`, config.refusalHandling, '{ autoRewind: true }')) {
    assertBooleanSetting(
      `${agent} refusalHandling.autoRewind`,
      config.refusalHandling.autoRewind,
      'true redacts the turn that tripped a refusal and runs again, up to maxRewinds times, ' +
        'and false or leaving it out doesn\'t',
    );
  }
  assertBooleanSetting(
    `${agent} toolResultGuard`,
    config.toolResultGuard,
    'true turns on tool-output admission, with one guarded retry after a provider refusal, ' +
      'and false or leaving it out doesn\'t',
  );
  assertBooleanSetting(
    `${agent} toolWrapperProseGuard`,
    config.toolWrapperProseGuard,
    'true keeps a response whose whole prose is a tool-call-shaped wrapper from running or entering the agent\'s history, ' +
      'and false or leaving it out doesn\'t',
  );
  resolveAutoContinue(config);
}

/** `AutoContinueConfig.maxConsecutive` when left out. */
export const DEFAULT_AUTO_CONTINUE_MAX = 3;
/** The most continuations in a row a config may ask for. */
const MAX_AUTO_CONTINUE_MAX = 20;

/**
 * `AgentConfig.autoContinue` resolved: undefined when off (left out, null or
 * false), else its cap. `true` takes the default cap; an object takes
 * `maxConsecutive`, a whole number from 1 to 20 (the default when left out).
 * Any other value is refused.
 */
export function resolveAutoContinue(config: AgentConfig): { maxConsecutive: number } | undefined {
  const setting = `Agent "${config.name}" autoContinue`;
  const value: unknown = config.autoContinue;
  if (value === true) return { maxConsecutive: DEFAULT_AUTO_CONTINUE_MAX };
  if (value !== undefined && value !== null && value !== false && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(
      `${setting} must be true, false or an object such as { maxConsecutive: 3 }, not ${kindOf(value)}` +
        (typeof value === 'string' ? ' (true and false go unquoted)' : ''),
    );
  }
  if (!holdsSettings(setting, value as AgentConfig['autoContinue'], '{ maxConsecutive: 3 }')) return undefined;
  const max = (value as AutoContinueConfig).maxConsecutive;
  if (max === undefined) return { maxConsecutive: DEFAULT_AUTO_CONTINUE_MAX };
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > MAX_AUTO_CONTINUE_MAX) {
    // The value's kind, never the value (config-checks): a `${VAR}` that
    // lands here could be a credential.
    const kind = typeof max !== 'number' ? kindOf(max)
      : !Number.isInteger(max) ? 'a number that isn\'t whole'
        : max < 1 ? 'a number below 1' : `a number above ${MAX_AUTO_CONTINUE_MAX}`;
    throw new Error(
      `${setting}.maxConsecutive must be a whole number from 1 to ${MAX_AUTO_CONTINUE_MAX}, not ${kind}: ` +
        'the most turns in a row that continue without skip_reply before the agent waits for the next event',
    );
  }
  return { maxConsecutive: max };
}

export function branchKey(branch: { readonly id: string; readonly created: number }): string {
  return `${branch.id}\u0000${branch.created}`;
}

/**
 * An agent wraps a context manager and manages inference state.
 */
export class Agent {
  readonly name: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly allowedTools: 'all' | string[];
  readonly triggerSources: 'all' | string[];
  readonly maxTokens: number;
  /**
   * Sampling temperature. Optional — if undefined, the parameter is omitted
   * from the inference request entirely. Required for newer Anthropic models
   * (claude-opus-4-7+) that have deprecated the `temperature` parameter and
   * return HTTP 400 if it's set, even to 1.
   */
  readonly temperature: number | undefined;
  /**
   * Extended thinking config. When set with `enabled: true`, Membrane will
   * request native thinking from the provider. Signatures on response thinking
   * blocks are preserved through Chronicle.
   */
  readonly thinking: AgentConfig['thinking'];
  /** Whether requests ask the provider to drop signed thinking whose earlier
   *  conversation changed (see AgentConfig.thinkingBinding.dropBlock). */
  private readonly thinkingDropBlock: boolean;
  /** Whether the model binds its signed thinking to the conversation before
   *  it (see AgentConfig.thinkingBinding.binds). */
  private readonly thinkingBinds: boolean;
  /** Refusal auto-rewind policy (see AgentConfig.refusalHandling). */
  readonly refusalHandling: AgentConfig['refusalHandling'];
  readonly toolResultGuard: ToolResultGuard;
  /** Prose delivery mode (see AgentConfig.proseRouting). Default 'locus'. */
  readonly proseRouting: 'locus' | 'explicit' | 'hybrid' | 'disabled';
  /** Exact whole-response known-tool wrapper containment (default off). */
  readonly toolWrapperProseGuard: boolean;
  /** Continuation after a turn the model ends itself (see
   *  AgentConfig.autoContinue); undefined when off. */
  readonly autoContinue: { maxConsecutive: number } | undefined;
  /** Clock rows' interval and precision (see AgentConfig.clock); undefined
   *  when the agent writes none of its own (a resident still reads those
   *  another resident writes into the shared slot). */
  readonly clock: ResolvedClockConfig | undefined;
  /** Prompt-cache TTL forwarded to the provider (see AgentConfig.cacheTtl). */
  readonly cacheTtl: NonNullable<AgentConfig['cacheTtl']>;
  /** Emit prompt-cache markers on requests (see AgentConfig.promptCaching). */
  readonly promptCaching: boolean;
  /** Prefill scaffold user message (see AgentConfig.prefillUserMessage). */
  readonly prefillUserMessage?: string;
  /** Provider-specific request parameters forwarded unchanged by Membrane. */
  readonly providerParams?: Record<string, unknown>;
  readonly sameRoundThinkTextPolicy: AgentConfig['sameRoundThinkTextPolicy'];
  /** The participant name this agent's turns are presented under (see AgentConfig.presentAs). */
  readonly presentAs: string;
  /** Stored participants presented as this agent's own turns: its name plus AgentConfig.selfParticipants. */
  private readonly ownParticipants: ReadonlySet<string>;
  private readonly deniedAtDispatch: ReadonlySet<string>;

  private _state: AgentState = { status: 'idle' };
  private _inferenceStartedAt = 0;
  private _streamId = 0;
  /** kv-unified receipt flights opened by the CURRENT activation and not yet
   * settled by a usage event. Held on the agent (not only in the stream's
   * closure) so the next activation can close whatever its predecessor left
   * open — see failOpenKvSubmissions. */
  private kvOpenQueue: Array<{ submissionId: string; wireReceipt: CacheWireReceipt }> | null = null;
  /** The current stream's fresh input so far, as membrane's usage event
   *  reports it (cumulative across the tool loop): what the maxStreamTokens
   *  budget checks. */
  lastStreamInputTokens = 0;
  /** Real prompt size of the stream's latest provider call that reported a
   *  prompt, which is what the provider billed it: fresh + cache creation +
   *  cache read. A call that reports none leaves it as it was (see
   *  lastStreamUnreportedTokens). Membrane's usage events are cumulative, so
   *  this is the call's share of its event (cumulativeDelta): the whole event
   *  for a stream's first call, and the event's own value where a counter
   *  went back. THE window-shaped number — `lastStreamInputTokens` alone
   *  omits cached tokens, which are most of a warm stream's window. 0 until a
   *  call on this stream reports a prompt, and the physical-window
   *  projection runs only once one has. */
  lastStreamRealInputTokens = 0;
  /** Output tokens of the same call as lastStreamRealInputTokens, or
   *  maxTokens, the bound on them, when it reported none (a call that ends at
   *  a tool boundary wrote a tool_use, so a 0 is a count left unreported) —
   *  the prior round's generated thinking/text/tool_use, which becomes part
   *  of the NEXT round's input and so belongs in the physical-window
   *  projection. */
  lastStreamOutputTokens = 0;
  /** What the stream has grown by since the call lastStreamRealInputTokens
   *  describes, for the physical-window projection: the blocks appended at
   *  each boundary the stream continued past (counted only for an agent with
   *  physicalWindowTokens, whose projection is this field's one reader), and
   *  the output of each call that reported no prompt (its reported output,
   *  or maxTokens, the bound on it, when it reported none either). After
   *  calls that report no prompt, the next request holds the prompt and
   *  output of the call lastStreamRealInputTokens describes, plus this. 0 at
   *  stream start and whenever a call reports a prompt. */
  lastStreamUnreportedTokens = 0;
  maxStreamTokens: number;
  /** Provider hard context cap (see AgentConfig.physicalWindowTokens). */
  readonly physicalWindowTokens?: number;
  /** Per-agent context compile budget (input tokens). When unset, the
   * ContextManager's built-in default applies. reserveForResponse uses
   * this agent's maxTokens. */
  contextBudgetTokens?: number;
  private readonly configuredContextBudgetTokens?: number;
  private readonly configuredTailTokens?: number;
  private readonly configuredTransitionPaceTokens?: number;
  private readonly configuredSameRoundThinkTextPolicy?: SameRoundThinkTextPolicy;
  private contextBudgetTargetTokens?: number;
  private runtimeSettingsOverrides: AgentRuntimeSettingsPatch = {};
  /**
   * Counts changes of the live budget (an update, a reset, a restore, a
   * settle). A compile speaks for the budget it planned at only if the live
   * budget didn't change while it ran, and what it showed stands only until
   * the next change.
   */
  private liveBudgetEpoch = 0;
  /**
   * Counts changes of the descent (each arm of one, the same target included,
   * a reset, a cancel, a settle). A settle proves its target only to a
   * compile that began under that same descent.
   */
  private descentEpoch = 0;
  /** The live budget the last compile planned at, whether it fit, and the live budget's epoch then. */
  private lastCompiledBudget?: { budget: number; fit: boolean; epoch: number };
  /** Counts compiles at the live budget as they start. */
  private compilesStarted = 0;
  /** The start numbers of the compiles at the live budget still running. */
  private readonly compilesRunning = new Set<number>();
  /**
   * For each budget, the start of the latest-started compile that has ended
   * there with a fit or a refusal, whether or not what it showed was
   * credited. Of two compiles at one budget, the later-started one planned
   * at the newer store, so an earlier-started one that ends after it is
   * ignored. That rests on the context manager selecting at the start of
   * `compile`, before anything it awaits, so start order is selection order;
   * a context manager that awaits before its select breaks it. (Injections
   * are added after the select, so compiles with and without them plan
   * alike.) An entry is
   * kept only while a compile that started before it is still running, the
   * only kind it can turn away, so the map is empty whenever no compile
   * runs.
   */
  private readonly latestEndedStart = new Map<number, number>();
  /** The last outcome the listener recorded; a failed record is told again, and so is any after a change. */
  private recordedCompiledBudget?: { budget: number; fit: boolean; epoch: number };
  /**
   * A boot restore applied a proven budget below the live one at once. Until
   * the budget is next written (an update that carries one, or a reset of
   * it) or a compile at it fits, a refusal of a compile at it restores it
   * paced instead.
   */
  private restoredAtOnce = false;
  /** Told when that changes (the framework records it beside the persisted budget). */
  private compiledBudgetListener?: (budget: number, fit: boolean) => boolean;
  private contextManager: ContextManager;
  private membrane: Membrane;

  constructor(
    config: AgentConfig,
    contextManager: ContextManager,
    membrane: Membrane
  ) {
    assertAgentSwitches(config);
    this.name = config.name;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools ?? 'all';
    this.triggerSources = config.triggerSources ?? 'all';
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature;
    this.thinking = config.thinking;
    this.thinkingDropBlock = config.thinkingBinding?.dropBlock === true;
    this.thinkingBinds = config.thinkingBinding?.binds === true;
    this.refusalHandling = config.refusalHandling;
    this.toolResultGuard = new ToolResultGuard(config.name, contextManager, config.toolResultGuard === true);
    this.proseRouting = config.proseRouting ?? 'locus';
    this.toolWrapperProseGuard = config.toolWrapperProseGuard === true;
    this.autoContinue = resolveAutoContinue(config);
    this.clock = resolveClockConfig(config.name, config.clock);
    this.cacheTtl = config.cacheTtl ?? '1h';
    this.promptCaching = config.promptCaching !== false;
    this.prefillUserMessage = config.prefillUserMessage;
    this.providerParams = config.providerParams;
    this.sameRoundThinkTextPolicy = config.sameRoundThinkTextPolicy;
    this.presentAs = config.presentAs ?? config.name;
    this.ownParticipants = new Set([config.name, ...(config.selfParticipants ?? [])]);
    this.deniedAtDispatch = new Set(config.denyToolsAtDispatch ?? []);
    this.maxStreamTokens = config.maxStreamTokens ?? 150_000;
    // The window size converted as the projection's comparison (`projected > window`) converts it, so a string such
    // as "200000" from a JSON or YAML config is its number, for every rule that reads it. A value whose number isn't
    // finite is no window: null, NaN and Infinity, which the comparison never passed, and -Infinity, which it always
    // did, a restart at every boundary.
    const window = config.physicalWindowTokens == null ? NaN : Number(config.physicalWindowTokens);
    this.physicalWindowTokens = Number.isFinite(window) ? window : undefined;
    this.contextBudgetTokens = config.contextBudgetTokens;
    this.configuredContextBudgetTokens = config.contextBudgetTokens;
    this.contextManager = contextManager;
    this.membrane = membrane;
    const hot = this.getHotContextSettings();
    this.configuredTailTokens = hot?.tailTokens;
    this.configuredTransitionPaceTokens = hot?.transitionPaceTokens;
    this.configuredSameRoundThinkTextPolicy = config.sameRoundThinkTextPolicy;
  }

  /**
   * Get current agent state.
   */
  get state(): AgentState {
    return this._state;
  }

  /**
   * Monotonically increasing stream generation counter.
   * Used to guard stale driveStream handlers after a budget restart.
   */
  get streamId(): number {
    return this._streamId;
  }

  /**
   * Get agent info.
   */
  get info(): AgentInfo {
    return {
      name: this.name,
      model: this.model,
      status: this._state.status,
    };
  }

  /**
   * Check if agent can use a specific tool.
   */
  canUseTool(toolName: string): boolean {
    if (this.allowedTools === 'all') {
      return true;
    }
    if (this.allowedTools.includes(toolName)) return true;
    // A heartbeat tool is one tool under either prefix: the framework's
    // `heartbeat--x` and heartbeat-mcpl's `mcpl--heartbeat--x`, which an
    // allowedTools written for the server names. Only one of them is ever
    // offered, since the framework refuses the server beside its heartbeat.
    const alias = heartbeatToolAlias(toolName);
    return alias !== undefined && this.allowedTools.includes(alias);
  }

  /**
   * Whether a call to an advertised tool is refused at dispatch
   * (see AgentConfig.denyToolsAtDispatch).
   */
  deniesAtDispatch(toolName: string): boolean {
    return this.deniedAtDispatch.has(toolName);
  }

  /** Whether a stored participant is this agent's own voice. */
  isOwnParticipant(participant: string): boolean {
    return this.ownParticipants.has(participant);
  }

  /**
   * Role assignment for a request: every participant that is this agent's
   * own voice — its name, and for a derived agent the agent it inherited
   * from — is presented under one name, which the formatter maps to the
   * assistant role. Stored authorship is untouched; this shapes the request
   * only. For a plain agent (no selfParticipants, presentAs = name) the
   * input is returned as is.
   */
  private presentOwnTurns(messages: NormalizedMessage[]): NormalizedMessage[] {
    if (this.ownParticipants.size === 1 && this.presentAs === this.name) return messages;
    return messages.map((m) =>
      this.ownParticipants.has(m.participant) && m.participant !== this.presentAs
        ? { ...m, participant: this.presentAs }
        : m,
    );
  }

  /**
   * Check if a source can trigger inference for this agent.
   */
  canBeTriggeredBy(source: string): boolean {
    if (this.triggerSources === 'all') {
      return true;
    }
    return this.triggerSources.includes(source);
  }

  // ==========================================================================
  // Composable Steps
  // ==========================================================================

  /**
   * Compile the context without injections.
   * Step 1 of the inference pipeline — callers can inspect/modify the result
   * before building a request.
   */
  /** Resolve the compile budget: explicit arg wins, else the per-agent
   * configured context budget (if any), else the ContextManager default. */
  private resolveBudget(budget?: TokenBudget): TokenBudget | undefined {
    if (budget) return budget;
    if (this.contextBudgetTokens === undefined) return undefined;
    return { maxTokens: this.contextBudgetTokens, reserveForResponse: this.maxTokens };
  }

  /** Compile budget with the tool-result guard's reservation applied. While
   * a batch is pending the strategy selects against short placeholders, but
   * prepareRequest substitutes the originals on the wire; reserve their real
   * cost so the final request still fits (a budget restart that recompiles
   * small must not re-inflate past the same window). */
  private compileBudget(budget?: TokenBudget): TokenBudget | undefined {
    const resolved = this.resolveBudget(budget);
    const reserve = this.toolResultGuard.pendingWireReserveTokens;
    if (reserve === 0) return resolved;
    // Mirrors ContextManager.compile's own default when no budget is set.
    const base = resolved ?? { maxTokens: 100_000, reserveForResponse: 4_000 };
    return { ...base, reserveForResponse: base.reserveForResponse + reserve };
  }

  /** Structural compatibility keeps lightweight test/host ContextManager
   * doubles working while making the new capability optional at runtime. */
  private getHotContextSettings(): HotContextSettingsStatus | null {
    const manager = this.contextManager as ContextManager & {
      getHotContextSettings?: () => HotContextSettingsStatus | null;
    };
    return typeof manager.getHotContextSettings === 'function'
      ? manager.getHotContextSettings()
      : null;
  }

  private updateHotContextSettings(update: HotContextSettingsUpdate): HotContextSettingsStatus {
    const manager = this.contextManager as ContextManager & {
      updateHotContextSettings?: (value: HotContextSettingsUpdate) => HotContextSettingsStatus;
    };
    if (typeof manager.updateHotContextSettings !== 'function') {
      throw new Error('The active context strategy does not support live context settings');
    }
    return manager.updateHotContextSettings(update);
  }

  getRuntimeSettings(): AgentRuntimeSettingsSnapshot {
    const hot = this.getHotContextSettings();
    return {
      // The budget it's set to: the override, where there is one. That is
      // the target of a descent toward it, or else the live budget, except
      // while it's kept unapplied: at boot (keepRuntimeSettings), or after a
      // refused at-once budget couldn't be restored paced (compileAtLiveBudget).
      contextBudgetTokens:
        this.runtimeSettingsOverrides.contextBudgetTokens ??
        this.contextBudgetTargetTokens ??
        this.contextBudgetTokens ??
        DEFAULT_CONTEXT_BUDGET_TOKENS,
      effectiveContextBudgetTokens: this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      ...(hot ? { tailTokens: hot.tailTokens } : {}),
      ...(hot?.transitionPaceTokens !== undefined
        ? { transitionPaceTokens: hot.transitionPaceTokens }
        : {}),
      sameRoundThinkTextPolicy: this.getEffectiveSameRoundThinkTextPolicy(),
      sameRoundThinkTextPolicySource: this.getSameRoundThinkTextPolicySource(),
      transition: this.contextBudgetTargetTokens === undefined
        ? 'stable'
        : hot?.blocked
          ? 'blocked'
          : 'converging',
      ...(hot?.blocked === 'transition-pace-floor'
        ? { transitionReason: 'transition_pace_too_small' as const }
        : hot?.blocked === 'prepared-window-floor'
          ? { transitionReason: 'protected_context_exceeds_target' as const }
          : {}),
    };
  }

  getRuntimeSettingsOverrides(): AgentRuntimeSettingsOverrides {
    return { ...this.runtimeSettingsOverrides };
  }

  /**
   * Set (or clear) the one listener told when a compile at the live budget
   * comes out differently from the last: it fit at a budget the last one
   * didn't plan at (after a settle, the target), or the context manager
   * refused a budget the last one fit at.
   */
  onContextBudgetCompiled(listener: ((budget: number, fit: boolean) => boolean) | undefined): void {
    this.compiledBudgetListener = listener;
  }

  /**
   * The live budget the last compile planned at and fit, if it fit and the
   * live budget hasn't changed since.
   */
  getProvenContextBudgetTokens(): number | undefined {
    const last = this.lastCompiledBudget;
    return last?.fit && last.epoch === this.liveBudgetEpoch ? last.budget : undefined;
  }

  /**
   * Set the live budget and the descent target, counting a change of each.
   * `armed` counts a descent armed here as a change even when its target is
   * the one already set: a compile that began under the earlier arm isn't
   * credited with this one's settle.
   */
  private setContextBudget(budget: number | undefined, target: number | undefined, armed = false): void {
    if (budget !== this.contextBudgetTokens) this.liveBudgetEpoch++;
    if (armed || target !== this.contextBudgetTargetTokens) this.descentEpoch++;
    this.contextBudgetTokens = budget;
    this.contextBudgetTargetTokens = target;
  }

  /**
   * Claim the place of the latest compile to end at `budget` for the one that
   * started as the `started`th, and say whether it got it: a compile that
   * started before one that has already ended there is ignored, whichever
   * finishes last.
   */
  private claimLatestAt(budget: number, started: number): boolean {
    if (started < (this.latestEndedStart.get(budget) ?? 0)) return false;
    this.latestEndedStart.set(budget, started);
    return true;
  }

  /**
   * Note what a compile at `budget`, planned at the live budget's `epoch`,
   * showed. It speaks for the live budget only if that hasn't changed since;
   * the listener is told either way, so a refusal withdraws the record's
   * marker for the budget it planned at whatever changed meanwhile.
   */
  private noteCompiledBudget(budget: number, fit: boolean, epoch: number): void {
    if (epoch === this.liveBudgetEpoch) this.lastCompiledBudget = { budget, fit, epoch };
    const recorded = this.recordedCompiledBudget;
    if (recorded?.budget === budget && recorded.fit === fit && recorded.epoch === epoch) return;
    // A listener that couldn't record it returns false: nothing is assumed
    // recorded then, so the next compile tells it again whatever it shows.
    this.recordedCompiledBudget = this.compiledBudgetListener?.(budget, fit) !== false ? { budget, fit, epoch } : undefined;
  }

  /** Compile at the live budget (no explicit one), noting whether it fit. */
  private async compileAtLiveBudget(compile: () => Promise<CompileResult>): Promise<CompileResult> {
    const started = ++this.compilesStarted;
    this.compilesRunning.add(started);
    try {
      return await this.compileAtLiveBudgetNoting(compile, started);
    } finally {
      this.compilesRunning.delete(started);
      const earliest = Math.min(...this.compilesRunning);
      for (const [budget, start] of this.latestEndedStart) {
        if (start < earliest) this.latestEndedStart.delete(budget);
      }
    }
  }

  /** The compile at the live budget that started as the `started`th, and what it showed. */
  private async compileAtLiveBudgetNoting(compile: () => Promise<CompileResult>, started: number): Promise<CompileResult> {
    // The budget this compile plans at, and the descent under way when it
    // started: a change of either while it runs is no part of what it shows.
    const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
    const epoch = this.liveBudgetEpoch;
    const descent = this.descentEpoch;
    let result: CompileResult;
    try {
      result = await compile();
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'OverBudgetError') throw error;
      // A refusal shows the budget it planned at doesn't fit, whatever
      // changed while it ran: the record's marker for it is withdrawn, and
      // nothing is credited, unless a compile that started later has already
      // ended at that budget.
      if (this.claimLatestAt(live, started)) this.noteCompiledBudget(live, false, epoch);
      // A budget a boot restore applied at once, refused at its first test,
      // before anything wrote the budget: restore it paced instead, as the
      // boot would have without its proof, and compile again from the
      // recipe's budget. (While restoredAtOnce holds, the live budget is the
      // one the boot applied: every write of the budget clears it, and no
      // compile runs before the boot's restore.)
      if (!this.restoredAtOnce) throw error;
      this.restoredAtOnce = false;
      // The persisted budget stays in the overrides, so if it can't be
      // restored paced, no later write erases it.
      this.setContextBudget(this.configuredContextBudgetTokens, undefined);
      let outcome: string;
      try {
        this.updateRuntimeSettings({ contextBudgetTokens: live });
        outcome = 'restored it as a paced descent from the recipe\'s budget';
      } catch (fallback) {
        outcome = `couldn't restore it paced (${fallback instanceof Error ? fallback.message : String(fallback)}), ` +
          `so it compiles at the recipe's budget, with contextBudgetTokens=${live} kept set`;
      }
      console.error(
        `[agent-settings] ${this.name}: the context manager refused contextBudgetTokens=${live}, which the boot ` +
          `applied at once; ${outcome}`,
      );
      return this.compileAtLiveBudget(compile);
    }
    this.restoredAtOnce = false;
    // A settle, here, of the descent this compile began under proves its
    // target: the frontier fits the window prepared for it. Without a settle,
    // the compile proves the budget it planned at. Either only if the live
    // budget didn't change while it ran; a settle of a descent armed while it
    // ran proves nothing (the next compile at the target does).
    // A compile that ends here with a fit takes its place in the start order
    // at the budget it planned at, credited or not; a settle credits its
    // target only from the latest compile to end there.
    const latest = this.claimLatestAt(live, started);
    const sameLive = this.liveBudgetEpoch === epoch;
    const sameDescent = this.descentEpoch === descent;
    const settled = this.settleRuntimeSettingsTransition();
    if (latest && sameLive && settled && sameDescent && this.claimLatestAt(this.contextBudgetTokens!, started)) {
      this.noteCompiledBudget(this.contextBudgetTokens!, true, this.liveBudgetEpoch);
    } else if (latest && sameLive && !settled) this.noteCompiledBudget(live, true, epoch);
    return result;
  }

  /**
   * The budget compiles plan at, the path a patch's budget takes from it, and
   * whether a descent is in flight, from the agent's own state alone: what a
   * runtime-settings preview can still say while the context manager refuses
   * its queries.
   * @internal For the framework's runtime-settings preview; not a host API.
   */
  runtimeBudgetPath(patch?: AgentRuntimeSettingsPatch): {
    liveBudgetTokens: number;
    path: 'immediate' | 'paced' | 'none';
    transition: 'stable' | 'converging';
  } {
    const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
    const budget = patch?.contextBudgetTokens;
    return {
      liveBudgetTokens: live,
      path: budget === undefined ? 'none' : budget >= live || patch?.immediate ? 'immediate' : 'paced',
      transition: this.contextBudgetTargetTokens === undefined ? 'stable' : 'converging',
    };
  }

  /**
   * Whether the context manager answers its queries, as its readiness says.
   * It refuses them while its strategy's initialization is pending or has
   * failed, until a switchBranch or setStrategy succeeds, and a strategy can
   * refuse its readiness on its own, as the autobiographical one does for a
   * branch it hasn't reloaded.
   * @internal For the framework's runtime-settings preview; not a host API.
   */
  contextManagerAnswers(): boolean {
    try {
      this.contextManager.isReady();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read-only mirror of `updateRuntimeSettings`' budget semantics: derive what
   * the next compile would actually plan at if `patch` were applied, WITHOUT
   * mutating anything. This is the settings→config mapping a feasibility
   * preview must share with the live path — previewing `patch.contextBudgetTokens`
   * directly models the wrong compile for a paced descent (a non-immediate
   * decrease never changes the compile budget; it only arms a prepared-window
   * transition — see the else-branch in updateRuntimeSettings).
   *
   * - `path: 'immediate'` — the patch changes the compile budget (increase, or
   *   decrease with `immediate: true`); `effectiveBudgetTokens` = patch value.
   * - `path: 'paced'` — non-immediate decrease; `effectiveBudgetTokens` stays
   *   at the live budget and `advisoryTargetTokens` carries the descent target.
   * - `path: 'none'` — patch absent or budget untouched.
   *
   * `overrides` uses strategy-config names (`recentWindowTokens`,
   * `kvStableReachTokens`) suitable for `previewContext`. The reach is the one
   * the next compile plans at (context-manager's kv-stable picker): a
   * descent's pace while a window is prepared for it, one this patch arms (a
   * paced decrease) or one in flight that it leaves alone (a patch without a
   * budget), and the configured reach otherwise. Config is a preview's only
   * lever: `preparedWindowTokens` and the live runtime pace are strategy
   * instance state, which a preview can't set. So a preview taken during a
   * descent plans under that descent's prepared window, and at its live pace
   * whenever the strategy carries one, which the picker reads before the
   * configured reach. A boot restore's preflight never meets this: a new
   * strategy has no window.
   */
  planRuntimeSettings(patch?: AgentRuntimeSettingsPatch): {
    effectiveBudgetTokens: number;
    /** The budget compiles currently plan at — the baseline the patch moves
     *  from. Lets callers distinguish a lowering from a no-op or an increase
     *  (an increase on an already-wedged agent never makes things worse). */
    liveBudgetTokens: number;
    advisoryTargetTokens?: number;
    path: 'immediate' | 'paced' | 'none';
    overrides: Record<string, unknown>;
  } {
    if (patch && Object.keys(patch).length > 0) {
      this.validateRuntimeSettingsPatch(patch);
    }
    const hot = this.getHotContextSettings();
    const { liveBudgetTokens: live, path } = this.runtimeBudgetPath(patch);
    const budget = patch?.contextBudgetTokens;

    const overrides: Record<string, unknown> = {};
    if (patch?.tailTokens !== undefined) {
      overrides.recentWindowTokens = patch.tailTokens;
    }
    // A window is prepared at the next compile when this patch arms a
    // descent, or leaves one in flight alone; an immediate change clears it.
    const prepared = hot !== null && (path === 'paced' || (path === 'none' && hot.preparedWindowTokens !== undefined));
    const reach = prepared
      ? patch?.transitionPaceTokens ?? hot.transitionPaceTokens ?? DEFAULT_TRANSITION_PACE_TOKENS
      : this.configuredTransitionPaceTokens;
    if (reach !== undefined && reach !== this.configuredTransitionPaceTokens) {
      overrides.kvStableReachTokens = reach;
    }

    if (budget === undefined) {
      return { effectiveBudgetTokens: live, liveBudgetTokens: live, path: 'none', overrides };
    }
    if (path === 'immediate') {
      return { effectiveBudgetTokens: budget, liveBudgetTokens: live, path, overrides };
    }
    return {
      effectiveBudgetTokens: live,
      liveBudgetTokens: live,
      advisoryTargetTokens: budget,
      path: 'paced',
      overrides,
    };
  }

  getEffectiveSameRoundThinkTextPolicy(): SameRoundThinkTextPolicy {
    return this.runtimeSettingsOverrides.sameRoundThinkTextPolicy
      ?? this.configuredSameRoundThinkTextPolicy
      ?? DEFAULT_SAME_ROUND_THINK_TEXT_POLICY;
  }

  getSameRoundThinkTextPolicySource(): SameRoundThinkTextPolicySource {
    if (this.runtimeSettingsOverrides.sameRoundThinkTextPolicy !== undefined) {
      return 'runtime_override';
    }
    if (this.configuredSameRoundThinkTextPolicy !== undefined) {
      return 'recipe';
    }
    return 'compatibility_default';
  }

  updateRuntimeSettings(patch: AgentRuntimeSettingsPatch): AgentRuntimeSettingsSnapshot {
    this.validateRuntimeSettingsPatch(patch);
    let nextContextBudget = this.contextBudgetTokens;
    let nextContextTarget = this.contextBudgetTargetTokens;
    let appliedDefaultPace = false;
    // A paced decrease arms a descent, even to the target already set.
    let armed = false;
    const hotPatch: {
      tailTokens?: number;
      transitionPaceTokens?: number | null;
      preparedWindowTokens?: number | null;
    } = {};
    if (patch.tailTokens !== undefined) hotPatch.tailTokens = patch.tailTokens;
    if (patch.transitionPaceTokens !== undefined) {
      hotPatch.transitionPaceTokens = patch.transitionPaceTokens;
    }

    if (patch.contextBudgetTokens !== undefined) {
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (patch.contextBudgetTokens >= live || patch.immediate) {
        // Increases are always immediate. Decreases take this path only with
        // the explicit `immediate` flag: the next compile plans straight at
        // the new budget — one-shot fold-down, KV invalidation paid this
        // turn — and any in-flight descent is cancelled.
        nextContextBudget = patch.contextBudgetTokens;
        nextContextTarget = undefined;
        if (this.getHotContextSettings()) hotPatch.preparedWindowTokens = null;
      } else {
        const hot = this.getHotContextSettings();
        if (!hot) {
          throw new Error('The active context strategy cannot prepare a smaller window live');
        }
        if (patch.transitionPaceTokens === undefined && hot.transitionPaceTokens === undefined) {
          hotPatch.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
          appliedDefaultPace = true;
        }
        hotPatch.preparedWindowTokens = patch.contextBudgetTokens - this.maxTokens;
        nextContextTarget = patch.contextBudgetTokens;
        armed = true;
      }
    }

    if (Object.keys(hotPatch).length > 0) {
      this.updateHotContextSettings(hotPatch);
    }
    this.setContextBudget(nextContextBudget, nextContextTarget, armed);
    // A budget written here is a decision about it, whatever its value: the
    // boot's at-once fallback (restoredAtOnce) no longer speaks for it.
    if (patch.contextBudgetTokens !== undefined) this.restoredAtOnce = false;
    if (appliedDefaultPace) {
      this.runtimeSettingsOverrides.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
    }
    // Only settings reach the override map: `immediate` is a mode for this
    // apply, and nothing else a caller passes is a setting.
    for (const key of ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens'] as const) {
      if (patch[key] !== undefined) this.runtimeSettingsOverrides[key] = patch[key];
    }
    if (patch.sameRoundThinkTextPolicy !== undefined) {
      this.runtimeSettingsOverrides.sameRoundThinkTextPolicy = patch.sameRoundThinkTextPolicy;
    }
    return this.getRuntimeSettings();
  }

  resetRuntimeSettings(keys?: Array<keyof AgentRuntimeSettingsPatch>): AgentRuntimeSettingsSnapshot {
    const reset = new Set(keys ?? ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens', 'sameRoundThinkTextPolicy']);
    let nextContextBudget = this.contextBudgetTokens;
    let nextContextTarget = this.contextBudgetTargetTokens;
    // A reset to a recipe budget below the live one arms a descent to it.
    let armed = false;
    const hotPatch: {
      tailTokens?: number;
      transitionPaceTokens?: number | null;
      preparedWindowTokens?: number | null;
    } = {};

    if (reset.has('contextBudgetTokens')) {
      const configured = this.configuredContextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (configured < live) {
        const hot = this.getHotContextSettings();
        if (!hot) throw new Error('The active context strategy cannot prepare a smaller window live');
        hotPatch.preparedWindowTokens = configured - this.maxTokens;
        if (hot.transitionPaceTokens === undefined) {
          hotPatch.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
        }
        nextContextTarget = configured;
        armed = true;
      } else {
        nextContextBudget = this.configuredContextBudgetTokens;
        nextContextTarget = undefined;
        if (this.getHotContextSettings()) hotPatch.preparedWindowTokens = null;
      }
    }
    if (reset.has('tailTokens')) {
      if (this.configuredTailTokens !== undefined) hotPatch.tailTokens = this.configuredTailTokens;
    }
    if (reset.has('transitionPaceTokens') && this.getHotContextSettings()) {
      hotPatch.transitionPaceTokens =
        nextContextTarget !== undefined && this.configuredTransitionPaceTokens === undefined
          ? DEFAULT_TRANSITION_PACE_TOKENS
          : this.configuredTransitionPaceTokens ?? null;
    }
    if (Object.keys(hotPatch).length > 0) this.updateHotContextSettings(hotPatch);
    this.setContextBudget(nextContextBudget, nextContextTarget, armed);
    if (reset.has('contextBudgetTokens')) {
      delete this.runtimeSettingsOverrides.contextBudgetTokens;
      this.restoredAtOnce = false;
    }
    if (reset.has('tailTokens')) delete this.runtimeSettingsOverrides.tailTokens;
    if (reset.has('transitionPaceTokens')) {
      delete this.runtimeSettingsOverrides.transitionPaceTokens;
    }
    if (reset.has('sameRoundThinkTextPolicy')) {
      delete this.runtimeSettingsOverrides.sameRoundThinkTextPolicy;
    }
    return this.getRuntimeSettings();
  }

  cancelRuntimeSettingsTransition(): AgentRuntimeSettingsSnapshot {
    if (this.contextBudgetTargetTokens !== undefined) {
      this.updateHotContextSettings({ preparedWindowTokens: null });
      this.setContextBudget(this.contextBudgetTokens, undefined);
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (live === (this.configuredContextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS)) {
        delete this.runtimeSettingsOverrides.contextBudgetTokens;
      } else {
        this.runtimeSettingsOverrides.contextBudgetTokens = live;
      }
    }
    return this.getRuntimeSettings();
  }

  /**
   * Apply persisted settings at construction. `provenBudget` is a budget the
   * caller has shown fits (the framework, from the record and a preflight),
   * applied at once: it stands as the last compile's until a compile here
   * says otherwise. When it's below the live budget, where the proof is what
   * took the restore off the paced path, a refusal of a compile at it
   * restores it paced instead, until the budget is next written or a compile
   * at it fits. At or above the live budget, the restore is at once either
   * way, and a refusal has nothing to fall back to.
   */
  restoreRuntimeSettings(
    settings: AgentRuntimeSettingsPatch,
    opts?: { provenBudget?: number },
  ): AgentRuntimeSettingsSnapshot {
    if (Object.keys(settings).length === 0) return this.getRuntimeSettings();
    const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
    const snapshot = this.updateRuntimeSettings(settings);
    if (opts?.provenBudget !== undefined) {
      this.lastCompiledBudget = { budget: opts.provenBudget, fit: true, epoch: this.liveBudgetEpoch };
      this.restoredAtOnce = opts.provenBudget < live;
    }
    return snapshot;
  }

  /**
   * Keep a persisted budget, tail or pace that couldn't be applied at
   * construction: it stays in the override map, unapplied, so a later
   * persisting write keeps it in the record. A budget is reported as the one
   * set (`contextBudgetTokens`) beside the one compiles plan at
   * (`effectiveContextBudgetTokens`); a tail or pace stays the strategy's.
   */
  keepRuntimeSettings(settings: Pick<AgentRuntimeSettingsPatch, 'contextBudgetTokens' | 'tailTokens' | 'transitionPaceTokens'>): void {
    for (const key of ['contextBudgetTokens', 'tailTokens', 'transitionPaceTokens'] as const) {
      if (settings[key] !== undefined) this.runtimeSettingsOverrides[key] = settings[key];
    }
  }

  private validateRuntimeSettingsPatch(patch: AgentRuntimeSettingsPatch): void {
    this.checkRuntimeSettingsPatch(patch);
    if ((patch.tailTokens !== undefined || patch.transitionPaceTokens !== undefined) &&
        !this.getHotContextSettings()) {
      throw new Error('The active context strategy does not support live tail/transition settings');
    }
  }

  /**
   * The checks of a runtime-settings patch that need nothing from the context manager.
   * @internal For the framework's runtime-settings preview; not a host API.
   */
  checkRuntimeSettingsPatch(patch: AgentRuntimeSettingsPatch): void {
    if (Object.keys(patch).length === 0) throw new Error('At least one setting is required');
    if (patch.contextBudgetTokens !== undefined) {
      if (!Number.isSafeInteger(patch.contextBudgetTokens) || patch.contextBudgetTokens <= this.maxTokens) {
        throw new Error(`contextBudgetTokens must be a safe integer greater than max response tokens (${this.maxTokens})`);
      }
    }
    if (patch.tailTokens !== undefined &&
        (!Number.isSafeInteger(patch.tailTokens) || patch.tailTokens < 0)) {
      throw new Error('tailTokens must be a non-negative safe integer');
    }
    if (patch.transitionPaceTokens !== undefined &&
        (!Number.isSafeInteger(patch.transitionPaceTokens) || patch.transitionPaceTokens <= 0)) {
      throw new Error('transitionPaceTokens must be a positive safe integer');
    }
    if (patch.sameRoundThinkTextPolicy !== undefined &&
        patch.sameRoundThinkTextPolicy !== 'public' &&
        patch.sameRoundThinkTextPolicy !== 'private') {
      throw new Error("sameRoundThinkTextPolicy must be 'public' or 'private'");
    }
  }

  /** Settle a converging budget once the window is prepared; true if it settled. */
  private settleRuntimeSettingsTransition(): boolean {
    if (this.contextBudgetTargetTokens === undefined) return false;
    const hot = this.getHotContextSettings();
    if (!hot?.prepared) return false;
    this.setContextBudget(this.contextBudgetTargetTokens, undefined);
    this.updateHotContextSettings({ preparedWindowTokens: null });
    return true;
  }

  /**
   * RFC-006 consumed watermark, per branch: the newest stored message as of
   * the latest of the agent's creation, a committing compile that returns,
   * and a tool boundary that injected messages into a live stream declaring
   * it carries them (`supportsInjectedMessages` true: membrane's native
   * path, from membrane 0.6.0). A compile counts from when it takes its
   * value, before it awaits, so one that began before a boundary's mark
   * doesn't roll the mark back (applyCompileWatermark), and a dry run, such
   * as previewActivation's, doesn't move it. Each move takes the store's
   * head, a scalar, so it also covers stored messages the agent wasn't
   * given, such as another slot's.
   *
   * A message above it may still be replaced or withdrawn in place by its
   * sender, though it may already have been in one of the agent's requests.
   * A live stream carries each round's own content and results, which it
   * stores at its tool boundaries, into its next request.
   */
  private consumedWatermark: { branch: string; sequence: number } | null = null;
  /** Counts marks (markContextConsumed's and applyCompileWatermark's), so a
   *  compile that finishes can tell whether one was made while it ran. */
  private watermarkMarks = 0;
  /**
   * The newest stored message a compile or a tool boundary may have put in
   * front of the agent, per branch. It moves where the consumed watermark
   * does, and sooner: when a committing compile takes its value, before it
   * awaits, and at every tool boundary that injects into its stream. A message above it may still
   * have been shown, though: for one, a live stream carries each round's own
   * content and results, stored at a boundary that injected nothing, into its
   * next request. A compile that throws assembled nothing, and gives its move
   * back where it can (unshowFailedCompile). A scalar counts a prefix, so a
   * message stored below it without having been shown counts as shown, which
   * errs toward a marker.
   */
  private shownWatermark: { branch: string; sequence: number } | null = null;

  getConsumedWatermark(): { branch: string; sequence: number } | null {
    return this.consumedWatermark;
  }

  getShownWatermark(): { branch: string; sequence: number } | null {
    return this.shownWatermark;
  }

  /**
   * The newest consumed watermark a request carried that was answered: its
   * round's tool calls, or its completion, came back. A message a boundary
   * injected counts as heard only once a request carrying it is answered;
   * the consumed watermark moves when the stream is handed it, before its
   * request runs, so a request that fails, ending its stream with an error,
   * leaves this as it was.
   */
  private answeredWatermark: { branch: string; sequence: number } | null = null;

  getAnsweredWatermark(): { branch: string; sequence: number } | null {
    return this.answeredWatermark;
  }

  /** A request that carried `watermark` was answered. Requests are answered
   *  in the order they're sent, and the consumed watermark only advances
   *  within a branch, so the latest is the newest. */
  markAnswered(watermark: { branch: string; sequence: number } | null): void {
    if (watermark) this.answeredWatermark = watermark;
  }

  /**
   * Keep the stored rows from `first` through `last` raw for the turn now
   * opening, with a raw pin under one name per agent. Any pin of that name
   * already held is removed first, one a crash left included. Under a
   * strategy without pins nothing is pinned. A committing compile that
   * refuses as over budget while a pin of that name is held removes it and
   * compiles once more, and `unpinTurnInputs` removes it. Returns the pin's
   * id, or undefined when nothing was pinned.
   *
   * @internal For the framework's turn starts; not a host API.
   */
  pinTurnInputs(first: MessageId, last: MessageId): string | undefined {
    if (!this.unpinTurnInputs()) return undefined;
    const cm = this.contextManager;
    if (typeof (cm.getStrategy() as { pinRange?: unknown }).pinRange !== 'function') return undefined;
    try {
      return cm.pinRange(first, last, { name: TURN_INPUTS_PIN });
    } catch (error) {
      console.error(`[turn-inputs] ${this.name}: could not pin the turn's inputs (${first}..${last}), so they may be compressed:`, error);
      return undefined;
    }
  }

  /** Remove the turn's input pin `pinId`, or without one every pin of its
   *  name. False when a removal threw.
   *  @internal For the framework's turn starts and ends; not a host API. */
  unpinTurnInputs(pinId?: string): boolean {
    try {
      for (const pin of this.contextManager.listPins()) {
        if (pin.name === TURN_INPUTS_PIN && (pinId === undefined || pin.id === pinId)) this.contextManager.unpin(pin.id);
      }
      return true;
    } catch (error) {
      console.error(`[turn-inputs] ${this.name}: could not remove the turn's input pin:`, error);
      return false;
    }
  }

  private async compileUnpinningOnRefusal(compile: () => Promise<CompileResult>): Promise<CompileResult> {
    const pinned = this.holdsTurnInputsPin();
    try {
      return await compile();
    } catch (error) {
      if ((error as { name?: unknown } | null)?.name !== 'OverBudgetError' || !pinned || !this.unpinTurnInputs()) throw error;
      console.error(`[turn-inputs] ${this.name}: the compile refused with the turn's inputs pinned, so they are unpinned and it compiles again`);
      return compile();
    }
  }

  private holdsTurnInputsPin(): boolean {
    try {
      return this.contextManager.listPins().some((pin) => pin.name === TURN_INPUTS_PIN);
    } catch {
      return false;
    }
  }

  /**
   * Per destination (a server's channel, by its key), the newest consumed
   * watermark the agent had read when it published there by a route the
   * framework sees (its prose, a sleep's announcement, a channel_publish, a
   * draft resend, or a send tool whose channel the framework records), on
   * the branch it was taken on. A wake that carries a channel, unless it's
   * marked ambient (InferenceRequest.ambient), keeps its turn unless the
   * agent spoke there after reading the write the wake is for. It
   * lives as long as this Agent: an agent made again starts it empty, and
   * such a wake then stays.
   */
  private publishedThrough = new Map<string, { branch: string; sequence: number }>();

  /** Note a publish into `destination` (its key), made having read through
   *  `readThrough`: the consumed watermark when its words were written, or
   *  its call made. */
  notePublished(destination: string, readThrough: { branch: string; sequence: number } | null): void {
    if (!readThrough) return;
    const noted = this.publishedThrough.get(destination);
    if (noted && noted.branch === readThrough.branch && noted.sequence >= readThrough.sequence) return;
    this.publishedThrough.set(destination, readThrough);
  }

  /** Whether the agent published into `destination` (its key) having read
   *  the row stored at `sequence` on `branch`. */
  publishedAfterReading(destination: string, branch: string, sequence: number): boolean {
    const noted = this.publishedThrough.get(destination);
    return !!noted && noted.branch === branch && noted.sequence >= sequence;
  }

  /** Mark everything currently stored as consumed (the agent's creation, at
   *  boot or later, and a tool boundary that injected messages into a live
   *  stream declaring it carries them; see consumedWatermark). */
  markContextConsumed(): void {
    // Tolerates partial context-manager doubles (tests build Agents over
    // stubs). Without a watermark, a reader that looks for one takes its own
    // side: the coalescer counts the message as read, and the framework's
    // unreadNoticesForPrimary counts it as unread. A wake for a deferred
    // write or a stored message reads the answered watermark instead
    // (deferredWriteDone, storedMessageDone).
    this.consumedWatermark = this.pendingWatermark();
    this.watermarkMarks++;
    this.shownWatermark = this.consumedWatermark;
  }

  /** Mark everything currently stored as possibly shown (a tool boundary
   *  that injected messages into its stream). Without
   *  a watermark the coalescer counts a message as shown, as it counts one
   *  read without a consumed watermark. */
  markContextShown(): void {
    this.shownWatermark = this.pendingWatermark();
  }

  /** A committing compile that threw assembled nothing, so its own move of
   *  the shown watermark goes back, unless a boundary or another compile has
   *  moved the watermark since. It goes back to the watermark as the compile
   *  found it, which can be another compile's claim that has failed as well.
   *  Of two overlapping committing compiles, if the first to start throws
   *  first, it gives nothing back (the second's claim is current), and if
   *  the second then throws, it restores the first's failed claim. Messages
   *  up to that claim then count as shown, although no request held those
   *  above the watermark the first compile found, which errs toward a marker
   *  until the next compile or boundary moves the watermark. */
  private unshowFailedCompile(
    watermark: { branch: string; sequence: number } | null,
    before: { branch: string; sequence: number } | null,
  ): void {
    if (watermark && this.shownWatermark === watermark) this.shownWatermark = before;
  }

  /**
   * A finished compile's watermark, taken before it awaited. Within a branch
   * the watermark only advances: if a mark was made while the compile ran,
   * the compile's (older) one is applied only where it is later on that
   * mark's branch, so a boundary's mark is never rolled back by a compile
   * that started before it (a committing compile, such as compileContext's,
   * run during a live turn; a dry run, such as previewActivation's, never
   * reaches here).
   */
  private applyCompileWatermark(watermark: { branch: string; sequence: number }, marksBefore: number): void {
    const current = this.consumedWatermark;
    if (this.watermarkMarks !== marksBefore && current
      && (current.branch !== watermark.branch || current.sequence >= watermark.sequence)) return;
    this.consumedWatermark = watermark;
    this.watermarkMarks++;
  }

  /**
   * The branch now (`branchKey`) and its head, as `pendingWatermark` reads it: a message stored on that branch later
   * has a larger sequence. Sequences are numbered per branch, so one compares with another only on the same branch.
   */
  branchHead(): { branch: string; sequence: number } | undefined {
    const head = this.pendingWatermark();
    const cm = this.contextManager as Partial<ContextManager>;
    if (!head || typeof cm.currentBranchRef !== 'function') return undefined;
    try {
      return { branch: branchKey(cm.currentBranchRef()), sequence: head.sequence };
    } catch {
      return undefined;
    }
  }

  /** The watermark a successful compile will establish (taken before, applied after). */
  private pendingWatermark(): { branch: string; sequence: number } | null {
    const cm = this.contextManager as Partial<ContextManager>;
    try {
      if (typeof cm.currentBranch !== 'function' || typeof cm.getAllMessages !== 'function') return null;
      // The chronicle head, not this slot's last message: a compile reads
      // everything stored on the branch so far, including messages merged in
      // from another slot (the subconscious reads the residents' shared slot).
      const store = typeof cm.getStore === 'function' ? cm.getStore() as { currentSequence?: () => number } : undefined;
      let sequence = typeof store?.currentSequence === 'function' ? store.currentSequence() : undefined;
      if (sequence === undefined) {
        const count = typeof cm.getMessageCount === 'function' ? cm.getMessageCount() : cm.getAllMessages().length;
        sequence = count > 0 ? cm.getAllMessages().at(-1)?.sequence ?? 0 : 0;
      }
      return { branch: cm.currentBranch().name, sequence };
    } catch {
      return null;
    }
  }

  /** A committing compile, as for a request that is sent: the context
   * manager commits what it commits for one, the consumed watermark moves,
   * and a prepared budget change settles. To inspect what the agent would
   * see, use the framework's `previewActivation`, which compiles as a dry
   * run. It isn't told the agent's thinking binding (`thinkingBinding.binds`),
   * so a context manager that keeps a thinking-binding record neither reads
   * nor writes the record here, and what it returns keeps thinking whose
   * earlier conversation changed. Called while a turn's input pin is held
   * (pinTurnInputs), a refusal as over budget removes the pin and compiles
   * once more, as the turn's own compiles do. */
  async compileContext(budget?: TokenBudget): Promise<CompileResult> {
    // RFC-006 §3.3: consumption is determined at assembly — a compile that
    // fails assembled nothing, so the watermark moves only on success.
    const watermark = this.pendingWatermark();
    const marksBefore = this.watermarkMarks;
    const shownBefore = this.shownWatermark;
    if (watermark) this.shownWatermark = watermark;
    const compile = () => this.compileUnpinningOnRefusal(() => this.contextManager.compile(this.compileBudget(budget)));
    let result: CompileResult;
    try {
      result = budget ? await compile() : await this.compileAtLiveBudget(compile);
    } catch (error) {
      this.unshowFailedCompile(watermark, shownBefore);
      throw error;
    }
    if (watermark) this.applyCompileWatermark(watermark, marksBefore);
    return result;
  }

  /**
   * The stored context injections of this agent's that the last compile it
   * built to send rendered (stored-injections.ts), the framework's activation
   * request's or the direct API's: for each namespace and content, the parts
   * the compile held, and the branch it read. A compile built to send whose
   * request then isn't sent (a stop, a failure) still records: its rows stay
   * in the window all the same. Undefined before the first, as after a
   * restart. The framework's same-content skip reads it (renderedInjection).
   */
  private renderedInjections?: {
    branch: { readonly id: string; readonly created: number };
    /** Per namespace, per content hash: the parts any copy of that content
     *  holds, how many it has, and its newest copy's sequence. */
    byNamespace: Map<string, Map<string, { parts: number; held: Set<number>; sequence: number }>>;
  };

  /**
   * Per branch (by id and created), the point a stored injection on it has
   * to come after to have been in no request yet (unsentInjection): the
   * newest row of this agent's window on that branch when the first plan
   * there since its last compile built to send (a start's, or a preview's,
   * which stores nothing) asked about a unit, before that plan's start
   * stored anything. Each compile built to send that records what it
   * held unsets its branch's, a restart unsets them all, and a plan asks
   * here before it stores a unit, so every one of this agent's stored
   * injections on a branch after its point was stored since that compile.
   * Kept per branch, so a start or preview on another branch doesn't move
   * this one's past a copy no request has had.
   */
  private readonly unsentSince = new Map<string, number>();

  /**
   * A host's hook, called with the messages of each compile built to send
   * (never a dry run), as the compile is recorded: what the request carries,
   * after compression and the window have done their work. The framework
   * uses it to tell when an MCPL toolset's announcement has left the context
   * (RFC-014 §8.3 reminders). It must not change the messages; one that
   * throws is logged, and the start goes on.
   */
  onCompiledToSend?: (messages: readonly unknown[]) => void;

  /**
   * A host's hook, called with each committing compile's `thinkingStrip` (never a dry run's) and the key of the
   * branch it read (`branchKey`), as the compile returns, whether or not its request is then sent, since the
   * context manager's binding record takes the strip either way. One that throws is logged. The framework sets it
   * at the agent's first stream unless a host has set one, so a host's own observer stands in for the framework's,
   * whose `[reasoning]` line for the agent then isn't told.
   */
  onThinkingStrip?: (strip: ThinkingStrip, branch: string) => void;

  /**
   * The newest content of `namespace` among this agent's rows stored since
   * its last compile built to send (unsentSince), and whether every part of
   * it is among them: rows a start stored whose compile then didn't record
   * (it threw, or the start failed before it), which no request has had
   * yet, and which are newer than anything renderedInjection knows. Undefined when there are none, as at every
   * start whose last compile was built and recorded. A fold between that
   * start and the next (a host's own committing compile, or the compression
   * an over-budget retry waits for) can summarize them all the same: the
   * next request then has the summary's word for them, and the start after
   * it stores them again, as after any fold. The window is read back 64
   * rows at a time from the newest, stopping at that point.
   */
  unsentInjection(namespace: string): { contentHash: string; whole: boolean } | undefined {
    let newest: { contentHash: string; parts: number; held: Set<number> } | undefined;
    try {
      const branch = branchKey(this.contextManager.currentBranchRef());
      const since = this.unsentSince.get(branch);
      if (since === undefined) {
        const count = this.contextManager.getMessageCount();
        const top = count > 0 ? this.contextManager.getMessageWindow(count - 1, 1, { resolveBlobs: false }).messages[0]?.sequence ?? 0 : 0;
        this.unsentSince.set(branch, top);
        return undefined;
      }
      scan: for (let end = this.contextManager.getMessageCount(); end > 0;) {
        const span = Math.min(end, 64);
        const { messages } = this.contextManager.getMessageWindow(end - span, span, { resolveBlobs: false });
        for (let i = messages.length - 1; i >= 0; i--) {
          const row = messages[i]!;
          if (row.sequence <= since) break scan;
          const mark = storedInjectionMarkOf(row.metadata);
          if (mark?.agent !== this.name || mark.namespace !== namespace) continue;
          // Read from the newest back, the first copy met is the newest
          // content; its other parts pool with it.
          newest ??= { contentHash: mark.contentHash, parts: mark.parts, held: new Set() };
          if (mark.contentHash === newest.contentHash) newest.held.add(mark.part);
        }
        end -= span;
      }
    } catch (err) {
      // Where the rows read before the failure held a copy, the newest of
      // them is still the newest content (any unread row is older), and a
      // part it lacks may be unread, so it's stored again at worst. Where
      // they held none, the last request's record decides, as it did before
      // this check: a copy a failed start stored is then stored again, or,
      // where the source has changed back to what that request held, left
      // newest for one more request. Either way the start goes on, where
      // failing here would lose its turn.
      console.error(`[injection] ${this.name}: could not read its window for copies stored since its last request, so ${newest ? 'the rows it read decide' : "that request's record decides"}:`, err);
      if (!newest) return undefined;
    }
    return newest && { contentHash: newest.contentHash, whole: newest.held.size === newest.parts };
  }

  /** Record which of this agent's stored injections a compile built to send
   *  rendered. Another agent's stored rows never reach this agent's compile,
   *  since every compile of a shared store leaves them out by its view
   *  filter (isAnotherAgentsInjection): a compile of a shared store without
   *  that filter would mix them in here. */
  private noteRenderedInjections(result: CompileResult): void {
    // The host's look at what this request carries (onCompiledToSend).
    if (this.onCompiledToSend) {
      try {
        this.onCompiledToSend(result.messages);
      } catch (err) {
        console.error(`[agent] ${this.name}: the host's compile observer failed:`, err);
      }
    }
    const provenance = result.provenance;
    // The rows stored before this compile on its branch have been compiled
    // to send, whether the request held them or a fold or the strategy's
    // window took them (the record below says which): the first plan there
    // after it, a start's or a preview's, sets the point again
    // (unsentInjection). Without provenance, which branch isn't known, so
    // every branch's point goes, rather than one surviving a compile that
    // held its rows.
    if (provenance) this.unsentSince.delete(branchKey(provenance.branch));
    else this.unsentSince.clear();
    if (!provenance) {
      this.renderedInjections = undefined;
      return;
    }
    const byNamespace = new Map<string, Map<string, { parts: number; held: Set<number>; sequence: number }>>();
    for (const [i, source] of provenance.messages.entries()) {
      // Only a message rendered as an injection's participant can be one, so
      // the store is read for those alone.
      if (source.kind !== 'raw' || !result.messages[i]?.participant.startsWith('system_context:')) continue;
      for (const body of source.bodies) {
        const mark = this.storedMarkOf(body.messageId);
        if (!mark) continue;
        // A part counts as held when all its shards are there. One the
        // strategy altered (cut at its per-message cap, an image stripped)
        // counts too: a new copy would meet the same, so storing again
        // would only add copies, every start. A part missing shards still
        // says which content is newest.
        const held = body.complete || (body.missing !== undefined && !body.missing.includes('shards'));
        const contents = byNamespace.get(mark.namespace) ?? new Map();
        byNamespace.set(mark.namespace, contents);
        // Copies of the same content in view pool what they hold: the agent
        // has each part that one of them holds.
        const known = contents.get(mark.contentHash) ?? { parts: mark.parts, held: new Set<number>(), sequence: body.sequence };
        if (held) known.held.add(mark.part);
        known.sequence = Math.max(known.sequence, body.sequence);
        contents.set(mark.contentHash, known);
      }
    }
    this.renderedInjections = { branch: provenance.branch, byNamespace };
  }

  /**
   * The newest content of `namespace` among this agent's stored injections
   * that the last compile built to send rendered, by its newest copy: its
   * content hash, and whether every part of that content was there in some
   * copy, every shard, however the strategy shaped it. Undefined when none
   * was, when this agent hasn't built a request since it started, or when
   * the window's branch has changed since.
   */
  renderedInjection(namespace: string): { contentHash: string; whole: boolean } | undefined {
    const rendered = this.renderedInjections;
    const branch = this.contextManager.currentBranchRef();
    if (!rendered || rendered.branch.id !== branch.id || rendered.branch.created !== branch.created) return undefined;
    let newest: [string, { parts: number; held: Set<number>; sequence: number }] | undefined;
    for (const entry of rendered.byNamespace.get(namespace) ?? []) {
      if (!newest || entry[1].sequence > newest[1].sequence) newest = entry;
    }
    return newest ? { contentHash: newest[0], whole: newest[1].held.size === newest[1].parts } : undefined;
  }

  /**
   * Whether compiled message `i` of `result` is a row of this agent's stored
   * context injections (stored-injections.ts): rendered as an injection's
   * participant, and each of its stored rows, by the compile's provenance,
   * carrying this agent's mark. A speaker merely named like an injection's
   * participant isn't one. Only such a message's rows are read, so a start
   * reads the store for those alone.
   */
  private isStoredInjectionRow(result: CompileResult, i: number): boolean {
    const source = result.provenance?.messages[i];
    return source?.kind === 'raw' && source.bodies.length > 0
      && !!result.messages[i]?.participant.startsWith('system_context:')
      && source.bodies.every((b) => this.storedMarkOf(b.messageId)?.agent === this.name);
  }

  /** A stored row's injection mark, or undefined for any other row, and for
   *  one the store can't read just now, which is logged: a start doesn't fail
   *  on it (the row then counts as no stored injection). */
  private storedMarkOf(id: MessageId): ReturnType<typeof storedInjectionMarkOf> {
    try {
      return storedInjectionMarkOf(this.contextManager.getMessage(id)?.metadata);
    } catch (err) {
      console.error(`[injection] ${this.name}: could not read stored row ${id}, so it counts as no stored injection:`, err);
      return undefined;
    }
  }

  /**
   * Compile the context with injections (e.g. from MCPL servers), which the
   * context manager merges into the compiled messages. Without
   * `opts.dryRun` it commits as `compileContext` does: the consumed
   * watermark moves, and a compile at the live window settles a prepared
   * budget change. With `opts.dryRun`, for a compile that will never be
   * sent, it does neither (see below).
   */
  async compileWithInjections(
    budget?: TokenBudget,
    injections?: ContextInjection[],
    opts?: { kvUnifiedImmutablePrefixHash?: string; dryRun?: boolean } & BindingCompileOptions,
  ): Promise<CompileResult> {
    // A dry run is a compile that will never be sent. The context manager
    // persists no fold resolutions for it and queues none of the compression
    // or merge work its fold plan calls for, and, with the thinking binding
    // (`thinkingBinding.binds`), writes no binding record. Here nothing
    // moves either: the agent never read what a dry run assembled, so the
    // consumed watermark stays. A dry run proves nothing about the budget
    // either, so it goes straight to the compile, around
    // compileAtLiveBudget: it settles no descent (a prepared budget change
    // waits for the compile that is sent), notes no compiled budget, and
    // restores nothing the boot applied at once, whether it fits or is
    // refused.
    //
    // Context-manager 0.14 leaves what a select leaves behind as the last
    // committing compile left it, on every path out of a dry run, throws
    // included: no chunk record and no compression queued for a chunk the
    // dry run closes, no calibration, and none of the bookkeeping the next
    // compile or an observer reads (its `SelectOptions.dryRun` gives the
    // contract). The one thing a dry run can still leave is the release of a
    // compression hold whose deadline has passed, which `compile` does for
    // any compile before it selects.
    const watermark = opts?.dryRun ? null : this.pendingWatermark();
    const marksBefore = this.watermarkMarks;
    // Shown from the compile's start: what it assembles is in front of the
    // agent before the consumed watermark moves, once it returns.
    const shownBefore = this.shownWatermark;
    if (watermark) this.shownWatermark = watermark;
    const select = () => this.contextManager.compile(this.compileBudget(budget), injections, opts as never);
    const compile = opts?.dryRun ? select : () => this.compileUnpinningOnRefusal(select);
    let result: CompileResult;
    try {
      result = budget || opts?.dryRun ? await compile() : await this.compileAtLiveBudget(compile);
    } catch (error) {
      this.unshowFailedCompile(watermark, shownBefore);
      throw error;
    }
    if (watermark) this.applyCompileWatermark(watermark, marksBefore);
    if (!opts?.dryRun && result.thinkingStrip && this.onThinkingStrip) {
      try {
        this.onThinkingStrip(result.thinkingStrip, result.provenance ? branchKey(result.provenance.branch) : '');
      } catch (err) {
        console.error(`[agent] ${this.name}: the host's thinking-strip observer failed:`, err);
      }
    }
    return result;
  }

  // ==========================================================================
  // Inference (backward-compatible)
  // ==========================================================================

  /**
   * Run inference and return result with tool calls and speech content.
   * Updates agent state during execution. Its compile commits. With
   * `thinkingBinding.binds` it also writes the context manager's
   * thinking-binding record, so then call it only while none of this agent's
   * requests is streaming: a stream open meanwhile then has its later notes
   * write nothing, and its replies go without their thinking at the next
   * compile. Its own reply is never noted, so with `binds` its thinking is
   * left out at the compile after it's stored.
   */
  async runInference(
    availableTools: ToolDefinition[],
    budget?: TokenBudget,
    options: InferenceOptions = {}
  ): Promise<InferenceResult> {
    return this.runInferenceWithInjections(availableTools, undefined, budget, options);
  }

  /**
   * Run inference with context injections.
   * Same as runInference but passes injections through to compile. Its
   * compile commits, and with `thinkingBinding.binds` writes the
   * thinking-binding record, as runInference's does (see there).
   */
  async runInferenceWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
    options?: InferenceOptions
  ): Promise<InferenceResult> {
    if (this._state.status === 'inferring') {
      throw new Error(`Agent ${this.name} is already inferring`);
    }
    // Unstored, so they leave for the request here (text-as-stored.ts).
    injections = injectionsAsStored(injections);

    if (this._state.status === 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is waiting for tool results`);
    }

    this.toolResultGuard.flushUnrecorded();

    // Filter tools to only allowed ones
    const tools = availableTools.filter((t) => this.canUseTool(t.name));

    // The direct Agent API uses the same admission rules as framework-driven
    // streams. Stage before compiling so compression only sees placeholders.
    const guardedResults = this._state.status === 'ready' && this.toolResultGuard.enabled;
    if (guardedResults && this._state.status === 'ready') {
      const content = this.buildToolResultMessages(this._state.toolResults)[0].content;
      const wireResults = content.flatMap((block) => block.type === 'tool_result'
        // buildToolResultMessages serializes every payload to a string.
        ? [{ toolUseId: block.toolUseId, content: block.content as string, isError: block.isError }] : []);
      // Stored under the house default cap (buildToolResultMessages), as what a
      // stub keeps is too.
      this.toolResultGuard.storeResults(content, wireResults, this._state.toolResults, undefined,
        DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS);
    }

    // Compile the context (with optional injections) into a request. The
    // guard's refusal retry is assembled the same way, afresh. It is compiled
    // only once each withheld stub's annotation has finished, including one
    // that began during the compile, and after a stub edit that failed has
    // been retried; one whose store still fails is compiled as the bare
    // notice.
    let unguardedResults: ReturnType<Agent['buildToolResultMessages']> | undefined;
    const binding = this.bindingCompileOptions(tools, (injections ?? [])
      .filter((injection) => injection.position === 'system')
      .flatMap((injection) => injection.content));
    const assemble = async (): Promise<NormalizedRequest> => {
      const compiled = await this.toolResultGuard.afterAnnotations(
        () => this.compileWithInjections(budget, injections, binding.thinkingBinding ? binding : undefined));
      // What it holds of the stored injections is what the agent last saw.
      this.noteRenderedInjections(compiled);
      const { systemInjections } = compiled;
      // The framework's own pricing stamp never goes out (thinking-token-stamp.ts);
      // the agent's own turns are then presented under its name (presentOwnTurns).
      const messages = this.presentOwnTurns(withoutTokenEstimates(compiled.messages));
      // Read once, after the first compile, since results may have become
      // ready while it ran; the refusal retry, assembled while the agent is
      // inferring, sends the same ones.
      unguardedResults ??= this._state.status === 'ready' && !guardedResults
        ? this.buildToolResultMessages(this._state.toolResults) : [];
      messages.push(...unguardedResults);
      return {
        messages: this.toolResultGuard.prepareRequest(messages, true),
        system: this.buildSystemPrompt(systemInjections),
        tools: tools.length > 0 ? tools : undefined,
        ...this.requestSettings(),
        assistantParticipant: this.presentAs,
      };
    };
    const request = await assemble();

    const abortController = new AbortController();
    if (options?.signal) {
      if (options.signal.aborted) {
        abortController.abort();
      } else {
        options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    // Set state to inferring
    this._inferenceStartedAt = Date.now();
    const inferencePromise = this.doInference(request, abortController.signal, assemble);
    this._state = { status: 'inferring', promise: inferencePromise, abortController };

    try {
      const result = await inferencePromise;

      if (result.aborted) {
        this._state = { status: 'idle' };
        return result;
      }

      if (result.toolCalls.length > 0) {
        // Waiting for tool results
        const pending = new Map<ToolCallId, PendingToolCall>();
        for (const call of result.toolCalls) {
          pending.set(call.id, {
            id: call.id,
            name: call.name,
            input: call.input,
            startedAt: Date.now(),
          });
        }
        this._state = { status: 'waiting_for_tools', pending, completed: [] };
      } else {
        // Done, back to idle
        this._state = { status: 'idle' };
      }

      return result;
    } catch (error) {
      // On error, go back to idle
      this._state = { status: 'idle' };
      this.toolResultGuard.recovering = false;
      throw error;
    }
  }

  /**
   * Provide a tool result.
   */
  provideToolResult(callId: ToolCallId, result: ToolResult): void {
    if (this._state.status !== 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is not waiting for tools`);
    }

    const pending = this._state.pending.get(callId);
    if (!pending) {
      throw new Error(`Unknown tool call: ${callId}`);
    }

    // Move from pending to completed
    const completed: CompletedToolCall = {
      id: pending.id,
      name: pending.name,
      input: pending.input,
      result,
      durationMs: Date.now() - pending.startedAt,
    };

    this._state.pending.delete(callId);
    this._state.completed.push(completed);

    // If all tools done, transition to ready
    if (this._state.pending.size === 0) {
      this._state = {
        status: 'ready',
        toolResults: this._state.completed,
        stream: this._state.stream,
        supportsInjectedMessages: this._state.supportsInjectedMessages,
      };
    }
  }

  /**
   * Start a yielding stream for inference.
   * Returns the stream — the caller (framework) iterates it.
   */
  async startStream(
    availableTools: ToolDefinition[],
    budget?: TokenBudget
  ): Promise<StartStreamResult> {
    return this.startStreamWithInjections(availableTools, undefined, budget);
  }

  /**
   * Build the membrane-normalized request that WOULD be emitted for this
   * agent's next activation, given the supplied tools and injections.
   *
   * This is the single source of truth for a framework turn's request,
   * shared by the real activation path (`startStreamWithInjections`) and
   * debug/preview tooling (`Framework.previewActivation`). It does not call
   * the membrane. The direct API (`runInferenceWithInjections`) assembles its
   * own messages, system prompt and tools, and both take the agent's
   * settings from `requestSettings()`.
   * A compile that is sent commits what the context manager commits for it
   * (fold resolutions, the compression its fold plan calls for, the consumed
   * watermark); a preview passes `options.dryRun`, so its compile commits
   * none of that (see `compileWithInjections` for what a dry run still
   * leaves). Either way the context manager is handed the compression tool
   * definitions. Safe to call regardless of the agent's current status,
   * except that with `thinkingBinding.binds` a compile that isn't a dry run
   * writes the context manager's binding record, so while one of the
   * agent's requests streams, a call to look passes `options.dryRun`.
   * It doesn't wait for the tool-result guard's annotations, so a preview
   * never waits on a workspace write (rollback, undo and redo report one), and
   * may show a withheld stub before its place is added; the activation waits
   * for them around its call.
   */
  private async assembleActivationRequest(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
    compressionTools: ToolDefinition[] = availableTools,
    options: ActivationRequestOptions = {},
  ): Promise<{ request: NormalizedRequest; continuePrompt?: RequestOnlyPrompt; compiled: CompiledForRequest; binding: BindingCompileOptions }> {
    // Unstored, so they leave for the request here (text-as-stored.ts), the
    // layout hash below included.
    injections = injectionsAsStored(injections);
    // Compression may revisit hidden tools in recorded history. Keep its full
    // definition set separate from the resident's advertised tools: the
    // autobiographical strategy must declare the same tools on its
    // summarizer/compression requests, or transcripts containing tool blocks
    // are refused by Anthropic's reasoning_extraction classifier (labclaude
    // incident, 2026-07-09). Optional chaining: older context-manager
    // versions don't have the hook.
    (this.contextManager as unknown as { setToolDefinitions?: (t: ToolDefinition[]) => void })
      .setToolDefinitions?.(compressionTools);

    const strategy = (this.contextManager as unknown as { getStrategy?: () => unknown })
      .getStrategy?.() as {
      beginKvUnifiedSubmission?: (args: { submissionId: string; requestHash: string; layoutHash: string }) => void;
      isKvUnifiedEnabled?: () => boolean;
    };
    const kvUnified = strategy?.isKvUnifiedEnabled?.() === true;
    const prospectiveSystemInjections = (injections ?? [])
      .filter((injection) => injection.position === 'system')
      .flatMap((injection) => injection.content);
    const immutablePrefixHash = kvUnified
      ? stableHash({
          tools: availableTools.length > 0 ? availableTools : undefined,
          system: this.buildSystemPrompt(prospectiveSystemInjections),
        })
      : undefined;
    const binding = this.bindingCompileOptions(availableTools, prospectiveSystemInjections);
    const compiledResult = await this.compileWithInjections(
      budget,
      injections,
      immutablePrefixHash || options.dryRun || binding.thinkingBinding
        ? {
            ...(immutablePrefixHash ? { kvUnifiedImmutablePrefixHash: immutablePrefixHash } : {}),
            ...(options.dryRun ? { dryRun: true } : {}),
            ...binding,
          }
        : undefined,
    );
    let { messages } = compiledResult;
    const { systemInjections } = compiledResult;
    // It counts what the compile selected, so a preview's stand-ins
    // (appendedMessages, below) aren't in it.
    const { renderStats } = compiledResult;
    // What the request is built from, as the compile returned it: a block the provider drops is found again in
    // it, through the copies below, by its signature (placeThinkingDrops).
    const recordedAfter = compiledResult.thinkingRecordedAfter;
    const compiled: CompiledForRequest = {
      messages: compiledResult.messages,
      ...(compiledResult.provenance ? { provenance: compiledResult.provenance } : {}),
      ...(recordedAfter !== undefined ? { recordedAfter } : {}),
    };
    // Each message's place in the compile, or a preview's stand-in (null),
    // for the count of stored rows the request ends on, below.
    let origin: Array<number | null> = messages.map((_, i) => i);
    // A request that's sent says which stored injections the agent now has in
    // view, which the next start's same-content skip reads (stored-injections.ts).
    if (!options.dryRun) this.noteRenderedInjections(compiledResult);
    const appended = options.appendedMessages ?? [];
    if (appended.length > 0) {
      // Where a start's compile would render them, as the window's newest
      // rows: last, unless the window has no user message, where the compile
      // places the injections it's given at the end, after the window.
      const sources = compiledResult.provenance?.messages;
      let at = messages.length;
      if (sources && !messages.some((m, i) => sources[i]?.kind !== 'injection' && m.participant.toLowerCase() === 'user')) {
        while (at > 0 && sources[at - 1]?.kind === 'injection') at--;
      }
      origin = [...origin.slice(0, at), ...appended.map(() => null), ...origin.slice(at)];
      messages = [...messages.slice(0, at), ...appended, ...messages.slice(at)];
    }
    // The stored context injections the request ends on, counted over the
    // messages the sanitizer below keeps (hasRenderedContent), since it drops
    // a message it leaves empty, a placed blank injection among them.
    // [Continue] goes after them, and a tool loop's prompt is read from
    // before them: they're context, not what woke the agent. An injection
    // compile() places ends the tail, as on main, where every one was placed.
    let injectionTail = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!hasRenderedContent(messages[i]!.content)) continue;
      const from = origin[i] ?? null;
      if (from !== null && !this.isStoredInjectionRow(compiledResult, from)) break;
      injectionTail++;
    }

    // Sanitize: strip empty/whitespace text blocks and drop messages left with
    // no content. The Anthropic API rejects empty text blocks with 400
    // "messages: text content blocks must be non-empty"; when such a block
    // reaches a live activation request the agent cannot complete ANY turn
    // ([inference-failed] on every attempt) until the offending message ages
    // out of the window. Empty text blocks occur naturally: tool-only turns,
    // delivery-failure placeholders, silent/skip turns. Non-text blocks pass
    // through unchanged, so tool pairing is unaffected. (Field-observed
    // 2026-07-10 on a resident agent: one empty block muted the agent's live
    // path entirely; twin of context-manager's stripEmptyTextBlocks on the
    // compression path.)
    // The same pass a tool boundary applies to what it notes as sent
    // (sent-rows.ts), so the two can't drift.
    messages = messages
      .map((m) => ({ ...m, content: m.content.filter(carriedBlock) }))
      .filter((m) => m.content.length > 0);
    // The framework's own pricing stamp never goes out (thinking-token-stamp.ts).
    messages = withoutTokenEstimates(messages);

    messages = this.presentOwnTurns(messages);

    // Silent heartbeat ticks and replies to a [Continue] turn store no
    // prompt row. Render each request-only turn before its response's first
    // surviving row, so the wire formatter cannot merge the response into the
    // previous assistant message and every later request keeps the prefix
    // the response was minted under (see silent-heartbeat.ts for what can
    // and cannot be matched). The request that minted the response ended on
    // that same turn, so the prefix it caches is the one every later compile
    // renders. "First" is per agent: a broadcast tick shares its eventId with
    // every resident.
    const index = this.indexRequestOnlyRows();
    const rendered = renderRequestOnlyRows(messages, index, this.presentAs);
    messages = rendered.messages;
    // A tick opens wherever its separator isn't already rendered: on its first
    // request, and on a restart whose compile left none of the tick's rows,
    // so the restart's reply follows the separator, where every later compile
    // renders it.
    const openingTick = options.silentHeartbeat !== undefined
      && !rendered.separatedTicks.has(tickKey(options.silentHeartbeat));

    // The [Continue] prompt this request's reply follows, read from the
    // request itself: a new one when it ends on [Continue]; else, when it
    // ends on tool results (apart from stored context injections after
    // them), the prompt of the reply that called those tools, whose tool
    // loop this reply continues; else none. A request that ends
    // on anything else (a message that arrived during a cooldown, say) gets
    // a reply that follows that message and carries no prompt.
    let continuePrompt: RequestOnlyPrompt | undefined;
    if (openingTick) {
      messages = [...messages, silentHeartbeatSeparatorTurn()];
    } else if (endsOnOwnMessage(messages, this.presentAs, injectionTail)) {
      // Safety: ensure messages don't end with an assistant message.
      // Some models reject trailing assistant messages ("prefill not supported"),
      // and after context compression a stale assistant turn can end up last.
      // Where stored context injections follow the agent's message, as a
      // changed one does on a wake with nothing new, [Continue] goes after
      // them, so the cue stays last: the block isn't taken for what woke
      // the agent. Its reply's promptedBy puts it there in later compiles too,
      // where they can recognise the reply (renderRequestOnlyRows).
      messages = [...messages, continueTurn()];
      continuePrompt = { turn: randomUUID(), text: CONTINUE_ROW };
    } else {
      // What the request ends on apart from the stored injections after it,
      // which aren't something the reply answers.
      continuePrompt = toolLoopPrompt(messages.at(-1 - injectionTail), index);
    }

    const request: NormalizedRequest = {
      messages: this.toolResultGuard.prepareRequest(messages),
      system: this.buildSystemPrompt(systemInjections),
      tools: availableTools.length > 0 ? availableTools : undefined,
      ...this.requestSettings(),
      ...(kvUnified ? { cacheMarkers: 'cm-owned' as const } : {}),
    };
    if (options.dryRun) dryCompileStats.set(request, renderStats);
    return { request, ...(continuePrompt ? { continuePrompt } : {}), compiled, binding };
  }

  /**
   * The request fields that come from this agent's own settings: its model
   * config, thinking binding, prompt caching and cache TTL, prefill message,
   * provider parameters and participant name. Every request the agent sends
   * takes them from here, a framework turn's (assembleActivationRequest) and
   * the direct API's (runInferenceWithInjections), so a setting reaches both
   * or neither.
   */
  private requestSettings(): Pick<NormalizedRequest,
    'config' | 'promptCaching' | 'cacheTtl' | 'prefillUserMessage' | 'providerParams' | 'assistantParticipant'> {
    const thinking = this.requestThinking();
    return {
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        ...(this.temperature !== undefined && { temperature: this.temperature }),
        ...(thinking !== undefined && { thinking }),
      },
      promptCaching: this.promptCaching,
      cacheTtl: this.cacheTtl,
      ...(this.prefillUserMessage && { prefillUserMessage: this.prefillUserMessage }),
      ...(this.providerParams && { providerParams: this.providerParams }),
      assistantParticipant: this.presentAs,
    };
  }

  /**
   * The thinking config a request carries: the agent's own, with the binding
   * control added when `thinkingBinding.dropBlock` asks for it. A model whose
   * thinking is always on takes the control whatever `enabled` says, so an
   * agent with no thinking config of its own still sends one, holding only
   * the control and `enabled: false`. Membrane sends nothing from it to any
   * other model, since thinking is off there.
   */
  private requestThinking(): NonNullable<NormalizedRequest['config']['thinking']> | undefined {
    if (!this.thinkingDropBlock) return this.thinking;
    const own = this.thinking !== null && typeof this.thinking === 'object' ? this.thinking : { enabled: false };
    return { ...own, blockBinding: { prefixMismatchBehavior: 'drop_block' } };
  }

  /** The stream's way to tell the context manager what its later rounds sent, with the head its compile was given:
   *  where the agent's model binds its thinking (context-manager's `noteRequestSent`). */
  private requestNotes(binding: BindingCompileOptions, compiled: CompiledForRequest): Pick<StartStreamResult, 'noteRequestSent'> {
    const identity = binding.identity;
    // Each note names the compile the stream was built from, so a note can't vouch for this stream under a record a
    // later committing compile with binds wrote. A compile that reports no provenance gives the stream nothing to name, and the
    // stream notes nothing: its replies go without their thinking at the next compile, never refused.
    const compileId = compiled.provenance?.compileId;
    if (!identity || compileId === undefined) return {};
    const cm = this.contextManager;
    return { noteRequestSent: (rows) => cm.noteRequestSent(rows, identity, compileId) };
  }

  /**
   * The binding a compile of this agent is told of (bindingCompileOptions), and a preview of its context too: the
   * participant whose messages are its replies is its own name. Undefined where the model doesn't bind.
   * @internal For the framework's preview and its budget rule; not a host API.
   */
  thinkingBindingOption(): { binds: true; dropBlock: boolean; participant: string } | undefined {
    return this.thinkingBinds ? { binds: true, dropBlock: this.thinkingDropBlock, participant: this.name } : undefined;
  }

  /**
   * What a compile the agent sends tells the context manager when the model binds its thinking
   * (`thinkingBinding.binds`): the binding as set, with the agent's own name as the participant whose messages
   * are its replies (an agent stores its replies under its name), and a digest of each part of the request ahead of
   * its messages, so a changed one can stand for a first difference where the context manager keeps a
   * thinking-binding record. The system text is the one the request will carry, built from the system-position
   * injections given to the compile as the kv-unified prefix hash builds it; the tools are the ones it will carry, in
   * their order; `request` covers the thinking config, `maxTokens` and `providerParams`, where a host puts its own
   * thinking config and `tool_choice`, and `prefillUserMessage`, which membrane sends as a leading user turn ahead
   * of a conversation that would begin with the assistant. Nothing without `binds`: the compile is as it was.
   */
  private bindingCompileOptions(tools: readonly ToolDefinition[], systemInjections: ContentBlock[]): BindingCompileOptions {
    const thinkingBinding = this.thinkingBindingOption();
    if (!thinkingBinding) return {};
    const { config, providerParams, prefillUserMessage } = this.requestSettings();
    return {
      thinkingBinding,
      identity: {
        system: wireDigest(this.buildSystemPrompt(systemInjections)),
        tools: wireDigest(tools),
        model: wireDigest(this.model),
        request: wireDigest({
          thinking: config.thinking ?? null, maxTokens: config.maxTokens, providerParams: providerParams ?? null,
          prefillUserMessage: prefillUserMessage ?? null,
        }),
      },
    };
  }

  /** The request `assembleActivationRequest` builds (see there), for preview
   * and debug tooling: what this agent's next activation would send. */
  async buildActivationRequest(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
    compressionTools: ToolDefinition[] = availableTools,
    options: ActivationRequestOptions = {},
  ): Promise<NormalizedRequest> {
    return (await this.assembleActivationRequest(availableTools, injections, budget, compressionTools, options)).request;
  }

  /** Stored rows that follow a request-only turn, memoized on the store's
   * cached message array (ContextManager returns the same array until the
   * store changes). */
  private requestOnlyIndex: { source: readonly unknown[]; index: RequestOnlyRowIndex } | null = null;

  private indexRequestOnlyRows(): RequestOnlyRowIndex {
    const empty: RequestOnlyRowIndex = { ticks: new Map(), prompts: new Map() };
    const cm = this.contextManager as Partial<ContextManager>;
    if (typeof cm.getAllMessages !== 'function') return empty;
    try {
      const stored = cm.getAllMessages() as unknown as readonly StoredRowLike[];
      if (this.requestOnlyIndex?.source === stored) return this.requestOnlyIndex.index;
      const index = indexRequestOnlyRows(stored, this.ownParticipants);
      this.requestOnlyIndex = { source: stored, index };
      return index;
    } catch (error) {
      console.error(`[request-only-rows] ${this.name}: could not index stored rows; request-only turns omitted:`, error);
      return empty;
    }
  }

  /**
   * Start a yielding stream with context injections.
   * Same as startStream but passes injections through to compile.
   */
  async startStreamWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget,
    compressionTools: ToolDefinition[] = availableTools,
    options: ActivationRequestOptions = {},
  ): Promise<StartStreamResult> {
    if (this._state.status !== 'idle') {
      throw new Error(`Agent ${this.name} cannot start stream in state ${this._state.status}`);
    }

    // Retry accepted history edits before assembling a real request. Pure
    // preview/compile entry points must not perform these writes.
    this.toolResultGuard.flushUnrecorded();

    // A new activation supersedes every receipt flight the previous one left
    // open. Membrane fires the kv-unified wire receipt per provider attempt,
    // BEFORE the adapter call; only that attempt's usage event settles it.
    // When the attempt dies without usage (transport error, idle timeout,
    // framework cancel for a budget restart or endTurn) the flight stays open
    // until the old driveStream's `finally` runs — and every successor path
    // (error-policy retry, budget restart, the next wake after an abort)
    // starts the new stream BEFORE that `finally`. The successor's first
    // receipt then met the ledger's single-flight guard and failed the
    // recovery itself: "kv-unified submission devops:46:…:4 is still in
    // flight" (devops agent, 2026-09-16 07:33Z, no provider error logged).
    this.failOpenKvSubmissions();

    this._streamId++;
    // A pending cancel belongs to the stream that was live when cancelStream()
    // ran. The stream driver collects it on that stream's terminal event, or
    // at the loop's end when the iterator closed without one, while the
    // stream still owns the agent. This clear is for the records no driver
    // collects: a cancel of a stream no driver iterates; one whose stream's
    // terminal came after another stream took the agent; or a cancel after
    // the stream's complete event. A fresh stream must not inherit one and
    // read its own later error as a deliberate stop.
    this._pendingCancel = undefined;
    this._inferenceStartedAt = Date.now();
    this.lastStreamInputTokens = 0;
    // Reset the cache-inclusive counters too: a new stream must not inherit
    // the prior stream's window size — on the physical-window restart path
    // that inherited value IS the oversized number that caused the restart,
    // and projecting on it before this stream's first usage event would
    // restart again (loop). The `> 0` guard downstream means "no call on
    // THIS stream has reported a prompt yet" only because of this reset (a
    // call that reports none leaves these as they were, and adds to
    // lastStreamUnreportedTokens instead).
    this.lastStreamRealInputTokens = 0;
    this.lastStreamOutputTokens = 0;
    this.lastStreamUnreportedTokens = 0;

    // Compiled only once each withheld stub's annotation has finished,
    // including one that began during the compile, and after a stub edit that
    // failed has been retried (see afterAnnotations).
    const { request, continuePrompt, compiled, binding } = await this.toolResultGuard.afterAnnotations(
      () => this.assembleActivationRequest(availableTools, injections, budget, compressionTools, options));
    request.messages = this.toolResultGuard.prepareRequest(request.messages, true);

    const receiptAware = (this.contextManager as unknown as { getStrategy?: () => unknown })
      .getStrategy?.() as {
      beginKvUnifiedSubmission?: (args: { submissionId: string; requestHash: string; layoutHash: string }) => void;
      isKvUnifiedEnabled?: () => boolean;
    };
    const kvEnabled = receiptAware?.isKvUnifiedEnabled?.() === true;
    const kvQueue: Array<{ submissionId: string; wireReceipt: CacheWireReceipt }> = [];
    let kvCall = 0;
    if (kvEnabled) {
      this.kvOpenQueue = kvQueue;
      const layoutHash = stableHash(request.messages);
      const kvRequest = request as NormalizedRequest & KvUnifiedRequestHooks;
      kvRequest.onCacheWireReceipt = (receipt) => {
        const submissionId = `${this.name}:${this._streamId}:${Date.now()}:${kvCall++}`;
        receiptAware.beginKvUnifiedSubmission!({
          submissionId,
          requestHash: receipt.requestHash,
          layoutHash,
        });
        kvQueue.push({ submissionId, wireReceipt: receipt });
      };
    }

    const agent = this;
    const stream = this.membrane.streamYielding(request, {
      emitTokens: true,
      emitBlocks: false,
      emitUsage: true,
      // A caller that retries itself (the framework's turns: errorPolicy,
      // provider holds, stated waits, each attempt a fresh compile a stop can
      // cancel) has membrane send a failed round once and hand the error up:
      // since membrane 0.7 its own schedules, ten minutes at a 529, would
      // otherwise run inside each of the caller's attempts, out of its sight.
      ...(options.membraneRetries === false ? { retry: false } : {}),
      ...streamBounds(options.inferenceBounds ?? null, request.config.maxTokens),
      // Retry a content-policy refusal at the provider seam rather than at
      // the framework level: membrane replays the SAME request immediately
      // (cache-warm), where a framework-level requeue would recompile and
      // land a different window. The framework's driveStream handles the
      // resulting `retrying` event by discarding the abandoned attempt.
      // Membrane reads this per physical round, including after settings
      // tools run. A guarded result must reach the host on its FIRST refusal;
      // never spend retries resubmitting unchanged guarded content.
      get refusalRetries() {
        return agent.toolResultGuard.hasSubmittedPending || agent.toolResultGuard.recovering
          ? 0 : agent.refusalHandling?.retries ?? 0;
      },
    });

    this._state = { status: 'streaming', stream };
    return {
      stream,
      request,
      ...(continuePrompt ? { continuePrompt } : {}),
      // Read against the messages the stream sends, which membrane's report indexes (RoundReport's coordinates).
      placeDrops: (entries) => placeThinkingDrops(entries, request.messages, compiled),
      ...this.requestNotes(binding, compiled),
      ...(compiled.provenance
        ? { carriedBodies: new Set(compiled.provenance.messages.flatMap((m) => m.kind === 'raw' ? m.bodies.map((b) => b.messageId) : [])) }
        : {}),
      ...(compiled.recordedAfter !== undefined ? { thinkingRecordedAfter: compiled.recordedAfter } : {}),
      ...(compiled.provenance ? { thinkingBranch: branchKey(compiled.provenance.branch) } : {}),
      ...(kvEnabled
        ? {
            takeKvSubmission: () => kvQueue.shift(),
            drainKvSubmissionIds: () => kvQueue.splice(0).map((item) => item.submissionId),
          }
        : {}),
    };
  }

  /** Close every kv-unified receipt flight the previous activation left
   * unsettled. Idempotent: the framework's driveStream `finally` drains the
   * same per-stream queue, so whichever runs first empties it and the other
   * finds nothing. Failing an already-settled id is a no-op in the ledger. */
  private failOpenKvSubmissions(): void {
    const open = this.kvOpenQueue?.splice(0) ?? [];
    this.kvOpenQueue = null;
    if (open.length === 0) return;
    const strategy = (this.contextManager as unknown as { getStrategy?: () => unknown })
      .getStrategy?.() as { reportKvUnifiedFailed?: (submissionId: string) => void } | undefined;
    for (const { submissionId } of open) {
      console.error(
        `[kv-unified] ${this.name}: closing receipt flight ${submissionId} left open by the previous activation`,
      );
      try {
        strategy?.reportKvUnifiedFailed?.(submissionId);
      } catch (err) {
        console.error(`[kv-unified] ${this.name}: could not close flight ${submissionId}:`, err);
      }
    }
  }

  /**
   * Transition to waiting_for_tools when stream yields tool calls.
   * Called by framework's driveStream, with what the stream declared about
   * carrying injected messages with this round's results (see AgentState).
   */
  enterWaitingForTools(calls: ToolCall[], stream: YieldingStream, supportsInjectedMessages?: boolean): void {
    const pending = new Map<ToolCallId, PendingToolCall>();
    for (const call of calls) {
      pending.set(call.id, {
        id: call.id,
        name: call.name,
        input: call.input,
        startedAt: Date.now(),
      });
    }
    this._state = { status: 'waiting_for_tools', pending, completed: [], stream, supportsInjectedMessages };
  }

  /**
   * Add an assistant response to context.
   * Called by framework when stream completes.
   */
  addAssistantResponse(content: ContentBlock[], metadata?: MessageMetadata): MessageId | undefined {
    // A turn whose entire output is thinking blocks produced NOTHING: no
    // speech, no tool call. That is what a refusal looks like on the wire —
    // the provider returns signed thinking (often with empty text, the
    // fable-5 hidden-CoT packaging) and no content. Persisting it records an
    // action that never happened, and two such records landing adjacent are
    // actively toxic: formatters merge consecutive same-role messages
    // (membrane `mergeConsecutiveRoles`), producing one assistant message
    // carrying signed thinking from two different responses, which the
    // provider cannot verify — 400 "`thinking` or `redacted_thinking` blocks
    // in the latest assistant message cannot be modified", unrecoverable by
    // retry (labclaude, 2026-07-27: hard down ~4h on exactly this pair).
    //
    // Refused turns are surfaced by the refusal path (stderr, failures.log,
    // the [inference-failed] notice); the store does not also need a
    // content-free artifact of them. Loud, never silent.
    if (content.length > 0 && content.every(
      (b) => b.type === 'thinking' || b.type === 'redacted_thinking',
    )) {
      console.error(
        `[assistant-persist] agent=${this.name}: refusing to store a thinking-only assistant ` +
        `message (${content.length} block(s), no text and no tool_use) — the turn produced no ` +
        `output. See the refusal/inference-failed record for why.`,
      );
      return undefined;
    }
    return this.contextManager.addMessage(this.name, content, metadata);
  }

  /**
   * Transition back to streaming state after tool results are provided.
   */
  setStreaming(stream: YieldingStream): void {
    this._state = { status: 'streaming', stream };
  }

  /** The most recent cancelStream() of a live stream, until the stream
   *  driver collects it on that stream's terminal event. Its presence is
   *  the signal (a reasonless Stop is still a deliberate stop); its reason
   *  is the caller's own word. Membrane reports every cancel() as reason
   *  'user' — the call, not the actor — and a stream implementation may
   *  report the cancel as `error` with no reason at all, so this record is
   *  the only provenance a host-side cancel has. */
  private _pendingCancel: { reason?: string } | undefined;

  /** The most recent cancelStream() made while this agent held no stream:
   *  during a turn's hooks or compile, while it waits to retry, or while no
   *  check of a turn is ahead at all. The framework collects it at the check
   *  ahead of it, which ends the turn, and the next start drops one no check
   *  collected, so a stop made while none was ahead, such as a host's
   *  interrupt of every agent, ends nothing. */
  private _stopWithoutStream: { reason?: string } | undefined;

  /**
   * Cancel the stream this agent's state holds (streaming, waiting on its
   * tools, or ready at a tool boundary with every result in), and reset to
   * idle. With no stream, the stop is kept for the turn in progress, which
   * the framework ends at its next check, before it sends anything more, if
   * one is still ahead; otherwise the next start drops it. `reason` is
   * provenance for the framework's inference:aborted trace and marker
   * metadata (e.g. 'zombie_reclaim', 'subagent_cancel'); it never reaches
   * the provider. When the stream's cancel() throws, the throw goes on to
   * the caller, and the agent still holds the stream, its cancel record as
   * it was before the call.
   */
  cancelStream(reason?: string): void {
    if ('stream' in this._state && this._state.stream) {
      // A cancel that throws leaves the stream going and the agent holding
      // it, so this call's record is taken back, leaving any earlier one: a
      // later end of that stream, an `error` the provider reports included,
      // is not read as this stop's.
      const earlier = this._pendingCancel;
      this._pendingCancel = { reason };
      try {
        this._state.stream.cancel();
      } catch (error) {
        this._pendingCancel = earlier;
        throw error;
      }
    } else {
      this._stopWithoutStream = { reason };
    }
    this._state = { status: 'idle' };
  }

  /** Collect (and clear) the cancelStream() made while this agent held no
   *  stream, if one was made since the last collection. */
  takeStopWithoutStream(): { reason?: string } | undefined {
    const s = this._stopWithoutStream;
    this._stopWithoutStream = undefined;
    return s;
  }

  /** Collect (and clear) the cancel that ended the current stream, if this
   *  side issued one. The stream driver calls it once, while the stream
   *  still owns the agent, at the stream's terminal event (`aborted`
   *  normally, `error` for implementations that report cancel() that way)
   *  or at the loop's end when the stream closed without one. A record no
   *  driver collects is cleared when the agent's next stream starts. */
  takeCancel(): { reason?: string } | undefined {
    const c = this._pendingCancel;
    this._pendingCancel = undefined;
    return c;
  }

  /**
   * Check if agent has pending tool calls.
   */
  hasPendingTools(): boolean {
    return this._state.status === 'waiting_for_tools' && this._state.pending.size > 0;
  }

  /**
   * Get pending tool call IDs.
   */
  getPendingToolIds(): ToolCallId[] {
    if (this._state.status !== 'waiting_for_tools') {
      return [];
    }
    return Array.from(this._state.pending.keys());
  }

  /**
   * Reset agent to idle state.
   */
  reset(): void {
    this._state = { status: 'idle' };
  }

  /**
   * Get the context manager.
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * Build the effective system prompt, appending any system-position
   * injections, their blocks joined by line breaks. The system prompt is
   * text, so a block of another type, such as an image a server or module
   * injected there, can't go in it: a line in its place says so. The hook
   * orchestrator tells a server's operator once per server and namespace,
   * and the module registry tells a module's once per module and namespace.
   */
  private buildSystemPrompt(systemInjections: ContentBlock[]): string {
    if (systemInjections.length === 0) {
      return this.systemPrompt;
    }

    const injectedText = systemInjections.map((block) =>
      block.type === 'text'
        ? block.text
        : `[${NOTICE_TAG.blockNotShown}: ${/^[aeiou]/i.test(block.type) ? 'an' : 'a'} ${block.type} block; the system prompt carries text only.]`);

    return this.systemPrompt + '\n' + injectedText.join('\n');
  }

  abortInference(reason?: string): { aborted: true; durationMs: number } | false {
    if (this._state.status === 'inferring') {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this._state.abortController.abort(reason);
      return { aborted: true, durationMs };
    }

    if ('stream' in this._state && this._state.stream) {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this.cancelStream(reason);
      return { aborted: true, durationMs };
    }

    return false;
  }

  private async doInference(
    request: NormalizedRequest,
    signal: AbortSignal | undefined,
    /** Compiles the context into a request again, for the guard's retry. */
    reassemble: () => Promise<NormalizedRequest>,
  ): Promise<InferenceResult> {
    let response = signal?.aborted
      ? { aborted: true as const, reason: 'user' as const }
      : await this.membrane.stream(request, { signal });
    // Usage of a refused attempt abandoned by the guard; it was billed and
    // is added to the retry's usage below rather than overwritten.
    let abandonedUsage: { inputTokens: number; outputTokens: number } | undefined;
    if (!isAbortedResponse(response) && response.stopReason === 'refusal') {
      // A staged batch never on the wire cannot have caused the refusal.
      this.toolResultGuard.settleUnsubmitted('unknown');
      const ids = this.toolResultGuard.withhold('unknown');
      if (ids) {
        abandonedUsage = response.usage;
        // The retry is compiled afresh, like every request: once each stub's
        // annotation has finished (agent-framework #277), and against the
        // budget without the batch's reservation, so a stub longer than its
        // original can't carry the request past the budget.
        const retry = await reassemble();
        response = signal?.aborted
          ? { aborted: true, reason: 'user', partialUsage: response.usage }
          : await this.membrane.stream(retry, { signal });
      }
    }

    if (isAbortedResponse(response)) {
      // Interrupted before a clean response: settle, never leave pending.
      try {
        this.toolResultGuard.abandon('aborted');
      } catch (error) {
        console.error(`[tool-result-guard] agent=${this.name} failed to record aborted batch:`, error);
      }
      const partialContent = response.partialContent ?? [];
      const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(partialContent);
      return {
        toolCalls,
        speechContent,
        usage: response.partialUsage,
        stopReason: 'abort',
        aborted: true,
        abortReason: response.reason,
      };
    }

    const guardedRefusal = response.stopReason === 'refusal' && this.toolResultGuard.recovering;
    if (response.stopReason !== 'refusal') this.toolResultGuard.accept();
    this.toolResultGuard.recovering = false;
    const content = guardedRefusal ? [] : response.content;
    const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(content);

    // Add assistant response to context
    if (!guardedRefusal) this.contextManager.addMessage(this.name, content);

    return {
      toolCalls,
      speechContent,
      raw: response.raw,
      usage: abandonedUsage && response.usage ? {
        ...response.usage,
        inputTokens: response.usage.inputTokens + abandonedUsage.inputTokens,
        outputTokens: response.usage.outputTokens + abandonedUsage.outputTokens,
      } : response.usage,
      stopReason: response.stopReason,
    };
  }

  private extractToolCallsAndSpeech(content: ContentBlock[]): {
    toolCalls: ToolCall[];
    speechContent: ContentBlock[];
  } {
    const toolCalls: ToolCall[] = [];
    const speechContent: ContentBlock[] = [];

    for (const block of content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
          ...(block.unparseableInput !== undefined ? { unparseableInput: block.unparseableInput } : {}),
        });
      } else if (block.type === 'text') {
        speechContent.push(block);
      }
    }

    return { toolCalls, speechContent };
  }

  private buildToolResultMessages(results: CompletedToolCall[]): NormalizedMessage[] {
    // Tool results go as a user message with tool_result blocks. The history
    // serializer turns MCP image blocks into `[image: type, size]` so the
    // persisted transcript stays small and survives truncation.
    //
    // This is the direct-Agent-API path (the framework stores results itself
    // via buildStoredToolResultContent, with workspace spill). No workspace
    // is reachable from here, so the house default cap applies as plain
    // truncation — bounded beats unbounded, for errors too.
    const content = results.map((r) => {
      // This API's results are unchecked (nonErrorResultText), so each field
      // is read once, and only an error that is a string is made well formed;
      // any other error value is passed on as it was before.
      const isError = r.result.isError;
      const error: unknown = isError ? r.result.error ?? 'Unknown error' : undefined;
      return {
        type: 'tool_result' as const,
        toolUseId: r.id,
        content: isError
          ? truncateForHistory(typeof error === 'string' ? error.toWellFormed() : error as string, DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS)
          : nonErrorResultText(r.result, DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS, { toolName: r.name }),
        isError,
      };
    });

    return [{
      participant: 'user',
      content,
    }];
  }
}
