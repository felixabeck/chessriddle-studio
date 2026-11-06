# Coverage gates

`pnpm coverage:frontend:check` applies two independent checks to every frontend area:

- The baseline ratchet independently rejects a lower covered count or a lower coverage ratio;
  deliberately, it does not reject a larger total when covered code grows with it. Both comparisons
  run against a baseline shrunk by however many records the measurement lost, because deleting a
  covered record lowers `covered` and `total` together and would otherwise fail both clauses — the
  ratio included, since `(c-1)/(t-1) < c/t` for every ratio below 1. When the total does not shrink
  the allowance is zero and the rule is arithmetically identical to the one before it.
- `minimumCoverage` in `coverage-areas.json` rejects a report below the permanent line,
  function, or branch floor for that area.

The allowance says `shrink`, not `deleted`, on purpose. A smaller denominator is the only thing
observable from four aggregate numbers: they cannot tell "one covered record was deleted" apart from
"one uncovered record was deleted and another lost its tests", and this repository has measured that
~170 `BRDA` block/branch identities flip per build without any source change. Record-level baselines
would settle it and are ruled out by that same instability — they would be permanently red. So the
allowance is **bounded** by the observed shrink, and every use that actually changes a verdict is
printed by `coverage-report.mjs`, landing in the CI log instead of being applied silently. A shrink
that would have passed anyway reports nothing.

One consequence worth stating plainly: `scopeSignature` and the blank-measurement check are the two
guards against narrowing the measured set. A wholesale narrowing looks exactly like a deletion once
the numeric backstop is gone, so any future mechanism that changes *what gets measured* — an
exclusion in `rust-branch-coverage.mjs`, a new include/exclude glob — must be expressed through the
config so it reaches that signature, or the narrowing becomes invisible.

Backend sources can declare `excludeTestOnlyItems` to remove Rust items and module files whose cfg
predicate is definitely false with `test` set to false and other atoms unknown. The coverage gate
scans included Rust files before applying exclude globs, then filters those lines and files from its
report; the exporter and its LCOV artifact remain unchanged.

**A narrowing can also arrive through the test suite, where the numeric ratchets do not look.**
An eager `?raw` import of a file inside the coverage include set registers that file in the v8
coverage map as a string module with no coverable statements. Vitest generates empty-but-counted
coverage only for files *absent* from that map, so the file is then reported as `LF:0 FNF:0 BRF:0`
instead of its real uncovered counts — it silently leaves the denominator. Measured: a single raw import of one
file zeroes exactly that file and nothing else; an eager `import.meta.glob` of `src/**` with
`query: "?raw"` in one test file zeroed 91 of 232 production files between 2026-09-19 and
2026-09-20, taking the reported `settings` line coverage from 13.39 % to 98.88 % while the gate
stayed green (`f-20260920-18`).

**The class is narrower than that, and the bound was measured on 2026-09-22.** Only a file that no
test imports as a *module* can be blanked this way, because only such a file is absent from the v8
map and therefore depends on the generated counts the raw import displaces. Raw-importing
`src/utils/format.ts`, which other tests import normally, left it at `LF:56 LH:19 FNF:18 FNH:6
BRF:35 BRH:7` — its ordinary measurement — and the gate stayed green. Raw-importing
`src/components/boards/EditingCard.tsx`, which nothing imports, took it from `LF:19` to
`LF:0 FNF:0 BRF:0`. The 91 files that `f-20260920-18` blanked were, consistently with this, exactly
the 91 with non-zero totals and zero hits. The practical reading: the defect hides in the untested
part of the tree, where it is least likely to be noticed and where the reported ratio improves
most.

Nothing catches this numerically, in either direction of arrival. The covered counts never move —
a blanked file contributed no covered records before or after — so neither ratchet clause fires,
and the shrink allowance above forgives the vanished totals by construction. Measured: a broken
measurement passes against the pre-existing baseline *and* against a baseline written from a
repaired run. Only the reverse fails, loudly: a repaired measurement checked against a baseline
written from a broken run reports a ratio regression. So refreshing a baseline from a corrupted
measurement is the trap to avoid above all — afterwards the repair itself looks like the
regression, and the cheapest green is to keep the instrument broken.

