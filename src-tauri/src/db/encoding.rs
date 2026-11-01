use crate::error::Error;
use shakmaty::{
    fen::Fen, san::SanPlus, CastlingMode, Chess, FromSetup, Move, Position, PositionError, Setup,
};
use std::io::{self, ErrorKind};
use tokio_util::sync::CancellationToken;

pub const VARIATION_START_MARKER: u8 = 255;
pub const VARIATION_END_MARKER: u8 = 254;
pub const COMMENT_MARKER: u8 = 253;
pub const NAG_MARKER: u8 = 252;
const ANNOTATION_CHECKPOINT_BYTES: usize = 4 * 1024;

/// Reconstructs database setups with the same policy used when importing PGN headers.
pub(crate) fn database_setup_to_chess(setup: Setup) -> Result<Chess, Error> {
    let castling_mode = CastlingMode::detect(&setup);
    Chess::from_setup(setup, castling_mode)
        .or_else(PositionError::ignore_too_much_material)
        .or_else(PositionError::ignore_invalid_castling_rights)
        .map_err(Error::from)
}

#[cfg(test)]
thread_local! {
    static DECODE_CANCELLATION_HOOK: std::cell::RefCell<Option<Box<dyn FnMut() -> bool>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(crate) fn cancel_decode_after_checkpoints(cancellation: CancellationToken, checkpoints: usize) {
    let mut seen = 0usize;
    DECODE_CANCELLATION_HOOK.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            seen += 1;
            if seen >= checkpoints {
                cancellation.cancel();
                true
            } else {
                false
            }
        }));
    });
}

#[cfg(test)]
fn test_cancellation_checkpoint() {
    DECODE_CANCELLATION_HOOK.with(|hook| {
        let current = hook.borrow_mut().take();
        if let Some(mut current) = current {
            if !current() {
                *hook.borrow_mut() = Some(current);
            }
        }
    });
}

pub fn encode_move(m: &Move, chess: &Chess) -> Result<u8, Error> {
    let moves = chess.legal_moves();
    let index = moves
        .iter()
        .position(|candidate| candidate == m)
        .ok_or_else(|| invalid_data("Move is not legal in the given position"))?;
    let encoded =
        u8::try_from(index).map_err(|_| invalid_data("Legal move index overflowed u8"))?;
    if encoded >= NAG_MARKER {
        return Err(invalid_data(
            "Legal move index collides with an encoding marker",
        ));
    }
    Ok(encoded)
}

pub fn decode_move(byte: u8, chess: &Chess) -> Option<Move> {
    let legal_moves = chess.legal_moves();
    legal_moves.get(byte as usize).cloned()
}

pub fn encode_comment(comment: &str, output: &mut Vec<u8>) {
    for chunk in comment.as_bytes().chunks(u16::MAX as usize) {
        output.push(COMMENT_MARKER);
        output.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        output.extend_from_slice(chunk);
    }
    // A full chunk continues into the next comment chunk. Terminate exact
    // multiples explicitly, and retain genuine empty comments as their own chunk.
    if comment.len().is_multiple_of(u16::MAX as usize) {
        output.extend_from_slice(&[COMMENT_MARKER, 0, 0]);
    }
}

pub fn encode_nag(nag: &str, output: &mut Vec<u8>) {
    for chunk in nag.as_bytes().chunks(u16::MAX as usize) {
        output.push(NAG_MARKER);
        output.extend_from_slice(&(chunk.len() as u16).to_le_bytes());
        output.extend_from_slice(chunk);
    }
}

pub struct MainlineMoveBytesIter<'a> {
    bytes: &'a [u8],
    cursor: usize,
    variation_depth: usize,
}

impl<'a> MainlineMoveBytesIter<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            cursor: 0,
            variation_depth: 0,
        }
    }

    fn skip_annotation(&mut self) -> Option<()> {
        let length_end = self.cursor.checked_add(2)?;
        let length_bytes = self.bytes.get(self.cursor..length_end)?;
        let length = u16::from_le_bytes([length_bytes[0], length_bytes[1]]) as usize;
        self.cursor = length_end.saturating_add(length).min(self.bytes.len());
        Some(())
    }
}

impl Iterator for MainlineMoveBytesIter<'_> {
    type Item = u8;

    fn next(&mut self) -> Option<Self::Item> {
        while self.cursor < self.bytes.len() {
            let byte = self.bytes[self.cursor];
            self.cursor += 1;

            match byte {
                VARIATION_START_MARKER => {
                    self.variation_depth = self.variation_depth.saturating_add(1);
                }
                VARIATION_END_MARKER => {
                    self.variation_depth = self.variation_depth.saturating_sub(1);
                }
                COMMENT_MARKER | NAG_MARKER => self.skip_annotation()?,
                _ if self.variation_depth == 0 => return Some(byte),
                _ => {}
            }
        }

        None
    }
}

pub fn iter_mainline_move_bytes(bytes: &[u8]) -> MainlineMoveBytesIter<'_> {
    MainlineMoveBytesIter::new(bytes)
}

