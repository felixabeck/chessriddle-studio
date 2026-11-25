//! Game, player and tournament listing commands and their query types.

use super::*;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum Sides {
    BlackWhite,
    WhiteBlack,
    Any,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum GameSort {
    #[default]
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "newest")]
    Newest,
    #[serde(rename = "whiteElo")]
    WhiteElo,
    #[serde(rename = "blackElo")]
    BlackElo,
    #[serde(rename = "plyCount")]
    PlyCount,
    #[serde(rename = "white")]
    White,
    #[serde(rename = "black")]
    Black,
    #[serde(rename = "result")]
    Result,
    #[serde(rename = "event")]
    Event,
    #[serde(rename = "site")]
    Site,
}

#[derive(Default, Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash, Type)]
pub enum SortDirection {
    #[serde(rename = "asc")]
    Asc,
    #[default]
    #[serde(rename = "desc")]
    Desc,
}

#[derive(Default, Debug, Clone, Deserialize, PartialEq, Eq, Hash, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryOptions<SortT> {
    pub skip_count: bool,
    #[specta(optional)]
    pub page: Option<i32>,
    #[specta(optional)]
    pub page_size: Option<i32>,
    pub sort: SortT,
    pub direction: SortDirection,
}

pub(super) const MAX_PAGE_SIZE: i32 = 1000;

// Bound single player and event name searches in Unicode characters.
pub(super) const MAX_NAME_SEARCH_CHARS: usize = 256;

pub(super) fn validate_name_search(name: &str) -> Result<(), Error> {
    if name.chars().take(MAX_NAME_SEARCH_CHARS + 1).count() > MAX_NAME_SEARCH_CHARS {
        return Err(Error::InvalidInput(format!(
            "name search must contain at most {MAX_NAME_SEARCH_CHARS} characters"
        )));
    }
    Ok(())
}

pub(super) fn like_contains_pattern(normalized: &str) -> String {
    let mut pattern = String::from("%");
    for character in normalized.chars() {
        if matches!(character, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

// Player-name searches accept at most 16 tokens of 128 Unicode characters each.
// Reject excess input rather than silently dropping part of the predicate.
pub(super) const MAX_PLAYER_NAME_TOKENS: usize = 16;
pub(super) const MAX_PLAYER_NAME_TOKEN_CHARS: usize = 128;

pub(super) fn player_name_patterns(query: &str) -> Result<Vec<String>, Error> {
    let mut patterns = Vec::new();
    for token in query
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|token| !token.is_empty())
    {
        if patterns.len() == MAX_PLAYER_NAME_TOKENS {
            return Err(Error::InvalidInput(format!(
                "player name query must contain at most {MAX_PLAYER_NAME_TOKENS} tokens"
            )));
        }
        if token.chars().take(MAX_PLAYER_NAME_TOKEN_CHARS + 1).count() > MAX_PLAYER_NAME_TOKEN_CHARS
        {
            return Err(Error::InvalidInput(format!(
                "player name tokens must contain at most {MAX_PLAYER_NAME_TOKEN_CHARS} characters"
            )));
        }
        patterns.push(like_contains_pattern(&name_identity::normalize_name(token)));
    }
    Ok(patterns)
}

pub(super) fn pagination_limit_offset(
    page: Option<i32>,
    page_size: Option<i32>,
) -> Result<(Option<i64>, Option<i64>), Error> {
    if let Some(page_size) = page_size {
        if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
            return Err(Error::InvalidInput(format!(
                "page size must be between 1 and {MAX_PAGE_SIZE}"
            )));
        }
    }

    if let Some(page) = page {
        if page < 1 {
            return Err(Error::InvalidInput("page must be at least 1".into()));
        }
    }

    let limit = page_size.map(i64::from);
    let offset = page.map(|page| (i64::from(page) - 1) * page_size.map(i64::from).unwrap_or(10));

    Ok((limit, offset))
}

/// List filters for `get_games`. Unknown keys are rejected.
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameListQuery {
    #[specta(optional)]
    pub options: Option<QueryOptions<GameSort>>,
    #[specta(optional)]
    pub player1: Option<i32>,
    #[specta(optional)]
    pub player2: Option<i32>,
    #[specta(optional)]
    pub player_name: Option<String>,
    #[specta(optional)]
    pub tournament_id: Option<i32>,
    #[specta(optional)]
    pub start_date: Option<String>,
    #[specta(optional)]
    pub end_date: Option<String>,
    #[specta(optional)]
    pub range1: Option<(i32, i32)>,
    #[specta(optional)]
    pub range2: Option<(i32, i32)>,
    #[specta(optional)]
    pub sides: Option<Sides>,
    #[specta(optional)]
    pub outcome: Option<String>,
}

impl From<GameListQuery> for GameQuery {
    fn from(query: GameListQuery) -> Self {
        Self {
            options: query.options,
            player1: query.player1,
            player2: query.player2,
            player_name: query.player_name,
            tournament_id: query.tournament_id,
            start_date: query.start_date,
            end_date: query.end_date,
            range1: query.range1,
            range2: query.range2,
            sides: query.sides,
            outcome: query.outcome,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq, Hash, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameQuery {
    #[specta(optional)]
    pub options: Option<QueryOptions<GameSort>>,
    #[specta(optional)]
    pub player1: Option<i32>,
    #[specta(optional)]
    pub player2: Option<i32>,
    #[specta(optional)]
    pub player_name: Option<String>,
    #[specta(optional)]
    pub tournament_id: Option<i32>,
    #[specta(optional)]
    pub start_date: Option<String>,
    #[specta(optional)]
    pub end_date: Option<String>,
    #[specta(optional)]
    pub range1: Option<(i32, i32)>,
    #[specta(optional)]
    pub range2: Option<(i32, i32)>,
    #[specta(optional)]
    pub sides: Option<Sides>,
    #[specta(optional)]
    pub outcome: Option<String>,
    #[specta(optional)]
    pub position: Option<PositionQueryJs>,
    #[specta(optional)]
    pub wanted_result: Option<String>,
    #[specta(optional)]
    pub exclude_fast_events: Option<bool>,
    #[specta(optional)]
    pub include_unknown_results: Option<bool>,
    #[specta(optional)]
    pub sample_order: Option<SampleOrder>,
    /// Position search only: allow-list of verbatim `TimeControl` values, where
    /// "" also matches a missing value. `None` applies no filter.
    #[specta(optional)]
    pub time_controls: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq, Hash, Type)]
#[serde(rename_all = "lowercase")]
pub enum SampleOrder {
    Elo,
    Date,
}

impl GameQuery {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn position(mut self, position: PositionQueryJs) -> Self {
        self.position = Some(position);
        self
    }
}

#[derive(Debug, Clone, Serialize, Type)]
pub struct QueryResponse<T> {
    pub data: T,
    pub count: Option<i32>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_games(
    file: DatabaseHandle,
    query: GameListQuery,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_games")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_games", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_games_blocking(&authority, &repository, file, query.into(), token)
            })
            .await
    })
    .await
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GameSignature {
    pub white: Option<String>,
    pub black: Option<String>,
    pub event: Option<String>,
    pub site: Option<String>,
    pub date: Option<String>,
    pub round: Option<String>,
}

#[derive(Clone, Copy)]
pub(super) enum SignatureNormalization {
    Name,
    Date,
    Plain,
}

#[derive(Clone, Copy)]
pub(super) enum SignatureField {
    White,
    Black,
    Event,
    Site,
    Date,
    Round,
}

impl SignatureField {
    pub(super) const ALL: [Self; 6] = [
        Self::White,
        Self::Black,
        Self::Event,
        Self::Site,
        Self::Date,
        Self::Round,
    ];

    pub(super) fn column(self) -> (&'static str, SignatureNormalization) {
        match self {
            Self::White => ("w.Name", SignatureNormalization::Name),
            Self::Black => ("b.Name", SignatureNormalization::Name),
            Self::Event => ("e.Name", SignatureNormalization::Name),
            Self::Site => ("s.Name", SignatureNormalization::Name),
            Self::Date => ("g.Date", SignatureNormalization::Date),
            Self::Round => ("g.Round", SignatureNormalization::Plain),
        }
    }

    pub(super) fn normalize(self, value: &Option<String>) -> Option<String> {
        let (_, kind) = self.column();
        value
            .as_ref()
            .filter(|value| !kind.markers().any(|marker| marker == value.as_str()))
            .cloned()
    }

    pub(super) fn normalized_sql(self) -> String {
        let (column, kind) = self.column();
        kind.markers()
            .fold(column.to_owned(), |expression, marker| {
                format!("NULLIF({expression}, '{marker}')")
            })
    }
}

impl SignatureNormalization {
    pub(super) fn markers(self) -> impl Iterator<Item = &'static str> {
        GameSignature::ABSENT_MARKERS.into_iter().chain(match self {
            Self::Name => Some(GameSignature::ABSENT_NAME),
            Self::Date => Some(GameSignature::ABSENT_DATE),
            Self::Plain => None,
        })
    }
}

