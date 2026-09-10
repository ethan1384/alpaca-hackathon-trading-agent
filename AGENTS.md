# Agent Coding Guidelines

This repository is designed to be extended by AI coding agents (Cursor, Claude Code, Codex).

## Hackathon rules — read first

`docs/05-hackathon-rules.md` is the binding restatement of the official Alpaca
hackathon guidelines + FAQ. **Read it before changing anything that places
orders, schedules the agent, or goes in the submission.** The rules that bite
most often:

- **Official account.** A dedicated $100k paper account, never the testing one.
  `COMPETITION_ACCOUNT_NUMBER` pins it; `assertCompetitionAccount()` refuses to
  trade any other. Judged on **equity**, never cash.
- **The deadline is Thursday.** Judged equity is the snapshot at **EOD Thu
  2026-09-03 (20:00Z)**, not Friday's close. Do not open a position whose legs
  expire after it.
- **Scoring window.** Opening trades count only between Mon 2026-08-31 13:30Z
  and the Thursday snapshot. Closing trades are always allowed.
- **No trailing stops on options** — equities only. Exits are the agent's job.
- **Free tier = indicative options feed.** Latest quotes/chains are real-time;
  historical option bars are 15-min delayed. Price off quotes, not bars.
- **Disclose pre-event work** in the README ([R17]) — it is a rules requirement,
  not housekeeping.

Enforcement lives in `src/config/competition.ts`,
`src/server/strategies/guardrails.ts` and `src/server/alpaca/account-guard.ts`.
`COMPETITION_ENFORCE=false` (the dev default) downgrades violations to warnings;
the official run sets it to `true`. Never work around a guardrail — if a rule
reading is wrong, fix the rule in `docs/05-hackathon-rules.md` and the code
together.

The **account** risk layer is separate: `src/config/risk.ts` (parameters + pure
predicates) and `src/server/risk/` (kill switch, data circuit breaker, execution
window, portfolio caps, decision log, reconciliation), gated by `RISK_ENFORCE`.
Both layers run from `executeSignal()`, which stays the single execution entry
point. Add a new risk control there, never at a call site.

`docs/06-options-parameters.md` is the companion: the rules say what is
forbidden, that file says how the agent is **calibrated** inside what is allowed
— universe filters, derived volatility signals, entry/exit parameters, portfolio
risk caps, and the operational layer (kill switch, circuit breaker, decision
log, reconciliation). Every item carries a status — `enforced`, `default`, or
`gap` — so the difference between a stated parameter and a checked one stays
visible. Read it before adding a strategy, a sizing rule, or a risk control.

## Skill routing — pick the resource before acting

Two skill sets are installed: BMAD-METHOD (from `bmad-code-org/BMAD-METHOD` via
`npx skills add`; canonical copies in `.agents/skills/`, symlinked into
`.claude/skills/`) and the vendored Alpaca skills (see *Alpaca Skills*).
Classify every request first, then invoke the matching skill. In Claude Code a
`UserPromptSubmit` hook (`.claude/hooks/skill-router.sh`) repeats this on every
prompt. The table mirrors the `bmad` skill's own routing
(`.agents/skills/bmad/references/help.md`) — if they disagree, that file wins.

| Request | Resource |
| --- | --- |
| Plain question, typo, formatting, ignore-file or config hygiene | Act directly — no workflow |
| Feature, bug fix, or meaningful change that fits one session | `bmad-build` |
| Work spanning 2-10 sessions (an epic) | `bmad-spec` → stories → `bmad-build` per story → `bmad-retrospective` |
| Project-sized work (a new product area) | `bmad` → brief or PRFAQ → `bmad-prd` → `bmad-architecture` → `bmad-create-epics-and-stories` → `bmad-sprint-planning` |
| "Where do I start?", "what's next?", unsure | `bmad` |
| The user asks to *review* a diff, PR or document | `bmad-code-review` (code) or `bmad-review` (any artifact) |
| Significant change of direction mid-sprint | `bmad-correct-course` |
| Research, or choosing between options | `bmad-deep-recon` |
| Anything touching the Alpaca API (orders, market data, backtests) | The matching `alpaca-*` skill — in addition to `bmad-build` when it means writing code |

