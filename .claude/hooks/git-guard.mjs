#!/usr/bin/env node
// PreToolUse hook (Bash) — enforces docs/10-git-workflow.md §8 for Claude Code.
// Commands that break the colleague's work (push to main, force push, pushing or
// deleting another prefix's branch, committing on main, --no-verify) are denied;
// commands that destroy local work (reset --hard, clean -f, …) ask the human.
// Codex and Cursor only have AGENTS.md — keep the two in sync.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TRUNKS = new Set(["main", "master"]);
const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);
const TOKEN =
  /"(?:\\.|[^"\\])*"|'[^']*'|\d*[<>]{1,2}&\d+|\d*[<>]{1,2}|\n|&&|\|\||[;|&]|[^\s"';|&<>]+/g;
const LAUNCHER = /^(?:[A-Za-z_]\w*=\S*|rtk|proxy|env|command|exec|time|nohup|sudo)$/;
const GIT_GLOBALS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const PUSH_OPTS_WITH_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

const deny = (reason) => ({ decision: "deny", reason });
const ask = (reason) => ({ decision: "ask", reason });
const has = (args, ...names) => args.some((a) => names.includes(a));
const hasShortFlag = (args, letter) =>
  args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));

function git(args, cwd) {
  try {
    const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    return execFileSync("git", args, opts).trim();
  } catch {
    return "";
  }
}

/** First word of `git config user.name`, lowercased, accents stripped — docs/10 §1. */
function branchPrefix(cwd) {
  const first = git(["config", "user.name"], cwd).split(/\s+/)[0] ?? "";
  return first
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
}

/** Shell command → list of word lists, one per simple command; redirections dropped. */
function segments(command) {
  const tokens = command.match(TOKEN) ?? [];
  const result = [[]];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (SEPARATORS.has(token)) result.push([]);
    else if (/^\d*[<>]/.test(token)) i += token.includes("&") ? 0 : 1;
    else result.at(-1).push(/^["']/.test(token) ? token.slice(1, -1) : token);
  }
  return result;
}

/** `[subcommand, ...args]` when the words run git, else null. */
function gitArgs(words) {
  let i = 0;
  while (i < words.length && words[i] !== "git") {
    if (!LAUNCHER.test(words[i])) return null;
    i++;
  }
  if (i === words.length) return null;
  i++;
  while (i < words.length && words[i].startsWith("-")) {
    i += GIT_GLOBALS_WITH_VALUE.has(words[i]) ? 2 : 1;
  }
  return words.slice(i);
}

function checkBranch(name, prefix, action) {
  if (TRUNKS.has(name)) {
    return deny(`never ${action} ${name} — it only changes through a squash-merged PR (§1, §5).`);
  }
  if (!prefix) return deny("cannot tell whose branch this is: set `git config user.name` (§1).");
  if (!name.startsWith(`${prefix}/`)) {
    return deny(`\`${name}\` is not one of your ${prefix}/… branches — never ${action} it (§3).`);
  }
  return null;
}

function checkPush(args, { branch, prefix }) {
  if (has(args, "--force") || hasShortFlag(args, "f")) {
    return deny("force push can overwrite a colleague's work — use --force-with-lease (§4).");
  }
  if (has(args, "--all", "--mirror"))
    return deny("push one branch at a time, never --all/--mirror.");
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (PUSH_OPTS_WITH_VALUE.has(args[i])) i++;
    else if (!args[i].startsWith("-")) positional.push(args[i]);
  }
  const deleting = has(args, "--delete", "-d");
  const refspecs = positional.slice(1);
  if (refspecs.length === 0)
    return has(args, "--tags") ? null : checkBranch(branch, prefix, "push");
  for (const spec of refspecs) {
    if (spec.startsWith("+"))
      return deny("a +refspec is a force push — use --force-with-lease (§4).");
    if (spec.startsWith("refs/tags/")) continue;
    const removes = deleting || spec.startsWith(":");
    const dst = removes ? spec.replace(/^:/, "") : (spec.split(":")[1] ?? spec);
    const name = (dst === "HEAD" ? branch : dst).replace(/^refs\/heads\//, "");
    const verdict = checkBranch(name, prefix, removes ? "delete" : "push to");
    if (verdict) return verdict;
  }
  return null;
}

function check([sub, ...args], ctx) {
  if (has(args, "--no-verify")) return deny("--no-verify skips the hooks the team relies on (§8).");
  switch (sub) {
    case "push":
      return checkPush(args, ctx);
    case "commit":
      return TRUNKS.has(ctx.branch)
        ? deny(`no commits on ${ctx.branch} — work on a ${ctx.prefix}/<type>/<slug> branch (§1).`)
        : null;
    case "reset":
      return has(args, "--hard") ? ask("git reset --hard discards uncommitted work.") : null;
    case "clean":
      return has(args, "--force") || hasShortFlag(args, "f")
        ? ask("git clean -f deletes untracked files.")
        : null;
    case "checkout":
      return has(args, "--", ".", "--force") || hasShortFlag(args, "f")
        ? ask("this checkout discards working-tree changes.")
        : null;
    case "switch":
      return has(args, "--discard-changes", "--force") || hasShortFlag(args, "f")
        ? ask("this switch discards working-tree changes.")
        : null;
    case "restore":
      return has(args, "--staged", "-S") && !has(args, "--worktree", "-W")
        ? null
        : ask("git restore discards working-tree changes.");
    case "stash":
      return has(args, "drop", "clear") ? ask("git stash drop/clear loses stashed work.") : null;
    case "branch":
      return has(args, "-D", "-M", "--force") || hasShortFlag(args, "f")
        ? ask("this branch command force-deletes or overwrites a branch.")
        : null;
    default:
      return null;
  }
}

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const command = input.tool_input?.command ?? "";
if (/\bgit\b/.test(command)) {
  const cwd = input.cwd || process.cwd();
  const ctx = {
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    prefix: branchPrefix(cwd),
  };
  const verdicts = segments(command)
    .map(gitArgs)
    .filter(Boolean)
    .map((args) => check(args, ctx))
    .filter(Boolean);
  const verdict = verdicts.find((v) => v.decision === "deny") ?? verdicts[0];
  if (verdict) {
    const output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: verdict.decision,
        permissionDecisionReason: `git-guard (docs/10-git-workflow.md): ${verdict.reason}`,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
}
