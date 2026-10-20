- A channel the host knows only from a push event no longer counts as
  confirmed closed before anything has shown its state: after a restart, the
  server may still hold a channel an earlier process opened. Its traffic shows
  it open as before: where this host directs the lifecycle, once it's decided
  open or tuned out.
  - Where this host directs the channel's lifecycle, `channel_decline` in such
    a channel that isn't open sends its close through the lifecycle queue.
    Until now it sent nothing. Its answer is still `remained closed`.
  - Where this host directs the channel's lifecycle, `channel_close` of such
    a channel already decided closed, as by a decision kept from before a
    restart, sends the close. Until now it answered `already closed` and sent
    nothing.
  - Where this host isn't permitted to open or close the server's channels,
    `channel_close` of such a channel is refused as for a registered channel,
    saying the close didn't go through and stays recorded. Until now a refused
    close said the channel was closed, and a channel already decided closed
    was answered `already closed`. Since such a channel may never be
    registered, the refusal says the close happens if the server registers
    it at a time this host may open and close its channels.
