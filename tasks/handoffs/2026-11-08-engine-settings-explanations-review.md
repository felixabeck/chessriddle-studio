# Plan: Explain engine settings on the Engines page

## Goal
A non-technical user can understand every known engine setting on the Engines page: each
known UCI option shows a readable name and a one-line explanation, rarely needed options sit
in a collapsed "Expert settings" section, and the target Elo only appears when strength
limiting is on.

## MANDATE
Felix (2026-11-08): "There are a lot of settings here for the engine. Should we give some
explanations here? Because most of them are only clear for very technical users. I for example
didn't know many of those. So should we for example somehow explain those settings or make a
small information button next to each of those that explains what this feature does?"

Agent recommendation Felix approved ("Yes, this sounds very good. Let's do everything as you
recommend. Do this full auto on a separate worktree"):
1. Readable names with a one-line, always-visible note under each field (Mantine
   `description`), not ⓘ buttons. The original UCI name stays visible as small secondary text.
2. Rarely needed options in a collapsed "Expert settings" section. Threads, Hash, MultiPV and
   UCI_ShowWDL stay visible.
3. Dependent settings only when they apply: UCI_Elo only when UCI_LimitStrength is ticked.
Unknown options (other engines) keep their raw name, nothing is hidden. Names and notes in
English and German.

## Threat model and non-goals
Inputs: the option list an engine reports over UCI (`get_engine_config`), arbitrary names and
casing from any engine, plus stored settings in `localStorage` `engines`. No new native, IPC,
persistence or security surface. Non-goals: changing which values are stored, the analysis
panel sliders (`EngineSettingsForm.tsx`), remote engines, the go-mode/search settings, a
persisted open/closed state for the expert section.

## Traced premises
- `src/components/engines/EnginesPage.tsx` (`EngineSettings` body, ~l.386-650) builds
  `completeOptions` from `options.options` minus `button`, then renders two `SimpleGrid`s:
  non-check options (spin → `NumberInput`, combo → `Select`, string → `TextInput`, path-like
  string → read-only `TextInput` + Open button, file-like string → plain `Button` whose text is
  the raw name) and check options (`Checkbox`, `UCI_Chess960` disabled). Every label is the raw
  `v.name`.
- `src/utils/engines.ts:78-87` classifies resource options by `name.toLocaleLowerCase()`
  containing `path` / `file`.
- UCI says option names are not case sensitive; Stockfish reports `Debug Log File`,
  `NumaPolicy`, `Threads`, `Hash`, `Clear Hash` (button), `Ponder`, `MultiPV`, `Skill Level`,
  `Move Overhead`, `nodestime`, `UCI_Chess960`, `UCI_LimitStrength`, `UCI_Elo`, `UCI_ShowWDL`,
  `SyzygyPath`, `SyzygyProbeDepth`, `Syzygy50MoveRule`, `SyzygyProbeLimit`, `EvalFile`
  (older builds also `EvalFileSmall`).
- `docs/localization.md`: `pnpm i18n:check` requires a non-empty value in all 16 shipped
  catalogues (`src/translation/*.json`), keys must be literal in `t()` calls, `pnpm i18n:jsx`
  rejects hard-coded `label`/`description` text except `UCI_*`-style notation.
- `e2e/accounts-puzzles-engines.spec.ts` ("local settings and catalog upgrade modal") renders
  `/engines?selected=0` with Threads/Hash/MultiPV and pins `engine-settings-upgrade.png`.
- `src/components/engines/EnginesPage.test.tsx` drives SyzygyPath / resource options and the
  defaults flow through the rendered form.

## Approach

### A. Option catalogue (one source)
New module `src/components/engines/engineOptionCatalog.ts(x)`: maps a UCI option name, matched
case-insensitively, to `{ tier: "essential" | "expert", label, description }`, with label and
description produced through literal `t("Engines.Options.<Key>.Label" | ".Description")` calls
so extraction keeps them. Essential: Threads, Hash, MultiPV, UCI_ShowWDL. Expert: every other
known option. Unknown options: tier essential (rendered in the always-visible section, as
today), label = raw name, no description — the MANDATE says nothing about them is hidden. Exact English and
German copy is in "Copy" below; other locales get faithful translations of the English copy.

### B. Field rendering
Every rendered option field uses the catalogue label as its label (accessible name) and shows
the description plus the raw UCI name as small dimmed secondary text in the description slot
(raw name omitted when it equals the label). Check options use the Checkbox `description`.
File-resource options (EvalFile, Debug Log File) render inside an input wrapper carrying label
and description, with the existing folder button (text `Common.Open`) as the control — the
button no longer carries the raw name as its only text. Behaviour of every control (values,
`setSetting`, resource issuing, Chess960 disabled) is unchanged.

### C. Essential vs expert sections
Essential options render first, as today (non-check grid then check grid). Expert options render
in the same two-grid layout inside a Mantine `Collapse` below a toggle button
("Expert settings", with count), collapsed by default, local component state, not persisted.
No toggle when there are no expert options. The `configFailure` alert stays above both.

### D. Dependent option
When the engine reports UCI_LimitStrength, `UCI_Elo` renders directly after that checkbox in the check grid, so it appears where the user just ticked (browser pass, 2026-11-08). `UCI_Elo` is not rendered unless `UCI_LimitStrength` is currently checked (stored value, or
default when unstored). Hiding never changes or deletes the stored UCI_Elo value. When the engine
reports no UCI_LimitStrength, UCI_Elo renders normally.

### E. Verification
Unit tests cover catalogue matching (case-insensitive, unknown fallback), section placement
(unknown options visible while the expert section is collapsed),
collapse toggle, UCI_Elo dependency both ways, and that the existing resource tests still pass
after expanding the expert section. A catalogue test loads the shipped `en-US.json` and
`de-DE.json` with fallback disabled (`docs/localization.md`) and asserts, for every known option,
the exact label and description from "Copy" — so a wrong key mapping or a missing German value
fails. One e2e spec with a full Stockfish option list pins the
collapsed and expanded settings (all colour schemes/projects the spec already runs), and the
existing `engine-settings-upgrade.png` is re-recorded in the container only where the change
shows.

## Copy
| Key (UCI) | EN label | EN description | DE label | DE description |
|---|---|---|---|---|
| Threads | CPU threads | How many processor cores the engine uses. More cores make analysis faster. | CPU-Threads | Wie viele Prozessorkerne die Engine nutzt. Mehr Kerne machen die Analyse schneller. |
| Hash | Memory (MB) | Memory for positions the engine has already calculated. More helps long analyses; stay well below your free RAM. | Arbeitsspeicher (MB) | Speicher für bereits berechnete Stellungen. Mehr hilft bei langen Analysen; bleib deutlich unter deinem freien Arbeitsspeicher. |
| MultiPV | Number of lines | How many best moves the engine shows at once. More lines make each one a little less deep. | Anzahl der Varianten | Wie viele beste Züge die Engine gleichzeitig zeigt. Mehr Varianten rechnen jede einzelne etwas weniger tief. |
| UCI_ShowWDL | Show win/draw/loss chances | Shows the chances of a win, draw or loss next to the evaluation. | Gewinn-/Remis-/Verlustchancen zeigen | Zeigt neben der Bewertung die Chancen auf Gewinn, Remis oder Verlust. |
| SyzygyPath | Endgame tablebase folders | Folders with Syzygy tablebases. With them the engine plays endgames with few pieces perfectly. | Ordner der Endspieldatenbanken | Ordner mit Syzygy-Endspieldatenbanken. Damit spielt die Engine Endspiele mit wenigen Steinen perfekt. |
| SyzygyProbeDepth | Tablebase probe depth | Minimum search depth before the engine asks the tablebases. Raise it if they are on a slow drive. | Abfragetiefe der Endspieldatenbanken | Mindesttiefe, ab der die Engine die Endspieldatenbanken abfragt. Erhöhe sie, wenn sie auf einem langsamen Laufwerk liegen. |
| SyzygyProbeLimit | Tablebase piece limit | The engine uses the tablebases only with at most this many pieces on the board. | Steinlimit der Endspieldatenbanken | Die Engine nutzt die Endspieldatenbanken nur bei höchstens so vielen Steinen auf dem Brett. |
| Syzygy50MoveRule | Respect the 50-move rule | Counts tablebase wins that need more than 50 moves as draws, as in real games. | 50-Züge-Regel beachten | Wertet Gewinne aus den Endspieldatenbanken, die mehr als 50 Züge brauchen, wie in echten Partien als Remis. |
| EvalFile | Evaluation network | Replaces the neural network the engine uses to judge positions. Leave it unless you need a specific one. | Bewertungsnetz | Ersetzt das neuronale Netz, mit dem die Engine Stellungen bewertet. Lass es so, außer du brauchst gezielt ein anderes. |
| EvalFileSmall | Small evaluation network | Replaces the second, faster network. Leave it unless you need a specific one. | Kleines Bewertungsnetz | Ersetzt das zweite, schnellere Netz. Lass es so, außer du brauchst gezielt ein anderes. |
| Skill Level | Skill level | Makes the engine play weaker on purpose (0 = weakest, 20 = full strength). Only matters when it plays against you. | Spielstärke-Stufe | Lässt die Engine absichtlich schwächer spielen (0 = am schwächsten, 20 = volle Stärke). Wirkt nur, wenn sie gegen dich spielt. |
| UCI_LimitStrength | Limit strength to an Elo rating | Makes the engine play at the Target Elo you set. Only matters when it plays against you. | Spielstärke auf eine Elo-Zahl begrenzen | Lässt die Engine mit der eingestellten Ziel-Elo spielen. Wirkt nur, wenn sie gegen dich spielt. |
| UCI_Elo | Target Elo | The playing strength the engine aims for while the limit is on. | Ziel-Elo | Die Spielstärke, die die Engine bei aktiver Begrenzung anstrebt. |
| Ponder | Think on your time | The engine keeps thinking while it waits for your move. Only matters when it plays. | In deiner Bedenkzeit rechnen | Die Engine rechnet weiter, während sie auf deinen Zug wartet. Wirkt nur, wenn sie spielt. |
| Move Overhead | Move overhead (ms) | Time kept back per move for delays in the app or network, so the engine does not lose on time. | Zeitpuffer pro Zug (ms) | Zeit, die die Engine pro Zug für Verzögerungen in App oder Netzwerk zurückhält, damit sie nicht auf Zeit verliert. |
| nodestime | Nodes as time | Testing setting: counts thinking time in calculated positions instead of seconds. Keep 0. | Knoten als Zeit | Testeinstellung: zählt Bedenkzeit in berechneten Stellungen statt in Sekunden. Bei 0 lassen. |
| NumaPolicy | Processor memory policy | How threads are spread across processors on machines with several CPUs. Keep “auto”. | Prozessor-Speicherrichtlinie | Wie die Engine Threads auf Rechnern mit mehreren Prozessoren verteilt. Bei „auto“ lassen. |
| UCI_Chess960 | Chess960 | Fischer Random rules. The app switches this on by itself for Chess960 games. | Chess960 | Regeln für Fischer-Random-Schach. Die App schaltet das bei Chess960-Partien selbst ein. |
| Debug Log File | Debug log file | Writes all communication with the engine to a file. Only needed to diagnose problems. | Debug-Logdatei | Schreibt die gesamte Kommunikation mit der Engine in eine Datei. Nur zur Fehlersuche nötig. |
| (toggle) | Expert settings ({{count}}) | — | Experteneinstellungen ({{count}}) | — |

## Decisions and trade-offs
Decided autonomously (full auto):
- Explanations always visible, not tooltips: discoverable without hovering; Mantine already has a
  description slot. Rejected: ⓘ tooltips (hidden, poor on touchpads).
- Unknown options stay in the visible section with their raw name (plan review r1, P-1: the
  approved recommendation promised nothing is hidden). Rejected: collapsing them as expert.
- Collapse state is not persisted: rare-use section, no persisted-state surface added.
- All 16 locales get translations: `pnpm i18n:check` requires them (technical consequence of
  the EN+DE mandate).
- Analysis-panel sliders are untouched: they already use translated names.

## Risks / open questions
- Existing unit/e2e tests that locate resource options by raw-name button text must expand the
  expert section first; they change only in locating, not in asserted behaviour.

## Not part of this task
Analysis panel engine form, remote/cloud engine forms, any change to stored settings or defaults,
new tooltips elsewhere.

## Phases
### Phase 1 — catalogue, rendering, sections, dependency, translations, tests
Files: `src/components/engines/engineOptionCatalog.ts(x)` (new), `EnginesPage.tsx`,
`EnginesPage.test.tsx` (+ new catalogue test), `src/translation/*.json` via `pnpm i18n:extract`
then filling every locale, `e2e/accounts-puzzles-engines.spec.ts` (new full-option-list test).
Role: normal. PROOF COMMAND:
`pnpm exec tsgo --noEmit && pnpm i18n:extract && pnpm i18n:jsx && pnpm i18n:check && pnpm exec vitest related --run <changed paths>`
Snapshots are recorded by the orchestrator in step 7 (container), not by the leaf.

## Reviews
### Round 1 (r1)
- review-plan: REVISE. P-1 [blocker] unknown options hidden in collapsed section contradicts MANDATE "nothing is hidden" → Fix: unknown options render in the visible section (Approach A/E, Decisions). P-2 [blocker] verification does not prove shipped EN/DE catalogue mapping (tests echo keys) → Fix: catalogue test against shipped en-US/de-DE with fallback disabled (Approach E).
- review-minimalism: APPROVED, no findings.
- review-engine-protocol: NOT APPLICABLE (no process/UCI/async change), APPROVED.
Adopted r1 = 2.

### Round 2 (r2)
- review-plan: APPROVED. P-1 CLOSED, P-2 CLOSED.
Adopted r2 = 0.

## Diff review
### d1 (7fd1baf4)
- review-correctness: REVISE. C-1 stored/reported name casing mismatch hides Target Elo → Skip: the rule reads the same value the checkbox renders; stored names are written from the engine's own reported name; no observed failure.
- review-tests: T-1 should-fix, no combo-field regression anchor → Fix (EnginesPage.test.tsx NumaPolicy combo test).
- review-root-cause, review-code-quality, review-minimalism: APPROVED. review-engine-protocol: NOT APPLICABLE.
- Browser pass (orchestrator, container screenshots), Fix: inputs misaligned by note length; raw name ran on from the sentence; file options' Open button inline with label; Target Elo far from its checkbox and note said "below"; separator stranded at line end; expanded screenshot hid the expert fields; Remove button under the refusal toast in an older e2e test.
### d2 (6f0c6622)
- review-correctness: C-2 uci_chess960 not disabled (case-sensitive compare) → Fix. T-1 closed. review-tests, review-code-quality: APPROVED.
### d3 (5e285e78)
- review-correctness: C-2 CLOSED. review-tests: C-2 CLOSED. Both APPROVED.
diff_adopted_per_round: r1=1 r2=1 r3=0
