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
import type { BodyEvidence, RequestEvidence } from './evidence.js';
import type { BranchStamp, ChannelClockLedger } from './clock-ledger.js';

export { ChannelClockLedger, channelKey, CLOCK_RECORD } from './clock-ledger.js';
export type { ChannelClocks, ChannelRef, ClockScope, SourceRef, VersionRef } from './clock-ledger.js';
export { requestEvidence, injectedEvidence, channelOf, sourceRefOf, versionOf } from './evidence.js';
export type { BodyEvidence, RequestEvidence } from './evidence.js';

/** One provider round's report, as membrane emits it on the usage event. */
export interface RoundReport {
  /** Zero-based returned-round index within the stream. */
  index: number;
  /** The mapped stop reason of the attempt that stands. */
  stopReason: string;
  /** This round's own usage; a field the provider did not report is absent. */
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheCreationTokens?: number };
  /** The newest injected batch and how much of it this round carried. */
  injectedBatch?: { batch: number; applied: number };
  /** Consumer messages this round did not carry verbatim. */
  altered?: { messages: number[]; injected: Array<[number, number]> };
  /** 'unknown' when an unattributable change (or an uninstrumented path) may have altered content. */
  fidelity?: 'established' | 'unknown';
}

interface StreamState {
  evidence: RequestEvidence | undefined;
  batches: BodyEvidence[][];
  applied: number[];
  accepted: boolean;
}

export interface ContextReceiptHooks {
  /** Accept a compile for fold receipts (ContextManager.acceptRound). */
  acceptRound(agent: string, provenance: CompileProvenance, usage: RoundReport['usage'], at: number): void;
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
    this.streams.set(key(agent, streamId), { evidence, batches: [], applied: [], accepted: false });
  }

  /** A batch of mid-turn injected messages handed to the stream; returns its batch number. */
  injectedBatch(agent: string, streamId: number, bodies: BodyEvidence[]): number {
    const state = this.streams.get(key(agent, streamId));
    if (!state) return -1;
    state.batches.push(bodies);
    state.applied.push(0);
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
      if (batch >= 0 && batch < state.applied.length) {
        state.applied[batch] = Math.max(state.applied[batch]!, Math.min(applied, state.batches[batch]!.length));
      }
    }

    const evidence = state.evidence;
    const established = round.fidelity === 'established';
    if (established && evidence) {
      const branch = branchOf(evidence);
      const alteredMessages = new Set(round.altered?.messages ?? []);
      const alteredInjected = new Set((round.altered?.injected ?? []).map(([b, i]) => `${b}:${i}`));
      this.ledger.withCommittedState(() => {
        for (const body of evidence.bodies) {
          this.evaluate(agent, body, alteredMessages.has(body.index), branch, at);
        }
        state.batches.forEach((bodies, batch) => {
          const applied = state.applied[batch] ?? 0;
          for (const body of bodies) {
            if (body.index < applied) this.evaluate(agent, body, alteredInjected.has(`${batch}:${body.index}`), branch, at);
          }
        });
      });
    }

    if (!state.accepted && evidence?.provenance) {
      state.accepted = true;
      try {
        this.hooks.acceptRound(agent, evidence.provenance, round.usage, at);
      } catch (err) {
        console.error(`[receipts] ${agent}: fold acceptance failed:`, err);
      }
    }
  }

  endStream(agent: string, streamId: number): void {
    this.streams.delete(key(agent, streamId));
  }

  private evaluate(agent: string, body: BodyEvidence, altered: boolean, branch: BranchStamp, at: number): void {
    if (body.complete && !altered) {
      this.ledger.delivered(agent, body.ch, body.src, body.ver, branch, at);
      return;
    }
    const why = [...(body.missing ?? []), ...(altered ? ['wire-alteration'] : [])];
    this.ledger.partial(agent, body.ch, body.src, body.ver, branch, why, at);
  }
}

function key(agent: string, streamId: number): string {
  return `${agent}\u0000${streamId}`;
}

function branchOf(evidence: RequestEvidence): BranchStamp {
  const branch = evidence.provenance?.branch;
  return branch ? { id: branch.id, name: branch.name } : { id: 'unknown', name: 'unknown' };
}
