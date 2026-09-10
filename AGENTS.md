# Agent Coding Guidelines

This repository is designed to be extended by AI coding agents (Cursor, Claude Code,
Codex). It is a personal Alpaca options-trading research project and can submit orders to
the account configured in `.env`.

## Trading safety — read first

- Keep development and unreviewed deployments on `ALPACA_PAPER=true`.
- `executeSignal()` in `src/server/strategies/execute.ts` is the single strategy execution
  entry point. Add new risk controls there, never only at a call site.
- Closing orders must remain possible even when opening-risk gates are tripped.
- The account risk layer lives in `src/config/risk.ts` and `src/server/risk/`, gated by
  `RISK_ENFORCE`. Read `docs/06-options-parameters.md` before adding a strategy, sizing
  rule or risk control.
- The project deliberately requires every `StrategySignal` to resolve to option legs on
  its underlying. `StrategySignalSchema` enforces this.
- Legacy event dates and account checks still exist in `src/config/competition.ts`,
  `src/server/strategies/guardrails.ts` and `src/server/alpaca/account-guard.ts`. Read
  `docs/05-legacy-competition.md` before changing or removing them. The archived agent's
  entry path remains closed after the historical event window.
- Never work around a guardrail to make an order pass. Correct the configuration, rule and
  tests together.

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
| Git housekeeping — sync, rebase, open a PR, clean up merged branches | Act directly, following `docs/10-git-workflow.md` |

Precedence: the safety rules above and the *Hard rules* below override any
BMAD workflow, and execution changes still go through `executeSignal()`. This
file is maintained by hand — do not run `bmad-project-context` over it. BMAD
runtime config lives in `_bmad/`, workflow output (specs, stories) in
`_bmad-output/`; both need `uv`. Update with `npx skills update`.

## Git & collaboration — two developers, one repo

Two people, each with their own agent, work here in parallel.
`docs/10-git-workflow.md` is the binding workflow — **read it before creating a
branch, committing, rebasing or pushing.** The rules that prevent collisions:

- **Never commit or push to `main`.** Work reaches `main` only through a pull
  request, squash-merged by a human. Agents never merge.
- **One branch per spec/story: `<prefix>/<type>/<slug>`.** `prefix` is the first
  word of `git config user.name`, lowercased (`ethan/feat/triangle-30min-triggers`);
  `slug` is the BMAD spec slug. Create it from a fresh `origin/main` and push it at
  once (`git push -u origin HEAD`) — the remote branch is the claim your colleague sees.
- **Preflight every task:** `git fetch --prune origin`; a dirty tree means stop and
  ask; a colleague's branch with the same slug means stop; warn about files their
  open branches already touch.
- **Only touch branches with your own prefix.** Never commit to, rebase, push or
  delete a colleague's branch.
- **Stage explicit paths** — never `git add -A` / `git add .` — and rebase on
  `origin/main` before the PR. Push your own branch with `--force-with-lease`, never
  `--force`.
- **Shared BMAD files:** a spec lives on its author's branch; in
  `sprint-status.yaml` touch only your own story's line; `deferred-work.md` is
  append-only (`merge=union` in `.gitattributes`); `_bmad/custom/*.toml` is team
  policy (PR only), `*.user.toml` is personal and gitignored.
- This policy is standing authorization for exactly three things: create your
  branch, commit on it, push it. Anything else that writes to the remote, or
  discards local work, goes through the human.

Enforcement: in Claude Code, a `PreToolUse` hook (`.claude/hooks/git-guard.mjs`)
denies pushes to `main`, force pushes, pushing or deleting another prefix's
branch, commits on `main` and `--no-verify`, and asks the human before
`reset --hard`, `clean -f`, `checkout -- <path>`, `restore`, `stash drop|clear`
and `branch -D`. The BMAD workflows `bmad-build`, `bmad-build-auto`, `bmad-spec`,
`bmad-code-review` and `bmad-sprint-planning` load `docs/10` through team
overrides in `_bmad/custom/`. Codex and Cursor only have this section — apply it
by hand.

