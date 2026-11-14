---
paths:
  - "src-tauri/src/pgn.rs"
  - "src-tauri/vendor/pgn-reader/src/reader.rs"
  - "src-tauri/src/lexer.rs"
  - "src-tauri/src/db/**"
  - "src-tauri/src/opening.rs"
  - "src-tauri/src/puzzle.rs"
  - "src/components/tabs/ImportModal.tsx"
  - "src/utils/db.ts"
---

# PGN Scanning and Database Encoding Rule

> **Relevant when working on:** detecting game boundaries in PGN bytes, the byte-offset index,
> encoding or decoding moves for the database, position search predicates, or import transactions.
>
> *Path-scoped: this file loads automatically when Claude Code touches the paths in the frontmatter
> above. Other agents never auto-load it — read it directly, as the rules table in the
> repo-root `CLAUDE.md` instructs. In-memory tree and position semantics are a different rule:
> `chess-tree-semantics.md`.*

## The single rule

**Every position setup on the encode path uses the same `CastlingMode` as the path that reads it
back — derived via `CastlingMode::detect`, never a hardcoded mode — and the game's own starting FEN,
not `Chess::default()`. Game-boundary
detection is comment-, BOM- and CRLF-aware, and when the same boundary rule exists in more than one
function, all copies change together. A PGN database is routinely hundreds of megabytes: nothing
reads one whole into memory.**

## Why

The failures in this domain are *off-by-a-boundary* failures — one game read as two, an offset three
bytes short, a mode that differs between writer and reader. They produce plausible-looking wrong
data rather than crashes, so a green import proves nothing, and the corrupted index is trusted by
every later read.

* **Game boundaries detected by a naive line prefix.** `86ca3f44` — splitting tested
  `line.starts_with('[')`, so a `[` at the start of a line *inside a `{ }` comment* split one game
  into two and desynchronised everything downstream. The fix threads an `in_comment` flag through
  the scanner — and had to be applied in **two** places, because the same test existed twice.
* **Byte offsets and reader position drifting from the file.** `3a632a7d` — a BOM's three bytes were
  not accounted for as the seek origin, and a guard left small files uncached. `f46f8610` — an offset
  index was read past the end of its vector. `eb01f5e6` — the reader was not rewound after
  `io::copy`, producing duplicate games. `42dde3de` — a missing cache entry was `unwrap`ed, and the
  "fix" silently returned instead, i.e. read game 0.
* **`CastlingMode` differing between encode and decode.** `fda1b87f` set one mode and `4e46ed52`
  another, so encoded move indices decoded to different moves. `7b128575` normalised this to
  `CastlingMode::detect`. The mode is *derived from the position*, never hardcoded per call site:
  the opening-book visitor in `src-tauri/src/game.rs` starts at `Standard` and upgrades to
  `CastlingMode::detect(parsed_fen.as_setup())` the moment it parses a FEN header (line 1646). The
  remaining `Chess960` literals are all inside `mod tests`.
* **A search predicate ignoring a dimension of the position.** `929dc1b6` — position search compared
  the board without the side to move. `c6ce630b` — decoding always replayed from `Chess::default()`
  and ignored the game's own starting FEN. `72642b6c` — forward and backward pruning were inverted
  in partial searches.
* **Whole-file materialisation.** `06b1c959` introduced reading the entire PGN via `readTextFile`.
* **Transaction and progress boundaries.** `cbdf2a09` — one transaction *per file* when importing
  several, so a failure on the third left the first two committed. `06c23b6a` — search cancellation
  was checked after the progress emit and dropped in-flight results.
* **Panics on non-conforming input.** `4e46ed52` — `btoi(...).expect("WhiteElo")` and
  `Fen::from_ascii(...).unwrap()` crashed the whole import on one malformed tag; `d12f43cc` is the
  same class for `Unrated` ratings.

## Inputs that must not break the scanner

A comment containing `[`. A BOM-prefixed file. CRLF line endings. A quoted tag value containing a
delimiter. A Chess960 game. A malformed `WhiteElo`. A 300 MB database. A game that starts from a
non-standard FEN. These are the concrete shapes every boundary or offset change is checked against.

## DO

* Grep for the *other* side of an encode/decode pair rather than trusting the local call.
* Make a missing offset-cache entry an error, and invalidate the cache when the file changes.
* Ask after any `seek`, `copy` or partial read whether the next operation still assumes a valid
  reader position.
* Make one logical import one transaction boundary, and observe cancellation before results are
  emitted or dropped.
* Fail the one malformed game, not the process.

## DO NOT

* Add a second copy of a boundary rule. If one already exists in two functions, that is a defect to
  resolve, not a pattern to follow.
* Compare positions without every dimension that makes two positions different — board, side to
  move, and the game's real starting position.
* `unwrap` or `expect` a value parsed out of a user-supplied PGN.

Reviewed by the `review-pgn-index` lens, which treats a boundary rule changed in one place while a
duplicate survives as a blocker. The panic-free and cancellation clauses restate
`async-resource-invariants.md` for this area.
