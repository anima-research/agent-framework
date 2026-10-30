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

Required traffic is authorized before admission. Before readiness it is refused,
not held; old-epoch traffic is never replayed. Required connections do not apply peer hints on pushes or standalone
`tools/hints`, or result-borne `mcpl/hints`. Result-borne hints are ignored
without losing the result.
Hinted pushes are unsupported and never reach the early tap. Standalone peer `tools/hints` is also refused before
the tap with `admission_unsupported` (JSON-RPC -32600 for requests); notifications
are discarded without changing toolset state or scheduling recovery. These restrictions apply only to this explicit profile.
The application's own solicited `tools/list` result is different: its completed
inventory still supplies tool presence and `mcpl/rev` because the application
asked for it, with no admission hook. A revision gap may trigger application-to-peer
`tools/list` / `toolsets/list` recovery. This is catalogue bookkeeping and list
recovery, not a wake, content delivery or stored data.
Peers must send after readiness or explicitly retry refused work. A verdict is
not a delivery receipt: existing content checks and downstream failures still
apply; already admitted siblings are not rolled back.

The channel adapter checks actual registration before preflight and rechecks the
entry, connection, epoch, readiness and grant afterward. No effect runs on a
refusal. `mayWake: false` skips wake policy and caps downstream wake requests;
it is **not** context-only delivery and does not suppress existing open/locus
maintenance. Push feature authorization precedes even the unsupported-hints refusal; the early
tap remains suppressed for every required push. Hint-free pushes run preflight
after feature authorization, before deduplication,
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
