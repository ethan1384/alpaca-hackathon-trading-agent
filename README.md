# Alpaca Hackathon Trading Agent — Phase 1

Real-time Alpaca market dashboard built as a single Next.js application.

## Requirements

- Node.js 20+ (24 recommended)
- pnpm
- Alpaca paper trading API keys

## Setup

```bash
pnpm install
cp .env.example .env
# Fill ALPACA_API_KEY and ALPACA_API_SECRET
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment

| Variable | Description |
|---|---|
| `ALPACA_API_KEY` | Alpaca API key id |
| `ALPACA_API_SECRET` | Alpaca API secret |
| `ALPACA_PAPER` | `true` for paper trading (recommended) |
| `ALPACA_DATA_FEED` | `test` (24/7 demo), `iex`, or `sip` |
| `MARKET_BUFFER_SIZE` | Ring buffer size per symbol (default 200) |
| `NEXT_PUBLIC_DEFAULT_SYMBOLS` | Comma-separated symbols for `iex`/`sip` feeds |
| `COMPETITION_ENFORCE` | `true` to enforce the hackathon guardrails (official run); `false` warns only |
| `COMPETITION_ACCOUNT_NUMBER` | Pins execution to the official $100k competition paper account |

When `ALPACA_DATA_FEED=test`, the dashboard automatically uses the `FAKEPACA` test symbol on Alpaca's always-on test stream.

## Scripts

```bash
pnpm dev       # development server
pnpm build     # production build
pnpm start     # run production build
pnpm test      # unit tests
pnpm lint      # biome check
pnpm format    # biome format
```

## Adding a symbol

Use the sidebar in the dashboard, or:

```bash
curl -X POST http://localhost:3000/api/subscriptions \
  -H 'Content-Type: application/json' \
  -d '{"action":"add","symbols":["MSFT"]}'
```

Free tier limit: **10 symbols** with bars+quotes+trades (30 WebSocket channels).

## Changing timeframe

The timeframe selector controls REST historical backfill. Live WebSocket bars are always 1-minute bars.

## Hackathon compliance

The official rules (Alpaca AI Trading Agents, lablab.ai) are restated as a
checkable rulebook in **[docs/05-hackathon-rules.md](docs/05-hackathon-rules.md)**
and enforced in code. Key points:

- The official run uses a **dedicated $100,000 paper account** — never the
  development account. Set `COMPETITION_ACCOUNT_NUMBER` to pin it.
- Judged equity is the snapshot at **EOD Thursday 2026-09-03**, so the agent
  treats Thursday's close as the deadline and does not open legs expiring after it.
- `COMPETITION_ENFORCE=true` turns the guardrails from advisory into blocking.

Check the live state at any time via the MCP tool `get_competition_status`.

### Pre-event work & disclosures

Per the hackathon FAQ, pre-event work is permitted and **must be disclosed**.
Built before the 2026-08-28 09:30 ET kickoff:

- The Next.js application shell, Tailwind/shadcn UI setup and tooling
  (Biome, Vitest) — scaffolded from `create-next-app`.
- The Alpaca market-data layer: the single-connection WebSocket hub
  (`src/server/hub/`), payload normalization (`src/server/alpaca/`), the SSE
  fan-out and the real-time dashboard (Phase 1).

Built during the hackathon window: the options strategy layer
(`src/domain/strategy.ts`, `src/server/strategies/`), the trading + MCP surface
(`src/server/mcp/`, `/api/mcp`), the competition guardrails, the credit-spread
backtest engine (`src/server/backtest/credit-spread*`), and the LLM decision
agent (`src/server/agent/`, `src/server/llm/`, the Agent tab — see
`docs/08-agent.md`). Commit history carries the dates.

No third-party pre-existing library of our own is used beyond the public
dependencies in `package.json`.

### Why the Alpaca SDK plus our own MCP server

The FAQ asks that submissions prefer Alpaca's MCP server or CLI and explain any
SDK use. This project does both, deliberately:

- **Order execution and market data go through the official Alpaca SDK**
  (`@alpacahq/alpaca-trade-api` v4) because the agent needs a *single*
  long-lived WebSocket market-data connection — Alpaca allows one per account,
  and a subprocess MCP server plus our own dashboard would contend for it. The
  SDK is the only way to own that connection in-process.
- **The agent still drives everything over MCP.** We expose the same trading
  surface — including options-native tools (`place_option_strategy`,
  `get_option_chain`, `get_competition_status`) — as a Streamable-HTTP MCP
  server at `/api/mcp` (`src/server/mcp/register-tools.ts`). The LLM agent
  never calls the SDK directly; it calls MCP tools, exactly as it would with
  `alpaca-mcp-server`.

The result is the MCP workflow the rules ask for, on top of the official SDK,
with the hub's one-connection constraint respected. See
[docs/04-trading-and-mcp.md](docs/04-trading-and-mcp.md).

## Documentation

- [docs/00-project-overview.md](docs/00-project-overview.md)
- [docs/01-architecture.md](docs/01-architecture.md)
- [docs/02-alpaca-integration.md](docs/02-alpaca-integration.md)
- [docs/03-frontend-ui.md](docs/03-frontend-ui.md)
- [docs/04-trading-and-mcp.md](docs/04-trading-and-mcp.md)
- [docs/05-hackathon-rules.md](docs/05-hackathon-rules.md)
- [docs/06-options-parameters.md](docs/06-options-parameters.md)
- [AGENTS.md](AGENTS.md)
