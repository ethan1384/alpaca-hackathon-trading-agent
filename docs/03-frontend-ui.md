# Frontend UI

## Components

| Component | Responsibility |
|---|---|
| `Dashboard` | Layout, hydration, stream hook |
| `MarketStatusBadge` | Market open/closed, paper/live, feed, connection |
| `SymbolGrid` / `SymbolCard` | Per-symbol price, spread, chart. Option symbols show a readable label (`AAPL Call 150 $ · 16 jan. 2026`). Cards are clickable → open the detail view |
| `SymbolDetailDialog` | Full-screen "TradingView" view for the clicked card: large chart, volume, crosshair OHLC legend, per-view timeframe, live bid/ask/spread, and the `OrderBookLadder` side panel (crypto) |
| `OrderBookLadder` | L2 depth ladder in the detail view: ~12 bid/ask levels with cumulative-size depth bars, mid + spread. Reads `market-store.bySymbol[symbol].lastOrderBook`; crypto-only (shows a hint for stock/option symbols) |
| `PriceChart` | lightweight-charts candlesticks with incremental `series.update()`. Optional `showVolume` / `showLegend` / `intraday` props (off for the grid cards), plus `markers` (bar-anchored annotations) and `priceLines` (horizontal levels) used by the agent cockpit |
| `AgentLiveView` / `AgentPipeline` | The agent cockpit at the top of the Agent tab — see "Agent cockpit" below |
| `ConfigPanel` | Symbol add/remove, option search launcher, timeframe selector |
| `OptionSearchButton` | Sidebar button that opens the option-search dialog; owns test-feed + symbol-limit gating |
| `OptionChainDialog` / `OptionChainFilters` / `OptionChainTable` | Modal option-chain search: filter by underlying / expiration / call-put / strike range or ATM±%, click-to-sort greeks+IV table. Per-row **Acheter** / **Vendre** fills the order ticket (`ui-store.sendToTicket`); **Suivre** still subscribes to the watchlist. Mounted once in `Dashboard`, opened via `ui-store.optionsSearchOpen` |
| `OrderTicket` | Manual order form. Contract is picked from the chain or a tracked-options dropdown — no OCC typing. Shows `formatOptionLabel` (Call/Put, strike, expiration); OCC is secondary. |

## State management

### Real-time: Zustand (`market-store`)

Selectors + `useShallow` prevent full-tree re-renders on high-frequency ticks.

Updated by `useMarketStream` only — not React Context.

Per-symbol state: `bars`, `lastQuote`, `lastTrade`, `lastOrderBook` (crypto L2 snapshot),
`lastUpdatedAt`.

### REST: TanStack Query

- `useBars` — historical backfill via `/api/bars`
- `useClock` — market status via `/api/clock` (polls every 15s when closed)
- `useOptionExpirations` / `useOptionChain` — option search via `/api/options/contracts`
  (the chain polls every 30s while the dialog is open; the `indicative` feed is ~15min delayed)

### Config: Zustand (`config-store`)

Symbols, timeframe, read-only paper/feed flags.

### UI: Zustand (`ui-store`)

`activeSymbol` — the symbol whose `SymbolDetailDialog` is open (`null` = closed). Set by
`SymbolCard` on click, cleared on dialog close.

`optionsSearchOpen` — whether the `OptionChainDialog` is open. Set by `OptionSearchButton`
or the order ticket's **Choisir un contrat** button.

`optionsSearchUnderlying` — optional ticker used to prefill the chain's underlying when the
dialog opens (consumed on open). Set by the order ticket from the current contract or the
first equity on the watchlist.

`dashboardTab` — `"market"` | `"trading"`. Moved out of `Dashboard` local state so the chain
can switch to Trading after **Acheter** / **Vendre**.

`ticketIntent` — `{ symbol, side, limitPrice? }` the order ticket should load. `sendToTicket`
sets the intent, switches to the trading tab, and closes the chain dialog. Positions table
symbol clicks also call it (sell a long / buy a short).

## Tick coalescing (two layers)

1. **Server hub (200ms)** — aggregates events before SSE fan-out
2. **Client rAF** — batches parsed SSE events before Zustand updates

Never push one store update per raw tick.

## Charts

`PriceChart` uses `lightweight-charts` v5:

