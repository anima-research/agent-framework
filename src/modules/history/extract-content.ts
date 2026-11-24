// The agent's structured view of an extract, not a transformation of the
// stored conversation or of native blocks on their way back to a provider.
const EXTRACT = 'history--extract';
const ACT = 'toolsets--act';
const WITHHELD = '[History extract withheld: malformed JSON contains a private thinking block.]';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function privateBlock(block: Record<string, unknown>): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

interface ExtractRow {
  content: unknown;
}

function* extractCalls(blocks: Iterable<unknown>): Generator<[string, boolean]> {
  for (const b of blocks) {
    if (!record(b) || b.type !== 'tool_use' || typeof b.id !== 'string' || typeof b.name !== 'string') continue;
    const act = b.name === ACT && record(b.input)
      && typeof b.input.tool === 'string' && b.input.tool.trim() === EXTRACT
      && !(typeof b.input.server === 'string' && b.input.server.trim());
    if (act || b.name === EXTRACT) yield [b.id, act];
  }
}

type ExtractCallLookup = (id: string, wrappedOnly: boolean) => boolean;

function lazyExtractCalls(blocks: () => Iterable<unknown>, fallback?: ExtractCallLookup): ExtractCallLookup {
  const calls = new Map<string, boolean>();
  let remaining: Generator<[string, boolean]> | undefined;
  return (id, wrappedOnly) => {
    const wrapped = calls.get(id);
    if (wrapped !== undefined && (!wrappedOnly || wrapped)) return true;
    // Stop at the first eligible call. Later lookups reuse what we saw and
    // resume the same scan. A wrapped match also satisfies unnamed results.
    remaining ??= extractCalls(blocks());
    for (let next = remaining.next(); !next.done; next = remaining.next()) {
      const [callId, act] = next.value;
      if (act || !calls.has(callId)) calls.set(callId, act);
      if (callId === id && (!wrappedOnly || act)) return true;
    }
    return fallback?.(id, wrappedOnly) ?? false;
  };
}

function extractResultCheck(b: Record<string, unknown>, lookup: ExtractCallLookup): (() => boolean) | undefined {
  const { toolUseId, toolName } = b;
  if (b.type !== 'tool_result' || typeof toolUseId !== 'string' || !toolUseId) return;
  // A direct result names itself, even mid-round or with a repeated call id.
  if (toolName === EXTRACT) return () => true;
  if (toolName !== undefined && toolName !== ACT) return;
  return () => lookup(toolUseId, toolName === ACT);
}

function* messageBlocks(rows: Iterable<ExtractRow>): Iterable<unknown> {
  for (const { content } of rows) {
    if (Array.isArray(content)) yield* content;
  }
}

export function projectRawMessages<T extends ExtractRow>(messages: T[], storedRows: () => Iterable<ExtractRow>): T[] {
  return projectPage(messages, lazyExtractCalls(() => messageBlocks(storedRows())));
}

function projectPage<T extends ExtractRow>(messages: T[], storedCalls: ExtractCallLookup): T[] {
  // The current page may contain calls missing from stored history.
  const lookup = lazyExtractCalls(() => messageBlocks(messages), storedCalls);
  const replacedXml = new Set<string>();
  const projected = messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content: unknown[] = message.content;
    const blocks = content.flatMap((b) => {
      if (!record(b)) return [b];
      if (privateBlock(b)) return [];
      const isExtract = extractResultCheck(b, lookup);
      if (!isExtract) return [b];

      const body = projectResultBody(b.content, isExtract, storedCalls);
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

function projectResultBody(body: unknown, isExtract: () => boolean, storedCalls: ExtractCallLookup): unknown {
  if (typeof body === 'string') return projectResultText(body, isExtract, storedCalls);
  if (!Array.isArray(body)) return body;
  let withheld = false;
  const blocks = (body as unknown[]).map((b) => {
    if (!record(b) || b.type !== 'text' || typeof b.text !== 'string') return b;
    const text = projectResultText(b.text, isExtract, storedCalls);
    if (text === b.text) return b;
    if (text === WITHHELD) withheld = true;
    const { rawItem: _, ...block } = b;
    return { ...block, text };
  });
  if (withheld) return WITHHELD;
  return blocks.some((b, i) => b !== body[i]) ? blocks : body;
}

// Undefined is not an extract envelope; null is a possible extract cut.
function parseExtractPage(text: string) {
  if (!text.startsWith('{')) return;
  try {
    // Framework tool results serialize ToolResult.data, not the outer ToolResult.
    const page: unknown = JSON.parse(text);
    if (record(page) && Array.isArray(page.messages) && page.returned === page.messages.length) {
      return page as Record<string, unknown> & { messages: unknown[] };
    }
  } catch {
    return null;
  }
}

function projectResultText(text: string, isExtract: () => boolean, storedCalls: ExtractCallLookup): string {
  const trimmed = text.trimStart();
  const page = parseExtractPage(trimmed);
  if (page === undefined) return text;
  if (page === null) return hasPrivateBlockMarker(trimmed, storedCalls) && isExtract() ? WITHHELD : text;
  const { messages } = page;
  if (!messages.every((m): m is ExtractRow & Record<string, unknown> => record(m)
    && typeof m.id === 'string' && typeof m.timestamp === 'string' && typeof m.participant === 'string'
    && (Array.isArray(m.content) || typeof m.content === 'string'))) return text;
  if (!isExtract()) return text;

  const projected = projectPage(messages, storedCalls);
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
          const startsString = token?.startsWith('"') || unfinishedString !== undefined;
          if ((key === 'thinking' || key === 'signature') && startsString) return true;
          if (key === 'data') data = startsString;
          if (fields.type === 'redacted_thinking' && data) return true;
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
  return blocks.some((b) => {
    if (!Array.isArray(b.content)) return false;
    const isExtract = extractResultCheck(b, lookup);
    return isExtract && b.content.some((item) => {
      if (item.type !== 'text' || typeof item.text !== 'string') return false;
      const trimmed = item.text.trimStart();
      return parseExtractPage(trimmed) !== undefined && hasPrivateBlockMarker(trimmed, storedCalls) && isExtract();
    });
  });
}
