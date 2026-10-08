/**
 * What a standard MCP tool result becomes for the framework. Standard means
 * the server did not negotiate MCPL: a legacy MCP-only peer or a modern
 * server. MCPL peers keep their RFC-005 reading (flat `resource` and
 * uri-form media as references), which is not this module's job.
 *
 * An MCP result has two views, and each consumer gets its own:
 * - **The content array is the server's model-facing view.** Text stays text
 *   and inline images stay native. Anything the provider format can't carry
 *   (audio, binary blobs) is saved to the workspace, and a bounded stub says
 *   where it went: a stub tells the reader where the payload is; it never
 *   replaces it silently. If a payload can't be saved, the result is a
 *   failure to materialize it, not a success. A `resource_link` is shown as a reference and never
 *   fetched. An embedded resource shows its text, or is saved like a blob.
 * - **`structuredContent` is the machine-readable view.** It is kept by
 *   presence on `ToolResult.structured`. The model sees it rendered as JSON
 *   only when the server's content has no text block of its own, because
 *   otherwise the server already chose what the model reads.
 *
 * This is the model's reading. Programs get the server's result itself:
 * the direct path returns the raw content, and a script receives a
 * structured result whole (framework.ts).
 *
 * Before this, a structured-only result reached the model as an empty string,
 * and a mixed result became one JSON string with its image as base64 text
 * (room-284 probe P1c).
 */
import type { ToolResult } from '../types/index.js';

/** Saves a payload under a host-chosen name; resolves to its workspace path,
 *  or null when there is nowhere writable to put it. */
export type SaveToolPayload = (fileName: string, bytes: Buffer, mimeType: string) => Promise<string | null>;

/** Stub fields are bounded independently of anything the server sends. */
const STUB_FIELD_CHARS = 200;

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function bounded(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return text.length > STUB_FIELD_CHARS ? `${text.slice(0, STUB_FIELD_CHARS)}…` : text;
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  const known: Record<string, string> = { 'octet-stream': 'bin', 'mpeg': 'mp3', 'plain': 'txt', 'x-wav': 'wav' };
  const ext = known[subtype] ?? subtype.replace(/[^a-z0-9]/g, '');
  return ext.length > 0 && ext.length <= 10 ? ext : 'bin';
}

export interface StandardToolResult {
  content?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
}

/**
 * Normalize a standard MCP tool result into the framework's `ToolResult`.
 * `label` names saved payloads (one per call; payloads get an index suffix).
 * A payload that can't be retained (no `save`, or saving failed) makes the
 * result a failure to materialize, never a success with part of it lost.
 */
export async function normalizeStandardToolResult(
  result: StandardToolResult,
  label: string,
  save: SaveToolPayload | null,
): Promise<ToolResult> {
  const raw = Array.isArray(result.content) ? result.content : [];
  const blocks: Block[] = [];
  let saved = 0;
  /** Payloads that could be neither shown nor retained. */
  let lost = 0;

  const payloadStub = async (kind: string, base64: string, mimeType: string, origin?: string): Promise<string> => {
    const size = humanSize(decodedSize(base64));
    const what = `[${kind}${origin ? ` ${bounded(origin)}` : ''}: ${bounded(mimeType)}, ${size}`;
    if (!save) {
      lost++;
      return `${what}. Not retained: the model can't take this type, and no workspace is mounted to save it]`;
    }
    const path = await save(`${label}-${++saved}.${extensionFor(mimeType)}`, Buffer.from(base64, 'base64'), mimeType)
      .catch(() => null);
    if (path) return `${what}, saved to workspace file ${path}]`;
    lost++;
    return `${what}. Not retained: the model can't take this type, and saving it to the workspace failed]`;
  };

  for (const entry of raw) {
    const block = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') blocks.push({ type: 'text', text: block.text });
        break;
      case 'image':
        if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType });
        } else {
          blocks.push({ type: 'text', text: `[image without inline data, not fetched${typeof block.uri === 'string' ? `: ${bounded(block.uri)}` : ''}]` });
        }
        break;
      case 'audio':
        if (typeof block.data === 'string' && typeof block.mimeType === 'string') {
          blocks.push({ type: 'text', text: await payloadStub('audio', block.data, block.mimeType) });
        } else {
          blocks.push({ type: 'text', text: `[audio without inline data, not fetched${typeof block.uri === 'string' ? `: ${bounded(block.uri)}` : ''}]` });
        }
        break;
      case 'resource_link': {
        const name = typeof block.name === 'string' ? block.name : undefined;
        const mime = typeof block.mimeType === 'string' ? `, ${bounded(block.mimeType)}` : '';
        blocks.push({ type: 'text', text: `[resource link${name ? ` "${bounded(name)}"` : ''}: ${bounded(block.uri)}${mime}; not fetched]` });
        break;
      }
      case 'resource': {
        const resource = (block.resource && typeof block.resource === 'object' ? block.resource : {}) as Record<string, unknown>;
        const uri = typeof resource.uri === 'string' ? resource.uri : undefined;
        const mime = typeof resource.mimeType === 'string' ? resource.mimeType : undefined;
        if (typeof resource.text === 'string') {
          blocks.push({ type: 'text', text: `[resource ${bounded(uri ?? '(no uri)')}${mime ? `, ${bounded(mime)}` : ''}]\n${resource.text}` });
        } else if (typeof resource.blob === 'string') {
          blocks.push({ type: 'text', text: await payloadStub('resource', resource.blob, mime ?? 'application/octet-stream', uri) });
        } else {
          blocks.push({ type: 'text', text: `[resource ${bounded(uri ?? '(no uri)')} with no contents]` });
        }
        break;
      }
      default:
        // Unknown to this client: shown as data rather than dropped.
        blocks.push({ type: 'text', text: JSON.stringify(entry) ?? '' });
    }
  }

  const hasStructured = Object.prototype.hasOwnProperty.call(result, 'structuredContent');
  // Only the server's own text blocks count as its presentation for the
  // model. Stubs this module wrote are notices, not the server's text.
  const serverText = raw.some((entry) => {
    const block = entry as { type?: unknown; text?: unknown } | null;
    return !!block && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0;
  });
  if (hasStructured && !serverText) {
    blocks.push({ type: 'text', text: JSON.stringify(result.structuredContent) ?? 'null' });
  }

  const text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
  const structured = hasStructured ? { structured: result.structuredContent } : {};
  if (result.isError) {
    return { success: false, error: text || 'Tool call failed', isError: true, ...structured };
  }
  if (lost > 0) {
    // The server answered, but part of its answer is gone: report that as a
    // failure to materialize the result, never as a success.
    return {
      success: false,
      error: `[result incomplete: ${lost} payload(s) could not be retained, so this result is not complete; ` +
        `the tool may already have completed]\n${text}`,
      isError: true,
      ...structured,
    };
  }
  const hasImage = blocks.some((b) => b.type === 'image');
  return {
    success: true,
    // Text-only results keep the joined-string convention callers expect.
    // An image keeps the array, so the model sees it natively.
    data: hasImage ? blocks : (text || undefined),
    isError: false,
    ...structured,
  };
}
