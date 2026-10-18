/**
 * MCPL wire content to membrane content: the one conversion every lane uses,
 * for pushed events, channel messages and context injections alike, so a rule
 * about a malformed block holds on all three.
 */

import type { ContentBlock } from '@animalabs/membrane';
import { INLINE_WITHHELD_TEXT, isInlineContradiction, referenceStubOrNull } from './references.js';
import { NON_STRING_TEXT_PLACEHOLDER } from './visible-content.js';
import type { McplContentBlock } from './types.js';

/**
 * Convert a single MCPL wire-format content block to a membrane ContentBlock.
 * It takes any block but null or undefined without throwing (those two throw,
 * for the caller to refuse or leave out): a type, data, mimeType or uri that
 * isn't a string counts as absent, and a text block whose text isn't a string
 * shows as NON_STRING_TEXT_PLACEHOLDER. `provenance` is what a reference stub
 * says the reference came on, such as 'attachment on push event'.
 */
export function convertBlock(block: McplContentBlock, provenance: string): ContentBlock {
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
      if (isFilledString(block.uri) && block.disposition) {
        // RFC-005 uri-form media with a disposition claim: stub, do not
        // hand the URI to the provider or inline it.
        return { type: 'text', text: referenceStubOrNull(block, provenance) ?? '[reference]' };
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
      return { type: 'text', text: isFilledString(block.data) ? '[Image: no media type]' : '[Image: no data]' };

    case 'audio':
      if (isInlineContradiction(block)) {
        // RFC-005 vector 2: inline data claiming bulk disposition — fail
        // closed, withhold the data (checked BEFORE the data branch).
        return { type: 'text', text: INLINE_WITHHELD_TEXT };
      }
      if (isFilledString(block.uri) && block.disposition) {
        // RFC-005 uri-form media with a disposition claim: stub, do not
        // hand the URI to the provider or inline it.
        return { type: 'text', text: referenceStubOrNull(block, provenance) ?? '[reference]' };
      }
      if (isFilledString(block.data) && isFilledString(block.mimeType)) {
        return {
          type: 'audio',
          source: { type: 'base64', data: block.data, mediaType: block.mimeType },
        } as ContentBlock;
      }
      return { type: 'text', text: isFilledString(block.data) ? '[Audio: no media type]' : '[Audio: no data]' };

    case 'resource':
      // RFC-005: reference blocks become bounded stubs — never raw URIs
      // (a signed URL is a bearer credential that looks like a location).
      return { type: 'text', text: referenceStubOrNull(block, provenance) ?? '[reference]' };

    default: {
      // Unknown wire block types previously fell off the exhaustive switch
      // and propagated `undefined` into ContentBlock[]. Fail visibly. A type
      // that isn't a string is no type, and is never converted to one: an
      // object can throw when it is.
      const type: unknown = (block as { type?: unknown }).type;
      return { type: 'text', text: `[unrecognized content block: ${typeof type === 'string' ? type : 'untyped'}]` };
    }
  }
}

/** A string with something in it: the only data, mimeType or uri a block's
 *  source is built from, and the only uri that makes it a reference. Anything
 *  else a sender puts there leaves the block without it, so conversion never
 *  throws and never copies a non-string. */
function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
