# Architecture

## Directory responsibilities

| Path | Role |
|---|---|
| `src/domain/` | Pure types and Zod schemas — no external imports |
| `src/server/alpaca/` | Alpaca REST + WebSocket adapters, normalization |
| `src/server/hub/` | Singleton hub: subscriptions, ring buffers, SSE fan-out |
| `src/app/api/` | Route handlers (SSE, subscriptions, bars, clock) |
| `src/lib/stores/` | Zustand client state |
| `src/lib/hooks/` | EventSource + TanStack Query hooks |
| `src/components/` | Dashboard UI |

## Data flow

```
Alpaca WS (1 conn)
  → stream.ts (SDK adapter)
  → market-hub.ts (coalesce 200ms, ring buffers)
  → GET /api/stream (SSE + heartbeat 15s)
  → useMarketStream (rAF batch)
  → market-store (zustand)
  → Dashboard / PriceChart (lightweight-charts series.update)
```

Subscriptions are **not** sent over SSE. The browser calls `POST /api/subscriptions`.

Historical backfill uses `GET /api/bars` via TanStack Query when a symbol card has no live bars yet.

## Singleton hub

```typescript
globalThis.__marketHub ??= createMarketHub();
```

All API routes call `getMarketHub()`. Multiple browser tabs create multiple SSE clients but share one Alpaca WebSocket.

## Server runtime

Hub routes declare:

```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

Streaming requires Node.js — not Edge.
