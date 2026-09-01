/**
 * Fixed platform-side page size for every cursor-paginated client list
 * (feature 005, FR-048). Deliberately not client-supplied — a caller-chosen
 * page size is an abuse lever with no requirement asking for one.
 */
export const DEFAULT_PAGE_SIZE = 20;
