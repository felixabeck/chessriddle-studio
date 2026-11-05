use crate::error::Error;
use diesel::{
    connection::SimpleConnection,
    prelude::*,
    sql_query,
    sql_types::{BigInt, Integer, Nullable, Text},
};

const CURRENT_DATABASE_VERSION: &str = "2.1.0";
const PRE_ORIENTATION_DATABASE_VERSION: &str = "2.0.0";
const LEGACY_DATABASE_VERSION: &str = "1.0.0";
const CREATE_TABLES_SQL: &str = include_str!("create.sql");

#[cfg(test)]
thread_local! {
    static CONTENT_PRAGMA_COUNTS: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}

#[cfg(test)]
pub(super) fn take_content_pragma_counts() -> (usize, usize) {
    CONTENT_PRAGMA_COUNTS.with(|counts| counts.replace((0, 0)))
}

#[derive(QueryableByName)]
struct CountRow {
    #[diesel(sql_type = BigInt)]
    count: i64,
}

#[derive(QueryableByName)]
struct TextRow {
    #[diesel(sql_type = Text)]
    value: String,
}

#[derive(QueryableByName)]
struct NullableTextRow {
    #[diesel(sql_type = Nullable<Text>)]
    value: Option<String>,
}

#[derive(QueryableByName)]
struct DetailedColumnInfo {
    #[diesel(sql_type = Integer)]
    cid: i32,
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    column_type: String,
    #[diesel(sql_type = Integer, column_name = is_not_null)]
    notnull: i32,
    #[diesel(sql_type = Nullable<Text>)]
    default_value: Option<String>,
    #[diesel(sql_type = Integer)]
    pk: i32,
}

#[derive(QueryableByName)]
struct ForeignKeyInfo {
    #[diesel(sql_type = Integer, column_name = id)]
    id: i32,
    #[diesel(sql_type = Integer, column_name = seq)]
    seq: i32,
    #[diesel(sql_type = Text, column_name = database_table)]
    table: String,
    #[diesel(sql_type = Text, column_name = from_column)]
    from: String,
    #[diesel(sql_type = Text, column_name = to_column)]
    to: String,
    #[diesel(sql_type = Text, column_name = on_update)]
    on_update: String,
    #[diesel(sql_type = Text, column_name = on_delete)]
    on_delete: String,
    #[diesel(sql_type = Text, column_name = match_name)]
    match_name: String,
}

#[derive(QueryableByName)]
struct IndexListInfo {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Integer, column_name = is_unique)]
    unique: i32,
    #[diesel(sql_type = Text, column_name = origin_name)]
    origin: String,
}

#[derive(QueryableByName)]
struct IndexColumnInfo {
    #[diesel(sql_type = Integer, column_name = seqno)]
    seqno: i32,
    #[diesel(sql_type = Text)]
    name: String,
}

#[derive(QueryableByName)]
struct TriggerInfo {
    #[diesel(sql_type = Text)]
    name: String,
    #[diesel(sql_type = Text)]
    sql: String,
}

#[cfg(test)]
#[derive(QueryableByName, Debug, PartialEq)]
struct MigratedGame {
    #[diesel(sql_type = Integer, column_name = "ID")]
    id: i32,
    #[diesel(sql_type = Nullable<Text>, column_name = "Round")]
    round: Option<String>,
    #[diesel(sql_type = Nullable<Text>, column_name = "Result")]
    result: Option<String>,
    #[diesel(sql_type = Integer, column_name = "PawnHome")]
    pawn_home: i32,
}

/// Creates a complete database or upgrades an existing supported database.
///
/// An empty SQLite file is safe to retry after an interrupted first creation because
/// the complete DDL and metadata marker are committed in one transaction. Any other
/// partial schema is rejected instead of being mistaken for a usable database.
#[cfg(test)]
pub fn prepare_database(
    conn: &mut SqliteConnection,
    title: &str,
    description: &str,
) -> Result<bool, Error> {
    Ok(prepare_database_with_validation(conn, title, description)?.0)
}

/// Returns (created, content_validated). The second flag is true only when both
/// content pragmas ran, so publication can follow the outermost commit.
pub fn prepare_database_with_validation(
    conn: &mut SqliteConnection,
    title: &str,
    description: &str,
) -> Result<(bool, bool), Error> {
    let table_count = non_internal_table_count(conn)?;
    if table_count == 0 {
        initialize_database(conn, title, description)?;
        return Ok((true, true));
    }

    Ok((false, migrate_database(conn)?))
}

pub(super) fn uninitialized_database_error() -> Error {
    Error::InvalidInput("Database has not been initialized yet".into())
}

