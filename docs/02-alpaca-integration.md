# Alpaca Integration

## Authentication

- REST: API key + secret via SDK (`Alpaca` client with `keyId`, `secretKey`, `paper`)
- WebSocket: SDK authenticates automatically on connect

Secrets are loaded from `.env` and validated in `src/config/env.ts`.

## REST endpoints used

| Endpoint | Purpose |
|---|---|
| `trading.clock.clock()` | Market open/closed state |
| `marketData.getStockBars()` | Historical stock bars |
| `marketData.getCryptoBars()` | Historical crypto bars |
| `marketData.getOptionBars()` | Historical option bars |
| `trading.collectOptionsContracts()` | Option contract metadata: expirations, strikes, open interest, close price (paginated `/v2/options/contracts`) |
| `marketData.collectOptionSnapshotsBySymbol()` | Per-contract greeks, IV, latest quote/trade, daily volume (`feed: indicative`) |
| `marketData.getLatestPrice()` | Underlying spot, to bound the option chain strike window / ATM presets |
| `trading.account.getAccount()` | Account snapshot (cash, equity, buying power) |
| `trading.positions.*` | List / read / close open positions |
| `trading.orders.*` (`submit`, `getAllOrders`, `patchOrderByOrderId`, `deleteOrderByOrderID`, …) | Place / list / replace / cancel orders |

Trading integration lives in `src/server/alpaca/trading.ts`; see `docs/04-trading-and-mcp.md`.

## WebSocket

| Feed | URL / config |
|---|---|
| `test` | `stockStream({ url: "wss://stream.data.alpaca.markets/v2/test" })` |
| `iex` | `stockStream({ feed: "iex" })` |
| `sip` | `stockStream({ feed: "sip" })` |
| crypto | `cryptoStream()` — mutually exclusive with stock stream |
| options | `optionStream({ feed: "indicative" })` — `v1beta1/indicative`, **separate** WS connection |

Channels per symbol: **bars**, **quotes**, **trades** (equities/crypto).
Options carry **quotes** and **trades** only — there is no option `bars` channel, so the hub
synthesizes 1-minute candles from the option trade stream (`src/server/hub/bar-aggregator.ts`).

The **orderbook** channel (L2 depth) is **crypto-only**. `createAlpacaStreamAdapter`
(`src/server/alpaca/stream.ts`) adds it automatically when the stream is in crypto mode and
strips it in stock mode, so it never appears in `DEFAULT_STREAM_CHANNELS`. Frames are full
snapshots (`reset` flag), not deltas — the client just replaces the last known book. Raw
wire shape: `{ "T":"o", "S":"BTC/USD", "t":"…", "b":[{"p":…,"s":…}], "a":[{"p":…,"s":…}], "r":false }`;
the SDK re-models it to `{ symbol, bids:[{price,size}], asks:[{price,size}], timestamp, reset }`,
and `normalizeStreamOrderbook` produces the domain `OrderBook`.

### Second WebSocket for options

AGENTS.md rule 1 ("one Alpaca WebSocket per process") is scoped to the equity/crypto stream.
Options market data is a distinct Alpaca product with its own connection allowance, so the hub
owns a second adapter (`src/server/alpaca/option-stream.ts`). It is still server-only, still
created once via `getMarketHub()`, and only connects once at least one option symbol is
subscribed. Feed is `indicative` (free); switch `OPTIONS_FEED` to `opra` with a paid
subscription.

## Raw vs normalized payloads

Raw WebSocket bar (short keys):

```json
{"T":"b","S":"FAKEPACA","o":132.65,"h":136,"l":132.12,"c":134.65,"v":205,"t":"2024-07-24T07:56:00Z"}
```

Normalized domain bar:

```json
{
  "symbol": "FAKEPACA",
  "assetClass": "stock",
  "open": 132.65,
  "high": 136,
  "low": 132.12,
  "close": 134.65,
  "volume": 205,
  "timestamp": "2024-07-24T07:56:00Z"
}
```

Normalization happens in `src/server/alpaca/normalize.ts` only.

Option **snapshots** come back with short keys (`ap`/`bp` on `latestQuote`, `p` on
`latestTrade`, `v` on `dailyBar`) plus full-name `greeks` and `impliedVolatility`.
`normalizeOptionSnapshot` maps them to the domain `OptionQuoteRow`. Note that
`getOptionBars` **is** already re-modelled to `open/high/low/close` by the SDK
wrapper — option snapshots are not, so they must pass through `normalize.ts`.

## Limits

| Limit | Value |
|---|---|
| Concurrent WS connections | 1 per account (typical) |
| trades + quotes channels (free) | 30 total |
| Recommended max symbols (3 channels each) | 10 |
| REST rate | ~200 req/min (plan dependent) |

## Reconnection

SDK v4 handles WebSocket backoff and re-subscription. The hub listens for `onReconnecting` / `onReconnected` and emits SSE status events.

## Test stream

URL: `wss://stream.data.alpaca.markets/v2/test`

Symbol: `FAKEPACA` — works 24/7 for hackathon demos.
