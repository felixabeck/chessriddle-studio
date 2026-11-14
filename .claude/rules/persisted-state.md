---
paths:
  - "src/state/**"
  - "src/hooks/**"
  - "src/utils/tabs.ts"
  - "src/components/tabs/**"
---

# Persisted Renderer State Rule

> **Relevant when working on:** anything written to `sessionStorage` or `localStorage`, Jotai atoms
> with persistence, the per-tab zustand tree stores, or the tab open/close/switch flows.
>
> *Path-scoped: this file loads automatically when Claude Code touches the paths in the frontmatter
> above, and the rule additionally binds for any direct web-storage access anywhere. Other
> agents never auto-load it — read it directly, as the rules table in the repo-root `CLAUDE.md`
> instructs.*

## The single rule

**Every write and every read of a stored value goes through `serializeStorageValue` /
`deserializeStorageValue` in `src/state/store/debouncedStorage.ts`. Never hand-roll a
`JSON.stringify` next to a store that persists through the middleware, and never write an unbounded
structure to storage without a bound, compression, and a handled failure.**

## Why

Persistence defects do not fail at write time. They fail on the next read, in another tab, or on the
machine with more data than yours — so a test suite that never fills a quota and never reloads
proves nothing.

* **Unbounded payload against a fixed quota.** `d250925f` — tree state was persisted as raw JSON; a
  ~6,600-node game serialises to roughly 1.5 MB, so a couple of open tabs exhausted the ~5 MB
  session-storage quota and `setItem` threw unhandled. The fix compresses with `compressToUTF16`
  (~5× smaller) and raises an explicit, user-facing quota error. This is also the real cause behind
  that commit's "large PGN import hang" subject — **the parser was not at fault**; do not cite it as
  parser evidence.
* **A write that bypasses the store's own serializer.** In the same commit, `createTab` in
  `src/utils/tabs.ts` wrote `sessionStorage.setItem(id, JSON.stringify({ version: 0, state: tree }))`
  by hand while the persist middleware read a different encoding. The fix routes both through the
  exported `serializeStorageValue`. Seed writes at creation time are the usual offender.
* **State written to a key nobody reads.** `37757834` — engine Threads/Hash edits were spread into an
  orphaned key while reads came from `opponent.engine.settings`, so per-tab settings vanished on tab
  switch.
* **A persisted selection not re-validated against a new context.** `35b0884f` — a persisted puzzle
  theme survived a context change and was either wiped by a reset effect or sent onward though no
  longer valid. The fix derives an *effective* value instead of resetting the persisted atom.
* **Hydration assuming well-formed data.** `e32d2588` — corrupt or absent persisted JSON threw
  instead of falling back to the default.
* **Identity keyed on a mutable field.** `5b5d006a` — engines were keyed by `name` for deletion,
  React keys, accordion values and drag ids, so duplicates collided.
* **Tab lifecycle.** `b829b562` — a synchronous `setActiveTab` during close crashed React until
  wrapped in `startTransition`. `ad4cbb75` added the `beforeunload`/`pagehide` flush that makes
  debounced writes survive quitting.

## Budget

The quota is ~5 MB per origin and it is shared by every open tab. Estimate the realistic worst case
— a long game, a large imported file, several open tabs — not the test case. Any `setItem` sits
inside a `try` that produces a comprehensible error rather than an unhandled throw.

## DO

* Find *both* sides of every storage key you touch: the writer and the reader, the creation path and
  the update path.
* Match key scope to how the value is edited and read — per tab, per document, or global.
* Re-validate a persisted value that names something contextual (engine, theme, database, file, tab)
  on read, and correct it with a derived effective value rather than a destructive reset.
* Keep the `beforeunload`/`pagehide` flush correct when changing anything about the debounce.
* Fall back to a default for absent, truncated, corrupt or older-shape values, except for tab-tree
  storage: a present undecodable tab-tree value (including an empty string) or a failed tree read
  remains gated and cannot be overwritten by a clean default. Keep undecodable bytes in place and
  expose the tree as unreadable; keep a refused read unavailable until an explicit retry succeeds.
  Workspace ID repair may copy those exact bytes to a new key only after verifying the copy and
  before publishing repaired metadata. Only an explicit successful discard may remove the last
  workspace-owned unreadable value. Once workspace metadata no longer owns a UUID tree key, its
  recorded pending-removal intent (tab close, replaced import owner, migrated source) removes the
  stored value whether or not it decodes and retries until the key is absent, while an unowned
  undecodable value with no recorded intent is never swept, an intent under a non-UUID id still
  needs a decodable tree, and a refused-admission marker removes only a decodable tree
  (d-20261008-09). When the pending list exceeds its cap after the retry, the oldest intents are
  dropped, those bytes stay until a certain-ownership sweep removes a decodable tree or the webview
  session ends, and the close or load still publishes. A version field that nothing migrates is
  not migration.

## DO NOT

* Key anything persisted by a user-editable name or path — including React keys, drag ids and
  atom-family parameters over persisted collections.
* Leave an orphaned entry behind when a tab closes, or persist what should not survive it.

Reviewed by the `review-persisted-state` lens. Runtime process keys and engine result routing are a
different rule: `engine-lifecycle.md`. Commit `5b5d006a` is genuinely both.
