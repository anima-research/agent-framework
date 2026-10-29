/**
 * AgentRegistry — the one place that knows which agents exist, what they
 * are for, how they relate and what ends them.
 *
 * Pure bookkeeping: it never touches a stream, a context manager or a
 * channel. Lifecycle methods return what changed (who ended, who was
 * orphaned, which mail became deliverable) and the framework performs the
 * side effects. That split keeps every rule here testable without a store
 * and keeps the framework from re-deriving policy at each call site.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentEndReason,
  AgentName,
  AgentRecord,
  AgentRef,
  AgentSpec,
  ContextInheritance,
  EndOutcome,
  HeldMail,
  MessageSlotRef,
  ObserveEdge,
  RegistrySnapshot,
} from './types.js';

/** Thrown for a spec the registry refuses to load. */
export class AgentSpecError extends Error {
  constructor(agent: string, problem: string) {
    super(`agent "${agent}": ${problem}`);
    this.name = 'AgentSpecError';
  }
}

export interface AgentRegistryOptions {
  now?: () => number;
  /** Called after every durable mutation with the state to persist. */
  persist?: (snapshot: RegistrySnapshot) => void;
  /**
   * Called once per ended record. Ended records are append-only history,
   * kept out of the snapshot so a mutation never rewrites them.
   */
  appendEnded?: (record: AgentRecord) => void;
  /** How many ended records stay inspectable in memory (oldest dropped first). */
  endedRetention?: number;
  /**
   * Told when a write that records something that has already happened — a
   * release, a held mark, a message path — fails. The change stays in memory
   * and the next write carries it; the call that made it is not failed, since
   * what it records is done (nissa's #546 review, round 2). Absent, the
   * failure is logged.
   */
  onRecordWriteFailed?: (what: string, error: unknown) => void;
  /** Told after a change that failed was put back in memory (a requested change, or a hold): the host rewrites what it wrote alongside to match. */
  onRollback?: () => void;
  /**
   * Asked for an ended record no longer in memory (past `endedRetention`):
   * the host reads its durable ended log, so an agent that ended long ago
   * can still be inspected, resumed and named.
   */
  findEnded?: (name: AgentName) => AgentRecord | undefined;
}

/** What a restore found that the previous process left unfinished. */
export interface RestoreOutcome {
  /** Non-persistent agents that were live when the previous process stopped. */
  interrupted: AgentRecord[];
}

/** What boot reconciliation concluded once configuration was applied. */
export interface ReconcileOutcome {
  /** Persistent agents the previous process ran that this configuration no longer declares. */
  unconfigured: EndOutcome[];
}

const DEFAULT_ENDED_RETENTION = 256;

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/** The residents' shared un-namespaced slot, on the host's current branch. */
export const RESIDENTS_SLOT: Readonly<MessageSlotRef> = Object.freeze({ namespace: null });

/** Whether two refs name one slot: the same namespace on the same branch. */
export function sameSlot(a: MessageSlotRef | undefined, b: MessageSlotRef | undefined): boolean {
  return !!a && !!b && a.namespace === b.namespace && a.branch === b.branch;
}

/**
 * The slot an observe edge reads. An edge that names a slot reads that
 * namespace on the host's current branch. One that names an agent and no
 * slot reads that agent's own slot, wherever it is (a shared fork's is on its
 * own branch), as `ownSlotOf` looks it up: undefined where the lookup doesn't
 * know the agent, or none is given. The registry's `observedSlotOf` passes its
 * records. An edge that names neither reads the residents' shared slot.
 */
export function observedSlot(
  edge: ObserveEdge,
  ownSlotOf?: (agent: AgentName) => MessageSlotRef | undefined,
): MessageSlotRef | undefined {
  if (edge.slot !== undefined) return { namespace: edge.slot };
  if (edge.agent === undefined) return { namespace: null };
  const own = ownSlotOf?.(edge.agent);
  return own ? { namespace: own.namespace, ...(own.branch !== undefined ? { branch: own.branch } : {}) } : undefined;
}

/**
 * The slot a shared derivation's own rows are stored in: the parent's
 * message slot, as context-manager's derivation record names it, on the
 * child's own branch. Undefined for any other inheritance, or one whose
 * record doesn't say.
 */
function derivedSlot(inherit: ContextInheritance | undefined): MessageSlotRef | undefined {
  if (inherit?.mode !== 'shared' || typeof inherit.ownBranch !== 'string') return undefined;
  const slots = (inherit.derivation as { slots?: { messageNamespace?: unknown } } | undefined)?.slots;
  const namespace = slots?.messageNamespace;
  if (namespace !== null && typeof namespace !== 'string') return undefined;
  return { namespace, branch: inherit.ownBranch };
}

