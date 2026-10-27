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
  allowedTools: ['search--query', 'utils', 'files--archive'], // or 'all'
  triggerSources: ['discord'],                   // or 'all'
  maxTokens: 8192,
  maxStreamTokens: 150_000,  // input token budget before stream restart
}
```

`allowedTools` is enforced at dispatch for registered agents. Omission or
`'all'` permits all tools; an explicit list matches exact names, including
`module--utility` names. Utilities aren't tools of their own: an agent's model
and its scripts are offered them only through `utils`, whose `run` checks the
utility's own name. An agent that should use a utility lists both `utils` and
`module--utility`. The name alone passes the dispatch check for any call by
that name, whether the host makes it with `executeToolCall` on the agent's
behalf or the model or a script makes it without being offered it. The slot
is hidden when the agent can use no registered utility. If utilities exist
but none are permitted, `list` returns a failed `ToolResult` with the registered
and permitted counts and migration advice, and a list containing `utils`
logs one warning per Agent instance after registration.
An empty registry still returns a successful empty list.

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

### Event Processing

The framework runs an event loop over a `ProcessQueue`. Each event is processed by all modules, which return `EventResponse` objects. If any response requests inference, the framework compiles context and starts a stream.

**Event types:** `ExternalMessageEvent`, `ToolCallEvent`, `ToolResultEvent`, `InferenceRequestEvent`, `McplPushEvent`, `McplChannelIncomingEvent`, `TimerFiredEvent`, `ApiMessageEvent`, `ModuleEvent`, `CustomEvent`

### Context Management

Each agent has a `ContextManager` (from `@connectome/context-manager`) that maintains conversation history with optional compression strategies:

- **PassthroughStrategy** - No compression, raw message replay up to budget
- **AutobiographicalStrategy** - Chunks old messages and summarizes them into diary entries, preserving recent context uncompressed

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
  and `toolHints: true`.
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
sharded message, and not folded into a summary by compression. A message
injected at a tool boundary whose stream doesn't say whether it carries
injections, as no membrane 0.5.x stream does, stays unread though the model
may have seen it. On any doubt — restart, branch switch, eviction — the host
appends, as it does today. There is no per-subject cap: a busy channel's unread
backlog is simply its unread backlog. Receipts and subject history are kept in
the `mcpl/coalescing` state (retry window 1 h); audit lines are
`mcpl:coalescing` trace events.

#### Tool presence and toolsets (RFC-014)

A server configured with `toolHints: true` (default false) is offered
`experimental.mcpl.toolHints`, and its hints count only if it advertised
`toolHints` too. Without it nothing changes: every tool is listed as before,
and the host advertises and reads nothing new.

With it, the server's static tools stay in the tool list as before, and its
dynamic tools (those in a toolset, or hinted `mcpl/presence: "dynamic"`) never
enter it, since every change to the list rebuilds the prompt cache. The
framework registers a `toolsets` module with four constant tools:

- `toolsets--open {server?, toolset?, instance?, options?}` opens a toolset (or
  a named instance of one), and answers with what the server shows on opening
  and the tools usable now;
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
- `toolsets--close {server?, toolset?, instance?}` closes it.

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
5. **Budget restart**: If input tokens exceed `maxStreamTokens`, the stream is cancelled, context is recompressed, and a fresh stream starts. An agent whose model binds its thinking (`thinkingBinding.binds`) with `physicalWindowTokens` set skips this, and the window projection restarts it instead before a request the window can't hold
6. **Complete**: Final response saved to context, agent returns to idle

### Abort / Cancellation

```typescript
// Cancel in-flight inference for an agent
framework.abortInference('assistant', 'user requested stop');
```

The non-streaming path uses `AbortSignal` forwarded to `membrane.stream()`, which returns an `AbortedResponse` with partial content. The streaming path cancels the `YieldingStream` directly.

A turn whose stream is cancelled this way, or by `agent.cancelStream()`, ends as a stop, whether the stream reports the cancel as `aborted`, as an `error`, or by just closing: one `inference:aborted` carrying the caller's reason (`user` when none was given), a `[turn-interrupted]` note in the agent's context, and never `inference:exhausted`, which is for failed inferences. A stream that membrane aborts on its own, at a deadline or on an error (reason `timeout` or `error`), is a failed inference. `stop()` and an operator's quiesce abandon end a turn as a stop too, with their own reasons, `shutdown` and `quiesce_abandoned`, and write no note. A stopped stream still writes its inference-log row, with `success: false`.

A caller's stop and an operator's quiesce abandon also reach a turn that has no live stream: one running its modules' `gatherContext`, its MCPL hooks or its compile, one waiting to retry a failed inference or compile (`abortInference()` and an operator's abandon end the wait, and a stop through `Agent.cancelStream()` waits for it to run out), and one whose tool-result guard is waiting to retry after a refusal, which holds only the round's finished stream. The turn ends at its next check, before it sends anything more, as a stop on a live stream ends it, and a turn whose compile fails after the stop ends at the failure, before a provider hold, the error policy's retry or `inference:exhausted`. A caller's stop leaves the note saying the turn was stopped before it sent anything or before it finished, and an operator's abandon leaves none. `abortInference()` returns `true` for such a turn. In the guard's wait, `stop()` ends the turn as a stop with reason `shutdown`, and an operator's abandon ends it as the abandon, even when a caller's stop came first; with both, it ends as `stop()`'s. `stop()` drops a turn in its hooks, its compile or a wait to retry before it sends anything, as before, and drops one whose compile fails while it runs, once a caller's stop has reached it, rather than ending it as that stop. While the failure of a turn's stream is reported (`inference:failed`), the agent no longer holds that stream, so `abortInference()` from a listener reports `false`. A failure to build a turn's request is reported while the turn's check is still ahead, so there `abortInference()` reports `true`, and the turn ends at that check. A caller's stop made where no check of a turn is ahead stops nothing, and doesn't end the agent's next turn: while the agent is idle, while a turn finishes its last delivery, and while a non-streaming turn's tool results wait to start the turn's next call. A turn whose continuation (a budget restart's, or a tool-result guard's retry) waits to start, or whose failed call a provider-capacity hold or a provider's stated wait keeps for its retry, is ended by `abortInference()`, by an operator's quiesce abandon and by `stop()`: the continuation or retry is dropped, and the turn ends with the caller's reason, `quiesce_abandoned` or `shutdown`. After `abortInference()` or an abandon, wakes that arrived meanwhile still run (after the abandon, once the host resumes): those a hold keeps beside the retry, and those the scheduler merged into the retry's or the continuation's start before that start began, which the stop or the abandon puts back in the queue. A stop through `Agent.cancelStream()` stops nothing there.

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
preview of the current runtime settings (`force` overrides). While quiesced, a
context write (a module event, an API `message.send`) is stored at once, and
enters the agents' windows at `resume` (#291).

```typescript
await framework.quiesce({ reason: 'refold', timeoutMs: 120_000, abandon: false });
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

An agent's context follows its own window (#291), so the cut is the write
that presented the target: a rollback removes only the rows stored after
that write, and the rows stored before it that the window took after the
target leave the window and wait outside it until the agent's next turn
start, so the cut holds until the agent speaks again (`returnedToArrivals`,
on the result and the preview). Rows that one write presented together with
the target stay after it (`keptInWindowAfterTarget`), since no branch cut
separates them from it: a rollback that only they follow is refused and
names them, and `suppressMessages`, or the host's `hide` by Discord message
id, takes them out. The preview's `neverPresented` counts the messages it
removes that no agent's window holds. The host command's `/undo n` counts
back over the rows of the agent's own slot in its window. A removal in place (a `hide`, a suppression on its fork, a module's
or the coalescer's removal) takes the rows out of every other agent's window
that held them too, each at its own place.

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
an unreleased commit wrote, is refused until it is moved away, and its error
says what that gives up.

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