- Initial load: `series.setData()`
- Live updates: `series.update()` on the latest bar (same timestamp) or new bar

This avoids React re-rendering the chart on every tick.

## Agent cockpit (`AgentLiveView`)

Top of the Agent tab: what the LLM agent is doing, on the chart it is doing it to.

- **State.** `deriveAgentPhase()` (`src/lib/agent-phase.ts`, pure + unit-tested)
  turns the read-only status payload plus "is a cycle in flight" into one of
  `booting | offline | standby | armed | scanning | thinking | monitoring |
  alert | closing | done`. The agent has no long-lived process — `runAgentCycle()`
  starts and ends — so the live state is *reconstructed* from the same inputs the
  next cycle branches on: competition phase, the ET entry window, whether today's
  entry is spent, and the zone each open spread marks into. Keep that mapping in
  step with `src/server/agent/run-cycle.ts`.
- **Pipeline.** `AgentPipeline` renders the cycle as `market feed → trigger →
  setup → LLM decision → guardrails/order`, pulsing on the step the phase points
  at. `AGENT_PIPELINE_STEPS` and `TONE_CLASSES` are the single source for labels
  and colours.
- **Chart.** The underlying's latest 1-min session (`/api/bars`, merged with live
  hub bars via `mergeTrailingBars`). Out of hours it falls back to the previous
  session and says so in the header, so an overnight chart never reads as live.
  The view subscribes the underlying additively — it never unsubscribes, which
  would yank a symbol the user added in the Market tab.
- **Decisions on the tape.** `decisionMarkers()` (`src/lib/decision-markers.ts`,
  pure + unit-tested) projects the [O5] decision log onto the candles: entry,
  close, LLM veto, dead-zone hold, guardrail block, no-setup. Each decision snaps
  back to the candle it happened in. Open spreads draw dashed short/long strike
  levels.
- **Read-only.** Nothing here can move an order. The auto-run timer and the
  manual "Run cycle" button live in `AgentPanel` and are passed down, so a single
  cycle timer exists no matter how many panels are mounted.

## Timeframe note

The UI timeframe selector affects REST historical bars only. Live stream bars are always 1-minute bars from Alpaca's `bars` channel.

## Detail view (`SymbolDetailDialog`)

- Click (or keyboard-activate) any `SymbolCard` → `ui-store.activeSymbol` → the dialog opens.
- The dialog has its **own** timeframe state (defaults to `config-store.timeframe`) and fetches
  bars directly via `fetchBars` (`src/lib/api/bars.ts`) — **not** through `useBars` /
  `market-store`, whose single per-symbol `bars` array is timeframe-agnostic and owned by the grid.
- Live candles (always 1-minute) are spliced onto the fetched history with
  `mergeTrailingBars` **only when the view timeframe is `1Min`**; other timeframes stay static
  with a live last price / bid / ask.
- Options with no OPRA subscription return empty `/api/bars` → the dialog shows an explanatory
  empty state.

## Options

- `OptionChainDialog` filters a chain by underlying / expiration / call-put / strike range
  or an ATM±% preset, and shows a sortable table with bid/ask, last, mark, volume, open
  interest, IV and greeks. Per-row **Acheter** / **Vendre** calls `ui-store.sendToTicket`
  with the OCC `symbol` (and ask/bid as `limitPrice` when present) — the ticket displays
  `formatOptionLabel` (`AAPL Call 150 $ · 16 jan. 2026`), not the raw OCC. **Suivre** still
  subscribes via `postSubscription` (`src/lib/api/subscriptions.ts`) + `config-store.addSymbol`.
  Disabled under `ALPACA_DATA_FEED=test` and at the shared 10-symbol limit.
- Server side (`src/server/alpaca/options.ts`): `listOptionExpirations` uses
  `trading.collectOptionsContracts` (metadata only); `getOptionChain` joins that contract
  list with `marketData.collectOptionSnapshotsBySymbol` (batched by 100) on the OCC symbol.
- Option cards reuse `PriceChart`. Historical candles come from `/api/bars`
  (`getOptionBars`); live candles are synthesized in the hub from the option trade stream
  (there is no option `bars` channel), so `market-store.applyBar` replaces the trailing
  candle when its timestamp matches.

## Paper vs live

No toggle in the UI. `MarketStatusBadge` shows **Paper** or **Live** from server config.
