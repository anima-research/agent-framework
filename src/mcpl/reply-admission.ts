/** Additive ingress wrapper: slice-A admission completes before route resolution. */
import type { AdmissionInput, AdmissionLane, AdmissionVerdict, RequiredIngress } from './inbound-admission.js';
export type PostAdmissionConsumer = (input: AdmissionInput, verdict: Extract<AdmissionVerdict, { store: true }>) =>
  Promise<{ routing?: unknown }>;
const receipts = new WeakMap<object, unknown>();
export function admissionRoutingFields(verdict: AdmissionVerdict): { routing?: unknown } {
  return receipts.has(verdict) ? { routing: receipts.get(verdict) } : {};
}
/** The original transport payload is JSON data; detach before either callback. */
function detach(value: unknown, seen = new Set<object>()): any {
  if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value) ||
    typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw Error('invalid_reply_input');
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null && !(Array.isArray(value) && proto === Array.prototype)) throw Error('invalid_reply_input');
  seen.add(value);
  const out: any = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !('value' in descriptor)) throw Error('invalid_reply_input');
    Object.defineProperty(out, key, { value: detach(descriptor.value, seen), enumerable: true });
  }
  seen.delete(value);
  return Object.freeze(out);
}
export function withReplyConsumer(admission: RequiredIngress, consume: PostAdmissionConsumer | undefined, transportSignal: AbortSignal): RequiredIngress {
  if (!consume) return admission;
  return Object.freeze({ key: admission.key, check: admission.check,
    async admit(lane: AdmissionLane, item: unknown, signal?: AbortSignal) {
      // Detachment cannot override A's own validation/refusal semantics.
      let snapshot: unknown;
      try { snapshot = detach(item); } catch { /* A validates the same input below. */ }
      const verdict = await admission.admit(lane, item, signal);
      if (verdict.store && verdict.mayWake && !admission.check()) {
        const input = Object.freeze({ connection: admission.key, lane, item: snapshot,
          signal: signal ? AbortSignal.any([signal, transportSignal]) : transportSignal }) as AdmissionInput;
        const result = await consume(input, verdict);
        if (Object.hasOwn(result, 'routing')) receipts.set(verdict, result.routing);
      }
      return verdict;
    },
  });
}
