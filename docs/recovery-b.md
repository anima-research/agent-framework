# Bounded whole-body recovery (Option B)

Refusal auto-rewind, forced `/unstick`, and inference-exhaustion quarantine use
one read-only plan before removing anything. A successful tool step removes a
complete, unambiguous call body and all its result bodies, not the inclusive
interval between them. Signed thinking, narration, images and every shard of
those bodies go together. Separate visible system/clock/lifecycle notices and
obsolete reasoning-loss notices stay; notice payload is not counted in the
content-free descriptor. Accounting is UTF-8 JSON stored-content bytes and
selected top-level images. One exchange costs one normal bounded rewind step.

On a presented window this is one `retractRows(heads, {undone:true})`, leaving
raw history and other residents' windows untouched for the selected exchange.
The separate refused-reply cleanup removes that reply globally and reconciles
other windows; that reply is not covered by this retention guarantee. Legacy recovery uses one
body-aligned contiguous raw removal, with the existing cross-window removal
semantics. A retained notice creates a hole: legacy recovery declines with no
writes, even after a failed initial write-down. It never forces conversion to
presented mode.

## Unsupported is not empty or repaired

Recovery deliberately declines corrupt/missing/duplicate IDs, reuse before a
round completes, incomplete rounds, mixed call/result bodies, intervening ordinary rows,
rewind markers, system changes, hidden non-tool shards, embedded system
notices, foreign context ownership and bodies not belonging to this reader's
native audience. Ordinary legacy own-row text selection follows the compile's
recorded visibility, not presentation ownership: a visible co-resident text body
is eligible; a visible foreign tool round declines rather than sacrificing an
older owned round. A stored result absent the current presented window also
declines: CM 0.27 cannot retract it in the same atomic batch. **Uncarried**
means absent the served request; **unpresented** means absent the CM window.
Refusal and standalone recovery can support uncarried result bodies already
resident in that window; exhaustion requires every selected body to be carried;
there is no present-first write, raw fallback, or new CM layer. ID matching follows
reader-owned live rounds in stored order: reuse after completion or in an undone older round does not create ambiguity.
Presented observations are transcript text, so another resident's ID reuse does
not reserve native IDs there. Legacy observations can remain native tool calls;
an observed unresolved call can therefore conservatively block the same ID in
the reader's later round. Within that
scope, stored endpoints including newer skipped/held results are checked in both
directions; unpresented endpoints are not ignored. It does not repair
unrelated malformed history or recursively close mixed chains.

The tool-result guard must have neither a pending batch **nor** queued
storage/annotation work, and no pending assistant round may remain. A standalone
attempt also needs the agent's idle boundary: no live turn token, stream, or
queued, parked, provider-held or budget-held continuation, even when status
already reads `idle`. Only terminal refusal can recover its own ending turn before token release.
Exhaustion carries the failed request's exact raw-body set into planning: the
initial compile plus each tool round's submitted call, result and supported
injected-message bodies, never later unsent arrivals;
every selected body head, including all tool-closure endpoints, must belong to
that set. If a late result completes a carried call, the whole plan declines
without removing either endpoint, selecting older history, consuming a step,
adding a marker or queuing a rewind retry. Missing provenance
or a changed/unreadable compile branch declines without quarantine or a rewind
retry. This witness is attempt-local, not a durable fence against future writers.
This follow-up **widens the supported path** compared with the published
“active-stream terminal failure stops unchanged” behavior. A registered stream's
qualifying exhausted provider failure (for example `invalid_request` HTTP 400,
not every HTTP 400) now keeps its attempt-local request witness through iterator completion,
successful queued speech delivery and terminal teardown. Later tool hand-offs
update that same request-body set; terminal failure snapshots it before waiting.
Only successful settlement permits quarantine, with full logical quiescence,
settled guard work and the same terminal owner, branch and carried bodies.
An unverifiable hand-off cannot supply a witness. Caught delivery rejections
keep subsequent posts ordered but are not successful settlement: they disable
automatic exhaustion quarantine for that Agent instance, including later
pre-stream failures, until it is stopped and recreated after inspection. A genuinely live or unsettled stream still blocks
recovery; a successor turn or stream invalidates the old terminal's ownership.
Pre-stream failures retain the same witness requirements and wait for earlier
streams' queued deliveries before accounting for a qualifying failure. Closed
provider admission during shutdown forbids quarantine and rewind retries. Failure accounting
may append an `inference-failed` notice even when quarantine declines; an
unchanged quarantine means no history shedding or rewind retry, not an
unchanged store. This is a known-writer boundary, not a promise that arbitrary
future modules cannot append a result. Dendrite
held result mail is not itself a stored `tool_result` endpoint.

