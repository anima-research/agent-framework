/**
 * What a standard MCP tool result becomes for the framework. Standard means
 * the server did not negotiate MCPL: a legacy MCP-only peer or a modern
 * server. MCPL peers keep their RFC-005 reading (flat `resource` and
 * uri-form media as references), which is not this module's job.
 *
 * An MCP result has two views, and each consumer gets its own:
 * - **The content array is the server's model-facing view.** Text stays text,
 *   and an inline image stays native when a provider can take it: one of the
 *   types providers accept, within their per-image size. Anything else the
 *   provider format can't carry (audio, binary blobs, other images) is saved
 *   to the workspace, and a bounded stub says where it went. A stub tells the
 *   reader where the payload is; nothing is dropped silently. If a payload
 *   can't be saved, the result is a failure to materialize it, not a
 *   success. A `resource_link` is shown as a link, with its name and URI,
 *   and never fetched. An embedded resource shows its text, or is saved like
 *   a blob.
 * - **`structuredContent` is the machine-readable view.** It is kept by
 *   presence on `ToolResult.structured`. The model sees it rendered as JSON
 *   only when the server's content has no text block of its own, because
 *   otherwise the server already chose what the model reads.
 *
 * A failed result is read by the model only as its error text, so there an
 * inline image is saved and stubbed too, like any other payload.
 *
 * This is the model's reading. The direct path returns the server's raw
 * content instead. A script receives the server's result whole only when it
 * carries structuredContent; an unstructured one reaches a script as this
 * reading, its payloads saved to the workspace and stubbed (framework.ts).
 */
import type { ToolResult } from '../types/index.js';

/** What a result whose content is present but isn't a list of blocks reads
 *  as, on the model's path and a script's alike. */
export const MALFORMED_CONTENT_NOTICE =
  '[malformed result: its content is not a list of blocks; the tool may already have completed]';

/** Saves a payload under a host-chosen name; resolves to its workspace path,
 *  or null when there is no writable workspace mount without an include to
 *  put it in. */
export type SaveToolPayload = (fileName: string, bytes: Buffer, mimeType: string) => Promise<string | null>;

/** Stub fields are bounded independently of anything the server sends. */
const STUB_FIELD_POINTS = 200;
/** A URI is the reference itself, so it's bounded far more loosely than a
 *  stub field: a real one survives, and a pathological one can't flood the
 *  model's view. */
const URI_POINTS = 2048;
/** The image types providers take inline. Any other image is saved. */
const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** The decoded size providers take per inline image: the same 5 MB ceiling
 *  the framework's read_image tool guards. A larger image is saved. */
const NATIVE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

/** Why a payload isn't shown inline, unless said otherwise. */
const UNSUPPORTED = "the model can't take this type";

type Block = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

/** The first `max` code points of `text`, never splitting a surrogate pair,
 *  and how many code points were left out. */
function headPoints(text: string, max: number): { head: string; omitted: number } {
  let end = 0;
  let points = 0;
  while (end < text.length && points < max) {
    end += text.codePointAt(end)! > 0xffff ? 2 : 1;
    points++;
  }
  let omitted = 0;
  for (let i = end; i < text.length; omitted++) i += text.codePointAt(i)! > 0xffff ? 2 : 1;
  return { head: text.slice(0, end), omitted };
}

/** Any value as JSON (a string quoted too). Never throws. */
function asJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** Any value as text: a string as itself, anything else as JSON. Never throws. */
function asText(value: unknown): string {
  return typeof value === 'string' ? value : asJson(value);
}

function bounded(value: unknown, max = STUB_FIELD_POINTS): string {
  const { head, omitted } = headPoints(asText(value), max);
  return omitted > 0 ? `${head}…` : head;
}

/** A payload's decoded size, its base64 read without the whitespace a
 *  wrapped encoding carries. */
function decodedSize(base64: string): number {
  const compact = base64.replace(/\s+/g, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((compact.length * 3) / 4) - padding);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const KNOWN_EXTENSIONS: Record<string, string> = { 'octet-stream': 'bin', 'mpeg': 'mp3', 'plain': 'txt', 'x-wav': 'wav' };

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase() ?? '';
  // The table's own keys only: a subtype such as 'constructor' must not find
  // what Object.prototype holds.
  const ext = Object.hasOwn(KNOWN_EXTENSIONS, subtype) ? KNOWN_EXTENSIONS[subtype]! : subtype.replace(/[^a-z0-9]/g, '');
  return ext.length > 0 && ext.length <= 10 ? ext : 'bin';
}

/** The image type a provider takes inline, in its canonical spelling, or
 *  null when it takes none of these. */
