// The agent's structured view of an extract, not a transformation of the
// stored conversation or of native blocks on their way back to a provider.
const EXTRACT = 'history--extract';
const ACT = 'toolsets--act';
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

// Only extract call IDs are indexed. The value distinguishes wrapped calls
// (true) from direct calls (false), so a named ACT result needs an ACT match.
function extractCalls(blocks: Iterable<unknown>): Map<string, boolean> {
  const calls = new Map<string, boolean>();
  for (const b of blocks) {
    if (!record(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
    const act = b.name === ACT && record(b.input)
      && typeof b.input.tool === 'string' && b.input.tool.trim() === EXTRACT
      && !(typeof b.input.server === 'string' && b.input.server.trim());
    // Any extract match wins, even with duplicate IDs. Prefer ACT because
    // an explicitly named EXTRACT result doesn't need a matching call.
    if (act || (b.name === EXTRACT && !calls.has(b.id))) calls.set(b.id, act);
  }
  return calls;
}

type ExtractCallLookup = (id: string, wrappedOnly: boolean) => boolean;

function lazyExtractCalls(blocks: () => Iterable<unknown>, fallback?: ExtractCallLookup): ExtractCallLookup {
  let calls: Map<string, boolean> | undefined;
  return (id, wrappedOnly) => {
    const wrapped = (calls ??= extractCalls(blocks())).get(id);
    return (wrapped !== undefined && (!wrappedOnly || wrapped)) || (fallback?.(id, wrappedOnly) ?? false);
  };
}

function isExtractResult(b: Record<string, unknown>, lookup: ExtractCallLookup): boolean {
  if (b.type !== 'tool_result' || typeof b.toolUseId !== 'string' || !b.toolUseId) return false;
  // A direct result names itself, even mid-round or with a repeated call id.
  if (b.toolName === EXTRACT) return true;
  if (b.toolName !== undefined && b.toolName !== ACT) return false;
  return lookup(b.toolUseId, b.toolName === ACT);
}

function* messageBlocks(rows: Iterable<ExtractRow>): Iterable<unknown> {
  for (const { content } of rows) {
    if (Array.isArray(content)) yield* content;
  }
}

export function projectRawMessages<T extends ExtractRow>(messages: T[], storedRows: () => Iterable<ExtractRow>): T[] {
  // Share one on-demand store scan across the raw page and all embedded pages.
  const storedCalls = lazyExtractCalls(() => messageBlocks(storedRows()));
  return projectPage(messages, storedCalls, storedCalls);
}

function projectPage<T extends ExtractRow>(messages: T[], lookup: ExtractCallLookup, storedCalls: ExtractCallLookup): T[] {
  const replacedXml = new Set<string>();
  const projected = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content: unknown[] = message.content;
    const blocks = content.flatMap((b) => {
      if (!record(b)) return [b];
      if (privateBlock(b)) return [];
      if (!isExtractResult(b, lookup)) return [b];

      const body = projectResultBody(b.content, storedCalls);
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

function projectResultBody(body: unknown, storedCalls: ExtractCallLookup): unknown {
  if (typeof body === 'string') return projectResultText(body, storedCalls);
  if (!Array.isArray(body)) return body;
  let withheld = false;
  const blocks = (body as unknown[]).map((b) => {
    if (!record(b) || b.type !== 'text' || typeof b.text !== 'string') return b;
    const text = projectResultText(b.text, storedCalls);
    if (text === b.text) return b;
    if (text === WITHHELD) withheld = true;
    const { rawItem: _, ...block } = b;
    return { ...block, text };
  });
  if (withheld) return WITHHELD;
  return blocks.some((b, i) => b !== body[i]) ? blocks : body;
}

function projectResultText(text: string, storedCalls: ExtractCallLookup): string {
  if (!text.trimStart().startsWith('{')) return text;
  let page: unknown;
  try {
    // Framework tool results serialize ToolResult.data, not the outer ToolResult.
    page = JSON.parse(text);
  } catch {
    return hasPrivateBlockMarker(text, storedCalls) ? WITHHELD : text;
  }
  if (!record(page) || !Array.isArray(page.messages) || page.returned !== page.messages.length) return text;
  const messages: unknown[] = page.messages;
  if (!messages.every((m): m is ExtractRow & Record<string, unknown> => record(m)
    && typeof m.id === 'string' && typeof m.timestamp === 'string' && typeof m.participant === 'string'
    && (Array.isArray(m.content) || typeof m.content === 'string'))) return text;

  // The embedded page can also contain calls no longer in the store.
  const lookup = lazyExtractCalls(() => messageBlocks(messages), storedCalls);
  const projected = projectPage(messages, lookup, storedCalls);
  return projected === messages ? text : JSON.stringify({ ...page, messages: projected });
}

// For cut or otherwise malformed JSON, look for a private block declaration
// in the parseable prefix, at messages[].content[] only. Recurse into text
// from recognized extract results, not arbitrary strings or tool arguments.
function hasPrivateBlockMarker(text: string, storedCalls: ExtractCallLookup): boolean {
  type Location = 'page' | 'messages' | 'message' | 'content' | 'block' | 'result' | 'resultText' | undefined;
  const blocks: Record<string, unknown>[] = [];
  const tokens = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*(")?|[{}\[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  let start = 0;
  let unfinishedString: string | undefined;
  const read = () => {
    start = tokens.lastIndex;
    const match = tokens.exec(text);
    // Keep the usable prefix without treating it as a complete token.
    unfinishedString = match?.[1]?.startsWith('"') && !match[2] ? match[1] : undefined;
    return unfinishedString === undefined ? match?.[1] : undefined;
  };
  let token = read();
  const stringValue = (allowPrefix: boolean): string | null => {
    if (token?.startsWith('"')) return JSON.parse(token);
    // The lexer stops before any incomplete escape, so this decodes just
    // the available text, including escaped JSON inside the result.
    return allowPrefix && unfinishedString !== undefined ? JSON.parse(unfinishedString + '"') : null;
  };
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

  function scan(at: Location, depth: number, body?: Record<string, unknown>[]): boolean {
    // This is a conservative fallback, not a recovery parser for arbitrary JSON.
    if (depth > 128) throw new SyntaxError();
    if (at === 'result') {
      const value = stringValue(true);
      if (value !== null) body!.push({ type: 'text', text: value });
    }
    if (eat('{')) {
      if (eat('}')) return false;
      // Keep only the fields needed to identify results and their text, even
      // if the cut comes before the enclosing block or array closes.
      const fields: Record<string, unknown> = {};
      if (at === 'block') blocks.push(fields);
      if (at === 'resultText') body!.push(fields);
      let thinking = false;
      let data = false;
      do {
        if (!token?.startsWith('"')) throw new SyntaxError();
        const key: string = JSON.parse(take()!);
        if (!eat(':')) throw new SyntaxError();
        if ((at === 'block' && ['type', 'id', 'name', 'toolUseId', 'toolName'].includes(key))
          || (at === 'resultText' && (key === 'type' || key === 'text'))) {
          fields[key] = stringValue(at === 'resultText' && key === 'text');
        }
        if (at === 'block') {
          // A cut can land in the block's string value itself.
          if (key === 'thinking' || key === 'data') {
            const startsString = token?.startsWith('"') ?? /^[ \t\r\n]*"/.test(text.slice(start));
            if (key === 'thinking') thinking = startsString;
            else data = startsString;
          }
          if ((fields.type === 'thinking' && thinking) || (fields.type === 'redacted_thinking' && data)) return true;
        }
        const child = at === 'page' && key === 'messages' ? 'messages'
          : at === 'message' && key === 'content' ? 'content'
          : at === 'block' && key === 'content' ? 'result' : undefined;
        const resultBody = child === 'result' ? [] : undefined;
        if (resultBody) fields.content = resultBody;
        const valueStart = start;
        if (scan(child, depth + 1, resultBody)) return true;
        if (at === 'block' && key === 'input') fields.input = JSON.parse(text.slice(valueStart, start));
      } while (eat(','));
      if (!eat('}')) throw new SyntaxError();
    } else if (eat('[')) {
      if (eat(']')) return false;
      const child = at === 'messages' ? 'message' : at === 'content' ? 'block'
        : at === 'result' ? 'resultText' : undefined;
      do {
        if (scan(child, depth + 1, body)) return true;
      } while (eat(','));
      if (!eat(']')) throw new SyntaxError();
    } else {
      if (!token || /^[}\]:,]$/.test(token)) throw new SyntaxError();
      take();
    }
    return false;
  }

  try {
    if (scan('page', 0)) return true;
  } catch {
    // The input ends in a cut or syntax error; check the prefix we did read.
  }
  const lookup = lazyExtractCalls(() => blocks, storedCalls);
  return blocks.some((b) => Array.isArray(b.content) && isExtractResult(b, lookup)
    && b.content.some((item) => item.type === 'text' && typeof item.text === 'string'
      && hasPrivateBlockMarker(item.text, storedCalls)));
}
