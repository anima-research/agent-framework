/**
 * Tool lifecycle (MCPL RFC-007): `tools/lifecycle` notifications about the
 * agent's tool calls, and the `tools/observe` filter a server sets on them.
 *
 * Authority is the grant plus host narrowing; a server's filter is interest
 * and only ever narrows. Per call and connection the host decides, in order
 * (RFC-007 §6.4):
 *
 *   1. reported at all?     grant `toolLifecycle.observe` + its narrowing
 *   2. reported to this server?  filter: first matching rule and its `report`
 *                           (no filter → yes)
 *   3. arguments requested? that rule's `input` (no filter → NO)
 *   4. arguments allowed?   grant `toolLifecycle.inputs` + its narrowing,
 *                           and never for `comms` or unclassed tools
 *   5. which fields, how large?  the rule's field selection, then the bound
 *
 * Tool RESULTS are never carried — no field for them exists here.
 *
 * Delivery is best-effort like `inference/lifecycle` (SPEC §10.5): one
 * terminal is attempted per opened call, to exactly the connections the
 * opening went to, unless their grant or narrowing no longer covers the call
 * (RFC-007 §4.5). A filter change never suppresses a terminal (§6.5).
 */

import { CapabilityGrant } from './capability-grant.js';
import { globMatch } from './tool-glob.js';
import { DEFAULT_INPUT_CLASSES, isToolClass, type ToolClass } from './tool-classes.js';

export const TOOL_LIFECYCLE_OBSERVE = 'toolLifecycle.observe';
export const TOOL_LIFECYCLE_INPUTS = 'toolLifecycle.inputs';

// ============================================================================
// Wire types
// ============================================================================

export type ToolPhase = 'pending' | 'started' | 'completed' | 'failed' | 'aborted';

/** `tools/lifecycle` params (Host → Server, Notification). RFC-007 §3. */
export interface ToolLifecycleParams {
  toolCallId: string;
  inferenceId: string;
  conversationId: string;
  tool: string;
  class: ToolClass[];
  serverId?: string;
  serverTool?: string;
  phase: ToolPhase;
  input?: Record<string, unknown>;
  inputAltered?: boolean;
  inputWithheld?: boolean;
  isError?: boolean;
  durationMs?: number;
}

export interface ToolObserveMatch {
  tool?: string;
  serverTool?: string;
  serverId?: string;
  conversationId?: string;
  class?: ToolClass;
}

/** One normalized `tools/observe` rule (RFC-007 §6.1). */
export interface ToolObserveRule {
  match: ToolObserveMatch;
  report: boolean;
  /** false = metadata only; true = all arguments; string[] = field paths. */
  input: boolean | string[];
}

// ============================================================================
// Host policy (config)
// ============================================================================

/**
 * A narrowing attached to one `toolLifecycle.*` grant entry (RFC-007 §4.3).
 * A call is inside it when it satisfies EVERY key stated. Patterns use the
 * RFC-007 §6.2 grammar.
 */
export interface ToolLifecycleNarrowing {
  /** Patterns over the model-facing tool name (`computer--*`). */
  tools?: string[];
  /** The tool's effective class must intersect this set. `'default'` is
   *  DEFAULT_INPUT_CLASSES (computer, shell, files, web, media, body). */
  classes?: ToolClass[] | 'default';
  /** Patterns over `conversationId` (the agent name in this host). */
  conversations?: string[];
}

/**
 * Per-server tool-lifecycle policy (`McplServerConfig.toolLifecycle`).
 *
 * Both capability paths are DENIED BY DEFAULT. Stating `observe` (even as
 * `{}`) or `inputs` here is the operator's explicit grant of that path, as
 * is naming it in `enabledCapabilities`. `inputs` is never unconditional:
 * without at least one `tools` or `classes` term it delivers no arguments
 * (RFC-007 §4.3).
 */
export interface ToolLifecycleConfig {
  observe?: ToolLifecycleNarrowing;
  inputs?: ToolLifecycleNarrowing;
  /** Serialized-size bound for `input` per notification. Default 16 KiB. */
  maxInputBytes?: number;
}

