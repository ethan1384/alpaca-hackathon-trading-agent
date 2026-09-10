# Stratégie — Cassure de triangle ascendant → call (triggers 30 min, détention swing)

*Spécification, modèle et résultats du backtest.*

Signal : `src/server/backtest/triangle.ts` · Moteur :
`src/server/backtest/triangle-engine.ts` · Domaine :
`src/domain/backtest-triangle.ts` · API : `POST /api/backtest/triangle` · UI :
onglet **Backtest → Ascending triangle → call**.

Remplace, comme piste de recherche, le put credit spread archivé (tag git
`archive/credit-spread-agent`, docs/07–08). L'agent live n'est **pas** basculé :
voir §7. Travail **post-événement** (2026-09-10, après le snapshot jugé du
jeudi 2026-09-03) : il n'a joué aucun rôle dans le run de compétition et n'a
passé aucun ordre.

Deux tailles de bougie, un seul moteur : `timeframe: "30Min"` (défaut) détecte
la figure et déclenche l'entrée sur les bougies de 30 minutes ;
`timeframe: "1Day"` garde la première étude journalière, qu'il reproduit au
trade près (§6.2). L'horizon reste swing dans les deux cas : l'option vit 30 à
45 jours, la position quelques jours à quelques semaines.

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

**Bougies.** Seules les bougies de la séance régulière entrent dans la
détection, les entrées et les sorties : ouverture de la bougie entre 09:30 et
16:00 ET (15:30 est la dernière). Le flux `30Min` d'Alpaca renvoie aussi les
bougies de 08:00-09:00 et de 16:00 et après (vérifié le 2026-09-10) ; elles sont
écartées avant tout calcul. Le détecteur travaille en index de bougie : la nuit
n'existe pas pour lui, la bougie de 09:30 suit directement celle de 15:30.

Pour chaque bougie *j* :

1. **Pivots hauts.** Une bougie est un pivot haut si son plus haut domine
   `pivotStrength` (3) bougies de chaque côté. Il n'est **connu que 3 bougies
   après** : en *j*, seuls les pivots confirmés au plus tard en *j−1* sont
   utilisés. C'est la garantie anti-lookahead ; un test vérifie que le détecteur
   rend la même cassure sur la série tronquée à la bougie de cassure.
2. **Couvercle.** Sur les `lookbackBars` dernières bougies, R = plus haut des
   pivots hauts. Il faut au moins `minTouches` (3) pivots à moins de
   `touchTolerancePct` sous R. La fenêtre de pivots glisse avec deux pointeurs
   (ses deux bornes n'avancent qu'avec *j*) : une bougie coûte les pivots de sa
   fenêtre, pas tous ceux de la série — ~20 000 bougies par symbole en 30 min.
   Un test compare le résultat, bougie par bougie, à un balayage complet.
3. **Sous le couvercle depuis le premier contact.** Aucune clôture au-dessus du
   seuil de cassure ni aucun plus haut au-delà de la tolérance entre le premier
   contact et *j−1* : la bougie *j* est la *première* clôture à travers.
