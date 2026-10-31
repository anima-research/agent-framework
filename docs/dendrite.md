# Dendrite: one registry, lifecycle and fork primitive for agents

Dendrite replaces four separate ways of making an agent (resident, subconscious, conversation fork, ephemeral subagent) with common machinery. Each of those is now a preset over one registry, one lifecycle and one way to derive a context.

This page describes what the framework implements. It follows the Dendrite proposal (revision 2, 6 October 2026) and [issue #232](https://github.com/anima-research/agent-framework/issues/232). The proposal is not an approved specification; [What is not implemented](#what-is-not-implemented) and [Choices made here](#choices-made-here) say where this implementation stops and where it had to decide.

## The model

Three things are kept apart:

- **Identity and lifetime.** What persists across runs: the name, the context the agent owns, its relationships. An identity has an *incarnation* number, which goes up each time it is instantiated.
- **Activation.** One bounded run. `listActivations()` reports each run in flight and the agent that owns it.
- **Policy epoch.** A tune-out interval. Ending an epoch ends neither an agent nor a task. `listPolicyEpochs()` reads epochs from the tune-out coordinator's own state; the registry does not keep a copy.

### Roles

These roles, not `kind`, decide where a message with no named recipient goes, which agents untargeted traffic and the host-wide gate wake, and who holds the provider gate. `kind` selects behaviour for two of its values, and derivation notices are counted per kind, below.

| Role | Meaning |
|---|---|
| `defaultDelivery` | A message with no named recipient goes to this agent. Exactly one agent has it. |
| `receivesUntargeted` | Woken by a module's `requestInference: true`, by a channel message or push event that names no agents, and as a default reader of a coalesced occurrence. |
| `receivesGateWakes` | Woken by the host-wide gate (debounce batches, sleep expiry). |
| `ownsProviderScheduling` | Holds the provider gate and owns rate-limit cooldowns. |

`kind` (`resident`, `subconscious`, `subconscious-fork`, `conversation-fork`, `task-fork`, `worker`, or any string) labels an agent for discovery, and the framework also selects by two of its values. An agent registered as `subconscious-fork` is a reader fork, which may call only its reader's tools (`deliver_summary`, `cancel_tuneout`, `note_disposition`), and `speak_in_channel` where `subconscious.allowChannelSpeech` allows it, whatever its `allowedTools` says. A `denyToolsAtDispatch` entry it takes from its resident's configuration still refuses the tool it names. The agents registered as `conversation-fork` are the ones `stop()` unbinds from their home channels and disposes, and the ones the cleanup after a context manager reinitializes disposes when their context is left empty. Whatever its value, `kind` also groups derivation notices for collapsing ("The source is told", below).

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
framework.listAgents({ includeEnded: true });   // live, and the newest 256 ended
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

The `dendrite:agent-created` trace names the kind, the model (whose weights), the context source (whose context), the lifetime and the `onParentEnd` policy at creation. The framework attaches no semantics to a derivation beyond its mechanics — no consent model, no rule about what a mind must be asked or told. What it offers a host that wants one is generic: `dendrite.beforeDerive(spec)` says yes or no, with a reason, to each agent `createEphemeralAgent` makes, derivations included, before the agent exists, and to each `resumeAgent` before its new incarnation exists; `dendrite.derivationNotice(record, from, defaultText)` decides what, if anything, the source is told; a record's `metadata` carries whatever the host records; `AgentConfig.denyToolsAtDispatch` narrows what a derived agent can do while its tool block stays the parent's; `ForkReaderConfig.framing` decides what a reader fork is told; and a module can offer tools. A consent flow — a recorded yes, a check that the configuration is the one agreed, a way to take the yes back — is a module built on these, not the platform's (architecture channel, 2026-10-19: semantics live outside the platform, so it can serve uses not yet imagined).

**The source is told only when the host asks.** A derivation puts nothing in the context of the agent it was derived from unless the host passes `dendrite.derivationNotice` (above) and that returns text. The hook is given the framework's own line, built from the same facts as the trace — `[Agent lifecycle: fork-1 was derived from you as a task-fork on your weights (claude-…), with a copy of your context; its result returns to you as a message; it ends when its task does (idle 15 min), and is orphaned if you end.]` — and returns that line, its own, or `null` for none; what it returns is stamped `kind: 'agent-lifecycle'` with the record's fields under `dendrite`. A resumption's line says so (`was resumed (incarnation 2)`); a conversation fork's says which channel it speaks in; a fork on another model's names it instead of "your weights". It requests no wake. Text about an agent's own body or mind isn't the framework's to add by default: a host that wants its agents told says so. The `dendrite:agent-created` trace is emitted either way. Both derivation paths announce after the fork's branch or copy exists, so a fork never inherits the notice about itself; a source that has ended is told nothing. For `subconscious.reader: 'forks'` that would be one line per invocation, and a reader loop can fork a hundred times in a session; so after `dendrite.collapseDerivationNoticesAfter` derivations of one kind from one agent (default 10; 0 never collapses) the hook is given a count line every so many instead — `[Agent lifecycle: 20 subconscious-forks have been derived from you since 14:02 UTC (10 since the last note); the latest, reader-20, is a subconscious-fork on your weights …]`, stamped `dendrite.collapsed: { count, sinceLastNote }` — while every derivation still emits its `dendrite:agent-created` trace, and `getAgentRecord(name)` finds any agent that ended, from the ended log (`listAgents({ includeEnded: true })` lists the newest 256).

### After a restart

A host's `stop()` does not end bounded work it cuts off: a fork or job still running when the host stops is left live in the registry snapshot (traced `dendrite:agent-interrupted`, reason `host-stop`), so the next boot ends it as `host-restart` and tells its result recipient — the same as a crash. Before this, `stop()` ended the record as finished or failed and the restart had nothing to report (first live run, 2026-10-12, finding D). Traces emitted during `create()` (restore, interrupted work, resumed epochs) are replayed to a listener that asks for them — `onTrace(listener, { replay: true })` — since every host attaches its sinks after `create()` returns. The buffer keeps the first 1,000; when there were more, the replay ends with one `dendrite:early-traces-dropped` event naming how many it didn't keep. The buffer is dropped at `start()`.

- Persistent agents are re-created by configuration, as a new incarnation.
- Every other agent that was live is recorded as ended with reason `host-restart`. If its result route is a message, the recipient is told once that it ended without a result.
- A persistent agent that the configuration no longer declares is ended with reason `not-configured`.
- Results held from before the restart are delivered, once.

## Messages and results

```ts
framework.sendAgentMessage('oren', 'mira', [{ type: 'text', text: 'the build is green' }]);
framework.deliverAgentResult('fork-1', [{ type: 'text', text: result.speech }], { causedBy: ['task-7'] });
```

Both put the sender's content in the recipient's context **under the sender's own name**. The one exception is a recipient that counts the sender as its own voice without being the sender, as a shared fork counts its parent: there the mail is stored under `<sender> (mail)`, such as `mira (mail)`, so no request presents it as the recipient's own turn. `metadata.dendrite` carries the sender's name and incarnation, the mail id, the causal chain, and `producedAt`, when the sender produced it, so a result that arrives late reads as mail from then rather than as the present. Nothing is inserted into the recipient's own voice.

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

The child's writes go to a Chronicle branch of its own, which its record names as `inherit.ownBranch`: `dendrite/<name>`, or `dendrite/<name>~2`, `~3` and so on when the store already has a branch by that name, as one an earlier process's child of the same name left. That branch outlives the child. The store's branch cursor does not move.

### The refusal ledger

By default a fork does not inherit its parent's compression-refusal ledger (what the parent declined to compress, and why): a task fork is free of its parent's refusals. With shared inheritance, `inheritRefusals: true` brings it along, for a fork that stands in for the parent's attention and must not be asked the thing the parent said no to without knowing. Either way the creation record and event state it (`inherit.refusals`), so nobody discovers the difference by being asked. A copy brings no ledger, so a copy derivation refuses `inheritRefusals: true` before anything is made. Inherited entries are the parent's; the child's own refusals append after them on its branch.

The ledger is **consultable, never rendered**: it steers what the child's strategy will and will not compress, and nothing in it is placed in a compiled request. Refusal records are the most classifier-sensitive content in the pipeline, so this is part of the declaration, not something that happens to be true.

### Reusing or redoing the solve

- `solve: 'reuse'` (default): the child keeps the parent's rendering. Fold state arrives through the store. The part that lives only in memory (the previous compile's cache identities, an in-flight budget transition, a hot-tuned tail) is handed from the parent's strategy to the child's.
- `solve: 'fresh'`: the child discards the inherited frontier and solves from scratch, for example at a different budget. The rendering changes and the provider cache misses. This is a supported choice.

