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
and error flags remain intact; each entire payload becomes the guard's notice.
For a result that isn't an error it is

> Tool result withheld by the guard. The tool has already executed.

for a call that was refused and never ran (`ToolResult.refused`),

> Tool result withheld by the guard. The tool didn't run.

and for any other error result (`isError`), which can come before or after the
tool runs,

> Tool result withheld by the guard. The call returned an error, and this notice can't say whether the tool ran.

The notice is followed by where the original is (see "Where a withheld original
goes" below); for an error result whose original was written to a workspace
file, by "Read it before calling again."; and, for the workspace's
`materialize`, `sync` and `delete`, by the fields of their results that say
what they acted on. The same holds for every withheld settlement: a refusal, an
aborted stream, a batch that was never submitted, and one whose audit sync
failed.

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

While a submitted batch is pending (or a recovery is running), the
round's `inference:tokens` trace events are held at one publication
boundary; they are released in order on a clean round and discarded on a
guard refusal. The outgoing stream needs no hold: it carries only what
delivery publishes, and a refused attempt publishes nothing.

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
edits in the final content first and then releases the hold: an accepted
batch's payload, or a withheld batch's stub, which is edited once the host
has reported where each of its originals went, including a failed, skipped
or unfinished write, so a withheld batch stays held meanwhile.
Once a history edit succeeds, its own audit-only failure does not retain that message's hold. If an acceptance
edit or a stub's edit fails, the guard keeps the content and its hold in a
separate retry queue; it does not re-arm provider submission or refusal
handling. Compression sees only the settled message: accepted output, or a
withheld batch's stub.
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
activation, compile of a request that is sent, or guard audit write, during
maintenance, and after stream teardown at shutdown, including those of an
ephemeral run or a closed conversation fork that has left the agent map.

With `maintenanceIntervalMs: 0`, periodic retries are disabled; stop still retries retained guards. The queue is ordered: a failing audit write blocks later queued history edits and their compression holds until the write succeeds. Shutdown retries the same queue and reports an error if it still fails.

Previews do not flush the queue. A history edit is retried only on its
original branch and only if the message still contains the guard's
placeholder or the content the edit writes; later operator edits, removals,
and branch changes take precedence. Such an edit is audited with
`historyUpdate: "superseded"` and its `sourceBranch` rather than overwriting
the operator's view. Originals in the audit are never edited or removed.

Storage retries are in-memory. If the process dies before storage recovers,
unsynced records or unfinished edits cannot be promised to survive. Originals
already made durable remain in Chronicle. A reopened context keeps the
withholding notice of any batch whose acceptance edit or stub edit did not
persist, with no compression hold, and nothing edits it later; an
`annotated` record that was saved still names a written file.

A stream that ends without a clean round and without a successor (abort,
exhausted error retries; also an aborted direct `Agent.runInference`)
settles its batch as `withheld` with `reason: "aborted"`, so a later turn
neither resubmits the originals nor treats its own refusal as the guard's.

An ephemeral run that leaves while its batch is still pending, however it
leaves, settles the batch as it leaves, before its agent is deregistered,
since nothing would settle it afterwards. The batch is `withheld` with
`reason: "run_stalled"` when the completion watchdog ended the run as
stalled, and otherwise with `reason: "aborted"`.

If the process stops before settlement finishes, placeholders remain after
restart; originals whose audit reached durability are still available. This is
deliberately conservative: an interrupted submission does not establish that
the output was accepted. Similarly, if context compilation omits a pending
exchange, its unsubmitted payload is not admitted to memory.

## Where a withheld original goes

Each withheld result's original is written, as the result was stored (its
text; for a result over the inline cap, its capped text, whose own note names
the file with the whole output), to a file under the `tool-results/`
directory of the first writable mount without an include that isn't
configured direct (a direct mount's directory is a checkout, whether it runs
direct or as 'chronicle'), named
`<date>-withheld-<batch>-<index>-<toolUseId>.txt` with any character outside
`A-Za-z0-9._-` replaced and the name cut to 80 characters. Its stub names it:

> Tool result withheld by the guard. The tool has already executed. Its result
> is in workspace file work/tool-results/2026-10-10-withheld-1a2b3c4d5e6f-0-toolu_01.txt.

Otherwise the stub names the guard's audit record, for an operator:

- with no writable mount without an include that isn't configured direct, or once the framework is
  stopping: "Its result is kept in the guard's audit record
  (framework/tool-result-guard), for an operator.";
- when the write failed: "Writing its result to workspace file … failed, so it
  is kept only in the guard's audit record …". The error itself stays in the
  audit record and the logs;
- when the write is still under way at its batch's deadline: "Its result was still being written to workspace file … when this note was made; if that file is missing, it is kept in the guard's audit record …".

Each batch has one 30-second deadline, starting when the batch is queued, so a request waiting on a chain of batches waits at most one deadline past the latest one's arrival. Each successive write uses the remaining time. Once the deadline passes, the request can carry the unfinished-write notice; later results in the batch name the audit record. The underlying write continues, and may finish or fail later. The guard stops waiting for it at the deadline, but `stop()` still waits for the workspace's own turns, which such a write holds, bounded only by a teardown timeout passed to `stop()`, and indefinitely without one. A deadline that fires logs the file's path to stderr. While any write remains overdue, new withheld spills are skipped as `workspace_unanswered`, logged once for the stall and counted when it clears. A write that never settles keeps that gate closed for the process lifetime. Other batches can start writes before the first deadline fires, each within its own deadline. This bound covers withheld spills; the inline cap's original spill has no deadline.