impl GameSignature {
    const ABSENT_MARKERS: [&'static str; 2] = ["", "?"];
    pub(super) const ABSENT_DATE: &'static str = "????.??.??";
    const ABSENT_NAME: &'static str = "Unknown";

    pub(super) fn normalized(&self) -> Self {
        Self {
            white: SignatureField::White.normalize(&self.white),
            black: SignatureField::Black.normalize(&self.black),
            event: SignatureField::Event.normalize(&self.event),
            site: SignatureField::Site.normalize(&self.site),
            date: SignatureField::Date.normalize(&self.date),
            round: SignatureField::Round.normalize(&self.round),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Type)]
pub struct LinkedGameIdentity {
    pub locator: linked_collections::LinkedGameLocator,
    pub signature: GameSignature,
}

#[derive(Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DbGameLookup {
    Found { game: Box<NormalizedGame> },
    Missing,
}

#[tauri::command]
#[specta::specta]
pub async fn get_db_game(
    file: DatabaseHandle,
    game_id: i32,
    linked: Option<LinkedGameIdentity>,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<DbGameLookup, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_db_game")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_db_game", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_db_game_blocking(
                    &authority,
                    &repository,
                    file,
                    game_id,
                    linked.as_ref(),
                    token,
                )
            })
            .await
    })
    .await
}

