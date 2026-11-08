- `channel_open`'s `beforeMessageId` and `channel_decline`'s `messageId` given
  as anything but a string, such as a JSON number, are now refused before
  anything changes, with an answer saying to give the id in quotes, as the
  invitation notice does. In 0.33.0 they went to the MCPL server as given,
  and an id the model wrote as a number past 2^53 had already been rounded
  when the call was parsed, so it reached the server naming another message:
  a backscroll anchored elsewhere, or an acknowledgment of a message that
  isn't there. A string id goes to the server as before.
