# Trading & MCP

Manual order execution (place / modify / cancel, positions, account) plus an MCP
server that exposes the same surface to AI agents.

## Layers

```
src/domain/trading.ts            types + Zod schemas (PlaceOrderSchema, ...)
src/server/alpaca/trading.ts     client.trading.* wrapper (server-only)
src/server/alpaca/normalize-trading.ts   SDK string money -> numeric domain models
src/app/api/{account,positions,orders}/  REST route handlers
src/server/mcp/register-tools.ts tool definitions (transport-agnostic)
src/app/api/mcp/route.ts         Streamable HTTP endpoint (mcp-handler)
src/lib/api/trading.ts + hooks/use-trading.ts   client fetchers + TanStack Query
src/components/trading/          OrderTicket, PositionsTable, OrdersTable, AccountSummary
```

## REST API

| Method + path | Purpose |
|---|---|
| `GET /api/account` | Cash, equity, buying power, margin, status |
| `GET /api/positions` | All open positions (normalized, numeric) |
| `DELETE /api/positions?cancelOrders=true` | Liquidate every position |
| `GET /api/positions/:symbol` | One position |
| `DELETE /api/positions/:symbol` | Close one position — body `{ qty? }` or `{ percentage? }` |
| `GET /api/orders?status=open&nested=true` | List orders (status: open/closed/all) |
| `POST /api/orders` | Place an order (see below) |
| `DELETE /api/orders` | Cancel all open orders |
| `GET /api/orders/:id` | One order (with bracket/OCO legs) |
| `PATCH /api/orders/:id` | Replace — `{ qty?, limitPrice?, stopPrice?, trail?, timeInForce? }` |
| `DELETE /api/orders/:id` | Cancel one order |

All handlers run `runtime = "nodejs"`, `dynamic = "force-dynamic"` and map Alpaca
`ApiError` status codes through `src/server/alpaca/errors.ts`.

### Placing an order (`PlaceOrderSchema`)

```jsonc
{
  "symbol": "AAPL",          // stock, crypto ("BTC/USD"), or OCC option symbol
  "side": "buy",             // buy | sell
  "type": "limit",           // market | limit | stop | stop_limit | trailing_stop
  "timeInForce": "day",      // day | gtc | opg | cls | ioc | fok
  "qty": 10,                 // exactly one of qty / notional
  "limitPrice": 190,         // required for limit / stop_limit
  "stopPrice": 185,          // required for stop / stop_limit
  "trailPercent": 2,         // or trailPrice — for trailing_stop
  "extendedHours": false,
  "clientOrderId": "my-id",
  "positionIntent": "buy_to_open",             // options: buy_to_open | sell_to_close | …
  "takeProfit": { "limitPrice": 210 },        // adds a bracket/OTO leg
  "stopLoss":   { "stopPrice": 180, "limitPrice": 179 }
}
```

`orderClass` is derived: both legs → `bracket`, one leg → `oto`, none → `simple`.
Set `orderClass: "oco"` explicitly to attach TP+SL to an existing position.
Bracket/OCO/OTO orders must be sized by `qty` (not `notional`).

### Multi-leg option orders (`mleg`)

Pass `legs` (2–4 entries) instead of `symbol`/`side` for a spread. Every leg
`symbol` must be an OCC option contract, all on one underlying. `orderClass`
derives to `mleg`; size the whole structure with the top-level `qty`; `type` is
`market` or `limit` (`limitPrice` = net debit/credit).

```jsonc
{
  "type": "limit", "qty": 2, "limitPrice": 2.40, "timeInForce": "day",
  "legs": [
    { "symbol": "SPY260116C00500000", "side": "buy",  "ratioQty": 1, "positionIntent": "buy_to_open" },
    { "symbol": "SPY260116C00510000", "side": "sell", "ratioQty": 1, "positionIntent": "sell_to_open" }
  ]
}
```

The strategy layer builds these automatically — see
`src/server/strategies/` and `docs/04-llm-agent.md`.

## MCP server

Endpoint: `POST /api/mcp` — stateless Streamable HTTP (`mcp-handler` v2, MCP SDK v2).
Set `MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>`.

### Client config

```json
{ "mcpServers": { "alpaca": { "url": "http://localhost:3000/api/mcp" } } }
```

For stdio-only clients: `npx -y mcp-remote http://localhost:3000/api/mcp`.

### Tools

| Tool | Notes |
|---|---|
| `get_clock` | Market open/closed |
| `get_bars` | OHLCV history (stock / crypto / option) |
| `get_account` | Account snapshot |
| `list_option_expirations`, `get_option_chain` | Options metadata + greeks/IV |
| `place_option_strategy` | Resolve a `kind` + `selection` thesis into OCC contracts and submit (destructive) |
| `list_positions`, `get_position` | Read positions |
| `close_position`, `close_all_positions` | Liquidate (destructive) |
| `list_orders`, `get_order` | Read orders |
| `place_order` | Same schema as `POST /api/orders`, incl. `legs` for `mleg` spreads (destructive) |
| `replace_order`, `cancel_order`, `cancel_all_orders` | Modify / cancel |

Write tools carry `annotations.destructiveHint`. They act on **real** Alpaca
orders for the configured environment (paper by default, `ALPACA_PAPER=false` for
live). Adding a tool: register it in `src/server/mcp/register-tools.ts` so every
transport gets it.
