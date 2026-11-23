// The agent's structured view of an extract, not a transformation of the
// stored conversation or of native blocks on their way back to a provider.
const EXTRACT = 'history--extract';
const WITHHELD = '[History extract withheld: malformed JSON contains a private thinking block.]';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function privateBlock(block: Record<string, unknown>): boolean {
  return (block.type === 'thinking' && typeof block.thinking === 'string')
    || (block.type === 'redacted_thinking' && typeof block.data === 'string');
}

interface ExtractRow {
  content: unknown;
}

export function projectRawMessages<T extends ExtractRow>(messages: T[]): T[] {
  const calls = new Map<string, string | null>();
  for (const { content } of messages) {
    if (!Array.isArray(content)) continue;
    for (const b of content as unknown[]) {
      if (record(b) && b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        // A repeated id in a disjoint history window isn't an unambiguous pair.
        calls.set(b.id, calls.has(b.id) ? null : b.name);
      }
    }
  }

  const replacedXml = new Set<string>();
  const projected = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content: unknown[] = message.content;
    const blocks = content.flatMap((b) => {
      if (!record(b)) return [b];
      if (privateBlock(b)) return [];
      if (b.type !== 'tool_result' || typeof b.toolUseId !== 'string' || !b.toolUseId) return [b];
      // Framework-written results persist their tool name beside their call
      // id. This still identifies a result when the page starts mid-round.
      // Legacy unnamed results need a matching tool_use in this extract.
      const paired = calls.get(b.toolUseId);
      if (b.toolName !== undefined && b.toolName !== EXTRACT) return [b];
      if ((paired === undefined ? b.toolName : paired) !== EXTRACT) return [b];

      const body = projectResultBody(b.content);
      if (body === b.content) return [b];
      if (typeof b.rawXml === 'string') replacedXml.add(b.rawXml);
      const { rawItem: _, ...result } = b;
      return [{ ...result, content: body }];
    });
    return blocks.length === content.length && blocks.every((b, i) => b === content[i])
      ? message : { ...message, content: blocks };
  });

  // XML replay can duplicate a whole results batch on each result in it.
  // Discard that replay copy when its structured body has changed.
  if (replacedXml.size) {
    return projected.map((message) => {
      if (!Array.isArray(message.content)) return message;
      let changed = false;
      const content = (message.content as unknown[]).map((b) => {
        if (!record(b) || b.type !== 'tool_result' || typeof b.rawXml !== 'string' || !replacedXml.has(b.rawXml)) return b;
        changed = true;
        const { rawXml: _, rawXmlImagesAt: _images, ...result } = b;
        return result;
      });
      return changed ? { ...message, content } : message;
    });
  }
  return projected.some((message, i) => message !== messages[i]) ? projected : messages;
}

function projectResultBody(body: unknown): unknown {
  if (typeof body === 'string') return projectResultText(body);
  if (!Array.isArray(body)) return body;
  let withheld = false;
  const blocks = (body as unknown[]).map((b) => {
    if (!record(b) || b.type !== 'text' || typeof b.text !== 'string') return b;
    const text = projectResultText(b.text);
    if (text === b.text) return b;
    if (text === WITHHELD) withheld = true;
    const { rawItem: _, ...block } = b;
    return { ...block, text };
  });
  if (withheld) return WITHHELD;
  return blocks.some((b, i) => b !== body[i]) ? blocks : body;
}

function projectResultText(text: string): string {
  if (!text.trimStart().startsWith('{')) return text;
  let page: unknown;
  try {
    // Framework tool results serialize ToolResult.data, not the outer ToolResult.
    page = JSON.parse(text);
  } catch {
    return hasPrivateBlockMarker(text) ? WITHHELD : text;
  }
  if (!record(page) || !Array.isArray(page.messages) || page.returned !== page.messages.length) return text;
  const messages: unknown[] = page.messages;
  if (!messages.every((m): m is ExtractRow & Record<string, unknown> => record(m)
    && typeof m.id === 'string' && typeof m.timestamp === 'string' && typeof m.participant === 'string'
    && (Array.isArray(m.content) || typeof m.content === 'string'))) return text;

  const projected = projectRawMessages(messages);
  return projected === messages ? text : JSON.stringify({ ...page, messages: projected });
}

// For cut or otherwise malformed JSON, look for a private block declaration
// in the parseable prefix, at messages[].content[] only. A token in a string,
// tool argument, result body, or unrelated property doesn't count.
function hasPrivateBlockMarker(text: string): boolean {
  type Location = 'page' | 'messages' | 'message' | 'content' | 'block' | undefined;
  const tokens = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  let start = 0;
  const read = () => {
    start = tokens.lastIndex;
    return tokens.exec(text)?.[1];
  };
  let token = read();
  const take = () => {
    const previous = token;
    token = read();
    return previous;
  };
  const eat = (expected: string): boolean => {
    if (token !== expected) return false;
    take();
    return true;
  };

  function scan(at: Location, depth: number): boolean {
    // This is a conservative fallback, not a recovery parser for arbitrary JSON.
    if (depth > 128) throw new SyntaxError();
    if (eat('{')) {
      if (eat('}')) return false;
      let type: string | undefined;
      let thinking = false;
      let data = false;
      do {
        if (!token?.startsWith('"')) throw new SyntaxError();
        const key: string = JSON.parse(take()!);
        if (!eat(':')) throw new SyntaxError();
        if (at === 'block') {
          if (key === 'type') type = token?.startsWith('"') ? JSON.parse(token) : undefined;
          // A cut can land in the block's string value itself.
          if (key === 'thinking' || key === 'data') {
            const startsString = token?.startsWith('"') ?? /^[ \t\r\n]*"/.test(text.slice(start));
            if (key === 'thinking') thinking = startsString;
            else data = startsString;
          }
          if ((type === 'thinking' && thinking) || (type === 'redacted_thinking' && data)) return true;
        }
        const child = at === 'page' && key === 'messages' ? 'messages'
          : at === 'message' && key === 'content' ? 'content' : undefined;
        if (scan(child, depth + 1)) return true;
      } while (eat(','));
      if (!eat('}')) throw new SyntaxError();
    } else if (eat('[')) {
      if (eat(']')) return false;
      const child = at === 'messages' ? 'message' : at === 'content' ? 'block' : undefined;
      do {
        if (scan(child, depth + 1)) return true;
      } while (eat(','));
      if (!eat(']')) throw new SyntaxError();
    } else {
      if (!token || /^[}\]:,]$/.test(token)) throw new SyntaxError();
      take();
    }
    return false;
  }

  try {
    return scan('page', 0);
  } catch {
    return false;
  }
}
