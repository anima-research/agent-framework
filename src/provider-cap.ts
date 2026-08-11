/**
 * Provider-cap parked state (2026-08-11, Cairn workspace-cap incident).
 *
 * A fixed-future usage/billing cap — "you will regain access on <date>" — is a
 * 400 invalid_request_error on the wire, so before this module it was
 * indistinguishable from a poisoned history:
 *
 *   - the poison-history breaker shed real messages (three per process, reset
 *     by restart — six of Cairn's messages went that way across two restarts);
 *   - the maintenance loop hot-retried the same non-retryable 400 every ~3.4 s
 *     with full-payload logging (12,774 failures, ~8.5 GB/day of logs, $0 of
 *     progress);
 *   - nothing told the operator OR the resident that the account was capped
 *     rather than the history broken.
 *
 * The park replaces all of that with: classify the cap structurally, make ONE
 * provider call's worth of evidence, then hold — no primary dispatch, no
 * auxiliary/compression dispatch, no history shedding — until an authenticated
 * operator clears it or the provider-stated reset time passes and a single
 * jittered canary succeeds. Incoming events keep recording durably the whole
 * time (chronicle appends never needed the provider).
 *
 * Classification is deliberately narrow: structural invariants on the
 * MembraneError (type/httpStatus/provider body error type) plus an ANCHORED
 * message pattern that must yield a real calendar timestamp. Anything less —
 * a substring match, a cap-shaped sentence with an unparseable date — does NOT
 * park. A cap-shaped-but-unparsed error is still excluded from the
 * poison-history breaker (a known cap sentence must never cost history) but
 * is surfaced loudly instead of acted on.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { MembraneError } from '@animalabs/membrane';

// ============================================================================
// Classification
// ============================================================================

/** Result of a positive structural cap classification. */
export interface ProviderCapClassification {
  provider: 'anthropic';
  /** Account scope the provider names in the error ('workspace' | 'organization'). */
  scope: string;
  errorClass: 'usage_cap';
  /** Provider-stated reset instant (epoch ms, parsed as UTC). May be in the
   *  past relative to the local clock (skew / stale error) — the governor
   *  handles that with a bounded backoff instead of trusting it blindly. */
  resetAt: number;
}

/**
 * The Anthropic workspace/organization usage-cap sentence. Anchored: prefix,
 * date, time, UTC marker, end. Tolerates only whitespace runs and optional
 * seconds/parentheses/trailing period — NOT arbitrary text. The date is
 * validated as a real calendar day below (a regex alone accepts 2026-13-45).
 */
const ANTHROPIC_CAP_PATTERN =
  /^You have reached your specified (workspace|organization) API usage limits\.\s+You will regain access on (\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2})(?::(\d{2}))?\s*\(?UTC\)?\.?$/;

/** Prefix-only shape check (see capShapedButUnparsed). */
const ANTHROPIC_CAP_PREFIX =
  /^You have reached your specified (workspace|organization) API usage limits\./;

/**
 * Structural invariants shared by full classification and the shape check:
 * a MembraneError, type 'invalid_request', HTTP 400, whose serialized provider
 * body carries error type 'invalid_request_error'. An error object that lost
 * its raw body (crossed a serialization boundary, was rehydrated from a log)
 * fails closed — we never classify from message text alone.
 */
function capStructuralInvariants(err: unknown): { messages: string[]; ok: boolean } {
  const isMembrane =
    err instanceof MembraneError ||
    (err instanceof Error && err.name === 'MembraneError');
  if (!isMembrane) return { ok: false, messages: [] };

  const e = err as MembraneError;
  if (e.type !== 'invalid_request' || e.httpStatus !== 400) {
    return { ok: false, messages: [] };
  }

  // serializeError copies the Anthropic SDK APIError's enumerable props, so
  // rawError.error is the HTTP body: { type:'error', error:{ type, message } }
  // (some SDK paths omit the outer envelope — accept both nestings).
  const raw = e.rawError as Record<string, unknown> | undefined;
  const body = raw?.error as Record<string, unknown> | undefined;
  const inner = body?.error as Record<string, unknown> | undefined;
  const bodyType = inner?.type ?? body?.type;
  if (bodyType !== 'invalid_request_error') return { ok: false, messages: [] };

  // The provider body's own message field is the structured source; the
  // Error message is a fallback (SDKs sometimes prefix it with the status).
  const messages: string[] = [];
  const bodyMessage = inner?.message ?? body?.message;
  if (typeof bodyMessage === 'string') messages.push(bodyMessage.trim());
  if (typeof e.message === 'string') {
    messages.push(e.message.trim(), e.message.trim().replace(/^400\s+/, ''));
  }
  return { ok: true, messages };
}

