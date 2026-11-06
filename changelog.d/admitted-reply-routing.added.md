- Optional host `replyAuthority` separates automatic publication from required
  inbound admission and waking. An admitted channel/push item may carry a frozen,
  registered destination or stay private with an agent notice; missing, invalid,
  timed-out or denied routes never refuse admission. Direct inference keeps its
  JSON-RPC response path. Pushes need no channel or publishable route.
- Causes for the same destination can share a turn only while every original
  cause still authorizes it at send time. Work survives holds, retries and
  continuations; mismatched/stale authority never falls back. Coordinator/tool
  locus changes and announcements cannot redirect the binding. Explicit send tools
  remain separately authorized (prose `>>`/`>>>` envelopes still require the binding), and unconfigured connections are unchanged.
- Stale reply continuations clean up their logical turn, guard and waiter;
  token release stays frame-owned. Reply-deferred waits retain existing stale
  diagnostics. No thread transport, typing, replay or recovery contract is added.
- Destination-less reply work resumes its own in-turn continuations by binding
  identity and turn ownership, without gaining automatic publication authority
  or joining work for an approved destination.
- Exhausted-turn re-arms retain admitted work but drop the ended turn owner.
  Private work has no guessed publish-tool default. Mixed bound/unbound debounce
  batches preserve their wake/context but prohibit automatic reply as a whole.
- Reply deadlines check elapsed monotonic time; timeout/overload diagnostics share
  the bounded failure window. Admission setup errors identify their server.

- Pin reply authority separately from the original transport configuration,
  preserving its identity and dial-token redaction, including reconnecting stubs.
