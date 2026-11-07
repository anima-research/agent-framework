- **The turn-opening pin and an undeclared stream read the window (#291).** 0.31.0's turn-opening pin
  (`agent-framework:turn-inputs`) pinned the rows stored after the agent's newest own message and its consumed
  watermark; it now pins the rows presented to the agent since its mark, in the window's order, a row stored before
  the mark and presented after it included, and no row stored and not yet presented (in legacy mode, where the
  window is the record, the rows stored since). A mark taken before the window was written down is read the same way
  once it is. And 0.31.0's rule that a stream whose tool calls don't declare `supportsInjectedMessages` carries no
  injected messages now means that what arrived for the agent during its turn waits out of its window for the turn's
  end; a tool boundary with no stream, as the direct API's, presents what arrived.
