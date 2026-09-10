# Alpaca Options Trading Agent

Personal research project for building, backtesting and operating options-trading
agents on Alpaca paper accounts.

The repository is a single Next.js application containing the market-data hub,
operator dashboard, trading API, backtests, risk controls, MCP server and an LLM-assisted
SPY credit-spread agent.

> **Paper trading first.** Order routes submit to the Alpaca account configured in
> `.env`. Keep `ALPACA_PAPER=true` until the strategy, authentication and operational
> controls have been reviewed for your deployment.

## Features

- Real-time stock, crypto and option monitoring through a server-owned Alpaca WebSocket hub.
- SSE fan-out to a React dashboard with charts, quotes and crypto order-book depth.
- Manual account, position and order management.
- Option-chain search and multi-leg option orders.
- Ascending-triangle swing, ORB debit-vertical and short credit-spread backtest engines.
- Deterministic portfolio limits, data-quality checks, reconciliation and kill switch.
- OpenAI-compatible LLM client used as a narrow entry-veto and early-exit layer.
- Streamable HTTP MCP server at `/api/mcp` for agent integrations.
- Local filesystem or Vercel Blob persistence for agent state and decision logs.

## Archived agent and current research

The implemented autonomous strategy is archived at tag
`archive/credit-spread-agent`. It trades a defined-risk SPY bull put spread:

- short put near 0.175 delta;
- long protective put five points lower;
- 1–2 DTE;
- 1% of account equity at risk per spread;
- at most two managed spreads;
- mechanical profit target, stop and time-based exits;
- LLM veto before entry and optional early close in the loss "dead zone".

The original agent window is frozen to the former event dates in
`src/config/competition.ts`. As a result, autonomous entries are currently closed even
when the legacy enforcement flag is disabled. Manual trading, market data and backtests
remain usable. Before running the autonomous agent as an ongoing personal system, replace
the fixed window with a configurable operating calendar and update its tests. See
[Legacy competition compatibility](docs/05-legacy-competition.md).

The current research track is an ascending-triangle breakout on daily bars, expressed as
a 30–45 DTE long call or bull call spread. Its detector and backtest are implemented, but
no tested variant currently demonstrates an edge and it is intentionally not wired to live
execution. See [Ascending-triangle strategy](docs/09-strategie-triangle.md).

## Requirements

- Node.js 20+ (24 recommended)
- pnpm
- Alpaca paper-trading API keys
- Optional: an OpenAI-compatible LLM endpoint such as Ollama

## Setup

```bash
pnpm install
cp .env.example .env
# Fill ALPACA_API_KEY and ALPACA_API_SECRET
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Important environment variables

| Variable | Description |
|---|---|
| `ALPACA_API_KEY` | Alpaca API key ID |
| `ALPACA_API_SECRET` | Alpaca API secret |
| `ALPACA_PAPER` | Use the paper-trading account; keep `true` by default |
| `ALPACA_DATA_FEED` | `test`, `iex` or `sip` |
| `NEXT_PUBLIC_DEFAULT_SYMBOLS` | Initial comma-separated watchlist |
| `RISK_ENFORCE` | Enforce account and operational risk checks on opening orders |
| `MCP_AUTH_TOKEN` | Protect `/api/mcp` and `/api/agent/run` with a bearer token |
| `AGENT_ENABLED` | Enable or disable the agent cycle endpoint |
| `AGENT_STORAGE` | `filesystem` locally or `blob` on Vercel |
| `AGENT_LLM_BASE_URL` | Base URL of an OpenAI-compatible chat-completions API |
| `AGENT_LLM_MODEL` | Model served by that endpoint |

See [.env.example](.env.example) for the complete configuration.

## Commands

```bash
pnpm dev
pnpm test
pnpm lint
pnpm build
pnpm start
```

## Architecture

```text
Alpaca REST + WebSockets
          |
          v
server adapters -> normalized domain models -> MarketHub / strategy layer
          |                                      |
          v                                      v
      REST + SSE                          risk gates -> Alpaca orders
          |
          v
 React dashboard (TanStack Query + Zustand)
```

Credentials and Alpaca connections stay on the server. `executeSignal()` remains the
single strategy execution entry point so all opening trades cross the same validation and
risk layers.

## Documentation

- [Architecture](docs/01-architecture.md)
- [Alpaca integration](docs/02-alpaca-integration.md)
- [Frontend UI](docs/03-frontend-ui.md)
- [Trading and MCP](docs/04-trading-and-mcp.md)
- [Legacy competition compatibility](docs/05-legacy-competition.md)
- [Options parameters, risk and operations](docs/06-options-parameters.md)
- [Credit-spread strategy](docs/07-strategie-credit-spreads.md)
- [LLM decision agent](docs/08-agent.md)
- [Ascending-triangle strategy](docs/09-strategie-triangle.md)

## Safety notes

- The application can place orders; do not expose write routes publicly without an
  authentication layer.
- `COMPETITION_ENFORCE=false` and `RISK_ENFORCE=false` are development defaults, not safe
  production defaults.
- Closing orders are intentionally never blocked by opening-risk gates.
- Historical option bars are not used for live pricing; entries use the latest option
  quotes and snapshots.