function nativeImageType(mimeType: unknown): string | null {
  if (typeof mimeType !== 'string') return null;
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  return NATIVE_IMAGE_TYPES.has(base) ? base : null;
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
 * Content that is present but isn't a list of blocks makes it a malformed
 * result, never an empty success. A tool's error result with no words, or
 * only whitespace, reads as `noWords`, which the framework words for its
 * server and tool. A payload stub with no `save` says why nothing could
 * keep it in `noSave`: no workspace mounted unless the caller words it
 * otherwise, as the framework does for a host whose only writable mount
 * is direct.
 */
export async function normalizeStandardToolResult(
  result: StandardToolResult,
  label: string,
  save: SaveToolPayload | null,
  noWords = 'Tool call failed',
  noSave = 'no workspace is mounted to save it',
): Promise<ToolResult> {
  const malformed = result.content !== undefined && !Array.isArray(result.content);
  const raw: unknown[] = Array.isArray(result.content) ? result.content : [];
  const blocks: Block[] = [];
  let saved = 0;
  /** Payloads that could be neither shown nor retained. */
  let lost = 0;

  const payloadStub = async (
    kind: string,
    base64: string,
    mimeType: string,
    opts: { origin?: string; why?: string } = {},
  ): Promise<string> => {
    const why = opts.why ?? UNSUPPORTED;
    const size = humanSize(decodedSize(base64));
    const what = `[${kind}${opts.origin ? ` ${bounded(opts.origin, URI_POINTS)}` : ''}: ${bounded(mimeType)}, ${size}`;
    if (!save) {
      lost++;
      return `${what}. Not retained: ${why}, and ${noSave}]`;
    }
    const fileName = `${label}-${++saved}.${extensionFor(mimeType)}`;
    const path = await save(fileName, Buffer.from(base64, 'base64'), mimeType).catch((error: unknown) => {
      // The stub says only that saving failed; why goes to the host's log.
      console.error(`[mcp] saving tool payload ${fileName} (${kind}, ${JSON.stringify(bounded(mimeType))}, ${size}) failed:`, error);
      return null;
    });
    if (path) return `${what}, saved to workspace file ${path}${why === UNSUPPORTED ? '' : `; not shown inline: ${why}`}]`;
    lost++;
    return `${what}. Not retained: ${why}, and saving it to the workspace failed]`;
  };

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      blocks.push({ type: 'text', text: `[malformed content entry, left out: ${bounded(entry)}]` });
      continue;
    }
    const block = entry as Record<string, unknown>;
    switch (block.type) {
      case 'text':
        blocks.push(typeof block.text === 'string'
          ? { type: 'text', text: block.text }
          : { type: 'text', text: '[malformed text block, left out: its text is not a string]' });
        break;
      case 'image':
      case 'audio': {
        const kind = block.type;
        if (typeof block.data !== 'string') {
          blocks.push({ type: 'text', text: `[${kind} without inline data, not fetched${typeof block.uri === 'string' ? `: ${bounded(block.uri, URI_POINTS)}` : ''}]` });
          break;
        }
        // Inline data with no type is still a payload, of no known type.
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream';
        const native = kind === 'image' ? nativeImageType(block.mimeType) : null;
        if (native && decodedSize(block.data) <= NATIVE_IMAGE_MAX_BYTES) {
          // Passed on without a wrapped encoding's whitespace, which a
          // provider may refuse, and with it the whole request.
          blocks.push({ type: 'image', data: block.data.replace(/\s+/g, ''), mimeType: native });
        } else {
          const why = native ? `over the ${humanSize(NATIVE_IMAGE_MAX_BYTES)} a model takes per image` : UNSUPPORTED;
          blocks.push({ type: 'text', text: await payloadStub(kind, block.data, mimeType, { why }) });
        }
        break;
      }
      case 'resource_link': {
        const name = typeof block.name === 'string' ? block.name : undefined;
        const mime = typeof block.mimeType === 'string' ? `, ${bounded(block.mimeType)}` : '';
        blocks.push({ type: 'text', text: `[resource link${name ? ` "${bounded(name)}"` : ''}: ${bounded(block.uri, URI_POINTS)}${mime}; not fetched]` });
        break;
      }
      case 'resource': {
        const resource = (block.resource && typeof block.resource === 'object' ? block.resource : {}) as Record<string, unknown>;
        const uri = typeof resource.uri === 'string' ? resource.uri : undefined;
        const mime = typeof resource.mimeType === 'string' ? resource.mimeType : undefined;
        if (typeof resource.text === 'string') {
          blocks.push({ type: 'text', text: `[resource ${uri === undefined ? '(no uri)' : bounded(uri, URI_POINTS)}${mime ? `, ${bounded(mime)}` : ''}]\n${resource.text}` });
        } else if (typeof resource.blob === 'string') {
          blocks.push({ type: 'text', text: await payloadStub('resource', resource.blob, mime ?? 'application/octet-stream', { origin: uri }) });
        } else {
          blocks.push({ type: 'text', text: `[resource ${uri === undefined ? '(no uri)' : bounded(uri, URI_POINTS)} with no contents]` });
        }
        break;
      }
      default: {
        // Unknown to this client: shown as data rather than dropped, bounded
        // like a stub field, so a large or binary payload can't flood the
        // model's view.
        const { head, omitted } = headPoints(asText(entry), STUB_FIELD_POINTS);
        blocks.push({ type: 'text', text: omitted > 0 ? `${head}… [${omitted} more characters of this block left out]` : head });
      }
    }
  }

  const failing = !!result.isError || lost > 0 || malformed;
  if (failing) {
    // A failed result is read only as its text: an inline image becomes a
    // payload like any other, saved and named, or marked not retained.
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      if (block.type === 'image') {
        blocks[i] = { type: 'text', text: await payloadStub('image', block.data, block.mimeType, { why: 'a failed result is read as its text alone' }) };
      }
    }
  }

  const hasStructured = Object.prototype.hasOwnProperty.call(result, 'structuredContent');
  // Only the server's own text blocks count as its presentation for the
  // model. Stubs this module wrote are notices, not the server's text.
  const serverText = raw.some((entry) => {
    const block = entry as { type?: unknown; text?: unknown } | null;
    return !!block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0;
  });
  if (hasStructured && !serverText) {
    blocks.push({ type: 'text', text: asJson(result.structuredContent) });
  }

  const text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n');
  const structured = hasStructured ? { structured: result.structuredContent } : {};
  if (result.isError) {
    return { success: false, error: text.trim() ? text : noWords, isError: true, ...structured };
  }
  if (malformed) {
    return {
      success: false,
      error: `${MALFORMED_CONTENT_NOTICE}${text ? `\n${text}` : ''}`,
      isError: true,
      ...structured,
    };
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
