/**
 * The platform schedules everything in India Standard Time. IST has no daylight saving,
 * so a fixed offset is exact.
 */
export const APP_TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET = "+05:30";
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

const LOCAL_INPUT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** Parse an `<input type="datetime-local">` value as IST. Returns null if malformed. */
export function parseIstInput(value: string): Date | null {
  if (!LOCAL_INPUT_RE.test(value)) return null;
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  const date = new Date(`${withSeconds}${IST_OFFSET}`);
  if (Number.isNaN(date.getTime())) return null;
  // Reject dates that don't exist (e.g. 31 February) instead of letting them roll over.
  return toIstInput(date) === withSeconds.slice(0, 16) ? date : null;
}

/** Format a Date as an IST `datetime-local` value (YYYY-MM-DDTHH:mm). */
export function toIstInput(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}