/**
 * The own slot a spec or record declares, or, where it declares none (one
 * written before `ownSlot` existed), the slot it meant: the shared slot for
 * one that reads that slot with no observe edge on it, which is how a
 * resident was declared; a shared derivation's slot; else the isolated slot
 * of its namespace. A subconscious declared its reading of the shared slot
 * as an observe edge from the start (subconsciousSpec), so it reads as
 * isolated, as it was opened. An edge on the shared slot here is one that
 * names neither a slot nor an agent. One that names an agent reads that
 * agent's slot, which isn't looked up here, so a spec reads as the same
 * record does when it is restored, where that agent's record may not be
 * loaded yet.
 */
function resolveOwnSlot(declared: {
  ownSlot?: MessageSlotRef;
  readsSharedSlot?: boolean;
  observes?: ObserveEdge[];
  inherit?: ContextInheritance;
  namespace?: string;
}): MessageSlotRef | undefined {
  const own = declared.ownSlot;
  if (own) return { namespace: own.namespace, ...(own.branch !== undefined ? { branch: own.branch } : {}) };
  const derived = derivedSlot(declared.inherit);
  if (derived) return derived;
  if (declared.readsSharedSlot === true && !(declared.observes ?? []).some((edge) => sameSlot(observedSlot(edge), RESIDENTS_SLOT))) {
    return { namespace: null };
  }
  return typeof declared.namespace === 'string' ? { namespace: declared.namespace } : undefined;
}

/** What a record's deprecated `readsSharedSlot` says: it owns the residents' slot or observes it. */
function readsResidentsSlot(
  ownSlot: MessageSlotRef | undefined,
  observes: ObserveEdge[],
  ownSlotOf: (agent: AgentName) => MessageSlotRef | undefined,
): boolean {
  return sameSlot(ownSlot, RESIDENTS_SLOT) || observes.some((edge) => sameSlot(observedSlot(edge, ownSlotOf), RESIDENTS_SLOT));
}

/**
 * A restored record with its own slot: one written before `ownSlot` existed
 * gets the slot its `readsSharedSlot`, observe edges, inheritance and
 * namespace meant (resolveOwnSlot). Its `readsSharedSlot` is kept as written.
 */
function withOwnSlot(record: AgentRecord): AgentRecord {
  if (record.ownSlot !== undefined) return record;
  const ownSlot = resolveOwnSlot({
    readsSharedSlot: record.readsSharedSlot,
    observes: record.relationships?.observes,
    inherit: record.inherit,
    namespace: record.namespace,
  });
  if (ownSlot) record.ownSlot = ownSlot;
  return record;
}

export class AgentRegistry {
  private readonly live = new Map<AgentName, AgentRecord>();
  /** Ended records, oldest first. */
  private ended: AgentRecord[] = [];
  /** Persistent records from the previous process, not yet re-declared. */
  private readonly awaiting = new Map<AgentName, AgentRecord>();
  /**
   * Bounded work the previous process left live, ended by this restart in
   * memory but kept in the snapshot as it was until the host has told each
   * recipient (settleInterrupted), so a crash before then owes the same
   * notices at the next boot rather than none.
   */
  private readonly interruptedPending = new Map<string, { asWas: AgentRecord; ended: AgentRecord }>();
  private readonly incarnations = new Map<AgentName, number>();
  private mail: HeldMail[] = [];
  private readonly now: () => number;
  private readonly persistFn?: (snapshot: RegistrySnapshot) => void;
  private readonly appendEndedFn?: (record: AgentRecord) => void;
  private readonly endedRetention: number;
  private readonly onRecordWriteFailed: (what: string, error: unknown) => void;
  private readonly onRollback?: () => void;
  private readonly findEnded?: (name: AgentName) => AgentRecord | undefined;
  /** Above zero while a record of what happened is being written: its writes alert rather than throw. */
  private recordingDepth = 0;

