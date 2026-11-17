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
raw history and other residents' windows untouched. Legacy recovery uses one
body-aligned contiguous raw removal, with the existing cross-window removal
semantics. A retained notice creates a hole: legacy recovery declines with no
writes, even after a failed initial write-down. It never forces conversion to
presented mode.

## Unsupported is not empty or repaired

Recovery deliberately declines corrupt/missing/duplicate/reused IDs,
incomplete rounds, mixed call/result bodies, intervening ordinary rows,
rewind markers, system changes, hidden non-tool shards, embedded system
notices, foreign context ownership and bodies not belonging to this reader's
native audience. A stored result absent the current presented window also
declines: CM 0.27 cannot retract it in the same atomic batch. **Uncarried**
means absent the served request; **unpresented** means absent the CM window.
Uncarried result bodies already resident in that window can be supported;
there is no present-first write, raw fallback, or new CM layer. It checks selected IDs in the full stored snapshot,
including newer skipped/held results, in both directions. It does not repair
unrelated malformed history or recursively close mixed chains.

The tool-result guard must have neither a pending batch **nor** queued
storage/annotation work, and no pending assistant round may remain. A standalone
attempt also needs the agent's idle boundary: no live turn token, stream, or
queued, parked, provider-held or budget-held continuation, even when status
already reads `idle`. Current terminal refusal/exhaustion handlers can recover
their own ending turn before its token is released; they still require settled
guard work. This is a known-writer boundary,
not a promise that arbitrary future modules cannot append a result. Dendrite
held result mail is not itself a stored `tool_result` endpoint.

A refused reply is excluded from planning only after its whole body is verified
tool-free. Unsupported, empty, or cap-exhausted attempts do not remove that
reply, remove either endpoint, add a marker, count a successful step or enqueue
a rewind retry. Existing confirmed step counts and marker state are left
unchanged on decline/cap/failure, not reset into a fresh automatic budget; a
non-refusal completion ends the episode. `/unstick` preflight declines before opening a session or
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
