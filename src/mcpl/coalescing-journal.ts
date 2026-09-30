/** Canonical coalescing operations and their deterministic projection.
 * Only this reducer changes logical coalescing state. Replaying it performs no I/O. */
import { createHash } from 'node:crypto';
import type { McplContentBlock, PushEventParams, PushEventResult, ChannelIncomingMessage } from './types.js';

export interface CoalescedPush {
  /** Host-only recovery marker: never read from wire params or origin. */
  recovered?: boolean;
  /** Journal-owned publication identity; never taken from a wire message. */
  publicationId?: string;
  serverId: string;
  /** Host-owned configured binding; changes when the endpoint/command is reassigned. */
  binding?: string;
  epoch: string;
  audience: string;
  params: PushEventParams;
  channelMessage?: ChannelIncomingMessage;
  /** Host-resolved delivery, independent of the untrusted coalescing scope. */
  routing?: {
    channelId?: string; messageId?: string; author?: { id: string; name: string };
    threadId?: string; metadata?: Record<string, unknown>;
    targetAgents: string[]; triggerAllowed?: boolean; generation?: number;
  };
}
export interface PushRenderParams {
  channelId?: string;
  featureSet: string;
  key: string;
  eventId: string;
  notices: Array<{ eventId: string; timestamp: string; data?: unknown }>;
  dropped: number;
}
export interface PushRenderResult { content: McplContentBlock[]; timestamp?: string }
/** A configured server binding survives transport reconnects. Epoch gates authority,
 * not subject or occurrence identity. Channel scope is NEVER inferred from origin. */
export function coalescingChannel(push: CoalescedPush): string | undefined {
  return push.channelMessage?.channelId ?? push.params.coalesce?.channelId;
}
export function coalescingSubject(push: CoalescedPush): string {
  const channel = coalescingChannel(push);
  return JSON.stringify([push.serverId, push.binding ?? '', channel === undefined ? 'featureSet' : 'channel',
    channel ?? push.params.featureSet, push.params.coalesce!.key]);
}

export function coalescingReceiptKey(push: CoalescedPush): string {
  return createHash('sha256').update(JSON.stringify([push.serverId, push.binding ?? '', push.params.eventId])).digest('hex');
}

type History = 'none' | 'some' | 'unknown';
type MessageIdentity = Pick<NonNullable<CoalescedPush['routing']>, 'messageId' | 'author' | 'threadId'>;
export interface CoalescingSlot {
  push: CoalescedPush;
  notices?: PushRenderParams['notices'];
  dropped: number;
}
export interface CoalescingSubjectState {
  history: History;
  identity?: MessageIdentity;
  consumedEventId?: string;
  slot?: CoalescingSlot;
  rendering?: { id: string; slot: CoalescingSlot };
}
export type CoalescingTarget = { slot: string } | { render: string };
export interface CoalescingPublication {
  id: string;
  subject: string;
  push: CoalescedPush;
}
/** One-time import of the unmerged snapshot-based prototype. Once appended, the
 * imported facts belong to this journal; the old stores are never read again. */
export interface LegacyCoalescingImport {
  pending: CoalescedPush[];
  history?: Array<{ key: string; history: History; consumedEventId?: string; identity?: MessageIdentity }>;
  receipts: Array<{ key: string; result: PushEventResult }>;
}
export type CoalescingOperation =
  | { kind: 'accepted'; push: CoalescedPush; result: PushEventResult }
  | { kind: 'forgotten'; subject: string }
  | { kind: 'render-started'; subject: string }
  | { kind: 'prepared'; subject: string; target: CoalescingTarget; push: CoalescedPush;
      source: 'plain' | 'render' | 'fallback'; observation?: unknown }
  | { kind: 'delivered'; publication: string; disposition: 'published' | 'suppressed' }
  | { kind: 'discarded'; subject: string; target: CoalescingTarget; reason: 'empty-render' | 'authority'; observation?: unknown }
  | { kind: 'disconnected'; serverId: string }
  | { kind: 'recovered'; branch?: string }
  | { kind: 'history-unknown' }
  | { kind: 'observed'; detail: Record<string, unknown> }
  | { kind: 'legacy-import'; initial: LegacyCoalescingImport };
export interface CoalescingRecord {
  version: 1;
  id: string;
  at: number;
  operation: CoalescingOperation;
}
/** append must commit durably before returning. Derived indexes are disposable. */
export interface CoalescingJournal {
  length(): number;
  read(index: number): CoalescingRecord;
  append(record: CoalescingRecord): void;
}
export interface ReceiptReference { record: number; imported?: number }

