- A message deferred during a turn that can't join the live stream at a tool
  boundary — one carrying tool blocks, or named as the agent itself — now
  waits for the turn's end, after its last round, instead of being stored at
  the boundary between rounds the stream never showed it. Messages queued
  behind it wait with it, so the queue keeps its order; messages queued
  before it are still heard at the boundary. The cost: a message addressed
  to the agent but queued behind a held one isn't heard mid-turn, and waits
  for the turn's end, and unless the queue is persisted (below), a held
  message and what is queued behind it live only in memory until then, so a
  crash during the turn loses them. Stored between rounds, a held message
  sat before the turn's later replies in every later compile although their
  requests never held it: a prompt-cache divergence, and on a provider that
  binds signed thinking to the prefix it was minted under
  (anima-research/context-manager#155, whose binding
  anima-research/context-manager#160 walks), a reply whose thinking is
  refused.
- A message injected into the live stream at a tool boundary now counts as
  read for RFC-006 coalescing when the stream says it carries injected
  messages (membrane's `ToolContext.supportsInjectedMessages`, which
  membrane's main sets true on its native path): the consumed watermark moves
  when messages are injected, not only at a compile. Before, an injected
  message sat above the watermark of the turn's compile, so a coalesced
  replacement for its subject could remove a message the agent had heard and
  answered. Within a branch the watermark only advances: a compile that
  started before such a mark doesn't roll it back when it finishes. A stream
  that doesn't say, as on membrane 0.5.87, still gets injected messages, and
  they stay unread, as before: 0.5.87's XML tool path doesn't carry them, and
  warns that they'll come next turn instead.
- A stream that says it can't carry injected messages (as membrane's main says
  of its XML prefill path) gets none: everything deferred for the agent during
  the turn waits for the turn's end, after its last round, as a held message
  does, instead of being stored between rounds the stream never showed it.
- A deferred write that a flush defers again does so whatever its content,
  under its id and in its place in the order writes arrived. That happens
  while its target's own turn, stream or tool cycle is alive, or the host is
  quiesced. (A write whose store throws before storing it goes back into the
  queue too; see below.) A `tool_result` used to land regardless, apart from
  the `tool_use` it answers, which went back into the queue.
- A write that waits now waits on its own target's state: the target's
  turn, stream and tool cycle, or a quiesced host. (A fresh `tool_result`
  still doesn't wait.) Before, a write for the primary agent waited out every
  agent's tool cycle, while one addressed to an agent waited only on that
  agent's. So a turn's end could store a later addressed message ahead of an
  earlier one for the primary, and a fork's, subagent's or the
  subconscious's tools held the primary's writes, which protected nothing in
  the primary's window. Each flush, at a turn's end, after surgery, after a
  withdrawn turn, after a start that ends before its stream and after a
  puppet call, now delivers the agent's deferred messages while another
  agent's tool cycle is pending; only the agent's own state holds them. The
  flush after surgery stores several agents' entries in the order they
  arrived, where it went agent by agent: residents share one message slot,
  so that reordered their shared transcript.
- `stop()` now stores what is still deferred for each registered agent
  before the store closes, in the order it arrived; before, a memory-only
  queue lost it. Once `stop()` begins, a new ephemeral run is refused, and
  an ephemeral run whose turn is refused because `stop()` has closed
  admission, or whose retry `stop()` cancels, ends at once rather than
  waiting for a watchdog. Since no turn starts or registers a stream once
  `stop()` begins (unless `start()` is called before it finishes), no reply
  can then follow a stored entry in a stream, so `stop()` stores each one
  even while a frame it doesn't wait for still holds its target's turn, such
  as a turn started outside the event loop, or a puppet call still running
  after `stop()`'s wait for operator operations timed out; that call's pair
  then lands after them. A quiesced host keeps what is deferred in its
  persisted queue for boot recovery. An entry for a target no longer
  registered (a disposed fork) is dropped from a memory-only queue at exit,
  as before.
- What is deferred for a conversation fork whose closure turn ends, or for
  an ephemeral run that ends, is now stored in that agent's store before the
  fork is disposed or the run deregistered. Before, the turn-end flush ran
  after, found no agent to take it, and dropped it. A closing fork is now
  disposed by the frame that ends its closure turn: one that hands the turn
  to a successor (a guard or budget restart) leaves it. Before, that frame
  disposed it, so the successor found no agent and the turn never finished.
  A quiesced host defers what is queued for an ending run or a closing fork
  again instead, and with the agent gone, the flush that meets it later
  drops it.
- A deferred write whose store throws without storing it goes back into the
  queue under its id, and so does every entry queued behind it for that
  agent, so none of them lands ahead of an earlier one, and a queued
  `tool_use` that can't be stored keeps the `tool_result` queued behind it
  from being stored alone. (A stored `tool_use` whose `tool_result` then
  can't be stored stays alone until the result lands at a later flush.)
  Other agents' entries go on, in the order they arrived. The log line names
  the entry at each flush, and one that keeps throwing holds what is
  deferred behind it for that agent until it can be stored. The hold is the
  queue's: a write that isn't deferred is stored at once and can land ahead
  of a held entry. That's a fresh `tool_result`, a message assembled into
  the agent's turn before its compile (RFC-006 coalescing), and any write
  while the agent's turn, stream and tool cycle are idle and the host isn't
  quiesced. So an entry that keeps throwing holds only what is deferred
  while the agent's turn, stream or tool cycle is alive, or the host is
  quiesced. Before, it stayed in the un-acked set and the next
  acknowledgement dropped it from the persisted queue (at a turn start or a
  flush it was lost even from memory). At a tool boundary, nothing from it
  on is injected. While the framework runs it is kept; a memory-only queue
  still loses it when the process exits. A persisted queue (one a quiesce
  persisted, or boot recovery restored) keeps it across restarts: each boot
  restores it and tries it again with the rest of the queue, at once or at
  the resume after a quiesced boot, and logs it again, unless it's one boot
  drops (below). While it's held the queue stays persisted, so every later
  deferral is written to the recovery file, up to the file's size cap; past
  it the file isn't rewritten, as the host log warns, and what's deferred
  after that is kept in memory only. Only the host log names the held write.
- A deferred write that throws after its message was stored, such as one
  whose store listener throws, counts as written: it isn't put back into the
  queue and stored a second time, and at a tool boundary what was stored is
  injected with the rest. For a body the strategy shards, that can be its
  first shards alone, since the throw stops the store's append loop: the
  rest of the body isn't stored, and the request carries what landed, joined
  as the strategy joins a body's shards when it compiles. The log line says
  it was stored, or how many shards were.
- Boot recovery drops a recovered deferred write whose participant isn't
  text, whose content isn't an array, or that holds a block that isn't an
  object, and logs it by id and participant, rather than holding it in the
  queue. The store can't take a null block. It keeps a string or number
  block as given, but the context manager's token estimate throws on such a
  block, so once one is stored, every compile for that agent fails, and a
  restart doesn't clear it. Before, an entry whose participant isn't text or
  whose content isn't an array was dropped without a line, and one with a
  block that isn't an object was kept: a null block could never be stored,
  and a string or number block, once stored, made every compile for its
  agent fail. Boot recovery also drops an entry whose `forAgent` is present
  but empty or not text, keeps the first well-formed entry with an id and
  drops and names a later one, names an entry with no id as it gives it one,
  and numbers an entry whose `seq` isn't a positive whole number up to
  `Number.MAX_SAFE_INTEGER` after the others, naming it unless it has none.
