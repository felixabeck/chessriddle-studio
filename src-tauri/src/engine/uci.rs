use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, EnPassantMode, Position, Setup};

use crate::error::Error;

/// Non-engine positions (Play without an engine, opening-book EPD lines and PGN `FEN` headers)
/// follow the database policy.
pub fn parse_fen_to_position(fen: &str) -> Result<Chess, Error> {
    let fen: Fen = fen.parse()?;
    crate::db::database_setup_to_chess(fen.into_setup())
}

/// The engine and game-report policy for a start setup. Castling rights without a matching king
/// and rook (stale `KQkq` from older tools, which chessops and the database already ignore) are
/// dropped. Every engine `position` line is serialised from the returned position by
/// `canonicalize_engine_position`, so the engine never receives them.
/// Excess material stays refused for engines
/// (`engine_games_refuse_excess_material_at_creation_but_human_games_keep_it`).
/// The returned mode is detected from the surviving rights, so a stale right cannot select
/// Chess960 (and with it `UCI_Chess960`) for a standard position.
pub(crate) fn engine_setup_to_chess(setup: Setup) -> Result<(Chess, CastlingMode), Error> {
    let castling_mode = CastlingMode::detect(&setup);
    match setup.position(castling_mode) {
        Ok(position) => Ok((position, castling_mode)),
        Err(error) => {
            let setup = error
                .ignore_invalid_castling_rights()?
                .into_setup(EnPassantMode::Legal);
            let castling_mode = CastlingMode::detect(&setup);
            Ok((setup.position(castling_mode)?, castling_mode))
        }
    }
}

// Stockfish sf_19, stockfish/src/position.cpp:425-426: inclusive rule50 range 0..32767.
const MAX_UCI_HALFMOVES: u32 = 32767;
// Stockfish sf_19, stockfish/src/position.cpp:428-433: inclusive *input fullmove*
// range 0..100000, before conversion to max(2 * (fullmove - 1), 0) + black.
// shakmaty serialises fullmove 0 as 1, which has the same ply semantics.
const MAX_UCI_FULLMOVES: u32 = 100000;

// FEN orders board, turn, castling, en passant, then clocks; Three-check inserts checks before clocks.
const HALFMOVE_FIELD: usize = 4;
const THREE_CHECK_HALFMOVE_FIELD: usize = 5;

pub struct CanonicalEnginePosition {
    pub fen: String,
    pub moves: Vec<String>,
    pub castling_mode: CastlingMode,
    pub position: Chess,
}

impl CanonicalEnginePosition {
    pub fn command(&self) -> String {
        if self.moves.is_empty() {
            format!("position fen {}", self.fen)
        } else {
            format!("position fen {} moves {}", self.fen, self.moves.join(" "))
        }
    }
}

/// Wire-only serialisation: callers retain the request FEN for options and payload identity.
pub fn canonicalize_engine_position(
    fen: &str,
    moves: &[String],
) -> Result<CanonicalEnginePosition, Error> {
    canonicalize_engine_position_inner(fen, moves)
        .map_err(|error| Error::EnginePositionRejected(Box::new(error)))
}