/// Validates every structural marker before returning the mainline iterator.
/// Callers that process database-owned move streams must use this boundary so
/// truncated comments/NAGs and unbalanced variations cannot be treated as a
/// valid shorter game.
fn validate_mainline_move_bytes(
    bytes: &[u8],
    cancellation: Option<&tokio_util::sync::CancellationToken>,
    checkpoint: &mut dyn FnMut(usize),
) -> Result<(), Error> {
    let mut cursor = 0usize;
    let mut variation_depth = 0usize;
    while cursor < bytes.len() {
        #[cfg(test)]
        test_cancellation_checkpoint();
        if cancellation.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
            return Err(Error::Cancellation);
        }
        checkpoint(cursor);
        let marker = bytes[cursor];
        cursor += 1;
        match marker {
            VARIATION_START_MARKER => {
                variation_depth = variation_depth
                    .checked_add(1)
                    .ok_or_else(|| invalid_data("variation nesting overflow"))?;
            }
            VARIATION_END_MARKER => {
                variation_depth = variation_depth
                    .checked_sub(1)
                    .ok_or_else(|| invalid_data("variation ended without a matching start"))?;
            }
            COMMENT_MARKER | NAG_MARKER => {
                let length_end = cursor
                    .checked_add(2)
                    .ok_or_else(|| invalid_data("annotation length overflow"))?;
                let length_bytes = bytes
                    .get(cursor..length_end)
                    .ok_or_else(|| invalid_data("truncated comment or NAG length"))?;
                let length = u16::from_le_bytes([length_bytes[0], length_bytes[1]]) as usize;
                let payload_start = cursor
                    .checked_add(2)
                    .ok_or_else(|| invalid_data("annotation payload offset overflow"))?;
                let payload_end = cursor
                    .checked_add(2)
                    .and_then(|start| start.checked_add(length))
                    .filter(|end| *end <= bytes.len())
                    .ok_or_else(|| invalid_data("truncated comment or NAG payload"))?;
                let mut payload_cursor = payload_start;
                while payload_cursor < payload_end {
                    #[cfg(test)]
                    test_cancellation_checkpoint();
                    if cancellation.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
                        return Err(Error::Cancellation);
                    }
                    checkpoint(payload_cursor);
                    payload_cursor = payload_cursor
                        .saturating_add(ANNOTATION_CHECKPOINT_BYTES)
                        .min(payload_end);
                }
                cursor = payload_end;
            }
            _ => {}
        }
    }
    if variation_depth != 0 {
        return Err(invalid_data("unclosed variation"));
    }
    if cancellation.is_some_and(tokio_util::sync::CancellationToken::is_cancelled) {
        return Err(Error::Cancellation);
    }
    Ok(())
}

pub fn try_iter_mainline_move_bytes(bytes: &[u8]) -> Result<MainlineMoveBytesIter<'_>, Error> {
    validate_mainline_move_bytes(bytes, None, &mut |_| {})?;
    Ok(MainlineMoveBytesIter::new(bytes))
}

pub fn try_iter_mainline_move_bytes_cancellable<'a>(
    bytes: &'a [u8],
    cancellation: &tokio_util::sync::CancellationToken,
) -> Result<MainlineMoveBytesIter<'a>, Error> {
    validate_mainline_move_bytes(bytes, Some(cancellation), &mut |_| {})?;
    Ok(MainlineMoveBytesIter::new(bytes))
}

