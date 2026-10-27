/**
 * The presentation index (#291): which stored rows each agent's window
 * holds, and when a row enters it.
 *
 * The store's record keeps every write in the order it arrived. An agent's
 * window is another order over the same rows: the rows it was shown, in the
 * order its requests carried them (context-manager's window index,
 * `presentRows`). While one agent writes one slot the two orders are the
 * same. Once agents share a slot, or one reads another's, they differ: a row
 * another agent stored during my turn sits inside my turn in the record, but
 * my requests carried it only at my next tool boundary or turn start, so a
 * compile that sent it where the record has it would change my turn's prefix
 * (the prompt cache misses, and a reply's signed thinking is sent under a
 * prefix it wasn't minted under).
 *
 * This module decides who each stored row is presented to and when, through
 * each live agent's own context manager. It reads the row's audience stamp
 * (dendrite/audience.ts) and the registry's slots and observe edges
 * (bearingOf), and presents:
 *
 * - an agent's own rows as they are written, through the own-row sink
 *   (storeOwnRow, Agent and ToolResultGuard call it once the row is stored),
 *   or at its next presentation point when a writer held one back;
 * - another writer's rows meant for it (arrivals) at its turn start, at its
 *   tool boundary as a prefix the live stream can carry, at its turn's end,
 *   and at once while it has no turn alive (present at rest);
 * - nothing of others' while the host is quiesced or under a surgery hold,
 *   which freeze every window but for an agent's own rows;
 * - the arrivals a rollback's cut took out of an agent's window only at its
 *   next turn start (holdUntilStart), so the cut holds until it speaks.
 *
 * Arrivals are read from the index itself (getUnpresentedMessages filtered
 * by bearingOf), never from the store's head: a crashed turn's arrivals, a
 * derived agent's inheritance and rows imported at boot are arrivals by
 * construction. The one scalar kept is a memo of where a scan may start,
 * reset whenever the branch, the index length or the reader's facts moved
 * under it.
 *
 * The module presents only for an agent it has taken on (adopt) whose
 * manager is in presented mode: it never calls presentRows on a manager in
 * legacy mode but for the deliberate write-down at adopt, and again at a
 * rebase after the store's branch moved to a branch whose window index for
 * that manager was never written (one made before the write-down), since
 * any presentRows there writes the whole record down and switches the mode.
 * Nothing in it throws into a writer: a failed presentation is traced and
 * its rows stay out of the window for the next point.
 *
 * It never imports framework.ts, which imports it.
 */
import type { ContentBlock } from '@animalabs/membrane';
import { continuesBody, type ContextManager, type MessageId, type MessageMetadata, type StoredMessage } from '@animalabs/context-manager';
import { audienceOf, heldFromResidents, observedRowFor } from './dendrite/audience.js';
import { RESIDENTS_SLOT, sameSlot, type AgentRegistry } from './dendrite/registry.js';
import type { AgentName, AgentRecord, MessageSlotRef, ObserveEdge } from './dendrite/types.js';
import type { WindowOrdinal } from './read-marks.js';
import { isAnotherAgentsInjection } from './stored-injections.js';
import { nameAsStored } from './text-as-stored.js';
import type { PresentationRetractReason, TraceEvent } from './types/trace.js';

export { heldFromResidents } from './dendrite/audience.js';

// ============================================================================
// Pure pieces the tool boundary and the drain share
// ============================================================================

/** Whether a stored row can join a live stream at a tool boundary: no tool
 *  blocks (the membrane's tool cycle) and not named as the agent itself (it
 *  would render as an assistant turn, a prefill). The #286 cut. */
export function isInjectableMidTurn(msg: { participant: string; content: ContentBlock[] }, agent: { isOwnParticipant(participant: string): boolean }): boolean {
  // Exact, as membrane's role test is: a participant the request assigns
  // the assistant role (the agent's name, and for a derived agent the
  // voice it inherited) renders as the assistant. It's the name as sent,
  // which the boundary takes as the store keeps it.
  return !agent.isOwnParticipant(nameAsStored(msg.participant))
    && !msg.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result');
}

/** What later compiles render from the store for the copies of one write
 *  that landed: one copy as it is, and two or more, the shards of a sharded
 *  body, as context-manager's autobiographical strategy (the one that
 *  shards on ingest) joins a body's consecutive shards: their non-text
 *  blocks, then one text block of their joined text. The join is that
 *  strategy's `mergeAdjacentBodyGroupRaw`, which context-manager doesn't
 *  export, so the rule is copied here, and a test compares the two. */
export function asCompiled(landed: ReadonlyArray<{ content: ContentBlock[] }>): ContentBlock[] {
  if (landed.length === 1) return landed[0]!.content;
  const blocks = landed.flatMap((m) => m.content);
  const text = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
  return [...blocks.filter((b) => b.type !== 'text'), { type: 'text', text } as ContentBlock];
}

// ============================================================================
// Positions in a window
// ============================================================================

/** A place in one agent's window on one branch: an index ordinal
 *  (ContextManager.ordinalOf, indexLength), never a store sequence. */
export type Position = WindowOrdinal;

/** Where an agent's window stood: its branch and its index length then. */
export interface WindowMark {
  readonly branch: string;
  readonly position: Position;
}

/** The row's place in `cm`'s window, or undefined for a row out of it (and every row in legacy mode). */
export function positionIn(cm: Pick<ContextManager, 'ordinalOf'>, id: MessageId): Position | undefined {
  return cm.ordinalOf(id) as Position | undefined;
}

/** The place the next row presented in `cm`'s window will take (its index length, exclusive; 0 in legacy mode). */
export function windowEnd(cm: Pick<ContextManager, 'indexLength'>): Position {
  return cm.indexLength() as Position;
}

/** Where `cm`'s window stands now, or null in legacy mode, where the window is the record and has no index. */
export function windowMarkOf(cm: Pick<ContextManager, 'windowMode' | 'indexLength' | 'currentBranch'>): WindowMark | null {
  if (cm.windowMode() !== 'presented') return null;
  return { branch: cm.currentBranch().name, position: windowEnd(cm) };
}

// ============================================================================
// The audience rule
// ============================================================================

/**
 * What a row in one agent's merged record is to that agent: its own row,
 * an arrival (a row meant for it that another writer stored), or elsewhere
 * (a row it is never presented: another agent's own round, mail for a
 * co-resident, a held row for a resident).
 */
export type Bearing = 'own' | 'arrival' | 'elsewhere';

/** A slot an agent observes: the slot its edge reads, the edge, and the slot's owners. */
export interface ObservedSlot {
  readonly slot: MessageSlotRef;
  readonly edge: ObserveEdge;
  readonly owners: readonly AgentName[];
}

