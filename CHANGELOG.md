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
