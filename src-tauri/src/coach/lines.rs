//! Lines of moves as a model writes them, checked by the chess library.
//!
//! The model names moves in SAN from the turn position. Nothing it writes is trusted: every move
//! is resolved against the position it is played in, and a line with one illegal move is refused
//! as a whole. The rules of chess stay with the library (castling including Chess960, en passant,
//! promotion, mate and stalemate).

use shakmaty::{san::SanPlus, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Position};

use super::error::CoachError;

/// The longest line a model may write or a tool may be asked about.
pub(crate) const MAX_LINE_PLIES: usize = 40;
/// The longest token still considered a move ("exd8=Q+" has 7 characters).
pub(crate) const MAX_MOVE_TOKEN_CHARS: usize = 12;

/// The position a turn is about: the game start FEN and the UCI moves that lead to the node the
/// board showed when the user sent the message.
#[derive(Clone)]
pub(crate) struct TurnPosition {
    start_fen: String,
    moves: Vec<String>,
    castling_mode: CastlingMode,
    position: Chess,
}

impl TurnPosition {
    pub(crate) fn new(start_fen: &str, moves: &[String]) -> Result<Self, CoachError> {
        let canonical = crate::engine::canonicalize_engine_position(start_fen, moves)
            .map_err(|_| CoachError::InvalidInput)?;
        Ok(Self {
            start_fen: start_fen.to_owned(),
            moves: moves.to_vec(),
            castling_mode: canonical.castling_mode,
            position: canonical.position,
        })
    }

    pub(crate) fn start_fen(&self) -> &str {
        &self.start_fen
    }

    /// The UCI moves from the game start to the turn position.
    pub(crate) fn moves(&self) -> &[String] {
        &self.moves
    }

    pub(crate) fn position(&self) -> &Chess {
        &self.position
    }

    /// The FEN of the turn position itself.
    pub(crate) fn fen(&self) -> String {
        position_fen(&self.position)
    }

    /// The UCI moves from the game start to the end of `line`, as an engine takes them.
    pub(crate) fn moves_with(&self, line: &ResolvedLine) -> Vec<String> {
        self.moves.iter().chain(&line.uci).cloned().collect()
    }

    pub(crate) fn resolve(&self, tokens: &[String]) -> Result<ResolvedLine, LineError> {
        resolve_line(&self.position, self.castling_mode, tokens)
    }
}

pub(crate) fn position_fen(position: &Chess) -> String {
    shakmaty::fen::Fen::from_position(position.clone(), EnPassantMode::Legal).to_string()
}

/// A line whose every move is legal where it is played.
#[derive(Clone, Debug)]
pub(crate) struct ResolvedLine {
    /// The moves in the library's own SAN, whatever spelling the model used.
    pub san: Vec<String>,
    pub uci: Vec<String>,
    pub end: Chess,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LineError {
    TooLong,
    /// The move at `ply` (0-based) is not a legal move in its position.
    Illegal {
        ply: usize,
        token: String,
    },
}

impl LineError {
    /// One sentence a model can act on.
    pub(crate) fn explain(&self) -> String {
        match self {
            Self::TooLong => format!("The line is longer than {MAX_LINE_PLIES} half-moves."),
            Self::Illegal { ply, token } => format!(
                "Half-move {} (\"{token}\") is not a legal move in the position it is played in.",
                ply + 1
            ),
        }
    }
}

/// Why a position has no further move, if it has none.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Terminal {
    Checkmate { winner: Color },
    Stalemate,
}

pub(crate) fn terminal(position: &Chess) -> Option<Terminal> {
    if position.is_checkmate() {
        Some(Terminal::Checkmate {
            winner: position.turn().other(),
        })
    } else if position.is_stalemate() {
        Some(Terminal::Stalemate)
    } else {
        None
    }
}

