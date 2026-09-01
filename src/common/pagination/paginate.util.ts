import { FilterQuery, HydratedDocument, Model } from 'mongoose';
import { DEFAULT_PAGE_SIZE } from '../constants/pagination.constants';
import {
  CursorSortField,
  buildKeysetFilter,
  buildSortSpec,
  decodeCursor,
  encodeCursor,
  extractCursorPayload,
} from './cursor.util';

export interface PaginatedResponse<T> {
  items: T[];
  /** `null` means the end of the list. A caller must never treat a missing field the same as null — this codec always sets it explicitly. */
  nextCursor: string | null;
}

/**
 * Executes one page of a keyset-paginated query (research R3). Shared by
 * every client list this feature paginates (orders, invoices, payments,
 * notifications) so the "fetch one extra to detect a next page, then slice"
 * recipe — the part easiest to get subtly wrong — exists in exactly one
 * place rather than once per module.
 *
 * `filter` should already carry every scoping condition the caller needs
 * (tenant plugin is automatic; caller-added `clientId`/`recipientUserId`
 * conditions and any status/date filters go in `filter`, never bolted on
 * after — see FR-048d, filters apply across the whole set, not the page).
 */
export async function paginate<T>(
  model: Model<T>,
  filter: FilterQuery<T>,
  sortKeys: CursorSortField[],
  cursor: string | undefined,
  pageSize: number = DEFAULT_PAGE_SIZE,
  /**
   * A Mongo projection (e.g. `{ rawPayload: 0 }`) applied at the query
   * level, not on the response afterward — a field excluded here is never
   * fetched at all, so it cannot leak through a later change that forgets
   * to strip it (spec 005 T074).
   */
  projection?: Record<string, 0 | 1>,
): Promise<PaginatedResponse<HydratedDocument<T>>> {
  let effectiveFilter: FilterQuery<T> = filter;
  if (cursor) {
    const boundary = decodeCursor(cursor);
    effectiveFilter = { $and: [filter, buildKeysetFilter(sortKeys, boundary)] } as FilterQuery<T>;
  }

  const sortSpec = buildSortSpec(sortKeys);
  // pageSize + 1: whether a next page exists is read off the extra row,
  // avoiding a separate count query on every page fetch.
  const docs = await model
    .find(effectiveFilter, projection)
    .sort(sortSpec)
    .limit(pageSize + 1)
    .exec();

  const hasMore = docs.length > pageSize;
  const items = hasMore ? docs.slice(0, pageSize) : docs;

  const nextCursor = hasMore
    ? encodeCursor(extractCursorPayload(items[items.length - 1].toObject(), sortKeys))
    : null;

  return { items, nextCursor };
}
