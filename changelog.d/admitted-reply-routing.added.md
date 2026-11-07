- Optional host `replyAuthority` separates automatic publication from required
  inbound admission and waking. An admitted channel/push item may carry a frozen,
  registered destination or stay private with an agent notice; missing, invalid,
  timed-out or denied routes never refuse admission. Direct inference keeps its
  JSON-RPC response path. Pushes need no channel or publishable route.
- Causes for the same destination can share a turn only while every original
  cause still authorizes it at send time. Destination-less causes with the same
  owner share one private turn. Work survives request holds, retries and
  continuations, including prose-bounce and wake-onboarding; tune-out aggregate
  release/reader wakes are explicitly private on opted-in hosts, not reconstructed
  from stored rows. Mismatched/stale authority never falls back on opted-in peers. Coordinator/tool
  locus changes and announcements cannot redirect the binding. Explicit send tools
  remain separately authorized (prose `>>`/`>>>` envelopes on opted-in peers still
  require the binding), and unconfigured connections are unchanged. In `locked`
  mode the lock remains the target: an opted-in lock requires matching authority
  and explains a mismatch before inference; a non-opted-in lock keeps posting.
- Stale reply continuations clean up their logical turn, guard and waiter;
  token release stays frame-owned. Reply-deferred waits retain existing stale
  diagnostics. No thread transport, typing, replay or recovery contract is added.
- Destination-less reply work resumes its own in-turn continuations by binding
  membership in the turn's original work set and turn ownership, without gaining automatic publication authority
  or joining work for an approved destination.
- Exhausted-turn re-arms retain admitted work but drop the ended turn owner.
  Private work has no guessed publish-tool default. Mixed bound/unbound debounce
  batches preserve their wake/context but prohibit automatic reply as a whole.
- Reply deadlines check elapsed monotonic time after resolution and authorization;
  timeout/overload diagnostics and fixed-code `reply:private` traces share
  the bounded failure window. Admission setup errors identify their server.

- Pin reply authority separately from the original transport configuration,
  preserving its identity and dial-token redaction, including reconnecting stubs.
  Pinned callbacks keep the original authority object as `this`, supporting class
  instances. Publish-tool reply guidance appears only with a connected opt-in;
  unconfigured tool descriptions remain unchanged.
