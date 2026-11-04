/**
 * Types for inference logging - captures raw LLM requests and responses
 */

// Re-export InferenceLogEntry from framework.ts for convenience
export type { InferenceLogEntry } from './framework.js';

/**
 * Query options for inference logs
 */
export interface InferenceLogQuery {
  /** Filter by agent name */
  agentName?: string;
  /** Max number of logs to return */
  limit?: number;
  /** Skip first N logs (for pagination) */
  offset?: number;
  /** Search pattern for content (regex) */
  pattern?: string;
  /** Only show inferences that didn't succeed: failed or stopped */
  errorsOnly?: boolean;
}

/**
 * Result from querying inference logs
 */
export interface InferenceLogQueryResult {
  /** Matching entries */
  entries: InferenceLogEntryWithId[];
  /** Total count matching query (before pagination) */
  total: number;
  /** Whether more entries exist beyond limit */
  hasMore: boolean;
}

/**
 * Inference log entry with Chronicle sequence ID
 */
export interface InferenceLogEntryWithId {
  /** Chronicle sequence number (acts as ID) */
  sequence: number;
  /** The log entry data (may contain blob references) */
  entry: import('./framework.js').InferenceLogEntry;
  /** Summary info for display without resolving blobs */
  summary?: InferenceLogSummary;
}

/**
 * Summary view of an inference log (without full request/response)
 */
export interface InferenceLogSummary {
  timestamp: number;
  agentName: string;
  requestId: string;
  success: boolean;
  error?: string;
  durationMs: number;
  tokenUsage?: { input: number; output: number; cacheCreation?: number; cacheRead?: number };
  stopReason?: string;
  /** Whether request is stored as blob */
  requestIsBlob: boolean;
  /** Whether response is stored as blob */
  responseIsBlob: boolean;
}
