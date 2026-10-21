- A WebSocket MCPL server takes `tokenTransport: 'header'`, which sends its
  credential, the static `token` or what its `accessProvider` returns for
  each dial, as an `Authorization: Bearer` header on the upgrade, with no
  `token` query parameter. The credential then stays out of the url and of
  the proxy and server access logs that record it. The default,
  `tokenTransport: 'query'`, dials exactly as before, and `null` counts as
  not set. A header carries a credential as configured only if it is
  printable ASCII (U+0020 to U+007E) with no space at either end, so header
  mode refuses any other, without quoting it: a static `token` as a
  configuration error, and an access provider's at the dial. Also refused as
  configuration errors (`serverConfigProblems`): a value other than
  `'query'` or `'header'`, named by its kind and never quoted,
  `tokenTransport` on an http(s):// or stdio server, and `'header'` with a
  url that carries a `token` query parameter or userinfo of its own
  (whenever the Bearer header carries a credential, it replaces the
  userinfo's Basic one). A WebSocket dial refuses the first and the last
  of these again, so a dial that skipped the configuration check can't
  fall back to the query.
  In header mode a dial puts nothing in the url's query, so the 0.23.0 note
  on redacting the query a WebSocket dial writes applies only to query mode.
