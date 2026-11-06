# ChessRiddle Studio design system

ChessRiddle web is the visual source of truth. Copy executable values from
`chess-tactics-app/frontend/web/src/app/globals.css` and the implemented
`src/components/ui/` controls. Executable CSS takes precedence over ChessRiddle's
`.claude/DESIGN.md` prose. There is no shared token package or automatic sync.

`src/styles/theme.ts` is the single executable home of the copied values.
`appCssVariablesResolver` publishes `--cf-*` variables for both schemes and maps
Mantine's body, text, border and semantic variants onto them. Use these variables
instead of repeating colour values at call sites.

## Tokens and surfaces

| Tokens | Meaning |
| --- | --- |
| `background`, `foreground` | Page surface and body text |
| `card`, `card-foreground`, `popover`, `popover-foreground` | Panels and floating content |
| `surface-inset` | Nested containers inside cards |
| `interactive`, `interactive-hover`, `inset` | Pressable controls, hover and readonly overlays |
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
| Tabs | Tinted active pill in default, outline and pills variants |
| SegmentedControl | Inset pill shell, card indicator and gold ring |
| Inputs and select triggers | Inset or interactive fill, primary focus border and ring |
| Combobox, Menu, Popover | Card surface, quiet gold border, rounded selected options |
| Checkbox, Switch | Gold checked state, square checkbox and card switch thumb |
| Badge | Primary, muted or semantic tinted pill with inset ring |
| Slider, RangeSlider, Progress | Primary or explicit semantic fill |
| Accordion | Gold-tinted open header with a quiet ring |
| Tooltip, AppModal, Notification | Bordered card surface and appropriate elevation |

Focus visibility is required. Buttons, checkbox/switch, segments, and text fields
retain their distinct focus treatments. Respect reduced motion and hover capability.
Icon-only actions go through `IconAction`, dialogs through `AppModal`.

Mantine's built-in named palettes remain default except the explicitly warm `dark`
scale. New `danger`, `success`, `warning`, `info` palettes carry chrome feedback.
`warning` is distinct from the warm brown `chart-4` used by warning badges, and
info badges use `chart-1` while the info palette derives from `chart-6`.
Engine arrow hues, NAG annotation colours, drawing brushes, premove/check overlays
and existing per-board coordinate colours retain their board meaning.

## Icon identities

Every migrated icon imports from `lucide-react`, pinned exactly to `1.61.0`, the
ChessRiddle version. The rail uses monochrome catalogue `ui` identities. The
following table records the implemented mapping. Reference paths are relative to
`chess-tactics-app/frontend/`. A source reference identifies the matched artwork
and meaning. Entries marked closest by meaning have no exact reference slot.

