- A turn whose last call the provider refused as `reasoning_extraction`,
  and which no rewind took, now leaves the agent a note in its own context:
  `[inference-failed] Your previous turn did not complete: the provider API
  refused its last call.` Until now such a turn left the agent nothing: the
  reaction on the message it answered never reaches its context. The note
  names no category and carries none of the provider's text; the category
  is in the row's metadata (`kind: 'inference-refused'`). A run of such
  turns shares one note: while the provider has answered no call of the
  agent's since, each further refused turn updates that row in place
  (`… The 2 turns after it ended the same way.`) rather than adding one.
  Once a call is answered, a round's or a turn's last, the note stays as
  written, and the next refused turn starts a new one. A turn that ended
  another way in between (a failure, or a refusal of another category) ends
  the run too, so the turns a note counts are the ones right after it. The
  run is kept in memory: after a restart, or once the note has left the
  agent's window (an undo takes it out), the next refused turn starts a new
  note. The note starts no inference: the agent reads it at its next turn.
  `SUPPRESS_INFERENCE_FAILED_MARKER=1` leaves it out. A refusal of another
  category writes no note, as before.
