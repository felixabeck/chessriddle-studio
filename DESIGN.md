# ChessRiddle Studio design system

ChessRiddle web is the visual source of truth. Copy executable values from
`chess-tactics-app/frontend/web/src/app/globals.css` and the implemented
`src/components/ui/` controls. Executable CSS takes precedence over ChessRiddle's
`.claude/DESIGN.md` prose. There is no shared token package or automatic sync.

`src/styles/theme.ts` is the single executable home of the copied values.
`appCssVariablesResolver` publishes the light and dark `--cf-*` variables and maps
Mantine's body, text, border and semantic variants onto them. `dimThemeCss` emits
the Dim overrides for a root that carries both Mantine's
`data-mantine-color-scheme="dark"` and `data-cf-theme-variant="dim"`;
`ThemeVariantSync` renders that stylesheet and sets or removes only
`data-cf-theme-variant`. Use these variables instead of repeating colour values
at call sites.

Dim is a variant of Dark, not a third Mantine colour scheme. It overrides the
surface tokens (page, card, inset, interactive, borders, muted text, elevated
shadow, eval-bar-dark) copied from ChessRiddle's `.dark.dim` block and inherits
Dark's accents (gold, charts, feedback, tiers, square highlights). Dim applies
only while the explicit scheme is Dark with the Dim variant stored; choosing Dim
sets both. Auto follows the system light or dark scheme and never yields Dim.

## Tokens and surfaces

| Tokens | Meaning |
| --- | --- |
| `background`, `foreground` | Page surface and body text |
| `card`, `card-foreground`, `popover`, `popover-foreground` | Panels and floating content |
| `surface-inset` | Nested containers inside cards |
| `interactive`, `interactive-hover`, `inset` | Pressable controls, hover and readonly overlays |
| `bar-hover` | Hover fill for controls on the navigation row's `surface-inset` bar; a clearly visible warm step, since `interactive-hover` sits almost on the bar colour |
| `primary`, `primary-foreground`, `ring` | Fixed gold actions, contrasting text and focus |
| `secondary`, `secondary-foreground`, `muted`, `muted-foreground`, `accent`, `accent-foreground` | Supporting surfaces and text |
| `destructive`, `destructive-foreground`, `warning`, `warning-foreground` | Error and warning feedback |
| `border`, `border-strong`, `input` | Separators, strong separators and fields |
| `chart-1` through `chart-8` | Statistics and categorical chart colours |
| `move-correct`, `move-incorrect` | Strong correction and incorrect-move feedback |
| `eval-bar-dark`, `eval-bar-light`, `eval-bar-center` | Evaluation presentation |
| `tier-*`, `square-highlight-*`, `resize-handle` | Copied specialised reference tokens |
| `shadow-card`, `shadow-card-dark`, `shadow-elevated`, `shadow-gold` | Quiet cards, floating surfaces and primary hover |

The golden rule is to alternate surface tiers. A page uses `background` (tier 0),
its cards use `card` (tier 1), and nested groups use `surface-inset` (tier 2).
Interactive controls inside inset containers use `interactive`. In dark mode this
makes them recessed, and `interactive-hover` lifts them on hover. Text fields read
their fill from `--cf-field-fill`: a tier-2 container that hosts fields sets it
(and `--cf-field-fill-hover`) to the interactive pair, and `Paper` resets it so a
card nested inside keeps the card-tier fill. Separators drawn on a `surface-inset`
container use `border-strong`, because `border` is nearly the inset fill itself. Cards have a
border and no default shadow. `Paper` and `Card` support `variant="inset"`.

The exact muted-foreground token stays available. Mantine's secondary text is
contrast-adjusted for readability across the three surface tiers.

Cards on a page or in a catalogue dialog sit `md` (16px) apart, horizontally and
vertically. Rows of cards stacked on one page share one column grid so their edges
line up. Card pages keep the same `md` margin to the window edge, and neighbouring
columns start at the same height. Compact tiles inside a panel or card, and the
resizable board and database workspaces, may use a smaller gap.

