/** Host-owned, opt-in admission. No wire metadata can create this authority. */
import type { ChannelIncomingMessage, PushEventParams, McplInferenceRequestParams } from './types.js';

export const MAX_ADMISSION_TIMEOUT_MS = 60_000;
export const MAX_PENDING_ADMISSIONS = 64;
export type AdmissionLane = 'channels/incoming' | 'push/event' | 'inference/request';
export type ConnectionKey = Readonly<{ connectionId: string; instance: symbol; transportEpoch: number }>;
export type RefusalCode = 'admission_denied' | 'admission_threw' | 'admission_timeout' |
  'admission_invalid' | 'admission_missing' | 'admission_stale' | 'admission_not_ready' |
  'admission_unsupported' | 'admission_mode_ungranted';
export type AdmissionVerdict = Readonly<{ store: false; mayWake: false; reason: RefusalCode }> |
  Readonly<{ store: true; mayWake: boolean; replyIntent?: unknown }>;
type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type Items = { 'channels/incoming': ChannelIncomingMessage; 'push/event': PushEventParams; 'inference/request': McplInferenceRequestParams };
export type AdmissionInput = { [L in AdmissionLane]: Readonly<{
  connection: ConnectionKey; lane: L; item: DeepReadonly<Items[L]>; signal: AbortSignal;
}> }[AdmissionLane];
export type AdmitInbound = (input: AdmissionInput) => AdmissionVerdict | Promise<AdmissionVerdict>;
export interface InboundAdmissionConfig {
  readonly timeoutMs: number;
  readonly bind: (key: ConnectionKey) => Readonly<{ connection: ConnectionKey; admit: AdmitInbound }> | undefined;
  readonly isReplyIntent: (value: unknown) => boolean;
  readonly initializeAttestation?: Readonly<{
    read: (result: DeepReadonly<unknown>) => unknown;
    matches: (attestation: DeepReadonly<unknown>) => boolean;
  }>;
}
const reasons = new Set<RefusalCode>(['admission_denied', 'admission_threw', 'admission_timeout', 'admission_invalid', 'admission_missing', 'admission_stale', 'admission_not_ready', 'admission_unsupported', 'admission_mode_ungranted']);
export const refusal = (reason: RefusalCode): AdmissionVerdict & { store: false } => ({ store: false, mayWake: false, reason });
export class AdmissionConnectError extends Error {
  constructor(code: 'initialize_attestation_refused' | 'admission_missing') { super(code); this.name = 'AdmissionConnectError'; }
}
export function admissionConfigProblem(value: InboundAdmissionConfig): string | undefined {
  if (!value || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > MAX_ADMISSION_TIMEOUT_MS ||
      typeof value.bind !== 'function' || typeof value.isReplyIntent !== 'function' ||
      (value.initializeAttestation !== undefined && (!value.initializeAttestation || typeof value.initializeAttestation.read !== 'function' || typeof value.initializeAttestation.matches !== 'function'))) {
    return 'inboundAdmission requires timeoutMs in 1..60000, bind, isReplyIntent and valid optional initializeAttestation';
  }
}

/** Data-only detachment, without invoking accessors, custom prototypes or toJSON. */
function snapshot(value: unknown, seen = new Set<object>()): any {
  if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || seen.has(value)) throw new InvalidData();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !(Array.isArray(value) && proto === Array.prototype)) throw new InvalidData();
  seen.add(value);
  const out: any = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !('value' in descriptor) || !descriptor.enumerable) throw new InvalidData();
    Object.defineProperty(out, key, { value: snapshot(descriptor.value, seen), enumerable: true });
  }
  seen.delete(value);
  return Object.freeze(out);
}
class InvalidData extends Error {}

/** A receipt is private runtime state, never metadata, persistence or a peer result. */
export const admittedEnvelope = Symbol('admitted inbound');
export type AdmittedEnvelope = Readonly<{ connection: ConnectionKey; mayWake: boolean; replyIntent?: unknown }>;
export function attachAdmission(event: object, envelope: AdmittedEnvelope): void {
  Object.defineProperty(event, admittedEnvelope, { value: envelope, enumerable: true });
}
export function wakeForbidden(event: object): boolean {
  const envelope = (event as { [admittedEnvelope]?: AdmittedEnvelope })[admittedEnvelope];
  return !!envelope && (envelope.mayWake === false || (event as { triggerInference?: boolean }).triggerInference === false);
}
export interface RequiredIngress {
  readonly key: ConnectionKey;
  check(): RefusalCode | undefined;
  admit(lane: AdmissionLane, item: unknown, signal?: AbortSignal): Promise<AdmissionVerdict>;
}

