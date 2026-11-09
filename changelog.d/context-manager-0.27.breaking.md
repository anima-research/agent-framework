- **Hosts:** agent-framework now depends on `@animalabs/context-manager`
  `^0.27.0` (was `^0.25.1`), and accepts `@animalabs/membrane`
  `^0.8.0 || ^0.9.0 || ^0.10.0` (was `^0.8.0 || ^0.9.0`), the range
  context-manager 0.27.0 declares, so the two share one membrane and a
  host's own membrane 0.10.0 is shared with them. A host that depends on
  context-manager itself needs `^0.27.0` too: beside a 0.25.x or 0.26.x of
  its own, an install holds two copies of context-manager. A fresh install
  gets context-manager 0.27.0 and membrane 0.10.1, unless the host's own
  range holds membrane lower, and a lockfile's membrane 0.8.0 or 0.9.0 is
  still admitted. context-manager's changelog for 0.26.0 and 0.27.0 and
  membrane's for 0.10.0 and 0.10.1 list their changes. Among them, these
  reach an agent's requests through the framework:
  - Where a later tool call reuses an earlier call's id, context-manager
    0.26.0 pairs each result with the nearest call before it with that id,
    and an earlier call left without a result goes with a stub. A store in
    which no call reuses an id compiles what it compiled. Where one does, a
    compile can differ, and the prompt cache can't serve that request from
    the first message that differs. A store whose one message holds several
    calls with one id, which `NativeFormatter` refused, is now sent.
  - A tool call's integer past `Number.MAX_SAFE_INTEGER` written as plain
    digits, such as a Discord id a model writes unquoted, reaches the tool
    from membrane 0.10.1 as those digits, a string, on the streamed paths
    the framework takes, where it could be rounded to another number.
  - Through OpenRouter, membrane 0.10.0 no longer puts the floating cache
    marker on a block that adapter sends without one, such as a tool
    result, so a request's float can go on the message before the round's
    calling turn instead, where it is sent.