  constructor(options: AgentRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persistFn = options.persist;
    this.appendEndedFn = options.appendEnded;
    this.onRollback = options.onRollback;
    this.findEnded = options.findEnded;
    this.onRecordWriteFailed = options.onRecordWriteFailed
      ?? ((what, error) => console.error(`[dendrite] the registry could not record ${what}; it stays in memory and the next write carries it:`, error));
    this.endedRetention = options.endedRetention ?? DEFAULT_ENDED_RETENTION;
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Admit an agent. Refuses a spec that breaks a registry invariant — an
   * unbounded task, a second default-delivery owner, a relationship that
   * names nobody — so a malformed agent fails at load, not mid-run.
   *
   * `resume` admits a new incarnation of an identity that ended: where its
   * context came from is then history, so the context source no longer has
   * to be live. Who it reports to still does. A spawner that has ended, and
   * a result route to it, are admitted: the agent registers as that
   * spawner's orphan, as if it had been live when the spawner ended.
   * `after` is the incarnation a resumption continues from: the new one is
   * past it, since the counter of a name that aged out of memory isn't kept.
   */
  register(spec: AgentSpec, options: { resume?: boolean; after?: number } = {}): AgentRecord {
    return this.requested(() => this.registerUnguarded(spec, options));
  }

  private registerUnguarded(spec: AgentSpec, options: { resume?: boolean; after?: number } = {}): AgentRecord {
    this.validate(spec, options.resume === true);
    const previous = this.awaiting.get(spec.name);
    this.awaiting.delete(spec.name);

    const incarnation = Math.max(this.incarnations.get(spec.name) ?? 0, options.after ?? 0) + 1;
    this.incarnations.set(spec.name, incarnation);

    const observes = (spec.observes ?? []).map((edge) => ({ ...edge }));
    const ownSlot = resolveOwnSlot({ ...spec, observes });
    const record: AgentRecord = {
      name: spec.name,
      kind: spec.kind,
      ...(spec.model ? { model: spec.model } : {}),
      incarnation,
      roles: { ...spec.roles },
      lifetime: { ...spec.lifetime },
      ...(spec.activation ? { activation: { ...spec.activation } } : {}),
      onParentEnd: spec.onParentEnd ?? 'orphan',
      relationships: {
        ...(spec.spawnedBy ? { spawnedBy: spec.spawnedBy } : {}),
        observes,
        // Explicit message paths accumulate over an identity's life.
        messagePeers: previous ? [...previous.relationships.messagePeers] : [],
        ...(spec.resultTo ? { resultTo: { ...spec.resultTo } } : {}),
      },
      ...(spec.inherit ? { inherit: clone(spec.inherit) } : {}),
      ...(spec.selfParticipants?.length ? { selfParticipants: [...spec.selfParticipants] } : {}),
      ...(spec.presentAs ? { presentAs: spec.presentAs } : {}),
      ...(spec.homeChannel ? { homeChannel: { serverId: spec.homeChannel.serverId, channelId: spec.homeChannel.channelId } } : {}),
      ...(ownSlot ? { ownSlot } : {}),
      // Kept for readers of the record from before the split: derived from it.
      readsSharedSlot: readsResidentsSlot(ownSlot, observes, (name) => this.recordedSlotOf(name)),
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.metadata ? { metadata: clone(spec.metadata) } : {}),
      createdAt: previous?.createdAt ?? this.now(),
    };
    const spawner = record.relationships.spawnedBy;
    if (spawner !== undefined && !this.live.has(spawner)) {
      const former = this.inspect(spawner)!;
      const above = former.relationships.spawnedBy;
      const candidates = above !== undefined && this.live.has(above) ? [above, ...this.ancestors(above)] : [];
      const primary = this.primary();
      if (primary && primary !== record.name && !candidates.includes(primary)) candidates.push(primary);
      record.orphaned = {
        since: this.now(),
        formerParent: { agent: former.name, incarnation: former.incarnation },
        reason: former.ended?.reason ?? 'stopped',
        candidates,
      };
    }
    this.live.set(spec.name, record);
    this.persist();
    return record;
  }

  private validate(spec: AgentSpec, resume = false): void {
    const fail = (problem: string): never => {
      throw new AgentSpecError(spec.name || '(unnamed)', problem);
    };
    if (!spec.name) fail('a name is required');
    if (this.live.has(spec.name)) fail('is already registered');

    if (spec.roles.defaultDelivery) {
      const owner = this.primary();
      if (owner) fail(`default delivery already belongs to "${owner}"; exactly one agent owns it`);
    }

    const lifetime = spec.lifetime;
    if (lifetime.kind === 'task') {
      const bounded =
        (lifetime.deadlineMs !== undefined && lifetime.deadlineMs > 0) ||
        (lifetime.idleTimeoutMs !== undefined && lifetime.idleTimeoutMs > 0);
      if (!bounded) fail('a task lifetime needs a deadline or an idle timeout; every task agent must end');
    } else if (lifetime.kind === 'idle') {
      if (!(lifetime.idleTtlMs > 0)) fail('an idle lifetime needs a positive idleTtlMs');
    }

    // A spawner that ended before its child registered (between creating the
    // child and running it): the child is its orphan from the start, as one
    // live when the spawner ended would be, with its route to the spawner
    // held; one that ends with its parent would have ended with it.
    const endedSpawner = spec.spawnedBy !== undefined && !this.live.has(spec.spawnedBy)
      ? this.inspect(spec.spawnedBy)
      : undefined;
    if (spec.spawnedBy !== undefined) {
      if (spec.spawnedBy === spec.name) fail('cannot be spawned by itself');
      if (!this.live.has(spec.spawnedBy)) {
        if (!endedSpawner?.ended) fail(`spawner "${spec.spawnedBy}" is not a registered agent`);
        if (spec.onParentEnd === 'end') {
          fail(`spawner "${spec.spawnedBy}" has ended, and an agent that ends with its parent would have ended with it`);
        }
      }
    } else if (spec.onParentEnd === 'end') {
      fail('onParentEnd "end" needs a spawnedBy relationship');
    }
    if (spec.resultTo && !this.live.has(spec.resultTo.to)
      && !(endedSpawner?.ended && spec.resultTo.to === spec.spawnedBy)) {
      fail(`result recipient "${spec.resultTo.to}" is not a registered agent`);
    }
    if (spec.inherit && !resume && !this.live.has(spec.inherit.from)) {
      fail(`context source "${spec.inherit.from}" is not a registered agent`);
    }
    for (const edge of spec.observes ?? []) {
      if (edge.agent !== undefined && !this.live.has(edge.agent)) {
        fail(`observed agent "${edge.agent}" is not a registered agent`);
      }
    }
  }

