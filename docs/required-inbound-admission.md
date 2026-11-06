# Required inbound admission

`McplServerConfig.inboundAdmission` explicitly enables fail-closed host admission
through `AgentFramework` only. Direct `McplServerConnection` factories reject this
option: raw event listeners do not install the framework's authorized lane adapters.
Unconfigured connections retain their existing dispatch, holding, hint taps and
wake policy: there is no default allow hook or new asynchronous preflight.

The host supplies `timeoutMs`, `bind(connection)` and `isReplyIntent(value)`.
The binder must return `{ connection, admit }` using the exact issued key. It runs
after initialize/optional attestation and again on every reconnect. Keys contain
a framework-issued instance token and transport epoch, not merely a server id.
A missing/wrong binding fails connection setup and aborts framework startup;
removing it never disables the requirement. Attestation refusal likewise aborts
startup, including when handshake cleanup also fails (the admission error remains
in the cause chain). Ordinary transport failures retain the existing log-and-continue startup
policy and configured reconnect behavior; an unavailable connection admits nothing. Modern MCP connections reject this configuration before connecting.

`admit` receives a detached, deeply frozen raw lane item, its original connection
key and cancellation signal. It returns either `{ store: false, mayWake: false,
reason }` or `{ store: true, mayWake: boolean, replyIntent? }`. Reasons are the
closed `RefusalCode` union. Unknown members, accessors and inconsistent branches
are refused; neither metadata nor tags supply host authority. Optional intent
must pass the host validator. It remains private and non-authorizing: no reply
resolution, publication or persistence is added. Host modules can read the
`AdmittedEnvelope` via the exported read-only `admissionOf(event)` accessor
(`undefined` for unconfigured events); private means host-only, not hidden from host code.

Stamp support arrives with context-only delivery. This profile rejects a `stamp`
member; it reserves no metadata keys and changes no storage schema.

The package also exports `AdmissionConnectError` for direct setup failures
(wrapped cleanup failures retain it in `cause`) and these initial bounds, open to
maintainer review: `MAX_ADMISSION_TIMEOUT_MS = 60000`
and `MAX_PENDING_ADMISSIONS = 64`. Timeout must be an integer in 1..60000;
invalid configuration cannot start the connection. Each connection has its own
budget (including attestation/validation); overload returns `admission_denied`
without queueing. Channel-batch items run sequentially with independent deadlines,
so a whole batch can take roughly its item count times `timeoutMs`.
Timeout aborts the signal and discards late results. Callbacks must cooperate with
cancellation, avoid framework mutation/reentrancy and protect their own external
effects. JavaScript timers cannot preempt a synchronous infinite loop or undo an
external write.

Required traffic is authorized before admission. Data received after initialize
is held during startup staging, policy exchange and quiesce just like unconfigured
traffic. At flush it is authorized against the current grant and admitted under
the current key. Superseded-epoch items are refused as `admission_stale`, never
rebound. Required backlogs drain one admission and its synchronous dispatch/storage
effects at a time in arrival order, including every item of a channel batch. A held
inference releases the drain after provider dispatch, not after the model finishes;
its handler still owns cancellation, failures and the eventual reply. A held
inference backlog reaches the provider concurrently (one call per held item, as
on the unconfigured path), because the drain releases at dispatch. A flush waits for any pre-pause
callbacks still occupying all admission slots instead of refusing held work as
overload. New data arriving during the drain joins the same bounded hold buffer;
control traffic and RPC responses remain live. Time waiting in the hold buffer is
outside the admission timeout. While a backlog drains, required data (held and
newly arriving) is admitted one at a time, so sustained ingress above roughly one
item per callback latency accumulates and is dropped/refused at the existing hold
bounds. A bounded-concurrency ordered drain is a possible follow-up, at the
maintainer's discretion; it is not implemented here.

