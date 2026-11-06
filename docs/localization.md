# Localization contract

All user-visible application text must use `t()` or `<Trans>`. Run `pnpm i18n:extract`, then `pnpm i18n:check` before submitting a change. The latter is a release gate: it requires the exact extracted key set and a non-empty translated value in every shipped catalogue.

`pnpm i18n:jsx` rejects hard-coded JSX text and the user-facing `aria-label`, `label`, `placeholder`, `description`, `title`, and `alt` attributes. Its only exemptions are proper product names and their canonical URLs (`ChessRiddle Studio`, `En Croissant`, `Lichess`, `Chess.com`, `chess.com`, `www.encroissant.org`) and chess/technical notation (`FEN`, `PGN`, `ELO`, `UCI_*`, `WDL`, `ACPL`, `n/s`, `O-O`, `O-O-O`, and date/unknown-value notation). New exceptions need a documented reason in the checker; ordinary UI labels, errors, hints, tooltips, and native-dialog copy are never exempt.

The application lazy-loads the selected locale and `en-US` fallback. Always call `changeLocale()` rather than `i18n.changeLanguage()` directly so a selected language is loaded before it becomes active.

For a finite set of messages, use literal keys in each `t()` call so extraction retains them. Adding catalogue entries alone does not preserve dynamically constructed keys. Test these messages against the shipped catalogues with fallback disabled after extraction.
