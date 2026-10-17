- **Speech delivery reports what a publish actually established.** Plain
  speech now goes through one publish executor (`ChannelRegistry.publish`,
  returning a `PublishOutcome`: `delivered`, `failed` or `unknown`, with the
  destination the registry resolved). Only a connector's `delivered: true`
  confirms a post; a missing or malformed receipt is no longer counted as
  delivered (#163's rule). `failed` means nothing was posted: refused before
  dispatch, or `delivered: false` naming no message. An error response, a
  timeout or a lost connection after dispatch is `unknown`, keeping the
  connector's own words (a multi-part send may already be partly posted), and
  so is a contradictory receipt (`delivered: false` beside a message id,
  valid or not).
  The resident's `[discord-send-failed]` marker now says which: "could not be
  delivered … Nothing was posted" for a failure, and "was not confirmed … may
  or may not have been posted, so sending it again could post it twice" for
  an uncertain outcome. The marker's metadata and the
  `mcpl:speech-route-failed` trace carry `outcome`. A channel id registered
  by more than one MCPL server is refused rather than routed through
  whichever server registered it first, and a supplied but empty or
  non-string server selector is refused rather than read as omitted. A send
  refused for its server or grant opens no closed channel. A
  `channels/publish` request always has a deadline: with `requestTimeoutMs`
  0 it keeps the 60 s default, since its outcome is told to the resident and
  recorded for its draft; its expiry reads as unknown.
  `channel_publish`, and the subconscious's `speak_in_channel`, which shares
  its path, answer by the same rule. Before, they answered success with
  `{ delivered: true }` for a missing receipt and never read `delivered`.
  Now only `delivered: true` is success. `delivered: false` naming no
  message, or a request refused before it was written, is an error saying
  nothing was posted. Anything else is an error saying the publish wasn't
  confirmed and that sending it again could post it twice. That answer, a
  draft resend's line for a send that wasn't confirmed, and the `drafts`
  tool's read of that attempt carry the connector's data, bounded, when it
  sent some. `channel_publish` and
  `speak_in_channel` still resolve a channel id by its first registered
  match and post into a closed channel without opening it, as before.

  If you run a connector that answers `channels/publish` with `{}` or no
  receipt, which earlier versions counted as delivered, every publish
  through it now reads as unconfirmed. The resident is told of each reply
  that it wasn't confirmed, and gets an error for each `channel_publish` and
  `speak_in_channel` call, each saying that sending it again could post it
  twice. A connector confirms a post by answering `delivered: true`.
