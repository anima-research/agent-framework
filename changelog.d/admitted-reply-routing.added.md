- Optional host `replyAuthority` separates automatic publication from required
  inbound admission and waking. An admitted channel/push item may carry a frozen,
  registered destination or stay private with an agent notice; missing, invalid,
  timed-out or denied routes never refuse admission. Direct inference keeps its
  JSON-RPC response path. Pushes need no channel or publishable route.
- Causes for the same destination can share a turn only while every original
  cause still authorizes it at send time. Work survives holds, retries and
  continuations; mismatched/stale authority never falls back. Coordinator/tool
  locus changes and announcements cannot redirect the binding. Explicit sends
  remain separately authorized, and unconfigured connections are unchanged.
- Stale reply continuations clean up their logical turn, guard and waiter;
  token release stays frame-owned. Reply-deferred waits retain existing stale
  diagnostics. No thread transport, typing, replay or recovery contract is added.
