- A debounced (batched) gate wake that contains an addressed message —
  mention, reply, or DM — now routes the turn's plain speech to that
  message's channel, the same rule the direct wake path already applies.
  Previously a batched wake carried no channel and fell back to the
  process-global most-recent-inbound channel, so ambient traffic elsewhere
  in the debounce window (or before a DM, which never updates that
  fallback) received the reply. Push events are mapped to their registered
  composite channel id via a new `EventGate` option `resolveRouteChannel`
  (the framework supplies it); batched-wake lines now show that id instead
  of the adapter's raw one. Ambient-only batches keep the legacy fallback.