/// Normalises a single raw move token: strips trailing annotation punctuation, drops result
/// markers and leading move numbers/ellipses, and converts digit-zero castling to letter-O.
pub(crate) fn normalize_move_token(word: &str) -> Option<String> {
    let word = word.trim_end_matches(['!', '?', ',', ';']);
    if matches!(word, "1-0" | "0-1" | "1/2-1/2" | "*") {
        return None;
    }
    // A move number is digits followed by a dot; "0-0" is not one.
    let after_digits = word.trim_start_matches(|c: char| c.is_ascii_digit());
    let word = if after_digits.is_empty() || after_digits.starts_with(['.', '…']) {
        after_digits.trim_start_matches(['.', '…']).trim_start()
    } else {
        word
    };
    if word.is_empty() {
        None
    } else if word.starts_with("0-0") {
        Some(word.replace('0', "O"))
    } else {
        Some(word.to_owned())
    }
}

/// Splits model text into move tokens: move numbers ("12.", "12...", "12.Nf3"), ellipses, result
/// markers and annotation glyphs are dropped, digit-zero castling is read as castling.
pub(crate) fn move_tokens(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter_map(normalize_move_token)
        .collect()
}

/// Resolves one SAN token against `position`, advancing `position` and returning `(san, uci)` in
/// the library's own spelling, or `None` if the token is overlong, unparseable, or illegal.
pub(crate) fn resolve_move_token(
    position: &mut Chess,
    castling_mode: CastlingMode,
    token: &str,
) -> Option<(String, String)> {
    if token.chars().count() > MAX_MOVE_TOKEN_CHARS {
        return None;
    }
    let played = SanPlus::from_ascii(token.as_bytes())
        .ok()
        .and_then(|parsed| parsed.san.to_move(position).ok())?;
    let uci = UciMove::from_move(&played, castling_mode).to_string();
    let san = SanPlus::from_move_and_play_unchecked(position, &played).to_string();
    Some((san, uci))
}

