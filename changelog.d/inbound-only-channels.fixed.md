- The host no longer publishes into a channel its server declared inbound-only
  (`direction: "inbound"`, SPEC §14.2). A server's live-transcript channel can
  be one, where an agent speaking in the room arrives addressed. Until now
  that moved a resident's plain speech there, the delivery attempt opened the
  channel if she had closed it, and the server refused the publish.
  - Plain speech aimed at a channel the host knows is inbound-only is
    refused before the channel is opened or published to, and the
    send-failure marker names the declaration.
  - A `>>` or `>>>` target naming the channel bounces with the same reason,
    and the closed-channel invitation offers no reply into it. In explicit
    mode the refused target also clears the turn's destination, so the turn's
    later text without a prefix bounces too, rather than going to the
    destination named before it. A channel declared inbound-only only after
    the target resolved is refused when the text is delivered, with the
    send-failure marker, and in explicit mode that ends the destination too,
    unless a later round has named another channel by then.
  - `channel_publish` and the subconscious's `speak_in_channel` return an
    error that names it. The outgoing stream skips the channel, and the
    channel context names no default outgoing channel for it.
  - A channel the host knows only from a push is refused once the server's
    answer to opening it, wherever the host opens it, declares it
    inbound-only.
  - The routing notices say plain speech is refused there, and to use that
    server's own tools. The locus and hybrid mode primers, shown when an
    agent's mode changes, say plain speech goes to the locus unless its server
    declared that channel inbound-only.
- When a server answers a publish of plain speech with an error, the
  send-failure marker says delivery wasn't confirmed and may or may not have
  happened, since an error can follow a partial post (a long reply sent in
  parts whose later part failed), so sending it again could post it twice.
  It carries the server's own message, cut at 200 characters, or says it
  sent none, and an `mcpl:speech-route-failed` trace goes out with
  `outcome: "unknown"`. The marker's and the trace's `outcome` is
  `"failed"` for every other failure of plain speech. Before, the error was
  only logged, unless the text had a hybrid `>>>` target, which bounced it.
  Any other failed publish still rejects as before: one that times out or
  loses its connection before an answer, which the server may or may not
  have posted, or one whose connection was already closed. Plain speech
  logs it, and a hybrid `>>>` target bounces it. `channel_publish`'s error
  for a server's error response likewise names the channel and says the
  publish wasn't confirmed and that sending it again could post it twice.
  For a server's error response, `channel_publish`, `speak_in_channel`,
  `channel_open` and `channel_close` errors, the error `channel_decline`
  gives when its acknowledgement request fails, and the marker for an open
  that fails, give the server's own words, cut the same way.
  `speak_in_channel`'s trace carries the outcome too:
  `"unknown"` after an error response, `"failed"` after a refusal or
  `delivered: false`, and none after another rejection, which it can't tell
  apart.
- A server's error response, to a request the host sends once the
  connection is up, now settles that request whatever its message is.
  Building the error's text from a message that isn't text, such as an
  object, could throw before, after the request's entry was gone, so the
  request never settled.
- Speech into a channel that is removed while the host opens it is refused,
  and nothing is published to it.
- `speak_in_channel`'s `mcpl:speech-routed` trace now follows a publish the
  server accepted and didn't report undelivered, with the fields
  `routeSpeech`'s trace has (`serverId`, `delivered`, `textLen` and the
  surface's `messageId`). Any other outcome, as the tool's result reports
  it, is traced as `mcpl:speech-route-failed`: a refusal, a publish the
  server reported undelivered, or one that failed, a timeout included.