export const DEFAULT_MAX_INPUT_BYTES = 16 * 1024;

/** Accepted sizes for a `tools/observe` request (RFC-007 §6.6 asks hosts to
 *  accept at least 64 rules, 64 paths per rule, 256-character strings). */
export const TOOL_OBSERVE_LIMITS = {
  rules: 256,
  pathsPerRule: 256,
  stringLength: 256,
} as const;

// ============================================================================
// tools/observe parsing (RFC-007 §6.1, §6.6)
// ============================================================================

export type ToolObserveParseResult =
  | { ok: true; rules: ToolObserveRule[] | null }
  | { ok: false; message: string; data?: Record<string, unknown> };

const MATCH_KEYS = new Set(['tool', 'serverTool', 'serverId', 'conversationId', 'class']);
const RULE_KEYS = new Set(['match', 'report', 'input']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate `tools/observe` params. `rules` absent or null clears the filter
 * (`{ok, rules: null}`); `[]` is a valid filter that reports nothing. Unknown
 * members are REJECTED, not ignored: ignoring an unknown `match` member would
 * make a rule match more than its author wrote.
 */
export function parseToolObserveParams(params: unknown): ToolObserveParseResult {
  if (params === undefined || params === null) return { ok: true, rules: null };
  if (!isPlainObject(params)) return { ok: false, message: 'tools/observe params must be an object' };
  // Unknown members are rejected here too (MCP's own `_meta` excepted): a
  // misspelled `rules` must not read as "no rules" and silently clear a
  // restrictive filter.
  for (const key of Object.keys(params)) {
    if (key !== 'rules' && key !== '_meta') {
      return { ok: false, message: `tools/observe: unknown params member "${key}"` };
    }
  }
  const raw = params.rules;
  if (raw === undefined || raw === null) return { ok: true, rules: null };
  if (!Array.isArray(raw)) return { ok: false, message: 'tools/observe: rules must be an array or null' };
  if (raw.length > TOOL_OBSERVE_LIMITS.rules) {
    return { ok: false, message: `tools/observe: more than ${TOOL_OBSERVE_LIMITS.rules} rules`, data: { limit: 'rules' } };
  }

  const rules: ToolObserveRule[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = `rules[${i}]`;
    const rule = raw[i];
    if (!isPlainObject(rule)) return { ok: false, message: `tools/observe: ${at} must be an object` };
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) return { ok: false, message: `tools/observe: ${at} has unknown member "${key}"` };
    }
    if (!isPlainObject(rule.match)) return { ok: false, message: `tools/observe: ${at}.match must be an object` };

    const match: ToolObserveMatch = {};
    for (const [key, value] of Object.entries(rule.match)) {
      if (!MATCH_KEYS.has(key)) {
        return { ok: false, message: `tools/observe: ${at}.match has unknown member "${key}"` };
      }
      if (key === 'class') {
        if (!isToolClass(value)) return { ok: false, message: `tools/observe: ${at}.match.class is not a ToolClass` };
        match.class = value;
        continue;
      }
      if (typeof value !== 'string') return { ok: false, message: `tools/observe: ${at}.match.${key} must be a string` };
      if (value.length > TOOL_OBSERVE_LIMITS.stringLength) {
        return { ok: false, message: `tools/observe: ${at}.match.${key} is too long`, data: { limit: 'stringLength' } };
      }
      (match as Record<string, string>)[key] = value;
    }

    if (rule.report !== undefined && typeof rule.report !== 'boolean') {
      return { ok: false, message: `tools/observe: ${at}.report must be a boolean` };
    }

    let input: boolean | string[] = false;
    if (rule.input !== undefined) {
      if (typeof rule.input === 'boolean') {
        input = rule.input;
      } else if (Array.isArray(rule.input)) {
        if (rule.input.length > TOOL_OBSERVE_LIMITS.pathsPerRule) {
          return { ok: false, message: `tools/observe: ${at}.input has too many paths`, data: { limit: 'pathsPerRule' } };
        }
        const paths: string[] = [];
        for (const path of rule.input) {
          if (typeof path !== 'string' || path.length === 0) {
            return { ok: false, message: `tools/observe: ${at}.input must hold non-empty strings` };
          }
          if (path.length > TOOL_OBSERVE_LIMITS.stringLength) {
            return { ok: false, message: `tools/observe: ${at}.input path is too long`, data: { limit: 'stringLength' } };
          }
          paths.push(path);
        }
        input = paths;
      } else {
        return { ok: false, message: `tools/observe: ${at}.input must be a boolean or an array of field paths` };
      }
    }

    rules.push({ match, report: rule.report !== false, input });
  }
  return { ok: true, rules };
}

