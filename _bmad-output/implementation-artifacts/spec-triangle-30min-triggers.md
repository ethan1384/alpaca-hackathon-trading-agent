---
title: 'Triangle ascendant — triggers sur bougies 30 min, swing conservé'
type: 'feature'
created: '2026-09-10'
status: 'in-progress'
route: 'dispatch'
baseline_commit: '84a39d9d218954a282fdc1a41344cb390b7adecf'
review_loop_iteration: 0
context:
  - '{project-root}/docs/09-strategie-triangle.md'
  - '{project-root}/AGENTS.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Le backtest triangle détecte la figure et déclenche l'entrée sur des bougies journalières. L'utilisateur veut des triggers sur bougies de 30 minutes en gardant un horizon swing (détention de jours à semaines, options 30-45 DTE), et des docs .md à jour.

**Approach:** Ajouter un paramètre `timeframe` (`30Min` par défaut, `1Day` conservé pour comparaison) : détection et entrée sur les bougies 30 min des heures régulières, gestion swing sur les niveaux du sous-jacent, temps restant en minutes de bourse. Relancer les backtests, mettre à jour docs, mémoire et rapport.

Décisions (paramètres exposés, variantes montrées dans la grille) :
- Stop vérifié à la clôture de séance par défaut (`stopCheck: session_close`), `bar_close` disponible ; cible testée sur le plus haut de chaque bougie.
- Défauts 30Min : fenêtre 130 bougies (10 séances), figure ≥ 26 bougies (2 séances), cooldown 13 ; tolérance, hauteur, pente, buffer et stop mis à l'échelle ; une valeur explicite l'emporte toujours.
- DTE 35 et time stop 15 séances inchangés.

## Boundaries & Constraints

**Always:**
- Seules les bougies 09:30–16:00 ET entrent dans détection, entrées et sorties : le flux 30Min d'Alpaca renvoie aussi 08:00-09:00 et 16:00+ (vérifié le 2026-09-10).
- Volume relatif = volume de la bougie / moyenne du **même créneau ET** sur les `volumeLookbackSessions` séances précédentes (la bougie de 15:30 fait ~8× celle de midi). En `1Day` cela revient aux N jours précédents, comme aujourd'hui.
- Pas de lookahead : pivot confirmé `pivotStrength` bougies plus tard ; entrée à l'ouverture de la bougie régulière suivante (09:30 du lendemain si la cassure est la bougie de 15:30).
- Temps restant via `tradingYears(minutes)` : minutes restantes de la séance + 390 × séances restantes ; jamais `yearsBetween`.
- En `1Day` avec les défauts, résultats identiques au moteur commité.
- Récupération des bougies : 4 symboles en parallèle maximum + `withRetry` avec backoff de plusieurs secondes.

**Never:** toucher l'agent live (`src/server/agent/`), ajouter une source de données ou `1Hour`, changer la structure d'option ou le modèle de prix, commiter sur `main`, pousser.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cassure en séance | clôture 11:00 au-dessus du couvercle, volume ≥ multiple × moyenne du créneau | entrée à l'ouverture de 11:30 | — |
| Cassure sur 15:30 | dernière bougie régulière | entrée à 09:30 le lendemain | pas de bougie suivante → `skippedData` |
| Volume de clôture | 15:30 à 8× midi, normal pour ce créneau | pas de confirmation de volume | — |
| Heures étendues | bougies 08:00 / 16:00 | ignorées | — |
| Stop `session_close` | une bougie clôture sous le stop, la séance clôture au-dessus | position conservée | — |
| Cible en séance | plus haut ≥ R + H | sortie à la cible sur cette bougie | — |
| Échec réseau | `FetchError` sans statut HTTP | réessayé avec backoff | échec final → 500 avec message |

</frozen-after-approval>

## Code Map

