/**
 * spec 007 FR-033: the driver's daily delivery count uses one boundary —
 * `platform.dayBoundaryTimezone` — never the caller's own clock, so two
 * drivers (or a driver and an admin checking on them) never disagree about
 * which day a delivery landed on. No date library is installed; this uses
 * only `Intl.DateTimeFormat`, correct for any IANA zone including ones that
 * observe DST (the offset is derived from the actual instant, not assumed
 * fixed).
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtcMillis = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour') % 24, // Intl can format midnight as "24"
    value('minute'),
    value('second'),
  );
  return (asUtcMillis - instant.getTime()) / 60_000;
}

/** The instant `00:00:00` fell at, in `timeZone`, on the day containing `instant`. */
export function startOfDayInTimezone(instant: Date, timeZone: string): Date {
  const offsetMinutes = offsetMinutesAt(instant, timeZone);
  const zonedNow = new Date(instant.getTime() + offsetMinutes * 60_000);
  const startOfZonedDayAsUtc = Date.UTC(
    zonedNow.getUTCFullYear(),
    zonedNow.getUTCMonth(),
    zonedNow.getUTCDate(),
  );
  return new Date(startOfZonedDayAsUtc - offsetMinutes * 60_000);
}
