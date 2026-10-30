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
startup. Ordinary transport failures retain the existing log-and-continue startup
policy and configured reconnect behavior; an unavailable connection admits nothing. Modern MCP connections reject this configuration before connecting.

`admit` receives a detached, deeply frozen raw lane item, its original connection
key and cancellation signal. It returns either `{ store: false, mayWake: false,
reason }` or `{ store: true, mayWake: boolean, replyIntent? }`. Reasons are the
closed `RefusalCode` union. Unknown members, accessors and inconsistent branches
are refused; neither metadata nor tags supply host authority. Optional intent
must pass the host validator. It remains private and non-authorizing: no reply
resolution, publication or persistence is added. Host modules can read the
envelope on admitted events; private means host-only, not hidden from host code.

Stamp support arrives with context-only delivery. This profile rejects a `stamp`
member; it reserves no metadata keys and changes no storage schema.

Initial bounds, open to maintainer review: `MAX_ADMISSION_TIMEOUT_MS = 60000`
and `MAX_PENDING_ADMISSIONS = 64`. Timeout must be an integer in 1..60000;
invalid configuration cannot start the connection. Each connection has its own
budget (including attestation/validation); overload returns `admission_denied`
without queueing. Channel-batch items run sequentially with independent deadlines.
Timeout aborts the signal and discards late results. Callbacks must cooperate with
cancellation, avoid framework mutation/reentrancy and protect their own external
effects. JavaScript timers cannot preempt a synchronous infinite loop or undo an
external write.

Required traffic is authorized before admission. Data received after initialize
is held during startup staging, policy exchange and quiesce just like unconfigured
traffic. At flush it is authorized against the current grant and admitted under
the current key. Superseded-epoch items are refused as `admission_stale`, never
rebound. A pause during a running preflight still refuses that item.
Required connections never advertise `toolHints`, even if `toolHints: true` is
configured. Under RFC-014 §6.3 the peer must not send hints and should tailor
its inventory to a hint-less host. No RFC-014 controller is installed by the
framework for these connections. Transport read taps and solicited `tools/*` /
`toolsets/*` result bookkeeping are not suppressed by admission.
Peers need no retry for host-internal staging or quiesce. A verdict is
not a delivery receipt: existing content checks and downstream failures still
apply; already admitted siblings are not rolled back.

The channel adapter checks actual registration before preflight and rechecks the
entry, connection, epoch, readiness and grant afterward. No effect runs on a
refusal. `mayWake: false` skips wake policy and caps downstream wake requests;
it is **not** context-only delivery and does not suppress existing open/locus
maintenance. Pushes run preflight after feature authorization, before deduplication,
notices, coalescing or queueing. Inference requests run admission after feature and loop checks, before model
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
Notifications have no wire receipt; no application status is sent for a refusal.

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
