- **Residents: `tune_out`'s description, and the `[tuned out]` note on a send into a tuned-out channel, name the
  reader this host configures, or say there is none.** The tool said "Divert a channel to your subconscious … Your
  subconscious watches it instead — summarizing on a cadence in its own voice, judging whether mentions merit
  interrupting", and the note that the channel's "traffic still goes to your subconscious", whatever the
  configuration: a persistent reader the host named was still "your subconscious", so were reader forks, and a host
  with no reader (`tuneOut.enabled` alone) was told of one, beside a sentence saying there might be none. Now the
  text names a persistent reader by the name it runs under (`subconscious.name`), says reader forks are forks of the
  resident's context, and with no reader, that the traffic is held for the resident and delivered when it cancels or
  `durationSeconds` runs out, with no reader to read it meanwhile; each says what the reader can do (report, cancel)
  and when it runs, not what it judges. The `maxWakes` sentence and the all-except pause are left out with no
  reader, where neither applies, and `backlogCap`'s 0 says what a cancel then delivers. A tool block's bytes change,
  so the first request after the upgrade misses the prompt cache. `tuneOutTool(reader)` builds the tool for each
  case.
- **Readers: the four reader tools' descriptions say what each tool does, not when to use it.** `deliver_summary`
  said "in your own voice, addressed to them (second person). Use at cadence when the diverted traffic merits it;
  staying silent is always allowed — an empty period needs no report"; `cancel_tuneout`, "use when something needs
  the resident's full attention … and normal attention resumes"; `speak_in_channel`, "in your own words and clearly
  as yourself (not as the resident) … Use sparingly — e.g. to tell someone the resident is tuned out and when to
  expect them"; and `note_disposition`'s examples named a real person ("antra's pings always escalate", "ignore
  release-bot"). Each now says what the tool does: a summary or a cancel's note arrives verbatim under the reader's
  own name, a cancel delivers the backlog and the channel's traffic reaches the resident as before, a disposition is
  kept under its key and shown to the reader each time it runs (its example a placeholder), and a post goes out
  under the resident's account with nothing in it naming the reader. `deliver_summary`'s refusal of an empty `text`
  no longer adds "staying silent is allowed". A host that wants a policy for its reader gives it in the reader's
  `systemPrompt` (persistent) or `voice` / `framing` (forks). The four tools are in every reader's tool block, and
  under reader forks in every resident's, so the first request after the upgrade misses the prompt cache there too.
