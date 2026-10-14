- The MCPL outgoing stream (`channels/outgoing/chunk` and `complete`) no
  longer carries text that delivery withholds or sends elsewhere. It
  streamed each round's text as the model wrote it, but whether a round is
  delivered is decided only once its tool calls are known. So a streaming
  server received, and discord-mcpl's voice spoke:
  - a round that called `skip_reply`, a silencing send such as
    `send_message` or `channel_publish`, or a `think` under
    `same_round_think_text_policy: private`;
  - a round its stream never finished, such as one cut off by a stream
    error;
  - in hybrid mode, in a later stream of the turn, such as a budget
    restart's, a framework retry's or a re-inference's, text the turn's
    hold kept back or its pin sent to another channel;
  - in locus and hybrid mode, after a mid-turn re-pin, text bound for the
    new locus, which streamed to the old one.

  The stream is now the prose that delivery published: each publish's
  text, to its channel, sent once the publish is confirmed, a later one to
  the same channel opening with a paragraph break. Tool publications, such
  as `send_message` or the `sleep` tool's announcement, aren't part of it,
  as before. A publish that fails, times out or isn't confirmed is never
  streamed. A `{{unsent}}` resend streams the retained text it sends,
  rather than the token.
- Every stream now sends `channels/outgoing/complete` for each channel it
  streamed to, on every exit path, as MCPL Spec 14.3 asks: once its
  deliveries have run, or, when the host stops, at once, with what it has
  sent. A stream that handed its turn to a budget restart or a
  tool-result-guard retry never sent it, so a voice server never learned
  that stream's utterance had ended.
- A membrane refusal retry no longer moves the outgoing stream to a new
  inference id. Nothing of the refused attempt was delivered, so none of it
  streamed; the rounds delivered before the refusal stay in the stream, and
  its `complete` carries them. The stream's `inference/lifecycle` `started`
  and terminal now carry that one id too. The retry re-minted the id
  between them, so a server matching them by `inferenceId` saw the first
  inference never end, and a terminal for an id that never started.
