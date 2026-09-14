import { BadRequestException } from '@nestjs/common';

/**
 * spec 017 (operator dashboard) — read an optional enum-valued query
 * parameter, treating an ABSENT and an EMPTY value identically as "no filter"
 * and refusing anything else with a 400.
 *
 * The empty-string case is the one worth naming. A dashboard select whose
 * "all" option carries `value=""` sends `?type=` on every unfiltered request;
 * without this, that string reaches the query as a literal and the list
 * silently returns nothing — indistinguishable from a platform with no
 * companies on it (FR-011, FR-013).
 *
 * Refusing an unrecognised value rather than ignoring it is Constitution I:
 * a typo'd filter must say so, never widen back to everything.
 */
export function parseEnumQuery<T extends Record<string, string>>(
  allowed: T,
  value: string | undefined,
  parameterName: string,
): T[keyof T] | undefined {
  if (value === undefined || value === '') return undefined;
  const values = Object.values(allowed) as string[];
  if (!values.includes(value)) {
    throw new BadRequestException(
      `${parameterName} must be one of: ${values.join(', ')}`,
    );
  }
  return value as T[keyof T];
}
