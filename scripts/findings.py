#!/usr/bin/env -S uv run --script
# agent-kit-sha256: 1ea6a910e2d4f2f1066d940eb1ab15b10e03878a7aac306b2f43d995c80e4819
# /// script
# requires-python = ">=3.14"
# ///
# The interpreter is declared here, not chosen by the caller.
# ~/.claude/references/python-interpreter-contract.md is the rule and the reasoning.
"""Query and validate the findings ledger (``tasks/findings.md``).

The ledger is an **append-only log**; the work queue is derived from it here. A
finding's position in the file therefore carries no meaning, which is what lets a
run append wherever it happens to be writing without anyone having to file it "in
the right place".

Grouping is by ``Root`` only; findings without a root are singletons. A shared root cause
crosses area boundaries — two findings can share no file and sit in different
areas yet be one defect. Picking them up together means one interview instead of
two, and removes the case where fixing the second undoes the first.

The contract — field meanings, ranking, the decision discipline — is
``~/.claude/references/findings-ledger-contract.md``. **This script is deliberately
identical across projects.** Everything project-specific is read from the ledger
or the project manifest: the area vocabulary from the markdown header, or — for a
Controller-generated JSON export — from ``.project.json`` ``findings.areas``; the
governing decisions from the sibling ``decisions.md``. Nothing project-specific
may be added below.

Subcommands
-----------
``check``        validate every header and the sibling decisions ledger's ids;
                 exit 1 on any violation
``list``         print findings, optionally filtered
``summary``      print counts, who is waiting, and what is drainable
``next``         print the highest-ranked pickable cluster, the decisions governing it,
                 and separately the ones merely touching its files
``unclaim``      release this session's pick claims
``related``      print findings sharing an area or naming the same files
``file``         publish one new finding entry through the inbox spool
``merge-inbox``  fold published findings from the inbox into the ledger
``finalize-claims`` release prepared claims whose entries are proven in ``HEAD``
``decisions``    print Felix-facing blockers waiting on Felix
``apply-answers`` fold answers back in and unblock what was decided
``answer``       publish one answer atomically through the answers spool
``commit-ledger`` commit an expected ledger snapshot by its exact bytes
``drain-status`` exit 0 if this repo's consumer lock is held, 1 otherwise
``set-header``  mutate selected fields of one finding header
``annotate``    append file contents to one finding entry
``close``       mark a finding handled and append its closing note atomically
``record-decision`` append decisions through the decisions ledger lock
``set-trailer`` set decision supersession references, adding the trailer where an
                 entry predates it, and refresh their covering receipt
``merge-driver`` git merge driver for the two ledgers (``%O %A %B %P``): compatible
                 edits and whole blocks merge, conflicts fall back to ``git merge-file``
"""

from __future__ import annotations

import argparse
import base64
import difflib
import errno
import fcntl
import functools
import hashlib
import io
import itertools
import json
import os
import posixpath
import re
import shlex
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Collection, Iterator, Mapping
from contextlib import (
    ExitStack,
    contextmanager,
    redirect_stderr,
    redirect_stdout,
    suppress,
)
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from enum import Enum, auto
from pathlib import Path, PurePosixPath
from typing import Literal, NamedTuple, cast

SUPERVISOR_CONTRACT_ENV = "FINDINGS_SUPERVISOR_CONTRACT"
# Malformed declarations fall back to the oldest gated behaviour, always safe for a declaring caller.
SUPERVISOR_CONTRACT_BASELINE = 1
# First level whose callers get impact-ranked cells and the new filing rules. Lower declared levels keep c57b00c behaviour.
IMPACT_QUEUE_CONTRACT_LEVEL = 2
# First level whose callers get the 2026-10-13 refusals and reports: repeated
# single-valued entry fields refused at admission, the out-of-diff admission bar in annotate and
# check, and writer success lines naming the ledger they wrote. Lower declared
# levels, including the supervisor's IMPACT_QUEUE_CONTRACT_LEVEL, keep the previous behaviour.
STRICT_REPORTING_CONTRACT_LEVEL = 3
ANSWERED_SPOOL_CONTRACT_LEVEL = 4
EFFECTIVE_FOLLOW_UP_CONTRACT_LEVEL = 5


def _parse_supervisor_contract_level(value: str | None) -> int | None:
    """Parse a declaration silently, falling back to the oldest declared level."""
    if value is None or value == "":
        return None
    if not value.isascii() or not value.isdecimal():
        return SUPERVISOR_CONTRACT_BASELINE
    # Accumulate digits so Python's decimal conversion limit cannot raise.
    level = 0
    for digit in value:
        level = level * 10 + ord(digit) - ord("0")
    return level or SUPERVISOR_CONTRACT_BASELINE


# Consume before the import-time git probe so children and hooks stay undeclared.
_SUPERVISOR_CONTRACT_LEVEL = _parse_supervisor_contract_level(
    os.environ.pop(SUPERVISOR_CONTRACT_ENV, None)
)


def supervisor_contract_level() -> int | None:
    """Return the level a declaring caller (the drain supervisor) understands.

    None means undeclared: newest behaviour. Behaviour gated on this level keeps
    old behaviour for lower declared levels
    (references/python-interpreter-contract.md §7).
    """
    return _SUPERVISOR_CONTRACT_LEVEL


def _impact_queue_enabled() -> bool:
    """Keep level-1 writer behaviour while enabling the impact queue for new callers."""
    level = supervisor_contract_level()
    return level is None or level >= IMPACT_QUEUE_CONTRACT_LEVEL


def _strict_reporting_enabled() -> bool:
    """Keep lower-level writer behaviour while enabling strict reporting for new callers."""
    level = supervisor_contract_level()
    return level is None or level >= STRICT_REPORTING_CONTRACT_LEVEL


def _answered_spool_enabled() -> bool:
    """Keep lower-level waiting counts while showing published answers to new callers."""
    level = supervisor_contract_level()
    return level is None or level >= ANSWERED_SPOOL_CONTRACT_LEVEL


def _effective_follow_up_enabled() -> bool:
    """Keep historical ancestry and annotation admission for lower declared levels."""
    level = supervisor_contract_level()
    return level is None or level >= EFFECTIVE_FOLLOW_UP_CONTRACT_LEVEL


# Named so the formatter cannot rewrite them. `ruff format` at target-version py314
# strips redundant parentheses from an explicit `except (A, B):` tuple literal, and
# the parenthesized form is what a pre-3.14 interpreter needs to parse this file
# (`d-20260830-26`). A name is a single expression with nothing to strip.
_READ_ERRORS = (OSError, UnicodeError)

# What json.loads raises on a document this tool did not write. RecursionError is
# the half that keeps being forgotten: a record nested past the interpreter's
# limit raises it instead of ValueError (`f-20260916-03`). A deliberate third
# spelling of the same fact — `drain_supervisor_paths.JSON_PARSE_ERRORS` and
# `leaf_terminal.py` carry the other two — because this file imports no
# supervisor module and must stay a single vendorable script.
_JSON_ERRORS = (ValueError, RecursionError)
_READ_JSON_ERRORS = _READ_ERRORS + _JSON_ERRORS
_MERGE_INTENT_ERRORS = _READ_ERRORS + _JSON_ERRORS + (KeyError, TypeError)

# Keep one failed breadcrumb report, including its final newline, within this
# fixed width so a helper cannot flood the drain's stderr. The beginning of the
# cause is retained because it is usually the useful part of the diagnostic.
DRAIN_BREADCRUMB_DIAGNOSTIC_MAX_CHARS = 4096
DRAIN_BREADCRUMB_FAILURE_MARKER = "breadcrumb not written:"
DRAIN_BREADCRUMB_TRUNCATION_MARKER = "... [truncated]"
_DRAIN_BREADCRUMB_ERRORS = (OSError, subprocess.SubprocessError)


def _probe_git_toplevel(*, cwd: Path | None = None) -> tuple[Path | None, str]:
    """Read-only `git rev-parse --show-toplevel` of the supplied directory or cwd.

    Never writes. Never falls back to ``__file__`` or cwd. The stderr string is
    what a verb prints inside ``REFUSING: not inside a git checkout (...)``.
    """
    git = shutil.which("git") or "/usr/bin/git"
    try:
        completed = subprocess.run(
            [git, "rev-parse", "--show-toplevel"],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        return None, str(exc)
    err = (completed.stderr or completed.stdout or "").strip()
    if completed.returncode != 0:
        return None, err or "git rev-parse --show-toplevel failed"
    text = completed.stdout.strip()
    if not text:
        return None, err or "git rev-parse --show-toplevel returned empty"
    return Path(text), ""

# Length is part of the cross-language protocol: `drain-findings.sh` truncates to
# the same width. Changing it here alone renames the lock for one side only.
DRAIN_LOCK_KEY_CHARS = 8


def _claude_home() -> Path:
    """The configuration root, derived exactly as `drain_supervisor_paths.claude_home()`."""
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def _lock_for_root(root: Path) -> Path:
    """Consumer-lock path matching drain-lock-name.sh and RepoPaths.consumer_lock.

    Both use the same configuration root.
    """
    key = hashlib.sha256(str(root).encode()).hexdigest()[:DRAIN_LOCK_KEY_CHARS]
    return _claude_home() / f"drain-lock-{root.name}-{key}"


def _require_git_toplevel() -> Path:
    """Verb-time root. Exit 3 outside a checkout; never fall back."""
    root, err = _probe_git_toplevel()
    if root is None:
        print(f"REFUSING: not inside a git checkout ({err})", file=sys.stderr)
        raise SystemExit(3)
    return root


_IMPORT_ROOT, _IMPORT_GIT_ERR = _probe_git_toplevel()
# Import-time paths exist so tests that inspect the module constants, and
# argparse defaults that production CLI calls omit, still resolve. Verbs
# re-derive from the cwd's git toplevel at execution; they never use __file__.
REPO_ROOT: Path | None = _IMPORT_ROOT
LEDGER = (
    REPO_ROOT / "tasks" / "findings.md"
    if REPO_ROOT is not None
    else Path("tasks") / "findings.md"
)
DECISIONS = (
    REPO_ROOT / "tasks" / "decisions.md"
    if REPO_ROOT is not None
    else Path("tasks") / "decisions.md"
)
# Git-ignored spool for findings filed through `file`. Separate atomically
# published files prevent two filing sessions from overwriting each other while
# the entry waits for its merge.
INBOX = (
    REPO_ROOT / "tasks" / "findings-inbox"
    if REPO_ROOT is not None
    else Path("tasks") / "findings-inbox"
)
LEGACY_INBOX = (
    REPO_ROOT / "tasks" / "findings-inbox.md"
    if REPO_ROOT is not None
    else Path("tasks") / "findings-inbox.md"
)
CLAIM = (
    REPO_ROOT / "tasks" / "findings-inbox.claim"
    if REPO_ROOT is not None
    else Path("tasks") / "findings-inbox.claim"
)
# A Controller-enrolled checkout regenerates ``tasks/findings.md`` from its SQLite
# ledger as a fenced JSON payload rather than the ``###`` entry contract. That
# form is read-only here: the Controller owns every write to it.
PROJECT_MANIFEST_NAME = ".project.json"
CONTROLLER_EXPORT_MARKERS = (
    "Generated from the authoritative SQLite ledger",
    "findings-generation:",
)
# Impact-queue-level and undeclared callers honour markers only in the bounded
# preamble before the first ``## `` or ``### `` heading, so quoted markers cannot
# switch the parser. Level 1 retains whole-head detection byte-identically.
CONTROLLER_EXPORT_HEAD_CHARS = 4096
CONTROLLER_EXPORT_HEADING_RE = re.compile(r"^#{2,3} ", re.MULTILINE)
# The section every Controller finding reports: the export has no ``## `` headings.
CONTROLLER_EXPORT_SECTION = "controller-export"
CONTROLLER_JSON_FENCE_RE = re.compile(r"```json[ \t]*\n(?P<body>.*?)```", re.S)
# Before publishing, a filer checks whether the drain holds the ledger to decide
# whether deferred-claim preconditions apply. After publishing, it takes a shared
# non-blocking flock to choose between drain-owned merging and merging itself. The
# environment override keeps that branch testable without ever consulting the
# real drain lock.
DRAIN_LOCK_ENV = "FINDINGS_DRAIN_LOCK"


def _bounded_drain_breadcrumb_failure(context: str, cause: object = "") -> str:
    """Return one bounded, newline-terminated breadcrumb failure diagnostic."""
    diagnostic = context
    if cause:
        diagnostic += f": {cause}"
    if not diagnostic.endswith("\n"):
        diagnostic += "\n"
    if len(diagnostic) <= DRAIN_BREADCRUMB_DIAGNOSTIC_MAX_CHARS:
        return diagnostic
    suffix = DRAIN_BREADCRUMB_TRUNCATION_MARKER + "\n"
    available = DRAIN_BREADCRUMB_DIAGNOSTIC_MAX_CHARS - len(suffix)
    return diagnostic[:available] + suffix


def append_drain_breadcrumb(label: str, detail: str) -> None:
    step_file = os.environ.get("DRAIN_STEP_FILE")
    if not step_file:
        return
    library = os.environ.get(
        "DRAIN_BREADCRUMB_LIB",
        str(_claude_home() / "scripts" / "lib" / "drain-breadcrumb.sh"),
    )
    try:
        result = subprocess.run(
            [
                "bash",
                "-c",
                'source "$1" && drain_breadcrumb "$2" "$3"',
                "_",
                library,
                label,
                detail,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        context = (
            f"{DRAIN_BREADCRUMB_FAILURE_MARKER} {step_file} "
            f"(helper {library}, exit {exc.returncode})"
        )
        sys.stderr.write(_bounded_drain_breadcrumb_failure(context, exc.stderr))
    except _DRAIN_BREADCRUMB_ERRORS as exc:
        context = (
            f"{DRAIN_BREADCRUMB_FAILURE_MARKER} {step_file} "
            f"(helper {library})"
        )
        sys.stderr.write(_bounded_drain_breadcrumb_failure(context, exc))
    else:
        if result.stderr:
            if DRAIN_BREADCRUMB_FAILURE_MARKER in result.stderr:
                context = (
                    f"{DRAIN_BREADCRUMB_FAILURE_MARKER} {step_file} "
                    f"(helper {library})"
                )
                sys.stderr.write(
                    _bounded_drain_breadcrumb_failure(
                        context,
                        result.stderr.replace(DRAIN_BREADCRUMB_FAILURE_MARKER, "", 1),
                    )
                )
            else:
                sys.stderr.write(result.stderr)


# Keyed by the RESOLVED PATH, not the basename. Two checkouts of one repo — a
# worktree, a /tmp clone — used to share one `drain-lock-<repo>` name, so a
# drain in either made a filer in the other believe its entry would be merged by
# a drain that reads a different ledger: the entry then waits in a spool with no
# consumer, silently. Liveness checking does not help, because the pid IS alive.
# The basename stays in the name so `rm ~/.claude/drain-lock-<repo>-*` still
# works and the file is still recognisable by eye.
# `drain-findings.sh` computes the same suffix and the two MUST agree —
# `test_drain_lock_name_matches_the_drain_script` proves it rather than trusting
# two implementations of one hash.
DEFAULT_DRAIN_LOCK = (
    _lock_for_root(REPO_ROOT)
    if REPO_ROOT is not None
    else _claude_home() / "drain-lock-unknown"
)
# Felix's answers to parked decisions. A separate spool from INBOX because the two
# do opposite things: the inbox appends whole new entries, an answer *edits* an
# existing one. Same unique-name plus exclusive-publish discipline (`ln` in
# `/decide`, `os.link` here), same "drain applies it between clusters" timing,
# so an answer given mid-run re-enters that run.
ANSWERS = (
    REPO_ROOT / "tasks" / "findings-answers"
    if REPO_ROOT is not None
    else Path("tasks") / "findings-answers"
)

# Ledger writers may wait for the exact-byte pre-commit hook and its termination
# grace period. Keep this above both those bounds so a hook never races another
# writer's read or worktree restoration.
LEDGER_LOCK_WAIT_SECONDS = 660.0
# Vendored capability marker checked before allocating beside branch worktrees.
CLONE_WIDE_ID_ALLOCATION_CAPABILITY = "findings-clone-wide-id-allocation-v2"
CLONE_WIDE_ID_LOCK_NAME = "findings-id-alloc.lock"
CLONE_WIDE_ID_RESERVATIONS_NAME = "findings-id-reservations"
CLONE_ID_COLLECTION_MAX_RESTARTS = 3
TREE_LEDGER_SYMLINK_LIMIT = 16
_ACTIVE_ID_RESERVATIONS: Path | None = None
_ACTIVE_CLONE_ID_SCOPES: dict[str, tuple[Path, int]] = {}
_EXPLICIT_ID_ALLOCATION_PATHS = False
CLONE_WIDE_WRITER_PATH = "scripts/findings.py"
# The lock fences only a short `git config` repair, never a hook. Measured here:
# four-call repair median 2.17 ms idle, max 2.46 ms with 12 concurrent holders.
# Allow 11 four-call holders at 0.3 s per Git call (13.2 s), plus margin.
MERGE_DRIVER_CONFIG_LOCK_WAIT_SECONDS = 15.0
LEDGER_LOCK_RETRY_INTERVAL_SECONDS = 0.05
DRAIN_LOCK_READ_BYTES = 4096
# What `drain-findings.sh` writes into the consumer lock once it has released the
# flock. With the flock already free, a decimal marker would read as a stale drain
# rather than a finished one, so the marker distinguishes "finished" from "died".
DRAIN_LOCK_RELEASED_MARKER = "released"
# scripts/with-drain-locks.sh records its maintenance fence in the consumer lock.
DRAIN_LOCK_FENCE_MARKER_PREFIX = "with-drain-locks "
VENDORED_STAMP_PREFIX = "# agent-kit-sha256:"
VENDORED_STAMP_LINE_BYTES = 4096
GIT_ENTRY_NAME = ".git"
# `_unique_suffix` cannot repeat within a process, so a second attempt is not this
# process colliding with itself. It recovers from a name another process already
# took, or from a filesystem that refused the link. Bounded rather than `while
# True` so a persistent collision errors out instead of hanging in a filing session.
PUBLISH_NAME_ATTEMPTS = 8
# A publisher must never wait forever behind a crashed or wedged writer. The
# lock is a short fence around rename/link and claim cleanup, so callers report a
# retryable refusal when this bounded window expires.
PUBLISH_LOCK_TIMEOUT_SECONDS = 30.0
RECEIPT_DIGEST_HEX_LENGTH = 64
# A completed `.part` is adopted only after this grace period. A live publisher
# keeps the publish lock, so the grace protects only writers from older versions
# that did not use that fence.
ORPHAN_PART_GRACE_SECONDS = 60.0
# Scratch files are intentionally retained for a while because one candidate
# writer remains outside the ledger lock. The bound is explicit: a writer paused
# for an hour is outside the supported write window, and a swept candidate makes
# the failed write visible rather than silently losing it.
SCRATCH_GRACE_SECONDS = 3600.0
INTAKE_RECOVERY_GRACE_SECONDS = 3600.0
# One retry covers a concurrent merge removing the emptied intake directory.
INTAKE_STAGING_ATTEMPTS = 2
_GENERATED_SCRATCH_RE = re.compile(r"^(?P<target>.+)\.(?:tmp|candidate)-\d+-\d+-\d+$")
_GENERATED_INBOX_PART_RE = re.compile(r"^\.\d{8}-\d{6}-\d+-\d+-\d+\.part$")
MERGE_INTENT_NAME = ".merge-intent.json"

STATUSES = frozenset({"open", "handled", "rejected"})
ENTRIES = frozenset({"inline", "lens", "build"})
ENTRY_RANK = {"inline": 0, "lens": 1, "build": 2}
IMPACT_RANK = {
    "security": 0,
    "data-loss": 0,
    "behaviour": 1,
    "unclassified": 2,
    "ux": 3,
    "tooling": 4,
}
IMPACT_CLASSES = frozenset(IMPACT_RANK) - {"unclassified"}
FOLLOW_UP_ESCALATION_MIN = 3
ROOT_CLUSTER_MIN_CARRIERS = 2
CO_LOCATED_MAX = 2

# One grammar for a finding id, so the validator that rejects a malformed one and
# the allocator that mints a new one cannot drift apart.
ID_DATE_LEN = 8
ID_SEQ_DIGITS = 2
ID_SEQ_MAX = 10**ID_SEQ_DIGITS - 1
ID_RE = re.compile(rf"^f-(\d{{{ID_DATE_LEN}}})-\d{{{ID_SEQ_DIGITS}}}$")
# What a filing session writes into the spool instead of choosing an id. See
# `assign_pending_ids` for why choosing one itself cannot be made race-free.
PENDING_ID = "f-PENDING"
PENDING_DECISION_ID = "d-PENDING"
LEDGER_META_PREFIX = "<!-- ledger-meta "
LEDGER_META_SUFFIX = " -->"
LEDGER_META_VERSION = 1
MUTATION_RECEIPT_KIND = "mutation-receipt"
CITATION_CONTEXT_KIND = "citation-context"
RECEIPT_PLACEHOLDER = "<!-- ledger-meta receipt-placeholder -->"
# The git merge driver for the two append-only ledgers. `.gitattributes` names
# the driver; the command can only live in the clone's own `.git/config`, so
# `check` installs it (`ensure_merge_driver`) and a fresh clone needs no hand.
MERGE_DRIVER_NAME = "ledger-append"
MERGE_DRIVER_COMMAND = "./scripts/findings.py merge-driver %O %A %B %P"
MERGE_DRIVER_DESCRIPTION = "validated ledger block merge (findings.py merge-driver)"
MERGE_DRIVER_CONFIG_LOCK_NAME = "findings-merge-driver-config.lock"
MERGE_DRIVER_LEDGERS = {
    "tasks/findings.md": "findings",
    "tasks/decisions.md": "decisions",
}
# A request id has one required first character plus up to 127 more.
REQUEST_ID_MAX_LENGTH = 128
REQUEST_ID_RE = re.compile(
    rf"^[A-Za-z0-9][A-Za-z0-9._-]{{0,{REQUEST_ID_MAX_LENGTH - 1}}}$"
)
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
# The decisions spool uses the same pending-token shape as the findings spool.
SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
HEADER_RE = re.compile(
    r"^\* \*\*ID:\*\* (?P<id>\S+) · "
    r"\*\*Status:\*\* (?P<status>\S+) · "
    r"\*\*Area:\*\* (?P<area>\S+) · "
    r"\*\*Root:\*\* (?P<root>\S+) · "
    r"\*\*Entry:\*\* (?P<entry>\S+) · "
    r"\*\*Blocked:\*\* (?P<blocked>\S+)\s*$"
)
HEADER_MARKER = "**ID:**"
ENTRY_MARKER = "### "
# Bold-label header keys in the form already used for Area vocabulary. Tooling
# areas is optional; a missing line means no finding is tooling.
_BOLD_LABEL_RE_TEMPLATE = r"\*\*{label}:\*\*(?P<body>.+?)(?:\n\n|\Z)"
VOCAB_RE = re.compile(_BOLD_LABEL_RE_TEMPLATE.format(label=r"Area vocabulary"), re.S)
TOOLING_AREAS_RE = re.compile(
    _BOLD_LABEL_RE_TEMPLATE.format(label=r"Tooling areas"), re.S
)
PLAN_ADOPTED_COLUMN = "plan_adopted_per_round"
PLAN_ADOPTED_NOT_RECORDED = "not-recorded"
# Labelled counts `r1=6 r2=2 r3=0`: sequential rN from 1, non-negative ints.
_PLAN_ADOPTED_TOKEN_RE = re.compile(r"^r([1-9]\d*)=(\d+)$")
NEXT_OUTCOME_CLUSTER = "cluster"
NEXT_OUTCOME_EMPTY = "empty"
NEXT_OUTCOME_BLOCKED_ONLY = "blocked-only"
# Per-claim outcomes of the locked finalizers. The post-commit path can also
# see free-form ``busy: <detail>`` and ``exception: <detail>`` strings.
FINALIZE_OUTCOME_NONE = "none"
FINALIZE_OUTCOME_REPLAY = "replay"
FINALIZE_OUTCOME_FINALIZED = "finalized"
FINALIZE_OUTCOME_CLEANUP_FAILED = "cleanup-failed"
FINALIZE_OUTCOME_MANUAL_REPAIR = "manual-repair"
MANUAL_REPAIR_RETURN_CODE = 4
# Every CLI verb is classified once so plan-only mode cannot silently miss a
# newly added writer. ``file`` is guarded except for its read-only ``--status``
# form and its explicitly authorised planner spool form.
COMMAND_CLASSIFICATION = {
    "check": "read-only",
    "drain-status": "read-only",
    "inbox-filed-by": "read-only",
    "list": "read-only",
    "summary": "read-only",
    "next": "read-only",
    "unclaim": "guarded",
    "related": "read-only",
    "decisions": "read-only",
    "file": "guarded",
    "merge-inbox": "guarded",
    "finalize-claims": "guarded",
    "apply-answers": "guarded",
    "answer": "guarded",
    "commit-ledger": "guarded",
    "set-header": "guarded",
    "annotate": "guarded",
    "close": "guarded",
    "record-decision": "guarded",
    "set-trailer": "guarded",
    "merge-driver": "guarded",
}
PLAN_ONLY_ENV = "DRAIN_PLAN_ONLY"
PLAN_INBOX_ENV = "DRAIN_PLAN_INBOX"
# `*`, `-` and `+` are all list bullets in Markdown. Detection and rendering
# must agree on the accepted bullet class or a gated entry can be reported as
# having no Sentry short-ID.
_BULLET = r"[*+-]"
TOP_LEVEL_FIELD_RE = re.compile(
    rf"^{_BULLET}[ \t]+\*\*(?P<name>[^*\n]+?):\*\*", re.MULTILINE
)
# These name one Sentry issue per bullet, so an entry may carry several.
REPEATABLE_ENTRY_FIELDS = frozenset({"Sentry", "Sentry-ref"})
FILED_FROM_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Filed from:\*\*[ \t]*\S.*$", re.MULTILINE
)
PROOF_BULLET_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Proof:\*\*", re.MULTILINE
)
BULLET_LINE_RE = re.compile(rf"^[ \t]*{_BULLET}[ \t]+\S")
CONTINUATION_LINE_RE = re.compile(r"^[ \t]+\S")
REJECTED_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Why rejected:\*\*[ \t]*(?P<reason>\S.*)",
    re.MULTILINE,
)
SENTRY_RE = re.compile(rf"^[ \t]*{_BULLET}[ \t]+\*\*Sentry:\*\*[ \t]*", re.MULTILINE)
SENTRY_ORIGIN_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Origin:\*\*[ \t]+sentry-intake[ \t]*$",
    re.MULTILINE,
)


def _body_is_sentry_origin(body: str) -> bool:
    """Return whether an unfenced body carries either Sentry-origin marker."""
    return (
        SENTRY_RE.search(body) is not None or SENTRY_ORIGIN_RE.search(body) is not None
    )


# A finding parked on Felix has to carry the brief that makes it answerable away
# from the session that parked it. Without this, answering days later means
# re-deriving an investigation that already happened — the same waste as
# restarting a crashed cluster instead of resuming it.
#
# All four use the shared `_BULLET` grammar rather than a hand-written `[*-]`.
# They carried their own copy until 2026-09-01, which silently rejected a
# CommonMark `+ ` bullet -- and because every locked mutation validates the
# whole ledger, one such entry would have refused every later write to it.
DECISION_BRIEF_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Decision:\*\*[ \t]*(?P<question>\S.*)",
    re.MULTILINE,
)
RECOMMEND_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Recommend:\*\*[ \t]*(?P<choice>\S.*)",
    re.MULTILINE,
)
# The parking session's id, so `/decide` can mine the transcript that holds the
# investigation instead of re-deriving it. Required by the contract and, until
# now, by nothing that checked.
SESSION_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Session:\*\*[ \t]*(?P<sid>\S.*)",
    re.MULTILINE,
)
# The gate that decides whether the question is Felix's at all: what does a user
# of the app see, get, pay or get promised differently depending on the answer?
# A technical question never parks, however consequential — the session holding
# the investigation is the one positioned to apply the optimal-long-term rule.
#
# This is enforced rather than merely written down because the failure mode is
# not a badly written park, it is a *well* written one. `f-20260824-21` parked a
# choice between npx, a devDependency and a hand-written allowlist behind a
# complete, well-argued brief; Felix: "This is purely technical stuff. I don't
# understand what you're talking about. I just enter your recommendations."
# `Entry: build` was 691 of 1137 filed findings on 2026-09-09, 60 % of the queue,
# because the contract's "when uncertain, write `build`" costs nothing to assert
# and needs evidence to undo. The counter-pressure is the same shape as the
# product-impact gate below: a bullet the filing session has to write. Uncertainty
# that cannot name its design question is not a design question, it is an unread
# file, and the finding belongs at `inline` or `lens`.
#
# Filing-time only, deliberately. It is NOT part of `validate`, which
# `findings.py check` runs over the whole ledger and every project gate calls:
# 690 existing `build` entries across four repositories were filed before this
# rule and would redden every gate at once. The rule is about what a filer was
# asked, and no existing entry's filer was asked.
OPEN_QUESTION_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Open question:\*\*[ \t]*(?P<question>\S.*)",
    re.MULTILINE,
)
OPEN_QUESTION_REFUSAL = (
    "{where}: `Entry: build` needs an '**Open question:**' bullet naming the design "
    "question the plan has to answer. If the question cannot be written, file it as "
    "`inline` or `lens`."
)
IMPACT_CLASS_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Impact class:\*\*[ \t]*(?P<value>[^\n]*)$",
    re.MULTILINE,
)
FOLLOW_UP_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Follow-up of:\*\*[ \t]*(?P<ids>[^\n]*)$",
    re.MULTILINE,
)
EFFECTIVE_FOLLOW_UP_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Effective Follow-up of:\*\*[ \t]*(?P<ids>[^\n]*)$",
    re.MULTILINE,
)
EFFECTIVE_FOLLOW_UP_MARKER_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Effective Follow-up of\b",
)
OUTSIDE_DIFF_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Spotted outside diff:\*\*",
    re.MULTILINE,
)
FAILURE_SCENARIO_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Failure scenario:\*\*[ \t]*(?P<scenario>\S[^\n]*)$",
    re.MULTILINE,
)
# Brief quality is not what makes a question his, so no amount of prose in the
# contract catches this — only a bullet the parking session has to write and
# cannot write honestly for a technical question.
PRODUCT_IMPACT_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*Product impact:\*\*[ \t]*(?P<impact>\S.*)",
    re.MULTILINE,
)
# A bullet that exists and says nothing satisfies the letter of the gate while
# defeating its purpose, and the phrasings that do it are few and predictable:
# a run that has just been told it must name a product impact, and has none,
# writes exactly one of these. The validator cannot judge honesty and does not
# try -- it refuses the grossly vacuous forms, which is the difference between
# a gate an agent must think past and one it can type past.
VACUOUS_IMPACT_RE = re.compile(
    r"^(?:"
    r"[\s.,()\[\]\-–—…;:!?*_`\"']*"  # punctuation-only, e.g. "." or "--" or "()"
    r"|n/?a\b.*"
    r"|none\b.*"
    r"|nothing\b.*"
    r"|unknown\b.*"
    r"|tbd\b.*"
    r"|(?:no|zero)\s+(?:user|product|customer|visible|direct)\b.*"
    r"|no\s+impact\b.*"
    r"|no\s+(?:users?|teachers?|customers?|one)\b.*"
    r"|(?:purely|only|just)\s+(?:a\s+)?technical\b.*"
    r"|technical\s+(?:only|choice|decision)\b.*"
    r"|(?:this\s+)?(?:is\s+)?(?:a\s+)?technical\b.*"
    # Anchored at the START of the bullet, deliberately, where the sibling
    # matched them anywhere in it. Matching anywhere refuses a legitimate
    # CONTRAST -- "(a) no user-visible change; (b) the teacher sees a warning"
    # names a real product impact and is exactly the sentence this gate wants.
    # Refusing it is the harmful direction: the failure message tells the author
    # the question is technical and should be unparked, so an over-broad rule
    # here pushes a genuine product question off Felix's list.
    r"|(?:there\s+is\s+)?no\s+(?:user|product|customer)[- ]visible\b.*"
    r"|nothing\s+(?:a\s+)?users?\s+(?:can\s+)?(?:see|observe|notice)\b.*"
    r"|(?:this\s+(?:is|would\s+be)\s+)?invisible\s+to\s+(?:the\s+|every\s+|all\s+)?users?\b.*"
    r")$",
    re.IGNORECASE | re.DOTALL,
)
# Slugs naming the waits that depend on Felix. Answerable blockers carry a
# question; other `felix-*` values name preconditions he must clear.
FELIX_DECISION = "felix-decision"
ANSWERABLE_BLOCKERS = frozenset({FELIX_DECISION})
# The `summary --json` contract. Versioned because the drain's preflight and
# the cross-repository view both read it from another process; a shape change
# that both ends learned to expect the way this one is spelled would otherwise
# be indistinguishable from a payload that merely happened to parse.
FINDINGS_SUMMARY_SCHEMA = "findings-summary/1"
DECIDED_MARKER = "**Decision made:**"


# The answer spool has a smaller header than the findings ledger. Reusing
# HEADER_RE would silently reject the actual answer shape; anchoring this grammar
# also keeps ids in prose or fenced examples from becoming answer targets.
ANSWER_ID_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+\*\*ID:\*\*[ \t]+"
    rf"(?P<id>f-\d{{{ID_DATE_LEN}}}-\d{{{ID_SEQ_DIGITS}}})(?=[ \t]*(?:·|$))",
    re.MULTILINE,
)
DECISION_BULLET_RE = re.compile(
    rf"^[ \t]*{_BULLET}[ \t]+"
    rf"(?P<decision>{re.escape(DECIDED_MARKER)}.*)$",
    re.MULTILINE,
)


def _answer_evidence_marker(body: str) -> str | None:
    """Name answer-route-only evidence in ``body``, if it carries any."""
    if DECISION_BULLET_RE.search(body) is not None:
        return DECIDED_MARKER
    return None


# A thematic break may contain spaces between its three or more matching markers.
HRULE_RE = re.compile(r" {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")
BLOCKER_NONE = "none"
BLOCKER_ANSWERABLE = "answerable"
BLOCKER_PRECONDITION = "precondition"
BLOCKER_EXTERNAL = "external"
BLOCKER_CLASSES = frozenset(
    {
        BLOCKER_NONE,
        BLOCKER_ANSWERABLE,
        BLOCKER_PRECONDITION,
        BLOCKER_EXTERNAL,
    }
)


def classify_blocker(blocked: str) -> str:
    """Classify a blocker without enumerating future Felix-only preconditions."""
    if blocked == BLOCKER_NONE:
        blocker_class = BLOCKER_NONE
    elif blocked in ANSWERABLE_BLOCKERS:
        blocker_class = BLOCKER_ANSWERABLE
    elif blocked.startswith("felix-"):
        blocker_class = BLOCKER_PRECONDITION
    else:
        blocker_class = BLOCKER_EXTERNAL
    assert blocker_class in BLOCKER_CLASSES
    return blocker_class


# Any backtick-quoted token that looks like a path or a filename.
# Brackets and parentheses are in the class for Next.js App Router route groups and
# dynamic segments (`(dashboard)`, `[id]`, `[...slug]`): without them
# `frontend/web/src/app/(dashboard)/puzzle/page.tsx` matched NOTHING at all -- the
# scan stopped dead at the `(` and no shorter match could reach the closing
# backtick. Every route-group path in the ledger was invisible to the duplicate
# check and to decision matching, which is most of this repo's frontend surface.
PATH_RE = re.compile(r"`([A-Za-z0-9_./()\[\]-]*[A-Za-z0-9_)\]-])(?::[\d\-]+)?`")
FENCED_LINE_NUMBER_RE = re.compile(r":\d+(?:-\d+)?$")
FENCED_URL_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*://")
FENCED_TOKEN_LEADING_CHARS = "\"'`([{<*"
FENCED_TOKEN_TRAILING_CHARS = "\"'`.,;:!?)]}>*"
DECISION_RE = re.compile(r"^ {0,3}### (?P<id>d-\d{8}-\d{2}) — (?P<question>.+)$")
# Pending headings are recognized separately until the locked allocator mints an id.
DECISION_PENDING_RE = re.compile(r"^ {0,3}### (?P<id>d-PENDING) — (?P<question>.+)$")
# Match the complete would-be owner token before validating it as a slug. Keeping
# punctuation and additional colons in that token prevents a malformed owner such
# as ``repo.slug:`` or ``repo:slug:`` from being reinterpreted at a valid suffix.
QUALIFIER_TOKEN_RE = r"[^\s`\"'“”‘’()\[\]{}<>,;|*–—]+"
QUALIFIER_LEFT_BOUNDARY_RE = r"(?<![^\s`\"'“”‘’()\[\]{}<>,;|*–—])"
QUALIFIED_DECISION_RE = re.compile(
    QUALIFIER_LEFT_BOUNDARY_RE + rf"(?:(?P<owner>{QUALIFIER_TOKEN_RE}):)?"
    r"(?P<id>d-\d{8}-\d{2})(?![A-Za-z0-9_-])"
)
QUALIFIED_FINDING_RE = re.compile(
    QUALIFIER_LEFT_BOUNDARY_RE + rf"(?:(?P<owner>{QUALIFIER_TOKEN_RE}):)?"
    r"(?P<id>f-\d{8}-\d{2})(?![A-Za-z0-9_-])"
)
INLINE_REFERENCE_RE = re.compile(
    r"\s*(?:(?:(?:[a-z0-9]+(?:-[a-z0-9]+)*):)?"
    r"[df]-\d{8}-\d{2}|-)\s*"
)
# Deliberately looser than the strict form above: it has to CATCH a near-miss
# so validation can reject it. Requiring a digit after `d-` excludes the format
# template in the decisions ledger's own header.
DECISION_MARKER_RE = re.compile(r"^ {0,3}#+\s*d-\d")
# Clause 1 of `tasks/decisions.md` requires every recorded decision to preserve
# the question, chosen option, rejected option, and reason. The ledger contains
# both bare and bulleted forms, and both punctuation forms are established in
# its existing entries.
DECISION_CLAUSE_ONE_FIELDS = ("Question", "Chosen", "Rejected", "Reason")
DECISION_FIELD_RE = {
    field: re.compile(
        rf"^[ \t]*(?:{_BULLET}[ \t]+)?\*\*{field}(?:\.|:)\*\*[ \t]*\S",
        re.MULTILINE,
    )
    for field in DECISION_CLAUSE_ONE_FIELDS
}
GOVERNS_RE = re.compile(r"\*\*Governs:\*\*(?P<ids>.+)")
DECISION_REFERENCE_PATTERN = r"(?:(?:[a-z0-9]+(?:-[a-z0-9]+)*):)?d-\d{8}-\d{2}"
QUOTED_DECISION_REFERENCE_PATTERN = (
    rf"(?:`{DECISION_REFERENCE_PATTERN}`|{DECISION_REFERENCE_PATTERN})"
)
SUPERSEDED_BY_RE = re.compile(
    r"\*\*Superseded-by:\*\*[ \t]*"
    rf"(?P<refs>{QUOTED_DECISION_REFERENCE_PATTERN}"
    rf"(?:[ \t]*,[ \t]*{QUOTED_DECISION_REFERENCE_PATTERN})*|`-`|-)"
    r"[.,;:!?]?(?:\s*$|\s+·)"
)
# Deliberately looser than the strict form above: it has to CATCH a near-miss
# so validation can reject it. A trailer with an unparseable id must not vanish
# from the ledger's validation output just because it is not a link. The second
# branch catches a case-insensitive supersed-ish by-marker and a decision id
# inside one bold run, including a marker with the id inside the bold text.
SUPERSEDED_BY_MARKER_RE = re.compile(
    r"\*\*Superseded-by:\*\*"
    r"|\*\*(?=[^*\n]*d-\d{8}-\d{2}[^*\n]*\*\*)"
    r"[^*\n]*supersed(?:e|ed)?[- ]by\b[^*\n]*\*\*",
    re.IGNORECASE,
)
# Deliberately looser than the strict form below: it has to CATCH a near-miss
# so validation can reject it. Anchored at column 0 it would silently ignore an
# indented bullet, and the link would simply not exist with nothing said.
GOVERNED_BY_MARKER_RE = re.compile(r"^\s*[*-]\s+\*\*Governed-by:\*\*")
GOVERNED_BY_RE = re.compile(
    r"^\* \*\*Governed-by:\*\* "
    rf"(?P<ids>{DECISION_REFERENCE_PATTERN}"
    rf"(?:,\s*{DECISION_REFERENCE_PATTERN})*)\s*$"
)


@dataclass(frozen=True)
class LedgerMeta:
    line: int
    data: dict[str, object]


class DuplicateLedgerMetadataKey(ValueError):
    """A ledger metadata object repeated one JSON key."""


@dataclass(frozen=True)
class CitationOccurrence:
    source: str
    entry: str
    cited_id: str
    owner: str | None
    line: int
    line_text: str
    occurrence: int


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_text(value: str) -> str:
    return _sha256_bytes(value.encode("utf-8"))


def _metadata_line(data: dict[str, object]) -> str:
    return LEDGER_META_PREFIX + json.dumps(
        data, ensure_ascii=True, sort_keys=True, separators=(",", ":")
    ) + LEDGER_META_SUFFIX


def _metadata_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Build a metadata object while rejecting ambiguous duplicate JSON keys."""
    data: dict[str, object] = {}
    for key, value in pairs:
        if key in data:
            raise DuplicateLedgerMetadataKey
        data[key] = value
    return data


def _has_ledger_meta_comment(line: str) -> bool:
    """Recognize reserved metadata comment syntax without banning prose names."""
    marker = line.find("<!--")
    if marker < 0:
        return False
    remainder = line[marker + 4 :].lstrip()
    name = "ledger-meta"
    return remainder.startswith(name) and (
        len(remainder) == len(name)
        or not (remainder[len(name)].isalnum() or remainder[len(name)] in "_-")
    )


def _metadata_schema_issues(meta: LedgerMeta, path: Path) -> list[str]:
    data = meta.data
    where = f"{path}:{meta.line}: ledger-meta"
    kind = data.get("kind")
    version = data.get("v")
    if type(version) is not int or version != LEDGER_META_VERSION:
        return [f"{where}: invalid field 'v' (expected {LEDGER_META_VERSION})"]
    common = {"v", "kind"}
    if kind == MUTATION_RECEIPT_KIND:
        command = data.get("command")
        expected = common | {
            "command", "operation", "request_id_sha256", "target",
            "input_sha256", "options", "results", "effect_lines",
            "effect_sha256",
        }
        if command in ("close", "set-header"):
            expected |= {"header_sha256", "header_status"}
        issues: list[str] = []
        if set(data) != expected:
            issues.append(
                f"{where}: invalid fields for kind {kind}: "
                f"{sorted(set(data) ^ expected)}"
            )
        if not isinstance(command, str) or command not in (
            "annotate", "record-decision", "close", "set-header"
        ):
            issues.append(f"{where}: invalid field 'command'")
        for field_name in ("operation", "input_sha256", "effect_sha256"):
            value = data.get(field_name)
            if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
                issues.append(f"{where}: invalid field {field_name!r}")
        request_hash = data.get("request_id_sha256")
        if request_hash is not None and (
            not isinstance(request_hash, str)
            or SHA256_RE.fullmatch(request_hash) is None
        ):
            issues.append(f"{where}: invalid field 'request_id_sha256'")
        if not isinstance(data.get("target"), str):
            issues.append(f"{where}: invalid field 'target'")
        if command in ("close", "set-header"):
            header_hash = data.get("header_sha256")
            if not isinstance(header_hash, str) or SHA256_RE.fullmatch(header_hash) is None:
                issues.append(f"{where}: invalid field 'header_sha256'")
            header_status = data.get("header_status")
            if not isinstance(header_status, str) or header_status not in STATUSES:
                issues.append(f"{where}: invalid field 'header_status'")
        options = data.get("options")
        option_fields = {"section", "headers"} if command == "set-header" else {"section"}
        if not isinstance(options, dict) or set(options) != option_fields:
            issues.append(f"{where}: invalid field 'options'")
        elif options["section"] is not None and not isinstance(options["section"], str):
            issues.append(f"{where}: invalid field 'options.section'")
        if command == "set-header" and isinstance(options, dict):
            headers = options.get("headers")
            if (
                options.get("section") is not None
                or not isinstance(headers, dict)
                or not headers
                or not set(headers) <= {"Status", "Blocked", "Root", "Entry"}
            ):
                issues.append(f"{where}: invalid field 'options.headers'")
            else:
                for field, value in headers.items():
                    try:
                        if not isinstance(value, str):
                            raise LedgerError("invalid header value")
                        _checked_header_value(field, value)
                    except LedgerError:
                        issues.append(f"{where}: invalid field 'options.headers.{field}'")
        results = data.get("results")
        results_invalid = (
            not isinstance(results, list)
            or not results
            or not all(isinstance(value, str) for value in results)
        )
        if isinstance(results, list) and results:
            if command == "annotate":
                results_invalid = results_invalid or not all(
                    isinstance(value, str) and ID_RE.fullmatch(value)
                    for value in results
                )
            elif command == "record-decision":
                results_invalid = results_invalid or not all(
                    isinstance(value, str)
                    and DECISION_RE.fullmatch(f"### {value} — x")
                    for value in results
                )
        if results_invalid:
            issues.append(f"{where}: invalid field 'results'")
        effect_lines = data.get("effect_lines")
        if (
            not isinstance(effect_lines, int)
            or isinstance(effect_lines, bool)
            or effect_lines <= 0
        ):
            issues.append(f"{where}: invalid field 'effect_lines'")
        if not issues:
            options = cast(dict[str, object], data["options"])
            operation_source = (
                {
                    "command": data["command"],
                    "request_id_sha256": data["request_id_sha256"],
                }
                if data["request_id_sha256"] is not None
                else {
                    "command": data["command"],
                    "target": data["target"],
                    "input_sha256": data["input_sha256"],
                    "section": options["section"],
                }
            )
            if command == "set-header" and data["request_id_sha256"] is None:
                operation_source["headers"] = options["headers"]
            expected_operation = _sha256_text(
                json.dumps(operation_source, sort_keys=True, separators=(",", ":"))
            )
            if data["operation"] != expected_operation:
                issues.append(f"{where}: invalid field 'operation'")
        return issues
    if kind == CITATION_CONTEXT_KIND:
        base = common | {
            "source", "entry", "cited", "line_sha256", "occurrence", "status"
        }
        status = data.get("status")
        expected = base | (
            {"owner"} if status == "external" else {"corrections", "reason"}
        )
        issues = []
        if set(data) != expected:
            issues.append(
                f"{where}: invalid fields for kind {kind}: "
                f"{sorted(set(data) ^ expected)}"
            )
        source = data.get("source")
        if not isinstance(source, str) or source not in ("findings", "decisions"):
            issues.append(f"{where}: invalid field 'source'")
        entry = data.get("entry")
        if not isinstance(entry, str) or re.fullmatch(
            r"[fd]-\d{8}-\d{2}", entry
        ) is None:
            issues.append(f"{where}: invalid field 'entry'")
        cited = data.get("cited")
        if not isinstance(cited, str) or re.fullmatch(
            r"d-\d{8}-\d{2}", cited
        ) is None:
            issues.append(f"{where}: invalid field 'cited'")
        line_hash = data.get("line_sha256")
        if not isinstance(line_hash, str) or SHA256_RE.fullmatch(line_hash) is None:
            issues.append(f"{where}: invalid field 'line_sha256'")
        occurrence = data.get("occurrence")
        if (
            not isinstance(occurrence, int)
            or isinstance(occurrence, bool)
            or occurrence <= 0
        ):
            issues.append(f"{where}: invalid field 'occurrence'")
        if status == "external":
            owner = data.get("owner")
            if (
                not isinstance(owner, str)
                or owner == "local"
                or SLUG_RE.fullmatch(owner) is None
            ):
                issues.append(f"{where}: invalid field 'owner'")
        elif status == "historical-error":
            corrections = data.get("corrections")
            if (
                not isinstance(corrections, list)
                or not corrections
                or not all(
                    isinstance(value, str)
                    and re.fullmatch(r"d-\d{8}-\d{2}", value)
                    for value in corrections
                )
            ):
                issues.append(f"{where}: invalid field 'corrections'")
            reason = data.get("reason")
            if not isinstance(reason, str) or not reason.strip():
                issues.append(f"{where}: invalid field 'reason'")
        else:
            issues.append(f"{where}: invalid field 'status'")
        return issues
    return [f"{where}: unknown metadata kind"]


def _scan_ledger_metadata(text: str, path: Path) -> tuple[list[LedgerMeta], list[str]]:
    lines = text.splitlines()
    mask = _fence_mask(lines)
    found: list[LedgerMeta] = []
    issues: list[str] = []
    for index, line in enumerate(lines):
        if (
            mask[index] is not FenceState.OUTSIDE
            or not _has_ledger_meta_comment(line)
        ):
            continue
        where = f"{path}:{index + 1}"
        if not (line.startswith(LEDGER_META_PREFIX) and line.endswith(LEDGER_META_SUFFIX)):
            issues.append(f"{where}: malformed reserved ledger-meta marker")
            continue
        payload = line[len(LEDGER_META_PREFIX) : -len(LEDGER_META_SUFFIX)]
        try:
            data = json.loads(payload, object_pairs_hook=_metadata_object)
        except DuplicateLedgerMetadataKey:
            issues.append(f"{where}: duplicate ledger-meta JSON key")
            continue
        except _JSON_ERRORS:
            issues.append(f"{where}: malformed ledger-meta JSON")
            continue
        if not isinstance(data, dict):
            issues.append(f"{where}: ledger-meta payload must be an object")
            continue
        meta = LedgerMeta(index + 1, data)
        found.append(meta)
        issues.extend(_metadata_schema_issues(meta, path))
    return found, issues


def _receipt_effect_issues(
    text: str, path: Path, metadata: list[LedgerMeta]
) -> list[str]:
    lines = text.splitlines()
    fence_states = _fence_mask(lines)
    issues: list[str] = []
    seen: dict[tuple[str, str], int] = {}
    finding_at_line: dict[int, str] = {}
    if "**Area vocabulary:**" in text.split("### ", 1)[0]:
        _found_lines, headers, _orphans = _unfenced_header_matches(
            text, fence_states
        )
        for heading_index, header_index, match in headers:
            end = _find_entry_span(lines, fence_states, header_index)
            for index in range(heading_index, end):
                finding_at_line[index + 1] = match.group("id")
    for meta in metadata:
        data = meta.data
        if (
            data.get("kind") != MUTATION_RECEIPT_KIND
            or _metadata_schema_issues(meta, path)
        ):
            continue
        command = str(data["command"])
        operation = str(data["operation"])
        duplicate = seen.get((command, operation))
        if duplicate is not None:
            issues.append(
                f"{path}:{meta.line}: duplicate mutation receipt identity; "
                f"first seen at line {duplicate}"
            )
        else:
            seen[(command, operation)] = meta.line
        count = cast(int, data["effect_lines"])
        start = meta.line - 1 - count
        if start < 0:
            issues.append(
                f"{path}:{meta.line}: mutation receipt effect_lines exceeds "
                "preceding content"
            )
            continue
        effect = lines[start : meta.line - 1]
        if _sha256_text("\n".join(effect)) != data["effect_sha256"]:
            issues.append(
                f"{path}:{meta.line}: mutation receipt effect_sha256 does not "
                "match its preceding effect block"
            )
            continue
        results = cast(list[str], data["results"])
        target = str(data["target"])
        if command in {"annotate", "close", "set-header"}:
            if results != [target] or ID_RE.fullmatch(target) is None:
                issues.append(
                    f"{path}:{meta.line}: {command} receipt has inconsistent "
                    "target/results"
                )
            effect_lines = range(start + 1, meta.line + 1)
            if any(finding_at_line.get(number) != target for number in effect_lines):
                issues.append(
                    f"{path}:{meta.line}: {command} receipt/effect is outside "
                    f"target finding {target}"
                )
            if command in {"close", "set-header"}:
                target_headers = [
                    (index, match)
                    for _heading, index, match in _unfenced_header_matches(
                        text, fence_states
                    )[1]
                    if match.group("id") == target
                ]
                if len(target_headers) != 1:
                    issues.append(
                        f"{path}:{meta.line}: {command} receipt target {target} has "
                        "no unique finding header"
                    )
                else:
                    header_index, header_match = target_headers[0]
                    if (
                        _sha256_text(lines[header_index]) != data.get("header_sha256")
                        or header_match.group("status") != data.get("header_status")
                    ):
                        issues.append(
                            f"{path}:{meta.line}: {command} receipt header effect does "
                            f"not match finding {target}"
                        )
        else:
            if target != "decisions-ledger" or not results:
                issues.append(
                    f"{path}:{meta.line}: record-decision receipt has "
                    "inconsistent target/results"
                )
            headings = [
                match.group("id")
                for _index, match in _decision_heading_matches(chr(10).join(effect))[1]
            ]
            if headings != results:
                issues.append(
                    f"{path}:{meta.line}: record-decision receipt results do "
                    "not match effect headings"
                )
    return issues


# Suffixes that make a path-shaped token a real source file. `Finding.paths()` is
# deliberately loose -- it feeds a duplicate check where a spurious candidate costs
# one line of output -- so it also yields `React.memo` and `test.fixme`. That is
# harmless between findings and NOT harmless when matching decisions to a cluster:
# `React.memo` appears in most frontend prose in this repo, so an unfiltered overlap
# would surface half the decision ledger and the mechanism would be ignored as noise.
# Rust's `.rs` suffix counts only under the impact-queue contract (level ≥ 2).
SOURCE_SUFFIXES = frozenset(
    {
        ".cjs",
        ".conf",
        ".css",
        ".dart",
        ".html",
        ".ini",
        ".js",
        ".json",
        ".jsx",
        ".lock",
        ".md",
        ".mjs",
        ".py",
        ".sh",
        ".sql",
        ".toml",
        ".ts",
        ".tsx",
        ".txt",
        ".yaml",
        ".yml",
    }
)


def scan_paths(body: list[str], body_fenced: list[bool]) -> set[str]:
    """Every path-shaped token anywhere in a ledger entry's body.

    Deliberately not restricted to the ``**Where:**`` bullet: a file named only
    in a ``**Defect:**`` or ``**Fix shape:**`` bullet is exactly the overlap a
    pre-filing duplicate check has to catch.

    Fenced tracebacks and snippets usually contain bare paths rather than
    backtick-quoted ones. Their slash requirement and repo-root check keep
    URL and version-number noise out while still making those paths visible.

    Shared by findings and decisions: matching the two by the files they name is
    the only linkage that works without one of them already knowing the other
    exists, which the hand-written ``Governs:`` / ``Governed-by:`` fields cannot.
    """
    out: set[str] = set()
    fenced_out: set[str] = set()
    for index, line in enumerate(body):
        is_fenced = index < len(body_fenced) and body_fenced[index]
        if not is_fenced:
            out.update(PATH_RE.findall(line))
            continue
        for raw_token in line.split():
            token = raw_token.lstrip(FENCED_TOKEN_LEADING_CHARS).rstrip(
                FENCED_TOKEN_TRAILING_CHARS
            )
            token = FENCED_LINE_NUMBER_RE.sub("", token)
            if "/" not in token or FENCED_URL_RE.match(token):
                continue
            candidate = Path(token)
            if candidate.is_absolute() and REPO_ROOT is not None:
                try:
                    token = candidate.resolve().relative_to(REPO_ROOT).as_posix()
                except ValueError:
                    continue
            fenced_out.add(token)
    return {p for p in out if "/" in p or "." in p} | fenced_out


# Filenames that the App Router assigns by convention, so dozens of unrelated files
# share each one. A basename match on these carries no information -- it says both
# entries touch *a* route, not the same route -- and the decisions it surfaced in
# testing were uniformly wrong. Bare basenames are excluded rather than denylisted
# case by case, because the ambiguity is a property of the framework, not of this repo.
# Full paths still identify one source file under the impact-queue contract.
AMBIGUOUS_BASENAMES = frozenset(
    f"{stem}{suffix}"
    for stem in (
        "default",
        "error",
        "global-error",
        "index",
        "layout",
        "loading",
        "not-found",
        "page",
        "page.test",
        "route",
        "template",
    )
    for suffix in (".ts", ".tsx", ".js", ".jsx")
)


# Files that are real sources without carrying a suffix.
EXTENSIONLESS_SOURCES = frozenset({"Dockerfile", "Makefile", "Procfile"})

# How many shared filenames to print beside an advisory match. Enough to show why the
# decision surfaced without turning one line into a paragraph; the reader opens the
# decision for the rest.
SHARED_FILES_SHOWN = 3


def _is_source_name(name: str) -> bool:
    if name in AMBIGUOUS_BASENAMES:
        return False
    if name in EXTENSIONLESS_SOURCES:
        return True
    suffix = PurePosixPath(name).suffix.lower()
    return suffix in SOURCE_SUFFIXES or (suffix == ".rs" and _impact_queue_enabled())


def source_file_keys(paths: set[str]) -> tuple[set[str], set[str]]:
    """Split a body's path tokens into (full paths, bare filenames).

    Kept apart because the two ledgers cite the same file at different depths: a
    finding writes ``frontend/web/src/.../usePuzzleSubmission.ts:739`` while a
    decision's prose writes ``usePuzzleSubmission.ts:284``. Collapsing everything to
    a basename connects that pair -- and also connects pairs that must NOT be
    connected. Measured on the live ledger: `backend/app/core/auth.py` and
    `backend/app/api/routes/auth.py` are two different files, and collapsing both to
    ``auth.py`` surfaced `d-20260822-14` for `f-20260821-28`, which it does not
    govern. So a basename is used only where a basename is all one side supplied.
    Bare framework-convention basenames never match. Under the impact-queue
    contract, full paths ending in one match only the identical full path.
    """
    full: set[str] = set()
    bare: set[str] = set()
    for path in paths:
        name = PurePosixPath(path).name
        convention_path = (
            _impact_queue_enabled() and "/" in path and name in AMBIGUOUS_BASENAMES
        )
        if not convention_path and not _is_source_name(name):
            continue
        if "/" in path:
            full.add(path)
        else:
            bare.add(name)
    return full, bare


def shared_source_files(
    left: tuple[set[str], set[str]], right: tuple[set[str], set[str]]
) -> set[str]:
    """The files both sides name, requiring a full match wherever both gave one."""
    left_full, left_bare = left
    right_full, right_bare = right
    shared = left_full & right_full
    left_names = {PurePosixPath(p).name for p in left_full}
    right_names = {PurePosixPath(p).name for p in right_full}
    shared |= left_bare & right_bare
    shared |= left_bare & right_names
    shared |= right_bare & left_names
    return shared


@dataclass
class Finding:
    id: str
    status: str
    area: str
    root: str
    entry: str
    blocked: str
    title: str
    section: str
    line: int
    body: list[str] = field(default_factory=list)
    body_fenced: list[bool] = field(default_factory=list)
    governed_by: set[str] = field(default_factory=set)
    # Set only for a finding read from a Controller export: it has no source-byte
    # slice of its own, so its ``list --raw`` identity is the digest of its
    # canonical JSON object instead.
    source_sha256: str | None = None

    @property
    def controller_export(self) -> bool:
        """Controller blockers are opaque wait keys; validation branches on this."""
        return self.source_sha256 is not None

    @property
    def pickable(self) -> bool:
        return (
            self.status == "open"
            and classify_blocker(self.blocked) == BLOCKER_NONE
        )

    @property
    def cluster_key(self) -> tuple[str, str]:
        """Return the raw Root relation.

        Queue ranking applies its two-carrier rule separately.
        """
        return ("root", self.root) if self.root != "-" else ("finding", self.id)

    def paths(self) -> set[str]:
        """Every path-shaped token anywhere in the body."""
        return scan_paths(self.body, self.body_fenced)

    def impact_class(self, tooling_areas: Collection[str] = ()) -> tuple[str, bool]:
        """Return the effective impact class and whether its last bullet is explicit."""
        body = _unfenced_body(self)
        matches = list(IMPACT_CLASS_RE.finditer(body))
        if matches:
            return matches[-1].group("value").strip(), True
        if _body_is_sentry_origin(body):
            return "behaviour", False
        if self.area in tooling_areas:
            return "tooling", False
        return "unclassified", False

    def summary(self) -> str:
        """Two-line rendering: header facts, then the title."""
        flag = (
            f"  [{self.blocked}]"
            if classify_blocker(self.blocked) != BLOCKER_NONE
            else ""
        )
        root = f" root={self.root}" if self.root != "-" else ""
        return (
            f"{self.id}  {self.status:<8} {self.area:<20}{root} "
            f"entry={self.entry}{flag}\n    {self.title}"
        )


@dataclass(frozen=True)
class SummaryBuckets:
    """One classification of a parsed ledger, for every counting consumer.

    Consumers that print or count Felix-facing classes read these fields
    instead of re-deriving them, so the overview, the drain's start screen and
    ``decisions`` cannot disagree about which finding waits on what.

    """

    total: int
    handled: int
    rejected: int
    open_: int
    pickable: tuple[Finding, ...]
    product: tuple[Finding, ...]
    preconditions: tuple[Finding, ...]
    external: tuple[Finding, ...]
    skipped_tooling: tuple[Finding, ...] = ()

    @property
    def answerable(self) -> tuple[Finding, ...]:
        return self.product

    @property
    def blocked(self) -> int:
        """Every open finding whose blocker is not ``none``."""
        return (
            len(self.product)
            + len(self.preconditions)
            + len(self.external)
        )


def summary_buckets(
    findings: list[Finding], *, exclude_tooling: bool = False,
    tooling_areas: Collection[str] = (),
) -> SummaryBuckets:
    """Classify parsed findings into the four blocker classes exactly once."""
    handled = 0
    rejected = 0
    open_findings: list[Finding] = []
    for finding in findings:
        if finding.status == "handled":
            handled += 1
        elif finding.status == "rejected":
            rejected += 1
        elif finding.status == "open":
            open_findings.append(finding)
    product = tuple(
        finding
        for finding in open_findings
        if finding.blocked == FELIX_DECISION
    )
    preconditions = tuple(
        finding
        for finding in open_findings
        if classify_blocker(finding.blocked) == BLOCKER_PRECONDITION
    )
    external = tuple(
        finding
        for finding in open_findings
        if classify_blocker(finding.blocked) == BLOCKER_EXTERNAL
    )
    keys = _effective_queue_cluster_keys(
        findings, exclude_tooling=exclude_tooling, tooling_areas=tooling_areas
    )
    eligible = {
        finding.id for finding, key in zip(findings, keys, strict=True)
        if key is not None
    }
    return SummaryBuckets(
        total=len(findings),
        handled=handled,
        rejected=rejected,
        open_=len(open_findings),
        pickable=tuple(
            finding for finding in open_findings
            if finding.pickable and finding.id in eligible
        ),
        product=product,
        preconditions=preconditions,
        external=external,
        skipped_tooling=tuple(
            finding for finding in open_findings
            if finding.pickable and finding.id not in eligible
        ),
    )


def _summary_counts_line(buckets: SummaryBuckets) -> str:
    """The one counts line, byte-identical to the drain's historical summary."""

    def amount(count, singular, plural):
        return "%d %s" % (count, singular if count == 1 else plural)

    return "%s (%s, %s, %s); %s; %s (%s, %s, %s)" % (
        amount(buckets.total, "finding", "findings"),
        amount(buckets.handled, "handled", "handled"),
        amount(buckets.rejected, "rejected", "rejected"),
        amount(buckets.open_, "open", "open"),
        amount(len(buckets.pickable), "pickable finding", "pickable findings"),
        amount(buckets.blocked, "blocked finding", "blocked findings"),
        amount(len(buckets.product), "decision", "decisions"),
        amount(
            len(buckets.preconditions), "Felix precondition", "Felix preconditions"
        ),
        amount(
            len(buckets.external),
            "external/technical blocker",
            "external/technical blockers",
        ),
    )


@dataclass
class Decision:
    id: str
    question: str
    governs: set[str]
    # Replacement references named by the trailer, empty while still current.
    superseded_by: str = ""
    # 1-based line of the heading. Only a duplicate-id report needs it, but it is
    # carried on the record rather than rescanned: a second scan is a second
    # parser, and the two drift the moment the heading format moves.
    line: int = 0
    body: list[str] = field(default_factory=list)
    body_fenced: list[bool] = field(default_factory=list)

    def paths(self) -> set[str]:
        """Every path-shaped token anywhere in the decision's body."""
        return scan_paths(self.body, self.body_fenced)


@dataclass(frozen=True)
class FindingExpectation:
    """Captured semantic content that an additive ledger update must preserve."""

    identifier: str
    status: str
    area: str
    root: str
    entry: str
    blocked: str
    title: str
    body: tuple[str, ...]
    body_fenced: tuple[bool, ...]
    governed_by: frozenset[str]


@dataclass(frozen=True)
class DecisionExpectation:
    """Captured semantic content that an additive decision update must preserve."""

    identifier: str
    question: str
    governs: frozenset[str]
    superseded_by: str
    body: tuple[str, ...]
    body_fenced: tuple[bool, ...]


@dataclass(frozen=True)
class AnswerExpectation:
    """Header transition and one additional evidence block from apply-answers."""

    status: str
    blocked: str
    evidence: tuple[str, ...]
    previous_occurrences: int
    previous_line_occurrences: dict[str, int]
    kind: str = "decision"


class LedgerError(Exception):
    pass


class LedgerReadRefused(LedgerError):
    """Committed ledger preservation could not be established."""


LEDGER_ROLLBACK_PREFIX = "ledger rollback refused:"
LEDGER_KEPT_CHANGING_CAUSE = "the committed ledger kept changing during the read"
LEDGER_READ_ATTEMPTS = 3
_GUARDED_LEDGER_PATHS: dict[Path, str] = {}
_LEDGER_ROLLBACK_CACHE: dict[tuple[str, str, str], tuple[list[str], int]] = {}
_LEDGER_BLOB_CACHE: dict[str, bytes] = {}


def _ledger_content(
    text: str, kind: str, *, strict: bool = True
) -> tuple[frozenset[str], frozenset[tuple[str, str]]]:
    """Extract the append-only identities using the ordinary ledger parsers."""
    path = Path(f"{kind}.md")
    metadata, issues = _scan_ledger_metadata(text, path)
    if kind == "findings":
        lines, headings, orphans = _unfenced_header_matches(text)
        mask = _fence_mask(lines)
        if not load_vocabulary(lines, mask):
            issues.append("missing area vocabulary")
        if orphans:
            issues.append("orphaned finding headers")
        attached = {index for index, _, _ in headings}
        issues += [
            f"finding heading without a header: {line}"
            for index, (line, state) in enumerate(zip(lines, mask, strict=True))
            if state is FenceState.OUTSIDE and line.startswith("### ") and index not in attached
        ]
        ids = frozenset(match.group("id") for _, _, match in headings)
    elif kind == "decisions":
        lines, headings = _decision_heading_matches(text)
        ids = frozenset(match.group("id") for _, match in headings)
        mask = _fence_mask(lines)
        issues += [
            f"malformed decision heading: {line}"
            for line, state in zip(lines, mask, strict=True)
            if state is FenceState.OUTSIDE and line.startswith("### d-")
            and DECISION_RE.match(line) is None
        ]
    else:
        raise ValueError("ledger kind must be findings or decisions")
    if strict and issues:
        raise LedgerError("could not parse ledger identities: " + ", ".join(issues))
    receipts = frozenset(
        (str(meta.data["command"]), str(meta.data["operation"]))
        for meta in metadata
        if meta.data.get("kind") == MUTATION_RECEIPT_KIND
        and isinstance(meta.data.get("command"), str)
        and isinstance(meta.data.get("operation"), str)
    )
    return ids, receipts


def _ledger_rollback(parent: str, candidate: str, kind: str) -> tuple[list[str], int]:
    """Return dropped entry IDs and the count of dropped receipt identities."""
    # Controller SQLite owns exports, and enrolment regenerates markdown into
    # one. The writer refuses to write or commit them, so this guard does not apply.
    if is_controller_export(parent) or is_controller_export(candidate):
        return [], 0
    try:
        parent_ids, parent_receipts = _ledger_content(parent, kind)
    except LedgerError as exc:
        raise LedgerError(f"HEAD does not validate ({exc})") from exc
    candidate_ids, candidate_receipts = _ledger_content(candidate, kind, strict=False)
    return sorted(parent_ids - candidate_ids), len(parent_receipts - candidate_receipts)


def _ledger_guard_refusal(cause: str) -> bool:
    return (
        cause.startswith(LEDGER_ROLLBACK_PREFIX)
        or LEDGER_KEPT_CHANGING_CAUSE in cause
    )


def _rollback_remedy(path: Path) -> str:
    return (
        "A concurrent commit's pre-commit stash may be holding the file. "
        "Retry once that commit has finished. If it persists, inspect "
        f"git diff HEAD -- {path}"
    )


def _ledger_parent_bytes(root: Path, blob: str) -> bytes:
    if blob not in _LEDGER_BLOB_CACHE:
        result = _git_for_ledger_bytes(root, "cat-file", "blob", blob)
        if result.returncode != 0:
            raise LedgerError(f"could not read committed ledger blob {blob}")
        _LEDGER_BLOB_CACHE[blob] = result.stdout
    return _LEDGER_BLOB_CACHE[blob]


def _refuse_ledger_rollback(
    root: Path, path: Path, blob: str | None, parent: str, candidate: bytes, kind: str
) -> None:
    if blob is None:
        return
    key = (blob, _sha256_bytes(candidate), kind)
    try:
        if key not in _LEDGER_ROLLBACK_CACHE:
            _LEDGER_ROLLBACK_CACHE[key] = _ledger_rollback(
                _ledger_parent_bytes(root, blob).decode("utf-8"), candidate.decode("utf-8"), kind
            )
        ids, receipts = _LEDGER_ROLLBACK_CACHE[key]
    except (LedgerError, UnicodeError) as exc:
        raise LedgerReadRefused(
            f"{LEDGER_ROLLBACK_PREFIX} {path}, parent {parent}: {exc}"
        ) from exc
    if ids or receipts:
        raise LedgerReadRefused(
            f"{LEDGER_ROLLBACK_PREFIX} {path}, parent {parent}: "
            f"dropped IDs {', '.join(ids) or '(none)'}, {receipts} receipt identities"
        )


def _head_ledger_blob(root: Path, relative: str) -> str | None:
    result = _git_for_ledger(root, "rev-parse", "--verify", "-q", "HEAD^{commit}")
    if result.returncode == 1 and not result.stdout.strip() and not result.stderr.strip():
        return None
    if result.returncode != 0:
        raise LedgerError(f"could not resolve HEAD: {_git_failure_detail(result)}")
    return _head_file_blob(root, result.stdout.strip(), relative)


def _read_working_ledger(path: Path, *, binary: bool) -> bytes | str:
    """Read a working ledger against a stable HEAD blob for persisting CLI calls."""
    def read() -> bytes | str:
        return path.read_bytes() if binary else path.read_text(encoding="utf-8")

    if not _GUARDED_LEDGER_PATHS:
        return read()
    resolved = _resolved_repo_path(path)
    kind = _GUARDED_LEDGER_PATHS.get(resolved)
    if kind is None:
        return read()
    root = cast(Path, REPO_ROOT).resolve()
    if not resolved.is_relative_to(root):
        return read()
    relative = _repo_relative(resolved, root)
    try:
        for _ in range(LEDGER_READ_ATTEMPTS):
            before = _head_ledger_blob(root, relative)
            missing: FileNotFoundError | None = None
            try:
                candidate = read()
            except FileNotFoundError as exc:
                missing = exc
                candidate = b"" if binary else ""
            after = _head_ledger_blob(root, relative)
            if before != after:
                continue
            candidate_bytes = candidate if isinstance(candidate, bytes) else candidate.encode("utf-8")
            _refuse_ledger_rollback(root, path, before, f"HEAD blob {before}", candidate_bytes, kind)
            if missing is not None:
                raise missing
            return candidate
    except LedgerError as exc:
        if isinstance(exc, LedgerReadRefused):
            raise LedgerReadRefused(f"{exc}. {_rollback_remedy(path)}") from exc
        raise LedgerReadRefused(
            f"{LEDGER_ROLLBACK_PREFIX} {path}, parent HEAD blob: {exc}. {_rollback_remedy(path)}"
        ) from exc
    raise LedgerReadRefused(
        f"{path}: {LEDGER_KEPT_CHANGING_CAUSE}. Retry. "
        + _rollback_remedy(path)
    )


def _read_ledger_bytes(path: Path) -> bytes:
    return cast(bytes, _read_working_ledger(path, binary=True))


def _read_ledger_text(path: Path) -> str:
    return cast(str, _read_working_ledger(path, binary=False))


def _ledger_path_exists(path: Path) -> bool:
    if path.exists():
        return True
    if _GUARDED_LEDGER_PATHS and _resolved_repo_path(path) in _GUARDED_LEDGER_PATHS:
        with suppress(FileNotFoundError):
            _read_ledger_text(path)
    return False


class PublishLockBusyError(LedgerError):
    """The bounded publish fence did not become available."""


class LedgerDirtyError(LedgerError):
    """The consumer requested an answer-only commit over foreign ledger dirt."""


class LedgerSupersededError(LedgerError):
    """A foreign ledger commit superseded this command's saved replacement."""


class KeptAnswersClaimError(LedgerError):
    """An answers claim has an inconsistent durable effect and needs repair."""

    def __init__(self, claim: Path, ids: Collection[str]) -> None:
        self.claim = claim
        self.ids = tuple(sorted(set(ids)))
        super().__init__(
            f"answers claim {claim} has an inconsistent HEAD effect for "
            f"{', '.join(self.ids)}; kept for manual repair"
        )


class ManualRepairAnswersClaimError(LedgerError):
    """An answers claim was marked for repair while a consumer was starting."""

    def __init__(self, ids: Collection[str]) -> None:
        self.ids = tuple(sorted(set(ids)))
        super().__init__(
            "answers claim kept for manual repair: " + ",".join(self.ids)
        )


@dataclass
class LedgerCommitIntent:
    """One CLI command's semantic obligation for a replaced ledger."""

    command: str
    ledger: Path
    findings: Path
    decisions: Path
    subject: str = ""
    expected_head: str | None = None
    head_at_write: str | None = None
    identifiers: tuple[str, ...] = ()
    postcondition: Callable[[Path, Path], bool] | None = None
    replaced: bool = False
    written_bytes: bytes | None = None
    companion: Path | None = None
    companion_bytes: bytes | None = None
    claim: Path | None = None
    finalize: Callable[[], str] | None = None
    provisional: tuple[str, ...] = ()
    allocation_lock: Path | None = None


@dataclass(frozen=True)
class LedgerCommitResult:
    """Whether a ledger commit obligation was proven durable."""

    durable: bool
    cause: str = ""
    # A branch ref can be durable even when index refresh or the final
    # postcondition read fails. Keep that head so callers never describe the
    # created commit as absent or retry it into a second commit.
    durable_head: str = ""
    phase: str = "before-update-ref"


@dataclass(frozen=True)
class ClaimIntent:
    """The validated durable state describing one inbox or answers claim."""

    phase: str
    ids: list[str]
    receipt_ids: dict[str, str | dict[str, str]]
    has_receipt_ids: bool
    fixed: set[str]
    has_fixed: bool
    claimed: tuple[Path, ...]
    files: dict[str, dict[str, object]] | None = None
    quarantined: dict[str, str] = field(default_factory=dict)
    manual_repair: bool = False
    refused: bool = False
    provisional_ids: dict[str, set[str]] | None = None


@dataclass(frozen=True)
class HeadSnapshot:
    """The committed ledger blobs and validation result from one HEAD."""

    findings_text: str | None
    valid: bool
    detail: str
    tasks_dir: Path


@dataclass(frozen=True)
class Reconciliation:
    """The outcome of classifying a prepared inbox or answers claim."""

    absent: list[Path]
    receipt_names: dict[str, str]
    fixed: set[str]
    released: bool
    replay: bool = False
    refused: bool = False
    provisional_ids: dict[str, set[str]] = field(default_factory=dict)


_ACTIVE_LEDGER_COMMIT: LedgerCommitIntent | None = None


def _note_ledger_replacement(path: Path, text: str) -> None:
    """Signal replacement immediately, before durability or cleanup can fail."""
    intent = _ACTIVE_LEDGER_COMMIT
    if intent is not None and path == intent.ledger:
        intent.replaced = True
        intent.written_bytes = text.encode("utf-8")
        root = REPO_ROOT
        if root is None:
            intent.head_at_write = None
            return
        try:
            intent.head_at_write = _resolve_head(root.resolve())
        except (LedgerError, OSError, UnicodeError, RuntimeError):
            # An unborn repository has no commit to compare. The commit helper
            # will report its inability to commit later; recording no baseline
            # here keeps the replacement notification itself non-fatal.
            intent.head_at_write = None


def _register_ledger_commit(
    subject: str,
    identifiers: Collection[str],
    postcondition: Callable[[Path, Path], bool],
) -> None:
    """Attach the subject and semantic HEAD check before ledger replacement."""
    intent = _ACTIVE_LEDGER_COMMIT
    if intent is None:
        return
    intent.subject = subject
    intent.identifiers = tuple(identifiers)
    intent.postcondition = postcondition


def _finding_expectation(finding: Finding) -> FindingExpectation:
    return FindingExpectation(
        identifier=finding.id,
        status=finding.status,
        area=finding.area,
        root=finding.root,
        entry=finding.entry,
        blocked=finding.blocked,
        title=finding.title,
        body=tuple(finding.body),
        body_fenced=tuple(finding.body_fenced),
        governed_by=frozenset(finding.governed_by),
    )


def _decision_expectation(decision: Decision) -> DecisionExpectation:
    return DecisionExpectation(
        identifier=decision.id,
        question=decision.question,
        governs=frozenset(decision.governs),
        superseded_by=decision.superseded_by,
        body=tuple(decision.body),
        body_fenced=tuple(decision.body_fenced),
    )


def _ordered_content_preserved(
    expected: tuple[object, ...], actual: tuple[object, ...]
) -> bool:
    """Accept insertions while requiring every captured item in its original order."""
    remaining = iter(actual)
    return all(any(item == candidate for candidate in remaining) for item in expected)


def _finding_matches_expectation(
    finding: Finding, expected: FindingExpectation
) -> bool:
    return (
        finding.status == expected.status
        and finding.root == expected.root
        and finding.entry == expected.entry
        and finding.blocked == expected.blocked
        and _finding_identity_preserved(expected, finding)
        and frozenset(finding.governed_by) == expected.governed_by
    )


def _finding_identity_preserved(
    expected: FindingExpectation, finding: Finding
) -> bool:
    """Match the immutable identity of a claimed finding entry."""
    return (
        finding.title == expected.title
        and finding.area == expected.area
        and _ordered_content_preserved(
            tuple(zip(expected.body, expected.body_fenced, strict=True)),
            tuple(zip(finding.body, finding.body_fenced, strict=True)),
        )
    )


def _findings_preserved(
    expected: Collection[FindingExpectation], findings: Collection[Finding]
) -> bool:
    actual = {finding.id: finding for finding in findings}
    return all(
        (finding := actual.get(item.identifier)) is not None
        and _finding_matches_expectation(finding, item)
        for item in expected
    )


def _decision_matches_expectation(
    decision: Decision, expected: DecisionExpectation
) -> bool:
    return (
        decision.question == expected.question
        and frozenset(decision.governs) == expected.governs
        and decision.superseded_by == expected.superseded_by
        and _ordered_content_preserved(
            tuple(zip(expected.body, expected.body_fenced, strict=True)),
            tuple(zip(decision.body, decision.body_fenced, strict=True)),
        )
    )


def _ledger_snapshot_valid(path: Path, ledger_kind: str) -> bool:
    """Read-only structural and receipt validation for one standalone ledger."""
    text = _read_ledger_text(path)
    metadata, issues = _scan_ledger_metadata(text, path)
    issues += _receipt_effect_issues(text, path, metadata)
    if ledger_kind == "findings":
        findings, problems, vocabulary = parse(path)
        issues += validate(findings, problems, vocabulary)
    else:
        issues += malformed_decision_headings(path)
        issues += malformed_superseded_trailers(path)
        issues += duplicate_decision_ids(path)
    return not issues


def _pure_insertions(base: list[str], side: list[str]) -> dict[int, list[str]] | None:
    """Decompose ``side`` into ``base`` plus inserted blocks keyed by base index.

    Greedy leftmost matching: ``base`` is a subsequence of ``side`` exactly when
    every base line is found, so ``None`` means the side deleted or rewrote a
    line and is not a pure append. An inserted line equal to the next base
    line is matched as that base line and shifts its block by one; the block
    stays contiguous either way, which is the property the receipts need.
    """
    blocks: dict[int, list[str]] = {}
    cursor = 0
    for index, line in enumerate(base):
        start = cursor
        while cursor < len(side) and side[cursor] != line:
            cursor += 1
        if cursor == len(side):
            return None
        if cursor > start:
            blocks[index] = side[start:cursor]
        cursor += 1
    if cursor < len(side):
        blocks[len(base)] = side[cursor:]
    return blocks


def merge_ledger_blocks(
    base: str, ours: str, theirs: str, *, preserve_line_endings: bool = False
) -> str | None:
    """Merge independent base-relative edits, keeping insertion blocks whole.

    Git's own ``merge=union`` refines a conflict against the two sides' common
    lines, so two receipted effects that begin with the same line were folded
    into one and the second receipt lost its effect line (measured
    2026-09-12, f-20260907-04). Here every inserted block is emitted whole, ours
    before theirs at the same base index, and an identical block on both sides
    is emitted once. Pure insertions retain their original greedy alignment.
    Other edits use line ranges in the base. Identical replacements appear once,
    incompatible overlapping replacements and insertions inside a replaced range
    return ``None`` for git's ordinary text merge. Boundary insertions survive.
    Carry retains exact line endings so published receipt bytes stay unchanged.
    """
    base_lines = base.splitlines(keepends=preserve_line_endings)

    def edits(side: str) -> list[tuple[int, int, list[str]]]:
        lines = side.splitlines(keepends=preserve_line_endings)
        blocks = _pure_insertions(base_lines, lines)
        if blocks is not None:
            return [(index, index, block) for index, block in blocks.items()]
        return [
            (start, end, lines[side_start:side_end])
            for tag, start, end, side_start, side_end in difflib.SequenceMatcher(
                None, base_lines, lines, autojunk=False
            ).get_opcodes()
            if tag != "equal"
        ]

    ours_edits, theirs_edits = edits(ours), edits(theirs)
    for start, end, block in ours_edits:
        for other_start, other_end, other_block in theirs_edits:
            if (start, end, block) == (other_start, other_end, other_block):
                continue
            if (max(start, other_start) < min(end, other_end)
                    or start < other_start < end
                    or other_start < start < other_end):
                return None

    # Sorting puts insertions before replacements at their shared start. Python's
    # stable order retains ours-before-theirs for distinct insertion blocks.
    combined = sorted(ours_edits + [edit for edit in theirs_edits if edit not in ours_edits],
                      key=lambda edit: (edit[0], edit[1]))
    merged: list[str] = []
    cursor = 0
    for start, end, block in combined:
        merged.extend(base_lines[cursor:start])
        merged.extend(block)
        cursor = end
    merged.extend(base_lines[cursor:])
    if preserve_line_endings:
        return "".join(merged)
    return "\n".join(merged) + "\n" if merged else ""


def ensure_merge_driver(root: Path) -> bool:
    """Install the ledger merge driver in this clone's config; True if written."""
    settings = (
        (f"merge.{MERGE_DRIVER_NAME}.driver", MERGE_DRIVER_COMMAND),
        (f"merge.{MERGE_DRIVER_NAME}.name", MERGE_DRIVER_DESCRIPTION),
    )
    missing_or_wrong = _merge_driver_settings_to_repair(root, settings)
    if not missing_or_wrong:
        return False

    with _merge_driver_config_lock(root):
        missing_or_wrong = _merge_driver_settings_to_repair(root, settings)
        for name, value in missing_or_wrong:
            result = _git_for_ledger(
                root, "config", "--local", "--replace-all", name, value
            )
            if result.returncode != 0:
                raise LedgerError(
                    f"could not install merge driver {name}: {_git_failure_detail(result)}"
                )
        return bool(missing_or_wrong)


def _merge_driver_settings_to_repair(
    root: Path, settings: tuple[tuple[str, str], ...]
) -> list[tuple[str, str]]:
    """Return merge-driver settings that do not have exactly one expected value."""
    missing_or_wrong: list[tuple[str, str]] = []
    for name, value in settings:
        result = _git_for_ledger(root, "config", "--local", "--get-all", name)
        if result.returncode == 1 and not result.stdout and not result.stderr:
            current_values: list[str] = []
        elif result.returncode == 0:
            current_values = result.stdout.splitlines()
        else:
            raise LedgerError(
                f"could not inspect merge driver {name}: "
                f"{_git_failure_detail(result)}"
            )
        if current_values != [value]:
            missing_or_wrong.append((name, value))
    return missing_or_wrong


def _git_common_directory(root: Path, purpose: str) -> Path:
    """Resolve the shared Git directory with the caller's failure diagnostic."""
    try:
        common = _git_for_ledger(
            root, "rev-parse", "--path-format=absolute", "--git-common-dir"
        )
    except OSError as exc:
        raise LedgerError(f"{purpose}: {exc}") from exc
    if common.returncode != 0:
        raise LedgerError(f"{purpose}: {_git_failure_detail(common)}")
    common_text = common.stdout.strip()
    if not common_text:
        raise LedgerError(
            f"{purpose}: "
            "git rev-parse --git-common-dir returned an empty path"
        )
    common_dir = Path(common_text)
    if not common_dir.is_absolute():
        common_dir = root / common_dir
    return common_dir.resolve()


@contextmanager
def _merge_driver_config_lock(root: Path) -> Iterator[None]:
    """Serialize merge-driver config repair across worktrees and processes.

    The lock lives in Git's common directory, which is shared by linked worktrees.
    Like the ledger flock, its inode remains on disk so waiters always lock the
    same file.
    """
    common_dir = _git_common_directory(
        root, "could not locate the shared Git directory for merge-driver config"
    )
    lock = common_dir / MERGE_DRIVER_CONFIG_LOCK_NAME
    try:
        acquired, waited = acquire_ledger_lock(
            lock, MERGE_DRIVER_CONFIG_LOCK_WAIT_SECONDS
        )
    except LedgerError as exc:
        raise LedgerError(
            f"could not acquire merge-driver config lock {lock}: {exc}"
        ) from exc
    if not acquired:
        raise LedgerError(
            f"could not acquire merge-driver config lock {lock} "
            f"(waited {waited:.2f}s)"
        )

    try:
        yield
    finally:
        release_ledger_lock(lock)


def _carry_published_insertions(
    base: str, ours: str, theirs: str, path: Path, upstream: str
) -> str:
    """Remove only inserted receipt windows witnessed in frozen upstream history."""
    root = cast(Path, REPO_ROOT)
    if re.fullmatch(r"[0-9a-f]{40,64}", upstream) is None:
        raise LedgerError("carry upstream must be a frozen commit SHA")

    def validated(text: str) -> list[LedgerMeta]:
        issues, metadata = _validate_text_with_metadata(text, path)
        if issues or is_controller_export(text):
            raise LedgerError("carry ledger does not validate: " + "\n".join(issues))
        return metadata

    base_metadata = validated(base)
    validated(ours)
    source_metadata = validated(theirs)
    base_keys = {
        (meta.data.get("command"), meta.data.get("operation"))
        for meta in base_metadata
    }
    lines = theirs.splitlines(keepends=True)
    inserted: set[int] = set()
    for tag, _start, _end, start, end in difflib.SequenceMatcher(
        None, base.splitlines(keepends=True), lines, autojunk=False
    ).get_opcodes():
        if tag == "insert":
            inserted.update(range(start, end))
    candidates = [
        meta
        for meta in source_metadata
        if meta.data.get("kind") == MUTATION_RECEIPT_KIND
        and (meta.data["command"], meta.data["operation"]) not in base_keys
        and all(
            index in inserted
            for index in range(
                meta.line - 1 - cast(int, meta.data["effect_lines"]), meta.line
            )
        )
    ]
    if not candidates:
        return theirs

    # Read only the relevant ledger, and only for commits narrowed by an exact
    # receipt-line pickaxe. Multiple batch/effect candidates share this cache.
    snapshots: dict[str, tuple[list[str], list[LedgerMeta]]] = {}
    relative = path.relative_to(root).as_posix()

    def snapshot(commit: str) -> tuple[list[str], list[LedgerMeta]]:
        if commit not in snapshots:
            result = _git_for_ledger_bytes(root, "show", f"{commit}:{relative}")
            if result.returncode:
                detail = os.fsdecode(result.stderr).strip()
                raise LedgerError("could not read carry publication witness: " + detail)
            text = result.stdout.decode("utf-8")
            snapshots[commit] = (text.splitlines(keepends=True), validated(text))
        return snapshots[commit]

    def witnessed(
        source: LedgerMeta, witness_lines: list[str], metadata: list[LedgerMeta]
    ) -> bool:
        start = source.line - 1 - cast(int, source.data["effect_lines"])
        window = lines[start:source.line]
        return any(
            item.data == source.data
            and witness_lines[
                item.line - 1 - cast(int, item.data["effect_lines"]):item.line
            ] == window
            for item in metadata
            if item.data.get("kind") == MUTATION_RECEIPT_KIND
        )

    upstream_lines, upstream_metadata = snapshot(upstream)
    suppressed: set[int] = set()
    for meta in candidates:
        data = meta.data
        current = [
            item for item in upstream_metadata
            if item.data.get("kind") == MUTATION_RECEIPT_KIND
            and item.data["command"] == data["command"]
            and item.data["operation"] == data["operation"]
        ]
        if not current:
            continue
        request = MutationRequest(
            str(data["command"]), str(data["target"]), str(data["input_sha256"]),
            cast(dict[str, object], data["options"]),
            cast(str | None, data["request_id_sha256"]), str(data["operation"]),
        )
        if (len(current) != 1
                or not _receipt_matches_request(current[0].data, request)
                or current[0].data["results"] != data["results"]):
            raise LedgerError("carry publication receipt has different request or results")
        start = meta.line - 1 - cast(int, data["effect_lines"])

        proven = witnessed(meta, upstream_lines, upstream_metadata)
        if not proven:
            history = _git_for_ledger(
                root, "log", "--format=%H", "--full-history", "-m",
                "-S" + lines[meta.line - 1].rstrip("\r\n"), upstream,
                "--", relative,
            )
            if history.returncode:
                raise LedgerError(
                    "could not inspect carry publication history: "
                    + _git_failure_detail(history)
                )
            for commit in dict.fromkeys(history.stdout.splitlines()):
                try:
                    witness_lines, metadata = snapshot(commit)
                except LedgerError:
                    continue
                if witnessed(meta, witness_lines, metadata):
                    proven = True
                    break
        if not proven:
            raise LedgerError("carry insertion has no exact publication witness")
        suppressed.update(range(start, meta.line))
    return "".join(line for index, line in enumerate(lines) if index not in suppressed)


def cmd_merge_driver(args: argparse.Namespace) -> int:
    """Git merge driver entry: ``%O %A %B %P``, result written into ``%A``.

    A non-zero exit tells git the file conflicts and leaves ``%A`` as written,
    so ordinary refusals hand the three inputs to ``git merge-file`` -- the
    merge git would have done without a driver -- and validate a clean ledger
    result too, so an invalid union never reports success. Opted-in carry proof
    failures refuse directly, before a textual fallback can hide invalid inputs.
    """
    ledger_kind = MERGE_DRIVER_LEDGERS.get(Path(args.path).as_posix())
    reason: str
    controller_export = False
    if ledger_kind is None:
        reason = f"{args.path} is not a ledger this driver merges"
    else:
        try:
            sides = []
            for side in (args.base, args.ours, args.theirs):
                # Publication witnesses compare exact effect and receipt bytes.
                # Ordinary callers retain universal-newline reads.
                with side.open(
                    encoding="utf-8",
                    newline="" if getattr(args, "carry_upstream", None) else None,
                ) as stream:
                    sides.append(stream.read())
        except (OSError, UnicodeDecodeError) as exc:
            merged = None
            reason = f"could not read the merge inputs: {exc}"
        else:
            controller_export = any(is_controller_export(side) for side in sides)
            if controller_export:
                # A block append after the JSON fence is invisible to the
                # export parser, so it would validate and then be discarded at
                # the Controller's next regeneration.
                merged = None
                reason = "a side is a Controller-generated export"
            else:
                if getattr(args, "carry_upstream", None):
                    try:
                        sides[2] = _carry_published_insertions(
                            *sides, cast(Path, REPO_ROOT) / args.path, args.carry_upstream
                        )
                    except (LedgerError, OSError, UnicodeError) as exc:
                        # A fallback could hide corrupt source proof behind a
                        # clean textual merge, so carry proof failures refuse.
                        print(
                            f"merge-driver: carry publication proof refused: {exc}",
                            file=sys.stderr,
                        )
                        return 1
                    merged = merge_ledger_blocks(*sides, preserve_line_endings=True)
                else:
                    merged = merge_ledger_blocks(*sides)
                reason = "the sides contain incompatible overlapping edits"
        if merged is not None:
            try:
                # Beside the real ledger, not git's %A scratch: the name is one
                # the ledger writers' scratch sweep removes if cleanup fails.
                with _candidate_scratch(
                    merged, cast(Path, REPO_ROOT) / args.path
                ) as candidate:
                    valid = _ledger_snapshot_valid(candidate, ledger_kind)
                    preserved = valid and _ledger_entry_ids_preserved(
                        args.base, candidate, ledger_kind
                    )
            except LedgerReadRefused:
                raise
            except (LedgerError, OSError, UnicodeError) as exc:
                valid = False
                reason = f"the merged blocks could not be validated: {exc}"
            else:
                reason = "the merged blocks do not validate together"
            if valid and not preserved:
                reason = "the merged blocks removed entries from the merge base"
            if valid and preserved:
                args.ours.write_text(merged, encoding="utf-8")
                return 0
    print(
        f"merge-driver: {reason}; {args.path} is left to git merge-file",
        file=sys.stderr,
    )
    result = _git_for_ledger(
        cast(Path, REPO_ROOT),
        "merge-file",
        "-L", "ours", "-L", "base", "-L", "theirs",
        str(args.ours), str(args.base), str(args.theirs),
    )
    if result.stderr.strip():
        for line in result.stderr.splitlines():
            print(f"merge-driver: git merge-file: {line}", file=sys.stderr)
    if controller_export:
        # Validation cannot vouch for this result: a markdown tail after the
        # JSON fence is invisible to the export parser. The file is resolved by
        # regenerating it from the Controller, never by a clean driver merge.
        print(
            f"merge-driver: {args.path} is a Controller-generated export; left "
            "conflicted — regenerate it from the Controller",
            file=sys.stderr,
        )
        return 1
    if result.returncode == 0:
        if ledger_kind is not None:
            try:
                valid = _ledger_snapshot_valid(args.ours, ledger_kind)
                preserved = (
                    _ledger_entry_ids_preserved(args.base, args.ours, ledger_kind)
                    if valid
                    else False
                )
            except LedgerReadRefused:
                raise
            except (LedgerError, OSError, UnicodeError) as exc:
                print(
                    f"merge-driver: could not validate git merge-file result for "
                    f"{args.path} ({args.ours}): {exc}",
                    file=sys.stderr,
                )
                valid = False
                preserved = False
            if not valid:
                print(
                    f"merge-driver: git merge-file joined {args.path} cleanly but "
                    "the result does not validate; left conflicted for a hand",
                    file=sys.stderr,
                )
                return 1
            if not preserved:
                print(
                    f"merge-driver: git merge-file removed entries from the merge "
                    f"base for {args.path}; left conflicted for a hand",
                    file=sys.stderr,
                )
                return 1
        return 0
    return result.returncode if 0 < result.returncode < 128 else 1


def _ledger_snapshot_preserved(before: Path, after: Path, ledger_kind: str) -> bool:
    """Whether every parsed entry in ``before`` survives semantically in ``after``.

    This is deliberately pure: it reads and parses the two paths but performs no Git
    operation, lock acquisition, recovery, or write.

    The drain supervisor imports this symbol by name across the kit-to-consumer
    vendoring boundary. Its name and ``(before, after, ledger_kind) -> bool``
    signature are part of that contract; changing either requires updating
    ``LedgerOps._snapshot_preserved`` and its capability probe together.
    """
    if ledger_kind not in {"findings", "decisions"}:
        raise ValueError("ledger_kind must be exactly 'findings' or 'decisions'")
    try:
        if not _ledger_snapshot_valid(before, ledger_kind):
            return False
        if not _ledger_snapshot_valid(after, ledger_kind):
            return False
        if ledger_kind == "findings":
            captured = [_finding_expectation(item) for item in parse(before)[0]]
            return _findings_preserved(captured, parse(after)[0])
        captured_decisions = [
            _decision_expectation(item) for item in load_decisions(before)
        ]
        actual = {item.id: item for item in load_decisions(after)}
        return all(
            (decision := actual.get(item.identifier)) is not None
            and _decision_matches_expectation(decision, item)
            for item in captured_decisions
        )
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError):
        return False


def _ledger_entry_ids_preserved(
    before: Path, after: Path, ledger_kind: str
) -> bool:
    """Whether all entry IDs in the merge base still exist in the result.

    This intentionally permits in-place edits to existing entries, such as a
    finding status change or a decision's supersession trailer update.
    """
    if ledger_kind not in {"findings", "decisions"}:
        raise ValueError("ledger_kind must be exactly 'findings' or 'decisions'")
    if ledger_kind == "findings":
        before_ids = {finding.id for finding in parse(before)[0]}
        after_ids = {finding.id for finding in parse(after)[0]}
    else:
        before_ids = {decision.id for decision in load_decisions(before)}
        after_ids = {decision.id for decision in load_decisions(after)}
    return before_ids <= after_ids


def _finding_entries_postcondition(
    expected: Collection[FindingExpectation],
) -> Callable[[Path, Path], bool]:
    def holds(findings_path: Path, _decisions_path: Path) -> bool:
        findings, problems, vocabulary = parse(findings_path)
        return not validate(findings, problems, vocabulary) and _findings_preserved(
            expected, findings
        )

    return holds


def _finding_header_postcondition(
    identifier: str, expected: dict[str, str]
) -> Callable[[Path, Path], bool]:
    def holds(findings_path: Path, _decisions_path: Path) -> bool:
        findings, problems, vocabulary = parse(findings_path)
        if validate(findings, problems, vocabulary):
            return False
        target = next((finding for finding in findings if finding.id == identifier), None)
        return target is not None and all(
            getattr(target, field) == value for field, value in expected.items()
        )

    return holds


def _receipt_postcondition(
    *, command: str, operation: str, results: Collection[str], decisions: bool
) -> Callable[[Path, Path], bool]:
    expected_results = list(results)

    def holds(findings_path: Path, decisions_path: Path) -> bool:
        path = decisions_path if decisions else findings_path
        text = _read_ledger_text(path)
        metadata, issues = _scan_ledger_metadata(text, path)
        issues += _receipt_effect_issues(text, path, metadata)
        return not issues and any(
            meta.data.get("kind") == MUTATION_RECEIPT_KIND
            and meta.data.get("command") == command
            and meta.data.get("operation") == operation
            and meta.data.get("results") == expected_results
            for meta in metadata
        )

    return holds


def _decision_trailer_postcondition(
    identifier: str, references: Collection[str]
) -> Callable[[Path, Path], bool]:
    expected = ", ".join(references)

    def holds(_findings_path: Path, decisions_path: Path) -> bool:
        decisions = load_decisions(decisions_path)
        target = next((decision for decision in decisions if decision.id == identifier), None)
        return target is not None and target.superseded_by == expected

    return holds


def _contiguous_occurrences(haystack: Collection[str], needle: tuple[str, ...]) -> int:
    values = tuple(haystack)
    if not needle:
        return 0
    return sum(
        values[index : index + len(needle)] == needle
        for index in range(len(values) - len(needle) + 1)
    )


def _answers_postcondition(
    expected: dict[str, AnswerExpectation],
) -> Callable[[Path, Path], bool]:
    def holds(findings_path: Path, _decisions_path: Path) -> bool:
        ledger = _answer_ledger(_read_ledger_text(findings_path), expected)
        for identifier, answer in expected.items():
            record = {
                "id": identifier,
                "status": answer.status,
                "blocked": answer.blocked,
                "evidence": list(answer.evidence),
                "previous_occurrences": answer.previous_occurrences,
                "previous_line_occurrences": answer.previous_line_occurrences,
                "kind": answer.kind,
            }
            if _answer_effect_state(ledger, record) != "complete":
                return False
        return True

    return holds


@dataclass(frozen=True)
class AnswerLedger:
    """One ledger text parsed once for every answer effect judged against it."""

    lines: list[str]
    fence_states: list[FenceState]
    targets: dict[str, tuple[int, int, re.Match[str]]]


def _answer_ledger(text: str, ids: Collection[str]) -> AnswerLedger:
    """Parse ``text`` once and locate the entries of every answered id.

    A batch judges each answer against the same text; parsing per answer made a
    batch of A answers cost A full ledger scans.
    """
    lines = text.splitlines()
    fence_states = _fence_mask(lines)
    return AnswerLedger(
        lines, fence_states, _answer_target_spans(lines, fence_states, ids)
    )


def _answer_effect_state(
    ledger: AnswerLedger, record: dict[str, object]
) -> Literal["complete", "untouched", "stale", "inconsistent", "missing"]:
    """Classify one recorded answer effect in a parsed ledger."""
    identifier = cast(str, record["id"])
    lines = ledger.lines
    fence_states = ledger.fence_states
    target = ledger.targets.get(identifier)
    if target is None:
        return "missing"
    header_index, end, header_match = target
    status = cast(str, record["status"])
    blocked = cast(str, record["blocked"])
    current_status = header_match.group("status")
    current_blocked = header_match.group("blocked")
    header_done = current_blocked == BLOCKER_NONE and current_status == status
    header_untouched = current_blocked == blocked and current_status == status

    evidence = tuple(cast(list[str], record["evidence"]))
    previous_occurrences = cast(int, record["previous_occurrences"])
    previous_lines = cast(dict[str, int], record["previous_line_occurrences"])
    body = tuple(
        lines[index]
        for index in range(header_index + 1, end)
        if fence_states[index] is FenceState.OUTSIDE
    )
    block_count = _contiguous_occurrences(body, evidence)
    line_counts: dict[str, int] = {}
    for line in body:
        line_counts[line] = line_counts.get(line, 0) + 1
    evidence_line_counts: dict[str, int] = {}
    for line in evidence:
        evidence_line_counts[line] = evidence_line_counts.get(line, 0) + 1
    lines_done = all(
        line_counts.get(line, 0) == previous_lines[line] + count
        for line, count in evidence_line_counts.items()
    )
    lines_untouched = all(
        line_counts.get(line, 0) == previous_lines[line]
        for line in evidence_line_counts
    )
    evidence_done = (
        block_count == previous_occurrences + 1 and lines_done
    )
    evidence_untouched = block_count == previous_occurrences and lines_untouched
    if header_done and evidence_done:
        return "complete"
    if header_untouched and evidence_untouched:
        return "untouched"
    if evidence_untouched and not header_untouched and current_blocked != BLOCKER_NONE:
        # The writer changes header and evidence in one replace, so untouched
        # evidence means this answer never landed, and a header parked on
        # another blocker or status means the entry was re-parked underneath the
        # claim. An unblocked header without the evidence is a partial effect
        # instead, and so is the writer's decision line re-marked `-` or `+` by
        # hand: both stay inconsistent for manual repair.
        decision_evidence = {
            line[2:]
            for line in evidence
            if line.startswith("* ") and DECIDED_MARKER in line
        }
        if not any(
            line.startswith(("- ", "+ ")) and line[2:] in decision_evidence
            for line in body
        ):
            return "stale"
    return "inconsistent"


_READ_ERRORS_LEDGER = (OSError, UnicodeError, LedgerError)


class FenceState(Enum):
    OUTSIDE = auto()
    DELIMITER = auto()
    CONTENT = auto()


def _fence_mask(lines: list[str]) -> list[FenceState]:
    """Classify each line as outside, a fence delimiter, or fenced content.

    The ledger documents its own header format in a fenced example. A full example
    including its ``###`` heading would otherwise be parsed as a real finding and
    collide with the entry it illustrates.

    An **unbalanced** fence is fatal rather than tolerated: it would mask every
    entry after it, and ``check`` would then report a smaller, valid-looking ledger
    while silently dropping findings out of the queue.
    """
    inside = False
    opened_at = 0
    fence_char = ""
    fence_length = 0
    mask: list[FenceState] = []
    for number, line in enumerate(lines, start=1):
        stripped = line.lstrip()
        # CommonMark allows ``` and ~~~, and a fence is only closed by one of the
        # same character. Toggling on any fence-looking line would let a ```-block
        # containing ~~~ (or the reverse) end early and expose its contents.
        opener = (
            "`"
            if stripped.startswith("```")
            else "~"
            if stripped.startswith("~~~")
            else ""
        )
        run_length = len(stripped) - len(stripped.lstrip(opener)) if opener else 0
        # A closing fence must be at least as long as the one that opened it.
        # Without the length test a four-backtick block QUOTING a three-backtick
        # one closes at the inner delimiter, and the rest of the outer block is
        # read as ledger structure — which is how a fenced ``###`` becomes a
        # second finding, the exact defect the mask exists to prevent.
        if opener and (
            not inside or (opener == fence_char and run_length >= fence_length)
        ):
            mask.append(FenceState.DELIMITER)
            if not inside:
                opened_at = number
                fence_char = opener
                fence_length = run_length
            inside = not inside
            continue
        mask.append(FenceState.CONTENT if inside else FenceState.OUTSIDE)
    if inside:
        raise LedgerError(
            f"unclosed code fence opened at line {opened_at} — everything after it "
            "would be masked, so the ledger would validate while hiding findings"
        )
    return mask


def _mask_inline_code_spans(line: str) -> str:
    """Mask quoted marker text in complete inline code spans on one line.

    Backtick runs delimit spans only when their opening and closing lengths match.
    Process longer runs first so a double-backtick span containing single
    backticks is masked as one quoted span rather than split into inner spans.
    A span containing only a valid local or qualified ledger reference, or the
    ``-`` sentinel, stays visible because it can be part of an otherwise visible
    near-miss marker. Unclosed spans remain visible to the caller and never
    consume a later line.
    """
    masked = line
    run_lengths = sorted(
        {len(match.group()) for match in re.finditer(r"`+", line)}, reverse=True
    )
    for run_length in run_lengths:
        span = re.compile(
            rf"(?<!`)`{{{run_length}}}(?!`)[^\n]*?"
            rf"(?<!`)`{{{run_length}}}(?!`)"
        )

        def replace(match: re.Match[str], run_length: int = run_length) -> str:
            content = match.group()[run_length:-run_length]
            if INLINE_REFERENCE_RE.fullmatch(content):
                return match.group()
            return " " * len(match.group())

        masked = span.sub(replace, masked)
    return masked


def _read_decision_lines(
    path: Path,
) -> tuple[list[str], list[FenceState]] | None:
    """Read a decisions ledger and classify each line's fence state once."""
    if not _ledger_path_exists(path):
        return None
    lines = _read_ledger_text(path).splitlines()
    return lines, _fence_mask(lines)


def _ledger_header_text(lines: list[str], fence_states: list[FenceState]) -> str:
    """Unfenced ledger text before the first finding entry.

    The boundary is the first ``### ``, not the first ``## ``: the header
    legitimately uses ``## `` subsections to document the contract. Shared by
    every bold-label read so Area vocabulary and Tooling areas cannot drift onto
    different regions.
    """
    header: list[str] = []
    for line, fence_state in zip(lines, fence_states, strict=True):
        if fence_state is not FenceState.OUTSIDE:
            continue

        if line.startswith("### "):
            break
        header.append(line)
    return "\n".join(header) + "\n\n"


def _backticks_after_bold_label(
    header: str, pattern: re.Pattern[str]
) -> frozenset[str] | None:
    """Return the backtick-quoted tokens of one bold-label header line, if present."""
    match = pattern.search(header)
    if match is None:
        return None
    return frozenset(re.findall(r"`([^`]+)`", match.group("body")))


def load_vocabulary(lines: list[str], fence_states: list[FenceState]) -> frozenset[str]:
    """Read the closed area set from the ledger header.

    Bounded to the region before the first finding entry and outside fences, so a
    stray occurrence in a finding body cannot define the accepted vocabulary.
    """
    found = _backticks_after_bold_label(
        _ledger_header_text(lines, fence_states), VOCAB_RE
    )
    if found is None:
        raise LedgerError(
            "ledger header has no '**Area vocabulary:**' line before the first finding "
            "entry — the closed area set lives in the ledger, not in this script"
        )
    return found


def load_tooling_areas(
    lines: list[str], fence_states: list[FenceState]
) -> frozenset[str]:
    """Read ``**Tooling areas:**`` from the same header region as the vocabulary.

    Optional: a ledger without the line treats every finding as not tooling.
    """
    found = _backticks_after_bold_label(
        _ledger_header_text(lines, fence_states), TOOLING_AREAS_RE
    )
    return found if found is not None else frozenset()


def load_tooling_areas_from_text(text: str) -> frozenset[str]:
    """Load tooling areas from already-read ledger text."""
    lines = text.splitlines()
    return load_tooling_areas(lines, _fence_mask(lines))


def load_vocabulary_from_project_manifest(manifest: Path) -> frozenset[str]:
    """Read the closed area set from ``.project.json`` for a Controller export.

    A Controller-generated ledger has no ``**Area vocabulary:**`` line; the
    project manifest is the authority for the closed set, the same rule the
    Controller's own filing path enforces. Still project data, never compiled in.
    """
    if not manifest.is_file():
        raise LedgerError(
            "Controller-generated ledger has no '**Area vocabulary:**' line and "
            f"{manifest} is missing — Controller exports read the closed area set "
            f"from {PROJECT_MANIFEST_NAME} findings.areas"
        )
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except _JSON_ERRORS as exc:
        raise LedgerError(f"{manifest} is not valid JSON: {exc}") from exc
    findings_config = data.get("findings") if isinstance(data, dict) else None
    areas = (
        findings_config.get("areas") if isinstance(findings_config, dict) else None
    )
    if not isinstance(areas, dict) or not areas:
        raise LedgerError(
            f"{manifest} findings.areas is missing or empty — Controller exports "
            "read the closed area vocabulary from the project manifest"
        )
    vocabulary: set[str] = set()
    for values in areas.values():
        if not isinstance(values, list):
            raise LedgerError(
                f"{manifest} findings.areas values must be lists of area slugs"
            )
        for area in values:
            if not isinstance(area, str) or not area.strip():
                raise LedgerError(
                    f"{manifest} findings.areas contains a non-string or empty area"
                )
            vocabulary.add(area)
    return frozenset(vocabulary)


def _controller_export_head(data: bytes) -> str:
    """Decode just the head a marker is honoured in from raw ledger bytes.

    UTF-8 needs at most four bytes per character; a character cut at the
    boundary is dropped, which no ASCII marker can be part of.
    """
    return data[: CONTROLLER_EXPORT_HEAD_CHARS * 4].decode("utf-8", errors="ignore")


def is_controller_export(text: str) -> bool:
    """True when a Controller marker occurs in the contract level's bounded head.

    Impact-queue-level and undeclared callers check only the preamble before the
    first ``## `` or ``### `` heading. Level 1 checks the whole bounded head,
    preserving its previous detection byte-identically.
    """
    head = text[:CONTROLLER_EXPORT_HEAD_CHARS]
    # Level 1 retains whole-head detection for byte-identical supervisor refusals.
    if _impact_queue_enabled():
        heading = CONTROLLER_EXPORT_HEADING_RE.search(head)
        if heading is not None:
            head = head[:heading.start()]
    return any(marker in head for marker in CONTROLLER_EXPORT_MARKERS)


def _refuse_controller_export(path: Path, text: str, command: str) -> None:
    """Refuse a write to a ledger the Controller regenerates from SQLite.

    Every writer here appends or rewrites markdown entries. Against the fenced
    JSON form that write would either fail late or, worse, validate — a markdown
    tail is invisible to the JSON parser — and land outside the Controller's
    authoritative store, to be discarded at its next regeneration.
    """
    if is_controller_export(text):
        raise LedgerError(
            f"{path} is a Controller-generated export; {command} works only on "
            "the markdown ledger. The Controller owns this one: file and change "
            "findings through its findings tools instead"
        )


def _refuse_controller_export_at(path: Path, command: str) -> None:
    """``_refuse_controller_export`` for a writer that has not read the ledger yet.

    Reads only the bounded head the markers are honoured in, so the check costs
    nothing on a large ledger and leaves the writer's own full read, and its
    compare-and-swap baseline, as the first read of the text it writes. An
    unreadable ledger is left to that read, which already reports it in the
    command's vocabulary.
    """
    # Unguarded: this marker check persists nothing and must precede intake staging
    # by contract, while every later full ledger read is guarded.
    try:
        with path.open("rb") as handle:
            head = _controller_export_head(
                handle.read(CONTROLLER_EXPORT_HEAD_CHARS * 4)
            )
    except OSError:
        return
    _refuse_controller_export(path, head, command)


def _controller_export_payload(text: str) -> dict[str, object] | None:
    """Return the parsed JSON payload when ``text`` is a Controller export.

    A marker without a usable ``json`` fence is a hard error: falling through to
    the markdown parser would only fail later on the missing vocabulary line and
    hide the real defect.
    """
    if not is_controller_export(text):
        return None
    match = CONTROLLER_JSON_FENCE_RE.search(text)
    if match is None:
        raise LedgerError(
            "Controller-generated ledger is missing its fenced ```json payload"
        )
    try:
        payload = json.loads(match.group("body"))
    except _JSON_ERRORS as exc:
        raise LedgerError(f"Controller-generated ledger JSON is invalid: {exc}") from exc
    if not isinstance(payload, dict):
        raise LedgerError("Controller-generated ledger JSON must be an object")
    if not isinstance(payload.get("findings"), list):
        raise LedgerError("Controller-generated ledger JSON lacks a 'findings' array")
    return cast(dict[str, object], payload)


def _line_of_finding_id(text: str, finding_id: str) -> int:
    """Best-effort 1-based line of a finding id inside the export text."""
    match = re.search(rf'"id"\s*:\s*{re.escape(json.dumps(finding_id))}', text)
    if match is None:
        return 1
    return text.count("\n", 0, match.start()) + 1


def _optional_string_field(
    raw: dict[str, object], key: str, default: str, where: str
) -> str:
    """Map a nullable Controller string onto the markdown ``-``/``none`` default.

    Any non-empty string passes: a Controller blocker is an opaque wait key or
    prose, not a slug, and the slug rule for roots stays with ``validate``.
    """
    value = raw.get(key)
    if value is None:
        return default
    if isinstance(value, str) and value.strip():
        return value
    raise ValueError(f"{where}: {key} must be null or a non-empty string")


def _finding_from_controller(raw: object, index: int, text: str) -> Finding | str:
    """Map one Controller wire object to a Finding, or return a problem string.

    ``index`` is the object's position in the ``findings`` array, the only
    locator a problem has before an id is known.
    """
    if not isinstance(raw, dict):
        return f"Controller findings[{index}] is not an object"
    raw = cast(dict[str, object], raw)
    finding_id = raw.get("id")
    if not isinstance(finding_id, str) or not finding_id:
        return f"Controller findings[{index}] is missing a string id"
    line = _line_of_finding_id(text, finding_id)
    where = f"{finding_id} (line {line})"

    for key in ("status", "area", "entry", "title"):
        value = raw.get(key)
        if not isinstance(value, str) or not value:
            return f"{where}: missing string field '{key}'"
    try:
        blocked = _optional_string_field(raw, "blocked", BLOCKER_NONE, where)
        root = _optional_string_field(raw, "root", "-", where)
    except ValueError as exc:
        return str(exc)

    body_lines: list[str] = []
    body_text = raw.get("body")
    if isinstance(body_text, str) and body_text.strip():
        body_lines.append(body_text)

    files = raw.get("files")
    if files is None:
        files = []
    elif not isinstance(files, list):
        return f"{where}: files must be an array"
    for path in files:
        if not isinstance(path, str) or not path.strip():
            return f"{where}: files entries must be non-empty strings"
        # Feed paths() / related the same backtick form the markdown ledger uses.
        body_lines.append(f"* **Where:** `{path}`.")

    brief = raw.get("decision_brief")
    if isinstance(brief, dict):
        for label, key in (
            ("Decision", "question"),
            ("Recommend", "recommend"),
            ("Session", "session_id"),
        ):
            value = brief.get(key)
            if isinstance(value, str) and value.strip():
                body_lines.append(f"* **{label}:** {value}")

    status = cast(str, raw["status"])
    if status == "rejected" and not any(REJECTED_RE.search(item) for item in body_lines):
        triage = raw.get("triage")
        evidence = triage.get("evidence") if isinstance(triage, dict) else None
        if isinstance(evidence, str) and evidence.strip():
            reason = evidence
        elif isinstance(body_text, str) and body_text.strip():
            reason = body_text
        else:
            reason = "Controller triage rejected this finding"
        body_lines.append(f"* **Why rejected:** {reason}")

    if not body_lines:
        return f"{where}: entry has no body and no files"

    return Finding(
        id=finding_id,
        status=status,
        area=cast(str, raw["area"]),
        root=root,
        entry=cast(str, raw["entry"]),
        blocked=blocked,
        title=cast(str, raw["title"]),
        section=CONTROLLER_EXPORT_SECTION,
        line=line,
        body=body_lines,
        body_fenced=[False] * len(body_lines),
        source_sha256=_sha256_text(
            json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        ),
    )


def parse_controller_export(
    payload: dict[str, object], text: str, manifest: Path
) -> tuple[list[Finding], list[str], frozenset[str]]:
    """Parse a Controller-generated JSON ledger export."""
    vocabulary = load_vocabulary_from_project_manifest(manifest)
    findings: list[Finding] = []
    problems: list[str] = []
    for index, raw in enumerate(cast(list[object], payload["findings"])):
        mapped = _finding_from_controller(raw, index, text)
        if isinstance(mapped, str):
            problems.append(mapped)
        else:
            findings.append(mapped)
    return findings, problems, vocabulary


def _body_line_kind(line: str, fence_state: FenceState) -> bool | None:
    """Return whether one parser line is body text and if it is fenced."""
    if fence_state is FenceState.CONTENT:
        return True if line.strip() else None
    if fence_state is FenceState.DELIMITER:
        return None
    if line.strip() and not HRULE_RE.fullmatch(line):
        return False
    return None


def _entry_body(
    lines: list[str], fence_states: list[FenceState], start: int, end: int
) -> tuple[list[str], list[bool]]:
    """Collect parser-normalized body lines from one already-located entry span."""
    body: list[str] = []
    body_fenced: list[bool] = []
    for index in range(start, end):
        fenced = _body_line_kind(lines[index], fence_states[index])
        if fenced is not None:
            body.append(lines[index])
            body_fenced.append(fenced)
    return body, body_fenced


def parse(
    path: Path = LEDGER, *, text: str | None = None
) -> tuple[list[Finding], list[str], frozenset[str]]:
    if text is None:
        text = _read_ledger_text(path)
    controller = _controller_export_payload(text)
    if controller is not None:
        # The manifest sits beside ``tasks/``; derived from the ledger's own path
        # so a scratch candidate next to the ledger resolves the same file.
        return parse_controller_export(
            controller, text, path.parent.parent / PROJECT_MANIFEST_NAME
        )
    lines = text.splitlines()
    fence_states = _fence_mask(lines)
    vocabulary = load_vocabulary(lines, fence_states)

    findings: list[Finding] = []
    problems: list[str] = []
    _, header_matches, orphans = _unfenced_header_matches(text, fence_states)
    headers_by_heading = {
        heading_index: (header_index, match)
        for heading_index, header_index, match in header_matches
    }
    problems.extend(
        f"line {idx + 1}: orphaned header line was not attached to an eligible '### ' "
        "heading by the parser's forward lookahead"
        for idx, _match in orphans
    )
    section = "(none)"
    pending: Finding | None = None
    # 1-based line of the header already consumed by the lookahead below, so the
    # main loop does not re-encounter it and report it as a duplicate.
    consumed_header_line = -1

    for idx, line in enumerate(lines, start=1):
        fence_state = fence_states[idx - 1]
        if fence_state is not FenceState.OUTSIDE:
            body_kind = _body_line_kind(line, fence_state)
            if pending is not None and body_kind is not None:
                pending.body.append(line)
                pending.body_fenced.append(body_kind)
            continue
        if line.startswith("# "):
            pending = None
            continue
        if line.startswith("## "):
            pending = None
            section = line[3:].strip()
            continue
        if line.startswith("### "):
            title = line[4:].strip()
            header_info = headers_by_heading.get(idx - 1)
            if header_info is None:
                problems.append(
                    f"line {idx}: '{title}' has no valid header line as its first bullet"
                )
                pending = None
                continue
            header_index, match = header_info
            consumed_header_line = header_index + 1
            pending = Finding(
                id=match.group("id"),
                status=match.group("status"),
                area=match.group("area"),
                root=match.group("root"),
                entry=match.group("entry"),
                blocked=match.group("blocked"),
                title=title,
                section=section,
                line=idx,
            )
            findings.append(pending)
            continue
        if pending is None:
            continue
        if idx == consumed_header_line:
            continue
        governed_by = GOVERNED_BY_RE.fullmatch(line)
        if governed_by is not None:
            if pending.governed_by:
                problems.append(
                    f"{pending.id} (line {idx}): a second '**Governed-by:**' "
                    "bullet in one entry — the contract allows exactly one"
                )
            else:
                pending.governed_by.update(
                    match.group("id")
                    for match in QUALIFIED_DECISION_RE.finditer(
                        governed_by.group("ids")
                    )
                    if match.group("owner") in {None, "local"}
                )
        if HEADER_MARKER in line and line.startswith("* "):
            # The first header was consumed above; any further one is a second
            # header in the same entry, which the contract forbids.
            problems.append(
                f"{pending.id} (line {idx}): a second header line in one entry — "
                "the contract allows exactly one"
            )
            continue
        body_kind = _body_line_kind(line, fence_state)
        if body_kind is not None:
            pending.body.append(line)
            pending.body_fenced.append(body_kind)

    return findings, problems, vocabulary


def validate(
    findings: list[Finding],
    problems: list[str],
    vocabulary: frozenset[str],
    *,
    allow_pending: bool = False,
) -> list[str]:
    issues = list(problems)
    seen: dict[str, Finding] = {}

    for f in findings:
        where = f"{f.id} (line {f.line})"
        blocker_class = classify_blocker(f.blocked)
        id_match = ID_RE.match(f.id)
        if f.id == PENDING_ID and allow_pending:
            id_match = None
        elif not id_match:
            issues.append(f"{where}: id must be f-YYYYMMDD-nn")
        else:
            try:
                datetime.strptime(id_match.group(1), "%Y%m%d").astimezone()
            except ValueError:
                issues.append(
                    f"{where}: id carries an impossible date '{id_match.group(1)}'"
                )
        if f.id in seen:
            issues.append(
                f"{where}: duplicate id, first seen at line {seen[f.id].line}"
            )
        seen[f.id] = f
        if f.status not in STATUSES:
            issues.append(f"{where}: status '{f.status}' not in {sorted(STATUSES)}")
        if f.area not in vocabulary:
            issues.append(
                f"{where}: area '{f.area}' is not in the ledger's area vocabulary "
                f"{sorted(vocabulary)} — add it there deliberately or use an existing one"
            )
        if f.root != "-" and not SLUG_RE.match(f.root):
            issues.append(f"{where}: root '{f.root}' must be a slug or '-'")
        if f.entry not in ENTRIES:
            issues.append(f"{where}: entry '{f.entry}' not in {sorted(ENTRIES)}")
        if (
            blocker_class != BLOCKER_NONE
            and not f.controller_export
            and not SLUG_RE.match(f.blocked)
        ):
            issues.append(f"{where}: blocked '{f.blocked}' must be a slug or 'none'")
        if not f.body:
            issues.append(f"{where}: entry has a header but no body")

        for index, line in enumerate(f.body):
            is_fenced = index < len(f.body_fenced) and f.body_fenced[index]
            if is_fenced or not GOVERNED_BY_MARKER_RE.match(line):
                continue
            if GOVERNED_BY_RE.fullmatch(line) is None:
                issues.append(
                    f"{where}: '**Governed-by:**' must be a top-level '* ' bullet "
                    "listing one or more d-YYYYMMDD-nn, local:d-YYYYMMDD-nn, or "
                    "repo-slug:d-YYYYMMDD-nn decision references, comma-separated"
                )

        joined = _unfenced_body(f)
        if f.status == "rejected" and not REJECTED_RE.search(joined):
            issues.append(
                f"{where}: status 'rejected' needs a '**Why rejected:**' bullet with a "
                "stated reason why this is genuinely not a defect"
            )
        if f.status == "open" and f.blocked == FELIX_DECISION:
            issues.extend(_park_brief_issues(where, joined))

    return issues


def _impact_class_issues(findings: list[Finding]) -> list[str]:
    """Validate the new body field without changing the imported legacy validator."""
    if not _impact_queue_enabled():
        return []
    issues = []
    for finding in findings:
        value, explicit = finding.impact_class()
        if explicit and value not in IMPACT_CLASSES:
            issues.append(
                f"{finding.id} (line {finding.line}): '**Impact class:**' value "
                f"{value!r} is not in {sorted(IMPACT_CLASSES)}"
            )
    return issues


def _impact_admission_issues(finding: Finding, where: object) -> list[str]:
    """Apply the out-of-diff scenario bar on every new-entry admission route."""
    if not _impact_queue_enabled():
        return []
    body = _unfenced_body(finding)
    if OUTSIDE_DIFF_RE.search(body) and not FAILURE_SCENARIO_RE.search(body):
        return [
            f"{where}: '**Spotted outside diff:**' needs a non-empty "
            "'**Failure scenario:**' bullet naming input or user action → wrong result. "
            "Run `findings.py related --file <path>`, then "
            "`findings.py annotate <nearest-id> <note-file>`. "
            "The bar is the scenario, never size or effort."
        ]
    return []


def _repeated_field_issues(finding: Finding, where: object) -> list[str]:
    """Refuse repeated single-valued top-level fields on pending entry admission."""
    if not _strict_reporting_enabled():
        return []
    counts: dict[str, int] = {}
    for match in TOP_LEVEL_FIELD_RE.finditer(_unfenced_body(finding)):
        name = match.group("name")
        counts[name] = counts.get(name, 0) + 1
    return [
        f"{where}: field '**{name}:**' appears {count} times; "
        "an entry carries each field once — merge the bullets"
        for name, count in sorted(counts.items())
        if count > 1 and name not in REPEATABLE_ENTRY_FIELDS
    ]


def _park_brief_issues(where: str, joined: str) -> list[str]:
    """Check a `felix-decision` park's brief, reporting every missing part.

    Two properties that were both wrong until 2026-09-01:

    * **All missing markers are reported at once.** These were an ``elif``
      chain, so a brief missing three of them surfaced one per attempt. That is
      merely annoying for ``check``, but every locked ledger mutation validates
      the whole file first, so each undisclosed omission kept refusing every
      write to the ledger until someone guessed the next one.
    * **The markers are searched inside the brief, not the whole entry.** The
      contract places the brief last, running from ``**Decision:**`` to the end
      of the entry. Searching the whole body let an unrelated or historical
      ``**Product impact:**`` bullet somewhere above the question satisfy the
      gate for a question that never had one -- which is exactly the bypass the
      gate exists to close.
    """
    decision = DECISION_BRIEF_RE.search(joined)
    if decision is None:
        return [
            f"{where}: blocked on {FELIX_DECISION} but carries no "
            "'**Decision:**' bullet — state the question, the options and what "
            "each costs, while the investigation that produced them is loaded"
        ]

    brief = joined[decision.start() :]
    issues: list[str] = []
    if not RECOMMEND_RE.search(brief):
        issues.append(
            f"{where}: has a '**Decision:**' bullet but no '**Recommend:**' in "
            "the brief — park with a recommendation so answering is a "
            "confirmation, not an investigation"
        )
    if not SESSION_RE.search(brief):
        issues.append(
            f"{where}: has a '**Decision:**' brief but no '**Session:**' id — "
            "name the parking session so its transcript can be mined instead "
            "of the investigation being re-derived"
        )
    impact = PRODUCT_IMPACT_RE.search(brief)
    if impact is None:
        issues.append(
            f"{where}: has a '**Decision:**' brief but no "
            "'**Product impact:**' — state what a user of the app sees, gets, "
            "pays or is promised differently depending on the answer. If that "
            "sentence cannot be written, the question is technical and does "
            "not park: decide it, record it in tasks/decisions.md, and name "
            "the decision in the completion message"
        )
    elif VACUOUS_IMPACT_RE.match(impact.group("impact").strip()):
        issues.append(
            f"{where}: its '**Product impact:**' says there is none "
            f"({impact.group('impact').strip()!r}), which is the answer that "
            "disqualifies the park rather than satisfying it. A question with "
            "no product impact is technical: clear the blocker and decide it, "
            "or give it a slug naming the precondition it actually waits on"
        )
    return issues


def load_decisions(path: Path) -> list[Decision]:
    """Parse the sibling decisions ledger. Absent or empty is fine."""
    decision_lines = _read_decision_lines(path)
    if decision_lines is None:
        return []
    decisions: list[Decision] = []
    pending: Decision | None = None
    lines, mask = decision_lines
    for number, line in enumerate(lines, 1):
        # The mask governs the WHOLE line, not just whether its paths count. Until
        # 2026-08-22 it gated only the body, so a fenced example heading still became a
        # real decision and a fenced `Governs:` still created a binding link -- the
        # ledger documents its own entry shape in exactly such a fence.
        if mask[number - 1] is not FenceState.OUTSIDE:
            if pending is not None:
                pending.body.append(line)
                pending.body_fenced.append(True)
            continue
        match = DECISION_RE.match(line)
        if match:
            pending = Decision(
                match.group("id"),
                match.group("question").strip(),
                set(),
                line=number,
            )
            decisions.append(pending)
            continue
        if pending is None:
            continue
        pending.body.append(line)
        pending.body_fenced.append(False)
        governs = GOVERNS_RE.search(line)
        if governs:
            pending.governs.update(
                match.group("id")
                for match in QUALIFIED_FINDING_RE.finditer(governs.group("ids"))
                if match.group("owner") in {None, "local"}
            )
        superseded_by = SUPERSEDED_BY_RE.search(_mask_inline_code_spans(line))
        if superseded_by:
            refs = superseded_by.group("refs").replace("`", "")
            pending.superseded_by = "" if refs == "-" else refs
    return decisions


def duplicate_decision_ids(decisions_path: Path) -> list[str]:
    """Report any id carried by two different decision headings.

    A decision id is the stable reference everything else cites — findings carry
    it in ``Governed-by:``, plans and commit messages name it. A duplicate makes
    every one of those citations unresolvable without reading both entries and
    guessing from context, which is exactly how `f-20260820-09` was found: a plan
    cited `d-20260819-20` and the reviewing lenses could not tell which decision
    was meant.

    **Fatal, not a warning.** A duplicate is born the moment a run appends a
    decision without looking at what the last one took, and at that moment it is
    free to fix — nothing cites the new entry yet. One citation later, renumbering
    trades the duplicate for a dangling reference. So this has to bite at creation
    time, which is `check` running after every cluster.
    """
    seen: dict[str, int] = {}
    issues: list[str] = []
    for decision in load_decisions(decisions_path):
        first = seen.get(decision.id)
        if first is None:
            seen[decision.id] = decision.line
            continue
        issues.append(
            f"{decisions_path}:{decision.line}: decision id {decision.id} is "
            f"already used at line {first}. Keep it on the entry with live "
            f"inbound references and give this one the next free id for its date."
        )
    return issues


def malformed_decision_headings(decisions_path: Path) -> list[str]:
    """Report a heading that tries to be a decision and misses the strict form.

    `DECISION_RE` is exact, so a heading written with a plain hyphen or at the
    wrong level is not a malformed decision to the parser — it is not a decision
    at all. It then carries an id nothing can see, which is precisely what
    `duplicate_decision_ids` above has to see to do its job: the escaped entry can
    reuse a live id and `check` stays green. Reported separately from the
    duplicates so the message names the real problem rather than its consequence.
    """
    decision_lines = _read_decision_lines(decisions_path)
    if decision_lines is None:
        return []
    issues: list[str] = []
    lines, mask = decision_lines
    for number, line in enumerate(lines, 1):
        if mask[number - 1] is not FenceState.OUTSIDE:
            continue
        if DECISION_MARKER_RE.match(line) and not DECISION_RE.match(line):
            issues.append(
                f"{decisions_path}:{number}: malformed decision heading. Expected "
                "'### d-YYYYMMDD-nn — <the question, as a question>'."
            )
    return issues


def malformed_superseded_trailers(decisions_path: Path) -> list[str]:
    """Report a supersession trailer whose reference list or sentinel is malformed.

    The decisions ledger documents its own format in fenced examples, so the same
    mask as ``load_decisions`` and ``malformed_decision_headings`` must govern this
    validation scan too. A malformed trailer is an explicit authoring error, not an
    absent supersession link that the queue should silently ignore.
    """
    decision_lines = _read_decision_lines(decisions_path)
    if decision_lines is None:
        return []
    lines, mask = decision_lines
    issues: list[str] = []
    for number, line in enumerate(lines, 1):
        if mask[number - 1] is not FenceState.OUTSIDE:
            continue
        masked_line = _mask_inline_code_spans(line)
        if any(
            SUPERSEDED_BY_RE.match(masked_line, marker.start()) is None
            for marker in SUPERSEDED_BY_MARKER_RE.finditer(masked_line)
        ):
            issues.append(
                f"{decisions_path}:{number}: malformed Superseded-by trailer. "
                "Expected '**Superseded-by:** d-YYYYMMDD-nn', "
                "'**Superseded-by:** local:d-YYYYMMDD-nn', "
                "'**Superseded-by:** repo-slug:d-YYYYMMDD-nn', or "
                "'**Superseded-by:** -'; references may be comma-separated, "
                "optionally backtick-quoted and "
                "followed by punctuation."
            )
    return issues


def _effective_queue_cluster_keys(
    findings: list[Finding],
    *, exclude_tooling: bool = False, tooling_areas: Collection[str] = (),
    tooling_pin: str | None = None,
) -> list[tuple[str, str] | None]:
    """Apply the two-carrier Root rule once to every finding for queue grouping."""
    root_counts: dict[str, int] = {}
    for finding in findings:
        if finding.root != "-":
            root_counts[finding.root] = root_counts.get(finding.root, 0) + 1

    keys = [
        (
            ("root", finding.root)
            if finding.root != "-"
            and root_counts.get(finding.root, 0) >= ROOT_CLUSTER_MIN_CARRIERS
            else ("finding", finding.id)
        )
        for finding in findings
    ]
    if exclude_tooling:
        tooling_keys = {
            key for finding, key in zip(findings, keys, strict=True)
            if finding.status == "open"
            and finding.impact_class(tooling_areas)[0] == "tooling"
        }
        tooling_keys.difference_update(
            key for finding, key in zip(findings, keys, strict=True)
            if finding.status == "open"
            and finding.impact_class(tooling_areas)[0] != "tooling"
        )
        pinned_key = next(
            (key for finding, key in zip(findings, keys, strict=True)
             if finding.id == tooling_pin), None
        )
        if pinned_key is not None:
            tooling_keys.discard(pinned_key)
        for key in sorted(tooling_keys):
            skipped = [
                finding for finding, member_key in zip(findings, keys, strict=True)
                if member_key == key and finding.pickable
            ]
            if skipped:
                print(
                    f"skipped tooling {key[0]}:{key[1]} "
                    f"({len(skipped)} pickable finding(s))",
                    file=sys.stderr,
                )
        return [None if key in tooling_keys else key for key in keys]
    return keys


def cluster_members(findings: list[Finding], key: tuple[str, str]) -> list[Finding]:
    return _ranked_clusters(findings)[2].get(key, [])


def _ranked_clusters(
    findings: list[Finding],
    *,
    excluded_ids: Collection[str] = (),
    tooling_areas: Collection[str] = (),
    exclude_tooling: bool = False,
    tooling_pin: str | None = None,
) -> tuple[
    list[tuple[tuple[str, str], list[Finding]]],
    list[Finding],
    dict[tuple[str, str], list[Finding]],
    dict[str, tuple[str, str]],
]:
    """Evaluate pickability once and group evidenced roots in one queue pass."""
    if _impact_queue_enabled():
        cells = _impact_cells(
            findings, excluded_ids=excluded_ids, tooling_areas=tooling_areas,
            exclude_tooling=exclude_tooling, tooling_pin=tooling_pin,
        )
        return cells.clusters, cells.pickable, cells.grouped, cells.key_by_id
    queue_keys = _effective_queue_cluster_keys(
        findings, exclude_tooling=exclude_tooling, tooling_areas=tooling_areas,
        tooling_pin=tooling_pin,
    )

    grouped: dict[tuple[str, str], list[Finding]] = {}
    pickable: list[Finding] = []
    key_by_id: dict[str, tuple[str, str]] = {}
    excluded = set(excluded_ids)
    for finding, key in zip(findings, queue_keys, strict=True):
        is_pickable = finding.pickable
        if key is None or not is_pickable or finding.id in excluded:
            continue
        pickable.append(finding)
        key_by_id[finding.id] = key
        grouped.setdefault(key, []).append(finding)

    clusters = list(grouped.items())

    def sort_key(item: tuple[tuple[str, str], list[Finding]]) -> tuple[int, str]:
        (kind, _name), members = item
        return (0 if kind == "root" else 1, min(member.id for member in members))

    clusters.sort(key=sort_key)
    return clusters, pickable, grouped, key_by_id


@dataclass
class ImpactCells:
    """One pin-independent queue partition, with its effective tiers and waiting carriers."""

    clusters: list[tuple[tuple[str, str], list[Finding]]]
    pickable: list[Finding]
    grouped: dict[tuple[str, str], list[Finding]]
    key_by_id: dict[str, tuple[str, str]]
    entries: dict[str, str]
    escalations: dict[str, tuple[str, list[str]]]
    waiting_builds: dict[str, Finding]


def _impact_cell_entry(members: list[Finding], cells: ImpactCells) -> str:
    """Use effective tiers consistently for cell filters and selected output."""
    return max((cells.entries[f.id] for f in members), key=ENTRY_RANK.__getitem__)


def _effective_follow_up_ids(value: str) -> set[str] | None:
    """Parse a complete replacement, distinguishing a clear from malformed prose."""
    value = value.strip()
    if value == "-":
        return set()
    if re.fullmatch(r"f-\d{8}-\d{2,}(?:[ \t]*,[ \t]*f-\d{8}-\d{2,})*", value):
        return {part.strip() for part in value.split(",")}
    return None


def _follow_up_ancestry(finding: Finding) -> tuple[bool, set[str]]:
    """Resolve membership and edges together, retaining legacy unions without a directive."""
    body = _unfenced_body(finding)
    if _effective_follow_up_enabled():
        for match in reversed(list(EFFECTIVE_FOLLOW_UP_RE.finditer(body))):
            parents = _effective_follow_up_ids(match.group("ids"))
            if parents is not None:
                return bool(parents), parents
    matches = list(FOLLOW_UP_RE.finditer(body))
    return bool(matches), {
        parent for match in matches
        for parent in re.findall(r"f-\d{8}-\d{2,}", match.group("ids"))
    }


def _follow_up_escalations(findings: list[Finding]) -> dict[str, tuple[str, list[str]]]:
    """Find three lineage follow-ups on one full source path, cycle-safe and status-independent."""
    by_id = {finding.id: finding for finding in findings}
    links: dict[str, set[str]] = {fid: set() for fid in by_id}
    follow_ups: set[str] = set()
    for finding in findings:
        is_follow_up, parents = _follow_up_ancestry(finding)
        if is_follow_up:
            follow_ups.add(finding.id)
        for parent in parents:
            if parent in by_id:
                links[finding.id].add(parent)
                links[parent].add(finding.id)
    full_paths: dict[str, set[str]] = {}
    escalations: dict[str, tuple[str, list[str]]] = {}
    visited: set[str] = set()
    for fid in sorted(follow_ups):
        if fid in visited:
            continue
        lineage: set[str] = set()
        pending = [fid]
        while pending:
            current = pending.pop()
            if current in lineage:
                continue
            lineage.add(current)
            pending.extend(links[current] - lineage)
        visited.update(lineage)
        path_members: dict[str, list[str]] = {}
        for member in sorted(lineage & follow_ups):
            full_paths[member] = source_file_keys(by_id[member].paths())[0]
            for path in sorted(full_paths[member]):
                path_members.setdefault(path, []).append(member)
        for member in sorted(lineage & follow_ups):
            for path in sorted(full_paths[member]):
                if len(path_members[path]) >= FOLLOW_UP_ESCALATION_MIN:
                    escalations[member] = (path, sorted(lineage))
                    break
    return escalations


def _impact_cells(
    findings: list[Finding],
    *,
    excluded_ids: Collection[str] = (),
    tooling_areas: Collection[str] = (),
    exclude_tooling: bool = False,
    tooling_pin: str | None = None,
) -> ImpactCells:
    """Keep one cell per evidenced Root, holding at most one effective build carrier."""
    escalations = _follow_up_escalations(findings)
    entries = {
        finding.id: "build" if finding.id in escalations else finding.entry
        for finding in findings
    }
    excluded = set(excluded_ids)
    grouped: dict[tuple[str, str], list[Finding]] = {}
    keys = _effective_queue_cluster_keys(
        findings, exclude_tooling=exclude_tooling, tooling_areas=tooling_areas,
        tooling_pin=tooling_pin,
    )
    for finding, key in zip(findings, keys, strict=True):
        if key is not None and finding.pickable and finding.id not in excluded:
            grouped.setdefault(key, []).append(finding)

    def member_order(finding: Finding) -> tuple[int, str]:
        return (
            IMPACT_RANK.get(
                finding.impact_class(tooling_areas)[0], IMPACT_RANK["unclassified"]
            ),
            finding.id,
        )

    waiting_builds: dict[str, Finding] = {}
    for key, members in grouped.items():
        builds = sorted(
            (f for f in members if entries[f.id] == "build"), key=member_order
        )
        if key[0] == "root" and len(builds) > 1:
            for waiting in builds[1:]:
                waiting_builds[waiting.id] = builds[0]
            members = [f for f in members if f.id not in waiting_builds]
        anchor = min(members, key=member_order)
        grouped[key] = [
            anchor,
            *sorted((f for f in members if f.id != anchor.id), key=lambda f: f.id),
        ]
    clusters = sorted(
        grouped.items(),
        key=lambda item: (
            member_order(item[1][0])[0],
            0 if item[0][0] == "root" else 1,
            item[1][0].id,
        ),
    )
    key_by_id = {finding.id: key for key, members in clusters for finding in members}
    pickable = [finding for finding in findings if finding.id in key_by_id]
    return ImpactCells(
        clusters, pickable, grouped, key_by_id, entries, escalations, waiting_builds
    )


def rank(
    findings: list[Finding], *, tooling_areas: Collection[str] = ()
) -> list[tuple[tuple[str, str], list[Finding]]]:
    """Rank pickable cells by the declared contract, deriving legacy classes at query time."""
    clusters, _pickable, _grouped, _key_by_id = _ranked_clusters(
        findings, tooling_areas=tooling_areas
    )
    return clusters


def _warn_problems(issues: list[str], command: str) -> None:
    for issue in issues:
        print(f"WARN {issue}", file=sys.stderr)
    if issues:
        print(
            f"WARN {command} ran against a ledger with {len(issues)} validation "
            "problem(s). Run `check`.",
            file=sys.stderr,
        )


def _count_pending_inbox(inbox: Path) -> tuple[int, bool, list[Path]]:
    """Count filed-but-unmerged entries, and whether the spool sweep was complete.

    The completeness flag is ``_enumerate_orphan_parts``' own: a part whose
    ``stat`` raised is dropped from the list, and only the flag distinguishes
    that from a spool that held nothing. `summary` reports it; the advisory
    duplicate warning ignores it.

    Returns the count, the flag and the files that were read, so the warning
    can name the directories without walking the spool a second time.
    """
    legacy = LEGACY_INBOX if inbox == INBOX else inbox.with_suffix(".md")
    claim = CLAIM if inbox == INBOX else inbox.with_name(f"{inbox.name}.claim")
    sources = sorted(inbox.glob("*.md"))
    orphan_parts, complete = _enumerate_orphan_parts(inbox)
    sources += orphan_parts
    # A prepared or refused batch sits in the claim, outside both the ledger and the spool.
    # Leaving it out here is the worst of the three: `related` would answer
    # "this looks new" about a finding that is already filed but unmergeable,
    # so the duplicate gets written AND the unresolved refusal stays quiet.
    if _entry_exists(claim, directory=True):
        sources += sorted(claim.glob("*.md"))
    if _entry_exists(legacy):
        sources.append(legacy)
    # A merge running in another terminal renames these files out from under the
    # glob. That is normal and means the entries are being consumed right now, so
    # a vanished file is skipped rather than crashing a read-only query.
    read: list[tuple[Path, str]] = []
    for p in sources:
        try:
            read.append((p, p.read_text(encoding="utf-8")))
        except FileNotFoundError as exc:
            if _entry_state(p) != _ENTRY_BROKEN:
                continue
            raise LedgerError(f"could not read pending filing {p}: {exc}") from exc
    # Count ENTRIES, not allocated ids. `header_ids` deliberately reports only ids
    # that are taken, and a spooled entry carries `**ID:** f-PENDING` by contract --
    # so counting ids reported 0 pending for exactly the normal case, and `related`
    # printed no warning at all about a spool that was holding work. That is the one
    # thing this function exists to prevent. Found by a push review lens, 2026-08-22.
    pending = 0
    for _, text in read:
        _lines, headers, orphans = _unfenced_header_matches(text)
        pending += len(headers) + len(orphans)
    return pending, complete, [p for p, _ in read]


def _warn_pending_inbox(inbox: Path) -> None:
    """A duplicate check that cannot see the inbox invites the duplicate.

    Entries filed during a drain are not in the ledger yet, so `related` would
    answer "looks new" about something already filed — and the collision only
    surfaces later, as a duplicate id that refuses the whole merge.
    """
    # The completeness flag belongs to `summary`, which reports it; here a
    # dropped part only weakens a duplicate warning that is advisory anyway.
    pending, _complete, sources = _count_pending_inbox(inbox)
    intake = intake_directory(inbox)
    try:
        intake_count = sum(
            1 for path in intake.iterdir()
            if not path.is_symlink() and path.is_file()
        )
    except FileNotFoundError as exc:
        if _entry_state(intake) == _ENTRY_BROKEN:
            print(f"WARN intake {intake.name}: {exc}", file=sys.stderr)
        intake_count = 0
    except OSError as exc:
        print(f"WARN intake {intake.name}: {exc}", file=sys.stderr)
        intake_count = 0
    if intake_count:
        print(
            f"NOTE {intake_count} intake entry(s) are pending in {intake}. "
            "Read them before filing.", file=sys.stderr,
        )
    if not pending:
        return
    claim = CLAIM if inbox == INBOX else inbox.with_name(f"{inbox.name}.claim")
    # Name the directories that actually hold something; `inbox` alone may not
    # even exist when the pending entries are in the claim or at the legacy path.
    where = ", ".join(dict.fromkeys(str(p.parent) for p in sources))
    print(
        f"NOTE {pending} finding(s) are pending in {where} and are not listed "
        "below. Read them before filing.",
        file=sys.stderr,
    )
    if any(p.parent == claim for p in sources):
        try:
            intent = _read_claim_intent(claim)
        except LedgerError as exc:
            print(f"NOTE claim intent could not be read: {exc}", file=sys.stderr)
            return
        if intent is not None and intent.phase == "prepared":
            print(
                f"NOTE a prepared claim at {claim} awaits proof that its ledger "
                "write is durable; findings.py finalize-claims releases it once "
                "it is committed, and the next merge-inbox replays whatever the commit "
                "discarded",
                file=sys.stderr,
            )
        else:
            print(
                f"NOTE a previously refused batch is unresolved in {claim}; "
                "merging is blocked until it is fixed.",
                file=sys.stderr,
            )


def _split_markdown_row(line: str) -> list[str]:
    """Split one pipe table row into stripped cells."""
    stripped = line.strip()
    if stripped.startswith("|"):
        stripped = stripped[1:]
    if stripped.endswith("|"):
        stripped = stripped[:-1]
    return [cell.strip() for cell in stripped.split("|")]


def _is_table_separator(cells: list[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def _plan_adopted_cell_ok(cell: str) -> bool:
    """True for ``not-recorded`` or sequential labelled counts ``r1=6 r2=2 r3=0``."""
    if cell == PLAN_ADOPTED_NOT_RECORDED:
        return True
    parts = cell.split(" ")
    if not parts or parts == [""]:
        return False
    for index, part in enumerate(parts, start=1):
        match = _PLAN_ADOPTED_TOKEN_RE.fullmatch(part)
        if match is None or int(match.group(1)) != index:
            return False
    return True


def validate_plan_adopted_column(path: Path) -> list[str]:
    """D6: well-formed ``plan_adopted_per_round`` cells, only when a header names it.

    A missing file, or a table whose header row does not name the column, is
    not an error — today's ledgers have no such column. A dangling link or an
    entry that cannot be looked up is not missing and is reported as a
    "could not read" issue. Unfenced tables only:
    a fenced format example must not be validated as data. Blank lines between
    row groups under one header do not end the table; a new header row or a
    non-table line does. A pipe row whose cell count differs from the header
    is malformed (an interior ``|`` in a cell is the usual cause).
    """
    state = _entry_state(path)
    if state == _ENTRY_BROKEN:
        return [f"could not read {path}: it is a dangling link or cannot be looked up"]
    if state == _ENTRY_ABSENT or not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except _READ_ERRORS as exc:
        return [f"could not read {path}: {exc}"]
    try:
        lines = text.splitlines()
        fence_states = _fence_mask(lines)
    except LedgerError as exc:
        return [f"{path}: {exc}"]

    issues: list[str] = []
    index = 0
    n_lines = len(lines)
    while index < n_lines:
        if fence_states[index] is not FenceState.OUTSIDE or "|" not in lines[index]:
            index += 1
            continue
        cells = _split_markdown_row(lines[index])
        if PLAN_ADOPTED_COLUMN not in cells:
            index += 1
            continue
        column = cells.index(PLAN_ADOPTED_COLUMN)
        header_width = len(cells)
        sep_index = index + 1
        while sep_index < n_lines and not lines[sep_index].strip():
            sep_index += 1
        if (
            sep_index >= n_lines
            or fence_states[sep_index] is not FenceState.OUTSIDE
            or not _is_table_separator(_split_markdown_row(lines[sep_index]))
        ):
            index += 1
            continue
        row_index = sep_index + 1
        while row_index < n_lines:
            if fence_states[row_index] is not FenceState.OUTSIDE:
                break
            row_line = lines[row_index]
            if not row_line.strip():
                row_index += 1
                continue
            if "|" not in row_line:
                break
            row_cells = _split_markdown_row(row_line)
            if _is_table_separator(row_cells):
                row_index += 1
                continue
            if PLAN_ADOPTED_COLUMN in row_cells:
                break
            where = f"{path}:{row_index + 1}"
            if len(row_cells) != header_width:
                issues.append(
                    f"{where}: row has {len(row_cells)} cells, "
                    f"header has {header_width}"
                )
            else:
                cell = row_cells[column]
                if not _plan_adopted_cell_ok(cell):
                    issues.append(
                        f"{where}: {PLAN_ADOPTED_COLUMN} cell {cell!r} is not "
                        "well-formed — expected 'r1=6 r2=2 r3=0' (labelled "
                        f"counts) or '{PLAN_ADOPTED_NOT_RECORDED}'"
                    )
            row_index += 1
        index = row_index
    return issues


def _print_json(payload: object) -> int:
    """Write one complete JSON value to stdout. Returns 0 for ``return`` sites."""
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def _json_requested(args: argparse.Namespace) -> bool:
    """True when ``--json`` was set. Direct callers may omit the attribute."""
    return bool(getattr(args, "json", False))


def _citation_line_ordinal(
    entry: str,
    cited: str,
    line: str,
    duplicate_lines: dict[tuple[str, str, str], int],
    ordinals_on_line: dict[str, int],
) -> int:
    """Allocate one ordinal per identical source line and cited id."""
    ordinal = ordinals_on_line.get(cited)
    if ordinal is None:
        key = (entry, cited, line)
        ordinal = duplicate_lines.get(key, 0) + 1
        duplicate_lines[key] = ordinal
        ordinals_on_line[cited] = ordinal
    return ordinal


def _append_citation_occurrences(
    occurrences: list[CitationOccurrence],
    issues: list[str],
    pattern: re.Pattern[str],
    *,
    path: Path,
    source: str,
    entry: str,
    line_number: int,
    line: str,
    duplicate_lines: dict[tuple[str, str, str], int],
    ordinals_on_line: dict[str, int],
) -> None:
    """Append valid references while rejecting their complete malformed owners."""
    for match in pattern.finditer(line):
        owner = match.group("owner")
        cited = match.group("id")
        if owner is not None and SLUG_RE.fullmatch(owner) is None:
            issues.append(
                f"{path}:{line_number}: malformed citation qualifier for {cited}"
            )
            continue
        occurrences.append(
            CitationOccurrence(
                source,
                entry,
                cited,
                owner,
                line_number,
                line,
                _citation_line_ordinal(
                    entry, cited, line, duplicate_lines, ordinals_on_line
                ),
            )
        )


def _citation_occurrences(
    path: Path, source: str, *, text: str | None = None
) -> tuple[list[CitationOccurrence], list[str]]:
    if text is None:
        if not _ledger_path_exists(path):
            return [], []
        text = _read_ledger_text(path)
    lines = text.splitlines()
    mask = _fence_mask(lines)
    occurrences: list[CitationOccurrence] = []
    issues: list[str] = []
    current_entry = ""
    pending_finding_heading = False
    duplicate_lines: dict[tuple[str, str, str], int] = {}
    for index, line in enumerate(lines):
        if mask[index] is not FenceState.OUTSIDE:
            continue
        if line.startswith(LEDGER_META_PREFIX):
            continue
        if source == "decisions":
            heading = DECISION_RE.match(line)
            if heading is not None:
                current_entry = heading.group("id")
                continue
            if line.startswith(("# ", "## ")):
                current_entry = ""
                continue
        else:
            if line.startswith("### "):
                pending_finding_heading = True
                current_entry = ""
                continue
            if pending_finding_heading:
                header_match = HEADER_RE.match(line)
                if header_match is not None:
                    current_entry = header_match.group("id")
                    pending_finding_heading = False
                    continue
            if line.startswith(("# ", "## ")):
                current_entry = ""
                continue
        if not current_entry:
            continue
        ordinals_on_line: dict[str, int] = {}

        _append_citation_occurrences(
            occurrences,
            issues,
            QUALIFIED_DECISION_RE,
            path=path,
            source=source,
            entry=current_entry,
            line_number=index + 1,
            line=line,
            duplicate_lines=duplicate_lines,
            ordinals_on_line=ordinals_on_line,
        )
        if GOVERNS_RE.search(line) is not None:
            _append_citation_occurrences(
                occurrences,
                issues,
                QUALIFIED_FINDING_RE,
                path=path,
                source=source,
                entry=current_entry,
                line_number=index + 1,
                line=line,
                duplicate_lines=duplicate_lines,
                ordinals_on_line=ordinals_on_line,
            )
    return occurrences, issues


def _citation_context_key(data: dict[str, object]) -> tuple[object, ...]:
    return (
        data.get("source"),
        data.get("entry"),
        data.get("cited"),
        data.get("line_sha256"),
        data.get("occurrence"),
    )


def _citation_resolution(
    ledger_path: Path,
    decisions_path: Path,
    *,
    ledger_text: str | None = None,
    ledger_metadata: list[LedgerMeta] | None = None,
    decision_text: str | None = None,
    decision_metadata: list[LedgerMeta] | None = None,
) -> tuple[dict[str, set[str]], list[str]]:
    finding_occurrences, issues = _citation_occurrences(
        ledger_path, "findings", text=ledger_text
    )
    decision_occurrences, decision_scan_issues = _citation_occurrences(
        decisions_path, "decisions", text=decision_text
    )
    issues.extend(decision_scan_issues)
    if decision_text is None:
        decision_text = (
            _read_ledger_text(decisions_path)
            if _ledger_path_exists(decisions_path)
            else ""
        )
    if decision_metadata is None:
        decision_metadata, metadata_issues = _scan_ledger_metadata(
            decision_text, decisions_path
        )
        issues.extend(metadata_issues)
    if ledger_text is None:
        ledger_text = _read_ledger_text(ledger_path)
    if ledger_metadata is None:
        ledger_metadata, ledger_metadata_issues = _scan_ledger_metadata(
            ledger_text, ledger_path
        )
        issues.extend(ledger_metadata_issues)
    for meta in ledger_metadata:
        if meta.data.get("kind") == CITATION_CONTEXT_KIND:
            issues.append(
                f"{ledger_path}:{meta.line}: citation-context declarations are "
                "allowed only in decisions.md"
            )
    contexts: dict[tuple[object, ...], LedgerMeta] = {}
    decision_lines = decision_text.splitlines()
    decision_mask = _fence_mask(decision_lines)
    decision_entry_at_line: dict[int, str] = {}
    current_decision = ""
    for index, line in enumerate(decision_lines):
        if decision_mask[index] is not FenceState.OUTSIDE:
            continue
        if (heading := DECISION_RE.match(line)) is not None:
            current_decision = heading.group("id")
        elif line.startswith(("# ", "## ")):
            current_decision = ""
        decision_entry_at_line[index + 1] = current_decision
    for meta in decision_metadata:
        if meta.data.get("kind") != CITATION_CONTEXT_KIND:
            continue
        if not decision_entry_at_line.get(meta.line):
            issues.append(
                f"{decisions_path}:{meta.line}: citation-context declaration "
                "must be inside a decision entry"
            )
            continue
        if _metadata_schema_issues(meta, decisions_path):
            continue
        key = _citation_context_key(meta.data)
        if key in contexts:
            issues.append(
                f"{decisions_path}:{meta.line}: duplicate or conflicting "
                "citation-context declaration"
            )
        else:
            contexts[key] = meta
    local_decisions = {decision.id for decision in load_decisions(decisions_path)}
    local_findings = {finding.id for finding in parse(ledger_path)[0]}
    resolved: dict[str, set[str]] = {}
    used_contexts: set[tuple[object, ...]] = set()
    for occurrence in finding_occurrences + decision_occurrences:
        if occurrence.cited_id.startswith("f-"):
            if occurrence.owner not in {None, "local"}:
                continue
            if occurrence.cited_id not in local_findings:
                issues.append(
                    f"{(ledger_path if occurrence.source == 'findings' else decisions_path)}:"
                    f"{occurrence.line}: unknown local finding citation "
                    f"{occurrence.cited_id}"
                )
            continue
        if occurrence.owner not in {None, "local"}:
            continue
        key = (
            occurrence.source,
            occurrence.entry,
            occurrence.cited_id,
            _sha256_text(occurrence.line_text),
            occurrence.occurrence,
        )
        context = contexts.get(key)
        if context is not None and occurrence.owner is None:
            used_contexts.add(key)
            if context.data.get("status") == "historical-error":
                corrections = cast(list[str], context.data["corrections"])
                missing = [value for value in corrections if value not in local_decisions]
                if missing:
                    issues.append(
                        f"{decisions_path}:{context.line}: citation-context has "
                        f"nonexistent correction ids {missing}"
                    )
                resolved.setdefault(occurrence.entry, set()).update(corrections)
            continue
        if occurrence.cited_id not in local_decisions:
            source_path = ledger_path if occurrence.source == "findings" else decisions_path
            issues.append(
                f"{source_path}:{occurrence.line}: unknown local decision citation "
                f"{occurrence.cited_id}"
            )
        else:
            resolved.setdefault(occurrence.entry, set()).add(occurrence.cited_id)
    for key, meta in contexts.items():
        if key not in used_contexts:
            issues.append(
                f"{decisions_path}:{meta.line}: unused citation-context declaration"
            )
    return resolved, issues


def cmd_check(args: argparse.Namespace) -> int:
    if os.environ.get(PLAN_ONLY_ENV) != "1" and ensure_merge_driver(
        cast(Path, REPO_ROOT)
    ):
        print(f"installed git merge driver {MERGE_DRIVER_NAME}", file=sys.stderr)
    findings, problems, vocabulary = parse(args.ledger)
    issues = validate(findings, problems, vocabulary)
    issues += _impact_class_issues(findings)
    if _strict_reporting_enabled():
        for finding in findings:
            issues += _impact_admission_issues(
                finding, f"{finding.id} (line {finding.line})"
            )
    ledger_text = _read_ledger_text(args.ledger)
    ledger_metadata, ledger_meta_issues = _scan_ledger_metadata(
        ledger_text, args.ledger
    )
    issues += ledger_meta_issues
    issues += _receipt_effect_issues(ledger_text, args.ledger, ledger_metadata)
    # The sibling decisions ledger may be absent only while no local decision is
    # cited. When present, its ids and metadata are load-bearing for this file.
    # Counted separately so the summary names the file the reader has to open;
    # each message carries its own path for the same reason.
    decision_issues = malformed_decision_headings(args.decisions)
    decision_issues += malformed_superseded_trailers(args.decisions)
    decision_issues += duplicate_decision_ids(args.decisions)
    decision_text = ""
    decision_metadata: list[LedgerMeta] = []
    if _ledger_path_exists(args.decisions):
        decision_text = _read_ledger_text(args.decisions)
        decision_metadata, decision_meta_issues = _scan_ledger_metadata(
            decision_text, args.decisions
        )
        decision_issues += decision_meta_issues
        decision_issues += _receipt_effect_issues(
            decision_text, args.decisions, decision_metadata
        )
    _resolved_citations, citation_issues = _citation_resolution(
        args.ledger,
        args.decisions,
        ledger_text=ledger_text,
        ledger_metadata=ledger_metadata,
        decision_text=decision_text,
        decision_metadata=decision_metadata,
    )
    decision_issues += citation_issues
    build_ledger = args.ledger.parent / "build-ledger.md"
    build_issues = validate_plan_adopted_column(build_ledger)
    if issues or decision_issues or build_issues:
        for issue in issues + decision_issues + build_issues:
            print(f"FAIL {issue}", file=sys.stderr)
        where = ", ".join(
            str(path)
            for path, found in (
                (args.ledger, issues),
                (args.decisions, decision_issues),
                (build_ledger, build_issues),
            )
            if found
        )
        print(
            f"\n{len(issues) + len(decision_issues) + len(build_issues)} "
            f"problem(s) in {where}",
            file=sys.stderr,
        )
        return 1
    buckets = summary_buckets(findings)
    print(
        f"ok: {buckets.total} findings, {len(buckets.pickable)} pickable, "
        f"{buckets.blocked} blocked"
    )
    return 0


def _summary_waiting_row(finding: Finding) -> str:
    """One waiting row: id, the slug it waits on, and its heading."""
    return f"  {finding.id}  {finding.blocked}  {finding.title}"


def _answered_summary(
    buckets: SummaryBuckets,
) -> tuple[SummaryBuckets, list[dict[str, str]]]:
    """Read the bound publication spool without locking or applying answers."""
    if not _answered_spool_enabled():
        return buckets, []
    claim = ANSWERS.with_name(ANSWERS.name + ".claim")
    directories = [ANSWERS]
    try:
        if stat.S_ISDIR(claim.stat().st_mode):
            intent_path = _claim_intent_path(claim)
            try:
                intent = json.loads(intent_path.read_text(encoding="utf-8"))
                if not isinstance(intent, dict):
                    raise ValueError("answers claim intent is not an object")
                manual_repair = intent.get("manual_repair", False)
                if not isinstance(manual_repair, bool):
                    raise ValueError("manual_repair must be a boolean")
            except FileNotFoundError:
                directories.append(claim)
            except _READ_JSON_ERRORS as exc:
                print(f"WARNING {intent_path}: {exc}", file=sys.stderr)
            else:
                if not manual_repair:
                    directories.append(claim)
    except FileNotFoundError:
        pass
    except OSError as exc:
        print(f"WARNING {claim}: {exc}", file=sys.stderr)
        return buckets, []
    paths = []
    for directory in directories:
        try:
            with os.scandir(directory) as entries:
                paths.extend(Path(entry.path) for entry in entries if entry.name.endswith(".md"))
        except FileNotFoundError:
            continue
        except OSError as exc:
            print(f"WARNING {directory}: {exc}", file=sys.stderr)
            return buckets, []
    answerable = {finding.id: finding for finding in buckets.product}
    answered: dict[str, dict[str, str]] = {}
    for path in sorted(paths, key=lambda path: path.as_posix()):
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except _READ_ERRORS as exc:
            print(f"WARNING {path}: {exc}", file=sys.stderr)
            continue
        lines = text.splitlines()
        answer = _parse_answer_contents(text, lines, _fence_mask(lines))
        if answer is None:
            print(f"WARNING {path}: invalid answer contents", file=sys.stderr)
            continue
        fid, _decision = answer
        if fid not in answerable or fid in answered:
            continue
        stamp = re.match(r"^(\d{8}-\d{6})-", path.name)
        answered_at = stamp.group(1) if stamp else path.name[:-3]
        if not answered_at:
            print(f"WARNING {path}: answer filename has no timestamp or name", file=sys.stderr)
            continue
        answered[fid] = {
            "id": fid,
            "heading": answerable[fid].title,
            "answered_at": answered_at,
        }
    return replace(buckets, product=tuple(
        finding for finding in buckets.product if finding.id not in answered
    )), list(answered.values())


def _render_answered_text(answered: list[dict[str, str]]) -> None:
    print("Answered — applied at the next drain step")
    for row in answered:
        print(f"  {row['id']}  {row['answered_at']}  {row['heading']}")


def _render_summary_text(
    buckets: SummaryBuckets, counts_line: str, pending: int, inbox_complete: bool,
    answered: list[dict[str, str]] | None = None,
) -> None:
    """The overview: counts line, then who waits, then what is drainable."""
    print(counts_line)
    print()
    print("WAITING ON YOU")
    # Product answers and preconditions are the two Felix-facing groups.
    # Omit empty groups.
    for label, rows in (
        ("product decisions", buckets.product),
        ("preconditions", buckets.preconditions),
    ):
        if not rows:
            continue
        print(f"{label} ({len(rows)})")
        for finding in rows:
            print(_summary_waiting_row(finding))
    if answered:
        print()
        print("ANSWERED")
        _render_answered_text(answered)
    print()
    print("PICKABLE")
    print(f"  {len(buckets.pickable)} pickable finding(s)")
    for finding in buckets.pickable:
        print(f"  {finding.id}  {finding.area}  {finding.entry}  {finding.title}")
    print()
    print("BLOCKED")
    # Grouped by slug so two findings waiting on the same thing read as one
    # clearance. Each row repeats its slug: a row lifted out of this section
    # must still say what it waits on.
    by_slug: dict[str, list[Finding]] = {}
    for finding in buckets.external:
        by_slug.setdefault(finding.blocked, []).append(finding)
    for slug, rows in by_slug.items():
        print(f"{slug} ({len(rows)})")
        for finding in rows:
            print(f"  {finding.id}  {slug}  {finding.title}")
    print()
    print("PENDING INBOX")
    if inbox_complete:
        print(f"pending inbox: {pending}")
    else:
        print(f"pending inbox: {pending} (incomplete scan)")


def _summary_json_payload(
    buckets: SummaryBuckets,
    counts_line: str,
    pending: int,
    inbox_complete: bool,
    validation_problems: int,
) -> dict[str, object]:
    """The versioned object the drain's preflight and `kit findings` read."""

    def waiting_rows(rows: tuple[Finding, ...], row_class: str) -> list[dict[str, str]]:
        return [
            {
                "id": finding.id,
                "blocked": finding.blocked,
                "heading": finding.title,
                "class": row_class,
            }
            for finding in rows
        ]

    return {
        "schema": FINDINGS_SUMMARY_SCHEMA,
        "counts": {
            "total": buckets.total,
            "handled": buckets.handled,
            "rejected": buckets.rejected,
            "open": buckets.open_,
            "pickable": len(buckets.pickable),
            "decisions": len(buckets.product),
            "preconditions": len(buckets.preconditions),
            "external": len(buckets.external),
            "blocked": buckets.blocked,
            "pending_inbox": pending,
            "skipped_tooling": len(buckets.skipped_tooling),
        },
        "summary_line": counts_line,
        "waiting": (
            waiting_rows(buckets.product, "answerable")
            + waiting_rows(buckets.preconditions, "precondition")
        ),
        "pickable": [
            {
                "id": finding.id,
                "area": finding.area,
                "entry": finding.entry,
                "heading": finding.title,
            }
            for finding in buckets.pickable
        ],
        "external": [
            {"id": finding.id, "blocked": finding.blocked, "heading": finding.title}
            for finding in buckets.external
        ],
        "pending_inbox_complete": inbox_complete,
        "validation_problems": validation_problems,
    }


def cmd_summary(args: argparse.Namespace) -> int:
    """One read-only overview of the ledger: text, or ``--json`` for consumers.

    Read-only and lock-free, like ``list``. A ledger with validation problems
    still answers with counts and warns on stderr, so one damaged entry does not
    hide the rest of the queue; only an unparseable ledger fails.
    """
    text = _read_ledger_text(args.ledger)
    findings, problems, vocabulary = parse(args.ledger, text=text)
    issues = validate(findings, problems, vocabulary)
    _warn_problems(issues, "summary")
    buckets = summary_buckets(
        findings, exclude_tooling=getattr(args, "exclude_tooling", False),
        tooling_areas=load_tooling_areas_from_text(text),
    )
    buckets, answered = _answered_summary(buckets)
    pending, inbox_complete, _sources = _count_pending_inbox(args.inbox)
    counts_line = _summary_counts_line(buckets)
    if getattr(args, "exclude_tooling", False):
        counts_line += f" · skipped tooling: {len(buckets.skipped_tooling)}"
    if _json_requested(args):
        payload = _summary_json_payload(
            buckets, counts_line, pending, inbox_complete, len(issues)
        )
        if _answered_spool_enabled():
            payload["answered"] = answered
        return _print_json(payload)
    _render_summary_text(buckets, counts_line, pending, inbox_complete, answered)
    if getattr(args, "exclude_tooling", False):
        print(f"skipped tooling: {len(buckets.skipped_tooling)} pickable finding(s)")
    return 0


def _raw_entry_records(
    path: Path,
    findings: list[Finding],
    *,
    raw_bytes: bytes | None = None,
    text: str | None = None,
) -> dict[int, dict[str, str]]:
    """Hash each entry's exact source-byte slice and retain its section.

    A Controller finding has no byte slice of its own (the export is one JSON
    payload), so its record carries the digest of its canonical JSON object,
    computed at parse time.

    The parser intentionally works on decoded lines, but the planner digest is
    a source identity. Re-encode the decoded ``splitlines(keepends=True)``
    chunks only to recover their byte offsets; UTF-8 is round-tripping here, and
    the hash itself is taken from the original bytes, including CRLF and spaces.
    """
    raw = _read_ledger_bytes(path) if raw_bytes is None else raw_bytes
    text = raw.decode("utf-8") if text is None else text
    lines = text.splitlines()
    chunks = text.splitlines(keepends=True)
    if len(lines) != len(chunks):
        raise LedgerError(f"could not map source lines in {path} to byte offsets")
    offsets: list[int] = [0]
    for chunk in chunks:
        offsets.append(offsets[-1] + len(chunk.encode("utf-8")))
    fence_states = _fence_mask(lines)
    records: dict[int, dict[str, str]] = {}
    for finding in findings:
        if finding.source_sha256 is not None:
            records[finding.line] = {
                "entry_sha256": finding.source_sha256,
                "section": finding.section,
            }
            continue
        start_index = finding.line - 1
        if start_index < 0 or start_index >= len(lines):
            raise LedgerError(
                f"could not locate entry {finding.id} in source bytes of {path}"
            )
        end_index = len(lines)
        for index in range(start_index + 1, len(lines)):
            if fence_states[index] is not FenceState.OUTSIDE:
                continue
            if lines[index].startswith(("### ", "## ")):
                end_index = index
                break
        entry_bytes = raw[offsets[start_index] : offsets[end_index]]
        records[finding.line] = {
            "entry_sha256": _sha256_bytes(entry_bytes),
            "section": finding.section,
        }
    return records


def _list_json_records(
    rows: list[Finding],
    tooling_areas: frozenset[str],
    *,
    include_body: bool = False,
    raw_records: dict[int, dict[str, str]] | None = None,
) -> list[dict[str, object]]:
    """One JSON object per finding; field values are the Finding attributes."""
    result: list[dict[str, object]] = []
    for f in rows:
        record: dict[str, object] = {
            "id": f.id,
            "status": f.status,
            "area": f.area,
            "root": f.root,
            "entry": f.entry,
            "blocked": f.blocked,
            "heading": f.title,
            "tooling": f.area in tooling_areas,
        }
        if include_body:
            record.update(
                {
                    "body": _unfenced_body(f),
                }
            )
        if raw_records is not None:
            record.update(raw_records[f.line])
        result.append(record)
    return result


def cmd_list(args: argparse.Namespace) -> int:
    ledger_bytes: bytes | None = None
    ledger_text: str | None = None
    if _json_requested(args):
        ledger_bytes = _read_ledger_bytes(args.ledger)
        ledger_text = ledger_bytes.decode("utf-8")
        findings, problems, vocabulary = parse(args.ledger, text=ledger_text)
    else:
        findings, problems, vocabulary = parse(args.ledger)
    # Full validation, not just parse problems: an entry with an invented area
    # parses fine, so a structural-only warning would let `related` answer
    # "looks new" about a finding that is already recorded.
    issues = validate(findings, problems, vocabulary)
    _warn_problems(issues, "list")
    if getattr(args, "strict", False) and issues:
        return 1
    rows = findings
    if args.open:
        rows = [f for f in rows if f.status == "open"]
    if args.area:
        rows = [f for f in rows if f.area == args.area]
    if args.root:
        rows = [f for f in rows if f.root == args.root]
    if _json_requested(args):
        raw_records = (
            _raw_entry_records(
                args.ledger,
                findings,
                raw_bytes=ledger_bytes,
                text=ledger_text,
            )
            if getattr(args, "raw", False)
            else None
        )
        return _print_json(
            _list_json_records(
                rows,
                load_tooling_areas_from_text(cast(str, ledger_text)),
                include_body=getattr(args, "body", False),
                raw_records=raw_records,
            )
        )
    if not rows:
        print("(none)")
        return 0
    for f in rows:
        print(f.summary())
    return 0


def _unfenced_body(entry: Finding) -> str:
    """The entry's prose with fenced blocks removed.

    A decision id inside a fenced example is an illustration, not a citation. Reading
    one as a citation promotes an unrelated decision into the binding block, which is
    the one place in this output that must not be guessed at.
    """
    return "\n".join(
        line
        for index, line in enumerate(entry.body)
        if not (index < len(entry.body_fenced) and entry.body_fenced[index])
    )


def _unfenced_text(text: str) -> str:
    """Return raw text with fenced lines removed before marker checks."""
    lines = text.splitlines()
    return chr(10).join(
        line
        for line, fence_state in zip(lines, _fence_mask(lines), strict=True)
        if fence_state is FenceState.OUTSIDE
    )


def _print_related_decisions(
    members: list[Finding], decisions_path: Path, ledger_path: Path
) -> None:
    """Surface settled decisions BEFORE the session forms its own view.

    This is the anti-oscillation mechanism: findings are worked in fresh contexts, so
    without it a later run re-derives a question an earlier one settled and can land on
    the other option.

    Two blocks, and the difference between them is load-bearing. A decision that NAMES
    the cluster (or is named by it) binds. A decision that merely touches the same files
    is a lead to check, printed separately and labelled as such -- it is matched by
    filename, and a filename is evidence, not proof.
    """
    for issue in malformed_superseded_trailers(decisions_path):
        print(f"WARN {issue}", file=sys.stderr)
    ids = {f.id for f in members}
    # Both hand-written directions: the decision naming the finding, and the finding
    # naming the decision in its `Governed-by:` field or anywhere in its prose.
    resolved, citation_issues = _citation_resolution(ledger_path, decisions_path)
    for issue in citation_issues:
        print(f"WARN {issue}", file=sys.stderr)
    governed_by = {
        decision_id
        for finding in members
        for decision_id in resolved.get(finding.id, set())
    }

    # The files the cluster is about. This is the only arm that fires without one side
    # already knowing the other exists -- see the note above the second block below.
    member_full: set[str] = set()
    member_bare: set[str] = set()
    for f in members:
        full, bare = source_file_keys(f.paths())
        member_full |= full
        member_bare |= bare
    member_files = (member_full, member_bare)
    has_files = bool(member_full or member_bare)

    binding: list[Decision] = []
    touching: list[tuple[Decision, set[str]]] = []
    for d in load_decisions(decisions_path):
        if d.governs & ids or d.id in governed_by:
            binding.append(d)
            continue
        if not has_files:
            continue
        # Computed once: the display below needs the same set, and rescanning a
        # decision body to render it is the kind of duplicate the reviewer catches.
        shared = shared_source_files(source_file_keys(d.paths()), member_files)
        if shared:
            touching.append((d, shared))
    if not binding and not touching:
        return

    def render(d: Decision, trailer: str = "") -> None:
        superseded = (
            f" (SUPERSEDED by {d.superseded_by} — read the replacement decisions)"
            if d.superseded_by
            else ""
        )
        print(f"  {d.id} — {d.question}{superseded}{trailer}")

    if binding:
        print("\nDECISIONS GOVERNING THIS CLUSTER — input, not open questions.")
        print(
            "Reversing one needs new evidence it did not consider, never a different opinion."
        )
        for d in binding:
            render(d)
    if touching:
        # `Governs:` and `Governed-by:` are hand-written cross-references, so they can
        # only connect a decision to a finding whose author already knew the decision
        # existed -- which is never true of the case that costs the most: a question
        # filed as open because its answer was recorded before the finding was written.
        # d-20260818-30 settled commit-time ref publication on 2026-08-18 and could not
        # name f-20260822-02, filed four days later; the filer set `Entry: build` for a
        # design question that was already closed, and the run spent 4.5 h on it.
        # Matching the files both sides name is what closes that hole.
        print("\nDECISIONS TOUCHING THE SAME FILES — read before treating any of this")
        print("as an open question. Matched by filename, so check the fit yourself.")
        for d, shared in touching:
            names = sorted(shared)[:SHARED_FILES_SHOWN]
            more = len(shared) - len(names)
            tail = f" (+{more} more)" if more else ""
            render(d, f"\n      shares {', '.join(names)}{tail}")


def _waiting_rows(findings: list[Finding]) -> list[tuple[str, str, str]]:
    """Leftover blocked rows: (id, slug, title)."""
    return [
        (f.id, f.blocked, f.title)
        for f in findings
        if f.status == "open" and classify_blocker(f.blocked) != BLOCKER_NONE
    ]


def _cluster_entry_and_ids(members: list[Finding]) -> tuple[str, list[str]]:
    """CLUSTER entry= and IDS values, computed once for both renderings."""
    entry = max(members, key=lambda f: ENTRY_RANK[f.entry]).entry
    return entry, [f.id for f in members]


def _next_exclusion_keys(values: list[str]) -> set[tuple[str, str]]:
    """Parse repeatable cluster exclusions into canonical cluster keys."""
    keys: set[tuple[str, str]] = set()
    for value in values:
        kind, separator, name = value.partition(":")
        if not separator or kind not in {"root", "finding"} or not name:
            raise ValueError(
                "--exclude must be root:<slug> or finding:<id>, "
                f"not {value!r}"
            )
        if (kind == "root" and SLUG_RE.fullmatch(name) is None) or (
            kind == "finding" and ID_RE.fullmatch(name) is None
        ):
            raise ValueError(
                "--exclude must use a valid root slug or finding id, "
                f"not {value!r}"
            )
        keys.add((kind, name))
    return keys


def _read_answers_claim_intent(
    claim: Path,
    *,
    error_context: Literal["inspect", "read"],
    allow_missing_ids: bool,
    validate_ids_only_when_manual_repair: bool = False,
    require_valid_ids: bool = False,
) -> tuple[dict[str, object], bool, list[str] | None]:
    """Read and validate the shared answers-claim intent fields."""
    intent_path = _claim_intent_path(claim)
    try:
        record = json.loads(intent_path.read_text(encoding="utf-8"))
    except _READ_JSON_ERRORS as exc:
        if error_context == "inspect":
            message = f"could not inspect answers claim {claim}: {exc}"
        else:
            message = f"could not read {intent_path}: {exc}"
        raise LedgerError(message) from exc
    if not isinstance(record, dict):
        raise LedgerError(f"answers claim intent {intent_path} is not an object")
    manual_value = record.get("manual_repair", False)
    if not isinstance(manual_value, bool):
        raise LedgerError(
            f"answers claim intent {intent_path} has an invalid manual_repair field"
        )

    manual_repair = manual_value
    validate_ids = not validate_ids_only_when_manual_repair or manual_repair
    raw_ids = record.get("ids", [] if allow_missing_ids else None)
    if validate_ids:
        if not isinstance(raw_ids, list) or not all(
            isinstance(identifier, str)
            and (not require_valid_ids or ID_RE.fullmatch(identifier) is not None)
            for identifier in raw_ids
        ):
            raise LedgerError(f"answers claim intent {intent_path} has invalid ids")
        identifiers = cast(list[str], raw_ids)
    else:
        identifiers = None
    return record, manual_repair, identifiers


def _standing_answers_claim(
    spool: Path,
) -> tuple[Path, set[str], bool]:
    """Read ids and the repair marker from an answers claim without mutating it."""
    claim = spool.with_name(f"{spool.name}.claim")
    if not _entry_exists(claim, directory=True):
        return claim, set(), False
    if not claim.is_dir():
        raise LedgerError(f"answers claim {claim} exists but is not a directory")

    intent_path = _claim_intent_path(claim)
    manual_repair = False
    identifiers: set[str] = set()
    if _entry_state(intent_path) != _ENTRY_ABSENT:
        record, manual_repair, raw_ids = _read_answers_claim_intent(
            claim,
            error_context="inspect",
            allow_missing_ids=True,
        )
        raw_ids = cast(list[str], raw_ids)
        identifiers.update(
            identifier for identifier in raw_ids if ID_RE.fullmatch(identifier)
        )
        raw_files = record.get("files", {})
        if raw_files is not None and not isinstance(raw_files, dict):
            raise LedgerError(f"answers claim intent {intent_path} has invalid files")
        if isinstance(raw_files, dict):
            for value in raw_files.values():
                if isinstance(value, dict):
                    identifier = value.get("id")
                    if isinstance(identifier, str) and ID_RE.fullmatch(identifier):
                        identifiers.add(identifier)
        raw_receipts = record.get("receipt_ids", {})
        if raw_receipts is not None and not isinstance(raw_receipts, dict):
            raise LedgerError(
                f"answers claim intent {intent_path} has invalid receipt_ids"
            )
        if isinstance(raw_receipts, dict):
            for value in raw_receipts.values():
                identifier = value.get("id") if isinstance(value, dict) else value
                if isinstance(identifier, str) and ID_RE.fullmatch(identifier):
                    identifiers.add(identifier)

    for answer_path in sorted(claim.glob("*.md")):
        try:
            lines = answer_path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError) as exc:
            raise LedgerError(
                f"could not inspect answer file {answer_path}: {exc}"
            ) from exc
        states = _fence_mask(lines)
        identifiers.update(
            match.group("id")
            for line, state in zip(lines, states, strict=True)
            if state is FenceState.OUTSIDE
            and (match := ANSWER_ID_RE.match(line)) is not None
        )

    if not identifiers:
        raise LedgerError(f"answers claim {claim} contains no readable finding ids")
    return claim, identifiers, manual_repair


def _manual_repair_answers_claim_ids(spool: Path) -> tuple[str, ...]:
    """Read the durable manual-repair marker without touching an answers claim."""
    claim = spool.with_name(f"{spool.name}.claim")
    intent_path = _claim_intent_path(claim)
    state = _entry_state(intent_path)
    # A broken intent (_ENTRY_BROKEN) deliberately falls through to the reader,
    # whose "could not read" refusal stops apply-answers with exit 1.
    if state == _ENTRY_ABSENT or (
        state == _ENTRY_PRESENT and not intent_path.is_file()
    ):
        return ()
    _record, marker, raw_ids = _read_answers_claim_intent(
        claim,
        error_context="read",
        allow_missing_ids=False,
        validate_ids_only_when_manual_repair=True,
        require_valid_ids=True,
    )
    if not marker:
        return ()
    identifiers = cast(list[str], raw_ids)
    return tuple(sorted(set(identifiers)))


def _next_json_payload(
    *,
    outcome: str,
    cluster_key: tuple[str, str] | None,
    entry: str | None,
    ids: list[str],
    waiting: list[tuple[str, str]],
    co_located: list[str] | None = None,
) -> dict[str, object]:
    """D4 next object. ``cluster_key.value`` is the same string the text line prints."""
    payload: dict[str, object] = {
        "outcome": outcome,
        "cluster_key": (
            {"by": cluster_key[0], "value": cluster_key[1]}
            if cluster_key is not None
            else None
        ),
        "entry": entry,
        "ids": ids,
        "waiting": [{"id": fid, "on": slug} for fid, slug in waiting],
    }
    if co_located is not None:
        payload["co_located"] = co_located
    return payload


def _co_located_singletons(
    selected_key: tuple[str, str],
    selected_entry: str,
    selected_members: list[Finding],
    pickable: list[Finding],
    key_by_id: dict[str, tuple[str, str]],
) -> list[str] | None:
    """Find up to two older unrooted singletons sharing a full source path."""
    if selected_entry == "build":
        return None
    selected_full: set[str] = set()
    for finding in selected_members:
        full, _bare = source_file_keys(finding.paths())
        selected_full.update(full)
    if not selected_full:
        return []

    candidates: list[str] = []
    selected_files = (selected_full, set())
    for finding in pickable:
        if finding.root != "-" or finding.entry not in {"inline", "lens"}:
            continue
        key = key_by_id[finding.id]
        if key[0] != "finding" or key == selected_key:
            continue
        candidate_full, _candidate_bare = source_file_keys(finding.paths())
        if shared_source_files(selected_files, (candidate_full, set())):
            candidates.append(finding.id)
    return sorted(candidates)[:CO_LOCATED_MAX]


def _impact_joiners(
    selected_key: tuple[str, str],
    members: list[Finding],
    cells: ImpactCells,
    excluded: set[tuple[str, str]],
    tooling_areas: Collection[str],
) -> list[str]:
    """Attach mechanical single-carrier cells sharing a full source path with the anchor."""
    anchor_full, _bare = source_file_keys(members[0].paths())
    candidates = []
    for key, candidate_members in cells.clusters:
        if key == selected_key or key in excluded or len(candidate_members) != 1:
            continue
        finding = candidate_members[0]
        if cells.entries[finding.id] not in {"inline", "lens"}:
            continue
        full, _bare = source_file_keys(finding.paths())
        if shared_source_files((anchor_full, set()), (full, set())):
            candidates.append(finding)
    candidates.sort(
        key=lambda f: (
            IMPACT_RANK.get(f.impact_class(tooling_areas)[0], IMPACT_RANK["unclassified"]),
            f.id,
        )
    )
    return [finding.id for finding in candidates]


PICK_CLAIM_LOCK_WAIT_SECONDS = 5.0
PICK_CLAIM_VERSION = 1
PICK_CLAIM_ANCESTOR_MAX = 16
# Parsed /proc stat fields start at field 3 after "pid (comm) "; ppid is 4, starttime is 22.
PICK_STAT_FIRST_FIELD = 3
PICK_STAT_PPID_INDEX = 4 - PICK_STAT_FIRST_FIELD
PICK_STAT_STARTTIME_INDEX = 22 - PICK_STAT_FIRST_FIELD
PICK_STAT_MIN_FIELDS = PICK_STAT_STARTTIME_INDEX + 1


def _pick_process_stat(pid: int) -> tuple[str | None, OSError | None]:
    """Local copy of the supervisor's /proc read; keep this script vendorable."""
    try:
        return Path(f"/proc/{pid}/stat").read_text(encoding="utf-8"), None
    except OSError as exc:
        return None, exc
    except UnicodeError:
        return None, None


def _pick_stat_fields(raw: str | None) -> list[str] | None:
    if raw is None:
        return None
    marker = raw.rfind(") ")
    if marker < 0:
        return None
    fields = raw[marker + 2:].split()
    if (
        len(fields) < PICK_STAT_MIN_FIELDS
        or not fields[PICK_STAT_STARTTIME_INDEX].isascii()
        or not fields[PICK_STAT_STARTTIME_INDEX].isdigit()
    ):
        return None
    return fields


def _pick_owner_identity() -> tuple[int, int] | None:
    override = os.environ.get("FINDINGS_CLAIM_OWNER_PID")
    if override is not None:
        if not re.fullmatch(r"[1-9][0-9]*", override):
            return None
        pid = int(override)
        fields = _pick_stat_fields(_pick_process_stat(pid)[0])
        return (pid, int(fields[PICK_STAT_STARTTIME_INDEX])) if fields is not None else None
    pid = os.getppid()
    for _hop in range(PICK_CLAIM_ANCESTOR_MAX):
        if pid <= 1:
            break
        raw, _error = _pick_process_stat(pid)
        fields = _pick_stat_fields(raw)
        if fields is None or raw is None:
            break
        comm = raw[raw.find("(") + 1:raw.rfind(") ")]
        if comm in {"claude", "codex", "grok"}:
            return pid, int(fields[PICK_STAT_STARTTIME_INDEX])
        if not fields[PICK_STAT_PPID_INDEX].isdigit():
            break
        parent = int(fields[PICK_STAT_PPID_INDEX])
        if parent == pid:
            break
        pid = parent
    return None


def _pick_owner_state(pid: int, start: int) -> str:
    """Mirror d-20260919-20: only proven absence or PID reuse ends a claim."""
    raw, error = _pick_process_stat(pid)
    fields = _pick_stat_fields(raw)
    if fields is not None:
        return "live" if int(fields[PICK_STAT_STARTTIME_INDEX]) == start else "gone"
    if error is not None and error.errno in {errno.ENOENT, errno.ESRCH}:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return "gone"
        except (OSError, OverflowError, ValueError):
            pass
    return "unprovable"


def _pick_claim_directory() -> Path:
    return _git_common_directory(
        _require_git_toplevel(), "pick claim storage unavailable"
    ) / "findings-picks"


@contextmanager
def _pick_claim_lock(directory: Path) -> Iterator[None]:
    directory.mkdir(exist_ok=True)
    try:
        with _publish_lock(directory / "lock", PICK_CLAIM_LOCK_WAIT_SECONDS):
            yield
    except PublishLockBusyError as exc:
        raise LedgerError(f"pick claim lock busy: {directory / 'lock'}") from exc


def _pick_claim_records(
    directory: Path, *, prune: bool = False,
) -> tuple[dict[str, dict[str, object] | None], list[str]]:
    records: dict[str, dict[str, object] | None] = {}
    diagnostics: list[str] = []
    try:
        paths = sorted(directory.iterdir())
    except FileNotFoundError as exc:
        if _entry_state(directory) != _ENTRY_BROKEN:
            return records, diagnostics
        raise LedgerError(
            f"pick claim directory {directory} is a dangling link or cannot be looked up; "
            "repair or remove it by hand, then retry"
        ) from exc
    for path in paths:
        fid = path.stem
        if path.suffix != ".json" or ID_RE.fullmatch(fid) is None:
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            if (
                not isinstance(record, dict) or record.get("version") != PICK_CLAIM_VERSION
                or record.get("id") != fid
                or type(record.get("owner_pid")) is not int
                or record["owner_pid"] <= 0
                or type(record.get("owner_start")) is not int
                or record["owner_start"] < 0
                or not isinstance(record.get("session"), str)
                or not isinstance(record.get("claimed_at"), str)
            ):
                raise ValueError("invalid pick claim fields")
        except _READ_JSON_ERRORS as exc:
            records[fid] = None
            diagnostics.append(f"WARN unreadable pick claim {path}: {exc}")
            continue
        if _pick_owner_state(record["owner_pid"], record["owner_start"]) == "gone":
            if prune:
                path.unlink()
            continue
        records[fid] = record
    return records, diagnostics


def _pick_claim_is_own(record: dict[str, object] | None, owner: tuple[int, int] | None) -> bool:
    return record is not None and owner is not None and (
        record["owner_pid"], record["owner_start"]
    ) == owner


def _pick_claim_reason(directory: Path, fid: str, record: dict[str, object] | None) -> str:
    path = directory / f"{fid}.json"
    if record is None:
        return f"claimed by session unknown pid unknown since unknown: {path}"
    return (
        f"claimed by session {record['session']} pid {record['owner_pid']} "
        f"since {record['claimed_at']}: {path}"
    )


def _write_pick_claims(
    directory: Path, ids: list[str], owner: tuple[int, int],
    records: dict[str, dict[str, object] | None], label: str,
) -> None:
    created: list[Path] = []
    try:
        for fid in ids:
            if _pick_claim_is_own(records.get(fid), owner):
                continue
            path = directory / f"{fid}.json"
            # Include the attempted path: a directory fsync can fail after rename.
            created.append(path)
            _atomic_write(path, json.dumps({
                "version": PICK_CLAIM_VERSION, "id": fid, "owner_pid": owner[0],
                "owner_start": owner[1], "session": label,
                "claimed_at": datetime.now(timezone.utc).isoformat(),
            }) + "\n", durable_directory=True)
    except OSError as exc:
        failed_path = path
        for path in created:
            try:
                path.unlink(missing_ok=True)
            except OSError as cleanup:
                print(
                    f"pick claim rollback failed: {path}: {cleanup}; "
                    f"run unclaim {path.stem}", file=sys.stderr,
                )
        raise LedgerError(f"pick claim write failed: {failed_path}: {exc}") from exc


def _next_with_pick_claims(
    args: argparse.Namespace, directory: Path, owner: tuple[int, int] | None,
    *, claim: bool,
) -> int:
    records, diagnostics = _pick_claim_records(directory, prune=claim)
    pick_claims = {
        fid: _pick_claim_reason(directory, fid, record)
        for fid, record in records.items() if not _pick_claim_is_own(record, owner)
    }
    output = io.StringIO()
    if claim:
        with redirect_stdout(output):
            result = _cmd_next_selection(args, pick_claims)
    else:
        result = _cmd_next_selection(args, pick_claims)
    for diagnostic in diagnostics:
        print(diagnostic, file=sys.stderr)
    if claim and result.status == 0:
        ids = result.ids
        if ids:
            assert owner is not None
            label = (os.environ.get("CLAUDE_CODE_SESSION_ID")
                     or os.environ.get("DRAIN_SESSION_ID") or "unknown")
            _write_pick_claims(directory, ids, owner, records, label)
            print(f"claimed {' '.join(ids)} for {label} pid {owner[0]}", file=sys.stderr)
        print(output.getvalue(), end="")
    return result.status


def cmd_next(args: argparse.Namespace) -> int:
    owner = _pick_owner_identity()
    claim = bool(getattr(args, "claim", False))
    if claim and owner is None:
        print("REFUSING: pick claim owner unresolved; set FINDINGS_CLAIM_OWNER_PID", file=sys.stderr)
        return 1
    directory = _pick_claim_directory()
    if claim:
        with _pick_claim_lock(directory):
            return _next_with_pick_claims(args, directory, owner, claim=True)
    return _next_with_pick_claims(args, directory, owner, claim=False)


def cmd_unclaim(args: argparse.Namespace) -> int:
    for fid in args.ids:
        if ID_RE.fullmatch(fid) is None:
            raise LedgerError(f"invalid pick claim id: {fid}")
    owner = _pick_owner_identity()
    directory = _pick_claim_directory()
    refused = False
    with _pick_claim_lock(directory):
        records, diagnostics = _pick_claim_records(directory, prune=True)
        for diagnostic in diagnostics:
            print(diagnostic, file=sys.stderr)
        for fid in dict.fromkeys(args.ids) or sorted(records):
            if fid not in records:
                continue
            if not _pick_claim_is_own(records[fid], owner):
                print(f"REFUSING: unclaim {fid}: {_pick_claim_reason(directory, fid, records[fid])}", file=sys.stderr)
                refused = True
                continue
            (directory / f"{fid}.json").unlink(missing_ok=True)
            del records[fid]
    return 1 if refused else 0


class NextSelection(NamedTuple):
    status: int
    ids: list[str]


def _cmd_next_selection(
    args: argparse.Namespace, pick_claims: Mapping[str, str]
) -> NextSelection:
    text = _read_ledger_text(args.ledger)
    findings, problems, vocabulary = parse(args.ledger, text=text)
    issues = validate(findings, problems, vocabulary)
    issues += _impact_class_issues(findings)
    if issues:
        print("refusing to pick from an invalid ledger; run `check`", file=sys.stderr)
        return NextSelection(1, [])

    try:
        answers_claim, answers_claim_ids, answers_claim_kept = _standing_answers_claim(
            args.ledger.parent / "findings-answers"
        )
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        print(f"refusing to pick while {exc}", file=sys.stderr)
        return NextSelection(1, [])
    waiting_rows = _waiting_rows(findings)
    cells = None
    tooling_areas = load_tooling_areas_from_text(text)
    exclude_tooling = getattr(args, "exclude_tooling", False)
    tooling_pin = args.pin if not getattr(args, "automatic_pin", False) else None
    excluded: set[tuple[str, str]] = set()
    if _impact_queue_enabled():
        cells = _impact_cells(
            findings,
            excluded_ids=set(answers_claim_ids) | set(pick_claims),
            tooling_areas=tooling_areas,
            exclude_tooling=exclude_tooling, tooling_pin=tooling_pin,
        )
        clusters, pickable, grouped, key_by_id = (
            cells.clusters, cells.pickable, cells.grouped, cells.key_by_id
        )
    else:
        clusters, pickable, grouped, key_by_id = _ranked_clusters(
            findings, excluded_ids=set(answers_claim_ids) | set(pick_claims),
            tooling_areas=tooling_areas, exclude_tooling=exclude_tooling,
            tooling_pin=tooling_pin,
        )

    if cells is not None or not args.pin:
        try:
            excluded = _next_exclusion_keys(list(getattr(args, "exclude", None) or []))
        except ValueError as exc:
            print(f"invalid next filter: {exc}", file=sys.stderr)
            return NextSelection(1, [])

    if args.pin:
        chosen = next((f for f in findings if f.id == args.pin), None)
        if chosen is None:
            print(f"no finding with id {args.pin}", file=sys.stderr)
            return NextSelection(1, [])
        if args.pin in pick_claims:
            print(f"{args.pin} is not pickable ({pick_claims[args.pin]})", file=sys.stderr)
            return NextSelection(1, [])
        if args.pin in answers_claim_ids:
            claim_reason = (
                "answers claim kept for manual repair"
                if answers_claim_kept
                else "finding is held by a standing answers claim"
            )
            print(
                f"{args.pin} is not pickable ({claim_reason}: {answers_claim})",
                file=sys.stderr,
            )
            return NextSelection(1, [])
        if cells is not None and args.pin in cells.waiting_builds:
            build_member = cells.waiting_builds[args.pin]
            print(
                f"{args.pin} is not pickable (waits on the design question of "
                f"{build_member.id} in root {chosen.root})",
                file=sys.stderr,
            )
            return NextSelection(1, [])
        key = key_by_id.get(args.pin)
        if key is None:
            if exclude_tooling and getattr(args, "automatic_pin", False) and chosen.pickable:
                print(f"{args.pin} is not pickable (excluded tooling)", file=sys.stderr)
                return NextSelection(1, [])
            print(
                f"{args.pin} is not pickable (status={chosen.status}, "
                f"blocked={chosen.blocked})",
                file=sys.stderr,
            )
            return NextSelection(1, [])
        members = grouped[key]
        reason = f"pinned: {args.pin}"
    else:
        requested_entry = getattr(args, "entry", None)
        remaining: list[tuple[tuple[str, str], list[Finding]]] = []
        for candidate_key, candidate_members in clusters:
            effective_entry, _candidate_ids = _cluster_entry_and_ids(
                candidate_members
            )
            if cells is not None:
                effective_entry = _impact_cell_entry(candidate_members, cells)
            if candidate_key in excluded:
                continue
            if requested_entry is not None and effective_entry != requested_entry:
                continue
            remaining.append((candidate_key, candidate_members))
        if not remaining:
            if _json_requested(args):
                return NextSelection(_print_json(
                    _next_json_payload(
                        outcome=(
                            NEXT_OUTCOME_BLOCKED_ONLY
                            if waiting_rows
                            else NEXT_OUTCOME_EMPTY
                        ),
                        cluster_key=None,
                        entry=None,
                        ids=[],
                        waiting=[(fid, slug) for fid, slug, _title in waiting_rows],
                    )
                ), [])
            print("QUEUE EMPTY")
            for fid, slug, title in waiting_rows:
                print(f"  blocked: {fid} on {slug} — {title}")
            return NextSelection(0, [])
        key, members = remaining[0]
        kind, name = key
        reason = (
            f"root '{name}' ({len(members)} member(s)); roots first, then oldest ID"
            if kind == "root"
            else f"oldest pickable singleton '{name}'; no pickable roots remain"
        )

    entry, ids = _cluster_entry_and_ids(members)
    if cells is not None:
        entry = _impact_cell_entry(members, cells)
        co_located = _impact_joiners(key, members, cells, excluded, tooling_areas)
        impact, explicit = members[0].impact_class(tooling_areas)
        reason = (
            f"anchor {members[0].id}, impact {impact} "
            f"({'explicit' if explicit else 'derived'}), cell {key[0]}:{key[1]}"
        )
        if members[0].id in cells.escalations:
            shared_path, lineage_ids = cells.escalations[members[0].id]
            reason += (
                f". Follow-up escalation to build: design review of {shared_path}, "
                f"lineage {' '.join(lineage_ids)}"
            )
    else:
        co_located = _co_located_singletons(
            key, entry, members, pickable, key_by_id
        )
    selected_ids = list(dict.fromkeys(ids + (co_located or [])))
    if _json_requested(args):
        return NextSelection(_print_json(
            _next_json_payload(
                outcome=NEXT_OUTCOME_CLUSTER,
                cluster_key=key,
                entry=entry,
                ids=ids,
                waiting=[],
                co_located=co_located,
            )
        ), selected_ids)
    print(f"CLUSTER {key[1]}  entry={entry}")
    print(f"WHY     {reason}")
    print(f"IDS     {' '.join(ids)}")
    if co_located:
        print(f"CO-LOCATED {' '.join(co_located)}")
    print()
    for f in members:
        print(f.summary())
        print(f"    section: {f.section}")
    _print_related_decisions(members, args.decisions, args.ledger)
    return NextSelection(0, selected_ids)


def cmd_related(args: argparse.Namespace) -> int:
    findings, problems, vocabulary = parse(args.ledger)
    _warn_problems(validate(findings, problems, vocabulary), "related")
    _warn_pending_inbox(args.inbox)
    wanted = set(args.file or [])
    hits: list[tuple[str, Finding]] = []
    for f in findings:
        if args.area and f.area == args.area:
            hits.append(("same area", f))
            continue
        shared = f.paths() & wanted
        if shared:
            hits.append((f"shares {sorted(shared)[0]}", f))
    if not hits:
        print("(no related findings — this looks new)")
        return 0
    print(
        "Check these before filing; reuse a Root only for an evidenced shared cause, "
        "not merely a shared area or file. Name the related finding in the report."
    )
    print(
        "If its Root is `-`, the slug cannot carry the relation; name that finding "
        "in the new entry body instead."
    )
    print("Handled ones matter too: they carry the decision already made.\n")
    for why, f in hits:
        print(f"[{why}] {f.summary()}")
    return 0


# Guarantees the suffix below differs on every call within this process. The
# clock cannot: `time.time_ns()` is wall-clock, so it can repeat on a coarse
# source and step backwards under NTP. That is not merely untidy -- the spool
# publisher retries on a name collision, so a clock that repeats would spin.
_SUFFIX_SEQUENCE = itertools.count()


def _publish_stamp() -> str:
    """The `YYYYMMDD-HHMMSS` half of a published spool name.

    Split out from `cmd_file` so a test can freeze it. The published name is
    `<stamp>-<suffix>`, and pinning only the suffix leaves the STAMP free: two
    filings a second apart then get different names and no collision, so a test
    written to prove that a taken name is refused quietly proves nothing instead.
    That is not hypothetical -- it passed for months and first went red inside a
    271-second full-gate run, where the two filings straddled a second boundary.
    """
    return f"{datetime.now().astimezone():%Y%m%d-%H%M%S}"


def _unique_suffix() -> str:
    """A per-process, per-call token for a filename that must not collide.

    PID separates processes, the counter separates calls within one, and the
    timestamp is there to keep the name readable and roughly ordered rather than
    to carry uniqueness. Every filename that must not collide is built from this,
    so the rule lives here once rather than in four places.
    """
    return f"{os.getpid()}-{time.time_ns()}-{next(_SUFFIX_SEQUENCE)}"


def _fsync_directory(directory: Path) -> None:
    """Make directory entries in ``directory`` durable."""
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    synced = False
    try:
        os.fsync(directory_fd)
        synced = True
    finally:
        try:
            os.close(directory_fd)
        except OSError as exc:
            # Never re-raise here. A ``raise`` inside ``finally`` replaces the
            # fsync exception already in flight, so report the cleanup failure
            # and let the durability error propagate.
            detail = (
                "after directory fsync" if synced else "after a failed directory fsync"
            )
            print(
                f"WARN could not clean up directory file descriptor {directory_fd} "
                f"{detail}: {exc}",
                file=sys.stderr,
            )


def _atomic_write(path: Path, text: str, *, durable_directory: bool = False) -> None:
    """Replace ``path`` atomically and apply the requested durability policy.

    The temp-file fsync is always fatal: no write is committed until it succeeds.
    The containing-directory fsync is fatal only for replayable writes whose
    surviving receipt or intent would otherwise make a false promise. Ordinary
    ledger mutations warn after ``os.replace`` because their retry is a blind
    append and the mutation is already visible.
    """
    tmp = path.with_name(f"{path.name}.tmp-{_unique_suffix()}")
    committed = False
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        _note_ledger_replacement(path, text)
        committed = True
        try:
            _fsync_directory(path.parent)
        except OSError as exc:
            if durable_directory:
                raise
            print(
                f"WARN could not durably sync directory {path.parent} after "
                f"replacing {path}: {exc}",
                file=sys.stderr,
            )
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError as exc:
            # Never re-raise here. A ``raise`` inside ``finally`` replaces the
            # exception already in flight, so a failed write followed by a failed
            # cleanup would reach ``main`` as "could not remove /tmp/...tmp-x" and
            # the reason the ledger could not be written would be gone. For a tool
            # whose whole purpose is not losing findings, that is the wrong half to
            # keep. Report the orphaned temporary file instead, so both diagnostics
            # survive, and let the primary error propagate.
            detail = (
                "after atomic write" if committed else "after a failed atomic write"
            )
            print(
                f"WARN could not clean up temporary file {tmp} {detail}: {exc}",
                file=sys.stderr,
            )


@contextmanager
def _candidate_scratch(candidate: str, near: Path) -> Iterator[Path]:
    """Expose candidate text through a unique scratch path for one validation."""
    scratch = near.with_name(f"{near.name}.candidate-{_unique_suffix()}")
    # Exclusive: a file or symlink already at the name is refused, never
    # written through, and never removed by the cleanup below.
    handle = scratch.open("x", encoding="utf-8")
    candidate_succeeded = False
    try:
        with handle:
            handle.write(candidate)
        yield scratch
        candidate_succeeded = True
    finally:
        try:
            scratch.unlink(missing_ok=True)
        except OSError as exc:
            # Never re-raise here. A ``raise`` inside ``finally`` replaces the
            # candidate error already in flight, so report the cleanup failure
            # and let the parse or validation error propagate.
            detail = (
                "after candidate processing"
                if candidate_succeeded
                else "after a failed candidate processing"
            )
            print(
                f"WARN could not clean up candidate scratch file {scratch} "
                f"{detail}: {exc}",
                file=sys.stderr,
            )


def publish_lock_path(spool: Path) -> Path:
    """Return the persistent publish fence beside ``spool``."""
    return spool.with_name(f"{spool.name}.publish.lock")


def receipt_directory(inbox: Path) -> Path:
    """Return the durable filing-receipt directory beside ``inbox``."""
    return inbox.with_name(f"{inbox.name}.receipts")


def _receipt_path(inbox: Path, entry: str, *, filing_token: str | None = None) -> Path:
    digest = hashlib.sha256(entry.encode("utf-8")).hexdigest()
    suffix = f"-{filing_token}" if filing_token is not None else ""
    return receipt_directory(inbox) / f"{digest}{suffix}.json"


def _write_receipt(path: Path, record: dict[str, str]) -> None:
    """Atomically persist a receipt and its directory entry to stable storage."""
    try:
        receipt_directory_existed = path.parent.exists()
        path.parent.mkdir(parents=True, exist_ok=True)
        if not receipt_directory_existed:
            _fsync_directory(path.parent.parent)
        serialized = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
        _atomic_write(path, serialized, durable_directory=True)
    except LedgerError:
        raise
    except OSError as exc:
        raise LedgerError(f"could not write filing receipt {path}: {exc}") from exc


def _published_receipt_record(
    published: str, receipt: dict[str, str] | None = None
) -> dict[str, str]:
    """Build a published receipt while preserving its part identity."""
    record = {"state": "published", "published": published}
    if receipt is not None and "part" in receipt:
        record["part"] = receipt["part"]
    return record


def _read_receipt(path: Path) -> dict[str, str] | None:
    """Read one receipt, refusing every shape whose recovery is ambiguous."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        if _entry_state(path) != _ENTRY_BROKEN:
            return None
        raise LedgerError(f"could not read filing receipt {path}: {exc}") from exc
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not read filing receipt {path}: {exc}") from exc
    try:
        record = json.loads(raw)
    except _JSON_ERRORS as exc:
        raise LedgerError(f"could not read filing receipt {path}: {exc}") from exc
    if not isinstance(record, dict):
        raise LedgerError(f"malformed filing receipt {path}: expected a JSON object")
    state = record.get("state")
    published = record.get("published")
    if state not in {"publishing", "published", "merged", "quarantined"}:
        raise LedgerError(f"malformed filing receipt {path}: invalid state {state!r}")
    if (
        not isinstance(published, str)
        or not published
        or Path(published).name != published
    ):
        raise LedgerError(
            f"malformed filing receipt {path}: invalid published filename"
        )
    identifier = record.get("id")
    part = record.get("part")
    reason = record.get("reason")
    refused = record.get("refused")
    if part is not None and (
        not isinstance(part, str) or not part or Path(part).name != part
    ):
        raise LedgerError(f"malformed filing receipt {path}: invalid part filename")
    if state == "merged":
        if not isinstance(identifier, str) or ID_RE.fullmatch(identifier) is None:
            raise LedgerError(f"malformed filing receipt {path}: invalid merged id")
    elif state == "quarantined":
        if (
            not isinstance(reason, str)
            or not reason
            or not isinstance(refused, str)
            or not refused
            or (
                identifier is not None
                and (
                    not isinstance(identifier, str)
                    or ID_RE.fullmatch(identifier) is None
                )
            )
        ):
            raise LedgerError(
                f"malformed filing receipt {path}: invalid quarantine record"
            )
    elif identifier is not None and (
        not isinstance(identifier, str) or ID_RE.fullmatch(identifier) is None
    ):
        raise LedgerError(f"malformed filing receipt {path}: invalid recorded id")
    return {
        key: value
        for key, value in record.items()
        if key in {"state", "published", "id", "part", "reason", "refused"}
        and isinstance(value, str)
    }


@dataclass
class ReceiptIndex:
    """Relevant receipts indexed once for one publish-locked merge."""

    by_name: dict[str, tuple[Path, dict[str, str]]] = field(default_factory=dict)
    by_filing: dict[tuple[str, str], list[tuple[Path, dict[str, str]]]] = field(
        default_factory=dict
    )
    by_part: dict[str, tuple[Path, dict[str, str]]] = field(default_factory=dict)


def _receipt_index(inbox: Path, digests: set[str]) -> ReceiptIndex:
    """Index only receipts relevant to this batch with one directory scan."""
    index = ReceiptIndex()
    directory = receipt_directory(inbox)
    try:
        entries = os.scandir(directory)
    except FileNotFoundError as exc:
        if _entry_state(directory) != _ENTRY_BROKEN:
            return index
        raise LedgerError(
            f"could not enumerate filing receipts {directory}: {exc}"
        ) from exc
    except OSError as exc:
        raise LedgerError(
            f"could not enumerate filing receipts {directory}: {exc}"
        ) from exc
    with entries:
        for entry in entries:
            digest = entry.name[:RECEIPT_DIGEST_HEX_LENGTH]
            if digest not in digests or not entry.name.endswith(".json"):
                continue
            path = Path(entry.path)
            record = _read_receipt(path)
            if record is None:
                continue
            index.by_name[path.name] = (path, record)
            index.by_filing.setdefault((digest, record["published"]), []).append(
                (path, record)
            )
            part = record.get("part")
            if part is not None:
                existing = index.by_part.get(part)
                if existing is not None and existing[0] != path:
                    raise LedgerError(
                        f"filing receipts {existing[0]} and {path} both name part {part}"
                    )
                index.by_part[part] = (path, record)
    return index


def _record_publishing(
    receipt_path: Path, receipt: dict[str, str] | None, candidate: Path
) -> None:
    """Persist one publishing-name transition while preserving its part."""
    if receipt is None or receipt["state"] != "publishing":
        return
    receipt["published"] = candidate.name
    record = {"state": "publishing", "published": candidate.name}
    if "part" in receipt:
        record["part"] = receipt["part"]
    _write_receipt(receipt_path, record)


def _link_with_retries(
    part: Path,
    candidate_for: Callable[[int], Path],
    before_link: Callable[[Path], None] | None = None,
) -> Path:
    """Link ``part`` under a collision-safe candidate name."""
    for attempt in range(PUBLISH_NAME_ATTEMPTS):
        candidate = candidate_for(attempt)
        if before_link is not None:
            before_link(candidate)
        try:
            os.link(part, candidate)
        except FileExistsError:
            continue
        return candidate
    raise LedgerError(
        f"could not find a free name in {part.parent} after "
        f"{PUBLISH_NAME_ATTEMPTS} attempts; the entry was NOT filed"
    )


@contextmanager
def _publish_lock(
    lock: Path, wait_window_seconds: float | None = None
) -> Iterator[None]:
    """Hold a bounded exclusive fence for one spool's publish window."""
    if wait_window_seconds is None:
        wait_window_seconds = PUBLISH_LOCK_TIMEOUT_SECONDS
    try:
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o644)
    except OSError as exc:
        raise LedgerError(f"could not open publish lock {lock}: {exc}") from exc
    try:
        started = time.monotonic()
        deadline = started + wait_window_seconds
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if exc.errno not in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES):
                    raise LedgerError(
                        f"could not acquire publish lock {lock}: {exc}"
                    ) from exc
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise PublishLockBusyError(
                        f"publish lock busy: {lock} remained busy for "
                        f"{time.monotonic() - started:.2f}s"
                    ) from exc
                time.sleep(min(LEDGER_LOCK_RETRY_INTERVAL_SECONDS, remaining))
        yield
    finally:
        with suppress(OSError):
            fcntl.flock(fd, fcntl.LOCK_UN)
        with suppress(OSError):
            os.close(fd)


def _enumerate_orphan_parts(spool: Path) -> tuple[list[Path], bool]:
    """Return old dot-prefixed ``.part`` files, and whether the scan was complete.

    The flag exists because a part whose ``stat`` raises is DROPPED from the
    list, and a caller cannot tell that apart from a spool that legitimately
    had nothing old in it. Warning and returning the survivors alone would make
    `merge-inbox` exit 0 while a published finding sat stranded -- the same
    "unreadable read as empty" failure the `iterdir` branch below already
    refuses, one level further in. `_adopt_orphan_parts` treats every other
    per-part `OSError` exactly this way (warn, skip that part, fail the sweep),
    so this keeps the batch working on the parts it can still adopt instead of
    refusing all of them for one bad entry.
    """
    try:
        entries = sorted(spool.iterdir())
    except FileNotFoundError as exc:
        if _entry_state(spool) != _ENTRY_BROKEN:
            return [], True
        errno_name = _errno_name(exc)
        raise LedgerError(
            f"could not enumerate findings spool {spool} ({errno_name}): {exc}"
        ) from exc
    except OSError as exc:
        errno_name = _errno_name(exc)
        raise LedgerError(
            f"could not enumerate findings spool {spool} ({errno_name}): {exc}"
        ) from exc
    cutoff = time.time() - ORPHAN_PART_GRACE_SECONDS
    orphans: list[Path] = []
    complete = True
    for path in entries:
        if not path.name.startswith(".") or not path.name.endswith(".part"):
            continue
        try:
            if path.stat().st_mtime <= cutoff:
                orphans.append(path)
        except OSError as exc:
            print(
                f"WARN could not stat orphan part {path}: {exc}",
                file=sys.stderr,
            )
            complete = False
            continue
    return orphans, complete


def _adopt_orphan_parts(spool: Path, receipt_index: ReceiptIndex | None = None) -> bool:
    """Publish old completed parts without deleting an entry on failure."""
    success = True
    try:
        orphan_parts, enumerated_completely = _enumerate_orphan_parts(spool)
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return False
    success = enumerated_completely
    if receipt_index is None:
        digests: set[str] = set()
        for part in orphan_parts:
            try:
                entry = part.read_text(encoding="utf-8")
            except _READ_ERRORS:
                continue
            digests.add(hashlib.sha256(entry.encode("utf-8")).hexdigest())
        try:
            receipt_index = _receipt_index(spool, digests)
        except LedgerError as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            return False
    for part in orphan_parts:
        try:
            if part.stat().st_nlink > 1:
                part.unlink()
                print(
                    f"NOTE cleaned published twin {part}",
                    file=sys.stderr,
                )
                continue
        except FileNotFoundError:
            continue
        except OSError as exc:
            print(f"WARN could not inspect orphan {part}: {exc}", file=sys.stderr)
            success = False
            continue

        try:
            entry = part.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            print(f"FAIL could not read orphan {part}: {exc}", file=sys.stderr)
            success = False
            continue
        digest = hashlib.sha256(entry.encode("utf-8")).hexdigest()
        stem = part.name[1 : -len(".part")]
        indexed_receipt = receipt_index.by_part.get(part.name)
        if indexed_receipt is None:
            bare_name = f"{digest}.json"
            bare_receipt = receipt_index.by_name.get(bare_name)
            if bare_receipt is None or bare_receipt[1]["published"] == f"{stem}.md":
                indexed_receipt = bare_receipt
        if indexed_receipt is None:
            receipt_path = _receipt_path(spool, entry)
            receipt = None
        else:
            receipt_path, receipt = indexed_receipt
        if receipt is not None and receipt["state"] in {"published", "merged", "quarantined"}:
            accounted_as = receipt.get("id", receipt.get("refused", receipt["published"]))
            try:
                part.unlink()
            except OSError as exc:
                print(
                    f"FAIL receipt {receipt_path} accounts for orphan {part} as "
                    f"{accounted_as}, but the part could not be removed: {exc}",
                    file=sys.stderr,
                )
                success = False
                continue
            print(
                f"NOTE removed accounted orphan {part}; receipt {receipt_path} "
                f"records {accounted_as}",
                file=sys.stderr,
            )
            continue

        def candidate_for(attempt: int, *, part_stem: str = stem) -> Path:
            suffix = "" if attempt == 0 else f"-{_unique_suffix()}"
            return spool / f"{part_stem}{suffix}.md"

        def record_publishing(
            candidate: Path,
            *,
            publishing_receipt: dict[str, str] | None = receipt,
            publishing_receipt_path: Path = receipt_path,
        ) -> None:
            _record_publishing(publishing_receipt_path, publishing_receipt, candidate)

        try:
            adopted = _link_with_retries(part, candidate_for, record_publishing)
            _fsync_directory(spool)
            if receipt is not None and receipt["state"] == "publishing":
                receipt["state"] = "published"
                receipt["published"] = adopted.name
                _write_receipt(
                    receipt_path, _published_receipt_record(adopted.name, receipt)
                )
            if receipt is not None:
                receipt_index.by_filing.setdefault((digest, adopted.name), []).append(
                    (receipt_path, receipt)
                )
        except (LedgerError, OSError) as exc:
            print(f"FAIL could not adopt orphan {part}: {exc}", file=sys.stderr)
            success = False
            continue
        try:
            part.unlink()
        except OSError as exc:
            print(
                f"FAIL adopted orphan {part} as {adopted}, but could not remove the "
                f"part name: {exc}",
                file=sys.stderr,
            )
            success = False
        print(f"NOTE adopted orphan {part} as {adopted}", file=sys.stderr)
    return success


def _remove_consumed_published_twin(spool: Path, published: Path) -> None:
    """Remove a part hard-linked to a published file as that file is claimed."""
    twin = spool / f".{published.stem}.part"
    try:
        if twin.stat().st_nlink > 1:
            twin.unlink()
    except FileNotFoundError:
        return
    except OSError as exc:
        raise LedgerError(
            f"could not remove consumed published twin {twin}: {exc}"
        ) from exc


def _sweep_scratch(
    directory: Path, owns_target: Callable[[str], bool]
) -> None:
    """Remove expired generated scratch for targets owned by the caller."""
    try:
        entries = list(directory.iterdir())
    except OSError:
        return
    cutoff = time.time() - SCRATCH_GRACE_SECONDS
    for path in entries:
        match = _GENERATED_SCRATCH_RE.fullmatch(path.name)
        if match is None or not owns_target(match.group("target")):
            continue
        try:
            if path.stat().st_mtime > cutoff:
                continue
            path.unlink()
        except OSError:
            continue


def _validate_text_with_metadata(
    candidate: str, near: Path
) -> tuple[list[str], list[LedgerMeta]]:
    """Validate ledger text and return the metadata scanned during validation."""
    metadata, metadata_issues = _scan_ledger_metadata(candidate, near)
    metadata_issues += _receipt_effect_issues(candidate, near, metadata)
    try:
        with _candidate_scratch(candidate, near) as scratch:
            if "**Area vocabulary:**" not in candidate.split("### ", 1)[0]:
                issues = metadata_issues + (
                    malformed_decision_headings(scratch)
                    + malformed_superseded_trailers(scratch)
                    + duplicate_decision_ids(scratch)
                )
                return issues, metadata
            findings, problems, vocabulary = parse(scratch)
            return (
                metadata_issues
                + validate(findings, problems, vocabulary)
                + _impact_class_issues(findings),
                metadata,
            )
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        return [*metadata_issues, str(exc)], metadata


def _validate_text(candidate: str, near: Path) -> list[str]:
    """Validate ledger text without a scratch path two runs could collide on."""
    issues, _metadata = _validate_text_with_metadata(candidate, near)
    return issues


def _parse_text(
    candidate: str, near: Path
) -> tuple[list[Finding], list[str], frozenset[str]]:
    """Parse text through the normal parser using a temporary path."""
    with _candidate_scratch(candidate, near) as scratch:
        return parse(scratch)


def _entry_candidate_text(entry: str, ledger_text: str) -> str:
    """Put one standalone entry under the ledger's real vocabulary header."""
    lines = ledger_text.splitlines()
    fence_states = _fence_mask(lines)
    prefix: list[str] = []
    for line, fence_state in zip(lines, fence_states, strict=True):
        if fence_state is FenceState.OUTSIDE and line.startswith(ENTRY_MARKER):
            break
        prefix.append(line)
    return "\n".join(prefix) + "\n\n## filed entry\n\n" + entry


def _stamp_filing_entry(entry: str) -> str:
    session_id = os.environ.get("DRAIN_SESSION_ID")
    if not session_id:
        return entry
    lines = entry.splitlines()
    try:
        fence_states = _fence_mask(lines)
    except LedgerError:
        # Attribution precedes validation, including an interrupted fence. A
        # virtual closing delimiter lets us inspect the prefix without repairing
        # the staged text or treating quoted headers as its own header.
        longest_run = max(
            (len(m[0]) for m in re.finditer(r"`+|~+", entry)), default=2
        )
        for character in ("`", "~"):
            try:
                fence_states = _fence_mask([*lines, character * (longest_run + 1)])[:-1]
                break
            except LedgerError:
                continue
        else:
            return entry
    unfenced = "\n".join(
        line for line, state in zip(lines, fence_states, strict=True)
        if state is FenceState.OUTSIDE
    )
    if FILED_FROM_RE.search(unfenced) is None:
        output = os.environ.get("DRAIN_CODEX_OUTPUT")
        filed_from = f"* **Filed from:** {session_id}"
        if output:
            filed_from += f" · output {output}"
        header_index = next(
            (
                index
                for index, (line, state) in enumerate(
                    zip(lines, fence_states, strict=True)
                )
                if state is FenceState.OUTSIDE and HEADER_RE.match(line)
            ),
            None,
        )
        if header_index is not None:
            lines.insert(header_index + 1, filed_from)
            entry = "\n".join(lines) + ("\n" if entry.endswith("\n") else "")
    return entry


def _read_and_validate_entry(
    entry_path: Path, ledger: Path
) -> tuple[str | None, list[str]]:
    """Read and stamp an external path for `cmd_file_status`, then validate its entry.

    Stamping precedes validation so the filing identity matches publication.
    """
    try:
        entry = entry_path.read_text(encoding="utf-8")
        entry = _stamp_filing_entry(entry)
        return _validate_entry_text(entry, ledger, entry_path)
    except LedgerReadRefused:
        raise
    except _READ_ERRORS_LEDGER as exc:
        return None, [f"could not read or parse {entry_path}: {exc}"]


def _validate_entry_text(
    entry: str, ledger: Path, entry_path: Path, *, ledger_text: str | None = None
) -> tuple[str | None, list[str]]:
    """Validate staged text without attributing it to the sweeper."""
    try:
        if ledger_text is None:
            ledger_text = _read_ledger_text(ledger)
        candidate = _entry_candidate_text(entry, ledger_text)
        findings, problems, vocabulary = _parse_text(candidate, ledger)
    except LedgerReadRefused:
        raise
    except (OSError, UnicodeError, LedgerError) as exc:
        return None, [f"could not read or parse {entry_path}: {exc}"]

    issues = validate(findings, problems, vocabulary, allow_pending=True)
    issues += _impact_class_issues(findings)
    if not findings:
        issues.append(f"{entry_path} has no readable `###` finding entry")
    elif len(findings) != 1:
        issues.append(
            f"{entry_path} must contain exactly one `###` finding entry; "
            f"found {len(findings)}"
        )
    elif findings[0].id != PENDING_ID:
        issues.append(
            f"{entry_path} must carry **ID:** {PENDING_ID}; the merge allocates "
            "the real finding id"
        )
    if len(findings) == 1:
        issues += _impact_admission_issues(findings[0], entry_path)
        issues += _repeated_field_issues(findings[0], entry_path)
        body = _unfenced_body(findings[0])
        if findings[0].entry == "build" and not OPEN_QUESTION_RE.search(body):
            issues.append(OPEN_QUESTION_REFUSAL.format(where=entry_path))
        marker = _answer_evidence_marker(body)
        if marker is not None:
            issues.append(
                f"{entry_path} carries answer evidence; only the answer route may "
                "write **Decision made:**"
            )
    return entry, issues


def _warn_filing_entry(entry: str, ledger: Path, decisions: Path) -> None:
    """Emit advisory filing context, blocking publication only on a ledger guard refusal."""
    try:
        ledger_text = _read_ledger_text(ledger)
        candidate = _entry_candidate_text(entry, ledger_text)
        findings, problems, vocabulary = _parse_text(candidate, ledger)
        existing, _existing_problems, _existing_vocabulary = parse(ledger)
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError) as exc:
        print(f"WARN could not inspect filing context: {exc}", file=sys.stderr)
        return
    if len(findings) != 1 or problems or validate(
        findings, problems, vocabulary, allow_pending=True
    ):
        return

    finding = findings[0]
    if _impact_queue_enabled() and finding.impact_class(
        load_tooling_areas_from_text(ledger_text)
    )[0] == "unclassified":
        print(
            f"WARN {finding.id} has unclassified impact. Add '**Impact class:**' "
            f"with one of {sorted(IMPACT_CLASSES)}.",
            file=sys.stderr,
        )
    if finding.root != "-" and not any(
        other.root == finding.root for other in existing
    ):
        print(
            f"WARN Root slug '{finding.root}' has no other ledger entry; "
            "it will not form a cluster until another finding carries it.",
            file=sys.stderr,
        )
    body = _unfenced_body(finding)
    if finding.entry in {"inline", "lens"} and PROOF_BULLET_RE.search(body) is None:
        print(
            f"WARN {finding.id} is Entry: {finding.entry} and has no **Proof:** bullet.",
            file=sys.stderr,
        )
    if finding.entry == "build":
        try:
            with redirect_stdout(sys.stderr):
                _print_related_decisions([finding], decisions, ledger)
        except LedgerReadRefused:
            raise
        except (LedgerError, OSError, UnicodeError) as exc:
            print(
                f"WARN could not read related decisions for {finding.id}: {exc}",
                file=sys.stderr,
            )


def drain_lock_path(ledger: Path | None = None) -> Path:
    """Return the configured drain lock path.

    A supplied ledger keys the checkout containing the directory of the path
    given. This function makes the path absolute for the probe but does not
    resolve symlinks. The CLI passes a canonical explicit ledger, so a symlinked
    tasks/findings.md belongs to the checkout holding the real file. Level 1
    skips the ledger probe, and failed probes fall back to cwd and then the
    import-time paths.
    """
    configured = os.environ.get(DRAIN_LOCK_ENV)
    if configured:
        return Path(configured)
    if ledger is not None and _impact_queue_enabled():
        # Level 1 preserves the supervisor's existing filing contract.
        root, _err = _probe_git_toplevel(cwd=Path(os.path.abspath(ledger)).parent)
        if root is not None:
            return _lock_for_root(root)
    root, _err = _probe_git_toplevel()
    if root is not None:
        return _lock_for_root(root)
    if REPO_ROOT is not None:
        return _lock_for_root(REPO_ROOT)
    return DEFAULT_DRAIN_LOCK


def _drain_lock_ledger(args: argparse.Namespace) -> Path | None:
    """Use ledger ownership only for an explicitly selected ledger."""
    return args.ledger if getattr(args, "_explicit_ledger", False) else None


def cmd_drain_status(args: argparse.Namespace) -> int:
    """Report whether a drain or maintenance fence holds the ledger's consumer lock.

    `file` and `/decide` agree that the consumer lock's kernel flock is the
    answer. Only `file` makes that answer durable by retaining its shared lock
    through a merge; this pure status query releases its probe immediately. The
    recorded PID is only a human diagnostic. An uncertain ownership probe fails
    open with exit 1 and an explicit warning. A lock proven held whose marker
    cannot be read reports an unidentified holder and returns 0.
    """
    lock = drain_lock_path(_drain_lock_ledger(args))
    held, reason, unreadable = _drain_lock_state(lock)
    if held:
        try:
            with lock.open("rb") as stream:
                marker = stream.read(DRAIN_LOCK_READ_BYTES).decode(
                    "utf-8", errors="replace"
                ).strip()
        except OSError as exc:
            print(
                "consumer lock held by an unidentified holder "
                f"(could not read {lock}: {exc})"
            )
            return 0
        if marker.startswith(DRAIN_LOCK_FENCE_MARKER_PREFIX):
            pid = marker[len(DRAIN_LOCK_FENCE_MARKER_PREFIX):]
            print(
                f"drain locks held by with-drain-locks.sh (pid {pid}), "
                f"not a drain (lock {lock})"
            )
            return 0
        print(f"drain running (lock {lock})")
        return 0
    if unreadable:
        assert reason is not None
        print(f"no drain running — {reason}")
        return 1
    if reason is not None:
        print(f"no drain running — STALE lock {lock}: {reason}")
        return 1
    print("no drain running")
    return 1


@dataclass
class MergeResult:
    returncode: int
    assigned_by_file: dict[Path, list[str]] = field(default_factory=dict)


def _spool_file_date(path: Path, legacy: Path | None) -> str:
    """Return the `YYYYMMDD` a spool file was filed on, from its own name.

    The `ID` field records the date a finding was *filed*, not the date a drain
    got round to merging it, and the contract already makes every spool file
    LEAD with its filing timestamp, `<YYYYMMDD-HHMMSS>-` followed by whatever
    `_unique_suffix` appends. So the name is the record. Only the leading date is
    read here; the rest exists to keep two publishers from colliding.

    **A name that does not carry one is refused, not quietly dated today.** The
    id is stable forever, so a wrong date is a permanent wrong record — and the
    silent version of that is the worst shape it can take, because the merge
    exits 0 and nothing ever contradicts it. The single exception is the legacy
    single-file inbox, which predates the naming contract and genuinely has no
    timestamp to read.
    """
    if legacy is not None and path.name == legacy.name:
        return f"{datetime.now().astimezone():%Y%m%d}"
    prefix = path.name.split("-", 1)[0]
    if len(prefix) == ID_DATE_LEN and prefix.isdigit():
        return prefix
    raise LedgerError(
        f"spool file {path.name} does not start with a YYYYMMDD- filing date, so "
        "the finding's id would silently record the wrong day. Rename it to "
        "<YYYYMMDD-HHMMSS>-<pid>.md"
    )


def header_ids(text: str) -> set[str]:
    """Every finding id `text` declares in a real, unfenced header line.

    **Deliberately not a bare `f-\\d{8}-\\d{2}` scan of the raw text.** Ids also
    appear in prose that cross-references them, in longer tokens that merely
    start like one, and in fenced examples that exist precisely to show the
    header format — none of which allocates anything. Counting those as taken
    lets a quoted `f-20260317-99` push the sequence past its ceiling and refuse
    a batch that is entirely valid. `parse` already decides what an id is by
    reading headers outside fences; this reads them the same way, so allocation
    and validation cannot drift apart.
    """
    _lines, headers, _orphans = _unfenced_header_matches(text)
    found: set[str] = set()
    for _heading_idx, _idx, match in headers:
        if ID_RE.match(match.group("id")):
            found.add(match.group("id"))
    return found


def _unfenced_header_matches(
    text: str, fence_states: list[FenceState] | None = None
) -> tuple[
    list[str],
    list[tuple[int, int, re.Match[str]]],
    list[tuple[int, re.Match[str]]],
]:
    """Return real headers, orphaned headers, and their source line indexes.

    A real header is found with the parser's forward lookahead: for an unfenced
    ``### `` heading, skip blank lines and inspect only the next line. A header
    that is not consumed by that lookahead is an orphan. Keeping this rule in one
    helper prevents allocation and merge accounting from accepting a header that
    the parser cannot turn into a finding.
    """
    lines = text.splitlines()
    if fence_states is None:
        fence_states = _fence_mask(lines)
    headers: list[tuple[int, int, re.Match[str]]] = []
    real_indexes: set[int] = set()
    heading_by_header: dict[int, int] = {}
    for idx, line in enumerate(lines):
        if fence_states[idx] is not FenceState.OUTSIDE or not line.startswith("### "):
            continue
        probe = idx + 1
        while probe < len(lines) and not lines[probe].strip():
            probe += 1
        if probe < len(lines) and (match := HEADER_RE.match(lines[probe])) is not None:
            real_indexes.add(probe)
            heading_by_header[probe] = idx

    orphans: list[tuple[int, re.Match[str]]] = []
    for idx, line in enumerate(lines):
        if fence_states[idx] is FenceState.CONTENT:
            continue
        match = HEADER_RE.match(line)
        if match is not None:
            if idx in real_indexes:
                headers.append((heading_by_header[idx], idx, match))
            else:
                orphans.append((idx, match))
    return lines, headers, orphans


def assign_pending_ids(text: str, date: str, taken: set[str]) -> tuple[str, list[str]]:
    """Replace every `f-PENDING` header id in `text` with a free sequential id.

    **The merger allocates, because it is the only writer that can.** A filing
    session cannot read the ledger and pick `max + 1` without racing every other
    filing session doing the same: both read `05`, both write `06`, and the merge
    then refuses a batch containing a third party's perfectly good finding. The
    merger holds the ledger lock and sees the whole batch at once, so allocation
    here is the only point where an id can be handed out exactly once. That is
    also why `f-PENDING` is the required form in the spool rather than merely a
    tolerated one.

    `taken` is mutated so ids stay unique across the files of one batch as well
    as against the ledger. Fenced lines are skipped: an entry quoting a header as
    an example must not have that example silently allocated a real id.

    Returns the rewritten text and the ids handed out, in order. The caller
    reports them: a filing session that published to a drain cannot learn its id,
    so the merge output is the place that mapping is recorded — and deriving it by
    re-scanning the merged text afterwards would re-list pre-assigned ids and
    fenced examples as though this run had allocated them.
    """
    return _allocate_pending(
        text,
        "f",
        date,
        taken,
        PENDING_ID,
        lambda value: _unfenced_header_matches(value)[:2],
    )


def _allocate_pending(
    text: str,
    prefix: str,
    date: str,
    taken: set[str],
    pending_token: str,
    locate: Callable[[str], tuple[list[str], list[tuple[int, int, re.Match[str]]]]],
) -> tuple[str, list[str]]:
    """Allocate high-water ids for either ledger's pending headings."""
    lines, matches = locate(text)
    assigned: list[str] = []
    for heading_idx, idx, match in matches:
        if match.group("id") != pending_token:
            continue
        used = sorted(
            int(identifier.rsplit("-", 1)[1])
            for identifier in taken
            if identifier.startswith(f"{prefix}-{date}-")
        )
        seq = (used[-1] + 1) if used else 1
        if seq > ID_SEQ_MAX:
            kind = "finding" if prefix == "f" else "decision"
            raise LedgerError(
                f"no free {kind} id left for {date} — the sequence reached {ID_SEQ_MAX}"
            )
        candidate = f"{prefix}-{date}-{seq:0{ID_SEQ_DIGITS}d}"
        taken.add(candidate)
        assigned.append(candidate)
        lines[idx] = lines[idx].replace(pending_token, candidate, 1)
        if prefix == "f":
            lines[heading_idx] = re.sub(
                r"^( {0,3}### )f-PENDING(?: — | - )",
                r"\g<1>",
                lines[heading_idx],
                count=1,
            )
    return "\n".join(lines), assigned


def _clone_id_allocation_root(ledger: Path, *, explicit: bool = False) -> Path | None:
    """Explicit paths and non-Git ledgers keep their isolated write protocol."""
    root = REPO_ROOT
    if explicit or root is None or _canonical_ledger_path(ledger) not in {
        _canonical_ledger_path(LEDGER), _canonical_ledger_path(DECISIONS),
    }:
        return None
    return root


def _clone_id_fence_lock(root: Path) -> Path:
    return _git_common_directory(
        root, "could not locate the shared Git directory for ledger id allocation"
    ) / CLONE_WIDE_ID_LOCK_NAME


@contextmanager
def _clone_id_allocation_scope(
    ledger: Path, *, explicit: bool = False,
) -> Iterator[Path | None]:
    """Fence writes and commits before ledger locks, nesting within one clone."""
    global _ACTIVE_ID_RESERVATIONS
    root = _clone_id_allocation_root(ledger, explicit=explicit)
    if root is None:
        yield None
        return
    lock = _clone_id_fence_lock(root)
    key = str(lock)
    holder = _ACTIVE_CLONE_ID_SCOPES.get(key)
    if holder is not None:
        held_root, depth = holder
        if key not in _HELD_LEDGER_LOCKS:
            raise LedgerError(f"clone-wide ledger id fence {lock} is no longer held")
        _ACTIVE_CLONE_ID_SCOPES[key] = held_root, depth + 1
        try:
            yield held_root
        finally:
            _ACTIVE_CLONE_ID_SCOPES[key] = held_root, depth
        return
    acquired, waited = acquire_ledger_lock(lock)
    if not acquired:
        raise LedgerError(f"clone-wide ledger id lock {lock} busy (waited {waited:.2f}s)")
    previous_registry = _ACTIVE_ID_RESERVATIONS
    _ACTIVE_CLONE_ID_SCOPES[key] = root, 1
    try:
        registry = lock.parent / CLONE_WIDE_ID_RESERVATIONS_NAME
        try:
            registry.mkdir(exist_ok=True)
        except OSError as exc:
            raise LedgerError(f"could not open id reservation registry {registry}: {exc}") from exc
        _ACTIVE_ID_RESERVATIONS = registry
        yield root
    finally:
        del _ACTIVE_CLONE_ID_SCOPES[key]
        _ACTIVE_ID_RESERVATIONS = previous_registry
        intent = _ACTIVE_LEDGER_COMMIT
        if intent is not None and intent.replaced and os.environ.get(LEDGER_COMMIT_ENV) != "0":
            # A commit hook can temporarily hide the working allocation. Keep
            # the outer fence until main has attempted the exact-byte commit.
            intent.allocation_lock = lock
            _DEFERRED_LEDGER_LOCKS.add(str(lock))
        else:
            release_ledger_lock(lock, defer=False)


def _id_allocation_test_point(stage: str) -> None:
    # Test-only file barrier, entirely inert without FINDINGS_TEST_ID_ALLOC_BARRIER.
    # Tests observe actual lock contention and pause writes or self-commits.
    barrier = os.environ.get("FINDINGS_TEST_ID_ALLOC_BARRIER")
    if barrier is None:
        return
    path = Path(barrier)
    path.with_suffix(f".{stage}").touch()
    if os.environ.get("FINDINGS_TEST_ID_ALLOC_PAUSE") == stage:
        while not path.with_suffix(".release").exists():
            time.sleep(TEST_BARRIER_POLL_SECONDS)


def _allocation_git(root: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    """Translate Git inspection failures without returning a partial id union."""
    inspection = " ".join(arguments)
    try:
        result = _git_for_ledger(root, *arguments)
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not inspect {root}: git {inspection}: {exc}") from exc
    if result.returncode != 0:
        raise LedgerError(
            f"could not inspect {root}: git {inspection}: {_git_failure_detail(result)}"
        )
    return result


def _allocation_blob_ids(root: Path, ref: str, relative: str, kind: str) -> set[str]:
    """Read identities from a present blob, allowing a ledger not yet tracked."""
    blob = _head_file_blob(root, ref, relative, strict=True)
    if blob is None:
        return set()
    try:
        text = _allocation_git(root, "cat-file", "blob", blob).stdout
    except LedgerError as exc:
        raise LedgerError(f"could not read {root} {ref}:{relative}: {exc}") from exc
    return set(_ledger_content(text, kind, strict=False)[0])


def _allocation_worktree_git_directory(worktree: Path) -> Path:
    """Resolve a live checkout's own metadata, refusing an uninspectable rebase."""
    marker = worktree / ".git"
    try:
        if marker.is_dir():
            return marker.resolve(strict=True)
        text = marker.read_text(encoding="utf-8").strip()
        if not text.startswith("gitdir: ") or not text[8:]:
            raise ValueError(f"invalid gitdir marker {marker}")
        directory = Path(text[8:])
        if not directory.is_absolute():
            directory = worktree / directory
        directory = directory.resolve(strict=True)
        if not directory.is_dir():
            raise ValueError(f"not a Git directory: {directory}")
        return directory
    except (OSError, UnicodeError, ValueError, RuntimeError) as exc:
        raise LedgerError(f"could not resolve Git directory for worktree {worktree}: {exc}") from exc


def _allocation_orig_head(path: Path) -> str | None:
    """Snapshot rebase metadata, allowing only an absent file to mean no rebase."""
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not read rebase original head {path}: {exc}") from exc


def _clone_allocation_ids(
    root: Path | None, ledger: Path, *, retained: Collection[str] = (),
    own_claim: Path | None = None,
) -> set[str]:
    """Collect working, committed, branch, rebase, claimed and upstream ids under the clone lock.

    Reads here deliberately bypass the own-ledger rollback guard: a sibling's
    temporarily shortened working file is covered by its committed HEAD blob.
    Receipt replay never calls this function and therefore mints no new ids.
    """
    if root is None:
        return set()
    for _restart in range(CLONE_ID_COLLECTION_MAX_RESTARTS + 1):
        identifiers = _clone_allocation_ids_once(
            root, ledger, retained=retained, own_claim=own_claim,
        )
        if identifiers is not None:
            return identifiers
    registry = _git_common_directory(
        root, "could not locate the shared Git directory for id reservations"
    ) / CLONE_WIDE_ID_RESERVATIONS_NAME
    raise LedgerError(
        f"clone id snapshot for id reservation registry {registry} kept changing during collection "
        f"after {CLONE_ID_COLLECTION_MAX_RESTARTS} restarts"
    )


def _clone_allocation_ids_once(
    root: Path, ledger: Path, *, retained: Collection[str], own_claim: Path | None,
) -> set[str] | None:
    """Return None when a source change invalidates this entire snapshot."""
    relative = next(
        relative for relative in MERGE_DRIVER_LEDGERS
        if _canonical_ledger_path(root / relative) == _canonical_ledger_path(ledger)
    )
    kind = MERGE_DRIVER_LEDGERS[relative]
    listing = _allocation_git(root, "worktree", "list", "--porcelain", "-z")
    branch_arguments = ("for-each-ref", "--format=%(objectname) %(refname)", "refs/heads")
    branches = _allocation_git(root, *branch_arguments).stdout
    taken: set[str] = set()
    offenders: list[Path] = []
    current_branch: str | None = None
    retained_ids = set(retained)
    working_ledgers: dict[Path, str | None] = {}
    orig_heads: dict[Path, str | None] = {}
    committed_ids: dict[str, set[str]] = {}
    current_head: str | None = None

    def commit_ids(commit: str, source: object) -> set[str]:
        if commit not in committed_ids:
            try:
                committed_ids[commit] = _allocation_blob_ids(root, commit, relative, kind)
            except LedgerError as exc:
                raise LedgerError(f"could not read allocation source {source}: {exc}") from exc
        return committed_ids[commit]

    def include(
        ids: Collection[str], worktree: Path, source: object, *, check: bool = True,
    ) -> None:
        conflicts = retained_ids.intersection(ids) if check else set()
        if conflicts:
            raise LedgerError(
                f"retained id {sorted(conflicts)[0]} conflicts with worktree {worktree} ({source})"
            )
        taken.update(ids)

    for record in listing.stdout.split("\0\0"):
        fields = dict(field.partition(" ")[::2] for field in record.split("\0") if field)
        if not fields:
            continue
        if "worktree" not in fields:
            raise LedgerError(f"could not inspect worktrees of {root}: missing worktree path")
        worktree = Path(fields["worktree"])
        if "prunable" in fields or "bare" in fields:
            continue
        try:
            worktree.stat()
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise LedgerError(f"could not inspect worktree {worktree}: {exc}") from exc
        if worktree.resolve() == root.resolve():
            current_branch = fields.get("branch")
            current_head = fields.get("HEAD")
        if "branch" in fields and worktree.resolve() != root.resolve():
            writer = worktree / CLONE_WIDE_WRITER_PATH
            try:
                writer_text = writer.read_text(encoding="utf-8")
            except FileNotFoundError:
                writer_text = None  # No writer in this checkout to race allocation.
            except (OSError, UnicodeError) as exc:
                raise LedgerError(f"could not read worktree writer {writer}: {exc}") from exc
            if writer_text is not None and CLONE_WIDE_ID_ALLOCATION_CAPABILITY not in writer_text:
                offenders.append(worktree)
        path = worktree / relative
        text = _allocation_working_ledger(path)
        working_ledgers[path] = text
        if text is not None:
            include(
                _ledger_content(text, kind, strict=False)[0], worktree, path,
                check=worktree.resolve() != root.resolve(),
            )
        head = fields.get("HEAD")
        if head is None:
            raise LedgerError(f"could not inspect worktree {worktree}: missing HEAD")
        if head.strip("0"):
            include(
                commit_ids(head, head), worktree, head,
                check=worktree.resolve() != root.resolve(),
            )
        directory = _allocation_worktree_git_directory(worktree)
        for backend in ("rebase-merge", "rebase-apply"):
            path = directory / backend / "orig-head"
            content = _allocation_orig_head(path)
            orig_heads[path] = content
            if content is None:
                continue
            commit = content.strip()
            if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", commit):
                raise LedgerError(f"could not read rebase original head {path}: invalid commit id")
            try:
                if _allocation_git(root, "cat-file", "-t", commit).stdout.strip() != "commit":
                    raise LedgerError("original head is not a commit")
                include(commit_ids(commit, path), worktree, path)
            except LedgerError as exc:
                raise LedgerError(f"could not read rebase original head {path}: {exc}") from exc
    for record in branches.splitlines():
        fields = record.split(" ")
        if (
            len(fields) != 2 or not fields[1].startswith("refs/heads/")
            or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", fields[0])
        ):
            raise LedgerError(f"could not inspect local branches of {root}: malformed ref {record!r}")
        commit, ref = fields
        include(commit_ids(commit, ref), root, ref, check=commit != current_head)
    registry = _git_common_directory(
        root, "could not locate the shared Git directory for id reservations"
    ) / CLONE_WIDE_ID_RESERVATIONS_NAME
    # v1 was never released, and the cutover inventory found no retained consumer claims before this registry.
    try:
        members = sorted(registry.iterdir())
    except OSError as exc:
        raise LedgerError(f"could not enumerate id reservation registry {registry}: {exc}") from exc
    for member in members:
        if member.suffix != ".json":
            continue  # Interrupted atomic-write scratch files reserve no intent.
        try:
            claim, identifiers = _read_id_reservation(member)
        except LedgerError as exc:
            if isinstance(exc.__cause__, FileNotFoundError):
                # Its ids may now live in a HEAD newer than our worktree list.
                return None
            raise
        if own_claim is not None and claim == own_claim.resolve():
            continue
        include(identifiers, claim.parent, member)
    # Detached HEAD has no branch and hence no configured branch upstream.
    if current_branch is not None:
        upstream = _allocation_git(
            root, "for-each-ref", "--format=%(upstream)", current_branch
        ).stdout.strip()
        if upstream:
            include(_allocation_blob_ids(root, upstream, relative, kind), root, upstream)
    # A finalizer can retire a reservation before enumeration even starts.
    # Accept the union only if the HEAD and branch inventories, rebase metadata
    # and every working ledger still match. This cannot detect a non-findings commit whose hook hides a
    # ledger for the WHOLE collection, then fails with HEAD unchanged and the
    # file restored. Findings commits instead hold the allocation fence.
    if _allocation_git(root, "worktree", "list", "--porcelain", "-z").stdout != listing.stdout:
        return None
    if _allocation_git(root, *branch_arguments).stdout != branches:
        return None
    for path, content in orig_heads.items():
        if _allocation_orig_head(path) != content:
            return None
    for path, content in working_ledgers.items():
        if _allocation_working_ledger(path) != content:
            return None
    if offenders:
        # Warn only for the accepted snapshot, once even when collection restarts.
        print(
            "WARNING clone-wide ledger id allocation with incompatible branch worktrees:\n"
            + "\n".join(
                f"{path}: missing {CLONE_WIDE_ID_ALLOCATION_CAPABILITY}. "
                f"Run kit worktree remove {shlex.quote(str(path))} or rebase onto the adopting commit"
                for path in offenders
            )
            + "\nan older writer there can still reuse an id allocated here; "
            "check/merge detects it at integration",
            file=sys.stderr,
        )
    return taken


def _allocation_working_ledger(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None  # An absent working file still contributes its HEAD ids.
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not read live worktree ledger {path}: {exc}") from exc


def _read_id_reservation(path: Path) -> tuple[Path, set[str]]:
    """Refuse an unreadable or malformed member instead of omitting its ids."""
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
        claim = record["claim"]
        identifiers = record["ids"]
        if (
            not isinstance(claim, str) or not Path(claim).is_absolute()
            or path.name != f"{_sha256_text(claim)}.json"
            or not isinstance(identifiers, list)
            or not all(isinstance(value, str) and ID_RE.fullmatch(value) for value in identifiers)
        ):
            raise ValueError("invalid claim or ids")
        return Path(claim), set(identifiers)
    except (OSError, UnicodeError, ValueError, KeyError, TypeError) as exc:
        raise LedgerError(f"could not read id reservation {path}: {exc}") from exc


def _set_claim_id_reservation(
    claim: Path, identifiers: Collection[str], *, retain_previous: bool = False,
    registry: Path | None = None,
) -> None:
    """Publish before intent persistence, release only after its durable update."""
    registry = registry if registry is not None else _ACTIVE_ID_RESERVATIONS
    if registry is None:
        return  # Explicit ledger paths and non-Git writers retain their isolation.
    claim_name = str(claim.resolve())
    path = registry / f"{_sha256_text(claim_name)}.json"
    ids = set(identifiers) - {PENDING_ID}
    try:
        if retain_previous:
            try:
                path.stat()
            except FileNotFoundError:
                pass
            else:
                ids.update(_read_id_reservation(path)[1])
        if ids:
            _fsync_directory(registry.parent)
            _atomic_write(
                path, json.dumps({"claim": claim_name, "ids": sorted(ids)}, sort_keys=True),
                durable_directory=True,
            )
        else:
            path.unlink(missing_ok=True)
            _fsync_directory(registry)
    except OSError as exc:
        raise LedgerError(f"could not update id reservation {path}: {exc}") from exc


def _explicit_allocation_paths(args: argparse.Namespace) -> bool:
    return bool(
        getattr(args, "_explicit_ledger", False)
        or getattr(args, "_explicit_decisions", False)
    )


def ledger_lock_path(ledger: Path) -> Path:
    """Return the lock file path associated with a ledger."""
    resolved = _resolved_repo_path(ledger)
    return resolved.with_name(f"{resolved.name}.lock")


# Open file descriptors for ledger locks this process currently holds, keyed by
# `str(lock)` as passed to `acquire_ledger_lock`. The fd IS the lock -- `flock`
# is released when it is closed or the process dies -- so it has to outlive
# `acquire_ledger_lock`. Callers that need the fd (the drain's ledger-only
# rebase) go through `held_ledger_lock_fd`, not this dict.
_HELD_LEDGER_LOCKS: dict[str, int] = {}
_DEFERRED_LEDGER_LOCKS: set[str] = set()


def _unlock_ledger_lock(lock: Path) -> None:
    """Close a held ledger lock and clear any deferred-release marker."""
    key = str(lock)
    _DEFERRED_LEDGER_LOCKS.discard(key)
    fd = _HELD_LEDGER_LOCKS.pop(key, None)
    if fd is None:
        return
    with suppress(OSError):
        fcntl.flock(fd, fcntl.LOCK_UN)
    with suppress(OSError):
        os.close(fd)


def _release_deferred_ledger_lock(intent: LedgerCommitIntent) -> None:
    """Release ledger ownership, then its allocation fence, after self-commit."""
    lock = ledger_lock_path(intent.ledger)
    try:
        if str(lock) in _DEFERRED_LEDGER_LOCKS:
            _unlock_ledger_lock(lock)
    finally:
        if intent.allocation_lock is not None:
            release_ledger_lock(intent.allocation_lock, defer=False)


def acquire_ledger_lock(
    lock: Path, wait_window_seconds: float | None = None
) -> tuple[bool, float]:
    """Take the ledger-wide writer lock, retrying for the requested window.

    Uses ``flock``, so **the kernel owns liveness**. A lock is released when its
    holder closes the descriptor or dies, by any means including SIGKILL -- there
    is no such thing as a stale lock here, and therefore no PID to record, no
    grace period to tune, no staleness to detect and no reclaim path to race.

    That is the entire reason for the primitive. Two hand-rolled protocols were
    tried first and both were wrong in the same way: acquisition was two steps
    (create, then record the owner), so the lock existed for a window with no
    readable owner, and every reader inside it had to guess from age -- which
    steals the lock of a writer that is merely paused. Rewriting the reclaim to
    be atomic only moved the race: checking that an owner is dead and removing
    its lock are still two steps, so a waiter can delete a lock a third process
    has already legitimately taken. `flock` deletes the question instead of
    answering it, and it is a primitive
    this repository already uses elsewhere for the same reason.

    Nothing writes the lock file either. Recording a PID required truncating a
    file identified only by its path, which was the mechanism that destroyed a
    ledger. A human who wants the holder can ask the kernel with ``fuser`` or
    ``lsof`` on the lock file; that answer is authoritative where a self-reported
    PID was not.
    """
    key = str(lock)
    if key in _DEFERRED_LEDGER_LOCKS:
        if key not in _HELD_LEDGER_LOCKS:
            raise LedgerError(f"deferred ledger lock {lock} is no longer held")
        return True, 0.0
    if wait_window_seconds is None:
        wait_window_seconds = LEDGER_LOCK_WAIT_SECONDS
    started = time.monotonic()
    deadline = started + wait_window_seconds
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o644)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                # A symlink is not a lock this code creates. Following it would
                # take the flock on an unrelated inode, so treat this hostile
                # path as busy without cleanup or retrying; it cannot clear
                # itself during the retry window.
                return False, time.monotonic() - started
            if not isinstance(exc, IsADirectoryError):
                raise LedgerError(f"could not open ledger lock {lock}: {exc}") from exc
            # A lock left behind by the pre-flock protocol, which used a
            # directory. It can only be a corpse: nothing creates one any more.
            #
            # Reproduced 2026-08-21: `acquire_ledger_lock` on a
            # `findings.md.lock/` containing `pid` returned False after 1.00s.
            # Remove only the legacy protocol's regular, non-symlink `pid` file.
            # A symlink at the lock path is left untouched: iterating it could
            # delete files in the directory it targets. Any other child keeps
            # `rmdir` failing rather than sweeping an unrelated path.
            if not lock.is_symlink():
                pid = lock / "pid"
                with suppress(OSError):
                    if pid.is_file() and not pid.is_symlink():
                        pid.unlink()
                with suppress(OSError):
                    os.rmdir(lock)
            if time.monotonic() >= deadline:
                return False, time.monotonic() - started
            continue
        try:
            link_count = os.fstat(fd).st_nlink
        except OSError as exc:
            with suppress(OSError):
                os.close(fd)
            raise LedgerError(f"could not inspect ledger lock {lock}: {exc}") from exc
        if link_count != 1:
            # Check the inode actually opened: multiple links mean another path
            # aliases this file, so taking the flock would make an unrelated
            # process block on that inode. A hostile path gets no cleanup or
            # retry; it cannot clear itself.
            os.close(fd)
            return False, time.monotonic() - started
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            with suppress(OSError):
                os.close(fd)
            if exc.errno not in {
                errno.EWOULDBLOCK,
                errno.EAGAIN,
                errno.EACCES,
            }:
                # `OSError.errno` is Optional. A None errno is not one of the
                # contention codes above, so it already routes here — it just
                # cannot be looked up by name, which `_errno_name` handles.
                errno_name = _errno_name(exc)
                raise LedgerError(
                    f"could not acquire ledger lock {lock}: {errno_name} ({exc})"
                ) from exc
            if lock.name == CLONE_WIDE_ID_LOCK_NAME:
                _id_allocation_test_point("waiting")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False, time.monotonic() - started
            time.sleep(min(LEDGER_LOCK_RETRY_INTERVAL_SECONDS, remaining))
            continue
        _HELD_LEDGER_LOCKS[str(lock)] = fd
        return True, time.monotonic() - started


def held_ledger_lock_fd(lock: Path) -> int | None:
    """Return this process's open flock descriptor for ``lock``, or ``None``.

    The descriptor *is* the lock. Handing it to a child via ``pass_fds`` keeps
    the fence after this process dies, including SIGKILL. ``None`` means this
    process does not currently hold ``lock``; the lookup key is ``str(lock)`` as
    passed to ``acquire_ledger_lock``.
    """
    return _HELD_LEDGER_LOCKS.get(str(lock))


def release_ledger_lock(lock: Path, *, defer: bool = True) -> None:
    """Release the ledger-wide writer lock if this process holds it.

    **The lock file is deliberately left on disk.** Removing it is the classic
    way to break a `flock`: unlink and a waiting process that already opened the
    old inode ends up holding a lock nobody else can see, while the next arrival
    creates a fresh file and locks that -- two owners, on two inodes, of one
    logical lock. Keeping the file makes the inode stable and the exclusion
    total. It costs one empty file beside the ledger, which `.gitignore` covers
    so it cannot dirty the tree a drain checks.

    During ``main()`` a command's intent-ledger release is deferred until its
    exact-byte self-commit attempt finishes. Calls outside ``main()`` retain
    their ordinary immediate-release behavior.
    """
    key = str(lock)
    if key not in _HELD_LEDGER_LOCKS:
        _DEFERRED_LEDGER_LOCKS.discard(key)
        return
    if defer and key in _DEFERRED_LEDGER_LOCKS:
        return
    intent = _ACTIVE_LEDGER_COMMIT
    if defer and intent is not None and lock == ledger_lock_path(intent.ledger):
        _DEFERRED_LEDGER_LOCKS.add(key)
        return
    _unlock_ledger_lock(lock)


def _write_if_unchanged(
    path: Path,
    expected: str,
    candidate: str,
    *,
    durable_directory: bool = False,
) -> None:
    """Write ``candidate`` only if ``path`` still contains ``expected``.

    An unchanged candidate still performs the compare, so a concurrent direct
    edit refuses before the caller's ``post_commit`` callback runs, but it never
    replaces the file: a replacement would register a commit attempt for a
    write that changed nothing.
    """
    current = _read_ledger_text(path)
    if current != expected:
        raise LedgerError(
            f"ledger {path} changed after it was read; refusing to overwrite it"
        )
    if candidate == expected:
        return
    _id_allocation_test_point("write")
    _atomic_write(path, candidate, durable_directory=durable_directory)


@contextmanager
def _ledger_mutation_scope(path: Path) -> Iterator[str]:
    """Own one ledger lock and translate its read/write failures consistently."""
    with ExitStack() as scope:
        if _ACTIVE_LEDGER_COMMIT is not None and os.environ.get(LEDGER_COMMIT_ENV) != "0":
            scope.enter_context(_clone_id_allocation_scope(
                path, explicit=_EXPLICIT_ID_ALLOCATION_PATHS,
            ))
        with _ledger_mutation_scope_clone_locked(path) as text:
            yield text


@contextmanager
def _ledger_mutation_scope_clone_locked(path: Path) -> Iterator[str]:
    path = _canonical_ledger_path(path)
    lock = ledger_lock_path(path)
    try:
        acquired, waited_seconds = acquire_ledger_lock(lock)
    except OSError as exc:
        raise LedgerError(f"could not acquire ledger lock {lock}: {exc}") from exc
    if not acquired:
        raise LedgerError(
            f"ledger lock {lock}: another ledger writer still holds it after "
            f"{waited_seconds:.2f}s of retries"
        )
    try:
        _sweep_scratch(path.parent, lambda target: target == path.name)
        text = _read_ledger_text(path)
        _refuse_controller_export(path, text, "a ledger mutation")
        yield text
    except LedgerError:
        raise
    except OSError as exc:
        raise LedgerError(f"could not mutate ledger {path}: {exc}") from exc
    except UnicodeError as exc:
        raise LedgerError(f"could not read ledger {path}: {exc}") from exc
    finally:
        release_ledger_lock(lock)


def _locked_ledger_mutation(
    path: Path,
    build: Callable[[str], str],
    post_commit: Callable[[], None] | None = None,
) -> None:
    """Run one validated, compare-and-swap mutation under the ledger lock."""
    path = _canonical_ledger_path(path)

    with _ledger_mutation_scope(path) as original:
        candidate = build(original)
        issues = _validate_text(candidate, path)
        if issues:
            raise LedgerError(
                "the mutation would leave the ledger invalid:\n"
                + "\n".join(issues)
            )
        _write_if_unchanged(path, original, candidate)
        if post_commit is not None:
            post_commit()


@dataclass(frozen=True)
class MutationRequest:
    command: str
    target: str
    input_sha256: str
    options: dict[str, object]
    request_id_sha256: str | None
    operation: str


def _mutation_request(
    command: str,
    target: str,
    raw_input: bytes,
    section: str | None,
    request_id: str | None,
    *,
    header_changes: dict[str, str] | None = None,
) -> MutationRequest:
    if request_id is not None and REQUEST_ID_RE.fullmatch(request_id) is None:
        raise LedgerError(
            "--request-id must match [A-Za-z0-9][A-Za-z0-9._-]"
            f"{{0,{REQUEST_ID_MAX_LENGTH - 1}}}"
        )
    input_sha256 = _sha256_bytes(raw_input)
    request_hash = _sha256_text(request_id) if request_id is not None else None
    identity = {
        "command": command,
        "target": target,
        "input_sha256": input_sha256,
        "section": section,
    }
    options: dict[str, object] = {"section": section}
    if header_changes is not None:
        options["headers"] = header_changes
        identity["headers"] = header_changes
    operation_source = (
        {"command": command, "request_id_sha256": request_hash}
        if request_hash is not None
        else identity
    )
    operation = _sha256_text(
        json.dumps(operation_source, sort_keys=True, separators=(",", ":"))
    )
    return MutationRequest(
        command,
        target,
        input_sha256,
        options,
        request_hash,
        operation,
    )


def _receipt_for(
    request: MutationRequest, results: list[str], effect: list[str]
) -> dict[str, object]:
    return {
        "v": LEDGER_META_VERSION,
        "kind": MUTATION_RECEIPT_KIND,
        "command": request.command,
        "operation": request.operation,
        "request_id_sha256": request.request_id_sha256,
        "target": request.target,
        "input_sha256": request.input_sha256,
        "options": request.options,
        "results": results,
        "effect_lines": len(effect),
        "effect_sha256": _sha256_text("\n".join(effect)),
    }


def _receipt_matches_request(data: dict[str, object], request: MutationRequest) -> bool:
    return (
        data.get("command") == request.command
        and data.get("target") == request.target
        and data.get("input_sha256") == request.input_sha256
        and data.get("options") == request.options
        and data.get("request_id_sha256") == request.request_id_sha256
    )


def _close_receipt_updates(
    original: str,
    finding_id: str,
    header_line: str,
    path: Path,
    *,
    close_receipts: Collection[LedgerMeta] | None = None,
) -> dict[int, str]:
    """Keep note/header receipts coupled when a later locked write changes a header."""
    match = HEADER_RE.match(header_line)
    if match is None or match.group("id") != finding_id:
        raise LedgerError(f"could not refresh close receipts for {finding_id}")
    metadata = (
        _validated_mutation_metadata(original, path)
        if close_receipts is None
        else close_receipts
    )
    updates: dict[int, str] = {}
    for meta in metadata:
        if (
            meta.data.get("kind") != MUTATION_RECEIPT_KIND
            or meta.data.get("command") not in {"close", "set-header"}
            or meta.data.get("target") != finding_id
        ):
            continue
        refreshed = dict(meta.data)
        refreshed["header_sha256"] = _sha256_text(header_line)
        refreshed["header_status"] = match.group("status")
        updates[meta.line - 1] = _metadata_line(refreshed)
    return updates


def _place_receipt(candidate: str, receipt_line: str) -> str:
    """Replace the single unfenced receipt anchor and leave quoted examples intact."""
    lines = candidate.splitlines()
    mask = _fence_mask(lines)
    anchors = [
        index
        for index, line in enumerate(lines)
        if mask[index] is FenceState.OUTSIDE and line == RECEIPT_PLACEHOLDER
    ]
    if len(anchors) != 1:
        raise LedgerError("receipt-bearing mutation misplaced its receipt anchor")
    lines[anchors[0]] = receipt_line
    return chr(10).join(lines) + (chr(10) if candidate.endswith(chr(10)) else "")


def _validated_mutation_metadata(text: str, path: Path) -> list[LedgerMeta]:
    """Refuse corrupt receipts before an append, replay, or trailer rewrite."""
    metadata, issues = _scan_ledger_metadata(text, path)
    issues += _receipt_effect_issues(text, path, metadata)
    if issues:
        raise LedgerError("the ledger contains invalid metadata:\n" + "\n".join(issues))
    return metadata


def _locked_receipted_mutation(
    path: Path,
    request: MutationRequest,
    build: Callable[
        [str],
        tuple[str, list[str], list[str]]
        | tuple[str, list[str], list[str], dict[str, object]],
    ],
) -> list[str]:
    """Run or replay one receipt-bearing ledger mutation under its lock."""
    path = _canonical_ledger_path(path)
    with _ledger_mutation_scope(path) as original:
        metadata = _validated_mutation_metadata(original, path)
        matching = [
            meta
            for meta in metadata
            if meta.data.get("kind") == MUTATION_RECEIPT_KIND
            and meta.data.get("command") == request.command
            and meta.data.get("operation") == request.operation
        ]
        if matching:
            receipt = matching[0].data
            if not _receipt_matches_request(receipt, request):
                raise LedgerError(
                    "--request-id was already used for different input, target, "
                    "or options in this ledger command"
                )
            _fsync_directory(path.parent)
            return list(cast(list[str], receipt["results"]))
        built = build(original)
        if len(built) == 3:
            candidate, results, effect = built
            receipt_fields: dict[str, object] = {}
        else:
            candidate, results, effect, receipt_fields = built
        if not effect:
            raise LedgerError("receipt-bearing mutation produced an empty effect")
        receipt = _receipt_for(request, results, effect)
        receipt.update(receipt_fields)
        receipt_line = _metadata_line(receipt)
        candidate = _place_receipt(candidate, receipt_line)
        issues = _validate_text(candidate, path)
        if issues:
            raise LedgerError(
                "the mutation would leave the ledger invalid:\n" + "\n".join(issues)
            )
        _write_if_unchanged(
            path, original, candidate, durable_directory=True
        )
        return results


def _locate_finding_header(text: str, identifier: str) -> tuple[list[str], int]:
    """Return the lines and header index for one real finding id."""
    lines, headers, _ = _unfenced_header_matches(text)
    target = next(
        (
            (header_index, match)
            for _heading_index, header_index, match in headers
            if match.group("id") == identifier
        ),
        None,
    )
    if target is None:
        raise LedgerError(f"finding id {identifier} is not present in the ledger")
    return lines, target[0]


def claim_spool(
    spool: Path,
    claim: Path,
    legacy: Path | None = None,
    *,
    into_existing: bool = False,
) -> list[Path] | None:
    """Take exclusive ownership of a spool's published files, by rename.

    Shared by both spool consumers — the inbox of filed findings and the spool of
    answered decisions. They fold different things into the ledger, but the
    dangerous half is identical, so it lives here once.

    The fixed directory records durable ownership of one batch. ``os.mkdir``
    is atomic, so two consumers cannot both claim the same published files; the
    ledger flock provides writer exclusion across different batches and spool
    consumers. Both are needed because the drain applies answers between
    clusters while `/decide` may apply them from another terminal.

    Claiming by RENAME is what makes a refused batch survivable: it sits at a
    fixed inspectable path instead of having been consumed. A writer publishing
    between the glob and the rename simply lands in the next batch.

    Returns the claimed paths (possibly empty), or None when another consumer
    holds the claim.
    """
    # Checked BEFORE the empty-spool shortcut, never after: a refusal moves the
    # batch INTO the claim, so the spool is normally empty afterwards. Testing
    # emptiness first would hide the leftover in exactly the situation it exists
    # to signal.
    if claim.exists() and not into_existing:
        return None

    published = sorted(spool.glob("*.md"))
    if legacy is not None and legacy.exists():
        published.append(legacy)
    if not published:
        return []
    # Every member lands in the claim under its bare name, and that name is how
    # the merge tells the legacy inbox apart (it has no filing date to read).
    # A spool file carrying it would be misdated, or overwritten on rename.
    if legacy is not None and (spool / legacy.name).exists():
        raise LedgerError(
            f"{spool / legacy.name} is named like the legacy inbox {legacy}; "
            "rename it to <YYYYMMDD-HHMMSS>-<suffix>.md by hand, then retry — "
            "nothing was claimed"
        )

    if into_existing:
        for source in published:
            destination = claim / source.name
            if destination.exists():
                raise LedgerError(
                    f"cannot claim {source} into {destination}: the destination "
                    "already exists; the claim and inbox are unchanged"
                )

    if not into_existing:
        try:
            os.mkdir(claim)
        except FileExistsError:
            # Lost the race between the check above and here. That check is only the
            # cheap early report; this is the mutex.
            return None

        try:
            _write_claim_intent(claim, "claimed")
        except OSError:
            with suppress(OSError):
                claim.rmdir()
            raise

    claimed: list[Path] = []
    for source in published:
        destination = claim / source.name
        try:
            os.rename(source, destination)
        except FileNotFoundError:
            continue
        _remove_consumed_published_twin(spool, source)
        claimed.append(destination)

    if not claimed and not into_existing:
        # Everything vanished under us between the glob and the rename. Drop the
        # claim rather than leaving an empty one: `claim.exists()` means "a batch
        # is sitting outside the queue", and an empty directory asserting that
        # would refuse every later consume until someone deleted it by hand.
        _remove_claim_intent(claim)
        claim.rmdir()
    return claimed


def _claim_intent_path(claim: Path) -> Path:
    return claim / MERGE_INTENT_NAME


def _write_claim_intent(
    claim: Path,
    phase: str,
    ids: set[str] | None = None,
    receipt_ids: dict[str, str | dict[str, str]] | None = None,
    fixed: Collection[str] | None = None,
    *,
    files: dict[str, dict[str, object]] | None = None,
    quarantined: dict[str, str] | None = None,
    manual_repair: bool = False,
    refused: bool = False,
    provisional_ids: dict[str, set[str]] | None = None,
) -> None:
    payload: dict[str, object] = {"phase": phase}
    if ids is not None:
        payload["ids"] = sorted(ids)
    if receipt_ids is not None:
        payload["receipt_ids"] = dict(sorted(receipt_ids.items()))
    if fixed is not None:
        payload["fixed"] = sorted(fixed)
    if files is not None:
        payload["files"] = dict(sorted(files.items()))
    if quarantined:
        payload["quarantined"] = dict(sorted(quarantined.items()))
    if manual_repair:
        payload["manual_repair"] = True
    if refused:
        payload["refused"] = True
    if provisional_ids is not None:
        payload["provisional_ids"] = {
            name: sorted(identifiers)
            for name, identifiers in sorted(provisional_ids.items())
        }
    intent = _claim_intent_path(claim)
    serialized = json.dumps(payload, sort_keys=True)
    if ids is not None:
        _set_claim_id_reservation(claim, ids, retain_previous=True)
    _atomic_write(intent, serialized, durable_directory=True)
    if ids is not None:
        _set_claim_id_reservation(claim, ids)


def _mark_refused_inbox_claim(claim: Path) -> None:
    """Record a never-written deferred batch without changing its intent fields."""
    try:
        intent = _read_claim_intent(claim)
        if intent is None or intent.phase != "prepared":
            return
        path = _claim_intent_path(claim)
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["refused"] = True
        _atomic_write(path, json.dumps(payload, sort_keys=True), durable_directory=True)
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        # Replacement may have succeeded before directory fsync failed.
        print(f"FAIL could not record refusal of {claim}: {exc}", file=sys.stderr)


def _kept_claim_provisional_ids(
    intent: ClaimIntent, names: Collection[str]
) -> dict[str, set[str]] | None:
    """Keep cumulative provisional provenance for the surviving filings."""
    if intent.provisional_ids is None:
        return None
    return {
        name: ids for name, ids in intent.provisional_ids.items() if name in names
    }


def _relocate_claim_file_durably(
    claim: Path,
    destination_dir: Path,
    name: str,
    *,
    conflict_message: str,
    missing_message: str,
    on_move: Callable[[], None] | None = None,
) -> None:
    """Move one claimed file and make either side of a replay durable."""
    source = claim / name
    destination = destination_dir / name
    source_exists = source.exists()
    destination_exists = destination.exists()
    if source_exists and destination_exists:
        raise LedgerError(conflict_message)
    if not source_exists and not destination_exists:
        raise LedgerError(missing_message)

    moved = source_exists
    if moved:
        os.rename(source, destination)
        if on_move is not None:
            on_move()
    _fsync_directory(claim)
    _fsync_directory(destination_dir)


def _mark_answers_claim_manual_repair(claim: Path, ids: Collection[str]) -> None:
    """Durably type an inconsistent prepared answers claim for later readers."""
    intent = _read_claim_intent(claim)
    if intent is None or intent.phase != "prepared" or intent.files is None:
        raise LedgerError(
            f"cannot mark answers claim {claim} for manual repair: "
            "its prepared intent is missing"
        )
    sorted_ids = sorted(set(ids))
    if not sorted_ids or not set(sorted_ids).issubset(intent.ids):
        raise LedgerError(
            f"cannot mark answers claim {claim} for manual repair: "
            "its intent does not record the inconsistent finding ids"
        )
    _write_claim_intent(
        claim,
        intent.phase,
        set(intent.ids),
        cast(dict[str, dict[str, str]], intent.receipt_ids)
        if intent.has_receipt_ids
        else None,
        fixed=intent.fixed if intent.has_fixed else None,
        files=intent.files,
        quarantined=intent.quarantined,
        manual_repair=True,
    )


def _remove_claim_intent(claim: Path) -> None:
    _claim_intent_path(claim).unlink(missing_ok=True)
    for scratch in claim.glob(f"{MERGE_INTENT_NAME}.tmp-*"):
        scratch.unlink(missing_ok=True)
    registry = _ACTIVE_ID_RESERVATIONS
    if registry is None and REPO_ROOT is not None:
        registry = _git_common_directory(
            REPO_ROOT, "could not locate the shared Git directory for id reservations"
        ) / CLONE_WIDE_ID_RESERVATIONS_NAME
    if registry is not None:
        reservation = registry / f"{_sha256_text(str(claim.resolve()))}.json"
        try:
            reservation.stat()
        except FileNotFoundError:
            return
        _fsync_directory(claim)
        _set_claim_id_reservation(claim, (), registry=registry)


def _relocate_quarantined_files(
    claim: Path,
    refused: Path,
    quarantined: dict[str, str],
    *,
    directory_kind: str,
    missing_kind: str,
) -> None:
    """Move claimed files into ``refused``.

    A file already at its destination is the completed half of a crashed move
    and is accepted on replay.
    """
    if not quarantined:
        return
    try:
        if not refused.exists():
            refused.mkdir(parents=True)
        elif not refused.is_dir():
            raise LedgerError(
                f"cannot quarantine {directory_kind}: {refused} exists but is not "
                "a directory"
            )
        _fsync_directory(refused.parent)
        for name, reason in sorted(quarantined.items()):
            _relocate_claim_file_durably(
                claim,
                refused,
                name,
                conflict_message=(
                    f"cannot quarantine {name}: destination {refused / name} "
                    "already exists"
                ),
                missing_message=(
                    f"quarantined {missing_kind} {name} is missing from both "
                    f"{claim} and {refused}; the claim is kept"
                ),
                on_move=lambda name=name, reason=reason: print(
                    f"quarantined {name}: {reason}"
                ),
            )
    except LedgerError:
        raise
    except OSError as exc:
        raise LedgerError(
            f"could not quarantine {directory_kind} from {claim} into {refused}: "
            f"{exc}"
        ) from exc


def _quarantine_claim_files(
    claim: Path, spool: Path, intent: ClaimIntent
) -> None:
    """Move intent-recorded irregular answer files to a durable side directory.

    Quarantine is part of the claim lifecycle. The intent is written before this
    move, so a crash leaves a restartable record; a file already at its refused
    destination is the completed half of that move and is accepted on replay.
    """
    _relocate_quarantined_files(
        claim,
        spool.with_name(f"{spool.name}.refused"),
        intent.quarantined,
        directory_kind="answers",
        missing_kind="answer",
    )


def _inbox_quarantines_from_intent(
    inbox: Path, intent: ClaimIntent
) -> dict[str, str]:
    """Find inbox files whose receipts durably record a quarantine outcome."""
    refused = inbox.with_name(f"{inbox.name}.refused")
    quarantined: dict[str, str] = {}
    for value in intent.receipt_ids.values():
        if not isinstance(value, dict):
            continue
        receipt_name = value.get("receipt")
        published = value.get("published")
        if not isinstance(receipt_name, str) or not isinstance(published, str):
            continue
        receipt = _read_receipt(receipt_directory(inbox) / receipt_name)
        if receipt is None or receipt["state"] != "quarantined":
            continue
        expected_refused = str(refused / published)
        if (
            receipt.get("published") != published
            or receipt.get("refused") != expected_refused
        ):
            raise LedgerError(
                f"quarantined receipt for {published} does not name its expected "
                f"refused path {expected_refused}"
            )
        reason = receipt["reason"]
        previous = quarantined.get(published)
        if previous is not None and previous != reason:
            raise LedgerError(
                f"quarantined receipts for {published} record different reasons"
            )
        quarantined[published] = reason
    return quarantined


def _write_quarantined_inbox_receipts(
    inbox: Path,
    receipt_ids: dict[str, str | dict[str, str]],
    quarantined: dict[str, str],
) -> None:
    """Persist terminal receipts before moving any refused inbox bytes."""
    refused = inbox.with_name(f"{inbox.name}.refused")
    for value in receipt_ids.values():
        if not isinstance(value, dict):
            continue
        published = value["published"]
        reason = quarantined.get(published)
        if reason is None:
            continue
        receipt_name = value.get("receipt")
        if not isinstance(receipt_name, str):
            raise LedgerError(
                f"claim receipt for {published} has no durable receipt filename"
            )
        record = {
            "state": "quarantined",
            "published": published,
            "id": value["id"],
            "reason": reason,
            "refused": str(refused / published),
        }
        existing = _read_receipt(receipt_directory(inbox) / receipt_name)
        if existing is not None and existing["state"] == "quarantined":
            if any(existing.get(key) != record[key] for key in record):
                raise LedgerError(
                    f"quarantined receipt {receipt_name} conflicts with the claim"
                )
            continue
        if existing is not None and "part" in existing:
            record["part"] = existing["part"]
        _write_receipt(receipt_directory(inbox) / receipt_name, record)


def _recover_inbox_quarantines(
    claim: Path, inbox: Path, intent: ClaimIntent
) -> ClaimIntent:
    """Finish receipt-recorded inbox quarantines and trim the claim to kept files."""
    quarantined = _inbox_quarantines_from_intent(inbox, intent)
    if not quarantined:
        return intent

    # Complete every receipt before the first move. A crash during this loop is
    # replayable because at least one already-written terminal receipt names the
    # file and this function repairs the remaining receipts on the next pass.
    _write_quarantined_inbox_receipts(inbox, intent.receipt_ids, quarantined)

    _relocate_quarantined_files(
        claim,
        inbox.with_name(f"{inbox.name}.refused"),
        quarantined,
        directory_kind="inbox filings",
        missing_kind="inbox filing",
    )

    quarantined_ids = {
        value["id"]
        for value in intent.receipt_ids.values()
        if isinstance(value, dict) and value["published"] in quarantined
    }
    kept_receipts = {
        key: value
        for key, value in intent.receipt_ids.items()
        if not isinstance(value, dict) or value["published"] not in quarantined
    }
    kept_ids = set(intent.ids) - quarantined_ids
    kept_fixed = set(intent.fixed) - quarantined_ids
    _write_claim_intent(
        claim,
        intent.phase,
        kept_ids,
        kept_receipts,
        fixed=kept_fixed if intent.has_fixed else None,
        **({"manual_repair": True} if intent.manual_repair else {}),
        refused=intent.refused,
        provisional_ids=_kept_claim_provisional_ids(
            intent, {path.name for path in intent.claimed} - set(quarantined)
        ),
    )
    updated = _read_claim_intent(claim)
    if updated is None:
        raise LedgerError(f"claim {claim} disappeared while recording quarantine")
    return updated


def _immediate_entry_id(
    identifier: str,
    published: str,
    index: int,
    count: int,
    receipt_ids: dict[str, str | dict[str, str]] | None,
) -> str | None:
    """Map a placeholder to its allocation, including older dict keys.

    Unmappable placeholders in legacy intents use id presence alone in the proof.
    """
    if identifier != PENDING_ID:
        return identifier
    if receipt_ids is None:
        return None
    key = published if count == 1 else f"{published}#{index}"
    record = receipt_ids.get(key)
    if not isinstance(record, dict) and count == 1:
        matching = [
            value
            for value in receipt_ids.values()
            if isinstance(value, dict) and value["published"] == published
        ]
        record = matching[0] if len(matching) == 1 else None
    if isinstance(record, dict) and record["published"] == published:
        return record["id"]
    return None


def _claim_release_records(
    claim: Path,
    spool: Path,
    claimed: list[Path],
    receipt_ids: dict[str, str | dict[str, str]] | None,
    proven_ids: Collection[str],
) -> list[tuple[str, str, str]]:
    """Check intent/file agreement without writing receipts or releasing files."""
    records = (
        _receipt_records_from_intent(claim, receipt_ids) if receipt_ids else []
    )
    recorded = {published for _receipt, published, _identifier in records}
    unrecorded: list[str] = []
    for path in claimed:
        if receipt_ids is not None and path.name not in recorded:
            unrecorded.append(path.name)
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            continue
        except (OSError, UnicodeError) as exc:
            raise LedgerError(
                f"could not read {path} while releasing {claim}: {exc}"
            ) from exc
        carried = header_ids(text)
        headers = _unfenced_header_matches(text)[1]
        for index, (_heading, _header, match) in enumerate(headers):
            if match.group("id") != PENDING_ID:
                continue
            identifier = _immediate_entry_id(
                PENDING_ID, path.name, index, len(headers), receipt_ids
            )
            if identifier is not None:
                carried.add(identifier)
            elif receipt_ids is None:
                carried.update(proven_ids)
        recorded_ids = {
            identifier
            for _receipt, published, identifier in records
            if published == path.name
        }
        if (
            not carried
            or not carried.issubset(proven_ids)
            or not recorded_ids.issubset(carried)
        ):
            unrecorded.append(path.name)
    if unrecorded:
        raise LedgerError(
            f"{', '.join(sorted(unrecorded))} in {claim} carries no recorded entry; "
            f"the claim is kept — move it back to {spool} by hand, then retry"
        )
    return records


def _claimed_entry_finding(
    entry_text: str, ledger_text: str, ledger: Path
) -> Finding | None:
    """Return exactly one valid claimed finding, allowing its pending allocation."""
    parsed, problems, vocabulary = _parse_text(
        _entry_candidate_text(entry_text, ledger_text), ledger
    )
    if (
        len(parsed) != 1
        or problems
        or validate(parsed, problems, vocabulary, allow_pending=True)
    ):
        return None
    return parsed[0]


def _entry_line_regions(
    text: str,
) -> list[tuple[str, tuple[str, ...], tuple[str, ...]]]:
    """Slice non-blank leading and body lines at the receipt parser's headings.

    Leading lines start after the preceding entry's header, or at the file start;
    body lines end before the next valid entry heading, or at EOF.
    """
    lines, headers, _orphans = _unfenced_header_matches(text)
    regions: list[tuple[str, tuple[str, ...], tuple[str, ...]]] = []
    previous_header = -1
    for index, (heading_index, header_index, match) in enumerate(headers):
        end = headers[index + 1][0] if index + 1 < len(headers) else len(lines)
        leading = tuple(
            line for line in lines[previous_header + 1:heading_index] if line.strip()
        )
        body = tuple(line for line in lines[header_index + 1:end] if line.strip())
        regions.append((match.group("id"), leading, body))
        previous_header = header_index
    return regions


def _claimed_file_content_proven(
    path: Path,
    ledger: Path,
    ledger_text: str,
    actual: dict[str, Finding],
    ledger_regions: dict[str, tuple[tuple[str, ...], tuple[str, ...]]],
    entry_id: Callable[[str, int, int, FindingExpectation], str | None],
    *,
    unmapped_entry: Callable[
        [FindingExpectation, tuple[str, ...], tuple[str, ...]], bool
    ] | None = None,
) -> bool:
    """Prove a claimed file's structure and ordered whole-file ledger coverage."""
    try:
        sources = _merge_sources([path], ledger)
        text = sources[0] if sources else ""
        parsed, problems, _vocabulary = _parse_text(
            _entry_candidate_text(text, ledger_text), ledger
        )
        _lines, _headers, orphans = _unfenced_header_matches(text)
        entries = _receipt_entry_texts(text)
        regions = _entry_line_regions(text)
        if (
            problems
            or not entries
            or len(parsed) != len(entries)
            or any(finding.controller_export for finding in parsed)
            or orphans
            or len(regions) != len(entries)
        ):
            return False
        for index, entry_text in enumerate(entries):
            finding = _claimed_entry_finding(entry_text, ledger_text, ledger)
            if finding is None or finding.controller_export:
                return False
            _identifier, leading, raw_body = regions[index]
            prefix = leading if index == 0 else ()
            expected = _finding_expectation(finding)
            identifier = entry_id(path.name, index, len(entries), expected)
            if identifier is None:
                if unmapped_entry is None or not unmapped_entry(expected, prefix, raw_body):
                    return False
                continue
            finding = actual.get(identifier)
            if finding is None or not _finding_identity_preserved(expected, finding):
                return False
            ledger_region = ledger_regions.get(identifier)
            if ledger_region is None:
                return False
            ledger_leading, ledger_body = ledger_region
            if not _ordered_content_preserved(prefix, ledger_leading):
                return False
            if not _ordered_content_preserved(raw_body, ledger_body):
                return False
    except LedgerReadRefused:
        raise
    except _READ_ERRORS_LEDGER:
        return False
    return True


def _immediate_claim_content_proven(
    claim: Path, ledger: Path, ledger_text: str, intent: ClaimIntent
) -> bool:
    """Prove ordered content coverage with insertions allowed, not write provenance.

    Each entry's body lines must occur within its ledger span, and a file's leading
    lines must occur before its first entry's ledger heading.
    Unmapped legacy placeholders retain id-presence proof only when their parser
    body accounts for every source line beyond the title and consumed header.
    """
    try:
        findings, _problems, _vocabulary = _parse_text(ledger_text, ledger)
        ledger_regions = {
            identifier: (leading, body)
            for identifier, leading, body in _entry_line_regions(ledger_text)
        }
    except LedgerReadRefused:
        raise
    except (OSError, UnicodeError, LedgerError) as exc:
        raise LedgerError(
            f"could not parse ledger {ledger} while recovering {claim}: {exc}"
        ) from exc
    actual = {finding.id: finding for finding in findings}
    current_ids = header_ids(ledger_text)
    receipt_ids = intent.receipt_ids if intent.has_receipt_ids else None
    dict_records = any(isinstance(value, dict) for value in intent.receipt_ids.values())
    claimed_names = {path.name for path in intent.claimed}
    for record in intent.receipt_ids.values():
        if (
            isinstance(record, dict)
            and record["published"] not in claimed_names
            and record["id"] not in current_ids
        ):
            return False

    def unmapped_entry(
        expected: FindingExpectation, prefix: tuple[str, ...], raw_body: tuple[str, ...]
    ) -> bool:
        # Older intents cannot map a placeholder to its minted id.
        if dict_records or not all(item in current_ids for item in intent.ids):
            return False
        return not prefix and _ordered_content_preserved(raw_body, expected.body)

    def entry_id(
        name: str, index: int, count: int, expected: FindingExpectation
    ) -> str | None:
        return _immediate_entry_id(
            expected.identifier, name, index, count, receipt_ids
        )

    for path in intent.claimed:
        if not _claimed_file_content_proven(
            path, ledger, ledger_text, actual, ledger_regions, entry_id,
            unmapped_entry=unmapped_entry,
        ):
            return False
    return True


def _complete_claim(
    claim: Path,
    spool: Path,
    claimed: list[Path],
    records: list[tuple[str, str, str]],
    *,
    publish_locked: bool,
) -> None:
    """Write terminal receipts and release an agreeing, content-proven claim."""
    if records:
        _write_merged_receipts(spool, records)
    release_spool(claim, spool, claimed, publish_locked=publish_locked)


def _write_merged_receipts(inbox: Path, records: list[tuple[str, str, str]]) -> None:
    """Record the consumer outcome for each claimed filing."""
    for receipt_name, published, identifier in records:
        path = receipt_directory(inbox) / receipt_name
        existing = _read_receipt(path)
        if existing is not None and existing["state"] == "merged":
            if (
                existing.get("published") != published
                or existing.get("id") != identifier
            ):
                raise LedgerError(
                    f"merged receipt {path} does not match the claimed outcome"
                )
            continue
        record = {"state": "merged", "published": published, "id": identifier}
        if existing is not None and "part" in existing:
            record["part"] = existing["part"]
        _write_receipt(path, record)


def _receipt_records_from_intent(
    claim: Path,
    receipt_ids: dict[str, str | dict[str, str]],
    *,
    keys: Collection[str] | None = None,
) -> list[tuple[str, str, str]]:
    """Reconstruct merged receipts from the durable claim intent."""
    claimed = sorted(claim.glob("*.md"))
    selected = set(keys) if keys is not None else set(receipt_ids)
    records: list[tuple[str, str, str]] = []
    for filing_key, receipt in receipt_ids.items():
        if filing_key not in selected:
            continue
        if isinstance(receipt, dict):
            receipt_name = receipt.get("receipt", f"{filing_key}.json")
            records.append((receipt_name, receipt["published"], receipt["id"]))
            continue

        # Intents written before the published name was persisted still need a
        # scan. A receipt that cannot be mapped to exactly one claimed file
        # REFUSES below and preserves the claim. Releasing it instead reports
        # success while destroying the id mapping the receipt exists to carry,
        # and a released claim cannot be retried; a preserved one can.
        identifier = receipt
        matching: list[Path] = []
        for path in claimed:
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc:
                raise LedgerError(
                    f"claim intent {claim} could not read {path} while mapping "
                    f"receipt {filing_key}: {exc}"
                ) from exc
            if identifier in header_ids(content):
                matching.append(path)
        if len(matching) != 1:
            raise LedgerError(
                f"claim intent {claim} cannot map receipt {filing_key} to "
                "exactly one claimed file; refusing to release the claim"
            )
        records.append((f"{filing_key}.json", matching[0].name, identifier))
    return records


def _receipt_intent_key_is_valid(key: object) -> bool:
    """Validate a receipt-intent key from either the current or legacy format."""
    if not isinstance(key, str):
        return False
    if re.fullmatch(r"[0-9a-f]{64}", key):
        return True
    path_name, separator, entry_index = key.partition("#")
    return (
        path_name.endswith(".md")
        and Path(path_name).name == path_name
        and (not separator or entry_index.isdecimal())
    )


def _validate_answers_files(
    claim: Path,
    files: object,
    ids: list[str],
    quarantined: dict[str, str] | None = None,
) -> dict[str, dict[str, object]]:
    """Validate and authenticate the recorded effect of an answers claim."""
    if not isinstance(files, dict):
        raise ValueError("files must be an object")
    if len(ids) != len(set(ids)) or set(ids) != {
        value.get("id")
        for value in files.values()
        if isinstance(value, dict) and isinstance(value.get("id"), str)
    }:
        raise ValueError("files ids do not match ids")
    result: dict[str, dict[str, object]] = {}
    for name, value in files.items():
        if (
            not isinstance(name, str)
            or not name.endswith(".md")
            or name in {".", ".."}
            or Path(name).name != name
        ):
            raise ValueError("invalid answers file name")
        if not isinstance(value, dict):
            raise ValueError("answers file records must be objects")
        identifier = value.get("id")
        is_quarantined = quarantined is not None and name in quarantined
        # A fresh unreadable answer cannot reveal its id or answer class.  The
        # caller records an explicit tombstone so the durable quarantine name is
        # still a member of ``files``; prepared claims retain their real id and
        # continue through the full schema below.
        if is_quarantined and identifier is None:
            if value.get("kind") != "quarantine":
                raise ValueError("invalid quarantined answer record")
            result[name] = value
            continue
        blocked = value.get("blocked")
        status = value.get("status")
        kind = value.get("kind")
        evidence = value.get("evidence")
        previous_occurrences = value.get("previous_occurrences")
        previous_line_occurrences = value.get("previous_line_occurrences")
        if not isinstance(identifier, str) or ID_RE.fullmatch(identifier) is None:
            raise ValueError("invalid answers file id")
        if not isinstance(blocked, str) or classify_blocker(blocked) != BLOCKER_ANSWERABLE:
            raise ValueError("answers file blocker is not answerable")
        if not isinstance(status, str) or status not in STATUSES:
            raise ValueError("invalid answers file status")
        if kind != "decision":
            raise ValueError("invalid answers file kind")
        if (
            not isinstance(evidence, list)
            or not evidence
            or not all(isinstance(line, str) for line in evidence)
        ):
            raise ValueError("invalid answers file evidence")
        if (
            not isinstance(previous_occurrences, int)
            or isinstance(previous_occurrences, bool)
            or previous_occurrences < 0
        ):
            raise ValueError("invalid previous evidence occurrence count")
        if not isinstance(previous_line_occurrences, dict):
            raise ValueError("invalid previous evidence line counts")
        distinct_evidence = set(evidence)
        if set(previous_line_occurrences) != distinct_evidence:
            raise ValueError("previous evidence line counts do not match evidence")
        if any(
            not isinstance(count, int)
            or isinstance(count, bool)
            or count < 0
            for count in previous_line_occurrences.values()
        ):
            raise ValueError("invalid previous evidence line count")
        result[name] = value

    record_ids = {
        cast(str, value["id"])
        for value in result.values()
        if isinstance(value.get("id"), str)
    }
    if len(record_ids) != sum(
        1 for value in result.values() if isinstance(value.get("id"), str)
    ):
        raise ValueError("duplicate answers file ids")

    for name, value in result.items():
        path = claim / name
        if _entry_state(path) == _ENTRY_ABSENT:
            continue
        if quarantined is not None and name in quarantined:
            continue
        try:
            parsed = _parse_answer_file(path)
        except (OSError, UnicodeError) as exc:
            if quarantined is None:
                raise LedgerError(f"could not read {path}: {exc}") from exc
            quarantined[name] = "unreadable"
            continue
        if parsed is None:
            raise LedgerError(f"could not read {path}: invalid answer file")
        identifier, bullet = parsed
        if identifier != value["id"]:
            raise LedgerError(
                f"could not read {path}: answer id {identifier} does not match "
                f"recorded id {value['id']}"
            )
        if bullet != value["evidence"]:
            raise LedgerError(
                f"could not read {path}: recorded evidence does not match the "
                "answer file"
            )
    return result


def _read_claim_intent(
    claim: Path, *, strict: bool = True
) -> ClaimIntent | None:
    """Read one claim intent and preserve whether it uses a legacy shape."""
    if not _entry_exists(claim, directory=True):
        return None
    intent_path = _claim_intent_path(claim)
    claimed = tuple(sorted(claim.glob("*.md")))
    # The claim itself was proven present above; a missing or dangling intent
    # with claimed members is refused just below, while one without members is
    # handled by the caller.
    if not intent_path.exists():
        if not claimed:
            return None
        raise LedgerError(
            f"a claim at {claim} has no {MERGE_INTENT_NAME}; it predates durable "
            "claim recovery. Restore or inspect it before retrying."
        )
    try:
        record = json.loads(intent_path.read_text(encoding="utf-8"))
        if not isinstance(record, dict):
            raise TypeError("expected a JSON object")
        phase = record["phase"]
        if phase not in {"claimed", "prepared"}:
            raise ValueError(f"unknown phase {phase!r}")
        manual_repair = record.get("manual_repair", False)
        if not isinstance(manual_repair, bool):
            raise ValueError("manual_repair must be a boolean")
        refused = record.get("refused", False)
        if not isinstance(refused, bool):
            raise ValueError("refused must be a boolean")
        provisional_ids = None
        raw_provisional = record.get("provisional_ids")
        if raw_provisional is not None:
            if not isinstance(raw_provisional, dict):
                raise TypeError("provisional_ids must be an object")
            provisional_ids = {}
            for name, identifiers in raw_provisional.items():
                if (
                    not isinstance(name, str)
                    or not name.endswith(".md")
                    or Path(name).name != name
                    or not isinstance(identifiers, list)
                    or not all(
                        isinstance(identifier, str) and ID_RE.fullmatch(identifier) is not None
                        for identifier in identifiers
                    )
                ):
                    raise ValueError("invalid provisional_ids record")
                provisional_ids[name] = set(identifiers)
        raw_receipts = record.get("receipt_ids")
        receipt_ids: dict[str, str | dict[str, str]] = {}
        if raw_receipts is not None:
            if not isinstance(raw_receipts, dict):
                raise TypeError("receipt_ids must be an object")
            for filing_key, receipt in raw_receipts.items():
                if not _receipt_intent_key_is_valid(filing_key):
                    raise ValueError("invalid receipt_ids key")
                if isinstance(receipt, str):
                    if ID_RE.fullmatch(receipt) is None:
                        raise ValueError("invalid receipt id")
                    receipt_ids[filing_key] = receipt
                    continue
                if not isinstance(receipt, dict):
                    raise TypeError("receipt_ids values must be objects")
                if set(receipt) not in (
                    {"id", "published"},
                    {"id", "published", "receipt"},
                ):
                    raise ValueError("invalid receipt record")
                identifier = receipt.get("id")
                published = receipt.get("published")
                receipt_name = receipt.get("receipt")
                if (
                    not isinstance(identifier, str)
                    or ID_RE.fullmatch(identifier) is None
                    or not isinstance(published, str)
                    or not published
                    or Path(published).name != published
                    or (
                        receipt_name is not None
                        and (
                            not isinstance(receipt_name, str)
                            or not receipt_name.endswith(".json")
                            or Path(receipt_name).name != receipt_name
                        )
                    )
                ):
                    raise ValueError("invalid receipt record")
                receipt_ids[filing_key] = {
                    "id": identifier,
                    "published": published,
                    **({"receipt": receipt_name} if receipt_name is not None else {}),
                }

        raw_ids = record.get("ids")
        if raw_ids is None:
            ids = [
                receipt["id"] if isinstance(receipt, dict) else receipt
                for receipt in receipt_ids.values()
            ]
        elif not strict:
            ids = (
                list(raw_ids)
                if isinstance(raw_ids, list)
                and all(isinstance(identifier, str) for identifier in raw_ids)
                else []
            )
        else:
            if not isinstance(raw_ids, list) or not all(
                isinstance(identifier, str) and ID_RE.fullmatch(identifier) is not None
                for identifier in raw_ids
            ):
                raise ValueError("invalid ids")
            ids = list(raw_ids)
            if len(ids) != len(set(ids)):
                raise ValueError("duplicate ids")

        raw_fixed = record.get("fixed")
        if raw_fixed is None:
            fixed: set[str] = set()
        elif not strict:
            fixed = set()
        else:
            if not isinstance(raw_fixed, list) or not all(
                isinstance(identifier, str)
                and ID_RE.fullmatch(identifier) is not None
                for identifier in raw_fixed
            ):
                raise ValueError("invalid fixed ids")
            fixed = set(raw_fixed)
        files = None
        quarantined: dict[str, str] = {}
        raw_quarantined = record.get("quarantined")
        if raw_quarantined is not None:
            if not isinstance(raw_quarantined, dict):
                raise TypeError("quarantined must be an object")
            for name, reason in raw_quarantined.items():
                if (
                    not isinstance(name, str)
                    or not isinstance(reason, str)
                    or not reason
                ):
                    raise ValueError("invalid quarantined record")
                quarantined[name] = reason
        if "files" in record:
            files = _validate_answers_files(
                claim, record["files"], ids, quarantined
            )
            # Prepared claims carry a complete file record for every answer,
            # including a file discovered unreadable during recovery.  A
            # direct apply may have no readable id to record at all; its
            # quarantine-only intent is the one explicit empty-files case.
            if any(name not in files for name in quarantined):
                raise ValueError("quarantined file is absent from files")
            # Persist unreadable-file discoveries before a recovery caller can
            # move or replay any member of this claim.
            if quarantined and raw_quarantined != quarantined:
                _write_claim_intent(
                    claim,
                    phase,
                    set(ids),
                    receipt_ids if raw_receipts is not None else None,
                    fixed if raw_fixed is not None else None,
                    files=files,
                    quarantined=quarantined,
                    **({"manual_repair": True} if manual_repair else {}),
                )
        elif quarantined:
            raise ValueError("quarantined requires files")
        return ClaimIntent(
            phase,
            ids,
            receipt_ids,
            raw_receipts is not None,
            fixed,
            raw_fixed is not None,
            claimed,
            files,
            quarantined,
            manual_repair,
            refused,
            provisional_ids,
        )
    except _MERGE_INTENT_ERRORS as exc:
        raise LedgerError(f"could not read {intent_path}: {exc}") from exc


def _recover_claim(
    claim: Path,
    spool: Path,
    ledger: Path,
    *,
    answers: bool = False,
    publish_locked: bool = False,
    durable_replay: bool = False,
) -> None:
    """Finish or replay a stranded claim using its durable intent record."""
    if not _entry_exists(claim, directory=True):
        return

    intent = _read_claim_intent(claim, strict=False)
    if intent is None:
        _remove_claim_intent(claim)
        claim.rmdir()
        return
    if not answers:
        intent = _recover_inbox_quarantines(claim, spool, intent)
    else:
        _quarantine_claim_files(claim, spool, intent)
    claimed = list(intent.claimed)
    if intent.phase == "prepared" and not answers:
        ids = [
            cast(str, value["id"])
            for name, value in (intent.files or {}).items()
            if name not in intent.quarantined and isinstance(value.get("id"), str)
        ] or [identifier for identifier in intent.ids if not intent.quarantined]
        if ids:
            try:
                ledger_text = _read_ledger_text(ledger)
            except (OSError, UnicodeError) as exc:
                raise LedgerError(
                    f"could not read ledger {ledger} while recovering {claim}: {exc}"
                ) from exc
            current_ids = header_ids(ledger_text)
            complete = all(identifier in current_ids for identifier in ids)
            if complete:
                records = _claim_release_records(
                    claim, spool, claimed,
                    intent.receipt_ids if intent.has_receipt_ids else None, ids,
                )
                complete = _immediate_claim_content_proven(
                    claim, ledger, ledger_text, intent
                )
            if complete:
                _complete_claim(
                    claim,
                    spool,
                    claimed,
                    records,
                    publish_locked=publish_locked,
                )
                print(
                    f"NOTE completed stranded batch from {claim}; the ledger already "
                    "contains every recorded id",
                    file=sys.stderr,
                )
                return

    # Immediate replay must never resemble an interrupted release. Deferred
    # prepared claims go through reconciliation, which refuses missing filings
    # rather than completing by id presence, so deferred replay needs no sync.
    if durable_replay and not answers:
        try:
            if intent.phase == "prepared":
                _write_claim_intent(claim, "claimed")
            _fsync_directory(claim)
        except OSError as exc:
            raise LedgerError(f"could not durably prepare replay of {claim}: {exc}") from exc

    # The work returns first, then the intent and claim disappear.
    legacy = None if answers else spool.with_suffix(".md")
    spool.mkdir(parents=True, exist_ok=True)
    for path in claimed:
        _return_claimed_file(path, spool, legacy)
    _remove_claim_intent(claim)
    claim.rmdir()


def _return_claimed_file(path: Path, spool: Path, legacy: Path | None) -> None:
    """Move one claimed file back to where the next merge-inbox claims it again.

    The legacy inbox returns to its own path: in the spool its name would read
    as a misnamed filing, which `claim_spool` refuses.
    """
    if legacy is None or path.name != legacy.name:
        os.rename(path, spool / path.name)
        return
    if legacy.exists():
        raise LedgerError(
            f"cannot return {path} to {legacy}: a new legacy inbox exists there; "
            f"merge the two by hand, then retry — {path.parent} is kept"
        )
    os.rename(path, legacy)


def _release_spool_contents(claim: Path, spool: Path, claimed: list[Path]) -> None:
    """Remove claimed files and the claim, leaving spool-directory cleanup aside."""
    for path in claimed:
        path.unlink(missing_ok=True)
    _remove_claim_intent(claim)
    claim.rmdir()


def release_spool(
    claim: Path,
    spool: Path,
    claimed: list[Path],
    *,
    publish_locked: bool = False,
) -> None:
    """Drop the claim and the spool directory once a batch is consumed.

    The spool is transient published work, not a drain-running signal, so an empty
    directory should be removed after a successful merge. ENOTEMPTY is expected
    rather than exceptional: a writer may publish between the claim and here, and
    that entry belongs to the next batch.
    """
    # Cleanup follows the ledger commit, so failures are warnings and not retries.
    try:
        _release_spool_contents(claim, spool, claimed)
    except OSError as exc:
        print(
            f"WARN ledger write committed but could not clean up claim {claim}: {exc}",
            file=sys.stderr,
        )
        return

    def remove_spool() -> None:
        try:
            spool.rmdir()
        except FileNotFoundError:
            pass
        except OSError as exc:
            if exc.errno != errno.ENOTEMPTY:
                print(
                    f"WARN ledger write committed but could not remove spool "
                    f"{spool}: {exc}",
                    file=sys.stderr,
                )

    if publish_locked:
        remove_spool()
    else:
        try:
            with _publish_lock(publish_lock_path(spool)):
                remove_spool()
        except LedgerError as exc:
            print(
                f"WARN ledger write committed but could not lock spool {spool} "
                f"for cleanup: {exc}",
                file=sys.stderr,
            )


def _report_refused_claim(
    claim: Path, *, batch: str, action: str, stranded: str
) -> int:
    """Report a refused spool batch that remains outside the ledger."""
    batch_label = f" of {batch}" if batch else ""
    print(
        f"FAIL a previously refused batch{batch_label} is still unresolved: {claim}\n"
        f"Fix or remove it before {action} again — proceeding would work the queue "
        f"while {stranded} sits outside it.\n"
        f"To retry: correct the files in place, move them back into the spool, and "
        f"remove the empty claim directory. Nothing re-reads the claim on its own — "
        f"its existence is the stop signal, so a fixed batch left there stays stranded.",
        file=sys.stderr,
    )
    return 1


def _ledger_lock_busy_message(lock: Path, waited_seconds: float) -> str:
    """Format the shared busy diagnostic for command and settle refusals."""
    return (
        f"ledger lock {lock}: another ledger writer still holds it after "
        f"{waited_seconds:.2f}s of retries (window "
        f"{LEDGER_LOCK_WAIT_SECONDS:.2f}s)."
    )


def _report_ledger_lock_busy(lock: Path, waited_seconds: float) -> int:
    """Report that another ledger writer still owns the shared lock."""
    print(f"FAIL {_ledger_lock_busy_message(lock, waited_seconds)}", file=sys.stderr)
    return 1


def _merge_sources(claimed: list[Path], ledger: Path) -> list[str]:
    """Read, refuse and normalise each claimed filing before it enters the ledger."""
    sources: list[str] = []
    for path in claimed:
        try:
            text = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise LedgerError(f"could not read claimed filing {path}: {exc}") from exc
        unfenced = _unfenced_text(text)
        marker = _answer_evidence_marker(unfenced)
        if marker is not None:
            raise LedgerError(
                f"{path} carries '{marker}' answer evidence; only the answer route "
                "may write it"
            )
        try:
            findings, problems, _vocabulary = _parse_text(
                _entry_candidate_text(text, _read_ledger_text(ledger)), ledger
            )
        except LedgerReadRefused:
            raise
        except (OSError, UnicodeError, LedgerError) as exc:
            raise LedgerError(f"could not parse claimed filing {path}: {exc}") from exc
        if len(findings) == 1 and problems:
            raise LedgerError(f"claimed filing {path} is invalid: {'; '.join(problems)}")
        sources.append(text)
    return sources


def _receipt_entry_texts(text: str) -> list[str]:
    """Return each exact entry body used to key a filing receipt."""
    headers = _unfenced_header_matches(text)[1]
    if len(headers) == 1:
        return [text]
    lines = text.splitlines(keepends=True)
    return [
        "".join(lines[heading_index:next_heading_index])
        for index, (heading_index, _header_index, _match) in enumerate(headers)
        for next_heading_index in [
            headers[index + 1][0] if index + 1 < len(headers) else len(lines)
        ]
    ]


def _merge_receipt_digests(inbox: Path, legacy: Path, claim: Path | None = None) -> set[str]:
    """Collect batch and orphan digests before the receipt directory is indexed."""
    paths = list(inbox.glob("*.md")) + list(inbox.glob(".*.part"))
    claimed = set(claim.glob("*.md")) if claim is not None else set()
    paths.extend(claimed)
    if legacy.exists():
        paths.append(legacy)
    digests: set[str] = set()
    for path in paths:
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            if path in claimed:
                raise LedgerError(
                    f"could not read claimed filing {path} while collecting receipt digests: {exc}"
                ) from exc
            continue
        except UnicodeError:
            continue
        entry_texts = _receipt_entry_texts(text) or [text]
        digests.update(
            hashlib.sha256(entry_text.encode("utf-8")).hexdigest()
            for entry_text in entry_texts
        )
    return digests


def _allocate_receipt_path(
    inbox: Path,
    index: ReceiptIndex,
    entry_text: str,
    published: str,
    identifier: str,
    allocated_names: set[str],
) -> Path:
    """Allocate one existing or new receipt to exactly one claimed entry."""
    digest = hashlib.sha256(entry_text.encode("utf-8")).hexdigest()
    for path, record in index.by_filing.get((digest, published), []):
        recorded_id = record.get("id")
        if recorded_id is not None and recorded_id != identifier:
            raise LedgerError(
                f"filing receipt {path} records conflicting id {recorded_id}; "
                f"the claimed entry was allocated {identifier}"
            )
        if path.name not in allocated_names:
            return path

    bare = _receipt_path(inbox, entry_text)
    if bare.name not in index.by_name and bare.name not in allocated_names:
        return bare
    return _receipt_path(inbox, entry_text, filing_token=_unique_suffix())


# A deliberate local copy of leaf_terminal.entry_state (decision d-20261004-01's
# predicate), because this file imports no supervisor module and must stay a
# single vendorable script; tests/test_leaf_terminal.py runs one matrix against
# both copies. After a failed read only a broken lookup refuses; an entry that
# appeared since the read keeps the absent answer it had at the read.
_ENTRY_PRESENT = "present"
_ENTRY_ABSENT = "absent"
_ENTRY_BROKEN = "broken"
_ENTRY_LOOKUP_ERRORS = (OSError, ValueError)


def _entry_state(path: Path) -> str:
    """Return presence, proven absence or broken lookup for a filesystem entry."""
    try:
        try:
            os.stat(path)
        except OSError:
            pass
        else:
            return _ENTRY_PRESENT
        try:
            os.lstat(path)
        except FileNotFoundError:
            ancestor = os.path.dirname(path) or "."
            while True:
                try:
                    os.lstat(ancestor)
                except FileNotFoundError:
                    parent = os.path.dirname(ancestor) or "."
                    if parent == ancestor:
                        return _ENTRY_BROKEN
                    ancestor = parent
                else:
                    return (_ENTRY_ABSENT if stat.S_ISDIR(os.stat(ancestor).st_mode)
                            else _ENTRY_BROKEN)
    except _ENTRY_LOOKUP_ERRORS:
        return _ENTRY_BROKEN
    return _ENTRY_BROKEN


def _entry_exists(path: Path, *, directory: bool = False) -> bool:
    """Present is True, proven absent is False; a broken lookup raises LedgerError.

    With ``directory=True`` a present directory must also open with
    ``os.scandir`` or ``LedgerError`` is raised; a present non-directory still
    answers True (kind handling stays with the caller).
    """
    state = _entry_state(path)
    if state == _ENTRY_ABSENT:
        return False
    if state == _ENTRY_BROKEN:
        raise LedgerError(
            f"{path} is a dangling link or cannot be looked up; "
            "repair or remove it by hand, then retry"
        )
    if directory and stat.S_ISDIR(os.stat(path).st_mode):
        try:
            with os.scandir(path) as entries:
                next(entries, None)
        except OSError as exc:
            raise LedgerError(
                f"{path} cannot be listed: {exc}; repair its permissions, then retry"
            ) from exc
    return True


def _resolved_repo_path(path: Path) -> Path:
    """Resolve a caller path before comparing it with the repository root."""
    try:
        return path.resolve()
    except (OSError, RuntimeError) as exc:
        raise LedgerError(f"could not resolve path {path}: {exc}") from exc


def _canonical_ledger_path(path: Path) -> Path:
    """Resolve one ledger path and refuse files with another hard-link name."""
    resolved = _resolved_repo_path(path)
    try:
        details = resolved.stat()
    except FileNotFoundError as exc:
        if _entry_state(path) != _ENTRY_BROKEN:
            return resolved
        raise LedgerError(
            f"could not inspect ledger path {path}: it is a dangling link or cannot be looked up "
            f"(resolves to {resolved}); repair or remove it by hand, then retry"
        ) from exc
    except OSError as exc:
        raise LedgerError(f"could not inspect ledger path {resolved}: {exc}") from exc
    if stat.S_ISREG(details.st_mode) and details.st_nlink > 1:
        raise LedgerError(
            f"ledger {resolved} is a hard-linked alias; a ledger must have exactly one name"
        )
    return resolved


def _repo_relative(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _resolve_head(root: Path) -> str:
    result = _git_for_ledger(root, "rev-parse", "--verify", "-q", "HEAD^{commit}")
    if result.returncode != 0:
        raise LedgerError(f"could not resolve HEAD: {_git_failure_detail(result)}")
    commit = result.stdout.strip()
    if not commit:
        raise LedgerError("could not resolve HEAD: git returned an empty commit id")
    return commit


@contextmanager
def _head_ledger_snapshot(
    findings: Path, decisions: Path, *, strict_decisions: bool = True
) -> Iterator[HeadSnapshot]:
    """Materialise and validate the findings and decisions blobs in HEAD."""
    root = cast(Path, REPO_ROOT).resolve()
    findings = _resolved_repo_path(findings)
    decisions = _resolved_repo_path(decisions)
    commit = _resolve_head(root)
    with tempfile.TemporaryDirectory(prefix="findings-ledger-head-") as directory:
        tasks = Path(directory) / "tasks"
        tasks.mkdir()
        listed: dict[Path, bool] = {}
        for source in (findings, decisions):
            relative = _repo_relative(source, root)
            listed_result = _git_for_ledger(
                root, "ls-tree", "-r", "--name-only", commit, "--", relative
            )
            if listed_result.returncode != 0:
                raise LedgerError(
                    f"could not inspect HEAD for {relative}: "
                    f"{_git_failure_detail(listed_result)}"
                )
            listed[source] = relative in listed_result.stdout.splitlines()

        findings_text: str | None = None
        targets = {
            findings: tasks / "findings.md",
            decisions: tasks / "decisions.md",
        }
        for source, is_listed in listed.items():
            if not is_listed:
                continue
            relative = _repo_relative(source, root)
            shown = _git_for_ledger(root, "show", f"{commit}:{relative}")
            if shown.returncode != 0:
                if source == decisions and not strict_decisions:
                    continue
                raise LedgerError(
                    f"could not read {commit}:{relative}: "
                    f"{_git_failure_detail(shown)}"
                )
            target = targets[source]
            target.write_text(shown.stdout, encoding="utf-8")
            if source == findings:
                findings_text = shown.stdout

        if not listed[findings]:
            yield HeadSnapshot(None, False, "findings ledger is not in HEAD", tasks)
            return

        stderr = io.StringIO()
        stdout = io.StringIO()
        try:
            with redirect_stdout(stdout), redirect_stderr(stderr):
                valid = (
                    cmd_check(
                        argparse.Namespace(
                            ledger=tasks / "findings.md",
                            decisions=tasks / "decisions.md",
                        )
                    )
                    == 0
                )
        except LedgerReadRefused:
            raise
        except (LedgerError, OSError, UnicodeError, ValueError) as exc:
            valid = False
            detail = str(exc)
        else:
            detail = stderr.getvalue().strip().replace("\n", "; ")
        if valid:
            detail = ""
        elif not detail:
            detail = "HEAD ledger validation failed"
        yield HeadSnapshot(findings_text, valid, detail, tasks)


def _validate_ledger_paths(findings: Path, decisions: Path) -> tuple[bool, str]:
    """Validate the working findings/decisions pair through the normal checker."""
    stdout = io.StringIO()
    stderr = io.StringIO()
    try:
        with redirect_stdout(stdout), redirect_stderr(stderr):
            result = cmd_check(
                argparse.Namespace(ledger=findings, decisions=decisions)
            )
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        return False, str(exc)
    if result == 0:
        return True, ""
    detail = stderr.getvalue().strip().replace("\n", "; ")
    return False, detail or "ledger validation failed"


def _validate_candidate_pair(
    candidate: str, near: Path, decisions: Path
) -> tuple[bool, str]:
    """Validate a merged findings candidate against its selected decisions ledger."""
    try:
        with _candidate_scratch(candidate, near) as scratch:
            return _validate_ledger_paths(scratch, decisions)
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        return False, str(exc)


def _candidate_citation_issues(
    candidate: str, near: Path, decisions: Path
) -> list[str]:
    """Check pending entry citations before a file can publish them."""
    try:
        with _candidate_scratch(candidate, near) as scratch:
            _resolved, issues = _citation_resolution(scratch, decisions)
            return issues
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        return [str(exc)]


def _deferred_preconditions(ledger: Path, decisions: Path) -> None:
    """Refuse every non-ordinary deferred claim state before mutation."""
    root = cast(Path, REPO_ROOT).resolve()
    findings = _resolved_repo_path(ledger)
    decisions = _resolved_repo_path(decisions)
    try:
        _resolve_head(root)
    except LedgerError as exc:
        probe = _git_for_ledger(root, "rev-parse", "--verify", "-q", "HEAD^{commit}")
        if probe.returncode == 1:
            raise LedgerError(
                "the findings ledger is tracked but HEAD does not resolve; commit it first"
            ) from exc
        raise

    if not decisions.is_relative_to(root):
        raise LedgerError(
            f"{decisions} must be a tracked file inside the repository, or absent and "
            "untracked, while claims are finalised after the commit; commit, restore "
            "or move it"
        )
    relative_decisions = _repo_relative(decisions, root)
    tracked = _git_for_ledger(
        root, "ls-files", "--error-unmatch", "--", relative_decisions
    )
    if tracked.returncode == 0:
        if not decisions.exists():
            raise LedgerError(
                f"{decisions} must be a tracked file inside the repository, or absent "
                "and untracked, while claims are finalised after the commit; commit, "
                "restore or move it"
            )
    elif tracked.returncode == 1:
        if decisions.exists():
            raise LedgerError(
                f"{decisions} must be a tracked file inside the repository, or absent "
                "and untracked, while claims are finalised after the commit; commit, "
                "restore or move it"
            )
    else:
        raise LedgerError(f"fatal tracked-file probe: {_git_failure_detail(tracked)}")

    with _head_ledger_snapshot(findings, decisions) as snapshot:
        if snapshot.findings_text is None:
            raise LedgerError(f"{findings} is not in HEAD; commit it first")
        if not snapshot.valid:
            raise LedgerError(
                f"HEAD does not validate: {snapshot.detail}; repair and commit the "
                "ledgers first"
            )

    valid, detail = _validate_ledger_paths(findings, decisions)
    if not valid:
        raise LedgerError(
            f"the working ledgers do not validate: {detail}; repair them first"
        )


def _require_deferred_ledger_tracked(ledger: Path) -> None:
    """Refuse deferred finalisation if its ledger stopped being commit-backed."""
    root = cast(Path, REPO_ROOT).resolve()
    resolved = _resolved_repo_path(ledger)
    if not resolved.is_relative_to(root):
        raise LedgerError(
            f"{resolved} is no longer inside the repository; the deferred claim "
            "is kept"
        )
    relative = _repo_relative(resolved, root)
    tracked = _git_for_ledger(root, "ls-files", "--error-unmatch", "--", relative)
    if tracked.returncode == 1:
        raise LedgerError(
            f"{resolved} is no longer tracked; the deferred claim is kept"
        )
    if tracked.returncode != 0:
        raise LedgerError(
            f"fatal tracked-file probe: {_git_failure_detail(tracked)}"
        )


def _claim_finalisation_mode(
    ledger: Path, *, merge_without_intent: bool
) -> str:
    """Choose immediate compatibility or deferred durable claim finalisation."""
    if (
        os.environ.get(LEDGER_COMMIT_ENV) == "0"
        and os.environ.get("FINDINGS_CLAIM_FINALIZE") != "after-commit"
    ):
        return "immediate"
    if merge_without_intent:
        return "immediate"
    root = cast(Path, REPO_ROOT).resolve()
    resolved = _resolved_repo_path(ledger)
    if not resolved.is_relative_to(root):
        return "immediate"
    relative = _repo_relative(resolved, root)
    tracked = _git_for_ledger(root, "ls-files", "--error-unmatch", "--", relative)
    if tracked.returncode == 1:
        return "immediate"
    if tracked.returncode != 0:
        raise LedgerError(f"fatal tracked-file probe: {_git_failure_detail(tracked)}")
    return "deferred"


def _claim_repeated_id(claim: Path, intent: ClaimIntent) -> str | None:
    """Refuse impossible receipt reuse before testing proof of an unwritten batch."""
    ids: set[str] = set()
    receipts: set[str] = set()
    repeated_id = None
    for filing_key, record in intent.receipt_ids.items():
        assert isinstance(record, dict)
        identifier = record["id"]
        receipt_name = record.get("receipt", f"{filing_key}.json")
        if receipt_name in receipts:
            raise LedgerError(
                f"claim intent {_claim_intent_path(claim)} records {receipt_name} twice; "
                "the claim is kept — inspect it by hand"
            )
        if identifier in ids and repeated_id is None:
            repeated_id = identifier
        ids.add(identifier)
        receipts.add(receipt_name)
    return repeated_id


def _claim_entry_expectations(
    claim: Path, ledger: Path, intent: ClaimIntent
) -> dict[str, tuple[Path, FindingExpectation]]:
    """Parse every claimed entry and map it to exactly one intent record."""
    records_by_file: dict[str, list[str]] = {}
    for filing_key, record in intent.receipt_ids.items():
        if not isinstance(record, dict):
            raise LedgerError(
                f"claim intent {_claim_intent_path(claim)} predates deferred "
                "finalisation; finish it with env -u FINDINGS_CLAIM_FINALIZE "
                "FINDINGS_LEDGER_COMMIT=0 findings.py merge-inbox (today's recovery), "
                "or inspect it by hand"
            )
        records_by_file.setdefault(record["published"], []).append(filing_key)

    repeated_id = _claim_repeated_id(claim, intent)
    if repeated_id is not None:
        raise LedgerError(
            f"claim intent {_claim_intent_path(claim)} records {repeated_id} twice; "
            "the claim is kept — inspect it by hand"
        )

    claimed_by_name = {path.name: path for path in intent.claimed}
    for published in records_by_file:
        if published not in claimed_by_name:
            raise LedgerError(
                f"recorded filing {published} is missing from {claim}; the claim is "
                "kept — if its receipt reads merged and HEAD holds that filing, "
                "remove the record by hand, otherwise restore the file"
            )

    result: dict[str, tuple[Path, FindingExpectation]] = {}
    ledger_text = _read_ledger_text(ledger)
    for path in intent.claimed:
        if path.name not in records_by_file:
            raise LedgerError(
                f"{path} is in {claim} but not in its intent; move it back to "
                f"{claim.parent / claim.name.removesuffix('.claim')} by hand, then retry"
            )
        try:
            merged = _merge_sources([path], ledger)
            text = merged[0] if merged else ""
            entries = _receipt_entry_texts(text)
        except LedgerReadRefused:
            raise
        except (OSError, UnicodeError, LedgerError) as exc:
            raise LedgerError(f"could not read {path} while reconciling {claim}: {exc}") from exc
        expected_keys = [
            path.name if len(entries) == 1 else f"{path.name}#{index}"
            for index in range(len(entries))
        ]
        actual_keys = sorted(records_by_file.get(path.name, []))
        if sorted(expected_keys) != actual_keys:
            raise LedgerError(
                f"{path} in {claim} holds entries its intent does not record; the "
                "claim is kept — inspect it by hand"
            )
        for filing_key, entry_text in zip(expected_keys, entries, strict=True):
            record = intent.receipt_ids[filing_key]
            assert isinstance(record, dict)
            finding = _claimed_entry_finding(entry_text, ledger_text, ledger)
            if finding is None:
                raise LedgerError(
                    f"{path} in {claim} holds entries its intent does not record; the "
                    "claim is kept — inspect it by hand"
                )
            if finding.id not in {PENDING_ID, record["id"]}:
                raise LedgerError(
                    f"{path} in {claim} holds entries its intent does not record; "
                    "the claim is kept — inspect it by hand"
                )
            expected = _finding_expectation(finding)
            if finding.id == PENDING_ID:
                # The intent is durable before a rewritten claim file. A crash in
                # that window leaves the placeholder behind with the allocated
                # id already recorded in the intent.
                expected = replace(expected, identifier=record["id"])
            result[filing_key] = (path, expected)

    if set(result) != set(intent.receipt_ids):
        raise LedgerError(
            f"{claim} holds entries its intent does not record; the claim is kept — "
            "inspect it by hand"
        )
    return result


def _reset_nonfixed_ids(text: str, fixed: Collection[str]) -> str:
    """Return an adopted filing with provisional allocated ids pending again."""
    fixed_ids = set(fixed)
    lines, headers, _orphans = _unfenced_header_matches(text)
    for _heading_index, index, match in headers:
        identifier = match.group("id")
        if identifier != PENDING_ID and identifier not in fixed_ids:
            lines[index] = lines[index].replace(identifier, PENDING_ID, 1)
    return "\n".join(lines)


def _reconcile_prepared_claim(
    claim: Path,
    spool: Path,
    snapshot: HeadSnapshot | None,
    working_text: str,
    *,
    records: dict[str, tuple[Path, object]],
    classify: Callable[[object, str | None, str], str],
    finish_present: Callable[[Collection[str]], None],
    waiting_message: Callable[[Path, str], str],
    missing_message: Callable[[Path, str], str],
) -> Reconciliation:
    """Run the crash-safe lifecycle shared by inbox and answers claims."""
    intent = _read_claim_intent(claim)
    if intent is None:
        return Reconciliation([], {}, set(), False)
    if intent.phase != "prepared":
        raise LedgerError(
            f"claim intent {_claim_intent_path(claim)} has phase {intent.phase!r}; "
            "the claim is kept — inspect it by hand"
        )

    quarantined_names = set(intent.quarantined)
    records = {
        key: value for key, value in records.items() if key not in quarantined_names
    }
    claimed_paths = set(intent.claimed)
    keys_by_path: dict[Path, list[str]] = {}
    for key, (path, _record) in records.items():
        keys_by_path.setdefault(path, []).append(key)
        if path not in claimed_paths:
            raise LedgerError(missing_message(path, key))
    for path in intent.claimed:
        if path.name in quarantined_names:
            continue
        if path not in keys_by_path:
            raise LedgerError(
                f"{path} is in {claim} but not in its intent; move it back to "
                f"{spool} by hand, then retry"
            )

    head_text = snapshot.findings_text if snapshot is not None else None
    states: dict[str, str] = {}
    path_states: dict[Path, set[str]] = {}
    for key, (path, record) in records.items():
        state = classify(record, head_text, working_text)
        states[key] = state
        path_states.setdefault(path, set()).add(state)

    for path, path_state in path_states.items():
        if len(path_state) != 1:
            raise LedgerError(
                f"{path} in {claim} holds entries in different durability states; "
                "the claim is kept — inspect it by hand"
            )
        state = next(iter(path_state))
        if state == "waiting":
            raise LedgerError(waiting_message(path, keys_by_path[path][0]))

    present_keys = [key for key, state in states.items() if state == "present"]
    absent = [
        path
        for path, path_state in path_states.items()
        if path_state == {"absent"}
    ]
    receipt_names: dict[str, str] = {}
    for key in records:
        receipt = intent.receipt_ids.get(key)
        receipt_names[key] = (
            receipt.get("receipt", f"{key}.json")
            if isinstance(receipt, dict)
            else f"{key}.json"
        )

    if present_keys:
        finish_present(present_keys)
        absent_names = {path.name for path in absent}
        remaining_keys = set(records) - set(present_keys)
        present_ids = {
            (
                intent.receipt_ids[key]["id"]
                if isinstance(intent.receipt_ids.get(key), dict)
                else cast(dict[str, object], records[key][1])["id"]
            )
            for key in present_keys
            if (
                isinstance(intent.receipt_ids.get(key), dict)
                or (
                    isinstance(records[key][1], dict)
                    and isinstance(records[key][1].get("id"), str)
                )
            )
        }
        remaining_ids = set(intent.ids) - cast(set[str], present_ids)
        remaining_receipts = {
            key: value
            for key, value in intent.receipt_ids.items()
            if key in remaining_keys
        }
        remaining_files = None
        if intent.files is not None:
            remaining_files = {
                name: value
                for name, value in intent.files.items()
                if name in quarantined_names or name in absent_names
            }
        intent_kwargs: dict[str, object] = {}
        if remaining_files is not None:
            intent_kwargs["files"] = remaining_files
            if intent.quarantined:
                intent_kwargs["quarantined"] = intent.quarantined
        _write_claim_intent(
            claim,
            "prepared",
            cast(set[str], remaining_ids),
            cast(dict[str, dict[str, str]], remaining_receipts)
            if remaining_receipts
            else None,
            fixed=intent.fixed,
            **({"manual_repair": True} if intent.manual_repair else {}),
            refused=intent.refused,
            provisional_ids=_kept_claim_provisional_ids(intent, absent_names),
            **intent_kwargs,
        )
        for path, path_state in path_states.items():
            if path_state == {"present"}:
                path.unlink()

    present_paths = {
        path for path, path_state in path_states.items() if path_state == {"present"}
    }
    remaining_paths = [
        path
        for path in intent.claimed
        if _entry_state(path) != _ENTRY_ABSENT and path not in present_paths
    ]
    if not remaining_paths:
        release_spool(claim, spool, [], publish_locked=True)
        return Reconciliation([], receipt_names, set(intent.fixed), not claim.exists())
    return Reconciliation(
        absent, receipt_names, set(intent.fixed), False,
        provisional_ids=intent.provisional_ids or {},
    )


def _reconcile_inbox_claim(
    claim: Path, inbox: Path, ledger: Path, decisions: Path
) -> Reconciliation:
    """Classify and, once safe, finalise a prepared findings claim."""
    intent = _read_claim_intent(claim)
    if intent is None:
        return Reconciliation([], {}, set(), False)
    intent = _recover_inbox_quarantines(claim, inbox, intent)
    if intent.phase != "prepared":
        raise LedgerError(
            f"claim intent {_claim_intent_path(claim)} has phase {intent.phase!r}; "
            "the claim is kept — inspect it by hand"
        )
    if not intent.has_receipt_ids or not intent.has_fixed or any(
        not isinstance(record, dict) for record in intent.receipt_ids.values()
    ):
        raise LedgerError(
            f"claim intent {_claim_intent_path(claim)} predates deferred finalisation; "
            "finish it with env -u FINDINGS_CLAIM_FINALIZE "
            "FINDINGS_LEDGER_COMMIT=0 findings.py merge-inbox (today's recovery), "
            "or inspect it by hand"
        )

    if _claim_repeated_id(claim, intent) is not None or intent.refused:
        # A refusal, or repeated ids the writer could never validate, proves
        # the batch unwritten. Adopt the files as corrected, not as recorded.
        provisional_ids = intent.provisional_ids
        if provisional_ids is None:
            provisional_ids = {}
            for record in intent.receipt_ids.values():
                assert isinstance(record, dict)
                ids = provisional_ids.setdefault(record["published"], set())
                if record["id"] not in intent.fixed:
                    ids.add(record["id"])
        receipt_names = {
            key: record.get("receipt", f"{key}.json")
            for key, record in intent.receipt_ids.items()
            if isinstance(record, dict)
        }
        if not intent.claimed:
            release_spool(claim, inbox, [], publish_locked=True)
        return Reconciliation(
            list(intent.claimed), receipt_names, set(intent.fixed), not claim.exists(),
            refused=True, provisional_ids=provisional_ids,
        )

    entry_expectations = _claim_entry_expectations(claim, ledger, intent)
    working_text = _read_ledger_text(ledger)
    working_findings, _problems, _vocabulary = _parse_text(working_text, ledger)
    with _head_ledger_snapshot(ledger, decisions) as snapshot:
        if snapshot.findings_text is None:
            raise LedgerError(f"{ledger} is not in HEAD; commit it first")
        if not snapshot.valid:
            raise LedgerError(
                f"HEAD does not validate: {snapshot.detail}; repair and commit the "
                "ledgers first"
            )
        head_findings, _head_problems, _head_vocabulary = _parse_text(
            snapshot.findings_text, ledger
        )

    head_by_id = {finding.id: finding for finding in head_findings}
    working_by_id = {finding.id: finding for finding in working_findings}
    path_by_id: dict[str, Path] = {}
    for filing_key, (path, expected) in entry_expectations.items():
        if filing_key not in intent.receipt_ids:
            raise LedgerError(
                f"{path} in {claim} holds entries its intent does not record; the "
                "claim is kept — inspect it by hand"
            )
        path_by_id.setdefault(expected.identifier, path)

    def classify(
        expected_object: object, _head_text: str | None, _working: str
    ) -> str:
        # The parsed expectation maps above are the source of truth for this callback.
        expected = cast(FindingExpectation, expected_object)
        head = head_by_id.get(expected.identifier)
        working_finding = working_by_id.get(expected.identifier)
        path = path_by_id[expected.identifier]
        if head is not None:
            if not _finding_identity_preserved(expected, head):
                raise LedgerError(
                    f"entry {expected.identifier} in HEAD is not the claimed filing "
                    f"{path.name}; the claim is kept — inspect it by hand"
                )
            return "present"
        if working_finding is not None:
            if not _finding_identity_preserved(expected, working_finding):
                raise LedgerError(
                    f"entry {expected.identifier} in the working ledger is not the "
                    f"claimed filing {path.name}; the claim is kept — inspect it by hand"
                )
            return "waiting"
        return "absent"

    def finish_present(keys: Collection[str]) -> None:
        head_text = cast(str, snapshot.findings_text)
        ledger_regions = {
            identifier: (leading, body)
            for identifier, leading, body in _entry_line_regions(head_text)
        }
        present_paths = {entry_expectations[key][0] for key in keys}

        def entry_id(
            name: str, index: int, count: int, _expected: FindingExpectation
        ) -> str:
            key = name if count == 1 else f"{name}#{index}"
            record = intent.receipt_ids[key]
            assert isinstance(record, dict)
            return record["id"]

        for path in intent.claimed:
            if path not in present_paths:
                continue
            if not _claimed_file_content_proven(
                path, ledger, head_text, head_by_id, ledger_regions, entry_id
            ):
                raise LedgerError(
                    f"{path} in {claim} holds text HEAD does not prove; "
                    "the claim is kept — inspect it by hand"
                )
        _write_merged_receipts(
            inbox,
            _receipt_records_from_intent(claim, intent.receipt_ids, keys=keys),
        )

    decisions_hint = f" [{decisions}]" if decisions.exists() else ""
    return _reconcile_prepared_claim(
        claim,
        inbox,
        snapshot,
        working_text,
        records=entry_expectations,
        classify=classify,
        finish_present=finish_present,
        waiting_message=lambda _path, _key: (
            f"a merged batch in {claim} is not durable yet (the entries are in "
            f"the working ledger but not in HEAD); commit it first: git commit -- "
            f"{ledger}{decisions_hint}"
        ),
        missing_message=lambda path, _key: (
            f"recorded filing {path.name} is missing from {claim}; the claim is "
            "kept — if its receipt reads merged and HEAD holds that filing, "
            "remove the record by hand, otherwise restore the file"
        ),
    )


def _ledger_bytes_postcondition(
    findings_bytes: bytes | None, decisions_bytes: bytes | None
) -> Callable[[Path, Path], bool]:
    def holds(findings_path: Path, decisions_path: Path) -> bool:
        try:
            return (
                (findings_bytes is None or _read_ledger_bytes(findings_path) == findings_bytes)
                and (
                    decisions_bytes is None
                    or _read_ledger_bytes(decisions_path) == decisions_bytes
                )
            )
        except OSError:
            return False

    return holds


def _settle_pending_ledger_dirt(intent: LedgerCommitIntent) -> None:
    """Commit valid pending ledger dirt before a deferred consumer mutation."""
    # A hook can hide dirty allocations even when it restores them and fails.
    # Fence the whole settlement before taking either per-ledger lock. The
    # caller's later merge acquisition is sequential, after this scope exits.
    with _clone_id_allocation_scope(
        intent.findings, explicit=_EXPLICIT_ID_ALLOCATION_PATHS,
    ):
        _settle_pending_ledger_dirt_clone_locked(intent)


def _settle_pending_ledger_dirt_clone_locked(intent: LedgerCommitIntent) -> None:
    findings = _canonical_ledger_path(intent.findings)
    decisions = _canonical_ledger_path(intent.decisions)
    locks = (ledger_lock_path(decisions), ledger_lock_path(findings))
    acquired_locks: list[Path] = []
    try:
        for lock in locks:
            acquired, waited_seconds = acquire_ledger_lock(
                lock, LEDGER_LOCK_WAIT_SECONDS
            )
            if not acquired:
                raise LedgerError(
                    _ledger_lock_busy_message(lock, waited_seconds)
                )
            acquired_locks.append(lock)

        root = cast(Path, REPO_ROOT).resolve()
        dirty_paths: list[Path] = []
        for path in (findings, decisions):
            if path == decisions and not path.exists():
                continue
            relative = _repo_relative(path, root)
            result = _git_for_ledger(root, "diff", "--quiet", "HEAD", "--", relative)
            if result.returncode == 0:
                continue
            if result.returncode == 1:
                dirty_paths.append(path)
                continue
            raise LedgerError(
                f"pending ledger dirt could not be inspected ({_git_failure_detail(result)})"
            )
        if not dirty_paths:
            return

        valid, detail = _validate_ledger_paths(findings, decisions)
        if not valid:
            raise LedgerError(
                f"pending ledger dirt does not validate ({detail}); repair it before merging"
            )

        findings_bytes = _read_ledger_bytes(findings) if findings in dirty_paths else None
        decisions_bytes = _read_ledger_bytes(decisions) if decisions in dirty_paths else None
        if findings_bytes is not None:
            # Judge the exact bytes the commit carries while both ledgers are
            # locked, so a Controller regeneration cannot slip in afterward.
            _refuse_controller_export(
                findings,
                _controller_export_head(findings_bytes),
                "a deferred ledger commit",
            )
        primary = findings if findings in dirty_paths else decisions
        companion = (
            decisions if findings in dirty_paths and decisions in dirty_paths else None
        )
        settle_intent = LedgerCommitIntent(
            command=intent.command,
            ledger=primary,
            findings=findings,
            decisions=decisions,
            subject=f"docs(findings): commit pending ledger dirt before {intent.command}",
            postcondition=_ledger_bytes_postcondition(findings_bytes, decisions_bytes),
            replaced=True,
            written_bytes=findings_bytes if findings_bytes is not None else decisions_bytes,
            companion=companion,
            companion_bytes=decisions_bytes if companion is not None else None,
        )
        result = _attempt_ledger_commit(settle_intent, lock_held=True)
        if not result.durable:
            paths = " ".join(str(path) for path in dirty_paths)
            if _ledger_guard_refusal(result.cause):
                raise LedgerReadRefused(f"{result.cause}. {_rollback_remedy(primary)}")
            if result.durable_head:
                raise LedgerError(
                    f"pending ledger dirt produced durable commit {result.durable_head} "
                    f"but verification failed ({result.cause}); inspect git log for "
                    f"{paths}"
                )
            raise LedgerError(
                f"pending ledger dirt could not be committed ({result.cause}); check git "
                f"status and git log, then commit it: git commit -- {paths}"
            )
    finally:
        for lock in reversed(acquired_locks):
            release_ledger_lock(lock, defer=False)


def _answers_legacy_intent_message(
    claim: Path, answers: Path, ledger: Path, mode: str
) -> str:
    basis = (
        "as committed in HEAD, after committing any pending ledger changes"
        if mode == "deferred"
        else f"in the working {ledger}"
    )
    return (
        f"answers claim intent {_claim_intent_path(claim)} was written before answer "
        "effects were recorded, so no answer in it can be judged automatically; "
        f"for each answer file in {claim} compare its entry {basis} with the complete "
        "effect the answer grammar in references/findings-ledger-contract.md "
        "prescribes (the blocker transition and every evidence line of the Decision "
        "made bullet): delete the file only if the entry holds that "
        "complete effect exactly once; move it back to "
        f"{answers} only if the entry holds none of it (still parked on its blocker, "
        "no copy of any evidence line); repair every other state by hand first; every "
        "id in the intent's ids must be accounted for — an id with no answer file in "
        f"{claim} needs its answer restored or its entry resolved by hand; only then "
        f"remove {claim}"
    )


def _reconcile_answers_claim(
    claim: Path,
    answers: Path,
    ledger: Path,
    decisions: Path,
    mode: str,
) -> Reconciliation:
    """Classify a prepared answers claim by its recorded effect."""
    intent = _read_claim_intent(claim)
    if intent is None:
        return Reconciliation([], {}, set(), False)
    if intent.files is None:
        raise LedgerError(_answers_legacy_intent_message(claim, answers, ledger, mode))
    _quarantine_claim_files(claim, answers, intent)
    intent = _read_claim_intent(claim)
    if intent is None:
        return Reconciliation([], {}, set(), False)
    records = {
        name: (claim / name, value)
        for name, value in intent.files.items()
        if name not in intent.quarantined
    }
    working_text = _read_ledger_text(ledger)
    # Every later ``records`` is a subset of these, so one parse per ledger text
    # serves every answer, however the quarantine narrows the batch.
    answered_ids = {
        cast(str, cast(dict[str, object], record)["id"])
        for _path, record in records.values()
    }

    @functools.cache
    def parsed(text: str) -> AnswerLedger:
        return _answer_ledger(text, answered_ids)

    def quarantine_stale(head_text: str | None) -> None:
        nonlocal intent, records
        stale_names: set[str] = set()
        for name, (_path, record) in records.items():
            working_state = _answer_effect_state(parsed(working_text), record)
            if head_text is None:
                if working_state == "stale":
                    stale_names.add(name)
                continue

            head_state = _answer_effect_state(parsed(head_text), record)
            if head_state == "complete":
                continue
            if head_state not in {"untouched", "stale"} or working_state not in {
                "complete",
                "untouched",
                "stale",
            }:
                continue
            if head_state == "stale" or working_state == "stale":
                stale_names.add(name)

        if not stale_names:
            return
        quarantined = dict(intent.quarantined)
        quarantined.update({name: "stale" for name in stale_names})
        _write_claim_intent(
            claim,
            "prepared",
            set(intent.ids),
            cast(dict[str, dict[str, str]], intent.receipt_ids)
            if intent.has_receipt_ids
            else None,
            fixed=intent.fixed if intent.has_fixed else None,
            files=intent.files,
            quarantined=quarantined,
            **({"manual_repair": True} if intent.manual_repair else {}),
        )
        intent = _read_claim_intent(claim)
        if intent is None:
            raise LedgerError(f"claim {claim} disappeared after recording stale answers")
        _quarantine_claim_files(claim, answers, intent)
        intent = _read_claim_intent(claim)
        if intent is None:
            raise LedgerError(f"claim {claim} disappeared while quarantining stale answers")
        records = {
            name: (claim / name, value)
            for name, value in intent.files.items()
            if name not in intent.quarantined
        }

    def missing(path: Path, name: str) -> str:
        if (answers / name).exists():
            return (
                f"recorded answer {name} is missing from {claim} but present in "
                f"{answers}: a replay was interrupted — move the remaining files of "
                f"{claim} back to {answers}, remove {claim}, then re-run apply-answers"
            )
        return (
            f"recorded answer {name} is missing from {claim}; restore it from "
            f"{answers} history or inspect {ledger} by hand"
        )

    if mode != "deferred":
        quarantine_stale(None)
        claimed_by_name = {path.name: path for path in intent.claimed}
        for name, (path, _record) in records.items():
            if path not in intent.claimed:
                raise LedgerError(missing(path, name))

        states: dict[str, str] = {}
        for name, (_path, record) in records.items():
            state = _answer_effect_state(parsed(working_text), record)
            states[name] = state
            if state not in {"complete", "untouched"}:
                identifier = cast(str, record["id"])
                raise LedgerError(
                    f"answer {name} for {identifier} is {state} in the working "
                    "ledger; the claim is kept — inspect the entry and the answer "
                    "by hand"
                )

        every_claimed_recorded = all(
            name in records for name in claimed_by_name
        )
        if every_claimed_recorded and all(
            state == "complete" for state in states.values()
        ):
            for path in intent.claimed:
                path.unlink(missing_ok=True)
            release_spool(claim, answers, [], publish_locked=True)
            return Reconciliation([], {}, set(), not claim.exists())
        return Reconciliation([], {}, set(), False, replay=True)

    def classify(record_object: object, head_text: str | None, working: str) -> str:
        record = cast(dict[str, object], record_object)
        identifier = cast(str, record["id"])
        if head_text is not None:
            head_state = _answer_effect_state(parsed(head_text), record)
            if head_state == "complete":
                return "present"
            if head_state != "untouched":
                raise KeptAnswersClaimError(claim, intent.ids)
        working_state = _answer_effect_state(parsed(working), record)
        if working_state == "complete":
            return "waiting" if head_text is not None else "present"
        if working_state == "untouched":
            return "absent"
        name = next(name for name, value in records.items() if value[1] is record)
        raise LedgerError(
            f"answer {name} for {identifier} is {working_state} in the working ledger; "
            "the claim is kept — inspect the entry and the answer by hand"
        )

    def waiting(_path: Path, _name: str) -> str:
        return (
            f"an applied answer batch in {claim} is not durable yet (the answers are "
            f"in the working ledger but not in HEAD); commit it first: git commit -- "
            f"{ledger}"
        )

    def run(snapshot: HeadSnapshot | None) -> Reconciliation:
        return _reconcile_prepared_claim(
            claim,
            answers,
            snapshot,
            working_text,
            records=records,
            classify=classify,
            finish_present=lambda _keys: None,
            waiting_message=waiting,
            missing_message=missing,
        )

    if mode == "deferred":
        with _head_ledger_snapshot(ledger, decisions) as snapshot:
            if snapshot.findings_text is None:
                raise LedgerError(f"{ledger} is not in HEAD; commit it first")
            if not snapshot.valid:
                raise LedgerError(
                    f"HEAD does not validate: {snapshot.detail}; repair and commit the "
                    "ledgers first"
                )
            quarantine_stale(snapshot.findings_text)
            return run(snapshot)
    return run(None)


def _finalizable_intent(claim: Path, ledger: Path, mode: str) -> ClaimIntent | str:
    """Load a claim's intent, or the outcome that settles it without reconciling."""
    if mode == "deferred":
        _require_deferred_ledger_tracked(ledger)
    intent = _read_claim_intent(claim, strict=mode == "deferred")
    if intent is None:
        if claim.exists():
            raise LedgerError(
                f"claim {claim} has no durable intent; remove it by hand before "
                "finalizing"
            )
        return FINALIZE_OUTCOME_NONE
    if intent.phase == "claimed":
        return FINALIZE_OUTCOME_REPLAY
    return intent


def _reconciled_outcome(claim: Path, reconciliation: Reconciliation) -> str:
    if reconciliation.released:
        return FINALIZE_OUTCOME_FINALIZED
    if reconciliation.replay:
        return FINALIZE_OUTCOME_REPLAY
    if not reconciliation.absent and not list(claim.glob("*.md")):
        return FINALIZE_OUTCOME_CLEANUP_FAILED
    return FINALIZE_OUTCOME_REPLAY


def _finalize_inbox_claim_locked(
    claim: Path,
    inbox: Path,
    ledger: Path,
    decisions: Path,
    mode: str,
) -> str:
    intent = _finalizable_intent(claim, ledger, mode)
    if isinstance(intent, str):
        return intent
    if mode == "deferred":
        return _reconciled_outcome(
            claim, _reconcile_inbox_claim(claim, inbox, ledger, decisions)
        )

    try:
        ledger_text = _read_ledger_text(ledger)
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not read ledger {ledger} while finalising {claim}: {exc}") from exc
    if not intent.ids or not all(identifier in header_ids(ledger_text) for identifier in intent.ids):
        return FINALIZE_OUTCOME_REPLAY
    records = _claim_release_records(
        claim, inbox, list(intent.claimed),
        intent.receipt_ids if intent.has_receipt_ids else None, intent.ids,
    )
    if not _immediate_claim_content_proven(claim, ledger, ledger_text, intent):
        return FINALIZE_OUTCOME_REPLAY
    _complete_claim(
        claim,
        inbox,
        list(intent.claimed),
        records,
        publish_locked=True,
    )
    if claim.exists():
        return FINALIZE_OUTCOME_CLEANUP_FAILED
    return FINALIZE_OUTCOME_FINALIZED


def _finalize_answers_claim_locked(
    claim: Path,
    answers: Path,
    ledger: Path,
    decisions: Path,
    mode: str,
) -> str:
    intent = _finalizable_intent(claim, ledger, mode)
    if isinstance(intent, str):
        return intent
    return _reconciled_outcome(
        claim, _reconcile_answers_claim(claim, answers, ledger, decisions, mode)
    )


def _finalize_claim(
    claim: Path,
    spool: Path,
    ledger: Path,
    decisions: Path,
    mode: str,
    locked_finalizer: Callable[[Path, Path, Path, Path, str], str],
) -> str:
    """Finalise one claim while holding the canonical ledger/publish lock order."""
    ledger = _canonical_ledger_path(ledger)
    decisions = _canonical_ledger_path(decisions)
    lock = ledger_lock_path(ledger)
    try:
        acquired, waited_seconds = acquire_ledger_lock(lock)
    except (LedgerError, OSError) as exc:
        return f"busy: {exc}"
    if not acquired:
        return f"busy: ledger lock {lock} remained busy after {waited_seconds:.2f}s"
    try:
        with _publish_lock(publish_lock_path(spool)):
            return locked_finalizer(claim, spool, ledger, decisions, mode)
    finally:
        release_ledger_lock(lock)


def cmd_finalize_claims(args: argparse.Namespace) -> int:
    """Release only claims whose entries are proven in HEAD."""
    inbox_claim = args.inbox.with_name(f"{args.inbox.name}.claim")
    answers_claim = args.answers.with_name(f"{args.answers.name}.claim")
    try:
        args.ledger = _canonical_ledger_path(args.ledger)
        decisions = _args_decisions(args)
        args.decisions = decisions
        mode = _claim_finalisation_mode(args.ledger, merge_without_intent=False)
        if mode == "deferred":
            _deferred_preconditions(args.ledger, decisions)
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1

    lock = ledger_lock_path(args.ledger)
    try:
        acquired, waited_seconds = acquire_ledger_lock(lock)
    except (LedgerError, OSError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    if not acquired:
        return _report_ledger_lock_busy(lock, waited_seconds)
    outcomes: list[tuple[Path, str | None]] = []
    manual_repair_ids: dict[Path, tuple[str, ...]] = {}
    try:
        if mode == "immediate":
            try:
                original = _read_ledger_text(args.ledger)
                issues = _validate_text(original, args.ledger)
            except (OSError, UnicodeError) as exc:
                print(
                    f"FAIL could not read ledger {args.ledger}: {exc}",
                    file=sys.stderr,
                )
                return 1
            if issues:
                print(
                    f"FAIL the working ledger does not validate: {'; '.join(issues)}",
                    file=sys.stderr,
                )
                return 1
        for claim, spool, finalizer in (
            (
                inbox_claim,
                args.inbox,
                _finalize_inbox_claim_locked,
            ),
            (
                answers_claim,
                args.answers,
                _finalize_answers_claim_locked,
            ),
        ):
            try:
                with _publish_lock(publish_lock_path(spool)):
                    outcome = finalizer(
                        claim, spool, args.ledger, decisions, mode
                    )
            except KeptAnswersClaimError as exc:
                try:
                    with _publish_lock(publish_lock_path(args.answers)):
                        _mark_answers_claim_manual_repair(claim, exc.ids)
                except LedgerReadRefused:
                    raise
                except (LedgerError, OSError, UnicodeError) as mark_exc:
                    print(
                        f"FAIL {claim}: could not record manual-repair state: "
                        f"{mark_exc}",
                        file=sys.stderr,
                    )
                    outcomes.append((claim, None))
                    continue
                else:
                    outcomes.append((claim, FINALIZE_OUTCOME_MANUAL_REPAIR))
                    manual_repair_ids[claim] = exc.ids
                    continue
            except LedgerReadRefused:
                raise
            except (LedgerError, OSError, UnicodeError) as exc:
                print(f"FAIL {claim}: {exc}", file=sys.stderr)
                outcomes.append((claim, None))
                continue
            outcomes.append((claim, outcome))
    finally:
        release_ledger_lock(lock)

    return_code = 0
    kept_for_manual_repair = False
    nonbenign_failure = False
    for claim, outcome in outcomes:
        if outcome is None:
            return_code = 1
            nonbenign_failure = True
        elif outcome == FINALIZE_OUTCOME_NONE:
            print(f"none {claim}")
        elif outcome == FINALIZE_OUTCOME_FINALIZED:
            print(f"finalized {claim}")
        elif outcome == FINALIZE_OUTCOME_CLEANUP_FAILED:
            print(f"cleanup failed {claim}: remove it by hand")
            return_code = 1
            nonbenign_failure = True
        elif outcome == FINALIZE_OUTCOME_MANUAL_REPAIR:
            print(
                f"kept {claim} for manual repair: "
                f"{','.join(manual_repair_ids[claim])}"
            )
            kept_for_manual_repair = True
        else:
            # `merge` (not `merge-inbox`) is a record token the drain supervisor
            # parses; renaming it is a running-drain contract change.
            next_command = "apply-answers" if claim == answers_claim else "merge"
            print(f"will be replayed by the next {next_command} {claim}")
            return_code = 1
    return (
        MANUAL_REPAIR_RETURN_CODE
        if kept_for_manual_repair and not nonbenign_failure
        else return_code
    )


def merge_inbox(
    inbox: Path,
    ledger: Path,
    *,
    decisions: Path | None = None,
    preconditions_checked: bool = False,
) -> MergeResult:
    """Run one ledger-locked merge with one nested publication fence.

    ``preconditions_checked`` tells the merge its caller already ran the deferred
    preconditions in this process, so the two full HEAD and working validations
    are not paid twice per filing.
    """
    try:
        ledger = _canonical_ledger_path(ledger)
        if decisions is None:
            decisions = ledger.parent / "decisions.md"
        decisions = _canonical_ledger_path(decisions)
        # First, before the deferred preconditions: those settle pending ledger
        # dirt by committing it, and dirt in an export is a regeneration.
        _refuse_controller_export_at(ledger, "merge-inbox")
        mode = _claim_finalisation_mode(
            ledger, merge_without_intent=_ACTIVE_LEDGER_COMMIT is None
        )
        if mode == "deferred":
            if not preconditions_checked:
                _deferred_preconditions(ledger, decisions)
            intent = _ACTIVE_LEDGER_COMMIT
            if intent is not None and os.environ.get(LEDGER_COMMIT_ENV) != "0":
                _settle_pending_ledger_dirt(intent)
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return MergeResult(1)

    try:
        with _clone_id_allocation_scope(
            ledger, explicit=_EXPLICIT_ID_ALLOCATION_PATHS,
        ) as root:
            return _merge_inbox_clone_locked(
                inbox, ledger, decisions=decisions, mode=mode,
                allocation_root=root,
            )
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return MergeResult(1)


def _merge_inbox_clone_locked(
    inbox: Path, ledger: Path, *, decisions: Path, mode: str,
    allocation_root: Path | None,
) -> MergeResult:
    """Take the per-ledger and publication locks inside the allocation fence."""
    lock = ledger_lock_path(ledger)
    try:
        acquired, waited_seconds = acquire_ledger_lock(lock)
    except (LedgerError, OSError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return MergeResult(1)
    if not acquired:
        return MergeResult(_report_ledger_lock_busy(lock, waited_seconds))

    try:
        # Read under the lock, before anything is claimed, so a refusal leaves
        # the spool untouched. The merge re-checks the text it actually appends
        # to, because the Controller regenerates without taking this lock.
        _refuse_controller_export_at(ledger, "merge-inbox")
    except LedgerError as exc:
        release_ledger_lock(lock)
        print(f"FAIL {exc}", file=sys.stderr)
        return MergeResult(1)
    try:
        with _publish_lock(publish_lock_path(inbox)):
            _sweep_intake(inbox, ledger, decisions)
            try:
                return _merge_inbox_publish_locked(
                    inbox, ledger, decisions=decisions, mode=mode,
                    allocation_root=allocation_root,
                )
            except LedgerReadRefused:
                raise
            except LedgerError as exc:
                print(f"FAIL {exc}", file=sys.stderr)
                return MergeResult(1)
    finally:
        release_ledger_lock(lock)


def _note_folded_legacy(legacy: Path, claimed: bool) -> None:
    if claimed:
        print(f"NOTE folded legacy findings inbox {legacy}", file=sys.stderr)


def _refuse_entryless_filings(
    inbox: Path, legacy: Path, *, adopted: Collection[Path] = ()
) -> None:
    """Refuse the merge while a published filing carries no entry.

    Such a filing gets no receipt record, so releasing its batch would delete it
    while its receipt still reads ``published``. Checked before the claim, under
    the publish lock every writer takes, so the refusal leaves the inbox as it
    was. Refused adoptions check their claimed files before rewriting the intent.
    An empty legacy single-file inbox has no receipt and is removed.
    """
    if _entry_state(legacy) == _ENTRY_BROKEN:
        raise LedgerError(
            f"could not read legacy inbox {legacy}: it is a dangling link or cannot be looked up; "
            "repair or remove it by hand, then retry"
        )
    try:
        if _entry_exists(legacy) and not legacy.read_text(encoding="utf-8").strip():
            legacy.unlink()
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not read legacy inbox {legacy}: {exc}") from exc
    filings = sorted(inbox.glob("*.md"))
    if _entry_exists(legacy):
        filings.append(legacy)
    adopted_paths = set(adopted)
    filings.extend(sorted(adopted_paths))
    entryless: list[str] = []
    for path in filings:
        try:
            text = path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            if _entry_state(path) != _ENTRY_BROKEN:
                continue
            raise LedgerError(f"could not read filing {path}: {exc}") from exc
        except UnicodeError as exc:
            if path in adopted_paths:
                # The source read retains its existing deterministic refusal.
                continue
            raise LedgerError(f"could not read filing {path}: {exc}") from exc
        except OSError as exc:
            raise LedgerError(f"could not read filing {path}: {exc}") from exc
        if not _unfenced_header_matches(text)[1]:
            entryless.append(str(path))
    if entryless:
        raise LedgerError(
            f"published filings with no findings: {', '.join(entryless)}. The "
            "inbox and receipts are unchanged; correct or remove each filing "
            "and its receipt by hand, then merge again"
        )


def _merge_inbox_publish_locked(
    inbox: Path,
    ledger: Path,
    *,
    decisions: Path | None = None,
    mode: str | None = None,
    allocation_root: Path | None = None,
) -> MergeResult:
    """Fold anything filed in the inbox into the ledger.

    **Each entry is published under a receipt and claimed before it is read.** A
    writer records a receipt naming its intended file, completes a ``.md.part``,
    then hard-links the part to that name with ``os.link``; the merger claims only
    files whose
    receipt says ``published``, one by one. The rename this once used is NOT the
    publication mechanism and has not been since the receipt protocol landed —
    the part's own name is removed only after the receipt is promoted. Reading a
    shared file and truncating afterwards — the obvious implementation, and the
    one this replaced — lets two filing sessions overwrite each other. Claiming
    an unpublished file would instead commit a valid-looking partial prefix while
    the writer's remaining lines disappear into an unlinked inode.

    **A refused batch is never destroyed.** A filing with no entry is refused
    where it stands, in the inbox before claiming or in the fixed claim directory
    during adoption. Every later refusal leaves the batch in that directory,
    whose path the error names. The directory records durable ownership of that
    batch; the ledger flock excludes concurrent ledger writers, while atomic
    ``mkdir`` prevents two consumers from claiming the same published files.

    Validation reuses the normal validator on a merged candidate rather than a
    second parser that could drift from the one deciding what gets worked on.
    """
    decisions = decisions or ledger.parent / "decisions.md"
    if mode is None:
        mode = _claim_finalisation_mode(
            ledger, merge_without_intent=_ACTIVE_LEDGER_COMMIT is None
        )
        if mode == "deferred":
            _deferred_preconditions(ledger, decisions)
    legacy = inbox.with_suffix(".md")
    claim = inbox.with_name(f"{inbox.name}.claim")

    def refuse() -> MergeResult:
        if mode == "deferred":
            _mark_refused_inbox_claim(claim)
        return MergeResult(1)

    _sweep_scratch(ledger.parent, lambda target: target == ledger.name)
    _sweep_scratch(
        inbox, lambda target: _GENERATED_INBOX_PART_RE.fullmatch(target) is not None
    )
    reconciliation: Reconciliation | None = None
    if mode == "deferred":
        existing = _read_claim_intent(claim)
        if existing is not None and existing.phase == "prepared":
            reconciliation = _reconcile_inbox_claim(claim, inbox, ledger, decisions)
        elif existing is not None:
            _recover_claim(
                claim, inbox, ledger, publish_locked=True, durable_replay=False
            )
    else:
        _recover_claim(
            claim, inbox, ledger, publish_locked=True, durable_replay=True
        )
    try:
        receipt_index = _receipt_index(
            inbox, _merge_receipt_digests(inbox, legacy, claim if mode == "deferred" else None)
        )
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        orphan_context = next(iter(inbox.glob(".*.part")), None)
        suffix = (
            f" while checking orphan {orphan_context}"
            if orphan_context is not None
            else ""
        )
        print(f"FAIL {exc}{suffix}", file=sys.stderr)
        return refuse()
    if not _adopt_orphan_parts(inbox, receipt_index):
        print(
            f"FAIL could not adopt every orphan in {inbox}; the merge "
            "is incomplete and the orphan files were preserved.",
            file=sys.stderr,
        )
        return refuse()
    if reconciliation is not None and reconciliation.refused:
        try:
            _refuse_entryless_filings(inbox, legacy, adopted=reconciliation.absent)
        except LedgerReadRefused:
            raise
        except LedgerError as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            return refuse()
    else:
        _refuse_entryless_filings(inbox, legacy)
    if reconciliation is not None and claim.exists():
        adopted = list(reconciliation.absent)
        newly_claimed = claim_spool(
            inbox, claim, legacy=legacy, into_existing=True
        )
        if newly_claimed is None:
            _report_refused_claim(
                claim, batch="", action="merging", stranded="a filed finding"
            )
            return refuse()
        claimed = adopted + newly_claimed
        adopted_paths = set(adopted)
    else:
        claimed = claim_spool(inbox, claim, legacy=legacy)
        adopted_paths = set()
    if claimed is None:
        return MergeResult(
            _report_refused_claim(
                claim, batch="", action="merging", stranded="a filed finding"
            )
        )
    if not claimed:
        return MergeResult(0)

    # The legacy single-file inbox is claimed by name like any other member, so
    # its presence is read back from the claim rather than tracked separately.
    # Reported only on success, never before a refusal could keep it claimed.
    legacy_claimed = (claim / legacy.name).exists()

    try:
        ledger_text = _read_ledger_text(ledger)
        _refuse_controller_export(ledger, ledger_text, "merge-inbox")
        sources = _merge_sources(claimed, ledger)
        raw_sources = [
            claimed_path.read_text(encoding="utf-8") for claimed_path in claimed
        ]
        if adopted_paths:
            sources = [
                _reset_nonfixed_ids(
                    text,
                    header_ids(text) - reconciliation.provisional_ids.get(path.name, set())
                    if reconciliation.refused else reconciliation.fixed,
                )
                if path in adopted_paths
                else text
                for path, text in zip(claimed, sources, strict=True)
            ]
    except LedgerReadRefused:
        raise
    except (OSError, UnicodeDecodeError, LedgerError) as exc:
        print(
            f"FAIL could not read {claim} while merging: {exc}. The ledger is "
            f"unchanged and the batch is preserved at {claim}.",
            file=sys.stderr,
        )
        return refuse()
    # Seeded from the whole batch before a single id is handed out, not just
    # from the ledger: a file that picked its own id is still a claim on that
    # number, and allocating it a second time is the very collision the
    # PENDING form exists to remove.
    taken = header_ids(ledger_text)
    for text in sources:
        taken |= header_ids(text)

    assigned: list[str] = []
    assigned_by_file: dict[Path, list[str]] = {}
    parts: list[str] = []
    try:
        retained = set().union(*(header_ids(text) for text in sources)) - {PENDING_ID}
        if retained:
            _set_claim_id_reservation(claim, retained, retain_previous=True)
        if retained or any(
            match.group("id") == PENDING_ID
            for text in sources
            for _, _, match in _unfenced_header_matches(text)[1]
        ):
            taken.update(_clone_allocation_ids(
                allocation_root, ledger, retained=retained, own_claim=claim,
            ))
        for path, text in zip(claimed, sources, strict=True):
            # The filing date is resolved only when there is actually an id to
            # mint. A file that already carries its id needs no date, and
            # refusing it over its NAME would reject a batch this command has
            # no quarrel with.
            published_path = inbox / path.name
            _lines, _headers, _orphans = _unfenced_header_matches(text)
            if not any(
                match.group("id") == PENDING_ID
                for _heading_idx, _header_idx, match in _headers
            ):
                parts.append(text)
                assigned_by_file[published_path] = []
                continue
            rewritten, minted = assign_pending_ids(
                text, _spool_file_date(path, legacy), taken
            )
            parts.append(rewritten)
            assigned += minted
            assigned_by_file[published_path] = minted
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        print(
            f"FAIL {exc}. The ledger is unchanged and the batch is preserved "
            f"at {claim}.",
            file=sys.stderr,
        )
        return refuse()
    body = "\n\n".join(parts).strip()
    if not body:
        # Unreachable while _refuse_entryless_filings holds; never release here.
        raise LedgerError(
            f"{claim} contains no findings; its published filings and receipts "
            "are preserved for inspection"
        )

    # **Persist the allocation into the spool files before anything else.**
    # An id is handed out here and nowhere else. The right rule depends on the
    # outcome:
    #   * a refusal below leaves the batch in the claim to be corrected and
    #     adopted. Deferred refusals keep per-filing provisional provenance
    #     across an interrupted rewrite. Adoption resets those provisional ids
    #     per filing and allocates them again;
    #   * once the ledger write may have happened, the ids must survive. The
    #     ledger write and spool release are two filesystem steps. A crash
    #     between them leaves the findings merged but still claimed. Replaying
    #     `f-PENDING` would append them a second time, so recovery re-proposes the
    #     on-disk ids and hits the duplicate check — a loud stop instead of a
    #     double entry.
    receipt_records: list[tuple[str, str, str]] = []
    receipt_ids: dict[str, dict[str, str]] = {}
    allocated_receipt_names: set[str] = set()
    for path, raw, rewritten in zip(claimed, raw_sources, parts, strict=True):
        rewritten_headers = _unfenced_header_matches(rewritten)[1]
        raw_entries = _receipt_entry_texts(raw)
        entry_records = [
            (entry_text, rewritten_headers[index][2].group("id"))
            for index, entry_text in enumerate(raw_entries)
        ]
        for entry_index, (entry_text, identifier) in enumerate(entry_records):
            filing_key = (
                path.name if len(entry_records) == 1 else f"{path.name}#{entry_index}"
            )
            reused_receipt = (
                reconciliation.receipt_names.get(filing_key)
                if reconciliation is not None
                else None
            )
            if reused_receipt is not None and reconciliation.refused:
                receipt = _read_receipt(receipt_directory(inbox) / reused_receipt)
                if (
                    len(entry_records) != 1
                    or receipt is None
                    or receipt["published"] != path.name
                ):
                    reused_receipt = None
            receipt_path = (
                receipt_directory(inbox) / reused_receipt
                if reused_receipt is not None
                else _allocate_receipt_path(
                    inbox,
                    receipt_index,
                    entry_text,
                    path.name,
                    identifier,
                    allocated_receipt_names,
                )
            )
            if receipt_path.name in allocated_receipt_names:
                raise LedgerError(
                    f"duplicate receipt name {receipt_path.name} was allocated "
                    "to more than one claimed entry"
                )
            allocated_receipt_names.add(receipt_path.name)
            receipt = {
                "id": identifier,
                "published": path.name,
                "receipt": receipt_path.name,
            }
            receipt_ids[filing_key] = receipt
            receipt_records.append((receipt_path.name, path.name, identifier))

    section = f"\n\n---\n\n## {datetime.now().astimezone():%Y-%m-%d} — filed through the inbox spool\n\n"
    candidate = ledger_text.rstrip() + section + body + "\n"

    try:
        fixed = None
        provisional_ids = None
        if mode == "deferred":
            fixed = set(reconciliation.fixed if reconciliation is not None else ())
            if reconciliation is not None and reconciliation.refused:
                fixed = set().union(*(header_ids(text) for text in sources))
            else:
                for path, raw in zip(claimed, raw_sources, strict=True):
                    if path not in adopted_paths:
                        fixed.update(header_ids(raw))
            provisional_ids = {
                path.name: (
                    set(assigned_by_file.get(inbox / path.name, []))
                    | (
                        reconciliation.provisional_ids.get(path.name, set())
                        if reconciliation is not None else set()
                    )
                    | (
                        header_ids(raw) - fixed
                        if path in adopted_paths else set()
                    )
                )
                for path, raw in zip(claimed, raw_sources, strict=True)
            }
        _write_claim_intent(
            claim,
            "prepared",
            header_ids(body),
            receipt_ids,
            fixed=fixed,
            provisional_ids=provisional_ids,
        )
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError) as exc:
        print(
            f"FAIL {exc}. The ledger is unchanged and the batch is preserved "
            f"at {claim}.",
            file=sys.stderr,
        )
        return refuse()
    if assigned:
        try:
            for path, rewritten in zip(claimed, parts, strict=True):
                _atomic_write(path, rewritten + "\n", durable_directory=True)
        except LedgerReadRefused:
            raise
        except (LedgerError, OSError) as exc:
            print(
                f"FAIL {exc}. The ledger is unchanged and the batch is preserved "
                f"at {claim}.",
                file=sys.stderr,
            )
            return refuse()

    def candidate_issues(
        candidate_text: str, new_parts: Collection[tuple[Path, str]] = ()
    ) -> list[str]:
        found = _validate_text(candidate_text, ledger)
        if _impact_queue_enabled():
            for path, part in new_parts:
                findings, _problems, _vocabulary = _parse_text(
                    _entry_candidate_text(part, ledger_text), ledger
                )
                for finding in findings:
                    found += _impact_admission_issues(finding, path)
                    found += _repeated_field_issues(finding, path)
        if not found and mode == "deferred":
            valid_pair, pair_detail = _validate_candidate_pair(
                candidate_text, ledger, decisions
            )
            if not valid_pair:
                found.append(f"merged candidate does not validate: {pair_detail}")
        return found

    issues = candidate_issues(candidate, list(zip(claimed, parts, strict=True)))
    if issues:
        base_issues = candidate_issues(ledger_text)
        if base_issues:
            for issue in issues:
                print(f"FAIL {issue}", file=sys.stderr)
            print(
                "\nrefusing to merge: the result would not validate. The ledger is "
                f"unchanged and the batch is preserved at {claim}. Fix it there.",
                file=sys.stderr,
            )
            return refuse()

        kept_indexes: list[int] = []
        quarantined: dict[str, str] = {}
        for index, (path, part) in enumerate(zip(claimed, parts, strict=True)):
            single = ledger_text.rstrip() + section + part.strip() + "\n"
            single_issues = candidate_issues(single, [(path, part)])
            if single_issues:
                quarantined[path.name] = (
                    single_issues[0].replace("\r", " ").replace("\n", " ")
                )
            else:
                kept_indexes.append(index)

        kept_parts = [parts[index] for index in kept_indexes]
        kept_body = "\n\n".join(kept_parts).strip()
        kept_candidate = (
            ledger_text.rstrip() + section + kept_body + "\n"
            if kept_body
            else ledger_text
        )
        kept_issues = candidate_issues(
            kept_candidate, [(claimed[index], parts[index]) for index in kept_indexes]
        )
        if not quarantined or kept_issues:
            for issue in issues:
                print(f"FAIL {issue}", file=sys.stderr)
            print(
                "\nrefusing to merge: the result would not validate. The ledger is "
                f"unchanged and the batch is preserved at {claim}. Fix it there.",
                file=sys.stderr,
            )
            return refuse()

        _write_quarantined_inbox_receipts(inbox, receipt_ids, quarantined)
        current_intent = _read_claim_intent(claim)
        if current_intent is None:
            raise LedgerError(f"claim {claim} disappeared before quarantine")
        _recover_inbox_quarantines(claim, inbox, current_intent)

        dropped_names = set(quarantined)
        original_claimed = claimed
        claimed = [original_claimed[index] for index in kept_indexes]
        raw_sources = [raw_sources[index] for index in kept_indexes]
        # Keep each in-memory component aligned with the claimed files. The
        # claim files already contain the durable allocated ids at this point.
        sources = [sources[index] for index in kept_indexes]
        parts = kept_parts
        assigned_by_file = {
            path: assigned_by_file[path]
            for path in assigned_by_file
            if path.name not in dropped_names
        }
        assigned = [
            identifier
            for path in claimed
            for identifier in assigned_by_file.get(inbox / path.name, [])
        ]
        receipt_records = [
            record for record in receipt_records if record[1] not in dropped_names
        ]
        receipt_ids = {
            key: value
            for key, value in receipt_ids.items()
            if value["published"] not in dropped_names
        }
        body = kept_body
        candidate = kept_candidate
        if not claimed:
            _remove_claim_intent(claim)
            claim.rmdir()
            print("merged 0 finding(s) from the inbox")
            return MergeResult(0)

    # Count what the PARSER found, never `body.count(ENTRY_MARKER)`. That
    # substring also matches a `### ` inside a fenced example, so a spool file
    # holding nothing but a quoted entry used to be appended to the ledger and
    # reported as a merged finding — a success message for zero work.
    merged = len(header_ids(body))
    if not merged:
        print(
            f"FAIL {inbox} had content but no finding the parser could read, so "
            f"nothing could be merged. It is preserved at {claim}. A '### ' or a "
            "header line inside a fence is an example, not an entry.",
            file=sys.stderr,
        )
        return refuse()

    merged_ids = sorted(header_ids(body))
    candidate_findings = _parse_text(candidate, ledger)[0]
    expected_entries = [
        _finding_expectation(finding)
        for finding in candidate_findings
        if finding.id in merged_ids
    ]
    command = (
        _ACTIVE_LEDGER_COMMIT.command
        if _ACTIVE_LEDGER_COMMIT is not None
        else "merge-inbox"
    )
    _register_ledger_commit(
        f"docs(findings): {command} {' '.join(merged_ids)}",
        merged_ids,
        _finding_entries_postcondition(expected_entries),
    )

    try:
        _write_if_unchanged(ledger, ledger_text, candidate, durable_directory=True)
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError) as exc:
        print(
            f"FAIL {exc}. The ledger may already have changed and the batch is "
            f"preserved at {claim}.",
            file=sys.stderr,
        )
        return MergeResult(1)

    if mode == "deferred":
        active = _ACTIVE_LEDGER_COMMIT
        if active is not None:
            active.claim = claim
            active.finalize = lambda: _finalize_claim(
                claim, inbox, ledger, decisions, "deferred",
                _finalize_inbox_claim_locked,
            )
            active.provisional = tuple(assigned)
        _note_folded_legacy(legacy, legacy_claimed)
        allocation = f": {' '.join(assigned)}" if assigned else ""
        print(f"merged {merged} finding(s) from the inbox{allocation}")
        return MergeResult(0, assigned_by_file)

    # Receipt finalisation and claim release are one publish transaction. A
    # concurrent `cmd_file` takes this same lock; without it, it can publish
    # after the receipt is written and then rewrite `merged` back to
    # `published` while the claim is still being released.
    _write_merged_receipts(inbox, receipt_records)
    release_spool(claim, inbox, claimed, publish_locked=True)
    _note_folded_legacy(legacy, legacy_claimed)
    # Name the allocated ids: a drain-owned filing session cannot learn them,
    # so the merge output is the place that mapping is recorded.
    allocation = f": {' '.join(assigned)}" if assigned else ""
    print(f"merged {merged} finding(s) from the inbox{allocation}")
    return MergeResult(0, assigned_by_file)


def _args_decisions(args: argparse.Namespace) -> Path:
    """Return the decisions ledger a command names, defaulting beside the findings ledger.

    Direct in-process callers pass namespaces without ``decisions``; the parser always sets it.
    """
    ledger = _canonical_ledger_path(args.ledger)
    decisions = getattr(args, "decisions", None)
    target = decisions if decisions is not None else ledger.parent / "decisions.md"
    return _canonical_ledger_path(target)


def inbox_filed_by(inbox: Path, sessions: set[str]) -> list[str]:
    """List attributed entries and parts completely, without locks or writes."""
    try:
        paths = sorted(inbox.iterdir())
    except FileNotFoundError as exc:
        if _entry_state(inbox) != _ENTRY_BROKEN:
            return []
        raise LedgerError(f"could not enumerate findings inbox {inbox}: {exc}") from exc
    except OSError as exc:
        raise LedgerError(f"could not enumerate findings inbox {inbox}: {exc}") from exc
    names = []
    for path in paths:
        if path.suffix not in {".md", ".part"}:
            continue
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise LedgerError(f"findings inbox {path}: not a regular file")
                contents = stream.read().decode("utf-8")
            for match in FILED_FROM_RE.finditer(_unfenced_text(contents)):
                stamp = match.group().split("**Filed from:**", 1)[1].strip().split()[0]
                if stamp in sessions:
                    names.append(path.name)
                    break
        except (OSError, UnicodeError) as exc:
            raise LedgerError(f"could not read findings inbox {path}: {exc}") from exc
    return names


def cmd_inbox_filed_by(args: argparse.Namespace) -> int:
    names = inbox_filed_by(args.inbox, set(args.session))
    print(json.dumps(names, ensure_ascii=True))
    return 0


def cmd_merge_inbox(args: argparse.Namespace) -> int:
    """CLI entry point over the shared inbox merge implementation."""
    return merge_inbox(
        args.inbox, args.ledger, decisions=_args_decisions(args),
    ).returncode


def _drain_lock_marker_reason(contents: bytes) -> str | None:
    """Classify the diagnostic marker stored in a free consumer lock."""
    marker = contents.decode("utf-8").strip()
    if not marker or marker == DRAIN_LOCK_RELEASED_MARKER:
        return None
    if _impact_queue_enabled() and marker.startswith(DRAIN_LOCK_FENCE_MARKER_PREFIX):
        pid = marker[len(DRAIN_LOCK_FENCE_MARKER_PREFIX):]
        return f"no process holds it; the last with-drain-locks.sh holder recorded pid {pid}"
    if marker.isdecimal():
        return f"no process holds it; the last owner recorded pid {marker}"
    return f"no process holds it and its contents are not a pid: {marker!r}"


def _drain_lock_state(lock: Path) -> tuple[bool, str | None, bool]:
    """Return kernel ownership, a leftover marker reason, and read uncertainty.

    The consumer lock is a shared flock owned by ``drain-findings.sh``. The
    recorded PID is diagnostic only: this reader never asks the kernel whether
    that process is alive. A decimal marker is therefore stale when the flock
    is free, while ``released`` and an empty marker are ordinary free states.
    The third position distinguishes a free lock whose contents could not be
    read from a confidently free lock; callers must not turn the former into a
    stale-lock claim.

    This deliberately fail-open diagnostic is the contract recorded by
    ``f-20260822-17`` and the supersession of ``d-20260819-04``: a filer may
    proceed after an unreadable diagnostic, but it must say that the lock could
    not be read.
    """
    try:
        fd = os.open(lock, os.O_RDONLY)
    except FileNotFoundError:
        return False, None, False
    except (OSError, UnicodeError) as exc:
        return False, f"could not read {lock}: {exc}", True

    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError as exc:
            if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
                return True, None, False
            return False, f"could not read {lock}: {exc}", True

        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError as exc:
            return False, f"could not read {lock}: {exc}", True

        try:
            os.lseek(fd, 0, os.SEEK_SET)
            reason = _drain_lock_marker_reason(os.read(fd, DRAIN_LOCK_READ_BYTES))
        except (OSError, UnicodeError) as exc:
            return False, f"could not read {lock}: {exc}", True
    finally:
        with suppress(OSError):
            os.close(fd)

    return False, reason, False


def _try_consumer_lock(ledger: Path | None = None) -> tuple[int | None, Path, str | None]:
    """Take the drain's shared consumer lock without waiting.

    The returned descriptor is kept by ``main`` until the exact ledger commit
    helper has finished. A busy drain is a normal retryable outcome; path and
    filesystem failures are reported separately so callers do not mistake a
    broken lock path for a live drain.
    """
    lock = drain_lock_path(ledger)
    try:
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o644)
    except OSError as exc:
        return None, lock, f"could not open consumer lock {lock}: {exc}"
    try:
        fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except OSError as exc:
        with suppress(OSError):
            os.close(fd)
        if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
            return None, lock, None
        return None, lock, f"could not acquire consumer lock {lock}: {exc}"
    return fd, lock, None


def _release_consumer_lock(args: argparse.Namespace) -> None:
    fd = getattr(args, "_consumer_lock_fd", None)
    if fd is None:
        return
    with suppress(OSError):
        fcntl.flock(fd, fcntl.LOCK_UN)
    with suppress(OSError):
        os.close(fd)
    args._consumer_lock_fd = None


def _decode_entry_bytes(raw: bytes, *, errors: str = "strict") -> str:
    """Decode entry bytes with the universal newlines used by `Path.read_text`."""
    return raw.decode("utf-8", errors=errors).replace("\r\n", "\n").replace("\r", "\n")


def cmd_file_status(args: argparse.Namespace) -> int:
    """Read the content-derived filing receipt without taking any lock."""
    try:
        _refuse_controller_export_at(args.ledger, "file --status")
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    intake_sourced = args.entry.resolve().parent == intake_directory(args.inbox.resolve())
    if intake_sourced or args.entry == Path("-"):
        try:
            raw = (
                sys.stdin.buffer.read() if args.entry == Path("-")
                else args.entry.read_bytes()
            )
            text = _decode_entry_bytes(raw)
            if not intake_sourced:
                text = _stamp_filing_entry(text)
            entry, issues = _validate_entry_text(
                text, args.ledger, args.entry
            )
        except (OSError, UnicodeError) as exc:
            entry, issues = None, [str(exc)]
    else:
        entry, issues = _read_and_validate_entry(args.entry, args.ledger)
    if issues:
        for issue in issues:
            print(f"FAIL {issue}", file=sys.stderr)
        return 1
    assert entry is not None
    receipt_path = _receipt_path(
        args.inbox, entry,
        filing_token=_intake_filing_token(args.entry) if intake_sourced else None,
    )
    receipt = _read_receipt(receipt_path)
    if receipt is None:
        print("none")
        return 0

    state = receipt["state"]
    if state == "publishing":
        published = args.inbox / receipt["published"]
        try:
            match = _published_filing_matches(published, entry)
        except LedgerError as exc:
            raise LedgerError(
                f"could not verify publishing receipt {receipt_path}: {exc}"
            ) from exc
        if match is None:
            print("none")
            return 0
        if match is False:
            raise LedgerError(
                f"publishing receipt {receipt_path} names {published}, "
                "but the linked inbox bytes do not match the entry digest"
            )
        print("published")
        return 0

    print(state)
    return 0


def _refuse_terminal_filing_receipt(
    receipt: dict[str, str] | None, receipt_path: Path, *, invite_again: bool = True
) -> bool:
    """Report a terminal merged or quarantined filing receipt."""
    if receipt is None:
        return False
    if receipt["state"] == "merged":
        invitation = " Use --again to file it deliberately." if invite_again else ""
        print(
            f"FAIL this entry was already filed as {receipt['id']} according to "
            f"{receipt_path}.{invitation}",
            file=sys.stderr,
        )
        return True
    if receipt["state"] == "quarantined":
        print(
            f"FAIL this entry was quarantined: {receipt['reason']} at "
            f"{receipt['refused']}. Use --again to file it deliberately.",
            file=sys.stderr,
        )
        return True
    return False


def intake_directory(inbox: Path) -> Path:
    return inbox / "intake"


def _intake_filing_token(path: Path) -> str | None:
    match = re.search(r"-again-(.+)\.md$", path.name)
    return match[1] if match is not None else None


_IntakeNameOrder = NamedTuple("_IntakeNameOrder", [("family", str), ("order", tuple[int, int, str])])


def _intake_name_order(path: Path) -> _IntakeNameOrder:
    """Parse <family>[.r<N>-<unique>][-again-<token>].md into family and
    order (revision, timestamp_ns or 0, name).
    """
    token = _intake_filing_token(path)
    stem = path.name[:-3]
    if token is not None:
        stem = stem[:-(len(token) + len("-again-"))]
    revision = re.fullmatch(r"(.+)\.r(\d+)-\d+-(\d+)-\d+", stem)
    if revision is not None and int(revision[2]) >= 2:
        return _IntakeNameOrder(revision[1], (int(revision[2]), int(revision[3]), path.name))
    unique = re.search(r"-\d+-(\d+)-\d+$", stem)
    return _IntakeNameOrder(stem, (1, int(unique[1]) if unique is not None else 0, path.name))


def _intake_family_members(source: Path) -> list[Path]:
    family, _order = _intake_name_order(source)
    try:
        paths = list(source.parent.iterdir())
    except FileNotFoundError:
        return []
    return sorted(
        (path for path in paths
         if not path.name.startswith(".") and path.suffix == ".md"
         and not path.is_symlink() and path.is_file()
         and _intake_name_order(path).family == family),
        key=lambda path: _intake_name_order(path).order,
    )


def _make_intake_directory(inbox: Path) -> Path:
    for directory in (inbox, intake_directory(inbox)):
        existed = directory.exists()
        directory.mkdir(parents=True, exist_ok=True)
        if not existed:
            _fsync_directory(directory.parent)
    return intake_directory(inbox)


def _stage_intake(
    inbox: Path, raw: bytes, *, filing_token: str | None = None,
    replaces: Path | None = None,
) -> Path:
    """Persist bytes before validation; an unsuccessful write never removes bytes."""
    suffix = f"-again-{filing_token}" if filing_token is not None else ""
    name = f"{_publish_stamp()}-{_unique_suffix()}{suffix}.md"
    for attempt in range(INTAKE_STAGING_ATTEMPTS):
        renamed = False
        try:
            directory = _make_intake_directory(inbox)
            staged = directory / name
            temporary = directory / f".{name}.tmp-{_unique_suffix()}"
            with temporary.open("xb") as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
            if replaces is None:
                os.replace(temporary, staged)
                renamed = True
                _fsync_directory(directory)
            else:
                try:
                    with _publish_lock(publish_lock_path(inbox)):
                        if replaces.is_symlink() or not replaces.is_file():
                            raise LedgerError(
                                f"{replaces} is no longer in the intake (filed, recovered "
                                "or replaced by a concurrent merge or filing); nothing was staged"
                            )
                        members = _intake_family_members(replaces)
                        family, _order = _intake_name_order(replaces)
                        revision, _ns, _name = max(_intake_name_order(p).order for p in members)
                        staged = directory / f"{family}.r{revision + 1}-{_unique_suffix()}{suffix}.md"
                        os.replace(temporary, staged)
                        renamed = True
                        _fsync_directory(directory)
                except LedgerError as exc:
                    exc.staging_temporary = temporary
                    raise
            return staged
        except OSError as exc:
            if renamed:
                if exc.errno == errno.ENOENT:
                    return staged
                raise
            if exc.errno != errno.ENOENT or attempt == INTAKE_STAGING_ATTEMPTS - 1:
                raise
    raise AssertionError("unreachable intake staging retry")


def _filing_citation_issues(
    entry: str, ledger: Path, decisions: Path, *, ledger_text: str | None = None
) -> list[str]:
    if ledger_text is None:
        ledger_text = _read_ledger_text(ledger)
    candidate = ledger_text.rstrip() + "\n\n" + entry + "\n"
    return _candidate_citation_issues(candidate, ledger, decisions)


def _published_filing_matches(published: Path, entry: str) -> bool | None:
    """The one verifier of a published filing against its entry digest.

    Return None for an absent path, True or False for a digest match or mismatch,
    and refuse a dangling link or any other read error.
    """
    try:
        return _sha256_bytes(published.read_bytes()) == _sha256_text(entry)
    except FileNotFoundError as exc:
        if _entry_state(published) != _ENTRY_BROKEN:
            return None
        raise LedgerError(f"could not read published filing {published}: {exc}") from exc
    except OSError as exc:
        raise LedgerError(f"could not read published filing {published}: {exc}") from exc


def _publish_filing(inbox: Path, entry: str, *, filing_token: str | None = None) -> Path:
    """Publish under the caller's publish lock through the durable receipt protocol."""
    receipt_path = _receipt_path(inbox, entry, filing_token=filing_token)
    receipt = _read_receipt(receipt_path)
    new_receipt = receipt is None
    if receipt is not None and receipt["state"] in {"merged", "quarantined"}:
        raise LedgerError(
            f"this entry was already filed according to {receipt_path}. "
            "Use --again to file it deliberately."
        )
    if receipt is None:
        receipt = {
            "state": "publishing",
            "published": f"{_publish_stamp()}-{_unique_suffix()}.md",
        }
    published_name = receipt["published"]
    published = inbox / published_name
    claimed = inbox.with_name(f"{inbox.name}.claim") / published_name
    match = _published_filing_matches(published, entry)
    in_inbox, in_claim = match is not None, claimed.exists()
    if not new_receipt and in_inbox and in_claim:
        raise LedgerError(
            f"filing receipt {receipt_path} names {published_name}, "
            "which exists in both the inbox and claim. Use --again to file deliberately."
        )
    if not new_receipt and match is False:
        raise LedgerError(
            f"filing receipt {receipt_path} names {published_name}, "
            "but the inbox content does not match this entry. "
            "Use --again to file deliberately."
        )
    state = receipt["state"]
    if not new_receipt and state == "published" and not in_inbox and not in_claim:
        detail = (
            f"it was filed as {receipt['id']}" if "id" in receipt
            else "the allocated id was not recorded"
        )
        raise LedgerError(
            f"this entry was already filed according to {receipt_path}; {detail}. "
            "Use --again to file it deliberately."
        )
    needs_link = new_receipt or (state == "publishing" and not in_inbox and not in_claim)
    if needs_link:
        inbox.mkdir(parents=True, exist_ok=True)
        recorded_part = receipt.get("part")
        part = inbox / recorded_part if recorded_part is not None else None
        if part is not None and part.exists():
            if part.read_text(encoding="utf-8") != entry:
                raise LedgerError(
                    f"filing receipt {receipt_path} names part {part.name}, "
                    "but its content does not match this entry"
                )
        else:
            part = inbox / f".{_publish_stamp()}-{_unique_suffix()}.part"
            receipt["part"] = part.name
            _write_receipt(
                receipt_path,
                {"state": "publishing", "published": published_name, "part": part.name},
            )
            _atomic_write(part, entry)

        def candidate_for(attempt: int) -> Path:
            if attempt == 0:
                return inbox / published_name
            return inbox / f"{_publish_stamp()}-{_unique_suffix()}.md"

        def record_publishing(candidate: Path) -> None:
            nonlocal published_name
            published_name = candidate.name
            _record_publishing(receipt_path, receipt, candidate)

        published = _link_with_retries(part, candidate_for, record_publishing)
        _fsync_directory(inbox)
        _write_receipt(receipt_path, _published_receipt_record(published.name, receipt))
        try:
            part.unlink(missing_ok=True)
        except OSError as exc:
            print(
                f"WARN published {published}; "
                f"could not remove part {part}: {exc}", file=sys.stderr
            )
    elif state == "publishing":
        _fsync_directory(inbox)
        _write_receipt(receipt_path, _published_receipt_record(published_name, receipt))
    return published


def _remove_published_intake(
    path: Path, published: Path, *, replaced: bool = False
) -> bool:
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        if replaced:
            print(
                f"WARN published {published}; "
                f"could not remove replaced {path}: {exc} — the next merge clears it",
                file=sys.stderr,
            )
        else:
            print(
                f"WARN published {published}; "
                f"could not remove {path}: {exc} — the next merge clears it", file=sys.stderr
            )
        return False
    return True


def _complete_intake_filing(source: Path, published: Path) -> None:
    try:
        members = _intake_family_members(source)
    except OSError as exc:
        print(
            f"WARN published {published}; could not list the intake family of "
            f"{source}: {exc} — the next merge clears it", file=sys.stderr,
        )
        return
    source_order = _intake_name_order(source).order
    older = [p for p in members if _intake_name_order(p).order < source_order]
    removed = True
    for path in older:
        if not _remove_published_intake(path, published, replaced=True):
            removed = False
    if removed:
        _remove_published_intake(source, published)


def _intake_covered(inbox: Path, entry: str, token: str | None = None) -> bool:
    receipt = _read_receipt(_receipt_path(inbox, entry, filing_token=token))
    if receipt is None or receipt["state"] == "publishing":
        return False
    if receipt["state"] in {"merged", "quarantined"}:
        return True
    published = inbox / receipt["published"]
    match = _published_filing_matches(published, entry)
    if match is not None:
        return match
    # A prepared claim has substituted its allocated id; its receipt is
    # still published until the ledger commit, and the claim owns the bytes.
    member = inbox.with_name(f"{inbox.name}.claim") / receipt["published"]
    if _entry_state(member) == _ENTRY_BROKEN:
        try:
            member.stat()
        except OSError as exc:
            # The OSError cause is what the intake sweep classifies as a read failure.
            raise LedgerError(
                f"could not read claimed filing {member}: {exc}"
            ) from exc
    return member.is_file()


def _intake_recovery_entry(raw: bytes, ledger_text: str) -> str:
    """Build a recovery identity from bytes and vocabulary, never a path or reason."""
    lines = ledger_text.splitlines()
    header = _ledger_header_text(lines, _fence_mask(lines))
    vocabulary = _backticks_after_bold_label(header, VOCAB_RE) or frozenset()
    rendered = _decode_entry_bytes(raw, errors="replace")
    try:
        unfenced = _unfenced_text(rendered)
    except LedgerError:
        unfenced = ""
    own_area = re.search(r"\*\*Area:\*\*\s+([\w-]+)", unfenced)
    if own_area is not None and own_area[1] in vocabulary:
        area = own_area[1]
    else:
        tooling = TOOLING_AREAS_RE.search(header)
        slugs = re.findall(r"`([^`]+)`", tooling[1]) if tooling is not None else []
        if not slugs:
            areas = VOCAB_RE.search(header)
            slugs = re.findall(r"`([^`]+)`", areas[1]) if areas is not None else []
        area = slugs[0] if slugs else ""
    longest_run = max((len(m[0]) for m in re.finditer(r"`+", rendered)), default=0)
    fence = "`" * max(3, longest_run + 1)
    try:
        text = _decode_entry_bytes(raw)
        payload = f"{fence}\n{text}\n{fence}\n"
    except UnicodeError:
        encoded = base64.b64encode(raw).decode("ascii")
        payload = (
            f"```base64\n{encoded}\n```\n\nRendering (errors=\"replace\"):\n"
            f"{fence}\n{rendered}\n{fence}\n"
        )
    return (
        "### Recovered unfiled finding text\n\n"
        f"* **ID:** f-PENDING · **Status:** open · **Area:** {area} · "
        "**Root:** - · **Entry:** inline · **Blocked:** none\n\n"
        "* **Where:** `<inbox>/intake/`, the findings intake directory.\n"
        "* **Defect:** A session handed this text to `findings.py file` "
        "and the filing never completed.\n"
        "* **Proof:** After `related`, re-file the text as its own entry through "
        "`file -` or show it is already filed, then close this one.\n"
        "* **Found by:** findings.py merge-inbox intake sweep\n\n"
        + payload
    )


def _intake_bytes_covered(
    inbox: Path, raw: bytes, ledger: Path, path: Path, token: str | None,
    *, require_valid: bool, include_recovery: bool, ledger_text: str,
) -> bool:
    """Check staged entry coverage, optionally including its recovery wrapper."""
    try:
        entry, issues = _validate_entry_text(
            _decode_entry_bytes(raw), ledger, path, ledger_text=ledger_text
        )
        if entry is not None and (not require_valid or not issues) and _intake_covered(inbox, entry, token):
            return True
    except LedgerReadRefused:
        raise
    except (LedgerError, UnicodeError) as exc:
        if isinstance(exc.__cause__, OSError):
            raise
    if include_recovery:
        recovery = _intake_recovery_entry(raw, ledger_text)
        wrapped, _issues = _validate_entry_text(
            recovery, ledger, path, ledger_text=ledger_text
        )
        return _intake_covered(inbox, wrapped if wrapped is not None else recovery)
    return False


def _remove_superseded_intake(
    inbox: Path, ledger: Path, members: list[Path], *, resolved: bool,
    ledger_text: str,
) -> bool:
    """Remove older intake members when covered or their latest member is resolved."""
    removed = True
    for older in members[:-1]:
        try:
            raw = older.read_bytes()
            covered = _intake_bytes_covered(
                inbox, raw, ledger, older, _intake_filing_token(older),
                require_valid=False, include_recovery=True, ledger_text=ledger_text,
            )
            if covered or resolved:
                older.unlink(missing_ok=True)
                if covered:
                    print(f"intake-cleared {older.name}")
                else:
                    print(f"intake-superseded {older.name} by {members[-1].name}")
            else:
                print(f"intake-pending {older.name}: superseded by {members[-1].name}")
        except LedgerReadRefused:
            raise
        except (OSError, LedgerError, UnicodeError) as exc:
            removed = False
            print(f"WARN intake {older.name}: {exc}", file=sys.stderr)
    return removed


def _finish_intake_family(
    inbox: Path, ledger: Path, members: list[Path], outcome: str,
    *, ledger_text: str,
) -> None:
    """Remove a resolved intake family and print its outcome."""
    if _remove_superseded_intake(
        inbox, ledger, members, resolved=True, ledger_text=ledger_text
    ):
        members[-1].unlink(missing_ok=True)
        print(outcome)


def _sweep_intake(inbox: Path, ledger: Path, decisions: Path) -> None:
    """Best-effort intake recovery under both merge locks.

    Block the queue only on a ledger guard refusal.
    """
    directory = intake_directory(inbox)
    try:
        paths = sorted(directory.iterdir())
    except FileNotFoundError as exc:
        if (
            _impact_queue_enabled()
            and _entry_state(directory) == _ENTRY_BROKEN
        ):
            print(f"WARN intake {directory.name}: {exc}", file=sys.stderr)
        return
    except OSError as exc:
        print(f"WARN intake {directory.name}: {exc}", file=sys.stderr)
        return
    families: dict[str, list[Path]] = {}
    other = []
    for path in paths:
        try:
            if not stat.S_ISREG(path.lstat().st_mode):
                print(f"WARN intake {path.name}: not a regular non-symlink file", file=sys.stderr)
                continue
        except FileNotFoundError:
            continue
        except OSError as exc:
            print(f"WARN intake {path.name}: {exc}", file=sys.stderr)
            if path.name.startswith(".") or path.suffix != ".md":
                continue
        if not path.name.startswith(".") and path.suffix == ".md":
            family, _order = _intake_name_order(path)
            families.setdefault(family, []).append(path)
        else:
            other.append(path)
    groups = [sorted(members, key=lambda p: _intake_name_order(p).order)
              for members in families.values()]
    groups.extend([path] for path in other)
    snapshot: str | None = None
    for members in groups:
        path = members[-1]

        try:
            metadata = path.lstat()
            if not stat.S_ISREG(metadata.st_mode):
                print(f"WARN intake {path.name}: not a regular non-symlink file", file=sys.stderr)
                continue
            raw = path.read_bytes()
            token = _intake_filing_token(path)
            if snapshot is None:
                snapshot = _read_ledger_text(ledger)
            reason = "interrupted staging"
            entry = None
            temporary = re.fullmatch(r"\.(.+\.md)\.tmp-\d+-\d+-\d+", path.name)
            if temporary is not None:
                temporary_token = _intake_filing_token(Path(temporary[1]))
                if _intake_bytes_covered(
                    inbox, raw, ledger, path, temporary_token,
                    require_valid=True, include_recovery=False, ledger_text=snapshot,
                ):
                    _finish_intake_family(
                        inbox, ledger, members, f"intake-cleared {path.name}",
                        ledger_text=snapshot,
                    )
                    continue
            if not path.name.startswith(".") and path.suffix == ".md":
                try:
                    entry, issues = _validate_entry_text(
                        _decode_entry_bytes(raw), ledger, path, ledger_text=snapshot
                    )
                    if entry is not None and _intake_covered(inbox, entry, token):
                        _finish_intake_family(
                            inbox, ledger, members, f"intake-cleared {path.name}",
                            ledger_text=snapshot,
                        )
                        continue
                    if not issues and entry is not None:
                        issues = _filing_citation_issues(
                            entry, ledger, decisions, ledger_text=snapshot
                        )
                        if not issues:
                            _publish_filing(inbox, entry, filing_token=token)
                            _finish_intake_family(
                                inbox, ledger, members, f"intake-filed {path.name}",
                                ledger_text=snapshot,
                            )
                            continue
                    reason = issues[0] if issues else "entry cannot be filed"
                except LedgerReadRefused:
                    raise
                except (LedgerError, UnicodeError) as exc:
                    if isinstance(exc.__cause__, OSError):
                        raise
                    reason = str(exc)
            recovery = _intake_recovery_entry(raw, snapshot)
            wrapped, wrap_issues = _validate_entry_text(
                recovery, ledger, path, ledger_text=snapshot
            )
            if _intake_covered(inbox, wrapped if wrapped is not None else recovery):
                _finish_intake_family(
                    inbox, ledger, members, f"intake-cleared {path.name}",
                    ledger_text=snapshot,
                )
                continue
            if metadata.st_mtime < time.time() - INTAKE_RECOVERY_GRACE_SECONDS:
                issues = wrap_issues
                if not issues and wrapped is not None:
                    issues = _filing_citation_issues(
                        wrapped, ledger, decisions, ledger_text=snapshot
                    )
                    if not issues:
                        _publish_filing(inbox, wrapped)
                        _finish_intake_family(
                            inbox, ledger, members, f"intake-recovered {path.name}: {reason}",
                            ledger_text=snapshot,
                        )
                        continue
                reason = issues[0] if issues else reason
            print(f"intake-pending {path.name}: {reason}")
            _remove_superseded_intake(
                inbox, ledger, members, resolved=False, ledger_text=snapshot
            )
        except LedgerReadRefused:
            raise
        except (OSError, LedgerError, UnicodeError) as exc:
            print(f"WARN intake {path.name}: {exc}", file=sys.stderr)
    try:
        directory.rmdir()
    except FileNotFoundError:
        pass
    except OSError as exc:
        if exc.errno not in {errno.ENOTEMPTY, errno.EEXIST}:
            print(f"WARN intake {directory.name}: {exc}", file=sys.stderr)
    else:
        try:
            inbox.rmdir()
        except FileNotFoundError:
            pass
        except OSError as exc:
            if exc.errno not in {errno.ENOTEMPTY, errno.EEXIST}:
                print(f"WARN intake {directory.name}: {exc}", file=sys.stderr)


def _print_kept_intake(args: argparse.Namespace, source: Path, token: str | None) -> None:
    global_options = []
    for name in ("ledger", "decisions"):
        if getattr(args, f"_explicit_{name}", False):
            global_options.extend([f"--{name}", str(getattr(args, name))])
    options = []
    if bool(getattr(args, "spool_only", False)):
        options.append("--spool-only")
    if getattr(args, "_explicit_inbox", False) or args.inbox != INBOX:
        options.extend(["--inbox", str(args.inbox)])
    if token is not None:
        options.append("--again")
    command = shlex.join(
        ["findings.py", *global_options, "file", *options, "--replaces", str(source), "-"]
    )
    print(f"kept {source}; file the corrected entry with: {command}", file=sys.stderr)


def cmd_file(args: argparse.Namespace) -> int:
    """Publish one pending finding, then merge it when no live drain owns the ledger."""
    try:
        _refuse_controller_export_at(args.ledger, "file")
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    inbox: Path = args.inbox.resolve()
    intake = intake_directory(inbox)
    source = args.entry.resolve()
    intake_sourced = args.entry != Path("-") and source.parent == intake
    display_path = source if intake_sourced else (
        Path("<stdin>") if args.entry == Path("-") else args.entry
    )
    replaces = getattr(args, "replaces", None)
    if replaces is not None:
        replaces = replaces.absolute()
        if (
            replaces.parent.resolve() != intake or replaces.is_symlink()
            or not replaces.is_file() or replaces.name.startswith(".")
            or replaces.suffix != ".md"
        ):
            print("FAIL --replaces must name a regular non-symlink, non-dot *.md file inside the intake", file=sys.stderr)
            return 2
        if intake_sourced:
            print("FAIL --replaces cannot be used with an intake entry path", file=sys.stderr)
            return 2
    if intake_sourced and bool(getattr(args, "again", False)):
        print("FAIL --again cannot be used with an intake path", file=sys.stderr)
        return 2
    token = _intake_filing_token(source) if intake_sourced else (
        _unique_suffix() if bool(getattr(args, "again", False)) else None
    )
    try:
        raw = sys.stdin.buffer.read() if args.entry == Path("-") else source.read_bytes()
        if not intake_sourced:
            try:
                text = _decode_entry_bytes(raw)
                stamped = _stamp_filing_entry(text)
                if stamped != text:
                    raw = stamped.encode("utf-8")
            except (UnicodeError, LedgerError):
                pass
            source = _stage_intake(inbox, raw, filing_token=token, replaces=replaces)
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        temporary = getattr(exc, "staging_temporary", None)
        if temporary is not None:
            try:
                temporary.unlink(missing_ok=True)
            except OSError as cleanup_error:
                print(f"WARN could not remove staging temporary {temporary}: {cleanup_error}", file=sys.stderr)
        if isinstance(exc, PublishLockBusyError):
            if replaces is not None and not replaces.is_symlink() and replaces.is_file():
                _print_kept_intake(args, replaces, token)
            else:
                print(f"{replaces} is no longer in the intake; nothing was staged", file=sys.stderr)
            return 2
        return 1
    except (OSError, UnicodeError) as exc:
        print(f"FAIL could not stage entry: {exc}", file=sys.stderr)
        return 1

    promoted = False
    superseded = False
    merged_refused = False
    owned = token is not None and not intake_sourced

    def consumed_filing(receipt: dict[str, str] | None, *, locked: bool = False) -> int | None:
        nonlocal promoted, published
        # A fresh token proves ownership even when a sweep could not remove the source.
        owned_covered = owned and receipt is not None and (
            receipt["state"] in {"merged", "quarantined"}
            or (receipt["state"] == "published" and _intake_covered(inbox, entry, token))
        )
        if owned_covered:
            promoted = True
            if receipt["state"] == "published":
                published = inbox / receipt["published"]
            if source.exists():
                if locked:
                    _complete_intake_filing(source, inbox / receipt["published"])
                else:
                    with ExitStack() as cleanup_lock:
                        try:
                            cleanup_lock.enter_context(_publish_lock(publish_lock_path(inbox)))
                        except LedgerError as exc:
                            print(
                                f"WARN published {inbox / receipt['published']}; could not clean up "
                                f"the retained intake copy {source}: {exc} — the next merge clears it",
                                file=sys.stderr,
                            )
                        else:
                            if receipt["state"] == "published":
                                return consumed_filing(_read_receipt(receipt_path), locked=True)
                            _complete_intake_filing(source, inbox / receipt["published"])
        elif source.exists():
            return None
        if receipt is not None:
            if receipt["state"] == "merged":
                promoted = True
                print(f"already filed as {receipt['id']}")
                return 0
            if receipt["state"] == "quarantined":
                if owned:
                    promoted = True
                _refuse_terminal_filing_receipt(receipt, receipt_path)
                return 1
            if receipt["state"] == "published" and _intake_covered(inbox, entry, token):
                promoted = True
                published = inbox / receipt["published"]
                return None
        if locked:
            raise LedgerError(
                f"{source} was removed before this filing published it; nothing is kept"
            )
        return None

    def refuse_terminal_source(receipt: dict[str, str] | None) -> bool:
        nonlocal merged_refused
        if receipt is not None and receipt["state"] == "merged":
            merged_refused = _refuse_terminal_filing_receipt(
                receipt, receipt_path, invite_again=False
            )
            return merged_refused
        return _refuse_terminal_filing_receipt(receipt, receipt_path)

    def refuse_superseded() -> bool:
        nonlocal superseded
        members = _intake_family_members(source)
        if members and _intake_name_order(members[-1]).order > _intake_name_order(source).order:
            superseded = True
            print(
                f"FAIL {source} is superseded by {members[-1]}; correct or retry that file instead",
                file=sys.stderr,
            )
        return superseded

    try:
        entry, issues = _validate_entry_text(_decode_entry_bytes(raw), args.ledger, display_path)
        if issues:
            raise LedgerError("; ".join(issues))
        assert entry is not None
        decisions = _args_decisions(args)
        _warn_filing_entry(entry, args.ledger, decisions)
        receipt_path = _receipt_path(inbox, entry, filing_token=token)
        try:
            terminal = _read_receipt(receipt_path)
        except LedgerError as exc:
            raise LedgerError(f"{exc}. Use --again to file deliberately.") from exc
        outcome = consumed_filing(terminal)
        if outcome is not None:
            return outcome
        if not promoted:
            if terminal is not None and terminal["state"] == "merged" and intake_sourced:
                with _publish_lock(publish_lock_path(inbox)):
                    if refuse_superseded():
                        return 1
                    _complete_intake_filing(source, inbox / terminal["published"])
                promoted = True
                print(f"already filed as {terminal['id']}")
                return 0
            if not owned and refuse_terminal_source(terminal):
                return 1
        preconditions_checked = False
        if not promoted:
            citation_issues = _filing_citation_issues(entry, args.ledger, decisions)
            if citation_issues:
                raise LedgerError(
                    f"{display_path} does not validate with {decisions}: "
                    + "; ".join(citation_issues)
                )
            if not bool(getattr(args, "spool_only", False)):
                drain_held, _reason, _unreadable = _drain_lock_state(
                    drain_lock_path(_drain_lock_ledger(args))
                )
                if not drain_held:
                    mode = _claim_finalisation_mode(
                        args.ledger, merge_without_intent=_ACTIVE_LEDGER_COMMIT is None
                    )
                    if mode == "deferred":
                        _deferred_preconditions(args.ledger, decisions)
                        preconditions_checked = True
            with _publish_lock(publish_lock_path(inbox)):
                current = _read_receipt(receipt_path)
                outcome = consumed_filing(current, locked=True)
                if outcome is not None:
                    return outcome
                if not promoted:
                    if refuse_superseded():
                        return 1
                    if intake_sourced and current is not None and current["state"] == "merged":
                        promoted = True
                        published = inbox / current["published"]
                        _complete_intake_filing(source, published)
                        print(f"already filed as {current['id']}")
                        return 0
                    if not owned and refuse_terminal_source(current):
                        return 1
                    try:
                        published = _publish_filing(inbox, entry, filing_token=token)
                    except OSError as exc:
                        raise LedgerError(f"could not publish filing to {inbox}: {exc}") from exc
                    promoted = True
                    _complete_intake_filing(source, published)
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 2 if isinstance(exc, (PublishLockBusyError, LedgerDirtyError)) else 1
    finally:
        if not promoted and not superseded and not merged_refused and source.exists():
            _print_kept_intake(args, source, token)

    if bool(getattr(args, "spool_only", False)):
        print(f"published finding entry: {published}; entry awaits a merge")
        return 0

    lock = drain_lock_path(_drain_lock_ledger(args))
    lock_fd: int | None = None
    mutex_error: OSError | None = None
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o644)
    except OSError as exc:
        mutex_error = exc
    else:
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError as exc:
            with suppress(OSError):
                os.close(lock_fd)
            lock_fd = None
            if exc.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
                print(f"drain owns the ledger and will merge this entry: {published}")
                return 0
            mutex_error = exc
        else:
            # This is strictly better than the old probe-then-read path: the held
            # descriptor makes the diagnostic describe the state this merge
            # actually runs in, instead of a marker already obsolete when printed.
            try:
                os.lseek(lock_fd, 0, os.SEEK_SET)
                reason = _drain_lock_marker_reason(
                    os.read(lock_fd, DRAIN_LOCK_READ_BYTES)
                )
            except (OSError, UnicodeError) as exc:
                print(f"WARNING could not read {lock}: {exc}; proceeding to merge")
            else:
                if reason is not None:
                    print(
                        f"WARNING STALE drain lock {lock}: {reason}; "
                        "proceeding to merge"
                    )

    if mutex_error is not None:
        errno_name = _errno_name(mutex_error)
        print(
            f"WARNING consumer mutex {lock} unavailable "
            f"({errno_name}: {mutex_error}); falling back to diagnostic read"
        )
        drain_held, reason, unreadable = _drain_lock_state(lock)
        if drain_held:
            print(f"drain owns the ledger and will merge this entry: {published}")
            return 0
        if reason is not None:
            if unreadable:
                # `reason` already names the path and the error. The two branches
                # stay distinguishable because only the other one says STALE: an
                # unreadable lock and a leftover pid need different remedies.
                print(f"WARNING {reason}; proceeding to merge")
            else:
                print(f"WARNING STALE drain lock {lock}: {reason}; proceeding to merge")

    try:
        result = merge_inbox(
            inbox,
            args.ledger,
            decisions=decisions,
            preconditions_checked=preconditions_checked,
        )
    finally:
        if lock_fd is not None:
            if bool(getattr(args, "_hold_consumer_lock", False)):
                args._consumer_lock_fd = lock_fd
            else:
                with suppress(OSError):
                    fcntl.flock(lock_fd, fcntl.LOCK_UN)
                with suppress(OSError):
                    os.close(lock_fd)
    if result.returncode != 0:
        return result.returncode

    allocated = result.assigned_by_file.get(published, [])
    if allocated:
        print(f"filed finding as {allocated[0]}{_written_ledger_suffix(args.ledger)}")
    else:
        try:
            merged_receipt = _read_receipt(receipt_path)
        except LedgerError as exc:
            print(
                f"WARNING filing completed, but could not read its final receipt "
                f"{receipt_path}: {exc}",
                file=sys.stderr,
            )
            return 0
        if merged_receipt is not None and merged_receipt["state"] == "quarantined":
            print(
                f"FAIL this entry was quarantined: {merged_receipt['reason']} at "
                f"{merged_receipt['refused']}.",
                file=sys.stderr,
            )
            return 1
        if merged_receipt is not None and merged_receipt["state"] == "merged":
            print(
                f"filed finding as {merged_receipt['id']}"
                f"{_written_ledger_suffix(args.ledger)} (concurrent merge)"
            )
        else:
            print(
                "entry was merged by a concurrent writer; the id could not be "
                "determined"
            )
    return 0


def cmd_decisions(args: argparse.Namespace) -> int:
    """Print Felix-facing blockers.

    Optionally restricted to ``args.ids``.

    This is a read-only lookup and does not send notifications or change state.
    """
    findings, problems, vocabulary = parse(args.ledger)
    issues = validate(findings, problems, vocabulary)
    _warn_problems(issues, "decisions")
    if issues:
        # `validate` seeds `issues` with the parse problems, so they are a subset
        # of the count, never a second set beside it. They are diagnostics, not
        # entries: one entry can yield several, and a readable one can yield some.
        parse_detail = (
            f", {len(problems)} of them from parsing" if problems else ""
        )
        print(
            f"WARNING decisions found {len(issues)} validation problem(s)"
            f"{parse_detail}. Run `findings.py check`."
        )
    buckets = summary_buckets(findings)
    buckets, answered = _answered_summary(buckets)
    waiting = list(buckets.product)
    preconditions = list(buckets.preconditions)
    if args.ids:
        # Apply one requested id set consistently to each printed class.
        wanted = set(args.ids)
        waiting = [f for f in waiting if f.id in wanted]
        preconditions = [f for f in preconditions if f.id in wanted]
        answered = [row for row in answered if row["id"] in wanted]
    if not waiting and not preconditions and not answered:
        if not issues:
            print("No decisions are waiting on you.")
        return 0

    # `waiting` is exactly the stored product bucket, so the brief list is it.
    product = waiting
    if product:
        print(f"{len(product)} product decision(s) waiting on you.\n")
    for f in product:
        print(f"{f.id} — {f.title}")
        print(f"  area={f.area}  entry={f.entry}  ledger line {f.line}")
        # The brief runs from the **Decision:** bullet to the end of the entry;
        # that placement is the contract, so everything after it is part of it.
        brief_started = False
        for line in _unfenced_body(f).splitlines():
            if not brief_started and DECISION_BRIEF_RE.search(line):
                brief_started = True
            if brief_started:
                print(f"  {line}" if line.strip() else "")
        if not brief_started:
            print("  (no **Decision:** brief — `check` will flag this)")
        print()
    if preconditions:
        print(f"{len(preconditions)} precondition(s) waiting on you.\n")
        print("WHAT MUST BECOME TRUE")
        for f in preconditions:
            print(f"{f.id} — {f.title}")
            # The slug IS the precondition -- it is the only place the entry says
            # what must become true. Printing the title and `Where` without it
            # told Felix to "clear this precondition" while naming none of them:
            # `felix-sentry-permission` read as an unexplained instruction to go
            # fix something in a file path.
            print(f"  waits on: {f.blocked}")
            where_lines = [
                line
                for line in _unfenced_body(f).splitlines()
                if line.lstrip().startswith("* **Where:**")
            ]
            for line in where_lines:
                print(f"  {line}")
            if not where_lines:
                print("  * **Where:** (not stated)")
            print("  No answer is requested; clear this precondition.")
            print()
    if answered:
        _render_answered_text(answered)
    if waiting:
        print(
            "To answer: run the /decide skill in any terminal, during a drain or not."
        )
    if preconditions:
        print("To clear: make the listed precondition true; no answer is needed.")
    return 0


def _find_entry_span(
    lines: list[str], fence_states: list[FenceState], header_index: int
) -> int:
    """Index one past the last body line of the entry whose header is at `header_index`.

    Stops at the next parser boundary or thematic break that is not inside a
    fence — a fenced snippet may legitimately contain a `### ` line — then backs
    over trailing blanks so an inserted bullet lands against the body, not after a
    gap.
    """
    end = len(lines)
    for index in range(header_index + 1, len(lines)):
        if fence_states[index] is not FenceState.OUTSIDE:
            continue
        if (
            lines[index].startswith("# ")
            or lines[index].startswith("## ")
            or lines[index].startswith(ENTRY_MARKER)
            or HRULE_RE.match(lines[index])
        ):
            end = index
            break
    while end > header_index + 1 and not lines[end - 1].strip():
        end -= 1
    return end


def _answer_target_spans(
    lines: list[str],
    fence_states: list[FenceState],
    ids: Collection[str],
) -> dict[str, tuple[int, int, re.Match[str]]]:
    """Locate answer targets with the same parser boundaries as the ledger."""
    wanted = set(ids)
    text = "\n".join(lines)
    _source, headers, _orphans = _unfenced_header_matches(text, fence_states)
    spans: dict[str, tuple[int, int, re.Match[str]]] = {}
    for _heading_index, header_index, match in headers:
        identifier = match.group("id")
        if identifier in wanted and identifier not in spans:
            spans[identifier] = (
                header_index,
                _find_entry_span(lines, fence_states, header_index),
                match,
            )
    return spans


def _decision_heading_matches(
    text: str, *, include_pending: bool = False
) -> tuple[list[str], list[tuple[int, re.Match[str]]]]:
    """Return real decision headings, optionally including pending headings."""
    lines = text.splitlines()
    mask = _fence_mask(lines)
    matches: list[tuple[int, re.Match[str]]] = []
    for index, line in enumerate(lines):
        if mask[index] is not FenceState.OUTSIDE:
            continue
        match = DECISION_RE.match(line)
        if match is None and include_pending:
            match = DECISION_PENDING_RE.match(line)
        if match is not None:
            matches.append((index, match))
    return lines, matches


def _decision_heading_locations(
    text: str, *, include_pending: bool = False
) -> tuple[list[str], list[tuple[int, int, re.Match[str]]]]:
    """Adapt decision headings to the shared pending-id allocator interface."""
    lines, matches = _decision_heading_matches(text, include_pending=include_pending)
    return lines, [(index, index, match) for index, match in matches]


def _decision_clause_one_issues(entry: str) -> list[str]:
    """Report clause-1 fields missing from decisions in one recording input."""
    lines, headings = _decision_heading_matches(entry, include_pending=True)
    fence_states = _fence_mask(lines)
    issues: list[str] = []
    for position, (heading_index, match) in enumerate(headings):
        end = headings[position + 1][0] if position + 1 < len(headings) else len(lines)
        body = chr(10).join(
            line
            for index, line in enumerate(
                lines[heading_index + 1 : end], heading_index + 1
            )
            if fence_states[index] is FenceState.OUTSIDE
        )
        missing = [
            field
            for field in DECISION_CLAUSE_ONE_FIELDS
            if DECISION_FIELD_RE[field].search(body) is None
        ]
        if missing:
            issues.append(
                f"### {match.group('id')} — {match.group('question')} is missing "
                "clause 1 field(s): " + ", ".join(missing)
            )
        # The trailer is not decoration. `set-trailer` can ADD one to an entry
        # that predates the requirement, but that is a repair for history, not a
        # licence to keep writing entries without it: the added bullet records
        # the supersession without recording who decided the entry, because that
        # is no longer recoverable at supersession time. A new record can carry
        # both, so it must. `check` does not read the trailer either, so the
        # writer is the only place this can be caught. Measured 2026-09-09:
        # d-20260909-05 and -06 were recorded without it and passed every gate.
        if SUPERSEDED_BY_RE.search(body) is None:
            issues.append(
                f"### {match.group('id')} — {match.group('question')} is missing "
                "the `* **Decided by:** <session/run> · **Superseded-by:** -` "
                "trailer; `set-trailer` would have to repair this entry later, "
                "and by then the decider is unrecoverable"
            )
        if GOVERNS_RE.search(body) is None:
            issues.append(
                f"### {match.group('id')} — {match.group('question')} is missing "
                "the `* **Governs:**` bullet; write the finding ids it governs, "
                "or `-`"
            )
    return issues


def _read_mutation_input(path: Path) -> tuple[bytes, str]:
    """Read exact input bytes and decode UTF-8 without normalising newlines."""
    try:
        raw = path.read_bytes()
        return raw, raw.decode("utf-8")
    except (OSError, UnicodeError) as exc:
        raise LedgerError(f"could not read input file {path}: {exc}") from exc


def _with_final_newline(text: str, lines: list[str]) -> str:
    """Join changed lines while preserving the original file's newline policy."""
    joined = "\n".join(lines)
    return joined + ("\n" if text.endswith("\n") else "")


def _checked_header_value(header_field: str, value: str) -> str:
    """Validate a header field before embedding it into the ledger line."""
    if header_field == "Blocked":
        if value != "none" and SLUG_RE.match(value) is None:
            raise LedgerError(f"--blocked must be 'none' or a slug, not {value!r}")
    elif header_field == "Root":
        if value != "-" and SLUG_RE.match(value) is None:
            raise LedgerError(f"--root must be '-' or a slug, not {value!r}")
    elif header_field == "Status" and value not in STATUSES:
        raise LedgerError(f"--status must be one of {sorted(STATUSES)}, not {value!r}")
    elif header_field == "Entry" and value not in ENTRIES:
        raise LedgerError(f"--entry must be one of {sorted(ENTRIES)}, not {value!r}")
    return value


def _answerable_header_change_refusal(
    findings: list[Finding],
    finding_id: str,
    *,
    blocked: str | None,
    status: str | None,
) -> str | None:
    """Refuse a set-header change that would bypass an answerable blocker."""
    target = next((finding for finding in findings if finding.id == finding_id), None)
    if target is None:
        return None
    if target.blocked not in ANSWERABLE_BLOCKERS:
        return None
    blocked_change = blocked is not None and blocked not in ANSWERABLE_BLOCKERS
    status_close = status in {"handled", "rejected"}
    if not (blocked_change or status_close):
        return None
    return (
        f"cannot clear answerable blocker {target.blocked} with set-header; "
        "answer it through /decide"
    )


def _raise_to_build_refusal(
    findings: list[Finding], finding_id: str, *, entry: str | None
) -> str | None:
    """Refuse a pickup raise to `build` on an entry that names no open question.

    The same gate as filing, at the other door. Use `set-header --entry build
    --note-file FILE` to supply the `**Open question:**` bullet with the raise.
    Lowering a tier is never gated by this.
    """
    if entry != "build":
        return None
    for finding in findings:
        if finding.id != finding_id:
            continue
        if finding.entry == "build":
            return None
        if OPEN_QUESTION_RE.search(_unfenced_body(finding)):
            return None
        return (
            OPEN_QUESTION_REFUSAL.format(where=finding_id)
            + " Supply that bullet with --note-file when setting the header."
        )
    return None


def cmd_set_header(args: argparse.Namespace) -> int:
    """Update selected fields on one real finding header under the ledger lock."""
    findings, _problems, _vocabulary = parse(args.ledger)
    refusal = _answerable_header_change_refusal(
        findings,
        args.id,
        blocked=args.blocked,
        status=args.status,
    )
    if refusal is not None:
        print(refusal, file=sys.stderr)
        return 1

    note_path = getattr(args, "note_file", None)
    raise_refusal = (
        _raise_to_build_refusal(findings, args.id, entry=args.entry)
        if note_path is None else None
    )
    if raise_refusal is not None:
        print(raise_refusal, file=sys.stderr)
        return 1

    changes = {
        "Status": args.status,
        "Blocked": args.blocked,
        "Root": args.root,
        "Entry": args.entry,
    }
    expected_header = {
        field.lower(): value
        for field, value in changes.items()
        if value is not None
    }
    _register_ledger_commit(
        f"docs(findings): set header for {args.id}",
        [args.id],
        _finding_header_postcondition(args.id, expected_header),
    )

    def build(text: str) -> str:
        current_findings, _problems, _vocabulary = _parse_text(text, args.ledger)
        current_refusal = _answerable_header_change_refusal(
            current_findings,
            args.id,
            blocked=args.blocked,
            status=args.status,
        )
        if current_refusal is not None:
            raise LedgerError(current_refusal)
        current_raise_refusal = _raise_to_build_refusal(
            current_findings, args.id, entry=args.entry
        )
        if current_raise_refusal is not None:
            raise LedgerError(current_raise_refusal)
        lines, index = _locate_finding_header(text, args.id)
        line = lines[index]
        for header_field, value in changes.items():
            if value is None:
                continue
            checked = _checked_header_value(header_field, value)
            pattern = rf"(\*\*{header_field}:\*\* )\S+"
            match = re.search(pattern, line)
            if match is None:
                raise LedgerError(
                    f"header for {args.id} carries no {header_field} field to update"
                )
            line = (
                line[: match.start()] + match.group(1) + checked + line[match.end() :]
            )
        lines[index] = line
        for receipt_line, refreshed in _close_receipt_updates(
            text, args.id, line, args.ledger
        ).items():
            lines[receipt_line] = refreshed
        return _with_final_newline(text, lines)

    if note_path is not None:
        return _mutate_finding_note(
            args, command="set-header", note_path=note_path,
            header_mutation=build,
            header_changes={
                field: value for field, value in changes.items() if value is not None
            },
        )
    _locked_ledger_mutation(args.ledger, build)
    if args.status in {"handled", "rejected"}:
        append_drain_breadcrumb(f"step 10 finding closed {args.id}", args.status)
    print(f"updated header for {args.id}{_written_ledger_suffix(args.ledger)}")
    return 0


def _annotation_refusal(annotation: str, target: Finding, source: Path) -> str | None:
    """Describe an unfenced annotation line that must not enter the ledger."""
    lines = annotation.splitlines()
    fence_states = _fence_mask(lines)
    for line, fence_state in zip(lines, fence_states, strict=True):
        if fence_state is not FenceState.OUTSIDE:
            continue

        if _effective_follow_up_enabled() and EFFECTIVE_FOLLOW_UP_MARKER_RE.match(line):
            directive = EFFECTIVE_FOLLOW_UP_RE.fullmatch(line)
            if directive is None or _effective_follow_up_ids(directive.group("ids")) is None:
                return (
                    f"{source} contains a malformed Effective Follow-up of directive. "
                    "Use '* **Effective Follow-up of:** -' to clear ancestry or a "
                    "comma-separated list of f-YYYYMMDD-nn ids to replace it."
                )

        if _has_ledger_meta_comment(line):
            return (
                f"{source} contains reserved ledger-meta syntax; refusing it "
                "because mutation inputs cannot supply ledger metadata"
            )

        if line.startswith("# "):
            boundary = "a top-level '# ' heading"
        elif line.startswith("## "):
            boundary = "a '## ' date-section heading"
        elif line.startswith(ENTRY_MARKER):
            boundary = "an '### ' finding heading"
        elif HRULE_RE.match(line):
            boundary = "a thematic break matching HRULE_RE"
        else:
            boundary = None
        if boundary is not None:
            return (
                f"{source} contains an unfenced {boundary}; refusing it because it "
                "would restructure the ledger. Put quoted structure inside a fenced "
                "block instead."
            )

        marker = _answer_evidence_marker(line)
        if marker is not None:
            return (
                f"{source} contains unfenced '{marker}' answer evidence; refusing it "
                "because annotate cannot forge Felix's answer. Only apply-answers "
                "may write it."
            )
    return None


def _needs_blank_before_block(
    lines: list[str], insertion: int, block: list[str]
) -> bool:
    """Whether a block appended at `insertion` must be separated by a blank line.

    Two commands append into an entry — `annotate` and `set-trailer` — and both
    need this answer, so it is asked once. Without a blank line a block joins the
    paragraph above it and renders as part of it; every hand-written closure note
    in the ledger has the blank line, and `annotate` was silently producing a
    different shape than the file's own convention until it got one.

    The exception is one list item landing after another: a blank line there makes
    the whole list LOOSE, so every existing item grows a paragraph gap. **A wrapped
    bullet's continuation counts as being inside the list.** The decisions ledger
    holds such a bullet (`d-20260904-20`, whose `Decided by` runs to a second,
    indented line), and reading only the immediately preceding line would call it a
    paragraph and loosen the list it belongs to.
    """
    if insertion <= 0 or not block or not block[0].strip():
        return False
    previous = lines[insertion - 1]
    if not previous.strip():
        return False
    if not BULLET_LINE_RE.match(block[0]):
        return True
    index = insertion - 1
    while index > 0 and CONTINUATION_LINE_RE.match(lines[index]):
        index -= 1
    return not BULLET_LINE_RE.match(lines[index])


def _written_ledger_suffix(path: Path) -> str:
    """Name the written ledger for callers receiving strict reporting."""
    return f" in {os.path.abspath(path)}" if _strict_reporting_enabled() else ""


def _mutate_finding_note(
    args: argparse.Namespace,
    *,
    command: Literal["annotate", "close", "set-header"],
    note_path: Path,
    status: str | None = None,
    header_mutation: Callable[[str], str] | None = None,
    header_changes: dict[str, str] | None = None,
) -> int:
    """Append a validated note, optionally changing the same entry's header."""
    if status is not None:
        findings, _problems, _vocabulary = parse(args.ledger)
        refusal = _answerable_header_change_refusal(
            findings, args.id, blocked=None, status=status
        )
        if refusal is not None:
            print(refusal, file=sys.stderr)
            return 1

    raw_note, note = _read_mutation_input(note_path)
    if not any(line.strip() for line in note.splitlines()):
        raise LedgerError(f"{note_path} contains no content to annotate")
    request = _mutation_request(
        command, args.id, raw_note, None, getattr(args, "request_id", None),
        header_changes=header_changes,
    )

    def build(
        text: str,
    ) -> tuple[str, list[str], list[str]] | tuple[
        str, list[str], list[str], dict[str, object]
    ]:
        lines, index = _locate_finding_header(text, args.id)
        findings, _problems, _vocabulary = _parse_text(text, args.ledger)
        target = next((finding for finding in findings if finding.id == args.id), None)
        if target is None:
            raise LedgerError(f"finding id {args.id} is not present in the ledger")
        if status is not None:
            refusal = _answerable_header_change_refusal(
                findings, args.id, blocked=None, status=status
            )
            if refusal is not None:
                raise LedgerError(refusal)
        refusal = _annotation_refusal(note, target, note_path)
        if refusal is not None:
            raise LedgerError(refusal)
        closing_status = (
            header_changes.get("Status") if header_changes is not None else status
        )
        if (
            closing_status == "handled"
            and "Still open" in _unfenced_text(note)
        ):
            raise LedgerError(
                f"{args.id} (line {target.line}): status is 'handled' but the "
                "closing note still says 'Still open' — "
                "split the open part into its own finding"
            )

        header_line: str | None = None
        if status is not None:
            header_line = lines[index]
            status_match = re.search(r"(\*\*Status:\*\* )\S+", header_line)
            if status_match is None:
                raise LedgerError(
                    f"header for {args.id} carries no Status field to update"
                )
            header_line = (
                header_line[: status_match.start()]
                + status_match.group(1)
                + status
                + header_line[status_match.end() :]
            )
            lines[index] = header_line
            for receipt_line, refreshed in _close_receipt_updates(
                text, args.id, header_line, args.ledger
            ).items():
                lines[receipt_line] = refreshed

        effect = note.splitlines()
        end = _find_entry_span(lines, _fence_mask(lines), index)
        block = list(effect)
        if _needs_blank_before_block(lines, end, block):
            block.insert(0, "")
        lines[end:end] = block
        candidate = _with_final_newline(text, lines)
        end += len(block)
        if header_mutation is not None:
            mutated = header_mutation(candidate)
            if len(mutated.splitlines()) != len(candidate.splitlines()):
                raise LedgerError("header mutation changed the entry's line count")
            candidate = mutated
            lines, index = _locate_finding_header(candidate, args.id)
            header_line = lines[index]
        lines[end:end] = [RECEIPT_PLACEHOLDER]
        candidate = _with_final_newline(candidate, lines)
        if _strict_reporting_enabled():
            candidate_findings, _problems, _vocabulary = _parse_text(
                candidate, args.ledger
            )
            candidate_target = next(
                finding for finding in candidate_findings if finding.id == args.id
            )
            admission_issues = _impact_admission_issues(
                candidate_target, f"{args.id} (line {candidate_target.line})"
            )
            if admission_issues:
                raise LedgerError("\n".join(admission_issues))

        receipt_postcondition = _receipt_postcondition(
            command=command,
            operation=request.operation,
            results=[args.id],
            decisions=False,
        )
        if header_line is not None:
            status_postcondition = _finding_header_postcondition(
                args.id,
                {field.lower(): value for field, value in header_changes.items()}
                if header_changes is not None else {"status": status},
            )

            def close_postcondition(
                findings_path: Path, decisions_path: Path
            ) -> bool:
                return status_postcondition(
                    findings_path, decisions_path
                ) and receipt_postcondition(findings_path, decisions_path)

            postcondition = close_postcondition
        else:
            postcondition = receipt_postcondition
        _register_ledger_commit(
            f"docs(findings): {command} {args.id}",
            [args.id],
            postcondition,
        )
        if header_line is None:
            return candidate, [args.id], effect
        return (
            candidate,
            [args.id],
            effect,
            {
                "header_sha256": _sha256_text(header_line),
                "header_status": HEADER_RE.match(header_line).group("status"),
            },
        )

    _locked_receipted_mutation(args.ledger, request, build)
    if command == "close":
        append_drain_breadcrumb(f"step 10 finding closed {args.id}", "handled")
        print(
            f"closed {args.id} with note from {note_path}"
            f"{_written_ledger_suffix(args.ledger)}"
        )
    elif command == "set-header":
        if args.status in {"handled", "rejected"}:
            append_drain_breadcrumb(f"step 10 finding closed {args.id}", args.status)
        print(
            f"updated header for {args.id} with note from {note_path}"
            f"{_written_ledger_suffix(args.ledger)}"
        )
    else:
        print(
            f"annotated {args.id} from {note_path}"
            f"{_written_ledger_suffix(args.ledger)}"
        )
    return 0


def cmd_annotate(args: argparse.Namespace) -> int:
    """Insert a file's lines into one finding entry under the ledger lock."""
    return _mutate_finding_note(
        args, command="annotate", note_path=args.file
    )


def cmd_close(args: argparse.Namespace) -> int:
    """Mark one finding handled and append its closing note under one receipt."""
    return _mutate_finding_note(
        args, command="close", note_path=args.note_file, status="handled"
    )


def _append_decision_entry(ledger_text: str, entry: str, section: str | None) -> str:
    """Append decision text, reusing a matching tail section when requested."""
    base = ledger_text.rstrip()
    label = (
        section
        or f"{datetime.now().astimezone():%Y-%m-%d} — recorded through the decisions lock"
    )
    lines, _matches = _decision_heading_matches(base, include_pending=True)
    mask = _fence_mask(lines)
    last_section = next(
        (
            line
            for index, line in reversed(list(enumerate(lines)))
            if mask[index] is FenceState.OUTSIDE and line.startswith("## ")
        ),
        None,
    )
    if last_section == f"## {label}":
        return base + "\n\n" + entry.strip() + "\n"
    return base + "\n\n" + f"## {label}" + "\n\n" + entry.strip() + "\n"


SECTION_LINE_SEPARATOR_RE = re.compile(r"[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]")


def _check_decision_section(section: str | None) -> None:
    """Reject section labels that could inject another ledger line."""
    if section is not None and SECTION_LINE_SEPARATOR_RE.search(section) is not None:
        raise LedgerError(
            "--section must be a single-line label without control line separators"
        )


def cmd_record_decision(args: argparse.Namespace) -> int:
    """Append pending decisions through the decisions ledger's writer lock."""
    _check_decision_section(args.section)
    raw_entry, entry = _read_mutation_input(args.file)
    input_metadata, input_meta_issues = _scan_ledger_metadata(entry, args.file)
    if input_meta_issues:
        raise LedgerError("invalid ledger metadata in decision input:\n" + "\n".join(input_meta_issues))
    if any(
        meta.data.get("kind") == MUTATION_RECEIPT_KIND
        for meta in input_metadata
    ):
        raise LedgerError(
            f"{args.file} contains reserved mutation-receipt metadata; "
            "mutation inputs cannot supply replay evidence"
        )
    _lines, pending = _decision_heading_matches(entry, include_pending=True)
    if not any(match.group("id") == PENDING_DECISION_ID for _, match in pending):
        raise LedgerError(
            f"{args.file} must contain at least one ### {PENDING_DECISION_ID} heading"
        )
    clause_one_issues = _decision_clause_one_issues(entry)
    if clause_one_issues:
        raise LedgerError(
            f"{args.file} decision entries must include tasks/decisions.md clause 1 "
            "fields (Question, Chosen, Rejected, Reason):"
            + chr(10)
            + chr(10).join(clause_one_issues)
        )
    request = _mutation_request(
        "record-decision",
        "decisions-ledger",
        raw_entry,
        args.section,
        getattr(args, "request_id", None),
    )
    date = f"{datetime.now().astimezone():%Y%m%d}"

    def build(text: str) -> tuple[str, list[str], list[str]]:
        taken = {
            match.group("id")
            for _index, match in _decision_heading_matches(text)[1]
        }
        taken.update(_clone_allocation_ids(allocation_root, args.decisions))
        rewritten, minted = _allocate_pending(
            entry,
            "d",
            date,
            taken,
            PENDING_DECISION_ID,
            lambda value: _decision_heading_locations(value, include_pending=True),
        )
        if PENDING_DECISION_ID in rewritten:
            raise LedgerError(f"{PENDING_DECISION_ID} survived decision id allocation")
        effect = rewritten.strip().splitlines()
        candidate = _append_decision_entry(text, rewritten, args.section)
        with _candidate_scratch(candidate, args.decisions) as scratch:
            _resolved, citation_issues = _citation_resolution(args.ledger, scratch)
        if citation_issues:
            raise LedgerError(
                "\nFAIL ".join(
                    issue.replace(str(scratch), str(args.decisions))
                    for issue in citation_issues
                )
            )
        candidate = candidate.rstrip() + "\n" + RECEIPT_PLACEHOLDER + "\n"
        _register_ledger_commit(
            f"docs(decisions): record {' '.join(minted)}",
            minted,
            _receipt_postcondition(
                command="record-decision",
                operation=request.operation,
                results=minted,
                decisions=True,
            ),
        )
        return candidate, minted, effect

    with _clone_id_allocation_scope(
        args.decisions, explicit=_explicit_allocation_paths(args),
    ) as allocation_root:
        allocated = _locked_receipted_mutation(args.decisions, request, build)
    print(
        f"recorded decision(s) as {' '.join(allocated)}"
        f"{_written_ledger_suffix(args.decisions)}"
    )
    return 0


def cmd_set_trailer(args: argparse.Namespace) -> int:
    """Set supersession references and refresh covering receipts atomically.

    An entry that predates the trailer requirement has the bullet ADDED rather
    than being refused; see the insertion branch for why it is added bare.
    """
    args.ledger = _canonical_ledger_path(args.ledger)
    args.decisions = _canonical_ledger_path(args.decisions)
    # `-` alone is the documented unsuperseded state, so a mistaken supersession
    # can be reverted through the same receipted write that made it.
    clearing = args.superseded_by in (["-"], ["`-`"])
    references = [] if clearing else args.superseded_by
    if any(re.fullmatch(DECISION_REFERENCE_PATTERN, ref) is None for ref in references):
        raise LedgerError("--superseded-by requires decision references, or `-` alone to clear")
    written = ", ".join(references) or "-"
    identities = [ref.removeprefix("local:") for ref in references]
    if len(set(identities)) != len(identities):
        raise LedgerError("--superseded-by contains duplicate references")
    with _ledger_mutation_scope(args.decisions) as original:
        metadata = _validated_mutation_metadata(original, args.decisions)
        lines, headings = _decision_heading_matches(original)
        targets = [index for index, match in headings if match.group("id") == args.id]
        if len(targets) != 1:
            raise LedgerError(f"expected exactly one decision {args.id}; found {len(targets)}")
        known = {match.group("id") for _, match in headings}
        for ref in references:
            owner, separator, identifier = ref.rpartition(":")
            if not separator or owner == "local":
                if identifier == args.id:
                    raise LedgerError("a decision cannot supersede itself")
                if identifier not in known:
                    raise LedgerError(f"replacement decision {ref} does not exist locally")
        mask = _fence_mask(lines)
        start = targets[0]
        end = min(
            _find_entry_span(lines, mask, start),
            next((index for index, _ in headings if index > start), len(lines)),
        )
        # Identity for the replace path: nothing is inserted, so `shifted` below
        # never moves an index. Set here rather than in the branch so the closure
        # cannot read an unbound name when no insertion happens.
        inserted_at, inserted_count = len(lines), 0
        trailers = []
        for index in range(start + 1, end):
            if mask[index] is not FenceState.OUTSIDE:
                continue
            masked_line = _mask_inline_code_spans(lines[index])
            for marker in SUPERSEDED_BY_MARKER_RE.finditer(masked_line):
                trailers.append((index, SUPERSEDED_BY_RE.match(masked_line, marker.start())))
        if not trailers:
            # The trailer became a requirement partway through the ledger's life,
            # so the entries written before it were unreachable by the one command
            # allowed to route a superseded decision forward — and hand-editing is
            # barred, because it takes no lock while `merge-inbox` may hold one.
            # Measured in Korrigio 2026-09-21: 598 of 707 entries, back to
            # `d-20260816-01`. Appending the bullet is inside what this command
            # already does; it holds the ledger lock and has validated both ids.
            #
            # A bare `**Superseded-by:**` bullet, not the canonical
            # `**Decided by:** … · **Superseded-by:** …` pair: who decided an entry
            # that never recorded it is not recoverable here, and inventing a
            # decider would write a false attribution into the very ledger whose
            # attributions the rules exist to protect. `load_decisions` reads the
            # trailer per line, so a standalone bullet supersedes exactly as the
            # paired form does.
            #
            # The bullet goes BEFORE the entry's trailing receipt line, not after
            # it: a `record-decision` receipt is the last line of the batch it
            # covers, and a bullet appended past it would read as belonging to
            # nothing. That puts the insertion inside a covering effect window,
            # which the loop below repairs — see `shifted`.
            insertion = end
            while insertion > start + 1 and (
                not lines[insertion - 1].strip()
                or lines[insertion - 1].startswith(LEDGER_META_PREFIX)
            ):
                insertion -= 1
            addition = [f"* **Superseded-by:** {written}"]
            if _needs_blank_before_block(lines, insertion, addition):
                addition.insert(0, "")
            lines[insertion:insertion] = addition
            inserted_at, inserted_count = insertion, len(addition)
            changed = set(range(insertion, insertion + inserted_count))
        elif len(trailers) != 1 or trailers[0][1] is None:
            raise LedgerError(f"decision {args.id} requires exactly one valid Superseded-by trailer")
        else:
            index, match = trailers[0]
            assert match is not None
            lines[index] = (
                lines[index][:match.start("refs")]
                + written
                + lines[index][match.end("refs"):]
            )
            changed = {index}
        # A record-decision receipt can cover a whole batch. Refresh its entire
        # effect, keeping operation/input identity so the original append replays.
        # Process in file order in case a covering effect contains earlier metadata.
        #
        # `metadata` was scanned from the ORIGINAL text, so every index it carries
        # has to be moved across the insertion before it means anything in `lines`.
        # A batch receipt sits after the last entry it covers, so adding a trailer
        # to any earlier entry of that batch lands inside the hashed effect and
        # widens it by exactly the inserted lines. Leaving `effect_lines` alone
        # would rehash a window sliding off the front of its own effect.
        def shifted(index: int) -> int:
            return index + inserted_count if index >= inserted_at else index

        for meta in metadata:
            if meta.data.get("kind") != MUTATION_RECEIPT_KIND:
                continue
            receipt_index = shifted(meta.line - 1)
            effect_start = shifted(meta.line - 1 - cast(int, meta.data["effect_lines"]))
            if not any(effect_start <= line < receipt_index for line in changed):
                continue
            data = dict(meta.data)
            data["effect_lines"] = receipt_index - effect_start
            data["effect_sha256"] = _sha256_text("\n".join(lines[effect_start:receipt_index]))
            lines[receipt_index] = _metadata_line(data)
            changed.add(receipt_index)
        candidate = "\n".join(lines) + ("\n" if original.endswith("\n") else "")
        issues = _validate_text(candidate, args.decisions)
        # Entry ids are unchanged, so resolution may use the on-disk id set,
        # but must inspect the candidate lines and their citation-context hashes.
        _resolved, citation_issues = _citation_resolution(
            args.ledger, args.decisions, decision_text=candidate
        )
        issues += citation_issues
        if issues:
            raise LedgerError("the mutation would leave the ledger invalid:\n" + "\n".join(issues))
        if candidate == original:
            _fsync_directory(args.decisions.parent)
        else:
            _register_ledger_commit(
                f"docs(decisions): set trailer for {args.id}",
                [args.id, *references],
                _decision_trailer_postcondition(args.id, references),
            )
            _write_if_unchanged(args.decisions, original, candidate, durable_directory=True)
    print(
        f"set {args.id} Superseded-by: {written}"
        f"{_written_ledger_suffix(args.decisions)}"
    )
    return 0


def _decision_bullet(
    answer: str, fence_states: list[FenceState] | None = None
) -> list[str] | None:
    """The whole `**Decision made:**` bullet, continuation lines included.

    Deliberately not a regex capture. `.*` stops at the first newline, and the
    answering skill writes Felix's reasoning as a wrapped bullet — so a one-line
    capture keeps the letter he chose and silently drops the sentence saying
    *why*, which is the half a later session needs when the decision is
    questioned again. The spool file is unlinked immediately afterwards, so that
    loss is permanent and invisible: validation passes and the run reports
    success.
    """
    lines = answer.splitlines()
    if fence_states is None:
        fence_states = _fence_mask(lines)
    bullets = _decision_bullets(lines, fence_states)
    return bullets[0] if bullets else None


def _decision_bullets(
    lines: list[str],
    fence_states: list[FenceState],
    start: int = 0,
    end: int | None = None,
) -> list[list[str]]:
    """Reconstruct every unfenced decision bullet, including wrapped lines."""
    if end is None:
        end = len(lines)
    bullets: list[list[str]] = []
    index = start
    while index < end:
        if (
            fence_states[index] is not FenceState.OUTSIDE
            or (match := DECISION_BULLET_RE.match(lines[index])) is None
        ):
            index += 1
            continue
        bullet = ["* " + match.group("decision").rstrip()]
        continuation = index + 1
        while continuation < end:
            line = lines[continuation]
            if (
                fence_states[continuation] is not FenceState.OUTSIDE
                or not line.strip()
                or not line[:1].isspace()
            ):
                break
            bullet.append(line.rstrip())
            continuation += 1
        bullets.append(bullet)
        index = continuation
    return bullets


def _parse_answer_contents(
    answer: str, answer_lines: list[str], answer_fence_states: list[FenceState]
) -> tuple[str, list[str]] | None:
    """Parse one answer's contents into its id and complete decision payload."""
    ids = [
        match.group("id")
        for line, fence_state in zip(answer_lines, answer_fence_states, strict=True)
        if fence_state is FenceState.OUTSIDE
        and (match := ANSWER_ID_RE.match(line)) is not None
    ]
    decision_matches = [
        match
        for line, fence_state in zip(answer_lines, answer_fence_states, strict=True)
        if fence_state is FenceState.OUTSIDE
        and (match := DECISION_BULLET_RE.match(line)) is not None
    ]
    bullet = _decision_bullet(answer, answer_fence_states)
    if len(ids) != 1 or bullet is None or len(decision_matches) != 1:
        return None
    return ids[0], bullet


def _parse_answer_file(path: Path) -> tuple[str, list[str]] | None:
    """Parse one claimed answer into its id and complete decision payload."""
    answer = path.read_text(encoding="utf-8")
    answer_lines = answer.splitlines()
    answer_fence_states = _fence_mask(answer_lines)
    return _parse_answer_contents(answer, answer_lines, answer_fence_states)


def _errno_name(exc: OSError) -> str:
    """Return a stable errno label for filesystem diagnostics."""
    return (
        errno.errorcode.get(exc.errno, str(exc.errno))
        if exc.errno is not None
        else "unknown errno"
    )


def _probe_answers_spool(spool: Path) -> None:
    """Raise when an answers spool exists but cannot be consumed safely."""
    try:
        spool_mode = os.lstat(spool).st_mode
    except FileNotFoundError as exc:
        if _entry_state(spool) != _ENTRY_BROKEN:
            return
        errno_name = _errno_name(exc)
        raise LedgerError(
            f"could not inspect answers spool {spool} ({errno_name}): {exc}"
        ) from exc
    except OSError as exc:
        errno_name = _errno_name(exc)
        raise LedgerError(
            f"could not inspect answers spool {spool} ({errno_name}): {exc}"
        ) from exc
    if not stat.S_ISDIR(spool_mode):
        raise LedgerError(
            f"answers spool {spool} exists but is not a directory; an answer "
            "written there will never be read"
        )
    try:
        with os.scandir(spool) as entries:
            next(entries, None)
    except OSError as exc:
        errno_name = _errno_name(exc)
        raise LedgerError(
            f"could not enumerate answers spool {spool} ({errno_name}): {exc}"
        ) from exc


def _refuse_unapplied_answers(spool: Path) -> None:
    """Refuse answer consumption while quarantined answers need resolution."""
    unapplied = sorted(spool.glob("*.unapplied"))
    if unapplied:
        names = ", ".join(path.name for path in unapplied)
        raise LedgerError(
            f"answers spool {spool} contains unapplied answer file(s): {names}; "
            "resolve them before applying more answers"
        )


def _answer_ids_in_path(path: Path) -> set[str]:
    """Read answer ids from one spool or claim file for duplicate detection."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return set()
    lines = text.splitlines()
    states = _fence_mask(lines)
    return {
        match.group("id")
        for line, state in zip(lines, states, strict=True)
        if state is FenceState.OUTSIDE
        and (match := ANSWER_ID_RE.match(line)) is not None
    }


def _answer_target_finding(ledger: Path, identifier: str) -> Finding:
    findings, problems, vocabulary = parse(ledger)
    issues = validate(findings, problems, vocabulary)
    if issues:
        raise LedgerError(
            f"the findings ledger does not validate: {'; '.join(issues)}"
        )
    target = next((finding for finding in findings if finding.id == identifier), None)
    if target is None:
        raise LedgerError(f"finding id {identifier} is not present in the ledger")
    return target


def _cmd_answer(args: argparse.Namespace) -> int:
    """Publish one authenticated answer without touching either ledger."""
    target = _answer_target_finding(args.ledger, args.id)
    blocker_class = classify_blocker(target.blocked)
    actor = str(getattr(args, "actor", "")).strip()
    reason = str(getattr(args, "reason", "")).strip()
    decision = getattr(args, "decision", None)
    if not actor:
        raise LedgerError("--actor is required")
    if blocker_class == BLOCKER_ANSWERABLE:
        if not isinstance(decision, str) or not decision.strip():
            raise LedgerError("felix-decision answers require --decision")
        choice = decision.strip()
    else:
        raise LedgerError(
            f"finding {target.id} is not answerable (blocker={target.blocked})"
        )
    if not reason:
        reason = "Answer recorded through the findings answer route."
    answer = (
        f"* **ID:** {target.id}\n\n"
        f"* **Decision made:** {choice} — {actor}: {reason}\n"
    )
    spool: Path = args.answers
    claim = spool.with_name(f"{spool.name}.claim")
    with _publish_lock(publish_lock_path(spool)):
        spool.mkdir(parents=True, exist_ok=True)
        candidates = list(spool.glob("*.md")) + list(spool.glob(".*.part"))
        if _entry_exists(claim, directory=True):
            if not claim.is_dir():
                raise LedgerError(
                    f"answers claim {claim} exists but is not a directory"
                )
            candidates += list(claim.glob("*.md"))
        for path in candidates:
            if target.id in _answer_ids_in_path(path):
                raise LedgerError(
                    f"finding {target.id} already has an answer in {path}; "
                    "refusing a duplicate decision answer"
                )
        part = spool / f".{_publish_stamp()}-{_unique_suffix()}.part"
        candidate = spool / f"{_publish_stamp()}-{_unique_suffix()}.md"
        _atomic_write(part, answer, durable_directory=True)
        try:
            os.link(part, candidate)
            _fsync_directory(spool)
        except OSError as exc:
            raise LedgerError(f"could not publish answer to {spool}: {exc}") from exc
        finally:
            part.unlink(missing_ok=True)
        _fsync_directory(spool)
    print(f"published answer for {target.id}: {candidate}")
    return 0


def cmd_answer(args: argparse.Namespace) -> int:
    """CLI answer wrapper with a typed usage/refusal status."""
    try:
        return _cmd_answer(args)
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 2


def cmd_apply_answers(args: argparse.Namespace) -> int:
    """Fold answers through the shared locked mutation pipeline."""
    spool: Path = args.answers
    try:
        kept_ids = _manual_repair_answers_claim_ids(spool)
    except LedgerReadRefused:
        raise
    except LedgerError as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    if kept_ids:
        print(
            "FAIL answers claim kept for manual repair: " + ",".join(kept_ids),
            file=sys.stderr,
        )
        return MANUAL_REPAIR_RETURN_CODE

    hold_consumer_lock = bool(getattr(args, "hold_consumer_lock", False))
    if hold_consumer_lock:
        consumer_fd, consumer_lock, consumer_error = _try_consumer_lock(
            _drain_lock_ledger(args)
        )
        if consumer_error is not None:
            print(f"FAIL {consumer_error}", file=sys.stderr)
            return 2
        if consumer_fd is None:
            print(
                f"consumer lock {consumer_lock} is held by the drain; retry after it "
                "finishes",
                file=sys.stderr,
            )
            return 75
        args._consumer_lock_fd = consumer_fd
    claim = spool.with_name(f"{spool.name}.claim")
    decisions = _args_decisions(args)
    # Before the deferred preconditions, which commit pending ledger dirt.
    _refuse_controller_export_at(args.ledger, "apply-answers")
    mode = _claim_finalisation_mode(
        args.ledger, merge_without_intent=_ACTIVE_LEDGER_COMMIT is None
    )
    if mode == "deferred":
        _deferred_preconditions(args.ledger, decisions)
        if (
            not hold_consumer_lock
            and _ACTIVE_LEDGER_COMMIT is not None
            and os.environ.get(LEDGER_COMMIT_ENV) != "0"
        ):
            _settle_pending_ledger_dirt(_ACTIVE_LEDGER_COMMIT)
    # Check the leftover claim first. A refused batch normally leaves the spool
    # empty, so testing for an empty or absent spool first would hide the stop
    # signal that says answers are stranded outside the ledger.
    if not _entry_exists(claim, directory=True):
        _probe_answers_spool(spool)
    claimed: list[Path] | None = None
    applied: list[str] = []
    skipped: list[str] = []
    quarantined: list[Path] = []
    unreadable_current: dict[str, str] = {}

    def build(text: str) -> str:
        nonlocal claimed
        kept_ids = _manual_repair_answers_claim_ids(spool)
        if kept_ids:
            raise ManualRepairAnswersClaimError(kept_ids)
        if hold_consumer_lock:
            # This check runs inside _locked_ledger_mutation's writer lock,
            # before claiming or settling anything. It prevents foreign bytes
            # from being folded into the answer commit between a preflight
            # probe and the locked mutation.
            root = cast(Path, REPO_ROOT).resolve()
            ledger_relative = _repo_relative(_resolved_repo_path(args.ledger), root)
            dirty_probe = _git_for_ledger(
                root, "diff", "--quiet", "HEAD", "--", ledger_relative
            )
            if dirty_probe.returncode == 1:
                raise LedgerDirtyError(
                    f"ledger dirty against HEAD: {_resolved_repo_path(args.ledger)}; "
                    "commit or discard that change before applying answers"
                )
            if dirty_probe.returncode != 0:
                raise LedgerError(
                    "could not inspect ledger dirt against HEAD: "
                    + _git_failure_detail(dirty_probe)
                )
        issues, validated_metadata = _validate_text_with_metadata(text, args.ledger)
        if issues:
            raise LedgerError(
                f"the working ledger does not validate: {'; '.join(issues)}; "
                f"nothing in {spool} or {claim} was touched — repair it first"
            )
        with _publish_lock(publish_lock_path(spool)):
            _refuse_unapplied_answers(spool)
            if not _adopt_orphan_parts(spool):
                raise LedgerError(
                    f"could not adopt every orphan in answers spool {spool}"
                )
            if claim.exists():
                existing_intent = _read_claim_intent(
                    claim, strict=mode == "deferred"
                )
                if (
                    existing_intent is not None
                    and existing_intent.phase == "prepared"
                ):
                    if existing_intent.files is None:
                        raise LedgerError(
                            _answers_legacy_intent_message(
                                claim.resolve(),
                                spool.resolve(),
                                args.ledger.resolve(),
                                mode,
                            )
                        )
                    reconciliation = _reconcile_answers_claim(
                        claim, spool, args.ledger, decisions, mode
                    )
                    if mode != "deferred" and reconciliation.replay:
                        _recover_claim(
                            claim,
                            spool,
                            args.ledger,
                            answers=True,
                            publish_locked=True,
                        )
                else:
                    _recover_claim(
                        claim,
                        spool,
                        args.ledger,
                        answers=True,
                        publish_locked=True,
                    )
            existing_claimed = (
                sorted(claim.glob("*.md")) if claim.exists() else []
            )
            newly_claimed = claim_spool(
                spool,
                claim,
                into_existing=claim.exists(),
            )
            claimed = (
                sorted(existing_claimed + newly_claimed)
                if newly_claimed is not None
                else None
            )
        if claimed is None:
            raise LedgerError(
                f"a previously refused answers batch is still unresolved: {claim}"
            )
        if not claimed:
            if claim.exists():
                existing_intent = _read_claim_intent(
                    claim, strict=mode == "deferred"
                )
                if (
                    existing_intent is not None
                    and existing_intent.phase == "prepared"
                    and existing_intent.quarantined
                    and not list(claim.glob("*.md"))
                ):
                    # A retry after a crash between the quarantine move and
                    # cleanup has no replayable answer left.  Finish that
                    # durable quarantine boundary before returning.
                    release_spool(claim, spool, [], publish_locked=False)
            return text
        lines = text.splitlines()
        ledger_fence_states = _fence_mask(lines)
        answer_records: list[tuple[Path, str, list[str]]] = []
        paths_by_id: dict[str, list[Path]] = {}
        for answer_path in claimed:
            try:
                record = _parse_answer_file(answer_path)
            except (OSError, UnicodeError):
                unreadable_current[answer_path.name] = "unreadable"
                continue
            if record is None:
                raise LedgerError(
                    f"{answer_path.name} needs exactly one finding id and one "
                    f"'{DECIDED_MARKER}' bullet"
                )
            finding_id, bullet = record
            answer_records.append((answer_path, finding_id, bullet))
            paths_by_id.setdefault(finding_id, []).append(answer_path)

        answer_by_id = {
            finding_id: (answer_path, bullet)
            for answer_path, finding_id, bullet in answer_records
        }
        target_spans = _answer_target_spans(
            lines, ledger_fence_states, answer_by_id
        )
        duplicate_ids = {
            finding_id: paths
            for finding_id, paths in paths_by_id.items()
            if len(paths) > 1
        }
        if duplicate_ids:
            details = "; ".join(
                f"{finding_id}: {', '.join(path.name for path in paths)}"
                for finding_id, paths in duplicate_ids.items()
            )
            raise LedgerError(f"duplicate answer id(s) in batch: {details}")

        header_updates: dict[int, str] = {}
        insertions: dict[int, list[str]] = {}
        waiting_records: list[dict[str, object]] = []
        already_applied: list[tuple[Path, str]] = []
        to_quarantine: list[tuple[Path, str, Path]] = []
        for answer_path, finding_id, bullet in answer_records:
            target = target_spans.get(finding_id)
            if target is None:
                raise LedgerError(
                    f"{answer_path.name} answers {finding_id}, which is not in the ledger"
                )
            header_index, end, header_match = target
            blocked = header_match.group("blocked")
            blocker_class = classify_blocker(blocked)
            if blocker_class == BLOCKER_ANSWERABLE:
                kind = "decision"
                evidence = list(bullet)
                body = tuple(
                    lines[index]
                    for index in range(header_index + 1, end)
                    if ledger_fence_states[index] is FenceState.OUTSIDE
                )
                line_counts: dict[str, int] = {}
                for line in body:
                    line_counts[line] = line_counts.get(line, 0) + 1
                previous_line_occurrences = {
                    line: line_counts.get(line, 0) for line in set(evidence)
                }
                waiting_records.append(
                    {
                        "path": answer_path,
                        "id": finding_id,
                        "bullet": bullet,
                        "blocked": blocked,
                        "status": header_match.group("status"),
                        "kind": kind,
                        "evidence": evidence,
                        "previous_occurrences": _contiguous_occurrences(
                            body, tuple(evidence)
                        ),
                        "previous_line_occurrences": previous_line_occurrences,
                    }
                )
                continue
            entry_bullets = _decision_bullets(
                lines, ledger_fence_states, header_index + 1, end
            )
            if bullet in entry_bullets:
                already_applied.append((answer_path, finding_id))
                continue
            destination = spool / answer_path.with_suffix(".unapplied").name
            if destination.exists():
                raise LedgerError(
                    f"cannot quarantine {answer_path.name}: destination "
                    f"{destination} already exists"
                )
            to_quarantine.append((answer_path, finding_id, destination))

        for answer_path, finding_id in already_applied:
            answer_path.unlink()
            skipped.append(
                f"{finding_id} (already applied; consumed {answer_path.name})"
            )
        for answer_path, finding_id, destination in to_quarantine:
            os.rename(answer_path, destination)
            quarantined.append(destination)
            skipped.append(
                f"{finding_id} (not waiting on a decision; preserved "
                f"{destination.name})"
            )
        for record in waiting_records:
            finding_id = cast(str, record["id"])
            bullet = cast(list[str], record["bullet"])
            blocked = cast(str, record["blocked"])
            target = target_spans[finding_id]
            header_index, end, header_match = target
            updated_header = lines[header_index]
            updated_header = updated_header.replace(
                f"**Blocked:** {blocked}", "**Blocked:** none"
            )
            header_updates[header_index] = updated_header
            evidence = cast(list[str], record["evidence"])
            insertions[end] = evidence
            applied.append(finding_id)

        expected_answers: dict[str, AnswerExpectation] = {}
        answer_files: dict[str, dict[str, object]] = {}
        for record in waiting_records:
            answer_path = cast(Path, record["path"])
            finding_id = cast(str, record["id"])
            header_index, end, _header_match = target_spans[finding_id]
            updated = HEADER_RE.match(header_updates[header_index])
            assert updated is not None
            expected_evidence = tuple(insertions[end])
            expected_answers[finding_id] = AnswerExpectation(
                status=updated.group("status"),
                blocked=updated.group("blocked"),
                evidence=expected_evidence,
                previous_occurrences=cast(int, record["previous_occurrences"]),
                previous_line_occurrences=cast(
                    dict[str, int], record["previous_line_occurrences"]
                ),
                kind=cast(str, record["kind"]),
            )
            answer_files[answer_path.name] = {
                "id": finding_id,
                "blocked": record["blocked"],
                "status": record["status"],
                "kind": record["kind"],
                "evidence": record["evidence"],
                "previous_occurrences": record["previous_occurrences"],
                "previous_line_occurrences": record["previous_line_occurrences"],
            }
        if expected_answers:
            _register_ledger_commit(
                f"docs(findings): apply answers for {' '.join(expected_answers)}",
                expected_answers,
                _answers_postcondition(expected_answers),
            )

        close_receipt_updates: dict[int, str] = {}
        close_receipts_by_id: dict[str, list[LedgerMeta]] = {}
        if header_updates:
            # ``text`` passed _validate_text_with_metadata above. Index its
            # validated close receipts instead of scanning the same bytes again.
            for meta in validated_metadata:
                if (
                    meta.data.get("kind") == MUTATION_RECEIPT_KIND
                    and meta.data.get("command") in {"close", "set-header"}
                    and isinstance(meta.data.get("target"), str)
                ):
                    close_receipts_by_id.setdefault(
                        cast(str, meta.data["target"]), []
                    ).append(meta)
        for updated_header in header_updates.values():
            updated_match = HEADER_RE.match(updated_header)
            if updated_match is None:
                continue
            close_receipt_updates.update(
                _close_receipt_updates(
                    text,
                    updated_match.group("id"),
                    updated_header,
                    args.ledger,
                    close_receipts=close_receipts_by_id.get(
                        updated_match.group("id"), []
                    ),
                )
            )

        result_lines: list[str] = []
        for index in range(len(lines) + 1):
            if index in insertions:
                result_lines.extend(insertions[index])
            if index < len(lines):
                result_lines.append(
                    header_updates.get(
                        index, close_receipt_updates.get(index, lines[index])
                    )
                )

        if waiting_records or unreadable_current:
            existing_intent = _read_claim_intent(claim, strict=mode == "deferred")
            if existing_intent is not None and existing_intent.files is not None:
                existing_files = dict(existing_intent.files)
                existing_files.update(answer_files)
                answer_files = existing_files
            existing_quarantined = (
                dict(existing_intent.quarantined)
                if existing_intent is not None
                else {}
            )
            existing_quarantined.update(unreadable_current)
            for name in existing_quarantined:
                # The unreadable file has no trustworthy bytes from which to
                # recover an id.  Keep a schema-marked tombstone in ``files``;
                # prepared claims already carry their real per-file record.
                answer_files.setdefault(
                    name,
                    {
                        "id": None,
                        "kind": "quarantine",
                    },
                )
            _write_claim_intent(
                claim,
                "prepared",
                {
                    cast(str, record["id"])
                    for record in answer_files.values()
                    if isinstance(record.get("id"), str)
                },
                files=answer_files,
                quarantined=existing_quarantined,
            )
            if existing_quarantined:
                with _publish_lock(publish_lock_path(spool)):
                    intent = _read_claim_intent(claim, strict=mode == "deferred")
                    if intent is not None:
                        _quarantine_claim_files(claim, spool, intent)
            if mode == "deferred" and _ACTIVE_LEDGER_COMMIT is not None:
                _ACTIVE_LEDGER_COMMIT.claim = claim
                _ACTIVE_LEDGER_COMMIT.finalize = lambda: _finalize_claim(
                    claim, spool, args.ledger, decisions, "deferred",
                    _finalize_answers_claim_locked,
                )
        return _with_final_newline(text, result_lines)

    def clean_committed_claim() -> None:
        if claimed and (mode != "deferred" or not applied):
            release_spool(claim, spool, claimed)

    try:
        _locked_ledger_mutation(
            args.ledger, build, post_commit=clean_committed_claim
        )
    except KeptAnswersClaimError as exc:
        try:
            with _publish_lock(publish_lock_path(spool)):
                _mark_answers_claim_manual_repair(claim, exc.ids)
        except LedgerReadRefused:
            raise
        except (LedgerError, OSError, UnicodeError) as mark_exc:
            print(
                f"FAIL {claim}: could not record manual-repair state: {mark_exc}",
                file=sys.stderr,
            )
            return 1
        print(
            "FAIL answers claim kept for manual repair: " + ",".join(exc.ids),
            file=sys.stderr,
        )
        return MANUAL_REPAIR_RETURN_CODE
    except ManualRepairAnswersClaimError as exc:
        print(
            "FAIL answers claim kept for manual repair: " + ",".join(exc.ids),
            file=sys.stderr,
        )
        return MANUAL_REPAIR_RETURN_CODE
    if applied:
        print(f"applied {len(applied)} decision(s): {', '.join(applied)}")
    for note in skipped:
        print(f"skipped {note}")
    return 1 if quarantined else 0


def _bind_repo_root(root: Path) -> None:
    """Point module-level ledger paths at a git toplevel. Verb-time only."""
    global REPO_ROOT, LEDGER, DECISIONS, INBOX, LEGACY_INBOX, CLAIM, ANSWERS
    global DEFAULT_DRAIN_LOCK
    REPO_ROOT = root
    LEDGER = root / "tasks" / "findings.md"
    DECISIONS = root / "tasks" / "decisions.md"
    INBOX = root / "tasks" / "findings-inbox"
    LEGACY_INBOX = root / "tasks" / "findings-inbox.md"
    CLAIM = root / "tasks" / "findings-inbox.claim"
    ANSWERS = root / "tasks" / "findings-answers"
    DEFAULT_DRAIN_LOCK = _lock_for_root(root)


def _plan_only_file_exception(args: argparse.Namespace) -> bool:
    """Allow only the exact planner spool filing or read-only status form."""
    if args.command != "file":
        return False
    if bool(getattr(args, "status", False)):
        return True
    inbox = os.environ.get(PLAN_INBOX_ENV)
    return bool(
        getattr(args, "spool_only", False)
        and getattr(args, "inbox", None) is not None
        and inbox
        and args.inbox == Path(inbox)
    )


def _plan_only_refuses(args: argparse.Namespace) -> bool:
    """Refuse guarded verbs before any command-owned lock or write is touched."""
    if os.environ.get(PLAN_ONLY_ENV) != "1":
        return False
    claim_next = args.command == "next" and bool(getattr(args, "claim", False))
    if not _invocation_persists(args):
        return False
    if _plan_only_file_exception(args):
        return False
    print(
        f"REFUSING: {PLAN_ONLY_ENV}=1 forbids {args.command}" + (" --claim" if claim_next else ""),
        file=sys.stderr,
    )
    return True


def _invocation_persists(args: argparse.Namespace) -> bool:
    if args.command == "file" and bool(getattr(args, "status", False)):
        return False
    return COMMAND_CLASSIFICATION.get(args.command) == "guarded" or (
        args.command == "next" and bool(getattr(args, "claim", False))
    )


def _has_git_ancestor(directory: Path) -> bool:
    """Distinguish a directory outside Git from a failed repository probe."""
    return any(
        os.path.lexists(ancestor / GIT_ENTRY_NAME)
        for ancestor in (directory, *directory.parents)
    )


def _vendored_writer_refusal(args: argparse.Namespace) -> str | None:
    """A stamped vendored copy confines cwd-derived writes to its own repository.

    Explicit ledger paths express caller intent and remain exempt for consumer
    writer tests and deliberate cross-repository use. The unstamped kit copy
    serves any checkout. Copies outside a checkout are runtime snapshots and
    remain exempt. Failed probes inside a checkout refuse.
    """
    if not _invocation_persists(args) or args.command == "merge-driver":
        return None
    writes_decisions = args.command in {"record-decision", "set-trailer"}
    if getattr(args, "_explicit_ledger", False) or (
        writes_decisions and getattr(args, "_explicit_decisions", False)
    ):
        return None
    # Protected level-1 verbs retain their byte-identical supervisor contract.
    if not _impact_queue_enabled() and args.command in {"next", "check", "file", "merge-inbox"}:
        return None
    script = Path(os.path.abspath(__file__))
    try:
        with script.open("rb") as stream:
            first_line = stream.readline(VENDORED_STAMP_LINE_BYTES)
            stamped = first_line.endswith(b"\n") and stream.readline(
                VENDORED_STAMP_LINE_BYTES
            ).startswith(VENDORED_STAMP_PREFIX.encode())
    except OSError:
        return None
    if not stamped:
        return None
    if not _has_git_ancestor(script.parent):
        return None
    copy_refusal = (
        "REFUSING: cannot establish which repository the vendored findings.py "
        f"at {script} belongs to: "
    )
    copy_root, error = _probe_git_toplevel(cwd=script.parent)
    if copy_root is None:
        return copy_refusal + f"git rev-parse --show-toplevel: {error}"
    try:
        copy_common = _git_common_directory(
            script.parent, "git rev-parse --git-common-dir"
        )
    except LedgerError as exc:
        return copy_refusal + str(exc)
    target = args.decisions if writes_decisions else args.ledger
    try:
        cwd_common = _git_common_directory(
            cast(Path, REPO_ROOT), "git rev-parse --git-common-dir"
        )
    except LedgerError as exc:
        return (
            f"REFUSING: cannot establish which repository the cwd-derived ledger "
            f"at {target} belongs to: {exc}"
        )
    if cwd_common != copy_common:
        return (
            f"REFUSING: {script} is the vendored findings.py of {copy_root}; "
            f"it writes only that repository's ledgers, not {target}. "
            "Run that repository's own scripts/findings.py, or the agent-kit copy."
        )
    return None


LEDGER_COMMIT_ENV = "FINDINGS_LEDGER_COMMIT"
LEDGER_COMMIT_COMMANDS = frozenset(
    {
        "file",
        "merge-inbox",
        "apply-answers",
        "set-header",
        "annotate",
        "close",
        "record-decision",
        "set-trailer",
    }
)
INDEX_LOCK_WAIT_SECONDS = 300.0
INDEX_LOCK_POLL_SECONDS = 0.1
# Poll interval for inert test-only barriers.
TEST_BARRIER_POLL_SECONDS = 0.01
LEDGER_HOOK_TIMEOUT_SECONDS = 600.0
LEDGER_HOOK_TERM_GRACE_SECONDS = 30.0
LEDGER_INDEX_FILE_MODE = 0o600
# Git's tree mode for a symbolic link.
GIT_SYMLINK_MODE = "120000"
LEDGER_INDEX_NAME_PREFIX = "findings-ledger-index-"
LEDGER_BLOB_READ_FAILURE_CAUSE = "stored-blob-read-failed"
LEDGER_BLOB_BYTES_MISMATCH_CAUSE = "exact-byte-mismatch"


def _git_for_ledger(
    root: Path, *arguments: str, stdin: str | None = None
) -> subprocess.CompletedProcess[str]:
    """Run one non-interactive git operation for the commit helper."""
    git = shutil.which("git") or "/usr/bin/git"
    return subprocess.run(
        [git, *arguments],
        cwd=root,
        input=stdin,
        capture_output=True,
        text=True,
        check=False,
    )


def _git_for_ledger_bytes(
    root: Path, *arguments: str
) -> subprocess.CompletedProcess[bytes]:
    """Run one git operation while preserving binary stdout and stderr."""
    git = shutil.which("git") or "/usr/bin/git"
    return subprocess.run(
        [git, *arguments],
        cwd=root,
        capture_output=True,
        text=False,
        check=False,
    )


def _git_for_ledger_env(
    root: Path,
    environment: dict[str, str],
    *arguments: str,
    stdin: bytes | str | None = None,
    start_new_session: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run git with an explicit child environment and optional session isolation."""
    git = shutil.which("git") or "/usr/bin/git"
    text_input = isinstance(stdin, str) or stdin is None
    return subprocess.run(
        [git, *arguments],
        cwd=root,
        env=environment,
        start_new_session=start_new_session,
        input=stdin,
        capture_output=True,
        text=text_input,
        check=False,
    )


def _git_failure_detail(result: subprocess.CompletedProcess[str]) -> str:
    detail = (result.stderr or result.stdout).strip().replace("\n", "; ")
    return detail or f"git exited {result.returncode} without a diagnostic"


def _save_ledger_commit_scratch(
    intent: LedgerCommitIntent,
    *,
    path: Path | None = None,
    content: bytes | None = None,
    suffix: str = "",
) -> Path | None:
    """Save ledger bytes outside the checkout; never gate the commit."""
    path = path or intent.ledger
    content = intent.written_bytes if content is None else content
    try:
        directory = Path(tempfile.gettempdir()).resolve()
        root = cast(Path, REPO_ROOT).resolve()
        if directory == root or root in directory.parents:
            directory = Path("/tmp")
        fd, name = tempfile.mkstemp(
            prefix=f"findings-ledger-{intent.command}-",
            suffix=f"-{suffix}{path.name}",
            dir=directory,
        )
    except (OSError, UnicodeError):
        return None
    scratch = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content or b"")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        # A partial copy would be named as the recovery bytes; drop it.
        _discard_scratch(scratch)
        return None
    return scratch


def _discard_scratch(path: Path | None) -> None:
    if path is not None:
        with suppress(OSError):
            path.unlink()


def _create_temporary_git_index() -> Path:
    """Reserve a private index path without sharing scratch-file allocation."""
    directory = Path(tempfile.gettempdir()).resolve()
    root = cast(Path, REPO_ROOT).resolve()
    if directory == root or root in directory.parents:
        directory = Path("/tmp")
    for _attempt in range(PUBLISH_NAME_ATTEMPTS):
        candidate = directory / f"{LEDGER_INDEX_NAME_PREFIX}{_unique_suffix()}"
        try:
            descriptor = os.open(
                candidate,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                LEDGER_INDEX_FILE_MODE,
            )
        except FileExistsError:
            continue
        try:
            os.close(descriptor)
            candidate.unlink()
        except OSError:
            with suppress(OSError):
                os.close(descriptor)
            with suppress(OSError):
                candidate.unlink()
            raise
        return candidate
    raise OSError(f"could not reserve a unique temporary index path in {directory}")


def _head_postcondition(intent: LedgerCommitIntent) -> tuple[bool, str]:
    """Validate HEAD and prove this command's semantic postcondition there."""
    try:
        with _head_ledger_snapshot(
            intent.findings, intent.decisions, strict_decisions=False
        ) as snapshot:
            if snapshot.findings_text is None:
                return False, "the findings ledger is not in HEAD"
            if not snapshot.valid:
                return False, f"HEAD ledger validation failed: {snapshot.detail}"
            if intent.postcondition is None:
                return False, "no semantic postcondition was registered"
            if not intent.postcondition(
                snapshot.tasks_dir / "findings.md",
                snapshot.tasks_dir / "decisions.md",
            ):
                return False, "the command's write is not in HEAD"
            return True, ""
    except LedgerReadRefused:
        raise
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        return False, f"could not verify HEAD: {exc}"


def _warn_ledger_commit(
    intent: LedgerCommitIntent,
    cause: str,
    scratch: Path | None,
    companion_scratch: Path | None = None,
    *,
    durable_head: str = "",
) -> None:
    identifiers = " ".join(intent.identifiers) or "(unknown ids)"
    recovery = f"; written bytes: {scratch}" if scratch is not None else ""
    if companion_scratch is not None:
        recovery += f"; companion bytes: {companion_scratch}"
    if intent.claim is not None:
        if intent.command == "apply-answers":
            recovery += (
                f"; the claim at {intent.claim} keeps the answers for the next "
                "apply-answers or finalize-claims"
            )
        else:
            recovery += (
                f"; the claim at {intent.claim} keeps the batch for the next merge-inbox "
                "or finalize-claims"
            )
        writer = Path(__file__).resolve()
        answers = intent.claim.parent / intent.claim.name.removesuffix(".claim")
        inbox = INBOX if intent.command == "apply-answers" else answers
        answers_option = (
            f" --answers {_resolved_repo_path(answers)}"
            if intent.command == "apply-answers"
            else ""
        )
        recovery += (
            f"; run {writer} --ledger {_resolved_repo_path(intent.ledger)} "
            f"--decisions {_resolved_repo_path(intent.decisions)} finalize-claims "
            f"--inbox {_resolved_repo_path(inbox)}{answers_option}"
        )
    if intent.provisional:
        recovery += (
            "; the id(s) "
            + " ".join(intent.provisional)
            + " printed above are provisional — a replay re-mints any that were used meanwhile"
        )
    if _ledger_guard_refusal(cause):
        prefix = (
            f"WARNING ledger commit for {intent.ledger} after {intent.command} "
            f"({identifiers}) was not committed: the ledger rollback guard refused it "
            "(the bytes drop committed content, or preservation could not be established): "
        )
        recovery += ". " + _rollback_remedy(intent.ledger)
    elif durable_head:
        prefix = (
            f"WARNING ledger commit for {intent.ledger} after {intent.command} "
            f"({identifiers}) is durable as {durable_head} but was not fully verified: "
        )
    else:
        prefix = (
            f"WARNING ledger commit for {intent.ledger} after {intent.command} "
            f"({identifiers}) did not preserve the write in HEAD: "
        )
    print(prefix + f"{cause}{recovery}", file=sys.stderr)


def _run_ledger_hook(
    root: Path, environment: dict[str, str]
) -> tuple[bool, bool, str]:
    """Run the repository pre-commit hook on the private index."""
    git = shutil.which("git") or "/usr/bin/git"
    process = subprocess.Popen(
        [git, "hook", "run", "--ignore-missing", "pre-commit"],
        cwd=root,
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    term_sent = False
    kill_sent = False
    stdout = ""
    stderr = ""

    def stream_text(value: object) -> str:
        if isinstance(value, bytes):
            return value.decode("utf-8", errors="replace")
        return value if isinstance(value, str) else ""

    def group_alive() -> bool:
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            return False
        except OSError:
            # Permission errors and an indeterminate group state fail closed:
            # never assume a descendant is gone before releasing the ledger lock.
            return True
        return True

    def terminate_group() -> None:
        nonlocal term_sent
        if term_sent:
            return
        term_sent = True
        with suppress(OSError):
            os.killpg(process.pid, signal.SIGTERM)

    def remember_partial(exc: subprocess.TimeoutExpired) -> None:
        nonlocal stdout, stderr
        partial_stdout = getattr(exc, "output", None)
        partial_stderr = getattr(exc, "stderr", None)
        if partial_stdout is not None:
            stdout = stream_text(partial_stdout)
        if partial_stderr is not None:
            stderr = stream_text(partial_stderr)

    def wait_for_group_grace() -> None:
        """Wait until the group exits or the full TERM grace has elapsed."""
        nonlocal stdout, stderr
        deadline = time.monotonic() + LEDGER_HOOK_TERM_GRACE_SECONDS
        while group_alive():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                stdout, stderr = process.communicate(
                    timeout=min(remaining, LEDGER_LOCK_RETRY_INTERVAL_SECONDS)
                )
            except subprocess.TimeoutExpired as exc:
                remember_partial(exc)
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(LEDGER_LOCK_RETRY_INTERVAL_SECONDS, remaining))
        if not group_alive() and process.poll() is not None:
            stdout, stderr = process.communicate()

    try:
        stdout, stderr = process.communicate(timeout=LEDGER_HOOK_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        remember_partial(exc)
        terminate_group()
    else:
        if group_alive():
            # The direct hook exited before the normal timeout, but a descendant
            # still owns the session. Give the group the same TERM/grace/KILL
            # treatment before considering the hook complete.
            terminate_group()
    if term_sent:
        # communicate() can return as soon as the direct process exits while a
        # detached descendant still owns the group. The grace is therefore
        # measured from the TERM signal and checked independently of pipes.
        wait_for_group_grace()
        if group_alive():
            kill_sent = True
            with suppress(OSError):
                os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
    if term_sent:
        detail = "\n".join(
            part.strip()
            for part in (stream_text(stderr), stream_text(stdout))
            if part.strip()
        )
        if detail:
            sys.stderr.write(detail + "\n")
        return False, kill_sent, (
            "pre-commit hook refused the ledger commit: timeout"
            + (f"; {detail}" if detail else "")
        )
    output = "\n".join(
        part for part in (stream_text(stdout), stream_text(stderr)) if part
    )
    if output:
        sys.stderr.write(output)
        if not output.endswith("\n"):
            sys.stderr.write("\n")
    if process.returncode != 0:
        return False, kill_sent, "pre-commit hook refused the ledger commit"
    return True, kill_sent, ""


def _commit_blob(
    root: Path,
    relative: str,
    scratch: Path | None,
    content: bytes | None,
) -> tuple[str | None, str | None]:
    """Hash one exact ledger byte string into the object store."""
    try:
        saved_bytes = scratch.read_bytes() if scratch is not None else content or b""
    except (OSError, UnicodeError) as exc:
        return None, f"could not read saved bytes for {relative}: {exc}"
    if scratch is not None:
        result = _git_for_ledger(
            root, "hash-object", "-w", "--path", relative, str(scratch)
        )
    else:
        result = _git_for_ledger_env(
            root,
            os.environ.copy(),
            "hash-object",
            "-w",
            "--path",
            relative,
            "--stdin",
            stdin=content or b"",
        )
    if result.returncode != 0:
        return None, _git_failure_detail(result)
    blob = result.stdout.strip()
    if isinstance(blob, bytes):
        blob = blob.decode("ascii", errors="replace")
    if SHA256_RE.fullmatch(blob) is None and not re.fullmatch(r"[0-9a-f]{40,64}", blob):
        return None, "git hash-object returned an invalid object id"
    stored = _git_for_ledger_bytes(root, "cat-file", "blob", blob)
    if stored.returncode != 0:
        detail = (stored.stderr or stored.stdout).decode("utf-8", errors="replace")
        detail = detail.strip().replace("\n", "; ")
        return None, (
            f"{LEDGER_BLOB_READ_FAILURE_CAUSE}:{relative}: "
            f"{detail or f'git exited {stored.returncode} without a diagnostic'}"
        )
    if stored.stdout != saved_bytes:
        return None, (
            f"{LEDGER_BLOB_BYTES_MISMATCH_CAUSE}:{relative}: "
            "stored blob differs from saved bytes"
        )
    return blob, None


def _head_file_mode(root: Path, commit: str, relative: str) -> str:
    entry = _head_file_blob_entry(root, commit, relative, strict=False)
    if entry is None:
        raise LedgerError(f"ledger path {relative} is not tracked in HEAD")
    return entry[0]


def _head_file_blob(
    root: Path, commit: str, relative: str, *, strict: bool = False,
) -> str | None:
    """Share path-to-blob lookup, preserving the commit helper's tolerant parser.

    By default, return the blob of the tree entry at ``relative`` itself, so a
    symlink returns its own blob. With ``strict=True``, follow ``120000`` symlink
    entries for at most ``TREE_LEDGER_SYMLINK_LIMIT`` links and return the target
    file's blob. Raise ``LedgerError`` for a dangling link, a target that leaves
    the tree, or a chain exceeding the limit. Return ``None`` when ``relative``
    is absent.
    """
    followed = 0
    while True:
        entry = _head_file_blob_entry(root, commit, relative, strict=strict)
        if entry is None:
            if followed:
                raise LedgerError(f"dangling ledger symlink in {root} {commit}:{relative}")
            return None
        mode, blob = entry
        if not strict or mode != GIT_SYMLINK_MODE:
            return blob
        if followed >= TREE_LEDGER_SYMLINK_LIMIT:
            raise LedgerError(
                f"ledger symlink chain exceeds {TREE_LEDGER_SYMLINK_LIMIT} links "
                f"in {root} {commit}:{relative}"
            )
        target = _allocation_git(root, "cat-file", "blob", blob).stdout
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(relative), target))
        if not target or resolved.startswith("/") or resolved == ".." or resolved.startswith("../"):
            raise LedgerError(f"ledger symlink leaves tree in {root} {commit}:{relative}: {target!r}")
        relative = resolved
        followed += 1


def _head_file_blob_entry(
    root: Path, commit: str, relative: str, *, strict: bool,
) -> tuple[str, str] | None:
    result = (
        _allocation_git(root, "ls-tree", commit, "-z", "--", relative)
        if strict else _git_for_ledger(root, "ls-tree", commit, "-z", "--", relative)
    )
    if result.returncode != 0:
        raise LedgerError(f"could not inspect HEAD tree: {_git_failure_detail(result)}")
    for record in result.stdout.split("\0"):
        if not record:
            continue
        metadata, separator, actual_path = record.partition("\t")
        fields = metadata.split()
        if len(fields) != 3 or not separator:
            if strict:
                raise LedgerError(f"could not inspect {root} {commit}:{relative}: malformed tree entry")
            continue
        if actual_path == relative:
            if strict and fields[1] != "blob":
                raise LedgerError(f"could not read {root} {commit}:{relative}: not a ledger blob")
            return fields[0], fields[2]
    return None


def _ledger_superseded_error(
    root: Path, intent: LedgerCommitIntent, current_head: str
) -> LedgerSupersededError | None:
    """Detect a foreign ledger replacement since this command's write."""
    if intent.head_at_write is None or intent.head_at_write == current_head:
        return None
    paths = [intent.ledger]
    if intent.companion is not None:
        paths.append(intent.companion)
    changed: list[str] = []
    for path in paths:
        relative = _repo_relative(_resolved_repo_path(path), root)
        before = _head_file_blob(root, intent.head_at_write, relative)
        after = _head_file_blob(root, current_head, relative)
        if before != after:
            changed.append(relative)
    if not changed:
        return None
    return LedgerSupersededError(
        f"ledger superseded: HEAD moved from {intent.head_at_write} to "
        f"{current_head}; ledger blob changed for {', '.join(changed)}"
    )


def _refresh_ledger_index(
    root: Path, relative_modes_blobs: list[tuple[str, str, str]]
) -> tuple[bool, str]:
    """Refresh only ledger index entries, preserving unrelated staged work."""
    last = "index refresh not attempted"
    wait_seconds = INDEX_LOCK_WAIT_SECONDS
    poll_seconds = INDEX_LOCK_POLL_SECONDS
    configured_index = os.environ.get("GIT_INDEX_FILE")
    if configured_index:
        index_path = Path(configured_index)
        if not index_path.is_absolute():
            index_path = root / index_path
        index_lock = index_path.with_name(index_path.name + ".lock")
    else:
        lock_result = _git_for_ledger(root, "rev-parse", "--git-path", "index.lock")
        index_lock = Path(lock_result.stdout.strip()) if lock_result.returncode == 0 else None
        if index_lock is not None and not index_lock.is_absolute():
            index_lock = root / index_lock
    deadline = time.monotonic() + wait_seconds

    def wait_for_index_lock() -> bool:
        if index_lock is None:
            return True
        while index_lock.exists():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(poll_seconds, remaining))
        return True

    def lock_timeout() -> tuple[bool, str]:
        lock_name = str(index_lock) if index_lock is not None else "the Git index lock"
        return False, (
            f"timed out after {wait_seconds:.1f}s waiting for "
            f"{lock_name} to disappear"
        )

    if not wait_for_index_lock():
        return lock_timeout()
    while True:
        last_result: subprocess.CompletedProcess[str] | None = None
        for relative, mode, blob in relative_modes_blobs:
            last_result = _git_for_ledger(
                root,
                "update-index",
                "--add",
                "--cacheinfo",
                f"{mode},{blob},{relative}",
            )
            if last_result.returncode != 0:
                break
        if last_result is None or last_result.returncode == 0:
            return True, ""
        last = _git_failure_detail(last_result)
        if "index.lock" not in last and "index.lock" not in (last_result.stderr or ""):
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return lock_timeout()
        # A peer may acquire the lock after the initial absence check. Give it
        # the same bounded window to finish, then retry the path-scoped update.
        time.sleep(min(poll_seconds, remaining))
        if not wait_for_index_lock():
            return lock_timeout()
    return False, last


def _attempt_ledger_commit(
    intent: LedgerCommitIntent,
    *,
    lock_held: bool = False,
    warn: bool = True,
    require_worktree_match: bool = False,
) -> LedgerCommitResult:
    """Commit exactly the command's bytes through a hooked temporary index."""
    if not intent.replaced or os.environ.get(LEDGER_COMMIT_ENV) == "0":
        return LedgerCommitResult(False)
    for path in (intent.ledger, intent.companion):
        if path is None:
            continue
        root = _clone_id_allocation_root(path, explicit=_EXPLICIT_ID_ALLOCATION_PATHS)
        if root is not None and held_ledger_lock_fd(_clone_id_fence_lock(root)) is None:
            raise LedgerError("ledger commit outside the clone-wide id fence")
    _id_allocation_test_point("commit")
    scratch = _save_ledger_commit_scratch(intent)
    companion_scratch = (
        _save_ledger_commit_scratch(
            intent,
            path=intent.companion,
            content=intent.companion_bytes,
            suffix="companion-",
        )
        if intent.companion is not None
        else None
    )

    installed_head = ""

    def failed(cause: str, *, durable_head: str = "",
               phase: str = "before-update-ref") -> LedgerCommitResult:
        # An unborn repository has no HEAD to preserve yet.  The mutation
        # remains successful and the untracked ledger is intentionally skipped;
        # emitting the normal recovery warning would turn that supported setup
        # into a false durability alarm.
        unborn_head = (intent.head_at_write is None
                       and cause.startswith("commit helper failed: could not resolve HEAD:"))
        if warn and not unborn_head:
            _warn_ledger_commit(
                intent, cause, scratch, companion_scratch, durable_head=durable_head)
        return LedgerCommitResult(False, cause, durable_head, phase)

    def already_durable(head: str) -> LedgerCommitResult:
        """Heal only this commit-ledger path when its worktree still equals HEAD."""
        if intent.command != "commit-ledger" or not head:
            return LedgerCommitResult(True, durable_head=head)
        relative = _repo_relative(_resolved_repo_path(intent.ledger), root)
        try:
            blob = _head_file_blob(root, head, relative)
            if blob is None:
                return LedgerCommitResult(True, durable_head=head)
            head_bytes = _git_for_ledger_bytes(root, "cat-file", "blob", blob)
            if head_bytes.returncode != 0:
                detail = (head_bytes.stderr or head_bytes.stdout).decode(
                    "utf-8", errors="replace"
                ).strip().replace("\n", "; ")
                return failed(
                    f"ledger commit is durable but index refresh failed: "
                    f"could not read HEAD blob for {relative}: "
                    f"{detail or f'git exited {head_bytes.returncode} without a diagnostic'}",
                    durable_head=head,
                    phase="after-update-ref",
                )
            if _read_ledger_bytes(_resolved_repo_path(intent.ledger)) != head_bytes.stdout:
                return LedgerCommitResult(True, durable_head=head)
            mode = _head_file_mode(root, head, relative)
            staged = _git_for_ledger(root, "ls-files", "--stage", "--", relative)
            if staged.returncode != 0:
                return failed(
                    f"ledger commit is durable but index refresh failed: "
                    f"could not inspect index entry for {relative}: "
                    f"{_git_failure_detail(staged)}",
                    durable_head=head,
                    phase="after-update-ref",
                )
            index_blob = None
            for record in staged.stdout.splitlines():
                metadata, separator, indexed_path = record.partition("\t")
                fields = metadata.split()
                if (
                    separator
                    and indexed_path == relative
                    and len(fields) == 3
                    and fields[2] == "0"
                ):
                    index_blob = fields[1]
                    break
            if index_blob == blob:
                return LedgerCommitResult(True, durable_head=head)
            refreshed, detail = _refresh_ledger_index(
                root, [(relative, mode, blob)]
            )
            if not refreshed:
                return failed(
                    f"ledger commit is durable but index refresh failed: {detail}",
                    durable_head=head,
                    phase="after-update-ref",
                )
        except LedgerReadRefused:
            raise
        except (LedgerError, OSError, UnicodeError, ValueError) as exc:
            return failed(
                f"ledger commit is durable but index refresh failed: {exc}",
                durable_head=head,
                phase="after-update-ref",
            )
        return LedgerCommitResult(True, durable_head=head)

    root = cast(Path, REPO_ROOT).resolve()
    lock = ledger_lock_path(_resolved_repo_path(intent.ledger))
    acquired_here = False
    temp_index: Path | None = None
    try:
        if not lock_held:
            acquired, waited = acquire_ledger_lock(lock, LEDGER_LOCK_WAIT_SECONDS)
            if not acquired:
                return failed(
                    f"ledger lock {lock}: another ledger writer still holds it after "
                    f"{waited:.2f}s of retries"
                )
            acquired_here = True
        paths = [intent.ledger]
        if intent.companion is not None:
            paths.append(intent.companion)
        relatives = [_repo_relative(_resolved_repo_path(path), root) for path in paths]
        tracked = _git_for_ledger(root, "ls-files", "--error-unmatch", "--", relatives[0])
        if tracked.returncode == 1:
            _discard_scratch(scratch)
            _discard_scratch(companion_scratch)
            try:
                durable_head = _resolve_head(root)
            except LedgerError:
                durable_head = ""
            return already_durable(durable_head)
        if tracked.returncode != 0:
            return failed(f"fatal tracked-file probe: {_git_failure_detail(tracked)}")
        if intent.companion is not None:
            companion_tracked = _git_for_ledger(
                root, "ls-files", "--error-unmatch", "--", relatives[1]
            )
            if companion_tracked.returncode != 0:
                if companion_tracked.returncode == 1:
                    return failed(f"companion ledger is untracked: {relatives[1]}")
                return failed(
                    f"fatal tracked-file probe: {_git_failure_detail(companion_tracked)}"
                )

        dirty = _git_for_ledger(root, "diff", "--quiet", "HEAD", "--", *relatives)
        if dirty.returncode not in {0, 1}:
            return failed(f"fatal HEAD dirtiness probe: {_git_failure_detail(dirty)}")

        expected_bytes = [intent.written_bytes]
        scratch_paths = [scratch]
        if intent.companion is not None:
            expected_bytes.append(intent.companion_bytes)
            scratch_paths.append(companion_scratch)
        for path, expected, saved in zip(paths, expected_bytes, scratch_paths, strict=True):
            if expected is None and saved is None:
                return failed(f"no exact bytes were recorded for {path}")
            if require_worktree_match:
                try:
                    actual = _read_ledger_bytes(_resolved_repo_path(path))
                    saved_bytes = saved.read_bytes() if saved is not None else expected or b""
                except (OSError, UnicodeError) as exc:
                    return failed(f"could not read exact ledger bytes for {path}: {exc}")
                if actual != saved_bytes:
                    return failed(
                        f"worktree ledger differs from the exact bytes written by {intent.command}"
                    )

        if require_worktree_match:
            valid, validation_detail = _validate_ledger_paths(
                intent.findings, intent.decisions
            )
            if not valid:
                return failed(f"ledger validation refused the commit: {validation_detail}")

        current_head = _resolve_head(root)
        old_head = intent.expected_head or current_head
        if intent.expected_head is not None and current_head != intent.expected_head:
            return failed(f"HEAD is {current_head}, not {intent.expected_head}")

        for path, relative, saved, expected in zip(
            paths, relatives, scratch_paths, expected_bytes, strict=True
        ):
            try:
                blob = _head_file_blob(root, old_head, relative)
                content = saved.read_bytes() if saved is not None else expected or b""
                kind = "decisions" if path == intent.decisions else "findings"
                _refuse_ledger_rollback(root, path, blob, old_head, content, kind)
            except (LedgerError, OSError, UnicodeError) as exc:
                cause = str(exc)
                if not cause.startswith(LEDGER_ROLLBACK_PREFIX):
                    cause = f"{LEDGER_ROLLBACK_PREFIX} {path}, parent {old_head}: {exc}"
                return failed(cause)

        # A no-op consumer mutation has no semantic postcondition to evaluate.
        # If its exact saved bytes already occupy HEAD, that is durable and must
        # not turn into an empty commit merely because the write was observed.
        if intent.postcondition is None:
            exact_head = True
            for relative, saved, expected in zip(
                relatives, scratch_paths, expected_bytes, strict=True
            ):
                try:
                    expected_content = (
                        saved.read_bytes() if saved is not None else expected or b""
                    )
                except (OSError, UnicodeError) as exc:
                    return failed(f"could not read exact ledger bytes for {relative}: {exc}")
                shown = _git_for_ledger(root, "show", f"{old_head}:{relative}")
                if (
                    shown.returncode != 0
                    or shown.stdout.encode("utf-8") != expected_content
                ):
                    exact_head = False
                    break
            if exact_head:
                _discard_scratch(scratch)
                _discard_scratch(companion_scratch)
                return already_durable(old_head)

        # The worktree may have returned to its old HEAD bytes after this
        # command's replacement, or may have moved independently while the
        # command's exact bytes are already represented in HEAD. Semantic
        # durability is checked independently of the dirtiness probe: foreign
        # worktree contents never suppress a saved commit, and an effect already
        # proven in HEAD never receives an empty commit.
        holds, detail = _head_postcondition(intent)
        if holds:
            _discard_scratch(scratch)
            _discard_scratch(companion_scratch)
            return already_durable(old_head)
        superseded = _ledger_superseded_error(root, intent, current_head)
        if superseded is not None:
            return failed(str(superseded))

        try:
            temp_index = _create_temporary_git_index()
        except OSError as exc:
            return failed(f"could not create temporary git index: {exc}")
        environment = os.environ.copy()
        environment["GIT_INDEX_FILE"] = str(temp_index)
        read_tree = _git_for_ledger_env(root, environment, "read-tree", old_head)
        if read_tree.returncode != 0:
            return failed(f"temporary index read-tree failed: {_git_failure_detail(read_tree)}")
        modes_blobs: list[tuple[str, str, str]] = []
        for relative, saved, expected in zip(relatives, scratch_paths, expected_bytes, strict=True):
            blob, error = _commit_blob(root, relative, saved, expected)
            if blob is None:
                return failed(f"hash-object failed for {relative}: {error}")
            mode = _head_file_mode(root, old_head, relative)
            update = _git_for_ledger_env(
                root,
                environment,
                "update-index",
                "--add",
                "--cacheinfo",
                f"{mode},{blob},{relative}",
            )
            if update.returncode != 0:
                return failed(f"temporary index update failed: {_git_failure_detail(update)}")
            modes_blobs.append((relative, mode, blob))
        hooked, killed, hook_detail = _run_ledger_hook(root, environment)
        if not hooked:
            if killed:
                hook_output = hook_detail
                stash_match = re.search(
                    r"Stashing unstaged files to (?P<path>[^\n]+?)(?:\.\s|\.$|\n|$)",
                    hook_output,
                )
                if stash_match is not None:
                    stash_path = stash_match.group("path").rstrip(".")
                    if f"Restored changes from {stash_path}" not in hook_output:
                        hook_detail += (
                            f"; unstaged changes left in {stash_path}; restore with: "
                            f"git apply {stash_path}"
                        )
            return failed(hook_detail)
        for relative, _mode, blob in modes_blobs:
            observed = _git_for_ledger_env(root, environment, "rev-parse", f":{relative}")
            if observed.returncode != 0 or observed.stdout.strip() != blob:
                return failed(
                    f"pre-commit hook changed exact ledger bytes for {relative}"
                )
        tree = _git_for_ledger_env(root, environment, "write-tree")
        if tree.returncode != 0:
            return failed(f"temporary index write-tree failed: {_git_failure_detail(tree)}")
        signing = _git_for_ledger(root, "config", "--type=bool", "--get", "commit.gpgsign")
        if signing.returncode not in {0, 1}:
            return failed(f"commit.gpgsign read failed: {_git_failure_detail(signing)}")
        signing_args = ["-S"] if signing.stdout.strip() == "true" else []
        commit_environment = dict(os.environ)
        commit_environment["SSH_ASKPASS_REQUIRE"] = "never"
        commit = _git_for_ledger_env(
            root,
            commit_environment,
            "commit-tree",
            tree.stdout.strip(),
            *signing_args,
            "-p",
            old_head,
            stdin=(intent.subject or "docs(findings): commit the verified ledger bytes") + "\n",
            start_new_session=True,
        )
        if commit.returncode != 0:
            return failed(f"commit-tree failed: {_git_failure_detail(commit)}")
        new_head = commit.stdout.strip()
        head_ref = _git_for_ledger(root, "symbolic-ref", "-q", "HEAD")
        if head_ref.returncode != 0 or not head_ref.stdout.strip():
            return failed("detached HEAD cannot receive an exact ledger commit")
        update_ref = _git_for_ledger(
            root, "update-ref", head_ref.stdout.strip(), new_head, old_head
        )
        if update_ref.returncode != 0:
            holds, detail = _head_postcondition(intent)
            if holds:
                durable_head = _resolve_head(root)
                _discard_scratch(scratch)
                _discard_scratch(companion_scratch)
                return already_durable(durable_head)
            return failed(
                f"HEAD moved during commit: {_git_failure_detail(update_ref)}",
                phase="before-update-ref")
        installed_head = new_head
        refreshed, refresh_detail = _refresh_ledger_index(root, modes_blobs)
        if not refreshed:
            return failed(
                f"ledger commit is durable but index refresh failed: {refresh_detail}",
                durable_head=new_head, phase="after-update-ref")
        holds, detail = _head_postcondition(intent)
        if not holds:
            return failed(detail, durable_head=new_head, phase="after-update-ref")
        _discard_scratch(scratch)
        _discard_scratch(companion_scratch)
        return LedgerCommitResult(True, durable_head=new_head, phase="after-update-ref")
    except LedgerReadRefused as exc:
        return failed(
            str(exc), durable_head=installed_head,
            phase="after-update-ref" if installed_head else "before-update-ref",
        )
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        return failed(
            f"commit helper failed: {exc}",
            durable_head=installed_head,
            phase="after-update-ref" if installed_head else "before-update-ref",
        )
    finally:
        if temp_index is not None:
            with suppress(OSError):
                temp_index.unlink()
        if acquired_here:
            release_ledger_lock(lock)


def _print_commit_metadata(result: LedgerCommitResult | None = None,
                           *, phase: str = "before-update-ref", sha: str = "",
                           stream: object | None = None) -> None:
    """State the writer phase and durable head on every commit-ledger exit."""
    if result is not None:
        phase = result.phase
        sha = result.durable_head
    output = sys.stdout if stream is None else stream
    print(f"phase={phase}", file=output)
    if sha:
        print(f"sha={sha}", file=output)


def cmd_commit_ledger(args: argparse.Namespace) -> int:
    """Commit an expected ledger snapshot while holding the writer lock."""
    try:
        with ExitStack() as scope:
            if os.environ.get(LEDGER_COMMIT_ENV) != "0":
                scope.enter_context(_clone_id_allocation_scope(
                    args.ledger, explicit=_explicit_allocation_paths(args),
                ))
            return _cmd_commit_ledger_clone_locked(args)
    except LedgerError as exc:
        _print_commit_metadata(phase="before-update-ref")
        print(f"FAIL {exc}", file=sys.stderr)
        return 1


def _cmd_commit_ledger_clone_locked(args: argparse.Namespace) -> int:
    ledger = _resolved_repo_path(args.ledger)
    expected_path = _resolved_repo_path(args.expected)
    lock = ledger_lock_path(ledger)
    try:
        acquired, waited = acquire_ledger_lock(lock, LEDGER_LOCK_WAIT_SECONDS)
        if not acquired:
            _print_commit_metadata(phase="before-update-ref")
            print(
                f"FAIL ledger lock {lock}: another ledger writer still holds it "
                f"after {waited:.2f}s of retries",
                file=sys.stderr,
            )
            return 1
        try:
            actual_head = _resolve_head(cast(Path, REPO_ROOT).resolve())
            if actual_head != args.expected_head:
                _print_commit_metadata(phase="before-update-ref")
                print(
                    f"FAIL HEAD is {actual_head}, not --expected-head {args.expected_head}",
                    file=sys.stderr,
                )
                return 1
            expected_bytes = expected_path.read_bytes()
            if _read_ledger_bytes(ledger) != expected_bytes:
                _print_commit_metadata(phase="before-update-ref")
                print(
                    f"FAIL worktree ledger differs from --expected {expected_path}",
                    file=sys.stderr,
                )
                return 1
            is_decisions = ledger == _resolved_repo_path(args.decisions)
            intent = LedgerCommitIntent(
                command="commit-ledger",
                ledger=ledger,
                findings=_resolved_repo_path(args.ledger),
                decisions=_resolved_repo_path(args.decisions),
                subject=args.subject
                or "docs(findings): commit the verified ledger bytes",
                expected_head=args.expected_head,
                postcondition=_ledger_bytes_postcondition(
                    None if is_decisions else expected_bytes,
                    expected_bytes if is_decisions else None,
                ),
                replaced=True,
                written_bytes=expected_bytes,
            )
            result = _attempt_ledger_commit(
                intent, lock_held=True, require_worktree_match=True
            )
            if not result.durable:
                _print_commit_metadata(result)
                print(f"FAIL {result.cause or 'ledger commit failed'}", file=sys.stderr)
                return 1
            _print_commit_metadata(result)
            return 0
        finally:
            release_ledger_lock(lock)
    except (LedgerError, OSError, UnicodeError, ValueError) as exc:
        _print_commit_metadata(phase="before-update-ref")
        print(f"FAIL {exc}", file=sys.stderr)
        return 1


def build_parser() -> argparse.ArgumentParser:
    """The complete CLI; a test walks its subcommand table."""
    parser = argparse.ArgumentParser(
        description="Query and validate the findings ledger (tasks/findings.md)."
    )
    parser.add_argument("--ledger", type=Path, default=None, help=argparse.SUPPRESS)
    parser.add_argument("--decisions", type=Path, default=None, help=argparse.SUPPRESS)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser(
        "check", help="validate every header and the decisions ledger's ids"
    ).set_defaults(func=cmd_check)
    sub.add_parser(
        "drain-status",
        help="exit 0 if this repo's consumer lock is held, 1 otherwise",
    ).set_defaults(func=cmd_drain_status)

    p_list = sub.add_parser("list", help="print findings")
    p_list.add_argument("--open", action="store_true", help="only status=open")
    p_list.add_argument("--area")
    p_list.add_argument("--root")
    p_list.add_argument(
        "--json",
        action="store_true",
        help="print a JSON array of findings on stdout; warnings stay on stderr",
    )
    p_list.add_argument(
        "--body",
        action="store_true",
        help="include unfenced body text and verified body digest in JSON",
    )
    p_list.add_argument(
        "--strict",
        action="store_true",
        help="exit 1 without output when validation finds a problem",
    )
    p_list.add_argument(
        "--raw",
        action="store_true",
        help="include exact source-byte entry digests and section headings in JSON",
    )
    p_list.set_defaults(func=cmd_list)

    p_summary = sub.add_parser(
        "summary", help="print counts, who is waiting, and what is drainable"
    )
    p_summary.add_argument(
        "--json",
        action="store_true",
        help="print the versioned summary object on stdout; warnings stay on stderr",
    )
    p_summary.add_argument("--inbox", type=Path, default=None, help=argparse.SUPPRESS)
    p_summary.set_defaults(func=cmd_summary)
    p_summary.add_argument("--exclude-tooling", action="store_true",
                           help="skip clusters whose open members all have tooling impact in drainable counts")

    p_next = sub.add_parser("next", help="print the highest-ranked pickable cluster")
    p_next.add_argument("--pin", help="force this finding's cluster")
    p_next.add_argument("--exclude-tooling", action="store_true",
                        help="skip clusters whose open members all have tooling impact unless explicitly pinned")
    p_next.add_argument("--automatic-pin", action="store_true", help=argparse.SUPPRESS)
    p_next.add_argument("--claim", action="store_true", help="atomically claim the selected findings for this session")
    p_next.add_argument(
        "--json",
        action="store_true",
        help="print a JSON object for the pick on stdout; warnings stay on stderr",
    )
    p_next.add_argument(
        "--exclude",
        action="append",
        default=[],
        metavar="root:<slug>|finding:<id>",
        help="exclude a cluster by its root slug or singleton finding id; repeatable",
    )
    p_next.add_argument(
        "--entry",
        choices=("build",),
        help="select the first remaining cluster at the effective build tier",
    )
    p_next.set_defaults(func=cmd_next)

    p_unclaim = sub.add_parser("unclaim", help="release this session's pick claims")
    p_unclaim.add_argument("ids", nargs="*", help="finding ids; omit to release all")
    p_unclaim.set_defaults(func=cmd_unclaim)

    p_rel = sub.add_parser("related", help="findings sharing an area or a file")
    p_rel.add_argument("--area")
    p_rel.add_argument("--file", action="append", help="repeatable")
    p_rel.add_argument("--inbox", type=Path, default=None, help=argparse.SUPPRESS)
    p_rel.set_defaults(func=cmd_related)

    p_file = sub.add_parser(
        "file", help="publish one pending finding entry through the inbox spool"
    )
    p_file.add_argument(
        "entry", type=Path, help="path to one complete ### finding entry, or - for stdin"
    )
    p_file.add_argument("--inbox", type=Path, default=None, help=argparse.SUPPRESS)
    p_file.add_argument("--replaces", type=Path, help="replace a kept intake entry after filing")
    p_file.add_argument(
        "--again",
        action="store_true",
        help="deliberately file byte-identical entry content again",
    )
    p_file.add_argument(
        "--spool-only",
        action="store_true",
        help="publish the entry without consulting the drain lock or merging",
    )
    p_file.add_argument(
        "--status",
        action="store_true",
        help="print the content-derived filing receipt state without writing",
    )
    p_file.set_defaults(func=cmd_file)

    p_merge = sub.add_parser("merge-inbox", help="fold the inbox into the ledger")
    p_merge.add_argument("--inbox", type=Path, default=None, help=argparse.SUPPRESS)
    p_merge.set_defaults(func=cmd_merge_inbox)

    p_filed = sub.add_parser("inbox-filed-by", help="list pending filings by session")
    p_filed.add_argument("--inbox", type=Path, default=None)
    p_filed.add_argument("--session", action="append", required=True)
    p_filed.set_defaults(func=cmd_inbox_filed_by)

    p_finalize = sub.add_parser(
        "finalize-claims", help="release prepared claims proven durable in HEAD"
    )
    p_finalize.add_argument("--inbox", type=Path, default=None, help=argparse.SUPPRESS)
    p_finalize.add_argument("--answers", type=Path, default=None, help=argparse.SUPPRESS)
    p_finalize.set_defaults(func=cmd_finalize_claims)

    p_dec = sub.add_parser(
        "decisions", help="print Felix-facing blockers waiting on Felix"
    )
    p_dec.add_argument("ids", nargs="*", help="only these findings (default: all)")
    p_dec.set_defaults(func=cmd_decisions)

    p_answers = sub.add_parser(
        "apply-answers", help="fold answered decisions in and unblock them"
    )
    p_answers.add_argument("--answers", type=Path, default=None, help=argparse.SUPPRESS)
    p_answers.add_argument("--hold-consumer-lock", action="store_true", help=argparse.SUPPRESS)
    p_answers.set_defaults(func=cmd_apply_answers)

    p_answer = sub.add_parser(
        "answer", help="publish one answer atomically through the answers spool"
    )
    p_answer.add_argument("id")
    p_answer.add_argument("--actor", required=True)
    p_answer.add_argument("--reason", default="")
    p_answer.add_argument("--decision")
    p_answer.add_argument("--answers", type=Path, default=None, help=argparse.SUPPRESS)
    p_answer.set_defaults(func=cmd_answer)

    p_commit = sub.add_parser(
        "commit-ledger", help=argparse.SUPPRESS
    )
    p_commit.add_argument("--expected", type=Path, required=True, help=argparse.SUPPRESS)
    p_commit.add_argument("--expected-head", required=True, help=argparse.SUPPRESS)
    p_commit.add_argument("--subject", default=None, help=argparse.SUPPRESS)
    p_commit.set_defaults(func=cmd_commit_ledger)

    p_header = sub.add_parser(
        "set-header", help="update selected finding header fields"
    )
    p_header.add_argument("id")
    p_header.add_argument("--status", choices=sorted(STATUSES))
    p_header.add_argument("--blocked")
    p_header.add_argument("--root")
    p_header.add_argument("--entry", choices=sorted(ENTRIES))
    p_header.add_argument("--note-file", type=Path, help="append a note in the same mutation")
    p_header.set_defaults(func=cmd_set_header)

    p_annotate = sub.add_parser("annotate", help="append file contents to a finding")
    p_annotate.add_argument("id")
    p_annotate.add_argument("file", type=Path)
    p_annotate.add_argument(
        "--request-id", help="stable caller identity for one intentional repeat"
    )
    p_annotate.set_defaults(func=cmd_annotate)

    p_close = sub.add_parser("close", help="mark a finding handled and append its note")
    p_close.add_argument("id")
    p_close.add_argument("--note-file", type=Path, required=True)
    p_close.add_argument(
        "--request-id", help="stable caller identity for one intentional repeat"
    )
    p_close.set_defaults(func=cmd_close)

    p_record = sub.add_parser(
        "record-decision", help="append decisions through the decisions ledger lock"
    )
    p_record.add_argument("file", type=Path)
    p_record.add_argument("--section")
    p_record.add_argument(
        "--request-id", help="stable caller identity for one intentional repeat"
    )
    p_record.set_defaults(func=cmd_record_decision)

    p_trailer = sub.add_parser(
        "set-trailer",
        help="set decision supersession references under the ledger lock, "
        "adding the trailer to an entry that has none",
    )
    p_trailer.add_argument("id")
    p_trailer.add_argument("--superseded-by", nargs="+", required=True)
    p_trailer.set_defaults(func=cmd_set_trailer)

    p_driver = sub.add_parser(
        "merge-driver",
        help="git merge driver for the append-only ledgers (%%O %%A %%B %%P)",
    )
    p_driver.add_argument("base", type=Path)
    p_driver.add_argument("ours", type=Path)
    p_driver.add_argument("theirs", type=Path)
    p_driver.add_argument("path")
    p_driver.add_argument(
        "--carry-upstream",
        help="frozen upstream SHA for receipt-backed worktree carry",
    )
    p_driver.set_defaults(func=cmd_merge_driver)

    return parser


def main(argv: list[str] | None = None) -> int:
    global _ACTIVE_LEDGER_COMMIT, _GUARDED_LEDGER_PATHS
    global _EXPLICIT_ID_ALLOCATION_PATHS
    parser = build_parser()
    args = parser.parse_args(argv)
    root = _require_git_toplevel()
    if _plan_only_refuses(args):
        return 3
    _bind_repo_root(root)
    args._explicit_ledger = args.ledger is not None
    args._explicit_decisions = args.decisions is not None
    if args.ledger is None:
        args.ledger = LEDGER
    try:
        args.ledger = _canonical_ledger_path(args.ledger)
        if args.decisions is None:
            # An explicit ledger pairs decisions, the default inbox and the drain
            # lock with the checkout holding its canonical file, matching every
            # ledger lock and write target since f-20260915-09. A symlinked
            # tasks/findings.md belongs to the checkout holding the real file.
            # Mixing a fixture findings ledger with the real decisions ledger made
            # every cross-ledger citation check report the real ledger's ids as missing.
            args.decisions = args.ledger.parent / "decisions.md"
        args.decisions = _canonical_ledger_path(args.decisions)
    except (LedgerError, OSError, UnicodeDecodeError) as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1
    refusal = _vendored_writer_refusal(args)
    if refusal is not None:
        print(refusal, file=sys.stderr)
        return 3
    args._explicit_inbox = getattr(args, "inbox", None) is not None
    if getattr(args, "inbox", None) is None and hasattr(args, "inbox"):
        args.inbox = (
            args.ledger.parent / INBOX.name
            if args._explicit_ledger and _impact_queue_enabled()
            else INBOX
        )
    if getattr(args, "answers", None) is None and hasattr(args, "answers"):
        args.answers = ANSWERS
    if args.command == "file" and bool(getattr(args, "status", False)):
        try:
            return cmd_file_status(args)
        except (LedgerError, OSError, UnicodeDecodeError) as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            return 1
    if args.command == "set-header" and not any(
        value is not None
        for value in (args.status, args.blocked, args.root, args.entry)
    ):
        parser.error("set-header requires at least one field option")
    intent: LedgerCommitIntent | None = None
    if args.command in LEDGER_COMMIT_COMMANDS:
        target = (
            args.decisions
            if args.command in {"record-decision", "set-trailer"}
            else args.ledger
        )
        intent = LedgerCommitIntent(
            command=args.command,
            ledger=target,
            findings=args.ledger,
            decisions=args.decisions,
        )
        _ACTIVE_LEDGER_COMMIT = intent
    # Filing and answer consumers keep their shared lock until the automatic
    # exact-byte commit attempt finishes in the outer ``finally`` block.
    args._hold_consumer_lock = args.command == "file" or (
        args.command == "apply-answers"
        and bool(getattr(args, "hold_consumer_lock", False))
    )
    command_result: int = 1
    previous_explicit_paths = _EXPLICIT_ID_ALLOCATION_PATHS
    _EXPLICIT_ID_ALLOCATION_PATHS = _explicit_allocation_paths(args)
    previous_guard = _GUARDED_LEDGER_PATHS
    if _invocation_persists(args):
        _GUARDED_LEDGER_PATHS = {args.ledger: "findings", args.decisions: "decisions"}
    try:
        try:
            command_result = args.func(args)
        except (LedgerError, OSError, UnicodeDecodeError) as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            command_result = (
                2
                if isinstance(exc, (PublishLockBusyError, LedgerDirtyError))
                else 1
            )
    finally:
        commit_result: LedgerCommitResult | None = None
        try:
            if intent is not None:
                try:
                    commit_result = _attempt_ledger_commit(
                        intent,
                        warn=not (
                            args.command == "apply-answers"
                            and bool(getattr(args, "hold_consumer_lock", False))
                        ),
                    )
                    if (
                        args.command == "apply-answers"
                        and bool(getattr(args, "hold_consumer_lock", False))
                        and intent.replaced
                        and not commit_result.durable
                        and os.environ.get(LEDGER_COMMIT_ENV) != "0"
                    ):
                        if commit_result.durable_head:
                            _warn_ledger_commit(
                                intent,
                                commit_result.cause,
                                _save_ledger_commit_scratch(intent),
                                durable_head=commit_result.durable_head,
                            )
                            command_result = 3
                        else:
                            retry = _attempt_ledger_commit(intent, warn=False)
                            if retry.durable:
                                commit_result = retry
                            else:
                                _warn_ledger_commit(
                                    intent,
                                    retry.cause or commit_result.cause,
                                    _save_ledger_commit_scratch(intent),
                                    durable_head=retry.durable_head,
                                )
                                if "worktree ledger differs" in (retry.cause or ""):
                                    command_result = 2
                                else:
                                    print("ledger applied, commit failed", file=sys.stderr)
                                    command_result = 3
                except Exception as exc:  # noqa: BLE001
                    # This is the final status-transparency boundary: arbitrary
                    # consumer hooks and diagnostics must never replace the command's
                    # return value, SystemExit, or unexpected exception.
                    # The one mode that owns a durability contract reports its failure.
                    with suppress(OSError, UnicodeError):
                        _warn_ledger_commit(
                            intent, f"unexpected commit helper failure: {exc}", None
                        )
                    if (
                        args.command == "apply-answers"
                        and bool(getattr(args, "hold_consumer_lock", False))
                        and intent.replaced
                        and os.environ.get(LEDGER_COMMIT_ENV) != "0"
                        and command_result == 0
                    ):
                        print("ledger applied, commit failed", file=sys.stderr)
                        command_result = 3
        finally:
            try:
                if intent is not None:
                    _release_deferred_ledger_lock(intent)
            finally:
                _ACTIVE_LEDGER_COMMIT = None

        try:
            if (
                intent is not None
                and commit_result is not None
                and commit_result.durable
                and intent.finalize is not None
            ):
                try:
                    finalization = intent.finalize()
                except LedgerReadRefused:
                    raise
                except Exception as exc:  # noqa: BLE001
                    # The ledger write is already durable, so whatever the
                    # finalizer raised — a defect included — is not hidden: its
                    # text goes into the warning below, beside the one command
                    # that recovers the claim. Propagating would lose that command.
                    finalization = f"exception: {exc}"
                if finalization not in {FINALIZE_OUTCOME_FINALIZED, FINALIZE_OUTCOME_NONE}:
                    claim = _resolved_repo_path(intent.claim) if intent.claim else "(unknown claim)"
                    ledger = _resolved_repo_path(intent.ledger)
                    decisions = _resolved_repo_path(intent.decisions)
                    spool = (
                        claim.parent / intent.claim.name.removesuffix(".claim")
                        if intent.claim
                        else "(unknown spool)"
                    )
                    inbox = INBOX if intent.command == "apply-answers" else spool
                    writer = Path(__file__).resolve()
                    answers_option = (
                        f" --answers {_resolved_repo_path(spool)}"
                        if intent.command == "apply-answers"
                        else ""
                    )
                    print(
                        f"WARNING the ledger write for {ledger} after {intent.command} "
                        f"is durable, but the claim at {claim} was not finalised: "
                        f"{finalization}; run {writer} --ledger {ledger} "
                        f"--decisions {decisions} finalize-claims --inbox {inbox}"
                        f"{answers_option}",
                        file=sys.stderr,
                    )
        except LedgerReadRefused as exc:
            print(f"FAIL {exc}", file=sys.stderr)
            command_result = 1
        except Exception as exc:  # noqa: BLE001
            # The same status-transparency boundary as the commit above: the
            # ledger write is already durable, so a post-commit defect is
            # reported and never replaces the command's return value.
            with suppress(OSError, UnicodeError):
                if intent is not None:
                    _warn_ledger_commit(
                        intent,
                        f"could not report the claim finalisation: {exc}",
                        None,
                        durable_head=(
                            commit_result.durable_head
                            if commit_result is not None and commit_result.durable
                            else ""
                        ),
                    )
        finally:
            try:
                _release_consumer_lock(args)
            finally:
                _GUARDED_LEDGER_PATHS = previous_guard
                _EXPLICIT_ID_ALLOCATION_PATHS = previous_explicit_paths
    return command_result


if __name__ == "__main__":
    raise SystemExit(main())