/** What bearingOf needs to know of a reader, read from the registry (readerFacts). */
export interface ReaderFacts {
  readonly name: AgentName;
  /** The slot its own rows are stored in (registry.ownSlotOf). */
  readonly ownSlot: MessageSlotRef | undefined;
  /** The slots it observes, each through its edge. */
  readonly observed: readonly ObservedSlot[];
  /** Whether its window leaves held rows out: an agent whose own slot is the
   *  residents' slot, on the host's branch or a branch of its own (a shared
   *  fork, which carries the residents' view filter). */
  readonly hidesHeld: boolean;
  /** For a shared derivation, the parent's checkpoint: a row with no stamp
   *  at or before it is the parent's inheritance, not the child's arrival. */
  readonly derivedAt?: number;
}

/** The registry queries readerFacts reads. */
export type ReaderRegistry = Pick<AgentRegistry, 'get' | 'ownSlotOf' | 'observedSlotOf' | 'slotOwners'>;

/** A reader's facts as the registry has them now. An agent it doesn't know has no slot and observes nothing. */
export function readerFacts(registry: ReaderRegistry, name: AgentName): ReaderFacts {
  return factsOf(registry, name, registry.get(name), registry.ownSlotOf(name));
}

/**
 * A reader's facts as the registry recorded them: its live record, else its
 * newest ended one (registry.inspect). For a reader that has left, as a
 * released fork or run has by the time its window is read for what it
 * never read (AgentFramework.releasedWindow): readerFacts reads live
 * records only, and would know nothing of it.
 */
export function recordedReaderFacts(
  registry: Pick<AgentRegistry, 'inspect' | 'observedSlotOf' | 'slotOwners'>,
  name: AgentName,
): ReaderFacts {
  const record = registry.inspect(name);
  return factsOf(registry, name, record, record?.ownSlot ? { ...record.ownSlot } : undefined);
}

/** A reader's facts from its record and its own slot (readerFacts, recordedReaderFacts). */
function factsOf(
  registry: Pick<AgentRegistry, 'observedSlotOf' | 'slotOwners'>,
  name: AgentName,
  record: AgentRecord | undefined,
  ownSlot: MessageSlotRef | undefined,
): ReaderFacts {
  const observed: ObservedSlot[] = [];
  for (const edge of record?.relationships.observes ?? []) {
    const slot = registry.observedSlotOf(edge);
    if (slot) observed.push({ slot, edge, owners: registry.slotOwners(slot) });
  }
  const derivedAt = record?.inherit?.mode === 'shared' ? record.inherit.atSequence : undefined;
  return {
    name,
    ownSlot,
    observed,
    hidesHeld: ownSlot?.namespace === null,
    ...(derivedAt !== undefined ? { derivedAt } : {}),
  };
}

/**
 * What one row is to one reader, from the row's stamp and the reader's
 * facts. `inOwnSlot` says whether the row is stored in the reader's own slot
 * (else it is in a slot the reader observes).
 *
 * In its own slot, with `stamp = audienceOf(metadata)`:
 * - its own row (`ownRowOf` names it): own;
 * - another agent's own row: elsewhere (decision 1: another agent's rounds
 *   reach an agent only through an observe edge);
 * - a row whose audience names it: an arrival, unless it is held and the
 *   reader leaves held rows out;
 * - a row stamped otherwise (mail for a co-resident, a held row): elsewhere;
 * - a row with no stamp (stored by a host's writer that doesn't stamp): an
 *   arrival for the slot's owners, as it reads today, unless it is a shared
 *   derivation's inheritance (at or before `derivedAt`), held for a reader
 *   that leaves held rows out, or another agent's stored injection.
 *
 * In an observed slot: through the edge that reads it (the only edge, or
 * the one on the residents' slot), what observedRowFor says.
 */
export function bearingOf(
  row: Pick<StoredMessage, 'sequence' | 'participant' | 'metadata'>,
  reader: ReaderFacts,
  inOwnSlot: boolean,
): Bearing {
  const metadata = row.metadata as Record<string, unknown> | undefined;
  if (!inOwnSlot) {
    const seen = reader.observed.length === 1
      ? reader.observed[0]
      : reader.observed.find((o) => sameSlot(o.slot, RESIDENTS_SLOT));
    if (!seen) return 'elsewhere';
    return observedRowFor(seen.edge, row, { observer: reader.name, owners: seen.owners }) ? 'arrival' : 'elsewhere';
  }
  const stamp = audienceOf(metadata);
  if (stamp) {
    if (stamp.ownRowOf !== undefined) return stamp.ownRowOf === reader.name ? 'own' : 'elsewhere';
    if (!stamp.audience.includes(reader.name)) return 'elsewhere';
    return reader.hidesHeld && heldFromResidents(metadata) ? 'elsewhere' : 'arrival';
  }
  if (reader.derivedAt !== undefined && row.sequence <= reader.derivedAt) return 'elsewhere';
  if (reader.hidesHeld && heldFromResidents(metadata)) return 'elsewhere';
  if (isAnotherAgentsInjection(metadata, reader.name)) return 'elsewhere';
  return 'arrival';
}

/**
 * Whether a row stamped for `audience` and stored in `slot` is meant only for
 * agents that can't read it: its audience names someone, and none of them
 * reads the slot, as an owner or through an observe edge (registry
 * readersOf). Such a row is stored as named, never widened (no window
 * presents it by its audience), and traced as a routing fault. A row whose
 * audience names an observer of the slot is no fault: its edge shows it
 * (observedRowFor), as one naming an owner is presented in that owner's
 * window.
 */
export function audienceFault(
  audience: readonly AgentName[],
  slot: MessageSlotRef | undefined,
  registry: Pick<AgentRegistry, 'readersOf'>,
): boolean {
  if (audience.length === 0 || slot === undefined) return false;
  const readers = registry.readersOf(slot);
  return !audience.some((name) => readers.includes(name));
}

// ============================================================================
// The presentation module
// ============================================================================

/** Where one presentation into an agent's window happened. */
export type PresentationOccasion =
  /** An agent's own row, presented as it was stored. */
  | 'write'
  /** A turn's start, before its compile: its own rows and its arrivals. */
  | 'turn-start'
  /** A start's assembly of a wake's own rows, before its compile. */
  | 'assembly'
  /** The backstop before every compile: its own rows only. */
  | 'compile'
  /** A tool boundary: the round's rows, then a prefix of its arrivals. */
  | 'tool-boundary'
  /** The check before a boundary hands the stream its rows. */
  | 'hand-off'
  /** A turn's end. */
  | 'turn-end'
  /** An agent with no turn alive, presented a row at its write, or at boot. */
  | 'at-rest'
  /** Rows handed a reader fork as framing. */
  | 'framing'
  /** An agent taken on: its window written down and its own rows repaired. */
  | 'adopt'
  /** The store's branch moved under a live agent (rebase): its window on the
   *  new branch written down, where that branch had none, and its own rows
   *  repaired. */
  | 'rebase';

/** A context manager as the module uses it. */
export type WindowManager = Pick<ContextManager,
  'presentRows' | 'getUnpresentedMessages' | 'getPresentedMessages' | 'ordinalOf' | 'indexLength' | 'windowStatusOf'
  | 'windowMode' | 'getMessage' | 'currentBranch' | 'isClosed' | 'retractRemoved' | 'retractAbsentRows'>;