/** Validate calendar components round-trip through Date.UTC (rejects 2026-13-45). */
function parseUtc(y: number, mo: number, d: number, h: number, mi: number, s: number): number | null {
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const dt = new Date(t);
  if (
    dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h || dt.getUTCMinutes() !== mi || dt.getUTCSeconds() !== s
  ) return null;
  return t;
}

/**
 * Positive classification: structural invariants AND an anchored message that
 * parses to a real calendar instant. Returns null otherwise — null means
 * "handle exactly as before this module existed", not "probably fine".
 */
export function classifyProviderCapError(err: unknown): ProviderCapClassification | null {
  const { ok, messages } = capStructuralInvariants(err);
  if (!ok) return null;
  for (const m of messages) {
    const match = ANTHROPIC_CAP_PATTERN.exec(m);
    if (!match) continue;
    const resetAt = parseUtc(
      Number(match[2]), Number(match[3]), Number(match[4]),
      Number(match[5]), Number(match[6]), Number(match[7] ?? 0),
    );
    if (resetAt === null) continue;
    return { provider: 'anthropic', scope: match[1], errorClass: 'usage_cap', resetAt };
  }
  return null;
}

/**
 * A cap-SHAPED error that full classification rejected (in practice: the
 * provider reworded the reset clause or dropped the date). Not enough to
 * park — but enough that the poison-history breaker must not shed history
 * over it, and enough to alert the operator that the classifier needs a
 * pattern update. Only meaningful when classifyProviderCapError returned null.
 */
export function capShapedButUnparsed(err: unknown): boolean {
  const { ok, messages } = capStructuralInvariants(err);
  if (!ok) return false;
  return messages.some((m) => ANTHROPIC_CAP_PREFIX.test(m));
}

// ============================================================================
// Park state
// ============================================================================

/** Durable per-resident park record. METADATA ONLY by construction: no prompt
 *  text, no response text, no provider error body ever enters this shape. */
export interface ProviderCapRecord {
  agent: string;
  provider: string;
  scope: string;
  errorClass: string;
  /** Model the agent was using when the cap was hit (from AgentConfig.model).
   *  A DIFFERENT live model at a later gate check means the operator changed
   *  provider/model while parked — the park's evidence no longer describes
   *  the live configuration, so the canary becomes immediately eligible. */
  model?: string;
  /** First cap-classified failure of this episode (epoch ms). */
  firstAt: number;
  /** Most recent cap-classified failure (epoch ms). */
  lastAt: number;
  /** Provider-stated reset instant (epoch ms, UTC). */
  resetAt: number;
  /** Provider calls that hit the cap this episode (1 = entry, +1 per canary). */
  attemptCount: number;
  /** Wake requests dropped while parked (events themselves are in chronicle). */
  heldWakes: number;
  /** Maintenance passes skipped while parked. */
  heldMaintenance: number;
  /** When the single jittered canary becomes permitted (epoch ms). */
  eligibleAt: number;
}

interface ProviderCapFileState {
  version: 1;
  updatedAt: number;
  parks: Record<string, ProviderCapRecord>;
  /** Last release, kept for the operator's benefit (one, not a history). */
  lastRelease?: {
    agent: string;
    releasedAt: number;
    releasedBy: string;
    attemptCount: number;
    heldWakes: number;
    heldMaintenance: number;
    parkedForMs: number;
  };
}

export interface ProviderCapGovernorConfig {
  /** Durable state file (default 'state/provider-cap.json', relative cwd). */
  statePath?: string;
  /** Max deterministic jitter added to resetAt before the canary (default 5 min). */
  jitterMaxMs?: number;
  /** Backoff ceiling for re-park after a failed canary / past reset (default 6 h). */
  maxBackoffMs?: number;
  /** Test seam for injected fs failures — production always uses the real fs. */
  fsOps?: Partial<FsOps>;
}

interface FsOps {
  readFileSync: typeof readFileSync;
  writeSync: typeof writeSync;
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  fsyncSync: typeof fsyncSync;
  renameSync: typeof renameSync;
  unlinkSync: typeof unlinkSync;
  mkdirSync: typeof mkdirSync;
}

