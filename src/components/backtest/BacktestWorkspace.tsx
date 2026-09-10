"use client";

import { useState } from "react";
import { BacktestPanel } from "@/components/backtest/BacktestPanel";
import { CreditSpreadPanel } from "@/components/backtest/CreditSpreadPanel";
import { TrianglePanel } from "@/components/backtest/TrianglePanel";
import { cn } from "@/lib/utils";

/**
 * One tab, several strategies. Each has its own engine, parameters and result
 * shape — they share only the equity-curve component and the verdict framing,
 * because the question ("does the hit rate clear what the payoff needs?") is the
 * same one whichever way the premium flows.
 *
 * The credit spread was the live agent's strategy through the hackathon; it is
 * archived (git tag `archive/credit-spread-agent`, docs/07–08) and kept here
 * for comparison.
 */
const STRATEGIES = [
  { id: "triangle", label: "Ascending triangle → call", note: "Daily swing, 30-45 DTE" },
  { id: "orb", label: "ORB → debit vertical", note: "0DTE, directional" },
  { id: "credit", label: "Credit spreads (archived)", note: "1-2 DTE, former live agent" },
] as const;

type StrategyId = (typeof STRATEGIES)[number]["id"];

export function BacktestWorkspace() {
  const [strategy, setStrategy] = useState<StrategyId>("triangle");

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {STRATEGIES.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setStrategy(item.id)}
            className={cn(
              "flex flex-col items-start rounded-md border px-3 py-2 text-left transition-colors",
              strategy === item.id
                ? "border-primary bg-primary/10"
                : "border-input hover:bg-accent",
            )}
          >
            <span className="text-sm font-medium">{item.label}</span>
            <span className="text-[11px] text-muted-foreground">{item.note}</span>
          </button>
        ))}
      </div>

      {strategy === "triangle" ? (
        <TrianglePanel />
      ) : strategy === "orb" ? (
        <BacktestPanel />
      ) : (
        <CreditSpreadPanel />
      )}
    </div>
  );
}
