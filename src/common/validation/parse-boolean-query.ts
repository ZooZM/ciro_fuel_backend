import { BadRequestException } from '@nestjs/common';

/**
 * spec 017 (operator dashboard) — read an optional boolean query parameter.
 *
 * Absent and empty both mean "no filter". They must, and the distinction is
 * load-bearing: `isActive=false` is a real, narrowing filter, so a helper that
 * coerced with `Boolean(value)` or `value === 'true'` would turn "show me the
 * deactivated drivers" into "show me the active ones" — a filter that returns
 * plausible rows and the wrong ones, with no error anywhere.
 *
 * Anything other than `true`/`false` is refused rather than coerced, for the
 * same reason a typo'd enum filter is (Constitution I).
 */
export function parseBooleanQuery(
  value: string | undefined,
  parameterName: string,
): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new BadRequestException(`${parameterName} must be true or false`);
}
