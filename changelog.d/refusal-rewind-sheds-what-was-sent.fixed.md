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
    refused requests carried. The refused reply is removed without being
    counted, and a row the request's sanitizer leaves empty is passed over
    and left in place.
  - **When the rewind gives up,** because nothing the refused request
    carried is left or because it has reached `maxRewinds`, it removes the
    refused reply first, so the next request doesn't carry its text. With
    the rewind off, the refused reply stays.
  - **A stored row the refused request didn't carry**, such as a tuned-out
    channel's traffic or a message stored while the request streamed, is
    left in place and isn't counted, unless it belongs to a tool exchange
    the shed takes whole: a call's stored result, or a row stored between a
    call and its result.
  - **The shed after inference exhaustion** passes over rows the sanitizer
    leaves empty in the same way.
