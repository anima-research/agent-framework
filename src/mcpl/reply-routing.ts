/** Private automatic-reply authority. Metadata and persisted rows never mint it. */
import { admittedEnvelope, type AdmittedEnvelope, type AdmissionInput, type ConnectionKey } from './inbound-admission.js';
import type { PostAdmissionConsumer } from './reply-admission.js';
import type { ChannelRef } from './channel-registry.js';

export type ReplyDestination = Readonly<ChannelRef>;
export type ReplyInput = AdmissionInput & { readonly replyIntent?: unknown };
export interface ReplyAuthorityConfig {
  /** Separate routing deadline; never changes the admission verdict. */
  readonly timeoutMs: number;
  /** Return one approved registered channel on the original connection, or null. */
  readonly resolve: (input: ReplyInput) => { readonly channelId: string } | null |
    Promise<{ readonly channelId: string } | null>;
  /** Cheap synchronous policy check, with no I/O. Only literal true authorizes. */
  readonly authorize: (input: ReplyInput, destination: ReplyDestination) => boolean;
}
export interface ReplyBinding {
  readonly connection: ConnectionKey;
  readonly destination?: ReplyDestination;
  readonly workId: symbol;
}
const bindings = new WeakSet<object>();
const liveBindings = new WeakMap<object, () => boolean>();
export function replyBindingCurrent(value: unknown): boolean {
  return isReplyBinding(value) && liveBindings.get(value)?.() === true;
}
export const privateReplyNotice = 'Automatic reply not sent: no unique, currently host-approved destination is available for every cause of this turn. Your prose stays private; explicit send tools remain available and are authorized separately.';
export const replyWork: unique symbol = Symbol('admitted reply work');
export const replyOwner: unique symbol = Symbol('reply turn owner');
export type ReplyWork = { [replyWork]?: readonly ReplyBinding[]; [replyOwner]?: number };
export function isReplyBinding(value: unknown): value is ReplyBinding {
  return typeof value === 'object' && value !== null && bindings.has(value);
}
export function workOf(value: object | undefined): readonly ReplyBinding[] {
  if (!value) return [];
  const carried = (value as ReplyWork)[replyWork];
  if (carried) return carried.filter(isReplyBinding);
  const receipt = (value as { [admittedEnvelope]?: AdmittedEnvelope & { routing?: unknown } })[admittedEnvelope];
  return isReplyBinding(receipt?.routing) ? [receipt.routing] : [];
}
export function carryWork(value: object | undefined): ReplyWork {
  const work = workOf(value);
  return work.length ? { [replyWork]: work } : {};
}
export function sameDestination(a: ReplyBinding | undefined, b: ReplyBinding | undefined): boolean {
  if (!a || !b) return a === b;
  return !!a.destination && !!b.destination &&
    a.connection.instance === b.connection.instance && a.connection.transportEpoch === b.connection.transportEpoch &&
    a.connection.connectionId === b.connection.connectionId && a.destination.serverId === b.destination.serverId &&
    a.destination.channelId === b.destination.channelId;
}
export function sameWork(a: object, b: object): boolean {
  const aa = workOf(a), bb = workOf(b);
  return (a as ReplyWork)[replyOwner] === (b as ReplyWork)[replyOwner] && aa.length === bb.length &&
    aa.every((work, i) => work === bb[i]);
}
/** Distinct identities stay in holds/dedupe even when their turn can be shared. */
export function shareReplyTurn(a: object, b: object): boolean {
  const aa = workOf(a), bb = workOf(b);
  return (a as ReplyWork)[replyOwner] === (b as ReplyWork)[replyOwner] &&
    (sameWork(a, b) || aa.length > 0 && bb.length > 0 && [...aa, ...bb].every(w => sameDestination(aa[0], w)));
}
function mint(connection: ConnectionKey, destination?: ReplyDestination, current: () => boolean = () => false): ReplyBinding {
  const binding = Object.freeze({ connection, ...(destination ? { destination } : {}), workId: Symbol('admitted work') });
  bindings.add(binding); liveBindings.set(binding, current);
  return binding;
}
/** Publication checks all original causes, never just the routing winner. */
export function turnReply(works: readonly ReplyBinding[]): ReplyBinding | undefined {
  if (!works.length) return;
  if (works.length === 1) return works[0];
  const first = works[0];
  return mint(first.connection, works.every(w => sameDestination(first, w)) ? first.destination : undefined,
    () => works.every(w => sameDestination(first, w) && replyBindingCurrent(w)));
}
let nextIdentity = 0;
const identities = new WeakMap<object, number>();
function identity(value: object): number {
  let n = identities.get(value);
  if (n === undefined) { n = ++nextIdentity; identities.set(value, n); }
  return n;
}
/** Opaque ids may contain every separator. */
export function workKey(value: object): unknown[] {
  return workOf(value).map(work => [identity(work.connection), work.connection.connectionId,
    work.connection.transportEpoch, work.destination?.serverId ?? null, work.destination?.channelId ?? null, identity(work)]);
}

export function replyConsumer(config: ReplyAuthorityConfig, valid: (key: ConnectionKey, target: ReplyDestination) => boolean): PostAdmissionConsumer {
  const { resolve, authorize, timeoutMs } = config;
  let pending = 0;
  let loggedThrow = false;
  const failed = (): void => {
    // One bounded diagnostic per configured connection; never expose callback details.
    if (!loggedThrow) { loggedThrow = true; console.error('[automatic-reply] host reply authority threw; automatic prose stays private'); }
  };
  return async (input, verdict) => {
    if (!verdict.mayWake) return {};
    const privateWork = () => ({ routing: mint(input.connection) });
    if (pending >= 64) return privateWork();
    pending++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    input.signal.addEventListener('abort', abort, { once: true });
    if (input.signal.aborted) abort();
    const approvedInput = Object.freeze({ ...input, signal: controller.signal, replyIntent: verdict.replyIntent });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = new Promise<null>(done => {
        controller.signal.addEventListener('abort', () => done(null), { once: true });
        timer = setTimeout(() => { done(null); controller.abort(); }, timeoutMs);
        if (controller.signal.aborted) done(null);
      });
      const operation = Promise.resolve().then(() => controller.signal.aborted ? null : resolve(approvedInput)).catch(() => { failed(); return null; });
      const raw = await Promise.race([operation, cancelled]);
      if (controller.signal.aborted || !raw || typeof raw !== 'object' ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return privateWork();
      const fields = Reflect.ownKeys(raw);
      const channel = Object.getOwnPropertyDescriptor(raw, 'channelId');
      if (fields.length !== 1 || fields[0] !== 'channelId' || !channel?.enumerable || !('value' in channel) ||
        typeof channel.value !== 'string' || !channel.value) return privateWork();
      const destination = Object.freeze({ serverId: input.connection.connectionId, channelId: channel.value });
      const current = (): boolean => {
        try { return valid(input.connection, destination) && authorize(approvedInput, destination) === true; }
        catch { failed(); return false; }
      };
      return current() ? { routing: mint(input.connection, destination, current) } : privateWork();
    } catch {
      failed(); return privateWork();
    } finally {
      clearTimeout(timer); input.signal.removeEventListener('abort', abort); pending--;
    }
  };
}
