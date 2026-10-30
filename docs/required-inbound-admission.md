# Required inbound admission

`McplServerConfig.inboundAdmission` explicitly enables fail-closed host admission.
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
rebound. Required backlogs drain one complete data handler at a time in arrival
order, including every item of a channel batch. A flush waits for any pre-pause
callbacks still occupying all admission slots instead of refusing held work as
overload. New data arriving during the drain joins the same bounded hold buffer;
control traffic and RPC responses remain live. A slow handler delays later held
data, and time waiting in the hold buffer is outside the admission timeout.

Without a backlog, independently sent live items still run admission concurrently:
callback latency can reorder them. Items within a channel batch remain sequential.
A pause during a running preflight still refuses that item.
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

Required `channels/incoming` items and `push/event` requests carrying `coalesce`
are refused with `admission_unsupported`, before the hook, dedup or acceptance.
This profile does not promise durable coalesced acceptance until current-key
re-admission of restored and prior-epoch batches exists. Unconfigured coalescing
and its pending batches still survive reconnect/recovery unchanged. Drain pending
coalesced work before enabling this profile on an existing configured binding.

The channel adapter checks actual registration before preflight and rechecks the
entry, connection, epoch, readiness and grant afterward. No effect runs on a
refusal. `mayWake: false` skips wake policy and caps downstream wake requests;
`mayWake: true` does not override gate declines: their decision remains visible,
but a module may request inference just as on an unconfigured connection. The cap
is only `mayWake: false`. It is **not** context-only delivery and does not suppress existing open/locus
maintenance. Pushes run preflight after feature authorization, before deduplication,
notices or queueing. Inference requests run admission after feature and loop checks, before model
resolution; false `mayWake` is `admission_denied` and sends no chunks.
Pending inference admission belongs to the request lifetime: stop cancels it and
answers once with the existing stopped-request error while the transport is live.
Transport closure cancels it without a router answer. Both release the admission
slot even if the callback ignores cancellation; late verdicts start no model call.
While the initialize reader is installed, required data-lane requests receive
JSON-RPC -32002 `capability_denied` (notifications are discarded); this is the
handshake capability refusal, before an admission key exists. Malformed lines
use the normal decoder. Once initialize settles, subsequent lines are buffered
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
