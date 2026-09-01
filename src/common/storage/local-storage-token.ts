import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The token that authorizes the local driver's byte route — spec 012 FR-042b.
 *
 * This token IS the authorization for an endpoint that streams tenant
 * documents with no `Authorization` header. That is acceptable only because it
 * is scoped to one file, expires, and does not exist in production — so all
 * three properties are enforced here and asserted by test rather than assumed.
 *
 * **Why a separate key from `JWT_SECRET`.** When `LOCAL_STORAGE_TOKEN_SECRET`
 * is unset the key is DERIVED from `JWT_SECRET` through a fixed context string
 * rather than being `JWT_SECRET` itself. Reusing session key material for a
 * second purpose means a weakness in either one is a weakness in both, and it
 * makes rotating one silently rotate the other. The derivation costs one hash
 * and removes the whole question.
 */
const DERIVATION_CONTEXT = 'ciro:spec-012:local-file-storage-token:v1';

export function deriveLocalTokenKey(configured: string, jwtSecret: string): string {
  if (configured) {
    return configured;
  }
  return createHmac('sha256', jwtSecret).update(DERIVATION_CONTEXT).digest('hex');
}

/**
 * `{fileId}.{expiresAtEpochSeconds}.{hmac}`.
 *
 * The file id is INSIDE the signed payload, not merely alongside it, so a token
 * minted for one file cannot be replayed against another — the difference
 * between "scoped" and "looks scoped".
 */
export function mintLocalToken(fileId: string, key: string, ttlSeconds: number): string {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${fileId}.${expiresAt}`;
  return `${payload}.${sign(payload, key)}`;
}

export type LocalTokenRejection = 'MALFORMED' | 'BAD_SIGNATURE' | 'WRONG_FILE' | 'EXPIRED';

/**
 * Verifies a token against the file actually being requested.
 *
 * Order matters: the signature is checked BEFORE the expiry and before the file
 * id, so an attacker cannot learn anything from a forged token beyond "no".
 * Returns a reason for the caller to record; the caller must not disclose it.
 */
export function verifyLocalToken(
  token: string | undefined,
  fileId: string,
  key: string,
): { ok: true } | { ok: false; reason: LocalTokenRejection } {
  if (!token) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'MALFORMED' };
  }
  const [tokenFileId, expiresAtRaw, signature] = parts;
  const payload = `${tokenFileId}.${expiresAtRaw}`;

  const expected = sign(payload, key);
  const given = Buffer.from(signature, 'hex');
  const want = Buffer.from(expected, 'hex');
  // Length-checked first: timingSafeEqual THROWS on a length mismatch rather
  // than returning false, so a short signature would be a 500 instead of a 403.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, reason: 'BAD_SIGNATURE' };
  }

  if (tokenFileId !== fileId) {
    return { ok: false, reason: 'WRONG_FILE' };
  }

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return { ok: true };
}

function sign(payload: string, key: string): string {
  return createHmac('sha256', key).update(payload).digest('hex');
}
