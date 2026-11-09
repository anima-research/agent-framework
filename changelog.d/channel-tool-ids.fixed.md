- `channel_open`'s `beforeMessageId` and `channel_decline`'s `messageId` given
  as anything but a string or `null`, such as a JSON number, are now refused
  before anything changes, with an answer saying to give the id in quotes, as
  the invitation notice does. In 0.33.0 they went to the MCPL server as given,
  and an id the model wrote as a number past 2^53 had usually lost its last
  digits when the call was parsed, so it reached the server as a different
  id, as a backscroll's anchor or as the message an acknowledgment is for.
  A string id goes to the server as before, and `null` is handled as before.
- `channel_publish`'s `channelId` given as anything but a string or `null` is
  now refused before anything is posted, with an answer saying to give the id
  in quotes, as `channel_list` does. In 0.33.0 such a `channelId` was
  usually read as left out, so the message was posted where a call naming no
  channel posts, such as the channel of the turn that made the call.