/// Verifies an existing database before it is handed to an ordinary command.
/// Creation is intentionally excluded: only the import command has the title
/// and description required to initialize a new database.
/// Returns true only when migration ran both content pragmas; false means only
/// the cheap schema contract was checked.
pub fn validate_existing_database(conn: &mut SqliteConnection) -> Result<bool, Error> {
    if non_internal_table_count(conn)? == 0 {
        return Err(uninitialized_database_error());
    }
    migrate_database(conn)
}

fn non_internal_table_count(conn: &mut SqliteConnection) -> Result<i64, Error> {
    Ok(sql_query(
        "SELECT COUNT(*) AS count FROM sqlite_master \
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .get_result::<CountRow>(conn)?
    .count)
}

fn initialize_database(
    conn: &mut SqliteConnection,
    title: &str,
    description: &str,
) -> Result<(), Error> {
    conn.transaction::<_, Error, _>(|conn| {
        conn.batch_execute(CREATE_TABLES_SQL)?;
        insert_info(conn, "Title", title)?;
        insert_info(conn, "Description", description)?;
        // Version is the commit marker: readers only accept a database after this
        // row exists, and this is deliberately the last mutation in the transaction.
        insert_info(conn, "Version", CURRENT_DATABASE_VERSION)?;
        validate_database(conn)?;
        Ok(())
    })
}

fn migrate_database(conn: &mut SqliteConnection) -> Result<bool, Error> {
    if !table_exists(conn, "Info")? || !table_exists(conn, "Games")? {
        return Err(Error::InvalidInput(
            "Database schema is incomplete; refusing to use a partial database".into(),
        ));
    }

    let version = info_value(conn, "Version")?.ok_or_else(|| {
        Error::InvalidInput(
            "Database schema has no Version marker; refusing partial database".into(),
        )
    })?;
    let canonical = games_schema_is_canonical(conn)?;

    match (version.as_str(), canonical) {
        (CURRENT_DATABASE_VERSION, true) => validate_schema(conn).map(|()| false),
        (LEGACY_DATABASE_VERSION, _) => migrate_legacy_database(conn).map(|()| true),
        (PRE_ORIENTATION_DATABASE_VERSION, _) => conn.transaction::<_, Error, _>(|conn| {
            validate_games_schema_version(conn, false)?;
            validate_reference_schema(conn)?;
            validate_sentinel_records_and_triggers(conn)?;
            conn.batch_execute(
                "ALTER TABLE Games ADD COLUMN Orientation TEXT \
                 CHECK(Orientation IN ('white', 'black') OR Orientation IS NULL);",
            )?;
            insert_info(conn, "Version", CURRENT_DATABASE_VERSION)?;
            validate_database(conn)?;
            Ok(true)
        }),
        (CURRENT_DATABASE_VERSION, false) => Err(Error::InvalidInput(
            "Database Version does not match its Games schema".into(),
        )),
        _ => Err(Error::InvalidInput(format!(
            "Unsupported database version {version}"
        ))),
    }
}

fn migrate_legacy_database(conn: &mut SqliteConnection) -> Result<(), Error> {
    let restore_required_indexes = super::check_index_exists(conn)?;
    conn.transaction::<_, Error, _>(|conn| {
        // Ensure legacy nullable foreign keys can be normalized to the sentinel.
        conn.batch_execute(
            "INSERT OR IGNORE INTO Players (ID, Name, Elo) VALUES (0, 'Unknown', NULL);\
             INSERT OR IGNORE INTO Events (ID, Name) VALUES (0, 'Unknown');\
             INSERT OR IGNORE INTO Sites (ID, Name) VALUES (0, 'Unknown');",
        )?;
        conn.batch_execute(
            "CREATE TABLE Games__canonical (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                EventID INTEGER NOT NULL DEFAULT 0,
                SiteID INTEGER NOT NULL DEFAULT 0,
                Date TEXT,
                UTCTime TEXT,
                Round TEXT,
                WhiteID INTEGER NOT NULL DEFAULT 0,
                WhiteElo INTEGER,
                BlackID INTEGER NOT NULL DEFAULT 0,
                BlackElo INTEGER,
                WhiteMaterial INTEGER,
                BlackMaterial INTEGER,
                Result TEXT CHECK(Result IN ('1-0', '0-1', '1/2-1/2', '*') OR Result IS NULL),
                TimeControl TEXT,
                ECO TEXT,
                PlyCount INTEGER,
                FEN TEXT,
                Moves BLOB,
                PawnHome INTEGER NOT NULL DEFAULT 0,
                Orientation TEXT CHECK(Orientation IN ('white', 'black') OR Orientation IS NULL),
                FOREIGN KEY(EventID) REFERENCES Events(ID),
                FOREIGN KEY(SiteID) REFERENCES Sites(ID),
                FOREIGN KEY(WhiteID) REFERENCES Players(ID),
                FOREIGN KEY(BlackID) REFERENCES Players(ID)
            );
            INSERT INTO Games__canonical (
                ID, EventID, SiteID, Date, UTCTime, Round, WhiteID, WhiteElo,
                BlackID, BlackElo, WhiteMaterial, BlackMaterial, Result,
                TimeControl, ECO, PlyCount, FEN, Moves, PawnHome
            )
            SELECT
                ID, COALESCE(EventID, 0), COALESCE(SiteID, 0), Date, UTCTime,
                CASE WHEN Round IS NULL THEN NULL ELSE CAST(Round AS TEXT) END,
                COALESCE(WhiteID, 0), WhiteElo, COALESCE(BlackID, 0), BlackElo,
                WhiteMaterial, BlackMaterial,
                CASE
                    WHEN Result IS NULL THEN NULL
                    WHEN CAST(Result AS TEXT) IN ('1-0', '0-1', '1/2-1/2', '*')
                        THEN CAST(Result AS TEXT)
                    ELSE '*'
                END,
                TimeControl, ECO, PlyCount, FEN, Moves,
                CAST(COALESCE(PawnHome, 0) AS INTEGER)
            FROM Games;
            DROP TABLE Games;
            ALTER TABLE Games__canonical RENAME TO Games;",
        )?;
        create_sentinel_triggers(conn)?;
        if restore_required_indexes {
            conn.batch_execute(super::INDEXES_SQL)?;
        }
        insert_info(conn, "Version", CURRENT_DATABASE_VERSION)?;
        validate_database(conn)
    })
}

