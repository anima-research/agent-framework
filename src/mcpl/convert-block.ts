/**
 * MCPL wire content to membrane content: the one conversion every lane uses,
 * for pushed events, channel messages and context injections alike, so a rule
 * about a malformed block holds on all three.
 */

import { NOTICE_TAG } from '../notice-tags.js';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AUDIO_NO_DATA_TEXT,
  AUDIO_NO_MEDIA_TYPE_TEXT,
  IMAGE_NO_DATA_TEXT,
  IMAGE_NO_MEDIA_TYPE_TEXT,
  INLINE_WITHHELD_TEXT,
  classifyBlock,
  isInlineContradiction,
  referenceStubOrNull,
  unknownBlockText,
} from './references.js';
import { NON_STRING_TEXT_PLACEHOLDER } from './visible-content.js';
import type { McplContentBlock } from './types.js';
import { markNoticeOpenings } from '../supplied-text.js';

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 * It takes any block but null or undefined without throwing (those two throw,
 * for the caller to refuse or leave out): a type, data, mimeType or uri that
 * isn't a string counts as absent, and a text block whose text isn't a string
 * shows as NON_STRING_TEXT_PLACEHOLDER. `provenance` is what a reference stub
 * says the reference came on, such as 'attachment on push event'. `serverId`
 * is the server that sent the content: a reference is registered with it, as
 * a tool result's references are, so fetch_reference can fetch it through that
 * server's address, where it has one.
 */
export function convertBlock(block: McplContentBlock, provenance: string, serverId: string): ContentBlock {
  switch (block.type) {
    case 'text':
      // Text that isn't a string can't be shown, so the agent reads that a
      // block was there; the emptiness checks still count it as no text
      // (isVisiblyEmptyConversion), as the request sanitizer would.
      return { type: 'text', text: typeof block.text === 'string' ? block.text : NON_STRING_TEXT_PLACEHOLDER };

    case 'image':
      if (isInlineContradiction(block)) {
        // RFC-005 vector 2: inline data claiming bulk disposition — fail
        // closed, withhold the data (checked BEFORE the data branch).
        return { type: 'text', text: INLINE_WITHHELD_TEXT };
      }
      if (isFilledString(block.uri) && block.disposition !== undefined) {
        // RFC-005 uri-form media with a disposition claim: stub, do not
        // hand the URI to the provider or inline it. Any disposition given
        // is a claim, one the reference rejects included, as classifyBlock
        // and isInlineContradiction read it: a falsy one such as 0, false
        // or '' stubs too, rather than sending the URI as the image's source.
        return { type: 'text', text: referenceStubOrNull(block, provenance, serverId) ?? `[${NOTICE_TAG.reference}]` };
      }
      if (isFilledString(block.data) && isFilledString(block.mimeType)) {
        return {
          type: 'image',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      if (isFilledString(block.uri)) {
        return {
          type: 'image',
          source: { type: 'url', url: block.uri },
        } as ContentBlock;
      }
      return { type: 'text', text: isFilledString(block.data) ? IMAGE_NO_MEDIA_TYPE_TEXT : IMAGE_NO_DATA_TEXT };

    case 'audio':
      if (isInlineContradiction(block)) {
        // RFC-005 vector 2: inline data claiming bulk disposition — fail
        // closed, withhold the data (checked BEFORE the data branch).
        return { type: 'text', text: INLINE_WITHHELD_TEXT };
      }
      if (isFilledString(block.uri) && block.disposition !== undefined) {
        // RFC-005 uri-form media with a disposition claim, a falsy one
        // included, as for an image (above): stub, do not hand the URI to
        // the provider or inline it.
        return { type: 'text', text: referenceStubOrNull(block, provenance, serverId) ?? `[${NOTICE_TAG.reference}]` };
      }
      if (isFilledString(block.data) && isFilledString(block.mimeType)) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      return { type: 'text', text: isFilledString(block.data) ? AUDIO_NO_MEDIA_TYPE_TEXT : AUDIO_NO_DATA_TEXT };

    case 'resource': {
      // MCP's embedded resource shows as the block its contents make would
      // show here (RFC-005 §8.1), its uri never.
      const c = classifyBlock(block);
      if (c.kind === 'embedded' && c.contents.kind === 'block') {
        return convertBlock(c.contents.block as McplContentBlock, provenance, serverId);
      }
      // RFC-005: reference blocks become bounded stubs — never raw URIs
      // (a signed URL is a bearer credential that looks like a location).
      return { type: 'text', text: referenceStubOrNull(block, provenance, serverId) ?? `[${NOTICE_TAG.reference}]` };
    }

    default: {
      // MCP's link to a resource isn't one of MCPL's own blocks, but a server
      // can send one, and RFC-005 §8.1 makes it a reference, shown as one.
      if ((block as { type?: unknown }).type === 'resource_link') {
        return { type: 'text', text: referenceStubOrNull(block, provenance, serverId) ?? `[${NOTICE_TAG.reference}]` };
      }
      // Unknown wire block types previously fell off the exhaustive switch
      // and propagated `undefined` into ContentBlock[]. Fail visibly. A type
      // that isn't a string is no type, and is never converted to one: an
      // object can throw when it is.
      return { type: 'text', text: unknownBlockText(block) };
    }
  }
}

export function convertBlocks(blocks: readonly McplContentBlock[], provenance: string, serverId: string): ContentBlock[] {
  const converted = blocks.map((block) => convertBlock(block, provenance, serverId));
  return markNoticeOpenings(converted, (index) => sendersText(blocks[index]));
}

function sendersText(block: McplContentBlock | undefined): boolean {
  if (block?.type === 'text') return typeof block.text === 'string';
  const c = classifyBlock(block);
  return c.kind === 'embedded' && c.contents.kind === 'block' && c.contents.block.type === 'text';
}

/** A string with something in it: the only data, mimeType or uri a block's
 *  source is built from, and the only uri that makes it a reference. Anything
 *  else a sender puts there leaves the block without it, so conversion never
 *  throws and never copies a non-string. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
