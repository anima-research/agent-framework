# Tool result guard

The tool result guard is off by default. An agent can enable it through
`agent_settings`:

```json
{"action":"update","tool_result_guard":true}
```

Use `{"action":"get"}` to inspect the effective boolean and its source.
The setting persists across turns and process restarts. Set it to `false`
to disable it, or explicitly reset `tool_result_guard` to restore the recipe
default. Programmatic hosts can set `AgentConfig.toolResultGuard: true`.
A host that builds `AgentConfig` from a recipe must forward that key itself;
connectome-host does not forward it yet, so in that host a recipe
`toolResultGuard` line is currently a silent no-op — use `agent_settings`.
Disabling the setting never restores previously withheld output.

## Behavior

The guard applies to the batch of results returned together by the agent's
latest tool round, including text, images, and errors. It recognizes a
structured provider `stopReason: 'refusal'`, not keywords in output, ordinary
provider errors, or natural-language refusal text.

On that signal, every result in the batch is withheld. Tool calls, result IDs,
and error flags remain intact; each entire payload becomes:

> Tool result withheld by the guard. The tool has already executed.

The refused attempt's partial assistant output is discarded. Inference is
retried once on the same model, within the same logical turn; executed tools
are never automatically run again. Refusal details stay in operational logs,
outside the agent-facing notice and setting description.

The guard takes precedence over Membrane's unchanged-input refusal retries
for a pending batch and its recovery attempt. A second refusal stops this
recovery without automatic rewind of older exchanges or human messages.
Explicit operator `/unstick` remains a separate action. A later clean tool
round can stage a new batch with its own single recovery allowance.

Guard effects apply only to a batch that was actually **submitted** to the
provider in the current turn. A batch whose turn ends before submission
(an `endTurn` tool such as `end_turn`/`skip_reply`, or results that arrive
after the response completed) is admitted immediately, recorded as
`accepted` with `reason: "turn_ended"`. A batch that compilation omitted
from the request is recorded as `withheld` with `reason: "unsubmitted"` when
a refusal arrives; that refusal then goes through ordinary refusal handling
(`refusalHandling.retries`/`autoRewind`), since the guarded output was never
on the wire.

Turn-ended admission also requires a durable audit. If staging or sync failed,
the result remains withheld with `reason: "audit_not_durable"`, including on
later turns.

While a submitted batch is pending, compilation reserves the originals' real
wire cost (chars/4 plus a flat per-image cost) in `reserveForResponse`, so
substituting them for the placeholders cannot push a restart's request past
its budget.

While a submitted batch is pending (or a recovery is running), streamed text
and its `inference:tokens` trace events are held at one publication
boundary; they are released in order on a clean round and discarded on a
guard refusal.

Normal successful rounds admit the preceding results to memory. This works
for framework yielding streams (including ephemeral agents and context-budget
restarts) and the backward-compatible direct `Agent.runInference` API.

## Chronicle and memory

Withholding is non-destructive. Before submitting a guarded batch, the host
appends a `staged` record to the Chronicle append-log state
`framework/tool-result-guard`. It contains the full `originals` (including
pre-truncation data, error strings, and image bytes), the serialized history
`content`, and the `wireResults`. A `linked` record connects its `batchId` to
the context message's `messageId`; later `accepted` or `withheld` records
record the outcome. No guard operation deletes or overwrites these records.
Payload fields larger than 10 KB use Chronicle blobs (`{blobId}`), following
the inference log convention; resolve them with `store.getBlob(blobId)` and
parse the JSON. The append-log snapshots retain the blob references.

The context manager initially receives only placeholders, so speculative
compression cannot incorporate output that is subsequently withheld. The
placeholder is not summarized while awaiting a decision: it is staged with a
context-manager compression hold (`addMessage(..., { holdCompression: true })`,
context-manager >= 0.12), placed before the strategy's ingress callback runs.
Every settlement path (accept, withhold, turn-ended, unsubmitted, aborted)
edits in the final content first and then releases the hold. Audit-only
failures cannot keep a settled message held. If an acceptance edit fails,
the guard keeps the accepted payload and its hold in a separate retry queue;
it does not re-arm provider submission or refusal handling. Compression sees
only the settled message: accepted output, or the notice for a withheld batch.
Holds are in-memory; a reopened process has no pending batch and therefore
no holds. Raw
pending output goes directly to the provider. A clean following response
promotes the history payload through Chronicle's versioned message-edit API.
On a refusal, the placeholders remain. The audit slot is not a context or
compression source.

The host calls `store.sync()` after the `staged`/`linked` records and before
the originals can be submitted. A failed staging/link append or sync fails
closed: it is logged (`[tool-result-guard] ... audit persistence failed`),
the provider receives placeholders instead of the originals, and the batch settles as `withheld`
(`reason: "unsubmitted"`). Output whose audit is not durable never reaches a
provider.

Failed edits and audit writes are retried in order before the next real
activation or guard audit write, during maintenance, and after stream teardown
at shutdown. Preview/compile calls do not flush the queue. A history edit is
retried only on its original branch and only if the message still contains the
guard's placeholder or the accepted payload; later operator edits, removals,
and branch changes take precedence. Such an acceptance is audited with
`historyUpdate: "superseded"` and its `sourceBranch` rather than overwriting
the operator's view. Originals in the audit are never edited or removed.

Storage retries are in-memory. If the process dies before storage recovers,
unsynced records or unfinished edits cannot be promised to survive. Originals
already made durable remain in Chronicle; reopened context conservatively
retains any withholding notice whose acceptance edit did not persist.

A stream that ends without a clean round and without a successor (abort,
exhausted error retries; also an aborted direct `Agent.runInference`)
settles its batch as `withheld` with `reason: "aborted"`, so a later turn
neither resubmits the originals nor treats its own refusal as the guard's.

If the process stops before settlement finishes, placeholders remain after
restart; originals whose audit reached durability are still available. This is
deliberately conservative: an interrupted submission does not establish that
the output was accepted. Similarly, if context compilation omits a pending
exchange, its unsubmitted payload is not admitted to memory.

For example, an operator can inspect records without changing the agent's
view:

```ts
const store = framework.getStore();
const records = store.getStateJson('framework/tool-result-guard');
// For large logs, use getStateLen/getStateItemJson instead of loading all.
const historical = store.getStateJsonAt('framework/tool-result-guard', sequence);
```

This is reactive recovery, not pre-submission screening: the provider sees
the original batch once before returning the signal. The setting is not
retroactive and does not rewrite results already accepted into memory.

## Known limits

- **Explicit-send suppression across a budget restart.** A guard recovery
  carries the same-turn send suppression, so a text-only recovery after a
  successful explicit send is not routed (locus/hybrid). Context-budget
  restarts still re-enter without it (inherited, unchanged here).
- **Audit growth.** Every guarded batch, accepted ones included, archives
  `originals`, `content`, and `wireResults` indefinitely. There is no
  retention policy and no restore tool; large payloads are blobs, but a full
  `getStateJson` read materializes the whole log.
- **Token stats.** The context manager's token-stats cache is not
  write-through on edit, so a stats read taken while a batch was pending can
  keep pricing that message as the placeholder.
- **Held stream text on abort.** Text held while a submitted batch is
  pending is dropped (not previewed) if the stream aborts or errors before
  the round settles.
