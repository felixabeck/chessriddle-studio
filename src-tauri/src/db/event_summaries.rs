use super::*;

/// Refresh only the dirty events. The caller owns the write transaction, including
/// temporary-table cleanup on failure, so no partial summaries can be published.
pub(super) fn refresh_event_summaries(conn: &mut SqliteConnection) -> Result<(), Error> {
    conn.batch_execute(
        "CREATE TEMP TABLE event_summary_refresh (
            ID INTEGER PRIMARY KEY, StartDate TEXT, EndDate TEXT,
            SiteID INTEGER NOT NULL, GameCount INTEGER NOT NULL,
            PlayerCount INTEGER NOT NULL, AvgElo INTEGER
         );
         INSERT INTO event_summary_refresh
         WITH dirty_games AS NOT MATERIALIZED (
             SELECT g.* FROM EventSummaryDirty d
             CROSS JOIN Games g INDEXED BY games_event_idx ON g.EventID = d.ID
             WHERE d.ID != 0
         ), totals AS (
             SELECT EventID, COUNT(*) AS GameCount,
                 MIN(CASE WHEN Date NOT LIKE '?%' THEN Date END) AS StartDate,
                 MAX(CASE WHEN Date NOT LIKE '?%' THEN Date END) AS EndDate,
                 CAST(ROUND(
                     SUM(CASE WHEN WhiteElo > 0 THEN CAST(WhiteElo AS REAL) ELSE 0 END
                         + CASE WHEN BlackElo > 0 THEN CAST(BlackElo AS REAL) ELSE 0 END)
                     / NULLIF(SUM((CASE WHEN WhiteElo > 0 THEN 1 ELSE 0 END)
                         + (CASE WHEN BlackElo > 0 THEN 1 ELSE 0 END)), 0)
                 ) AS INTEGER) AS AvgElo
             FROM dirty_games GROUP BY EventID
         ), participants AS (
             SELECT EventID, COUNT(*) AS PlayerCount FROM (
                 SELECT EventID, WhiteID AS PlayerID FROM dirty_games WHERE WhiteID != 0
                 UNION
                 SELECT EventID, BlackID AS PlayerID FROM dirty_games WHERE BlackID != 0
             ) GROUP BY EventID
         ), ranked_sites AS (
             SELECT EventID, SiteID,
                 ROW_NUMBER() OVER (PARTITION BY EventID ORDER BY COUNT(*) DESC, SiteID) AS rank
             FROM dirty_games WHERE SiteID != 0 GROUP BY EventID, SiteID
         )
         SELECT d.ID, t.StartDate, t.EndDate, COALESCE(s.SiteID, 0),
             COALESCE(t.GameCount, 0), COALESCE(p.PlayerCount, 0), t.AvgElo
         FROM EventSummaryDirty d
         LEFT JOIN totals t ON t.EventID = d.ID
         LEFT JOIN participants p ON p.EventID = d.ID
         LEFT JOIN ranked_sites s ON s.EventID = d.ID AND s.rank = 1
         WHERE d.ID != 0;
         UPDATE Events SET (StartDate, EndDate, SiteID, GameCount, PlayerCount, AvgElo) = (
             SELECT StartDate, EndDate, SiteID, GameCount, PlayerCount, AvgElo
             FROM event_summary_refresh WHERE ID = Events.ID
         ) WHERE ID IN (SELECT ID FROM event_summary_refresh);
         DELETE FROM EventSummaryDirty;
         DROP TABLE event_summary_refresh;",
    )?;
    Ok(())
}