Both gates are enforced by one script, and its own failure surface is recorded rather than
assumed: the complete failure matrix — every path it can fail on, how each was staged, and the
message and exit status each was seen to produce — is the header comment of
`scripts/coverage-report.mjs`. It lives there rather than here because that is the artefact, and
this is documentation adjacent to it. Cite that script's green result as evidence only alongside
what the matrix says it does not cover.

The blank-measurement check now enforces this class mechanically: a measured file with zero line,
function, and branch records fails unless it is declared under `statementFree`. The residual hole
is deliberate and narrow: condition 3 cannot tell that a declared file gained statements if it is
also raw-imported and therefore remains blank. That limitation covers only the declared
statement-free files, not the whole measured set.

The practical rule: a test may read source text off disk, but **must not import a file inside
`src/**/*.{ts,tsx}` through `?raw`, `?url` or `?inline`**. Raw imports of files outside that set —
`src-tauri/**`, `.github/**`, `@/catalogs/*.json` — are unaffected and are used deliberately. If a
source scan needs the whole renderer tree, it belongs in a `scripts/**` checker, where several
already live, not in a renderer test.

If a new production file is genuinely statement-free, declare its literal path under
`statementFree` with a reason, then re-record the `scope` subtree in the relevant baseline by
hand. Leave `areas` untouched and prove the edit is scope-only by comparing the parsed committed
baseline with the parsed working-tree baseline; the hand-edit procedure is also the route for a
changed declaration.

Every area has a permanent, behavior-derived floor calibrated below its verified baseline; the
floor prevents broad test-suite collapse while the exact-count baseline catches smaller
regressions. Settings (2% lines, 3% functions, 1% branches) is backed by directory-workspace
success, failure, and duplicate-submit controller tests. Puzzles/Engines (5% lines, 6%
functions, 1.5% branches) is backed by workspace/download mutation success and failure tests
plus engine lifecycle/analysis IPC controller tests. Raise floors when additional central flows
are covered; never lower them to accept a regression.

The backend uses the same two-layer policy, measured on production code only: every item, statement
and module file compiled only under `test` leaves the measurement (`excludeTestOnlyItems`,
`d-20260927-24`), so a test's own code can neither raise nor lower an area. Each floor is
`floor(covered/total × 100)` of the CI measurement it was re-derived from (2026-09-28, CI run
36355498319): app infrastructure 81/73/47%, filesystem boundaries 81/53/45%, OAuth and credentials
64/58/59%, database and search 86/71/71%, engine, game, and chess 78/78/62%, and auxiliary domain
services 75/58/90% (lines/functions/branches). Before that re-derivation the backend measured its
own `#[cfg(test)]` code, which inflated most areas by 15 to 30 points (`f-20260829-04`). The
exact-count baseline catches changes above those floors; new security or IPC surfaces require
focused tests before the baseline is refreshed.

After adding coverage, deliberately refresh the frontend baseline so the new gains become
binding. First require a green full coverage run against the existing baseline. Obtain the
`frontend-coverage` LCOV artifact from a successful `Test` run in `felixabeck/chessriddle-studio`,
verify that its frontend source, dependencies, test configuration and coverage scope match
the candidate tree, and compare its area metrics with a fresh local `pnpm test:coverage`.
Do not use an old artifact across changed measurement inputs. Require every covered count
and ratio to stay level or rise without using a shrink allowance; otherwise investigate
the difference separately rather than including it in an upward refresh.

Record the CI run, commit, artifact, all metric deltas and the reasoned exception in the
task records before committing the refresh. Use the existing `coverage-report.mjs`
baseline writer with that CI LCOV, then run `pnpm coverage:frontend:check` against the
fresh local LCOV and the normal push gates. A baseline write refuses any decrease in a
covered count or ratio, and any change to the recorded scope or area set, unless
`--instrument-change <d-id> --finding <f-id>` names a decision in `tasks/decisions.md`
whose `Governs:` line names that finding. The writer prints every per-area, per-metric
delta before deciding and applies no shrink allowance. Upward refreshes still follow the
CI-artifact procedure above. Never refresh automatically during tests or to clear a red
gate. The 2026-09-11 refresh follows this procedure under `d-20260911-02` in
`tasks/decisions.md`.
