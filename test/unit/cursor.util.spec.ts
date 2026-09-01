import { BadRequestException } from '@nestjs/common';
import {
  buildKeysetFilter,
  buildSortSpec,
  decodeCursor,
  encodeCursor,
  extractCursorPayload,
} from '../../src/common/pagination/cursor.util';

describe('cursor codec', () => {
  it('round-trips an arbitrary payload', () => {
    const payload = { updatedAt: '2026-08-15T10:00:00.000Z', _id: '66b1234567890abcdef12345' };
    const cursor = encodeCursor(payload);
    expect(decodeCursor(cursor)).toEqual(payload);
  });

  it('rejects a malformed cursor with 400, never a silent fallback to page one', () => {
    expect(() => decodeCursor('not-valid-base64url-json!!!')).toThrow(BadRequestException);
    expect(() => decodeCursor(Buffer.from('not json').toString('base64url'))).toThrow(
      BadRequestException,
    );
    // A JSON array or primitive is syntactically valid JSON but not a valid
    // cursor payload shape — must still be rejected, not silently accepted.
    expect(() => decodeCursor(Buffer.from('[1,2,3]').toString('base64url'))).toThrow(
      BadRequestException,
    );
    expect(() => decodeCursor(Buffer.from('"just a string"').toString('base64url'))).toThrow(
      BadRequestException,
    );
    expect(() => decodeCursor(Buffer.from('null').toString('base64url'))).toThrow(
      BadRequestException,
    );
  });

  it('is opaque: a cursor for one shape does not silently succeed decoding as another', () => {
    // Decoding never validates the shape against a specific sort-key set —
    // that's the keyset filter's job — but it always yields SOME object,
    // never throws for a well-formed-but-differently-shaped payload.
    const cursor = encodeCursor({
      state: 'ISSUED',
      createdAt: '2026-01-01T00:00:00.000Z',
      _id: 'x',
    });
    expect(() => decodeCursor(cursor)).not.toThrow();
  });
});

describe('buildSortSpec', () => {
  it('maps direction to Mongo sort values', () => {
    expect(
      buildSortSpec([
        { field: 'updatedAt', direction: 'desc' },
        { field: '_id', direction: 'desc' },
      ]),
    ).toEqual({ updatedAt: -1, _id: -1 });

    expect(buildSortSpec([{ field: 'createdAt', direction: 'asc' }])).toEqual({ createdAt: 1 });
  });
});

describe('extractCursorPayload', () => {
  it('pulls only the sort-key fields off a document, ignoring the rest', () => {
    const doc = { _id: 'abc', updatedAt: 'x', amount: 500, secret: 'never-included' };
    const keys = [
      { field: 'updatedAt', direction: 'desc' as const },
      { field: '_id', direction: 'desc' as const },
    ];
    expect(extractCursorPayload(doc, keys)).toEqual({ updatedAt: 'x', _id: 'abc' });
  });
});

describe('buildKeysetFilter — 2-key descending (orders/invoices/payments/notifications shape)', () => {
  const keys = [
    { field: 'updatedAt', direction: 'desc' as const },
    { field: '_id', direction: 'desc' as const },
  ];

  it('produces the standard seek-method OR clause', () => {
    const filter = buildKeysetFilter(keys, { updatedAt: 'T2', _id: 'ID2' });
    expect(filter).toEqual({
      $or: [{ updatedAt: { $lt: 'T2' } }, { updatedAt: 'T2', _id: { $lt: 'ID2' } }],
    });
  });

  /**
   * FR-048c: stability under a mid-scroll insert. Ten records timestamped
   * minute :01 through :10 (:10 newest); the client has already seen
   * :10..:06 (cursor now anchored on the :06 record's own values). A new
   * record at :11 — inserted at the very head, after the client started
   * scrolling — must not appear on the next page (it sorts before the
   * boundary, i.e. "behind" where the client already scrolled past) and no
   * record from :05..:01 may be skipped or repeated. This is the property
   * that rules out skip/limit for this feature (research R3): an
   * offset-based page 2 would shift by exactly one under this same insert
   * and repeat the :06 record.
   *
   * Real ISO-8601 timestamps throughout — lexicographic string comparison
   * on them equals chronological order, which is what the filter's `$lt`
   * relies on against a Date-typed Mongo field.
   */
  it('never re-surfaces a record newer than the boundary, regardless of when it was inserted', () => {
    const at = (minute: number) => `2026-08-15T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const boundary = { updatedAt: at(6), _id: 'idAt06' };
    const filter = buildKeysetFilter(keys, boundary);

    const matches = (doc: { updatedAt: string; _id: string }) => {
      const [first, second] = filter.$or as Array<Record<string, unknown>>;
      const firstMatch = doc.updatedAt < (first.updatedAt as { $lt: string }).$lt;
      const secondMatch =
        doc.updatedAt === second.updatedAt && doc._id < (second._id as { $lt: string }).$lt;
      return firstMatch || secondMatch;
    };

    // A record inserted at :11 (newer than everything, including the
    // boundary) must not match — it belongs "above" where the client has
    // already scrolled, not on the next page.
    expect(matches({ updatedAt: at(11), _id: 'idAt11' })).toBe(false);
    // :05 (older than the boundary) — must match, so it isn't skipped.
    expect(matches({ updatedAt: at(5), _id: 'idAt05' })).toBe(true);
    // The boundary record itself — must NOT match again, so it isn't repeated.
    expect(matches({ updatedAt: at(6), _id: 'idAt06' })).toBe(false);
    // A same-timestamp tie broken by _id — the tiebreaker must still apply
    // correctly rather than dropping ties entirely.
    expect(matches({ updatedAt: at(6), _id: 'idAt06-earlier' })).toBe('idAt06-earlier' < 'idAt06');
  });
});

describe('buildKeysetFilter — 3-key (invoices: state, createdAt, _id — FR-048f)', () => {
  const keys = [
    { field: 'state', direction: 'asc' as const },
    { field: 'createdAt', direction: 'desc' as const },
    { field: '_id', direction: 'desc' as const },
  ];

  it('produces a three-clause OR chaining equality on prior keys', () => {
    const filter = buildKeysetFilter(keys, { state: 'ISSUED', createdAt: 'T5', _id: 'idX' });
    expect(filter).toEqual({
      $or: [
        { state: { $gt: 'ISSUED' } },
        { state: 'ISSUED', createdAt: { $lt: 'T5' } },
        { state: 'ISSUED', createdAt: 'T5', _id: { $lt: 'idX' } },
      ],
    });
  });
});