Any override that changes what is rendered (model, system prompt, budget, tools) has the same effect as a fresh solve on the provider cache. `solve` is for shared inheritance: a copy derivation refuses it before anything is made.

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

### The author's name

A channel message is stored as the model reads it: `author: body`. MCPL's `channels/incoming` carries the author as a field — `author: {id, name}` — and the body alone as content; the framework stores it under the anonymous participant `user` with the author in `metadata.author`. The wire formatter writes the participant, and the compiled view carries no metadata, so a body stored bare reached the model as `user: <text>` with the author nowhere, while a release's backlog lines, which read the metadata, named it (first live run, Weft's isolation, 2026-10-13). The rule, `presentAuthor` (exported): a message stored under `user` that names an author has the name written before its first text block — or, with no text block, as a leading `Name:` line before its media — unless the text already begins with `Name:`. A server that renders the name into the text itself (portal-mcpl does) is left as it is, so the name appears once whichever shape a server sends. Backlog lines follow the same rule (`authorLine`), so such a server's messages are no longer shown as `Name: Name: body`.

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
  from: 'scout', kind: 'subconscious-fork',
  inheritRefusals: true, onParentEnd: 'end',
  resultTo: { to: 'scout', as: 'message' },
  config: { model, proseRouting: 'disabled' },
  metadata: { epochId, channelId, trigger },
  framing: [/* the notice, the reader's voice block, the dispositions, the held traffic */],
})
```

The fork has the resident's history as its own turns, the resident's refusal ledger, the resident's tool block and system prompt, and runs on the model the configuration names. It ends when its turn ends (`runEphemeralToCompletion`), or with the resident. It reports through `deliver_summary`, which becomes attributed mail: the report lands in the resident's context under the fork's name and incarnation, with `producedAt`. The report is the fork's whole job, so a fork that ends in plain prose without calling the tool has still reported: its final prose is delivered as its report by the same route, traced `tune-out:reader-prose-delivered` (first live run, 2026-10-12, finding A — a fork that judged correctly and answered in prose lost the whole report to `proseRouting: 'disabled'`). A fork that did call the tool does not report its trailing prose again. `cancel_tuneout` works as before (the resident gets the dump; the fork's note arrives as its own mail). `speak_in_channel` posts through the resident's own publish path: the channel sees the post under the resident's account, in the fork's words; nothing in the `channels/publish` request names the fork. Both act only through the hold of the epoch the fork was derived to read, the `epochId` on its record: a fork's cancel of another hold is refused, and so is its post into a channel that hold doesn't hold, once that hold has ended included; a fork whose record has no epoch is refused both. The check is made when the call is made, so a post admitted before the hold ends may finish after it, with its ordinary delivery result. Its reports, `deliver_summary` and `note_disposition`, stay open to it. With `allowChannelSpeech` off, a reader fork can post nowhere — every tool but its own three is refused at dispatch, while the block it is shown stays the resident's for the shared prefix (scout's condition for a future yes, 2026-10-19). `note_disposition` records a standing note under a key, stored for the resident rather than the epoch (as coordinator state `subconscious/<resident>/dispositions`); later forks see the text in their framing.

**What the fork is handed.** The held traffic is delivered as ordinary framing, each held message to exactly one fork: the coordinator keeps a per-channel cursor over the diverted backlog and each invocation gets what arrived since the last look. That includes what is still queued behind a resident turn that is running: while the resident's turn runs, what arrives for it waits in the deferred queue rather than its store, and that is when a reader is most useful. A queued message is handed with its deferred write's id; the coordinator records the ids it hands out, and once such a write lands, its stored row (which carries the id as `metadata.deferredWriteId`) is not handed again. A fork that never reads what it was handed (its framing, derive or run throws before it reports) gives it back while the epoch still holds the channel, and the next invocation for the channel is handed it (`tune-out:reader-fork-failed`). A channel here is its server and id, since two servers can register the same id. How that is worded is configurable: `framing(context)` receives the resident and fork names, the `voice`, the channel, epoch and trigger, the coordinator's notice, the standing dispositions and the held messages (`backlog`, the queued ones last, with held handles for ids and provisional sequences; `queuedCount` says how many), and returns the content of the one message the fork receives after the fork point. The default, `defaultReaderFraming` (exported), writes a header, the notice (`[Tune-out wake: …]`, `[Tune-out cadence: …]`, `[Tune-out cancelled: …]`), the `voice` block, `[Standing dispositions]`, then `[Held in <channel> since your last look: n messages]` with one `author: text` line per message and media blocks preserved as the source supplied them, the queued ones after a note that they arrived while the resident's turn was running and are not stored yet — or `[Nothing new has been held since your last look.]`. Whatever is returned is stored on the fork's own branch with `metadata.kind = 'tune-out-reader-framing'` and the held message ids (a queued message's is its held handle, `heldHandle(writeId)`, as module rows name it). If the resident was mid-tool-call when the invocation fired, the pending round precedes it as for any fork. The resident never sees any of it; the held originals stay out of its compiled view as before.

**Sharing the prefix.** For the fork's request to share the resident's provider-cached prefix, nothing ahead of the framing may differ. Hence: the reader's `voice` is framing rather than a system prompt, and residents are shown the reader's four tools (`deliver_summary`, `cancel_tuneout`, `speak_in_channel`, `note_disposition`) in their own tool block, unless their `allowedTools` leaves them out; then the resident's reader forks aren't shown them either, and can still report through their final prose. A resident that calls one is refused at dispatch (`… is available to the resident's reader, not to <name>`), in the tune-out module's voice, so the refusal is a tool result and not a provider error. The persistent mode advertises nothing extra.

