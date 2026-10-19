/**
 * Test helper: make an already-registered agent look like a conversation
 * fork bound to `channelId`, the way `createConversationAgent` registers
 * one — a home channel, not a broadcast recipient, no provider-scheduling
 * ownership. Returns an undo.
 *
 * Tests that exercise fork-only code paths (injection scoping, channel
 * tool guards, provider-cooldown ownership) use this instead of spawning a
 * real fork through the conversation router.
 */
import type { NormalizedRequest, NormalizedResponse, YieldingStream } from '@animalabs/membrane';
import type {
  AgentFramework,
  AgentRecord,
  EventResponse,
  Module,
  ModuleContext,
  ProcessEvent,
  ProcessState,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '../../src/index.js';
import { createMockResponse, MockYieldingStream } from './mock-membrane.js';

type RegistryInternals = { registry: { get(name: string): AgentRecord | undefined } };

export function bindAsConversationFork(
  framework: AgentFramework,
  agentName: string,
  channelId: string,
): () => void {
  const record = (framework as unknown as RegistryInternals).registry.get(agentName);
  if (!record) throw new Error(`bindAsConversationFork: "${agentName}" is not a registered agent`);
  const prior = { homeChannel: record.homeChannel, roles: { ...record.roles } };
  record.homeChannel = channelId;
  record.roles = { ...record.roles, receivesUntargeted: false, ownsProviderScheduling: false };
  return () => {
    if (prior.homeChannel === undefined) delete record.homeChannel;
    else record.homeChannel = prior.homeChannel;
    record.roles = prior.roles;
  };
}

/** The registry's home channel for an agent (what channel routing resolves). */
export function homeChannelOf(framework: AgentFramework, agentName: string): string | undefined {
  return (framework as unknown as RegistryInternals).registry.get(agentName)?.homeChannel;
}

/** A membrane that scripts each agent separately: one response list per activation. */
export class RoutedMembrane {
  readonly calls: NormalizedRequest[] = [];
  private readonly scripts = new Map<string, NormalizedResponse[][]>();
  /**
   * Which agent a request belongs to. Defaults to the request's assistant
   * participant; a derived agent presents itself under its parent's name,
   * so a test that scripts one sets this to tell the two apart.
   */
  identify: (request: NormalizedRequest) => string = (request) => request.assistantParticipant ?? '';
  /** Text returned by `complete` (compression calls). */
  completion = 'ok';

  script(agent: string, ...activation: NormalizedResponse[]): void {
    this.scripts.set(agent, [...(this.scripts.get(agent) ?? []), activation]);
  }

  callsFor(agent: string): NormalizedRequest[] {
    return this.calls.filter((call) => this.streamed.has(call) && this.identify(call) === agent);
  }

  private readonly streamed = new WeakSet<NormalizedRequest>();

  streamYielding(request: NormalizedRequest): YieldingStream {
    this.calls.push(request);
    this.streamed.add(request);
    const queue = this.scripts.get(this.identify(request)) ?? [];
    const activation = queue.shift() ?? [createMockResponse([{ type: 'text', text: 'ok' }])];
    return new MockYieldingStream(activation);
  }

  async complete(request: NormalizedRequest): Promise<NormalizedResponse> {
    this.calls.push(request);
    return createMockResponse([{ type: 'text', text: this.completion }]);
  }

  asMembrane(): import('@animalabs/membrane').Membrane {
    return this as unknown as import('@animalabs/membrane').Membrane;
  }
}

/** `test--wait` blocks its caller until the test releases the named gate. */
export class GateModule implements Module {
  readonly name = 'test';
  readonly entered = new Set<string>();
  private readonly gates = new Map<string, () => void>();
  broadcastOn: string | null = null;

  async start(_ctx: ModuleContext): Promise<void> {}
  // Gates still closed at shutdown stay closed: releasing them would hand a
  // tool result to a framework that has already stopped.
  async stop(): Promise<void> {}

  getTools(): ToolDefinition[] {
    return [{
      name: 'wait',
      description: 'Block until released',
      inputSchema: { type: 'object', properties: { gate: { type: 'string' } } },
    }];
  }

  async handleToolCall(call: ToolCall): Promise<ToolResult> {
    const gate = String((call.input as { gate?: string }).gate ?? 'default');
    this.entered.add(gate);
    await new Promise<void>((resolve) => this.gates.set(gate, resolve));
    return { success: true, data: { released: gate } };
  }

  release(gate: string): void {
    this.gates.get(gate)?.();
  }

  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (this.broadcastOn && (event as { type: string }).type === this.broadcastOn) {
      return { requestInference: true };
    }
    return {};
  }
}

export const waitCall = (gate: string) =>
  createMockResponse([{ type: 'tool_use', id: `call-${gate}`, name: 'test--wait', input: { gate } }], 'tool_use');
export const say = (text: string) => createMockResponse([{ type: 'text', text }]);

export async function until(condition: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

