# Legacy competition compatibility

This repository started as an Alpaca trading-agent competition entry. The project is now
maintained as a personal options-trading research system, but the original event controls
remain in code for reproducibility and historical backtest consistency.

## What remains

- `src/config/competition.ts` contains the fixed 2026 event dates and expiration deadline.
- `src/server/strategies/guardrails.ts` can block openings outside that window.
- `src/server/alpaca/account-guard.ts` can pin execution to a specific paper account.
- `get_competition_status` exposes the legacy state through MCP.
- Agent prompts, state payloads and parts of the UI still use competition-oriented names.

These modules are compatibility code, not the desired long-term scheduling model for the
personal project.

## Current behaviour

`COMPETITION_ENFORCE=false` turns most legacy rule violations into warnings. However, the
autonomous agent also calls `isOpeningWindowOpen()` directly, so its entry path remains
closed after the original snapshot date regardless of that flag. Manual trading and
backtests are not generally limited by the expired agent entry window.

## Migration direction

Before enabling ongoing autonomous entries:

1. Introduce a general operating-calendar configuration independent of the legacy dates.
2. Keep the paper-account assertion as a reusable safety control.
3. Replace the final-snapshot rule with a configurable maximum expiration and flattening
   policy.
4. Rename competition status types, UI labels and MCP tools without changing their safety
   semantics.
5. Update the unit tests before removing the legacy module.

The portfolio and operational controls in
[Options parameters, risk and operations](06-options-parameters.md) remain applicable to
the personal project and should not be removed with the legacy calendar.
