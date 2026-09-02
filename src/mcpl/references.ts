/**
 * RFC-005 bulk content references — host treatment (agent-framework side).
 *
 * Mirrors the pure module in mcpl-core-ts `src/references.ts` (this framework
 * deliberately does not depend on that package; hand-maintained MCPL types
 * are the house convention — see types.ts header). Semantics are the RFC's,
 * revision 3:
 *
 *  - every parsed field is server *testimony*, never a fact (§3);
 *  - the one invalid-field rule (§8): a bad optional field is dropped while
 *    the block and its subtractive `disposition` survive; a bad `uri`
 *    rejects the block whole;
 *  - `disposition:"never"` withholds payload AND uri from model context
 *    unconditionally — enforced in code here, not by caller discipline (§5);
 *  - stub size is independent of every server-supplied field length (§5);
 *  - unparseable `expiresAt` fails closed (§7.4);
 *  - unknown block types never propagate `undefined` (the pre-existing
 *    convertBlock switches had no default — a latent corruption this module
 *    retires).
 *
 * The ReferenceRegistry is the host-private reference record (§6.2): raw
 * URIs and testimony live here and never in model-visible content. Fetching
 * (§6/§7 origin binding, ceilings, redirects) is deliberately not here yet —
 * the registry is what makes a future host-mediated fetcher and the
 * code-execution materialization hook possible.
 */

export const REFERENCE_LIMITS = { uri: 4096, mimeType: 255, name: 255, expiresAt: 64 } as const;
export const DIGEST_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const MAX_SAFE = 9007199254740991; // 2^53 - 1
const STUB_FIELD_CHARS = 120;

export type ReferenceDisposition = 'never' | 'ref';

export interface ReferenceTestimony {
  uri: string;
  mimeType?: string;
  sizeBytes?: number;
  digest?: string;
  expiresAt?: string;
  name?: string;
  disposition?: ReferenceDisposition;
  rejectedFields: string[];
  truncatedFields: string[];
}

export type BlockClassification =
  | { kind: 'text' }
  | { kind: 'inline'; contradiction: boolean }
  | { kind: 'reference'; testimony: ReferenceTestimony }
  | { kind: 'invalid'; reason: string };

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function takeString(
  raw: unknown, field: keyof typeof REFERENCE_LIMITS & string,
  out: { rejected: string[]; truncated: string[] },
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') { out.rejected.push(field); return undefined; }
  const limit = REFERENCE_LIMITS[field];
  if (raw.length > limit) { out.truncated.push(field); return raw.slice(0, limit); }
  return raw;
}

export function classifyBlock(block: unknown): BlockClassification {
  if (!isRecord(block) || typeof block.type !== 'string') {
    return { kind: 'invalid', reason: 'not a content block' };
  }
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string'
        ? { kind: 'text' }
        : { kind: 'invalid', reason: 'text block without string text' };
    case 'image':
    case 'audio': {
      const hasData = typeof block.data === 'string';
      const hasUri = typeof block.uri === 'string';
      if (hasData) {
        // Inline form claiming bulk disposition (or smuggling a uri beside
        // the data) is the vector-2 contradiction: fail closed, withhold.
        return { kind: 'inline', contradiction: block.disposition !== undefined || hasUri };
      }
      if (hasUri) return parseReferenceFields(block);
      return { kind: 'invalid', reason: `${block.type} block with neither data nor uri` };
    }
    case 'resource':
      return parseReferenceFields(block);
    default:
      return { kind: 'invalid', reason: `unknown block type: ${block.type}` };
  }
}

