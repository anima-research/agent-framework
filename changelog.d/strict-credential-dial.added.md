- WebSocket servers can opt into `credentialRequired: true` with
  `tokenTransport: 'header'` and a host-attached `accessProvider`. Missing,
  throwing, empty or non-sendable providers stop the dial without fallback;
  sendable credentials have no minimum length. Static tokens, URL token
  parameters, userinfo, fragments, non-WebSocket bindings and cleartext
  connections to anything but `localhost` or a literal loopback address are
  refused. Redirects are not followed.
  Dial failures distinguish `provider-failed`, `credential-rejected` (401/403),
  `engine-unsupported` (no numeric upgrade status) and `connection-failed`.
  Runtime support uses structured status capability rather than version pins.
  Optional credential behavior and diagnostic filtering are unchanged.