**Whose weights.** A fork holds the resident's whole prefix, so which model reads it is the one fact that must never be defaulted: `model` is required in this mode and `create` refuses its omission. The resident's own model makes the fork a copy of the resident — the shape the subconscious was built on, a reader that knows what is good for the resident because it is them. Another model, stated by name, makes it a stranger holding the resident's history; the framework allows that when the configuration says so, since other residents elsewhere may want it, and refuses only the silent case. Either way this mode is fork-grade under the architecture channel's 10-05 ruling, which for Connectome's residents asks the resident's named consent to the preset (kind `subconscious-fork`, the model, shared inheritance with refusals, `onParentEnd: 'end'`, `resultTo` as mail) once per configuration. Whether a deployment asks that, and how, is its own: the framework records every one of those fields in `dendrite:agent-created`, offers `dendrite.beforeDerive` to a host that gates on them, and checks none of them against a consent itself; the registry is not a permission check, and the yes belongs on the operator's row or in a consent module's record. The persistent reader, with its own model and no prefix, remains the reader-grade option.

**Strategy.** A fork reuses the resident's fold state and rendering (shared inheritance), which needs a strategy instance of the same class and configuration. `strategyFactory` supplies it; `create` refuses `reader: 'forks'` for a non-passthrough resident without one rather than letting a fork fold with the wrong strategy.

