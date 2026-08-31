# Stratégie — Credit spreads courts sur SPY

*Spécification + résultats du backtest.*

Module : `src/server/backtest/credit-spread.ts` · Domaine :
`src/domain/backtest-credit.ts` · API : `POST /api/backtest/credit` · UI :
onglet **Backtest → Credit spreads**.

---

## 1. Définition

Vente de prime à risque défini sur SPY, échéances 1 à 2 jours, montée sous forme
d'iron condor décomposé en deux spreads verticaux indépendants : un put credit
spread et un call credit spread.

Les deux côtés sont posés, surveillés et clôturés séparément. Chaque côté peut
être coupé sans affecter l'autre, et les deux empruntent le même chemin de code.

**Variante réduite :** put credit spread seul (`sides: "put"`). Supprime la
neutralité directionnelle, conserve la génération de theta.

---

## 2. Paramètres

### 2.1 Sélection

| Paramètre | Valeur | Champ |
| --- | --- | --- |
| Sous-jacent | SPY | `underlyings` |
| DTE à l'entrée | 1-2 jours (fenêtre de recherche 1-3) | `minDte` / `maxDte` |
| Delta jambe short | 0,15 - 0,20 | `targetDelta` (0,175) |
| Largeur du spread | 5 $ | `spreadWidth` |
| Crédit minimum par côté | 0,25 $ | `minCredit` |
| Open Interest minimum | 500 | *non modélisé — voir §6* |
| Spread bid/ask maximum | 5 % du mid **ou** 0,03 $ | *non modélisé — voir §6* |

Le crédit minimum agit comme un filtre d'IV implicite : si la prime disponible à
delta cible est inférieure au seuil, aucune position n'est ouverte. Le backtest
compte ce refus dans `rejections.credit_below_min` — un refus n'est pas un bug.

### 2.2 Dimensionnement

| Paramètre | Valeur | Champ |
| --- | --- | --- |
| Positions simultanées maximum | 4 spreads (2 condors) | `maxConcurrentSpreads` |
| Buying power alloué | 12 000 $ (plafond dur) | `buyingPowerCap` |
| …et en relatif | 40 % de l'équity | `buyingPowerPctCap` |
| Risque par côté | 1 % de l'équity | `riskPerSidePct` |
| Risque cumulé du jour | 4 % de l'équity | `dailyRiskCapPct` |
| Cap de delta net | 25 % de l'équity | `maxNetDeltaPctEquity` |
| Perte maximale par spread | largeur − crédit | dérivé |

### 2.3 Sorties

| Paramètre | Valeur | Champ |
| --- | --- | --- |
| Cible de profit | rachat à 50 % du crédit | `targetProfitPct` |
| Stop | rachat ≥ 3× le crédit (§7.7) | `stopMultiple` |
| Clôture temporelle | 15:30 ET le jour de l'échéance | `closeAtEt` |
| Politique de roll | aucune | — |

---

## 3. Cycle d'exécution

### 3.1 Fenêtre de décision

**10:00 ET, une seule fois par jour** (`entryTimeEt`), après la phase de
volatilité d'ouverture, quand les spreads bid/ask sont normalisés.

### 3.2 Séquence d'entrée

Deux phases distinctes — construction puis envoi — pour que le gate ne juge
jamais une jambe isolée d'un condor en cours de montage :

1. **Construction (mémoire).** Récupérer l'échéance la plus proche dans la
   fenêtre 1-3 DTE, puis construire chaque côté demandé (short par delta cible,
   long par largeur). Contrôler crédit minimum, Open Interest et spread
   bid/ask. Un échec invalide le côté concerné uniquement ; si l'autre côté est
   valide, la structure devient un spread simple et sera re-soumise au gate avec
   son delta directionnel propre.
2. **Gate agrégé (une fois).** Calculer le delta net, le buying power et le
   risque journalier **proposés** sur la structure complète (condor ou spread
   réduit). Décision binaire : les deux ordres partent, ou aucun. Chaque refus
   produit une entrée dans `rejectionLog` (contrôle, valeur constatée, seuil,
   structure proposée).
3. **Envoi.** Ordres en limite au mid, re-pricing par pas de 0,01 $ toutes les
   5 s, abandon après 60 s (non modélisé en détail dans le backtest).
4. Enregistrer la position avec ses seuils de sortie calculés à l'entrée.

L'ancienne logique (gate par jambe, commit immédiat) est conservée dans
`runCreditBacktestLegacy` (`credit-spread-legacy.ts`) pour comparaison A/B.

