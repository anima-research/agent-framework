- Words for a channel that its server registered again or retargeted after
  the publish's last wait, as it can while the channel's opening is
  announced, were published before anything had confirmed the new
  registration or target open. They now wait for that queued lifecycle
  work, as they wait for any channel's, and go out only into the channel it
  leaves open. If it leaves none open, nothing is published, and the failure
  reads as at the first wait. A close decided in that window, where the
  host directs the server's lifecycle, now stands, as one decided while the
  words wait already does.
- A `channels.publish` grant withdrawn while the words wait now holds for
  them too: the check just before the publish reads the grant as it is
  then, and refuses as the check before the waits does.
- On a server whose channel lifecycle the host doesn't direct (no
  `channels.lifecycle` grant), a channel decided closed no longer refuses
  words that waited for queued lifecycle work: the host can't close it, so
  they go into its open transport, as they already did when nothing was
  queued.
- Words for a channel whose registration is no longer marked open, with no
  lifecycle work queued for it, are now refused where they used to be
  published. That happens, for example, when a server answers an open of
  the channel for another one. On a server without `channels.lifecycle`,
  words for a retargeted channel are refused the same way, unless the
  server's traffic has confirmed the new target open first.
