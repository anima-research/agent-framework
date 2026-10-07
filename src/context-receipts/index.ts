/**
 * Confirms what reached a resident, one provider round at a time (shelf-354),
 * and accepts the compile behind a successful round for fold receipts
 * (shelf-381).
 *
 * A request's evidence is captured when it is prepared (evidence.ts). Membrane
 * reports each provider round whose response stands, with that round's own
 * usage, which consumer messages it did not carry verbatim, and how much of
 * the newest injected batch it carried (`UsageEvent.round`). For each such
 * round that isn't a provider refusal:
 *  - every channel body in the request, and every injected body the stream
 *    has applied so far, is evaluated: carried complete and verbatim with
 *    established fidelity → a delivery (the ledger keeps only the first per
 *    version); known partial or altered → a partial exposure; fidelity
 *    unknown → neither, and the body stays eligible for a later round;
 *  - the first such round accepts the compile's rendered layout with the
 *    context manager, which writes any fold receipt.
 * A round that never stands (a failure, a cancel) reports nothing, so it
 * confirms nothing.
 */

import type { CompileProvenance } from '@animalabs/context-manager';
import type { RoundReport } from '@animalabs/membrane';
import type { BodyEvidence, RequestEvidence } from './evidence.js';
import type { BranchStamp, ChannelClockLedger } from './clock-ledger.js';

export { ChannelClockLedger, channelKey, CLOCK_RECORD } from './clock-ledger.js';
export type { ChannelClocks, ChannelRef, ClockScope, SourceRef, VersionRef } from './clock-ledger.js';
export { requestEvidence, injectedEvidence, channelOf, sourceRefOf, versionOf, recordedBodyDigest, sourceBodyDigest, withPreparation } from './evidence.js';
export type { BodyEvidence, RequestEvidence } from './evidence.js';

/** One provider round's report: membrane's `UsageEvent.round`. */
export type { RoundReport };

interface InjectedBatch {
  /** Every message of the batch, bodies or not: the producer's coordinates. */
  size: number;
  /** Evidence for the channel bodies among them, at their batch indices. */
  bodies: BodyEvidence[];
  /** How much of the batch, as an ordered prefix, a round has carried. */
  applied: number;
}

interface StreamState {
  evidence: RequestEvidence | undefined;
  batches: InjectedBatch[];
  accepted: boolean;
}

/** How a round carried the compile, for fold receipts. */
export type Presentation = 'verbatim' | 'altered' | 'unknown';

export interface ContextReceiptHooks {
  /** Accept a compile for fold receipts (ContextManager.acceptRound). Throws when the write fails. */
  acceptRound(agent: string, provenance: CompileProvenance, usage: RoundReport['usage'], at: number, presentation: Presentation): void;
}

/** One copy of a version in a round's request, over all its fragments. */
interface CopyCarriage {
  body: BodyEvidence;
  complete: boolean;
  missing: Set<string>;
}

export class ContextReceipts {
  private readonly streams = new Map<string, StreamState>();
  /** Set when membrane emitted usage without a round report. */
  private missingRoundReports = false;

  constructor(
    readonly ledger: ChannelClockLedger,
    private readonly hooks: ContextReceiptHooks,
    private readonly now: () => number = Date.now,
  ) {}

  /** True once a usage event arrived without a round report (older membrane). */
  get roundReportsMissing(): boolean {
    return this.missingRoundReports;
  }

  beginStream(agent: string, streamId: number, evidence: RequestEvidence | undefined): void {
    this.streams.set(key(agent, streamId), { evidence, batches: [], accepted: false });
  }

  /**
   * A batch of mid-turn injected messages handed to the stream: `size` is
   * the whole batch's length (the producer's coordinate space), `bodies` the
   * evidence for its channel bodies. Returns the batch number.
   */
  injectedBatch(agent: string, streamId: number, size: number, bodies: BodyEvidence[]): number {
    const state = this.streams.get(key(agent, streamId));
    if (!state) return -1;
    state.batches.push({ size, bodies, applied: 0 });
    return state.batches.length - 1;
  }