pub(super) fn get_db_game_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    game_id: i32,
    linked: Option<&LinkedGameIdentity>,
    cancellation: &CancellationToken,
) -> Result<DbGameLookup, Error> {
    cancellation_check(cancellation)?;
    if !authority.with_mut(|authority| authority.has_persistent_id(&file.path_ref().id))? {
        return Ok(DbGameLookup::Missing);
    }
    // Resolve collections first so a lost disposable cache can be rebuilt. Ordinary databases
    // still require an existing file target before opening a connection.
    let target = match resolve_database(authority, &file, PathOperation::DatabaseRead) {
        Ok(target) => target,
        Err(error) if error.is_missing_entry() => return Ok(DbGameLookup::Missing),
        Err(error) => return Err(error),
    };
    let mut connection =
        match get_db_or_create(repository, &target, Some(cancellation), authority, &file) {
            Ok(connection) => connection,
            Err(error) if error.is_missing_entry() => return Ok(DbGameLookup::Missing),
            Err(error) => return Err(error),
        };
    connection.transaction::<_, Error, _>(|db| {
        let id = if let Some(identity) = linked {
            match linked_collections::recent_game_id(
                db,
                &file,
                authority,
                identity,
                game_id,
                cancellation,
            )? {
                Some(id) => id,
                None => return Ok(DbGameLookup::Missing),
            }
        } else {
            game_id
        };
        let rows = load_games(
            db,
            authority,
            &file,
            GameQuery::new(),
            Some(id),
            cancellation,
        )?;
        Ok(match rows.data.into_iter().next() {
            Some(game) => DbGameLookup::Found {
                game: Box::new(game),
            },
            None => DbGameLookup::Missing,
        })
    })
}

pub(super) type EloBandExpr<QS> =
    Box<dyn BoxableExpression<QS, Sqlite, SqlType = Nullable<diesel::sql_types::Bool>>>;

/// `col BETWEEN lo AND hi`, treating SQL NULL as unrated 0. The column is
/// compared directly so `games_white_elo_idx` / `games_black_elo_idx` stay
/// usable; `OR col IS NULL` is emitted only when the band contains 0.
pub(super) fn elo_band<C, QS>(col: C, (lo, hi): (i32, i32)) -> EloBandExpr<QS>
where
    C: diesel::expression::Expression<SqlType = Nullable<Integer>>
        + SelectableExpression<QS>
        + QueryFragment<Sqlite>
        + ValidGrouping<(), IsAggregate = diesel::expression::is_aggregate::No>
        + Copy
        + Send
        + 'static,
    QS: 'static,
{
    let band = col.between(lo, hi);
    if lo <= 0 && 0 <= hi {
        Box::new(band.or(col.is_null()))
    } else {
        Box::new(band)
    }
}

pub(super) fn sides_any_elo_band_predicate<QS>(
    player1: Option<i32>,
    range1: Option<(i32, i32)>,
    range2: Option<(i32, i32)>,
) -> Option<EloBandExpr<QS>>
where
    QS: 'static,
    games::white_id: SelectableExpression<QS>,
    games::black_id: SelectableExpression<QS>,
    games::white_elo: SelectableExpression<QS>,
    games::black_elo: SelectableExpression<QS>,
{
    if range1.is_none() && range2.is_none() {
        return None;
    }

    let white_as_player = {
        let mut terms: Vec<EloBandExpr<QS>> = Vec::new();
        if let Some(range) = range1 {
            terms.push(elo_band(games::white_elo, range));
        }
        if let Some(range) = range2 {
            terms.push(elo_band(games::black_elo, range));
        }
        let band = terms
            .into_iter()
            .reduce(|acc, term| Box::new(acc.and(term)) as EloBandExpr<QS>)?;
        match player1 {
            Some(id) => Box::new(band.and(games::white_id.eq(id))) as EloBandExpr<QS>,
            None => band,
        }
    };
    let black_as_player = {
        let mut terms: Vec<EloBandExpr<QS>> = Vec::new();
        if let Some(range) = range1 {
            terms.push(elo_band(games::black_elo, range));
        }
        if let Some(range) = range2 {
            terms.push(elo_band(games::white_elo, range));
        }
        let band = terms
            .into_iter()
            .reduce(|acc, term| Box::new(acc.and(term)) as EloBandExpr<QS>)?;
        match player1 {
            Some(id) => Box::new(band.and(games::black_id.eq(id))) as EloBandExpr<QS>,
            None => band,
        }
    };
    Some(Box::new(white_as_player.or(black_as_player)))
}

pub(super) fn get_games_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    query: GameQuery,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    load_games(db, authority, &file, query, None, cancellation)
}

// Read only by the Unix-gated `db::tests`.
#[cfg(all(test, unix))]
thread_local! {
    /// The last game page query `load_games` built on this thread, so tests can check its plan.
    static LAST_GAME_PAGE_SQL: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

#[cfg(all(test, unix))]
pub(super) fn take_last_game_page_sql() -> Option<String> {
    LAST_GAME_PAGE_SQL.with(|last| last.borrow_mut().take())
}

/// The game index a name sort can walk in name order, joined from its name table.
pub(super) fn name_sort_index(sort: &GameSort) -> Option<&'static str> {
    match sort {
        GameSort::White => Some("games_white_idx"),
        GameSort::Black => Some("games_black_idx"),
        GameSort::Event => Some("games_event_idx"),
        GameSort::Site => Some("games_site_idx"),
        _ => None,
    }
}

/// Whether a filter fixes the sorted key, which puts every match at one name, where a walk
/// would pass every game sorted before it.
pub(super) fn pins_sorted_key(sort: &GameSort, query: &GameQuery) -> bool {
    match (sort, &query.sides) {
        (GameSort::White, Some(Sides::WhiteBlack)) => query.player1.is_some(),
        (GameSort::White, Some(Sides::BlackWhite)) => query.player2.is_some(),
        (GameSort::Black, Some(Sides::WhiteBlack)) => query.player2.is_some(),
        (GameSort::Black, Some(Sides::BlackWhite)) => query.player1.is_some(),
        (GameSort::Event, _) => query.tournament_id.is_some(),
        _ => false,
    }
}

