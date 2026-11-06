---
name: push
description: Validate, independently review, remediate, commit, and push ChessRiddle Studio changes when Felix requests a push or a drain session or build run invokes this skill. Push is not release or deployment.
---

# push (Codex bridge)

Read `.claude/skills/push/SKILL.md` first and follow that canonical ChessRiddle Studio workflow.
Read `~/.claude/references/push-review-policy.md` before its first step.

Follow the canonical execution order and stage-emission contract above.

* Use `GIT_COMMITTER_NAME="Codex"` for every commit; leave the author untouched and add no
  co-author trailer.
