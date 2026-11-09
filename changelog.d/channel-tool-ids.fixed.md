- The channel tools (`channel_open`, `channel_decline`, `channel_close`,
  `channel_publish`, `think`, `journal` and `skip_reply`) now refuse a call
  that gives a parameter their schema declares a string as anything else,
  such as a JSON number, before anything changes. The answer names the
  parameter and what the call gave, and says to give it in quotes. A
  parameter left out or given as `null` is read as before. In 0.33.0:
  - `channel_open`'s `beforeMessageId` and `channel_decline`'s `messageId`
    went to the MCPL server as given, and an id the model wrote as a number
    past 2^53 had usually lost its last digits when the call was parsed, so
    it reached the server as a different id, as a backscroll's anchor or as
    the message an acknowledgment is for.
  - `channel_publish`'s `channelId` was usually read as left out, so the
    message was posted where a call naming no channel posts, such as the
    channel of the turn that made the call.
  - `channel_decline`'s `acknowledge`, and `channel_publish`'s `content` or
    `text`, given as a number, `true`, an object or an array, went to the
    server as given: as the acknowledgment's value, or as the posted
    message's text.
  - A `channelId` given to `channel_open`, `channel_decline` or
    `channel_close` as anything but a string was refused as a channel that
    doesn't exist, except in a conversation fork: there `0` or `false` as
    `channel_close`'s `channelId` closed the fork's own channel, and as
    `channel_publish`'s posted there. A `serverId` of `0` or `false` was read
    as none given.
  - `think`, `journal` and `skip_reply` took any value; a `skip_reply` whose
    `reason` isn't a string is now refused, and the turn goes on.
