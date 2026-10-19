- Where `fetch_reference` refused a reference from an MCPL server the host
  doesn't connect to over a network, such as a stdio server, as
  `unknown server: <id>`, it now says `this host doesn't connect to the
  "<id>" server over a network, so there's nowhere to fetch it from`. A
  server the host spawns from a command has no address either,
  even when its config also holds a `url`, on whose origin its references
  used to be fetched; nor has a WebSocket server whose `url` the transport
  won't dial: one that isn't a `ws://` or `wss://` url, or that has a
  fragment. A WebSocket server whose `url` has a fragment, which the `ws`
  library refuses to dial, now fails to connect with the transport's own
  error naming the fragment. `save_recent_image` now gives the reason a
  `fetch_reference` call naming no `max_bytes` would be refused with before
  dialing, and points at `fetch_reference` only where that fetch would go
  ahead. The eager fetch of the references in the result of an MCPL tool
  call the agent makes no longer spends one of its slots on a reference the
  fetch would refuse before dialing, such as one from a server whose fetch
  budget is spent, though it still joins a fetch of a reference already
  under way.
