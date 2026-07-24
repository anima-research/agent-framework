/**
 * Token utilities for voice-relay user accounts.
 *
 * Ported from melodeus-tts-relay/src/oauth.ts (token portion only — the
 * OAuth HTTP flow itself lands with the Discord workstream).
 */

import { createHash, randomBytes } from 'node:crypto';

/** Generate a fresh raw session token (delivered to the client exactly once). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 hex digest — the at-rest form of user tokens. */
export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Verify a raw token against its stored form.
 * Legacy accounts stored plaintext (`hashed = false`); they compare directly
 * and are migrated to hashed storage by the caller on first success.
 */
export function verifyToken(raw: string, stored: string, hashed: boolean): boolean {
  return hashed ? hashToken(raw) === stored : raw === stored;
}