// ============================================================================
// Matching
// ============================================================================

/** What the host knows about one call, shared by every connection. */
export interface ToolCallDescriptor {
  /** Host-unique on every connection (RFC-007 §3). */
  toolCallId: string;
  inferenceId: string;
  conversationId: string;
  tool: string;
  class: ToolClass[];
  serverId?: string;
  serverTool?: string;
  input: unknown;
}

function anyGlob(patterns: readonly string[], subject: string): boolean {
  for (const p of patterns) if (globMatch(p, subject)) return true;
  return false;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Every stated key must hold. An unclassed tool never satisfies `classes`.
 * Policy comes from operator config (JSON recipes), so a key of the wrong
 * shape admits NOTHING rather than being read as absent — fail closed.
 */
function narrowingAdmits(n: ToolLifecycleNarrowing, call: ToolCallDescriptor): boolean {
  if (n.tools !== undefined && (!isStringArray(n.tools) || !anyGlob(n.tools, call.tool))) return false;
  if (n.classes !== undefined) {
    const classes = n.classes === 'default' ? DEFAULT_INPUT_CLASSES : n.classes;
    if (!Array.isArray(classes) || !call.class.some((c) => classes.includes(c))) return false;
  }
  if (n.conversations !== undefined
    && (!isStringArray(n.conversations) || !anyGlob(n.conversations, call.conversationId))) {
    return false;
  }
  return true;
}

/**
 * `observe` narrowing: absent means no narrowing (the grant is enough). A
 * value that is not a narrowing object (`false`, `null`, a string) admits
 * nothing: a setting that looks like "off" must never read as "everything".
 */
export function observeAdmits(config: ToolLifecycleConfig | undefined, call: ToolCallDescriptor): boolean {
  const n = config?.observe as unknown;
  if (n === undefined) return true;
  if (!isPlainObject(n)) return false;
  return narrowingAdmits(n as ToolLifecycleNarrowing, call);
}

/**
 * Does `inputs` narrowing say this call has no tool/class term at all? Such
 * an entry is unconditional and therefore treated as narrowed to NO tools
 * (RFC-007 §4.3 — the widest form is not producible by omission).
 */
export function inputsNarrowingIsUnconditional(n: ToolLifecycleNarrowing | undefined): boolean {
  if (!isPlainObject(n)) return true;
  const hasTools = Array.isArray(n.tools) && n.tools.length > 0;
  const hasClasses = n.classes === 'default' || (Array.isArray(n.classes) && n.classes.length > 0);
  return !hasTools && !hasClasses;
}

/** Class exclusions that no narrowing overrides (RFC-007 §4.3, §5.4). */
export function inputsExcludedByClass(call: ToolCallDescriptor): boolean {
  return call.class.length === 0 || call.class.includes('comms');
}

export function inputsAdmit(config: ToolLifecycleConfig | undefined, call: ToolCallDescriptor): boolean {
  const n = config?.inputs;
  if (inputsNarrowingIsUnconditional(n)) return false;
  if (inputsExcludedByClass(call)) return false;
  return narrowingAdmits(n!, call);
}

export function ruleMatches(match: ToolObserveMatch, call: ToolCallDescriptor): boolean {
  if (match.tool !== undefined && !globMatch(match.tool, call.tool)) return false;
  if (match.serverTool !== undefined && (call.serverTool === undefined || !globMatch(match.serverTool, call.serverTool))) {
    return false;
  }
  if (match.serverId !== undefined && (call.serverId === undefined || !globMatch(match.serverId, call.serverId))) {
    return false;
  }
  if (match.conversationId !== undefined && !globMatch(match.conversationId, call.conversationId)) return false;
  if (match.class !== undefined && !call.class.includes(match.class)) return false;
  return true;
}

// ============================================================================
// Arguments: field selection and bounding (RFC-007 §5.2, §6.3)
// ============================================================================

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Select field paths from an arguments object. `.` descends into nested
 * objects; a path ending on an object or array selects it whole; a path that
 * passes through a non-object or names a missing member selects nothing.
 * Selected members keep their place in the structure. Only OWN properties
 * are read and the output is built from null-prototype objects, so a path
 * like `__proto__.x` can neither read nor write a prototype.
 */
export function selectFields(input: Record<string, unknown>, paths: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null);
  for (const path of paths) {
    const segs = path.split('.');
    let src: unknown = input;
    let found = true;
    for (const seg of segs) {
      if (!isPlainObject(src) || !hasOwn(src, seg)) {
        found = false;
        break;
      }
      src = src[seg];
    }
    if (!found || src === undefined) continue;
    let dst = out;
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i];
      const next = hasOwn(dst, seg) ? dst[seg] : undefined;
      if (!isPlainObject(next)) {
        const fresh: Record<string, unknown> = Object.create(null);
        dst[seg] = fresh;
        dst = fresh;
      } else {
        dst = next;
      }
    }
    dst[segs[segs.length - 1]] = cloneJson(src);
  }
  // Round-trip to ordinary objects: the wire form is JSON either way, and
  // callers comparing with deepEqual expect Object prototypes.
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