**Trace.** `tune-out:reader-fork` fires per invocation with the fork's name, the channel, the epoch, the trigger (`cadence` | `wake` | `cancel`) and how many held messages it was given (`held`, of which `queued` were still queued). `tune-out:reader-fork-failed` fires for a fork that threw, with whether it had reported and how many messages it gave back (`returned`). `dendrite:agent-created` and `dendrite:agent-ended` fire as for any derived agent; `listAgents({ includeEnded: true })` lists the forks.

Costs are those of [Cost](#cost): one Chronicle branch and one context manager per invocation, nothing copied. A fork over a 200k-message resident derives in under a millisecond and reads its first context in about ten.

## Admission

Every inbound channel event — a `channels/incoming` message or a `push/event` — passes one admission decision before anything acts on it (`src/admission/admit.ts`, called from both lanes in the framework). The decision answers the proposal's five questions once:

| Question | Decided as |
|---|---|
| Is it captured? | Always. It is stored where it arrived, in the shared slot. |
| Who may receive it? | The event's explicit targets, else the untargeted recipients. |
| Body or hold? | A hold if a policy epoch (today: tune-out) is in force over the channel. A held message carries the record on itself, `metadata.tuneOut = { epochId }`, and is excluded from every resident's view by that record. |
| May it wake them? | Not when held or vetoed by the server. Otherwise the wake gate decides, and it is consulted here, after the hold — so a held message never forms a debounce batch, never advances a counter. For a held message the gate is only *probed* (side-effect free), and that verdict is handed to the hold's reader as a precondition: a message the gate would have muted does not wake the reader either. |
| Where may speech go? | A held message never counts as "the latest delivered inbound". Under the default `speech.locus: 'delivery'` nothing inbound sets a locus for a later turn at all (below). |

Everything downstream reads the decision: the two lanes store and wake from it, the compiled view and the mid-turn injection use the same `heldFromResidents` predicate, and the channel registry learns of a delivered message through `noteDelivered` instead of deciding at ingestion. A tool close of a tuned-out channel is refused and leaves the tune-out in place, since its cancel is what releases the held traffic; a tool close of the channel an all-except hold excepts ends that hold through the cancel flow. The gate's batch delivery re-checks the hold, since an epoch can begin after an event was batched. The decision is traced as `admission:decided`.

What it closes from issue #232 §2: gaps 1 (a DM can be tuned out: the push lane is admitted too), 2 (held traffic never moves the locus), 3 (no debounce wake for held mentions), 4 (a release names non-text blocks), 5 (no mid-turn injection of held messages), 6 (a release left in the deferred queue is durable and re-wakes the resident at boot), 7 (deferred held messages are in the release), 8 (server-qualified channel resolution; ambiguity is an error), 9 (`channel_close` on a tuned-out channel is refused, and the tune-out's cancel releases), 10 (the hold machinery runs without a reader) and 11 (the truncation note names a history tool the resident has, or none). Gaps 1 to 10 each have a regression test in `test/admission-e2e.test.ts`, on the loopback MCPL server, and gap 11's is in `test/tune-out-dump-fit.test.ts`.

### The speech locus

`FrameworkConfig.speech.locus` chooses where a turn's plain prose goes when nothing names a destination.

- `'delivery'` (the default) is the §3 carve-out the residents accepted in the architecture channel on 2026-10-06: the locus comes only from the delivery that woke the turn, a conversation fork's home channel, or a channel the agent opened during the turn. Incoming traffic never moves it — not between turns, and not mid-turn either. An addressed message injected during a turn from another channel is announced in the same injection batch — `[routing] <author> addressed you from <channel> while you were busy. Your plain speech still lands in <locus> this turn; reaching them takes an explicit send.` — once per channel per turn, because a neutral message carries nothing that names its channel (first live run, 2026-10-12, finding C). A turn with no such locus keeps its prose private. When the locus the agent was last told of was a channel, a `[routing]` notice tells it its speech now has none; an agent never told of a channel isn't told this. The same holds for a message that lands between a turn's streams — during a provider-capacity hold, before a re-inference on tool results, or drained at an over-budget boundary (an *arrival*, in the turn-routing sense of 0.22.1): it moves nothing, and if it addressed the agent from another channel the next start of the turn announces it with the same notice, naming which start it is — `while your turn waited on a provider hold`, `before this re-inference on your tool results`, `at your budget restart`, `while your turn was retried` — since from inside they look alike and the reason says whether the earlier prose landed (Linn, 2026-10-14). `channel_publish` without a `channelId`, made inside the turn, goes where the turn's plain speech would — the frozen turn locus, so the waking delivery's channel or one opened this turn — and is refused when its server no longer registers it. A `serverId` given with no `channelId` names the locus's id on that server, as the registry reads one given beside its own default. A turn with no locus takes its home channel if it's a conversation fork, else its trigger channel where it has one, as a turn under explicit or disabled prose routing does, since it never resolves a locus. Past those, a turn with no channel by design (`noChannel`, or a heartbeat) takes nothing, and so does an ephemeral agent's turn (one `createEphemeralAgent` or `resumeAgent` made, derivations included); any other turn takes the registry's default, as a call outside the turn does. One made outside the turn, as a script left running after it makes, takes none of the turn's channels: a conversation fork's goes to its home channel, an ephemeral agent's to none, and anyone else's takes the registry's default, which under this rule is the all-except hold's excepted channel while one is open, and none otherwise.
- `'latest-inbound'` restores the previous rule: the most recent delivered inbound message is a global fallback locus, an addressed mid-turn injection re-pins the turn, and so does an arrival at the turn's next start (the 0.22.1 rule, kept whole under this flag).

Under both rules a held message is never "the latest inbound".

### Tune-out without a reader

The tune-out coordinator exists whenever MCPL channels do. With a reader (the persistent subconscious or reader forks) it summarizes on a cadence and wakes the reader on addressed traffic. Without one a tune-out is a *silent hold*: nothing summarizes, nothing wakes, suppressed mentions are still acknowledged, and the backlog is released on cancel; the tool result says so. A persisted epoch is therefore always resumed and released, whatever the configuration (gap 10). Residents are offered `tune_out` when a reader is configured or `tuneOut.enabled` is set.

### What a release is

A release is a system-framed notice with the count, the channel and the epoch, then the held messages up to `backlogCap` as `author: text [image] …` lines in block order, then the reader's report under the reader's own name. Messages still in the deferred queue (held while a turn was alive) are included. Above the cap the note names the history tool the resident actually has, or says the rest was not delivered. The release is made durable before the cancel returns.

### The all-except scope

`tune_out` with `scope: 'all-except'` — or its alias `focus` — holds every channel except `channelId`, for `durationSeconds` (mandatory: the scope always ends on its own). It is a resident-level policy epoch, not a per-channel state, so it covers DMs and channels registered after entry: admission's hold lookup asks "is this the exception?", not "is this channel marked?". While it holds, a turn with no delivery of its own speaks into the excepted channel (nissa's reply order: explicit target, waking delivery, focus destination, otherwise private). `mode: 'check'` reports the held count per channel and, with `peek`, one channel's newest held lines without releasing anything — only lines of the epochs holding that channel now; a released epoch's messages were delivered and are not shown as held (finding B of the first live run: peek is the resident's own gauge, and a gauge that shows released traffic as held is a false declaration). Release is one notice with a per-channel backlog, each capped by `backlogCap`.

The excepted channel hears the door shut. On entry one bracketed line is posted there under the resident's name — `[Focus: mira is here for 30 min, until 19:30 UTC; other channels are held meanwhile.]` — and one on release — `[Focus: mira released — duration elapsed.]`. The held channels hear nothing; a suppressed mention there is acknowledged as before. This is on by default (`tuneOut.announce: false` turns it off): a hold the room cannot see is the failure the scope exists to prevent (Linn, 2026-10-12, on having built the same thing by hand and been rightly caught). The tool result names the channel as `announcedIn`; the outcome is traced as `tune-out:announced` or `tune-out:announce-failed`, never awaited by the epoch flip. The wording is fixed and is a notice, not the resident's speech.

Decisions carried from issue #232 and the discussion: a per-channel epoch takes precedence over the scope (its own cadence, budget and stamp); the excepted channel cannot be tuned out, and a tuned-out channel cannot be the exception; the reader keeps its latitude and may end the scope (`cancel_tuneout` on a held channel, or `scope: 'all-except'`); exhausting the reader's wake budget *pauses* reader wakes and leaves the hold in force (traced as `tune-out:wake-budget-paused`); wakes already queued before entry still run; without a reader it is a silent hold; `focus` stays as the alias; closing the excepted channel ends the scope. The record lives in the coordinator's snapshot slot (`tune-out/<resident>/all-except`) and appears in `listPolicyEpochs()` as a tune-out epoch with `scope: { kind: 'all-except', except }`. A scope whose deadline passed while the process was down is released at resume; if that release fails before the scope's end is recorded, the scope stays in force and its release is tried again a minute later; one that fails after its end leaves the scope ended, with no retry.

### Not here

The per-recipient exposure model of nissa's household's proposal (an inbox outside recipient slots, `attention`/`inline` per channel per recipient, overlays) and the mention autoreply (#232 §3.4) are not built. Admission here decides per *slot*: residents share one message slot, so a hold applies to all of them, and a reader of the slot sees held traffic through its own view. The structure is the one those designs need — one decision, consumed downstream — so they are additions to the policy inputs, not another path.

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

A fork's first request reads everything its parent had cached, including what the parent's latest request added, and writes only its own framing (and, mid-round, the pending round). The read counts grow between requests because the prefix grows, not because more than was cached is reused. Reuse follows the cache markers the strategy actually emits: of the two strategies tested, the autobiographical strategy marks messages (through its recall ladder) and the passthrough strategy marks none, so a passthrough resident caches only its system prompt and tools — for resident and fork alike; the same script shows that (1,306 / 1,306) when run without a folding strategy. This is builder-measured evidence for that model, route and setup; larger stores and other models are separate acceptance cases. The script needs `ANTHROPIC_API_KEY`, or `GATE_TOKEN` and `GATE_URL` for a gateway, and prints neither.

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

The framework detects these at run time.

## What is not implemented

- **Per-recipient exposure.** Admission decides per shared slot, not per recipient (see [Admission](#admission)); the inbox, the `attention`/`inline` settings and overlays of nissa's household's proposal are not built.
- **The mention autoreply** (#232 §3.4). The tune-out coordinator still owns epochs and the wake budget; Dendrite supplies the admission decision, the reader and the result route.
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
3. **The inherited-state manifest is the strategy's to declare.** The autobiographical strategy inherits summaries, chunk records, the id counter, pins, resolutions, locks, calibration, the kv-unified receipt and the merge quarantine; it leaves the merge queue (rebuilt from inherited memory on initialize) empty on the child's branch, and its compression-refusal ledger too unless the derivation passes `inheritRefusals: true` (above). That is the list Linn quoted from the earlier design doc's §7 in the architecture channel. Compression holds and compression work in flight are not inherited either.
4. **Running bounded jobs no longer receive untargeted broadcasts or gate wakes.**
5. **Orphans keep running by default**, and the adoption offer is a notice to the nearest live ancestor, then the primary.
6. **The default-delivery owner cannot be stopped.**
7. **The rendering contract compares content and the boundary marker, not interior marker positions** (see above).
8. **A fork presents its turns under its parent's name**, so formatters that render participant names produce the same prefix as formatters that only assign roles.
9. **Activations and policy epochs are derived from live state**, not recorded a second time.
10. **A reader fork is handed the held traffic as framing, not as a view.** Delivering each held message to exactly one fork keeps the fork's request a pure extension of the resident's and leaves the coordinator as the only holder of the backlog; the alternative, a per-fork view filter over the shared slot, would have put tune-out state into the context manager. The reader's tools sit in the resident's tool block, refused at dispatch, for the same prefix.
11. **The hold record lives on the message.** A held message is stamped at admission (`metadata.tuneOut`) and excluded from residents' views by that stamp; no second corpus and no separate delivery flag mirrors it (antra, architecture channel: recipient-state membership records delivery). Nothing is retro-inserted on release.
12. **A debounce verdict counts as "would wake"** when the gate is probed for a held message, so a mention in a debounced, tuned-out channel still reaches the reader. The old order (gate before hold) returned false for it, which is what gap 3 observed.
13. **`speech.locus` defaults to `'delivery'`**, the §3 carve-out, with `'latest-inbound'` to restore the previous rule — including the mid-turn addressed re-pin, which was ratified separately and is kept under that rule only.