### 3.3 Calendrier de la compétition

| Jour | Action |
| --- | --- |
| Lundi 31 août | Entrée — échéance mardi ou mercredi |
| Mardi 1ᵉʳ septembre | Entrée — échéance mercredi ou jeudi |
| Mercredi 2 septembre | Entrée **uniquement si l'échéance disponible est le jeudi 3** |
| Jeudi 3 septembre | Aucune entrée. Clôture uniquement |

Contrainte dure de `docs/05-hackathon-rules.md` : l'équity jugée est le snapshot
du **jeudi 3 à 20:00Z**. Aucune jambe ne doit expirer après.

---

## 4. Gestion des positions

Cycle de 60 s. Trois déclencheurs, par ordre de priorité : **stop**, **cible**,
**temps**. Le backtest applique le même ordre, et évalue le stop sur l'extrême
défavorable de la barre — une barre d'une minute ne dit pas lequel de ses deux
extrêmes est venu en premier, donc c'est le mauvais qui est supposé l'avoir été.

Le niveau du stop est le paramètre auquel le résultat est le plus sensible —
plus que `targetProfitPct`, plus que le choix des côtés. §7.7 le mesure.

### 4.1 Logique d'ordre en sortie

Sur stop, le bid/ask peut être fortement élargi : limite au mid → re-pricing par
pas de 0,01 $ toutes les 5 s → bascule au marché après 30 s. Le coût de cette
séquence est modélisé par `stopSlippagePct` (25 % du crédit au-dessus du niveau
de déclenchement).

### 4.2 Contrainte d'assignation

SPY est de style américain et physiquement livré. La clôture à 15:30 ET le jour
de l'échéance n'admet aucune exception, et l'assignation n'est pas un résultat
modélisé : le backtest sort en `time_close` (mid, avec du temps restant), jamais
en règlement.

**Filet de sécurité `expiry`.** Si la séance d'échéance se termine avant
`closeAtEt` (demi-journée NYSE, trou de barres, ou `closeAtEt` inaccessible parce
que ≥ 16:00 ET), la position est réglée à l'**intrinsèque** sur la dernière barre
disponible de cette séance, motif `expiry`. Si une position survit malgré tout
dans une séance ultérieure, le moteur force le même règlement et émet un
avertissement. Les stops et la cible ne s'appliquent qu'avant expiration
(`minutesLeft > 0`).

---

## 5. Gate de risque partagé

Appelé **une fois** sur la structure proposée, avant tout commit au book :

```
canOpen(proposedStructure) →
  spreads ouverts + proposés   ≤ maxConcurrentSpreads ?
  buying power + proposé       ≤ min(12 000 $, 40 % equity) ?
  risque du jour + proposé     ≤ 4 % equity ?
  |delta net agrégé| × spot    ≤ 25 % equity ?
  kill switch inactif ?
```

Pour un condor, `proposés` = 2 spreads ; le delta net est la somme des deux
côtés (quasi nul). Pour un spread réduit (un côté invalidé à la construction),
le gate est ré-appelé sur ce spread seul — une autorisation condor n'est jamais
héritée par une jambe isolée.

Le backtest **rogne la taille** jusqu'à la contrainte qui mord, plutôt que de
refuser sec — c'est ce que fait le gate en réel. Seul le cap de delta net refuse
au lieu de rogner. Un refus gate est **tout ou rien** : aucune jambe part si la
structure complète échoue.

Chaque refus gate alimente `rejectionLog` avec le contrôle en cause, la valeur
constatée, le seuil appliqué et la structure proposée (`condor` / `put` /
`call`). Les compteurs `rejections` restent disponibles pour les agrégats.

**Kill switch :** drawdown mark-to-market > 5 % de l'équity d'ouverture de la
séance → liquidation totale et arrêt des entrées jusqu'à la séance suivante.

---

## 6. Ce que le backtest ne modélise pas

À lire avant d'interpréter le moindre chiffre.

- **Pas de bid/ask.** Le pricing est Black-Scholes sur une IV dérivée de la vol
  réalisée. Les filtres Open Interest ≥ 500 et spread ≤ 5 % / 0,03 $ sont des
  filtres d'exécution : ils n'ont pas d'équivalent ici. `frictionPerLeg`
  (0,015 $) est le proxy — c'est le demi-spread payé à chaque traversée.
