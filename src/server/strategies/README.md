# Strategies (Phase 2)

Trading strategy implementations. **Hackathon rule: every strategy must
incorporate options trading.** That rule is enforced in code — see
`src/domain/strategy.ts`.

## The contract

A strategy analyses an **underlying** and emits a `StrategySignal` describing a
directional thesis as an **option structure**, never an equity trade.

```typescript
export interface Strategy {
  readonly name: string;
  evaluate(ctx: StrategyContext): Promise<StrategySignal | null>; // null = do nothing
}

export interface StrategyContext {
  underlying: string;          // never an option symbol
  bars: Bar[];                 // from MarketHub.getBars()
  quote?: Quote;
  position?: TradingPosition;  // current option position for this thesis
  clock: MarketClock;
}
```

`StrategyContext` is built by a snapshot step from the hub ring buffer + trading
API. `Strategy` / `StrategyContext` live in `src/server/strategies/index.ts`;
`StrategySignal` + its Zod schema live in `src/domain/strategy.ts`.

## Signal shape (options-native)

```typescript
{
  strategy: "ascending-triangle",
  underlying: "SPY",
  bias: "bullish",                       // bullish | bearish | neutral
  kind: "long_call",                     // long_call | long_put | bull_call_spread
                                         //   | bear_put_spread | long_straddle
  selection: {                           // how to pick the contract(s)
    targetDelta: 0.40,                   //   preferred selector
    minDte: 7, maxDte: 30,
    minOpenInterest: 500,
    maxSpreadPct: 0.20,
    spreadWidth: 5,                      //   verticals only
  },
  confidence: 0.72,
  reason: "close broke triple resistance on 2x volume",
  maxContracts: 2,
  entryLimit: 4.20,                      // net debit; omit for market
  timestamp: "2026-08-28T14:31:00Z",
  // resolvedLegs — filled by select-contract before execution
}
```

`StrategySignalSchema` rejects any `resolvedLegs` entry that is not an OCC option
symbol on the signal's underlying, and checks leg shape per `kind` (a
`bull_call_spread` must buy the lower call and sell the higher call, etc.).

## Pipeline

```
Strategy.evaluate(ctx)                → StrategySignal (selection only)
  → resolveContracts(signal, deps)    → OptionOrderLeg[]   (select-contract.ts)
      listOptionExpirations + getOptionChain, filter by DTE / delta / liquidity
  → executeSignal(signal)             → TradingOrder       (execute.ts)
      1 leg  → simple option order (positionIntent carried)
      2+ legs → mleg order  (orderClass derived by deriveOrderClass)
  → placeOrder()                      → Alpaca             (src/server/alpaca/trading.ts)
```

Both helpers take injectable `deps` (same pattern as `MarketHubDeps`) so
strategies and tests run without touching Alpaca.

## MCP

`place_option_strategy` exposes the whole pipeline to agents: pass
`{ underlying, kind, selection, maxContracts }` and it resolves + submits.

## Status

- **Built:** the LLM decision agent (`src/server/agent/`, docs/08) on the
  put-credit-spread strategy (`credit-spread-strategy.ts`) — **archived** since
  2026-09-10, git tag `archive/credit-spread-agent`.
- **Built, backtest only:** the ascending-triangle breakout detector
  (`src/server/backtest/triangle.ts`) and its engine (docs/09). It is not a
  `Strategy` here yet: its backtest shows no edge (docs/09 §7).
- **Not built:** a live triangle `Strategy`, and the `/api/agent` SSE surface.
