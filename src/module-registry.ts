import type { JsStateRegistration, JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import type {
  MessageId,
  MessageMetadata,
  MessageQuery,
  ContextInjection,
} from '@animalabs/context-manager';
import type {
  Module,
  ModuleContext,
  ProcessState,
  ProcessQueue,
  ToolDefinition,
  ToolCall,
  ToolResult,
  AgentInfo,
  ExternalIdRef,
  SpeechContext,
  SpeechHandlerOptions,
  ProcessEvent,
  TraceEventListener,
  ModuleMessage,
  MessageQueryResult,
} from './types/index.js';
import { heldWriteId } from './held-writes.js';
import type { Agent } from './agent.js';
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, validateShutdownTimeout, waitForShutdown } from './shutdown.js';
import { logValue } from './mcpl/log-value.js';
import { toolArgsProblems } from './tool-args.js';

/** How the registry queues a module's event: its push names the module. A
 * `ProcessQueue` serves too, ignoring the name. */
export interface ModuleQueue {
  push(event: ProcessEvent, moduleName?: string): void;
}

const MODULE_STATE_PREFIX = 'modules/';

/**
 * True when a registerState failure means "this state id already exists" —
 * the one failure that is safe to swallow on an idempotent re-registration.
 * Anything else (closed store, IO error) must propagate: swallowing it defers
 * the real error to a later write with far worse context.
 */
export function isStateExistsError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('State already exists');
}

/**
 * Register a state, treating "already exists" as done: a store reopened after
 * a restart already holds it. Every other failure is thrown here, where it
 * happened, naming the state, with the store's own error as its cause. Each
 * state the framework registers goes through this.
 */
