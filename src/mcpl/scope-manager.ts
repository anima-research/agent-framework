/**
 * ScopeManager — Whitelist/blacklist enforcement and scope elevation for MCPL.
 *
 * Manages per-feature-set scope configurations and evaluates whether actions
 * are approved, denied, or require user prompting. Handles `scope/elevate`
 * requests from servers.
 *
 * Spec references: Section 7 (Scoped Access).
 */

import type {
  ScopeConfig,
  ScopeLabel,
  ScopeElevateParams,
  ScopeElevateResult,
} from './types.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Callback invoked when a scope elevation requires user approval.
 * Returns true if the user approves, false otherwise.
 */
export type ElevationHandler = (
  featureSet: string,
  scope: ScopeLabel
) => Promise<boolean>;

// ============================================================================
// Glob Matching
// ============================================================================

/**
 * Simple glob-style pattern matching.
 *
 * Supported syntax:
 *   - `*`  matches any sequence of characters except `/`
 *   - `**` matches any sequence of characters including `/`
 *   - All other characters are matched literally
 *
 * The pattern must match the entire text (anchored at both ends).
 */
function globMatch(pattern: string, text: string): boolean {
  // Convert glob pattern to a RegExp
  let regexStr = '^';
  let i = 0;

  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      // `**` matches any characters including `/`
      regexStr += '.*';
      i += 2;
      // Skip a trailing `/` after `**` if present (e.g., `**/foo`)
      if (i < pattern.length && pattern[i] === '/') {
        regexStr += '(?:/|$)';
        i++;
      }
    } else if (pattern[i] === '*') {
      // `*` matches any characters except `/`
      regexStr += '[^/]*';
      i++;
    } else {
      // Escape regex special characters
      regexStr += escapeRegex(pattern[i]);
      i++;
    }
  }

  regexStr += '$';

  try {
    const regex = new RegExp(regexStr);
    return regex.test(text);
  } catch {
    // If the pattern produces an invalid regex, fall back to exact match
    return pattern === text;
  }
}

/** Escape a character for use in a RegExp. */
function escapeRegex(char: string): string {
  const special = /[.+?^${}()|[\]\\]/;
  if (special.test(char)) {
    return '\\' + char;
  }
  return char;
}

// ============================================================================
// ScopeManager
// ============================================================================

/**
 * Manages whitelist/blacklist enforcement and scope elevation for feature sets.
 *
 * Evaluation order (per spec Section 7.6):
 * 1. Check approval cache (session-level)
 * 2. Check blacklist (if any pattern matches -> denied)
 * 3. Check whitelist (if any pattern matches -> approved)
 * 4. Otherwise -> prompt
 */
export class ScopeManager {
  /** Scope configs keyed by feature set name. */
  private configs = new Map<string, ScopeConfig>();

  /** Cached approvals: Set of `${featureSet}\0${label}` keys. */
  private approvalCache = new Set<string>();

  /** Optional handler for user-approval prompts. */
  private elevationHandler: ElevationHandler | null = null;

  /**
   * Set scope configuration for a single feature set.
   */
  configure(featureSet: string, config: ScopeConfig): void {
    this.configs.set(featureSet, config);
  }

  /**
   * Set scope configurations for multiple feature sets at once.
   */
  configureAll(scopes: Record<string, ScopeConfig>): void {
    for (const [featureSet, config] of Object.entries(scopes)) {
      this.configs.set(featureSet, config);
    }
  }

  /**
   * Check whether a label is approved, denied, or needs prompting
   * for the given feature set.
   *
   * Evaluation order:
   * 1. Approval cache hit -> 'approved'
   * 2. Blacklist match -> 'denied'
   * 3. Whitelist match -> 'approved'
   * 4. No config or no match -> 'prompt'
   */
  checkScope(
    featureSet: string,
    label: string
  ): 'approved' | 'denied' | 'prompt' {
    // 1. Check approval cache
    if (this.approvalCache.has(cacheKey(featureSet, label))) {
      return 'approved';
    }

    const config = this.configs.get(featureSet);

    // No config for this feature set -> prompt
    if (!config) {
      return 'prompt';
    }

    // 2. Check blacklist first (deny wins)
    if (config.blacklist) {
      for (const pattern of config.blacklist) {
        if (globMatch(pattern, label)) {
          return 'denied';
        }
      }
    }

    // 3. Check whitelist
    if (config.whitelist) {
      for (const pattern of config.whitelist) {
        if (globMatch(pattern, label)) {
          return 'approved';
        }
      }
    }

    // 4. Neither matched
    return 'prompt';
  }

  /**
   * Handle a `scope/elevate` request from a server.
   *
   * Checks scope against whitelist/blacklist, then:
   * - 'approved' -> return approved with payload
   * - 'denied'   -> return denied with reason
   * - 'prompt'   -> invoke elevation handler if registered, otherwise deny
   */
  async handleElevation(
    params: ScopeElevateParams
  ): Promise<ScopeElevateResult> {
    const { featureSet, scope } = params;
    const result = this.checkScope(featureSet, scope.label);

    if (result === 'approved') {
      return {
        approved: true,
        payload: scope.payload,
      };
    }

    if (result === 'denied') {
      return {
        approved: false,
        reason: 'Scope denied by blacklist',
      };
    }

    // result === 'prompt'
    if (this.elevationHandler) {
      const approved = await this.elevationHandler(featureSet, scope);
      if (approved) {
        // Cache the approval for the session
        this.cacheApproval(featureSet, scope.label);
        return {
          approved: true,
          payload: scope.payload,
        };
      }
      return {
        approved: false,
        reason: 'User denied the elevation request',
      };
    }

    // No handler registered — default to denied
    return {
      approved: false,
      reason: 'User approval required',
    };
  }

  /**
   * Register a custom elevation handler for user-approval prompts.
   * The handler is called when a scope check returns 'prompt'.
   */
  setElevationHandler(handler: ElevationHandler): void {
    this.elevationHandler = handler;
  }

  /**
   * Cache an approval for the session.
   * Subsequent `checkScope()` calls with the same feature set and label
   * will return 'approved' without re-evaluating patterns.
   */
  cacheApproval(featureSet: string, label: string): void {
    this.approvalCache.add(cacheKey(featureSet, label));
  }

  /**
   * Clear all cached approvals.
   */
  clearCache(): void {
    this.approvalCache.clear();
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Build a cache key from feature set and label. */
function cacheKey(featureSet: string, label: string): string {
  return `${featureSet}\0${label}`;
}