Without a backlog, independently sent live items still run admission concurrently.
Non-coalesced items can complete in callback-latency order. Coalesced effects
instead take a per-subject ordering ticket on arrival, before the callback, keyed
by `coalescingSubjectKey(serverId, binding, scope, key)`. Channel deliveries and
channel-scoped pushes share that queue: a later verdict waits for earlier tickets
for the subject to retire, including refusals. Channel batches reserve all their
tickets on arrival and still admit siblings sequentially. Independent single-item subjects do not wait on one another's callbacks.
Batch siblings remain sequential: reserving B behind a slow sibling A also delays
later traffic for B. Outstanding coalescing tickets are capped at 64 per server id (spans reconnects);
excess fresh occurrences refuse without joining the subject queue, after live receipt lookup.
A withdrawal may take one over-cap ticket per subject with a live occupant or
pending coalesced work/ticket; it still waits behind that subject's create and
uses the ordinary per-connection admission budget. Unknown-subject withdrawals
and additional over-cap withdrawals for the same subject refuse at the cap. A pause or grant change during a running preflight invalidates it even if restored before the verdict.
Required connections never advertise `toolHints`, even if `toolHints: true` is
configured. That explicit combination logs one diagnostic at connect (not on
automatic transport retries); it is not a configuration error. Under RFC-014 §6.3 the peer must not send hints and should tailor
its inventory to a hint-less host. No RFC-014 controller is installed by the
framework for these connections, so they carry no RFC-014 toolset presence. The
generic transport result tap is preserved; the framework does not use it for
`toolsets/*` state on required connections.
Peers need no retry for host-internal staging or quiesce. A verdict is
not a delivery receipt: existing content checks and downstream failures still
apply; already admitted siblings are not rolled back.

Single, non-deferred `channels/incoming` items and `push/event` requests carrying
`coalesce` go through the admission callback, preserving the RFC-006 subject key.
Each edit/delete stands on its own verdict: an approved edit replaces an admitted
unread create for that key, and an approved withdrawal removes it. A refused
replacement leaves the original untouched. Without an unread target, RFC-006's
ordinary no-target handling applies: an approved edit is its own delivery, and
an empty deletion is a no-op. A refused create leaves no stored content, subject
or receipt for later replacement to revive; an independently approved edit never
recovers that refused content. This also applies to never-seen subjects and
already-read or prior-epoch creates. No per-key refusal history is retained.
The verdict is checked again against the current connection, epoch, grant and
channel registration at the coalescer's first effect, after waiting for its lock.
Its private envelope, including the wake ceiling, follows the admitted delivery.

RFC-006 retries are not new admission decisions. On either lane, an occurrence
with a live receipt for the same server, binding and `eventId` returns its original
accepted result without invoking the callback or repeating content effects. A
receipt created while another callback is running also takes precedence over
that callback's refusal or stale verdict; the mutex recheck cannot turn already
admitted work into a refusal. Only admitted work creates receipts. Refusals do
not reserve an `eventId`, and once the receipt window expires an item goes through
admission again. Receipt replay retains the durability barrier: an acceptance
whose acknowledgement failed must still be persisted/committed before replay
can succeed.

Multi-item `channels/incoming` requests remain itemwise, sequential admissions,
including coalesced items; they are not an atomic batch. Required connections
omit `eventCoalescing.deferred` from their initialize offer while retaining the
other coalescing members, so producers can select their non-deferred fallback.
As defence in depth, deferred `push/event` notices (`coalesce.deferred: true`)
still refuse explicitly with `admission_unsupported` before the hook, dedup or acceptance. Their later
`push/render` aggregates multiple occurrences, and this profile has no current-key
re-admission for restored or prior-epoch batches. Unconfigured coalescing and its
pending batches still survive reconnect/recovery unchanged. Drain pending
**deferred batches** accepted while unconfigured before enabling this profile on
an existing binding; ordinary coalesced creates, edits and withdrawals need no
such drain. Restored or prior-epoch deferred work cannot borrow a new admission
key.

The channel adapter checks actual registration before preflight and rechecks the
entry, connection, epoch, readiness and grant afterward. No effect runs on a
refusal. `mayWake: false` skips wake policy and caps downstream wake requests;
`mayWake: true` does not override gate declines: their decision remains visible,
but a module may request inference just as on an unconfigured connection. The cap
is only `mayWake: false`. It is **not** context-only delivery and does not suppress existing open/locus
maintenance.

Admitted work goes out with the round's results only on a stream that declares
`supportsInjectedMessages: true`; otherwise it arrives at turn end, except that a direct API boundary with no
stream drains deferred work immediately for the next compile.

