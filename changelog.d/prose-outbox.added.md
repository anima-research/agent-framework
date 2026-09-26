- Opt-in prose outbox (`FrameworkConfig.proseOutbox`): plain speech whose
  publish fails transiently (connector down, disconnected mid-send, timed out)
  is kept in `<storePath>/recovery/prose-outbox.json` and retried when the
  server comes back, in per-channel order (newer speech never overtakes queued
  speech), for up to `maxAgeMs` (default 6 h), capped per agent and in total.
  Speech that may already have posted is resent only to a server that
  confirms dedupe: `channels/publish` gains optional `idempotencyKey`,
  `writtenAt` and (on retries) `delayReason`, and a server that dedupes
  echoes the key in its result. The agent gets non-waking notices naming
  which reply and what, if anything, to do: `[delivery-delayed]` (kept
  across restarts, no need to resend), `[delivered-late]`, and
  `[discord-send-failed]` (no longer held; carries the full text, and a copy
  is saved to `recovery/undelivered/`) when speech is given up. After a
  timeout the notes say the message may already have arrived.
  - `proseOutbox.tools` (e.g. `["send_message", "reply_message"]`) holds
    those send tools the same way: a call that can't reach its target is
    queued with its full input and the agent gets a `[queued]` result
    ("you don't need to resend it") instead of an error. Calls carry
    `_meta.idempotencyKey`; dedupe is confirmed per server and tool.
    `McplServerConnection.sendToolsCall` gains an optional `meta` argument.