- **Pas de skew intra-spread.** Les deux jambes sont pricées à la même IV.
  En réel la jambe longue, plus loin de la monnaie, porte une IV plus élevée, ce
  qui **réduit** le crédit encaissé. Le backtest est donc optimiste sur ce point.
  `putIvPremium` ne corrige que le skew *entre côtés*, pas *dans* un spread.
- **Pas d'échéances réelles.** L'échéance est choisie parmi les séances de
  cotation présentes dans les données. SPY expire tous les jours ouvrés, donc
  l'approximation est bonne — elle ne le serait pas sur un sous-jacent à
  échéances hebdomadaires.
- **Le temps est compté en minutes de séance**, pas en temps calendaire
  (`tradingYears`). La vol réalisée est annualisée sur 252 séances ; mesurer le
  temps restant sur un calendrier de 365 jours mettrait σ et √t sur deux
  horloges différentes. Sur un week-end l'écart est d'un facteur ~1,9 en
  variance. Les deux moteurs suivent désormais cette convention — voir §9 pour
  ce que valait l'ancienne.

---

## 7. Résultats

SPY, flux SIP, 2026-05-01 → 2026-08-28, 79 séances sur 83 avec entrée,
couverture complète (aucun avertissement de troncature).

> **Les §7.1 à §7.6 ont été produites à `stopMultiple = 2`**, qui était le
> défaut jusqu'au 2026-08-31. Le défaut est maintenant **3** — voir §7.7, qui
> porte le balayage complet et les chiffres courants. Les tables ci-dessous sont
> conservées : le mécanisme qu'elles montrent (la dépendance à `ivMultiplier`,
> le coût du choc de vol, l'asymétrie put/call) reste valable, et §7.7 se lit
> contre elles. Un rejeu à froid en 2026-08-31 donne 158 spreads là où §7.1 en
> enregistrait 153-154 ; l'écart n'a pas été attribué.

### 7.1 Tout dépend de `ivMultiplier`

| IV / vol réalisée | n | hit | seuil rentabilité | payoff | P&L | max DD |
| --- | --- | --- | --- | --- | --- | --- |
| **1,00 — aucune prime** | 154 | 70,1 % | 72,8 % | 0,37 | **−842 $** | 2 457 $ |
| 1,15 | 153 | 75,8 % | 72,7 % | 0,37 | +989 $ | 1 557 $ |
| 1,30 | 154 | 79,2 % | 72,7 % | 0,38 | +2 213 $ | 1 748 $ |

Le seuil de rentabilité est **structurel et quasi constant à ~72,7 %** : une
cible à 50 % du crédit contre un stop à 2× fige le payoff autour de 0,37, donc
`1 / (1 + 0,37) ≈ 73 %`. Un taux de réussite de 75 % n'est pas une performance,
c'est le minimum syndical de la structure.

À `ivMultiplier = 1,00` — c'est-à-dire si le marché ne paie **aucune** prime de
risque de variance — la stratégie perd. C'est le comportement attendu : tout le
résultat vient de cette hypothèse, et elle n'est pas observable dans les barres
du sous-jacent. C'est un paramètre, pas une découverte.

### 7.2 Le choc de vol vaut la moitié du résultat

| iv = 1,15 | n | hit | stops | P&L | max DD |
| --- | --- | --- | --- | --- | --- |
| avec choc (0,15) | 153 | 75,8 % | 37 | +989 $ | 1 557 $ |
| **sans choc (0)** | 151 | 78,8 % | 32 | **+1 990 $** | 964 $ |

Modéliser la hausse d'IV quand le marché baisse coûte la moitié du P&L. L'effet
n'est pas celui qu'on attend : le stop à 2× le crédit est un **niveau**, donc la
perte moyenne ne grossit pas — le stop se déclenche **plus tôt, sur un mouvement
plus petit**. Sans le choc, le sous-jacent doit descendre plus bas pour que le
spread coûte 2×, et la stratégie est créditée d'une survie qu'elle n'aurait pas
eue.

### 7.3 Le côté put est celui qui perd

À `ivMultiplier = 1,00` : côté call **+412 $** (74 spreads), côté put
**−1 254 $** (75 spreads). Le côté put encaisse pourtant plus de crédit grâce au
skew. L'asymétrie classique des indices : la baisse va plus vite que la hausse.

### 7.4 Pas de stabilité hors échantillon

| Période | n | hit | seuil | P&L |
| --- | --- | --- | --- | --- |
| 2026-05-01 → 06-30 | 75 | 69,3 % | 72,4 % | **−467 $** |
| 2026-07-01 → 08-28 | 76 | 81,6 % | 73,8 % | **+1 327 $** |

