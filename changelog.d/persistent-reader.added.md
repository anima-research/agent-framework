- A persisted reader: `subconscious.persist` (`'look'`, the default, `'epoch'` or `'resident'`) for reader forks. With
  `'epoch'` or `'resident'` the reader is one derived identity per tune-out or across the resident's tune-outs,
  `reader/<resident>/<epoch8>/g<k>` or `reader/<resident>/g<k>`. Its first look derives it as a reader fork is derived;
  each later look resumes it (`resumeAgent`), a new incarnation on the branch the derivation made, with the
  configuration a derivation gives it built again and that look's epoch, channel and trigger as its record's metadata.
  One look runs at a time per identity. With `'look'`, or with `persist` left out, each look derives a fork of its own,
  as before.
  - `subconscious.resync` (`'window'`, the default with `persist`, or `'none'`): a resumed look is handed, as
    `ReaderFramingContext.residentRows`, the rows the resident's window took since the reader's last look, read from
    the mark its previous framing row records (`metadata.residentThrough`, `residentBranch`), without the reader's own
    rows and report mail, the resident's stored context injections and held rows. Its `backlog` leaves out the held rows
    a framing on its branch handed it before. `defaultReaderFraming` writes `residentRows` as one block before the held
    traffic: `[In <resident>'s context since your last look: n messages]` and a line per row, tool calls and results in
    brief and no thinking. The framing context also has `resumed`, `incarnation` and `rederived`.
  - The identity is derived again under the next `g<k>`, traced `tune-out:reader-rederived` (`reason: 'no-record' |
    'branch-moved' | 'scope-ended'`), when the registry has no ended record of it in scope, when its derivation's
    checkpoint is no longer on the host's branch or (with `resync: 'window'`) its last look was framed on another
    branch, and with `'epoch'` for the one late look the coordinator asks for after the tune-out ended
    (`ReaderInvocation.epochEnded`).
  - `dendrite.beforeDerive` is asked at every derivation and every resumption; a resumption it refuses is a failed
    look, whose held rows go back, and is never turned into a derivation. The framework checks no consent and assumes
    none; the record, the traces and the spec show `persist` and `resync`.
  - `tune-out:reader-fork` carries `incarnation`, `resumed` and `resynced` for a persisted reader. `tune_out`'s text
    says what a persisted reader does at a later run, in one sentence, so its bytes change for a host that sets
    `persist`.
- `subconscious.pendingRound`: the resident's tool round in flight when a reader is derived, as `deriveAgent`'s
  `pendingRound`, or a function of the look's framing context that returns it, in place of the framework's note for the
  open call. `DeriveAgentOptions.pendingRound.madeBy.toolUseId` may be left out, for the only open call.
- `resumeAgent(name, config, { metadata })`: the new incarnation's record metadata, in place of the ended record's
  (`ResumeAgentOptions`).
