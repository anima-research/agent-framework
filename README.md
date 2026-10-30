# @connectome/agent-framework

Multi-agent framework with pluggable modules, persistent state, streaming inference, and concurrent tool execution.

## Overview

Agent Framework orchestrates one or more LLM-powered agents that interact with the world through **modules** (pluggable capability providers). It handles the full lifecycle: event processing, context compilation, inference (streaming or request/response), tool dispatch, and state persistence via [Chronicle](https://github.com/antra-tess/chronicle).

```
External events (Discord, API, MCPL servers, timers)
    ↓
ProcessQueue → Module.onProcess() → EventResponse
    ↓                                    ↓
Inference trigger              Messages / state updates
    ↓
Context compilation (with injections from modules + MCPL hooks)
    ↓
Membrane (LLM abstraction) → YieldingStream
    ↓
Tool calls → Module.handleToolCall() → results → stream resumes
    ↓
Agent speech → Module.onAgentSpeech() → external delivery
```

## Quick Start

```typescript
import { AgentFramework, ApiModule, ApiServer } from '@connectome/agent-framework';
import { Membrane, AnthropicAdapter } from 'membrane';

const membrane = new Membrane({ adapter: new AnthropicAdapter() });

const framework = await AgentFramework.create({
  storePath: './data/store',
  membrane,
  agents: [{
    name: 'assistant',
    model: 'claude-sonnet-4-20250514',
    systemPrompt: 'You are a helpful assistant.',
  }],
  modules: [new ApiModule()],
});

framework.start();

const server = new ApiServer(framework, { port: 8765 });
await server.start();
```

## Core Concepts

### Agents

An agent wraps an LLM identity: model, system prompt, context strategy, and tool permissions. Multiple agents can coexist, each with independent context and inference state.

Agents can opt into the [tool result guard](docs/tool-result-guard.md) through
`agent_settings` with `{"action":"update","tool_result_guard":true}`. The
setting persists across restarts; withheld results remain recoverable in
Chronicle's audit history.

```typescript
{
  name: 'researcher',
  model: 'claude-opus-4-20250514',
  systemPrompt: '...',
  strategy: new AutobiographicalStrategy({ recentWindowTokens: 30000 }),
  allowedTools: ['search--query', 'toolsets--open', 'toolsets--act', 'toolsets--look', 'toolsets--close', 'files--archive'], // or 'all'
  triggerSources: ['discord'],                   // or 'all'
  maxTokens: 8192,
  maxStreamTokens: 150_000,  // input token budget before stream restart
}
```

`allowedTools` is enforced at dispatch for registered agents. Omission or
`'all'` permits all tools; an explicit list matches exact names, including
`module--utility` names. A utility, like every tool of the host's built-in
toolset (see "The host's own toolsets" below), is called through
`toolsets--act`, and the dispatch check applies to the utility's own name: an
agent that should use one lists `module--utility` and the `toolsets--` tools.
An agent that can't use `toolsets--open` and `toolsets--act` gets no host
toolsets: every tool it may call stays in its tool list, except module
utilities, which are never in a tool list (it can still call one by name).

Trusted module calls are exempt from agent allowlists. Genuinely unidentified
public callers, including unknown legacy caller names, remain unrestricted.
Framework-created ephemeral and conversation identities fail closed while
unregistered. Hosts using `createEphemeralAgent` must register and run the
returned agent through `runEphemeralToCompletion` for tool authority.

**Inference modes:**
- **Streaming** (default in framework): `startStreamWithInjections()` returns a `YieldingStream` that emits tokens, tool calls, and completion events. The framework drives the stream, dispatches tools, and resumes automatically.
- **Request/response**: `runInferenceWithInjections()` for simple complete-and-return usage with optional `AbortSignal` for cancellation.

**State machine:**
```
idle → inferring → streaming ⇄ waiting_for_tools → ready → streaming → ... → idle
                 ↘ (abort) → idle
```

### Modules

Modules are pluggable capability providers. They process events, expose tools, deliver speech, and optionally inject context before inference.

```typescript
interface Module {
  readonly name: string;

  start(ctx: ModuleContext): Promise<void>;
  stop(): Promise<void>;

  getTools(): ToolDefinition[];
  handleToolCall(call: ToolCall): Promise<ToolResult>;
  onProcess(event: ProcessEvent, state: ProcessState): Promise<EventResponse>;

  // Optional
  onAgentSpeech?(agentName: string, content: ContentBlock[], context: SpeechContext): Promise<void>;
  gatherContext?(agentName: string): Promise<ModuleContextInjection[]>;
}
```

An `EventResponse` can add/edit/remove messages, update module state, request inference, and signal tool changes. The framework applies its message changes, then its state update, then its inference request; when one of these throws, what came before it stays applied, that step may have taken effect in part, and the rest of that response isn't:

```typescript
return {
  addMessages: [{ participant: 'user', content: [{ type: 'text', text: '...' }] }],
  requestInference: true,
  stateUpdate: { lastProcessed: Date.now() },
};
```

**Built-in modules:**
- **DiscordModule** - Discord bot integration (messages, reactions, threads, typing indicators)
- **ApiModule** - WebSocket API event processing
- **WorkspaceModule** - Mountable filesystem abstraction with Chronicle tree state, filesystem watching, and materialization

DiscordModule and ApiModule store a sender's name that comes from outside the framework in a form marked with its source: a Discord author's username as `<name> (Discord)`, and the name on every `api:message` event, from an ApiServer caller or a host's own, as `<name> (API)`. An `api:message` whose `participant` isn't text, which its type doesn't allow, isn't stored, and starts no turn. Such a name is stored on one line: each run of line breaks (U+2028 and U+2029 included) and other control characters becomes one space. Each of the framework's notice openings in it is marked with a backslash, as in the text a participant or a server supplies. The generic name `user`, in any capitalization, is stored as given. Unless a host gives one of its own agents the name `user`, in any capitalization, or a name ending in ` (Discord)` or ` (API)`, such a message never carries an agent's name, so the agent's request never takes it as the agent's own turn. Where an agent's request shows senders' names, the agent sees the marked form, and the unmarked one in rows stored by earlier versions. A host that pushes an `api:message` in an agent's name records a user turn, not that agent's, with the same exception, and the ApiServer's message list returns each message's participant as stored, so a caller sees its own messages under its name's stored form, `<name> (API)`. The ApiServer refuses a `participant` that isn't text, as it refuses content that isn't. The bot's own messages that a Discord history sync stores keep the name of the framework's first agent, as before. For a sender from outside, both modules also store the name as sent in `metadata.author` (with the author's Discord id), unless an `api:message` event's metadata already carries an `author` object, which is kept. History's author filter matches a row's `metadata.author` when it has one, and its participant otherwise. Code that tells senders apart should read a row's `metadata.author` (its `name`, and `id` for Discord) when it has one, and its participant otherwise, as the filter does: rows these modules stored in earlier versions have none, unless a host's `api:message` carried one.

### Event Processing

The framework runs an event loop over a `ProcessQueue`. Each event is processed by all modules, which return `EventResponse` objects. If any response requests inference, the framework compiles context and starts a stream.

**Event types:** `ExternalMessageEvent`, `ToolCallEvent`, `ToolResultEvent`, `InferenceRequestEvent`, `McplPushEvent`, `McplChannelIncomingEvent`, `TimerFiredEvent`, `ApiMessageEvent`, `ModuleEvent`, `CustomEvent`

### Context Management

Each agent has a `ContextManager` (from `@connectome/context-manager`) that maintains conversation history with optional compression strategies:

- **PassthroughStrategy** - No compression, raw message replay up to budget
- **AutobiographicalStrategy** - Chunks old messages and summarizes them into diary entries, preserving recent context uncompressed

