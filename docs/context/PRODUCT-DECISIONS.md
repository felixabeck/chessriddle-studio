# Product decisions

This record holds product precedent: what ChessRiddle Studio is for and how it behaves.
Technical precedent lives in `tasks/decisions.md`. `/decide` writes product decisions
here per `~/.claude/skills/decide/SKILL.md` section 4.

Use one entry per decision, with the question, choice, Felix's reason in his terms,
finding ids and date.

## 2026-10-04 — One Library with linked collections

- **Question:** Should games and opening material live in one Library instead of
  separate Files and Databases pages organised by storage format?
- **Choice:** One Library, in two phases.
  - **Phase 1:** One Library sidebar entry replaces Files and Databases, with one
    searchable list of files and databases, type badges and a detail pane by item
    type. `/files` and `/databases` redirect to the Library.
  - **Phase 2:** Every collection exists exactly once. A user's own PGN file in the
    library folder is the truth. A database is either the search index of such a
    file or a standalone reference collection.
    - Game collections in the library folder get automatically maintained linked
      search indexes, including after external rewrites. Edits go to the file.
    - Repertoires and studies remain plain files without indexes. Position search
      inside repertoire variations is not promised.
    - Account sync appends only games not already present to one accumulated PGN
      per account in the library folder, linked like any game collection.
    - Large collections imported from outside the library folder remain
      standalone databases.
    - Existing unlinked file/database pairs are offered a one-time link, without
      silent merging or losing edits made on either side since import.
    - Working editing must be preserved. Linked collections ship where PGN
      write-back works (Linux, macOS). Windows keeps unlinked databases until PGN
      atomic replacement is ported.
- **Ruled out:** Converting everything to one storage format. Converting
  repertoires to databases loses free-form editing and repertoire practice.
  Converting databases to PGN loses indexed position search and the opening
  explorer over large collections.
- **Felix's reason:** "in chess space this is all in one list". Users organise by
  purpose, not storage format.
