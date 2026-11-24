# Handoff to ChessRiddle: a Studio guide on the website from the same topic files

Receiver: a ChessRiddle session in `/home/felixb/Projekte/chess-tactics-app` (the `/studio` page,
`frontend/web/src/app/[locale]/studio/`).

## Mandate

Felix, 2026-11-24, asked whether Studio needs a guide that explains all features or whether the
Assistant is enough. The recommendation he ordered built ("Alright, do this full auto …") was a
guide from the Assistant's topic files, reachable from Studio's Help menu for every user, with the
same content also on the ChessRiddle website, "where it can carry videos and be found by search",
text first. The in-app half was built in the Studio repository on 2026-11-24 (plan
`tasks/plans/2026-11-24-feature-guide.md`, decision `d-20261124-19`). This note is the website
half. It is not yet a build order for the website: whether and when to build it, and where it sits
on `/studio`, is open for Felix.

## The source of truth

Studio repository `felixabeck/chessriddle-studio` (public), branch `master`:

* English source: `src/components/assistant/topics/<id>.md`, 18 topics. Fixed reading order:
  `src/components/assistant/topics/order.ts` (`HELP_TOPIC_ORDER`).
* Translations: `src/components/assistant/topics/<locale>/<id>.md` for every Studio locale except
  `en-US`/`en-GB` (de-DE, es-ES, fr-FR, it-IT, pt-PT, pl-PL, nb-NO, ru-RU, uk-UA, be-BY, tr-TR,
  ko-KR, zh-CN, zh-TW).
* File format: frontmatter `id`, `title`, `summary` (translations also `source:`, a hash of the
  English file they translate, enforced by Studio's `topics.test.ts`), then a body of paragraphs,
  `- ` lists, `N. ` ordered lists, `**bold**` and inline backticks.
* Two placeholder forms inside the text:
  * `{{label:<i18n key>}}` names a Studio UI label. Studio resolves it from its catalogues
    (`src/translation/<locale>.json`). The website must resolve it from the same catalogue of the
    same Studio version, or the guide shows raw keys.
  * `[[<target>]]` is an in-app link (`page:library`, `settings-category:board`,
    `setting:<id>`, `feedback`). On the website it cannot open anything; render its label as
    plain text. In Studio the labels come from `src/components/assistant/targets.ts`; every topic
    target resolves there (test "every [[target]] exists in the registry …").

## What the website needs to decide and build

1. Fetch at build time (or ISR) the files of the latest Studio release tag, not `master`, so the
   guide matches the version people download. `releaseDownloads.ts` already reads the latest
   release.
2. Parse the subset above. `frontend/web/src/lib/studio/releaseNotesMarkdown.ts` already parses a
   close subset (no ordered lists yet) and never emits HTML; extend that parser rather than
   writing a second one.
3. Map ChessRiddle locales to Studio locales. ChessRiddle has locales Studio does not ship (for
   example `ar`); fall back to English for those, and say so in the page.
4. Resolve `{{label:…}}` from the Studio catalogue of that release, and `[[…]]` to plain label
   text.
5. Videos: Felix's original wish ("explanation videos maybe or at least some guiding text") is
   text first. Videos are a later product decision.

## Verification to carry

* A guide page per locale renders every topic in `HELP_TOPIC_ORDER` with no raw `{{label:`,
  `[[` or target ids.
* A locale without a Studio translation falls back to English visibly, not silently.
* `/privacy` needs no change: the page fetches public files from GitHub at build time and sends
  nothing about the visitor.
