use crate::db::models::{Event, Game, NewEvent, NewGame, NewPlayer, NewSite, Player, Site};
use diesel::prelude::*;

/// Creates a new player in the database, and returns the player's ID.
/// If the player already exists, returns the ID of the existing player.
pub fn create_player(
    conn: &mut SqliteConnection,
    name: &str,
) -> Result<Player, diesel::result::Error> {
    use crate::db::schema::players;

    let new_player = NewPlayer { name, elo: None };

    let player = diesel::insert_or_ignore_into(players::table)
        .values(&new_player)
        .execute(conn);

    match player {
        Ok(_) => players::table
            .filter(players::name.eq(name))
            .first::<Player>(conn),
        Err(e) => Err(e),
    }
}

/// Calendar edition shared by import and edit. Partial dates still identify a year.
pub(super) fn event_year(name: &str, date: Option<&str>) -> i32 {
    if name.is_empty() || name == "Unknown" {
        return 0;
    }
    match date.and_then(|date| date.as_bytes().get(..4)) {
        Some(prefix) if prefix.iter().all(u8::is_ascii_digit) => prefix
            .iter()
            .fold(0, |year, digit| year * 10 + i32::from(digit - b'0')),
        _ => 0,
    }
}

// Migration equivalent, exercised against event_year by the date parity test.
pub(super) const EVENT_YEAR_SQL: &str = "CASE
    WHEN e.Name IN ('Unknown', '') THEN 0
    WHEN substr(g.Date, 1, 4) GLOB '[0-9][0-9][0-9][0-9]'
        THEN CAST(substr(g.Date, 1, 4) AS INTEGER)
    ELSE 0 END";

pub fn create_event(
    conn: &mut SqliteConnection,
    name: &str,
    date: Option<&str>,
) -> Result<Event, diesel::result::Error> {
    use crate::db::schema::events;

    let new_event = NewEvent {
        name,
        year: event_year(name, date),
    };

    let event = diesel::insert_or_ignore_into(events::table)
        .values(&new_event)
        .execute(conn);

    match event {
        Ok(_) => events::table
            .filter(events::name.eq(name))
            .filter(events::year.eq(new_event.year))
            .first::<Event>(conn),
        Err(e) => Err(e),
    }
}

pub fn create_site(conn: &mut SqliteConnection, name: &str) -> Result<Site, diesel::result::Error> {
    use crate::db::schema::sites;

    let new_site = NewSite { name };

    let site = diesel::insert_or_ignore_into(sites::table)
        .values(&new_site)
        .execute(conn);

    match site {
        Ok(_) => sites::table
            .filter(sites::name.eq(name))
            .first::<Site>(conn),
        Err(e) => Err(e),
    }
}

/// Creates a new game in the database, and returns the game's ID.
pub fn create_game(
    conn: &mut SqliteConnection,
    game: NewGame,
) -> Result<Game, diesel::result::Error> {
    use crate::db::schema::games;

    diesel::insert_into(games::table)
        .values(&game)
        .get_result(conn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use diesel::connection::SimpleConnection;
    use diesel::sql_types::{Integer, Nullable, Text};

    #[derive(QueryableByName)]
    struct EditionYear {
        #[diesel(sql_type = Integer)]
        year: i32,
    }

    #[test]
    fn create_event_keeps_unknown_and_empty_names_in_year_zero() {
        use crate::db::schema::events;

        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        conn.batch_execute(include_str!("create.sql")).unwrap();
        let unknown = create_event(&mut conn, "Unknown", Some("2020.01.01")).unwrap();
        assert_eq!((unknown.id, unknown.year), (0, 0));
        assert_eq!(
            events::table.count().get_result::<i64>(&mut conn).unwrap(),
            1
        );
        assert_eq!(
            events::table
                .filter(events::name.eq("Unknown"))
                .count()
                .get_result::<i64>(&mut conn)
                .unwrap(),
            1
        );

        let empty = create_event(&mut conn, "", Some("2020.01.01")).unwrap();
        assert_eq!(empty.year, 0);
        assert_eq!(
            create_event(&mut conn, "", Some("2021.01.01")).unwrap().id,
            empty.id
        );
        assert_eq!(
            events::table.count().get_result::<i64>(&mut conn).unwrap(),
            2
        );
    }

    #[test]
    fn event_year_matches_migration_sql_for_all_date_shapes() {
        let mut conn = SqliteConnection::establish(":memory:").unwrap();
        for name in ["Recurring", "Unknown", ""] {
            for (date, expected) in [
                (None, 0),
                (Some(""), 0),
                (Some("????.??.??"), 0),
                (Some("0000.01.01"), 0),
                (Some("2024.??.??"), 2024),
                (Some("2024.05.06"), 2024),
                (Some("x024.05.06"), 0),
                (Some("202"), 0),
                (Some("２０２４.01.01"), 0),
                (Some(" 2024"), 0),
                (Some("9999"), 9999),
                (Some("0001.??.??"), 1),
                (Some("20245"), 2024),
                (Some("20\0x"), 0),
            ] {
                let sql = diesel::sql_query(format!(
                    "SELECT {EVENT_YEAR_SQL} AS year FROM (SELECT ? AS Name) e CROSS JOIN (SELECT ? AS Date) g"
                ))
                .bind::<Text, _>(name)
                .bind::<Nullable<Text>, _>(date)
                .get_result::<EditionYear>(&mut conn).unwrap().year;
                let rust = event_year(name, date);
                assert_eq!(
                    rust,
                    if name == "Unknown" || name.is_empty() {
                        0
                    } else {
                        expected
                    }
                );
                assert_eq!(rust, sql, "{name:?} {date:?}");
            }
        }
    }
}
