# Product decisions

This record holds product precedent: what ChessFable is for and how it behaves.
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