A file whose tree entry was set is readable through the workspace's tools, on the branch that was current when the entry was set, even if the rest of its write fails: its disk copy refused, or a throw after the entry. `WorkspaceModule.writeBinary` reports `data: { inChronicle: true }` for that outcome. Both withheld stubs and inline truncation notes name the tree file, while stderr and `tool:spill_failed` report the failure (the workspace's own `workspace:materialize-failed` event is emitted only for a refused push). `save_recent_image` also counts that file as saved, with its path, size, MIME type, `inChronicle` and `diskCopyError` (the failure after the tree entry, whichever it was) in the saved receipt, and an RFC-005 reference fetched to such a file names it. A write that throws before its tree entry is set fails the call, naming the images already saved.

When saving the staged audit record itself had failed as the result arrived,
the stub says the result went to the audit record "though saving that record
had failed when the result arrived", rather than that it is kept there.

A tool can mark fields of its result's `data` to keep in the stub
(`ToolResult.keepWhenWithheld`), and the workspace's `materialize`, `sync` and
`delete` do: what `materialize` removed from disk and wrote to it, any root
`sync` accepted and what it took from disk, gave up or holds as a conflict, and
the path `delete` removed. They follow where the original is, in every form of
the stub:

> Tool result withheld by the guard. The tool has already executed. Its result
> is in workspace file work/tool-results/2026-10-10-withheld-1a2b3c4d5e6f-0-toolu_01.txt.
> Kept from its result: {"materialized":[{"mount":"work","path":"LOG.md"}]}

They're serialized as a stored result is, in the order marked. Past the inline
cap they're cut, with a note saying so and that the whole result is where the
stub says, so a later field can be cut away entirely. A failed result keeps
nothing, and no other tool marks any field.

The file is an ordinary workspace file. The agent can read it back
deliberately, and so can whoever else reads the mount: another agent sharing
it, a process, or a synced copy. Withholding keeps the original out of the
agent's context, not out of its workspace.

If the active branch changes while the originals are being written (a
rollback, an undo, a host's switch), no more are written, and the rest are
recorded as skipped for the branch change. While the store is away from the
batch's branch, the stub stays as it was; if the branch is back by the edit,
as after an undo and a redo, each skipped result's stub names the audit
record. A write already under way names the batch's branch, and the workspace
refuses it where it commits the file (`WorkspaceModule.writeBinary`'s `branch`
option, whose refusal carries `data: { branchLeft: true }`), so no original's
tree entry lands on another branch. With `autoMaterialize`, a mount has one
directory on disk for every branch, so a written file's copy there, made after
its tree entry, is there whichever branch is active, like any other write's.

Two audit records describe it, each with `batchId`, `messageId` and
`sourceBranch`:

- `annotated`, queued first, on its own: one entry in `results` per result.
  `{ toolUseId, path }` is a written file; with `error`, a failed write; with
  `unfinished: true`, a write still under way at the deadline. `{ toolUseId,
  error }` is a write that threw. `{ toolUseId, skipped }` is no write:
  `no_workspace_file` (no writable mount without an include that isn't configured direct, or the framework
  was stopping), `workspace_unanswered` (an earlier write was still under way past its
  deadline), `batch_deadline` (the batch had no time left to start another write), or `branch_changed` (the workspace declined the write before its tree entry was set).

The `annotated` record describes what each spill reported when the batch's annotation finished. An `unfinished` entry is not updated when the underlying write later settles.
- `stub_updated`: the stub's edit, with `historyUpdate: "superseded"` when an
  operator's edit, removal, rollback or branch change came first.

The stub's edit is made at once. If it fails, it waits in the retry queue
above, and the batch stays held until it lands, so no summary is made of a
stub that doesn't yet say where its original went. Meanwhile a request
compiled while it is failing, as the refusal retry is, carries the bare
notice, and the `annotated` record, once saved, names the file. An activation
or a direct API call retries the queue first, and fails while the edit keeps
failing, as it does for a failing acceptance edit.
Requests sent by the framework or the direct Agent inference API are compiled after the guard's annotations finish, including the refusal retry. A conversation fork also waits before compiling its template's seed. A preview, including public `compileContext()`, does not wait and can show a stub before its place is added.

Concurrent starts on one Agent, a direct inference call beside a framework-driven turn, are not made safe here: an Agent compiles its request while its status still reads idle (or ready), as before this change, and the wait for annotations lengthens that window, by up to the batch's deadline. `abortInference()` returns false during a direct call's initial assembly; a caller's own abort signal is checked before the request is sent, and again after the refusal retry's annotation wait. The direct API reads its unguarded tool results once, after the first compile, and sends the same ones with the refusal retry.

At stop, the framework lets running annotations finish while the workspace is up. An annotation that starts after that drain writes no file and is saved before the store closes. A framework-driven turn that compiled across stop is discarded before its stream is driven, even if the same framework has since restarted. A `start()` after a finished `stop()` starts a new lifecycle, with the spill gate open again; a `start()` made while a `stop()` is still running is refused. These lifecycle gates cover framework-driven turns; direct Agent calls use their caller's abort signal.

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
  carries the same-turn send suppression, so a text-only recovery is held
  where an explicit send may have posted (locus/hybrid). Context-budget
  restarts still re-enter without it (inherited, unchanged here).
- **Audit growth.** Every guarded batch, accepted ones included, archives
  `originals`, `content`, and `wireResults` indefinitely. There is no
  retention policy and no restore tool; large payloads are blobs, but a full
  `getStateJson` read materializes the whole log.
- **Token stats.** The context manager's token-stats cache is not
  write-through on edit, so a stats read taken while a batch was pending can
  keep pricing that message as the placeholder.
- **Held token traces on abort.** `inference:tokens` traces held while a
  submitted batch is pending are dropped (not previewed) if the stream
  aborts or errors before the round settles.
- **Withheld originals in the workspace.** Every reader of the mount can read
  a withheld original's file, and nothing removes it; delete it as any
  workspace file.