function parseReferenceFields(block: Record<string, unknown>): BlockClassification {
  if (typeof block.uri !== 'string' || block.uri.length === 0) {
    return { kind: 'invalid', reason: 'reference without string uri' };
  }
  if (block.uri.length > REFERENCE_LIMITS.uri) {
    return { kind: 'invalid', reason: 'uri exceeds schema maximum' };
  }
  const out = { rejected: [] as string[], truncated: [] as string[] };
  const t: ReferenceTestimony = { uri: block.uri, rejectedFields: out.rejected, truncatedFields: out.truncated };
  t.mimeType = takeString(block.mimeType, 'mimeType', out);
  t.name = takeString(block.name, 'name', out);
  t.expiresAt = takeString(block.expiresAt, 'expiresAt', out);
  if (block.sizeBytes !== undefined) {
    const n = block.sizeBytes;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SAFE) t.sizeBytes = n;
    else out.rejected.push('sizeBytes');
  }
  if (block.digest !== undefined) {
    if (typeof block.digest === 'string' && DIGEST_PATTERN.test(block.digest)) t.digest = block.digest;
    else out.rejected.push('digest');
  }
  if (block.disposition !== undefined) {
    if (block.disposition === 'never' || block.disposition === 'ref') t.disposition = block.disposition;
    else out.rejected.push('disposition');
  }
  return { kind: 'reference', testimony: t };
}

/** RFC-005 vector 2: an inline-data block claiming bulk disposition (or
 *  smuggling a uri beside its data) is an emitter contradiction — the host
 *  fails closed by withholding the inline data from context. Every lane that
 *  handles inline media MUST consult this before its data branch. */
export function isInlineContradiction(block: unknown): boolean {
  const c = classifyBlock(block);
  return c.kind === 'inline' && c.contradiction;
}

export const INLINE_WITHHELD_TEXT =
  '[inline content withheld: nonconformant bulk disposition on inline data]';

export function isReferenceExpired(t: Pick<ReferenceTestimony, 'expiresAt'>, nowMs = Date.now()): boolean {
  if (t.expiresAt === undefined) return false;
  const exp = Date.parse(t.expiresAt);
  return Number.isNaN(exp) ? true : exp <= nowMs;
}

/** Strip C0/C1 controls plus bidi marks/overrides/isolates; bound length.
 *  Labels are labels — storage naming is host-generated elsewhere (§7.3). */
export function sanitizeLabel(s: string, maxChars: number): string {
  const cleaned = s.replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  if (cleaned.length <= maxChars) return cleaned;
  let cut = cleaned.slice(0, Math.max(0, maxChars - 1));
  // never split a surrogate pair at the truncation boundary
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + '…';
}

