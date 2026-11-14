---
name: git
description: Create one explicit, well-scoped ChessRiddle Studio commit without pushing or adding AI/co-author trailers.
---

# Git — smart commit

This is the canonical ChessRiddle Studio commit workflow.

## Authority

* Follow the active workflow's commit authority; this skill adds no second approval gate. Verified
  task-owned work is committed automatically under `~/.claude/CLAUDE.md`, so `/git` is an
  optional manual trigger, not a prerequisite.
* Delegated leaves never stage or commit; they hand unstaged work and proof to the orchestrator.

## Inspect and scope

* Read `git status`, the unstaged and staged diffs, and the recent log before staging anything.
* Select one cohesive change. Preserve foreign work and never use `git add -A` or `git add .`.
* Match the repository's concise conventional-commit style; use an imperative summary and add a
  body only when it carries useful context.

## Verify and commit

* Never commit on red. Use the verification already run for the affected change. If nothing ran,
  run the narrowest affected check from `.claude/skills/push/SKILL.md`; do not copy its mapping here
  and do not run the full push workflow.
* Never bypass hooks with `--no-verify`.
* Commit with `GIT_COMMITTER_NAME="Claude Code"`. Leave the author untouched and add no AI or
  co-author trailer.
* Name the owned paths on the commit itself (`git commit -- <paths>`). Pass prose through `-F -`
  with a quoted heredoc, never a double-quoted `-m` string containing backticks.
* Do not push. Push requires a separate explicit request and the canonical push workflow.
