- On a server that's up but whose grant lacks `channels.lifecycle`, speech, a draft's resend or a
  send's open step no longer tries to open a channel that isn't open, since nothing opens there:
  the words go into the channel as it stands, and a send answers `already-open` or `stays-closed`.
  Before, speech and resends there were refused, with "… this host isn't permitted to open or close
  the … server's channels", or with "the channel isn't confirmed open" where a retarget had left it
  unconfirmed, and a send's open failed and was traced as `mcpl:channel-open-failed`.
- The latest deliberate close is the one on record: the agent's `channel_close` over its own
  decline, its `channel_decline` over its own close, and either over a module's close, or a
  module's close over the agent's, now record themselves. Before, a channel the agent had already
  declined kept the decline when it closed it, and the reverse. A machine close of a channel with
  no record at all, one registered lazily or on a server whose grant lacks `channels.lifecycle`,
  now leaves it the default it had, where it used to record its own source, which policy never
  lifts (#417). Records written before this change keep their source, so a channel a machine closed
  before the upgrade still isn't opened by policy.
- `channel_decline` of a channel decided open that isn't open at the transport, whose open failed
  or is still on its way, now records the decline, where it was refused with "… is open, or set to
  open, so there's nothing to decline". That's the decline the invitation offers as the way to
  reply without opening a channel. Where its transport may be open, as with an open on its way, the
  decline closes it through the channel's lifecycle queue, as any decline does. A channel open at
  the transport is still refused, now with "… is open, so there's nothing to decline", and so is a
  tuned-out channel, as before.
- `channel_close`'s description and the "[channels] Now open" and policy notices' last sentence now
  say that a channel the agent closes stays closed until it opens it with `channel_open`, and that
  neither speaking there, the subscription policy nor its server's own default opens it again.
- The closed-channel invitation is no longer added to a direct message (`chat:dm`), all of which
  reaches the agent whether the DM is open or not. Where no single-word target reaches a channel,
  it no longer says to open the channel to reply: it suggests checking whether the server has a
  send tool that can address the channel, and says what replying there does.
