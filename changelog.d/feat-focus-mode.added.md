- `focus` tool (opt-in via `FrameworkConfig.focus.enabled`): the primary
  resident narrows attention to one channel for a bounded time. Every other
  channel and DM is held — stored with `metadata.focusHeld` and excluded from
  the resident's view, never woken on, and dropped by the wake gate before
  any debounce policy can batch it. Addressed messages elsewhere get one
  host-authored automatic reply per (channel, author) per epoch. Focus ends
  on `mode: "end"`, at its deadline (durable across restarts), or when an
  expired epoch is found at boot; ending delivers a per-channel
  `<focus-backlog>` of the newest `backlogCap` held messages and points at
  the resident's actual history/backscroll tools for the rest. `mode:
  "check"` reports held counts (and peeks one channel) without ending;
  `enter` while focused re-targets, delivering the new channel's backlog.
- While focused, plain speech lands in the focus channel: it outranks the
  trigger channel and the global most-recent-inbound fallback for every
  turn, a successful `enter` moves the current turn's prose there too
  (announced in the tool result), and held inbound neither retargets the
  fallback locus nor qualifies for the mid-turn addressed re-pin.
- Review hardening: channel identity is `(serverId, channelId)` throughout
  (hold, gate, `enter` with an optional `serverId`, server-qualified
  autoreply publish); the gate keeps each queued event's metadata so the
  focus-entry purge, delivery-time re-check and live evaluation derive a
  push event's channel identically; a held message never reaches a live
  turn through the mid-turn deferred injection; held messages still deferred
  behind the current turn are part of the unfocus backlog, and a deferred
  focus dump makes the deferred queue durable so a crash cannot lose it; the
  autoreply speaks only in channels the resident is open in and in DMs, and
  a failed publish releases the per-author allowance; channels under
  tune-out are left to the subconscious (and cannot be focused); the tool is
  not offered under per-channel conversation routing; a persisted epoch
  still ends at boot after `focus.enabled` is turned off; configured maxima
  are floored/capped integers; media blocks are named in the dump.
  Speech under focus is routed server-qualified (a same-id channel on
  another server cannot receive it); automatic replies that published are
  recorded in the lifecycle log, so once-per-author survives a restart and
  a failed publish is retried, and a publish settling after its epoch ended
  touches nothing; a held message awaiting its dump counts as unread for
  event coalescing (an edit replaces it in place); wakes already queued for
  a channel are dropped when that channel becomes held.
