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
  text, to its channel, sent once the publish succeeds, a later one to the
  same server's channel opening with a paragraph break. Tool publications, such as
  `send_message`, a `drafts` resend or the `sleep` tool's announcement,
  aren't part of it, as before. A publish succeeds only when the server
  confirms it (`delivered: true`), so one refused before sending, one that
  throws, times out or gets an error response, one the server reports
  undelivered (`delivered: false`) and one whose reply leaves `delivered`
  out are never streamed, and neither is text held as a draft. A
  `{{unsent}}` resend streams the draft's words it sends, rather than the
  token.
- With native tool calls (`roundContent`), a call of a `code_execution`
  script that reaches the host while a run or wait call of the round
  watches the script now counts toward that round's routing, as the same
  call made directly does (#306), whether or not the round waits on that
  call's script. In explicit mode an inner `skip_reply` keeps the round's
  envelopes in the context. In locus and hybrid mode an inner `skip_reply`
  keeps the round's prose private, and an inner silencing send, a `drafts`
  resend among them, holds it and the turn's later prose as drafts, as a
  direct one does. An inner `think` under the private same-round policy
  holds the round back in every mode but disabled. An inner `skip_reply`
  that's refused at dispatch, because this host can't set the
  `wake_in_seconds` it asks for or because the agent's allowedTools doesn't
  name it, or that the host refuses before dispatch, as for arguments that
  aren't an object, counts as a refused direct one: it keeps only its own
  round private, and the turn goes on. An inner send refused so, like a
  refused direct one, silences nothing. A script has only the tools its
  agent's allowedTools names, so a call of
  any other tool fails in the script and reaches no one. On the fallback
  without `roundContent`, as in XML tool mode, an inner call counts only as
  a direct one does there. Nothing is routed until the turn ends, so a
  silencing send holds the whole turn's prose as drafts, the rounds before
  it included. The private `think` hold and an explicit round's
  `skip_reply` don't apply there (#307).
- A round whose run or wait call watches a script that can change its
  routing waits for that call to return, at the script's end or at the
  call's yield, and its prose goes out then. A script can change it when
  its code names a tool whose call changes the round's routing in the
  turn's mode: in locus and hybrid mode `skip_reply`, a silencing send,
  `drafts` (whose resend is one, so its name holds whatever action its
  call asks), `say` or `whisper`; in explicit mode only
  `skip_reply`; and in either, `think` under the private same-round policy.
  Disabled mode holds nothing. A wait reads the code of the script it
  names. A name counts wherever it stands in the code as a whole
  JavaScript identifier, comments and strings included: `tools.say(...)`,
  `tools["say"]` and `tools["world--say"]` name `say`, and `say_hello`
  doesn't. So a comment or a string that mentions such a tool holds its
  round too, for no longer than the call's yield: 30 seconds by default,
  and up to `maxYieldMs`, 600 seconds by default, when the call asks. A
  tool name the code doesn't spell out, built at runtime or written with
  escapes, goes unseen, and its round is routed as it was before scripts
  counted. A stop or a list holds nothing, and neither does a
  `code_execution` call without code execution or one the agent's
  allowedTools refuses. Any other round is routed at its tool-calls event,
  as before, so narration beside a script isn't held for it. The turn's
  locus and an explicit round's `>>` targets are taken at the round's
  tool-calls event, when the model has finished writing it, not when its
  calls return; hybrid's `>>>` targets apply as its delivery runs, as for
  any queued hybrid delivery. What counts is the host's receipt of a call,
  not the script's making it: a call that reaches the host while no call of
  the round watches the script isn't the round's, as one made once its run
  has yielded, one made while it was watched that waited, with 16 of the
  script's calls already out, until the watching call had returned, and one
  still on its way when the call yielded. Such a call's effect can come
  after the round's prose. A call's result settles only the round that
  dispatched it, even when a
  newer round reuses its call id. A round whose turn ends or stops waiting
  on it, or that a newer round of the same agent replaces, before its calls
  return, as when the turn is stopped, is withheld: it is neither sent nor
  held as a draft, a log line names it, and in locus and hybrid mode the
  turn's delivery receipt counts it as suppressed.
- Every stream now sends `channels/outgoing/complete` for each channel it
  streamed to, while its server registers it and takes the stream, on every
  exit path, as MCPL Spec 14.3 asks: once its deliveries have run, or, when
  the host stops, before its connections close, with what it has sent by
  then, so a publish that succeeds after that isn't streamed. A stream that
  handed its turn to a budget restart or a tool-result-guard retry never
  sent it, so a voice server never learned that stream's utterance had
  ended.
- A membrane refusal retry no longer moves the outgoing stream to a new
  inference id. Nothing of the refused attempt was delivered, so none of it
  streamed; the rounds delivered before the refusal stay in the stream, and
  its `complete` carries them. The stream's `inference/lifecycle` `started`
  and terminal now carry that one id too. The retry re-minted the id
  between them, so a server matching them by `inferenceId` saw the first
  inference never end, and a terminal for an id that never started.
