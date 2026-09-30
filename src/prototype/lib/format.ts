// Formatting helpers. Everything is shown in IST so server and browser renders match.

const TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000;

const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: TZ });
const shortDateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: TZ });
const timeFmt = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ });
const numberFmt = new Intl.NumberFormat("en-IN");

export function formatDate(iso: string | null | undefined) {
  return iso ? dateFmt.format(new Date(iso)) : "—";
}

export function formatShortDate(iso: string | null | undefined) {
  return iso ? shortDateFmt.format(new Date(iso)) : "—";
}

export function formatTime(iso: string | null | undefined) {
  return iso ? timeFmt.format(new Date(iso)).replace("am", "AM").replace("pm", "PM") : "—";
}

export function formatDateTime(iso: string | null | undefined) {
  return iso ? `${formatDate(iso)}, ${formatTime(iso)}` : "—";
}

export function formatNumber(n: number) {
  return numberFmt.format(n);
}

export function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Relative time like "2 h ago", "in 3 days". `now` is passed in so renders are deterministic. */
export function formatRelative(iso: string, now: number) {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const text = mins < 60 ? `${Math.max(1, mins)} min` : hours < 24 ? `${hours} h` : `${days} day${days === 1 ? "" : "s"}`;
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

/** IST date (YYYY-MM-DD) and time (HH:mm) parts for form inputs. */
export function toIstParts(iso: string) {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}

export function fromIstParts(date: string, time: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const d = new Date(`${date}T${time}:00+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function percent(score: number, max: number) {
  return max > 0 ? Math.round((score / max) * 1000) / 10 : 0;
}
