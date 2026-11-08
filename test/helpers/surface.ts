import type { ContentBlock } from '@animalabs/membrane';
import type { EventResponse, Module, ModuleContext, ProcessEvent, ProcessState, SpeechContext, ToolDefinition, ToolResult } from '../../src/index.js';
import { createMockResponse } from './mock-membrane.js';

export class SurfaceModule implements Module {
  readonly name = 'surface';
  constructor(private readonly wakes: boolean | string[] = true) {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent, _state: ProcessState): Promise<EventResponse> {
    if (event.type !== 'external-message') return {};
    return {
      addMessages: [{ participant: 'user', content: [{ type: 'text', text: String((event as { content?: unknown }).content) }] }],
      requestInference: this.wakes,
    };
  }
}

export const surfaceMessage = (content: string, source = 'tui') =>
  ({ type: 'external-message', source, content, metadata: {}, triggerInference: true }) as never;

export class ActModule implements Module {
  readonly name = 'probe';
  readonly acts: Array<() => unknown> = [];
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] {
    return [{ name: 'act', description: 'Act', inputSchema: { type: 'object', properties: {} } }];
  }
  async handleToolCall(): Promise<ToolResult> {
    await this.acts.shift()?.();
    return { success: true, data: 'acted' };
  }
  async onProcess(): Promise<EventResponse> { return {}; }
}

export const say = (text: string) => createMockResponse([{ type: 'text', text }] as ContentBlock[]);
export const callTool = (id: string, name: string, input: Record<string, unknown> = {}, text?: string) =>
  createMockResponse([
    ...(text !== undefined ? [{ type: 'text', text }] : []),
    { type: 'tool_use', id, name, input },
  ] as ContentBlock[], 'tool_use');
export const act = (id: string, text?: string) => callTool(id, 'probe--act', {}, text);

export class SpeechProbe implements Module {
  readonly name = 'speaker';
  readonly heard: Array<{ text: string; private?: true }> = [];
  async start(ctx: ModuleContext): Promise<void> { ctx.registerSpeechHandler('*', { additive: true }); }
  async stop(): Promise<void> {}
  getTools(): ToolDefinition[] { return []; }
  async handleToolCall(): Promise<ToolResult> { return { success: false, error: 'no tools' }; }
  async onProcess(event: ProcessEvent): Promise<EventResponse> {
    const type = (event as { type: string }).type;
    const text = String((event as { content?: unknown }).content);
    if (type === 'room:message') {
      return { addMessages: [{ participant: 'Ann', content: [{ type: 'text', text }], metadata: { channelId: 'room-1' } }], requestInference: true };
    }
    if (type === 'reaction:message') {
      return { addMessages: [{ participant: 'Ann', content: [{ type: 'text', text }], metadata: { channelId: 'room-1', tags: ['chat:reaction'] } }], requestInference: true };
    }
    if (type === 'note:message') {
      return {
        addMessages: [{ participant: 'Muse', content: [{ type: 'text', text }], metadata: { kind: 'subconscious-note', channelId: 'room-1', serverId: 'room', epochId: 'e1' } }],
        requestInference: true,
      };
    }
    return {};
  }
  async onAgentSpeech(_agent: string, content: ContentBlock[], context: SpeechContext): Promise<void> {
    const text = content.map((b) => (b as { text?: string }).text ?? '').join('');
    this.heard.push({ text, ...(context.private ? { private: true as const } : {}) });
  }
}
