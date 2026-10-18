- What the model sees of an MCP tool result from a server that isn't an
  MCPL peer (an MCP-only legacy server, or a modern server) now follows its
  content types:
  - text stays text;
  - an inline image stays native when a provider can take it: png, jpeg,
    gif or webp, within 5 MB decoded;
  - audio, binary resources, other images, and media with inline data but
    no type are saved to the workspace (`tool-results/`), each under a
    unique name, with a bounded stub saying where. If a payload can't be
    saved, the result is reported as incomplete (`isError`), noting the tool
    may already have completed, never as a success with part of it missing,
    and the host's log says why the save failed;
  - a failed result is read as its text alone, so there an inline image is
    saved and stubbed like any other payload;
  - a `resource_link` is shown as a link, with its name and URI, and never
    fetched;
  - an embedded text resource shows its text;
  - an unknown block is shown as JSON, bounded, saying how much was left
    out. A malformed entry is named and left out, and content that isn't a
    list of blocks makes the result a failure.

  Before, any non-text block turned the whole result into raw JSON.
  `structuredContent` is kept by presence on the new `ToolResult.structured`
  (`false`, `0` and `null` are values). The model sees it as JSON when the
  server's content has no text block of its own; a structured-only result
  used to reach the model as an empty string. MCPL peers keep their RFC-005
  reading and gain `structured`.