fn canonicalize_engine_position_inner(
    fen: &str,
    moves: &[String],
) -> Result<CanonicalEnginePosition, Error> {
    super::validate_uci_text("FEN", fen)?;
    // Match shakmaty's accepted separators. Normalize negative decimal counters
    // before parsing because its unsigned parser rejects them. Variant check counters
    // can precede the move clocks; leave that field to the FEN parser.
    let mut fields: Vec<String> = fen
        .split([' ', '_'])
        .filter(|field| !field.is_empty())
        .map(str::to_owned)
        .collect();
    let clocks = if fields
        .get(HALFMOVE_FIELD)
        .is_some_and(|field| field.contains('+'))
    {
        THREE_CHECK_HALFMOVE_FIELD
    } else {
        HALFMOVE_FIELD
    };
    for index in [clocks, clocks + 1] {
        if let Some(field) = fields.get_mut(index) {
            if let Some(digits) = field.strip_prefix('-') {
                if !digits.is_empty() && digits.bytes().all(|digit| digit.is_ascii_digit()) {
                    *field = "0".into();
                }
            }
        }
    }
    let fen: Fen = fields.join(" ").parse()?;
    let (mut pos, castling_mode) = engine_setup_to_chess(fen.into_setup())?;
    // Clamp only the wire setup. In particular, game state retains positive
    // request clocks rather than adopting the engine's bounded counters.
    let mut wire_setup = pos.clone().into_setup(EnPassantMode::Legal);
    wire_setup.halfmoves = wire_setup.halfmoves.min(MAX_UCI_HALFMOVES);
    wire_setup.fullmoves =
        std::num::NonZeroU32::new(wire_setup.fullmoves.get().min(MAX_UCI_FULLMOVES))
            .unwrap_or(std::num::NonZeroU32::MIN);
    let canonical_fen = Fen::from_setup(wire_setup).to_string();

    let mut normalized_moves = Vec::with_capacity(moves.len());

    for m in moves {
        let uci = UciMove::from_ascii(m.as_bytes())?;
        let mv = uci.to_move(&pos)?;
        normalized_moves.push(UciMove::from_move(&mv, castling_mode).to_string());
        pos.play_unchecked(&mv);
    }

    Ok(CanonicalEnginePosition {
        fen: canonical_fen,
        moves: normalized_moves,
        castling_mode,
        position: pos,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const START: &str = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
    const BOARD: &str = "4k3/8/8/8/8/8/8/4K3";
    const STANDARD_CASTLING: &str = "r3k2r/8/8/8/8/8/8/R3K2R w HAha - 0 1";
    const CHESS960: &str = "1r1k3r/8/8/8/8/8/8/1R1K3R w HBhb - 0 1";

    struct Fixture {
        name: &'static str,
        fen: String,
        moves: Vec<String>,
        expected: Option<&'static str>,
    }

    // Every canonicaliser fixture belongs here, including rejections. The ignored
    // corpus exporter runs these exact inputs through the production canonicaliser.
    fn fixtures() -> Vec<Fixture> {
        let fixture = |name, fen: String, moves: &[&str], expected| Fixture {
            name,
            fen,
            moves: moves.iter().map(|mv| (*mv).to_owned()).collect(),
            expected,
        };
        vec![
            fixture("start: 32 total pieces", START.into(), &[], Some(START)),
            fixture(
                "board only",
                BOARD.into(),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "board and side",
                format!("{BOARD} b"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 b - - 0 1"),
            ),
            fixture(
                "underscore separators",
                START.replace(' ', "_"),
                &[],
                Some(START),
            ),
            fixture(
                "negative halfmove and zero fullmove",
                format!("{BOARD} w - - -1 0"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "150 halfmoves and excess fullmove",
                format!("{BOARD} b - - 150 200000"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 b - - 150 100000"),
            ),
            fixture(
                "excess halfmove and negative fullmove",
                format!("{BOARD} w - - 32768 -1"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 32767 1"),
            ),
            fixture(
                "inclusive maxima",
                format!("{BOARD} b - - 32767 100000"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 b - - 32767 100000"),
            ),
            fixture(
                "Shredder standard",
                STANDARD_CASTLING.into(),
                &["e1g1", "e8c8"],
                Some("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"),
            ),
            fixture(
                "Chess960 Shredder",
                CHESS960.into(),
                &["d1h1", "d8b8"],
                Some("1r1k3r/8/8/8/8/8/8/1R1K3R w KQkq - 0 1"),
            ),
            fixture(
                "Chess960 inner rook retains file letter",
                "rr1k3r/8/8/8/8/8/8/1R1K3R w HBhb - 0 1".into(),
                &[],
                Some("rr1k3r/8/8/8/8/8/8/1R1K3R w KQkb - 0 1"),
            ),
            fixture(
                "no en passant capturer",
                "4k3/8/8/8/4P3/8/8/4K3 b - e3 0 1".into(),
                &[],
                Some("4k3/8/8/8/4P3/8/8/4K3 b - - 0 1"),
            ),
            fixture(
                "castling without rooks",
                format!("{BOARD} w KQkq - 0 1"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "stale castling beside a valid right",
                "4k3/8/8/8/8/8/8/4K2R w Kk - 0 1".into(),
                &["e1d2"],
                Some("4k3/8/8/8/8/8/8/4K2R w K - 0 1"),
            ),
            fixture(
                "stale Shredder right beside a standard right",
                "4k3/8/8/8/8/8/8/4K2R w HB - 0 1".into(),
                &["e1g1"],
                Some("4k3/8/8/8/8/8/8/4K2R w K - 0 1"),
            ),
            fixture(
                "Crazyhouse bracket pockets",
                format!("{BOARD}[q] w - - 0 1"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "Crazyhouse slash pockets",
                format!("{BOARD}/q w - - 0 1"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "Three-check before clocks",
                format!("{BOARD} w - - 1+2 0 1"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "Three-check suffix",
                format!("{BOARD} w - - 0 1 +0+0"),
                &[],
                Some("4k3/8/8/8/8/8/8/4K3 w - - 0 1"),
            ),
            fixture(
                "ten knights legal material",
                "4k3/8/8/8/8/NNNNNNNN/NN6/4K3 w - - 0 1".into(),
                &[],
                Some("4k3/8/8/8/8/NNNNNNNN/NN6/4K3 w - - 0 1"),
            ),
            fixture(
                "nine white pawns",
                "4k3/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "eight pawns and third knight",
                "4k3/8/8/8/8/8/PPPPPPPP/NNN1K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "more than sixteen white pieces",
                "4k3/8/8/8/8/N7/PPPPPPPP/RNBQKBNR w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "eight pawns and three queens",
                "4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "missing king",
                "8/8/8/8/8/8/8/4K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "extra king",
                "4k3/8/8/8/8/8/8/3KK3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "opposite king in check",
                "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "backrank pawn",
                "4k3/8/8/8/8/8/8/P3K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "bad piece",
                "4k3/8/8/8/8/8/8/X3K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture(
                "rank overflow",
                "4k4/8/8/8/8/8/8/4K3 w - - 0 1".into(),
                &[],
                None,
            ),
            fixture("bad side", format!("{BOARD} x - - 0 1"), &[], None),
            fixture("bad castling", format!("{BOARD} w Z - 0 1"), &[], None),
            fixture("bad ep rank", format!("{BOARD} w - e3 0 1"), &[], None),
            fixture(
                "malformed clock",
                format!("{BOARD} w - - nope 1"),
                &[],
                None,
            ),
            fixture("illegal move", START.into(), &["e2e5"], None),
            fixture("malformed move", START.into(), &["nope"], None),
            fixture(
                "legal opening",
                START.into(),
                &["e2e4", "e7e5"],
                Some(START),
            ),
        ]
    }

    #[test]
    fn canonicalizes_all_strict_engine_rejection_classes() {
        for fixture in fixtures() {
            let result = canonicalize_engine_position(&fixture.fen, &fixture.moves);
            match fixture.expected {
                Some(expected) => assert_eq!(result.unwrap().fen, expected, "{}", fixture.name),
                None => assert!(
                    matches!(result, Err(Error::EnginePositionRejected(_))),
                    "{}",
                    fixture.name
                ),
            }
        }
    }

    fn assert_fixture(name: &str) {
        let fixture = fixtures()
            .into_iter()
            .find(|fixture| fixture.name == name)
            .unwrap();
        let result = canonicalize_engine_position(&fixture.fen, &fixture.moves);
        match fixture.expected {
            Some(expected) => assert_eq!(result.unwrap().fen, expected),
            None => assert!(matches!(result, Err(Error::EnginePositionRejected(_)))),
        }
    }

    #[test]
    fn drops_stale_castling_rights_and_redetects_the_mode() {
        assert_fixture("castling without rooks");
        assert_fixture("stale castling beside a valid right");
        let canonical =
            canonicalize_engine_position("4k3/8/8/8/8/8/8/4K2R w HB - 0 1", &["e1g1".into()])
                .unwrap();
        assert_eq!(canonical.castling_mode, CastlingMode::Standard);
        assert_eq!(canonical.moves, ["e1g1"]);
        // Excess material stays refused for engines; only castling is tolerated.
        assert!(matches!(
            canonicalize_engine_position("4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w KQ - 0 1", &[]),
            Err(Error::EnginePositionRejected(_))
        ));
        // Play without an engine follows the database policy for both classes.
        assert!(parse_fen_to_position("4k3/8/8/8/8/8/PPPPPPPP/QQQ1K3 w KQ - 0 1").is_ok());
    }

    #[test]
    fn expands_board_only_fen() {
        assert_fixture("board only");
    }
    #[test]
    fn normalizes_underscore_separators() {
        assert_fixture("underscore separators");
    }
    #[test]
    fn clamps_out_of_range_counters() {
        assert_fixture("negative halfmove and zero fullmove");
        assert_fixture("150 halfmoves and excess fullmove");
        assert_fixture("excess halfmove and negative fullmove");
        assert_fixture("inclusive maxima");
    }
    #[test]
    fn normalizes_shredder_castling_in_standard_mode() {
        assert_fixture("Shredder standard");
    }
    #[test]
    fn removes_en_passant_without_a_capturer() {
        assert_fixture("no en passant capturer");
    }
    #[test]
    fn rejects_nine_pawns_for_one_side() {
        assert_fixture("nine white pawns");
    }
    #[test]
    fn rejects_promoted_piece_surplus_for_one_side() {
        assert_fixture("eight pawns and third knight");
    }
    #[test]
    fn rejects_more_than_sixteen_pieces_for_one_side() {
        assert_fixture("more than sixteen white pieces");
    }

    #[test]
    fn measures_shakmaty_nonstandard_fen_inputs() {
        for fixture in fixtures().into_iter().filter(|fixture| {
            matches!(
                fixture.name,
                "board only"
                    | "board and side"
                    | "underscore separators"
                    | "Crazyhouse bracket pockets"
                    | "Crazyhouse slash pockets"
                    | "Three-check before clocks"
                    | "Three-check suffix"
            )
        }) {
            let fen: Fen = fixture.fen.parse().unwrap();
            let setup = fen.as_setup();
            if fixture.name.starts_with("Crazyhouse") {
                assert!(setup.pockets.is_some());
            }
            if fixture.name.starts_with("Three-check") {
                assert!(setup.remaining_checks.is_some());
            }
            let pos: Chess = setup.clone().position(CastlingMode::detect(setup)).unwrap();
            assert!(pos.pockets().is_none());
            assert!(pos.remaining_checks().is_none());
            assert_eq!(
                Fen::from_position(pos, EnPassantMode::Legal).to_string(),
                fixture.expected.unwrap()
            );
        }
    }

    #[test]
    fn castling_mode_round_trips_with_normalized_moves() {
        for fixture in fixtures()
            .into_iter()
            .filter(|fixture| matches!(fixture.name, "Shredder standard" | "Chess960 Shredder"))
        {
            let canonical = canonicalize_engine_position(&fixture.fen, &fixture.moves).unwrap();
            let setup = canonical.fen.parse::<Fen>().unwrap().into_setup();
            assert_eq!(CastlingMode::detect(&setup), canonical.castling_mode);
            assert_eq!(
                canonical.castling_mode.is_chess960(),
                fixture.name == "Chess960 Shredder"
            );
            assert_eq!(canonical.moves, fixture.moves);
            let mut replayed: Chess = canonical
                .fen
                .parse::<Fen>()
                .unwrap()
                .into_position(canonical.castling_mode)
                .unwrap();
            for mv in &canonical.moves {
                let mv = mv.parse::<UciMove>().unwrap().to_move(&replayed).unwrap();
                replayed.play_unchecked(&mv);
            }
            assert_eq!(
                Fen::from_position(replayed, EnPassantMode::Legal),
                Fen::from_position(canonical.position, EnPassantMode::Legal)
            );
        }
    }

    #[test]
    #[ignore]
    fn dump_sf19_canonical_corpus() -> Result<(), Box<dyn std::error::Error>> {
        let path = std::env::var("SF19_CORPUS_OUT")?;
        let mut corpus = String::new();
        for fixture in fixtures() {
            if let Ok(canonical) = canonicalize_engine_position(&fixture.fen, &fixture.moves) {
                corpus.push_str(&format!(
                    "setoption name UCI_Chess960 value {}\n",
                    canonical.castling_mode.is_chess960()
                ));
                corpus.push_str(&canonical.command());
                corpus.push('\n');
            }
        }
        std::fs::write(path, corpus)?;
        Ok(())
    }
}