For required coalesced traffic, built-in storage and the durable acknowledgement
do not await module `onProcess`. Module dispatch starts after acceptance and after
the lane's response is written or abandoned, and runs per channel (feature-set scope for plain pushes) in acceptance order (callback-completion order across subjects).
The exported ceiling `MAX_PENDING_REQUIRED_MODULE_WORK = 64` (equal to
`MAX_PENDING_ADMISSIONS`) bounds released queued **plus running** work at
reservation. Not-yet-released reservations are bounded separately at 64 per
scope, so a batch's own reservations do not count as module backlog for its
later siblings. Each batch is also bounded by its arrival tickets. Releasing a
batch can temporarily take released work over 64; total retained slots stay
bounded by the two allowances (at most 128). At either capacity, new deliveries refuse with
`admission_denied` before replacement, storage or acceptance receipt.
Withdrawals are never refused at the module cap: removal stands, and if the
withdrawal delivers a notice, only that notice's module work is dropped with
`mcpl:module-work-dropped`, count 1, reason `admission_module_capacity`.
No reservation exceeds either allowance at admission. Pure withdrawals deliver no module work.
The lane diagnostic/trace reasons `admission_ticket_capacity` and
`admission_module_capacity` distinguish the two bounds from policy denials;
both capacity refusals retain wire reason `admission_denied` (no wire schema change).
Receipt retries create no work and still replay at capacity, after current
authority (not the callback verdict or capacity) is checked under the mutex,
after its subject ticket is ready. The receipt stays pinned during that wait.
There is no wait for module space under the coalescer lock. A channel batch
releases its module work only after its batch response is written or abandoned; later accepted work in
the same scope cannot overtake that waiting FIFO position. Notifications release
module work at lane completion, without a response.

Stop and explicit disconnect discard not-yet-started module work, release queued
event references, and emit `mcpl:module-work-dropped` with count and fixed reason.
Transport close/reconnect preserve queued work for already-acknowledged content.
Accepted content remains stored. A running call is not cancelled: it stays
counted across epochs until it settles; completion cannot resurrect dropped work.
New work for the scope waits behind the running call and preserved queue.
A hung required-path module occupies one slot and eventually causes new
deliveries in its scope to refuse, rather than growing an unbounded backlog.
Module errors are contained; they never retract an acknowledgement.

**Shared coalescing limit:** required and unconfigured coalescing servers share
one host-wide coalescing chain/mutex. Unconfigured coalesced delivery retains its
existing completion timing and awaits module `onProcess` inside that chain.
A hung module on an unconfigured server's coalesced delivery can therefore stall
required coalesced effects too, eventually filling their ticket limit. Isolation
from such modules is not promised (existing main behaviour, out of scope).

Channel-scoped pushes also require the `channels.incoming` grant and a declared
channel before either receipt replay or the admission callback.
Pushes run preflight after feature authorization, before deduplication,
notices or queueing. Inference requests run admission after feature and loop checks, before model
resolution; false `mayWake` is `admission_denied` and sends no chunks.
Pending inference admission belongs to the request lifetime: stop cancels it and
answers once with the existing stopped-request error while the transport is live.
Transport closure cancels it without a router answer. Both release the admission
slot even if the callback ignores cancellation; late verdicts start no model call.
While the initialize reader is installed, required data-lane requests receive
JSON-RPC -32002 `capability_denied` with `data: { capability }`, naming
`channels.incoming`, `pushEvents` or `inferenceRequest` for the refused lane
(notifications are discarded); this is the handshake capability refusal, before
an admission key exists. Malformed lines use the normal decoder. Once initialize settles, subsequent lines are buffered
for ordinary dispatch, including a ping in the same read chunk.

Admission refusals after the handshake are itemwise channel results, push `{ accepted: false, reason }`
results, or inference JSON-RPC errors with code -32600 and the fixed reason.
Every admission refusal, including notifications, emits the lane's existing
rejection trace (`mcpl:channel-incoming-rejected`, `mcpl:push-event-rejected`, or
`mcpl:inference_fail`) with the fixed refusal code. Repeated diagnostic lines are rate-limited per server/lane/code at each refusal
boundary, with suppressed counts on the next line.
Neither payload nor callback exception text is logged. Notifications have no wire
receipt; no application status is sent for a refusal.

Optional `initializeAttestation: { read, matches }` checks detached initialize
result data, after protocol agreement but before initialized/capability use.
Missing, malformed or mismatched attestation fails with the fixed
`initialize_attestation_refused`, including with reconnect enabled. The host and
peer own the attestation format/authentication; this adds no wire offer or
universal identity field.

## Scope and protocol baseline

This admission profile requires no SPEC change. It uses the existing protocol
decoder and capability-grant implementation (`@animalabs/mcpl-core` 0.4.0 in the
repository development dependencies); a full MCPL pin follows separately.
Existing upstream connector-specific routing remains untouched to preserve
unconfigured behaviour; the new admission mechanism contains no connector policy.
Removing those older fallbacks requires a separate compatibility decision, not a
silent change in this opt-in profile.
