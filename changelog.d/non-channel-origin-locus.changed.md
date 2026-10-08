- **Residents operated from WebUI/TUI/CLI/headless/API while also present in
  channels:** a turn triggered from a non-channel surface no longer infers a
  channel locus (home, active, or process-global last-inbound). Plain prose on
  such a turn stays with the surface that triggered it; reaching a channel
  requires an explicit send tool. Channel-triggered and heartbeat turns are
  unchanged. Closes the case where a private WebUI reply was published to the
  Discord channel that last spoke.
