/**
 * Backtest engines emit one warning per rejected trigger, so the same text
 * ("SPY 2026-06-05: debit/width 0.08 outside [0.1, 0.9] — no trade") can repeat
 * many times in a run. Collapse identical strings for display, keeping first-seen
 * order and an occurrence count, so the list stays readable and every `key` is
 * unique.
 */
export function groupWarnings(warnings: string[]): { text: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const w of warnings) {
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts].map(([text, count]) => ({ text, count }));
}
