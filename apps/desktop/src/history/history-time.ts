/** Local time labels for the History panel (#365). Never UTC, never raw stamps. */

function atLocal(unix: number): Date {
  return new Date(unix * 1000);
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatTime(d: Date): string {
  return d.toLocaleString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function shortWeekday(d: Date): string {
  return d.toLocaleString(undefined, { weekday: 'short' });
}

function shortMonthDay(d: Date, includeYear: boolean): string {
  const month = d.toLocaleString(undefined, { month: 'short' });
  const day = d.getDate();
  if (includeYear) return `${month} ${day}, ${d.getFullYear()}`;
  return `${month} ${day}`;
}

/** Row subtitle: Today 10:22 AM · older: Mon, Nov 10, 4:05 PM · year when not current. */
export function formatHistoryRowWhen(unix: number, now = new Date()): string {
  const d = atLocal(unix);
  const today = startOfLocalDay(now);
  const target = startOfLocalDay(d);
  const dayMs = 86_400_000;
  const diffDays = Math.round((today.getTime() - target.getTime()) / dayMs);
  const thisYear = now.getFullYear() === d.getFullYear();

  if (diffDays === 0) return `Today ${formatTime(d)}`;
  if (!thisYear) {
    return `${shortWeekday(d)}, ${shortMonthDay(d, true)} · ${formatTime(d)}`;
  }
  return `${shortWeekday(d)}, ${shortMonthDay(d, false)}, ${formatTime(d)}`;
}

/** Day group headers: Today, Yesterday, Monday, Nov 10, or Thursday, Sep 3, 2026 */
export function formatHistoryDayHeader(unix: number, now = new Date()): string {
  const d = atLocal(unix);
  const today = startOfLocalDay(now);
  const target = startOfLocalDay(d);
  const dayMs = 86_400_000;
  const diffDays = Math.round((today.getTime() - target.getTime()) / dayMs);
  const thisYear = now.getFullYear() === d.getFullYear();

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (!thisYear) {
    const wd = d.toLocaleString(undefined, { weekday: 'long' });
    const month = d.toLocaleString(undefined, { month: 'short' });
    return `${wd}, ${month} ${d.getDate()}, ${d.getFullYear()}`;
  }
  const wd = d.toLocaleString(undefined, { weekday: 'long' });
  const month = d.toLocaleString(undefined, { month: 'short' });
  return `${wd}, ${month} ${d.getDate()}`;
}

/** Compare banner and restore confirm: Tue, Nov 17, 2026 · 10:22 AM */
export function formatHistoryLongWhen(unix: number): string {
  const d = atLocal(unix);
  const wd = d.toLocaleString(undefined, { weekday: 'short' });
  const month = d.toLocaleString(undefined, { month: 'short' });
  return `${wd}, ${month} ${d.getDate()}, ${d.getFullYear()} · ${formatTime(d)}`;
}

/** Restore confirm title fragment: Nov 17, 10:22 AM */
export function formatRestoreTitleWhen(unix: number, now = new Date()): string {
  const d = atLocal(unix);
  const thisYear = now.getFullYear() === d.getFullYear();
  const month = d.toLocaleString(undefined, { month: 'short' });
  const day = d.getDate();
  const yearPart = thisYear ? '' : `, ${d.getFullYear()}`;
  return `${month} ${day}${yearPart}, ${formatTime(d)}`;
}

export function historyDayKey(unix: number, now = new Date()): string {
  const d = atLocal(unix);
  if (isSameLocalDay(d, now)) return 'today';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