/** An agent as the module presents to it. The framework's Agent is one. */
export interface PresentedAgent {
  readonly name: AgentName;
  getContextManager(): WindowManager;
  isOwnParticipant(participant: string): boolean;
  /** Where the agent tells of its own rows once they are stored (Agent.setOwnRowSink). */
  setOwnRowSink?(sink: ((ids: readonly MessageId[]) => void) | undefined): void;
}

type WithoutTimestamp<T> = T extends unknown ? Omit<T, 'timestamp' | 'traceId'> : never;
/** The traces the module emits, as a host passes them on. */
export type PresentationTrace = WithoutTimestamp<Extract<TraceEvent, { type: `presentation:${string}` }>>;

/** What the module reads of its host (the framework). */
export interface PresentationHost {
  /** Every agent registered now, a shared fork on its own branch included. */
  liveAgents(): Iterable<PresentedAgent>;
  readonly registry: Pick<AgentRegistry, 'get' | 'ownSlotOf' | 'observedSlotOf' | 'readersOf' | 'slotOwners'>;
  /**
   * Whether the agent's logical turn is alive: a turn token, a continuation
   * or retry on its way, a live stream, or a tool cycle pending. Nothing but
   * its own rows and its boundary's arrivals is presented to it then.
   */
  turnAlive(name: AgentName): boolean;
  /** Whether others' rows are frozen out of every window (quiesced, or a surgery hold): own rows still present. */
  frozen(): boolean;
  emitTrace(event: PresentationTrace): void;
}

/** A row a tool boundary presented for the live stream to carry: one per body, by the id that names it. */
export interface HeardRow {
  readonly id: MessageId;
  readonly participant: string;
  /** The body as the store holds it, a sharded one's shards joined as compiles join them (asCompiled). */
  readonly content: ContentBlock[];
  readonly metadata?: MessageMetadata;
}

/** What a tool boundary presented beyond the round's own rows. */
export interface BoundaryPresentation {
  /** The rows the stream carries next, in window order. */
  readonly heard: readonly HeardRow[];
  /** The first row the stream can't carry, where the rows presented stop. */
  readonly cutAt?: MessageId;
}

/**
 * An agent holding a row: in its window, at a place (`'window'`); in a
 * window that is still the whole record (`'legacy'`), which holds every row
 * its merged record does; or handed it as a reader fork's framing
 * (`'framing'`).
 */
export type Holder =
  | { readonly agent: AgentName; readonly via: 'window'; readonly position: Position }
  | { readonly agent: AgentName; readonly via: 'legacy' }
  | { readonly agent: AgentName; readonly via: 'framing' };

/** What a presentation listener hears: the rows that entered one agent's window, in order, and where. */
export interface PresentedEvent {
  readonly agentName: AgentName;
  readonly occasion: PresentationOccasion;
  readonly rows: readonly StoredMessage[];
}

/** One body of the agent's pending rows: its unpresented shards in record order, and what it is to the agent. */
interface PendingBody {
  readonly shards: StoredMessage[];
  readonly bearing: 'own' | 'arrival';
  readonly unstamped: boolean;
}

/** Where a scan of one manager's unpresented rows may start: every one at or below `scanFrom` was elsewhere. */
interface ScanMemo {
  generation: number;
  branch: string;
  length: number;
  facts: string;
  scanFrom: number;
}

/** What adopt left for one manager. */
interface Adopted {
  /** Set when the window couldn't be written down: the agent stays in legacy mode for this process. */
  pinnedLegacy?: string;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The presentation index's decisions, over each live agent's context
 * manager. The framework constructs it in create() and calls it at each
 * presentation point.
 */
export class AgentPresentation {
  private readonly adopted = new WeakMap<WindowManager, Adopted>();
  private readonly memos = new WeakMap<WindowManager, ScanMemo>();
  /** Bumped when a registration may have changed what a row is to someone: every memo is then stale. */
  private generation = 0;
  /** Rows handed each reader fork as framing (noteFramed), in memory. */
  private readonly framed = new Map<AgentName, Set<MessageId>>();
  private readonly listeners = new Map<AgentName, Set<(event: PresentedEvent) => void>>();
  /** Own rows whose presentation at their write failed, per manager (presentOwn), until they enter its window. */
  private readonly failedOwn = new WeakMap<WindowManager, Set<MessageId>>();
  /** Arrivals a rollback took out of each manager's window, kept out of it at rest until the agent's next turn start (holdUntilStart). */
  private readonly heldUntilStart = new WeakMap<WindowManager, Set<MessageId>>();

  constructor(private readonly host: PresentationHost) {}

  // --------------------------------------------------------------------------
  // Taking agents on
  // --------------------------------------------------------------------------

  /** Take on every live agent (adopt), then present what each is owed at rest (repairAndRest). */
  boot(): void {
    for (const agent of this.host.liveAgents()) this.adopt(agent);
    this.repairAndRest();
  }

  /**
   * Take an agent on. Once per manager object: a manager in legacy mode has
   * its window written down (presentRows([]), which also finishes a
   * write-down cut short), and the agent's own rows stored and not in its
   * window are presented to it, in record order (an undone turn's rows are
   * not: getUnpresentedMessages leaves them out). A window that can't be
   * written down (another version's index format, or a failed write; not a
   * write-down that threw once its record was written, which reads as
   * presented: writeDown) leaves the agent in legacy mode, traced once,
   * until a move of the store's branch writes its window down on the new
   * branch (rebase): its window is the whole record, as before the index.
   * Then, every time, the agent's own-row sink is installed, and every scan
   * memo is dropped, since a registration can change who reads a slot.
   */
  adopt(agent: PresentedAgent): void {
    const cm = agent.getContextManager();
    this.generation++;
    let state = this.adopted.get(cm);
    if (!state) {
      state = {};
      this.adopted.set(cm, state);
      this.writeDown(agent, state, 'adopt');
      if (!state.pinnedLegacy) {
        this.repair(agent);
        // A reader fork is framed before it is taken on (noteFramed at its
        // derivation, adopt at its run's registration): the held rows it was
        // handed enter its window now, after its framing row.
        this.presentFramed(agent);
      }
    }
    if (!state.pinnedLegacy) agent.setOwnRowSink?.((ids) => this.presentOwn(agent, ids));
  }

