/**
 * One of a script's calls through the framework's bridge, as the script gets
 * it: a result in the one shape every tool answers, or the refusal a call
 * refused before it ran rejects with.
 */
import type { AgentFramework } from '../../src/index.js';

export type ScriptAnswer =
  | { refused: false; content: unknown[]; structuredContent: unknown; isError: boolean }
  | { refused: true; name: string; message: string; tool: string };

export async function scriptCall(framework: AgentFramework, agent: string, tool: string, input: unknown = {}): Promise<ScriptAnswer> {
  const answer = await (framework as unknown as {
    scriptToolCall(agent: string, tool: string, argsJson: string, context: object): Promise<{ ok: boolean; json: string }>;
  }).scriptToolCall(agent, tool, JSON.stringify(input), {});
  const value = JSON.parse(answer.json) as Record<string, unknown>;
  return (answer.ok ? { refused: false, ...value } : { refused: true, ...value }) as ScriptAnswer;
}

/** A text-only answer's text, as a script reads `result.content[0].text`. */
export function answerText(answer: ScriptAnswer): string {
  if (answer.refused) return answer.message;
  const first = answer.content[0] as { type?: string; text?: string } | undefined;
  return first?.type === 'text' ? first.text ?? '' : '';
}
