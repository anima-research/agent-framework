- **Hosts:** agent-framework accepts `@animalabs/membrane`
  `^0.8.0 || ^0.9.0` (was `^0.8.0`), so agent-framework and the
  context-manager it installs share one membrane, and a host's own membrane
  0.8 or 0.9.0 is shared with them. A fresh install gets membrane 0.9.0
  unless the host's own range holds it to 0.8, and a lockfile's 0.8.0 is
  still admitted. membrane's changelog for 0.9.0 lists its changes. With
  membrane 0.9.0 installed, two things the framework takes from membrane
  read differently:
  - When a model call fails because its connection does, and the error's
    causes carry a code, membrane 0.9.0's message names the host it tried,
    with its port when that isn't the scheme's default, and what happened,
    such as "The request to 127.0.0.1:59999 failed: the connection was
    refused (ECONNREFUSED)." On Node, membrane 0.8.0 said "Connection
    error." through the Anthropic adapter and "fetch failed" through the
    OpenRouter, OpenAI-compatible and OpenAI adapters. An
    `[inference-failed]` note's reason is the failure's message, cut at 600
    characters, so a new note reads that way.
    Notes already stored don't change.
  - A retryable failure with no HTTP status and no deadline mark, of type
    `network` or `timeout`, whose message holds `529` as a word or
    `overloaded_error`, is no longer read as overloaded, so the error
    policy gives it the base schedule rather than the overloaded one.
