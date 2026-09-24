import type { ContentBlock, NormalizedMessage } from '@animalabs/membrane';

/** Detect an image's real format from its leading bytes. */
export function sniffImageMediaTypeBase64(data: string): string | undefined {
  const head = Buffer.from(data.slice(0, 32), 'base64');
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 3 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
  if (
    head.length >= 12 &&
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) return 'image/webp';
  return undefined;
}

/**
 * Correct base64 image blocks whose declared media type doesn't match their
 * bytes (e.g. Discord serving a PNG for an attachment it labels image/webp).
 * The provider rejects the WHOLE request on a mismatch, so one mislabelled
 * image in history would fail every turn. Returns new message/block objects
 * for anything changed; stored history is never touched.
 */
export function correctImageMediaTypes(messages: NormalizedMessage[]): NormalizedMessage[] {
  let changed = 0;
  const fix = (blocks: ContentBlock[]): ContentBlock[] => {
    let touched = false;
    const out = blocks.map((block) => {
      const b = block as { type: string; source?: { type?: string; data?: string; mediaType?: string }; content?: unknown };
      if (b.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string') {
        const actual = sniffImageMediaTypeBase64(b.source.data);
        if (actual && actual !== b.source.mediaType) {
          touched = true;
          changed++;
          return { ...block, source: { ...b.source, mediaType: actual } } as ContentBlock;
        }
      }
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        const inner = fix(b.content as ContentBlock[]);
        if (inner !== b.content) {
          touched = true;
          return { ...block, content: inner } as ContentBlock;
        }
      }
      return block;
    });
    return touched ? out : blocks;
  };
  const result = messages.map((m) => {
    const content = fix(m.content);
    return content === m.content ? m : { ...m, content };
  });
  if (changed > 0) console.error(`[images] corrected media type on ${changed} image block(s) whose bytes disagreed with their label`);
  return result;
}