Single-column pages whose rows pair a label with a value or control (Settings, New Tab) centre
their content in a column of `--cf-page-column` (60rem, `src/styles/global.css`), so the two ends
of a row stay within one glance on wide windows. New Tab widens that column only as far as its
action row needs to stay on one line (longer labels, such as German). The Guide caps its prose
by line length (80ch) instead. Two-pane pages (Library, Engines) and the board keep the full
width.

## Typography and radii

Inter is the sans and heading family. JetBrains Mono is for notation, logs and
code. Self-hosted subsets cover Latin, extended Latin, Cyrillic, extended Cyrillic,
Greek and Vietnamese. System fonts provide scripts such as CJK. Merida supplies
U+2654–U+265F within both families. Font declarations and fallback metrics live in
`src/styles/fonts.css`, assets and redistribution notices in `public/fonts/`.
Every face uses swap display and loads offline under the existing CSP.

The theme defines ChessRiddle's heading, title, body and caption scale. Labels use
medium weight, headings use semibold or bold, and numeric displays use tabular
Inter figures. Preserve the compact notation and engine-line spacing.

No rendered text is smaller than 12px (the theme's `xs`) at the default font size. Two things are
exempt: text that scales with the board, such as its coordinates, and the ON/OFF word inside a
switch track. Bar labels and badges are held at the floor centrally (`src/styles/Progress.module.css`,
`src/styles/Badge.module.css`), so a low bar or a small badge cannot print smaller text. A spot
that reads too small at 12px is raised on its own; there is no rule that controls or labels use a
larger size.

Choose radius by actual control dimensions: xs 4px, sm 8px, md 12px, lg 16px, or
full. Checkboxes use xs, compact controls sm, small buttons md, standard inputs
and cards lg, and switches, segments and badges use full.

## Controls

| Mantine variant or control | ChessRiddle treatment |
| --- | --- |
| Button `filled` | Primary gold, contrasting text, gold hover shadow |
| Button `default`, `light` | Secondary interactive fill and quiet primary border |
| Button `subtle`, `transparent` | Ghost text and a visible hover surface |
| Button `danger` colour | Destructive feedback or action |
| Tabs | Tinted active pill in default, outline and pills variants; the active label is `--cf-foreground` so it reads at 4.5:1 on the inset list in Dim |
| Window tabs (navigation row only) | Browser tabs on a `--cf-surface-inset` bar; the current item takes `--cf-background` and merges into the page through a gap in the bar's bottom border; other items are flat and take `--cf-bar-hover` (warm beige) on hover, as do the other controls on the bar |
| SegmentedControl | Inset pill shell, card indicator and gold ring |
| Inputs and select triggers | Inset or interactive fill, primary focus border and ring |
| Combobox, Menu, Popover | Card surface, quiet gold border, rounded selected options; the selected label is `--cf-foreground` so it reads at 4.5:1 on the 10% gold pill in Dim; hovered items and the application-menu button take the `--cf-primary-hover` gold tint, never a gray |
| Data tables | Hovered rows and sortable headers take the lighter, opaque `--cf-primary-row-hover` gold tint; a selected row keeps its own fill |
| Notation moves | A plain move takes the translucent `--cf-move-hover` (warm beige) on hover, which reads on the card and on inset variation blocks and engine lines and stays quieter than the current move; the current move takes a gold fill and quiet gold ring, and a previewed engine-line move the same gold fill; annotated moves keep their annotation hue in `--cf-annotation-<hue>-text` (Mantine shade 6 half-mixed with black in light, shade 3 in dark; in Dim, red annotation text is shade 3 mixed 85% with white), which reaches 4.5:1 on the card, the inset blocks and the current-move fill; the report's move-quality table and the evaluation-chart tooltip write marks in the same variable; moves after the game end are italic, and an unannotated one takes the dimmed secondary colour `--mantine-color-dimmed` that variations use — never reduced opacity, which would pull text below 4.5:1; on the analysis board, where a file is built, an open variation (a side line one move long) takes a 1px dashed frame in `--cf-open-variation`, painted over the cell 3px inside its top and bottom so its size, text colour and fill are untouched and frames in consecutive rows stay apart, and the tree stats line writes its count in the same variable: the info hue, which no move-quality mark uses, mixed 80% with black in light, 70% with white in dark and 55% with white in Dim, so it reads as text at 4.5:1 on the card, the page and the inset blocks of each scheme |
| Checkbox, Switch | Gold checked state, square checkbox and card switch thumb |
| Badge | Primary, muted or semantic tinted pill with inset ring |
| Slider, RangeSlider, Progress | Primary or explicit semantic fill |
| Board clocks | White and black papers from the eval-bar pair at full opacity; whose turn is a gold inset ring. Never reduced opacity, which would pull the digits below 4.5:1 |
| Practice rare-move rows, engine stats Group, inert engine lines, game-list index, and FenSearch suggestion FEN | Take `--mantine-color-dimmed` at full opacity — never reduced opacity, which would pull text below 4.5:1 |
| Accordion | Gold-tinted open header with a quiet ring; the open label is `--cf-foreground` so it reads at 4.5:1 on the 10% gold pill in Dim |
| Tooltip, AppModal, Notification | Bordered card surface and appropriate elevation |

Focus visibility is required. Buttons, checkbox/switch, segments, and text fields
retain their distinct focus treatments. Respect reduced motion and hover capability.
Icon-only actions go through `IconAction`, dialogs through `AppModal`.

Mantine's built-in named palettes remain default except the explicitly warm `dark`
scale. New `danger`, `success`, `warning`, `info` palettes carry chrome feedback.
`warning` is distinct from the warm brown `chart-4` used by warning badges, and
info badges use `chart-1` while the info palette derives from `chart-6`.
Engine arrow hues, NAG annotation colours, drawing brushes, premove/check overlays
and existing per-board coordinate colours retain their board meaning. A glyph or label drawn on a
mark's filled hue (the board badge and the active Annotate button) takes
`--cf-annotation-<hue>-on-fill`: black or white, whichever contrasts more with the filled shade.
On every move-quality hue that is black in both schemes, because white falls to 1.43:1.

## Icon identities

ChessRiddle Studio follows ChessRiddle web's icon split: raw system emoji (the catalogue
`emoji` layer in `chess-tactics-app/frontend/shared/icon-catalog.json` and
`frontend/web/src/lib/constants/icons.ts`) identify features and sections such as nav sections,
Guide entries, and puzzle modes, while `lucide-react` (`ui` layer) supplies actions and utilities
such as buttons, application menu items, and page tabs. New emoji slots render through the shared decorative `<Emoji>` primitive (`src/components/common/Emoji.tsx`); the Guide and Settings sidebars predate it and still style their own `aria-hidden` spans. All use the system
colour-emoji font stack (`"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`)
rather than the bundled text font.

