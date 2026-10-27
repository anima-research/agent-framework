- Once a turn stream's terminal event (`complete`, `error` or `aborted`) has
  decided the turn, nothing after it decides it again (#734). A stream that
  threw from its iterator after that event, or sent another event, had its
  turn acted on a second time: a later failure ended an answered turn as
  failed, with an `[inference-failed]` line in the agent's context after its
  own answer and a failed inference-log row, or, as an acceleration 429,
  installed a hold whose retry would send the answered turn again; and a
  later event ran its case for a turn already decided. Such an event or
  throw now ends the stream, with a line on the console, and decides
  nothing. Membrane's own streams send their terminal event last; only a
  stream of another make sends or throws anything after it.
