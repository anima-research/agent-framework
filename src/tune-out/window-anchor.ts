/**
 * Where the persistent subconscious's window starts (#291, AF-5).
 *
 * The subconscious reads a tune-out's held traffic through a windowed
 * passthrough strategy: everything from the anchor on, the anchor at the
 * oldest active tune-out's start (the coordinator's anchorSubconscious), or
 * at an earlier start kept in force: a cancelled tune-out's, kept while
 * another stays active and across a restart, until the next enter sets the
 * oldest active one's (below).
 * While its window is the record, a start is a sequence, and the window is
 * every row stored at it or after. Once its window follows the presentation
 * index, the window is the rows in the order it was shown them, and a start
 * is an index ordinal: the row at it and every row presented after it.
 *
 * A tune-out's start can't be turned into an ordinal once and for all at its
 * enter. The subconscious's window grows only at its own points, so a row
 * stored before the start can still be out of its window then (its turn
 * alive, the host quiesced), and would be presented after the start, inside
 * the window. Converting the sequence again later (a restart, another
 * tune-out's enter) can give another ordinal, and so another window, once
 * rows have been presented out of record order. So each tune-out's start is
 * fixed once, at the first moment no row the subconscious is owed stored
 * before the start is out of its window: the ordinal just past the last row
 * in its window stored before the start, which leaves every such row out
 * (0 when there is none). Others' rows enter a window in record order, so
 * that is where the first row stored at the start or after entered, unless
 * one of the subconscious's own rows was presented ahead of them, at its
 * write, in the turn the tune-out began in; that row stays out too, the turn
 * having been before the tune-out. The coordinator keeps the ordinal
 * (subconsciousWindowFixed), and from then on the start is set by it,
 * clamped to the window's length on a branch whose window is shorter (a
 * rollback), the clamped ordinal then kept as the start, never converted
 * again. A kept ordinal is kept as the start in force once it is set, not
 * before, and one whose setting or keeping fails is tried again at the next
 * presentation, as a fix is. One set while the window is the record (a
 * branch move whose re-initialization of the subconscious failed) waits
 * longer: it is set by sequence and fixed at the next enter or restart once
 * the window presents. One whose setting or keeping failed before a branch
 * move is fixed again on the branch moved to, from its window there, as one
 * never fixed is: an ordinal is a place on the branch it was fixed on; one
 * for tune-outs none of which is active then, and a cancelled tune-out's
 * start set in force by its kept ordinal, are dropped at the move. A
 * restart that finds a start in force kept sets that one, and fixes the
 * oldest active tune-out's start, if it isn't kept, without moving the
 * window to it; one that finds none in force kept sets the anchor the
 * strategy persisted, as the start in force: where the oldest's start is
 * kept, if it is earlier (a cancelled tune-out's start that was set but
 * never kept), and where it isn't (its fix set, its keeping failed),
 * wherever it is, rather than converting the oldest's sequence again, that
 * start fixed without moving the window to it; where that anchor can't be
 * read, it sets nothing, the window left where it was until the next enter
 * or restart.
 */
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { SubconsciousWindowStart } from './coordinator.js';
import type { TraceEventInput } from '../types/trace.js';

/** The windowed strategy's anchor setters and read, as the anchor uses them. */
export interface AnchoredStrategy {
  setAnchor(sequence: number): void;
  setAnchorOrdinal(ordinal: number): void;
  getAnchorOrdinal(): number | undefined;
}

/** What the anchor reads of the framework. */
export interface SubconsciousWindowAnchorHost {
  /** The subconscious's name, for its traces. */
  readonly agentName: string;
  /** Its context manager while it is registered. */
  cm(): Pick<ContextManager, 'indexLength' | 'getPresentedMessages' | 'ordinalOf'> | undefined;
  /** Its windowed strategy. */
  strategy(): AnchoredStrategy | null;
  /** Whether its window follows the presentation index, so its places are ordinals. */
  presents(): boolean;
  /** The rows it is owed that its window doesn't hold yet, one per body (AgentPresentation.owedOf). */
  owed(): readonly Pick<StoredMessage, 'sequence'>[];
  /**
   * Keep a start fixed for `epochIds` (TuneOutCoordinator.subconsciousWindowFixed), as the start in force when
   * `inForce`; false when it couldn't be kept.
   */
  fixed(epochIds: readonly string[], ordinal: number, inForce: boolean): boolean;
  emitTrace(event: Extract<TraceEventInput, { type: 'tune-out:subconscious-window' }>): void;
}

