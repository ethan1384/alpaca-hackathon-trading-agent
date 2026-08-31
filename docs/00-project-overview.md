# Project Overview

## Context

Hackathon project for **Alpaca AI Trading Agents** (lablab.ai).

Phase 1 delivers:

- A server-side Alpaca WebSocket hub (single connection)
- SSE fan-out to browser clients
- A real-time dashboard with candlestick charts

Phase 2+ will add strategies, AI agents, order execution, and persistence.

**Hackathon rules:** the official guidelines and FAQ are restated as a
checkable rulebook in `docs/05-hackathon-rules.md` and enforced in code
(`src/config/competition.ts`, `src/server/strategies/guardrails.ts`,
`src/server/alpaca/account-guard.ts`). Read it before touching execution.

**Calibration & risk:** `docs/06-options-parameters.md` holds the parameter
spec (universe, IV signals, entry/exit, portfolio caps), the operational
guardrails, and the indicator glossary. Each item is tagged `enforced`,
`default`, or `gap`.

**Options mandate:** every strategy must incorporate options trading. The
strategy layer enforces this — a `StrategySignal` (`src/domain/strategy.ts`) can
only resolve to option contracts, and execution goes through option/`mleg`
orders. See `docs/04-llm-agent.md` and `src/server/strategies/`.

## Principles

1. **Single repo, single Next.js app** — no monorepo, no separate services.
2. **Alpaca credentials stay on the server** — never exposed to the browser.
3. **One WebSocket connection** — Alpaca allows only one concurrent market-data connection per account on many plans.
4. **HMR-safe singleton** — the hub lives on `globalThis.__marketHub`.
5. **Normalized domain types** — all UI and future strategy code consumes friendly types, not Alpaca wire keys.

## Demo outside market hours

Set `ALPACA_DATA_FEED=test` to use Alpaca's 24/7 test stream with symbol `FAKEPACA`.

When the US market is closed on live feeds, the UI shows a badge and falls back to REST historical bars.
