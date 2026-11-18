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
native audience. A stored result absent the current presented window also
declines: CM 0.27 cannot retract it in the same atomic batch. **Uncarried**
means absent the served request; **unpresented** means absent the CM window.
Uncarried result bodies already resident in that window can be supported;
there is no present-first write, raw fallback, or new CM layer. ID matching follows
reader-owned live rounds in stored order: reuse after completion, by another
resident, or in an undone older round does not create ambiguity. Within that
scope, stored endpoints including newer skipped/held results are checked in both
directions; unpresented endpoints are not ignored. It does not repair
unrelated malformed history or recursively close mixed chains.

The tool-result guard must have neither a pending batch **nor** queued
storage/annotation work, and no pending assistant round may remain. A standalone
attempt also needs the agent's idle boundary: no live turn token, stream, or
queued, parked, provider-held or budget-held continuation, even when status
already reads `idle`. Only terminal refusal can recover its own ending turn before token release.
Exhaustion requires full logical quiescence and declines while a stream is
active: a terminal 400 on an active stream stops immediately for manual repair,
without mutation or retry. It does not wait for teardown or defer quarantine;
no exact failed-request branch and carried-set witness survives there. Both
require settled guard work. This is a known-writer boundary,
not a promise that arbitrary future modules cannot append a result. Dendrite
held result mail is not itself a stored `tool_result` endpoint.

A refused reply is excluded from planning only after its whole body is verified
tool-free. Unsupported, empty, or cap-exhausted attempts do not remove that
reply, remove either endpoint, add a marker, count a successful step or enqueue
a rewind retry. Existing confirmed step counts and marker state are left
unchanged on exhaustion decline/cap/failure. Automatic refusal rewind instead
ends its attempt on give-up and resets its budget for a later independent wake,
without queuing a retry; the durable marker remains, but the episode count
is cleared. A missing, hidden, branched-away or non-tail marker also starts a
fresh count instead of editing an old prefix. `/unstick` preflight declines before opening a session or
queuing its initial probe. Supported probes re-plan at actual refusal. Later
unsupported forced recovery ends as `gave-up`, with the logged bounded reason;
it does not claim `cleared`. The exhaustion caller requests manual repair.

## Failure and transaction boundary

Only confirmed removals count. Throwing CM writes are read back, not replayed.
Even a confirmed post-commit removal stops automatic retry, since notifications,
refused-reply cleanup and the consolidated marker are separate operations.
Unknown/partial readback, a branch change, failed cleanup, or a failed marker
also stop. A forced outcome still reports a confirmed removal if cleanup then
fails. Legacy markers truthfully say that originals were removed from raw history. No crash-atomic cross-write counter/marker guarantee is made.

No durable wake fence is added: an independently triggered later wake can
resubmit unchanged unsupported history. No cap bypass, provider changes,
malformed-history repair, storage format or CM API is part of this change.

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
| Gap scan requires implementation-specific content getter read counts | Retired with the backward pairing walk; bounded snapshot body scan replaces it |
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
   exclusive maintenance process use CM's whole-body `retractRows` on the
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
a cleanup/marker failure. A marker also describes the current window mode; it
is not a per-step raw-retention audit if modes change mid-episode. Consult the
backed-up store and failure logs for repair, not the marker alone. Forced-session
failure summaries report a stopped, unverified recovery and confirmed removals;
the bounded stop reason is in the host log.