| ChessRiddle Studio slot | Lucide export | ChessRiddle source or fallback |
| --- | --- | --- |
| Board, play and game tabs | `ChessKnight` | `shared/icon-catalog.json:664` |
| Account and human opponent | `User` | `shared/icon-catalog.json:655` |
| Library rail | `Library` | `shared/icon-catalog.json:790` |
| Engine rail, local engine portraits and computer opponent | `Brain` | `web/src/components/analysis/EnginePanel.tsx:272` |
| Settings and engine configuration | `Settings` | `shared/icon-catalog.json:793` |
| Appearance category | `Palette` | `shared/icon-catalog.json:661` |
| Sound category | `Volume2` | `shared/icon-catalog.json:667` |
| Privacy category | `Shield` | `shared/icon-catalog.json:676` |
| Puzzle tabs and new puzzle card | `Puzzle` | `shared/icon-catalog.json:757` |
| Tournament and engine rating | `Trophy` | `shared/icon-catalog.json:721` |
| Information and help | `Info` | `shared/icon-catalog.json:697` |
| Analysis tabs and actions | `ScanSearch` | `web/src/components/analysis/AnalyzePuzzleButton.tsx:60` |
| First, previous, next, last move | `ChevronFirst`, `ChevronLeft`, `ChevronRight`, `ChevronLast` | `web/src/components/analysis/ControlButtons.tsx:39`, `web/src/components/analysis/ControlButtons.tsx:48`, `web/src/components/analysis/ControlButtons.tsx:57`, `web/src/components/analysis/ControlButtons.tsx:66` |
| Start and pause one or all engines | `Play`, `Pause` | `web/src/components/puzzle/MoveAnnouncerControls.tsx:149`, `web/src/components/puzzle/MoveAnnouncerControls.tsx:149` |
| Delete move, game, file, database or account | `Trash2` | `web/src/components/puzzle/DeleteMoveAffordance.tsx:30` |
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
| Repertoire file, review and settings | `BookOpen` | `web/src/components/puzzle/OpeningSelect.tsx:432` |
| Upload engine portrait | `ImagePlus` | `web/src/components/feedback/FeedbackModal.tsx:396` |
| Refresh account or engine logs | `RefreshCw` | `web/src/components/settings/AccountSettings.tsx:291` |
| Reset keybindings or reload file | `RotateCcw` | `web/src/components/settings/SettingsSidebar.tsx:97` |
| Error alerts | `AlertCircle` | `web/src/components/entityEditor/EntityAutosaveStatus.tsx:32` |
| Authenticated account status | `CircleCheckBig` | Closest by meaning, reference success status uses the same icon in `web/src/components/history/AttemptHistoryItem.tsx:59` |
| More actions | `Ellipsis` | `web/src/components/profile/ProfileActionsMenu.tsx:71` |
| Engine drag and resize handles | `GripVertical` | `web/src/components/entityEditor/SortableReorderList.tsx:20` |
| Compact application menu | `Menu` | `web/src/components/layout/Header.tsx:11` |
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
| Threats, repertoire practice tab and new repertoire | `Crosshair` | Closest by meaning |
| Pin and unpin engine | `Pin`, `PinOff` | Closest by meaning |
| Stop engine | `Square` | Closest by meaning |
| Generic engine selector | `ChevronsUpDown` | Closest by meaning |
| Board snapshot | `Camera` | Closest by meaning, reference capture uses the same icon in `web/src/components/feedback/FeedbackModal.tsx:4` |
| Disable position editing | `PencilOff` | Closest by meaning |
| Erase drawings, save file and flip board | `Eraser`, `Save`, `ArrowUpDown` | Closest by meaning |
| File, PGN and game report | `File`, `FileText` | Closest by meaning |
| Import game and export engine logs | `FileInput`, `FileOutput` | Closest by meaning |
| Directory, open directory and move file | `Folder`, `FolderOpen`, `FolderSymlink` | Closest by meaning |
| Database and empty database list | `Database`, `DatabaseX` | Closest by meaning |
| Cloud engine | `Cloud` | Closest by meaning |
| External FIDE profile | `ExternalLink` | `web/src/components/puzzle/SourceGameLink.tsx:17` |
| Advanced filters and log filter | `EllipsisVertical`, `ListFilter` | Closest by meaning |
| Empty engine logs | `Terminal` | Closest by meaning |
| Repertoire start and Anarchy category | `Flag` | Closest by meaning |
| Inputs and keybindings categories | `Mouse`, `Keyboard` | Closest by meaning |
| Automatic, dark and light theme | `Monitor`, `Moon`, `Sun` | Closest by meaning |
| Recent file time | `Clock` | Closest by meaning |
| Account statistic increase and decrease | `ArrowUpRight`, `ArrowDownRight` | Closest by meaning |
| Warning alert | `TriangleAlert` | Closest by meaning |
| Expand and collapse a variation | `Plus`, `Minus` | Closest by meaning, numeric stepping uses the same icons in `web/src/components/entityEditor/EntityNumericStepper.tsx:4` |
| Add game, tab, database or engine | `Plus` | Closest by meaning |
| Ultra-bullet, bullet, blitz, rapid, classical and correspondence | `ChevronsRight`, `ChevronRight`, `Flame`, `Hourglass`, `Clock4`, `Send` | Closest by meaning for time controls |
| Captured bishop, rook and queen | `ChessBishop`, `ChessRook`, `ChessQueen` | Closest by meaning |

Existing rendered sizes are retained for this import and JSX migration, including
the rail's 24px icons and compact 12–14px slots. This follows Phase 2's explicit
size-preservation constraint. ChessRiddle's reference uses 16px inline controls
(`web/src/app/globals.css:1077`) and 20px medium/large icon buttons
(`web/src/components/ui/IconButton.tsx:10`). Lucide's default stroke width is 2,
and explicit Tabler stroke props are replaced with `strokeWidth={2}`. Sizes can
be reconciled separately when layout changes are authorised.

`IconAction` keeps its existing accessible labels, tooltips and pending treatment.
The native window-control SVGs in `TopBar.tsx` and local chessboard artwork remain.

## Board defaults and maintenance

Users without a saved board get `chessriddle.svg`, the flat ChessRiddle maple
board. Its asset and coordinate map reproduce the reference maple preset.
Existing `board-image` selections remain unchanged, all previous choices stay
available, and the piece-set default remains `staunty`. ChessRiddle's wood grain
(`wood4-square.png`, soft-light, one tile per square) is on by default and can be
switched off under Appearance → Wood texture (`d-20261031-03`).
Light, Dark and Auto keep their existing behaviour.

No hard-coded colours, no new icon library, no accent picker. Use the existing
semantic variables and shared controls. Board-functional colours are the explicit
exception above. To re-sync, compare the executable ChessRiddle CSS and control
implementations, update `theme.ts` and the relevant component modules together,
copy changed font subsets with their notices, and verify both colour schemes.
