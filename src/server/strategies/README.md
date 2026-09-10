# Strategy layer

Trading strategies analyse an underlying and emit a `StrategySignal` describing an option
structure. They never submit equity or crypto trades directly.

## Contract

```typescript
export interface StrategyContext {
  underlying: string;
  bars: Bar[];
  quote?: Quote;
  position?: TradingPosition;
  clock: MarketClock;
}

export interface Strategy {
  readonly name: string;
  evaluate(ctx: StrategyContext): Promise<StrategySignal | null>;
}
```

`StrategySignalSchema` supports long calls and puts, debit verticals, credit verticals and
long straddles. Resolved legs must be valid OCC option symbols on the declared underlying,
with the correct leg shape for the selected strategy kind.

## Pipeline

```text
strategy or candidate builder
  -> StrategySignal with contract-selection criteria
  -> resolveContracts() selects concrete OCC legs from the live chain
  -> executeSignal() runs legacy calendar checks and account risk gates
  -> signalToOrder() creates a single-option or mleg Alpaca order
  -> placeOrder()
```

`executeSignal()` is the only strategy execution entry point. Opening orders pass through
the shared risk layer; closing orders remain available so risk can always be reduced. The
helpers accept injectable dependencies so tests can run without contacting Alpaca.

## Status

- **Archived live agent:** `credit-spread-strategy.ts` builds the mechanical SPY bull put
  spread used by the LLM agent. The implementation remains wired under `src/server/agent/`
  but its historical entry window is closed. Tag: `archive/credit-spread-agent`.
- **Research, backtest only:** `src/server/backtest/triangle.ts` contains the
  lookahead-free ascending-triangle detector and `triangle-engine.ts` evaluates it. The
  research currently shows no edge and has not been turned into a live `Strategy`.
- **Not built:** a live triangle strategy and an `/api/agent` SSE surface.

Read `docs/07-strategie-credit-spreads.md`, `docs/08-agent.md` and
`docs/09-strategie-triangle.md` before changing these paths.

## External surface

The MCP tool `place_option_strategy` exposes contract selection and execution to clients.
