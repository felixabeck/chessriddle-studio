//! Scoresheet photo reading turn: prompts a vision-capable model to transcribe 1–4 scoresheet
//! photos into JSON, validates and replays every move against standard chess rules, runs bounded
//! correction rounds on illegal moves, and returns the legal prefix plus any remaining sheet
//! tokens.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use shakmaty::{san::SanPlus, CastlingMode, Chess, Position};
use specta::Type;
use tokio_util::sync::CancellationToken;

use super::{
    backend::{Message, ModelBackend},
    coach,
    driver::TURN_DEADLINE,
    effort_is_plain,
    error::CoachError,
    lines::{normalize_move_token, position_fen, resolve_move_token, MAX_MOVE_TOKEN_CHARS},
    model_loop::ModelRounds,
    plain,
    scoresheet_photo::{MAX_OUTPUT_JPEG_BYTES, MAX_SCORESHEET_PHOTOS},
    MAX_MODEL_CHARS,
};
use crate::{
    credentials::CoachConnectionHandle,
    infra::validation::{validate_image_data_url, RasterFormat},
};

/// Maximum scoresheet reads running concurrently across all windows (at most one per window).
pub(crate) const MAX_SCORESHEET_READS: usize = 2;
/// Total model rounds permitted for one scoresheet read (initial + repair/correction rounds).
pub(crate) const MAX_READ_ROUNDS: usize = 4;
const MAX_ROWS: usize = 300;
const MAX_HEADER_CHARS: usize = 120;
const MAX_STOPPED_TOKENS: usize = 600;
const MAX_CLOCK_SECONDS: u32 = 36_000;
const MAX_PLAUSIBLE_CLOCK_RISE_SECONDS: u32 = 60;
const UNREADABLE_TOKEN: &str = "?";

const SYSTEM_PROMPT: &str = "\
You transcribe handwritten chess scoresheets from photographs.\n\
Rules:\n\
- The attached photos are pages of one game's scoresheet, in order.\n\
- Transcribe exactly what is written on the sheet. Never invent or substitute a better move.\n\
- Convert piece letters from the sheet's language (for example K/D/T/L/S, R/D/T/F/C, R/D/T/A/C) into English SAN (K, Q, R, B, N).\n\
- Answer with ONE JSON object and nothing else. Do not add commentary outside the JSON.\n\
- Schema:\n\
{\n\
  \"status\": \"ok\" | \"no_image\" | \"not_a_scoresheet\",\n\
  \"headers\": {\n\
    \"white\": \"\", \"black\": \"\", \"event\": \"\", \"site\": \"\",\n\
    \"date\": \"YYYY.MM.DD\", \"round\": \"\", \"result\": \"1-0\" | \"0-1\" | \"1/2-1/2\" | \"*\",\n\
    \"whiteElo\": \"\", \"blackElo\": \"\"\n\
  },\n\
  \"moves\": [\n\
    { \"n\": 1, \"white\": \"e4\", \"black\": \"e5\", \"whiteClock\": \"\", \"blackClock\": \"\", \"unsure\": [] }\n\
  ]\n\
}\n\
- Use status \"no_image\" if you cannot see any attached image.\n\
- Use status \"not_a_scoresheet\" if the photos are not a chess scoresheet.\n\
- Leave absent header fields as empty strings.\n\
- In each row, \"n\" is the 1-based move number, \"white\" and \"black\" are the SAN moves, \"whiteClock\" and \"blackClock\" are optional remaining clock times written next to the move, exactly as written (e.g. \"86\" or \"1:26\"; empty if none), and \"unsure\" lists any of \"white\" or \"black\" that you could not read with confidence.\n\
- Put \"?\" for any cell on the sheet that is unreadable.";

const INITIAL_USER_PROMPT: &str = "Transcribe this chess scoresheet into the required JSON object.";

const RETRY_MALFORMED_PROMPT: &str = "\
Your previous reply was not a valid JSON object matching the schema and bounds \
(status, headers up to 120 chars, up to 300 rows with ascending move numbers 1..300 and move tokens up to 12 chars). \
Please reply with ONLY that one JSON object.";

