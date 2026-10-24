- A message that arrives during a turn's tool call, and that the strategy
  renders as `null`, is injected into the live stream as stored again. The
  memory strategy gives `null` for a message before its recent window (a
  batch bigger than that window), and for every message while a head
  window a topic change reset hasn't filled yet. Since 0.24.1, such a
  message was left out of the live round, and a `[not shown]` system line
  was stored in its place. But the next compile sends it raw, in order,
  after the tool result, so the agent didn't hear it mid-turn, the line was
  false, and the next request differed from the live rounds anyway. The
  `[not shown]` line, and the log line naming what was left out, are gone.
  A clock row the render gives `null` goes in as stored too. As stored
  still differs from the next request where its per-message cap or an
  image limit reaches such a message, since the render neither cuts it nor
  counts its images: a batch with more images than `maxLiveImages`, for
  one. It differs too for a single message too big for the recent window,
  which the strategy stores in parts.