#[cfg(test)]
fn try_iter_mainline_move_bytes_with_checkpoint<'a>(
    bytes: &'a [u8],
    cancellation: &tokio_util::sync::CancellationToken,
    mut checkpoint: impl FnMut(usize),
) -> Result<MainlineMoveBytesIter<'a>, Error> {
    validate_mainline_move_bytes(bytes, Some(cancellation), &mut checkpoint)?;
    Ok(MainlineMoveBytesIter::new(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodedGameNode {
    Move(String),
    Nag(String),
    Comment(String),
    Variation(Vec<DecodedGameNode>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedGame {
    pub nodes: Vec<DecodedGameNode>,
}

struct DecodeFrame {
    nodes: Vec<DecodedGameNode>,
    chess: Chess,
    pre_move_positions: Vec<Chess>,
}

fn invalid_data(message: &str) -> Error {
    Error::from(io::Error::new(ErrorKind::InvalidData, message.to_string()))
}

#[cfg(test)]
fn decode_game(moves_bytes: &[u8], initial_fen: Fen) -> Result<DecodedGame, Error> {
    let mut checkpoint = || {};
    decode_game_cancellable_with_checkpoint(
        moves_bytes,
        initial_fen,
        &CancellationToken::new(),
        &mut checkpoint,
    )
}

fn decode_game_cancellable_with_checkpoint(
    moves_bytes: &[u8],
    initial_fen: Fen,
    cancellation: &CancellationToken,
    checkpoint: &mut dyn FnMut(),
) -> Result<DecodedGame, Error> {
    cancellation_check(cancellation, checkpoint)?;
    let root_position = database_setup_to_chess(initial_fen.into_setup())
        .map_err(|error| invalid_data(&format!("Invalid initial FEN setup: {error}")))?;

    let mut stack = vec![DecodeFrame {
        nodes: Vec::new(),
        chess: root_position,
        pre_move_positions: Vec::new(),
    }];

    let mut cursor = 0usize;
    while cursor < moves_bytes.len() {
        cancellation_check(cancellation, checkpoint)?;
        let byte = moves_bytes[cursor];
        cursor += 1;

        match byte {
            VARIATION_START_MARKER => {
                let parent_position = stack
                    .last()
                    .map(|frame| {
                        frame
                            .pre_move_positions
                            .last()
                            .cloned()
                            .unwrap_or_else(|| frame.chess.clone())
                    })
                    .ok_or_else(|| invalid_data("Missing parent frame while opening variation"))?;
                stack.push(DecodeFrame {
                    nodes: Vec::new(),
                    chess: parent_position,
                    pre_move_positions: Vec::new(),
                });
            }
            VARIATION_END_MARKER => {
                if stack.len() == 1 {
                    return Err(invalid_data("Unbalanced variation end marker"));
                }
                let frame = stack.pop().ok_or_else(|| {
                    invalid_data("Missing variation frame while closing variation")
                })?;
                if let Some(parent) = stack.last_mut() {
                    parent.nodes.push(DecodedGameNode::Variation(frame.nodes));
                }
            }
            COMMENT_MARKER => {
                let mut payload = Vec::new();
                loop {
                    if cursor + 2 > moves_bytes.len() {
                        return Err(invalid_data("Truncated comment length marker"));
                    }
                    let len =
                        u16::from_le_bytes([moves_bytes[cursor], moves_bytes[cursor + 1]]) as usize;
                    cursor += 2;
                    if cursor + len > moves_bytes.len() {
                        return Err(invalid_data("Truncated comment payload"));
                    }
                    // The combined payload is bounded by the in-memory moves blob:
                    // every chunk copies only bytes from moves_bytes.
                    // Check around each chunk allocation, before UTF-8 decoding, and
                    // again before the combined comment is rendered.
                    cancellation_check(cancellation, checkpoint)?;
                    payload.extend_from_slice(&moves_bytes[cursor..cursor + len]);
                    cursor += len;
                    cancellation_check(cancellation, checkpoint)?;
                    if len != u16::MAX as usize || moves_bytes.get(cursor) != Some(&COMMENT_MARKER)
                    {
                        break;
                    }
                    cursor += 1;
                }
                cancellation_check(cancellation, checkpoint)?;
                let comment = String::from_utf8_lossy(&payload).to_string();
                cancellation_check(cancellation, checkpoint)?;
                if let Some(frame) = stack.last_mut() {
                    frame.nodes.push(DecodedGameNode::Comment(comment));
                }
            }
            NAG_MARKER => {
                if cursor + 2 > moves_bytes.len() {
                    return Err(invalid_data("Truncated NAG length marker"));
                }
                let len =
                    u16::from_le_bytes([moves_bytes[cursor], moves_bytes[cursor + 1]]) as usize;
                cursor += 2;
                if cursor + len > moves_bytes.len() {
                    return Err(invalid_data("Truncated NAG payload"));
                }
                let payload = &moves_bytes[cursor..cursor + len];
                cursor += len;

                cancellation_check(cancellation, checkpoint)?;
                let nag = String::from_utf8_lossy(payload).to_string();
                cancellation_check(cancellation, checkpoint)?;
                if let Some(frame) = stack.last_mut() {
                    frame.nodes.push(DecodedGameNode::Nag(nag));
                }
            }
            move_idx => {
                let frame = stack
                    .last_mut()
                    .ok_or_else(|| invalid_data("Missing frame while decoding move"))?;
                let pre_move_position = frame.chess.clone();
                let m = decode_move(move_idx, &frame.chess)
                    .ok_or_else(|| invalid_data("Invalid move index for current position"))?;
                let san = SanPlus::from_move_and_play_unchecked(&mut frame.chess, &m).to_string();
                frame.pre_move_positions.push(pre_move_position);
                frame.nodes.push(DecodedGameNode::Move(san));
            }
        }
    }

    if stack.len() != 1 {
        return Err(invalid_data("Unclosed variation markers in encoded game"));
    }

    let root = stack
        .pop()
        .ok_or_else(|| invalid_data("Missing root decode frame at end of parsing"))?;
    cancellation_check(cancellation, checkpoint)?;
    Ok(DecodedGame { nodes: root.nodes })
}

fn cancellation_check(
    cancellation: &CancellationToken,
    checkpoint: &mut dyn FnMut(),
) -> Result<(), Error> {
    checkpoint();
    #[cfg(test)]
    test_cancellation_checkpoint();
    if cancellation.is_cancelled() {
        Err(Error::Cancellation)
    } else {
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct RenderState {
    move_number: u32,
    white_to_move: bool,
}

fn parse_initial_render_state(initial_fen: &Fen) -> RenderState {
    let fen_string = initial_fen.to_string();
    let mut fields = fen_string.split_whitespace();

    let _board = fields.next();
    let side_to_move = fields.next().unwrap_or("w");
    let move_number = fields
        .nth(3)
        .and_then(|field| field.parse::<u32>().ok())
        .unwrap_or(1);

    RenderState {
        move_number,
        white_to_move: side_to_move == "w",
    }
}

fn render_nodes_cancellable(
    nodes: &[DecodedGameNode],
    state: &mut RenderState,
    cancellation: &CancellationToken,
    checkpoint: &mut dyn FnMut(),
) -> Result<String, Error> {
    let mut out = String::new();
    let mut prev_was_move = false;
    let mut last_pre_move_state = None;
    let mut has_emitted_move = false;
    let mut force_black_prefix = false;
    for node in nodes {
        cancellation_check(cancellation, checkpoint)?;
        match node {
            DecodedGameNode::Move(san) => {
                if !out.is_empty() {
                    out.push(' ');
                }

                let pre_move_state = *state;

                if state.white_to_move {
                    out.push_str(&state.move_number.to_string());
                    out.push_str(". ");
                    out.push_str(san);
                    state.white_to_move = false;
                } else {
                    if !has_emitted_move || force_black_prefix {
                        out.push_str(&state.move_number.to_string());
                        out.push_str("... ");
                    }
                    out.push_str(san);
                    state.white_to_move = true;
                    state.move_number = state.move_number.saturating_add(1);
                }

                last_pre_move_state = Some(pre_move_state);
                has_emitted_move = true;
                force_black_prefix = false;
                prev_was_move = true;
            }
            DecodedGameNode::Nag(nag) => {
                let rendered_nag = match nag.as_str() {
                    "$1" => "!",
                    "$2" => "?",
                    "$3" => "!!",
                    "$4" => "??",
                    "$5" => "!?",
                    "$6" => "?!",
                    _ => nag,
                };

                if rendered_nag.starts_with('$') {
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(rendered_nag);
                } else if prev_was_move {
                    out.push_str(rendered_nag);
                } else {
                    if !out.is_empty() {
                        out.push(' ');
                    }
                    out.push_str(rendered_nag);
                }
                prev_was_move = false;
            }
            DecodedGameNode::Comment(comment) => {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push('{');
                cancellation_check(cancellation, checkpoint)?;
                out.push_str(comment);
                cancellation_check(cancellation, checkpoint)?;
                out.push('}');
                prev_was_move = false;
            }
            DecodedGameNode::Variation(children) => {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push('(');
                let mut variation_state = last_pre_move_state.unwrap_or(*state);
                out.push_str(&render_nodes_cancellable(
                    children,
                    &mut variation_state,
                    cancellation,
                    checkpoint,
                )?);
                out.push(')');
                force_black_prefix = true;
                prev_was_move = false;
            }
        }
    }
    cancellation_check(cancellation, checkpoint)?;
    Ok(out)
}

#[cfg(test)]
fn render_nodes(nodes: &[DecodedGameNode], state: &mut RenderState) -> String {
    render_nodes_cancellable(nodes, state, &CancellationToken::new(), &mut || {})
        .expect("a fresh test cancellation token cannot cancel rendering")
}

pub fn decode_game_to_movetext(moves_bytes: &[u8], initial_fen: Fen) -> Result<String, Error> {
    decode_game_to_movetext_cancellable(moves_bytes, initial_fen, &CancellationToken::new())
}

pub fn decode_game_to_movetext_cancellable(
    moves_bytes: &[u8],
    initial_fen: Fen,
    cancellation: &CancellationToken,
) -> Result<String, Error> {
    let mut checkpoint = || {};
    decode_game_to_movetext_cancellable_with_checkpoint(
        moves_bytes,
        initial_fen,
        cancellation,
        &mut checkpoint,
    )
}

fn decode_game_to_movetext_cancellable_with_checkpoint(
    moves_bytes: &[u8],
    initial_fen: Fen,
    cancellation: &CancellationToken,
    checkpoint: &mut dyn FnMut(),
) -> Result<String, Error> {
    let render_state = parse_initial_render_state(&initial_fen);
    let decoded = decode_game_cancellable_with_checkpoint(
        moves_bytes,
        initial_fen,
        cancellation,
        checkpoint,
    )?;
    let mut state = render_state;
    render_nodes_cancellable(&decoded.nodes, &mut state, cancellation, checkpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    use shakmaty::{Role, Square};

    #[cfg(target_os = "linux")]
    const SUPPRESS_MUTATION_CORE_ENV: &str = "CHESSFABLE_ENCODING_MUTATION_SUPPRESS_CORE";
    #[cfg(target_os = "linux")]
    const CORE_SUPPRESSION_PROBE_ENV: &str = "CHESSFABLE_ENCODING_CORE_SUPPRESSION_PROBE";

    fn prepare_mutation_test() {
        #[cfg(target_os = "linux")]
        if std::env::var(SUPPRESS_MUTATION_CORE_ENV).as_deref() == Ok("1") {
            // The mutation runner sets this only for Linux encoding tests. This call
            // runs inside the test executable, after Cargo's runner has exec'd it.
            let result = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) };
            if result != 0 {
                panic!(
                    "failed to disable core dumps for encoding mutation test: {}",
                    std::io::Error::last_os_error()
                );
            }
            assert_eq!(current_dumpability(), 0);
        }
    }

    #[cfg(target_os = "linux")]
    fn current_dumpability() -> libc::c_int {
        let result = unsafe { libc::prctl(libc::PR_GET_DUMPABLE) };
        if result < 0 {
            panic!(
                "failed to read encoding-test dumpability: {}",
                std::io::Error::last_os_error()
            );
        }
        result
    }

    fn assert_mainline_move_bytes(bytes: &[u8], expected: &[u8]) {
        let mut actual = iter_mainline_move_bytes(bytes);
        for expected_byte in expected {
            assert_eq!(actual.next(), Some(*expected_byte));
        }
        assert_eq!(actual.next(), None);
    }

    #[test]
    fn test_encoding() {
        prepare_mutation_test();
        let mut chess = Chess::default();
        let m = Move::Normal {
            role: Role::Pawn,
            from: Square::E2,
            to: Square::E4,
            capture: None,
            promotion: None,
        };

        let byte = encode_move(&m, &chess).unwrap();
        let m2 = decode_move(byte, &chess).unwrap();
        assert_eq!(m, m2);

        chess.play_unchecked(&m);

        let m = Move::Normal {
            role: Role::Pawn,
            from: Square::E7,
            to: Square::E5,
            capture: None,
            promotion: None,
        };
        let byte = encode_move(&m, &chess).unwrap();
        let m2 = decode_move(byte, &chess).unwrap();
        assert_eq!(m, m2);
    }

    #[test]
    fn long_token_encoding_pins_comment_chunk_layout() {
        for (size, expected_lengths) in [
            (0, vec![0]),
            (3, vec![3]),
            (65_534, vec![65_534]),
            (65_535, vec![65_535, 0]),
            (65_536, vec![65_535, 1]),
            (131_070, vec![65_535, 65_535, 0]),
        ] {
            let comment = "x".repeat(size);
            let mut bytes = Vec::new();
            encode_comment(&comment, &mut bytes);
            let mut cursor = 0;
            let mut payload = Vec::new();
            for expected in expected_lengths {
                assert_eq!(bytes[cursor], COMMENT_MARKER);
                let length = u16::from_le_bytes([bytes[cursor + 1], bytes[cursor + 2]]) as usize;
                assert_eq!(length, expected);
                cursor += 3;
                payload.extend_from_slice(&bytes[cursor..cursor + length]);
                cursor += length;
            }
            assert_eq!(cursor, bytes.len());
            assert_eq!(payload, comment.as_bytes());
            assert_eq!(
                decode_game(&bytes, Fen::default()).unwrap().nodes,
                vec![DecodedGameNode::Comment(comment)]
            );
            assert_mainline_move_bytes(&bytes, &[]);
            assert_eq!(try_iter_mainline_move_bytes(&bytes).unwrap().count(), 0);
        }
    }

    #[test]
    fn long_token_encoding_joins_utf8_before_decoding() {
        let comment = "ä".repeat(512 * 1024);
        let mut bytes = Vec::new();
        encode_comment(&comment, &mut bytes);
        assert_eq!(&bytes[..3], &[COMMENT_MARKER, 255, 255]);
        assert!(std::str::from_utf8(&bytes[3..3 + 65_535]).is_err());
        assert_eq!(
            decode_game(&bytes, Fen::default()).unwrap().nodes,
            vec![DecodedGameNode::Comment(comment)]
        );
    }

    #[test]
    fn long_token_encoding_preserves_adjacent_and_empty_comments() {
        for comments in [
            vec!["x".repeat(65_535), "second".into()],
            vec!["short".into(), String::new()],
            vec!["x".repeat(65_535), String::new()],
        ] {
            let mut bytes = Vec::new();
            for comment in &comments {
                encode_comment(comment, &mut bytes);
            }
            let expected: Vec<_> = comments.into_iter().map(DecodedGameNode::Comment).collect();
            assert_eq!(decode_game(&bytes, Fen::default()).unwrap().nodes, expected);
        }
    }

    #[test]
    fn long_token_encoding_decodes_continued_comment_longer_than_parser_cap() {
        let comment = "x".repeat(10 * 1024 * 1024 + 1);
        let mut bytes = Vec::new();
        encode_comment(&comment, &mut bytes);
        assert_eq!(
            decode_game(&bytes, Fen::default()).unwrap().nodes,
            vec![DecodedGameNode::Comment(comment)]
        );
    }

    #[test]
    fn long_token_encoding_rejects_truncated_continuation() {
        let mut bytes = Vec::new();
        encode_comment(&"x".repeat(65_535), &mut bytes);
        bytes.pop();
        assert!(decode_game(&bytes, Fen::default()).is_err());
    }

    #[test]
    fn long_token_encoding_cancels_during_continued_comment() {
        let mut bytes = Vec::new();
        encode_comment(&"x".repeat(131_070), &mut bytes);
        let cancellation = CancellationToken::new();
        let mut checkpoints = 0;
        let result = decode_game_cancellable_with_checkpoint(
            &bytes,
            Fen::default(),
            &cancellation,
            &mut || {
                checkpoints += 1;
                if checkpoints == 5 {
                    cancellation.cancel();
                }
            },
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(checkpoints, 5);
    }

    #[test]
    fn test_encode_illegal_move_returns_contextual_error() {
        prepare_mutation_test();
        let chess = Chess::default();
        let illegal_move = Move::Normal {
            role: Role::Pawn,
            from: Square::E2,
            to: Square::E5,
            capture: None,
            promotion: None,
        };

        let error = encode_move(&illegal_move, &chess).unwrap_err();
        assert_eq!(error.to_string(), "I/O failure");
        let source = std::error::Error::source(&error).expect("Io keeps its cause");
        assert_eq!(
            source.to_string(),
            "Move is not legal in the given position"
        );
    }

    #[test]
    fn test_encode_checked_conversion_roundtrips_legal_move() {
        prepare_mutation_test();
        let chess = Chess::default();
        let legal_move = Move::Normal {
            role: Role::Knight,
            from: Square::G1,
            to: Square::F3,
            capture: None,
            promotion: None,
        };

        let encoded = encode_move(&legal_move, &chess).unwrap();
        assert_eq!(decode_move(encoded, &chess), Some(legal_move));
    }

    #[test]
    fn test_decode_game_rejects_invalid_initial_setup() {
        prepare_mutation_test();
        let missing_black_king: Fen = "8/8/8/8/8/8/8/K7 w - - 0 1".parse().unwrap();

        let error = decode_game(&[], missing_black_king).unwrap_err();
        assert_eq!(error.to_string(), "I/O failure");
        let source = std::error::Error::source(&error).expect("Io keeps its cause");
        assert!(source.to_string().starts_with("Invalid initial FEN setup:"));
    }

    #[test]
    fn invalid_castling_rights_setup_converts_and_roundtrips_a_legal_move() {
        let fen: Fen = "4k3/8/8/8/8/8/8/4K3 w KQkq - 0 1".parse().unwrap();
        let chess = database_setup_to_chess(fen.clone().into_setup()).unwrap();
        let m = SanPlus::from_ascii(b"Ke2")
            .unwrap()
            .san
            .to_move(&chess)
            .unwrap();
        let bytes = [encode_move(&m, &chess).unwrap()];
        assert_eq!(decode_game_to_movetext(&bytes, fen).unwrap(), "1. Ke2");
    }

    #[test]
    fn too_much_material_decodes_legal_moves_but_rejects_invalid_blobs() {
        let fen: Fen = "4k3/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1".parse().unwrap();
        let chess = database_setup_to_chess(fen.clone().into_setup()).unwrap();
        let m = SanPlus::from_ascii(b"a4")
            .unwrap()
            .san
            .to_move(&chess)
            .unwrap();
        let bytes = [encode_move(&m, &chess).unwrap()];
        assert_eq!(
            decode_game_to_movetext(&bytes, fen.clone()).unwrap(),
            "1. a4"
        );

        for (blob, message) in [
            (&[251][..], "Invalid move index for current position"),
            (&[COMMENT_MARKER, 1][..], "Truncated comment length marker"),
        ] {
            let error = decode_game_to_movetext(blob, fen.clone()).unwrap_err();
            let cause = std::error::Error::source(&error).unwrap().to_string();
            assert_eq!(cause, message);
        }
    }

    #[test]
    fn too_much_material_does_not_hide_invalid_king_setups() {
        for fen in [
            "8/8/8/8/8/P7/PPPPPPPP/4K3 w - - 0 1",
            "4k3/8/8/8/8/P7/PPPPPPPP/3KK3 w - - 0 1",
        ] {
            let error = decode_game(&[], fen.parse().unwrap()).unwrap_err();
            let cause = std::error::Error::source(&error).unwrap().to_string();
            assert!(cause.starts_with("Invalid initial FEN setup:"), "{cause}");
        }
    }

    #[test]
    fn test_mainline_iterator_ignores_variations_and_comments() {
        prepare_mutation_test();
        let bytes = vec![
            1,
            NAG_MARKER,
            2,
            0,
            b'!',
            b'!',
            VARIATION_START_MARKER,
            2,
            VARIATION_START_MARKER,
            3,
            VARIATION_END_MARKER,
            COMMENT_MARKER,
            3,
            0,
            b'f',
            b'o',
            b'o',
            4,
            VARIATION_END_MARKER,
            COMMENT_MARKER,
            3,
            0,
            b'b',
            b'a',
            b'r',
            5,
        ];

        assert_mainline_move_bytes(&bytes, &[1, 5]);
    }

    #[test]
    fn mainline_iterator_handles_exact_and_truncated_annotation_boundaries() {
        prepare_mutation_test();
        let exact_empty = [1, COMMENT_MARKER, 0, 0, 2, NAG_MARKER, 0, 0, 3];
        assert_mainline_move_bytes(&[], &[]);
        assert_mainline_move_bytes(&[1], &[1]);
        assert_mainline_move_bytes(&exact_empty, &[1, 2, 3]);

        for truncated in [
            vec![1, COMMENT_MARKER],
            vec![1, COMMENT_MARKER, 0],
            vec![1, NAG_MARKER],
            vec![1, NAG_MARKER, 0],
        ] {
            assert_mainline_move_bytes(&truncated, &[1]);
        }
    }

    #[test]
    fn test_decode_game_with_nags() {
        prepare_mutation_test();
        let mut bytes = Vec::new();
        let mut chess = Chess::default();
        let m = decode_move(12, &chess).unwrap();
        bytes.push(encode_move(&m, &chess).unwrap());
        chess.play_unchecked(&m);

        encode_nag("!", &mut bytes);
        bytes.push(VARIATION_START_MARKER);

        let mut variation = Chess::default();
        let v = decode_move(12, &variation).unwrap();
        bytes.push(encode_move(&v, &variation).unwrap());
        variation.play_unchecked(&v);
        encode_nag("$2", &mut bytes);
        bytes.push(VARIATION_END_MARKER);

        let m2 = decode_move(12, &chess).unwrap();
        bytes.push(encode_move(&m2, &chess).unwrap());
        encode_nag("$1", &mut bytes);

        let movetext = decode_game_to_movetext(&bytes, Fen::default()).unwrap();
        assert_eq!(movetext, "1. e4! (1. e4?) 1... e5!");
    }

    #[test]
    fn render_nodes_preserves_every_symbolic_and_custom_nag_spacing() {
        prepare_mutation_test();
        let mut state = RenderState {
            move_number: 1,
            white_to_move: true,
        };
        let nodes = vec![
            DecodedGameNode::Move("e4".into()),
            DecodedGameNode::Nag("$1".into()),
            DecodedGameNode::Move("e5".into()),
            DecodedGameNode::Nag("$2".into()),
            DecodedGameNode::Move("Nf3".into()),
            DecodedGameNode::Nag("$3".into()),
            DecodedGameNode::Move("Nc6".into()),
            DecodedGameNode::Nag("$4".into()),
            DecodedGameNode::Move("Bb5".into()),
            DecodedGameNode::Nag("$5".into()),
            DecodedGameNode::Move("a6".into()),
            DecodedGameNode::Nag("$6".into()),
            DecodedGameNode::Nag("$99".into()),
            DecodedGameNode::Comment("note".into()),
            DecodedGameNode::Nag("!!".into()),
        ];

        assert_eq!(
            render_nodes(&nodes, &mut state),
            "1. e4! e5? 2. Nf3!! Nc6?? 3. Bb5!? a6?! $99 {note} !!"
        );
    }

    #[test]
    fn decode_game_checks_exact_annotation_length_and_payload_boundaries() {
        prepare_mutation_test();
        for marker in [COMMENT_MARKER, NAG_MARKER] {
            assert!(decode_game(&[marker], Fen::default()).is_err());
            assert!(decode_game(&[marker, 0], Fen::default()).is_err());
            assert!(decode_game(&[marker, 1, 0], Fen::default()).is_err());

            let empty = decode_game(&[marker, 0, 0], Fen::default()).unwrap();
            let expected = if marker == COMMENT_MARKER {
                DecodedGameNode::Comment(String::new())
            } else {
                DecodedGameNode::Nag(String::new())
            };
            assert_eq!(empty.nodes, vec![expected]);
        }

        let chess = Chess::default();
        let legal_move = Move::Normal {
            role: Role::Pawn,
            from: Square::E2,
            to: Square::E4,
            capture: None,
            promotion: None,
        };
        let encoded_move = encode_move(&legal_move, &chess).unwrap();
        let bytes = [COMMENT_MARKER, 1, 0, b'x', encoded_move];
        assert_eq!(
            decode_game(&bytes, Fen::default()).unwrap().nodes,
            vec![
                DecodedGameNode::Comment("x".into()),
                DecodedGameNode::Move("e4".into())
            ]
        );

        let bytes = [NAG_MARKER, 1, 0, b'!', encoded_move];
        assert_eq!(
            decode_game(&bytes, Fen::default()).unwrap().nodes,
            vec![
                DecodedGameNode::Nag("!".into()),
                DecodedGameNode::Move("e4".into())
            ]
        );
    }

    #[test]
    fn test_decode_game_plain_mainline() {
        prepare_mutation_test();
        let mut chess = Chess::default();
        let mut bytes = Vec::new();

        let first = Move::Normal {
            role: Role::Pawn,
            from: Square::E2,
            to: Square::E4,
            capture: None,
            promotion: None,
        };
        bytes.push(encode_move(&first, &chess).unwrap());
        chess.play_unchecked(&first);

        let second = Move::Normal {
            role: Role::Pawn,
            from: Square::E7,
            to: Square::E5,
            capture: None,
            promotion: None,
        };
        bytes.push(encode_move(&second, &chess).unwrap());
        chess.play_unchecked(&second);

        let third = Move::Normal {
            role: Role::Knight,
            from: Square::G1,
            to: Square::F3,
            capture: None,
            promotion: None,
        };
        bytes.push(encode_move(&third, &chess).unwrap());
        chess.play_unchecked(&third);

        let fourth = Move::Normal {
            role: Role::Knight,
            from: Square::B8,
            to: Square::C6,
            capture: None,
            promotion: None,
        };
        bytes.push(encode_move(&fourth, &chess).unwrap());

        let movetext = decode_game_to_movetext(&bytes, Fen::default()).unwrap();
        assert_eq!(movetext, "1. e4 e5 2. Nf3 Nc6");
    }

    #[test]
    fn test_decode_game_comment_does_not_force_black_ellipsis() {
        prepare_mutation_test();
        let mut chess = Chess::default();
        let mut bytes = Vec::new();

        let white_move = Move::Normal {
            role: Role::Pawn,
            from: Square::E2,
            to: Square::E4,
            capture: None,
            promotion: None,
        };
        bytes.push(encode_move(&white_move, &chess).unwrap());
        chess.play_unchecked(&white_move);

        encode_comment("mainline", &mut bytes);

        let black_move = Move::Normal {
            role: Role::Pawn,
            from: Square::E7,
            to: Square::E5,
            capture: None,
            promotion: None,
        };
        bytes.push(encode_move(&black_move, &chess).unwrap());

        let movetext = decode_game_to_movetext(&bytes, Fen::default()).unwrap();
        assert_eq!(movetext, "1. e4 {mainline} e5");
    }

    #[test]
    fn test_decode_game_starts_with_black_move_numbering() {
        prepare_mutation_test();
        let initial_fen: Fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1"
            .parse()
            .unwrap();
        let chess = Chess::from_setup(initial_fen.clone().into(), CastlingMode::Chess960)
            .or_else(PositionError::ignore_too_much_material)
            .unwrap();

        let black_pawn_push = Move::Normal {
            role: Role::Pawn,
            from: Square::E7,
            to: Square::E5,
            capture: None,
            promotion: None,
        };
        let bytes = vec![encode_move(&black_pawn_push, &chess).unwrap()];

        let movetext = decode_game_to_movetext(&bytes, initial_fen).unwrap();
        assert_eq!(movetext, "1... e5");
    }

    #[test]
    fn test_decode_game_nested_variations_and_comments() {
        prepare_mutation_test();
        let mut bytes = Vec::new();

        let mut root = Chess::default();
        let branch_root = root.clone();
        let m_e4 = decode_move(12, &root).unwrap();
        bytes.push(encode_move(&m_e4, &root).unwrap());
        root.play_unchecked(&m_e4);

        encode_comment("hello", &mut bytes);

        bytes.push(VARIATION_START_MARKER);
        let mut var = branch_root.clone();
        let var_branch_root = var.clone();
        let m_var_first = decode_move(12, &var).unwrap();
        bytes.push(encode_move(&m_var_first, &var).unwrap());
        var.play_unchecked(&m_var_first);

        bytes.push(VARIATION_START_MARKER);
        let m_var_nested = decode_move(0, &var_branch_root).unwrap();
        bytes.push(encode_move(&m_var_nested, &var_branch_root).unwrap());
        bytes.push(VARIATION_END_MARKER);

        encode_comment("nest", &mut bytes);
        bytes.push(VARIATION_END_MARKER);

        let m_mainline_second = decode_move(12, &root).unwrap();
        bytes.push(encode_move(&m_mainline_second, &root).unwrap());

        let decoded = decode_game(&bytes, Fen::default()).unwrap();

        let expected_first = SanPlus::from_move(Chess::default(), &m_e4).to_string();
        let expected_var_first = SanPlus::from_move(root.clone(), &m_var_first).to_string();
        let expected_nested = SanPlus::from_move(var_branch_root, &m_var_nested).to_string();
        let expected_mainline_second = SanPlus::from_move(root, &m_mainline_second).to_string();

        assert_eq!(
            decoded.nodes,
            vec![
                DecodedGameNode::Move(expected_first),
                DecodedGameNode::Comment("hello".to_string()),
                DecodedGameNode::Variation(vec![
                    DecodedGameNode::Move(expected_var_first),
                    DecodedGameNode::Variation(vec![DecodedGameNode::Move(expected_nested)]),
                    DecodedGameNode::Comment("nest".to_string()),
                ]),
                DecodedGameNode::Move(expected_mainline_second),
            ]
        );
    }

    #[test]
    fn fallible_mainline_iterator_rejects_truncated_and_unbalanced_streams() {
        prepare_mutation_test();
        assert!(try_iter_mainline_move_bytes(&[COMMENT_MARKER, 4, 0, b'x']).is_err());
        assert!(try_iter_mainline_move_bytes(&[NAG_MARKER, 1]).is_err());
        assert!(try_iter_mainline_move_bytes(&[VARIATION_END_MARKER]).is_err());
        assert!(try_iter_mainline_move_bytes(&[VARIATION_START_MARKER, 0]).is_err());
    }

    #[test]
    fn cancellable_validation_stops_during_actual_large_comment_and_move_traversal() {
        prepare_mutation_test();
        let mut bytes = Vec::new();
        for _ in 0..96 {
            bytes.extend(std::iter::repeat_n(0, 2_048));
            encode_comment(&"x".repeat(60_000), &mut bytes);
        }
        let cancellation = tokio_util::sync::CancellationToken::new();
        let mut checkpoints = 0usize;
        let result =
            try_iter_mainline_move_bytes_with_checkpoint(&bytes, &cancellation, |cursor| {
                checkpoints += 1;
                if cursor > bytes.len() / 2 {
                    cancellation.cancel();
                }
            });
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(
            checkpoints > 90_000,
            "validation did not traverse the move stream"
        );
    }

    #[test]
    fn cancellable_decoder_stops_before_copying_a_large_annotation() {
        prepare_mutation_test();
        let mut bytes = Vec::new();
        encode_comment(&"x".repeat(u16::MAX as usize), &mut bytes);
        let cancellation = CancellationToken::new();
        let mut checkpoints = 0usize;
        let result = decode_game_cancellable_with_checkpoint(
            &bytes,
            Fen::default(),
            &cancellation,
            &mut || {
                checkpoints += 1;
                if checkpoints == 3 {
                    cancellation.cancel();
                }
            },
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(
            checkpoints, 3,
            "decoder reached the bounded pre-copy checkpoint"
        );
    }

    #[test]
    fn cancellable_movetext_render_stops_after_decode_before_publication() {
        prepare_mutation_test();
        let mut bytes = Vec::new();
        encode_comment(&"visible only after rendering".repeat(1_000), &mut bytes);
        let cancellation = CancellationToken::new();
        let mut checkpoints = 0usize;
        let result = decode_game_to_movetext_cancellable_with_checkpoint(
            &bytes,
            Fen::default(),
            &cancellation,
            &mut || {
                checkpoints += 1;
                if checkpoints == 6 {
                    cancellation.cancel();
                }
            },
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(checkpoints, 6, "render traversal observed the inner token");
    }

    #[test]
    fn render_cancellation_checkpoint_prevents_move_state_mutation() {
        prepare_mutation_test();
        let cancellation = CancellationToken::new();
        cancel_decode_after_checkpoints(cancellation.clone(), 1);
        let mut state = RenderState {
            move_number: 1,
            white_to_move: true,
        };
        let result = render_nodes_cancellable(
            &[DecodedGameNode::Move("e4".into())],
            &mut state,
            &cancellation,
            &mut || {},
        );
        assert!(matches!(result, Err(Error::Cancellation)));
        assert_eq!(state.move_number, 1);
        assert!(state.white_to_move, "cancelled render mutated move state");
    }

    #[test]
    fn mutation_core_suppression_is_after_exec_and_scoped() {
        prepare_mutation_test();

        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::ExitStatusExt;
            use std::process::Command;

            if let Some(mode) = std::env::var_os(CORE_SUPPRESSION_PROBE_ENV) {
                let dumpability = current_dumpability();
                eprintln!(
                    "encoding-core-probe pid={} dumpability={} mode={}",
                    std::process::id(),
                    dumpability,
                    mode.to_string_lossy()
                );
                match mode.to_str() {
                    Some("ordinary") => {
                        assert_eq!(dumpability, 1);
                        return;
                    }
                    Some("contained-abort") => {
                        assert_eq!(dumpability, 0);
                        eprintln!("encoding-core-probe aborting after checked dumpability=0");
                        std::process::abort();
                    }
                    _ => panic!("unknown encoding core-suppression probe mode"),
                }
            }

            let executable = std::env::current_exe().expect("test executable path is available");
            let test_name =
                "db::encoding::tests::mutation_core_suppression_is_after_exec_and_scoped";
            let ordinary = Command::new(&executable)
                .args(["--exact", test_name, "--nocapture"])
                .env_remove(SUPPRESS_MUTATION_CORE_ENV)
                .env(CORE_SUPPRESSION_PROBE_ENV, "ordinary")
                .output()
                .expect("ordinary probe starts");
            let ordinary_stderr = String::from_utf8_lossy(&ordinary.stderr);
            eprint!("{ordinary_stderr}");
            assert!(ordinary.status.success());
            assert!(ordinary_stderr.contains("dumpability=1 mode=ordinary"));

            let contained = Command::new(executable)
                .args(["--exact", test_name, "--nocapture"])
                .env(SUPPRESS_MUTATION_CORE_ENV, "1")
                .env(CORE_SUPPRESSION_PROBE_ENV, "contained-abort")
                .output()
                .expect("contained abort probe starts");
            let contained_stderr = String::from_utf8_lossy(&contained.stderr);
            eprint!("{contained_stderr}");
            assert_eq!(contained.status.signal(), Some(libc::SIGABRT));
            assert!(contained_stderr.contains("encoding-core-probe pid="));
            assert!(contained_stderr.contains("dumpability=0 mode=contained-abort"));
            assert!(contained_stderr.contains("aborting after checked dumpability=0"));
        }
    }
}
