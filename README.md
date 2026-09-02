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

### Resident retirement

Configured resident agents can opt into the framework's neutral irreversible
seal and enforcement primitive:

```ts
agents: [{
  name: 'assistant',
  model: 'claude-opus-4-6',
  systemPrompt: '...',
  retirement: { enabled: true },
}]
```

After applying its own resident-facing policy, a host calls
`framework.retireResident(name, reason?)`. The framework fsyncs the terminal
seal file and its containing directory on first creation, cancels an active
stream, denies every future inference surface (including public `Agent`
references), clears queued wakes and process-local gate state, stops
resident-authored scripts, and keeps Chronicle/workspace history readable.
Confirmation wording, cooling-off, health gates, and notifications
deliberately belong to the host. Retirement is distinct from end-turn,
sleep/dormancy, and erasure.

Modules can expose host-owned ceremony through `getLiveTools(agentName)`.
Those tools are available only to a provider-issued live stream, never public
programmatic dispatch, code execution, ephemeral agents, or `puppetToolCall`.
Once a module reserves a live-only tool name for any resident, that name is
protected globally against forged caller identities.

The terminal seal is append-only and branch-independent at
`<storePath>/resident-retirements.jsonl`, so Chronicle undo/redo or a branch
switch cannot resume the identity. Apps that supply an owned `store` must also
supply `retirementPath`. Newly created directories in a custom seal path are
also fsynced through their existing ancestor. See
[Resident lifecycle](docs/resident-lifecycle.md).

## API Server

WebSocket server for external clients (UIs, scripts, other agents).

```typescript
const server = new ApiServer(framework, { port: 8765 });
await server.start();
```

**Commands:** `message.send`, `message.list`, `inference.request`, `inference.abort`, `branch.*`, `agent.*`, `module.*`, `store.*`, `inference.tail/inspect/search`, `events.*`

Also available as an MCP server via the `agent-framework-mcp` binary.

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
