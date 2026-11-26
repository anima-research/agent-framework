# Experimental main-refusal bridge

This experimental, optional API hands main-refusal reaction ownership to a host.
Omission retains the built-in Discord reaction (including its category map and
no removal), targeting the per-turn answer rather than the latest inbound
message. Provider retry policy and the ops refusal-streak threshold are unchanged.

`framework.getMainRefusalBridge()` returns a version-1 narrow facet:

- `takeOwnership(handler)` replaces **all** framework-owned refusal reactions for
  that framework. Only one owner is allowed. The returned disposer restores
  legacy ownership. Ownership is never inferred from server configuration.
- The handler receives a frozen `MainRefusal`: agent name, process-local agent
  instance identity, logical turn id, category, frozen answer provenance if known,
  and `rewind: 'handled' | 'unhandled'`. Only the latter may produce a reaction.
- `isCurrent(signal)` rejects a removed/replaced agent instance.
- `serverBinding(id)` returns the current binding; hosts must compare it with `signal.origin.binding`;
  `serverEpoch(id)` identifies the config **object** plus connection **object**
  within this process. It is not a transport epoch, child PID, reconnect detector,
  or security/realm/executable attestation. Automatic in-place crash/reconnect
  keeps these objects and this identity even when `transportEpoch` and the child
  PID change. Object replacement (for example `restartMcplServer`, including
  deploy/restart, or disconnect+connect) changes the identity instead.
  Neither value is a published provenance link or a persistent identity.

The signal is made only on the main stream's final refusal path, after membrane
has exhausted any retries enabled for that attempt (none during guarded tool-result recovery) and after the existing rewind decision. A
handled rewind is reported without an effect; its retry keeps the original
origin. Auxiliary `complete()` calls and ephemeral agents in `run` mode do not enter
this handoff. Ephemeral conversations do enter it, matching legacy behavior.

## Origin, not cause

The bridge derives its origin from the same per-turn `routing.answers` /
`answersMessageId` used by the built-in reaction. The private admission mark
only enriches that answer with endpoint binding and thread provenance; it
cannot select a different message. These fields come from the trusted ingestion
envelope, not message text, event UUIDs, channel_open, or `incomingFor`.

Direct message wakes (including wake onboarding) can name a message. An ambient
tag does not negate a real wake. Gate batches — debounced, judged, or deferred —
answer no single message, **even a singleton batch**. This includes a judged
event answered while judging: moving its placement from `after` to `named`
does not turn the batch into a direct-message wake.
A merged wake has no trusted origin unless every cause names the same
admitted message within the same scope. Nonmessage markers, context-only
traffic, and heartbeats supply no target. An edit counts only on an admitted
first view. A merged start released from a provider hold can recover its
original answer and origin even if an additional wake folded into it during
the hold would have made them ambiguous.

An open turn keeps its answer despite new inbound messages, locus moves, and
provider/framework continuations. Rewind retries carry provenance from the
same answer as the built-in reaction. Automatic refusal rewinds use the refused
turn; a new unstick run or inference-failure rewind uses only the unfinished
channel turn, not a completed or abandoned one. A new inbound wake merged with
a retry can clear the answer. An exhausted turn re-armed in the answer channel
keeps the provenance; one re-armed to speak in another channel clears it and
neither owner path marks the old message there.

Restored/foreign requests without trusted admission provenance can name an
answer for internal routing but cannot supply the bridge's endpoint binding;
their bridge origin remains unknown. There is no reconstruction from stored
text or the latest channel. This reports the message answered, not the culprit
or cause of a refusal. The main completion captures the answer before
reset/settlement/terminal traces; later host work never looks up a newer target.

## Failure semantics

A host owner's failure is logged and contained. It neither falls back to legacy
reactions nor requests inference. The existing `ops:alert` of kind `refusal`
starts at streak two, independently of this handoff. Hosts own their effect and
deduplication policies; this API promises neither exactly-once effects nor
durable cross-process/cross-host deduplication.
Disposing restores legacy ownership but cannot retract an already issued effect.
