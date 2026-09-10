# Stratégie — Cassure de triangle ascendant → call (swing, barres journalières)

*Spécification, modèle et résultats du backtest.*

Signal : `src/server/backtest/triangle.ts` · Moteur :
`src/server/backtest/triangle-engine.ts` · Domaine :
`src/domain/backtest-triangle.ts` · API : `POST /api/backtest/triangle` · UI :
onglet **Backtest → Ascending triangle → call**.

Remplace, comme piste de recherche, le put credit spread archivé (tag git
`archive/credit-spread-agent`, docs/07–08). L'agent live n'est **pas** basculé :
voir §7.

---

## 1. Définition

Un **triangle ascendant** est une résistance horizontale (le « couvercle »)
testée plusieurs fois, sous laquelle les creux montent. L'offre plafonne à un
prix, la demande accepte des prix de plus en plus hauts : la cassure du
couvercle est censée libérer un mouvement d'une amplitude comparable à la
hauteur de la figure — le **mouvement mesuré**, cible = résistance + hauteur.

La stratégie achète de la hausse via une option : un **bull call spread** (par
défaut) ou un call nu, 30-45 jours, détenu quelques jours à quelques semaines.

## 2. Détection (couche signal — pure, sans option)

Sur les barres journalières du sous-jacent, pour chaque barre *j* :

1. **Pivots hauts.** Une barre est un pivot haut si son plus haut domine
   `pivotStrength` (3) barres de chaque côté. Il n'est **connu que 3 barres
   après** : au bar *j*, seuls les pivots confirmés au plus tard en *j−1* sont
   utilisés. C'est la garantie anti-lookahead ; un test vérifie que le détecteur
   rend la même cassure sur la série tronquée au bar de cassure.
2. **Couvercle.** Sur les `lookbackBars` (60) dernières barres, R = plus haut
   des pivots hauts. Il faut au moins `minTouches` (3) pivots à moins de
   `touchTolerancePct` (1 %) sous R.
3. **Sous le couvercle depuis le premier contact.** Aucune clôture au-dessus du
   seuil de cassure ni aucun plus haut au-delà de la tolérance entre le premier
   contact et *j−1* : la barre *j* est la *première* clôture à travers.
