- **Inbound source envelope.** Every inbound item the host accepts now carries
  `metadata.inboundSource`, stamped once where it was accepted: the
  conversation it belongs to (`channel`: MCPL server, endpoint binding,
  canonical channel id, thread, message, reply edge and the channel's label at
  receipt; `unscoped` for a push that names no channel; `surface` for console
  or API input from a module), the host acceptance time and the adapter's own
  timestamp. It covers `channels/incoming` and `push/event` on both the
  ordinary and the RFC-006 coalesced paths; a coalesced occurrence freezes its
  envelope at acceptance, so deferral, fan-out and replay deliver it unchanged
  and a later rename never rewrites it. Adapter-supplied metadata cannot set
  the field (an adapter's own `origin.source` string is untouched).
  `readInboundSource`, `conversationKey` and `INBOUND_SOURCE_KEY` are exported.
- **Inbound source envelope: admission facts.** An ordinary `channels/incoming`
  message or `push/event` now has its envelope frozen at admission, before it
  is queued or acknowledged, so a rename or rebind while it waits cannot
  change it. Every channel and unscoped envelope names the admission `lane`
  (`channels/incoming` or `push/event`) and whether it came through RFC-006
  coalesced admission (`coalesced: true`): facts a consumer needs to know what
  an `eventId` is worth. `readInboundSource` validates every field it returns.