export function ensureStateRegistered(
  store: Pick<JsStore, 'registerState'>,
  registration: JsStateRegistration,
): void {
  try {
    store.registerState(registration);
  } catch (error) {
    if (isStateExistsError(error)) return;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Registering state '${registration.id}' failed: ${reason}`, { cause: error });
  }
}

/**
 * Hard ceiling for a single module's gatherContext budget, regardless of the
 * `contextTimeoutMs` it declares. gatherContext runs on the critical path of
 * every inference turn, so an unbounded self-declared budget would let one
 * wedged module stall every agent. 30s is generous for legitimate work (e.g. a
 * retrieval module's sequential LLM calls) while keeping the worst case bounded.
 */
const MAX_CONTEXT_TIMEOUT_MS = 30_000;

/**
 * Bound on each module's onToolBatchComplete. The hook runs inside the
 * framework's sequential event loop, so a wedged module would stall every
 * agent's events, not just its own round; past this the round goes on without
 * it. A module with its own semantic deadline (the workspace scan's) sets it
 * below this one, so it can record the miss itself.
 */
export const TOOL_BATCH_HOOK_TIMEOUT_MS = 30_000;

/**
 * Registered speech handler.
 */
interface SpeechHandler {
  moduleName: string;
  agents: '*' | string[];
  priority: number;
}


/**
 * Registry for managing modules.
 */
export class ModuleRegistry {
  /** Each module's tool-batch hook still running, past its bound or not. */
  private batchHooksRunning = new Map<string, Promise<unknown>>();

  private modules: Map<string, Module> = new Map();
  private stopping = new Map<Module, Promise<void>>();
  /** Module and namespace pairs already told that a system injection held a block that isn't text. */
  private notShownWarned = new Set<string>();
  private moduleContexts: Map<string, ModuleContextImpl> = new Map();
  private speechHandlers: SpeechHandler[] = [];
  private store: JsStore;
  private queue: ModuleQueue;
  private getAgents: () => Agent[];
  private addMessageFn: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId;
  private editMessageFn: (id: MessageId, content: ContentBlock[]) => void;
  private removeMessageFn: (id: MessageId) => void;
  private getMessageFn: (id: MessageId) => ModuleMessage | null;
  private queryMessagesFn: (filter: MessageQuery) => MessageQueryResult;

  private pushEventFn: (event: ProcessEvent, moduleName?: string) => void;
  private onTraceFn: (listener: TraceEventListener) => () => void;
  private callToolFn: (call: ToolCall) => Promise<ToolResult>;
  /** Framework ops-alert channel, surfaced to modules via
   *  ModuleContext.notifyOps. Readonly-public so ModuleContextImpl can
   *  delegate without another positional constructor parameter. */
  readonly notifyOpsFn?: (
    kind: string,
    agentName: string,
    message: string,
    data?: Record<string, unknown>,
  ) => void;

  constructor(
    store: JsStore,
    queue: ModuleQueue,
    options: {
      getAgents: () => Agent[];
      addMessage: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId;
      editMessage: (id: MessageId, content: ContentBlock[]) => void;
      removeMessage: (id: MessageId) => void;
      getMessage: (id: MessageId) => ModuleMessage | null;
      queryMessages: (filter: MessageQuery) => MessageQueryResult;
      /** Called with the pushing module's name. */
      pushEvent: (event: ProcessEvent, moduleName?: string) => void;
      onTrace: (listener: TraceEventListener) => () => void;
      callTool: (call: ToolCall) => Promise<ToolResult>;
      notifyOps?: (kind: string, agentName: string, message: string, data?: Record<string, unknown>) => void;
    }
  ) {
    this.store = store;
    this.queue = queue;
    this.getAgents = options.getAgents;
    this.addMessageFn = options.addMessage;
    this.editMessageFn = options.editMessage;
    this.removeMessageFn = options.removeMessage;
    this.getMessageFn = options.getMessage;
    this.queryMessagesFn = options.queryMessages;
    this.pushEventFn = options.pushEvent;
    this.onTraceFn = options.onTrace;
    this.callToolFn = options.callTool;
    this.notifyOpsFn = options.notifyOps;
  }

  /**
   * Register and start a module.
   */
  async addModule(module: Module): Promise<void> {
    if (this.modules.has(module.name)) {
      throw new Error(`Module already registered: ${module.name}`);
    }

    // Register module state in store
    const stateId = this.getStateId(module.name);
    ensureStateRegistered(this.store, { id: stateId, strategy: 'snapshot' });

    // Check if this is a restart (state exists)
    const existingState = this.store.getStateJson(stateId);
    const isRestart = existingState !== null;

    // Create context
    const context = new ModuleContextImpl(
      module.name,
      this.store,
      stateId,
      this.queue,
      this,
      isRestart,
      this.getAgents,
      this.addMessageFn,
      this.editMessageFn,
      this.removeMessageFn,
      this.getMessageFn,
      this.queryMessagesFn,
      this.pushEventFn,
      this.onTraceFn,
      this.callToolFn
    );

    this.modules.set(module.name, module);
    this.moduleContexts.set(module.name, context);

    // Start the module
    await module.start(context);
  }

  /**
   * Stop and unregister a module.
   */
  async removeModule(name: string): Promise<void> {
    const module = this.modules.get(name);
    if (!module) {
      throw new Error(`Module not found: ${name}`);
    }

    await this.stopModule(module);
  }

  /**
   * Get a module by name.
   */
  getModule<T extends Module>(name: string): T | null {
    return (this.modules.get(name) as T) ?? null;
  }

  /**
   * Get all registered modules.
   */
  getAllModules(): Module[] {
    return Array.from(this.modules.values());
  }

  /**
   * Set state for a module by name.
   * Used by the framework to apply stateUpdate from EventResponse atomically.
   */
  setModuleState(moduleName: string, state: unknown): void {
    const ctx = this.moduleContexts.get(moduleName);
    if (ctx) {
      ctx.setState(state);
    }
  }

  /**
   * Get state for a module by name.
   */
  getModuleState<T>(moduleName: string): T | null {
    const ctx = this.moduleContexts.get(moduleName);
    if (ctx) {
      return ctx.getState<T>();
    }
    return null;
  }

  /**
   * Create a ProcessState for a module to use during event processing.
   */
  createProcessState(moduleName: string): ProcessState {
    const ctx = this.moduleContexts.get(moduleName);
    if (!ctx) {
      throw new Error(`Module ${moduleName} not found`);
    }
    return new ProcessStateImpl(moduleName, ctx, this);
  }

  /**
   * Get all available tools from all modules.
   */
  getAllTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const module of this.modules.values()) {
      for (const tool of module.getTools()) {
        tools.push({
          ...tool,
          name: `${module.name}--${tool.name}`,
        });
      }
    }
    return tools;
  }

  /**
   * All utilities from all modules, namespaced exactly like tools
   * (`module--name`). See Module.getUtilities — these are deliberately kept
   * out of the model-facing tool list and surfaced through the framework's
   * `utils` meta-tool; dispatch goes through the same handleToolCall.
   */
  getAllUtilities(): ToolDefinition[] {
    const utilities: ToolDefinition[] = [];
    for (const module of this.modules.values()) {
      for (const util of module.getUtilities?.() ?? []) {
        utilities.push({
          ...util,
          name: `${module.name}--${util.name}`,
        });
      }
    }
    return utilities;
  }

  /**
   * A module tool's call for a path that stores or sends its result: the
   * model's dispatch, a script's inner call, the `utils` meta-tool for a
   * model. The result is checked and read once, in its JSON form
   * ({@link storableToolResult}).
   */
  async storableToolCall(call: ToolCall, options: { definition?: ToolDefinition } = {}): Promise<ToolResult> {
    return storableToolResult(call, await this.handleToolCall(call, options));
  }

  /**
   * Handle a tool call by routing to the appropriate module: the module's own
   * result, unchecked, as it returned it, for a caller that uses the result
   * in process (`ModuleContext.callTool`, `executeToolCall`, or a host
   * calling the registry). A module's throw is answered as an error result.
   * A call whose input isn't an object, or lacks a key the tool's schema
   * requires, is answered before the module runs, with an error result that
   * opens "Nothing was done:" and names what to send (toolArgsProblems).
   * A caller that has already resolved the tool's definition, as the `utils`
   * tool has a utility's, passes it as `definition`, and it's checked against
   * that one.
   */
  async handleToolCall(call: ToolCall, options: { definition?: ToolDefinition } = {}): Promise<ToolResult> {
    // Parse module--tool name
    const sepIndex = call.name.indexOf('--');
    if (sepIndex === -1) {
      return {
        success: false,
        error: `Invalid tool name format: ${call.name}`,
        isError: true,
      };
    }

    const moduleName = call.name.substring(0, sepIndex);
    const toolName = call.name.substring(sepIndex + 2);

    const module = this.modules.get(moduleName);
    if (!module) {
      return {
        success: false,
        error: `Module not found: ${moduleName}`,
        isError: true,
      };
    }

    // The call as it came, with the un-prefixed name: the caller's identity
    // and everything else the dispatch set on it reach the module.
    const moduleCall: ToolCall = { ...call, name: toolName };

    try {
      // The call against the tool's declared schema, before the module runs:
      // a missing required argument is refused with what to send, where the
      // handler would otherwise fail deep inside, or run without it. Values
      // aren't checked here, since a handler may take more than its schema
      // can say (toolArgsProblems). The module's own listing runs inside the
      // try, so its throw is answered like any other. Utilities are listed
      // only for a name the tools don't have, so a utility listing that
      // throws or is slow reaches only calls to such names: a utility called
      // by its own name, and a name the module answers without declaring it.
      // A caller that passes `definition` lists nothing.
      const definition = options.definition
        ?? module.getTools().find((tool) => tool.name === toolName)
        ?? module.getUtilities?.()?.find((tool) => tool.name === toolName);
      const problems = toolArgsProblems(call.input, definition?.inputSchema);
      if (problems.length > 0) {
        return {
          success: false,
          error: `Nothing was done: ${call.name} ${problems.join('; ')}.`,
          isError: true,
        };
      }
      return await module.handleToolCall(moduleCall);
    } catch (error) {
      return thrownResult(error);
    }
  }

  /**
   * Stop all modules. A caller may bound its wait without cancelling cleanup.
   * The default waits for each module's own shutdown contract.
   */
  async stopAll(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    validateShutdownTimeout(timeoutMs);
    await waitForShutdown(Array.from(this.modules.values(), module => ({
      label: `module:${module.name}`, promise: this.stopModule(module),
    })), timeoutMs);
  }

  private stopModule(module: Module): Promise<void> {
    const existing = this.stopping.get(module);
    if (existing) return existing;
    const attempt = Promise.resolve().then(() => module.stop()).then(() => {
      if (this.modules.get(module.name) === module) {
        this.modules.delete(module.name);
        this.moduleContexts.delete(module.name);
        this.speechHandlers = this.speechHandlers.filter(handler => handler.moduleName !== module.name);
      }
      this.stopping.delete(module);
    }, error => {
      this.stopping.delete(module);
      throw error;
    });
    this.stopping.set(module, attempt);
    return attempt;
  }

  /**
   * Register a module as a speech handler.
   */
  registerSpeechHandler(
    moduleName: string,
    agents: '*' | string[],
    options: SpeechHandlerOptions = {}
  ): void {
    const priority = options.priority ?? 0;

    if (!options.additive) {
      // Remove existing handlers for this module
      this.speechHandlers = this.speechHandlers.filter(
        (h) => h.moduleName !== moduleName
      );
    }

    this.speechHandlers.push({ moduleName, agents, priority });

    // Sort by priority (higher first)
    this.speechHandlers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Unregister a module as a speech handler.
   */
  unregisterSpeechHandler(moduleName: string): void {
    this.speechHandlers = this.speechHandlers.filter(
      (h) => h.moduleName !== moduleName
    );
  }

  /**
   * Gather context injections from all modules before inference.
   * Calls each module's gatherContext() in parallel with a per-module timeout.
   * Fail-open: timed-out or erroring modules are skipped (with a stderr line).
   *
   * The per-module budget is `module.contextTimeoutMs` when declared, else the
   * `timeoutMs` default (15s). Modules whose gatherContext does real work —
   * e.g. a retrieval module making sequential LLM calls with backoff — should
   * declare a larger `contextTimeoutMs` rather than silently losing their
   * injection every turn to the shared default. The declared value is clamped
   * to MAX_CONTEXT_TIMEOUT_MS so no single module can hold every turn hostage.
   * Adapted from Anarchid/agent-framework@mcpl-module-proto.
   */
  async gatherContext(agentName: string, timeoutMs = 15_000): Promise<ContextInjection[]> {
    const injections: ContextInjection[] = [];
    const promises: Promise<void>[] = [];

    for (const module of this.modules.values()) {
      if (!module.gatherContext) continue;

      // Clamp the per-module budget. A module declaring `contextTimeoutMs`
      // legitimately needs more than the shared default (e.g. a retrieval
      // module doing sequential LLM calls), but it must not be able to hold
      // EVERY inference turn of EVERY agent hostage: the fail-open contract is
      // "a wedged module never blocks inference for long", so cap the wait.
      const budgetMs = Math.min(
        module.contextTimeoutMs ?? timeoutMs,
        MAX_CONTEXT_TIMEOUT_MS,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const promise = Promise.race([
        module.gatherContext(agentName).then(r => {
          injections.push(...r);
          this.noteBlocksNotShown(module.name, r);
        }),
        new Promise<void>((_, rej) => {
          timer = setTimeout(
            () => rej(new Error(`gatherContext timed out after ${budgetMs}ms`)),
            budgetMs,
          );
        }),
      ])
        .catch(err => console.error(`[${module.name}] gatherContext:`, err))
        .finally(() => clearTimeout(timer));

      promises.push(promise as Promise<void>);
    }

    await Promise.all(promises);
    return injections;
  }

  /**
   * The system prompt is text, so an agent given a `system` injection reads
   * a line in place of each of its blocks that isn't text (the agent's
   * buildSystemPrompt), though `ContextInjection`'s content may be any
   * block. The module meant those blocks for the model, so its operator is
   * told, once per module and namespace, as the module's injections are
   * gathered, whichever agents are given them.
   */
  private noteBlocksNotShown(moduleName: string, injections: ContextInjection[]): void {
    for (const injection of injections) {
      if (injection.position !== 'system' || !injection.content.some((block) => block.type !== 'text')) continue;
      const key = `${moduleName}\u0000${injection.namespace}`;
      if (this.notShownWarned.has(key)) continue;
      this.notShownWarned.add(key);
      console.error(
        `[${moduleName}] gatherContext: a system injection in namespace ${logValue(injection.namespace)} holds a block that ` +
          "isn't text, which the system prompt can't carry, so an agent given the injection reads a line in place of each such block; " +
          'this line prints once per module and namespace while the host runs',
      );
    }
  }

  /**
   * Tell modules an agent's tool batch completed (see
   * Module.onToolBatchComplete). Hooks run in parallel, each awaited up to
   * `timeoutMs`; a hook that throws or times out is logged and skipped, so a
   * wedged module can't hold the round. Returns the modules that didn't
   * finish, for the caller's trace.
   */
  async notifyToolBatchComplete(
    agentName: string,
    timeoutMs = TOOL_BATCH_HOOK_TIMEOUT_MS,
  ): Promise<Array<{ module: string; error: string }>> {
    const failures: Array<{ module: string; error: string }> = [];
    const promises: Promise<void>[] = [];
    for (const module of this.modules.values()) {
      if (!module.onToolBatchComplete) continue;
      // A hook still running from an earlier batch (it outlasted its bound)
      // isn't called again or waited for: a wedged module costs one bound,
      // not one per batch.
      if (this.batchHooksRunning.has(module.name)) {
        failures.push({ module: module.name, error: 'still running from an earlier batch' });
        continue;
      }
      // Called from a promise, so a hook that throws synchronously, before
      // returning its promise, is caught below like any other failure
      // instead of escaping the round (the result would never be provided).
      const call = Promise.resolve().then(() => module.onToolBatchComplete!(agentName));
      this.batchHooksRunning.set(module.name, call);
      const settled = (): void => {
        if (this.batchHooksRunning.get(module.name) === call) this.batchHooksRunning.delete(module.name);
      };
      call.then(settled, settled);
      let timer: ReturnType<typeof setTimeout> | undefined;
      promises.push(
        Promise.race([
          call,
          new Promise<void>((_, rej) => {
            timer = setTimeout(() => rej(new Error(`onToolBatchComplete timed out after ${timeoutMs}ms`)), timeoutMs);
          }),
        ])
          .catch((err: unknown) => {
            const error = err instanceof Error ? err.message : String(err);
            failures.push({ module: module.name, error });
            console.error(`[${module.name}] onToolBatchComplete:`, err);
          })
          .finally(() => clearTimeout(timer)),
      );
    }
    await Promise.all(promises);
    return failures;
  }

  /**
   * Dispatch speech to registered handlers.
   */
  async dispatchSpeech(
    agentName: string,
    content: ContentBlock[],
    context: SpeechContext
  ): Promise<void> {
    // Find handlers that match this agent
    const handlers = this.speechHandlers.filter(
      (h) => h.agents === '*' || h.agents.includes(agentName)
    );

    // Call each handler
    for (const handler of handlers) {
      const module = this.modules.get(handler.moduleName);
      if (module?.onAgentSpeech) {
        try {
          await module.onAgentSpeech(agentName, content, context);
        } catch (error) {
          console.error(
            `Speech handler ${handler.moduleName} error:`,
            error
          );
        }
      }
    }
  }

  private getStateId(moduleName: string): string {
    return `${MODULE_STATE_PREFIX}${moduleName}/state`;
  }
}

/**
 * Implementation of ModuleContext.
 */
class ModuleContextImpl implements ModuleContext {
  private moduleName: string;
  private store: JsStore;
  private stateId: string;
  readonly queue: ProcessQueue;
  private registry: ModuleRegistry;
  readonly isRestart: boolean;
  private getAgentsFn: () => Agent[];
  private addMessageFn: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId;
  private editMessageFn: (id: MessageId, content: ContentBlock[]) => void;
  private removeMessageFn: (id: MessageId) => void;
  private getMessageFn: (id: MessageId) => ModuleMessage | null;
  private queryMessagesFn: (filter: MessageQuery) => MessageQueryResult;
  private pushEventFn: (event: ProcessEvent, moduleName?: string) => void;
  private onTraceFn: (listener: TraceEventListener) => () => void;
  private callToolFn: (call: ToolCall) => Promise<ToolResult>;

  // External ID mapping stored in module state
  private externalIdMap: Map<string, MessageId> = new Map();

  constructor(
    moduleName: string,
    store: JsStore,
    stateId: string,
    queue: ModuleQueue,
    registry: ModuleRegistry,
    isRestart: boolean,
    getAgents: () => Agent[],
    addMessage: (participant: string, content: ContentBlock[], metadata?: MessageMetadata) => MessageId,
    editMessage: (id: MessageId, content: ContentBlock[]) => void,
    removeMessage: (id: MessageId) => void,
    getMessage: (id: MessageId) => ModuleMessage | null,
    queryMessages: (filter: MessageQuery) => MessageQueryResult,
    pushEvent: (event: ProcessEvent, moduleName?: string) => void,
    onTrace: (listener: TraceEventListener) => () => void,
    callTool: (call: ToolCall) => Promise<ToolResult>
  ) {
    this.moduleName = moduleName;
    this.store = store;
    this.stateId = stateId;
    // The deprecated handle: a push names this module, as pushEvent() does.
    this.queue = { push: (event) => queue.push(event, moduleName) };
    this.registry = registry;
    this.isRestart = isRestart;
    this.getAgentsFn = getAgents;
    this.addMessageFn = addMessage;
    this.editMessageFn = editMessage;
    this.removeMessageFn = removeMessage;
    this.getMessageFn = getMessage;
    this.queryMessagesFn = queryMessages;
    this.pushEventFn = pushEvent;
    this.onTraceFn = onTrace;
    this.callToolFn = callTool;

    // Load external ID map from state if exists
    const state = this.getState<{ externalIdMap?: Record<string, string> }>();
    if (state?.externalIdMap) {
      this.externalIdMap = new Map(Object.entries(state.externalIdMap));
    }
  }

  getState<T>(): T | null {
    const state = this.store.getStateJson(this.stateId);
    return state as T | null;
  }

  setState<T>(state: T): void {
    // Merge external ID map into state
    const fullState = {
      ...(state as object),
      externalIdMap: Object.fromEntries(this.externalIdMap),
    };
    this.store.setStateJson(this.stateId, fullState);
  }

  /** Log-state names this context has registered (registerLogState is
   *  contract-required in start(), so this is populated before any use). */
  private registeredLogStates = new Set<string>();

  private logStateId(name: string): string {
    if (!name || name === 'state' || name.includes('/')) {
      throw new Error(
        `Invalid module log state name '${name}': must be non-empty, not 'state', and contain no '/'`
      );
    }
    return `${MODULE_STATE_PREFIX}${this.moduleName}/${name}`;
  }

  /**
   * Like logStateId, but only for names that went through registerLogState.
   * Chronicle happily appends to an unregistered state — it just never gets a
   * snapshot strategy, so every reconstruction replays the full op chain from
   * record one. A forgotten registration or a typo'd name in one call site
   * must be an immediate, attributable error, not a silent O(n²)-read trap.
   */
  private registeredLogStateId(name: string): string {
    if (!this.registeredLogStates.has(name)) {
      throw new Error(
        `Module log state '${name}' is not registered for module '${this.moduleName}' — ` +
        `call registerLogState('${name}') in start() before using it`
      );
    }
    return this.logStateId(name);
  }

  registerLogState(
    name: string,
    opts?: { deltaSnapshotEvery?: number; fullSnapshotEvery?: number }
  ): void {
    ensureStateRegistered(this.store, {
      id: this.logStateId(name),
      strategy: 'append_log',
      deltaSnapshotEvery: opts?.deltaSnapshotEvery ?? 100,
      fullSnapshotEvery: opts?.fullSnapshotEvery ?? 20,
    });
    this.registeredLogStates.add(name);
  }

  appendToLog<T>(name: string, item: T): void {
    this.store.appendToStateJson(this.registeredLogStateId(name), item);
  }

  editLogItem<T>(name: string, index: number, item: T): void {
    this.store.editStateItem(this.registeredLogStateId(name), index, Buffer.from(JSON.stringify(item)));
  }

  getLog<T>(name: string): T[] {
    const data = this.store.getStateJson(this.registeredLogStateId(name));
    return Array.isArray(data) ? (data as T[]) : [];
  }

  getLogLength(name: string): number {
    return this.store.getStateLen(this.registeredLogStateId(name)) ?? 0;
  }

  getModule<T extends Module>(name: string): T | null {
    return this.registry.getModule<T>(name);
  }

  onTrace(listener: TraceEventListener): () => void {
    return this.onTraceFn(listener);
  }

  callTool(call: ToolCall): Promise<ToolResult> {
    return this.callToolFn(call);
  }

  notifyOps(kind: string, agentName: string, message: string, data?: Record<string, unknown>): void {
    this.registry.notifyOpsFn?.(kind, agentName, message, data);
  }

  addMessage(
    participant: string,
    content: ContentBlock[],
    metadata?: MessageMetadata & { external?: ExternalIdRef }
  ): MessageId {
    const id = this.addMessageFn(participant, content, metadata);

    // Track external ID if provided. A write the framework holds keeps '',
    // as it did before held writes had handles: the map is module state an
    // earlier release reads back, and a handle is no id to it.
    // findMessageByExternalId finds the held write by its external id.
    if (metadata?.external) {
      const key = `${metadata.external.source}:${metadata.external.id}`;
      this.externalIdMap.set(key, heldWriteId(id) === undefined ? id : '');
      // Persist the mapping
      this.persistExternalIdMap();
    }

    return id;
  }

  editMessage(id: MessageId, content: ContentBlock[]): void {
    this.editMessageFn(id, content);
  }

  removeMessage(id: MessageId): void {
    this.removeMessageFn(id);
    // Clean up external ID mapping
    for (const [key, msgId] of this.externalIdMap) {
      if (msgId === id) {
        this.externalIdMap.delete(key);
        this.persistExternalIdMap();
        break;
      }
    }
  }

  findMessageByExternalId(source: string, externalId: string): MessageId | null {
    const key = `${source}:${externalId}`;
    const entry = this.externalIdMap.get(key);
    if (entry === undefined) return null;
    // A stored id answers while the store holds its row, and once the row is
    // gone the entry goes, as removeMessage drops it. The '' a held write
    // keeps here (addMessage) names no row, so the message is looked up in
    // the store by its external id, held rows included, and the first row
    // found is taken, as context-manager's findByExternalId takes it: a held
    // row answers by its handle and leaves the entry as it is, and a stored
    // row's id becomes the entry. With nothing found, '' stays, as earlier
    // releases kept it: in a module's start(), the writes the last process
    // held don't show yet, since create() restores them after the modules
    // start, and a write that shows later finds its entry.
    if (entry !== '') {
      if (this.getMessageFn(entry)) return entry;
      this.externalIdMap.delete(key);
      this.persistExternalIdMap();
      return null;
    }
    const row = this.queryMessagesFn({ source, externalIds: [externalId] }).messages[0];
    if (row?.held) return row.id;
    if (!row) return null;
    this.externalIdMap.set(key, row.id);
    this.persistExternalIdMap();
    return row.id;
  }

  getMessage(id: MessageId): ModuleMessage | null {
    return this.getMessageFn(id);
  }

  queryMessages(filter: MessageQuery): MessageQueryResult {
    return this.queryMessagesFn(filter);
  }

  getAgents(): AgentInfo[] {
    return this.getAgentsFn().map((a) => a.info);
  }

  getActiveTools(): ToolDefinition[] {
    return this.registry.getAllTools();
  }

  registerSpeechHandler(
    agents: '*' | string[],
    options?: SpeechHandlerOptions
  ): void {
    this.registry.registerSpeechHandler(this.moduleName, agents, options);
  }

  unregisterSpeechHandler(): void {
    this.registry.unregisterSpeechHandler(this.moduleName);
  }

  pushEvent(event: ProcessEvent): void {
    this.pushEventFn(event, this.moduleName);
  }

  private persistExternalIdMap(): void {
    const currentState = this.getState<object>() ?? {};
    this.setState({
      ...currentState,
      externalIdMap: Object.fromEntries(this.externalIdMap),
    });
  }
}

/**
 * Implementation of ProcessState - read-only state access during event processing.
 */
class ProcessStateImpl implements ProcessState {
  private moduleName: string;
  private ctx: ModuleContextImpl;
  private registry: ModuleRegistry;

  constructor(moduleName: string, ctx: ModuleContextImpl, registry: ModuleRegistry) {
    this.moduleName = moduleName;
    this.ctx = ctx;
    this.registry = registry;
  }

  getState<T>(): T | null {
    return this.ctx.getState<T>();
  }

  getModuleState<T>(name: string): T | null {
    return this.registry.getModuleState<T>(name);
  }

  findMessageByExternalId(source: string, externalId: string): MessageId | null {
    return this.ctx.findMessageByExternalId(source, externalId);
  }

  getAgents(): AgentInfo[] {
    return this.ctx.getAgents();
  }

  getActiveTools(): ToolDefinition[] {
    return this.ctx.getActiveTools();
  }

  get queue(): ProcessQueue {
    return this.ctx.queue;
  }

  pushEvent(event: ProcessEvent): void {
    this.ctx.pushEvent(event);
  }
}

/** A result's flags, which consumers read for their truth: booleans here. */
const RESULT_FLAGS = ['success', 'isError', 'endTurn'] as const;

/**
 * A module's tool result as the framework can store, send and trace it. A
 * module runs in the host's process, so it can return what JSON can't hold,
 * such as a cyclic object, a BigInt or a `toJSON` that throws, no result
 * object at all, or one whose getters or Proxy traps throw, or answer
 * differently each time they're read. Everything after this (the stored
 * history, the request sent to the model, traces, the tool-result guard's
 * audit record, a script's result) would throw on it, and the agent's turn
 * would never settle.
 *
 * So the result is read once, here, and this never throws. Each field a
 * consumer reads is read by name, so a result class's getters count, and any
 * other own field is kept, except a `toJSON`: consumers read a result's
 * fields, never a `toJSON` of the result. What's returned is the JSON form of
 * those fields, parsed, so every consumer holds plain data and no module code
 * runs again. It's taken where the framework stores or sends a result
 * ({@link ModuleRegistry.storableToolCall}). A caller that uses the result
 * in process (`ModuleContext.callTool`, `executeToolCall`) gets the module's
 * own result, as the module returned it ({@link ModuleRegistry.handleToolCall}).
 * The flags are booleans, read for their truth as consumers read them.
 * `error` is its text form, which is all a consumer reads of it, so an error
 * value JSON can't hold costs nothing. An error that says nothing (null,
 * false or empty) is left out, so the result reads as having no error text.
 *
 * A result that can't be read or converted becomes an error result naming the
 * tool, keeping the module's own error text and its `endTurn` when they could
 * be read. So does data that is a function or a symbol, which JSON leaves out
 * whole.
 */
export function storableToolResult(call: ToolCall, result: unknown): ToolResult {
  return checkedToolResult(call, result).result;
}

/**
 * {@link storableToolResult}, saying whether the module's result was usable:
 * read and converted (`usable`), or replaced by the error result naming the
 * tool. A caller that stores the result and hands the module's own result
 * back, as `puppetToolCall` does, hands back the error result instead when
 * there was nothing usable to store.
 */
export function checkedToolResult(call: ToolCall, result: unknown): { result: ToolResult; usable: boolean } {
  // What's been read so far, kept by an error result if a later read throws.
  let ownText: string | undefined;
  let endTurn = false;
  const unusable = (problem: string): { result: ToolResult; usable: boolean } => {
    const own = ownText ? `, with this error: ${ownText}` : '.';
    const error = `Tool '${call.name}' ${problem}. The call itself completed${own}`;
    console.error(`[tools] ${call.callerAgentName ? `agent ${call.callerAgentName}: ` : ''}${error}`);
    return { result: { success: false, isError: true, error, ...(endTurn ? { endTurn: true } : {}) }, usable: false };
  };
  const reasonOf = (error: unknown) => thrownText(error).split('\n')[0] || 'no reason given';
  try {
    if (!result || typeof result !== 'object' || Array.isArray(result) || result instanceof Error) {
      const what = result === undefined || result === null ? String(result)
        : Array.isArray(result) ? 'an array' : result instanceof Error ? 'an Error' : `a ${typeof result}`;
      if (result instanceof Error) ownText = errorText(result);
      return unusable(`returned ${what} instead of a result object, so there's nothing to store or send`);
    }
    const candidate = result as Record<string, unknown>;
    // No prototype, so an own field named like an inherited one is a field.
    const fields: Record<string, unknown> = Object.create(null);
    const read = (key: string) => { if (key in candidate) fields[key] = candidate[key]; };
    // endTurn first and the error's text next, so an error result keeps
    // whichever of them could be read when a later read throws.
    read('endTurn');
    endTurn = Boolean(fields.endTurn);
    read('error');
    ownText = errorText(fields.error);
    for (const key of ['success', 'isError', 'data']) read(key);
    for (const key of Object.keys(candidate)) {
      if (key !== 'toJSON' && !(key in fields)) fields[key] = candidate[key];
    }
    // The error is kept as its text, which consumers read; its value isn't.
    delete fields.error;
    // The flags are kept as their truth, which is all consumers read of them,
    // before anything is serialized, so a flag's own value (a BigInt, a
    // function, an object with a toJSON) neither breaks nor runs anything.
    for (const flag of RESULT_FLAGS) {
      if (fields[flag] !== undefined) fields[flag] = Boolean(fields[flag]);
    }
    // An error result reads as its error, so only a non-error result's data matters.
    if (!fields.isError && (typeof fields.data === 'function' || typeof fields.data === 'symbol')) {
      return unusable(`returned a ${typeof fields.data} as its data, which JSON leaves out, so there's nothing to store or send`);
    }
    let json: string;
    try {
      json = JSON.stringify(fields);
    } catch (error) {
      return unusable(`returned a result that can't be converted to JSON, so it can't be stored or sent (${reasonOf(error)})`);
    }
    const storable = JSON.parse(json) as Record<string, unknown>;
    if (ownText !== undefined) storable.error = ownText;
    return { result: storable as unknown as ToolResult, usable: true };
  } catch (error) {
    return unusable(`returned a result that can't be read, so it can't be stored or sent (${reasonOf(error)})`);
  }
}

