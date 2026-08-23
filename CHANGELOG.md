# Changelog

Notable changes to `@animalabs/agent-framework`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them — see [CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.7.3 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/anima-research/agent-framework/releases).

## Unreleased

### Added

- `proseRouting: "disabled"` keeps all generated plain prose private and permits external publication only through explicit tools, preventing ambient locus capture from publishing continuity output.

### Fixed

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