  /**
   * The store's branch moved under an agent taken on (a host's switchBranch,
   * a rollback's or a suppression's switch, a failed surgery's restore).
   * Its manager's window index is the new branch's: on a branch made before
   * the agent's write-down (every branch an earlier release's store holds,
   * or a rollback into rows the write-down presented, which branchAt cuts
   * at their own sequence) there is none, and the window would be the
   * whole record for the rest of the process. So, as at adopt, such a
   * window is written down (presentRows([]), traced as presented at
   * `'rebase'`), and the agent's own rows stored and not in its window are
   * presented to it (the own-row sweep). A window that is presented on the
   * new branch is presented again for an agent left in legacy mode by an
   * earlier branch, its own-row sink installed. A window that can't be
   * written down, or a manager whose strategy couldn't follow the move
   * (`failure`, from its re-initialization by the framework, #353), leaves
   * the agent in legacy mode until the next move, traced as
   * presentation:failed at `'rebase'`. Arrivals aren't presented here: the
   * framework's surgery release presents what each agent is owed. Never
   * throws.
   */
  rebase(agent: PresentedAgent, failure?: unknown): void {
    const cm = agent.getContextManager();
    const state = this.adopted.get(cm);
    if (!state) return;
    this.generation++;
    this.memos.delete(cm);
    try {
      if (failure !== undefined) {
        state.pinnedLegacy = describe(failure);
        this.host.emitTrace({ type: 'presentation:failed', agentName: agent.name, occasion: 'rebase', error: state.pinnedLegacy });
        return;
      }
      if (cm.isClosed()) return;
      delete state.pinnedLegacy;
      if (!this.writeDown(agent, state, 'rebase')) return;
      agent.setOwnRowSink?.((ids) => this.presentOwn(agent, ids));
      this.repair(agent, 'rebase');
    } catch (error) {
      state.pinnedLegacy = describe(error);
      this.host.emitTrace({ type: 'presentation:failed', agentName: agent.name, occasion: 'rebase', error: state.pinnedLegacy });
    }
  }

  /**
   * Write `agent`'s window down where its manager is in legacy mode
   * (presentRows([]), which also finishes a write-down cut short), and say
   * whether the window is presented after it. A write-down that fails, or
   * leaves the manager in legacy mode, pins the agent in legacy mode
   * (`state.pinnedLegacy`), traced as presentation:failed at `occasion`. A
   * write-down that throws once its record is written (the store's own work
   * after a write, such as a snapshot, failing) has written the window
   * down: the manager reads its index again after any throw, so a window
   * that reads as presented then is taken as one, and the agent is
   * presented for, with a log line. A write-down at a rebase is traced as
   * presented, with the bodies the window holds.
   */
  private writeDown(agent: PresentedAgent, state: Adopted, occasion: 'adopt' | 'rebase'): boolean {
    const cm = agent.getContextManager();
    let wrote = false;
    if (cm.windowMode() === 'legacy') {
      try {
        cm.presentRows([]);
        wrote = true;
      } catch (error) {
        if (!readsPresented(cm)) {
          state.pinnedLegacy = describe(error);
          this.host.emitTrace({ type: 'presentation:failed', agentName: agent.name, occasion, error: state.pinnedLegacy });
          return false;
        }
        console.warn(`[presentation] ${agent.name}: writing its window down at ${occasion} threw after the window was written (${describe(error)}); its window is presented`);
        wrote = true;
      }
    }
    if (cm.windowMode() !== 'presented') {
      state.pinnedLegacy = 'the window is not in presented mode after its write-down';
      this.host.emitTrace({ type: 'presentation:failed', agentName: agent.name, occasion, error: state.pinnedLegacy });
      return false;
    }
    if (wrote && occasion === 'rebase') {
      const count = bodyHeadCount(cm.getPresentedMessages());
      if (count > 0) this.host.emitTrace({ type: 'presentation:presented', agentName: agent.name, occasion, count });
    }
    return true;
  }

  /** Let an agent go: its sink off, and what the module kept for it (its memo, its framing, its held arrivals) dropped. */
  forget(agent: PresentedAgent): void {
    agent.setOwnRowSink?.(undefined);
    const cm = agent.getContextManager();
    this.adopted.delete(cm);
    this.memos.delete(cm);
    this.failedOwn.delete(cm);
    this.heldUntilStart.delete(cm);
    this.framed.delete(agent.name);
    this.generation++;
  }

  /**
   * For every live agent the module presents to and whose turn isn't alive:
   * its own rows stored and not in its window (the own-row sweep, traced as
   * presentation:repaired), then whatever it is owed at rest (presentAtEnd).
   * Boot runs it once every agent is taken on and the stored rows are in,
   * whether or not an adopt repaired anything.
   */
  repairAndRest(): void {
    for (const agent of this.host.liveAgents()) {
      if (!this.presenting(agent) || this.host.turnAlive(agent.name)) continue;
      this.repair(agent);
      this.presentAtRest(agent, 'at-rest');
    }
  }

  /** Whether the module presents for this agent: taken on, its manager open and in presented mode. */
  presenting(agent: PresentedAgent): boolean {
    const cm = agent.getContextManager();
    const state = this.adopted.get(cm);
    return !!state && !state.pinnedLegacy && !cm.isClosed() && cm.windowMode() === 'presented';
  }

  // --------------------------------------------------------------------------
  // Presentation points
  // --------------------------------------------------------------------------

  /**
   * Present the agent's own rows now, in the order given, those not in its
   * window yet, even while the host is frozen; then tell the other readers
   * of its slot (afterStore). The own-row sink calls it. It is for a row the
   * agent's stream carries (its round, its results, a notice injected at its
   * boundary), one written before its next compile or after its stream's
   * last request, or one written while it has no turn alive: any other row
   * would enter a live window its requests don't carry, so its writer holds
   * it back (storeOwnRow's `present: false`) for the next point's sweep.
   *
   * An own row whose presentation here failed (a transient store error) is
   * kept, and presented ahead of the rows given at the agent's next call,
   * in record order, while it is still out of the window: its window's
   * ordinals never move, so a row written after it and presented first
   * would stay ahead of it for good (a round's results ahead of its reply,
   * which every later compile would send so). It is kept until the agent's
   * next turn start or tool boundary, whose own-row sweep presents it by
   * that point's rule, or leaves it for the next point when that fails
   * too: a request compiled, or a stream handed its rows, without it
   * mustn't find it in the window ahead of a reply it didn't come before.
   * A row its writer held back is never kept: it waits for the next point's
   * sweep. Never throws.
   */
  presentOwn(agent: PresentedAgent, ids: ReadonlyArray<MessageId | undefined>): void {
    let tried: readonly MessageId[] = unique(ids);
    try {
      if (!this.presenting(agent)) return;
      const cm = agent.getContextManager();
      tried = unique([...this.failedOwnOf(agent), ...ids]).filter((id) => cm.ordinalOf(id) === undefined);
      this.present(agent, tried, 'write');
      this.keepFailedOwn(agent, tried);
      this.afterStore(agent, ids);
    } catch (error) {
      this.failed(agent, 'write', error);
      this.keepFailedOwn(agent, tried);
    }
  }

