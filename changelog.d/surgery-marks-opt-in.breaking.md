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
    `host/command` `undo` (by messages or by turns) and `hide`, and
    `--marks addressed|all` on the CLI. Show `previewSurgeryMarks()` before
    the choice, and pass a scope's `refs` back to bind the choice to exactly
    the previewed messages. Any other `marks` value is refused rather than
    guessed (`invalid`, from the two methods). A surface that reacted to
    `hide`'s `hiddenRefs` itself should leave marking to the framework: a
    mark it places itself is outside the journal, so nothing can list or
    cancel it.
  - **Unchanged:** the body change itself (fork, switch, redaction), the
    receipt's `status` values, the emoji (`discordAwarenessEmoji`) and the
    reaction deadline (`discordAwarenessDeadlineMs`). Marks already on Discord
    are left alone. Receipts (`markers`) now also carry `scope`, `unmarked`
    and `notRemoved`.
  - `host/command` `hide` and turn-based `undo` now hold the store like
    every surgery, so they are refused (`agent-busy`) while any agent
    sharing the store is mid-turn.
  - An older discord-mcpl's `/hide` reacts 💤 to every message in
    `hiddenRefs` itself, whatever the framework does, until its companion
    release, which passes the operator's choice instead.
- **Code using `DiscordAwarenessOutbox` directly:** the awareness ledger is now
  an append-only journal of typed records in the Chronicle store, so the
  constructor takes the store: `new DiscordAwarenessOutbox(store, { legacyPath? })`.
  `pending()` and `reconcileForBranch()` are gone. Use `claimDispatch()` (or
  `pendingDispatches()` and `recordDispatching()`), `recordOutcome()`,
  `view()`, `cancel()`, `retract()` and `settleActivation()`. The exported
  `DiscordAwarenessEntry` and `DiscordAwarenessOperation` types went with the
  JSON ledger: an operation is `DiscordAwarenessOp`, a batch
  `DiscordAwarenessBatch`, and `view()` returns `DiscordAwarenessView`. An
  operator control the outbox won't carry out throws
  `DiscordAwarenessRefusal`.
- **Hosts with a JSON awareness ledger:** `discordAwarenessOutboxPath` now
  only names it for import (by default
  `<store>/recovery/discord-awareness-outbox.json`). It is imported once on
  first use and renamed `.migrated-v2`, and the marks 0.22.x had still to add
  or remove are never sent, since nobody chose them. The import names their
  batches on stderr wherever it runs, and in a
  `discord-awareness-import-unsent` ops alert at the host's start that
  imported it. A batch 0.22.x never activated placed no marks; a retract of
  a batch takes off the mark of its emoji from each of its messages, whichever
  batch placed it.
  A release before this one doesn't read the
  journal, so a host downgraded after the import starts without it, and
  marks queued since aren't delivered.
- **Hosts that call `startDiscordAwarenessDelivery()`:** 0.22.1 added it
  for a host to start the marks' delivery after its own branch moves. It is
  removed: a branch move adds or removes no marks now, and queued work is
  delivered in the background on its own. `syncDiscordAwarenessMarkers()`
  delivers what is queued now and waits for that pass. Once `stop()` has
  begun it rejects, where the removed method logged and returned, so await
  it, or catch its refusal.
- **`createOfflineRecoveryBranch` and `agent-framework-recover`:** the result
  (and the CLI's JSON output) no longer has `outboxPath`, since the journal is
  in the store. `discordMarkersQueued` is the marks queued (planned, for a dry
  run), with `markers`, the receipt, beside it, and `discordAddressable`,
  `marksScope`, `unmarked` and `notRemoved` are new. Both need a store that
  exists: a path that holds none is refused, where it used to be created.