#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScoresheetReadInput {
    pub connection: CoachConnectionHandle,
    pub model: String,
    #[specta(optional)]
    pub effort: Option<String>,
    pub photos: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetHeaders {
    pub white: String,
    pub black: String,
    pub event: String,
    pub site: String,
    pub date: String,
    pub round: String,
    pub result: String,
    pub white_elo: String,
    pub black_elo: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetMove {
    pub san: String,
    pub unsure: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub clock: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetStop {
    pub ply: u32,
    pub tokens: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(optional)]
    pub clocks: Option<Vec<Option<u32>>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetGame {
    pub headers: ScoresheetHeaders,
    pub moves: Vec<ScoresheetMove>,
    pub stopped: Option<ScoresheetStop>,
}

impl ScoresheetReadInput {
    fn validate(&self) -> Result<(), CoachError> {
        if !plain(&self.model, MAX_MODEL_CHARS) || !effort_is_plain(self.effort.as_deref()) {
            return Err(CoachError::InvalidInput);
        }
        if self.photos.is_empty() || self.photos.len() > MAX_SCORESHEET_PHOTOS {
            return Err(CoachError::InvalidInput);
        }
        for photo in &self.photos {
            if validate_image_data_url(photo, &[RasterFormat::Jpeg], MAX_OUTPUT_JPEG_BYTES)
                .is_none()
            {
                return Err(CoachError::InvalidInput);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReplyStatus {
    Ok,
    NoImage,
    NotAScoresheet,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedRow {
    n: usize,
    white: Option<String>,
    black: Option<String>,
    white_clock: Option<u32>,
    black_clock: Option<u32>,
    unsure_white: bool,
    unsure_black: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedReply {
    status: ReplyStatus,
    headers: ScoresheetHeaders,
    rows: Vec<ParsedRow>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SheetCell {
    token: String,
    unsure: bool,
    clock: Option<u32>,
}

/// Extracts the first balanced JSON object `{ ... }` from `text`, tolerating surrounding prose or
/// markdown code fences.
fn extract_first_json_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&text[start..=start + offset]);
                }
            }
            _ => {}
        }
    }
    None
}

fn clean_header_value(raw: &str) -> String {
    raw.chars()
        .filter(|ch| !ch.is_control())
        .collect::<String>()
        .trim()
        .to_owned()
}

fn clean_date(raw: &str) -> String {
    let cleaned = clean_header_value(raw);
    let mut parts = cleaned.split('.');
    let (Some(year), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return String::new();
    };
    let year_ok =
        year == "????" || (year.len() == 4 && year.bytes().all(|byte| byte.is_ascii_digit()));
    let month_ok = month == "??"
        || (month.len() == 2
            && month.bytes().all(|byte| byte.is_ascii_digit())
            && matches!(month.parse::<u8>(), Ok(1..=12)));
    let day_ok = day == "??"
        || (day.len() == 2
            && day.bytes().all(|byte| byte.is_ascii_digit())
            && matches!(day.parse::<u8>(), Ok(1..=31)));
    if year_ok && month_ok && day_ok {
        cleaned
    } else {
        String::new()
    }
}

fn clean_result(raw: &str) -> String {
    match clean_header_value(raw).as_str() {
        "1-0" => "1-0".into(),
        "0-1" => "0-1".into(),
        "1/2-1/2" => "1/2-1/2".into(),
        _ => "*".into(),
    }
}

fn clean_elo(raw: &str) -> String {
    let cleaned = clean_header_value(raw);
    if !cleaned.is_empty()
        && cleaned.len() <= 4
        && cleaned.bytes().all(|byte| byte.is_ascii_digit())
    {
        cleaned
    } else {
        String::new()
    }
}

fn parse_header_field(headers: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    match headers.get(key) {
        None | Some(Value::Null) => Some(String::new()),
        Some(Value::String(text)) => {
            if text.chars().count() > MAX_HEADER_CHARS {
                return None;
            }
            Some(text.clone())
        }
        Some(Value::Number(num)) => {
            let text = num.to_string();
            if text.chars().count() > MAX_HEADER_CHARS {
                return None;
            }
            Some(text)
        }
        _ => None,
    }
}

fn parse_headers(value: Option<&Value>) -> Option<ScoresheetHeaders> {
    let Some(value) = value else {
        return Some(ScoresheetHeaders {
            result: "*".into(),
            ..ScoresheetHeaders::default()
        });
    };
    if value.is_null() {
        return Some(ScoresheetHeaders {
            result: "*".into(),
            ..ScoresheetHeaders::default()
        });
    }
    let map = value.as_object()?;
    let white = clean_header_value(&parse_header_field(map, "white")?);
    let black = clean_header_value(&parse_header_field(map, "black")?);
    let event = clean_header_value(&parse_header_field(map, "event")?);
    let site = clean_header_value(&parse_header_field(map, "site")?);
    let date = clean_date(&parse_header_field(map, "date")?);
    let round = clean_header_value(&parse_header_field(map, "round")?);
    let result = clean_result(&parse_header_field(map, "result")?);
    let white_elo = clean_elo(&parse_header_field(map, "whiteElo")?);
    let black_elo = clean_elo(&parse_header_field(map, "blackElo")?);
    Some(ScoresheetHeaders {
        white,
        black,
        event,
        site,
        date,
        round,
        result,
        white_elo,
        black_elo,
    })
}

fn parse_leading_clock_part(part: &str) -> Option<u32> {
    if part.is_empty() || part.len() > 6 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    part.parse::<u32>().ok()
}

fn parse_sexagesimal_clock_part(part: &str) -> Option<u32> {
    let bytes = part.as_bytes();
    if bytes.len() != 2 || !(b'0'..=b'5').contains(&bytes[0]) || !bytes[1].is_ascii_digit() {
        return None;
    }
    Some(u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0'))
}

/// Mirrors `parseClockInput` in `src/utils/clock.ts`: plain whole number is minutes (`"86"` -> 5160),
/// `"h:mm"` and `"h:mm:ss"` parse hours/minutes/seconds, upper bound 10 h (`36_000` s).
fn parse_clock_str(raw: &str) -> Option<u32> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut parts = trimmed.split(':');
    let first = parts.next()?;
    match (parts.next(), parts.next(), parts.next()) {
        (None, None, None) => {
            let minutes = parse_leading_clock_part(first)?;
            let seconds = minutes.checked_mul(60)?;
            (seconds <= MAX_CLOCK_SECONDS).then_some(seconds)
        }
        (Some(second), third, None) => {
            let hours = parse_leading_clock_part(first)?;
            let minutes = parse_sexagesimal_clock_part(second)?;
            let secs = match third {
                Some(part) => parse_sexagesimal_clock_part(part)?,
                None => 0,
            };
            let total = hours
                .checked_mul(3600)?
                .checked_add(minutes.checked_mul(60)?)?
                .checked_add(secs)?;
            (total <= MAX_CLOCK_SECONDS).then_some(total)
        }
        _ => None,
    }
}

/// Parses an optional JSON clock field (`string` or `number`). Any malformed or out-of-range value
/// becomes `None` and never fails the scoresheet reply.
fn parse_clock_cell(value: Option<&Value>) -> Option<u32> {
    match value {
        Some(Value::String(raw)) => parse_clock_str(raw),
        Some(Value::Number(num)) => parse_clock_str(&num.to_string()),
        _ => None,
    }
}

fn parse_cell(value: Option<&Value>) -> Option<Option<String>> {
    match value {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.chars().count() > MAX_MOVE_TOKEN_CHARS {
                return None;
            }
            if trimmed.is_empty() {
                Some(None)
            } else {
                Some(Some(trimmed.to_owned()))
            }
        }
        _ => None,
    }
}

fn parse_reply(text: &str, require_status: bool) -> Option<ParsedReply> {
    let json_text = extract_first_json_object(text)?;
    let root: Value = serde_json::from_str(json_text).ok()?;
    let obj = root.as_object()?;

    let status = match obj.get("status") {
        Some(Value::String(s)) => match s.as_str() {
            "ok" => ReplyStatus::Ok,
            "no_image" => ReplyStatus::NoImage,
            "not_a_scoresheet" => ReplyStatus::NotAScoresheet,
            _ => return None,
        },
        None if !require_status => ReplyStatus::Ok,
        _ => return None,
    };

    let headers = parse_headers(obj.get("headers"))?;

    let mut rows = Vec::new();
    if let Some(moves_val) = obj.get("moves") {
        if !moves_val.is_null() {
            let arr = moves_val.as_array()?;
            if arr.len() > MAX_ROWS {
                return None;
            }
            let mut prev_n = 0usize;
            for item in arr {
                let row = item.as_object()?;
                let n_u64 = row.get("n")?.as_u64()?;
                let n = usize::try_from(n_u64).ok()?;
                if n == 0 || n > MAX_ROWS || n <= prev_n {
                    return None;
                }
                prev_n = n;

                let white = parse_cell(row.get("white"))?;
                let black = parse_cell(row.get("black"))?;
                let white_clock = parse_clock_cell(row.get("whiteClock"));
                let black_clock = parse_clock_cell(row.get("blackClock"));
                let mut unsure_white = false;
                let mut unsure_black = false;
                if let Some(unsure_val) = row.get("unsure") {
                    if !unsure_val.is_null() {
                        let unsure_arr = unsure_val.as_array()?;
                        for flag in unsure_arr {
                            let label = flag.as_str()?;
                            if label.eq_ignore_ascii_case("white") {
                                unsure_white = true;
                            } else if label.eq_ignore_ascii_case("black") {
                                unsure_black = true;
                            }
                        }
                    }
                }
                rows.push(ParsedRow {
                    n,
                    white,
                    black,
                    white_clock,
                    black_clock,
                    unsure_white,
                    unsure_black,
                });
            }
        }
    }

    Some(ParsedReply {
        status,
        headers,
        rows,
    })
}

/// Normalises one filled cell's text. `?` or anything that leaves nothing after normalisation
/// becomes the unreadable token `?` so its ply is never dropped.
fn cell_token(raw: &str) -> String {
    if raw == UNREADABLE_TOKEN {
        return UNREADABLE_TOKEN.into();
    }
    normalize_move_token(raw).unwrap_or_else(|| UNREADABLE_TOKEN.into())
}

/// Converts parsed rows into `(start_ply, cells)` covering every ply up to the last filled cell.
/// When `start_at_zero` is true (initial reading), `start_ply` is 0 and skipped/leading empty
/// cells become `?`. When false (correction reply), `start_ply` is the first filled cell so an
/// empty cell at the start of the first returned row leaves that ply's existing token in place.
fn rows_to_ply_slice(rows: &[ParsedRow], start_at_zero: bool) -> Option<(usize, Vec<SheetCell>)> {
    let mut first_filled_ply: Option<usize> = None;
    let mut last_filled_ply: Option<usize> = None;
    for row in rows {
        let base = 2 * (row.n - 1);
        if row.white.is_some() {
            first_filled_ply.get_or_insert(base);
            last_filled_ply = Some(base);
        }
        if row.black.is_some() {
            first_filled_ply.get_or_insert(base + 1);
            last_filled_ply = Some(base + 1);
        }
    }
    let start_ply = if start_at_zero { 0 } else { first_filled_ply? };
    let last_ply = last_filled_ply?;
    let mut slice = vec![
        SheetCell {
            token: UNREADABLE_TOKEN.into(),
            unsure: false,
            clock: None,
        };
        last_ply - start_ply + 1
    ];
    for row in rows {
        let base = 2 * (row.n - 1);
        if let Some(white) = &row.white {
            if base >= start_ply && base <= last_ply {
                slice[base - start_ply] = SheetCell {
                    token: cell_token(white),
                    unsure: row.unsure_white,
                    clock: row.white_clock,
                };
            }
        }
        if let Some(black) = &row.black {
            if base + 1 >= start_ply && base < last_ply {
                slice[base + 1 - start_ply] = SheetCell {
                    token: cell_token(black),
                    unsure: row.unsure_black,
                    clock: row.black_clock,
                };
            }
        }
    }
    Some((start_ply, slice))
}

fn rows_to_initial_cells(rows: &[ParsedRow]) -> Vec<SheetCell> {
    rows_to_ply_slice(rows, true)
        .map(|(_, cells)| cells)
        .unwrap_or_default()
}

fn rows_to_correction_slice(rows: &[ParsedRow]) -> Option<(usize, Vec<SheetCell>)> {
    rows_to_ply_slice(rows, false)
}

struct ReplayResult {
    moves: Vec<ScoresheetMove>,
    failed: Option<(usize, Chess)>,
}

/// Replays `cells` from the standard starting position using the shared single-token resolver.
fn replay_cells(cells: &[SheetCell]) -> ReplayResult {
    let mut position = Chess::default();
    let mut moves = Vec::with_capacity(cells.len());
    for (ply, cell) in cells.iter().enumerate() {
        let Some((san, _uci)) =
            resolve_move_token(&mut position, CastlingMode::Standard, &cell.token)
        else {
            return ReplayResult {
                moves,
                failed: Some((ply, position)),
            };
        };
        moves.push(ScoresheetMove {
            san,
            unsure: cell.unsure,
            clock: cell.clock,
        });
    }
    ReplayResult {
        moves,
        failed: None,
    }
}

/// Marks a move `unsure` when its clock rises more than 60 s above the same side's previous
/// reading, except on move 40, 41, 60 or 61 where a time-control period bonus can be added.
fn mark_implausible_clocks(moves: &mut [ScoresheetMove]) {
    let mut prev_clock: [Option<u32>; 2] = [None, None];
    for (ply, mv) in moves.iter_mut().enumerate() {
        let Some(clock) = mv.clock else {
            continue;
        };
        let side = ply % 2;
        let move_number = ply / 2 + 1;
        let exempt = matches!(move_number, 40 | 41 | 60 | 61);
        if let Some(prev) = prev_clock[side] {
            if !exempt && clock > prev.saturating_add(MAX_PLAUSIBLE_CLOCK_RISE_SECONDS) {
                mv.unsure = true;
            }
        }
        prev_clock[side] = Some(clock);
    }
}

fn correction_prompt(failed_ply: usize, failed_token: &str, position: &Chess) -> String {
    let move_number = failed_ply / 2 + 1;
    let colour = if failed_ply.is_multiple_of(2) {
        "White"
    } else {
        "Black"
    };
    let fen = position_fen(position);
    let legal_moves: Vec<String> = position
        .legal_moves()
        .into_iter()
        .map(|m| SanPlus::from_move(position.clone(), &m).to_string())
        .collect();
    format!(
        "Move {move_number} ({colour}) \"{failed_token}\" is not a legal move in this position.\n\
         Position FEN: {fen}\n\
         Legal moves: {}\n\
         Look at the scoresheet photos again and return ONE JSON object {{\"status\":\"ok\",\"moves\":[...]}} \
         with the same row shape (including \"whiteClock\" and \"blackClock\" if written) \
         starting from move {move_number} (or an earlier row if the misreading was earlier). \
         If the first returned row starts on Black's move, leave \"white\" empty.",
        legal_moves.join(", ")
    )
}

async fn ask_round(rounds: &ModelRounds<'_>, messages: &[Message]) -> Result<String, CoachError> {
    if rounds.cancellation.is_cancelled() {
        return Err(CoachError::Cancelled);
    }
    let round = rounds
        .ask(messages, &mut |_| {})
        .await
        .map_err(|failure| failure.error)?;
    Ok(round.text)
}

/// Core reading loop, independent of Tauri state so unit tests can drive it directly with
/// `ScriptedBackend` and custom deadlines.
async fn run_scoresheet_read(
    backend: &dyn ModelBackend,
    model: &str,
    effort: Option<&str>,
    photos: Vec<String>,
    cancellation: &CancellationToken,
    deadline: Duration,
) -> Result<ScoresheetGame, CoachError> {
    match tokio::time::timeout(
        deadline,
        run_scoresheet_rounds(backend, model, effort, photos, cancellation),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            if cancellation.is_cancelled() {
                Err(CoachError::Cancelled)
            } else {
                Err(CoachError::LimitExceeded)
            }
        }
    }
}

async fn run_scoresheet_rounds(
    backend: &dyn ModelBackend,
    model: &str,
    effort: Option<&str>,
    photos: Vec<String>,
    cancellation: &CancellationToken,
) -> Result<ScoresheetGame, CoachError> {
    let rounds = ModelRounds {
        backend,
        model,
        effort,
        system: SYSTEM_PROMPT,
        tools: &[],
        cancellation,
    };
    let mut messages = vec![Message::UserWithImages {
        text: INITIAL_USER_PROMPT.into(),
        images: photos,
    }];
    let mut rounds_used = 0usize;

    // Initial reading (retrying malformed/out-of-bound replies within the 4-round budget).
    let (headers, mut cells) = loop {
        rounds_used += 1;
        let reply_text = ask_round(&rounds, &messages).await?;
        messages.push(Message::Assistant {
            text: reply_text.clone(),
            tool_calls: Vec::new(),
            extra: serde_json::Map::new(),
        });
        match parse_reply(&reply_text, true) {
            Some(parsed) => match parsed.status {
                ReplyStatus::NoImage => return Err(CoachError::ImagesUnsupported),
                ReplyStatus::NotAScoresheet => return Err(CoachError::ScoresheetUnreadable),
                ReplyStatus::Ok => break (parsed.headers, rows_to_initial_cells(&parsed.rows)),
            },
            None => {
                if rounds_used >= MAX_READ_ROUNDS {
                    return Err(CoachError::ScoresheetUnreadable);
                }
                messages.push(Message::User(RETRY_MALFORMED_PROMPT.into()));
            }
        }
    };

    // Replay and run bounded correction rounds on illegal moves.
    loop {
        let mut replay = replay_cells(&cells);
        let Some((failed_ply, failed_position)) = replay.failed else {
            if replay.moves.is_empty() {
                return Err(CoachError::ScoresheetUnreadable);
            }
            mark_implausible_clocks(&mut replay.moves);
            return Ok(ScoresheetGame {
                headers,
                moves: replay.moves,
                stopped: None,
            });
        };

        let build_stopped = |mut moves: Vec<ScoresheetMove>,
                             cells: &[SheetCell]|
         -> Result<ScoresheetGame, CoachError> {
            if moves.is_empty() {
                return Err(CoachError::ScoresheetUnreadable);
            }
            mark_implausible_clocks(&mut moves);
            let remaining_cells = &cells[failed_ply..];
            let remaining: Vec<String> = remaining_cells
                .iter()
                .take(MAX_STOPPED_TOKENS)
                .map(|cell| cell.token.clone())
                .collect();
            let remaining_clocks: Vec<Option<u32>> = remaining_cells
                .iter()
                .take(MAX_STOPPED_TOKENS)
                .map(|cell| cell.clock)
                .collect();
            let clocks = remaining_clocks
                .iter()
                .any(Option::is_some)
                .then_some(remaining_clocks);
            Ok(ScoresheetGame {
                headers: headers.clone(),
                moves,
                stopped: Some(ScoresheetStop {
                    ply: u32::try_from(failed_ply).unwrap_or(u32::MAX),
                    tokens: remaining,
                    clocks,
                }),
            })
        };

        if rounds_used >= MAX_READ_ROUNDS {
            return build_stopped(replay.moves, &cells);
        }

        let failed_token = cells[failed_ply].token.clone();
        messages.push(Message::User(correction_prompt(
            failed_ply,
            &failed_token,
            &failed_position,
        )));
        rounds_used += 1;

        // A provider, transport or deadline failure in any round fails the whole read.
        let reply_text = ask_round(&rounds, &messages).await?;
        messages.push(Message::Assistant {
            text: reply_text.clone(),
            tool_calls: Vec::new(),
            extra: serde_json::Map::new(),
        });

        let Some(parsed) = parse_reply(&reply_text, false) else {
            return build_stopped(replay.moves, &cells);
        };
        if parsed.status == ReplyStatus::NoImage {
            return Err(CoachError::ImagesUnsupported);
        }
        if parsed.status == ReplyStatus::NotAScoresheet {
            return Err(CoachError::ScoresheetUnreadable);
        }
        let Some((first_ply, replacement)) = rows_to_correction_slice(&parsed.rows) else {
            return build_stopped(replay.moves, &cells);
        };

        let prev_cells = cells.clone();
        // Keep everything before `first_ply`, pad any gap with `?`, and replace from `first_ply`
        // to the end with the correction's cells.
        cells.truncate(first_ply);
        while cells.len() < first_ply {
            cells.push(SheetCell {
                token: UNREADABLE_TOKEN.into(),
                unsure: false,
                clock: None,
            });
        }
        for (offset, mut cell) in replacement.into_iter().enumerate() {
            let ply = first_ply + offset;
            let prev = prev_cells.get(ply);
            let changed = prev.is_some_and(|old| old.token != cell.token);
            let prev_unsure = prev.is_some_and(|old| old.unsure);
            if !changed && cell.clock.is_none() {
                if let Some(old) = prev {
                    cell.clock = old.clock;
                }
            }
            if ply == failed_ply || changed || prev_unsure {
                cell.unsure = true;
            }
            cells.push(cell);
        }

        // Stop if the correction left every token up to and including `failed_ply` unchanged
        // (including returning the exact same token at `failed_ply` without fixing an earlier move).
        let same_at_failed = cells.get(failed_ply).map(|c| c.token.as_str())
            == prev_cells.get(failed_ply).map(|c| c.token.as_str());
        let same_prefix = failed_ply <= cells.len()
            && cells[..failed_ply]
                .iter()
                .zip(prev_cells[..failed_ply].iter())
                .all(|(a, b)| a.token == b.token);
        if same_at_failed && same_prefix {
            return build_stopped(replay.moves, &prev_cells);
        }
    }
}

pub(crate) async fn read_scoresheet(
    read: ScoresheetReadInput,
    ticket: Option<String>,
    state: &crate::AppState,
    window: &str,
) -> Result<ScoresheetGame, CoachError> {
    let coach = coach(state)?;
    let ticket = ticket
        .filter(|value| !value.trim().is_empty())
        .ok_or(CoachError::InvalidInput)?;
    read.validate()?;
    let ScoresheetReadInput {
        connection,
        model,
        effort,
        photos,
    } = read;

    let slot = coach.scoresheet_reads.take_key(window.to_owned())?;
    let operation = state
        .operations
        .claim_read(&ticket, window, "scoresheet_read")
        .map_err(|error| match error {
            crate::error::Error::Cancellation => CoachError::Cancelled,
            _ => CoachError::InvalidInput,
        })?;
    let backend = coach.backend(connection).await?;
    let cancellation = operation.token();

    let workflow = async move {
        let _slot = slot;
        Ok(run_scoresheet_read(
            backend.as_ref(),
            &model,
            effort.as_deref(),
            photos,
            &cancellation,
            TURN_DEADLINE,
        )
        .await)
    };
    crate::infra::operations::run_native_operation(operation, "scoresheet_read", workflow)
        .await
        .map_err(|error| match error {
            crate::error::Error::Cancellation => CoachError::Cancelled,
            _ => CoachError::ProviderFailure,
        })?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coach::{
        backend::{RoundFailure, RoundRequest},
        turn::tests::{text, ScriptedBackend},
        TurnSlots,
    };
    use async_trait::async_trait;
    use base64::Engine as _;
    use serde_json::json;
    use std::sync::Arc;

    fn valid_jpeg_data_url() -> String {
        let bytes = [0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F'];
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn row_bounds_reject_zero_repeats_and_above_300_while_skipped_rows_become_two_unreadable_cells()
    {
        // Row number 0 is malformed.
        assert!(parse_reply(
            r#"{"status":"ok","moves":[{"n":0,"white":"e4","black":"e5"}]}"#,
            true
        )
        .is_none());
        // Repeated row number is malformed.
        assert!(parse_reply(
            r#"{"status":"ok","moves":[{"n":1,"white":"e4","black":"e5"},{"n":1,"white":"Nf3","black":"Nc6"}]}"#,
            true
        )
        .is_none());
        // Row number above 300 is malformed.
        assert!(parse_reply(
            r#"{"status":"ok","moves":[{"n":301,"white":"e4","black":"e5"}]}"#,
            true
        )
        .is_none());
        // Overlong move token (> 12 chars) is malformed.
        assert!(parse_reply(
            r#"{"status":"ok","moves":[{"n":1,"white":"1234567890123","black":"e5"}]}"#,
            true
        )
        .is_none());

        // Skipped row 2 produces two unreadable `?` cells at plies 2 and 3.
        let parsed = parse_reply(
            r#"{"status":"ok","moves":[{"n":1,"white":"e4","black":"e5"},{"n":3,"white":"Bb5","black":"a6"}]}"#,
            true,
        )
        .expect("valid reply");
        let cells = rows_to_initial_cells(&parsed.rows);
        let tokens: Vec<&str> = cells.iter().map(|c| c.token.as_str()).collect();
        assert_eq!(tokens, ["e4", "e5", "?", "?", "Bb5", "a6"]);
    }

    #[test]
    fn header_cleaning_strips_control_chars_and_validates_date_result_and_elo() {
        let reply = json!({
            "status": "ok",
            "headers": {
                "white": "  Carlsen,\nMagnus\t ",
                "black": "Caruana\r",
                "event": "World Championship",
                "site": "London",
                "date": "2018.11.??",
                "round": "1",
                "result": "1/2-1/2",
                "whiteElo": "2835",
                "blackElo": "28325"
            },
            "moves": [{"n": 1, "white": "e4", "black": "e5"}]
        })
        .to_string();
        let parsed = parse_reply(&reply, true).unwrap();
        assert_eq!(parsed.headers.white, "Carlsen,Magnus");
        assert_eq!(parsed.headers.black, "Caruana");
        assert_eq!(parsed.headers.date, "2018.11.??");
        assert_eq!(parsed.headers.result, "1/2-1/2");
        assert_eq!(parsed.headers.white_elo, "2835");
        // 5-digit Elo is dropped.
        assert_eq!(parsed.headers.black_elo, "");

        // Bad date and bad result fall back to "" and "*".
        let bad = json!({
            "status": "ok",
            "headers": {
                "date": "2018-11-09",
                "result": "White wins",
                "whiteElo": "abc"
            },
            "moves": [{"n": 1, "white": "e4"}]
        })
        .to_string();
        let parsed = parse_reply(&bad, true).unwrap();
        assert_eq!(parsed.headers.date, "");
        assert_eq!(parsed.headers.result, "*");
        assert_eq!(parsed.headers.white_elo, "");
    }

    #[tokio::test]
    async fn illegal_move_is_repaired_in_a_correction_round_and_marked_unsure() {
        let round1 = json!({
            "status": "ok",
            "headers": { "white": "Alice", "black": "Bob", "result": "1-0" },
            "moves": [
                { "n": 1, "white": "e4", "black": "e5", "unsure": [] },
                { "n": 2, "white": "Ke3", "black": "Nc6", "unsure": [] }
            ]
        })
        .to_string();
        let round2 = json!({
            "status": "ok",
            "moves": [
                { "n": 2, "white": "Nf3", "black": "Nc6", "unsure": [] }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&round1), text(&round2)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("repaired game");

        assert_eq!(game.headers.white, "Alice");
        assert_eq!(game.headers.result, "1-0");
        assert!(game.stopped.is_none());
        assert_eq!(
            game.moves,
            vec![
                ScoresheetMove {
                    san: "e4".into(),
                    unsure: false,
                    clock: None,
                },
                ScoresheetMove {
                    san: "e5".into(),
                    unsure: false,
                    clock: None,
                },
                // Replaced failed token -> marked unsure.
                ScoresheetMove {
                    san: "Nf3".into(),
                    unsure: true,
                    clock: None,
                },
                ScoresheetMove {
                    san: "Nc6".into(),
                    unsure: false,
                    clock: None,
                },
            ]
        );
    }

    #[tokio::test]
    async fn correction_starting_on_blacks_cell_keeps_whites_move_of_that_row() {
        let round1 = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "black": "e5" },
                { "n": 2, "white": "Nf3", "black": "Kf6" }
            ]
        })
        .to_string();
        // Correction starts on row 2 Black with empty white cell: keeps 2. Nf3!
        let round2 = json!({
            "status": "ok",
            "moves": [
                { "n": 2, "white": "", "black": "Nc6" },
                { "n": 3, "white": "Bb5", "black": "a6" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&round1), text(&round2)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("repaired game");

        let sans: Vec<&str> = game.moves.iter().map(|m| m.san.as_str()).collect();
        assert_eq!(sans, ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6"]);
        assert!(!game.moves[2].unsure);
        assert!(game.moves[3].unsure);
    }

    #[tokio::test]
    async fn unreadable_question_mark_in_the_middle_keeps_later_moves_on_their_colour_and_stops_with_failed_token_first(
    ) {
        let round1 = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "black": "e5" },
                { "n": 2, "white": "?", "black": "Nc6" },
                { "n": 3, "white": "Bb5", "black": "a6" }
            ]
        })
        .to_string();
        // Correction repeats "?" at ply 2 -> stops immediately with tokens[0] = "?".
        let round2 = json!({
            "status": "ok",
            "moves": [
                { "n": 2, "white": "?", "black": "Nc6" },
                { "n": 3, "white": "Bb5", "black": "a6" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&round1), text(&round2)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("partial game");

        let sans: Vec<&str> = game.moves.iter().map(|m| m.san.as_str()).collect();
        assert_eq!(sans, ["e4", "e5"]);
        assert_eq!(
            game.stopped,
            Some(ScoresheetStop {
                ply: 2,
                tokens: vec!["?".into(), "Nc6".into(), "Bb5".into(), "a6".into()],
                clocks: None,
            })
        );
    }

    #[tokio::test]
    async fn no_image_not_a_scoresheet_and_malformed_replies_classify_properly() {
        // no_image -> ImagesUnsupported
        let backend = ScriptedBackend::new(vec![text(r#"{"status":"no_image"}"#)]);
        assert_eq!(
            run_scoresheet_read(
                &backend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await
            .unwrap_err(),
            CoachError::ImagesUnsupported
        );

        // not_a_scoresheet -> ScoresheetUnreadable
        let backend = ScriptedBackend::new(vec![text(r#"{"status":"not_a_scoresheet"}"#)]);
        assert_eq!(
            run_scoresheet_read(
                &backend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await
            .unwrap_err(),
            CoachError::ScoresheetUnreadable
        );

        // Malformed first reply retries once and succeeds on fenced JSON in round 2.
        let fenced = "```json\n{\"status\":\"ok\",\"moves\":[{\"n\":1,\"white\":\"d4\",\"black\":\"d5\"}]}\n```";
        let backend = ScriptedBackend::new(vec![text("Sorry, I see a sheet."), text(fenced)]);
        let game = run_scoresheet_read(
            &backend,
            "m",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("repaired after malformed");
        assert_eq!(game.moves.len(), 2);

        // Four malformed replies -> ScoresheetUnreadable.
        let backend =
            ScriptedBackend::new(vec![text("bad"), text("bad"), text("bad"), text("bad")]);
        assert_eq!(
            run_scoresheet_read(
                &backend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await
            .unwrap_err(),
            CoachError::ScoresheetUnreadable
        );
    }

    #[tokio::test]
    async fn provider_failure_in_correction_round_fails_the_whole_read() {
        let round1 = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "black": "e5" },
                { "n": 2, "white": "Ke3", "black": "Nc6" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![
            text(&round1),
            Err(RoundFailure::new(CoachError::RateLimited)),
        ]);
        let err = run_scoresheet_read(
            &backend,
            "m",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert_eq!(err, CoachError::RateLimited);
    }

    #[tokio::test]
    async fn cancelled_read_and_deadline_exceeded_return_expected_codes() {
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let backend = ScriptedBackend::new(vec![]);
        assert_eq!(
            run_scoresheet_read(
                &backend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &cancellation,
                Duration::from_secs(10),
            )
            .await
            .unwrap_err(),
            CoachError::Cancelled
        );

        struct HangingBackend;
        #[async_trait]
        impl ModelBackend for HangingBackend {
            async fn round(
                &self,
                _request: RoundRequest<'_>,
                _on_text: &mut crate::coach::backend::TextSink<'_>,
                cancellation: &CancellationToken,
            ) -> Result<crate::coach::backend::Round, RoundFailure> {
                cancellation.cancelled().await;
                Err(RoundFailure::new(CoachError::Cancelled))
            }
        }

        assert_eq!(
            run_scoresheet_read(
                &HangingBackend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &CancellationToken::new(),
                Duration::from_millis(20),
            )
            .await
            .unwrap_err(),
            CoachError::LimitExceeded
        );
    }

    #[test]
    fn slot_pool_allows_one_per_window_and_two_overall_and_releases_on_drop() {
        let slots: Arc<TurnSlots<String, MAX_SCORESHEET_READS>> = Arc::default();
        let s1 = slots.take_key("win-1".into()).expect("first window");
        assert_eq!(slots.take_key("win-1".into()).err(), Some(CoachError::Busy));
        let s2 = slots.take_key("win-2".into()).expect("second window");
        assert_eq!(slots.take_key("win-3".into()).err(), Some(CoachError::Busy));
        drop(s1);
        let _s3 = slots.take_key("win-3".into()).expect("slot released");
        drop(s2);
    }

    #[test]
    fn input_validation_enforces_photo_count_and_jpeg_data_url() {
        let conn = CoachConnectionHandle("conn-1".into());
        // Empty photos -> InvalidInput.
        assert_eq!(
            ScoresheetReadInput {
                connection: conn.clone(),
                model: "m".into(),
                effort: None,
                photos: vec![],
            }
            .validate()
            .err(),
            Some(CoachError::InvalidInput)
        );
        // 5 photos -> InvalidInput.
        assert_eq!(
            ScoresheetReadInput {
                connection: conn.clone(),
                model: "m".into(),
                effort: None,
                photos: vec![valid_jpeg_data_url(); 5],
            }
            .validate()
            .err(),
            Some(CoachError::InvalidInput)
        );
        // PNG data URL -> InvalidInput (only JPEG allowed).
        let png_url = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest")
        );
        assert_eq!(
            ScoresheetReadInput {
                connection: conn.clone(),
                model: "m".into(),
                effort: None,
                photos: vec![png_url],
            }
            .validate()
            .err(),
            Some(CoachError::InvalidInput)
        );
        // Valid JPEG -> Ok.
        assert!(ScoresheetReadInput {
            connection: conn,
            model: "m".into(),
            effort: Some("medium".into()),
            photos: vec![valid_jpeg_data_url()],
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn move_number_with_space_in_cell_resolves_as_move() {
        assert_eq!(cell_token("1. e4"), "e4");
        assert_eq!(cell_token("12... Nf6"), "Nf6");
        let parsed = parse_reply(
            r#"{"status":"ok","moves":[{"n":1,"white":"1. e4","black":"1... e5"}]}"#,
            true,
        )
        .expect("valid reply");
        let cells = rows_to_initial_cells(&parsed.rows);
        let replay = replay_cells(&cells);
        assert!(replay.failed.is_none());
        let sans: Vec<&str> = replay.moves.iter().map(|m| m.san.as_str()).collect();
        assert_eq!(sans, ["e4", "e5"]);
    }

    #[tokio::test]
    async fn model_flagged_unsure_cells_and_correction_changing_non_failed_ply_are_marked_unsure() {
        let round1 = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "black": "e5", "unsure": ["white"] },
                { "n": 2, "white": "Nf3", "black": "Nc6", "unsure": ["black"] },
                { "n": 3, "white": "Bxc6", "black": "dxc6" }
            ]
        })
        .to_string();
        // Ply 4 ("Bxc6") is illegal because White played Nf3, not Bb5; correction changes non-failed
        // ply 2 (2. Nf3 -> 2. Bb5? No: 1. e4 e5 2. Bb5 Nc6 3. Bxc6 dxc6) so ply 2 becomes unsure via `changed`.
        let round2 = json!({
            "status": "ok",
            "moves": [
                { "n": 2, "white": "Bb5", "black": "Nc6", "unsure": [] },
                { "n": 3, "white": "Bxc6", "black": "dxc6", "unsure": [] }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&round1), text(&round2)]);
        let game = run_scoresheet_read(
            &backend,
            "m",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("repaired game");
        assert!(game.stopped.is_none());
        assert_eq!(
            game.moves,
            vec![
                // Model-flagged white on row 1.
                ScoresheetMove {
                    san: "e4".into(),
                    unsure: true,
                    clock: None,
                },
                ScoresheetMove {
                    san: "e5".into(),
                    unsure: false,
                    clock: None,
                },
                // Non-failed ply 2 changed from Nf3 to Bb5 by correction -> marked unsure.
                ScoresheetMove {
                    san: "Bb5".into(),
                    unsure: true,
                    clock: None,
                },
                // Model-flagged black on row 2 preserved across correction.
                ScoresheetMove {
                    san: "Nc6".into(),
                    unsure: true,
                    clock: None,
                },
                // Failed ply 4 -> marked unsure.
                ScoresheetMove {
                    san: "Bxc6".into(),
                    unsure: true,
                    clock: None,
                },
                ScoresheetMove {
                    san: "dxc6".into(),
                    unsure: false,
                    clock: None,
                },
            ]
        );
    }

    #[tokio::test]
    async fn zero_legal_moves_exhausted_rounds_and_unusable_corrections_behave_as_specified() {
        // Zero legal moves (empty moves list) -> ScoresheetUnreadable.
        let backend = ScriptedBackend::new(vec![text(r#"{"status":"ok","moves":[]}"#)]);
        assert_eq!(
            run_scoresheet_read(
                &backend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await
            .unwrap_err(),
            CoachError::ScoresheetUnreadable
        );

        // Zero legal moves when ply 0 fails and correction repeats -> ScoresheetUnreadable.
        let bad_first = json!({
            "status": "ok",
            "moves": [{ "n": 1, "white": "Ke3", "black": "e5" }]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&bad_first), text(&bad_first)]);
        assert_eq!(
            run_scoresheet_read(
                &backend,
                "m",
                None,
                vec![valid_jpeg_data_url()],
                &CancellationToken::new(),
                Duration::from_secs(10),
            )
            .await
            .unwrap_err(),
            CoachError::ScoresheetUnreadable
        );

        // Rounds exhausted (4 rounds each changing the illegal move) -> legal prefix + stopped.
        let r = |tok: &str| {
            json!({
                "status": "ok",
                "moves": [
                    { "n": 1, "white": "e4", "black": "e5" },
                    { "n": 2, "white": tok, "black": "Nc6" }
                ]
            })
            .to_string()
        };
        let backend = ScriptedBackend::new(vec![
            text(&r("Ke3")),
            text(&r("Kd3")),
            text(&r("Kf3")),
            text(&r("Qa5")),
        ]);
        let game = run_scoresheet_read(
            &backend,
            "m",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("stopped after 4 rounds");
        assert_eq!(game.moves.len(), 2);
        assert_eq!(
            game.stopped,
            Some(ScoresheetStop {
                ply: 2,
                tokens: vec!["Qa5".into(), "Nc6".into()],
                clocks: None,
            })
        );

        // Unusable correction reply (malformed JSON) -> legal prefix + stopped.
        let backend = ScriptedBackend::new(vec![text(&r("Ke3")), text("not json at all")]);
        let game = run_scoresheet_read(
            &backend,
            "m",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("stopped on malformed correction");
        assert_eq!(game.moves.len(), 2);
        assert_eq!(
            game.stopped,
            Some(ScoresheetStop {
                ply: 2,
                tokens: vec!["Ke3".into(), "Nc6".into()],
                clocks: None,
            })
        );

        // Unusable correction reply (empty moves -> rows_to_correction_slice None) -> legal prefix + stopped.
        let backend =
            ScriptedBackend::new(vec![text(&r("Ke3")), text(r#"{"status":"ok","moves":[]}"#)]);
        let game = run_scoresheet_read(
            &backend,
            "m",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("stopped on empty correction");
        assert_eq!(game.moves.len(), 2);
        assert_eq!(
            game.stopped,
            Some(ScoresheetStop {
                ply: 2,
                tokens: vec!["Ke3".into(), "Nc6".into()],
                clocks: None,
            })
        );
    }

    #[test]
    fn clock_parser_matches_o1_rule_and_rejects_malformed_or_out_of_range() {
        for (input, expected) in [
            ("86", 5160),
            (" 86 ", 5160),
            ("1:26", 5160),
            ("1:26:30", 5190),
            ("0:59", 3540),
            ("600", 36_000),
            ("10:00", 36_000),
            ("10:00:00", 36_000),
            ("0", 0),
        ] {
            assert_eq!(parse_clock_str(input), Some(expected), "input {input:?}");
        }

        let nine_400 = "9".repeat(400);
        let zero_400 = "0".repeat(400);
        for invalid in [
            "",
            "   ",
            "\t\n",
            "601",
            "10:00:01",
            "1:60",
            "1:00:60",
            "1:5",
            "1:005",
            "abc",
            "-5",
            "1.5",
            "1:20:30:40",
            "1 : 26",
            nine_400.as_str(),
            zero_400.as_str(),
        ] {
            assert_eq!(parse_clock_str(invalid), None, "invalid {invalid:?}");
        }

        assert_eq!(parse_clock_cell(Some(&json!(86))), Some(5160));
        assert_eq!(parse_clock_cell(Some(&json!(0))), Some(0));
        assert_eq!(parse_clock_cell(Some(&json!(600))), Some(36_000));
        assert_eq!(parse_clock_cell(Some(&json!(601))), None);
        assert_eq!(parse_clock_cell(Some(&json!(-5))), None);
        assert_eq!(parse_clock_cell(Some(&json!(1.5))), None);
        assert_eq!(parse_clock_cell(Some(&json!(true))), None);
        assert_eq!(parse_clock_cell(Some(&json!(["86"]))), None);
        assert_eq!(parse_clock_cell(Some(&json!({"m": 86}))), None);
        assert_eq!(parse_clock_cell(Some(&Value::Null)), None);
        assert_eq!(parse_clock_cell(None), None);
    }

    #[tokio::test]
    async fn reply_with_clocks_parses_strings_and_numbers_and_drops_garbage_without_failing() {
        let reply = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "whiteClock": "86", "black": "e5", "blackClock": 86 },
                { "n": 2, "white": "Nf3", "whiteClock": "1:26", "black": "Nc6", "blackClock": "garbage" },
                { "n": 3, "white": "Bb5", "whiteClock": "601", "black": "a6", "blackClock": { "bad": true } }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&reply)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("read succeeds with garbage clocks dropped");

        let clocks: Vec<Option<u32>> = game.moves.iter().map(|m| m.clock).collect();
        assert_eq!(
            clocks,
            vec![Some(5160), Some(5160), Some(5160), None, None, None]
        );
        assert!(game.moves.iter().all(|m| !m.unsure));

        // Absent clock is omitted when serializing ScoresheetMove.
        let serialized = serde_json::to_value(&game.moves[3]).expect("serialize");
        assert!(serialized.get("clock").is_none());
    }

    #[tokio::test]
    async fn correction_round_preserves_old_clock_for_unchanged_token_and_uses_new_clock_for_changed_token(
    ) {
        let round1 = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "whiteClock": "90", "black": "e5", "blackClock": "89" },
                { "n": 2, "white": "Ke3", "whiteClock": "88", "black": "Nc6", "blackClock": "87" },
                { "n": 3, "white": "Bb5", "whiteClock": "86", "black": "a6", "blackClock": "85" }
            ]
        })
        .to_string();
        // Correction changes 2. Ke3 -> 2. Nf3 (with new clock "84"), keeps 2... Nc6 without clock
        // (keeps old "87"), keeps 3. Bb5 with updated clock "83", and changes 3... a6 -> 3... Nf6
        // without clock (takes None, not old "85").
        let round2 = json!({
            "status": "ok",
            "moves": [
                { "n": 2, "white": "Nf3", "whiteClock": "84", "black": "Nc6" },
                { "n": 3, "white": "Bb5", "whiteClock": "83", "black": "Nf6" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&round1), text(&round2)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("repaired game");

        let clocks: Vec<Option<u32>> = game.moves.iter().map(|m| m.clock).collect();
        assert_eq!(
            clocks,
            vec![
                Some(5400), // 1. e4 kept
                Some(5340), // 1... e5 kept
                Some(5040), // 2. Nf3 changed -> took correction's "84"
                Some(5220), // 2... Nc6 unchanged & no clock -> kept old "87"
                Some(4980), // 3. Bb5 unchanged & new clock -> took "83"
                None,       // 3... Nf6 changed & no clock -> None
            ]
        );
    }

    #[tokio::test]
    async fn stopped_read_returns_parallel_clocks_for_remaining_tokens() {
        let round1 = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "whiteClock": "90", "black": "e5", "blackClock": "89" },
                { "n": 2, "white": "?", "black": "Nc6", "blackClock": "87" },
                { "n": 3, "white": "Bb5", "whiteClock": "1:26", "black": "a6" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&round1), text(&round1)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("stopped game");

        assert_eq!(
            game.stopped,
            Some(ScoresheetStop {
                ply: 2,
                tokens: vec!["?".into(), "Nc6".into(), "Bb5".into(), "a6".into()],
                clocks: Some(vec![None, Some(5220), Some(5160), None]),
            })
        );
    }

    #[test]
    fn plausibility_marks_rises_above_60s_unsure_except_on_moves_40_41_60_61() {
        // Build 62 full moves (124 plies) with legal placeholder moves.
        let make_moves = || -> Vec<ScoresheetMove> {
            (0..124)
                .map(|_| ScoresheetMove {
                    san: "Nf3".into(),
                    unsure: false,
                    clock: None,
                })
                .collect()
        };

        // Rise of 60 s is plausible; rise of 61 s is implausible and keeps the value.
        let mut basic = make_moves();
        basic[0].clock = Some(5000); // White move 1
        basic[2].clock = Some(5060); // White move 2 (+60 s -> ok)
        basic[4].clock = Some(5121); // White move 3 (+61 s -> unsure)
        basic[1].clock = Some(4000); // Black move 1
        basic[3].clock = Some(4200); // Black move 2 (+200 s -> unsure)
        mark_implausible_clocks(&mut basic);
        assert!(!basic[0].unsure);
        assert!(!basic[2].unsure);
        assert!(basic[4].unsure);
        assert_eq!(basic[4].clock, Some(5121));
        assert!(!basic[1].unsure);
        assert!(basic[3].unsure);
        assert_eq!(basic[3].clock, Some(4200));

        // Test boundary move numbers for White (even plies) and Black (odd plies):
        // move 39 -> marked unsure; move 40 -> exempt; move 41 -> exempt; move 42 -> marked unsure;
        // move 60 -> exempt; move 61 -> exempt; move 62 -> marked unsure.
        for side in 0..=1usize {
            for (move_num, expect_unsure) in [
                (39usize, true),
                (40, false),
                (41, false),
                (42, true),
                (60, false),
                (61, false),
                (62, true),
            ] {
                let mut moves = make_moves();
                let prev_ply = (move_num - 2) * 2 + side;
                let curr_ply = (move_num - 1) * 2 + side;
                moves[prev_ply].clock = Some(600);
                moves[curr_ply].clock = Some(2400); // +1800 s period bonus
                mark_implausible_clocks(&mut moves);
                assert_eq!(
                    moves[curr_ply].unsure, expect_unsure,
                    "side={side} move={move_num}"
                );
                assert_eq!(moves[curr_ply].clock, Some(2400));
            }
        }
    }

    #[tokio::test]
    async fn run_scoresheet_read_marks_implausible_clock_rise_unsure_in_complete_and_stopped_reads()
    {
        // (a) Complete read: White's clock jumps from 80 min (4800 s) to 82 min (4920 s) on move 2.
        let complete = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "whiteClock": "80", "black": "e5", "blackClock": "80" },
                { "n": 2, "white": "Nf3", "whiteClock": "82", "black": "Nc6", "blackClock": "79" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&complete)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("complete read");
        assert!(game.stopped.is_none());
        assert!(!game.moves[0].unsure);
        assert!(game.moves[2].unsure);
        assert_eq!(game.moves[2].clock, Some(4920));
        assert!(!game.moves[3].unsure);

        // (b) Stopped read: same implausible rise on move 2, followed by unreadable "?" on move 3.
        let stopped = json!({
            "status": "ok",
            "moves": [
                { "n": 1, "white": "e4", "whiteClock": "80", "black": "e5", "blackClock": "80" },
                { "n": 2, "white": "Nf3", "whiteClock": "82", "black": "Nc6", "blackClock": "79" },
                { "n": 3, "white": "?", "whiteClock": "78", "black": "a6", "blackClock": "77" }
            ]
        })
        .to_string();
        let backend = ScriptedBackend::new(vec![text(&stopped), text(&stopped)]);
        let game = run_scoresheet_read(
            &backend,
            "vision-model",
            None,
            vec![valid_jpeg_data_url()],
            &CancellationToken::new(),
            Duration::from_secs(10),
        )
        .await
        .expect("stopped read");
        assert!(game.stopped.is_some());
        assert!(!game.moves[0].unsure);
        assert!(game.moves[2].unsure);
        assert_eq!(game.moves[2].clock, Some(4920));
        assert!(!game.moves[3].unsure);
    }
}