/** The subconscious's window start, set by sequence in legacy mode and by a fixed ordinal once its window is presented. */
export class SubconsciousWindowAnchor {
  /**
   * The starts whose ordinal isn't set and kept yet, the one in force
   * (`inForce`) first if it is among them: some row older than a start is
   * still out of the window, or setting or keeping the ordinal it was fixed
   * at (`ordinal`) failed, which the next presentation tries again. A start
   * set by an ordinal already known (`known`) waits only for its setting and
   * keeping: kept for `keep` (none for a start in force only) and as the
   * start in force, traced when clamped (`clampedFrom`, the ordinal kept
   * before).
   */
  private pending: Array<{
    start: SubconsciousWindowStart;
    ordinal?: number;
    inForce: boolean;
    known?: { keep: readonly string[]; clampedFrom?: number };
  }> = [];

  constructor(private readonly host: SubconsciousWindowAnchorHost) {}

  /**
   * Set the window start (the coordinator's setSubconsciousAnchor). In
   * legacy mode by its sequence, as before the index. In presented mode by
   * its ordinal when one was fixed, clamped to the window's index length
   * and traced when past it, the clamped ordinal kept as the start; the
   * strategy's persisted anchor where it is earlier, or, with no ordinal
   * known, where it has one, at a resume that asks for it
   * (keepEarlierAnchor); else by its sequence for now, converted as
   * the strategy converts one, and the ordinal is fixed (see the module
   * doc) as soon as no row the subconscious is owed stored before the start
   * is out of its window, now or at a later presentation (presented). An
   * ordinal set is kept as the start in force once it is set, and tried
   * again at the next presentation until both succeed. The starts of
   * `others`, the other active tune-outs' whose ordinal isn't kept yet, are
   * fixed the same way, without moving the window to them. Never throws: a
   * set that fails is logged, and the anchor stays where it was.
   */
  set(start: SubconsciousWindowStart, others: readonly SubconsciousWindowStart[] = []): void {
    try {
      const strategy = this.host.strategy();
      if (!strategy) return;
      if (!this.host.presents()) {
        this.pending = [];
        strategy.setAnchor(start.sequence);
        return;
      }
      const was = this.pending;
      const carried = (wanted: SubconsciousWindowStart, inForce: boolean) => ({
        ...(was.find((p) => !p.known && sameStart(p.start, wanted)) ?? { start: wanted }),
        inForce,
      });
      this.pending = others.map((other) => carried(other, false));
      let known = start.ordinal;
      let inForceOnly = start.inForceOnly === true;
      if (start.keepEarlierAnchor) {
        const persisted = persistedOrdinal(strategy);
        if (persisted === null) {
          // Whether the strategy holds an earlier start (a cancelled
          // tune-out's, set and never kept) can't be told: the kept one set
          // over it would drop the rows it held from the window, and be kept
          // in force. The window stays where it was, nothing set or kept in
          // force; the next enter or restart sets it. The others are fixed,
          // and so is the start itself where no ordinal is kept for it,
          // without moving the window to it.
          if (known === undefined) this.pending.push(carried(start, false));
          this.tryFix();
          return;
        }
        // With no ordinal kept (one fixed and set whose keeping failed), the
        // persisted anchor is the start this window had, wherever it is: the
        // sequence converted again could give a later one, leaving out a
        // row presented out of record order (AF #844 review 5, #47). The
        // start's own ordinal is fixed beside it, unmoved to.
        if (persisted !== undefined && (known === undefined || persisted < known)) {
          if (known === undefined) this.pending.push(carried(start, false));
          known = persisted;
          inForceOnly = true;
        }
      }
      if (known !== undefined) {
        const length = this.host.cm()?.indexLength() ?? 0;
        const ordinal = Math.min(known, length);
        this.pending.unshift({
          start,
          ordinal,
          inForce: true,
          known: { keep: inForceOnly ? [] : start.epochIds, ...(ordinal !== known ? { clampedFrom: known } : {}) },
        });
      } else {
        this.pending.unshift(carried(start, true));
        strategy.setAnchor(start.sequence);
      }
      this.tryFix();
    } catch (error) {
      console.error(`[tune-out] the subconscious's window start couldn't be set, so it stays where it was:`, error);
    }
  }

