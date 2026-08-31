interface ChangeBadgeProps {
  current?: number;
  previous?: number;
}

export function ChangeBadge({ current, previous }: ChangeBadgeProps) {
  if (current == null || previous == null || previous === 0) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }

  const change = ((current - previous) / previous) * 100;
  const positive = change >= 0;

  return (
    <span
      className={
        positive ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }
    >
      {positive ? "+" : ""}
      {change.toFixed(2)}%
    </span>
  );
}
