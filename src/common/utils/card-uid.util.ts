/**
 * Canonicalizes an NFC card identifier so that the SAME physical card resolves
 * to the same string no matter which device read it.
 *
 * spec 008 assumed (spec.md "Assumptions") that the identifier is "an opaque
 * string ... compared for equality", so "cards of differing encodings work
 * without change". That holds only while one reader is the sole capture path.
 * It is false across two: the transporter's desk-mounted HID reader and the
 * driver's phone render the same UID differently — case, separators, a decimal
 * rather than hex reading, and frequently the reverse byte order. Compared raw,
 * a driver would present the correct card at the correct truck and be refused,
 * and FR-018 deliberately makes "wrong truck" and "no such card" the same
 * refusal, so the failure carries no diagnostic to follow.
 *
 * Normalizing at both ends — pairing and verification — is what makes the
 * opacity assumption true rather than merely stated. Note that it also
 * STRENGTHENS FR-005/SC-008: uniqueness is now enforced on the canonical form,
 * so two renderings of one card can no longer pair to two different trucks,
 * which the raw comparison would have permitted.
 */

/** 2^32-1 is exactly 10 digits — the width a decimal reading is padded to. */
const DECIMAL_UID_LENGTH = 10;
const MAX_UINT32 = 0xffffffff;

/**
 * Strips separators, uppercases, and converts the one decimal rendering that
 * can be recognized without ambiguity.
 *
 * The decimal/hex ambiguity is real and is resolved by LENGTH, not by content:
 * `04291623` is all digits but is 8 characters, the width of a 4-byte hex UID,
 * so it is read as hex. Ten digits is the only length at which a reading cannot
 * also be hex — no card carries a 5-byte UID — so it is the only length treated
 * as decimal. Anything else is left as-is and compared as the reader gave it.
 */
export function normalizeCardUid(raw: string): string {
  const stripped = raw.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!stripped) {
    return '';
  }
  if (stripped.length === DECIMAL_UID_LENGTH && /^[0-9]+$/.test(stripped)) {
    const value = Number(stripped);
    if (Number.isSafeInteger(value) && value <= MAX_UINT32) {
      return value.toString(16).toUpperCase().padStart(8, '0');
    }
  }
  return stripped;
}

/**
 * The same UID with its bytes in the opposite order, or `null` when the value
 * is not an even-length hex string and so has no byte order to reverse.
 *
 * Readers of this class disagree about byte order for the same card, and which
 * end a given device picks is not discoverable from the value itself.
 */
export function reverseCardUidBytes(uid: string): string | null {
  if (uid.length < 2 || uid.length % 2 !== 0 || !/^[0-9A-F]+$/.test(uid)) {
    return null;
  }
  const bytes = uid.match(/../g);
  if (!bytes) {
    return null;
  }
  return bytes.reverse().join('');
}

/**
 * The values to try when resolving a presented credential, in PRECEDENCE
 * ORDER — they are looked up one at a time, not as a single `$in`, so an exact
 * canonical match always wins over a coincidental byte-reversed one.
 *
 * Ordering matters for correctness, not just cost. Two distinct cards whose
 * UIDs happen to be byte-reverses of each other would otherwise be mutually
 * resolvable; trying the canonical form first means each still resolves to its
 * own truck, and the reversal is consulted only when nothing matched at all.
 *
 * The raw value is included because trucks paired before normalization existed
 * hold an un-normalized identifier, and those pairings must keep working
 * rather than silently needing a re-pair.
 */
export function cardUidLookupCandidates(raw: string): string[] {
  const canonical = normalizeCardUid(raw);
  if (!canonical) {
    return [];
  }
  const candidates = [canonical];
  const rawTrimmed = raw.trim();
  if (rawTrimmed && rawTrimmed !== canonical) {
    candidates.push(rawTrimmed);
  }
  const reversed = reverseCardUidBytes(canonical);
  if (reversed && !candidates.includes(reversed)) {
    candidates.push(reversed);
  }
  return candidates;
}
