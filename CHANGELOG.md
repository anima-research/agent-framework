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