A refused reply is excluded from planning only after its whole body is verified
tool-free. Unsupported, empty, or cap-exhausted attempts do not remove that
reply, remove either endpoint, add a marker, count a successful step or enqueue
a rewind retry. Exhaustion decline or a cap stop before mutation leaves counts and markers
unchanged. Any confirmed removal consumes a step, even if notification,
cleanup or marker writing subsequently fails; no retry follows that failure. Automatic refusal rewind instead
ends its attempt on give-up and resets its budget for a later independent wake,
without queuing a retry; the durable marker remains, but the episode count
is cleared. A missing, hidden, branched-away or non-tail marker also starts a
fresh count instead of editing an old prefix. `/unstick` preflight declines before opening a session or
queuing its initial probe. Supported probes re-plan at actual refusal. Later
unsupported forced recovery ends as `gave-up`, with the logged bounded reason;
it does not claim `cleared`. Exhaustion logs distinguish waiting for known work to settle from inspecting history for repair.

Markers consolidate only while the current marker remains at the visible tail.
A retained notice after it starts another marker/count, even within one recovery
episode: there is no one-marker-per-episode or shed-N/add-one convergence guarantee.
Marker counts describe consecutive omissions at that position, not a caller's
budget. Forced-session, automatic-refusal and exhaustion logs use their own
confirmed-removal counts; changing callers does not turn the marker into a
shared budget.

## Failure and transaction boundary

Only confirmed removals count. Throwing CM writes are read back, not replayed.
Even a confirmed post-commit removal stops automatic retry, since notifications,
refused-reply cleanup and the consolidated marker are separate operations.
Unknown/partial readback, a branch change, failed cleanup, or a failed marker
also stop. A forced outcome still reports a confirmed removal if cleanup then
fails. Legacy markers truthfully say that originals were removed from raw history. No crash-atomic cross-write counter/marker guarantee is made.

No durable wake fence is added: an independently triggered later wake can
resubmit unchanged unsupported history or plan and mutate again after an
unknown/partial write outcome. The no-replay guarantee covers only the current
attempt. Stop normal writers and inspect the store before allowing another wake
after uncertainty; the framework does not enforce that operator boundary. No cap bypass, provider changes,
malformed-history repair, storage format or CM API is part of this change.

## Synchronous whole-history cost (not window-bounded)

The rewind **step count** is bounded; snapshot time and memory are not.
The cap does not preserve a minimum history: even one step can remove all
eligible conversational content when only one eligible body remains. After the
guard and live-turn checks pass, each plan, including `/unstick` preflight and
plans that later decline, calls
`getAllMessages()` and examines raw bodies, including held/unpresented endpoints.
This can inflate every historical image/blob even for a tiny presented window.
CM caches may make a warm read cheap; they do not impose a recovery memory cap.

Offline measurement with Node 22.23.3, CM 0.27.0 and Chronicle 0.6.0:
128 distinct raw images containing 32 MiB of base64, with only one presented
text row, took **34.0–37.3 ms synchronously**, allocating **32.8–32.9 MiB heap**
and **80.4–80.6 MiB RSS** across three fresh-process cold plans. The fixture
uses real CM/blob storage and the production planner with idle host state;
it excludes process startup, store opening, provider calls and mutation.
Reproduce **from a source checkout** (the published package does not ship the probe), after building, with
`node --expose-gc scripts/recovery-plan-cost.mjs` (optional row-count and
KiB-per-row arguments). These are fixture observations, not bounds or a
production latency guarantee. Larger histories can stall the event loop or
exhaust memory before a decline is returned. For large/image-heavy stores,
provision memory for raw history and perform inspected, exclusive offline
maintenance before invoking recovery; a small context window is not protection.
No bounded metadata-only snapshot API or background planner is introduced here.

## Intentional test / compatibility dispositions

The former adjacent-**whatever-IDs** exception is retired, not retained as a
best-effort corruption breaker. Adjacency cannot prove either-direction closure.