  /**
   * Rows `writer` just stored, in its own slot: each other reader of that
   * slot (its owners and its observers) whose turn isn't alive, and the
   * writer itself, is presented what it is owed at once, when one of the
   * rows is an arrival for it (present at rest). A reader with a turn alive
   * takes them at its next point. Frozen, only own rows present. Never throws.
   */
  afterStore(writer: PresentedAgent, ids: ReadonlyArray<MessageId | undefined>): void {
    try {
      const stored = unique(ids);
      if (stored.length === 0) return;
      const writerCm = writer.getContextManager();
      const rows = stored.map((id) => writerCm.getMessage(id)).filter((row): row is StoredMessage => row !== null);
      const slot = this.host.registry.ownSlotOf(writer.name);
      const readers = new Set<AgentName>([writer.name, ...(slot ? this.host.registry.readersOf(slot) : [])]);
      for (const reader of this.host.liveAgents()) {
        if (!readers.has(reader.name) || !this.presenting(reader) || this.host.turnAlive(reader.name)) continue;
        const facts = readerFacts(this.host.registry, reader.name);
        const inOwnSlot = reader === writer || sameSlot(facts.ownSlot, slot);
        // A row the writer's own slot doesn't hold (none found) can't be
        // weighed here; the reader's own scan weighs it.
        const owed = rows.length < stored.length || rows.some((row) => bearingOf(row, facts, inOwnSlot) !== 'elsewhere');
        if (owed) this.presentAtRest(reader, 'at-rest');
      }
    } catch (error) {
      this.failed(writer, 'at-rest', error);
    }
  }

  /**
   * A turn's start, before its compile. `'turn-start'` (a fresh start) and
   * `'assembly'` (the rows a wake assembled for it) present, in one call and
   * record order, the agent's own rows not in its window and its arrivals
   * (none while frozen); `'compile'`, the backstop before every compile,
   * fresh or resumed, its own rows only. Returns the arrivals presented, one
   * per body, for the start to weigh. A fresh start ends a rollback's hold
   * on the arrivals its cut returned (holdUntilStart): they enter with the
   * rest, in record order.
   */
  presentAtStart(agent: PresentedAgent, occasion: 'turn-start' | 'assembly' | 'compile'): StoredMessage[] {
    if (!this.presenting(agent)) return [];
    // The sweep below decides the own rows a failed write left (presentOwn).
    this.failedOwn.delete(agent.getContextManager());
    // A fresh start is where a rollback's returned arrivals enter (holdUntilStart).
    if (occasion !== 'compile') this.heldUntilStart.delete(agent.getContextManager());
    return this.presentPending(agent, occasion, occasion !== 'compile' && !this.host.frozen());
  }

  /**
   * A tool boundary. First the round's own rows on the wire (`wire`: its
   * reply, its results, a clock row due), those not in the window yet, in
   * order; if that fails, nothing more. Then, unless the host is frozen or
   * the stream can't carry injected rows (`injects` false), the agent's own
   * rows not in its window and its arrivals, by bodies in record order, up
   * to the first body the stream can't carry (isInjectableMidTurn: a tool
   * block, or a row named as the agent), presented in one call: each body
   * whole, named by its first shard not in the window. Those are what the
   * stream carries next (`heard`); the cut body and those after it wait for
   * the turn's end. A presentation cut short hears only the bodies wholly in
   * the window. A read of the window or the record that throws is traced as
   * presentation:failed, and the stream hears nothing: what wasn't presented
   * waits for the next point, and the hand-off that follows checks the
   * window as it then stands. Never throws, so the boundary goes on to hand
   * the stream its results.
   */
  presentAtBoundary(agent: PresentedAgent, wire: ReadonlyArray<MessageId | undefined>, options: { injects: boolean }): BoundaryPresentation {
    try {
      if (!this.presenting(agent)) return { heard: [] };
      const cm = agent.getContextManager();
      const missing = unique(wire).filter((id) => cm.ordinalOf(id) === undefined);
      // The round's rows are presented here, in order, and the own rows a
      // failed write left (presentOwn) are this boundary's to sweep, or the
      // next point's: none is put ahead of the next round's reply.
      this.failedOwn.delete(cm);
      if (missing.length > 0 && this.present(agent, missing, 'tool-boundary').error !== undefined) return { heard: [] };
      if (this.host.frozen() || !options.injects) return { heard: [] };
      const bodies = this.pending(agent, true);
      const cut = bodies.findIndex((body) => body.shards.some((shard) => !isInjectableMidTurn(shard, agent)));
      const prefix = cut === -1 ? bodies : bodies.slice(0, cut);
      const cutAt = cut === -1 ? undefined : bodies[cut]!.shards[0]!.id;
      const { entered } = this.present(agent, prefix.map((body) => body.shards[0]!.id), 'tool-boundary', {
        unstamped: prefix.filter((body) => body.unstamped).length,
        ...(cutAt !== undefined ? { cutAt } : {}),
      }, prefix);
      const heard = prefix
        .filter((body) => entered.has(body.shards[0]!.id) && body.shards.every((shard) => cm.ordinalOf(shard.id) !== undefined))
        .map((body): HeardRow => {
          const head = body.shards[0]!;
          return {
            id: head.id,
            participant: head.participant,
            content: asCompiled(body.shards),
            ...(head.metadata !== undefined ? { metadata: head.metadata } : {}),
          };
        });
      return { heard, ...(cutAt !== undefined ? { cutAt } : {}) };
    } catch (error) {
      this.failed(agent, 'tool-boundary', error);
      return { heard: [] };
    }
  }

  /**
   * A turn's end, and an agent at rest: when its logical turn isn't alive,
   * its own rows not in its window and its arrivals (none while frozen), in
   * one call and record order. Nothing while the turn is alive. Idempotent.
   * Returns the arrivals presented, one per body.
   */
  presentAtEnd(agent: PresentedAgent): StoredMessage[] {
    return this.presentAtRest(agent, 'turn-end');
  }

  /**
   * The rows a rollback's branch cut took out of the agent's window and
   * kept in the record (its `returnedToArrivals`, #291): they are arrivals
   * again, and wait outside the window until the agent's next turn start
   * (presentAtStart's `'turn-start'` or `'assembly'`), which presents them
   * with whatever else it is owed, in record order. Until then no point at
   * rest presents them: not the surgery's release, a resume, a turn's end
   * or a row stored for the agent while it is idle, so the cut the
   * operator made is what the agent's window holds until it speaks again.
   * A tool boundary isn't held back (a turn alive started since). An own
   * row among them isn't held: own rows enter at every point, as ever. In
   * memory: a restart presents them at its pass at rest, and an agent let
   * go (forget) drops them. Rows given again add to those held. Never throws.
   */
  holdUntilStart(agent: PresentedAgent, ids: readonly MessageId[]): void {
    const named = unique(ids);
    if (named.length === 0) return;
    const cm = agent.getContextManager();
    const held = this.heldUntilStart.get(cm) ?? new Set<MessageId>();
    for (const id of named) held.add(id);
    this.heldUntilStart.set(cm, held);
  }

