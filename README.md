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
windows, never compiles message content, and activates the new Chronicle
branch. By default the recovery is local to the resident: nothing is posted to
Discord. To let the people involved see that the agent no longer has their
messages, choose awareness marks explicitly with `--marks addressed` (removed
messages that mentioned or replied to the bot, and DMs) or `--marks all`
(every removed Discord message). The output counts what will be marked and
what stays unmarked, and `--dry-run` shows exactly which addresses each choice
covers. Only `{serverId, channelId, messageId}` metadata is written, to the
awareness journal kept in the store itself, and the marks are delivered when
the host and that agent's `discord-mcpl` bot next connect (see
[Live surgery and Discord awareness marks](#live-surgery-and-discord-awareness-marks)).
If the branch is made but the marks can't be recorded, the output's `markers`
says so and the branch stands.
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

With the host stopped, the same command inspects and controls the awareness
journal: `--awareness list`, `--awareness cancel <batch|retract-request>`,
`--awareness retract <batch|all>` and `--awareness release <batch>` behave as
the live controls described below.

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
// result.markers: { status: 'none' | 'queued' | 'not-scheduled' | 'unresolved', ... }
```

- **`marks`** is `'none'` (the default), or `{ scope: 'addressed' | 'all', refs? }`.
  `addressed` covers messages tagged `chat:addressed` (mentions, replies to
  the bot, DMs). Passing a preview's `refs` binds the choice to exactly that
  set: messages that arrive before the surgery applies are removed locally but
  never marked. The choice is recorded in the operator log.
- **The surgery returns once marks are scheduled**, never after Discord has
  accepted them. `result.markers` says whether they were scheduled (`queued`
  with a count and batch id), not chosen or not in scope (`none`), not to be
  delivered because recording the batch failed after the body change and it
  was retired or never recorded (`not-scheduled`), or `unresolved` (neither
  activation nor retirement could be recorded, or the journal could not be
  read back to say whether the batch was; it names a batch that may still be
  delivered). Every receipt also counts the removed messages left unmarked.
  Marker bookkeeping never fails or undoes an applied rollback or
  suppression.
- **Delivery runs in the background** and never holds MCPL traffic or turns.
  A route that is not connected keeps its work queued until it connects.
  Each reaction call has a mandatory deadline independent of
  `requestTimeoutMs` (including `0`): `discordAwarenessDeadlineMs` (default
  10000ms, clamped to 50..60000ms). The emoji is `discordAwarenessEmoji`
  (offline: `--emoji`).
- **Marks are one-shot.** Switching branches, undo/redo and restarts never add
  or remove a mark. The journal is an append-only history of requests and
  their attempts, kept as typed records in the Chronicle store: it survives
  rollbacks, branch deletion and a killed process, and lives with its store.
  Each request is written ahead of its dispatch, and a dispatch is admitted
  from the journal as it is at that moment, so a cancel takes effect even
  while an earlier request is on the wire. A request written and never
  answered is recorded as `unknown`, and a later confirmation of a different
  attempt never resolves it. Between opposite requests for one reaction,
  the later *authorization* wins, whenever each request was created: a
  surgery's adds carry the moment of its marks choice, even when activation
  comes later, so a retract made in between prevails; a release is a new
  act. A record that certifies a body change (an activation, a completed
  suppression, a retirement, or the batch a hide or turn undo records after
  its change) is written only after that change is synced.
  A batch whose surgery was interrupted before its branch switch was
  recorded is held at startup until an operator releases it; an interrupted
  suppression's redactions are resumed whenever its branch is active at
  startup, whatever its marks' state.
- **Operator controls,** each recorded in the operator log:
  - `listDiscordAwareness()` lists batches and retract requests;
  - `cancelDiscordAwareness(batch | retractRequest)` stops all further sends
    and retries of a batch's marks or a retract's removals, and never removes
    or undoes anything. Its receipt counts requests in flight or unknown,
    including earlier attempts later answered, any of which may still land;
  - `retractDiscordAwareness(batch | 'all')` queues removal of this bot's
    reaction, through each address's configured MCPL route, for every message
    of the batch (or of every batch not retired by its own surgery, prepared,
    held or active, and every message an imported ledger recorded), whatever
    history says: removing an absent reaction does nothing. As the latest
    authorization for those messages, it stops adds that haven't ended and
    any an earlier choice would request later; cancelling it never revives
    them. Its receipt discloses earlier requests whose outcome is unknown and
    imported history that leaves outcomes unrecorded;
  - `releaseDiscordAwareness(batch)` queues a held batch.
- **Over `host/command`** (servers granted `allowHostCommands`): `undo` (by
  messages or by turns) and `hide` take `marks: 'none' | 'addressed' | 'all'`
  (default `none`; any other value is refused) and return `markers`. Each
  holds the store like every surgery, so it is refused while any agent
  sharing the store is mid-turn. The `marks` verb takes `action: 'list'
  | 'cancel' | 'retract' | 'release'` with a `target` (a batch id; for cancel
  also a retract request id; for retract also `all`).

A pre-journal awareness ledger (`discord-awareness-outbox.json` under the
store, or `discordAwarenessOutboxPath`) is imported once on first use and the
file renamed `.migrated-v2`. What it recorded about each message is kept as
evidence (attempt count; the last action and the outcome its error field
establishes; the old writer's delivery status, labelled as the
reconciliation state it was; and how many attempt outcomes it leaves
unrecorded), never as a claim about what is on Discord,
and an imported `active` suppression is not taken as proof that its body
completed: startup verifies and resumes its intervals on its branch. Its
undelivered work is held for an explicit release.

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
