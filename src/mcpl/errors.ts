/**
 * MCPL error codes and helpers.
 *
 * Error codes from Spec Appendix A. Used when rejecting inbound messages
 * from MCPL servers that violate permission or state constraints.
 */

import type { JsonRpcError } from './types.js';

// ============================================================================
// Error Codes (Spec Appendix A)
// ============================================================================

/** Message used a disabled feature set. */
export const FEATURE_SET_NOT_ENABLED = -32001;

/**
 * Method requires a capability the host has masked for this server
 * (McplServerConfig.enabledCapabilities/disabledCapabilities). Host-side
 * extension code, pending a spec assignment.
 */
export const CAPABILITY_DISABLED = -32002;

/** Message used an undeclared feature set. */
export const UNKNOWN_FEATURE_SET = -32003;

/** Rollback targeted a pruned or unknown checkpoint. */
export const CHECKPOINT_NOT_FOUND = -32005;

/** Lacking scope to publish or observe channel. */
export const CHANNEL_NOT_PERMITTED = -32017;

/** Channel ID doesn't exist or not registered. */
export const UNKNOWN_CHANNEL = -32023;

/** Server could not open/connect the requested channel. */
export const CHANNEL_OPEN_FAILED = -32024;

// ============================================================================
// Error Factories
// ============================================================================

/** The text of any value: anything thrown or rejected, or a value a server
 *  sent, such as an error answer's code. Never throws, whatever it is: a
 *  null-prototype object, or a message getter or toString that throws. */
export function describeCause(cause: unknown): string {
  try {
    return cause instanceof Error ? String(cause.message) : String(cause);
  } catch {
    try {
      return Object.prototype.toString.call(cause);
    } catch {
      return 'an error that could not be printed';
    }
  }
}

/** Text a server or a handler chose, made fit for an error's message or a
 *  trace field: control and format characters replaced (C0 and C1 controls,
 *  bidi and other \p{Cf} characters, and the line and paragraph separators
 *  some log readers break lines on), and cut after `max` code points, with
 *  "…" marking the cut. Those are read as data, by a trace's or an error
 *  listener's reader, so the text is bounded rather than escaped. A log line
 *  prints text a server or a handler chose through log-value instead
 *  (logValue for a field, logDetail for the free text that ends the line). */
export function boundedForLog(text: string, max = 200): string {
  const points = [...text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '?')];
  return points.length > max ? `${points.slice(0, max).join('')}…` : points.join('');
}

export function hostStoppedWhileHandling(): JsonRpcError {
  return { code: -32000, message: 'the host stopped while handling this request' };
}

/**
 * Create a "feature set not enabled" error.
 * Returned when a server sends a message tagged with a feature set
 * that the host has disabled.
 */
export function featureSetNotEnabled(
  featureSet: string,
  canEnable: boolean = true
): JsonRpcError {
  return {
    code: FEATURE_SET_NOT_ENABLED,
    message: 'Feature set not enabled',
    data: { featureSet, canEnable },
  };
}

/**
 * Create an "unknown feature set" error.
 * Returned when a server sends a message tagged with a feature set
 * that was never declared in capabilities.
 */
export function unknownFeatureSet(featureSet: string): JsonRpcError {
  return {
    code: UNKNOWN_FEATURE_SET,
    message: 'Unknown feature set',
    data: { featureSet },
  };
}

/**
 * Create a "checkpoint not found" error.
 * Returned when a rollback targets a pruned or unknown checkpoint.
 */
export function checkpointNotFound(checkpoint: string): JsonRpcError {
  return {
    code: CHECKPOINT_NOT_FOUND,
    message: 'Checkpoint not found',
    data: { checkpoint },
  };
}

/**
 * Create a "channel not permitted" error.
 * Returned when a server lacks scope to publish or observe a channel.
 */
export function channelNotPermitted(channelId: string): JsonRpcError {
  return {
    code: CHANNEL_NOT_PERMITTED,
    message: 'Channel not permitted',
    data: { channelId },
  };
}

/**
 * Create an "unknown channel" error.
 * Returned when a channel ID doesn't exist or isn't registered.
 */
export function unknownChannel(channelId: string): JsonRpcError {
  return {
    code: UNKNOWN_CHANNEL,
    message: 'Unknown channel',
    data: { channelId },
  };
}

/**
 * Create a "channel open failed" error.
 * Returned when a server could not open/connect the requested channel.
 */
export function channelOpenFailed(
  channelId: string,
  reason?: string
): JsonRpcError {
  return {
    code: CHANNEL_OPEN_FAILED,
    message: 'Channel open failed',
    data: { channelId, reason },
  };
}