fn table_exists(conn: &mut SqliteConnection, name: &str) -> Result<bool, Error> {
    Ok(
        sql_query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
            .bind::<Text, _>(name)
            .get_result::<CountRow>(conn)?
            .count
            == 1,
    )
}

fn info_value(conn: &mut SqliteConnection, name: &str) -> Result<Option<String>, Error> {
    Ok(sql_query("SELECT Value AS value FROM Info WHERE Name = ?")
        .bind::<Text, _>(name)
        .get_result::<NullableTextRow>(conn)
        .optional()?
        .and_then(|row| row.value))
}

fn insert_info(conn: &mut SqliteConnection, name: &str, value: &str) -> Result<(), Error> {
    sql_query(
        "INSERT INTO Info (Name, Value) VALUES (?, ?) \
         ON CONFLICT(Name) DO UPDATE SET Value = excluded.Value",
    )
    .bind::<Text, _>(name)
    .bind::<Text, _>(value)
    .execute(conn)?;
    Ok(())
}

fn games_schema_is_canonical(conn: &mut SqliteConnection) -> Result<bool, Error> {
    Ok(validate_games_schema(conn).is_ok())
}

fn validate_database(conn: &mut SqliteConnection) -> Result<(), Error> {
    validate_schema(conn)?;
    validate_content(conn)
}

fn validate_schema(conn: &mut SqliteConnection) -> Result<(), Error> {
    validate_games_schema(conn)?;
    validate_reference_schema(conn)?;
    validate_sentinel_records_and_triggers(conn)?;
    Ok(())
}

pub(super) fn validate_content(conn: &mut SqliteConnection) -> Result<(), Error> {
    #[cfg(test)]
    CONTENT_PRAGMA_COUNTS.with(|counts| {
        let (integrity, foreign) = counts.get();
        counts.set((integrity + 1, foreign));
    });
    let integrity: Vec<TextRow> =
        sql_query("SELECT integrity_check AS value FROM pragma_integrity_check").load(conn)?;
    let foreign_key_violations = {
        #[cfg(test)]
        CONTENT_PRAGMA_COUNTS.with(|counts| {
            let (integrity, foreign) = counts.get();
            counts.set((integrity, foreign + 1));
        });
        sql_query("SELECT COUNT(*) AS count FROM pragma_foreign_key_check")
            .get_result::<CountRow>(conn)
    };
    if integrity.iter().any(|row| row.value != "ok") {
        return Err(Error::InvalidInput("SQLite integrity_check failed".into()));
    }
    if foreign_key_violations?.count != 0 {
        return Err(Error::InvalidInput(
            "SQLite foreign_key_check failed".into(),
        ));
    }
    Ok(())
}

fn validate_games_schema(conn: &mut SqliteConnection) -> Result<(), Error> {
    validate_games_schema_version(conn, true)
}