  /** A usage event from the stream; `round` is membrane's round report. */
  usage(agent: string, streamId: number, round: RoundReport | undefined): void {
    const state = this.streams.get(key(agent, streamId));
    if (!state) return;
    if (!round) {
      this.missingRoundReports = true;
      return;
    }
    if (round.stopReason === 'refusal') return;
    const at = this.now();

    if (round.injectedBatch) {
      const { batch, applied } = round.injectedBatch;
      const target = state.batches[batch];
      if (target) target.applied = Math.max(target.applied, Math.min(applied, target.size));
    }

    const evidence = state.evidence;
    const established = round.fidelity === 'established';
    const alteredMessages = new Set(round.altered?.messages ?? []);
    if (established && evidence) {
      const branch = branchOf(evidence);
      const alteredInjected = new Set((round.altered?.injected ?? []).map(([b, i]) => `${b}:${i}`));
      // A version can reach the request as several COPIES (a compiled
      // stored copy, an injected copy, a replayed stored copy), and one copy
      // can span several FRAGMENTS (a split message, a sharded body). A copy
      // is complete only when every one of its fragments arrived complete
      // and unaltered; a version is delivered when ANY of its copies was
      // complete, and is a partial exposure otherwise.
      const versions = new Map<string, Map<string, CopyCarriage>>();
      const carry = (copy: string, body: BodyEvidence, altered: boolean) => {
        const id = JSON.stringify([body.ver.basis, body.ver.key]);
        let copies = versions.get(id);
        if (!copies) versions.set(id, (copies = new Map()));
        const entry = copies.get(copy) ?? { body, complete: true, missing: new Set<string>() };
        if (!body.complete) {
          entry.complete = false;
          for (const why of body.missing ?? []) entry.missing.add(why);
        }
        if (altered) {
          entry.complete = false;
          entry.missing.add('wire-alteration');
        }
        copies.set(copy, entry);
      };
      for (const body of evidence.bodies) carry(`stored:${body.storeMessageId}`, body, alteredMessages.has(body.index));
      state.batches.forEach((batch, n) => {
        for (const body of batch.bodies) {
          if (body.index < batch.applied) carry(`injected:${n}:${body.index}`, body, alteredInjected.has(`${n}:${body.index}`));
        }
      });
      this.ledger.withCommittedState(() => {
        for (const copies of versions.values()) {
          const whole = [...copies.values()].find((c) => c.complete);
          if (whole) {
            this.ledger.delivered(agent, whole.body.ch, whole.body.src, whole.body.ver, branch, at);
            continue;
          }
          const first = copies.values().next().value!;
          const missing = new Set<string>();
          for (const c of copies.values()) for (const why of c.missing) missing.add(why);
          this.ledger.partial(agent, first.body.ch, first.body.src, first.body.ver, branch, [...missing], at);
        }
      });
    }

    if (!state.accepted && evidence?.provenance) {
      // A known alteration (by request preparation, or reported by the
      // producer) means the compile was not presented verbatim; otherwise
      // only established fidelity makes it verbatim.
      const presentation: Presentation = evidence.preparationAltered || alteredMessages.size > 0
        ? 'altered'
        : established ? 'verbatim' : 'unknown';
      try {
        this.hooks.acceptRound(agent, evidence.provenance, round.usage, at, presentation);
        // Only a completed acceptance closes this compile's acceptance: a
        // failed or uncertain write is retried at the stream's next round
        // (the context manager finds it already accepted if it landed).
        state.accepted = true;
      } catch (err) {
        console.error(`[receipts] ${agent}: fold acceptance failed (retried at the next round):`, err);
      }
    }
  }

  endStream(agent: string, streamId: number): void {
    this.streams.delete(key(agent, streamId));
  }

}

function key(agent: string, streamId: number): string {
  return `${agent}\u0000${streamId}`;
}

function branchOf(evidence: RequestEvidence): BranchStamp {
  const branch = evidence.provenance?.branch;
  return branch ? { id: branch.id, name: branch.name } : { id: 'unknown', name: 'unknown' };
}