const byteLength = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** Walk an object tree and collect every string leaf with its holder. */
function collectStrings(root: unknown): Array<{ holder: Record<string, unknown> | unknown[]; key: string | number; length: number }> {
  const out: Array<{ holder: Record<string, unknown> | unknown[]; key: string | number; length: number }> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => {
        if (typeof v === 'string') out.push({ holder: node, key: i, length: v.length });
        else visit(v);
      });
    } else if (isPlainObject(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') out.push({ holder: node, key: k, length: v.length });
        else visit(v);
      }
    }
  };
  visit(root);
  return out;
}

/** Cut a string to a prefix of at most `length` code units without leaving
 *  half a surrogate pair at the end. */
function prefixOf(s: string, length: number): string {
  let cut = s.slice(0, Math.max(0, length));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Bound `value` to `maxBytes` of serialized JSON (RFC-007 §5.2): first by
 * replacing the longest strings with prefixes of themselves, then by removing
 * the largest members. The result is always a JSON object. Returns null when
 * nothing meaningful fits — the caller withholds instead.
 */
export function boundInput(
  value: Record<string, unknown>,
  maxBytes: number,
): { value: Record<string, unknown>; altered: boolean } | null {
  if (byteLength(value) <= maxBytes) return { value, altered: false };
  const clone = cloneJson(value);

  const MIN_STRING = 32;
  for (let guard = 0; guard < 256; guard++) {
    const over = byteLength(clone) - maxBytes;
    if (over <= 0) return { value: clone, altered: true };
    const strings = collectStrings(clone).filter((s) => s.length > MIN_STRING);
    if (strings.length === 0) break;
    strings.sort((a, b) => b.length - a.length);
    const longest = strings[0];
    const current = (longest.holder as Record<string | number, string>)[longest.key];
    const target = Math.max(MIN_STRING, Math.min(Math.floor(current.length / 2), current.length - over));
    (longest.holder as Record<string | number, unknown>)[longest.key] = prefixOf(current, target);
  }

  // Still over: remove top-level members, largest first, in ONE pass (sizes
  // measured once; a running estimate decides when to stop). A member that
  // is itself a huge nested structure goes whole — what remains must be
  // meaningful, or the caller withholds.
  let total = byteLength(clone);
  const members = Object.keys(clone)
    .map((key) => ({ key, size: byteLength(key) + 1 + byteLength(clone[key]) + 1 }))
    .sort((a, b) => b.size - a.size);
  for (const { key, size } of members) {
    if (total <= maxBytes) break;
    delete clone[key];
    total -= size;
  }
  return byteLength(clone) <= maxBytes && Object.keys(clone).length > 0 ? { value: clone, altered: true } : null;
}

// ============================================================================
// Per-connection decision
// ============================================================================

/** What the emitter needs from a connection. */
export interface ToolLifecycleObserver {
  id: string;
  grant?: CapabilityGrant;
  toolObserveFilter?: ToolObserveRule[] | null;
  /** Increments at every transport boundary (reconnect). Terminals go only
   *  to the epoch the opening went to. Absent = 0. */
  transportEpoch?: number;
  sendToolLifecycle(params: ToolLifecycleParams): void;
}

function baseParams(call: ToolCallDescriptor, phase: ToolPhase): ToolLifecycleParams {
  return {
    toolCallId: call.toolCallId,
    inferenceId: call.inferenceId,
    conversationId: call.conversationId,
    tool: call.tool,
    class: [...call.class],
    ...(call.serverId !== undefined ? { serverId: call.serverId, serverTool: call.serverTool } : {}),
    phase,
  };
}

/**
 * The opening notification (`pending` or `started`) this connection should
 * receive for `call`, or null when it receives nothing. Steps 1–5 of
 * RFC-007 §6.4.
 */
export function openingFor(
  observer: ToolLifecycleObserver,
  config: ToolLifecycleConfig | undefined,
  call: ToolCallDescriptor,
  phase: 'pending' | 'started',
): ToolLifecycleParams | null {
  const grant = CapabilityGrant.of(observer);
  if (!grant.has(TOOL_LIFECYCLE_OBSERVE)) return null;
  // A connection's own tools: it already sees the call as tools/call (§7.1).
  if (call.serverId !== undefined && call.serverId === observer.id) return null;
  if (!observeAdmits(config, call)) return null;

  const filter = observer.toolObserveFilter ?? null;
  let requested: boolean | string[] = false; // no filter → metadata only (§5.1)
  if (filter) {
    const rule = filter.find((r) => ruleMatches(r.match, call));
    if (!rule || !rule.report) return null;
    requested = rule.input;
  }

  const params = baseParams(call, phase);
  if (phase !== 'started' || requested === false) return params;
  // Arguments were requested. Without the inputs grant the server learns
  // nothing more (no inputWithheld — §5.1).
  if (!grant.has(TOOL_LIFECYCLE_INPUTS)) return params;
  if (!inputsAdmit(config, call)) {
    params.inputWithheld = true;
    return params;
  }
  const args: Record<string, unknown> = isPlainObject(call.input) ? call.input : {};
  const selected = requested === true ? cloneJson(args) : selectFields(args, requested);
  const bounded = boundInput(selected, config?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES);
  if (!bounded) {
    params.inputWithheld = true;
    return params;
  }
  params.input = bounded.value;
  if (bounded.altered) params.inputAltered = true;
  return params;
}

/** Does this connection still get the terminal for a call it was opened to? */
export function terminalStillAllowed(
  observer: ToolLifecycleObserver,
  config: ToolLifecycleConfig | undefined,
  call: ToolCallDescriptor,
): boolean {
  return CapabilityGrant.of(observer).has(TOOL_LIFECYCLE_OBSERVE) && observeAdmits(config, call);
}

// ============================================================================
// The emitter
// ============================================================================

export interface ToolLifecycleHost {
  /** Every live connection that might observe. */
  observers(): Iterable<ToolLifecycleObserver>;
  /** Host policy for one connection. */
  configFor(serverId: string): ToolLifecycleConfig | undefined;
  /** Class and provider for a model-facing tool name. */
  describe(tool: string): { class: ToolClass[]; serverId?: string; serverTool?: string };
}

interface TrackedCall {
  agentName: string;
  modelCallId: string;
  call: ToolCallDescriptor;
  /** Connection id → transport epoch the opening went to. */
  openedTo: Map<string, number>;
  /** `started` has been sent (open() ran and the call was not refused). */
  opened: boolean;
  startedAt: number;
  /** The host could not obtain a result (a dispatch catch path). */
  failed: boolean;
}

/**
 * Provider identifiers trusted as unique (RFC-007 §3 rev 3: reuse the
 * model's id only where the provider guarantees it). Anthropic `tool_use`
 * ids are random and at least this long; everything else — per-response
 * counters like `call_0`, other providers' formats — is minted over.
 */
const PROVIDER_UNIQUE_ID = /^toolu_[A-Za-z0-9]{20,}$/;
const RECENT_ID_WINDOW = 8192;

const callKey = (agentName: string, callId: string): string => `${agentName}\u0000${callId}`;

export class ToolLifecycleEmitter {
  private readonly host: ToolLifecycleHost;
  private readonly now: () => number;
  /** Opened calls awaiting their terminal, keyed by (agent, model call id). */
  private readonly calls = new Map<string, TrackedCall>();
  private readonly recentIds = new Set<string>();
  private readonly recentOrder: string[] = [];
  private mintSeq = 0;

  constructor(host: ToolLifecycleHost, now: () => number = Date.now) {
    this.host = host;
    this.now = now;
  }

  /** Nothing observes: skip all work on the hot path. */
  private anyObserver(): boolean {
    for (const o of this.host.observers()) {
      if (CapabilityGrant.of(o).has(TOOL_LIFECYCLE_OBSERVE)) return true;
    }
    return false;
  }

  /**
   * A host-unique id for a call (RFC-007 §3): the model's own only where the
   * provider guarantees it unique and it was not reported recently; minted
   * otherwise. Minted ids carry a per-process counter, so they never repeat.
   */
  private hostCallId(modelCallId: string): string {
    let id = modelCallId;
    if (!PROVIDER_UNIQUE_ID.test(id) || this.recentIds.has(id)) {
      id = `${modelCallId}~h${(++this.mintSeq).toString(36)}`;
    }
    this.recentIds.add(id);
    this.recentOrder.push(id);
    if (this.recentOrder.length > RECENT_ID_WINDOW) {
      this.recentIds.delete(this.recentOrder.shift()!);
    }
    return id;
  }

  /**
   * A model-issued call is about to be dispatched. Recorded, keyed by
   * (agent, model call id) — never matched through the trace stream, so two
   * agents' identical short ids cannot cross — but nothing is sent yet: the
   * host may still refuse it (refuse()) before it executes.
   */
  register(agentName: string, inferenceId: string, call: { id: string; name: string; input: unknown }): void {
    if (!this.anyObserver()) return;
    const described = this.host.describe(call.name);
    this.calls.set(callKey(agentName, call.id), {
      agentName,
      modelCallId: call.id,
      call: {
        toolCallId: this.hostCallId(call.id),
        inferenceId,
        conversationId: agentName,
        tool: call.name,
        class: described.class,
        ...(described.serverId !== undefined
          ? { serverId: described.serverId, serverTool: described.serverTool }
          : {}),
        input: call.input,
      },
      openedTo: new Map(),
      opened: false,
      // Taken before dispatch, so durationMs includes work a synchronous
      // tool does inside dispatch (its `started` is sent only after).
      startedAt: this.now(),
      failed: false,
    });
  }

  /**
   * The host refused the call before executing it — its provider is gone,
   * host tool policy denies it, a conversation-bound agent reached outside
   * its channel. Called from the refusal site itself, synchronously within
   * dispatch, so the call is forgotten before open() would send anything:
   * a refused call produces no events (RFC-007 §3).
   */
  refuse(agentName: string, callId: string): void {
    const key = callKey(agentName, callId);
    const tracked = this.calls.get(key);
    if (tracked && !tracked.opened) this.calls.delete(key);
  }

  /**
   * Dispatch returned and the call was not refused: execution has begun.
   * Send `started` to every connection that should see it. Refusal sites
   * run synchronously inside dispatch, before this.
   */
  open(agentName: string, callId: string): void {
    const key = callKey(agentName, callId);
    const tracked = this.calls.get(key);
    if (!tracked || tracked.opened) return;
    tracked.opened = true;
    for (const observer of this.host.observers()) {
      let params: ToolLifecycleParams | null;
      try {
        params = openingFor(observer, this.host.configFor(observer.id), tracked.call, 'started');
      } catch (err) {
        console.error(`[mcpl] ${observer.id}: tools/lifecycle decision failed: ${(err as Error).message}`);
        continue;
      }
      if (!params) continue;
      try {
        observer.sendToolLifecycle(params);
        tracked.openedTo.set(observer.id, observer.transportEpoch ?? 0);
      } catch {
        /* best-effort */
      }
    }
    // Nobody received an opening, so nobody is owed a terminal.
    if (tracked.openedTo.size === 0) this.calls.delete(key);
  }

  /**
   * The host could not obtain a result for this call (its dispatch threw,
   * the provider's transport failed, the request timed out). Its terminal
   * will be `failed`. An error RESULT returned by the tool is not this: it
   * is `completed` with `isError` (RFC-007 §3).
   */
  markDispatchFailure(agentName: string, callId: string): void {
    const tracked = this.calls.get(callKey(agentName, callId));
    if (tracked) tracked.failed = true;
  }

  private terminate(tracked: TrackedCall, phase: 'completed' | 'failed' | 'aborted', isError?: boolean): void {
    this.calls.delete(callKey(tracked.agentName, tracked.modelCallId));
    const durationMs = Math.max(0, this.now() - tracked.startedAt);
    for (const observer of this.host.observers()) {
      const epoch = tracked.openedTo.get(observer.id);
      // Only the transport epoch the opening went to: a reconnected observer
      // never receives a terminal for an opening it did not see (§7.3).
      if (epoch === undefined || epoch !== (observer.transportEpoch ?? 0)) continue;
      if (!terminalStillAllowed(observer, this.host.configFor(observer.id), tracked.call)) continue;
      const params = baseParams(tracked.call, phase);
      if (phase === 'completed') params.isError = !!isError;
      params.durationMs = durationMs;
      try {
        observer.sendToolLifecycle(params);
      } catch {
        /* best-effort */
      }
    }
  }

  /** A tool result reached the host: the call's terminal. */
  onResult(agentName: string, callId: string, result: { success?: boolean; isError?: boolean } | undefined): void {
    if (this.calls.size === 0) return;
    const tracked = this.calls.get(callKey(agentName, callId));
    if (!tracked) return;
    if (!tracked.opened) {
      // Never opened (a path that bypassed open()): nothing was sent.
      this.calls.delete(callKey(agentName, callId));
      return;
    }
    if (tracked.failed) this.terminate(tracked, 'failed');
    else this.terminate(tracked, 'completed', result?.isError === true || result?.success === false);
  }

  /**
   * A stream ended: its calls still open were cancelled before a result.
   * Scoped to the inference ids that stream minted, so a successor stream
   * for the same agent (a budget restart overlapping this one's teardown)
   * keeps its live calls. A result arriving later finds nothing.
   */
  abortOpen(agentName: string, inferenceIds: Iterable<string>): void {
    if (this.calls.size === 0) return;
    const ids = new Set(inferenceIds);
    for (const tracked of [...this.calls.values()]) {
      if (tracked.agentName === agentName && ids.has(tracked.call.inferenceId)) {
        if (tracked.opened) this.terminate(tracked, 'aborted');
        else this.calls.delete(callKey(tracked.agentName, tracked.modelCallId));
      }
    }
  }

  /** For tests and diagnostics. */
  get openCount(): number {
    return this.calls.size;
  }
}