/// Measured on 12.4M games: sorting all matches costs 0.8 µs (0.7M date-window matches) to
/// 2.8 µs (every game) per match, while walking a name index costs about 4 µs per game it
/// passes. The walk passes roughly `(offset + limit) * games / matches` games before it fills
/// the page and assumes matches spread over the names. A wrong walk costs far more than a wrong
/// sort, so the ratio takes the cheapest measured sort.
const NAME_INDEX_WALK_COST_RATIO: f64 = 5.0;

/// Whether walking the name index beats sorting every match for this page. Without a page
/// limit or without the index, the sort always runs.
pub(super) fn name_index_walk_is_cheaper(
    db: &mut SqliteConnection,
    index: &str,
    matches: i64,
    limit: Option<i64>,
    offset: Option<i64>,
    cancellation: &CancellationToken,
) -> Result<bool, Error> {
    #[derive(QueryableByName)]
    struct WalkInputs {
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        indexed: i64,
        #[diesel(sql_type = diesel::sql_types::BigInt)]
        games: i64,
    }
    let Some(limit) = limit else {
        return Ok(false);
    };
    if matches == 0 {
        return Ok(false);
    }
    let inputs = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
        diesel::sql_query(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?)
                 AS indexed,
             COALESCE((SELECT MAX(ID) FROM Games), 0) AS games",
        )
        .bind::<Text, _>(index)
        .get_result::<WalkInputs>(db)
    })?;
    if inputs.indexed == 0 {
        return Ok(false);
    }
    let passed = (offset.unwrap_or(0) + limit) as f64 * inputs.games as f64 / matches as f64;
    Ok(passed * NAME_INDEX_WALK_COST_RATIO < matches as f64)
}

