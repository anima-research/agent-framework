- **Hosts and operator surfaces that remove Discord messages from an agent's
  context:** awareness marks are now an explicit publication choice, and the
  default is none. Previously every live rollback or suppression,
  message-granular `host/command` undo, and offline `agent-framework-recover`
  run queued a 💤 reaction on every removed Discord message, including other
  people's ambient messages in a busy channel. In the incident behind this
  change, one web-UI rollback queued 918 of them.
  - **Who needs to act:** a surface that should keep offering marks passes the
    operator's choice: `marks: { scope: 'addressed' | 'all', refs? }` on
    `rollbackToMessage`/`suppressMessages`, `marks: 'addressed' | 'all'` on
    `host/command` `undo` (by messages or by turns) and `hide`, and
    `--marks addressed|all` on the CLI. `addressed` covers messages tagged
    `chat:addressed` (mentions, replies to the bot, DMs). Show
    `previewSurgeryMarks()` before the choice, and pass a scope's `refs` back
    to bind the choice to exactly the previewed messages. Any other
    `host/command` `marks` value is refused rather than guessed. A surface
    that reacted to `hide`'s `hiddenRefs` itself should stop when the result
    carries `markers`: the framework marked through its journal.
  - **Unchanged:** the body change itself (fork, switch, redaction), the
    receipt's `status` values, the emoji (`discordAwarenessEmoji`) and the
    reaction deadline (`discordAwarenessDeadlineMs`). Marks already on Discord
    are left alone; nothing is removed automatically.
  - Receipts (`markers`) now also carry `scope`, `unmarked` and `notRemoved`.
  - `host/command` `hide` and turn-based `undo` now hold the store like
    every surgery, so they are refused (`agent-busy`) while any agent
    sharing the store is mid-turn.
  - No sibling version is required: a host that ignores the new option simply
    places no marks. The connectome-host and discord-mcpl companions add the
    choice to their surfaces.
- **Code using `DiscordAwarenessOutbox` directly:** the awareness ledger is now
  an append-only journal of typed records in the Chronicle store
  (`af:discord-awareness`, on the shared `RecordJournal`), so the constructor
  takes the store: `new DiscordAwarenessOutbox(store, { legacyPath? })`.
  `pending()` and `reconcileForBranch()` are gone. Use `claimDispatch()` (or
  `pendingDispatches()` and `recordDispatching()`), `recordOutcome()`,
  `view()`, `cancel()`, `retract()`, `release()` and `settleActivation()`.
  `discordAwarenessOutboxPath` now only names a previous JSON ledger to
  import. Such a file (by default `<store>/recovery/discord-awareness-outbox.json`)
  is imported once on first use and renamed `.migrated-v2`; a copy put back
  there later imports only batches the journal doesn't already hold. What it
  recorded is kept as evidence, never as synthesized attempts or as proof that
  a suppression's body completed, and its undelivered work is held for an
  explicit release.