A turn keeps the messages it opened with whole: at a start that opens a turn, the framework pins raw (`pinRange`, named `agent-framework:turn-inputs`) the rows the agent sees that were stored after both the newest of its own messages that it sees and its consumed watermark, starting at the first such row that holds more than tool results, and removes the pin when the turn ends. The pinned rows' tokens count against the budget. If a committing compile refuses as over budget with the pin held, the pin is removed and the compile runs once more, so the turn goes on as it would have without it. A silent heartbeat tick pins nothing, and neither does a strategy without pins.

Before inference, modules and MCPL hooks can inject additional context via `gatherContext()`. An `afterUser` injection is stored in the agent's window, as the message `compile()` would have placed after the last user message, so it stays where the agent saw it: the replies after it keep their thinking, and the cache keeps the turns before it. A source's unchanged content isn't stored again while the copy the agent will read as current has it whole: the one its last request held, or a newer one a start stored whose compile then didn't record (it threw, or the start failed before it); once a fold has summarized it or the strategy's window has passed it, it's stored again, as one more row. Where a changed one lands right after the agent's own latest message, with no one else's message between, `[Continue]` still ends the request, after it. A stored row is history to the strategy, capped, sharded, budgeted and folded like any message. Its metadata carries `system: true`, `kind: 'context-injection'` and `contextInjection: { agent, namespace, contentHash, part, parts }`, which `storedInjectionMarkOf` reads, and every other agent's view leaves it out. A module's injection can set `placedEachCompile: true` to be placed by `compile()` at each start instead, near the end, at the cost of the thinking of every reply after its old place.

### Persistence

