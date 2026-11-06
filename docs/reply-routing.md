# Admitted automatic replies

Admission and waking remain those of [required inbound admission](required-inbound-admission.md).
Permission to publish an automatic reply is separate. An admitted item may
carry one host-approved, registered channel destination, or be definitively
private. No channel or publishable route is required to admit or wake an item.

## Opt-in host authority

Configure `McplServerConfig.inboundAdmission` first, then optionally:

```ts
replyAuthority: {
  timeoutMs: 1000,
  resolve: ({ connection, lane, item, replyIntent, signal }) => {
    // Validate opaque intent against host policy; return one registered
    // channel on this connection, or null when no unique route is approved.
    return approvedChannel(replyIntent, connection, signal);
  },
  authorize: (input, destination) => {
    // Cheap, synchronous, no I/O. Only literal true permits publication.
    return stillApproved(input, destination);
  },
}
```

`resolve` returns `{ channelId }` or `null`. The framework supplies `serverId`
from the original connection key and freezes the destination. Channels may
represent registered thread channels; there is no new thread field, transport
profile, capability negotiation or initialize extension in this feature.
Opaque `replyIntent`, metadata, prose and persisted rows cannot mint authority.
The reply callbacks and deadline are snapshotted once before the initial dial or
spawn, including for a reconnecting stub. This separate snapshot does not wrap or
replace the transport configuration: its identity and credential-redaction state
remain shared with the framework.

Required inbound admission completes first, under its unchanged timeout,
cancellation and pending-slot rules. Only after a fully validated store-and-wake verdict does
this feature resolve a channel/push reply binding. It has its **own** required
deadline
(`timeoutMs`, integer 1..60000), AbortController, and cap of 64 pending
resolutions per connection. No turn can wake or publish with an unresolved
binding: resolution finishes, or becomes definitively private, before delivery
to the existing wake path. Admission/storage rules remain unchanged; reply
authority only decides the private publish binding. Sequential channel batches
and held backlogs also wait for each channel/push item's reply resolution: their
per-item latency includes both admission and reply deadlines (roughly
`inboundAdmission.timeoutMs + replyAuthority.timeoutMs` in the worst case).
Direct inference does not add a reply-resolution wait. Routing can delay delivery by its bounded wait,
but cannot turn route failure into an admission refusal.

Null, malformed output, a throw, timeout, overload, denied approval or an
unavailable destination means **admitted and wakeable as before, but private**.
Automatic prose remains in context/archive and a readable agent notice explains
that no unique currently approved destination exists and explicit send tools
remain available. Private work has no inferred locus or default for `channel_publish`;
name an explicit destination when using a separately authorized send tool.
Callback exceptions, timeout and overload produce a fixed, bounded diagnostic at
most once per 60 seconds per connection while the fault persists. Consumer and
authority faults, timeout and overload share this monotonic-clock window, including across reconnects. Exception
content is never included in agent context.
Cancellation aborts resolution; late results are discarded. The admission layer's
existing final current/epoch/registration checks still govern stale ingress. Callbacks must
honor cancellation, avoid reentering ingress, and have no external side effects;
cancellation cannot undo host callback effects.

Read-only admission does not invoke the resolver. `inference/request` keeps
its JSON-RPC response path and does not resolve a channel reply destination.
Pushes need neither a channel origin nor a publishable route.

## Shared turns and send-time checks

Every admitted cause retains private work identity through queues, holds,
retries and continuations. Equality and parked-request keys distinguish
connection incarnation, channel and work identity; opaque separators cannot
collapse them. Causes for the same frozen destination can share a turn, retaining
**all** their work. Different destinations get separate turns; incompatible or
missing authority can only keep prose private, never select a new destination.
A debounce batch mixing bound and unbound causes stays **private as a whole**:
its wake and full context remain, but only separately authorized send tools may
publish from it. All-bound and all-unbound batches retain their existing behavior.

Each original cause must still authorize that same destination at send time.
`authorize` runs at binding and immediately before automatic open/send effects;
connection incarnation, registered descriptor identity and the current publish
grant are also rechecked after waits. If any cause loses approval, the shared
turn's prose stays private with a notice. The resolver is not called again and
there is no fallback to a home, locus or latest inbound destination on an opted-in connection.
In `locked` prose mode the lock remains the target: a lock on an opted-in
connection requires a current matching binding (otherwise prose stays private
and the agent is told why). A lock on a connection without `replyAuthority`
keeps posting as before, even when another connection woke the bound turn.
Destination-less admitted work remains private in locked mode too.

The logical turn owns in-turn continuations (setup retries, tool waits, budget
restarts and provider holds). Exhausted-turn re-arms, post-turn continuations and rewind retries carry
the same work into a fresh logical turn without retaining the ended turn id.
Destination-less work can resume its own turn only with the same private binding
and matching owner; it cannot join a destination-bearing turn or gain permission
to publish.
Stale in-turn continuations are dropped and their logical turn/guard/waiter
cleaned up. Token release stays frame-owned, as on the existing drop path.
An unrelated wake cannot borrow an open turn's binding. Reply-deferred waits
retain the existing stale-diagnostic threshold, throttle and quiesce suppression.

Coordinator and agent-tool locus changes cannot redirect an admitted turn.
Automatic sleep announcements use its frozen binding or fail closed. Explicit
send tools keep their chosen targets and their existing, separate authorization;
they neither require nor inherit automatic-reply authority. Prose envelopes
(`>>` in explicit mode, `>>>` in hybrid mode) are still automatic speech, not
send tools: on an opted-in connection they cannot override a binding, and
unbound envelopes aimed there fail closed. Connections without `replyAuthority`
keep their existing automatic envelope routing. For a different destination or an unbound turn,
use a separately authorized send tool, for example `drafts(action: "resend", ...)`;
`>>#channel {{unsent}}` cannot bypass these checks.

Opting in also refuses unbound automatic prose aimed at that connection (for
example timer, home, or heartbeat prose or an unrelated module wake). Such prose gets
a private failure notice, not a guessed destination. Module wakes caused by an
admitted channel/push event carry only that event's existing private work;
`mayWake: false` still forbids direct event/module wakes. Stored held work may
still contribute to a later tune-out reader cadence wake (the admission guide
describes that existing limit). Check existing unbound-post dependencies
before opting in. Wakes carrying private admitted work are also exempt from the
redundant-wake drop based on deferred/stored-message read and publication
watermarks: those watermarks cannot discard an admitted cause or its authority,
even if an unbound wake for the same write would already be satisfied.
Connections without `replyAuthority` retain existing admission and routing
behavior, including existing automatic routing.

Silent starts retain the existing owner/latest-routing resume boundary; the
regression test adds no recovery or simultaneous-start contract. Typing/status
ownership, durable classification, context-only wire delivery, connector
adapters and live deployment are outside this feature. `mayWake: false` is not
a context-only effect bundle.