## Stack

- Next.js 16 App Router, React 19, TypeScript strict
- Tailwind CSS v4 + shadcn/ui
- Zustand for real-time UI state, TanStack Query for REST state
- Alpaca SDK v4 (`@alpacahq/alpaca-trade-api`)
- Biome for lint/format, Vitest for tests

## Hard rules

1. **One Alpaca WebSocket per process, per data product.** Use `getMarketHub()` from
   `src/server/hub`. Never connect from the browser. The hub owns the equity/crypto stream
   plus one options stream (`feed: "indicative"`) that connects only when needed.
2. **Server/client boundary.** Anything under `src/server/` is server-only. Import
   `server-only` at the top of those modules.
3. **Normalize Alpaca payloads once.** Only `src/server/alpaca/normalize.ts` may know
   market-data short keys. Trading responses pass through
   `src/server/alpaca/normalize-trading.ts`.
4. **No paper/live toggle in the UI.** Display read-only state from `/api/clock`.
5. **Hub route runtime.** Route handlers touching the hub must export:

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

1. Rebase on `origin/main` (`git fetch origin && git rebase origin/main`)
2. Run `pnpm test`
3. Run `pnpm lint`
4. Run `pnpm build`
5. Verify no secrets in commits (`.env` is gitignored)
6. Push your own branch and open a PR; a human squash-merges it — never push to
   `main` (`docs/10-git-workflow.md` §5)

## Adding a feature

Start with the Git preflight (`docs/10-git-workflow.md` §2): your own branch
from a fresh `origin/main`.

1. Domain types and schemas first (`src/domain/`).
2. Server integration (`src/server/alpaca/`, `src/server/hub/`).
3. API route if needed (`src/app/api/`).
4. Client store or hook (`src/lib/`).
5. UI component (`src/components/`).
6. Update the relevant document under `docs/` when behaviour or architecture changes.
7. Re-check every execution change against the shared risk gate and
   `docs/05-legacy-competition.md` when touching competition-era guards.

## Trading and MCP

Manual order execution and the MCP server are documented in
`docs/04-trading-and-mcp.md`.

- Domain: `src/domain/trading.ts`
- Server: `src/server/alpaca/trading.ts` and `normalize-trading.ts`
- REST: `/api/account`, `/api/positions[/:symbol]`, `/api/orders[/:id]`
- MCP: `/api/mcp` via `mcp-handler`
- Tool registration: `src/server/mcp/register-tools.ts`
- UI: `src/components/trading/`

Reuse `registerTradingTools()` for any new MCP transport.

## Backtests

Three independent engines live under `src/server/backtest/` and share the pure
`black-scholes.ts` module:

| Engine | Strategy | Domain | Route |
| --- | --- | --- | --- |
| `triangle-engine.ts` | Ascending-triangle breakout on 30-min triggers (daily kept) → call spread / long call, swing hold | `src/domain/backtest-triangle.ts` | `/api/backtest/triangle` |
| `engine.ts` | ORB to 0DTE debit vertical | `src/domain/backtest.ts` | `/api/backtest` |
| `credit-spread.ts` | 1–2 DTE short credit spreads, archived strategy | `src/domain/backtest-credit.ts` | `/api/backtest/credit` |

The credit-spread agent is archived at tag `archive/credit-spread-agent`; its code remains
wired but cannot open beyond its historical window. The active research track is the
ascending-triangle backtest in `docs/09-strategie-triangle.md`. It is backtest-only and no
tested variant currently demonstrates an edge, so do not wire it live without new evidence.

The triangle detector is pure and lookahead-free; its tests verify the same breakout on a
series truncated at the detection bar. The triangle backtest runs on `timeframe` `30Min`
(default) or `1Day`:

