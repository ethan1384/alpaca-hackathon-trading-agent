# Options Parameters, Risk & Operations (calibrated)

This is the parameter, risk and operational design register for the personal
trading project. It originated in the former Alpaca event, so some calibrations
still describe its four-session window. Those historical constraints are
summarised in `docs/05-legacy-competition.md`; the reusable risk controls in
this document remain the target for ongoing development.

Ids: **[P#]** parameters, **[K#]** portfolio risk, **[O#]** operational.
Each carries a status:

- **enforced** — a code path refuses the violation.
- **default** — the value exists in code but nothing stops a caller overriding it.
- **gap** — named here, not implemented yet.

---

## 1. Why short DTE, and why that is the dangerous choice

Four sessions (Mon 2026-08-31 → Thu 2026-09-03 EOD). Two consequences drive
every number below:

1. **Theta and vega cannot pay out on long expirations in four sessions.** The
   scoring window mechanically pushes the agent to short DTE — which is the
   **gamma regime**, where a short leg's delta can travel 0.30 → 0.90 in one
   session. Short DTE is not a preference here; it is forced by [D4]
   (`optionExpirationDeadline = 2026-09-03`). The risk that comes with it must
   therefore be handled explicitly, not assumed away.
2. **Scoring has no drawdown penalty ([R14])**, which is an incentive to size
   aggressively. But robustness is scored separately ([R13]): a demonstrable,
   logged guardrail is worth more than the marginal P&L of an unbounded bet.
   See [D11].

---

## 2. Universe

The fundamental layer **builds the whitelist and then leaves**. It is computed
once, before the run; it never enters the decision loop. A balance sheet does
not move in four days — using valuation to pick a 3-DTE strike confuses two time
horizons.

What fundamentals *do* buy us, and why each matters:

- **Tail-risk exclusion.** Selling puts on a company burning cash collects $40
  of premium against a -30% gap. Market cap > $5B, adequate cash, no going-concern
  flag removes that whole category.
- **Explaining an abnormal IV.** IV rank 95 means one of two opposite things:
  premium inflated by fear (an opportunity), or real risk correctly priced
  (litigation, debt maturity, regulatory decision). Without that reading, a
  system systematically sells the most dangerous situations — precisely because
  they pay best.
- **The dated catalyst.** Earnings, PDUFA, central-bank decision, macro print.
  The only fundamental dimension whose horizon matches four sessions. Closer to
  a calendar than to analysis, and a mandatory system input.

| Id | Parameter | Target | Role | Status |
|---|---|---|---|---|
| **[P1]** | Whitelist | SPY, QQQ, IWM + 15–20 US large caps | liquidity | gap |
| **[P2]** | Min open interest (per strike) | 500 | avoid ghost strikes | default (`minOpenInterest` defaults to **0**) |
| **[P3]** | Max bid/ask spread | 5% of mid, or $0.10 absolute on index names | the spread is the first cost, paid twice on a round trip | default (`maxSpreadPct` defaults to **0.25**) |
| **[P4]** | Min daily option volume | 1 000 | confirm live activity | gap |
| **[P5]** | Hard exclusions | small caps, biotech without catalyst, market cap < $5B | tail risk | gap |

> **Drift to fix.** `ContractSelectionSchema` (`src/domain/strategy.ts`) ships
> `minOpenInterest: 0` and `maxSpreadPct: 0.25` — far looser than [P2]/[P3].
> `isLiquid()` in `select-contract.ts` applies whatever it is given, so today the
> liquidity floor is only as strong as the caller. An LLM-authored signal can
> pass 0/0.25 and get filled on a ghost strike.

---

## 3. Inputs to fetch each cycle

- Full chain per expiration: bid, ask, mid, IV, greeks, OI, volume per strike.
- Underlying spot.
- IV rank and IV percentile over 252 days.
- 20-day historical volatility (HV20).
- Calendar: earnings, ex-dividends, macro prints.
- Account state: equity, buying power, open positions **with their greeks**.

> **[R9]/[D7] restated:** trust API data exclusively. The Alpaca dashboard can
> lag. Price off the latest quote/snapshot, never off historical option bars —
> those are 15-minute delayed on the free tier.

> **Feasibility note on IV rank.** [P6]/[P7] below assume 252 days of IV history
> per underlying. Alpaca's free tier does not serve that series directly. Either
> approximate (HV20 on underlying daily bars is available; VIX-relative levels
> for index names), or snapshot the chain daily from now to build the series
> forward — with 2 sessions before kickoff, a 252-day series cannot be
> backfilled. **Do not let a strategy branch on an IV rank the system cannot
> actually compute.** An unavailable signal must be `null`, never a default.

---

## 4. Derived signals

| Id | Signal | Formula | Use | Status |
|---|---|---|---|---|
| **[P6]** | IV rank | (IV − IV_min) / (IV_max − IV_min) over 252d | buyer/seller switch | gap |
| **[P7]** | IV percentile | % of days where IV < current IV | cross-check on [P6]; robust to isolated spikes | gap |
| **[P8]** | IV/HV ratio | IV30 / HV20 | > 1.2 → premium overpriced | gap |
| **[P9]** | Expected move | ATM straddle × 0.85 | bounds of the priced-in move; place strikes relative to it | gap |
| **[P10]** | 25-delta skew | IV(put 25Δ) − IV(call 25Δ) | measure of directional fear | gap |
| **[P11]** | Term structure | short-dated IV vs long-dated | backwardation = stress = seller-favourable | gap |

All of these are **deterministic code**, never LLM output — see §8.

---

## 5. Entry rules

| Id | Parameter | Standard | **Calibrated for this run** | Status |
|---|---|---|---|---|
| **[P12]** | DTE window | 30–45 | **2–9** | default is 7–45; ceiling enforced by `clampDteWindow` [D4] |
| **[P13]** | Target delta — directional buy | 0.40 | 0.40–0.50 | default (`targetDelta`, honoured by `select-contract`) |
| **[P14]** | Target delta — premium sale | 0.20–0.30 | 0.15–0.25 | gap (no short structures — see §9) |
| **[P15]** | IV rank — buyer mode | < 30 | < 30 | gap (depends on [P6]) |
| **[P16]** | IV rank — seller mode | > 50 | > 50 | gap |
| **[P17]** | Event filter | exclude if earnings inside the window | same, unless a dedicated strategy | gap |
| **[P18]** | Order type | **limit at mid, never market** | same | gap (`entryLimit` is optional; omitting it sends a market order) |
| **[P19]** | Repricing | unfilled after 60s → reprice toward the touched side in $0.01 steps | same | partial — **exits only**: a close order unfilled after 90s is cancelled and re-sent at market (`CLOSE_ORDER_TIMEOUT_MS`, `src/server/agent/run-cycle.ts`). Entries are still one-shot |

> [P12] and [D4] interact: the deadline clamp already caps `maxDte` at the
> 2026-09-03 expiration. Setting the strategy window to 2–9 makes the intent
> explicit rather than relying on the clamp as the calibration.

---

## 6. Position management

| Id | Parameter | Standard | **Calibrated** | Status |
|---|---|---|---|---|
| **[P20]** | Profit target — premium sale | 50% of max credit | **25–35%** | gap |
| **[P21]** | Profit target — long premium | 100% of premium | **50–70%** | gap |
| **[P22]** | Stop loss | 2× the credit collected | **3× the credit collected** | gap |
| **[P23]** | Forced time exit | 21 DTE | **mandatory close before the 2026-09-03 expiration** | partially — [D4] blocks *opening* past the deadline; nothing forces a *close* |
| **[P24]** | Delta breach | short leg reaches 0.45 → act | same | gap |
| **[P25]** | Roll policy | define explicitly | **do not roll** — horizon too short | gap |

> **[P22] departs from the standard on purpose.** A stop is a level on the
> *credit*, but the risk it protects is the *width*. At the calibrated 0.57
> credit on a 5-wide spread, 2× cuts at 16% of defined risk — inside ordinary
> intraday gamma noise on a 1-2 DTE short vertical. It fires on a quarter of all
> trades, and most of those revert. 3× cuts at ~29% of defined risk and fires on
> ~12%. The sweep is `docs/07-strategie-credit-spreads.md` §7.7; the ordering
> holds under every friction and volatility assumption tested. Wider still (4×,
> 5×) tested better again, and was rejected: the marginal gain past 3× is bought
> with rarer, larger losses, and that tail is what the sample never saw.

> **[R10]/[R12] restated, because it is the load-bearing constraint here:**
> Alpaca has **no trailing stop on options**. Every exit must be an *active*
> closing order sent by a monitoring agent. There is no passive order resting at
> the broker that will save the position. This is what makes [P20]–[P24] the
> agent's own job, and why [D9] puts `underlyingStop` / `underlyingTarget` on
> the signal.

---

## 7. Portfolio risk

The layer most systems omit, and the one that explains most of the losses.

| Id | Guardrail | Value | Status |
|---|---|---|---|
| **[K1]** | Max net portfolio delta | ±60% of equity in dollar-delta | **enforced** |
| **[K2]** | Max net vega | ±0.4% of equity per IV point | **enforced** |
| **[K3]** | Max buying power used | 35% | **enforced** |
| **[K4]** | Max loss per position | 2% of equity | **enforced** |
| **[K5]** | Correlation cap | 2 positions per sector | **enforced** |
| **[K6]** | Max concurrent positions | 6 | **enforced** |

Values live in `RISK` (`src/config/risk.ts`); `checkPortfolioRisk()` evaluates
them against the book *as it would stand after* the candidate trade, and
`assertTradeAllowed()` (`src/server/risk/gate.ts`) runs from `executeSignal()`
before every opening order.

> **On [K1].** The source document expresses the delta cap in "SPY-share
> equivalents", which needs beta-weighting we cannot compute reliably. The cap is
> enforced on **signed dollar-delta** — `Σ delta × 100 × contracts × spot` — as a
> fraction of equity, which is the computable equivalent. The SPY-share number is
> reported alongside (`netDeltaSpyShares`) for legibility only.

> **On correlation.** Twenty credit spreads on US tech names are not twenty
> trades. They are one macro position split into twenty lines, carrying roughly
> twenty times the risk the system believes it holds. [K5] exists to stop the
> position count from lying to the sizing logic. The sector map is `SECTORS` in
> `src/config/risk.ts` — coarse on purpose. An underlying absent from it gets its
> own bucket, which is the permissive reading; extend the map rather than relying
> on that.

> **Missing greeks do not pass.** If any open position comes back without a delta
> or vega, the aggregate degrades to `null` and [K1]/[K2] report "cap not
> checked" as a warning rather than passing silently. A cap that clears because
> the input was missing reports a safety it never verified.

> `COMPETITION.maxPortfolioRiskPct = 0.25` ([D11]) remains declared and unread;
> [K3]/[K4] in `RISK` superseded it with tighter, enforced values.

---

## 8. Operational layer

This is the layer judged directly on the "robustness" axis ([R13]/[D10]).

| Id | Control | Behaviour | Status | Code |
|---|---|---|---|---|
| **[O1]** | Kill switch | intraday drawdown > 8% → cancel all, close all, halt until manually re-armed | **enforced** — `isHalted()` gates every opening trade, and `runAgentCycle` takes the drawdown reading once per cycle so the switch can trip on its own (before, only the manual MCP tool ever evaluated it) | `src/server/risk/kill-switch.ts` |
| **[O2]** | Data circuit breaker | bid ≤ 0, crossed book, spread > 50% of mid, IV > 500%, quote > 5min stale, or no snapshot → freeze entries | **enforced** | `quoteAnomalies()`, `src/config/risk.ts` |
| **[O3]** | Execution time window | no order in the first or last 10 minutes of the session | **enforced** | `checkExecutionWindow()` |
| **[O4]** | Reject handling | exponential backoff on retryable failures, alert past 3 consecutive | **enforced** | `src/server/alpaca/retry.ts` |
| **[O5]** | Structured decision log | trigger → structure chosen → **alternatives rejected and why** → guardrail verdicts → sizing → outcome (+ the LLM prompt/response verbatim when a model decided) | **enforced** — the LLM agent emits on every branch; `executeSignal` emits for every non-agent execution; every manual order/close/cancel path (MCP + REST) emits via `recordManualAction` | `src/server/risk/decision-log.ts` |
| **[O6]** | State reconciliation | compare the agent's expected book against the account's real one | **built**; called by the agent loop (`run-cycle.ts` reconciles vanished spreads) and the `reconcile_positions` MCP tool | `src/server/risk/reconcile.ts` |

Notes on the two that carry the most weight:

- **[O5]** logging the **rejected** alternatives is what distinguishes a decision
  log from a trade blotter. `serializeForReview()` emits the same history in the
  compact form a reviewing model reads well. The MCP tool `get_decision_log`
  exposes both.
- **[O4]** the load-bearing detail is *which* failures deserve a retry. A 429 or
  5xx is the venue being busy. A 4xx is Alpaca saying the order is wrong —
  retrying sends the same wrong order again and buries the real message. Only
  transport and rate-limit failures retry. Order submissions carry a generated
  `clientOrderId`, so a retry after a lost response produces a duplicate
  rejection, never a second fill.
- **[O1]** re-arming is manual, deliberately. An automatic reset makes it a speed
  bump, not a switch.

### Wiring

```
executeSignal()                         ← the single execution entry point
  ├─ assertSignalAllowed()              legacy event compatibility (docs/05)
  └─ assertTradeAllowed()               risk layer       (this file)
       ├─ isHalted()                    [O1] — checked first, before any I/O
       ├─ checkExecutionWindow()        [O3]
       ├─ checkChainSanity()            [O2]
       └─ checkPortfolioRisk()          [K1]-[K6], against the post-trade book
```

Closing trades are never gated — risk must always be reducible, whatever the
phase or the drawdown.

`RISK_ENFORCE=true` makes a breach throw; off (the dev default) skips the gate
entirely, doing no account or chain lookups, so tests and backtests run without
credentials. **The official run sets it to `true`.**

Visibility for the agent and the judge, over MCP: `get_risk_status`,
`reconcile_positions`, `get_decision_log`, `trip_kill_switch`.

---

## 9. LLM / code split

| Layer | Implementation | Reason |
|---|---|---|
| Pricing & greeks | Alpaca API | deterministic, reliable |
| Derived signals (§4) | **deterministic code** | an LLM computing a vega hallucinates |
| Sizing & risk controls (§7) | **deterministic code** | must be non-negotiable |
| Structure selection | LLM, under constraints | contextual judgement |
| Qualitative context reading | LLM | explain *why* an IV is high |
| Order execution | code | reproducibility |

This matches the architecture already in the repo: the LLM emits a
`StrategySignal`; `select-contract.ts` and `execute.ts` resolve and submit it;
`guardrails.ts` refuses what the rules forbid. §4 and §7 are the parts of that
split that do not exist yet.

> **Credit spreads now exist.** `OPTION_STRATEGY_KINDS` gained `bull_put_spread`
> and `bear_call_spread` — new leg-shape validation, a `select-contract` branch
> that picks the short leg by delta and the long wing by width, net-credit sign
> handling in `signalToOrder`, and a defined-risk `(width − credit)` max-loss in
> `priceCandidate` so [K4] is correct. Iron condors and [P14]/[P16] are still not
> expressible (4-leg structures; `resolvedLegs` caps at 4 but `validateLegShape`
> has no condor case).

### 9.1 The LLM decision agent (built — docs/08-agent.md)

A mechanical **SPY put credit spread** (`src/config/agent.ts`, `bull_put_spread`,
~0.175-delta short, $5 wide, 1–2 DTE) with an LLM layer that does **only** two
things:

| lever | status | note |
|---|---|---|
| entry veto | `default` | LLM approves/skips the mechanical candidate — event risk, trend, IV vs the tail |
| dead-zone early close | `default` | LLM closes a losing spread that is near the short strike or low on time, before the 3× stop |

Everything else stays the enforced exit layer the LLM cannot touch: profit
target (50% of credit), stop (3× credit), 15:30 ET time-close, and the forced
close 45 min before the 20:00Z snapshot — all mechanical checks in
`src/server/agent/monitor.ts`. Sizing is 1% of equity max-loss per spread
(`AGENT.riskPerSidePct`), capped at 2 concurrent, and re-checked by [K1]–[K6] at
`executeSignal()`. Nothing in `docs/05` needed correcting.

---

## 10. Glossary

### 10.1 Greeks

**Delta (Δ)** — change in option price per $1 rise in the underlying. 0 to 1 for
a call, 0 to −1 for a put; ≈ 0.50 at the money. *Practical reading:* approximates
the probability of expiring ITM — a 0.20-delta put has roughly a 20% chance of
finishing ITM. The single most useful strike-selection parameter. *Agent use:*
strike selection [P13]/[P14], net directional exposure [K1].

**Gamma (Γ)** — rate of change of delta. Maximal at the money, grows explosively
into expiration. *Practical reading:* this is the seller's risk. At 5 DTE on an
ATM strike, a delta can go 0.30 → 0.90 in one session. *Agent use:* justifies the
time-exit rule [P23] and the ban on leaving short near-dated legs unmonitored.

**Theta (Θ)** — value lost per day elapsed. Negative for the buyer, positive for
the seller; accelerates sharply under 30 DTE. *Practical reading:* the rent the
buyer of optionality pays. *Agent use:* sizes the profit target [P20]/[P21] and
the expected holding period.

**Vega (ν)** — change in option price per 1-point rise in implied volatility.
Maximal ATM, grows with maturity. *Practical reading:* the most underestimated
greek. On an earnings straddle you can be right on the move and still lose: a
30-point IV collapse outweighs the delta gain. *Agent use:* net vega cap [K2],
event filter [P17].

**Rho (ρ)** — interest-rate sensitivity. Negligible except on LEAPS.

> **The fundamental relation.** Gamma and theta are inverse. You cannot be long
> gamma (convexity) and long theta (time) at once. The buyer pays time for
> convexity; the seller collects time by selling convexity. **Every structure
> choice reduces to that trade-off.**

### 10.2 Volatility

**IV — implied volatility** — annualised volatility implied by the option's market
price. The market's expectation, not a measure of the past.

**HV — historical/realised volatility** — volatility actually observed over the
last N days (typically 20 or 30). A measure of the past.

**IV rank** — where current IV sits in its 252-day range:
`(IV − IV_min) / (IV_max − IV_min) × 100`. Thresholds: **< 30** → options cheap,
favour buying; **> 50** → premium expensive, favour selling. *Limit:* sensitive to
extremes — a single IV spike eight months ago flattens the scale. Always
cross-check against IV percentile.

**IV percentile** — % of the last 252 days on which IV was below the current
level. More robust than IV rank because isolated extremes do not distort it.

**IV/HV ratio** — expectation versus reality. Above 1.2 the market is pricing
more movement than it has recently delivered — favourable to the premium seller.

**IV crush** — abrupt IV collapse right after an uncertainty resolves (earnings,
regulatory decision). The main cause of losses on options bought ahead of a
catalyst.

**Skew** — IV difference between strikes of the same expiration, typically
measured between the 25-delta put and the 25-delta call. High put skew signals
demand for downside protection.

**Term structure** — the IV curve across maturities. Normally IV rises with term
(contango). An inversion (backwardation) signals short-term stress —
historically favourable to the seller.

### 10.3 Price, structure, liquidity

**DTE — days to expiration** — calendar days to expiry. Central calibration
parameter: 30–45 DTE is the classic balance; **under 21 DTE gamma dominates**.

**Moneyness** — strike relative to spot: ITM, ATM, OTM.

**Intrinsic vs time value** — option price = intrinsic value (immediate gain if
exercised) + time value. An OTM option is *only* time value — it is worth zero at
expiry if nothing moves.

**Open interest (OI)** — contracts currently open on a strike. Structural
liquidity. Minimum filter: 500 [P2].

**Volume** — contracts traded during the session. Instantaneous liquidity —
distinct from OI [P4].

**Bid / ask / mid** — the mid is the bid-ask average and the reference for a limit
order [P18]. The spread is the immediate friction cost, **paid twice on a round
trip**.

**Expected move** — the move the market prices in until expiration. Common
approximation: ATM straddle price × 0.85 [P9]. Used to place strikes relative to
what is already priced.

### 10.4 Structures

**Credit spread** — sell an option + buy a further one on the same expiration.
Collects premium; defined, capped risk. The base structure of premium selling.

**Debit spread** — buy an option + sell a further one. Cheaper than a naked buy,
capped gain. Directional exposure at controlled cost.

**Straddle** — buy (or sell) a call and a put at the same ATM strike. A bet on
magnitude, not direction.

**Strangle** — same logic with different strikes, both OTM. Cheaper than a
straddle, needs a larger move.

**Iron condor** — a call credit spread plus a put credit spread. A bet on the
absence of movement, defined risk on both sides.

**Calendar spread** — sell a near expiration, buy a far one at the same strike.
Exploits the theta differential and the term structure.

### 10.5 Account mechanics

**Assignment** — obligation to deliver or buy the underlying when a sold option is
exercised. The principal risk of short ITM legs into expiration. Historical note:
assignments on 2026-09-03 were reflected in the former event's final equity.

**Early exercise** — possible on American-style options (single names, ETFs);
impossible on European-style (SPX, XSP). Cash-settled index options remove this
risk entirely.

**Buying power** — capital available to open new positions. On defined-risk
structures it equals the position's maximum loss [K3].

**Total equity** — cash + market value of positions. This is the useful portfolio
value, not the cash balance. Cash goes *down* when the agent buys options; that
alone is not a loss.

---

## 11. Pre-start checklist

- [ ] New $100k paper account created, distinct from the testing account — [R1]/[R2]/[D1]
- [ ] Whitelist built with frozen fundamental filters — [P1]/[P5]
- [ ] Week's event calendar loaded — [P17]
- [ ] Kill switch tested under real conditions — [O1] (`trip_kill_switch` over MCP is the drill)
- [ ] Data circuit breaker tested with a simulated aberrant quote — [O2]
- [ ] Structured decision log operational and readable by a judge — [O5]
- [ ] `RISK_ENFORCE=true` and `COMPETITION_ENFORCE=true` set in the official `.env`
- [ ] Close-before-2026-09-03-expiration policy implemented — [P23]
- [ ] README documents pre-kickoff work — [R17]/[D12]
- [ ] Backtests and shock simulations attached to the write-up — [R15]
