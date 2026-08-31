import type { CreditBacktestStats, CreditTrade, EquityPoint } from "@/domain/backtest-credit";

function group(
  trades: CreditTrade[],
  key: (t: CreditTrade) => string,
): Record<string, { trades: number; pnl: number; hitRate: number }> {
  const out: Record<string, { trades: number; pnl: number; hitRate: number }> = {};
  for (const trade of trades) {
    const k = key(trade);
    const entry = out[k] ?? { trades: 0, pnl: 0, hitRate: 0 };
    entry.trades += 1;
    entry.pnl += trade.pnl;
    out[k] = entry;
  }
  for (const [k, entry] of Object.entries(out)) {
    const wins = trades.filter((t) => key(t) === k && t.pnl > 0).length;
    entry.hitRate = entry.trades > 0 ? wins / entry.trades : 0;
  }
  return out;
}

export function summariseCredit(
  trades: CreditTrade[],
  initialEquity: number,
  equityCurve: EquityPoint[],
): CreditBacktestStats {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : 0;

  let peak = initialEquity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, peak - point.equity);
  }

  const byExitReason: Record<string, number> = {};
  for (const trade of trades) {
    byExitReason[trade.exit.reason] = (byExitReason[trade.exit.reason] ?? 0) + 1;
  }

  const mean = (pick: (t: CreditTrade) => number) =>
    trades.length > 0 ? trades.reduce((a, t) => a + pick(t), 0) / trades.length : 0;

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    hitRate: trades.length > 0 ? wins.length / trades.length : 0,
    avgWin,
    avgLoss,
    payoffRatio,
    breakEvenHitRate: payoffRatio > 0 ? 1 / (1 + payoffRatio) : 1,
    expectancy: trades.length > 0 ? totalPnl / trades.length : 0,
    totalPnl,
    finalEquity: initialEquity + totalPnl,
    returnPct: initialEquity > 0 ? totalPnl / initialEquity : 0,
    maxDrawdown,
    maxDrawdownPct: initialEquity > 0 ? maxDrawdown / initialEquity : 0,
    avgCredit: mean((t) => t.credit),
    avgMaxLoss: mean((t) => t.maxLoss),
    avgMinutesHeld: mean((t) => t.minutesHeld),
    bySide: group(trades, (t) => t.side),
    byUnderlying: group(trades, (t) => t.underlying),
    byExitReason,
  };
}