pub(super) fn load_games(
    db: &mut SqliteConnection,
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: &DatabaseHandle,
    query: GameQuery,
    game_id: Option<i32>,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<NormalizedGame>>, Error> {
    db.transaction::<_, Error, _>(|db| {
        let query_options = query.options.clone().unwrap_or_default();
        let name_patterns = query
            .player_name
            .as_deref()
            .map(player_name_patterns)
            .transpose()?;

        // The count and the page share one filter set.
        macro_rules! filter_games {
            ($games:expr) => {{
                let mut filtered = $games;
                if let Some(id) = game_id {
                    filtered = filtered.filter(games::id.eq(id));
                }
                for pattern in name_patterns.iter().flatten() {
                    let matching_players = players::table
                        .filter(
                            name_identity::normalized_name(players::name)
                                .like(pattern.clone())
                                .escape('\\'),
                        )
                        .select(players::id);
                    filtered = filtered.filter(
                        games::white_id
                            .eq_any(matching_players.clone())
                            .or(games::black_id.eq_any(matching_players)),
                    );
                }
                if let Some(outcome) = &query.outcome {
                    filtered = filtered.filter(games::result.eq(outcome.clone()));
                }
                if let Some(start_date) = &query.start_date {
                    filtered = filtered
                        .filter(search::date_interval_endpoint_sql(false).ge(start_date.clone()));
                }
                if let Some(end_date) = &query.end_date {
                    filtered = filtered
                        .filter(search::date_interval_endpoint_sql(true).le(end_date.clone()));
                }
                if let Some(tournament_id) = query.tournament_id {
                    filtered = filtered.filter(games::event_id.eq(tournament_id));
                }
                match query.sides {
                    Some(Sides::BlackWhite) => {
                        if let Some(player1) = query.player1 {
                            filtered = filtered.filter(games::black_id.eq(player1));
                        }
                        if let Some(player2) = query.player2 {
                            filtered = filtered.filter(games::white_id.eq(player2));
                        }
                        if let Some(range1) = query.range1 {
                            filtered = filtered.filter(elo_band(games::black_elo, range1));
                        }
                        if let Some(range2) = query.range2 {
                            filtered = filtered.filter(elo_band(games::white_elo, range2));
                        }
                    }
                    Some(Sides::WhiteBlack) => {
                        if let Some(player1) = query.player1 {
                            filtered = filtered.filter(games::white_id.eq(player1));
                        }
                        if let Some(player2) = query.player2 {
                            filtered = filtered.filter(games::black_id.eq(player2));
                        }
                        if let Some(range1) = query.range1 {
                            filtered = filtered.filter(elo_band(games::white_elo, range1));
                        }
                        if let Some(range2) = query.range2 {
                            filtered = filtered.filter(elo_band(games::black_elo, range2));
                        }
                    }
                    Some(Sides::Any) => {
                        if let Some(player1) = query.player1 {
                            filtered = filtered.filter(
                                games::white_id.eq(player1).or(games::black_id.eq(player1)),
                            );
                        }
                        if let Some(player2) = query.player2 {
                            filtered = filtered.filter(
                                games::white_id.eq(player2).or(games::black_id.eq(player2)),
                            );
                        }
                        if let Some(predicate) =
                            sides_any_elo_band_predicate(query.player1, query.range1, query.range2)
                        {
                            filtered = filtered.filter(predicate);
                        }
                    }
                    None => {}
                }
                filtered
            }};
        }

        let (limit, offset) = pagination_limit_offset(query_options.page, query_options.page_size)?;
        let name_index = name_sort_index(&query_options.sort);
        // A name sort needs the match count to choose its plan, even when the caller skips it.
        let matches = if !query_options.skip_count || name_index.is_some() {
            let count_query = filter_games!(games::table.into_boxed());
            Some(sqlite_cancellation::with_sqlite_cancellation(
                cancellation,
                || {
                    count_query
                        .select(diesel::dsl::count(games::id))
                        .first::<i64>(db)
                },
            )?)
        } else {
            None
        };
        let walk_name_index = match (name_index, matches) {
            (Some(index), Some(matches)) if !pins_sorted_key(&query_options.sort, &query) => {
                name_index_walk_is_cheaper(db, index, matches, limit, offset, cancellation)?
            }
            _ => false,
        };
        // A unary plus on the name table's key stops SQLite from looking that row up per game,
        // so it walks the name index in order and stops after the page instead of sorting every
        // match. Only the joined table of the requested sort gets it.
        let join_key = |sort: GameSort, key: &str| {
            let walk = walk_name_index && query_options.sort == sort;
            diesel::dsl::sql::<Integer>(&format!("{}{key}", if walk { "+" } else { "" }))
        };

        let (white_players, black_players) = diesel::alias!(players as white, players as black);
        let mut sql_query = filter_games!(games::table
            .inner_join(white_players.on(games::white_id.eq(join_key(GameSort::White, "white.ID"))))
            .inner_join(black_players.on(games::black_id.eq(join_key(GameSort::Black, "black.ID"))))
            .inner_join(
                events::table.on(games::event_id.eq(join_key(GameSort::Event, "Events.ID")))
            )
            .inner_join(sites::table.on(games::site_id.eq(join_key(GameSort::Site, "Sites.ID"))))
            .into_boxed());
        if let Some(limit) = limit {
            sql_query = sql_query.limit(limit);
        }
        if let Some(offset) = offset {
            sql_query = sql_query.offset(offset);
        }

        // Order by the requested key(s), then the game ID in the same direction so pages
        // partition ties deterministically and index walks match plain sorts.
        macro_rules! order_by_then_id {
            ($($column:expr),+) => {
                match query_options.direction {
                    SortDirection::Asc => sql_query.order(($($column.asc(),)+ games::id.asc())),
                    SortDirection::Desc => sql_query.order(($($column.desc(),)+ games::id.desc())),
                }
            };
        }
        sql_query = match query_options.sort {
            GameSort::Id => match query_options.direction {
                SortDirection::Asc => sql_query.order(games::id.asc()),
                SortDirection::Desc => sql_query.order(games::id.desc()),
            },
            GameSort::Date => order_by_then_id!(games::date, games::time),
            // This sort is always newest first, independently of the legacy direction option.
            GameSort::Newest => sql_query.order((
                diesel::dsl::sql::<Text>(&format!(
                    "REPLACE({}, '?', '0')",
                    pgn_date::canonical_sql("COALESCE(Games.Date, '')")
                ))
                .desc(),
                games::time.desc(),
                games::id.desc(),
            )),
            GameSort::WhiteElo => order_by_then_id!(games::white_elo),
            GameSort::BlackElo => order_by_then_id!(games::black_elo),
            GameSort::PlyCount => order_by_then_id!(games::ply_count),
            // games_result_idx already holds (Result, ID) in order.
            GameSort::Result => order_by_then_id!(games::result),
            GameSort::White => order_by_then_id!(
                white_players.field(players::name),
                white_players.field(players::id)
            ),
            GameSort::Black => order_by_then_id!(
                black_players.field(players::name),
                black_players.field(players::id)
            ),
            GameSort::Event => order_by_then_id!(events::name, events::year, events::id),
            GameSort::Site => order_by_then_id!(sites::name, sites::id),
        };
        let count = matches.filter(|_| !query_options.skip_count);
        #[cfg(all(test, unix))]
        LAST_GAME_PAGE_SQL.with(|last| {
            *last.borrow_mut() =
                Some(diesel::debug_query::<diesel::sqlite::Sqlite, _>(&sql_query).to_string())
        });

        // println!(
        //     "{:?}\n",
        //     diesel::debug_query::<diesel::sqlite::Sqlite, _>(&sql_query)
        // );

        let games: Vec<(Game, Player, Player, Event, Site)> =
            sqlite_cancellation::with_sqlite_cancellation(cancellation, || sql_query.load(db))?;
        cancellation_check(cancellation)?;
        let mut normalized_games = normalize_games(games, cancellation)?;
        linked_collections::qualify_games(db, file, authority, &mut normalized_games)?;

        Ok(QueryResponse {
            data: normalized_games,
            count: count.map(|c| c as i32),
        })
    })
}

pub(super) const OWNER_INFERENCE_SAMPLE_CAP: i64 = 500;
pub(super) const OWNER_INFERENCE_MIN_GAMES: usize = 10;
pub(super) const OWNER_INFERENCE_THRESHOLD_PERCENT: usize = 80;

#[tauri::command]
#[specta::specta]
pub async fn infer_game_orientation(
    file: DatabaseHandle,
    game_id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<BoardOrientation>, Error> {
    let operation = state.operations.accept("infer_game_orientation")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(
        operation,
        "infer_game_orientation",
        async move {
            BLOCKING_GATEWAY
                .spawn_cancellable(cancellation, move |token| {
                    infer_game_orientation_blocking(&authority, &repository, file, game_id, token)
                })
                .await
        },
    )
    .await
}

pub(super) fn infer_game_orientation_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    game_id: i32,
    cancellation: &CancellationToken,
) -> Result<Option<BoardOrientation>, Error> {
    cancellation_check(cancellation)?;
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;
    let mut connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    linked_collections::read_snapshot(&mut connection, authority, &file, |db| {
        sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            infer_owner_orientation(db, game_id)
        })
    })
}

