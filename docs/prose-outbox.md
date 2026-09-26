# Prose outbox

`FrameworkConfig.proseOutbox` (opt-in) keeps an agent's plain speech when it
can't be delivered right now, and delivers it later: in order, without double
posts, and with the agent told what happened.

```ts
proseOutbox: {
  enabled: true,
  maxAgeMs: 6 * 60 * 60_000,   // give up on the agent's own words after this (default 6 h)
  noticeMaxAgeMs: Infinity,     // automatic notices: kept until delivered (default)
  maxEntriesPerAgent: 50,       // defaults shown
  maxEntries: 200,
  retryBaseMs: 60_000,          // doubles per attempt…
  retryMaxMs: 15 * 60_000,      // …up to this
  tools: ['send_message', 'reply_message'], // send tools held the same way
  fileArgs: ['files'],          // args of those tools carrying files by path (default)
  path: '<storePath>/recovery/prose-outbox.json', // default
}
```

## What happens to a failed publish

All plain-speech paths (locus, explicit `>>` prefixes, hybrid, streamed
segments, trailing prose) deliver through `ChannelRegistry.routeSpeech`, so
the outbox sits there and covers all of them.

| Failure | Classified as | With the outbox |
|---|---|---|
| Connection closed / server disconnected / connector says the platform is not connected | `not-sent`: provably never posted | queued, retried |
| Request timed out; connection died while awaiting the answer; partial multi-part send | `unknown`: may have posted | queued and retried **only** if the server confirmed dedupe (below); otherwise reported as "may or may not have reached the channel" |
| `delivered: false`, missing grant, unknown channel, any other error | `permanent` | reported as before |

Without the outbox, thrown failures are no longer lost to a log line either:
they produce the `[discord-send-failed]` marker (with the "may or may not"
wording for `unknown`).

## No double posts

Every first attempt already carries `idempotencyKey` (stable across retries)
and `writtenAt` on `channels/publish`; a retry adds `delayReason`
(`disconnected` or `unanswered`) so the server can say why it is late. A server that dedupes by the key (a
repeat returns the original result instead of posting again) echoes the key
in its result; the host remembers, per server, whether the latest result
echoed it. Outcome-unknown speech is resent only to a server that did.
Servers that ignore the fields are unaffected and never receive a
possibly-duplicate resend.

## Send tools (`tools`)

Agents that talk through explicit send tools get the same hold for the tools
listed in `tools` (unprefixed MCPL names). Only list tools that are safe to
perform later: sends, never deletes or edits.

- Both MCPL tool routes (model dispatch and programmatic `callTool`) go
  through `ChannelRegistry.beginQueueableCall` / `settleQueueableCall`.
- Every call carries `_meta: { idempotencyKey, writtenAt }` (and on replay
  `delayReason`); a server that dedupes echoes the key in the result's
  `_meta`. Dedupe is tracked per server AND tool: a server may dedupe
  `send_message` but not `send_dm`.
- A call that can't reach its target (thrown not-sent, or the server's own
  error saying its platform is unreachable), or whose outcome is unknown on
  a tool that confirmed dedupe, is queued with its full input (channel,
  reply target, files) and the agent gets a successful `[queued] …` tool
  result, "you don't need to resend it", instead of an error. Any other
  error is returned exactly as before.
- Queued sends share per-channel order with queued speech (a raw provider
  channel id is matched to the registry's id).
- A queued send still counts as the round's explicit delivery, so the
  round's prose stays silenced (no double speaking).

## Order, durability, bounds

- Per-channel FIFO: while a channel has queued speech, new speech to it is
  queued behind (and the queue drained), never sent ahead.
- The queue is a JSON file written atomically before `routeSpeech` returns,
  not Chronicle state: a historical rollback must not resurrect delivered
  speech (double post) or lose undelivered speech.
- Drains run when a server connects or reconnects (after its grant is
  re-established), and on a timer while anything is queued. A drain never
  blocks generation.
- Two classes. The agent's own speech and sends expire after `maxAgeMs`,
  because a reply hours late may no longer fit the conversation. Automatic
  notices (`routeSpeech(..., { notice: true })`, e.g. a failure notice)
  are kept until delivered unless `noticeMaxAgeMs` is set. What a notice
  reports stays true. It is also written at the start of an outage, so a
  shared age limit would drop exactly the entries that report drops.
- Over a cap, the agent's own entries give way oldest first, and notices only
  after them. The survivors keep their order.
- A notice is never credited to the agent: its notes say "The automatic
  notice", not "Your reply".

## What the agent sees

Non-waking system notices in its window. Each names the reply (channel and
first words: several can be queued at once) and says what, if anything, the
agent needs to do:
- `[delivery-delayed]`: queued, kept across restarts, retried until a stated
  time; no need to resend. (Without a queue file it says the hold is
  memory-only, so the agent keeps its own copy.) After a timeout it says
  the message **got no answer and may already have arrived**: a timeout is
  the absence of an answer, not a failure, and the retry checks the channel
  before sending (a duplicate is possible only if that check can't be made:
  at-least-once, marked as such).
- `[delivered-late]`: written at X, delivered at Y. Nothing to do. (After a
  timeout: "confirmed in the channel", since it may have arrived the first
  time.)
- `[discord-send-failed]`: no longer held and won't be retried; either it
  never arrived ("send it again if it still matters") or it may already be
  in the channel ("check before sending it again"). **It carries the full
  text** (up to 8,000 characters inline; attachments listed), and a copy is
  saved to `undelivered/` beside the queue file, so giving up never loses
  the words and the agent needs no shadow copy of its own.

## Not covered

- Tools not listed in `tools` (and `channel_publish`): their failures still
  return to the agent as tool results, and the agent decides.
- Marking late messages for readers is the server's job: `writtenAt` and
  `delayReason` are passed so it can.
- Detecting a hung connector, and restarting it, is not part of this.

## Files, withdrawal, status (Sol, 2026-09-26)
- **Exact files.** A queued send tool call that carries files (`fileArgs`,
  arrays of `{ path }`) gets each file copied, owner-only, into
  `recovery/attachments/<id>/` when it is queued. The queued call points at
  the copies. Before each retry their SHA-256 is checked; a changed or
  missing copy means the entry is given up visibly, never sent altered or
  without it. If a copy can't be made (or the queue is memory-only), the call
  isn't queued at all and the agent gets an error saying nothing was sent.
  Copies are removed on delivery or withdrawal, and kept with the dead letter
  (`undelivered/<id>-attachments/`) when an entry is given up.
- **Withdrawal.** `outbox_cancel { id }` (the agent's own entries; the id or a
  unique prefix of 6+ characters) and `AgentFramework.cancelOutboxEntry(ref)`
  (operators, any entry; the agent is told). An entry whose retry is in flight
  can't be withdrawn: it may already be posting. A withdrawal never triggers a
  send by itself.
- **Status.** `outbox_status` lists the agent's waiting entries (id, where,
  written, attempts, kept files, retry deadline) and recent give-ups;
  `AgentFramework.getOutboxStatus()` gives operators the whole queue. Every
  delivery note carries the entry's short id. Both tools are present whenever
  the outbox is enabled.
- The queue's directories are owner-only (0700), like its files (0600).

