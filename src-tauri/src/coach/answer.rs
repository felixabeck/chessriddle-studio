//! The model's final text, split into prose and checked lines.
//!
//! The system prompt asks for every concrete line in double square brackets, in SAN, from the
//! turn position. Each bracket is resolved by the chess library; a line that is not legal is
//! never shown as a line.

use serde::Serialize;
use specta::Type;

use super::{
    brackets,
    lines::{move_tokens, TurnPosition},
};

/// The most lines one answer may carry as lines; further brackets stay prose.
pub(crate) const MAX_ANSWER_LINES: usize = 40;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum Segment {
    Text {
        text: String,
    },
    /// A line that is legal from the turn position, in the library's SAN with its engine moves.
    Line {
        san: Vec<String>,
        uci: Vec<String>,
    },
}

/// A bracket whose moves are not legal from the turn position.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FailedLine {
    /// What the model wrote between the brackets.
    pub written: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Answer {
    pub segments: Vec<Segment>,
    pub failed: Vec<FailedLine>,
}

impl Answer {
    /// Reads `text` against the turn position. A failed line stays in the answer as prose without
    /// its brackets, so nothing the model wrote is lost and nothing unchecked is offered as a move.
    pub(crate) fn parse(text: &str, turn: &TurnPosition) -> Self {
        let mut failed = Vec::new();
        let mut lines = 0;
        let segments = brackets::split_segments(
            text,
            |text| Segment::Text { text },
            |written| {
                let tokens = move_tokens(written);
                if tokens.is_empty() || lines == MAX_ANSWER_LINES {
                    return None;
                }
                match turn.resolve(&tokens) {
                    Ok(line) => {
                        lines += 1;
                        Some(Segment::Line {
                            san: line.san,
                            uci: line.uci,
                        })
                    }
                    Err(error) => {
                        failed.push(FailedLine {
                            written: written.trim().to_owned(),
                            reason: error.explain(),
                        });
                        None
                    }
                }
            },
        );
        Self { segments, failed }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn turn() -> TurnPosition {
        TurnPosition::new(START, &["e2e4".to_owned(), "e7e5".to_owned()]).unwrap()
    }

    fn text(value: &str) -> Segment {
        Segment::Text { text: value.into() }
    }

    fn line(san: &[&str], uci: &[&str]) -> Segment {
        Segment::Line {
            san: san.iter().map(|m| (*m).to_owned()).collect(),
            uci: uci.iter().map(|m| (*m).to_owned()).collect(),
        }
    }

    #[test]
    fn prose_and_legal_lines_alternate_in_order() {
        let answer = Answer::parse(
            "Develop with [[2. Nf3 Nc6 3. Bb5]] or play [[Bc4]].\nBoth are fine.",
            &turn(),
        );
        assert_eq!(
            answer.segments,
            [
                text("Develop with "),
                line(&["Nf3", "Nc6", "Bb5"], &["g1f3", "b8c6", "f1b5"]),
                text(" or play "),
                line(&["Bc4"], &["f1c4"]),
                text(".\nBoth are fine."),
            ]
        );
        assert!(answer.failed.is_empty());
    }

    #[test]
    fn an_illegal_line_becomes_prose_without_brackets_and_is_reported() {
        let answer = Answer::parse("Try [[Nf3 Nc6 Ke3]] and [[d4]].", &turn());
        assert_eq!(
            answer.segments,
            [
                text("Try Nf3 Nc6 Ke3 and "),
                line(&["d4"], &["d2d4"]),
                text(".")
            ]
        );
        assert_eq!(answer.failed.len(), 1);
        assert_eq!(answer.failed[0].written, "Nf3 Nc6 Ke3");
        assert!(answer.failed[0].reason.contains("Half-move 3"));
    }

    #[test]
    fn text_without_lines_and_unbalanced_brackets_stay_prose() {
        assert_eq!(
            Answer::parse("Just a plan.", &turn()).segments,
            [text("Just a plan.")]
        );
        assert_eq!(
            Answer::parse("Open [[Nf3 and never closed", &turn()).segments,
            [text("Open [[Nf3 and never closed")]
        );
        assert_eq!(
            Answer::parse("Empty [[ ]] and [[1.]] here", &turn()).segments,
            [text("Empty   and 1. here")]
        );
        assert!(Answer::parse("", &turn()).segments.is_empty());
    }

    #[test]
    fn markup_inside_a_bracket_never_becomes_a_line() {
        let answer = Answer::parse("[[<img src=x onerror=alert(1)>]]", &turn());
        assert_eq!(answer.segments, [text("<img src=x onerror=alert(1)>")]);
        assert_eq!(answer.failed.len(), 1);
    }

    #[test]
    fn lines_beyond_the_bound_stay_prose() {
        let many = "[[Nf3]] ".repeat(MAX_ANSWER_LINES + 2);
        let answer = Answer::parse(&many, &turn());
        let lines = answer
            .segments
            .iter()
            .filter(|segment| matches!(segment, Segment::Line { .. }))
            .count();
        assert_eq!(lines, MAX_ANSWER_LINES);
        assert!(answer.failed.is_empty());
        assert!(
            matches!(answer.segments.last(), Some(Segment::Text { text }) if text.contains("Nf3"))
        );
    }
}