- **One calibration source.** Bar-size-dependent parameters (window, pattern
  length, cooldown, tolerance, height, slope, buffers) are resolved from
  `TRIANGLE_TIMEFRAME_DEFAULTS` in the schema's `transform`; an explicit value
  always wins. `1Day` with its defaults reproduces the first daily study to the
  trade — keep it that way.
- **Regular session only.** Alpaca's 30Min feed also returns pre-market and
  after-hours bars; the engine drops everything outside 09:30–16:00 ET before
  detection, entry, exit and session closes (IV, benchmark, equity marks).
- **Volume per time slot.** The breakout bar is compared with the same ET slot
  over `volumeLookbackSessions` prior sessions — the 15:30 bar trades ~8× the
  midday one. A plain trailing mean would confirm every closing bar.
- **Fetching.** Four symbols at a time, each through `withRetry` with a
  multi-second backoff: 40 unbounded 30-minute fetches trip the data rate limit,
  and the SDK then fails with no HTTP status. Space 40-symbol runs ≥ 60 s apart.

Read `docs/07-strategie-credit-spreads.md` before changing the credit engine. Its result is
highly sensitive to `ivMultiplier`, an assumption that cannot be recovered from underlying
bars. `black-scholes.ts` is pure and shared — no `server-only`, so it stays testable
and reusable.

All three engines measure time to expiry in trading minutes (`tradingYears`) on the same
252-session calendar used to annualise realised volatility. Do not replace it with calendar
time when pricing short-dated structures.

## Strategy and agent extension points

Strategies live in `src/server/strategies/` and emit `StrategySignal` values. Contract
selection happens in `select-contract.ts`; execution happens in `execute.ts` as a
single-leg option order or an `mleg` spread.

The archived autonomous agent lives in `src/server/agent/` and is documented in
`docs/08-agent.md`. Its mechanical strategy builds a SPY bull put spread; the LLM may only
veto an entry or close early in the dead zone. Profit target, stop, time close, sizing and
risk checks remain deterministic. A live triangle `Strategy` is not built yet.

## Alpaca Skills

Vendored from [`alpacahq/alpaca-skills`](https://github.com/alpacahq/alpaca-skills)
(Apache-2.0). Canonical copies live in `.claude/skills/<name>/SKILL.md`;
`.cursor/skills` links to that directory. Codex and other agents must read the matching
`SKILL.md` directly before doing a covered task. Load skills on demand, not all at once.

| Skill | When to use |
| --- | --- |
| `alpaca-trading-backtest` | Deterministic historical backtests |
| `alpaca-trading-paper-trading` | Execute a strategy signal as a paper trade |
| `alpaca-trading-paper-trading-cli` | Paper trading through Alpaca CLI |
| `alpaca-trading-paper-trading-mcp` | Paper trading through Alpaca MCP |
| `alpaca-broker-integration` | Broker API integration setup |
| `alpaca-broker-account-onboarding` | Broker account creation and KYC |
| `alpaca-broker-funding-transfers` | ACH/wire funding and transfers |
| `alpaca-broker-journals` | JNLC/JNLS journals between accounts |
| `alpaca-broker-trading-orders` | Broker API account trading |
| `alpaca-broker-market-data` | Broker API market data |
| `alpaca-broker-sse-events` | Broker SSE event streams |
| `alpaca-broker-reconciliation-idempotency` | Reconciliation and idempotency |
| `alpaca-broker-rate-limits-resilience` | Retry and rate-limit handling |
| `alpaca-broker-money-precision` | Money and numeric precision |

This application executes through `src/server/alpaca/trading.ts` and its own `/api/mcp`
server. Prefer `alpaca-trading-paper-trading` for execution guidance; treat the CLI and MCP
skills as references unless the task explicitly targets those transports.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ
from your training data. Read the relevant guide in `node_modules/next/dist/docs/`
(resolved from this file's directory; in monorepos the `next` package may not be visible
from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at
`node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only
re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
