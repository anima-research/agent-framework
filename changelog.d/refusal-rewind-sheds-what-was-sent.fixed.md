- A refusal rewind (`refusalHandling.autoRewind`, or `/unstick`) sheds
  what the refused request carried: the newest message, or tool exchange,
  that the refused request sent. Before, where the provider's refused reply
  was stored as the agent's turn, empty or holding the text the refused
  attempt produced, each shed took only that reply. So the retry sent the
  refused message again, unchanged, repeated refusals never reached
  anything older, and the marker said "The N most recent turn(s) were set
  aside" of turns that hadn't been.
  - **The retry** no longer carries the refused message, and repeated
    refusals now shed older messages, newest first, the agent's own turns
    included, as the rewind's order always was.
  - **The marker's count** is the number of turns set aside that the
    refused requests carried. A shed removes the refused reply that its
    refusal just stored, and any row that carries nothing a request sends,
    without counting them. When nothing the refused request carried is
    left, it removes the refused reply alone before giving up.
  - **A stored row the refused request didn't carry**, such as a tuned-out
    channel's traffic or a message stored while the request streamed, is
    left in place and isn't counted.
  - **The shed after inference exhaustion** removes rows that carry
    nothing without counting them, in the same way.