  /**
   * The check before a tool boundary hands the stream its rows: `sent` (the
   * round's reply, its results and the injected rows, in the order the
   * stream is given them) not yet in the window are presented, in order,
   * and the window's newest bodies must then be exactly those rows. On a
   * mismatch it traces presentation:hand-off-mismatch and the rows are not
   * vouched for, so the stream's later thinking is left out at the next
   * compile rather than sent under a prefix its window doesn't hold. An
   * agent the module doesn't present for is vouched for as before. A read
   * of the window that throws is traced as presentation:failed, and the
   * rows are not vouched for: the check couldn't be made. Never throws.
   */
  handOff(agent: PresentedAgent, sent: ReadonlyArray<MessageId | undefined>): { vouched: boolean } {
    try {
      if (!this.presenting(agent)) return { vouched: true };
      const cm = agent.getContextManager();
      const expected = unique(sent);
      if (expected.length === 0) return { vouched: true };
      const missing = expected.filter((id) => cm.ordinalOf(id) === undefined);
      if (missing.length > 0 && this.present(agent, missing, 'hand-off').error !== undefined) {
        this.host.emitTrace({ type: 'presentation:hand-off-mismatch', agentName: agent.name, expected, tail: lastBodyHeads(cm.getPresentedMessages(), expected.length) });
        return { vouched: false };
      }
      const tail = lastBodyHeads(cm.getPresentedMessages(), expected.length);
      if (tail.length !== expected.length || tail.some((id, i) => id !== expected[i])) {
        this.host.emitTrace({ type: 'presentation:hand-off-mismatch', agentName: agent.name, expected, tail });
        return { vouched: false };
      }
      return { vouched: true };
    } catch (error) {
      this.failed(agent, 'hand-off', error);
      return { vouched: false };
    }
  }

  /** A read of the agent's arrivals not yet presented, one per body, in record order (for previews and a release). */
  arrivalsOf(agent: PresentedAgent): StoredMessage[] {
    if (!this.presenting(agent)) return [];
    return this.pending(agent, true).filter((body) => body.bearing === 'arrival').map((body) => body.shards[0]!);
  }

  /**
   * A reader fork was handed held rows as framing (AF-5): those not in its
   * window yet are presented there, when the module presents for it, and
   * the fork counts as holding every one of them (holders, `'framing'`),
   * however its window filters held rows, until it is let go (forget). A
   * fork framed before it is taken on has them presented at its adopt. Its
   * window's filter (the residents', which a reader fork inherits) keeps
   * them out of its compiles, where its framing row shows them; nothing
   * else of its window moves.
   */
  noteFramed(agent: PresentedAgent, rowIds: readonly MessageId[]): void {
    const set = this.framed.get(agent.name) ?? new Set<MessageId>();
    for (const id of rowIds) set.add(id);
    this.framed.set(agent.name, set);
    this.presentFramed(agent);
  }

  /**
   * Drop the rows a reader fork was handed as framing (noteFramed) when the
   * fork is never taken on, so never let go (forget): one its run refused
   * before registering it (the host quiesced or stopping, a surgery holding
   * the store). Nothing for a name handed none.
   */
  forgetFramed(agent: AgentName): void {
    this.framed.delete(agent);
  }

  /**
   * The rows the agent is owed and its window doesn't hold yet, one per
   * body (its first shard not in the window), in record order: its own rows
   * and its arrivals, frozen or not, whatever its turn. None for an agent the
   * module doesn't present for. The subconscious's window start is fixed
   * once no row it is owed stored before the start is among them.
   */
  owedOf(agent: PresentedAgent): StoredMessage[] {
    if (!this.presenting(agent)) return [];
    return this.pending(agent, true).map((body) => body.shards[0]!);
  }

  // --------------------------------------------------------------------------
  // Reads
  // --------------------------------------------------------------------------

  /**
   * Every live agent holding a row: each whose window has it at a place,
   * leaving out one whose window leaves held rows out when the row is held
   * (a window written down from the record took them in); each whose window
   * is still the whole record and whose record holds it; and each reader fork
   * handed it as framing.
   */
  holders(rowId: MessageId): Holder[] {
    const holders: Holder[] = [];
    const inWindow = new Set<AgentName>();
    for (const agent of this.host.liveAgents()) {
      const cm = agent.getContextManager();
      if (cm.isClosed()) continue;
      if (this.adopted.get(cm)?.pinnedLegacy || cm.windowMode() !== 'presented') {
        if (cm.getMessage(rowId) !== null || cm.getPresentedMessages().some((m) => m.id === rowId)) {
          holders.push({ agent: agent.name, via: 'legacy' });
        }
        continue;
      }
      const position = positionIn(cm, rowId);
      if (position === undefined) continue;
      if (readerFacts(this.host.registry, agent.name).hidesHeld
        && heldFromResidents(cm.getMessage(rowId)?.metadata as Record<string, unknown> | undefined)) continue;
      holders.push({ agent: agent.name, via: 'window', position });
      inWindow.add(agent.name);
    }
    for (const [agent, ids] of this.framed) {
      if (ids.has(rowId) && !inWindow.has(agent)) holders.push({ agent, via: 'framing' });
    }
    return holders;
  }

  /**
   * Rows removed from the record through `remover` (a context manager of a
   * live agent's, or one opened apart from them), taken out of every other
   * live agent's window that still holds them: context-manager tombstones a
   * removal in the remover's own window only, and another window on the
   * same slot, or merging it, keeps the row's place (CM-T) while its listing
   * and its compile leave the row out. Each row leaves at its own place, so
   * no other row's place moves, and a cursor or watermark kept by place
   * stays good. A window on a branch whose record still holds the row (a
   * fork, a derived agent's view made before the removal) keeps it, as does
   * a window that is still the record, which is never written to here
   * (context-manager's retractRemoved passes over both). Each window's rows
   * taken out are traced (presentation:retracted, with `reason`), and a
   * window that couldn't be repaired is logged and passed by: the removal
   * stands. `ids` names every row removed, a body by each of its shards.
   * Returns what left each window. Never throws.
   */
  retractRemoved(remover: WindowManager | undefined, ids: readonly MessageId[], reason: PresentationRetractReason): Array<{ agent: AgentName; ids: MessageId[] }> {
    const named = unique(ids).filter((id) => id !== '');
    if (named.length === 0) return [];
    const visited = new Set<WindowManager>(remover ? [remover] : []);
    const out: Array<{ agent: AgentName; ids: MessageId[] }> = [];
    for (const agent of this.host.liveAgents()) {
      const cm = agent.getContextManager();
      if (visited.has(cm)) continue;
      visited.add(cm);
      try {
        // A window that is still the record holds no place for the row:
        // checked here as well as by the call, which writes nothing then.
        if (cm.isClosed() || cm.windowMode() !== 'presented') continue;
        const taken = cm.retractRemoved(named);
        if (taken.length === 0) continue;
        out.push({ agent: agent.name, ids: taken });
        this.host.emitTrace({ type: 'presentation:retracted', agentName: agent.name, messageIds: taken, reason });
      } catch (error) {
        console.error(`[presentation] could not take ${named.length} removed row(s) out of ${agent.name}'s window (${reason}); the removal stands: ${describe(error)}`);
      }
    }
    return out;
  }

