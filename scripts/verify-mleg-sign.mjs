#!/usr/bin/env node
// One real order-preview check for the open risk in docs/08-agent.md §"Known
// divergences" / the plan: does Alpaca accept a NEGATIVE mleg limit_price as a
// net credit? Alpaca's docs say yes (positive = debit, negative = credit); this
// confirms it against the live paper account before the official run.
//
// It places ONE tiny, far-OTM, 1-contract SPY bull_put_spread as a limit order
// at a -0.05 credit target (deep OTM + an aggressive credit -> will not fill),
// prints what came back, then cancels it.
//
//   pnpm dev                       # in another terminal — the server holds the creds
//   node scripts/verify-mleg-sign.mjs
//   API=https://my-host node scripts/verify-mleg-sign.mjs
//
// PASS  -> the order was accepted and limit_price came back negative. The agent's
//          negative-for-credit logic in signalToOrder is correct; keep
//          AGENT.creditEntryOrderType = "limit".
// FAIL  -> flip AGENT.creditEntryOrderType to "market" (src/config/agent.ts) and
//          re-run the agent; entries then go out as market in the 10:00-11:00 ET
//          window and the sign question no longer matters.

const API = (process.env.API ?? "http://localhost:3000").replace(/\/+$/, "");
const TOKEN = process.env.MCP_AUTH_TOKEN;
const H = {
  "Content-Type": "application/json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function j(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...H, ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `${init?.method ?? "GET"} ${path} -> ${res.status}: ${body.error ?? JSON.stringify(body)}`,
    );
  return body;
}

function pickExpiration(expirations) {
  const today = new Date().toISOString().slice(0, 10);
  // 15-45 calendar days out, so it is nowhere near the money and safe to leave briefly.
  const candidates = expirations.filter((e) => {
    const days = (Date.parse(`${e}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
    return days >= 15 && days <= 45;
  });
  return candidates[0] ?? expirations.at(-1);
}

async function main() {
  console.log(`verify-mleg-sign: ${API}`);
  const clock = await j("/api/clock");
  if (clock.feed === "test") {
    console.error("FAIL: ALPACA_DATA_FEED=test has no options data. Set iex or sip and retry.");
    process.exit(2);
  }

  const { expirations } = await j("/api/options/contracts?underlying=SPY");
  const expiration = pickExpiration(expirations);
  if (!expiration) throw new Error("no SPY expirations returned");
  console.log(`expiration: ${expiration}`);

  const { spot, rows } = await j(
    `/api/options/contracts?underlying=SPY&expiration=${expiration}&type=put&moneyness=0.2`,
  );
  console.log(`SPY spot: ${spot}`);

  // Far-OTM: short leg ~10-delta, long leg one $5 step lower.
  const puts = rows
    .filter((r) => r.strike < spot && r.bid != null && r.ask != null)
    .sort((a, b) => b.strike - a.strike);
  const short =
    puts.find((r) => Math.abs(r.greeks?.delta ?? 1) <= 0.12) ?? puts[Math.floor(puts.length / 2)];
  const long =
    puts.find((r) => r.strike <= short.strike - 5) ?? puts.find((r) => r.strike < short.strike);
  if (!short || !long) throw new Error("could not pick two far-OTM put strikes");
  console.log(`short: ${short.symbol} (${short.strike}, delta ${short.greeks?.delta})`);
  console.log(`long : ${long.symbol} (${long.strike})`);

  const orderReq = {
    type: "limit",
    timeInForce: "day",
    qty: 1,
    limitPrice: -0.05, // negative = net credit target
    legs: [
      { symbol: short.symbol, side: "sell", ratioQty: 1, positionIntent: "sell_to_open" },
      { symbol: long.symbol, side: "buy", ratioQty: 1, positionIntent: "buy_to_open" },
    ],
  };
  console.log("\nsubmitting:", JSON.stringify(orderReq));

  let order;
  try {
    order = await j("/api/orders", { method: "POST", body: JSON.stringify(orderReq) });
  } catch (err) {
    console.error(`\nFAIL: order rejected — ${err.message}`);
    console.error('  -> set AGENT.creditEntryOrderType = "market" in src/config/agent.ts');
    process.exit(1);
  }

  const id = order.id;
  console.log(`\naccepted: id=${id} status=${order.status} limitPrice=${order.limitPrice}`);

  await new Promise((r) => setTimeout(r, 2500));
  const fetched = await j(`/api/orders/${id}`).catch(() => order);
  console.log(
    `re-fetched: status=${fetched.status} limitPrice=${fetched.limitPrice} class=${fetched.orderClass ?? fetched.order_class}`,
  );

  await j(`/api/orders/${id}`, { method: "DELETE" }).catch((e) =>
    console.warn(`cancel warn: ${e.message}`),
  );
  console.log(`cancelled ${id}`);

  const finalLimit = fetched.limitPrice ?? order.limitPrice;
  if (typeof finalLimit === "number" && finalLimit < 0) {
    console.log(
      '\nPASS: Alpaca accepted the negative mleg limit as a net credit. Keep creditEntryOrderType = "limit".',
    );
    process.exit(0);
  }
  console.log(
    `\nINCONCLUSIVE: order accepted but limit_price came back as ${finalLimit}. Inspect on the Alpaca dashboard; if it shows the wrong sign, use "market".`,
  );
  process.exit(3);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(2);
});