- `src/domain/backtest-triangle.ts` -- schéma : `timeframe`, `stopCheck`, `volumeLookbackBars` → `volumeLookbackSessions`, paramètres d'échelle optionnels résolus par une table `TRIANGLE_TIMEFRAME_DEFAULTS` dans un `transform` ; résultat `barsByUnderlying` → `barsByTrade` (fenêtres, charge utile raisonnable en 30Min).
- `src/server/backtest/triangle.ts` -- `detectTriangleBreakouts(bars, p, slots?)` : volume relatif par créneau (fenêtre glissante par créneau, O(n)) ; fenêtre de pivots à deux pointeurs (le `filter` actuel par bougie est O(n × pivots), trop lent à ~20k bougies/symbole).
- `src/server/backtest/triangle-engine.ts` -- type de deps propre (`Timeframe`) ; filtre heures régulières via `toEastern`, `MARKET_OPEN_ET`, `MARKET_CLOSE_ET` (`orb.ts`) ; clôtures de séance dérivées des bougies (IV, benchmark, points d'équité) ; boucle par séance ; `t` en minutes ; `stopCheck` ; réutiliser `sessionsBetween`, `expirationFor`, `impliedVolFor`.
- `src/server/alpaca/retry.ts` -- réutiliser `withRetry` (lecture, `retryOnNoResponse` à true).
- `src/components/backtest/TrianglePanel.tsx`, `TriangleTradeChart.tsx`, `BacktestPanel.tsx` (prop `placeholder` sur `Field`) -- contrôles timeframe et stop, champs « auto » par timeframe, axe horaire intraday, bougies par trade.
- Tests : `triangle.test.ts`, `triangle-engine.test.ts`, `__fixtures__/triangle-series.ts`.
- Docs : `docs/09-strategie-triangle.md`, `AGENTS.md`, `docs/04-llm-agent.md`, `src/server/strategies/README.md`, `README.md` (travail post-événement).
- Mémoire : `/Users/ethan/.claude/projects/-Users-ethan-Development-alpaca-hackathon-trading-agent/memory/triangle-strategy.md` et sa ligne d'index dans `MEMORY.md` (même dossier) — mettre à jour, ne pas dupliquer.
- Rapport : `/private/tmp/claude-501/-Users-ethan-Development-alpaca-hackathon-trading-agent/d2bde48b-6b01-486e-ba1b-31580031fe28/scratchpad/` contient `gen-report.mjs`, `report.template.html` (prose aux chiffres codés en dur, à réécrire) et les runs daily (`triangle-default.json`, `grid-B…H.json`). Republier `report.html` du même dossier sur l'artifact existant `https://claude.ai/code/artifact/1e7cd997-d031-4ea0-b267-1248001203d6` ; si l'outil Artifact est indisponible, régénérer `report.html` et laisser la publication à l'orchestrateur.
- Runs : `next dev` tourne déjà sur `localhost:3000` (ne pas en lancer un second). La grille daily a échoué en enchaînant des runs de 40 symboles : attendre ≥ 60 s entre deux.

## Tasks & Acceptance

**Execution:**
- [ ] `src/domain/backtest-triangle.ts` -- timeframe, stopCheck, table de défauts, transform, `barsByTrade` -- une seule source de calibration par timeframe
- [ ] `src/server/backtest/triangle.ts` -- créneaux + deux pointeurs -- justesse et vitesse
- [ ] `src/server/backtest/triangle-engine.ts` -- moteur intraday, concurrence bornée + retry -- cœur du changement
- [ ] tests + fixture 30 min (horodatage EDT) -- volume par créneau, cassure 15:30 → entrée le lendemain, heures étendues ignorées, stop `session_close` vs `bar_close`, `t` en minutes, résolution des défauts ; tests daily verts
- [ ] UI -- contrôles et graphique
- [ ] backtests -- défaut (10 symboles, 3 ans, 30Min) + grille 40 symboles 6 ans (spread, call nu, stop `bar_close`, fenêtre 260, référence `1Day`), espacés
- [ ] docs, mémoire, rapport republié

**Acceptance Criteria:**
- Given `timeframe` omis, when l'API tourne, then la détection utilise les bougies 30Min régulières et `params` renvoie les défauts 30Min résolus.
- Given `timeframe: "1Day"` et la variante D commitée, when elle tourne, then elle redonne 40 trades et −5,9 %.
- Given un run 30Min 40 symboles × 6 ans lancé seul, when il s'exécute, then il se termine sans erreur de récupération.
- Given l'onglet Backtest, when un trade 30Min est sélectionné, then le graphique montre des bougies 30 min avec le triangle posé sur les bonnes bougies.

## Implementation Notes

## Spec Change Log

## Review Triage Log

## Design Notes

Boucle par séance : pour chaque bougie, entrées à l'ouverture puis sorties (stop si `bar_close` ou dernière bougie de la séance, cible, prise de profit) ; sur la dernière bougie de la séance, en plus : time stop, plancher d'échéance, fin des données, valorisation de l'équité. En `1Day` chaque bougie est la dernière de sa séance : l'ordre stop-avant-cible actuel est conservé.

## Verification

**Commands:**
- `pnpm test` -- expected: tout passe
- `pnpm exec tsc --noEmit -p .` -- expected: aucune erreur
- `pnpm exec biome check <fichiers modifiés>` -- expected: propre
- `pnpm build` -- expected: succès
- `curl -X POST localhost:3000/api/backtest/triangle` (défaut + grille) -- expected: Σ P&L = équité finale − initiale

**Manual checks:**
- Onglet Backtest : 2-3 trades 30Min, contacts sur les pivots hauts, entrée sur la bougie suivant la cassure.