Le signe s'inverse entre les deux moitiés. Quatre mois ne suffisent pas à
trancher, et le risque d'une stratégie de vente de prime est entièrement dans la
queue — un échantillon dont le drawdown maximum est de 2,5 % ne l'a pas
rencontrée.

### 7.5 Le cap de delta net (comportement legacy vs corrigé)

**Comportement legacy** (`runCreditBacktestLegacy`) — gate par jambe, commit
immédiat. Chaque côté est évalué au moment où il est ajouté, donc le premier est
contrôlé alors que le book est encore unilatéral. Le condor n'est neutre qu'une
fois les deux côtés en place :

| Risque / côté | spreads posés | refus `net_delta_cap` | qty moyenne | P&L |
| --- | --- | --- | --- | --- |
| 1 % | 153 | 5 | 2,0 | +989 $ |
| 2 % | 23 | 135 | 4,0 | +1 065 $ |
| 3 % | **0** | 158 | — | 0 $ |
| 5 % | **0** | 158 | — | 0 $ |

À `maxNetDeltaPctEquity = 0,25` la stratégie legacy est plafonnée autour de 2 %
de risque par côté et bloquée net à 3 % — c'est le cap qui décide de la taille,
pas `riskPerSidePct` ni `buyingPowerCap`.

**Comportement corrigé** (`runCreditBacktest`) — construction en mémoire, gate
agrégé unique, décision tout ou rien. Le condor complet est évalué avec son delta
net quasi nul : `riskPerSidePct` redevient le facteur limitant principal ; le cap
de delta net ne refuse que les spreads directionnels isolés (spread réduit ou
`sides: "put"` / `"call"`). Reproduire les chiffres legacy : importer
`runCreditBacktestLegacy` depuis `src/server/backtest/credit-spread-legacy.ts`.

### 7.6 Répétition sur une semaine analogue à la compétition

2026-08-24 → 08-28, `ivMultiplier = 1,15` : **8 spreads, +271 $ (+0,27 %)**,
7 cibles atteintes et 1 stop à −142 $. Taux de réussite 87,5 % contre 70,6 %
requis — une bonne semaine, la structure a parfaitement fonctionné.

Et elle rapporte 0,27 %.

---

### 7.7 Le niveau du stop — pourquoi le défaut est passé de 2× à 3×

Rejeu du 2026-08-31, SPY, SIP, 2026-05-01 → 08-28, condor, `ivMultiplier` 1,15,
158 spreads dans **chaque** ligne — le stop ne change pas les entrées, seulement
les sorties, donc les colonnes sont directement comparables.

| Stop | hit | seuil rentab. | payoff | P&L | max DD | stops |
| --- | --- | --- | --- | --- | --- | --- |
| ×1,5 | 52,5 % | 61,7 % | 0,62 | **−2 156 $** | 3 136 $ | 75 |
| ×2 *(ancien défaut)* | 74,7 % | 73,5 % | 0,36 | **+394 $** | 1 557 $ | 40 |
| ×2,5 | 84,8 % | 80,2 % | 0,25 | +2 112 $ | 1 173 $ | 23 |
| **×3 *(défaut)*** | 87,3 % | 82,9 % | 0,21 | **+2 351 $** | **1 307 $** | 19 |
| ×4 | 92,4 % | 86,6 % | 0,15 | +3 885 $ | 1 045 $ | 11 |
| ×5 | 93,0 % | 87,4 % | 0,14 | +4 017 $ | 1 024 $ | 8 |
| ×100 *(aucun stop)* | 93,0 % | 90,3 % | 0,11 | +2 510 $ | 1 718 $ | 0 |

Le drawdown maximum **baisse** en même temps que le P&L monte (1 557 → 1 307 $).
Ce n'est pas un arbitrage rendement/risque : à 2× le stop ne protège de rien, il
fabrique le drawdown.

**Le mécanisme.** Le stop est un niveau sur le **crédit**, mais le risque qu'il
protège est la **largeur**. À 0,57 $ de crédit moyen sur 5 $ de largeur, la perte
au stop vaut `crédit × (multiple − 1 + stopSlippagePct)` :

| Stop | perte au stop | …en % du risque défini (4,43 $) | trades stoppés |
| --- | --- | --- | --- |
| ×2 | 0,71 $ | **16 %** | 25,3 % |
| ×3 | 1,28 $ | **29 %** | 12,0 % |
| ×4 | 1,85 $ | 42 % | 7,0 % |

