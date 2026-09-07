/**
 * Format a Date as `YYYY-MM-DD` in *local* time.
 *
 * `toISOString()` converts to UTC first, which rolls the date back a day for
 * anyone east of Greenwich — i.e. everyone using this roster.
 */
export function isoDate(d: Date): string {
    const month = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
}
