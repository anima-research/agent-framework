- An agent whose window can't be written down at its registration, or after a move of the store's branch (or whose
  context can't follow the move), is logged and raises an ops alert (`presentation-legacy`), beside the
  `presentation:failed` trace, which now carries `legacy: true` (#291). Its context is the whole record until a
  later move writes its window down; before, a host with no trace listener wasn't told. Where its context couldn't
  follow a move onto a branch that holds a window (one made from the head), its window is that branch's instead, and
  isn't presented to, and writes for it wait in memory until a later move re-initializes it; the alert says so.
