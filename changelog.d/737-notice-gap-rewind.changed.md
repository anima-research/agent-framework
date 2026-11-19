- The rewind marker now reads "The N earlier turn(s) were set aside after
  requests couldn't be completed", where it read "The N most recent
  turn(s) were set aside because the requests that carried them couldn't
  be completed": the shed passes over notices and rows a request didn't
  carry, so what it set aside isn't always the newest, nor always all on
  the failed request. It still opens "[turns-set-aside] The ", so a reader
  matching that prefix still finds it. It also no longer says the
  originals always remain in the raw record: it says they remain there
  after a rewind on a presented window (the default), and that they were
  removed from it after one on a window that is still the record (legacy
  mode), as it did before. The tag and the metadata are unchanged.
