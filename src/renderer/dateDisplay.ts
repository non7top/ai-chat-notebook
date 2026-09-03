/**
 * Formats a stored timestamp as the date it carries, not as the viewer's
 * timezone would render it.
 *
 * These strings keep the offset they were recorded with ("...T03:09:33+07:00").
 * Passing one through Date and toLocaleDateString reinterprets the instant in
 * whatever zone this machine is set to, which shifts a late-evening or
 * early-morning conversation to the neighbouring day. An archive should say
 * when something happened where it happened.
 */
export function displayDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) {
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleDateString();
  }
  const [, year, month, day] = m;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(day)} ${months[Number(month) - 1]} ${year}`;
}

/** Date plus time of day, still as recorded. */
export function displayDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return displayDate(iso);
  const [, , , , hour, minute] = m;
  return `${displayDate(iso)}, ${hour}:${minute}`;
}
