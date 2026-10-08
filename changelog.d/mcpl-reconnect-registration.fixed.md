- An MCPL server that reconnects now has its channel registration accepted.
  A reconnect resets the server's grant, and its traffic used to reach
  admission before the host's new §5.3 policy Request was answered: a
  `channels/register` sent right after initialize, as chat bridges do, was
  refused (-32002) and never replayed, so the route's incoming messages
  stayed unknown channels until the server registered again. A reconnect
  now holds control traffic as well as data until the new grant is
  established, as initial connect already did, both for a connection that
  was open and for one whose first connect had failed, and even when
  startup or a quiesce resume opens every connection meanwhile.