### One concept, one icon

Feature and section identities, emoji and lucide alike, come from one catalogue:
`src/components/common/iconCatalog.ts` (`EMOJI_IDENTITIES`, `LUCIDE_IDENTITIES`). Surfaces ask for
a concept by name (`emojiOf("repertoire")` for emoji, the named export `EngineIcon` for lucide) and
never write a glyph or import an identity icon from `lucide-react` directly. `LUCIDE_IDENTITIES` is
read only by the test, so unused icons stay out of the entry chunk. Two rules hold, and `iconCatalog.test.ts` enforces both:

* **Same concept, same icon; different concepts, different icons.** A concept shown in two places
  (Board → Arrows & drawing and the Drawing shortcuts) is one entry used twice. Two entries never
  share a glyph or lucide export. The only exceptions are listed in `ACCEPTED_EMOJI_OVERLAPS`:
  🗂️ for Tabs & files and the All filter, ♟️ for Board settings and Games (kept by Felix,
  2026-11-25).
* **ChessRiddle meanings are kept.** A glyph or lucide export that ChessRiddle also shows must
  mean the same thing here, and its entry names the ChessRiddle identity in `chessRiddle`. The
  test checks this against `src/components/common/chessRiddleIconSnapshot.json`, a copy of
  ChessRiddle's `frontend/shared/icon-catalog.json` resolved to glyph → identities. Re-copy it
  when ChessRiddle's catalogue changes; a new clash then fails the test.

