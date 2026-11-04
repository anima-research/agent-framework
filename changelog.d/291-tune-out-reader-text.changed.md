- **Residents: `tune_out`'s description, and the `[tuned out]` note on a send into a tuned-out channel, name the
  reader this host configures.** The tool said "Divert a channel to your subconscious … Your
  subconscious watches it instead — summarizing on a cadence in its own voice, judging whether mentions merit
  interrupting", and the note that the channel's "traffic still goes to your subconscious", whatever the
  configuration: a persistent reader the host named was still "your subconscious", and so were reader forks. Now the
  text names a persistent reader by the name it runs under (`subconscious.name`), and says reader forks are forks of
  the resident's context; each says what the reader can do (report, cancel) and when it runs, not what it judges. A
  tool block's bytes change, so the first request after the upgrade misses the prompt cache. `tuneOutTool(reader)`
  builds the tool for each case.
- **Readers: the four reader tools' descriptions say what each tool does, not when to use it.** `deliver_summary`
  said "in your own voice, addressed to them (second person). Use at cadence when the diverted traffic merits it;
  staying silent is always allowed — an empty period needs no report"; `cancel_tuneout`, "use when something needs
  the resident's full attention … and normal attention resumes"; `speak_in_channel`, "in your own words and clearly
  as yourself (not as the resident) … Use sparingly — e.g. to tell someone the resident is tuned out and when to
  expect them"; and `note_disposition`'s examples named a real person ("antra's pings always escalate", "ignore
  release-bot"). Each now says what the tool does: a summary or a cancel's note arrives verbatim (leading and
  trailing whitespace trimmed) under the reader's own name, a cancel delivers the backlog and the channel's traffic
  reaches the resident as before, a disposition is kept under its key and shown to the reader each time it runs
  (its example a placeholder), and a post goes out as written, trimmed the same way, under the resident's account
  with nothing in it naming the reader. `deliver_summary`'s refusal of an empty `text`
  no longer adds "staying silent is allowed", and `speak_in_channel`'s refusal where channel speech is off no longer
  says "tell it what's needed with deliver_summary, or, if the channel is tuned out and needs the resident now, end
  the tune-out": it says what each does (deliver_summary puts the reader's text in the resident's context;
  cancel_tuneout ends the tune-out and delivers its backlog). A host that wants a policy for its reader gives it in the reader's
  `systemPrompt` (persistent) or `voice` / `framing` (forks). The four tools are in every reader's tool block, and
  under reader forks in every resident's, unless the resident's `allowedTools` leaves them out (then its reader
  forks aren't shown them either), so the first request after the upgrade misses the prompt cache there too.
- **Residents and readers: the rest of the text about a tuned-out channel names the reader this host configures, and
  a reader's cancel says who made it.** A channel tool's refusal of a tuned-out channel
  (`channel_open`, `channel_close`, `channel_decline`, a decline a tune-out replaced) said "its messages go to the
  subconscious"; tune_out's answers about the channel's transport said its messages "may not reach", "don't reach"
  or "reach the subconscious"; and tune_out with no reader said "this host has no subconscious resident to watch a
  channel". Now the messages "are held from you and read by <name>" (a persistent reader, by the name it runs
  under) or "… read by forks of your context" (reader forks); they "reach <name>" or "the reader"; and the refusals
  say "No reader is configured here". A reader's `cancel_tuneout` gave its cancel the reason "subconscious judgment", which the
  resident read in "[Tune-out: … cancelled — subconscious judgment, N wakes]", the reader in its cancel notice, the
  excepted channel in an all-except hold's release line, and a host in the `tune-out:cancelled` trace; the reason is
  now "by <name>", the reader's name or a reader fork's own (or "by the reader" where the call names none), except
  in the line posted in the excepted channel, which says "[Focus: <resident> released — by its reader.]" so that no
  agent's name, a reader fork's structural one included, reaches the channel. The
  channel registry takes the reader from the new `tuneOutReader` option, which the framework gives it; a registry
  made without one names the persistent reader by its default name, "Subconscious".
- **Hosts: `create()`'s refusal of reader forks with no `model` says what a reader fork is.** It said to give the
  resident's model "for a copy of the resident"; it now says a reader fork of the resident holds its whole prefix,
  and `model` is the model the resident runs or another by name.