  // ==========================================================================
  // Discovery
  // ==========================================================================

  /** A live agent's record. */
  get(name: AgentName): AgentRecord | undefined {
    return this.live.get(name);
  }

  has(name: AgentName): boolean {
    return this.live.has(name);
  }

  /** The live record, else the most recent ended one with that name, from memory or the host's ended log. */
  inspect(name: AgentName): AgentRecord | undefined {
    const live = this.live.get(name);
    if (live) return live;
    for (let i = this.ended.length - 1; i >= 0; i--) {
      if (this.ended[i]!.name === name) return this.ended[i];
    }
    // An interrupted record trimmed from memory before its end is written:
    // the newest incarnation, where two of one name are pending.
    let newest: AgentRecord | undefined;
    for (const { ended } of this.interruptedPending.values()) {
      if (ended.name === name && (!newest || ended.incarnation > newest.incarnation)) newest = ended;
    }
    return newest ?? this.findEnded?.(name);
  }

  /** Flat list of agents — the discovery surface. Ended ones on request. */
  list(options: { includeEnded?: boolean } = {}): AgentRecord[] {
    const live = [...this.live.values()];
    return options.includeEnded ? [...this.ended, ...live] : live;
  }

  /**
   * An agent other than `except` whose own context a namespace holds, among
   * the records in memory: live, awaiting re-declaration, or ended. A shared
   * fork's record names its parent's namespace, where it owns only a branch,
   * so it holds none.
   * @internal For the framework's namespace check in
   * `createEphemeralAgent()`; not a host API.
   */
  namespaceHolder(namespace: string, except: AgentName): AgentName | undefined {
    const pending = [...this.interruptedPending.values()].map((entry) => entry.asWas);
    for (const record of [...this.live.values(), ...this.awaiting.values(), ...pending, ...this.ended]) {
      if (record.name !== except && record.namespace === namespace && record.inherit?.mode !== 'shared') return record.name;
    }
    return undefined;
  }

  /** Provenance stamp for a live agent (or its last incarnation). */
  ref(name: AgentName): AgentRef {
    const record = this.inspect(name);
    return { agent: name, incarnation: record?.incarnation ?? this.incarnations.get(name) ?? 0 };
  }

  // ==========================================================================
  // Role queries — the positive replacements for exclusion filters
  // ==========================================================================

  /** The agent that owns default delivery, if any. */
  primary(): AgentName | null {
    for (const record of this.live.values()) {
      if (record.roles.defaultDelivery) return record.name;
    }
    return null;
  }

  /** Recipients of untargeted inbound, in registration order. */
  untargetedRecipients(): AgentName[] {
    return this.namesWhere((r) => r.roles.receivesUntargeted);
  }

  /** Recipients of host-wide gate fan-out, in registration order. */
  gateRecipients(): AgentName[] {
    return this.namesWhere((r) => r.roles.receivesGateWakes);
  }

  ownsProviderScheduling(name: AgentName): boolean {
    return this.live.get(name)?.roles.ownsProviderScheduling === true;
  }

  /**
   * Agents reading the residents' shared message slot.
   *
   * @deprecated Use `readersOf(RESIDENTS_SLOT)`, or `slotOwners` and
   * `observersOf` where owning and observing differ.
   */
  sharedSlotReaders(): AgentName[] {
    return this.namesWhere((r) => r.readsSharedSlot);
  }

  /** @deprecated Use `ownSlotOf` and `observersOf`. */
  readsSharedSlot(name: AgentName): boolean {
    return this.live.get(name)?.readsSharedSlot === true;
  }

  /** The slot a live agent's own rows are stored in, if it names one. */
  ownSlotOf(name: AgentName): MessageSlotRef | undefined {
    const slot = this.live.get(name)?.ownSlot;
    return slot ? { ...slot } : undefined;
  }

  /** Live agents whose own rows are stored in `slot`, in registration order. */
  slotOwners(slot: MessageSlotRef): AgentName[] {
    return this.namesWhere((r) => sameSlot(r.ownSlot, slot));
  }

  /**
   * The slot an observe edge reads (observedSlot): an edge that names an
   * agent and no slot reads that agent's own slot, as its record names it,
   * the live one, else the one awaiting re-declaration, else its newest
   * ended one, so an edge on an agent that ended still reads the slot it
   * read. Undefined for an agent the registry doesn't know.
   */
  observedSlotOf(edge: ObserveEdge): MessageSlotRef | undefined {
    return observedSlot(edge, (name) => this.recordedSlotOf(name));
  }

