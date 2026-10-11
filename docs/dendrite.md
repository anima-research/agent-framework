# Dendrite: one registry, lifecycle and fork primitive for agents

Dendrite replaces four separate ways of making an agent (resident, subconscious, conversation fork, ephemeral subagent) with common machinery. Each of those is now a preset over one registry, one lifecycle and one way to derive a context.

This page describes what the framework implements. It follows the Dendrite proposal (revision 2, 6 October 2026) and [issue #232](https://github.com/anima-research/agent-framework/issues/232). The proposal is not an approved specification; [What is not implemented](#what-is-not-implemented) and [Choices made here](#choices-made-here) say where this implementation stops and where it had to decide.

## The model

Three things are kept apart:

- **Identity and lifetime.** What persists across runs: the name, the context the agent owns, its relationships. An identity has an *incarnation* number, which goes up each time it is instantiated.
- **Activation.** One bounded run. `listActivations()` reports each run in flight and the agent that owns it.
- **Policy epoch.** A tune-out interval. Ending an epoch ends neither an agent nor a task. `listPolicyEpochs()` reads epochs from the tune-out coordinator's own state; the registry does not keep a copy.

### Roles

The framework never asks what kind of agent something is. It asks what the agent's spec declares.

| Role | Meaning |
|---|---|
| `defaultDelivery` | A message with no named recipient goes to this agent. Exactly one agent has it. |
| `receivesUntargeted` | Woken by a module's `requestInference: true`, by a channel message or push event that names no agents, and as a default reader of a coalesced occurrence. |
| `receivesGateWakes` | Woken by the host-wide gate (debounce batches, sleep expiry). |
| `ownsProviderScheduling` | Holds the provider gate and owns rate-limit cooldowns. |

`kind` (`resident`, `subconscious`, `conversation-fork`, `task-fork`, `worker`, or any string) is a label for discovery only.

### Lifetime

| Lifetime | Ends | After a restart |
|---|---|---|
| `persistent` | Never; declared in configuration | Re-created as a new incarnation |
| `idle` | After `idleTtlMs` without traffic | Recorded as ended (`host-restart`) |
| `task` | When its run ends, at `deadlineMs`, or after `idleTimeoutMs` of silence | Recorded as ended (`host-restart`); can be resumed |

A `task` lifetime with neither a deadline nor an idle timeout is refused.

### Relationships

Four relationships, each separate:

- **Spawn** (`spawnedBy`): who created the agent. Optional; an independent agent has no parent.
- **Observe** (`observes`): whose stored messages the agent reads.
- **Message** (`messagePeers`): explicit paths the agent has used.
- **Result route** (`resultTo`): where a bounded job's result goes.

Spawning an agent does not make you its only observer or the recipient of its result.

## Presets

| Preset | Lifetime | Roles | Relationships |
|---|---|---|---|
| `residentSpec` | persistent | untargeted, gate, provider; the first one also has default delivery | none |
| `subconsciousSpec` | persistent | provider only | spawned by the resident it serves; ends with it; observes the shared slot including held traffic; result to the resident |
| `conversationForkSpec` | idle | gate only | spawned by the template; home channel; inherits by copy |
| `workerSpec` | task | none | optional spawner and result route |
| `taskForkSpec` | task | none | spawned by its parent; inherits its context |

With `subconscious.reader: 'forks'` the subconscious preset is not registered at all; the reader is a succession of `subconscious-fork` agents derived from the resident (see [The subconscious as forks](#the-subconscious-as-forks)).

The four existing creation paths register these presets. Their behaviour is unchanged, with one exception: an ephemeral agent that is mid-run is no longer queued for untargeted broadcasts or gate wakes. Those requests used to wait in the queue and were dropped when the run ended.

## Discovery

```ts
framework.listAgents({ includeEnded: true });   // every record
framework.getAgentRecord('fork-1');             // live, else the most recent ended one
framework.getPrimaryAgentName();
framework.listActivations();                    // runs in flight, with owners
framework.listPolicyEpochs();                   // tune-out holds in force
framework.listHeldMail();                       // results not yet delivered, and why
```

Ended agents stay inspectable. The registry keeps live records in the Chronicle state `framework/dendrite` and ended records in the append log `framework/dendrite/ended`.

## Lifecycle

There are no permission checks. The framework runs in one host trust domain, and any caller may stop, cancel or reparent any agent.

**Context isolation is not process or filesystem isolation.** Agents that share tools, a shell or a workspace can change the same external state. A fork that edits a file edits the file its parent sees.

```ts
framework.cancelActivation('worker-1', { by: 'mira', reason: 'changed plans' });
framework.stopAgent('worker-1', { by: 'mira' });
framework.reparentAgent('job', 'mira');
```

- `cancelActivation` aborts the run in flight and leaves the agent registered. A bounded job lives for one run, so cancelling its run ends it.
- `stopAgent` ends the agent. The caller that is awaiting its run receives an `AgentStoppedError`. The agent with `defaultDelivery` cannot be stopped; cancel its activation instead.
- A `task` lifetime's `deadlineMs` is enforced: the run is rejected with `AgentStoppedError` when it passes.

### When a parent ends

Each agent declares `onParentEnd`:

- `'end'` (attention tenancy): the agent exists to serve its parent and ends with it.
- `'orphan'` (bounded task work, the default): the agent keeps running. It receives a notice in its own context. Its nearest live ancestor, or else the primary, receives a notice that it can adopt the agent. `dendrite:agent-orphaned` carries the candidates. Set `dendrite.announceOrphans: false` if the host decides adoption itself.

`reparentAgent` clears the orphan state. If the orphan's result recipient is gone, the route moves to the new parent and results already held are delivered there.

The `dendrite:agent-created` trace names the kind, the model (whose weights), the context source (whose context), the lifetime and the `onParentEnd` policy at creation. It is the event a consent decision about a derived agent can be made on; the consent flow itself belongs to the host.

### After a restart

- Persistent agents are re-created by configuration, as a new incarnation.
- Every other agent that was live is recorded as ended with reason `host-restart`. If its result route is a message, the recipient is told once that it ended without a result.
- A persistent agent that the configuration no longer declares is ended with reason `not-configured`.
- Results held from before the restart are delivered, once.

## Messages and results

```ts
framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'the build is green' }]);
framework.deliverAgentResult('fork-1', [{ type: 'text', text: result.speech }], { causedBy: ['task-7'] });
```

Both put the sender's content in the recipient's context **under the sender's own name**. `metadata.dendrite` carries the sender's name and incarnation, the mail id, the causal chain, and `producedAt`, when the sender produced it, so a result that arrives late reads as mail from then rather than as the present. Nothing is inserted into the recipient's own voice.

Published is not delivered. `dendrite:mail-deferred` fires when a message is queued for a recipient's next boundary; `dendrite:mail-delivered` fires only when it has entered the recipient's store. Neither says the model has seen it; that is a separate event the framework does not yet record.

A result is written to the registry and synced to disk before delivery is attempted. It is released only when its message has entered the recipient's store. Consequences:

- If the recipient is mid-turn, the result waits for its next boundary and stays held until then.
- If the process stops in between, the next boot delivers it, after checking the recipient's store for the mail id so it is never delivered twice.
- If the recipient no longer exists, the result is held with reason `recipient-gone` until the sender is reparented.

`deliverAgentResult` works after the agent's run has ended. It refuses a `tool-result` route, because there the caller awaiting the run already has the result.

## Deriving an agent

```ts
const fork = await framework.deriveAgent({
  name: 'fork-1',
  from: 'mira',
  strategy: makeStrategy(),            // a fresh instance; same class and config as the parent's
  resultTo: { to: 'mira', as: 'message' },
  framing: [{ participant: 'user', content: [{ type: 'text', text: 'You are the fork. Task: …' }] }],
});
const { speech } = await framework.runEphemeralToCompletion(fork.agent, fork.contextManager);
```

The child gets the parent's context at a checkpoint and continues privately. The parent keeps running. Unless you override them, the child also gets the parent's whole configuration: model, thinking, cache TTL, provider parameters, system prompt, tools, and the parent's live context budget.

### Shared and copied inheritance

| | `mode: 'shared'` (default) | `mode: 'copy'` |
|---|---|---|
| What the child reads | The parent's messages and fold state at the checkpoint, through shared storage | The parent's compiled context, re-added as the child's own messages |
| Memory tree | Inherited, with its alternative resolutions | Lost; the child refolds a rendered copy |
| Written to the store per fork | Only what the child adds | A full copy of the compiled context |
| Parent's turns | Kept under the parent's name; mapped at request assembly | Renamed to the child at copy time |
| Requires | Chronicle with `JsStore.view`; context-manager with `ContextManager.derive` | Nothing extra |

With shared inheritance, neither side can change what the other reads. The parent's later folding does not alter the child's inherited past, and nothing the child does, background compression included, reaches the parent.

Shared inheritance is refused with a clear error when the installed packages cannot provide it. It is never silently replaced by a copy.

The child's writes go to a Chronicle branch of its own (`dendrite/<name>`). That branch outlives the child. The store's branch cursor does not move.

### The refusal ledger

By default a fork does not inherit its parent's compression-refusal ledger (what the parent declined to compress, and why): a task fork is free of its parent's refusals. `inheritRefusals: true` brings it along, for a fork that stands in for the parent's attention and must not be asked the thing the parent said no to without knowing. Either way the creation record and event state it (`inherit.refusals`), so nobody discovers the difference by being asked. Inherited entries are the parent's; the child's own refusals append after them on its branch.

The ledger is **consultable, never rendered**: it steers what the child's strategy will and will not compress, and nothing in it is placed in a compiled request. Refusal records are the most classifier-sensitive content in the pipeline, so this is part of the declaration, not something that happens to be true.

### Reusing or redoing the solve

- `solve: 'reuse'` (default): the child keeps the parent's rendering. Fold state arrives through the store. The part that lives only in memory (the previous compile's cache identities, an in-flight budget transition, a hot-tuned tail) is handed from the parent's strategy to the child's.
- `solve: 'fresh'`: the child discards the inherited frontier and solves from scratch, for example at a different budget. The rendering changes and the provider cache misses. This is a supported choice.

Any override that changes what is rendered (model, system prompt, budget, tools) has the same effect as a fresh solve on the provider cache.

### Framing and the fork point

Framing is ordinary messages added to the child before it runs. How a child is prompted is the host's: `deriveAgent` fixes nothing about it beyond appending what the caller supplies after the fork point.

While a tool call is executing, the assistant turn that made the call is not in the parent's store yet; the framework stores it when all its tool results are in. A fork made from inside a tool call is therefore derived at **the last stored message before the turn that made it** — and, by default, gets that turn back as the first thing on its own branch, so it sees the call that made it and never meets a dangling `tool_use`:

1. the parent's pending assistant turn, verbatim (text and `tool_use` blocks), stored under the parent's name like the rest of a shared inheritance (renamed in a copy), with `metadata.kind = 'dendrite-pending-round'`;
2. a tool-result message answering every call in it: results the parent has already received, as stored; the call that derived the child with `pendingRound.madeBy.result` or, by default, a note saying who it is, what kind and how long — *"This call derived fork-1. You are fork-1, a task-fork, continuing from here on your own branch. You finish your task and then end; if mira ends first you keep running, as an orphan with the same return address. mira receives this call's result, not you."* (for `onParentEnd: 'end'`: *"You end when mira does; your report returns to mira as mail under your own name; nothing you do speaks as mira."*) — the same fields the creation event names, so a fork never infers its own lifetime from context; any other call still running with a note that its result was not available when the child was made. `madeBy` defaults to the only open call when there is exactly one.

Then the caller's framing. `pendingRound: { include: false }` leaves the round out. The parent's own store is untouched; the round lands there when its results are in. `getPendingAssistantRound(name)` still returns the pending turn for hosts that want to word it themselves.

### Role assignment

Stored authorship and the role a model sees are different things. `AgentConfig` has two fields for this, both applied at request assembly only:

- `selfParticipants`: stored participants that are this agent's own voice. Their turns are presented as its assistant turns.
- `presentAs`: the participant name its turns are presented under. Default: its own name.

`deriveAgent` with shared inheritance sets `selfParticipants` to the parent (and the parent's own ancestors) and `presentAs` to the name the parent's requests use. The child's new turns are still stored under the child's name.

### Restricting a fork without losing the prefix

Removing a tool from `allowedTools` changes the tool block at the front of the request, which changes the prefix. `AgentConfig.denyToolsAtDispatch` leaves the tool advertised and refuses the call when it is made.

## The subconscious as forks

`subconscious.reader: 'forks'` replaces the persistent reader with a succession of forks of the resident. Nothing persists between invocations except what the tune-out coordinator already keeps: the epoch, its held traffic, the wake count, and the standing dispositions.

```ts
await AgentFramework.create({
  agents: [{ name: 'scout', strategy: new AutobiographicalStrategy(opts), ... }],
  subconscious: {
    enabled: true,
    reader: 'forks',
    model: 'claude-...',   // whose weights; required, never defaulted
    voice: 'You are reading for scout. Report in second person, briefly.',
    strategyFactory: () => new AutobiographicalStrategy(opts),
    forkIdleTimeoutMs: 10 * 60_000,
  },
});
```

Each cadence tick, each coalesced wake and the cancel derive one fork at the resident's head:

```ts
deriveAgent({
  name: 'reader/scout/<epoch>/<n>',
  from: 'scout', kind: 'subconscious-fork', model,
  inheritRefusals: true, onParentEnd: 'end',
  resultTo: { to: 'scout', as: 'message' },
  config: { proseRouting: 'disabled' },
  framing: [/* the notice, the reader's voice block, the dispositions, the held traffic */],
})
```

The fork has the resident's history as its own turns, the resident's refusal ledger, the resident's tool block and system prompt, and runs on the model the configuration names. It ends when its turn ends (`runEphemeralToCompletion`), or with the resident. It reports through `deliver_summary`, which becomes attributed mail: the report lands in the resident's context under the fork's name and incarnation, with `producedAt`. `cancel_tune_out` works as before (the resident gets the dump; the fork's note arrives as its own mail). `speak_in_channel` speaks under the fork's name. `set_disposition` records to the epoch; later forks see the text in their framing.

**What the fork is handed.** The held traffic is delivered as ordinary framing, each held message to exactly one fork: the coordinator keeps a per-channel cursor over the diverted backlog and each invocation gets what arrived since the last look. How that is worded is configurable: `framing(context)` receives the resident and fork names, the `voice`, the channel, epoch and trigger, the coordinator's notice, the standing dispositions and the held messages, and returns the content of the one message the fork receives after the fork point. The default, `defaultReaderFraming` (exported), writes a header, the notice (`[Tune-out wake: …]`, `[Tune-out cadence: …]`, `[Tune-out cancelled: …]`), the `voice` block, `[Standing dispositions]`, then `[Held in <channel> since your last look: n messages]` with one `author: text` line per message and media blocks preserved as the source supplied them — or `[Nothing new has been held since your last look.]`. Whatever is returned is stored on the fork's own branch with `metadata.kind = 'tune-out-reader-framing'` and the held message ids. If the resident was mid-tool-call when the invocation fired, the pending round precedes it as for any fork. The resident never sees any of it; the held originals stay out of its compiled view as before.

**Sharing the prefix.** For the fork's request to share the resident's provider-cached prefix, nothing ahead of the framing may differ. Hence: the reader's `voice` is framing rather than a system prompt, and residents are shown the reader's four tools (`deliver_summary`, `cancel_tune_out`, `speak_in_channel`, `set_disposition`) in their own tool block. A resident that calls one is refused at dispatch (`… is available to the resident's reader, not to <name>`), in the tune-out module's voice, so the refusal is a tool result and not a provider error. The persistent mode advertises nothing extra.

**Whose weights.** A fork holds the resident's whole prefix, so which model reads it is the one fact that must never be defaulted: `model` is required in this mode and `create` refuses its omission. The resident's own model makes the fork a copy of the resident — the shape the subconscious was built on, a reader that knows what is good for the resident because it is them. Another model, stated by name, makes it a stranger holding the resident's history; the framework allows that when the configuration says so, since other residents elsewhere may want it, and refuses only the silent case. Either way this mode is fork-grade under the architecture channel's 10-05 ruling: it needs the resident's named consent to the preset (kind `subconscious-fork`, the model, shared inheritance with refusals, `onParentEnd: 'end'`, `resultTo` as mail) once per configuration. The framework records every one of those fields in `dendrite:agent-created` and checks none of them against a consent; the registry is not a permission check, and the yes belongs on the operator's row. The persistent reader, with its own model and no prefix, remains the reader-grade option.

**Strategy.** A fork reuses the resident's fold state and rendering (shared inheritance), which needs a strategy instance of the same class and configuration. `strategyFactory` supplies it; `create` refuses `reader: 'forks'` for a non-passthrough resident without one rather than letting a fork fold with the wrong strategy.

**Trace.** `tune-out:reader-fork` fires per invocation with the fork's name, the channel, the epoch, the trigger (`cadence` | `wake` | `cancel`) and how many held messages it was given. `dendrite:agent-created` and `dendrite:agent-ended` fire as for any derived agent; `listAgents({ includeEnded: true })` lists the forks.

Costs are those of [Cost](#cost): one Chronicle branch and one context manager per invocation, nothing copied. A fork over a 200k-message resident derives in under a millisecond and reads its first context in about ten.

## The rendering contract

For a child with shared inheritance, reused solve and no overrides, the test `test/dendrite-derive.test.ts` compares **provider-formatted** requests (membrane's native formatter) up to the fork boundary, which is the end of the parent's last request:

- The system prompt and the tool block are identical.
- Every provider message of the parent's request appears unchanged in the child's request. In the boundary message, every block appears unchanged.
- The boundary block carries a cache marker in both requests, with the same TTL.
- The child stays within four cache breakpoints.

"Unchanged" covers the content the provider hashes. The positions of *interior* cache markers are not compared, because they differ between any two consecutive requests of one agent: each request marks the end of the previous request and its own end, and drops the marker before that. The parent's own next request would not repeat its earlier interior marker either. Issue #232 asked for byte identity including markers; that cannot hold under this marker scheme, so the contract here is content identity plus a marker on the boundary.

A second test in context-manager (`test/derive.test.ts`) checks the stronger statement where it does hold: the child's first compile is identical, markers included, to the compile the parent would have made next.

Both tests fail when the mechanism they check is disabled.

### Live acceptance

The contract was checked against the provider on 10 October 2026 with `bench/dendrite/cache-acceptance.mjs` (Claude Sonnet 5.5 through the house inference gateway; a folding resident with ~10k tokens of history, summaries written by the same model; native formatter). Uncached input was 4 tokens on every request.

| Request | cache_creation | cache_read |
|---|---|---|
| resident, first turn (writes the cache) | 10,173 | 0 |
| resident, next turn (its own reuse, the control) | 20 | 10,173 |
| **fork at the boundary, first request** | 29 | **10,193** |
| resident, a turn that blocks in a tool call | 0 | 10,230 |
| **fork derived mid-tool-call, first request** | 152 | **10,230** |

A fork's first request reads everything its parent had cached, including what the parent's latest request added, and writes only its own framing (and, mid-round, the pending round). Message cache breakpoints come from the strategy's recall ladder, so a passthrough resident caches only its system prompt and tools — for resident and fork alike; the same script shows that (1,306 / 1,306) when run without a folding strategy. The script needs `ANTHROPIC_API_KEY`, or `GATE_TOKEN` and `GATE_URL` for a gateway, and prints neither.

## Resuming and inspecting

```ts
const resumed = await framework.resumeAgent('fork-1', { model, systemPrompt, strategy: makeStrategy() });
const past = await framework.inspectAgentContext('mira', { atSequence });
const left = await framework.inspectAgentContext('fork-1');
```

- `resumeAgent` brings an ended bounded job back as a new incarnation, on the context it left: its own namespace, or its own branch. Nothing is derived again. It continues from the end of its last complete round. Configuration is not stored with an agent, so the caller supplies it; a fork's role mapping is restored from its record. Use it for a job that was stopped, failed, or was interrupted by a restart.
- `inspectAgentContext` on a live agent returns a snapshot on its own branch, at the head or at an earlier sequence. The agent is not affected by anything done to the snapshot.
- `inspectAgentContext` on an ended agent returns the context it left. This is the real context: treat it as read-only unless you intend to change what a resume starts from.

**External effects are not replayed and not undone.** A tool that ran before an agent ended has had its effect. A call that never received its result may be made again by the model after a resume.

**On record for when replay exists:** a child's stored turns, if ever read back by its parent — merged, replayed or mailed — arrive as the child's, under its name and incarnation. Mail already does this; replay must too.

## Cost

Measured with `bench/derive/derive-bench.mjs` in context-manager, on one synthetic store with messages of about 470 bytes, on an Apple-silicon laptop. These numbers compare sizes; they are not a guarantee for a mature resident store.

| | 20,000 messages | 200,000 messages |
|---|---|---|
| Create a child (`ContextManager.derive`), median of 10 | 0.8 ms | 0.5 ms |
| Child's first full read | 4.4 ms | 9.9 ms |
| Child's first append | 0.6 ms | 0.7 ms |
| Heap per additional child | 0.2 MB | 2.1 MB |
| Parent's append plus full read, with 10 children alive | 10 ms | 13 ms |
| For comparison: one cold full read of the history | about 600 ms | about 800 ms |

Creating a child does not get slower as the history grows. Its first full read does, linearly, at the same rate the parent already pays on each of its own turns: both walk the message list once.

Creating a child copies one array of references to the parent's message objects, at about 8 bytes per message. The messages themselves, their resolved media and their caller-facing views are shared.

The store-level costs underneath, from `cargo run --release --example fork_bench` in chronicle. The store has one message-like state of N items of about 500 bytes and 1,000 small states. The 0.4.0 column is the same store on the published build.

| | 20,000 items | 20,000 on 0.4.0 | 200,000 items | 200,000 on 0.4.0 |
|---|---|---|---|---|
| Fork at the head, inheriting 12 states | 3.9 µs | not available | 3.3 µs | not available |
| Fork at the head, inheriting all 1,001 states | 212 µs | 408 µs | 219 µs | 613 µs |
| Child's first read, parent warm | 2.8 µs | 33 ms | 2.8 µs | 343 ms |
| Resident memory per child that has read | 4.8 KB | 23.9 MB | 6.4 KB | 113 MB |
| Child's first append | 42 µs | 1.0 ms | 41 µs | 47 ms |
| Read right after that append | 2.4 µs | 32 ms | 2.5 µs | 372 ms |

All figures in this section are single runs on a machine that was also running builds. Treat them as orders of magnitude.

Store-level costs that still grow with the size of the state:

- A fork at an *earlier* point (`atSequence`) when a full snapshot has been written since: about 10 ms at 20,000 items and 110 to 140 ms at 200,000.
- The first read on such a historical branch: one materialization, about 25 ms and 240 ms. Forks at the head avoid both.
- A field index built for a child that has already written: about 160 ms at 200,000 items. A child that never queries history by time or channel never builds one.

Two costs are not removed:

- A child's strategy loads its fold state from the store as any strategy does at start. The parent's summaries are parsed again for the child and held a second time in memory.
- Each fork leaves its branch behind, so that it can be inspected or resumed. The framework does not delete it.

## Requirements on other packages

| Package | Needed for | Without it |
|---|---|---|
| `@animalabs/chronicle` with `JsStore.view` and `createBranchWithStates` | Shared inheritance, live snapshots | `deriveAgent` shared mode and live `inspectAgentContext` throw; everything else works |
| `@animalabs/context-manager` with `ContextManager.derive` and `reopenDerived` | The same, plus resuming a fork | The same |

The framework detects these at run time. The registry, lifecycle, attributed mail, copy inheritance and role assignment work with the published `chronicle` 0.4.0 and `context-manager` 0.13.0.

## What is not implemented

- **The admission stage.** The proposal asks for one path that decides, per recipient, whether an inbound event is captured, announced, delivered and allowed to wake, before any side effect. Only recipient selection is centralised here (`untargetedRecipients`, `gateRecipients`). The gate, the speech locus and the tune-out divert are unchanged, so the tune-out gaps listed in issue #232 remain.
- **Tune-out and focus as policies over this machinery.** The tune-out coordinator still owns epochs, the divert and the wake budget; Dendrite supplies only the reader (below) and the result route.
- **Live-follow inheritance.** Shared inheritance takes a snapshot. The persistent reader (`reader: 'persistent'`, the default) keeps its live view of the shared slot; the fork reader does not need one, since each fork is derived at the head and handed what arrived since the last look.
- **Conversation forks on shared inheritance.** They still copy. Moving them needs a decision about their existing stores.
- **Retiring multi-residency.** Residents still share one message slot.
- **Diagnostic replay** in an isolated environment.
- **Per-activation bounds** (`maxTurns`, `maxInputTokens`) are recorded and not enforced.
- **Model-facing tools** for any of this. The framework provides the API; tools belong to the host.
- **Resource accounting and write-conflict handling** between agents that share external state.
- **A loud miss for off-branch sequences in Chronicle.** `iterFrom`/`query` on a handle still scan the log from the start when the branch has no record at the requested sequence. Nothing in the fork path reads records by sequence, so a fork cannot reach it, but a direct caller on a view can.

## Choices made here

The proposal left these open. Each is a decision of this implementation and can be revisited.

1. **A fork is a Chronicle branch read through a branch-bound handle.** The alternative, an overlay in the context manager, would have re-implemented copy-on-write for eleven strategy states with in-place edits.
2. **A fork inherits the states its parent's context manager owns** (message slot, auxiliary slots, context log, the strategy's declared manifest, the mint-preimage index) and nothing else in the store.
3. **The inherited-state manifest is the strategy's to declare.** The autobiographical strategy inherits summaries, chunk records, the id counter, pins, resolutions, locks, calibration, the kv-unified receipt and the merge quarantine; it leaves the merge queue (rebuilt from inherited memory on initialize) and its compression-refusal ledger empty on the child's branch. That is the list Linn quoted from the earlier design doc's §7 in the architecture channel. Compression holds and compression work in flight are not inherited either.
4. **Running bounded jobs no longer receive untargeted broadcasts or gate wakes.**
5. **Orphans keep running by default**, and the adoption offer is a notice to the nearest live ancestor, then the primary.
6. **The default-delivery owner cannot be stopped.**
7. **The rendering contract compares content and the boundary marker, not interior marker positions** (see above).
8. **A fork presents its turns under its parent's name**, so formatters that render participant names produce the same prefix as formatters that only assign roles.
9. **Activations and policy epochs are derived from live state**, not recorded a second time.
10. **A reader fork is handed the held traffic as framing, not as a view.** Delivering each held message to exactly one fork keeps the fork's request a pure extension of the resident's and leaves the coordinator as the only holder of the backlog; the alternative, a per-fork view filter over the shared slot, would have put tune-out state into the context manager. The reader's tools sit in the resident's tool block, refused at dispatch, for the same prefix.
