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
converse is a known limit: if compression summarizes the placeholder
*before* acceptance (e.g. deferred messages flushed behind the batch push it
out of the protected tail), the later acceptance edit does not invalidate
that summary, and the accepted output is absent from compressed memory.
Closing this needs a context-manager hook (a transient compression hold
for pending messages, or edit-aware invalidation of derived entries). Raw
pending output goes directly to the provider. A clean following response
promotes the history payload through Chronicle's versioned message-edit API.
On a refusal, the placeholders remain. The audit slot is not a context or
compression source.

The host calls `store.sync()` after the `staged`/`linked` records and before
the originals can be submitted. A failed sync is logged loudly
(`[tool-result-guard] ... audit sync failed`) but does not stop submission,
so in that case the records are only as durable as any other unsynced write.

If the process stops before acceptance, placeholders remain after restart;
the full pending originals are still available in the audit. This is
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

- **Compression before acceptance** — see above; needs a context-manager
  change.
- **Explicit-send suppression across a recovery.** The recovery restart
  re-enters the stream without the previous round's `hadToolCalls` /
  same-turn send-silencing state, so a text-only recovery after a successful
  explicit `send` can publish a postscript the policy would have silenced.
  Context-budget restarts share this inherited limitation.
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
