- With `subconscious.reader: 'forks'`, residents see the reader's four tools
  (`deliver_summary`, `cancel_tuneout`, `speak_in_channel`, `note_disposition`)
  in their own tool block so a reader fork's request shares their provider
  prefix; a resident that calls one gets a tool-result refusal naming the
  reader. A resident whose `allowedTools` leaves them out isn't shown them,
  and neither are its reader forks, which then report through their final
  prose. A reader fork may call its own tools whatever its resident's
  `allowedTools` says, unless a `denyToolsAtDispatch` entry it takes from
  its resident names one. Persistent mode advertises nothing extra.
