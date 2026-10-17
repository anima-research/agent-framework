- An MCPL server that reconnects now has its channel registration accepted.
  A reconnect resets the server's grant, and its traffic used to reach
  admission before the host's new §5.3 policy Request was answered: a
  `channels/register` sent right after initialize, as chat bridges do, was
  refused (-32002) and never replayed, so the route's incoming messages
  stayed unknown channels until the server registered again. A reconnect
  now holds control traffic as well as data until the new grant is
  established, as initial connect already did, both for a connection that
  was open and for one whose first connect had failed, and even when
  startup or a quiesce resume opens every connection meanwhile. A runtime
  connect holds its planes the same way.
- A transport that drops during that policy exchange no longer has its
  planes opened or is announced as reconnected (`mcpl:server-reconnected`,
  `module:added`): its planes stay closed until the next transport's
  exchange settles, and an answer that arrives after its transport closed
  grants nothing. What a server sent about its own process that is still
  held when its transport closes (a request, a `tools/observe` filter, a
  channel registration) is dropped rather than admitted under the next
  transport's grant: the next process announces its own. Incoming channel
  messages and pushes still held are kept and admitted under the next
  grant, since the next process won't send them again. A channel
  registration the next process sends while they are still held is
  admitted ahead of them, so a kept message isn't refused as an unknown
  channel, up to the first `channels/changed` it sends that removes a
  channel: nothing passes a removal, so when both planes open together,
  what the next process sent before one is admitted before it. While the
  host is quiesced its control plane opens first, so a removal is admitted
  then, ahead of the incoming messages still held, as live traffic is during
  a quiesce, and a message held for a channel it removed is refused when the
  data plane opens. A registration that arrives once the kept messages are
  admitted is too late for them, and a kept message for a channel the
  registry doesn't know is refused. An answer to a request from
  a closed transport is never written to the next one, whether the request
  was still held or its listener was still working when the transport
  closed. A `close()` during a reconnect's handshake now closes the new
  transport instead of adopting it.