export class RequiredAdmission {
  readonly instance = Symbol('connection instance');
  private key?: ConnectionKey;
  private binding?: ReturnType<InboundAdmissionConfig['bind']>;
  private readonly pending = new Set<AbortController>();
  private readonly config: InboundAdmissionConfig;
  constructor(config: InboundAdmissionConfig, readonly connectionId: string) {
    this.config = Object.freeze({ ...config, ...(config.initializeAttestation ? { initializeAttestation: Object.freeze({ ...config.initializeAttestation }) } : {}) });
  }
  isCurrent(key: ConnectionKey): boolean {
    return this.key === key && this.binding?.connection === key;
  }
  invalidate(): void {
    this.binding = undefined;
    this.key = undefined;
    for (const controller of this.pending) controller.abort();
  }
  bind(epoch: number): void {
    this.invalidate();
    const key = Object.freeze({ connectionId: this.connectionId, instance: this.instance, transportEpoch: epoch });
    try {
      const bound = this.config.bind(key);
      if (!bound || bound.connection !== key || typeof bound.admit !== 'function') throw new AdmissionConnectError('admission_missing');
      this.key = key;
      this.binding = Object.freeze({ connection: key, admit: bound.admit });
    } catch { throw new AdmissionConnectError('admission_missing'); }
  }
  capture(check: () => RefusalCode | undefined): RequiredIngress {
    const key = this.key ?? Object.freeze({ connectionId: this.connectionId, instance: this.instance, transportEpoch: -1 });
    const binding = this.binding;
    const current = (): RefusalCode | undefined => {
      const reason = check();
      if (reason) return reason;
      if (!binding || !this.binding) return 'admission_missing';
      if (this.key !== key || this.binding !== binding) return 'admission_stale';
    };
    return Object.freeze({ key, check: current, admit: (lane: AdmissionLane, item: unknown, signal?: AbortSignal) => {
      const reason = current();
      if (reason) return Promise.resolve(refusal(reason));
      return this.run(async (signal) => {
        const input = Object.freeze({ connection: key, lane, item: snapshot(item), signal }) as AdmissionInput;
        const raw = await binding!.admit(input);
        const verdict = snapshot(raw);
        if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict) || typeof verdict.store !== 'boolean' || typeof verdict.mayWake !== 'boolean') throw new InvalidData();
        const fields = Object.keys(verdict);
        if (!verdict.store) {
          if (verdict.mayWake || !reasons.has(verdict.reason) || fields.some(k => !['store', 'mayWake', 'reason'].includes(k))) throw new InvalidData();
        } else {
          if (fields.some(k => !['store', 'mayWake', 'replyIntent'].includes(k))) throw new InvalidData();
          if (Object.hasOwn(verdict, 'replyIntent') && this.config.isReplyIntent(verdict.replyIntent) !== true) throw new InvalidData();
        }
        return verdict;
      }, signal);
    } });
  }
  async attest(result: unknown): Promise<void> {
    if (!this.config.initializeAttestation) return;
    const attestation = this.config.initializeAttestation;
    const verdict = await this.run(async () => {
      const value = attestation.read(snapshot(result));
      if (value === undefined || attestation.matches(snapshot(value)) !== true) throw new InvalidData();
      return { store: true, mayWake: false };
    });
    if (!verdict.store) throw new AdmissionConnectError('initialize_attestation_refused');
  }
  private async run(work: (signal: AbortSignal) => Promise<AdmissionVerdict>, signal?: AbortSignal): Promise<AdmissionVerdict> {
    if (signal?.aborted) return refusal('admission_stale');
    if (this.pending.size >= MAX_PENDING_ADMISSIONS) return refusal('admission_denied');
    const controller = new AbortController();
    this.pending.add(controller);
    const deadline = performance.now() + this.config.timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<AdmissionVerdict>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(refusal('admission_stale')), { once: true });
      timer = setTimeout(() => { resolve(refusal('admission_timeout')); controller.abort(); }, this.config.timeoutMs);
    });
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const operation = Promise.resolve().then(() => controller.signal.aborted ? refusal('admission_stale') : work(controller.signal)).then(
      value => performance.now() >= deadline ? refusal('admission_timeout') : value,
      error => refusal(performance.now() >= deadline ? 'admission_timeout' : error instanceof InvalidData ? 'admission_invalid' : 'admission_threw'),
    );
    try {
      const result = await Promise.race([operation, cancelled]);
      if (!result.store && result.reason === 'admission_timeout') controller.abort();
      return result;
    }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(controller); }
  }
}
