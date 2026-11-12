# Local main-refusal handover prototype

This is an unreleased, optional companion API for connectome-host. It changes no
package versions, dependencies, provider retry policy, routing, CM purpose
classification, or ops refusal-streak threshold. Omission preserves the existing
Discord special case (including its category map, last-resort behavior and no
removal). It is not a new incident service or general host executor.

`framework.getMainRefusalBridge()` returns a version-1 narrow facet:

- `takeOwnership(handler)` replaces **all** framework-owned refusal reactions for
  that framework. Only one owner is allowed. The returned disposer restores
  legacy ownership. Installing a Zulip driver does not imply this handover.
- The handler receives a frozen `MainRefusal`: agent name, process-local agent
  instance identity, logical turn id, category, frozen admission origin if known,
  and `rewind: 'handled' | 'unhandled'`. Only the latter may produce a reaction.
- `isCurrent(signal)` rejects a removed/replaced agent instance.
- `serverBinding(id)` checks the original inbound source's endpoint binding;
  `serverEpoch(id)` additionally identifies the current config/connection within
  this process. Replacing either requires a new handover/preflight. Neither is a
  published provenance link or a persistent identity.

The signal is made only on the main stream's final refusal path, after membrane
has exhausted its provider retries and after the existing rewind decision. A
handled rewind is reported without an effect; its retry keeps the original
origin. Auxiliary `complete()` calls and ephemeral/subagent runs do not enter this
handoff. Provider retry execution itself is membrane's responsibility; mock
stream tests do not qualify a real provider.

## Origin, not cause

The framework takes an opaque message reference, server/endpoint binding,
channel, and thread (if supplied) from its trusted ingestion envelope, **not** from
message text, event UUIDs, routing winners, channel_open, or `incomingFor`.
Direct wake branches use the actual admission decision. An ambient tag does not
negate a real wake. Debounced/judged gate deliveries merge private admission
marks over **all** batch events, independently of the gate's speech-locus winner.
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
There is no reconstructed origin from stored text or the latest channel. This
reports request processing status, not the culprit or cause of a refusal.

## Failure semantics

A host owner's failure is logged and contained. It neither falls back to legacy
reactions nor requests inference. For the first refusal with unknown origin or
unsupported driver the companion host logs a local diagnostic only: the existing
ops home notice starts at streak two and is **not** first-refusal home coverage.
The host owns bounded ADD-only dedup/effects; this API promises neither exactly
once nor durable cross-process/cross-host dedup. Disposing cannot retract an
already issued effect. It never removes reactions.
