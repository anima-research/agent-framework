# Experimental main-refusal bridge

This experimental, optional API hands main-refusal reaction ownership to a host.
Omission preserves the existing Discord special case (including its category
map, last-resort behavior and no removal). Provider retry policy and the ops
refusal-streak threshold are unchanged.

`framework.getMainRefusalBridge()` returns a version-1 narrow facet:

- `takeOwnership(handler)` replaces **all** framework-owned refusal reactions for
  that framework. Only one owner is allowed. The returned disposer restores
  legacy ownership. Installing a Zulip driver does not imply this handover.
- The handler receives a frozen `MainRefusal`: agent name, process-local agent
  instance identity, logical turn id, category, frozen admission origin if known,
  and `rewind: 'handled' | 'unhandled'`. Only the latter may produce a reaction.
- `isCurrent(signal)` rejects a removed/replaced agent instance.
- `serverBinding(id)` checks the original inbound source's endpoint binding;
  `serverEpoch(id)` identifies the config **object** plus connection **object**
  within this process. It is not a transport epoch, child PID, reconnect detector,
  or security/realm/executable attestation. Automatic in-place crash/reconnect
  keeps these objects and this identity even when `transportEpoch` and the child
  PID change. Object replacement (for example `restartMcplServer`, including
  deploy/restart, or disconnect+connect) changes the identity instead.
  Neither value is a published provenance link or a persistent identity.

The signal is made only on the main stream's final refusal path, after membrane
has exhausted its provider retries and after the existing rewind decision. A
handled rewind is reported without an effect; its retry keeps the original
origin. Auxiliary `complete()` calls and ephemeral agents in `run` mode do not enter
this handoff. Ephemeral conversations do enter it, matching legacy behavior. Provider retry execution itself is membrane's responsibility; mock
stream tests do not qualify a real provider.
Auxiliary exclusion is source-reviewed (the signal is only in the main final
stream branch), not behavior-proven by a direct call to a mock's `complete()`.

## Origin, not cause

The framework takes an opaque message reference, server/endpoint binding,
channel, and thread (if supplied) from its trusted ingestion envelope, **not** from
message text, event UUIDs, routing winners, channel_open, or `incomingFor`.
Direct wake branches use the actual admission decision. An ambient tag does not
negate a real wake. Debounced/judged gate deliveries merge private admission
marks over **all** batch events, independently of the gate's speech-locus winner
(subject to the missing-provenance limitations below).
Exactly one distinct known eligible scoped message can be named; two distinct
messages or any unknown cause are ambiguous. Duplicate delivery of the same
scoped message is one. Nonmessage markers, context-only traffic, and heartbeats
cannot supply an effect target. An edit counts only on an admitted first view.

An open turn keeps its snapshot despite new inbound messages, locus moves,
resumes and provider/framework continuations. The main completion captures its
agent/instance/turn snapshot before reset/settlement/terminal traces. Later
reaction work does not look up a newer target.

Conservative limitations: restored/foreign wakes without the private admission
mark, deferred RFC-006 batches whose content is materialized at assembly rather
than delivered as a marked wake, and incomplete gate provenance are unknown.
Two additional paths currently lose the mark and therefore report unknown:
wake onboarding, and judged events answered while judging (their placement moves
from `after` to `named`, which the origin merge does not read).
These are documented limitations, not changes to the origin model; reconciling
that model with the per-turn answer model in #947 remains an owner decision.
There is no reconstructed origin from stored text or the latest channel. This
reports request processing status, not the culprit or cause of a refusal.

## Failure semantics

A host owner's failure is logged and contained. It neither falls back to legacy
reactions nor requests inference. The existing ops home notice starts at streak
two, independently of this handoff. Hosts own their effect and deduplication policies; this API promises
neither exactly-once effects nor durable cross-process/cross-host deduplication.
Disposing restores legacy ownership but cannot retract an already issued effect.
