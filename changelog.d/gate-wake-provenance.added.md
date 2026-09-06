- Gate-requested wakes (`gate:debounce`) carry provenance: the EventGate hands
  the framework the newest channel-bearing event's channel id and its author
  as an adapter-namespaced counterparty (`<adapter>:user:<id>`), from the same
  event, so the turn's `InferenceRequest` — and any telemetry stamped from it —
  names where and by whom the agent was woken instead of just `gate`. Ids
  only; wakes without a channel event carry nothing.
