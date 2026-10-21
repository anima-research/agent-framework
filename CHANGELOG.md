# Changelog

Notable changes to `@animalabs/agent-framework`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time — see
[CONTRIBUTING.md](CONTRIBUTING.md#changelog).

Releases up to and including 0.7.3 predate this file; for their contents see
`git log` and the
[releases page](https://github.com/anima-research/agent-framework/releases).

## Unreleased

## 0.23.2 — 2026-10-20

### Fixed

- A channel server can no longer set the metadata keys that only the host writes on a stored message. A `channels/incoming` message's `metadata` and a push event's `origin` are now stored without `system`, `kind`, `draftOwner`, `draftIds`, `tuneOut`, `coalescingSubject`, `deferredWriteId`, `external` and `openaiResponsesItems`, and the host writes its own after them, as it already did for the inbound source envelope. A key is in that set when only the host writes it and some reader takes it on its own as what the message is. Until now a server's copy of one was stored wherever the host wrote none, so a server's message could pass for one the host wrote: with `kind: "discord-send-failed"`, a message left unread in a conversation fork's window made the host tell the primary, when the fork was released, that the fork's reply had failed (#611).

  The first time a server sends one of these keys, the host logs the server and the key, without the value, once for each server and key until it restarts. Every other key a server sends, such as `tags` or `mentioned`, is stored as before, beside the fields the host writes itself. Messages stored or queued before this change keep what they were stored or queued with.
- A message that arrives while an agent's tools run now reaches membrane, at the tool boundary, as its participant and content alone. Its stored metadata stays the host's record, whoever wrote it.

## 0.23.1 — 2026-10-19

### Fixed

- An agent's request no longer carries the `tokenEstimate` the framework
  stamps on the thinking blocks it stores. Membrane sent a
  `redacted_thinking` block to Anthropic and Bedrock with every field it
  had, and the Messages API refuses a block carrying a field it doesn't
  define ("Extra inputs are not permitted"). So once the framework stored a
  stamped `redacted_thinking`, every later request carrying that turn was
  refused. A framework turn's request and the direct API's (`runInference`)
  now drop the stamp from the compiled messages. The stored block keeps it,
  and context-manager still prices the block by it.

## 0.23.0 — 2026-10-19

### Breaking

- `onChannelAutoOpened` with `source: 'subscription-policy'` now reports a durable admission decision before transport reconciliation. Treat it as intent; await the registration call and inspect `getOpenChannels()` when confirmed live state is needed. `opened-by-delivery` reports a delivery that opened a channel not already decided open or tuned out, once its transport is confirmed; a delivery that only reconfirms the transport of a channel that was isn't reported. The built-in host notice now distinguishes selected-for-opening from currently open.

- **Operators:** two MCPL servers whose `toolPrefix`es meet are refused, at
  `create()`, at a runtime connect and at a restart (before it disconnects
  anything), with an error naming both servers, both prefixes and the rule
  (#265). Two prefixes meet when one is the other's followed by `-`, or
  begins with the other's followed by `--`, as `foo` and `foo--bar` do. Their
  servers could give one tool name: `foo` listing `bar--echo` and `foo--bar`
  listing `echo` both gave `foo--bar--echo`. Such a name reached the model
  twice, which membrane's native formatter and Anthropic's API refuse, so
  every inference of an agent offered it failed, and in XML tool mode its
  calls reached whichever server listed it last. A configuration with such a
  pair needs one of the two prefixes changed, such as `foo-bar` for
  `foo--bar`. `foo` beside `foo-bar` or `foobar` is fine.

- **Hosts:** explicit `allowedTools` lists must name each permitted utility as `module--utility`, or use `"all"`. Utilities aren't tools of their own: an agent's model and its scripts are offered them only through `utils`, whose `run` checks the utility's own name. An agent that should use a utility lists both `utils` and `module--utility`. The name alone passes the dispatch check for any call by that name, whether the host makes it with `executeToolCall` on the agent's behalf or the model or a script makes it without being offered it. `utils` alone no longer exposes a usable slot. When utilities are registered but none are permitted, `list` returns a failed `ToolResult` with both counts and migration advice instead of listing every registered utility, as earlier releases do. The slot is hidden in that case, and explicit lists containing `utils` log one warning per Agent instance. Hosts that construct depth-limited lists can obtain the existing namespaced utility catalogue through `getAllUtilities()`. Callers using `"all"` retain the permission policy; an empty registry continues to omit the slot and return a successful empty list. Hosts that drive `createEphemeralAgent` results themselves must use `runEphemeralToCompletion` to register and run them; framework-created identities have tool authority only while registered, and calls before a run or after retirement fail with a registration error. Adopt this change with the first connectome-host release after 0.10.2, which contains https://github.com/anima-research/connectome-host/pull/191.

- **Operators with `codeExecution` enabled:** the python interpreter that runs model-authored scripts no longer inherits the host's environment, and it starts in its own runtime directory instead of the host's working directory. It gets the allowlist stdio MCPL children get (#175), `CHILD_ENV_ALLOWLIST` in `src/mcpl/transport.ts`, among them `PATH`, `HOME`, the locale, temp directories, CA bundles and proxy variables, whose URLs can carry credentials. Then come `codeExecution.env`, and last `PYTHONUNBUFFERED=1` and `PYTHONIOENCODING=utf-8`, which the runner sets over any declared value.
  - **What stops arriving:** every host variable outside the allowlist, such as `PYTHONPATH`, `VIRTUAL_ENV`, `PYTHONHOME`, `LD_LIBRARY_PATH`, `PYTHONUTF8` and `ALL_PROXY`, and any credential a script read from `os.environ`. To get one back, list it in `codeExecution.env`, which a recipe can `${VAR}`-substitute from `.env`. `codeExecution.inheritEnv: true` restores the whole environment, and with it hands every host variable, provider keys included, to model code and to every subprocess a script starts.
  - **Relative paths** now resolve in the runtime directory, which teardown removes, best effort, whenever the interpreter stops or is reclaimed: a script's relative reads and writes; a relative path in `codeExecution.env`, such as a `PYTHONPATH` entry; a relative value of an allowlisted path variable, such as `TMPDIR` or `SSL_CERT_FILE`; and a relative `PATH` entry that a bare `pythonPath` is looked up on. A file a script reads from the host, or writes to keep, needs an absolute path, as does a path in `codeExecution.env` or in an allowlisted variable. To give scripts somewhere durable, pass its absolute path through `codeExecution.env`, such as `"AGENT_FILES": "/srv/agent/files"`, and name the variable in the agent's prompt.
  - **Direct `PyRunner` users:** `PyRunnerOptions` gains `env` and `inheritEnv`, and a runner built without them gets the allowlist. Only `inheritEnv: true` passes the whole environment, and these options aren't checked as `create()` checks `codeExecution`'s.
  - **A misread configuration is refused at create:** an `inheritEnv` that isn't `true` or `false`, such as a quoted `"true"`, which would quietly keep the allowlist; an `env` that isn't an object of strings; and a variable name that is empty or holds `=` or NUL, or a value that holds NUL. A `null` `inheritEnv` or `env` counts as left out.
  - **Unchanged:** a `pythonPath` with a separator, which still resolves from the host's working directory, and which a venv's interpreter needs no `VIRTUAL_ENV` for, since it finds its prefix and site-packages itself. The allowlisted variables keep their values too, so an absolute path among them names what it did, and a relative one resolves as above. The allowlist limits what model code inherits, not what it can read: on Linux a process running as the same user can still read the environment the host and its MCPL servers started with, through `/proc/<pid>/environ`, and can open the host's files, `.env` included, by absolute path.

- **Hosts that set `processLogging.broadcast` or an agent's `refusalHandling.announceHumanTurns`, or read either back:** both settings are removed. In no release has either changed what the framework does, beyond `isProcessLoggingEnabled()` reporting `broadcast` back: `process:completed` trace events are emitted whatever `broadcast` says, and 0.6.2, the first release with `announceHumanTurns`, already shipped without its one reader. `isProcessLoggingEnabled()` now returns `{ persist }`.
  - **Migration:** delete either setting from your config, and drop any read of `isProcessLoggingEnabled().broadcast` or of `announceHumanTurns` on an agent's `refusalHandling`. In TypeScript, an object literal checked against the framework's types, such as a config passed straight to `create()`, no longer compiles while it names either setting, and neither does such a read. In plain JavaScript, `isProcessLoggingEnabled().broadcast` reads `undefined`.
  - **Unchanged:** a config that still sets either starts as before, with the setting ignored.

- **MCPL/MCP server authors:** the legacy engine now enforces the revision it
  speaks. `McplServerConnection` offers MCP `2024-11-05` and now also requires
  it back: an `initialize` result with any other `protocolVersion`, or with
  none, fails as `McplProtocolVersionError` (`kind: 'mismatch'`), stating what
  each side said. Every server family probed answers `2024-11-05`, but a
  hand-written server that omits the field must add it. An `initialize`
  answered with JSON-RPC `-32022` fails as `McplProtocolVersionError`
  (`kind: 'rejected'`), keeping the server's `supported` list, code and data.
  When that list names modern MCP, the message says to configure the server
  with `protocol: 'modern'`. A protocol-version verdict is never retried: no
  reconnect stub, and a reconnecting connection stops its backoff loop
  (`reconnect-failed` carries `permanent: true` and raises the ops alert at
  once). At startup the verdict raises the same `mcpl-down` ops alert, so a
  server refused for its revision doesn't drop out with only a log line. The
  established revision is on `connection.protocolVersion`.
- `tools/list` now follows `nextCursor` across pages, so a paginating server's
  whole inventory reaches the agent; before, every page after the first was
  silently dropped. A repeated cursor, or more than 100 pages, is an error
  rather than a partial inventory.
- **Hosts and operators:** a server configuration with both `command` and
  `url` and no `transport` is now refused before anything is spawned or
  dialed. Before, it was launched as stdio and the url was silently
  ignored. Migration: drop the field you don't use, or set `transport` to
  say which one is used. Unchanged: a configuration with only one of them,
  or with both and a `transport`, resolves as before (a host can still
  layer a url and `transport: 'websocket'` over a file's command). A legacy
  `requestTimeoutMs` above 2^31−1 is refused too: Node ran it as a timer of
  about 1 ms, so every request timed out at once. Every value that worked,
  `0` included, passes.
- **Hosts:** `stop()` now rejects, after its whole teardown, when an MCP
  server's child couldn't be confirmed exited, naming each such child and
  its server. Before, closing a stdio server returned as soon as a signal
  was sent, so `stop()` never failed for this. Code that chains work on
  `stop()`, such as exiting a TUI or switching sessions, should catch that
  rejection: the framework is stopped either way. As with any failed
  teardown, an owned store stays open, and a later `stop()` retries the
  reap, completing once the child has exited.

- **Module authors:** a module tool's call is refused before its handler
  runs when it lacks a key the tool's `inputSchema` lists in `required` (a
  key given as `null` counts as lacking it, unless its declaration admits
  `null`, by a type list naming it or `nullable: true`, or it has no `type`
  at all), or when its input is there but isn't an object. **Who
  needs to act:** a module whose handler runs without a key its schema
  requires, since calls that leave the key out ran before and are now
  refused. **Migration:** if the key is optional, drop it from `required`
  and give its default in the property's description; if your handler
  needs it, keep it required: calls without it are now refused before your
  handler runs, telling the agent what to send. **Unchanged:** a module
  tool's values (types, enums, nested shapes) are still the handler's to
  check, while a run through the `utils` tool has its values' types and
  enums checked, as it always had; an absent input (`undefined` or `null`)
  still reaches a tool that requires nothing; a name the module answers
  but doesn't declare goes on unchecked; MCPL servers' tools keep their
  servers' own checks. Where a required key is missing and the schema
  declares its keys only in `properties` and `required`, the refusal also
  names keys the call gave that it doesn't declare, since a key sent under
  another name is one way a required key goes missing; such keys are never
  refused for themselves. connectome-host needs no change:
  its tools of this kind keep those keys required, since each such call
  did something its agent didn't ask for, such as starting a subagent
  named "undefined", or one with no system prompt, which was accepted and
  then failed once its run began.

- **Hosts whose config gives two agents one name:** `create()` now refuses the config, naming the name and each agent's place in `agents`, before it opens the store. Until now the last agent of a name took the others' place in the framework's registry, though all of them used the name's one context log, and an earlier one could still decide two things: whether the name was the primary agent, which is the first configured agent's name, and the name's tool presentation, when only an earlier agent of the name set one. Keep one agent of each name. An agent you rename starts a new context log and its recipe's settings, since both are kept by name, and still reads the residents' shared messages. Names compare exactly, so `Dup` beside `dup` is still two agents, though the history tool's author filter matches their own turns without letter case and can't tell them apart there.

- **Code that sets or reads `InferenceRequest.ephemeralSystemPrompt`:** the
  field is removed. It carried a system-position prompt for one turn; the
  silent heartbeat was its only producer, and its instruction now rides the
  tick's request-only separator. There is no replacement: a system prompt
  that changes for one turn costs that request its prompt cache from the
  system on, and changes what every retained signed-thinking block is bound
  to. Nothing in this package or in connectome-host sets or reads it.
  Unchanged: `suppressProse` and `silentHeartbeat` on `InferenceRequest`.

- **Operators:** on Linux, a workspace mount's watcher holds the mount's root
  directory open while it watches it, so it can tell whether that directory
  has been removed whatever has since been made at its path.
  - **What stops working:** `umount` of the file system under a watched
    root fails with "target is busy" while the host watches it. Stop the host
    first, or use `umount -l`, which still detaches it.
  - **What gets slower:** a root removed, or replaced by a rename over it, is
    found at the watcher's next root poll (`watchRootPollMs`, 2 s by default)
    rather than at once.
  - **Unchanged:** where the watcher can't hold the root (macOS, Windows, or
    on Linux a root it can't open as a directory), it holds nothing open, as
    before. On WSL 2, Windows programs can still rename or remove a watched
    folder on a Windows drive.

- **Operators whose mounts hold symlinks inside them:** on a mount that doesn't set `followSymlinks: true`, the default, a file reached through a symlinked directory inside the mount is no longer read, written or synced through the link. A file a host reads from disk behind such a link, such as an agent's instructions file, is refused, with a refusal that names the link. To keep using it, use the path through the link's target, which the refusal names, or for a link into another mount's directory, that mount's path; or, for a link to a directory inside the mount, set `followSymlinks: true` on that mount; or move the file so that no directory on its path is a link. Unchanged: a link leading out of the mount, and a file that is itself a link, are refused as before.
- **Hosts and module authors choosing advice by a disk read's code:** `readFileFromDisk` refuses a link among a path's directories with a new code, `parent_symlink`, which `WorkspaceReadErrorCode` gains, and one into a nested mount's directory with `other_mount`, the code that mount's own paths get. A link leading out of the mount keeps `escape`, and a file that is itself a link keeps `symlink`.

### Added

- Connecting to an MCP server warns once when a credential would cross the
  network unencrypted, to an `http://` or `ws://` url whose host isn't this
  machine: its `token` or `accessProvider`, or a secret the url carries
  itself (a `ws://` url's userinfo, a query parameter whose name says
  credential: `token`, `key`, `secret`, `password`, `auth` or `signature`,
  or whose value is shaped like one under a plain name, a query parameter
  name that may itself be one, or a path segment that looks like one, as
  the redacted url judges it). A name that may itself be
  a credential is counted in the warning, never quoted. An `http(s)://` url
  with userinfo is refused instead, since the HTTP client can't send it and
  its error would quote it. Loopback hosts are
  exempt, and so are the unspecified addresses `0.0.0.0` and `[::]`, which
  reach this host too. It warns rather than refuses, since a private network
  or a TLS-terminating proxy can make that deliberate.
  `serverConfigWarnings` is exported beside `serverConfigProblems`, so a host
  can apply the same check in its own configuration validation.

- Modern MCP servers (revision `2026-07-28`) can now be configured beside
  MCPL ones, through the official SDK 2.x client. A server's URL decides its
  family: `ws://`/`wss://` stays MCPL (MCP `2024-11-05`), and
  `http://`/`https://` is modern MCP over Streamable HTTP. A stdio server
  stays legacy unless its config sets `protocol: 'modern'`. A modern server's
  tools use the same prefix, tool policy, RFC-008 class hints and dispatch
  paths as any MCPL server's, and its tool prefix meets the same rules: it
  can't be a module's name or another server's prefix, or meet another
  server's, whichever family either server is. It has no MCPL surface: no grant, push,
  channels, inference requests, quiesce plane or awareness gate. MCPL policy
  that asks for that surface on one is a configuration error, such as
  `allowHostCommands: true` or a scope's non-empty `whitelist`. Policy that
  only takes something away or repeats a default, such as
  `disabledCapabilities` or an allow-list like `enabledFeatureSets`, is
  accepted as already satisfied, so a host that puts a deny-list on every
  server it deploys can deploy a modern one. A modern `requestTimeoutMs`
  outside 1..2^31−1 is a configuration error too, since 0 means "time out
  now" to the SDK. Details:
  - **stdio:** runs through the framework's own spawner (env allowlist,
    `inheritEnv`, stderr lines including startup), launched once per connect.
  - **HTTP credentials:** come from `token`/`accessProvider`, as a cached
    bearer refreshed once on 401.
  - **Deadline:** each call gets one `requestTimeoutMs` deadline across every
    leg and the pauses between them. At the deadline cancellation is
    requested for a leg in flight (between continuation rounds none is), the
    outcome is reported as unknown, and nothing is replayed.
  - **Failures:** reported as `McplRequestError`, with the outcome taken from
    what actually crossed the transport: `not-sent`, `error-response` (HTTP
    401/403 with `data.httpStatus`) or `no-response`. Only an error or a
    `complete` result is a final answer: a call that ends after an
    `input_required` answer, or after a result type this revision doesn't
    define, is `no-response`. A complete result that can't be used is a
    plain error. The message an agent reads is the one an MCPL server's
    failure gives where the two share an outcome, and has its shape where
    they don't: what happened, whether anything took effect, and what works
    from there. The method, the tool, the JSON-RPC code and the HTTP status
    go to the host's log. A tool call made while the server's connect is
    still under way reads as one made while an MCPL server connects.
  - **Lifetime:** reconnects use the legacy backoff settings. A tool-list
    change subscription is kept open, reopened if refused or lost, and its
    changes go through ordinary admission, so they park under quiesce like
    any wake. `close()` and `stop()` end any connect in flight. A
    `ModernMcpConnection` starts once: a second `start()` returns the first
    call's promise. When a stdio launch's first attempt fails and its cleanup
    can't confirm the child exited, `ModernMcpConnection.connect()` throws
    `McplUnreapedLaunchError`, whose `connection` owns the launch; its
    `close()` retries the reap.
  - **Status:** `listMcplServers()` entries gain `family`, `protocolVersion`
    and `transport`.
- A server lost for good (it closed and won't reconnect), MCPL or modern,
  now leaves the agents' tool list, as a disconnected one does. So does one
  whose reconnecting halts for good (`reconnect-failed` with
  `permanent: true`, which also raises the ops alert). An MCP tool
  result marked as an error is traced as `tool:failed`, on both engines.

- **A `code_execution` script can test a result for an error, and read its
  structured content, without parsing.** Each tool function's string is
  unchanged, and carries two attributes beside it: `.is_error`, `True` for an
  error result (a failure the framework reports as `Error: …`, or a
  structured result whose `isError` is true) and `False` otherwise, and
  `.structured`, the parsed `structuredContent` of a structured result's
  JSON object, or `None`. A result whose text merely starts with `Error:`
  reads `False`. The string is now a `str` subclass, so code that uses it as
  a string keeps working, `json.loads` and `isinstance(r, str)` included,
  while an exact type check such as `type(r) is str` now reads `False`, and
  a result a script pickles loads only in the script runtime.
  `PyRunner`'s `onToolCall` may return a `ScriptToolResult` (exported) to
  set both, or a plain string as before, for which both read `None`.
  `code_execution`'s description changes, so the first request after the
  upgrade that carries it misses the prompt cache from its tool block on.

### Changed

- `getActiveTurnTrigger` returns the trigger of a turn that a coalesced batch woke without the host-owned `coalescingSubject`, `coalescingBatch` and `coalescingBatchSubjects` while that turn is retried: an in-turn retry, a provider hold's release, a requeue behind an auxiliary call, or the tool-result guard's restart. Those fields identify a wake for withdrawal while it is unconsumed, and a retry belongs to a turn that has already passed its batch gate. A turn whose merged wakes don't all share one subject shows no `coalescingSubject` either. Its other fields, such as `reason`, `source`, `channelId` and `counterparty`, are as before.

- `fetch_reference`'s failures now say what happened to the reference and what calling again can do: `fetch_reference couldn't fetch "<ref_id>": <what happened>. <what calling again can do>`, where they gave the fetcher's reason alone, such as `HTTP 404`, `fetch timed out or aborted`, `claimed <n> bytes exceeds fetch ceiling <m>` or `third-party origin (<origin> != dialed <origin>); not fetched by this host`. Where `save_recent_image` says a reference can't be fetched, it gives the same two.
  - **What happened** names the server and what it answered (`the "<server>" server answered HTTP 503`), the limit a fetch met (`it claims <n> bytes, over the <m> bytes this call allows`, `the download had reached <n> bytes, past …`), what kept a fetch from dialing (`it points to <origin>, not to the "<server>" server's own address (<origin>), and this host fetches only from the server itself`), or that what arrived didn't match the reference's digest or couldn't be stored. The eager fetch's and a script's fetch's log lines read the same words.
  - **What calling again can do**, such as trying again later (after a timeout, 408, 409, 423, 425, 429, or a 5xx other than 501 and 505, and after a failed request, with whoever runs the host to check its connection to the server if it fails the same way), waiting for a fresh reference to it (an expired or unbound reference, and the other 4xx), passing a larger `max_bytes` (naming the size it needs, and no more than the server's fetch budget has left), asking whoever runs the host (who can check its credentials for the server after a 401 or 403, raise or renew a spent budget, or add back a server it no longer has), or nothing, as for an address on another origin, a server this host doesn't connect to over a network, or a claim past the 256 MiB this host fetches at most, which no `max_bytes` or setting lifts. A claim past those 256 MiB is refused for them first, and a download past them is stopped for them first, whatever the server's budget has left.
  - **The budget's texts** read `this host's fetch budget for the "<server>" server is used up (<used> of <budget> bytes)` and, partway, `this host's fetch budget for the "<server>" server ran out during the download (<total> of <budget> bytes), so it was stopped and nothing was kept`, where they read `per-server fetch budget exhausted (<total>/<budget> bytes)`, the one partway after `aborted: `.
  - **A `ws:` or `wss:` reference** on its server's own origin is refused for its scheme before anything is dialed, where `fetch` refused it before connecting and the agent read `fetch failed`. A server whose address doesn't parse is refused, saying so, and that whoever runs the host can correct it.
  - **The host's log** says why a fetched payload couldn't be stored: no workspace, no writable mount, or the write's error. A save that throws is that failure too, logged, where its message reached the agent as the fetch's own error.

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
  the model. An RFC-005 reference arrives without its URI, as the host's
  reference id (`refId`), what the server said about it in that block
  (`name`, `mimeType`, `sizeBytes`, `digest`, `expiresAt`, with control and
  bidi characters stripped from the text fields, as in the model's stub),
  and `savedTo`, the workspace path the framework fetched its payload to for
  the script (`null` when it couldn't; `fetch_reference` takes the id as its
  `ref_id` argument). An unsaved reference that counts as expired also
  carries `expired`, the reason the model's stub gives, and isn't fetched.
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

- The MCPL texts an agent reads for a failed request, a refused tool call and a block the host can't show now say what happened, whether anything took effect, and what works from there, or that nothing does. Method names, request ids, JSON-RPC codes, close details and field names leave them. The ones an operator needs go to the host's log.
  - **A failed MCPL request:**
    - A connection that closes with a call pending reads `The connection to the "<server>" server closed before it answered, so whether the request took effect is unknown.` It then says whether this host is reconnecting, where it read `MCPL server "<server>" disconnected unexpectedly (code=…, signal=…, reason=…) while awaiting <method> (id=N)`.
    - The other texts change the same way: a close by this host, a request on a closed connection or one the transport couldn't write, a server's error answer (in the server's own words, or, with none, saying the outcome is unknown) and a timeout.
    - The log gains a line for a close with requests pending, with the close's code, signal and reason, whether this host closed it, and the requests left unanswered; one for a server's error answer, with its method, id and code, and its message, whatever JSON value it is, with any credential the server's configuration holds replaced, where the caller's text keeps the message unredacted; one for a timeout, with its method and id; and one for a request the transport couldn't write, with its method, id and the transport's words.
  - **The framework's MCPL tool calls:**
    - A call to a server missing from the registry, or to a tool its policy denies, says it didn't run and whether anything can change that, in the same words for the model's call and a script's. One made while this host is connecting to the server, in a runtime connect or a restart's, says so and to try again in a moment.
    - An error result with no text, or only whitespace, reads as one whose effect is unknown, where it read `Tool call failed`, or the blank text.
    - A conversation's `channel_open` is told where to reply.
  - **Blocks the host can't show** read as what they were and why: `[Image not shown: …]`, `[Audio not shown: …]`, `[Reference not shown: …]`, `[Content not shown: …]`, and the text marker `[Text not shown: a text part arrived without readable text.]`. They had read `[Image: no data]`, `[unrecognized content block: …]`, `[inline content withheld: …]` and `[Text not shown: the server's text block had no string text.]`. An image or audio block with an empty link and no data reads as the no-data marker on the tool-result lane too.
  - **A reference's expiry and missing server** read `expired`, `treated as expired, since its expiry time can't be read`, `treated as expired, since its expiry time isn't in a form this host accepts` and `not tied to any server, so there's nowhere to fetch it from`. They had read `expired: its expiresAt has passed`, `… (fail closed)` and `unbound: no server is recorded to fetch it from`.

- A silent heartbeat tick's instruction now rides the tick's request-only
  separator instead of a system-position injection, so a tick's request
  carries the agent's own system prompt, like every other turn. A system
  prompt that changed for one turn cost the heartbeat's request its prompt
  cache from the system on, and on a provider that binds signed thinking to
  the prefix it was minted under (context-manager #155) it failed every
  retained thinking block in that request, and the tick reply's own thinking
  at the next ordinary turn. `SILENT_HEARTBEAT_SEPARATOR` is now that
  instruction (199 characters where it was 16, roughly 50 tokens at each
  tick whose rows survive in the window). Each tick's rows now record the
  separator their request rendered (`SilentHeartbeatStamp.separator`), and
  later compiles render that text, so ticks stored before upgrading keep
  their `[heartbeat tick]` marker byte for byte: no stored reply's prefix
  changes. (`InferenceRequest.ephemeralSystemPrompt` is removed; see the
  breaking entry.)
- A tick whose restart compiles none of the tick's rows (a strategy folded
  them all) opens again: the restart's request ends on the separator, where
  later compiles render it before the restart's reply. It used to end on
  `[Continue]`, and later compiles put the separator before a reply whose
  request never held it.
- When a compile ends on the agent's own message and the request gets a
  trailing `[Continue]` turn, the reply's rows (its assistant responses and
  tool results) now record that prompt (`metadata.promptedBy`, a
  `{ turn, text }` pair), and every later request renders `[Continue]`
  again just before the first of its assistant rows that survives, the way a
  silent tick's separator is rendered. A later reply follows the same prompt
  when what it is sent ends on the tool results of a reply that did: a next
  round of the stream, a budget restart, an error retry, or a new process
  reading the stored rows. A reply sent anything else after those results,
  such as a message that arrived at the tool boundary or during a provider
  cooldown, follows that instead and records no prompt. Without the turn,
  later requests merged the reply into the previous assistant message (one
  message carrying signed thinking from two responses, a 400 when it is the
  latest), and dropped a turn the reply's request held, which a provider
  that binds thinking refuses. A reply with neither a tool call nor signed or
  redacted thinking can't be found in a compiled window and merges as
  before. `StartStreamResult.continuePrompt` carries the prompt a stream's
  request ends on (new, optional); the agent sets it. The direct
  `runInference` paths compile without these request-only turns, as they
  did without the tick separator, so their replies render none.

### Fixed

- Failed backscroll requests preserve the registry's known-open state rather than claiming a close. Automatic delivery joins pending lifecycle work without reopening a channel closed during the wait. A delivery or reply is announced as opening a channel, with the current registration label, only when the channel wasn't already decided open or tuned out; reconfirming the transport of a channel that was isn't announced. Speech engages a channel decided closed as a reply does, even while a failed close has left its transport open, wherever the server's grant lets the host open it. When `channel_open` fails for a channel that isn't open and is still decided open, its error says the channel stays selected for opening, since that decision outlives the failed round-trip and a later delivery or reconnect tries again.

- Channel lifecycle operations now run in order per channel and reconcile the latest desired state and registration after an in-flight operation completes. Successful reconciliation confirms the current target and desired state at its receipt boundary; a superseded tool request reports that its requested state no longer applies. Automatic delivery preserves active tune-out attention state while opening or awaiting transport. A registration batch reconciles its channels side by side, so one held RPC doesn't delay its siblings. Removing a server cancels its queued lifecycle operations, and the framework removes its channel entries before closing its connection, so nothing queued runs against a closing connection or a later re-registration.

- A channel's transport state is known only from a receipt for its current registration, connection, type, and address. A channel a registration creates or replaces, a retarget, a substitution, or a failed open or close leaves it unconfirmed: failed corrective opens fail joined delivery, while a same-target backscroll failure keeps a channel that was open usable. Incoming traffic confirms nothing unconfirmed (after a retarget it may still come from the old subscription), and it marks a channel open only while that channel is decided open or tuned out, so a close receipt stands. Explicit close, and declining an invitation, close an unconfirmed target for real instead of reporting it already closed. A retarget of a channel decided open or tuned out opens the new target.

- Lifecycle convergence makes at most five transport attempts per operation. Continued descriptor/intent supersession fails with a diagnostic, releases the queue, and gives joined speech or reply preparation a visible failure instead of hanging. Later stable operations can retry.

- A `channels/open` answered for a different channel than the one requested, by the answer's `channel.id` or a history item's `channelId`, compared exactly as the server's traffic is, fails the open. The requested channel isn't marked open (its open state becomes unconfirmed), nothing in the answer is used, its history included, and the host logs `[channel-open-substituted]` and emits an `mcpl:channel-open-substituted` trace, whose `answeredFor` is the answered id as the log line prints it, escaped by `logValue`. When the channel the server opened instead is registered and its desired state is closed, the host closes it again, so its traffic doesn't reach the resident. A substituted answer on a receipt already made stale by retargeting is retried like any stale receipt. An answer that names no channel, by a null id or none, is accepted as before; one whose id isn't a string fails the open the same way, with nothing to close. Either rollout order is safe: on a server that still falls back, the resident sees a failed open for an id that server no longer knows (a deleted channel), rather than another channel's traffic. `ChannelsOpenParams.channelId` is documented as exact: a server that doesn't know the id should refuse.

- A tool name an MCPL server lists more than once reaches the model once:
  the server's first listing is offered and the rest are left out (#265).
  The model's tool list carried the name twice, which membrane's native
  formatter and Anthropic's API refuse. Each tool refresh that finds such a
  listing raises an `mcpl-tool-duplicate` ops alert naming the tools; its
  webhook post goes out at most once per server in 15 minutes.

- A `gate.json` or privileged-users file saved as UTF-8 with a leading BOM
  now loads. Before, `JSON.parse` rejected the invisible U+FEFF, and the gate
  reported an error and didn't apply the file (#395).

- An ephemeral run (a subagent) no longer posts its plain prose to whichever
  channel last received a message (#551). That channel, the process-global
  fallback, was the locus of any `locus` or `hybrid` run with no channel of its
  own, so delegated work, possibly drawn from a DM, could land in an unrelated,
  possibly public channel. No ephemeral run takes the global fallback now,
  whatever its prose routing:
  - a `locus` or `hybrid` run's plain prose with no channel of its own is
    returned to its caller as before and published nowhere; a sleep
    announcement it makes is published nowhere too. Neither counts as a failed
    delivery, so neither writes a `[send-undeliverable]` notice, an
    `mcpl:speech-route-failed` trace or a log line;
  - `channel_publish` without a `channelId` is refused, with words saying to
    name the channel;
  - its channel context has no `incoming` message, and no default outgoing
    channel unless it opened one itself;
  - a refusal of its inference adds no reaction anywhere, and its
    `failures.log` record names no `locus`.

  A channel the run opens itself, and a destination it names in its prose
  (`hybrid`'s `>>>`, `explicit`'s `>>`), still route as before. Residents and
  conversation forks keep the fallback. `channel_publish`'s description now
  says where an omitted `channelId` goes: the conversation's bound channel,
  else the most recent incoming one, and nowhere for a subagent.

- Enforce each registered agent's allowedTools before model, script and public agent-origin dispatch, including utility names inside utils run. Filter utility list/describe to the same executable names. Refused calls retain paired error results without inner lifecycle state. A refusal withholds a call's effect, never the model's choice about its own words: a refused send changes nothing about prose, so its round and what follows go out; a `skip_reply` that a round calls itself (not one a `code_execution` script makes) keeps that round's prose private and silences nothing after it, as a refused wake already did, when the agent's allowedTools doesn't name it, another module's namespaced `skip_reply` included, or when it's the registry's own `skip_reply` asking for a wake this host can't set; and a refused `think` is read as a permitted one is, so the private same-round policy keeps its round private wherever it applies, which is where rounds are routed live. Framework-created identities (ephemerals and conversation forks) have no tool authority while unregistered, including after disposal; genuine unregistered legacy callers and trusted module closures retain their behavior. Prose primers and bounce notices advertise prose_help only when permitted, and `think`'s and `journal`'s descriptions tell an agent to call `skip_reply` only when it may. `think`'s result and `prose_help`'s reference no longer point at the `skip_reply` tool.

- A turn woken only by deferred coalescing batches is withdrawn before inference in more of the cases where it used to call the model with nothing new to read: its batch was retracted or replaced after the wake was taken (the replacement or the retraction's notice wakes agents as any push does, by its own `triggerInference`), its batch was being rendered for another agent's assembly (the turn waits for that render, which the other agent's request reads), or the render was placed in another agent's deferred queue because that agent's turn was running. In that last case that agent is now woken for the render, as the batch's own wake would have woken it; before, nothing woke it for the render. When several agents are woken for one batch, the first assembly consumes it, and the others' turns already taken from the queue are withdrawn, as their still-queued wakes already were. A turn woken by a batch that a provider hold kept after its call failed is now retried with its own trigger when the hold ends, even if a newer batch of its subject arrived meanwhile. Before, the newer batch withdrew it, and the agent's next turn came from the newer batch's wake or, with nothing left held, from a fresh compile that names no channel or author.
- When one agent's queued wakes merge into one turn, the turn's trigger now carries a coalescing subject only when it is every merged wake's, so a withdrawal of that subject's wakes, such as a retraction's or a newer batch's, takes the merged wake only when that subject was its sole cause. Before, the merged trigger carried its first wake's subject, and such a withdrawal, landing while the merged wake was held or requeued before its turn started, also dropped the wake's other causes, such as an ordinary message.

- On a host with no primary (`agents: []`), a write with no target goes to the
  first registered agent, such as an ephemeral run. Deferred, it now names
  that agent in its queue entry, so it is that agent's as a targeted write is:
  the agent's own flushes store it, and so does its window's release when it
  leaves. Before, the entry named no agent, so neither the run's flushes nor
  the run's end took it: after the run it was still queued, unstored, and in
  the recovery file when the queue was persisted.
- Boot recovery numbers the restored deferred-write queue 1, 2, 3, … in the
  order it restores it, and later deferrals are numbered on from there.
  Before, it kept each entry's `seq` and numbered only the entries without a
  valid one, after the largest, so the counter went on from the largest valid
  `seq`: one at `Number.MAX_SAFE_INTEGER`, which boot accepts, gave every
  later deferral the same `seq`, 2^53. A recovery file whose `seq`s are all
  valid isn't rewritten at boot for the new numbers; the queue's next write
  carries them.
- At a tool boundary, a deferred message that the strategy stores as more than
  one message (a sharded body) is now injected as later compiles render it,
  its shards joined. Before, it was injected as given, so a body of more than
  one text block, or with a non-text block after a text block, reached the
  stream in a different shape from later requests.

- Under `proseRouting: "disabled"`, the turn-end receipt now reads `[delivered] plain speech → no channel — N plain-speech segment(s) kept in the transcript (…)` instead of `[delivered] nothing — N plain-speech segment(s) suppressed (…)`, which read to a resident talking with its operator through a console or Web UI as if its replies had reached no one (#225).

- A Discord message is no longer stored twice when its live create and the history sync both reach it. The sync stored a message it fetched while the live path was still converting the message's attachments, or while its create waited to be handled, and the create then added a second row. Now the live path keeps each create on record from the moment it takes the message up until the store shows its row, stored or held (a held write's row shows at once), and the sync stores none of those. A second delivery of a message whose create is still on its way is ignored. A create whose message a sync stored first adds no row, and still sets the reply context and asks for inference as before. Where a message was already stored twice, a live edit and the sync both change its first row, where the sync changed the last, and a delete, live or found by the sync, removes every row of the message.
- A message deleted before its create was handled is no longer stored, and no longer wakes the agent. A delete that came while the live path converted the message's attachments was handled first, found no row, and the create then stored the message. One that came while the create waited in the queue was handled after it, so the agent could be woken by, and answer, a message its author had taken back. Now the create is dropped: no row, no reply context, no inference.
- An edit that comes while the live path converts the message's attachments is no longer lost. It was handled before the create, found no row and was dropped, so the message kept the text it was sent with until the next history sync. Now it's folded into the create.
- An edit that removes an attachment now removes its block from the stored message. The client passed an edit's text alone, so the image, file text or note of an attachment the edit took away stayed in the row until the next history sync, which runs when the client becomes ready. The client now passes the edit's attachments, for a message discord.js had cached, and a message stored with its text first drops the block of each attachment it no longer has: an image by its URL, a file's text by its header and a note by the filename it opens with, whatever its words after it. A block that may stand for an attachment still there stays, such as one of two files of one name. An edit that adds an attachment, which Discord's API allows, is still left to the history sync, as is a message stored before its text came first.
- A stopping module writes nothing. A create still converting attachments when the module stopped reached the stopped module's context and failed with a TypeError, in a promise nothing awaits. Now nothing is written for it, nor for a message that arrives or an event the framework hands the module while it disconnects.
- Host authors: `DiscordClientInterface.onMessageEdit`'s handler takes an optional third argument, the edited message's attachments as the edit left them. A custom client that passes two arguments keeps today's behaviour: a stored message keeps its attachment blocks on such an edit. `DiscordEditEvent` gains the matching optional `attachments`.

- **The workspace's disk reads refuse a mount root that isn't the mount's
  directory.** `readFileFromDisk`, `readBinaryFromDisk` and `read_image` read
  whatever was at a mount's root path, so a root renamed away and replaced by
  a link to another directory, or by another directory, was read as the
  mount. Once the workspace has recorded the root's identity, with the first
  evidence it gathers there, such a root is refused as `mount_unavailable`,
  in the words a sync uses for it, until a sync with `acceptRoot` takes it.
  A root that is gone, or is a file, is `mount_unavailable` too, with errno
  ENOENT or ENOTDIR, where it was "File not found". A root that changes
  during a read, until the file has been opened and checked, gets the same
  code and errno as one changed before the read.
- **`readBinaryFromDisk`'s `maxBytes` bounds the read itself.** A file that
  grows past it after the read's size check is refused as "File too large",
  having loaded at most `maxBytes` bytes and one more, where it was read
  whole.
- **Two opens no longer wait on a FIFO.** A directory's sync after a push
  opened the directory blocking, so a FIFO put at its path held the sync
  until something opened it for writing. The tool presentation file's read
  did the same, synchronously, holding the whole process. Each now opens
  without waiting, and refuses what isn't a directory or a regular file.

- `WorkspaceModule.readFileFromDisk` and `read_image` no longer wait on a FIFO in a mount until something writes to it. They refuse a FIFO, socket or device without opening it, with "Not a regular file: <path>" (`readFileFromDisk` with the code `not_found`), where they waited for a writer on a FIFO and gave other words for a socket or device. One reached through a symlink the mount follows is opened without waiting and refused the same way.

- A reference whose address carries a user name or password is refused before anything is dialed, in words that don't repeat them. `fetch` refused such an address before connecting, with a message holding the whole address, password included, which `fetch_reference` gave the agent as its error, and the host's log carried it when the eager fetch tried it.

- Notices about an agent's own action now reach the window that agent reads, deferred against that agent's own turn, stream and tool cycle (#188). Exceptions: a failed reply its speaker will never read, and a channel an ended agent's send opened, are told to the primary by name; any other notice for an agent no longer registered goes nowhere, logged.
  - The notices: a failed reply (`[discord-send-failed]`), bounced prose (beside its `{{unsent}}` clipboard), the notices about the agent's drafts (a draft held at once, an `{{unsent}}` that names nothing or a draft it can't send, a resend whose outcome couldn't be recorded, and `>>skip_reply {{unsent}}`'s), a background script's wake, and a channel opened by the agent's own send. A channel opened by subscription policy, with no agent behind it, is still announced to the primary.
  - A conversation fork's or an ephemeral run's notices land in its own window instead of the primary's. In connectome-host this moves a subagent's notices from the primary, where the default path put them, to the subagent.
  - A resident's notices are addressed to it too, in the slot the residents share, and wait on its own turn rather than the primary's. Whether it may land there while another resident's turn is alive is the question of #291.
  - When a fork or an ephemeral run is released, each failed-reply notice it never read is passed to the primary, once, by name, in the words of the speaker's own notice: "A reply by `<name>` (N chars) could not be delivered to … (…). Nothing was posted. `<name>` has ended.", or, for a delivery that wasn't confirmed, "Delivery of a reply by `<name>` (N chars) to … was not confirmed (…). It may or may not have been posted, so sending it again could post it twice. `<name>` has ended.", with the connector's detail when there is one. Never read means still queued for it, or stored in its window above its consumed watermark: after its last compile, and after the last tool boundary whose stream declared it carries the messages injected there. After a branch switch, only what both branches share up to the point they part counts as read. The same goes for a delivery that fails after its speaker is released, and for such a notice restored at boot whose agent is gone; a notice still queued goes on as that same queue entry, so a crash before its ack passes it on once. That notice's metadata carries `speaker`, and the delivery's `outcome` and `detail` as the speaker's notice had them; every failed-reply notice's metadata now carries `textLen`. With no primary registered, no one is told, and it's logged. A host stopped while quiesced, before a fork's or run's window release, queues the primary's notice of each failed reply that window holds unread, for resume or boot.
  - A channel opened by an agent's own send after that agent has ended (an ephemeral run's final reply is routed after the run settles) is announced to the primary, by name: "Now open: … — opened by `<name>`'s reply; `<name>` has ended.", with the `channel_close` line. Its metadata carries `speaker`. With no primary registered, no one is told, and it's logged.
  - Writes still queued for a fork or an ephemeral run when it is released land in its own window, which Chronicle keeps, with one acknowledgement once a failed reply among them has gone on to the primary. A fork or run that ends while the host is quiesced is deregistered at once, and only its window's release waits for resume, which lands them then; no other flush takes them meanwhile. A write addressed to it meanwhile is treated as for any agent no longer registered.
  - The fallback reaper no longer disposes a closing fork whose turn is still alive before its stream has registered.
  - Any other notice or background-script wake made for an agent that is no longer registered is dropped, logged once, with no trace and no wake.

- `USERNAME` joins the child-env allowlist, beside `USER` and `LOGNAME`, so a Windows child gets its user's name, as a POSIX one does. Python's `getpass.getuser()` tries `LOGNAME`, `USER` and `LNAME` before `USERNAME`, so without it, it raises on a Windows host that supplies the name only through `USERNAME`, in stdio MCPL children and the code-execution interpreter alike.
- A code-execution script's output that UTF-8 can't encode, a lone surrogate such as Python makes of a filename byte that isn't UTF-8 or of a `\ud800` JSON escape, reaches the host as U+FFFD. Before, the interpreter could fail to send the script's result, which then waited out the script's deadline.

- The Discord module's tools now tell the agent what Discord refused and what to do instead. An id Discord doesn't know (Unknown Channel, Unknown Guild, Unknown Message, Unknown User), a channel, server or user the bot can't reach (Missing Access), a missing permission, an unknown emoji, an edit of someone else's message and a direct message the user doesn't take each read as "Nothing was sent", "Nothing was edited" and so on, with the call that shows the right id or whom to ask; before, the agent read Discord's bare words, such as "Unknown Channel". Any other refusal from Discord keeps Discord's words after the same lead. A `delete` of a message that isn't there says it's deleted or the id is wrong, without saying nothing was deleted, since a retried request of the call may have deleted it. A refused `reply` names the channel and message its reply context points to, and says `set_reply_context` changes them. What discord.js refuses itself, before it sends a request, reads the same way: a thread asked for on a message whose channel can't hold threads, or on a message that already has one (named, with how to post in it), and a reaction that isn't an emoji, which says Discord wasn't asked. A thread Discord says the message already has, from a repeat call or a retried request it had carried out, reads as there, with how to post in it; after a send, the send's error says so. A channel that holds no messages, such as a category, a forum or a media channel, is named as what it is, and an unknown channel's id says threads aren't listed by `list_channels`. An error that isn't a refusal, such as a network failure, reads as an unexpected error: for `send` and `reply` it says the message may have gone out and which channel's history shows it (for `reply`, the channel it posted in as it was sent, or, when its reply context names an empty thread id, how to put that right), for `dm` that sending again may send it twice unless an earlier `dm` to that user gave its channel's id, which `dm` now returns, and for the tools that change something that calling again is safe. A lookup that stops on such an error, before a tool changes anything, says nothing was done: a send's of its channel, a `dm`'s of its user and their direct message channel, and the message an `edit`, `delete`, `react` or `create_thread` acts on. One of those four that names an empty message id is refused before any request, with `fetch_history` as the way to find the id; it used to stop on discord.js's error. `list_channels` loses two refusals that couldn't be reached, and its description now says threads aren't listed. That changes the tool definitions every request carries, so each agent's first request after upgrading misses the prompt cache.
- A `send` with `createThread` whose message went out but whose thread wasn't started now says the message was sent, with its id and the `create_thread` call that starts the thread, so the agent doesn't send it again. A thread asked for in a channel that can't hold one, such as a DM, is still skipped with a successful result, whose data now carries a `note` saying no thread was started and why.
- The Discord module's rate limit refusal says how many seconds are left in the channel's window and what the limit is, rather than "Rate limited". A reply into a thread says the limit is its conversation's channel's. `reply` without a conversation, and `activate` and `deactivate` before the module has started, say what happened and what the agent can do. The notice for a text attachment that couldn't be fetched, which read `[Attachment: <filename> (failed to fetch)]`, now says its text isn't in the agent's context and to ask the sender in the channel to paste it, and the note for an attachment the host doesn't read in says the same of its contents. A text file of 100,000 bytes or more now says it's too large to read in, where it read as any attachment the host doesn't read in. A message stored with the earlier words keeps them until the history sync stores it again.
- An unknown tool name for the `discord`, `health` or `api` module says there's no such tool and lists that module's tools, read from its own `getTools()`. The health snapshot asked for before the host has bound the module tells the agent nothing was read and to ask whoever runs the host, and prints the host's missing `bind(framework, store)` step on a console line.
- **Client authors:** `DiscordRefusal` is exported. A `DiscordClientInterface` implementation that throws one has its message passed to the agent as it is; anything else it throws is worded as an unexpected error. `DiscordJsClient`'s `sendMessage`, `sendDM`, `editMessage`, `deleteMessage`, `addReaction`, `createThread`, `listChannels` and `fetchHistory` now throw a `DiscordRefusal` in three cases where each threw something else: Discord's refusal, a `DiscordAPIError` (kept as the refusal's `cause`); discord.js's own refusal of a thread or an emoji; and a channel that holds no messages or that discord.js returned as null, for which they threw an `Error` of their own. `sendMessage`, `sendDM`, `editMessage`, `deleteMessage`, `addReaction` and `createThread` also throw one when a lookup before their change stops on an unexpected error, such as a network failure. `fetchMessage` and `sendTyping`, whose failures reach only a console line, keep their errors. `sendMessage`'s `threadFailure` is worded for the agent, and it resolves with a `note` when the channel can't hold the thread asked for. `sendDM` resolves with the direct message channel's `channelId` beside the message's id; a custom client may leave it out.

- A stream that reports the framework's own cancel as an `error`, by just closing, or by
  throwing, now ends an endTurn or a budget restart the way an `aborted` one does. After
  an `error`, neither is traced as `inference:failed`, logged as a failed inference, or
  handed to the error policy. After a throw, neither is traced as `inference:failed` or
  `inference:exhausted`, or leaves an "[inference-failed]" note in the agent's context.
  In every shape, the stream's §10.5 lifecycle terminal reads `aborted`, an endTurn writes
  its delivery receipt and starts the continuation it was asked for, and a budget restart
  keeps the event gate's window open for its new stream, which takes over the turn's
  typing and streamed message. A stop, a quiesce abandon or a caller's stop over a stream
  that throws ends as one, as it already did over the other shapes, and the throw is said
  on the console. A stream that reports its cancel as an `error` and then throws ends
  once. membrane's yielding stream reports a cancel as `aborted`, so this reaches other
  stream implementations.
- A budget restart whose new start fails before its stream exists, such as on a store
  write, no longer leaves the agent's window open at the event gate, which kept every
  gate event buffered, for every agent. This happened with membrane's `aborted` restarts.

- **An inference whose stream fails now ends its `inference/lifecycle` with
  `failed`, where it ended `completed`.** An MCPL server granted
  `inferenceLifecycle` was told that such an inference completed. Three
  endings change:
  - an `error` event that ends the turn;
  - an `error` event that is retried. The retry is an inference of its own,
    with its own `started` and terminal, and a retry that `stop()` cancels
    leaves the failed inference `failed`;
  - an `aborted` event whose reason isn't `user`, such as `timeout`.

  The endings a stop or the framework's own cancel accounts for still end
  `aborted`, as before: an `aborted` event with reason `user`, an `error`
  event after a caller's stop, and an `aborted` or `error` event after the
  framework's cancel.

- A runtime connect, or a restart of another server into an id whose connect is still in flight, in either engine, is now refused before it changes anything, with `MCPL server "<id>" has a connect in flight; try again once it settles`, until that connect lets go of the id, just before it lists its tools. Before, a second connect went ahead beside a legacy one, and whichever settled last replaced the other in the registry without closing it. A disconnect of the id now ends the connect in flight and removes whatever it registered. Before, the disconnect removed the server's config and tool prefix, and the connect then registered the server without them, where no call reached it and only another disconnect cleared it.

- An MCPL server that reconnects now has its channel registration accepted.
  A reconnect resets the server's grant, and its traffic used to reach
  admission before the host's new §5.3 policy Request was answered: a
  `channels/register` sent right after initialize, as chat bridges do, was
  refused (-32002) and never replayed, so the route's incoming messages
  stayed unknown channels until the server registered again. A reconnect now
  holds control traffic as well as data until the new grant is established,
  as initial connect already did, both for a connection that was open and
  for one whose first connect had failed. It holds them whatever gate
  completes meanwhile, though each gate's completion opens every
  connection's planes: startup's staged open, a quiesce resume, an awareness
  sync, or another server's list change or reconnect. A runtime connect
  holds its planes the same way, through its awareness accounting too, and
  runs its exchange only on the transport it registered: if a reconnect
  replaced that transport meanwhile, the reconnect's exchange covers the new
  one, and the server is announced once.
- A policy answer that arrives after its transport closed grants nothing,
  whether to the initial policy Request or to one after a manifest change,
  and a manifest fetched from a transport that has closed isn't installed,
  nor a refresh queued on it run on the next one. A queued refresh's receipt
  reports the domains of the announcements it coalesced on its transport,
  each once, and the refresh limiter is kept per connection, so a connection
  that replaces a removed server under its id starts its own, where a timer
  of the removed connection could drop its replacement's queued refresh. A
  reconnect is still announced (`mcpl:server-reconnected`, `module:added`)
  once its attempt has settled, granted or not, and now also when another
  gate replaced its own before the awareness drain ended, where it used to
  go unannounced. A connect or reconnect whose transport drops before it's
  announced isn't announced: the close has reported the server gone
  (`module:removed`), and the next reconnect, if one comes, announces it.
  For a host that lists modules from the trace: a server whose first connect
  failed is added (`module:added`) once, by the first reconnect that's still
  connected once its attempt settles, granted or not, where it used to be
  added also when startup or a runtime connect registered it, and one that
  never connects isn't added. What a server sent about its own process that
  is still held when its transport closes, such as a request, a
  `tools/observe` filter or a channel registration, is dropped rather than
  admitted under the next transport's grant: the next process announces its
  own. So is such a message read from the transport after it closed, as can
  happen when a process a stdio server started still holds its stdout, until
  a reconnect attempt, if one comes, closes the transport's reader. A
  response read then is matched against none of the connection's requests,
  since the next transport numbers its own afresh, and, as any late answer,
  is surfaced as an orphaned response if it carries state, which waits, as
  the host's other reports do, for the control plane to open. A connection
  closed for good as its transport closes, by the host's close of a live
  connection or a drop with reconnect off, drops and logs the incoming
  messages and pushes it still holds then, and every request or notification
  it reads late, since no grant will come. Incoming channel messages and
  pushes still held, or read from the transport after it closed, are kept
  and admitted under the next grant, since a bridge that recorded them as
  forwarded won't send them again, and they stay held while no transport
  serves, even when a gate readies every connection meanwhile; the host's
  own reports about the transport, such as a `connect-failed`, go on.
  Requests kept this way don't count against the 10,000 held requests a
  server may have waiting, since no server waits on their answers any more:
  they have a bound of their own, the same 10,000, past which one is dropped
  and logged, so a dead process's backlog doesn't refuse the next process's
  requests. A channel registration the next process sends while they are
  still held is admitted ahead of them, so a kept message isn't refused as
  an unknown channel, unless it names a channel that an earlier removal, or
  an earlier registration kept in place, names: then it's kept in place too,
  so the writes to one channel stay in order. A removal stays where it was
  held, with whatever else it adds or updates, so when both planes open
  together, what the next process sent before one is admitted before it.
  While the host is quiesced its control plane opens first, so a removal is
  admitted then, ahead of the incoming messages still held, as live traffic
  is during a quiesce, and a message held for a channel it removed is
  refused when the data plane opens. A registration that arrives once the
  kept messages are admitted is too late for them, and a kept message for a
  channel the registry doesn't know is refused. An answer to a request from
  a closed transport is never written to the next one, whether the request
  was still held or its listener was still working when the transport
  closed, and neither is a streamed inference's chunk. A bridge that sends a
  kept incoming message again after reconnecting, because it hadn't recorded
  it as forwarded, can have it admitted twice; discord-mcpl records a
  message as forwarded before it forwards it.

- A module now reads, edits and removes the messages it writes while the framework holds them. The framework holds a module's writes while their agent has a turn alive or the host is quiesced, and stores them at a later boundary. A module's context answered such a write's id as `''`, its queries didn't see the write, and its edits and removals threw "Message not found". So a Discord message deleted during a turn stayed in the agent's history, an edit made then was lost, and a history sync could store a second copy.
  - **`ctx.addMessage`** answers a held write's id as a handle, `held:` and the write's id in the deferred-writes queue. `getMessage`, `editMessage` and `removeMessage`, and a process answer's `editMessages` and `removeMessages`, take it as they take a stored id. An edit changes the held write, and a removal drops it, so the agent never reads it. Once the write lands, the handle names its stored row. A handle whose write the framework dropped names nothing, as an unknown id does.
  - **`ctx.queryMessages`** answers the rows of held writes after the stored rows, marked `held: true` (the new `ModuleMessage` type), and `totalCount` counts them. A held row's `sequence` and `timestamp` are provisional, and change when its write lands. The writes a process held and the next one restores show once `create()` has restored them, which is after every module's `start()`: a module's `start()` doesn't see them, as before. A module that reads every row sees held ones too: connectome-host's retrieval module keeps its window to stored rows (anima-research/connectome-host#326).
  - **`ctx.findMessageByExternalId`** answers the first row under the external id where it answered `''` for a held write: the write's handle while it's held and its stored id once it lands, or an older row the module added under the same external id. The context still keeps `''` for a held write in its persisted map, which an earlier release reads back, and looks such an entry up in the store by the external id, held rows included. So an entry an earlier release left for a held write finds its message, and an entry it finds nothing for stays, as in a module's `start()` for a write the last process held. A stored id answers while its row is stored: once a process answer or a removal by handle has taken the row, the lookup answers `null` rather than that row's id.
  - A write a module or a process answer adds loses a `deferredWriteId` its metadata carries, such as one copied from a stored row: the framework finds a held write's stored row by that key.
  - The deferred-writes queue (`recovery/deferred-writes.json`, or `framework/deferred-writes` without one) records when each write was held (`heldAt`). An entry an earlier release wrote takes the time the queue is read back.

- A module tool's call that lacks a required argument, or whose input is
  there but isn't an object, is answered before the module runs with what to
  send, such as `Nothing was done: discord--set_reply_context needs
  "channelId" (a string), and this call gave none.`, every problem named at
  once. Before, the call reached the handler, which could fail deep inside
  with a `TypeError`, or run without it: `discord--set_reply_context` with no
  `channelId` left the reply context with no channel and answered success.
- The `utils` tool's check of a run's arguments reads the same way ("Nothing
  was done: …"), names every problem at once, and is still followed by the
  utility's schema. It now admits any type of a declared type list, where it
  refused every value of such a parameter; no longer checks the type of a
  parameter whose `type` names no JSON Schema type, such as `any`, or a list
  naming one, which it refused whatever it was (its `enum` is still
  checked); and takes a run of 16 or more digits sent as text for a number,
  passing it to the utility as text.
- The Discord module's `activate` reads a call with no input as no
  arguments, where it threw a `TypeError`.

- Where `fetch_reference` refused a reference from an MCPL server the host
  doesn't connect to over a network, such as a stdio server, as
  `unknown server: <id>`, it now says `this host doesn't connect to the
  "<id>" server over a network, so there's nowhere to fetch it from`. A
  server the host spawns from a command has no address either,
  even when its config also holds a `url`, on whose origin its references
  used to be fetched; nor has a WebSocket server whose `url` the transport
  won't dial: one that isn't a `ws://` or `wss://` url, or that has a
  fragment. A WebSocket server whose `url` has a fragment, which the `ws`
  library refuses to dial, now fails to connect with the transport's own
  error naming the fragment. `save_recent_image` now gives the reason a
  `fetch_reference` call naming no `max_bytes` would be refused with before
  dialing, and points at `fetch_reference` only where that fetch would go
  ahead. The eager fetch of the references in the result of an MCPL tool
  call the agent makes no longer spends one of its slots on a reference the
  fetch would refuse before dialing, such as one from a server whose fetch
  budget is spent, though it still joins a fetch of a reference already
  under way.

- `WorkspaceModule.readBinaryFromDisk` could read outside its mount through a symlink: it followed one at the path or among the directories on its way, wherever it led, whatever the mount's `followSymlinks` said. It now reaches a file as `readFileFromDisk` does, so it refuses a symlink the mount doesn't follow, and on any mount a file that resolves outside it, in `readFileFromDisk`'s words, before any size limit answers. Its own answers for a missing file, a file that isn't regular and a file over `maxBytes` are kept, with two changes: a path through a file, which gave the system's message with the absolute path, answers "File not found on disk", and a file this user can't read answers "Unable to read file" whatever its size.

- Server and transport text the framework records has the server's configured credentials replaced, in both engines: connection traces, console lines, stderr traces, the last of a server's stderr that a failed handshake keeps (in its trace and console line), the ops alert (and so `logs/failures.log` and the webhook), an MCP tool call that fails without an answer, as its caller and the model get it and in the `tool:failed` trace's message and stack. The credentials are those the configuration holds and those its dials sent: from the url as each dial sends it (a WebSocket dial sets the token in the query, which writes the whole query again, form-encoded, and an access provider's token can be in it), credential-like path segments and query names, credential-shaped or credential-named query values (each as written and decoded), every non-empty parameter as its whole `name=value`, and a WebSocket url's username and password, its userinfo as one unit before its `@` (the username alone when there's no password), with no length floor, so a short password goes with its username and a short username alone goes too, and the Basic credential a WebSocket client sends for it; the static `token`, and each token an access provider handed a dial (the newest sixteen), raw, and as a url carries it, percent- or form-encoded with either case of hex; and a stdio server's `env` values whose names have a part ending in a credential word, singular or plural, with any digits after it (`GITHUB_TOKEN`, `API_KEYS`, `PGPASSWORD`, `DB_PASS`, `AUTHORIZATION`, `SESSION_COOKIE`, `TOKEN2`), raw, and percent-encoded with either case of hex. Each of these strings, from every source, the `name=value` pairs and userinfo units too, is also replaced as JSON encoders write it, with `JSON.stringify`'s escapes, and with its slashes escaped too, as some encoders write them. A stdio server's command-line arguments are not derived. A string replaced on its own has at least eight characters, since a shorter one can't be told from ordinary text, and is replaced wherever it occurs. Every non-empty query parameter is also replaced as its whole `name=value`, only where no letter or digit adjoins the pair (so `v=2` leaves `dev=2` alone; a JSON escape before it, such as `\n`, isn't one); a short value goes only that way. A connection's event records use a redactor built once for it, and built again once a dial has sent something new. An operation's records replace the credentials of the configurations present when it began and of those present when each record is made, so a server removed, or replaced by a restart, while the operation waits is still covered, and so is one connected meanwhile. Every place a credential matches is replaced, places that overlap included, and text that may come from any server is matched against every server's strings at once, so two servers' secrets that overlap are both replaced whole. Over HTTP, which only the modern engine speaks, a 401 or 403's response body is left out of the request error's data; where the HTTP client builds the error's message from the body, as it does for most statuses, the message is redacted like any record. Credentials neither the configuration holds nor a dial sent are outside this, and so are a stdio server's command-line arguments. JSON-RPC answers, and the error a host's own connect raises, pass as they are.

- A record of a server's text no longer throws when the configuration it's
  redacted with can't be read, as a legacy stdio MCPL server's can't while
  the Discord awareness ledger can't be read. In place of the text it reads
  `[withheld: the server's configuration couldn't be read to redact this]`.
  Before, on a legacy MCPL connection:
  - a reconnect attempt made while the ledger couldn't be read rejected with
    nothing to catch it, which by Node's default ends the process. The
    connection made no further attempt, and its `close()`, and with it the
    framework's `stop()`, rejected with the ledger's error;
  - an error its transport reported after the handshake settled, or while a
    transport that never served was closing, was thrown inside an I/O
    callback;
  - an initial connect with `reconnect: true` whose ledger broke after the
    framework's own read rejected with the ledger's error, which ended
    startup, instead of returning the stub that retries.

- Under a configuration a host passes with a getter that throws, a failed
  MCP or MCPL tool call now answers with the withheld words as its error,
  where a call the model or a `code_execution` script made got no result and
  an in-process call rejected; and startup goes on past that server's failed
  connect, where it ended.

- A silent heartbeat tick is now told apart by its server and its event id
  together, so two servers' ticks whose events share an id each get their
  own separator, before their own first row.

- `start()` and `addModule()` made while a `stop()` is still running are now refused: `start()` throws `start() refused: the framework is stopping`, and `addModule()` rejects with `addModule() refused: the framework is stopping` (#315). Before, `start()` began a second lifecycle under the stop. If the stop hadn't yet seen its event loop end, it waited on the new loop instead: with no budget, which is the default, nothing ended that wait, and with one, it failed with `pending: event loop` and left the new loop running. If the stop had got past that wait, it settled after tearing down modules and an owned store under the new loop, and every later `stop()` returned that settled promise, so nothing could end the loop. A module added after the stop had taken its list of modules to stop stayed started and registered past it. `start()` and `addModule()` after a `stop()` has settled behave as before.

- **A stdio MCP server whose stdin or stdout fails is now ended even when
  it ignores SIGTERM, in both engines.** Since 0.22.2 such a failure sends
  the child SIGTERM, and its exit closes the connection. A child that
  ignored SIGTERM kept running, the connection stayed connected, and each
  request waited out its timeout. The transport now sends SIGKILL after 2 s,
  as its `close()` does, in the one attempt `close()` shares, so the
  connection closes, and reconnects if it would after any exit, its close
  still naming the pipe's error.
  - Nothing more is written to the child after the failure. A request made
    then is refused as not sent (`not-sent`), where it was written to the
    failed pipe and reported at its deadline as possibly executed. One
    written before the failure is still reported as possibly executed.
  - A connected server's child that outlives SIGKILL too is held as a
    launch that couldn't be reaped, as a reconnect holds one: reconnecting
    halts, the `mcpl-down` alert is raised, its tools leave the agents'
    list, and its id stays held until a disconnect or `stop()` retries the
    reap and confirms the exit.
  - Under Bun, a child that closes its stdin isn't reported at all, since
    Bun emits no `'error'` event for the writes to it, so request timeouts
    still bound it, as they do a child that stops reading.

- **`stop()` ends an MCPL connect still in flight, in either engine,
  instead of waiting for it.** The connect rejects with "was not connected:
  the framework stopped while it was connecting", and `stop()` doesn't wait
  on a server for it, in its handshake (its launch reaped), its setup or its
  tool listing, which asks every server. A restart in flight ends too, its
  connect refused once `stop()` has begun, so the server it was restarting
  is down. A disconnect admitted before `stop()` began still finishes
  first.

- `stop()` now runs every step of its teardown whatever an earlier step did.
  Before, a step that threw, such as a host's stream whose `cancel()`
  throws, ended `stop()` there: its modules and MCPL servers weren't
  stopped, the liveness watchdog went on beating, the framework stayed in
  the diagnostics registry, an ephemeral run still pending wasn't ended,
  and every later `stop()` failed the same way. Now `stop()` fails with
  that error once the rest has run, beside any other failure in an
  `AggregateError`, and an owned store stays open for another `stop()`, as
  after a failed module stop. A step in the last flush of deferred writes,
  which comes once everything else has stopped, fails the `stop()` as a
  failed final sync does, and the store is still synced and closed.
  - A stream whose `cancel()` threw is left running, as one whose wait ran
    out is: `stop()` doesn't wait for it, even with no budget, its agent's
    deferred writes stay queued, and a later `stop()` waits for it before
    it closes the store.
  - An ephemeral run whose own stream's `cancel()` throws at the run's end
    now leaves all the same, and settles as it ended, such as with
    `stop()`'s refusal, rather than with the cancel's error, which is
    logged. Before, the throw skipped the run's cleanup: the run and its
    agent stayed registered, and the stream's later text still reached the
    agent's context.
- `stop()` now ends Discord awareness delivery. A drain running when
  `stop()` begins sends nothing more, and the marks it hasn't sent stay
  pending in the outbox, unrecorded, for the next start's barrier; a line in
  the host log names the server and how many marks it held. `stop()`
  waits, within `teardownTimeoutMs`, for each drain still running to record
  the call that closing its MCPL server ended. Before, `stop()` neither
  stopped nor waited for drains: once the servers had closed, a drain went
  on through its pending marks, recording each as a failed attempt
  ("Cannot send request: connection … is closed") though it sent none, and
  with many marks those writes went on after `stop()` had returned. After a
  `create()` whose awareness barrier failed on one server, another server's
  drain went on writing the outbox after `create()` had rejected, while a
  `create()` retried in the same process could already be using it.
  - A wait on drains that runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming `awareness drain:<server>` and keeps an
    owned store open; a later `stop()` waits for that drain again. With a
    budget, a `stop()` can now take up to six budgets, where 0.22.3 took up
    to five. A failed `create()` gives this wait 30 s too, a third cleanup
    wait beside the two it had in 0.22.3.

- **A stop reaches a turn that has no live stream.** A turn can be alive
  with no stream to carry a stop: while it runs its modules'
  `gatherContext`, its MCPL hooks or its compile, while it waits to retry a
  failed inference or a failed compile, and while the tool-result guard
  waits for its speech to go out before retrying a refused round, when it
  holds only the round's finished stream. In the first two,
  `Agent.cancelStream()` had nothing to cancel, the framework's
  `abortInference()` returned `false`, and an operator's quiesce abandon
  left the turn running. In the guard's wait, the round's finished stream
  was cancelled and `abortInference()` returned `true`, but the retry was
  sent anyway. The turn went on to send its request or its retry, and
  answered, and an abandoned one did so while the host was quiesced. Now
  it ends at its next check, before it sends anything more.
  - **What a host sees:** one `inference:aborted` with the stop's reason,
    instead of a turn that goes on. The agent's `[turn-interrupted]` note
    says the turn was stopped before it sent anything, or before it
    finished; an operator's abandon writes no note. The inference log gets
    the stop's row, as for a stop on a live stream:
    `Stream cancelled (<reason>)`, or `Stream aborted: quiesce_abandoned`
    for an operator's abandon. The framework's `abortInference()` returns
    `true` for such a turn. `abortInference()` and an operator's abandon end
    a turn's wait to retry, however long, so the turn ends at once; a stop
    through `Agent.cancelStream()` ends it when the wait runs out. An MCPL
    server granted `inferenceLifecycle` sees a failed inference whose retry
    such a stop cancels end `failed`, as when `stop()` cancels it. In the
    tool-result guard's wait, `stop()` and an operator's abandon end the
    turn as their own stop even when a caller's stop came first, and as
    `stop()`'s when both reach it. `host:quiesce`'s `unabandonable` lists a
    turn that the abandon hasn't ended when its grace runs out: one with no
    stream and no check ahead, such as a puppet tool turn, or one that
    hasn't reached its check yet, the tool-result guard's wait for its
    speech included. A turn whose stream the abandon cancelled while it was
    still streaming isn't listed, even one still running.
  - **A failure's report:** a turn's stream that failed or threw no longer
    holds the agent while its `inference:failed` is delivered, nor does a
    compiled stream held for a provider's wait. A listener sees the agent
    idle, and `abortInference()` from a listener reports `false`: no stream
    or check is there to take the stop. A stop through
    `Agent.cancelStream()` made then ends the turn at the check after its
    wait to retry, if the error policy retries it, and otherwise ends
    nothing. A failure to build a turn's request is reported while the
    turn's check is still ahead: `abortInference()` from a listener reports
    `true` there, and the turn ends at that check.
  - **A stop followed by a failure:** when a turn's compile fails after a
    stop reached it, the turn ends at the failure: its `inference:failed`,
    then its `inference:aborted`. It isn't held by a provider hold, and the
    error policy doesn't retry it. If by then the agent was replaced, or the
    framework is stopping or was stopped and started again, the turn is
    dropped before it sends anything, as at the check after the compile. A
    failure that would have exhausted the turn emits no
    `inference:exhausted`, the event from which the hard-down alert's
    failure streak, the over-budget drain and the poison-history breaker
    count failures, so none of them counts it.
  - **A stop made where no check of a turn is ahead ends nothing:** the
    agent's next turn runs, as after a host's interrupt of every agent.
    That covers an idle agent, a turn finishing its last delivery, a budget
    restart or a non-streaming turn's tool results waiting to start the
    turn's next call, and a turn a provider-capacity hold or a provider's
    stated wait has parked.
- **A start whose framework was stopped and started again since it began is
  dropped before it retries a failed compile.** Its `inference:aborted`
  reads `a retry waiting while the framework was stopped and started again
  is dropped before it sends anything`; before, the retry compiled and was
  sent in the new lifecycle. A start whose hooks ran across a `stop()` and a
  `start()` is dropped before its compile too, as `a turn assembled while
  the framework was stopped and started again …`, where before the check
  after its compile dropped it. Either way a stop kept for the turn goes
  with it, as for a turn dropped while `stop()` runs.

- On Linux, a workspace mount's watcher no longer re-attaches, rescanning
  the whole mount and running its catch-up pass, when a file or directory
  with the mount root's own name is made, saved over or removed anywhere in
  the mount, as a program a build names after its directory is on every
  build. libuv reports such a rename under the same name as the root's own
  removal, and the watcher took every one for the root's. It now holds its
  root open (see Breaking) and checks whether the root is still the directory
  it holds. Where it can't hold the root, as on macOS and Windows or without
  read permission, such a rename still re-attaches it, as before.
- A workspace mount's watcher whose re-attach fails to close its old chokidar
  instance now reports that and attaches again. It used to stop watching the
  mount until the root's identity changed.

- On a disk that folds case, as macOS's does by default, a path that disk has nothing for takes the spelling of a workspace entry it equals in simple case folding, letter by letter, so a draft that isn't on disk yet has one name too. A `write` of `work/src/NEW.txt` where the workspace holds the draft `src/New.txt` now writes that draft, as the disk will once it's materialized, and `read work/src/new.txt` finds it; a directory works the same way. Two drafts that differ only in case used to be two entries for one file: a materialize wrote one and skipped the other, a forced one wrote the second over the first, and two directory drafts became one disk directory whose files the next pass moved under its spelling. A path that names a workspace entry exactly, or does once its directories take disk's spelling, keeps the entry's spelling, so an entry that disk lists in another spelling, or in a directory disk lists in another, such as a draft beside a file made on disk in another case before the draft was materialized, is read, synced, materialized and deleted by its own path. So is a file deleted in the workspace while disk keeps its copy, and a path in conflict: a `read` of its own path answers that it was deleted, or is in conflict, rather than taking the file in again, and a `materialize` of that path with `applyDeletions`, or a `sync`, reaches it. A path that disk's spelling puts in a nested mount's directory keeps that spelling, so the nested-mount checks still refuse what they refused. A draft whose directory disk comes to list in another spelling before it's materialized is found only by its own path. Drafts that differ only in Unicode normalization form, or in letters only a fuller folding joins, such as `ß` and `ss`, stay two entries, and where the disk folds them, as macOS's folds normalization, a materialize still writes one and skips the other. Spelling a path disk has nothing for reads the workspace's entries under the deepest of its directories disk has, so on macOS a script that creates thousands of new files, or looks up thousands of paths that don't exist, under one large directory pays that once per path. On a disk that tells case apart, every answer is as before, except that where such a disk folds normalization forms, a path that names a workspace entry exactly, or a deletion or conflict the workspace records there, or does once its directories take disk's form, keeps its form, outside nested mounts' directories.

- A mount nested in another is now that mount's directory wherever disk puts it, not only where the outer mount's paths name it as written. A root configured through a symlink, or beneath one, is nested where its real path lies; before, it wasn't nested at all, and the outer mount took in and read the inner mount's files. Each start of the module reads each root's real path again, awaited, so a root on a share that stops answering holds that start, not the process; before the first start, mounts are nested by their configured paths alone, as they were. On a mount that follows symlinks, a path that reaches a nested mount's directory through a link is now refused as one written into it: the file tools answer `"work/l/x.txt" leads into mount "inner", nested in mount "work", which neither reads nor writes it: use "inner/sub/x.txt".`, a sync or a materialize leaves it with `"work/l" leads into mount "inner", nested in mount "work": use "inner/sub" in its place`, and `readFileFromDisk` refuses it with the code `other_mount`. Before, the outer mount read, took in, wrote and unlinked the inner mount's files through such a link (#530). On a mount that doesn't follow symlinks, a path through a link into a nested mount's directory is now refused before anything is stored, with the refusal of the link the mount doesn't follow; a `write`, `edit` or `delete` through it used to store a change that no push could write. Where the path is itself a link to a file in a nested mount's directory, `readFileFromDisk` now refuses it with the code `other_mount` and words naming that mount, where it answered `symlink`.
- A mount configured with a relative root written with `./`, such as `./m`, now hears its watcher; it heard no change on disk.

- A workspace mount that doesn't follow symlinks (`followSymlinks` unset or false) now follows none among the directories on a path's way either. Before, a symlinked directory pointing inside the mount was followed, so the workspace acted on a file under another path than the one it named: a materialize deleted, created or overwrote the file behind the link, and a sync took that file's bytes in. Such a path is now refused wherever the link leads, naming the link: for a link inside the mount, with its target, and for a link to a directory there, that the mount's host can set `followSymlinks: true`; for one leading outside the mount, saying so. On such a mount, reads through an inside directory link stop, from `readFileFromDisk` and `read_image`, with a new code, `parent_symlink`, or `other_mount` for one into a nested mount's directory, and a listing of the directory a link stands at says so instead of walking it. A directory link leading out of the mount keeps the code `escape`, with the new words. A change a tool stores through such a link stays pending until disk can be observed there: the link goes, or, for a link to a directory inside the mount, the host follows links. A file the workspace created through the link clears when its entry is deleted. For a link inside the mount, the path through its target is the one to use. A mount root that is itself a symlink is still the root, and a mount that follows symlinks keeps following them while they stay inside it.
- Deleting a workspace entry disk never agreed with, a draft the workspace created with no push of it in doubt, or one at a path where disk last agreed it had nothing, no longer leaves a deletion pending. It records nothing to apply and pushes nothing, so it needs no proof of absence, which a path beneath a symlink the mount doesn't follow could never give. A draft written over a disk file the workspace never saw is now deleted without touching that file, which a sync observes as it does any file disk holds; the deletion was refused, with a forced push that would have deleted the file offered after a sync. Where a conflict the deletion clears names such a file, `delete`'s answer carries a `note` saying nothing was unlinked.

- On a disk that folds names, as macOS's does by default (case, and Unicode normalization), the workspace's tools take a path as disk spells it, unless it names a workspace entry exactly, or a deletion or conflict the workspace records at that path, or does once its directories take disk's spelling, which keeps that spelling where disk's spelling doesn't put it in a nested mount's directory. A `path` spelled otherwise, such as `work/SRC` for disk's `src/`, reaches disk's files, and `glob`, `grep` and `ls` used to name what they found from that spelling. So the workspace took each file in a second time under that name, announced it as created, and announced it deleted at the next pass over the mount; a `write` there was held under the name given while disk put it in `src/`. Now each segment of a `path` that reaches an entry under another spelling takes the entry's own name, from the mount's root down, and answers name files as disk lists them: `read work/SRC/a.ts` answers with `path: "work/src/a.ts"`. A segment disk doesn't have keeps the spelling given, unless a workspace entry spells it, and nothing past a symlink, or past a `..` that climbs above the mount's root, is respelled. `readBinary`, `readBinaryFromDisk`, `readFileFromDisk` and `writeBinary` take their paths the same way; `resolveAbsolutePath` takes its path as given, and the path it returns reaches the same file. A nested mount's directory on disk is now known in its configured spelling and in disk's: `read`, `read_image`, `write`, `edit` and `delete`, and the public readers and writer, refuse a path into it spelled in another case or normalization form as that mount's, and an outer mount no longer takes in the files of a nested mount whose directory was configured in another spelling than disk's. On a disk that tells spellings apart, every answer is as before.

## 0.22.3 — 2026-10-18

### Added

- A tool call the framework dispatches carries `callerTurnId`, the turn it was made in, and `SpeechContext` carries `turnId`, the turn the speech ends. A model's call carries the turn whose stream made it, a foreground script's inner call the turn of the `code_execution` call running it, and a background script's calls carry none. A turn's calls and its speech carry the same id, and the agent's next turn has a larger one, so a module can tell one turn's work from another's. Ids are unique only within one run of the process. The call on a `tool-call` process event now carries `callerAgentName` too, and `callerTurnId` when it has a turn.

- **Inbound source envelope.** Every inbound item the host accepts now carries
  `metadata.inboundSource`, stamped once where it was accepted: the
  conversation it belongs to (`channel`: MCPL server, endpoint binding,
  canonical channel id, thread, message, reply edge and the channel's label at
  receipt; `unscoped` for a push that names no channel; `surface` for console
  or API input from a module), the host acceptance time and the adapter's own
  timestamp. It covers `channels/incoming` and `push/event` on both the
  ordinary and the RFC-006 coalesced paths; a coalesced occurrence freezes its
  envelope at acceptance, so deferral, fan-out and replay deliver it unchanged
  and a later rename never rewrites it. Adapter-supplied metadata cannot set
  the field, and one a module's messages carry is dropped (an adapter's own
  `origin.source` string is untouched). `readInboundSource`,
  `conversationKey` (a JSON-encoded key, so no server-chosen part can run
  into another) and `INBOUND_SOURCE_KEY` are exported.
- **Inbound source envelope: admission facts.** An ordinary `channels/incoming`
  message or `push/event` now has its envelope frozen at admission, before it
  is queued or acknowledged, so a rename or rebind while it waits cannot
  change it. Every channel and unscoped envelope names the admission `lane`
  (`channels/incoming` or `push/event`), and one that came through RFC-006
  coalesced admission has `coalesced: true` (others have no `coalesced`
  field): facts a consumer needs to know what an `eventId` is worth.
  `readInboundSource` validates every field it returns.

- **`McplRequestError`: why an MCPL request produced no result.** A request
  to an MCPL server that fails now rejects with `McplRequestError` (exported),
  whose `outcome` says which of three things happened: `not-sent` (refused
  before anything was written: the connection was already closed),
  `error-response` (the server answered with a JSON-RPC error; the error's
  `data` is kept, and its code is in the message), or `no-response` (the request was handed to the
  transport and no answer came back: a timeout, or the connection closed
  while awaiting; it may or may not have reached the server). Only
  `not-sent` proves the server never saw the request. Messages are unchanged,
  and it is still an `Error`, so existing handling keeps working.

- **Held prose drafts: suppressed speech is kept, not destroyed.** Plain
  speech that routing holds back is now held as a draft with its exact
  words, instead of surviving only as a count: speech suppressed by an
  explicit send in the same round (locus and hybrid modes, mid-turn, trailing
  and text-only, native and XML tool modes), hybrid prose left without a
  destination after a failed envelope, and explicit/hybrid bounces, a
  delivery that definitely failed among them (which replace the in-memory
  latest-wins clipboard; `{{unsent}}` keeps meaning the latest bounce). Locus
  speech whose delivery fails keeps its failure marker, and isn't held. A draft held beside a send keeps its run exactly as
  written, indentation and surrounding newlines included; routing still
  publishes trimmed segments. Deliberate privacy is never drafted:
  `skip_reply` (the tool, or a hybrid `>>>skip_reply` envelope, which keeps
  the rest private until a destination is named), a same-round private
  `think` in a native round (where that policy applies: XML tool mode routes
  such prose as ordinary speech, so a send holds it as a draft), silent turns
  and `proseRouting: disabled` narration stay private.
- In hybrid mode a send withholds publication, not what an envelope does: a
  held `>>>` envelope moves the routing state as live routing would (a
  destination it names becomes the sticky target), `>>>skip_reply {{unsent}}`
  still sets the latest bounce aside, and the draft holds the message the
  envelope would have published, with `{{unsent}}` expanded under the
  re-bounce rule (a bare `{{unsent}}` leaves the bounce as the one draft).
- Drafts live in typed Chronicle records (`RecordJournal`) that do not follow
  branch switches: undo, rollback and checkout never change them, and they
  survive restarts. Nothing is ever sent from them on its own. Each
  resident's 100 newest drafts are kept, and an older one for at least 7
  days after anything last happened to it (held, named, attempted, answered,
  dismissed). The journal lets such a draft go when it next checkpoints what
  it keeps, every 500 entries, so opening it replays only what follows. A request naming a draft that was let go is
  refused, and nothing is sent, unless that id has since been given to a newer draft,
  which the request then names instead: an id is `d-` and seven characters, so after N more of its resident's drafts a let-go id has come back
  with a probability of about N in 2.75 × 10^10.
- A private notice names held drafts at the next tool boundary when the live
  stream presents mid-turn messages (a draft holding words copied from one
  that may already have been posted is named with that risk and the
  `confirmDuplicate` its resend needs). In locus and hybrid modes the
  turn-end `[delivered]` receipt names every draft held in the turn, in any
  of its streams (a framework retry, or the compile a provider-capacity hold
  defers the turn to), by id and by its state at turn end: still held
  ("held as drafts d-… (not sent …)"), delivered by the resident's resend
  (listed where it landed), unconfirmed, or dismissed. A dismissed draft
  whose own attempt may already have been posted is named with that risk,
  and counts like an unconfirmed one: a receipt that names one, with nothing
  confirmed delivered, reads "nothing confirmed", not "nothing". Explicit
  mode writes no receipt: its drafts are named by their bounce and refusal
  notices. A draft counts as named while a message naming it is on the
  current branch, so one no notice reached (a crash, an aborted turn), or
  whose notices a rollback or branch move took away, is named at the next
  turn's start: every such open draft by id, the newest eight with its state
  and why it was held. That catch-up reads the recent history (the newest
  500 messages): it records a notice it finds there, including one that
  landed after its turn had ended, and it leaves out the drafts of a turn
  still open and those a notice waiting to be written names. Notices
  name drafts and say how to resend or dismiss them, and quote none of their
  words; the `drafts` tool's `read` shows the words, and its `list` a
  preview of each.
- A draft is never published except by its resident's explicit resend (or
  `{{unsent}}`), and only that resident can list or act on it. Its notices go
  into the resident's own history, which residents sharing one message slot
  already share, as they share the assistant turn the words came from.
- New `drafts` tool (whenever MCPL channels are configured): `list`, `read`,
  `resend` and `dismiss`, scoped to the calling resident. Every such
  resident's tool list gains it, so each one's first request after upgrading
  misses the prompt cache once. `resend` publishes
  drafts verbatim, in order, to one destination through the normal publish
  path, journaling each attempt durably before the request leaves; it counts
  as an explicit send. A delivered draft returns its historical receipt
  instead of sending again; a draft with any attempt whose outcome is
  unknown (and none confirmed) needs `confirmDuplicate: true`, and a resend
  owns its drafts until it finishes, re-checking each before it is sent, and
  a draft it doesn't attempt is told why the batch stopped. Dismissing a
  draft (with the tool or `>>skip_reply {{unsent}}`) is refused while that
  draft's attempt is out, since a dismissal can't call back words already on
  their way; the resident is told to wait for that result. A draft only
  queued in a resend can still be dismissed, and is then not sent. A
  dismissal of a draft that may already have been posted names that risk.
  Unused fields may be passed as null.
- `{{unsent}}` whose draft is being sent, queued in a resend, or unconfirmed
  sends nothing, and the envelope's own words are held as a bounce draft
  with `{{unsent}}` written out and the risk carried, so nothing the
  resident wrote has to be typed again. If the journal refuses that draft,
  the notice says the words remain only in the history.
- Prose segments also break at XML tool mode's refused attempts and their
  notices (`tool_attempt`, `tool_notice`): the words before an all-refused
  call and after its notice are two messages, routed or held separately.
- `ChannelRegistry.deliverSpeech` (routeSpeech with its `PublishOutcome`) and
  `ChannelRegistry.resolveDestination` are new. `routeSpeech` now delegates
  to `deliverSpeech` and returns null unless delivery was confirmed, so a
  missing receipt and a channel id two servers share now return null (see
  the publish-outcomes entry).
- The bounce notice now goes to the bouncing resident rather than the primary.

- `QuiesceBlockedError`, exported beside `ResumeBlockedError`: what `quiesce()` throws when it refuses because the queue of deferred context writes can't reach disk, over its cap or with its write failed (the error's `cause`), with the host's mode as it was. The HTTP `/quiesce` route answers it with a 409 and the host's mode, and `host/command` with `ok: false` and the host's mode, as they answer `resume()`'s `ResumeBlockedError`.

### Changed

- **MCPL server authors:** when the host's handler for a server's request throws or rejects before it has answered, the server's answer no longer carries the handler's own message (#208). 0.22.x answered such a failure of a `push/event`, `inference/request`, `channels/register`, `channels/changed`, `channels/incoming` or `host/command` handler with `-32603` and the handler's message, or, once the host was stopping, with `-32000` and "the host stopped while handling this request" followed by the handler's message in parentheses. These requests now get `-32603` "Internal error", or, while the host is stopping, `-32000` "the host stopped while handling this request" alone. A handler's message can name the host's internal paths and errors, and the server may be a third party's. A server that shows or parses the handler's text from these replies no longer receives it: the host writes it to stderr and to its `mcpl:request-handler-error` trace instead. A handler that answers a failure itself still sends its own code and message, as before: `inference/request` when the inference fails, and `push/event` when a coalesced push fails.

- With a budget, `stop(teardownTimeoutMs)` now also bounds its waits on the
  streams it cancels, on maintenance in flight and on the event loop, as it
  did its waits on an operator's operations and on modules and MCPL servers
  (#373). Each wait takes the whole budget, so a `stop()` with one can take
  up to five budgets, besides the withheld-spill deadline of a guard's write
  still under way. Before, a stream whose cancel couldn't reach it, a
  maintenance tick that didn't settle, or a module's `onProcess` that never
  returned kept `stop(t)` waiting without end, whatever `t` was. With no
  budget, `stop()` waits for each as before.
  - A wait whose budget runs out fails the `stop()` with a
    `ShutdownTimeoutError` naming what it waited for (`stream:<agent>`,
    `maintenance` or `event loop`), once teardown has gone on; with more
    than one, or beside another failure, the `stop()` fails with an
    `AggregateError` of them all. An owned store stays open, so that
    `stop()` can be called again, as after a timed-out wait on an
    operator's operations.
  - A later `stop()` waits again, within its own budget, for a stream or an
    event loop that an earlier one left running, and closes an owned store
    only once they've settled.
  - An agent whose stream outlasted its wait keeps its deferred writes
    queued, logged once for that agent, where `stop()` would otherwise
    store them ahead of what the stream may still write. The stream's own
    end takes them, as at any turn's end, if the process lives on, and a
    later `stop()` takes what that leaves. A memory-only queue loses them if
    the process exits before then.
  - Every ephemeral run still registered is ended with "refused: the
    framework is stopping", even one whose stream is still running, and its
    end stores what is queued for it, as at any run's end. Before, `stop()`
    waited for that run's stream first, without end if it never settled.
  - An event loop still in a call, such as a module's `onProcess`, when its
    wait runs out finishes that call and the rest of its iteration, then
    exits, even when a `start()` has been made meanwhile.

### Fixed

- MCPL's inbound handlers are contained at one boundary, the framework's wiring, for every request and notification it handles (#186). The `channels/list`, `tools/observe` and `model/info` requests and the `notifications/tools/list_changed` notification are newly contained: a throw or rejection of theirs is reported as the other handlers' are. `mcpl/manifestChanged` goes through the same boundary, and so does a refresh its handler schedules for later, after the fetch floor or behind a fetch in flight: a manifest fetch that fails is still caught and logged inside the handler, as in 0.22.x, and anything else the handler throws or rejects with is now reported as the others' are. 0.22.x logged that from an announcement's own run, and dropped it from a scheduled re-run. The six requests whose handler failures 0.22.0 already answered (`push/event`, `inference/request`, `channels/register`, `channels/changed`, `channels/incoming` and `host/command`) go through the same boundary now. On a connection the framework wires, no handler's throw or rejection ends the host, and a rejection reason that can't be printed is reported as one that can.
  - **A request whose handler fails is answered `-32603` "Internal error",** or, while the host is stopping, `-32000` "the host stopped while handling this request". The handler's error stays in the trace and on stderr. For the six that 0.22.x answered with the handler's own message, that's a change, described under Changed. A request is answered this way when its handler fails without having written a reply, which includes a reply whose write threw, such as one that can't be encoded. A notification gets no reply.
  - **Each failure emits a new trace, `mcpl:request-handler-error`, and a stderr line.** Its `error` is the handler's own error, or, for a handler that resolved, the reply write it swallowed, or a note that it tried to answer a second time. A reply write that failed before it is `responseFailure`, and a reply the handler tried to send after one was already attempted is `refusedResponse` (a result, or an error with its code and message): refused, never written. `responseError` is the internal-error reply's own failure, which the stderr line prints too. `requestId` is the request's id when that is a number, and a string id bounded as the trace's other texts are. A request form of `mcpl/manifestChanged` or `notifications/tools/list_changed` has none, since it's answered as it's admitted and then handled as the notification is.
  - **A request whose method isn't a string,** or isn't one the host handles, or whose event nothing on the host listens for, is answered `-32601` "Method not found", with a stderr line. A notification nobody handles is ignored.
  - **`mcpl/manifestChanged` and `notifications/tools/list_changed` sent as requests,** with an id, are answered with an empty result when the connection admits them, which waits while their plane is paused, if something on the host listens for them, as the framework's wiring always does, and are handled as the notification is.
  - **Non-object JSON** (`null`, `42`, `"hi"`, `true`) is ignored before property access, in the handshake reader and in routing, as a non-JSON line already is. One such line from a server used to end the host (#217).
  - **An `initialize` error whose `message` has no string form,** such as `{"toString":1}`, refuses the connect, with `initialize error: [object Object]`. 0.22.x converted that message after the handshake had stopped listening and cleared its timeout, so the conversion's throw escaped as an uncaught exception, which ends a host that doesn't catch them, and the connect never settled.
  - **An error answer to a request the host sent,** such as its manifest fetch, settles that request whatever its `code` and `message` are. 0.22.x's conversion of them threw out of the transport's line listener in the same way.
  - **A server's text in these errors is bounded:** in an `initialize` error's message and in an error answer's code and message, control, format and line-separator characters become `?`, and each is cut after 200 code points, with `…` marking the cut.
  - **A synchronous failure while dispatching an inbound message**, buffered plane flushes and a server's stderr lines included, is reported without interrupting later messages. Its `mcpl:server-error` names the event or method, the request id, and the cause.
- A trace listener that throws a value `console.error` can't print, such as one whose `util.inspect.custom` throws, no longer keeps the listeners after it from getting the event, or throws out at the code that emitted it: its error is printed as text instead.

- An MCPL server's `inheritEnv`, `reconnect` and `allowHostCommands` each take `true` or `false`, or can be left out, and `null` counts as left out (#379). `create()`, `connectMcplServer` and `restartMcplServer` refuse any other value, naming the server, the setting and the value's kind, and `restartMcplServer` refuses before it disconnects the running server, which stays up. `inheritEnv` is checked only for a stdio server, since a WebSocket server never reads it. `inheritEnv` and `reconnect` were read by truthiness, so `"inheritEnv": "false"` handed a stdio server the host's whole environment, API keys and bot tokens included, and `"reconnect": "false"` turned retrying on. `allowHostCommands` was read as on only when `true`, so `"allowHostCommands": "true"` granted nothing. Every reader of the three now takes only `true` as on, and `McplServerRegistry` asks the connection whether it will reconnect instead of reading `reconnect` again. So a server with `reconnect: true` that the host closes for good, as a policy refusal's `"close"` fallback does, no longer stays registered as a closed connection. A quoted `"true"` is refused wherever the setting is checked, including where the truthy reading made it work, so write `true` or `false` without quotes. A host that passes these settings on from its own configuration without checking them now gets this refusal from `create()` where a quoted value used to start.

- **Requests an MCPL server sends while its plane is paused are bounded**
  (#387). During a startup, a reconnect, an awareness drain or a quiesce,
  held requests had no bound, so a server that sends requests without
  waiting for their answers grew the host's memory until it ran out. Past
  10,000 held requests, a new one is now answered at once with `-32000`
  "the host is busy: 10000 of this server's requests are already waiting;
  send this one again later", and the host logs the first refusal and every
  hundredth. A server that doesn't send a refused request again loses it.
  Notifications keep their own bound of 1,000, now counted apart from
  requests. Before, held requests counted toward it, so a pause holding many
  requests dropped notifications it had room for.

- A failed `AgentFramework.create()` now releases what it had acquired before its error reaches the caller, so the same process can call `create()` again (#389). Before, a `create()` that failed after opening its store, such as on an invalid `timeZone`, an MCPL `toolPrefix` collision, a module whose `start()` threw or an out-of-range `toolResultInlineMaxChars`, left the store locked: every later `create()` on that `storePath` got `Store is locked by another process` until the process exited. It also left running what it had started, the liveness watchdog among it, which could then kill a process that carried on after the failure. Now the framework it had begun is stopped as `stop()` stops one (its modules, MCPL servers, event gate, tune-out coordinator and watchdog), and a store it opened from `storePath` is closed. A store passed in as `store` stays open.
  - The caller of a failed `create()` has no framework to give `stop()` a deadline, so `create()` gives it one: it gives up after 30 s on each of `stop()`'s two cleanup waits, for an operator's operations already running and then for its modules and MCPL servers to stop, where `stop()`'s default waits with no deadline. A module whose `stop()` never settles would otherwise turn a failed boot that exits into one that hangs.
  - When stopping them fails or runs out of time, or closing the store fails, `create()` rejects with an `AggregateError` holding its own error first and then those failures. Its message begins `AgentFramework.create() failed:` and says what didn't finish: that part of what it started may still be running, that stopping failed only after everything it started had stopped, or that its store may still be locked. It closes a store it opened even when stopping failed. When the release finishes cleanly, `create()`'s own error is rethrown unchanged, as before.
  - A `WorkspaceModule` that stops before its `initStore()` has applied the state it was handed, as one does when a `create()` that started it fails, or after an `initStore()` that threw partway, no longer saves over its stored state. Its `stop()` saved empty or default mounts there, losing the branch last materialized to disk, so on the next start `materialize` no longer refused a branch that had diverged from it.

- **A WebSocket MCPL server that sends a malformed frame with its upgrade
  response no longer ends the host** (#391). ws raised the frame's error
  before the handshake had attached a listener to the new transport, and
  the transport passed it on with nothing listening, which EventEmitter
  throws from an I/O callback. Such an error is now logged
  (`[mcpl] <server>: a websocket transport error, with nothing listening for
  it: …`), and the connect is refused: at once when the server then closes
  the connection, as a WebSocket server does after answering the close frame
  ws sends, and after about 30 s when it never does.
- **A transport error no longer ends a process whose `McplServerConnection`
  has no `'error'` listener** (#391). A connection the framework wires always
  has one, but a probe, a playtest or a harness holding a bare connection
  often doesn't. With no listener the error is now logged
  (`[mcpl] <server>: transport error: …`), and a listener that throws is
  caught and logged with the error it was handling.

- **An MCPL server's MCP `ping` is answered** with an empty result, as MCP
  asks, while its planes are paused too, and during the initialize handshake
  (#392). In 0.22.x a ping went unanswered, so a server with a keepalive could
  take the host for dead. During the handshake, a request whose id was `0`,
  the id the host gives `initialize`, was taken for the initialize response,
  so a server that pinged then connected as if it had advertised no MCPL
  capabilities.

- **A late `push/render` answer, and a tool call's late error, are now
  recorded** (#398).
  - **A `push/render` answered after its timeout**, once the batch's
    fallback was in place, left no record. It's now a `mcpl:coalescing`
    `late-render` with `discarded: true`, naming the server, the render's
    `featureSet`, `key` and, for a channel-scoped subject, `channelId`, and
    the `eventId` that links it to the batch's `render-failed`. A late
    JSON-RPC error is recorded as `error`, its code and message
    (`[code] message`, cut to 500 code points). While a data plane was
    paused, the late answer was also held and took a slot of that plane's
    bound; now it isn't held.
  - **A tool call answered after its mandatory deadline** stays a
    `mcpl:orphaned-response`, and a late JSON-RPC error there is now
    recorded as `error` the same way, where it used to look like a late
    success.
  - **`McplServerConnection` no longer emits `orphaned-render-response`.** A
    late `push/render` answer is an `orphaned-response`, with
    `method: 'push/render'`, `featureSet`, `key`, `eventId`, `channelId`
    when the subject is a channel's, and `error` when the answer was one.

- A tool result stored over its inline cap no longer keeps every line shaped like a reference stub from past the cut (#403). Every `[ref_…] …` line past the cut was added back after the truncation notice, whether or not it named an image and with no limit, so a text result listing channel attachments was stored far over the cap: a 25,980-character result at a cap of 2,000 was stored at 25,168 characters. The lines past the cut were kept so that `save_recent_image`'s index counts every image the resident saw, and now the stored copy keeps what the live copy showed.
  - A result with no inline image keeps nothing past its cut. Its live copy is the stored text, so the resident never saw what lies past the cut either. A truncated text result no longer lists the image stubs past the cut: the spill file holds them, and without a writable workspace they aren't kept, like the rest of the text past the cut. Such a reference's record is still in the registry, so running its tool again brings its stub back.
  - A result carrying an inline image went to the model as blocks: every image and every reference's stub, whatever the text's length, and each text block cut at the cap on its own. Past its cut it keeps the image slots those blocks showed, placeholders and image-typed stubs, the newest 64 of them, the most images the tool-image ledger holds bytes for. A slot in the part of a text block that the live copy cut away isn't kept. When more than 64 fell past the cut, a note says how many were left out, and `save_recent_image` doesn't count those.
  - History's own truncation, which cuts a script's tool results and those on the direct Agent API, keeps nothing past its cut either: each is read as its text.
  - The stored copy's cut, history's own truncation, and the live copy's cut of a text block beside an image never leave part of a slot before their notice. A cut that would split a placeholder moves back to the placeholder's start, and one that would split a stub-shaped line moves back to the line's start when at most 677 characters of the line lie before the cut, since that part could still read as an image; a longer part can't, and stays. The live copy and the stored copy cut alike, so the stored copy counts exactly the slots the live copy showed.
  - `save_recent_image` counts a reference stub as an image by the type its stored text shows, as it did after a restart or an eviction, and no longer by the registry's record while one exists. A stub counts the same whether or not the process still holds its record, and a reference issued again with testimony of another type no longer changes how an earlier stub counts.
  - A save in the same batch as a long result counts it as its stored copy will be cut, and an error result, or one with no data, which history stores as its error text, counts that text's slots before it is stored as it does after.
  - A slot is no longer than its writer writes it: a stub-shaped line longer than the longest stub the framework writes (677 characters), or a placeholder whose type or subtype is over 127 characters or whose size's number, ledger nonce or sequence is over 16 characters, is quoted text and counts nowhere. A tool image whose type or subtype is over 127 characters, the most RFC 6838 allows, is labelled `application/octet-stream`. A placeholder stored before with such a type no longer counts; only a server that sent one could have produced it.

- What agent-framework tells an agent about opening and closing a channel no longer describes one server's delivery as every server's (#406). MCPL leaves what an open or closed channel delivers to the server. discord-mcpl subscribes a channel when the host opens it and unsubscribes it when the host closes it. slack-mcpl keeps its own subscription, which decides whether a conversation's ordinary messages arrive whether the host has it open or closed.
  - The closed-channel invitation says "a channel you haven't opened" and that messages there that address the agent reach it whether or not it opens the channel, in place of "the rest of its traffic is invisible to you". Option 1 drops the warning that follow-ups to a reply won't reach the agent, and says that replying opens the channel, which it does. Option 2 reads "Open the channel".
  - `channel_open`'s description says that what an open channel delivers depends on its MCPL server, in place of "start receiving its ordinary ongoing traffic" and the server's "subscribe/join/attach operation".
  - `channel_close`'s description says that messages addressing the agent still reach it and what else stops depends on its server, in place of "stop receiving messages". `channel_decline`'s error for an open channel says to use `channel_close` to close it, not to leave it.
  - The "[channels] Now open" notice says that what an open channel delivers depends on its server, in place of "Ongoing traffic from this channel will reach you".
  - Every place that puts `#` before a channel's name adds it only where the name doesn't already start with one. The closed-channel invitation named slack-mcpl's `#general (acme)` as `##general (acme)`, and with a channel registry that has no `proseTargetFor`, it offered a label such as `#random` as the reply prefix `>>##random`. The gate's batched-wake line did the same with a `channelName` that starts with `#`. The invitation also names a channel whose label is only its id, as a lazily registered channel's is, by that id, without a `#`.
  - `channel_open`'s and `channel_close`'s descriptions change, so the first request after the upgrade that carries the channel tools misses the prompt cache from its tool block on.

- `codeExecution.enabled` takes `true` or `false`, or can be left out, and `null` counts as left out (#473). `create()` refuses any other value, and a `codeExecution` that isn't an object, `null` or `false`, naming the value's kind, not the value. The switch was read by truthiness, so `"enabled": "false"`, as a JSON config or a `${VAR}` substitution can write it, gave agents the `code_execution` tool and a python interpreter on the host, and a bare `"codeExecution": true` was read as off. Only `true` turns it on now. As before, a configuration that isn't on has its other settings left unchecked. A host that passes `codeExecution` on from its own configuration without checking it now gets this refusal from `create()` where such a value used to start.

- Restored state is no longer taken as empty at boot. `AgentFramework.create()` now fails when a state it restores can't be read, or reads as something this version can't take for that state. The error names the state, or its recovery file, and says what to do; nothing it names is changed. Before, each was taken as empty, the framework served without it, and the next write replaced what was stored. Nothing stored still starts empty, and a store any release wrote boots as before unless one of these reads fails.
  - **Host mode** (`recovery/host-mode.json`, or `framework/state` without one): a quiesced host booted serving, and landed the writes it had deferred during the maintenance.
  - **Deferred writes** (`recovery/deferred-writes.json`, or `framework/deferred-writes` without one): the queue restored nothing, and the next deferral replaced it. An agent's context that can't be checked for writes that landed before their ack now fails `create()` too, where such a write landed a second time.
  - **A recovery file that can't be reached** (an error other than its absence, such as `EACCES` on its directory) fails `create()` too, where it read as absent.
  - **Usage totals** (`framework/state`): they started at zero, and the next inference stored zeros over them. A `framework/state` that isn't an object now fails `create()`, where every reader took it as empty.
  - **An agent's persisted runtime settings** (`framework/state`): the agent booted at its recipe's settings, a `private` think-text policy as `public`, and its next settings change stored over the record. 0.22.2's notes said such a read is logged and the agent boots at the recipe's; it now fails `create()`.
  - **Tool-result guards** (`framework/state`): a `toolResultGuards` that isn't an object read as no setting, and the next guard change stored over it. It's now read by each agent's own name, so an agent named `constructor` no longer fails `create()` once any guard is stored.
  - **MCPL coalescing** (`mcpl/coalescing`, `mcpl/coalescing-recent`): an acknowledged deferred acceptance or a pending batch was never delivered, and the next receipt or flush replaced the stored ones. A snapshot of a version this one doesn't read was ignored and replaced; it now fails `create()` and is kept for the version that wrote it. An agent's context that can't be checked for an occurrence already delivered fails `create()` too, where the occurrence was delivered again.
  - **MCPL checkpoint trees** (`mcpl/checkpoints`): a stored value without `trees` read as no checkpoints, and the next feature set registered stored over it.
  - On a framework started with no MCPL servers, the coalescing state and the checkpoint trees are read at the first `connectMcplServer()`, which fails instead, with nothing of MCPL built, and the next connect reads them again.
- A host-managed MCPL feature set's state (`mcpl/state/<server>/<feature set>`) is now read after a restart: when MCPL starts, for each configured server, and before `connectMcplServer()` adds a server. It wasn't, so the state read as empty, and the feature set's next delta checkpoint applied to nothing and stored over it. A failed read of it fails `create()`, or that `connectMcplServer()`, naming it, before the server connects. A feature set with no stored tree, such as one registering for the first time or after its server was disconnected, has its state read when it registers, as before. A failed read there fails that server's connect, as before, and `create()` logs that and goes on, as for any server's failed connect. The state is now read again the next time the feature set registers; before, its tree was held after the failed read, so the state was taken as empty.
- A usage count stored as `null`, which a provider's usage without a count left as `NaN`, restores as 0, and a usage without a count no longer makes the totals `NaN`.
- A failed read of the persisted `tool_result_inline_max_chars` caps at boot is now logged. As before, they don't apply until a restart, and setting one keeps the others stored.

- **`readFileFromDisk`'s `maxBytes` and `read_image`'s size limit now bound
  the read itself, so they hold for a file that grows while it's read.**
  Both were checked against the size the open's `fstat` reported (for
  `read_image`, the mount's `maxFileSize`), and a file within the limit
  then was read with `readFile`, which in Node reads to the size its own
  `fstat` finds, or for a size of 0, to the file's end. So a file that
  grew in between was loaded whole. `readFileFromDisk` returned all of it
  with `truncated` false, and `read_image` loaded it before refusing it as
  too large.
  - Each now reads no more than its limit and one byte past it, which
    isn't kept and says whether the file goes on. `readFileFromDisk` reports
    a file that goes on as `truncated`, and `read_image` refuses it with its
    usual "Image file exceeds max size" words.
  - `readFileFromDisk`'s `truncated` and `size` now say what the read found.
    A file that shrank under `maxBytes` after the open is no longer reported
    `truncated`. `size` is `bytes.length` unless `truncated`, and then the
    file's size by an `fstat` after the read, or `maxBytes + 1` if that's
    less. Before, `size` was the open's `fstat` size, so it could disagree
    with the bytes returned for a file that changed in between.
- **A sync, listing or scan now takes a file that grew past the mount's
  `maxFileSize` after its `fstat` as oversize.** The workspace hashes it
  in chunks and keeps only its head, as for any file over the limit.
  Before, its read of a file within the limit at its `fstat` used
  `readFile`, so a file that grew in between was loaded whole, and a sync
  could store the whole of a text file over the limit.

- A workspace mount's catch-up pass, which takes in what changed on disk
  while the session was down, now runs once the mount's watcher is ready. So
  a change made after the pass has looked at a file reaches the watcher.
  Started beside the watcher's first scan, the pass could finish with a file
  before the watcher watched it, and a change made between the two reached
  neither until a sync or a later catch-up pass took it in. A watcher that
  isn't ready within 30 s has the pass started then, and its ready, if it
  comes, runs the pass again. A re-attached watcher's pass waits for its
  ready the same way. The status's `initialSyncDone` turns true when the
  first whole-mount pass ends, usually the catch-up pass, so it now turns
  true later, by as long as the watcher's first scan takes, up to 30 s.

- A turn woken only by deferred coalescing batches is no longer started when none of them has anything for it to read. It used to run, calling the model although no new input had arrived for it, when the assembly found a batch's authority revoked (before or after its render-start commit), when the render-start commit failed, or when it found that the agent had left the batch's audience since the batch woke it. Such a turn is now withdrawn before inference, as a turn whose batches all rendered nothing already was, and traces `turn-withdrawn`. A batch whose render-start commit failed is still kept, and its recovery wake delivers its fallback once storage recovers. The stderr line for a withdrawn turn now reads `[coalescing] <agent>: its deferred batches gave this turn nothing to read; turn not started (no wake cause left)`. It said `deferred render produced nothing`, which is untrue where no render ran.

- A message that arrives on a channel while its conversation fork is being spawned now goes where it would have gone just after the spawn: into the fork once it is bound. The event queue and the coalescer each deliver their messages one at a time, but they run beside each other, and a fork's spawn waits while its template's withheld tool results are still being saved to the workspace. Meanwhile a second message for the same new channel, plain or coalesced, or a deferred batch that spawns the fork to wake it, could decide on the same spawn, and that second spawn failed ("already registered or reserved"): traced as `mcpl:conversation-spawn-failed` on an incoming message's path, logged on a batch's. A message that wouldn't bind the channel on its own, such as an unmentioned one where only a mention binds, was dropped as unrouted. Either way the message wasn't delivered to any agent. Now a routing on a channel whose fork is being spawned waits for that spawn and decides once it settles. If the spawn failed, its own message is lost as before, and a waiting routing decides as a message arriving next would, proposing the spawn again if its message qualifies. While it waits, the path it runs on waits too, for as long as the spawn's seed waits (the withheld results' 30-second deadline per batch): on the event queue, every channel's messages; under the coalescer's lock, every subject's.

- A reference in a push event, a render result, an incoming channel message,
  a context injection or the successful result of an MCPL tool called in
  process is registered with the server that sent it, as the references in
  the result of an MCPL tool call the agent makes are, so `fetch_reference`
  can fetch it from that server. These were registered with no server, so
  `fetch_reference` refused them, unless a tool result had registered the
  same uri with its server. A reference now keeps every server that
  delivered its uri, and `fetch_reference` dials through the first of them
  whose address is on the uri's origin, with that server's credential and
  against its fetch budget, so a server off that origin sending it first no
  longer stops it being fetched. One on none of their origins is still
  refused, as a tool result's is.

- A channel decision whose durable record fails to write no longer takes effect in memory alone (the first part of #417). The channel registry now appends to its lifecycle log before it changes memory, so a `channel_close`, `channel_open`, `channel_decline` or tune-out whose decision fails to append, as on a full disk, fails with the decision as it was, and a retry records it. Before, memory changed first: a retried close or open took the same-state return and reported success without recording anything, and after a restart the old record came back, so subscription policy could lift a close the agent had been told succeeded. The same order now holds for a tune-out's wake count, for the record that a server's recipe policy has been migrated, and for the channel label history that lets an agent name a channel it isn't connected to, including a label first seen in a push event.

- **Text cut to a fixed length for an agent to read no longer ends or
  starts on half a surrogate pair.** An emoji or another character outside
  the Basic Multilingual Plane that fell across such a cut left half of its
  pair, which the agent read as a replacement character (U+FFFD) or, in a
  result's data, as an escape such as `\ud83d`. These cuts now leave out a
  pair they would halve:
  - the event gate's quote of a debounced event's content (200 units);
  - a utility's one-liner in `utils list` (160 units);
  - a failed spill's reason in a truncated tool result (200 units);
  - each recent error in health's `snapshot` (400 units);
  - the last 2000 units of a dead background script's output, in the wake
    that tells the agent it died;
  - a thrown error's text, as a subconscious tool's failed result reports
    it. It's now cut at 500 characters counted as code points, as
    `boundedErrorMessage` cuts, and its "(N characters)" counts code points.
    A text within 500 characters now comes back whole, even past 500 UTF-16
    units. So do the framework's and the MCPL checkpoint manager's other
    quotes made through `thrownText`, such as a refusal when stored state
    can't be read.

- `quiesce()` now writes the queue of deferred context writes before it changes the host's mode, or refuses, and a write of that queue that fails elsewhere is reported where an operator looks.
  - **A write deferred behind a turn still alive** before the host quiesced was held in memory only. `quiesce()` didn't write the queue, so when its drain timed out with that turn alive, a crash before the queue next changed lost the write. `quiesce()` now writes the queue first, before the host-mode record, on a first call and a repeat alike.
  - **When the queue can't reach disk,** because its write fails or it's over the cap, `quiesce()` refuses with a `QuiesceBlockedError` and the host's mode as it was. The refusal names the ways out. For a failed write, which is its `cause`, that's quiescing again once the record can be written. Over the cap, it's waiting for the writes to land, or quiescing with `abandon: true`, then resuming so they land, and quiescing again. Either way, `quiesce({ abandon: true })` goes on, since abandon is the call for a turn that won't end, and writes held for a turn land only once it has ended. So it's also how to quiesce anyway: the queue stays in memory, not on disk, so resume before restarting, since a restart restores only what the record last held, or doesn't start if it can't read the record. The failure or the cap then raises the alert below. As before, the abandon's answer lists a turn it can't end as unabandonable, and its writes land once it has ended and the host is serving.
  - **A write of the queue that fails elsewhere,** such as when a context write is deferred while quiesced, still keeps the queue in memory, since the write's source has already been answered, and the queue's next change writes it again. It used to be logged and nothing more. It now raises a `deferred-writes` ops alert at a run's first failure, and a line is logged when a write succeeds again, which ends the run. A queue over the cap counts as a failure, so it raises the same alert when it begins a run. On a host that's quiesced, or that an abandon is quiescing, the alert and the cap's line say to resume before any restart. The cap's line is logged the first time the cap is met in a run, where it used to be logged once a process. Like every ops alert, it reaches failures.log and the `ops:alert` trace each time, and the webhook, when one is configured, unless one of its kind was posted in the last 15 minutes.
  - **The cap is unchanged:** when the queue's JSON is longer than 4,194,304 characters, counted as the string's length, its record isn't written at all and keeps what it last held.
  - **Without a recovery file,** the store is the record, and the queue's write wasn't synced, so a crash could lose it. The store is now synced after the write, as it is for the host-mode record, and a sync that fails counts as a failed write. The write is already in the store by then, where a later sync can still put it on disk, so the queue stays mirrored from then on.

- The `SIGUSR2` diagnostics dump prints a line for each framework from partway through its `create()`, once its agents, modules and event gate are built, until its `stop()` has waited on its streams and event loop, and one line, `[diagnostics] no framework is running in this process`, when there is none. A framework leaves the dump before its modules and MCPL servers stop, so one whose teardown hangs or times out isn't listed. Before, every `create()` added a `SIGUSR2` listener that nothing removed, so a process that made one framework after another, as connectome-host does on each session switch, kept every stopped framework reachable and printed a stale dump of each on every signal. Now one listener serves the process: the first `create()` installs it, and it stays for the process's life, since a process whose last `SIGUSR2` listener is removed is ended by the next `SIGUSR2`. A framework's own line is unchanged.

- **The direct API sends the agent's request settings** (`runInference`,
  `runInferenceWithInjections`). Its requests carried the agent's model config
  and `providerParams`, but not the `promptCaching`, `cacheTtl` or
  `prefillUserMessage` that a framework turn's requests carry, so membrane's
  own defaults applied to them. `promptCaching: false` never reached them,
  and membrane's default, which is on unless its `defaultPromptCaching` says
  otherwise, decided their cache markers. Those markers had no TTL, so the
  provider's default applied. Membrane's formatters got no
  `prefillUserMessage`. One method now builds these fields for both paths.
  - The agent's `promptCaching`, default `true`, now governs direct-API
    requests as it does framework turns, over membrane's
    `defaultPromptCaching`. A host that turned caching off only with
    membrane's `defaultPromptCaching: false` now gets cache markers on its
    direct calls, which fail on a transport that rejects them, such as the
    Bedrock legacy Claude models `promptCaching`'s doc names. Such a host
    sets the agent's `promptCaching: false`, as that doc advises.
  - A direct caller that never set `cacheTtl` now sends the agent's
    documented default, `'1h'`, so its cache writes may now be priced at the
    one-hour rate.
- **`prefillUserMessage`'s doc** said native formatting ignores it. Membrane's
  native formatter uses it as the text of a leading user turn that its
  tool-pair normalizer adds, and the doc now says so.

- The Discord module edits a tool turn's thoughts, as a spoiler, only into a message the same agent posted in the same turn. Before, it edited them into the last message the module had posted, whoever posted it and in whichever turn. That could be another agent's message, or an earlier turn's message: after a `send` or `reply` that was refused or threw, after a `dm`, or from the agent's last text turn when the tool turn posted nothing. People in the channel saw a message they had already read change. Now a turn that posted nothing, or only a DM, edits nothing, and an attempt in the turn that is refused or throws leaves the turn's own post to take the thoughts. A post or thoughts that carry no turn, such as from a host that calls the module without the framework's dispatch, are left alone.

- An ephemeral run that leaves while its tool-result guard still holds a batch now settles
  the batch as it leaves, before the agent is deregistered. The batch is withheld, so its
  stubs say where each original is, as for any withheld batch, and the guard's audit
  records how it ended. Until now several ways out left the batch pending on an agent
  nobody would run again, with no `withheld` record and no stub naming where its originals
  are: a failure whose stream ended only after the run's caller had deregistered the
  agent, a budget restart or error retry whose new start failed, a run the completion
  watchdog ended, and `stop()`'s sweep of the runs still registered. The record reads
  `run_stalled` when the completion watchdog ended the run as stalled, and `aborted`
  otherwise, as driveStream's own teardown records a stream that ended without a clean
  round.

- **A turn ended by a tool result (`endTurn`, such as `skip_reply`) is recorded as a completed
  turn** (#67). It emits `inference:completed` with the stream's cumulative usage, then
  `inference:turn_ended`, writes a successful inference-log entry (`stopReason: 'turn_ended'`),
  and adds its usage once to the session totals (`usage:updated`, `getSessionUsage()`). Like a
  completion, it resets the consecutive-failure streak and the poison-history rewind budget, ends
  a refusal-rewind episode (a forced `/unstick` reports that the model responded), and records a
  provider-cooldown recovery. In hosts such as connectome-host, consumers that end a turn's display
  on `inference:completed` (a typing indicator, notices that close on success, a voice relay) now
  end it on these turns too, and a consumer that totals `inference:completed`'s `tokenUsage` now
  counts them too; one that also adds each `inference:usage` sample counts them twice.
- **Every stream's billed rounds reach the session totals once, however the stream ends.** A
  context-budget or physical-window restart is counted and logged where it is decided
  (`stopReason: 'context_budget'` or `'physical_window'`), without `inference:completed`. A stream
  that errors, aborts or throws after finishing rounds counts them, and its failure entry in the
  inference log carries them. A stream superseded by a newer one, one whose agent was disposed,
  or one that ended with no final response and no other end, which wrote no entry before, now
  writes a failure entry naming what ended it and carrying its rounds, and `inferenceCount`
  counts it, when it had finished a round; one that hadn't has nothing to carry and writes none,
  as before. A stop of any other stream writes its own entry, which carries them. If the store
  fails while a stream's end is recorded, the error is reported on stderr and what comes after it
  still runs: the rest of a
  tool-ended turn's end, a restart's next stream, and the stream's teardown. Exactly one
  entry of each stream carries its usage, so totals summed from the inference log count each
  stream once, as the session's do. A health snapshot's token totals read the log's newest 1,000
  entries, so with these new entries that window spans fewer turns.
- An inference-log entry for a stream the framework ended at a tool boundary (a tool-ended turn or
  a restart) records a note in place of the compiled request, so these frequent entries don't each
  add a whole-context blob to the store. They are still new entries: the inference log keeps no
  retention, so it grows by one small entry for every tool-ended turn and restart, and by one
  entry, with its request, for each abandoned, superseded or disposed stream that had finished a
  round.

- A store failure while removing an agent's turn checkpoints no longer stops
  that agent's teardown partway. An ephemeral run, such as a subagent's,
  resolves with its result instead of rejecting with the store's error. A
  closing conversation fork's disposal runs to its end, through
  `mcpl:conversation-disposed`, where at its closure turn's end the stream
  rejected with nothing to catch it, an unhandled rejection that ends a Node
  or Bun process with no handler for one. The fallback reaper goes on to the
  next fork. The failure is logged as `[checkpoints] agent=…`, and those
  checkpoints stay in the store.

- A `code_execution` script whose interpreter is still starting is now stopped by `PyRunner.abort()` and `dispose()`, as a running one is, and so is one aborted on the tick `exec` is called. The exec settles at once, and the script never runs. Before, an abort in that window did nothing, though `busy` was already true: when a script's turn ended or was reset to run again in that window, the script ran to its end or its time limit, calling tools as it went, and each `code_execution` call of the agent's later turns was refused as another script already running until then. A dispose there, as a background script's cancel does, waited out the interpreter's 15 s start timeout and then reported that the runtime had failed to start. The interpreter starts at an agent's first script, after it has been idle, and after a script is aborted, killed at its time limit or crashes.
- A `code_execution` interpreter that stops reading its input, as one does after a script closes its standard input (`os.close(0)`), is now ended at the first message that can't reach it, and the script waiting on it settles at once, saying the runtime stopped reading its input. That message's failed write was thrown in the host as an uncaught exception (`write EPIPE`), which ended the host's process. After a script's `os.close(0)`, the next script's message is sometimes written without an error and never runs, and that script settles this way only at its time limit. An interpreter that died before its exit was handled still settles with its own exit code.
- A `code_execution` script stopped at its time limit now reads the note "script stopped: it reached its … time limit" on a line of its own when the text before it doesn't end with a newline, as the runner's own texts don't, such as an interpreter's exit. The note used to run on at the end of that text's line.
- An abort or a dispose on the tick `exec` is called, when the interpreter couldn't be spawned, no longer signals another process. The runner killed the failed spawn's child, which has no pid, in the tick before Node's `error` for it, and Node then signals whatever pid the child's handle held: in a fresh Node 20 process that was 0, so `SIGKILL` went to the host's own process group.

- Nine boolean switches take `true` or `false`, or can be left out, and `null` counts as left out: `subconscious.enabled`, `subconscious.allowChannelSpeech` (checked once the subconscious is on), `watchdog.enabled` and `processLogging.persist`, and each agent's `promptCaching`, `thinking.enabled`, `refusalHandling.autoRewind`, `toolResultGuard` and `toolWrapperProseGuard`. `create()` refuses any other value, naming the value's kind, not the value, and `createEphemeralAgent` and the `Agent` constructor refuse it in an agent's. Each was read by truthiness, so a quoted `"false"`, as a JSON config or a `${VAR}` substitution can write it, turned it on, and a falsy non-boolean such as `0` turned it off without a word. A settings object holding them (`subconscious`, `watchdog`, `processLogging`, an agent's `thinking` or `refusalHandling`) counts as left out when it's `null` or `false`, and anything else that isn't an object, such as `true`, is refused, since every switch in it was read as left out. `promptCaching` is still on unless it's `false`. A host that passes these on from its own configuration without checking them now gets this refusal from `create()` where such a value used to start.

- The Discord module's edits and history sync no longer erase what the host added to a stored message. A message is now stored with its own text first, `''` when it has none, followed by its images, inlined file text and attachment notes, and its row's metadata carries `discordTextFirst: true`. An edit, live or found by the history sync, replaces that first block alone. Before, an edit rewrote the message as Discord's plain text, dropping its images, attachment notes and inlined file text. The history sync, which runs when the client becomes ready, did the same to any message with a note or an inlined file, since it compared Discord's text with all of the stored text at once, and a message whose only content was such a note or file then read as nothing at all. An update that leaves the text as it was now changes nothing, and an edit that removes a message's text, leaving its attachment, now reaches a message stored from now on. A live edit leaves a row stored before this change alone unless Discord's text is there and differs from the row's first block. It then puts the text in that block's place when the block is text, and before it when it isn't, and keeps the rest. Before, it rewrote the row as the text alone. A message that had no text of its own and was stored beginning with a file's contents or a note loses that block, where the rewrite lost everything, until the history sync stores it again.
- A live edit or delete now reaches a message that arrived live. Both looked the row up in the module context's external-id index, which holds only rows a module stored through its context, such as the history sync's, so they did nothing for any other message.
- A message the history sync missed is now stored as the live path stores it, with its images, small text files and attachment notes, where only its text was stored before. The sync also stores a row again through the live conversion when it doesn't hold what that conversion gives its message now: an attachment-only message an earlier sync blanked reads again, one it stripped of its notes or files gets them back, and an attachment removed from the message goes. One whose text changed while the client was away keeps its files. A row stored before this change for a message without text, whose first block is text, is stored again once, since that block may be a caption the message lost while the client was away. A rebuild whose text file can't be fetched writes nothing over a row holding other text, which may be that file's, so the row keeps what it holds and the next sync tries again; a row missing its file gets the notice that it wasn't fetched. A row the live path stored before the sync began is neither rewritten nor fetched again; one it stores while the sync fetches history may have its attachments fetched again, and is then left as the live path wrote it.
- The history sync now leaves alone a message the live path stored, changed or was told was deleted while it ran; an update that changed nothing doesn't count. It runs the conversions it needs first, then reads the store again and writes with no await between. A message the live path stored while it ran, which its fetch couldn't hold, is no longer removed as deleted. A row another writer removed while it ran isn't stored again. Before, a live edit made while the sync fetched history was written over with the fetch's older text. It writes nothing once the module has stopped or started again. A message a context strategy stored as a body, in shards, is kept as stored by the sync and by a live edit, since a body can't be edited in place, so an edit to it isn't taken in, and a live one writes a console line saying so. Before, the sync threw on a shard and stopped at it on every pass, and a live edit that found a shard threw too.
- `fetch_history` lists each message's attachments by filename, type and size, without their URLs, which work for anyone holding them until they expire.
- A send that posted its message but whose thread wasn't started now counts that message as the one the bot last sent, so the agent's thoughts are edited into it. Before, the message wasn't recorded, and the thoughts went into the message the bot sent before it, or into none. The send's result is the same error as before.
- Host authors: a Discord message stored from now on has its own text as its first content block, `''` when it has none; a row stored before keeps its layout until the history sync stores it again. The request builder drops an empty text block, as it already did, but a UI that renders stored content should expect one, and the history module's `raw` format shows it. `HistoryMessage` gains an optional `attachments`, which a custom `DiscordClientInterface` can fill; left out, the sync can't compare a message's attachments, so it rebuilds no row, though it still changes a row's text as a live edit does. `MessageQuery` gains `externalIds`, which context-manager already accepted. A `DiscordClientInterface`'s `sendMessage` may resolve with `threadFailure`, why the thread it was asked for wasn't started; one that throws instead works as before, and the message it sent isn't counted as the bot's last.

- An MCPL server's error result (`isError: true`) is now a failure for a caller in process too. `executeToolCall` and a module's `ModuleContext.callTool` got such a result as a success, `success: true` with the server's blocks as `data`, so a caller that checks `success` took a refused call for one that worked. They now get the failure the model's call gets: `success: false`, `isError: true`, and as `error` the result's text blocks joined by line breaks, a text that isn't a string shown as the converters' placeholder, or `Tool call failed` when it has no text. Its blocks that aren't text, which such a caller used to get in `data`, aren't kept, as the model's call never kept them. A success is unchanged: the server's blocks as `data`. The admin puppet (`puppetToolCall`) calls through the same path, so it now stores a server's error as an error result, where it stored it as an ordinary result the agent read as the tool's answer, and its `puppet:tool-call` trace now says `isError: true`.
- A server's error result through the model's call, and a channel tool's error result, such as `channel_open`'s refusal of a channel it doesn't know, are now traced as `tool:failed` with their error, where they were traced as `tool:completed`, so a host that shows failed tools, as connectome-host's terminal view does, now shows these among them. What the agent reads is unchanged.

- `set_tool_visibility` and `set_tool_description` refusals now lead with "Nothing was changed", lose the "Error: " prefix, and say what helps. Arguments of the wrong shape are named together, each by its key, with the call that works. A tool name that isn't available is quoted, cut past 60 characters, and gets the closest names, quoted whole, and the catalogue's index to copy from. A description over 32,768 characters, or hiding one of the three tools that can't be hidden, is refused as the agent's own input, where before it read as a problem with the file; a description's length is now counted in code points rather than UTF-16 units, so a character outside the Basic Multilingual Plane, such as 😀, counts once rather than twice. A stale `.lock`, a presentation file that is a symbolic link, an edit that would take the file past 256 KiB (with the bytes over), and a file changed during the edit each say what happened and whether calling again helps. An edit whose lock can't be removed after it's done now succeeds where it failed, and says that its lock was left and that edits will be refused until it's removed; a refusal that leaves its lock says so too. A lock that something else removed first is not reported as left.
- A presentation or description-defaults file the host can't use is reported with its problems all at once (up to ten, then how many more), each by its entry, both by the editing tools and in the catalogue's diagnostics. A name a problem quotes is cut past 60 characters and a value past 40, counted as code points, and the key the catalogue reports as not currently available is cut as a name is. The diagnostics also say what applies meanwhile and who can fix the file, each on one line of the catalogue. A presentation file that is a symbolic link to nothing is reported as such, where it read as no file. `parsePresentation`'s error names the document's problems the same way, where before it named the first, in other words.
- A `code_execution` script stopped at its time limit says its tool calls keep their effects, and offers `time_limit_ms` only when a longer limit is allowed. At the deployment's ceiling, which is the default unless `maxScriptTimeoutMs` raises it, it says that is the longest a script runs and to split the work, or to run it in the background when this agent could start a background script as the script starts (it runs them, and a slot is free) and one may run longer (a background script: that starting it again runs it from the top). Before, it said only that the script had stopped. A script whose interpreter exits under it, can't start, or exits as it starts says what ran and whether running it again can help; a missing `python3` says `code_execution` can't run there until the host installs one, a non-executable one until the host makes it executable, and a failure creating or writing the runtime's files says so, with its path. A second script while one runs says they run one at a time.
- Inside a script, a tool function called with keyword arguments, such as `await workspace__read(path="a.txt")`, is refused with the dict to write, `await workspace__read({'path': <str>})`, where before Python reported an unexpected keyword argument. A `str` key in that dict is shown whole up to 60 characters, and a longer one, any other key and every value by its type; a non-dict argument is named the same way.
- **Hosts driving `PyRunner`:** `exec()`'s options take `ceilingMs`, the longest limit the deployment allows that kind of script; without it, a stopped script isn't offered a longer limit. A foreground exec's `backgroundCeilingMs` is the longest a background script may run, which a script stopped at its ceiling is offered when it's longer; leave it out where the caller can't start one.

- An MCPL text block whose text isn't a string, which only a nonconformant server sends, now reaches the agent as `[Text not shown: the server's text block had no string text.]` instead of vanishing from its view or reading as `[object Object]`. That holds on the push and channel lanes, coalesced or not, in a `context/beforeInference` injection, and in a tool result, text-only or beside an image or a reference, where such a block sent the whole result to the agent as JSON, a reference's uri included. An MCPL tool error whose only text isn't a string now reports the placeholder as its error, where it read `[object Object]` for an object, the value itself for a number or `true`, its items joined by commas for an array, and `Tool call failed` for `null`, `false` or `0`. A `system` injection's text used to be joined into the system prompt as it was, which for an object with no string form threw while the request was built; a text-only tool result whose only block was such a text came back as an empty success. The placeholder still counts as no text when a message is checked for visible content, so a message holding only such blocks (or blank text) is still refused as empty, with the same answers as before, and a message whose blocks are numbers, strings or booleans is still admitted uncoalesced as its untyped placeholders. A `shouldTriggerInference` filter, and so the EventGate's content filter, now reads the placeholder where it read an empty line, as it already reads the converters' other placeholders.
- A `context/beforeInference` injection's content now converts as a pushed event's and a channel message's does: one converter serves all three. Before, an injection block whose `type` wasn't a string read as that value (`[unrecognized content block: 5]`, `[unrecognized content block: [object Object]]`), and one whose `type` was an object with no string form threw while it was converted, so the framework dropped every server's injections for that turn, with only a console line. An image's `data`, `mimeType` or `uri`, or an audio block's `data` or `mimeType`, that wasn't a string was passed on to the provider as the block's source, and a `uri` with a `disposition` was taken as a reference. An audio block without inline data showed its uri in its text: one that wasn't a string read as itself, and one with no string form threw, as a `type` did. Such fields now count as absent, and such blocks show the placeholders the other lanes show: `[unrecognized content block: untyped]`; `[Image: no data]` (where it read `[Image: missing data]`) or `[Image: no media type]`; and `[Audio: no data]` (where it read `[Audio: <uri>]` or `[Audio: missing data]`) or `[Audio: no media type]`. So an injection no longer writes an audio block's uri into the agent's text. An injection the host can't read is now left out with a console line naming its server, and the turn keeps every other injection: one holding a null block or content that isn't an array, a null injection, or one whose position has no string form, and likewise an answer whose injections aren't a list. Before, any of these dropped them all. An injection whose namespace can't be read as text, such as `{"toString": 1}`, is left out the same way. Before, a `beforeUser` or `afterUser` one failed the whole request, since context-manager writes the namespace into a participant's name as it builds the request, and a `system` one arrived, as context-manager never reads its namespace. Any other namespace that isn't a string, which §10.4 doesn't allow, still reaches the agent as it did: a `beforeUser` or `afterUser` injection's is written into its participant's name as its text, such as `system_context:5`, or `system_context:undefined` for an injection without one. The first such namespace from each server now gets a console line saying so. The line for an injection outside the server's grant now prints its position as one field, so a position holding a line break can't add a line of its own.
- The Discord module now gives the agent `[Attachment: <filename> (failed to fetch)]` for a text attachment whose download is answered with a status that isn't OK, as it already did when the download threw. Before, such an attachment was left out without a word, and a message with nothing else in it read `[Empty message]`. Either failure now also writes a console line naming the file, the message and the status or error, and an answer that isn't OK has its body cancelled, so its connection is released.

- A connect refused at a stdio MCPL server's exit now takes its `stderrTail` once the server's stderr has ended, waiting up to a second after the server's exit for a process that still holds the stream, such as one the server started. Node can emit a child's `exit` before it has read the last of the child's stderr, and the tail was taken at the exit, so a server that printed why it failed and exited could be refused without that line. A process the server started and left running with its stderr now holds the refusal up by that second.

- A block that isn't text in a `system` injection, such as an image or audio block that an MCPL server's `context/beforeInference` hook or a module's `gatherContext` put there, now reads in the system prompt as a line in its place, naming its type: `[image block not shown: the system prompt carries text only.]`. Before, the system prompt kept only an injection's text blocks, so such a block vanished with no sign to the agent, and an injection holding only such blocks left the system prompt as it was. The first such injection in each namespace also gets a console line naming its server (`[mcpl] <server>: …`) or its module (`[<module>] gatherContext: …`), once per server or module and namespace while the host runs. For an agent given such an injection, the system prompt changes with this upgrade, so its first request after upgrading misses the prompt cache.

- The workspace's `edit` writes its replacement as given. It read `$&`, `$$`, `` $` `` and `$'` in `newString` as replacement patterns. It now refuses, changing nothing, four edits it used to report as successes:
  - an edit of a file that isn't valid UTF-8, where decoding and writing it back turned every invalid byte sequence in the file into U+FFFD;
  - an empty `oldString`, which matched between every character;
  - a `replaceAll` whose `oldString` isn't in the file, which stored the file unchanged;
  - a lone UTF-16 surrogate in `newString`, which was written as U+FFFD. One in `oldString`, which used to miss, is refused the same way. `write` now refuses one in `content` too, as every tool does in a path.
- Every workspace tool checks its input against its own schema before it does anything: required fields, strings, booleans, and whole numbers, with `read`'s `offset` and `limit` at least 1 and `grep`'s context lines at least 0. An edit missing `newString` wrote the word "undefined", and `replaceAll: "false"` counted as true. A typed field given as `null`, or a number given as a string, is refused too, as `read` already refused them for `offsetChars` and `limitChars`. Before, some handlers read `null` as the field's default and did arithmetic on a numeric string. `read`'s `offset` and `limit`, and `grep`'s `contextBefore` and `contextAfter`, are typed `integer` in their schemas.
- A `write`, `edit` or `delete` that the workspace stored but couldn't finish still answers as an error. That covers one whose push to disk didn't complete, and one that failed after its change was stored. The answer now leads with the fact that the change is stored and mustn't be sent again, then gives the push's reason, which says what disk holds and the way out. All of that is in its text, which is what the model and a `code_execution` script receive of an error. Before, a refused push's answer began "Wrote to Chronicle", "Edited Chronicle" or "Removed from Chronicle", and a failure after the change was stored gave only the error. Either way, an edit sent again could apply twice.
- A refused push's way out names the tool that takes it, `materialize it with force`, where it said `pass force`. For a deletion it adds `applyDeletions`, which materialize needs to unlink anything. A disk copy that can't be verified is told to fix it and materialize again. `force` is named beside that only where a forced push gets past what kept the copy from being verified. A file its permissions keep the workspace from reading is offered force if disk lets the workspace write it, or, for a deletion, unlink it, since a read's refusal doesn't show either. Before, force was named for every such copy, though a forced push leaves a symlink the mount doesn't follow, or a FIFO a write meets, as it is. A path whose branch intent can't be read is told to sync the path, which replaces the intent. Where disk's copy can't be verified either, it's told that first, since a sync replaces the intent only once it can see disk's copy. Before, it was told to fix it and materialize again, which is refused the same way until a sync does. `ls`'s description names `applyDeletions` beside `force` for a path the workspace deleted.
- `read` counts the lines a file has: a final line end no longer starts an empty extra line, so "a\nb\n" is two lines, and an empty file has none. `grep` numbers lines the same way. An `offset` past the last line answers empty `content` with the file's `totalLines`, no `fromLine` or `toLine`, and a note saying where the file ends. Before, it claimed a range that ended before it began. Reading an empty file from line 1 answers `totalLines: 0` with no note.
- An `edit` first takes in a change on disk to a file the workspace holds, as a listing does, and applies to that text. Its answer says so when disk's copy had changed since the workspace last agreed with it, when disk had deleted the file, or when disk's copy couldn't be checked and it used the workspace's copy. Before, it edited the older stored copy, and on a mount that pushes, its push then failed as stale. When disk has no copy and nothing records whether it was deleted there, the edit uses the workspace's copy, as before. That copy goes back to disk with the edit's own push on a mount that pushes, or when the path is materialized on one that doesn't, and the edit's answer now says which. Where the path's stored copy is a draft and disk changed too, the edit applies to the draft as before, and its answer names the conflict and the two ways out, as does an edit refused there for what it found. `write` doesn't look at disk first, since it replaces the whole file; as before, it only settles a pending intent.
- `grep`'s refusal of an invalid pattern gives the parser's reason, and the workspace's refusals no longer begin with "Error: ". A push that disk's shape refuses says what's in the way and the way out: a directory at the path, or a file or a symlink where the path needs a directory. Before, it offered `force`, which can't write or unlink there either, and a file in the way named no way out.

- Two channels whose ids differ only in characters a conversation fork's name can't hold, such as `foo bar` and `foo-bar`, no longer get forks of one name. The name was the channel id with each run of characters other than letters, digits, `_` and `-` replaced by `-`, so both channels' first forks were `conversation-foo-bar-g1`. In one process, the second channel's spawn failed ("already registered or reserved") on every message, and its messages reached no agent. After a restart, its fork opened the first channel's namespace, wasn't seeded because that namespace already held history, and carried on as the first channel's conversation, which then went to the model in the second channel's turns. A fork's name is now `<prefix>-<readable>-g<generation>-<hash>`, such as `conversation-C123-g2-e08e564271867d16` for Slack's channel `C123` on a server named `slack`, or `conversation-discord-123-456-g2-1cd68209a232e3d5` for discord-mcpl's `discord:123:456` on a server named `discord`. The readable part is that sanitized id cut to 64 characters, and the hash is the first 16 hex digits of a SHA-256 of the server and channel ids. Traces, logs, the fork's namespace (`conversations/<name>`) and the fork's own participant name in its context carry the new form. In a server's `toolLifecycle` narrowing by `conversations`, a pattern over the readable part and `-g`, such as `conversation-C123-g*`, still matches each generation's fork. A pattern that ends at the generation, such as `conversation-C123-g2`, no longer matches, and needs `-*` at its end. Neither does one that spells out more of a channel id than the first 64 characters it sanitizes to; it needs to stop at those 64. Bindings aren't stored and the generation counters keep their keys, so nothing stored changes: after the upgrade, each channel's next fork takes the next generation under the new form. `IncomingMessageFacts` gains an optional `serverId`, which the framework passes; a direct `ConversationRouter.route()` call without it gets a name whose hash has `null` for the server.

- `workspace--glob` and `workspace--grep`'s `glob` filter now refuse a brace group they can't read, with an error that names the pattern and says that `?` in place of a `{` matches one in a name: a `{` that never closes, such as `src/{a,b`, a group inside another, such as `{a,{b,c}}`, and a group with no `,`, such as `{name}`, `{}` or `{1..3}`. Before, a `{` that never closed kept the pattern's conversion from finishing, so the call never answered and the process handled nothing else while it ran. The other two were misread with no error: `{a,{b,c}}` matched `a}`, `{b}` and `c}` and none of `a`, `b` or `c`, and a group with no `,` lost its braces, so `{name}` matched `name` and `{1..3}` only `1..3`.

- The history tools' refusals now open with what didn't happen ("Nothing was read", "Nothing was searched"), name the field and the value the call gave, and say what to send instead: how to write an ISO 8601 date, which fields go together (`before`, `after` and `allChannels` with `aroundId`; `windowOffset`, `afterId` and `seqMark` with an author filter), a count such as `limit` or `maxScan` with its range and default, how to find a channel's id, where a message id comes from, and that a continuation's fields are copied from its `resume` into the call. A search continuation that can't step past an instant shared by more than 5000 messages now points to reading it with `history--extract`; it used to suggest an author filter, which can't narrow that count. `history--semantic_search` says whether the semantic index service didn't answer, couldn't be reached, or answered with an error, and whether trying later can help. The client's errors carry the service's HTTP status (`EmbedServiceError`), and the checks for a missing namespace or a service without `/delete` read that status, not the message's text; the index's log lines name the index. A tool name the module doesn't route gets the list of its tools, and a call made before the host binds the module says it's the host's to fix, with the detail in the host's log.
- `history--search` reads a number given as its `query` as that number's text, whichever way the search is made, a regular expression taking that text as its pattern. It used to fail on one unless `caseSensitive` was set, and with it a search for text came back with an empty snippet; only a regular expression searched it as text. Any other `query` that isn't text is refused, as an empty one is.
- `history--semantic_search` keeps the hits it found when it searches again for more and that search fails, and says why in `index.searchAgainError`. It searches again when too few of its hits are on the agent's branch, and a failure of a later search used to refuse the whole call. A hit whose `ts` isn't a number of seconds or text holding one, or whose `meta` isn't an object, now comes back with no timestamp, or no participant or author. Such a hit among those returned used to fail the call where its `ts` made no date or its `meta` was missing or `null`, and a `ts` of `""`, `false` or `[]` read as a date in 1970. The host's log names each such hit, but for a `null` `ts`, which is written so on purpose.
- When the semantic index service answers the background sync's stats request with a 2xx that isn't stats, such as a web page from a wrong route, the sync names that answer in `index.lastError` and walks from the start, as for a store the index doesn't hold yet; a pass whose budget runs out then fails on that answer and backs off. A web page there used to read as no stats, so every pass re-sent the history from its start without a word, and a history longer than a pass's budget was never walked to its end; JSON without stats by kind failed every pass, so nothing was indexed.

- The history module's semantic index no longer stops taking removals because one came before the index was made. The removals and edits phase runs before any upsert, so a removal made before a store's first pass went to `/delete` before its index existed. When `/delete` answered 404, as a service may for a namespace not made yet, every later removal was dropped until the host restarted or bound the module again, and removed messages stayed in the index, which only grew; search-time checks keep them out of results.
  - A pass whose `/stats` answers 404 now has no index to remove from: it drops its removals, and the deletes of messages edited down to nothing indexable, without calling `/delete`. The index that pass makes takes only what the store holds and can index, which leaves them out.
  - Only a pass whose `/stats` answered with stats reads a 404 from `/delete` as a service without that route. Such a 404 still ends removals until the host restarts or binds the module again, and until then no pass calls `/delete`, where an edit down to nothing indexable called it again each pass and repeated the warning.
  - A 404 from `/delete` in a pass whose `/stats` answered with something that isn't stats, such as a page shown while the service restarts, is re-queued like any other failed delete, since that answer doesn't show the index is made. While `/stats` keeps answering so, each pass sends the delete again.
  - The warnings for a failed delete name removals and edits down to nothing indexable apart, where one counted every delete as a removal and the other counted only the removals.

- The snippets the history tools cut, and the text they send the semantic index, no longer begin or end on half of a surrogate pair, half of an emoji for instance. `history--search` keeps up to 80 UTF-16 units each side of a match, `history--semantic_search` up to 400 of a message hit's text, and the semantic index up to `maxChars` (32,000 by default) of a message's or a summary's text, each one fewer at a cut that would split a pair. A summary hit's snippet is still the one the index service sends. The internal `safeSlice` now also moves a start that falls on a low surrogate forward past it.

- **A `stop()`, surgery or maintain begun from inside a context-maintenance pass now finds the pass.** The pass is registered before its body runs, so a `stop()`, `rollbackToMessage()`, `suppressMessages()`, `switchBranch()` or `maintenanceTick()` called from a trace listener on the `ops:alert` the pass raises while it prepares, or from a strategy's tick before that tick's first await, waits for the pass or joins it. A tick that awaits such a call waits on its own pass, as a tick already did for a call it made after its first await. Before, `stop()` closed the store while that tick was in flight, and the pass then met the closed store and reported it as the agent's maintenance failure ("Store has been closed"), with a `context-maintenance-failed` alert. A rollback moved the branch under the tick, and the pass went on ticking on the new branch. And `maintenanceTick()` started a second pass beside the first, so two ticks of one agent ran at once.
- **A context-maintenance pass or an over-budget drain kick takes no further tick of an agent disposed while it runs,** such as a conversation fork closed after it went idle, or an ephemeral run that ended. A tick in flight at disposal finishes. Before, each went on ticking the disposed agent's context manager, up to eight ticks, for a context the framework runs no further turn on. The drain kick's log line says `stopped as the agent was disposed`.

- The MCPL connection's buffered-event cap counts each pause's drops: the
  flush line that ends a pause reports that pause's drops, and the drop log
  speaks at each pause's first drop. Previously the count ran for the
  connection's whole life.

- A `reconnect: true` MCPL server that the framework closes for good now
  leaves the registry even when it's down at the time, so a later connect of
  its id isn't refused as already registered. The framework closes a server
  for good when a runtime `connectMcplServer` or `restartMcplServer` fails
  its Discord awareness accounting or its policy registration, and when the
  server refuses the host's policy with the `"close"` fallback. The registry
  dropped a closed server only when its connection reported the close, and a
  connection that's down between retries reports none. So the stub a failed
  first connect leaves stayed registered after such a close, and a later
  `connectMcplServer` of its id failed as already registered until
  `disconnectMcplServer` or `restartMcplServer` dropped it. A close that
  fails still keeps the server registered, so a later disconnect, restart or
  shutdown can close it again, and the failed connect now logs it.
- A runtime `connectMcplServer` or `restartMcplServer` that fails after
  pausing the other MCPL servers' data planes no longer leaves their data
  held. The connect paused them behind a gate that it settled only when it
  succeeded, so their pushes, incoming messages and inference requests
  waited until some other gate completed.
  - When its Discord awareness accounting fails, it now fails that gate, as
    a failed reconnect, tools-list reconciliation,
    `syncDiscordAwarenessMarkers()` or `resume()` already does: each running
    server is recycled, and its reconnect's own gate holds its data until
    that reconnect's accounting succeeds. A server without `reconnect: true`
    is closed for good there, as on those paths. While the host is stopping,
    the gate is released instead.
  - When its policy registration throws after accounting succeeded, it now
    closes the new server for good, where it stayed connected and half
    registered, and completes the gate, with no recycle.
- `McplServerConnection.ready()` and `readyControlPlane()` now do nothing once
  the connection is closed for good: closed, with reconnect off, as after
  `close()` or a drop with reconnect off. What it held stays held. Any gate's
  completion used to pass the part of it that needs no grant to listeners,
  as for a connection whose close failed and so stayed registered. While the
  host stops, a connection closed for good, such as one being closed, no
  longer passes what it held to the stopping refusal, whose answers can't be
  sent on a closed connection.

- An MCPL server's `inference/request` result now gives as `model` the model membrane names as having served it, `details.model.actual`, which is what SPEC §11.3 defines `model` as (#414). It gave the model the routing policy chose, or `default` without a policy. When membrane names no model, the result gives the routed one, as before, and on its streaming paths and most of its adapters membrane names the requested model itself when the provider names none. The `mcpl:inference_complete` trace keeps the routed model in `model`, as `mcpl:inference_start` has it, and adds `actualModel`, the model the result names, which it leaves out when membrane names none.

- An MCPL server's `inference/request` now gets a result only for an inference that completed with a stop MCPL can name, and the JSON-RPC error otherwise, whether it was streamed or not. A streamed request whose stream failed, such as on OpenRouter's mid-stream error, or stopped early, such as on a timeout, was answered `end_turn` with whatever text had arrived. In XML tool mode, a model that wrote a tool call parked a streamed request's stream, so the request was never answered. Each now gets the error the non-streamed path already sent for a failure, code `-32603` with the cause in its message, and an `mcpl:inference_fail` trace. So does an inference that ended with a stop reason `finishReason` has no value for, which was answered `end_turn`: `refusal`, `tool_use`, `pause_turn`, `abort`, and membrane's guard stops `no_progress` and `round_limit`. So does an inference the provider ended with `finish_reason: "error"` and no error object, which membrane has no stop reason for: it was answered `end_turn` with the text so far. In XML tool mode, so does tool-call markup that was answered as a completion: a tool call in a request that isn't streamed, whose markup was returned as content, and, streamed or not, a tool-call block membrane reads no call from or one still open when the output ended, such as a call cut off at `max_tokens`. membrane tells an open block from the text, so a completion that writes `<function_calls>` in prose and never closes it gets the error too. An inference the provider ended with a stop token membrane has no stop reason for, other than `error`, such as Gemini's `OTHER`, is still answered `end_turn`, since membrane normalizes the token to that.
  - **MCPL server authors:** a streamed `inference/request` can now end in a JSON-RPC error after chunks have arrived, and the error carries no partial text. anima-research/mcpl#20 asks the spec to say what a server does with those chunks.
  - A streamed result carries the response's `finishReason` and `usage`, as one that isn't streamed does. It was always `end_turn` with zero usage, so an answer cut off at `max_tokens` read as finished. Its `content` is the text of the response's text blocks, so in XML tool mode it no longer includes thinking, except a thinking block still open when the output ended, such as one cut off at `max_tokens`. A result that isn't streamed still includes thinking, since membrane's `complete()` keeps the `<thinking>` markup in the text.
  - Chunks carry only text membrane marks visible: thinking and the text of a tool call are no longer sent as `inference/chunk` deltas. In XML tool mode membrane's stream parser also opens a block at a `<function_results>` or `<invoke>` tag written in prose, so the chunks can then leave out text that the result's `content` holds.
  - A streamed request's `mcpl:inference_complete` trace now carries `inputTokens` and `outputTokens`. `streamed`, which only that trace carried, is now on every success and failure trace.

- An `mcpl/manifestChanged` notification sent without params is handled like
  any other: the fetched manifest is applied, its
  `mcpl:manifest-change-receipt` is emitted naming no domains, and the tools
  list is refreshed. Previously the handler threw once it had applied the
  manifest, so the receipt and the refresh were skipped. The receipt's
  `announcedDomains` now holds only the strings of the announcement's
  `domains` array.

- A WebSocket server's close reason no longer reaches the errors a close
  makes. A WebSocket transport that closes during the handshake now fails the
  connect with the transport's words and the close code, such as
  `(websocket closed, code 4001)`, whether or not the server sent a reason,
  and each request pending when the connection drops is rejected with
  `reason=websocket closed`. Previously both errors carried the server's text
  as it wrote it, into the host's log, the `mcpl:server-connect-failed` trace,
  the `mcpl-down` alert and a tool call's result, and the connect error gave
  no code. `mcpl:server-closed` already left that text out. A stdio child's
  exit reads as before.

- A message deferred during a turn that can't join the live stream at a tool
  boundary — one carrying tool blocks, or named as the agent itself — now
  waits for the turn's end, after its last round, instead of being stored at
  the boundary between rounds the stream never showed it. Messages queued
  behind it wait with it, so the queue keeps its order; messages queued
  before it are still heard at the boundary. The cost: a message addressed
  to the agent but queued behind a held one isn't heard mid-turn, and waits
  for the turn's end, and unless the queue is persisted (below), a held
  message and what is queued behind it live only in memory until then, so a
  crash during the turn loses them. Stored between rounds, a held message
  sat before the turn's later replies in every later compile although their
  requests never held it: a prompt-cache divergence, and on a provider that
  binds signed thinking to the prefix it was minted under
  (anima-research/context-manager#155, whose binding
  anima-research/context-manager#160 walks), a reply whose thinking is
  refused.
- A message injected into the live stream at a tool boundary now counts as
  read for RFC-006 coalescing when the stream says it carries injected
  messages (membrane's `ToolContext.supportsInjectedMessages`, which
  membrane's main sets true on its native path): the consumed watermark moves
  when messages are injected, not only at a compile. Before, an injected
  message sat above the watermark of the turn's compile, so a coalesced
  replacement for its subject could remove a message the agent had heard and
  answered. Within a branch the watermark only advances: a compile that
  started before such a mark doesn't roll it back when it finishes. A stream
  that doesn't say, as on membrane 0.5.87, still gets injected messages, and
  they stay unread, as before: 0.5.87's XML tool path doesn't carry them, and
  warns that they'll come next turn instead.
- A stream that says it can't carry injected messages (as membrane's main says
  of its XML prefill path) gets none: everything deferred for the agent during
  the turn waits for the turn's end, after its last round, as a held message
  does, instead of being stored between rounds the stream never showed it.
- A deferred write that a flush defers again does so whatever its content,
  under its id and in its place in the order writes arrived. That happens
  while its target's own turn, stream or tool cycle is alive, or the host is
  quiesced. (A write whose store throws before storing it goes back into the
  queue too; see below.) A `tool_result` used to land regardless, apart from
  the `tool_use` it answers, which went back into the queue.
- A write that waits now waits on its own target's state: the target's
  turn, stream and tool cycle, or a quiesced host. (A fresh `tool_result`
  still doesn't wait.) Before, a write for the primary agent waited out every
  agent's tool cycle, while one addressed to an agent waited only on that
  agent's. So a turn's end could store a later addressed message ahead of an
  earlier one for the primary, and a fork's, subagent's or the
  subconscious's tools held the primary's writes, which protected nothing in
  the primary's window. Each flush, at a turn's end, after surgery, after a
  withdrawn turn, after a start that ends before its stream and after a
  puppet call, now delivers the agent's deferred messages while another
  agent's tool cycle is pending; only the agent's own state holds them. The
  flush after surgery stores several agents' entries in the order they
  arrived, where it went agent by agent: residents share one message slot,
  so that reordered their shared transcript.
- `stop()` now stores what is still deferred for each registered agent
  before the store closes, in the order it arrived; before, a memory-only
  queue lost it. Once `stop()` begins, a new ephemeral run is refused. Since
  no turn starts or registers a stream once `stop()` begins (unless
  `start()` is called before it finishes), no reply can then follow a stored
  entry in a stream, so `stop()` stores each one even while a frame it
  doesn't wait for still holds its target's turn, such as a turn started
  outside the event loop, or a puppet call still running after `stop()`'s
  wait for operator operations timed out; that call's pair then lands after
  them. A quiesced host keeps what is deferred in its persisted queue for
  boot recovery. An entry for a target no longer registered (a disposed
  fork) is dropped from a memory-only queue at exit, as before.
- What is deferred for a conversation fork whose closure turn ends, or for
  an ephemeral run that ends, is now stored in that agent's store before the
  fork is disposed or the run deregistered. Before, the turn-end flush ran
  after, found no agent to take it, and dropped it. A closing fork is now
  disposed by the frame that ends its closure turn: one that hands the turn
  to a successor (a guard or budget restart) leaves it. Before, that frame
  disposed it, so the successor found no agent and the turn never finished.
  A quiesced host defers what is queued for an ending run or a closing fork
  again instead, and with the agent gone, the flush that meets it later
  drops it.
- A deferred write whose store throws without storing it goes back into the
  queue under its id, and so does every entry queued behind it for that
  agent, so none of them lands ahead of an earlier one, and a queued
  `tool_use` that can't be stored keeps the `tool_result` queued behind it
  from being stored alone. (A stored `tool_use` whose `tool_result` then
  can't be stored stays alone until the result lands at a later flush.)
  Other agents' entries go on, in the order they arrived. The log line names
  the entry at each flush, and one that keeps throwing holds what is
  deferred behind it for that agent until it can be stored. The hold is the
  queue's: a write that isn't deferred is stored at once and can land ahead
  of a held entry. That's a fresh `tool_result`, a message assembled into
  the agent's turn before its compile (RFC-006 coalescing), and any write
  while the agent's turn, stream and tool cycle are idle and the host isn't
  quiesced. So an entry that keeps throwing holds only what is deferred
  while the agent's turn, stream or tool cycle is alive, or the host is
  quiesced. Before, it stayed in the un-acked set and the next
  acknowledgement dropped it from the persisted queue (at a turn start or a
  flush it was lost even from memory). At a tool boundary, nothing from it
  on is injected. While the framework runs it is kept; a memory-only queue
  still loses it when the process exits. A persisted queue (one a quiesce
  persisted, or boot recovery restored) keeps it across restarts: each boot
  restores it and tries it again with the rest of the queue, at once or at
  the resume after a quiesced boot, and logs it again, unless it's one boot
  drops (below). While it's held the queue stays persisted, so every later
  deferral is written to the recovery file, up to the file's size cap; past
  it the file isn't rewritten, as the host log warns, and what's deferred
  after that is kept in memory only. Only the host log names the held write.
- A deferred write that throws after its message was stored, such as one
  whose store listener throws, counts as written: it isn't put back into the
  queue and stored a second time, and at a tool boundary what was stored is
  injected with the rest. For a body the strategy shards, that can be its
  first shards alone, since the throw stops the store's append loop: the
  rest of the body isn't stored, and the request carries what landed, joined
  as the strategy joins a body's shards when it compiles. The log line says
  it was stored, or how many shards were.
- Boot recovery drops a recovered deferred write whose participant isn't
  text, whose content isn't an array, or that holds a block that isn't an
  object, and logs it by id and participant, rather than holding it in the
  queue. The store can't take a null block. It keeps a string or number
  block as given, but the context manager's token estimate throws on such a
  block, so once one is stored, every compile for that agent fails, and a
  restart doesn't clear it. Before, an entry whose participant isn't text or
  whose content isn't an array was dropped without a line, and one with a
  block that isn't an object was kept: a null block could never be stored,
  and a string or number block, once stored, made every compile for its
  agent fail. Boot recovery also drops an entry whose `forAgent` is present
  but empty or not text, keeps the first well-formed entry with an id and
  drops and names a later one, names an entry with no id as it gives it one,
  and numbers an entry whose `seq` isn't a positive whole number up to
  `Number.MAX_SAFE_INTEGER` after the others, naming it unless it has none.

- A programmatic MCPL tool call, through `executeToolCall` or a module's
  `ctx.callTool`, now reaches the server the model's own call of the name
  reaches, and sends it the same tool name: the server whose tool listing
  offers the name, else the longest matching prefix. It took the first
  configured server whose prefix the name began with, so where one prefix
  begins with another's, such as `foo` beside `foo--bar` or beside `foo-`, it
  reached whichever of the two was configured first (#227, #230). Where two
  servers list the same full name, the listing holds the one listed last
  (#265), and both paths reach that one.
- An MCPL tool's source in the tool presentation now names the server a call
  of it reaches, by the same resolver. **Operators:** a tool's source was the
  first configured server whose prefix its name began with, so with `foo`
  configured before `foo--bar`, a component description profile bound to
  `MCPL server: foo` also described `foo--bar`'s tools. Those tools now take
  the profile bound to `MCPL server: foo--bar`, if there is one, and lose
  `foo`'s descriptions.
- A server's close forgets only its own tools' RFC-008 class declarations.
  Closing `foo` also forgot `foo--bar`'s, leaving its tools unclassed until
  the next tool refresh.

- **Two operator changes of one kind made one after the other within a
  millisecond each get a branch.** Unless the caller names it, a suppression,
  a rollback, the host command's message undo, a turn undo and an offline
  recovery name the branch they make for the time in milliseconds
  (`suppress/<agent>/<ms>` and so on). A second change of the same kind in the
  same millisecond used to be refused, because its name was the first one's
  branch. A default name is now one the store doesn't hold: the timestamped
  name, or that name with `-2`, `-3`, … appended. A name the caller gives is
  used as given, and the store still refuses one that's taken.

- The npm package no longer ships the compiled test suite or the
  compiler's build record: `files` packs `dist/src` and `src`, so
  `dist/test`, about half the published files, and
  `dist/tsconfig.tsbuildinfo` stay out, and the package's contents no
  longer depend on whether the tests ran before packing. The redundant
  `discord.js` entry in `devDependencies` is gone (it is a dependency).

- Explicit prose whose delivery definitely fails is held as a bounce draft with its notice, as hybrid envelopes are. A delivery whose outcome is unknown gets the failure marker alone, so its words are not offered for an ordinary resend that might duplicate a post. A failed delivery that is held gets the bounce notice alone, not a second marker.
- An envelope whose `{{unsent}}` names no held draft (the latest bounce draft was sent, set aside or let go) sends nothing, rather than the rest of the envelope. Its other words, if any, are held as a bounce draft; otherwise a short notice says nothing was sent.
- In hybrid and locus mode, a completing turn waits for its queued speech and hybrid holds even when its final response is empty, so its receipt includes that work and its draft notices settle with the same turn.
- Failure markers and traces include a bounded display of the connector's structured error data, such as parts already posted, and the connector's error message is bounded too. Contradictory delivery receipts bound the message id in their diagnostic without changing the receipt's id.
- A synchronous MCPL write rejection reports that the request was not sent and removes its pending state. `channels/open` keeps the same deadline as `channels/publish` when `requestTimeoutMs` is 0 (`publishDeadlineMs`, 60 s by default), so an unanswered open can't hold a delivery for good.
- A hybrid `>>>skip_reply {{unsent}}` in a skip-reply round sets the latest bounce aside while keeping publication private; text in a round with a private think stays uninterpreted, matching explicit mode.

- **Speech delivery reports what a publish actually established.** Plain
  speech now goes through one publish executor (`ChannelRegistry.publish`,
  returning a `PublishOutcome`: `delivered`, `failed` or `unknown`, with the
  destination the registry resolved). Only a connector's `delivered: true`
  confirms a post; a missing or malformed receipt is no longer counted as
  delivered (#163's rule). `failed` means nothing was posted: refused before
  dispatch, or `delivered: false` naming no message. An error response, a
  timeout or a lost connection after dispatch is `unknown`, keeping the
  connector's own words (a multi-part send may already be partly posted), and
  so is a contradictory receipt (`delivered: false` beside a message id,
  valid or not).
  The resident's `[discord-send-failed]` marker now says which: "could not be
  delivered … Nothing was posted" for a failure, and "was not confirmed … may
  or may not have been posted, so sending it again could post it twice" for
  an uncertain outcome. The marker's metadata and the
  `mcpl:speech-route-failed` trace carry `outcome`. A channel id registered
  by more than one MCPL server is refused rather than routed through
  whichever server registered it first, and a supplied but empty or
  non-string server selector is refused rather than read as omitted. A send
  refused for its server or grant opens no closed channel. A
  `channels/publish` request always has a deadline: with `requestTimeoutMs`
  0 it keeps the 60 s default, since its outcome is told to the resident and
  recorded for its draft; its expiry reads as unknown.
  `channel_publish`, and the subconscious's `speak_in_channel`, which shares
  its path, answer by the same rule. Before, they answered success with
  `{ delivered: true }` for a missing receipt and never read `delivered`.
  Now only `delivered: true` is success. `delivered: false` naming no
  message, or a request refused before it was written, is an error saying
  nothing was posted. Anything else is an error saying the publish wasn't
  confirmed and that sending it again could post it twice. That answer, a
  draft resend's line for a send that wasn't confirmed, and the `drafts`
  tool's read of that attempt carry the connector's data, bounded, when it
  sent some. `channel_publish` and
  `speak_in_channel` still resolve a channel id by its first registered
  match and post into a closed channel without opening it, as before.

  If you run a connector that answers `channels/publish` with `{}` or no
  receipt, which earlier versions counted as delivered, every publish
  through it now reads as unconfirmed. The resident is told of each reply
  that it wasn't confirmed, and gets an error for each `channel_publish` and
  `speak_in_channel` call, each saying that sending it again could post it
  twice. A connector confirms a post by answering `delivered: true`.

- An operator's quiesce abandon (`quiesce({ abandon: true })`) now ends the turn the same way whatever the stream reports for the cancel. It writes an inference-log row of its own, `Stream aborted: quiesce_abandoned`, carrying the rounds the stream finished, which it didn't when the stream reported `aborted`; and when the stream answers the cancel by just closing, with no `aborted` or `error` event, it still settles the turn and returns the agent to idle, where the agent had stayed busy and an ephemeral run's promise unsettled.

- `quiesce()` and `resume()` now answer only once the host-mode record agrees with the host, or fail, apart from calls that overlap.
  - **`quiesce()`** writes the record before it marks the host quiesced. When that write failed, `quiesce()` rejected with the host quiesced in memory while its record said it was serving, so a restart booted serving, and a second `quiesce()` resolved without writing the record. Now a failed write leaves the host serving, as it was, and the next `quiesce()` quiesces and writes the record.
  - **`resume()`** still serves before it clears the record, so a failed clear leaves the record quiesced. A second `resume()` used to resolve without clearing it, so the next restart booted quiesced; it now clears the record. While a surgery holds the store, that clear is refused as `resume()` is on a quiesced host, and a `resume()` arriving while another is still flushing leaves the clear to that one.
  - **Without a recovery file,** the store is the record, and a failed sync of the store after the write was only logged, so `quiesce()` resolved before its record was durable. It now fails `quiesce()` or `resume()`. The write is already in the store's log, though, so after a `quiesce()` that failed this way the record can still reach disk, and a restart can boot quiesced unless a `resume()` clears it first. With a recovery file, the file is the record, and a failed sync of the store is still only logged.

- The host-mode and deferred-writes recovery files are now synced to disk before they replace the record, and their directory and its parent after the rename. On Windows, and where the filesystem refuses a directory's sync with `EINVAL` or `EBADF`, only the file is synced. A write that fails before the rename removes its `.tmp` file instead of leaving it beside the record, logs one it can't remove, and fails with an error that names the record and says it was left as it was. A directory sync that fails for any other reason raises an ops alert naming the record, since the new record is already in place.

- The reference fetcher's per-server byte budget (an MCPL server's `autofetch.maxTotalBytes`, 1 GiB by default) now holds as it says. Each fetch read the server's total once, before it started, and set the total to that plus its own bytes when it finished. So concurrent fetches, such as the eager path's eight per result, could together go past the budget, and the last to finish overwrote what the others had added. Bytes read but not kept were never charged: a payload the workspace couldn't store, one whose digest didn't match, or a download stopped partway, by `max_bytes`, a timeout or the budget. Now each server's total is charged as each chunk is read, kept or not, and every fetch checks it at each chunk, so concurrent fetches can't together pass the budget by more than one chunk each. Where a fetch would pass both `max_bytes` and the budget, it's now refused for the budget, since a larger `max_bytes` wouldn't help: before it starts, when the budget is spent or a claim over `max_bytes` is also over what's left of it, and partway, when a chunk passes both. The spent budget's refusals now read `per-server fetch budget exhausted (<total>/<budget> bytes)`, the one partway after `aborted: `, where that one read `aborted: actual bytes exceeded per-server budget at <this download's bytes>`. A claim past both reads `claimed <n> bytes exceeds what's left of the per-server fetch budget (<total>/<budget> bytes)`. Each adds that the budget doesn't renew on its own, so calling again won't change that unless whoever runs the host raises or renews it.

- A tool result's data that isn't a content array of blocks agent-framework
  recognizes was stored, and sent to the agent, as plain JSON, so an RFC-005
  reference in it carried its raw uri into the agent's context and history.
  That JSON now shows, wherever in the data it sits, each reference as its
  stub (or as an unrecognized-block line when it's invalid), and inline data
  that also claims a uri or a disposition as withheld. A reference is a
  `resource` with a uri, at its top level or under `resource` where MCP
  embeds one, or an `image` or `audio` block given by `uri`; inline data is
  an `image` or `audio` block whose data is a string. Since JSON writes every
  field, inline data beside a uri of any value is withheld there, not only
  beside a string one. A uri that is null, absent or empty counts as none,
  and data that isn't a string isn't inline data, so a record that only
  shares one of those type names is written as before, as is everything else
  in the data: inline media that claims neither, with its bytes, and a
  `resource_link`'s fields among it. A reference that is the whole data is
  its stub, read as a content array's reference is, a `save_recent_image`
  slot included. The same text reaches a script that calls the tool, the
  direct Agent API's tool result, and a withheld result's kept fields, where
  data that is itself a reference keeps its stub whichever fields its tool
  marks. Results stored before the upgrade keep the text they were stored
  with, any uri in it included, which goes on reaching the model until those
  results leave its context.
- The notice for withheld inline content now says the inline data also
  claimed a uri or a bulk disposition. It named only a disposition, also
  when a uri was the cause. An `image` or `audio` block with neither string
  data nor a string uri is now said to have data or a uri that isn't a
  string when it has one, where the unrecognized-block line said it had
  neither.

- A refusal now reaches the model as an error result (`isError: true`), so it can tell a refusal from a tool that ran. That covers `tune_out`'s refusals (an unknown channel, a cancel of a channel that isn't tuned out, and an enter that can't go through, such as on a channel already tuned out), `channel_open` on a tuned-out channel, the subconscious's refusals of a `deliver_summary` with no text, a `cancel_tuneout` of a channel that isn't tuned out, a `note_disposition` with no key and a `speak_in_channel` it can't make, and the api module's `Unknown tool`. Each came back unflagged (`isError: false`, or for the api module no `isError` at all), so the model read it as a tool's ordinary answer, in XML tool mode as its `<stdout>`. `channel_open`'s refusal also showed the model only its `data`, `{"refusal":"tuned-out","channelId":"…"}`, and never the text saying to cancel the tune-out with `tune_out`'s `cancel` mode; the model now reads that text. A script's call to one of these tools now gets `Error: <text>`, as for any failed call. An in-process caller of `channel_open` (`ctx.callTool`) or of the api module gets the same result as before with `isError` set, and the tuned-out refusal keeps its `data`.

- **`history--search`'s snippet for a case-insensitive match now always
  holds the match.** The search found the match in the lower-cased text but
  cut the snippet from the text itself at the same position. `İ` (U+0130)
  lower-cases to two UTF-16 units, so each one before a match made the
  match's index in the text one unit too large, and enough of them left the
  match outside the snippet. The snippet now sits on the match in the text
  itself.

- The workspace's `glob` starts its walk at the directory its pattern names before its first wildcard, and `grep` at the deeper of its `path` and the directory its `glob` filter names that way. On a mount larger than its walk cap, a search for one directory's files then finds them, as long as that directory's own walk fits the cap. A walk of the whole mount could reach the cap before it got there and answer with no matches. The walk starts only as deep as disk lists each segment with the pattern's spelling, so on a case-insensitive disk a pattern spelled in another case finds nothing, as before. A search's `incomplete` now names only what lies beneath the directory its walk starts at, and a pattern into a directory the mount passes over by design (its ignore list, or another mount's directory) names that directory there. The start never goes through a link, as a walk of the whole mount doesn't. A `grep` whose `path` and filter name directories that don't overlap searches nothing. A search that starts below the mount root takes in, and announces, only the disk changes beneath its start, and no longer marks the mount's first whole sync done in `status`.

- A graceful framework shutdown (`AgentFramework.stop()`) with an inference
  still streaming records its own provenance before cancelling — the same
  `frameworkCancelledStreams` track that `endTurn`, budget restarts and
  quiesce use — so the stream driver settles the turn as a shutdown: no
  `[turn-interrupted]` marker (nobody stopped the agent; the host went
  away), no `inference:exhausted`, one `inference:aborted` with reason
  `shutdown`, an inference-log terminal, and the agent settled so an
  in-flight `runEphemeralToCompletion` rejects immediately instead of
  waiting out its idle watchdog.

- Without an EventGate, `skip_reply` no longer offers `wake_in_seconds`; a
  positive timer argument supplied anyway is refused visibly without ending the
  turn, while ordinary `skip_reply` remains available.
- Without an EventGate, a `skip_reply` call stored in the agent's history keeps
  its `wake_in_seconds`, which the host used to delete from it (#394).

- `skip_reply` reads `wake_in_seconds` one way for every part of the host: a number of seconds from 1 to 3600, or a string that reads as one, taken in whole seconds. A larger number waits 3600, `Infinity` included, where before `Infinity` armed nothing and the turn ended as an ordinary skip. The tool's description of the parameter now says "from 1 to 3600; a larger number waits 3600" in place of "clamped to 1–3600".
- With an EventGate, a `wake_in_seconds` that isn't such a number is refused as a tool error that names the value. That covers a number below 1, such as `0`, a negative or `0.5`, as well as `"soon"`, `""`, `true`, an array or an object. It arms nothing and doesn't end the turn. Before, `0`, negatives and `"soon"` ended the turn with no wake, a number between 0 and 1 such as `0.5` armed a wake of 1 s, and `true` and `[5]` armed wakes of 1 s and 5 s. A number below 1 is refused rather than raised to 1, so that `0`, which a model may write to fill an optional number, can't become a 1-second wake after every turn.
- Without an EventGate, any `wake_in_seconds` other than absent or `null` is now refused, as a positive number, `true` and `[5]` already were. `0`, negatives, `Infinity`, a blank string and values `Number()` can't read used to end the turn as an ordinary skip, which dropped the wake the call asked for without saying so.
- A `skip_reply` call whose input is `null` ends the turn as an ordinary skip, where the channel registry's handler threw reading `wake_in_seconds`.

- A failed read or write of the framework's own state is now an error, not an empty state or a success, in the two places that read a map and write it back whole.
  - When the tune-out coordinator's stored dispositions can't be read, each attempt at the subconscious's turn fails with the read error (`inference:failed`), and the error policy retries it as it does any failed compile, each attempt reading the store again, so the turn reaches the provider only with its dispositions. `note_disposition` answers that the note wasn't recorded, and writes nothing. A note whose write fails is in effect nowhere, since the coordinator caches a note only once it's stored. Before, a failed read cached an empty map in the dispositions' place: the subconscious compiled without them until a restart, and the next noted disposition replaced the stored map. A failed write kept its note in effect until a restart, and the next note stored it.
  - When the conversation router's generation counters can't be read at startup, `AgentFramework.create()` fails with the read error before anything starts, and closes a store it opened. A fork's counter is now stored before the fork is spawned, and a spawn whose counters can't be read or stored is refused, as a spawn that fails is, so the next qualifying message proposes it again. Before, the router started from no counters after a failed read, and after a failed write it logged the failure and spawned anyway. Either way the next restart reused a fork's agent name, reopening that engagement's namespace.
  - A state with nothing stored still reads as empty.

- A state that can't be registered, for any reason but that it already exists, now fails the call that registers it, with an error that names the state (#385). Those calls are `AgentFramework.create()`, `addModule()`, the workspace's `initStore()`, the MCPL checkpoint and host states, and the tune-out coordinator's state when it's written. Most of the registrations behind them swallowed every failure, a closed store or an I/O error alike, so the failure surfaced at a later read or write of that state, if one came, under that call's name. Two of them leave nothing behind when they fail this way: `initStore()` takes no mount until a call succeeds, and a feature set whose host state couldn't be registered is registered by the next call for it, such as a reconnect's. A registration the store answers with "already exists", as on a reopened store, is still taken as done.

- **A stop at a tool boundary stops the turn.** Once a round's last tool
  result was in, and while the framework stored the round (an oversized
  result spilling to the workspace), `Agent.cancelStream()` left the
  turn's stream running and `stop()` and `abortInference()` passed the
  agent over. The boundary then resumed the turn, or restarted it when it
  was over budget. So a host's stop there, such as connectome-host's Esc,
  its web UI's interrupt or a subagent's cancel, was undone, `stop()` let
  the turn run on during shutdown, and the framework's `abortInference()`
  returned `false`. Each now cancels the turn's stream, as it does while
  the round's tools run, and the framework's `abortInference()` returns
  `true`.
  - **What a host sees:** the stop's own terminal event instead of a turn
    that goes on. The stopped round isn't stored, as when a stop comes
    while its tools run: neither its assistant content (its text, any
    thinking and its tool_use) nor its results reach the window. A result
    that spilled keeps its workspace file, which nothing stored names.
    `tool:result_dropped` is emitted once, for the result the boundary was
    handling, as for a result whose turn changed while modules caught up
    with the batch. The round's earlier results go with it, without events
    of their own.
  - **What a reader of the store sees:** a round's assistant row, with its
    tool_use, is stored with its results, after the spill's workspace
    write, rather than before it. While the write runs, neither is in the
    window, so the window never holds the tool_use without its results.

- `stop()` now ends every ephemeral run still registered once its event
  loop has ended, with "refused: the framework is stopping", such as a run
  whose wake the loop hadn't taken up when `stop()` began, whose turn
  `stop()` refused, or whose retry it cancelled. Before, such a run waited
  for its startup watchdog (30 s by default) or, once its inference had
  started, its idle watchdog (15 minutes by default) before it rejected. A
  run's startup or idle watchdog that fires once `stop()` has begun,
  before that end, now rejects with the same error followed by what it
  saw, such as "(inference not started within 30000ms)". Before, it named
  a stalled event loop or a lost stream as the cause, even for a run whose
  turn `stop()` had refused.
- After a `stop()` that cancelled a turn's retry, a `start()` on the same
  framework (one whose store it doesn't own, or whose `stop()` failed)
  delivers the event gate's debounced batches again. The cancelled turn
  left its agent inferring at the gate, so every batch was buffered, and
  woke no agent, until that agent's next turn ended.
  `EventGate.dispose()`, which `stop()` calls once its streams and event
  loop have ended, now clears which agents are inferring. A turn that
  continues another, such as a budget restart left queued that a `start()`
  takes up, marks its agent inferring again through the new
  `EventGate.onInferenceResumed()`, which, unlike `onInferenceStarted()`,
  leaves a pending self-wake alone.
- A budget restart or tool-result-guard retry that a provider hold kept
  from starting, such as a stated wait or an acceleration cooldown, now
  marks its agent inferring at the event gate when it runs after the hold,
  as any turn that runs does, so debounced batches wait for its end.
  Before, the hold ended its turn at the gate, and it ran without it:
  unless another agent was inferring, the gate delivered debounced batches
  while it ran, into the message slot residents share.
- A turn whose retry `stop()` cancels now ends with `inference:aborted`
  after its `inference:failed`, with the reason "a retry waiting while the
  framework was stopping is dropped before it sends anything", and
  `healthSnapshot()`'s `lastInference` records its end. Before, nothing
  followed that event, and for a turn whose stream couldn't start,
  `lastInference` had no end.

- The tune-out coordinator's refusals say what didn't happen and what to do instead. `tune_out` on a channel that's already tuned out gives that tune-out's settings and how to change them, and its end time where it has one. A cancel of a channel that isn't tuned out, through `tune_out` or the subconscious's `cancel_tuneout`, names the connected channels that are and how a tune-out ends by itself, and says whose window its backlog goes to: "you" to the resident, "the resident" to the subconscious. A fork-bound channel says why `tune_out` won't divert it, and that calling again won't change that until its conversation ends. The subconscious's `deliver_summary`, `note_disposition` and `speak_in_channel` say what they need. `speak_in_channel`'s refusal where channel speech is off says the resident can speak there, through `deliver_summary` or by ending the tune-out with `cancel_tuneout`, and the configuration key it used to name goes to a `[tune-out]` log line for whoever runs the host.

- A tune-out's `durationSeconds` or `cadenceSeconds` longer than about 24.8
  days (2^31 - 1 ms, the longest delay one Node timer holds) now holds.
  Before, Node fired the timer almost at once, so such a tune-out ended as
  "duration elapsed" moments after it began, waking the resident with its
  backlog, and such a cadence re-armed about every millisecond, giving the
  subconscious a turn as soon as anything was diverted. Both timers now
  wait in steps no longer than one timer. The cadence counts its period on
  those timers, as it did before, so setting the wall clock doesn't move
  it. The end time reads the wall clock against the stored end at each
  step, so a host that runs through a long tune-out and one that restarts
  during it aim at the same end.
- A tune-out that ends in the channel registry without a cancel (the send
  path and the close tool set the channel's state there directly) no
  longer leaves its timers to act on the channel's next tune-out. Before,
  when the next tune-out had no `durationSeconds`, the old end time ended
  it as "duration elapsed", and a wake still in its 2-second coalescing
  window counted against it and gave the subconscious a turn.
- `tune_out` refuses a `durationSeconds`, `cadenceSeconds`, `backlogCap` or
  `maxWakes` that gives no finite number, such as `"abc"`, and a duration
  whose end time is too far off to store, naming the option and saying
  nothing was tuned out, before anything changes. Before, the store's write
  threw after the channel had been marked tuned out in memory, so the call
  failed and left the channel diverted with no cadence or end timer until
  the next restart. A numeric string such as `"3600"` is still read as its
  number.
- A `null` `durationSeconds` now means the tune-out lasts until cancelled,
  as leaving it out does. Before, it gave a tune-out of 60 seconds, the
  shortest duration.

- A tune-out's cadence, coalesced wake or end time whose work throws, such
  as a store write that fails during the subconscious's turn, no longer
  throws into the event loop, where an uncaught exception ends the host
  process. The coordinator writes the error to stderr and reports a
  `tune-out:timer-failed` trace naming the timer. Before, a cadence whose
  turn threw also never armed again. Now it arms its next period before
  the turn, and that next turn counts the failed turn's messages. An end
  time whose cancel throws before the channel registry has changed
  anything tries the cancel again a minute later, until it succeeds.
- A failed acknowledgement of a suppressed mention is written to stderr
  as well as traced, and a rejection with `undefined` or `null` no
  longer throws inside its handler.

- A reference registered with no server, such as one an in-process module
  returns, says it can't be fetched instead of inviting a `fetch_reference`
  call the fetcher can only refuse. Its stub, `fetch_reference`'s refusal
  (which read "reference has no server binding") and `save_recent_image`'s
  refusal now say "unbound: no server is recorded to fetch it from", as an
  expired reference's already say why. A saved copy is still offered.

- A cancelled stream (host Stop button, `agent.cancelStream()`,
  `framework.abortInference()`) is no longer recorded as an inference
  failure. It emits `inference:aborted` instead of `inference:exhausted`,
  leaves the consecutive-failure streak and ops alerts untouched, and writes
  a `[turn-interrupted] … a deliberate stop, not a failure` chronicle marker
  in place of the `[inference-failed] the model call failed…` text with
  remediation advice for a failure that never happened. The marker names the
  act, not an actor (membrane's `user` reason means "the signal was aborted",
  not "the user did it"), and makes no claim about delivery. Callers can pass
  their own provenance — `cancelStream(reason)` / `abortInference(reason)` —
  which the trace and the marker's metadata carry; `abortInference` no longer
  emits a second `inference:aborted` on top of the stream driver's. An
  ephemeral run that such a cancel ends now rejects with `Stream cancelled`,
  and the stop's inference-log row reads `Stream cancelled (<reason>)`, where
  both read `Stream aborted: user` before. This
  holds on both of a stream's cancel twins: a stream implementation that
  reports `cancel()` through `error` rather than `aborted` reaches the same
  terminal (one `inference:aborted`, the marker, no `inference:failed`, no
  `errorPolicy` retry of the inference that was just stopped), and the
  quiesce/shutdown twins no longer emit a contradictory `inference:failed`
  before settling as aborted. A third shape — an implementation whose
  `cancel()` simply closes the iterator, with no terminal event — reaches the
  same terminal too, at the loop's end, instead of leaving the turn unsettled
  under a `completed` lifecycle terminal. (#134, by Lari; reworked after
  review.)
- Speech-route failures with no delivery locus (headless/WebUI turns with no
  home or trigger channel) now read `[send-undeliverable] … had no channel
  to go to` instead of claiming a Discord delivery failure to "the channel",
  and say that this route delivered nowhere rather than that the reply
  reached no one — another `dispatchSpeech` handler may have shown it. The
  machine-readable marker `kind` is unchanged.

- Where disk has deleted a file the workspace still holds, the workspace's ways out say what they do there. A push's refusal for that path, and an edit's note on it, now say that a sync of the path takes disk's deletion, which removes the workspace's copy, and that a forced materialize writes the workspace's copy back. Where the path's branch intent can't be read, the refusal still names the sync alone, and now says it takes the deletion. Before, they offered to "take disk's copy" or "adopt the disk version" and to overwrite a disk copy that wasn't there, so an agent that synced to take disk's copy lost the workspace's copy instead. A conflict recorded before disk deleted the file keeps its kind, and its refusal now says disk has no copy of the file. Where disk does hold a copy, an edit's conflict note now says that a sync keeps disk's copy and gives up the workspace's, which holds whether or not the workspace can store disk's copy: one it can't store, binary or past the size limit, stays on disk alone.

- A file the workspace writes keeps its permission bits. Every tree entry recorded `0o644` whatever disk had, and every file the workspace created was created `0o644` under the umask, so a script re-created by a branch switch, an undo or a forced `materialize` lost its executable bit, and a `0600` file came back readable by others. Now a file taken in records disk's mode, with the regular-file type bits as git records one (`0o100755`), and a file the workspace writes again gets the mode its entry records, whatever the umask. A new file is created at its mode and given it exactly before its bytes, and a file written in place loses the bits its mode removes before its bytes and gains the ones it adds after them, so no bytes sit at a mode wider than both their old and new ones. An overwrite with `write` or `writeBinary` keeps the entry's mode, as `edit` does. A file the workspace creates has no mode in its entry until a sync, a listing or the watcher fills in disk's, and the push that writes it records the mode disk gave it as their agreement. The setuid, setgid and sticky bits, which entries don't record, are kept as a file has them when a write widens its mode or a push changes only its mode, and a write drops setuid and setgid before its bytes, whether or not it narrows the mode, and keeps the sticky bit, so no new bytes are written under a setuid or setgid bit the write saw when it checked the file. Where the kernel refuses that chmod, as on another user's file, the write goes on under the kernel's own rule for a write, which leaves setuid for a writer with `CAP_FSETID` and setgid where the group can't execute. A widening of the workspace's own change that the kernel refuses, after a write's bytes, to the exact mode of a file the push creates, or in a push of the mode alone that only adds bits, leaves the file at the mode it has and no mode owed: the evidence records none, so the next sync takes disk's mode in, as an edit's pass over the path does, and the push says so. Until then, a later write or named `materialize` of the path says that nothing records which side changed its mode, and a forced one meets the kernel's refusal again; each note names the sync. A narrowing of the workspace's own change that it refuses stays owed, before a write's bytes or in a push of the mode alone: the write is refused before its bytes, which aren't written wider than their mode, and a retry is refused the same way until the file's owner or an administrator narrows it, forced or not; a write's refusal names the mode the file has, the one its chmod aimed at and the workspace's, and a mode-only push's names the workspace's. A forced push over a mode disk changed, or one nothing records, whose chmod it refuses, narrowing or widening, ends where an unforced push would: a push of the mode alone leaves the path as it was, and a write's bytes go in at disk's mode and are recorded as an unforced write records them, which it says under `modesKept`; disk keeps its mode, and a sync takes it in. `materialize` lists a written path whose mode stayed as disk had it under `modesKept`, with why, apart from `skipped`, which holds only what it refused, and the `write` and `edit` tools and `writeBinary` give the same note as `modeKept` in their result, so a write whose mode stayed as disk had it is no longer reported as failed. The mode notes that offer force say to materialize the path with force, since the write tools take none. A write by a process without `CAP_FSETID` clears setuid, and setgid where the group can execute, as Linux does for any writer. On Windows, which reports only `0o666` or `0o444`, modes go unobserved, so nothing is taken in or applied there: a store written on a POSIX host keeps its modes, and the disk evidence records none, so a POSIX host that opens the store later reads each mode as unknown and takes disk's in, as it does for evidence from before modes were recorded.
- A file's mode changed on disk is taken in as a change on the same bytes: it's recorded as `modified` and makes no event, since it brings nothing new to read, and a sync lists it among what it synced. A sync that names the path takes disk's mode as it takes disk's bytes. A mode the workspace records that disk lacks, as after an undo or a branch switch, is owed to disk and listed as `workspace-draft` where disk still has the mode they last agreed on, and a push applies it as a chmod; `materialize` lists that path as materialized. A mode disk changed since stays, a push says so, under `modesKept` where it wrote the bytes and under `skipped` where it had only the mode to give, and a sync takes it in; forced, disk takes the workspace's mode, as it takes its bytes, where the kernel allows the chmod. A mode disk changes while a push runs, its bytes going in included, is kept the same way, unless the push is forced; one set in the instant between the push's last check and its chmod isn't, since nothing makes the two one step. A push that stopped partway left disk at one of its own modes: the old bytes at the mode it saw or at that mode narrowed to the new mode's bits, and the new bytes at the narrowed mode or the new one. Run again, it completes from there, writing the bytes before it widens, and never gives the old bytes the new mode; a sync that names the path takes in the mode the push meant those bytes to have. A mode set since the push stopped stays, as does the mode of a push that kept disk's, unless it's the mode disk and the workspace last agreed on, which takes the workspace's as on any other path.
- Entries recorded before this hold `0o644` as a placeholder, not a mode: such an entry never changes a file's mode on disk, and takes disk's mode the first time a sync, a listing or the watcher finds their bytes agree. That's no change and makes no event, though the first sync after upgrading writes each file's entry once. Evidence from before this records no mode either, so where an entry's mode and disk's differ and nothing records which side changed, disk's is taken in: an unknown never moves a file's mode on disk. agent-framework 0.22.1 and 0.22.2, opening a store this version wrote, keep the recorded modes through an `edit` and apply none of them to disk.

- A workspace materialize with `force` and `applyDeletions` no longer removes
  a pipe, socket or device found at a path the workspace deleted, nor a
  followed symlink that leads to a directory or to anything else that isn't a
  regular file. Like a write, which already refused such a path, the unlink
  now acts only on a regular file, or on a followed symlink to one (removing
  the link itself), forced or not. Where the workspace's deletion of such a
  path is refused, forced or not, the refusal says that no push unlinks it,
  and to ask whoever runs the host if it should go. Before, the refusal for a
  pipe, socket or device offered a forced materialize to delete it. A forced
  materialize without `applyDeletions` now refuses such a deletion in the same
  words, and a deletion over a directory in the directory's, rather than
  listing it among the deletions left on disk for `applyDeletions` to
  remove. A path whose branch intent can't be read is refused, or left, as
  before. As before, the unlink checks the entry as close to the unlink as
  Node allows, so an entry swapped in at that very moment is still removed.
  - **For operators:** to clear such an entry, which a forced materialize used
    to remove, remove it by hand with `unlink <path>`: it removes that one
    entry, never what a link leads to, and refuses a directory. (`rm -r` on a
    link to a directory written with a trailing slash acts on the directory
    it leads to.)

- A watched mount passes over what its `ignore` list covers, as a sync without a path does. The watcher handed chokidar the list as strings, which chokidar 4 compares with whole absolute paths, so no pattern matched, and every covered file the watcher saw change was taken in. A copy taken in that way stays as it was stored to every pass that names no path: a later change on disk isn't taken in, and its deletion is taken in where a walk lists its directory, as for anything a complete listing lacks. A copy beneath a directory the list covers stays, deleted on disk or not, the directory itself included, and so does one an `ls`, `glob` or `grep` reaches by its own path, or a sync naming a directory above it reaches by its walk.
- A mount nested inside another is passed over by the outer one as another mount's directory, in every pass, named or not, and by its watcher. The outer mount's ignore list gained the nested mount's path as written, which matched nothing for a mount more than one level down (`a/b`), so the outer mount took its files in as its own, and which matched the name at any depth for one directly beneath (`c`), so the outer mount also passed over unrelated entries with that name, such as `sub/c`. Now the outer mount's `ignore` list is left as configured, and the nested mount's directory is passed over as itself, counted under `passedOver` as "another mount's directory": the outer mount stops taking the nested mount's files, and takes files that only share its name. A sync that names that directory, or a path beneath it, with `/` between its segments, takes nothing in, and says so under `ignored`, where it took the nested mount's files in, since a named sync sets aside the `ignore` entries covering what it names (#276). That holds where an `ignore` entry covers a directory above the nested mount too. Files an outer mount stored from a nested one before, as `main`'s `a/b` mistake let it, stay in its branch's history and are listed with whose they are, but are passed over by its syncs, counted under `passedOver` and not under `incomplete`, and left out of its materialize and of `status`'s pending changes, conflicts and workspace deletions (its `fileCount` counts the tree as it stands).
- **The outer mount now refuses a nested mount's paths, reads included.** `read`, `read_image`, `write`, `edit`, `delete`, `readBinary`, `writeBinary`, `readBinaryFromDisk` and `readFileFromDisk` refuse a path in another mount's directory nested in the mount they name, judged where the path lands once its `.` and `..` segments and repeated separators are resolved, and the message names the mount that holds it and the path to use there; `readFileFromDisk`'s error code for it is `other_mount`, and `resolveAbsolutePath` returns null for such a path. A generated file the host registers at such a path is the same file whichever mount names it, and either reads it from its generator. `grep` returns none of the outer mount's copy of such a path; `ls` and `glob` list it with a note naming the mount that holds it and the path to use; a listing or `grep` naming a path there names them in its region, and a sync naming one in its note under `ignored`. A push of the outer mount, forced or not, skips such a path; a `materialize` that names one lists it under `skipped`, naming the mount that holds it, as a sync that names it does under `ignored`. A mount configured with a trailing separator no longer refuses its own root as traversal, and one configured with a relative path no longer refuses every path, generated files included, so the path the message names works. Before, a write through the outer mount, and any copy its store held there, went to disk at its next materialize over the nested mount's file wherever disk still agreed with the outer mount's evidence, and a forced one, as an undo or a branch switch makes, whatever disk held; and a read through the outer mount returned its own copy. A mount whose name only begins with two dots, such as `..cache`, now counts as nested.
- Three families of editors' swap and backup file names are passed over by a sync without a path, a listing and the watcher: `.name.swp` and `.name.swx` as the whole name (vim), and names ending in `~` (backups) or in `.subl…tmp` (Sublime Text's saves in progress), matched by `^\..+\.sw[px]$`, `~$` and `\.subl.*\.tmp$`. A directory with such a name is passed over with what lies beneath it. A sync counts one it doesn't track under `passedOver` as "an editor's swap or backup file", and reports one it tracks under `incomplete`. Naming one in a sync still syncs it, and lists it under `ignored`. Before, the watcher hid these names through chokidar's `atomic` option while a sync took them in, and that option tested the whole path, unanchored, so it also hid names such as `report.v2.swp`, and under a directory with a dot in its name, such as `~/.local/…`, every name ending in `.swp` or `.swx`, `notes.swp` included. The watcher no longer uses that option. An editor's save by rename reaches the workspace as a change to the file when the new copy is on disk by the time the watcher's batch is taken in, after its debounce. A copy still being written then is taken in as it stands and again whole once written, and one saved after a longer pause than the debounce is taken in as a deletion and then a creation. A copy already stored stays as it was to every pass that names no path, until its deletion is taken in, and a materialize treats it as any file the workspace holds, as it does a path the `ignore` list covers: it writes the workspace's copy while disk has what they last agreed on, as after a branch switch to history that holds it, and leaves a change disk made alone, as a conflict, unless forced.
- An `ls`, `glob` or `grep` that names a directory the mount passes over, such as one a bare-name `ignore` entry covers (`node_modules`) or one with an editor's name (`drafts~`), or a path beneath one, now takes nothing in there, and names the region under `incomplete`, adding that a sync that names the path takes in what's there, editors' files aside, as it still does. A copy the workspace stored there is listed, unobserved. Before, it listed such a directory and started tracking what it found; one a path entry such as `cache/**` covers listed nothing, and named nothing. A file tool names the path it acts on, as a sync naming it does: `read`, `edit`, `delete` and `readBinary` take in a file there that the workspace doesn't hold, as before, and the pass `write`, `edit`, `delete` and `writeBinary` make first, to settle a pending change on their path, observes it too.

## 0.22.2 — 2026-10-17

**Operators upgrading from 0.22.1:** on a workspace mount over 5000 files, the
first syncs and catch-up scans after upgrading catch up on what 0.22.1's
walks, which stopped at 5000 files, never reached, up to the mount's walk cap
(`walkCap`, 5000 entries unless configured) in each pass. Each pass pushes one
event for each kind of change it finds, listing every path, and where the
mount's `wakeOnChange` admits that kind, each event is one message to the
agent. Going back to 0.22.1 is safe for a store 0.22.2 wrote, with one
exception: 0.22.1 refuses to create the framework when an agent's persisted
runtime setting can't be applied, such as a budget no longer above the
recipe's `maxTokens`, or a budget below the recipe's on a strategy that can't
prepare a smaller window. 0.22.2 starts with such a setting and logs
`[agent-settings]` that it stays set but unapplied; reset it with
`resetAgentRuntimeSettings()` before going back. Under 0.22.1, a coalesced
message whose content passes 1 MiB with its inline images is refused again,
and walks stop at 5000 files again. 0.22.1 leaves the walk's place alone, so
coming forward resumes there, unless 0.22.1 wrote a checkpoint meanwhile,
which starts each scope's walk at its top. Keep context-manager 0.14.1, which
0.22.1's `^0.14.0` admits. Not tested: going back under connectome-host rather
than a bare framework, and a tail or pace kept unapplied.

### Added

- The `mcpl:server-closed` trace carries `reason`, why the transport closed,
  in its own words, such as `child process exited, and its pipe failed with
  write EPIPE` or `closed by host`. It is null when the transport gave none,
  and when the reason is a WebSocket server's own close text, which stays off
  the trace: `TransportCloseInfo` and the connection's close info mark that
  text with `reasonFromPeer`.

- `ProviderWaitNotSleptError`: when a retryable provider failure states a
  wait an ephemeral run won't sleep (longer than the 600 s it sleeps in its
  turn, infinite, or `NaN`), `runEphemeralToCompletion` now rejects with this
  error, carrying the wait as stated as `retryAfterMs`. Its message is
  unchanged. Its `name` is `ProviderWaitNotSleptError`, so a logged rejection
  reads that where it read `Error`. A host that decides whether to run a task
  again can test `instanceof` or the `name` instead of reading the message.
  Every other ending still rejects with a plain `Error`.

- `AgentFramework.switchBranch(name)` switches the store to an existing
  branch, starts the delivery of the Discord awareness marks the move
  changes, re-materializes the config mount, and then resolves. It doesn't
  wait for Discord, as the surgeries don't. If the mount fails, it rejects
  with the branch already moved. The branch moves under every agent
  sharing the store, so, as for `rollbackToMessage()`, every agent must be
  idle: during a live turn it refuses with `OperatorActionError`
  (`agent-busy`), and no turn starts until it's done. Once `stop()` has
  begun it refuses, and `stop()` waits for one already running.
  - The API server's branch switch used to run these steps itself, on the
    store, and now calls `switchBranch()`. So it refuses during a live turn
    instead of moving the branch beneath it. Its current branch follows the
    store from the moment it moves, and clients hear of a move even when a
    later step fails, but not of a refused switch. A branch create with
    `switchTo` creates the branch first, so during a live turn it creates
    it and answers the switch's refusal.

### Changed

- A context-maintenance pass no longer fails as a whole when one agent's readiness can't be read. context-manager 0.14, which agent-framework has required since 0.21.1, refuses its readiness queries while a strategy's initialization is pending (inside `switchBranch`, `fork`, `setStrategy` or `ContextManager.open`) or has failed, and a strategy can refuse on its own, as the autobiographical one does for a branch it hasn't reloaded. That agent's run now records the error, the agent gets its own `context-maintenance-failed` alert (`scope: 'agent'`), and the other agents run. Before, such a throw ended the pass for every agent, with one alert for the whole pass (`scope: 'pass'`). Anything else that throws while one agent's maintenance is prepared is that agent's failure in the same way. A failure that lasts, met by every pass, is logged, alerted and recorded in the maintenance history when it's first met, then again when its text changes, every 15 minutes while it lasts (the alert webhook's cooldown for it, counted from the webhook's last post of it), or after that agent's maintenance has gone without a failure. A pass that met only failures already reported, and took no tick, isn't added to the history unless an operator's `maintain` (`maintenanceTick()`) asked for it, so a lasting failure no longer pushes out the runs that did work. `getContextMaintenanceSnapshot()` reports such an agent as `ready: false` with an `error`, and a strategy that can't give a progress snapshot reads as having none.
- While an operator surgery (`rollbackToMessage` or `suppressMessages`) or `switchBranch` holds the store, no maintenance pass starts and no over-budget drain kick is started, a running pass or drain kick starts no new tick, and the operator call waits for them to finish before it switches or forks the branch, so no maintenance work overlaps the move. `stop()` waits for them the same way, a drain kick included, before it closes the store, so the tick in flight ends before the store closes, and once `stop()` has begun, no drain kick starts and none starts a new tick. Maintenance makes no provider call meanwhile, a conversation agent's included: one made under the hold, or once `stop()` has begun, is withdrawn without being sent, and so is a resident's call waiting at its provider gate when the hold is taken or `stop()` begins. That's no maintenance failure, and for a call outside context-manager 0.14's compression fallback ladder, a merge's or a chunk's canonical call with its retries after a `tool_use` stop, context-manager counts no attempt. One inside the ladder, after a chunk's canonical call was refused or cut short, is recorded there as a provider error, and once every rung has failed, the chunk's request family is quarantined, with its alert. Before, a resident's call made once `stop()` had begun was refused as a failure, so a restart that caught a maintenance tick before one of its calls logged a maintenance failure and raised a `context-maintenance-failed` alert; now the agent's maintenance logs that it stopped. An over-budget compile's `context-refusal` alert says whether the drain breaker kicked: `kicking`, `already draining`, or `not kicked` with the reason, where it said `kicking` whenever the agent was found, and `unavailable (no agent handle)` for one it can't find, as before. A kick joins what `stop()`, an operator surgery and `switchBranch` wait for before the alert is raised, so a listener on the alert that begins any of them waits for the kick, which then starts no tick. A merge keeps its place in the queue. When a chunk's compression is withdrawn outside the ladder, context-manager logs its "Failed to compress chunk (hierarchical)" line with the withdrawal, and the chunk is queued again at that manager's next rebuild, such as its next message or sent compile. The operator call never waits on a provider cooldown, or on the retry turn a cooldown queues, which the hold keeps from starting. `switchBranch` can therefore move the store after the call returns, and the API server's `branch.switch` announces the move it made once it has, while `branch.current`, the branch list, `/health` and `/status` read the store's branch whenever they report one. `maintenanceTick()` answers `ran: false` meanwhile, and `resume()` refuses with `OperatorActionError` (`agent-busy`), as the other operator calls do, including when the surgery took the store while `resume()` waited. Resume once the surgery has finished.

- **Built with TypeScript 7**, the native compiler, up from 5.9. Measured
  with 7.0.2 against 5.9.3 on the same source, the emitted JavaScript is
  byte-identical. What the package ships beside it changes:
  - seven declaration files under `dist/src/` (`mcpl/push-coalescer`,
    `mcpl/references`, `mcpl/tool-classes`, `mcpl/transport`, `mcpl/types`,
    `modules/workspace/types` and `tune-out/tools`) write string literal
    types with single quotes, as the source does; the types are the same;
  - source maps: of the `.js.map` files that change, all but four move only
    columns; in two a generated line maps to other source lines, and in two
    a generated line gains or loses its mapping, so a stack trace can land
    on a different column, and rarely on a different line or none. Of the
    56 `.d.ts.map` files that change, 49 map some declarations to other
    source lines and 7 gain or lose a line's mapping, which can move where
    go-to-definition lands;
  - `dist/tsconfig.tsbuildinfo`, the compiler's build record, changes.

  `test/stop-with-work-in-flight.test.ts`, whose build ships in `dist/test`,
  now parses `src` with `@babel/parser`, a new devDependency: the main entry
  of TypeScript 7's package has no compiler API, and its `./unstable/*`
  entries reach the native compiler over IPC.

  As with the same source built with 5.9.3, a consumer on TypeScript 7 with
  `skipLibCheck` off whose `types` leaves out `node` can get Node-name errors
  from this package's declarations and its dependencies', unless its program
  already reaches Node's types. Install `@types/node` and list `node` in
  `types`, as this package's own `tsconfig.json` now does.

### Fixed

- A coalesced MCPL message with inline images is admitted like any other message (#266). Coalesced `channels/incoming` and `push/event` items, and render results, were checked against a 1 MiB budget on their serialized content, inline base64 images included, which uncoalesced messages never had. Any message with a sizeable screenshot was refused as `coalesce_invalid`, never stored and never woke the agent, and discord-mcpl tags every message create with `coalesce`. An incoming coalesced item's content must be an array of objects with something visible in it (a retraction may be empty, and on the push lane so may a silent heartbeat), and within that it is admitted as an uncoalesced message is: a block the converters can't render, such as a video or an unknown type, becomes the same placeholder whether or not the message was coalesced. The converters of both lanes now take any object without throwing: a block's type, text, data, mimeType or uri that isn't a string is treated as absent, so a malformed block becomes a placeholder too (a text block, no text) instead of throwing in conversion, where the sender got no answer and a `channels/incoming` batch stopped before its later messages. An image or audio block that has data but no usable media type reads `[Image: no media type]` or `[Audio: no media type]` rather than claiming no data, and an image or audio block with a disposition is a reference only when its uri is a non-empty string. A `shouldTriggerInference` filter, and so the EventGate's content filter, reads on both lanes the text the agent's context gets, the converted text blocks joined with line breaks: on the channel lane, which read the message's own text blocks before, a block that converts to text (an unknown type's placeholder, an image with no data, a reference stub) is now part of what a filter matches, as it already was on the push lane, and text that isn't a string reads as empty. A render result, which the host delivers in the occurrence's place, gets every check a pushed payload gets (RFC-006 §5.2) except visible emptiness, since an empty render means nothing happened, and one more: each block must be one the converters show as itself (its text, or its image or audio source) or as a reference stub. A render with a block that would show as a placeholder falls back to the occurrence's own content, which a pushed payload doesn't have. The 4 KiB bound on `coalesce.data`, which the coalescer holds outside context, is unchanged.
  Every coalesce rejection is now visible on the host as well as on the wire: as a `mcpl:channel-incoming-rejected` or `mcpl:push-event-rejected` trace with the error's message in `detail` and the failing `field` when the error names one, and as a line, unless it is a push refused for its channel within a minute of that channel's last line (below). A coalesce rejection's `[channel-incoming-rejected]` line names the server, channel, message id and failing field, and its `[push-event-rejected]` line names the server, feature set, event id and failing field; each ends with the error's message. When a channel's refusals were held back, the next line printed for it adds how many. The reason follows the answer the sender got: `coalesce-invalid` when the item was the sender's to fix (malformed, or a push to a channel it isn't permitted or hasn't registered), `coalesce-failed` when the host itself failed (coalescing unavailable, the host stopping or unable to make an acceptance durable, or an internal error). A `channels/incoming` message for an unregistered channel now gets a line too (`reason=unknown-channel`), coalesced or not. So that a server that never registered a busy channel doesn't print a line for every message in it, a channel's first refusal prints, and after that a refusal prints only once a minute has passed since the channel's last line, naming how many were held back since; a channel-scoped push refused because its channel isn't declared (-32023) or may not be used (-32017) prints the same way on its own lane, per channel, and its line and its trace name the channel. Every refusal is still answered and traced. The unknown-channel trace carries the message id, and its reason is now `unknown-channel`, the line's token (it was `unknown channel — not registered (§14.5)`). A render result the host refuses gets a `[push-render-failed]` line naming the server, subject, event id and failing field, and the occurrence's own content is delivered instead. A missing push `eventId` prints as `""` on every `[push-event-rejected]` line, and the push rejection trace carries `''`. The wire answers are unchanged.
  The host log lines listed here now print the values a server chose (channel, message and event ids, feature set and field names, a tool's name and declared classes, an advertised capability's key, a discarded method's name) in a form a server can't use to add a line that reads as another host record, a word that reads as another field of the same line, or a `key=` that a search for that field finds before the real one. That covers every `[channel-incoming-rejected]` and `[push-event-rejected]` line, the existing empty-content, duplicate and feature-set rejections included; the `[channel-incoming-dropped]` and `[push-event-dropped]` backstops; the `[routeSpeech]` delivery and closed-locus lines; the `[inference-refusal]` line for a locus with no server; both conversation spawn-failure lines, the routed message's and the coalesced batch's; the `[heartbeat]` silent-wake line; the feature-set disabled line, the tool-class lines, the masked-capability line and the discarded-method line. A plain token (visible characters with no space, quote, backslash or `=`) prints as before. Anything else prints as a JSON string with every `=`, every space and every invisible character escaped (a line break, a terminal escape, a bidi control, a default-ignorable character such as a Hangul filler or a variation selector), so `JSON.parse` of it gives back exactly what was sent. A value longer than 256 UTF-16 units is cut instead: it prints, quoted, as its first 256 (255 when the 256th is a high surrogate) followed by `…(N)` with N its full length. A value that isn't a string prints as its JSON text, a non-finite number as `NaN` or `Infinity`. The feature-set rejection's reason, which names the feature set, is a field like any other: `reason="Unknown\u0020feature\u0020set:\u0020…"`. The `[inference-refusal]` line's locus, and a plain unknown tool class, now print without literal quotes. The host's own message at the end of a line is quoted and cut the same way but keeps its plain spaces and `=`.

- A workspace mount with more files than one walk takes is now covered by repeated syncs (#272). Each mount sets its cap with `walkCap`, a positive integer no larger than `Number.MAX_SAFE_INTEGER` that defaults to 5000; any other value is refused when the module is created, naming the mount. A bare `sync` or a `sync` of a directory that reaches the cap lists what it didn't reach under `incomplete`, and the next one of the same scope resumes after the last entry it took, then wraps to the start. A watched mount's catch-up scan (at start and when its watcher reattaches) takes its turn in the same rotation as the mount's bare syncs. The place is kept with the mount's disk evidence, so a restart resumes there too, unless the machine went down before the store made the latest place durable, which only starts the next walk at an earlier place. Before, every walk stopped at the same 5000 files, so no walk ever reached the files past them. An agent-action scan (`watch: 'on-agent-action'`) still takes up to the cap from the mount's start after every tool batch, and a listing (`ls`, `glob`, `grep`) still takes up to the cap from its scope's start. Both now take entries in the walk's name order, so on a mount over the cap they can reach different files than 0.22's first 5000, which followed the order the platform lists a directory in.
  - A walk takes each directory's entries that aren't directories by name, then its subdirectories by name, so each walk can resume where the last stopped, whatever order the platform lists a directory in. A link, or another entry that isn't a directory, counts against the cap as a file does, since the pass reads each one it takes, through the link on a mount that follows them.
  - Each directory's listing is read whole, so a file deleted on disk is seen wherever the walk lists, past the cap included. Before, a directory holding more files than the cap never proved a deletion.
  - Because a watched mount's catch-up scan takes its turn in the rotation, on a mount over the cap a change made while the process was down reaches the workspace when the rotation comes to it, or when a sync of its path takes it. Before, the catch-up scan at start took a change among the first 5000 files every time, and never one past them.
  - The `sync` tool's description now says that a sync takes up to the mount's walk cap, and that the next sync of the same mount or directory picks up where the last turn stopped, with a watched mount's catch-up scan taking turns with its whole-mount syncs. So the first request after the upgrade that carries the workspace's tools misses the prompt cache from its tool block on.
  - On a mount over 5000 entries, the first syncs and catch-up scans after the upgrade catch up on what 0.22's walks never reached: files past the old cap, never scanned, and edits and deletions of tracked files there. Each such pass pushes one event for each kind of change it finds (`workspace:created`, `workspace:modified` or `workspace:deleted`), each listing every path, and a mount whose `wakeOnChange` admits that kind turns each into one message to the agent. Any pass that lists a directory larger than the cap, a listing or an agent-action scan included, also proves deletions there that 0.22 never proved.
  - Going back to 0.22: its walks stop at the same 5000 files as before. It leaves the place alone, so coming forward again resumes there, unless 0.22 wrote a checkpoint meanwhile, which drops every place and starts each scope at its top.

- Removing a single message that belongs to a body, a one-shard body's included, no longer fails: context-manager's `removeMessage` refuses any message in a body, so agent-framework now removes one as a range in offline recovery's suppressions, and in a Discord suppression resumed after a crash. The host `hide` command now hides a message stored as a body (a long one, in shards) whole, with every stored copy of it (a write cut short leaves a partial copy before its retry). Its range form takes what was stored between its two messages, from the earlier one's first copy through the later one's first, and every copy of both, each whole, so a copy stored outside that span is taken on its own, and nothing else stored after the later message began is taken. Offline recovery's suppressed ranges (`suppressRanges`) take the same: before, a range ran through the later message's last copy, taking what was stored between that message's copies, and left out a copy of the earlier message stored after it. Either form's operator-log entry lists at most 50 of the ids it removed, with `removedIdsTruncated` when there were more. It's refused as busy while a surgery holds the store, and a message with no Discord id never matches one. A module's removal of a message it added, and the coalescer's, take its whole body too, and an automatic rewind whose newest message is a shard of a body takes the whole body.

- A lower context budget the agent was running at comes back at once after a restart, when a compile recorded it as reached and the boot's preflight says it still fits (context-manager #162). Before, every restore of a lower budget paced a new descent from the recipe's budget, on a strategy that can prepare a smaller window, so until the first compile settled it the agent reported `converging` and planned at the recipe's budget.
  - **The marker.** The persisted runtime settings carry `contextBudgetReachedTokens` beside `contextBudgetTokens`. It is the record's own budget, written when a compile fits at it (a paced descent's settle included), and withdrawn when the context manager refuses that budget as over budget, even if the budget changed while that compile ran, unless a compile at that budget that started later has already ended with a fit or a refusal: of two compiles at one budget, the one that started later planned at the newer store, so an earlier-started one that ends after it is ignored. The context manager selects against the budget before it adds injections, so a compile with injections plans like one without, and the marker says the stored context fits the budget, not that a request with its injections, system prompt and tools does. A fit counts only if the live budget didn't change while the compile ran, and a settle only for a compile that began under that descent; each arm of a descent is a new one, to the same target included. What a compile showed stands only until the live budget changes: after a persisted change, immediate or paced, back to an earlier budget included, the record carries none until a compile fits at the new budget. A `persist: false` change leaves the record as it was, marker included. A compile must record a fit before an unmarked record can take the proof-based immediate path.
  - **At boot**, each persisted setting is restored on its own: the think-text policy, then the tail and the pace, and the budget last. A budget below the recipe's whose record carries the marker is applied at once if the preflight says it fits now, and otherwise paced from the recipe's budget, as before. The preflight plans the stored context as the context manager will, with the restored tail and pace, so it sees a new `maxTokens` or strategy configuration a restart brings, and a context that grew while the agent ran at another budget; the system prompt, tools and injections are outside the context manager's budget. A budget at or above the recipe's is applied at once with or without the marker, as an increase always is.
  - **If a compile at a budget below the recipe's that the boot applied at once is refused** before any compile at it has fit and before the budget is next written (an update that carries a budget, whatever its value, or a reset of it), the refusal withdraws the marker, and the agent makes the paced decrease a boot without the marker makes, from the recipe's budget: the budget alone, with the default pace when the strategy has none. Then it compiles again. If the budget can't be restored paced, the agent compiles at the recipe's budget with the budget kept set. This fallback runs once: a compile refused after it, including one already in flight at the boot's budget or the fallback's own compile at the recipe's, reports its own refusal, as does one the start order ignores. A tail, pace or think-text policy change leaves it in place.
  - **A persisted setting never stops the agent booting,** except an invalid think-text policy, which still fails closed. A tail, pace or budget that can't be applied now (a tail or pace on a strategy without live settings, a budget no longer above `maxTokens`, a lower one restored paced on a strategy that can't prepare a smaller window) is kept set but unapplied, so a later persisting write keeps it in the record, and the agent runs at the recipe's for it. A `private` think-text policy beside such a setting still governs. When a marked budget isn't applied at once or a setting can't be applied, one log line says why, what couldn't be applied, and the budget that's set beside the one compiles plan at.
  - **Smaller:** a patch can't set the field; a malformed persisted number (the marker, a budget, a tail or a pace) is ignored with a log line naming its kind; a record holding nothing else restores nothing. If reading the record fails at boot, the agent logs it and boots at the recipe's; a store that can't be read at all still fails agent creation at an earlier read of the same state, as before. A record that can't be read or written when a compile tells it is logged, and told again at the next compile at that budget.
- Outside a descent, `previewAgentRuntimeSettings` and the budget preflight plan a patch at the reach its next compile plans at: the pace for a paced decrease, and the configured reach otherwise, so an immediate change, and a pace with no descent, preview at the configured reach. A preview taken during a descent plans under that descent's prepared window, and at its live pace when the strategy carries one, which a preview can't change.
- The runtime settings snapshot (`getAgentRuntimeSettings`, `agent_settings` `get`) reports `effectiveContextBudgetTokens`, the budget compiles plan at now, beside `contextBudgetTokens`, the budget that's set. They differ while a lower budget converges, when compiles still plan at the budget the descent started from, and while a budget the agent couldn't apply is kept, when they plan at the budget it runs at. Code that builds an `AgentRuntimeSettingsSnapshot` itself, such as a test double, adds the field.

- `previewAgentRuntimeSettings()` no longer throws when an agent's context manager (0.14, required since 0.21.1) refuses its queries, as after its strategy failed to initialize: it answers `{available: false, reason}`, with the agent's live budget and the patch's path, as it does for any preview it can't compute. So `resume()` no longer throws for such an agent either. It warns, naming the agent and the reason, and proceeds without a feasibility verdict for that agent: the verdict guards against an agent that would run over budget, and an agent whose manager refuses its compiles can't run. That manager refuses the agent's turns and writes until a `switchBranch` or `setStrategy` succeeds, and maintenance reports it.
- Offline recovery (`createOfflineRecoveryBranch`) reads a sharded message's body as context-manager 0.14.0 does: a message continues the body before it only when it carries the same group id at a higher shard index. A document posted twice stores two copies under one group id, so an anchor at the end of one copy, or a suppression of one copy alone, is no longer refused. A selection inside one copy is still refused. An anchor at the end of a write that was cut short keeps that partial body and leaves out its retry, which context-manager 0.14.0 reads as a body of its own.

- Requires context-manager 0.14.1 (was `^0.14.0`). In 0.14.0, under the
  autobiographical strategy, a dry compile that was the first compile after a
  message's removal left later compiles reading message positions from before
  the removal, so every later compile could throw `UncoveredDropError` until
  something rebuilt the order (anima-research/context-manager#180). Previews
  now compile dry, and hiding or suppressing messages answers with one right
  after it removes them, so with 0.14.0 a hide or a suppression could leave the
  agent unable to compile its next turn.
- context-manager 0.14.1 also reads a calibration record written by 0.13.0 or
  earlier, which has no pricing stamp, as provisional rather than learned
  (anima-research/context-manager#179). It may be discarded at load; one above
  1 that puts a compile over budget drops to 1; and the first provider sample
  replaces it. So an agent whose autobiographical strategy uses adaptive
  resolution, upgrading from such a store, can compile a different window when
  the record is read, and again when the first provider sample sets the
  multiplier, rather than over about ten samples. A store that has already run
  a committing compile on 0.14.0 keeps its re-stamped multiplier;
  context-manager 0.14.0's notes give the one-time reset it may still need.

- A start that continues a logical turn now keeps what the turn has decided
  about where its speech is published. Those starts are a framework retry
  after a stream error, the re-inference that consumes unstreamed tool
  results, and the compile a provider-capacity hold defers a turn to (#314).
  Before, each began with fresh routing:
  - in hybrid mode, the hold after `>>>skip_reply` was dropped, so the new
    stream's unprefixed prose was published to the turn's locus;
  - the sticky destination was dropped in both modes, so unprefixed prose
    went to the locus in hybrid mode, and in explicit mode bounced with a
    notice and a wake, while the new stream streamed nothing;
  - the turn's locus was resolved again: a retry lost a mid-turn addressed
    re-pin, a re-inference took the locus of whichever wake started it, and
    a held turn's later compile let a newer ambient message move it.

  A hybrid stream's live outgoing deltas still start at the turn's locus,
  as before.
- A message that no tool boundary weighed now moves the turn's locus at the
  turn's next start, by the rule a mid-turn message follows: a
  conversational message that addressed the agent, or that follows up in a
  channel the turn sent into, with the same
  `[routing] The conversation moved to …` notice. That covers a message that
  arrives during a capacity hold or before a re-inference, and one drained
  at a budget restart's over-budget boundary, which before never moved the
  locus. Ambient traffic in a channel the turn hasn't sent into, reactions
  and system markers don't move it. Neither does a message the agent won't
  see: one that tune-out diverts, or one removed before that start, such as
  an unread coalesced message its server retracted. The newest qualifying
  message that remains decides. Residents read one message slot, and a
  tool boundary weighs only the messages drained for its own agent, so each
  resident's open turn also takes, by the same rule, a message stored for
  another resident whenever it lands, including one that resident's
  boundary drained. A message tagged as addressed addresses the account the
  residents share, so it can move any resident's turn.
- A silent turn's tool boundary no longer re-pins its locus or adds a
  `[routing]` notice to its stream.
- For a trunk agent, the channel context passed to `beforeInference` hooks
  (`channels.defaultOutgoing`) names the turn's locus once the turn has one.
  After a re-pin, a later start of the turn reports the locus it moved to,
  where its unprefixed speech is published unless a hybrid `>>>` destination
  takes it, not the channel that triggered the turn. A conversation fork
  still reports its home channel.
- A start that fails before its stream exists now lands the messages
  deferred during it, as a stream's end does. Before, they waited for the
  agent's next start and landed after any message stored in between. A
  start that throws outside its stream's failure handling ends its logical
  turn, so the agent's next start opens its own, and an ephemeral run
  (`runEphemeralToCompletion`) whose start throws that way fails at once
  with the start's error. Before, the run waited for its watchdog: 30 s by
  default before its inference started, or 15 minutes once it had.
- A send's engaged channel is recorded on the turn that called the tool,
  even when the open that follows the send comes after that turn has ended.
  A `channel_open` moves the locus of the turn that called it while that
  turn is open. Its result tells the agent of the move, so one that comes
  after the turn ended moves nothing: the result is dropped unread.

- The Discord module's typing keepalive now stops when a turn completes normally, at `inference:completed`. It stopped only at `inference:turn_ended`, `inference:aborted`, `inference:failed` and `inference:exhausted`, so with `autoTyping` on, its default, the indicator went on refreshing after an ordinary reply until the agent's next `inference:started` or its five-minute cap. `onTrace`'s documentation now names `inference:completed` as a turn's normal end, beside the other four.

- `agent-framework-mcp`, the MCP server's bin, now runs as an installed
  command on Linux and macOS. Its file had no `#!` line, so the shell ran it
  as a shell script, and it started only when `argv[1]` ended in
  `mcp-server.js`, which the path of npm's link doesn't. The command is now
  a file of its own that always starts the server, run through the link or
  by its own path, as `mcp-wrapper.sh` runs it. `McpServer` moved to a
  module of its own, which the package root still exports, so importing or
  bundling the package never starts a server. Before, an entry script, or
  a bundle, named `mcp-server.js` did. The server is a client of the
  framework's WebSocket API (`AGENT_FRAMEWORK_WS_URL`, default
  `ws://localhost:8765/ws`), which must be running: without it, it prints
  "Failed to start MCP server" and exits 1.

- A connect or reconnect whose stdio server fails its handshake, by exiting,
  by a transport error or by not answering in time, such as a server that
  exits at startup for want of a token, now keeps the last of the server's
  stderr: at most 2,048 UTF-16 code units, after a `…` when earlier output
  was dropped. The error named only how the handshake failed, and what the
  server wrote about why was dropped (#339). The stderr stays out of the
  error's message, which travels wherever errors go, tool results included,
  since a server's stderr can hold a credential. The error carries it as
  `stderrTail`, the connection's `'connect-failed'` and `'reconnect-failed'`
  events carry it beside `error`, the host's log line about the failure
  prints it a line at a time, and the `mcpl:server-connect-failed` trace
  carries it as `stderrTail`. The `mcpl-down` ops alert, which posts to the
  operator's webhook, leaves it out. An `initialize` error answer, where the
  server gives its own reason, is unchanged.
- A stdio server's last stderr line, when it has no newline, is now emitted
  as a `'stderr'` line once the stream ends. It was kept until more output
  completed it, so it never arrived (#339).
- A stdio server's stderr is decoded as one stream, so a character whose
  bytes arrive in two reads is no longer replaced with U+FFFD in its line.

- `StdioTransport.close()` resolves for a child that a signal other than its
  own `kill()` has already ended, such as an OOM kill or a crash. It waited
  for an `exit` event that had already fired. So a connect or reconnect whose
  child died that way during `initialize` never settled, `close()` on its
  connection never settled, and `stop()` never returned, or, given a teardown
  timeout, failed when it ran out (#331).
- An error an MCPL transport reports while nothing else listens for it is
  now logged instead of thrown as an uncaught exception. That covers a
  transport that `McplServerConnection` keeps for `close()` while a
  reconnect's handshake finishes (#332), a transport whose handshake has
  settled until the connection takes it, and one that a failed handshake is
  closing. A malformed frame from a WebSocket server is such an error.

- An error on a stdio MCPL child's stdin or stdout, such as a write's EPIPE
  from a child that closed its stdin but kept running, is now handled as the
  end of that child. Such an error was thrown as an uncaught exception, and
  where a host caught it, a child that kept running left the connection
  connected, with each request waiting out its timeout. Those pipes carry the
  protocol, so the transport sends the child SIGTERM if it's still running,
  and when the child exits, the transport's close names the error (`child
  process exited, and its pipe failed with write EPIPE`), unless the host had
  closed the transport first. The connection handles that close as any other
  exit: it rejects its pending requests, and reconnects if `reconnect` is set.
  A child that ignores SIGTERM keeps running, and its requests still wait out
  their timeouts. A read error on the child's stderr, which was thrown as an
  uncaught exception too, now reaches the transport's `'error'` listener if
  it has one and is otherwise dropped: once the connection is wired it ends
  nothing, and during a handshake it fails the handshake.

- A stdio MCPL server whose command can't be spawned, such as a command that
  doesn't exist, now fails its connect or reconnect attempt with
  `MCPL server "<id>" could not be started: ` and the runtime's spawn error,
  such as Node's `spawn <command> ENOENT`, which is also its `cause`. Node
  reports a failed spawn after `spawn()` has returned, and a reconnect
  attempt, which runs from a timer, got that report before anything listened
  for it. So it was thrown as an uncaught exception, which ends a host that
  has no `uncaughtException` handler (#336).

- The physical-window projection (#92) projects from the stream's latest
  provider call that reported a prompt. Membrane's usage event is the stream's
  running total across the tool loop, and the projection added it as the
  prior call's prompt and output, so from the boundary after a stream's
  second call on, an agent with `physicalWindowTokens` set could restart its
  stream even when the next request would have fit. Its physical-window
  restart now comes only when that call's prompt and output, what the stream
  has grown by since that call, the round about to be appended and the
  response reserve together cross the window (`maxStreamTokens` still
  restarts on its own), and the `inference:stream_restarted` trace's
  `inputTokens` for a `physical_window` restart is that projection. The
  growth is the blocks appended since that call and the output of each later
  call that reported no prompt. A call's output of 0 counts as `maxTokens`,
  the bound on it, since a call that ends at a tool boundary always wrote a
  `tool_use`. The projection runs once a call on the stream has reported a
  prompt. `Agent.lastStreamRealInputTokens` holds that call's prompt, which
  is what the provider billed, and `lastStreamOutputTokens` its output;
  `Agent.lastStreamUnreportedTokens` holds the growth since.
  `lastStreamInputTokens` stays the stream's accumulated fresh input, which
  is what `maxStreamTokens` checks.

- **`stop()` waits for an operator's operation that is already running, and
  refuses new ones.** A quiesce, a resume, a
  `host/command`, a store surgery, a branch switch, an undo or redo's config
  materialization, a puppet tool call, an awareness sync, or an MCPL
  connect, disconnect or restart admitted before `stop()` began now
  finishes before the event gate, the modules, the MCPL connections and the
  store go, unless a budget runs out first (see the operators' note below).
  Before, such an operation kept running through the teardown. A resume
  waiting on its maintenance pass or previews could go on to leave quiesce
  while the host stopped, so the host booted unquiesced; a puppet call
  could find the store closed partway; a surgery could still be running at
  the final sync; a `host/command` could answer after its connection
  closed; an API server branch switch requested during `stop()` moved the
  branch, mounted its config after the store had closed and answered
  success; and a connect could leave a connection that nothing closed.
  - Once `stop()` has begun, `quiesce()`, `resume()`, `rollbackToMessage()`,
    `suppressMessages()`, `switchBranch()`, `undoLastTurn()`, `redo()`,
    `maintenanceTick()`, `puppetToolCall()`, `syncDiscordAwarenessMarkers()`,
    `connectMcplServer()`, `disconnectMcplServer()` and `restartMcplServer()`
    refuse with "<verb> refused: the framework is stopping" before they
    read or change
    anything, as a `host/command` already did. That includes a call made
    from a trace emitted inside `stop()`'s own start, before its queue has
    closed, and the MCPL listener now refuses a `host/command` from that
    moment too.
  - The awareness delivery that a surgery, a branch switch, a `host/command`
    undo, or the API server's undo or redo starts
    (`startDiscordAwarenessDelivery()`) runs like a server's drain: `stop()`
    doesn't wait for it, and once `stop()` has begun none is started, since
    the teardown would cut it off. The durable outbox keeps the marks, and
    the next start delivers them.
  - `stop()` also waits for what those operations start while it waits: the
    config materialization that undo, redo and the two surgeries start
    without waiting for it themselves. The framework now logs a failed
    materialization.
  - A quiesce stops waiting for its drain, or for an abandon's grace, once
    `stop()` begins. `stop()` cancels the streams and waits for the event
    loop and the operations above, puppet calls included. It doesn't wait
    for any other turn that holds its token with no stream to cancel, so a
    quiesce cut short can report `drained: false`. The host stays quiesced,
    so it boots quiesced. A drain cut short logs that it stopped waiting,
    emits no `host:quiesce` trace, and leaves an abandon it hadn't begun to
    `stop()`, which cancels the streams. An abandon whose grace is cut short
    reports its abandon as usual.
  - A resume refuses at its start once `stop()` has begun, whether or not
    the host is quiesced, and checks again after its maintenance and preview
    waits, before it leaves quiesce, so a quiesced host stays quiesced. A
    resume past that point finishes, its durable clear included, and its log
    says that the parked wakes it released won't run.
  - A host's trace listener can call `stop()` from inside an operation, such
    as on its completion trace, and `stop()` still waits for that operation.
    A multi-turn `host/command` undo stopped that way still undoes every
    turn it was asked for.
  - `undoLastTurn()` and `redo()` refuse with `OperatorActionError`
    (`agent-busy`) while a surgery or a branch switch holds the store,
    instead of moving the branch beneath it.
  - A `stop()` called from a trace emitted inside `stop()`'s own start, as
    the push coalescer's suspension emits for a render in flight, gets the
    attempt already running. Before, it started a second teardown beside
    the first, which then failed at its final sync, and every later
    `stop()` rejected with "Store has been closed" for a framework that had
    stopped.
  - While the host stops, an MCPL awareness barrier that fails no longer
    recycles the connections, which `stop()` is closing. The framework
    releases it as it releases a completed one, so nothing waits on a
    rejected barrier, and unless the host is quiesced, what it held back
    reaches the listeners' stopping refusal.
  - **For operators:** `stop()` waits as long as an operation's own work
    runs. An awareness drain finishes its deliveries, each within its own
    deadline, and a puppet call waits for its tool, so a tool on an MCPL
    server that never answers holds `stop()` until the request times out
    (60 s by default, never with `requestTimeoutMs: 0`).
    `stop(teardownTimeoutMs)` gives this wait its own budget, shared by all
    its rounds, and then gives the modules' and MCPL's teardown the budget
    again, so a budgeted `stop()` can take up to twice the budget, beside
    the stream and event-loop waits that no budget bounds. An operation
    that outlasts the budget fails `stop()` with a `ShutdownTimeoutError`
    that names it, on its own or inside an `AggregateError` when other
    cleanup failed too. `stop()` still tears down the rest, while that
    operation may still run, and keeps the store open, so `stop()` can be
    called again.

- A turn the framework drops before it sends anything, because its agent was replaced or removed, or the framework was stopping or had been stopped and started again while the turn was assembled or compiled, now ends with `inference:aborted`, whose `reason` says which, and records `lastInference.endedAt`. The turn had emitted `inference:started` and then no terminal event, so a module that brackets a turn between them, such as a typing indicator, kept that turn open, and the health snapshot showed it still running. When a newer turn of the agent's name already holds its turn token, the dropped turn emits and records nothing, since both carry only the name and would end that newer turn. The web UI in `ui/` now also returns an agent to idle on `inference:turn_ended`, `inference:aborted` and `inference:exhausted`, where it had looked only at `inference:completed` and `inference:failed`.

- Compiles that are never sent are now dry runs (context-manager's
  `SelectOptions.dryRun`): `previewActivation`, which undo, rollback and
  hiding messages also run for their "last visible" line; the API's
  `message.list` and agent context commands; and a conversation fork's seed
  (the template's compile and the new namespace's emptiness check). A
  committing compile persists fold resolutions and queues the compression its
  fold plan calls for. Once context-manager's thinking binding
  (anima-research/context-manager#160, not yet released) ships, it will also
  commit stamps and join the branch's compiles awaiting acceptance, where one
  never sent can cost a live stream's later replies their thinking. A dry run
  does none of that, and it leaves the agent's consumed watermark and a
  prepared budget change alone, as `previewActivation` already promised; a
  preview at the live window used to settle a converging budget change.
  `ActivationRequestOptions` gains `dryRun`.
- With context-manager 0.14.1, a dry run leaves what a select leaves behind as
  the last committing compile left it: no chunk record, no calibration, and
  none of the bookkeeping the next compile or an observer reads. The one thing
  it can still leave is the release of a compression hold whose deadline has
  passed, as any compile does.
- Under the autobiographical strategy, a dry run still refuses a budget the
  context can't fit, as a committing compile does: context-manager skips only
  its post-pick check, and an adaptive fold plan that doesn't fit then
  overruns at the middle's emission, with a refusal that names the tokens and
  the limit. So at such a budget a preview, `message.list` and the API's agent
  context command still fail, and a fork whose template's fold plan doesn't
  fit the default budget its seed is compiled at still fails to spawn.
  Windowed passthrough, though, skips its refusal of a newest message larger
  than the budget on a dry run: where they failed on such a message, a
  preview, `message.list` and the agent context command now return it alone,
  larger than the budget, and a fork is seeded with it. Passthrough, the
  default strategy, keeps the newest messages that fit, as before.
- A conversation fork's seed no longer copies the template's `thinking` and
  `redacted_thinking` blocks, and leaves out a message with no content left.
  A fork inherits the template's conversation, not its reasoning. A signed
  block was minted under the template's prefix, which the fork's system
  prompt, tools and scoped injections don't promise to match, so on an
  account that enforces thinking binding the fork's first request could be
  refused (inferred from probes of other requests, not observed on a fork).
  Unsigned reasoning, from text-only providers or XML mode, goes by the same
  rule. On models that don't bind thinking to its prefix (by probes, Fable 5
  and Sonnet 5), a copy would have been kept, so there the fork loses the
  template's reasoning. That a provider accepts the stripped seed rests on
  probes of two shapes, each sent without its thinking: an assistant text
  turn followed by a new user turn, on Sonnet 5.5, Fable 5.1, Fable 5 and
  Sonnet 5; and a tool round, a `tool_use` with no thinking before it and
  its result, continued by the model, on those four, Opus 5.5 and Haiku 5.5.
  Other thinking models weren't probed.
- On the OpenAI Responses path, the seed's items that were paired with a
  reasoning item it left out (the message's text, a function call) lose
  their provider-native raw item and render from their fields, so the fork
  replays no item id whose reasoning is gone. Opaque items, such as a
  compaction or a hosted tool's call, keep theirs.
- A fork's seed keeps no tool call whose result isn't in it, and no result
  whose call isn't (context-manager's `stripUnpairedToolBlocks`): the rest of
  their messages stays, and a message left with nothing becomes
  `[tool call omitted]`. A fork spawned while the template was between a
  tool round's call and its results (the coalescer can spawn one outside the
  event loop) gave the fork's first request an unanswered call under the
  passthrough strategies.
- A fork's spawn logs one line when its seed left something out:
  `[conversation] <fork>: seeded from <template> without N thinking
  block(s), N unanswered tool call(s) and N orphaned tool result(s)`.

## 0.22.1 — 2026-10-14

**Operators upgrading from 0.22.0:** a provider's stated `retry-after` now
holds a resident's or conversation agent's turns, recorded in the store and
kept across restarts, where 0.22.0 slept it inside the turn and `stop()`
couldn't end the sleep. A hold longer than an hour raises a `provider-wait`
ops alert, and the `release-provider-wait` host command lifts one. An
ephemeral run, such as a subagent's, still sleeps a stated wait of up to ten
minutes, and a longer one ends the run at once, telling its caller why. If
the recorded waits can't be read, no resident's or conversation agent's
provider call goes out until they read again (every 30 s), or until an
operator releases that agent's waits with `release-provider-wait` for the
life of the process; a `provider-wait` alert for agent `framework` says so.
A misspelled model's 404 no longer sheds the agent's newest exchanges.
Discord reaction suppression's default now also covers the awareness emoji
(💤 unless configured otherwise) and retained recovery emoji; a host that
injects the old refusal-only default should remove it. Going back to 0.22.0
is safe. It opens a store 0.22.1 wrote and ignores the recorded waits, so a
long `retry-after` is slept inside the turn again, and a wait recorded before
going back binds again if you return before it passes. Not tested: going back
while the recorded waits can't be read, going back after an operator released
a wait under 0.22.1, and going back under connectome-host rather than a bare
framework.

### Added

- `McplServerConnection`'s `'close'` event now carries a third argument,
  `McplConnectionCloseInfo` (`transport`, `code`, `signal`, `reason`,
  `byHost`), so a host can see the WebSocket close code a networked MCPL
  server sent (e.g. 4001 for an expired or refused credential) and refresh
  what `accessProvider` hands the next dial instead of replaying it. The
  first two `(code, signal)` arguments are unchanged; host-initiated closes
  now pass `(null, null, info)` where they passed nothing. The type is
  exported from the package root alongside `McplServerConnection`.

### Fixed

- Discord reaction suppression defaults include refusal markers, default/configured awareness markers, and retained recovery-outbox emojis. `framework.getPlacedReactionBaseline()` exposes that snapshot as suppression tokens, converting composite custom-emote markers to stable IDs; stored markers and reaction payloads remain unchanged. Stdio MCPL children get it by default, derived at each spawn (first connect, automatic reconnect, restart). Suppression is by emoji, so members' own reactions with 💤, the configured awareness emoji or a retained recovery emoji stop reaching the agent too, as members' 🛑 already did. When the awareness ledger can't be read, a runtime connect refuses before it registers or spawns anything (a startup connect, before it spawns), any restart refuses before it stops the running child, and an automatic reconnect of a child taking the default fails and retries rather than spawn without it. Explicit server env and intentionally inherited baseline values with tokens retain precedence, and the framework logs when one replaces the default; a value with no tokens, as discord-mcpl's parser reads them (blank, commas alone, or only tokens its normalizer reduces to nothing, such as `:`, `::` or a lone U+FE0F), or a null counts as unset, since the adapter would read it as suppression off (its filters file and legacy operator env are where suppression is turned off), and any other non-string value (a number from a JSON config) is read as its string form, as the child sees it, rather than failing the connect. On Windows, duplicate spellings resolve to the first in sorted order within each source, then declared values take precedence over inherited values. Hosts that inject the old refusal-only default must remove that default to adopt the framework-derived one; remote WebSocket adapters still need their own environment configuration (#95).

- The inference-failure pipeline bounds the failure text it records. A failure's text is its source's `Error.message`, and a provider can echo the whole rejected request there: in one household an OpenAI-compatible 400 echoed ~1.7 MB, and the framework stored it in the resident's own context as an `[inference-failed]` marker (about 200K tokens, by the household's notes, which the resident then carried), wrote it to stderr and `logs/failures.log`, and traced it.
  - Every cut this change makes follows one rule: the text's head and tail around a marker stating how many of how many characters were omitted. Each sink cuts the whole text, so its marker states the whole length, and no cut separates a surrogate pair.
  - The `[inference-failed]` marker carries an excerpt of at most 600 characters. It also names the classification when there is one ("the model call failed (invalid_request, HTTP 400) …"). Its metadata adds `errorType`, `retryable`, `httpStatus` and `providerErrorCode`, plus `reasonChars` whenever the marker's excerpt was cut. A small unclassified failure produces exactly the marker it did before. Markers already stored keep their size until they're folded or removed.
  - The rewind marker's reason is cut to 160 characters, an agent's `lastInference.lastError` and the compile-refused ops alert's to 300, and the ops webhook's copy of the alert's message to 500. Each bound includes the marker.
  - Each of these is bounded to 2,000 characters:
    - the reason excerpt in the exhaustion stderr line (the line also carries the agent, the streak and `type=… status=… code=…` labels when known);
    - every field of a `logs/failures.log` record: a string to 2,000 characters, an `Error` as its projection (below), and any other value as its JSON, with any `Error` inside it written as its projection, kept as data when it fits and as bounded text when it doesn't. A record with a value JSON throws on, such as one with a cycle, is no longer lost: that value is described as a thrown value is (below). A value JSON writes nothing for, such as a function, is left out, as JSON leaves it out;
    - ops alert messages, and an alert's `data` on its `ops:alert` trace, bounded field by field as a failures.log record is, so a trace listener gets the plain data the log writes: a `Date` as its ISO string, a `Map` as `{}`, an `Error` as its projection. Data that isn't a plain object, such as a string or an array from a JavaScript caller, is kept as one field, `data`, rather than spread into a field per character or element, and a message that isn't a string is described as a thrown value is (below) rather than thrown on;
    - the inference log's `error`;
    - every trace event's `error` and `stack` strings;
    - the provider cooldown's reason, in its stderr lines and the status snapshot's `cooldownReason`;
    - the error an ephemeral run (`runEphemeralToCompletion`) rejects with.

    `inference:exhausted` traces and failures.log records add `httpStatus` and `providerErrorCode`, and a failures.log record adds `reasonChars` when its own excerpt was cut. The error type and the provider code are recorded to at most 128 characters each.
  - The OverBudget drain kick, the marker write and the provider-cooldown resume used to print the error object when they failed, as did a host's `providerHold` hook when it threw (the hook is handed the model's error, and can throw it back). They now print a bounded projection instead: name, classification, status, provider code and message, cut once to 2,000 characters as one text after the name, type and provider code are bounded, on one line unless one of its parts has newlines, as a message can. A thrown value that isn't an `Error` is printed as its `String` when that's text of its own, as for a `Buffer`, an `Error` from another realm or a class with its own `toString`. An array, or an object whose `String` is empty or only its tag, such as `[object Object]`, is printed as its JSON, bounded, with any `Error` inside it as its projection, so a thrown plain object keeps its fields and an array its elements; the tag stands when JSON can't write the value or finds no fields in an object. Context maintenance describes one the same way, and its alert's copies, the webhook's included, are cut once from the whole message. The stack's frames follow on the lines below, also bounded to 2,000 characters: from after the message when the message is the stack's header, and otherwise from the stack's first frame line. Printing a `MembraneError` printed its message whole, in the stack, and its `rawRequest` with each string up to Node's 10,000-character limit, a long system prompt among them. Context maintenance records and logs a bounded message, in its existing format.
  - The OverBudget drain breaker's message-text fallback now applies only to unclassified failures, and it is decided on the whole reason, never the excerpt. A classified provider error that quotes "exceed hard budget" or "no summary covers" (the agent's own context, echoed back) no longer kicks the compression drain.
- This bound doesn't depend on membrane bounding its own errors.
- A `MembraneError` from another copy of membrane is recognised by its name as well as by its class, since the host supplies the `Membrane` instance and two copies can be installed. Its failure is classified, and so gets the framework's recovery for its class: an invalid request now sheds the newest exchanges of the agent's history, up to the rewind cap, as the poisoned-history quarantine does for the framework's own copy. The default error policy reads its `retryable` and `retryAfterMs`, and an organization acceleration limit it reports is held, as for the framework's own copy. Before, each treated it as an unknown error: the default policy retried a non-retryable one up to three times, and its failure was then left unclassified.
- Not covered by this change: an `Error` from another realm (a `vm` context) nested inside a value, which fails `instanceof Error` and so is written as its own JSON rather than its projection (at the top level, a thrown one is printed as its `String`); Discord-awareness log sites, the speech-route failure reason and `[discord-send-failed]` marker (kept whole as the delivery evidence a resident reads before resending), logs outside the inference-failure pipeline that still print an error object, in modules and in the framework's own code (among them the `beforeInference` hook's catch and its preview's, the event loop's catch, periodic and final sync, and the maintenance pass's retry of the tool-result guard's storage), and two plain slices: the health report's 400 characters of the inference log's stored error (already bounded to 2,000), and the tool-result spill's 200 characters of a workspace write's failure.

- A provider's stated `retry-after` is now a lower bound on the next call to that model, for that agent, across restarts and branch switches. When a classified error carries `retryAfterMs` as a number, the framework records a provider wait for (agent, model) and calls that model no earlier. That includes an error from another copy of membrane than the framework's own, since the host supplies the Membrane instance:
  - **Primary turns** are held, not retried and not counted as failures: no `[inference-failed]` marker and no hard-down streak. Wakes that arrive meanwhile join the held turn, and one fresh compile runs when the wait ends, the way an organization-acceleration cooldown already works. This applies to a failure the provider says may be retried; a non-retryable failure that states a wait keeps its terminal disposition (its marker and failure count), and the wait binds the calls after it.
  - **Admission is checked at the last boundary before a primary call**, so a wait recorded after a wake was scheduled (by an auxiliary call the wake parked behind) holds that wake too.
  - **Auxiliary calls** (context-manager compression through provider admission) to a held model are refused without calling the provider. The refusal is a retryable `rate_limit` `MembraneError` carrying the remaining wait as `retryAfterMs` (none for a wait held until released), marked `providerAdmission: 'deferred'` so a pacing caller can keep the wait without counting a failed call. context-manager reads that marker from its corrective round (#138) on. context-manager 0.14.0, the version this release requires, doesn't read it yet: it rethrows the refusal as it does any retryable error, and its next attempt meets the same admission, still without a call to the provider. A different model is not held: a compression model the provider did not limit keeps working, and changing an agent's primary model lets its turns proceed while the old model's wait stays recorded.
  - **Durability:** waits are kept in typed Chronicle records (RecordJournal), so a restart honours them and a rollback or branch switch does not rewind them. A wait or release whose record could not be written still binds in this process, and is offered to the record again, in order, at every later act (and from admission checks every 30 s); an ambiguous write is reconciled before anything is decided against the record. If the store's append itself throws, the record journal writes nothing more until the store is reopened, as at the next start, and that is logged once. The record that append was writing may still be in the store's log, where the next start loads it. Every later act holds in this process only, and a restart doesn't keep it.
  - **Unreadable records fail closed:** if the recorded waits cannot be read at startup, or a record parses but is not a well-formed provider wait, their absence is unknown, so no provider call is admitted for any resident or conversation agent until they can be read (retried every 30 s; held turns resume by themselves once they can) or an operator releases an agent's waits. An ephemeral run records no waits, so none can be unknown for it, and it isn't held. The hold names its cause in the log and in `providerWaits` (model `*`, which stands for every model), and inspection is unaffected. Such a release lifts exactly what it names (that model, or every model when none is given or it names `*`) for this process only, and a restart that still cannot read the records holds again. As the hold begins it raises a `provider-wait` ops alert for the whole framework (agent `framework`, model `*`), once per episode, since a cause that persists, such as a record this reader does not know, never reads again.
  - **No shortening:**
    - A later, shorter wait never shortens an outstanding longer one.
    - A wait that cannot be represented as an instant becomes an indefinite wait, held until released.
    - A negative stated wait (a provider's "retry now", or an HTTP date already past) is already over: it binds nothing, the same as 0. An organization-acceleration hold reads it as a stated 0 too (the 1 s floor, plus jitter).
    - The organization-acceleration cooldown no longer caps a stated wait at 10 minutes. The cap still applies to the framework's own default wait.
  - **Visibility:** `healthSnapshot().agents[].providerAdmission.providerWaits` lists the waits that bind now. Each wait, hold and release is logged once (`[provider-wait] …`). A wait's reason is the provider's message, bounded, with its control characters as spaces. A wait recorded to hold a model for more than an hour, or until released, also raises a `provider-wait` ops alert (a failures.log record, an `ops:alert` trace, and the ops webhook when configured), so a person can decide whether the provider meant it; it is honoured in full either way.
  - **Operator override:** the `release-provider-wait` host command (`agentName`, optional `model`) and the `host.releaseProviderWait` API verb release a wait, and the release is recorded so a restart does not restore it. The API verb takes the server's `adminToken` when one is configured, as the other host verbs that change something do. A `model` that is not a nonempty string, or that holds a control character, is refused, never taken as every model. A release names its agent on both surfaces. An `agentName` that is neither one of the framework's agents nor the agent of a wait `host.providerWaits` lists (a disposed conversation agent's, say) is refused before anything is recorded, `*` and `framework` included: the hold for unreadable records is lifted one agent at a time. The release records who asked. Over the API that's `api`, or `api:<requester>` for a requester the caller names. Any requester is bounded, and its control characters become spaces. An organization-acceleration cooldown that the released wait lengthened falls back to the framework's own pacing for that failure; a host hold (`providerHold`) stays the host's. Each released wait's receipt says how far the release reaches: `recorded`, `pending` (binding here, its record not yet written), or `in-process override` (the unreadable-records hold). A context strategy that paces its own calls by the same wait and has `releaseCompressionPause` (context-manager's compression lane from its corrective round, #138, on; 0.14.0 has none, so nothing is called) is released with it, for the model the release names, even when no wait binds in the framework itself (the lane may still hold a pause the framework no longer has); the receipt lists only the framework's own waits. `host.providerWaits` lists the waits. Only the passing of the wait, or this explicit release, ends one, and an ordinary restart does not; the hold for unreadable records also ends once they read again.
  - **Scope:** the guarantee covers the calls the framework makes for an agent: primary turns and auxiliary calls through provider admission. It covers the calls themselves, not membrane's retries inside one: membrane 0.5.87, the version this release requires, retries a rate-limited `complete()` call up to four times before throwing. Each retry waits the longer of its own backoff (1, 2, 4, then 8 s) and the stated wait, but no longer than `maxRetryDelayMs` (30 s by default), so a stated wait longer than that is retried inside, and an auxiliary call can reach the provider again inside the wait before the framework records it. membrane #102 stops that for a wait longer than its retry window; until a release carries it, a host's `hooks.onError` returning `'abort'` stops it. Primary turns go through `streamYielding()`, which has no retry loop. A wait binds the agent the provider answered. Another agent on the same model isn't held by it, and records its own wait from its own first refusal. Traffic a provider adapter makes on its own, such as membrane's Anthropic cache keepalive, is outside it. So is server-initiated inference through the MCPL inference router, which runs for an MCPL server rather than for an agent, so no agent's wait applies to it.
- Error-policy retry waits no longer fire almost at once when a delay exceeds what one timer holds (about 24.8 days). They wait in steps, and `stop()` ends a wait in progress.

- Live `rollbackToMessage` and `suppressMessages` (and message-granular
  `host/command` undo, which rides on rollback) return once the body change
  has landed, with a marker-scheduling receipt, instead of after every
  awareness reaction (💤 by default) has been delivered. Previously the store
  stayed reserved, and the operator got no answer, for the whole serial
  drain. At the reported pace of about one reaction per second, 918 queued
  marks would take roughly 15 minutes; the household's client timed out
  after 60 seconds. Delivery now continues in the background, behind the
  same MCPL data-plane gate as before, which holds channel traffic that
  arrives after it until the marks are attempted, or deferred when their
  server isn't connected. A turn may now run during delivery when it carries
  no channel traffic, such as a scheduler timer or a provider admission, and
  also when its channel traffic was admitted before the gate went up (queued
  when the surgery began, or arriving during its switch or fork). Such a
  turn used to wait for the whole drain, since the store stayed reserved;
  now it can answer before the marks show.
- The other branch moves no longer wait for Discord either: the web API's
  `branch.switch`, `undo` and `redo`, and `host/command` turn undo, return
  once the branch has moved, and their marks follow behind the same gate.
  Each starts its delivery through
  `startDiscordAwarenessDelivery(after, agentName?)`, a new public method
  that a host can call after its own branch moves. A delivery that fails to
  start raises a `discord-awareness-delivery` ops alert instead of failing
  the command, and the next sync, reconnect or start delivers what is still
  pending. (The web switch used to await the awareness sync before
  answering.)
- A gate installed while a drain is still running (restoring the source
  branch mid-delivery, say) waits for that drain and then drains again from
  the ledger. So before traffic is released, every mark pending when the
  gate was armed is attempted, or deferred until its server is connected,
  as before: the drain's remaining reactions, the removals they need, and an
  add re-pended during the drain (a rollback, its undo, then a redo).
  Inbound MCPL handlers wait out a generation installed while they wait, not
  only the one they first saw, and a reconnect's gate opens only once both
  its drain and the server's re-registration attempt have settled. So a
  reconnect's `mcpl:server-reconnected` and `module:added` traces now come
  once that attempt has settled, granted or not, where they came at once
  when no marks were pending.
- The result's new `markers` field (`none` | `queued` | `not-scheduled` |
  `unresolved`, the exported `SurgeryMarkerReceipt` type) says whether marks
  were scheduled, never that Discord accepted them. The `[operator]` stderr
  line gains `marks=…` and the operator-actions log entry gains `markers`.
  If the ledger write after the switch fails, the rollback that already
  applied is no longer reported as failed: the batch is retired
  (`not-scheduled`, with a `discord-awareness-not-scheduled` ops alert), or,
  if even that write fails, the result says the batch may still be
  delivered (`unresolved`, with a `discord-awareness-unresolved` ops alert). A
  suppression whose redactions all committed is no longer undone by that
  failure.

- A result of the workspace's `materialize`, `sync` or `delete` that the
  tool-result guard withholds now keeps what it acted on in its stub, after
  where the original is ("Kept from its result: {…}"): what `materialize`
  removed from disk and wrote to it, any root `sync` accepted and what it took
  from disk, gave up or holds as a conflict, per mount, and the path `delete`
  removed (a `delete` that failed keeps nothing, as any failed result). The
  result as stored still goes where every withheld original goes. Past the
  inline cap the kept fields are cut in that order, so a later list can be
  cut away entirely, and the stub says so. While the store is away from the
  batch's branch, the stub stays the bare notice, without the kept fields, as
  every withheld stub does then. A tool marks which fields of its result's
  data are kept with the new `ToolResult.keepWhenWithheld`; only these three
  mark any. Before this, a withheld receipt hid even which files a write had
  touched, such as the clobbered `LOG.md` in agent-framework #277.

- A module's event that arrives after `stop()` began is dropped with a log line naming the module, through `ModuleContext.pushEvent()` or the deprecated `queue` handle alike, instead of throwing `Queue is closed`. `stop()` closes the event queue before it stops modules, so such an event comes from a listener that fires while `stop()` runs, where the throw can go unhandled, or from the module's own `stop()`, where it made the framework's `stop()` fail. A direct caller of `AgentFramework.pushEvent()` still gets the throw for anything but a tool result, and a module's tool result keeps that method's drop line, which names the call, the tool and its outcome. The deprecated `ModuleContext.queue` is now an object with `push` alone, as its `ProcessQueue` type always said; it was the framework's own queue object.

- The poison-history breaker sheds history only for an `invalid_request` that came back as HTTP 400, 413 or 422 or that carries no status, and for a `context_length` at 413. The status is a heuristic for when shedding the newest exchange may help, not proof that the history is at fault. 400 and 422 are how a provider answers a request that fails its validation, as a history it can't accept does. A 413 is the request's size: when the newest exchange made it too large, as an oversized attachment does, shedding that exchange may recover, and nothing else in the framework does; when the history as a whole is too large, the shed doesn't help, and the breaker stops at its rewind cap. The 413 arm takes both labels a 413 arrives under, `invalid_request` and `context_length`, since membrane's label for a 413 differs by version and adapter. Other statuses keep the history, since shed history can't be got back and the status gives no sign that a shed would help: a 404 is a model or an endpoint that doesn't exist, and 405, 409, 410 and 415 are about the HTTP request or the resource, as a rule, rather than the conversation. The failure is still counted, logged and reported hard-down either way.
  - With membrane 0.5.87, which this release requires, one status table serves every adapter. A 404, such as a misspelled model's, arrives as `invalid_request`. Under 0.22.0, three of them shed the agent's newest exchanges, under a rewind marker saying "the model API kept rejecting the conversation on them"; 0.22.1 keeps the history. A 405, 409, 410 or 415 arrives as `invalid_request` too and is kept the same way. A 413 arrives as `context_length` and still sheds, so the breaker also sheds for an Anthropic 413, which no earlier release did. A `context_length` at 400 or 422 is a token overflow and keeps the history. A 422 from an OpenAI-compatible server that answers a validation failure with it, such as a FastAPI one, arrives as `invalid_request` and still sheds.
  - An error with no status, from a membrane that reports none, keeps the breaker's earlier rule, the type alone.
  - Account refusals, such as Anthropic's "credit balance is too low" and usage-limit 400s, arrive as `auth` and never shed.
  - The rewind marker the breaker writes into the agent's context says the turns were set aside because the model API kept refusing the requests that carried them, so that the conversation could go on. It used to say the API kept rejecting the conversation on them.

- A provider's stated `retry-after` on a turn that doesn't own provider admission, a conversation agent's or an ephemeral run's, is no longer slept in the turn for as long as it says. Such a turn went to the error policy, which returns a stated wait as it is: a 429 stating two hours held the turn asleep two hours per attempt, up to three times, with nothing recorded and nothing raised.
  - **Conversation agents** treat a stated wait as a resident does. The wait is recorded for (agent, model) and raises the `provider-wait` ops alert past an hour. The turn is held until the wait passes or `release-provider-wait` releases it, and one fresh compile runs then. A non-retryable failure that states a wait keeps its terminal disposition, and the wait binds the calls after it. This applies however the call fails, including a stream that throws.
    - Its retries and in-turn restarts check its recorded waits at the last boundary before the call, as a resident's turns do. It takes no provider gate, so its own compression can record a wait while a turn compiles: each of its turns checks again once compiled, and a wait found then holds the turn before anything is sent.
    - Its context manager's compression calls to a held model are refused without a call, and a compression call's own stated wait is recorded for it. A conversation agent still takes no provider gate: admission stays the resident's.
  - **Ephemeral runs** sleep a stated wait of up to 10 minutes, the framework's own longest pacing, and retry, as before. A longer stated wait, or one that can't be represented, ends the run at once. It is never retried before the provider's time, and the run's error says why: `… (the provider asked to wait 7200 s; an ephemeral run doesn't sleep a stated wait longer than 600 s, so it ends now)`. Nothing is recorded for an ephemeral run, whose name is single-use.

- MCPL references (RFC-005): display labels now drop the Arabic letter mark (U+061C) along with the other bidi controls, and are trimmed. `fetch_reference` shows the response's `Content-Type` and the server's claimed type as labels too, and `save_recent_image` shows a reference's claimed type in its refusal, and an attachment's media type in its receipt, as labels. The stub leaves out a label with nothing left once sanitized. A server's type such as `constructor` now saves the file as `.bin` instead of naming it with inherited function text.
- An `expiresAt` rejected as a field (past its 64-character maximum, or not a string, null included) now fails closed like an unparseable one on the fetcher's paths: `fetch_reference`, the eager default and a code-execution script's result. The fetcher treats such a reference as already expired, never as immortal, and doesn't fetch it. It still serves a copy saved earlier while the host holds the reference's record. A restart or an eviction drops the record, and a reference sent again is then judged on its expiry. A uri-form image block that a converter hands the provider as a URL source is unchanged.
- A reference that has already expired when it arrives gets a stub giving the case (an expiry that has passed, one that doesn't parse, or one rejected as a field) instead of offering `fetch_reference`. `save_recent_image`'s refusal of an expired reference, and the fetcher's refusal, give the same reasons. For a reference this process holds no record of (after a restart or an eviction, or a stub quoted from elsewhere), `save_recent_image`'s refusal says it can't be fetched, and to re-run its tool if the tool can produce it again. The eager default no longer gives one of a result's eight slots to an expired reference, to a uri that any of the result's blocks calls expired, or to a second block for a uri the result already listed.
- The reference registry, past its 2000 records, now evicts the reference registered least recently, where it evicted the one registered first. Registering a reference it holds, as showing its stub does, makes that reference the newest, since the one the model was just shown is the likeliest to be fetched. A result with at most 2000 distinct references therefore no longer evicts a reference it has just named.

- Unsubscribing a trace listener while an event is being delivered (through `onTrace`'s returned function or `offTrace`) no longer makes the next listener miss that event. Each event goes to the subscriptions present when its delivery starts, each one only if it is still subscribed when its turn comes, as the DOM's `EventTarget` delivers: a subscription made during delivery is first called for the next event, and a subscription removed during delivery is skipped if its turn hasn't come. Each `onTrace` call is a subscription of its own, so a listener subscribed twice is still called twice. The function `onTrace` returns now removes its own subscription, so calling it twice no longer removes a second subscription of the same listener.

- Workspace `sync` says what it didn't look at (#276). A sync now counts,
  under `passedOver`, what each mount's scan skipped by design and reported
  nowhere else, by reason. Today that's the entries its ignore list covers
  that hold nothing the workspace tracks; an ignored directory counts once,
  and one that hides a tracked path is listed under `incomplete` instead. A
  walk cut short, by the file cap or a directory that changed while it was
  listed, is listed under `incomplete`, and counts only what it kept. So a
  `totalSynced` of 0, with a `totalConflicts` of 0 and nothing under
  `passedOver`, `incomplete` or `skipped`, means the sync looked everywhere
  and nothing had changed; changed files it couldn't take in are listed
  under `skipped`. A path the ignore list covers is synced when named, and
  the result lists it under `ignored`: a sync without a path passes over it,
  so nothing else keeps it current. Naming an ignored directory sets aside
  the patterns that cover it or a directory above it; a pattern that covers
  only something inside it still applies, so with `build/**` and `*.md`,
  naming `build` takes `build/out.txt` and passes over `build/LOG.md`. A
  symlink the ignore list doesn't cover isn't counted: the pass reports each
  one by path, taken through the link when it's a file on a mount that
  follows symlinks, and otherwise listed under `skipped`. One the ignore list
  covers is passed over like any ignored entry.

## 0.22.0 — 2026-10-13

### Breaking

- **Workspace tool-output consumers:** `glob` returns `matches` as objects,
  `{ path, state, size?, mimeType?, conflict?, note? }`, instead of path strings. `sync` reports
  `conflicts` as `{ path, kind, diskCopy }`. `sync` without a path no longer replaces a workspace
  draft with a differing disk copy: the draft stays, and where disk changed too, the path is a
  conflict until a `sync` of that path or a forced `materialize` resolves it, or the two converge.
  For an `unknown-provenance` or `store-origin-collision` conflict, the forced `materialize` must
  name the path: one without a path leaves it. `ls`, `grep` and `sync` otherwise only add fields
  (each `ls` file entry's `state`; grep's `state`, `version`, `skipped` and `incomplete`; a path
  sync's `discarded`).
- **Hosts and module authors reading workspace internals:** `MountState` no longer has
  `materializedHashes` or `refusedPaths`. Disk-agreement evidence lives in `workspace/disk-agreement`
  chronicle records, and branch-local intent in each mount's `workspace/<mount>/intent` tree state.
  The module's saved state carries neither field, so a build from #169's branch started on a
  store this release wrote begins with no freshness baselines.
- **Prompt cache:** the descriptions of the workspace's `ls`, `glob`, `grep`, `sync`,
  `materialize` and `delete` tools change, and `sync` and `materialize` take new parameters, so
  the first request after the upgrade that carries those tools' definitions misses the cache from
  its tool block on.

### Added

- Tool-name patterns that match no tool are reported. This covers
  `toolClassOverrides` keys and `toolLifecycle.observe.tools` /
  `toolLifecycle.inputs.tools`. Each pattern is reported once, as a console
  line and an `mcpl:tool-pattern-unmatched` trace. A pattern written against
  the bare server id gets the `mcpl--<serverId>--…` form suggested, since
  that is the default tool prefix. A pattern that could name a server's tools
  waits until that server has listed them.
- Two disablements that were only console lines are now also traces.
  `mcpl:feature-set-disabled` covers a feature set that §6.4 derivation turns
  off, for example one that declares no `uses` while `enabledFeatureSets`
  lists it. `mcpl:policy-refused` covers a server refusing the host's policy,
  with its `fallback`.
- README documents MCPL tool naming (`<toolPrefix>--<tool>`, default prefix
  `mcpl--<serverId>`) and how `enabledFeatureSets` behaves. The `toolPrefix`
  doc comment now shows the real `--` separator.

- **`Module.onToolBatchComplete(agentName)`**: called once an agent's tool batch completes,
  when the round's last pending result arrives and before it is provided. It therefore runs
  before anything that continues the turn: re-inference, stream resume or the end of the turn.
  The framework awaits every module's hook in parallel, each bounded at 30 s and fail-open; a
  hook that throws (before returning its promise or after) or times out is traced as
  `module:batch_hook_failed` and the round goes on.
  The agent's state is checked again afterwards, so a result whose turn was cancelled or
  replaced during the hook is dropped (traced as `tool:result_dropped`). A hook still running
  from an earlier batch, past its bound, is skipped rather than called again. The hook is
  awaited in the framework's event loop, so a slow one holds every agent's event processing,
  not only the batch's agent. Script-inner tool calls don't trigger it, nor does a batch whose
  error results the framework fills in after its stream ended before its tools answered.
- Workspace: `materialize` accepts `applyDeletions`, `WorkspaceConfig` accepts
  `agentActionScanDeadlineMs` (default 20000, kept below the hook's 30 s bound), and
  `workspace:deleted` events carry `conflicts` when a disk deletion met a newer workspace edit.

- Add opt-in resident-editable tool descriptions and visibility, a source-grouped generated catalogue, and optional component description profiles. Hidden tools retain their existing execution permissions.
- Keep hidden definitions available to compression, protect catalogue path aliases and discovery instructions, and preserve shared override-file permissions during resident edits.

- Live requests capture advertised and compression definitions together before asynchronous context gathering, so mid-gather tool refreshes cannot split their snapshots. Settings edits preserve permissions through the open temporary-file descriptor and reject detected pathname replacement before committing.

### Changed

- **Per-channel conversation routing is deprecated** (`FrameworkConfig.conversations`,
  `ConversationRouter`, `ConversationRouterConfig`). Its `'mention'` bind/trigger
  rule, the default for channels, reads `metadata.mentioned`, which discord-mcpl
  never sets, so on Discord channels an @-mention neither binds a fork nor
  triggers a bound one (#235). Behavior is unchanged for now: routing still
  works, and the framework logs one `[deprecated]` line when it is created with
  `conversations` set. Removal is a follow-up. The `idleTtlMs` docs now note
  that expiry is checked at most about once a minute, so the sweep usually
  notices an expired binding up to ~60s after the TTL; that is not a deadline
  for closing the fork, whose closure turn can be delayed further (e.g. while
  the host is quiesced).

- Depends on `@animalabs/membrane` `^0.5.87` (was `^0.5.78`), the version this
  release is built and tested against. Membrane 0.5.87 classifies provider
  errors at the HTTP boundary and honours `retry-after`, defaults to native
  tool mode where the formatter supports it, and reports `pause_turn` as its
  own stop reason; see its changelog for the full list.

### Fixed

- A module's tool result that JSON can't hold, such as a cyclic object, a
  BigInt or a `toJSON` that throws, is now answered as an error result
  naming the tool wherever the framework stores or sends it: a model's
  call, a script's inner call, the `utils` meta-tool for a model,
  `read_image`, and the pair `puppetToolCall` stores. So is a result that
  isn't a result object (`undefined`, `null`, an array, a string, an `Error`
  returned rather than thrown), a result whose getters or Proxy traps throw
  while it's read, and a non-error result whose data is a function or a
  symbol, which JSON leaves out whole. The error keeps the module's own
  error text and its `endTurn` when they can be read. Before, the first
  code to store, send or trace such a result threw, and the agent's turn
  never settled (#309). Those paths now read a module's result once and use
  its JSON form, so its getters and `toJSON` never run a second time. A
  caller that uses the result in process (`ModuleContext.callTool`,
  `executeToolCall`) still gets the module's own result, and
  `puppetToolCall` still returns it, or the error result where it used to
  reject.
- A module's `error` is sent as text: an `Error`'s message, an object's own
  `message`, any other value's JSON, or a BigInt's or symbol's `String()`.
  One that says nothing (`null`, `false` or empty), and a throw with no
  text, read as "Unknown error", as a missing one does. A result's
  `success`, `isError` and `endTurn` are sent as booleans.
- A tool result with no data is stored as empty text, as an empty content
  array is. Before, storing it threw, and the turn never settled. A
  failure the tool doesn't flag as an error for the model
  (`{ success: false, error, isError: false }`) with no data reads as its
  error text, for the model and for a script.

- In explicit prose routing, when a round calls `skip_reply` itself (in
  native tool mode, and not from a `code_execution` script), the prose
  gateway no longer delivers or bounces that round's plain text.
  `skip_reply` promises that "Any plain text you wrote this turn stays
  private and is NOT posted". The round's segments used to go through the
  gateway like any other round's. Unprefixed text with no destination
  bounced: it went onto the clipboard for an `{{unsent}}` resend, got a
  bounce notice and could wake the resident again. Unprefixed text after a
  destination set earlier in the turn was published there. Now none of that
  round's envelopes is delivered or bounced, and none moves the destination
  or asks for a continuation. A `>>skip_reply {{unsent}}` in it still sets
  the retained text aside. A valid destination prefix, or a destination set
  earlier in the turn, can still send the round's text through the live
  outgoing stream as it is written.
- Explicit prose routing no longer streams unprefixed text to the trigger
  channel. The MCPL outgoing stream (`channels/outgoing/chunk` and
  `complete`) started with the trigger channel as its destination, so a
  streaming-capable server there received text that delivery would bounce.
  It now starts with no destination on a fresh turn, since explicit text has
  none until a `>>` prefix names one. When a tool-result-guard retry or a
  budget restart resumes the turn, it starts at the destination the turn's
  delivered rounds have set, decided at each round's end, so a private
  round's prefix doesn't count. The stream also reads a `>>` prefix after
  any leading whitespace, and ends its target at any whitespace, as delivery
  does, rather than streaming such a line as text or dropping it. The stream
  parses each round's text from the start of a line, as delivery parses each
  round on its own: a round that began with a `>>` prefix streamed it as
  text to the previous round's destination. A round's later text block
  starts a new line, as delivery joins a round's text blocks with a newline.
  At each round's end, and when the membrane retries a refused attempt, the
  stream returns to the turn's destination, so a private round's prefix, a
  `>>skip_reply` envelope or a target that didn't resolve no longer moves
  where later rounds stream.
- A turn resumed by a tool-result-guard retry or a budget restart now queues
  its prose deliveries behind the turn's earlier ones, in every mode, so the
  turn delivers in the order it wrote. Before, a resumed reply could be
  delivered ahead of an earlier round's queued envelope, to the destination
  that envelope was about to change. In explicit mode, a round's `>>`
  targets are resolved once, when the round ends, and its queued delivery
  posts to those channels.

- A debounced (batched) gate wake that contains an addressed message —
  mention, reply, or DM — now routes the turn's plain speech to that
  message's channel, the same rule the direct wake path already applies.
  Previously a batched wake carried no channel and fell back to the
  process-global most-recent-inbound channel, so ambient traffic elsewhere
  in the debounce window (or before a DM, which never updates that
  fallback) received the reply. Push events are mapped to their registered
  composite channel id via a new `EventGate` option `resolveRouteChannel`
  (the framework supplies it); batched-wake lines now show that id instead
  of the adapter's raw one. Ambient-only batches keep the legacy fallback.
- When a batch holds several addressed wakes, the newest addressed EVENT now
  decides the turn's channel, not the most recently queued request. A gate
  wake flushed after a busy turn no longer outranks a newer mention's direct
  wake. A conversation fork takes a batched wake's route only for its home
  channel, so a fork bound elsewhere shows no typing in the addressed
  channel. An addressed wake with no author no longer borrows another
  request's author for its turn telemetry.

- `code_execution` time limits now stop blocking code (`time.sleep()`, a busy
  loop, a blocking read) at the limit (#235). The deadline's cancel reached a
  script only at an `await`, so blocking code ran on until it returned (and
  read as a success) or was killed 10s later, losing its output and the
  interpreter's variables. The host now also sends the interpreter SIGINT,
  repeated until the script reports. In the script's own code the runtime
  raises it as `KeyboardInterrupt`; a script waiting on an `await` is
  cancelled straight away, without waiting for the cancel op. The result keeps the output so far, shows the line the
  script was stopped at, and says it reached its time limit, and variables
  survive. The kill remains for code that ignores the interrupt (a long call
  inside C code, code that swallows `KeyboardInterrupt`, blocking code in a
  task the script started), and its message now names the time limit and the
  lost variables. `PyRunner` takes `cancelGraceMs` for the time between the
  two. Windows keeps the previous behavior.

- A `code_execution` script no longer receives another script's tool result.
  Inner-call ids restart in every interpreter, and a result was delivered to
  whichever interpreter was current when it arrived: after a script was
  aborted, killed at its time limit, or crashed mid-call, the late result of
  its call could resolve the first call of the next script, which then went
  on with the wrong data. Results and wake acknowledgements now go only to
  the interpreter that asked; one whose interpreter is gone is dropped and
  logged.

- A tool call that ends the turn, made by a `code_execution` script that was
  stopped before the call finished, no longer ends the turn of the agent's
  next script. The deferred end-turn request was kept per agent; it now marks
  only the foreground script that made the call. Background scripts' requests
  no longer reach a foreground script running alongside them.

- A tool result the guard withholds now says where its original is. The
  guard's notice ("Tool result withheld by the guard. The tool has already
  executed.") is followed by the original's place: a workspace file under the
  first writable mount's `tool-results/` (named
  `<date>-withheld-<batch>-<index>-<toolUseId>`, one per result, with any
  character outside `A-Za-z0-9._-` replaced and the name cut to 80
  characters, so a long tool use id is cut), or, with no writable workspace
  or a failed write, the guard's audit record (`framework/tool-result-guard`),
  for an operator. The place holds the result as stored, which is its text:
  for a result over the inline cap, its capped text, whose own note names the
  file with the whole output. A failed write's own error stays in the audit
  record and the logs; the audit record also says when no file was written or
  a write threw. When saving the audit record itself
  had failed as the result arrived, the stub says so rather than that the
  original is kept there. This holds for every withheld settlement: a refusal,
  an aborted stream, a batch that was never submitted, and one whose audit sync
  failed. The notice still names no refusal and no category. Before this, a
  withheld result left only the notice, so the agent couldn't tell what the
  tool had done (agent-framework #277). The file is an ordinary workspace
  file: the agent can read it back deliberately, and so can whoever else reads
  the mount, such as another agent sharing it or a synced copy.
- How the stub is written. Where each original went is queued first, as an
  audit record of its own, and the stub's edit is then made at once. If it
  fails, it is retried before the next activation, compile of a request that
  is sent, maintenance pass or stop, including for an ephemeral run or a
  closed fork that has left the agent map, and the batch stays held out of
  summaries until it lands. Until then, or if the store keeps failing or the
  process stops first, the stub is the bare notice, and the `annotated` audit
  record describes the spill's outcome when the annotation finishes, with `unfinished` for a write still running. That record is not revised when the write later settles. A file whose copy on disk fails
  is still in the workspace's tree, where its tools read it, so the stub names
  it; for this, `WorkspaceModule.writeBinary`'s result for that case carries
  `data: { inChronicle: true }`, including when a post-commit operation throws. Inline truncation notes also name that readable tree file, and the disk-copy failure is logged and traced. Each batch has one 30-second deadline for all its withheld writes. A write still under way then is named as unfinished, with the audit record as the fallback. The guard stops waiting for it there; the write goes on, and may finish or fail later. `stop()` still waits for the workspace's own turns, which such a write holds, bounded only by a teardown timeout passed to `stop()` (indefinitely without one, as since #248). Until it
  settles, no other withheld original is written, for this batch or a later
  one of any agent: their stubs name the audit record. Writes can start before the first deadline fires; those batches each use their own deadline. A write that never settles keeps new withheld spills disabled for the process lifetime. A deadline that fires names its file on stderr; a stall's skips are logged once, naming the first file, and counted when it clears; an exhausted batch's skips are logged once per batch. The inline cap's spills are outside this deadline. Requests sent by the framework and the direct Agent API are compiled only once each annotation started so far has finished,
  including one that began while the compile waited or ran, and the refusal
  retry; a conversation fork seeded from its template copies only stubs whose
  annotation has finished. A request preview doesn't wait, so rollback,
  undo and redo never wait on a workspace write, and a preview can show a stub
  before its place is added, as can public `compileContext()`. Stop lets running annotations finish while the
  workspace is up; one that starts after that writes no file and is saved
  before the store closes. A crash before a stub is written leaves the notice
  alone, and the staged audit record still holds the original. If the active
  branch changes while the originals are being written, no more are written:
  a write that has not set its tree entry is refused where it commits, and it and the rest are recorded as skipped for the branch change. A write whose tree entry was already set remains on that branch. While the store is away the
  stub stays as it was; if the branch is back by the edit, those results'
  stubs name the audit record. So no original's tree entry lands on another
  branch. For this, `WorkspaceModule.writeBinary` takes an optional `branch`:
  the file's tree entry lands on that branch or isn't written, and a refused
  write's result carries `data: { branchLeft: true }` (it isn't traced as a
  failed spill). A mount has one directory on disk for every branch, so with
  `autoMaterialize` a file's copy there, made after its tree entry, is there
  whichever branch is active, like any other write's. The audit records `annotated`
  (where each original went) and `stub_updated` (the stub's edit) carry the
  batch's `sourceBranch`. The direct Agent API's refusal retry is now
  compiled afresh, as the framework's is, so its longer stubs fit the budget.

- With `maintenanceIntervalMs: 0`, periodic retries of retained guards are disabled; stop still retries them. A failing audit record blocks later queued edits and their compression holds until its write succeeds. Shutdown reports an error if that retry still fails.
- A framework-driven turn that compiled across stop is discarded before driving its stream, with a line saying why, even if the framework has restarted. A `start()` after a finished `stop()` starts a new lifecycle, with the spill gate open again; a `start()` made while a `stop()` is still draining isn't a supported order. Direct Agent calls remain governed by their caller's abort signal; a refusal retry checks that signal again after waiting for annotations. The direct API reads its unguarded tool results once, after the first compile, and sends the same ones with the refusal retry.
- Concurrent starts on one Agent, a direct inference call beside a framework-driven turn, are not made safe by this change: an Agent compiles while its status still reads idle, as before, and the annotation wait lengthens that window by up to the batch's deadline. `abortInference()` returns false during a direct call's initial assembly.
- `save_recent_image` reports a tree-only write as saved, including its path, size, MIME type, `inChronicle` and `diskCopyError` (the failure after the tree entry, whichever it was). A later failure in a multi-image save, returned or thrown, includes that file among the already-saved paths. An RFC-005 reference fetched to such a file names it.

- MCPL tool lifecycle (RFC-007) now reports the tool calls a `code_execution`
  script makes, not just the script's own `code_execution` call. Each is
  reported like a model call, under the inner tool's own name and class, so
  grants, narrowing, filters and the `comms`/unclassed input exclusions apply
  to it as they would to the model calling that tool directly. It carries the
  inference that issued the `code_execution` call and, in
  `_meta["agent-framework/parentToolCallId"]`, that call's `toolCallId`. A
  stream's end does not abort these calls: one still running when its script
  is killed is reported `completed` or `failed` when it finishes.
- Two `code_execution` calls in one model response no longer hang the turn.
  The runner now claims itself before it waits for the interpreter, so the
  second call is refused with "already running" and the first runs normally.
  Before, both got through: the second was refused by the interpreter, the
  first script's result was dropped, and its tool call never answered.

- **`materialize` no longer silently overwrites disk files changed by another writer** (#109). A file disk changed since it last agreed with the workspace is refused and listed in the result (`skipped`, with the remedy) instead of silently reverted. So is a disk copy that exists but can't be read (e.g. a write-only file), with the filesystem error in the reason, rather than treated as absent. `force: true` remains the deliberate override. A refused workspace edit stays owed: every later materialize takes it up again, and it counts in `status.pendingChanges`. A file the workspace hasn't changed, whose disk copy changed, isn't owed: a materialize naming it refuses it, and one without a path leaves it, for a `sync` of the path (take disk) or a `materialize` naming it with `force` (take the workspace). What disk last agreed with is kept as evidence that survives restarts and branch switches (see the truthful-listings entry), and a `sync` that takes a disk copy records that agreement, so the agent's next edit to that file isn't refused. A first materialize that finds every file already in place still pins the branch, and a file whose disk copy already matches the target bytes is left untouched (mtime preserved). The post-undo/redo `_config` restore keeps its overwrite semantics.

- Visibly-empty MCPL content no longer causes uncaused wakes (#235). Content with no non-text block and no non-whitespace text was stored and woke the agent, but the request sanitizer stripped it, so the model woke to `[Continue]` or to an older message re-presented as the newest. `push/event` now rejects such content with `-32602` (`data.field: "payload.content"`), and `channels/incoming` rejects the message with `reason: "empty_content"`; both log `reason=empty-content`. Exemptions: an RFC-006 retraction, which may be empty (an empty or blank-text notice appends nothing), and the exact silent-heartbeat marker (#216), now one shared predicate. Empty deferred fallbacks are rejected because a fallback must be self-contained. A blank-text render counts as "nothing happened", and a turn whose only causes were deferred batches that rendered nothing (empty, blank, cancelled or revoked) is not started. `PushCoalescer.assemble()` now reports which subjects settled and which materialized content. Rejections are typed `TraceEvent` members (`mcpl:push-event-rejected`, `mcpl:channel-incoming-rejected`). The store/wake site drops empty push and channel events from modules or the coalescer: no row, no wake, and an `mcpl:empty-content-dropped` trace.
  **MCPL server authors:** to wake the agent, send content it can see. An empty push from any server other than the exact silent-heartbeat marker now gets an error.

- Preserve unbounded module and MCPL shutdown by default and allow explicit wait budgets. Retain failed or pending cleanup for retry, run final storage repair and sync best-effort, and keep storage open until teardown succeeds. Reuse in-flight cleanup and make successful shutdown idempotent until a new borrowed-store lifecycle begins. Preserve final storage errors, including Chronicle close failures that consume the handle, and expose timeout diagnostics to hosts.

- Silent heartbeat ticks no longer merge into the previous assistant message
  on the wire. Every row a tick's turn stores (assistant responses,
  tool_result rows) now carries
  `metadata.silentHeartbeat: { eventId, serverId, agentName }`, and request
  builds render a request-only `[heartbeat tick]` user turn immediately
  before the first of the tick's rows that survives compilation (the agent's
  own opening request for a tick ends on that same turn instead of
  `[Continue]`). Nothing new is stored, and the separator's position follows
  from the stamped rows alone, so it is identical on every compile and keeps
  the cached prefix stable. Rows are recognised by tool_use ids and thinking
  signatures only: an unsigned, tool-free tick reply still merges as before
  (no signed thinking, so no provider rejection). Previously back-to-back
  ticks, or a tick after a reply that left no delivery receipt, were sent as
  one assistant message carrying signed thinking from two responses.

- **Late tool results, and MCPL requests and notifications, at `stop()` no
  longer end in an unhandled rejection.** `stop()` closes the process queue
  before it closes MCPL connections, and nothing caught the "Queue is
  closed" that this meant for late arrivals. Test files that stop a
  framework while a tool still runs, such as `conversation-routing`, failed
  at file level with it.
  - A tool's result that arrives after `stop()` is logged and dropped: the
    queue that would carry it to its stream is closed, and the tool has
    already run. Before, its push threw, the throw was reported as the
    tool's own failure, and that failure's push threw again, unhandled.
  - tune-out's results now go through the same `pushEvent` as every other
    tool's, so they also emit `process:received`, and a rejection of its
    handler is answered with a failed result, as other tools' dispatch
    failures are, instead of being left unhandled.
  - The drop's log line names the tool and whether it succeeded, which is
    what decides whether anything needs reconciling (the resident may run
    the tool again). For this, the framework's tool results carry the tool's
    name (`ToolResultEvent.toolName`, optional).
  - A server's `push/event`, `channels/incoming`, `channels/register`,
    `channels/changed`, `inference/request` or `host/command` that arrives
    once the host is stopping is refused before its handler runs, with a
    JSON-RPC error (`-32000`, "the host is stopping", the code the push
    coalescer already gives a stopping host). It is never answered
    "accepted", no inference starts, and no host command runs.
  - A handler that throws is answered with an error too: while the host
    stops, `-32000` with the handler's own message after "the host stopped
    while handling this request"; on a live host, `-32603` with its message.
    The message is bounded, and any thrown value is printed safely. Part of
    the request may already have been admitted. A notification is logged.
  - **For operators:** such a handler fault used to be an unhandled
    rejection, which ends a Node process by default, so a supervisor would
    have restarted the host. Now the host stays up and logs the failure.
  - A request is answered at most once. A second answer, such as a
    handler's late one after its failure was answered, is refused and
    logged. An answer that throws, such as a result the connection can't
    serialize, doesn't count, so the request still gets the error answer.
  - Any other event pushed to a stopped framework still throws to its
    caller.

- In explicit mode, a turn that a tool ends, such as with `skip_reply`, no
  longer leaves the prose it queued to run under the next turn's routing
  state. Such a turn settles before its earlier rounds' queued deliveries
  have posted, and in explicit mode the next turn can start at once. That
  start cleared the sticky destination those deliveries read when they
  post, so a queued unprefixed segment bounced into the next turn. Each
  turn now has its own routing state (the sticky destination, the turn's
  destination, hybrid's hold) and its logical turn's ` !` continuation and
  receipt tallies (the destinations and suppressed segments its receipt
  reports), and a queued delivery keeps the one of the turn that queued
  it. In hybrid and
  locus mode the ended turn already keeps the next one waiting until its
  receipt is written, as before.
- The agent's prose deliveries go out in the order they were written,
  across turns: every stream queues its deliveries behind the agent's
  earlier ones, a fresh turn's included (apart from a stream that a later
  one replaced). A turn's reply, and its completion, can therefore wait for
  an earlier turn's posts: up to their request timeouts, one after another,
  or for good when `requestTimeoutMs` is 0 and a post is never answered.
- In explicit and hybrid mode, a ` !` continuation that an earlier round
  asked for now starts when a tool ends the turn, once that turn's
  deliveries have run, unless the framework has stopped or the agent has
  been disposed by then (a dropped one is logged). In explicit mode a turn
  that another event started meanwhile runs first. Before, hybrid mode
  started it only after the next turn, and explicit mode dropped it, or,
  when its delivery ran late, started it after the next turn.
- A logical turn now stays open from the start that opens it until the turn
  settles (it completes, a tool ends it, or it fails or is abandoned), and
  every start that routes prose while it is open continues it: a framework
  retry, the start that consumes unstreamed tool results (whichever wake
  the scheduler starts it with), the later start a provider-capacity hold
  defers a turn to. Each begins the sticky destination and hybrid's hold
  afresh, as before, but a ` !` asked for earlier in the turn still stands,
  in explicit mode too, and in hybrid and locus mode the receipt at the
  turn's end reports every stream's deliveries, including ones that land
  after a new stream began. Before, explicit mode dropped that ` !`, and the
  receipt counted only the deliveries that landed after the new start.
- A turn that completes now waits for its queued deliveries before its
  receipt and its continuation check, in every mode, whatever its last
  response. Before, only a completion with final text waited, so in hybrid
  and locus mode a stream whose last response was empty (a budget
  restart's, say) wrote its receipt first: those deliveries were never
  receipted, or were counted in the next turn's receipt. A ` !` they carried
  was missed too.

- **Workspace listings tell the truth about disk, and no scan discards a workspace edit.** `ls`,
  `glob` and `grep` check their scope against disk before answering, under one rule over disk, the
  workspace store and what disk last agreed with. Files created by a shell show up, including
  binary and oversize ones, listed as `disk-only` with their size and, for images, their type.
  A file deleted by a shell leaves the workspace on every scan path (a watcher event, `sync`, a
  listing, the scan after a restart, and a watcher reattach) where the workspace held what disk
  last agreed with; a workspace edit of it stays, as a `deleted-on-disk` conflict. Each file entry
  carries a state:
  `synced`, `workspace-draft`, `workspace-deleted`, `not-in-branch`, `disk-only`, `conflict` (with
  its kind) or `disk-missing-provenance-unknown`. Where disk couldn't be checked, the state is
  `unverified`, and `incomplete` names the unreadable, ignored or capped regions. A pending
  workspace edit is never overwritten by a scan, a watcher event or a lazy read. When disk and
  the workspace both changed, the path becomes a conflict that stays until a `sync` of that path
  (take disk), a forced `materialize` (take the workspace) or convergence. A text disk version is
  kept in the store; a binary or oversize one is referenced, and the listing says if it changed
  since. `grep` labels a kept disk version `recorded-disk` once disk has changed since, and lists
  a conflict's disk side it couldn't search as skipped. A `sync` of a path lists under
  `discarded` each workspace change it gave up for disk's state.
- **A mount root that isn't the directory disk last agreed with is unavailable, not empty.** The
  workspace records the root's identity (its device and inode) with the first evidence it
  gathers there. When the drive under a read-write mount is unmounted, the watcher recreates its
  mountpoint as an empty directory; that root is listed as unavailable (`incomplete`, saying what
  to do), so no scan reads its emptiness as every file deleted, and no `materialize`, forced or
  not, writes into it. When the drive comes back at the same path, the mount is available again;
  one that comes back elsewhere leaves it unavailable until it is back at that path. If the
  directory was replaced on purpose, or a drive came back under a new device number, `sync` with
  `acceptRoot: true` takes the root as it is now: what was recorded about the old one is set
  aside, and every file is compared afresh.
- **A workspace deletion stays deleted, and materialize never deletes from disk unasked.** Without
  `autoMaterialize`, a deleted file's disk copy, unchanged since disk last agreed with the
  workspace, is listed as `workspace-deleted`, and no scan or lazy read brings that copy back; a
  copy changed on disk since is a conflict. `materialize` lists the deletions it left on disk;
  `applyDeletions: true` removes those whose disk copy is still one the workspace held, and
  `force` too removes those changed since. A `sync` of the path takes disk's copy back into the
  workspace when it's one the workspace can hold (text within the size limit). Once the deletion
  is confirmed on disk, a file that later appears at the path is a new file, adopted like any
  other.
  `autoMaterialize` writes and deletes follow materialize's freshness rule: a disk copy changed
  by another writer since it last agreed is refused, not overwritten or unlinked.
- **A `materialize` without a path takes up only what disk still owes:** workspace edits,
  entries never checked against disk, conflicts and workspace deletions. It no longer depends on
  the sequence the mount was last materialized at (`status.lastMaterializedSeq`), which is saved
  only at a clean stop: after a restart that lost it, a bare `materialize` took up the whole tree.
  A file the workspace hasn't changed is left as disk has it, with or without `force`, unless its
  path is given. A path the evidence says nothing about is treated the same way. Where disk holds
  a different copy (`unknown-provenance`, or `store-origin-collision` for a file the workspace
  created), only a `materialize` that names the path with `force` overwrites it. Where an entry
  from before the evidence has no disk copy, only one that names the path writes it, and a `sync`
  of the path drops it from the workspace instead. A bare `materialize` trusts the evidence: if
  disk was replaced behind the workspace, a `sync` takes disk's copies, and naming the paths with
  `force` writes the workspace's. `status.pendingChanges` counts what disk owes by the evidence;
  an entry never checked against disk isn't counted until a listing or a `materialize` checks it.
- **Undo and branch switches are not mistaken for disk edits.** What disk last agreed with is kept
  in global chronicle records rather than branch state, so selecting an earlier state keeps that
  state as a draft over the later disk version, and a file present only in another branch's
  history is listed `not-in-branch`, never ingested or unlinked. Each write or unlink a
  materialize makes, and each adoption that ingests a disk change or removes a file, is recorded
  as an intent ahead of it and completed once it is durable, so a crash or a torn record tail
  never costs an edit. If an append of disk-agreement evidence fails inside Chronicle, the
  workspace refuses operations that need that evidence and reports why. Those operations remain
  unavailable until the host restarts and reloads the store's records. The append may have
  reached the log without becoming readable in this process, so deciding a conflict from
  possibly incomplete evidence would be unsafe. A binary or oversize disk version, for which the workspace drops its copy,
  forgets the evidence first instead. After a crash, an interrupted write or unlink is decided by what disk shows (a copy
  matching neither the one before nor the one intended is an `interrupted` conflict), and one
  that shows on disk without proof it is durable is completed only by the next `materialize`,
  which redoes it; an interrupted adoption is settled by its own branch's tree. This replaces
  #109's stop-time baselines and refused paths,
  which an abrupt exit or a branch switch could lose or rewind. A store that saved them doesn't
  import them, since they name no root: its first pass records each file disk agrees with, and
  lists any other as a conflict or of unknown provenance.
- **`watch: 'on-agent-action'` works as documented:** after each completed tool batch, before
  anything continues the agent's turn, the mount is scanned. A scan that outlasts
  `agentActionScanDeadlineMs` stops holding the round and continues in the background; the miss
  is reported on `status` (`lastAgentActionScan`) and as a `workspace:agent-action-scan-incomplete`
  event, as are the regions a finished scan couldn't observe (`incomplete`). Batches that come
  while a scan waits share it, and while a scan that outlasted its deadline still runs, a later
  batch isn't held: its miss is recorded at once, and its scan comes after. The hold is in the
  framework's event loop, so while it lasts every agent's events wait.
- Disk text is stored as its raw bytes rather than through a UTF-8 round trip, so a file in
  another encoding no longer differs from its own stored copy.
- `status` with `mount` reports that mount alone, and refuses one that doesn't exist. A
  `materialize` that names a read-only mount lists it under `skipped`, rather than answering as
  if nothing was owed there.
- `materialize` and `autoMaterialize` check each write and unlink where it happens, not only when
  it is planned. A file is opened in its directory without truncating and located before any
  byte changes: never through a symlink the mount doesn't follow, or a directory that resolves
  outside the mount, and never into a file with other hard links, whose other names (a package
  store's, say) a write in place would change too, even with `force`. Unless `force`, it must
  also still hold what the materialize decided on, so a disk edit or a new file that appears
  meanwhile is refused, not overwritten. Refused paths are listed as skipped with the reason.
  Where the platform can sync a directory (not Windows, nor a filesystem that refuses it), every
  directory from a written file up to the mount root is synced before the write counts as done,
  directories it had to create included. Listings likewise accept a directory's contents only
  while it is still the directory at its path, and a scan, write or unlink accepts what it found
  only while the mount root is still the one it began under: a scan that finds the root replaced
  when it looks again treats what it observed as unverified, and reports the root. Each check is made where the operation happens,
  against what is there at that moment. Node has no `openat`, so a parent directory replaced
  concurrently in the window between a check and a create, `mkdir`, unlink or listing can still
  redirect that one operation: an empty file or directory can appear outside the mount, or a
  same-named file there can be unlinked. Nor can a write or an unlink be bound to the moment of
  its last check: an edit to the open file between the last look and the truncate can be
  overwritten, and a file put at the path, or an edit made to it, between the last look and the
  unlink can be removed. Content writes stay bound to the
  descriptor verified, inside the mount and with no other hard links, before modification; a
  hard link made to the file after that check shares the write.

## 0.21.1 — 2026-10-13

### Changed

- Depends on `@animalabs/context-manager` `^0.14.0` (was `^0.13.0`). Under
  `foldingStrategy: 'kv-unified'` the strategy no longer persists its
  presentation receipt as one entry per message on every accepted call: the
  receipt is stored run-length encoded, so a Chronicle `records.log` no longer
  grows quadratically with session length (context-manager#148). Stores written
  under 0.13.x still load. Patch release from the v0.21.0 tag with this
  dependency bump only; the work on `main` since 0.21.0 is not included.
  - **Operators of stores that learned an estimator calibration under
    context-manager 0.13 or earlier** (added after the release): 0.14.0 stamps
    its persisted calibration multiplier with the pricing it was learned under.
    An unstamped multiplier is kept and re-stamped, unless the store holds
    XML-history carriers, in which case it restarts from 1.0 and the value it
    discarded is kept as `reset.discardedMultiplier` in the calibration state
    (shown in `RenderStats.calibration`). Two kinds of store can then refuse
    every compile with `OverBudgetError` before inference. One holds no
    carriers and kept a multiplier last learned before its host moved to
    context-manager 0.11.0. Its record can't show that; the host's own
    history can, in its lockfile's or its deployments' history: a host that
    went from a context-manager older than 0.11.0 straight to 0.14.0 can
    hold one. The other holds carriers and had learned a multiplier
    below 1, which its `reset.discardedMultiplier` shows. With the host
    stopped, reset the first kind's multiplier once, and re-stamp the second
    kind's checked value, as the **Operators** entry of context-manager
    0.14.0's changelog describes. The reset is for a store that already
    opened on 0.14.0 and ran a committing compile, which re-stamped its
    multiplier: `^0.14.0` now installs 0.14.1, which keeps a still-unstamped
    multiplier provisional and replaces or drops it on its own.
  - **What else hosts meet with context-manager 0.14.0** (added after the
    release): a preview, or any compile made with `dryRun`, leaves the context
    manager's estimate, its calibration and a pending kv-unified draft's marker
    indices as it found them. The context manager's state queries (`isReady`,
    `getPendingWork`, `getHotContextSettings`, `previewContext` and others)
    throw while its strategy's initialization is pending or has failed, where
    they used to answer. A reposted sharded document renders as two bodies, so
    a stored conversation holding one misses the prompt cache once after the
    upgrade.

## 0.21.0 — 2026-10-03

### Breaking

- **Direct ConversationRouter callers:** `route()` is now a pure query and no longer refreshes idle activity (#46). After successfully delivering a message to the bound fork, call `touch(channelId)`; deterministic clocks move from `route({ now })` to `touch(channelId, now)`. Framework-managed delivery performs this step automatically, including ambient messages and coalesced fixed-audience delivery to the current binding. Queries, failed writes, and delivery to an older engagement leave the current binding's clock unchanged. Bind rules, trigger rules, generation counters, and fork names are unchanged. No store migration or sibling dependency upgrade is required.

### Changed

- Depend on `@animalabs/context-manager` ^0.13.0: optional compression-hold timeouts, branch-ID cache keys, Bedrock summarizer recognition, tool pairing before pruning in both renderers, and fuller refusal diagnostics.

### Fixed

- Stdio MCPL children inherit `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, and uppercase/lowercase `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` so Python/curl CA trust and proxy-based egress survive the child environment allowlist (#191). Declared server `env` still overrides host values, including differently cased keys and empty values on Windows; POSIX names stay case-sensitive. Duplicate Windows spellings within one source use Node's first lexicographic spelling before declared values override host values. Proxy URLs can carry credentials; the allowlist limits accidental inheritance rather than isolating a hostile child.

- RFC-005 references now drop overlong optional `name`, `mimeType`, and `expiresAt` fields instead of retaining truncated testimony. Their schema limits count Unicode code points. Reference blocks and subtractive disposition remain valid; admitted display labels retain independent sanitization and truncation.

- `tools/observe` rejects explicit null params and non-object `_meta` before changing the existing filter. Omitted params and `rules: null` still clear the filter. Pattern and field-path limits count Unicode code points, matching the RFC-007 schema and accepting valid 256-code-point astral strings; rule and path-count limits are unchanged.

## 0.20.0 — 2026-10-03

### Breaking

- **Operators of stdio MCPL servers:** children no longer inherit the whole
  host environment. They get a small allowlist (`PATH`, `HOME`, locale/`LC_*`,
  `TMPDIR`, TLS roots, …; see `CHILD_ENV_ALLOWLIST`) plus the server's own
  `env`, so one server's credentials (provider API keys, other bots' tokens)
  are no longer readable by another. A server that relied on an inherited
  variable must declare it in its `env` (recipes can `${VAR}`-substitute), or
  set `inheritEnv: true` to restore full inheritance.

- **Resident scripts parsing history `extract`:** without a `channelId`,
  `extract` no longer returns `matchedCount` (a time-only native query only
  ever reported the page size there, not a total). It returns `hasMore`
  instead; channel-scoped `extract` keeps its exact `matchedCount`.

### Added

- `code_execution` takes an optional per-call `time_limit_ms`: the time limit for
  that script, the way Claude Code's Bash tool takes a per-call timeout. It
  defaults to `codeExecution.scriptTimeoutMs` (10 min) and may go up to the new
  `codeExecution.maxScriptTimeoutMs`, which defaults to the same value, so
  agents can only shorten the limit until a deployment raises the ceiling.
  Longer requests are capped and the result says so (`time_limit_note`). For a
  background script it shortens the lifetime, capped at
  `backgroundMaxLifetimeMs`. The tool description now states the limit, and a
  script stopped at its limit says so instead of only "cancelled by host".

- MCPL tool lifecycle (mcpl RFC-007): servers granted `toolLifecycle.observe`
  receive `tools/lifecycle` notifications for the agent's calls to OTHER
  servers' tools and to host tools — `started`, then exactly one of
  `completed` (with `isError`) / `failed` / `aborted`, paired by a host-unique
  `toolCallId`. Metadata only by default; tool results are never sent.
  - `toolLifecycle.inputs` adds the call's arguments, but only the fields a
    server asks for with `tools/observe`, bounded (16 KiB default,
    `toolLifecycle.maxInputBytes`), and never for `comms` or unclassed tools.
  - `tools/observe` (server → host request) sets an ordered first-match
    filter on which calls are reported and which argument fields are sent;
    it only narrows what the grant allows.
  - Both paths are denied by default. Grant them with a
    `McplServerConfig.toolLifecycle` policy block (`observe`, `inputs` with a
    `tools`/`classes`/`conversations` narrowing; `classes: 'default'` admits
    computer, shell, files, web, media and body) or via `enabledCapabilities`.
    `inputs` with no tools/classes term delivers no arguments.
  - `listMcplServers()` shows each connection's current filter.
- MCPL tool classes (mcpl RFC-008): a tool's class is read from
  `_meta["mcpl/class"]` on its MCP definition, from the framework's table of
  its own tools, or from `FrameworkConfig.toolClassOverrides` /
  `hostToolClasses`. Classes are policy hints only: they never change what
  the model sees.

- History tools, from a resident's diary-work feedback: `search` and `extract`
  take `author` / `excludeAuthor` (exact, case-insensitive match on
  `metadata.author` name or id; messages without author metadata, such as
  the agent's own turns, match on their stored participant). Results now carry `author`.
  `extract({aroundId, before, after})` returns the conversation around a
  message id from `search` (its own channel by default, `allChannels` to
  interleave). `search` adds `wholeWord` (Unicode-aware) and
  `order: "newest"`, and when it stops early (at `limit` or `maxScan`) it
  reports `scannedThrough` and `resume: {from|to, skipSequences}` to repeat
  the call with (`skipSequences` names the messages at that exact instant
  already scanned by sequence range, so a message added or removed there
  between calls is neither lost nor shifts the skip). `search` rejects
  `maxScan: 0`.
  An author-filtered `extract` that stops early returns
  `resume: {windowOffset, offset, afterId}` to repeat the call with (position,
  not timestamp, so late-appended backfill in a channel is not skipped). On
  resume, `afterId` pins the position: if messages were removed or inserted
  before it since the previous call, the scan re-anchors and reports
  `windowChanged: {shift}`; if the anchor itself is gone, it fails loudly
  instead of silently skipping. Without a channel (a time-ordered window) the
  resume also carries `seqMark`, and messages appended since then that landed
  behind the cursor are reported in `windowChanged.missedIds` even when a
  removal balanced them out (shift 0). Unrelated appends don't count; past
  200,000 appends since the mark the check is reported as
  `windowChanged.unverified` instead of failing. A resumed call reports
  `matchedSinceWindowOffset` rather than a total.
  `aroundId` also accepts a `semantic_search` `msg:<id>` hit id.

- `HistoryModule` gains an optional `semantic_search` tool: meaning-based search
  over the agent's raw messages (text plus its own think/journal/skip_reply
  notes) and every compression summary, backed by a shared remote
  embed-service whose vector index lives server-side, one namespace per store
  (`new HistoryModule({ semantic: { url, token, namespace } })`). The module
  keeps the index in sync itself — a background tick every 60 s and a bounded
  catch-up before each search, messages watermarked by timestamp with an
  overlap re-scan and summaries by `createdMs` — and backs off cleanly when
  the service is unreachable, so the other four history tools are unaffected.

- Operators can see each tool's effective MCPL class (RFC-008 §6):
  `listMcplServers()` entries gain `toolClasses` (every tool of that server,
  with its class and whether it came from an operator override, the
  server's own `_meta["mcpl/class"]`, or nowhere — unclassed), and the new
  `listToolClasses()` lists every tool the framework offers, host built-ins
  and agent-only tools (the subconscious's, `prose_help`) included, with
  the same source and the MCPL server where there is one.
  `listToolClasses(agentName)` lists exactly what that agent is shown.

- MCPL event coalescing (RFC-006, mcpl PR #5 revision 7): `coalesce` on `push/event` and `channels/incoming` — replace-if-unread, atomic retraction with a conditional deletion notice, `initial` birth marker, deferred batches rendered through `push/render` at assembly, channel-scoped pushes delivered as messages of their channel. Content stays in context; "unread" is above the agent's consumed watermark and not folded by compression. Advertised as `eventCoalescing` with a one-hour retry window.

- Silent heartbeat wakes: an authenticated empty push from the `heartbeat` MCPL server can start one private inference without adding a Chronicle message, resolving or announcing a publication locus, starting typing, or routing automatic prose. The tick carries a bounded ephemeral self-check prompt; explicit tools remain available, and context-budget restarts preserve the silent-turn contract.

- Add the opt-in, durable `agent_settings.tool_result_guard` setting
  (programmatic `AgentConfig.toolResultGuard`; hosts must forward it from
  recipes). On a provider refusal after tool output, withhold the
  latest result batch and retry inference once without rerunning tools or
  automatically rewinding older messages. Full originals remain in an
  append-only Chronicle audit log (synced before submission); pending output
  stays out of speculative compression and the placeholder is held from
  compression until settled (requires context-manager ^0.12.0), guard effects apply only to a batch
  actually submitted in the current turn, and disabling the guard does not restore withheld results.
- Recover from failed staging/link audit appends and accepted-result history
  edits without stranding streams or compression holds. Retry storage work
  before activation, during maintenance, and at shutdown; preserve later
  operator edits and branch changes. End-turn output remains withheld when
  its audit was not made durable.

### Fixed

- The closed-channel invitation's "reply without joining" prefix is now always one
  whitespace-free token that resolves back to the channel on the server the message came
  from (`@name` for a DM, else `#label`, `#name` without the server suffix, or the channel
  id), from the new `ChannelRegistry.proseTargetFor(channelId, serverId)`. It used to quote
  the label verbatim, and the prefix grammar reads the target as the first non-whitespace
  run: a DM labelled `DM: alice` gave `>>#DM: alice` (target `#DM:`, body `alice …`, so the
  reply bounced and the retained text went out with a stray `alice` line), and a suffixed
  label like `#fable (antra's server)` delivered `(antra's server)` as text. When no token is
  safe (the channel id is registered by more than one server, or every option contains
  whitespace) the invitation offers no prefix and points to joining the channel instead.

- MCPL tool calls under nested tool prefixes (one server's prefix `foo`,
  another's `foo--bar`) went to whichever prefix was registered first. A
  call now goes to the server whose `tools/list` produced the name; a name
  no live server listed goes to the longest matching prefix.
  `listMcplServers()` counts and lists each tool under that one server.

## 0.19.0 — 2026-09-28

### Added

- `journal({content})` — a synthesized private note-taking tool beside `think`
  and `skip_reply`. The entry stays in the agent's own context and is sent
  nowhere; it does not end the turn and does not affect prose routing. It exists
  because long prose kept in `skip_reply.reason` (or `think.content`) makes
  replayed history read as a reasoning trace, and every memory-compression
  request over it is refused `reasoning_extraction` regardless of content,
  while the same prose in a note-taking tool passes. Context-manager's
  `compressionToolProseFallback` rung rewrites old history into calls to this
  tool and mirrors its result wording.

### Changed

- `classifyInferenceError` matches context-manager's `OverBudgetError` /
  `UncoveredDropError` with a real cross-package `instanceof` now that CM
  exports them from its package root (context-manager#41/#71 — the follow-up
  promised there). The `err.name` comparison is kept as a fallback for
  deployments carrying two CM copies, and the message-prose match remains a
  last resort for serialized reasons; neither classification changes.

- `skip_reply.reason` is now described as ONE short line (under ~100
  characters), pointing at `journal()` for anything longer. Description only —
  no length is enforced and existing calls behave exactly as before.

### Fixed

- `channels/changed` is answered before the host reconciles the added
  channels, as `channels/register` already was (#160). Reconciling sends
  `channels/open` or `channels/close` back to the server, and a server that
  announced from inside a request it was serving (a tool that refreshes or
  subscribes) could not read them until its announcement was answered, so
  both sides waited until one timed out. In zulip-mcp this left streams the
  bot joined after startup as `Unknown channel` until a restart.

## 0.18.0 — 2026-09-25

### Changed

- Depend on `@animalabs/context-manager` `^0.11.0`: the kv-unified solver no longer
  grows its label set with the forest once a cache is relevant (#105), solves are
  packed and selectively rescored (#110), and signed thinking blocks are priced by
  signature (#113, the store-side half of #170).

### Fixed

- Signed `thinking` / `redacted_thinking` blocks are stamped with a `tokenEstimate` when persisted: this call's `usage.output_tokens` minus the visible blocks, split across carriers by signature length (per tool round, and on the trailing content at completion; cumulative membrane usage is diffed per call). On keep-all models the hidden chain of thought is replayed and billed as input on every later call, and context-manager's budget had no measure of it beyond a flat default — the compiled request ran ~1.5× over budget on long agentic histories, with dead `max_tokens` turns at the context ceiling.

## 0.17.0 — 2026-09-21

### Added

- `FrameworkConfig.providerHold(error, agentName)`: a host hook consulted on
  a failed inference, before the error policy. Returning `{ holdMs, reason }`
  parks the agent's provider admission the same way the built-in
  organization-acceleration cooldown does — no immediate retry, no
  `[inference-failed]` marker, no hard-down streak, arrivals held and merged
  into one later compile. Holds are served in slices of at most 10 minutes;
  when a slice expires the hook is asked again before any inference is
  attempted, so a long wait (a spent subscription quota window) costs no
  provider calls and an early reset is noticed within one slice.
  The hook is asked before the built-in acceleration classification, and
  receives `{ model }` for the failing agent. A failure in an auxiliary
  (compression) call arms the hold too, and such a hold releases without
  synthesising an inference. Ephemeral runs and conversation forks are not
  covered. `healthSnapshot()` reports `cooldownReason` and `hostHold`.

## 0.16.0 — 2026-09-18

### Added

- Host quiesce/maintenance mode (#122): `framework.quiesce()` drains
  in-flight turns (bounded, optional `abandon`), parks every subsequent wake
  (coalesced per agent+reason), pauses all MCPL data planes (control planes
  stay live), defers module/API context writes, and persists `hostMode` so a
  restart boots quiesced with a loud banner. `framework.resume()` gates on a
  fresh per-agent feasibility preview of the CURRENT settings (`force` to
  override; `ResumeBlockedError` carries per-agent verdicts), reopens data
  planes through the existing barrier funnel, flushes deferred writes and
  releases parked wakes. `framework.maintenanceTick()` runs one
  compression/maintenance pass on demand. Surfaces: `host/command` verbs
  `quiesce` / `resume` / `maintain` / `host-status`; WS `host.quiesce` /
  `host.resume` / `host.status` / `host.maintenanceTick`; HTTP `GET /hostmode`,
  `POST /quiesce|/resume|/maintenance/tick` (opt-in `ApiServerConfig.adminToken`,
  `x-admin-token` header always required on the POST verbs to force a CORS
  preflight). New traces `host:quiesce`, `host:resume`, `host:quiesced_boot`.
- Runtime-settings feasibility preview: `framework.previewAgentRuntimeSettings()`
  and `Agent.planRuntimeSettings()` expose the live→effective budget mapping;
  `updateAgentRuntimeSettings` preflights an immediate budget LOWERING and
  throws `BudgetPreflightError` when the folded floor cannot fit (paced
  descents, increases, no-op rewrites and boot restore are never blocked;
  `allowInfeasible` overrides).
- Review hardening of the above: `resume()` flushes deferred writes per
  message (a poison write cannot drop the rest or skip the data-plane
  reopen, which now runs in a `finally`); writes deferred while quiesced are
  persisted (`framework/deferred-writes` slot) and restored at a quiesced
  boot (`HostModeStatus.deferredWrites`); parked wakes coalesce per
  (reason, addressed) so a DM/mention parked earlier survives ambient
  traffic parked later; the `[1s, 10m]` drain clamp lives in `quiesce()` for
  every ingress; a `quiesce()` superseded by a concurrent `resume()` returns
  without abandoning anything; `resume()` waits for an in-flight maintenance
  pass instead of skipping the feasibility verdict; `abandon` reports turns
  it cannot cancel (`unabandonable`); `tool_results_ready` continuations pass
  the wake gate like budget restarts; `maintenanceTick()` returns `ran`;
  `nudge`/`unstick` replies carry `quiesced: true` while parked. ApiServer:
  WebSocket upgrades from foreign browser origins are refused
  (`ApiServerConfig.allowedOrigins`; same-host and non-browser clients pass),
  an empty `adminToken` is rejected at construction, `GET /hostmode` requires
  the token when one is configured, and `host-command` on the MCPL control
  plane means a surface `/undo` can now run ahead of pushes still buffered
  behind a startup/reconnect barrier.
- Review round 2: quiesce state and the deferred-write queue now live OUTSIDE
  branch history — `<storePath>/recovery/host-mode.json` and
  `recovery/deferred-writes.json` (`FrameworkConfig.hostModePath` /
  `deferredWritesPath`; the branch-local slot is only a fallback for
  store-only configs, with a warning) — so a historical rollback can no
  longer erase the marker of the surgery it belongs to or orphan the writes
  it deferred. A wake parked on provider admission behind an in-flight
  auxiliary call now rechecks quiesce when the auxiliary settles and is
  requeued instead of starting a turn; `HostModeStatus.parkedAdmissions`
  counts such wakes and `drained` is false while any exist. The resume flush
  acknowledges each deferred write durably as it lands and stamps its id into
  the stored message's metadata; boot recovers the queue regardless of the
  mode flag, skips ids that already landed, and the durable flag is cleared
  only after the flush completes — an interrupted resume neither loses nor
  duplicates a message.
- Review round 3: a flushed deferred write is removed from the durable
  recovery queue only AFTER `store.sync()` has made the appended chronicle
  slots durable (chronicle persists the slot-chain head on sync, not on
  append). Every deferred-drain path — resume flush, boot recovery, the
  turn-start / turn-end / puppet-end flushes — hands its batch to an
  un-acked set, writes, syncs, and only then rewrites the queue; a failed
  sync keeps the batch queued (retried at the next ack and at `stop()`).
  Regression coverage uses a real child process that `process.exit`s
  mid-resume, both right after the first acknowledgement and before the
  sync: the reopened host replays exactly the un-landed remainder.
- Review round 4: one durable id per logical deferred write across every
  hand-off. Every write that originates from the durable queue — the
  ordinary turn-start, mid-turn-injection, turn-end and puppet-end flushes,
  not only the resume flush — stamps `metadata.deferredWriteId`, and a
  re-deferral (target still busy or host still quiesced when a drained entry
  is written) moves the same entry back to pending under the same id
  instead of minting a second replayable one. Two more real child-process
  crash regressions: exit between an ordinary turn-start flush's sync and
  its queue rewrite, and exit at a re-deferral's recovery-file write.
- Review round 5: deferred-write entries carry a monotonic `seq` from first
  deferral; the durable queue is written, restored, drained and flushed in
  that order whatever the pending/un-acked split, so a re-deferred member
  of a batch keeps its place. Each hand-off persists a receipt of the
  target's store position before anything is written; boot dedup scans from
  that position to the tail (the whole store when a receipt predates it),
  never a fixed 2,000-message tail — a synced-but-unacked batch of any size
  is recognised in full. Recovery file/slot format is v2
  (`{pending, scanFrom}`); v1 is still read.

- `HistoryModule` gains a fourth tool, `overview`, for browsing conversation
  history when the caller doesn't already know a specific channel/date/search
  term: returns existing compression summaries as a table of contents (zero
  new LLM calls), falling back to raw message/channel counts for spans not
  yet summarized. `stats`/`extract`/`search`/`overview` now all accept a
  `channelId` as either a channel label (e.g. `#general`, `@name`, `<@id>`)
  or the raw internal channel id — resolved via a new durable
  `ChannelRegistry` label-history log, so a channel is still addressable by
  name even after the bot disconnects from it (the common case for browsing
  history on a quiet/old channel, where the live channel registry has
  nothing).

- Live operator surgery on the open store, no restart: `rollbackToMessage()`
  forks the chronicle at a message and switches to the fork (the source
  branch keeps everything after it); `suppressMessages()` forks at head,
  redacts the chosen messages on the fork (body-group shards always
  together), and switches. Both are the offline-recovery idiom made live and
  reuse the Discord awareness outbox (markers for messages that left the
  context; suppression batches activate only after the last redaction and
  finish at next boot if interrupted). Both refuse — never queue — while the
  agent is not idle (`OperatorActionError`, code `agent-busy`). The
  message-granular `host/command undo` now rides on `rollbackToMessage`
  (reads windowed, blob-free — no longer re-inflates every attachment on the
  branch). Its stderr line is now `[operator] rollback …` rather than
  `[host-command] undo-messages …`, and the reply carries the refusal `code`.
  Body groups are never bisected: a rollback target inside a sharded message
  snaps to the group's last shard (`tailMessageId` in the result), and a
  suppression removes the whole group as a range. The idle gate is the
  scheduler's own (`idle+turn-alive` counts as busy).
- `DiscordAwarenessOutbox.discard(batchId)` retires a prepared-but-never-
  activated batch. Live suppression uses it on every failure path so an
  orphaned explicit batch can no longer re-arm at boot and abort
  `AgentFramework.create()`.
- Durable operator log: `<storePath>/operator-actions.jsonl` (config
  `operatorLogPath`, `false` to disable) records who asked, from where, and
  why for every operator mutation — rollback, suppress, hide, undo/redo turn,
  unstick, nudge, runtime-settings update/reset/cancel — plus anything a host
  records through `recordOperatorAction()` (e.g. quiesce/resume). Each record
  is also broadcast as an `operator:action` trace; `getOperatorLog()` reads
  the tail. `undoLastTurn`/`redo`/settings methods accept an optional
  requester.

## 0.15.0 — 2026-09-17

### Added

- `HistoryModule` adds `stats`/`extract`/`search` tools for querying an
  agent's full uncompressed message history by time range and/or channel
  (#151), backed by context-manager's native chronicle secondary-index
  queries — O(log n + k) against multi-million-message stores, not a full
  scan. Read-only, `bind(contextManager)` after `AgentFramework.create()`.

### Fixed

- `puppetToolCall` reserves the agent against turn start for its whole
  duration (#145). The idle check was a point in time before two awaits
  (tool execution, result build); a wake arriving in either gap started a
  real turn, and the synthetic `tool_use`/`tool_result` pair then wrote
  straight into the window under that turn — the wire-order corruption the
  puppet exists to avoid. The puppet now holds the turn-alive marker the
  scheduler and the `addMessage` deferral guard already respect, and refuses
  when a turn is alive even if status reads idle. The one path that could
  still start a turn over the reservation — a wake parked on provider
  admission resuming after an auxiliary call — now re-tests turn-alive, gives
  admission back and requeues the wake for the scheduler instead.

- kv-unified: a new activation now closes any receipt flight its predecessor left unsettled before it submits its own. A provider attempt that died without a usage event (transport error, idle timeout, budget-restart or endTurn cancel) used to keep its flight open until the old stream's teardown, and every successor path started first — so the retry itself failed with `kv-unified submission … is still in flight` (devops agent, 2026-09-16).
- Inference-log records below the blob threshold are persisted through their JSON view; the kv-unified receipt hook on a compiled request (a function) made Chronicle reject the record with `JS functions cannot be represented as a serde_json::Value`, throwing from the failure path it was logging.

- Oversized tool-result spill files can now be read in bounded character
  ranges with `workspace--read` (`offsetChars`/`limitChars`). Spill notices
  include a read command sized for the inline cap and explain how to continue.
  This makes single-line JSON, large string values, and non-JSON long lines
  recoverable without rewriting the stored result or expanding it past the
  workspace file-size limit. Existing line-based reads keep their behavior.

## 0.14.0 — 2026-09-09

### Added

- Gate-batched wakes (`gate:debounce`) carry telemetry provenance: the
  EventGate hands the framework the newest addressed channel event (else the
  newest event naming a channel or author) as `counterparty`
  (`<serverId>:user:<id>`), `wakeChannelId` (composite channel id; push-event
  raw ids are not reported) and `wakeAt`, all from the same event, so the
  turn's `InferenceRequest` — and a host stamping gateway telemetry from it —
  can say who and where woke the agent. Telemetry only: the turn's speech
  locus (`channelId` / `addressed`) is not set by gate wakes, so routing is
  unchanged. `WakeProvenance` is exported.

### Fixed

- **`save_recent_image` can no longer save the wrong image** (#104). Tool-result
  images never reached the persisted window — history keeps a text placeholder
  and only the live wire copy carries bytes — so the recency scan walked past a
  snapshot the resident had just seen and quietly saved an OLDER attachment
  under the snapshot's filename (or reported "no images found"). Every
  tool-result image is now retained per agent at ingestion in a bounded
  in-memory ledger with provenance (tool call, block, MIME, size, SHA-256), and
  the history placeholder carries its handle:
  `[image: image/png, ~691KB, ref img_7]`. The tool walks one ordered inventory
  across attachments, tool images and image-typed RFC-005 reference stubs; when
  the image at the requested index cannot be produced (evicted, from an earlier
  process, a pre-retention placeholder, a quoted/forged placeholder whose ref
  belongs to another call, or a reference whose bytes live behind
  `fetch_reference`) it fails **at that index** and writes nothing — it never
  substitutes an older image. New `ref` argument saves by provenance; receipts
  report source, tool call, MIME, byte size and SHA-256.
  Second review round (#140) closed three more representations of the same
  failure: truncation/spill now re-appends every image slot that fell past the
  cut (the stored text is the only place the inventory finds tool images, and
  the wire delivered them regardless); a save dispatched in the same batch as
  the tool that produced the image waits for its siblings to settle (bounded,
  fail-closed) and classifies their results with the commit-path serializer;
  refs are namespaced per ledger (`img_k7x3q2_7`) so a placeholder from a
  previous process resolves to nothing rather than to today's seventh image,
  and a direct `ref` is saved through its visible placeholder (same provenance
  cross-check as by index). Mime types normalize to a type/subtype essence
  (parameters dropped, nonconforming → `application/octet-stream`) so the
  placeholder always re-parses; large payloads are digested chunked; the
  ledgers are released on framework `stop()`.

## 0.13.0 — 2026-09-07

### Added

- **Tune-out (#77): subconscious summaries instead of unsubscribing.** A third
  channel state between subscribed and gone: `tune_out` diverts a channel's
  traffic to a persistent same-model side-agent (participant `Subconscious`)
  that summarizes on a cadence in its own voice, judges wakes (addressed
  messages and gate-privileged authors, both preconditioned by the resident's
  wake gate), and can cancel. Suppressed mentions get a deterministic
  `channels/acknowledge` reaction; wake budgets are durable in the
  `mcpl/channel-lifecycle` log with max-wakes auto-cancel; optional
  `durationSeconds` gives a tune-out a restart-surviving deadline. Cancel
  delivers a capped `<tuned-out-backlog>` dump plus a subconscious report;
  diverted messages never enter the residents' compiled view (cm `viewFilter`)
  and stay excluded after cancel. Standing dispositions ride a fixed
  system-position injection on the subconscious's compiles. Requires
  `@animalabs/context-manager` with strategy-view composition
  (context-manager#54); designer review record in #115.
- **`targetAgents` honored on the channel-incoming fan-out** (was declared but
  dead); untargeted events keep the historical broadcast.
- **Per-agent message delivery**: `addMessage(…, {forAgent})` with deferral and
  turn-alive guards evaluated against the target agent; gate self-wake notices
  deliver to the waking agent. Default path unchanged.

- Add a default-off, per-agent guard that contains an exact whole-response textual wrapper for a tool registered on that inference. The wrapper is neither executed, published, nor stored as assistant continuity; a content-free system receipt records that no tool was called.

### Fixed

- `read_image` / workspace `read_image` no longer reject a JPEG that carries
  padding after its EOI marker (#143). Hardware encoders such as the Raspberry
  Pi camera pad every still to a 4-byte boundary (`ff d9 00 00 00`), and
  decoders stop at EOI, so these are valid images; the validator used to
  require EOI to be the final byte and reported them as `Invalid JPEG image`,
  which made an rpi camera unviewable for a resident. The SOI..EOI stream is
  still fully validated.

## 0.12.0 — 2026-09-05

### Added

- **`WorkspaceModule.readFileFromDisk(mountPath, { maxBytes })`** — a
  workspace-owned filesystem read for peer modules that enforces the mount
  boundary on disk, not just on the path string (#129). Honors the mount's
  `followSymlinks` policy (default: refuse), requires the canonical target to
  stay beneath the canonical mount root when symlinks are allowed (so an
  intermediate symlinked directory or a sibling-prefix root cannot escape), and
  performs a bounded prefix read when `maxBytes` is set, reporting `truncated`
  alongside the full `size`, `mtimeMs` and canonical `realPath`. Refusals throw
  the exported `WorkspaceReadError` with a `code` distinguishing unknown mount,
  lexical traversal, unavailable mount, missing file, directory, policy-denied
  symlink, outside-mount target and file-changed-during-read.
  `resolveAbsolutePath()` is now documented as lexical-only and deprecated for
  direct reads; `read_image` shares the same containment core with its error
  wording unchanged.

- `InferenceRequest.counterparty` carries the adapter-namespaced author id of
  the channel message that triggered the turn, and
  `getActiveTurnTrigger(agentName)` exposes the trigger of the turn in
  progress (kept beside the turn token, cleared wherever it is) so a host can
  stamp gateway telemetry with why the call exists and who woke the agent
  (#141).

- Wire `kv-unified` immutable-prefix identity and caller-owned cache markers through activation requests, and commit context presentation/cache receipts only after the corresponding provider call is accepted.
- Calibrate context estimates from per-provider-call usage deltas instead of cumulative tool-loop totals.

### Fixed

- The workspace materialize branch guard checks lineage instead of branch
  identity: a branch that linearly continues the last-materialized branch
  (every fork point at or after the materialized sequence) materializes
  normally, and proven-ancestor pins are re-pinned at boot — so an
  out-of-band repair that leaves the store on a fork-at-head child branch no
  longer wedges every materialize until manual surgery. The guard is scoped
  to the mounts being materialized (one mount's stale pin no longer blocks
  the rest, blocked mounts are reported as `skipped`), `canMaterialize` in
  `status` shares the guard's exact predicate instead of a divergent
  computation, and genuine divergence can be overridden with the new
  `force: true` input, which resets tracking and re-materializes the full
  tree (an incremental diff across divergent history silently writes
  nothing).

- **World `say` / `whisper` now silence adjacent auto-routed prose in every
  prose-routing mode**, not only `hybrid`. In `locus` mode a round of ordinary
  text plus an explicit Eidoverse `say` published twice — the say text, then the
  adjacent prose auto-routed to the same world locus (Cairn, 2026-09-01, world
  seq 15146/15147 byte-for-byte). An explicit world utterance is the resident's
  chosen public speech for that round and is treated exactly like a channel
  send: sticky silencing from that round on, suppression visible in the
  `[delivered]` receipt. Discord send/reply/DM, `skip_reply`, `think()` privacy,
  text-only turns and non-publishing tool rounds are unchanged.

## 0.11.0 — 2026-08-26

### Added

- `proseRouting: "disabled"` keeps all generated plain prose private and permits external publication only through explicit tools, preventing ambient locus capture from publishing continuity output.

### Changed

- Changelog entries now land as per-change fragment files in `changelog.d/`
  (`<slug>.<breaking|added|changed|fixed>.md`), folded into the version
  section at release time — concurrent PRs no longer conflict in
  `CHANGELOG.md`. Editing `## Unreleased` directly still works and is merged
  at the same point.

### Fixed

- Anthropic organization-acceleration 429s now enter a per-residence provider cooldown instead of immediate same-window retries: later arrivals are retained for one fresh compile after the quiet window, local Context Manager maintenance waits behind the primary lane, and capacity errors never enter the poisoned-history breaker (AF #114 bounded first slice).

- **Workspace mounts are usable on native Windows.** The mount containment
  checks (the `parsePath` traversal guard and sync's `safePath`) appended a
  POSIX `'/'` to the mount root before prefix-matching, but `resolve()` emits
  backslash-separated paths on Windows — so every legitimate in-mount path
  was rejected: read/write threw "Path traversal detected" and `syncFromFs`
  reported every real file as outside its mount (`ls` was unaffected, making
  a populated mount look empty). Containment now compares with the platform
  separator; the sync walker and the watcher additionally normalize relative
  paths to the `'/'`-separated logical form used everywhere else. No
  behavior change on POSIX.

- Discord downtime history is written to Context Manager in chronological order while newest-message tracking retains Discord order.

- Rapid external messages now retain arrival order while remaining prioritized
  ahead of queued internal framework events.

- Mixed wake batches containing a context-budget restart now preserve the
  restart's same-turn semantics instead of taking the restart-only turn-lock
  exception and then starting from an older ordinary wake as a fresh turn.

## 0.10.0 — 2026-08-18

Minor release because it adds a third public prose-routing mode and expands the
runtime wake-rule surface.

### Added

- **Hybrid prose routing** (#113) — `AgentConfig.proseRouting: "hybrid"` keeps
  unprefixed prose in the frozen current locus while a leading
  `>>>destination` envelope uses the existing authorized cross-surface router.
  Exact authored source remains in resident context, recipients see only the
  body, and delivery success/failure returns as a model-visible receipt.
  Explicit publication tools outrank contradictory prose to prevent duplicate
  sends.
- **Composable wake-rule observers** (#106) — rate/sampling rules may fall
  through without swallowing later addressed-message rules, rules support
  anchored insertion, and the runtime reports before/after probes plus shadow
  warnings so ordering failures are visible before they become silence.

### Changed

- **Default inline tool-result cap raised from 5,000 to 24,000 characters**
  (#101). Durable resident overrides and strategy hard clamps remain unchanged;
  larger results still spill to the workspace with a bounded notice.
- **Workspace egress reads the current disk bytes** rather than trusting a stale
  in-memory copy, and skipped syncs now return an explicit reason.

### Fixed

- **Legacy XML tool-round persistence** (#107) stores each round's delta prose
  rather than the cumulative preamble and retains `toolName` on stored
  `tool_result` blocks, preventing duplicate public text and malformed replay.

### Security

- CI actions are pinned to immutable SHAs and checkout no longer persists
  credentials (#100).

## 0.9.0 — 2026-08-06

Minor rather than patch because 0.x puts breaking changes in the minor, and
this release both removes a public method from an exported class and changes
fleet default behavior.

### Breaking (consumers)

- **`McplServerConnection.sendAfterInference` is removed** (#86). The method
  was dropped from the spec in MCPL 0.5.0 (§10.5, replaced by
  `inference/lifecycle`) and the runtime stopped sending it then; only the
  helper survived.
  - **Who needs to act:** nobody we can find. `package.json` `exports` maps
    only `.`, and the root index re-exports a curated subset that never
    included `McplMethod`, `AfterInferenceParams` or `AfterInferenceResult`,
    so the surface is provably private. A grep across 14 trees found one
    definition and zero callers.
  - **Migration:** consume `inference/lifecycle` — `started` at stream start,
    exactly one terminal event on every exit path.
- **Tool results now spill to a file above 5,000 characters by default**
  (#91). Previously the cap was `strategy.maxMessageTokens * 4` — often tens
  of thousands of characters, and *no cap at all* when the strategy declares
  no `maxMessageTokens`.
  - **Who needs to act:** any deployment relying on large tool results
    landing inline. Raise `FrameworkConfig.toolResultInlineMaxChars`
    (minimum 1000), or per-agent via `tool_result_inline_max_chars`.
  - **Unchanged:** nothing is lost — the full result is written to a spill
    file and the notice names its path.

### Breaking (MCPL servers)

- **MCPL 0.5 enforces deny-by-default before the policy handshake completes**
  (§5.3). A connection carries an empty grant until `establishGrant()`, and
  privileged inbound traffic is rejected until the initial exchange settles.
  A server that does not answer the `featureSets/update` Request keeps an
  empty grant — **un-migrated servers will go dark**, accepted deliberately
  for a single-release rollout.
- **§7 `scope`/`elevate` is removed** — both now answer `-32601`, config
  `scopes` is ignored with a warning, and `ScopeManager` is gone from wiring.
- Requests denied against the grant answer `-32002` with
  `data: { capability }`; notifications are discarded with diagnostics.
  `-32001`/`-32003` are JSON-RPC errors with `data: { featureSet }` (§6.6),
  with result-shape fallback only for legacy responders.

### Breaking (dependency floors)

Raised to fix a build that only worked against local symlinks:

- **chronicle `^0.3.0`** — context-manager 0.6.3 requires `^0.3.0`, so the old
  `^0.2.2` installed *two* chronicles and the framework handed a 0.2.x
  `JsStore` to APIs expecting the 0.3.x one. Single copy now.
- **membrane `^0.5.78`** — the framework consumes the `retrying`
  yielding-stream event, which existed only in unpublished membrane commits
  until 0.5.78.

**Deploy note:** chronicle 0.3.0 open-writes a store format 0.2.x cannot
reopen. Take cold backups before upgrading any residence.

### Added

- **MCPL 0.5 capability grants** (#76, #78, #79) — the §6.2 vocabulary tree, a
  generic recursive advertisement walk (§5.1 boolean shorthand; unknown names
  mint nothing), grant matching with one-segment wildcards and
  bare-parent-grants-nothing (§5.4), and §13.4 deny-by-default for
  `inject.system`, re-grantable only via explicit config. Enforcement sits at
  the admission choke-point that live routing and every buffer flush share, so
  buffered events are authorized against the grant current at admission rather
  than at emit. Hook fan-out selects by grant, `userMessage` is `null` when
  `observe` is not granted, and injection positions are authorized against the
  grant current at response receipt (§10.8).
- **§17 host-side manifest tracking** (#78) — `mcpl/manifestChanged` routed
  ungated (§17.3: gating would silence exactly the servers whose grants just
  narrowed), fetched via `mcpl/manifest`, validated exactly as `initialize`,
  and applied reduction-first through an interim `new ∩ old` grant before the
  server is told (§6.7). Rate-limited per connection with in-flight coalescing
  and a 5s floor, host-bounded rather than trusting server coalescing.
- **Host-side capability scoping** — `enabledCapabilities` /
  `disabledCapabilities` per server, same allow/deny and wildcard idiom as
  `enabledTools`. A server names its own capabilities in its `initialize`
  response and hook fan-out keyed off that self-advertisement, so connecting
  any server claiming `contextHooks.afterInference` received the complete text
  of every agent turn, and disabling its feature sets did not stop that:
  feature sets gate what a server may *do*, while what it may *see* was gated
  only by its own advert.
- Live policy status in the MCPL server listing, and manifest freshness in
  server status (#87).
- **`refusalHandling.retries`** (default 0) — plain same-model retries when a
  turn ends in `stop_reason: refusal`, before rewind or reaction. Near the
  classifier threshold the verdict is probabilistic rather than a function of
  the payload; identical bytes were observed passing and refusing minutes
  apart. Retries are spent at the membrane seam, which replays the same
  request immediately and cache-warm — a framework requeue recompiled, making
  attempts correlated rather than fresh draws. `driveStream` handles
  membrane's `retrying` event by re-minting the outgoing inference id and
  resetting the prose router, so the surface orphans the partial preview
  instead of splicing two half-answers together. Escalation order is now
  retries → rewind → reaction, which restores the reaction's meaning as "the
  border is close" rather than firing on every near-threshold flip.
  Operator-forced `/unstick` skips retries and keeps its semantics.
- **`REFUSAL_REACTIONS`, the fallback marker, and `REFUSAL_REACTION_BASELINE`**
  are exported from the root index (#88) — the deduplicated set of every
  marker `reactToRefusal` can emit, so a host can suppress exactly the
  annotations the framework stamps instead of keeping a list in sync by hand.
- **`nudgeAgent()`** — queue a normal inference request with zero context
  mutation, so the turn compiles exactly what the agent already sees. Not
  idle-gated; queued requests bypass gate sleep as an admin override. Also
  wired as host/command `nudge`.
- **`skip_reply` `wake_in_seconds`** — end the turn but come back on your own
  after N seconds, so "not replying now" can mean "back in a moment" instead
  of "idle until something external arrives". Deliberately not sleep: no
  suppression window, external wakes flow normally, and any turn start cancels
  the pending self-wake. A compact one-line in-window notice rides the wake
  turn so the agent can tell its own timer from a heartbeat.
- **`AgentConfig.physicalWindowTokens`** (#92) — continuation rounds append
  tool results to the compiled request without recompiling, so a compile that
  was legal could walk past the provider's hard cap mid-turn and take a wire
  `context_length_exceeded` 400 (observed at 185k → 199.6k → 209k against a
  200k cap). Grace cannot help, because the provider cap is physical. Unset
  leaves behavior unchanged.
- **`tool_result_inline_max_chars` as a durable resident setting** (#91, #94) —
  persisted to `framework/state` alongside the other durable settings and
  restored on create, with load-time validation that drops invalid entries
  loudly. `reset` clears it and returns the agent to the residence default,
  and the reset itself survives restarts. The *effective* cap is
  `min(desired, strategy bound)` for every source: a durable preference must
  not become a durable path for one tool result to exceed the strategy's
  per-message safety limit. `agent_settings get` reports the full quartet —
  desired, effective, source, and `clamped_by`.
- **Routing self-observability** — `[delivered]` prose receipts collected
  across the logical turn (budget restarts accumulate into one receipt),
  `channel_open` moves the pin and announces it in its own tool result, and
  suppressed prose is visible in the receipt. The 2026-07-31 misroute series
  showed the agent provably knew its prose lane one round before misrouting;
  the failure was attention, and it could never see afterwards where its words
  had actually landed.
- **Engaged-channel re-pin** — a human follow-up in a channel the agent itself
  sent into this turn moves the locus, even without a mention. Tagged
  `chat:ambient`, such a message correctly declined the addressed re-pin, but
  conversationally it is a reply in flow, and trailing prose followed the stale
  pin into an unrelated DM.

### Fixed

- **A failing MCPL server can no longer crash the agent process.** A websocket
  dial failing at the HTTP layer (nginx 502 with the backend down) emits
  `error` on the raw socket more than once; `open()`'s settle paths called
  `removeAllListeners()` before `terminate()`, so the late error had no
  listener and became a top-level unhandled `ErrorEvent` — the whole agent died
  at boot, into a systemd crashloop (623 cycles observed live). Every settle
  path now leaves a swallow listener; the reconnect loop above owns recovery.
- Stale MCPL grants are revoked across reconnects.
- **Cache-inclusive stream counters are reset at stream start.**
  `lastStreamRealInputTokens` was never reset, so a new stream inherited the
  previous stream's window size until its own first usage event — and on the
  restart path introduced by #92 the inherited value is precisely the oversized
  number that caused the restart, so a round reaching the tool-result boundary
  before emitting usage would restart again, forever. Prior output is also now
  counted in the projection.
- A spill *write* failure now produces a distinct notice and trace, instead of
  being indistinguishable from a successful spill.
- The closed-channel invitation states the real delivery model and carries a
  missed tally.
- Tool-call state is attributed correctly across multiple feature sets.

## 0.8.0 — 2026-07-31

### Breaking

- **`McplServerConfig.tokenProvider` is renamed `accessProvider`.** Identifiers
  surface — in stack traces, in agent-readable source, in every model-driven
  loop over this code — and the name now matches the access-grant framing.
  Mechanical rename; update the field name at call sites.

### Added

- **Background scripts** — `code_execution` gains `background: true`. The
  script detaches into a dedicated interpreter, the tool returns immediately
  with a `script_id`, and the turn is free to end. In-script,
  `await wake_agent(payload)` delivers a provenance envelope — script id, the
  line number in the agent's own script, elapsed time, wake count, journal path
  — plus the payload, and requests inference, entering tagged `script:wake`.
  The authority is the agent's own: it armed the wake itself. A script that
  ends without waking wakes nobody, and one that crashes wakes the agent with
  the error tail.
- **Oversized tool-result spill** — the agent's context is for signal, not
  bulk. (Completed with a safe default in 0.9.0; see #91.)
- **`utils` meta-tool** — `Module.getUtilities?()` takes the same
  `ToolDefinition` shape and the same `handleToolCall` dispatch as
  `getTools()`, so a tool migrates surfaces by moving between the two lists.
  The framework advertises a single `utils` tool (list / describe / run) only
  when at least one utility is registered, and `run` bounces schema misses with
  the schema attached. Rationale: every first-class tool schema taxes every
  inference, and a capability used twice a month shouldn't.
- **Per-dial MCPL credential provider** — resolved at every dial, connect and
  each background reconnect, overriding the static token. Host-attached and
  never serialized: agents name an access grant, credentials are fetched fresh
  outside model context, which also makes short-lived audience tokens viable
  where a static `?token=` forced long-lived ones. Dial-failure messages now
  carry a token-stripped URL, since error strings travel into traces and tool
  results.
- **Machine-close provenance and explicit-open protection** — `channel_close`
  accepts `source` and `overrideExplicitOpen` (module callers only, undeclared
  in the agent-facing schema). Housekeeping closes previously recorded
  `source: 'agent-tool'`, so the durable record could not distinguish an
  agent's decision from a janitor's, and downstream respect for agent decisions
  became respect for the janitor. A machine-sourced close of a channel an agent
  or operator explicitly opened is now refused structurally
  (`data.refusal = 'explicit-open'`) unless the caller certifies otherwise.
  Adds `ModuleContext.notifyOps`.
- **Addressed re-pin** — a turn's locus freezes at turn start (deliberate,
  as ambient-hijack protection), but when someone *addresses* the agent from
  another channel mid-turn the model conversationally follows the new speaker
  while its trailing prose lands on the stale pin. In all six recorded
  incidents the prose answered the injected speaker. Mid-turn addressed
  injections now move the locus.

### Fixed

- **Phantom skips and falsified history.** A DM's wake fired a turn whose
  compile ran before the deferred DM flushed: the model saw only the routing
  notice and reasonably skipped, and the DM then landed in the window
  mid-compile, positioned *before* the skip — so the window testified that the
  agent saw and ignored a message it was never shown, and the agent
  confabulated an apology for a choice it never made, with KV divergence at the
  inserted message on every later compile. `activeTurnTokens` now marks a turn
  alive from dequeue through settled teardown (strictly longer than
  `activeStreams` membership, which begins only after hooks and compile), and
  `addMessage` defers on turn-alive: the compile window is closed to cross-turn
  writers.
- **Lazy workspace sync corrupted binaries.** `ensureSynced` round-tripped
  every file through UTF-8 before storing the blob, so non-UTF-8 bytes became
  U+FFFD and any binary entering the tree via lazy sync was permanently
  corrupted. The bulk path already skipped binaries; lazy sync now mirrors it
  and serves them from disk. Separately, bare `read_image` was unconditionally
  intercepted by a tree-only handler with no fallback, and now falls back to
  disk.
- **`WorkspaceModule` restart restoration is second-callback-safe** (#72).
  Hosts call `module.start(ctx)` before `initStore(store)`, but restoration
  looped over `this.mounts` inside `start()` — empty at that moment — so every
  restart silently reset materialization state: misleading `pendingChanges`,
  null `lastMaterializedBranch`, `canMaterialize` true across a branch
  mismatch, and a disabled branch guard until the next materialization.
  `start()` now only decodes the persisted payload, and a shared
  `applySavedState()` applies it once mounts exist, called from both callbacks.

## 0.7.4 — 2026-07-27

### Added

- **Immediate context-budget decrease** — `patch.immediate` (a mode flag, never
  persisted) takes a `contextBudgetTokens` decrease down the same path as an
  increase: budget set directly, any in-flight paced descent cancelled, and the
  next compile plans straight at the new value. Previously a decrease could
  only converge gradually, which is the wrong tool during a refusal streak or
  an over-wall wedge — the operator needs the window smaller now, and the whole
  fold-down and its KV invalidation land on one turn by explicit choice. Also
  exposed on `agent_settings`.

### Fixed

- **Thinking-only assistant messages are never persisted.** They are refusals:
  the provider returns signed thinking and no content, so the turn produced no
  speech and no tool call, and storing one records an action that never
  happened. Two landing adjacently are toxic — formatters merge consecutive
  same-role messages, producing a single assistant message carrying signed
  thinking from two *different* responses, which the provider cannot verify:
  a 400 that no retry can clear. One such pair took an agent hard down for
  roughly four hours. Refused at `addAssistantResponse`, the single chokepoint
  for every assistant persist, and refused loudly.
- **Unverifiable signed thinking is dropped from the last assistant message.**
  The provider verifies thinking blocks in the latest assistant message against
  their signature, and a block whose text was summarized or redacted away
  (signature present, thinking empty) fails that check and 400s the entire
  request, unrecoverably — one agent was down ~2.5h across 13 consecutive
  failures. Such blocks are normal in these stores and harmless everywhere
  except that one position, where the provider replays their encrypted chain of
  thought, so the strip is scoped to the last assistant message: a blanket
  strip would silently discard the agent's interiority.
- **The typing indicator starts at turn start**, not after module
  `gatherContext`, MCPL `beforeInference` RPCs, the full context compile and
  stream initiation. Every millisecond of that leg read as dead air to whoever
  had just messaged the agent — 30+ seconds during one compile regression, and
  still seconds afterwards. Typing now means attending, not replying. The
  failure paths that never reach `driveStream` stop the indicator, so a compile
  refusal cannot leave it stuck.
- **Channel invitations reach the `channels/incoming` path.** The
  addressed-while-closed invitation block existed only on the push-event path,
  so an agent woken by a mention delivered via `channels.publish` got no
  guidance and no route — one observed reply of 2,320 characters bounced with
  "no destination set yet this turn". The invitation's first option was also
  reworded: "simply write your reply as normal text" is a false promise for
  explicit prose-routing agents.
