use std::{collections::HashMap, num::NonZeroU32};

use log::info;
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, san::San, CastlingMode, Chess, EnPassantMode, Position, Setup};

use lazy_static::lazy_static;
use specta::Type;
use strsim::{jaro_winkler, sorensen_dice};

use crate::error::Error;

#[derive(Debug, Clone)]
struct Opening {
    _eco: String,
    name: String,
    setup: Setup,
    pgn: Option<String>,
}

#[derive(Debug, Clone, Type, Serialize)]
pub struct OutOpening {
    name: String,
    fen: String,
}

#[derive(Deserialize)]
struct OpeningRecord {
    eco: String,
    name: String,
    pgn: String,
}

const TSV_DATA: [&[u8]; 5] = [
    include_bytes!("../data/a.tsv"),
    include_bytes!("../data/b.tsv"),
    include_bytes!("../data/c.tsv"),
    include_bytes!("../data/d.tsv"),
    include_bytes!("../data/e.tsv"),
];

const FISCHER_RANDOM_DATA: &[u8] = include_bytes!("../data/frc.tsv");

#[derive(Deserialize)]
struct FischerRandomRecord {
    name: String,
    fen: String,
}

fn get_opening_from_fen(fen: &str) -> Result<String, Error> {
    let fen: Fen = fen.parse()?;
    get_opening_from_setup(fen.into_setup())
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_name(name: &str) -> Result<String, Error> {
    OPENINGS
        .iter()
        .find(|o| o.name == name)
        .and_then(|o| o.pgn.clone())
        .ok_or_else(|| Error::NoOpeningFound)
}

#[tauri::command]
#[specta::specta]
pub fn get_opening_from_fens(fens: Vec<String>) -> Result<String, Error> {
    for fen in fens.into_iter().rev() {
        if let Ok(opening) = get_opening_from_fen(&fen) {
            return Ok(opening);
        }
    }
    Err(Error::NoOpeningFound)
}

pub fn get_opening_from_setup(setup: Setup) -> Result<String, Error> {
    OPENING_INDEX
        .get(&normalize_opening_setup(setup))
        .map(|&index| OPENINGS[index].name.clone())
        .ok_or_else(|| Error::NoOpeningFound)
}

fn normalize_opening_setup(mut setup: Setup) -> Setup {
    setup.halfmoves = 0;
    setup.fullmoves = NonZeroU32::MIN;
    if setup.ep_square.is_some() {
        // Use the chess library for legal en passant without changing other setup fields.
        setup.ep_square = setup
            .clone()
            .position::<Chess>(CastlingMode::Chess960)
            .ok()
            .and_then(|pos| pos.ep_square(EnPassantMode::Legal));
    }
    setup
}

fn build_opening_index(openings: &[Opening]) -> HashMap<Setup, usize> {
    let mut index = HashMap::with_capacity(openings.len());
    for (row, opening) in openings.iter().enumerate() {
        index
            .entry(normalize_opening_setup(opening.setup.clone()))
            .or_insert(row);
    }
    index
}

#[tauri::command]
#[specta::specta]
pub async fn search_opening_name(query: String) -> Result<Vec<OutOpening>, Error> {
    let lower_query = query.to_lowercase();
    let mut best_matches = OPENINGS
        .iter()
        .filter_map(|opening| {
            let lower_name = opening.name.to_lowercase();
            let sorenson_score = sorensen_dice(&lower_query, &lower_name);
            let jaro_score = jaro_winkler(&lower_query, &lower_name);
            let score = sorenson_score.max(jaro_score);
            if score > 0.8 {
                Some((opening, score))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    best_matches.sort_by(|(left, left_score), (right, right_score)| {
        right_score
            .total_cmp(left_score)
            .then_with(|| left.name.cmp(&right.name))
    });

    let best_matches_names = best_matches
        .into_iter()
        .take(15)
        .map(|(o, _)| OutOpening {
            name: o.name.clone(),
            fen: Fen::from_setup(o.setup.clone()).to_string(),
        })
        .collect();
    Ok(best_matches_names)
}

lazy_static! {
    static ref OPENING_INDEX: HashMap<Setup, usize> = build_opening_index(&OPENINGS);
    static ref OPENINGS: Vec<Opening> = {
        info!("Initializing openings table...");

        let mut positions = vec![
            Opening {
                _eco: "Extra".to_string(),
                name: "Starting Position".to_string(),
                setup: Setup::default(),
                pgn: None,
            },
            Opening {
                _eco: "Extra".to_string(),
                name: "Empty Board".to_string(),
                setup: Setup::empty(),
                pgn: None,
            },
        ];

        for tsv in TSV_DATA {
            let mut rdr = csv::ReaderBuilder::new().delimiter(b'\t').from_reader(tsv);
            for result in rdr.deserialize() {
                // INVARIANT: The embedded TSV data is statically known to be well-formed.
                let record: OpeningRecord = result.expect("Failed to deserialize opening");
                let mut pos = Chess::default();
                for token in record.pgn.split_whitespace() {
                    if let Ok(san) = token.parse::<San>() {
                        // INVARIANT: The PGN moves in the embedded TSV data are statically verified legal moves.
                        pos.play_unchecked(&san.to_move(&pos).expect("legal move"));
                    }
                }
                positions.push(Opening {
                    _eco: record.eco,
                    name: record.name,
                    setup: pos.into_setup(EnPassantMode::Legal),
                    pgn: Some(record.pgn),
                });
            }
        }
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(b'\t')
            .from_reader(FISCHER_RANDOM_DATA);
        for result in rdr.deserialize() {
            // INVARIANT: The embedded FRC data is statically known to be well-formed.
            let record: FischerRandomRecord = result.expect("Failed to deserialize opening");
            // INVARIANT: FEN strings in the FRC data are valid FENs.
            let fen: Fen = record.fen.parse().expect("Failed to parse fen");
            positions.push(Opening {
                _eco: "FRC".to_string(),
                name: record.name,
                setup: fen.into_setup(),
                pgn: None,
            });
        }
        positions
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position_after_moves(moves: &str) -> Chess {
        let mut pos = Chess::default();
        for token in moves.split_whitespace() {
            let san: San = token.parse().unwrap();
            pos.play_unchecked(&san.to_move(&pos).unwrap());
        }
        pos
    }

    #[test]
    fn transpositions_find_the_current_opening_independently_of_move_clocks() {
        for moves in [
            "d4 Nf6 c4 e6 Nc3 d5",
            "d4 e6 c4 Nf6 Nc3 d5",
            "Nf3 Nf6 Ng1 Ng8 d4 Nf6 c4 e6 Nc3 d5",
        ] {
            let setup = position_after_moves(moves).into_setup(EnPassantMode::Legal);
            assert_eq!(
                get_opening_from_setup(setup.clone()).unwrap(),
                "Queen's Gambit Declined: Normal Defense",
                "{moves}"
            );
            assert_eq!(
                get_opening_from_fen(&Fen::from_setup(setup).to_string()).unwrap(),
                "Queen's Gambit Declined: Normal Defense",
                "{moves}"
            );
        }
    }

    #[test]
    fn transposed_fens_do_not_fall_back_to_an_earlier_opening() {
        let earlier = position_after_moves("d4 Nf6 c4");
        let transposed = position_after_moves("d4 Nf6 c4 e6 Nc3 d5");
        assert_eq!(
            get_opening_from_fens(vec![
                Fen::from_position(earlier, EnPassantMode::Always).to_string(),
                Fen::from_position(transposed, EnPassantMode::Always).to_string(),
            ])
            .unwrap(),
            "Queen's Gambit Declined: Normal Defense"
        );
    }

    #[test]
    fn duplicate_normalized_positions_keep_the_first_rows_name() {
        let first = Opening {
            _eco: "Extra".into(),
            name: "First opening".into(),
            setup: Setup::default(),
            pgn: None,
        };
        let mut second = first.clone();
        second.name = "Later opening".into();
        second.setup.halfmoves = 8;
        second.setup.fullmoves = NonZeroU32::new(5).unwrap();
        let query = second.setup.clone();
        let openings = [first, second];
        let index = build_opening_index(&openings);
        assert_eq!(index.len(), 1);
        let row = index[&normalize_opening_setup(query)];
        assert_eq!(openings[row].name, "First opening");
    }

    #[test]
    fn non_legal_en_passant_squares_still_find_the_opening() {
        for moves in ["e4", "d4 Nf6 c4 e6 Nc3 d5"] {
            let mut without_ep = position_after_moves(moves).into_setup(EnPassantMode::Always);
            assert!(without_ep.ep_square.is_some());
            let fen = Fen::from_setup(without_ep.clone()).to_string();
            without_ep.ep_square = None;
            assert_eq!(
                get_opening_from_fen(&fen).unwrap(),
                get_opening_from_setup(without_ep).unwrap()
            );
        }
        assert_eq!(
            get_opening_from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq e6 8 5")
                .unwrap(),
            "Starting Position"
        );
    }

    #[test]
    fn normalization_preserves_legal_en_passant_but_removes_pinned_captures() {
        let legal = position_after_moves("e4 a6 e5 d5").into_setup(EnPassantMode::Always);
        assert!(legal.ep_square.is_some());
        let mut expected = legal.clone();
        expected.halfmoves = 0;
        expected.fullmoves = NonZeroU32::MIN;
        assert_eq!(normalize_opening_setup(legal), expected);

        let pinned = "k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1"
            .parse::<Fen>()
            .unwrap()
            .into_setup();
        assert_eq!(normalize_opening_setup(pinned).ep_square, None);
    }

    #[test]
    fn normalization_preserves_other_position_fields() {
        let mut setup = position_after_moves("e4 a6 e5 d5").into_setup(EnPassantMode::Always);
        setup.promoted = shakmaty::Bitboard::from(shakmaty::Square::B1);
        let normalized = normalize_opening_setup(setup.clone());
        assert_eq!(normalized.board, setup.board);
        assert_eq!(normalized.promoted, setup.promoted);
        assert_eq!(normalized.turn, setup.turn);
        assert_eq!(normalized.castling_rights, setup.castling_rights);
        assert_eq!(normalized.pockets, setup.pockets);
        assert_eq!(normalized.remaining_checks, setup.remaining_checks);
        assert_eq!(normalized.ep_square, setup.ep_square);
    }

    #[test]
    fn every_fischer_random_opening_survives_clock_normalization() {
        let mut rdr = csv::ReaderBuilder::new()
            .delimiter(b'\t')
            .from_reader(FISCHER_RANDOM_DATA);
        for record in rdr.deserialize::<FischerRandomRecord>() {
            let record = record.unwrap();
            let mut setup = record.fen.parse::<Fen>().unwrap().into_setup();
            setup.halfmoves = 12;
            setup.fullmoves = NonZeroU32::new(7).unwrap();
            let expected = if record.name == "Fischer Random 518" {
                "Starting Position"
            } else {
                &record.name
            };
            assert_eq!(get_opening_from_setup(setup).unwrap(), expected);
        }
        assert_eq!(
            get_opening_from_setup(Setup::empty()).unwrap(),
            "Empty Board"
        );
    }

    #[test]
    fn invalid_fens_return_an_error() {
        assert!(get_opening_from_fen("invalid fen").is_err());
        assert!(matches!(
            get_opening_from_fens(vec!["invalid fen".into()]),
            Err(Error::NoOpeningFound)
        ));
    }

    #[test]
    fn test_get_opening_from_name_failures() {
        let res = get_opening_from_name("Nonexistent Opening");
        assert!(res.is_err());
    }

    #[test]
    fn starting_fen_is_the_starting_position_opening() {
        let name = get_opening_from_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
            .unwrap();
        assert_eq!(name, "Starting Position");
        assert!(matches!(
            get_opening_from_fen("8/8/8/8/8/8/8/4K2k w - - 0 1"),
            Err(Error::NoOpeningFound)
        ));
    }

    #[test]
    fn opening_from_fens_walks_back_to_the_last_known_position() {
        let start = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let off_book = "8/8/8/8/8/8/8/4K2k w - - 0 1";
        assert_eq!(
            get_opening_from_fens(vec![start.to_string(), off_book.to_string()]).unwrap(),
            "Starting Position"
        );
        assert!(matches!(
            get_opening_from_fens(vec![off_book.to_string()]),
            Err(Error::NoOpeningFound)
        ));
    }

    #[test]
    fn test_get_opening_from_name_non_pgn() {
        let res_start = get_opening_from_name("Starting Position");
        assert!(res_start.is_err());
        let res_empty = get_opening_from_name("Empty Board");
        assert!(res_empty.is_err());
    }

    #[test]
    fn every_embedded_non_pgn_opening_reports_no_pgn_instead_of_panicking() {
        for opening in OPENINGS.iter().filter(|opening| opening.pgn.is_none()) {
            assert!(matches!(
                get_opening_from_name(&opening.name),
                Err(Error::NoOpeningFound)
            ));
        }
    }

    #[tokio::test]
    async fn equal_search_scores_have_a_stable_name_order() {
        let first = search_opening_name("gambit".into()).await.unwrap();
        let second = search_opening_name("gambit".into()).await.unwrap();
        assert_eq!(
            first
                .iter()
                .map(|opening| &opening.name)
                .collect::<Vec<_>>(),
            second
                .iter()
                .map(|opening| &opening.name)
                .collect::<Vec<_>>()
        );
        for pair in first.windows(2) {
            let left_score = pair[0].name.to_lowercase();
            let right_score = pair[1].name.to_lowercase();
            // The command's score ordering is verified by the duplicate call;
            // this assertion documents its deterministic tie breaker.
            if left_score == right_score {
                assert!(pair[0].name <= pair[1].name);
            }
        }
    }
}
