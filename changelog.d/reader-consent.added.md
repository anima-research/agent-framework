- Reader forks run under the resident's yes. `subconscious.consent`
  (`ReaderConsent`) records who said yes, when, where the public yes can be
  read, and the fork section as the resident saw it (`model`, `voice`,
  `allowChannelSpeech`, `forkIdleTimeoutMs`); `create` refuses a live section
  that differs from the one agreed (`readerConsentDrift`), naming the field,
  the yes and what to do. The record rides every fork's registry entry and
  `dendrite:agent-created`, and each derivation notice names it — "under the
  yes you gave on … (…)". A new resident tool, `withdraw_consent`, takes the
  yes back: from the next derivation nothing is derived
  (`tune-out:reader-withheld`), a tune-out is a silent hold whose tool result
  says why, the resident is told, the withdrawal survives a restart beside
  the all-except scope, and a later yes in the configuration renews the forks
  (`tune-out:reader-consent-renewed`). A yes counts only as public speech; a
  no counts however it reaches the host. Whether a yes is asked for at all is
  a policy, `dendrite.consent`: `'recorded'` (default) checks and carries a
  yes that is given and offers the withdrawal, `'required'` also refuses
  forks without one, `'none'` reads no consent and offers no tool; and
  `dendrite.announceDerivations` (default true) decides whether an agent is
  told of its derivations. Neither is a rule the framework imposes: a consent
  gate and a derivation stamp assume one kind of mind's preferences, and the
  architecture should not assume them of every mind that may run here.
- `speak_in_channel` posts through the resident's own publish path: the
  channel sees the resident's account, in the fork's words, and nothing in
  the request names the fork. `docs/dendrite.md` and `allowChannelSpeech`'s
  doc said otherwise and now say this.
