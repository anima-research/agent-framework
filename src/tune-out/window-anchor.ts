/**
 * Where the persistent subconscious's window starts (#291, AF-5).
 *
 * The subconscious reads a tune-out's held traffic through a windowed
 * passthrough strategy: everything from the anchor on, the anchor at the
 * oldest active tune-out's start (the coordinator's anchorSubconscious).
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
 * rollback), never converted again.
 */
import type { ContextManager, StoredMessage } from '@animalabs/context-manager';
import type { SubconsciousWindowStart } from './coordinator.js';
import type { TraceEvent } from '../types/trace.js';

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
  emitTrace(event: Omit<Extract<TraceEvent, { type: 'tune-out:subconscious-window' }>, 'timestamp' | 'traceId'>): void;
}

/** The subconscious's window start, set by sequence in legacy mode and by a fixed ordinal once its window is presented. */
export class SubconsciousWindowAnchor {
  /**
   * The starts whose ordinal isn't set and kept yet, the one in force
   * (`inForce`) first if it is among them: the window doesn't present yet,
   * some row older than a start is still out of the window, or setting or
   * keeping the ordinal it was fixed at (`ordinal`) failed, which the next
   * presentation tries again. A start given its ordinal (`given`: kept, or
   * the one in force at a resume) while the window was the record waits to
   * be set at it, as a set() while the window presents sets it, and nothing
   * is kept for it.
   */
  private pending: Array<{ start: SubconsciousWindowStart; ordinal?: number; given?: true; inForce: boolean }> = [];

  constructor(private readonly host: SubconsciousWindowAnchorHost) {}

  /**
   * Set the window start (the coordinator's setSubconsciousAnchor). In
   * legacy mode by its sequence, as before the index, and every start it is
   * given waits for the window's next presentation (presented): one given
   * its ordinal is set at it then, and one not kept yet is fixed then, as
   * below. In presented mode by
   * its ordinal when one was fixed, clamped to the window's index length
   * and traced when past it; else by its sequence for now, converted as the
   * strategy converts one, and the ordinal is fixed (see the module doc) as
   * soon as no row the subconscious is owed stored before the start is out
   * of its window, now or at a later presentation (presented). The starts
   * of `others`, the other active tune-outs' whose ordinal isn't kept yet,
   * are fixed the same way, without moving the window to them. Never
   * throws: a set that fails is logged, and the anchor stays where it was.
   */
  set(start: SubconsciousWindowStart, others: readonly SubconsciousWindowStart[] = []): void {
    try {
      const strategy = this.host.strategy();
      if (!strategy) return;
      // A start's kept ordinal, or the one an earlier set fixed it at and
      // couldn't set or keep, which the next presentation tries again.
      const was = this.pending;
      const carried = (wanted: SubconsciousWindowStart, inForce: boolean) => {
        if (wanted.ordinal !== undefined) return { start: wanted, ordinal: wanted.ordinal, given: true as const, inForce };
        const ordinal = was.find((p) => sameStart(p.start, wanted))?.ordinal;
        return { start: wanted, ...(ordinal !== undefined ? { ordinal } : {}), inForce };
      };
      if (!this.host.presents()) {
        this.pending = [carried(start, true), ...others.map((other) => carried(other, false))];
        strategy.setAnchor(start.sequence);
        return;
      }
      this.pending = others.map((other) => carried(other, false));
      if (start.ordinal !== undefined) {
        this.setInForce(strategy, start.ordinal, start.epochIds);
      } else {
        this.pending.unshift(carried(start, true));
        strategy.setAnchor(start.sequence);
      }
      this.tryFix();
    } catch (error) {
      console.error(`[tune-out] the subconscious's window start couldn't be set, so it stays where it was:`, error);
    }
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
   * until both succeed a start stays pending at that ordinal.
   */
  private tryFix(): void {
    if (this.pending.length === 0 || !this.host.presents()) return;
    const cm = this.host.cm();
    const strategy = this.host.strategy();
    if (!cm || !strategy) return;
    const owed = this.host.owed();
    for (const entry of [...this.pending]) {
      if (entry.ordinal === undefined) {
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
      if (entry.inForce) this.setInForce(strategy, ordinal, entry.start.epochIds);
      if (entry.given) {
        this.pending = this.pending.filter((p) => p !== entry);
        continue;
      }
      if (!this.host.fixed(entry.start.epochIds, ordinal, entry.inForce)) continue;
      this.pending = this.pending.filter((p) => p !== entry);
      this.host.emitTrace({
        type: 'tune-out:subconscious-window', agentName: this.host.agentName,
        epochIds: [...entry.start.epochIds], how: 'fixed', ordinal,
      });
    }
  }

  /**
   * Start the window at `ordinal`, clamped to the window's index length on a
   * branch whose window is shorter (a rollback), traced when it is.
   */
  private setInForce(strategy: AnchoredStrategy, ordinal: number, epochIds: readonly string[]): void {
    const length = this.host.cm()?.indexLength() ?? 0;
    const at = Math.min(ordinal, length);
    strategy.setAnchorOrdinal(at);
    if (at !== ordinal) {
      this.host.emitTrace({
        type: 'tune-out:subconscious-window', agentName: this.host.agentName,
        epochIds: [...epochIds], how: 'clamped', ordinal: at, kept: ordinal,
      });
    }
  }
}

function sameStart(a: SubconsciousWindowStart, b: SubconsciousWindowStart): boolean {
  return a.sequence === b.sequence && a.epochIds.length === b.epochIds.length && a.epochIds.every((id) => b.epochIds.includes(id));
}