  /**
   * At boot, after every live agent is taken on: take out of each window
   * the module presents for every row it holds that its record no longer
   * does (context-manager's retractAbsentRows), as retractRemoved takes out
   * the rows a live removal named. These are rows removed where no live
   * context heard it: by an offline recovery's suppressions, with the host
   * stopped, through the one context it opened, and removals whose own
   * tombstone failed. Traced as presentation:retracted with `boot`; a
   * window that couldn't be repaired is logged and passed by. Each agent's
   * context is open with every slot it merges by then, so a row of a slot
   * it merges isn't taken for removed. Never throws.
   */
  retractAbsentRows(): Array<{ agent: AgentName; ids: MessageId[] }> {
    const out: Array<{ agent: AgentName; ids: MessageId[] }> = [];
    const visited = new Set<WindowManager>();
    for (const agent of this.host.liveAgents()) {
      const cm = agent.getContextManager();
      if (visited.has(cm)) continue;
      visited.add(cm);
      try {
        if (!this.presenting(agent)) continue;
        const taken = cm.retractAbsentRows();
        if (taken.length === 0) continue;
        out.push({ agent: agent.name, ids: taken });
        this.host.emitTrace({ type: 'presentation:retracted', agentName: agent.name, messageIds: taken, reason: 'boot' });
      } catch (error) {
        console.error(`[presentation] could not take removed rows out of ${agent.name}'s window at boot: ${describe(error)}`);
      }
    }
    return out;
  }

  /** Whether a reader fork was handed the row as framing (noteFramed), and
   *  hasn't been let go since, whether or not its window holds the row. */
  framedToAny(rowId: MessageId): boolean {
    for (const ids of this.framed.values()) if (ids.has(rowId)) return true;
    return false;
  }

  /** Whether any live agent but `except` holds the row in a window or as framing: a window that is still the record doesn't count. */
  presentedToAnyone(rowId: MessageId, options: { except?: AgentName } = {}): boolean {
    return this.holders(rowId).some((h) => h.via !== 'legacy' && h.agent !== options.except);
  }

  /** The rows of the agent's window at or after `mark`, in window order; none in legacy mode. */
  presentedSince(agent: PresentedAgent, mark: Position): StoredMessage[] {
    const cm = agent.getContextManager();
    if (cm.windowMode() !== 'presented') return [];
    return cm.getPresentedMessages().filter((m) => (cm.ordinalOf(m.id) ?? -1) >= mark);
  }

