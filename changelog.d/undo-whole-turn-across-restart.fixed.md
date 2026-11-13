- An undo after a turn that started again inside itself takes the whole turn
  back (#1013). A budget restart at a tool boundary and a held call's retry
  each start a stream of their own, and each recorded a turn checkpoint, so
  `undoLastTurn` took back only the rows since that start: the reply left,
  and the round's tool call and its result stayed in the window, which the
  next request still carried. A start that carries the logical turn on
  records no checkpoint now; the undo walks back to the turn's first.
