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
    `host/command` `undo` and `hide`, and `--marks addressed|all` on the CLI.
    `addressed` covers messages tagged `chat:addressed` (mentions, replies to
    the bot, DMs). Show `previewSurgeryMarks()` before the choice, and pass a
    scope's `refs` back to bind the choice to exactly the previewed messages.
    Any other `host/command` `marks` value is refused rather than guessed.
  - **Unchanged:** the body change itself (fork, switch, redaction), the
    receipt's `status` values, the emoji (`discordAwarenessEmoji`) and the
    reaction deadline (`discordAwarenessDeadlineMs`). Marks already on Discord
    are left alone; nothing is removed automatically.
  - Receipts (`markers`) now also carry `scope`, `unmarked` and `notRemoved`.
    Marks that were chosen but can't be recorded, because there is no journal
    (no `storePath` or `discordAwarenessOutboxPath`), are reported as
    `not-scheduled` rather than `none`.
  - No sibling version is required: a host that ignores the new option simply
    places no marks. The connectome-host and discord-mcpl companions add the
    choice to their surfaces.
- **Code using `DiscordAwarenessOutbox` directly:** the awareness ledger is now
  an append-only journal of requests and attempts,
  `<store>/recovery/discord-awareness-journal.jsonl`. `pending()` and
  `reconcileForBranch()` are gone. Use `pendingDispatches()`,
  `recordDispatching()`/`recordOutcome()`, `view()`, and
  `cancel()`/`retract()`/`release()`. A previous `discord-awareness-outbox.json`
  is imported once on first use: its recorded outcomes are kept, its undelivered
  work is held for an explicit release, and the file is renamed
  `.migrated-v2`.
