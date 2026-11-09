- The channel tools (`channel_open`, `channel_decline`, `channel_close`,
  `channel_publish`, `think`, `journal` and `skip_reply`) now refuse a call
  that gives a parameter their schema declares a string as anything else,
  such as a JSON number, before anything changes. The answer names the
  parameter and what the call gave, and says to give it in quotes. A
  parameter left out or given as `null` is read as before. In 0.33.0:
  - An id the model wrote as a number past 2^53, as `channel_open`'s
    `beforeMessageId` or `channel_decline`'s `messageId`, had usually lost
    its last digits when the call was parsed, so it reached the MCPL server
    as a different id, as a backscroll's anchor or as the message an
    acknowledgment is for.
  - `channel_publish`'s `channelId` was usually read as left out, so the
    message was posted where a call naming no channel posts, such as the
    channel of the turn that made the call.
  - Other non-strings were taken as given, read as left out, or refused for
    another reason.