16 % du risque défini, sur un vertical short 1-2 DTE à 0,175 delta, est **à
l'intérieur du bruit gamma/vega intraday ordinaire**. Le stop se déclenche sur du
bruit et matérialise une perte que le marché rendait : à effectif constant, 21
trades stoppés à 2× finissent gagnants à 3×.

Que le stop garde de la valeur se lit sur la dernière ligne : ×100 (aucun stop)
est nettement moins bon que ×4. La question n'était jamais « faut-il un stop »,
mais « à quelle distance ».

**Robustesse.** L'ordre ×3 > ×2 tient dans **chaque** cellule testée :

| Axe | ×2 | ×3 |
| --- | --- | --- |
| `ivShockPerDownPct` 0 / 0,15 / 0,30 | +1 570 / +394 / **−1 679 $** | +3 301 / +2 351 / **+1 429 $** |
| `stopSlippagePct` 0,25 / 0,50 / 1,00 | +394 / −709 / **−2 915 $** | +2 351 / +1 824 / **+771 $** |
| `hvLookbackDays` 5 / 10 / 20 / 60 *(iv 1,00)* | −3 438 / −2 917 / −1 357 / −370 $ | −900 / −1 461 / +1 204 / +2 918 $ |
| `ivMultiplier` 1,00 / 1,15 / 1,30 | −1 357 / +394 / +1 858 $ | +1 204 / +2 351 / +4 555 $ |
| Hors échantillon, 1ʳᵉ / 2ᵉ moitié | −634 / +898 $ | −393 / +2 613 $ |
| Mensuel mai / juin / juil. / août | −244 / −315 / +114 / +1 085 $ | −165 / −333 / +1 167 / +1 637 $ |
| `sides` put seul / call seul | +194 / +400 $ | +776 / +915 $ |

La ligne `stopSlippagePct` est la plus utile : **×2 est fragile aux frictions,
×3 ne l'est pas.** À slippage 100 % du crédit, le stop ×2 fait perdre 2 915 $ —
il part si souvent que le coût de sortie *devient* la stratégie. C'est le risque
réel et pas une hypothèse d'école : sur un stop, le bid/ask s'élargit, et les
25 % du défaut sont optimistes.

**Pourquoi pas ×4 ou ×5.** Ils testent mieux, partout, y compris en drawdown.
Le défaut reste ×3 par choix explicite : le gain marginal au-delà de ×3 s'achète
en pertes plus rares et plus grosses, c'est-à-dire dans la queue — précisément ce
qu'un échantillon de quatre mois dont le drawdown maximum vaut 2,5 % n'a jamais
rencontré. §7.4 vaut toujours : le signe s'inverse entre les deux moitiés, à ×3
comme à ×2. Un arbitrage, pas un optimum ; `stopMultiple` reste un paramètre.

**Ce que ce balayage invalide au passage.** La ligne `hvLookbackDays` interdit de
lire la rentabilité à `ivMultiplier = 1,00` (§7.1) comme une preuve d'edge sans
prime de variance : à stop ×3 elle va de −900 $ (lookback 5) à +2 918 $
(lookback 60). C'est un artefact du régime de vol décroissante de mai-août 2026 —
vendre sur une HV glissante longue dans une vol qui baisse rapporte
mécaniquement. Pas une découverte.

**Semaine analogue à la compétition** (2026-08-24 → 08-28, 8 spreads) :

| Stop | hit | stops | P&L |
| --- | --- | --- | --- |
| ×2 | 87,5 % | 1 | +271 $ (+0,27 %) |
| ×3 | 100 % | 0 | +469 $ (+0,47 %) |

Ce qui ne change pas le §8 : sur quatre séances et huit spreads, le niveau du
stop est noyé dans la variance. Ce qui décide du classement est le
dimensionnement, pas la sortie.

---

## 8. Verdict opérationnel

La stratégie est **saine mais sans levier utile sur quatre jours**.

Ce qui joue pour elle : un fondement économique réel (on est payé pour porter du
risque de variance), un risque défini par construction, une exposition
directionnelle proche de zéro, et un drawdown maximum de 2,5 % sur quatre mois.
C'est nettement plus solide que l'ORB → vertical débit, qui perd sur les deux
moitiés de l'échantillon une fois pricé correctement (§9).