fn validate_games_schema_version(
    conn: &mut SqliteConnection,
    with_orientation: bool,
) -> Result<(), Error> {
    let columns: Vec<DetailedColumnInfo> = sql_query(
        "SELECT cid, name, type AS column_type, \"notnull\" AS is_not_null,
                dflt_value AS default_value, pk
         FROM pragma_table_info('Games') ORDER BY cid",
    )
    .load(conn)?;
    let mut expected = vec![
        ("ID", "INTEGER", false, None, 1),
        ("EventID", "INTEGER", true, Some("0"), 0),
        ("SiteID", "INTEGER", true, Some("0"), 0),
        ("Date", "TEXT", false, None, 0),
        ("UTCTime", "TEXT", false, None, 0),
        ("Round", "TEXT", false, None, 0),
        ("WhiteID", "INTEGER", true, Some("0"), 0),
        ("WhiteElo", "INTEGER", false, None, 0),
        ("BlackID", "INTEGER", true, Some("0"), 0),
        ("BlackElo", "INTEGER", false, None, 0),
        ("WhiteMaterial", "INTEGER", false, None, 0),
        ("BlackMaterial", "INTEGER", false, None, 0),
        ("Result", "TEXT", false, None, 0),
        ("TimeControl", "TEXT", false, None, 0),
        ("ECO", "TEXT", false, None, 0),
        ("PlyCount", "INTEGER", false, None, 0),
        ("FEN", "TEXT", false, None, 0),
        ("Moves", "BLOB", false, None, 0),
        ("PawnHome", "INTEGER", true, Some("0"), 0),
    ];
    if with_orientation {
        expected.push(("Orientation", "TEXT", false, None, 0));
    }
    if columns.len() != expected.len()
        || columns
            .iter()
            .zip(expected)
            .enumerate()
            .any(|(position, (actual, expected))| {
                actual.cid as usize != position
                    || !actual.name.eq_ignore_ascii_case(expected.0)
                    || !actual.column_type.eq_ignore_ascii_case(expected.1)
                    || (actual.notnull != 0) != expected.2
                    || actual.default_value.as_deref() != expected.3
                    || actual.pk != expected.4
            })
    {
        return Err(Error::InvalidInput(
            "Games table does not match the canonical schema".into(),
        ));
    }
    let foreign_keys: Vec<ForeignKeyInfo> = sql_query(
        "SELECT id, seq, \"table\" AS database_table, \"from\" AS from_column, \"to\" AS to_column,
                on_update, on_delete, \"match\" AS match_name
         FROM pragma_foreign_key_list('Games')",
    )
    .load(conn)?;
    let expected_foreign_keys = [
        (0, "Players", "BlackID", "ID"),
        (1, "Players", "WhiteID", "ID"),
        (2, "Sites", "SiteID", "ID"),
        (3, "Events", "EventID", "ID"),
    ];
    if foreign_keys.len() != expected_foreign_keys.len()
        || expected_foreign_keys.iter().any(|expected| {
            !foreign_keys.iter().any(|actual| {
                actual.table.eq_ignore_ascii_case(expected.1)
                    && actual.id == expected.0
                    && actual.seq == 0
                    && actual.from.eq_ignore_ascii_case(expected.2)
                    && actual.to.eq_ignore_ascii_case(expected.3)
                    && actual.on_update.eq_ignore_ascii_case("NO ACTION")
                    && actual.on_delete.eq_ignore_ascii_case("NO ACTION")
                    && actual.match_name.eq_ignore_ascii_case("NONE")
            })
        })
    {
        return Err(Error::InvalidInput(
            "Games foreign-key contract is invalid".into(),
        ));
    }
    let table_sql: TextRow =
        sql_query("SELECT sql AS value FROM sqlite_master WHERE type = 'table' AND name = 'Games'")
            .get_result(conn)?;
    let sql: String = table_sql
        .value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase();
    if !sql.contains("IDINTEGERPRIMARYKEYAUTOINCREMENT") {
        return Err(Error::InvalidInput(
            "Games.ID must retain the canonical AUTOINCREMENT primary key".into(),
        ));
    }
    if !sql.contains("CHECK(RESULTIN('1-0','0-1','1/2-1/2','*')ORRESULTISNULL)") {
        return Err(Error::InvalidInput(
            "Games.Result CHECK constraint is missing".into(),
        ));
    }
    if with_orientation && !sql.contains("CHECK(ORIENTATIONIN('WHITE','BLACK')ORORIENTATIONISNULL)")
    {
        return Err(Error::InvalidInput(
            "Games.Orientation CHECK constraint is missing".into(),
        ));
    }
    Ok(())
}