Precedence: the hackathon rules above and the *Hard rules* below override any
BMAD workflow, and execution changes still go through `executeSignal()`. This
file is maintained by hand — do not run `bmad-project-context` over it. BMAD
runtime config lives in `_bmad/`, workflow output (specs, stories) in
`_bmad-output/`; both need `uv`. Update with `npx skills update`.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Zustand (real-time UI state), TanStack Query (REST)
- Alpaca SDK v4 (`@alpacahq/alpaca-trade-api`)
- Biome for lint/format, Vitest for tests

## Hard rules

1. **One Alpaca WebSocket per process, per data product.** Use `getMarketHub()` from `src/server/hub`. Never connect from the browser. The hub owns the equity/crypto stream plus one dedicated options stream (`optionStream`, `feed: "indicative"`) that only connects when an option is subscribed.
2. **Server/client boundary.** Anything under `src/server/` is server-only. Import `server-only` at the top of those modules.
3. **Normalize Alpaca payloads once.** Only `src/server/alpaca/normalize.ts` may know Alpaca market-data short keys (`T`, `S`, `p`, ...). Trading responses (orders/positions/account) are modelled camelCase by the SDK but type money as strings — `src/server/alpaca/normalize-trading.ts` is the single boundary that turns those into numeric domain models.
4. **No paper/live toggle in UI.** Display read-only badges from `/api/clock`.
5. **Route handlers touching the hub** must export:

```typescript
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
```

## Commands

```bash
pnpm install
pnpm dev
pnpm test
pnpm lint
pnpm build
```

## Before merging

1. Run `pnpm test`
2. Run `pnpm lint`
3. Run `pnpm build`
4. Verify no secrets in commits (`.env` is gitignored)

## Adding a feature

1. Domain types/schemas first (`src/domain/` — e.g. `trading.ts`, `strategy.ts`)
2. Server integration (`src/server/alpaca/`, `src/server/hub/`)
3. API route if needed (`src/app/api/`)
4. Client store/hook (`src/lib/`)
5. UI component (`src/components/`)
6. Update docs in `docs/` if architecture or Alpaca behavior changes
7. If the change touches execution or the submission, re-check it against
   `docs/05-hackathon-rules.md`

## Trading & MCP

Manual order execution and the MCP server are documented in `docs/04-trading-and-mcp.md`.

- Domain: `src/domain/trading.ts` (types + Zod schemas: `PlaceOrderSchema`, `ReplaceOrderSchema`, …).
- Server: `src/server/alpaca/trading.ts` (thin `client.trading.*` wrapper), `normalize-trading.ts`.
- REST: `/api/account`, `/api/positions[/:symbol]`, `/api/orders[/:id]`.
- MCP: `/api/mcp` (Streamable HTTP via `mcp-handler`). Tools are registered in
  `src/server/mcp/register-tools.ts` — reuse that module for any new transport.
- UI: `src/components/trading/` (`TradingPanel`), wired into the dashboard "Trading" tab.

## Backtests

Three independent engines under `src/server/backtest/`, one tab in the UI
(`BacktestWorkspace`), one shared Black-Scholes module:

| Engine | Strategy | Domain | Route |
| --- | --- | --- | --- |
| `triangle-engine.ts` | Ascending-triangle breakout → call spread / long call, daily swing | `src/domain/backtest-triangle.ts` | `/api/backtest/triangle` |
| `engine.ts` | ORB → 0DTE debit vertical | `src/domain/backtest.ts` | `/api/backtest` |
| `credit-spread.ts` | 1-2 DTE short credit spreads (archived strategy) | `src/domain/backtest-credit.ts` | `/api/backtest/credit` |

**Strategy status (2026-09-10).** The put-credit-spread strategy the live agent
ran through the hackathon is **archived**: git tag `archive/credit-spread-agent`,
banners on `docs/07` and `docs/08`. Its code is still in place — the live agent
in `src/server/agent/` has *not* been switched. The research track is now the
ascending-triangle breakout (`docs/09-strategie-triangle.md`); read §6–7 there
before wiring it live: no variant of its backtest shows an edge yet.