Ce qui joue contre elle, pour **ce** concours : au dimensionnement spécifié elle
produit ~0,5 % sur la semaine (0,3 % avant le passage du stop à 3×, §7.7), ce qui
ne classe pas. Pour peser il faudrait
10 à 20× la taille — donc relever le cap de delta net, `riskPerSidePct` au-delà
de 3 % et `buyingPowerCap` bien au-dessus de 12 000 $. À ce niveau, avec un
seuil de rentabilité à 83 % et un payoff de 0,21 (les valeurs au stop ×3 : le
stop plus large rend les pertes plus rares **et** plus grosses), une mauvaise
semaine coûte 5 à 10 % de l'équity, et c'est précisément la queue que quatre mois
d'échantillon n'ont pas testée.

Le choix — sécurité ou classement — est un arbitrage explicite, pas une question
technique.

---

## 9. Annexe — le correctif d'horloge du 2026-08-30

`engine.ts` (ORB) mesurait le temps restant en **calendaire** (`yearsBetween`,
365 jours) alors que la vol réalisée est annualisée sur **252 séances**. Sur une
séance de 6h30 : `t` calendaire = 6,85 × 10⁻⁴ an, `t` de séance = 3,66 × 10⁻³ an.
Facteur **5,3 sur `t`**, donc **2,3 sur σ√t**.

A/B à paramètres identiques (SPY + QQQ, SIP, 2026-05-01 → 08-28) :

| Config | | n | hit | seuil | payoff | P&L | débit méd. |
| --- | --- | --- | --- | --- | --- | --- | --- |
| largeur 3 | calendaire | 117 | 39,3 % | 34,5 % | 1,90 | **+12 650** | 0,86 |
| largeur 3 | séance *(corrigé)* | 117 | 35,0 % | **52,4 %** | 0,91 | **−19 472** | 1,15 |
| range | calendaire | 115 | 45,2 % | 32,1 % | 2,11 | **+44 974** | 0,85 |
| range | séance *(corrigé)* | 116 | 36,2 % | **49,3 %** | 1,03 | **−15 454** | 1,24 |

Mécanisme : le débit monte de 34 à 46 %. La perte max **est** le débit, le gain
max est `largeur − débit` — les deux bougent dans le mauvais sens en même temps,
le payoff est divisé par deux et le seuil de rentabilité passe de ~33 % à ~50 %,
pendant que le taux de réussite baisse. Le strike « 0,45 delta » était par
ailleurs placé à la moitié de sa vraie distance du spot (|K−S| 0,47 → 0,94).

Split hors échantillon après correction, largeur 3 :

| Période | n | hit | seuil | P&L |
| --- | --- | --- | --- | --- |
| 2026-05-01 → 06-30 | 62 | 48,4 % | 52,9 % | **−2 969** |
| 2026-07-01 → 08-28 | 55 | 20,0 % | 56,9 % | **−16 778** |

Négatif sur les deux moitiés. Tout résultat ORB antérieur au 2026-08-30 était
gonflé en faveur de la stratégie.

### Second correctif : `daysToExpiration`

`src/config/competition.ts` comparait `now` à **minuit UTC** de la date
d'échéance — soit 20:00 ET la veille. En séance, chaque DTE était donc décalé
d'un jour : lundi 10:00 ET, l'échéance du jour renvoyait **−1** et celle du
lendemain **0**.

Conséquence : `pickExpiration` (`select-contract.ts`) filtrant sur `minDte: 0`
sélectionnait l'échéance du **lendemain**, jamais celle du jour — la stratégie
ORB, explicitement 0DTE, n'aurait pas tradé en 0DTE. La deadline restait
néanmoins protégée : `clampDteWindow` passait par la même fonction décalée, donc
l'erreur s'annulait, et `isExpirationWithinWindow` compare des chaînes.

Le DTE se lit désormais sur le calendrier US/Eastern (`easternDate`) : date à
date, pas instant à minuit UTC.

**Effet sur cette stratégie.** Le moteur crédit utilisait `tradingYears` dès le
départ, donc le premier correctif ne le concernait pas. Le second, si : le
backtest comptait le DTE date à date (lundi → mardi = 1) pendant que la
production l'aurait compté 0. Une fenêtre `minDte: 1, maxDte: 3` testait 1-3
jours et aurait exécuté 2-4. Les deux comptent désormais pareil, via une
définition unique — `daysBetweenDates` dans `config/competition.ts`, consommée
par `daysToExpiration` (production) et par le moteur crédit (backtest). Un test
verrouille l'accord sur les enregistrements de trades eux-mêmes
(`credit-spread.test.ts`, « counts DTE the way production does ») : il échoue si
l'une des deux horloges bouge.
