- A `channel_decline` that a later decision replaced while its
  acknowledgment was out no longer has this host send the server anything
  for that decision. Until now:
  - where a `channel_open` replaced it, with the open's request still out
    when the acknowledgment was answered, this host sent the server that
    open a second time;
  - where a tune-out replaced it, in a channel this host hadn't confirmed
    closed, this host sent a `channels/open` for the tune-out.