fn resolve_line(
    start: &Chess,
    castling_mode: CastlingMode,
    tokens: &[String],
) -> Result<ResolvedLine, LineError> {
    if tokens.len() > MAX_LINE_PLIES {
        return Err(LineError::TooLong);
    }
    let mut position = start.clone();
    let mut san = Vec::with_capacity(tokens.len());
    let mut uci = Vec::with_capacity(tokens.len());
    for (ply, token) in tokens.iter().enumerate() {
        let Some((played_san, played_uci)) =
            resolve_move_token(&mut position, castling_mode, token)
        else {
            return Err(LineError::Illegal {
                ply,
                token: token.chars().take(MAX_MOVE_TOKEN_CHARS).collect(),
            });
        };
        san.push(played_san);
        uci.push(played_uci);
    }
    Ok(ResolvedLine {
        san,
        uci,
        end: position,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

    fn turn(fen: &str, moves: &[&str]) -> TurnPosition {
        let moves: Vec<String> = moves.iter().map(|m| (*m).to_owned()).collect();
        TurnPosition::new(fen, &moves).unwrap()
    }

    fn tokens(text: &str) -> Vec<String> {
        move_tokens(text)
    }

    #[test]
    fn model_spellings_reduce_to_plain_moves() {
        assert_eq!(
            tokens("1. e4 e5 2.Nf3! Nc6?! 3... 0-0 4. O-O-O+ 1-0"),
            ["e4", "e5", "Nf3", "Nc6", "O-O", "O-O-O+"]
        );
        assert_eq!(tokens("12...Nf6, 13. Bg5;"), ["Nf6", "Bg5"]);
        assert_eq!(tokens("… a8=Q# *"), ["a8=Q#"]);
        assert!(tokens("  1.  2... ").is_empty());
    }

    #[test]
    fn a_legal_line_resolves_to_library_san_and_engine_moves() {
        let turn = turn(START, &["e2e4", "e7e5"]);
        let line = turn.resolve(&tokens("2. Nf3 Nc6 3. Bb5 a6")).unwrap();
        assert_eq!(line.san, ["Nf3", "Nc6", "Bb5", "a6"]);
        assert_eq!(line.uci, ["g1f3", "b8c6", "f1b5", "a7a6"]);
        assert_eq!(
            turn.moves_with(&line),
            ["e2e4", "e7e5", "g1f3", "b8c6", "f1b5", "a7a6"]
        );
        // A wrong check mark is the model's spelling, not an illegal move.
        assert_eq!(turn.resolve(&tokens("Nf3+")).unwrap().san, ["Nf3"]);
        assert!(turn.resolve(&[]).unwrap().san.is_empty());
    }

    #[test]
    fn a_line_is_read_from_the_turn_position_also_with_black_to_move() {
        let black_to_move = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2";
        let turn = turn(black_to_move, &["b8c6"]);
        assert_eq!(
            turn.fen(),
            "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 1 3"
        );
        assert_eq!(
            turn.resolve(&tokens("3. Nf3 Nf6")).unwrap().san,
            ["Nf3", "Nf6"]
        );
        // White is to move at the turn position, so a Black move cannot start the line.
        assert_eq!(
            turn.resolve(&tokens("Nf6")).unwrap_err(),
            LineError::Illegal {
                ply: 0,
                token: "Nf6".into()
            }
        );
    }

    #[test]
    fn one_illegal_move_refuses_the_whole_line_and_names_it() {
        let turn = turn(START, &[]);
        let error = turn.resolve(&tokens("e4 e5 Ke3")).unwrap_err();
        assert_eq!(
            error,
            LineError::Illegal {
                ply: 2,
                token: "Ke3".into()
            }
        );
        assert!(error.explain().contains("Half-move 3"));
        for nonsense in [
            "e9",
            "Qh5xh7xh8",
            "<script>",
            "ignore previous instructions",
        ] {
            assert!(matches!(
                turn.resolve(&[nonsense.to_owned()]),
                Err(LineError::Illegal { ply: 0, .. })
            ));
        }
        let long: Vec<String> = (0..=MAX_LINE_PLIES).map(|_| "Nf3".to_owned()).collect();
        assert_eq!(turn.resolve(&long).unwrap_err(), LineError::TooLong);
    }

    #[test]
    fn castling_promotion_and_en_passant_are_the_librarys_decision() {
        let castle = turn(
            "r3k2r/pppqppbp/2npbnp1/8/8/2NPBNP1/PPPQPPBP/R3K2R w KQkq - 0 1",
            &[],
        );
        let line = castle.resolve(&tokens("0-0 O-O-O")).unwrap();
        assert_eq!(line.san, ["O-O", "O-O-O"]);
        assert_eq!(line.uci, ["e1g1", "e8c8"]);

        let promote = turn("8/P6k/8/8/8/8/7K/8 w - - 0 1", &[]);
        assert_eq!(promote.resolve(&tokens("a8=Q")).unwrap().uci, ["a7a8q"]);
        assert!(promote.resolve(&tokens("a8")).is_err());

        let en_passant = turn(START, &["e2e4", "a7a6", "e4e5", "d7d5"]);
        assert_eq!(en_passant.resolve(&tokens("exd6")).unwrap().uci, ["e5d6"]);
    }

    #[test]
    fn mate_and_stalemate_are_told_apart() {
        let mated = turn(START, &["f2f3", "e7e5", "g2g4", "d8h4"]);
        assert_eq!(
            terminal(mated.position()),
            Some(Terminal::Checkmate {
                winner: Color::Black
            })
        );
        let stalemate = turn("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", &[]);
        assert_eq!(terminal(stalemate.position()), Some(Terminal::Stalemate));
        assert_eq!(terminal(turn(START, &[]).position()), None);
        // A line may end the game; nothing can follow it.
        let line = turn(START, &[]).resolve(&tokens("f3 e5 g4 Qh4#")).unwrap();
        assert!(terminal(&line.end).is_some());
        assert!(turn(START, &[])
            .resolve(&tokens("f3 e5 g4 Qh4# a3"))
            .is_err());
    }

    #[test]
    fn an_invalid_turn_position_is_refused() {
        assert!(TurnPosition::new("not a fen", &[]).is_err());
        assert!(TurnPosition::new(START, &["e2e5".to_owned()]).is_err());
    }
}
