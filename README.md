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
  allowedTools: ['search', 'read', 'write'],   // or 'all'
  triggerSources: ['discord'],                   // or 'all'
  maxTokens: 8192,
  maxStreamTokens: 150_000,  // input token budget before stream restart
}
```

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
  gatherContext?(agentName: string): Promise<ContextInjection[]>;
}
```

An `EventResponse` can add/edit/remove messages, request inference, signal tool changes, and atomically update module state:

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

Before inference, modules and MCPL hooks can inject additional context via `gatherContext()`.

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
windows, never compiles message content, activates
the new Chronicle branch, and writes only Discord `{serverId, channelId,
messageId}` metadata to
`<store>/recovery/discord-awareness-outbox.json`. When the host and that
agent's `discord-mcpl` bot reconnect, each addressable discarded message is
marked with 💤. Delivery state is recorded per message: retryable failures
remain queued, permanent deleted/inaccessible-message failures remain in the
audit ledger without blocking later markers. Portal and other non-Discord
records are ignored.

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
Suppressed Discord messages are queued for the same 💤 awareness marker.
Selections that split a sharded body group or a tool-use/tool-result exchange
are rejected. The suppression plan is journaled before the branch switch; if
the recovery process is interrupted between interval removals, framework
startup resumes the remaining atomic intervals before connecting MCPL.
For old stores whose messages lack `metadata.serverId`, supply
`--discord-server discord` (or the configured Discord MCPL server id). The
normal agent host must be stopped while this command has the Chronicle store
open.

The marker sidecar is a retained operation ledger, not a delete-on-success
queue. Switching back to the source branch queues removal of the bot's marker;
returning to the recovery branch queues it again. Initial MCPL events remain
buffered until the ledger has been reconciled. Startup, reconnect, runtime
list-change, and online undo use one framework-global generation: every MCPL
data plane waits while all control planes remain live for registration and
marker service. Awareness marker calls also have a mandatory deadline that is
independent of `requestTimeoutMs` (including when that value is `0`); configure
it with `discordAwarenessDeadlineMs` (default 10000ms, clamped to 50..60000ms).
Configure the online marker with `discordAwarenessEmoji`; the offline CLI
accepts `--emoji`.

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
| `url: 'ws://…'` / `'wss://…'` | MCPL (MCP `2024-11-05`) | WebSocket |
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

A modern server's tools get the same prefix, `enabledTools`/`disabledTools`,
class overrides and dispatch as an MCPL server's, and `listMcplServers()`
shows its `family`, `protocolVersion` and `transport`. Its config differs in
two ways:
- It has no MCPL surface (grant, push, channels, inference requests, feature
  sets), so setting MCPL-only fields on one is a configuration error.
- `requestTimeoutMs` is one deadline per tool call and must be 1 to 2^31−1;
  0 is refused, where MCPL reads it as no watchdog.

At the deadline cancellation is requested, the outcome is reported as
unknown, and the call is never retried. An MCPL server that refuses
`2024-11-05` with `-32022` fails with `McplProtocolVersionError`, which names
the fix, and is not retried.

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
still unread, and **appends** once a model has seen it; `retract: true`
withdraws unread content and appends the supplied deletion notice only when
some version was read (or history is unknown). `initial: true` on a create lets
the host know the subject's history is complete, so a create → edit → delete
that nobody read leaves no trace. `deferred: true` (push only) holds a batch of
notices outside context and asks the server for the content with `push/render`
when a turn is assembled.

Plain content stays in context and is delivered on arrival through the ordinary
channel/push path; the host only remembers where it landed. "Unread" means:
above the agent's consumed watermark (advanced at every compile of a model
request), on the current branch, not a sharded message, and not folded into a
summary by compression. On any doubt — restart, branch switch, eviction — the
host appends, as it does today. There is no per-subject cap: a busy channel's
unread backlog is simply its unread backlog. Receipts and subject history are
kept in the `mcpl/coalescing` state (retry window 1 h); audit lines are
`mcpl:coalescing` trace events.

#### Per-channel conversation routing (deprecated)

> **Deprecated: `FrameworkConfig.conversations` (`ConversationRouter`).** Per-channel conversation routing sends each channel's traffic to its own fork agent, spawned from a template agent and closed after an idle TTL. It is being retired ([#235](https://github.com/anima-research/agent-framework/issues/235)). Its `'mention'` bind/trigger rule, the default for channels, reads `metadata.mentioned`, which discord-mcpl does not set, so on Discord channels an @-mention never binds a fork or triggers a bound one. Don't adopt it in new hosts. Existing configurations still route exactly as before, and the framework logs one `[deprecated]` line when it is created with `conversations` set. Removal is a follow-up.

### Streaming Lifecycle

1. **Start**: Framework calls `agent.startStreamWithInjections()` → `YieldingStream`
2. **Drive**: Framework iterates stream events (tokens, tool-calls, complete, error)
3. **Tool yield**: Stream yields tool calls → framework dispatches concurrently → collects results
4. **Resume**: All results in → stream resumes with tool results
5. **Budget restart**: If input tokens exceed `maxStreamTokens`, the stream is cancelled, context is recompressed, and a fresh stream starts
6. **Complete**: Final response saved to context, agent returns to idle

### Abort / Cancellation

```typescript
// Cancel in-flight inference for an agent
framework.abortInference('assistant', 'user requested stop');
```

The non-streaming path uses `AbortSignal` forwarded to `membrane.stream()`, which returns an `AbortedResponse` with partial content. The streaming path cancels the `YieldingStream` directly.

## API Server

WebSocket server for external clients (UIs, scripts, other agents).

```typescript
const server = new ApiServer(framework, { port: 8765 });
await server.start();
```

**Commands:** `message.send`, `message.list`, `inference.request`, `inference.abort`, `branch.*`, `agent.*`, `module.*`, `store.*`, `inference.tail/inspect/search`, `events.*`, `host.quiesce/resume/status/maintenanceTick`

Also available as an MCP server via the `agent-framework-mcp` binary.

### Host quiesce / maintenance mode

Pause the inference thread and MCPL data planes while keeping the framework,
context managers, and membrane hot — so compression/refold/quarantine work runs
through the live machinery instead of offline scripts (issue #122). Quiesce
persists across restarts; `resume` gates on a fresh per-agent feasibility
preview of the current runtime settings (`force` overrides).

```typescript
await framework.quiesce({ reason: 'refold', timeoutMs: 120_000, abandon: false });
await framework.maintenanceTick();   // drain quarantine / advance merges
await framework.resume();            // throws ResumeBlockedError if the layout won't compile
```

Also reachable over HTTP (`POST /quiesce`, `POST /resume`,
`POST /maintenance/tick`, `GET /hostmode`; options via query string) and as
`host/command` verbs (`quiesce`, `resume`, `maintain`, `host-status`) from MCPL
servers granted `allowHostCommands`. The HTTP host verbs accept an optional
shared secret (`ApiServerConfig.adminToken`, sent as `x-admin-token`) for
deployments that front the port with a proxy.

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

Requires Node.js >= 20. Chronicle requires a Rust toolchain for native module compilation (`npm run build` in the chronicle directory).
