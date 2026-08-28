# Resident lifecycle

Resident retirement is an opt-in terminal lifecycle state for a configured,
persistent agent identity. Its semantics are deliberately narrow:

- **End turn** stops the current inference and permits a later wake.
- **Sleep/dormancy** suppresses wakes temporarily and remains reversible.
- **Retirement** permanently denies future inference for this resident.
- **Erasure** deletes stored data and is a separate custodial operation.

Retirement preserves Chronicle, messages, workspace files, inference logs,
and a terminal lifecycle event. Later external traffic may still appear in
host process logs, but is not appended to the retired resident's context.

## Framework responsibility

Enable the neutral primitive on a configured resident:

```ts
const framework = await AgentFramework.create({
  storePath: './data/resident',
  membrane,
  agents: [{
    name: 'resident',
    model: 'claude-opus-4-6',
    systemPrompt: '...',
    retirement: { enabled: true },
  }],
  modules,
});
```

Once its own policy is satisfied, the host applies the seal imperatively:

```ts
const result = framework.retireResident('resident', optionalResidentReason);
```

There is intentionally no framework-owned confirmation phrase, challenge,
cooling-off interval, notification policy, or human approval hook. Those are
product decisions. The framework owns only authorization, durable sealing,
enforcement, status, and observability.

`getResidentLifecycleStatus(name)` returns the durable host view. A configured
resident without `retirement.enabled` cannot be retired through this API.

## Host-owned live tools

A module may implement `getLiveTools(agentName)` for a resident-facing
ceremony. Definitions from this method are namespaced like ordinary module
tools, but have a stronger call boundary:

- they appear only on the named provider-issued live stream;
- they are absent from ephemeral and conversation-fork surfaces unless the
  module explicitly returns them for those names;
- public `executeToolCall`, `ModuleContext.callTool`, `code_execution`, and
  `puppetToolCall` cannot invoke them.

The module still handles a valid live call through its ordinary
`handleToolCall`. This lets a host own all resident-facing semantics while the
framework enforces that administrative puppeting cannot counterfeit consent.

## Terminal enforcement

`retireResident` appends and fsyncs one record in
`resident-retirements.jsonl`. That sidecar is authoritative across Chronicle
undo, redo, and branch switching. The framework then:

- drops queued and future inference requests for the resident;
- rejects direct starts and operator nudges;
- skips context-maintenance ticks that could invoke the resident's model;
- stops resident-authored foreground/background code runners;
- clears resident-owned gate sleep and self-wake timers, provider cooldowns,
  and queued wake state;
- freezes the resident conversation against later message appends;
- refuses to create a conversation fork from a retired template resident; and
- appends `framework/resident-lifecycle` in Chronicle and emits a
  `resident:retired` trace.

Already-running ephemeral subagents are separate, short-lived inference
identities. Retirement does not kill them mid-call. They may finish their own
work, but any attempt to deliver a wake or append into the retired resident is
rejected by the seal. New resident inference and new resident-authored
background activity are denied. Hosts that want parent-scoped cancellation
must track and cancel those ephemeral jobs before invoking `retireResident`.

## Seal location and startup integrity

With `storePath`, the default sidecar is
`<storePath>/resident-retirements.jsonl`. If the app passes an owned `store`,
it must also pass an explicit branch-independent `retirementPath`.

Startup parses every non-empty line strictly and fails closed on truncated
JSON, a missing final newline, invalid fields, or duplicate records. The
framework must not infer while the terminal ledger is ambiguous.

### Recovering a malformed seal safely

There is no lifecycle reversal API. If startup reports a malformed seal:

1. Keep the host stopped and make a byte-for-byte backup of the sidecar.
2. Inspect the exact path and line number from the startup error.
3. Compare the sidecar with host/storage logs. Remove only a demonstrably
   incomplete or invalid write that never constituted a valid seal record
   (normally a torn final line after a storage failure).
4. Never delete or edit a valid `resident-retired` record. Never repair an
   ambiguous file by guessing. Preserve it and escalate for forensic review.
5. Restart only after the remaining file is newline-terminated and every line
   validates independently.

This procedure repairs ledger syntax; it does not provide a hidden route to
unretire a resident. Deleting a valid seal is an out-of-band alteration of the
durable record and violates the lifecycle contract.
