# 10 — Workflow git à deux

> **Politique d'équipe, contraignante.** Deux développeurs, chacun avec son agent
> (Claude Code, Codex, Cursor), travaillent en parallèle sur ce repo. Ce fichier est
> chargé par les workflows BMAD (overrides d'équipe dans `_bmad/custom/`) et résumé
> dans `AGENTS.md`. Il se modifie par PR, comme le code.

Cette politique vaut **autorisation permanente pour exactement trois choses** : créer
sa branche, committer dessus, la pousser. Tout le reste qui écrit sur le remote ou
détruit du travail local passe par l'humain.

## §1 Modèle

- **`main` est le tronc.** Personne ne committe ni ne pousse dessus directement : tout
  y arrive par une PR squash-mergée par un humain.
- **Une branche courte par spec ou story**, nommée `<prefix>/<type>/<slug>` :
  - `prefix` — premier mot de `git config user.name`, en minuscules, sans accent :

    ```sh
    prefix=$(git config user.name | awk '{print tolower($1)}' | iconv -f UTF-8 -t ASCII//TRANSLIT | tr -cd 'a-z0-9-')
    ```

    Les deux développeurs doivent donc avoir des prénoms différents dans `user.name`.
  - `type` — `feat` | `fix` | `chore` | `docs` | `refactor` | `test` | `research`.
  - `slug` — celui de la spec BMAD (`_bmad-output/implementation-artifacts/spec-<slug>.md`),
    précédé de la clé de story s'il y en a une : `ethan/feat/3-2-digest-delivery`.
  - 1 spec ↔ 1 branche ↔ 1 PR.
- **Une branche mergée est morte** : plus aucun commit dessus. Nouvelle tâche =
  nouvelle branche.

## §2 Preflight — au début de chaque tâche et de chaque session

1. `git fetch --prune origin`
2. `git status --porcelain` doit être vide. Sinon **STOP et demander** : ne jamais
   stasher, reset ou jeter le travail en cours de l'humain.
3. Qui travaille sur quoi :

   ```sh
   git for-each-ref --format='%(refname:lstrip=3)' refs/remotes/origin | grep -v -e '^HEAD$' -e '^main$'
   ```

4. **Slug déjà pris** — une branche d'un autre `prefix` se termine par `/<slug>` :
   **STOP**, le collègue est dessus. Le dire à l'humain.
5. **Chevauchement** — pour chaque branche du collègue,
   `git diff --name-only origin/main...origin/<sa-branche>`. Si elle touche des fichiers
   qu'on va modifier, prévenir l'humain avant de commencer (se coordonner, ou attendre
   son merge).
6. **Nouvelle tâche** :

   ```sh
   git switch -c "$prefix/<type>/<slug>" origin/main
   git push -u origin HEAD   # la branche distante = la réservation visible par le collègue
   ```

   **Reprise** : `git switch <sa-branche> && git rebase origin/main`.

## §3 Propriété

- On ne committe, ne rebase, ne pousse et ne supprime **que les branches qui portent son
  propre `prefix`**.
- La branche du collègue est en lecture seule : `git log`, `git diff`,
  `git switch --detach origin/<sa-branche>` pour tester.
- Construire sur son travail pas encore mergé : brancher depuis sa branche
  (`git switch -c "$prefix/feat/<slug>" origin/<sa-branche>`) et le dire à l'humain.
  Après son squash merge, rejouer uniquement ses propres commits :
  `git rebase --onto origin/main <base>`, où `<base>` est le commit de départ
  (`git merge-base HEAD origin/<sa-branche>`, à noter tant que sa branche existe).

## §4 Pendant le travail

- Commits petits et conventionnels : `feat(backtest): …`, `fix(agent): …`, `docs: …`.
- **Stager des chemins explicites** — `git add <chemin>…`. Jamais `git add -A`,
  `git add .` ni `git commit -a`. Relire `git diff --cached --stat` avant de committer.
  Jamais `.env*`, `.agent/`, `*.log` ni aucun secret.
- Rebaser sur `origin/main` en début de session et avant la PR :
  `git fetch origin && git rebase origin/main`. Pas de merge de `main` dans sa branche.
- **Conflit de rebase** : le résoudre seulement s'il porte sur des fichiers que la
  branche a modifiés et que l'intention des deux côtés est claire, puis relancer les
  tests. Sinon `git rebase --abort` et **STOP** : montrer les fichiers en conflit à
  l'humain.
- Après un rebase, pousser avec `git push --force-with-lease`. Jamais `--force`, `-f`
  ni `+refspec`.

## §5 Handoff — fin de tâche

1. `git fetch origin && git rebase origin/main`
2. `pnpm test && pnpm lint && pnpm build` : tout vert, sinon pas de PR.
3. `git push -u origin HEAD` (`--force-with-lease` si la branche a été rebasée).
4. Ouvrir la PR : `gh pr create --base main --fill` si `gh` est installé, sinon afficher
   `https://github.com/ethan1384/alpaca-hackathon-trading-agent/compare/main...<branche>?expand=1`.
   - Titre = message de commit conventionnel : il devient le commit squash sur `main`.
   - Corps = lien vers la spec, ce qui change, résultat des vérifications, fichiers
     partagés touchés (§7).
5. **L'agent ne merge pas.** Un humain squash-merge, idéalement après relecture de
   l'autre (`bmad-code-review` sur `git diff origin/main...origin/<branche>`).

## §6 Après le merge

Avec un squash merge, les commits de la branche ne sont pas des ancêtres de `main` :
`git branch -d` refuse de la supprimer, c'est normal.

1. Vérifier sur GitHub que la PR est mergée.
2. `git switch main && git pull --ff-only`
3. `git branch -D <sa-branche>` (le hook demande confirmation à l'humain).
4. Branche distante : activer *Automatically delete head branches* dans les réglages
   GitHub ; sinon `git push origin --delete <sa-branche>` (sa branche uniquement).
   Puis `git fetch --prune`.

## §7 Fichiers BMAD et fichiers communs

| Fichier | Règle |
| --- | --- |
| `_bmad-output/implementation-artifacts/spec-<slug>.md` | Appartient à l'auteur de la branche : committé dessus, mergé avec la PR. |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | Partagé. Ne modifier que la ligne de sa propre story. En conflit : garder les lignes des deux côtés, et pour chaque story le statut le plus avancé. |
| `_bmad-output/implementation-artifacts/deferred-work.md` | Ajout en fin de fichier seulement. `merge=union` (`.gitattributes`) garde les deux côtés sans conflit. |
| `_bmad-output/implementation-artifacts/epic-<N>-context.md` | Généré et régénérable : en conflit, prendre `origin/main` puis régénérer. |
| `_bmad-output/planning-artifacts/*` (PRD, architecture, epics) | Partagés : modifier sur sa branche, PR dédiée, prévenir l'autre. |
| `_bmad/custom/*.toml` | Politique d'équipe : PR uniquement. |
| `_bmad/custom/*.user.toml` | Personnel, ignoré par git. |
| `AGENTS.md`, `docs/05-legacy-competition.md`, ce fichier, `.claude/settings.json`, `.claude/hooks/` | Règles communes : PR dédiée, relue par l'autre. |

## §8 Interdits

Dans Claude Code, `.claude/hooks/git-guard.mjs` (hook `PreToolUse` sur `Bash`) applique
deux niveaux :

**Refusé** — casse le travail de l'autre :

- commit sur `main` ; push vers `main` (`main`, `HEAD:main`, `git push` nu depuis
  `main`), `--all`, `--mirror` ;
- `--force`, `-f`, `+refspec` (seul `--force-with-lease` sur sa branche est permis) ;
- pousser ou supprimer une branche qui ne porte pas son `prefix` ;
- `--no-verify`.

**Confirmation humaine** — détruit du travail local :

- `reset --hard`, `clean -f`, `checkout -- <chemin>` / `checkout .`,
  `restore <chemin>` (sauf `--staged` seul), `switch --discard-changes`,
  `stash drop|clear`, `branch -D|-M|-f`.

Un tag se pousse par `refs/tags/<nom>` ou `--tags`.

Le hook ne voit que les commandes de Claude Code. **Codex et Cursor n'ont que ce fichier
et `AGENTS.md`** : ces règles s'y appliquent à la main. Complément côté serveur, que seul
le propriétaire du repo peut activer sur GitHub : protection de `main` (PR obligatoire,
pas de force push), squash merge seul, suppression automatique des branches mergées.