function sameAudience(prior: CoalescedPush | undefined, push: CoalescedPush): boolean {
  return !prior || prior.audience === push.audience &&
    JSON.stringify(prior.routing?.metadata?.tuneOut ?? null) === JSON.stringify(push.routing?.metadata?.tuneOut ?? null);
}
function audienceBranch(push: CoalescedPush): string | undefined {
  try { return JSON.parse(push.audience)[0]; } catch { return undefined; }
}

export class CoalescingProjection {
  readonly subjects = new Map<string, CoalescingSubjectState>();
  readonly publications = new Map<string, CoalescingPublication>();
  readonly receipts = new Map<string, ReceiptReference>();
  uncertain = false;
  cursor = 0;

  resultFor(push: CoalescedPush): PushEventResult {
    const state = this.subjects.get(coalescingSubject(push));
    const c = push.params.coalesce!;
    const history = state?.history ?? (this.uncertain || c.retract ? 'unknown' : 'none');
    const prior = state?.slot ?? state?.rendering?.slot;
    const priorEventId = prior?.push.params.eventId ?? state?.consumedEventId;
    const outcome = c.retract
      ? history === 'none' ? 'retracted' : push.params.payload.content.length ? 'noted' : 'consumed'
      : c.deferred ? state?.slot ? 'replaced' : 'first'
      : prior ? 'replaced' : state?.consumedEventId || history === 'unknown' ? 'appended' : 'first';
    return { accepted: true, coalesce: { outcome, ...(priorEventId ? { priorEventId } : {}) } };
  }

