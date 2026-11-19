import type { ContentBlock } from '@animalabs/membrane';

/**
 * A message's non-text block, priced about as context-manager's store
 * prices it (MessageStore's raw estimate at 0.14.1): an image at its
 * `tokenEstimate` stamp, or 1600 without one, and a document, audio or video
 * at 1000. These are the store's flat estimates, not ceilings: a PDF's pages
 * can cost more than 1000. Of the writers in agent-framework, channel
 * messages and MCPL bring images, MCPL push events and channel messages
 * bring audio, and none writes a document or a video; a host module's
 * addMessage can write any of them. Two departures err high. A generated
 * image, which the store prices at 0, is priced as an image, since
 * membrane's Anthropic formatter sends it as one. A stamp that isn't a
 * finite number, 0 or more, is priced at 1600, where the store takes it as
 * given: a NaN would make every sum it joins NaN. Thinking and other blocks
 * are priced at 0: they come from
 * provider responses, stored as the agent's own messages, and nothing in
 * agent-framework writes them under another participant, though a host
 * module's addMessage could.
 */
export function mediaBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'image':
    case 'generated_image': {
      const stamp = (block as { tokenEstimate?: unknown }).tokenEstimate;
      return typeof stamp === 'number' && Number.isFinite(stamp) && stamp >= 0 ? stamp : 1600;
    }
    case 'document':
    case 'audio':
    case 'video':
      return 1000;
    default:
      return 0;
  }
}
