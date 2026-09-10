#!/bin/sh
# UserPromptSubmit hook: stdout is added to Claude's context before it answers.
# Injected on every prompt, so keep it short — the routing table lives in AGENTS.md.
cat <<'EOF'
Skill routing: before acting, classify this request against the "Skill routing" table in AGENTS.md and invoke the matching skill first — bmad-build for a feature, bug fix or meaningful change; bmad-spec for multi-session work; bmad when unsure what comes next; the matching alpaca-* skill for anything touching the Alpaca API; docs/10-git-workflow.md for git housekeeping. Plain questions and trivial edits: act directly. AGENTS.md hard rules and docs/05-legacy-competition.md override any BMAD workflow.
Git: follow docs/10-git-workflow.md — work on your own <prefix>/<type>/<slug> branch from a fresh origin/main; never commit to main, never touch a colleague's branch.
EOF
