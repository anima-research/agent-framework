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
  EndOutcome,
  HeldMail,
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

export class AgentRegistry {
  private readonly live = new Map<AgentName, AgentRecord>();
  /** Ended records, oldest first. */
  private ended: AgentRecord[] = [];
  /** Persistent records from the previous process, not yet re-declared. */
  private readonly awaiting = new Map<AgentName, AgentRecord>();
  private readonly incarnations = new Map<AgentName, number>();
  private mail: HeldMail[] = [];
  private readonly now: () => number;
  private readonly persistFn?: (snapshot: RegistrySnapshot) => void;
  private readonly appendEndedFn?: (record: AgentRecord) => void;
  private readonly endedRetention: number;

  constructor(options: AgentRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.persistFn = options.persist;
    this.appendEndedFn = options.appendEnded;
    this.endedRetention = options.endedRetention ?? DEFAULT_ENDED_RETENTION;
  }

  // ==========================================================================
  // Registration
  // ==========================================================================

  /**
   * Admit an agent. Refuses a spec that breaks a registry invariant — an
   * unbounded task, a second default-delivery owner, a relationship that
   * names nobody — so a malformed agent fails at load, not mid-run.
   */
  register(spec: AgentSpec): AgentRecord {
    this.validate(spec);
    const previous = this.awaiting.get(spec.name);
    this.awaiting.delete(spec.name);

    const incarnation = (this.incarnations.get(spec.name) ?? 0) + 1;
    this.incarnations.set(spec.name, incarnation);

    const record: AgentRecord = {
      name: spec.name,
      kind: spec.kind,
      incarnation,
      roles: { ...spec.roles },
      lifetime: { ...spec.lifetime },
      ...(spec.activation ? { activation: { ...spec.activation } } : {}),
      onParentEnd: spec.onParentEnd ?? 'orphan',
      relationships: {
        ...(spec.spawnedBy ? { spawnedBy: spec.spawnedBy } : {}),
        observes: (spec.observes ?? []).map((edge) => ({ ...edge })),
        // Explicit message paths accumulate over an identity's life.
        messagePeers: previous ? [...previous.relationships.messagePeers] : [],
        ...(spec.resultTo ? { resultTo: { ...spec.resultTo } } : {}),
      },
      ...(spec.inherit ? { inherit: { ...spec.inherit } } : {}),
      ...(spec.selfParticipants?.length ? { selfParticipants: [...spec.selfParticipants] } : {}),
      ...(spec.homeChannel ? { homeChannel: spec.homeChannel } : {}),
      readsSharedSlot: spec.readsSharedSlot ?? false,
      ...(spec.namespace ? { namespace: spec.namespace } : {}),
      ...(spec.metadata ? { metadata: clone(spec.metadata) } : {}),
      createdAt: previous?.createdAt ?? this.now(),
    };
    this.live.set(spec.name, record);
    this.persist();
    return record;
  }

  private validate(spec: AgentSpec): void {
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

    if (spec.spawnedBy !== undefined) {
      if (spec.spawnedBy === spec.name) fail('cannot be spawned by itself');
      if (!this.live.has(spec.spawnedBy)) fail(`spawner "${spec.spawnedBy}" is not a registered agent`);
    } else if (spec.onParentEnd === 'end') {
      fail('onParentEnd "end" needs a spawnedBy relationship');
    }
    if (spec.resultTo && !this.live.has(spec.resultTo.to)) {
      fail(`result recipient "${spec.resultTo.to}" is not a registered agent`);
    }
    if (spec.inherit && !this.live.has(spec.inherit.from)) {
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

  /** The live record, else the most recent ended one with that name. */
  inspect(name: AgentName): AgentRecord | undefined {
    const live = this.live.get(name);
    if (live) return live;
    for (let i = this.ended.length - 1; i >= 0; i--) {
      if (this.ended[i]!.name === name) return this.ended[i];
    }
    return undefined;
  }

  /** Flat list of agents — the discovery surface. Ended ones on request. */
  list(options: { includeEnded?: boolean } = {}): AgentRecord[] {
    const live = [...this.live.values()];
    return options.includeEnded ? [...this.ended, ...live] : live;
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

  /** Agents reading the residents' shared message slot. */
  sharedSlotReaders(): AgentName[] {
    return this.namesWhere((r) => r.readsSharedSlot);
  }

  readsSharedSlot(name: AgentName): boolean {
    return this.live.get(name)?.readsSharedSlot === true;
  }

  /** The channel an agent is bound to, if it has one. */
  homeChannel(name: AgentName): string | undefined {
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
    this.persist();
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
  end(name: AgentName, reason: AgentEndReason, by?: string): EndOutcome | null {
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
    this.persist();
    return item;
  }

  /** Delivery confirmed: forget the held copy. */
  releaseMail(id: string): void {
    const before = this.mail.length;
    this.mail = this.mail.filter((item) => item.id !== id);
    if (this.mail.length !== before) this.persist();
  }

  /** Mark why an item is still held (delivery attempted and not possible yet). */
  markMailHeld(id: string, because: NonNullable<HeldMail['heldBecause']>): void {
    const item = this.mail.find((candidate) => candidate.id === id);
    if (!item || item.heldBecause === because) return;
    item.heldBecause = because;
    this.persist();
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
    const records = [...this.awaiting.values(), ...this.live.values()].map((record) => clone(record));
    // Counters are kept for identities that can still be referred to: live
    // agents, persistent agents awaiting re-declaration, and ended agents
    // still in retention. A single-use name that has aged out restarts at 1.
    const referable = new Set<AgentName>([
      ...this.live.keys(),
      ...this.awaiting.keys(),
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
   * is ended here as interrupted, and returned so its result recipient can
   * be told. Held mail is kept for redelivery.
   *
   * `endedHistory` is the tail of the ended-record log, oldest first.
   */
  restore(snapshot: RegistrySnapshot | null | undefined, endedHistory: AgentRecord[] = []): RestoreOutcome {
    const interrupted: AgentRecord[] = [];
    for (const raw of endedHistory.slice(-this.endedRetention)) {
      if (raw && typeof raw === 'object' && raw.ended) this.ended.push(clone(raw));
    }
    if (!snapshot || snapshot.version !== 1) return { interrupted };

    for (const [name, value] of Object.entries(snapshot.incarnations ?? {})) {
      if (typeof value === 'number') this.incarnations.set(name, value);
    }
    this.mail = Array.isArray(snapshot.mail) ? clone(snapshot.mail) : [];

    for (const raw of snapshot.records ?? []) {
      const record = clone(raw);
      if (record.ended) continue; // history lives in the ended log
      if (record.lifetime.kind === 'persistent') {
        this.awaiting.set(record.name, record);
        continue;
      }
      this.recordEnded(record, 'host-restart');
      interrupted.push(record);
    }
    if (interrupted.length > 0) this.persist();
    return { interrupted };
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
    record.ended = { at: this.now(), reason, ...(by ? { by } : {}) };
    this.ended.push(record);
    if (this.ended.length > this.endedRetention) {
      this.ended.splice(0, this.ended.length - this.endedRetention);
    }
    if (!this.appendEndedFn) return;
    try {
      this.appendEndedFn(clone(record));
    } catch (error) {
      console.error('[dendrite] failed to append an ended agent record:', error);
    }
  }

  private persist(): void {
    if (!this.persistFn) return;
    try {
      this.persistFn(this.snapshot());
    } catch (error) {
      console.error('[dendrite] failed to persist the agent registry:', error);
    }
  }
}