4. **Creux strictement ascendants.** Un creux par oscillation : le plus bas
   entre deux contacts consécutifs, plus le dernier resserrement avant la
   cassure. Chacun doit être **strictement plus haut** que le précédent, et la
   pente de régression d'au moins `minSlopePctPerBar` (0,05 % du prix par
   barre) — ce qui écarte les rectangles plats.
   *Historique :* une première version prenait tous les pivots bas avec une
   simple pente de régression positive. Sur données réelles elle acceptait un V
   (SPY 2024 : 537 → 510 → 539, le creux d'août) et un support qui s'affaissait
   en fin de figure (SPY 2026). Un test (`V_FLOOR`) verrouille la correction.
5. **Géométrie.** Hauteur H = R − premier creux, au moins `minHeightPct` (3 %)
   de R. Le support prolongé doit rester sous R au bar *j* (apex non dépassé).
6. **Cassure.** Clôture > R × (1 + `breakoutBufferPct`) (0,2 %) et volume du
   jour > `volumeMultiple` (1,2) × moyenne des 20 barres précédentes. Une
   cassure sur volume faible est comptée à part (`rejectedVolume`) et n'est pas
   retentée. `cooldownBars` (10) par symbole ensuite.

## 3. Structure et exécution simulée (couche structure)

| | valeur | paramètre |
| --- | --- | --- |
| entrée | **ouverture du lendemain** de la cassure (gap inclus) | — |
| jambe longue | call à delta 0,45 | `targetDelta` |
| jambe courte (spread) | sur la cible R + H, arrondie au pas de strike | `shortStrikeMode: measured` |
| échéance | premier vendredi après entrée + 35 jours | `dteDays` |
| IV | vol réalisée 20 j (clôtures strictement antérieures) × 1,1 | `hvLookbackDays`, `ivMultiplier` |
| temps | séances ouvrées × 390 min via `tradingYears` | — |
| friction | 3 % du prix modèle par jambe et par traversée, plancher 0,01 $ | `frictionPct` |
| taille | 1 % de l'équité, risque = débit entier | `riskPerTradePct` |
| portefeuille | 5 positions max, 1 par sous-jacent | `maxOpenPositions` |

Le moteur simule un **portefeuille jour par jour** : entrées à l'ouverture,
sorties à la clôture, puis valorisation de toutes les positions ouvertes au prix
Black-Scholes. L'équité est donc marquée à chaque séance. Quand le carnet est
plein, la cassure au plus fort ratio de volume passe en premier.

## 4. Sorties (sur les niveaux du sous-jacent, à la clôture)

Ordre de priorité quand plusieurs se déclenchent le même jour — le stop d'abord,
une barre journalière ne disant pas quel extrême est venu en premier :

1. **stop** : clôture sous R × (1 − 2 %) — la cassure a échoué
   (`stopMode: support` : sous le support prolongé à la place) ;
2. **target** : le plus haut atteint R + H (un gap au-dessus sort à l'ouverture) ;
3. **take_profit** (spread) : valeur ≥ 80 % du profit maximal ;
4. **time_stop** : 15 séances ;
5. **dte_floor** : 7 jours calendaires avant l'échéance ;
6. **end_of_data**.

## 5. Ce que le modèle ne capture pas

- **Le smile et la structure par terme de l'IV.** Une seule vol par position,
  fixée à l'entrée : pas de hausse d'IV sur une chute, pas de baisse après une
  cassure réussie (le « vol crush » qui pénalise les calls achetés).
- **Les vrais spreads bid/ask.** 3 % du mid par jambe est une hypothèse ; sur
  les strikes loin de la monnaie et les sous-jacents chers elle est optimiste.
- **Les annonces de résultats.** Aucune exclusion autour des earnings, alors
  qu'elles provoquent une bonne part des gaps.
- **Les jours fériés** sont comptés comme séances pour le temps restant.
- **Le pas de strike** est approché (≈ 0,5 % du spot, arrondi à 0,5 / 1 / 2,5 / 5 / 10).
- **Le biais de survie de l'univers** : les 40 symboles sont les grandes
  valeurs *d'aujourd'hui*.

## 6. Résultats

Données SIP journalières Alpaca, capital 100 000 $, 1 % de risque par trade.
Toutes les variantes testées sont listées — c'est un test de robustesse, pas
une recherche du meilleur réglage. Variante D = celle qui donne le premier
échantillon exploitable ; les autres en changent un seul élément.

| | variante | trades | réussite / équilibre | R moyen | rendement | DD max | cible atteinte |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | défauts : 10 symboles, 3 ans, 3 contacts | 1 | 0 % / — | −0,55 | −0,5 % | — | 0 % |
| B | 40 symboles, 3 ans, 3 contacts | 3 | 0 % / — | −0,38 | −1,1 % | 1,2 % | 33 % |
| C | 40 symboles, 6 ans, 3 contacts | 7 | 28,6 % / 48,3 % | −0,15 | −1,1 % | 1,5 % | 43 % |
| **D** | **C avec 2 contacts** | **40** | **37,5 % / 53,7 %** | **−0,17** | **−5,9 %** | **7,0 %** | **33 %** |
| E | D, tolérance 1,5 %, fenêtre 120 j | 40 | 27,5 % / 51,5 % | −0,27 | −8,9 % | 9,0 % | 23 % |
| F | D en call nu | 33 | 39,4 % / 39,2 % | +0,06 | +0,1 % | 4,5 % | 36 % |
| G | D, stop sous le support | 40 | 40,0 % / 55,3 % | −0,16 | −5,8 % | 6,8 % | 33 % |
| H | D sans filtre de volume | 109 | 39,4 % / 42,3 % | −0,01 | −3,3 % | 6,6 % | 30 % |

Sur la même période (2020-09 → 2026-09), SPY en buy & hold : **+118 %**
(drawdown max 25,4 %). 40 symboles : grands indices (SPY, QQQ, IWM, DIA, XLF,
XLE) et 34 grandes capitalisations liquides en options.

### 6.1 Lecture

- **La définition classique est rare.** Avec 3 contacts, même 40 symboles sur
  6 ans ne donnent que 7 trades. À 10 symboles sur 3 ans : un seul. Le pattern
  « manuel » n'a pas de fréquence suffisante pour être une stratégie seule.
- **Le signal ne porte pas.** La cible du mouvement mesuré n'est atteinte que
  dans ~30-36 % des cas, quelle que soit la variante. C'est la question de la
  couche signal, et elle répond non : la cassure se prolonge rarement de toute
  la hauteur de la figure dans les 15 séances.
- **Le spread ne sauve pas un signal faible.** Avec la jambe courte sur la
  cible, le spread vaut bien moins que sa largeur quand la cible est touchée
  avec 25 jours restants : le payoff reste sous 1 (D : 0,86) et il faudrait
  54 % de réussite. Le call nu (F) a un meilleur payoff (1,55) et atteint
  l'équilibre — sans le dépasser.
- **Le filtre de volume n'ajoute rien de mesurable.** Sans lui (H), 109 trades,
  R moyen −0,01 : le même non-résultat, sur un échantillon plus grand.
- **Taille.** 11 cassures de D ne sont pas prises car un seul spread dépasse
  1 % de l'équité : les figures hautes sur les titres chers donnent des spreads
  larges. Ce n'est pas ce qui décide du résultat.

## 7. Verdict et phase 2

**No-go pour l'agent live.** Aucune des huit variantes ne montre d'avantage : la
meilleure (F) est à l'équilibre sur 33 trades, les autres perdent, et toutes
sont écrasées par la simple détention de SPY. Brancher ce signal sur l'agent
(plan « phase 2 » : trigger daily via REST, validation LLM vraie/fausse cassure,
sorties sur niveaux) reviendrait à automatiser une espérance nulle ou négative.

Ce qui pourrait changer la conclusion, dans l'ordre :

1. **Couche signal seule** : mesurer le rendement à 5/10/20 jours du
   sous-jacent après cassure, contre un échantillon de clôtures au plus haut
   de 60 jours prises au hasard. S'il n'y a pas d'excès de rendement là, aucune
   structure d'option ne le crée.
2. **Filtre de régime** (tendance de fond, ex. SPY au-dessus de sa moyenne
   200 j) et exclusion des semaines d'earnings.
3. **Sorties** : le time stop à 15 séances ferme 1/3 des trades de D ; une
   détention plus longue avec un call plus long (60-90 j) est à tester.
4. Seulement ensuite, la **validation LLM** de la cassure — qui ne peut
   qu'améliorer un signal qui a déjà un avantage, pas en créer un.

## 8. Reproduire

UI : onglet Backtest → *Ascending triangle → call* (graphique de chaque
triangle détecté, équité vs SPY, drawdown, distribution des R).

```bash
# variante D
curl -sX POST localhost:3000/api/backtest/triangle -H 'Content-Type: application/json' -d '{
  "start":"2020-09-01","end":"2026-09-04","minTouches":2,
  "underlyings":["SPY","QQQ","IWM","DIA","AAPL","MSFT","NVDA","AMZN","META","GOOGL",
    "AMD","TSLA","AVGO","NFLX","JPM","BAC","XOM","CVX","WMT","COST","HD","UNH","V","MA",
    "LLY","ORCL","CRM","ADBE","INTC","MU","QCOM","CSCO","PEP","KO","DIS","BA","CAT","GS",
    "XLF","XLE"]}'
```

Espacer les runs de 40 symboles : plusieurs à la suite dépassent la limite de
requêtes de données Alpaca (erreur SDK « The request failed and the interceptors
did not return an alternative response »).
