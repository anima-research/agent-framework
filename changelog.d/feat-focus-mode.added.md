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
