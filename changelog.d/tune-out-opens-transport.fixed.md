- `tune_out` of a channel whose transport is closed now opens it, so the
  subconscious gets the traffic it was told to watch. Until now it recorded
  the tune-out and answered success, and the channel's traffic didn't arrive
  until its server next registered it. Where the transport doesn't end open,
  or the tune-out ended while it was being opened, the answer is still a
  success, since the tune-out was recorded, and its new `openError` field
  says why the channel's messages don't, or may not, reach the subconscious
  yet and when they will, or that the tune-out isn't in effect any more. The
  answer now comes once the channel's lifecycle work has settled: the work
  already queued for it, the tune-out's own open where the transport may
  not be open, and the work queued while that open was out, each request
  up to its deadline. `tune_out` called again for a channel already tuned
  out tries the open again where its transport may not be open and this
  host can open the channel, and its refusal says what the transport is
  now.
- `channel_decline` refuses a channel that's tuned out, whatever its
  transport, and says to cancel the tune-out with `tune_out` mode "cancel",
  which delivers what it diverted. Until now a decline of one whose
  transport wasn't open answered success and ended the tune-out without its
  cancel, so its diverted backlog never reached the agent.
