/**
 * Voice relay integration: connects framework agents to an external TTS
 * relay (melodeus-tts-relay) so their turns stream to voice clients as they
 * are written and can be interrupted mid-utterance — the same connection the
 * relay's existing bots (ChapterX) hold.
 */

export { RelayClientModule } from './relay-client-module.js';
export type { RelayClientModuleConfig } from './relay-client-module.js';

export { InferenceTraceBridge } from './trace-bridge.js';
export type { TraceBridge, ChannelBroadcastFn, AgentIdentityResolver } from './trace-bridge.js';

export type {
  RelayLogger,
  BotStreamMessage,
  RelayToVoiceClientMessage,
  BlockType,
  ActivationEndReason,
} from './types.js';