type ColumnContract = (&'static str, &'static str, bool, Option<&'static str>, i32);

fn validate_reference_schema(conn: &mut SqliteConnection) -> Result<(), Error> {
    validate_exact_columns(
        conn,
        "Info",
        &[
            ("Name", "TEXT", true, None, 0),
            ("Value", "TEXT", false, None, 0),
        ],
    )?;
    validate_exact_columns(
        conn,
        "Players",
        &[
            ("ID", "INTEGER", false, None, 1),
            ("Name", "TEXT", false, None, 0),
            ("Elo", "INTEGER", false, None, 0),
        ],
    )?;
    for table in ["Events", "Sites"] {
        validate_exact_columns(
            conn,
            table,
            &[
                ("ID", "INTEGER", false, None, 1),
                ("Name", "TEXT", false, None, 0),
            ],
        )?;
    }
    for table in ["Info", "Players", "Events", "Sites"] {
        validate_single_column_unique(conn, table, "Name")?;
    }
    for table in ["Events", "Sites"] {
        let definition: TextRow =
            sql_query("SELECT sql AS value FROM sqlite_master WHERE type = 'table' AND name = ?")
                .bind::<Text, _>(table)
                .get_result(conn)?;
        if !normalize_sql(&definition.value).contains("IDINTEGERPRIMARYKEYAUTOINCREMENT") {
            return Err(Error::InvalidInput(format!(
                "{table} must retain its AUTOINCREMENT primary key"
            )));
        }
    }
    Ok(())
}

fn validate_single_column_unique(
    conn: &mut SqliteConnection,
    table: &str,
    column: &str,
) -> Result<(), Error> {
    let indexes: Vec<IndexListInfo> = sql_query(format!(
        "SELECT name, \"unique\" AS is_unique, origin AS origin_name FROM pragma_index_list('{table}')"
    ))
    .load(conn)?;
    let mut matching = 0;
    for index in indexes.into_iter().filter(|index| index.unique != 0) {
        let columns: Vec<IndexColumnInfo> = sql_query(format!(
            "SELECT seqno, name FROM pragma_index_info('{}') ORDER BY seqno",
            index.name.replace('\'', "''")
        ))
        .load(conn)?;
        if columns.len() == 1
            && columns[0].seqno == 0
            && columns[0].name.eq_ignore_ascii_case(column)
        {
            // A manually-created same-column unique index is equivalent for
            // enforcement, but the canonical DDL uses SQLite's UNIQUE
            // constraint origin, so reject lookalikes as schema drift.
            if !index.origin.eq_ignore_ascii_case("u") {
                return Err(Error::InvalidInput(format!(
                    "{table}.{column} UNIQUE constraint is not canonical"
                )));
            }
            matching += 1;
        }
    }
    if matching != 1 {
        return Err(Error::InvalidInput(format!(
            "{table} must retain exactly one UNIQUE {column} constraint"
        )));
    }
    Ok(())
}

fn normalize_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>()
        .to_ascii_uppercase()
}

fn validate_exact_columns(
    conn: &mut SqliteConnection,
    table: &str,
    expected: &[ColumnContract],
) -> Result<(), Error> {
    // `table` is exclusively an internal constant, never renderer input.
    let columns: Vec<DetailedColumnInfo> = sql_query(format!(
        "SELECT cid, name, type AS column_type, \"notnull\" AS is_not_null,
                dflt_value AS default_value, pk
         FROM pragma_table_info('{table}') ORDER BY cid"
    ))
    .load(conn)?;
    if columns.len() != expected.len()
        || columns
            .iter()
            .zip(expected)
            .enumerate()
            .any(|(position, (actual, expected))| {
                actual.cid as usize != position
                    || !actual.name.eq_ignore_ascii_case(expected.0)
                    || !actual.column_type.eq_ignore_ascii_case(expected.1)
                    || (actual.notnull != 0) != expected.2
                    || actual.default_value.as_deref() != expected.3
                    || actual.pk != expected.4
            })
    {
        return Err(Error::InvalidInput(format!(
            "{table} does not match the canonical schema"
        )));
    }
    Ok(())
}

