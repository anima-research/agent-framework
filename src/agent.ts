import type { Membrane, NormalizedMessage, NormalizedRequest, ContentBlock, YieldingStream, CacheWireReceipt } from '@animalabs/membrane';
import { isAbortedResponse } from '@animalabs/membrane';
import { createHash } from 'node:crypto';
import {
  toolResultDataToHistoryString,
  truncateForHistory,
  DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS,
} from './tool-result-history.js';

export interface StartStreamResult {
  stream: YieldingStream;
  request: NormalizedRequest;
  takeKvSubmission?: () => { submissionId: string; wireReceipt: CacheWireReceipt } | undefined;
  drainKvSubmissionIds?: () => string[];
}
import type {
  ContextManager,
  TokenBudget,
  ContextInjection,
  CompileResult,
  HotContextSettingsStatus,
  HotContextSettingsUpdate,
} from '@animalabs/context-manager';
import type {
  AgentConfig,
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

function stableHash(value: unknown): string {
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${encode(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(item) ?? 'null';
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}

const DEFAULT_CONTEXT_BUDGET_TOKENS = 100_000;
const DEFAULT_TRANSITION_PACE_TOKENS = 16_000;
const DEFAULT_SAME_ROUND_THINK_TEXT_POLICY: SameRoundThinkTextPolicy = 'public';

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
  /** Refusal auto-rewind policy (see AgentConfig.refusalHandling). */
  readonly refusalHandling: AgentConfig['refusalHandling'];
  /** Prose delivery mode (see AgentConfig.proseRouting). Default 'locus'. */
  readonly proseRouting: 'locus' | 'explicit' | 'hybrid' | 'disabled';
  /** Prompt-cache TTL forwarded to the provider (see AgentConfig.cacheTtl). */
  readonly cacheTtl: NonNullable<AgentConfig['cacheTtl']>;
  /** Emit prompt-cache markers on requests (see AgentConfig.promptCaching). */
  readonly promptCaching: boolean;
  /** Prefill scaffold user message (see AgentConfig.prefillUserMessage). */
  readonly prefillUserMessage?: string;
  /** Provider-specific request parameters forwarded unchanged by Membrane. */
  readonly providerParams?: Record<string, unknown>;
  readonly sameRoundThinkTextPolicy: AgentConfig['sameRoundThinkTextPolicy'];

  private _state: AgentState = { status: 'idle' };
  private _inferenceStartedAt = 0;
  private _streamId = 0;
  lastStreamInputTokens = 0;
  /** Real prefix size of the last usage event: fresh + cache creation +
   *  cache read. THE window-shaped number — `lastStreamInputTokens` alone
   *  omits cached tokens, which are most of a warm stream's window. */
  lastStreamRealInputTokens = 0;
  /** Output tokens of the last usage event — the prior round's generated
   *  thinking/text/tool_use, which becomes part of the NEXT round's input
   *  and so belongs in the physical-window projection. */
  lastStreamOutputTokens = 0;
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
  private runtimeSettingsOverrides: AgentRuntimeSettingsOverrides = {};
  private contextManager: ContextManager;
  private membrane: Membrane;

  constructor(
    config: AgentConfig,
    contextManager: ContextManager,
    membrane: Membrane
  ) {
    this.name = config.name;
    this.model = config.model;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools ?? 'all';
    this.triggerSources = config.triggerSources ?? 'all';
    this.maxTokens = config.maxTokens ?? 4096;
    this.temperature = config.temperature;
    this.thinking = config.thinking;
    this.refusalHandling = config.refusalHandling;
    this.proseRouting = config.proseRouting ?? 'locus';
    this.cacheTtl = config.cacheTtl ?? '1h';
    this.promptCaching = config.promptCaching ?? true;
    this.prefillUserMessage = config.prefillUserMessage;
    this.providerParams = config.providerParams;
    this.sameRoundThinkTextPolicy = config.sameRoundThinkTextPolicy;
    this.maxStreamTokens = config.maxStreamTokens ?? 150_000;
    this.physicalWindowTokens = config.physicalWindowTokens;
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
    return this.allowedTools.includes(toolName);
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
      contextBudgetTokens:
        this.contextBudgetTargetTokens ??
        this.contextBudgetTokens ??
        DEFAULT_CONTEXT_BUDGET_TOKENS,
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
      }
    }

    if (Object.keys(hotPatch).length > 0) {
      this.updateHotContextSettings(hotPatch);
    }
    this.contextBudgetTokens = nextContextBudget;
    this.contextBudgetTargetTokens = nextContextTarget;
    if (appliedDefaultPace) {
      this.runtimeSettingsOverrides.transitionPaceTokens = DEFAULT_TRANSITION_PACE_TOKENS;
    }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'sameRoundThinkTextPolicy') continue;
      if (key === 'immediate') continue; // a mode for this apply, never a persisted setting
      if (value !== undefined) (this.runtimeSettingsOverrides as Record<string, unknown>)[key] = value;
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
    this.contextBudgetTokens = nextContextBudget;
    this.contextBudgetTargetTokens = nextContextTarget;
    if (reset.has('contextBudgetTokens')) delete this.runtimeSettingsOverrides.contextBudgetTokens;
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
      this.contextBudgetTargetTokens = undefined;
      const live = this.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
      if (live === (this.configuredContextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS)) {
        delete this.runtimeSettingsOverrides.contextBudgetTokens;
      } else {
        this.runtimeSettingsOverrides.contextBudgetTokens = live;
      }
    }
    return this.getRuntimeSettings();
  }

  restoreRuntimeSettings(overrides: AgentRuntimeSettingsOverrides): AgentRuntimeSettingsSnapshot {
    return this.updateRuntimeSettings(overrides);
  }

  private validateRuntimeSettingsPatch(patch: AgentRuntimeSettingsPatch): void {
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
    if ((patch.tailTokens !== undefined || patch.transitionPaceTokens !== undefined) &&
        !this.getHotContextSettings()) {
      throw new Error('The active context strategy does not support live tail/transition settings');
    }
  }

  private settleRuntimeSettingsTransition(): void {
    if (this.contextBudgetTargetTokens === undefined) return;
    const hot = this.getHotContextSettings();
    if (!hot?.prepared) return;
    this.contextBudgetTokens = this.contextBudgetTargetTokens;
    this.contextBudgetTargetTokens = undefined;
    this.updateHotContextSettings({ preparedWindowTokens: null });
  }

  async compileContext(budget?: TokenBudget): Promise<CompileResult> {
    const result = await this.contextManager.compile(this.resolveBudget(budget));
    if (!budget) this.settleRuntimeSettingsTransition();
    return result;
  }

  /**
   * Compile the context with injections.
   * Same as compileContext but forwards injections (e.g. from MCPL servers)
   * to the context manager so they are merged into the compiled messages.
   */
  async compileWithInjections(
    budget?: TokenBudget,
    injections?: ContextInjection[],
    opts?: { kvUnifiedImmutablePrefixHash?: string },
  ): Promise<CompileResult> {
    const result = await this.contextManager.compile(this.resolveBudget(budget), injections, opts);
    if (!budget) this.settleRuntimeSettingsTransition();
    return result;
  }

  // ==========================================================================
  // Inference (backward-compatible)
  // ==========================================================================

  /**
   * Run inference and return result with tool calls and speech content.
   * Updates agent state during execution.
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
   * Same as runInference but passes injections through to compile.
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

    if (this._state.status === 'waiting_for_tools') {
      throw new Error(`Agent ${this.name} is waiting for tool results`);
    }

    // Filter tools to only allowed ones
    const tools = availableTools.filter((t) => this.canUseTool(t.name));

    // Compile context (with optional injections)
    const { messages, systemInjections } = await this.compileWithInjections(budget, injections);

    // If we have pending tool results, add them
    if (this._state.status === 'ready') {
      const toolResultMessages = this.buildToolResultMessages(this._state.toolResults);
      messages.push(...toolResultMessages);
    }

    const request: NormalizedRequest = {
      messages,
      system: this.buildSystemPrompt(systemInjections),
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        ...(this.temperature !== undefined && { temperature: this.temperature }),
        ...(this.thinking !== undefined && { thinking: this.thinking }),
      },
      tools: tools.length > 0 ? tools : undefined,
      ...(this.providerParams && { providerParams: this.providerParams }),
      assistantParticipant: this.name,
    };

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
    const inferencePromise = this.doInference(request, abortController.signal);
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
      this._state = { status: 'ready', toolResults: this._state.completed, stream: this._state.stream };
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
   * This is the single source of truth for request assembly, shared by the
   * real activation path (`startStreamWithInjections`) and debug/preview
   * tooling (`Framework.previewActivation`). It is pure and non-mutating:
   * it does not touch agent state and does not call the membrane, and
   * `ContextManager.compile` is itself side-effect-free (compression runs in
   * the background). Safe to call regardless of the agent's current status.
   */
  async buildActivationRequest(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget
  ): Promise<NormalizedRequest> {
    // Keep the context manager's view of the live tool surface current: the
    // autobiographical strategy must declare the same tools on its
    // summarizer/compression requests, or transcripts containing tool blocks
    // are refused by Anthropic's reasoning_extraction classifier (labclaude
    // incident, 2026-07-09). Optional chaining: older context-manager
    // versions don't have the hook.
    (this.contextManager as unknown as { setToolDefinitions?: (t: ToolDefinition[]) => void })
      .setToolDefinitions?.(availableTools);

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
    let { messages, systemInjections } = await this.compileWithInjections(
      budget,
      injections,
      immutablePrefixHash ? { kvUnifiedImmutablePrefixHash: immutablePrefixHash } : undefined,
    );

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
    messages = messages
      .map((m) => ({
        ...m,
        content: m.content.filter(
          // typeof guard is deliberate runtime defense: history loaded from
          // disk can carry a non-string `text` despite what the types claim.
          (b: ContentBlock) => !(b.type === "text" && (typeof b.text !== "string" || b.text.trim() === "")),
        ),
      }))
      .filter((m) => m.content.length > 0);

    // Safety: ensure messages don't end with an assistant message.
    // Some models reject trailing assistant messages ("prefill not supported"),
    // and after context compression a stale assistant turn can end up last.
    if (messages.length > 0 && messages[messages.length - 1]!.participant === this.name) {
      messages = [...messages, {
        participant: 'user',
        content: [{ type: 'text', text: '[Continue]' }],
      }];
    }

    return {
      messages,
      system: this.buildSystemPrompt(systemInjections),
      config: {
        model: this.model,
        maxTokens: this.maxTokens,
        ...(this.temperature !== undefined && { temperature: this.temperature }),
        ...(this.thinking !== undefined && { thinking: this.thinking }),
      },
      tools: availableTools.length > 0 ? availableTools : undefined,
      promptCaching: this.promptCaching,
      ...(kvUnified ? { cacheMarkers: 'cm-owned' as const } : {}),
      cacheTtl: this.cacheTtl,
      ...(this.prefillUserMessage && { prefillUserMessage: this.prefillUserMessage }),
      ...(this.providerParams && { providerParams: this.providerParams }),
      assistantParticipant: this.name,
    };
  }

  /**
   * Start a yielding stream with context injections.
   * Same as startStream but passes injections through to compile.
   */
  async startStreamWithInjections(
    availableTools: ToolDefinition[],
    injections?: ContextInjection[],
    budget?: TokenBudget
  ): Promise<StartStreamResult> {
    if (this._state.status !== 'idle') {
      throw new Error(`Agent ${this.name} cannot start stream in state ${this._state.status}`);
    }

    this._streamId++;
    this._inferenceStartedAt = Date.now();
    this.lastStreamInputTokens = 0;
    // Reset the cache-inclusive counters too: a new stream must not inherit
    // the prior stream's window size — on the physical-window restart path
    // that inherited value IS the oversized number that caused the restart,
    // and projecting on it before this stream's first usage event would
    // restart again (loop). The `> 0` guard downstream means "no usage
    // observed on THIS stream yet" only because of this reset.
    this.lastStreamRealInputTokens = 0;
    this.lastStreamOutputTokens = 0;

    const request = await this.buildActivationRequest(availableTools, injections, budget);

    const receiptAware = (this.contextManager as unknown as { getStrategy?: () => unknown })
      .getStrategy?.() as {
      beginKvUnifiedSubmission?: (args: { submissionId: string; requestHash: string; layoutHash: string }) => void;
      isKvUnifiedEnabled?: () => boolean;
    };
    const kvEnabled = receiptAware?.isKvUnifiedEnabled?.() === true;
    const kvQueue: Array<{ submissionId: string; wireReceipt: CacheWireReceipt }> = [];
    let kvCall = 0;
    if (kvEnabled) {
      const layoutHash = stableHash(request.messages);
      request.onCacheWireReceipt = (receipt) => {
        const submissionId = `${this.name}:${this._streamId}:${Date.now()}:${kvCall++}`;
        receiptAware.beginKvUnifiedSubmission!({
          submissionId,
          requestHash: receipt.requestHash,
          layoutHash,
        });
        kvQueue.push({ submissionId, wireReceipt: receipt });
      };
    }

    const stream = this.membrane.streamYielding(request, {
      emitTokens: true,
      emitBlocks: false,
      emitUsage: true,
      // Retry a content-policy refusal at the provider seam rather than at
      // the framework level: membrane replays the SAME request immediately
      // (cache-warm), where a framework-level requeue would recompile and
      // land a different window. The framework's driveStream handles the
      // resulting `retrying` event by discarding the abandoned attempt.
      ...(this.refusalHandling?.retries ? { refusalRetries: this.refusalHandling.retries } : {}),
    });

    this._state = { status: 'streaming', stream };
    return {
      stream,
      request,
      ...(kvEnabled
        ? {
            takeKvSubmission: () => kvQueue.shift(),
            drainKvSubmissionIds: () => kvQueue.splice(0).map((item) => item.submissionId),
          }
        : {}),
    };
  }

  /**
   * Transition to waiting_for_tools when stream yields tool calls.
   * Called by framework's driveStream.
   */
  enterWaitingForTools(calls: ToolCall[], stream: YieldingStream): void {
    const pending = new Map<ToolCallId, PendingToolCall>();
    for (const call of calls) {
      pending.set(call.id, {
        id: call.id,
        name: call.name,
        input: call.input,
        startedAt: Date.now(),
      });
    }
    this._state = { status: 'waiting_for_tools', pending, completed: [], stream };
  }

  /**
   * Add an assistant response to context.
   * Called by framework when stream completes.
   */
  addAssistantResponse(content: ContentBlock[]): void {
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
      return;
    }
    this.contextManager.addMessage(this.name, content);
  }

  /**
   * Transition back to streaming state after tool results are provided.
   */
  setStreaming(stream: YieldingStream): void {
    this._state = { status: 'streaming', stream };
  }

  /**
   * Cancel any active stream and reset to idle.
   */
  cancelStream(): void {
    if (this._state.status === 'streaming') {
      this._state.stream.cancel();
    } else if (this._state.status === 'waiting_for_tools' && this._state.stream) {
      this._state.stream.cancel();
    }
    this._state = { status: 'idle' };
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
   * Build the effective system prompt, appending any system-position injections.
   */
  private buildSystemPrompt(systemInjections: ContentBlock[]): string {
    if (systemInjections.length === 0) {
      return this.systemPrompt;
    }

    const injectedText = systemInjections
      .filter((block): block is ContentBlock & { type: 'text' } => block.type === 'text')
      .map((block) => block.text);

    if (injectedText.length === 0) {
      return this.systemPrompt;
    }

    return this.systemPrompt + '\n' + injectedText.join('\n');
  }

  abortInference(reason?: string): { aborted: true; durationMs: number } | false {
    if (this._state.status === 'inferring') {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this._state.abortController.abort(reason);
      return { aborted: true, durationMs };
    }

    if (this._state.status === 'streaming' ||
        (this._state.status === 'waiting_for_tools' && this._state.stream)) {
      const durationMs = Date.now() - this._inferenceStartedAt;
      this.cancelStream();
      return { aborted: true, durationMs };
    }

    return false;
  }

  private async doInference(
    request: NormalizedRequest,
    signal?: AbortSignal
  ): Promise<InferenceResult> {
    const response = await this.membrane.stream(request, { signal });

    if (isAbortedResponse(response)) {
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

    const { toolCalls, speechContent } = this.extractToolCallsAndSpeech(response.content);

    // Add assistant response to context
    this.contextManager.addMessage(this.name, response.content);

    return {
      toolCalls,
      speechContent,
      raw: response.raw,
      usage: response.usage,
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
    const content = results.map((r) => ({
      type: 'tool_result' as const,
      toolUseId: r.id,
      content: r.result.isError
        ? truncateForHistory(r.result.error ?? 'Unknown error', DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS)
        : toolResultDataToHistoryString(r.result.data, DEFAULT_TOOL_RESULT_INLINE_MAX_CHARS),
      isError: r.result.isError,
    }));

    return [{
      participant: 'user',
      content,
    }];
  }
}