  /** Hear each presentation into the named agent's window, after its rows entered. Returns the unsubscribe. */
  onPresented(agentName: AgentName, listener: (event: PresentedEvent) => void): () => void {
    const set = this.listeners.get(agentName) ?? new Set();
    set.add(listener);
    this.listeners.set(agentName, set);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(agentName) === set) this.listeners.delete(agentName);
    };
  }

  /**
   * A write's stamp, checked as it is stored through `deliveredTo`'s
   * context: an audience none of whose agents reads that slot is traced
   * (presentation:unreadable-audience), once for the write. The row is
   * stored as named.
   */
  checkAudience(metadata: MessageMetadata | undefined, deliveredTo: AgentName): void {
    const stamp = audienceOf(metadata);
    if (!stamp) return;
    const slot = this.host.registry.ownSlotOf(deliveredTo);
    if (!slot || !audienceFault(stamp.audience, slot, this.host.registry)) return;
    this.host.emitTrace({ type: 'presentation:unreadable-audience', audience: stamp.audience, slot, deliveredTo });
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /**
   * The own rows whose presentation at their write failed (presentOwn) and
   * that are still out of the agent's window, in record order. A row that
   * entered by another point since, was undone, or left the record (a
   * branch move, a removal) is dropped.
   */
  private failedOwnOf(agent: PresentedAgent): MessageId[] {
    const cm = agent.getContextManager();
    const kept = this.failedOwn.get(cm);
    if (!kept || kept.size === 0) return [];
    const owed: Array<{ id: MessageId; sequence: number }> = [];
    for (const id of kept) {
      const row = cm.windowStatusOf(id) === 'out' ? cm.getMessage(id) : null;
      if (row) owed.push({ id, sequence: row.sequence });
    }
    if (owed.length === 0) this.failedOwn.delete(cm);
    return owed.sort((a, b) => a.sequence - b.sequence).map((row) => row.id);
  }

  /** Keep, of the own rows presentOwn tried, those still out of the window, for its next call; forget the rest. */
  private keepFailedOwn(agent: PresentedAgent, tried: readonly MessageId[]): void {
    const cm = agent.getContextManager();
    try {
      const left = tried.filter((id) => cm.ordinalOf(id) === undefined);
      if (left.length > 0) this.failedOwn.set(cm, new Set(left));
      else this.failedOwn.delete(cm);
    } catch {
      // A window that can't be read now: keep every row tried.
      if (tried.length > 0) this.failedOwn.set(cm, new Set(tried));
    }
  }

  /** presentAtEnd under a named occasion; a rollback's held arrivals wait (holdUntilStart). */
  private presentAtRest(agent: PresentedAgent, occasion: 'turn-end' | 'at-rest'): StoredMessage[] {
    if (!this.presenting(agent) || this.host.turnAlive(agent.name)) return [];
    return this.presentPending(agent, occasion, !this.host.frozen(), true);
  }

  /** The rows the agent was handed as framing (noteFramed) that its window doesn't hold yet, presented in the order handed. */
  private presentFramed(agent: PresentedAgent): void {
    const framed = this.framed.get(agent.name);
    if (!framed || framed.size === 0) return;
    try {
      if (!this.presenting(agent)) return;
      const cm = agent.getContextManager();
      // presentRows refuses a row the window holds already, and a reader
      // fork derived from a presented window holds those rows its parent's
      // window was written down with.
      const unpresented = new Set(cm.getUnpresentedMessages().map((m) => m.id));
      this.present(agent, [...framed].filter((id) => unpresented.has(id)), 'framing');
    } catch (error) {
      this.failed(agent, 'framing', error);
    }
  }

  /** The own-row sweep: the agent's own rows not in its window, presented in record order, traced as a repair. */
  private repair(agent: PresentedAgent, occasion: 'adopt' | 'rebase' = 'adopt'): void {
    try {
      const own = this.pending(agent, false);
      if (own.length === 0) return;
      const { entered } = this.present(agent, own.map((body) => body.shards[0]!.id), occasion, undefined, own, true);
      if (entered.size > 0) this.host.emitTrace({ type: 'presentation:repaired', agentName: agent.name, count: entered.size });
    } catch (error) {
      this.failed(agent, occasion, error);
    }
  }

  /**
   * Present the agent's own pending rows, and its arrivals when `arrivals`
   * (but those a rollback holds for its next start, with `atRest`), in one
   * call; return the arrivals that entered whole.
   */
  private presentPending(agent: PresentedAgent, occasion: PresentationOccasion, arrivals: boolean, atRest = false): StoredMessage[] {
    try {
      const cm = agent.getContextManager();
      const bodies = this.pending(agent, arrivals, atRest);
      if (bodies.length === 0) return [];
      const { entered } = this.present(agent, bodies.map((body) => body.shards[0]!.id), occasion, {
        unstamped: bodies.filter((body) => body.unstamped).length,
      }, bodies);
      return bodies
        .filter((body) => body.bearing === 'arrival' && entered.has(body.shards[0]!.id)
          && body.shards.every((shard) => cm.ordinalOf(shard.id) !== undefined))
        .map((body) => body.shards[0]!);
    } catch (error) {
      this.failed(agent, occasion, error);
      return [];
    }
  }

  /**
   * The agent's pending bodies, in record order: its own rows not in its
   * window, and its arrivals when `arrivals`, leaving out, with `atRest`,
   * an arrival a rollback holds for the agent's next start (any shard of
   * its body held). A body is its run of unpresented shards
   * (continuesBody), weighed by its first.
   */
  private pending(agent: PresentedAgent, arrivals: boolean, atRest = false): PendingBody[] {
    const cm = agent.getContextManager();
    const held = atRest ? this.heldUntilStart.get(cm) : undefined;
    const unpresented = cm.getUnpresentedMessages();
    const facts = readerFacts(this.host.registry, agent.name);
    const factsKey = JSON.stringify(facts);
    const branch = cm.currentBranch().name;
    const length = cm.indexLength();
    let memo = this.memos.get(cm);
    if (!memo || memo.generation !== this.generation || memo.branch !== branch || memo.length !== length || memo.facts !== factsKey) {
      memo = { generation: this.generation, branch, length, facts: factsKey, scanFrom: -Infinity };
      this.memos.set(cm, memo);
    }
    const bodies: PendingBody[] = [];
    let firstOwed: number | undefined;
    let newest = memo.scanFrom;
    let i = 0;
    while (i < unpresented.length) {
      const start = i;
      i++;
      while (i < unpresented.length && continuesBody(unpresented[i - 1], unpresented[i])) i++;
      const head = unpresented[start]!;
      newest = Math.max(newest, unpresented[i - 1]!.sequence);
      if (head.sequence <= memo.scanFrom) continue;
      const inOwnSlot = cm.getMessage(head.id) !== null;
      const bearing = bearingOf(head, facts, inOwnSlot);
      if (bearing === 'elsewhere') continue;
      firstOwed ??= head.sequence;
      if (bearing === 'arrival' && !arrivals) continue;
      // Still owed (firstOwed), so a later scan starts at or before it.
      if (bearing === 'arrival' && held && held.size > 0
        && unpresented.slice(start, i).some((shard) => held.has(shard.id))) continue;
      bodies.push({ shards: unpresented.slice(start, i), bearing, unstamped: audienceOf(head.metadata) === undefined });
    }
    memo.scanFrom = firstOwed !== undefined ? Math.max(memo.scanFrom, firstOwed - 1) : newest;
    return bodies;
  }

  /**
   * One presentRows call for `ids` in the agent's window: on a throw, the
   * rows that entered before it count, and the failure is traced. Traces
   * what entered and tells the listeners.
   */
  private present(
    agent: PresentedAgent,
    ids: readonly MessageId[],
    occasion: PresentationOccasion,
    extra?: { unstamped?: number; cutAt?: MessageId },
    bodies?: readonly PendingBody[],
    quiet = false,
  ): { entered: Set<MessageId>; error?: unknown } {
    if (ids.length === 0) return { entered: new Set() };
    const cm = agent.getContextManager();
    let error: unknown;
    try {
      cm.presentRows(ids);
    } catch (thrown) {
      error = thrown;
    }
    const entered = new Set(ids.filter((id) => cm.ordinalOf(id) !== undefined));
    const memo = this.memos.get(cm);
    if (memo) memo.length = cm.indexLength();
    if (error !== undefined) this.failed(agent, occasion, error);
    if (entered.size > 0) {
      if (!quiet) {
        const unstamped = extra?.unstamped !== undefined && bodies
          ? bodies.filter((body) => body.unstamped && entered.has(body.shards[0]!.id)).length
          : 0;
        this.host.emitTrace({
          type: 'presentation:presented',
          agentName: agent.name,
          occasion,
          count: entered.size,
          ...(extra?.cutAt !== undefined ? { cutAt: extra.cutAt } : {}),
          ...(unstamped > 0 ? { unstamped } : {}),
        });
      }
      this.tell(agent, occasion, ids, entered, bodies);
    }
    return { entered, ...(error !== undefined ? { error } : {}) };
  }

  /** Tell the agent's listeners of the rows that entered its window, in order. */
  private tell(
    agent: PresentedAgent,
    occasion: PresentationOccasion,
    ids: readonly MessageId[],
    entered: ReadonlySet<MessageId>,
    bodies?: readonly PendingBody[],
  ): void {
    const listeners = this.listeners.get(agent.name);
    if (!listeners || listeners.size === 0) return;
    const cm = agent.getContextManager();
    const byHead = new Map((bodies ?? []).map((body) => [body.shards[0]!.id, body.shards] as const));
    let window: StoredMessage[] | undefined;
    const rows = ids.filter((id) => entered.has(id)).flatMap((id) => {
      const shards = byHead.get(id);
      if (shards) return shards.filter((shard) => cm.ordinalOf(shard.id) !== undefined);
      // A row named alone (an own row at its write): its body as the window now holds it.
      window ??= cm.getPresentedMessages();
      const at = window.findIndex((m) => m.id === id);
      if (at === -1) return [];
      let end = at + 1;
      while (end < window.length && continuesBody(window[end - 1], window[end])) end++;
      return window.slice(at, end);
    });
    for (const listener of [...listeners]) {
      try {
        listener({ agentName: agent.name, occasion, rows });
      } catch (error) {
        console.error(`[presentation] a listener of ${agent.name}'s window failed:`, error);
      }
    }
  }

  private failed(agent: PresentedAgent, occasion: PresentationOccasion, error: unknown): void {
    console.error(`[presentation] ${agent.name}: presenting at ${occasion} failed; what it didn't present waits for the next point:`, error);
    this.host.emitTrace({ type: 'presentation:failed', agentName: agent.name, occasion, error: describe(error) });
  }
}

/** Whether `cm`'s window reads as presented; a mode that can't be read is not. */
function readsPresented(cm: Pick<WindowManager, 'windowMode'>): boolean {
  try {
    return cm.windowMode() === 'presented';
  } catch {
    return false;
  }
}

/** The defined ids, each once, in order. */
function unique(ids: ReadonlyArray<MessageId | undefined>): MessageId[] {
  const seen = new Set<MessageId>();
  const out: MessageId[] = [];
  for (const id of ids) {
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** How many bodies a window holds, a sharded one counted once. */
function bodyHeadCount(window: readonly StoredMessage[]): number {
  let count = 0;
  for (let i = 0; i < window.length; i++) if (i === 0 || !continuesBody(window[i - 1], window[i])) count++;
  return count;
}

/** The ids of the last `count` bodies of a window, by their first shards, in window order. */
function lastBodyHeads(window: readonly StoredMessage[], count: number): MessageId[] {
  const heads: MessageId[] = [];
  for (let i = window.length - 1; i >= 0 && heads.length < count; i--) {
    if (i === 0 || !continuesBody(window[i - 1], window[i])) heads.unshift(window[i]!.id);
  }
  return heads;
}
