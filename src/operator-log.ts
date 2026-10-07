/**
 * Operator action log — a durable, append-only JSONL record of every
 * operator-initiated mutation of a live resident: branch rollbacks, message
 * suppressions, undo/redo/hide, unstick/nudge, runtime-settings changes,
 * host quiesce/resume. One file per store, next to the chronicle
 * (`<storePath>/operator-actions.jsonl`), so it travels with backups and
 * survives host restarts the way `repair-receipts.jsonl` and
 * `watchdog-wedge.jsonl` do.
 *
 * The chronicle record log is the authoritative history of *what* changed;
 * this file records *who asked for it, from where, and why* — the part the
 * store cannot know. Writes are best-effort (a logging failure never fails
 * the action) and synchronous (`write(2)`, not `fsync`): an entry survives a
 * process crash once the call returns, not a power loss. Mutations record
 * after they complete, so a crash between the chronicle switch and the
 * append loses the who/why for that one action — the branch itself remains
 * the evidence. The file is created 0600: it carries requester identity and
 * free-text operator notes.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Who asked. `via` names the surface ('webui', 'host-command', 'api',
 *  'cli', …); `name`/`id` are whatever identity that surface has. */
export interface OperatorRequester {
  via: string;
  name?: string;
  id?: string;
}

export interface OperatorLogEntry {
  /** ISO-8601 wall-clock time of the record. */
  at: string;
  /** Action kind, e.g. 'rollback', 'suppress', 'undo', 'hide', 'quiesce'. */
  kind: string;
  /** Agent the action targeted (absent for host-wide actions). */
  agent?: string;
  requester?: OperatorRequester;
  /** Free-text reason supplied by the operator. */
  note?: string;
  /** Inputs as the caller supplied them (ids, counts, patches). */
  params?: Record<string, unknown>;
  /** Outcome details (branches, removed ids, refs) when the action succeeded. */
  result?: Record<string, unknown>;
  /** Error message when the action was refused or failed. */
  error?: string;
}

export type OperatorLogInput = Omit<OperatorLogEntry, 'at'> & { at?: string };

export class OperatorLog {
  private warned = false;

  constructor(readonly path: string | undefined) {}

  get enabled(): boolean {
    return this.path !== undefined;
  }

  /** Append one record. Never throws. Returns the stamped entry. */
  append(input: OperatorLogInput): OperatorLogEntry {
    const entry: OperatorLogEntry = { ...input, at: input.at ?? new Date().toISOString() };
    if (!this.path) return entry;
    try {
      const dir = dirname(this.path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.error(
          `[operator-log] failed to write ${this.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return entry;
  }

  /**
   * Read the newest `limit` entries (oldest first within the slice). Reads
   * the whole file — the log is small (one line per operator action).
   * Malformed lines are skipped rather than failing the read.
   */
  readTail(limit = 100): OperatorLogEntry[] {
    if (!this.path || !existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const slice = lines.slice(Math.max(0, lines.length - Math.max(0, limit)));
    const out: OperatorLogEntry[] = [];
    for (const line of slice) {
      try {
        const parsed = JSON.parse(line) as OperatorLogEntry;
        if (parsed && typeof parsed === 'object' && typeof parsed.kind === 'string') out.push(parsed);
      } catch {
        // skip torn/corrupt line
      }
    }
    return out;
  }
}

export function defaultOperatorLogPath(storePath: string): string {
  return join(storePath, 'operator-actions.jsonl');
}

/** Ids lists in log records are capped so one wide `hide`/`suppress` cannot
 *  write a multi-KB line; the full count is always recorded alongside. */
export const OPERATOR_LOG_ID_CAP = 50;
export function capIds(ids: string[]): { ids: string[]; count: number; truncated?: true } {
  return ids.length > OPERATOR_LOG_ID_CAP
    ? { ids: ids.slice(0, OPERATOR_LOG_ID_CAP), count: ids.length, truncated: true }
    : { ids, count: ids.length };
}

/**
 * What a live surgery did about Discord awareness marks, reported apart from
 * the body change itself. A surgery that returns has applied its body change;
 * this says only whether marks were scheduled:
 *
 * - `none` — the change removed no addressable Discord message.
 * - `queued` — the outbox batch is durably active and its delivery has been
 *   handed to the background drain. It is not a delivery claim: per-message
 *   outcomes stay in the outbox ledger.
 * - `not-scheduled` — the body change landed, but recording the batch as
 *   active failed, so it was retired from the ledger: none of its marks will
 *   be delivered.
 * - `unresolved` — the ledger could record neither the activation nor the
 *   retirement. The batch (`batchId`) is still in the ledger in its prepared
 *   state, and any later reconciliation or restart that can read it may
 *   promote and deliver it; nothing here promises otherwise.
 */
export type SurgeryMarkerReceipt =
  | { status: 'none'; queued: 0 }
  | { status: 'queued'; queued: number; batchId: string }
  | { status: 'not-scheduled'; queued: 0; error: string }
  | { status: 'unresolved'; queued: 0; batchId: string; error: string };

/** Thrown by live surgery methods when a request cannot be honored. `code`
 *  lets surfaces distinguish "agent busy — quiesce first" from bad input. */
export class OperatorActionError extends Error {
  constructor(
    readonly code: 'unknown-agent' | 'agent-busy' | 'unknown-message' | 'invalid' | 'failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OperatorActionError';
  }
}