fn validate_sentinel_records_and_triggers(conn: &mut SqliteConnection) -> Result<(), Error> {
    let sentinel_count = sql_query(
        "SELECT
            (SELECT COUNT(*) FROM Players WHERE ID = 0 AND Name = 'Unknown' AND Elo IS NULL) +
            (SELECT COUNT(*) FROM Events WHERE ID = 0 AND Name = 'Unknown') +
            (SELECT COUNT(*) FROM Sites WHERE ID = 0 AND Name = 'Unknown') AS count",
    )
    .get_result::<CountRow>(conn)?
    .count;
    if sentinel_count != 3 {
        return Err(Error::InvalidInput(
            "Database sentinel records are missing or malformed".into(),
        ));
    }
    let triggers: Vec<TriggerInfo> = sql_query(
        "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'protect_unknown_%'",
    )
    .load(conn)?;
    let required = [
        (
            "protect_unknown_player_delete",
            "CREATETRIGGERPROTECT_UNKNOWN_PLAYER_DELETEBEFOREDELETEONPLAYERSWHENOLD.ID=0BEGINSELECTRAISE(ABORT,'CANNOTDELETETHEUNKNOWNPLAYER');END",
        ),
        (
            "protect_unknown_player_update",
            "CREATETRIGGERPROTECT_UNKNOWN_PLAYER_UPDATEBEFOREUPDATEONPLAYERSWHENOLD.ID=0AND(NEW.ID!=0ORNEW.NAMEISNOT'UNKNOWN'ORNEW.ELOISNOTNULL)BEGINSELECTRAISE(ABORT,'CANNOTMODIFYTHEUNKNOWNPLAYER');END",
        ),
        (
            "protect_unknown_event_delete",
            "CREATETRIGGERPROTECT_UNKNOWN_EVENT_DELETEBEFOREDELETEONEVENTSWHENOLD.ID=0BEGINSELECTRAISE(ABORT,'CANNOTDELETETHEUNKNOWNEVENT');END",
        ),
        (
            "protect_unknown_event_update",
            "CREATETRIGGERPROTECT_UNKNOWN_EVENT_UPDATEBEFOREUPDATEONEVENTSWHENOLD.ID=0AND(NEW.ID!=0ORNEW.NAMEISNOT'UNKNOWN')BEGINSELECTRAISE(ABORT,'CANNOTMODIFYTHEUNKNOWNEVENT');END",
        ),
        (
            "protect_unknown_site_delete",
            "CREATETRIGGERPROTECT_UNKNOWN_SITE_DELETEBEFOREDELETEONSITESWHENOLD.ID=0BEGINSELECTRAISE(ABORT,'CANNOTDELETETHEUNKNOWNSITE');END",
        ),
        (
            "protect_unknown_site_update",
            "CREATETRIGGERPROTECT_UNKNOWN_SITE_UPDATEBEFOREUPDATEONSITESWHENOLD.ID=0AND(NEW.ID!=0ORNEW.NAMEISNOT'UNKNOWN')BEGINSELECTRAISE(ABORT,'CANNOTMODIFYTHEUNKNOWNSITE');END",
        ),
    ];
    if triggers.len() != required.len()
        || required.iter().any(|(name, contract)| {
            !triggers
                .iter()
                .any(|trigger| trigger.name == *name && normalize_sql(&trigger.sql) == *contract)
        })
    {
        return Err(Error::InvalidInput(
            "Database sentinel protection triggers are missing".into(),
        ));
    }
    Ok(())
}