pub(super) fn infer_owner_orientation(
    db: &mut SqliteConnection,
    game_id: i32,
) -> Result<Option<BoardOrientation>, Error> {
    let (white_id, black_id) = games::table
        .find(game_id)
        .select((games::white_id, games::black_id))
        .first::<(i32, i32)>(db)
        .optional()?
        .ok_or_else(|| Error::GameNotFound(game_id.to_string()))?;
    let mut eligible = |id| -> Result<bool, Error> {
        if id == 0 {
            return Ok(false);
        }
        let name = players::table
            .find(id)
            .select(players::name)
            .first::<Option<String>>(db)
            .optional()?
            .flatten();
        Ok(name.is_some_and(|name| !matches!(name.trim(), "" | "?" | "Unknown")))
    };
    if !eligible(black_id)? {
        return Ok(None);
    }
    let white_eligible = eligible(white_id)?;
    // The primary-key walk reads only this bounded sample, with no player index required.
    let sample = games::table
        .select((games::white_id, games::black_id))
        .order(games::id.desc())
        .limit(OWNER_INFERENCE_SAMPLE_CAP)
        .load::<(i32, i32)>(db)?;
    if sample.len() < OWNER_INFERENCE_MIN_GAMES {
        return Ok(None);
    }
    let dominant = |id| {
        sample
            .iter()
            .filter(|(white, black)| *white == id || *black == id)
            .count()
            * 100
            >= sample.len() * OWNER_INFERENCE_THRESHOLD_PERCENT
    };
    Ok(
        (dominant(black_id) && !(white_eligible && dominant(white_id)))
            .then_some(BoardOrientation::Black),
    )
}

/// Hash the stored row, independently of joined names and decoded movetext.
pub(super) fn game_row_stamp(game: &Game) -> String {
    use sha2::{Digest, Sha256};

    fn field(hash: &mut Sha256, value: Option<&[u8]>) {
        match value {
            None => hash.update([0]),
            Some(bytes) => {
                hash.update([1]);
                hash.update((bytes.len() as u64).to_be_bytes());
                hash.update(bytes);
            }
        }
    }
    let mut hash = Sha256::new();
    macro_rules! integer {
        ($value:expr) => {
            field(&mut hash, Some(&$value.to_be_bytes()))
        };
    }
    macro_rules! optional_integer {
        ($value:expr) => {
            field(
                &mut hash,
                $value
                    .map(i32::to_be_bytes)
                    .as_ref()
                    .map(|bytes| bytes.as_slice()),
            )
        };
    }
    macro_rules! text {
        ($value:expr) => {
            field(&mut hash, $value.as_deref().map(str::as_bytes))
        };
    }
    integer!(game.id);
    integer!(game.event_id);
    integer!(game.site_id);
    text!(game.date);
    text!(game.time);
    text!(game.round);
    integer!(game.white_id);
    optional_integer!(game.white_elo);
    integer!(game.black_id);
    optional_integer!(game.black_elo);
    integer!(game.white_material);
    integer!(game.black_material);
    text!(game.result);
    text!(game.time_control);
    text!(game.eco);
    optional_integer!(game.ply_count);
    text!(game.fen);
    field(&mut hash, Some(&game.moves));
    integer!(game.pawn_home);
    // Preserve the exact pre-orientation stamp for existing, unset rows.
    if game.orientation.is_some() {
        text!(game.orientation);
    }
    format!("{:x}", hash.finalize())
}

pub(super) fn normalize_games(
    games: Vec<(Game, Player, Player, Event, Site)>,
    cancellation: &CancellationToken,
) -> Result<Vec<NormalizedGame>, Error> {
    games
        .into_iter()
        .map(|(game, white, black, event, site)| {
            cancellation_check(cancellation)?;
            let stamp = game_row_stamp(&game);
            let fen: Fen = game
                .fen
                .map(|f| {
                    Fen::from_ascii(f.as_bytes()).map_err(|error| {
                        Error::InvalidInput(format!("game {} has invalid FEN: {error}", game.id))
                    })
                })
                .transpose()?
                .unwrap_or_default();
            let game_result = game.result.clone().unwrap_or_default();
            let result_token = if game_result.is_empty() {
                "*".to_string()
            } else {
                game_result.clone()
            };

            Ok(NormalizedGame {
                orientation: game
                    .orientation
                    .as_deref()
                    .and_then(BoardOrientation::from_pgn),
                stamp: Some(stamp),
                linked: None,
                id: game.id,
                event: event.name.unwrap_or_default(),
                event_id: event.id,
                site: site.name.unwrap_or_default(),
                site_id: site.id,
                date: game.date,
                time: game.time,
                round: game.round,
                white: white.name.unwrap_or_default(),
                white_id: game.white_id,
                white_elo: game.white_elo,
                black: black.name.unwrap_or_default(),
                black_id: game.black_id,
                black_elo: game.black_elo,
                result: Outcome::from_str(&game_result).unwrap_or_default(),
                time_control: game.time_control,
                eco: game.eco,
                ply_count: game.ply_count,
                fen: fen.to_string(),
                moves: {
                    let movetext =
                        decode_game_to_movetext_cancellable(&game.moves, fen, cancellation)?;
                    cancellation_check(cancellation)?;
                    if movetext.is_empty() {
                        result_token
                    } else {
                        format!("{} {}", movetext, result_token)
                    }
                },
            })
        })
        .collect()
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlayerQuery {
    pub options: QueryOptions<PlayerSort>,
    #[specta(optional)]
    pub name: Option<String>,
    #[specta(optional)]
    pub name_match: Option<PlayerNameMatch>,
    #[specta(optional)]
    pub range: Option<(i32, i32)>,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PlayerNameMatch {
    Contains,
    Exact,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum PlayerSort {
    #[serde(rename = "id")]
    Id,
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "elo")]
    Elo,
    #[serde(rename = "games")]
    Games,
}

#[tauri::command]
#[specta::specta]
pub async fn get_player(
    file: DatabaseHandle,
    id: i32,
    state: tauri::State<'_, AppState>,
) -> Result<Option<Player>, Error> {
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_accepted_blocking(&state.operations, "get_player", move || {
        get_player_blocking(&authority, &repository, file, id)
    })
    .await
}

pub(super) fn get_player_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    id: i32,
) -> Result<Option<Player>, Error> {
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection = get_db_or_create(repository, &target, None, authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let player = players::table
            .filter(players::id.eq(id))
            .first::<Player>(db)
            .optional()?;
        Ok(player)
    })
}

