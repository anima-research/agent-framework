- A refusal rewind (`refusalHandling.autoRewind`, or `/unstick`) sheds
  what the refused request carried: the newest message, or tool exchange,
  that reached it. Every shed, the one after inference exhaustion included,
  passes over rows no request carries. Before, the provider's refused reply
  was stored as the agent's turn, empty or holding the text the refused
  attempt produced, and each shed took only that reply. So the retry sent
  the refused message again, unchanged, repeated refusals never reached
  anything older, and the marker said "The N most recent turn(s) were set
  aside" of turns that hadn't been.
  - **The retry** no longer carries the refused message, and repeated
    refusals now shed older messages, newest first, the agent's own turns
    included, as the rewind's order always was.
  - **The marker's count** is the number of turns set aside that reached a
    request. A shed removes the refused reply that its refusal just stored,
    and any row a request never carries, without counting them. An earlier
    refused reply that a later request carried, as when the rewind was off
    and the agent went on, counts as a turn.
