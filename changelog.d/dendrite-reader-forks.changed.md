- With `subconscious.reader: 'forks'`, residents see the reader's four tools
  (`deliver_summary`, `cancel_tuneout`, `speak_in_channel`, `note_disposition`)
  in their own tool block so a reader fork's request shares their provider
  prefix; a resident that calls one gets a tool-result refusal naming the
  reader. A resident whose `allowedTools` leaves them out isn't shown them,
  and neither are its reader forks, which then report through their final
  prose. A reader fork may call its own tools whatever its resident's
  `allowedTools` says, unless a `denyToolsAtDispatch` entry it takes from
  its resident names one. Persistent mode advertises nothing extra.
- A reader fork's `cancel_tuneout` ends only the hold of the epoch it was
  derived to read, and its `speak_in_channel` posts only into a channel that
  hold still holds; once the hold has ended, both are refused. A fork whose
  record carries no epoch is refused both. `deliver_summary` and
  `note_disposition` stay open to every reader.