- A script whose tool call returns `structuredContent` receives the
  server's result itself, as one JSON object: `{ content, structuredContent,
  isError, error? }`. From a server that isn't an MCPL peer, `content` is the
  blocks as sent, so images and other payloads survive. `structuredContent`
  is the tool's own JSON, as sent. Content that is present but isn't a
  list of blocks, from such a server, is the malformed result the model
  reads (`isError`, with the malformed notice as `error`), its structured
  content kept, where it was an empty success.
- An MCPL peer's blocks in a script's `content` get the treatment every
  lane the model reads gives them, since what a script prints comes back to
  the model. An RFC-005 reference arrives as the host's reference id
  (`refId`), what the server said about it in that block (`name`,
  `mimeType`, `sizeBytes`, `digest`, `expiresAt`, with control and bidi
  characters stripped from the text fields, as in the model's stub), and
  `savedTo`, the workspace path the framework fetched its payload to for
  the script (`null` when it couldn't; `fetch_reference` takes the id as its
  `ref_id` argument). It arrives without its URI, except a link (MCP's
  `resource_link`) that carries `uri` where the model's line for it shows
  the uri. An unsaved reference that counts as expired isn't fetched.
  Where the model's line for a reference is a stub, the object also
  carries what the stub says in place of advising `fetch_reference`:
  `expired`, the reason, for one that counts as expired, and
  `unfetchable`, the stub's words, for one the fetcher would refuse.
  A block the classifier rejects arrives as the notice the model reads in
  its place, and inline data that also claims a bulk disposition as the
  withheld notice. #181, by @Meganeuridae, first
  found scripts losing `structuredContent`, and it kept the saved paths of
  RFC-005 payloads for them by falling back to the text rendering. Here the
  paths are in the structured object, as `savedTo`.
- If a script's structured result would exceed the 5 MB script cap, the
  framework saves it to the workspace and the script gets
  `{ isError, oversized: { chars, savedTo } }`. If it can't be saved, the
  script gets a failure that says the tool may have completed. Results
  without structured content keep the existing script contract.
- A result that can't be converted to JSON, such as a cyclic object or a
  `BigInt` from an in-process module, reaches the script as an error that
  names the tool and says the call itself completed: for a structured
  result, the object above with `content: []`, `structuredContent: null`,
  `isError: true` and the `error`, and `Error: …` otherwise. Before, the
  script got the runner's bare error, such as `Converting circular
  structure…`.
- The `code_execution` tool's description now says what a script's tool
  function returns: the text, or for a structured result the JSON object
  above, with references and the oversized form. These two changes, and an
  end-to-end test with real Python adapted from #181's, come from
  @Meganeuridae's review of this change against #181.
- The direct tool path (`executeToolCall`, `ModuleContext.callTool`) adds
  `structured` to an MCP tool's result, success or failure, when the server
  sent `structuredContent`. A modern server's result reaches it as an MCPL
  server's does: an error result is a failure with its text, and a success
  is the server's content array as `data`.
- Closing a stdio MCP/MCPL server now waits for the child to exit, sending
  SIGKILL after 2 s. A child still alive 2 s after SIGKILL fails `close()`
  with an explicit error. Before, close returned as soon as a signal was
  sent. `stop()` still finishes shutting everything else down after such a
  failure, and then rejects (see the breaking notes). Concurrent `close()`
  calls share one teardown, and a
  later call re-checks a child that couldn't be reaped. A launch whose exit
  can't be confirmed is never orphaned, and nothing launches beside it:
  - `McplServerConnection.connect()` and `connectWithReconnect()` throw the
    new `McplUnreapedLaunchError`, whose `connection` owns the launch; its
    `close()` retries the reap. A reconnect attempt halts the loop instead
    (`reconnect-failed`, `permanent: true`). Reconnect attempts run one at
    a time, and never start before the previous child has exited.
  - `reconnectAfterFailure()` on a connection without reconnect ends it
    with `close()`, so a child it can't reap stays owned.
  - `close()` during a reconnect handshake ends that launch before it
    resolves, a WebSocket dial still opening included. In the framework,
    `stop()` and a disconnect of the id end a first connect still in its
    handshake the same way, and a WebSocket dial still waiting for its
    access provider: `connect()`, `connectWithReconnect()` and
    `McplServerRegistry.addServer()` take an optional `AbortSignal`, and an
    aborted `connectWithReconnect()` makes no retry stub.
  - `McplServerRegistry` holds an id until its child is confirmed exited:
    `removeServer` frees it only once the close succeeds, a second
    `addServer` for an id still connecting is refused, and `closeAll()`
    keeps each connection it couldn't reap, reporting every failure.
  - In the framework, a disconnect or failed connect whose cleanup can't
    reap the child keeps the server registered, closed and listed as
    disconnected, and its error says so; its tools leave the agents' list.
    A connect for that id is refused until a disconnect, retried once the
    child is gone, confirms the exit and completes the removal. A failed
    startup connect that leaves such a child raises the `mcpl-down` ops
    alert.
- One owner per server id, across both families: a connect is refused while
  another connect for that id is in flight (a legacy handshake included) or
  a disconnect is still tearing it down. A disconnect closes a registered
  connection immediately, and a legacy connect still handshaking is cleaned
  up when its handshake settles (a modern connect in flight, or such a
  legacy one, fails with "was not connected"); then it removes what was
  registered. A teardown never removes what a later connection registered.
  `restartMcplServer` refuses, before it tears the running server down, what
  its connect would refuse: whatever the configuration check refuses (such as
  an unusable binding, userinfo on an http(s) url, or MCPL policy that asks
  for what a modern server lacks), a new id another server holds, a tool
  prefix another server or a module holds or that meets another server's, a
  framework whose `stop()` has begun, and a connect or disconnect of the
  server in flight. Before, a restart disconnected first,
  so a refused connect left the server gone; now the server keeps running.
  From those checks through its connect, the restart holds the id and the
  tool prefix it moves the server to: a connect or a restart started
  meanwhile is refused them, or a prefix that meets that one, and a module
  added meanwhile is refused that prefix, each naming the restart, rather than taking them while the old
  server is torn down. The id and prefix it moves the server from are free
  once its disconnect is done. A disconnect of the id it moves the server
  to (its own, for a restart under the same id), or a `stop()`, that begins
  during the restart ends it, as a disconnect ends a connect in flight, and
  the restart's error says the server is down. A restart whose connect
  fails leaves the server down, configured under the new configuration and
  its id, and holding its tool prefix, as any failed connect does: it's
  listed as not connected, and a restart or a disconnect under that id
  tries it again or removes it. `addModule` also refuses a name a
  server's tool prefix holds, as `create()` does at startup. A disconnect
  releases the tool-prefix claims its own server holds. Treat a submitted
  configuration as immutable while the server uses it: change settings with
  `restartMcplServer(id, newConfig)`, and rotate a network server's
  credentials through `accessProvider` (a stdio server's changed `env` goes
  through a restart with the new configuration).
- A server configuration naming no usable transport is now an error before
  anything is spawned or dialed. That covers a `transport` that doesn't
  match the url's scheme, `transport: 'http'` without a url, and an
  unrecognized scheme. `McplServerConnection.connect()` and
  `connectWithReconnect()` apply the framework's whole check (so `protocol`
  on a WebSocket url is refused too), and a configuration error is never
  turned into a retry stub. `openTransport()` and `isWebSocketTransport()`
  decide by the same rule, so an http(s) url is never dialed as a WebSocket.
- A configuration error, a WebSocket dial failure and `listMcplServers()`
  show a server's url redacted, since a credential may ride in it: no
  userinfo, each query parameter's value replaced, and so is a path
  segment that looks like a credential (16 or more characters with a
  digit, as a token or uuid has, or 32 or more of anything), such as the
  per-user secret some hosted servers put in the path. A url that doesn't
  parse isn't shown. An `accessProvider` that throws is logged by
  its error's class and its message's length, not its text, which may quote
  the credential.
- `listMcplServers()` lists a configuration that connecting would refuse
  with `refused`, which says why and is the verdict to read. Its `family`
  and `transport` are null only when the configuration names no usable
  transport, where the listing guessed a legacy binding before. A usable
  binding refused for something else, such as an https url with
  `requestTimeoutMs: 0`, keeps them. Its `policyEstablished` is null for a
  modern server, which has no MCPL policy.
