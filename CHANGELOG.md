# Changelog

Notable changes to `@animalabs/agent-framework`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.7.3 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/anima-research/agent-framework/releases).

## Unreleased

## 0.32.0 — 2026-10-31

### Breaking

- **Hosts that want an agent told when something is derived from it:** pass
  `dendrite.derivationNotice`. Without one, a derivation (a task-fork, a
  subconscious fork, a conversation fork, a resumption) no longer puts an
  `[Agent lifecycle: … was derived from you …]` line, or its collapsed count
  line, in the source agent's context. Text about an agent's own body or mind
  isn't added by default: a host that wants it says so. The hook is given the
  framework's line as before and returns it, its own text, or `null`. The
  `dendrite:agent-created` trace is emitted either way, and the other
  lifecycle lines (an orphan's offer, work a restart interrupted) are
  unchanged.

### Changed

- An agent is no longer told when reasoning leaves its context. #826's
  `[reasoning] <agent>:` notices ("The reasoning behind your earlier replies is
  no longer in your context, because your tools changed… Re-read before relying
  on an earlier decision.", and the per-reply form) are no longer stored for an
  agent or passed to its stream, on a binding compile's strip or on a block the
  provider drops. Standing or recurring text about the mechanics of an agent's
  own memory and reasoning gives it nothing to act on and keeps it thinking
  about it, and under a binding model any change to the tool list would have
  triggered one. Operators keep the `thinking-binding-loss` ops alert for drops
  the record doesn't account for, and hosts can still observe strips through
  `Agent.onThinkingStrip`.

## 0.31.0 — 2026-10-30

### Breaking

- **Hosts that call `start()` or `addModule()` on an `AgentFramework` after its `stop()`:** a stop now ends its instance (#315). Once a `stop()` is admitted, `start()` throws and `addModule()` rejects, for good, whether that stop completed or failed. Before, both were allowed once the stop had settled (0.22.0: "A `start()` after a finished `stop()` starts a new lifecycle"; 0.24.0 left what it should do as #315's open question), and the lifecycle they began didn't work. Its event queue stayed closed, so an event passed to `pushEvent()` threw `Queue is closed` and a tool call's result couldn't be delivered, failing the turn that made it. Operator operations and MCPL connects were refused as "the framework is stopping". The push coalescer, the liveness watchdog and the MCPL servers stayed stopped, and events the queue held when the stop closed it ran in the new lifecycle. What did run was a turn woken outside the queue that called no tool: a sleep's wake, a heartbeat's, or a budget restart left pending.
  - **Migration:** create a new `AgentFramework` on the store, with the same borrowed `store` or the same `storePath`. After a failed `stop()`, call `stop()` again first, until one resolves. The refusal says which applies. After a completed stop it reads `start() refused: this framework has stopped, and a stopped framework doesn't start again. Create a new AgentFramework on its store to go on, with its storePath if it opened the store itself.`, and `addModule()`'s the same with its own name. After a failed one, it says to call `stop()` again. After a failed one that left its owned store closed, so it can't be tried again, its `cause` is that stop's failure. These texts replace `Cannot start a new lifecycle: owned store is closed` and `Cannot start a new lifecycle: stop() closed its context managers, and then failed to close its owned store`, and once a `stop()` is admitted, `addModule()` now refuses before it checks the module's name against servers' tool prefixes, while that stop runs as well as after. A turn begun through `runUntilIdle()` before the first `start()`, and still being assembled when that `start()` comes, now goes on rather than being dropped.
  - **What a new instance keeps:** what the store holds, and, with the heartbeat on and the same heartbeat state file, the heartbeat's schedule as it reads it from that file, so a tick or a reminder that fell due meanwhile fires once, shortly after it starts. What the old instance held only in memory is lost with it, as on a process restart: an agent's sleep and its wake, a self-wake, the inference requests still queued (a budget restart, a heartbeat's wake, a nudge), a re-armed turn's wait and count, and the redo stack. #627 is about keeping a sleep and a self-wake across a restart. To pause and resume one framework in place, use `quiesce()` and `resume()`.
  - **Unchanged:** a `start()` or `addModule()` made while a `stop()` runs is refused as before, with `… refused: the framework is stopping`. `stop()` keeps its cleanup and retry: a failed `stop()` can be called again, and that call waits for what the failed one left running; a completed one called again resolves without tearing down again; one that failed and closed an owned store rejects again with its original error; its waits have no default bound; and a timed-out wait ends the caller's wait while teardown goes on. A `stop()` whose budget is refused, with a `RangeError`, isn't admitted and changes nothing. No sibling package needs a new version.
- **Code that calls `EventGate.resumeSleep()`:** it's removed. It armed a disposed gate's timers again for a lifecycle after a `stop()`, which a framework no longer has, and the framework no longer calls it. A gate's `dispose()` is now for good: it keeps the sleep, as before, and nothing arms a sleep's or a self-wake's timer after it. To go on, create a new `AgentFramework`, whose gate is its own.

- **Hosts:** a model call that stops making progress is now cut
  (agent-framework#378). On an adapter whose stream reports content
  (`AnthropicAdapter`, `BedrockAdapter`), a resident's streamed call, and an
  MCPL server's, gets membrane's progress bounds: before content, 60 s from
  its send, or, once a thinking block has started, the later of that and the
  block's allowance (its `max_tokens` at 87 tokens a second); after content,
  150 s from its last provider event, or the allowance when that event was a
  thinking block's start and the allowance is longer. On every adapter a
  streamed call also ends once the larger of a setup term (the larger of the
  before-content and between-events bounds, 150 s) plus that allowance and
  1,862 s passes with no provider event; an SSE keepalive comment isn't one.
  A compression's, the reply judge's and an MCPL server's non-streamed call
  ends the setup term plus its allowance after its send, or at the larger of
  the setup term and 1,862 s when it names no `max_tokens`, unless its caller
  passed a `progressTimeoutMs` of its own; on an adapter whose `complete()`
  streams under the hood, such as membrane's OpenAI Responses adapter in
  subscription mode, that bound runs from the last provider event instead.
  Before, a call ended only at the Anthropic adapter's own 600 s watchdogs,
  the SDK's request timeout or the runtime's fetch timeout, which still apply,
  and a call kept open with keepalives didn't end. A call that would have run
  past one of these bounds and then completed now fails as a `timeout`.
  **Migration:** `inferenceBounds` raises them, and `inferenceBounds: false`
  sets none of them. The phase bounds act only when the `Membrane` passed in
  comes from membrane 0.8.0 or later; with an older one only the flat bound
  acts, so a host that builds its own `Membrane` raises its membrane to
  `^0.8.0` with this release.
- **Hosts:** `DefaultErrorPolicy` gives a deadline expiry one fresh call,
  1 s later. An expiry is a bound's cut, the Anthropic adapter's watchdogs,
  the SDK's request timeout or a runtime's fetch timeout; the last three were
  thrown as retryable timeouts and got the base schedule's three tries. For a
  deadline expiry the framework passes an `errorPolicy` the count of that
  call's consecutive expiries as `attempt`, in place of the turn's failures,
  so each call a deadline cuts gets its fresh call; a host's own policy reads
  that count too. A quiet call on an adapter without progress bounds now ends
  after two of the runtime's fetch timeouts (on Bun, 360 s each) rather than
  three. **Migration:** settings passed to `new DefaultErrorPolicy(settings)`
  with no `deadline` schedule give an expiry their base schedule, counted the
  same way.

- **Hosts that run `DiscordModule` or `ApiModule`:** a sender's name from
  outside the framework is now stored with each of the framework's notice
  openings in it marked with a backslash before its bracket, as in the text a
  participant or a server supplies, ahead of the name's ` (Discord)` or
  ` (API)`. A name with none of those openings is stored as before. This
  corrects 0.29.0's entry for these modules where it gives the stored form as
  `<username> (Discord)` and `<name> (API)`: from this release, a name holding
  one of those openings is stored in its marked form, and that is the form the
  `ApiServer`'s message list shows wherever it lists such a message. 0.29.0's
  entry on supplied text ends "This change doesn't mark these openings in the
  name a message is stored under, which a formatter writes before the
  message." This release does, for these two modules.

  **Who needs to act:** code that matches senders by a stored message's exact
  participant. As 0.29.0's entry says, read a row's `metadata.author` when it
  has one, which this change leaves as it was.

  **Unchanged:** rows stored before this change keep the name they were
  stored with: a history sync or an edit through these modules may change a
  stored message's content, never the name it is stored under. The generic
  name `user`, in any capitalization, is stored as given.

### Added

- `FrameworkConfig.inferenceBounds` sets how long a model call may go without
  progress: `progressBounds`, membrane's `beforeContentMs`, `betweenEventsMs`
  and `thinkTokensPerSecond`, from which the flat and whole-call bounds also
  derive, and `flatMinimumMs`, by default `FLAT_MINIMUM_MS` (exported). `false`
  sets none. A value it can't use is refused at `create()`, naming the field
  under `inferenceBounds`. One setting covers every agent, so a host with one
  slower model raises the bounds for all of them.
- Settings passed to `new DefaultErrorPolicy(settings)` can carry a
  `deadline` schedule for deadline expiries.

- A host's `executeToolCall` reaches the framework's own tools that the
  agent has, as the agent's own call does (see the Fixed entry on awaited
  tool calls).

- **`workspace--status` for one mount that isn't direct shows its root's
  identity**, whether or not a sync can use the root: `root` carries
  `recorded` and `now` (`recorded` left out where the store's record of disk
  can't be read back), each its device and inode and, where it has one, its
  birth time as an ISO time in UTC to the nanosecond, so whoever upgraded
  can see whether the root's birth time was recorded. Where the root is
  usable and nothing is recorded yet, or no birth time is while the
  directory has one, `root.note` says so, what can pass as the root until
  then, and which call records it (a read-only mount's names no materialize,
  which writes nothing there); while the store awaits reopening it says
  nothing. Where the store's record of disk can't be read back, `status` for
  a mount with no files still answers, as it did, its `root` saying the
  recorded root can't be read, why, and the step that reopens the store.
  `status` for every mount reads no disk: it carries `root` only where the
  mount's last pass couldn't use the root, with `unavailable`, the words
  that pass listed, and `lastPassAt`, when it ran, and none where the last
  pass used it or no pass has run since start.

- WebSocket servers can opt into `credentialRequired: true` with
  `tokenTransport: 'header'` and a host-attached `accessProvider`. Missing,
  throwing, empty or non-sendable providers stop the dial without fallback;
  sendable credentials have no minimum length. Static tokens, URL token
  parameters, userinfo, fragments, non-WebSocket bindings and cleartext
  connections to anything but `localhost` or a literal loopback address are
  refused. Redirects are not followed.
  Dial failures distinguish `provider-failed`, `credential-rejected` (401/403),
  `engine-unsupported` (no numeric upgrade status) and `connection-failed`.
  Runtime support uses structured status capability rather than version pins.
  Optional credential behavior and diagnostic filtering are unchanged.

- `subconscious.physicalWindowTokens` and `subconscious.thinkingBinding`, with
  the same types as an agent's and the same meaning where set, set the
  subconscious reader's own window and thinking binding in place of the
  resident's, on its own model or the resident's: the persistent reader's,
  and each reader fork's. A reader whose `subconscious.model` names another
  model can now have the window projection and the binding its model needs.
  Left out, nothing changes: on the resident's model a reader inherits the
  resident's two fields; on another model the persistent reader has neither,
  and a reader fork has the resident's. `null` counts as left out, and so does
  `false` for the binding, as in an agent's config. An enabled subconscious's
  malformed binding is refused before anything opens, whichever its reader,
  as an agent's is.

### Changed

- A turn that ends on a timeout says so in its `[inference-failed]` note: the
  model call timed out, or its last call did, with the reason, which for a
  bound's cut names the bound that ran out. When that call was a fresh call made for an earlier cut and a
  deadline ended it too, the note says so: "The call was made again, and it timed out again." The cause in parentheses
  is left out when it's only `timeout`. Its closing line says that if a reply
  is still owed from that turn, it can be given now. Other failures keep their
  wording and advice.
- An MCPL server's streamed inference request that ends early is answered
  with the reason and, when membrane gives one, its message, such as the
  bound that ran out: ``The inference stopped before it finished (timeout:
  No content within 60s of the send: … (the host's setting for this bound:
  `inferenceBounds.progressBounds.beforeContentMs`))``.
- A stream cut's reason, in a turn's error and note and in an MCPL server's
  answer, ends by naming the host setting for the bound it hit, such as
  ``(the host's setting for this bound:
  `inferenceBounds.progressBounds.beforeContentMs`)``.

- **Hosts:** a re-armed turn's send (agent-framework#838) that fails with a
  deadline marked as run out, membrane's or a bound the host sets on the
  call (`inferenceBounds`), as when a provider's stream stalls, now counts
  as a transient failure, so a turn that ends on it is re-armed as for a
  transient failure, unless it follows another such cut with no transient
  failure, answered round or message said to the agent between them: two
  such cuts in a row end the re-arming, and the second gets no retry from
  the error policy, even in a re-armed turn that got partway. A transient
  failure or an answered round in any of the agent's turns clears an earlier
  cut, and so does a message said to the agent. Every such cut counts,
  including one the error policy retries or a host's provider hold takes.
  0.29.0 listed a deadline, whether the host set it or membrane marks one as
  run out, among what the re-arm leaves unchanged; that still holds for a
  turn that isn't itself a re-arm.

- **A module's `stop()` now waits for its `start()` to settle** (#882). A
  `stop()` of the framework, or a `removeModule()`, made while an
  `addModule()` was still running the module's `start()` used to call the
  module's `stop()` at once, so whatever the rest of its `start()` set up,
  such as its own timers, outlived the stop that should have ended it. Now
  the module's `stop()` is called once its `start()` has settled, fulfilled
  or rejected, including for a `removeModule()` the `start()` itself makes.
  The framework's `stop()` waits for that within its wait on modules, so a
  `start()` that outlasts `stop()`'s budget fails the `stop()` as a slow
  `stop()` does, and the module's `stop()` runs once the `start()` settles;
  if it never settles, the module's `stop()` is never called. A
  `removeModule()` has no budget and waits for the `start()` as long as it
  runs. So a module's `start()` mustn't await its own removal or the
  framework's `stop()`: both now wait for it, where before its `stop()` ran
  beside it. A `removeModule()` made during a `start()` that then fulfils,
  with no framework `stop()` admitted meanwhile, now announces the module
  added, then removed; before, it was announced removed, then added.

- **Importing agent-framework no longer loads discord.js.** It loads when the first `DiscordJsClient` is constructed, so a process that never makes one doesn't pay for it. On one 12-core machine at a one-minute load of about 17–23, 15 fresh processes each, importing the package took a median 0.37 s where it took 0.66 s under Bun 1.4.4, which loads `src` (run with its transpiler cache off), and 0.65 s where it took 1.00 s under Node 24.22.1, which loads `dist`. discord.js is no longer a static import, so `bun build` leaves it out of a bundle and keeps the call that requires it when a client is constructed: a bundled host that makes a `DiscordJsClient` needs discord.js to be resolvable then, and under `bun --no-install` a bundle with no `node_modules` at or above it can't find it. No export changes.

- **The gate's refusals and file errors say what didn't happen, name each field as its caller wrote it, and say what to do.**
  - **"Rule":** a refusal of a rule's fields opens `Rule "x" wasn't saved`, where it opened `Policy "x"`, and gate_status's notes and the gate's log lines call a rule a rule too.
  - **A placement that names no rule:** `Rule "x" wasn't saved: insertBefore is "y", and no rule has that name.`, with the other rules and the way on, replacing `addPolicy: no policy named "y" to anchor on — have: [...]`. An `insertBefore` or `insertAfter` that isn't a rule's name gets the other rules a change edits and the way on too, or, where a change is refused, that refusal. Over a gate.json the gate doesn't use, these lists and the placement refusals add that gate.json, at its path, isn't in force, that a change is saved only if it brings it into force, and what would.
  - **`passthrough` on a behavior that can't use it** names that behavior as given and says to leave `passthrough` out, replacing `passthrough is only valid with rate_limit or passive_sample behaviors — for "debounce:60000" …`. **A regular expression the gate can't read** says to fix it, or to give `match.filter.type` `"text"`.
  - **`wake_add_rule`'s own refusals** of no behavior, more than one behavior and more than one placement say nothing was saved, and `wake_remove_rule`'s refusal of a missing `name` says nothing was removed and names the rules a change edits, or, where a change is refused, gives that refusal.
  - **A gate.json the gate can't use:** where it can't be read, isn't JSON, or is JSON the gate refuses (neither an object nor a list, a `default` other than the three, a rule left out that could wake the agent under a `default` that holds events back), gate_status's error opens `gate.json, at <path>, …`, says what the gate runs meanwhile as before, and ends with what to do. Where it can't be read or isn't JSON, the error opened with the bare filesystem or parse error, and where it was refused, it named no path and nothing to do. The `[gate]` line ends with what to do too, and a change refused over gate.json names its path; a write that fails gives the filesystem's error, as before.
  - **The privileged-users file:** a file that can't be read, isn't JSON or holds no list gets an error naming the file's path, how many ids of the list that last loaded stay privileged meanwhile, or that no one is, what makes it load, and that replacing it with a file holding `[]`, or removing it, makes no one privileged at the gate's next check for changes. Each of these used to read `Failed to load privileged-users file: …`. The error naming entries that aren't user ids names the path, how many ids did load and are privileged, and that the gate reads the file again once those entries are user ids.
  - **Supplied text is escaped once, with the framework's escaping for it (`quotedValue`):** text from gate.json or the privileged-users file that a refusal, gate_status or a `[gate]` log line quotes, such as a parse error's excerpt, a rule's or a field's name, a value, a scope's event types in a shadow warning, or the rule names in a start's recipe line, and a value a refusal shows, including one the agent sent. So a UTF-16 file's NULs reach the agent and the log as `\u0000`, where they came through raw. An error from reading or parsing either file is now quoted, in double quotes, in these texts, and gate.json's in the `gate:config-error` trace's `error` too.

- A stream whose tool calls don't declare `supportsInjectedMessages` is read
  as one that doesn't carry injected messages: what's queued for the agent
  waits for the turn's end, as on membrane's XML path. membrane's yielding
  stream, the only one the framework continues across tool rounds, declares
  it on both paths, true on the native path and false on the XML path. A
  tool boundary with no stream, as the direct API's, stores what's queued as
  before.

- **Operators:** an MCPL server this host won't connect again on its own now
  raises the `mcpl-down` ops alert once: a `failures.log` record, an
  `ops:alert` trace, and the webhook within its 15-minute throttle.
  - A startup connect that fails, leaving nothing connected and nothing to
    retry it: a server without `reconnect: true`, a configuration refused
    before anything launches, a protocol-version verdict, or a launch that
    couldn't be reaped. 0.28.0 alerted only for the last two, so a stdio
    server that exited before its handshake, as one started before the
    network is up does, left one stderr line and its traces, and no alert.
    The alert now reads "MCPL server not connected at startup, and this host
    won't retry it on its own: <error>", where 0.28.0's read "MCPL server
    unreachable at startup: <error>". A startup failure that leaves a
    retrying connection raises nothing at startup: its fifth failed retry
    raises the alert, or a retry that fails for good does, as before.
  - A connected server that closes on its own with no reconnect coming: "MCPL
    server closed (<reason>, code <n>), and this host won't reconnect it on its
    own", with the transport's own reason and its exit or close code or signal
    (a WebSocket peer's close text is left out, as the trace leaves it out), or
    "MCP server closed (<reason>, code <n>), …" for a modern server. 0.28.0
    raised nothing. A close this host makes (`stop()`, `disconnectMcplServer`,
    `restartMcplServer`) raises none, and neither does a loss once `stop()` has
    begun, whatever its cause, since it is part of the close the host is
    making. Nor does a loss that reconnects, nor one whose launch couldn't be
    reaped, which already raises the alert.
  - A child that ends the way a server ends when asked to is taken as stopped,
    not lost, and raises none: an exit with code 0, death by SIGTERM, SIGINT
    or SIGHUP, or a shell's report of such a death, exit code 143, 130 or 129.
    A service manager's stop (systemd's default, for one) signals the host and
    its children together, so a child can go before the host's `stop()` closes
    it, and a server that catches SIGTERM may exit 0 instead. So a connected
    server that exits 0, or with one of those codes, on its own isn't
    reported. Any other exit code, SIGKILL, SIGABRT or any other signal still
    alerts, and so does a child the stdio transport ended itself after an
    error on the child's stdin or stdout, whatever its code or signal. After
    such an error the transport now waits up to 2 seconds for the child to
    exit on its own before ending it, so a child that was already gone, as
    one a stop's signal reaches while the host is writing to it, closes with
    its own code and signal. A live child whose pipe failed is ended up to 2
    seconds later than in 0.28.0; its connection is unusable by then.
- **Operators:** a modern stdio server's loss now carries its child's exit
  code and signal, as a legacy server's does: the `mcpl:server-closed` trace
  carries them, where 0.28.0 gave `null` for both, and its `reason`, which
  0.28.0 left out, is "child process exited" where the loss read "transport
  closed".
- **Operators:** a modern stdio server whose connect fails now carries the
  last of the child's stderr, redacted, as a legacy server's failure does. A
  failed first connect's "Failed to connect MCPL server" or "initial connect
  failed, will retry" line prints it, and the `mcpl:server-connect-failed`
  trace carries it as `stderrTail`, for the first connect and for each failed
  retry. The alert leaves it out, since the webhook posts outside the process.
  0.28.0's lines gave only the SDK's error, such as "Version negotiation probe
  failed: Connection closed during the version negotiation probe", and the
  child's stderr only as `mcpl:server-stderr` traces.
- **Hosts:** `restartMcplServer`'s doc no longer says that `reconnect: true`
  doesn't respawn a stdio child: each reconnect attempt spawns the child
  afresh, once the connection has failed or the child has exited.

- **A line longer than 104,857,600 UTF-16 code units (100 Mi) on a stdio
  MCPL server's stdout now ends that server's connection.** This host
  refuses the line as soon as a read takes it past the bound, takes no line
  from stdout after it, writes nothing more to the child, and ends it at
  once with SIGTERM, then SIGKILL if it outlives that. Requests in flight
  fail with the disconnect when the child exits, unless their own deadline
  comes first, and a request made after the line and before the exit is
  refused as not sent.
  The close's `pipeFailed` is `true`, so a server that doesn't reconnect
  raises `mcpl-down`, as after a pipe failure. Each UTF-16 code unit is at
  least one byte of UTF-8, so such a line is also longer than 100 MiB, the
  per-message bound `ws` 8.22.0's client sets on the WebSocket path by
  default.
- **A stderr line longer than the same bound is dropped,** with one line in
  its place saying so, `[a stderr line longer than 104,857,600 UTF-16 code
  units was dropped]`, and the connection stays up. Stderr lines that arrive
  before anything listens for them, on either engine, are held to the newest
  200 lines and to the same bound in total: past either, the oldest whole
  lines go, and the first line handed on says how many went, `[N earlier
  stderr lines were dropped: unread stderr is held to 200 lines and
  104,857,600 UTF-16 code units]`. On the modern engine that replaces a hold
  of the newest 200 lines with no bound on their length, which dropped older
  ones with no notice. Two holds are as before: the legacy
  connection's own queue, which while its control plane is closed (until
  it first opens, and from each reconnect until it reopens) holds up to
  1,000 events that need no answer, stderr lines among them;
  and the transport's stdout lines, held with no count bound whenever no
  `'line'` listener is attached.
- **The bound counts characters, not memory.** An unfinished line that
  arrives in very small reads takes more memory than its characters until
  its line end: up to about 32 bytes a character at one character a read.
- **`McpServer.start()`, and so the `agent-framework-mcp` command, exits the
  process with code 1** when a line on its stdin is longer than the same
  bound, after one stderr line naming it.
- **The words for a stdio server whose stdio this host stopped using have
  changed.** Where this host's messages said "its pipe failed with X" or
  "stdio pipe failed with X", they now say "this host stopped using the
  server's stdio (X)". A close's reason reads `child process exited, and this
  host had stopped using the server's stdio (write EPIPE)`, and so do the
  `mcpl:server-closed` trace's `reason` and the `mcpl-down` alert that quotes
  it. For a line past the bound, X is "the server wrote a line on stdout
  longer than 104,857,600 UTF-16 code units". A loss whose child outlived
  SIGKILL ended "and its child outlived SIGKILL", and now ends "and the
  server's process outlived SIGKILL". A host that matches the old words
  needs the new ones.

- The workspace wake notice writes a changed or conflicting path that doesn't show as itself as one line of JSON, which parses back to the path. A path that shows as itself is written as before.
- A script's ending gives a failure's name and message, a crash's detail and a stop's reason on one line, with any of the framework's openings in them marked, in the notice sent when a script the agent left running ends and in the code-execution tool's own results. A stop's reason is cut to 300 characters, as the script list already cut a failure's message.
- A timed-out call whose answer came later is listed in the code-execution tool's results with that answer as JSON that gives it back on one line, with NEL, U+2028, U+2029 and any of the framework's openings escaped. A `wake_agent()` payload is written into its notice the same way.
- The tool lines that opening or looking at the built-in toolset or a tab show give each tool's first sentence as a toolset's listing does: on one line, with any of the framework's openings marked.

- **A turn keeps the messages it opened with whole.** At a start that opens a turn, the framework pins raw, with context-manager's `pinRange` and the name `agent-framework:turn-inputs`, the rows the agent sees that were stored after both the newest of its own messages that it sees and its consumed watermark (the store's head as of its last committing compile, or of its last tool boundary whose injected messages its stream carries), starting at the first such row that holds more than tool results. Until the turn ends, or a compile drops the pin as the next bullet says, its compiles, a `maxStreamTokens` restart's included, render those rows raw, where 0.30.0 lets compression fold them once they leave the recent window, so a long turn whose older rounds are summarised no longer loses the request it is answering. Their tokens count against the budget. A row inside the range that the agent doesn't see, such as a tuned-out message, stays out of its view, as before.
- **When a committing compile refuses as over budget (`OverBudgetError`) while a pin of that name is held,** the pin is removed, a `[turn-inputs]` line is logged, and the compile runs once more, so the turn goes on as it would have without the pin, a refusal included. A dry run never removes it.
- **The pin is removed** when the turn ends, whether it settles or its start or continuation is dropped, at `stop()`, and otherwise at the agent's next start that opens a turn, which first removes any pin of that name, one left by a process that crashed included. A silent heartbeat tick's start removes one too, and pins nothing. While the turn holds the pin, `listPins()` on the agent's context manager shows it. An agent whose strategy has no pins gets none.

- Two readings kept for inputs no supported dependency produces are gone.
  In XML tool mode, a round's persisted text is its `roundPreamble`, which
  every membrane from 0.5.79 sends (the floor is 0.8.0); a round without one
  no longer falls back to the cumulative `preamble`. A Discord awareness
  ledger at version 1, which only an unreleased commit wrote, is refused with
  the message any version but 2 and 3 gets.

### Fixed

- **An `addModule()` whose `start()` is still running when the framework's
  `stop()` is admitted is refused** (#882). Once that `start()` fulfils, the
  `addModule()` rejects with the refusal an `addModule()` made at that
  moment gets, which follows the stop's state then, and no `module:added` is
  emitted for the module; before, it resolved and the module was announced
  after the framework had already stopped it. A `start()` that rejects
  rejects the `addModule()` with its own error, as before.

- An agent that's stopped, ended with its parent, or disposed as a fork now takes its failure accounting with it: its consecutive-failure streak, its poison-history rewind count, its refusal streak, rewind count and rewind episode, the mark that its last timed-out call was made again, and an open `/unstick` session, which it says on stderr has ended. That holds for a bounded job stopped, or its activation cancelled, while it runs, too. A new agent created under the name, or a job resumed after such an end, meets its first failed request as its first, so it isn't reported hard-down, and the poison-history breaker doesn't set aside its own message, on one refusal. A job whose run ended on its own, by a failure, a refused turn, its deadline or an abort of its call, keeps what failure accounting it has when it's resumed in the same process, since a resume reopens the same history and a history refused across resumes is what the streak is for; of that accounting, only the made-again mark goes at its end.

- **An awaited tool call now goes where the agent's own call of the tool
  goes.** The admin puppet (`puppetToolCall`), a host's `executeToolCall`
  and a module's `ModuleContext.callTool` take the routing the turn's
  dispatch takes, in its order. Before, an awaited call of `agent_settings`,
  `save_recent_image`, `read_image`, `fetch_reference`, `gate_status`,
  `event_tags`, `wake_add_rule`, `wake_remove_rule`, `sleep`, `wake`,
  `think`, `journal`, `skip_reply` or `prose_help` reached the module
  registry and failed with "Invalid tool name format", and the puppet stored
  that failure in the agent's window as a call the agent had made. Now,
  for each of these tools the framework has (the gate tools only with an
  event gate, and `think`, `journal` and `skip_reply` only with a channel
  registry, which an MCPL server brings):
  - a call of one with agent origin (the puppet's, and a host's) runs the
    handler the agent's own call runs and gets its answer, except
    `skip_reply`, which ends the turn it's called in, while an awaited
    call isn't made in a turn: a host's call of it gets a refusal
    and does nothing, and the puppet refuses it, by name or through a
    `toolsets--act` that reaches it, before anything runs or is stored, as
    it refuses a tool that isn't on the agent's surface. A `sleep` made off
    a turn posts no announcement, as a script's sleep after its turn
    already doesn't;
  - a module's call of the agent's own tools, `think`, `journal`,
    `skip_reply` and `drafts`, is refused with a reason that says so, and
    does nothing, and a module's call of the others runs for the agent its
    `callerAgentName` names;
  - where the dispatcher would answer one of these calls with a refusal
    (such as a conversation fork's `sleep`), the awaited call gets it
    without `refused`, which `ToolResult.refused` says a programmatic call
    never carries;
  - the puppet's check that a tool is on the agent's surface reads the
    tools the agent may call, so an explicit-prose agent's `prose_help` is
    on it;
  - a `fetch_reference` whose work throws before it answers, such as one
    whose `ref_id` has no text form, now answers with the error, on the
    turn's path too, where before no result came from it;
  - a `save_recent_image` that isn't one of its round's own calls, such as
    a module's from inside its own pending tool call, doesn't wait on that
    round's other calls, which would include the call that made it.

- **agent-framework now asks for `@animalabs/chronicle` `^0.5.1`**, where it asked for `^0.5.0`. chronicle 0.5.1 stores JSON objects with their keys in the order they were written (in a JavaScript object, its own property order) and hands them back that way, where 0.5.0 sorted them. Where agent-framework opens a store itself, from `storePath` or in offline recovery, it does so with its own copy of chronicle, so asking for `^0.5.1` makes every install of agent-framework take that fix for those stores, whatever range the host or another package asks for. A store the host opens and passes in as `store` follows the host's copy of chronicle, which this range moves only where the installer shares one copy of chronicle between the host and agent-framework. Nothing is migrated: as chronicle 0.5.1's changelog says, objects written before through its JSON-writing methods keep their sorted keys, and objects stored before as raw bytes now come back in the order of their bytes (in a JavaScript object, its own property order), so a request built from them can change once after the upgrade.

- **Hosts with a `providerHold`:** a wake parked on provider admission behind
  an auxiliary call (compression's kind) now goes back to the scheduler if a
  provider hold is pending for its agent when the auxiliary work it waited
  for has settled, and the scheduler judges it as it judges a new wake: a
  hold that stands keeps it, and it starts with that hold's other kept wakes
  once the hold releases. Before, it went on into its turn's call: when the
  auxiliary call's failure had armed the host's hold, that call went into the
  quota the host had just said was spent.

- A wake the scheduler merged from several wakes and took back before its
  turn started (held by a provider's stated wait recorded after it was
  scheduled, or sent back from its wait for an auxiliary call by a quiesce or
  a turn still alive) is merged again from the wakes it took in, each as it
  was. It was merged again as one wake, which lost what its first merge had
  decided:
  - Merged from two or more deferred coalescing batches, it no longer counted
    as batch-only. When none of its batches had anything for it by then (each
    retracted, displaced, or taken by another agent's assembly), its turn
    called the model with nothing new to read, where the turn is withdrawn
    with `turn-withdrawn`.
  - It kept its first wake's time, so merged with a later-queued wake for an
    older message, such as a gate's batched wake, it gave the turn that
    message's channel instead of the newer addressed message's it stood for.
- A merged wake whose every wake is withdrawn while it waits in the queue, in
  a provider hold or in a scheduler pass is withdrawn with them, and starts
  no turn. If it still waits as one wake, not yet taken back apart by a
  scheduler pass, and its wakes were deferred batches of more than one
  subject, it traces `turn-withdrawn` naming them as the last goes, with the
  stderr line `[coalescing] <agent>: its deferred batches were withdrawn
  while its wake waited; turn not started (no wake cause left)`.
  `HostModeStatus.gatedRequests` counts a merged wake as the wakes it took in.
- A provider hold whose kept wakes are all withdrawn while it holds them, as
  a deferred batch's wake is when the batch is retracted, now releases
  without starting a turn, with the stderr line `[provider-cooldown]
  agent=<agent> hold, its held wakes withdrawn, released after <ms>ms`. Its
  release queued a wake of its own (`provider-acceleration-retry`), whose
  turn called the model with nothing new to read.

- **`wake_add_rule`'s refusals named fields the agent never sent.** A refusal of a `debounceMs`, `rateLimit`, `passiveSample` or `judge` now names it so, and its fields as, for example, `rateLimit.tokens`, where it named gate.json's `behavior.debounce`, `behavior.rate_limit.tokens` and `behavior.passive_sample`. A behavior given as an object, in gate.json's form, is named as written there.
- **A placement naming the rule it replaces** was refused as naming no rule, though a rule had that name. It now says a rule can't be placed beside itself, and gives the other rules and the way on.

- **`workspace--status` names a mount whose root a sync can't use**, where
  it said nothing while `sync` and `materialize` skipped every file of the
  mount. Asked for that mount, its entry carries `root`: `unavailable`, the
  words `sync` lists under `incomplete` for the mount's root; `recorded`,
  the root identity disk last agreed under (`dev`, `ino`, and `born` where
  one was recorded), or null, and left out where the store's record of disk
  can't be read back; and `now`, the identity of the directory at the root's
  path, or null where no directory could be checked there. That covers
  nothing at the path, something there that isn't a directory, another
  directory, and the recorded inode on another device. A root this process
  can resolve but not list is named by `sync`'s and `ls`'s walk, as before,
  and not by `status`. `canMaterialize` is false wherever that entry's
  `root` has `unavailable`, since `materialize` writes nothing there.
  `status` for one mount checks its root on disk, so a root on a network
  mount that doesn't answer holds that call, as it holds that mount's
  `sync`, `ls` and reads. `status` for every mount reads no disk: an entry
  whose mount's last pass couldn't use the root carries `root` with
  `unavailable`, the words that pass listed, and `lastPassAt`, when it ran.
  An entry with no `root` is one whose last pass used the root, or a mount
  with no pass since start: one watched `always` runs a pass when its
  watcher is ready, and others when a call does.
- **A directory made again where the mount root was removed, born after it,
  is another directory** where the root's filesystem keeps a birth time
  fixed: on Linux, ext2/3/4, xfs, btrfs, tmpfs, f2fs or zfs, as `statfs`
  names it. It passed as the root when it had the old one's inode, as ext4
  gives it, and is now refused in the replaced-root words. On any other
  filesystem, overlayfs included, and off Linux, the rule before this change
  decides: the same device and inode, or on another device the same birth
  time below the second: overlayfs gives a directory it copies up from a
  lower layer a later birth time under the same device and inode. A birth
  time earlier than the recorded one still passes on its device. A birth
  time equal to the ctime counts as none, so it is neither recorded nor
  compared: Node reports one where `statx` is unavailable, such as under a
  seccomp filter that blocks it, and a directory nothing has changed since
  it was made has one too. So where either side has no birth time, a
  directory with the old device and inode still passes, as before: anywhere
  `statx` is unavailable; where the record has none, as releases before 0.28
  left it; and for a directory just made in the root's place until something
  changes in it after the clock's first tick.
- **A mount root with the inode disk last agreed with, on another device
  number, is named as that** where the birth times can't tell the two apart
  (either side has none, as releases before 0.28 recorded roots; or the
  root's is no later than the recorded one, or its filesystem doesn't keep a
  birth time fixed, without both being the same time to below the second):
  "the mount root has the inode disk last agreed with, but another device
  number: a reboot can renumber a volume, and another volume mounted at the
  same place can have a root with the same inode; whoever runs this host can
  say which, and if it is the same directory, a sync of the mount with
  acceptRoot takes it as it is now; if not, they can mount the right
  volume". It was named as an unmounted drive or a replaced directory.
  `status`, `sync`, `ls`, `materialize` and `read` give the new words, and
  so does `readFileFromDisk`'s `Mount unavailable:` message, whose code is
  unchanged.
- **The replaced-root refusal says who can act on it**: "the mount root is
  not the directory disk last agreed with (an unmounted drive, a directory
  moved aside, or a replaced one); whoever runs this host can say which: a
  drive they can reconnect, a directory moved aside they can put back, and a
  replaced directory a sync of the mount with acceptRoot takes as it is
  now", where it ended "reconnect it; if it was replaced on purpose, sync
  the mount with acceptRoot to take it as it is now". Its code and fields
  are unchanged.

- **Operators:** once `stop()` has begun, no MCPL server with `reconnect: true`
  is launched or dialed again on its own. A server lost just before or during
  a stop, as when a service manager signals the host and its children
  together, kept its retry timer, so when `stop()`'s waits (a stream, a
  script, an operator operation) outlasted the retry's delay, 3.75 to 6.25
  seconds at the defaults, its stdio command was started again and could
  reconnect before the teardown closed it. A server such as a Discord bridge
  logs in to its service before it serves, so that start did outward work for
  nothing. Now `stop()`'s first step stops every connection reconnecting: a
  retry already scheduled starts nothing, none is scheduled after, and a
  legacy retry already under way is aborted, so one still waiting on its
  access provider never dials. A modern retry already under way has spawned
  its child or opened its connection, and is ended by the teardown's close,
  as before. This covers a server whose first connect failed too: its
  background retries stop as well.

- **MCPL server authors:** a server's `inference/request` still running when
  the host calls `stop()` is now answered `-32000` "the host stopped while
  handling this request" (#418). Before, it got no answer, and failed on the
  server's side when the connection closed. It's the answer a request whose
  handler fails while the host is stopping already gets, so the server can
  send the request again to the host's next run. The host writes it before it
  closes the connection; a stdio server, which the close sends SIGTERM, may
  exit before it reads it.
- **Hosts:** `stop()` now aborts the provider call of each MCPL server's
  `inference/request` still running, in the step after it closes its queue.
  Before, the call ran on, and billed, until it finished or timed out, and its
  answer was dropped. The request's `mcpl:inference_fail` trace carries the
  stop answer's text. `stop()` then waits for each request to end, within its
  wait on modules and MCPL, so with a budget a `stop()` still takes up to six
  waits. A streamed request ends when membrane ends its stream, which
  membrane 0.8.0 does at the abort. A non-streamed one ends when its
  `complete()` settles, which with membrane 0.8.0 is at the abort too. A
  `complete()` that ignores the signal now holds `stop()` until that wait's
  budget runs out, or without a budget until the call ends, where before
  `stop()` didn't wait for it; the timeout names
  `inference/request:<server id>`.
- **Hosts:** when the transport an MCPL server's `inference/request` came on
  closes while its inference runs (the server's process exits, its connection
  drops, or the host closes or removes the server), the provider call is
  aborted, rather than running to its end for an answer nothing can receive.
  The host answers nothing, and when the abort ends the call, the request's
  `mcpl:inference_fail` trace says the transport the request came on closed;
  a call that completed before the abort reached it is traced as completed.

- **A module no longer acts once its `stop()` has completed,** through
  `removeModule()` or the framework's `stop()`, except that after
  `removeModule()` the result its `handleToolCall` returns for a call it was
  already running is still delivered while the framework runs (below).
  Before, a removed module's context could go on writing its state and log
  state, which a later module of the same name
  then read as its own, adding and editing messages in an agent's window,
  calling other modules' tools with module origin, pushing events that
  every remaining module processed, registering or removing speech
  handlers under its name, sending ops alerts, and receiving traces. And
  an event already being dispatched could still call the removed module's
  `onProcess`, with a later namesake's context, apply its response,
  writing its state update into a namesake's state, and call its speech
  handler on a namesake; and a turn whose context was being gathered when
  its removal completed still took its `gatherContext` answer. Now, once a
  module's `stop()` has completed (a module added again under its name,
  even the same object, is a new registration, which none of this
  touches):
  - each push through its context is dropped with a log line, as a push
    after the framework's `stop()` is: per push, since a tool result's line
    names the call, the tool where the event names one, and whether it
    succeeded, which an operator reconciles call by call;
  - `setState`, `registerLogState`, `appendToLog`, `editLogItem`,
    `editMessage`, `removeMessage`, `notifyOps`, `registerSpeechHandler` and
    `unregisterSpeechHandler` do nothing; `addMessage` returns `''` and adds
    nothing; `callTool` resolves with an error result and runs nothing;
    `getModule` returns `null`; and `onTrace` subscribes nothing, while the
    subscriptions made through the context end, and do nothing even if the
    registry's unsubscribe throws. None of these throws, so a
    late callback can't fail the host, and the first call of each method
    logs one line naming the module and the method;
  - `findMessageByExternalId` answers without updating its mapping; reads
    answer, and fail, as before;
  - its `onProcess`, `onAgentSpeech` and `onToolBatchComplete` aren't called
    again, and a response of its that hadn't been applied is dropped whole,
    with a line naming what it asked for if it asked for anything. A push it
    made while registered still runs, since a push is its message to the
    others, made while it was there, whereas applying a response would act on
    its behalf after it's gone;
  - its `gatherContext` answer is left out of a turn whose answers the
    registry hadn't merged when its `stop()` completed, with a line if it
    held injections; a stop that completes after the merge leaves that
    turn's context as it was;
  - a module added later under its name has its `onToolBatchComplete`
    called, even while the stopped module's own hook is still running past
    its bound.
- **After `removeModule()`, the result a module's `handleToolCall` returns
  for a call it was running when its `stop()` completed is still delivered
  while the framework runs,** like a push it made while registered: the
  agent asked while the module was there, and the result is the true
  answer to what ran. An error in its place would
  tell the agent a tool that ran didn't, and dropping it would leave the
  call unanswered. A response differs because the framework applies a
  response for the module, after it's gone. A result the module pushes
  through its context after its stop completes is a push like any other:
  it's dropped, with the line that names the call, the tool and whether it
  succeeded. The framework's `stop()` closes its event queue before it
  stops any module, so through it that result is dropped, with the line any
  tool result arriving after the framework's `stop()` gets, as before.
- **A module may still write from inside its own `stop()`,** and a module
  whose `stop()` fails stays registered with a working context, for the
  retry.
- **A push dropped after the framework's `stop()` keeps today's line.** A
  `ModuleRegistry` a host builds itself, such as one its tests build, drops
  a stopped module's pushes too, with a line of its own for each, and
  doesn't queue them.

- **`save_recent_image` takes null or an empty string for the selector a caller isn't using.**
  `ref` is now advertised as string-or-null and `index`/`count` as integer-or-null, and
  null, an empty string and omission all mean the selector isn't used. Callers whose
  provider presents every property as required can therefore save by `ref` or by
  `index`/`count`; before, `ref: null`, `ref: ""` and `count: null` were all refused, so
  neither selector worked for them. Any other supplied value is checked, never read as
  absent: a whitespace or malformed `ref` is refused, and an `index` or `count` given as a
  whitespace string, a boolean, an array, or a numeric string other than decimal digits
  (`"2.0"`, `"+2"`, `"1e0"`, `"0x2"`) is refused, as an out-of-range one is, instead of
  being coerced. Before, `Number()` read such an `index`: `" "`, `false` and `[]` as 0,
  which saved the newest image, `true` as 1 and `[2]` as 2, which saved the second- and
  third-newest, and `"2.0"` or `"+2"` as 2; a `count` was read the same way, then
  range-checked. Integer numbers and decimal-digit strings, with surrounding whitespace
  trimmed, are accepted within each selector's range (`index` from 0, `count` 1..20) and
  within the integers a number holds exactly, so a value past them is refused rather
  than read as a different number. A malformed `ref` beside an `index` or `count` in use is
  refused with a note that null, or leaving the selector out, marks one that isn't used, as
  the conflict refusal of a well-formed `ref` beside them says. A refusal of one selector on
  its own carries no such note: dropping a lone `ref` would save the newest image, and
  dropping `index` or `count`, which together are one selector, would save other images than
  the call named.
- **`drafts` reads its nullable fields by the same rule.** An empty string now means
  `draftIds`, `destination`, `confirmDuplicate` or `offset` isn't in use, as null and
  omission already did, so a caller that fills the fields it isn't using with `""` can
  use the tool. Before, `{action: "list", destination: ""}` was refused as passing a
  field `list` doesn't use. `confirmDuplicate: false` is now taken as "don't confirm" on
  `list`, `read` and `dismiss` too, as the field's description already offered. `offset`
  is read as `index` is, so one past the integers a number holds exactly is refused;
  before, it was read as a rounded number, past every draft.
- **The selectors' schema uses JSON Schema type arrays** (`["integer", "null"]`,
  `["string", "null"]`), as `drafts` and `set_tool_description` already did. Membrane 0.7.0
  and later send a tool's schema to Gemini as `parametersJsonSchema`, so the arrays reach it
  as JSON Schema. A host whose own membrane is older than 0.7.0 still sends them as the
  function declaration's `parameters`, where Gemini's `Schema.type` takes a single type.

- A server's listing in `toolsets--look` writes an openable toolset's options as an object of its parameters again, such as `{size?: 9|13|19 =9}`. 0.29.0 and 0.30.0 wrote a stray `"(` after the opening brace, as `{"(size?: 9|13|19 =9}`.

- A tuned-out channel's cancel writes its backlog dump and makes it
  durable before it records the tune-out's end, as the all-except hold's
  release already ordered them. A cancel that failed between the two, from
  a write that threw or a process that died, left the tune-out ended with
  no dump: its held messages stay out of every resident's window, so
  nothing delivered them, at a restart either. Now a failure before the
  end record, a dump that couldn't be made durable included, leaves the
  tune-out (or the all-except hold) in force, and a later cancel, in this
  process or after a restart, dumps the stored held messages no earlier
  dump covered. Each dump records the held messages it covered, those its
  cap left out among them, so a retried cancel shows none of them twice. A
  tune-out whose writes keep failing stays in force past its end time, its
  cancel tried again every minute, and so does one whose queue of writes
  waiting to be stored is over its cap, until the queue is back under it;
  one that reached its end time while the process was down is tried the
  same way, and the start goes on. A tune-out past its wake budget is
  cancelled at the start too, and its cancel, like an end time's, is tried
  again every minute while it fails. A tool close of the excepted channel
  whose release fails is refused and not recorded: when the release fails
  before the hold's end is recorded, the hold stays in force; when it
  fails after, the hold has ended.

## 0.30.0 — 2026-10-29

### Breaking

- **Hosts:** `speech.locus` defaults to `'delivery'`, and a `channel_publish`
  with no `channelId` goes where the calling turn's plain speech would. A
  host that relied on its agents' prose or publishes reaching the channel
  of the latest message needs to act.
  - **Before, plain prose** (under prose routing by locus, `'locus'` or
    `'hybrid'`): a turn no channel message woke fell back to the channel
    of the most recent inbound message (a reaction, an edit, a deletion or
    a system notice aside), unless it was a conversation fork's, a
    heartbeat's, a `noChannel` turn or an ephemeral agent's, as now. An
    addressed message injected mid-turn from another channel moved the
    turn's speech to that channel, and so did one that arrived between the
    turn's streams, at its next start.
  - **Before, `channel_publish` with no `channelId`:** it went to the
    channel of the most recent inbound message (the same markers aside),
    whichever turn called it or whether or not one did. A conversation
    fork's own call went to its home, as now, but one a host made for it
    through `executeToolCall` took the latest message's channel, and now
    takes the home. It was refused when there was none or the caller was
    an ephemeral agent.
  - **Now, plain prose** (under prose routing by locus): only the delivery
    that woke a turn, a conversation fork's home channel or a channel the
    agent opened during the turn sets its locus. A turn with no locus falls
    back only to an open all-except tune-out's excepted channel, and
    otherwise keeps its prose private; a heartbeat's turn, a `noChannel`
    turn and an ephemeral agent's take no fallback. An addressed message
    from another channel moves nothing, and the agent is told, once per
    channel per turn, in a `[routing]` notice.
  - **Now, `channel_publish` with no `channelId`:** from a turn, it goes to
    the turn's locus, else a conversation fork's home channel, else the
    channel of the message that woke the turn, else the fallback. Made
    outside any turn, as a script left running after its turn makes, it
    goes to a conversation fork's home channel, else the fallback. The
    fallback is only an open all-except tune-out's excepted channel, and a
    heartbeat's turn, a `noChannel` turn and an ephemeral agent don't take
    it. The call is refused when none of these names a channel.
  - **Migration:** `speech: { locus: 'latest-inbound' }` brings back the
    re-pins on an addressed injection and on an arrival, and makes the most
    recent delivered inbound message's channel the fallback again, after
    an open all-except tune-out's, for prose and for a publish. No setting
    sends a publish from a turn there ahead of the turn's own channel, or
    from a turn that takes no fallback: a publish meant for it names its
    `channelId`.
  - **Unchanged:** a `channel_publish` that names its `channelId` goes to
    that channel.

### Added

- The admission stage (Dendrite §D, issue #232 §3.5): every inbound channel
  message and push event passes one decision — captured, recipients, body or
  hold, wake, locus — before anything acts on it (`src/admission/admit.ts`,
  traced as `admission:decided`). The wake gate runs after the hold, so a
  held message never forms a debounce batch; for a held message it is only
  probed, and that verdict preconditions the reader's wake. Gate batches
  re-check the hold at delivery (`gate:held-dropped`).
- `speech.locus` (`'delivery'` | `'latest-inbound'`): where plain prose goes
  when nothing names a destination. The default `'delivery'` is the §3
  carve-out: only the waking delivery, a fork's home or a channel the agent
  opened this turn sets the locus; incoming traffic never moves it, between
  turns or mid-turn; a turn without one keeps its prose private with a
  `[routing]` notice. `'latest-inbound'` restores the previous rule.
- Tune-out without a reader (#232 §3.3): the coordinator exists whenever
  MCPL channels do, a persisted epoch is always resumed and released, and a
  tune-out without a subconscious is a silent hold. `tuneOut.enabled` offers
  `tune_out` to residents when no reader is configured.
- `tune_out` and `cancel_tuneout` take `serverId`; a channel id that exists
  on several servers is refused as ambiguous.

- The all-except scope (issue #232 §3.2; focus folded into tune-out):
  `tune_out` with `scope: 'all-except'`, or its alias `focus`, holds every
  channel except one — DMs and channels registered later included — for a
  mandatory `durationSeconds`. A turn with no delivery of its own speaks into
  the excepted channel. `mode: 'check'` reports held counts per channel and
  peeks one channel without releasing; release is per channel, each capped.
  A per-channel epoch takes precedence; the reader may end the scope;
  exhausting the reader's wake budget pauses reader wakes rather than ending
  the hold (`tune-out:wake-budget-paused`); closing the excepted channel ends
  it. Listed by `listPolicyEpochs()` as a tune-out epoch with
  `scope: { kind: 'all-except', except }`.
  Entry and release are announced in the excepted channel as one bracketed
  line each under the resident's name (`tuneOut.announce`, default true;
  traced `tune-out:announced` / `tune-out:announce-failed`).
  Its end time and cadence hold any length: both run on timers no longer
  than one holds, as a channel's tune-out does since 0.22.3, so a hold or a
  cadence past 24.8 days ends or ticks when it should rather than at once.
  `focus` reads its options as `tune_out` does: a value that gives no finite
  number is refused, naming it, before anything changes; a numeric string is
  read as its number; a `null` option counts as left out; and the duration
  is still required.

- `bench/dendrite/cache-acceptance.mjs`: a live acceptance run for the Dendrite
  rendering contract — a folding resident, a fork at the boundary and a fork
  derived mid-tool-call, each request's `cache_creation`/`cache_read` against the
  resident's own reuse. Measured 2026-10-10 on Claude Sonnet 5.5 (one model, one
  route, a synthetic 40-message history): the fork at the boundary read 10,193
  cached tokens and wrote 29; the fork derived mid-tool-call read 10,230 and
  wrote 152; the resident's own reuse read 10,173. Reuse follows the cache markers
  the strategy emits (autobiographical: messages; passthrough: system and
  tools only).

- A derived agent's source is told of it (#270, for Linn): by default every
  derivation puts one host-framed `[Agent lifecycle: … was derived from you as a …]`
  line in the context of the agent it was made from — the fork's name and
  kind, whose weights run it, what it inherits, where its result goes and
  what ends it; a resumption says so. Stamped `kind: 'agent-lifecycle'`
  with the record's fields under `dendrite`. No wake; a host's
  `dendrite.derivationNotice` can replace the line or send none. The fork
  never inherits the notice about itself; an ended source is told nothing.
  After `dendrite.collapseDerivationNoticesAfter` derivations of one kind
  from one agent (default 10; 0 never collapses), the source hears a count
  line every so many instead, with the latest described and
  `dendrite.collapsed: { count, sinceLastNote }`; every derivation still
  emits its `dendrite:agent-created` trace.

- `deriveAgent({ name, from, mode?, solve?, strategy?, config?, framing?, resultTo?, ... })` derives a bounded agent from a live one: the parent's context at a checkpoint, a private continuation, and — unless overridden — the parent's whole configuration (model, thinking, cache TTL, provider params, system prompt, tools, live context budget). The parent keeps running. `mode: 'shared'` (default) gives the child the parent's messages and fold state through shared storage on a Chronicle branch of its own: nothing is copied, the child folds with the parent's memory tree, and neither can alter what the other reads. It requires `@animalabs/chronicle` with `JsStore.view` and `@animalabs/context-manager` with `ContextManager.derive`, and is refused with a clear error, never silently downgraded, where they are missing. `mode: 'copy'` is the historical compiled-context copy and works with the published packages. `solve: 'fresh'` deliberately re-solves the inherited context instead of reusing the parent's rendering. See `docs/dendrite.md`.
- `AgentConfig.selfParticipants` and `AgentConfig.presentAs`: model-facing role assignment at request assembly. Stored participants named in `selfParticipants` are presented as the agent's own assistant turns, under `presentAs` (default: its name). Stored authorship is never rewritten. A shared-inheritance fork uses these so its parent's turns read as its own history and its request shares the parent's provider prefix.
- `AgentConfig.denyToolsAtDispatch`: tools that stay advertised but are refused when the agent calls them, so a derived agent can be restricted without changing the tool block at the front of its request.
- `resumeAgent(name, config)` brings an ended bounded job back as a new incarnation of the same identity on the context it left (its namespace, or a fork's own branch) — after a stop, a failure, or a restart. `inspectAgentContext(name, { atSequence? })` returns a snapshot of a live agent's context at the head or an earlier sequence without affecting the agent, or the context an ended agent left.
- `deriveAgent({ inheritRefusals: true })` also inherits the parent's compression-refusal ledger (default off); the choice is recorded as `inherit.refusals` on the agent record and in `dendrite:agent-created`.
- `getPendingAssistantRound(name)` returns the assistant turn an agent has produced but not yet stored (its tool calls in flight), for hosts that derive an agent from inside a tool call.
- A derived agent that inherits its parent's tools shows the parent's tool presentation (resident-edited visibility and descriptions); only the owner can edit it.

- Two hooks a host decides derivations with, free of semantics:
  `dendrite.beforeDerive(spec)` says yes or no, with a reason, to each agent
  `createEphemeralAgent` makes, derivations included, before the agent
  exists, and to each `resumeAgent` before its new incarnation exists;
  `dendrite.derivationNotice(
  record, from, defaultText)` decides what, if anything, the source is told.
  Consent, budgets, a mind's standing instructions, or uses not yet
  imagined are a host's or a module's to build on them, with a record's
  `metadata`, `denyToolsAtDispatch` and `ForkReaderConfig.framing`; the
  framework carries no consent model (architecture channel, 2026-10-19).
- A reader fork can post nowhere with `allowChannelSpeech` off: every tool
  but `deliver_summary`, `cancel_tuneout` and `note_disposition` is refused
  at dispatch, while the block it is shown stays the resident's for the
  shared prefix. `speak_in_channel` posts through the resident's publish
  path, under the resident's account, in the fork's words; the docs said
  otherwise and now say this.

- A fork made from inside a tool call now sees the call that made it: by default
  `deriveAgent` reproduces the parent's in-flight tool round on the child's
  branch — the pending assistant turn verbatim, then a tool-result message with
  the results already received, a note (or `pendingRound.madeBy.result`) for the
  call that derived the child, and a note for any call still running — so the
  child never meets a dangling `tool_use`. `pendingRound: { include: false }`
  leaves it out.

- `subconscious.reader: 'forks'` (Dendrite): the tune-out reader as a succession
  of forks of the resident instead of one persistent side-agent. Each cadence
  tick, coalesced wake and cancel derives a short-lived `subconscious-fork` at
  the resident's head — its history as the fork's own turns, its refusal ledger,
  its tools and system prompt, ending with it — hands it the traffic held since
  the last look as ordinary framing (each held message to exactly one fork, media
  preserved), including messages still queued behind a resident turn that is
  running, which come last in `ReaderFramingContext.backlog` with held handles
  for ids (`queuedCount` says how many), and lets it report through
  `deliver_summary` as attributed mail
  under the fork's name and incarnation. In this mode `subconscious.model` is
  required (whose weights read the resident's prefix is never defaulted; the
  resident's own model makes the fork a copy, another model by name is allowed)
  and `subconscious.voice` is the reader's framing block in place of
  `systemPrompt`. `subconscious.strategyFactory` supplies a fresh strategy
  instance for each fork (required for a folding resident);
  `subconscious.forkIdleTimeoutMs` bounds one fork (default 10 minutes);
  `subconscious.framing(context)` decides how a fork is prompted, with
  `defaultReaderFraming` exported as the default. A cadence period with nothing
  new derives no fork. A reader's own cancel is followed by one more fork only
  for messages that arrived after the reader was handed its own, and a
  reader's own release of the all-except hold by one fork for each channel
  with messages no reader was handed. A fork that throws before it reports
  gives its messages back to the channel's next reader while the epoch still
  holds the channel. New traces `tune-out:reader-fork` (`held`, of which
  `queued`) and `tune-out:reader-fork-failed` (`returned`).
  `reader: 'persistent'` remains the default and is unchanged.

- Dendrite agent registry: one registry now describes every agent the framework runs — residents, the subconscious, conversation forks and ephemeral agents — with declared roles, lifetime and relationships (spawn, observe, message, result route). The four creation paths register as presets (`residentSpec`, `subconsciousSpec`, `conversationForkSpec`, `workerSpec`, `taskForkSpec`), exported with the registry types from the package root.
- Discovery: `listAgents({ includeEnded })`, `getAgentRecord(name)`, `getPrimaryAgentName()`, `listActivations()` (which agent owns each in-flight run) and `listPolicyEpochs()` (tune-out holds, read from the coordinator's own state). Ended agents stay inspectable.
- Lifecycle, with no permission checks inside the one host trust domain: `cancelActivation(name)`, `stopAgent(name)` and `reparentAgent(name, newParent)`. When an agent ends, the agents it spawned as attention tenants (`onParentEnd: 'end'`) end with it; task work it spawned is orphaned, keeps running, is told in its own context, and is offered to its nearest live ancestor or the primary. `stopAgent` refuses the default-delivery owner.
- `reparentAgent(name, newParent)` also takes an agent that has ended, for the mail it holds: what it produced for a recipient that is gone, results and messages alike, goes to the new parent, and its record stays as it ended. When an ended agent's result is first held for a recipient that is gone, its first adoption candidate is told.
- Attributed communication: `sendAgentMessage(from, to, content)` and `deliverAgentResult(from, content)` place the sender's verbatim content in the recipient's context under the sender's own name, with the sender's identity, incarnation and causal chain in `metadata.dendrite`. A result is recorded durably before delivery; if its recipient is gone it is held (`listHeldMail()`) until the agent is reparented, and a result held across a restart is delivered exactly once.
- `createEphemeralAgent(config, spec?)` accepts an optional registry spec declaring who spawned the agent, where its result goes and what bounds it. A `task` lifetime's `deadlineMs` is enforced by `runEphemeralToCompletion`, which rejects with the new `AgentStoppedError` when a run is stopped, cancelled or timed out from outside. A task spec with neither a deadline nor an idle timeout is refused.
- Restart behaviour follows lifetime: persistent agents are restored as a new incarnation of the same identity; bounded work that was live is recorded as ended (`host-restart`), and the recipient of a `message` result route is told once. Persistent agents the configuration no longer declares are ended (`not-configured`).
- `agentRegistryPath` and `agentRegistryEndedPath` place the registry's recovery files for a host that gives the framework its own `store`; each defaults to its file under `<storePath>/recovery/`, and with neither and no `storePath` the framework warns at create.
- New traces: `dendrite:agent-created` (names the kind, the model, the context source, what ends the agent and what happens when its spawner ends), `dendrite:agent-ended`, `dendrite:agent-orphaned`, `dendrite:agent-reparented`, `dendrite:activation-cancelled`, `dendrite:mail-deferred` (queued for the recipient's next boundary), `dendrite:mail-delivered` (entered the recipient's store), `dendrite:mail-held`. Delivered mail carries `metadata.dendrite.producedAt`. New config: `dendrite.announceOrphans` (default true).

### Changed

- `ChannelRegistry` no longer evaluates the wake gate or sets the publish
  locus at ingestion: `shouldTriggerInference` is the per-server veto only,
  and the framework reports delivered messages through `noteDelivered` after
  admission. `channel_publish` without a `channelId` goes to the calling turn's
  locus, else a conversation fork's home channel, else the turn's trigger
  channel, else the registry's default, which an ephemeral agent (one
  `createEphemeralAgent` or `resumeAgent` made, derivations included) or a
  turn with no channel by design (`noChannel`, or a heartbeat) doesn't
  take; the call is refused when none of these names a channel.
- `TuneOutCoordinator.onIncoming` is split into `holdFor` (the pure lookup
  admission uses) and `recordHeld` (the bookkeeping that follows a hold);
  `cancel` takes the lifecycle state to return to; `enter` no longer
  requires a reader.

- `createEphemeralAgent(config, spec)` with `spec.inherit.mode: 'shared'` opens the agent's context by derivation from the named agent instead of a fresh isolated namespace.
- A mid-turn injected message whose participant is one of the receiving agent's `selfParticipants` is no longer injected into the live stream (it would render as an assistant turn); it stays window-only, as a message under the agent's own name already did.

- **agent-framework now depends on `@animalabs/context-manager` `^0.24.0` and `@animalabs/chronicle` `^0.5.0`**, where it depended on `^0.23.1` and `^0.4.0`. Derived agents and reader forks need context-manager 0.24.0's derived contexts and chronicle 0.5.0's branch views, so a fresh install now takes both.

- Merged `main` at 0.22.1. The turn-routing rework (#314) is kept whole, and
  `speech.locus` decides what its addressed re-pin does: under
  `'latest-inbound'` a mid-turn addressed message or an *arrival* (one that
  landed between the turn's streams) moves the locus as 0.22.1 does; under
  `'delivery'` (the default) neither moves it, and an arrival that addressed
  the agent from another channel is announced at the turn's next start with
  the same `[routing] … addressed you from …` notice a tool boundary gives,
  naming which start it is: a provider hold, a re-inference on tool
  results, a budget restart or a retry.
  The per-agent routing maps the Dendrite seam read (`turnLocusPins`,
  `turnEngagedChannels`) are gone with the rework; the seam reads the turn's
  `TurnRouting`. `conversationAgentHomes` and `sharedSlotAgents` are answered
  by the agent registry (`homeChannel`, `readsSharedSlot`).
- Merged `main` at 0.22.2. Where main's deferred-write rework (#286) meets
  the Dendrite seam: at a tool boundary, a message held from the residents
  (`tuneOut.heldFromResidents`) is stored with the boundary's other drained
  writes, as before, and left out of the injection, since the next compile
  hides it; a message that can't join the stream waits for the turn's end,
  as main has it, and "the agent's own voice" there is every participant
  the agent presents as, a derived agent's inherited voice included, not
  its name alone. Held agent mail (`sendAgentMessage`, `deliverAgentResult`)
  is released at each of the three sites that now store a deferred write:
  the tool boundary, the turn-start flush and `addMessage`. An arrival's
  record carries `addressed`, so main's new arrival tests read it. The
  all-except hold's timers and option reading follow #444 (see the
  all-except entry). `ProviderWaitNotSleptError` (main) is exported beside
  `AgentStoppedError` and `DeriveAgentOptions` (the branch).
- Merged `main` at 0.22.3. `isAddressedMessage` stays tag-only: main's call
  sites pass the message's metadata as a second argument it ignores, and
  here they pass the tags alone. The channel registry still decides nothing
  about the locus at ingestion: main's acceptance step keeps only its
  confirmation that the transport is open (a lifecycle-directed server's
  traffic confirms the current target alone), and the latest-inbound locus
  is set by admission, as before. `tune_out` and `focus` still dispatch
  through the queue, and `enter` without a reader is still a silent hold;
  main's words for a channel already tuned out, one bound to a conversation,
  a cancel of a channel that isn't tuned out and an empty `speak_in_channel`
  are adopted. A coalesced wake's timer reports what its work throws
  (`tune-out:timer-failed`, main) around the all-except hold's own wake
  path. The `drafts` tool (main) sits beside `tune_out` and `focus`; a
  derived agent's tool block is still its surface owner's, with main's
  `utils` filter applied to it. The deferred-writes restore is main's (a
  queue that can't be read refuses to start; `heldAt`), with the branch's
  re-wake for a tune-out release it restores. A request's per-agent
  settings come from main's `requestSettings()` with the branch's
  `assistantParticipant`; main's request-only rows are rendered under the
  agent's presentation name. `endEphemeralRunRefused` is gone with main's
  refusal of a start during `stop()` (#532). `QuiesceBlockedError` (main)
  is exported beside the branch's names.
  Main's rule that a refusal is an error result (#506) now covers
  `tune_out` and `focus`: every refusal they return is `isError: true`, and
  a channel the registry doesn't know is refused as `unknown channel: <id>`
  (an id on several servers keeps the registry's own words). A tune-out
  with no reader is a silent hold only where the host offers `tune_out`
  without one (`tuneOut.enabled`); the coordinator's new
  `holdWithoutReader` hook says so, and without it a hold with no reader is
  refused in main's words. Under the author rule a placeholder for content
  the host can't read is stored under its author too, `User: [Content not
  shown: …]`, which main's parity test now counts as such.
- Merged `main` at `8ec1de5a` (0.26.2's changelog and #720). At a tool
  boundary the branch still releases each stored message's landed mail and
  skips one held from the residents, and what it injects is then #720's: a
  message the render gives null goes in as stored.
- Merged `main` at `a4a74b48` (0.26.0 and after), where #710's
  server-qualified channels meet the branch. A conversation fork's home
  stays the agent registry's `homeChannel`, which the framework reads
  wherever main read its own map of homes. `tune_out` and `focus` resolve
  their channel as main's channel tools do: with a `serverId`, that server's
  channel; inside the calling turn, the turn's own channel by its id;
  otherwise the one registered channel a name answers to, by its id or as
  `serverId:channelId`, and a name two channels answer to is refused with
  them as candidates; `check`'s `peek` takes the same names and refuses what
  they refuse, a channel no server registers now included. Their answers,
  and the all-except announcement, name and reach the channel on its server.
  The subconscious's `deliver_summary`, `cancel_tuneout` and
  `speak_in_channel` resolve a channel as main's do, from a reader fork too.
  A `cancel_tuneout` that names the all-except scope ends that hold, as
  before, whatever channel its `channelId` picks or fails to pick (a name two
  servers' channels answer to, or a turn's own channel its server no longer
  registers); only a channel with a tune-out of its own is cancelled instead.
  The latest delivered
  inbound message, which admission records, keeps its server, and a message
  whose server no longer registers its channel sets none. A
  `channel_publish` naming no channel takes the turn's locus only when the
  call is made inside the turn; outside it, a conversation fork's goes to
  its home, an ephemeral agent's to none, and anyone else's takes the
  registry's default. So main's
  shared-channel-ids entry, which says such a publish posts to the latest
  message's channel, holds here only under `speech.locus:
  'latest-inbound'`, while no all-except tune-out is open, for a call by
  an agent that is neither ephemeral nor a conversation fork, made
  outside a turn or in a turn with neither a locus nor a trigger channel
  that isn't a heartbeat's or a `noChannel` turn. Every way a live non-ephemeral agent ends drops a continuation
  of its turn that is on its way (#722), and a conversation agent stopped by
  a listener of the failure its hold after the compile reports is held by
  nothing.
  `AgentSpec.homeChannel` and the registry record's `homeChannel` are a
  channel with its server, `{ serverId, channelId }`, and
  `conversationForkSpec` takes it as `homeChannel` in place of `channelId`.
  A record that keeps a bare id, as one written before does, is read as a
  wake that names its channel without its server is: the one registered
  channel with that id, or, where none or several are, a home on no
  server.
- Merged `main` at 0.28.0. main's view rule (#853: every check of whether
  an agent sees a row asks the predicate its store was opened with) reads
  this branch's views: a resident's (held rows and another agent's stored
  context injections out), a derived agent's (its source's, which
  context-manager's `derive` keeps) and a context reopened on the shared
  slot (the residents'). A tool boundary, an arrival and the unread check
  ask it, and a shared-slot message's readers are the registry's. main's
  heartbeat (#827) wakes the agents whose spec takes untargeted inbound, as
  an untargeted push does. An ended agent's re-arm count, exhausted-turn
  record and run of stated waits (#846, #840) go with it. A `chat:system`
  notice (#830) leaves the latest delivered inbound where it was, as a
  marker does. Supplied text (#852): a channel message's author, which this
  branch writes into the stored text and a held line, is kept to one line
  with its notice openings marked, as is the author an addressed-elsewhere
  notice names; `[Agent lifecycle: …]` and `[Focus: …]` are notice tags, so
  a participant's text that opens with one is marked; tune-out's texts quote
  a channel's name as `tune_out` takes it back, and name one no name picks
  alone by its id and server.

- With `subconscious.reader: 'forks'`, residents see the reader's four tools
  (`deliver_summary`, `cancel_tuneout`, `speak_in_channel`, `note_disposition`)
  in their own tool block so a reader fork's request shares their provider
  prefix; a resident that calls one gets a tool-result refusal naming the
  reader. A resident whose `allowedTools` leaves them out isn't shown them,
  and neither are its reader forks, which can still report through their
  final prose. A reader fork may call its own tools whatever its resident's
  `allowedTools` says, unless a `denyToolsAtDispatch` entry it takes from
  its resident names one. Persistent mode advertises nothing extra.
- A reader fork's `cancel_tuneout` ends only the hold of the epoch it was
  derived to read, and its `speak_in_channel` posts only into a channel that
  hold still holds; calls made after it ends are refused. A fork whose
  record carries no epoch is refused both. `deliver_summary` and
  `note_disposition` stay open to every reader.

- Agent selection reads declared roles from the registry instead of excluding agent kinds at each site. Residents, the subconscious and conversation forks are selected exactly as before. One difference: an ephemeral agent that is mid-run is no longer queued for untargeted broadcasts (a module's `requestInference: true`, an untargeted channel message or push event, coalescing's default readers) or for host-wide gate wakes. Such requests previously sat in the queue until the run ended and were then dropped with an `agent_not_found` trace; they are now never queued.
- Two Chronicle states are added to every store: `framework/dendrite` (snapshot) and `framework/dendrite/ended` (append log). Existing stores need no migration.

### Fixed

- A channel message is stored as the model reads it: `author: body`. MCPL's
  `channels/incoming` carries the author as a field and the body alone as
  content; the framework stored the body under the anonymous participant
  `user` with the author in metadata, and nothing between the store and the
  wire wrote the name, so a spec-shaped server's message reached the model
  as `user: <text>` with the author nowhere (Weft's rig, 2026-10-13). A
  server that renders `Name: body` into the text itself (portal-mcpl) is
  left as it is: the rule is idempotent, so the name appears once whichever
  shape a server sends. The author stays in `metadata.author` as the
  structured record. Exported as `presentAuthor` / `authorLine`.
- A tune-out release line and the reader fork's backlog name an author
  once. Both read `metadata.author`, so a message whose text a server had
  already prefixed was shown as `Name: Name: body`.

- Issue #232 §2 tune-out gaps, each with a regression test (gaps 1 to 10 on
  the loopback MCPL server in `test/admission-e2e.test.ts`, gap 11 in
  `test/tune-out-dump-fit.test.ts`): tuning out a DM now holds it
  (1); held traffic never moves the speech locus (2); a debounced mention in
  a tuned-out channel wakes the reader, not the resident (3); a release names
  non-text blocks instead of dropping them (4); a held message that arrives
  mid-turn is stored, never injected into the live turn (5); a release left
  in the deferred queue is durable and re-wakes the resident at boot (6);
  held messages still deferred at cancel are in the release (7); channel ids
  resolve server-qualified (8); `channel_close` on a tuned-out channel is
  refused, and the tune-out's cancel releases (9); the hold machinery runs
  without a reader (10); the truncation note names a history tool the
  resident has, or none (11).

- The agent registry's durable state keeps `main`'s rules for the framework's
  own state (nissa's review of #546, findings 1 to 5). A registry that can't
  be read, or that reads as another version, refuses the start and names the
  state, where before it was taken as empty and overwritten by the first
  registration. A failed registry write, ended-log append or sync fails the
  call that made it, and a result whose hold isn't durable is not delivered
  (it stays held for the next attempt); a hold whose write fails leaves
  memory too, so a retry holds it once. The registry and its ended log are
  recovery files beside the store (`recovery/dendrite-registry.json`,
  `recovery/dendrite-ended.json`), which win over the branch-local state, so
  an undo or an operator's surgery can't erase a held result or the record
  of work that ran; the branch-local copies stay for inspection and for
  stores that predate the files. At boot, interrupted work is settled and
  held mail redelivered after host mode and the deferred-write queue are
  restored, so a quiesced host holds them as it holds any write, and mail an
  entry of the restored queue carries is left to that entry's landing rather
  than delivered twice under one id. Every agent that ends — by `stopAgent`,
  by the idle reap, with its parent — is released through one path, which
  releases its window as the reap did: a failure notice it never read
  reaches the primary, and a write queued for it lands in its window.
- The second round of the same review: a change a caller asks for — a
  registration, an end, a reparent, a hold — is put back when its write
  fails, so the call fails and a retry does it once (a stop whose write
  failed had left the agent recorded as stopped while it ran). The put-back
  rewrites the registry's recovery files to match memory (the branch-local
  snapshot, written last, never holds the change); only an end already
  appended to the branch-local ended log stays, and a boot reads that log
  only where no ended recovery file exists.
  A write that records something that has already happened — a
  release, a held mark, a message path — is not failed: it alerts, stays in
  memory, and the next write carries it. A result's hold is durable as it is
  written, so no store sync decides the delivery; the release is written
  only once the store has synced the landed message, so a hard exit between
  the two leaves the mail held and the next boot's check of the recipient's
  store settles it, never a release on disk for a message that isn't. A
  version-1 registry whose records or mail are not lists is refused, not
  taken as empty. A reader of the residents' shared slot that ends — a
  resident dropped from the configuration — is reopened on the slot it
  read, through the residents' view, where before an isolated namespace
  showed none of its messages.
- The split between a requested change and a record is the caller's: an end
  `stopAgent` asks for is put back when its write fails, while a run's own
  end and an idle reap record what has already happened — their writes
  alert and the run still settles. An end that was put back comes off the
  ended log's recovery file too, and a registry refused for its content
  names the state it read, as one refused for its version does.

- From the first live run of tune-out mk2 (Weft, 2026-10-12): a reader
  fork that ends in prose without `deliver_summary` now has its final prose
  delivered as its report (`tune-out:reader-prose-delivered`) instead of
  losing it to `proseRouting: 'disabled'`; under `speech.locus: 'delivery'`
  an addressed message injected mid-turn from another channel is announced
  (who, from where, where the prose still lands); `tune_out check`'s `peek`
  shows only the epochs holding the channel now, never a released one;
  `stop()` leaves bounded work it cuts off live for the next boot to end as
  `host-restart` and report (`dendrite:agent-interrupted` at stop), and
  create()-time traces replay to a listener that asks (`onTrace(fn, { replay: true })`);
  `channel_publish` without a `channelId` goes to the turn's locus (the
  waking delivery, a channel opened this turn) before being refused.
  `isAddressedMessage` is tag-only and says so; its unread parameter is gone.

## 0.29.0 — 2026-10-28

### Breaking

- `metadata.sourceBodyDigest` is taken over a message's content as conversion leaves it, with the server's text marked at the framework's openings. A body stored before this change that holds one of those openings digests differently from the same body delivered after it.
- `ChannelRegistry.nameShown` gives a channel whose id doesn't show as itself by its id and its server, each written as JSON, which the channel tools take exactly and the prose resolver doesn't. On 0.28.0 an id holding a quote, a backslash or one of the framework's openings was given bare, and worked as a `>>` target; it no longer does. An id holding a line break is given the same way; on 0.28.0 its bare form went back through the resolver but never worked in a `>>` line. An id with whitespace at its edges went back through neither on 0.28.0.

- **Residents and hosts whose agents answer a heartbeat in plain speech:** a
  turn the heartbeat opens (a tick or a reminder, from the framework's
  heartbeat or from an MCPL server whose id is `heartbeat`; a silent tick
  already keeps its words private) no longer posts its plain speech where the
  latest inbound message came from. That turn has no channel and takes no
  fallback, in every routing mode. Its plain speech with no destination of
  its own is held as a draft the agent can resend with `drafts` (in explicit
  mode it's a bounce, so `{{unsent}}` names it too), and named in the turn's
  `[delivered]` receipt, or in a notice mid-turn; in locus and hybrid mode
  the turn is told so in a `[routing]` notice before it compiles, once per
  heartbeat. The bounce of
  such words with no destination is noticed but requests no wake, and
  doesn't count toward the bounce-wake cap; a `>>` or `>>>` target that
  fails still wakes the agent, and an autoContinue agent's run from a
  heartbeat continues as configured, each continuation holding its words too.
  What still reaches a channel: an explicit send, a `>>` or `>>>`
  destination, the agent's own `channel_open`, and a re-pin when an
  addressed message arrives mid-turn. Other wakes that carry no channel
  (timers, a host's own requests) route as before, and so does a heartbeat
  a gate rule batches (a `debounce` or `judge` rule matching it), which wakes
  as the gate's batch. The turn doesn't announce a locus change, so the next
  channel turn doesn't re-announce its channel.
  **Migration:** an agent that checked in by speaking from its heartbeat now
  needs an explicit send to reach someone; say so in the heartbeat's message
  (`heartbeat_configure`'s `message`), for example "your plain words stay
  with you as drafts; send to reach someone".

- **Every agent's tool list changes: rarely-used host tools leave it for the host's built-in toolset, `settings`.** `agent_settings`, `wake_add_rule`, `wake_remove_rule`, `gate_status`, `event_tags`, `set_tool_visibility`, `set_tool_description`, `heartbeat--heartbeat_status`, `heartbeat--heartbeat_trigger` and `workspace--status` are no longer in the tool list; an agent opens the toolset with `toolsets--open {toolset:"settings"}` and calls them with `toolsets--act {tool, args}` while it's open. The four `toolsets--` meta-tools are now in every agent's tool list, with or without MCPL. A call of one of those tools by name still works. The first request after the update writes its prompt cache in full. An agent whose `allowedTools` doesn't permit `toolsets--open` and `toolsets--act` keeps every tool in its list, as before, except module utilities (see below).
- **`utils` is removed, with no alias.** Module utilities (`Module.getUtilities`) are tools of the built-in toolset: listed by `toolsets--look {toolset:"settings"}` and called with `toolsets--act` under their own `module--utility` name, which `allowedTools` checks as before. A call of `utils` is refused, saying where its utilities went, whatever `allowedTools` names. `getAllTools()` now lists module utilities beside tools (under their `module--utility` names), so a code-execution script and `listToolClasses()` see them too. The `[utils]` startup warning about an `allowedTools` that permits none is gone.
- **Hiding a tool now moves it into a toolset.** A tool hidden with `set_tool_visibility` leaves the tool list for the built-in toolset (an MCPL server's tool, for that server's tab), where `toolsets--look` lists it and `toolsets--act` calls it while that toolset is open. The `toolsets--` tools can't be hidden.
- **`toolsets--open` and `toolsets--close` with `server` alone address the server's tab** (see Added), where they used to open or close the server's only toolset. Name `toolset` to open or close a toolset a server declares.
- **The name `toolsets` is the framework's from creation.** Its toolsets module is registered for every agent at `create()` (unless a module given to `create()` holds the name, in which case the host presents nothing out of the tool list), so a module named `toolsets` added later is refused as already registered, and an MCPL server's `toolPrefix` of `toolsets` is refused as colliding with it.

- **Hosts that run `DiscordModule` or `ApiModule`:** a sender's name from
  outside the framework is now stored in a form marked with its source.
  Before this change, a Discord author or API caller whose name matched an
  agent's could have their message compiled as the agent's own turn.
  `DiscordModule` now stores a Discord author's message under
  `<username> (Discord)`, live and on history sync, and `ApiModule` stores
  the message of every `api:message` event, from an `ApiServer` caller or a
  host's own, under `<name> (API)`. An `api:message` whose `participant`
  isn't text, which its type doesn't allow, isn't stored, and starts no
  turn. Such a name is stored on one line: each run of line breaks (U+2028
  and U+2029 included) and other control characters becomes one space. The
  generic name `user`, in any capitalization, is stored as given. Where an
  agent's request shows senders' names, the agent sees the marked form,
  beside the form stored before this change in older rows. The `ApiServer`
  now refuses a `participant` that isn't text, as it refuses content that
  isn't.

  **Who needs to act:**
  - code that tells senders apart by a stored message's participant, such
    as an `ApiServer` client that recognises its own messages in the
    message list, which now returns them under `<name> (API)`;
  - a host that pushes an `api:message` in an agent's name to write that
    agent's turn, which now records a user turn, unless that name is one
    the marking can't cover (below);
  - an `ApiServer` caller that sends a `participant` that isn't text, which
    the server now refuses, and a host that pushes such an `api:message`
    itself, which `ApiModule` doesn't store or start a turn for.

  **Migration:** read a row's `metadata.author` when it has one, and its
  participant otherwise, as history's author filter does: rows these modules
  stored before this change have none, unless a host's `api:message` carried
  one. Both modules now store the name as sent there (`{ id, name }` from
  Discord, `{ name }` from the API, unless an `api:message` event's metadata
  carries an `author` object, which is kept and identifies the row instead),
  so the author filter still finds a sender by that name, and a Discord
  author by id in rows stored after this change. Write an agent's own turns
  from a module of your own, with its context's `addMessage` under the
  agent's name. Send a `participant` as text.

  **Unchanged:** an agent's own turns, and the bot's own messages that a
  Discord history sync stores, which keep the name of the framework's first
  agent. Rows stored before this change keep the name they were stored
  with, so one author can appear under both forms in one history, and the
  author filter finds both by the name as sent, or, for an API event that
  carried an `author` object, by that author, as before.

  No agent's name is refused: a host that gives one of its own agents the
  name `user`, in any capitalization, or a name ending in ` (Discord)` or
  ` (API)` defeats the marking for that name.

- **Hosts and operators of MCPL servers that advertise RFC-014 tool hints:**
  tool hints are now on by default. An MCPL server whose configuration
  leaves `toolHints` out (or sets it null) is offered
  `experimental.mcpl.toolHints`, as one set to `true` was, so a server that
  advertises hints too has its toolset and dynamic tools leave the API tool
  list: they're announced in the conversation and reached through
  `toolsets--open` and `toolsets--act`, and a call of one by its listed name
  is refused while it isn't static. `toolHints: false` is the per-server
  opt-out. A server added any way, including at runtime by a deploy tool
  that doesn't name the setting, gets toolsets.
  - **Migration:** to keep a server's whole tool list as 0.28.0 gave it, set
    `toolHints: false` on it. (The agent's tool list as a whole changes in
    this release anyway: see the host's own toolsets, below.)
  - **Who else notices:** the `toolsets` module's four meta-tools
    (`toolsets--open`, `--act`, `--look`, `--close`) are in every agent's tool
    list from creation, with or without MCPL, since the host's own toolsets
    use them too; the first request after the update writes its prompt cache
    in full.
  - **Unchanged:** a server that doesn't advertise hints lists every tool as
    before. A modern (MCP) server can't negotiate hints, so it has none, and
    `toolHints: true` on one is still refused. Where a module given to
    `create()` holds the name `toolsets`, MCPL servers that leave the setting
    out have no hints, and a line names them. A server whose `toolPrefix` is
    `toolsets` is refused, at startup and at runtime, and so is a host's own
    `addModule()` of a module named `toolsets`: the name is the framework's
    from creation.

### Added

- **The host's own toolsets** (`src/host-presentation.ts`; RFC-014 §8.5 host-made toolsets and §8.1 surface presentation, host-side only, for every MCPL server with or without RFC-014):
  - the built-in toolset `settings`, holding the framework's rarely-used tools, every module utility, and a module's tools it places there with the new optional `Module.toolPlacement(toolName)` answering `'builtin'`;
  - **server tabs**: each MCPL server is presented to each agent as `full` (in the tool list, the default), a `tab` (connected, events still arriving, its tools out of the tool list until `toolsets--open {server}` and called through `toolsets--act`), or a `closed-tab` (disconnected until `toolsets--open {server}` connects it again with its configuration, an `accessProvider` asked afresh). `toolsets--close {server}` moves a full server to a tab or hides an open one, `toolsets--close {server, disconnect: true}` disconnects it, `toolsets--open {server, full: true}` puts it back in the tool list. `toolsets--look` lists the built-in toolset and every server's presentation.
  - `McplServerConfig.presentation` (`'full' | 'tab' | 'closed-tab'`, default full) sets where each agent starts; a `closed-tab` server isn't connected at startup. Any other value is refused when the server is added.
  - `toolsets--act` on a host toolset's tool checks its `args` against the definition the agent was shown before calling it, as it does a server's dynamic tool.
  - A closed tab is host-wide, since a connection is the host's: `disconnect: true` is refused while another resident agent has the server in its tool list or its tab open, or can't use the meta-tools (so couldn't open a closed tab again); a disconnect that fails changes nothing. An operator's own `connectMcplServer` of a closed tab ends it, and `disconnectMcplServer` forgets the server's tab state.
  - Which host toolsets an agent has open, each server's presentation where the agent changed it, and which servers are closed tabs are kept in `<storePath>/config/toolsets.json` across restarts (an agent with nothing open or chosen keeps no entry). A file that can't be read is moved aside, not written over.
  - The tool list changes only when a server moves between full and a tab, or a tool is hidden or shown; opening, acting in and closing a host toolset never change it. An open host toolset whose announcement has left the context is reminded of, beside servers' toolsets (RFC-014 §8.3).
- **`AgentFramework.presentedTools(agentName, tools, canUseMeta?)`**: the host presentation every request's tool list gets, applied to the given tools, for a stream that isn't registered yet (a fork whose orientation is written before its run starts). `canUseMeta` says whether it will be able to call `toolsets--open` and `toolsets--act`; left out, the agent registered under that name is asked.

- `Heartbeat.scheduledWakes(whose?)` lists the heartbeat's next tick and pending reminders, soonest first, as `HeartbeatScheduledWake` (exported): an `UpcomingWake` with its `kind` (`heartbeat` or `reminder`), `silent` and the `text` it will bring, so a host can ask the gate about it. `whose` words each for the reply judge (`"its"`, the default) or for the agent (`"your"`). `upcomingWakes()` is unchanged.

### Changed

- **Hosts:** a persistent agent's turn that ends exhausted on a transient
  failure (a server error, an overload, a rate limit, a network failure, or a
  timeout membrane marks retryable and not as a deadline it reports as run
  out, such as a 408 or a socket's ETIMEDOUT) is now sent again after 2, 8 and
  32 minutes (agent-framework#838). 0.28.0 sent nothing until another wake
  came, so a message that arrived during a provider outage could go unanswered
  for good. The re-armed trigger is a wake of its own, since the turn it came
  from has ended. It opens where that turn's plain speech was going: its
  locus, where a message mid-turn may have moved it, else its trigger channel.
  Carrying that channel, it ranks as addressed in a merged wake's choice of
  channel, so a newer ambient wake from elsewhere doesn't take it; an
  autoContinue continuation's still yields its channel to any wake's, as it
  does on main; a continuation's, such as a budget restart's, names no author.
  A re-arm that would have to guess a channel isn't sent again: one whose turn
  was woken for a channel id that names no one registered channel and never
  found one, and whose request names none of its own. Until one of its rounds
  has run or had its tool calls cut off, a re-armed turn's failure gets no
  retries from the error policy: on another transient failure the next delay
  follows, until the list runs out, and a failure of any other kind ends the
  re-arming. A wake for the agent while it waits starts its turn at once, with
  the re-armed trigger merged in. That turn is the wake's: the error policy
  retries its failures. A completed turn starts the count again, and so does a
  message said to the agent (not a system message or notice; not an edit,
  reaction or deletion, unless an edit is the first version of a message the
  agent sees; not a message its own view leaves out, such as one a tune-out
  holds from it; and not the agent's own schedule: the heartbeat's tick or
  reminder, a self-wake timer it set, or a script's wake. A notice a module or
  an MCPL server stores as a message counts, and a message in the residents'
  shared slot counts for each resident that reads it), so each such message
  gets its own re-sends, over about 42 minutes after its turn first exhausts
  at the default delays; any other wake leaves the count going on. A
  heartbeat-mcpl server registered under another id stores its ticks as
  ordinary messages, so each of its ticks starts the count again too. A
  re-armed turn's transient failure writes no `[inference-failed]` marker
  unless it got partway, so the agent's context keeps the one the first
  exhaustion wrote; a failure of another kind writes its own. A judge rule's
  judge is told when the re-arm comes, and can make its calls while the agent
  waits. The health snapshot shows the wait under `providerAdmission`, with a
  `cooldownReason` that says the turn is sent again; a re-arm that comes while
  a provider hold is already on the agent waits for that hold instead, under
  its reason, and takes its count all the same. The wait and the count are
  kept in memory, so `stop()` or a restart drops them, and `abortInference()`
  doesn't end the wait. Set `exhaustedTurnRearmMs` to other delays, or to
  `false` to send nothing again. **Unchanged:** ephemeral runs and
  conversation forks, a failure the provider refuses, a compile refused over
  budget, a deadline, whether the host set it or membrane marks one as run out
  (the runtime's or undici's on a sent request, the Anthropic adapter's
  watchdogs, or the Anthropic SDK's timeout, which covers its connect timeout
  too), and a provider's stated wait, which the framework holds as before.
- **Operators:** each re-armed turn's failure counts toward the hard-down
  streak, so the hard-down alert now comes during an outage from a single
  wake, at the third exhaustion, about 10 minutes after the first at the
  default delays, where 0.28.0 needed three wakes. New `[inference-rearm]`
  stderr lines say when each re-send is coming, when it went, and, as "turn
  not re-armed", why none is: a failure that isn't transient once the agent's
  re-arming has begun and neither a turn has completed nor a message been said
  to it since, re-arms that are spent (until a turn completes or a message is
  said to the agent), or a turn that would have to guess a channel. A message
  said to the agent starts its count again, with a line saying so, so a `(1 of
  3)` can follow a `(2 of 3)`. With `exhaustedTurnRearmMs: false` they say
  nothing. A turn that a provider's stated waits, one after another, have held
  for more than an hour now raises the `provider-wait` ops alert, once for
  that run, saying how many waits and how long they span, and pointing to the
  account's rate limit or quota, or the host's load: at its first such hold
  that begins past the hour, or, if none does, when the run ends, if its
  latest wait ran past the hour, measured to the earlier of that wait's end
  and the run's end. A wait released early counts to its release. So the alert
  can come as late as the run's end. The run counts the holds of the turn's
  own failed calls whose stated wait still bound, whether held as a provider
  wait, an acceleration cooldown or a host's hold, from the first of them; it
  ends with the turn, or when one of the turn's rounds runs. 0.28.0 raised the
  alert only for one wait of more than an hour, which it still does, so a turn
  held by a long run of short waits left no alert and no `failures.log`
  record; a run whose wait raised that alert raises no second one. It doesn't
  count toward the hard-down streak.

- **agent-framework now depends on `@animalabs/context-manager` `^0.23.1`** (0.23.1 up to, not including, 0.24.0), where it depended on `^0.23.0`; a fresh install of 0.28.0 already took 0.23.1. One of 0.23.1's changes reaches the runtime-settings preview: for a hierarchical agent (`adaptiveResolution` off) whose context fits its budget, which has no fold plan to preview, and whose strategy is built from the framework's own copy of context-manager, `previewContextSettings` returns null and `previewAgentRuntimeSettings` reports `available: false` with reason `no_preview_support`, and `resume()` logs no warning for it. Under 0.23.0 that preview threw, the reason was `no_adaptive_resolution`, and `resume()` warned that the agent's preview was unavailable. A strategy built from another copy of context-manager, a host's own at 0.23.0 or a second copy at 0.23.1, still gives `no_adaptive_resolution` and the warning where its context fits, as before, since 0.23.1's manager recognises only its own copy's error.
- **Three doc comments say less than 0.28.0's did, to match what the code does; no behaviour changes:**
  - **`resume()`:** 0.28.0 said "Unavailable previews warn and pass". A preview unavailable as `no_preview_support` passes without a warning.
  - **`previewContextSettings`:** 0.28.0 said it "Returns null when the agent's strategy has no fold plan (non-adaptive)". Within its budget, a non-adaptive `AutobiographicalStrategy` gets null only when it is built from the framework's own copy of context-manager, and one built from another copy throws there. Over the budget, its preview is an infeasible one.
  - **`previewAgentRuntimeSettings`:** 0.28.0 listed "the hierarchical (non-adaptive) path" among the previews that come back as `{available: false, reason}`. That holds within its budget; over it, the answer is `available: true` with `effective.fits: false`.

- The notice of a server's tool changes opens with `[toolsets]`.
- The system prompt's placeholder for a non-text system injection reads `[block not shown: an image block; the system prompt carries text only.]`.
- A toolset or instance name that holds a line break or one of the framework's openings is written as JSON in its `[server/toolset:instance]` label, and a channel whose name holds one is named in notices by its id and server, each written as JSON. A bounce or a resend's refusal that lists such a channel gives the channelId `channel_publish` reaches it by, its server-qualified name, or its id where only that picks it alone, as JSON, or says no channelId reaches it alone; and a refusal of an id the turn's channels on several servers share lists a channel whose qualified name picks it alone by that name, as JSON, and tells a tool that takes a serverId to call again with the channelId and serverId of one no channelId reaches alone.
- Generic resend examples no longer name something a resend could reach: an example that names no particular channel writes `"#<channel>"`, where it wrote `"#channel"`, and a bounce's DM example writes `@<person>`, where it wrote `@person`. A `>>` target or a resend refuses either as the example's placeholder. The `"#<channel>"` examples are a drafts notice's, where no destination the resend reads reaches the drafts' channel, a bounce's, where no channel it could mean is one token that shows as itself, and a re-bounced {{unsent}}'s confirm line.

- The notes `wake_add_rule` and `gate_status` give about rule order (`shadowWarnings`) now leave out event types a rule's source never sends. An MCPL server's events reach the gate as its pushes and channel messages only, and the framework's heartbeat's as pushes, so a rule for one of them, such as `{ source: "world" }` with no scope, is no longer told that an earlier rule taking every `external-message` keeps it from applying. A rule whose source's every event an earlier rule takes is now said never to apply, where it was said to miss only that rule's types. `gate_status` reads the servers connected now, so a note made before a server connected goes once it does, and the `gate:shadow-warnings` trace is made again when a server connects or is removed (`EventGate.sourcesChanged`), with an empty list when the last note goes. `EventGate` takes the host's knowledge as `eventTypesFrom`; `EventTypesFrom` and `MCPL_GATE_EVENT_TYPES` are exported for a host that builds its own gate.
- Each note now says which of three it is and what to do: the rule never applies; it misses some of the events it's for and applies to the rest; or an earlier rule takes event types the rule may not be meant for, which needs nothing unless it is, and which a scope on the rule clears. Each names the move that fixes it (`wake_add_rule` with the whole rule and `insertBefore`).
- `wake_add_rule`'s description says the same about order without capitals or warning signs: rules are checked in order, the first match decides, and the result's `shadowWarnings` are notes on the whole rule list, not only the change, each saying whether it matters and what to do.

- `skip_reply` with `wake_in_seconds` names the heartbeat's wake due before the self-wake. When the built-in heartbeat's next tick or a pending reminder is due sooner, and the agent's rules as they stand would let it wake the agent, the confirmation adds it after the usual line: `Turn ended; nothing sent. Self-wake in ~900s unless something wakes you first. Your heartbeat (a check-in prompt, every 10 min) is due sooner, in ~300s; if it wakes you, the self-wake is cancelled, so set it again for the ~600s left if you still want it.` Any turn start cancels a pending self-wake, so a heartbeat turn ends it. The note says when the heartbeat is due, not that it will wake the agent, so it stays true when something else wakes the agent sooner or the wake is held back. A skip with no wake, a self-wake due first, a wake the rules hold back, an agent the heartbeat doesn't wake and a host without the heartbeat read as before.

- `materialize` and `sync` took `"mount": ""` and `"path": ""` as no mount
  or path given, and acted on every mount. Without a path, `"mount": ""` is
  now refused, naming the mounts; `"path": ""` is refused whatever `"mount"`
  holds. Each refusal acts on no mount and says what leaving the field out
  covers: every mount, or for `"path"` beside a mount's name, that mount.

- The workspace's reasons for what a push, a sync, a listing or a read
  couldn't do now give the way on, or say who can fix it:
  - A failed system call is said in plain words, with what helps: an
    unlink's failure no longer quotes Node's message with the host's path,
    and a code in parentheses became words.
  - A push that failed after it began writing or unlinking, or whose
    durability barrier failed, says that whether disk holds the change isn't
    known until it's checked, and that a materialize of the path checks it
    and says how it ended.
  - What stands at a push's path or on its way, such as a symlink this mount
    doesn't follow, one leading out of the mount, a pipe, a link to a
    directory or a directory leading out of the mount, is named with what
    gets past it, forced or not. A disk copy a push couldn't verify names
    who can fix the cause. A reason that already names the path to use, a
    nested mount's place or a link's target, gets nothing added, where "fix
    it and materialize again" followed it before. A push of a file whose
    stored copy is lost names the read, which takes disk's copy where it
    can and otherwise says what can be done.
  - A symlink among a path's directories that the mount doesn't follow names
    the path to use where it leads to a directory inside the mount, and the
    mount whose `followSymlinks` whoever runs the host can set; says that
    nothing lies beneath one leading to something that isn't a directory;
    and says what gets past one leading nowhere or somewhere its refusal
    doesn't name. One leading outside the mount, or a path that leaves the
    mount through a symlink, says that nothing done through the mount
    reaches what it leads to, and that whoever runs the host can mount it,
    or a directory that holds it. A directory on the way that the walk
    can't ask gives its errno's way on. The tools quote the path they were
    given before the link's reason. A symlink at a path the mount doesn't
    follow says that whoever runs the host can set `followSymlinks` where it
    leads inside the mount, mount what it leads to, or a directory that
    holds it, where it leads outside, or remove it where it leads nowhere,
    where before it
    said to name the file it leads to by its own path, which the agent
    couldn't learn and which may lie in no mount.
  - `sync`'s skips, and the incomplete regions of `ls`, `sync`, `grep` and
    an agent-action scan, give a way on where the walk failed, met a
    change, found the root unavailable, met a link or a place leading out
    of the mount or a link to a directory, or reached its cap. A `sync`
    skip of a path its walk passed over, one the mount ignores, an editor's
    swap or backup file, or one beneath a link the walk doesn't enter,
    names the sync of that path, which checks it. A
    listing's per-entry notes and `grep`'s per-file skips stay
    descriptions.
  - A mount whose path holds a file where its directory was is told, as one
    whose directory is gone, that whoever runs the host can put the
    directory back. A region the walk cap left says that naming a path
    beneath it walks only that path, and that whoever runs the host can
    raise the mount's `walkCap`.
  - `read` of a file the workspace doesn't hold, where disk couldn't be
    checked, gives the way on its reason calls for, as a push or a sync
    gives it: an errno's, a symlink's, or that of a directory resolving
    outside the mount.
  - A direct mount's `delete` of a file that changed while it was checked
    says that calling again checks it afresh.
  - `save_recent_image`, where the store throws on a write, says the
    store's errno in plain words with a way on, and still names the images
    already saved. The error is logged whole, since an error it can't word
    that way sends whoever runs the host to the log.
- A forced `materialize` without `applyDeletions` lists a workspace
  deletion that no push makes, forced or not, such as one over or beneath
  a symlink this mount doesn't follow, under `skipped` with why, rather
  than among the deletions `applyDeletions` would make.
- **Hosts calling `readFileFromDisk`, `readBinaryFromDisk` or
  `writeBinary`, or reading a scan's `incomplete`:** codes are unchanged.
  The reason after `<path>: ` in a link refusal now ends with its way on:
  "the mount's host can set followSymlinks: true" became `use "<target>"
  in place of "<link>", or whoever runs this host can set followSymlinks:
  true on mount "<mount>"`. A `writeBinary` failure quotes the push's
  reasons in these words, and the `incomplete` reasons on `status`'s
  `lastAgentActionScan` and the `workspace:agent-action-scan-incomplete`
  event carry their way on, an errno in plain words. Code that matches on
  those words needs updating.

### Fixed

- Every check of whether an agent sees a stored row now asks the agent's own view, so it agrees with what the agent's compile sends: the view filter a resident's or the subconscious's store was opened with, and for an agent whose store has none, such as an ephemeral run, every row. A row a resident's view leaves out, such as a channel message a tune-out diverted, no longer keeps an earlier gate entry from counting as the newest in that resident's window, so a batched wake for that one message runs without its `[Gate: …]` line; and an image in such a row no longer takes an index in `save_recent_image`. A row the view leaves out that a module wrote, such as one carrying another agent's stored context injection mark, no longer goes into the agent's live turn at a tool boundary or moves its turn to the row's channel, and another agent's stored injection no longer counts as read for the agent whose context it is because a resident whose view leaves it out read past it. A row written for the subconscious that carries a tune-out's stamp now goes into its live turn, and a message rather than a notice counts as heard there, since the subconscious's view holds it.

- A closed channel's invitation offers the reply the prose routing of the agent it wakes reads: the one live agent the message names, as a correction delivered to the agent that holds the original does, else the primary. In explicit mode it offers a `>>` prefix, as before; in hybrid mode, a `>>>` one. In locus mode, the default, it says that plain speech lands where the latest word on where it lands says, a `[routing]` notice or `channel_open`'s result, names the channel as those do, and says that a reply with no prefix reaches it when that word names it; otherwise, or with no such word, a send tool of the server's does; opening the channel says where plain speech lands. For a tuned-out channel, whose messages start no turn and which `channel_open` refuses, it gives the same rule and the send tool. In disabled mode it points only to a send tool of the server's. Before, it offered a `>>` prefix in every mode, and locus and hybrid mode post such a line as text, prefix and all, to the turn's channel.

- The framework now marks notice openings in text a participant or a server supplied, in the places named below, to tell that text apart from its own notices in an agent's context. The openings it marks are those that the framework, context-manager 0.23.0 and 0.23.1, or membrane 0.8.0 writes into an agent's context outside a tool result, such as `[drafts]`, `[Channel invitation]`, `[Recall …]` or `[continuing]`. It marks each in upper, lower or mixed case, and through whitespace, control or invisible characters inside its bracket. A value a participant or a server supplied that the framework names in its own text, such as a channel's label, an author's or guild's name, a send's failure reason, a server's error text, or a server's tool and toolset names, titles and descriptions, stays on its line: each run of line breaks in it, in any form, shows as a space, and these openings in it are marked. A value the agent is told to pass back to a tool, such as a channel or message id, is written so it can be passed back exactly: one that holds a line break, one of these openings, a quote, a backslash or whitespace at its edges is written as JSON that stays on one line and parses back to it, and a toolsets tool selector with whitespace at its edges reaches the tool with that name exactly, and the tool with the trimmed name only when no tool the call can reach has the name as written. In a server's or a participant's text, these openings are marked with a backslash (`\[drafts]`) in a channel message, a pushed event, a context injection, console and API input and a Discord message as they're stored, and in channel_open's backscroll. Messages stored before this change keep their text as stored, apart from a Discord message a history sync rebuilds, which is written as new ones are. This change doesn't mark these openings in the name a message is stored under, which a formatter writes before the message.

- **A stdio MCP server's message holding U+2028 or U+2029 inside a string
  arrives.** The stdio transport read the server's output with `readline`,
  which on Node 24 and later, and on Bun, also ends a line at U+2028 and
  U+2029. JSON lets both stand raw inside a string, and `JSON.stringify`
  leaves them so, so such a message reached the host as two lines that
  weren't JSON and was dropped: a response's request then failed after its
  timeout, and a notification never arrived. Lines still end at LF, CRLF
  and a bare CR, and no longer at U+2028 or U+2029, for legacy MCPL and
  modern MCP servers alike. The `agent-framework-mcp` command reads its
  stdin the same way, so a client's request holding either character gets
  its answer, not two parse errors.
- **A message the host sends holding U+2028 or U+2029 arrives at a server
  that reads with `readline` on Node 24 or later, or on Bun,** such as one
  on mcpl-core 0.3.0 or older, which lost it: the MCPL stdio and WebSocket
  transports, and `agent-framework-mcp`'s answers on its stdout, now write
  both characters escaped, as `\u2028` and `\u2029`. It's the same JSON to
  every reader.
- **A line an MCP server sends that isn't JSON is no longer dropped
  silently,** and neither is a JSON value that isn't an object from a legacy
  MCPL server. One stderr line names the server, the line's length, and
  whether it isn't JSON, starts like a JSON object but doesn't parse, or is
  JSON but not an object, never its content. A blank line is still dropped
  without one, and the WebSocket transport still trims each line first and
  drops one that trims to nothing. Each connection logs the first three
  such lines, then one line saying that more go unlogged, so a server that
  writes its logs to stdout doesn't flood the host's.

- The reply judge's list of what wakes the agent asks the gate about each heartbeat tick and reminder as the event its delivery is judged by: a silent tick as silent, each with its text as of its due time. Before, both kinds were probed with the placeholder text `probe`. Ticks and reminders share the server id `heartbeat`, so a rule that tells them apart by their text, or holds back silent ticks by their `silent` flag, showed a held-back wake as certain.

## 0.28.0 — 2026-10-27

### Breaking

- **Hosts and API clients that call `undoLastTurn()`, `redo()` or
  `switchBranch()`, or change an agent's runtime settings:** each of these
  can now be refused with `OperatorActionError` (`agent-busy`), where on
  0.27.0 it went ahead, by our reading of 0.27.0's code:
  - `undoLastTurn()` and `redo()`, while any agent sharing the store is
    busy or a conversation agent is being created, since the branch moves
    under every agent sharing the store. A refused undo or redo keeps its
    checkpoint or redo entry;
  - `switchBranch()` while another move holds the store for its
    re-initialization: a second switch made together with one, which
    0.27.0 refused only while the first still waited for running
    maintenance or a workspace module's mount (a run shows two made
    together with neither both going ahead there), and a switch made
    during an undo's or redo's re-initialization;
  - a runtime-settings change, reset or cancelled transition while an
    undo's or redo's re-initialization, or a surgery, holds the store.
    Nothing of it is applied.

  Retry once the agents are idle and the store is released: an undo's or
  redo's `settled` says when its hold ends.

- **Hosts that pass `new DefaultErrorPolicy(settings)` as `errorPolicy`:**
  the policy now takes your settings' stated-wait ceilings as they are
  (agent-framework#734). 0.27.0 raised each class's ceiling below the
  framework's ten-minute provider-hold cap to that cap, so with a ceiling of
  30 s the policy still retried a 429 stating a 90 s wait. Now it answers no
  retry, as your settings say, and the turn ends. The policy decides such a
  failure for an ephemeral run's turn, such as a subagent's, and
  `runEphemeralToCompletion` then rejects with a plain `Error` carrying the
  provider's words: `ProviderWaitNotSleptError` still means only a wait past
  the framework's ten-minute cap, or one it can't represent. A resident's or
  a conversation agent's stated wait is held by the framework before the
  policy is asked, as in 0.27.0. **Migration:** to keep 0.27.0's behaviour,
  raise each class's `statedWaitCeilingMs` that isn't `null` to at least
  600,000, as 0.27.0 did. The default policy's own settings keep the
  ten-minute ceilings.

- **Hosts and operators whose workspace mounts set `ignore` or `include`:**
  both lists now read one grammar, the gitignore forms a config copied from
  a `.gitignore` uses, and a pattern of any other form stops the module from
  being built, with an error naming the mount, the pattern and why. Each form
  covers the files git's reading of it covers, with three differences: names
  compare exactly, as git's do with `core.ignorecase` off (its default folds
  case on macOS and Windows); a `?` matches one character where git's
  matches one byte, so the two differ on names outside ASCII; and on a mount
  that follows links, a link to a directory counts as a directory, where git
  reads every link as a file. Before,
  `ignore` read only a name, `dir/**` and `*.ext`, and any other pattern
  matched only an entry of exactly that name, or nothing, without a word.

  **Who needs to act:** a config holding a pattern the lists now refuse,
  which loaded before:
  - in either list, a leading `!` or `#`, a trailing space, or a `\`.
    `include` read each of these as part of a name (a `\` only where `/` is
    the platform's separator);
  - in `ignore`, also a `[`, `**` anywhere but as the first segment before
    one name or in a trailing `/**`, or an empty, `.` or `..` segment, which
    `include` already refused, apart from the `[`. `include` still reads a
    `[` as itself, so `[id].tsx` names that file.

  Remove such a pattern, or write it in a form the lists read. A `?` matches
  any one character, so it can stand for a `[` or `\` in a name: in `ignore`,
  `?id].tsx` covers `[id].tsx`, and any other name that differs from it only
  in that character. An `ignore` that isn't a list, such as `null`, is
  refused too; `[]` still ignores nothing.

  **What `ignore` now covers that it didn't:**
  - `dir/`: a directory named `dir` at any depth, with what lies beneath it,
    and no file of that name;
  - `/dir` and `a/b`: that path from the mount's root;
  - `**/name`: `name` at any depth, as `name` alone, and `**/name/**` as
    `name/`;
  - `*` and `?` within a name, such as `npm-debug.log*`, `.env*` or
    `te?t.txt`. Before, a `*` anywhere but a leading `*.`, and every `?`,
    matched only itself.

  **What `ignore` no longer covers:** a file named like a `dir/**` pattern's
  directory. `node_modules/**` covers the root's `node_modules` directory
  and what lies beneath it, and no longer a file named `node_modules`.

  **`include`** reads the same forms for files: `fixtures/` covers every
  file beneath a directory named `fixtures`, at any depth, `/gate.json` only
  the root's `gate.json`, and `src/*.ts` the `.ts` files directly in the
  root's `src`. Each was refused before. A `?` in an include pattern, which
  it read as itself, now matches any one character, so such a pattern covers
  more files than before.

- **Hosts that set `toolHints: true` on an MCPL server without granting it `pushEvents`:** the reminder that restates a server's open toolsets at an agent's next start, once their announcement has left the context, now comes only for a server granted `pushEvents`, like every other notice of its changes. Grant `pushEvents` to that server to keep the reminders.

- **Hosts:** agent-framework now requires `@animalabs/membrane` ^0.8.0 (was
  ^0.7.1) and `@animalabs/context-manager` ^0.23.0 (was ^0.22.0), which
  admit no membrane 0.7.x. A host whose own membrane range is still ^0.7
  gets two membrane copies. TypeScript then refuses the host's `Membrane`
  in `FrameworkConfig.membrane` (TS2741). JavaScript isn't refused, but
  context-manager then hands its own membrane 0.8 formatter to the host's
  0.7 `Membrane` on every call it makes, a mix this release's tests don't
  cover.
  **Migration:** move the host to membrane ^0.8.0 with this release. A host
  that depends on context-manager itself moves it to the framework's range,
  ^0.23.0, too. membrane 0.8.0's own changelog says what it adds and
  changes. context-manager 0.23.0 also changes when summaries merge and
  what its debt report counts; its own changelog says how.
  **Unchanged:** the framework's own code. For the framework's request
  shapes compared before this release, membrane 0.8.0's native formatter on
  its Anthropic and Bedrock adapters builds the same bytes as 0.7.2's.
  membrane's retry settings and schedules are unchanged too.

- **Operators of a workspace with a nested mount, on a disk that tells names apart:** the nested-mount checks now compare a path with a nested mount's directory as any disk may compare names, at every level, so that on a disk that folds names the outer mount can't write into that mount's directory unseen. Where the disk keeps apart two names the comparison joins, a name the outer mount read and wrote as its own is now taken for the nested mount's directory: every tool that names it is refused as a path that may lie in the nested mount, with the two spellings the workspace can't tell apart and a step for each thing the caller may have meant, and walks and pushes pass over it. Where a followed link leads outside the mount, to a place only the comparison takes for the nested mount's directory, the refusal says only that it can't tell. That's, at any level:
  - a name in another case than a nested mount's directory's name, on a disk that tells case apart;
  - a name in the other Unicode normalization form, on a disk that keeps the forms apart, as ext4 does by default;
  - a name the comparison folds with it that the disk keeps apart, such as `ss` beside a nested `ß`, or `ı` beside a nested `i`, or a name that differs from a nested directory's only by a default-ignorable code point, such as `inner` with a soft hyphen or a zero-width joiner inside, which the comparison takes for `inner`, as Linux's casefold does.
  - **What to do:** rename one of the two spellings, which the refusal names, except where it can't show where a link leads. Where two mounts' roots are configured in spellings the workspace can't tell apart, start places the nested mount by a guess, and the refusal asks for the configuration to be checked.
  - **What the outer mount already held there** stays in its history, and no push of the outer mount writes it. Where the mounts' includes cover it, a listing shows it with the same note.

### Added

- **`undoLastTurn()`'s and `redo()`'s results carry `settled` when the store
  moved:** a promise that settles once the store's reservation is released,
  each agent's context manager re-initialized for the branch the store moved
  to or its failure alerted. It never rejects. Await it before work that
  needs the store free: a compile on an agent's own context manager, which
  refuses until that manager is re-initialized, or a write meant to land at
  once, which the reservation defers. An undo or redo made while an earlier
  one's managers re-initialize settles with it. The API server's `undo` and
  `redo` now wait for it before they broadcast `branch:switched` and answer,
  so a client that reads an agent's context when it hears the event gets it.
  Their answers are as before, without the promise.

- The heartbeat moves into the framework (`FrameworkConfig.heartbeat`, src/heartbeat/heartbeat.ts). It was the heartbeat-mcpl server: the agent's own periodic check-in, in message or silent mode, and its one-off and repeating reminders. The tools are `heartbeat--heartbeat_status`, `heartbeat--heartbeat_configure`, `heartbeat--heartbeat_trigger`, `heartbeat--reminder_add`, `heartbeat--reminder_list` and `heartbeat--reminder_cancel`. Wakes go to the gate as the server's pushes did, as a push from the server id `heartbeat`: the agent's rules decide them (a rule matching `source: "heartbeat"`, the gate's default), and a sleep lets them through, as it let that server id through. A message-mode tick and a reminder store their timestamped text whatever the rules decide, as a push's is stored; a silent tick, when the rules wake the agent for it, is a silent-heartbeat turn with prose suppressed. The wakes go to the residents, not to conversation forks, ephemeral runs or the subconscious.
  - State is one file, by default `{storePath}/config/heartbeat.json`: the schedule, the next tick's time and the reminders. The next tick's time is kept across restarts, so a restart doesn't push it back. A tick or reminder that fell due while the host was down fires once, ten seconds after start; a repeating reminder fires once for the periods it missed.
  - `importFrom: { configPath, remindersPath }` brings heartbeat-mcpl's schedule and reminders along the first time, leaving its files as they are.
  - heartbeat-mcpl beside it is refused, at create and at a runtime connect or restart: both would wake the agent and offer the same tools. That covers an MCPL server with the id `heartbeat`, one with the tool prefix `heartbeat` or `mcpl--heartbeat`, and one whose command runs heartbeat-mcpl. `heartbeat` must be `true`, `false`, null or an object, its paths text; anything else is refused at create rather than read as on.
  - Calls by heartbeat-mcpl's names under the default prefix (`mcpl--heartbeat--…`), which residents' contexts hold, reach the same tools, and the result names the new one. An agent's `allowedTools` that names a heartbeat tool under either prefix allows it under both. The tools answer every call path: a turn's, an in-process `executeToolCall`, a puppet, and a module's `callTool`.
  - A conversation fork or an ephemeral run can call `heartbeat_status` and `reminder_list` but not change the schedule or set a reminder, which would wake the residents, not it. The subconscious's own tool surface doesn't include the heartbeat's tools.
  - A tick or reminder whose delivery throws is tried again a minute later. A reminder keeps its due time for its header and its rhythm.
  - The reply judge is told the heartbeat's next tick and each pending reminder among what wakes the agent if it waits. One the agent's rules would hold back is listed only as a "maybe".

- A resident is told when reasoning that nothing in its window shows leaves
  its context, in a `[reasoning] <agent>:` line
  (anima-research/context-manager#155). The line is stored as a system notice
  of kind `reasoning-loss`, through `addMessage` with the agent as its target,
  so while a turn is alive it waits for the agent's next boundary, as the
  framework's other notices do.
  - **What's told:** with `thinkingBinding.binds` set, a committing compile's
    strip that begins at a change of the request's head, naming the tools,
    system text or model that changed, or at a branch's first compile, and a
    fold or other change to an earlier message that takes a reply of the
    current turn; a strip counts each stored reply once per agent and branch.
    With `dropBlock` set, blocks the provider dropped that can be placed as
    stored replies or the stream's own rounds, told once per incident and
    again when a call drops more.
  - **What isn't:** a compile before the agent's first framework stream, so
    an agent driven only through the direct `Agent` API is never told; a fold
    between turns; any other change to an earlier message between turns; and
    a call none of whose dropped blocks can be placed, which is the
    `thinking-binding-loss` ops alert's to report, by its own rules.
  - `Agent.onThinkingStrip` is a host's hook, called with each committing
    compile's `thinkingStrip` (never a dry run's) and the key of the branch it
    read. The framework sets it at the agent's first stream unless a host has
    set one; a host's own observer stands in for the framework's, whose line
    for that agent then isn't told.
  - `StartStreamResult.thinkingBranch` is the key of the branch the stream's
    compile read, and `Agent.branchHead()` gives the current branch's key and
    head.

- `StartStreamResult.carriedBodies`: the stored bodies the request's
  compile carried, by each body's first message id, from its provenance's
  raw bodies. Absent when the compile reports no provenance.

- A new wake-rule behavior, `judge`, that asks a small model before waking the agent. A judge rule batches matching events as a debounce does (`debounceMs`, with an optional `maxWaitMs` that judges a batch by then even while messages keep coming). When the batch fires, the reply judge reads three things: the agent's context as one document (the request the agent would send if woken now, `previewActivation`'s dry run: its newest part, oldest first), the agent's own `instructions` to it, and the batch. It answers `REPLY` or `WAIT`. On reply the batch wakes the agent as a debounce's would. On wait it doesn't, and the events stay in context, as for `defer`. Rules are read in order, as ever: a mention rule placed ahead of a judge rule wakes the agent without the judge, and the turn it starts stops and holds the judge as any resident's turn does. A mention the judge rule itself matches goes to the judge with its batch, marked as addressing the agent.
- Batches are judged against the context as it stands after the residents' turns, since the residents share the message slot the judge reads. A batch that fires while a resident's turn runs or the host is quiesced is held, then judged once both are clear. A resident's turn that starts while the judge decides, or a quiesce, stops the judge, and its batch is judged once the turn ends or at resume, against what the turn left, and the turn never waits for the judge. A stopped call is no verdict: it wakes nothing and isn't counted as a failure. A fork's or the subconscious's turn, in a store of its own, neither holds a judge rule's batch nor stops the judge; the wake a batch gets still waits while any agent's turn runs, as every batched wake does. A judge rule's batch that is waiting, held or being judged when the rule is changed or removed is still judged: by the rule as it is when the judge is asked, while it's still a judge rule, and by the rule as it was once it isn't. `wake_remove_rule` says so where a judge is wired. What a rule holds for the judge while a turn runs, and the events waiting behind a judge call, are each capped at the inference buffer's 100 events, dropping the oldest, which `inferenceDiagnostics()` counts.
- The judge is told what waiting would leave the agent with: what will wake it anyway with no new event, soonest first. That covers its own `skip_reply` timer, the end of a sleep, other rules' pending batches (a judge rule's only "maybe"), a wake already queued, and a turn held by a provider cooldown. When none is pending, it's told nothing the host knows of is scheduled; a server's own timers, such as a heartbeat, aren't known to the host. The gate's part is `EventGate.upcomingWakes()` and `JudgeRequest.upcomingWakes`; the framework adds its own through `ReplyJudgeDeps.upcomingWakes`.
- The judge is wired unless the host turns it off (`GateOptions.judge.enabled: false`), and it runs only for judge rules, so a gate without them makes no judge calls. The agent writes judge rules with `wake_add_rule`'s new `judge` parameter. With the judge off, the tool is as it was. gate_status shows each judge rule's verdict counts and its newest verdict, with the judge's reason. It also says when a judge rule is in force with no judge wired, and when the judge has failed three times in a row. Each verdict is traced as `gate:judge-verdict`, with its counts and tokens but not the judge's reason, which is written from the agent's context.
- The judge is `ReplyJudge` (`src/gate/reply-judge.ts`), configured by `GateOptions.judge`. The package root exports it with the judge's types, `JudgeEventSummary` among them:
  - `model`: default `claude-haiku-5-5`.
  - `maxInputTokens`: default 90,000, under the 100K line past which Haiku 5.5 costs five times as much. At least 4,000, which makes it read a short tail; a smaller value is read as 4,000, with a log line.
  - `timeoutMs`: default 20,000.
  - `onError`: `"wake"` (the default) or `"skip"`.
  - `effort`: default `"low"`; `"none"` sends none, for a provider without Anthropic's `output_config`.
  - `cacheTtl`: `"5m"` (the default) or `"1h"`.
  - `enabled: false` leaves it unwired.
- How the judge calls its model:
  - The agent's provider holds bind its calls, but where compression waits out a hold, a judge call is refused without being made: under a hold on the agent or on the call's model, and, as compression's are, under a surgery or at stop. A refused call takes `onError`'s path. A call that fails records the wait its provider states, if any, so the judge's next call on that model is refused until it ends, and holds nothing else: the judge usually runs on another model than the agent's. None of them waits on the agent's turn, which stops the judge instead.
  - Each request's usage counts as the judged agent's, in its usage tally and the session's totals, as a turn's does.
  - It always uses membrane's native formatter: an XML-formatted request would end in a prefill, which current Claude models refuse.
  - It reads the newest part of the agent's context that fits `maxInputTokens`, so the judge weighs the room's history and not only its last few lines. Input tokens are estimated at a ratio corrected from every response's reported usage.
  - The document goes in chunks from a fixed first message, with a cache breakpoint after the last full chunk, so successive requests read most of it from the prompt cache. The agent's system prompt (abridged) follows the conversation, and the batch's listing is capped at a tenth of the budget, newest first.
  - The verdict is the last line in the asked-for form (`REPLY:` / `WAIT:` in capitals).
- Failures and fallbacks:
  - A judge that fails, times out or answers without a verdict wakes the agent (fail open), unless `onError` is `"skip"`.
  - Without a judge wired, a judge rule wakes the agent as a debounce of the same quiet period would.

- **Hosts:** a turn waiting out its error policy's delay before a retry now
  says so with an `inference:waiting` trace event: as the wait begins, with
  `until`, the time the wait is due to end, and again every 60 seconds
  while it lasts, while its agent is the one registered under its name, and
  never after the wait ends. The failure being retried is the `inference:failed`
  just before it. A host that watches for agents gone quiet can tell a
  waiting one from a stuck one: connectome-host's subagent reaper
  reclaims a subagent that has been silent for two minutes with no request
  in flight, and `inference:failed` ends its request in flight, while the
  default policy's waits before a 529's fifth and later retries run from 80
  seconds to five minutes.

- `InferenceRequest.readsStoredMessage` names the stored message that is a
  wake's sole cause, by its row's id, as `readsDeferredWrite` names a held
  write. `WritePlacement` gains `messageId`: for a message the gate
  writes, such as its self-wake notice, the `addMessage` hook fills it when
  the message was stored rather than held, as it fills `deferredId` when it
  was held, and the gate passes that placement to `requestInference` as
  `after`.

- The answers of `write`, `edit`, `edit_many` and `delete`, and a
  `WorkspaceModule.writeBinary` success, carry `disk`: where the change
  stands on disk as the workspace last saw it. `done` means nothing of it
  waits, apart from a file mode the answer's `modeKept` names: the call
  wrote it there, on a direct mount or through `autoMaterialize`'s push, or
  disk already agreed with it, or a deletion found no disk copy of the
  workspace's to remove. `waits for materialize` means a materialize writes
  it, and `waits for materialize with applyDeletions` means a deletion takes
  a materialize with that option, since one without it leaves the file.
  `in conflict with disk` means an unforced materialize leaves the path: a
  sync of the path takes disk's state there, its copy or its deletion, and a
  materialize of the path with `force`, and `applyDeletions` for a deletion,
  writes the workspace's. In `edit` and `edit_many` it's a header line, and
  `edit_many` gives the value of its file furthest from disk. Each file
  `save_recent_image` saves carries it too, or `diskCopyError` where the
  file's disk copy failed. Before, on a store-backed mount without
  `autoMaterialize`, these answers read the same as where the change was
  already on disk.

### Changed

- **`undoLastTurn()` and `redo()` reserve the store as a surgery does**
  (their new refusals are under Breaking). An undo or redo of an agent that
  is itself busy is refused with `OperatorActionError` (`agent-busy`), where
  it threw a plain `Error`. Each still returns its result at once, with the
  store moved, and its `settled` says when the store is let go. The
  re-initialization of every agent's context manager finishes after the
  call returns, and the store stays reserved until it's done: a turn asked for meanwhile starts after, and a
  `rollbackToMessage()`, `suppressMessages()` or `switchBranch()` made
  meanwhile is refused as busy. A context-settings preview made meanwhile is
  refused by context-manager until that agent's manager is current, as
  during a surgery's switch. An undo or redo made meanwhile moves the
  store again under the same reservation, and the managers are
  re-initialized for the branch the last one leaves. The re-initialization
  waits first for maintenance already running, a pass or an over-budget
  drain kick; the move itself is synchronous, so a maintenance tick running
  at that moment still runs across it, as before. Its work was for the
  branch the store left, so context-manager's refusal of that work isn't
  reported as a maintenance failure; any other failure it meets is.
  Creating a conversation agent waits while a move or a surgery holds the
  store, since its context is seeded from the template's, and a move made
  while one is being created is refused as busy. An undo or redo that fails
  leaves the store where it was, with the turn still there to undo or redo
  (before, a failed undo lost its turn, and a failed redo its step), unless
  it's a redo whose branch has been deleted, which drops that step and says
  so, naming the branch and how many redo steps remain.
- **While the store is held, by a surgery, a branch switch, an undo or a
  redo, a coalesced update or retraction no longer removes the stored,
  unread message it updates or withdraws.** The update, or the retraction's
  notice, is added once the store is released, and a retraction with no
  notice leaves the message in place, so an agent can read a message
  withdrawn while the store was held.

- `agent_settings` refuses an update that names something that isn't a setting
  (`Unknown setting: tail_token`), or names `settings`, which only a reset
  reads, where it dropped the name unseen and answered as if the call had
  succeeded. A reset refuses a name beside `settings` the same way, where it
  dropped the name and, with no `settings` list, reset everything. A reset
  also refuses a name in `settings` that is inherited, such as
  `constructor`, which it took as a setting and reset nothing, and a module
  setting whose extension has no `reset`, which it skipped and answered as
  reset. A cancel refuses any name beside `action`, where it ignored the name
  and cancelled.
- `agent_settings` refuses `null`, `true` or `false`, a list, an object or
  blank text for a numeric setting (`context_budget_tokens`, `tail_tokens`,
  `transition_pace_tokens`, `tool_result_inline_max_chars`). Each was read as
  a number, and applied where that number was in range: `tail_tokens: null`,
  `false` or `""` set the tail to 0, `true` set the tail or the pace to 1,
  and a one-item list such as `[20000]` set any of the four to its item.
  Text that reads as a number, such as `"20000"`, is still taken, and text
  that doesn't, such as `"abc"`, is refused as before, now saying it must be
  a number.
- `agent_settings` refuses `immediate` given as anything but true or false,
  or the text `"true"` or `"false"`. It was read with `Boolean()`, so `1`,
  `"yes"` or a list applied a lower budget at once, and `0`, `null` or `""`
  paced it.

- A wake queued while a turn runs is no longer taken into the turn's
  context-budget restart when the restart is queued beside it, or released
  beside it by a provider hold. It goes back to the queue and waits for the
  restarted turn, as it does when a turn ends without a restart. Then a wake
  that names its message is dropped once a request that carried the message
  has been answered (for a channel wake not marked ambient, once the agent
  has also spoken in that channel since), or once the message is gone from
  the queue and the store's current branch. Any other wake starts a turn of
  its own.
  A restart takes in no new input, so a coalesced batch the wake carried
  wasn't assembled there, and no turn of its own followed; and a silent
  turn's restart (`suppressProse`) that took an ordinary wake resumed with
  prose routing.

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

- `ToolResult.refused` is now also set on the result the framework stores for each call in the last round of a response the output limit cut off. Those calls are never dispatched, and before this change nothing answered them; until now only the dispatcher's path set `refused`. Their results go into the context with the reply, not through a `tool-result` event, so a host reading `refused` from tool results won't meet them there. Within the framework, the tool-result guard, when it's on, reads it for its notice on a batch it withholds and keeps it in its audit record. Each such call also gets a `tool:failed` trace.

- In XML tool mode, or with a membrane that gives a tool round no `roundContent`, such a round's speech reaches a channel only when its stream completes. When the stream instead fails, is stopped, is ended by a tool, is retried by the error policy or restarted for the context budget or by the tool-result guard, or is abandoned by a quiesce or `stop()`, a `[speech-not-posted]` notice now tells the agent that nothing it wrote before its tool calls in those rounds was posted, so it can send what should go out again. Before this change nothing said so, and a retry's request carried the words as already said. A turn its own `skip_reply` ends and a silent turn get no notice. With thinking on in XML tool mode, a round whose text was only thinking gets the notice too, since only the round's raw text is at hand there.
- A turn that fails, or that a caller stops, writes no `[delivered]` receipt, as before. When its rounds' plain speech was delivered live (native tool mode, locus or hybrid routing), its `[inference-failed]` note, or the stop's `[turn-interrupted]` note, now adds that the speech was handed on for delivery as written and that no `[delivered]` line was written for it. When some of its speech was still being routed as the turn ended, the note also says it may yet be posted, and to check the channel before sending it again. A delivery that finished undelivered gets neither, beside the `[discord-send-failed]` note a channel delivery gets, or a refused `>>>` envelope's bounce. A caller's stop after a round whose tool calls were started but whose results never came back says those calls may have taken effect, as the failure note does. Before this change those notes said nothing about speech already routed or calls already started.

- `HostModeStatus.gatedRequests` counts the inference requests waiting to
  start in the queue, in a scheduler pass's hands, or held by a provider
  hold (an acceleration or host hold, or a provider's stated wait). There,
  a start that carries a turn on counts as the wakes merged into it. What a
  quiesce lets through, a turn's continuation or its held retry, still
  isn't counted, and a start parked on provider admission behind an
  auxiliary call still counts in `parkedAdmissions` instead. Before, it
  counted only queued requests, and no wake merged into a start, so a wake
  a hold kept while no turn was alive showed nowhere in the status. A host
  that reads `gatedRequests` beside `drained` to decide an agent is idle
  answered while the wake waited for the hold to end. That happens when a
  host's `providerHold` holds after a failed compression, when a provider's
  stated wait on the agent's model holds a wake (one a failed compression
  on that model records, for example), or when a stop drops a turn's retry
  from a hold that then keeps a later wake. Such a host's idle check now
  waits for the hold to end, however long the provider's stated wait, or
  until an operator releases a wait with no end. `drained` is unchanged: it
  is true when no turn is alive and nothing is parked on provider
  admission, and a hold that releases during a quiesce hands its wakes to
  the quiesce gate, as any queued wake meets it, so no turn starts until
  `resume()`. The quiesce's log line says "wake(s) waiting" where it
  said "wake(s) parked".

- MCPL RFC-014 tool presence (`toolHints: true`):
  - A move between static and dynamic takes effect when the server's `tools/list` states it, not when a hint announces it, and once the next rebuild of the model's tool list that lists the server has published it, a notice says where the tool went, unless a list read during that rebuild undid the move. A move is no reason to rebuild the tool list early, whether a hint announced it or the host's own re-read found it.
  - Each `ended` id is told once while the host runs: told ids are kept in memory, an id counts as told only once a notice or a result carrying it reached the agent, and it is forgotten once the server stops reporting it. Rare interleavings, such as a `toolsets--look` overlapping another read of the same server, can tell one twice.
  - `toolsets--look` naming a tool shows its signature, description, class and input schema, as before; the README no longer calls that its whole definition. What look's own re-read of the server changed is in its answer when it restates everything, and otherwise told as a notice.

- MCPL RFC-014 tool presence (`toolHints: true`): until a move between static and dynamic reaches the model's tool list, the tool is called at either place: by its prefixed name where the tool list or the server's latest `tools/list` shows it static, and through `toolsets--act` where either shows it dynamic (RFC-014 §4.2). A dynamic tool called by its prefixed name is therefore no longer always refused. `toolsets--look` naming a tool shows the definition `toolsets--act` would check it against wherever `toolsets--act` would take it.

- **Workspace mounts:** a mount root found on another device with the same inode and the same birth time, given to a fraction of a second, is now the directory disk last agreed with. The workspace records it on its new device and keeps what it recorded about its files, so a reboot that gives the volume another device number, as macOS can, no longer leaves the mount taking no writes until a `sync` with `acceptRoot`, after which every draft whose bytes differed from disk's came back as a conflict. A root recorded before this release gains its birth time at the next pass, or the next push that records anything about its files, that finds it on its old device and inode. A root on another device with another inode or another birth time, or with no birth time to compare (where the runtime reports none, or a record that hasn't gained one yet), or one in whole seconds, still needs `acceptRoot`, as before: volume roots made in the same second can share their inode and a whole-second birth time. A mounted APFS snapshot or a block-level replica of the volume (a `dd` or `asr` image) at the path keeps the original's inode and birth time, so it is read as the original: its older files are taken as disk edits and files it lacks as deleted, and a draft over one of them is a conflict.

- In `locus` and `hybrid` mode, an explicit send now holds plain speech back
  only where the send may have posted. Before, a round with any send
  (`send_message`, `reply_message`, `send_dm`, `channel_publish`, a `drafts`
  resend, a world's `say` or `whisper`) held that round's plain speech as
  drafts, and every later round's until a new message arrived, wherever it was
  going: a line to the person in the conversation, written beside a send into
  another channel, was held as a draft instead of reaching them. Now a round
  with a send routes its plain speech once its sends have answered, and holds
  a segment only where a send may have posted to that segment's own target:
  the turn's locus, or in `hybrid` mode the sticky target or a `>>>` target.
  Where a send posted is read from its answer: a server's success answer whose
  JSON names the channel (`channelId`), or, for `channel_publish` and a
  `drafts` resend, the framework's own publish outcome, which counts as posted
  when delivered or unconfirmed. A send whose answer is an error, or names no
  channel the framework reads (as, by our reading of eidoverse-worlds' source,
  a world's `say` does), holds the round's speech wherever it was going, as
  before. A send the framework refused, or whose publish is proven not posted,
  holds nothing. In `hybrid` mode, when every send's place is known, an
  envelope whose `>>>` target names no channel, or a malformed one, now goes
  as it would with no send (a bounce, or in a `drafts` round a draft held with
  no notice); before, the send held it as a draft with a notice. The hold
  lasts for the rest of the turn, for speech to the places a send may have
  posted, until a new message reaches the resident. A script's sends count by
  their answers too, and a send still out when its `code_execution` call
  returns counts as one that may have posted anywhere; in XML tool mode, which
  routes a turn's speech once at its end, the places of all the turn's sends
  count. A `drafts` round keeps the speech the turn's sends silenced (#701).
- The costs: a round with a send waits for the send's answer before its speech
  goes, so a send that hangs holds its round's speech until the tool's own
  timeout; narration beside a send to another channel, such as "posting it to
  the other channel now", now reaches the conversation; and a world's `say`
  still holds its round's speech, since, by our reading of eidoverse-worlds'
  source, its answer names no channel.
- The held-draft notice now names the send, where it posted or may have
  posted, and where the speech was going, or says the framework can't tell
  where, or whether, the send posted, and why; for a send in an earlier round
  of the turn, a notice mid-turn says the hold lasts until a new message
  arrives or the turn ends. Its resend example names the place the speech was
  going, by a name a resend in the turn reaches it by, where it always said
  `"#channel"`; with no such name it still does. A held draft's note now
  records where it was going, which `drafts` `read` shows. For such a draft,
  `list` and the catch-up notice now give "explicit send in its turn" as the
  reason, and `read` "an explicit send in its turn held it back", where each
  said the send was in the same round. The `drafts` tool's description says a
  draft was held back because an explicit send in its turn may already have
  posted where it was going. An `autoContinue` turn's `[continue]` row, after
  a turn some or all of whose closing words a send held, now says "Some or all
  of your closing words last turn were held, not sent: a send that turn may
  already have posted where they were going" where it said "Your closing words
  last turn were held, not sent: that turn had already sent with a send tool".

- The default error policy gives a 529, or an overloaded error mid-stream,
  thirteen tries on membrane's overloaded schedule where 0.27.0 gave
  membrane's seven: jittered waits from 10 s doubling to five minutes come to
  20 to 40 minutes, about 30 on average (2,410 s nominal), as long as 0.26.0
  bore a 529 with membrane's seven sends inside each of its four tries
  (2,440 s nominal). 0.27.0's seven tries came to 5 to 10 minutes (610 s
  nominal). A host that passes `new DefaultErrorPolicy(settings)` keeps its
  own count. Ephemeral runs, such as a host's subagents, get the thirteen
  tries too, so a host that retries whole runs multiplies them:
  connectome-host starts a subagent's run again up to twice more after an
  overloaded error, so in a 529 storm one gets up to 39 sends over about 60
  to 120 minutes, where 0.27.0 gave it 21 over about 15 to 31. A stop through
  `Agent.cancelStream()`, as connectome-host's is, waits out the wait it
  finds, as in 0.27.0, and seven of the twelve waits run 150 to 300 s;
  `abortInference()` ends one at once.

- The workspace's tools word a call they refuse, or one that fails, one way:
  what didn't happen, what the agent gave, then the way on, or that calling
  again won't change it and who can. A path naming no mount lists the mounts
  and offers the closest, a leading `/` is named, a read-only mount names
  the mounts that take writes, a size refusal gives the size and the limit,
  `read_image` says what about the file stops it, and in these answers an
  errno reaches an agent in plain words rather than Node's message with the
  host's path, a store's I/O failure included. An error no handler threw on
  purpose names the call and its path, and for a call that changes files
  says whether the change was stored, that the files already held it, or
  that this isn't known; where the call leaves the store awaiting its
  reopening, the answer says only a restart ends that, a stored change's
  included. `ls` of a missing path or of a file, and `materialize` or `sync`
  of a path held nowhere, add a `note` saying so.
- **Hosts calling `readFileFromDisk`, `readBinary`, `readBinaryFromDisk` or
  `writeBinary`:** a refusal's code is unchanged. Its words have changed for
  a path that names no mount, climbs out of its mount or holds a lone
  surrogate; for the read-only and size refusals; for `readBinary`'s
  answers, but for a file neither the workspace nor disk has on a mount the
  workspace stores, which keeps `readFileFromDisk`'s words; for an errno
  `readFileFromDisk` gives from a link check, now in plain words; and for
  the reason after `Mount unavailable: <mount>:` while the store awaits
  reopening. An error `readFileFromDisk` meets while parsing a path that
  isn't a refusal is thrown as it is, not as a `traversal` refusal. Code
  that matches on those words needs updating.

### Fixed

- **After the store's branch moves, the context manager of every registered
  agent sharing it works again without a restart, unless its
  re-initialization fails.**
  `rollbackToMessage()`, `suppressMessages()`, `switchBranch()`,
  `undoLastTurn()` and `redo()` now re-initialize every agent's context
  manager for the branch the store is on, before the store is released. A
  rollback or suppression waits for them before it returns. Before,
  context-manager re-initialized only a manager that made the move itself:
  after a rollback or suppression, every agent but the one named kept a
  strategy loaded for the branch the store had left, and after a branch
  switch, undo or redo every agent did. An autobiographical strategy then
  refused that agent's compiles, its readiness and its maintenance until the
  host restarted. A manager whose re-initialization fails raises an ops
  alert, `context-reinit-failed`, naming its agent and the move, unless the
  agent has left by then, as a run its watchdog ended; it is
  logged and traced each time, and the alert webhook posts it at most once
  per agent and kind in 15 minutes, as it does any alert without a key of
  its own. Each alert says
  what happened and what to do or what happens next first, within the start
  the webhook keeps of a long message, whatever the branches it names, and
  its cause last.
  That agent refuses its
  work, compiles and message writes included, until `switchBranch()` (to
  the branch the store is already on, too) re-initializes it and stores the
  writes kept queued for it meanwhile, at resume on a quiesced host; a
  restart can lose those writes. `stop()` says how many writes it leaves queued for
  an agent whose store didn't take them, and whether they're kept for boot.
  That line, and its line for writes left queued behind a stream still
  running, now say the persisted queue's record is behind, rather than that
  boot keeps them, when the record's last write failed or met the cap.
  The move itself stands. A rollback or suppression whose switch back to the
  source branch fails as well raises the same alert for the agent it named,
  and says which branch the store is on, and whether the agent's manager
  refuses its work there, or, after a suppression whose removals failed and
  whose switch back couldn't select the source, is current on the
  suppression's branch, which its fork initialized it for, and serves from
  there until a `switchBranch()` moves it. A rollback or suppression refused
  before the store moved, such as one whose branch name is already taken,
  re-initializes nothing. Each move re-initializes every agent on the store,
  one at a time with the event loop running between them, so the store stays
  reserved for longer as agents and their stored history grow, while the
  host goes on handling events between agents. Each agent's own
  re-initialization can still hold the host for its whole length, which
  grows with that agent's stored history. Nothing bounds it, or the wait for
  maintenance already running that comes before it, so a move whose hold on
  the store is still up after 60 s raises one `store-held-long` ops alert.
  It says what a restart does: it ends the move, the conversation agents
  and the runs, and re-initializes the configured agents, and writes still
  queued at exit survive only in a persisted deferral queue. Then it names
  the agent the move was for, and the manager its pass is re-initializing
  or the maintenance it's waiting for. It's raised for every move that holds the store: a
  rollback, a suppression and a branch switch, as well as an undo or redo.
- **A conversation agent with no stored message of its own on the branch
  the store moves to is disposed,** as one spawned after the point a move
  returns to has none there. Re-initialized, it would answer with no
  history. Its channel is unbound, and `context-reinit-failed` says so, and
  how many writes were held for it while the store was held. Its channel's
  next qualifying message spawns a new fork from the template, under a new
  name, which needs the template's own context manager to be working. Its
  messages stay in the store, but no agent reads them again, so an undo and
  then a redo don't bring it back. It's disposed whether or not its own
  re-initialization succeeded, with the disposal's alert alone, which gives
  that failure's cause when there was one; that alert's webhook cooldown is
  its own, so a refusal posted for the same agent doesn't silence it. After a rollback, a branch
  switch, an undo or a redo, every conversation agent is judged once, on
  the branch the store lands on, after every manager is re-initialized, so
  a fork an undo empties and a redo made before then restores is kept; a
  suppression can't empty one. One with stored history there
  stays, even where that history compiles to nothing. If disposing it fails
  partway, the alert says that too, and the others are still judged. What
  reaches a conversation agent while a move holds the store, from its
  channel, a correction for it or its idle closure, is written after the
  release, as every agent's writes are; before, it was written at once, on
  the branch a rollback was about to leave. A spawn that comes to create a
  conversation agent once a `stop()` of its lifecycle has begun, under way,
  done, or failed with no `start()` since, as one waiting out a move's hold
  can, fails as a failed spawn does, rather than open its context manager
  on a store `stop()` is tearing down or has torn down. A spawn waits out a
  move's hold before it stores its channel's name counter, so the counter
  is on the branch the store lands on, and a restart doesn't give a later
  fork that fork's name.

- A tool call whose arguments membrane marks as not the model's (`unparseableInput`) no longer runs (#363). The model gets an error result that says what came instead, and can call again:
  - none of its arguments, when they never arrived;
  - text that isn't JSON, which may have been cut off, with the start of it;
  - an array, a number, a string or a boolean, in the words a module tool's check uses (#372);
  - an object from a response that didn't arrive whole and in order, which can't be taken as the call's own.

  A call marked as JSON `null` still runs, as a call with no arguments: its input is `{}`, whatever its block carried. A refused `skip_reply` silences nothing after its round, and a refused send counts for nothing, as with calls the agent's `allowedTools` refuses. `ToolCall` declares `unparseableInput`, and the calls `Agent.runInference` returns keep it. `executeToolCall`, a module's `callTool`, a queued `tool-call` event and `ModuleRegistry.handleToolCall` answer a marked call with the same text, as a failure, without running it, except one marked as JSON `null`, which runs with no arguments.

- A context manager the framework is done with makes no further provider
  call, and none of its work runs after a store the framework owns closes
  (#550). From an ephemeral agent's run's end or its `cleanup()`, and from a
  conversation fork's disposal, its manager's new compression calls are
  withdrawn unsent, and the calls it has out are aborted, so membrane
  doesn't retry them. An ephemeral agent's new calls are withdrawn under a
  surgery's hold and once `stop()` has begun too, as a resident's and a
  conversation agent's already were; a call already out then runs on, as
  theirs do, until `stop()` closes a store the framework owns. Before, a
  strategy that compresses in the background, as connectome-host builds a
  subagent's, went on calling the provider in each of those cases, and a
  call still out when `stop()` closed the store answered into the closed
  store. `stop()`, with a store it owns, closes every manager it opened
  that's still alive, residents', the subconscious's and released ones
  included (`ContextManager.close()`), before it closes the store, so work a
  release left unwinding reads nothing of the closed store. A failed
  `create()` closes the managers it opened, whoever owns the store, and a
  fork or an ephemeral agent whose creation fails after its manager opened
  has that manager closed. A released manager stays open until then, as
  before, so its window still takes the writes held for it and a compile of
  it works. On a released manager whose strategy asks the provider for its
  transition text, as the autobiographical strategy does,
  `resetHeadWindow()` with no text rejects with an error that is an instance
  of context-manager's `CompressionWithdrawn`. With a store the host owns,
  `stop()` leaves the managers open.
- `cleanup()` is final: `runEphemeralToCompletion` refuses an agent it has
  released, saying so. Before, a run after `cleanup()` ran, with nothing
  said. A host that keeps a context manager after `stop()` with a store the
  framework owns, and does strategy work on it, gets, by our reading of
  context-manager 0.22.1, its "after close()" error, where it met a closed
  store.

- In a round that calls `drafts`, with any action, what the round would hold
  or bounce for lack of a destination is now held as a draft with no notice
  mid-turn (#701). It stays listed by `drafts` and resendable by id, and the
  turn's receipt (in `locus` and `hybrid` mode) or a later turn's catch-up
  notice (in `explicit` mode) names it, but nothing offers it for resend while
  the turn runs. Before, once a turn had an explicit send (a `drafts` resend
  included), such a line was held as a draft and the round's notice offered
  it, so an agent that writes a line beside each call resent its own narration
  round after round within one turn. In a turn a send has silenced, the
  round's plain speech aimed where a send may have posted stays in the agent's
  context instead, counted in the receipt as kept private, while what a `>>>`
  envelope addressed there is held with no notice. A round that also makes a
  send of its own, other than a `drafts` resend, holds its prose where that
  send may have posted and offers it as any send's round does. Outside a
  silenced turn, what the round would deliver is still delivered, a `>>`/`>>>`
  target and a sticky target included, and a refused target, a malformed
  envelope or a failed delivery still bounces. This applies in native tool
  mode, to a `drafts` call made from a script too. In `explicit` mode, an
  envelope beside a script whose code mentions `drafts` now waits for the
  script, since its call would change the round's routing. XML tool mode,
  which routes a turn's prose once at its end with no notice mid-turn, is
  unchanged: there an `explicit`-mode line beside a `drafts` call still
  bounces, and the bounce-wake cap ends a cycle of `drafts` resends after two
  wakes, counted from the last turn with a cause of its own or the last
  delivered envelope.
- Only the framework's own `drafts` tool makes a drafts round: a module's or
  server's tool whose bare name is `drafts`, such as `mail--drafts`, makes
  none, and a resend through it no longer silences its round's prose.

- `agent_settings` applies an update's or a reset's settings in one order:
  the core settings first, then each extension's. So a refusal from the core
  (a value out of range, a lower budget the strategy can't reach gradually,
  the budget preflight, the strategy's own refusal) leaves every extension's
  setting in the call as it was. Before, both applied the extensions'
  settings first, so a call refused for its `tail_tokens` had already
  changed its inline cap.
- An `agent_settings` update, reset or cancel refusal ends by saying what the
  call changed. One made before the settings are read, such as for a name
  the call can't take or a core value of the wrong type, ends "Nothing in
  this call was changed." One made after names each setting that reads
  differently than before the call ("Changed before the refusal: …; no other
  setting reads differently."), or says "No setting reads differently after
  this call.", or, if the settings can't be read back, says that whether
  anything changed couldn't be.
- `agent_settings` reads `immediate`, `tool_result_guard` and
  `closed_channel_note` given as the text `"true"` or `"false"` as that
  boolean. Before, `immediate: "false"` applied a lower budget at once where
  the call asked for it paced, and the other two refused the text. Their
  refusals now read `… must be true or false, not <value>`, where the
  guard's and the note's read `… must be a boolean`.

- A `chat:system` notice (MCPL RFC-001 rev 3: someone joining, a pin, the
  weather changing in a world) no longer decides where an agent's plain
  speech goes. Like a reaction or an edit, it doesn't become the default
  publish channel or the reply anchor, doesn't re-pin a turn mid-turn (not
  even in a channel the turn engaged), and doesn't clear a round's
  explicit-send suppression. A wake it causes names no channel for its turn,
  so a turn it wakes alone resolves its locus as a heartbeat does, and a wake
  to read it is done once read, as an ambient one is. This holds when the
  notice is also addressed by its place (a pin in a DM): kind and addressing
  are separate facets. Before, a world's forecast line tagged `chat:ambient`
  became the most recent inbound message, and a heartbeat turn spoke a reply
  meant for a DM aloud in the world.

- When a response ends at the output limit (`max_tokens`) with calls in its last round, none of those calls runs, and the round is now stored as the agent's reply, each call answered by a refused result that says the output limit stopped it and to send less in one response. Before, with native tools the round wasn't stored at all, so the agent couldn't read what it had said, and a later round's words were lost. The round's words are routed as a round of refused calls is: a cut-off `skip_reply` keeps them private, a `think` under `sameRoundThinkTextPolicy: 'private'` keeps a native round's words private, and any other call leaves them to go out. One `[tool-boundary]` line is logged for each such response.
- In XML tool mode (the `anthropic-xml` formatter), a tool-call block cut off by the output limit is no longer stored or published as raw XML. Each call in it whose name arrived is stored and refused as above. A block cut off before any call was named leaves the words before it and a notice to the agent that nothing ran. The stale opener no longer bends the next answer, which had been stored and published as `<function_calls>` followed by the answer.

- An ephemeral run whose turn's continuation the inference policy drops now
  rejects at once, with a plain `Error` naming the drop, as the turn ends.
  It used to wait for the idle watchdog, whose rejection said the run had
  stalled.

- The `[inference-failed]` note after a turn with tool rounds no longer says that the model call "produced no response, so nothing was sent". It says that the turn failed (with the cause, when one is known); when any round reached the context with its results, "Its earlier rounds ran, and their tool calls ran as their results show."; and when any of the turn's streams ended while a round's tool calls were running, "A round's tool calls were started, but its stream ended before their results came back, so that round isn't in your context; those calls may have taken effect."
- A caller's stop that reaches a silent turn's error-policy retry before it sends its request no longer says the turn "was stopped before it sent anything" when the turn's first stream had already run rounds. It says the turn was stopped before it finished, with the started-calls sentence when that stream ended while a round's tool calls were running.

- `history--search`'s hint, when a search stops at `maxScan` with no match, now says that nothing matched among the messages scanned and that this isn't a negative result for the range. With a `channelId`, it also says how many of the range's messages weren't searched. It used to say only that the oldest or newest N messages of the range were scanned, so a script reading `matches` alone could take a partial scan's empty result for the range's. Its advice on narrowing no longer names `author` after a stop at `maxScan`, since that filter applies only to the messages already scanned, nor `channelId` or `author` when the call gave it.
- `history--extract` with `author` or `excludeAuthor`, when its scan stops at `maxScan` with no message returned, now says in its hint that returning none isn't a negative result for the window.

- A cancel the framework makes whose stream's `cancel()` throws no longer
  leaves the framework's mark on that stream, which said a cancel had
  happened. At a context-budget restart, a tool result that ends the turn
  and a restart while the framework stops, the stream goes on, waiting for
  the round's results, which the boundary doesn't send: the turn keeps its
  token until the stream ends, a log line and an operator alert
  (`stream-cancel-failed`) say so, and a later `abortInference()` whose
  cancel goes through ends the turn as the caller's stop, with one
  `inference:aborted` carrying its reason. A restart whose cancel throws queues no continuation and reports
  no restart. After a restart's or an end of turn's failed cancel, that
  abort used to end with no `inference:aborted`, leaving the logical turn
  open, and after a failed restart-while-stopping cancel it was reported as
  `shutdown`. The tool boundary no longer throws into the event loop.
- `quiesce({ abandon: true })` resolves when a turn's stream's cancel
  throws, and goes on to the other agents' turns. It lists that agent in
  `unabandonable`, unless the turn waits at a check ahead, as in the
  tool-result guard's wait, where the abandon ends it instead; such a turn
  is listed only if it hasn't reached that check when the abandon's grace
  runs out. It used to
  reject with the cancel's error. `stop()` still rejects with such an
  error, now with a line naming the agent, and leaves a mark only for a
  cancel that happened, such as an abandon's before it.
- `Agent.cancelStream()` whose stream's `cancel()` throws leaves its record
  of a stop as it was before the call, so the stream's own later end, an
  `error` the provider reports included, isn't read as this stop.
- A turn's start whose compiled stream won't be sent (the framework
  stopping, a caller's stop during the compile, a provider wait recorded
  during it) ends as it does when the stream's cancel works, when that
  cancel throws. The stream was never iterated, so it sent nothing. It used
  to report `inference:failed` with the cancel's error instead.
- A stream that no longer owns its agent (a newer stream took it, or the
  agent was replaced or removed), whose `cancel()` throws, is logged, and
  the loop that drove it ends without rejecting its promise. It used to
  reject that promise, which went unhandled unless a `stop()` was waiting
  for that loop.

- When the tool-result guard withholds a batch, an error result no longer reads
  "The tool has already executed.": a refused call's (`ToolResult.refused`)
  reads "The tool didn't run.", and any other error result's reads "The call
  returned an error, and this notice can't say whether the tool ran.",
  followed, when its original was written to a workspace file, by "Read it
  before calling again." The stub, the retry and the placeholder sent when the
  guard's audit can't be saved all carry the same notice.

- A tool-result guard's retry that a provider hold releases in one batch
  with a wake it held before it now starts alone, as the retry, continuing
  the turn the guard held, and the wake goes back to the queue behind it.
  It used to start as that wake, a fresh turn, which opened a new EventGate
  window where the retry resumes its turn's.

- MCPL RFC-014 tool presence (`toolHints: true`), fixes to how hint changes are applied and told:
  - A `tools/list` is applied whole as its last page is read, so a hint read just after it isn't undone, and a malformed or timed-out list changes nothing. A paged list whose pages straddle a change, or a hint or `toolsets/list` entry naming a tool `tools/list` hasn't listed, is recovered from.
  - Changes are told in the order they were read, each once: a result's change nobody shows with it is told as a notice before any later change, and a new tool's first sentence counts as shown only once text describing it reached the model. A change a caller took and then couldn't show is told when the caller finds that out, after anything told meanwhile. By our reading of the code, a puppet's open, close or look whose result the store refuses has already counted the definitions it rendered.
  - A change that would go as a notice to a server without the `pushEvents` grant is dropped, and `toolsets--look` shows the state.
  - A tool the operator's tool policy refuses never starts a recovery, and a tool listed twice is known by its first listing.
  - A malformed definition no longer makes rendering throw: a description that isn't a string is left out, and a schema or a toolset's `options` nested very deep is cut short, rather than failing a notice or `toolsets--look`.

- MCPL RFC-014 tool presence (`toolHints: true`), fixes to how the toolsets host is wired into the framework:
  - A result's tool change goes with it only where the result reaches an agent: the model's own call, and the operator's puppet, whose call and result are stored in the agent's window. The model's own call counts as reaching it once its result is handed back. If the turn is stopped while the call is out (or, by our reading of the code, the agent is gone), the result is dropped, and the change with it, counted as told and not told again, as in 0.27.0; `toolsets--look` shows the state it left. A script's, a module's or a host's own call leaves it to a notice. A dynamic tool's change that wouldn't fit whole within its result's inline cap, or whose call fails after its result was read, goes as a notice too. A result that is structured content alone shows that content, as its JSON, before the change that goes with it.
  - An open or close whose outcome is unknown is reported as unconfirmed rather than as not done, and names `toolsets--look`, which says when it couldn't ask the server. A selector that is present but isn't a name is refused (null reads as left out), and a refusal for a name the server doesn't have says what it has.
  - Removing a server, or restarting it under another id or with `toolHints` off, leaves no toolset state behind. A stop or a disconnect while a `toolHints` server is still connecting ends the connect.
  - The capability mask no longer reports `toolHints`, `toolsets` and `surface` as masked: `toolHints: false` turns hints off. Operator tool-name patterns naming a dynamic tool count as matched.
  - Server-chosen values in the toolset host's log lines, and in the trace of a `toolsets--act` that can't be resolved, are redacted with the servers' configuration. A request kept for a late answer no longer holds a call's arguments.
  - A programmatic `toolsets--act` that's refused is traced as `tool:failed`, as the model's own refused act already was. A tool change that can't be told for want of an agent is logged, as one without the `pushEvents` grant already was.

- On a disk that folds names, a path that named a nested mount's directory, or a directory above it, in a spelling other than the ones read at start was the outer mount's own. A draft could be written there, a file read and listed, and a materialize wrote into the nested mount's directory, a read-only mount's included. That held with nothing there on disk, with the directory or its parent made or renamed after start, with history spelling a parent otherwise, with a name typed with `ß` where the directory is `ss` on a disk that folds them together, with a soft hyphen or a zero-width joiner inside the name on a disk that passes over them, as Linux's casefold does, and through a link whose target spells the directory otherwise. Every check, `resolveAbsolutePath`'s included, now compares a path with a nested mount's directory as any disk may compare names, level by level: in either Unicode normalization form and in any case, as fully as a disk that folds names may compare them, with default-ignorable code points passed over, at every level, reading nothing from the disk to do so. Such a path is refused, naming the nested mount and the path to use there, and walks and pushes pass over it. Where the path matches the directory only that loosely, not exactly, the refusal says the path may lie in the nested mount, shows both spellings, and gives a step for each thing the caller may have meant. Where it lies beneath a nested mount that start placed only by such a match of the real roots, however exactly it matches there, the refusal says it may lie there, names the directory as the path spells it, and asks for the configuration to be checked. Where a followed link leads outside the mount, to a place only such a match takes for the nested mount's directory, it says only that it can't tell.
- On such a disk, a mount configured through a link, or in a spelling, other than disk's wasn't always found nested, and the outer mount held its files as its own. Start now places each mount by the same comparison. Through a link into a nested mount's directory, the place beneath it is judged by that mount's include, and by the include of each other nested mount whose directory may hold it, out to the first that surely holds it, and named, as disk spells it, where it was judged in the link's spelling.
- The cases that fall outside the nested-mount guarantee, which 0.24.0's entry for `include` listed as four, are now these: on a disk whose folding goes past the comparison's, a name the comparison keeps apart can reach the directory; a second path to the directory that isn't a link, such as a bind mount, isn't found to lead there, though a walk passes over it; a nested mount whose root moves while running, as `acceptRoot` takes, stays placed where it was until the next start, but for the calls of a direct mount whose root has moved and on or beneath whose path it's configured, which place it where it lies; and on a direct mount, a root repointed between a read's parse and its open, or a write's parse and its staging, can have the read serve a path in a mount nested in it by its directories alone, or the write land there.

- `nudgeAgent()` reports an agent whose turn waits for its continuation (a
  context-budget restart's, or the tool-result guard's retry) as
  `idle+turn-alive`, in its result, its log line and the operator-action
  record, as it does an agent holding a turn token. It used to report
  `idle`, which its doc says means the turn starts on the next scheduler
  pass, though that pass started none (#754).

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
    left in place and isn't counted, unless it's the stored result of a
    call the refused request carried, stored right after that call, which
    goes with it as one exchange.
  - **The shed after inference exhaustion** passes over rows the sanitizer
    leaves empty in the same way.

- `save_recent_image`'s description no longer says saved files are visible at
  the `/files/` endpoint. That endpoint is the host's, and where it reads disk
  it doesn't show a save that waits for a materialize.

- `sourceBodyDigest`, and the `storedBodyDigest` it stamps at ingestion on both MCPL lanes, now take each block's stored form from context-manager's own `blockAsStored` (context-manager 0.22.0) instead of a copy of its transform (#252). MCPL's content conversion produces only text, image and audio blocks, and no body an MCPL lane stamps changes digest. Every body in the real-store test, those shapes among them, hashes as it did under the copy except the first two shapes below, and the test pins each one's digest. A direct caller of `sourceBodyDigest` with one of these three shapes gets a different digest than from 0.27.0:
  - **a `tool_use` whose input isn't an object.** The store hands it back with `input: {}` and the value kept in `unparseableInput`. 0.27.0 hashed it as given, so its stored copy didn't match; now the digest is of the mended block, and it does, unless other blocks of the message share its raw replay form (below).
  - **media whose data is a byte array.** The store keeps it as base64. 0.27.0 hashed the array as given, so its stored copy didn't match; now the digest is of the base64, and it does.
  - **a media block the store refuses** (no media type, and for an image no recognized signature). 0.27.0 re-encoded its data and dropped its other fields before hashing; now it's digested as given, since no stored copy of it can exist.
- Digests already stamped are never recomputed. A stored copy of a body of the first two kinds, stamped under 0.24.0 or later through the copied transform, keeps that digest and doesn't match it. So for such a copy, a mismatch doesn't mean it was changed after it arrived, as the 0.24.0 entry reads one.
- A digest is now a digest under the context-manager release that computed it: a release that changes what the store keeps, such as its set of image signatures, changes the digest of a body it touches.
- The digest takes each block's stored form on its own. When the store mends a `tool_use`, it also releases a raw replay form (`rawXml`, `rawItem`) that other blocks in the message share, so a body like that doesn't hash as its stored copy does.
- When `blockAsStored` throws anything but a refusal (a `MalformedContentError`), the block is still digested as given, and each digest taken over it logs a `[stored-digest-as-given]` line naming the error. Ingestion takes two digests of a body, so one such block logs two lines.

- A message stored as it arrived, rather than held for a turn that was
  running, no longer starts a turn of its own when a request read and
  answered it while its wake waited, as behind a context-budget restart or
  a tool-result guard's retry held by a provider. Its wake is now judged as
  the wake of a message heard mid-turn is: it's dropped once a request that
  carried the message has been answered and, for a wake that carries a
  channel, unless its server marked the message ambient, the agent has
  since published into that channel. It's also dropped once the message is
  no longer on its store's current branch. A wake whose message reached the
  agent only in a request that failed, or whose channel the agent hasn't
  spoken in since it read the message, still starts its turn. It covers the
  kinds of wake the rule for a message heard mid-turn covers: channel
  messages other than a conversation fork's, push events, a module event's
  one message, background-script wakes and the gate's self-wake notices.
  Only the agent the message was stored for has its wake judged this way:
  another resident's wake for a message in the shared slot still starts its
  turn. A wake the event gate starts when a debounce fires carries no mark,
  so it too still starts its turn (#814).

- A subconscious whose `subconscious.model` names a model id other than the
  resident's (compared exactly) no longer inherits the resident's
  `physicalWindowTokens` or `thinkingBinding`, which describe the resident's
  model: a resident window above its own model's let its streams walk past
  that model's window (#92). Such a subconscious now runs with no
  physical-window projection, so its `maxStreamTokens` restart is its only
  window guard, and its requests carry no drop control unless its inherited
  `providerParams` ask for one. It still inherits every other inference
  setting, the thinking config, `maxTokens`, the budgets and `promptCaching`
  among them, so its model's window must hold those budgets. On the
  resident's model, named or by default, it inherits both fields too.

- A failure membrane marks retryable (a `MembraneError` with
  `retryable: true`) that a turn stream of another make throws from its
  iterator before its terminal event is held, retried and logged as the same
  failure sent as an `error` event is, as membrane's own streams send it
  (agent-framework#734). In 0.27.0 such a throw never asked the error policy.
  A turn that owns the provider gate, as a resident's does, was held when the
  host's provider hold claimed the failure, when it was an
  organization-acceleration 429, or when it stated a wait still to come, with
  its inference-log row prefixed `Provider acceleration cooldown:`; a
  conversation agent's was held when it stated such a wait, prefixed
  `Provider wait:`. Any other, a 529 stating no wait among them, ended the
  turn after one send (`inference:failed`, then `inference:exhausted`). Its
  row is now the provider's words, as the event's is. The stream that threw
  is cancelled before the retry.

- Once a turn stream's terminal event (`complete`, `error` or `aborted`) has
  decided the turn, nothing after it decides it again (#734). A stream that
  threw from its iterator after that event, or sent another event, had its
  turn acted on a second time: a later failure ended an answered turn as
  failed, with an `[inference-failed]` line in the agent's context after its
  own answer and a failed inference-log row, or, as an acceleration 429,
  installed a hold whose retry would send the answered turn again; and a
  later event ran its case for a turn already decided. Such an event or
  throw now ends the stream, with a line on the console, and decides
  nothing. Membrane's own streams send their terminal event last; only a
  stream of another make sends or throws anything after it.

- A workspace file whose stored contents the store has lost, or can't read, is now read from disk's copy when that copy has exactly those bytes (the same size and SHA-256), by `read`, `edit`, `edit_many`, `grep`, `read_image` and `readBinary`. The contents are stored again, and whoever runs the host gets an ops alert: `workspace-contents-restored`, `workspace-contents-unstored` when the store doesn't keep them, or `workspace-contents-lost` when no copy with their hash can be read. Before, `read`, `edit`, `edit_many` and `readBinary` answered "Blob not found for:", `grep` left the file unsearched, and a blob it couldn't read failed the whole `grep`. Where nothing can restore them, the answer says what the store and disk hold and what the agent can do instead.
- `read_image` serving disk's copy of a file whose workspace copy is lost now says so in its text.
- `materialize` lists a workspace copy the store can't read as skipped, saying so, rather than failing the whole call, and a branch intent whose stored record can't be read leaves its path unverified with that reason rather than failing the listing.

## 0.27.0 — 2026-10-26

### Breaking

- **Hosts and residents with gate policies that name a channel:** a
  `match.channel` in the registered form, such as
  `discord:<guild>:<channel>` or `discord:<guild>:*`, now meets every event
  in that channel, not only the messages that arrive while it's open
  (#702).

  **Check your config for:**
  - any `match.channel` in the registered form (for Discord, starting
    `discord:`) without `scope: ["mcpl:channel-incoming"]`;
  - any `keyBy: "channelId"`, whatever its policy matches.

  **What such a policy now does:**
  - **Quieter:** a `defer` channel policy stops the channel's push events
    waking the resident, including an @-mention in that channel while it's
    closed, which a later addressed rule used to take. A `passive_sample`
    one wakes on its every-Nth only (with `passthrough`, the others go on to
    later rules). A `debounce` one batches and delays them, and a
    `rate_limit` one can deny them.
  - **Louder:** an `always` channel policy ahead of a `defer` rule wakes on
    every reaction, edit and voice report in that channel.
  - **A later policy can lose events:** a later policy, such as one naming
    the channel's raw id, no longer receives the pushes an earlier
    registered-form policy now matches, though no pattern matches fewer
    events than before. Neither the shadow lint, which compares patterns as
    written, nor `wake_add_rule`'s before/after table, whose probes name no
    channel, shows this.
  - **Counting:** every `rate_limit` and `passive_sample` with `keyBy:
    "channelId"` counts a channel's push events with its messages, under its
    registered id. A push was counted under its raw id, or in the shared
    bucket when it carried none, as a voice report doesn't. So a channel's
    messages and pushes now share one bucket or counter, and voice reports
    in different channels no longer share one.
  - **A host that builds its own `EventGate` with `resolveRouteChannel`:**
    its resolver, which routed batched wakes, now also decides which channel
    policies a push meets and how `keyBy: "channelId"` counts it.
    `EventGate`'s default resolver gives no push a registered id, so with it
    a push matches and counts by its own id, as before.

  **Migration:** to keep a registered-form channel policy to the channel's
  messages, closed channels' addressed ones included, add `tagsAny:
  ["chat:ambient", "chat:addressed"]` to it. Those are Discord's message
  tags, and its reactions, edits, deletes, voice reports and catch-ups carry
  neither; another adapter's markers may carry `chat:addressed`. To keep it
  to exactly what it caught before, add `scope: ["mcpl:channel-incoming"]`,
  since a registered-form pattern matched no push before. Neither changes
  how `keyBy: "channelId"` now counts. A pattern written as `*<raw id>`,
  which matched both paths before, matches as it did, and now also matches a
  push that names its channel only by `mcplChannelId`, such as a voice
  report.

  **Unchanged:** which policy an event meets stays as it was in a config
  whose rules for the push events it receives (addressed messages,
  reactions, voice reports and the rest) come before its channel policies
  and aren't `passthrough`, and for a channel policy scoped to
  `mcpl:channel-incoming`. Counting with `keyBy: "channelId"` changes even
  there, as above.

  **Why:** a message in an open channel arrives through `channels/incoming`
  with the registered id, but every other event arrives as a push: an
  addressed message in a closed channel, a message in a channel the adapter
  subscribes to without opening, and in any channel a reaction, an edit, a
  delete, a voice report or a missed-message catch-up. A push's own channel
  id is the adapter's raw one (a bare Discord snowflake), or none, as on a
  voice report, so a registered-form pattern missed all of those, and each
  fell through to a later policy. The pattern is now tested against the
  event's own id and, when that misses, against the registered id the
  framework resolves for the push: its origin's `mcplChannelId`, or, for a
  Discord origin without one, its guild and channel (`discord:dm:<channel>`
  when it names no guild, as a DM's doesn't). A push whose origin names its
  channel neither way, from another adapter, still matches by its raw id
  alone.

- **Hosts and custom `errorPolicy` authors:** the framework is now the one
  retry layer for its turns. A turn passes `retry: false` to membrane, so
  membrane sends a failed round once and the error reaches the framework,
  where since membrane 0.7 membrane's own schedules (up to ten minutes at a
  529) ran inside each of the framework's attempts, out of its sight. Each
  retry is now a fresh compile, its wait is traced, and a stop cancels it.
  The default error policy decides on membrane's schedules
  (`@animalabs/membrane/retry`; `MEMBRANE_RETRY_SETTINGS` unless a host
  passes `new DefaultErrorPolicy(settings)` as `errorPolicy`), where it
  retried any retryable failure three times, 1, 2 then 4 s apart:
  - a 529, or an overloaded error mid-stream, gets the overloaded schedule:
    seven tries, jittered waits from 10 s doubling to five minutes;
  - a 429 gets at least five tries on the base schedule;
  - any other retryable failure, a stream deadline included (membrane itself
    leaves a deadline to its caller), gets three tries, 1 s then 2 s, and so
    does an error that isn't a MembraneError;
  - a provider's stated wait is waited when it is longer than the backoff, up
    to ten minutes (the framework's provider-hold cap), as before;
  - a failure that isn't retryable ends at once, as before.
  A custom `ErrorPolicy` now sees failures membrane used to retry first (a
  5xx, a 529, a dropped connection, a 429), so it decides those itself.
  **Migration:** decide with membrane's own helpers (`classifyFailure`,
  `retryDecision`), as the default policy does, or wrap the now exported
  `DefaultErrorPolicy`. **Unchanged:** the provider holds before the policy
  (a resident's stated waits and acceleration 429s), refusal re-issues
  (`refusalRetries`), a direct caller of `Agent.startStream` (it keeps
  membrane's retries; `ActivationRequestOptions.membraneRetries: false` is
  what the framework passes), and calls that aren't turns (the MCPL
  inference router, compression and other host calls keep membrane's
  retries).

- **Residents and hosts:** an agent's own `channel_close` or `channel_decline` now holds against
  its own speech there. A send tool's call (`send_message`, `reply_message`, `send_dm`,
  `send_file`, `send_files`), plain speech, or a draft's resend into a channel the agent closed or
  declined publishes there and leaves the channel closed. Before, it opened the channel, recorded
  that open over the agent's close, and announced "[channels] Now open: … your own message into the
  closed channel opened it." That holds where the agent's close failed at the server and left the
  channel's transport open too: the words go out there, and the close stays the decision on record,
  where speech used to reopen the channel. Words that wait on a channel's lifecycle work, or on an
  open they started, go into the channel as it stands once the agent closes or declines it
  meanwhile, or a module closes it, where they were refused with "a decision to close the channel
  came before these words went out". They're still refused where the channel's address kept
  changing until the tries ran out, and a channel whose last open the server answered for another
  channel takes no words as it stands until an open of it is answered for this channel, since a
  publish by its id may not reach it. Speech into any other closed channel, one nobody decided
  about (such as a DM that woke the agent) or one a machine closed, opens it as before, with that
  notice, and a close a machine decides while words wait still refuses them.
  - **Who needs to act:** an agent that closed a channel and wants its ongoing traffic again opens
    it with `channel_open`; speaking there no longer does. Messages that address the agent still
    arrive while a channel is closed.
  - **What residents read:** where an agent's words land in a channel it closed or declined, the
    send tool's answer, for routed speech the turn's `[delivered]` line, or in `explicit` routing
    mode, which has no such line, a line of its own at the turn's end, says that the channel stays
    closed, and, as each holds for the agent reading it, that messages addressing it still reach
    it, that `channel_open` opens it, and how to turn the note off. The first is left out for an
    agent whose window isn't where those messages land, such as an ephemeral run's; `channel_open`
    where the agent's `allowedTools` leave it out, or on a server that's up but whose grant lacks
    `channels.lifecycle`, where no channel can open; and the last where `allowedTools` leave
    `agent_settings` out. In `explicit` mode, speech still being delivered when a tool ends the
    turn gets the line once it's delivered, and a line that comes while another turn is under way
    waits for that turn's next tool call, where that turn is shown it, or for its end. The agent
    turns the note off for good with `agent_settings`' new `closed_channel_note`, which is on by
    default. A conversation agent gets none: `channel_open` is refused to it, and its settings end
    with its conversation. In a channel the agent's words leave closed, one it closed or declined,
    one a module closed, or a closed one on a server that's up without `channels.lifecycle`, the
    `sleep` tool's default announcement says "I'll still see messages addressed to me, but won't
    respond until I wake." A send tool's call into a channel the agent tuned out keeps the
    tune-out, as it has since 0.23.0, and its answer now says so: "… stays tuned out: your words
    there don't end the tune-out, so its traffic still goes to your subconscious until the tune-out
    ends. Call tune_out with channelId … and mode "cancel" for it to resume normal attention;
    cancelling delivers the diverted backlog." The last sentence is `tune_out`'s own refusals' one,
    naming the channel as they do, for an agent whose `allowedTools` hold `tune_out`. The same
    setting turns that line off. A send a `code_execution` script makes keeps the server's receipt
    alone, since the script parses it, and the agent gets the note or the tune-out line in its
    window instead, as a notice.
  - **What the invitation says:** the closed-channel invitation's first option now says what
    replying does there. In a channel the agent closed or declined itself, or a module closed, a
    reply no longer opens the channel, and the option says so: "1. Reply — … it will be delivered
    there, and the channel stays closed." Before, it said "… which opens the channel" there too. It
    says the same on a server whose grant lacks `channels.lifecycle`, where nothing opens. In any
    other closed channel, where a reply still opens the channel, it adds how to reply without
    opening it: "To reply without opening it, decline it first (option 3): a channel you've
    declined stays closed when you speak there." It leaves that out in a tuned-out channel, which
    `channel_decline` refuses. What else reaches the agent from a channel left closed is its
    server's to say (#406): on discord-mcpl, the channel's later messages that don't address the
    agent don't arrive as they're posted, and anima-research/discord-mcpl#97 has discord-mcpl say
    so on its push.
  - **What residents notice,** by our reading of discord-mcpl's and zulip_mcp's code: on
    discord-mcpl, opening a channel also turns on its reaction forwarding, and closing it turns
    that off. A reply in a guild channel the agent closed used to reopen it, and so turn its
    reactions on. Now reactions to that reply arrive only where the agent opens the channel or
    turns them on with `set_reaction_visibility`. DMs are unaffected: discord-mcpl requests no DM
    reaction events. discord-mcpl's `channels/open` also lifts a mute set with `mute_channel`, so a
    reply that opens a muted channel nobody decided about, or one a machine closed, unmutes it, as
    before; a channel the agent closed keeps its mute. On zulip_mcp, an answer's topic comes from
    the last message delivered as `channels/incoming`, and a closed stream's mentions are pushed
    instead, so in a stream the agent closed, every answer goes to the topic of the stream's last
    message from before the close, where a reply used to reopen the stream.
  - **What hosts notice,** by our reading of discord-mcpl's and connectome-host's code: on
    discord-mcpl, a channel the agent closed keeps delivering the messages that address the agent
    as push events, as any closed channel's are, where a reply used to reopen it and switch them to
    `channels/incoming`. Host code that acts on `channels/incoming`, such as connectome-host's
    outage reply, doesn't see them there. Nor does a turn with no trigger, such as a heartbeat,
    come to speak there: where it speaks moves only with `channels/incoming` messages.
- **Hosts with modules that close channels:** a module's `channel_close` through its own tool call
  (`ctx.callTool`) without a machine source is now recorded with the source `module-tool`, where it
  was `agent-tool`. Speech leaves such a channel closed, as it does one the agent closed, but gives
  no note, since the module owns the way back. In connectome-host that's the `mentions` channel
  mode: a reply to a mention in a channel in that mode stays a reply, and the invitation there says
  the channel stays closed. Policy doesn't lift such a close, and a machine's close doesn't replace
  it. Of the agent's close and a module's, the later one is the one on record. A module's close is
  never refused as a machine's close of an explicit open; only one naming a machine source is.
  - **Who needs to act:** a module's close made before this change was recorded as `agent-tool`,
    which can't be told apart from the agent's own, so after the upgrade such a channel reads as
    one the agent closed, and the agent's words there carry the note. Setting the channel's mode
    again (connectome-host's `channel_mode` with `mentions`) records the close as the module's.
- **Direct `ChannelRegistry` consumers:** `openIfClosedForSend()` answers a new `status`,
  `stays-closed`, for a channel a send leaves closed without trying to open it: one the agent
  closed or declined, one a module closed, or a closed one on a server that's up but whose grant
  lacks `channels.lifecycle`, where it answered `open-failed` or opened the channel. For an open
  channel on such a server that isn't decided open, it answers `already-open` without trying an
  open, where it answered `open-failed`. `speechOpens(channel)` says whether the agent's words
  there open the channel, and `speechLeavesClosed(channel)` whether they go into it and leave it
  closed. `closedByAgent(channel)`, `lifecycleWithheld(serverId)`, `tuneOutEnd(channel)` and
  `resolveSendTarget(channelId, serverId?)`, which names the one channel a send went to from a
  composite or raw id, and opens nothing, are new too.
- **Prompt cache:** `channel_close`'s description and `agent_settings`' input schema change, so the
  first request after the upgrade that carries those tools misses the cache from its tool block on.

- **Scripts, hosts and modules that read the workspace's `read`, `grep`,
  `edit` or `edit_many` results:** each now answers as the text the model
  reads, with its fields beside it in `structured`. The model read each as
  one line of JSON, a page's lines escaped inside it. It now reads a header
  of the result's fields, one `key: value` to a line (`path: …`,
  `totalLines: …`, `nextOffsetChars: null`), then labelled sections: a
  page's `--- content ---`, grep's matches by file and version (`N:` for a
  match, `N-` for a line of its context, as grep writes them), what grep
  skipped, and a receipt's `--- files ---` and `--- changed ---`. A value
  outside a page's content and a receipt's changed lines that holds a line
  break (LF, CR, VT, FF, NEL, U+2028 or U+2029) or starts with `"`, such as
  a path or a line grep matched, is written as a JSON string, so a value
  shown as it is never starts with `"`. A control character in a file
  reaches the model as itself, where JSON wrote an escape such as `\u001b`.

  **Who needs to act:**
  - a `code_execution` script that parses one of these results' text as
    JSON (`JSON.parse(result.content[0].text)`): read
    `result.structuredContent`, which holds the fields the JSON held;
  - a host or module that reads these results' fields from `result.data`,
    through `executeToolCall` or `ctx.callTool`: read `result.structured`.
    connectome-host reads either since 0.11.0
    (anima-research/connectome-host#324), and needs that version or later:
    before it, its file viewers show such a file as empty.

  **What a page holds:** a page is held to the call's result limit as its
  text measures it, where it was measured as JSON, and so is a receipt.
  - A model's page holds more of a file whose lines JSON escapes: at the
    default 24,000 characters, a page of this repository's
    `src/modules/workspace/index.ts` now ends at line 475, where it ended at
    line 454. A spilled result's notice sizes the read-back page it suggests
    the same way, so below a cap of about 12,300 characters it suggests a
    longer one than before.
  - A script's page is never shorter than before, since a page's text is
    shorter than its JSON, unless the text quotes its path or a note. A script's answer carries the result's fields, a
    page's content among them, beside the text, and the limit counts the
    text alone. A script's limit counts each character at the six bytes it
    takes at most in the answer, and only a control character takes more
    than three, so the two together can pass what the script takes only on
    a page of more than half that limit (about 3.7 million characters at
    the default 128 MiB of script memory) that holds control characters.
    Such a page answers `ResultTooLarge`, which cuts nothing, and the script
    reads a smaller page.

  **Unchanged:** the tools' descriptions and inputs; the words of their
  notes; their errors, which were text already; the results of `write`,
  `delete`, `ls`, `glob`, `status`, `materialize`, `sync` and the other
  workspace tools, whose fields stay in `data`; and a page for a call made
  in process without a result limit, which holds to its line limit alone.

- **Hosts:** agent-framework now requires `@animalabs/context-manager`
  ^0.22.0 (was ^0.20.0). A host whose own context-manager range is still
  below it gets two copies, and a `ContextManager` built from its own copy
  isn't the one agent-framework's types take: connectome-host's `main`,
  with ^0.20.1, fails to typecheck where the two meet, installed with npm
  or bun. context-manager 0.22.0's own breaking change reaches every host
  too: a `maxLiveImages`, `maxLiveImageBytes` or `maxCompressionImageBytes`
  of 0, documented as no limit, now means up to `imageCeiling` (500 images
  by default) or `imageByteCeiling` (24 MiB), and so does a value above its
  ceiling (context-manager's 0.22.0 notes). **Migration:** move the host's
  own context-manager range to ^0.22.0 with this release; with it,
  connectome-host's `main` installs one copy and typechecks.

- **Code that calls `ChannelRegistry` or `ConversationRouter` directly:** a
  channel the registry acts on is a `ChannelRef`, `{ serverId, channelId }`
  (exported as a type), where it was a bare channel id, since two MCPL
  servers can register the same id.
  - `routeSpeech` and `deliverSpeech` take the locus as a `ChannelRef` (or
    `null`), and `resolveLocus` and `getDefaultPublishChannel` return one.
    `getDescriptor`, `isChannelOpen`, `inboundOnlyServer` and
    `proseTargetFor` take one. `getChannelServerId` is removed: a ref names
    its server.
  - `buildChannelContext(agentName, serverId)` builds the channel context one
    server is told, and `incomingFor(agentName)` gives the message the agent
    is replying to, with its channel.
  - `ChannelRegistryOptions.homeChannelResolver` and `activeChannelResolver`
    return a `ChannelRef`.
  - `sendOutgoingChunk` and `sendOutgoingComplete` take only the
    destination the publish went to. A bare channel id, which they resolved
    again at each call and dropped where two servers register it, is no
    longer taken.
  - `ConversationRouter`'s `bind`, `touch`, `unbind` and `getBinding` take a
    `ChannelRef`, `channelForAgent` returns one, and a `ConversationBinding`
    carries `serverId`.
  - **Migration:** pass `{ serverId, channelId }`. An inbound event, a
    publish outcome's `destination` and `channel_list` each carry the server.
    `resolveProseTarget`'s answer, `openIfClosedForSend`'s, `channel_open`'s
    result data, a gate wake's `WakeProvenance` (as `routeServerId`) and
    `onRouteFailure`'s info now carry it too, and `InferenceRequest` carries
    it as `channelServerId`, beside `channelId`. A stream's chunk and
    `complete` take the publish outcome's `destination`. For a name given as a
    string, `channelsNamed(name)` gives the channels it means, by its id or
    its `serverId:channelId` form, and `nameShown(ref)` the name an agent is
    shown for a channel.
  - **Unchanged:** `startTyping`, `stopTyping` and `publishForAgent` still
    accept a bare id, as connectome-host's activity and notices modules pass
    one, and also take a ref or a `serverId:channelId` name. Where two
    servers register the id, what a bare id does changes, as Fixed says:
    typing shows in each server's channel, and `publishForAgent` refuses it.
    `InferenceRequest.channelId` stays. No tool's description or schema
    changes.

### Added

- **Hosts:** `AgentConfig.autoContinue` (default off): a turn the model ends
  itself, with prose or with nothing, is followed by another turn straight
  away, until the agent calls `skip_reply` (or another tool that ends the
  turn), ends on a `>>skip_reply` / `>>>skip_reply` envelope, or reaches
  `maxConsecutive` continuations in a row (default 3, 1 to 20). The count
  starts again on any wake with a cause of its own (a silent heartbeat tick
  isn't one). As the next turn starts it reads a short `[continue]` row
  naming the agent, saying another turn starts, how to stop and that
  unmarked words are sent as usual (and, on the last continuation, that it
  waits for the next event after it); the row is written only when the
  continuation is that turn's whole cause, never for a wake that doesn't run.
  The next turn keeps the turn's locus unless a batched message names
  another channel. Its wake has reason `auto-continue`. Not continued:
  refusals, `max_tokens` cut-offs, the stall guard's ends, silent heartbeat
  ticks, a turn whose closing prose bounced, ephemeral runs, conversation forks, an
  agent offered no way to stop, and a quiesce (which drops a queued
  continuation); a ` !` continuation runs instead. Each continuation is a
  full inference: an agent that answers and ends its turn gets at least one
  more per answer. A malformed setting is refused when the agent is built,
  naming the value's kind, never the value. New exported types
  `AutoContinueConfig` and `AutoContinueRun` (`InferenceRequest.autoContinueRun`).
  See docs/auto-continue.md.

- `WakeProvenance.line` (optional) carries a batched wake's `[Gate: …]` line
  when the gate hands it to the wake rather than writing it (`WakeLine`, now
  exported: its event's entry, its policies, the channel it names and when
  the event arrived; `wakeLineText` renders it as of a time), and
  `InferenceRequest.wakeLines` carries it on the wake's request for the
  turn's start to write or leave out. A host that builds its
  own `EventGate` with `isNewestEntry` and handles `requestInference` itself
  receives the line there instead of in the window.

- MCPL RFC-014 (tool presence, toolsets and surfaces), host side, opt-in per server with `toolHints: true` (default false; off, nothing changes). The server's dynamic tools leave the tool list and are announced in the conversation as they become visible and invisible; the new `toolsets` module's `toolsets--open`, `toolsets--act`, `toolsets--look` and `toolsets--close` open toolsets and instances, call dynamic tools, and close them. `toolsets--act` goes down the same path as a direct call of the server's tool (allowedTools, tool policy, state exchange, result reading, RFC-007 observers, who see that tool), adding only `_meta["mcpl/instance"]`; it checks arguments against the instance's current definition first, with a bounded check that never runs a server's `pattern`. Hint changes apply as each message is read, in rev order, late results and refused pushes included; a skipped rev recovers through `tools/list` then `toolsets/list`, which is also read after every (re)connect. Changes are told after a call's result, after the push that explains them, or as `mcpl-toolsets` notices (a call whose result doesn't go to the agent included). When an open toolset's announcement leaves an agent's context, a reminder is stored at its next start. New: `Agent.onCompiledToSend`, the hook that tells which announcements a request carries, and `ToolLifecycleEmitter.retarget`, which describes an act call as the tool it calls. See the README's "Tool presence and toolsets".

- A module's `queryMessages` and `addMessage` take `{ forAgent }`, naming
  the agent whose window they read or write: a conversation fork's or a
  running sub-agent's own store, or, for an ordinary resident, the
  residents' shared slot. For the subconscious, it's its own store, not
  the residents' slot its compile merges in. Left out, they read and write
  the delivery agent's window, as before: the primary's, or the first
  agent's when none is primary. A name that isn't a registered agent, or
  the empty name, throws, naming the registered ones, so a typo isn't read
  as an empty window and a write for a launcher that has gone is heard. A
  module's `gatherContext(agentName)` can then read the window of the
  agent it gathers for, as retrieval does to key its block to that agent's
  own opening message, and a host can deliver an async subagent's result
  to the window of the fork or sub-agent that launched it, rather than to
  the residents' slot.
  - **A targeted write** is held while its agent's turn is alive, as a
    write for the primary is. For an ephemeral run or a conversation fork,
    whose window nothing reads after it's released, a write it never read
    goes to the primary at its release, as the write itself, through the
    primary's own delivery. It's read as a notice is: once it's below the
    target's consumed watermark, which a compile built to send moves when
    it commits (a row that compile's strategy left out counts as read too),
    and a tool round moves when it injects messages into a stream that
    declares it carries them. So a write that waited for its target's end (a
    run's end, made after its last tool round or any on membrane's XML
    prefill path, or a fork's last turn), one stored while it was idle and
    never sent, one stored at a tool round that ended the turn, and one
    injected into a stream that didn't declare it carries injections go to
    the primary. One still
    queued at the release is also stored in the target's own window, kept
    for investigation, as a queued notice is. A queued one goes as it was
    written; a stored one the store split into shards goes as one text,
    whole. The framework's own writes for a run or a fork are unchanged.
  - **`getMessage`, `editMessage` and `removeMessage`** still read the
    delivery agent's window (the primary's, or the first agent's when none
    is primary), so they don't take an id or handle for a row in a fork's
    or a sub-agent's window: read it with `queryMessages` and the same
    `forAgent`. The residents' shared slot is the primary's window too, for
    a primary that's an ordinary resident, so there they do.
    `metadata.external` with a target throws, since its id map is read in
    the primary's window.

- `PublishRefusalReason` gains `shared-id`: `publishForAgent` refuses a name
  that means more than one registered channel, before anything goes out. A
  ref picks one, as a server-qualified name does where it names one channel
  alone.

- `AgentFramework.getRequestCompileStats(request)` gives the render stats of the dry compile that
  built a request `previewActivation` returned: context-manager's `CompileResult.renderStats`, what
  that compile selected, by kind, without the injections merged in after it. So a host can show
  the makeup of an agent's next request without sending one
  (anima-research/connectome-host#425). It's null for a request that is sent, and when the
  agent's strategy records no stats.

- `thinkingBinding.binds` in an agent's config says the agent's model binds
  its signed thinking to the conversation before it. context-manager 0.22.0
  keeps a record of what each branch sent
  (anima-research/context-manager#155), so that thinking can then be left out
  once its earlier conversation changes, rather than sent and refused or
  dropped. It's off by default.
  - **What compiles are told:** each compile the agent sends, a framework
    turn's, `previewActivation`'s and the direct API's, gets
    `thinkingBinding` (`binds`, `dropBlock`, and the agent's name as
    `participant`) and `identity`, digests of the request's system text,
    tools, model and the rest of what it carries ahead of its messages.
    `previewContextSettings` passes the binding too.
  - **What streams note:** at each tool boundary and at its end, a framework
    stream tells the context manager which stored rows its requests carried
    as stored (`noteRequestSent`), naming the compile it was built from, so
    their thinking is kept at the next compile. The direct API
    (`runInference`) notes nothing, so with `binds` set, each direct-API
    reply's thinking is left out at the compile after it's stored.
  - **No budget restart mid-turn:** with `physicalWindowTokens` set as well,
    `maxStreamTokens` no longer starts a new stream at a tool boundary, since
    the new stream's compile can take the turn's earlier reasoning out of the
    request. The window check still does, whatever the context manager.
  - **An ops alert:** with `dropBlock` set too, where a compile reports where
    the branch's record began (`thinkingRecordedAfter`), a block the provider
    drops that the record doesn't account for raises `thinking-binding-loss`,
    once per agent per incident and again if a call drops more. A reply stored
    before the record began, or a drop for the account's binding (its
    organization or end user), doesn't count. The provider reports drops only
    on a request that carries the drop control.
- `Agent.addAssistantResponse` returns the stored message's id.
  `runInference()`'s doc says that with `binds` set, its compile writes the
  context manager's record, so it's for a time when none of the agent's
  requests is streaming: a stream open meanwhile then has its later notes
  write nothing. `compileContext()` isn't told the binding, and touches no
  record.

- `thinkingBinding.dropBlock` in an agent's config asks the provider to drop
  a signed thinking block whose earlier conversation has changed, as a fold
  changes it, rather than refuse the request. An account that enforces
  thinking-signature binding answers such a request with a 400; with the
  setting, it drops the blocks that no longer match and answers. Where an
  account doesn't enforce it, the provider decides for itself what to do with
  such a block, and the setting has it drop them too. The setting is off by
  default.
  - **What's sent:** `thinking.block_binding.prefix_mismatch_behavior:
    "drop_block"` with the `thinking-binding-controls-2026-08-01` beta, which
    membrane's Anthropic and Bedrock adapters carry. It has no effect through
    other adapters, or where the host sends a thinking config of its own,
    through `request.extra` or `providerParams`, which replaces membrane's.
    Any other model carries it only while thinking is on. A model whose
    thinking is always on (Fable, Mythos) gets an adaptive thinking config
    to carry it, with the agent's `thinking.display` when that's set, so on
    such a model `display` takes effect only with this setting. membrane
    notes that the Mythos family has refused thinking configs with a 400
    before, so on a Mythos model the setting may fail every request.
  - **What's reported:** on a framework turn, each call's dropped blocks, and
    any shown to the model though they failed the check, appear in its
    `inference:usage` trace as `thinking`. A call that dropped blocks, and
    every later call of its stream, isn't used to calibrate the context
    strategy's token estimates, since the provider doesn't bill a block it
    dropped and the strategy still counts it. Where the strategy still sends
    the blocks a fold left bound to a conversation the request no longer
    holds, the provider drops them on every call until a later fold takes
    them out of the context, and while they're sent, no stream calibrates and
    the estimates keep the value they had. The direct API carries the setting
    too, but reports nothing of it.

- `ToolResult.dataIsContent` says a result's array `data` is a protocol result's content, in which every element is a block, of a type the host can show or not. The model then reads each element as itself, as a reference's stub, or as a marker saying what it was, never as the array's JSON. agent-framework sets it on an MCPL tool's result, and a module that returns a content array can set it too.

- **A direct workspace mount can be written:** the workspace no longer refuses a mount with `backend: 'direct'` whose `mode` isn't `'read-only'`, and one that names no `mode` is writable, as any mount with none is. Its `write`, `edit`, `edit_many` and `delete` land on disk when they answer, or don't happen, and none of its files go into the store. The settings a direct mount refuses are otherwise as before.
  - **A write is whole:** the new bytes are staged beside the file, in `.workspace-staged-<id>`, at the file's mode, special bits included as far as the kernel lets the process set them, and renamed over it, so a reader beside the agent never sees half a file, an edited `0755` script stays `0755`, and a process killed mid-write leaves the old file whole. A process that dies between staging and its rename leaves the staged file, which `ls` and `git status` show by that name and nothing sweeps; so does a refused write whose removal of its staged file fails, or whose directory another writer moved meanwhile. A new file takes `0666` less the process's umask, as a shell's would. The file's owner and group become the process's and the ones its directory gives a new file, and an ACL or extended attribute on it isn't carried over, as with any write that renames over a file. A file the process may not write is refused, as a store-backed push's write is, and so is a file in a directory it may not write, where the staged file is made. A file with other hard links gets a file of its own at its path, the other links keep the old text, and the answer's `note` says so. Nothing is synced, so a power loss or a kernel crash can lose a write its answer said had landed.
  - **An edit is planned against disk's text as it is now,** by the store-backed kind's planner, and its answer is a store-backed edit's, changed region included. Just before the rename, the file is checked unchanged since the edit read it, by its bytes, read again, and by its device, inode, size, mode, owner, group and change times. A file another writer changed meanwhile is read and planned again, three attempts in all, so the edit lands on top of that change, and it's refused where its match is gone or now occurs a different number of times, where a file changed at every attempt, or where the next read refuses it as any read would, with nothing written. The answer's `note` says when a file was read again. The bytes are compared because a kernel that stamps files from a coarse clock, as Linux before 6.13 does, can leave a same-size change made within one tick unstamped.
  - **`edit_many`** checks every edit in every file, stages every file and checks each unchanged before it renames any, so a full disk while staging, or another writer's change, is met before any file is replaced. If a rename then fails partway, the files before it are written and the rest are as they were, the answer names each file's outcome, and nothing puts the written ones back. A refusal says the call wrote none of its edits. Two paths that reach one file, through a link or as hard links, are refused, so the file is named one way.
  - **`delete`** unlinks the file through the mount's boundary, as a store-backed push's deletion does, a followed link's entry included. One that fails after reaching the file says the file may be gone.
  - **Links:** on a mount that doesn't follow links, a write, edit or deletion at a link is refused. On one that follows them, a write or edit goes to the file the link leads to, where that stays inside the mount, and the link stays.
  - **After an undo or another move of the store's head,** the files stay as the departed turns left them. At the agent's next start, opening, continuing or resuming, the framework stores one notice in its history, before that start's compile, for each mount the agent wrote direct whose latest such write its history no longer holds, whether the mount runs direct now or as `'chronicle'`: "Writes to `<mount>` from turns the history no longer holds are still on disk. If it's a git checkout, `git status` and `git diff` show them; a `git checkout` of a file drops every unstaged change in it, including the ones the history still holds." Each agent is told only of its own writes. Whether the notice was given is judged by its own presence in the history: an undo that takes it away gives it again, a redo back to the latest write needs none, and going back to a branch told earlier, after another branch's notice, gives it again. The latest write's position and the notice are saved at a clean stop, in a global record the store keeps whatever branch it's on, with the mount's configured root, so a restart on another branch, such as an offline rollback's, still gives the notice, a mount left out of one session's config keeps its positions for the next, and a mount whose path changed gets none at its new path, while its old path's are kept for when it's back; a crash loses the positions of writes made since the last one, and a later move away from those writes isn't told; it can also repeat a notice given since then. A record the store can't read leaves a session with no positions to restore, and the record as it was; one that reads but isn't of the shape saved is replaced at that session's stop. A head that moves away under a running turn and comes back before the agent's next start loses the notice for the writes made while it was away.
  - **Tool descriptions:** `write`, `edit`, `edit_many` and `delete` gain a sentence about the direct kind only on a host with a writable direct mount. `ls` without a path, and `status`, give such a mount's `mode` as `'read-write'` where its config names none.
- **The framework's own files pass over a mount configured direct:** tool-result spill files, saved MCP payloads and fetched references go to the first writable mount without an include that isn't direct, so none lands in a checkout, where `git status` would show it and an undo would leave it. A host whose only writable mount is direct gets no spill file and no stored reference, and the truncation note, and the stub for an MCP payload it can't show, say no mount that keeps its files in the store can hold it. `getMounts()` gives `backend: 'direct'` for a mount configured direct, whether it runs direct this session or, while the store holds work there that disk lacks, as `'chronicle'`. While a mount configured direct runs as `'chronicle'`, it takes no `write`, `edit`, `edit_many`, `delete` or `writeBinary`, which would stay in the store: each is refused, saying why and that a `sync` of a held path or a `materialize` naming the mount settles what's held, after which a start runs it direct. Its start alert says the same, and no longer says to configure it `'chronicle'` to materialize it, and `getMounts()` gives it as `'read-only'` for that session.

### Changed

- The workspace's `read` shows a file's text as it is, and says so. A line page shows a CRLF file's lines without the CR before each line feed, and leaves out a BOM. A line whose own text ends in a CR shows its line end's CR too, since `edit` reads a CR before a line feed as part of the line end, so text copied from the line still matches it. Its note says when the file has CRLF ends or a BOM, counting a mix of CRLF and LF ends and the lines that show both CRs. It also says when the file isn't valid UTF-8: each invalid byte sequence shows as U+FFFD, `edit` refuses the file, and `write` replaces it whole. Before, each line of a CRLF file ended in a CR, a BOM came first in the first line as U+FEFF, and invalid bytes showed as U+FFFD with no note. A character page still reads the stored text as it is, BOM and CRs included.
- On a page for a call that carries a `resultMaxChars`, such as a model's or a running script's, a line over 2,000 characters is cut, with a marker that gives the `offsetChars` and `limitChars` that read its rest. Before, a line page showed every line whole, however long.
- A `read` page stops before its result would pass `resultMaxChars`, the most of it that can reach its caller whole. For a model's call that's its agent's inline cap, 24,000 characters by default, within which a result is stored whole unless its round's results together pass the readers' bound; for a running script's call it's what the script's memory takes, 7,456,527 characters at the default 128 MiB. Its note says where to continue: the `offset` after its last line, or for a character page the `offsetChars` it also gives as `nextOffsetChars`, with the `limitChars` left of what it was asked for, so a reader that follows the notes ends where it asked to. Where even a page's first line would pass the limit, that line is cut shorter, at the most the page has room for. Where a page's last line is cut, its note names the `offsetChars` where that line's rest starts and the `limitChars` that reads it to the line's end, before the next line's `offset` if the file goes on. A page always moves on, so where its own fields (the path and its notes) and the least it can show pass a small limit, it passes the limit. At 1,000 characters, a page with no notes does that only for a path of about 690 characters or more. Its notes take room from that: with all three notes on a file's text and a conflict's, a path of 101 to 137 characters does it, and a note that names a symlink's target, as one saying disk couldn't be checked can, takes as much room as the target is long. Before, a page of up to 2,000 lines, or of `limitChars` characters, went out whole, and for a result that passed the limit the framework kept only its start, cut mid-JSON, writing the whole of it to a workspace file where the agent has one. A caller that pages 2,000 lines at a time and starts the next page at line 2,001 now starts where the note says. A running `code_execution` script's call has that larger limit, so its line pages still stop at the line limit, 2,000 by default, and its character pages at `limitChars`, unless a page would pass that. Its line pages cut a line over 2,000 characters and leave out CRs and a BOM, as a model's do, and a character page gives it the stored text exactly. A call made in process, through `handleToolCall`, `executeToolCall` or `ModuleContext.callTool`, carries no `resultMaxChars` unless its caller sets one. Its line pages stop at the line limit alone and show every line whole, as they did before, though now without the CRs and the BOM.
- The workspace's `grep` leaves out a CRLF end's CR, for matching as well as display, as `read` does, so `foo$` finds a CRLF file's line too, as it does under ripgrep's `--crlf`. A match's text and context are its lines as `read` shows them, but each line whole, where a `read` page for a call with a result limit cuts a line over 2,000 characters. A BOM isn't part of the first line, and a file with CRLF ends says so in its result's `lineEndings` (`CRLF`, or `mixed`). Before, a CRLF file's lines ended in a CR, so `foo$` missed them and a match's text copied into an edit carried the CR. A pattern written to find the CR of a CRLF line end no longer matches, except on a line whose own text ends in a CR, which keeps its line end's CR as `read` shows it. When a pattern names a CR, as a literal one or as `\r`, `\x0d`, `\u000d`, `\cM` or `\015`, and a file it searched has CRLF ends, the result's `note` says how many files searched have them and names them, each as `CRLF` or `mixed`, up to 20 and then how many more. It also says that a character `read` shows every CR in the workspace's copy, or in disk's file on a direct mount where the host has one. A pattern that names U+FEFF, over a file that starts with a BOM, gets a note that names the files that start with one and says a BOM isn't part of the first line. So a `grep` for `\r` or `^\uFEFF` still finds which of the files it searches have CRLF ends or a BOM. A CR that doesn't come before a line feed is still part of its line.
- The workspace's `read` first takes in a change on disk to a file the workspace holds, as a listing and an `edit` do, and shows that text. Its note says so when disk's copy had changed since the workspace last agreed with it. It also says when disk's copy couldn't be checked, or disk has none and nothing records whether it was deleted there, so it shows the workspace's copy; where the check gave up because the selected branch kept changing, it says to read again. A file disk deleted answers that disk deleted it and the deletion was taken in, and a file disk made binary or too large answers that it's on disk but not stored. Where the path's stored copy is a draft and disk changed or deleted it too, the read shows the draft, and its note names the conflict and the ways to settle it, a sync, or a forced materialize on a mount that isn't read-only: for a deletion, a sync of the path takes it and removes the workspace's copy. Before, a read of a path the workspace held didn't look at disk, so it could show a copy another writer had since changed; a path it didn't hold was observed, as now.
- A direct mount's `read` and `grep` show a file's text as a store-backed mount's do, with the same pages, cut lines, notes and `lineEndings`. Only the disk check is a store-backed mount's alone, since a direct mount reads disk as it is and keeps no copy of its own.

- A conversation fork's or an ephemeral run's `sleep` and `wake` are refused, with a result saying that nothing was set or changed, and why. The gate's sleep quiets the whole agent, so a fork's sleep held back the primary's wakes until the sleep or the fork ended, and a fork's `wake` ended the primary's own sleep. Where a fork can call `skip_reply`, the refusal names its `wake_in_seconds` as the way to come back to the conversation later. The primary's sleep is unchanged, and still quiets the messages its forks would wake on.

- A batched (debounced) wake for one MCPL message that is still the newest
  entry in the agent's window runs without its `[Gate: 1 event matched] …
  already shown above at arrival; this is a batched wake, not new content`
  line. The line says which messages a wake is for, and for that one message,
  right above it, it said nothing new: on a resident whose addressed messages
  wake through a 5 s debounce, a third of the window was these lines, four in
  five of them right under the one message they named. The wake itself, its
  provenance and the reply's channel are unchanged. The line stays whenever it
  says something: several messages in the batch, anything stored after the
  message (the agent's own turn, another message), a turn running or a write
  waiting, a message a tune-out holds, and content the line quotes (events not
  stored at arrival). The gate asks the framework (`isNewestEntry`, by the
  message's server, channel and message id, or a push event's event id); a
  gate built without it writes every line, as before. A clock row stored after
  the message doesn't count against it. The gate asks when the batch fires,
  and the turn compiles later: a provider hold or a compression in flight can
  leave room for another message to be stored in between. So when the message
  is still the newest at the fire, the gate hands the line to the wake, and
  the turn's start decides, after its own inputs land: if anything is stored
  after the message by then, the line is written there, after what arrived and
  before the start's own notices, with the same words and its age counted to
  then, once, at the start of the agent the window belongs to, before its
  answer. Another resident reading that window places none (every resident
  gets every batched wake), so its request shows what the window holds, as
  before. No start writes one while the host is quiesced or another resident
  reading that window has a turn alive, where it would land inside that turn,
  as a clock row waits then too; that start's request goes without it, and it
  is written only if another fresh start of the wake comes. A line left out is
  decided again if the provider holds the turn and its fresh start runs later;
  if the first start's own notices then follow the message, as a routing
  notice does when the turn's channel changed, the line is written. A retry of
  the same start decides nothing. Each fresh start that leaves a line out
  traces `gate:wake-line-omitted`, with its reason (`newest` or `held`); a
  line whose write fails is logged and left for a later start. A turn that
  never starts for the wake, or one that starts as the continuation of a turn
  already running, writes no line and traces none.

- `maxSyncPerTick` and `maxSyncBeforeSearch` are now the most items one
  pass writes to the semantic index: what the service reports each upsert
  inserted or updated, with each queued edit counted as one. Deletes aren't
  counted. A pass stops where that runs out, inside a millisecond's
  summaries or a page of messages too, and the next pass goes on from
  there. Their documentation had called them the most items a pass would
  push, which no pass kept: the message walk checked once per page of 256,
  and messages the overlap behind the cursor found new went uncounted. A
  pass still re-sends items the service holds unchanged, such as the
  overlap's, and those spend no budget and need no embedding, so
  re-sending them can't use a pass up. A search that finds a pass already running waits for that pass,
  under its budget.

- Each MCPL server is told only of its own channels in
  `context/beforeInference`'s channel context (SPEC §14.4): `incoming` and
  `defaultOutgoing` only when that channel is the server's, and `candidates`
  only its own open channels. Every capable server was told the same
  context, other servers' channels included, by their ids alone, which a
  server registering the same id would read as its own. A server that read
  other servers' channels from it no longer hears of them.
- A `[prose-routing]` bounce that lists the channels its target could mean
  gives its resend examples with the first of them written as one token,
  such as `>>a:general {{unsent}}` and `destination: "a:general"`, where it
  gave `>>#channel` and `"#channel"` whatever it listed.
- The `mcpl:conversation-spawned`, `-spawn-failed`, `-unrouted`,
  `-binding-orphaned`, `-closed` and `-disposed` traces carry the channel's
  `serverId`, and a refusal's failure log names its locus as the agent is
  shown it.
- `inference:started` carries the server of its `channelId` as `serverId`,
  so a host that posts back to the turn's channel can name it where two
  servers register the id. `inference:tokens` and `inference:content_block`
  carry the id alone.
- `channel_list` gives a channel whose id names another channel too, another
  server's channel with that id or another channel's server-qualified id, a
  `name`: its server-qualified id, where that names it alone, which
  `channelId` takes, and a `>>` target too where it is one token. Other rows
  are as they were.
- The results of `channel_open`, `channel_close` and `channel_decline` carry
  the channel's `serverId` in their `data`.
- An open that a tune-out overtook ends as `channel_open`'s refusal of a
  tuned-out channel does, saying how the tune-out ends: by cancelling it,
  which delivers the diverted backlog, or, for a channel no name picks
  alone, by itself.
- A fork's channel refusals quote its channel and what the call asked for.
- A `serverId` given to `channel_publish`, whose schema has none, is read
  beside a `channelId` as that exact pair, and with no `channelId` as the
  default channel's id on that server, where it was ignored.
- A drafts resend whose destination names a channel that takes no posts is
  refused before anything is sent, as a `>>` target naming one is; before,
  the send refused its first draft.
- In explicit mode, a start whose wake names no channel, such as a budget
  restart or a re-inference, keeps typing in the channel the turn shows,
  starting it again where a stop or a failed start ended it, and its token
  traces carry that channel's id, where they carried none.

- An `afterUser` context injection, a module's `gatherContext` or an MCPL
  `beforeInference` hook's, is appended to the agent's window at the start
  that gathers it, as the message `compile()` would have placed
  (participant `system_context:<namespace>`), so it stays where the agent
  saw it. Where the window ends on a user message, as at a turn's start and
  a restart after tool results, that's where `compile()` placed it.
  Before, `compile()` placed it after the newest user message at each
  start, so it moved every turn and at each restart after a tool result:
  every reply after its old place lost its thinking on a model that binds
  thinking to everything before it, and the previous turn's cached prefix
  was rewritten. The first start after upgrading stores each
  injection once, so that request's cached prefix ends where the injection
  used to be placed.
  - **What's stored again:** a source's unchanged content isn't stored again
    while the copy the agent will read as current has it whole: the one its
    last request held, or a newer one a start stored whose compile then
    didn't record (it threw, or the start failed before it). An injection that would
    leave nothing in a request (no block but blank text) isn't stored, and
    is placed as before. Changed content is appended then (see where it
    lands, below), and the earlier copy stays, so each change adds a row
    until a fold summarizes it. A copy a fold has summarized, or a
    strategy's window has passed, is stored again, as one more row, at the
    start after the first request that no longer holds it, so that one
    request has the summary's word for it, or, past the window, goes
    without it. So is one after the host restarts or the window changes
    branch. A copy a start stored whose compile then threw isn't stored
    again by an error policy's retry of that start, since no request has
    had it yet, and content that changed back while a compile failed is
    stored again (where the window can't be read then, one request later).
    A copy the strategy cut
    at its per-message cap counts as held, since a new one would be cut the
    same. A copy whose source stops giving it stays in the window until a
    fold, where before it was gone at once.
  - **Where it lands:** appended to the window. Where the window ends on the
    agent's own reply (a wake with nothing new), a changed injection lands
    after that reply, and `[Continue]` still ends the request, after it.
    Where another participant spoke last (another resident, a visitor),
    the request ends on the injection, after that message; `compile()`
    placed it after the last user message, before it.
    `system` and `beforeUser` injections are placed by `compile()` as
    before. While the host is quiesced, or another reader of the residents'
    shared slot has a turn alive, nothing is stored: `compile()` places a
    changed one.
    A request that ends on an injection `compile()` placed (in a window
    with no user message, or a held window where a changed injection is
    placed rather than stored) gets no `[Continue]` after it, and a tool
    loop's prompt doesn't carry past it, as before.
  - **A stored injection is history to the strategy:** it's sharded,
    selected by the budget and folded like any message, where a placed one
    went whole. Under the windowed-passthrough strategy, an injection larger
    than `maxMessageTokens` reaches the request cut to it, with the cap's
    omission marker. The autobiographical strategy, with
    `adaptiveResolution` on, stores a message over twice
    `targetChunkTokens` in shards of about `targetChunkTokens` each, and
    caps each shard on its own.
  - **Host authors:** a stored injection is a row of the agent's window, so
    `getAllMessages`, `queryMessages` and a module's reads return it. Its
    metadata carries `system: true`, `kind: 'context-injection'` and
    `contextInjection: { agent, namespace, contentHash, part, parts }`. The
    newly exported `storedInjectionMarkOf` reads it as the framework's own
    views do. A reader that answers "what did someone say" should leave such
    rows out. Every other agent's view (another resident sharing the slot,
    the subconscious) leaves them out, and a conversation fork's seed leaves
    out its template's, though a summary that folded one in is seeded as
    summaries are. The history module's semantic index leaves their rows
    out, though a summary that folded one in is indexed as summaries are; its
    `extract`, `search`, `stats` and `overview` list them under their
    participant, as they list clock rows, every resident's in a shared slot,
    and a channel-filtered read leaves them out, as they carry no channel.
  - **Module authors:** `gatherContext` returns `ModuleContextInjection[]`,
    whose `placedEachCompile: true` keeps an injection placed by `compile()`
    at each start, near the end, as before, at the cost of the thinking of
    every reply after its old place. It's for context meant to stay near the
    end, such as instructions moved off `system`. An existing module's
    `ContextInjection[]` is still accepted. An MCPL server's injection can't
    opt out.

- In an MCPL tool's result, or a module's, a link (MCP's `resource_link`) the host can't fetch whose uri may carry a credential now shows a stub that says why it can't be fetched, with no uri, where the result's JSON showed the uri. So an agent no longer sees that uri, and has no other handle on the link here. Such a uri has userinfo, or a query or fragment parameter that has a value and is named like a signed URL's or a token, such as `X-Amz-Signature`, `sig`, `hm`, `token`, `access_token` or `key`, compared by letters and digits alone, so `accessToken` and `token[]` count too. A parameter's value that is itself a uri is read the same way, whether absolute (an image proxy's `?url=` holding a percent-encoded signed URL), protocol-relative, or relative with a query or fragment (a login's `?next=%2Freset%3Ftoken%3D…`), and also once decoded again where a redirector encoded it twice, each read and decode a level, up to four; a uri reached deeper counts too, and one in another encoding, such as base64, isn't read. RFC-005 §5 gives the reason: signed URLs and query capabilities are bearer credentials that look like locations. So does a link to a uri that any reference in the same result marks `disposition: never`, or to a uri that shows as the same text (a label's cleaning drops controls and bidi marks and trims surrounding space, and a lone surrogate shows as U+FFFD), or, where no reference in the result names the uri (a link names it without claiming anything), whose reference from an earlier result, as the host's record of the uri holds it, did (the latest reference until its bytes are saved, then the one they were verified against), since RFC-005 §5 removes such a uri unconditionally. An ordinary link with a query, such as `watch?v=…`, and an anchor such as `#token`, which has no value, still show their uri. A standard MCP server's result, a modern server's or an MCP-only one's, isn't read this way: its links show their uri as the server sent it.
- In a script's structured result, from an MCPL peer or a module, a reference arrives as its object without its uri, as before, except a link (MCP's `resource_link`), which carries `uri` where the model's line for it shows the uri. One the fetcher would refuse carries `unfetchable`, the words a stub gives in place of advising `fetch_reference`, as one that counts as expired carries `expired`. Both give why a `fetch_reference` with the object's `refId` would be refused, as the result's references claim it, so a link whose line shows its uri carries them too. An MCPL peer's link reached a script as the unknown-block notice, and a module's as its fields, its uri among them. A script's view reads the claims of every reference it shows, those nested in a block's fields included, so a `disposition: never` nested in one block withholds that uri from a link elsewhere in the same result, where the model's line, which shows a block and not its fields, can still show it. A link's object carries its uri only where the model's line for the result shows it, by the claims that line reads and the uri's record as that line leaves the registry, before the script lane's own registrations, so a script never sees, through a result's blocks, a uri the model's line withholds, within 2,000 references in one result: past that, either can lose an earlier result's `never`, and a script reading a module's content array can lose it where the line, rendering in order, hasn't yet. A result's structured content reaches a script as sent, as before. A script's demand fetch of an MCPL peer's references reads the same claims as its view, as a module's does, so a uri a reference nested in a block calls expired isn't fetched.
- A uri inline data marks `disposition: never` beside its data, which is withheld, is withheld from every other block of the result too, such as a link naming it, as a reference's `never` is (RFC-005 §5).
- Inline data beside an empty `uri` reaches a script as sent, from an MCPL peer as from a module, where 0.26.1 and 0.26.2 gave a script an MCPL peer's as the withheld notice. An empty uri carries nothing a credential could ride on. Inline data beside one that also claims a disposition is still withheld.
- A tool result's data that can't be read through to apply RFC-005's rules, or shown once it has been, shows `[Result not shown: the tool ran, but its result couldn't be read through, checked for references and shown, so this host withheld it.]` on the model's lane, in the stored and sent copies alike, with a log line naming the tool and the error. It was shown with none of its references' claims where the walk reading them stopped and the render's didn't, or, for data no JSON can hold, such as a cycle or a BigInt, a getter that throws, or data too deep to write, the copies' serializer threw. So a host passing such a result to the direct Agent API gets the notice where it got an exception, with the tool-result guard off; with it on, its archive of the result, and the fields it keeps of a result it withholds, still throw, as before, as does an error result whose own error field can't be read. A script meets it as a failure naming the tool, on its text route as on its structured view, and from an MCPL peer's structured view as a result it can't convert.

### Fixed

- A start now applies the recipe's wake rules to an existing `gate.json`, where it only appended rules under new names before (#654). The gate keeps the recipe it last applied beside `gate.json`, in `gate.recipe.json`, and merges the recipe against it at each start:
  - a rule the recipe dropped goes, and a renamed rule takes its new name at the recipe's place, rather than landing behind a catch-all while its old name keeps matching;
  - a rule the recipe added, moved or redefined takes its place and definition;
  - a rule edited at run time or by hand keeps its definition, even when the recipe drops or changes it, and a rule added at run time stays where it is;
  - a rule both recipes declare that was removed at run time comes back at its recipe place;
  - a recipe rule moved at run time, as `wake_add_rule` with a position does, keeps `gate.json`'s order;
  - an unedited `default` takes the recipe's.

  Each start that merges into an existing `gate.json` and changes something logs one line naming the rules it added, removed, updated, restored, moved and kept, and the `gate:config-reconciled` trace carries the same lists. Rules are compared by what the gate reads, so a recipe rule that `wake_add_rule` wrote back unchanged still follows the recipe. Where `gate.json` or the recipe names a rule twice, the merge can't run, so a start only appends the rules `gate.json` lacks, as before, and removes, redefines and records nothing. The log and the gate's status say why, and status keeps it until the gate is next created.
  - **The first start after upgrading** has no recorded recipe, so it removes and redefines nothing. It puts the rules that match the recipe into the recipe's order, and names the rules that differ from the recipe or aren't in it. A rule that differs can be removed, and the next start restores it from the recipe.
- `wake_add_rule`'s result names the rules no probe event reaches (`notProbed`), such as one scoped to `external-message`, so its probe rows of `default:skip` don't read as their effect (#654).

- `workspace--grep`'s `glob` filter matches a file's name at any depth when
  it holds no `/`, as ripgrep's `--glob` does, so `*.ts` or `*.{ts,tsx}`
  finds those files wherever they lie in what's searched (#694). It was
  tested only against the path from the mount's root, so with no `path` it
  let through only the files at a mount's root, and with a `path` below the
  root, a directory or a file, it let through none, answering "no matches"
  for files that were there. The path is still tried too, so every file a
  filter let through before still passes. A filter with a `/` is still
  matched from the mount's root, whatever the `path`, or read mount-prefixed
  in the mount its first segment names.
- Where a `path` and the directory a `workspace--grep` filter with a `/`
  names before its first wildcard or brace lie apart, neither holding the
  other, as `path: "project/src"` and `glob: "components/*.tsx"` do, the
  grep is now refused, saying how the filter is read, where it answered
  "no matches". `workspace--glob` is refused the same way where its
  pattern is read mount-prefixed, as `path: "project/src"` and
  `pattern: "project/lib/*.ts"` are, unless the `path` lies in another
  mount's directory, which is said to be that mount's, as grep says it.
  Where the `path` isn't a file, the refusal also names the filter or
  pattern that reaches beneath it, mount-prefixed
  (`project/src/components/*.tsx`), unless it has an empty, `.` or `..`
  segment.

- A tool presentation file or a description defaults file saved as UTF-8 with
  a leading byte order mark, as some Windows editors save a hand-edited file,
  is read like the same file without one. Each was refused as "isn't valid
  JSON". For a presentation file, none of its settings applied, and
  `set_tool_visibility` and `set_tool_description` refused to write until it
  was repaired (#758). For a defaults file, the descriptions it sets didn't
  apply. Exactly one leading U+FEFF is skipped, as `gate.json` already does
  (#395).

- On a server that's up but whose grant lacks `channels.lifecycle`, speech, a draft's resend or a
  send's open step no longer tries to open a channel that isn't open, since nothing opens there:
  the words go into the channel as it stands, and a send answers `already-open` or `stays-closed`.
  Before, speech and resends there were refused, with "… this host isn't permitted to open or close
  the … server's channels", or with "the channel isn't confirmed open" where a retarget had left it
  unconfirmed, and a send's open failed and was traced as `mcpl:channel-open-failed`.
- The latest deliberate close is the one on record: the agent's `channel_close` over its own
  decline, its `channel_decline` over its own close, and either over a module's close, or a
  module's close over the agent's, now record themselves. Before, a channel the agent had already
  declined kept the decline when it closed it, and the reverse. A machine close of a channel with
  no record at all, one registered lazily or on a server whose grant lacks `channels.lifecycle`,
  now leaves it the default it had, where it used to record its own source, which policy never
  lifts (#417). Records written before this change keep their source, so a channel a machine closed
  before the upgrade still isn't opened by policy.
- `channel_decline` of a channel decided open that isn't open at the transport, whose open failed
  or is still on its way, now records the decline, where it was refused with "… is open, or set to
  open, so there's nothing to decline". That's the decline the invitation offers as the way to
  reply without opening a channel. Where its transport may be open, as with an open on its way, the
  decline closes it through the channel's lifecycle queue, as any decline does. A channel open at
  the transport is still refused, now with "… is open, so there's nothing to decline", and so is a
  tuned-out channel, as before.
- `channel_close`'s description and the "[channels] Now open" and policy notices' last sentence now
  say that a channel the agent closes stays closed until it opens it with `channel_open`, and that
  neither speaking there, the subscription policy nor its server's own default opens it again.
- The closed-channel invitation is no longer added to a direct message (`chat:dm`), all of which
  reaches the agent whether the DM is open or not. Where no single-word target reaches a channel,
  it no longer says to open the channel to reply: it suggests checking whether the server has a
  send tool that can address the channel, and says what replying there does.

- The estimator calibration sample hands the context strategy the system
  prompt and tool definitions the request sent, beside the provider's input
  total, so the strategy compares that total with an estimate of the whole
  request, not of its compiled window alone (context-manager #323). Before,
  a tool-heavy agent's calibration multiplier learned its tool schemas as a
  per-token rate, or sat at 1.00 rejecting every sample as out of band. A
  context-manager without the second argument ignores it, 0.20.0 included,
  so the multiplier learns as before until the host runs a context-manager
  release with context-manager #324.

- A deferred write that throws after it's stored, whose store can't be read back to tell whether it landed, is now looked up by its id at the boundary that wrote it, so it counts as written there, where it landed, and at a tool boundary it's injected with what that boundary stores, before the turn's later replies. Before, it was queued as a doubt and counted at a later flush where it first landed, ahead of later replies whose requests never held it. That's still so, as a known limit, for a write that can be neither read back nor looked up there: on an account where the provider enforces its binding of signed thinking to the prefix it was made with, a later request replaying the signed thinking of a reply stored after it, whose request didn't carry it, is refused with a 400 (context-manager #155). A recompile before the next tool boundary, such as a retry, carries such a copy where it was stored, and the boundary that then finds it injects it again, as before, so a later request replaying the signed thinking of a reply made after that boundary is refused the same way.
- Looking a held write up by its id no longer fails because another message's blob is missing: where context-manager's query throws, the branch is scanned without blobs, and only the rows that match are read with theirs. Before, every such write stayed a doubt, holding what was queued behind it for its agent, and each read logged it again. The lines saying a store can't be searched, and that a drain holds what's queued behind such a write, are now said once per write until a lookup succeeds. The first is said again when its failure changes, and names the query's own error, which names the missing blob.
- A module's `onProcess` response that throws as the framework applies it (at an edit of a held write that may already be stored while its store can't be searched, an edit of a message the store doesn't hold, or any store error) no longer ends the event's processing. The response stops where it threw, as before: what came before the throw stays applied, the operation that threw may have taken effect in part or whole, and the rest of it, its state update and inference request included, isn't. A line now names the module and where it threw, `process:completed` and the process log name the response with where it threw (`ModuleProcessResponse.threw`), and the other modules' responses, a `tool-call` event's dispatch, the event's trace and its process log go on. Before, the throw escaped the event's processing and all of these were lost. `EventResponse`'s docs, the README and two comments no longer say a response is applied atomically, which it wasn't: they say it's applied in order, up to a throw.
- The log line for a held write settled through a stored row a module names says when that row is one shard of a body, rather than that the whole write was stored.

- The eager reference fetch, which fetches an MCPL tool result's small references before the agent sees the result, now keeps to its own limit (#747). A fetch it starts reads no further than the first chunk past the server's eager limit (`autofetch.maxBytes`, 256 KiB by default). Before, only the size a reference claimed was held to that limit, so a body larger than its claim was read and saved whole, up to the host's 256 MiB ceiling. Once its fetch of a reference fails, for any reason, the eager fetch doesn't choose that reference again at later results, where it used to try at each: its stub offers `fetch_reference`, which still works. A reference that claims no more than the eager limit but whose body runs past it is now read twice: up to the limit by the eager fetch, then whole by the next fetch that wants it, `fetch_reference` or a script's own fetch of its references. Before, the eager fetch read it whole once, and later fetches got its saved copy.
- Each caller of the reference fetcher now waits no longer than its own timeout, counted from its own call and covering the workspace save: 10 s for the eager fetch, and 60 s for `fetch_reference` and a script's references. A caller that joined a fetch already in flight used to keep that fetch's timer and byte ceiling. So an eager fetch that joined a `fetch_reference` could hold the tool result for 60 s, and a `fetch_reference` that joined an eager fetch failed at its 10 s. Now, when the fetch it joined stops on a narrower byte limit than the caller's own, the caller fetches again under its own, and when it stops at its time limit, the caller fetches again if it has more time left than that fetch's starter's whole timeout. A fetch that succeeds still answers every caller waiting on it, an eager fetch that joined a wider one included.

- MCP's embedded resource, `{ type: 'resource', resource: { uri, text } }` or `{ …, resource: { uri, blob } }`, which RFC-005 §8.1 reads as an ordinary inline block, showed as `[Reference not shown: it arrived without a link.]` on the lanes RFC-005 governs: an MCPL peer's or a module's tool result, a script's view of either, and the push, channel and injection lanes. So its contents never reached the agent. Its contents now show as the block they make: its text as text, and a blob of an image type as an image, of an audio type as audio (in a tool result, the audio marker), and of any other type as a marker naming its type and size. A script's view gets that block too, an image or audio blob as inline data. Its uri isn't shown. One that also claims a disposition is withheld, as inline data that claims one is, and one that claims `never` marks its uri `never` for the result, so a link to that uri in the same result shows its stub. One with both text and a blob, or neither, shows a marker. At any depth in a tool result's data, it's the text its stored copy shows: its uri under `resource` no longer counts there as a reference's. Content whose only block is an embedded resource with blank text is empty, as content with only blank text is: such a push or channel message is refused, and such a render result is nothing happened. A withheld result whose data is an embedded resource keeps nothing in the guard's notice, since its text is the body withheld. A standard MCP server's result is read as before.

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

- `semantic_search` keeps a summary apart from another branch's summary with
  the same id. A branch made from an earlier point, as an undo makes one,
  mints summary ids its parent already used, and the index held one item per
  id, so the branch that synced last replaced the other's summary there. A
  summary is now indexed as `sum:<id>@<created>`, by the time it was minted,
  which a branch that inherits it keeps. A hit whose time isn't this branch's
  summary's is dropped as off-branch and counted in `index.droppedOffBranch`.
  Hits still show the id as `sum:<id>`. An item from before, under the id
  alone, can hold another branch's summary, so it's never a hit. It's
  counted as off-branch when its id names no summary on this branch, and
  otherwise isn't counted, since it may hold this branch's own.
- Each branch sends its own messages and summaries to the index. The sync
  cursors are kept in the history module's state, which the store's branches
  carry, where they were the service's one watermark for every branch. So a
  message or summary stored on a branch with cursors and left before a sync
  is sent once that branch syncs again, whatever another branch sent
  meanwhile. A branch with no message cursor yet, from before the upgrade or
  made at a point before its first pass after it, starts its walk at the
  service's watermark, as before. A deleted index starts the cursors over,
  and cursors kept for another namespace aren't used. A cursor is taken as
  no later than the index's newest item of its kind, so an index that keeps
  its namespace and loses its newest items, as a restore from an older
  backup leaves it, gets them again from the next pass, as before.
- **Hosts:** after upgrading, each branch a pass syncs embeds every summary
  it holds once more under its new key, a one-time cost on the embed service
  of one embedding per summary, and deletes the summary's old item,
  `sum:<id>`, where the service has `/delete`. Where it doesn't, the old items
  stay, and search leaves them out. Until a branch's passes have sent its
  summaries under the new key, a search on it can miss one: the search's
  own catch-up writes up to `maxSyncBeforeSearch` items first (256 by
  default), and background passes write the rest, up to `maxSyncPerTick` a
  tick.
  A summary only on a branch no pass syncs keeps its old item, unless
  another branch's pass sends a summary with its id.
  Messages start from the service's watermark, as before. The history
  module's state gains `semanticCursors`. Going back to an earlier release
  leaves summaries indexed under the new keys out of its searches until the
  index is rebuilt. An index restored from a backup taken before this
  release needs rebuilding too: search leaves out its older summaries' old
  items, and no pass sends again a summary a branch's cursor covers.

- **A module's `gatherContext()` that answers after its timeout adds
  nothing,** and no longer prints the line about blocks the system prompt
  can't carry. It was still pushed into the list the registry returns for
  the turn. When another module was still being waited for, it landed there
  before the list was returned, so it reached the turn's request. Otherwise
  it landed afterwards, and when another module had answered in time, a
  turn for an agent that isn't a conversation fork keeps that list while it
  waits for MCPL servers' `beforeInference`, so a late answer arriving
  during that wait reached the request too.
- **A module whose `gatherContext()` throws before returning a promise is
  skipped,** logged as a module that rejects is. The throw left the
  registry's `gatherContext()`, and the turn then went without every
  module's injections. A module whose `gatherContext()` returns an array
  without a promise has it taken as its answer, where it lost every module's
  injections the same way. One that answers with something other than an
  array is skipped and logged, where a string answered through a promise
  was spread into the turn's injections one character each.

- Modules' context injections now come in the modules' registration order,
  whatever order their `gatherContext` calls finish in, so `compile()`
  places what it places in a fixed order and a stored injection's content
  doesn't change with timing. Before, they came in the order the modules
  finished. A module whose answer is an array holding something other than
  an object (such as `null` or a string), or a `system` entry whose content
  isn't an array of objects (such as `[image, null]`, or an array with a
  hole), is skipped and logged; before, its entries were kept and
  reached the turn's start.

- A message that arrives while an agent's turn is alive, and that the turn
  hears at a tool boundary, no longer also starts a turn of its own after
  that turn when nothing is left for it (#264). When the scheduler comes to
  start its wake, the wake is dropped if a request that carried the message
  has been answered and, for a wake that carries a channel, unless its
  server marked the message ambient, the agent has since published into that
  channel: in its plain speech, with a `>>` or `>>>` address, in a sleep's
  announcement, with `channel_publish`, by resending a draft, or with a send
  tool whose channel the framework records (`send_message`, `reply_message`,
  `send_dm`, `send_file`, `send_files`). A script's publish counts only in
  the turn that started the script, and as made having read what the agent
  had read when it started. Such a wake whose channel the agent hasn't
  spoken in since the message was read still starts its turn, and so does
  one whose message reached the agent only in a request that failed. A
  message its server marked ambient asked nothing of the agent, so its wake
  is dropped once a request that carried it has been answered; one with
  neither tag is judged as addressed. This covers channel messages, push
  events, a module event's one message, background-script wakes and the
  gate's self-wake notices. Console and API input, a module event that adds
  several messages or whose event or message names a channel, a prose bounce
  notice and a tune-out cancellation keep their wakes. A render's wake to
  read it counts the render as read on the same terms: one that carries a
  channel now also waits for the agent to publish there, unless every notice
  the render folds was marked ambient, and then it's dropped once read, as
  before. `EventGate`'s `addMessage` and `requestInference` hooks take an
  optional `placement` and `after` (`WritePlacement`), which a host that
  builds its own gate passes on to have the self-wake notice's wake dropped
  too.

- An MCPL server's `inference/request` on a host that sets no
  `inferenceRouting` policy is refused before it reaches the provider, with
  `-32603` and a message naming `inferenceRouting`. Before, it went to the
  provider with the model `default`, a name the Anthropic API doesn't
  recognize (its token-counting endpoint answers 404 `not_found_error` for
  it), and a failed inference comes back to the server as `-32603` with the
  provider's message. The framework doesn't choose a model for the server: a
  model it picked would run, on whatever credentials and at whatever price
  it carries, for a server the operator never chose it for. A host whose
  provider served a model named `default`, through a membrane
  `beforeRequest` hook, a proxy or another adapter, loses server inference
  until it sets `inferenceRouting`. The capability grant is unchanged.
- A policy that names no model for a request's feature set refuses that
  request the same way, naming the feature set, where it sent an empty
  model on to the provider. A policy entry that is empty or not a string
  names no model: an empty `wildcards` entry is passed over, as empty
  `byFeature` and `overrides` entries already were, and an override or
  feature set named like an `Object.prototype` member (such as
  `constructor`) no longer reads one.
- Each refusal is traced as `mcpl:inference_fail`, with `model: null` and
  no `mcpl:inference_start`, so a trace watcher still sees the failure it saw
  when the request failed at the provider. The first refusal for each server
  is logged, naming what to set; with a policy, so is the first for each
  feature set it names no model for.

- `read_image`'s refusal of an image over 5 MB now says it's over the limit this host sends per image, where it called that a model limit: a route to a model can take a larger image. What it refuses is unchanged.

- Two MCPL servers can register the same channel id (MCPL requires one to be
  unique only within a server's connection), and the framework now tells
  their channels apart wherever it acts on one, instead of taking whichever
  server registered the id first, or refusing the id outright.
  - A turn's plain speech, its typing indicator and its outgoing stream go to
    the channel on the server the turn's message came from. Speech to a
    shared id was refused as ambiguous, with a failure marker, and typing
    showed on the server that registered the id first. The `[routing]` and
    `[channels]` notices, the turn's receipt, a bounce, the drafts'
    destinations and the channel tools' results and refusals name such a
    channel by its server-qualified id, `serverId:channelId`.
  - `channel_publish` and the subconscious's `speak_in_channel` refuse a
    shared id, naming each candidate by its server-qualified id, and take
    that form in `channelId` to name one server's channel. Both posted on the
    server that registered the id first. `tune_out` does the same, where it
    tuned out the channel on the server that registered the id first, and its
    result names the channel as the agent can name it back.
    `channel_open`, `channel_close` and `channel_decline` take the form too,
    alone, and a `serverId` beside a `channelId` names that server's channel
    with that exact id. The refusal names each candidate so it can be told
    apart, without "not found". Ids hold colons, so two channels'
    server-qualified ids can be one string, as `a`'s `b:room` and `a:b`'s
    `room` are: such a name is refused as a shared id is, and a channel no
    string picks alone is named by its id and server, `"b:room" on server
    "a"`. No tool's description or schema changes.
  - The subconscious's `cancel_tuneout` reads a name as `tune_out` does: it
    refuses a name two registered channels answer to, naming both, and takes
    the server-qualified form, where it cancelled the one on the server that
    registered the id first. Its `deliver_summary` refuses such a name too,
    and tags the summary with the channel's server, where it stored the id
    alone. Tune-out's notices, and the reasons its wakes
    give, name such a channel by its server-qualified id, and `tune_out`
    refuses a channel because a conversation is bound to it only when that
    conversation is bound to that server's channel.
  - A `>>` or `>>>` target takes the server-qualified id, and a shared id or
    label is refused with its candidates named so each can be told apart.
    `>>b:general` matched nothing, and a shared label's candidates read as
    the same id twice. `prose_help`'s reference shows the form. A `<@id>`
    mention or an `@name` that one person's DMs on two servers answer to is
    refused with both named apart, where a mention was refused as matching
    no DM. A closed-channel invitation for a channel whose id another server
    shares offers a `>>` reply naming its server.
  - A host's bare id to `startTyping` or `stopTyping` types in each server's
    channel with that id, so connectome-host's activity indicator shows in
    both, rather than on the first registered server. Where two servers reach
    one platform channel, two bots can show typing there.
  - `publishForAgent` refuses a shared bare id, where it posted on the first
    registered server. A host that passes the server as a ref is answered
    there, as one that passes `serverId:channelId` is where that names one
    channel alone.
  - A push's channel is registered for the server that pushed it, whatever
    another server registers, and its reply goes back through that server.
    A push leaves the entry of another server's channel with that id as it
    was.
  - Within a turn, a `>>` or `>>>` target, a drafts resend's destination,
    and the `channelId` of `channel_publish`, `channel_open`,
    `channel_close`, `channel_decline`, `tune_out` and the subconscious's
    `cancel_tuneout`, `speak_in_channel` and `deliver_summary`, that name
    the id of a channel the turn has been in (the channel of the message it
    answers, and any a mid-turn message or `channel_open` moved it to) mean
    that channel on its server, and, where two of the turn's channels on
    two servers have that id, neither, with each named. Where another
    server registers the same id, such a reply
    goes back where the message came from, where it was refused as a shared
    id; once that channel's server no longer registers it, the call is
    refused, where it went out through, or acted on, another server's
    channel with the id. A tool call takes the turn's channels only
    when it is made inside the turn, and a script's call only when the turn
    that started the script is the one waiting on it, so a script left
    running after its turn takes none, and a later turn's channels aren't
    lent to it.
  - `channel_publish` with no `channelId` posts to its default channel, the
    latest message's, on the server that message came from, and is refused
    once that server no longer registers the channel, where it went out
    through another server that registers the id. The refusal names no other
    channel to post to, since the one with that id that remains is another
    server's.
  - A wake that names its channel without the server, such as a host's
    inference request, by an id two servers share or that no registered
    channel has, gives the turn no channel and no fallback. Its speech isn't
    published, as before, and the agent is no longer told its speech lands in
    the first registered server's channel.
  - The deprecated conversation routing gives each server's channel its own
    fork, where a second server's channel with the same id reached the first
    one's fork. A fork's `channel_publish` and `channel_close` of its home's
    id act on its home, on its server, where they acted on the first
    registered server's channel, and a home its server no longer registers is
    refused as such. An addressed wake's route applies to the fork homed on
    that server's channel only.
  - Coalesced work for a channel is admitted only while its own server
    registers the channel, not another server's channel with the same id.
  - A batched gate wake's summary lists two servers' channels with one id
    apart, each with its count, where it merged them into one line under
    the first one's label.
  - Two servers' wakes on one channel id at one moment are two wakes to a
    provider hold, where one was dropped as the other's duplicate.
  - The registry keeps each channel under its server and id together, so
    server `a`'s channel `b:room` and server `a:b`'s channel `room`, which a
    key joined with a colon gave one entry, are two.

- Every problem a wake rule has is named, where these used to change what a rule does without a word:
  - a `behavior` that isn't an object, `"always"`, `"defer"` or `"skip"`, which was saved as `"always"`, waking on every event the rule matches. That covered a typo such as `"deffer"`, and in membrane's XML tool mode the object form `wake_add_rule`'s description showed, since there `behavior` arrives as text;
  - a match field of the wrong type, such as `tagsAny: "chat:ambient"`, `channel: 12345`, `match: "discord"` or a `filter` whose `type` isn't `text` or `regex`, and an entry of the wrong type, or `""`, in a list, which were dropped, so the rule matched more than it named;
  - a field name that's a slip for one the gate reads at that level: the same ignoring case; one edit away, or more for a long name, a quarter of what follows the part the two names share (`pasthrough`, `keyby`, `polices`); or, at three characters or more, a part of it (`tags`, `interval` for `refillIntervalMs`); or a name holding the whole name of a field its object doesn't give, which is that field under another name (`matchTags` with no `match`, `debounceMs` in a `behavior`), but for gate.json's own fields, where such a name can be a label of the file. Beside the field it holds, such a name does nothing, as before (`channelNote` beside `channel`). A slip was ignored, so the field meant was missing: `pasthrough: true` made a governor consume the events it should let fall through. Each field the name could be a slip for is named (`tags` for `tagsAny`, `tagsAll` or `tagsNone`);
  - a field the gate reads at another level of the rule, such as a match's `tagsAny` beside `name`, or a filter's `pattern` straight in `match`, which was ignored, so the rule matched more than it named. It's named with where the gate reads it: `Policy "quiet": it has "tagsAny", a field of "match", which the gate doesn't read here, so the rule matches every event.`;
  - a `rate_limit` or `passive_sample` `keyBy`, or a `resets`, of the wrong type, which was dropped;
  - a behavior object holding two kinds, of which `debounce`, then `rate_limit`, then `passive_sample` was used, whatever their order.
- `wake_add_rule` and `addGatePolicy` refuse a rule with any problem, naming every one, those of each kind a behavior object holds included, and save nothing, since their caller is there to fix it. `wake_add_rule`'s own parameters are checked the same way: a slip of one is refused, such as `matches` with no `match`, which saved a rule matching every event, and so is a field of `match`, `rateLimit` or `passiveSample` given as a parameter of its own, such as `tagsAny`, which used to be saved without it, naming the parameter it belongs in, and showing it there where it belongs in only one and its value can be shown whole. Any refusal of `wake_add_rule`'s also names each other parameter it doesn't take, which a saved rule's `ignoredFields` names.
- gate.json and the host's starting rules (`FrameworkConfig.gate.config`) are what a deployment already runs, so there a rule with a problem is read the way the gate read it before, and each problem is named in `gate_status`'s `errors` and a `[gate]` log line; the rest of the file loads. A rule that skips or defers is read past its problem the same way, holding back what it held back before, and its note says so: `Read so, it skips every event it now matches, as earlier releases did.` A rule is left out only where the gate refused it before: a rule that isn't an object or has no `name`; a behavior that's a list or holds none of the three kinds; a `rate_limit` or `passive_sample` that isn't an object or lacks `tokens`, `refillIntervalMs` or `every`, or has `tokens` at or under 0; a `debounce`, `tokens`, `refillIntervalMs` or `every` that isn't a finite number; an invalid regular expression in a `filter`; and a `passthrough` that isn't a boolean, or is `true` on a behavior that doesn't count. Under a default that holds events back, `"skip"` or `"defer"`, a gate.json or starting config that leaves out a rule that could wake the agent isn't used, as before, since that would hold back what the rule was written to wake on: a start runs the host's starting rules, or none, which hears every event, and a reload keeps the rules in force. A later start doesn't add starting rules that would leave gate.json unused that way, and says so. So, wherever the gate loaded the file before, no event that woke the agent before goes quiet. An empty entry in `scope`, which only narrows a rule, since no event's type is `""`, is read as written whatever the rule does.
- A number outside the gate's range, which the gate refused whole in gate.json before and ran as given from the starting rules, is read in both with a note, and `wake_add_rule` and `addGatePolicy` refuse each. Read so, no event the starting rules woke the agent on is held back, though a batch can go out later or sooner:
  - a `debounce` under 100 ms is read as 100 ms, so events further apart than the debounce given and closer than 100 ms, each its own batch before, share one: the agent wakes fewer times, and the batch goes out 100 ms after the last of its burst, or later where it's held, as any batch is, while the agent's turn runs;
  - a `debounce` over 300000 ms is read as 300000 ms, so its batch goes out sooner, but for one over 2147483647 ms, the most a timer takes, which Node and Bun 1.4.3 ran after 1 ms: its batch now goes out after five minutes;
  - a `rate_limit` `refillIntervalMs` of 0 refills at once, so the rule limits nothing, where it refilled the bucket once, through a division by 0, and then never; one under 0 is read as never refilling, as it ran, so the rule wakes the agent on its first `tokens` events and none after;
  - a `passive_sample` `every` at or under 0 is read as 1, and a fractional one as its next whole number, as they ran.
- gate.json's own fields are read as the gate read them before, with a note, wherever it loaded the file. One that's a list is read as no rules under the default `"always"`. A slip of `policies`, such as `"polices"`, a name the gate doesn't read, a list of rules parked under one, such as `"disabled"` or `"rules"`, included, a field of a rule at the file's top, such as `"channel"`, and a `policies` that isn't a list each do nothing: a note names each, a slip with what the file's default then does (`gate.json has "polices" (did you mean "policies"?), which the gate doesn't read, and it has no rules, so under its default, "skip", every event is held back.`), and where `policies` writes no rules the file has none, so under `"skip"` or `"defer"` it holds back every event, as it did. A `policies` holding nothing, such as `"policies": {}`, writes no rules, as `[]` does. A change keeps each such name as written and adds a `policies` list beside it, or writes the list in place of a `policies` holding nothing.
- A change through `wake_add_rule`, `wake_remove_rule`, `addGatePolicy` or `removeGatePolicy` edits gate.json's own list of rules by name: every rule it doesn't change is written back as it was written, with its problems and the fields the gate doesn't read, and the rules in force are read from what was written, so what gate.json still holds that the gate reads past or leaves out stays named until someone fixes it. A `"comment"` survives a write now, where a write used to write the rules as the gate held them. A rule a change leaves out of force, or gives another behavior, loses its counters, buckets and timers, as at a reload, so a rule that comes back, or that a change gives another behavior, starts afresh. Its pending debounce batch is then sent as its timer would have sent it, held while an agent is inferring or the host is quiesced, and so it is at a reload, which delivered it at once. A batch whose delivery throws is named in a `[gate]` log line and dropped, and the change or reload goes on as made; so is one its timer sends, or one held for an agent's turn, which before threw uncaught, stopping a host with no handler for that. Rules that share a name share its state, and a change or reload keeps it only where those rules keep their behaviors, in order: a reload compared each with the last of them, so with two rules of a name, a change can reset their state, or keep it where it changed. A rule the gate leaves out can be replaced, or removed, by its name. A gate.json that's JSON the gate doesn't use is edited the same way, and only what loads is written: a change that doesn't mend what keeps it out is refused, naming that and what would bring it into force, and the file stays as its operator wrote it, where a change used to write the rules in force over it, losing its other rules, its own fields and its default; a change that replaces or removes by name the rule keeping it out brings it into force. When gate.json is missing, a change edits the list of the text whose rules are in force the same way, so a rule it leaves out keeps its name there too. A gate.json with no list of rules a change could edit without writing over what it holds (a list, a `policies` that isn't one and holds something, or JSON that isn't an object) refuses a change, an addition or a removal, and saves nothing; a removal there used to answer that no rule had the name, and an addition used to write the rules in force over the file. That refusal, like one over a gate.json that can't be read or isn't JSON, and one at a start that didn't use gate.json, says what the gate runs meanwhile, and what has to change first. A write of gate.json that fails says whether gate.json was changed: one that fails at its open leaves it as it was, and one that fails after may leave it holding the whole change, part of it or nothing. A change over a gate.json the gate doesn't use that would leave it with no rules in force is refused, naming what runs meanwhile, since such a file holds events back by default, so every event would be held back. A removal by a name that isn't a non-empty string, from JavaScript, finds no rule, so it can't remove the rules gate.json holds with no name.
- `gate_status`'s `errors` says what the start did with the host's starting rules, apart from gate.json's load error, until the next start: how it read them, rules it couldn't use, and rules it couldn't add to gate.json. When adding the starting rules to a gate.json that loaded failed, the load that followed cleared the error, so the missing rules went unmentioned. When the start's own write of gate.json fails and leaves the rules in force unsaved, another entry says so until gate.json is written or loads; if that write leaves gate.json unable to load, the gate runs the rules it read and the ones it was adding, where it used to drop them, and that entry names what they hold that the gate reads past or leaves out. The entry for a gate.json that isn't used, or can't be read or isn't JSON, now says what's in force instead: the rules of the last gate.json the gate used, the rules a start read from gate.json and was adding when its write left gate.json unable to load, the host's starting rules, or none. `gate_status`'s `configSource` is `"initial"` while the starting rules are in force, where it said `"default"` while they ran in place of a gate.json that didn't load.
- A `null` is a field left out, and so is `""`, which is named in a note, with what leaving it out does where that's more than no constraint: a `match` left out matches every event, and a `behavior` is `"always"`. In a rule the gate reads, a match left with nothing that narrows it, once something in it was dropped, left out as `""` or unread, matches every event, and a note says so; in a refusal of such a rule, where nothing was saved, the note gives that as the reason its problems matter: read without what's wrong in its match, as earlier releases read it, the rule would match every event. A gate.json holding `"channel": ""`, as `wake_add_rule` could save before, loads as it did, with the field left out. Where the gate refused a rule or a gate.json for a `null` or `""`, in a `passthrough`, a behavior's kind or gate.json's `default`, it now loads without it. A `filter` whose `pattern` is `""` narrows nothing and is left out, with a note. For `wake_add_rule`, a `null` or `""` parameter is left out too, so a call whose only behavior is `null` is refused as one with none, where it was saved as `"always"`. A field name the gate reads nowhere that's no slip, such as `"comment"`, changes nothing, so it loads, and `gate_status`'s `errors` names it with the fields its place holds. `wake_add_rule` leaves it out of the rule it saves and names it in the result's `ignoredFields`, and `addGatePolicy` tells a new `onIgnoredFields` callback, or the log.
- `wake_add_rule` refuses a `position` other than `"append"` or `"prepend"`, and an `insertBefore` or `insertAfter` that isn't a string, which were ignored, so the rule was appended. A refused `behavior` points at `debounceMs`, `rateLimit` and `passiveSample`. Its description's example now gives `debounceMs: 60000` in place of `behavior: { debounce: 60000 }`, which its schema, a string enum, didn't admit.
- **What a deployment will notice:**
  - A gate.json holding a rule the gate refused before now loads, with that rule left out and named, under `"always"`, or where the rule skips, defers or has no tokens. A reload or a start applies its other rules, where a reload kept the rules the gate had and a start ran the host's starting rules, or none. So under `"always"`, a rule after the one left out that skips, defers, rate-limits or samples can now hold back an event those rules woke on, and one that debounces can delay it: that's the case where an event that woke the agent before can go quiet.
  - A rule that skips or defers, with a problem the gate read past before, is read as before, holding back every event it then matched, and now says so.
  - A starting rule with a `debounce` under 100 ms or over 300000 ms, or a `refillIntervalMs` of 0, runs as read above, where it ran as given: a burst under a short debounce wakes the agent fewer times, a debounce over 2147483647 ms waits five minutes where it ran after 1 ms, and a refill interval of 0 no longer stops the rule after its one refill.
  - A batch a timer or an agent's turn sends, whose delivery throws, as `addMessage` does with no agent configured, is named in the log and dropped, where it was thrown uncaught.
  - `wake_add_rule` and `addGatePolicy` refuse a rule holding a field at another level than its own, and `wake_add_rule` a field of `match`, `rateLimit` or `passiveSample` given on its own; such a rule used to be saved without it. A gate.json written with such a field loads as before, with the field named.
  - A starting rule the gate refused before is named at start. One used to make the gate run all of the starting rules as given, from memory, so these ran and woke the agent: a `rate_limit` without `refillIntervalMs`, a `debounce` given as text such as `"60000"`, a `passthrough` that isn't a boolean, which ran as its truthiness, `passthrough: true` on `"always"`, and a rule with no `name` that wakes, such as on `"always"`. Now, under a starting default of `"always"`, such a rule is left out and the rest run; under `"skip"` or `"defer"`, none of the starting rules is used, and the start runs gate.json's rules, or none, which hears every event. connectome-host's recipes hold none of them.
  - A first start writes the host's starting rules to gate.json as given, a rule left out included, as before, and runs each as read, but writes none the gate refuses whole, and then starts with no rules, as a host without them does; gate.json, read the same way, names each problem at every load until someone fixes it. A later start adds, as given, the starting rules whose names gate.json lacks; a rule gate.json holds keeps its name even where the gate leaves it out, so the host's rule of that name doesn't replace the operator's. Where gate.json has no list of rules to add them to, a list or a `policies` that isn't one and holds something, a later start writes nothing over it and runs them under gate.json's default, unsaved, until gate.json changes and loads, and `gate_status` says so, with `configSource` `"initial"`, where it used to write them over the file, losing what it held. Where gate.json has no rules of its own, with no list, an empty one or one holding only rules the gate leaves out, and, under its default, one of the starting rules that could wake the agent can't be put in force, left out, with no name, or kept out by a rule of gate.json's of its name that the gate leaves out, or they're refused whole and that default holds events back, gate.json isn't used at that start, which runs as one without it does: the starting rules under their own default, as earlier releases ran them once what they wrote over it or into it wouldn't load, or once they refused gate.json's rule, or no rules where the starting rules are refused whole. `gate_status` names the rule left out and the way back, and a change through the gate is refused until gate.json changes.
  - A rule a slip already saved in a valid form, such as `"always"` saved from a typo or `match: {}` from a dropped field, loads as it was saved, since the slip is no longer in it.

- A tool result's content array with a block agent-framework couldn't show, such as inline audio, an image with no media type or no data, or a block of a type it doesn't know, was stored, and sent to the model, as the whole array's JSON. Inline data's base64 went into the agent's context and history, and so did a block's uri, and an image beside it went as base64 text instead of an image. Each block now shows on its own, in the stored copy and the one the model reads alike: as itself, as a reference's stub, or as a marker saying what it was and why it isn't shown. Beside an image, the model reads them as blocks while the result's links and markers fit its inline cap together, and past that it reads the stored text, cut at the cap. Inline audio reads `[Audio not shown: this host's tool results carry only text and images (<type>, <size>).]`, and the other blocks read the markers the push lane shows for them. An MCPL tool's result is content whatever its blocks' types. Any other array, such as a module's that doesn't set `dataIsContent`, is content only when every element is a block of one of MCP's types (text, image, audio, resource, resource_link). Any other array is data, written as JSON as before. Results stored before the upgrade keep the text they were stored with.
- MCP's `resource_link` is a reference (RFC-005 §8.1): its `uri`, `name`, `mimeType` and `size` (as `sizeBytes`) make its record, with no disposition. On every lane, a link `fetch_reference` can fetch shows as a reference's stub, with its name, type and size. In a tool result, whose JSON showed every link's uri, one it can't fetch shows as `[resource link "<name>": <uri>, <type>; not fetched]`, keeping the uri, the agent's only handle on it, as a standard MCP server's link shows. That holds at any depth in a tool result's data too, where a link's fields were written as data, and a link whose uri is empty, null or not a string is the marker that says so. A link that names no uri at all is the marker as a block of a content array the model reads, and at depth, or in a script's view of a module's result, stays data, as before, since its fields hold no uri this reads. That covers a uri that isn't http(s), one off its server's origin, one from a server with no address, and a link no server delivered. Where the uri may carry a credential, the link shows a stub instead (under Changed), and so does a link whose uri is a `data:` uri, which holds its content rather than naming where it lies. On every other lane, a link that can't be fetched shows the stub that says why it can't be fetched, with no uri, where the push lane showed an unknown-block marker. A link is registered with the server that sent it, but it's never fetched eagerly or on a script's demand: a uri a link names is fetched only when a block of the result that isn't a link names it too. A link's claims never replace a reference's in the registry, so a later link to a uri can't lift its expiry or its digest check.
- A reference's stub now offers `fetch_reference` only where a fetch can reach the reference through a server that delivered it and the reference hasn't expired, as the servers' configs have it. Where two frameworks in one process configure one server id at different urls, a stub reads the address recorded most recently by a framework that hasn't since removed the server or stopped. A framework records its servers' addresses as it configures them and again as it starts. Otherwise it ends with why `fetch_reference` would refuse, without what calling again can do. The stub reads an expiry from the references in its result where they name its uri, and the fetch from the reference as the host last recorded it, so where one result names a uri both expired and fresh, the stub says it's expired while a fetch can succeed. A fetch's own limits, a spent budget or a claim over its ceiling, still apply when it's made. That covers a server with no address, such as a stdio one, a server the host doesn't know, one whose address doesn't parse, a uri off its server's origin, one with a user name or password, or a scheme the fetcher doesn't fetch. A third-party origin and a refused scheme are described there without naming the origins or the scheme. Before, the stub offered the fetch for any reference a server delivered. A server's id in a stub, or in `fetch_reference`'s refusal, is bounded and stripped of controls, as a label is, and so is a scheme in that refusal.
- A label in a stub (a name, a type, a server's id, a provenance or a saved path) loses any line or paragraph separator (U+2028, U+2029), as it loses control characters.
- A script's demand fetch of a reference not yet fetched reads that reference's own digest and expiry, where it read whatever an earlier reference to the same uri had claimed.
- Inline data beside an empty `uri` is shown as any inline data is, on every lane, where it was withheld as data that also claimed a link.
- On the tool-result lane, an image whose data or media type is an empty string shows its marker, as on the push lane, where it was sent to the model as an image with that field empty.

- A wake-rule change no longer destroys a gate.json that won't load. `wake_add_rule` and `wake_remove_rule` (and `addGatePolicy` and `removeGatePolicy`) started from the rules in force when gate.json was there but wasn't JSON or held a policy the gate refused, and they wrote those rules straight over the file, so whatever it held, such as an operator's unfinished edit, was lost. A gate.json that holds a policy the gate refuses is now edited in place instead, with that policy kept as written. A change over one that isn't JSON, or that the gate can't read at all, such as one it lacks permission for, is refused, naming why and what the gate runs meanwhile, and nothing is written over it, so what it holds stays as it is, until it's JSON the gate can read.
- The gate's files are reloaded when their text changes. At most once a second, gate.json is read again and applied when its text differs from the text whose rules are in force, and the privileged-users file is read again and loaded when its text differs from the text last read. A gate.json that holds the text in force again after failing to load, as after a `chmod` that makes it readable, has its error cleared, and nothing is applied again. gate.json's reload compared only its mtime, so two writes in one clock tick, a write between its read and its stat, or a read that only looked (`getGatePolicyNames`, or a change that wrote nothing) left a new gate.json unapplied until it next changed, and a `chmod` that made it readable again wasn't noticed. `isPrivilegedUser`, which tune-out's wake classification calls for each diverted message, read and parsed the privileged-users file on every call, and while it couldn't be read each call added another copy of its error to `gate_status`'s `errors`. A clock stepped backwards now makes the next check run, rather than holding off both reloads until the clock catches up. A missing file is told apart from one that's there but can't be reached, such as behind a directory the process can't search: only a missing gate.json keeps the rules in force without an error, and only a missing privileged-users file means no one is privileged.
- A privileged-users file loads entry by entry. An entry of its list that's a non-empty string, or a safe integer (a whole number within 2^53 - 1 of zero), is a user id. Any other entry is skipped and named in the file's error, including a number too large for JSON to read exactly, whose rounded value could be another user's id. A file that isn't JSON, or isn't a list or `{"userIds": [...]}`, is that file's error, and the list that last loaded stays in effect, as for a file that can't be read (at startup, that's no one). Such a file used to load as no one privileged, without a word, and an entry that wasn't an id was loaded as text. An empty author id is never privileged, while the agent sleeps as for tune-out.
- `gate_status` reads both files again, at most once a second, before it answers, and its `errors` holds each problem once: gate.json's, what the start did with the host's starting rules, and the privileged-users file's. A gate.json load no longer clears the start's notice, which stays until the next start, or the privileged-users file's error, and a privileged-users file that loads again, or is removed, clears its own. The starting rules the start couldn't save stay named until gate.json holds what's in force, as it does once it loads or a change is written. When gate.json's error changes, a `[gate]` log line says it couldn't be read and why, and the `gate:config-error` trace is emitted, not at every read that fails the same way. A gate.json that stopped loading used to reach only the trace.
- `wake_remove_rule` and `removeGatePolicy` clear the removed rule's state (delivering its pending debounce batch, and dropping its rate-limit and sampling counters) only once gate.json is written. A write that failed used to leave the rule in force with its state already cleared.

## 0.26.2 — 2026-10-24

### Fixed

- A turn whose call failed into a provider hold (a provider's stated wait, a
  host's `providerHold`, or an organization-acceleration cooldown), or whose
  compile a conversation agent's recorded wait held with nothing sent, now
  counts as alive until the hold releases its retry, and so does a turn
  whose error-policy retry a provider wait holds at the last admission
  boundary before it starts (a conversation agent's own compression can
  record one during the policy's delay). The host used to report it
  `drained`, and a rollback, suppression or branch switch went through,
  after which the retry ran on the rewound store, answering again on history
  rewound under it. Now:
  - `getHostModeStatus()` lists the agent in `activeTurnAgents` and counts it
    in `activeTurns`, and `drained` reads `false`;
  - a rollback, suppression or branch switch refuses as `agent-busy`, naming
    the hold, its end (or `until released`) and its reason, and how to go on
    sooner: a quiesce with `abandon: true`, or, where a stated wait holds the
    turn, `release-provider-wait`;
  - a quiesce waits for the turn, up to its `timeoutMs` (at least 1 s),
    where it used to report drained at once, and lets the retry start when
    the hold ends and finish; wakes that arrive meanwhile park, as for any
    turn alive;
  - a quiesce with `abandon: true` (once its wait for the drain runs out, or
    at once on a host already quiesced), `stop()`, the inference policy, the
    agent's removal or a conversation agent's disposal drops the retry, and
    the turn ends with one `inference:aborted`, as a turn whose continuation
    is dropped does;
  - a closing conversation agent isn't disposed while a hold keeps its
    turn's retry, nor while a continuation of its turn (a budget restart or
    a tool-result guard's retry) waits in a hold, a park or a scheduler pass;
  - once `stop()` has closed admission, a failure reported then installs no
    hold, so no retry outlives the stop, and the turn ends with an
    `inference:aborted` after its `inference:failed`, as a retry a stop
    cancels does;
  - a puppet tool call is refused while the retry waits, as during any live
    turn, naming the hold and how to go on sooner;
  - `abortInference()` ends the turn, and a turn whose budget restart or
    tool-result guard's retry waits held or parked, where it reported
    nothing to stop and the turn ran once the hold ended: one
    `inference:aborted` with the stop's reason, and it returns `true`. Wakes
    that arrived meanwhile still run: those the hold keeps beside the retry,
    and those merged into the retry's or the continuation's start before it
    began, which the stop puts back in the queue. A hold of such wakes alone
    still has nothing to stop. From a listener of a failed stream's
    `inference:failed` it reports `false`, as before (a turn's start that
    fails still takes a listener's stop at its own check): every failure
    site now reports `inference:failed` before a hold takes the turn's
    retry, where a stream that throws, and the hold a conversation agent's
    compile meets, used to hold it first;
  - a quiesce with `abandon: true` puts back the wakes merged into a held
    retry's or a continuation's start that hadn't begun, as a caller's stop
    through `abortInference()` does: they park under the quiesce and run at
    resume. Under a quiesce, a held retry starts alone, and the wakes merged
    into its start before the quiesce park until resume. An abandon of a budget
    restart's start merged with other wakes used to drop those wakes with
    it, so their messages went unanswered until something else woke the
    agent.

  A wake a hold keeps at admission, with no turn of its own begun, keeps no
  turn alive, as before.

- What an MCPL peer's content block carries in its other fields now
  reaches a script with RFC-005's treatment at any depth, as the block
  itself does: an RFC-005 reference there arrives as its stub's facts,
  bound to that server and not fetched for the script (its `savedTo` is
  null unless an earlier fetch saved that URI), one the classifier
  rejects as its notice, and inline data that also claims a URI of any
  type, an empty one included, or a disposition, as the withheld notice.
  Before, such fields reached a script whole, references' URIs included.
  `structuredContent` still reaches a script whole, from every tool, in
  any result that can be converted to JSON.

## 0.26.1 — 2026-10-23

### Added

- `HostModeStatus.activeTurnAgents` lists, sorted, the agents with a turn
  alive, the ones `activeTurns` counts: each from its turn's dequeue to its
  settled teardown, so a turn in its hooks or compile, one finishing its
  deliveries, or one whose continuation is on its way to its start, is
  listed. So a host can record which agents are mid-turn before it abandons
  their turns or stops.

### Changed

- `stop()` ends a turn whose continuation hasn't started, as `shutdown`,
  with the continuation dropped.
- A budget restart's `inference:stream_restarted`, and its boundary's usage
  report, now come after its continuation is queued and its stream
  cancelled.
  A restart boundary reached while the framework is stopping emits no
  `inference:stream_restarted` and queues no continuation: the turn ends as
  `shutdown`.

### Fixed

- A coalesced `push/event` or `channels/incoming` message whose receipt the
  host couldn't write is no longer admitted again when the producer retries.
  The failed write was answered "host could not persist the acceptance; retry"
  after the occurrence's effects were in, and no receipt was kept. So each
  retry was a fresh admission: a copy the agent had read arrived again, a
  deferred notice rendered again, a deletion notice was appended again, and the
  answer named the occurrence's own eventId as `priorEventId`. Now the receipt
  is kept. A retry writes it again and makes it durable, then answers the first
  result without repeating an effect, as RFC-006 §3.1 has a coalescing host
  do. While the write keeps failing, each retry gets the same answer and
  repeats nothing. A host killed before a later save and commit carried the
  receipt still admits the retry as a new occurrence.
- On `channels/incoming`, a coalesced message admitted whose receipt couldn't
  be written or made durable was answered `accepted: false`, which says it
  wasn't admitted, so a producer could hold it as never delivered. The request
  is now answered with a -32000 error carrying the same message, since a
  per-message result can only say a message was taken or wasn't, and the
  messages after it in the request aren't admitted until they're sent again.
  An uncoalesced message before it in the same request is admitted again when
  the request is sent again. A retry of an admitted message while the host is
  stopping fails the request the same way. A failure before any effect, such
  as "host is stopping" for a new message, is still a per-message refusal.
- A save of the coalescing state that fails is kept for the next save or the
  host's stop, instead of being dropped until the state next changes.

- A module's blocks in a script's `content` now get the treatment the
  model's lanes give a module's result, as an MCPL peer's already did,
  since what a script prints comes back to the model. Such blocks include
  an MCPL peer's result that a module got through `ctx.callTool` and
  returns whole. An RFC-005 reference anywhere in them, a `disposition:
  "never"` one included, arrives without its URI, as the stub's facts an
  MCPL peer's reference arrives as (`refId`, the labels the block gave,
  `savedTo`). Inline data that also claims a URI, of any type, or a
  disposition arrives as the withheld notice; a null or absent URI is
  none, and in a module's result so is an empty one, as the model's
  history reads it. A reference the classifier
  rejects arrives as its notice; that includes an MCP-form embedded
  resource, whose URI sits under `resource`, which the model's history
  shows the same way, so a script no longer gets its text. Anything else
  arrives as the module returned it. Before, a module's structured result
  reached a script with its blocks as the module returned them,
  references' URIs included. Which results are a module's is decided by
  where the dispatch sent the call, not by the tool's name. An MCPL
  peer's inline data beside a URI that isn't a string, such as an object,
  now also reaches a script as the withheld notice. `structuredContent`
  still reaches a script whole, from every tool, and so do fields a server
  puts outside its content blocks' reference positions.

- A turn whose continuation (a budget restart's, or a tool-result guard's
  retry) is waiting to start now counts as alive. Between the turn's stream
  ending and the continuation's start, a stretch that a provider wait stated
  meanwhile makes as long as the wait, the host used to report `drained`, a
  `quiesce()` returned drained and the continuation then started while the
  host was quiesced, and `quiesce({ abandon: true })` found nothing to end.
  Now `activeTurnAgents` lists the agent, a `quiesce()` waits for the
  continuation's turn, and an abandon ends the turn with the continuation
  dropped. A puppet tool call and a branch switch are refused in that
  stretch, as during any live turn.
- A turn whose continuation is dropped by an abandon, `stop()`, the
  inference policy, the agent's removal or a conversation agent's disposal
  now ends, with one `inference:aborted`. A drop other than an abandon or a
  stop also releases the EventGate window held for the continuation,
  closes the turn's logical turn and withholds the tool-result guard's
  pending batch from later requests, as for a turn that ends before it
  sends anything. A provider hold left empty by the drop releases without
  queueing a retry turn. An ephemeral run that ends takes such a
  continuation with it, its own end having ended the turn.

## 0.26.0 — 2026-10-23

### Breaking

- **Hosts:** agent-framework now requires `@animalabs/membrane` ^0.7.1 (was
  ^0.6.1) and `@animalabs/context-manager` ^0.20.0 (was ^0.19.0), which
  admit no membrane 0.6.x. A host whose own membrane range is still ^0.6 gets
  two membrane copies, and an error one copy builds isn't an instance of the
  other's `MembraneError`, which the framework's error policy reads.
  **Migration:** move the host to membrane ^0.7.1 with this release
  (connectome-host 0.13.0 does). The framework calls through the `Membrane`
  its host passes in, so membrane 0.7's retry changes reach its turns through
  the host's retry config: since 0.7, membrane also retries on
  `streamYielding()`, the turn path, inside each of the framework's own
  attempts, and the framework's error policy retries above it as before.
  **Unchanged:** the framework's error policy and what it does with a
  failure that reaches it.

### Fixed

- A cut tool result's spill notice now survives every reader's per-message
  cut while the turn, each result at its least, fits the bound, unless a
  mount name past about seventy characters makes the notice longer than its
  room, or results' notices differ in length (by call ids of different
  lengths) and the turn passes the bound by that difference. Under a turn's
  share of the bound, a result is at its least whole where it's no longer
  than what its cut would store in its place, and otherwise as its notice
  alone. 0.24.1 said the notice survived until a turn's notices alone filled
  the bound, which wasn't true for a notice longer than its share: results
  stored within their shares could leave it no room, and a result just past
  its share was stored as a notice longer than the result. Now, in a turn
  stored by its share, such a result is stored whole, and save_recent_image
  counts the image slots it holds. A turn whose results fit the bound
  together is stored as before, unless a save_recent_image in it had it
  stored by its share only because such a result's slots differed: it's now
  stored as each result would be alone, as other turns that fit are.
- A spill notice's paging advice in a turn stored by its share is sized to
  the inline cap that a later read of the file comes back under, alone in
  its own turn, rather than to the share. Under a share below the notice's
  room, the advice was to read one character at a time.

## 0.25.0 — 2026-10-22

### Breaking

- **Agents, and whoever writes their prompts, where a mount holds a
  directory named like the mount itself:** a `workspace--glob` pattern, or a
  `workspace--grep` `glob` filter, whose first segment is that mount's name
  is now read mount-prefixed in that mount, from its root and within
  `path`, and no longer as written there. So a pattern written relative to
  the mount, such as `work/z/*.ts` for the file the tools show as
  `work/work/z/a.ts`, no longer finds that file. With a `path`, the same
  goes for such a directory anywhere beneath it: `glob` with `path:
  "notes/diary"` and `pattern: "notes/*.md"`, written relative to the path
  for `notes/diary/notes/x.md`, no longer finds it. Where nothing else
  matches, the agent gets an answer with no matches (`glob`'s
  `"matches": []`, `grep`'s `"results": []`), not an error.
  - **Migration:** write the path as the tools show it: `work/work/z/*.ts`
    finds `work/work/z/a.ts`, and `notes/diary/notes/*.md` finds
    `notes/diary/notes/x.md`, with that `path` or without one.
  - **Unchanged:** in every other mount, and for a pattern whose first
    segment names no mount, the pattern is still matched relative to the
    mount (or to `path`).

- **Script authors (`code_execution`):** a tool's text result now reaches a
  script as that text, in its result's `content[0].text`, where it was the
  text JSON-encoded. That covers every MCP tool whose result is text only,
  and every module tool whose `data` is a string, without structured
  content. A script saved before the upgrade meets the change too. Drop a
  `JSON.parse` that only unquoted such a result. Where the text is itself
  JSON, one `JSON.parse` now returns the data, so drop the second. A script
  that read every result with `JSON.parse` can parse inside a `try` and
  keep the text when it throws; a string whose text is itself JSON, such as
  the text `123` or `true`, then reads as the value it spells. A result
  whose data isn't a string, and a result with structured content, reach a
  script as before.

### Changed

- Requires `@animalabs/context-manager` ^0.19.0 (was ^0.18.0) and
  `@animalabs/membrane` ^0.6.1 (was ^0.6.0). context-manager 0.19.0 stores a
  lone UTF-16 surrogate half in edits and state writes as U+FFFD, where it
  left state the store couldn't read back, and fixes image-strip pricing;
  its subclass-facing breaking changes are in its own notes. membrane 0.6.1
  runs complete tool calls a provider returns under `stop_reason: end_turn`,
  where 0.6.0 ended the turn without running them.

- A tool result whose `data` is a string now reaches the model as that text.
  It was JSON-encoded on the way, quoted with every newline, tab and quote
  escaped, so a multi-line answer, such as a module tool's line-per-item
  listing, arrived as one escaped line: in context, on the live wire, and in
  its spill file under `tool-results/`, which `workspace--read` could then
  page only by character and `workspace--grep` matched as a single line. A
  spill file now holds the string as the tool returned it. Data that isn't a
  string reaches the model as before.

  Results stored before the upgrade keep the quoted text they were stored
  with, so a conversation shows both forms until its older results leave
  its context. A string is measured as its own text, so one whose JSON form
  went over the inline cap while its text doesn't, such as a long listing
  of short lines, now stays inline where it used to spill to a file. A lone
  UTF-16 surrogate in the string, which JSON escaped, reads as U+FFFD. For
  a result without an error, `data: ''` reads as an empty result, as
  `data: undefined` already did.

### Fixed

- A tool presentation file holding `{}`, an object with no keys, is read as the empty document, as a missing presentation file already is. A description defaults file holding `{}` is read as one too, where a missing defaults file is still reported. Before, `{}` was refused for its missing `"version"` and `"tools"`, so every `set_tool_visibility` and `set_tool_description` call refused and the resident was told to ask whoever runs the host to repair the file, though `{}` is what an operator writes by hand to start one. A 0-byte file, and a document with only one of the two keys, are still refused. `parsePresentation('{}')` returns the empty document too, where it threw.

- `workspace--glob` finds files from a mount-prefixed pattern, such as
  `notes/diary/2026-10-13.md` or `project/src/**/*.ts`, as every other
  workspace path is written and as its own results are returned. The pattern
  was matched only against paths relative to the mount (or to `path`), so a
  mount-prefixed one answered "no matches" for files that were there. When a
  pattern's first segment names a mount, that mount now matches its rest from
  the mount's root, in place of the pattern as written. Every other mount
  still matches the pattern relative to the mount (or to `path`), so
  `notes/*.md` still finds `project/notes/todo.md` beside the `notes` mount's
  own files. In a mount holding a directory named like itself, this narrows
  what a pattern written relative to the mount finds (see Breaking).
  `workspace--grep`'s `glob` filter takes a mount-prefixed pattern the same
  way. In both, a `**/` at the start of a path segment now matches zero or
  more directories, as in other glob tools, so `project/src/**/*.ts` also finds `project/src/main.ts` and
  `**/*.md` also finds the `.md` files at a mount's root; it used to need at
  least one directory there. After a brace group whose alternatives each end a
  directory, a `**/` matches zero or more directories, and so does a `**`
  that ends an alternative before a `/`, so `{src/,lib/}**/*.ts` and
  `{src/**,lib}/*.ts` find `src/main.ts`, as `src/**/*.ts` does. `glob`'s description and its `pattern`
  parameter's description changed, and so did `grep`'s `glob` parameter's
  description, so the first request after the upgrade that carries the
  workspace's tools misses the prompt cache from its tool block on.

- **The prose bounce-wake cap no longer latches.** A bounce wakes the resident
  so it can resend, at most twice in a row, so a bounce → wake → bounce loop
  ends. The count reset only when a prose envelope was delivered, so a
  resident that recovered from bounces another way (a send tool, setting the
  draft aside) kept the count across turns: from its third bounce on, a reply
  to a fresh message bounced with no wake, and sat unseen until something
  else woke the resident. The count now also resets when a turn starts with a
  cause of its own (a channel message, a server event, a gate flush, a timer,
  an operator nudge), in explicit and hybrid modes. A loop of bounce wakes
  with no other cause is still capped at two.

- What reaches a request without passing through the context store now carries a lone UTF-16 surrogate as U+FFFD, as the store keeps it (#695). That's a context injection's text and namespace, a hook's or a module's, and what a tool boundary injects into the live round: the messages it heard, with their senders' names, and its own notices. Before, every request an injection was in carried the lone half raw, and the API refuses such a request with a 400 ("The request body is not valid JSON: unexpected end of hex escape"). A namespace is still compared with channel ids as given when an injection is kept to its channel's conversation.

- A lone UTF-16 surrogate in a tool result's text now reaches membrane as U+FFFD, as the context stores it (#695). Before, a text block's text, a reference's stub (from its `name`), an error result's text and the error text of a failure the tool doesn't flag went to membrane with the lone half raw, while the stored copy held U+FFFD. With the tool-result guard on (`toolResultGuard`), such a result left a stored message the context couldn't read back; with a text block or an error result, the agent's next turn sent no request and `stop()` threw. This change doesn't repair a store that already holds such a message.

## 0.24.1 — 2026-10-22

### Added

- **Clock rows** (`AgentConfig.clock`, off by default): with
  `clock: { intervalMinutes: 10 }` (or `intervalSeconds`, and `precision:
  'minutes' | 'seconds'`), an agent's window takes a `Clock: 10:50
  Europe/Berlin (UTC+02:00)` row whenever a boundary of that interval on its
  local wall clock (from local midnight, in the framework's `timeZone`) has
  passed since its last clock: before an incoming event, at a fresh turn's
  start (a silent heartbeat tick included), and mid-turn after a tool
  round's results, where it also joins the live stream as an injected
  message (not on a stream that can't carry injected messages, such as
  membrane's XML prefill path: there the next event or turn start writes
  it). Only the latest boundary is written, and a window that holds no
  clock row yet, a conversation fork's seeded one included, takes one at the
  next of these. A clock reads the boundary's time where that tick would have
  stood, else the time it is written (after a tool round or a reply that
  spanned the boundary), so it never reads earlier than a row before it; it
  shows the weekday and date when the day has changed since the last clock.
  Clock rows are `system: true`, `kind: 'clock'`, with `metadata.clock: {
  at, onBoundary, zone }`; they wake no one, move no routing locus and clear
  no send suppression. None is written while the host is quiesced, or into
  the residents' shared slot while another of its readers has a turn alive.
  Residents share one window, so every resident reads the clock rows any of
  them writes, one with no `clock` of its own included; each writes one when
  a boundary of its own interval has passed since the window's last clock.
  The subconscious takes none of its own. On some models a clock after a
  tool's results drops the loop's earlier thinking from the request, as any
  message heard while acting does there, at most once an interval. An
  invalid `clock` setting makes `AgentFramework.create` throw, naming the
  agent. `resolveClockConfig` (the validation `create` runs, for a host
  checking a recipe up front), `CLOCK_ROW_KIND` and the `ClockConfig` /
  `ClockStamp` / `ResolvedClockConfig` types are exported.

### Changed

- The workspace's `edit` and `edit_many` refuse a file the workspace holds
  when the check of disk before them decided nothing, because the selected
  branch kept changing while it ran. They store nothing, and say so, with
  that reason and to make the same call again. Before, they applied to the
  workspace's copy without a word, so where disk had changed they edited
  text disk had moved past and left the path in conflict, and they committed
  on whichever branch was selected when the check gave up. Where disk's copy
  couldn't be read, an `edit` or `edit_many` still applies to the
  workspace's copy and says so.

- A cut tool result's spill notice, which names the workspace file holding
  the rest, now survives every reader's per-message cut until a turn's
  notices alone fill the bound, or a mount name past about seventy
  characters makes the notice longer than its room. Past six results at a
  bound of 4,000, or 62 at 40,000, a turn's share is under the notice's
  room, so each result longer than its share is stored as its notice alone,
  with no head; where a workspace is writable, its file holds the whole
  result. Past about 11 results at 4,000, or 119 at 40,000, the notices
  themselves pass the bound, and the reader's cut takes the later ones. An
  ordinary
  resident's inline cap is at most the smallest per-message bound among the
  agents that read the shared slot, and `agent_settings` get reports a cap
  set by another reader's bound as
  `tool_result_inline_max_chars_clamped_by: "reader-bound"`. Where a cut
  result's stored copy, notice and kept image slots included, would pass
  that bound, its head moves back until it fits, and image slots that still
  don't fit keep the newest. A reader's strategy spends its bound across a
  message, and a turn's results are stored as one message, so where they
  pass the bound together, which used to cut or leave out a later result
  silently, each now takes an equal share of it. A turn whose results fit is
  stored as each result would be alone, unless a `save_recent_image` in it
  counted a result whose kept image slots the share would change: that turn
  is stored by its share, so the images the save counted are the ones
  stored. A withheld turn under a bound, whether or not its results fit,
  cuts each stub's kept fields within its share less the notice's room, so
  every stub's notice and place survive the reader's cut too, under a note
  that now reads
  `[cut: N of these fields' M characters; …]`; under a share of about 640
  characters or less a stub keeps a single character of its fields. The
  notice offers raising the inline cap only where a cap at the bound would
  keep more of the result, and a stored copy that leaves out every image
  slot past its cut says so.

### Fixed

- The workspace's `delete`, `edit` and `edit_many`, and its `readBinary`
  method, no longer answer "File not found" for a path the workspace doesn't
  hold when the check of disk before them decided nothing, because the
  selected branch kept changing while it ran. Each now says that disk
  couldn't be checked, with that reason, and to make the same call again.
  Before, they answered "File not found" even when disk held the file
  (#552). `readBinary` also gives `delete`'s answer for every other path the
  workspace doesn't hold, such as one whose disk copy couldn't be read, where
  it said "File not found" whatever the reason.

- `channel_close` refuses a channel that's tuned out, as `channel_open` and
  `channel_decline` do, and says to cancel the tune-out with `tune_out` mode
  "cancel", which delivers what it diverted (#633). The channel can be closed
  after that. Until now the close answered success and ended the tune-out
  without its cancel, so its diverted backlog never reached the agent, and a
  later cancel found nothing to cancel. A module's close, such as one that
  certifies an idle lease (`overrideExplicitOpen`), is refused the same way,
  with `isError: false` and `data.refusal` `'tuned-out'`, so it can stand
  down as it does on the explicit-open refusal. A close that a tune-out
  overtook now answers in the refusal's words, and a decline that one
  overtook says to cancel the tune-out before calling `channel_close`.
  Before, both said to call `channel_close`, which now refuses it.
- A tune-out on record where the host has no tune-out coordinator, at a
  start with no subconscious or when a start with no servers connects its
  first one, now ends as the channels come up, and its channel is decided
  open again, as a cancel leaves it, still the agent's decision. A log line
  names the channel and says how many of the messages the tune-out diverted
  are held, which nothing will deliver as its backlog. Before, nothing
  diverted the channel's traffic or could cancel the tune-out, `tune_out`
  wasn't offered, and `channel_open`, `channel_decline` and now
  `channel_close` refused the channel, so its decision couldn't change.

- A modern MCP server whose `requestTimeoutMs` is a value `String()` can't
  print, such as `{"toString": 1}`, which a JSON configuration can hold, is
  now refused like any other wrong deadline, with the value shown as
  `[a value that cannot be printed]`. Before, checking the configuration
  threw a `TypeError` instead: connecting to the server failed with that
  error's text, and `listMcplServers` threw rather than list any server.

- A message that arrives during a turn's tool call is injected into the
  live stream as the next compile would send it, where it was injected
  whole. The agent's strategy renders the boundary's messages as the newest
  of its window (context-manager's `renderAsNewest`): cut by the
  per-message cap, a sharded body joined, and its images as the image
  limits leave them, counted newest-first across the batch. So the next
  turn's request matches what the live rounds carried, and its prompt cache
  holds, where a message over `maxMessageTokens`, or with more images than
  `maxLiveImages`, made the next request differ there. A message that
  arrives later can still take an injected one past an image limit, as it
  can any message. A message the next compile won't send among its newest,
  such as one in a batch bigger than the memory strategy's recent window,
  isn't injected, and a log line names it. In its place a stored system
  line after the batch, `[not shown]`, tells the agent who sent it, its
  size in characters and images, and the `history--extract` call that reads
  it, or its id where the agent isn't shown that tool. It names the agent
  it's for, since residents sharing a slot read it too. Where that boundary
  marks what it stored as read, the message counts as read with it, so a
  coalesced render's wake to read it is dropped and a release doesn't pass
  it to the primary. A strategy without `renderAsNewest`, or a render that
  throws, which is logged, gets the message as stored, as before.

## 0.24.0 — 2026-10-22

### Breaking

- **Agents with `code_execution`, and whoever writes their prompts:** scripts are JavaScript now, not Python, and each runs in a process of its own, in QuickJS compiled to WebAssembly, on the host's own runtime (Node or Bun). A script reaches nothing but its agent's tools: no network, files, timers, packages or environment.
  - **Calling tools:** by exact name, `await tools["workspace--read"]({ path: "work/notes.md" })`, one argument, an object. The mangled Python names (`workspace__read`) are gone. `ALL_TOOLS` lists each tool's name, description and `inputSchema`. A name that isn't one of the agent's tools throws at once in the script, naming close matches, and nothing is sent. At most 16 of a script's calls are out at once: one past them waits until an earlier one's answer has reached the script, and is never refused, so a `Promise.all` over many calls is paced rather than refused. Calls that timed out count against the 16 the host holds until their tools end, so a call made while 16 of those still run waits, and one that waits past its timeout gets a `TimeoutError` saying it was never sent. A call whose tool gives no result within `toolCallTimeoutMs` and 30 s more, which the host stops waiting for then, keeps its place until the script ends, since its tool may still be running. A call's arguments may be up to 4 MiB of JSON holding at most 100,000 values: past either, the call throws `ArgumentsTooLarge`, and nothing is sent.
  - **Results:** every tool answers one shape, `{ content, structuredContent, isError }`: `content` is what the model would read (a structured result's blocks, otherwise one text block), `structuredContent` the tool's own structured content or `null`, and `isError` true when the tool failed. A structured result's blocks are as its tool sent them, so images survive. A call refused before its tool ran (`ToolResult.refused`) throws an `Error` instead, `ToolRefused`, and nothing was done. A result that can't be converted to JSON, such as a cyclic object from an in-process module, comes as a failure in the same shape, its text naming the tool and saying the call completed. Before, a script got a string, the tool's text or `Error: …` for a failure, carrying `.is_error` and `.structured`, and a result with structured content got `{ content, structuredContent, isError, error? }`, with a failure's text in `error`.
  - **`code_execution`'s own result** is an error (`isError`) when its script failed, crashed or was stopped at its limit, or the call was refused, with the text the model reads as its `error`; otherwise that text is its `data`, as a list of one text block. It carries no `structured`. Before, a script's result was a success whatever its `return_code`, and its `data` an object of `stdout`, `stderr`, `return_code` and, when the call's limit was capped, `time_limit_note`.
  - **One kind of script:** a script runs in its agent's turn; past `yield_time_ms` (default 30 s, at most `maxYieldMs`, 10 min by default) it yields with its output so far and keeps running. Then `{"action": "wait", "script_id": …}` waits again, `{"action": "stop", …}` stops it and `{"action": "list"}` lists the agent's scripts, each with the wakes the host delivered for it. Each return shows the output since the previous one, its first and last 8,000 characters, cut alike to fit the agent's inline cap for tool results where the rest of the return leaves them room. The primary agent may leave a script running past its turn: `wake_agent()` is open to any running script, and a left script that fails, crashes or reaches its limit (24 h) wakes its agent; any other agent's scripts stop when its turn ends. The background log file is gone, its place taken by each return's output.
  - **Refused inputs, each naming its replacement:** `background` (every script can yield and keep running), `time_limit_ms` (`yield_time_ms`) and the `cancel` action (`stop`).
  - **Nothing is kept between scripts:** each starts fresh, so globals no longer persist until an idle reclaim. A script writes what must last with a tool.
  - **Large results:** a result too large for the script's memory (past a third of it, or one that doesn't fit when it's parsed), or nested more than 2,000 deep, isn't passed to the script: the call's `ResultTooLarge` error says the tool ran, and a refusal the script can't take stays a refusal, with its start. Any other result reaches the script whole. Before, a text result was cut at 5,000,000 characters, and a structured one past that length was saved to the workspace, the script getting `{ isError, oversized: { chars, savedTo } }` in its place, or, when it couldn't be saved, a failure saying the tool may have completed.
  - **Unchanged:** a script's calls go through the ordinary dispatcher as its agent's, with its allowlist and every gate; intermediate results stay out of the model's context; a call's `endTurn` ends the turn at the `code_execution` result watching the script; `wake_agent()` keeps its spacing and cap; RFC-007 observers see a script's calls as before.
  - **Wakes:** a `wake_agent()` still waiting for its spacing when its script ends is dropped, however the script ended. Before, only a cancel dropped it, and a script that finished or died still woke its agent after the wait, saying it was still running. New: a wake's payload may be up to 64 KiB of JSON, and past it `wake_agent()` throws `WakeRefused`, with nothing sent.
- **Operators with `codeExecution` enabled:** the host no longer needs a Python interpreter. On Bun it needs Bun 1.4.0 or later: `create()` refuses `codeExecution` on an older Bun, since Bun 1.3.14 loses, at some starts, the pipe a script's process answers on, which crashes the script. `create()` refuses each setting the Python runner took, naming what to do: `pythonPath`, `idleReclaimMs`, `env` and `inheritEnv` are gone, since a script has no interpreter, nothing to reclaim and no environment, and `scriptTimeoutMs`, `maxScriptTimeoutMs`, `backgroundMaxLifetimeMs` and `maxBackgroundScripts` become `yieldMs`, `maxYieldMs`, `scriptLifetimeMs` and `maxRunningScripts`. New: `maxScriptChildren` (default 16), the script processes a host runs at once, and `memoryMaxBytes` (default 128 MiB, 4 MiB to 2 GiB in 64 KiB pages), each script's budget. A script's process stays within about its runtime's base plus 2.7 times `memoryMaxBytes`, plus what its calls take as they go out, up to about 200 MiB under Node and 410 MiB under Bun, and the host holds at most about 6 times `memoryMaxBytes`, plus 653 MiB, plus 128 KiB for each wake `maxWakesPerScript` allows, for a script, about 1.4 GiB at the defaults, for its 16 calls out at once, timed-out ones whose tools still run included, up to 16 more waiting for those, their answers, the frame from its process being read and its waiting wakes: size a host by both. `toolCallTimeoutMs`, `wakeMinIntervalMs` and `maxWakesPerScript` are unchanged. A connectome-host recipe that sets `codeExecution.pythonPath`, `env`, `scriptTimeoutMs` or `idleReclaimMs` is refused the same way.
  - **What it promises:** `code_execution` adds nothing to what an agent's tools allow, provided the host runtime's WebAssembly engine, Bun's or Node's, and our glue are right. It claims no containment beyond that.
- **Library users:** `PyRunner`, `buildInjectedTools`, `PYTHON_RUNTIME_SOURCE` and the types `InjectedTool`, `ExecResult`, `PyRunnerOptions`, `ScriptToolCallHandler` and `ScriptToolResult` are no longer exported. `CodeExecutionConfig` has the new keys, and `buildCodeExecutionToolDefinition()` takes them, as `create()` does, where it took the Python runner's options. `HostModeStatus.backgroundScripts` counts scripts left running after a yield. A script's wake enters the agent's context with `metadata.source` `code-execution-script` (was `background-script`), tagged `script:wake` as before.

- **Hosts that read usage by agent:** every ephemeral agent's usage (`createEphemeralAgent`) now counts in one shared `byAgent` entry, named `ephemeral agents` and marked `ephemeral: true`, instead of an entry under each agent's own name. Each ephemeral agent runs under a new name, and the usage record is rewritten whole after every inference, so an entry per name made every later write bigger for good.
  - **Migration:** a host that looks up a subagent's usage by its name in `getSessionUsage()` no longer finds it there, and reads the entry marked `ephemeral: true` instead, which holds every ephemeral agent's usage together. A host that lists `byAgent`, such as connectome-host's `/usage`, shows one line for all subagents instead of one each. connectome-host's web UI lists that line in its per-agent cost when it carries a cost.
  - **Stored entries:** at the first start after upgrading, the entries a store holds under ephemeral agents' names fold into the shared entry, for good once the record is written again. An entry folds when the store has that name's ephemeral namespace (`subagent/<name>`), unless a persistent agent has the name: a configured agent, the configured subconscious, or one with a resident's or a conversation agent's namespace (`agents/<name>`, `conversations/<name>`).
  - **Costs in two currencies:** once inferences priced in two currencies are counted in one tally, the totals or any entry, its `estimatedCost` stays absent from then on, and `mixedCurrencies: true` marks it. Before, a later cost started the sum again from itself, so the tally reported only part of its cost. At the first start, the totals are also marked when the stored entries show two currencies met. The shared entry's cost, like the totals', counts only the inferences membrane priced.
  - **Unchanged:** the totals, the inference count and each other agent's entry, apart from a cost after two currencies meet. The `usage:updated` trace still names each run's own agent.
  - **Rolling back:** a framework from before this shows the shared entry as an agent named `ephemeral agents` and writes it back without its mark, and this version takes it back as the shared entry. If an agent is itself named `ephemeral agents`, the older framework keys both by that name, so the shared entry replaces the agent's own, and after upgrading again that entry stays the agent's. The older framework also drops `mixedCurrencies`, so a tally in which two currencies met starts its cost again from its next priced inference. The totals' counts don't change.

- **Hosts:** agent-framework now depends on membrane `^0.6.0` and
  context-manager `^0.18.0`, where it depended on `^0.5.87` and `^0.14.1`.
  context-manager 0.18.0 requires membrane `^0.6.0` itself, so the two
  install one membrane between them. What reaches a host through
  agent-framework, from those releases' notes:
  - **Your own membrane:** a host that builds its own `Membrane` and hands it
    to agent-framework raises its own `@animalabs/membrane` range to
    `^0.6.0`. context-manager counts a compression attempt's prompt through
    that instance, and with an older membrane it counts Gemini's cached input
    twice (below 0.5.81, OpenAI's too, and OpenRouter's on routes that report
    OpenAI's `cached_tokens`), so a compression fallback that fits can be
    rejected at admission and its chunk quarantined (context-manager 0.16.0).
  - **Your own context-manager:** a host that constructs strategies from its
    own `@animalabs/context-manager` must also raise that range to `^0.18.0`,
    matching agent-framework's dependency, and verify that installation has
    one compatible copy. Leaving the host on 0.14.x installs two copies and
    hands an older strategy to a newer manager; strategy interfaces and
    compression-pause/quarantine behavior differ between those versions.
  - **The kv-unified hysteresis certificate is on by default** for a
    strategy built from a recipe: a `kvUnified` block without
    `hysteresisCertificate` takes the certified exit, and
    `hysteresisCertificate: false` restores the full solver on every compile
    (context-manager 0.15.0).
  - **Content context-manager won't store** is refused where agent-framework
    writes it, as the entry on malformed content says.
  - **Stored history:** content an older context-manager stored that doesn't
    match `ContentBlock` is now read mended, or left out, with one line per
    message naming each place, where some such content made every compile
    throw. A `tool_use` stored with `input: null`, as membrane 0.5.87's
    OpenAI-family adapters gave it for the arguments `null`, reads as `{}`
    with `null` in `unparseableInput`. A request compiled from such a message
    can change there, so a provider's prompt cache misses from that point,
    once (context-manager 0.16.0).
  - **Tools given `null` arguments:** an OpenAI-family tool call whose
    arguments are the text `null` reaches the tool as `{}`, where it reached
    it as `null`. membrane keeps the arguments' text on the `tool_use` block
    as `unparseableInput` (membrane 0.6.0).
  - **Anthropic streams:** after a stream's first event, SSE `ping`
    keepalives now count as activity for its idle deadline, so a stream that
    keeps sending only pings no longer ends at it (membrane 0.6.0).
  - **Media notes:** two of the notes membrane writes in place of media it
    doesn't send now say the model isn't seeing it. The first request after
    upgrading carries the new text wherever it renders such a note, so a
    provider's prompt cache misses once, from the first such note on
    (membrane 0.6.0).
  - **Caller-supplied blob references:** context-manager 0.16.0 and later refuse
    `blob_ref` writes with `MalformedContentError`; these references are
    store-internal. Read with blobs resolved (the default) before copying a
    body into a new write. An unresolved read is not a write-ready payload.
  - **Compression quarantine status:** callers that inspect or compare
    `getCompressionQuarantineStatus()` must account for its `spans` field,
    including an empty array when no spans are quarantined.
  - **kv-unified policy:** context-manager 0.17 adds age bands, joint latent
    demand and the subtree engine. Explicit recipe overrides remain important:
    `policy.ageBandSteps: 0` requests exact ages, `latentDemandMode: 'individual'`
    chooses independent ranking, and `engine: 'dag'` selects the DAG engine.
  - **Merges across an unowned message:** the floor is 0.18.0, not 0.17.x,
    because before it a merge could group the summaries on either side of a
    message no chunk owns (a raw pin, a message an unpin freed, or a head
    window `resetHeadWindow` left mid-stream), and under kv-unified without
    `treeifyNonContiguousSummaries` or `preserveGapBearingSummaries` every
    compile after it threw `CanonicalForestError`. A store already holding
    such a summary loads as before (context-manager 0.18.0, #287).
  - **`close()` is final:** after a context manager's `close()`, every
    operation that writes or calls into its strategy throws, with an
    app-owned store too; open a new manager on the store to go on with it
    (context-manager 0.18.0).
  - **Compression debt:** `getCompressionDebt()` answers `unknown` when it
    can't read what decides its state, with `null` for each count it couldn't
    compute and an operator-facing `error`. A host that shows the report
    treats `unknown` as needing attention and never shows a `null` count as
    0 (context-manager 0.18.0).
  - **Strategy subclasses:** `AutobiographicalStrategy`'s protected
    `pruneToolEntries` is removed; override `toolPruning` or `prunedForSend`
    instead (context-manager 0.18.0).
  - The rest is in membrane 0.6.0's notes and context-manager 0.15.0's,
    0.16.0's, 0.17.x's and 0.18.0's.

- **Hosts:** membrane 0.6.0, which agent-framework now depends on, says
  with each round of tool calls whether its stream can carry messages
  injected with the round's results: yes on its native tool path, no on its
  XML tool path. membrane 0.5.87 said neither, and agent-framework now acts
  on what 0.6.0 says:
  - **On the native path,** a tool boundary that injects messages marks
    everything stored so far as read, as a compile does: the injected
    messages, and anything stored before them. A later coalesced update of
    one of their subjects is then added after the earlier version rather
    than replacing it, and a wake queued only to have the agent read one of
    them starts no turn. With 0.5.87 they stayed unread.
  - **A notice the primary would take over** when a run or a conversation
    fork ends and its window is released (a failed reply, or a channel its
    message opened or couldn't open) is no longer passed on to the primary
    if it was injected at such a boundary, since the agent read it. It may
    still be if the window can't be read at the release. With 0.5.87 it was
    passed on.
  - **On the XML path,** a tool boundary injects nothing. Messages queued for
    the agent after a turn's first request wait for the turn's end and are
    stored then. With 0.5.87, a tool boundary stored those it could inject
    there and offered them to the stream, which ignored them. While they
    wait they are in the deferral queue, which is saved to disk only from a
    quiesce until the queue next drains, so at other times a crash before
    the turn ends loses them.
  - **Migration:** nothing to change in code. A host whose agents use XML
    tool mode should expect a message that arrives during a long turn to
    reach the agent, and the store, only when the turn ends, and a crash
    before then to lose it.
  - **Unchanged:** each round's tool results, what a turn's start stores
    before its first request, and which messages the native path injects.
  - **Added after the release:** this entry was written after 0.24.0 was
    published, so the `CHANGELOG.md` at its tag, `v0.24.0`, doesn't have
    it.

- **Anyone running agent-framework on a Node before 22.12:** agent-framework
  now declares `engines.node` `>=22.12.0`, where it declared `>=20.0.0`, as
  membrane 0.6.0 and context-manager 0.18.0, which it now depends on, both
  do. CI tests at Node 22.12.0 exactly, at 24 and at the newest Node, where it
  tested 20 and 24, and the publish workflow builds and tests at 22.12.0.
  npm warns when it installs agent-framework on an older Node, and refuses
  only with `engine-strict` set. Nothing in agent-framework's code changes
  with this; older Node versions are simply no longer tested.
  - **Migration:** run Node 22.12 or later.

- **Hosts and operator surfaces that remove Discord messages from an agent's
  context:** awareness marks are now an explicit publication choice, and the
  default is none. Previously every live rollback or suppression,
  message-granular `host/command` undo, and offline `agent-framework-recover`
  run queued a 💤 reaction on every removed Discord message, including other
  people's ambient messages in a busy channel. In the incident behind this
  change, one web-UI rollback queued 918 of them. The contract is in the
  README's [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks).
  - **Who needs to act:** a surface that should keep offering marks passes the
    operator's choice: `marks: { scope: 'addressed' | 'all', refs? }` on
    `rollbackToMessage`/`suppressMessages`, `marks: 'addressed' | 'all'` on
    a `host/command` `undo` by messages, and `--marks addressed|all` on the
    CLI. Show `previewSurgeryMarks()` before
    the choice, and pass a scope's `refs` back to bind the choice to exactly
    the previewed messages. Any other `marks` value is refused rather than
    guessed (`invalid`, from the two methods). `hide` and an `undo` by turns
    place no marks, and refuse a `marks` choice other than `none`. A
    framework with an app-owned `store` and no `storePath` has no awareness
    ledger unless `discordAwarenessOutboxPath` names one, and refuses a marks
    choice (`invalid`) rather than place none.
  - **Receipts (`markers`):** their `status` is `none`, `queued` or
    `not-scheduled`. `unresolved` is gone: a batch that can be neither
    activated nor retired stays prepared, and a start retires it, none of
    its marks sent, so it is `not-scheduled`, whose `error` says so.
    Receipts now also carry `scope`, `unmarked` and `notRemoved`.
  - **Unchanged:** the body change itself (fork, switch, redaction), the
    emoji (`discordAwarenessEmoji`) and the reaction deadline
    (`discordAwarenessDeadlineMs`). Marks already on Discord are left
    alone.
  - discord-mcpl 0.3.0's `/hide` reacts 💤 to every message in `hiddenRefs`
    itself, whatever this framework does: those marks are its own, outside
    the ledger.
- **Code using `DiscordAwarenessOutbox` directly:** the ledger is version 3,
  a table with one entry per reaction. The constructor takes the path and,
  for the sync before a write that activates, completes or retires a batch,
  the store, with a callback told of a directory a write couldn't sync:
  `new DiscordAwarenessOutbox(path, { store?, onUnsyncedWrite? })`. Every call that
  writes is async and resolves once its write is on disk; the views
  (`view()`, `batches()`, `due()` and `pendingSuppressionsFor()`) read
  memory. `pending()`,
  `reconcileForBranch()`, `activatePreparedForBranch()`,
  `preparedSuppressionsForBranch()`, `recordSuccess()`, `recordFailure()`
  and `acknowledge()` are gone. Use `claim()` and `recordOutcome()`,
  `view()`, `cancel()`, `retract()` and `settleActivation()`. `prepare()`
  takes no `activationPolicy`: a batch that names removal intervals is a
  suppression, and only its surgery activates it. The exported
  `DiscordAwarenessEntry` and `DiscordAwarenessOperation` types went with the
  version 2 shape: a request is `DiscordAwarenessRequest`, a batch
  `DiscordAwarenessBatch`, and `view()` returns `DiscordAwarenessView`. An
  operator control the outbox won't carry out throws
  `DiscordAwarenessRefusal`.
- **Hosts with an awareness ledger from 0.22.x** (by default
  `<store>/recovery/discord-awareness-outbox.json`): it is rewritten as
  version 3 in place by its first write, at a start or an offline recovery,
  and the marks 0.22.x had still to add or remove are never sent, since
  nobody chose them. The rewrite names their batches on stderr wherever it
  runs, and in a `discord-awareness-import-unsent` ops alert at the host's
  start that makes it, each before the rewrite is written. A batch 0.22.x
  never activated placed no marks; a retract of a batch takes off the mark
  of its emoji from each of its messages, whichever batch placed it. A
  version 1 ledger, which only an unreleased commit wrote, is refused until
  it is moved away, and its error says what that gives up. 0.22.x reads only
  versions 1 and 2, and its start stops on a version 3 file: to go back to
  0.22.x, move the file aside first, and 0.22.x then starts with no marks
  history.
- **Hosts that call `startDiscordAwarenessDelivery()`:** 0.22.1 added it
  for a host to start the marks' delivery after its own branch moves. It is
  removed: a branch move adds or removes no marks now, and queued work is
  delivered in the background on its own. `syncDiscordAwarenessMarkers()`
  delivers what is queued now and waits for that pass. Once `stop()` has
  begun it rejects, where the removed method logged and returned, so await
  it, or catch its refusal.
- **`createOfflineRecoveryBranch` and `agent-framework-recover`:** in the
  result (and the CLI's JSON output), `discordMarkersQueued` is the marks
  queued (planned, for a dry run), no longer every addressable removed
  message, with `markers`, the receipt, beside it, and `discordAddressable`,
  `marksScope`, `unmarked` and `notRemoved` are new.

- **Operators whose workspace history holds paths written with `//` or a trailing `/`:** every tool now reads a path in one spelling (see Fixed), so an entry an earlier version stored under another spelling, such as `a//b.txt` or `c/`, is outside the mount: no tool lists, counts, syncs or writes it, and since no spelling names it, a `materialize` doesn't report it under `skipped`. A draft written under such a key that hadn't reached disk when the host upgraded stays in history and never reaches disk. To keep it, read it from the store under its old key, on its branch (`treeGet` on the mount's tree state, `workspace/<mount>/tree`, then `getBlob` with the entry's `blobHash`), and write it again under its new spelling. Unchanged: the workspace's history keeps such an entry as it was, and where such a write reached disk, the file is the one its new spelling names, which the next sync of the mount takes in.
- **Hosts matching the traversal refusal's text, or reading a file by a path with a separator right after the mount's name:** a path that climbs above a mount's root is refused with `Path traversal detected: "<path>" climbs above the root of mount "<mount>".`, where a climb that left the mount was refused with `Path traversal detected: "<path>" resolves outside mount "<mount>"`. A path with a separator straight after the mount's name, such as `work//a.txt`, is refused by every tool and reader, `readFileFromDisk` included, with the code `traversal`, where `readFileFromDisk` read the file before. Give such a path from the mount's root, as `work/a.txt`. Unchanged: a path that leaves the mount by any other way is refused as before.

### Added

- `inference:published` and `inference:published_complete` traces carry the
  outgoing stream to in-process consumers: each chunk once its publish
  succeeds, with the `serverId` and `channelId` it was published to, its
  `inferenceId`, `index` and `text`, and the `messageId` the channel's
  server returned for that publish, when it returned one; and the
  `complete` for each server's channel it published to. They are emitted
  whether or not the channel's server takes the stream, and carry only what
  delivery published, so a host relay that voices them, such as a TTS
  bridge, never speaks text that
  `skip_reply`, a send or a private `think` withheld, or a publish the
  server didn't confirm. `inference:tokens` is unchanged: it carries the
  model's text as it is written, held, as before, while a tool-result
  guard's batch is pending.
  `mcpl:speech-routed` also reports speech publishes, with no stream id,
  index or end: among them the `sleep` tool's announcement and a
  subconscious's `speak_in_channel`. A relay that voices the agent's prose
  takes the `inference:published` stream, with its
  `inference:published_complete`, and not `mcpl:speech-routed` as well, and
  takes each message's id from `inference:published` to edit what it voiced.

- **Delivered-body digests on every stored MCPL inbound item.** Both MCPL
  lanes stamp two fields, outside the frozen source envelope (console and API
  input, and the host's own notices, carry neither):
  - `metadata.sourceBodyDigest` is the version identity of the body as
    delivered, taken at ingestion, after MCPL conversion and before any host
    decoration or storage sharding. It is the SHA-256 (hex) of `[blocks]`
    as canonical JSON (keys sorted at every level, `undefined` object entries
    dropped, and an `undefined` array element written as `null` as JSON
    writes it, though the store refuses a body holding one), with the blocks
    as the store keeps them: inline media as
    the store hands it back (base64 re-encoded from its bytes, an image's
    media type taken from its bytes' signature, only `type` and `source`
    kept), strings well-formed (a lone surrogate as U+FFFD) and an entry
    whose key isn't well-formed dropped, as the store's append drops it. So
    the body hashes alike as delivered, as handed to storage and as read
    back, and an undecorated, unsharded stored copy hashes to it.
  - `metadata.storedBodyDigest` uses the same function over exactly the
    blocks handed to storage, decorations included, taken where each path
    stores.

  Both are always the host's own: values an adapter supplies are replaced.
  A stored copy, read back with its blobs resolved, that no longer hashes to
  its `storedBodyDigest` was changed after it arrived (`editMessage` keeps
  metadata). That check is of an unsharded copy: a body the store shards
  (context-manager's adaptive ingress chunking) carries the whole body's two
  digests on every shard (`bodyGroupId` and `shardIndex` mark them), and no
  shard hashes to them. A `blob_ref` block is digested as given, while the
  store resolves it on read, so a copy holding one doesn't match; the MCPL
  lanes never store one. `sourceBodyDigest(blocks)` is exported from the
  package root as the one implementation consumers share; it carries the
  framing and the store's normalization, so check a copy with it rather than
  hashing your own serialization.

- A workspace mount can name the files it holds with `include`, in the same pattern forms as `ignore`, read for files: a name or an extension glob covers a file by its own name, at any depth, and a `dir/**` glob covers what lies beneath that directory, and not a file named like it. Unlike `ignore`, a pattern that matches a directory's name covers nothing beneath it, since each file is covered by its own name: `include: ["gate.json"]` holds every file named `gate.json`, and no other file beneath a directory of that name. Left out, nothing changes. An empty list, an entry that isn't a string, or a pattern the matcher can't read (a path with `/` that isn't a `dir/**` glob, a `*` anywhere but a leading `*.`, an empty, `.` or `..` segment, or a `\` where it's the platform's separator, as on Windows) is refused when the module is created, naming the mount and the pattern. Any other pattern is a file name, matched literally. So connectome-host can give its `_config` mount, which versions the host's config files, an include naming them, and a file saved beside them then stays out of its history and is never written back (connectome-host #278).
  - **What it guarantees:** no workspace path reads, stores, serves or writes back a file the include leaves out, including one in a nested mount's directory that mount's include leaves out, and no tool lists, matches or names one. A refusal may show that something occupies a path the caller named. On a mount that follows links, it may also say whether that path leads out of the mount or into a nested mount that covers it, with the path to use there. A link the include covers is described as on any mount, its target included unless that's a file the include leaves out. Otherwise, a refusal names nothing the include leaves out beyond the path the caller gave, which it may spell as disk does, and on a mount that doesn't follow links, it tells nothing of where a link the include leaves out leads. A sync's `passedOver` counts what it passed over.
  - **How it holds:** a walk passes over a file the include doesn't cover, and on a mount that follows links a link it doesn't cover that leads anywhere but to a directory, and counts it under `passedOver` as "outside the mount's include", a change the watcher reports there is dropped before it takes the mount's turn, and `materializeMount` and `materialize` never write one back, even when the workspace's history holds it from before the include (a `materialize` naming a directory inside the mount counts each such entry beneath it under `passedOver`, with that reason and without its path). `read`, `read_image`, `write`, `edit`, `edit_many`, `delete`, `readBinary`, `writeBinary`, `readBinaryFromDisk` and `readFileFromDisk` refuse any path it doesn't cover, a directory's included, saying it's outside the mount's include (`readFileFromDisk`'s code is `outside_include`), and `resolveAbsolutePath` returns null for one; the mount's root is inside. A `sync`, `materialize`, `grep`, `glob` or `ls` that names a path the include doesn't cover takes it as a directory, its scope, exactly where a listing names one: where disk has a directory reached from the mount's root through directories, with no link among them, or the workspace's history holds an entry beneath it that the include covers, and that a nested mount's include covers too where it lies in that mount's directory. A directory `ignore` covers is a scope too when it's named, though a listing passes over it. Each refuses any other path the include doesn't cover. A covered path is a file to a `sync`, `materialize` or `grep` when disk or the workspace's history has a file there, and otherwise a directory, and a `glob` takes its path as a directory. Beneath a directory, each passes over what the include doesn't cover, and a listing shows only covered files, beside each directory disk has beneath its path and each that covered history implies. `ignore` still applies to what `include` covers, and `ls` without a path lists each mount's include.
  - **Nested mounts:** a path in a nested mount's directory is that mount's, whatever this mount's include covers: every tool names the mount holding it and the path to use there, as on a mount without an include. Through a link this mount follows, a place in that directory is named only where it's a directory, or a file that mount's include covers with no file on its way; otherwise no answer names that mount or the place, and the file tools and `readFileFromDisk` refuse the path as one that leaves the mount (`Symlink escape detected: <path>`, code `escape`). A walk through a link to a directory above a nested mount's directory passes over that directory too.
  - **Links:** on a mount that follows links, a path is judged where it lands as well as where it's named, as disk spells it there: a covered path that reaches a file the include leaves out, through a link at the path or on its way, is refused as one that leaves the mount, in the words a place a nested mount's include leaves out gets. The file tools refuse it before anything is stored, and they and `readFileFromDisk` answer `Symlink escape detected: <path>`, code `escape`. A listing from where a link leads passes over such a file, and nothing a materialize writes through that path reaches disk, a file it would create included. So with `include: ["docs/**"]`, where `docs` is a link to `site/docs`, the mount holds nothing beneath `docs/` unless the include names `site/docs/**` too. A covered path whose landing realpath can't resolve, as for a loop or a directory this process can't search, is refused by every file tool, a delete included, and by `readFileFromDisk` (`Unable to resolve file: <path>`, code `not_found`), since where it lands can't be judged. A link the include doesn't cover that leads to a directory is passed over with the reason a mount without an include gives a link, "a symlink, not walked", since a name or an extension glob can cover what lies beneath it and what's read through it is judged by its path and where it lands, and history beneath it is unverified for that reason. On a mount that doesn't follow links, every link the include doesn't cover gets that reason, since nothing reads through one there, and such a mount resolves none to tell where it leads. On a mount that doesn't follow links, a link's refusal names an inside target only where the include covers the link and a tool could name the target: a directory, or a file the include of the mount it lies in covers. Only a refusal that names a nested mount has the code `other_mount`, so a link at the path to a file there that mount's include leaves out keeps `symlink`. A link the include doesn't cover is outside the mount itself, and its refusal names nothing of where it leads, with the code `parent_symlink` on a path's way.
  - **Disks that fold names:** a path is judged as disk spells it, as the walk judges what it lists, so a covered name whose file disk spells otherwise, such as `gate.json` where disk has `GATE.JSON`, is outside the mount, and its refusal shows the path as given. A path that names one of the workspace's entries exactly, or does once its directories take disk's spelling, keeps the entry's spelling, and what lies past a link on a path's way keeps the spelling given. Otherwise answers name a path in disk's spelling, a name the include leaves out included. Where a followed path lands is judged as disk spells it, and a path that meets no link as named, and a link's target is judged and named as disk spells it. `resolveAbsolutePath`, which is synchronous, judges the include on the path as given and follows no link: it returns the path that reaches such a file, and null for a covered file named in another case. It takes a path into a nested mount's directory in any spelling a disk that folds names may fold to it as that mount's, and gives null for it, so on a disk that tells names apart, a directory of the outer mount's own spelled like a nested one in another case gets null too.
  - **Where a nested mount is found:** its root is placed where disk has it at each start, and its directory is matched by spelling, so four cases fall outside the guarantee, as for any nested mount: on a disk that folds names, a mount configured through a link that spells a directory otherwise than disk does isn't found nested, and the outer mount holds its files as its own; on such a disk, a path through a link of the outer mount that spells a nested mount's directory otherwise than that mount's configured path does, whether the link or the configured path is the one spelled otherwise than disk, isn't found to lead there, and the outer mount reads, lists, searches and writes there as its own, creating files too, though a walk from its root passes over the directory; on such a disk, a place in a nested mount's directory that a link does lead to is judged by that mount's include, and named, in the spelling the link's target gives, so a refusal can name a file disk spells outside that include, or leave a covered one unnamed; and a nested mount whose root moves while running, as `acceptRoot` takes, stays placed where it was until the next start.
  - **Registered text:** text a host registers for a path with `registerGeneratedTextFile` is served there whatever the include says: every spelling that resolves to its path reads it, and none writes it. On a disk that folds names, a spelling in another case isn't its path, and reaches whatever file disk has there.
  - History from before the include stays as it was: no pass decides an entry outside it, a `materialize` of the whole mount leaves a deletion or conflict held outside it alone (one that names a directory inside the mount counts those beneath it under `passedOver`), the mount's `status` counts only what's inside, and a listing shows no directory that only such history holds.
  - The framework keeps its own files (`tool-results/`, `refs/`) in the first read-write mount without an include, and a setup whose only writable mount has one is treated as having none. The over-cap notice and the host's log line for a fetched reference it can't store say there is no writable mount without an include. What it kept in a mount before the mount had an include is outside the mount once it has one, unless the include covers it, so a `read` of a path an earlier spill note or reference gave is refused.

- `ChannelRegistry.publishForAgent`'s failure carries a `reason` when the
  destination refused it before anything went out: `channel-not-registered`,
  `inbound-only`, `server-gone`, `server-connecting`, `server-down` or
  `not-permitted`, the state its words come from, or `not-sent`, where its
  connection refused the request before anything was written. The type is
  exported as `PublishRefusalReason`. A host that matched the words these
  refusals had before this release, such as `Channel not found` or
  `Server not found`, reads `reason` instead. A refusal of the caller's own
  input, and a publish that went out, carry none.

- Operator controls for awareness marks, described in the README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks):
  - `previewSurgeryMarks(agent, { rollbackTo } | { suppress })` shows what a
    surgery would remove and which messages each scope would mark, per
    channel.
  - `listDiscordAwareness()` lists the ledger's batches and retract
    requests, each with its reactions counted by state.
  - `cancelDiscordAwareness(batch | retractRequest)` stops a batch's marks,
    or a retract's removals, from being sent or sent again, and never removes
    or undoes anything.
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each message's configured MCPL route, for every
    selected message, whatever was answered before.

  Cancel and retract resolve with their receipts once the ledger holds what
  they did. The same controls are the `host/command` `marks` verb
  (`action: list | cancel | retract`, `target`). Each control that changes
  the ledger is recorded in the operator log, and refuses once `stop()` has
  begun, like every operator entry point.

- **Module authors:** a tool call now carries `resultMaxChars`: how long its result may be and still reach its caller whole, measured as the framework stores it (an error's text, or a success's `data` as JSON, with a content array taken as its text). A tool that pages or budgets its answer can stay under it.
  - A model's call carries the agent's effective inline cap: its `tool_result_inline_max_chars` setting, else the residence's `toolResultInlineMaxChars`, else the default 24,000, lowered to the strategy's per-message bound. Past it, the framework writes the result to a workspace file and stores its start, or only its start where no file can be written. A utility run through `utils` carries the same, and so does an operator's puppet call, a utility run through it included.
  - A call from a running `code_execution` script carries the longest result that reaches the script whole whatever its characters, from the script's memory. The script takes an answer of up to a third of its `memoryMaxBytes`, and a character of a result takes at most six bytes there, a control character escaped as `\u0000`. So the figure is that third, less the 80 bytes of a text answer's envelope, over six: 7,456,527 characters at the default 128 MiB, moving with the setting. On Node, past about 1.5 GiB, the host's longest string bounds it instead. A result with a `structured` value reaches the script as its content's blocks as they are, beside that value as JSON, and the figure counts neither the value nor what the blocks carry past their text, such as each further block's keys or an image's data, so a tool that returns one leaves room for them. A result nested deeper than 2,000 levels, or whose parse needs more of the script's memory than is free, doesn't reach the script whatever its length. A result that doesn't reach it is answered `ResultTooLarge`, saying the call took effect. Nothing is cut or saved to a file. A utility the script runs through `utils` carries the same figure.
  - A call made in process (`ModuleContext.callTool`, `executeToolCall`) carries what its caller put on it, and a utility it runs through `utils` carries what that call carried. Without it, a module holds its answer to a bound of its own, if any.
  - The module registry now passes every field of a call on to the module, `resultMaxChars` included. It used to pass `id`, `name`, `input`, `callerAgentName` and `callerTurnId` alone.

- **`ToolResult.refused`:** `true` when the dispatcher refused the call before it opened, as RFC-007's lifecycle refuses one, so nothing ran and the call certainly had no effect: the agent may not use the tool (its `allowedTools`), a `skip_reply` wake was refused, the call's MCPL server is absent or still connecting, the host's policy for that server denies the tool, or a fork reached outside its channel. The lifecycle refuses the call from the same place, so observers see no events for it. A check made after the call opened is a failure whose text says nothing was done, and a module's result can't claim `refused`. A script's call refused so reaches the script as an `Error`, any other failure as a result with `isError`.

- **A direct workspace mount, for a checkout an agent reads:** a mount whose config sets `backend: 'direct'` (the default is `'chronicle'`, the store-backed kind every mount has been) is read straight from disk. `read`, `read_image`, `ls`, `glob` and `grep` give its files as they are when they run, with no scan, watcher or pass, so no call waits behind one, and none of its files go into the store. It's read-only: the workspace refuses a direct mount with any `mode` but `'read-only'`, and one that sets `watch` other than `'never'`, `watchDebounceMs`, `watchRootPollMs`, a `wakeOnChange` that would wake, or `autoMaterialize: true`, since none of them would ever act there. Its paths, links, `include`, other mounts' directories, size limit and walk cap hold as on a store-backed mount. Where it differs:
  - **What its listings say:** each file with its `size`, and no state or MIME type, or, for a link the mount doesn't follow or another entry it doesn't take, with why as `note`. A listing looks at each entry with `lstat`, so it lists a file it can't open with its size, and reading that file says why. `grep`'s results say `version: 'disk'`, and it lists under `skipped` a binary file, one over the size limit and one it doesn't read, each with why. `read` refuses a binary file and one over the size limit, as a store-backed mount's `read` refuses one it never took in from disk.
  - **Its ignore list:** with none in its config, it takes `node_modules`, `dist`, `.git`, `build`, `coverage`, `target`, `__pycache__` and `.venv`. Walks of the whole mount pass over what the list covers, and a path a listing, glob or grep names, or its pattern's directory, is walked all the same, as a sync naming a path walks it on a store-backed mount. `ls` without a path, and `status`, give a mount configured direct its `backend`, as it runs this session, and the list it goes by. A direct mount's `status` gives only its `path`, `mode`, `backend` and `ignore`, since it keeps nothing to count.
  - **Its root:** it reads beneath whatever directory is at its path now, with no check against the one a store-backed run of it last agreed with. Where its root now lies elsewhere than the last start placed it, as when a link it's configured through is repointed, it nests what a start would nest there now: a mount configured beneath its path, where that path leads, and a mount whose root the last start placed beneath where its root lies now, or whose configured path lies beneath a directory that start found there. Their files are those mounts'. A mount configured elsewhere whose own root has moved since, and the other mounts' own placements, wait for the next start, so a direct root moved into another mount's directory is still that mount's directory too.
  - **`sync`:** passes over it, listing it under `skipped`. `materialize` passes over it too, naming it under `skipped`, as it does any read-only mount.
  - **A mount the store holds changes on that disk lacks** (a draft, a workspace deletion, a conflict, or an intent it can't read, on the branch selected at a start, where its `include` covers it) runs store-backed from that start, so they stay in view. It runs unwatched, and with the direct default ignore list where its config names none. The workspace says so on stderr and in one ops alert (`workspace-mount-not-direct`). The alert first gives the two ways to start such a mount direct: give each change up with a sync of its path, or configure the mount `'chronicle'` and read-write, materialize it, follow materialize's answer, and restore its direct config; its next start then runs it direct. Where an intent it can't read is held, it says to sync that path. Then it names every such mount and what's held there, counting an intent it can't read as one. A mount that ran direct and runs store-backed again takes in what disk changed meanwhile as its listings, searches and syncs reach it, as an unwatched store-backed mount does.
  - **Tool descriptions:** `ls`, `glob`, `grep` and `sync` gain a sentence about the direct kind only on a host with a mount that runs direct; elsewhere they're unchanged.

- The workspace has an `edit_many` tool: several exact edits, in one file or across files of one mount, stored all or none. Each edit gives `path`, `oldString`, `newString` and `occurrences`, how many times `oldString` must occur (1 when left out), and every occurrence is replaced. Each edit is matched in its file as the call reads it, never in another edit's result, so the list's order doesn't matter, and two edits' matches may touch but not overlap. Matching is `edit`'s. Its input is checked item by item, as every workspace tool's input is checked.
  - Any problem stores none of the call's edits. The refusal names every problem it finds, in edit order, each by its edit's number from 1, a run of three or more as a range: a miss with its closest region, from one search of 2,097,152 UTF-16 code units that the call's misses share, a count that differs with the lines that matched, an old text read more than one way (by the rule `edit` refuses one by), edits whose matches overlap, an edit's own refused input, a path no mount holds, a path that names its mount's root (by the rule `edit` refuses one by), a read-only mount, a generated file (by the rule `edit` refuses one by), a file it can't edit, and edits naming files in more than one mount.
  - Two or more edits of one file that ask, past the 20 occurrences a refusal shows, for more occurrences between them than its text is long, in UTF-16 code units with its line ends read as LF, can't all apply, since each occurrence takes one or more. They don't keep each occurrence's place: when each finds what it asks for, or stops counting short of it (below), the refusal says they ask for more occurrences between them than the text is long, so some of their matches would overlap. When one of them finds a different number than it asks for, the refusal names that, and names the overlap only where the rest still ask for more occurrences than the text is long; where they don't, it names each that stopped counting short of its ask by its count, as a floor.
  - A call counts the occurrences no answer needs, past what an edit asks for and the one more that shows it finds more, only as many as the larger of its mount's limit and its largest file, in bytes, all of its edits together, so that many edits of a text with millions of occurrences don't each count them all. Past that, an edit's count is a floor, and its refusal says so, and that sent in a call of its own the edit has every one counted, unless they overlap.
  - Edits naming files in more than one mount are refused at once. Otherwise every path is first settled with disk, in one pass, as `edit` settles its one, and a refusal says what that pass took in. Then every file is read and planned, and every entry set in one record of the store, with nothing awaited between, so no other call, pass or branch change moves the tree between a file's read and its set. A call that fails before its entries are set answers that it stored none of its edits. A store that throws as it sets them is read back, since it can throw once the record is in, as Chronicle 0.4 does when the snapshot it writes after a record fails: where the entries hold the edits, the answer says every edit is stored and that the store failed after recording them, and on a mount with `autoMaterialize`, that their push to disk didn't run, so disk lacks them until a materialize of their files writes them, and on a mount without it, it names each conflict with disk, as its success does; where they don't, it says it stored none. Where the entries can't be read back either, it says it can't tell, and to read the files before sending the call again. A call whose every file already held what its edits leave, such as edits matched with quotes treated as equal that change no byte, gets the store's error, as a failure before the set does, since reading the files back can't show whether the store recorded the call.
  - On a mount with `autoMaterialize`, disk can still refuse a file once every edit is stored. The answer then leads with the fact that every edit is stored, so the call mustn't be sent again, and names each file disk refused, with its push's reason, and each file disk took with its mode left as disk had it, as `modeKept` says in a success. A call that fails after its entries are set says so too.
  - The answer gives each file's `size`, `replacements`, `edits` and `note`, and `modeKept` where its push left the file's mode as disk had it, as `edit`'s answer gives it, and `changed`, each edit's first changed region, numbered, a line over 2,000 characters as a stretch from at most 80 characters before each change on it. Every answer is held to the call's `resultMaxChars`, or with none to 24,000 characters: past it, regions are named by their lines, a file is listed without its notes or edits' numbers and then counted rather than listed, a refusal names its problems before it explains any, and its last line counts what it left out. From 1,000 characters, the least a residence or an agent can set, a refusal names at least its first problem. Below that, which a strategy's per-message bound can set, a refusal may name no problem, and its last line then asks nothing of the agent; an answer is never shorter than its head and last line.

- A WebSocket MCPL server takes `tokenTransport: 'header'`, which sends its
  credential, the static `token` or what its `accessProvider` returns for
  each dial, as an `Authorization: Bearer` header on the upgrade, with no
  `token` query parameter. The credential then stays out of the url and of
  the proxy and server access logs that record it. The default,
  `tokenTransport: 'query'`, dials exactly as before, and `null` counts as
  not set. A header carries a credential as configured only if it is
  printable ASCII (U+0020 to U+007E) with no space at either end, so header
  mode refuses any other, without quoting it: a static `token` as a
  configuration error, and an access provider's at the dial. Also refused as
  configuration errors (`serverConfigProblems`): a value other than
  `'query'` or `'header'`, named by its kind and never quoted,
  `tokenTransport` on an http(s):// or stdio server, and `'header'` with a
  url that carries a `token` query parameter or userinfo of its own
  (whenever the Bearer header carries a credential, it replaces the
  userinfo's Basic one). A WebSocket dial refuses the first and the last
  of these again, so a dial that skipped the configuration check can't
  fall back to the query.
  In header mode a dial puts nothing in the url's query, so the 0.23.0 note
  on redacting the query a WebSocket dial writes applies only to query mode.

### Changed

- **Hosts that read the `channelId` of `inference:tokens` or
  `inference:content_block` traces:** in `locus` and `hybrid` mode it now
  follows the turn's locus. It was documented as "the turn's locus as the
  stream started", so after an addressed re-pin, or the agent's own
  `channel_open`, moved the locus between rounds, it kept naming the old
  channel for the rest of the stream. It now names the new locus from the
  next round on: from the model's first content in that round, or from its
  retry after a refusal. It is still the channel the stream shows typing in,
  and in `hybrid` mode still the locus whether or not a `>>>` envelope sends
  the text elsewhere.
  - **Migration:** a consumer that keeps the first `channelId` it sees for an
    activation, as a voice relay may, works as before, and stays on the old
    channel after a re-pin; to follow the move, read each trace's
    `channelId`. A consumer that groups one stream's chunks by `channelId`
    now finds a stream whose locus moved under two channels.
  - **Unchanged:** `explicit` mode's traces, which name the trigger channel,
    and the live outgoing stream (`channels/outgoing/chunk` and `complete`).

- What the channel tools and speech tell an agent when they can't do what it asked now says what happened, whether anything took effect, and what works from there, or that calling again won't change it. They gave the registry's own words, such as `channels.lifecycle not in "<server>"'s effective grant (§14.1)`, `Server not found: <server>`, `Channel not found: <id>`, `lifecycle work prevented delivery: …` or `channel is closed and open failed: …`.
  - **A server's state is read before its grant is quoted.** By our reading, a connection's grant is empty from a transport drop until its next policy exchange ends, and that emptiness read as a refusal. Now a server this host is reconnecting to, is connecting to, or won't reconnect to on its own says so, with when to try again or whom to ask. Only a connected server whose exchange has ended, granted or not, is read by its grant: one without what was asked reads "this host isn't permitted to …", with "if you need it, ask whoever runs this host". The grant still decides every refusal, as before, and the state only words it. `ChannelRegistryOptions.serverConnecting`, new and optional, says when the host is connecting to a server. The framework's callback reads a connect or restart of the id in flight, and a connected registered connection's policy exchange in flight.
  - **`channel_open` and `channel_close`** say that a change the server couldn't take now is recorded and when it happens, that a later decision came first and what changes it, that the change already holds, or what the request met and whether calling again helps. A promise of a later change names its conditions: the server registers the channel again, and this host may open and close its channels then. A backscroll's history isn't among what happens then, and the text says so. A channel no longer registered here says so, with why it went where the failure says (this host's disconnect or the server's de-listing), or else the server's state where it isn't up, and a request's own words where it failed with them, and names no channel tool, since none can find it. A change a later decision replaced, or one refused for the grant, says that this call's change doesn't stand or didn't go through, not what the channel's transport is, which other work may hold. A channel id on another server, or on several, names them.
  - **`channel_decline`** says the decline is recorded, whatever became of its acknowledgment and its close, and a later decision that replaced it: an open, or a tune-out. It offers posting the acknowledgment again only where another decline would be taken, and only where nothing could have been posted: where the request may have reached the server with no answer saying it wasn't posted (no answer, an error answer, or one that didn't say), the text says declining again with it could post it twice. Only `acknowledged: true` counts as posted, and only `false` as not posted.
  - **A decision the lifecycle log refuses to append,** as on a full disk, gets an answer from `channel_close` and `channel_decline`, as from `channel_open`: nothing changed and nothing was sent. They rejected with the store's error. By our reading, a host watching tool calls through RFC-007 now gets `completed` with `isError` as their terminal, where it got `failed`. A decline's record of the invitation it declined, written once the decline has taken effect, no longer fails it when the log refuses it; the `[channel-decline]` log line says so, and, by the same reading, the call's RFC-007 terminal on that path is `completed`, where it was `failed`.
  - **`channel_publish`**, and the subconscious's `speak_in_channel`, frame a refusal as `Nothing was posted to channel "<id>": <reason>.` and an unconfirmed post as `Posting to channel "<id>" wasn't confirmed: …`, where they read `Publish to <id> failed: <reason>. Nothing was posted.` and `Publish to <id> wasn't confirmed: …`. A refusal for the server's state or grant reads as speech's does. `speak_in_channel`'s point to the tuned-out channels the subconscious reads, since it isn't offered `channel_list`. `channel_publish` refuses an empty `channelId` as empty, where it said there was no channel to default to.
  - **A delivery's reason** (`PublishOutcome.reason`) is one clause that reads in each text that composes it (the `[discord-send-failed]` notice, the drafts tool's lines, a `>>` bounce, `channel_publish`'s frame), and in the `[routeSpeech]` log line and the `mcpl:speech-route-failed` trace. Words that waited for a channel's lifecycle work say what the wait found: the channel was removed before they went out, a decision to close it came before they went out, or it isn't confirmed open. Words checked against a connection the registry replaced while they waited say so where the replacement would take them, and otherwise describe the replacement as it stands. Speech whose channel id is on more than one server says no server was named for the words, and whom to ask. The two reasons for speech with no channel to go to say whom to ask, and keep their words in the log line and the trace, where, by our reading, connectome-host's `connectome-doctor` looks for "no locus".
  - **A host that composes a channel tool's error into its own text,** as, by our reading, connectome-host's channel mode does, now carries these sentences.

- The notices that tell an agent a channel was opened for it now say what happens next, how servers differ in what an open channel brings, and what won't reopen a channel the agent closed.
  - **A subscription policy's notice** reads "The host opens it, and if that fails, tries again when its server next registers it; channel_list shows whether it's open yet." It read "This records the admission decision; channel_list shows current transport state." For several channels it reads "The host opens them, and if one doesn't open, tries again when its server next registers it; channel_list shows whether each is open yet."
  - **Where the agent's window holds the channel's traffic,** a notice reads "What an open channel brings you is up to its server: some send every message in it, and others only what addresses you unless you're subscribed to it; their own tools can change that." It read "What an open channel delivers to you depends on its server."
  - **Where the agent can close the channel,** a notice reads "If you don't want it, use channel_close: neither the subscription policy nor its server's own default opens it again." It read "use channel_close; your choice outranks policy."

- `channel_decline`'s `status` says what the decline found, where it said `remained closed` every time: `remained closed` where the channel is closed for certain (registered, not open, its target confirmed, and no lifecycle work for it outstanding), `declined` where the decline stands but the channel may not be closed (its close didn't complete, this host never confirmed it closed, work for it is outstanding, or its registration went), or `replaced` where a later decision, an open or a tune-out, replaced it. Every status but `remained closed` comes with a `closeError` sentence saying what became of the channel and what follows: when this host closes it, that there's no need to decline again to close it, `channel_close` where that would close it now, or whom to ask. `replaced`'s names `channel_close` as the call that closes the channel after all, whoever runs this host where this host isn't permitted to open or close the server's channels, or, where the channel isn't registered any more, that no channel tool can reach it. A decline in a channel whose traffic showed it open while the decline's acknowledgment was out now closes it, where this host directs the server's channels by then. For a channel registered, or known only from a push, while its server lacked `channels.lifecycle`, a decline made before the server gains it now answers `declined` with a `closeError`, where it answered `remained closed` with none; while the server is up, that sentence says the server keeps the channel open or closed as it chooses, and whom to ask.

- **MCPL servers that take the outgoing stream (`channels.streaming`):**
  chunks now arrive once each publish succeeds, one per published
  message, rather than token by token while the model writes. A round
  reaches a voice server once the model has finished writing it, its
  routing is decided and its publish succeeds, after any earlier post
  of the agent's still in flight. A later message to the same channel
  within one stream opens with a paragraph break (`\n\n`), so the
  channel's chunks joined in `index` order are its text, which `complete`
  carries, with its messages kept apart. A server that read chunks as a
  sign the agent is composing, such as eidoverse-worlds' typing dots, now
  sees them only as a reply is published; `channels/typing`, which the
  host sends to a server granted `channels.typing` while a turn runs on
  one of its channels, is that signal.
- Agents with `toolWrapperProseGuard` now stream their delivered prose. The
  stream was off for them because it ran ahead of the guard's
  classification; it now carries only prose that delivery published, and a
  wrapper the guard contains is never published. Wrapper-shaped text the
  guard doesn't match, as in a turn that has made a real tool call, was
  already posted as ordinary prose, and now streams too.

- Awareness marks are one-shot. Switching branches, a turn undo, a redo and
  restarts no longer request marks or removals of their own; previously a
  mark followed the branch, removed when the source branch became active and
  re-added when the recovery branch did. Nothing more is sent for a mark
  after three unconfirmed attempts at it, or after a refusal no retry can
  change, and giving up raises a `discord-awareness-delivery` ops alert. The
  README's
  [Live surgery and Discord awareness marks](README.md#live-surgery-and-discord-awareness-marks)
  describes the ledger, its receipts and how acts are ordered.
- A start never activates a surgery's marks. A batch an interrupted surgery
  left is retired at the next start, none of its marks sent; one that had
  marks to apply raises a `discord-awareness-not-scheduled` ops alert that
  names the surgery and the redo that applies them. An interrupted
  suppression's removals are still finished, at the first start on its
  branch. Each of these notices comes before the start records what it
  reports, so a start that doesn't get that record written gives the notice
  again at the next start.
- A ledger write that certifies a body change (a marks activation, a
  completed suppression or a retired batch) now syncs the store first.
  Previously a crash could keep marks active for a rollback the store had
  lost. Every ledger write is now durable too: the file is synced before it
  replaces the ledger, and its directory and that directory's parent after,
  as the framework's recovery files are. Previously an operating system
  crash or a power failure could lose a write the host had already acted
  on. A directory that can't be synced raises the `recovery-sync` ops alert,
  and the write stands. Writes leave the event loop free while the disk
  works: only serializing the ledger runs on it.
- Awareness delivery no longer holds MCPL traffic. Previously every MCPL
  data plane waited at startup, at reconnect, at a runtime
  `connectMcplServer` or `restartMcplServer`, at a tools list change, at
  `resume()`, after each surgery and in `syncDiscordAwarenessMarkers()`
  until every queued mark had been attempted, which at Discord's pace could
  leave the resident deaf for minutes. When that accounting failed, a
  runtime connect or restart failed, and every running server was recycled,
  one without `reconnect: true` closing for good, except while the host was
  stopping. Delivery now runs in the background, and a route that is not
  connected keeps its work queued until it connects. Nothing but startup's
  staged open and `resume()` now opens every MCPL connection's planes, and
  a connection whose §5.3 policy exchange is in flight still stays closed
  through both until its grant exists. The marks a drain
  hadn't sent when `stop()` began stay queued in the awareness ledger, and
  the next start delivers them in the background. A ledger that cannot
  be read still stops startup, as does one in a version this build doesn't
  read: it can hold a suppression whose removals a start must finish before
  the agent's context is served. A runtime connect or restart is refused
  over a ledger that can't be read only for a stdio server with no reaction
  baseline of its own, whose default is derived from the ledger.

- The workspace's `edit` matches and replaces through a planner ported from hands-mcp's, and says more when it can't apply:
  - A miss shows the stretch of the file most like the first line of `oldString` with two or more characters, at most its first 2,000 characters, as many as the stretch shows of a line, numbered as `read` numbers lines, and says to match exactly. A file over 2,097,152 UTF-16 code units gets no such region, and the refusal says to find the text with `grep`.
  - A count other than one, without `replaceAll`, names the lines of up to 20 occurrences, each line once, and shows each of those lines, a long one as an excerpt around its match.
  - Occurrences that overlap one another each count, so "aa" occurs twice in "aaa", and can't each be replaced: an edit whose occurrences overlap is refused, with `replaceAll` too. Since it's refused whatever their number, overlapping occurrences are counted only until the refusal has the 20 it shows, and it says "at least".
  - An `oldString` with LF line ends matches a file's CRLF ones, and the new text takes, by position, the line ends of the text it replaces. A BOM, a lone CR and every byte outside the replaced text stay as they were. A line whose own text ends in a CR shows its CRLF end's CR too wherever `edit` or `edit_many` shows the line, as `read` shows such a line, since a CR before a line feed in `oldString` is read as part of the line end; so lines copied across it match where they came from. A receipt tells a line's own CRs from its line end's by the bytes the edit stores, so a CR the edit puts before a bare LF, which disk then holds as a CRLF end, shows as that end. Before, an LF `oldString` missed in a CRLF file, and a CRLF one could mix the file's line ends.
  - An `oldString` that starts with the file's BOM or ends with a line's CR, as a character page shows them, is also read without the one, the other or both: without the BOM only at the file's start, and without the CR only before a CRLF line end. A BOM or CR at the same end of `newString` is read the same way, so the file keeps its one BOM and its line end. Where one reading finds it, that one is taken, and the answer says so where it isn't as given. Where more than one does, the edit is refused, naming the lines of each, since which the edit means can't be told: a line whose own text ends in one CR, shown with its end's CR, reads as given as a line whose own text ends in two. So is an `oldString` that is the BOM or a CR alone, found as given, where it could be the file's BOM or a CRLF line end's CR. A reading in which the edit changes nothing counts as much as any, since a copy of a line end's CR or the BOM may mean the file's own, which an edit can't change, and the refusal says where it changes nothing. A `replaceAll` counts neither such reading, since edits keep line ends and the BOM: it replaces the occurrences that change. An edit whose only change, read this way, is the BOM or CR is refused as one with nothing to change. Before, such an `oldString` matched the file's raw text, BOM and CRs included.
  - When `oldString` isn't in the file in any of these readings, straight and curly quotes are matched as equal, and the answer says so.
  - `oldString` and `newString` that are the same, once CRLF line ends are read as LF, are refused before anything is read. Where they differ only in their line ends, the refusal says that an edit keeps the file's line ends and that `write` replaces the whole file, line ends included. Before, such an edit changed the line ends of the text it replaced.
  - An edit that would take a file past its mount's `maxFileSize` is refused, as `write` refuses content past it, and the refusal says the edit must leave the file within the limit. One that its counts take past the limit, such as a `replaceAll` that lengthens or widens millions of occurrences, is refused before its new text is built, from the least its bytes can be, and the refusal says the file would be at least that many bytes. Before, such an edit was built whole, and one past V8's longest string was refused with "Invalid string length".
  - A path that names the mount's root, such as `work/.`, is refused as not a file. Before, `edit` took such a path as written.
  - A miss or a count that differs is refused with "The edit did nothing:", where it said "String not found in …" or "String found N times in …". What the edit's settling with disk took in follows the problem after a blank line, where it followed on the same line.
- A successful `edit` answers with `replacements` and `changed` beside `path` and `size`: the changed region with two lines on each side, numbered as `read` numbers lines, a line over 2,000 characters from at most 80 characters before the change on it. Its `note` also says, where they apply, that the file's CRLF or mixed line ends were kept, that the text matched with quotes treated as equal or without the BOM or a line end's CR it carried, and on which lines `replaceAll`'s other replacements are.
- A `write`, `edit` or `delete` whose store throws after recording the change, as Chronicle 0.4 does when the snapshot it writes after a record fails, answers that the change is stored and mustn't be sent again, and that the store failed after recording it, with its error. On a mount with `autoMaterialize` it says the push to disk didn't run, and that a materialize of the path takes the change there (with `applyDeletions` for a deletion). On a mount without it, `edit` names a conflict with disk, as its success does. Before, it answered with the store's error alone, as a call whose every change the tree already holds still does, such as a `write` of the bytes its path holds, since reading the path back can't show whether the store recorded it. Where the change can't be read back either, `edit` says whether it's stored isn't known, and to read the file before sending the edit again. `writeBinary` gives its peer callers the same words with `inChronicle: true`, where it threw the store's error, so `save_recent_image` lists such an image as saved, with them as its `diskCopyError`.
- A call that would change an agent's own generated file, such as a `write`, `edit` or `delete`, is refused with the tools that change what the file shows, `set_tool_visibility` and `set_tool_description`, where the refusal said to edit the presentation configuration.
- `edit`'s note on a conflict says what a sync of the path does, from what disk holds at the call, whatever kind the conflict was recorded as: where disk no longer has the file, a sync takes disk's deletion, which removes the workspace's copy; where disk has one, a sync keeps disk's copy and gives up the workspace's. Either way, it says, a forced materialize writes the workspace's copy to disk.
- `edit`'s description and its parameters' descriptions changed, and the workspace has a new tool, `edit_many`, so the first request after the upgrade that carries the workspace's tools misses the prompt cache from its tool block on.
- `edit`'s refusal and receipt are held to the call's `resultMaxChars`, or with none to 24,000 characters, so that a closest region or a long receipt doesn't push them past what reaches the agent whole: past it, a refusal's problem keeps its first line, and the receipt names a region by its lines rather than showing it. A receipt whose path and notes alone pass the cap keeps them and shows no region. A refusal is never longer than the cap unless its head and its last line alone are.

### Fixed

- A deferred push's render that's still unread now stays where it was
  placed when a later render or notice of the same subject arrives, as
  RFC-006 §5.2 and §3.3 have it: each render describes what changed since
  the one before, so the later render lands after it. A retraction removes
  the subject's unread renders, newest first, and a plain occurrence
  displaces them. A later render used to take the subject's place, so a
  retraction withdrew only that one and left the earlier render queued
  (#548), and a notice arriving after a render had landed unread removed
  it, so the model never read what it described.

- A maintenance call agent-framework withdraws, under a surgery's hold or
  once `stop()` has begun, no longer counts against a chunk's compression
  (#549). `MaintenanceWithdrawnError` now extends context-manager's
  `CompressionWithdrawn`, so context-manager rethrows it unchanged from every
  rung of its compression fallback ladder and its merge path, recording no
  outcome, attempt or quarantine event. Before, a call withdrawn after a
  chunk's canonical call was refused was recorded as that rung's provider
  error, and once every rung had failed, the chunk's request family was
  quarantined, with its alert.

- The workspace's `delete` writes the deletion's tombstone before it removes
  the file's entry, and puts the tombstone back if the removal doesn't land
  (#553). A store that failed between the two had left the entry gone with
  no tombstone, so the deletion read as a file the branch doesn't have: no
  materialize deleted the disk copy, and a second `delete` found nothing to
  delete. Now a deletion whose tombstone can't be written is refused before
  anything is removed, and can be sent again. A tombstone beside an entry
  that's still there is no longer counted by `status` as a pending deletion,
  or a reason for a bare `materialize` to take its path up, which forced
  could write the entry over a newer disk copy.

- After an addressed re-pin, or the agent's own `channel_open`, moves a
  `locus` or `hybrid` turn's locus between rounds, the `inference:tokens` and
  `inference:content_block` traces now name the new locus, and the typing
  indicator moves there, from the next round on (#555). Before, both stayed
  on the channel the stream started in for the rest of the stream, while the
  round's prose was delivered to the new locus, and after a budget restart
  or a guard retry the old channel's indicator kept running beside the new
  one until the turn ended. Both name the conversation the turn is
  attending: in `hybrid` mode they follow the locus whether or not a `>>>`
  envelope sends the text elsewhere. An `explicit` turn's typing and traces
  still show its trigger channel.

- When an MCPL server's connection closes, its channels no longer read as
  open, or as confirmed closed, on the connection that follows (#644). The
  closed transport's confirmations held for that transport only, but they
  stayed: between a reconnect and the server's next registration,
  `channel_open` answered "already open" and asked the server nothing, and
  `channel_close` answered "already closed". Now each channel reads as a
  freshly registered one does until it's confirmed again: it's left out of
  the open-channel list, and an addressed message there arrives as the
  invitation a closed channel's does. While the server is down,
  `channel_open` and `channel_close` say so and record the decision. Once
  it's back, where this host opens and closes the server's channels (its
  `channels.lifecycle` grant), they ask the server, and delivery opens the
  channel before it publishes. Where it doesn't, the channel reads as open
  again once its traffic shows it, and delivery is refused until then, as
  after a registration. Messages and lifecycle answers that were under way
  when the connection closed no longer confirm a channel after it; messages
  the connection held across the reconnect are admitted with the next
  connection, as before.
- A conversation fork now leaves out every other registered channel's
  context injections, open or not. Before, it left out only another open
  channel's, so a channel the agent had closed, or one not yet confirmed,
  had its injections shown to every fork as general context.

- What was deferred for an agent before a coalesced render or message the
  agent's turn assembles now lands ahead of it, in the order it arrived. The
  assembly's write used to be stored at once, ahead of a write still queued
  for the agent, so a render could be read before the earlier render it
  builds on: after a render landed in the agent's queue during its own
  assembly, or after the turn's start couldn't store a queued render. When a
  queued write can't be stored, the assembled one now waits behind it. What
  is deferred for the agent while its assembly awaits a render, such as a
  render another agent's assembly placed in its queue, now lands in that
  turn's request, rather than at the turn's first tool boundary or its end.
- A render's wake to read it, given when the render lands in an agent's
  deferred queue, no longer starts a turn if, when the scheduler comes to
  start it, the agent has already read the render or the render was
  retracted.
- A provider hold no longer keeps two wakes from the same millisecond as
  one when one of them is a coalesced batch's wake or a wake to read a
  render, so withdrawing the batch, or dropping the read render's wake,
  no longer takes the other wake's cause with it.
- A reply to a `[Continue]` turn that a coalesced batch's wake or a wake to
  read a render started now keeps its `promptedBy` stamp, so later
  requests render `[Continue]` before it as they do for other such replies.
- A render that settles after its turn's assembly has failed, while the turn
  is still alive, is now deferred like any other write during the turn,
  rather than stored into the turn after its compile. While the host is
  quiesced, the assembly's writes wait behind what is queued for the agent,
  and land when it does.

- The notice that a channel opened without the agent asking (an open its
  own send or reply caused, or a subscription-policy admission) names
  `channel_close` only to an agent that can call it there for every channel
  it names, except where several residents share one slot (#291), and where
  a fork's seed still carries it: in an adaptive template's summary, or in a
  notice long enough for its template to shard or cut. A conversation fork can
  close only its home channel, and an agent's `allowedTools` can leave
  `channel_close` out. Before, such an agent
  was told to use `channel_close`, and couldn't call it, or its call was
  refused. Where an agent's own send opened a channel it can't close, the
  primary is now told by name too, if it can close it, and the agent is told
  that it was.
- The opened notice says what an open channel brings, which is up to its
  server, only to an agent whose window holds the channel's traffic.
  Before, a conversation fork was told this about a channel other than its
  home, whose messages never reach it.
- The primary's notices name a conversation fork by the channel it's bound
  to, then by its generated name. The notice of an open by an agent that has
  ended says "a message from" it, where it said "opened by X's reply" whether
  a reply or speech had opened the channel. The reply notice and speech's
  failure notice say why a channel is selected for opening again with
  "because", where they said "as".
- When a conversation fork or an ephemeral run is released without reading a
  channel notice it could act on (a channel its own send opened, or a
  channel its reply couldn't open that is selected for opening), the primary
  is told by name in its place, as for a reply whose delivery failed, of what
  still holds then: a channel closed since is left out, and so is one no
  longer selected for opening, or open since. Before, the notice stayed
  unread in the released agent's window.

- `channel_open` and `channel_close` promise delivery only to an agent whose
  window holds the channel's traffic. An ephemeral run, and on a host that
  routes conversations every agent but a conversation fork, are now told that
  opening or closing a channel does so for every agent on the host, that
  opening it brings them none of its messages and closing it stops none
  reaching them, and that `channel_open`'s history comes back in its result.
  Before, they were told "Messages that address you still reach you" and
  offered history "preceding the message that invited you", though a channel's
  messages go to the residents, or to its fork or nowhere. Residents of a host
  that doesn't route conversations, and conversation forks, keep the words they
  had, so their cached tool lists don't change; a fork keeps them through its
  closure turn after its binding expires. On a host with no residents, the run channel messages are stored
  with is a holder, so when it ends, the next run's words change to the
  holder's.

- A `channel_decline` that a later decision replaced while its
  acknowledgment was out no longer has this host send the server anything
  for that decision. Until now:
  - where a `channel_open` replaced it, with the open's request still out
    when the acknowledgment was answered, this host sent the server that
    open a second time;
  - where a tune-out replaced it, in a channel this host hadn't confirmed
    closed, this host sent a `channels/open` for the tune-out.

- A deferred context write whose write threw, and whose store then couldn't
  be read to tell whether it had landed, is no longer put back as one that
  wasn't stored. Until now a later flush stored it again, so a write that
  had landed appeared twice. It's now put back marked as unknown, and before
  it's written again the store is searched for its id: found, it counts as
  written and isn't stored again; not found, it's written; and while the
  store can't be searched, it stays queued, holding what's queued behind it
  for that agent, as a write that keeps failing does. Such an entry's mark
  is persisted with the queue, so after a restart it's still looked up
  before it's written.
  - A write found this way at a flush is carried there, after what the turn
    stored since, though the store holds it before those, so later requests
    place it earlier.
  - Wherever held writes are read or changed, by a module's context, the
    coalescer, a wake's check or a tune-out's backlog, such a write is
    looked up first. One that landed is a stored message from then on, read
    and changed as one, and isn't carried into the turn; one that didn't is
    an ordinary held write. Where the store can't be searched, the
    coalescer reads it as possibly read and shown.
  - A module context's `editMessage` and `removeMessage` can now throw for
    such a held write: where its store can't be searched to tell whether
    it landed, nothing is changed, and the error reads "held write held:…
    may already be stored, and its store can't be searched to tell, so
    nothing was changed. It's refused the same way while the store can't be
    searched; the host log names the store's error".
  - A conversation fork's or ephemeral run's queue, stored when it's
    released, looks such an entry up the same way, and, where the store
    can't be searched, in the window the release reads: found, it isn't
    stored again; where neither can see the store, it's stored anyway where
    the store takes it, and the log says it may now be stored twice. A
    failed reply, or a channel notice the fork or run could act on, among
    such entries reaches the primary once, as the entry itself under its own
    id, so a crash or a restart doesn't tell it twice, as long as the
    release's sync went through. It isn't passed on where the release finds
    the fork or run had read the copy that landed, at its release or at the
    `stop()` that ends it. Where a crash or a failed sync leaves the entry
    to the next boot, boot passes it on anyway, since it can't read that
    window.

- A Discord message stored twice in shards now loses both copies when it's
  deleted, by a live delete or by a history sync that finds it gone. The
  module removed one body per shard group id, and the group id names the
  text, so the second copy, under the same id, outlived the delete. It now
  removes each body as context-manager reads them (`continuesBody`, in store
  order).

- When an open that speech or a reply made fails, the channel's decision goes
  back to what it was. So an agent told the open failed isn't later put
  into the channel by that open's decision. Before, the
  decision to open stayed: the agent's next speech there, or reconciliation
  when the server announced the channel again, opened it without the notice
  that says it's open and how to close it. A decision made while the open
  was out stands. Since the failed request may have reached the server, as
  when its answer is lost to a timeout, the host also closes the channel on
  the server. Where the decision put back means nobody had decided, the
  channel then follows its server's latest announcement and the
  subscription policy, which a re-announcement during the open couldn't
  apply: if they select it for opening, the host tries the open again, and
  the failure says why. Where the host can't record putting the decision
  back, the decision stays, no close is sent, and the failure says the
  channel stays selected for opening. `channel_open`'s own decision still
  outlives a failed open, as its failure says.
- A reply into a closed channel whose open fails now tells the agent that
  the reply went out and opening the channel failed, and that
  `channel_open` tries again, where the agent can call it: a conversation
  fork can't, and an agent's `allowedTools` can leave it out. The notice
  comes where the host directs the server's lifecycle
  (`channels.lifecycle`), and only when no decision about the channel, such
  as the agent closing it, was made while the open was out. A reply whose
  open only reconfirms a channel the agent already has open gets none.
  Where the channel is selected for opening after the failure, the notice
  says so and why, as speech's failure does, and that `channel_close`
  withdraws that, where the agent can call it: where the host couldn't
  record putting the channel's decision back, a later delivery or
  reconnect tries again; where the
  server's latest announcement or the policy selected it again, the host
  tries again itself. Where the channel is selected for opening and the
  replying agent has ended, the primary is told by name instead, if one is
  registered; where the replying agent can't close the channel, as a fork
  away from its home can't, the primary is told by name too, if it can.
  Before, the failure reached only the logs.
- On a server without `channels.lifecycle`, an open by speech or a reply,
  which fails there before any request is sent, no longer records a decision.
- `channel_open` on a channel that's already open, and `channel_close` on one
  that's already closed, now record the agent's decision, and so does
  `channel_decline` on a channel closed by default. So a module's
  housekeeping close is refused for a channel the agent opened itself, even
  where speech, a reply, the server or a policy had opened it first. And a
  channel the agent closed or declined isn't opened later because its server
  registers it as initially open, or a policy admits it.
- `channels/close` now has the deadline `channels/open` has when
  `requestTimeoutMs` is 0. A close the server never answers no longer holds,
  for good, the deliveries that wait for the channel's lifecycle work.

- `semantic_search` finds what the resident wrote through a send tool. The
  index took text blocks and private-prose tool arguments only, so a resident
  with `proseRouting: "disabled"`, which speaks only through send tools, had
  none of its own replies indexed. The message argument, `content` (or `text`,
  as older `channel_publish` callers send it), of `channel_publish`,
  `send_message`, `reply_message`, `send_dm` and `edit_message`, under any
  MCPL prefix, is now indexed as `[<tool>] …`, with or without
  `includePrivateTools`. Messages stored before this change are not indexed
  again, so earlier send-only messages stay out of the index.

- `semantic_search` builds a summary hit's snippet and `chars` from the local
  summary, as it already does for message hits, instead of taking the
  service's copy: up to 400 UTF-16 units of the text as indexed, with "…" when
  it's longer than that. A service that stores only vectors and ids, and
  returns no text, now gives summary hits a snippet instead of an empty one.
  Where a branch made from an earlier point, as an undo makes one, minted a
  summary id another branch already used, the hit's snippet and `chars` come
  from this branch's summary; its score, timestamp and date filtering are
  still the index's.

- Where conversations are routed to per-channel forks (`FrameworkConfig.conversations`), a fork's seed no longer copies its template's channel notices, or its by-name notices of what another agent's reply did. That's each `[channels]` notice of an open, a failed open or a subscription policy's admission, whichever build stored it, and each notice telling the primary by name of another agent's failed reply or channel. They were copied into the forks spawned after them, so a fork serving one channel held which channels other conversations opened and whose replies failed, with advice judged for the primary, such as "use channel_close", which a fork can follow only for its home channel. The template keeps them. A text block that repeats one word for word is left out too, and the spawn's log line counts what was left out: `[conversation] <fork>: seeded from <template> without N thinking block(s), N channel or by-name notice(s), N unanswered tool call(s) and N orphaned tool result(s)`. A summary an adaptive template wrote while one was in its window can still mention it, a notice long enough for its template to shard or cut compiles to other text and stays, and a fork spawned before this change keeps what its seed copied.

- The MCPL outgoing stream (`channels/outgoing/chunk` and `complete`) no
  longer carries text that delivery withholds or sends elsewhere. It
  streamed each round's text as the model wrote it, but whether a round is
  delivered is decided only once its tool calls are known. So a streaming
  server received, and discord-mcpl's voice spoke:
  - a round that called `skip_reply`, a silencing send such as
    `send_message` or `channel_publish`, or a `think` under
    `same_round_think_text_policy: private`;
  - a round its stream never finished, such as one cut off by a stream
    error;
  - in hybrid mode, in a later stream of the turn, such as a budget
    restart's, a framework retry's or a re-inference's, text the turn's
    hold kept back or its pin sent to another channel;
  - in locus and hybrid mode, after a mid-turn re-pin, text bound for the
    new locus, which streamed to the old one.

  The stream is now the prose that delivery published: each publish's
  text, to its channel, sent once the publish succeeds, a later one to the
  same server's channel opening with a paragraph break. Tool publications, such as
  `send_message`, a `drafts` resend or the `sleep` tool's announcement,
  aren't part of it, as before. A publish succeeds only when the server
  confirms it (`delivered: true`), so one refused before sending, one that
  throws, times out or gets an error response, one the server reports
  undelivered (`delivered: false`) and one whose reply leaves `delivered`
  out are never streamed, and neither is text held as a draft. A
  `{{unsent}}` resend streams the draft's words it sends, rather than the
  token.
- With native tool calls (`roundContent`), a call of a `code_execution`
  script that reaches the host while a run or wait call of the round
  watches the script now counts toward that round's routing, as the same
  call made directly does (#306), whether or not the round waits on that
  call's script. In explicit mode an inner `skip_reply` keeps the round's
  envelopes in the context. In locus and hybrid mode an inner `skip_reply`
  keeps the round's prose private, and an inner silencing send, a `drafts`
  resend among them, holds it and the turn's later prose as drafts, as a
  direct one does. An inner `think` under the private same-round policy
  holds the round back in every mode but disabled. An inner `skip_reply`
  that's refused at dispatch, because this host can't set the
  `wake_in_seconds` it asks for or because the agent's allowedTools doesn't
  name it, or that the host refuses before dispatch, as for arguments that
  aren't an object, counts as a refused direct one: it keeps only its own
  round private, and the turn goes on. An inner send refused so, like a
  refused direct one, silences nothing. A script has only the tools its
  agent's allowedTools names, so a call of
  any other tool fails in the script and reaches no one. On the fallback
  without `roundContent`, as in XML tool mode, an inner call counts only as
  a direct one does there. Nothing is routed until the turn ends, so a
  silencing send holds the whole turn's prose as drafts, the rounds before
  it included. The private `think` hold and an explicit round's
  `skip_reply` don't apply there (#307).
- A round whose run or wait call watches a script that can change its
  routing waits for that call to return, at the script's end or at the
  call's yield, and its prose goes out then. A script can change it when
  its code names a tool whose call changes the round's routing in the
  turn's mode: in locus and hybrid mode `skip_reply`, a silencing send,
  `drafts` (whose resend is one, so its name holds whatever action its
  call asks), `say` or `whisper`; in explicit mode only
  `skip_reply`; and in either, `think` under the private same-round policy.
  Disabled mode holds nothing. A wait reads the code of the script it
  names. A name counts wherever it stands in the code as a whole
  JavaScript identifier, comments and strings included: `tools.say(...)`,
  `tools["say"]` and `tools["world--say"]` name `say`, and `say_hello`
  doesn't. So a comment or a string that mentions such a tool holds its
  round too, for no longer than the call's yield: 30 seconds by default,
  and up to `maxYieldMs`, 600 seconds by default, when the call asks. A
  tool name the code doesn't spell out, built at runtime or written with
  escapes, goes unseen, and its round is routed as it was before scripts
  counted. A stop or a list holds nothing, and neither does a
  `code_execution` call without code execution or one the agent's
  allowedTools refuses. Any other round is routed at its tool-calls event,
  as before, so narration beside a script isn't held for it. The turn's
  locus and an explicit round's `>>` targets are taken at the round's
  tool-calls event, when the model has finished writing it, not when its
  calls return; hybrid's `>>>` targets apply as its delivery runs, as for
  any queued hybrid delivery. What counts is the host's receipt of a call,
  not the script's making it: a call that reaches the host while no call of
  the round watches the script isn't the round's, as one made once its run
  has yielded, one made while it was watched that waited, with 16 of the
  script's calls already out, until the watching call had returned, and one
  still on its way when the call yielded. Such a call's effect can come
  after the round's prose. A call's result settles only the round that
  dispatched it, even when a
  newer round reuses its call id. A round whose turn ends or stops waiting
  on it, or that a newer round of the same agent replaces, before its calls
  return, as when the turn is stopped, is withheld: it is neither sent nor
  held as a draft, a log line names it, and in locus and hybrid mode the
  turn's delivery receipt counts it as suppressed.
- Every stream now sends `channels/outgoing/complete` for each channel it
  streamed to, while its server registers it and takes the stream, on every
  exit path, as MCPL Spec 14.3 asks: once its deliveries have run, or, when
  the host stops, before its connections close, with what it has sent by
  then, so a publish that succeeds after that isn't streamed. A stream that
  handed its turn to a budget restart or a tool-result-guard retry never
  sent it, so a voice server never learned that stream's utterance had
  ended.
- A membrane refusal retry no longer moves the outgoing stream to a new
  inference id. Nothing of the refused attempt was delivered, so none of it
  streamed; the rounds delivered before the refusal stay in the stream, and
  its `complete` carries them. The stream's `inference/lifecycle` `started`
  and terminal now carry that one id too. The retry re-minted the id
  between them, so a server matching them by `inferenceId` saw the first
  inference never end, and a terminal for an id that never started.

- An error a host's own call to agent-framework gets, thrown, rejected with
  or in an error answer's data, no longer carries a credential the framework
  replaces in its records, whoever wrote its words. Before:
  - a server's words in an error built from them were cut to 200 code
    points, with control characters replaced, before anything redacted
    them. That covers an initialize error, a refusal of the protocol
    revision, the revision a legacy server answered with, and a tool call's
    error answer. A credential the cut split kept its start in the
    framework's records and in an agent's tool result, and one holding a
    control character survived changed. An error answer's words were also
    trimmed first, so a credential ending in a space at their end survived
    whole. The caller of a connection got the server's words, an error
    answer's data, the revisions a refusal lists and a tools/list cursor in
    its errors unredacted;
  - a failed legacy handshake's `stderrTail` was the end of the server's
    stderr as written, cut before anything redacted it;
  - a modern connection's failed connect handed the host the SDK's error as
    raised, with the url in its words, and under Bun in its `path`;
  - a legacy stdio server that couldn't be started was refused with Node's
    error as the `cause`, its command line in `spawnargs`, and an argument
    Node refuses quoted in the words;
  - `McplUnreapedLaunchError` printed its connection's configuration,
    credentials included, wherever the error was inspected.

  Now each error redacts the server's words where it's built, then trims and
  bounds them, and redacts the strings in an error answer's data. In that
  data, a number whose digits hold a credential, as JavaScript reads the
  number, becomes a string, its digits with the credential replaced; a
  number with more significant digits than a double holds has lost its last
  ones before that. A redacted key that comes out the same as another key is
  numbered (`redacted (2)`), and data nested past 64 levels reads
  `[withheld: nested too deep to redact]`. A failed handshake's `stderrTail`
  is the same end of the server's stderr, with every credential of up to
  14,336 characters that reaches into it replaced whole. A library's error
  is handed on as its name and its redacted words alone, with a launch
  failure's `code`: a legacy stdio server that couldn't be started is
  refused with its words redacted and a `cause` that keeps Node's error's
  name, those words and its `code`, and nothing else of it; when Node
  refuses an argument or an env value at once, the words leave the value
  out. `McplUnreapedLaunchError.connection` isn't enumerable. With a
  configuration that can't be read, the server's words are withheld, as the
  records already withhold them, and an error answer's data is withheld
  whole.
- The record of a tools/call or push/render answer that came after its
  deadline is redacted as an on-time answer's record is.

- The host no longer publishes into a channel its server declared inbound-only
  (`direction: "inbound"`, SPEC §14.2). A server's live-transcript channel can
  be one, where an agent speaking in the room arrives addressed. Until now
  that moved a resident's plain speech there, the delivery attempt opened the
  channel if she had closed it, and the server refused the publish.
  - Every publish of plain speech into such a channel is refused before the
    channel is opened or published to, a drafts resend and `{{unsent}}`
    included, with a reason that names the declaration and says to use that
    server's own tools. A channel declared inbound-only while the publish
    waits, on the channel's lifecycle work, its open or anything else, is
    refused too, and so is one whose registration is gone by the time the
    words would be published. Nothing is published to either. A declaration
    that comes with the channel's own opening leaves the channel open: the
    agent gets the failure for its words, and the notice that the channel is
    open if this open is what opened it.
  - A `>>` or `>>>` target naming the channel bounces with the same reason,
    and the closed-channel invitation offers no reply into it. In explicit
    mode the refused target also clears the turn's destination, so the turn's
    later text without a prefix bounces too, rather than going to the
    destination named before it. A delivery refused because the channel was
    declared inbound-only after its target resolved ends the destination
    too, unless a later round has named another channel by then.
  - `channel_publish` and the subconscious's `speak_in_channel` return an
    error that names it. No outgoing stream starts in the channel, and the
    channel context names no default outgoing channel for it.
  - A channel the host knows only from a push is refused once the server's
    answer to opening it, wherever the host opens it, declares it
    inbound-only.
  - The routing notices say plain speech is refused there, and to use that
    server's own tools. The locus and hybrid mode primers, shown when an
    agent's mode changes, say plain speech goes to the locus unless its server
    declared that channel inbound-only.
- `speak_in_channel`'s `mcpl:speech-routed` trace now follows a confirmed
  delivery, with `serverId`, `delivered` and `textLen` as plain speech's trace
  has them, and no `messageId`, as before. Any other result is traced as
  `mcpl:speech-route-failed`, with the publish's reason, the connector's
  detail when it sent some, and `outcome: "unknown"` when the words may have
  been posted or `"failed"` when nothing was, a refusal included.

- Content context-manager won't store is refused where it's written, and a deferred write that context-manager refuses no longer holds its agent's later writes. From context-manager 0.16.0, a write whose content doesn't match `ContentBlock` is refused with a `MalformedContentError` (context-manager #184). Before it, such content was stored as given, and a compile that read it could throw.
  - **Writes and edits through the framework:** a module's write, and its edit of a write still held for a turn's end, throw `MalformedContentError`, naming each place, as the store's own write and edit do. They throw whether the write would be stored at once or deferred while a turn runs, where a deferred one used to be refused only at a later flush. Content the store mends, a `tool_use` whose input isn't an object, is written as before. The API's `message.send` refuses content that isn't text with an error, where it answered `pending` and stored the message as given.
  - **A process response** with such content, in a message it adds or an edit it makes, is refused whole before any response to the event is applied. None of it is applied, its module state update and inference request included, and it doesn't count as accepting console or API input. A `[process-response-refused]` line and a `process:response-refused` trace name the module, the other modules' responses apply, and the `process:completed` trace and the process log list only the responses that applied.
  - **The push and channel lanes** check content with context-manager's `malformedContentPlaces` before anything else. Content from an MCPL server is converted at the boundary into blocks the store accepts, so this catches events that never crossed it. When it names any place, the message stores no row and queues no wake. A stderr line, `[push-event-refused]` or `[channel-incoming-refused]`, names the server, the channel where there is one, the event or message, and the places. A new trace, `mcpl:malformed-content-refused`, carries the same, with the places as `places`. Content that's absent is still the empty-content check's.
  - **A deferred write that context-manager refuses as malformed is dropped at the drain** and logged, rather than queued again: it would be refused at every flush, and so would hold every later deferred write for its agent for good. Since writes through the framework's `addMessage` are refused before they're queued, this meets an entry a process before this release persisted, a pair `puppetToolCall` queues itself, or a write the strategy's chunking splits into a shard the store refuses, which the line names. Any other failure keeps the entry queued, as before, unless a read-back shows it landed. A `tool_use` dropped this way lets a `tool_result` queued behind it be stored alone.

    The store's own validation checks all content and shards before append, so
    an unavailable readback does not make such a refusal retryable. Other errors
    whose landing is unknown remain queued and are reconciled by ID before retry.
    A synchronous custom strategy hook throwing this same error after append is
    tracked separately in context-manager #288; this is not a general guarantee
    for arbitrary host callbacks when readback is also unavailable.

- **A tool call whose arguments JSON can't write is refused as not sent
  (`not-sent`), in both engines** (#556). Such arguments, a BigInt or a
  cyclic object, can come only from in-process code. The modern engine
  reported the call as possibly executed (`no-response`: "whether it took
  effect is unknown"), though nothing reached the server. The legacy engine
  already refused it, but said to try again later, which fails the same way.
  Both now say "If calling it again fails, ask whoever runs this host", and
  the host's log line names the serializer's error.
- **A legacy request refused as not sent stays a `not-sent` refusal when the
  host's `console.error` throws:** for these arguments, for a stdio pipe
  that has failed, and for a write the transport refuses at once. Before,
  the call threw the logger's error, or failed with it. The refusal's log
  line is then lost.
- **A request that fails over HTTP is reported once** (#556), by whatever
  made it: a tool call or a listing to its caller and in the host's own log
  line. Its failure no longer also raises the modern connection's `'error'`
  event, and with it the framework's `mcpl:server-error` trace. A host that
  logs that trace, as connectome-host does in each server's `mcpl-stderr`
  log, no longer shows a failed tool call there; its HTTP status and the
  server's words stay in the host's own log line. A failed listing still
  shows there once, as the framework's `tools/list failed` trace, and so
  does a failure the SDK reports itself, such as a list-change
  subscription's. A connection with no `'error'` listener of the host's no
  longer logs a second line for it. A failed notification is reported as
  before, since what sent it may report nothing of it.
- **A stdio MCP server whose pipe fails and whose child outlives SIGKILL no
  longer has calls told that the host is reconnecting to it** (from the
  review of #540). The modern engine now holds the launch before the calls
  the failure ends are answered, as the legacy engine does, so they, and a
  call made as the connection closes, read that the host won't reconnect to
  it on its own.
- **A legacy stdio server the framework launched no longer has the Discord
  awareness ledger read from disk for each JSON-RPC error answer's log
  line** (from the review of #540). The connection builds that line's
  redaction at its first error answer and keeps it. If the ledger can't be
  read when it builds, that line is withheld, and the next answer builds
  again.

- **A stdio MCP server whose pipe fails while it's connecting no longer reads
  as connected, in both engines.** Such a connect now fails: one whose
  transport found the child's stdin or stdout failed before the connection
  was taken on, as when the modern engine's connect-time list-change
  subscribe, or the legacy engine's answer to a ping the server sent during
  the handshake, meets EPIPE. Before, unless the child had already exited,
  the modern connect was taken on once that subscribe gave up, and the legacy
  handshake took an initialize answer that came afterwards. The connection
  then read as connected while refusing every call as not sent, and said the
  host was reconnecting to it when reconnect was on, until the child exited;
  for a child that outlived SIGKILL that never came, and nothing held or
  reported the launch. The connect's error is now `MCP server "<id>" stdio
  pipe failed with <error> while connecting` (modern) or `MCPL server "<id>"
  stdio pipe failed with <error> during the handshake` (legacy). A child that
  can't be reaped is held as for any failed connect: `connect()` throws
  `McplUnreapedLaunchError`, and a reconnect's failure is a permanent
  `reconnect-failed`. A modern connect that the SDK resolved after such a
  failure had already ended the child, which read `MCP server "<id>" closed
  its connection while connecting`, now names the pipe too. A connect that
  fails some other way after its pipe failed, such as one the SDK rejects,
  keeps its words.

- A message a tune-out holds from the residents is no longer injected into a resident's live turn. One that arrives while the resident's turn is alive is held, and the next tool boundary stored it and injected it into the turn with the other held writes, though the resident's compiled view leaves it out. The boundary now stores it without injecting it.
- A module's `ctx.queryMessages` and `ctx.getMessage` now mark such a message with `heldFromResidents: true` (on `ModuleMessage`): a message that arrived in a tuned-out channel, stored with `metadata.tuneOut`, whose row no resident is shown, during the tune-out or after it. A module's context answered it as an ordinary row, so a module that leaves out `held: true` rows to keep to what the residents see took it in. A held write that carries the stamp is marked as well as `held`, and so is its stored row once it lands. Its text can still reach a resident in rows of their own, which aren't marked, such as the cancel's `<tuned-out-backlog>` row, with the text of the tune-out's newest messages, up to `backlogCap` of them and as many as fit in one of the residents' messages, the stored ones first and then those still held, what the subconscious says of it, and the result of a tool that reads history on request.
- A cancel's `<tuned-out-backlog>` now carries the tune-out's messages still held, oldest first, after its stored ones. It carried only stored ones, so a message held while the resident's turn was alive was left out of it. The held messages the backlog leaves out, all of them when `backlogCap` is 0, now follow the subconscious's cancel report notice, each a row of its own with its own content, since its view holds only stored messages. So does a held message the backlog shows whose image or audio its text lines drop. A cancel the subconscious makes itself now gets that notice and a report turn too when any held message follows the notice, since it wrote its note, if any, before it could see them.
- A cancel the subconscious makes itself with no note now gets the report notice and a report turn when the `<tuned-out-backlog>` left messages out. It got neither, so at `backlogCap` 0, where the tool says the subconscious's report is the whole delivery, the resident was left an empty backlog and nothing else.

- **Edit/delete/reaction-remove markers now preserve explicit-send suppression, like reaction markers** (#157). `isConversationalInjection` exempted only `chat:reaction`, so the RFC-001 marker tags `chat:edited`, `chat:deleted` and `chat:reaction-remove` (now delivered as synthetic incoming messages by e.g. zulip_mcp) cleared explicit-send suppression — an edit notice arriving right after a `send_message` re-opened auto-routing for the same round's prose. The four tags live in a shared `NON_CONVERSATIONAL_TAGS` set (`src/mcpl/tags.ts`). All four marker tags also leave ChannelRegistry's default publish channel and `context.incoming`'s message/thread anchor unchanged. An edit the agent sees first still counts as the message it replaced: it clears explicit-send suppression, can move the turn's speech channel at a tool boundary, and, for a channel message the coalescer delivers when it accepts it, moves the default publish channel and `context.incoming` as that message would. The host knows that case when RFC-006 coalescing delivers a version of a subject whose producer marked its first occurrence `initial` and of which no version may have been shown to the agent yet, whether the version is a plain occurrence that replaced an unread one, a deferred notice's render, or a plain occurrence that replaced a pending notice; an edit of such an edit is the agent's first view too. A doubt counts as shown, so the host errs toward a marker: a message counts as shown once a compile of any agent that can read it has begun to assemble it (a compile that throws gives that back, unless a tool boundary or another compile has moved the agent's position since) or a tool boundary of one may have injected it (residents sharing a message slot can all read it), and so does any message stored before one that was, since the host keeps one position per agent. `channel_publish`'s description now says that an omitted `channelId` goes to a conversation agent's own channel when it is bound to one, and otherwise to the channel of the most recent incoming message the host received on any channel, whether or not the agent has been shown it, apart from markers, and that a message pushed to the agent never sets it.

- The physical-window projection (`physicalWindowTokens`) prices what a mid-turn message brings into a continuation round: an image or a generated image at its `tokenEstimate`, or 1,600 tokens without a usable one, and a document, audio or video at 1,000, the flat estimates context-manager's store uses for images and other media. It priced only such a message's text, so a round that carried photos or audio could cross the window the projection exists to keep a request inside.

- Words for a channel that its server registered again or retargeted after
  the publish's last wait, as it can while the channel's opening is
  announced, were published before anything had confirmed the new
  registration or target open. They now wait for that queued lifecycle
  work, as they wait for any channel's, and go out only into the channel it
  leaves open. If it leaves none open, nothing is published, and the failure
  reads as at the first wait. A close decided in that window, where the
  host directs the server's lifecycle, now stands, as one decided while the
  words wait already does.
- A `channels.publish` grant withdrawn while the words wait now holds for
  them too: the check just before the publish reads the grant as it is
  then, and refuses as the check before the waits does.
- On a server whose channel lifecycle the host doesn't direct (no
  `channels.lifecycle` grant), a channel decided closed no longer refuses
  words that waited for queued lifecycle work: the host can't close it, so
  they go into its open transport, as they already did when nothing was
  queued.
- Words for a channel whose registration is no longer marked open, with no
  lifecycle work queued for it, are now refused where they used to be
  published. That happens, for example, when a server answers an open of
  the channel for another one. On a server without `channels.lifecycle`,
  words for a retargeted channel are refused the same way, unless the
  server's traffic has confirmed the new target open first.

- A channel the host knows only from a push event no longer counts as
  confirmed closed before anything has shown its state: after a restart, the
  server may still hold a channel an earlier process opened. Its traffic shows
  it open as before: where this host directs the lifecycle, once it's decided
  open or tuned out.
  - Where this host directs the channel's lifecycle, `channel_decline` in such
    a channel that isn't open sends its close through the lifecycle queue.
    Until now it sent nothing. Its answer is still `remained closed` when
    that close completes, no later decision has replaced the decline, and
    nothing else is under way for the channel.
  - Where this host directs the channel's lifecycle, `channel_close` of such
    a channel already decided closed, as by a decision kept from before a
    restart, sends the close. Until now it answered `already closed` and sent
    nothing.
  - Where this host isn't permitted to open or close the server's channels,
    `channel_close` of such a channel is refused as for a registered channel,
    saying the close didn't go through and stays recorded. Until now a refused
    close said the channel was closed, and a channel already decided closed
    was answered `already closed`. Since such a channel may never be
    registered, the refusal says the close happens if the server registers
    it at a time this host may open and close its channels.

- A channel decided open (or tuned out) that its server retargets now opens
  at the new target when the only lifecycle work still outstanding for it
  was queued before the server's registrations were last removed. That work
  cancels when it would run, so it opens nothing. Before, the retarget left
  the new target to it, and the channel stayed unopened there although
  decided open. It needs the channel to be registered again in a way that
  queues no lifecycle work, before that work settles: from a push, or while
  the host doesn't direct the server's lifecycle (`channels.lifecycle`).

- A sleeping agent's wake no longer outlives its framework's `stop()`. The event gate's `dispose()` left the sleep's timer armed, so the stopped framework kept the process running until the sleep's end, and then queued a wake there. `dispose()` now clears that timer and keeps the sleep, and until the next `start()` nothing arms a sleep's or a self-wake's timer, even for a turn a failed `stop()` left running. The next `start()` on the same framework arms the wake again for the sleep's end, or wakes the agent at once if the sleep ended while it was stopped, as the queued wake did before.
- A sleep now wakes the agent at its end by the gate's clock, whatever its length. Its timer could fire before the end, and the wake was then dropped, so the agent slept on until something else woke it. On Node a timer can fire a millisecond early: in a probe on Linux with Node 24.22.0, 7 to 10 of every 1,000 timers of 1 to 40 ms, armed the way a sleep arms them, did, and with Bun 1.4.3 none of 2,000 did. A clock set back did the same on any runtime, and a sleep longer than about 24.8 days fired its timer at once.
- A sleep a conversation fork or an ephemeral run set ends when it does, at a fork's idle close or at `stop()`, or at the run's end, and so does a `skip_reply` self-wake it left pending. The gate's sleep holds back every agent's wakes but the heartbeat's and a privileged user's, so they were held back until its end, and its wake, like the self-wake's, then went to a name that no longer existed.

- While an agent sleeps, an event wakes it as its heartbeat only when it comes from the MCPL server configured under the id `heartbeat`. Any server's push or channel message whose metadata said `source: 'heartbeat'` woke a sleeping agent, as did a push whose `origin` gave the server id `heartbeat`. The `heartbeat` server's ticks and reminders still wake it, and so does a privileged author, as before.
- The event gate reads a push event's server id, feature set, event id and event type as the host has them. A push's `origin` that held fields of those names took their place, so a server could match a policy written for another server's id, or for channel messages. The origin's other fields reach the gate as before.

- `stop()` now ends each conversation fork that's still live, as a closing
  fork's end does, whatever its stream or turn is doing, as it ends each
  ephemeral run. So a failed reply the fork stored and never read reaches
  the primary instead of being lost at a restart. A restart re-creates no
  fork: the next qualifying message on the fork's channel spawns a new
  generation, and nothing reads the old fork's window again. Each fork
  `stop()` ends emits `mcpl:conversation-disposed`, and its channel
  unbinds, so after a `start()` of the same instance each such fork's
  conversation starts again from the template at its channel's next
  qualifying message, a message still queued for that channel included;
  what a `start()` after a settled `stop()` should do is #315's open
  question.
  The notices `stop()` passes on before the registry forgets its channels
  now name the channel by the label the registry has for it, as other
  notices do, rather than by its bare id. A release postponed later, as a
  run's that `stop()`'s sweep ended can be, still names it by its bare id.
  A crash runs no release, so after one a notice a fork stored unread is
  still lost.
- A failed reply still queued for a fork or a run that ended while the
  host was quiesced is now passed to the primary when `stop()` runs, named
  as the registry knows its channel then, and lands when the host resumes.
  It isn't passed on where the fork or run had read the copy of it that
  landed in its window, unless `stop()`'s pass over that window fails,
  when it goes on as boot would send it, read or not. Before, the next
  boot's flush passed it on. A memory-only queue still loses it at exit.
  Any other write queued for such an agent, but a channel notice it could
  act on, is still dropped, logged.

- An MCPL outgoing stream now goes where each of its publishes went, that
  server's channel, and ends there with its `channels/outgoing/complete`.
  It looked each channel up again by its bare id, for every chunk and for
  the `complete`, so:
  - a stream lost its `complete` when the channel's server declared it
    inbound-only mid-stream, or when a second server registered the same
    channel id, and a consumer that finalizes on it, such as a TTS
    utterance, was left open;
  - when a channel id passed from one server to another mid-stream, the
    `complete` the new server got carried the old server's words too.

  A stream that started in a channel goes on there while its server
  registers the channel and takes the stream, an inbound-only declaration
  included, so a chunk for a publish delivered just before the declaration
  is sent too. No stream starts in a channel declared inbound-only, as
  before. A channel gets nothing of the stream while its server doesn't
  register it, as after the server removes it or is disconnected, until
  the server registers it again, or while the server isn't granted the
  stream, as during a reconnect until its grant is settled again.

- Awareness marks queued just as a delivery pass finishes are now sent on
  their own trigger. A pass that had found nothing more to send stayed
  joinable for one more microtask, so a request made then (an operator's
  retract, say) joined a pass that would never look again, and its work
  waited for the next surgery, operator act, reconnect, `tools/list_changed`
  or restart. A pass now stops being joinable as soon as its last claim
  finds nothing more to send, before a later act can make more work owed.

- A tune-out cancel's `<tuned-out-backlog>` now holds only as many of the newest diverted messages as fit whole in one message of each resident that reads it: the smallest of their strategies' `maxMessageTokens` at four characters a token. The dump is one message, and a resident's strategy cut it like any message over that cap, keeping its first characters. So a long backlog lost its newest messages and its closing tag, while they still counted as shown, and the subconscious's report wasn't told of them. The messages the dump now leaves out are the oldest, and they count as left out wherever those above `backlogCap` do: in `truncated=`, in the report notice's count, and for the notice and report turn that a cancel the subconscious makes itself with no note gets. Held ones among them follow the report notice as rows of their own. A newest message too long to fit by itself is shown cut to the room left, when at least a character of it fits beside the mark, and marked `[cut to fit; the whole message is in the channel's history]`, and if it's still held, it also follows the notice as a row of its own. The notice's count now reads "N of M diverted messages, the oldest, weren't delivered raw to the resident".
- A `backlogCap` between 0 and 1 now delivers no raw backlog. It delivered every diverted message, since the backlog was taken with `slice(-backlogCap)`, which starts at the first message for such a cap.

- `tune_out` of a channel whose transport is closed now opens it, so the
  subconscious gets the traffic it was told to watch. Until now it recorded
  the tune-out and answered success, and the channel's traffic didn't arrive
  until its server next registered it. Where the transport doesn't end open,
  or the tune-out ended while it was being opened, the answer is still a
  success, since the tune-out was recorded, and its new `openError` field
  says why the channel's messages don't, or may not, reach the subconscious
  yet and when they will, or that the tune-out isn't in effect any more. The
  answer now comes once the channel's lifecycle work has settled: the work
  already queued for it, the tune-out's own open where the transport may
  not be open, and the work queued while that open was out, each request
  up to its deadline. `tune_out` called again for a channel already tuned
  out tries the open again where its transport may not be open and this
  host can open the channel, and its refusal says what the transport is
  now.
- `channel_decline` refuses a channel that's tuned out, whatever its
  transport, and says to cancel the tune-out with `tune_out` mode "cancel",
  which delivers what it diverted. Until now a decline of one whose
  transport wasn't open answered success and ended the tune-out without its
  cancel, so its diverted backlog never reached the agent.

- At startup, a failed MCPL connect whose launch couldn't be reaped, or
  that `stop()` or a disconnect ended, now keeps the server's stderr that
  its handshake's error kept in its `mcpl:server-connect-failed` trace and
  its `Failed to connect MCPL server` console line, redacted, as other
  failed connects do. The handshake's error carries the stderr as
  `stderrTail`, and `McplUnreapedLaunchError` and the framework's own
  refusals wrap that error, so the trace and the line, which read only the
  outermost error, found none.

- A uri-form image or audio block that gives a `disposition`, even a falsy one
  such as `0`, `false`, `""` or `null`, becomes a reference stub in pushed
  events, channel messages and context injections, as one with `"ref"` or
  `"never"` does, and as tool results already showed it. Before, such an image
  went to the provider with its `uri` as the image's source, except in a
  `system` injection, which can't carry an image, and such audio showed the
  no-data notice. A reference's own reading of the block, and the check for
  inline data that claims a disposition, already counted any disposition
  given. Pushed events and channel messages are converted once, when they're
  accepted or a coalesced one is delivered, and stored that way, so history
  from before the upgrade keeps such a block as it was: an image there stays
  a provider url source while its message is in context. A server's
  `beforeInference` injection is converted at each turn, so one that keeps
  injecting such a block changes there at the first turn after the upgrade,
  whose first request misses the prompt cache from that injection on: from
  the system prompt on, for a `system` injection. As for a `"ref"` block, the
  stub names a reference id this host keeps only in memory, so the same miss
  comes again after each restart.

- The 0.23.0 notes said that `readFileFromDisk` keeps the code `symlink` for a file that is itself a link. One that leads into a nested mount's directory gets `other_mount`, with words naming that mount and the path to use there, as the same release's note on nested mounts says. 0.23.0 already answers so, and nothing changes; this corrects the note for hosts and module authors who choose advice by the code.

- The workspace's tools read a path after its mount's name one way everywhere: `/` between segments, `\` too on Windows, with no empty or `.` segment and no trailing `/`, and a `..` takes back the segment before it. So `work/./a.txt`, `work/a//b.txt`, `work/docs/` and `work/sub/../a.txt` name the workspace entries `a.txt`, `a/b.txt`, `docs` and `a.txt`, the files the disk operations already reached. Before, the workspace's history kept a path as written: `work/a//b.txt` became a second entry for `a/b.txt`, a write to `work/./a.txt` or `work/sub/../a.txt` failed with the store's "Invalid tree path", and a `materialize` naming `work/docs/` found nothing. A `..` with nothing before it to take back climbs above the mount's root and is refused, whatever it reaches afterwards, a path that comes back in by the mount directory's own name included. Before, the traversal guard let that through: a disk read reached the file, and the other tools failed with the store's "Invalid tree path". A separator straight after the mount's name (`work//a.txt`) is refused too, since it would make the rest an absolute path, even where that path lies inside the mount, which the traversal guard let through before: a disk read reached the file, and the other tools found nothing or failed. What hosts and operators may need to do about these is under Breaking.

- A WebSocket client's error no longer quotes the server's credentials.
  Under Bun, the client's own message for a failed dial names the url as
  dialed (its user, password, path and query, and the token, a static one
  or an access provider's), and the dial's error carried that message on as
  it read, to the caller of `connectMcplServer` among others. The client's
  text, for a failed dial, for a client that throws as the socket is
  constructed, and for an error after the socket opened, now has the url as
  dialed and as configured shown as `redactUrl` shows it, the strings the
  configuration and its dials know to be credentials replaced
  (`redactServerText`), and any other ws(s) url masked the same way; the
  error is a new one with no `cause` holding the client's original. Node's
  `ws` quotes no url, so its errors read as before.

## 0.23.2 — 2026-10-20

### Fixed

- A channel server can no longer set the metadata keys that only the host writes on a stored message. A `channels/incoming` message's `metadata` and a push event's `origin` are now stored without `system`, `kind`, `draftOwner`, `draftIds`, `tuneOut`, `coalescingSubject`, `deferredWriteId`, `external` and `openaiResponsesItems`, and the host writes its own after them, as it already did for the inbound source envelope. A key is in that set when only the host writes it and some reader takes it on its own as what the message is. Until now a server's copy of one was stored wherever the host wrote none, so a server's message could pass for one the host wrote: with `kind: "discord-send-failed"`, a message left unread in a conversation fork's window made the host tell the primary, when the fork was released, that the fork's reply had failed (#611).

  The first time a server sends one of these keys, the host logs the server and the key, without the value, once for each server and key until it restarts. Every other key a server sends, such as `tags` or `mentioned`, is stored as before, beside the fields the host writes itself. Messages stored or queued before this change keep what they were stored or queued with.
- A message that arrives while an agent's tools run now reaches membrane, at the tool boundary, as its participant and content alone. Its stored metadata stays the host's record, whoever wrote it.

## 0.23.1 — 2026-10-19

### Fixed

- An agent's request no longer carries the `tokenEstimate` the framework
  stamps on the thinking blocks it stores. Membrane sent a
  `redacted_thinking` block to Anthropic and Bedrock with every field it
  had, and the Messages API refuses a block carrying a field it doesn't
  define ("Extra inputs are not permitted"). So once the framework stored a
  stamped `redacted_thinking`, every later request carrying that turn was
  refused. A framework turn's request and the direct API's (`runInference`)
  now drop the stamp from the compiled messages. The stored block keeps it,
  and context-manager still prices the block by it.

## 0.23.0 — 2026-10-19

### Breaking

- `onChannelAutoOpened` with `source: 'subscription-policy'` now reports a durable admission decision before transport reconciliation. Treat it as intent; await the registration call and inspect `getOpenChannels()` when confirmed live state is needed. `opened-by-delivery` reports a delivery that opened a channel not already decided open or tuned out, once its transport is confirmed; a delivery that only reconfirms the transport of a channel that was isn't reported. The built-in host notice now distinguishes selected-for-opening from currently open.

- **Operators:** two MCPL servers whose `toolPrefix`es meet are refused, at
  `create()`, at a runtime connect and at a restart (before it disconnects
  anything), with an error naming both servers, both prefixes and the rule
  (#265). Two prefixes meet when one is the other's followed by `-`, or
  begins with the other's followed by `--`, as `foo` and `foo--bar` do. Their
  servers could give one tool name: `foo` listing `bar--echo` and `foo--bar`
  listing `echo` both gave `foo--bar--echo`. Such a name reached the model
  twice, which membrane's native formatter and Anthropic's API refuse, so
  every inference of an agent offered it failed, and in XML tool mode its
  calls reached whichever server listed it last. A configuration with such a
  pair needs one of the two prefixes changed, such as `foo-bar` for
  `foo--bar`. `foo` beside `foo-bar` or `foobar` is fine.

- **Hosts:** explicit `allowedTools` lists must name each permitted utility as `module--utility`, or use `"all"`. Utilities aren't tools of their own: an agent's model and its scripts are offered them only through `utils`, whose `run` checks the utility's own name. An agent that should use a utility lists both `utils` and `module--utility`. The name alone passes the dispatch check for any call by that name, whether the host makes it with `executeToolCall` on the agent's behalf or the model or a script makes it without being offered it. `utils` alone no longer exposes a usable slot. When utilities are registered but none are permitted, `list` returns a failed `ToolResult` with both counts and migration advice instead of listing every registered utility, as earlier releases do. The slot is hidden in that case, and explicit lists containing `utils` log one warning per Agent instance. Hosts that construct depth-limited lists can obtain the existing namespaced utility catalogue through `getAllUtilities()`. Callers using `"all"` retain the permission policy; an empty registry continues to omit the slot and return a successful empty list. Hosts that drive `createEphemeralAgent` results themselves must use `runEphemeralToCompletion` to register and run them; framework-created identities have tool authority only while registered, and calls before a run or after retirement fail with a registration error. Adopt this change with the first connectome-host release after 0.10.2, which contains https://github.com/anima-research/connectome-host/pull/191.

- **Operators with `codeExecution` enabled:** the python interpreter that runs model-authored scripts no longer inherits the host's environment, and it starts in its own runtime directory instead of the host's working directory. It gets the allowlist stdio MCPL children get (#175), `CHILD_ENV_ALLOWLIST` in `src/mcpl/transport.ts`, among them `PATH`, `HOME`, the locale, temp directories, CA bundles and proxy variables, whose URLs can carry credentials. Then come `codeExecution.env`, and last `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8`, which the runner sets over any declared value.
  - **What stops arriving:** every host variable outside the allowlist, such as `PYTHONPATH`, `VIRTUAL_ENV`, `PYTHONHOME`, `LD_LIBRARY_PATH`, `PYTHONUTF8` and `ALL_PROXY`, and any credential a script read from `os.environ`. To get one back, list it in `codeExecution.env`, which a recipe can `${VAR}`-substitute from `.env`. `codeExecution.inheritEnv: true` restores the whole environment, and with it hands every host variable, provider keys included, to model code and to every subprocess a script starts.
  - **Relative paths** now resolve in the runtime directory, which teardown removes, best effort, whenever the interpreter stops or is reclaimed: a script's relative reads and writes; a relative path in `codeExecution.env`, such as a `PYTHONPATH` entry; a relative value of an allowlisted path variable, such as `TMPDIR` or `SSL_CERT_FILE`; and a relative `PATH` entry that a bare `pythonPath` is looked up on. A file a script reads from the host, or writes to keep, needs an absolute path, as does a path in `codeExecution.env` or in an allowlisted variable. To give scripts somewhere durable, pass its absolute path through `codeExecution.env`, such as `"AGENT_FILES": "/srv/agent/files"`, and name the variable in the agent's prompt.
  - **Direct `PyRunner` users:** `PyRunnerOptions` gains `env` and `inheritEnv`, and a runner built without them gets the allowlist. Only `inheritEnv: true` passes the whole environment, and these options aren't checked as `create()` checks `codeExecution`'s.
  - **A misread configuration is refused at create:** an `inheritEnv` that isn't `true` or `false`, such as a quoted `"true"`, which would quietly keep the allowlist; an `env` that isn't an object of strings; and a variable name that is empty or holds `=` or NUL, or a value that holds NUL. A `null` `inheritEnv` or `env` counts as left out.
  - **Unchanged:** a `pythonPath` with a separator, which still resolves from the host's working directory, and which a venv's interpreter needs no `VIRTUAL_ENV` for, since it finds its prefix and site-packages itself. The allowlisted variables keep their values too, so an absolute path among them names what it did, and a relative one resolves as above. The allowlist limits what model code inherits, not what it can read: on Linux a process running as the same user can still read the environment the host and its MCPL servers started with, through `/proc/<pid>/environ`, and can open the host's files, `.env` included, by absolute path.

- **Hosts that set `processLogging.broadcast` or an agent's `refusalHandling.announceHumanTurns`, or read either back:** both settings are removed. In no release has either changed what the framework does, beyond `isProcessLoggingEnabled()` reporting `broadcast` back: `process:completed` trace events are emitted whatever `broadcast` says, and 0.6.2, the first release with `announceHumanTurns`, already shipped without its one reader. `isProcessLoggingEnabled()` now returns `{ persist }`.
  - **Migration:** delete either setting from your config, and drop any read of `isProcessLoggingEnabled().broadcast` or of `announceHumanTurns` on an agent's `refusalHandling`. In TypeScript, an object literal checked against the framework's types, such as a config passed straight to `create()`, no longer compiles while it names either setting, and neither does such a read. In plain JavaScript, `isProcessLoggingEnabled().broadcast` reads `undefined`.
  - **Unchanged:** a config that still sets either starts as before, with the setting ignored.

- **MCPL/MCP server authors:** the legacy engine now enforces the revision it
  speaks. `McplServerConnection` offers MCP `2024-11-05` and now also requires
  it back: an `initialize` result with any other `protocolVersion`, or with
  none, fails as `McplProtocolVersionError` (`kind: 'mismatch'`), stating what
  each side said. Every server family probed answers `2024-11-05`, but a
  hand-written server that omits the field must add it. An `initialize`
  answered with JSON-RPC `-32022` fails as `McplProtocolVersionError`
  (`kind: 'rejected'`), keeping the server's `supported` list, code and data.
  When that list names modern MCP, the message says to configure the server
  with `protocol: 'modern'`. A protocol-version verdict is never retried: no
  reconnect stub, and a reconnecting connection stops its backoff loop
  (`reconnect-failed` carries `permanent: true` and raises the ops alert at
  once). At startup the verdict raises the same `mcpl-down` ops alert, so a
  server refused for its revision doesn't drop out with only a log line. The
  established revision is on `connection.protocolVersion`.
- `tools/list` now follows `nextCursor` across pages, so a paginating server's
  whole inventory reaches the agent; before, every page after the first was
  silently dropped. A repeated cursor, or more than 100 pages, is an error
  rather than a partial inventory.
- **Hosts and operators:** a server configuration with both `command` and
  `url` and no `transport` is now refused before anything is spawned or
  dialed. Before, it was launched as stdio and the url was silently
  ignored. Migration: drop the field you don't use, or set `transport` to
  say which one is used. Unchanged: a configuration with only one of them,
  or with both and a `transport`, resolves as before (a host can still
  layer a url and `transport: 'websocket'` over a file's command). A legacy
  `requestTimeoutMs` above 2^31−1 is refused too: Node ran it as a timer of
  about 1 ms, so every request timed out at once. Every value that worked,
  `0` included, passes.
- **Hosts:** `stop()` now rejects, after its whole teardown, when an MCP
  server's child couldn't be confirmed exited, naming each such child and
  its server. Before, closing a stdio server returned as soon as a signal
  was sent, so `stop()` never failed for this. Code that chains work on
  `stop()`, such as exiting a TUI or switching sessions, should catch that
  rejection: the framework is stopped either way. As with any failed
  teardown, an owned store stays open, and a later `stop()` retries the
  reap, completing once the child has exited.

- **Module authors:** a module tool's call is refused before its handler
  runs when it lacks a key the tool's `inputSchema` lists in `required` (a
  key given as `null` counts as lacking it, unless its declaration admits
  `null`, by a type list naming it or `nullable: true`, or it has no `type`
  at all), or when its input is there but isn't an object. **Who
  needs to act:** a module whose handler runs without a key its schema
  requires, since calls that leave the key out ran before and are now
  refused. **Migration:** if the key is optional, drop it from `required`
  and give its default in the property's description; if your handler
  needs it, keep it required: calls without it are now refused before your
  handler runs, telling the agent what to send. **Unchanged:** a module
  tool's values (types, enums, nested shapes) are still the handler's to
  check, while a run through the `utils` tool has its values' types and
  enums checked, as it always had; an absent input (`undefined` or `null`)
  still reaches a tool that requires nothing; a name the module answers
  but doesn't declare goes on unchecked; MCPL servers' tools keep their
  servers' own checks. Where a required key is missing and the schema
  declares its keys only in `properties` and `required`, the refusal also
  names keys the call gave that it doesn't declare, since a key sent under
  another name is one way a required key goes missing; such keys are never
  refused for themselves. connectome-host needs no change:
  its tools of this kind keep those keys required, since each such call
  did something its agent didn't ask for, such as starting a subagent
  named "undefined", or one with no system prompt, which was accepted and
  then failed once its run began.

- **Hosts whose config gives two agents one name:** `create()` now refuses the config, naming the name and each agent's place in `agents`, before it opens the store. Until now the last agent of a name took the others' place in the framework's registry, though all of them used the name's one context log, and an earlier one could still decide two things: whether the name was the primary agent, which is the first configured agent's name, and the name's tool presentation, when only an earlier agent of the name set one. Keep one agent of each name. An agent you rename starts a new context log and its recipe's settings, since both are kept by name, and still reads the residents' shared messages. Names compare exactly, so `Dup` beside `dup` is still two agents, though the history tool's author filter matches their own turns without letter case and can't tell them apart there.

- **Code that sets or reads `InferenceRequest.ephemeralSystemPrompt`:** the
  field is removed. It carried a system-position prompt for one turn; the
  silent heartbeat was its only producer, and its instruction now rides the
  tick's request-only separator. There is no replacement: a system prompt
  that changes for one turn costs that request its prompt cache from the
  system on, and changes what every retained signed-thinking block is bound
  to. Nothing in this package or in connectome-host sets or reads it.
  Unchanged: `suppressProse` and `silentHeartbeat` on `InferenceRequest`.

- **Operators:** on Linux, a workspace mount's watcher holds the mount's root
  directory open while it watches it, so it can tell whether that directory
  has been removed whatever has since been made at its path.
  - **What stops working:** `umount` of the file system under a watched
    root fails with "target is busy" while the host watches it. Stop the host
    first, or use `umount -l`, which still detaches it.
  - **What gets slower:** a root removed, or replaced by a rename over it, is
    found at the watcher's next root poll (`watchRootPollMs`, 2 s by default)
    rather than at once.
  - **Unchanged:** where the watcher can't hold the root (macOS, Windows, or
    on Linux a root it can't open as a directory), it holds nothing open, as
    before. On WSL 2, Windows programs can still rename or remove a watched
    folder on a Windows drive.

- **Operators whose mounts hold symlinks inside them:** on a mount that doesn't set `followSymlinks: true`, the default, a file reached through a symlinked directory inside the mount is no longer read, written or synced through the link. A file a host reads from disk behind such a link, such as an agent's instructions file, is refused, with a refusal that names the link. To keep using it, use the path through the link's target, which the refusal names, or for a link into another mount's directory, that mount's path; or, for a link to a directory inside the mount, set `followSymlinks: true` on that mount; or move the file so that no directory on its path is a link. Unchanged: a link leading out of the mount, and a file that is itself a link, are refused as before.
- **Hosts and module authors choosing advice by a disk read's code:** `readFileFromDisk` refuses a link among a path's directories with a new code, `parent_symlink`, which `WorkspaceReadErrorCode` gains, and one into a nested mount's directory with `other_mount`, the code that mount's own paths get. A link leading out of the mount keeps `escape`, and a file that is itself a link keeps `symlink`.

### Added

- Connecting to an MCP server warns once when a credential would cross the
  network unencrypted, to an `http://` or `ws://` url whose host isn't this
  machine: its `token` or `accessProvider`, or a secret the url carries
  itself (a `ws://` url's userinfo, a query parameter whose name says
  credential: `token`, `key`, `secret`, `password`, `auth` or `signature`,
  or whose value is shaped like one under a plain name, a query parameter
  name that may itself be one, or a path segment that looks like one, as
  the redacted url judges it). A name that may itself be
  a credential is counted in the warning, never quoted. An `http(s)://` url
  with userinfo is refused instead, since the HTTP client can't send it and
  its error would quote it. Loopback hosts are
  exempt, and so are the unspecified addresses `0.0.0.0` and `[::]`, which
  reach this host too. It warns rather than refuses, since a private network
  or a TLS-terminating proxy can make that deliberate.
  `serverConfigWarnings` is exported beside `serverConfigProblems`, so a host
  can apply the same check in its own configuration validation.

- Modern MCP servers (revision `2026-07-28`) can now be configured beside
  MCPL ones, through the official SDK 2.x client. A server's URL decides its
  family: `ws://`/`wss://` stays MCPL (MCP `2024-11-05`), and
  `http://`/`https://` is modern MCP over Streamable HTTP. A stdio server
  stays legacy unless its config sets `protocol: 'modern'`. A modern server's
  tools use the same prefix, tool policy, RFC-008 class hints and dispatch
  paths as any MCPL server's, and its tool prefix meets the same rules: it
  can't be a module's name or another server's prefix, or meet another
  server's, whichever family either server is. It has no MCPL surface: no grant, push,
  channels, inference requests, quiesce plane or awareness gate. MCPL policy
  that asks for that surface on one is a configuration error, such as
  `allowHostCommands: true` or a scope's non-empty `whitelist`. Policy that
  only takes something away or repeats a default, such as
  `disabledCapabilities` or an allow-list like `enabledFeatureSets`, is
  accepted as already satisfied, so a host that puts a deny-list on every
  server it deploys can deploy a modern one. A modern `requestTimeoutMs`
  outside 1..2^31−1 is a configuration error too, since 0 means "time out
  now" to the SDK. Details:
  - **stdio:** runs through the framework's own spawner (env allowlist,
    `inheritEnv`, stderr lines including startup), launched once per connect.
  - **HTTP credentials:** come from `token`/`accessProvider`, as a cached
    bearer refreshed once on 401.
  - **Deadline:** each call gets one `requestTimeoutMs` deadline across every
    leg and the pauses between them. At the deadline cancellation is
    requested for a leg in flight (between continuation rounds none is), the
    outcome is reported as unknown, and nothing is replayed.
  - **Failures:** reported as `McplRequestError`, with the outcome taken from
    what actually crossed the transport: `not-sent`, `error-response` (HTTP
    401/403 with `data.httpStatus`) or `no-response`. Only an error or a
    `complete` result is a final answer: a call that ends after an
    `input_required` answer, or after a result type this revision doesn't
    define, is `no-response`. A complete result that can't be used is a
    plain error. The message an agent reads is the one an MCPL server's
    failure gives where the two share an outcome, and has its shape where
    they don't: what happened, whether anything took effect, and what works
    from there. The method, the tool, the JSON-RPC code and the HTTP status
    go to the host's log. A tool call made while the server's connect is
    still under way reads as one made while an MCPL server connects.
  - **Lifetime:** reconnects use the legacy backoff settings. A tool-list
    change subscription is kept open, reopened if refused or lost, and its
    changes go through ordinary admission, so they park under quiesce like
    any wake. `close()` and `stop()` end any connect in flight. A
    `ModernMcpConnection` starts once: a second `start()` returns the first
    call's promise. When a stdio launch's first attempt fails and its cleanup
    can't confirm the child exited, `ModernMcpConnection.connect()` throws
    `McplUnreapedLaunchError`, whose `connection` owns the launch; its
    `close()` retries the reap.
  - **Status:** `listMcplServers()` entries gain `family`, `protocolVersion`
    and `transport`.
- A server lost for good (it closed and won't reconnect), MCPL or modern,
  now leaves the agents' tool list, as a disconnected one does. So does one
  whose reconnecting halts for good (`reconnect-failed` with
  `permanent: true`, which also raises the ops alert). An MCP tool
  result marked as an error is traced as `tool:failed`, on both engines.

- **A `code_execution` script can test a result for an error, and read its
  structured content, without parsing.** Each tool function's string is
  unchanged, and carries two attributes beside it: `.is_error`, `True` for an
  error result (a failure the framework reports as `Error: …`, or a
  structured result whose `isError` is true) and `False` otherwise, and
  `.structured`, the parsed `structuredContent` of a structured result's
  JSON object, or `None`. A result whose text merely starts with `Error:`
  reads `False`. The string is now a `str` subclass, so code that uses it as
  a string keeps working, `json.loads` and `isinstance(r, str)` included,
  while an exact type check such as `type(r) is str` now reads `False`, and
  a result a script pickles loads only in the script runtime.
  `PyRunner`'s `onToolCall` may return a `ScriptToolResult` (exported) to
  set both, or a plain string as before, for which both read `None`.
  `code_execution`'s description changes, so the first request after the
  upgrade that carries it misses the prompt cache from its tool block on.

### Changed

- `getActiveTurnTrigger` returns the trigger of a turn that a coalesced batch woke without the host-owned `coalescingSubject`, `coalescingBatch` and `coalescingBatchSubjects` while that turn is retried: an in-turn retry, a provider hold's release, a requeue behind an auxiliary call, or the tool-result guard's restart. Those fields identify a wake for withdrawal while it is unconsumed, and a retry belongs to a turn that has already passed its batch gate. A turn whose merged wakes don't all share one subject shows no `coalescingSubject` either. Its other fields, such as `reason`, `source`, `channelId` and `counterparty`, are as before.

- `fetch_reference`'s failures now say what happened to the reference and what calling again can do: `fetch_reference couldn't fetch "<ref_id>": <what happened>. <what calling again can do>`, where they gave the fetcher's reason alone, such as `HTTP 404`, `fetch timed out or aborted`, `claimed <n> bytes exceeds fetch ceiling <m>` or `third-party origin (<origin> != dialed <origin>); not fetched by this host`. Where `save_recent_image` says a reference can't be fetched, it gives the same two.
  - **What happened** names the server and what it answered (`the "<server>" server answered HTTP 503`), the limit a fetch met (`it claims <n> bytes, over the <m> bytes this call allows`, `the download had reached <n> bytes, past …`), what kept a fetch from dialing (`it points to <origin>, not to the "<server>" server's own address (<origin>), and this host fetches only from the server itself`), or that what arrived didn't match the reference's digest or couldn't be stored. The eager fetch's and a script's fetch's log lines read the same words.
  - **What calling again can do**, such as trying again later (after a timeout, 408, 409, 423, 425, 429, or a 5xx other than 501 and 505, and after a failed request, with whoever runs the host to check its connection to the server if it fails the same way), waiting for a fresh reference to it (an expired or unbound reference, and the other 4xx), passing a larger `max_bytes` (naming the size it needs, and no more than the server's fetch budget has left), asking whoever runs the host (who can check its credentials for the server after a 401 or 403, raise or renew a spent budget, or add back a server it no longer has), or nothing, as for an address on another origin, a server this host doesn't connect to over a network, or a claim past the 256 MiB this host fetches at most, which no `max_bytes` or setting lifts. A claim past those 256 MiB is refused for them first, and a download past them is stopped for them first, whatever the server's budget has left.
  - **The budget's texts** read `this host's fetch budget for the "<server>" server is used up (<used> of <budget> bytes)` and, partway, `this host's fetch budget for the "<server>" server ran out during the download (<total> of <budget> bytes), so it was stopped and nothing was kept`, where they read `per-server fetch budget exhausted (<total>/<budget> bytes)`, the one partway after `aborted: `.
  - **A `ws:` or `wss:` reference** on its server's own origin is refused for its scheme before anything is dialed, where `fetch` refused it before connecting and the agent read `fetch failed`. A server whose address doesn't parse is refused, saying so, and that whoever runs the host can correct it.
  - **The host's log** says why a fetched payload couldn't be stored: no workspace, no writable mount, or the write's error. A save that throws is that failure too, logged, where its message reached the agent as the fetch's own error.

- What the model sees of an MCP tool result from a server that isn't an
  MCPL peer (an MCP-only legacy server, or a modern server) now follows its
  content types:
  - text stays text;
  - an inline image stays native when a provider can take it: png, jpeg,
    gif or webp, within 5 MB decoded;
  - audio, binary resources, other images, and media with inline data but
    no type are saved to the workspace (`tool-results/`), each under a
    unique name, with a bounded stub saying where. If a payload can't be
    saved, the result is reported as incomplete (`isError`), noting the tool
    may already have completed, never as a success with part of it missing,
    and the host's log says why the save failed;
  - a failed result is read as its text alone, so there an inline image is
    saved and stubbed like any other payload;
  - a `resource_link` is shown as a link, with its name and URI, and never
    fetched;
  - an embedded text resource shows its text;
  - an unknown block is shown as JSON, bounded, saying how much was left
    out. A malformed entry is named and left out, and content that isn't a
    list of blocks makes the result a failure.

  Before, any non-text block turned the whole result into raw JSON.
  `structuredContent` is kept by presence on the new `ToolResult.structured`
  (`false`, `0` and `null` are values). The model sees it as JSON when the
  server's content has no text block of its own; a structured-only result
  used to reach the model as an empty string. MCPL peers keep their RFC-005
  reading and gain `structured`.
- A script whose tool call returns `structuredContent` receives the
  server's result itself, as one JSON object: `{ content, structuredContent,
  isError, error? }`. From a server that isn't an MCPL peer, `content` is the
  blocks as sent, so images and other payloads survive. `structuredContent`
  is the tool's own JSON, as sent. Content that is present but isn't a
  list of blocks, from such a server, is the malformed result the model
  reads (`isError`, with the malformed notice as `error`), its structured
  content kept, where it was an empty success.
- An MCPL peer's blocks in a script's `content` get the treatment every
  lane the model reads gives them, since what a script prints comes back to
  the model. An RFC-005 reference arrives without its URI, as the host's
  reference id (`refId`), what the server said about it in that block
  (`name`, `mimeType`, `sizeBytes`, `digest`, `expiresAt`, with control and
  bidi characters stripped from the text fields, as in the model's stub),
  and `savedTo`, the workspace path the framework fetched its payload to for
  the script (`null` when it couldn't; `fetch_reference` takes the id as its
  `ref_id` argument). An unsaved reference that counts as expired also
  carries `expired`, the reason the model's stub gives, and isn't fetched.
  A block the classifier rejects arrives as the notice the model reads in
  its place, and inline data that also claims a bulk disposition as the
  withheld notice. #181, by @Meganeuridae, first
  found scripts losing `structuredContent`, and it kept the saved paths of
  RFC-005 payloads for them by falling back to the text rendering. Here the
  paths are in the structured object, as `savedTo`.
- If a script's structured result would exceed the 5 MB script cap, the
  framework saves it to the workspace and the script gets
  `{ isError, oversized: { chars, savedTo } }`. If it can't be saved, the
  script gets a failure that says the tool may have completed. Results
  without structured content keep the existing script contract.
- A result that can't be converted to JSON, such as a cyclic object or a
  `BigInt` from an in-process module, reaches the script as an error that
  names the tool and says the call itself completed: for a structured
  result, the object above with `content: []`, `structuredContent: null`,
  `isError: true` and the `error`, and `Error: …` otherwise. Before, the
  script got the runner's bare error, such as `Converting circular
  structure…`.
- The `code_execution` tool's description now says what a script's tool
  function returns: the text, or for a structured result the JSON object
  above, with references and the oversized form. These two changes, and an
  end-to-end test with real Python adapted from #181's, come from
  @Meganeuridae's review of this change against #181.
- The direct tool path (`executeToolCall`, `ModuleContext.callTool`) adds
  `structured` to an MCP tool's result, success or failure, when the server
  sent `structuredContent`. A modern server's result reaches it as an MCPL
  server's does: an error result is a failure with its text, and a success
  is the server's content array as `data`.
- Closing a stdio MCP/MCPL server now waits for the child to exit, sending
  SIGKILL after 2 s. A child still alive 2 s after SIGKILL fails `close()`
  with an explicit error. Before, close returned as soon as a signal was
  sent. `stop()` still finishes shutting everything else down after such a
  failure, and then rejects (see the breaking notes). Concurrent `close()`
  calls share one teardown, and a
  later call re-checks a child that couldn't be reaped. A launch whose exit
  can't be confirmed is never orphaned, and nothing launches beside it:
  - `McplServerConnection.connect()` and `connectWithReconnect()` throw the
    new `McplUnreapedLaunchError`, whose `connection` owns the launch; its
    `close()` retries the reap. A reconnect attempt halts the loop instead
    (`reconnect-failed`, `permanent: true`). Reconnect attempts run one at
    a time, and never start before the previous child has exited.
  - `reconnectAfterFailure()` on a connection without reconnect ends it
    with `close()`, so a child it can't reap stays owned.
  - `close()` during a reconnect handshake ends that launch before it
    resolves, a WebSocket dial still opening included. In the framework,
    `stop()` and a disconnect of the id end a first connect still in its
    handshake the same way, and a WebSocket dial still waiting for its
    access provider: `connect()`, `connectWithReconnect()` and
    `McplServerRegistry.addServer()` take an optional `AbortSignal`, and an
    aborted `connectWithReconnect()` makes no retry stub.
  - `McplServerRegistry` holds an id until its child is confirmed exited:
    `removeServer` frees it only once the close succeeds, a second
    `addServer` for an id still connecting is refused, and `closeAll()`
    keeps each connection it couldn't reap, reporting every failure.
  - In the framework, a disconnect or failed connect whose cleanup can't
    reap the child keeps the server registered, closed and listed as
    disconnected, and its error says so; its tools leave the agents' list.
    A connect for that id is refused until a disconnect, retried once the
    child is gone, confirms the exit and completes the removal. A failed
    startup connect that leaves such a child raises the `mcpl-down` ops
    alert.
- One owner per server id, across both families: a connect is refused while
  another connect for that id is in flight (a legacy handshake included) or
  a disconnect is still tearing it down. A disconnect closes a registered
  connection immediately, and a legacy connect still handshaking is cleaned
  up when its handshake settles (a modern connect in flight, or such a
  legacy one, fails with "was not connected"); then it removes what was
  registered. A teardown never removes what a later connection registered.
  `restartMcplServer` refuses, before it tears the running server down, what
  its connect would refuse: whatever the configuration check refuses (such as
  an unusable binding, userinfo on an http(s) url, or MCPL policy that asks
  for what a modern server lacks), a new id another server holds, a tool
  prefix another server or a module holds or that meets another server's, a
  framework whose `stop()` has begun, and a connect or disconnect of the
  server in flight. Before, a restart disconnected first,
  so a refused connect left the server gone; now the server keeps running.
  From those checks through its connect, the restart holds the id and the
  tool prefix it moves the server to: a connect or a restart started
  meanwhile is refused them, or a prefix that meets that one, and a module
  added meanwhile is refused that prefix, each naming the restart, rather than taking them while the old
  server is torn down. The id and prefix it moves the server from are free
  once its disconnect is done. A disconnect of the id it moves the server
  to (its own, for a restart under the same id), or a `stop()`, that begins
  during the restart ends it, as a disconnect ends a connect in flight, and
  the restart's error says the server is down. A restart whose connect
  fails leaves the server down, configured under the new configuration and
  its id, and holding its tool prefix, as any failed connect does: it's
  listed as not connected, and a restart or a disconnect under that id
  tries it again or removes it. `addModule` also refuses a name a
  server's tool prefix holds, as `create()` does at startup. A disconnect
  releases the tool-prefix claims its own server holds. Treat a submitted
  configuration as immutable while the server uses it: change settings with
  `restartMcplServer(id, newConfig)`, and rotate a network server's
  credentials through `accessProvider` (a stdio server's changed `env` goes
  through a restart with the new configuration).
- A server configuration naming no usable transport is now an error before
  anything is spawned or dialed. That covers a `transport` that doesn't
  match the url's scheme, `transport: 'http'` without a url, and an
  unrecognized scheme. `McplServerConnection.connect()` and
  `connectWithReconnect()` apply the framework's whole check (so `protocol`
  on a WebSocket url is refused too), and a configuration error is never
  turned into a retry stub. `openTransport()` and `isWebSocketTransport()`
  decide by the same rule, so an http(s) url is never dialed as a WebSocket.
- A configuration error, a WebSocket dial failure and `listMcplServers()`
  show a server's url redacted, since a credential may ride in it: no
  userinfo, each query parameter's value replaced, and so is a path
  segment that looks like a credential (16 or more characters with a
  digit, as a token or uuid has, or 32 or more of anything), such as the
  per-user secret some hosted servers put in the path. A url that doesn't
  parse isn't shown. An `accessProvider` that throws is logged by
  its error's class and its message's length, not its text, which may quote
  the credential.
- `listMcplServers()` lists a configuration that connecting would refuse
  with `refused`, which says why and is the verdict to read. Its `family`
  and `transport` are null only when the configuration names no usable
  transport, where the listing guessed a legacy binding before. A usable
  binding refused for something else, such as an https url with
  `requestTimeoutMs: 0`, keeps them. Its `policyEstablished` is null for a
  modern server, which has no MCPL policy.

- The MCPL texts an agent reads for a failed request, a refused tool call and a block the host can't show now say what happened, whether anything took effect, and what works from there, or that nothing does. Method names, request ids, JSON-RPC codes, close details and field names leave them. The ones an operator needs go to the host's log.
  - **A failed MCPL request:**
    - A connection that closes with a call pending reads `The connection to the "<server>" server closed before it answered, so whether the request took effect is unknown.` It then says whether this host is reconnecting, where it read `MCPL server "<server>" disconnected unexpectedly (code=…, signal=…, reason=…) while awaiting <method> (id=N)`.
    - The other texts change the same way: a close by this host, a request on a closed connection or one the transport couldn't write, a server's error answer (in the server's own words, or, with none, saying the outcome is unknown) and a timeout.
    - The log gains a line for a close with requests pending, with the close's code, signal and reason, whether this host closed it, and the requests left unanswered; one for a server's error answer, with its method, id and code, and its message, whatever JSON value it is, with any credential the server's configuration holds replaced, where the caller's text keeps the message unredacted; one for a timeout, with its method and id; and one for a request the transport couldn't write, with its method, id and the transport's words.
  - **The framework's MCPL tool calls:**
    - A call to a server missing from the registry, or to a tool its policy denies, says it didn't run and whether anything can change that, in the same words for the model's call and a script's. One made while this host is connecting to the server, in a runtime connect or a restart's, says so and to try again in a moment.
    - An error result with no text, or only whitespace, reads as one whose effect is unknown, where it read `Tool call failed`, or the blank text.
    - A conversation's `channel_open` is told where to reply.
  - **Blocks the host can't show** read as what they were and why: `[Image not shown: …]`, `[Audio not shown: …]`, `[Reference not shown: …]`, `[Content not shown: …]`, and the text marker `[Text not shown: a text part arrived without readable text.]`. They had read `[Image: no data]`, `[unrecognized content block: …]`, `[inline content withheld: …]` and `[Text not shown: the server's text block had no string text.]`. An image or audio block with an empty link and no data reads as the no-data marker on the tool-result lane too.
  - **A reference's expiry and missing server** read `expired`, `treated as expired, since its expiry time can't be read`, `treated as expired, since its expiry time isn't in a form this host accepts` and `not tied to any server, so there's nowhere to fetch it from`. They had read `expired: its expiresAt has passed`, `… (fail closed)` and `unbound: no server is recorded to fetch it from`.

- A silent heartbeat tick's instruction now rides the tick's request-only
  separator instead of a system-position injection, so a tick's request
  carries the agent's own system prompt, like every other turn. A system
  prompt that changed for one turn cost the heartbeat's request its prompt
  cache from the system on, and on a provider that binds signed thinking to
  the prefix it was minted under (context-manager #155) it failed every
  retained thinking block in that request, and the tick reply's own thinking
  at the next ordinary turn. `SILENT_HEARTBEAT_SEPARATOR` is now that
  instruction (199 characters where it was 16, roughly 50 tokens at each
  tick whose rows survive in the window). Each tick's rows now record the
  separator their request rendered (`SilentHeartbeatStamp.separator`), and
  later compiles render that text, so ticks stored before upgrading keep
  their `[heartbeat tick]` marker byte for byte: no stored reply's prefix
  changes. (`InferenceRequest.ephemeralSystemPrompt` is removed; see the
  breaking entry.)
- A tick whose restart compiles none of the tick's rows (a strategy folded
  them all) opens again: the restart's request ends on the separator, where
  later compiles render it before the restart's reply. It used to end on
  `[Continue]`, and later compiles put the separator before a reply whose
  request never held it.
- When a compile ends on the agent's own message and the request gets a
  trailing `[Continue]` turn, the reply's rows (its assistant responses and
  tool results) now record that prompt (`metadata.promptedBy`, a
  `{ turn, text }` pair), and every later request renders `[Continue]`
  again just before the first of its assistant rows that survives, the way a
  silent tick's separator is rendered. A later reply follows the same prompt
  when what it is sent ends on the tool results of a reply that did: a next
  round of the stream, a budget restart, an error retry, or a new process
  reading the stored rows. A reply sent anything else after those results,
  such as a message that arrived at the tool boundary or during a provider
  cooldown, follows that instead and records no prompt. Without the turn,
  later requests merged the reply into the previous assistant message (one
  message carrying signed thinking from two responses, a 400 when it is the
  latest), and dropped a turn the reply's request held, which a provider
  that binds thinking refuses. A reply with neither a tool call nor signed or
  redacted thinking can't be found in a compiled window and merges as
  before. `StartStreamResult.continuePrompt` carries the prompt a stream's
  request ends on (new, optional); the agent sets it. The direct
  `runInference` paths compile without these request-only turns, as they
  did without the tick separator, so their replies render none.

### Fixed

- Failed backscroll requests preserve the registry's known-open state rather than claiming a close. Automatic delivery joins pending lifecycle work without reopening a channel closed during the wait. A delivery or reply is announced as opening a channel, with the current registration label, only when the channel wasn't already decided open or tuned out; reconfirming the transport of a channel that was isn't announced. Speech engages a channel decided closed as a reply does, even while a failed close has left its transport open, wherever the server's grant lets the host open it. When `channel_open` fails for a channel that isn't open and is still decided open, its error says the channel stays selected for opening, since that decision outlives the failed round-trip and a later delivery or reconnect tries again.

- Channel lifecycle operations now run in order per channel and reconcile the latest desired state and registration after an in-flight operation completes. Successful reconciliation confirms the current target and desired state at its receipt boundary; a superseded tool request reports that its requested state no longer applies. Automatic delivery preserves active tune-out attention state while opening or awaiting transport. A registration batch reconciles its channels side by side, so one held RPC doesn't delay its siblings. Removing a server cancels its queued lifecycle operations, and the framework removes its channel entries before closing its connection, so nothing queued runs against a closing connection or a later re-registration.

- A channel's transport state is known only from a receipt for its current registration, connection, type, and address. A channel a registration creates or replaces, a retarget, a substitution, or a failed open or close leaves it unconfirmed: failed corrective opens fail joined delivery, while a same-target backscroll failure keeps a channel that was open usable. Incoming traffic confirms nothing unconfirmed (after a retarget it may still come from the old subscription), and it marks a channel open only while that channel is decided open or tuned out, so a close receipt stands. Explicit close, and declining an invitation, close an unconfirmed target for real instead of reporting it already closed. A retarget of a channel decided open or tuned out opens the new target.

- Lifecycle convergence makes at most five transport attempts per operation. Continued descriptor/intent supersession fails with a diagnostic, releases the queue, and gives joined speech or reply preparation a visible failure instead of hanging. Later stable operations can retry.

- A `channels/open` answered for a different channel than the one requested, by the answer's `channel.id` or a history item's `channelId`, compared exactly as the server's traffic is, fails the open. The requested channel isn't marked open (its open state becomes unconfirmed), nothing in the answer is used, its history included, and the host logs `[channel-open-substituted]` and emits an `mcpl:channel-open-substituted` trace, whose `answeredFor` is the answered id as the log line prints it, escaped by `logValue`. When the channel the server opened instead is registered and its desired state is closed, the host closes it again, so its traffic doesn't reach the resident. A substituted answer on a receipt already made stale by retargeting is retried like any stale receipt. An answer that names no channel, by a null id or none, is accepted as before; one whose id isn't a string fails the open the same way, with nothing to close. Either rollout order is safe: on a server that still falls back, the resident sees a failed open for an id that server no longer knows (a deleted channel), rather than another channel's traffic. `ChannelsOpenParams.channelId` is documented as exact: a server that doesn't know the id should refuse.

- A tool name an MCPL server lists more than once reaches the model once:
  the server's first listing is offered and the rest are left out (#265).
  The model's tool list carried the name twice, which membrane's native
  formatter and Anthropic's API refuse. Each tool refresh that finds such a
  listing raises an `mcpl-tool-duplicate` ops alert naming the tools; its
  webhook post goes out at most once per server in 15 minutes.

- A `gate.json` or privileged-users file saved as UTF-8 with a leading BOM
  now loads. Before, `JSON.parse` rejected the invisible U+FEFF, and the gate
  reported an error and didn't apply the file (#395).

- An ephemeral run (a subagent) no longer posts its plain prose to whichever
  channel last received a message (#551). That channel, the process-global
  fallback, was the locus of any `locus` or `hybrid` run with no channel of its
  own, so delegated work, possibly drawn from a DM, could land in an unrelated,
  possibly public channel. No ephemeral run takes the global fallback now,
  whatever its prose routing:
  - a `locus` or `hybrid` run's plain prose with no channel of its own is
    returned to its caller as before and published nowhere; a sleep
    announcement it makes is published nowhere too. Neither counts as a failed
    delivery, so neither writes a `[send-undeliverable]` notice, an
    `mcpl:speech-route-failed` trace or a log line;
  - `channel_publish` without a `channelId` is refused, with words saying to
    name the channel;
  - its channel context has no `incoming` message, and no default outgoing
    channel unless it opened one itself;
  - a refusal of its inference adds no reaction anywhere, and its
    `failures.log` record names no `locus`.

  A channel the run opens itself, and a destination it names in its prose
  (`hybrid`'s `>>>`, `explicit`'s `>>`), still route as before. Residents and
  conversation forks keep the fallback. `channel_publish`'s description now
  says where an omitted `channelId` goes: the conversation's bound channel,
  else the most recent incoming one, and nowhere for a subagent.

- Enforce each registered agent's allowedTools before model, script and public agent-origin dispatch, including utility names inside utils run. Filter utility list/describe to the same executable names. Refused calls retain paired error results without inner lifecycle state. A refusal withholds a call's effect, never the model's choice about its own words: a refused send changes nothing about prose, so its round and what follows go out; a `skip_reply` that a round calls itself (not one a `code_execution` script makes) keeps that round's prose private and silences nothing after it, as a refused wake already did, when the agent's allowedTools doesn't name it, another module's namespaced `skip_reply` included, or when it's the registry's own `skip_reply` asking for a wake this host can't set; and a refused `think` is read as a permitted one is, so the private same-round policy keeps its round private wherever it applies, which is where rounds are routed live. Framework-created identities (ephemerals and conversation forks) have no tool authority while unregistered, including after disposal; genuine unregistered legacy callers and trusted module closures retain their behavior. Prose primers and bounce notices advertise prose_help only when permitted, and `think`'s and `journal`'s descriptions tell an agent to call `skip_reply` only when it may. `think`'s result and `prose_help`'s reference no longer point at the `skip_reply` tool.

- A turn woken only by deferred coalescing batches is withdrawn before inference in more of the cases where it used to call the model with nothing new to read: its batch was retracted or replaced after the wake was taken (the replacement or the retraction's notice wakes agents as any push does, by its own `triggerInference`), its batch was being rendered for another agent's assembly (the turn waits for that render, which the other agent's request reads), or the render was placed in another agent's deferred queue because that agent's turn was running. In that last case that agent is now woken for the render, as the batch's own wake would have woken it; before, nothing woke it for the render. When several agents are woken for one batch, the first assembly consumes it, and the others' turns already taken from the queue are withdrawn, as their still-queued wakes already were. A turn woken by a batch that a provider hold kept after its call failed is now retried with its own trigger when the hold ends, even if a newer batch of its subject arrived meanwhile. Before, the newer batch withdrew it, and the agent's next turn came from the newer batch's wake or, with nothing left held, from a fresh compile that names no channel or author.
- When one agent's queued wakes merge into one turn, the turn's trigger now carries a coalescing subject only when it is every merged wake's, so a withdrawal of that subject's wakes, such as a retraction's or a newer batch's, takes the merged wake only when that subject was its sole cause. Before, the merged trigger carried its first wake's subject, and such a withdrawal, landing while the merged wake was held or requeued before its turn started, also dropped the wake's other causes, such as an ordinary message.

- On a host with no primary (`agents: []`), a write with no target goes to the
  first registered agent, such as an ephemeral run. Deferred, it now names
  that agent in its queue entry, so it is that agent's as a targeted write is:
  the agent's own flushes store it, and so does its window's release when it
  leaves. Before, the entry named no agent, so neither the run's flushes nor
  the run's end took it: after the run it was still queued, unstored, and in
  the recovery file when the queue was persisted.
- Boot recovery numbers the restored deferred-write queue 1, 2, 3, … in the
  order it restores it, and later deferrals are numbered on from there.
  Before, it kept each entry's `seq` and numbered only the entries without a
  valid one, after the largest, so the counter went on from the largest valid
  `seq`: one at `Number.MAX_SAFE_INTEGER`, which boot accepts, gave every
  later deferral the same `seq`, 2^53. A recovery file whose `seq`s are all
  valid isn't rewritten at boot for the new numbers; the queue's next write
  carries them.
- At a tool boundary, a deferred message that the strategy stores as more than
  one message (a sharded body) is now injected as later compiles render it,
  its shards joined. Before, it was injected as given, so a body of more than
  one text block, or with a non-text block after a text block, reached the
  stream in a different shape from later requests.

- Under `proseRouting: "disabled"`, the turn-end receipt now reads `[delivered] plain speech → no channel — N plain-speech segment(s) kept in the transcript (…)` instead of `[delivered] nothing — N plain-speech segment(s) suppressed (…)`, which read to a resident talking with its operator through a console or Web UI as if its replies had reached no one (#225).

- A Discord message is no longer stored twice when its live create and the history sync both reach it. The sync stored a message it fetched while the live path was still converting the message's attachments, or while its create waited to be handled, and the create then added a second row. Now the live path keeps each create on record from the moment it takes the message up until the store shows its row, stored or held (a held write's row shows at once), and the sync stores none of those. A second delivery of a message whose create is still on its way is ignored. A create whose message a sync stored first adds no row, and still sets the reply context and asks for inference as before. Where a message was already stored twice, a live edit and the sync both change its first row, where the sync changed the last, and a delete, live or found by the sync, removes every row of the message.
- A message deleted before its create was handled is no longer stored, and no longer wakes the agent. A delete that came while the live path converted the message's attachments was handled first, found no row, and the create then stored the message. One that came while the create waited in the queue was handled after it, so the agent could be woken by, and answer, a message its author had taken back. Now the create is dropped: no row, no reply context, no inference.
- An edit that comes while the live path converts the message's attachments is no longer lost. It was handled before the create, found no row and was dropped, so the message kept the text it was sent with until the next history sync. Now it's folded into the create.
- An edit that removes an attachment now removes its block from the stored message. The client passed an edit's text alone, so the image, file text or note of an attachment the edit took away stayed in the row until the next history sync, which runs when the client becomes ready. The client now passes the edit's attachments, for a message discord.js had cached, and a message stored with its text first drops the block of each attachment it no longer has: an image by its URL, a file's text by its header and a note by the filename it opens with, whatever its words after it. A block that may stand for an attachment still there stays, such as one of two files of one name. An edit that adds an attachment, which Discord's API allows, is still left to the history sync, as is a message stored before its text came first.
- A stopping module writes nothing. A create still converting attachments when the module stopped reached the stopped module's context and failed with a TypeError, in a promise nothing awaits. Now nothing is written for it, nor for a message that arrives or an event the framework hands the module while it disconnects.
- Host authors: `DiscordClientInterface.onMessageEdit`'s handler takes an optional third argument, the edited message's attachments as the edit left them. A custom client that passes two arguments keeps today's behaviour: a stored message keeps its attachment blocks on such an edit. `DiscordEditEvent` gains the matching optional `attachments`.

- **The workspace's disk reads refuse a mount root that isn't the mount's
  directory.** `readFileFromDisk`, `readBinaryFromDisk` and `read_image` read
  whatever was at a mount's root path, so a root renamed away and replaced by
  a link to another directory, or by another directory, was read as the
  mount. Once the workspace has recorded the root's identity, with the first
  evidence it gathers there, such a root is refused as `mount_unavailable`,
  in the words a sync uses for it, until a sync with `acceptRoot` takes it.
  A root that is gone, or is a file, is `mount_unavailable` too, with errno
  ENOENT or ENOTDIR, where it was "File not found". A root that changes
  during a read, until the file has been opened and checked, gets the same
  code and errno as one changed before the read.
- **`readBinaryFromDisk`'s `maxBytes` bounds the read itself.** A file that
  grows past it after the read's size check is refused as "File too large",
  having loaded at most `maxBytes` bytes and one more, where it was read
  whole.
- **Two opens no longer wait on a FIFO.** A directory's sync after a push
  opened the directory blocking, so a FIFO put at its path held the sync
  until something opened it for writing. The tool presentation file's read
  did the same, synchronously, holding the whole process. Each now opens
  without waiting, and refuses what isn't a directory or a regular file.

- `WorkspaceModule.readFileFromDisk` and `read_image` no longer wait on a FIFO in a mount until something writes to it. They refuse a FIFO, socket or device without opening it, with "Not a regular file: <path>" (`readFileFromDisk` with the code `not_found`), where they waited for a writer on a FIFO and gave other words for a socket or device. One reached through a symlink the mount follows is opened without waiting and refused the same way.

- A reference whose address carries a user name or password is refused before anything is dialed, in words that don't repeat them. `fetch` refused such an address before connecting, with a message holding the whole address, password included, which `fetch_reference` gave the agent as its error, and the host's log carried it when the eager fetch tried it.

- Notices about an agent's own action now reach the window that agent reads, deferred against that agent's own turn, stream and tool cycle (#188). Exceptions: a failed reply its speaker will never read, and a channel an ended agent's send opened, are told to the primary by name; any other notice for an agent no longer registered goes nowhere, logged.
  - The notices: a failed reply (`[discord-send-failed]`), bounced prose (beside its `{{unsent}}` clipboard), the notices about the agent's drafts (a draft held at once, an `{{unsent}}` that names nothing or a draft it can't send, a resend whose outcome couldn't be recorded, and `>>skip_reply {{unsent}}`'s), a background script's wake, and a channel opened by the agent's own send. A channel opened by subscription policy, with no agent behind it, is still announced to the primary.
  - A conversation fork's or an ephemeral run's notices land in its own window instead of the primary's. In connectome-host this moves a subagent's notices from the primary, where the default path put them, to the subagent.
  - A resident's notices are addressed to it too, in the slot the residents share, and wait on its own turn rather than the primary's. Whether it may land there while another resident's turn is alive is the question of #291.
  - When a fork or an ephemeral run is released, each failed-reply notice it never read is passed to the primary, once, by name, in the words of the speaker's own notice: "A reply by `<name>` (N chars) could not be delivered to … (…). Nothing was posted. `<name>` has ended.", or, for a delivery that wasn't confirmed, "Delivery of a reply by `<name>` (N chars) to … was not confirmed (…). It may or may not have been posted, so sending it again could post it twice. `<name>` has ended.", with the connector's detail when there is one. Never read means still queued for it, or stored in its window above its consumed watermark: after its last compile, and after the last tool boundary whose stream declared it carries the messages injected there. After a branch switch, only what both branches share up to the point they part counts as read. The same goes for a delivery that fails after its speaker is released, and for such a notice restored at boot whose agent is gone; a notice still queued goes on as that same queue entry, so a crash before its ack passes it on once. That notice's metadata carries `speaker`, and the delivery's `outcome` and `detail` as the speaker's notice had them; every failed-reply notice's metadata now carries `textLen`. With no primary registered, no one is told, and it's logged. A host stopped while quiesced, before a fork's or run's window release, queues the primary's notice of each failed reply that window holds unread, for resume or boot.
  - A channel opened by an agent's own send after that agent has ended (an ephemeral run's final reply is routed after the run settles) is announced to the primary, by name: "Now open: … — opened by `<name>`'s reply; `<name>` has ended.", with the `channel_close` line. Its metadata carries `speaker`. With no primary registered, no one is told, and it's logged.
  - Writes still queued for a fork or an ephemeral run when it is released land in its own window, which Chronicle keeps, with one acknowledgement once a failed reply among them has gone on to the primary. A fork or run that ends while the host is quiesced is deregistered at once, and only its window's release waits for resume, which lands them then; no other flush takes them meanwhile. A write addressed to it meanwhile is treated as for any agent no longer registered.
  - The fallback reaper no longer disposes a closing fork whose turn is still alive before its stream has registered.
  - Any other notice or background-script wake made for an agent that is no longer registered is dropped, logged once, with no trace and no wake.

- `USERNAME` joins the child-env allowlist, beside `USER` and `LOGNAME`, so a Windows child gets its user's name, as a POSIX one does. Python's `getpass.getuser()` tries `LOGNAME`, `USER` and `LNAME` before `USERNAME`, so without it, it raises on a Windows host that supplies the name only through `USERNAME`, in stdio MCPL children and the code-execution interpreter alike.
- A code-execution script's output that UTF-8 can't encode, a lone surrogate such as Python makes of a filename byte that isn't UTF-8 or of a `\ud800` JSON escape, reaches the host as U+FFFD. Before, the interpreter could fail to send the script's result, which then waited out the script's deadline.

- The Discord module's tools now tell the agent what Discord refused and what to do instead. An id Discord doesn't know (Unknown Channel, Unknown Guild, Unknown Message, Unknown User), a channel, server or user the bot can't reach (Missing Access), a missing permission, an unknown emoji, an edit of someone else's message and a direct message the user doesn't take each read as "Nothing was sent", "Nothing was edited" and so on, with the call that shows the right id or whom to ask; before, the agent read Discord's bare words, such as "Unknown Channel". Any other refusal from Discord keeps Discord's words after the same lead. A `delete` of a message that isn't there says it's deleted or the id is wrong, without saying nothing was deleted, since a retried request of the call may have deleted it. A refused `reply` names the channel and message its reply context points to, and says `set_reply_context` changes them. What discord.js refuses itself, before it sends a request, reads the same way: a thread asked for on a message whose channel can't hold threads, or on a message that already has one (named, with how to post in it), and a reaction that isn't an emoji, which says Discord wasn't asked. A thread Discord says the message already has, from a repeat call or a retried request it had carried out, reads as there, with how to post in it; after a send, the send's error says so. A channel that holds no messages, such as a category, a forum or a media channel, is named as what it is, and an unknown channel's id says threads aren't listed by `list_channels`. An error that isn't a refusal, such as a network failure, reads as an unexpected error: for `send` and `reply` it says the message may have gone out and which channel's history shows it (for `reply`, the channel it posted in as it was sent, or, when its reply context names an empty thread id, how to put that right), for `dm` that sending again may send it twice unless an earlier `dm` to that user gave its channel's id, which `dm` now returns, and for the tools that change something that calling again is safe. A lookup that stops on such an error, before a tool changes anything, says nothing was done: a send's of its channel, a `dm`'s of its user and their direct message channel, and the message an `edit`, `delete`, `react` or `create_thread` acts on. One of those four that names an empty message id is refused before any request, with `fetch_history` as the way to find the id; it used to stop on discord.js's error. `list_channels` loses two refusals that couldn't be reached, and its description now says threads aren't listed. That changes the tool definitions every request carries, so each agent's first request after upgrading misses the prompt cache.
- A `send` with `createThread` whose message went out but whose thread wasn't started now says the message was sent, with its id and the `create_thread` call that starts the thread, so the agent doesn't send it again. A thread asked for in a channel that can't hold one, such as a DM, is still skipped with a successful result, whose data now carries a `note` saying no thread was started and why.
- The Discord module's rate limit refusal says how many seconds are left in the channel's window and what the limit is, rather than "Rate limited". A reply into a thread says the limit is its conversation's channel's. `reply` without a conversation, and `activate` and `deactivate` before the module has started, say what happened and what the agent can do. The notice for a text attachment that couldn't be fetched, which read `[Attachment: <filename> (failed to fetch)]`, now says its text isn't in the agent's context and to ask the sender in the channel to paste it, and the note for an attachment the host doesn't read in says the same of its contents. A text file of 100,000 bytes or more now says it's too large to read in, where it read as any attachment the host doesn't read in. A message stored with the earlier words keeps them until the history sync stores it again.
- An unknown tool name for the `discord`, `health` or `api` module says there's no such tool and lists that module's tools, read from its own `getTools()`. The health snapshot asked for before the host has bound the module tells the agent nothing was read and to ask whoever runs the host, and prints the host's missing `bind(framework, store)` step on a console line.
- **Client authors:** `DiscordRefusal` is exported. A `DiscordClientInterface` implementation that throws one has its message passed to the agent as it is; anything else it throws is worded as an unexpected error. `DiscordJsClient`'s `sendMessage`, `sendDM`, `editMessage`, `deleteMessage`, `addReaction`, `createThread`, `listChannels` and `fetchHistory` now throw a `DiscordRefusal` in three cases where each threw something else: Discord's refusal, a `DiscordAPIError` (kept as the refusal's `cause`); discord.js's own refusal of a thread or an emoji; and a channel that holds no messages or that discord.js returned as null, for which they threw an `Error` of their own. `sendMessage`, `sendDM`, `editMessage`, `deleteMessage`, `addReaction` and `createThread` also throw one when a lookup before their change stops on an unexpected error, such as a network failure. `fetchMessage` and `sendTyping`, whose failures reach only a console line, keep their errors. `sendMessage`'s `threadFailure` is worded for the agent, and it resolves with a `note` when the channel can't hold the thread asked for. `sendDM` resolves with the direct message channel's `channelId` beside the message's id; a custom client may leave it out.

- A stream that reports the framework's own cancel as an `error`, by just closing, or by
  throwing, now ends an endTurn or a budget restart the way an `aborted` one does. After
  an `error`, neither is traced as `inference:failed`, logged as a failed inference, or
  handed to the error policy. After a throw, neither is traced as `inference:failed` or
  `inference:exhausted`, or leaves an "[inference-failed]" note in the agent's context.
  In every shape, the stream's §10.5 lifecycle terminal reads `aborted`, an endTurn writes
  its delivery receipt and starts the continuation it was asked for, and a budget restart
  keeps the event gate's window open for its new stream, which takes over the turn's
  typing and streamed message. A stop, a quiesce abandon or a caller's stop over a stream
  that throws ends as one, as it already did over the other shapes, and the throw is said
  on the console. A stream that reports its cancel as an `error` and then throws ends
  once. membrane's yielding stream reports a cancel as `aborted`, so this reaches other
  stream implementations.
- A budget restart whose new start fails before its stream exists, such as on a store
  write, no longer leaves the agent's window open at the event gate, which kept every
  gate event buffered, for every agent. This happened with membrane's `aborted` restarts.

- **An inference whose stream fails now ends its `inference/lifecycle` with
  `failed`, where it ended `completed`.** An MCPL server granted
  `inferenceLifecycle` was told that such an inference completed. Three
  endings change:
  - an `error` event that ends the turn;
  - an `error` event that is retried. The retry is an inference of its own,
    with its own `started` and terminal, and a retry that `stop()` cancels
    leaves the failed inference `failed`;
  - an `aborted` event whose reason isn't `user`, such as `timeout`.

  The endings a stop or the framework's own cancel accounts for still end
  `aborted`, as before: an `aborted` event with reason `user`, an `error`
  event after a caller's stop, and an `aborted` or `error` event after the
  framework's cancel.

- A runtime connect, or a restart of another server into an id whose connect is still in flight, in either engine, is now refused before it changes anything, with `MCPL server "<id>" has a connect in flight; try again once it settles`, until that connect lets go of the id, just before it lists its tools. Before, a second connect went ahead beside a legacy one, and whichever settled last replaced the other in the registry without closing it. A disconnect of the id now ends the connect in flight and removes whatever it registered. Before, the disconnect removed the server's config and tool prefix, and the connect then registered the server without them, where no call reached it and only another disconnect cleared it.

- An MCPL server that reconnects now has its channel registration accepted.
  A reconnect resets the server's grant, and its traffic used to reach
  admission before the host's new §5.3 policy Request was answered: a
  `channels/register` sent right after initialize, as chat bridges do, was
  refused (-32002) and never replayed, so the route's incoming messages
  stayed unknown channels until the server registered again. A reconnect now
  holds control traffic as well as data until the new grant is established,
  as initial connect already did, both for a connection that was open and
  for one whose first connect had failed. It holds them whatever gate
  completes meanwhile, though each gate's completion opens every
  connection's planes: startup's staged open, a quiesce resume, an awareness
  sync, or another server's list change or reconnect. A runtime connect
  holds its planes the same way, through its awareness accounting too, and
  runs its exchange only on the transport it registered: if a reconnect
  replaced that transport meanwhile, the reconnect's exchange covers the new
  one, and the server is announced once.
- A policy answer that arrives after its transport closed grants nothing,
  whether to the initial policy Request or to one after a manifest change,
  and a manifest fetched from a transport that has closed isn't installed,
  nor a refresh queued on it run on the next one. A queued refresh's receipt
  reports the domains of the announcements it coalesced on its transport,
  each once, and the refresh limiter is kept per connection, so a connection
  that replaces a removed server under its id starts its own, where a timer
  of the removed connection could drop its replacement's queued refresh. A
  reconnect is still announced (`mcpl:server-reconnected`, `module:added`)
  once its attempt has settled, granted or not, and now also when another
  gate replaced its own before the awareness drain ended, where it used to
  go unannounced. A connect or reconnect whose transport drops before it's
  announced isn't announced: the close has reported the server gone
  (`module:removed`), and the next reconnect, if one comes, announces it.
  For a host that lists modules from the trace: a server whose first connect
  failed is added (`module:added`) once, by the first reconnect that's still
  connected once its attempt settles, granted or not, where it used to be
  added also when startup or a runtime connect registered it, and one that
  never connects isn't added. What a server sent about its own process that
  is still held when its transport closes, such as a request, a
  `tools/observe` filter or a channel registration, is dropped rather than
  admitted under the next transport's grant: the next process announces its
  own. So is such a message read from the transport after it closed, as can
  happen when a process a stdio server started still holds its stdout, until
  a reconnect attempt, if one comes, closes the transport's reader. A
  response read then is matched against none of the connection's requests,
  since the next transport numbers its own afresh, and, as any late answer,
  is surfaced as an orphaned response if it carries state, which waits, as
  the host's other reports do, for the control plane to open. A connection
  closed for good as its transport closes, by the host's close of a live
  connection or a drop with reconnect off, drops and logs the incoming
  messages and pushes it still holds then, and every request or notification
  it reads late, since no grant will come. Incoming channel messages and
  pushes still held, or read from the transport after it closed, are kept
  and admitted under the next grant, since a bridge that recorded them as
  forwarded won't send them again, and they stay held while no transport
  serves, even when a gate readies every connection meanwhile; the host's
  own reports about the transport, such as a `connect-failed`, go on.
  Requests kept this way don't count against the 10,000 held requests a
  server may have waiting, since no server waits on their answers any more:
  they have a bound of their own, the same 10,000, past which one is dropped
  and logged, so a dead process's backlog doesn't refuse the next process's
  requests. A channel registration the next process sends while they are
  still held is admitted ahead of them, so a kept message isn't refused as
  an unknown channel, unless it names a channel that an earlier removal, or
  an earlier registration kept in place, names: then it's kept in place too,
  so the writes to one channel stay in order. A removal stays where it was
  held, with whatever else it adds or updates, so when both planes open
  together, what the next process sent before one is admitted before it.
  While the host is quiesced its control plane opens first, so a removal is
  admitted then, ahead of the incoming messages still held, as live traffic
  is during a quiesce, and a message held for a channel it removed is
  refused when the data plane opens. A registration that arrives once the
  kept messages are admitted is too late for them, and a kept message for a
  channel the registry doesn't know is refused. An answer to a request from
  a closed transport is never written to the next one, whether the request
  was still held or its listener was still working when the transport
  closed, and neither is a streamed inference's chunk. A bridge that sends a
  kept incoming message again after reconnecting, because it hadn't recorded
  it as forwarded, can have it admitted twice; discord-mcpl records a
  message as forwarded before it forwards it.

- A module now reads, edits and removes the messages it writes while the framework holds them. The framework holds a module's writes while their agent has a turn alive or the host is quiesced, and stores them at a later boundary. A module's context answered such a write's id as `''`, its queries didn't see the write, and its edits and removals threw "Message not found". So a Discord message deleted during a turn stayed in the agent's history, an edit made then was lost, and a history sync could store a second copy.
  - **`ctx.addMessage`** answers a held write's id as a handle, `held:` and the write's id in the deferred-writes queue. `getMessage`, `editMessage` and `removeMessage`, and a process answer's `editMessages` and `removeMessages`, take it as they take a stored id. An edit changes the held write, and a removal drops it, so the agent never reads it. Once the write lands, the handle names its stored row. A handle whose write the framework dropped names nothing, as an unknown id does.
  - **`ctx.queryMessages`** answers the rows of held writes after the stored rows, marked `held: true` (the new `ModuleMessage` type), and `totalCount` counts them. A held row's `sequence` and `timestamp` are provisional, and change when its write lands. The writes a process held and the next one restores show once `create()` has restored them, which is after every module's `start()`: a module's `start()` doesn't see them, as before. A module that reads every row sees held ones too: connectome-host's retrieval module keeps its window to stored rows (anima-research/connectome-host#326).
  - **`ctx.findMessageByExternalId`** answers the first row under the external id where it answered `''` for a held write: the write's handle while it's held and its stored id once it lands, or an older row the module added under the same external id. The context still keeps `''` for a held write in its persisted map, which an earlier release reads back, and looks such an entry up in the store by the external id, held rows included. So an entry an earlier release left for a held write finds its message, and an entry it finds nothing for stays, as in a module's `start()` for a write the last process held. A stored id answers while its row is stored: once a process answer or a removal by handle has taken the row, the lookup answers `null` rather than that row's id.
  - A write a module or a process answer adds loses a `deferredWriteId` its metadata carries, such as one copied from a stored row: the framework finds a held write's stored row by that key.
  - The deferred-writes queue (`recovery/deferred-writes.json`, or `framework/deferred-writes` without one) records when each write was held (`heldAt`). An entry an earlier release wrote takes the time the queue is read back.

- A module tool's call that lacks a required argument, or whose input is
  there but isn't an object, is answered before the module runs with what to
  send, such as `Nothing was done: discord--set_reply_context needs
  "channelId" (a string), and this call gave none.`, every problem named at
  once. Before, the call reached the handler, which could fail deep inside
  with a `TypeError`, or run without it: `discord--set_reply_context` with no
  `channelId` left the reply context with no channel and answered success.
- The `utils` tool's check of a run's arguments reads the same way ("Nothing
  was done: …"), names every problem at once, and is still followed by the
  utility's schema. It now admits any type of a declared type list, where it
  refused every value of such a parameter; no longer checks the type of a
  parameter whose `type` names no JSON Schema type, such as `any`, or a list
  naming one, which it refused whatever it was (its `enum` is still
  checked); and takes a run of 16 or more digits sent as text for a number,
  passing it to the utility as text.
- The Discord module's `activate` reads a call with no input as no
  arguments, where it threw a `TypeError`.

- Where `fetch_reference` refused a reference from an MCPL server the host
  doesn't connect to over a network, such as a stdio server, as
  `unknown server: <id>`, it now says `this host doesn't connect to the
  "<id>" server over a network, so there's nowhere to fetch it from`. A
  server the host spawns from a command has no address either,
  even when its config also holds a `url`, on whose origin its references
  used to be fetched; nor has a WebSocket server whose `url` the transport
  won't dial: one that isn't a `ws://` or `wss://` url, or that has a
  fragment. A WebSocket server whose `url` has a fragment, which the `ws`
  library refuses to dial, now fails to connect with the transport's own
  error naming the fragment. `save_recent_image` now gives the reason a
  `fetch_reference` call naming no `max_bytes` would be refused with before
  dialing, and points at `fetch_reference` only where that fetch would go
  ahead. The eager fetch of the references in the result of an MCPL tool
  call the agent makes no longer spends one of its slots on a reference the
  fetch would refuse before dialing, such as one from a server whose fetch
  budget is spent, though it still joins a fetch of a reference already
  under way.

- `WorkspaceModule.readBinaryFromDisk` could read outside its mount through a symlink: it followed one at the path or among the directories on its way, wherever it led, whatever the mount's `followSymlinks` said. It now reaches a file as `readFileFromDisk` does, so it refuses a symlink the mount doesn't follow, and on any mount a file that resolves outside it, in `readFileFromDisk`'s words, before any size limit answers. Its own answers for a missing file, a file that isn't regular and a file over `maxBytes` are kept, with two changes: a path through a file, which gave the system's message with the absolute path, answers "File not found on disk", and a file this user can't read answers "Unable to read file" whatever its size.

- Server and transport text the framework records has the server's configured credentials replaced, in both engines: connection traces, console lines, stderr traces, the last of a server's stderr that a failed handshake keeps (in its trace and console line), the ops alert (and so `logs/failures.log` and the webhook), an MCP tool call that fails without an answer, as its caller and the model get it and in the `tool:failed` trace's message and stack. The credentials are those the configuration holds and those its dials sent: from the url as each dial sends it (a WebSocket dial sets the token in the query, which writes the whole query again, form-encoded, and an access provider's token can be in it), credential-like path segments and query names, credential-shaped or credential-named query values (each as written and decoded), every non-empty parameter as its whole `name=value`, and a WebSocket url's username and password, its userinfo as one unit before its `@` (the username alone when there's no password), with no length floor, so a short password goes with its username and a short username alone goes too, and the Basic credential a WebSocket client sends for it; the static `token`, and each token an access provider handed a dial (the newest sixteen), raw, and as a url carries it, percent- or form-encoded with either case of hex; and a stdio server's `env` values whose names have a part ending in a credential word, singular or plural, with any digits after it (`GITHUB_TOKEN`, `API_KEYS`, `PGPASSWORD`, `DB_PASS`, `AUTHORIZATION`, `SESSION_COOKIE`, `TOKEN2`), raw, and percent-encoded with either case of hex. Each of these strings, from every source, the `name=value` pairs and userinfo units too, is also replaced as JSON encoders write it, with `JSON.stringify`'s escapes, and with its slashes escaped too, as some encoders write them. A stdio server's command-line arguments are not derived. A string replaced on its own has at least eight characters, since a shorter one can't be told from ordinary text, and is replaced wherever it occurs. Every non-empty query parameter is also replaced as its whole `name=value`, only where no letter or digit adjoins the pair (so `v=2` leaves `dev=2` alone; a JSON escape before it, such as `\n`, isn't one); a short value goes only that way. A connection's event records use a redactor built once for it, and built again once a dial has sent something new. An operation's records replace the credentials of the configurations present when it began and of those present when each record is made, so a server removed, or replaced by a restart, while the operation waits is still covered, and so is one connected meanwhile. Every place a credential matches is replaced, places that overlap included, and text that may come from any server is matched against every server's strings at once, so two servers' secrets that overlap are both replaced whole. Over HTTP, which only the modern engine speaks, a 401 or 403's response body is left out of the request error's data; where the HTTP client builds the error's message from the body, as it does for most statuses, the message is redacted like any record. Credentials neither the configuration holds nor a dial sent are outside this, and so are a stdio server's command-line arguments. JSON-RPC answers, and the error a host's own connect raises, pass as they are.

- A record of a server's text no longer throws when the configuration it's
  redacted with can't be read, as a legacy stdio MCPL server's can't while
  the Discord awareness ledger can't be read. In place of the text it reads
  `[withheld: the server's configuration couldn't be read to redact this]`.
  Before, on a legacy MCPL connection:
  - a reconnect attempt made while the ledger couldn't be read rejected with
    nothing to catch it, which by Node's default ends the process. The
    connection made no further attempt, and its `close()`, and with it the
    framework's `stop()`, rejected with the ledger's error;
  - an error its transport reported after the handshake settled, or while a
    transport that never served was closing, was thrown inside an I/O
    callback;
  - an initial connect with `reconnect: true` whose ledger broke after the
    framework's own read rejected with the ledger's error, which ended
    startup, instead of returning the stub that retries.

- Under a configuration a host passes with a getter that throws, a failed
  MCP or MCPL tool call now answers with the withheld words as its error,
  where a call the model or a `code_execution` script made got no result and
  an in-process call rejected; and startup goes on past that server's failed
  connect, where it ended.

- A silent heartbeat tick is now told apart by its server and its event id
  together, so two servers' ticks whose events share an id each get their
  own separator, before their own first row.

- `start()` and `addModule()` made while a `stop()` is still running are now refused: `start()` throws `start() refused: the framework is stopping`, and `addModule()` rejects with `addModule() refused: the framework is stopping` (#315). Before, `start()` began a second lifecycle under the stop. If the stop hadn't yet seen its event loop end, it waited on the new loop instead: with no budget, which is the default, nothing ended that wait, and with one, it failed with `pending: event loop` and left the new loop running. If the stop had got past that wait, it settled after tearing down modules and an owned store under the new loop, and every later `stop()` returned that settled promise, so nothing could end the loop. A module added after the stop had taken its list of modules to stop stayed started and registered past it. `start()` and `addModule()` after a `stop()` has settled behave as before.

- **A stdio MCP server whose stdin or stdout fails is now ended even when
  it ignores SIGTERM, in both engines.** Since 0.22.2 such a failure sends
  the child SIGTERM, and its exit closes the connection. A child that
  ignored SIGTERM kept running, the connection stayed connected, and each
  request waited out its timeout. The transport now sends SIGKILL after 2 s,
  as its `close()` does, in the one attempt `close()` shares, so the
  connection closes, and reconnects if it would after any exit, its close
  still naming the pipe's error.
  - Nothing more is written to the child after the failure. A request made
    then is refused as not sent (`not-sent`), where it was written to the
    failed pipe and reported at its deadline as possibly executed. One
    written before the failure is still reported as possibly executed.
  - A connected server's child that outlives SIGKILL too is held as a
    launch that couldn't be reaped, as a reconnect holds one: reconnecting
    halts, the `mcpl-down` alert is raised, its tools leave the agents'
    list, and its id stays held until a disconnect or `stop()` retries the
    reap and confirms the exit.
  - Under Bun, a child that closes its stdin isn't reported at all, since
    Bun emits no `'error'` event for the writes to it, so request timeouts
    still bound it, as they do a child that stops reading.

- **`stop()` ends an MCPL connect still in flight, in either engine,
  instead of waiting for it.** The connect rejects with "was not connected:
  the framework stopped while it was connecting", and `stop()` doesn't wait
  on a server for it, in its handshake (its launch reaped), its setup or its
  tool listing, which asks every server. A restart in flight ends too, its
  connect refused once `stop()` has begun, so the server it was restarting
  is down. A disconnect admitted before `stop()` began still finishes
  first.

- `stop()` now runs every step of its teardown whatever an earlier step did.
  Before, a step that threw, such as a host's stream whose `cancel()`
  throws, ended `stop()` there: its modules and MCPL servers weren't
  stopped, the liveness watchdog went on beating, the framework stayed in
  the diagnostics registry, an ephemeral run still pending wasn't ended,
  and every later `stop()` failed the same way. Now `stop()` fails with
  that error once the rest has run, beside any other failure in an
  `AggregateError`, and an owned store stays open for another `stop()`, as
  after a failed module stop. A step in the last flush of deferred writes,
  which comes once everything else has stopped, fails the `stop()` as a
  failed final sync does, and the store is still synced and closed.
  - A stream whose `cancel()` threw is left running, as one whose wait ran
    out is: `stop()` doesn't wait for it, even with no budget, its agent's
    deferred writes stay queued, and a later `stop()` waits for it before
    it closes the store.
  - An ephemeral run whose own stream's `cancel()` throws at the run's end
    now leaves all the same, and settles as it ended, such as with
    `stop()`'s refusal, rather than with the cancel's error, which is
    logged. Before, the throw skipped the run's cleanup: the run and its
    agent stayed registered, and the stream's later text still reached the
    agent's context.
- `stop()` now ends Discord awareness delivery. A drain running when
  `stop()` begins sends nothing more, and the marks it hasn't sent stay
  pending in the outbox, unrecorded, for the next start's barrier; a line in
  the host log names the server and how many marks it held. `stop()`
  waits, within `teardownTimeoutMs`, for each drain still running to record
  the call that closing its MCPL server ended. Before, `stop()` neither
  stopped nor waited for drains: once the servers had closed, a drain went
  on through its pending marks, recording each as a failed attempt
  ("Cannot send request: connection … is closed") though it sent none, and
  with many marks those writes went on after `stop()` had returned. After a
  `create()` whose awareness barrier failed on one server, another server's
  drain went on writing the outbox after `create()` had rejected, while a
  `create()` retried in the same process could already be using it.
  - A wait on drains that runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming `awareness drain:<server>` and keeps an
    owned store open; a later `stop()` waits for that drain again. With a
    budget, a `stop()` can now take up to six budgets, where 0.22.3 took up
    to five. A failed `create()` gives this wait 30 s too, a third cleanup
    wait beside the two it had in 0.22.3.

- **A stop reaches a turn that has no live stream.** A turn can be alive
  with no stream to carry a stop: while it runs its modules'
  `gatherContext`, its MCPL hooks or its compile, while it waits to retry a
  failed inference or a failed compile, and while the tool-result guard
  waits for its speech to go out before retrying a refused round, when it
  holds only the round's finished stream. In the first two,
  `Agent.cancelStream()` had nothing to cancel, the framework's
  `abortInference()` returned `false`, and an operator's quiesce abandon
  left the turn running. In the guard's wait, the round's finished stream
  was cancelled and `abortInference()` returned `true`, but the retry was
  sent anyway. The turn went on to send its request or its retry, and
  answered, and an abandoned one did so while the host was quiesced. Now
  it ends at its next check, before it sends anything more.
  - **What a host sees:** one `inference:aborted` with the stop's reason,
    instead of a turn that goes on. The agent's `[turn-interrupted]` note
    says the turn was stopped before it sent anything, or before it
    finished; an operator's abandon writes no note. The inference log gets
    the stop's row, as for a stop on a live stream:
    `Stream cancelled (<reason>)`, or `Stream aborted: quiesce_abandoned`
    for an operator's abandon. The framework's `abortInference()` returns
    `true` for such a turn. `abortInference()` and an operator's abandon end
    a turn's wait to retry, however long, so the turn ends at once; a stop
    through `Agent.cancelStream()` ends it when the wait runs out. An MCPL
    server granted `inferenceLifecycle` sees a failed inference whose retry
    such a stop cancels end `failed`, as when `stop()` cancels it. In the
    tool-result guard's wait, `stop()` and an operator's abandon end the
    turn as their own stop even when a caller's stop came first, and as
    `stop()`'s when both reach it. `host:quiesce`'s `unabandonable` lists a
    turn that the abandon hasn't ended when its grace runs out: one with no
    stream and no check ahead, such as a puppet tool turn, or one that
    hasn't reached its check yet, the tool-result guard's wait for its
    speech included. A turn whose stream the abandon cancelled while it was
    still streaming isn't listed, even one still running.
  - **A failure's report:** a turn's stream that failed or threw no longer
    holds the agent while its `inference:failed` is delivered, nor does a
    compiled stream held for a provider's wait. A listener sees the agent
    idle, and `abortInference()` from a listener reports `false`: no stream
    or check is there to take the stop. A stop through
    `Agent.cancelStream()` made then ends the turn at the check after its
    wait to retry, if the error policy retries it, and otherwise ends
    nothing. A failure to build a turn's request is reported while the
    turn's check is still ahead: `abortInference()` from a listener reports
    `true` there, and the turn ends at that check.
  - **A stop followed by a failure:** when a turn's compile fails after a
    stop reached it, the turn ends at the failure: its `inference:failed`,
    then its `inference:aborted`. It isn't held by a provider hold, and the
    error policy doesn't retry it. If by then the agent was replaced, or the
    framework is stopping or was stopped and started again, the turn is
    dropped before it sends anything, as at the check after the compile. A
    failure that would have exhausted the turn emits no
    `inference:exhausted`, the event from which the hard-down alert's
    failure streak, the over-budget drain and the poison-history breaker
    count failures, so none of them counts it.
  - **A stop made where no check of a turn is ahead ends nothing:** the
    agent's next turn runs, as after a host's interrupt of every agent.
    That covers an idle agent, a turn finishing its last delivery, a budget
    restart or a non-streaming turn's tool results waiting to start the
    turn's next call, and a turn a provider-capacity hold or a provider's
    stated wait has parked.
- **A start whose framework was stopped and started again since it began is
  dropped before it retries a failed compile.** Its `inference:aborted`
  reads `a retry waiting while the framework was stopped and started again
  is dropped before it sends anything`; before, the retry compiled and was
  sent in the new lifecycle. A start whose hooks ran across a `stop()` and a
  `start()` is dropped before its compile too, as `a turn assembled while
  the framework was stopped and started again …`, where before the check
  after its compile dropped it. Either way a stop kept for the turn goes
  with it, as for a turn dropped while `stop()` runs.

- On Linux, a workspace mount's watcher no longer re-attaches, rescanning
  the whole mount and running its catch-up pass, when a file or directory
  with the mount root's own name is made, saved over or removed anywhere in
  the mount, as a program a build names after its directory is on every
  build. libuv reports such a rename under the same name as the root's own
  removal, and the watcher took every one for the root's. It now holds its
  root open (see Breaking) and checks whether the root is still the directory
  it holds. Where it can't hold the root, as on macOS and Windows or without
  read permission, such a rename still re-attaches it, as before.
- A workspace mount's watcher whose re-attach fails to close its old chokidar
  instance now reports that and attaches again. It used to stop watching the
  mount until the root's identity changed.

- On a disk that folds case, as macOS's does by default, a path that disk has nothing for takes the spelling of a workspace entry it equals in simple case folding, letter by letter, so a draft that isn't on disk yet has one name too. A `write` of `work/src/NEW.txt` where the workspace holds the draft `src/New.txt` now writes that draft, as the disk will once it's materialized, and `read work/src/new.txt` finds it; a directory works the same way. Two drafts that differ only in case used to be two entries for one file: a materialize wrote one and skipped the other, a forced one wrote the second over the first, and two directory drafts became one disk directory whose files the next pass moved under its spelling. A path that names a workspace entry exactly, or does once its directories take disk's spelling, keeps the entry's spelling, so an entry that disk lists in another spelling, or in a directory disk lists in another, such as a draft beside a file made on disk in another case before the draft was materialized, is read, synced, materialized and deleted by its own path. So is a file deleted in the workspace while disk keeps its copy, and a path in conflict: a `read` of its own path answers that it was deleted, or is in conflict, rather than taking the file in again, and a `materialize` of that path with `applyDeletions`, or a `sync`, reaches it. A path that disk's spelling puts in a nested mount's directory keeps that spelling, so the nested-mount checks still refuse what they refused. A draft whose directory disk comes to list in another spelling before it's materialized is found only by its own path. Drafts that differ only in Unicode normalization form, or in letters only a fuller folding joins, such as `ß` and `ss`, stay two entries, and where the disk folds them, as macOS's folds normalization, a materialize still writes one and skips the other. Spelling a path disk has nothing for reads the workspace's entries under the deepest of its directories disk has, so on macOS a script that creates thousands of new files, or looks up thousands of paths that don't exist, under one large directory pays that once per path. On a disk that tells case apart, every answer is as before, except that where such a disk folds normalization forms, a path that names a workspace entry exactly, or a deletion or conflict the workspace records there, or does once its directories take disk's form, keeps its form, outside nested mounts' directories.

- A mount nested in another is now that mount's directory wherever disk puts it, not only where the outer mount's paths name it as written. A root configured through a symlink, or beneath one, is nested where its real path lies; before, it wasn't nested at all, and the outer mount took in and read the inner mount's files. Each start of the module reads each root's real path again, awaited, so a root on a share that stops answering holds that start, not the process; before the first start, mounts are nested by their configured paths alone, as they were. On a mount that follows symlinks, a path that reaches a nested mount's directory through a link is now refused as one written into it: the file tools answer `"work/l/x.txt" leads into mount "inner", nested in mount "work", which neither reads nor writes it: use "inner/sub/x.txt".`, a sync or a materialize leaves it with `"work/l" leads into mount "inner", nested in mount "work": use "inner/sub" in its place`, and `readFileFromDisk` refuses it with the code `other_mount`. Before, the outer mount read, took in, wrote and unlinked the inner mount's files through such a link (#530). On a mount that doesn't follow symlinks, a path through a link into a nested mount's directory is now refused before anything is stored, with the refusal of the link the mount doesn't follow; a `write`, `edit` or `delete` through it used to store a change that no push could write. Where the path is itself a link to a file in a nested mount's directory, `readFileFromDisk` now refuses it with the code `other_mount` and words naming that mount, where it answered `symlink`.
- A mount configured with a relative root written with `./`, such as `./m`, now hears its watcher; it heard no change on disk.

- A workspace mount that doesn't follow symlinks (`followSymlinks` unset or false) now follows none among the directories on a path's way either. Before, a symlinked directory pointing inside the mount was followed, so the workspace acted on a file under another path than the one it named: a materialize deleted, created or overwrote the file behind the link, and a sync took that file's bytes in. Such a path is now refused wherever the link leads, naming the link: for a link inside the mount, with its target, and for a link to a directory there, that the mount's host can set `followSymlinks: true`; for one leading outside the mount, saying so. On such a mount, reads through an inside directory link stop, from `readFileFromDisk` and `read_image`, with a new code, `parent_symlink`, or `other_mount` for one into a nested mount's directory, and a listing of the directory a link stands at says so instead of walking it. A directory link leading out of the mount keeps the code `escape`, with the new words. A change a tool stores through such a link stays pending until disk can be observed there: the link goes, or, for a link to a directory inside the mount, the host follows links. A file the workspace created through the link clears when its entry is deleted. For a link inside the mount, the path through its target is the one to use. A mount root that is itself a symlink is still the root, and a mount that follows symlinks keeps following them while they stay inside it.
- Deleting a workspace entry disk never agreed with, a draft the workspace created with no push of it in doubt, or one at a path where disk last agreed it had nothing, no longer leaves a deletion pending. It records nothing to apply and pushes nothing, so it needs no proof of absence, which a path beneath a symlink the mount doesn't follow could never give. A draft written over a disk file the workspace never saw is now deleted without touching that file, which a sync observes as it does any file disk holds; the deletion was refused, with a forced push that would have deleted the file offered after a sync. Where a conflict the deletion clears names such a file, `delete`'s answer carries a `note` saying nothing was unlinked.

- On a disk that folds names, as macOS's does by default (case, and Unicode normalization), the workspace's tools take a path as disk spells it, unless it names a workspace entry exactly, or a deletion or conflict the workspace records at that path, or does once its directories take disk's spelling, which keeps that spelling where disk's spelling doesn't put it in a nested mount's directory. A `path` spelled otherwise, such as `work/SRC` for disk's `src/`, reaches disk's files, and `glob`, `grep` and `ls` used to name what they found from that spelling. So the workspace took each file in a second time under that name, announced it as created, and announced it deleted at the next pass over the mount; a `write` there was held under the name given while disk put it in `src/`. Now each segment of a `path` that reaches an entry under another spelling takes the entry's own name, from the mount's root down, and answers name files as disk lists them: `read work/SRC/a.ts` answers with `path: "work/src/a.ts"`. A segment disk doesn't have keeps the spelling given, unless a workspace entry spells it, and nothing past a symlink, or past a `..` that climbs above the mount's root, is respelled. `readBinary`, `readBinaryFromDisk`, `readFileFromDisk` and `writeBinary` take their paths the same way; `resolveAbsolutePath` takes its path as given, and the path it returns reaches the same file. A nested mount's directory on disk is now known in its configured spelling and in disk's: `read`, `read_image`, `write`, `edit` and `delete`, and the public readers and writer, refuse a path into it spelled in another case or normalization form as that mount's, and an outer mount no longer takes in the files of a nested mount whose directory was configured in another spelling than disk's. On a disk that tells spellings apart, every answer is as before.

## 0.22.3 — 2026-10-18

### Added

- A tool call the framework dispatches carries `callerTurnId`, the turn it was made in, and `SpeechContext` carries `turnId`, the turn the speech ends. A model's call carries the turn whose stream made it, a foreground script's inner call the turn of the `code_execution` call running it, and a background script's calls carry none. A turn's calls and its speech carry the same id, and the agent's next turn has a larger one, so a module can tell one turn's work from another's. Ids are unique only within one run of the process. The call on a `tool-call` process event now carries `callerAgentName` too, and `callerTurnId` when it has a turn.

- **Inbound source envelope.** Every inbound item the host accepts now carries
  `metadata.inboundSource`, stamped once where it was accepted: the
  conversation it belongs to (`channel`: MCPL server, endpoint binding,
  canonical channel id, thread, message, reply edge and the channel's label at
  receipt; `unscoped` for a push that names no channel; `surface` for console
  or API input from a module), the host acceptance time and the adapter's own
  timestamp. It covers `channels/incoming` and `push/event` on both the
  ordinary and the RFC-006 coalesced paths; a coalesced occurrence freezes its
  envelope at acceptance, so deferral, fan-out and replay deliver it unchanged
  and a later rename never rewrites it. Adapter-supplied metadata cannot set
  the field, and one a module's messages carry is dropped (an adapter's own
  `origin.source` string is untouched). `readInboundSource`,
  `conversationKey` (a JSON-encoded key, so no server-chosen part can run
  into another) and `INBOUND_SOURCE_KEY` are exported.
- **Inbound source envelope: admission facts.** An ordinary `channels/incoming`
  message or `push/event` now has its envelope frozen at admission, before it
  is queued or acknowledged, so a rename or rebind while it waits cannot
  change it. Every channel and unscoped envelope names the admission `lane`
  (`channels/incoming` or `push/event`), and one that came through RFC-006
  coalesced admission has `coalesced: true` (others have no `coalesced`
  field): facts a consumer needs to know what an `eventId` is worth.
  `readInboundSource` validates every field it returns.

- **`McplRequestError`: why an MCPL request produced no result.** A request
  to an MCPL server that fails now rejects with `McplRequestError` (exported),
  whose `outcome` says which of three things happened: `not-sent` (refused
  before anything was written: the connection was already closed),
  `error-response` (the server answered with a JSON-RPC error; the error's
  `data` is kept, and its code is in the message), or `no-response` (the request was handed to the
  transport and no answer came back: a timeout, or the connection closed
  while awaiting; it may or may not have reached the server). Only
  `not-sent` proves the server never saw the request. Messages are unchanged,
  and it is still an `Error`, so existing handling keeps working.

- **Held prose drafts: suppressed speech is kept, not destroyed.** Plain
  speech that routing holds back is now held as a draft with its exact
  words, instead of surviving only as a count: speech suppressed by an
  explicit send in the same round (locus and hybrid modes, mid-turn, trailing
  and text-only, native and XML tool modes), hybrid prose left without a
  destination after a failed envelope, and explicit/hybrid bounces, a
  delivery that definitely failed among them (which replace the in-memory
  latest-wins clipboard; `{{unsent}}` keeps meaning the latest bounce). Locus
  speech whose delivery fails keeps its failure marker, and isn't held. A draft held beside a send keeps its run exactly as
  written, indentation and surrounding newlines included; routing still
  publishes trimmed segments. Deliberate privacy is never drafted:
  `skip_reply` (the tool, or a hybrid `>>>skip_reply` envelope, which keeps
  the rest private until a destination is named), a same-round private
  `think` in a native round (where that policy applies: XML tool mode routes
  such prose as ordinary speech, so a send holds it as a draft), silent turns
  and `proseRouting: disabled` narration stay private.
- In hybrid mode a send withholds publication, not what an envelope does: a
  held `>>>` envelope moves the routing state as live routing would (a
  destination it names becomes the sticky target), `>>>skip_reply {{unsent}}`
  still sets the latest bounce aside, and the draft holds the message the
  envelope would have published, with `{{unsent}}` expanded under the
  re-bounce rule (a bare `{{unsent}}` leaves the bounce as the one draft).
- Drafts live in typed Chronicle records (`RecordJournal`) that do not follow
  branch switches: undo, rollback and checkout never change them, and they
  survive restarts. Nothing is ever sent from them on its own. Each
  resident's 100 newest drafts are kept, and an older one for at least 7
  days after anything last happened to it (held, named, attempted, answered,
  dismissed). The journal lets such a draft go when it next checkpoints what
  it keeps, every 500 entries, so opening it replays only what follows. A request naming a draft that was let go is
  refused, and nothing is sent, unless that id has since been given to a newer draft,
  which the request then names instead: an id is `d-` and seven characters, so after N more of its resident's drafts a let-go id has come back
  with a probability of about N in 2.75 × 10^10.
- A private notice names held drafts at the next tool boundary when the live
  stream presents mid-turn messages (a draft holding words copied from one
  that may already have been posted is named with that risk and the
  `confirmDuplicate` its resend needs). In locus and hybrid modes the
  turn-end `[delivered]` receipt names every draft held in the turn, in any
  of its streams (a framework retry, or the compile a provider-capacity hold
  defers the turn to), by id and by its state at turn end: still held
  ("held as drafts d-… (not sent …)"), delivered by the resident's resend
  (listed where it landed), unconfirmed, or dismissed. A dismissed draft
  whose own attempt may already have been posted is named with that risk,
  and counts like an unconfirmed one: a receipt that names one, with nothing
  confirmed delivered, reads "nothing confirmed", not "nothing". Explicit
  mode writes no receipt: its drafts are named by their bounce and refusal
  notices. A draft counts as named while a message naming it is on the
  current branch, so one no notice reached (a crash, an aborted turn), or
  whose notices a rollback or branch move took away, is named at the next
  turn's start: every such open draft by id, the newest eight with its state
  and why it was held. That catch-up reads the recent history (the newest
  500 messages): it records a notice it finds there, including one that
  landed after its turn had ended, and it leaves out the drafts of a turn
  still open and those a notice waiting to be written names. Notices
  name drafts and say how to resend or dismiss them, and quote none of their
  words; the `drafts` tool's `read` shows the words, and its `list` a
  preview of each.
- A draft is never published except by its resident's explicit resend (or
  `{{unsent}}`), and only that resident can list or act on it. Its notices go
  into the resident's own history, which residents sharing one message slot
  already share, as they share the assistant turn the words came from.
- New `drafts` tool (whenever MCPL channels are configured): `list`, `read`,
  `resend` and `dismiss`, scoped to the calling resident. Every such
  resident's tool list gains it, so each one's first request after upgrading
  misses the prompt cache once. `resend` publishes
  drafts verbatim, in order, to one destination through the normal publish
  path, journaling each attempt durably before the request leaves; it counts
  as an explicit send. A delivered draft returns its historical receipt
  instead of sending again; a draft with any attempt whose outcome is
  unknown (and none confirmed) needs `confirmDuplicate: true`, and a resend
  owns its drafts until it finishes, re-checking each before it is sent, and
  a draft it doesn't attempt is told why the batch stopped. Dismissing a
  draft (with the tool or `>>skip_reply {{unsent}}`) is refused while that
  draft's attempt is out, since a dismissal can't call back words already on
  their way; the resident is told to wait for that result. A draft only
  queued in a resend can still be dismissed, and is then not sent. A
  dismissal of a draft that may already have been posted names that risk.
  Unused fields may be passed as null.
- `{{unsent}}` whose draft is being sent, queued in a resend, or unconfirmed
  sends nothing, and the envelope's own words are held as a bounce draft
  with `{{unsent}}` written out and the risk carried, so nothing the
  resident wrote has to be typed again. If the journal refuses that draft,
  the notice says the words remain only in the history.
- Prose segments also break at XML tool mode's refused attempts and their
  notices (`tool_attempt`, `tool_notice`): the words before an all-refused
  call and after its notice are two messages, routed or held separately.
- `ChannelRegistry.deliverSpeech` (routeSpeech with its `PublishOutcome`) and
  `ChannelRegistry.resolveDestination` are new. `routeSpeech` now delegates
  to `deliverSpeech` and returns null unless delivery was confirmed, so a
  missing receipt and a channel id two servers share now return null (see
  the publish-outcomes entry).
- The bounce notice now goes to the bouncing resident rather than the primary.

- `QuiesceBlockedError`, exported beside `ResumeBlockedError`: what `quiesce()` throws when it refuses because the queue of deferred context writes can't reach disk, over its cap or with its write failed (the error's `cause`), with the host's mode as it was. The HTTP `/quiesce` route answers it with a 409 and the host's mode, and `host/command` with `ok: false` and the host's mode, as they answer `resume()`'s `ResumeBlockedError`.

### Changed

- **MCPL server authors:** when the host's handler for a server's request throws or rejects before it has answered, the server's answer no longer carries the handler's own message (#208). 0.22.x answered such a failure of a `push/event`, `inference/request`, `channels/register`, `channels/changed`, `channels/incoming` or `host/command` handler with `-32603` and the handler's message, or, once the host was stopping, with `-32000` and "the host stopped while handling this request" followed by the handler's message in parentheses. These requests now get `-32603` "Internal error", or, while the host is stopping, `-32000` "the host stopped while handling this request" alone. A handler's message can name the host's internal paths and errors, and the server may be a third party's. A server that shows or parses the handler's text from these replies no longer receives it: the host writes it to stderr and to its `mcpl:request-handler-error` trace instead. A handler that answers a failure itself still sends its own code and message, as before: `inference/request` when the inference fails, and `push/event` when a coalesced push fails.

- With a budget, `stop(teardownTimeoutMs)` now also bounds its waits on the
  streams it cancels, on maintenance in flight and on the event loop, as it
  did its waits on an operator's operations and on modules and MCPL servers
  (#373). Each wait takes the whole budget, so a `stop()` with one can take
  up to five budgets, besides the withheld-spill deadline of a guard's write
  still under way. Before, a stream whose cancel couldn't reach it, a
  maintenance tick that didn't settle, or a module's `onProcess` that never
  returned kept `stop(t)` waiting without end, whatever `t` was. With no
  budget, `stop()` waits for each as before.
  - A wait whose budget runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming what it waited for (`stream:<agent>`,
    `maintenance` or `event loop`), once teardown has gone on; with more
    than one, or beside another failure, the `stop()` fails with an
    `AggregateError` of them all. An owned store stays open, so that
    `stop()` can be called again, as after a timed-out wait on an
    operator's operations.
  - A later `stop()` waits again, within its own budget, for a stream or an
    event loop that an earlier one left running, and closes an owned store
    only once they've settled.
  - An agent whose stream outlasted its wait keeps its deferred writes
    queued, logged once for that agent, where `stop()` would otherwise
    store them ahead of what the stream may still write. The stream's own
    end takes them, as at any turn's end, if the process lives on, and a
    later `stop()` takes what that leaves. A memory-only queue loses them if
    the process exits before then.
  - Every ephemeral run still registered is ended with "refused: the
    framework is stopping", even one whose stream is still running, and its
    end stores what is queued for it, as at any run's end. Before, `stop()`
    waited for that run's stream first, without end if it never settled.
  - An event loop still in a call, such as a module's `onProcess`, when its
    wait runs out finishes that call and the rest of its iteration, then
    exits, even when a `start()` has been made meanwhile.

### Fixed

- MCPL's inbound handlers are contained at one boundary, the framework's wiring, for every request and notification it handles (#186). The `channels/list`, `tools/observe` and `model/info` requests and the `notifications/tools/list_changed` notification are newly contained: a throw or rejection of theirs is reported as the other handlers' are. `mcpl/manifestChanged` goes through the same boundary, and so does a refresh its handler schedules for later, after the fetch floor or behind a fetch in flight: a manifest fetch that fails is still caught and logged inside the handler, as in 0.22.x, and anything else the handler throws or rejects with is now reported as the others' are. 0.22.x logged that from an announcement's own run, and dropped it from a scheduled re-run. The six requests whose handler failures 0.22.0 already answered (`push/event`, `inference/request`, `channels/register`, `channels/changed`, `channels/incoming` and `host/command`) go through the same boundary now. On a connection the framework wires, no handler's throw or rejection ends the host, and a rejection reason that can't be printed is reported as one that can.
  - **A request whose handler fails is answered `-32603` "Internal error",** or, while the host is stopping, `-32000` "the host stopped while handling this request". The handler's error stays in the trace and on stderr. For the six that 0.22.x answered with the handler's own message, that's a change, described under Changed. A request is answered this way when its handler fails without having written a reply, which includes a reply whose write threw, such as one that can't be encoded. A notification gets no reply.
  - **Each failure emits a new trace, `mcpl:request-handler-error`, and a stderr line.** Its `error` is the handler's own error, or, for a handler that resolved, the reply write it swallowed, or a note that it tried to answer a second time. A reply write that failed before it is `responseFailure`, and a reply the handler tried to send after one was already attempted is `refusedResponse` (a result, or an error with its code and message): refused, never written. `responseError` is the internal-error reply's own failure, which the stderr line prints too. `requestId` is the request's id when that is a number, and a string id bounded as the trace's other texts are. A request form of `mcpl/manifestChanged` or `notifications/tools/list_changed` has none, since it's answered as it's admitted and then handled as the notification is.
  - **A request whose method isn't a string,** or isn't one the host handles, or whose event nothing on the host listens for, is answered `-32601` "Method not found", with a stderr line. A notification nobody handles is ignored.
  - **`mcpl/manifestChanged` and `notifications/tools/list_changed` sent as requests,** with an id, are answered with an empty result when the connection admits them, which waits while their plane is paused, if something on the host listens for them, as the framework's wiring always does, and are handled as the notification is.
  - **Non-object JSON** (`null`, `42`, `"hi"`, `true`) is ignored before property access, in the handshake reader and in routing, as a non-JSON line already is. One such line from a server used to end the host (#217).
  - **An `initialize` error whose `message` has no string form,** such as `{"toString":1}`, refuses the connect, with `initialize error: [object Object]`. 0.22.x converted that message after the handshake had stopped listening and cleared its timeout, so the conversion's throw escaped as an uncaught exception, which ends a host that doesn't catch them, and the connect never settled.
  - **An error answer to a request the host sent,** such as its manifest fetch, settles that request whatever its `code` and `message` are. 0.22.x's conversion of them threw out of the transport's line listener in the same way.
  - **A server's text in these errors is bounded:** in an `initialize` error's message and in an error answer's code and message, control, format and line-separator characters become `?`, and each is cut after 200 code points, with `…` marking the cut.
  - **A synchronous failure while dispatching an inbound message**, buffered plane flushes and a server's stderr lines included, is reported without interrupting later messages. Its `mcpl:server-error` names the event or method, the request id, and the cause.
- A trace listener that throws a value `console.error` can't print, such as one whose `util.inspect.custom` throws, no longer keeps the listeners after it from getting the event, or throws out at the code that emitted it: its error is printed as text instead.

- An MCPL server's `inheritEnv`, `reconnect` and `allowHostCommands` each take `true` or `false`, or can be left out, and `null` counts as left out (#379). `create()`, `connectMcplServer` and `restartMcplServer` refuse any other value, naming the server, the setting and the value's kind, and `restartMcplServer` refuses before it disconnects the running server, which stays up. `inheritEnv` is checked only for a stdio server, since a WebSocket server never reads it. `inheritEnv` and `reconnect` were read by truthiness, so `"inheritEnv": "false"` handed a stdio server the host's whole environment, API keys and bot tokens included, and `"reconnect": "false"` turned retrying on. `allowHostCommands` was read as on only when `true`, so `"allowHostCommands": "true"` granted nothing. Every reader of the three now takes only `true` as on, and `McplServerRegistry` asks the connection whether it will reconnect instead of reading `reconnect` again. So a server with `reconnect: true` that the host closes for good, as a policy refusal's `"close"` fallback does, no longer stays registered as a closed connection. A quoted `"true"` is refused wherever the setting is checked, including where the truthy reading made it work, so write `true` or `false` without quotes. A host that passes these settings on from its own configuration without checking them now gets this refusal from `create()` where a quoted value used to start.

- **Requests an MCPL server sends while its plane is paused are bounded**
  (#387). During a startup, a reconnect, an awareness drain or a quiesce,
  held requests had no bound, so a server that sends requests without
  waiting for their answers grew the host's memory until it ran out. Past
  10,000 held requests, a new one is now answered at once with `-32000`
  "the host is busy: 10000 of this server's requests are already waiting;
  send this one again later", and the host logs the first refusal and every
  hundredth. A server that doesn't send a refused request again loses it.
  Notifications keep their own bound of 1,000, now counted apart from
  requests. Before, held requests counted toward it, so a pause holding many
  requests dropped notifications it had room for.

- A failed `AgentFramework.create()` now releases what it had acquired before its error reaches the caller, so the same process can call `create()` again (#389). Before, a `create()` that failed after opening its store, such as on an invalid `timeZone`, an MCPL `toolPrefix` collision, a module whose `start()` threw or an out-of-range `toolResultInlineMaxChars`, left the store locked: every later `create()` on that `storePath` got `Store is locked by another process` until the process exited. It also left running what it had started, the liveness watchdog among it, which could then kill a process that carried on after the failure. Now the framework it had begun is stopped as `stop()` stops one (its modules, MCPL servers, event gate, tune-out coordinator and watchdog), and a store it opened from `storePath` is closed. A store passed in as `store` stays open.
  - The caller of a failed `create()` has no framework to give `stop()` a deadline, so `create()` gives it one: it gives up after 30 s on each of `stop()`'s two cleanup waits, for an operator's operations already running and then for its modules and MCPL servers to stop, where `stop()`'s default waits with no deadline. A module whose `stop()` never settles would otherwise turn a failed boot that exits into one that hangs.
  - When stopping them fails or runs out of time, or closing the store fails, `create()` rejects with an `AggregateError` holding its own error first and then those failures. Its message begins `AgentFramework.create() failed:` and says what didn't finish: that part of what it started may still be running, that stopping failed only after everything it started had stopped, or that its store may still be locked. It closes a store it opened even when stopping failed. When the release finishes cleanly, `create()`'s own error is rethrown unchanged, as before.
  - A `WorkspaceModule` that stops before its `initStore()` has applied the state it was handed, as one does when a `create()` that started it fails, or after an `initStore()` that threw partway, no longer saves over its stored state. Its `stop()` saved empty or default mounts there, losing the branch last materialized to disk, so on the next start `materialize` no longer refused a branch that had diverged from it.

- **A WebSocket MCPL server that sends a malformed frame with its upgrade
  response no longer ends the host** (#391). ws raised the frame's error
  before the handshake had attached a listener to the new transport, and
  the transport passed it on with nothing listening, which EventEmitter
  throws from an I/O callback. Such an error is now logged
  (`[mcpl] <server>: a websocket transport error, with nothing listening for
  it: …`), and the connect is refused: at once when the server then closes
  the connection, as a WebSocket server does after answering the close frame
  ws sends, and after about 30 s when it never does.
- **A transport error no longer ends a process whose `McplServerConnection`
  has no `'error'` listener** (#391). A connection the framework wires always
  has one, but a probe, a playtest or a harness holding a bare connection
  often doesn't. With no listener the error is now logged
  (`[mcpl] <server>: transport error: …`), and a listener that throws is
  caught and logged with the error it was handling.

- **An MCPL server's MCP `ping` is answered** with an empty result, as MCP
  asks, while its planes are paused too, and during the initialize handshake
  (#392). In 0.22.x a ping went unanswered, so a server with a keepalive could
  take the host for dead. During the handshake, a request whose id was `0`,
  the id the host gives `initialize`, was taken for the initialize response,
  so a server that pinged then connected as if it had advertised no MCPL
  capabilities.

- **A late `push/render` answer, and a tool call's late error, are now
  recorded** (#398).
  - **A `push/render` answered after its timeout**, once the batch's
    fallback was in place, left no record. It's now a `mcpl:coalescing`
    `late-render` with `discarded: true`, naming the server, the render's
    `featureSet`, `key` and, for a channel-scoped subject, `channelId`, and
    the `eventId` that links it to the batch's `render-failed`. A late
    JSON-RPC error is recorded as `error`, its code and message
    (`[code] message`, cut to 500 code points). While a data plane was
    paused, the late answer was also held and took a slot of that plane's
    bound; now it isn't held.
  - **A tool call answered after its mandatory deadline** stays a
    `mcpl:orphaned-response`, and a late JSON-RPC error there is now
    recorded as `error` the same way, where it used to look like a late
    success.
  - **`McplServerConnection` no longer emits `orphaned-render-response`.** A
    late `push/render` answer is an `orphaned-response`, with
    `method: 'push/render'`, `featureSet`, `key`, `eventId`, `channelId`
    when the subject is a channel's, and `error` when the answer was one.

- A tool result stored over its inline cap no longer keeps every line shaped like a reference stub from past the cut (#403). Every `[ref_…] …` line past the cut was added back after the truncation notice, whether or not it named an image and with no limit, so a text result listing channel attachments was stored far over the cap: a 25,980-character result at a cap of 2,000 was stored at 25,168 characters. The lines past the cut were kept so that `save_recent_image`'s index counts every image the resident saw, and now the stored copy keeps what the live copy showed.
  - A result with no inline image keeps nothing past its cut. Its live copy is the stored text, so the resident never saw what lies past the cut either. A truncated text result no longer lists the image stubs past the cut: the spill file holds them, and without a writable workspace they aren't kept, like the rest of the text past the cut. Such a reference's record is still in the registry, so running its tool again brings its stub back.
  - A result carrying an inline image went to the model as blocks: every image and every reference's stub, whatever the text's length, and each text block cut at the cap on its own. Past its cut it keeps the image slots those blocks showed, placeholders and image-typed stubs, the newest 64 of them, the most images the tool-image ledger holds bytes for. A slot in the part of a text block that the live copy cut away isn't kept. When more than 64 fell past the cut, a note says how many were left out, and `save_recent_image` doesn't count those.
  - History's own truncation, which cuts a script's tool results and those on the direct Agent API, keeps nothing past its cut either: each is read as its text.
  - The stored copy's cut, history's own truncation, and the live copy's cut of a text block beside an image never leave part of a slot before their notice. A cut that would split a placeholder moves back to the placeholder's start, and one that would split a stub-shaped line moves back to the line's start when at most 677 characters of the line lie before the cut, since that part could still read as an image; a longer part can't, and stays. The live copy and the stored copy cut alike, so the stored copy counts exactly the slots the live copy showed.
  - `save_recent_image` counts a reference stub as an image by the type its stored text shows, as it did after a restart or an eviction, and no longer by the registry's record while one exists. A stub counts the same whether or not the process still holds its record, and a reference issued again with testimony of another type no longer changes how an earlier stub counts.
  - A save in the same batch as a long result counts it as its stored copy will be cut, and an error result, or one with no data, which history stores as its error text, counts that text's slots before it is stored as it does after.
  - A slot is no longer than its writer writes it: a stub-shaped line longer than the longest stub the framework writes (677 characters), or a placeholder whose type or subtype is over 127 characters or whose size's number, ledger nonce or sequence is over 16 characters, is quoted text and counts nowhere. A tool image whose type or subtype is over 127 characters, the most RFC 6838 allows, is labelled `application/octet-stream`. A placeholder stored before with such a type no longer counts; only a server that sent one could have produced it.

- What agent-framework tells an agent about opening and closing a channel no longer describes one server's delivery as every server's (#406). MCPL leaves what an open or closed channel delivers to the server. discord-mcpl subscribes a channel when the host opens it and unsubscribes it when the host closes it. slack-mcpl keeps its own subscription, which decides whether a conversation's ordinary messages arrive whether the host has it open or closed.
  - The closed-channel invitation says "a channel you haven't opened" and that messages there that address the agent reach it whether or not it opens the channel, in place of "the rest of its traffic is invisible to you". Option 1 drops the warning that follow-ups to a reply won't reach the agent, and says that replying opens the channel, which it does. Option 2 reads "Open the channel".
  - `channel_open`'s description says that what an open channel delivers depends on its MCPL server, in place of "start receiving its ordinary ongoing traffic" and the server's "subscribe/join/attach operation".
  - `channel_close`'s description says that messages addressing the agent still reach it and what else stops depends on its server, in place of "stop receiving messages". `channel_decline`'s error for an open channel says to use `channel_close` to close it, not to leave it.
  - The "[channels] Now open" notice says that what an open channel delivers depends on its server, in place of "Ongoing traffic from this channel will reach you".
  - Every place that puts `#` before a channel's name adds it only where the name doesn't already start with one. The closed-channel invitation named slack-mcpl's `#general (acme)` as `##general (acme)`, and with a channel registry that has no `proseTargetFor`, it offered a label such as `#random` as the reply prefix `>>##random`. The gate's batched-wake line did the same with a `channelName` that starts with `#`. The invitation also names a channel whose label is only its id, as a lazily registered channel's is, by that id, without a `#`.
  - `channel_open`'s and `channel_close`'s descriptions change, so the first request after the upgrade that carries the channel tools misses the prompt cache from its tool block on.

- `codeExecution.enabled` takes `true` or `false`, or can be left out, and `null` counts as left out (#473). `create()` refuses any other value, and a `codeExecution` that isn't an object, `null` or `false`, naming the value's kind, not the value. The switch was read by truthiness, so `"enabled": "false"`, as a JSON config or a `${VAR}` substitution can write it, gave agents the `code_execution` tool and a python interpreter on the host, and a bare `"codeExecution": true` was read as off. Only `true` turns it on now. As before, a configuration that isn't on has its other settings left unchecked. A host that passes `codeExecution` on from its own configuration without checking it now gets this refusal from `create()` where such a value used to start.

- Restored state is no longer taken as empty at boot. `AgentFramework.create()` now fails when a state it restores can't be read, or reads as something this version can't take for that state. The error names the state, or its recovery file, and says what to do; nothing it names is changed. Before, each was taken as empty, the framework served without it, and the next write replaced what was stored. Nothing stored still starts empty, and a store any release wrote boots as before unless one of these reads fails.
  - **Host mode** (`recovery/host-mode.json`, or `framework/state` without one): a quiesced host booted serving, and landed the writes it had deferred during the maintenance.
  - **Deferred writes** (`recovery/deferred-writes.json`, or `framework/deferred-writes` without one): the queue restored nothing, and the next deferral replaced it. An agent's context that can't be checked for writes that landed before their ack now fails `create()` too, where such a write landed a second time.
  - **A recovery file that can't be reached** (an error other than its absence, such as `EACCES` on its directory) fails `create()` too, where it read as absent.
  - **Usage totals** (`framework/state`): they started at zero, and the next inference stored zeros over them. A `framework/state` that isn't an object now fails `create()`, where every reader took it as empty.
  - **An agent's persisted runtime settings** (`framework/state`): the agent booted at its recipe's settings, a `private` think-text policy as `public`, and its next settings change stored over the record. 0.22.2's notes said such a read is logged and the agent boots at the recipe's; it now fails `create()`.
  - **Tool-result guards** (`framework/state`): a `toolResultGuards` that isn't an object read as no setting, and the next guard change stored over it. It's now read by each agent's own name, so an agent named `constructor` no longer fails `create()` once any guard is stored.
  - **MCPL coalescing** (`mcpl/coalescing`, `mcpl/coalescing-recent`): an acknowledged deferred acceptance or a pending batch was never delivered, and the next receipt or flush replaced the stored ones. A snapshot of a version this one doesn't read was ignored and replaced; it now fails `create()` and is kept for the version that wrote it. An agent's context that can't be checked for an occurrence already delivered fails `create()` too, where the occurrence was delivered again.
  - **MCPL checkpoint trees** (`mcpl/checkpoints`): a stored value without `trees` read as no checkpoints, and the next feature set registered stored over it.
  - On a framework started with no MCPL servers, the coalescing state and the checkpoint trees are read at the first `connectMcplServer()`, which fails instead, with nothing of MCPL built, and the next connect reads them again.
- A host-managed MCPL feature set's state (`mcpl/state/<server>/<feature set>`) is now read after a restart: when MCPL starts, for each configured server, and before `connectMcplServer()` adds a server. It wasn't, so the state read as empty, and the feature set's next delta checkpoint applied to nothing and stored over it. A failed read of it fails `create()`, or that `connectMcplServer()`, naming it, before the server connects. A feature set with no stored tree, such as one registering for the first time or after its server was disconnected, has its state read when it registers, as before. A failed read there fails that server's connect, as before, and `create()` logs that and goes on, as for any server's failed connect. The state is now read again the next time the feature set registers; before, its tree was held after the failed read, so the state was taken as empty.
- A usage count stored as `null`, which a provider's usage without a count left as `NaN`, restores as 0, and a usage without a count no longer makes the totals `NaN`.
- A failed read of the persisted `tool_result_inline_max_chars` caps at boot is now logged. As before, they don't apply until a restart, and setting one keeps the others stored.

- **`readFileFromDisk`'s `maxBytes` and `read_image`'s size limit now bound
  the read itself, so they hold for a file that grows while it's read.**
  Both were checked against the size the open's `fstat` reported (for
  `read_image`, the mount's `maxFileSize`), and a file within the limit
  then was read with `readFile`, which in Node reads to the size its own
  `fstat` finds, or for a size of 0, to the file's end. So a file that
  grew in between was loaded whole. `readFileFromDisk` returned all of it
  with `truncated` false, and `read_image` loaded it before refusing it as
  too large.
  - Each now reads no more than its limit and one byte past it, which
    isn't kept and says whether the file goes on. `readFileFromDisk` reports
    a file that goes on as `truncated`, and `read_image` refuses it with its
    usual "Image file exceeds max size" words.
  - `readFileFromDisk`'s `truncated` and `size` now say what the read found.
    A file that shrank under `maxBytes` after the open is no longer reported
    `truncated`. `size` is `bytes.length` unless `truncated`, and then the
    file's size by an `fstat` after the read, or `maxBytes + 1` if that's
    less. Before, `size` was the open's `fstat` size, so it could disagree
    with the bytes returned for a file that changed in between.
- **A sync, listing or scan now takes a file that grew past the mount's
  `maxFileSize` after its `fstat` as oversize.** The workspace hashes it
  in chunks and keeps only its head, as for any file over the limit.
  Before, its read of a file within the limit at its `fstat` used
  `readFile`, so a file that grew in between was loaded whole, and a sync
  could store the whole of a text file over the limit.

- A workspace mount's catch-up pass, which takes in what changed on disk
  while the session was down, now runs once the mount's watcher is ready. So
  a change made after the pass has looked at a file reaches the watcher.
  Started beside the watcher's first scan, the pass could finish with a file
  before the watcher watched it, and a change made between the two reached
  neither until a sync or a later catch-up pass took it in. A watcher that
  isn't ready within 30 s has the pass started then, and its ready, if it
  comes, runs the pass again. A re-attached watcher's pass waits for its
  ready the same way. The status's `initialSyncDone` turns true when the
  first whole-mount pass ends, usually the catch-up pass, so it now turns
  true later, by as long as the watcher's first scan takes, up to 30 s.

- A turn woken only by deferred coalescing batches is no longer started when none of them has anything for it to read. It used to run, calling the model although no new input had arrived for it, when the assembly found a batch's authority revoked (before or after its render-start commit), when the render-start commit failed, or when it found that the agent had left the batch's audience since the batch woke it. Such a turn is now withdrawn before inference, as a turn whose batches all rendered nothing already was, and traces `turn-withdrawn`. A batch whose render-start commit failed is still kept, and its recovery wake delivers its fallback once storage recovers. The stderr line for a withdrawn turn now reads `[coalescing] <agent>: its deferred batches gave this turn nothing to read; turn not started (no wake cause left)`. It said `deferred render produced nothing`, which is untrue where no render ran.

- A message that arrives on a channel while its conversation fork is being spawned now goes where it would have gone just after the spawn: into the fork once it is bound. The event queue and the coalescer each deliver their messages one at a time, but they run beside each other, and a fork's spawn waits while its template's withheld tool results are still being saved to the workspace. Meanwhile a second message for the same new channel, plain or coalesced, or a deferred batch that spawns the fork to wake it, could decide on the same spawn, and that second spawn failed ("already registered or reserved"): traced as `mcpl:conversation-spawn-failed` on an incoming message's path, logged on a batch's. A message that wouldn't bind the channel on its own, such as an unmentioned one where only a mention binds, was dropped as unrouted. Either way the message wasn't delivered to any agent. Now a routing on a channel whose fork is being spawned waits for that spawn and decides once it settles. If the spawn failed, its own message is lost as before, and a waiting routing decides as a message arriving next would, proposing the spawn again if its message qualifies. While it waits, the path it runs on waits too, for as long as the spawn's seed waits (the withheld results' 30-second deadline per batch): on the event queue, every channel's messages; under the coalescer's lock, every subject's.

- A reference in a push event, a render result, an incoming channel message,
  a context injection or the successful result of an MCPL tool called in
  process is registered with the server that sent it, as the references in
  the result of an MCPL tool call the agent makes are, so `fetch_reference`
  can fetch it from that server. These were registered with no server, so
  `fetch_reference` refused them, unless a tool result had registered the
  same uri with its server. A reference now keeps every server that
  delivered its uri, and `fetch_reference` dials through the first of them
  whose address is on the uri's origin, with that server's credential and
  against its fetch budget, so a server off that origin sending it first no
  longer stops it being fetched. One on none of their origins is still
  refused, as a tool result's is.

- A channel decision whose durable record fails to write no longer takes effect in memory alone (the first part of #417). The channel registry now appends to its lifecycle log before it changes memory, so a `channel_close`, `channel_open`, `channel_decline` or tune-out whose decision fails to append, as on a full disk, fails with the decision as it was, and a retry records it. Before, memory changed first: a retried close or open took the same-state return and reported success without recording anything, and after a restart the old record came back, so subscription policy could lift a close the agent had been told succeeded. The same order now holds for a tune-out's wake count, for the record that a server's recipe policy has been migrated, and for the channel label history that lets an agent name a channel it isn't connected to, including a label first seen in a push event.

- **Text cut to a fixed length for an agent to read no longer ends or
  starts on half a surrogate pair.** An emoji or another character outside
  the Basic Multilingual Plane that fell across such a cut left half of its
  pair, which the agent read as a replacement character (U+FFFD) or, in a
  result's data, as an escape such as `\ud83d`. These cuts now leave out a
  pair they would halve:
  - the event gate's quote of a debounced event's content (200 units);
  - a utility's one-liner in `utils list` (160 units);
  - a failed spill's reason in a truncated tool result (200 units);
  - each recent error in health's `snapshot` (400 units);
  - the last 2000 units of a dead background script's output, in the wake
    that tells the agent it died;
  - a thrown error's text, as a subconscious tool's failed result reports
    it. It's now cut at 500 characters counted as code points, as
    `boundedErrorMessage` cuts, and its "(N characters)" counts code points.
    A text within 500 characters now comes back whole, even past 500 UTF-16
    units. So do the framework's and the MCPL checkpoint manager's other
    quotes made through `thrownText`, such as a refusal when stored state
    can't be read.

- `quiesce()` now writes the queue of deferred context writes before it changes the host's mode, or refuses, and a write of that queue that fails elsewhere is reported where an operator looks.
  - **A write deferred behind a turn still alive** before the host quiesced was held in memory only. `quiesce()` didn't write the queue, so when its drain timed out with that turn alive, a crash before the queue next changed lost the write. `quiesce()` now writes the queue first, before the host-mode record, on a first call and a repeat alike.
  - **When the queue can't reach disk,** because its write fails or it's over the cap, `quiesce()` refuses with a `QuiesceBlockedError` and the host's mode as it was. The refusal names the ways out. For a failed write, which is its `cause`, that's quiescing again once the record can be written. Over the cap, it's waiting for the writes to land, or quiescing with `abandon: true`, then resuming so they land, and quiescing again. Either way, `quiesce({ abandon: true })` goes on, since abandon is the call for a turn that won't end, and writes held for a turn land only once it has ended. So it's also how to quiesce anyway: the queue stays in memory, not on disk, so resume before restarting, since a restart restores only what the record last held, or doesn't start if it can't read the record. The failure or the cap then raises the alert below. As before, the abandon's answer lists a turn it can't end as unabandonable, and its writes land once it has ended and the host is serving.
  - **A write of the queue that fails elsewhere,** such as when a context write is deferred while quiesced, still keeps the queue in memory, since the write's source has already been answered, and the queue's next change writes it again. It used to be logged and nothing more. It now raises a `deferred-writes` ops alert at a run's first failure, and a line is logged when a write succeeds again, which ends the run. A queue over the cap counts as a failure, so it raises the same alert when it begins a run. On a host that's quiesced, or that an abandon is quiescing, the alert and the cap's line say to resume before any restart. The cap's line is logged the first time the cap is met in a run, where it used to be logged once a process. Like every ops alert, it reaches failures.log and the `ops:alert` trace each time, and the webhook, when one is configured, unless one of its kind was posted in the last 15 minutes.
  - **The cap is unchanged:** when the queue's JSON is longer than 4,194,304 characters, counted as the string's length, its record isn't written at all and keeps what it last held.
  - **Without a recovery file,** the store is the record, and the queue's write wasn't synced, so a crash could lose it. The store is now synced after the write, as it is for the host-mode record, and a sync that fails counts as a failed write. The write is already in the store by then, where a later sync can still put it on disk, so the queue stays mirrored from then on.

- The `SIGUSR2` diagnostics dump prints a line for each framework from partway through its `create()`, once its agents, modules and event gate are built, until its `stop()` has waited on its streams and event loop, and one line, `[diagnostics] no framework is running in this process`, when there is none. A framework leaves the dump before its modules and MCPL servers stop, so one whose teardown hangs or times out isn't listed. Before, every `create()` added a `SIGUSR2` listener that nothing removed, so a process that made one framework after another, as connectome-host does on each session switch, kept every stopped framework reachable and printed a stale dump of each on every signal. Now one listener serves the process: the first `create()` installs it, and it stays for the process's life, since a process whose last `SIGUSR2` listener is removed is ended by the next `SIGUSR2`. A framework's own line is unchanged.

- **The direct API sends the agent's request settings** (`runInference`,
  `runInferenceWithInjections`). Its requests carried the agent's model config
  and `providerParams`, but not the `promptCaching`, `cacheTtl` or
  `prefillUserMessage` that a framework turn's requests carry, so membrane's
  own defaults applied to them. `promptCaching: false` never reached them,
  and membrane's default, which is on unless its `defaultPromptCaching` says
  otherwise, decided their cache markers. Those markers had no TTL, so the
  provider's default applied. Membrane's formatters got no
  `prefillUserMessage`. One method now builds these fields for both paths.
  - The agent's `promptCaching`, default `true`, now governs direct-API
    requests as it does framework turns, over membrane's
    `defaultPromptCaching`. A host that turned caching off only with
    membrane's `defaultPromptCaching: false` now gets cache markers on its
    direct calls, which fail on a transport that rejects them, such as the
    Bedrock legacy Claude models `promptCaching`'s doc names. Such a host
    sets the agent's `promptCaching: false`, as that doc advises.
  - A direct caller that never set `cacheTtl` now sends the agent's
    documented default, `'1h'`, so its cache writes may now be priced at the
    one-hour rate.
- **`prefillUserMessage`'s doc** said native formatting ignores it. Membrane's
  native formatter uses it as the text of a leading user turn that its
  tool-pair normalizer adds, and the doc now says so.

- The Discord module edits a tool turn's thoughts, as a spoiler, only into a message the same agent posted in the same turn. Before, it edited them into the last message the module had posted, whoever posted it and in whichever turn. That could be another agent's message, or an earlier turn's message: after a `send` or `reply` that was refused or threw, after a `dm`, or from the agent's last text turn when the tool turn posted nothing. People in the channel saw a message they had already read change. Now a turn that posted nothing, or only a DM, edits nothing, and an attempt in the turn that is refused or throws leaves the turn's own post to take the thoughts. A post or thoughts that carry no turn, such as from a host that calls the module without the framework's dispatch, are left alone.

- An ephemeral run that leaves while its tool-result guard still holds a batch now settles
  the batch as it leaves, before the agent is deregistered. The batch is withheld, so its
  stubs say where each original is, as for any withheld batch, and the guard's audit
  records how it ended. Until now several ways out left the batch pending on an agent
  nobody would run again, with no `withheld` record and no stub naming where its originals
  are: a failure whose stream ended only after the run's caller had deregistered the
  agent, a budget restart or error retry whose new start failed, a run the completion
  watchdog ended, and `stop()`'s sweep of the runs still registered. The record reads
  `run_stalled` when the completion watchdog ended the run as stalled, and `aborted`
  otherwise, as driveStream's own teardown records a stream that ended without a clean
  round.

- **A turn ended by a tool result (`endTurn`, such as `skip_reply`) is recorded as a completed
  turn** (#67). It emits `inference:completed` with the stream's cumulative usage, then
  `inference:turn_ended`, writes a successful inference-log entry (`stopReason: 'turn_ended'`),
  and adds its usage once to the session totals (`usage:updated`, `getSessionUsage()`). Like a
  completion, it resets the consecutive-failure streak and the poison-history rewind budget, ends
  a refusal-rewind episode (a forced `/unstick` reports that the model responded), and records a
  provider-cooldown recovery. In hosts such as connectome-host, consumers that end a turn's display
  on `inference:completed` (a typing indicator, notices that close on success, a voice relay) now
  end it on these turns too, and a consumer that totals `inference:completed`'s `tokenUsage` now
  counts them too; one that also adds each `inference:usage` sample counts them twice.
- **Every stream's billed rounds reach the session totals once, however the stream ends.** A
  context-budget or physical-window restart is counted and logged where it is decided
  (`stopReason: 'context_budget'` or `'physical_window'`), without `inference:completed`. A stream
  that errors, aborts or throws after finishing rounds counts them, and its failure entry in the
  inference log carries them. A stream superseded by a newer one, one whose agent was disposed,
  or one that ended with no final response and no other end, which wrote no entry before, now
  writes a failure entry naming what ended it and carrying its rounds, and `inferenceCount`
  counts it, when it had finished a round; one that hadn't has nothing to carry and writes none,
  as before. A stop of any other stream writes its own entry, which carries them. If the store
  fails while a stream's end is recorded, the error is reported on stderr and what comes after it
  still runs: the rest of a
  tool-ended turn's end, a restart's next stream, and the stream's teardown. Exactly one
  entry of each stream carries its usage, so totals summed from the inference log count each
  stream once, as the session's do. A health snapshot's token totals read the log's newest 1,000
  entries, so with these new entries that window spans fewer turns.
- An inference-log entry for a stream the framework ended at a tool boundary (a tool-ended turn or
  a restart) records a note in place of the compiled request, so these frequent entries don't each
  add a whole-context blob to the store. They are still new entries: the inference log keeps no
  retention, so it grows by one small entry for every tool-ended turn and restart, and by one
  entry, with its request, for each abandoned, superseded or disposed stream that had finished a
  round.

- A store failure while removing an agent's turn checkpoints no longer stops
  that agent's teardown partway. An ephemeral run, such as a subagent's,
  resolves with its result instead of rejecting with the store's error. A
  closing conversation fork's disposal runs to its end, through
  `mcpl:conversation-disposed`, where at its closure turn's end the stream
  rejected with nothing to catch it, an unhandled rejection that ends a Node
  or Bun process with no handler for one. The fallback reaper goes on to the
  next fork. The failure is logged as `[checkpoints] agent=…`, and those
  checkpoints stay in the store.

- A `code_execution` script whose interpreter is still starting is now stopped by `PyRunner.abort()` and `dispose()`, as a running one is, and so is one aborted on the tick `exec` is called. The exec settles at once, and the script never runs. Before, an abort in that window did nothing, though `busy` was already true: when a script's turn ended or was reset to run again in that window, the script ran to its end or its time limit, calling tools as it went, and each `code_execution` call of the agent's later turns was refused as another script already running until then. A dispose there, as a background script's cancel does, waited out the interpreter's 15 s start timeout and then reported that the runtime had failed to start. The interpreter starts at an agent's first script, after it has been idle, and after a script is aborted, killed at its time limit or crashes.
- A `code_execution` interpreter that stops reading its input, as one does after a script closes its standard input (`os.close(0)`), is now ended at the first message that can't reach it, and the script waiting on it settles at once, saying the runtime stopped reading its input. That message's failed write was thrown in the host as an uncaught exception (`write EPIPE`), which ended the host's process. After a script's `os.close(0)`, the next script's message is sometimes written without an error and never runs, and that script settles this way only at its time limit. An interpreter that died before its exit was handled still settles with its own exit code.
- A `code_execution` script stopped at its time limit now reads the note "script stopped: it reached its … time limit" on a line of its own when the text before it doesn't end with a newline, as the runner's own texts don't, such as an interpreter's exit. The note used to run on at the end of that text's line.
- An abort or a dispose on the tick `exec` is called, when the interpreter couldn't be spawned, no longer signals another process. The runner killed the failed spawn's child, which has no pid, in the tick before Node's `error` for it, and Node then signals whatever pid the child's handle held: in a fresh Node 20 process that was 0, so `SIGKILL` went to the host's own process group.

- Nine boolean switches take `true` or `false`, or can be left out, and `null` counts as left out: `subconscious.enabled`, `subconscious.allowChannelSpeech` (checked once the subconscious is on), `watchdog.enabled` and `processLogging.persist`, and each agent's `promptCaching`, `thinking.enabled`, `refusalHandling.autoRewind`, `toolResultGuard` and `toolWrapperProseGuard`. `create()` refuses any other value, naming the value's kind, not the value, and `createEphemeralAgent` and the `Agent` constructor refuse it in an agent's. Each was read by truthiness, so a quoted `"false"`, as a JSON config or a `${VAR}` substitution can write it, turned it on, and a falsy non-boolean such as `0` turned it off without a word. A settings object holding them (`subconscious`, `watchdog`, `processLogging`, an agent's `thinking` or `refusalHandling`) counts as left out when it's `null` or `false`, and anything else that isn't an object, such as `true`, is refused, since every switch in it was read as left out. `promptCaching` is still on unless it's `false`. A host that passes these on from its own configuration without checking them now gets this refusal from `create()` where such a value used to start.

- The Discord module's edits and history sync no longer erase what the host added to a stored message. A message is now stored with its own text first, `''` when it has none, followed by its images, inlined file text and attachment notes, and its row's metadata carries `discordTextFirst: true`. An edit, live or found by the history sync, replaces that first block alone. Before, an edit rewrote the message as Discord's plain text, dropping its images, attachment notes and inlined file text. The history sync, which runs when the client becomes ready, did the same to any message with a note or an inlined file, since it compared Discord's text with all of the stored text at once, and a message whose only content was such a note or file then read as nothing at all. An update that leaves the text as it was now changes nothing, and an edit that removes a message's text, leaving its attachment, now reaches a message stored from now on. A live edit leaves a row stored before this change alone unless Discord's text is there and differs from the row's first block. It then puts the text in that block's place when the block is text, and before it when it isn't, and keeps the rest. Before, it rewrote the row as the text alone. A message that had no text of its own and was stored beginning with a file's contents or a note loses that block, where the rewrite lost everything, until the history sync stores it again.
- A live edit or delete now reaches a message that arrived live. Both looked the row up in the module context's external-id index, which holds only rows a module stored through its context, such as the history sync's, so they did nothing for any other message.
- A message the history sync missed is now stored as the live path stores it, with its images, small text files and attachment notes, where only its text was stored before. The sync also stores a row again through the live conversion when it doesn't hold what that conversion gives its message now: an attachment-only message an earlier sync blanked reads again, one it stripped of its notes or files gets them back, and an attachment removed from the message goes. One whose text changed while the client was away keeps its files. A row stored before this change for a message without text, whose first block is text, is stored again once, since that block may be a caption the message lost while the client was away. A rebuild whose text file can't be fetched writes nothing over a row holding other text, which may be that file's, so the row keeps what it holds and the next sync tries again; a row missing its file gets the notice that it wasn't fetched. A row the live path stored before the sync began is neither rewritten nor fetched again; one it stores while the sync fetches history may have its attachments fetched again, and is then left as the live path wrote it.
- The history sync now leaves alone a message the live path stored, changed or was told was deleted while it ran; an update that changed nothing doesn't count. It runs the conversions it needs first, then reads the store again and writes with no await between. A message the live path stored while it ran, which its fetch couldn't hold, is no longer removed as deleted. A row another writer removed while it ran isn't stored again. Before, a live edit made while the sync fetched history was written over with the fetch's older text. It writes nothing once the module has stopped or started again. A message a context strategy stored as a body, in shards, is kept as stored by the sync and by a live edit, since a body can't be edited in place, so an edit to it isn't taken in, and a live one writes a console line saying so. Before, the sync threw on a shard and stopped at it on every pass, and a live edit that found a shard threw too.
- `fetch_history` lists each message's attachments by filename, type and size, without their URLs, which work for anyone holding them until they expire.
- A send that posted its message but whose thread wasn't started now counts that message as the one the bot last sent, so the agent's thoughts are edited into it. Before, the message wasn't recorded, and the thoughts went into the message the bot sent before it, or into none. The send's result is the same error as before.
- Host authors: a Discord message stored from now on has its own text as its first content block, `''` when it has none; a row stored before keeps its layout until the history sync stores it again. The request builder drops an empty text block, as it already did, but a UI that renders stored content should expect one, and the history module's `raw` format shows it. `HistoryMessage` gains an optional `attachments`, which a custom `DiscordClientInterface` can fill; left out, the sync can't compare a message's attachments, so it rebuilds no row, though it still changes a row's text as a live edit does. `MessageQuery` gains `externalIds`, which context-manager already accepted. A `DiscordClientInterface`'s `sendMessage` may resolve with `threadFailure`, why the thread it was asked for wasn't started; one that throws instead works as before, and the message it sent isn't counted as the bot's last.

- An MCPL server's error result (`isError: true`) is now a failure for a caller in process too. `executeToolCall` and a module's `ModuleContext.callTool` got such a result as a success, `success: true` with the server's blocks as `data`, so a caller that checks `success` took a refused call for one that worked. They now get the failure the model's call gets: `success: false`, `isError: true`, and as `error` the result's text blocks joined by line breaks, a text that isn't a string shown as the converters' placeholder, or `Tool call failed` when it has no text. Its blocks that aren't text, which such a caller used to get in `data`, aren't kept, as the model's call never kept them. A success is unchanged: the server's blocks as `data`. The admin puppet (`puppetToolCall`) calls through the same path, so it now stores a server's error as an error result, where it stored it as an ordinary result the agent read as the tool's answer, and its `puppet:tool-call` trace now says `isError: true`.
- A server's error result through the model's call, and a channel tool's error result, such as `channel_open`'s refusal of a channel it doesn't know, are now traced as `tool:failed` with their error, where they were traced as `tool:completed`, so a host that shows failed tools, as connectome-host's terminal view does, now shows these among them. What the agent reads is unchanged.

- `set_tool_visibility` and `set_tool_description` refusals now lead with "Nothing was changed", lose the "Error: " prefix, and say what helps. Arguments of the wrong shape are named together, each by its key, with the call that works. A tool name that isn't available is quoted, cut past 60 characters, and gets the closest names, quoted whole, and the catalogue's index to copy from. A description over 32,768 characters, or hiding one of the three tools that can't be hidden, is refused as the agent's own input, where before it read as a problem with the file; a description's length is now counted in code points rather than UTF-16 units, so a character outside the Basic Multilingual Plane, such as 😀, counts once rather than twice. A stale `.lock`, a presentation file that is a symbolic link, an edit that would take the file past 256 KiB (with the bytes over), and a file changed during the edit each say what happened and whether calling again helps. An edit whose lock can't be removed after it's done now succeeds where it failed, and says that its lock was left and that edits will be refused until it's removed; a refusal that leaves its lock says so too. A lock that something else removed first is not reported as left.
- A presentation or description-defaults file the host can't use is reported with its problems all at once (up to ten, then how many more), each by its entry, both by the editing tools and in the catalogue's diagnostics. A name a problem quotes is cut past 60 characters and a value past 40, counted as code points, and the key the catalogue reports as not currently available is cut as a name is. The diagnostics also say what applies meanwhile and who can fix the file, each on one line of the catalogue. A presentation file that is a symbolic link to nothing is reported as such, where it read as no file. `parsePresentation`'s error names the document's problems the same way, where before it named the first, in other words.
- A `code_execution` script stopped at its time limit says its tool calls keep their effects, and offers `time_limit_ms` only when a longer limit is allowed. At the deployment's ceiling, which is the default unless `maxScriptTimeoutMs` raises it, it says that is the longest a script runs and to split the work, or to run it in the background when this agent could start a background script as the script starts (it runs them, and a slot is free) and one may run longer (a background script: that starting it again runs it from the top). Before, it said only that the script had stopped. A script whose interpreter exits under it, can't start, or exits as it starts says what ran and whether running it again can help; a missing `python3` says `code_execution` can't run there until the host installs one, a non-executable one until the host makes it executable, and a failure creating or writing the runtime's files says so, with its path. A second script while one runs says they run one at a time.
- Inside a script, a tool function called with keyword arguments, such as `await workspace__read(path="a.txt")`, is refused with the dict to write, `await workspace__read({'path': <str>})`, where before Python reported an unexpected keyword argument. A `str` key in that dict is shown whole up to 60 characters, and a longer one, any other key and every value by its type; a non-dict argument is named the same way.
- **Hosts driving `PyRunner`:** `exec()`'s options take `ceilingMs`, the longest limit the deployment allows that kind of script; without it, a stopped script isn't offered a longer limit. A foreground exec's `backgroundCeilingMs` is the longest a background script may run, which a script stopped at its ceiling is offered when it's longer; leave it out where the caller can't start one.

- An MCPL text block whose text isn't a string, which only a nonconformant server sends, now reaches the agent as `[Text not shown: the server's text block had no string text.]` instead of vanishing from its view or reading as `[object Object]`. That holds on the push and channel lanes, coalesced or not, in a `context/beforeInference` injection, and in a tool result, text-only or beside an image or a reference, where such a block sent the whole result to the agent as JSON, a reference's uri included. An MCPL tool error whose only text isn't a string now reports the placeholder as its error, where it read `[object Object]` for an object, the value itself for a number or `true`, its items joined by commas for an array, and `Tool call failed` for `null`, `false` or `0`. A `system` injection's text used to be joined into the system prompt as it was, which for an object with no string form threw while the request was built; a text-only tool result whose only block was such a text came back as an empty success. The placeholder still counts as no text when a message is checked for visible content, so a message holding only such blocks (or blank text) is still refused as empty, with the same answers as before, and a message whose blocks are numbers, strings or booleans is still admitted uncoalesced as its untyped placeholders. A `shouldTriggerInference` filter, and so the EventGate's content filter, now reads the placeholder where it read an empty line, as it already reads the converters' other placeholders.
- A `context/beforeInference` injection's content now converts as a pushed event's and a channel message's does: one converter serves all three. Before, an injection block whose `type` wasn't a string read as that value (`[unrecognized content block: 5]`, `[unrecognized content block: [object Object]]`), and one whose `type` was an object with no string form threw while it was converted, so the framework dropped every server's injections for that turn, with only a console line. An image's `data`, `mimeType` or `uri`, or an audio block's `data` or `mimeType`, that wasn't a string was passed on to the provider as the block's source, and a `uri` with a `disposition` was taken as a reference. An audio block without inline data showed its uri in its text: one that wasn't a string read as itself, and one with no string form threw, as a `type` did. Such fields now count as absent, and such blocks show the placeholders the other lanes show: `[unrecognized content block: untyped]`; `[Image: no data]` (where it read `[Image: missing data]`) or `[Image: no media type]`; and `[Audio: no data]` (where it read `[Audio: <uri>]` or `[Audio: missing data]`) or `[Audio: no media type]`. So an injection no longer writes an audio block's uri into the agent's text. An injection the host can't read is now left out with a console line naming its server, and the turn keeps every other injection: one holding a null block or content that isn't an array, a null injection, or one whose position has no string form, and likewise an answer whose injections aren't a list. Before, any of these dropped them all. An injection whose namespace can't be read as text, such as `{"toString": 1}`, is left out the same way. Before, a `beforeUser` or `afterUser` one failed the whole request, since context-manager writes the namespace into a participant's name as it builds the request, and a `system` one arrived, as context-manager never reads its namespace. Any other namespace that isn't a string, which §10.4 doesn't allow, still reaches the agent as it did: a `beforeUser` or `afterUser` injection's is written into its participant's name as its text, such as `system_context:5`, or `system_context:undefined` for an injection without one. The first such namespace from each server now gets a console line saying so. The line for an injection outside the server's grant now prints its position as one field, so a position holding a line break can't add a line of its own.
- The Discord module now gives the agent `[Attachment: <filename> (failed to fetch)]` for a text attachment whose download is answered with a status that isn't OK, as it already did when the download threw. Before, such an attachment was left out without a word, and a message with nothing else in it read `[Empty message]`. Either failure now also writes a console line naming the file, the message and the status or error, and an answer that isn't OK has its body cancelled, so its connection is released.

- A connect refused at a stdio MCPL server's exit now takes its `stderrTail` once the server's stderr has ended, waiting up to a second after the server's exit for a process that still holds the stream, such as one the server started. Node can emit a child's `exit` before it has read the last of the child's stderr, and the tail was taken at the exit, so a server that printed why it failed and exited could be refused without that line. A process the server started and left running with its stderr now holds the refusal up by that second.

- A block that isn't text in a `system` injection, such as an image or audio block that an MCPL server's `context/beforeInference` hook or a module's `gatherContext` put there, now reads in the system prompt as a line in its place, naming its type: `[image block not shown: the system prompt carries text only.]`. Before, the system prompt kept only an injection's text blocks, so such a block vanished with no sign to the agent, and an injection holding only such blocks left the system prompt as it was. The first such injection in each namespace also gets a console line naming its server (`[mcpl] <server>: …`) or its module (`[<module>] gatherContext: …`), once per server or module and namespace while the host runs. For an agent given such an injection, the system prompt changes with this upgrade, so its first request after upgrading misses the prompt cache.

- The workspace's `edit` writes its replacement as given. It read `$&`, `$$`, `` $` `` and `$'` in `newString` as replacement patterns. It now refuses, changing nothing, four edits it used to report as successes:
  - an edit of a file that isn't valid UTF-8, where decoding and writing it back turned every invalid byte sequence in the file into U+FFFD;
  - an empty `oldString`, which matched between every character;
  - a `replaceAll` whose `oldString` isn't in the file, which stored the file unchanged;
  - a lone UTF-16 surrogate in `newString`, which was written as U+FFFD. One in `oldString`, which used to miss, is refused the same way. `write` now refuses one in `content` too, as every tool does in a path.
- Every workspace tool checks its input against its own schema before it does anything: required fields, strings, booleans, and whole numbers, with `read`'s `offset` and `limit` at least 1 and `grep`'s context lines at least 0. An edit missing `newString` wrote the word "undefined", and `replaceAll: "false"` counted as true. A typed field given as `null`, or a number given as a string, is refused too, as `read` already refused them for `offsetChars` and `limitChars`. Before, some handlers read `null` as the field's default and did arithmetic on a numeric string. `read`'s `offset` and `limit`, and `grep`'s `contextBefore` and `contextAfter`, are typed `integer` in their schemas.
- A `write`, `edit` or `delete` that the workspace stored but couldn't finish still answers as an error. That covers one whose push to disk didn't complete, and one that failed after its change was stored. The answer now leads with the fact that the change is stored and mustn't be sent again, then gives the push's reason, which says what disk holds and the way out. All of that is in its text, which is what the model and a `code_execution` script receive of an error. Before, a refused push's answer began "Wrote to Chronicle", "Edited Chronicle" or "Removed from Chronicle", and a failure after the change was stored gave only the error. Either way, an edit sent again could apply twice.
- A refused push's way out names the tool that takes it, `materialize it with force`, where it said `pass force`. For a deletion it adds `applyDeletions`, which materialize needs to unlink anything. A disk copy that can't be verified is told to fix it and materialize again. `force` is named beside that only where a forced push gets past what kept the copy from being verified. A file its permissions keep the workspace from reading is offered force if disk lets the workspace write it, or, for a deletion, unlink it, since a read's refusal doesn't show either. Before, force was named for every such copy, though a forced push leaves a symlink the mount doesn't follow, or a FIFO a write meets, as it is. A path whose branch intent can't be read is told to sync the path, which replaces the intent. Where disk's copy can't be verified either, it's told that first, since a sync replaces the intent only once it can see disk's copy. Before, it was told to fix it and materialize again, which is refused the same way until a sync does. `ls`'s description names `applyDeletions` beside `force` for a path the workspace deleted.
- `read` counts the lines a file has: a final line end no longer starts an empty extra line, so "a\nb\n" is two lines, and an empty file has none. `grep` numbers lines the same way. An `offset` past the last line answers empty `content` with the file's `totalLines`, no `fromLine` or `toLine`, and a note saying where the file ends. Before, it claimed a range that ended before it began. Reading an empty file from line 1 answers `totalLines: 0` with no note.
- An `edit` first takes in a change on disk to a file the workspace holds, as a listing does, and applies to that text. Its answer says so when disk's copy had changed since the workspace last agreed with it, when disk had deleted the file, or when disk's copy couldn't be checked and it used the workspace's copy. Before, it edited the older stored copy, and on a mount that pushes, its push then failed as stale. When disk has no copy and nothing records whether it was deleted there, the edit uses the workspace's copy, as before. That copy goes back to disk with the edit's own push on a mount that pushes, or when the path is materialized on one that doesn't, and the edit's answer now says which. Where the path's stored copy is a draft and disk changed too, the edit applies to the draft as before, and its answer names the conflict and the two ways out, as does an edit refused there for what it found. `write` doesn't look at disk first, since it replaces the whole file; as before, it only settles a pending intent.
- `grep`'s refusal of an invalid pattern gives the parser's reason, and the workspace's refusals no longer begin with "Error: ". A push that disk's shape refuses says what's in the way and the way out: a directory at the path, or a file or a symlink where the path needs a directory. Before, it offered `force`, which can't write or unlink there either, and a file in the way named no way out.

- Two channels whose ids differ only in characters a conversation fork's name can't hold, such as `foo bar` and `foo-bar`, no longer get forks of one name. The name was the channel id with each run of characters other than letters, digits, `_` and `-` replaced by `-`, so both channels' first forks were `conversation-foo-bar-g1`. In one process, the second channel's spawn failed ("already registered or reserved") on every message, and its messages reached no agent. After a restart, its fork opened the first channel's namespace, wasn't seeded because that namespace already held history, and carried on as the first channel's conversation, which then went to the model in the second channel's turns. A fork's name is now `<prefix>-<readable>-g<generation>-<hash>`, such as `conversation-C123-g2-e08e564271867d16` for Slack's channel `C123` on a server named `slack`, or `conversation-discord-123-456-g2-1cd68209a232e3d5` for discord-mcpl's `discord:123:456` on a server named `discord`. The readable part is that sanitized id cut to 64 characters, and the hash is the first 16 hex digits of a SHA-256 of the server and channel ids. Traces, logs, the fork's namespace (`conversations/<name>`) and the fork's own participant name in its context carry the new form. In a server's `toolLifecycle` narrowing by `conversations`, a pattern over the readable part and `-g`, such as `conversation-C123-g*`, still matches each generation's fork. A pattern that ends at the generation, such as `conversation-C123-g2`, no longer matches, and needs `-*` at its end. Neither does one that spells out more of a channel id than the first 64 characters it sanitizes to; it needs to stop at those 64. Bindings aren't stored and the generation counters keep their keys, so nothing stored changes: after the upgrade, each channel's next fork takes the next generation under the new form. `IncomingMessageFacts` gains an optional `serverId`, which the framework passes; a direct `ConversationRouter.route()` call without it gets a name whose hash has `null` for the server.

- `workspace--glob` and `workspace--grep`'s `glob` filter now refuse a brace group they can't read, with an error that names the pattern and says that `?` in place of a `{` matches one in a name: a `{` that never closes, such as `src/{a,b`, a group inside another, such as `{a,{b,c}}`, and a group with no `,`, such as `{name}`, `{}` or `{1..3}`. Before, a `{` that never closed kept the pattern's conversion from finishing, so the call never answered and the process handled nothing else while it ran. The other two were misread with no error: `{a,{b,c}}` matched `a}`, `{b}` and `c}` and none of `a`, `b` or `c`, and a group with no `,` lost its braces, so `{name}` matched `name` and `{1..3}` only `1..3`.

- The history tools' refusals now open with what didn't happen ("Nothing was read", "Nothing was searched"), name the field and the value the call gave, and say what to send instead: how to write an ISO 8601 date, which fields go together (`before`, `after` and `allChannels` with `aroundId`; `windowOffset`, `afterId` and `seqMark` with an author filter), a count such as `limit` or `maxScan` with its range and default, how to find a channel's id, where a message id comes from, and that a continuation's fields are copied from its `resume` into the call. A search continuation that can't step past an instant shared by more than 5000 messages now points to reading it with `history--extract`; it used to suggest an author filter, which can't narrow that count. `history--semantic_search` says whether the semantic index service didn't answer, couldn't be reached, or answered with an error, and whether trying later can help. The client's errors carry the service's HTTP status (`EmbedServiceError`), and the checks for a missing namespace or a service without `/delete` read that status, not the message's text; the index's log lines name the index. A tool name the module doesn't route gets the list of its tools, and a call made before the host binds the module says it's the host's to fix, with the detail in the host's log.
- `history--search` reads a number given as its `query` as that number's text, whichever way the search is made, a regular expression taking that text as its pattern. It used to fail on one unless `caseSensitive` was set, and with it a search for text came back with an empty snippet; only a regular expression searched it as text. Any other `query` that isn't text is refused, as an empty one is.
- `history--semantic_search` keeps the hits it found when it searches again for more and that search fails, and says why in `index.searchAgainError`. It searches again when too few of its hits are on the agent's branch, and a failure of a later search used to refuse the whole call. A hit whose `ts` isn't a number of seconds or text holding one, or whose `meta` isn't an object, now comes back with no timestamp, or no participant or author. Such a hit among those returned used to fail the call where its `ts` made no date or its `meta` was missing or `null`, and a `ts` of `""`, `false` or `[]` read as a date in 1970. The host's log names each such hit, but for a `null` `ts`, which is written so on purpose.
- When the semantic index service answers the background sync's stats request with a 2xx that isn't stats, such as a web page from a wrong route, the sync names that answer in `index.lastError` and walks from the start, as for a store the index doesn't hold yet; a pass whose budget runs out then fails on that answer and backs off. A web page there used to read as no stats, so every pass re-sent the history from its start without a word, and a history longer than a pass's budget was never walked to its end; JSON without stats by kind failed every pass, so nothing was indexed.

- The history module's semantic index no longer stops taking removals because one came before the index was made. The removals and edits phase runs before any upsert, so a removal made before a store's first pass went to `/delete` before its index existed. When `/delete` answered 404, as a service may for a namespace not made yet, every later removal was dropped until the host restarted or bound the module again, and removed messages stayed in the index, which only grew; search-time checks keep them out of results.
  - A pass whose `/stats` answers 404 now has no index to remove from: it drops its removals, and the deletes of messages edited down to nothing indexable, without calling `/delete`. The index that pass makes takes only what the store holds and can index, which leaves them out.
  - Only a pass whose `/stats` answered with stats reads a 404 from `/delete` as a service without that route. Such a 404 still ends removals until the host restarts or binds the module again, and until then no pass calls `/delete`, where an edit down to nothing indexable called it again each pass and repeated the warning.
  - A 404 from `/delete` in a pass whose `/stats` answered with something that isn't stats, such as a page shown while the service restarts, is re-queued like any other failed delete, since that answer doesn't show the index is made. While `/stats` keeps answering so, each pass sends the delete again.
  - The warnings for a failed delete name removals and edits down to nothing indexable apart, where one counted every delete as a removal and the other counted only the removals.

- The snippets the history tools cut, and the text they send the semantic index, no longer begin or end on half of a surrogate pair, half of an emoji for instance. `history--search` keeps up to 80 UTF-16 units each side of a match, `history--semantic_search` up to 400 of a message hit's text, and the semantic index up to `maxChars` (32,000 by default) of a message's or a summary's text, each one fewer at a cut that would split a pair. A summary hit's snippet is still the one the index service sends. The internal `safeSlice` now also moves a start that falls on a low surrogate forward past it.

- **A `stop()`, surgery or maintain begun from inside a context-maintenance pass now finds the pass.** The pass is registered before its body runs, so a `stop()`, `rollbackToMessage()`, `suppressMessages()`, `switchBranch()` or `maintenanceTick()` called from a trace listener on the `ops:alert` the pass raises while it prepares, or from a strategy's tick before that tick's first await, waits for the pass or joins it. A tick that awaits such a call waits on its own pass, as a tick already did for a call it made after its first await. Before, `stop()` closed the store while that tick was in flight, and the pass then met the closed store and reported it as the agent's maintenance failure ("Store has been closed"), with a `context-maintenance-failed` alert. A rollback moved the branch under the tick, and the pass went on ticking on the new branch. And `maintenanceTick()` started a second pass beside the first, so two ticks of one agent ran at once.
- **A context-maintenance pass or an over-budget drain kick takes no further tick of an agent disposed while it runs,** such as a conversation fork closed after it went idle, or an ephemeral run that ended. A tick in flight at disposal finishes. Before, each went on ticking the disposed agent's context manager, up to eight ticks, for a context the framework runs no further turn on. The drain kick's log line says `stopped as the agent was disposed`.

- The MCPL connection's buffered-event cap counts each pause's drops: the
  flush line that ends a pause reports that pause's drops, and the drop log
  speaks at each pause's first drop. Previously the count ran for the
  connection's whole life.

- A `reconnect: true` MCPL server that the framework closes for good now
  leaves the registry even when it's down at the time, so a later connect of
  its id isn't refused as already registered. The framework closes a server
  for good when a runtime `connectMcplServer` or `restartMcplServer` fails
  its Discord awareness accounting or its policy registration, and when the
  server refuses the host's policy with the `"close"` fallback. The registry
  dropped a closed server only when its connection reported the close, and a
  connection that's down between retries reports none. So the stub a failed
  first connect leaves stayed registered after such a close, and a later
  `connectMcplServer` of its id failed as already registered until
  `disconnectMcplServer` or `restartMcplServer` dropped it. A close that
  fails still keeps the server registered, so a later disconnect, restart or
  shutdown can close it again, and the failed connect now logs it.
- A runtime `connectMcplServer` or `restartMcplServer` that fails after
  pausing the other MCPL servers' data planes no longer leaves their data
  held. The connect paused them behind a gate that it settled only when it
  succeeded, so their pushes, incoming messages and inference requests
  waited until some other gate completed.
  - When its Discord awareness accounting fails, it now fails that gate, as
    a failed reconnect, tools-list reconciliation,
    `syncDiscordAwarenessMarkers()` or `resume()` already does: each running
    server is recycled, and its reconnect's own gate holds its data until
    that reconnect's accounting succeeds. A server without `reconnect: true`
    is closed for good there, as on those paths. While the host is stopping,
    the gate is released instead.
  - When its policy registration throws after accounting succeeded, it now
    closes the new server for good, where it stayed connected and half
    registered, and completes the gate, with no recycle.
- `McplServerConnection.ready()` and `readyControlPlane()` now do nothing once
  the connection is closed for good: closed, with reconnect off, as after
  `close()` or a drop with reconnect off. What it held stays held. Any gate's
  completion used to pass the part of it that needs no grant to listeners,
  as for a connection whose close failed and so stayed registered. While the
  host stops, a connection closed for good, such as one being closed, no
  longer passes what it held to the stopping refusal, whose answers can't be
  sent on a closed connection.

- An MCPL server's `inference/request` result now gives as `model` the model membrane names as having served it, `details.model.actual`, which is what SPEC §11.3 defines `model` as (#414). It gave the model the routing policy chose, or `default` without a policy. When membrane names no model, the result gives the routed one, as before, and on its streaming paths and most of its adapters membrane names the requested model itself when the provider names none. The `mcpl:inference_complete` trace keeps the routed model in `model`, as `mcpl:inference_start` has it, and adds `actualModel`, the model the result names, which it leaves out when membrane names none.

- An MCPL server's `inference/request` now gets a result only for an inference that completed with a stop MCPL can name, and the JSON-RPC error otherwise, whether it was streamed or not. A streamed request whose stream failed, such as on OpenRouter's mid-stream error, or stopped early, such as on a timeout, was answered `end_turn` with whatever text had arrived. In XML tool mode, a model that wrote a tool call parked a streamed request's stream, so the request was never answered. Each now gets the error the non-streamed path already sent for a failure, code `-32603` with the cause in its message, and an `mcpl:inference_fail` trace. So does an inference that ended with a stop reason `finishReason` has no value for, which was answered `end_turn`: `refusal`, `tool_use`, `pause_turn`, `abort`, and membrane's guard stops `no_progress` and `round_limit`. So does an inference the provider ended with `finish_reason: "error"` and no error object, which membrane has no stop reason for: it was answered `end_turn` with the text so far. In XML tool mode, so does tool-call markup that was answered as a completion: a tool call in a request that isn't streamed, whose markup was returned as content, and, streamed or not, a tool-call block membrane reads no call from or one still open when the output ended, such as a call cut off at `max_tokens`. membrane tells an open block from the text, so a completion that writes `<function_calls>` in prose and never closes it gets the error too. An inference the provider ended with a stop token membrane has no stop reason for, other than `error`, such as Gemini's `OTHER`, is still answered `end_turn`, since membrane normalizes the token to that.
  - **MCPL server authors:** a streamed `inference/request` can now end in a JSON-RPC error after chunks have arrived, and the error carries no partial text. anima-research/mcpl#20 asks the spec to say what a server does with those chunks.
  - A streamed result carries the response's `finishReason` and `usage`, as one that isn't streamed does. It was always `end_turn` with zero usage, so an answer cut off at `max_tokens` read as finished. Its `content` is the text of the response's text blocks, so in XML tool mode it no longer includes thinking, except a thinking block still open when the output ended, such as one cut off at `max_tokens`. A result that isn't streamed still includes thinking, since membrane's `complete()` keeps the `<thinking>` markup in the text.
  - Chunks carry only text membrane marks visible: thinking and the text of a tool call are no longer sent as `inference/chunk` deltas. In XML tool mode membrane's stream parser also opens a block at a `<function_results>` or `<invoke>` tag written in prose, so the chunks can then leave out text that the result's `content` holds.
  - A streamed request's `mcpl:inference_complete` trace now carries `inputTokens` and `outputTokens`. `streamed`, which only that trace carried, is now on every success and failure trace.

- An `mcpl/manifestChanged` notification sent without params is handled like
  any other: the fetched manifest is applied, its
  `mcpl:manifest-change-receipt` is emitted naming no domains, and the tools
  list is refreshed. Previously the handler threw once it had applied the
  manifest, so the receipt and the refresh were skipped. The receipt's
  `announcedDomains` now holds only the strings of the announcement's
  `domains` array.

- A WebSocket server's close reason no longer reaches the errors a close
  makes. A WebSocket transport that closes during the handshake now fails the
  connect with the transport's words and the close code, such as
  `(websocket closed, code 4001)`, whether or not the server sent a reason,
  and each request pending when the connection drops is rejected with
  `reason=websocket closed`. Previously both errors carried the server's text
  as it wrote it, into the host's log, the `mcpl:server-connect-failed` trace,
  the `mcpl-down` alert and a tool call's result, and the connect error gave
  no code. `mcpl:server-closed` already left that text out. A stdio child's
  exit reads as before.

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
  queue lost it. Once `stop()` begins, a new ephemeral run is refused. Since
  no turn starts or registers a stream once `stop()` begins (unless
  `start()` is called before it finishes), no reply can then follow a stored
  entry in a stream, so `stop()` stores each one even while a frame it
  doesn't wait for still holds its target's turn, such as a turn started
  outside the event loop, or a puppet call still running after `stop()`'s
  wait for operator operations timed out; that call's pair then lands after
  them. A quiesced host keeps what is deferred in its persisted queue for
  boot recovery. An entry for a target no longer registered (a disposed
  fork) is dropped from a memory-only queue at exit, as before.
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

- A programmatic MCPL tool call, through `executeToolCall` or a module's
  `ctx.callTool`, now reaches the server the model's own call of the name
  reaches, and sends it the same tool name: the server whose tool listing
  offers the name, else the longest matching prefix. It took the first
  configured server whose prefix the name began with, so where one prefix
  begins with another's, such as `foo` beside `foo--bar` or beside `foo-`, it
  reached whichever of the two was configured first (#227, #230). Where two
  servers list the same full name, the listing holds the one listed last
  (#265), and both paths reach that one.
- An MCPL tool's source in the tool presentation now names the server a call
  of it reaches, by the same resolver. **Operators:** a tool's source was the
  first configured server whose prefix its name began with, so with `foo`
  configured before `foo--bar`, a component description profile bound to
  `MCPL server: foo` also described `foo--bar`'s tools. Those tools now take
  the profile bound to `MCPL server: foo--bar`, if there is one, and lose
  `foo`'s descriptions.
- A server's close forgets only its own tools' RFC-008 class declarations.
  Closing `foo` also forgot `foo--bar`'s, leaving its tools unclassed until
  the next tool refresh.

- **Two operator changes of one kind made one after the other within a
  millisecond each get a branch.** Unless the caller names it, a suppression,
  a rollback, the host command's message undo, a turn undo and an offline
  recovery name the branch they make for the time in milliseconds
  (`suppress/<agent>/<ms>` and so on). A second change of the same kind in the
  same millisecond used to be refused, because its name was the first one's
  branch. A default name is now one the store doesn't hold: the timestamped
  name, or that name with `-2`, `-3`, … appended. A name the caller gives is
  used as given, and the store still refuses one that's taken.

- The npm package no longer ships the compiled test suite or the
  compiler's build record: `files` packs `dist/src` and `src`, so
  `dist/test`, about half the published files, and
  `dist/tsconfig.tsbuildinfo` stay out, and the package's contents no
  longer depend on whether the tests ran before packing. The redundant
  `discord.js` entry in `devDependencies` is gone (it is a dependency).

- Explicit prose whose delivery definitely fails is held as a bounce draft with its notice, as hybrid envelopes are. A delivery whose outcome is unknown gets the failure marker alone, so its words are not offered for an ordinary resend that might duplicate a post. A failed delivery that is held gets the bounce notice alone, not a second marker.
- An envelope whose `{{unsent}}` names no held draft (the latest bounce draft was sent, set aside or let go) sends nothing, rather than the rest of the envelope. Its other words, if any, are held as a bounce draft; otherwise a short notice says nothing was sent.
- In hybrid and locus mode, a completing turn waits for its queued speech and hybrid holds even when its final response is empty, so its receipt includes that work and its draft notices settle with the same turn.
- Failure markers and traces include a bounded display of the connector's structured error data, such as parts already posted, and the connector's error message is bounded too. Contradictory delivery receipts bound the message id in their diagnostic without changing the receipt's id.
- A synchronous MCPL write rejection reports that the request was not sent and removes its pending state. `channels/open` keeps the same deadline as `channels/publish` when `requestTimeoutMs` is 0 (`publishDeadlineMs`, 60 s by default), so an unanswered open can't hold a delivery for good.
- A hybrid `>>>skip_reply {{unsent}}` in a skip-reply round sets the latest bounce aside while keeping publication private; text in a round with a private think stays uninterpreted, matching explicit mode.

- **Speech delivery reports what a publish actually established.** Plain
  speech now goes through one publish executor (`ChannelRegistry.publish`,
  returning a `PublishOutcome`: `delivered`, `failed` or `unknown`, with the
  destination the registry resolved). Only a connector's `delivered: true`
  confirms a post; a missing or malformed receipt is no longer counted as
  delivered (#163's rule). `failed` means nothing was posted: refused before
  dispatch, or `delivered: false` naming no message. An error response, a
  timeout or a lost connection after dispatch is `unknown`, keeping the
  connector's own words (a multi-part send may already be partly posted), and
  so is a contradictory receipt (`delivered: false` beside a message id,
  valid or not).
  The resident's `[discord-send-failed]` marker now says which: "could not be
  delivered … Nothing was posted" for a failure, and "was not confirmed … may
  or may not have been posted, so sending it again could post it twice" for
  an uncertain outcome. The marker's metadata and the
  `mcpl:speech-route-failed` trace carry `outcome`. A channel id registered
  by more than one MCPL server is refused rather than routed through
  whichever server registered it first, and a supplied but empty or
  non-string server selector is refused rather than read as omitted. A send
  refused for its server or grant opens no closed channel. A
  `channels/publish` request always has a deadline: with `requestTimeoutMs`
  0 it keeps the 60 s default, since its outcome is told to the resident and
  recorded for its draft; its expiry reads as unknown.
  `channel_publish`, and the subconscious's `speak_in_channel`, which shares
  its path, answer by the same rule. Before, they answered success with
  `{ delivered: true }` for a missing receipt and never read `delivered`.
  Now only `delivered: true` is success. `delivered: false` naming no
  message, or a request refused before it was written, is an error saying
  nothing was posted. Anything else is an error saying the publish wasn't
  confirmed and that sending it again could post it twice. That answer, a
  draft resend's line for a send that wasn't confirmed, and the `drafts`
  tool's read of that attempt carry the connector's data, bounded, when it
  sent some. `channel_publish` and
  `speak_in_channel` still resolve a channel id by its first registered
  match and post into a closed channel without opening it, as before.

  If you run a connector that answers `channels/publish` with `{}` or no
  receipt, which earlier versions counted as delivered, every publish
  through it now reads as unconfirmed. The resident is told of each reply
  that it wasn't confirmed, and gets an error for each `channel_publish` and
  `speak_in_channel` call, each saying that sending it again could post it
  twice. A connector confirms a post by answering `delivered: true`.

- An operator's quiesce abandon (`quiesce({ abandon: true })`) now ends the turn the same way whatever the stream reports for the cancel. It writes an inference-log row of its own, `Stream aborted: quiesce_abandoned`, carrying the rounds the stream finished, which it didn't when the stream reported `aborted`; and when the stream answers the cancel by just closing, with no `aborted` or `error` event, it still settles the turn and returns the agent to idle, where the agent had stayed busy and an ephemeral run's promise unsettled.

- `quiesce()` and `resume()` now answer only once the host-mode record agrees with the host, or fail, apart from calls that overlap.
  - **`quiesce()`** writes the record before it marks the host quiesced. When that write failed, `quiesce()` rejected with the host quiesced in memory while its record said it was serving, so a restart booted serving, and a second `quiesce()` resolved without writing the record. Now a failed write leaves the host serving, as it was, and the next `quiesce()` quiesces and writes the record.
  - **`resume()`** still serves before it clears the record, so a failed clear leaves the record quiesced. A second `resume()` used to resolve without clearing it, so the next restart booted quiesced; it now clears the record. While a surgery holds the store, that clear is refused as `resume()` is on a quiesced host, and a `resume()` arriving while another is still flushing leaves the clear to that one.
  - **Without a recovery file,** the store is the record, and a failed sync of the store after the write was only logged, so `quiesce()` resolved before its record was durable. It now fails `quiesce()` or `resume()`. The write is already in the store's log, though, so after a `quiesce()` that failed this way the record can still reach disk, and a restart can boot quiesced unless a `resume()` clears it first. With a recovery file, the file is the record, and a failed sync of the store is still only logged.

- The host-mode and deferred-writes recovery files are now synced to disk before they replace the record, and their directory and its parent after the rename. On Windows, and where the filesystem refuses a directory's sync with `EINVAL` or `EBADF`, only the file is synced. A write that fails before the rename removes its `.tmp` file instead of leaving it beside the record, logs one it can't remove, and fails with an error that names the record and says it was left as it was. A directory sync that fails for any other reason raises an ops alert naming the record, since the new record is already in place.

- The reference fetcher's per-server byte budget (an MCPL server's `autofetch.maxTotalBytes`, 1 GiB by default) now holds as it says. Each fetch read the server's total once, before it started, and set the total to that plus its own bytes when it finished. So concurrent fetches, such as the eager path's eight per result, could together go past the budget, and the last to finish overwrote what the others had added. Bytes read but not kept were never charged: a payload the workspace couldn't store, one whose digest didn't match, or a download stopped partway, by `max_bytes`, a timeout or the budget. Now each server's total is charged as each chunk is read, kept or not, and every fetch checks it at each chunk, so concurrent fetches can't together pass the budget by more than one chunk each. Where a fetch would pass both `max_bytes` and the budget, it's now refused for the budget, since a larger `max_bytes` wouldn't help: before it starts, when the budget is spent or a claim over `max_bytes` is also over what's left of it, and partway, when a chunk passes both. The spent budget's refusals now read `per-server fetch budget exhausted (<total>/<budget> bytes)`, the one partway after `aborted: `, where that one read `aborted: actual bytes exceeded per-server budget at <this download's bytes>`. A claim past both reads `claimed <n> bytes exceeds what's left of the per-server fetch budget (<total>/<budget> bytes)`. Each adds that the budget doesn't renew on its own, so calling again won't change that unless whoever runs the host raises or renews it.

- A tool result's data that isn't a content array of blocks agent-framework
  recognizes was stored, and sent to the agent, as plain JSON, so an RFC-005
  reference in it carried its raw uri into the agent's context and history.
  That JSON now shows, wherever in the data it sits, each reference as its
  stub (or as an unrecognized-block line when it's invalid), and inline data
  that also claims a uri or a disposition as withheld. A reference is a
  `resource` with a uri, at its top level or under `resource` where MCP
  embeds one, or an `image` or `audio` block given by `uri`; inline data is
  an `image` or `audio` block whose data is a string. Since JSON writes every
  field, inline data beside a uri of any value is withheld there, not only
  beside a string one. A uri that is null, absent or empty counts as none,
  and data that isn't a string isn't inline data, so a record that only
  shares one of those type names is written as before, as is everything else
  in the data: inline media that claims neither, with its bytes, and a
  `resource_link`'s fields among it. A reference that is the whole data is
  its stub, read as a content array's reference is, a `save_recent_image`
  slot included. The same text reaches a script that calls the tool, the
  direct Agent API's tool result, and a withheld result's kept fields, where
  data that is itself a reference keeps its stub whichever fields its tool
  marks. Results stored before the upgrade keep the text they were stored
  with, any uri in it included, which goes on reaching the model until those
  results leave its context.
- The notice for withheld inline content now says the inline data also
  claimed a uri or a bulk disposition. It named only a disposition, also
  when a uri was the cause. An `image` or `audio` block with neither string
  data nor a string uri is now said to have data or a uri that isn't a
  string when it has one, where the unrecognized-block line said it had
  neither.

- A refusal now reaches the model as an error result (`isError: true`), so it can tell a refusal from a tool that ran. That covers `tune_out`'s refusals (an unknown channel, a cancel of a channel that isn't tuned out, and an enter that can't go through, such as on a channel already tuned out), `channel_open` on a tuned-out channel, the subconscious's refusals of a `deliver_summary` with no text, a `cancel_tuneout` of a channel that isn't tuned out, a `note_disposition` with no key and a `speak_in_channel` it can't make, and the api module's `Unknown tool`. Each came back unflagged (`isError: false`, or for the api module no `isError` at all), so the model read it as a tool's ordinary answer, in XML tool mode as its `<stdout>`. `channel_open`'s refusal also showed the model only its `data`, `{"refusal":"tuned-out","channelId":"…"}`, and never the text saying to cancel the tune-out with `tune_out`'s `cancel` mode; the model now reads that text. A script's call to one of these tools now gets `Error: <text>`, as for any failed call. An in-process caller of `channel_open` (`ctx.callTool`) or of the api module gets the same result as before with `isError` set, and the tuned-out refusal keeps its `data`.

- **`history--search`'s snippet for a case-insensitive match now always
  holds the match.** The search found the match in the lower-cased text but
  cut the snippet from the text itself at the same position. `İ` (U+0130)
  lower-cases to two UTF-16 units, so each one before a match made the
  match's index in the text one unit too large, and enough of them left the
  match outside the snippet. The snippet now sits on the match in the text
  itself.

- The workspace's `glob` starts its walk at the directory its pattern names before its first wildcard, and `grep` at the deeper of its `path` and the directory its `glob` filter names that way. On a mount larger than its walk cap, a search for one directory's files then finds them, as long as that directory's own walk fits the cap. A walk of the whole mount could reach the cap before it got there and answer with no matches. The walk starts only as deep as disk lists each segment with the pattern's spelling, so on a case-insensitive disk a pattern spelled in another case finds nothing, as before. A search's `incomplete` now names only what lies beneath the directory its walk starts at, and a pattern into a directory the mount passes over by design (its ignore list, or another mount's directory) names that directory there. The start never goes through a link, as a walk of the whole mount doesn't. A `grep` whose `path` and filter name directories that don't overlap searches nothing. A search that starts below the mount root takes in, and announces, only the disk changes beneath its start, and no longer marks the mount's first whole sync done in `status`.

- A graceful framework shutdown (`AgentFramework.stop()`) with an inference
  still streaming records its own provenance before cancelling — the same
  `frameworkCancelledStreams` track that `endTurn`, budget restarts and
  quiesce use — so the stream driver settles the turn as a shutdown: no
  `[turn-interrupted]` marker (nobody stopped the agent; the host went
  away), no `inference:exhausted`, one `inference:aborted` with reason
  `shutdown`, an inference-log terminal, and the agent settled so an
  in-flight `runEphemeralToCompletion` rejects immediately instead of
  waiting out its idle watchdog.

- Without an EventGate, `skip_reply` no longer offers `wake_in_seconds`; a
  positive timer argument supplied anyway is refused visibly without ending the
  turn, while ordinary `skip_reply` remains available.
- Without an EventGate, a `skip_reply` call stored in the agent's history keeps
  its `wake_in_seconds`, which the host used to delete from it (#394).

- `skip_reply` reads `wake_in_seconds` one way for every part of the host: a number of seconds from 1 to 3600, or a string that reads as one, taken in whole seconds. A larger number waits 3600, `Infinity` included, where before `Infinity` armed nothing and the turn ended as an ordinary skip. The tool's description of the parameter now says "from 1 to 3600; a larger number waits 3600" in place of "clamped to 1–3600".
- With an EventGate, a `wake_in_seconds` that isn't such a number is refused as a tool error that names the value. That covers a number below 1, such as `0`, a negative or `0.5`, as well as `"soon"`, `""`, `true`, an array or an object. It arms nothing and doesn't end the turn. Before, `0`, negatives and `"soon"` ended the turn with no wake, a number between 0 and 1 such as `0.5` armed a wake of 1 s, and `true` and `[5]` armed wakes of 1 s and 5 s. A number below 1 is refused rather than raised to 1, so that `0`, which a model may write to fill an optional number, can't become a 1-second wake after every turn.
- Without an EventGate, any `wake_in_seconds` other than absent or `null` is now refused, as a positive number, `true` and `[5]` already were. `0`, negatives, `Infinity`, a blank string and values `Number()` can't read used to end the turn as an ordinary skip, which dropped the wake the call asked for without saying so.
- A `skip_reply` call whose input is `null` ends the turn as an ordinary skip, where the channel registry's handler threw reading `wake_in_seconds`.

- A failed read or write of the framework's own state is now an error, not an empty state or a success, in the two places that read a map and write it back whole.
  - When the tune-out coordinator's stored dispositions can't be read, each attempt at the subconscious's turn fails with the read error (`inference:failed`), and the error policy retries it as it does any failed compile, each attempt reading the store again, so the turn reaches the provider only with its dispositions. `note_disposition` answers that the note wasn't recorded, and writes nothing. A note whose write fails is in effect nowhere, since the coordinator caches a note only once it's stored. Before, a failed read cached an empty map in the dispositions' place: the subconscious compiled without them until a restart, and the next noted disposition replaced the stored map. A failed write kept its note in effect until a restart, and the next note stored it.
  - When the conversation router's generation counters can't be read at startup, `AgentFramework.create()` fails with the read error before anything starts, and closes a store it opened. A fork's counter is now stored before the fork is spawned, and a spawn whose counters can't be read or stored is refused, as a spawn that fails is, so the next qualifying message proposes it again. Before, the router started from no counters after a failed read, and after a failed write it logged the failure and spawned anyway. Either way the next restart reused a fork's agent name, reopening that engagement's namespace.
  - A state with nothing stored still reads as empty.

- A state that can't be registered, for any reason but that it already exists, now fails the call that registers it, with an error that names the state (#385). Those calls are `AgentFramework.create()`, `addModule()`, the workspace's `initStore()`, the MCPL checkpoint and host states, and the tune-out coordinator's state when it's written. Most of the registrations behind them swallowed every failure, a closed store or an I/O error alike, so the failure surfaced at a later read or write of that state, if one came, under that call's name. Two of them leave nothing behind when they fail this way: `initStore()` takes no mount until a call succeeds, and a feature set whose host state couldn't be registered is registered by the next call for it, such as a reconnect's. A registration the store answers with "already exists", as on a reopened store, is still taken as done.

- **A stop at a tool boundary stops the turn.** Once a round's last tool
  result was in, and while the framework stored the round (an oversized
  result spilling to the workspace), `Agent.cancelStream()` left the
  turn's stream running and `stop()` and `abortInference()` passed the
  agent over. The boundary then resumed the turn, or restarted it when it
  was over budget. So a host's stop there, such as connectome-host's Esc,
  its web UI's interrupt or a subagent's cancel, was undone, `stop()` let
  the turn run on during shutdown, and the framework's `abortInference()`
  returned `false`. Each now cancels the turn's stream, as it does while
  the round's tools run, and the framework's `abortInference()` returns
  `true`.
  - **What a host sees:** the stop's own terminal event instead of a turn
    that goes on. The stopped round isn't stored, as when a stop comes
    while its tools run: neither its assistant content (its text, any
    thinking and its tool_use) nor its results reach the window. A result
    that spilled keeps its workspace file, which nothing stored names.
    `tool:result_dropped` is emitted once, for the result the boundary was
    handling, as for a result whose turn changed while modules caught up
    with the batch. The round's earlier results go with it, without events
    of their own.
  - **What a reader of the store sees:** a round's assistant row, with its
    tool_use, is stored with its results, after the spill's workspace
    write, rather than before it. While the write runs, neither is in the
    window, so the window never holds the tool_use without its results.

- `stop()` now ends every ephemeral run still registered once its event
  loop has ended, with "refused: the framework is stopping", such as a run
  whose wake the loop hadn't taken up when `stop()` began, whose turn
  `stop()` refused, or whose retry it cancelled. Before, such a run waited
  for its startup watchdog (30 s by default) or, once its inference had
  started, its idle watchdog (15 minutes by default) before it rejected. A
  run's startup or idle watchdog that fires once `stop()` has begun,
  before that end, now rejects with the same error followed by what it
  saw, such as "(inference not started within 30000ms)". Before, it named
  a stalled event loop or a lost stream as the cause, even for a run whose
  turn `stop()` had refused.
- After a `stop()` that cancelled a turn's retry, a `start()` on the same
  framework (one whose store it doesn't own, or whose `stop()` failed)
  delivers the event gate's debounced batches again. The cancelled turn
  left its agent inferring at the gate, so every batch was buffered, and
  woke no agent, until that agent's next turn ended.
  `EventGate.dispose()`, which `stop()` calls once its streams and event
  loop have ended, now clears which agents are inferring. A turn that
  continues another, such as a budget restart left queued that a `start()`
  takes up, marks its agent inferring again through the new
  `EventGate.onInferenceResumed()`, which, unlike `onInferenceStarted()`,
  leaves a pending self-wake alone.
- A budget restart or tool-result-guard retry that a provider hold kept
  from starting, such as a stated wait or an acceleration cooldown, now
  marks its agent inferring at the event gate when it runs after the hold,
  as any turn that runs does, so debounced batches wait for its end.
  Before, the hold ended its turn at the gate, and it ran without it:
  unless another agent was inferring, the gate delivered debounced batches
  while it ran, into the message slot residents share.
- A turn whose retry `stop()` cancels now ends with `inference:aborted`
  after its `inference:failed`, with the reason "a retry waiting while the
  framework was stopping is dropped before it sends anything", and
  `healthSnapshot()`'s `lastInference` records its end. Before, nothing
  followed that event, and for a turn whose stream couldn't start,
  `lastInference` had no end.

- The tune-out coordinator's refusals say what didn't happen and what to do instead. `tune_out` on a channel that's already tuned out gives that tune-out's settings and how to change them, and its end time where it has one. A cancel of a channel that isn't tuned out, through `tune_out` or the subconscious's `cancel_tuneout`, names the connected channels that are and how a tune-out ends by itself, and says whose window its backlog goes to: "you" to the resident, "the resident" to the subconscious. A fork-bound channel says why `tune_out` won't divert it, and that calling again won't change that until its conversation ends. The subconscious's `deliver_summary`, `note_disposition` and `speak_in_channel` say what they need. `speak_in_channel`'s refusal where channel speech is off says the resident can speak there, through `deliver_summary` or by ending the tune-out with `cancel_tuneout`, and the configuration key it used to name goes to a `[tune-out]` log line for whoever runs the host.

- A tune-out's `durationSeconds` or `cadenceSeconds` longer than about 24.8
  days (2^31 - 1 ms, the longest delay one Node timer holds) now holds.
  Before, Node fired the timer almost at once, so such a tune-out ended as
  "duration elapsed" moments after it began, waking the resident with its
  backlog, and such a cadence re-armed about every millisecond, giving the
  subconscious a turn as soon as anything was diverted. Both timers now
  wait in steps no longer than one timer. The cadence counts its period on
  those timers, as it did before, so setting the wall clock doesn't move
  it. The end time reads the wall clock against the stored end at each
  step, so a host that runs through a long tune-out and one that restarts
  during it aim at the same end.
- A tune-out that ends in the channel registry without a cancel (the send
  path and the close tool set the channel's state there directly) no
  longer leaves its timers to act on the channel's next tune-out. Before,
  when the next tune-out had no `durationSeconds`, the old end time ended
  it as "duration elapsed", and a wake still in its 2-second coalescing
  window counted against it and gave the subconscious a turn.
- `tune_out` refuses a `durationSeconds`, `cadenceSeconds`, `backlogCap` or
  `maxWakes` that gives no finite number, such as `"abc"`, and a duration
  whose end time is too far off to store, naming the option and saying
  nothing was tuned out, before anything changes. Before, the store's write
  threw after the channel had been marked tuned out in memory, so the call
  failed and left the channel diverted with no cadence or end timer until
  the next restart. A numeric string such as `"3600"` is still read as its
  number.
- A `null` `durationSeconds` now means the tune-out lasts until cancelled,
  as leaving it out does. Before, it gave a tune-out of 60 seconds, the
  shortest duration.

- A tune-out's cadence, coalesced wake or end time whose work throws, such
  as a store write that fails during the subconscious's turn, no longer
  throws into the event loop, where an uncaught exception ends the host
  process. The coordinator writes the error to stderr and reports a
  `tune-out:timer-failed` trace naming the timer. Before, a cadence whose
  turn threw also never armed again. Now it arms its next period before
  the turn, and that next turn counts the failed turn's messages. An end
  time whose cancel throws before the channel registry has changed
  anything tries the cancel again a minute later, until it succeeds.
- A failed acknowledgement of a suppressed mention is written to stderr
  as well as traced, and a rejection with `undefined` or `null` no
  longer throws inside its handler.

- A reference registered with no server, such as one an in-process module
  returns, says it can't be fetched instead of inviting a `fetch_reference`
  call the fetcher can only refuse. Its stub, `fetch_reference`'s refusal
  (which read "reference has no server binding") and `save_recent_image`'s
  refusal now say "unbound: no server is recorded to fetch it from", as an
  expired reference's already say why. A saved copy is still offered.

- A cancelled stream (host Stop button, `agent.cancelStream()`,
  `framework.abortInference()`) is no longer recorded as an inference
  failure. It emits `inference:aborted` instead of `inference:exhausted`,
  leaves the consecutive-failure streak and ops alerts untouched, and writes
  a `[turn-interrupted] … a deliberate stop, not a failure` chronicle marker
  in place of the `[inference-failed] the model call failed…` text with
  remediation advice for a failure that never happened. The marker names the
  act, not an actor (membrane's `user` reason means "the signal was aborted",
  not "the user did it"), and makes no claim about delivery. Callers can pass
  their own provenance — `cancelStream(reason)` / `abortInference(reason)` —
  which the trace and the marker's metadata carry; `abortInference` no longer
  emits a second `inference:aborted` on top of the stream driver's. An
  ephemeral run that such a cancel ends now rejects with `Stream cancelled`,
  and the stop's inference-log row reads `Stream cancelled (<reason>)`, where
  both read `Stream aborted: user` before. This
  holds on both of a stream's cancel twins: a stream implementation that
  reports `cancel()` through `error` rather than `aborted` reaches the same
  terminal (one `inference:aborted`, the marker, no `inference:failed`, no
  `errorPolicy` retry of the inference that was just stopped), and the
  quiesce/shutdown twins no longer emit a contradictory `inference:failed`
  before settling as aborted. A third shape — an implementation whose
  `cancel()` simply closes the iterator, with no terminal event — reaches the
  same terminal too, at the loop's end, instead of leaving the turn unsettled
  under a `completed` lifecycle terminal. (#134, by Lari; reworked after
  review.)
- Speech-route failures with no delivery locus (headless/WebUI turns with no
  home or trigger channel) now read `[send-undeliverable] … had no channel
  to go to` instead of claiming a Discord delivery failure to "the channel",
  and say that this route delivered nowhere rather than that the reply
  reached no one — another `dispatchSpeech` handler may have shown it. The
  machine-readable marker `kind` is unchanged.

- Where disk has deleted a file the workspace still holds, the workspace's ways out say what they do there. A push's refusal for that path, and an edit's note on it, now say that a sync of the path takes disk's deletion, which removes the workspace's copy, and that a forced materialize writes the workspace's copy back. Where the path's branch intent can't be read, the refusal still names the sync alone, and now says it takes the deletion. Before, they offered to "take disk's copy" or "adopt the disk version" and to overwrite a disk copy that wasn't there, so an agent that synced to take disk's copy lost the workspace's copy instead. A conflict recorded before disk deleted the file keeps its kind, and its refusal now says disk has no copy of the file. Where disk does hold a copy, an edit's conflict note now says that a sync keeps disk's copy and gives up the workspace's, which holds whether or not the workspace can store disk's copy: one it can't store, binary or past the size limit, stays on disk alone.

- A file the workspace writes keeps its permission bits. Every tree entry recorded `0o644` whatever disk had, and every file the workspace created was created `0o644` under the umask, so a script re-created by a branch switch, an undo or a forced `materialize` lost its executable bit, and a `0600` file came back readable by others. Now a file taken in records disk's mode, with the regular-file type bits as git records one (`0o100755`), and a file the workspace writes again gets the mode its entry records, whatever the umask. A new file is created at its mode and given it exactly before its bytes, and a file written in place loses the bits its mode removes before its bytes and gains the ones it adds after them, so no bytes sit at a mode wider than both their old and new ones. An overwrite with `write` or `writeBinary` keeps the entry's mode, as `edit` does. A file the workspace creates has no mode in its entry until a sync, a listing or the watcher fills in disk's, and the push that writes it records the mode disk gave it as their agreement. The setuid, setgid and sticky bits, which entries don't record, are kept as a file has them when a write widens its mode or a push changes only its mode, and a write drops setuid and setgid before its bytes, whether or not it narrows the mode, and keeps the sticky bit, so no new bytes are written under a setuid or setgid bit the write saw when it checked the file. Where the kernel refuses that chmod, as on another user's file, the write goes on under the kernel's own rule for a write, which leaves setuid for a writer with `CAP_FSETID` and setgid where the group can't execute. A widening of the workspace's own change that the kernel refuses, after a write's bytes, to the exact mode of a file the push creates, or in a push of the mode alone that only adds bits, leaves the file at the mode it has and no mode owed: the evidence records none, so the next sync takes disk's mode in, as an edit's pass over the path does, and the push says so. Until then, a later write or named `materialize` of the path says that nothing records which side changed its mode, and a forced one meets the kernel's refusal again; each note names the sync. A narrowing of the workspace's own change that it refuses stays owed, before a write's bytes or in a push of the mode alone: the write is refused before its bytes, which aren't written wider than their mode, and a retry is refused the same way until the file's owner or an administrator narrows it, forced or not; a write's refusal names the mode the file has, the one its chmod aimed at and the workspace's, and a mode-only push's names the workspace's. A forced push over a mode disk changed, or one nothing records, whose chmod it refuses, narrowing or widening, ends where an unforced push would: a push of the mode alone leaves the path as it was, and a write's bytes go in at disk's mode and are recorded as an unforced write records them, which it says under `modesKept`; disk keeps its mode, and a sync takes it in. `materialize` lists a written path whose mode stayed as disk had it under `modesKept`, with why, apart from `skipped`, which holds only what it refused, and the `write` and `edit` tools and `writeBinary` give the same note as `modeKept` in their result, so a write whose mode stayed as disk had it is no longer reported as failed. The mode notes that offer force say to materialize the path with force, since the write tools take none. A write by a process without `CAP_FSETID` clears setuid, and setgid where the group can execute, as Linux does for any writer. On Windows, which reports only `0o666` or `0o444`, modes go unobserved, so nothing is taken in or applied there: a store written on a POSIX host keeps its modes, and the disk evidence records none, so a POSIX host that opens the store later reads each mode as unknown and takes disk's in, as it does for evidence from before modes were recorded.
- A file's mode changed on disk is taken in as a change on the same bytes: it's recorded as `modified` and makes no event, since it brings nothing new to read, and a sync lists it among what it synced. A sync that names the path takes disk's mode as it takes disk's bytes. A mode the workspace records that disk lacks, as after an undo or a branch switch, is owed to disk and listed as `workspace-draft` where disk still has the mode they last agreed on, and a push applies it as a chmod; `materialize` lists that path as materialized. A mode disk changed since stays, a push says so, under `modesKept` where it wrote the bytes and under `skipped` where it had only the mode to give, and a sync takes it in; forced, disk takes the workspace's mode, as it takes its bytes, where the kernel allows the chmod. A mode disk changes while a push runs, its bytes going in included, is kept the same way, unless the push is forced; one set in the instant between the push's last check and its chmod isn't, since nothing makes the two one step. A push that stopped partway left disk at one of its own modes: the old bytes at the mode it saw or at that mode narrowed to the new mode's bits, and the new bytes at the narrowed mode or the new one. Run again, it completes from there, writing the bytes before it widens, and never gives the old bytes the new mode; a sync that names the path takes in the mode the push meant those bytes to have. A mode set since the push stopped stays, as does the mode of a push that kept disk's, unless it's the mode disk and the workspace last agreed on, which takes the workspace's as on any other path.
- Entries recorded before this hold `0o644` as a placeholder, not a mode: such an entry never changes a file's mode on disk, and takes disk's mode the first time a sync, a listing or the watcher finds their bytes agree. That's no change and makes no event, though the first sync after upgrading writes each file's entry once. Evidence from before this records no mode either, so where an entry's mode and disk's differ and nothing records which side changed, disk's is taken in: an unknown never moves a file's mode on disk. agent-framework 0.22.1 and 0.22.2, opening a store this version wrote, keep the recorded modes through an `edit` and apply none of them to disk.

- A workspace materialize with `force` and `applyDeletions` no longer removes
  a pipe, socket or device found at a path the workspace deleted, nor a
  followed symlink that leads to a directory or to anything else that isn't a
  regular file. Like a write, which already refused such a path, the unlink
  now acts only on a regular file, or on a followed symlink to one (removing
  the link itself), forced or not. Where the workspace's deletion of such a
  path is refused, forced or not, the refusal says that no push unlinks it,
  and to ask whoever runs the host if it should go. Before, the refusal for a
  pipe, socket or device offered a forced materialize to delete it. A forced
  materialize without `applyDeletions` now refuses such a deletion in the same
  words, and a deletion over a directory in the directory's, rather than
  listing it among the deletions left on disk for `applyDeletions` to
  remove. A path whose branch intent can't be read is refused, or left, as
  before. As before, the unlink checks the entry as close to the unlink as
  Node allows, so an entry swapped in at that very moment is still removed.
  - **For operators:** to clear such an entry, which a forced materialize used
    to remove, remove it by hand with `unlink <path>`: it removes that one
    entry, never what a link leads to, and refuses a directory. (`rm -r` on a
    link to a directory written with a trailing slash acts on the directory
    it leads to.)

- A watched mount passes over what its `ignore` list covers, as a sync without a path does. The watcher handed chokidar the list as strings, which chokidar 4 compares with whole absolute paths, so no pattern matched, and every covered file the watcher saw change was taken in. A copy taken in that way stays as it was stored to every pass that names no path: a later change on disk isn't taken in, and its deletion is taken in where a walk lists its directory, as for anything a complete listing lacks. A copy beneath a directory the list covers stays, deleted on disk or not, the directory itself included, and so does one an `ls`, `glob` or `grep` reaches by its own path, or a sync naming a directory above it reaches by its walk.
- A mount nested inside another is passed over by the outer one as another mount's directory, in every pass, named or not, and by its watcher. The outer mount's ignore list gained the nested mount's path as written, which matched nothing for a mount more than one level down (`a/b`), so the outer mount took its files in as its own, and which matched the name at any depth for one directly beneath (`c`), so the outer mount also passed over unrelated entries with that name, such as `sub/c`. Now the outer mount's `ignore` list is left as configured, and the nested mount's directory is passed over as itself, counted under `passedOver` as "another mount's directory": the outer mount stops taking the nested mount's files, and takes files that only share its name. A sync that names that directory, or a path beneath it, with `/` between its segments, takes nothing in, and says so under `ignored`, where it took the nested mount's files in, since a named sync sets aside the `ignore` entries covering what it names (#276). That holds where an `ignore` entry covers a directory above the nested mount too. Files an outer mount stored from a nested one before, as `main`'s `a/b` mistake let it, stay in its branch's history and are listed with whose they are, but are passed over by its syncs, counted under `passedOver` and not under `incomplete`, and left out of its materialize and of `status`'s pending changes, conflicts and workspace deletions (its `fileCount` counts the tree as it stands).
- **The outer mount now refuses a nested mount's paths, reads included.** `read`, `read_image`, `write`, `edit`, `delete`, `readBinary`, `writeBinary`, `readBinaryFromDisk` and `readFileFromDisk` refuse a path in another mount's directory nested in the mount they name, judged where the path lands once its `.` and `..` segments and repeated separators are resolved, and the message names the mount that holds it and the path to use there; `readFileFromDisk`'s error code for it is `other_mount`, and `resolveAbsolutePath` returns null for such a path. A generated file the host registers at such a path is the same file whichever mount names it, and either reads it from its generator. `grep` returns none of the outer mount's copy of such a path; `ls` and `glob` list it with a note naming the mount that holds it and the path to use; a listing or `grep` naming a path there names them in its region, and a sync naming one in its note under `ignored`. A push of the outer mount, forced or not, skips such a path; a `materialize` that names one lists it under `skipped`, naming the mount that holds it, as a sync that names it does under `ignored`. A mount configured with a trailing separator no longer refuses its own root as traversal, and one configured with a relative path no longer refuses every path, generated files included, so the path the message names works. Before, a write through the outer mount, and any copy its store held there, went to disk at its next materialize over the nested mount's file wherever disk still agreed with the outer mount's evidence, and a forced one, as an undo or a branch switch makes, whatever disk held; and a read through the outer mount returned its own copy. A mount whose name only begins with two dots, such as `..cache`, now counts as nested.
- Three families of editors' swap and backup file names are passed over by a sync without a path, a listing and the watcher: `.name.swp` and `.name.swx` as the whole name (vim), and names ending in `~` (backups) or in `.subl…tmp` (Sublime Text's saves in progress), matched by `^\..+\.sw[px]$`, `~$` and `\.subl.*\.tmp$`. A directory with such a name is passed over with what lies beneath it. A sync counts one it doesn't track under `passedOver` as "an editor's swap or backup file", and reports one it tracks under `incomplete`. Naming one in a sync still syncs it, and lists it under `ignored`. Before, the watcher hid these names through chokidar's `atomic` option while a sync took them in, and that option tested the whole path, unanchored, so it also hid names such as `report.v2.swp`, and under a directory with a dot in its name, such as `~/.local/…`, every name ending in `.swp` or `.swx`, `notes.swp` included. The watcher no longer uses that option. An editor's save by rename reaches the workspace as a change to the file when the new copy is on disk by the time the watcher's batch is taken in, after its debounce. A copy still being written then is taken in as it stands and again whole once written, and one saved after a longer pause than the debounce is taken in as a deletion and then a creation. A copy already stored stays as it was to every pass that names no path, until its deletion is taken in, and a materialize treats it as any file the workspace holds, as it does a path the `ignore` list covers: it writes the workspace's copy while disk has what they last agreed on, as after a branch switch to history that holds it, and leaves a change disk made alone, as a conflict, unless forced.
- An `ls`, `glob` or `grep` that names a directory the mount passes over, such as one a bare-name `ignore` entry covers (`node_modules`) or one with an editor's name (`drafts~`), or a path beneath one, now takes nothing in there, and names the region under `incomplete`, adding that a sync that names the path takes in what's there, editors' files aside, as it still does. A copy the workspace stored there is listed, unobserved. Before, it listed such a directory and started tracking what it found; one a path entry such as `cache/**` covers listed nothing, and named nothing. A file tool names the path it acts on, as a sync naming it does: `read`, `edit`, `delete` and `readBinary` take in a file there that the workspace doesn't hold, as before, and the pass `write`, `edit`, `delete` and `writeBinary` make first, to settle a pending change on their path, observes it too.

## 0.22.2 — 2026-10-17

**Operators upgrading from 0.22.1:** on a workspace mount over 5000 files, the
first syncs and catch-up scans after upgrading catch up on what 0.22.1's
walks, which stopped at 5000 files, never reached, up to the mount's walk cap
(`walkCap`, 5000 entries unless configured) in each pass. Each pass pushes one
event for each kind of change it finds, listing every path, and where the
mount's `wakeOnChange` admits that kind, each event is one message to the
agent. Going back to 0.22.1 is safe for a store 0.22.2 wrote, with one
exception: 0.22.1 refuses to create the framework when an agent's persisted
runtime setting can't be applied, such as a budget no longer above the
recipe's `maxTokens`, or a budget below the recipe's on a strategy that can't
prepare a smaller window. 0.22.2 starts with such a setting and logs
`[agent-settings]` that it stays set but unapplied; reset it with
`resetAgentRuntimeSettings()` before going back. Under 0.22.1, a coalesced
message whose content passes 1 MiB with its inline images is refused again,
and walks stop at 5000 files again. 0.22.1 leaves the walk's place alone, so
coming forward resumes there, unless 0.22.1 wrote a checkpoint meanwhile,
which starts each scope's walk at its top. Keep context-manager 0.14.1, which
0.22.1's `^0.14.0` admits. Not tested: going back under connectome-host rather
than a bare framework, and a tail or pace kept unapplied.

### Added

- The `mcpl:server-closed` trace carries `reason`, why the transport closed,
  in its own words, such as `child process exited, and its pipe failed with
  write EPIPE` or `closed by host`. It is null when the transport gave none,
  and when the reason is a WebSocket server's own close text, which stays off
  the trace: `TransportCloseInfo` and the connection's close info mark that
  text with `reasonFromPeer`.

- `ProviderWaitNotSleptError`: when a retryable provider failure states a
  wait an ephemeral run won't sleep (longer than the 600 s it sleeps in its
  turn, infinite, or `NaN`), `runEphemeralToCompletion` now rejects with this
  error, carrying the wait as stated as `retryAfterMs`. Its message is
  unchanged. Its `name` is `ProviderWaitNotSleptError`, so a logged rejection
  reads that where it read `Error`. A host that decides whether to run a task
  again can test `instanceof` or the `name` instead of reading the message.
  Every other ending still rejects with a plain `Error`.

- `AgentFramework.switchBranch(name)` switches the store to an existing
  branch, starts the delivery of the Discord awareness marks the move
  changes, re-materializes the config mount, and then resolves. It doesn't
  wait for Discord, as the surgeries don't. If the mount fails, it rejects
  with the branch already moved. The branch moves under every agent
  sharing the store, so, as for `rollbackToMessage()`, every agent must be
  idle: during a live turn it refuses with `OperatorActionError`
  (`agent-busy`), and no turn starts until it's done. Once `stop()` has
  begun it refuses, and `stop()` waits for one already running.
  - The API server's branch switch used to run these steps itself, on the
    store, and now calls `switchBranch()`. So it refuses during a live turn
    instead of moving the branch beneath it. Its current branch follows the
    store from the moment it moves, and clients hear of a move even when a
    later step fails, but not of a refused switch. A branch create with
    `switchTo` creates the branch first, so during a live turn it creates
    it and answers the switch's refusal.

### Changed

- A context-maintenance pass no longer fails as a whole when one agent's readiness can't be read. context-manager 0.14, which agent-framework has required since 0.21.1, refuses its readiness queries while a strategy's initialization is pending (inside `switchBranch`, `fork`, `setStrategy` or `ContextManager.open`) or has failed, and a strategy can refuse on its own, as the autobiographical one does for a branch it hasn't reloaded. That agent's run now records the error, the agent gets its own `context-maintenance-failed` alert (`scope: 'agent'`), and the other agents run. Before, such a throw ended the pass for every agent, with one alert for the whole pass (`scope: 'pass'`). Anything else that throws while one agent's maintenance is prepared is that agent's failure in the same way. A failure that lasts, met by every pass, is logged, alerted and recorded in the maintenance history when it's first met, then again when its text changes, every 15 minutes while it lasts (the alert webhook's cooldown for it, counted from the webhook's last post of it), or after that agent's maintenance has gone without a failure. A pass that met only failures already reported, and took no tick, isn't added to the history unless an operator's `maintain` (`maintenanceTick()`) asked for it, so a lasting failure no longer pushes out the runs that did work. `getContextMaintenanceSnapshot()` reports such an agent as `ready: false` with an `error`, and a strategy that can't give a progress snapshot reads as having none.
- While an operator surgery (`rollbackToMessage` or `suppressMessages`) or `switchBranch` holds the store, no maintenance pass starts and no over-budget drain kick is started, a running pass or drain kick starts no new tick, and the operator call waits for them to finish before it switches or forks the branch, so no maintenance work overlaps the move. `stop()` waits for them the same way, a drain kick included, before it closes the store, so the tick in flight ends before the store closes, and once `stop()` has begun, no drain kick starts and none starts a new tick. Maintenance makes no provider call meanwhile, a conversation agent's included: one made under the hold, or once `stop()` has begun, is withdrawn without being sent, and so is a resident's call waiting at its provider gate when the hold is taken or `stop()` begins. That's no maintenance failure, and for a call outside context-manager 0.14's compression fallback ladder, a merge's or a chunk's canonical call with its retries after a `tool_use` stop, context-manager counts no attempt. One inside the ladder, after a chunk's canonical call was refused or cut short, is recorded there as a provider error, and once every rung has failed, the chunk's request family is quarantined, with its alert. Before, a resident's call made once `stop()` had begun was refused as a failure, so a restart that caught a maintenance tick before one of its calls logged a maintenance failure and raised a `context-maintenance-failed` alert; now the agent's maintenance logs that it stopped. An over-budget compile's `context-refusal` alert says whether the drain breaker kicked: `kicking`, `already draining`, or `not kicked` with the reason, where it said `kicking` whenever the agent was found, and `unavailable (no agent handle)` for one it can't find, as before. A kick joins what `stop()`, an operator surgery and `switchBranch` wait for before the alert is raised, so a listener on the alert that begins any of them waits for the kick, which then starts no tick. A merge keeps its place in the queue. When a chunk's compression is withdrawn outside the ladder, context-manager logs its "Failed to compress chunk (hierarchical)" line with the withdrawal, and the chunk is queued again at that manager's next rebuild, such as its next message or sent compile. The operator call never waits on a provider cooldown, or on the retry turn a cooldown queues, which the hold keeps from starting. `switchBranch` can therefore move the store after the call returns, and the API server's `branch.switch` announces the move it made once it has, while `branch.current`, the branch list, `/health` and `/status` read the store's branch whenever they report one. `maintenanceTick()` answers `ran: false` meanwhile, and `resume()` refuses with `OperatorActionError` (`agent-busy`), as the other operator calls do, including when the surgery took the store while `resume()` waited. Resume once the surgery has finished.

- **Built with TypeScript 7**, the native compiler, up from 5.9. Measured
  with 7.0.2 against 5.9.3 on the same source, the emitted JavaScript is
  byte-identical. What the package ships beside it changes:
  - seven declaration files under `dist/src/` (`mcpl/push-coalescer`,
    `mcpl/references`, `mcpl/tool-classes`, `mcpl/transport`, `mcpl/types`,
    `modules/workspace/types` and `tune-out/tools`) write string literal
    types with single quotes, as the source does; the types are the same;
  - source maps: of the `.js.map` files that change, all but four move only
    columns; in two a generated line maps to other source lines, and in two
    a generated line gains or loses its mapping, so a stack trace can land
    on a different column, and rarely on a different line or none. Of the
    56 `.d.ts.map` files that change, 49 map some declarations to other
    source lines and 7 gain or lose a line's mapping, which can move where
    go-to-definition lands;
  - `dist/tsconfig.tsbuildinfo`, the compiler's build record, changes.

  `test/stop-with-work-in-flight.test.ts`, whose build ships in `dist/test`,
  now parses `src` with `@babel/parser`, a new devDependency: the main entry
  of TypeScript 7's package has no compiler API, and its `./unstable/*`
  entries reach the native compiler over IPC.

  As with the same source built with 5.9.3, a consumer on TypeScript 7 with
  `skipLibCheck` off whose `types` leaves out `node` can get Node-name errors
  from this package's declarations and its dependencies', unless its program
  already reaches Node's types. Install `@types/node` and list `node` in
  `types`, as this package's own `tsconfig.json` now does.

### Fixed

- A coalesced MCPL message with inline images is admitted like any other message (#266). Coalesced `channels/incoming` and `push/event` items, and render results, were checked against a 1 MiB budget on their serialized content, inline base64 images included, which uncoalesced messages never had. Any message with a sizeable screenshot was refused as `coalesce_invalid`, never stored and never woke the agent, and discord-mcpl tags every message create with `coalesce`. An incoming coalesced item's content must be an array of objects with something visible in it (a retraction may be empty, and on the push lane so may a silent heartbeat), and within that it is admitted as an uncoalesced message is: a block the converters can't render, such as a video or an unknown type, becomes the same placeholder whether or not the message was coalesced. The converters of both lanes now take any object without throwing: a block's type, text, data, mimeType or uri that isn't a string is treated as absent, so a malformed block becomes a placeholder too (a text block, no text) instead of throwing in conversion, where the sender got no answer and a `channels/incoming` batch stopped before its later messages. An image or audio block that has data but no usable media type reads `[Image: no media type]` or `[Audio: no media type]` rather than claiming no data, and an image or audio block with a disposition is a reference only when its uri is a non-empty string. A `shouldTriggerInference` filter, and so the EventGate's content filter, reads on both lanes the text the agent's context gets, the converted text blocks joined with line breaks: on the channel lane, which read the message's own text blocks before, a block that converts to text (an unknown type's placeholder, an image with no data, a reference stub) is now part of what a filter matches, as it already was on the push lane, and text that isn't a string reads as empty. A render result, which the host delivers in the occurrence's place, gets every check a pushed payload gets (RFC-006 §5.2) except visible emptiness, since an empty render means nothing happened, and one more: each block must be one the converters show as itself (its text, or its image or audio source) or as a reference stub. A render with a block that would show as a placeholder falls back to the occurrence's own content, which a pushed payload doesn't have. The 4 KiB bound on `coalesce.data`, which the coalescer holds outside context, is unchanged.
  Every coalesce rejection is now visible on the host as well as on the wire: as a `mcpl:channel-incoming-rejected` or `mcpl:push-event-rejected` trace with the error's message in `detail` and the failing `field` when the error names one, and as a line, unless it is a push refused for its channel within a minute of that channel's last line (below). A coalesce rejection's `[channel-incoming-rejected]` line names the server, channel, message id and failing field, and its `[push-event-rejected]` line names the server, feature set, event id and failing field; each ends with the error's message. When a channel's refusals were held back, the next line printed for it adds how many. The reason follows the answer the sender got: `coalesce-invalid` when the item was the sender's to fix (malformed, or a push to a channel it isn't permitted or hasn't registered), `coalesce-failed` when the host itself failed (coalescing unavailable, the host stopping or unable to make an acceptance durable, or an internal error). A `channels/incoming` message for an unregistered channel now gets a line too (`reason=unknown-channel`), coalesced or not. So that a server that never registered a busy channel doesn't print a line for every message in it, a channel's first refusal prints, and after that a refusal prints only once a minute has passed since the channel's last line, naming how many were held back since; a channel-scoped push refused because its channel isn't declared (-32023) or may not be used (-32017) prints the same way on its own lane, per channel, and its line and its trace name the channel. Every refusal is still answered and traced. The unknown-channel trace carries the message id, and its reason is now `unknown-channel`, the line's token (it was `unknown channel — not registered (§14.5)`). A render result the host refuses gets a `[push-render-failed]` line naming the server, subject, event id and failing field, and the occurrence's own content is delivered instead. A missing push `eventId` prints as `""` on every `[push-event-rejected]` line, and the push rejection trace carries `''`. The wire answers are unchanged.
  The host log lines listed here now print the values a server chose (channel, message and event ids, feature set and field names, a tool's name and declared classes, an advertised capability's key, a discarded method's name) in a form a server can't use to add a line that reads as another host record, a word that reads as another field of the same line, or a `key=` that a search for that field finds before the real one. That covers every `[channel-incoming-rejected]` and `[push-event-rejected]` line, the existing empty-content, duplicate and feature-set rejections included; the `[channel-incoming-dropped]` and `[push-event-dropped]` backstops; the `[routeSpeech]` delivery and closed-locus lines; the `[inference-refusal]` line for a locus with no server; both conversation spawn-failure lines, the routed message's and the coalesced batch's; the `[heartbeat]` silent-wake line; the feature-set disabled line, the tool-class lines, the masked-capability line and the discarded-method line. A plain token (visible characters with no space, quote, backslash or `=`) prints as before. Anything else prints as a JSON string with every `=`, every space and every invisible character escaped (a line break, a terminal escape, a bidi control, a default-ignorable character such as a Hangul filler or a variation selector), so `JSON.parse` of it gives back exactly what was sent. A value longer than 256 UTF-16 units is cut instead: it prints, quoted, as its first 256 (255 when the 256th is a high surrogate) followed by `…(N)` with N its full length. A value that isn't a string prints as its JSON text, a non-finite number as `NaN` or `Infinity`. The feature-set rejection's reason, which names the feature set, is a field like any other: `reason="Unknown\u0020feature\u0020set:\u0020…"`. The `[inference-refusal]` line's locus, and a plain unknown tool class, now print without literal quotes. The host's own message at the end of a line is quoted and cut the same way but keeps its plain spaces and `=`.

- A workspace mount with more files than one walk takes is now covered by repeated syncs (#272). Each mount sets its cap with `walkCap`, a positive integer no larger than `Number.MAX_SAFE_INTEGER` that defaults to 5000; any other value is refused when the module is created, naming the mount. A bare `sync` or a `sync` of a directory that reaches the cap lists what it didn't reach under `incomplete`, and the next one of the same scope resumes after the last entry it took, then wraps to the start. A watched mount's catch-up scan (at start and when its watcher reattaches) takes its turn in the same rotation as the mount's bare syncs. The place is kept with the mount's disk evidence, so a restart resumes there too, unless the machine went down before the store made the latest place durable, which only starts the next walk at an earlier place. Before, every walk stopped at the same 5000 files, so no walk ever reached the files past them. An agent-action scan (`watch: 'on-agent-action'`) still takes up to the cap from the mount's start after every tool batch, and a listing (`ls`, `glob`, `grep`) still takes up to the cap from its scope's start. Both now take entries in the walk's name order, so on a mount over the cap they can reach different files than 0.22's first 5000, which followed the order the platform lists a directory in.
  - A walk takes each directory's entries that aren't directories by name, then its subdirectories by name, so each walk can resume where the last stopped, whatever order the platform lists a directory in. A link, or another entry that isn't a directory, counts against the cap as a file does, since the pass reads each one it takes, through the link on a mount that follows them.
  - Each directory's listing is read whole, so a file deleted on disk is seen wherever the walk lists, past the cap included. Before, a directory holding more files than the cap never proved a deletion.
  - Because a watched mount's catch-up scan takes its turn in the rotation, on a mount over the cap a change made while the process was down reaches the workspace when the rotation comes to it, or when a sync of its path takes it. Before, the catch-up scan at start took a change among the first 5000 files every time, and never one past them.
  - The `sync` tool's description now says that a sync takes up to the mount's walk cap, and that the next sync of the same mount or directory picks up where the last turn stopped, with a watched mount's catch-up scan taking turns with its whole-mount syncs. So the first request after the upgrade that carries the workspace's tools misses the prompt cache from its tool block on.
  - On a mount over 5000 entries, the first syncs and catch-up scans after the upgrade catch up on what 0.22's walks never reached: files past the old cap, never scanned, and edits and deletions of tracked files there. Each such pass pushes one event for each kind of change it finds (`workspace:created`, `workspace:modified` or `workspace:deleted`), each listing every path, and a mount whose `wakeOnChange` admits that kind turns each into one message to the agent. Any pass that lists a directory larger than the cap, a listing or an agent-action scan included, also proves deletions there that 0.22 never proved.
  - Going back to 0.22: its walks stop at the same 5000 files as before. It leaves the place alone, so coming forward again resumes there, unless 0.22 wrote a checkpoint meanwhile, which drops every place and starts each scope at its top.

- Removing a single message that belongs to a body, a one-shard body's included, no longer fails: context-manager's `removeMessage` refuses any message in a body, so agent-framework now removes one as a range in offline recovery's suppressions, and in a Discord suppression resumed after a crash. The host `hide` command now hides a message stored as a body (a long one, in shards) whole, with every stored copy of it (a write cut short leaves a partial copy before its retry). Its range form takes what was stored between its two messages, from the earlier one's first copy through the later one's first, and every copy of both, each whole, so a copy stored outside that span is taken on its own, and nothing else stored after the later message began is taken. Offline recovery's suppressed ranges (`suppressRanges`) take the same: before, a range ran through the later message's last copy, taking what was stored between that message's copies, and left out a copy of the earlier message stored after it. Either form's operator-log entry lists at most 50 of the ids it removed, with `removedIdsTruncated` when there were more. It's refused as busy while a surgery holds the store, and a message with no Discord id never matches one. A module's removal of a message it added, and the coalescer's, take its whole body too, and an automatic rewind whose newest message is a shard of a body takes the whole body.

- A lower context budget the agent was running at comes back at once after a restart, when a compile recorded it as reached and the boot's preflight says it still fits (context-manager #162). Before, every restore of a lower budget paced a new descent from the recipe's budget, on a strategy that can prepare a smaller window, so until the first compile settled it the agent reported `converging` and planned at the recipe's budget.
  - **The marker.** The persisted runtime settings carry `contextBudgetReachedTokens` beside `contextBudgetTokens`. It is the record's own budget, written when a compile fits at it (a paced descent's settle included), and withdrawn when the context manager refuses that budget as over budget, even if the budget changed while that compile ran, unless a compile at that budget that started later has already ended with a fit or a refusal: of two compiles at one budget, the one that started later planned at the newer store, so an earlier-started one that ends after it is ignored. The context manager selects against the budget before it adds injections, so a compile with injections plans like one without, and the marker says the stored context fits the budget, not that a request with its injections, system prompt and tools does. A fit counts only if the live budget didn't change while the compile ran, and a settle only for a compile that began under that descent; each arm of a descent is a new one, to the same target included. What a compile showed stands only until the live budget changes: after a persisted change, immediate or paced, back to an earlier budget included, the record carries none until a compile fits at the new budget. A `persist: false` change leaves the record as it was, marker included. A compile must record a fit before an unmarked record can take the proof-based immediate path.
  - **At boot**, each persisted setting is restored on its own: the think-text policy, then the tail and the pace, and the budget last. A budget below the recipe's whose record carries the marker is applied at once if the preflight says it fits now, and otherwise paced from the recipe's budget, as before. The preflight plans the stored context as the context manager will, with the restored tail and pace, so it sees a new `maxTokens` or strategy configuration a restart brings, and a context that grew while the agent ran at another budget; the system prompt, tools and injections are outside the context manager's budget. A budget at or above the recipe's is applied at once with or without the marker, as an increase always is.
  - **If a compile at a budget below the recipe's that the boot applied at once is refused** before any compile at it has fit and before the budget is next written (an update that carries a budget, whatever its value, or a reset of it), the refusal withdraws the marker, and the agent makes the paced decrease a boot without the marker makes, from the recipe's budget: the budget alone, with the default pace when the strategy has none. Then it compiles again. If the budget can't be restored paced, the agent compiles at the recipe's budget with the budget kept set. This fallback runs once: a compile refused after it, including one already in flight at the boot's budget or the fallback's own compile at the recipe's, reports its own refusal, as does one the start order ignores. A tail, pace or think-text policy change leaves it in place.
  - **A persisted setting never stops the agent booting,** except an invalid think-text policy, which still fails closed. A tail, pace or budget that can't be applied now (a tail or pace on a strategy without live settings, a budget no longer above `maxTokens`, a lower one restored paced on a strategy that can't prepare a smaller window) is kept set but unapplied, so a later persisting write keeps it in the record, and the agent runs at the recipe's for it. A `private` think-text policy beside such a setting still governs. When a marked budget isn't applied at once or a setting can't be applied, one log line says why, what couldn't be applied, and the budget that's set beside the one compiles plan at.
  - **Smaller:** a patch can't set the field; a malformed persisted number (the marker, a budget, a tail or a pace) is ignored with a log line naming its kind; a record holding nothing else restores nothing. If reading the record fails at boot, the agent logs it and boots at the recipe's; a store that can't be read at all still fails agent creation at an earlier read of the same state, as before. A record that can't be read or written when a compile tells it is logged, and told again at the next compile at that budget.
- Outside a descent, `previewAgentRuntimeSettings` and the budget preflight plan a patch at the reach its next compile plans at: the pace for a paced decrease, and the configured reach otherwise, so an immediate change, and a pace with no descent, preview at the configured reach. A preview taken during a descent plans under that descent's prepared window, and at its live pace when the strategy carries one, which a preview can't change.
- The runtime settings snapshot (`getAgentRuntimeSettings`, `agent_settings` `get`) reports `effectiveContextBudgetTokens`, the budget compiles plan at now, beside `contextBudgetTokens`, the budget that's set. They differ while a lower budget converges, when compiles still plan at the budget the descent started from, and while a budget the agent couldn't apply is kept, when they plan at the budget it runs at. Code that builds an `AgentRuntimeSettingsSnapshot` itself, such as a test double, adds the field.

- `previewAgentRuntimeSettings()` no longer throws when an agent's context manager (0.14, required since 0.21.1) refuses its queries, as after its strategy failed to initialize: it answers `{available: false, reason}`, with the agent's live budget and the patch's path, as it does for any preview it can't compute. So `resume()` no longer throws for such an agent either. It warns, naming the agent and the reason, and proceeds without a feasibility verdict for that agent: the verdict guards against an agent that would run over budget, and an agent whose manager refuses its compiles can't run. That manager refuses the agent's turns and writes until a `switchBranch` or `setStrategy` succeeds, and maintenance reports it.
- Offline recovery (`createOfflineRecoveryBranch`) reads a sharded message's body as context-manager 0.14.0 does: a message continues the body before it only when it carries the same group id at a higher shard index. A document posted twice stores two copies under one group id, so an anchor at the end of one copy, or a suppression of one copy alone, is no longer refused. A selection inside one copy is still refused. An anchor at the end of a write that was cut short keeps that partial body and leaves out its retry, which context-manager 0.14.0 reads as a body of its own.

- Requires context-manager 0.14.1 (was `^0.14.0`). In 0.14.0, under the
  autobiographical strategy, a dry compile that was the first compile after a
  message's removal left later compiles reading message positions from before
  the removal, so every later compile could throw `UncoveredDropError` until
  something rebuilt the order (anima-research/context-manager#180). Previews
  now compile dry, and hiding or suppressing messages answers with one right
  after it removes them, so with 0.14.0 a hide or a suppression could leave the
  agent unable to compile its next turn.
- context-manager 0.14.1 also reads a calibration record written by 0.13.0 or
  earlier, which has no pricing stamp, as provisional rather than learned
  (anima-research/context-manager#179). It may be discarded at load; one above
  1 that puts a compile over budget drops to 1; and the first provider sample
  replaces it. So an agent whose autobiographical strategy uses adaptive
  resolution, upgrading from such a store, can compile a different window when
  the record is read, and again when the first provider sample sets the
  multiplier, rather than over about ten samples. A store that has already run
  a committing compile on 0.14.0 keeps its re-stamped multiplier;
  context-manager 0.14.0's notes give the one-time reset it may still need.

- A start that continues a logical turn now keeps what the turn has decided
  about where its speech is published. Those starts are a framework retry
  after a stream error, the re-inference that consumes unstreamed tool
  results, and the compile a provider-capacity hold defers a turn to (#314).
  Before, each began with fresh routing:
  - in hybrid mode, the hold after `>>>skip_reply` was dropped, so the new
    stream's unprefixed prose was published to the turn's locus;
  - the sticky destination was dropped in both modes, so unprefixed prose
    went to the locus in hybrid mode, and in explicit mode bounced with a
    notice and a wake, while the new stream streamed nothing;
  - the turn's locus was resolved again: a retry lost a mid-turn addressed
    re-pin, a re-inference took the locus of whichever wake started it, and
    a held turn's later compile let a newer ambient message move it.

  A hybrid stream's live outgoing deltas still start at the turn's locus,
  as before.
- A message that no tool boundary weighed now moves the turn's locus at the
  turn's next start, by the rule a mid-turn message follows: a
  conversational message that addressed the agent, or that follows up in a
  channel the turn sent into, with the same
  `[routing] The conversation moved to …` notice. That covers a message that
  arrives during a capacity hold or before a re-inference, and one drained
  at a budget restart's over-budget boundary, which before never moved the
  locus. Ambient traffic in a channel the turn hasn't sent into, reactions
  and system markers don't move it. Neither does a message the agent won't
  see: one that tune-out diverts, or one removed before that start, such as
  an unread coalesced message its server retracted. The newest qualifying
  message that remains decides. Residents read one message slot, and a
  tool boundary weighs only the messages drained for its own agent, so each
  resident's open turn also takes, by the same rule, a message stored for
  another resident whenever it lands, including one that resident's
  boundary drained. A message tagged as addressed addresses the account the
  residents share, so it can move any resident's turn.
- A silent turn's tool boundary no longer re-pins its locus or adds a
  `[routing]` notice to its stream.
- For a trunk agent, the channel context passed to `beforeInference` hooks
  (`channels.defaultOutgoing`) names the turn's locus once the turn has one.
  After a re-pin, a later start of the turn reports the locus it moved to,
  where its unprefixed speech is published unless a hybrid `>>>` destination
  takes it, not the channel that triggered the turn. A conversation fork
  still reports its home channel.
- A start that fails before its stream exists now lands the messages
  deferred during it, as a stream's end does. Before, they waited for the
  agent's next start and landed after any message stored in between. A
  start that throws outside its stream's failure handling ends its logical
  turn, so the agent's next start opens its own, and an ephemeral run
  (`runEphemeralToCompletion`) whose start throws that way fails at once
  with the start's error. Before, the run waited for its watchdog: 30 s by
  default before its inference started, or 15 minutes once it had.
- A send's engaged channel is recorded on the turn that called the tool,
  even when the open that follows the send comes after that turn has ended.
  A `channel_open` moves the locus of the turn that called it while that
  turn is open. Its result tells the agent of the move, so one that comes
  after the turn ended moves nothing: the result is dropped unread.

- The Discord module's typing keepalive now stops when a turn completes normally, at `inference:completed`. It stopped only at `inference:turn_ended`, `inference:aborted`, `inference:failed` and `inference:exhausted`, so with `autoTyping` on, its default, the indicator went on refreshing after an ordinary reply until the agent's next `inference:started` or its five-minute cap. `onTrace`'s documentation now names `inference:completed` as a turn's normal end, beside the other four.

- `agent-framework-mcp`, the MCP server's bin, now runs as an installed
  command on Linux and macOS. Its file had no `#!` line, so the shell ran it
  as a shell script, and it started only when `argv[1]` ended in
  `mcp-server.js`, which the path of npm's link doesn't. The command is now
  a file of its own that always starts the server, run through the link or
  by its own path, as `mcp-wrapper.sh` runs it. `McpServer` moved to a
  module of its own, which the package root still exports, so importing or
  bundling the package never starts a server. Before, an entry script, or
  a bundle, named `mcp-server.js` did. The server is a client of the
  framework's WebSocket API (`AGENT_FRAMEWORK_WS_URL`, default
  `ws://localhost:8765/ws`), which must be running: without it, it prints
  "Failed to start MCP server" and exits 1.

- A connect or reconnect whose stdio server fails its handshake, by exiting,
  by a transport error or by not answering in time, such as a server that
  exits at startup for want of a token, now keeps the last of the server's
  stderr: at most 2,048 UTF-16 code units, after a `…` when earlier output
  was dropped. The error named only how the handshake failed, and what the
  server wrote about why was dropped (#339). The stderr stays out of the
  error's message, which travels wherever errors go, tool results included,
  since a server's stderr can hold a credential. The error carries it as
  `stderrTail`, the connection's `'connect-failed'` and `'reconnect-failed'`
  events carry it beside `error`, the host's log line about the failure
  prints it a line at a time, and the `mcpl:server-connect-failed` trace
  carries it as `stderrTail`. The `mcpl-down` ops alert, which posts to the
  operator's webhook, leaves it out. An `initialize` error answer, where the
  server gives its own reason, is unchanged.
- A stdio server's last stderr line, when it has no newline, is now emitted
  as a `'stderr'` line once the stream ends. It was kept until more output
  completed it, so it never arrived (#339).
- A stdio server's stderr is decoded as one stream, so a character whose
  bytes arrive in two reads is no longer replaced with U+FFFD in its line.

- `StdioTransport.close()` resolves for a child that a signal other than its
  own `kill()` has already ended, such as an OOM kill or a crash. It waited
  for an `exit` event that had already fired. So a connect or reconnect whose
  child died that way during `initialize` never settled, `close()` on its
  connection never settled, and `stop()` never returned, or, given a teardown
  timeout, failed when it ran out (#331).
- An error an MCPL transport reports while nothing else listens for it is
  now logged instead of thrown as an uncaught exception. That covers a
  transport that `McplServerConnection` keeps for `close()` while a
  reconnect's handshake finishes (#332), a transport whose handshake has
  settled until the connection takes it, and one that a failed handshake is
  closing. A malformed frame from a WebSocket server is such an error.

- An error on a stdio MCPL child's stdin or stdout, such as a write's EPIPE
  from a child that closed its stdin but kept running, is now handled as the
  end of that child. Such an error was thrown as an uncaught exception, and
  where a host caught it, a child that kept running left the connection
  connected, with each request waiting out its timeout. Those pipes carry the
  protocol, so the transport sends the child SIGTERM if it's still running,
  and when the child exits, the transport's close names the error (`child
  process exited, and its pipe failed with write EPIPE`), unless the host had
  closed the transport first. The connection handles that close as any other
  exit: it rejects its pending requests, and reconnects if `reconnect` is set.
  A child that ignores SIGTERM keeps running, and its requests still wait out
  their timeouts. A read error on the child's stderr, which was thrown as an
  uncaught exception too, now reaches the transport's `'error'` listener if
  it has one and is otherwise dropped: once the connection is wired it ends
  nothing, and during a handshake it fails the handshake.

- A stdio MCPL server whose command can't be spawned, such as a command that
  doesn't exist, now fails its connect or reconnect attempt with
  `MCPL server "<id>" could not be started: ` and the runtime's spawn error,
  such as Node's `spawn <command> ENOENT`, which is also its `cause`. Node
  reports a failed spawn after `spawn()` has returned, and a reconnect
  attempt, which runs from a timer, got that report before anything listened
  for it. So it was thrown as an uncaught exception, which ends a host that
  has no `uncaughtException` handler (#336).

- The physical-window projection (#92) projects from the stream's latest
  provider call that reported a prompt. Membrane's usage event is the stream's
  running total across the tool loop, and the projection added it as the
  prior call's prompt and output, so from the boundary after a stream's
  second call on, an agent with `physicalWindowTokens` set could restart its
  stream even when the next request would have fit. Its physical-window
  restart now comes only when that call's prompt and output, what the stream
  has grown by since that call, the round about to be appended and the
  response reserve together cross the window (`maxStreamTokens` still
  restarts on its own), and the `inference:stream_restarted` trace's
  `inputTokens` for a `physical_window` restart is that projection. The
  growth is the blocks appended since that call and the output of each later
  call that reported no prompt. A call's output of 0 counts as `maxTokens`,
  the bound on it, since a call that ends at a tool boundary always wrote a
  `tool_use`. The projection runs once a call on the stream has reported a
  prompt. `Agent.lastStreamRealInputTokens` holds that call's prompt, which
  is what the provider billed, and `lastStreamOutputTokens` its output;
  `Agent.lastStreamUnreportedTokens` holds the growth since.
  `lastStreamInputTokens` stays the stream's accumulated fresh input, which
  is what `maxStreamTokens` checks.

- **`stop()` waits for an operator's operation that is already running, and
  refuses new ones.** A quiesce, a resume, a
  `host/command`, a store surgery, a branch switch, an undo or redo's config
  materialization, a puppet tool call, an awareness sync, or an MCPL
  connect, disconnect or restart admitted before `stop()` began now
  finishes before the event gate, the modules, the MCPL connections and the
  store go, unless a budget runs out first (see the operators' note below).
  Before, such an operation kept running through the teardown. A resume
  waiting on its maintenance pass or previews could go on to leave quiesce
  while the host stopped, so the host booted unquiesced; a puppet call
  could find the store closed partway; a surgery could still be running at
  the final sync; a `host/command` could answer after its connection
  closed; an API server branch switch requested during `stop()` moved the
  branch, mounted its config after the store had closed and answered
  success; and a connect could leave a connection that nothing closed.
  - Once `stop()` has begun, `quiesce()`, `resume()`, `rollbackToMessage()`,
    `suppressMessages()`, `switchBranch()`, `undoLastTurn()`, `redo()`,
    `maintenanceTick()`, `puppetToolCall()`, `syncDiscordAwarenessMarkers()`,
    `connectMcplServer()`, `disconnectMcplServer()` and `restartMcplServer()`
    refuse with "<verb> refused: the framework is stopping" before they
    read or change
    anything, as a `host/command` already did. That includes a call made
    from a trace emitted inside `stop()`'s own start, before its queue has
    closed, and the MCPL listener now refuses a `host/command` from that
    moment too.
  - The awareness delivery that a surgery, a branch switch, a `host/command`
    undo, or the API server's undo or redo starts
    (`startDiscordAwarenessDelivery()`) runs like a server's drain: `stop()`
    doesn't wait for it, and once `stop()` has begun none is started, since
    the teardown would cut it off. The durable outbox keeps the marks, and
    the next start delivers them.
  - `stop()` also waits for what those operations start while it waits: the
    config materialization that undo, redo and the two surgeries start
    without waiting for it themselves. The framework now logs a failed
    materialization.
  - A quiesce stops waiting for its drain, or for an abandon's grace, once
    `stop()` begins. `stop()` cancels the streams and waits for the event
    loop and the operations above, puppet calls included. It doesn't wait
    for any other turn that holds its token with no stream to cancel, so a
    quiesce cut short can report `drained: false`. The host stays quiesced,
    so it boots quiesced. A drain cut short logs that it stopped waiting,
    emits no `host:quiesce` trace, and leaves an abandon it hadn't begun to
    `stop()`, which cancels the streams. An abandon whose grace is cut short
    reports its abandon as usual.
  - A resume refuses at its start once `stop()` has begun, whether or not
    the host is quiesced, and checks again after its maintenance and preview
    waits, before it leaves quiesce, so a quiesced host stays quiesced. A
    resume past that point finishes, its durable clear included, and its log
    says that the parked wakes it released won't run.
  - A host's trace listener can call `stop()` from inside an operation, such
    as on its completion trace, and `stop()` still waits for that operation.
    A multi-turn `host/command` undo stopped that way still undoes every
    turn it was asked for.
  - `undoLastTurn()` and `redo()` refuse with `OperatorActionError`
    (`agent-busy`) while a surgery or a branch switch holds the store,
    instead of moving the branch beneath it.
  - A `stop()` called from a trace emitted inside `stop()`'s own start, as
    the push coalescer's suspension emits for a render in flight, gets the
    attempt already running. Before, it started a second teardown beside
    the first, which then failed at its final sync, and every later
    `stop()` rejected with "Store has been closed" for a framework that had
    stopped.
  - While the host stops, an MCPL awareness barrier that fails no longer
    recycles the connections, which `stop()` is closing. The framework
    releases it as it releases a completed one, so nothing waits on a
    rejected barrier, and unless the host is quiesced, what it held back
    reaches the listeners' stopping refusal.
  - **For operators:** `stop()` waits as long as an operation's own work
    runs. An awareness drain finishes its deliveries, each within its own
    deadline, and a puppet call waits for its tool, so a tool on an MCPL
    server that never answers holds `stop()` until the request times out
    (60 s by default, never with `requestTimeoutMs: 0`).
    `stop(teardownTimeoutMs)` gives this wait its own budget, shared by all
    its rounds, and then gives the modules' and MCPL's teardown the budget
    again, so a budgeted `stop()` can take up to twice the budget, beside
    the stream and event-loop waits that no budget bounds. An operation
    that outlasts the budget fails `stop()` with a `ShutdownTimeoutError`
    that names it, on its own or inside an `AggregateError` when other
    cleanup failed too. `stop()` still tears down the rest, while that
    operation may still run, and keeps the store open, so `stop()` can be
    called again.

- A turn the framework drops before it sends anything, because its agent was replaced or removed, or the framework was stopping or had been stopped and started again while the turn was assembled or compiled, now ends with `inference:aborted`, whose `reason` says which, and records `lastInference.endedAt`. The turn had emitted `inference:started` and then no terminal event, so a module that brackets a turn between them, such as a typing indicator, kept that turn open, and the health snapshot showed it still running. When a newer turn of the agent's name already holds its turn token, the dropped turn emits and records nothing, since both carry only the name and would end that newer turn. The web UI in `ui/` now also returns an agent to idle on `inference:turn_ended`, `inference:aborted` and `inference:exhausted`, where it had looked only at `inference:completed` and `inference:failed`.

- Compiles that are never sent are now dry runs (context-manager's
  `SelectOptions.dryRun`): `previewActivation`, which undo, rollback and
  hiding messages also run for their "last visible" line; the API's
  `message.list` and agent context commands; and a conversation fork's seed
  (the template's compile and the new namespace's emptiness check). A
  committing compile persists fold resolutions and queues the compression its
  fold plan calls for. Once context-manager's thinking binding
  (anima-research/context-manager#160, not yet released) ships, it will also
  commit stamps and join the branch's compiles awaiting acceptance, where one
  never sent can cost a live stream's later replies their thinking. A dry run
  does none of that, and it leaves the agent's consumed watermark and a
  prepared budget change alone, as `previewActivation` already promised; a
  preview at the live window used to settle a converging budget change.
  `ActivationRequestOptions` gains `dryRun`.
- With context-manager 0.14.1, a dry run leaves what a select leaves behind as
  the last committing compile left it: no chunk record, no calibration, and
  none of the bookkeeping the next compile or an observer reads. The one thing
  it can still leave is the release of a compression hold whose deadline has
  passed, as any compile does.
- Under the autobiographical strategy, a dry run still refuses a budget the
  context can't fit, as a committing compile does: context-manager skips only
  its post-pick check, and an adaptive fold plan that doesn't fit then
  overruns at the middle's emission, with a refusal that names the tokens and
  the limit. So at such a budget a preview, `message.list` and the API's agent
  context command still fail, and a fork whose template's fold plan doesn't
  fit the default budget its seed is compiled at still fails to spawn.
  Windowed passthrough, though, skips its refusal of a newest message larger
  than the budget on a dry run: where they failed on such a message, a
  preview, `message.list` and the agent context command now return it alone,
  larger than the budget, and a fork is seeded with it. Passthrough, the
  default strategy, keeps the newest messages that fit, as before.
- A conversation fork's seed no longer copies the template's `thinking` and
  `redacted_thinking` blocks, and leaves out a message with no content left.
  A fork inherits the template's conversation, not its reasoning. A signed
  block was minted under the template's prefix, which the fork's system
  prompt, tools and scoped injections don't promise to match, so on an
  account that enforces thinking binding the fork's first request could be
  refused (inferred from probes of other requests, not observed on a fork).
  Unsigned reasoning, from text-only providers or XML mode, goes by the same
  rule. On models that don't bind thinking to its prefix (by probes, Fable 5
  and Sonnet 5), a copy would have been kept, so there the fork loses the
  template's reasoning. That a provider accepts the stripped seed rests on
  probes of two shapes, each sent without its thinking: an assistant text
  turn followed by a new user turn, on Sonnet 5.5, Fable 5.1, Fable 5 and
  Sonnet 5; and a tool round, a `tool_use` with no thinking before it and
  its result, continued by the model, on those four, Opus 5.5 and Haiku 5.5.
  Other thinking models weren't probed.
- On the OpenAI Responses path, the seed's items that were paired with a
  reasoning item it left out (the message's text, a function call) lose
  their provider-native raw item and render from their fields, so the fork
  replays no item id whose reasoning is gone. Opaque items, such as a
  compaction or a hosted tool's call, keep theirs.
- A fork's seed keeps no tool call whose result isn't in it, and no result
  whose call isn't (context-manager's `stripUnpairedToolBlocks`): the rest of
  their messages stays, and a message left with nothing becomes
  `[tool call omitted]`. A fork spawned while the template was between a
  tool round's call and its results (the coalescer can spawn one outside the
  event loop) gave the fork's first request an unanswered call under the
  passthrough strategies.
- A fork's spawn logs one line when its seed left something out:
  `[conversation] <fork>: seeded from <template> without N thinking
  block(s), N unanswered tool call(s) and N orphaned tool result(s)`.

## 0.22.1 — 2026-10-14

**Operators upgrading from 0.22.0:** a provider's stated `retry-after` now
holds a resident's or conversation agent's turns, recorded in the store and
kept across restarts, where 0.22.0 slept it inside the turn and `stop()`
couldn't end the sleep. A hold longer than an hour raises a `provider-wait`
ops alert, and the `release-provider-wait` host command lifts one. An
ephemeral run, such as a subagent's, still sleeps a stated wait of up to ten
minutes, and a longer one ends the run at once, telling its caller why. If
the recorded waits can't be read, no resident's or conversation agent's
provider call goes out until they read again (every 30 s), or until an
operator releases that agent's waits with `release-provider-wait` for the
life of the process; a `provider-wait` alert for agent `framework` says so.
A misspelled model's 404 no longer sheds the agent's newest exchanges.
Discord reaction suppression's default now also covers the awareness emoji
(💤 unless configured otherwise) and retained recovery emoji; a host that
injects the old refusal-only default should remove it. Going back to 0.22.0
is safe. It opens a store 0.22.1 wrote and ignores the recorded waits, so a
long `retry-after` is slept inside the turn again, and a wait recorded before
going back binds again if you return before it passes. Not tested: going back
while the recorded waits can't be read, going back after an operator released
a wait under 0.22.1, and going back under connectome-host rather than a bare
framework.

### Added

- `McplServerConnection`'s `'close'` event now carries a third argument,
  `McplConnectionCloseInfo` (`transport`, `code`, `signal`, `reason`,
  `byHost`), so a host can see the WebSocket close code a networked MCPL
  server sent (e.g. 4001 for an expired or refused credential) and refresh
  what `accessProvider` hands the next dial instead of replaying it. The
  first two `(code, signal)` arguments are unchanged; host-initiated closes
  now pass `(null, null, info)` where they passed nothing. The type is
  exported from the package root alongside `McplServerConnection`.

### Fixed

- Discord reaction suppression defaults include refusal markers, default/configured awareness markers, and retained recovery-outbox emojis. `framework.getPlacedReactionBaseline()` exposes that snapshot as suppression tokens, converting composite custom-emote markers to stable IDs; stored markers and reaction payloads remain unchanged. Stdio MCPL children get it by default, derived at each spawn (first connect, automatic reconnect, restart). Suppression is by emoji, so members' own reactions with 💤, the configured awareness emoji or a retained recovery emoji stop reaching the agent too, as members' 🛑 already did. When the awareness ledger can't be read, a runtime connect refuses before it registers or spawns anything (a startup connect, before it spawns), any restart refuses before it stops the running child, and an automatic reconnect of a child taking the default fails and retries rather than spawn without it. Explicit server env and intentionally inherited baseline values with tokens retain precedence, and the framework logs when one replaces the default; a value with no tokens, as discord-mcpl's parser reads them (blank, commas alone, or only tokens its normalizer reduces to nothing, such as `:`, `::` or a lone U+FE0F), or a null counts as unset, since the adapter would read it as suppression off (its filters file and legacy operator env are where suppression is turned off), and any other non-string value (a number from a JSON config) is read as its string form, as the child sees it, rather than failing the connect. On Windows, duplicate spellings resolve to the first in sorted order within each source, then declared values take precedence over inherited values. Hosts that inject the old refusal-only default must remove that default to adopt the framework-derived one; remote WebSocket adapters still need their own environment configuration (#95).

- The inference-failure pipeline bounds the failure text it records. A failure's text is its source's `Error.message`, and a provider can echo the whole rejected request there: in one household an OpenAI-compatible 400 echoed ~1.7 MB, and the framework stored it in the resident's own context as an `[inference-failed]` marker (about 200K tokens, by the household's notes, which the resident then carried), wrote it to stderr and `logs/failures.log`, and traced it.
  - Every cut this change makes follows one rule: the text's head and tail around a marker stating how many of how many characters were omitted. Each sink cuts the whole text, so its marker states the whole length, and no cut separates a surrogate pair.
  - The `[inference-failed]` marker carries an excerpt of at most 600 characters. It also names the classification when there is one ("the model call failed (invalid_request, HTTP 400) …"). Its metadata adds `errorType`, `retryable`, `httpStatus` and `providerErrorCode`, plus `reasonChars` whenever the marker's excerpt was cut. A small unclassified failure produces exactly the marker it did before. Markers already stored keep their size until they're folded or removed.
  - The rewind marker's reason is cut to 160 characters, an agent's `lastInference.lastError` and the compile-refused ops alert's to 300, and the ops webhook's copy of the alert's message to 500. Each bound includes the marker.
  - Each of these is bounded to 2,000 characters:
    - the reason excerpt in the exhaustion stderr line (the line also carries the agent, the streak and `type=… status=… code=…` labels when known);
    - every field of a `logs/failures.log` record: a string to 2,000 characters, an `Error` as its projection (below), and any other value as its JSON, with any `Error` inside it written as its projection, kept as data when it fits and as bounded text when it doesn't. A record with a value JSON throws on, such as one with a cycle, is no longer lost: that value is described as a thrown value is (below). A value JSON writes nothing for, such as a function, is left out, as JSON leaves it out;
    - ops alert messages, and an alert's `data` on its `ops:alert` trace, bounded field by field as a failures.log record is, so a trace listener gets the plain data the log writes: a `Date` as its ISO string, a `Map` as `{}`, an `Error` as its projection. Data that isn't a plain object, such as a string or an array from a JavaScript caller, is kept as one field, `data`, rather than spread into a field per character or element, and a message that isn't a string is described as a thrown value is (below) rather than thrown on;
    - the inference log's `error`;
    - every trace event's `error` and `stack` strings;
    - the provider cooldown's reason, in its stderr lines and the status snapshot's `cooldownReason`;
    - the error an ephemeral run (`runEphemeralToCompletion`) rejects with.

    `inference:exhausted` traces and failures.log records add `httpStatus` and `providerErrorCode`, and a failures.log record adds `reasonChars` when its own excerpt was cut. The error type and the provider code are recorded to at most 128 characters each.
  - The OverBudget drain kick, the marker write and the provider-cooldown resume used to print the error object when they failed, as did a host's `providerHold` hook when it threw (the hook is handed the model's error, and can throw it back). They now print a bounded projection instead: name, classification, status, provider code and message, cut once to 2,000 characters as one text after the name, type and provider code are bounded, on one line unless one of its parts has newlines, as a message can. A thrown value that isn't an `Error` is printed as its `String` when that's text of its own, as for a `Buffer`, an `Error` from another realm or a class with its own `toString`. An array, or an object whose `String` is empty or only its tag, such as `[object Object]`, is printed as its JSON, bounded, with any `Error` inside it as its projection, so a thrown plain object keeps its fields and an array its elements; the tag stands when JSON can't write the value or finds no fields in an object. Context maintenance describes one the same way, and its alert's copies, the webhook's included, are cut once from the whole message. The stack's frames follow on the lines below, also bounded to 2,000 characters: from after the message when the message is the stack's header, and otherwise from the stack's first frame line. Printing a `MembraneError` printed its message whole, in the stack, and its `rawRequest` with each string up to Node's 10,000-character limit, a long system prompt among them. Context maintenance records and logs a bounded message, in its existing format.
  - The OverBudget drain breaker's message-text fallback now applies only to unclassified failures, and it is decided on the whole reason, never the excerpt. A classified provider error that quotes "exceed hard budget" or "no summary covers" (the agent's own context, echoed back) no longer kicks the compression drain.
- This bound doesn't depend on membrane bounding its own errors.
- A `MembraneError` from another copy of membrane is recognised by its name as well as by its class, since the host supplies the `Membrane` instance and two copies can be installed. Its failure is classified, and so gets the framework's recovery for its class: an invalid request now sheds the newest exchanges of the agent's history, up to the rewind cap, as the poisoned-history quarantine does for the framework's own copy. The default error policy reads its `retryable` and `retryAfterMs`, and an organization acceleration limit it reports is held, as for the framework's own copy. Before, each treated it as an unknown error: the default policy retried a non-retryable one up to three times, and its failure was then left unclassified.
- Not covered by this change: an `Error` from another realm (a `vm` context) nested inside a value, which fails `instanceof Error` and so is written as its own JSON rather than its projection (at the top level, a thrown one is printed as its `String`); Discord-awareness log sites, the speech-route failure reason and `[discord-send-failed]` marker (kept whole as the delivery evidence a resident reads before resending), logs outside the inference-failure pipeline that still print an error object, in modules and in the framework's own code (among them the `beforeInference` hook's catch and its preview's, the event loop's catch, periodic and final sync, and the maintenance pass's retry of the tool-result guard's storage), and two plain slices: the health report's 400 characters of the inference log's stored error (already bounded to 2,000), and the tool-result spill's 200 characters of a workspace write's failure.

- A provider's stated `retry-after` is now a lower bound on the next call to that model, for that agent, across restarts and branch switches. When a classified error carries `retryAfterMs` as a number, the framework records a provider wait for (agent, model) and calls that model no earlier. That includes an error from another copy of membrane than the framework's own, since the host supplies the Membrane instance:
  - **Primary turns** are held, not retried and not counted as failures: no `[inference-failed]` marker and no hard-down streak. Wakes that arrive meanwhile join the held turn, and one fresh compile runs when the wait ends, the way an organization-acceleration cooldown already works. This applies to a failure the provider says may be retried; a non-retryable failure that states a wait keeps its terminal disposition (its marker and failure count), and the wait binds the calls after it.
  - **Admission is checked at the last boundary before a primary call**, so a wait recorded after a wake was scheduled (by an auxiliary call the wake parked behind) holds that wake too.
  - **Auxiliary calls** (context-manager compression through provider admission) to a held model are refused without calling the provider. The refusal is a retryable `rate_limit` `MembraneError` carrying the remaining wait as `retryAfterMs` (none for a wait held until released), marked `providerAdmission: 'deferred'` so a pacing caller can keep the wait without counting a failed call. context-manager reads that marker from its corrective round (#138) on. context-manager 0.14.0, the version this release requires, doesn't read it yet: it rethrows the refusal as it does any retryable error, and its next attempt meets the same admission, still without a call to the provider. A different model is not held: a compression model the provider did not limit keeps working, and changing an agent's primary model lets its turns proceed while the old model's wait stays recorded.
  - **Durability:** waits are kept in typed Chronicle records (RecordJournal), so a restart honours them and a rollback or branch switch does not rewind them. A wait or release whose record could not be written still binds in this process, and is offered to the record again, in order, at every later act (and from admission checks every 30 s); an ambiguous write is reconciled before anything is decided against the record. If the store's append itself throws, the record journal writes nothing more until the store is reopened, as at the next start, and that is logged once. The record that append was writing may still be in the store's log, where the next start loads it. Every later act holds in this process only, and a restart doesn't keep it.
  - **Unreadable records fail closed:** if the recorded waits cannot be read at startup, or a record parses but is not a well-formed provider wait, their absence is unknown, so no provider call is admitted for any resident or conversation agent until they can be read (retried every 30 s; held turns resume by themselves once they can) or an operator releases an agent's waits. An ephemeral run records no waits, so none can be unknown for it, and it isn't held. The hold names its cause in the log and in `providerWaits` (model `*`, which stands for every model), and inspection is unaffected. Such a release lifts exactly what it names (that model, or every model when none is given or it names `*`) for this process only, and a restart that still cannot read the records holds again. As the hold begins it raises a `provider-wait` ops alert for the whole framework (agent `framework`, model `*`), once per episode, since a cause that persists, such as a record this reader does not know, never reads again.
  - **No shortening:**
    - A later, shorter wait never shortens an outstanding longer one.
    - A wait that cannot be represented as an instant becomes an indefinite wait, held until released.
    - A negative stated wait (a provider's "retry now", or an HTTP date already past) is already over: it binds nothing, the same as 0. An organization-acceleration hold reads it as a stated 0 too (the 1 s floor, plus jitter).
    - The organization-acceleration cooldown no longer caps a stated wait at 10 minutes. The cap still applies to the framework's own default wait.
  - **Visibility:** `healthSnapshot().agents[].providerAdmission.providerWaits` lists the waits that bind now. Each wait, hold and release is logged once (`[provider-wait] …`). A wait's reason is the provider's message, bounded, with its control characters as spaces. A wait recorded to hold a model for more than an hour, or until released, also raises a `provider-wait` ops alert (a failures.log record, an `ops:alert` trace, and the ops webhook when configured), so a person can decide whether the provider meant it; it is honoured in full either way.
  - **Operator override:** the `release-provider-wait` host command (`agentName`, optional `model`) and the `host.releaseProviderWait` API verb release a wait, and the release is recorded so a restart does not restore it. The API verb takes the server's `adminToken` when one is configured, as the other host verbs that change something do. A `model` that is not a nonempty string, or that holds a control character, is refused, never taken as every model. A release names its agent on both surfaces. An `agentName` that is neither one of the framework's agents nor the agent of a wait `host.providerWaits` lists (a disposed conversation agent's, say) is refused before anything is recorded, `*` and `framework` included: the hold for unreadable records is lifted one agent at a time. The release records who asked. Over the API that's `api`, or `api:<requester>` for a requester the caller names. Any requester is bounded, and its control characters become spaces. An organization-acceleration cooldown that the released wait lengthened falls back to the framework's own pacing for that failure; a host hold (`providerHold`) stays the host's. Each released wait's receipt says how far the release reaches: `recorded`, `pending` (binding here, its record not yet written), or `in-process override` (the unreadable-records hold). A context strategy that paces its own calls by the same wait and has `releaseCompressionPause` (context-manager's compression lane from its corrective round, #138, on; 0.14.0 has none, so nothing is called) is released with it, for the model the release names, even when no wait binds in the framework itself (the lane may still hold a pause the framework no longer has); the receipt lists only the framework's own waits. `host.providerWaits` lists the waits. Only the passing of the wait, or this explicit release, ends one, and an ordinary restart does not; the hold for unreadable records also ends once they read again.
  - **Scope:** the guarantee covers the calls the framework makes for an agent: primary turns and auxiliary calls through provider admission. It covers the calls themselves, not membrane's retries inside one: membrane 0.5.87, the version this release requires, retries a rate-limited `complete()` call up to four times before throwing. Each retry waits the longer of its own backoff (1, 2, 4, then 8 s) and the stated wait, but no longer than `maxRetryDelayMs` (30 s by default), so a stated wait longer than that is retried inside, and an auxiliary call can reach the provider again inside the wait before the framework records it. membrane #102 stops that for a wait longer than its retry window; until a release carries it, a host's `hooks.onError` returning `'abort'` stops it. Primary turns go through `streamYielding()`, which has no retry loop. A wait binds the agent the provider answered. Another agent on the same model isn't held by it, and records its own wait from its own first refusal. Traffic a provider adapter makes on its own, such as membrane's Anthropic cache keepalive, is outside it. So is server-initiated inference through the MCPL inference router, which runs for an MCPL server rather than for an agent, so no agent's wait applies to it.
- Error-policy retry waits no longer fire almost at once when a delay exceeds what one timer holds (about 24.8 days). They wait in steps, and `stop()` ends a wait in progress.

- Live `rollbackToMessage` and `suppressMessages` (and message-granular
  `host/command` undo, which rides on rollback) return once the body change
  has landed, with a marker-scheduling receipt, instead of after every
  awareness reaction (💤 by default) has been delivered. Previously the store
  stayed reserved, and the operator got no answer, for the whole serial
  drain. At the reported pace of about one reaction per second, 918 queued
  marks would take roughly 15 minutes; the household's client timed out
  after 60 seconds. Delivery now continues in the background, behind the
  same MCPL data-plane gate as before, which holds channel traffic that
  arrives after it until the marks are attempted, or deferred when their
  server isn't connected. A turn may now run during delivery when it carries
  no channel traffic, such as a scheduler timer or a provider admission, and
  also when its channel traffic was admitted before the gate went up (queued
  when the surgery began, or arriving during its switch or fork). Such a
  turn used to wait for the whole drain, since the store stayed reserved;
  now it can answer before the marks show.
- The other branch moves no longer wait for Discord either: the web API's
  `branch.switch`, `undo` and `redo`, and `host/command` turn undo, return
  once the branch has moved, and their marks follow behind the same gate.
  Each starts its delivery through
  `startDiscordAwarenessDelivery(after, agentName?)`, a new public method
  that a host can call after its own branch moves. A delivery that fails to
  start raises a `discord-awareness-delivery` ops alert instead of failing
  the command, and the next sync, reconnect or start delivers what is still
  pending. (The web switch used to await the awareness sync before
  answering.)
- A gate installed while a drain is still running (restoring the source
  branch mid-delivery, say) waits for that drain and then drains again from
  the ledger. So before traffic is released, every mark pending when the
  gate was armed is attempted, or deferred until its server is connected,
  as before: the drain's remaining reactions, the removals they need, and an
  add re-pended during the drain (a rollback, its undo, then a redo).
  Inbound MCPL handlers wait out a generation installed while they wait, not
  only the one they first saw, and a reconnect's gate opens only once both
  its drain and the server's re-registration attempt have settled. So a
  reconnect's `mcpl:server-reconnected` and `module:added` traces now come
  once that attempt has settled, granted or not, where they came at once
  when no marks were pending.
- The result's new `markers` field (`none` | `queued` | `not-scheduled` |
  `unresolved`, the exported `SurgeryMarkerReceipt` type) says whether marks
  were scheduled, never that Discord accepted them. The `[operator]` stderr
  line gains `marks=…` and the operator-actions log entry gains `markers`.
  If the ledger write after the switch fails, the rollback that already
  applied is no longer reported as failed: the batch is retired
  (`not-scheduled`, with a `discord-awareness-not-scheduled` ops alert), or,
  if even that write fails, the result says the batch may still be
  delivered (`unresolved`, with a `discord-awareness-unresolved` ops alert). A
  suppression whose redactions all committed is no longer undone by that
  failure.

- A result of the workspace's `materialize`, `sync` or `delete` that the
  tool-result guard withholds now keeps what it acted on in its stub, after
  where the original is ("Kept from its result: {…}"): what `materialize`
  removed from disk and wrote to it, any root `sync` accepted and what it took
  from disk, gave up or holds as a conflict, per mount, and the path `delete`
  removed (a `delete` that failed keeps nothing, as any failed result). The
  result as stored still goes where every withheld original goes. Past the
  inline cap the kept fields are cut in that order, so a later list can be
  cut away entirely, and the stub says so. While the store is away from the
  batch's branch, the stub stays the bare notice, without the kept fields, as
  every withheld stub does then. A tool marks which fields of its result's
  data are kept with the new `ToolResult.keepWhenWithheld`; only these three
  mark any. Before this, a withheld receipt hid even which files a write had
  touched, such as the clobbered `LOG.md` in agent-framework #277.

- A module's event that arrives after `stop()` began is dropped with a log line naming the module, through `ModuleContext.pushEvent()` or the deprecated `queue` handle alike, instead of throwing `Queue is closed`. `stop()` closes the event queue before it stops modules, so such an event comes from a listener that fires while `stop()` runs, where the throw can go unhandled, or from the module's own `stop()`, where it made the framework's `stop()` fail. A direct caller of `AgentFramework.pushEvent()` still gets the throw for anything but a tool result, and a module's tool result keeps that method's drop line, which names the call, the tool and its outcome. The deprecated `ModuleContext.queue` is now an object with `push` alone, as its `ProcessQueue` type always said; it was the framework's own queue object.

- The poison-history breaker sheds history only for an `invalid_request` that came back as HTTP 400, 413 or 422 or that carries no status, and for a `context_length` at 413. The status is a heuristic for when shedding the newest exchange may help, not proof that the history is at fault. 400 and 422 are how a provider answers a request that fails its validation, as a history it can't accept does. A 413 is the request's size: when the newest exchange made it too large, as an oversized attachment does, shedding that exchange may recover, and nothing else in the framework does; when the history as a whole is too large, the shed doesn't help, and the breaker stops at its rewind cap. The 413 arm takes both labels a 413 arrives under, `invalid_request` and `context_length`, since membrane's label for a 413 differs by version and adapter. Other statuses keep the history, since shed history can't be got back and the status gives no sign that a shed would help: a 404 is a model or an endpoint that doesn't exist, and 405, 409, 410 and 415 are about the HTTP request or the resource, as a rule, rather than the conversation. The failure is still counted, logged and reported hard-down either way.
  - With membrane 0.5.87, which this release requires, one status table serves every adapter. A 404, such as a misspelled model's, arrives as `invalid_request`. Under 0.22.0, three of them shed the agent's newest exchanges, under a rewind marker saying "the model API kept rejecting the conversation on them"; 0.22.1 keeps the history. A 405, 409, 410 or 415 arrives as `invalid_request` too and is kept the same way. A 413 arrives as `context_length` and still sheds, so the breaker also sheds for an Anthropic 413, which no earlier release did. A `context_length` at 400 or 422 is a token overflow and keeps the history. A 422 from an OpenAI-compatible server that answers a validation failure with it, such as a FastAPI one, arrives as `invalid_request` and still sheds.
  - An error with no status, from a membrane that reports none, keeps the breaker's earlier rule, the type alone.
  - Account refusals, such as Anthropic's "credit balance is too low" and usage-limit 400s, arrive as `auth` and never shed.
  - The rewind marker the breaker writes into the agent's context says the turns were set aside because the model API kept refusing the requests that carried them, so that the conversation could go on. It used to say the API kept rejecting the conversation on them.

- A provider's stated `retry-after` on a turn that doesn't own provider admission, a conversation agent's or an ephemeral run's, is no longer slept in the turn for as long as it says. Such a turn went to the error policy, which returns a stated wait as it is: a 429 stating two hours held the turn asleep two hours per attempt, up to three times, with nothing recorded and nothing raised.
  - **Conversation agents** treat a stated wait as a resident does. The wait is recorded for (agent, model) and raises the `provider-wait` ops alert past an hour. The turn is held until the wait passes or `release-provider-wait` releases it, and one fresh compile runs then. A non-retryable failure that states a wait keeps its terminal disposition, and the wait binds the calls after it. This applies however the call fails, including a stream that throws.
    - Its retries and in-turn restarts check its recorded waits at the last boundary before the call, as a resident's turns do. It takes no provider gate, so its own compression can record a wait while a turn compiles: each of its turns checks again once compiled, and a wait found then holds the turn before anything is sent.
    - Its context manager's compression calls to a held model are refused without a call, and a compression call's own stated wait is recorded for it. A conversation agent still takes no provider gate: admission stays the resident's.
  - **Ephemeral runs** sleep a stated wait of up to 10 minutes, the framework's own longest pacing, and retry, as before. A longer stated wait, or one that can't be represented, ends the run at once. It is never retried before the provider's time, and the run's error says why: `… (the provider asked to wait 7200 s; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now)`. Nothing is recorded for an ephemeral run, whose name is single-use.

- MCPL references (RFC-005): display labels now drop the Arabic letter mark (U+061C) along with the other bidi controls, and are trimmed. `fetch_reference` shows the response's `Content-Type` and the server's claimed type as labels too, and `save_recent_image` shows a reference's claimed type in its refusal, and an attachment's media type in its receipt, as labels. The stub leaves out a label with nothing left once sanitized. A server's type such as `constructor` now saves the file as `.bin` instead of naming it with inherited function text.
- An `expiresAt` rejected as a field (past its 64-character maximum, or not a string, null included) now fails closed like an unparseable one on the fetcher's paths: `fetch_reference`, the eager default and a code-execution script's result. The fetcher treats such a reference as already expired, never as immortal, and doesn't fetch it. It still serves a copy saved earlier while the host holds the reference's record. A restart or an eviction drops the record, and a reference sent again is then judged on its expiry. A uri-form image block that a converter hands the provider as a URL source is unchanged.
- A reference that has already expired when it arrives gets a stub giving the case (an expiry that has passed, one that doesn't parse, or one rejected as a field) instead of offering `fetch_reference`. `save_recent_image`'s refusal of an expired reference, and the fetcher's refusal, give the same reasons. For a reference this process holds no record of (after a restart or an eviction, or a stub quoted from elsewhere), `save_recent_image`'s refusal says it can't be fetched, and to re-run its tool if the tool can produce it again. The eager default no longer gives one of a result's eight slots to an expired reference, to a uri that any of the result's blocks calls expired, or to a second block for a uri the result already listed.
- The reference registry, past its 2000 records, now evicts the reference registered least recently, where it evicted the one registered first. Registering a reference it holds, as showing its stub does, makes that reference the newest, since the one the model was just shown is the likeliest to be fetched. A result with at most 2000 distinct references therefore no longer evicts a reference it has just named.

- Unsubscribing a trace listener while an event is being delivered (through `onTrace`'s returned function or `offTrace`) no longer makes the next listener miss that event. Each event goes to the subscriptions present when its delivery starts, each one only if it is still subscribed when its turn comes, as the DOM's `EventTarget` delivers: a subscription made during delivery is first called for the next event, and a subscription removed during delivery is skipped if its turn hasn't come. Each `onTrace` call is a subscription of its own, so a listener subscribed twice is still called twice. The function `onTrace` returns now removes its own subscription, so calling it twice no longer removes a second subscription of the same listener.

- Workspace `sync` says what it didn't look at (#276). A sync now counts,
  under `passedOver`, what each mount's scan skipped by design and reported
  nowhere else, by reason. Today that's the entries its ignore list covers
  that hold nothing the workspace tracks; an ignored directory counts once,
  and one that hides a tracked path is listed under `incomplete` instead. A
  walk cut short, by the file cap or a directory that changed while it was
  listed, is listed under `incomplete`, and counts only what it kept. So a
  `totalSynced` of 0, with a `totalConflicts` of 0 and nothing under
  `passedOver`, `incomplete` or `skipped`, means the sync looked everywhere
  and nothing had changed; changed files it couldn't take in are listed
  under `skipped`. A path the ignore list covers is synced when named, and
  the result lists it under `ignored`: a sync without a path passes over it,
  so nothing else keeps it current. Naming an ignored directory sets aside
  the patterns that cover it or a directory above it; a pattern that covers
  only something inside it still applies, so with `build/**` and `*.md`,
  naming `build` takes `build/out.txt` and passes over `build/LOG.md`. A
  symlink the ignore list doesn't cover isn't counted: the pass reports each
  one by path, taken through the link when it's a file on a mount that
  follows symlinks, and otherwise listed under `skipped`. One the ignore list
  covers is passed over like any ignored entry.

## 0.22.0 — 2026-10-13

### Breaking

- **Workspace tool-output consumers:** `glob` returns `matches` as objects,
  `{ path, state, size?, mimeType?, conflict?, note? }`, instead of path strings. `sync` reports
  `conflicts` as `{ path, kind, diskCopy }`. `sync` without a path no longer replaces a workspace
  draft with a differing disk copy: the draft stays, and where disk changed too, the path is a
  conflict until a `sync` of that path or a forced `materialize` resolves it, or the two converge.
  For an `unknown-provenance` or `store-origin-collision` conflict, the forced `materialize` must
  name the path: one without a path leaves it. `ls`, `grep` and `sync` otherwise only add fields
  (each `ls` file entry's `state`; grep's `state`, `version`, `skipped` and `incomplete`; a path
  sync's `discarded`).
- **Hosts and module authors reading workspace internals:** `MountState` no longer has
  `materializedHashes` or `refusedPaths`. Disk-agreement evidence lives in `workspace/disk-agreement`
  chronicle records, and branch-local intent in each mount's `workspace/<mount>/intent` tree state.
  The module's saved state carries neither field, so a build from #169's branch started on a
  store this release wrote begins with no freshness baselines.
- **Prompt cache:** the descriptions of the workspace's `ls`, `glob`, `grep`, `sync`,
  `materialize` and `delete` tools change, and `sync` and `materialize` take new parameters, so
  the first request after the upgrade that carries those tools' definitions misses the cache from
  its tool block on.

### Added

- Tool-name patterns that match no tool are reported. This covers
  `toolClassOverrides` keys and `toolLifecycle.observe.tools` /
  `toolLifecycle.inputs.tools`. Each pattern is reported once, as a console
  line and an `mcpl:tool-pattern-unmatched` trace. A pattern written against
  the bare server id gets the `mcpl--<serverId>--…` form suggested, since
  that is the default tool prefix. A pattern that could name a server's tools
  waits until that server has listed them.
- Two disablements that were only console lines are now also traces.
  `mcpl:feature-set-disabled` covers a feature set that §6.4 derivation turns
  off, for example one that declares no `uses` while `enabledFeatureSets`
  lists it. `mcpl:policy-refused` covers a server refusing the host's policy,
  with its `fallback`.
- README documents MCPL tool naming (`<toolPrefix>--<tool>`, default prefix
  `mcpl--<serverId>`) and how `enabledFeatureSets` behaves. The `toolPrefix`
  doc comment now shows the real `--` separator.

- **`Module.onToolBatchComplete(agentName)`**: called once an agent's tool batch completes,
  when the round's last pending result arrives and before it is provided. It therefore runs
  before anything that continues the turn: re-inference, stream resume or the end of the turn.
  The framework awaits every module's hook in parallel, each bounded at 30 s and fail-open; a
  hook that throws (before returning its promise or after) or times out is traced as
  `module:batch_hook_failed` and the round goes on.
  The agent's state is checked again afterwards, so a result whose turn was cancelled or
  replaced during the hook is dropped (traced as `tool:result_dropped`). A hook still running
  from an earlier batch, past its bound, is skipped rather than called again. The hook is
  awaited in the framework's event loop, so a slow one holds every agent's event processing,
  not only the batch's agent. Script-inner tool calls don't trigger it, nor does a batch whose
  error results the framework fills in after its stream ended before its tools answered.
- Workspace: `materialize` accepts `applyDeletions`, `WorkspaceConfig` accepts
  `agentActionScanDeadlineMs` (default 20000, kept below the hook's 30 s bound), and
  `workspace:deleted` events carry `conflicts` when a disk deletion met a newer workspace edit.

- Add opt-in resident-editable tool descriptions and visibility, a source-grouped generated catalogue, and optional component description profiles. Hidden tools retain their existing execution permissions.
- Keep hidden definitions available to compression, protect catalogue path aliases and discovery instructions, and preserve shared override-file permissions during resident edits.

- Live requests capture advertised and compression definitions together before asynchronous context gathering, so mid-gather tool refreshes cannot split their snapshots. Settings edits preserve permissions through the open temporary-file descriptor and reject detected pathname replacement before committing.

### Changed

- **Per-channel conversation routing is deprecated** (`FrameworkConfig.conversations`,
  `ConversationRouter`, `ConversationRouterConfig`). Its `'mention'` bind/trigger
  rule, the default for channels, reads `metadata.mentioned`, which discord-mcpl
  never sets, so on Discord channels an @-mention neither binds a fork nor
  triggers a bound one (#235). Behavior is unchanged for now: routing still
  works, and the framework logs one `[deprecated]` line when it is created with
  `conversations` set. Removal is a follow-up. The `idleTtlMs` docs now note
  that expiry is checked at most about once a minute, so the sweep usually
  notices an expired binding up to ~60s after the TTL; that is not a deadline
  for closing the fork, whose closure turn can be delayed further (e.g. while
  the host is quiesced).

- Depends on `@animalabs/membrane` `^0.5.87` (was `^0.5.78`), the version this
  release is built and tested against. Membrane 0.5.87 classifies provider
  errors at the HTTP boundary and honours `retry-after`, defaults to native
  tool mode where the formatter supports it, and reports `pause_turn` as its
  own stop reason; see its changelog for the full list.

### Fixed

- A module's tool result that JSON can't hold, such as a cyclic object, a
  BigInt or a `toJSON` that throws, is now answered as an error result
  naming the tool wherever the framework stores or sends it: a model's
  call, a script's inner call, the `utils` meta-tool for a model,
  `read_image`, and the pair `puppetToolCall` stores. So is a result that
  isn't a result object (`undefined`, `null`, an array, a string, an `Error`
  returned rather than thrown), a result whose getters or Proxy traps throw
  while it's read, and a non-error result whose data is a function or a
  symbol, which JSON leaves out whole. The error keeps the module's own
  error text and its `endTurn` when they can be read. Before, the first
  code to store, send or trace such a result threw, and the agent's turn
  never settled (#309). Those paths now read a module's result once and use
  its JSON form, so its getters and `toJSON` never run a second time. A
  caller that uses the result in process (`ModuleContext.callTool`,
  `executeToolCall`) still gets the module's own result, and
  `puppetToolCall` still returns it, or the error result where it used to
  reject.
- A module's `error` is sent as text: an `Error`'s message, an object's own
  `message`, any other value's JSON, or a BigInt's or symbol's `String()`.
  One that says nothing (`null`, `false` or empty), and a throw with no
  text, read as "Unknown error", as a missing one does. A result's
  `success`, `isError` and `endTurn` are sent as booleans.
- A tool result with no data is stored as empty text, as an empty content
  array is. Before, storing it threw, and the turn never settled. A
  failure the tool doesn't flag as an error for the model
  (`{ success: false, error, isError: false }`) with no data reads as its
  error text, for the model and for a script.

- In explicit prose routing, when a round calls `skip_reply` itself (in
  native tool mode, and not from a `code_execution` script), the prose
  gateway no longer delivers or bounces that round's plain text.
  `skip_reply` promises that "Any plain text you wrote this turn stays
  private and is NOT posted". The round's segments used to go through the
  gateway like any other round's. Unprefixed text with no destination
  bounced: it went onto the clipboard for an `{{unsent}}` resend, got a
  bounce notice and could wake the resident again. Unprefixed text after a
  destination set earlier in the turn was published there. Now none of that
  round's envelopes is delivered or bounced, and none moves the destination
  or asks for a continuation. A `>>skip_reply {{unsent}}` in it still sets
  the retained text aside. A valid destination prefix, or a destination set
  earlier in the turn, can still send the round's text through the live
  outgoing stream as it is written.
- Explicit prose routing no longer streams unprefixed text to the trigger
  channel. The MCPL outgoing stream (`channels/outgoing/chunk` and
  `complete`) started with the trigger channel as its destination, so a
  streaming-capable server there received text that delivery would bounce.
  It now starts with no destination on a fresh turn, since explicit text has
  none until a `>>` prefix names one. When a tool-result-guard retry or a
  budget restart resumes the turn, it starts at the destination the turn's
  delivered rounds have set, decided at each round's end, so a private
  round's prefix doesn't count. The stream also reads a `>>` prefix after
  any leading whitespace, and ends its target at any whitespace, as delivery
  does, rather than streaming such a line as text or dropping it. The stream
  parses each round's text from the start of a line, as delivery parses each
  round on its own: a round that began with a `>>` prefix streamed it as
  text to the previous round's destination. A round's later text block
  starts a new line, as delivery joins a round's text blocks with a newline.
  At each round's end, and when the membrane retries a refused attempt, the
  stream returns to the turn's destination, so a private round's prefix, a
  `>>skip_reply` envelope or a target that didn't resolve no longer moves
  where later rounds stream.
- A turn resumed by a tool-result-guard retry or a budget restart now queues
  its prose deliveries behind the turn's earlier ones, in every mode, so the
  turn delivers in the order it wrote. Before, a resumed reply could be
  delivered ahead of an earlier round's queued envelope, to the destination
  that envelope was about to change. In explicit mode, a round's `>>`
  targets are resolved once, when the round ends, and its queued delivery
  posts to those channels.

- A debounced (batched) gate wake that contains an addressed message —
  mention, reply, or DM — now routes the turn's plain speech to that
  message's channel, the same rule the direct wake path already applies.
  Previously a batched wake carried no channel and fell back to the
  process-global most-recent-inbound channel, so ambient traffic elsewhere
  in the debounce window (or before a DM, which never updates that
  fallback) received the reply. Push events are mapped to their registered
  composite channel id via a new `EventGate` option `resolveRouteChannel`
  (the framework supplies it); batched-wake lines now show that id instead
  of the adapter's raw one. Ambient-only batches keep the legacy fallback.
- When a batch holds several addressed wakes, the newest addressed EVENT now
  decides the turn's channel, not the most recently queued request. A gate
  wake flushed after a busy turn no longer outranks a newer mention's direct
  wake. A conversation fork takes a batched wake's route only for its home
  channel, so a fork bound elsewhere shows no typing in the addressed
  channel. An addressed wake with no author no longer borrows another
  request's author for its turn telemetry.

- `code_execution` time limits now stop blocking code (`time.sleep()`, a busy
  loop, a blocking read) at the limit (#235). The deadline's cancel reached a
  script only at an `await`, so blocking code ran on until it returned (and
  read as a success) or was killed 10s later, losing its output and the
  interpreter's variables. The host now also sends the interpreter SIGINT,
  repeated until the script reports. In the script's own code the runtime
  raises it as `KeyboardInterrupt`; a script waiting on an `await` is
  cancelled straight away, without waiting for the cancel op. The result keeps the output so far, shows the line the
  script was stopped at, and says it reached its time limit, and variables
  survive. The kill remains for code that ignores the interrupt (a long call
  inside C code, code that swallows `KeyboardInterrupt`, blocking code in a
  task the script started), and its message now names the time limit and the
  lost variables. `PyRunner` takes `cancelGraceMs` for the time between the
  two. Windows keeps the previous behavior.

- A `code_execution` script no longer receives another script's tool result.
  Inner-call ids restart in every interpreter, and a result was delivered to
  whichever interpreter was current when it arrived: after a script was
  aborted, killed at its time limit, or crashed mid-call, the late result of
  its call could resolve the first call of the next script, which then went
  on with the wrong data. Results and wake acknowledgements now go only to
  the interpreter that asked; one whose interpreter is gone is dropped and
  logged.

- A tool call that ends the turn, made by a `code_execution` script that was
  stopped before the call finished, no longer ends the turn of the agent's
  next script. The deferred end-turn request was kept per agent; it now marks
  only the foreground script that made the call. Background scripts' requests
  no longer reach a foreground script running alongside them.

- A tool result the guard withholds now says where its original is. The
  guard's notice ("Tool result withheld by the guard. The tool has already
  executed.") is followed by the original's place: a workspace file under the
  first writable mount's `tool-results/` (named
  `<date>-withheld-<batch>-<index>-<toolUseId>`, one per result, with any
  character outside `A-Za-z0-9._-` replaced and the name cut to 80
  characters, so a long tool use id is cut), or, with no writable workspace
  or a failed write, the guard's audit record (`framework/tool-result-guard`),
  for an operator. The place holds the result as stored, which is its text:
  for a result over the inline cap, its capped text, whose own note names the
  file with the whole output. A failed write's own error stays in the audit
  record and the logs; the audit record also says when no file was written or
  a write threw. When saving the audit record itself
  had failed as the result arrived, the stub says so rather than that the
  original is kept there. This holds for every withheld settlement: a refusal,
  an aborted stream, a batch that was never submitted, and one whose audit sync
  failed. The notice still names no refusal and no category. Before this, a
  withheld result left only the notice, so the agent couldn't tell what the
  tool had done (agent-framework #277). The file is an ordinary workspace
  file: the agent can read it back deliberately, and so can whoever else reads
  the mount, such as another agent sharing it or a synced copy.
- How the stub is written. Where each original went is queued first, as an
  audit record of its own, and the stub's edit is then made at once. If it
  fails, it is retried before the next activation, compile of a request that
  is sent, maintenance pass or stop, including for an ephemeral run or a
  closed fork that has left the agent map, and the batch stays held out of
  summaries until it lands. Until then, or if the store keeps failing or the
  process stops first, the stub is the bare notice, and the `annotated` audit
  record describes the spill's outcome when the annotation finishes, with `unfinished` for a write still running. That record is not revised when the write later settles. A file whose copy on disk fails
  is still in the workspace's tree, where its tools read it, so the stub names
  it; for this, `WorkspaceModule.writeBinary`'s result for that case carries
  `data: { inChronicle: true }`, including when a post-commit operation throws. Inline truncation notes also name that readable tree file, and the disk-copy failure is logged and traced. Each batch has one 30-second deadline for all its withheld writes. A write still under way then is named as unfinished, with the audit record as the fallback. The guard stops waiting for it there; the write goes on, and may finish or fail later. `stop()` still waits for the workspace's own turns, which such a write holds, bounded only by a teardown timeout passed to `stop()` (indefinitely without one, as since #248). Until it
  settles, no other withheld original is written, for this batch or a later
  one of any agent: their stubs name the audit record. Writes can start before the first deadline fires; those batches each use their own deadline. A write that never settles keeps new withheld spills disabled for the process lifetime. A deadline that fires names its file on stderr; a stall's skips are logged once, naming the first file, and counted when it clears; an exhausted batch's skips are logged once per batch. The inline cap's spills are outside this deadline. Requests sent by the framework and the direct Agent API are compiled only once each annotation started so far has finished,
  including one that began while the compile waited or ran, and the refusal
  retry; a conversation fork seeded from its template copies only stubs whose
  annotation has finished. A request preview doesn't wait, so rollback,
  undo and redo never wait on a workspace write, and a preview can show a stub
  before its place is added, as can public `compileContext()`. Stop lets running annotations finish while the
  workspace is up; one that starts after that writes no file and is saved
  before the store closes. A crash before a stub is written leaves the notice
  alone, and the staged audit record still holds the original. If the active
  branch changes while the originals are being written, no more are written:
  a write that has not set its tree entry is refused where it commits, and it and the rest are recorded as skipped for the branch change. A write whose tree entry was already set remains on that branch. While the store is away the
  stub stays as it was; if the branch is back by the edit, those results'
  stubs name the audit record. So no original's tree entry lands on another
  branch. For this, `WorkspaceModule.writeBinary` takes an optional `branch`:
  the file's tree entry lands on that branch or isn't written, and a refused
  write's result carries `data: { branchLeft: true }` (it isn't traced as a
  failed spill). A mount has one directory on disk for every branch, so with
  `autoMaterialize` a file's copy there, made after its tree entry, is there
  whichever branch is active, like any other write's. The audit records `annotated`
  (where each original went) and `stub_updated` (the stub's edit) carry the
  batch's `sourceBranch`. The direct Agent API's refusal retry is now
  compiled afresh, as the framework's is, so its longer stubs fit the budget.

- With `maintenanceIntervalMs: 0`, periodic retries of retained guards are disabled; stop still retries them. A failing audit record blocks later queued edits and their compression holds until its write succeeds. Shutdown reports an error if that retry still fails.
- A framework-driven turn that compiled across stop is discarded before driving its stream, with a line saying why, even if the framework has restarted. A `start()` after a finished `stop()` starts a new lifecycle, with the spill gate open again; a `start()` made while a `stop()` is still draining isn't a supported order. Direct Agent calls remain governed by their caller's abort signal; a refusal retry checks that signal again after waiting for annotations. The direct API reads its unguarded tool results once, after the first compile, and sends the same ones with the refusal retry.
- Concurrent starts on one Agent, a direct inference call beside a framework-driven turn, are not made safe by this change: an Agent compiles while its status still reads idle, as before, and the annotation wait lengthens that window by up to the batch's deadline. `abortInference()` returns false during a direct call's initial assembly.
- `save_recent_image` reports a tree-only write as saved, including its path, size, MIME type, `inChronicle` and `diskCopyError` (the failure after the tree entry, whichever it was). A later failure in a multi-image save, returned or thrown, includes that file among the already-saved paths. An RFC-005 reference fetched to such a file names it.

- MCPL tool lifecycle (RFC-007) now reports the tool calls a `code_execution`
  script makes, not just the script's own `code_execution` call. Each is
  reported like a model call, under the inner tool's own name and class, so
  grants, narrowing, filters and the `comms`/unclassed input exclusions apply
  to it as they would to the model calling that tool directly. It carries the
  inference that issued the `code_execution` call and, in
  `_meta["agent-framework/parentToolCallId"]`, that call's `toolCallId`. A
  stream's end does not abort these calls: one still running when its script
  is killed is reported `completed` or `failed` when it finishes.
- Two `code_execution` calls in one model response no longer hang the turn.
  The runner now claims itself before it waits for the interpreter, so the
  second call is refused with "already running" and the first runs normally.
  Before, both got through: the second was refused by the interpreter, the
  first script's result was dropped, and its tool call never answered.

- **`materialize` no longer silently overwrites disk files changed by another writer** (#109). A file disk changed since it last agreed with the workspace is refused and listed in the result (`skipped`, with the remedy) instead of silently reverted. So is a disk copy that exists but can't be read (e.g. a write-only file), with the filesystem error in the reason, rather than treated as absent. `force: true` remains the deliberate override. A refused workspace edit stays owed: every later materialize takes it up again, and it counts in `status.pendingChanges`. A file the workspace hasn't changed, whose disk copy changed, isn't owed: a materialize naming it refuses it, and one without a path leaves it, for a `sync` of the path (take disk) or a `materialize` naming it with `force` (take the workspace). What disk last agreed with is kept as evidence that survives restarts and branch switches (see the truthful-listings entry), and a `sync` that takes a disk copy records that agreement, so the agent's next edit to that file isn't refused. A first materialize that finds every file already in place still pins the branch, and a file whose disk copy already matches the target bytes is left untouched (mtime preserved). The post-undo/redo `_config` restore keeps its overwrite semantics.

- Visibly-empty MCPL content no longer causes uncaused wakes (#235). Content with no non-text block and no non-whitespace text was stored and woke the agent, but the request sanitizer stripped it, so the model woke to `[Continue]` or to an older message re-presented as the newest. `push/event` now rejects such content with `-32602` (`data.field: "payload.content"`), and `channels/incoming` rejects the message with `reason: "empty_content"`; both log `reason=empty-content`. Exemptions: an RFC-006 retraction, which may be empty (an empty or blank-text notice appends nothing), and the exact silent-heartbeat marker (#216), now one shared predicate. Empty deferred fallbacks are rejected because a fallback must be self-contained. A blank-text render counts as "nothing happened", and a turn whose only causes were deferred batches that rendered nothing (empty, blank, cancelled or revoked) is not started. `PushCoalescer.assemble()` now reports which subjects settled and which materialized content. Rejections are typed `TraceEvent` members (`mcpl:push-event-rejected`, `mcpl:channel-incoming-rejected`). The store/wake site drops empty push and channel events from modules or the coalescer: no row, no wake, and an `mcpl:empty-content-dropped` trace.
  **MCPL server authors:** to wake the agent, send content it can see. An empty push from any server other than the exact silent-heartbeat marker now gets an error.

- Preserve unbounded module and MCPL shutdown by default and allow explicit wait budgets. Retain failed or pending cleanup for retry, run final storage repair and sync best-effort, and keep storage open until teardown succeeds. Reuse in-flight cleanup and make successful shutdown idempotent until a new borrowed-store lifecycle begins. Preserve final storage errors, including Chronicle close failures that consume the handle, and expose timeout diagnostics to hosts.

- Silent heartbeat ticks no longer merge into the previous assistant message
  on the wire. Every row a tick's turn stores (assistant responses,
  tool_result rows) now carries
  `metadata.silentHeartbeat: { eventId, serverId, agentName }`, and request
  builds render a request-only `[heartbeat tick]` user turn immediately
  before the first of the tick's rows that survives compilation (the agent's
  own opening request for a tick ends on that same turn instead of
  `[Continue]`). Nothing new is stored, and the separator's position follows
  from the stamped rows alone, so it is identical on every compile and keeps
  the cached prefix stable. Rows are recognised by tool_use ids and thinking
  signatures only: an unsigned, tool-free tick reply still merges as before
  (no signed thinking, so no provider rejection). Previously back-to-back
  ticks, or a tick after a reply that left no delivery receipt, were sent as
  one assistant message carrying signed thinking from two responses.

- **Late tool results, and MCPL requests and notifications, at `stop()` no
  longer end in an unhandled rejection.** `stop()` closes the process queue
  before it closes MCPL connections, and nothing caught the "Queue is
  closed" that this meant for late arrivals. Test files that stop a
  framework while a tool still runs, such as `conversation-routing`, failed
  at file level with it.
  - A tool's result that arrives after `stop()` is logged and dropped: the
    queue that would carry it to its stream is closed, and the tool has
    already run. Before, its push threw, the throw was reported as the
    tool's own failure, and that failure's push threw again, unhandled.
  - tune-out's results now go through the same `pushEvent` as every other
    tool's, so they also emit `process:received`, and a rejection of its
    handler is answered with a failed result, as other tools' dispatch
    failures are, instead of being left unhandled.
  - The drop's log line names the tool and whether it succeeded, which is
    what decides whether anything needs reconciling (the resident may run
    the tool again). For this, the framework's tool results carry the tool's
    name (`ToolResultEvent.toolName`, optional).
  - A server's `push/event`, `channels/incoming`, `channels/register`,
    `channels/changed`, `inference/request` or `host/command` that arrives
    once the host is stopping is refused before its handler runs, with a
    JSON-RPC error (`-32000`, "the host is stopping", the code the push
    coalescer already gives a stopping host). It is never answered
    "accepted", no inference starts, and no host command runs.
  - A handler that throws is answered with an error too: while the host
    stops, `-32000` with the handler's own message after "the host stopped
    while handling this request"; on a live host, `-32603` with its message.
    The message is bounded, and any thrown value is printed safely. Part of
    the request may already have been admitted. A notification is logged.
  - **For operators:** such a handler fault used to be an unhandled
    rejection, which ends a Node process by default, so a supervisor would
    have restarted the host. Now the host stays up and logs the failure.
  - A request is answered at most once. A second answer, such as a
    handler's late one after its failure was answered, is refused and
    logged. An answer that throws, such as a result the connection can't
    serialize, doesn't count, so the request still gets the error answer.
  - Any other event pushed to a stopped framework still throws to its
    caller.

- In explicit mode, a turn that a tool ends, such as with `skip_reply`, no
  longer leaves the prose it queued to run under the next turn's routing
  state. Such a turn settles before its earlier rounds' queued deliveries
  have posted, and in explicit mode the next turn can start at once. That
  start cleared the sticky destination those deliveries read when they
  post, so a queued unprefixed segment bounced into the next turn. Each
  turn now has its own routing state (the sticky destination, the turn's
  destination, hybrid's hold) and its logical turn's ` !` continuation and
  receipt tallies (the destinations and suppressed segments its receipt
  reports), and a queued delivery keeps the one of the turn that queued
  it. In hybrid and
  locus mode the ended turn already keeps the next one waiting until its
  receipt is written, as before.
- The agent's prose deliveries go out in the order they were written,
  across turns: every stream queues its deliveries behind the agent's
  earlier ones, a fresh turn's included (apart from a stream that a later
  one replaced). A turn's reply, and its completion, can therefore wait for
  an earlier turn's posts: up to their request timeouts, one after another,
  or for good when `requestTimeoutMs` is 0 and a post is never answered.
- In explicit and hybrid mode, a ` !` continuation that an earlier round
  asked for now starts when a tool ends the turn, once that turn's
  deliveries have run, unless the framework has stopped or the agent has
  been disposed by then (a dropped one is logged). In explicit mode a turn
  that another event started meanwhile runs first. Before, hybrid mode
  started it only after the next turn, and explicit mode dropped it, or,
  when its delivery ran late, started it after the next turn.
- A logical turn now stays open from the start that opens it until the turn
  settles (it completes, a tool ends it, or it fails or is abandoned), and
  every start that routes prose while it is open continues it: a framework
  retry, the start that consumes unstreamed tool results (whichever wake
  the scheduler starts it with), the later start a provider-capacity hold
  defers a turn to. Each begins the sticky destination and hybrid's hold
  afresh, as before, but a ` !` asked for earlier in the turn still stands,
  in explicit mode too, and in hybrid and locus mode the receipt at the
  turn's end reports every stream's deliveries, including ones that land
  after a new stream began. Before, explicit mode dropped that ` !`, and the
  receipt counted only the deliveries that landed after the new start.
- A turn that completes now waits for its queued deliveries before its
  receipt and its continuation check, in every mode, whatever its last
  response. Before, only a completion with final text waited, so in hybrid
  and locus mode a stream whose last response was empty (a budget
  restart's, say) wrote its receipt first: those deliveries were never
  receipted, or were counted in the next turn's receipt. A ` !` they carried
  was missed too.

- **Workspace listings tell the truth about disk, and no scan discards a workspace edit.** `ls`,
  `glob` and `grep` check their scope against disk before answering, under one rule over disk, the
  workspace store and what disk last agreed with. Files created by a shell show up, including
  binary and oversize ones, listed as `disk-only` with their size and, for images, their type.
  A file deleted by a shell leaves the workspace on every scan path (a watcher event, `sync`, a
  listing, the scan after a restart, and a watcher reattach) where the workspace held what disk
  last agreed with; a workspace edit of it stays, as a `deleted-on-disk` conflict. Each file entry
  carries a state:
  `synced`, `workspace-draft`, `workspace-deleted`, `not-in-branch`, `disk-only`, `conflict` (with
  its kind) or `disk-missing-provenance-unknown`. Where disk couldn't be checked, the state is
  `unverified`, and `incomplete` names the unreadable, ignored or capped regions. A pending
  workspace edit is never overwritten by a scan, a watcher event or a lazy read. When disk and
  the workspace both changed, the path becomes a conflict that stays until a `sync` of that path
  (take disk), a forced `materialize` (take the workspace) or convergence. A text disk version is
  kept in the store; a binary or oversize one is referenced, and the listing says if it changed
  since. `grep` labels a kept disk version `recorded-disk` once disk has changed since, and lists
  a conflict's disk side it couldn't search as skipped. A `sync` of a path lists under
  `discarded` each workspace change it gave up for disk's state.
- **A mount root that isn't the directory disk last agreed with is unavailable, not empty.** The
  workspace records the root's identity (its device and inode) with the first evidence it
  gathers there. When the drive under a read-write mount is unmounted, the watcher recreates its
  mountpoint as an empty directory; that root is listed as unavailable (`incomplete`, saying what
  to do), so no scan reads its emptiness as every file deleted, and no `materialize`, forced or
  not, writes into it. When the drive comes back at the same path, the mount is available again;
  one that comes back elsewhere leaves it unavailable until it is back at that path. If the
  directory was replaced on purpose, or a drive came back under a new device number, `sync` with
  `acceptRoot: true` takes the root as it is now: what was recorded about the old one is set
  aside, and every file is compared afresh.
- **A workspace deletion stays deleted, and materialize never deletes from disk unasked.** Without
  `autoMaterialize`, a deleted file's disk copy, unchanged since disk last agreed with the
  workspace, is listed as `workspace-deleted`, and no scan or lazy read brings that copy back; a
  copy changed on disk since is a conflict. `materialize` lists the deletions it left on disk;
  `applyDeletions: true` removes those whose disk copy is still one the workspace held, and
  `force` too removes those changed since. A `sync` of the path takes disk's copy back into the
  workspace when it's one the workspace can hold (text within the size limit). Once the deletion
  is confirmed on disk, a file that later appears at the path is a new file, adopted like any
  other.
  `autoMaterialize` writes and deletes follow materialize's freshness rule: a disk copy changed
  by another writer since it last agreed is refused, not overwritten or unlinked.
- **A `materialize` without a path takes up only what disk still owes:** workspace edits,
  entries never checked against disk, conflicts and workspace deletions. It no longer depends on
  the sequence the mount was last materialized at (`status.lastMaterializedSeq`), which is saved
  only at a clean stop: after a restart that lost it, a bare `materialize` took up the whole tree.
  A file the workspace hasn't changed is left as disk has it, with or without `force`, unless its
  path is given. A path the evidence says nothing about is treated the same way. Where disk holds
  a different copy (`unknown-provenance`, or `store-origin-collision` for a file the workspace
  created), only a `materialize` that names the path with `force` overwrites it. Where an entry
  from before the evidence has no disk copy, only one that names the path writes it, and a `sync`
  of the path drops it from the workspace instead. A bare `materialize` trusts the evidence: if
  disk was replaced behind the workspace, a `sync` takes disk's copies, and naming the paths with
  `force` writes the workspace's. `status.pendingChanges` counts what disk owes by the evidence;
  an entry never checked against disk isn't counted until a listing or a `materialize` checks it.
- **Undo and branch switches are not mistaken for disk edits.** What disk last agreed with is kept
  in global chronicle records rather than branch state, so selecting an earlier state keeps that
  state as a draft over the later disk version, and a file present only in another branch's
  history is listed `not-in-branch`, never ingested or unlinked. Each write or unlink a
  materialize makes, and each adoption that ingests a disk change or removes a file, is recorded
  as an intent ahead of it and completed once it is durable, so a crash or a torn record tail
  never costs an edit. If an append of disk-agreement evidence fails inside Chronicle, the
  workspace refuses operations that need that evidence and reports why. Those operations remain
  unavailable until the host restarts and reloads the store's records. The append may have
  reached the log without becoming readable in this process, so deciding a conflict from
  possibly incomplete evidence would be unsafe. A binary or oversize disk version, for which the workspace drops its copy,
  forgets the evidence first instead. After a crash, an interrupted write or unlink is decided by what disk shows (a copy
  matching neither the one before nor the one intended is an `interrupted` conflict), and one
  that shows on disk without proof it is durable is completed only by the next `materialize`,
  which redoes it; an interrupted adoption is settled by its own branch's tree. This replaces
  #109's stop-time baselines and refused paths,
  which an abrupt exit or a branch switch could lose or rewind. A store that saved them doesn't
  import them, since they name no root: its first pass records each file disk agrees with, and
  lists any other as a conflict or of unknown provenance.
- **`watch: 'on-agent-action'` works as documented:** after each completed tool batch, before
  anything continues the agent's turn, the mount is scanned. A scan that outlasts
  `agentActionScanDeadlineMs` stops holding the round and continues in the background; the miss
  is reported on `status` (`lastAgentActionScan`) and as a `workspace:agent-action-scan-incomplete`
  event, as are the regions a finished scan couldn't observe (`incomplete`). Batches that come
  while a scan waits share it, and while a scan that outlasted its deadline still runs, a later
  batch isn't held: its miss is recorded at once, and its scan comes after. The hold is in the
  framework's event loop, so while it lasts every agent's events wait.
- Disk text is stored as its raw bytes rather than through a UTF-8 round trip, so a file in
  another encoding no longer differs from its own stored copy.
- `status` with `mount` reports that mount alone, and refuses one that doesn't exist. A
  `materialize` that names a read-only mount lists it under `skipped`, rather than answering as
  if nothing was owed there.
- `materialize` and `autoMaterialize` check each write and unlink where it happens, not only when
  it is planned. A file is opened in its directory without truncating and located before any
  byte changes: never through a symlink the mount doesn't follow, or a directory that resolves
  outside the mount, and never into a file with other hard links, whose other names (a package
  store's, say) a write in place would change too, even with `force`. Unless `force`, it must
  also still hold what the materialize decided on, so a disk edit or a new file that appears
  meanwhile is refused, not overwritten. Refused paths are listed as skipped with the reason.
  Where the platform can sync a directory (not Windows, nor a filesystem that refuses it), every
  directory from a written file up to the mount root is synced before the write counts as done,
  directories it had to create included. Listings likewise accept a directory's contents only
  while it is still the directory at its path, and a scan, write or unlink accepts what it found
  only while the mount root is still the one it began under: a scan that finds the root replaced
  when it looks again treats what it observed as unverified, and reports the root. Each check is made where the operation happens,
  against what is there at that moment. Node has no `openat`, so a parent directory replaced
  concurrently in the window between a check and a create, `mkdir`, unlink or listing can still
  redirect that one operation: an empty file or directory can appear outside the mount, or a
  same-named file there can be unlinked. Nor can a write or an unlink be bound to the moment of
  its last check: an edit to the open file between the last look and the truncate can be
  overwritten, and a file put at the path, or an edit made to it, between the last look and the
  unlink can be removed. Content writes stay bound to the
  descriptor verified, inside the mount and with no other hard links, before modification; a
  hard link made to the file after that check shares the write.

## 0.21.1 — 2026-10-13

### Changed

- Depends on `@animalabs/context-manager` `^0.14.0` (was `^0.13.0`). Under
  `foldingStrategy: 'kv-unified'` the strategy no longer persists its
  presentation receipt as one entry per message on every accepted call: the
  receipt is stored run-length encoded, so a Chronicle `records.log` no longer
  grows quadratically with session length (context-manager#148). Stores written
  under 0.13.x still load. Patch release from the v0.21.0 tag with this
  dependency bump only; the work on `main` since 0.21.0 is not included.
  - **Operators of stores that learned an estimator calibration under
    context-manager 0.13 or earlier** (added after the release): 0.14.0 stamps
    its persisted calibration multiplier with the pricing it was learned under.
    An unstamped multiplier is kept and re-stamped, unless the store holds
    XML-history carriers, in which case it restarts from 1.0 and the value it
    discarded is kept as `reset.discardedMultiplier` in the calibration state
    (shown in `RenderStats.calibration`). Two kinds of store can then refuse
    every compile with `OverBudgetError` before inference. One holds no
    carriers and kept a multiplier last learned before its host moved to
    context-manager 0.11.0. Its record can't show that; the host's own
    history can, in its lockfile's or its deployments' history: a host that
    went from a context-manager older than 0.11.0 straight to 0.14.0 can
    hold one. The other holds carriers and had learned a multiplier
    below 1, which its `reset.discardedMultiplier` shows. With the host
    stopped, reset the first kind's multiplier once, and re-stamp the second
    kind's checked value, as the **Operators** entry of context-manager
    0.14.0's changelog describes. The reset is for a store that already
    opened on 0.14.0 and ran a committing compile, which re-stamped its
    multiplier: `^0.14.0` now installs 0.14.1, which keeps a still-unstamped
    multiplier provisional and replaces or drops it on its own.
  - **What else hosts meet with context-manager 0.14.0** (added after the
    release): a preview, or any compile made with `dryRun`, leaves the context
    manager's estimate, its calibration and a pending kv-unified draft's marker
    indices as it found them. The context manager's state queries (`isReady`,
    `getPendingWork`, `getHotContextSettings`, `previewContext` and others)
    throw while its strategy's initialization is pending or has failed, where
    they used to answer. A reposted sharded document renders as two bodies, so
    a stored conversation holding one misses the prompt cache once after the
    upgrade.

## 0.21.0 — 2026-10-03

### Breaking

- **Direct ConversationRouter callers:** `route()` is now a pure query and no longer refreshes idle activity (#46). After successfully delivering a message to the bound fork, call `touch(channelId)`; deterministic clocks move from `route({ now })` to `touch(channelId, now)`. Framework-managed delivery performs this step automatically, including ambient messages and coalesced fixed-audience delivery to the current binding. Queries, failed writes, and delivery to an older engagement leave the current binding's clock unchanged. Bind rules, trigger rules, generation counters, and fork names are unchanged. No store migration or sibling dependency upgrade is required.

### Changed

- Depend on `@animalabs/context-manager` ^0.13.0: optional compression-hold timeouts, branch-ID cache keys, Bedrock summarizer recognition, tool pairing before pruning in both renderers, and fuller refusal diagnostics.

### Fixed

- Stdio MCPL children inherit `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and uppercase/lowercase `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` so Python/curl CA trust and proxy-based egress survive the child environment allowlist (#191). Declared server `env` still overrides host values, including differently cased keys and empty values on Windows; POSIX names stay case-sensitive. Duplicate Windows spellings within one source use Node's first lexicographic spelling before declared values override host values. Proxy URLs can carry credentials; the allowlist limits accidental inheritance rather than isolating a hostile child.

- RFC-005 references now drop overlong optional `name`, `mimeType`, and `expiresAt` fields instead of retaining truncated testimony. Their schema limits count Unicode code points. Reference blocks and subtractive disposition remain valid; admitted display labels retain independent sanitization and truncation.

- `tools/observe` rejects explicit null params and non-object `_meta` before changing the existing filter. Omitted params and `rules: null` still clear the filter. Pattern and field-path limits count Unicode code points, matching the RFC-007 schema and accepting valid 256-code-point astral strings; rule and path-count limits are unchanged.

## 0.20.0 — 2026-10-03

### Breaking

- **Operators of stdio MCPL servers:** children no longer inherit the whole
  host environment. They get a small allowlist (`PATH`, `HOME`, locale/`LC_*`,
  `TMPDIR`, TLS roots, …; see `CHILD_ENV_ALLOWLIST`) plus the server's own
  `env`, so one server's credentials (provider API keys, other bots' tokens)
  are no longer readable by another. A server that relied on an inherited
  variable must declare it in its `env` (recipes can `${VAR}`-substitute), or
  set `inheritEnv: true` to restore full inheritance.

- **Resident scripts parsing history `extract`:** without a `channelId`,
  `extract` no longer returns `matchedCount` (a time-only native query only
  ever reported the page size there, not a total). It returns `hasMore`
  instead; channel-scoped `extract` keeps its exact `matchedCount`.

### Added

- `code_execution` takes an optional per-call `time_limit_ms`: the time limit for
  that script, the way Claude Code's Bash tool takes a per-call timeout. It
  defaults to `codeExecution.scriptTimeoutMs` (10 min) and may go up to the new
  `codeExecution.maxScriptTimeoutMs`, which defaults to the same value, so
  agents can only shorten the limit until a deployment raises the ceiling.
  Longer requests are capped and the result says so (`time_limit_note`). For a
  background script it shortens the lifetime, capped at
  `backgroundMaxLifetimeMs`. The tool description now states the limit, and a
  script stopped at its limit says so instead of only "cancelled by host".

- MCPL tool lifecycle (mcpl RFC-007): servers granted `toolLifecycle.observe`
  receive `tools/lifecycle` notifications for the agent's calls to OTHER
  servers' tools and to host tools — `started`, then exactly one of
  `completed` (with `isError`) / `failed` / `aborted`, paired by a host-unique
  `toolCallId`. Metadata only by default; tool results are never sent.
  - `toolLifecycle.inputs` adds the call's arguments, but only the fields a
    server asks for with `tools/observe`, bounded (16 KiB default,
    `toolLifecycle.maxInputBytes`), and never for `comms` or unclassed tools.
  - `tools/observe` (server → host request) sets an ordered first-match
    filter on which calls are reported and which argument fields are sent;
    it only narrows what the grant allows.
  - Both paths are denied by default. Grant them with a
    `McplServerConfig.toolLifecycle` policy block (`observe`, `inputs` with a
    `tools`/`classes`/`conversations` narrowing; `classes: 'default'` admits
    computer, shell, files, web, media and body) or via `enabledCapabilities`.
    `inputs` with no tools/classes term delivers no arguments.
  - `listMcplServers()` shows each connection's current filter.
- MCPL tool classes (mcpl RFC-008): a tool's class is read from
  `_meta["mcpl/class"]` on its MCP definition, from the framework's table of
  its own tools, or from `FrameworkConfig.toolClassOverrides` /
  `hostToolClasses`. Classes are policy hints only: they never change what
  the model sees.

- History tools, from a resident's diary-work feedback: `search` and `extract`
  take `author` / `excludeAuthor` (exact, case-insensitive match on
  `metadata.author` name or id; messages without author metadata, such as
  the agent's own turns, match on their stored participant). Results now carry `author`.
  `extract({aroundId, before, after})` returns the conversation around a
  message id from `search` (its own channel by default, `allChannels` to
  interleave). `search` adds `wholeWord` (Unicode-aware) and
  `order: "newest"`, and when it stops early (at `limit` or `maxScan`) it
  reports `scannedThrough` and `resume: {from|to, skipSequences}` to repeat
  the call with (`skipSequences` names the messages at that exact instant
  already scanned by sequence range, so a message added or removed there
  between calls is neither lost nor shifts the skip). `search` rejects
  `maxScan: 0`.
  An author-filtered `extract` that stops early returns
  `resume: {windowOffset, offset, afterId}` to repeat the call with (position,
  not timestamp, so late-appended backfill in a channel is not skipped). On
  resume, `afterId` pins the position: if messages were removed or inserted
  before it since the previous call, the scan re-anchors and reports
  `windowChanged: {shift}`; if the anchor itself is gone, it fails loudly
  instead of silently skipping. Without a channel (a time-ordered window) the
  resume also carries `seqMark`, and messages appended since then that landed
  behind the cursor are reported in `windowChanged.missedIds` even when a
  removal balanced them out (shift 0). Unrelated appends don't count; past
  200,000 appends since the mark the check is reported as
  `windowChanged.unverified` instead of failing. A resumed call reports
  `matchedSinceWindowOffset` rather than a total.
  `aroundId` also accepts a `semantic_search` `msg:<id>` hit id.

- `HistoryModule` gains an optional `semantic_search` tool: meaning-based search
  over the agent's raw messages (text plus its own think/journal/skip_reply
  notes) and every compression summary, backed by a shared remote
  embed-service whose vector index lives server-side, one namespace per store
  (`new HistoryModule({ semantic: { url, token, namespace } })`). The module
  keeps the index in sync itself — a background tick every 60 s and a bounded
  catch-up before each search, messages watermarked by timestamp with an
  overlap re-scan and summaries by `createdMs` — and backs off cleanly when
  the service is unreachable, so the other four history tools are unaffected.

- Operators can see each tool's effective MCPL class (RFC-008 §6):
  `listMcplServers()` entries gain `toolClasses` (every tool of that server,
  with its class and whether it came from an operator override, the
  server's own `_meta["mcpl/class"]`, or nowhere — unclassed), and the new
  `listToolClasses()` lists every tool the framework offers, host built-ins
  and agent-only tools (the subconscious's, `prose_help`) included, with
  the same source and the MCPL server where there is one.
  `listToolClasses(agentName)` lists exactly what that agent is shown.

- MCPL event coalescing (RFC-006, mcpl PR #5 revision 7): `coalesce` on `push/event` and `channels/incoming` — replace-if-unread, atomic retraction with a conditional deletion notice, `initial` birth marker, deferred batches rendered through `push/render` at assembly, channel-scoped pushes delivered as messages of their channel. Content stays in context; "unread" is above the agent's consumed watermark and not folded by compression. Advertised as `eventCoalescing` with a one-hour retry window.

- Silent heartbeat wakes: an authenticated empty push from the `heartbeat` MCPL server can start one private inference without adding a Chronicle message, resolving or announcing a publication locus, starting typing, or routing automatic prose. The tick carries a bounded ephemeral self-check prompt; explicit tools remain available, and context-budget restarts preserve the silent-turn contract.

- Add the opt-in, durable `agent_settings.tool_result_guard` setting
  (programmatic `AgentConfig.toolResultGuard`; hosts must forward it from
  recipes). On a provider refusal after tool output, withhold the
  latest result batch and retry inference once without rerunning tools or
  automatically rewinding older messages. Full originals remain in an
  append-only Chronicle audit log (synced before submission); pending output
  stays out of speculative compression and the placeholder is held from
  compression until settled (requires context-manager ^0.12.0), guard effects apply only to a batch
  actually submitted in the current turn, and disabling the guard does not restore withheld results.
- Recover from failed staging/link audit appends and accepted-result history
  edits without stranding streams or compression holds. Retry storage work
  before activation, during maintenance, and at shutdown; preserve later
  operator edits and branch changes. End-turn output remains withheld when
  its audit was not made durable.

### Fixed

- The closed-channel invitation's "reply without joining" prefix is now always one
  whitespace-free token that resolves back to the channel on the server the message came
  from (`@name` for a DM, else `#label`, `#name` without the server suffix, or the channel
  id), from the new `ChannelRegistry.proseTargetFor(channelId, serverId)`. It used to quote
  the label verbatim, and the prefix grammar reads the target as the first non-whitespace
  run: a DM labelled `DM: alice` gave `>>#DM: alice` (target `#DM:`, body `alice …`, so the
  reply bounced and the retained text went out with a stray `alice` line), and a suffixed
  label like `#fable (antra's server)` delivered `(antra's server)` as text. When no token is
  safe (the channel id is registered by more than one server, or every option contains
  whitespace) the invitation offers no prefix and points to joining the channel instead.

- MCPL tool calls under nested tool prefixes (one server's prefix `foo`,
  another's `foo--bar`) went to whichever prefix was registered first. A
  call now goes to the server whose `tools/list` produced the name; a name
  no live server listed goes to the longest matching prefix.
  `listMcplServers()` counts and lists each tool under that one server.

## 0.19.0 — 2026-09-28

### Added

- `journal({content})` — a synthesized private note-taking tool beside `think`
  and `skip_reply`. The entry stays in the agent's own context and is sent
  nowhere; it does not end the turn and does not affect prose routing. It exists
  because long prose kept in `skip_reply.reason` (or `think.content`) makes
  replayed history read as a reasoning trace, and every memory-compression
  request over it is refused `reasoning_extraction` regardless of content,
  while the same prose in a note-taking tool passes. Context-manager's
  `compressionToolProseFallback` rung rewrites old history into calls to this
  tool and mirrors its result wording.

### Changed

- `classifyInferenceError` matches context-manager's `OverBudgetError` /
  `UncoveredDropError` with a real cross-package `instanceof` now that CM
  exports them from its package root (context-manager#41/#71 — the follow-up
  promised there). The `err.name` comparison is kept as a fallback for
  deployments carrying two CM copies, and the message-prose match remains a
  last resort for serialized reasons; neither classification changes.

- `skip_reply.reason` is now described as ONE short line (under ~100
  characters), pointing at `journal()` for anything longer. Description only —
  no length is enforced and existing calls behave exactly as before.

### Fixed

- `channels/changed` is answered before the host reconciles the added
  channels, as `channels/register` already was (#160). Reconciling sends
  `channels/open` or `channels/close` back to the server, and a server that
  announced from inside a request it was serving (a tool that refreshes or
  subscribes) could not read them until its announcement was answered, so
  both sides waited until one timed out. In zulip-mcp this left streams the
  bot joined after startup as `Unknown channel` until a restart.

## 0.18.0 — 2026-09-25

### Changed

- Depend on `@animalabs/context-manager` `^0.11.0`: the kv-unified solver no longer
  grows its label set with the forest once a cache is relevant (#105), solves are
  packed and selectively rescored (#110), and signed thinking blocks are priced by
  signature (#113, the store-side half of #170).

### Fixed

- Signed `thinking` / `redacted_thinking` blocks are stamped with a `tokenEstimate` when persisted: this call's `usage.output_tokens` minus the visible blocks, split across carriers by signature length (per tool round, and on the trailing content at completion; cumulative membrane usage is diffed per call). On keep-all models the hidden chain of thought is replayed and billed as input on every later call, and context-manager's budget had no measure of it beyond a flat default — the compiled request ran ~1.5× over budget on long agentic histories, with dead `max_tokens` turns at the context ceiling.

## 0.17.0 — 2026-09-21

### Added

- `FrameworkConfig.providerHold(error, agentName)`: a host hook consulted on
  a failed inference, before the error policy. Returning `{ holdMs, reason }`
  parks the agent's provider admission the same way the built-in
  organization-acceleration cooldown does — no immediate retry, no
  `[inference-failed]` marker, no hard-down streak, arrivals held and merged
  into one later compile. Holds are served in slices of at most 10 minutes;
  when a slice expires the hook is asked again before any inference is
  attempted, so a long wait (a spent subscription quota window) costs no
  provider calls and an early reset is noticed within one slice.
  The hook is asked before the built-in acceleration classification, and
  receives `{ model }` for the failing agent. A failure in an auxiliary
  (compression) call arms the hold too, and such a hold releases without
  synthesising an inference. Ephemeral runs and conversation forks are not
  covered. `healthSnapshot()` reports `cooldownReason` and `hostHold`.

## 0.16.0 — 2026-09-18

### Added

- Host quiesce/maintenance mode (#122): `framework.quiesce()` drains
  in-flight turns (bounded, optional `abandon`), parks every subsequent wake
  (coalesced per agent+reason), pauses all MCPL data planes (control planes
  stay live), defers module/API context writes, and persists `hostMode` so a
  restart boots quiesced with a loud banner. `framework.resume()` gates on a
  fresh per-agent feasibility preview of the CURRENT settings (`force` to
  override; `ResumeBlockedError` carries per-agent verdicts), reopens data
  planes through the existing barrier funnel, flushes deferred writes and
  releases parked wakes. `framework.maintenanceTick()` runs one
  compression/maintenance pass on demand. Surfaces: `host/command` verbs
  `quiesce` / `resume` / `maintain` / `host-status`; WS `host.quiesce` /
  `host.resume` / `host.status` / `host.maintenanceTick`; HTTP `GET /hostmode`,
  `POST /quiesce|/resume|/maintenance/tick` (opt-in `ApiServerConfig.adminToken`,
  `x-admin-token` header always required on the POST verbs to force a CORS
  preflight). New traces `host:quiesce`, `host:resume`, `host:quiesced_boot`.
- Runtime-settings feasibility preview: `framework.previewAgentRuntimeSettings()`
  and `Agent.planRuntimeSettings()` expose the live→effective budget mapping;
  `updateAgentRuntimeSettings` preflights an immediate budget LOWERING and
  throws `BudgetPreflightError` when the folded floor cannot fit (paced
  descents, increases, no-op rewrites and boot restore are never blocked;
  `allowInfeasible` overrides).
- Review hardening of the above: `resume()` flushes deferred writes per
  message (a poison write cannot drop the rest or skip the data-plane
  reopen, which now runs in a `finally`); writes deferred while quiesced are
  persisted (`framework/deferred-writes` slot) and restored at a quiesced
  boot (`HostModeStatus.deferredWrites`); parked wakes coalesce per
  (reason, addressed) so a DM/mention parked earlier survives ambient
  traffic parked later; the `[1s, 10m]` drain clamp lives in `quiesce()` for
  every ingress; a `quiesce()` superseded by a concurrent `resume()` returns
  without abandoning anything; `resume()` waits for an in-flight maintenance
  pass instead of skipping the feasibility verdict; `abandon` reports turns
  it cannot cancel (`unabandonable`); `tool_results_ready` continuations pass
  the wake gate like budget restarts; `maintenanceTick()` returns `ran`;
  `nudge`/`unstick` replies carry `quiesced: true` while parked. ApiServer:
  WebSocket upgrades from foreign browser origins are refused
  (`ApiServerConfig.allowedOrigins`; same-host and non-browser clients pass),
  an empty `adminToken` is rejected at construction, `GET /hostmode` requires
  the token when one is configured, and `host-command` on the MCPL control
  plane means a surface `/undo` can now run ahead of pushes still buffered
  behind a startup/reconnect barrier.
- Review round 2: quiesce state and the deferred-write queue now live OUTSIDE
  branch history — `<storePath>/recovery/host-mode.json` and
  `recovery/deferred-writes.json` (`FrameworkConfig.hostModePath` /
  `deferredWritesPath`; the branch-local slot is only a fallback for
  store-only configs, with a warning) — so a historical rollback can no
  longer erase the marker of the surgery it belongs to or orphan the writes
  it deferred. A wake parked on provider admission behind an in-flight
  auxiliary call now rechecks quiesce when the auxiliary settles and is
  requeued instead of starting a turn; `HostModeStatus.parkedAdmissions`
  counts such wakes and `drained` is false while any exist. The resume flush
  acknowledges each deferred write durably as it lands and stamps its id into
  the stored message's metadata; boot recovers the queue regardless of the
  mode flag, skips ids that already landed, and the durable flag is cleared
  only after the flush completes — an interrupted resume neither loses nor
  duplicates a message.
- Review round 3: a flushed deferred write is removed from the durable
  recovery queue only AFTER `store.sync()` has made the appended chronicle
  slots durable (chronicle persists the slot-chain head on sync, not on
  append). Every deferred-drain path — resume flush, boot recovery, the
  turn-start / turn-end / puppet-end flushes — hands its batch to an
  un-acked set, writes, syncs, and only then rewrites the queue; a failed
  sync keeps the batch queued (retried at the next ack and at `stop()`).
  Regression coverage uses a real child process that `process.exit`s
  mid-resume, both right after the first acknowledgement and before the
  sync: the reopened host replays exactly the un-landed remainder.
- Review round 4: one durable id per logical deferred write across every
  hand-off. Every write that originates from the durable queue — the
  ordinary turn-start, mid-turn-injection, turn-end and puppet-end flushes,
  not only the resume flush — stamps `metadata.deferredWriteId`, and a
  re-deferral (target still busy or host still quiesced when a drained entry
  is written) moves the same entry back to pending under the same id
  instead of minting a second replayable one. Two more real child-process
  crash regressions: exit between an ordinary turn-start flush's sync and
  its queue rewrite, and exit at a re-deferral's recovery-file write.
- Review round 5: deferred-write entries carry a monotonic `seq` from first
  deferral; the durable queue is written, restored, drained and flushed in
  that order whatever the pending/un-acked split, so a re-deferred member
  of a batch keeps its place. Each hand-off persists a receipt of the
  target's store position before anything is written; boot dedup scans from
  that position to the tail (the whole store when a receipt predates it),
  never a fixed 2,000-message tail — a synced-but-unacked batch of any size
  is recognised in full. Recovery file/slot format is v2
  (`{pending, scanFrom}`); v1 is still read.

- `HistoryModule` gains a fourth tool, `overview`, for browsing conversation
  history when the caller doesn't already know a specific channel/date/search
  term: returns existing compression summaries as a table of contents (zero
  new LLM calls), falling back to raw message/channel counts for spans not
  yet summarized. `stats`/`extract`/`search`/`overview` now all accept a
  `channelId` as either a channel label (e.g. `#general`, `@name`, `<@id>`)
  or the raw internal channel id — resolved via a new durable
  `ChannelRegistry` label-history log, so a channel is still addressable by
  name even after the bot disconnects from it (the common case for browsing
  history on a quiet/old channel, where the live channel registry has
  nothing).

- Live operator surgery on the open store, no restart: `rollbackToMessage()`
  forks the chronicle at a message and switches to the fork (the source
  branch keeps everything after it); `suppressMessages()` forks at head,
  redacts the chosen messages on the fork (body-group shards always
  together), and switches. Both are the offline-recovery idiom made live and
  reuse the Discord awareness outbox (markers for messages that left the
  context; suppression batches activate only after the last redaction and
  finish at next boot if interrupted). Both refuse — never queue — while the
  agent is not idle (`OperatorActionError`, code `agent-busy`). The
  message-granular `host/command undo` now rides on `rollbackToMessage`
  (reads windowed, blob-free — no longer re-inflates every attachment on the
  branch). Its stderr line is now `[operator] rollback …` rather than
  `[host-command] undo-messages …`, and the reply carries the refusal `code`.
  Body groups are never bisected: a rollback target inside a sharded message
  snaps to the group's last shard (`tailMessageId` in the result), and a
  suppression removes the whole group as a range. The idle gate is the
  scheduler's own (`idle+turn-alive` counts as busy).
- `DiscordAwarenessOutbox.discard(batchId)` retires a prepared-but-never-
  activated batch. Live suppression uses it on every failure path so an
  orphaned explicit batch can no longer re-arm at boot and abort
  `AgentFramework.create()`.
- Durable operator log: `<storePath>/operator-actions.jsonl` (config
  `operatorLogPath`, `false` to disable) records who asked, from where, and
  why for every operator mutation — rollback, suppress, hide, undo/redo turn,
  unstick, nudge, runtime-settings update/reset/cancel — plus anything a host
  records through `recordOperatorAction()` (e.g. quiesce/resume). Each record
  is also broadcast as an `operator:action` trace; `getOperatorLog()` reads
  the tail. `undoLastTurn`/`redo`/settings methods accept an optional
  requester.

## 0.15.0 — 2026-09-17

### Added

- `HistoryModule` adds `stats`/`extract`/`search` tools for querying an
  agent's full uncompressed message history by time range and/or channel
  (#151), backed by context-manager's native chronicle secondary-index
  queries — O(log n + k) against multi-million-message stores, not a full
  scan. Read-only, `bind(contextManager)` after `AgentFramework.create()`.

### Fixed

- `puppetToolCall` reserves the agent against turn start for its whole
  duration (#145). The idle check was a point in time before two awaits
  (tool execution, result build); a wake arriving in either gap started a
  real turn, and the synthetic `tool_use`/`tool_result` pair then wrote
  straight into the window under that turn — the wire-order corruption the
  puppet exists to avoid. The puppet now holds the turn-alive marker the
  scheduler and the `addMessage` deferral guard already respect, and refuses
  when a turn is alive even if status reads idle. The one path that could
  still start a turn over the reservation — a wake parked on provider
  admission resuming after an auxiliary call — now re-tests turn-alive, gives
  admission back and requeues the wake for the scheduler instead.

- kv-unified: a new activation now closes any receipt flight its predecessor left unsettled before it submits its own. A provider attempt that died without a usage event (transport error, idle timeout, budget-restart or endTurn cancel) used to keep its flight open until the old stream's teardown, and every successor path started first — so the retry itself failed with `kv-unified submission … is still in flight` (devops agent, 2026-09-16).
- Inference-log records below the blob threshold are persisted through their JSON view; the kv-unified receipt hook on a compiled request (a function) made Chronicle reject the record with `JS functions cannot be represented as a serde_json::Value`, throwing from the failure path it was logging.

- Oversized tool-result spill files can now be read in bounded character
  ranges with `workspace--read` (`offsetChars`/`limitChars`). Spill notices
  include a read command sized for the inline cap and explain how to continue.
  This makes single-line JSON, large string values, and non-JSON long lines
  recoverable without rewriting the stored result or expanding it past the
  workspace file-size limit. Existing line-based reads keep their behavior.

## 0.14.0 — 2026-09-09

### Added

- Gate-batched wakes (`gate:debounce`) carry telemetry provenance: the
  EventGate hands the framework the newest addressed channel event (else the
  newest event naming a channel or author) as `counterparty`
  (`<serverId>:user:<id>`), `wakeChannelId` (composite channel id; push-event
  raw ids are not reported) and `wakeAt`, all from the same event, so the
  turn's `InferenceRequest` — and a host stamping gateway telemetry from it —
  can say who and where woke the agent. Telemetry only: the turn's speech
  locus (`channelId` / `addressed`) is not set by gate wakes, so routing is
  unchanged. `WakeProvenance` is exported.

### Fixed

- **`save_recent_image` can no longer save the wrong image** (#104). Tool-result
  images never reached the persisted window — history keeps a text placeholder
  and only the live wire copy carries bytes — so the recency scan walked past a
  snapshot the resident had just seen and quietly saved an OLDER attachment
  under the snapshot's filename (or reported "no images found"). Every
  tool-result image is now retained per agent at ingestion in a bounded
  in-memory ledger with provenance (tool call, block, MIME, size, SHA-256), and
  the history placeholder carries its handle:
  `[image: image/png, ~691KB, ref img_7]`. The tool walks one ordered inventory
  across attachments, tool images and image-typed RFC-005 reference stubs; when
  the image at the requested index cannot be produced (evicted, from an earlier
  process, a pre-retention placeholder, a quoted/forged placeholder whose ref
  belongs to another call, or a reference whose bytes live behind
  `fetch_reference`) it fails **at that index** and writes nothing — it never
  substitutes an older image. New `ref` argument saves by provenance; receipts
  report source, tool call, MIME, byte size and SHA-256.
  Second review round (#140) closed three more representations of the same
  failure: truncation/spill now re-appends every image slot that fell past the
  cut (the stored text is the only place the inventory finds tool images, and
  the wire delivered them regardless); a save dispatched in the same batch as
  the tool that produced the image waits for its siblings to settle (bounded,
  fail-closed) and classifies their results with the commit-path serializer;
  refs are namespaced per ledger (`img_k7x3q2_7`) so a placeholder from a
  previous process resolves to nothing rather than to today's seventh image,
  and a direct `ref` is saved through its visible placeholder (same provenance
  cross-check as by index). Mime types normalize to a type/subtype essence
  (parameters dropped, nonconforming → `application/octet-stream`) so the
  placeholder always re-parses; large payloads are digested chunked; the
  ledgers are released on framework `stop()`.

## 0.13.0 — 2026-09-07

### Added

- **Tune-out (#77): subconscious summaries instead of unsubscribing.** A third
  channel state between subscribed and gone: `tune_out` diverts a channel's
  traffic to a persistent same-model side-agent (participant `Subconscious`)
  that summarizes on a cadence in its own voice, judges wakes (addressed
  messages and gate-privileged authors, both preconditioned by the resident's
  wake gate), and can cancel. Suppressed mentions get a deterministic
  `channels/acknowledge` reaction; wake budgets are durable in the
  `mcpl/channel-lifecycle` log with max-wakes auto-cancel; optional
  `durationSeconds` gives a tune-out a restart-surviving deadline. Cancel
  delivers a capped `<tuned-out-backlog>` dump plus a subconscious report;
  diverted messages never enter the residents' compiled view (cm `viewFilter`)
  and stay excluded after cancel. Standing dispositions ride a fixed
  system-position injection on the subconscious's compiles. Requires
  `@animalabs/context-manager` with strategy-view composition
  (context-manager#54); designer review record in #115.
- **`targetAgents` honored on the channel-incoming fan-out** (was declared but
  dead); untargeted events keep the historical broadcast.
- **Per-agent message delivery**: `addMessage(…, {forAgent})` with deferral and
  turn-alive guards evaluated against the target agent; gate self-wake notices
  deliver to the waking agent. Default path unchanged.

- Add a default-off, per-agent guard that contains an exact whole-response textual wrapper for a tool registered on that inference. The wrapper is neither executed, published, nor stored as assistant continuity; a content-free system receipt records that no tool was called.

### Fixed

- `read_image` / workspace `read_image` no longer reject a JPEG that carries
  padding after its EOI marker (#143). Hardware encoders such as the Raspberry
  Pi camera pad every still to a 4-byte boundary (`ff d9 00 00 00`), and
  decoders stop at EOI, so these are valid images; the validator used to
  require EOI to be the final byte and reported them as `Invalid JPEG image`,
  which made an rpi camera unviewable for a resident. The SOI..EOI stream is
  still fully validated.

## 0.12.0 — 2026-09-05

### Added

- **`WorkspaceModule.readFileFromDisk(mountPath, { maxBytes })`** — a
  workspace-owned filesystem read for peer modules that enforces the mount
  boundary on disk, not just on the path string (#129). Honors the mount's
  `followSymlinks` policy (default: refuse), requires the canonical target to
  stay beneath the canonical mount root when symlinks are allowed (so an
  intermediate symlinked directory or a sibling-prefix root cannot escape), and
  performs a bounded prefix read when `maxBytes` is set, reporting `truncated`
  alongside the full `size`, `mtimeMs` and canonical `realPath`. Refusals throw
  the exported `WorkspaceReadError` with a `code` distinguishing unknown mount,
  lexical traversal, unavailable mount, missing file, directory, policy-denied
  symlink, outside-mount target and file-changed-during-read.
  `resolveAbsolutePath()` is now documented as lexical-only and deprecated for
  direct reads; `read_image` shares the same containment core with its error
  wording unchanged.

- `InferenceRequest.counterparty` carries the adapter-namespaced author id of
  the channel message that triggered the turn, and
  `getActiveTurnTrigger(agentName)` exposes the trigger of the turn in
  progress (kept beside the turn token, cleared wherever it is) so a host can
  stamp gateway telemetry with why the call exists and who woke the agent
  (#141).

- Wire `kv-unified` immutable-prefix identity and caller-owned cache markers through activation requests, and commit context presentation/cache receipts only after the corresponding provider call is accepted.
- Calibrate context estimates from per-provider-call usage deltas instead of cumulative tool-loop totals.

### Fixed

- The workspace materialize branch guard checks lineage instead of branch
  identity: a branch that linearly continues the last-materialized branch
  (every fork point at or after the materialized sequence) materializes
  normally, and proven-ancestor pins are re-pinned at boot — so an
  out-of-band repair that leaves the store on a fork-at-head child branch no
  longer wedges every materialize until manual surgery. The guard is scoped
  to the mounts being materialized (one mount's stale pin no longer blocks
  the rest, blocked mounts are reported as `skipped`), `canMaterialize` in
  `status` shares the guard's exact predicate instead of a divergent
  computation, and genuine divergence can be overridden with the new
  `force: true` input, which resets tracking and re-materializes the full
  tree (an incremental diff across divergent history silently writes
  nothing).

- **World `say` / `whisper` now silence adjacent auto-routed prose in every
  prose-routing mode**, not only `hybrid`. In `locus` mode a round of ordinary
  text plus an explicit Eidoverse `say` published twice — the say text, then the
  adjacent prose auto-routed to the same world locus (Cairn, 2026-09-01, world
  seq 15146/15147 byte-for-byte). An explicit world utterance is the resident's
  chosen public speech for that round and is treated exactly like a channel
  send: sticky silencing from that round on, suppression visible in the
  `[delivered]` receipt. Discord send/reply/DM, `skip_reply`, `think()` privacy,
  text-only turns and non-publishing tool rounds are unchanged.

## 0.11.0 — 2026-08-26

### Added

- `proseRouting: "disabled"` keeps all generated plain prose private and permits external publication only through explicit tools, preventing ambient locus capture from publishing continuity output.

### Changed

- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.

### Fixed

- Anthropic organization-acceleration 429s now enter a per-residence provider cooldown instead of immediate same-window retries: later arrivals are retained for one fresh compile after the quiet window, local Context Manager maintenance waits behind the primary lane, and capacity errors never enter the poisoned-history breaker (AF #114 bounded first slice).

- **Workspace mounts are usable on native Windows.** The mount containment
  checks (the `parsePath` traversal guard and sync's `safePath`) appended a
  POSIX `'/'` to the mount root before prefix-matching, but `resolve()` emits
  backslash-separated paths on Windows — so every legitimate in-mount path
  was rejected: read/write threw "Path traversal detected" and `syncFromFs`
  reported every real file as outside its mount (`ls` was unaffected, making
  a populated mount look empty). Containment now compares with the platform
  separator; the sync walker and the watcher additionally normalize relative
  paths to the `'/'`-separated logical form used everywhere else. No
  behavior change on POSIX.

- Discord downtime history is written to Context Manager in chronological order while newest-message tracking retains Discord order.

- Rapid external messages now retain arrival order while remaining prioritized
  ahead of queued internal framework events.

- Mixed wake batches containing a context-budget restart now preserve the
  restart's same-turn semantics instead of taking the restart-only turn-lock
  exception and then starting from an older ordinary wake as a fresh turn.

## 0.10.0 — 2026-08-18

Minor release because it adds a third public prose-routing mode and expands the
runtime wake-rule surface.

### Added

- **Hybrid prose routing** (#113) — `AgentConfig.proseRouting: "hybrid"` keeps
  unprefixed prose in the frozen current locus while a leading
  `>>>destination` envelope uses the existing authorized cross-surface router.
  Exact authored source remains in resident context, recipients see only the
  body, and delivery success/failure returns as a model-visible receipt.
  Explicit publication tools outrank contradictory prose to prevent duplicate
  sends.
- **Composable wake-rule observers** (#106) — rate/sampling rules may fall
  through without swallowing later addressed-message rules, rules support
  anchored insertion, and the runtime reports before/after probes plus shadow
  warnings so ordering failures are visible before they become silence.

### Changed

- **Default inline tool-result cap raised from 5,000 to 24,000 characters**
  (#101). Durable resident overrides and strategy hard clamps remain unchanged;
  larger results still spill to the workspace with a bounded notice.
- **Workspace egress reads the current disk bytes** rather than trusting a stale
  in-memory copy, and skipped syncs now return an explicit reason.

### Fixed

- **Legacy XML tool-round persistence** (#107) stores each round's delta prose
  rather than the cumulative preamble and retains `toolName` on stored
  `tool_result` blocks, preventing duplicate public text and malformed replay.

### Security

- CI actions are pinned to immutable SHAs and checkout no longer persists
  credentials (#100).

## 0.9.0 — 2026-08-06

Minor rather than patch because 0.x puts breaking changes in the minor, and
this release both removes a public method from an exported class and changes
fleet default behavior.

### Breaking (consumers)

- **`McplServerConnection.sendAfterInference` is removed** (#86). The method
  was dropped from the spec in MCPL 0.5.0 (§10.5, replaced by
  `inference/lifecycle`) and the runtime stopped sending it then; only the
  helper survived.
  - **Who needs to act:** nobody we can find. `package.json` `exports` maps
    only `.`, and the root index re-exports a curated subset that never
    included `McplMethod`, `AfterInferenceParams` or `AfterInferenceResult`,
    so the surface is provably private. A grep across 14 trees found one
    definition and zero callers.
  - **Migration:** consume `inference/lifecycle` — `started` at stream start,
    exactly one terminal event on every exit path.
- **Tool results now spill to a file above 5,000 characters by default**
  (#91). Previously the cap was `strategy.maxMessageTokens * 4` — often tens
  of thousands of characters, and *no cap at all* when the strategy declares
  no `maxMessageTokens`.
  - **Who needs to act:** any deployment relying on large tool results
    landing inline. Raise `FrameworkConfig.toolResultInlineMaxChars`
    (minimum 1000), or per-agent via `tool_result_inline_max_chars`.
  - **Unchanged:** nothing is lost — the full result is written to a spill
    file and the notice names its path.

### Breaking (MCPL servers)

- **MCPL 0.5 enforces deny-by-default before the policy handshake completes**
  (§5.3). A connection carries an empty grant until `establishGrant()`, and
  privileged inbound traffic is rejected until the initial exchange settles.
  A server that does not answer the `featureSets/update` Request keeps an
  empty grant — **un-migrated servers will go dark**, accepted deliberately
  for a single-release rollout.
- **§7 `scope`/`elevate` is removed** — both now answer `-32601`, config
  `scopes` is ignored with a warning, and `ScopeManager` is gone from wiring.
- Requests denied against the grant answer `-32002` with
  `data: { capability }`; notifications are discarded with diagnostics.
  `-32001`/`-32003` are JSON-RPC errors with `data: { featureSet }` (§6.6),
  with result-shape fallback only for legacy responders.

### Breaking (dependency floors)

Raised to fix a build that only worked against local symlinks:

- **chronicle `^0.3.0`** — context-manager 0.6.3 requires `^0.3.0`, so the old
  `^0.2.2` installed *two* chronicles and the framework handed a 0.2.x
  `JsStore` to APIs expecting the 0.3.x one. Single copy now.
- **membrane `^0.5.78`** — the framework consumes the `retrying`
  yielding-stream event, which existed only in unpublished membrane commits
  until 0.5.78.

**Deploy note:** chronicle 0.3.0 open-writes a store format 0.2.x cannot
reopen. Take cold backups before upgrading any residence.

### Added

- **MCPL 0.5 capability grants** (#76, #78, #79) — the §6.2 vocabulary tree, a
  generic recursive advertisement walk (§5.1 boolean shorthand; unknown names
  mint nothing), grant matching with one-segment wildcards and
  bare-parent-grants-nothing (§5.4), and §13.4 deny-by-default for
  `inject.system`, re-grantable only via explicit config. Enforcement sits at
  the admission choke-point that live routing and every buffer flush share, so
  buffered events are authorized against the grant current at admission rather
  than at emit. Hook fan-out selects by grant, `userMessage` is `null` when
  `observe` is not granted, and injection positions are authorized against the
  grant current at response receipt (§10.8).
- **§17 host-side manifest tracking** (#78) — `mcpl/manifestChanged` routed
  ungated (§17.3: gating would silence exactly the servers whose grants just
  narrowed), fetched via `mcpl/manifest`, validated exactly as `initialize`,
  and applied reduction-first through an interim `new ∩ old` grant before the
  server is told (§6.7). Rate-limited per connection with in-flight coalescing
  and a 5s floor, host-bounded rather than trusting server coalescing.
- **Host-side capability scoping** — `enabledCapabilities` /
  `disabledCapabilities` per server, same allow/deny and wildcard idiom as
  `enabledTools`. A server names its own capabilities in its `initialize`
  response and hook fan-out keyed off that self-advertisement, so connecting
  any server claiming `contextHooks.afterInference` received the complete text
  of every agent turn, and disabling its feature sets did not stop that:
  feature sets gate what a server may *do*, while what it may *see* was gated
  only by its own advert.
- Live policy status in the MCPL server listing, and manifest freshness in
  server status (#87).
- **`refusalHandling.retries`** (default 0) — plain same-model retries when a
  turn ends in `stop_reason: refusal`, before rewind or reaction. Near the
  classifier threshold the verdict is probabilistic rather than a function of
  the payload; identical bytes were observed passing and refusing minutes
  apart. Retries are spent at the membrane seam, which replays the same
  request immediately and cache-warm — a framework requeue recompiled, making
  attempts correlated rather than fresh draws. `driveStream` handles
  membrane's `retrying` event by re-minting the outgoing inference id and
  resetting the prose router, so the surface orphans the partial preview
  instead of splicing two half-answers together. Escalation order is now
  retries → rewind → reaction, which restores the reaction's meaning as "the
  border is close" rather than firing on every near-threshold flip.
  Operator-forced `/unstick` skips retries and keeps its semantics.
- **`REFUSAL_REACTIONS`, the fallback marker, and `REFUSAL_REACTION_BASELINE`**
  are exported from the root index (#88) — the deduplicated set of every
  marker `reactToRefusal` can emit, so a host can suppress exactly the
  annotations the framework stamps instead of keeping a list in sync by hand.
- **`nudgeAgent()`** — queue a normal inference request with zero context
  mutation, so the turn compiles exactly what the agent already sees. Not
  idle-gated; queued requests bypass gate sleep as an admin override. Also
  wired as host/command `nudge`.
- **`skip_reply` `wake_in_seconds`** — end the turn but come back on your own
  after N seconds, so "not replying now" can mean "back in a moment" instead
  of "idle until something external arrives". Deliberately not sleep: no
  suppression window, external wakes flow normally, and any turn start cancels
  the pending self-wake. A compact one-line in-window notice rides the wake
  turn so the agent can tell its own timer from a heartbeat.
- **`AgentConfig.physicalWindowTokens`** (#92) — continuation rounds append
  tool results to the compiled request without recompiling, so a compile that
  was legal could walk past the provider's hard cap mid-turn and take a wire
  `context_length_exceeded` 400 (observed at 185k → 199.6k → 209k against a
  200k cap). Grace cannot help, because the provider cap is physical. Unset
  leaves behavior unchanged.
- **`tool_result_inline_max_chars` as a durable resident setting** (#91, #94) —
  persisted to `framework/state` alongside the other durable settings and
  restored on create, with load-time validation that drops invalid entries
  loudly. `reset` clears it and returns the agent to the residence default,
  and the reset itself survives restarts. The *effective* cap is
  `min(desired, strategy bound)` for every source: a durable preference must
  not become a durable path for one tool result to exceed the strategy's
  per-message safety limit. `agent_settings get` reports the full quartet —
  desired, effective, source, and `clamped_by`.
- **Routing self-observability** — `[delivered]` prose receipts collected
  across the logical turn (budget restarts accumulate into one receipt),
  `channel_open` moves the pin and announces it in its own tool result, and
  suppressed prose is visible in the receipt. The 2026-07-31 misroute series
  showed the agent provably knew its prose lane one round before misrouting;
  the failure was attention, and it could never see afterwards where its words
  had actually landed.
- **Engaged-channel re-pin** — a human follow-up in a channel the agent itself
  sent into this turn moves the locus, even without a mention. Tagged
  `chat:ambient`, such a message correctly declined the addressed re-pin, but
  conversationally it is a reply in flow, and trailing prose followed the stale
  pin into an unrelated DM.

### Fixed

- **A failing MCPL server can no longer crash the agent process.** A websocket
  dial failing at the HTTP layer (nginx 502 with the backend down) emits
  `error` on the raw socket more than once; `open()`'s settle paths called
  `removeAllListeners()` before `terminate()`, so the late error had no
  listener and became a top-level unhandled `ErrorEvent` — the whole agent died
  at boot, into a systemd crashloop (623 cycles observed live). Every settle
  path now leaves a swallow listener; the reconnect loop above owns recovery.
- Stale MCPL grants are revoked across reconnects.
- **Cache-inclusive stream counters are reset at stream start.**
  `lastStreamRealInputTokens` was never reset, so a new stream inherited the
  previous stream's window size until its own first usage event — and on the
  restart path introduced by #92 the inherited value is precisely the oversized
  number that caused the restart, so a round reaching the tool-result boundary
  before emitting usage would restart again, forever. Prior output is also now
  counted in the projection.
- A spill *write* failure now produces a distinct notice and trace, instead of
  being indistinguishable from a successful spill.
- The closed-channel invitation states the real delivery model and carries a
  missed tally.
- Tool-call state is attributed correctly across multiple feature sets.

## 0.8.0 — 2026-07-31

### Breaking

- **`McplServerConfig.tokenProvider` is renamed `accessProvider`.** Identifiers
  surface — in stack traces, in agent-readable source, in every model-driven
  loop over this code — and the name now matches the access-grant framing.
  Mechanical rename; update the field name at call sites.

### Added

- **Background scripts** — `code_execution` gains `background: true`. The
  script detaches into a dedicated interpreter, the tool returns immediately
  with a `script_id`, and the turn is free to end. In-script,
  `await wake_agent(payload)` delivers a provenance envelope — script id, the
  line number in the agent's own script, elapsed time, wake count, journal path
  — plus the payload, and requests inference, entering tagged `script:wake`.
  The authority is the agent's own: it armed the wake itself. A script that
  ends without waking wakes nobody, and one that crashes wakes the agent with
  the error tail.
- **Oversized tool-result spill** — the agent's context is for signal, not
  bulk. (Completed with a safe default in 0.9.0; see #91.)
- **`utils` meta-tool** — `Module.getUtilities?()` takes the same
  `ToolDefinition` shape and the same `handleToolCall` dispatch as
  `getTools()`, so a tool migrates surfaces by moving between the two lists.
  The framework advertises a single `utils` tool (list / describe / run) only
  when at least one utility is registered, and `run` bounces schema misses with
  the schema attached. Rationale: every first-class tool schema taxes every
  inference, and a capability used twice a month shouldn't.
- **Per-dial MCPL credential provider** — resolved at every dial, connect and
  each background reconnect, overriding the static token. Host-attached and
  never serialized: agents name an access grant, credentials are fetched fresh
  outside model context, which also makes short-lived audience tokens viable
  where a static `?token=` forced long-lived ones. Dial-failure messages now
  carry a token-stripped URL, since error strings travel into traces and tool
  results.
- **Machine-close provenance and explicit-open protection** — `channel_close`
  accepts `source` and `overrideExplicitOpen` (module callers only, undeclared
  in the agent-facing schema). Housekeeping closes previously recorded
  `source: 'agent-tool'`, so the durable record could not distinguish an
  agent's decision from a janitor's, and downstream respect for agent decisions
  became respect for the janitor. A machine-sourced close of a channel an agent
  or operator explicitly opened is now refused structurally
  (`data.refusal = 'explicit-open'`) unless the caller certifies otherwise.
  Adds `ModuleContext.notifyOps`.
- **Addressed re-pin** — a turn's locus freezes at turn start (deliberate,
  as ambient-hijack protection), but when someone *addresses* the agent from
  another channel mid-turn the model conversationally follows the new speaker
  while its trailing prose lands on the stale pin. In all six recorded
  incidents the prose answered the injected speaker. Mid-turn addressed
  injections now move the locus.

### Fixed

- **Phantom skips and falsified history.** A DM's wake fired a turn whose
  compile ran before the deferred DM flushed: the model saw only the routing
  notice and reasonably skipped, and the DM then landed in the window
  mid-compile, positioned *before* the skip — so the window testified that the
  agent saw and ignored a message it was never shown, and the agent
  confabulated an apology for a choice it never made, with KV divergence at the
  inserted message on every later compile. `activeTurnTokens` now marks a turn
  alive from dequeue through settled teardown (strictly longer than
  `activeStreams` membership, which begins only after hooks and compile), and
  `addMessage` defers on turn-alive: the compile window is closed to cross-turn
  writers.
- **Lazy workspace sync corrupted binaries.** `ensureSynced` round-tripped
  every file through UTF-8 before storing the blob, so non-UTF-8 bytes became
  U+FFFD and any binary entering the tree via lazy sync was permanently
  corrupted. The bulk path already skipped binaries; lazy sync now mirrors it
  and serves them from disk. Separately, bare `read_image` was unconditionally
  intercepted by a tree-only handler with no fallback, and now falls back to
  disk.
- **`WorkspaceModule` restart restoration is second-callback-safe** (#72).
  Hosts call `module.start(ctx)` before `initStore(store)`, but restoration
  looped over `this.mounts` inside `start()` — empty at that moment — so every
  restart silently reset materialization state: misleading `pendingChanges`,
  null `lastMaterializedBranch`, `canMaterialize` true across a branch
  mismatch, and a disabled branch guard until the next materialization.
  `start()` now only decodes the persisted payload, and a shared
  `applySavedState()` applies it once mounts exist, called from both callbacks.

## 0.7.4 — 2026-07-27

### Added

- **Immediate context-budget decrease** — `patch.immediate` (a mode flag, never
  persisted) takes a `contextBudgetTokens` decrease down the same path as an
  increase: budget set directly, any in-flight paced descent cancelled, and the
  next compile plans straight at the new value. Previously a decrease could
  only converge gradually, which is the wrong tool during a refusal streak or
  an over-wall wedge — the operator needs the window smaller now, and the whole
  fold-down and its KV invalidation land on one turn by explicit choice. Also
  exposed on `agent_settings`.

### Fixed

- **Thinking-only assistant messages are never persisted.** They are refusals:
  the provider returns signed thinking and no content, so the turn produced no
  speech and no tool call, and storing one records an action that never
  happened. Two landing adjacently are toxic — formatters merge consecutive
  same-role messages, producing a single assistant message carrying signed
  thinking from two *different* responses, which the provider cannot verify:
  a 400 that no retry can clear. One such pair took an agent hard down for
  roughly four hours. Refused at `addAssistantResponse`, the single chokepoint
  for every assistant persist, and refused loudly.
- **Unverifiable signed thinking is dropped from the last assistant message.**
  The provider verifies thinking blocks in the latest assistant message against
  their signature, and a block whose text was summarized or redacted away
  (signature present, thinking empty) fails that check and 400s the entire
  request, unrecoverably — one agent was down ~2.5h across 13 consecutive
  failures. Such blocks are normal in these stores and harmless everywhere
  except that one position, where the provider replays their encrypted chain of
  thought, so the strip is scoped to the last assistant message: a blanket
  strip would silently discard the agent's interiority.
- **The typing indicator starts at turn start**, not after module
  `gatherContext`, MCPL `beforeInference` RPCs, the full context compile and
  stream initiation. Every millisecond of that leg read as dead air to whoever
  had just messaged the agent — 30+ seconds during one compile regression, and
  still seconds afterwards. Typing now means attending, not replying. The
  failure paths that never reach `driveStream` stop the indicator, so a compile
  refusal cannot leave it stuck.
- **Channel invitations reach the `channels/incoming` path.** The
  addressed-while-closed invitation block existed only on the push-event path,
  so an agent woken by a mention delivered via `channels.publish` got no
  guidance and no route — one observed reply of 2,320 characters bounced with
  "no destination set yet this turn". The invitation's first option was also
  reworded: "simply write your reply as normal text" is a false promise for
  explicit prose-routing agents.