  /**
   * Live agents that read `slot` through an observe edge, in registration
   * order. With `held`, only those whose edge shows held (policy-diverted)
   * traffic.
   */
  observersOf(slot: MessageSlotRef, options: { held?: boolean } = {}): AgentName[] {
    return this.namesWhere((r) => r.relationships.observes.some(
      (edge) => sameSlot(this.observedSlotOf(edge), slot) && (!options.held || edge.includeHeld === true),
    ));
  }

  /** Every live agent that reads `slot`, as its own or through an observe edge, in registration order. */
  readersOf(slot: MessageSlotRef): AgentName[] {
    return this.namesWhere((r) => sameSlot(r.ownSlot, slot)
      || r.relationships.observes.some((edge) => sameSlot(this.observedSlotOf(edge), slot)));
  }

  /** The own slot an agent's record names: live, else awaiting re-declaration, else its newest ended record. */
  private recordedSlotOf(name: AgentName): MessageSlotRef | undefined {
    return (this.live.get(name) ?? this.awaiting.get(name) ?? this.inspect(name))?.ownSlot;
  }

  /** The channel an agent is bound to, if it has one. */
  homeChannel(name: AgentName): AgentRecord['homeChannel'] {
    return this.live.get(name)?.homeChannel;
  }

  /** Live agents of one preset label. Discovery only — see {@link AgentKind}. */
  ofKind(kind: string): AgentRecord[] {
    return [...this.live.values()].filter((r) => r.kind === kind);
  }

  private namesWhere(predicate: (record: AgentRecord) => boolean): AgentName[] {
    const names: AgentName[] = [];
    for (const record of this.live.values()) if (predicate(record)) names.push(record.name);
    return names;
  }

  // ==========================================================================
  // Relationships
  // ==========================================================================

  /** Live agents this one spawned. */
  children(name: AgentName): AgentRecord[] {
    return [...this.live.values()].filter((r) => r.relationships.spawnedBy === name && !r.orphaned);
  }

  /** Live spawn ancestors, nearest first. */
  ancestors(name: AgentName): AgentName[] {
    const chain: AgentName[] = [];
    const seen = new Set<AgentName>([name]);
    let cursor = this.live.get(name)?.relationships.spawnedBy;
    while (cursor && !seen.has(cursor) && this.live.has(cursor)) {
      chain.push(cursor);
      seen.add(cursor);
      cursor = this.live.get(cursor)?.relationships.spawnedBy;
    }
    return chain;
  }

  /** Live agents whose completed work returns to `name`. */
  resultSources(name: AgentName): AgentRecord[] {
    return [...this.live.values()].filter((r) => r.relationships.resultTo?.to === name);
  }

