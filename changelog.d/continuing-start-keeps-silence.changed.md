- A turn's hold on plain speech after an explicit send now lasts through the
  starts that continue the turn: the error policy's retry after a stream
  fails, the retry after such a retry's own start fails, the retry a provider
  hold keeps for the turn, and a context-budget restart. Before, only the
  tool-result guard's retry carried it, so after one of these the agent's next
  words posted where its send had already posted, though the hold's notice
  said its speech there "stays held until a new message reaches you or this
  turn ends". A new conversational message the continuing start reads ends the
  hold, as one does at a tool boundary: a message stored while the turn was
  held, one queued while it ran and taken in at the start, one another
  resident's window got meanwhile, or one its last tool boundary injected. A
  wake that brings no message, such as a silent heartbeat merged into a held
  retry, leaves it in place, and so does a message removed unread before the
  start.