/** FNV-1a over a short string — deterministic canary jitter with no RNG, so
 *  restarts and tests see the same eligibility instant for the same episode. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export class ProviderCapGovernor {
  private readonly statePath: string;
  private readonly jitterMaxMs: number;
  private readonly maxBackoffMs: number;
  private readonly fs: FsOps;

  private parks = new Map<string, ProviderCapRecord>();
  private lastRelease: ProviderCapFileState['lastRelease'];
  /** Single canary permit per agent: at most one dispatch may probe at once. */
  private canaryInFlight = new Set<string>();

  /** Visible load failure (corrupt state file). Never silently cleared. */
  loadError: string | null = null;
  /** Visible persist failure. Cleared only by a subsequent successful persist. */
  persistError: string | null = null;
  /** When the on-disk file last verifiably matched memory (bug-14 discipline:
   *  assigned only AFTER rename + parent fsync succeed). */
  durableThrough: number | null = null;

  private tmpCounter = 0;
  private lastHeldPersistAt = 0;

  constructor(config?: ProviderCapGovernorConfig) {
    this.statePath = config?.statePath ?? join('state', 'provider-cap.json');
    this.jitterMaxMs = Math.max(0, config?.jitterMaxMs ?? 5 * 60_000);
    this.maxBackoffMs = Math.max(60_000, config?.maxBackoffMs ?? 6 * 60 * 60_000);
    this.fs = {
      readFileSync, writeSync, openSync, closeSync, fsyncSync,
      renameSync, unlinkSync, mkdirSync,
      ...config?.fsOps,
    };
  }

  // --------------------------------------------------------------------------
  // Durability
  // --------------------------------------------------------------------------

  /**
   * Load persisted parks. ENOENT = clean (an agent that was never capped never
   * grows this file). A corrupt/unreadable file is a VISIBLE failure: the
   * bytes are preserved by renaming aside (never overwritten in place), the
   * error is surfaced, and the governor starts unparked.
   *
   * Failing toward UNPARKED is deliberate and asymmetric: staying parked on
   * corrupt metadata mutes an agent indefinitely; starting unparked costs at
   * most one $0 cap-rejected call before the next classification re-parks.
   */
  load(now: number): void {
    let text: string;
    try {
      text = this.fs.readFileSync(this.statePath, 'utf8') as string;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      this.loadError = `read failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    try {
      const state = JSON.parse(text) as ProviderCapFileState;
      if (state.version !== 1 || typeof state.parks !== 'object' || state.parks === null) {
        throw new Error(`unsupported state shape (version=${String((state as { version?: unknown }).version)})`);
      }
      for (const [agent, rec] of Object.entries(state.parks)) {
        if (
          typeof rec.resetAt !== 'number' || typeof rec.firstAt !== 'number' ||
          typeof rec.eligibleAt !== 'number' || typeof rec.errorClass !== 'string'
        ) {
          throw new Error(`malformed park record for agent ${agent}`);
        }
        this.parks.set(agent, rec);
      }
      this.lastRelease = state.lastRelease;
      this.durableThrough = state.updatedAt ?? now;
    } catch (err) {
      this.loadError = `corrupt state: ${err instanceof Error ? err.message : String(err)}`;
      const aside = `${this.statePath}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
      try {
        this.fs.renameSync(this.statePath, aside);
        this.loadError += ` (bytes preserved at ${basename(aside)})`;
      } catch {
        this.loadError += ' (could not move bytes aside; file left in place, persistence disabled)';
        // Leave persistError set so we never overwrite evidence we failed to move.
        this.persistError = 'refusing to overwrite unreadable prior state';
      }
      this.parks.clear();
    }
  }

  /**
   * Atomic durable write: unique temp file → write → fsync(fd) → rename →
   * fsync(parent dir). On ANY failure: best-effort unlink of the orphan temp,
   * visible persistError, in-memory state kept, and durableThrough NOT
   * advanced (it moves only after the rename + directory fsync both succeed).
   */
  private persist(now: number): boolean {
    if (this.persistError === 'refusing to overwrite unreadable prior state') {
      return false; // corrupt bytes still in place — never clobber them
    }
    const state: ProviderCapFileState = {
      version: 1,
      updatedAt: now,
      parks: Object.fromEntries(this.parks),
      ...(this.lastRelease ? { lastRelease: this.lastRelease } : {}),
    };
    const dir = dirname(this.statePath);
    const tmp = `${this.statePath}.tmp.${process.pid}.${++this.tmpCounter}`;
    let fd: number | null = null;
    try {
      this.fs.mkdirSync(dir, { recursive: true });
      fd = this.fs.openSync(tmp, 'w', 0o600) as number;
      const bytes = Buffer.from(JSON.stringify(state, null, 2));
      this.fs.writeSync(fd, bytes, 0, bytes.length, null);
      this.fs.fsyncSync(fd);
      this.fs.closeSync(fd);
      fd = null;
      this.fs.renameSync(tmp, this.statePath);
      const dirFd = this.fs.openSync(dir, 'r') as number;
      try {
        this.fs.fsyncSync(dirFd);
      } finally {
        this.fs.closeSync(dirFd);
      }
      this.durableThrough = now;
      this.persistError = null;
      return true;
    } catch (err) {
      if (fd !== null) {
        try { this.fs.closeSync(fd); } catch { /* already failed */ }
      }
      try { this.fs.unlinkSync(tmp); } catch { /* orphan cleanup is best-effort */ }
      this.persistError = err instanceof Error ? err.message : String(err);
      console.error(`[provider-cap] persist FAILED (state kept in memory): ${this.persistError}`);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  isParked(agent: string): boolean {
    return this.parks.has(agent);
  }

  /** Dispatch (primary or maintenance) must be suppressed right now. False
   *  once the canary window opens — callers must then acquire the single
   *  canary permit via tryAcquireCanary before dispatching. */
  shouldSuppress(agent: string, now: number): boolean {
    const rec = this.parks.get(agent);
    if (!rec) return false;
    return now < rec.eligibleAt || this.canaryInFlight.has(agent);
  }

  /** True when parked and inside the canary window (eligibleAt passed). */
  canaryWindowOpen(agent: string, now: number): boolean {
    const rec = this.parks.get(agent);
    return !!rec && now >= rec.eligibleAt;
  }

  /**
   * Claim the single canary slot. Exactly one dispatch may probe the provider
   * per window; everything else stays suppressed until the probe's terminal
   * outcome releases the permit (noteSuccess / recordCapError / canaryAborted).
   */
  tryAcquireCanary(agent: string, now: number): boolean {
    if (!this.canaryWindowOpen(agent, now)) return false;
    if (this.canaryInFlight.has(agent)) return false;
    this.canaryInFlight.add(agent);
    return true;
  }

  /** The canary ended without touching the cap question (e.g. compile failed
   *  before dispatch). Frees the slot; the park stays as it was. */
  canaryAborted(agent: string): void {
    this.canaryInFlight.delete(agent);
  }

  status(agent: string): (ProviderCapRecord & { canaryInFlight: boolean }) | null {
    const rec = this.parks.get(agent);
    return rec ? { ...rec, canaryInFlight: this.canaryInFlight.has(agent) } : null;
  }

  statusAll(): {
    parks: Array<ProviderCapRecord & { canaryInFlight: boolean }>;
    lastRelease: ProviderCapFileState['lastRelease'] | null;
    loadError: string | null;
    persistError: string | null;
    durableThrough: number | null;
  } {
    return {
      parks: [...this.parks.keys()].map((a) => this.status(a)!),
      lastRelease: this.lastRelease ?? null,
      loadError: this.loadError,
      persistError: this.persistError,
      durableThrough: this.durableThrough,
    };
  }

  // --------------------------------------------------------------------------
  // Transitions
  // --------------------------------------------------------------------------

  /** Deterministic per-episode jitter: same agent + resetAt → same instant,
   *  across restarts; different agents spread out instead of stampeding the
   *  provider at the shared reset second. */
  private jitterFor(agent: string, resetAt: number): number {
    if (this.jitterMaxMs === 0) return 0;
    return fnv1a(`${agent}:${resetAt}`) % this.jitterMaxMs;
  }

  /** Eligibility for the next canary. A future reset waits for it (plus
   *  jitter). A past/present reset — clock skew, a stale error, a canary that
   *  found the cap still on — backs off exponentially from the attempt count
   *  instead of trusting the stale instant: 1 min, 2, 4, ... capped (6 h). */
  private computeEligibleAt(agent: string, rec: { resetAt: number; attemptCount: number }, now: number): number {
    if (rec.resetAt > now) return rec.resetAt + this.jitterFor(agent, rec.resetAt);
    const backoff = Math.min(60_000 * 2 ** Math.max(0, rec.attemptCount - 1), this.maxBackoffMs);
    return now + backoff;
  }

  /**
   * A provider call hit the cap. Entry (not yet parked) or a failed canary
   * (already parked — attempt++, reset instant refreshed from the provider's
   * CURRENT error, so a changed reset time is adopted, never argued with).
   * Returns whether this call ENTERED the park (callers alert/mark only then).
   */
  recordCapError(
    agent: string,
    cls: ProviderCapClassification,
    now: number,
    model?: string,
  ): { entered: boolean; record: ProviderCapRecord } {
    this.canaryInFlight.delete(agent);
    const existing = this.parks.get(agent);
    if (existing) {
      existing.lastAt = now;
      existing.attemptCount += 1;
      existing.resetAt = cls.resetAt;
      existing.scope = cls.scope;
      if (model) existing.model = model;
      existing.eligibleAt = this.computeEligibleAt(agent, existing, now);
      this.persist(now);
      return { entered: false, record: existing };
    }
    const record: ProviderCapRecord = {
      agent,
      provider: cls.provider,
      scope: cls.scope,
      errorClass: cls.errorClass,
      ...(model ? { model } : {}),
      firstAt: now,
      lastAt: now,
      resetAt: cls.resetAt,
      attemptCount: 1,
      heldWakes: 0,
      heldMaintenance: 0,
      eligibleAt: 0,
    };
    record.eligibleAt = this.computeEligibleAt(agent, record, now);
    this.parks.set(agent, record);
    this.persist(now);
    return { entered: true, record };
  }

  /**
   * A provider call SUCCEEDED for a parked agent (the canary, by construction
   * — nothing else dispatches). Releases the park. Returns the closed record
   * so the caller can mark/alert/queue one catch-up wake, or null if the
   * agent was not parked.
   */
  noteSuccess(agent: string, now: number, releasedBy = 'canary'): ProviderCapRecord | null {
    this.canaryInFlight.delete(agent);
    const rec = this.parks.get(agent);
    if (!rec) return null;
    this.parks.delete(agent);
    this.lastRelease = {
      agent,
      releasedAt: now,
      releasedBy,
      attemptCount: rec.attemptCount,
      heldWakes: rec.heldWakes,
      heldMaintenance: rec.heldMaintenance,
      parkedForMs: now - rec.firstAt,
    };
    this.persist(now);
    return rec;
  }

  /** Authenticated operator release — same path as noteSuccess but attributed. */
  operatorClear(agent: string, clearedBy: string, now: number): ProviderCapRecord | null {
    return this.noteSuccess(agent, now, `operator:${clearedBy}`);
  }

  /**
   * The live agent's model differs from the one the cap was measured on —
   * the operator changed provider/model while parked, so the park's evidence
   * is stale. Makes the canary immediately eligible (one probe decides;
   * still-capped re-parks in a single $0 call, and that re-park records the
   * NEW model). Returns true exactly once per change.
   */
  noteModelChanged(agent: string, currentModel: string | undefined, now: number): boolean {
    const rec = this.parks.get(agent);
    if (!rec || !rec.model || !currentModel || rec.model === currentModel) return false;
    rec.model = currentModel;
    rec.eligibleAt = now;
    this.persist(now);
    return true;
  }

  /**
   * Held-work accounting. Advisory counters: persisted lazily (at most one
   * durable write per minute) so a busy channel can't turn the park itself
   * into an fsync storm — losing a minute of counts to a crash is acceptable,
   * losing the park record is not (that one always persists synchronously).
   */
  noteHeldWakes(agent: string, count: number, now: number): void {
    const rec = this.parks.get(agent);
    if (!rec) return;
    rec.heldWakes += count;
    this.persistLazily(now);
  }

  noteHeldMaintenance(agent: string, now: number): void {
    const rec = this.parks.get(agent);
    if (!rec) return;
    rec.heldMaintenance += 1;
    this.persistLazily(now);
  }

  private persistLazily(now: number): void {
    if (now - this.lastHeldPersistAt < 60_000) return;
    this.lastHeldPersistAt = now;
    this.persist(now);
  }
}
