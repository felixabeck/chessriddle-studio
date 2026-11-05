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