  /**
   * The store's branch moved (the framework's followBranchMove, before the
   * agents follow it): an ordinal is a place on the branch it was fixed on,
   * so a start pending at one (its setting or keeping failed), or set by one
   * kept there (`known`), waits again to be fixed, from the window it
   * presents on now, as a start never fixed does (tryFix): one for a
   * tune-out still active (`active`, the coordinator's, where the framework
   * says). One fixed for tune-outs none of which is active any more, and
   * the start in force only (a cancelled tune-out's, set by its kept
   * ordinal: fixed again, it would be the active one's start), are dropped,
   * as every start fixed at an ordinal was before (AF #844 review 3, #30
   * and #44): the anchor the destination's strategy keeps stands until the
   * next enter or restart sets one.
   */
  branchMoved(active?: readonly string[]): void {
    const holds = active === undefined ? undefined : new Set(active);
    this.pending = this.pending
      .filter((p) => {
        if (p.known && p.known.keep.length === 0) return false;
        const fixedThere = p.ordinal !== undefined || p.known !== undefined;
        return !fixedThere || holds === undefined || p.start.epochIds.some((id) => holds.has(id));
      })
      .map((p) => ({ start: p.start, inForce: p.inForce }));
  }

  /** Rows entered the subconscious's window (the presentation index's onPresented): a start waiting to be fixed may be fixable now. */
  presented(): void {
    if (this.pending.length === 0) return;
    try {
      this.tryFix();
    } catch (error) {
      console.error(`[tune-out] the subconscious's window start couldn't be fixed at this presentation; the next one tries again:`, error);
    }
  }

  /**
   * Fix each pending start's ordinal, once no row owed and stored before it
   * is out of the window, then set it (the start in force) and keep it;
   * until both succeed a start stays pending at that ordinal. A start set by
   * an ordinal known is set and kept the same way, and traced only when
   * clamped.
   */
  private tryFix(): void {
    if (this.pending.length === 0 || !this.host.presents()) return;
    const cm = this.host.cm();
    const strategy = this.host.strategy();
    if (!cm || !strategy) return;
    // Read once, and only for a start still to be fixed.
    let owed: readonly Pick<StoredMessage, 'sequence'>[] | undefined;
    for (const entry of [...this.pending]) {
      if (entry.ordinal === undefined) {
        owed ??= this.host.owed();
        if (owed.some((row) => row.sequence < entry.start.sequence)) continue;
        // Just past the last row in the window stored before the start.
        let ordinal = 0;
        for (const row of cm.getPresentedMessages()) {
          if (row.sequence >= entry.start.sequence) continue;
          const at = cm.ordinalOf(row.id);
          if (at !== undefined && at + 1 > ordinal) ordinal = at + 1;
        }
        entry.ordinal = ordinal;
      }
      const ordinal = entry.ordinal;
      if (entry.inForce) strategy.setAnchorOrdinal(ordinal);
      if (!this.host.fixed(entry.known ? entry.known.keep : entry.start.epochIds, ordinal, entry.inForce)) continue;
      this.pending = this.pending.filter((p) => p !== entry);
      if (!entry.known) {
        this.host.emitTrace({
          type: 'tune-out:subconscious-window', agentName: this.host.agentName,
          epochIds: [...entry.start.epochIds], how: 'fixed', ordinal,
        });
      } else if (entry.known.clampedFrom !== undefined) {
        this.host.emitTrace({
          type: 'tune-out:subconscious-window', agentName: this.host.agentName,
          epochIds: [...entry.start.epochIds], how: 'clamped', ordinal, kept: entry.known.clampedFrom,
        });
      }
    }
  }
}

/** The anchor the strategy persisted, as an ordinal: undefined where it persisted none, null where it can't be read. */
function persistedOrdinal(strategy: AnchoredStrategy): number | undefined | null {
  try {
    return strategy.getAnchorOrdinal();
  } catch (error) {
    console.error(`[tune-out] the subconscious's persisted window start couldn't be read, so the window start stays where it was; the next enter or restart sets it:`, error);
    return null;
  }
}

function sameStart(a: SubconsciousWindowStart, b: SubconsciousWindowStart): boolean {
  return a.sequence === b.sequence && a.epochIds.length === b.epochIds.length && a.epochIds.every((id) => b.epochIds.includes(id));
}
