//! Splits a model's final text at `[[...]]` into prose and bracket contents.
//!
//! What a bracket means (a chess line in the Coach, a link target in the Assistant) belongs to
//! the caller. An unclosed `[[` stays prose so nothing the model wrote is dropped.

const OPEN: &str = "[[";
const CLOSE: &str = "]]";

/// Splits `text` into caller-defined segments by scanning `[[...]]` brackets.
///
/// `resolve` receives the text inside each closed bracket. Returning `Some(segment)` flushes any
/// accumulated prose and emits `segment`; returning `None` folds the bracket's inner text
/// (without `[[` and `]]`) into the surrounding prose so adjacent prose stays one segment. An
/// unclosed `[[` and everything after it stays prose.
pub(crate) fn split_segments<T>(
    text: &str,
    mut on_prose: impl FnMut(String) -> T,
    mut resolve: impl FnMut(&str) -> Option<T>,
) -> Vec<T> {
    let mut segments = Vec::new();
    let mut prose = String::new();
    let mut rest = text;
    while let Some(open) = rest.find(OPEN) {
        let after_open = &rest[open + OPEN.len()..];
        let Some(close) = after_open.find(CLOSE) else {
            break;
        };
        prose.push_str(&rest[..open]);
        let written = &after_open[..close];
        rest = &after_open[close + CLOSE.len()..];
        match resolve(written) {
            Some(segment) => {
                if !prose.is_empty() {
                    segments.push(on_prose(std::mem::take(&mut prose)));
                }
                segments.push(segment);
            }
            None => prose.push_str(written),
        }
    }
    prose.push_str(rest);
    if !prose.is_empty() {
        segments.push(on_prose(prose));
    }
    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    enum Part {
        Text(String),
        Link(String),
    }

    fn parse(text: &str) -> Vec<Part> {
        split_segments(text, Part::Text, |written| {
            matches!(written, "settings:board" | "engines" | "ok")
                .then(|| Part::Link(written.to_owned()))
        })
    }

    #[test]
    fn prose_and_resolved_brackets_split_without_empty_prose_segments() {
        assert_eq!(
            parse("See [[settings:board]] or [[engines]]."),
            [
                Part::Text("See ".into()),
                Part::Link("settings:board".into()),
                Part::Text(" or ".into()),
                Part::Link("engines".into()),
                Part::Text(".".into()),
            ]
        );
        // Leading, adjacent and trailing resolved brackets must not produce empty prose segments.
        assert_eq!(
            parse("[[settings:board]] tail"),
            [
                Part::Link("settings:board".into()),
                Part::Text(" tail".into()),
            ]
        );
        assert_eq!(
            parse("[[settings:board]][[engines]]"),
            [
                Part::Link("settings:board".into()),
                Part::Link("engines".into()),
            ]
        );
        assert_eq!(
            parse("head [[engines]]"),
            [Part::Text("head ".into()), Part::Link("engines".into())]
        );
        assert!(parse("").is_empty());
    }

    #[test]
    fn an_unclosed_bracket_stays_prose() {
        assert_eq!(
            parse("Open [[target and never closed"),
            [Part::Text("Open [[target and never closed".into())]
        );
        assert_eq!(
            parse("Before [[ok]] then [[unclosed"),
            [
                Part::Text("Before ".into()),
                Part::Link("ok".into()),
                Part::Text(" then [[unclosed".into()),
            ]
        );
    }

    #[test]
    fn unresolved_brackets_coalesce_into_surrounding_prose_without_delimiters() {
        assert_eq!(
            parse("Open [[unknown]] or [[settings:board]] and [[still open"),
            [
                Part::Text("Open unknown or ".into()),
                Part::Link("settings:board".into()),
                Part::Text(" and [[still open".into()),
            ]
        );
    }
}
