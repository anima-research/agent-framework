- **Hosts that run `DiscordModule` or `ApiModule`:** a sender's name from
  outside the framework is now stored in a form marked with its source.
  Before this change, a Discord author or API caller whose name matched an
  agent's could have their message compiled as the agent's own turn.
  `DiscordModule` now stores a Discord author's message under
  `<username> (Discord)`, live and on history sync, and `ApiModule` stores
  the message of every `api:message` event, from an `ApiServer` caller or a
  host's own, under `<name> (API)`. An `api:message` whose `participant`
  isn't text, which its type doesn't allow, isn't stored, and starts no
  turn. Such a name is stored on one line: each run of line breaks (U+2028
  and U+2029 included) and other control characters becomes one space. The
  generic name `user`, in any capitalization, is stored as given. Where an
  agent's request shows senders' names, the agent sees the marked form,
  beside the form stored before this change in older rows. The `ApiServer`
  now refuses a `participant` that isn't text, as it refuses content that
  isn't.

  **Who needs to act:**
  - code that tells senders apart by a stored message's participant, such
    as an `ApiServer` client that recognises its own messages in the
    message list, which now returns them under `<name> (API)`;
  - a host that pushes an `api:message` in an agent's name to write that
    agent's turn, which now records a user turn, unless that name is one
    the marking can't cover (below);
  - an `ApiServer` caller that sends a `participant` that isn't text, which
    the server now refuses, and a host that pushes such an `api:message`
    itself, which `ApiModule` doesn't store or start a turn for.

  **Migration:** read a row's `metadata.author` when it has one, and its
  participant otherwise, as history's author filter does: rows these modules
  stored before this change have none, unless a host's `api:message` carried
  one. Both modules now store the name as sent there (`{ id, name }` from
  Discord, `{ name }` from the API, unless an `api:message` event's metadata
  carries an `author` object, which is kept and identifies the row instead),
  so the author filter still finds a sender by that name, and a Discord
  author by id in rows stored after this change. Write an agent's own turns
  from a module of your own, with its context's `addMessage` under the
  agent's name. Send a `participant` as text.

  **Unchanged:** an agent's own turns, and the bot's own messages that a
  Discord history sync stores, which keep the name of the framework's first
  agent. Rows stored before this change keep the name they were stored
  with, so one author can appear under both forms in one history, and the
  author filter finds both by the name as sent, or, for an API event that
  carried an `author` object, by that author, as before.

  No agent's name is refused: a host that gives one of its own agents the
  name `user`, in any capitalization, or a name ending in ` (Discord)` or
  ` (API)` defeats the marking for that name.