| Previous control / assertion | Option B disposition / replacement |
| --- | --- |
| Adjacent or notice-gap missing/mismatched/mixed IDs remove a result or pair | Decline; raw/window snapshots unchanged; quarantine does not count or retry |
| Barrier/marker/hidden call causes result-only fallback | Decline; neither endpoint changes |
| Skipped mixed body allows call-only or mixed-body/result removal | Both carried states decline, preventing forward and reverse orphans |
| Hidden/heterogeneous sibling or embedded system notice removed with result | Decline the whole attempt; no borrowed visibility |
| Raw notice-gap removal deletes notices and other-window rows | Genuine failed-write-down gap declines byte-identically; adjacent complete raw round still succeeds and propagates |
| Descriptor includes intervening notice bytes/image | Counts only selected bodies; multiple selected images and dominant signature/input/UTF-8 payload are tested |
| Gap scan requires implementation-specific content getter read counts | Retired with the backward pairing walk; whole-history snapshot body scan replaces it (see cost below) |
| Empty/cap-exhausted rewind cleans refused reply alone | No mutation without a ready target and budget; later independent requests can still carry the reply |
| Carried call with stored but unpresented held result was shed by call alone | Original setup retained as a no-removal/no-cleanup/no-new-step/no-retry decline witness, with resident uncarried-result positive counterpart |
| Staged omitted guard batch permits rewind before asynchronous settlement becomes idle | Guard still settles normally, but recovery declines without a marker, endpoint removal or retry |
| `/unstick` can open an empty parked session | Preflight needs an eligible target; lifecycle outcome test now seeds that target |

Unaffected whole-body, other-resident, undo/redo/restart, whitespace witness,
legacy foreign/held selection, signed tool-round, and bounded budget controls
remain. Real-store tests exercise actual refusal/forced callers, production
exhaustion entry and terminal error streams, positive before/after wire history,
resident-before witnesses, retained clock and one-shot notices, including
notices arriving after compile. Defensive malformed/heterogeneous bodies use
CM's internal append or snapshot injection where normal CM writers reject them;
those tests do not claim normal writers produce such shapes.

## Safe manual repair for interrupted calls

An interrupted call body with no stored result is intentionally unsupported on
all rewind paths. Repeating `/unstick` cannot repair it. Do not fabricate a
result, replay a possibly side-effecting tool, or delete just one endpoint.

1. Stop writers: **every process that can write the store**, not merely an
   idle host. Take a **fresh, coherent copy** of the complete store after writers
   have stopped, and note the affected branch, resident and body IDs before
   changing anything. Keep all normal writers stopped throughout inspection and repair.
   Repair must use a single exclusive offline maintenance process with
   inference, event ingestion, timers and background writers disabled; if the
   host cannot provide that mode, do not restart it for repair.
   Reconcile unfinished or unknown dispatches first: establish whether each
   tool ran and what external effects it produced before undoing history.
   If dispatch outcomes cannot be established, keep the store stopped and
   escalate to the maintainer rather than assuming the tools did not run.
2. Inspect raw history **and** the resident's presented window. Identify the
   complete assistant body (all shards, thinking and calls), every call ID and
   any stored matching results, including held/unpresented rows and other
   branches. If IDs, ownership or closure are uncertain, keep the backup and
   ask the maintainer to repair the snapshot; do not guess.
3. For a verified trailing call-only body with nothing after it, have the
   exclusive maintenance process use CM's whole-body
   `cm.retractRows([head], { undone: true })` on the
   affected presented window. Do not use normal whole-turn `/undo`: it requires
   a presented window and can retract earlier exchanges and notices as well.
   For legacy raw history, only a verified exact contiguous whole-body interval
   may be removed with CM's removal API, with all resident windows reconciled.
   Retraction does not roll back external tool effects; reconcile those
   separately. If exclusive offline maintenance is unavailable, leave the
   store stopped and escalate for snapshot repair. Never hand-edit Chronicle files.
4. Verify that the next compiled request contains neither the removed calls
   nor orphan results, that unrelated notices and other residents are intact,
   then restart from the repaired snapshot. If verification fails, keep writers
   stopped and restore only the fresh, coherent backup, ensuring restoration
   does not overwrite later writes. If any later writes occurred, preserve them
   and have a maintainer reconcile them before restoring; do not blindly replace
   the store. This is operator repair, not an automatic recovery exception.

Marker limits: the consolidated count advances when the marker write succeeds,
not at the removal commit, so a later marker can understate prior removals after
a cleanup/marker failure. Markers are model-visible explanatory text, not
metadata-only. Consolidation tracks whether omissions retained originals, removed
them, or did both across a mode change; same-mode reuse preserves the retention
statement and mixed-mode reuse explicitly states both outcomes. Its metadata
records the initial count/category/cause; consolidation edits only the text,
so metadata is not a current aggregate either. Consult the
backed-up store and failure logs for repair, not the marker alone. Forced-session
failure summaries report a stopped, unverified recovery and confirmed removals;
the bounded stop reason is in the host log.