#[tauri::command]
#[specta::specta]
pub async fn get_players(
    file: DatabaseHandle,
    query: PlayerQuery,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<Player>>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_players")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_players", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_players_blocking(&authority, &repository, file, query, token)
            })
            .await
    })
    .await
}

pub(super) fn get_players_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    query: PlayerQuery,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<Player>>, Error> {
    cancellation_check(cancellation)?;
    if let Some(name) = &query.name {
        validate_name_search(name)?;
    }
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let mut count: Option<i64> = None;

        let mut sql_query = players::table.into_boxed();
        let mut count_query = players::table.into_boxed();
        let mut count_with_rows = false;
        for marker in SignatureNormalization::Name.markers() {
            sql_query = sql_query.filter(players::name.is_not(marker));
            count_query = count_query.filter(players::name.is_not(marker));
        }

        if let Some(name) = query.name {
            if name.is_empty() && !matches!(query.name_match, Some(PlayerNameMatch::Exact)) {
                sql_query = sql_query.filter(players::name.is_not_null());
                count_query = count_query.filter(players::name.is_not_null());
            } else {
                count_with_rows = !query.options.skip_count;
                let (predicate, value, escape) = match query.name_match {
                    Some(PlayerNameMatch::Exact) => (
                        "normalized_name(Name) = ",
                        name_identity::normalize_name(&name),
                        "",
                    ),
                    _ => (
                        "normalized_name(Name) LIKE ",
                        like_contains_pattern(&name_identity::normalize_name(&name)),
                        " ESCAPE '\\'",
                    ),
                };
                let name_filter = diesel::dsl::sql::<diesel::sql_types::Bool>(predicate)
                    .bind::<diesel::sql_types::Text, _>(value)
                    .sql(escape);
                // Resolve matching IDs through the narrow Name projection before sorting.
                // Otherwise SQLite scans the entire game-count index even for one match.
                let matching_players = diesel::alias!(players as matching_players);
                sql_query = sql_query.filter(
                    players::id.eq_any(
                        matching_players
                            .select(matching_players.field(players::id))
                            .filter(name_filter.clone()),
                    ),
                );
                count_query = count_query.filter(name_filter);
            }
        }

        if let Some(range) = query.range {
            sql_query = sql_query.filter(players::elo.between(range.0, range.1));
            count_query = count_query.filter(players::elo.between(range.0, range.1));
        }

        let (limit, offset) = pagination_limit_offset(query.options.page, query.options.page_size)?;
        if let Some(limit) = limit {
            sql_query = sql_query.limit(limit);
        }

        if let Some(offset) = offset {
            sql_query = sql_query.offset(offset);
        }

        sql_query = match query.options.sort {
            PlayerSort::Id => match query.options.direction {
                SortDirection::Asc => sql_query.order(players::id.asc()),
                SortDirection::Desc => sql_query.order(players::id.desc()),
            },
            PlayerSort::Name => match query.options.direction {
                SortDirection::Asc => sql_query.order((players::name.asc(), players::id.asc())),
                SortDirection::Desc => sql_query.order((players::name.desc(), players::id.desc())),
            },
            PlayerSort::Elo => match query.options.direction {
                SortDirection::Asc => sql_query.order((players::elo.asc(), players::id.asc())),
                SortDirection::Desc => sql_query.order((players::elo.desc(), players::id.desc())),
            },
            PlayerSort::Games => match query.options.direction {
                SortDirection::Asc => sql_query.order((
                    players::game_count.asc(),
                    players::name.asc(),
                    players::id.asc(),
                )),
                SortDirection::Desc => sql_query.order((
                    players::game_count.desc(),
                    players::name.asc(),
                    players::id.asc(),
                )),
            },
        };

        let players = if count_with_rows {
            // Share the filtered scan with pagination's count. Keep the separate
            // count for unfiltered pages so their LIMIT can use the count index.
            let rows = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
                sql_query
                    .select((
                        players::all_columns,
                        diesel::dsl::sql::<diesel::sql_types::BigInt>("COUNT(*) OVER ()"),
                    ))
                    .load::<(Player, i64)>(db)
            })?;
            count = rows.first().map(|(_, total)| *total);
            if rows.is_empty() && offset.unwrap_or(0) == 0 {
                count = Some(0);
            }
            rows.into_iter().map(|(player, _)| player).collect()
        } else {
            sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
                sql_query.load::<Player>(db)
            })?
        };
        if !query.options.skip_count && count.is_none() {
            count = Some(sqlite_cancellation::with_sqlite_cancellation(
                cancellation,
                || count_query.count().get_result(db),
            )?);
        }
        cancellation_check(cancellation)?;

        Ok(QueryResponse {
            data: players,
            count: count.map(|c| c as i32),
        })
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub enum TournamentSort {
    #[serde(rename = "name")]
    Name,
    #[serde(rename = "date")]
    Date,
    #[serde(rename = "players")]
    Players,
    #[serde(rename = "games")]
    Games,
    #[serde(rename = "avgElo")]
    AvgElo,
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TournamentQuery {
    pub options: QueryOptions<TournamentSort>,
    pub name: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn get_tournaments(
    file: DatabaseHandle,
    query: TournamentQuery,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<QueryResponse<Vec<TournamentEvent>>, Error> {
    let operation = crate::native_read_operation(ticket, &window, &state, "get_tournaments")?;
    let cancellation = operation.token();
    let authority = state.pgn_path_authority.clone();
    let repository = Arc::clone(&state.database_repository);
    crate::infra::operations::run_native_operation(operation, "get_tournaments", async move {
        BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                get_tournaments_blocking(&authority, &repository, file, query, token)
            })
            .await
    })
    .await
}

pub(super) fn get_tournaments_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    repository: &DatabaseRepository,
    file: DatabaseHandle,
    query: TournamentQuery,
    cancellation: &CancellationToken,
) -> Result<QueryResponse<Vec<TournamentEvent>>, Error> {
    cancellation_check(cancellation)?;
    if let Some(name) = &query.name {
        validate_name_search(name)?;
    }
    let target = resolve_database(authority, &file, PathOperation::DatabaseRead)?;

    let mut database_connection =
        get_db_or_create(repository, &target, Some(cancellation), authority, &file)?;
    let db = &mut *database_connection;
    linked_collections::read_snapshot(db, authority, &file, |db| {
        let mut count: Option<i64> = None;

        let mut sql_query = events::table
            .left_join(sites::table.on(events::site_id.eq(sites::id).and(sites::id.ne(0))))
            .select((
                events::id,
                events::name,
                events::start_date,
                events::end_date,
                sites::name.nullable(),
                events::player_count,
                events::game_count,
                events::avg_elo,
            ))
            .into_boxed();
        let mut count_query = events::table.into_boxed();
        for marker in SignatureNormalization::Name.markers() {
            sql_query = sql_query.filter(events::name.is_not(marker));
            count_query = count_query.filter(events::name.is_not(marker));
        }

        if let Some(name) = query.name {
            let pattern = like_contains_pattern(&name_identity::normalize_name(&name));
            sql_query = sql_query.filter(
                name_identity::normalized_name(events::name)
                    .like(pattern.clone())
                    .escape('\\'),
            );
            count_query = count_query.filter(
                name_identity::normalized_name(events::name)
                    .like(pattern)
                    .escape('\\'),
            );
        }

        if !query.options.skip_count {
            count = Some(sqlite_cancellation::with_sqlite_cancellation(
                cancellation,
                || count_query.count().get_result(db),
            )?);
        }

        let (limit, offset) = pagination_limit_offset(query.options.page, query.options.page_size)?;
        if let Some(limit) = limit {
            sql_query = sql_query.limit(limit);
        }

        if let Some(offset) = offset {
            sql_query = sql_query.offset(offset);
        }

        // Every sort keeps NULL last in either direction. Numeric and date
        // sorts use ascending Name/ID ties across page boundaries.
        macro_rules! order_by {
            (date $column:literal) => {
                order_by!(diesel::dsl::sql::<Nullable<Text>>(concat!(
                    "REPLACE(",
                    $column,
                    ", '?', '0')"
                )))
            };
            ($column:expr) => {
                match query.options.direction {
                    SortDirection::Asc => sql_query.order((
                        $column.is_null().asc(),
                        $column.asc(),
                        events::name.is_null().asc(),
                        events::name.asc(),
                        events::id.asc(),
                    )),
                    SortDirection::Desc => sql_query.order((
                        $column.is_null().asc(),
                        $column.desc(),
                        events::name.is_null().asc(),
                        events::name.asc(),
                        events::id.asc(),
                    )),
                }
            };
        }
        sql_query = match query.options.sort {
            TournamentSort::Name => match query.options.direction {
                SortDirection::Asc => sql_query.order((
                    events::name.is_null().asc(),
                    events::name.asc(),
                    events::year.desc(),
                    events::id.asc(),
                )),
                SortDirection::Desc => sql_query.order((
                    events::name.is_null().asc(),
                    events::name.desc(),
                    events::year.desc(),
                    events::id.asc(),
                )),
            },
            TournamentSort::Date => match query.options.direction {
                SortDirection::Asc => order_by!(date "Events.StartDate"),
                // Recurring events are newest at their latest game, not their first.
                SortDirection::Desc => order_by!(date "Events.EndDate"),
            },
            TournamentSort::Players => order_by!(events::player_count),
            TournamentSort::Games => order_by!(events::game_count),
            TournamentSort::AvgElo => order_by!(events::avg_elo),
        };

        let events = sqlite_cancellation::with_sqlite_cancellation(cancellation, || {
            sql_query.load::<TournamentEvent>(db)
        })?;
        cancellation_check(cancellation)?;

        Ok(QueryResponse {
            data: events,
            count: count.map(|c| c as i32),
        })
    })
}