export function formatSizeBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `~${Math.round(n / 1024)}KB`;
  if (n < 1024 * 1024 * 1024) return `~${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `~${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

// ============================================================================
// Host-private reference record (§6.2) + reference ids (§5)
// ============================================================================

export interface ReferenceRecord {
  refId: string;
  serverId?: string;
  testimony: ReferenceTestimony;
  receivedAt: number;
  /** Set by the host-mediated fetcher after a successful, verified fetch. */
  fetchedPath?: string;
  verifiedBytes?: number;
  verifiedMimeType?: string;
  digestVerified?: boolean;
}

const MAX_RECORDS = 2000;

/**
 * Host-private store of received references. Raw URIs live here and in stubs
 * never (under `never`) or by policy only (`ref`/absent). Ids are stable and
 * never reused within the process (vector 20); eviction is FIFO past
 * MAX_RECORDS and a stale lookup returns undefined — a defined miss, never a
 * different record.
 *
 * Process-wide singleton by design: ids are host-local *names*, not
 * capabilities, and the record itself carries serverId for any future
 * origin-bound fetcher.
 */
export class ReferenceRegistry {
  private records = new Map<string, ReferenceRecord>();
  /** uri → refId. The uri ALONE is the identity key: stub sites (the two
   *  tool-result serializers and the three converters) are free functions
   *  with no server context, while dispatch-time pre-registration carries a
   *  serverId — keying on both split every reference into two records, the
   *  model-visible one unbound (fetch_reference failed on it) and the bound
   *  one invisible. One key, and a later registration that knows the server
   *  UPGRADES the record's binding instead of forking it. If two servers ever
   *  reference the same uri, the first binding wins (the record's serverId
   *  feeds the origin check, which fails closed on a mismatch). */
  private byKey = new Map<string, string>();
  private counter = 0;

  register(testimony: ReferenceTestimony, serverId?: string): ReferenceRecord {
    const existingId = this.byKey.get(testimony.uri);
    if (existingId !== undefined) {
      const existing = this.records.get(existingId);
      if (existing) {
        if (serverId !== undefined && existing.serverId === undefined) {
          existing.serverId = serverId;
        }
        // Refresh testimony while unfetched: a re-issued reference with a new
        // digest/expiry supersedes the stale claims. Once fetched, the record
        // describes verified bytes on disk and keeps the testimony they were
        // verified against.
        if (!existing.fetchedPath) existing.testimony = testimony;
        return existing;
      }
    }
    const refId = `ref_${(++this.counter).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const record: ReferenceRecord = { refId, serverId, testimony, receivedAt: Date.now() };
    this.records.set(refId, record);
    this.byKey.set(testimony.uri, refId);
    if (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest !== undefined) {
        const old = this.records.get(oldest);
        this.records.delete(oldest);
        if (old) this.byKey.delete(old.testimony.uri);
      }
    }
    return record;
  }

  get(refId: string): ReferenceRecord | undefined {
    return this.records.get(refId);
  }

  /** Find the record for a uri. */
  findByUri(uri: string): ReferenceRecord | undefined {
    const id = this.byKey.get(uri);
    return id !== undefined ? this.records.get(id) : undefined;
  }
}

export const referenceRegistry = new ReferenceRegistry();

// ============================================================================
// Stub building (§5)
// ============================================================================

/**
 * Build the model-visible stub for a reference. Output length is bounded by
 * host constants and independent of every server-supplied field length.
 * Under `disposition:"never"` the uri is omitted unconditionally; under
 * `ref`/absent it is omitted too — this host's default policy is the opaque
 * id everywhere (the safe default of §5), with retrieval via the record.
 */
export function buildReferenceStub(t: ReferenceTestimony, provenance?: string, serverId?: string): string {
  const record = referenceRegistry.register(t, serverId);
  const parts: string[] = [];
  if (t.name) parts.push(sanitizeLabel(t.name, STUB_FIELD_CHARS));
  const meta: string[] = [];
  if (t.mimeType) meta.push(sanitizeLabel(t.mimeType, STUB_FIELD_CHARS));
  if (t.sizeBytes !== undefined) meta.push(`${formatSizeBytes(t.sizeBytes)} claimed`);
  if (meta.length) parts.push(meta.join(', '));
  if (provenance) parts.push(sanitizeLabel(provenance, STUB_FIELD_CHARS));
  if (record.fetchedPath) {
    // Already materialized by the host-mediated fetcher: hand the model the
    // workspace path (host-generated, §7.3) so existing tools just work.
    parts.push(`saved: ${sanitizeLabel(record.fetchedPath, 256)}`);
  } else {
    parts.push('fetch with fetch_reference');
  }
  return `[${record.refId}] ${parts.join(' — ') || 'referenced content'}`;
}

/**
 * RFC-005 treatment for one MCPL wire block, for the model-visible text
 * lanes. Returns a replacement string, or null when the block should keep
 * its existing (inline/text) handling.
 */
export function referenceStubOrNull(block: unknown, provenance?: string, serverId?: string): string | null {
  const c = classifyBlock(block);
  switch (c.kind) {
    case 'text': return null;
    case 'inline':
      return c.contradiction ? INLINE_WITHHELD_TEXT : null;
    case 'reference': return buildReferenceStub(c.testimony, provenance, serverId);
    case 'invalid': return `[unrecognized content block: ${sanitizeLabel(c.reason, STUB_FIELD_CHARS)}]`;
  }
}
