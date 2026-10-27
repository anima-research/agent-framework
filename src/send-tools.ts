/**
 * Tools whose call delivers the resident's message to a channel or person,
 * by bare name (an MCPL server's `<prefix>--` stripped). The framework reads
 * a call of one as an explicit send that silences the round's auto-routed
 * prose where it may have posted; the history module's semantic index reads
 * its message argument as what the resident wrote to someone, whether or not
 * it was delivered.
 */
export const SEND_TOOLS = new Set(['channel_publish', 'send_message', 'reply_message', 'send_dm']);

/** Strip the `server--` MCPL prefix from a tool name. */
export const bareToolName = (n: string): string => n.split('--').pop()!;
