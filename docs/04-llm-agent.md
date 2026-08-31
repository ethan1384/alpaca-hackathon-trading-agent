# LLM Agent (Phase 2)

> **Status (built).** The LLM decision layer now exists as a **SPY put
> credit-spread agent** — `src/server/agent/`, `src/server/llm/`,
> `/api/agent/{run,status,decisions}`, the dashboard **Agent** tab. See
> **`docs/08-agent.md`** for how it actually works and how to run it. Two things
> below are now stale and superseded by that doc:
> - the gating strategy is the **put-credit-spread entry veto + dead-zone early
>   exit**, not the ascending-triangle breakout sketched here;
> - there is **no Anthropic SDK** — the client is a provider-agnostic
>   `POST {base}/chat/completions` (`src/server/llm/client.ts`), env-switchable
>   between a local Ollama and Featherless.
>
> The rest of this file is kept as the original design rationale.

Design notes for adding an LLM decision layer. The strategy/execution contract it
targets (`src/domain/strategy.ts`, `src/server/strategies/`) is implemented.

## Options mandate

Hackathon rule: **all strategies must incorporate options trading.** The LLM
never decides "buy 100 shares". Its output is a `StrategySignal` — a directional
thesis on an underlying expressed as an option structure (`long_call`,
`long_put`, `bull_call_spread`, `bear_put_spread`, `long_straddle`) plus contract
selection criteria. `StrategySignalSchema` rejects equity/crypto legs, so a
non-options decision cannot reach execution.

## Competition guardrails

The LLM decides; it does not get to break the hackathon rules. `executeSignal()`
runs `assertSignalAllowed()` before and after contract resolution, so a model
that proposes an out-of-window entry or a leg expiring past the judged snapshot
is refused at the boundary rather than talked out of it. Give the model the
current state via the MCP tool `get_competition_status` so it plans around the
Thursday deadline instead of discovering it as a rejection. Rules and rationale:
`docs/05-hackathon-rules.md`.

## Principle

The LLM is a **decision layer**, not part of the hub. The hub stays dumb
(ingestion + fan-out). The LLM never touches the WebSocket or the browser.

```
MarketHub (bars/quotes/trades on the underlying)
  → trigger detection (pure TS on the ring buffer — free, runs every bar)
  → snapshot builder (recent bars + pattern metadata + option position + clock)
  → LlmStrategy.evaluate(context) → StrategySignal | null   ← Anthropic/LLM call here
  → resolveContracts()  → OptionOrderLeg[]   (select-contract.ts: DTE / delta / liquidity)
  → SSE /api/agent (UI: decision + chosen contracts + reason + confidence)
  → [Phase 3] executeSignal() → paper order (human gate)
```

## The LLM is gated by one strategy

> **As built:** the strategy is the **SPY put credit spread** (docs/08-agent.md).
> There is no pattern trigger — the mechanical strategy proposes a candidate once
> per ET session inside the entry window, and the LLM approves or vetoes it, then
> manages the dead zone. The breakout sketch below was the original plan.

First strategy: **ascending-triangle / triple-resistance breakout** on a liquid
optionable underlying (SPY, QQQ, AAPL, …). The agent acts on this strategy only.

Trigger (pure code, no LLM), computed on the **underlying's** bars:

```
resistance R = max(high) over lookback, touched ≥3× within ±ε
ascending lows: regression slope over pivot lows > 0
trigger = close > R·(1 + buffer)  AND  volume > k·avg_volume
+ per-symbol cooldown (don't re-fire the same breakout repeatedly)
```

The LLM is invoked **only when the trigger fires**. It validates (real breakout
vs fakeout) and, if it acts, emits a `StrategySignal`:

- `bias: "bullish"`, `kind`: `long_call` for pure directional exposure, or
  `bull_call_spread` when it wants defined risk / lower theta.
- `selection`: `targetDelta` ≈ 0.35–0.45 (slightly OTM to ATM), `minDte`/`maxDte`
  ≈ 7–45 (enough time for the move, not so much that theta dominates),
  `minOpenInterest` / `maxSpreadPct` to keep fills realistic, `spreadWidth` for
  verticals.
- `entryLimit` (net debit cap), `underlyingStop` / `underlyingTarget` at the
  invalidation and objective **levels of the underlying** — the exit logic keys
  off the underlying, not the option premium.

`resolveContracts()` turns `selection` into concrete OCC legs against the live
chain; `executeSignal()` submits a single-leg option order or an `mleg` spread.

## File layout (as built)

