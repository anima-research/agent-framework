- **Hosts whose own context-manager stays at 0.24.0 or 0.24.1:**
  agent-framework asks for `@animalabs/context-manager` `^0.24.2` (was
  `^0.24.0`), the first context-manager release that accepts membrane
  0.9.0. A host whose own copy of context-manager stays at 0.24.0 or
  0.24.1 gets a second context-manager, 0.24.2, under agent-framework, and
  a strategy it builds from its own copy is no longer an instance of the
  framework's classes. An exact pin in the host's `package.json` keeps its
  copy there, and so does bun when the host's lockfile holds 0.24.0 or
  0.24.1 under a caret range; npm instead moves such a lockfile to 0.24.2,
  and the host keeps one context-manager. With
  `subconscious.reader: 'forks'` and no `subconscious.strategyFactory`,
  `AgentFramework.create` throws for such a host's `PassthroughStrategy`.
  Ask for context-manager `^0.24.2`. Beside membrane 0.9.0, a
  context-manager 0.24.0 or 0.24.1 brings a membrane 0.8 of its own, since
  each asks for `^0.8.0`, so such a host had two membranes before this
  release too.
- **Hosts:** agent-framework accepts `@animalabs/membrane`
  `^0.8.0 || ^0.9.0` (was `^0.8.0`), so agent-framework and the
  context-manager it installs share one membrane, and a host's own membrane
  0.8 or 0.9.0 is shared with them. A fresh install gets membrane 0.9.0
  unless the host's own range holds it to 0.8, and a lockfile's 0.8.0 is
  still admitted. membrane's changelog for 0.9.0 and context-manager's for
  0.24.2 list their changes. With membrane 0.9.0 installed, two things the
  framework takes from membrane read differently:
  - When a model call fails because its connection does, and the error's
    causes carry a code, membrane 0.9.0's message names the host it tried,
    with its port when that isn't the scheme's default, and what happened,
    such as "The request to 127.0.0.1:59999 failed: the connection was
    refused (ECONNREFUSED)." where membrane 0.8.0 said "Connection error."
    or "fetch failed". An `[inference-failed]` note's reason is the
    failure's message, cut at 600 characters, so a new note reads that way.
    Notes already stored don't change.
  - A retryable failure with no HTTP status and no deadline mark, of type
    `network` or `timeout`, whose message holds `529` as a word or
    `overloaded_error`, is no longer read as overloaded, so the error
    policy gives it the base schedule rather than the overloaded one.
