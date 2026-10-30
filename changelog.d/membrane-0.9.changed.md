- **Hosts:** agent-framework accepts `@animalabs/membrane` `^0.8.0 || ^0.9.0`
  (was `^0.8.0`) and asks for `@animalabs/context-manager` `^0.24.2` (was
  `^0.24.0`), the first context-manager release that accepts membrane 0.9.0.
  So a host on membrane 0.8 or on 0.9.0 installs one membrane, shared by the
  framework and context-manager. membrane's changelog for 0.9.0 and
  context-manager's for 0.24.2 list their changes. With membrane 0.9.0
  installed, two things the framework takes from membrane read differently:
  - When a model call fails because its connection does, and the error's
    causes carry a code, membrane 0.9.0's message names the host and port it
    tried and what happened, such as "The request to 127.0.0.1:59999 failed:
    the connection was refused (ECONNREFUSED)." where membrane 0.8.0 said
    "Connection error." or "fetch failed". An `[inference-failed]` note's
    reason is the failure's message, so a new note reads that way. Notes
    already stored don't change.
  - A failure with no HTTP status whose type is `network` or `timeout` is no
    longer read as overloaded from its message, one holding `529` or
    `overloaded_error`, so the error policy gives it the base schedule
    rather than the overloaded one.
