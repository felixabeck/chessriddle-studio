---
paths:
  - "src/utils/treeReducer.ts"
  - "src/utils/chess.ts"
  - "src/utils/chessops.ts"
  - "src/utils/repertoire.ts"
  - "src/state/store/tree.ts"
  - "src/components/common/GameNotation.tsx"
  - "src/components/panels/practice/**"
  - "src-tauri/src/chess.rs"
  - "src-tauri/src/game.rs"
---

# Chess Tree Semantics Rule

> **Relevant when working on:** the in-memory game tree, position comparison, move paths, move
> numbering, or anything deriving side to move from an index.
>
> *Path-scoped: this file loads automatically when Claude Code touches the paths in the frontmatter
> above. Other agents never auto-load it — read it directly, as the rules table in the
> repo-root `CLAUDE.md` instructs. On-disk and database encoding is a different rule:
> `pgn-scanning.md`.*

## The single rule

**Position identity comes from `getBoardState` in `src/utils/treeReducer.ts` — never from a new
`split` of a FEN string. Move numbers and colours are anchored to the root FEN's side to move and
halfmove clock — never to ply 0 being White. A `number[]` path is re-derived after any mutation
that can insert, delete, promote or reorder nodes — never reused across it.**

## Why

The defining property of this failure class is that the code is *reasonable TypeScript and wrong
chess*: type-checking, linting and a green test suite say nothing about whether the right FEN
fields were compared. Every incident below survived review at the time.

* **Which fields define "the same position".** `5bccdc06` — threefold repetition compared
  `fen.split(" - ")[0]`, which breaks the moment castling rights are non-empty and ignores the
  en-passant square. The fix introduced `getBoardState = fen.split(" ").slice(0, 4).join(" ")`
  (`src/utils/treeReducer.ts:212`). `242d01df` — the 50-move rule walked the tree instead of reading
  the halfmove clock out of the FEN. `8f85fef3` caches transpositions under a third key,
  `stripClock(fen)` (`src/utils/chess.ts:687`).
* **A path outliving the tree it indexed.** `0de7cc43` —
  `while (!promoteVariation(state, path)) {}` never refreshed `path` from `state.position` and
  looped forever (issue #496). `a59b561c` — `deleteMove` only corrected `state.position` when the
  path lengths matched exactly, leaving the cursor inside a deleted subtree. `7ff0646f` replaced
  `PositionMove.childIndex: number` with `path: number[]` and rebuilt repertoire coverage around FEN
  keys, because a single path cannot represent a transposed node.
* **Parity assumed from the standard start position.** `10a49bab` — `defaultTree` hardcoded
  `halfMoves: 0` and PGN parsing hardcoded ply 0, giving wrong move numbers from a Black-to-move
  FEN. `2f96637a` — annotation colour came from `i % 2 === 1`, ignoring the root FEN. `274dad07` —
  `floor(halfMoves / 2) + 1` where `ceil(halfMoves / 2)` was correct.
* **Board and tree drifting apart on an edit.** `637b9f88` — `SET_HEADERS` stored a new `fen`
  without rebuilding the root. `9ba36493` — toggling orientation spread the headers without `fen`
  and wiped a custom setup. `050acb57` — editing the board pasted the old FEN fields 2–6 back on,
  keeping impossible castling rights.
* **"Child 0" assumed to be the intended continuation.** `1337c8bf` — `goToNext` always took
  `children[0]`, so practice navigated into the wrong variation.
* **Metadata lost across a round trip.** `d4efe5fa` (non-standard headers dropped), `167d8cf0`
  (`[%timestamp]` survived in comment text because chessops only strips `[%clk]`).

Note that `7ff0646f` and `d250925f` *re-fix* the first two classes rather than closing them.

## Three helpers, three questions

`getBoardState` (first four FEN fields), `stripClock`, and the full FEN answer different questions.
Pick by what is being asked, and never introduce a fourth truncation:

| Question | Key |
| --- | --- |
| Is this the same position for repetition or repertoire coverage? | `getBoardState(fen)` |
| Is this the same node for a transposition cache? | `stripClock(fen)` |
| Can the 50-move rule fire? | the halfmove field of the FEN, read directly |

Two different truncations coexisting in one flow is a defect even if both are individually
defensible.

## DO

* Anchor every move number, side to move and annotation colour to the root FEN. Mentally run new
  code against a game that starts from a Black-to-move FEN.
* Refresh the path from `state.position` on every iteration of a loop that mutates the tree.
* Let the chess library decide legality — promotion, en passant, castling including Chess960,
  stalemate versus checkmate — instead of re-implementing the rule ad hoc.
* Rebuild or invalidate derived caches (transposition and board-state maps) wherever the tree is
  mutated or rehydrated.

## DO NOT

* Write a new `fen.split(...)` for position comparison.
* Take `children[0]` or `candidates[0]` as the intended continuation without a defined reason that
  the order is meaningful.
* Rebuild a tree, header set or comment without checking what is silently dropped on the way back:
  non-standard headers, clock and timestamp annotations, NAGs, the starting FEN.

Reviewed by the `review-chess-semantics` lens, which carries the adversarial questions for this
area and treats a violation of the rule above as a blocker.