The triangle signal (`triangle.ts`) is pure and lookahead-free — a swing high
counts only `pivotStrength` bars after it prints, and the tests check that the
detector returns the same breakout on a series truncated at that bar.

`black-scholes.ts` is pure and shared — no `server-only`, so it stays testable
and reusable. Read `docs/07-strategie-credit-spreads.md` before touching the
credit engine: §6 lists what the model does *not* capture, and §7 shows that the
whole result hinges on `ivMultiplier`, which is an assumption rather than
something the backtest can discover.

All three engines measure time to expiry in **trading minutes** (`tradingYears`),
on the same 252-session calendar realised vol is annualised on. Do not reach for
`yearsBetween` when pricing: a 6.5-hour session is 1/252 of a trading year but
1/1348 of a calendar one, so calendar time understates `t` by ~5x on a 0DTE and
prices the structure far too cheap. `engine.ts` did exactly that until
2026-08-30; correcting it flipped the ORB backtest from +12,650 to −19,472 at
its calibrated settings.

## Phase 2 extension point

Trading strategies live in `src/server/strategies/`. See the README there for the
`Strategy` interface. Strategies emit signals; execution goes through
`src/server/alpaca/trading.ts`.

**Options mandate (hackathon rule).** Every `StrategySignal` must resolve to one
or more option legs (OCC symbols) on its underlying — `StrategySignalSchema`
(`src/domain/strategy.ts`) rejects equity/crypto legs. Strategies output a
directional thesis + `ContractSelection` (target delta / DTE window / liquidity
floor); `src/server/strategies/select-contract.ts` resolves it to contracts and
`src/server/strategies/execute.ts` submits a single-leg option order or an `mleg`
spread. Multi-leg order support lives in `PlaceOrderSchema` (`legs[]` →
`orderClass: "mleg"`).

## Alpaca Skills

Vendored from [`alpacahq/alpaca-skills`](https://github.com/alpacahq/alpaca-skills)
(Apache-2.0). Canonical copies live in `.claude/skills/<name>/SKILL.md`;
`.cursor/skills` is a symlink to that directory, so Cursor also sees the BMAD
skills linked there. **Codex / other agents:** read the matching `SKILL.md`
directly before doing the task it covers (BMAD skills are also in `.agents/skills/`).

Each skill is a `SKILL.md` (some with a `reference.md`) of step-by-step
instructions, guardrails, and reporting standards. Load one on demand — do not
preload all of them.

| Skill | When to use |
| --- | --- |
| `alpaca-trading-backtest` | Deterministic historical backtests from a start/end date + strategy concept |
| `alpaca-trading-paper-trading` | Take a strategy signal and execute it as a paper trade (generic, SDK/API) |
| `alpaca-trading-paper-trading-cli` | Same, via the Alpaca CLI |
| `alpaca-trading-paper-trading-mcp` | Same, via the Alpaca Trading API MCP server |
| `alpaca-broker-integration` | Broker API integration setup |
| `alpaca-broker-account-onboarding` | Broker account creation + KYC |
| `alpaca-broker-funding-transfers` | ACH/wire funding and transfers |
| `alpaca-broker-journals` | JNLC/JNLS journals between accounts |
| `alpaca-broker-trading-orders` | Trading on behalf of Broker API accounts |
| `alpaca-broker-market-data` | Market data for Broker API |
| `alpaca-broker-sse-events` | Consuming Broker SSE event streams |
| `alpaca-broker-reconciliation-idempotency` | Reconciliation + idempotency patterns |
| `alpaca-broker-rate-limits-resilience` | Rate-limit handling + retry/resilience |
| `alpaca-broker-money-precision` | Money + numeric precision handling |

Note: this project trades through `src/server/alpaca/trading.ts` and its own
`/api/mcp` server, not the Alpaca CLI — prefer `alpaca-trading-paper-trading`
for execution guidance and treat the CLI/MCP skills as reference.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