fn create_sentinel_triggers(conn: &mut SqliteConnection) -> Result<(), Error> {
    conn.batch_execute(
        "CREATE TRIGGER IF NOT EXISTS protect_unknown_player_delete BEFORE DELETE ON Players WHEN OLD.ID = 0 BEGIN SELECT RAISE(ABORT, 'cannot delete the Unknown player'); END;
         CREATE TRIGGER IF NOT EXISTS protect_unknown_player_update BEFORE UPDATE ON Players WHEN OLD.ID = 0 AND (NEW.ID != 0 OR NEW.Name IS NOT 'Unknown' OR NEW.Elo IS NOT NULL) BEGIN SELECT RAISE(ABORT, 'cannot modify the Unknown player'); END;
         CREATE TRIGGER IF NOT EXISTS protect_unknown_event_delete BEFORE DELETE ON Events WHEN OLD.ID = 0 BEGIN SELECT RAISE(ABORT, 'cannot delete the Unknown event'); END;
         CREATE TRIGGER IF NOT EXISTS protect_unknown_event_update BEFORE UPDATE ON Events WHEN OLD.ID = 0 AND (NEW.ID != 0 OR NEW.Name IS NOT 'Unknown') BEGIN SELECT RAISE(ABORT, 'cannot modify the Unknown event'); END;
         CREATE TRIGGER IF NOT EXISTS protect_unknown_site_delete BEFORE DELETE ON Sites WHEN OLD.ID = 0 BEGIN SELECT RAISE(ABORT, 'cannot delete the Unknown site'); END;
         CREATE TRIGGER IF NOT EXISTS protect_unknown_site_update BEFORE UPDATE ON Sites WHEN OLD.ID = 0 AND (NEW.ID != 0 OR NEW.Name IS NOT 'Unknown') BEGIN SELECT RAISE(ABORT, 'cannot modify the Unknown site'); END;",
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> SqliteConnection {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute("PRAGMA foreign_keys = ON;").unwrap();
        conn
    }

    #[test]
    fn initialization_binds_metadata_and_leaves_a_canonical_database() {
        let mut conn = connection();
        prepare_database(&mut conn, "quoted ' title", "x'); DROP TABLE Games; --").unwrap();

        assert_eq!(
            info_value(&mut conn, "Title").unwrap().as_deref(),
            Some("quoted ' title")
        );
        assert_eq!(
            info_value(&mut conn, "Description").unwrap().as_deref(),
            Some("x'); DROP TABLE Games; --")
        );
        assert!(games_schema_is_canonical(&mut conn).unwrap());
        assert!(table_exists(&mut conn, "Games").unwrap());
    }

    #[test]
    fn legacy_affinities_migrate_without_losing_ids_or_valid_results() {
        let mut conn = connection();
        conn.batch_execute(
            "CREATE TABLE Info (Name TEXT UNIQUE NOT NULL, Value TEXT);
             CREATE TABLE Players (ID INTEGER PRIMARY KEY, Name TEXT UNIQUE, Elo INTEGER);
             CREATE TABLE Events (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
             CREATE TABLE Sites (ID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE);
             CREATE TABLE Games (
                 ID INTEGER PRIMARY KEY AUTOINCREMENT, EventID INTEGER, SiteID INTEGER,
                 Date TEXT, UTCTime TEXT, Round INTEGER, WhiteID INTEGER, WhiteElo INTEGER,
                 BlackID INTEGER, BlackElo INTEGER, WhiteMaterial INTEGER, BlackMaterial INTEGER,
                 Result INTEGER, TimeControl TEXT, ECO TEXT, PlyCount INTEGER, FEN TEXT,
                 Moves BLOB, PawnHome BLOB
             );
             INSERT INTO Players VALUES (0, 'Unknown', NULL);
             INSERT INTO Events VALUES (0, 'Unknown');
             INSERT INTO Sites VALUES (0, 'Unknown');
             INSERT INTO Games (ID, EventID, SiteID, Round, WhiteID, BlackID, Result, Moves, PawnHome, WhiteMaterial, BlackMaterial)
             VALUES (42, 0, 0, 7, 0, 0, '1-0', X'00', 255, 0, 0);
             INSERT INTO Info VALUES ('Version', '1.0.0');",
        )
        .unwrap();

        prepare_database(&mut conn, "unused", "unused").unwrap();
        assert!(games_schema_is_canonical(&mut conn).unwrap());
        assert_eq!(
            info_value(&mut conn, "Version").unwrap().as_deref(),
            Some(CURRENT_DATABASE_VERSION)
        );
        let row: MigratedGame =
            sql_query("SELECT ID, Round, Result, PawnHome FROM Games WHERE ID = 42")
                .get_result(&mut conn)
                .unwrap();
        assert_eq!(
            row,
            MigratedGame {
                id: 42,
                round: Some("7".into()),
                result: Some("1-0".into()),
                pawn_home: 255,
            }
        );
        assert_migrated_orientation_and_stamp(&mut conn);
    }

    fn assert_migrated_orientation_and_stamp(conn: &mut SqliteConnection) {
        let row = super::super::schema::games::table
            .find(42)
            .first::<super::super::models::Game>(conn)
            .unwrap();
        assert!(row.orientation.is_none());
        // Golden digest of this row with the original, pre-orientation field framing.
        assert_eq!(
            super::super::game_row_stamp(&row),
            "18add3dbe3e697f80e999fbbf72733d2e1ceadebf7008ccfeab9969671089cbb"
        );
        validate_database(conn).unwrap();
    }

    fn pre_orientation_connection() -> SqliteConnection {
        let mut conn = connection();
        let old_schema = CREATE_TABLES_SQL.replace(
            "    Orientation TEXT CHECK(Orientation IN ('white', 'black') OR Orientation IS NULL),\n",
            "",
        );
        conn.batch_execute(&old_schema).unwrap();
        insert_info(&mut conn, "Version", PRE_ORIENTATION_DATABASE_VERSION).unwrap();
        conn
    }

    #[test]
    fn version_two_upgrade_adds_nullable_orientation_in_place_and_preserves_stamps() {
        let mut conn = pre_orientation_connection();
        conn.batch_execute(
            "INSERT INTO Games (ID, Round, Result, Moves, PawnHome, WhiteMaterial, BlackMaterial)
             VALUES (42, '7', '1-0', X'00', 255, 0, 0);
             CREATE INDEX retained_game_index ON Games(Date);",
        )
        .unwrap();
        assert!(validate_existing_database(&mut conn).unwrap());
        assert_eq!(
            info_value(&mut conn, "Version").unwrap().as_deref(),
            Some(CURRENT_DATABASE_VERSION)
        );
        assert_migrated_orientation_and_stamp(&mut conn);
        assert_eq!(
            sql_query(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'retained_game_index'"
            )
            .get_result::<CountRow>(&mut conn)
            .unwrap()
            .count,
            1
        );
        assert!(!validate_existing_database(&mut conn).unwrap());
        assert!(sql_query("UPDATE Games SET Orientation = 'invalid'")
            .execute(&mut conn)
            .is_err());
    }

    #[test]
    fn failed_orientation_upgrade_rolls_back_column_and_version() {
        let mut conn = pre_orientation_connection();
        conn.batch_execute(
            "PRAGMA ignore_check_constraints = ON;
            INSERT INTO Games (Result) VALUES ('invalid');
            PRAGMA ignore_check_constraints = OFF;",
        )
        .unwrap();
        assert!(validate_existing_database(&mut conn).is_err());
        assert_eq!(
            info_value(&mut conn, "Version").unwrap().as_deref(),
            Some(PRE_ORIENTATION_DATABASE_VERSION)
        );
        validate_games_schema_version(&mut conn, false).unwrap();
    }

    #[test]
    fn non_empty_partial_schema_is_rejected() {
        let mut conn = connection();
        conn.batch_execute("CREATE TABLE Info (Name TEXT UNIQUE NOT NULL, Value TEXT);")
            .unwrap();
        assert!(matches!(
            prepare_database(&mut conn, "title", "description"),
            Err(Error::InvalidInput(message)) if message.contains("incomplete")
        ));
    }

    #[test]
    fn version_two_database_with_missing_sentinel_protection_is_rejected() {
        let mut conn = connection();
        prepare_database(&mut conn, "title", "description").unwrap();
        conn.batch_execute("DROP TRIGGER protect_unknown_player_delete;")
            .unwrap();
        assert!(matches!(
            validate_existing_database(&mut conn),
            Err(Error::InvalidInput(message)) if message.contains("sentinel protection")
        ));
    }

    #[test]
    fn version_two_database_with_missing_foreign_key_is_rejected() {
        let mut conn = connection();
        prepare_database(&mut conn, "title", "description").unwrap();
        conn.batch_execute(
            "DROP TABLE Games;
             CREATE TABLE Games (
                ID INTEGER PRIMARY KEY AUTOINCREMENT,
                EventID INTEGER NOT NULL DEFAULT 0,
                SiteID INTEGER NOT NULL DEFAULT 0,
                Date TEXT, UTCTime TEXT, Round TEXT,
                WhiteID INTEGER NOT NULL DEFAULT 0, WhiteElo INTEGER,
                BlackID INTEGER NOT NULL DEFAULT 0, BlackElo INTEGER,
                WhiteMaterial INTEGER, BlackMaterial INTEGER,
                Result TEXT CHECK(Result IN ('1-0', '0-1', '1/2-1/2', '*') OR Result IS NULL),
                TimeControl TEXT, ECO TEXT, PlyCount INTEGER, FEN TEXT, Moves BLOB,
                PawnHome INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(EventID) REFERENCES Events(ID),
                FOREIGN KEY(SiteID) REFERENCES Sites(ID),
                FOREIGN KEY(WhiteID) REFERENCES Players(ID)
             );",
        )
        .unwrap();
        let result = validate_existing_database(&mut conn);
        assert!(
            result.is_err(),
            "missing foreign key must be rejected: {result:?}"
        );
    }

    #[test]
    fn version_two_database_with_wrong_unique_constraint_is_rejected() {
        let mut conn = connection();
        prepare_database(&mut conn, "title", "description").unwrap();
        conn.batch_execute(
            "CREATE TABLE Players__wrong (ID INTEGER PRIMARY KEY, Name TEXT, Elo INTEGER, UNIQUE(Elo));
             INSERT INTO Players__wrong SELECT ID, Name, Elo FROM Players;
             DROP TABLE Players;
             ALTER TABLE Players__wrong RENAME TO Players;",
        )
        .unwrap();
        assert!(validate_existing_database(&mut conn).is_err());
    }

    #[test]
    fn version_two_database_with_lookalike_trigger_is_rejected() {
        let mut conn = connection();
        prepare_database(&mut conn, "title", "description").unwrap();
        conn.batch_execute(
            "DROP TRIGGER protect_unknown_player_delete;
             CREATE TRIGGER protect_unknown_player_delete BEFORE DELETE ON Players WHEN OLD.ID = 0
             BEGIN SELECT RAISE(ABORT, 'different message'); END;",
        )
        .unwrap();
        assert!(matches!(
            validate_existing_database(&mut conn),
            Err(Error::InvalidInput(message)) if message.contains("sentinel protection")
        ));
    }

    #[test]
    fn version_two_database_without_games_autoincrement_is_rejected() {
        let mut conn = connection();
        let malformed = CREATE_TABLES_SQL.replace(
            "ID INTEGER PRIMARY KEY AUTOINCREMENT,\n    EventID INTEGER NOT NULL DEFAULT 0",
            "ID INTEGER PRIMARY KEY,\n    EventID INTEGER NOT NULL DEFAULT 0",
        );
        conn.batch_execute(&malformed).unwrap();
        insert_info(&mut conn, "Version", CURRENT_DATABASE_VERSION).unwrap();
        assert!(matches!(
            validate_games_schema(&mut conn),
            Err(Error::InvalidInput(message)) if message.contains("AUTOINCREMENT")
        ));
    }
}
