/**
 * spec 016 (broadcast fuel exchange offers) T050a — was a local function duplicated
 * three times (`dispatch.service.ts`, `ratings.service.ts`, `payments.service.ts`), not
 * an importable helper. Extracted so the new proposal path (T050) doesn't make a fourth
 * copy (Constitution I). Every one of those call sites shares the same discipline: a
 * duplicate-key violation is translated into a typed `ConflictException`, never guarded
 * by a prior existence check that two concurrent writes could both pass identically.
 */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}
