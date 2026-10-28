- **Hosts that run `DiscordModule` or `ApiModule`:** each of the framework's
  notice openings in the name a sender's message is stored under is now
  marked with a backslash before its bracket, as in the text a participant
  or a server supplies, ahead of the name's ` (Discord)` or ` (API)`. A name
  with none of those openings is stored as before. This corrects 0.29.0's
  entry for these modules where it gives the stored form as
  `<username> (Discord)` and `<name> (API)`: from this release, a name
  holding one of those openings is stored in its marked form, and that is
  the form the `ApiServer`'s message list shows wherever it lists such a
  message. 0.29.0's entry on supplied text ends
  "This change doesn't mark these openings in the name a message is stored
  under"; for these two modules, this release does.

  **Who needs to act:** code that matches senders by a stored message's exact
  participant. As 0.29.0's entry says, read a row's `metadata.author` when it
  has one, which this change leaves as it was.

  **Unchanged:** rows stored before this change keep the name they were
  stored with: a history sync or an edit through these modules may change a
  stored message's content, never the name it is stored under. The generic
  name `user`, in any capitalization, is stored as given.
