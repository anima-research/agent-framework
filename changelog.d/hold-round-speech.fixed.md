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
  same channel opening with a paragraph break. Tool publications, such as
  `send_message` or the `sleep` tool's announcement, aren't part of it, as
  before. A publish that fails is never streamed: one refused before
  sending, one that throws or times out, or one the server reports
  undelivered (`delivered: false`). A reply that leaves `delivered` out
  counts as delivered, as delivery counts it. A `{{unsent}}` resend
  streams the retained text it sends, rather than the token.
- With native tool calls (`roundContent`), a call made inside a foreground
  `code_execution` script now counts toward its round's routing, as the
  same call made directly does (#306). In explicit mode an inner
  `skip_reply` keeps the round's envelopes in the context. In locus and
  hybrid mode an inner `skip_reply` suppresses the round's prose, and an
  inner silencing send suppresses it and the turn's later prose. An inner
  `think` under the private same-round policy holds the round back in every
  mode. On the fallback without `roundContent`, as in XML tool mode, an
  inner call counts only as a direct one does there: a silencing call
  silences the turn's later prose, while the private `think` hold and an
  explicit round's `skip_reply` don't apply (#307).
- A round whose script can change its routing waits for the script, and its
  prose goes out when the script finishes. A script can change it when its
  code names a tool whose call changes the round's routing in the turn's
  mode: in locus and hybrid mode `skip_reply`, a silencing send, `say` or
  `whisper`; in explicit mode only `skip_reply`; and in either, `think`
  under the private same-round policy. Disabled mode holds nothing. A name
  counts in code wherever it stands as a whole word of ASCII letters, digits
  and underscores, or after `__` as in `mcpl__world__say`, as a function is
  called or a `tools[...]` key is written: `say_hello` doesn't name `say`. A
  name in a comment doesn't count, since Python never runs one, while a name
  anywhere in a string does, since a string can be a key or code to run. A
  script can also change its round's routing when the interpreter it runs in
  has run a script that left such a tool reachable, by naming the tool
  inside a definition (a function or lambda, a class's methods among them)
  or other than in a direct call, or by keeping a string that is the tool's
  whole name, optionally namespaced, as a key kept for later is. That holds
  until the interpreter is reclaimed or restarted. A direct call outside a
  definition, a class's own body included, or a string that only mentions a
  tool, as a printed sentence does, leaves nothing reachable. Without code
  execution, a `code_execution` call holds nothing. Any other round is
  routed at its tool-calls event, as before, so narration beside a script
  isn't held for the script's runtime. What goes unseen is routed as it was
  before scripts counted, such as a tool name the code doesn't spell out
  (built at runtime, written with escapes, or in non-ASCII spellings), code
  loaded from a file or module, an enumeration of the tools, a call written
  in a string's text (code run with `exec` or `eval`, or an f-string's
  field), inside a definition too, a definition or alias made inside such a
  string, a call that outlives its script (one it awaits only in a later
  script, schedules as a task, or leaves in a generator expression), and
  code a later script runs from a string an earlier one kept. The turn's
  locus and an explicit round's `>>` targets are taken at the round's
  tool-calls event, when the model has finished writing it, not when its
  scripts return; hybrid's `>>>` targets apply as its delivery runs, as for
  any queued hybrid delivery. A background script's call returns as soon as
  the script has started, and its later calls aren't the round's. A script's
  result settles only the round that dispatched it, even when a newer round
  reuses its call id. A round whose turn ends or stops waiting on it, or
  that a newer round of the same agent replaces, before its scripts return,
  as when the turn is stopped, is withheld: a log line names it, and the
  turn's delivery receipt counts it as suppressed.
- Every stream now sends `channels/outgoing/complete` for each channel it
  streamed to, on every exit path, as MCPL Spec 14.3 asks: once its
  deliveries have run, or, when the host stops, at once, with what it has
  sent, so a publish that succeeds after the stop began isn't streamed. A
  stream that handed its turn to a budget restart or a tool-result-guard
  retry never sent it, so a voice server never learned that stream's
  utterance had ended.
- A membrane refusal retry no longer moves the outgoing stream to a new
  inference id. Nothing of the refused attempt was delivered, so none of it
  streamed; the rounds delivered before the refusal stay in the stream, and
  its `complete` carries them. The stream's `inference/lifecycle` `started`
  and terminal now carry that one id too. The retry re-minted the id
  between them, so a server matching them by `inferenceId` saw the first
  inference never end, and a terminal for an id that never started.
