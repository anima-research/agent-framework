import type { ContentBlock } from '@animalabs/membrane';

/**
 * Recognize ONLY a whole-response textual invocation wrapper for a tool that
 * was registered on this exact inference. This is containment, not parsing:
 * callers must never execute the returned tool name or wrapper body.
 */
export function detectKnownToolWrapperProse(
  content: ContentBlock[],
  knownToolNames: ReadonlySet<string>,
): string | null {
  if (knownToolNames.size === 0) return null;

  // Signed thinking may precede visible prose. Any other non-text block makes
  // this a mixed response, not an exact textual wrapper.
  const text: string[] = [];
  for (const block of content) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return null;
  }
  const body = text.join('\n').trim();
  if (!body) return null;

  const tagName = '[A-Za-z_][A-Za-z0-9_.:-]*';
  let match = body.match(new RegExp(`^<(${tagName})\\s*/>$`));
  if (match && knownToolNames.has(match[1]!)) return match[1]!;

  match = body.match(new RegExp(`^<(${tagName})\\s*>([\\s\\S]*?)<\\/\\1\\s*>$`));
  if (match && knownToolNames.has(match[1]!)) return match[1]!;

  // Legacy XML formatter shape used by older Claude harnesses.
  match = body.match(/^<invoke\s*>\s*<tool\s+name=(['"])([^'"]+)\1(?:\s+[^>]*)?\s*\/>\s*<\/invoke\s*>$/);
  if (match && knownToolNames.has(match[2]!)) return match[2]!;
  match = body.match(/^<invoke\s*>\s*<tool\s+name=(['"])([^'"]+)\1(?:\s+[^>]*)?\s*>([\s\S]*?)<\/tool\s*>\s*<\/invoke\s*>$/);
  if (match && knownToolNames.has(match[2]!)) return match[2]!;

  return null;
}
