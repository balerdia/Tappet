const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "5 min ago", "3 hours ago", or a date for anything older. */
export function when(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 0) return `at ${new Date(iso).toLocaleString()}`;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < 24 * HOUR) {
    const hours = Math.floor(diff / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return new Date(iso).toLocaleString();
}