  /** Record that `from` used an explicit message path to `to`. */
  noteMessagePath(from: AgentName, to: AgentName): void {
    const record = this.live.get(from);
    if (!record || record.relationships.messagePeers.includes(to)) return;
    record.relationships.messagePeers.push(to);
    this.persistRecord(`the message path ${from} -> ${to}`);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * End an agent identity. Attention tenants it spawned end with it; task
   * work it spawned is orphaned, with reparenting candidates. Result routes
   * that pointed at it are left in place — delivery holds the mail instead
   * of dropping it, so a later adoption can still receive the result.
   */
  /**
   * End an agent. A stop a caller asks for is a requested change: a write that
   * fails puts memory back and fails the call. A run's own end or an idle
   * reap (`record: true`) records what has already happened: a write that
   * fails alerts, and the next write carries it (nissa's #546 review, round 3).
   */
  end(name: AgentName, reason: AgentEndReason, by?: string, options: { record?: boolean } = {}): EndOutcome | null {
    return options.record
      ? this.recording(() => this.endUnguarded(name, reason, by))
      : this.requested(() => this.endUnguarded(name, reason, by));
  }

  private endUnguarded(name: AgentName, reason: AgentEndReason, by?: string): EndOutcome | null {
    const record = this.live.get(name);
    if (!record) return null;
    const outcome = this.endRecursive(record, reason, by);
    this.persist();
    return outcome;
  }

  private endRecursive(record: AgentRecord, reason: AgentEndReason, by?: string): EndOutcome {
    // Candidates are computed before removal so the chain is still walkable.
    const adopters = this.adoptionCandidates(record);

    this.live.delete(record.name);
    this.recordEnded(record, reason, by);

    const cascaded: AgentRecord[] = [];
    const orphaned: EndOutcome['orphaned'] = [];
    const formerParent: AgentRef = { agent: record.name, incarnation: record.incarnation };
    for (const child of [...this.live.values()]) {
      if (child.relationships.spawnedBy !== record.name || child.orphaned) continue;
      if (!this.live.has(child.name)) continue; // ended by an earlier cascade
      if (child.onParentEnd === 'end') {
        const inner = this.endRecursive(child, 'parent-ended', record.name);
        cascaded.push(...inner.cascaded, inner.ended);
        orphaned.push(...inner.orphaned);
      } else {
        const candidates = adopters.filter((candidate) => candidate !== child.name);
        child.orphaned = { since: this.now(), formerParent, reason, candidates };
        orphaned.push({ record: child, candidates });
      }
    }
    return { ended: record, cascaded, orphaned };
  }

  /** Who could take over an ending agent's children: nearest live ancestor, then the primary. */
  private adoptionCandidates(record: AgentRecord): AgentName[] {
    const candidates = this.ancestors(record.name);
    const primary = this.primary();
    if (primary && primary !== record.name && !candidates.includes(primary)) candidates.push(primary);
    return candidates;
  }

  /**
   * Give an agent a new spawner. Clears orphan state. A result route whose
   * recipient is gone follows the new parent, and mail the agent already
   * produced for the lost recipient is re-addressed and returned so the
   * caller can deliver it.
   */
  reparent(name: AgentName, newParent: AgentName): { record: AgentRecord; deliverable: HeldMail[] } {
    return this.requested(() => this.reparentUnguarded(name, newParent));
  }

  private reparentUnguarded(name: AgentName, newParent: AgentName): { record: AgentRecord; deliverable: HeldMail[] } {
    const record = this.live.get(name);
    if (!record) throw new AgentSpecError(name, 'is not a registered agent');
    if (!this.live.has(newParent)) throw new AgentSpecError(name, `new parent "${newParent}" is not a registered agent`);
    if (newParent === name) throw new AgentSpecError(name, 'cannot be its own parent');
    if (this.ancestors(newParent).includes(name)) {
      throw new AgentSpecError(name, `"${newParent}" descends from it; reparenting would form a cycle`);
    }
    record.relationships.spawnedBy = newParent;
    delete record.orphaned;

    const route = record.relationships.resultTo;
    if (route && !this.live.has(route.to)) route.to = newParent;

    const deliverable: HeldMail[] = [];
    for (const item of this.mail) {
      if (item.from.agent === name && !this.live.has(item.to)) {
        item.to = newParent;
        item.heldBecause = 'undelivered';
        deliverable.push(item);
      }
    }
    this.persist();
    return { record, deliverable };
  }

  /**
   * An ended agent's held mail finds a new recipient: every item it produced
   * for a recipient that is gone (a result or a message, as `reparent`
   * moves for a live agent) is re-addressed to `newParent` and returned for
   * delivery. Its record stays as it ended, since history isn't reparented.
   * @internal For the framework's `reparentAgent()` of an ended agent; not a host API.
   */
  readdressHeldMail(name: AgentName, newParent: AgentName): { record: AgentRecord; deliverable: HeldMail[] } {
    return this.requested(() => {
      const record = this.inspect(name);
      if (!record?.ended) throw new AgentSpecError(name, 'is not an ended agent');
      if (!this.live.has(newParent)) throw new AgentSpecError(name, `new parent "${newParent}" is not a registered agent`);
      const deliverable: HeldMail[] = [];
      for (const item of this.mail) {
        if (item.from.agent === name && !this.live.has(item.to)) {
          item.to = newParent;
          item.heldBecause = 'undelivered';
          deliverable.push(item);
        }
      }
      if (deliverable.length > 0) this.persist();
      return { record, deliverable };
    });
  }

  // ==========================================================================
  // Held mail
  // ==========================================================================

  /** Record a communication durably BEFORE attempting delivery. */
  holdMail(mail: Omit<HeldMail, 'id' | 'createdAt'> & { id?: string }): HeldMail {
    const item: HeldMail = {
      ...mail,
      id: mail.id ?? randomUUID(),
      createdAt: this.now(),
      content: clone(mail.content),
    };
    this.mail.push(item);
    // A hold that isn't durable isn't held: the persist's failure fails this
    // call, and the item leaves memory and every copy written before the
    // failure too, so a retry holds it once.
    try {
      this.persist();
    } catch (error) {
      this.mail.pop();
      this.putBack();
      throw error;
    }
    return item;
  }

  /** Delivery confirmed: forget the held copy. */
  releaseMail(id: string): void {
    const before = this.mail.length;
    this.mail = this.mail.filter((item) => item.id !== id);
    if (this.mail.length !== before) this.persistRecord(`the release of mail ${id}`);
  }

  /** Mark why an item is still held (delivery attempted and not possible yet). */
  markMailHeld(id: string, because: NonNullable<HeldMail['heldBecause']>): void {
    const item = this.mail.find((candidate) => candidate.id === id);
    if (!item || item.heldBecause === because) return;
    item.heldBecause = because;
    this.persistRecord(`why mail ${id} is held (${because})`);
  }

  listMail(filter: { to?: AgentName; from?: AgentName } = {}): HeldMail[] {
    return this.mail.filter(
      (item) =>
        (filter.to === undefined || item.to === filter.to) &&
        (filter.from === undefined || item.from.agent === filter.from),
    );
  }

  // ==========================================================================
  // Persistence and restart
  // ==========================================================================

  snapshot(): RegistrySnapshot {
    const pending = [...this.interruptedPending.values()].map((entry) => entry.asWas);
    const records = [...this.awaiting.values(), ...pending, ...this.live.values()].map((record) => clone(record));
    // Counters are kept for identities that can still be referred to: live
    // agents, persistent agents awaiting re-declaration, and ended agents
    // still in retention. A single-use name that has aged out restarts at 1.
    const referable = new Set<AgentName>([
      ...this.live.keys(),
      ...this.awaiting.keys(),
      ...pending.map((record) => record.name),
      ...this.ended.map((record) => record.name),
    ]);
    const incarnations: Record<AgentName, number> = {};
    for (const [name, value] of this.incarnations) if (referable.has(name)) incarnations[name] = value;
    return { version: 1, records, incarnations, mail: clone(this.mail) };
  }

  /**
   * Load what the previous process persisted. Restart behaviour follows
   * from lifetime: a persistent agent waits to be re-declared by
   * configuration (see {@link reconcile}); every other agent that was live
   * is ended here as interrupted, in memory, and returned so its result
   * recipient can be told. It stays in the snapshot as it was, and its end
   * is written, once the host has told the recipients (settleInterrupted).
   * Held mail is kept for redelivery.
   *
   * A bounded record the ended history already holds, by name and
   * incarnation, ended before the previous process could write the snapshot
   * without it: it is dropped, not ended again. A persistent record waits to
   * be re-declared whatever that history says, since the end there may be one
   * a stop left that failed and was put back (an append can't be taken
   * back); configuration then declares it again or ends it.
   *
   * `endedHistory` is the tail of the ended-record log, oldest first.
   */
  restore(snapshot: RegistrySnapshot | null | undefined, endedHistory: AgentRecord[] = []): RestoreOutcome {
    const interrupted: AgentRecord[] = [];
    for (const raw of endedHistory.slice(-this.endedRetention)) {
      if (raw && typeof raw === 'object' && raw.ended) this.ended.push(withOwnSlot(clone(raw)));
    }
    if (!snapshot) return { interrupted };
    if (snapshot.version !== 1) {
      throw new Error(`the agent registry reads as version ${JSON.stringify(snapshot.version)}, which this code doesn't read; nothing was restored`);
    }

    // Damaged in its content rather than its version: refused the same way,
    // since taken as empty it would be overwritten, and without its counters
    // every identity it names would start again at incarnation 1.
    if (!Array.isArray(snapshot.mail) || !Array.isArray(snapshot.records)) {
      throw new Error('the agent registry reads as version 1 but its records or mail are not lists; nothing was restored');
    }
    const counters: unknown = snapshot.incarnations;
    if (counters === null || typeof counters !== 'object' || Array.isArray(counters)) {
      throw new Error('the agent registry reads as version 1 but has no map of incarnations; nothing was restored');
    }
    for (const [name, value] of Object.entries(counters)) {
      if (typeof value === 'number') this.incarnations.set(name, value);
    }
    this.mail = clone(snapshot.mail);

    const endedKeys = new Set(this.ended.map((record) => `${record.name}#${record.incarnation}`));
    let dropped = false;
    for (const raw of snapshot.records) {
      const record = withOwnSlot(clone(raw));
      if (record.ended) continue; // history lives in the ended log
      if (record.lifetime.kind === 'persistent') {
        this.awaiting.set(record.name, record);
        continue;
      }
      if (endedKeys.has(`${record.name}#${record.incarnation}`)) {
        dropped = true;
        continue;
      }
      const asWas = clone(record);
      this.pushEnded(record, 'host-restart');
      this.interruptedPending.set(`${record.name}#${record.incarnation}`, { asWas, ended: clone(record) });
      interrupted.push(record);
    }
    if (dropped) this.persist();
    return { interrupted };
  }

  /**
   * The host has told each interrupted job's recipient (restore's
   * `interrupted`): their ends are written now, and the snapshot no longer
   * lists them. Each pending entry carries its own end, as memory keeps only
   * the newest `endedRetention`. An end whose write fails is reported and
   * stays pending, so the snapshot still lists it and a later settlement (the
   * next boot's) writes it; a failed snapshot write is reported too.
   * @internal For the framework's boot, once the interrupted jobs'
   * recipients are told; not a host API.
   */
  settleInterrupted(): void {
    if (this.interruptedPending.size === 0) return;
    for (const [key, { ended }] of [...this.interruptedPending]) {
      try {
        this.appendEndedFn?.(clone(ended));
      } catch (error) {
        this.onRecordWriteFailed(`the end of ${ended.name}`, error);
        continue;
      }
      this.interruptedPending.delete(key);
    }
    this.recording(() => this.persist());
  }

  /**
   * Call once configuration has declared its agents. A persistent agent the
   * previous process ran but this configuration omits is ended, with the
   * usual consequences for what it spawned.
   */
  reconcile(): ReconcileOutcome {
    const unconfigured: EndOutcome[] = [];
    for (const record of [...this.awaiting.values()]) {
      this.awaiting.delete(record.name);
      this.recordEnded(record, 'not-configured');
      const formerParent: AgentRef = { agent: record.name, incarnation: record.incarnation };
      const orphaned: EndOutcome['orphaned'] = [];
      const primary = this.primary();
      for (const child of this.live.values()) {
        if (child.relationships.spawnedBy !== record.name || child.orphaned) continue;
        const candidates = primary && primary !== child.name ? [primary] : [];
        child.orphaned = { since: this.now(), formerParent, reason: 'not-configured', candidates };
        orphaned.push({ record: child, candidates });
      }
      unconfigured.push({ ended: record, cascaded: [], orphaned });
    }
    if (unconfigured.length > 0) this.persist();
    return { unconfigured };
  }

  private recordEnded(record: AgentRecord, reason: AgentEndReason, by?: string): void {
    this.pushEnded(record, reason, by);
    this.appendEndedRecord(record);
  }

  /** Mark a record ended and keep it in memory, without writing the end. */
  private pushEnded(record: AgentRecord, reason: AgentEndReason, by?: string): void {
    record.ended = { at: this.now(), reason, ...(by ? { by } : {}) };
    this.ended.push(record);
    if (this.ended.length > this.endedRetention) {
      this.ended.splice(0, this.ended.length - this.endedRetention);
    }
  }

  /** Write an ended record through the host's append hook. */
  private appendEndedRecord(record: AgentRecord): void {
    if (!this.appendEndedFn) return;
    // A failed append fails the end that made it, as a failed persist does —
    // unless the end records a run that has ended, when it alerts instead.
    if (this.recordingDepth > 0) {
      try {
        this.appendEndedFn(clone(record));
      } catch (error) {
        this.onRecordWriteFailed(`the end of ${record.name}`, error);
      }
      return;
    }
    this.appendEndedFn(clone(record));
  }

  /**
   * Run a change a caller asks for — a registration, an end, a reparent, a
   * hold — so that a write failing on the way puts memory back as it was:
   * the call fails and changes nothing, and a retry does it once (nissa's
   * #546 review, round 2: a stop whose write failed left the agent recorded
   * as stopped while it kept running).
   */
  private requested<T>(change: () => T): T {
    const saved = {
      live: new Map([...this.live].map(([k, v]) => [k, clone(v)])),
      ended: this.ended.map(clone),
      awaiting: new Map([...this.awaiting].map(([k, v]) => [k, clone(v)])),
      incarnations: new Map(this.incarnations),
      mail: this.mail.map(clone),
    };
    try {
      return change();
    } catch (error) {
      this.live.clear(); for (const [k, v] of saved.live) this.live.set(k, v);
      this.ended = saved.ended;
      this.awaiting.clear(); for (const [k, v] of saved.awaiting) this.awaiting.set(k, v);
      this.incarnations.clear(); for (const [k, v] of saved.incarnations) this.incarnations.set(k, v);
      this.mail = saved.mail;
      this.putBack();
      throw error;
    }
  }

  /** Memory is as it was before a change that failed: the host rewrites its copies to match. The caller hears why
   *  its change failed, not why the put-back did. */
  private putBack(): void {
    try {
      this.onRollback?.();
    } catch (rollbackError) {
      this.onRecordWriteFailed('the put-back of a change that failed', rollbackError);
    }
  }

  /** Run a record of something that has already happened: its writes alert and stay in memory rather than throw. */
  private recording<T>(change: () => T): T {
    this.recordingDepth++;
    try {
      return change();
    } finally {
      this.recordingDepth--;
    }
  }

  /** The ended records in memory, newest last. */
  endedHistory(): AgentRecord[] {
    // An interrupted end not yet written isn't history yet: written into the
    // ended file early, it would let a crash drop the record before its
    // recipient is told (restore drops what the ended history holds).
    return this.ended
      .filter((record) => !this.interruptedPending.has(`${record.name}#${record.incarnation}`))
      .map(clone);
  }

  /** Persist a record of something that has already happened: a failure
   *  alerts and leaves the change in memory for the next write to carry. */
  private persistRecord(what: string): void {
    try {
      this.persist();
    } catch (error) {
      this.onRecordWriteFailed(what, error);
    }
  }

  /** Write the snapshot through the host's persist hook. A write that fails
   *  fails the change that made it (nissa's #546 finding 2): the change is in
   *  memory, and the caller is told it is not durable, rather than told it
   *  succeeded while a restart would lose it. */
  private persist(): void {
    if (!this.persistFn) return;
    if (this.recordingDepth > 0) {
      try {
        this.persistFn(this.snapshot());
      } catch (error) {
        this.onRecordWriteFailed('a change already made', error);
      }
      return;
    }
    this.persistFn(this.snapshot());
  }
}