  /** Validate and apply a committed fact, independent of the current grant, clock,
   * routing policy, sockets, or process. No effects belong in this method. */
  apply(record: CoalescingRecord, index: number): void {
    if (record?.version !== 1 || typeof record.id !== 'string' || index !== this.cursor) {
      throw new Error(`Invalid coalescing journal record at ${index}`);
    }
    const op = record.operation;
    switch (op.kind) {
      case 'accepted': {
        const push = structuredClone(op.push);
        const key = coalescingSubject(push);
        const expected = this.resultFor(push);
        if (op.result.accepted !== true || expected.coalesce?.outcome !== op.result.coalesce?.outcome ||
            expected.coalesce?.priorEventId !== op.result.coalesce?.priorEventId || this.receipts.has(coalescingReceiptKey(push))) {
          throw new Error(`Inconsistent coalescing acceptance at ${index}`);
        }
        const c = push.params.coalesce!;
        const state = this.subjects.get(key) ?? { history: this.uncertain || c.retract ? 'unknown' : 'none' };
        const prior = state.slot ?? state.rendering?.slot;
        const deliver = !!push.audience && sameAudience(prior?.push, push);
        if (c.retract || !c.deferred) {
          state.rendering = undefined;
          state.slot = undefined;
          if (c.retract) state.consumedEventId = undefined;
          if (deliver && (!c.retract || op.result.coalesce?.outcome === 'noted')) state.slot = { push, dropped: 0 };
        } else if (deliver) {
          const notices = state.slot?.notices ?? [];
          let dropped = state.slot?.dropped ?? 0;
          notices.push({ eventId: push.params.eventId, timestamp: push.params.timestamp,
            ...(c.data !== undefined ? { data: structuredClone(c.data) } : {}) });
          if (notices.length > 64) { notices.shift(); dropped++; }
          state.slot = { push, notices, dropped };
        } else state.slot = undefined;
        if (push.routing && coalescingChannel(push)) {
          state.identity = { messageId: push.routing.messageId, author: push.routing.author, threadId: push.routing.threadId };
        }
        this.subjects.set(key, state);
        this.receipts.set(coalescingReceiptKey(push), { record: index });
        break;
      }
      case 'forgotten': {
        const state = this.subjects.get(op.subject);
        if (!state || state.slot || state.rendering || [...this.publications.values()].some(p => p.subject === op.subject)) {
          throw new Error('Cannot forget pending coalescing work');
        }
        this.subjects.delete(op.subject);
        this.uncertain = true;
        break;
      }
      case 'render-started': {
        const state = this.requireSubject(op.subject);
        if (!state.slot?.notices || state.rendering) throw new Error('Invalid render start');
        state.rendering = { id: record.id, slot: state.slot };
        state.slot = undefined;
        break;
      }
      case 'prepared': {
        const state = this.requireTarget(op.subject, op.target);
        if (coalescingSubject(op.push) !== op.subject) throw new Error('Publication subject mismatch');
        this.clearTarget(state, op.target);
        // The publication may have escaped before a crash. The append is the
        // irreversible assembly fence; pending outbox work cannot be replaced.
        if (state.history === 'none') state.history = 'unknown';
        state.consumedEventId = op.push.params.eventId;
        this.publications.set(record.id, { id: record.id, subject: op.subject, push: structuredClone(op.push) });
        break;
      }
      case 'delivered': {
        const publication = this.publications.get(op.publication);
        if (!publication) throw new Error('Unknown coalescing publication');
        if (op.disposition === 'published') this.requireSubject(publication.subject).history = 'some';
        this.publications.delete(op.publication);
        break;
      }
      case 'discarded': this.clearTarget(this.requireTarget(op.subject, op.target), op.target); break;
      case 'disconnected': {
        for (const state of this.subjects.values()) {
          const slot = state.slot ?? state.rendering?.slot;
          if (slot?.push.serverId === op.serverId) this.recoverSubject(state);
        }
        for (const publication of this.publications.values()) {
          if (publication.push.serverId === op.serverId) publication.push.recovered = true;
        }
        break;
      }
      case 'recovered': {
        for (const state of this.subjects.values()) {
          const slot = state.slot ?? state.rendering?.slot;
          if (slot && op.branch !== undefined && audienceBranch(slot.push) !== op.branch) {
            state.slot = undefined;
            state.rendering = undefined;
          } else this.recoverSubject(state);
        }
        for (const [id, publication] of this.publications) {
          if (op.branch !== undefined && audienceBranch(publication.push) !== op.branch) this.publications.delete(id);
          else publication.push.recovered = true;
        }
        break;
      }
      case 'history-unknown': {
        this.uncertain = true;
        for (const state of this.subjects.values()) state.history = 'unknown';
        break;
      }
      case 'legacy-import': {
        if (index !== 0) throw new Error('Legacy import must be the first journal entry');
        this.uncertain = true;
        for (const { key, ...state } of op.initial.history ?? []) this.subjects.set(key, structuredClone(state));
        op.initial.pending.forEach((push, pendingIndex) => {
          const key = coalescingSubject(push);
          const state = this.subjects.get(key) ?? { history: 'unknown' as const };
          // The old snapshot and context write were independent. We cannot prove
          // an imported item was unread, so seal it conservatively as an outbox
          // intent. Legacy context markers make its publication idempotent.
          if (state.history !== 'some') state.history = 'unknown';
          state.consumedEventId = push.params.eventId;
          this.subjects.set(key, state);
          const id = `${record.id}/legacy/${pendingIndex}`;
          this.publications.set(id, { id, subject: key, push: { ...structuredClone(push), recovered: true } });
        });
        op.initial.receipts.forEach((receipt, imported) => this.receipts.set(receipt.key, { record: index, imported }));
        break;
      }
      case 'observed': break;
      default: throw new Error(`Unknown coalescing journal operation at ${index}`);
    }
    this.cursor++;
  }

  private requireSubject(key: string): CoalescingSubjectState {
    const state = this.subjects.get(key);
    if (!state) throw new Error(`Unknown coalescing subject ${key}`);
    return state;
  }
  private requireTarget(key: string, target: CoalescingTarget): CoalescingSubjectState {
    const state = this.requireSubject(key);
    if ('slot' in target ? state.slot?.push.params.eventId !== target.slot : state.rendering?.id !== target.render) {
      throw new Error('Coalescing journal target no longer pending');
    }
    return state;
  }
  private clearTarget(state: CoalescingSubjectState, target: CoalescingTarget): void {
    if ('slot' in target) state.slot = undefined;
    else state.rendering = undefined;
  }
  private recoverSubject(state: CoalescingSubjectState): void {
    const slot = state.slot ?? state.rendering?.slot;
    state.rendering = undefined;
    if (slot) state.slot = { push: { ...slot.push, recovered: true }, dropped: 0 };
  }
}

export function replayCoalescingJournal(journal: CoalescingJournal): CoalescingProjection {
  const projection = new CoalescingProjection();
  for (let index = 0; index < journal.length(); index++) projection.apply(journal.read(index), index);
  return projection;
}
