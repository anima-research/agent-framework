- **Speech delivery reports what a publish actually established.** Plain
  speech now goes through one publish executor (`ChannelRegistry.publish`,
  returning a `PublishOutcome`: `delivered`, `failed` or `unknown`, with the
  destination the registry resolved). Only a connector's `delivered: true`
  confirms a post; a missing or malformed receipt is no longer counted as
  delivered (#163's rule). `failed` means nothing was posted: refused before
  dispatch, or `delivered: false` naming no posted message. An error response,
  a timeout or a lost connection after dispatch is `unknown`, keeping the
  connector's own words (a multi-part send may already be partly posted).
  The resident's `[discord-send-failed]` marker now says which: "could not be
  delivered … Nothing was posted" for a failure, and "was not confirmed … may
  or may not have been posted; check the channel before sending it again"
  for an uncertain outcome. The marker's metadata and the
  `mcpl:speech-route-failed` trace carry `outcome`. A channel id registered
  by more than one MCPL server is refused rather than routed through
  whichever server registered it first.
