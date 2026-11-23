- An emoji no longer makes the reply judge fail. The judge shortens a long
  text to its head and its tail. Its cut kept a fixed number of UTF-16 units
  at each end, so it could keep half of an emoji's surrogate pair. The
  provider refused such a request with HTTP 400 ("lone leading surrogate in
  hex escape"). Under the default `onError: "wake"`, each refused batch then
  woke the agent. The cut now keeps each pair whole. The judge also replaces
  each lone surrogate in its request with U+FFFD before it sends the
  request. A rule's `instructions` can hold one, for example.