- **Findings:** `f-20261001-11` (phase 1), `f-20261004-15` (phase 2, linked collections).
- **Date:** 2026-10-04.
- **Later state (noted 2026-11-26):** the Library is no longer a sidebar entry; since
  2026-11-20 it is the first tab of the one navigation row ("2026-11-20 — One navigation row
  replaces the title row, the tab row and the rail").
  Linked collections still ship only on Linux and macOS (`linked_collections::supported` in
  `src-tauri/src/db/linked_collections.rs`), although PGN writes on Windows work since
  `d-20261124-22`; the reason given above for leaving Windows out is out of date.

## 2026-11-05 — The board tab stacks its tiles in narrow windows

- **Question:** How should the board tab (board, side panel, notation) adapt when the
  window is too narrow for the desktop side-by-side split, for example 320px wide or a
  small screen at 200% font scale?
- **Choice:** Stack vertically. Board at full width on top, side panel and notation
  below, the page scrolls vertically. The saved desktop split is untouched and returns
  when the window is wide again.
- **Ruled out:** A single-tile switcher (board and notation never visible together) and
  minimum tile widths with horizontal scrolling (sideways scrolling is awkward).
- **Felix's reason:** chose the recommended option. It matches how the settings and
  database screens already behave at narrow widths.
- **Findings:** `f-20261104-07`.
- **Date:** 2026-11-05.

## 2026-11-05 — Games reopen from the remembered side

- **Question:** Should a game remember the board orientation the user chose, and should the
  user's own black games open from Black's side without a flip?
- **Choice:** Memory plus inference. A manual flip is remembered per game, in PGN files through
  the `[Orientation]` tag and in databases through a stored per-game value. When nothing is
  stored, a database game opens from Black's side if its Black player appears in nearly every
  game of that database. A stored orientation always wins. Default on, no setting, no account
  required.
- **Ruled out:** Matching connected Lichess/Chess.com account names only (Felix has none
  connected), a "my name" setting, and flip memory without inference (61 manual first flips in
  "Meine Partien").
- **Felix's reason:** "what's really annoying is that I have to do this every time again.
  Because when I review a game I open it several times and then I have to do this every time.
  That's what's annoying, not the first time."
- **Date:** 2026-11-05.

## 2026-11-09 — New Tab is one searchable Library list

- **Question:** New Tab showed only the last ten files and a separate due card, so
  opening anything else meant a detour through the Library. How should the page work?
- **Choice:** A compact row of actions, then one list of the whole Library sorted by
  last opened, with a search field and the filters All, Repertoires, Games and Due. Every
  row has the same layout and is clickable across its full width.
  - The Games filter lists each game from the user's own collections, newest first, and a
    player's name finds them. Large reference databases stay one row each and open their
    game table. All shows each collection as one row plus recently opened games.
  - Clicking a row turns this New Tab into that file.
  - Due counts only overdue positions across every repertoire, never untrained ones.
  - A repertoire opens on Practice only from the Due filter, otherwise on Info.
- **Ruled out:** Three cards (Library, Recent, Due), and two cards with Recent and Due
  merged, both of which keep two starting points. Collections only under Games, which
  keeps the detour.
- **Felix's reason:** "because currently I can't really use the feature new tab, because
  new tab doesn't help me, because anyway I have to click on library and then open the
  files there." The two old cards "doesn't feel consistent".
- **Date:** 2026-11-09.

## 2026-11-09 — One Puzzles entry, ChessRiddle first

- **Question:** Should ChessRiddle puzzles and the offline puzzle databases be two
  separate options on New Tab, or should Studio offer only ChessRiddle puzzles?
- **Choice:** One "Puzzles" entry. Inside the puzzle tab ChessRiddle is the default
  when the connection is available. A connected user starts ChessRiddle tactics
  directly, with retry-your-mistakes. A user who is not connected sees the prompt to
  connect a ChessRiddle account first, with the offline databases as a smaller second
  choice. The offline databases stay.
- **Ruled out:** Two New Tab buttons side by side. Removing the offline databases
  now: without an account or internet the entry would only show a login wall, and a
  free user at the daily limit would have nothing left to solve.
- **Felix's reason:** He opened Puzzles and saw no ChessRiddle puzzles: "is it
  sensible to have those two options or should I just only use the chess riddle
  puzzles here?" On the recommendation above: "Yes, I will definitely, I want to
  build this."
- **Date:** 2026-11-09. Technical record: `d-20261110-01`.

## 2026-11-10 — Studio offers tactics only, made complete in itself

- **Question:** Should Studio cover all ChessRiddle puzzle modes, so that it is an
  alternative to the browser, or only tactics?
- **Choice:** Tactics only, plus the mistakes queue, and no further puzzle modes.
  The tactics mode gets difficulty and motif and a timer, all synced with the
  ChessRiddle account, the browser's keyboard shortcuts (Enter or A, the arrows, ?),
  a "This session" summary with the rating, Analyse after the verdict with the local
  engine, and a link to the other training modes on chessriddle.com. The puzzle tab
  is a way into ChessRiddle for Studio users, not a replacement for the website.
- **Ruled out:** Rebuilding the browser's other modes in Studio: each needs its own
  solving interface and every later change would be built twice. Zen mode. Saving a
  puzzle to a local file ("I would wait with that until people ask for it").
  The wrong-piece hint ("I would also leave this out for now"). A counter of the
  remaining free puzzles and the motif shown after solving, because both need the
  server to return new information.
- **Felix's reason:** "So let's just focus on tactics, no more puzzle modes, but make
  these really well so that the user is really inclined to check chess riddle out."
  On the timer: "I think the timer is something valuable and easy to build." On the
  keys: "I would use the same keyboards that we use in the browser."
- **Date:** 2026-11-10. Technical record: `d-20261110-08`.

## 2026-11-10 — Arrow down at a line end stays at its own fork

- **Question:** Where does arrow down go at the end of a line, so that variations can
  be walked from the board alone, without reading the notation?
- **Choice:** At the end of a variation, arrow down goes to the next sibling variation
  of the same fork. After the last sibling it goes to the main move those variations
  are alternatives to. At the end of the main line it does nothing. Inside a line it
  still jumps to the line's end, and the variation selector stays the way into a
  variation.
- **Ruled out:** Walking variation starts in notation order (the earlier behaviour):
  the end of a nested variation jumped to an unrelated variation further down.
  Arrow down inside a line entering the next variation below: it only works when the
  notation shows that a variation exists. Landing on the move after the main move:
  the main move itself is never shown as its own step.
- **Felix's reason:** "I don't want to look at the right side. I just want to look at
  the board and then navigate through it." On landing on the main move: "that would
  skip a move which is not ideal", and, although arrow down then jumps up in the
  notation, "logically it's still the best solution".
- **Date:** 2026-11-10.

## 2026-11-10 — Library rows: selected beats hover, a folder is highlighted only while open

- **Question:** How do Library file rows show hover and selection? Felix saw the selected
  fill only after the pointer left the row, and a folder stayed dark after he closed it.
- **Choice:** The selected look shows immediately on click, also while the pointer is on
  the row. Selected is a soft gold tint with the gold bar, not the darker fill. Hover is
  slightly stronger. A folder is not highlighted once it is closed.
- **Agent adaptation, not Felix's wording:** Felix approved "folders no longer get
  selected by clicking". The build found that Create file and Create folder create
  inside the selected folder, so dropping folder selection would have removed that
  route. Implemented instead: opening a folder selects it, closing it (or a folder
  above it) clears that selection. Reversal: make `toggleDirectory` in
  `src/components/files/DirectoryTree.tsx` stop calling `setSelectedFile`, and give
  Create file/folder another way to target a folder.
- **Ruled out:** Keeping the selection on a closed folder: it reads as "still open".
- **Felix's reason:** "when I then close it again it stays highlighted in dark. This is
  I think a bit strange because I no longer opened it so this should no longer be
  highlighted." On the recommendation: "Do everything as you recommend."
- **Date:** 2026-11-10.

## 2026-11-10 — File tabs show the current chapter

- **Question:** When a file contains several chapters, should the tab name follow the
  chapter currently shown, and where should the file name appear?
- **Choice:** Chapter name in the tab, file › chapter in the tooltip. The tab name
  follows chapter switches and title edits. The Library chapter picker is also part
  of the agreed design.
- **Ruled out:** File name only.
- **Felix's reason:** "When I just show white moragambit then I have the same problem
  that I can't distinguish between different moragambit files". Also: "The chapter
  picker should definitely be part of it."
- **Date:** 2026-11-10.

## 2026-11-20 — Which upstream En Croissant 0.16 features Studio adopts

- **Question:** Upstream shipped 96 commits since the fork point. Which of its
  user-visible features does Studio take, in what form, and which does it leave out?
- **Choice:** Adopt four: the material display can be switched off; a "Default panel"
  setting chooses the side panel a board opens on (default Info, repertoires still
  open Practice only on request); the analysis-panel control for the engine's Threads
  option is called "CPU threads" like the Engines page; two humans playing on one
  board get a takeback, and deleting the last move of such a game acts as a takeback.
  All four shipped on 2026-11-20. Deleting any other move while a game is running is
  not offered, because the game's moves belong to the backend. The agent applied the
  same rule to games against an engine, where deleting the last move runs the
  existing engine takeback; Felix was told and can restrict it to two humans.
  Upstream's hide toggles for the sidebar and tab bar are not adopted as
  such: Felix chose a one-row navigation redesign instead, which is being planned in
  its own run and gets its own entry once he has picked a variant.
- **Ruled out:** Long algebraic notation; engine Elo in the PGN headers of engine
  games; the colour square beside "White/Black to move" in puzzles; the Kiwen Suwi
  piece set and the blue4 board. The database game preview keeps opening on the
  starting position, with no setting for it.
- **Felix's reason:** Material: "Yes, adopt this." Default panel: "Yes, adopt this as
  a setting. Seems sensible." Threads: "Number of threads, yes, also adopt." Takeback:
  "adopt this", and on deleting the last move: "Act as a take back. Yes, I'm fine
  with it." Long algebraic notation: "I don't even know what this is, so maybe…
  we can just skip it." Engine Elo: "I don't understand the clear benefit behind
  this, so maybe we can just skip the engine ELO." Preview: "I would definitely keep
  it on the starting position". The agent recommended against a setting for the
  preview (no evidence of demand, "go to end" is one click away) and Felix did not
  ask for one.
- **Findings:** f-20261120-03 to f-20261120-06 are the upstream bug fixes taken in
  the same run; they needed no product decision.
- **Later state (noted 2026-11-26):** the one-row navigation got its own entry, "2026-11-20 —
  One navigation row replaces the title row, the tab row and the rail" (variant B).
- **Date:** 2026-11-20.

## 2026-11-20 — One navigation row replaces the title row, the tab row and the rail

- **Question:** The title row, the tab row and the left rail each take space while
  showing little. How should navigation be arranged?
- **Choice:** One row at the top of the window.
  - The title row, the tab row and the left rail merge into one row. No hide toggle
    and no window per game.
  - Tabs look like browser tabs on a tinted bar, and the current one merges into the
    page (variant B of the three rendered mockups).
  - Every tab carries its own close X. The separate close button at the right edge
    goes.
  - The "..." button next to the tabs goes. Its actions stay on the tab's right-click
    menu.
  - File, View and Help collapse into one menu button. Settings, Accounts and Engines
    move into it as entries that open their own pages.
  - The Board icon of the rail disappears because the tabs are the boards. Library is
    the only destination left in the row, shown with its label as the pinned first
    tab.
  - Send feedback stays one click away: a small labelled "Feedback" button at the
    right end of the row, before the window buttons, in addition to its menu entry.
- **Agent proposals Felix confirmed, not his wording** (asked as four details, answered
  "yes to all"):
  - Reload, Clear saved data and Open logs move into a new Advanced section of
    Settings.
  - On the Settings, Accounts and Engines pages the page appears in the row as a
    temporary item with its own X. Closing it returns to the tab the user came from.
  - A button lists every open tab when the tabs overflow.
  - F2 renames a tab.
- **Shown on the mockup sheets of the options he chose, not confirmed item by item:**
  - The menu holds New tab, Open file, Save, Save to file or database, Accounts,
    Engines, Settings, Fullscreen, Send feedback, About and Exit.
  - With many tabs open, tabs shrink to a minimum width and then the strip scrolls.
    Only the current tab keeps its X then; the others show it on hover.
- **Supersedes in part:** the 2026-10-04 entry "One Library with linked collections"
  places Library as a sidebar entry. Library stays the one entry for files and
  databases; its place becomes the first tab of the row.
- **Ruled out:** A hide toggle for the bars. One window per game. Accounts and Engines
  as sections of the Settings page. Variant A (today's pill tabs in a strip) and
  variant C (flat labels with a gold line).
- **Felix's reason:** With one or two tabs open "the whole tab bar on top is wasted",
  the left bar has "only the four items on top", and in the header line "a lot of
  space is wasted". He uses the navigation a lot between files, but not while working
  inside one. The only things he uses all the time are board and library; accounts and
  engines are set up once and do not deserve a prominent spot. If feedback is hidden
  and a user has to click too much first, he might not send it. On the mockups and the
  proposals: "B Browser Taps, 2 menue entries, yes to all".
- **Superseded in part (2026-11-21):** Settings, Accounts and Engines no longer appear as a
  temporary item; they stay open as tabs until closed ("2026-11-21 — Accounts, Engines and
  Settings stay open as tabs until closed").
- **Later state (noted 2026-11-27):** the File menu item "Save to file or database" was renamed
  to "Save a copy…" ("2026-11-27 — Save-to of the current game updates it; copy is named a copy").
- **Date:** 2026-11-20.

## 2026-11-21 — Accounts, Engines and Settings stay open as tabs until closed

- **Question:** The Accounts page appeared in the navigation row with its own X, but it
  vanished as soon as Felix switched to a board tab. Should it stay, and should users be
  able to pin Accounts or Engines to the header?
- **Choice:** Accounts, Engines and Settings open as tabs that stay until their X closes
  them. They sit at the front of the row, right after Library, in the order they were
  opened. Opening a page that is already open goes to its tab. Open page tabs come back
  with the board tabs. There is no pin setting.
- **Supersedes in part:** the 2026-11-20 entry's "temporary item with its own X. Closing
  it returns to the tab the user came from". Closing still returns there; leaving the
  page no longer closes it.
- **Felix's reason:** "when I then switch the tab, for example, to the next one, then it
  suddenly disappears. And this is of course very strange." On the proposal (agent's,
  confirmed): "Yes, let's put them at the front. And alright, let's do what you suggest
  first, only making them as tabs but without the setting or without the option to fix
  them, as you recommend."
- **Date:** 2026-11-21.

## 2026-11-21 — The last tab can be closed; the Library takes its place

- **Question:** Closing the only open tab brought a fresh New Tab straight back, so the
  last tab could never be closed. Should a closed last tab stay closed?
- **Choice:** Yes. The workspace may hold no tabs. With none open, the board view sends
  the user to the Library, right after the last close and when the app opens with a
  restored empty workspace. "+" and the New Tab hotkey open a fresh tab. A first start
  without a saved workspace still opens one New Tab.
- **Reason:** Felix reported that the closed tab "disappears for a fraction of a second
  and then opens again" and approved this recommendation: the Library is now its own
  page in the navigation row, so an empty tab row has a clear place to go.
- **Date:** 2026-11-21.

## 2026-11-22 — The analysis board can show its panels beside the notation

- **Question:** A user asked for Annotate next to the notation instead of above it, with
  the Database on top across both. Should the analysis board offer that, for which
  boards, and what happens in a narrow window?
- **Choice:** A switch in Settings, Board: "Panels beside the notation", off by default.
  On, the analysis board shows its tab panels (Practice, Analysis, Database, Annotate,
  Info) to the right of the notation. What is pinned "Above the tabs" (the Database
  strip, the engine bar) then spans the notation and the panels, and that place is named
  "Above the notation and tabs" there. Play, puzzle and ChessRiddle training tabs keep
  their layout. In a window too narrow for board, notation and panels the panels show
  above the notation again; the choice is kept and returns with the room.
- **Agent proposals Felix confirmed, not his wording** (scope, default, the narrow-window
  fallback and the label, presented as four decisions): "Yes, I like all your decisions."
- **Not confirmed item by item:** In this arrangement a divider stops where board,
  notation or panels would get narrower than the 20rem the narrow-window rule already
  uses. The arrangement has its own divider positions; the panels-above layout keeps its.
- **Felix's reason:** "I think it makes quite a lot of sense because the notation doesn't
  need to be that wide and the annotate is more compact and better visualized on the
  right side next to the moves."
- **Date:** 2026-11-22.
- **Superseded (2026-11-25):** the switch "Panels beside the notation" is replaced by dragging
  areas into place on the analysis board, and the place "Above the notation and tabs" is gone
  (the engine bar's "Above the tabs" is the top of the tab strip area); see "2026-11-25 — The
  analysis board is arranged by dragging; the Assistant gets a draggable width", Felix's answer 1.
  A beside arrangement a user had is carried over.

## 2026-11-22 — Game report: marks option, backward analysis, saved-only numbers, Lichess-style accuracy, key moments

- **Question:** The game-report plan (`tasks/plans/2026-11-22-game-report-improvements.md`)
  presented five changes to what the user sees beyond repairing defects, each with a
  recommendation.
- **Choice:** All five as recommended.
  - **P1:** A "Mark moves" option, on by default. When on, a report replaces the existing
    `??`, `?`, `?!`, `!`, `!!`, `!?` on the main line (one undo brings them back); when off,
    a report writes evaluations only.
  - **P2:** The "Reversed analysis" option is removed; a report always analyses from the
    last move backwards.
  - **P3:** Accuracy and ACPL ignore the live engine and use saved evaluations only.
  - **P4:** Game accuracy per side is the mean of a volatility-weighted mean and the
    harmonic mean, as on Lichess.
  - **P5:** A "Key moments" list on the Report tab shows the marked mainline moves.
- **Reasons (the plan's, confirmed by Felix):** P1: a re-run must not leave the previous
  report's marks behind, and a user with hand-made marks needs a way to keep them. P2:
  backwards is the better technique (the engine's hash carries over from later positions)
  and the option means nothing to a club player. P3: today the numbers drift while
  browsing with the engine on. P4: one disastrous move in an otherwise clean game no
  longer halves the number, and users compare with Lichess. P5: today the only way to see
  the mistakes is to click the count buttons one move at a time.
- **How Felix decided:** by sending the handover prompt with the decision line "P1 yes,
  P2 yes, P3 yes, P4 yes, P5 yes".
- **Findings:** none; the plan is the record. Related known limit: `f-20261122-04`.
- **Date:** 2026-11-22.

## 2026-11-22 — An opponent's online accounts are linked on the database player

- **Question:** When preparing against an opponent found in a reference database, can their
  Lichess and Chess.com games be added, where do those accounts live, and how are the online
  games shown next to the over-the-board games?
- **Choice:**
  - The accounts are linked on the database player's card, not on the Accounts page. An
    account is added by site and username; the site's answer (spelling, title, real name,
    country, rated games) is shown for confirmation before it is linked. Neither site offers
    a search by real name, so the username has to be known.
  - Period and time controls are chosen before the download. Default: the last three years,
    every time control except bullet. Only rated standard chess is downloaded.
  - The Lichess download needs no login of the opponent: it uses the user's own Lichess login
    when there is one and runs anonymously otherwise.
  - Lichess and Chess.com games of one opponent are kept together as that opponent's online
    games, apart from the over-the-board games.
  - No merged opening tree. "Prepare on board" opens the board with two columns: the
    database the player was found in, and the online games. Both follow the moves on the
    board; colour, dates, result, Elo and the fast-events switch are shared.
  - Removing the online games keeps the usernames on the player. A separate "Unlink
    accounts" forgets them. The link is stored by the player's name, so it survives a
    replaced reference database.
  - Suggestions for titled players' handles and a search by name are left out for now.
  - Requests to Lichess and Chess.com carry a contact address, the one published on the
    ChessRiddle site.
- **Felix's reasons:**
  - Where the accounts live: "the accounts page, I consider it more for my own accounts and
    for my analysis. And the other players that I look forward to prepare against, I just
    need them once in combination with their saved games in the database. And then I don't
    need them any longer because I just play them once."
  - Two columns instead of a merged tree: "it would even be interesting to see them all side
    by side. For example, like I currently … show two databases … So separate for over the
    board and for online. Because that would always give a clear distinction. And I could
    just … click through the moves and there's no need in merging". This replaced his
    earlier wish for a filter "to turn the only over-the-board or only online games".
  - One online column for both sites: "I think it's sensible to merge the Chess.com and the
    Leechess online games because as you say they are both online games … and separate them
    from the over the board games."
  - Period and time controls: "choosing period and time control is also sensible."
  - Titled players: "let's leave title players out for now."
  - Contact address: "of course, I can include my contact address to the chest.com.
    reqests" and "My business address is the same as my private address, so just take it
    from the chess riddle page."
- **Agent proposals Felix confirmed, not his wording:** removing the games keeps the
  username and unlinking is separate ("Yes, point three as well"); the default filter, the
  confirmation by profile, the download without the opponent's login and rated standard
  chess only (confirmed with "as you recommend" on the summary).
- **Not confirmed item by item:** the opponent's online games are an ordinary database and
  appear in the Library while they exist. The opening tree on the card itself stays
  over-the-board only; the two columns are the board's. An account that cannot be found
  stops the whole download instead of being skipped, so a mistyped username is noticed.
- **Finding filed on the way:** f-20261122-03 (a Lichess account added without login on the
  Accounts page can never download its games).
- **Later state (noted 2026-11-26):** "Prepare on board" now builds on the user's repertoire
  and can show up to three columns, the reference database and Lichess included ("2026-11-24 —
  Opponent preparation against the user's own repertoire, without AI" and "2026-11-25 — Lichess
  All and Lichess Masters are normal sources of the board's Database panel").
  The opening tree on the card itself also shows an Online section beside Over the board when
  online games are linked (`src/components/databases/PlayerOpeningTree.tsx`), so it is no longer
  over-the-board only.
- **Date:** 2026-11-22.

## 2026-11-24 — Transposition markers span all chapters of a file up to a limit and switch chapter in the same tab

- **Question:** When a move reaches a position that exists in another chapter of the same PGN
  file, how should the notation mark it, which files should be indexed, and what should clicking
  the marker do?
- **Choice:**
  - Every multi-chapter file up to a size limit is indexed per verified revision (`"All files up
    to a limit"`), not repertoire files only. Files exceeding the chapter, byte, or position limit
    are skipped silently, keeping in-chapter markers only.
  - The marker keeps the Merge icon with no text in the notation or PGN. An in-chapter target
    keeps the `Transposition` label; a target in another chapter names that chapter in its
    accessible label (`Transposition in <chapter>`).
  - Clicking a marker targeting another chapter switches the chapter in the same tab (`"Switch
    chapter in same tab"`) and lands the cursor on the matching position; unsaved changes follow
    the normal chapter-switch confirmation prompt.
  - Occurrences reached by the same moves from the same starting position in another chapter are
    not marked as transpositions, so shared opening moves across chapters stay unmarked.
  - If the target chapter or position is gone when clicked (before the revision poll retires the
    stale index), nothing is switched and an error notice tells the user that the position is no
    longer in that chapter.
- **Agent proposals Felix confirmed, not his wording:**
  - Confirmed in Felix's handover on 2026-11-24: `"The three agent proposals (shared opening
    moves are no transposition, the silent limit, the \"position is no longer in that chapter\"
    notice) are confirmed unless struck here: none struck."`
- **Ruled out:** Adding text markers in the notation or PGN. Limiting the check to repertoire files.
  Opening the target chapter in a new tab instead of switching in the same tab. Marking shared
  opening move orders as transpositions.
- **Felix's reason:** For the icon-only presentation: `"The icon is fine. I don't need a text for
  this."` For file scope and click behaviour: `"All files up to a limit"` and `"Switch chapter in
  same tab"`. Builds on the in-chapter transposition precedent (`d-20261124-06`).
- **Date:** 2026-11-24.

## 2026-11-24 — Opponent preparation against the user's own repertoire, without AI

- **Question:** How should Studio help prepare against an opponent: with AI, with a generated
  preparation file, or with the user's own repertoire files? Which games count, how is recency
  handled, do the training answers count for the normal schedule, where does it live, and should
  the preparation board also show the general database?
- **Choice:**
  - No AI in this step: "we keep AI for later as a second step."
  - The user's own repertoire files, with the irrelevant lines collapsed, instead of a generated
    file: "using my own files also is very good, because I might be tempted to look at some other
    lines. […] So it's definitely better, as you suggest, to use the normal files. […] We can just
    collapse all the lines that are irrelevant."
  - Recency through the period control, 3 years by default: "And yes, recency is also good."
  - Games used: a switch "Over the board | Online | Both", starting on Over the board (answer
    "Switch, 3 ways").
  - Answers in "Train these lines" reschedule the cards like any practice (answer "Yes, counts").
  - Place: a new fourth tab "Preparation" on the database player's card (answer "New tab
    \"Preparation\"").
  - The general database shown in addition on the board that "Prepare on board" opens, from a
    user's feedback Felix forwarded: "Ich vermisse im Vorbereitungsfenster die Möglichkeit die
    normale Datenbank zusätzlich anzuzeigen, dass ich nicht nur sehe, was er OTB macht und was er
    online macht, sondern auch was die häufigsten Züge sind. […] Can we implement this in the
    same run?"
- **Agent proposals Felix confirmed, not his wording:** the whole recommendation ("Yes, that
  sounds very good, everything."): lines ranked by how often this opponent reached them, a list of
  gaps (his moves the repertoire does not cover), positions compared instead of move orders,
  opening a line in the user's file, a training run limited to these positions, and finding
  online accounts kept manual.
- **Ruled out:** an AI summary in this step; a generated preparation file or a bare pointer to a
  file; finding online accounts by name.
- **Felix's reason:** "I don't want to review all of my files for a certain variation but only the
  moves he plays. So It's not enough to just point me to one of my opening files, because they
  have a lot of different variations in it."
- **Agent decisions of the plan:** d-20261124-24 to d-20261124-34. "Vorbereitungsfenster" is read
  as the board "Prepare on board" opens (plan "Risks / open questions").
- **Date:** 2026-11-24.

## 2026-11-24 — Library files sync one-way to the private Library on the ChessRiddle website

- **Question:** How do Studio's PGN files reach the private Library on the ChessRiddle website,
  so that nobody has to upload PGN files by hand?
- **Choice:** Felix's decisions, relayed on 2026-11-24 in a handover brief written in a
  chess-tactics-app chat (the brief's summary wording, not verbatim quotes):
  - Sync is one-way, from Studio to the website. The website Library only reads files and never
    writes back.
  - The Library gets one "Sync with ChessRiddle" action, available once the ChessRiddle account is
    connected.
  - Every PGN file is selected by default, including files created later. Single files can be
    deselected.
  - After sync is turned on, saving a selected file updates its website copy automatically. A
    manual "sync now" stays available.
  - Only PGN files sync (repertoires, annotated games). Game databases (downloaded Lichess and
    Chess.com histories) do not.
- **Answers Felix picked from agent-proposed options on 2026-11-24 (option labels, not his
  wording):**
  - `"Yes, remove it"`: a synced file that is deselected, moved to the trash or removed from the
    Library folder is removed from the website. Restoring or reselecting it uploads it again.
    Files uploaded by hand on the website are never touched.
  - `"Marked, delete only"`: on the website a synced file is labelled "Synced from ChessRiddle
    Studio", cannot be replaced or edited there, and can be deleted with a note that it comes back
    at the next sync unless it is deselected in Studio.
  - `"Ask: keep or remove"`: turning sync off asks whether the synced files stay on the website or
    are removed, with "keep" preselected.
- **Agent decisions inside that frame, not Felix's wording:** a file over the website's limits is
  shown per file with its reason and never fails silently. A changed Library folder pauses sync
  and offers only turning it off. Sync belongs to the connected ChessRiddle account; another
  account starts with sync off.
- **Ruled out:** two-way sync. Syncing game databases. Changing or deleting files that were
  uploaded on the website by hand.
- **Felix's reason:** from the brief: "so nobody has to upload PGNs by hand".
- **Technical record:** `d-20261124-23` and `d-20261125-05` in `tasks/decisions.md`; the website's half is
  `p-20261124-01`, `d-20261124-14` and `d-20261125-01` in the ChessRiddle repository.
- **Date:** 2026-11-24.

## 2026-11-25 — Minimum games in the Preparation tab and an entry for online-only opponents

- **Question:** The two points the opponent preparation plan left open: should the Preparation
  tab get a minimum number of games per line, and how does a user prepare against an opponent who
  has only an online account and no game in a database?
- **Choice:** Felix ordered both as recommended: "Do all of those now. Full auto execute
  anti-gravity. Everything that you think needs to be built, build this now. You can build one
  after the other, but don't stop when the first one is done. Just build everything."
- **Agent proposals Felix confirmed, not his wording:**
  - A "Minimum games" choice with 1, 2, 3 and 5, starting at 1, which limits the lines, the gaps,
    the folding in the opened file and the training run together. Rejected: a minimum that adapts
    to the number of games.
  - An "Online opponent" entry: choose Lichess or Chess.com, type the username, the games are
    downloaded the way the player card downloads them today, and the opponent's card opens with
    its Preparation tab. Finding accounts by a person's name stays out (his decision of
    2026-11-22).
- **Date:** 2026-11-25.

## 2026-11-25 — Lichess All and Lichess Masters are normal sources of the board's Database panel

- **Question:** A friend asked to see his Mega database on the left and the Lichess database on
  the right without downloading Lichess. Felix: "So is there a way to include leaches? Maybe to
  include it into one of the databases that are already open." Should Lichess become a source in
  the same drop-downs as the local databases, and what happens to the Local / Lichess All /
  Lichess Masters switch and to the column limits?
- **Choice:** Felix accepted the recommendation: Lichess All and Lichess Masters appear in the
  database drop-down and in the "+ Compare" menu, in an "Online" group below the local databases;
  each Lichess column has its own filter button with the existing Lichess filters; the
  preparation board can show Lichess as a further column. His words: "And yes, let's go with your
  approach above to not download leeches." and, to the two open questions, "Both questions go
  with your recommendation." That means:
  - The Local / Lichess All / Lichess Masters switch is removed entirely, not kept as a shortcut.
  - At most two columns on a normal board and three on the preparation board.
- **Agent proposals Felix confirmed, not his wording:**
  - The starred "Reference database" in the Library stays a local database; picking Lichess as
    the first source is a choice of the board tab, exactly as the switch is today.
  - Lichess is not offered as a download.
  - The limits he was told: a Lichess column needs a signed-in Lichess account and shows the
    sign-in hint without one while the other columns keep working; Lichess returns only its most
    common moves, so a rare move shows "–" in the Lichess column while the total stays correct;
    the Games view gets only a handful of top and recent games from Lichess; a partial position
    search has no Lichess answer.
- **Consequences recorded as agent decisions d-20261125-24 to d-20261125-36 (tasks/decisions.md):** Lichess alone on
  a preparation board is no longer possible, there it is a further column; a failed Lichess
  request is not retried by itself, moving to another position asks again; a column that cannot
  answer shows empty cells instead of dashes.
- **Date:** 2026-11-25.

## 2026-11-25 — Importing a game from a scoresheet photo

- **Question:** How should a user with an AI connection turn a photo of a handwritten scoresheet
  into a game, and which product points of the reviewed plan
  (`tasks/plans/2026-11-24-scoresheet-photo-import.md`) apply?
- **Choice:** Felix, 2026-11-24: "yes the entry point is fine from photo Everything else as you
  recommend." A "From photo" option in the import dialog plus drag and drop and paste; the game
  opens as a new unsaved tab with the photo beside the board and unclear moves marked, and the
  user corrects and saves it into the file they choose; several photos per game; without an AI
  connection the option is shown with a hint to connect one; names, date, event and result are
  read from the sheet too. On 2026-11-25 he confirmed the plan's six product points by sending
  the build order ("P1 yes, P2 yes, P3 yes, P4 yes, P5 yes, P6 yes"):
  - **P1** "Continue with the rest of the sheet": after a stop or a corrected wrong move the
    sheet's own moves are put back. Reason in the plan: without it a wrong move in the middle
    means typing the rest of the game again.
  - **P2** Photos are kept in memory only: after a restart the game and its marks are back, the
    photo has to be loaded again.
  - **P3** Up to 4 photos per game; JPEG, PNG and WebP; no HEIC and no PDF.
  - **P4** Standard chess from the starting position only.
  - **P5** Dropping a photo works on the open "From photo" pane, not anywhere in the window.
  - **P6** The wording of the first-use notice: what is sent (the photos, with names and whatever
    else is written on the sheet) and to whom (the provider of the chosen connection), that
    photo metadata such as location is removed first, and that nothing else of the user's data
    goes with it.
- **Felix's reason:** from the original question: "I saw it in another app that they provide this
  feature to directly upload a photo of your notation and then it gets converted into a file".
- **Technical record:** `d-20261125-40` to `d-20261125-49` (DA1 to DA10 of the plan) and the
  bundle decisions `d-20261125-37` to `d-20261125-39` and `d-20261125-50` in `tasks/decisions.md`; the privacy text is
  ChessRiddle commit `7757a40b7`.
- **Date:** 2026-11-25.
- **Later state (noted 2026-11-27):** P2 no longer holds: scoresheet photos persist with the
  game (`d-20261126-34`). P3: PDF scoresheet pages are in scope; Felix ordered PDF support on
  2026-11-26 (`d-20261127-01`). HEIC remains out.

## 2026-11-25 — The analysis board is arranged by dragging; the Assistant gets a draggable width

- **Question:** Felix: "do you think it's worth building the whole new architecture now with the
  movable windows? or even to show those windows and to extract them maybe so that a user with
  two screens can set them on two, for example two different monitors, or is this too much and
  not something for the first session?" He also said the Assistant "currently always sits on the
  whole right side of the board. takes a lot of space which is not ideal in my estimation."
- **Choice:** One drag-to-arrange mechanism inside the analysis board: the panels Analysis,
  Database, Annotate, Coach and Info can be taken out of the tab strip and placed left, right,
  above or below another area with a preview; the notation and the tab strip move the same way;
  "Return to the tabs" and "Reset layout". The Assistant stays docked and gets a draggable,
  remembered width. Felix ordered the plan ("Make a plan for both of those and review the plan
  with anti-gravity.") and chose, by question dialog:
  1. "Replace both (Recommended)": dragging replaces the Database "Pin" menu and the Settings
     switch "Panels beside the notation" (his 2026-11-22 decision, superseded). "One way to
     arrange things. A pinned Database and a beside arrangement are carried over automatically.
     Two small losses: a dragged Database strip height resets once, and an engine bar pinned
     across notation and tabs then sits above the tabs only."
  2. "Keep it as it is (Recommended)": the compact engine bar keeps its position menu (above
     tabs, above or below notation, below board); the full Analysis panel becomes draggable like
     every other panel.
  3. "Analysis board only (Recommended)": play, puzzle and ChessRiddle training boards keep their
     layout with movable dividers.
- **Agent proposals Felix confirmed by ordering the build, not his wording:** tabs stay the
  default so a new user sees the simple screen; no free-floating windows; "Second monitor: not
  now."; the Assistant stays docked because it must stay visible while it takes the user to a
  setting.
- **Consequences told to Felix:** the Assistant's narrowest width is 20rem; an arrangement that no
  longer fits the window (for example after opening the Assistant) shows the plain tab layout
  until there is room again.
- **Technical record:** the plan's agent decisions 1 to 13 as `d-20261125-53` to
  `d-20261125-65`, and the Photo tab staying in the tab strip as `d-20261125-66`, in
  `tasks/decisions.md`; plan `tasks/plans/2026-11-25-board-layout-arrange.md`.
- **Date:** 2026-11-25.
- **Later state (noted 2026-11-27):** Photo joins the arranged analysis-board areas;
  `d-20261126-36` supersedes `d-20261125-66`.

## 2026-11-27 — Settings remembers its view while its tab stays open

- **Question:** Switching from Settings to another tab and clicking the still-open Settings tab
  reset Settings to Board at the top. Should Settings remember where the user left off, and what
  should reset it?
- **Choice:** While the Settings tab stays open in this run, switching to another tab (a board or
  Library) and returning to Settings restores the same category, search query, and scroll offset.
  Closing the Settings tab with its X and opening Settings again starts at Board with an empty
  search at the top. Restarting the app (even when the Settings tab comes back with
  restore-open-tabs) starts at Board. A deep link from the Assistant, Guide, Coach, or photo import
  wins over the remembered view. Highlight is one-shot and is not restored.
- **Felix's reason:** Agreed lifetimes on 2026-11-27: switching away from Settings and back to the
  still-open Settings tab must remember the place he left; closing the tab and opening Settings
  again starts at Board. He accepted putting category and search on the Settings URL so the
  existing in-run page-tab last-location path restores them, matching Engines' `selected` search
  param.
- **Technical record:** plan `tasks/plans/2026-11-27-settings-view-restore.md` and `d-20261127-06`
  in `tasks/decisions.md` (alongside `d-20261121-02`).
- **Date:** 2026-11-27.

## 2026-11-27 — Game review works without AI; Coach Explain is hidden without a connection

- **Question:** How should AI explanations relate to the redesigned Game Review page, and should the "Explain" action on mistake moments appear when no AI connection is configured?
- **Choice:** The Game Review works completely without AI as an engine-based review. An "Explain" action on `?!`, `?`, and `??` key moments opens Coach with a question about that moment and is hidden when no AI connection is configured.
- **Ruled out:** Making AI part of generating the report itself, or showing a disabled or upsell "Explain" button without an AI connection.
- **Felix's reason:** The agent recommended "the report works completely without AI, and AI is an optional layer on top that only explains"; Felix chose "Yes, hidden without a connection" for Explain.
- **Technical record:** agent decisions D1–D8 in
  `tasks/decisions.md`; plan `tasks/plans/2026-11-27-game-review.md`.
- **Date:** 2026-11-27.

## 2026-11-27 — Game review scope: step one plus an informational repertoire note only

- **Question:** Should the Game Review include follow-up repertoire workflows, personal puzzle decks, or cross-game insights right away, or stay focused on single-game review with an informational repertoire comparison?
- **Choice:** Step one (single-game guided review) plus an informational note showing where the game left the user's repertoire or how far it followed it, with no follow-up workflows or personal puzzles.
- **Ruled out:** Follow-up repertoire editing or training flows, personal mistake puzzle decks ("step 2"), and cross-game insights ("step 3").
- **Felix's reason:** "I only want step one for now. Maybe the only thing you could mark is where the repertoire was left, because this is an important information. … this should just be an information here without any follow-up any without any personal puzzles and stuff like this"
- **Date:** 2026-11-27.

## 2026-11-27 — Repertoire note covers the user's side only

- **Question:** When comparing the game to the user's repertoire files, should the review show repertoire notes for both players or only for the user's side?
- **Choice:** Only the user's side (matched by player name against connected Lichess, Chess.com, or alias accounts; falling back to the side at the bottom of the board when neither or both match).
- **Ruled out:** Checking repertoire notes for both White and Black.
- **Felix's reason:** "Only my side"
- **Date:** 2026-11-27.

## 2026-11-27 — Time-per-move strip and time-trouble tag included

- **Question:** Should Game Review show a time-per-move strip under the chart, a "time trouble" tag on key moments, neither, or both?
- **Choice:** Both: a time-per-move strip under the chart (when at least half the moves have clock times) and a "Time trouble" tag on key moments played in time trouble.
- **Ruled out:** Leaving out either the time strip or the time-trouble tag.
- **Felix's reason:** "Yes, both"
- **Date:** 2026-11-27.

## 2026-11-27 — No live fill-in while the report analysis runs

- **Question:** Should the chart and key moments fill in live while the engine analysis is still running, or appear only once the finished report is applied?
- **Choice:** Leave live fill-in out; show progress while the report runs and render the finished review once complete.
- **Ruled out:** Streaming partial chart points and key moments into the review page during analysis.
- **Felix's reason:** "Leave it out"
- **Date:** 2026-11-27.

## 2026-11-27 — Skip a separate mockup and judge the built page directly

- **Question:** Should a mockup be built and reviewed before implementing the Game Review redesign, or should the redesign be built directly from the reviewed plan?
- **Choice:** Build the page directly without a separate mockup first, and evaluate the finished page in practice afterwards.
- **Ruled out:** Creating a standalone UI mockup before implementation.
- **Felix's reason:** "I'm not sure if it's worth it because maybe it's better to just build it and then in the end I can still correct it when I see how it works in practice."
- **Date:** 2026-11-27.

## 2026-11-27 — Unified panel headers and collapsible Database games region

- **Question:** How should analysis-board panel windows lay out their headers, where should Database's settings gear live, and how should users give move statistics more height?
- **Choice:** Every analysis-board panel window uses one shared `PanelHeader` component:
  - Database puts its settings gear and a new games-region collapse control on the first header line via a `PanelArea` chrome slot when shown as a tile, and keeps both icons on its top control row when shown inside the tab strip. Position/Compare/AddColumn stay as a left-packed cluster above `.sources`, never inside the multi-source column alignment grid.
  - The Database matching-games region can be collapsed so move statistics use the full panel height, remembered app-wide (`explorer-games-collapsed`, default expanded, hydrated before first paint) without rewriting the saved split height. Partial search always keeps the games list visible.
  - Engine (`BestMoves`) joins `PanelHeader` in this run's second phase (`d-20261127-28`).
- **Ruled out:** Leaving Database's gear on a sparse second line under the tile header, hiding only the Notation column, restoring the old Statistics/Games switch, or adding a Settings-page toggle for the games list.
- **Felix's reason:** Database was inconsistent with Engine and Notation, leaving empty space on the top header line; he asked for one central header component reused across panel windows, putting settings and header options on the first line, and collapsing the whole games region so move statistics can use the full height ("Yes, I think it's sensible to unify all of this. And then also make the changes to the database window that we talked about before.").
- **Technical record:** `d-20261127-26`, `d-20261127-27`, `d-20261127-28`, and `d-20261127-30` in `tasks/decisions.md`; plan `tasks/plans/2026-11-27-panel-header-unify.md`.
- **Date:** 2026-11-27.

## 2026-11-27 — Dark-mode notation marks stay ChessRiddle gold, not a picker

- **Question:** Should Dark mode let the user pick the accent colour, and the unfinished-variation dash, because the gold current-move wash is too quiet and the blue dashed open-variation mark does not fit?
- **Choice:** No picker. ChessRiddle gold stays the accent. Dark and Dim find the current move with a solid gold ring on the existing 10% fill. The unfinished-variation dash uses the warm brown `chart-4` token instead of the info blue, still distinct from gold so a move that is both current and unfinished stays readable.
- **Ruled out:** A user-facing accent picker, a second colour control for open variations, painting the dash in gold, and raising the current-move fill (annotation text would fall below 4.5:1).
- **Felix's reason:** He called a picker a nice-to-have and chose option A (fix the defaults) after Grok and Antigravity agreed that the demand is the two marks being hard to see, which a better default answers for every dark-mode user.
- **Technical record:** `d-20261127-32`.
- **Date:** 2026-11-27.

## 2026-11-27 — Save-to of the current game updates it; copy is named a copy

- **Question:** Opening a database game, editing info, and using “In Datenbank speichern” produced a second identical game because autosave had already written the origin silently. Should that be fixed, and how, given a suggestion of an “Infos gespeichert” popup?
- **Choice:** Fix it. The copy action becomes “Save a copy…” / “Als Kopie speichern…” (keybind name “Save a copy” / “Als Kopie speichern”). Picking the current origin database or file in that dialog updates the existing game. File → Save stays in-place. Autosave stays on with silent success. A quiet Saved / Saving… state lives in the board chrome Save slot. FileFreshnessGate “Save my version as a new game” stays the explicit duplicate.
- **Ruled out:** A popup or toast on every autosave or header keystroke. A second “add as a new game” button inside the copy dialog.
- **Felix's reason:** User feedback described the duplicate-game trap. Felix: “Alright, do everything as you recommend.” The recommendation was the copy rename, same-origin in-place update, and quiet chrome indicator.
- **Technical record:** `d-20261127-33` through `d-20261127-37` in `tasks/decisions.md`; plan `tasks/plans/2026-11-27-save-copy-and-saved-indicator.md`.
- **Date:** 2026-11-27.
