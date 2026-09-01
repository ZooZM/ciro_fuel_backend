import { BadRequestException } from '@nestjs/common';

/**
 * Opaque cursor for keyset ("seek method") pagination across every
 * client-facing list in feature 005 (FR-048, research R3). Deliberately NOT
 * skip/limit: a record inserted at the head of a newest-first list between
 * two page requests would otherwise shift every subsequent offset, causing
 * a record to repeat or be skipped (FR-048c). Keyset pagination anchors on
 * the last-seen row's own sort values instead of a position, so it is
 * immune to inserts anywhere except exactly at the boundary.
 *
 * The cursor is a base64url-encoded JSON object carrying the sort field
 * values of the last item on the previous page — e.g. `{ updatedAt: "...",
 * _id: "..." }` for a 2-key sort, or `{ state: "...", createdAt: "...", _id:
 * "..." }` for invoices' 3-key sort (FR-048f). Callers must not construct
 * or parse a cursor by hand — it is opaque by contract, so its shape can
 * change per collection without breaking the API contract, only the cursor
 * itself needing to round-trip through {@link encodeCursor}/{@link decodeCursor}.
 */
export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

/**
 * Decodes a cursor produced by {@link encodeCursor}. A malformed cursor
 * MUST fail loudly (400) — silently falling back to page one would turn an
 * infinite-scroll list into an infinite loop for a client stuck retrying a
 * bad cursor (T020).
 */
export function decodeCursor<T extends Record<string, unknown> = Record<string, unknown>>(
  cursor: string,
): T {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('cursor payload is not an object');
    }
    return parsed as T;
  } catch {
    throw new BadRequestException('Malformed pagination cursor');
  }
}

export interface CursorSortField {
  /** Mongo field name — also the key this field's value is stored under in the cursor payload. */
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * Builds the MongoDB keyset filter for a compound sort over `keys`, in
 * priority order, given the cursor's decoded boundary values. Standard
 * "seek method" translation of the lexicographic comparison
 * `(k1, k2, ..., kn) BEFORE (v1, v2, ..., vn)`:
 *
 *   k1 <cmp> v1
 *   OR (k1 == v1 AND k2 <cmp> v2)
 *   OR (k1 == v1 AND k2 == v2 AND k3 <cmp> v3)
 *   ... and so on, where <cmp> is `$lt` for a descending field and `$gt`
 *   for an ascending one (the direction the field is sorted in determines
 *   which side "next page" is on).
 */
export function buildKeysetFilter(
  keys: CursorSortField[],
  boundary: Record<string, unknown>,
): Record<string, unknown> {
  const or: Record<string, unknown>[] = [];
  for (let i = 0; i < keys.length; i++) {
    const clause: Record<string, unknown> = {};
    for (let j = 0; j < i; j++) {
      clause[keys[j].field] = boundary[keys[j].field];
    }
    const op = keys[i].direction === 'desc' ? '$lt' : '$gt';
    clause[keys[i].field] = { [op]: boundary[keys[i].field] };
    or.push(clause);
  }
  return { $or: or };
}

/** Builds the Mongo `.sort(...)` spec matching a `CursorSortField[]` definition. */
export function buildSortSpec(keys: CursorSortField[]): Record<string, 1 | -1> {
  return Object.fromEntries(keys.map((k) => [k.field, k.direction === 'desc' ? -1 : 1]));
}

/** Extracts the cursor payload (this document's own values for each sort key) from a document. */
export function extractCursorPayload(
  doc: Record<string, unknown>,
  keys: CursorSortField[],
): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k.field, doc[k.field]]));
}