/** A result's `error` as text, always a string or none: a string as it is,
 *  an `Error`'s message read the same way (a module's value, so not always a
 *  string), an object's own `message`, any other value's JSON, and a
 *  primitive JSON can't hold (a BigInt, a symbol) as its String(). None for a
 *  value that says nothing: absent, null, false or empty, which consumers
 *  then report as "Unknown error". */
function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null || error === false || error === '') return undefined;
  if (typeof error === 'string') return error;
  if (error instanceof Error) return errorText(error.message);
  const message = (error as { message?: unknown }).message;
  if (typeof message === 'string' && message) return message;
  try {
    const json = JSON.stringify(error) as string | undefined;
    if (json !== undefined) return json;
  } catch {
    // A cyclic or BigInt-holding value: nothing faithful to show as JSON.
  }
  if (typeof error !== 'object' && typeof error !== 'function') return thrownText(error);
  return 'an error value with no text form';
}

/** A module's throw, answered as an error result: its text, or none when it
 *  has none, so consumers say "Unknown error". */
export function thrownResult(error: unknown): ToolResult {
  const text = thrownText(error);
  return { success: false, isError: true, ...(text ? { error: text } : {}) };
}

/** A thrown value's whole text, always a string, for a result's error, and
 *  for a value that has none too. An `Error`'s message is a module's value,
 *  so it may not be a string: one that isn't is given its String(), and an
 *  absent one is empty. String() throws on an object without a prototype,
 *  and such a value is named as having no text form. */
function thrownText(value: unknown): string {
  try {
    if (!(value instanceof Error)) return String(value);
    const message: unknown = value.message;
    if (typeof message === 'string') return message;
    return message === undefined || message === null ? '' : String(message);
  } catch {
    return 'a value with no text form';
  }
}
