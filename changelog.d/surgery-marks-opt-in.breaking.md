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
    a `host/command` `undo` by messages, and `--marks addressed|all` on the
    CLI. Show `previewSurgeryMarks()` before
    the choice, and pass a scope's `refs` back to bind the choice to exactly
    the previewed messages. Any other `marks` value is refused rather than
    guessed (`invalid`, from the two methods). `hide` and an `undo` by turns
    place no marks, and refuse a `marks` choice other than `none`. A
    framework with an app-owned `store` and no `storePath` has no awareness
    ledger unless `discordAwarenessOutboxPath` names one, and refuses a marks
    choice (`invalid`) rather than place none.
  - **Receipts (`markers`):** their `status` is `none`, `queued` or
    `not-scheduled`. `unresolved` is gone: a batch that can be neither
    activated nor retired stays prepared, and a start retires it, none of
    its marks sent, so it is `not-scheduled`, whose `error` says so.
    Receipts now also carry `scope`, `unmarked` and `notRemoved`.
  - **Unchanged:** the body change itself (fork, switch, redaction), the
    emoji (`discordAwarenessEmoji`) and the reaction deadline
    (`discordAwarenessDeadlineMs`). Marks already on Discord are left
    alone.
  - discord-mcpl 0.3.0's `/hide` reacts 💤 to every message in `hiddenRefs`
    itself, whatever this framework does: those marks are its own, outside
    the ledger.
- **Code using `DiscordAwarenessOutbox` directly:** the ledger is version 3,
  a table with one entry per reaction. The constructor takes the path and,
  for the sync before a write that activates, completes or retires a batch,
  the store, with a callback told of a directory a write couldn't sync:
  `new DiscordAwarenessOutbox(path, { store?, onUnsyncedWrite? })`. Every call that
  writes is async and resolves once its write is on disk; the views
  (`view()`, `batches()`, `due()` and `pendingSuppressionsFor()`) read
  memory. `pending()`,
  `reconcileForBranch()`, `activatePreparedForBranch()`,
  `preparedSuppressionsForBranch()`, `recordSuccess()`, `recordFailure()`
  and `acknowledge()` are gone. Use `claim()` and `recordOutcome()`,
  `view()`, `cancel()`, `retract()` and `settleActivation()`. `prepare()`
  takes no `activationPolicy`: a batch that names removal intervals is a
  suppression, and only its surgery activates it. The exported
  `DiscordAwarenessEntry` and `DiscordAwarenessOperation` types went with the
  version 2 shape: a request is `DiscordAwarenessRequest`, a batch
  `DiscordAwarenessBatch`, and `view()` returns `DiscordAwarenessView`. An
  operator control the outbox won't carry out throws
  `DiscordAwarenessRefusal`.
- **Hosts with an awareness ledger from 0.22.x** (by default
  `<store>/recovery/discord-awareness-outbox.json`): it is rewritten as
  version 3 in place by its first write, at a start or an offline recovery,
  and the marks 0.22.x had still to add or remove are never sent, since
  nobody chose them. The rewrite names their batches on stderr wherever it
  runs, and in a `discord-awareness-import-unsent` ops alert at the host's
  start that makes it, each before the rewrite is written. A batch 0.22.x
  never activated placed no marks; a retract of a batch takes off the mark
  of its emoji from each of its messages, whichever batch placed it. A
  version 1 ledger, which only an unreleased commit wrote, is refused until
  it is moved away, and its error says what that gives up. 0.22.x reads only
  versions 1 and 2, and its start stops on a version 3 file: to go back to
  0.22.x, move the file aside first, and 0.22.x then starts with no marks
  history.
- **Hosts that call `startDiscordAwarenessDelivery()`:** 0.22.1 added it
  for a host to start the marks' delivery after its own branch moves. It is
  removed: a branch move adds or removes no marks now, and queued work is
  delivered in the background on its own. `syncDiscordAwarenessMarkers()`
  delivers what is queued now and waits for that pass. Once `stop()` has
  begun it rejects, where the removed method logged and returned, so await
  it, or catch its refusal.
- **`createOfflineRecoveryBranch` and `agent-framework-recover`:** in the
  result (and the CLI's JSON output), `discordMarkersQueued` is the marks
  queued (planned, for a dry run), no longer every addressable removed
  message, with `markers`, the receipt, beside it, and `discordAddressable`,
  `marksScope`, `unmarked` and `notRemoved` are new.
