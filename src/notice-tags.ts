/**
 * Build every fixed bracket opening the framework writes into an agent's
 * context outside a tool result (a notice, a heartbeat or reminder text, a
 * placeholder in a message's content) from a tag here, as `[tag]`,
 * `[tag: …]` or `[tag …]`: text the framework didn't write is marked
 * wherever it would open with one of these (supplied-text.ts). A toolset's
 * `[server/toolset:instance]` label is built from its server's id and names
 * instead.
 */
export const NOTICE_TAG = {
  turnInterrupted: 'turn-interrupted',
  closedChannel: 'closed channel',
  tunedOut: 'tuned out',
  refusalRewind: 'refusal-rewind',
  drafts: 'drafts',
  delivered: 'delivered',
  routing: 'routing',
  channels: 'channels',
  continue: 'continue',
  proseRouting: 'prose-routing',
  toolBoundary: 'tool-boundary',
  gate: 'Gate',
  selfWake: 'self-wake',
  discordSendFailed: 'discord-send-failed',
  sendUndeliverable: 'send-undeliverable',
  inferenceFailed: 'inference-failed',
  speechNotPosted: 'speech-not-posted',
  reasoning: 'reasoning',
  workspace: 'workspace',
  workspaceEvent: 'workspace event',
  conflictsWithDisk: 'conflicts with disk',
  tuneOut: 'Tune-out',
  tuneOutWake: 'Tune-out wake',
  tuneOutCadence: 'Tune-out cadence',
  tuneOutCancelled: 'Tune-out cancelled',
  standingDispositions: 'Standing dispositions',
  channelInvitation: 'Channel invitation',
  system: 'system',
  toolsets: 'toolsets',
  heartbeat: 'heartbeat',
  silentHeartbeat: 'silent heartbeat',
  heartbeatTick: 'heartbeat tick',
  heartbeatContinue: 'Continue',
  currentTime: 'current time',
  reminder: 'reminder',
  attachment: 'Attachment',
  emptyMessage: 'Empty message',
  imageNotShown: 'Image not shown',
  audioNotShown: 'Audio not shown',
  contentNotShown: 'Content not shown',
  resourceNotShown: 'Resource not shown',
  referenceNotShown: 'Reference not shown',
  textNotShown: 'Text not shown',
  reference: 'reference',
  referenceId: 'ref',
  resourceLink: 'resource link',
  withheld: 'withheld',
  unserializableConnectorValue: 'unserializable connector value',
  unprintableValue: 'a value that cannot be printed',
  undescribedFailure: 'failure could not be described',
  script: 'script',
  truncated: 'truncated',
  cutToFit: 'cut to fit',
  blockNotShown: 'block not shown',
} as const;

/**
 * The bracket openings context-manager 0.23.0 and 0.23.1 write into an
 * agent's context outside a tool result or read back from it, marked as the
 * framework's own are. Check them against each context-manager release the
 * framework takes.
 */
export const CONTEXT_MANAGER_TAGS = [
  'content omitted', 'image not shown', 'Operator note', 'Recall', 'tool call omitted', 'tool result moved', 'Topic Transition',
] as const;

/**
 * The bracket openings membrane 0.8.0 writes into an agent's request outside
 * a tool result, marked as the framework's own are. Check them against each
 * membrane release the framework takes.
 */
export const MEMBRANE_TAGS = [
  'Audio', 'continuing', 'Document', 'duplicate tool_result for', 'Image', 'orphan tool_result for', 'Start', 'Tool Result', 'Video',
] as const;
