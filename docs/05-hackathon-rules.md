# Hackathon Rules (binding)

Source: **Alpaca AI Trading Agents Hackathon** — official guidelines + FAQ
(lablab.ai). This file is the canonical, machine-checked restatement of those
rules for this repository. Every agent working in this repo — Claude Code,
Cursor, Codex — must read it before touching execution, scheduling, or
submission code.

Rules marked **[R#]** are hard constraints. Rules marked **[D#]** are
engineering decisions *derived* from a hard constraint. Each one names where it
is enforced in code so the two never drift.

---

## 1. Account

| | |
|---|---|
| **[R1]** | The official submission must run on a **new Alpaca paper account** with a **$100,000** starting balance. |
| **[R2]** | The testing/development account must **not** be used for the official P&L measurement. Same email is fine; the account must be new. |
| **[R3]** | Performance is measured on **total account equity**, never cash balance. |

**[D1]** `.env` for the official run points at the competition paper account.
`COMPETITION_ACCOUNT_NUMBER` pins that account; `assertCompetitionAccount()`
(`src/server/alpaca/account-guard.ts`) refuses to trade when the live credentials
resolve to a different account, when `ALPACA_PAPER` is not `true`, or when the
account is blocked. Enforced before every opening order.

**[D2]** Never key any submission metric off `account.cash` — use
`account.equity` / `portfolioValue`. Cash goes *down* when the agent buys
options; that is not a loss.

---

## 2. Timeline (all times US/Eastern, EDT = UTC−4)

| Milestone | ET | UTC |
|---|---|---|
| Hackathon window opens | Fri **2026-08-28** 09:30 | `2026-08-28T13:30:00Z` |
| **Official scoring starts** | Mon **2026-08-31** 09:30 | `2026-08-31T13:30:00Z` |
| **Equity snapshot for scoring** | Thu **2026-09-03** EOD (16:00) | `2026-09-03T20:00:00Z` |
| Window closes / submission | Fri **2026-09-04** 09:30 | `2026-09-04T13:30:00Z` |

| | |
|---|---|
| **[R4]** | The agent begins trading the competition account on **Mon 2026-08-31 09:30 ET**. Trades before that, in the testing account, do not count. |
| **[R5]** | Judged equity is the portfolio's total equity **as of EOD Thursday 2026-09-03**. Exercises/assignments for options expiring 2026-09-03 are reflected in that value. |
| **[R6]** | Trading after Fri 2026-09-04 09:30 ET does not count. |

**[D3]** The scoring value is fixed at Thursday's close, not Friday's. Friday
morning is **not** a recovery session — it is after the fact. The agent must
treat **Thu 2026-09-03 16:00 ET as the real deadline**.

**[D4]** Do not open a position whose option legs expire **after 2026-09-03**
unless the thesis is explicitly closed before Thursday's close: contracts
expiring later are still marked to market at the snapshot, but they carry
weekend/gap risk that is never realised inside the measured window.
`optionExpirationDeadline` in `src/config/competition.ts`; `checkSignal()` in
`src/server/strategies/guardrails.ts` rejects an opening leg that expires past
it, and `applyCompetitionDteWindow()` narrows the strategy's requested DTE
window before contract selection runs. `resolveContracts()` stays a generic
mechanism — the deadline is applied by its caller, not baked into it.

**[D5]** No new *opening* trades outside the scoring window when
`COMPETITION_ENFORCE=true`. Closing trades are always allowed — risk must always
be reducible.

---

## 3. Market data

| | |
|---|---|
| **[R7]** | Free Basic plan is permitted; it provides the **indicative** options feed. Algo Trader Plus (OPRA) is permitted but is **not** granted automatically. |
| **[R8]** | On Basic, the 15-minute restriction applies to **historical bars and trades only** — the **latest option quote and chain are real-time**. |
| **[R9]** | The Alpaca dashboard charts may lag. Agents must rely on **API data**, not the dashboard. |

**[D6]** `OPTIONS_FEED = "indicative"` (`src/config/constants.ts`). Do not switch
to `opra` without a paid subscription — the stream silently returns nothing.

**[D7]** Option pricing decisions (entry limit, spread width, liquidity floor)
read the **latest quote / snapshot** endpoints, never historical option bars.
Underlying bars may be delayed on Basic; on `iex` they are not. Never gate an
entry on an option's historical bar.

---

## 4. Execution constraints

| | |
|---|---|
| **[R10]** | Option orders support **market, limit, stop, stop_limit**. **Trailing stop is equities-only** — it is not valid on an options contract. |
| **[R11]** | There are **no restrictions on options strategies**. Any structure is allowed. |
| **[R12]** | Risk management on an option position = monitor it and submit a market/limit closing order. There is no server-side trailing stop to lean on. |

**[D8]** `PlaceOrderSchema` (`src/domain/trading.ts`) rejects
`type: "trailing_stop"` when the symbol is an OCC contract, and rejects it on
`mleg` orders. The failure is a validation error, not an Alpaca 4xx at 3pm.

**[D9]** Because [R12] gives no broker-side trailing stop, exits are the agent's
job: the strategy layer carries `underlyingStop` / `underlyingTarget` on the
signal and the agent loop is responsible for firing the closing order.

---

## 5. Judging

| | |
|---|---|
| **[R13]** | Judged on **trading performance (total equity)** *and* the **creativity, autonomy, and robustness** of the agent workflow. P&L alone does not decide it. |
| **[R14]** | Risk-adjusted metrics (Sharpe/Sortino/drawdown) are **not** scored — only total equity at the close. |
| **[R15]** | Backtests and simulated shocks may be included as **evidence of guardrails** in the write-up; they are not the official P&L. |

**[D10]** Half the score is the workflow. Decision logging, the memory system,
and the guardrails in this document are scored artifacts — they are not
optional polish. See `docs/04-llm-agent.md` § "To build alongside".

**[D11]** [R14] means the objective is terminal equity, not a smooth curve. It
does *not* mean uncapped risk: a blown-up account scores zero on both axes, and
[R13] scores robustness explicitly. Position sizing stays bounded by the
portfolio caps [K1]-[K6] and the kill switch [O1] — `src/config/risk.ts`,
`docs/06-options-parameters.md`.

---

## 6. Submission & disclosure

| | |
|---|---|
| **[R16]** | The GitHub repo **may stay private** during the hackathon. |
| **[R17]** | Pre-event work (infrastructure, boilerplate, pre-existing libraries) **is allowed but MUST be disclosed** in the README / final submission. |
| **[R18]** | A UI is **not required** — judging is on the autonomous workflow and performance. Hosting is only needed if the submission includes a demo app judges must open. |
| **[R19]** | Alpaca **MCP or CLI** is the preferred integration path. Using an SDK instead is allowed but the reasons **must be clearly explained**, and the official SDKs prioritised. |

**[D12]** README carries a "Pre-event work & disclosures" section satisfying
[R17] and an "Why the SDK + our own MCP server" note satisfying [R19]. Keep both
current — an undisclosed pre-existing component is a rules violation, not a
style issue.

**[D13]** The dashboard is optional under [R18]; it exists to make the workflow
legible to judges under [R13]. It must never become a prerequisite for the agent
to trade — the agent runs headless.

---

## 7. Options mandate (this project's own rule)

Every `StrategySignal` resolves to option legs on its underlying;
`StrategySignalSchema` (`src/domain/strategy.ts`) rejects equity/crypto legs.
This is stricter than [R11] and is a deliberate project constraint, not a
hackathon rule. See `AGENTS.md`.

---

## Enforcement map

| Rule | Enforced in |
|---|---|
| D1 | `src/server/alpaca/account-guard.ts` (`assertCompetitionAccount`) |
| D3, D4, D5 | `src/config/competition.ts` + `src/server/strategies/guardrails.ts` |
| D6 | `src/config/constants.ts` |
| D8 | `src/domain/trading.ts` (`PlaceOrderSchema`) |
| Entry point | `executeSignal()` calls the guardrails before *and* after contract resolution |
| D12 | `README.md` |
| Visibility | MCP tool `get_competition_status` (`src/server/mcp/register-tools.ts`) |

The **account** risk layer is separate and lives in `docs/06-options-parameters.md`
(`src/config/risk.ts` + `src/server/risk/`), gated by `RISK_ENFORCE`. Both run
from `executeSignal()`. They are kept apart on purpose: the competition rules are
fixed by the organisers and expire with the event; the risk caps are ours and
outlive it, and collapsing them would make it impossible to relax one without
relaxing the other.

## Escape hatch

Set `COMPETITION_ENFORCE=false` (the default outside the official run) to
develop and test freely. The guardrails then downgrade from throwing to
returning warnings. `RISK_ENFORCE=false` does the same for the account risk
layer, skipping it entirely so no credentials are needed. **The official run sets
both to `true`.**