```
src/domain/strategy.ts        StrategySignal + Zod schema, incl. bull_put_spread  ← DONE
src/domain/agent.ts           AgentState / AgentCycleReport / AgentStatus types   ← DONE
src/config/agent.ts           AGENT — all agent calibration (pure constants)      ← DONE
src/server/strategies/select-contract.ts  selection → OCC legs (+ credit branch)  ← DONE
src/server/strategies/credit-spread-strategy.ts  mechanical candidate builder     ← DONE
src/server/strategies/execute.ts          signal → placeOrder (+ credit sign)     ← DONE
src/server/llm/client.ts      OpenAI-compatible fetch client, injectable          ← DONE
src/server/llm/{decide,schema,prompt}.ts  JSON decision helper + prompts          ← DONE
src/server/agent/positions-store.ts       working-memory file                     ← DONE
src/server/agent/monitor.ts               mark a spread + classify its exit zone  ← DONE
src/server/agent/run-cycle.ts             one cycle: manage, then maybe enter     ← DONE
src/app/api/agent/{run,status,decisions}/route.ts                                 ← DONE
src/lib/hooks/use-agent.ts + src/components/agent/*   Agent tab                    ← DONE
```

The `Strategy` / `StrategyContext` interface (`src/server/strategies/index.ts`)
is unused by this agent — `run-cycle.ts` calls `buildCreditSpreadCandidate`
directly so it can surface the rejected-alternative detail the decision log
wants. A future pattern-triggered strategy can still use that interface.

The interface (`src/server/strategies/index.ts`, already implemented):

```typescript
export interface StrategyContext {
  underlying: string;          // never an option symbol
  bars: Bar[];
  quote?: Quote;
  position?: TradingPosition;  // current option position for this thesis
  clock: MarketClock;
}
export interface Strategy {
  readonly name: string;
  evaluate(ctx: StrategyContext): Promise<StrategySignal | null>;
}
```

`LlmStrategy` implements `Strategy`; the LLM call happens inside `evaluate`, and
its structured output is validated against `StrategySignalSchema`.

## SDK notes (as built)

- **No SDK.** `src/server/llm/client.ts` is a hand-rolled
  `POST {AGENT_LLM_BASE_URL}/chat/completions` in the OpenAI shape — identical
  for Ollama (`/v1`), Featherless, OpenAI, Together, vLLM. Bearer header only
  when `AGENT_LLM_API_KEY` is set. `AbortController` timeout. Any transport
  failure → `LlmUnavailableError`, which the agent treats as "no entry / hold".
- Structured output: `src/server/llm/decide.ts` sends `response_format:
  {type:"json_object"}`, strips fences, `JSON.parse`, validates with Zod
  (`EntryDecisionSchema` / `ManageDecisionSchema`), retries once, then
  `LlmParseError`. Never string-matches.
- Prompt caching: the static system prompt is message 0, the volatile context is
  message 1.
- The client is injected into `runAgentCycle({ llm })`; tests pass a fake.

## Cost (rough, 7-day continuous run)

Because the LLM is gated behind the trigger, cost is dominated by trigger
frequency, not model choice.

| Regime | Calls/day | Total 7 days |
|---|---|---|
| Strict (clean triangles, no reasoning) | 5–10 | ~$0.15 |
| Moderate (reasoning + exit management) | 20–50 | ~$1.80 |
| Loose (lax params + tool use + multi-timeframe) | 100–200 | ~$18 |

Realistic: **$1–5 for the whole week**. Kimi/GLM (~$1.80) vs Claude Haiku
(~$3.70) / Sonnet 5 (~$7.40) / Opus 5 (~$18) at the moderate regime — price is
not the deciding factor at this volume.

**Guardrail:** a mis-calibrated trigger that calls the LLM on every bar (10
symbols) ≈ 3,900 calls/day ≈ ~$205/week. Add a hard daily call cap + per-symbol
cooldown.

Latency matters more than cost: a reasoning model taking 15–30s can miss the
breakout entry. Option: code takes the mechanical entry immediately, the LLM
validates / vetoes / resizes on the next bar.

## Built alongside the LLM integration

1. **Decision logging** — `src/server/risk/decision-log.ts` ([O5]). `recordDecision`
   is called from `run-cycle.ts` on every branch that matters (entry acted /
   vetoed / skipped / blocked / errored, every mechanical close, every dead-zone
   hold/close), with the `llm` field populated: model + tokens + latency **and
   the verbatim user prompt + raw model reply** (`llm.prompt` / `llm.response`).
   Outside the agent, `executeSignal` logs every non-agent execution and
   `recordManualAction` logs every raw order/close/cancel via MCP or REST — so
   the JSONL is a complete record of every order the system placed and why.

2. **Memory / persistence** — `src/server/agent/positions-store.ts`:
   `${AGENT_LOG_DIR}/agent-state.json` holds the open spreads, `enteredEtDates`,
   and free-text `notes` the agent carries into later cycles (fed into the entry
   prompt via `notesForToday`).

3. **UI surface** — the Agent tab: `DecisionTimeline` (table + an "AI-readable
   export" toggle backed by `serializeForReview`), `ManagedSpreadsTable` (live
   marks), `AgentConfigCard` (phase / config / account).
