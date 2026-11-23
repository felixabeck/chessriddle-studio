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

* Every commit that is not records-only gets the pre-commit review, whether it changes code or
  non-code paths (`.claude/skills/**`, `.claude/rules/**`, `CLAUDE.md`, `AGENTS.md`, docs,
  workflows, config, `package.json`), per `~/.claude/references/push-review-policy.md` §1b.
  Stage the owned paths with explicit `git add -- <paths>`, then before the commit:
  * run `pnpm checks:pre-review` (push §2a, changed-path lint/format/type/build lanes);
  * run the applicable commands from the push skill's "## Related tests" over the changed and
    created paths (Vitest related, filtered `cargo test`, matching `scripts/*-tests.mjs`);
  * review the staged diff under policy §§2–4a with push §3's parameters (lens selection,
    sensitive-path globs, `Skip` catalog). Lenses run on the selected executor through
    `~/.claude/scripts/leaf-launch.sh` as policy §3 and
    `~/.claude/references/review-lens-contract.md` describe. Repairs are staged and closed under
    policy §4a before the commit. `$push` runs no lenses, so an unreviewed commit is never pushed.
* For a visible UI change, run the `verify-ui` skill after review repairs and before the commit,
  under the push skill's browser-verification rules (screenshots of every affected flow,
  `pnpm test:e2e:container` where the push skill requires it).
* Emit the `code-review`, `repair` and `browser-verification` `drain_stage` records the push skill
  names, sourcing `~/.claude/scripts/lib/drain-breadcrumb.sh` in the same shell as each call.
* Records-only commits follow policy §1b: ledger records (`tasks/findings.md`,
  `tasks/decisions.md`, `tasks/build-ledger.md`, `tasks/handoffs/**`) are reviewed by
  `./scripts/findings.py check` printing `ok`; ChessRiddle Studio has no other record paths.
* A mixed commit runs the review fan-out on
  `git diff --cached -- . ':(exclude)<record paths>'` and the records route above on the record
  paths, exactly as policy §1b and push §3 say. A code lens never receives a record path's diff.
* Never commit on red. Never bypass hooks with `--no-verify`.
* Committer identity follows push §1 and policy §1: the session-native committer, never a
  per-command `GIT_COMMITTER_NAME` prefix. Leave the author untouched and add no AI or
  co-author trailer.
* Name the owned paths on the commit itself (`git commit -- <paths>`). Pass prose through `-F -`
  with a quoted heredoc, never a double-quoted `-m` string containing backticks.
* Do not push. Push requires a separate explicit request and the canonical push workflow.