The Guide topic emoji in `src/components/assistant/topics/order.ts` stay literal, because the
website's Studio guide parses that file as text (`frontend/web/src/lib/studio/studioGuide.ts`);
the test checks that each of them is a catalogue glyph. Puzzle motif glyphs in
`src/components/chessriddle/motifCatalog.ts` are ChessRiddle's own content, not Studio
identities, and stay outside the catalogue. Action and status icons (close, save, a settings gear
on a button, an info alert) are not identities and follow the table below.

### Lucide icons

Every migrated icon imports from `lucide-react`, pinned exactly to `1.61.0`, the
ChessRiddle version. The navigation row uses monochrome catalogue `ui` identities. The
following table records the implemented mapping. Reference paths are relative to
`chess-tactics-app/frontend/`. A source reference identifies the matched artwork
and meaning. Entries marked closest by meaning have no exact reference slot.

| ChessRiddle Studio slot | Lucide export | ChessRiddle web source or fallback |
| --- | --- | --- |
| Board, play and game tabs | `ChessKnight` | `shared/icon-catalog.json:664` |
| Account and human opponent | `User` | `shared/icon-catalog.json:655` |
| Library tab in the navigation row | `Library` | `shared/icon-catalog.json:790` |
| Engines page item, local engine portraits and computer opponent | `Brain` | `web/src/components/analysis/EnginePanel.tsx:272` |
| Settings and engine configuration | `Settings` | `shared/icon-catalog.json:793` |
| Privacy category | `Shield` | `shared/icon-catalog.json:676` |
| Puzzle tabs and puzzle file icon | `Puzzle` | `shared/icon-catalog.json:757` |
| Tournament | `Trophy` | `shared/icon-catalog.json:721` |
| Engine rating and engine download size | `Gauge`, `HardDriveDownload` | Closest by meaning |
| Information and help | `Info` | `shared/icon-catalog.json:697` |
| Analysis tabs and actions | `ScanSearch` | `web/src/components/analysis/AnalyzePuzzleButton.tsx:60` |
| First, previous, next, last move | `ChevronFirst`, `ChevronLeft`, `ChevronRight`, `ChevronLast` | `web/src/components/analysis/ControlButtons.tsx:39`, `web/src/components/analysis/ControlButtons.tsx:48`, `web/src/components/analysis/ControlButtons.tsx:57`, `web/src/components/analysis/ControlButtons.tsx:66` |
| Start and pause one or all engines | `Play`, `Pause` | `web/src/components/puzzle/MoveAnnouncerControls.tsx:149`, `web/src/components/puzzle/MoveAnnouncerControls.tsx:149` |
| Delete move, game, file, database or account | `Trash2` | `web/src/components/puzzle/DeleteMoveAffordance.tsx:30` |
| Line section in a repertoire | `SeparatorHorizontal` | Closest by meaning |
| Close tab, cancel and clear session | `X` | `web/src/components/ui/Modal.tsx:188` |
| Copy and copy confirmation | `Copy`, `Check` | `web/src/components/entityEditor/EntityEditorHeader.tsx:161`, `web/src/components/puzzle/MoveInputPanel.tsx:261` |
| Challenge results: correct, incorrect and incomplete | `CircleCheckBig`, `CircleX`, `CircleEllipsis` | `web/src/components/puzzle/PuzzleFeedbackCard.tsx:61` |
| Show and hide notation | `Eye`, `EyeOff` | `web/src/components/ui/PasswordField.tsx:57`, `web/src/components/ui/PasswordField.tsx:57` |
| Search inputs | `Search` | `web/src/components/ui/SearchInput.tsx:60` |
| Expand analysis or repertoire line | `ChevronDown` | `web/src/components/analysis/EngineAnalysisLines.tsx:188` |
| Collapse repertoire line | `ChevronRight` | `web/src/components/analysis/VariationMoveList.tsx:142` |
| Promote variation or mainline | `ArrowUpRight` | `web/src/components/analysis/VariationMoveList.tsx:394` |
| Back from database | `ArrowLeft` | `web/src/components/entityEditor/EntityEditorHeader.tsx:113` |
| Next and previous database record, return to practice position | `ArrowRight`, `ArrowLeft` | `web/src/components/puzzle/ReviewActionDock.tsx:22`, `web/src/components/entityEditor/EntityEditorHeader.tsx:113` |
| Rename and edit metadata | `Pencil` | `web/src/components/profile/ProfileHeader.tsx:71` |
| Repertoire file and review | `BookBookmark` | Closest by meaning (ChessRiddle's `BookOpen` is homework) |
| Coach panel and Assistant (both AI chats) | `MessagesSquare` | Closest by meaning |
| Start a new Coach conversation | `MessageSquarePlus` | Closest by meaning |
| Insert a Coach line as a variation | `ListPlus` | Closest by meaning |
| Upload engine portrait | `ImagePlus` | `web/src/components/feedback/FeedbackModal.tsx:396` |
| Refresh account or engine logs | `RefreshCw` | `web/src/components/settings/AccountSettings.tsx:291` |
| Reset keybindings or reload file | `RotateCcw` | `web/src/components/settings/SettingsSidebar.tsx:97` |
| Error alerts | `AlertCircle` | `web/src/components/entityEditor/EntityAutosaveStatus.tsx:32` |
| Authenticated account status | `CircleCheckBig` | Closest by meaning, reference success status uses the same icon in `web/src/components/history/AttemptHistoryItem.tsx:59` |
| More actions | `Ellipsis` | `web/src/components/profile/ProfileActionsMenu.tsx:71` |
| Engine drag and resize handles | `GripVertical` | `web/src/components/entityEditor/SortableReorderList.tsx:20` |
| Application menu button (beside the ChessRiddle logo) and the all-tabs list | `ChevronDown` | Closest by meaning |
| Application menu items (new tab, open file, save, save to database, accounts, engines, settings, fullscreen, guide, assistant, send feedback, about, exit) | `Plus`, `FolderOpen`, `Save`, `Database`, `User`, `Brain`, `Settings`, `Maximize`, `Info`, `MessagesSquare`, `MessageSquarePlus`, `Castle`, `LogOut` | Reuses each action's slot icon in this table; About `Castle` and Fullscreen `Maximize` closest by meaning, Exit `LogOut` is `shared/icon-catalog.json:711` (`signOut`) |
| Guide page tab and Guide menu item | `Info` | `shared/icon-catalog.json:714` (`guide`) |
| Send feedback (Feedback button at the right end of the navigation row, and its menu entry) | `MessageSquarePlus` | `web/src/components/feedback/FeedbackButton.tsx:47` (`UI_ICONS.feedback`) |
| Add an account | `UserPlus` | `shared/icon-catalog.json:700` |
| Download account games | `Download` | `web/src/components/legal/WithdrawalFormLink.tsx:1` |
| Practice streak | `Flame` | `shared/icon-catalog.json:763` |
| Captured pawn and knight | `ChessPawn`, `ChessKnight` | `shared/icon-catalog.json:691`, `shared/icon-catalog.json:664` |
| Take back a move and leave practice line | `Undo2` | Closest by meaning |
| Swap players | `ArrowRightLeft` | Closest by meaning |
| Join transposition and show variations | `Merge`, `Split` | Closest by meaning |
| Show and hide comments | `MessageSquare`, `MessageSquareOff` | Closest by meaning |
| Normal and table notation | `List`, `TableProperties` | Closest by meaning |
| Annotate panel | `NotebookPen` | Closest by meaning |
| Practice target and due badge | `Target` | Closest by meaning |
| Threats | `Crosshair` | Closest by meaning |
| Repertoire practice tab | `Dumbbell` | `shared/icon-catalog.json` `ui.training` |
| Game Info tab | `Tags` | Closest by meaning (`Info` is the Guide) |
| Pin and unpin engine | `Pin`, `PinOff` | Closest by meaning |
| Stop engine | `Square` | Closest by meaning |
| Generic engine selector | `ChevronsUpDown` | Closest by meaning |
| Board snapshot | `Camera` | Closest by meaning, reference capture uses the same icon in `web/src/components/feedback/FeedbackModal.tsx:4` |
| Disable position editing | `PencilOff` | Closest by meaning |
| Erase drawings, save file and flip board | `Eraser`, `Save`, `ArrowUpDown` | Closest by meaning |
| File, PGN and game report | `File`, `FileText` | Closest by meaning |
| Export engine logs | `FileOutput` | Closest by meaning |
| Directory, open directory and move file | `Folder`, `FolderOpen`, `FolderSymlink` | Closest by meaning |
| Database and empty database list | `Database`, `DatabaseX` | Closest by meaning |
| Cloud engine | `Cloud` | Closest by meaning |
| External FIDE profile | `ExternalLink` | `web/src/components/puzzle/SourceGameLink.tsx:17` |
| Advanced filters and log filter | `EllipsisVertical`, `ListFilter` | Closest by meaning |
| Empty engine logs | `Terminal` | Closest by meaning |
| Repertoire start and Anarchy category | `Flag` | Closest by meaning |
| Automatic, dark, dim and light theme | `Monitor`, `Moon`, `SunDim`, `Sun` | Closest by meaning |
| Recent file time | `Clock` | Closest by meaning |
| Account statistic increase and decrease | `ArrowUpRight`, `ArrowDownRight` | Closest by meaning |
| Warning alert | `TriangleAlert` | Closest by meaning |
| Expand and collapse a variation | `Plus`, `Minus` | Closest by meaning, numeric stepping uses the same icons in `web/src/components/entityEditor/EntityNumericStepper.tsx:4` |
| Add game, tab, database or engine | `Plus` | Closest by meaning |
| Ultra-bullet, bullet, blitz, rapid, classical and correspondence | `ChevronsRight`, `ChevronRight`, `Zap`, `Hourglass`, `Clock4`, `Send` | Closest by meaning for time controls (`Flame` is the streak) |

Existing rendered sizes are retained for this import and JSX migration, including
compact 12–14px slots. This follows Phase 2's explicit
size-preservation constraint. ChessRiddle's reference uses 16px inline controls
(`web/src/app/globals.css:1077`) and 20px medium/large icon buttons
(`web/src/components/ui/IconButton.tsx:10`). Lucide's default stroke width is 2,
and explicit Tabler stroke props are replaced with `strokeWidth={2}`. Sizes can
be reconciled separately when layout changes are authorised.

`IconAction` keeps its existing accessible labels, tooltips and pending treatment.
The native window-control SVGs in `src/components/tabs/NavigationRow.tsx` and local chessboard artwork remain.

## Board defaults and maintenance

Users without a saved board get `chessriddle.svg`, the flat ChessRiddle maple
board. Its asset and coordinate map reproduce the reference maple preset.
Existing `board-image` selections remain unchanged, all previous choices stay
available, and the piece-set default remains `staunty`. ChessRiddle's wood grain
(`wood4-square.png`, soft-light, one tile per square) is on by default and can be
switched off under Board → Look → Wood Texture (`d-20261031-03`).
Board corners scale with the board: 3% of its width, capped at the default lg
radius, so a main board keeps 16px and small previews keep their corner squares.
Light, Dark and Auto keep their existing behaviour; Dim is the dark variant
described under Tokens and surfaces.

No hard-coded colours, no new icon library, no accent picker. Use the existing
semantic variables and shared controls. Board-functional colours are the explicit
exception above. To re-sync, compare the executable ChessRiddle CSS and control
implementations, update `theme.ts` and the relevant component modules together,
copy changed font subsets with their notices, and verify Light, Dark and Dim.