4. **Creux strictement ascendants.** Un creux par oscillation : le plus bas
   entre deux contacts consécutifs, plus le dernier resserrement avant la
   cassure. Chacun doit être **strictement plus haut** que le précédent, et la
   pente de régression d'au moins `minSlopePctPerBar` du prix par bougie — ce
   qui écarte les rectangles plats.
   *Historique :* une première version prenait tous les pivots bas avec une
   simple pente de régression positive. Sur données réelles elle acceptait un V
   (SPY 2024 : 537 → 510 → 539, le creux d'août) et un support qui s'affaissait
   en fin de figure (SPY 2026). Un test (`V_FLOOR`) verrouille la correction.
5. **Géométrie.** Hauteur H = R − premier creux, au moins `minHeightPct` de R.
   Le support prolongé doit rester sous R en *j* (apex non dépassé).
6. **Cassure.** Clôture > R × (1 + `breakoutBufferPct`) et volume relatif ≥
   `volumeMultiple` (1,2). **Volume relatif = volume de la bougie / moyenne du
   même créneau ET sur les `volumeLookbackSessions` (20) séances précédentes** :
   la bougie de 15:30 fait ~8× celle de midi un jour ordinaire, une moyenne
   glissante toutes bougies confondues validerait donc presque toute cassure de
   fin de séance. En `1Day` le créneau est unique et c'est la moyenne des 20
   jours précédents, comme dans la première étude. Une cassure sur volume faible
   est comptée à part (`rejectedVolume`) et n'est pas retentée.
   `cooldownBars` par symbole ensuite.

### 2.1 Calibration par timeframe

Une seule source : `TRIANGLE_TIMEFRAME_DEFAULTS` (`src/domain/backtest-triangle.ts`),
appliquée par le `transform` du schéma à tout paramètre omis. **Une valeur
explicite l'emporte toujours** ; `params` dans la réponse renvoie les valeurs
résolues. La colonne `1Day` est celle de la première étude, inchangée : avec
ses défauts, `timeframe: "1Day"` redonne la variante D au trade près (§6.2).
Toute modification du moteur doit préserver cette équivalence — c'est le test
de non-régression du passage en 30 min.

| paramètre | `1Day` | `30Min` | règle |
| --- | ---: | ---: | --- |
| `lookbackBars` | 60 | 130 | 10 séances de 13 bougies |
| `minPatternBars` | 15 | 26 | 2 séances |
| `cooldownBars` | 10 | 13 | 1 séance |
| `touchTolerancePct` | 1 % | 0,4 % | × 0,41 |
| `minHeightPct` | 3 % | 1,2 % | × 0,41 |
| `breakoutBufferPct` | 0,2 % | 0,08 % | × 0,41 |
| `stopBufferPct` | 2 % | 0,8 % | × 0,41 |
| `minSlopePctPerBar` | 0,05 % | 0,01 % | × 0,41 × 60/130 |

Les valeurs `30Min` sont dérivées, pas optimisées : une fenêtre de 10 séances
contre 60, et sur une marche aléatoire la taille naturelle d'une figure varie
comme la racine de sa durée — √(10/60) ≈ 0,41. La pente par bougie est la
hauteur réduite étalée sur 130 bougies au lieu de 60. `pivotStrength` (3),
`minTouches` (3), `minLowPivots` (2), `volumeMultiple` (1,2) et
`volumeLookbackSessions` (20) sont communs ; en 30 min un pivot est donc
confirmé 1 h 30 après son sommet.

## 3. Structure et exécution simulée (couche structure)

| | valeur | paramètre |
| --- | --- | --- |
| entrée | **ouverture de la bougie régulière suivant la cassure** — 09:30 du lendemain si la cassure est la bougie de 15:30 (gap inclus) | — |
| jambe longue | call à delta 0,45 | `targetDelta` |
| jambe courte (spread) | sur la cible R + H, arrondie au pas de strike | `shortStrikeMode: measured` |
| échéance | premier vendredi après entrée + 35 jours | `dteDays` |
| IV | vol réalisée 20 séances (clôtures de séance strictement antérieures) × 1,1 | `hvLookbackDays`, `ivMultiplier` |
| temps | minutes restantes de la séance + 390 × séances restantes jusqu'à l'échéance, via `tradingYears` — jamais `yearsBetween` | — |
| friction | 3 % du prix modèle par jambe et par traversée, plancher 0,01 $ | `frictionPct` |
| taille | 1 % de l'équité, risque = débit entier | `riskPerTradePct` |
| portefeuille | 5 positions max, 1 par sous-jacent | `maxOpenPositions` |

Le moteur simule un **portefeuille séance par séance, bougie par bougie** : à
chaque bougie, les entrées à l'ouverture, puis le marquage Black-Scholes et les
sorties à la clôture ; à la clôture de séance, la valorisation de toutes les
positions ouvertes, un point d'équité par séance. Quand plusieurs cassures
arrivent sur la même bougie et que le carnet ne peut pas toutes les prendre, la
plus forte en volume relatif passe en premier.

Les **clôtures de séance** (IV, benchmark SPY, points d'équité) sont celles de
la dernière bougie régulière — en 30 min, la clôture de la bougie 15:30-16:00.
Pour une entrée à 11:30 un lundi et une échéance le vendredi, `t` = 270 +
4 × 390 minutes de bourse ; à 09:30 c'est exactement séances × 390, ce que
faisait le moteur journalier.

**Données.** Une seule taille de bougie par symbole ; 200 jours calendaires
d'historique avant `start` amorcent figures, volume et vol. La limite de
données d'Alpaca (200 requêtes par minute en offre gratuite, comptées par page)
dicte la récupération — un premier run de 40 symboles × 6 ans a échoué sur
« too many requests », chaque nouvel essai tombant dans la même minute :

- en `30Min`, l'historique est demandé par tranches de 365 jours : une année
  fait au plus 8 064 bougies (04:00–20:00 ET), sous la page de 10 000, donc un
  appel = une requête. En `1Day`, un seul appel, comme la première étude ;
- un cadenceur partagé espace les requêtes pour rester sous 180 par minute,
  2 symboles à la fois (~290 requêtes, ~1 min 40 pour 41 symboles × 6,5 ans) ;
- chaque requête passe par `withRetry` (4 tentatives). Sur un 429, ou une erreur
  sans statut HTTP (ce que renvoie le SDK quand la limite coupe la connexion),
  l'attente va jusqu'à `X-RateLimit-Reset`, jamais moins de 61 s ; toute autre
  erreur réessayable garde le backoff court 3 / 6 / 12 s.

Échec final : HTTP 500 avec le symbole en tête du message.

## 4. Sorties (sur les niveaux du sous-jacent)

| sortie | testée | niveau |
| --- | --- | --- |
| **stop** | clôture de séance (`stopCheck: session_close`, défaut) ou clôture de chaque bougie (`bar_close`) | clôture sous R × (1 − `stopBufferPct`) — la cassure a échoué (`stopMode: support` : sous le support prolongé à la place) |
| **target** | plus haut de chaque bougie | R + H ; un gap au-dessus sort à l'ouverture de la bougie |
| **take_profit** (spread) | clôture de chaque bougie | valeur ≥ 80 % du profit maximal |
| **time_stop** | clôture de séance | 15 séances, séance d'entrée comprise |
| **dte_floor** | clôture de séance | 7 jours calendaires avant l'échéance |
| **end_of_data** | dernière séance | — |

Sur la bougie où stop et cible sont testés ensemble, le stop passe d'abord :
une bougie ne dit pas quel extrême est venu en premier. En `1Day` chaque bougie
est la dernière de sa séance, c'est l'ordre stop-avant-cible de la première
étude. Le stop à la clôture de séance est le défaut parce que la détention est
swing : une bougie de 30 min sous le couvercle n'invalide pas une cassure qui
se referme au-dessus le soir même.

## 5. Ce que le modèle ne capture pas

- **Le smile et la structure par terme de l'IV.** Une seule vol par position,
  fixée à l'entrée : pas de hausse d'IV sur une chute, pas de baisse après une
  cassure réussie (le « vol crush » qui pénalise les calls achetés).
- **Les vrais spreads bid/ask.** 3 % du mid par jambe est une hypothèse ; sur
  les strikes loin de la monnaie et les sous-jacents chers elle est optimiste.
- **Les annonces de résultats.** Aucune exclusion autour des earnings, alors
  qu'elles provoquent une bonne part des gaps.
- **Les jours fériés** sont comptés comme séances pour le temps restant ; les
  **demi-séances** (clôture 13:00) comme des séances pleines, et leur dernière
  bougie (12:30) est comparée au volume ordinaire de 12:30 — un volume de
  clôture anticipée peut y passer pour une confirmation.
- **La clôture de séance** est celle de la dernière bougie de 30 min, pas le
  prix d'enchère de clôture.
- **La sortie à la cible** se fait au niveau exact dans la bougie qui le
  touche, sans glissement.
- **Le pas de strike** est approché (≈ 0,5 % du spot, arrondi à 0,5 / 1 / 2,5 / 5 / 10).
- **Le biais de survie de l'univers** : les 40 symboles sont les grandes
  valeurs *d'aujourd'hui*.

## 6. Résultats

Données SIP Alpaca, capital 100 000 $, 1 % de risque par trade. Toutes les
variantes testées sont listées — c'est un test de robustesse, pas une
recherche du meilleur réglage ; chacune change un seul élément de sa référence.

<!-- 6.1 filled from the 30Min grid -->

### 6.2 Référence journalière (première étude)

Les huit variantes de la première étude, sur bougies journalières. **Relancée
après le passage en 30 min avec `timeframe: "1Day"`, la variante D redonne
40 trades et −5,93 %, avec la même liste de trades et la même courbe d'équité
que le run d'origine** (vérifié le 2026-09-10) : le moteur intraday n'a rien
changé au cas journalier.

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

Ce que la première étude a établi : la définition à 3 contacts est rare (1 à
7 trades) ; la cible du mouvement mesuré n'est atteinte que dans ~30-36 % des
cas ; avec la jambe courte sur la cible, le payoff reste sous 1 (D : 0,86) et il
faudrait 54 % de réussite ; le call nu (F, payoff 1,55) atteint l'équilibre sans
le dépasser ; sans filtre de volume (H), 109 trades et le même non-résultat.

## 7. Verdict et suite

<!-- filled from the 30Min grid -->

## 8. Reproduire

UI : onglet Backtest → *Ascending triangle → call* : sélecteur *Trigger bars*
(30 min / Daily), *Stop tested on* (Session close / Every bar), champs « auto »
qui affichent la valeur résolue pour la taille de bougie ; graphique de chaque
triangle en bougies de 30 min, équité vs SPY, drawdown, distribution des R.

```bash
# défaut : 10 symboles, 3 ans, bougies 30 min
curl -sX POST localhost:3000/api/backtest/triangle -H 'Content-Type: application/json' \
  -d '{"start":"2023-09-01","end":"2026-09-04"}'

# variante I : 40 symboles, 6 ans, 30 min
curl -sX POST localhost:3000/api/backtest/triangle -H 'Content-Type: application/json' -d '{
  "start":"2020-09-01","end":"2026-09-04",
  "underlyings":["SPY","QQQ","IWM","DIA","AAPL","MSFT","NVDA","AMZN","META","GOOGL",
    "AMD","TSLA","AVGO","NFLX","JPM","BAC","XOM","CVX","WMT","COST","HD","UNH","V","MA",
    "LLY","ORCL","CRM","ADBE","INTC","MU","QCOM","CSCO","PEP","KO","DIS","BA","CAT","GS",
    "XLF","XLE"]}'

# référence journalière, variante D : même corps + "timeframe":"1Day","minTouches":2
```

Un run de 40 symboles × 6 ans en 30 min fait ~290 requêtes, cadencées sous 180
par minute (§3). Le cadenceur est propre à chaque run : **un run à la fois**,
espacés d'au moins 60 s — deux runs simultanés doublent le débit et retombent
sur « too many requests ». Le client doit attendre la réponse : `curl -m 3600`
convient, pas le `fetch` de Node, qui abandonne après 300 s sans en-têtes —
et la route continue alors de calculer (et de solliciter l'API) sans personne
pour lire le résultat.
