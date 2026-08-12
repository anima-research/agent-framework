/**
 * Authorized live-pattern check (Sol, 2026-08-11T22:27Z): read ONE existing
 * Cairn workspace-cap 400 record from the local llm-calls log, feed its
 * VERBATIM error fields through the real classifier, and emit ONLY:
 * match boolean + normalized reset date + record timestamp + record sha256 +
 * structural-invariant booleans. No error body, no resident content, no
 * surrounding record fields are printed. Read-only: the log is opened with
 * a read fd; nothing under ~/cairn is written.
 */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MembraneError } from '@animalabs/membrane';
import { classifyProviderCapError, capShapedButUnparsed } from '../src/provider-cap.js';

const LOG = process.argv[2];
if (!LOG) { console.error('usage: bun live-pattern-check.ts <llm-calls.jsonl>'); process.exit(2); }

// Read the last TAIL_BYTES of the (multi-GB) log without loading the file.
const TAIL_BYTES = 16 * 1024 * 1024;
const fd = openSync(LOG, 'r');
const size = fstatSync(fd).size;
const start = Math.max(0, size - TAIL_BYTES);
const buf = Buffer.alloc(size - start);
readSync(fd, buf, 0, buf.length, start);
closeSync(fd);

const lines = buf.toString('utf8').split('\n');
// Drop the first (possibly partial) line unless we started at 0.
if (start > 0) lines.shift();

const NEEDLE = 'You have reached your specified';
let picked: string | null = null;
for (let i = lines.length - 1; i >= 0; i--) {
  if (lines[i].includes(NEEDLE)) { picked = lines[i]; break; }
}
if (!picked) { console.log(JSON.stringify({ found: false, scannedTailBytes: buf.length })); process.exit(0); }

const recordSha = createHash('sha256').update(picked).digest('hex');
const rec = JSON.parse(picked) as Record<string, unknown>;

// Locate the error info in the record without printing it. fkm logs either a
// structured error object or rawError; walk known shapes.
function dig(o: unknown, path: string[]): unknown {
  let cur: unknown = o;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}
const err = (rec.error ?? rec.rawError ?? dig(rec, ['response', 'error'])) as
  | Record<string, unknown> | undefined;

const type = (err?.type ?? dig(err, ['errorInfo', 'type'])) as string | undefined;
const httpStatus = (err?.httpStatus ?? err?.status) as number | undefined;
const message = (err?.message ?? dig(err, ['error', 'message'])) as string | undefined;
const rawError = (err?.rawError ?? err) as unknown;
const bodyType = (dig(rawError, ['error', 'error', 'type'])
  ?? dig(rawError, ['error', 'type'])) as string | undefined;

// Rebuild the MembraneError EXACTLY as membrane would deliver it live, with
// every field taken verbatim from the record.
const rebuilt = new MembraneError({
  type: (type ?? 'invalid_request') as 'invalid_request',
  message: message ?? '',
  retryable: false,
  httpStatus: httpStatus ?? 400,
  rawError,
});

const cls = classifyProviderCapError(rebuilt);
console.log(JSON.stringify({
  found: true,
  recordTimestamp: rec.timestamp ?? rec.at ?? null,
  recordSha256: recordSha,
  invariants: {
    membraneType: type ?? '(absent)',
    httpStatus: httpStatus ?? '(absent)',
    providerBodyType: bodyType ?? '(absent)',
    messagePresent: typeof message === 'string',
    messageLength: typeof message === 'string' ? message.length : 0,
  },
  classifierMatch: cls !== null,
  normalizedResetAt: cls ? new Date(cls.resetAt).toISOString() : null,
  scope: cls?.scope ?? null,
  capShapedButUnparsed: cls === null ? capShapedButUnparsed(rebuilt) : false,
}, null, 2));
