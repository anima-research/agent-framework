- Event suppression: a wake rule with `suppress: { description, script? }`
  (and `behavior: "defer"`, written out so an earlier release defers rather
  than wakes) keeps the events it takes out of the agent's context. Each such
  event is stored with `metadata.suppressed = { rule, eventType }`, decided
  once as it arrives, before the hold, the veto and the gate. Every view the
  framework sets leaves stamped rows out, so they're never compiled,
  injected, folded into memory, woken for, or taken as the locus, and they
  bring no clock row in. Editing or removing the rule changes only what
  arrives afterwards. Events addressed to the agent (`chat:addressed`), the
  heartbeat's, and console or API input are never suppressed, and a suppress
  rule decides no wake for an event suppression was asked about (where it
  wasn't, it defers). Covers MCPL channel messages and push events, a
  module's events with their messages and wake, and a server's `[toolsets]`
  notices (gated as `mcpl:tool-changes`). `wake_add_rule` takes `suppress`;
  `gate_status` shows each suppress rule's settings and how its script has
  run, and counts what it suppressed since start.
- A suppress rule's `script` is the agent's own logic: the source of a
  function `(event, state) => boolean`, true hiding the event, with `state`
  the rule's own JSON object (at most 64 KB), kept across events and restarts
  in `suppress-state.json` beside gate.json and started afresh when the
  script changes or the rule is removed. Scripts run on a worker thread with
  a 50 ms timeout (`gate.suppressScriptTimeoutMs`); one that fails or times
  out lets the event on to the rules after it, and one that times out three
  times in its last twenty runs is set aside until its script changes or the
  host restarts. wake_add_rule compiles
  a script before saving it.
- `suppression_stats { rule?, recent?, since? }` and `dump_suppressed { path?,
  rule?, since?, until?, format? }`, in the built-in settings toolset, read
  the stamped rows on the current branch (times are when each was stored). The first reports, per rule, the
  count, the text size, the first and last arrival, a breakdown by source and
  event type, and the newest few with a preview (a removed rule with
  `inForce: false`). The second writes the rows to a workspace file, their text in full and other blocks named, as
  a transcript or JSON lines, at most 4 MB. `AgentFramework.suppressedEvents()`
  gives hosts the same rows.
- The suppression review (`gate.suppressionReview`, on by default): every two
  hours (`intervalMs`, at least ten minutes), Claude Haiku 5.5 (`model`) reads
  what each suppress rule hid against its description, a sample of at most
  `maxEventsPerRule` (60), and flags what doesn't fit or what the agent would
  plausibly need to see. The agent gets a `[suppression review]` notice, and a
  wake on a flag (`wakeOnFlag`); `notify: "flagged"` tells it only of flags.
  Progress is kept in `suppression-review.json` beside gate.json.
  `AgentFramework.reviewSuppression()` runs one now. New traces:
  `gate:suppressed`, `gate:suppression-review`; `admission:decided` gains
  `suppressed`.
- **Hosts rolling back past this release:** run its `agent-framework-recover
  --store <path> --agent <name> --remove-suppressed` first, with the host
  stopped. A release without suppression doesn't read the stamp, and where
  compression formed a summary around a hidden row, it refuses the store at
  open (`StoreTopologyError`). The command makes and activates a branch without
  the hidden rows; the source branch keeps them. That holds unless this release
  has made a window write of two or more rows (the first write-down of a window
  that holds a row, as at the first boot on a store with history, or a
  presentation of more than one row): the store's MANIFEST is then at version 2, which
  no earlier release opens, and only a copy of the store taken before the
  upgrade goes back (the 291-presentation-mandatory entry). It cleans the agent's own
  branch, not a derived context's (`dendrite/…`), so finish any such context
  first. With an anchor it starts at that message, where a row an earlier run
  removed is back, so run it last with no anchor. Suppress rules load as `defer`
  in every release back to 0.22, so nothing wakes for their events; 0.22 to
  0.26 drop `suppress` from gate.json at their first rule edit.
- The changed `wake_add_rule` definition and the two new tools change the tool
  definitions once, in the built-in settings toolset, or in the tool list on a
  host without host presentation, where it's one prompt-cache miss. The review's calls count toward the agent's
  usage, as the reply judge's do, and a wake on a flag is a full turn of the
  agent's own model.