All state is persisted in a [Chronicle](https://github.com/antra-tess/chronicle) store:

| State | Strategy | Description |
|-------|----------|-------------|
| `framework/state` | snapshot | Agent configs |
| `framework/inference-log` | append_log | Raw LLM requests/responses |
| `messages` | (context-manager) | Shared conversation log |
| `agents/{name}/context` | (context-manager) | Per-agent context log |
| `modules/{name}/state` | snapshot | Per-module persistent state |

Chronicle's branching support enables time-travel and what-if exploration across all state.

#### Offline recovery from a poisoned context tail

If an inference API rejects message history and the normal host must remain
stopped, create a safe branch with the recovery CLI:

```bash
agent-framework-recover \
  --store ./data/agent-store \
  --agent cairn \
  --message-id 123456789012345678 \
  --branch recovery/cairn/poisoned-tail
```

The specified Discord message is the last message the agent will still see;
everything after it is left on the old branch. The command scans in bounded
windows, never compiles message content, and activates the new Chronicle
branch. By default the recovery is local to the resident: nothing is posted to
Discord. To let the people involved see that the agent no longer has their
messages, choose awareness marks explicitly with `--marks addressed` (removed
messages that mentioned or replied to the bot, and DMs) or `--marks all`
(every removed Discord message). The output counts what will be marked and
what stays unmarked, and `--dry-run` shows exactly which addresses each choice
covers. Only `{serverId, channelId, messageId}` metadata is written, to the
awareness ledger, `<store>/recovery/discord-awareness-outbox.json`, and the
marks are delivered when the host and that agent's `discord-mcpl` bot next
connect (see
[Live surgery and Discord awareness marks](#live-surgery-and-discord-awareness-marks)).
If the branch is made but the marks can't be recorded, the output's `markers`
says so and the branch stands. The live controls described below list, cancel
and retract marks; with the host stopped there are none, so a chosen batch is
stopped by starting the host and cancelling it, and a few of its marks may go
out first.
Portal and other non-Discord records are ignored.

When the safe point is an assistant/tool-side record rather than a Discord
message, use its exact ContextManager message ID:

```bash
agent-framework-recover \
  --store ./data/agent-store \
  --agent cairn \
  --context-id 15184
```

Use `--dry-run` to inspect the proposed branch and message IDs without writing.
`--message-id` also accepts a Discord message link. The older `--messages N`
mode remains available when a count of internal context entries is genuinely
desired.

To branch at the current message while suppressing selected earlier messages
only on the new branch:

```bash
agent-framework-recover \
  --store ./data/agent-store \
  --agent cairn \
  --message-id <current-discord-message-id> \
  --suppress <message-id-to-hide> \
  --suppress <another-message-id>
```

`--suppress` may be repeated or given a comma-separated list.
`--suppress-range <first>..<last>` suppresses the inclusive context interval
between two Discord messages, including intervening agent/tool entries. These
removals exist only on the recovery branch; the source branch remains intact.
Suppressed Discord messages follow the same `--marks` choice.
Selections that split a sharded body group or a tool-use/tool-result exchange
are rejected. The suppression plan is journaled before the branch switch; if
the recovery process is interrupted between interval removals, framework
startup resumes the remaining atomic intervals before connecting MCPL.
For old stores whose messages lack `metadata.serverId`, supply
`--discord-server discord` (or the configured Discord MCPL server id). The
normal agent host must be stopped while this command has the Chronicle store
open.

For stdio MCPL children, the framework defaults `DISCORD_SUPPRESSED_REACTIONS_BASELINE` to the reactions it places: its refusal markers, the Discord adapter's default awareness marker, the configured awareness marker, and every retained outbox emoji. This covers later removals and replays after a configuration change. Suppression is by emoji, so members' own reactions with those emoji stop reaching the agent too. The default is derived at each spawn of a child (its first connect, each automatic reconnect, a restart), so the next child spawned gets the markers retained since the last spawn. The ledger is read once and held, and read from its file again only after a write to it failed. When it can't be read, a runtime connect of a child that takes the default refuses before anything is registered or spawned (a startup connect, whose routing is staged beforehand, before anything spawns), and a restart of one refuses before it stops the running child; a child with a baseline of its own, and a WebSocket server, connect and restart whatever the ledger's state. An automatic reconnect of a child that takes the default fails and retries rather than spawn it without the default. A value with tokens in the server's env (case-insensitive on Windows), or one intentionally inherited with `inheritEnv: true`, takes precedence, and the framework logs that it replaces the default. A value with no tokens, as discord-mcpl's parser reads them, counts as unset, since the adapter would read it as suppression off. The parser splits on commas and keeps a token only when its normalizer leaves something of it, after stripping U+FE0F, trimming, and stripping one leading and one trailing colon: so a blank value, commas alone, `:`, `::` or a lone U+FE0F (say from `${A},${B}` or `:${NAME}:` with the variables empty) has no tokens. The adapter's filters file and legacy operator env still take precedence over this variable, and they are where an operator turns suppression off.

`framework.getPlacedReactionBaseline()` returns a fresh snapshot of that default for other embeddings, including separately managed WebSocket adapters. It returns suppression tokens, with a custom emoji as its bare ID, not marker payloads for adding, removing or replaying a reaction. An unreadable awareness ledger throws instead of producing a partial snapshot. Hosts that previously supplied a refusal-only default must stop supplying it to adopt this framework-derived default; an explicit operator choice should remain intact.

### MCPL (MCP Live)

Optional host-side implementation of the MCP Live protocol. External servers (game engines, dev tools, etc.) can:
- Push events into agent context
- Hook into inference lifecycle (beforeInference/afterInference)
- Initiate inference requests
- Publish and observe channels
- Provide tools (namespaced automatically)

```typescript
{
  mcplServers: [{
    id: 'game-engine',
    command: 'node',
    args: ['./game-server.js'],
    toolPrefix: 'game',
  }],
}
```

#### Tool names and tool-name patterns

An MCPL tool reaches the model as `<toolPrefix>--<tool>`. `toolPrefix`
defaults to `mcpl--<serverId>`: server `search` with no `toolPrefix` offers
`mcpl--search--query`, and with `toolPrefix: 'search'` it offers
`search--query`.

No two servers' prefixes may meet, since their servers could then give one
tool name. Two prefixes meet when one is the other's followed by `-`, or
begins with the other's followed by `--`: server `foo` listing `bar--echo` and
server `foo--bar` listing `echo` would both give `foo--bar--echo`. `create()`
refuses such a pair, and so do a runtime connect and a restart (before it
disconnects anything), naming both servers and the rule. `foo` beside
`foo-bar` or `foobar` is fine. A server that lists one tool more than once has
its first listing offered to the model and the rest left out, and each tool
refresh that finds it raises an `mcpl-tool-duplicate` ops alert naming the
tools. Its webhook post goes out at most once per server in 15 minutes.

These settings take RFC-007 §6.2 patterns (`*` matches any run of characters)
over that full model-facing name, so they need the prefix:

- `toolClassOverrides` (framework config), e.g. `{ 'mcpl--search--*': ['web'] }`
- `toolLifecycle.observe.tools` and `toolLifecycle.inputs.tools` (per server)

`enabledTools` / `disabledTools` (per server) are different: they take the
bare server-side name (`query`) with no prefix.

A pattern that matches no tool is reported once, as a console line and an
`mcpl:tool-pattern-unmatched` trace. When the pattern used the bare server id
(`search--*` under the default prefix), the report suggests the prefixed form.
A pattern that could name a server's tools is not judged until that server
has listed them, so late connects and reconnects don't cause early reports.

#### Modern MCP servers (2026-07-28)

The same `mcplServers` list also takes servers that speak modern MCP
(revision `2026-07-28`), reached through the official SDK client. The
configuration chooses the family, and nothing is probed:

| Configuration | Family | Transport |
|---|---|---|
| `url: 'ws://…'` / `'wss://…'` | MCPL (MCP `2024-11-05`) | WebSocket (`token` / `accessProvider` as `?token=`, or as bearer with `tokenTransport: 'header'`) |
| `url: 'http://…'` / `'https://…'` | modern MCP | Streamable HTTP (`token` / `accessProvider` as bearer) |
| `command` | MCPL | stdio |
| `command` + `protocol: 'modern'` | modern MCP | stdio |

```typescript
{
  mcplServers: [
    { id: 'docs', url: 'https://mcp.example.com/mcp', accessProvider: getToken },
    { id: 'search', command: 'search-mcp', protocol: 'modern', reconnect: true },
  ],
}
```

A configuration with both `command` and `url` needs `transport` to say which
one is used; without it, it is refused rather than silently ignoring one.

A WebSocket server's credential, its `token` or what its `accessProvider`
returns for a dial, goes as a `token` query parameter by default
(`tokenTransport: 'query'`). With `tokenTransport: 'header'` it goes as an
`Authorization: Bearer` header on the upgrade instead, with no query
parameter, so it stays out of the url and of the access logs that record it;
the provider still runs at every dial and reconnect. Switch a server to
`'header'` once it reads the header. A header carries a credential as
configured only if it is printable ASCII with no space at either end, so
header mode refuses any other, without quoting it: a static `token` when the
server is added, and an access provider's at the dial. `tokenTransport` is
refused on an http(s):// server, which always sends the header, and on a
stdio server; `'header'` is refused with a url that carries a `token`
parameter or userinfo of its own, since whenever the Bearer header carries a
credential it replaces the userinfo's Basic one.

Set `credentialRequired: true` for a fail-closed WebSocket dial. This requires
`tokenTransport: 'header'` and a host-attached `accessProvider`, called on every
dial including reconnects. A missing or throwing provider, or an empty or
non-sendable result, stops the dial without connecting or falling back. Credentials
must be printable ASCII with no space at either end; there is no minimum length.
The server's authentication scheme decides which credentials it accepts.

This mode forbids a static `token` (even empty), a URL `token` query parameter,
userinfo and fragments. It supports only WebSocket servers, not HTTP, stdio or
modern MCP. Cleartext `ws://` is allowed only to `localhost` or a literal loopback
address, not to a `*.localhost` name, which a resolver can send off this host;
use `wss://` for remote servers. These configuration mistakes are reported
descriptively when the server is configured, and checked again before the
provider runs at dial time.

Strict dial errors have the fixed form `MCPL server "<id>": <code>`:

| Code | Meaning |
| --- | --- |
| `provider-failed` | The provider is absent, throws, or returns an empty or non-sendable value. No connection is made. |
| `credential-rejected` | The server answers the WebSocket upgrade with HTTP 401 or 403. |
| `engine-unsupported` | A refused upgrade has no finite numeric status available from the client runtime. |
| `connection-failed` | Any other upgrade status, socket/TLS error, open timeout, cancellation, or strict configuration refusal at dial time. |

Redirects are not followed. Refused upgrades are classified only by the
`unexpected-response` event's numeric `statusCode`, never by error text or response
bodies; runtime support is determined by that capability, not a version list.
Leaving `credentialRequired` out, or setting it to `false` or `null`, keeps optional
credential behavior. Diagnostic filtering and credential retention are unchanged;
this option controls dialing, not a guarantee that all diagnostics hide secrets.

A modern server's tools get the same prefix, `enabledTools`/`disabledTools`,
class overrides and dispatch as an MCPL server's, and `listMcplServers()`
shows its `family`, `protocolVersion` and `transport`. Its config differs in
three ways:
- It has no MCPL surface (grant, push, channels, inference requests, feature
  sets). A setting that asks for that surface can't apply, so it is a
  configuration error: `allowHostCommands: true`, an `enabledCapabilities`
  pattern that matches a capability denied by default, `channelSubscription:
  'auto'` or a non-empty list, a scope's non-empty `whitelist`, a
  `toolLifecycle` `observe` or `inputs` block, a
  `toolLifecycle.maxInputBytes` or an `autofetch` bound above its default,
  and `toolHints: true` (an MCPL server takes hints when the setting is left
  out; a modern server ignores the default).
  A setting
  that only takes something away, or repeats a default, is already
  satisfied, so it is accepted: `enabledFeatureSets` and the rest of
  `enabledCapabilities`, which are allow-lists, `disabledFeatureSets`,
  `disabledCapabilities`, a scope's `blacklist`, `channelSubscription:
  'manual'`, a `toolLifecycle.maxInputBytes` or an `autofetch` bound at or
  below its default, and `shouldTriggerInference`.
  So a host that puts a deny-list on every server it deploys can deploy a
  modern one.
- `requestTimeoutMs` is one deadline per tool call and must be 1 to 2^31−1;
  0 is refused, where MCPL reads it as no watchdog.
- Over stdio it takes no credential: `token` or `accessProvider` on one is
  refused.

At the deadline, cancellation is requested for a leg still in flight;
between the rounds of an `input_required` continuation nothing is in flight
to cancel. Either way the outcome is reported as unknown (`no-response`),
and the call is never retried. The protocol has no cancel for a paused call,
so whatever the server holds for it, beyond the `requestState` it gave this
client, stays until the server lets it go. A call that ends for any other
reason after the server asked for another round, before its final answer, is
reported the same way, since the server may already have acted. An MCPL
server that refuses `2024-11-05` with `-32022` fails with
`McplProtocolVersionError`, and is not retried. The error names the
revisions the server says it supports ("none listed" for an empty list), or its error text when it sends no list,
and when the list includes `2026-07-28` it says to configure the server with
`protocol: 'modern'` (stdio) or reach it over http(s).

Server and transport text the framework records has the server's configured credentials replaced, in both engines. That covers connection traces, console lines, stderr traces, ops alerts, and a tool call's failure as its caller, the model and the `tool:failed` trace get it. The credentials are those the configuration holds and those its dials sent: from the url as each dial sends it (a WebSocket dial sets the token in the query, which writes the whole query again, form-encoded, and an access provider's token can be in it; with `tokenTransport: 'header'` it sets none), credential-like path segments and query names, credential-shaped or credential-named query values, and a WebSocket url's userinfo, in their encoded and decoded forms, replaced wherever they occur; every non-empty query parameter as its whole `name=value`, where no letter or digit adjoins it; the static `token`, and each token an access provider handed a dial, the newest sixteen, raw and url-encoded; and a stdio server's `env` values whose names have a part ending in a credential word, such as `GITHUB_TOKEN`, `PGPASSWORD` or `SESSION_COOKIE`, raw and url-encoded. A stdio server's command and arguments aren't derived. Standalone strings shorter than eight characters stay unchanged because they may be ordinary words; short query values are still removed with their parameter names. Treat a submitted configuration as immutable while the server uses it: apply changes with `restartMcplServer(id, newConfig)`. Secrets neither the configuration holds nor a dial sent remain outside this filtering. A JSON-RPC tool answer's result passes through as sent. No error a host's own call gets, whether thrown, rejected with or in an error answer's data, carries a credential this filtering replaces, whoever wrote its words: a server's words are redacted, then bounded, where an error is built from them, the strings in an error answer's data are redacted, and an error a library raised, such as a failed modern connect's, is handed on as its name and its redacted words alone. A stdio child that couldn't be started is refused with Node's words redacted, stopping before Node's quote of a value it refused at once, and a cause that keeps Node's error's name, those words and its `code`. With a configuration that can't be read, the server's words and data are withheld. A failed handshake's `stderrTail` is the end of the server's stderr, with every credential of up to 14,336 characters that reaches into it replaced whole. A number in an error answer's data is matched as JavaScript reads it, so one with more significant digits than a double holds has lost its last digits before it's matched. A close's or a cleanup's failure carries the transports' own words, a child's pid, its server's id and the wait it was given. A connection's events are inputs to the framework's records, which redact them.

#### Feature sets

`enabledFeatureSets` and `disabledFeatureSets` select which of a server's
declared feature sets are enabled (`.`-segment wildcards such as `chat.*`;
`disabledFeatureSets` wins on overlap):

- `enabledFeatureSets` omitted: every declared set is a candidate.
- `enabledFeatureSets: []`: no set is enabled.
- In both cases a set is enabled only if its declared `uses` lists
  recognized capabilities that the server's grant covers. A set that declares
  no `uses` stays disabled even when `enabledFeatureSets` lists it. This is
  reported on the console and as an `mcpl:feature-set-disabled` trace.

A server that refuses the host's policy is reported as an `mcpl:policy-refused`
trace. With `fallback: 'close'` the host closes the connection; with
`'mcp-only'` only plain MCP tools keep working.

#### Event coalescing (RFC-006)

The host advertises `eventCoalescing` (both lanes, deferred rendering,
channel-scoped pushes, a one-hour retry window). A server may add
`coalesce: { key }` to a `push/event` or a `channels/incoming` message so that a
later occurrence of the same subject **replaces** the earlier one while it is
still unread, and **appends** once it has been read (both defined below);
`retract: true` withdraws unread content and appends the supplied deletion
notice only when some version was read (or history is unknown). `initial: true`
on a create lets the host know the subject's history is complete, so a create →
edit → delete that nobody read leaves no trace. `deferred: true` (push only)
holds a batch of notices outside context and asks the server for the content
with `push/render` when a turn is assembled. Each render describes what changed
since the one before it, so neither a later render nor a notice replaces an
earlier render the model hasn't read: the newer render lands after it, and a
retraction or a later plain occurrence withdraws the unread renders, newest
first.

Plain content stays in context and is delivered on arrival through the ordinary
channel/push path; the host only remembers where it landed. "Unread" means:
above the agent's consumed watermark (set when the agent is created, and
advanced at every compile of a request it sends, which a preview isn't, and at
a tool boundary that injects messages into a stream declaring it carries them,
as membrane's native path does from 0.6.0), on the current branch, not a
sharded message, and not folded into a summary by compression. A stream that
doesn't say whether it carries injections is taken as one that doesn't: at a
tool boundary nothing is injected into it, and what's queued waits for the
turn's end. On any doubt — restart, branch switch, eviction — the host
appends, as it does today. There is no per-subject cap: a busy channel's unread
backlog is simply its unread backlog. Receipts and subject history are kept in
the `mcpl/coalescing` state (retry window 1 h); audit lines are
`mcpl:coalescing` trace events.

#### Tool presence and toolsets (RFC-014)

Every MCPL server is offered `experimental.mcpl.toolHints` unless its
configuration sets `toolHints: false`, and its hints count only if it
advertised `toolHints` too. A server that doesn't advertise them lists every
tool as before. With `toolHints: false` on a server, the host advertises and
reads nothing new for it. The `toolsets` module below is registered at
creation in any case, since the host's own toolsets use it. A modern (MCP)
server never has hints. Only a module given to `create()` can hold the name
`toolsets`: MCPL servers that leave the setting out then have none, and a line
says so. A server `toolPrefix` of `toolsets` is refused.

With hints in effect, the server's static tools stay in the tool list as before, and its
dynamic tools (those in a toolset, or hinted `mcpl/presence: "dynamic"`) never
enter it, since every change to the list rebuilds the prompt cache. The
framework registers a `toolsets` module with four constant tools at creation,
for every agent (the host's own toolsets need them too, below), so the tool
list doesn't change when a server starts to present:

- `toolsets--open {server?, toolset?, instance?, options?, full?}` opens a
  server's toolset (`server` and `toolset`), or a named instance of one, and
  answers with what the server shows on opening and the tools usable now;
  `server` alone opens the server's tab and `toolset: "settings"` alone the
  host's built-in toolset (below);
- `toolsets--act {server?, tool, instance?, args?}` calls a dynamic tool down
  the same path as a direct call of it (the agent's `allowedTools`, the
  server's tool policy, the state exchange, the reading of its result, RFC-007
  observers and RFC-008 class rules, which see the server's tool and its class),
  with only the instance added, in
  `_meta["mcpl/instance"]`. It first checks `args` against the definition in
  force for that instance; that check is bounded, and leaves `pattern` and
  anything nested or branching too far to the server, which checks every
  call itself;
- `toolsets--look {server?, toolset?, instance?, tool?}` restates what is open
  and what can be opened, or one tool's signature, description, class and
  input schema. It
  re-reads each server that presents toolsets first, and says so when it
  couldn't; what that changed
  is in the answer when look restates everything, and otherwise told as a
  notice;
- `toolsets--close {server?, toolset?, instance?, disconnect?}` closes it;
  `server` alone moves the server to a tab or hides its open tab, and with
  `disconnect: true` makes it a closed tab (below).

### The host's own toolsets

Beside the toolsets servers declare, the host presents some tools out of the
tool list itself (RFC-014 §8.5 host-made toolsets, §8.1 surface presentation;
`src/host-presentation.ts`). It's host presentation, not an MCPL wire change,
and works for every server, with or without RFC-014. The `toolsets--` tools
are registered for every agent, MCPL or none, unless a module holds the name.

- **The built-in toolset, `settings`.** The host tools an agent reaches for
  rarely: `agent_settings`, `wake_add_rule`, `wake_remove_rule`,
  `gate_status`, `event_tags`, `set_tool_visibility`, `set_tool_description`,
  `heartbeat--heartbeat_status`, `heartbeat--heartbeat_trigger`,
  `workspace--status`, every module utility (`Module.getUtilities`), and a
  module's tools it places there (`Module.toolPlacement` answering
  `'builtin'`). None is in the tool list. `toolsets--open {toolset:"settings"}`
  announces them, `toolsets--act {tool, args}` calls one while it's open, under
  its own name and permissions, its `args` checked against the definition first, `toolsets--close {toolset:"settings"}` closes
  it, and `toolsets--look {toolset:"settings"}` lists them either way. A
  server's own toolset named `settings` is reached with its `server` named.
- **Server tabs.** Each MCPL server is presented to each agent one of three
  ways: `full` (its tools in the tool list, the default), a `tab` (connected,
  its events still arriving, none of its tools in the tool list:
  `toolsets--open {server}` announces them and lets `toolsets--act` call them,
  named in full or bare with `server`; `toolsets--close {server}` hides them
  again), or a `closed-tab` (disconnected until `toolsets--open {server}`
  connects it again, with its configuration and credentials, an
  `accessProvider` asked afresh). `toolsets--close {server}` moves a full
  server to a tab, `toolsets--close {server, disconnect: true}` disconnects it,
  and `toolsets--open {server, full: true}` puts it back in the tool list. A
  server's configured `presentation` (`'full' | 'tab' | 'closed-tab'`) is where
  each agent starts; what an agent chose is kept across restarts. A
  connection is the host's, so a closed tab is disconnected for every agent of
  the host, and `disconnect` is refused while another resident agent has the
  server in its tool list or its tab open, or can't use the meta-tools (it
  has every server in its list, and couldn't open a closed tab again). A
  disconnect that fails changes nothing. An operator's own connect of a
  closed tab ends it, and an operator's disconnect forgets the server's tab.
- **Hidden tools.** A tool an agent hides with `set_tool_visibility` leaves its
  tool list for the built-in toolset, or its server's tab, and comes back when
  shown. The `toolsets--` tools can't be hidden.

The tool list changes only when a server moves between full and a tab or a
tool is hidden or shown, one prompt-cache write each; opening, acting in and
closing a host toolset never change it. Which host toolsets an agent has open,
and each server's presentation where the agent changed it, are kept in
`<storePath>/config/toolsets.json`. An open host toolset whose announcement has
left the context is reminded of, as a server's toolset is (§8.3). A call of a
tool the agent may call by name still works by name; the tool list just
doesn't carry it. `framework.presentedTools(agentName, tools, canUseMeta?)`
applies this presentation to a tool list, so a host can tell a stream that
isn't registered yet (a fork, before its run starts) what its first request
will carry.

`server` can be left out when only one server has the name. By our reading of
the code, a server with no toolsets stops presenting them once its latest `tools/list` has no dynamic
tool, so until the rebuild, act takes its last one only with `server` named.
Hint changes apply
as their message is read, in `rev` order, whatever becomes of the message (a
refused push, a result that came after its timeout). A move between static and
dynamic takes effect when the server's `tools/list` states it, and the tool
list follows at its next rebuild that lists the server, whichever refresh
brings it (a move is no reason to rebuild the tool list early). Until then the
tool is called at either place, where the tool list shows it or where the
server's latest list put it (RFC-014 §4.2 keeps it working where it is until
the move applies), and
once that rebuild has published the list, a notice says where it went. A list
read while a rebuild is under way can undo a move that rebuild then publishes;
neither is told, and the next rebuild puts the tool back.
A skipped rev re-reads `tools/list` and then `toolsets/list`, which the host
also reads after every (re)connect, adopting what the server kept open and
never re-opening anything.
What changed is told where it happened: after a call's own result, after the
push that explains it, or as a notice (`kind: 'mcpl-toolsets'`, which wakes
nothing) for a standalone `tools/hints`, a late result, an adoption, a
recovery, or a call whose result may not reach the agent (a script's, a
module's or a host's, or one the framework makes itself); an open, close or
look made that way also shows its caller the change, unless the change has
already gone as a notice (below). A dynamic tool's change also goes as a notice
when it wouldn't fit whole within its result's inline cap, or when its call
fails after the result was read. A call's change also goes as a notice, ahead of its
result, when a later change goes to the agent before the call's caller has
taken it, so changes are told in the order they were read (the agent's window
can still show a call's result, a push's event, or a change its taker couldn't
show after a change read later). The model's own call's change counts as told
once its result is handed back: if the turn is stopped while the call is out
(or, by our reading of the code, the agent is gone), the result is dropped and the change with it, and
`toolsets--look` shows the state it left. Notices and reminders
need the server's `pushEvents` grant, like any delivery; without it, a change
that would go as a notice is dropped, and `toolsets--look` shows the state. A new tool's first sentence is told with its
definition until text describing it has reached the model, except that, by our reading of the code, a puppet's
open, close or look whose result the store refuses has already counted it. Suggestions are shown, never acted on. Each
`ended` id is told once while the
host runs (told ids are kept in memory), short of rare interleavings, such as a
`toolsets--look` overlapping other reads of the same server, that can tell one
twice. When an
open toolset's announcements have left an agent's context (compressed or out
of the window), the module's `gatherContext` restates what is open, as a
stored `afterUser` injection (namespace `mcpl-toolsets`), at that agent's next
start.

A dynamic tool called by its prefixed name is refused, pointing at
`toolsets--act`, unless the tool list or the server's latest list shows it as
static (a move waiting for its rebuild). Calls to an undeclared toolset's
tools are refused while the host has that group closed (RFC-014 §5.4), except
by a tool's listed name until the rebuild that publishes its move into the
group. Projection and surface mode are not implemented: a `surface` server's
static tools are listed like any server's.

#### Per-channel conversation routing (deprecated)

> **Deprecated: `FrameworkConfig.conversations` (`ConversationRouter`).** Per-channel conversation routing sends each channel's traffic to its own fork agent, spawned from a template agent and closed after an idle TTL. It is being retired ([#235](https://github.com/anima-research/agent-framework/issues/235)). Its `'mention'` bind/trigger rule, the default for channels, reads `metadata.mentioned`, which discord-mcpl does not set, so on Discord channels an @-mention never binds a fork or triggers a bound one. Don't adopt it in new hosts. Existing configurations still route exactly as before, and the framework logs one `[deprecated]` line when it is created with `conversations` set. Removal is a follow-up.

### Streaming Lifecycle

1. **Start**: Framework calls `agent.startStreamWithInjections()` → `YieldingStream`
2. **Drive**: Framework iterates stream events (tokens, tool-calls, complete, error)
3. **Tool yield**: Stream yields tool calls → framework dispatches concurrently → collects results
4. **Resume**: All results in → stream resumes with tool results
5. **Budget restart**: If input tokens exceed `maxStreamTokens`, the stream is cancelled, context is recompressed (the turn's opening messages kept whole, as Context Management says), and a fresh stream starts. An agent whose model binds its thinking (`thinkingBinding.binds`) with `physicalWindowTokens` set skips this, and the window projection restarts it instead before a request the window can't hold
6. **Complete**: Final response saved to context, agent returns to idle

### Inference bounds

A model call that stops making progress is cut, so an agent isn't held by a provider that has gone quiet, or that keeps its connection open with keepalives (an Anthropic stream's pings, SSE comments) and never answers.

- **A resident's streamed call**, and an MCPL server's streamed inference request, get membrane's progress bounds where the adapter's stream reports content (`AnthropicAdapter`, `BedrockAdapter`). Before content, a call ends 60 s after its send, or, once a thinking block has started, at the later of that and the block's allowance, its `max_tokens` at 87 tokens a second. Once content has begun, it ends after 150 s without a provider event, or after the block's allowance when the last event was a thinking block's start and the allowance is longer. Membrane's README gives the rules whole.
- **Every streamed call the framework makes** also gets a flat bound from its last provider event: the larger of a setup term plus that allowance and 1,862 s (`FLAT_MINIMUM_MS`). The setup term is the larger of the before-content and between-events bounds, 150 s by default. So on an adapter with progress bounds the flat bound never runs out first. On one without, such as `OpenAICompatibleAdapter`, it's the only progress bound, and an SSE keepalive comment doesn't restart it, though a data frame that parses as an event does, a provider's own ping object included.
- **A whole non-streamed call**, a compression's, the reply judge's, or an MCPL server's non-streamed inference request, ends the setup term plus its allowance after its send, or, when it names no `max_tokens`, at the larger of the setup term and the flat minimum, unless its caller passed a `progressTimeoutMs` of its own. Its caller gets the `timeout` error. The event gate's own 20 s judge timeout ends the reply judge's call first at the defaults. Context-manager takes a cut compression call as a transient failure: the lane pauses and tries again, so compression that never lands within its bound shows as a lane that keeps pausing, not as a failed turn, and is a reason to raise the bound. On an adapter whose `complete()` streams under the hood, such as membrane's OpenAI Responses adapter in subscription mode, membrane renews the bound at each parsed provider event, so there it runs from the last event, as a stream's flat bound does.
- **A turn's call a bound cuts** fails as a `timeout`, and `DefaultErrorPolicy` gives it one fresh call, 1 s later, whatever other failures its turn had, except in a turn sent again after its retries ran out, before one of its rounds has run or had its tool calls cut off, whose failures get no retries. A fresh call that's cut too, with no other failure between, ends the turn, and its `[inference-failed]` note says the call timed out, that the call was made again and timed out again, and the reason. For a bound's cut the reason names the bound that ran out and the host's setting for it. A deadline expiry membrane throws (the Anthropic adapter's own watchdogs, the SDK's request timeout, a runtime's fetch timeout on a silent connection) counts the same toward the fresh call and the turn's end, and its reason is its own message, which names no setting. A bound's cut isn't `retryable`, so a host's own `errorPolicy` that retries only retryable errors gives it no fresh call; an expiry membrane throws stays `retryable`, as membrane made it.
- **A stream that keeps sending content** isn't ended by any of these, since content is progress.

These bounds don't replace the deadlines below them: a silent connection still meets the runtime's own fetch timeout (360 s on Bun 1.4.4) and, on `AnthropicAdapter`, the adapter's 600 s first-event and idle watchdogs, so on a silent connection a bound raised past those is met by them first.

The phase bounds, and a reason that names the bound that ran out, need the `Membrane` a host passes in to come from membrane 0.8.0 or later. An older one ignores `progressBounds`, so only the flat bound acts, and a cut's reason names no bound.

The flat and whole-call bounds read the request's `maxTokens`. A `max_tokens` set through `providerParams` or a hook isn't read, where membrane's own allowance reads what's sent, so a larger one set that way can let the flat bound run out before membrane's.

Where the values come from: membrane's README gives its progress bounds' measurements, on a production router's streamed Anthropic calls to `claude-opus-5-5` and `claude-haiku-5-5`. The flat minimum is the longest silence between frames of any completed call in that router's OpenAI calls (the Responses API over a WebSocket), standing in for an OpenAI-compatible stream, which wasn't measured. The whole-call bound's setup term is five times the longest wait from the send to content or a thinking block's start in those calls (a wait that router cuts at 30 s and sends again, so a longer one is unseen), and its allowance is generation at 87 tokens a second, the 1st percentile of Opus's thinking speed over its thinking blocks of 30 seconds or more. No completed streamed call in that record ran past the whole-call bound. Bedrock, other models (`claude-opus-4-6` among them), OpenAI-compatible streams and calls that aren't streamed, compression's among them, weren't measured, so a host whose calls run slower raises the bounds with `inferenceBounds`. Membrane's README also reports the wait for content growing with the prompt, so a resident near a full context window is the likeliest to meet the before-content bound first.

`inferenceBounds` sets them: `progressBounds` takes membrane's three values, from which the flat and whole-call bounds also derive, and `flatMinimumMs` the flat bound's least. `false` sets none. One setting covers every agent, so a host with one slower model or adapter raises them for all of its agents. A stream cut's reason is membrane's message, naming the bound that ran out, followed by the host setting for that bound, as in ``(the host's setting for this bound: `inferenceBounds.progressBounds.beforeContentMs`)``. A whole call's caller gets membrane's message alone. Each reason's opening and its setting:

| The reason begins | The setting | Default |
|---|---|---|
| `No content within …s of the send` | `progressBounds.beforeContentMs` | 60,000 ms |
| `No provider event within …s` | `progressBounds.betweenEventsMs` | 150,000 ms |
| `No content within …s of a thinking block's start` (or `No provider event within …s of a thinking block's start`) | `progressBounds.thinkTokensPerSecond`: a lower rate allows a slower think | 87 |
| `No provider progress within …ms`, on a stream | `flatMinimumMs`, or the setup term and allowance when they're larger | 1,862,000 ms |
| `No provider progress within …ms`, on a call that isn't streamed | the setup term (`beforeContentMs`, `betweenEventsMs`) and the allowance (`thinkTokensPerSecond`, or the request's `maxTokens`); the larger of the setup term and `flatMinimumMs` when the request names no `maxTokens` | 150 s plus `maxTokens` at 87 a second; 1,862,000 ms with no `maxTokens` |

Each cut of a turn's call is traced as `inference:failed`, with its reason as `error`, and logged with the turn's inference log as a failed call, whether or not its fresh call then answers, so a host can count cuts a resident never sees and raise a bound before turns start failing. An MCPL server's request that a bound cuts is traced as `mcpl:inference_fail` with the reason as `error`, and a compression or reply-judge call's cut reaches only its caller, as the `timeout` error.

### Abort / Cancellation

```typescript
// Cancel in-flight inference for an agent
framework.abortInference('assistant', 'user requested stop');
```

The non-streaming path uses `AbortSignal` forwarded to `membrane.stream()`, which returns an `AbortedResponse` with partial content. The streaming path cancels the `YieldingStream` directly.

A turn whose stream is cancelled this way, or by `agent.cancelStream()`, ends as a stop, whether the stream reports the cancel as `aborted`, as an `error`, or by just closing: one `inference:aborted` carrying the caller's reason (`user` when none was given), a `[turn-interrupted]` note in the agent's context, and never `inference:exhausted`, which is for failed inferences. A stream that membrane aborts on its own, at a deadline or on an error (reason `timeout` or `error`), is a failed inference. `stop()` and an operator's quiesce abandon end a turn as a stop too, with their own reasons, `shutdown` and `quiesce_abandoned`, and write no note, except the `[speech-not-posted]` notice when the turn's rounds left speech unposted (XML tool mode, or a membrane without `roundContent`; see below). A stopped stream still writes its inference-log row, with `success: false`.

A caller's stop and an operator's quiesce abandon also reach a turn that has no live stream: one running its modules' `gatherContext`, its MCPL hooks or its compile, one waiting to retry a failed inference or compile (`abortInference()` and an operator's abandon end the wait, and a stop through `Agent.cancelStream()` waits for it to run out), and one whose tool-result guard is waiting to retry after a refusal, which holds only the round's finished stream. The turn ends at its next check, before it sends anything more, as a stop on a live stream ends it, and a turn whose compile fails after the stop ends at the failure, before a provider hold, the error policy's retry or `inference:exhausted`. A caller's stop leaves the note saying the turn was stopped before it sent anything or before it finished, and an operator's abandon leaves none, except the `[speech-not-posted]` notice when the turn's rounds left speech unposted. `abortInference()` returns `true` for such a turn. In the guard's wait, `stop()` ends the turn as a stop with reason `shutdown`, and an operator's abandon ends it as the abandon, even when a caller's stop came first; with both, it ends as `stop()`'s. `stop()` drops a turn in its hooks, its compile or a wait to retry before it sends anything, as before, and drops one whose compile fails while it runs, once a caller's stop has reached it, rather than ending it as that stop. While the failure of a turn's stream is reported (`inference:failed`), the agent no longer holds that stream, so `abortInference()` from a listener reports `false`. A failure to build a turn's request is reported while the turn's check is still ahead, so there `abortInference()` reports `true`, and the turn ends at that check. A caller's stop made where no check of a turn is ahead stops nothing, and doesn't end the agent's next turn: while the agent is idle, while a turn finishes its last delivery, and while a non-streaming turn's tool results wait to start the turn's next call. A turn whose continuation (a budget restart's, or a tool-result guard's retry) waits to start, or whose failed call a provider-capacity hold or a provider's stated wait keeps for its retry, is ended by `abortInference()`, by an operator's quiesce abandon and by `stop()`: the continuation or retry is dropped, and the turn ends with the caller's reason, `quiesce_abandoned` or `shutdown`. After `abortInference()` or an abandon, wakes that arrived meanwhile still run (after the abandon, once the host resumes): those a hold keeps beside the retry, and those the scheduler merged into the retry's or the continuation's start before that start began, which the stop or the abandon puts back in the queue. A stop through `Agent.cancelStream()` stops nothing there.

In XML tool mode, or with a membrane that gives a tool round no `roundContent`, such a round's speech reaches a channel only when its stream completes. When the stream ends any other way (a failure, a stop, a tool that ends the turn, an error policy's retry, a context-budget or tool-result-guard restart, a quiesce abandon or `stop()`), the rounds' words are already in the agent's context, and a `[speech-not-posted]` notice tells the agent that nothing it wrote before its tool calls in those rounds was posted, so it can send what should go out again. It's written once for those rounds: where the turn ends, or before a retry's or a restart's request is sent. A turn its own `skip_reply` ends, a silent turn, a round still waiting on its tools when its stream ends (which never reaches the context) and the rounds of a stream that completes get none. In XML tool mode with thinking on, a round whose text was only thinking gets the notice too, since the framework has only the round's raw text there. A failed turn's `[inference-failed]` note says that its earlier rounds ran when any round reached the context with its results, and that a round's tool calls were started and may have taken effect when any of its streams ended before that round's results came back; a caller's stop says the latter in its `[turn-interrupted]` note too. A turn that fails, or that a caller stops, writes no `[delivered]` receipt, so when its rounds' plain speech was delivered live (native tool mode, in locus or hybrid routing), its `[inference-failed]` note, or the stop's `[turn-interrupted]` note, says that speech was handed on for delivery as written and that no `[delivered]` line was written for it. When some of its speech was still being routed as the turn ended, the note also says it may yet be posted and to check the channel before sending it again. A delivery that finished undelivered gets neither: a channel delivery's `[discord-send-failed]` note, or a refused `>>>` envelope's bounce, already says what happened. A quiesce abandon and `stop()` write neither note.

## API Server

WebSocket server for external clients (UIs, scripts, other agents).

```typescript
const server = new ApiServer(framework, { port: 8765 });
await server.start();
```

**Commands:** `message.send`, `message.list`, `inference.request`, `inference.abort`, `branch.*`, `agent.*`, `module.*`, `store.*`, `inference.tail/inspect/search`, `events.*`, `host.quiesce/resume/status/maintenanceTick`, `host.providerWaits/releaseProviderWait`

Also available as an MCP server via the `agent-framework-mcp` binary (`npx -p @animalabs/agent-framework agent-framework-mcp` without installing it). It is a client of this API's WebSocket server, at `AGENT_FRAMEWORK_WS_URL` (default `ws://localhost:8765/ws`), and offers a subset of these commands as tools; its `tools/list` names them.

### Host quiesce / maintenance mode

Pause the inference thread and MCPL data planes while keeping the framework,
context managers, and membrane hot — so compression/refold/quarantine work runs
through the live machinery instead of offline scripts (issue #122). Quiesce
persists across restarts; `resume` gates on a fresh per-agent feasibility
preview of the current runtime settings (`force` overrides).

```typescript
await framework.quiesce({ reason: 'refold', timeoutMs: 120_000, abandon: false });  // throws QuiesceBlockedError if the deferred writes can't reach disk
await framework.maintenanceTick();   // drain quarantine / advance merges
await framework.resume();            // throws ResumeBlockedError if the layout won't compile
```

Also reachable over HTTP (`POST /quiesce`, `POST /resume`,
`POST /maintenance/tick`, `GET /hostmode`; options via query string) and as
`host/command` verbs (`quiesce`, `resume`, `maintain`, `host-status`) from MCPL
servers granted `allowHostCommands`. The same servers can lift a provider's
stated wait with `release-provider-wait` (`agentName`, optional `model`), as
`host.releaseProviderWait` does over the WebSocket API, and
`host.providerWaits` lists the waits that bind. The HTTP host verbs accept an
optional shared secret (`ApiServerConfig.adminToken`, sent as `x-admin-token`)
for deployments that front the port with a proxy.

### Live surgery and Discord awareness marks

`rollbackToMessage(agent, { messageId })` forks the agent's context at a
message and switches to the fork; `suppressMessages(agent, { messageIds })`
forks at the head and removes the chosen messages on the fork. The source
branch stays intact either way. Removing Discord messages from an agent's
context is local to that agent unless the operator also chooses to mark them:

```typescript
const preview = framework.previewSurgeryMarks('cairn', { rollbackTo: messageId });
// preview.scopes.addressed / .all: count, per-channel counts and refs
const result = await framework.rollbackToMessage('cairn', {
  messageId,
  marks: { scope: 'addressed', refs: preview.scopes.addressed.refs },
});
// result.markers: { status: 'none' | 'queued' | 'not-scheduled', ... }
```

- **`marks`** is `'none'` (the default), or `{ scope: 'addressed' | 'all', refs? }`.
  `addressed` covers messages tagged `chat:addressed` (mentions, replies to
  the bot, DMs). Passing a preview's `refs` binds the choice to exactly that
  set: messages that arrive before the surgery applies are removed locally but
  never marked. Any other value is refused (`invalid`), never guessed. The
  choice is recorded in the operator log.
- **The surgery returns once marks are scheduled**, never after Discord has
  accepted them. `result.markers` says whether they were scheduled (`queued`
  with a count and batch id), not chosen or not in scope (`none`), or not to
  be delivered because recording the batch as active failed after the body
  change (`not-scheduled`, whose `error` says why, and whether the batch was
  retired or stays prepared for a start to retire). Every receipt also counts the removed messages left
  unmarked. Marker bookkeeping never fails or undoes an applied rollback or
  suppression; a batch that can't be recorded before the body change stops
  the surgery before anything changes (`failed`).
- **Delivery runs in the background** and never holds MCPL traffic or turns.
  MCPL's own hold stays: a connection whose policy exchange is in flight,
  after a connect or a reconnect, keeps both planes closed until the
  exchange settles, since its traffic is admitted against the grant the
  exchange establishes. A route that is not connected keeps its work queued
  until it connects.
  Each reaction call has a mandatory deadline independent of
  `requestTimeoutMs` (including `0`): `discordAwarenessDeadlineMs` (default
  10000ms, clamped to 50..60000ms). The emoji is `discordAwarenessEmoji`
  (offline: `--emoji`). Nothing more is sent for a mark after three
  unconfirmed attempts at it (Discord refused it, or no answer came and so
  it may have landed, one left on the wire when the host stopped included;
  an attempt refused before it left the host doesn't count), or after a
  refusal no retry can change (the message, channel or emoji is gone, access
  is missing, or the message takes no more reactions); a pass that gives up
  on marks raises one `discord-awareness-delivery` ops alert, and so does a
  start whose reconciliation gives up on any. A JSON-RPC error answer, which
  may come after the server acted, counts as unanswered, unless it is such a
  refusal. A mark whose request failed in a way a retry could change is sent
  again by the next delivery pass: after a surgery, a retract, a start, a
  connect or reconnect of its route, a tools-list change, or an operator's
  sync, and a trigger that meets a pass already running has that pass try
  it once more before it ends.
- **Marks are one-shot.** Switching branches, a turn undo, a redo and
  restarts never request a mark or a removal of their own: what goes out is what a surgery
  (the marks chosen for it) or a retract recorded, and a start's delivery
  sends what of that hasn't gone out. The ledger is a table with one entry
  per reaction (route, channel, message and emoji): what the acts that still
  stand want of it, whether Discord is owed a request for that, and what
  Discord last answered. It is a JSON file outside Chronicle,
  `<store>/recovery/discord-awareness-outbox.json` (or
  `discordAwarenessOutboxPath`), so it survives rollbacks, branch deletion
  and a killed process. Each request is written ahead before it leaves, and
  the next one is chosen from the ledger as it is then, so a cancel takes
  effect even while an earlier request is on the wire. A request written and
  never answered is kept as one that may land, whatever Discord answers
  later. Between opposite wishes for one reaction, the later act wins: a
  surgery's marks carry the moment of its choice, even when activation comes
  later, so a retract made in between prevails, and cancelling it revives
  nothing. A write goes to a temporary file renamed over the ledger, synced
  with its directory and that directory's parent, as the framework's own
  recovery files are: one that fails leaves the ledger as it was, and a
  directory that can't be synced after the rename raises the `recovery-sync`
  ops alert while the write stands. A write that activates, completes or
  retires a batch syncs the store first, so it never outlives the change it
  certifies. A ledger that can't be read, or holds a version this build
  doesn't read, stops a start. A running host holds the ledger in memory and
  reads the file again only after a write failed; while it then can't be
  read, nothing is sent, the delivery alert says so, and the controls
  refuse.
- **A start never activates a surgery's marks.** A batch an interrupted
  surgery left prepared is retired at the next start, none of its marks
  sent. One that had marks to apply raises a `discord-awareness-not-scheduled` ops alert that names the
  surgery, its agent and its branches, and the redo that applies the marks:
  run the surgery again from the source onto a new branch name, choosing
  marks again, if the source still has every message the surgery removed (a
  `hide` there, or the source's deletion, changes that). A batch doesn't say
  which surgery made it, so the alert names an offline recovery beside a
  rollback or a suppression. One with none to apply (none chosen, or its marks cancelled) is
  only logged. An interrupted suppression's removals are still finished, at
  the first start on its branch, and its batch is retired then. Until then
  a start on any branch with that name would apply those removals there.
- **Operator controls,** each that changes the ledger recorded in the
  operator log (a list or a preview records nothing); once `stop()`
  has begun, cancel and retract refuse, like every operator entry
  point:
  - `listDiscordAwareness()` lists batches and retract requests, each with
    its reactions counted by state (`queued`, `sending`, `present`,
    `absent`, `unknown`, `failed` or `untouched`) and how many may still land;
  - `cancelDiscordAwareness(batch | retractRequest)` stops a batch's marks or
    a retract's removals from being sent or sent again, and never removes or
    undoes anything. Its receipt counts what it stopped before any request
    went out (`cancelled`), what Discord last confirmed as the act wanted
    (`confirmed`), and the act's reactions with a request on the wire or one
    never answered, any of which may still land (`mayStillLand`);
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each address's configured MCPL route, for every message
    of the batch (or of every batch that isn't retired, whether prepared or
    active, and every reaction the ledger holds), whatever was answered
    before: removing an absent reaction does nothing. As the latest act on
    those reactions, it replaces the adds owed there and any an earlier
    choice would owe later (a prepared batch's activation); cancelling it
    never revives them. Its receipt counts the reactions on which an add may
    still land, on the wire or never answered (an unanswered removal can't
    bring a mark back).

  Both are async. A request the ledger won't carry out (an unknown batch or
  retract request) is refused as `invalid`; a failure to read or write the
  ledger is `failed`. A framework with neither `storePath` nor
  `discordAwarenessOutboxPath` has no ledger: it refuses a marks choice as
  `invalid`, and so do its controls.
- **Over `host/command`** (servers granted `allowHostCommands`): an `undo` by
  messages takes `marks: 'none' | 'addressed' | 'all'` (default `none`; any
  other value is refused) and returns `markers`. It holds the store like
  every surgery, so it is refused while any agent sharing the store is
  mid-turn. `hide` and an `undo` by turns place no marks, and refuse a
  `marks` choice other than `none`. The `marks` verb takes `action: 'list'
  | 'cancel' | 'retract'` with a `target` (a batch id; for cancel also a
  retract request id; for retract also `all`).

The ledger is version 3. A version 2 ledger, agent-framework 0.22.x's at the
same path, is rewritten as version 3 in place by its first write: at a start,
or an offline recovery. Each of its batches keeps how many of its messages
0.22.x's last attempt saw a mark added to (`legacyAdded` in the list), never
as a claim about what is on Discord. The work 0.22.x had still to do is never
sent, since nobody chose it: a batch it never activated is retired (a
suppression whose body may be pending, once a start on its branch finishes
the body), and pending adds and removals are dropped. A batch it activated
stays active, its body taken as finished, as 0.22.x took it. The rewrite names
each batch that had such work, with how many adds and removals, on stderr
wherever it runs, and in a `discord-awareness-import-unsent` ops alert at the
host's start that made it. A batch 0.22.x never activated placed no marks; a
retract of a batch takes off the mark of its emoji from each of its messages,
whichever batch placed it. 0.22.x reads only versions 1 and 2, and its start
stops on a version 3 file: to go back to 0.22.x, move the file aside first,
and 0.22.x then starts with no marks history. A version 1 ledger, which only
an unreleased commit wrote, is refused as any version but 2 and 3 is, until it
is moved away.

## Observability

Subscribe to trace events for logging, UI updates, or debugging:

```typescript
framework.onTrace((event) => {
  // inference:started, inference:completed, inference:aborted
  // tool:started, tool:completed, tool:failed
  // process:received, process:completed
  // message:added, module:added, module:removed
  console.log(event.type, event);
});
```

Trace events are observability-only. They are intended for logs, metrics, UI
updates, and debugging, not framework-internal control flow. Internal lifecycle
code should use state-machine signals or process events instead of consuming
traces, so trace emit order does not become an API contract.

Query raw inference logs:

```typescript
const logs = framework.queryInferenceLogs({ agentName: 'assistant', limit: 10 });
```

## Dependencies

| Package | Role |
|---------|------|
| [membrane](https://github.com/antra-tess/membrane) | LLM provider abstraction (Anthropic, Bedrock, OpenRouter) |
| [@connectome/context-manager](https://github.com/anima-research/context-manager) | Context window management and compression |
| [chronicle](https://github.com/antra-tess/chronicle) | Branchable persistent event store (Rust + N-API) |

## Development

```bash
npm install
npm run build      # TypeScript compilation
npm run dev        # Watch mode
npm test           # Run tests
npm run typecheck  # Type-check without emitting
```

Requires Node.js >= 22.12. Chronicle requires a Rust toolchain for native module compilation (`npm run build` in the chronicle directory).
