- An MCPL server that reconnects now has its channel registration accepted.
  A reconnect resets the server's grant, and its traffic used to reach
  admission before the host's new §5.3 policy Request was answered: a
  `channels/register` sent right after initialize, as chat bridges do, was
  refused (-32002) and never replayed, so the route's incoming messages
  stayed unknown channels until the server registered again. A reconnect now
  holds control traffic as well as data until the new grant is established,
  as initial connect already did, both for a connection that was open and
  for one whose first connect had failed. It holds them whatever gate
  completes meanwhile, though each gate's completion opens every
  connection's planes: startup's staged open, a quiesce resume, an awareness
  sync, or another server's list change or reconnect. A runtime connect
  holds its planes the same way, through its awareness accounting too, and
  runs its exchange only on the transport it registered: if a reconnect
  replaced that transport meanwhile, the reconnect's exchange covers the new
  one, and the server is announced once.
- A policy answer that arrives after its transport closed grants nothing,
  whether to the initial policy Request or to one after a manifest change,
  and a manifest fetched from a transport that has closed isn't installed,
  nor a refresh queued on it run on the next one. A queued refresh's receipt
  reports the domains of the announcements it coalesced on its transport,
  each once, and the refresh limiter is kept per connection, so a connection
  that replaces a removed server under its id starts its own, where a timer
  of the removed connection could drop its replacement's queued refresh. A
  reconnect is still announced (`mcpl:server-reconnected`, `module:added`)
  once its attempt has settled, granted or not, and now also when another
  gate replaced its own before the awareness drain ended, where it used to
  go unannounced. A connect or reconnect whose transport drops before it's
  announced isn't announced: the close has reported the server gone
  (`module:removed`), and the next reconnect, if one comes, announces it.
  For a host that lists modules from the trace: a server whose first connect
  failed is added (`module:added`) once, by the first reconnect that's still
  connected once its attempt settles, granted or not, where it used to be
  added also when startup or a runtime connect registered it, and one that
  never connects isn't added. What a server sent about its own process that
  is still held when its transport closes, such as a request, a
  `tools/observe` filter or a channel registration, is dropped rather than
  admitted under the next transport's grant: the next process announces its
  own. So is such a message read from the transport after it closed, as can
  happen when a process a stdio server started still holds its stdout, until
  a reconnect attempt, if one comes, closes the transport's reader. A
  response read then is matched against none of the connection's requests,
  since the next transport numbers its own afresh, and, as any late answer,
  is surfaced as an orphaned response if it carries state, which waits, as
  the host's other reports do, for the control plane to open. A connection
  closed for good as its transport closes, by the host's close of a live
  connection or a drop with reconnect off, drops and logs the incoming
  messages and pushes it still holds then, and every request or notification
  it reads late, since no grant will come. Incoming channel messages and
  pushes still held, or read from the transport after it closed, are kept
  and admitted under the next grant, since a bridge that recorded them as
  forwarded won't send them again, and they stay held while no transport
  serves, even when a gate readies every connection meanwhile; the host's
  own reports about the transport, such as a `connect-failed`, go on.
  Requests kept this way don't count against the 10,000 held requests a
  server may have waiting, since no server waits on their answers any more:
  they have a bound of their own, the same 10,000, past which one is dropped
  and logged, so a dead process's backlog doesn't refuse the next process's
  requests. A channel registration the next process sends while they are
  still held is admitted ahead of them, so a kept message isn't refused as
  an unknown channel, unless it names a channel that an earlier removal, or
  an earlier registration kept in place, names: then it's kept in place too,
  so the writes to one channel stay in order. A removal stays where it was
  held, with whatever else it adds or updates, so when both planes open
  together, what the next process sent before one is admitted before it.
  While the host is quiesced its control plane opens first, so a removal is
  admitted then, ahead of the incoming messages still held, as live traffic
  is during a quiesce, and a message held for a channel it removed is
  refused when the data plane opens. A registration that arrives once the
  kept messages are admitted is too late for them, and a kept message for a
  channel the registry doesn't know is refused. An answer to a request from
  a closed transport is never written to the next one, whether the request
  was still held or its listener was still working when the transport
  closed, and neither is a streamed inference's chunk. A bridge that sends a
  kept incoming message again after reconnecting, because it hadn't recorded
  it as forwarded, can have it admitted twice; discord-mcpl records a
  message as forwarded before it forwards it.
