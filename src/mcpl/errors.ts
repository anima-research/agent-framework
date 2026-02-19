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
