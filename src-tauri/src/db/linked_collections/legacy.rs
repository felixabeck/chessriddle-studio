//! Durable provider identity assignments for PGN occurrences whose legacy bytes lack IDs.
//! This is reconciliation evidence, separate from the disposable search cache and game text.
use super::super::bound_sqlite::{BoundConnection, BoundDatabase, SqliteMode};
use super::*;

pub(super) fn open(
    service: &CollectionService,
    record: &Record,
) -> Result<BoundConnection<rusqlite::Connection>, Error> {
    let leaf = format!("{}-identity.db3", record.id);
    match entry_identity_at(service.root.descriptor(), OsStr::new(&leaf), false) {
        Ok(_) => {}
        Err(error) if error.is_missing_entry() => {
            let (file, _) = create_regular_at(service.root.descriptor(), OsStr::new(&leaf))?;
            file.sync_all()?;
            service.root.descriptor().sync_all()?;
        }
        Err(error) => return Err(error),
    }
    let target = service.root.database_target(OsStr::new(&leaf))?;
    let binding = BoundDatabase::acquire(&target)?;
    let lifetime = binding.connection_lifetime()?;
    let connection = lifetime.wrap(
        rusqlite::Connection::open_with_flags(
            binding.uri(SqliteMode::ReadWrite)?,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(batch::batch_error)?,
    );
    connection
        .execute_batch(
            "PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA temp_store=FILE;",
        )
        .map_err(batch::batch_error)?;
    let version: i32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(batch::batch_error)?;
    if !matches!(version, 0 | 1) {
        return Err(Error::Conflict(
            "unsupported collection identity evidence".into(),
        ));
    }
    connection.execute_batch("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS Evidence(Provider TEXT NOT NULL,Account TEXT NOT NULL,ID TEXT NOT NULL,Binding TEXT NOT NULL,Generation TEXT NOT NULL,Ordinal INTEGER NOT NULL,Stamp TEXT NOT NULL,Fingerprint TEXT NOT NULL,PRIMARY KEY(Provider,Account,ID)); CREATE INDEX IF NOT EXISTS EvidenceFingerprint ON Evidence(Provider,Account,Fingerprint); PRAGMA user_version=1; COMMIT;").map_err(batch::batch_error)?;
    // SQLite synced the transaction. The verified directory also owns creation of this leaf.
    service.root.descriptor().sync_all()?;
    Ok(connection)
}

pub(super) fn binding(record: &Record) -> Result<String, Error> {
    // Authority-proven app renames retain the epoch. Explicit source selection advances it.
    serde_json::to_string(&(record.id, &record.workspace, record.source_epoch))
        .map_err(|_| Error::StaleGame)
}

/// Revalidate every assignment against Source and restore its IDs before loading Batch.
/// Exact unique bytes or unique semantics survive annotations. Invalid evidence is retained.
pub(super) fn revalidate_source(
    db: &rusqlite::Transaction<'_>,
    account: &AccountIdentity,
    binding: &str,
    generation: &str,
) -> Result<(), Error> {
    db.execute_batch(
        "CREATE TEMP TABLE Valid(ID TEXT PRIMARY KEY,Ordinal INTEGER UNIQUE NOT NULL);",
    )
    .map_err(batch::batch_error)?;
    // A unique explicit current ID attests its own identity across source selection. It must
    // agree with the stored semantics. ID-less occurrences still require the original binding.
    db.execute("INSERT INTO Valid SELECT e.ID,s.Ordinal FROM Evidence e JOIN Source s ON s.ID=e.ID AND s.Fingerprint=e.Fingerprint WHERE e.Provider=?1 AND e.Account=?2 AND (SELECT count(*) FROM Source x WHERE x.ID=e.ID)=1", rusqlite::params![account.provider, account.account]).map_err(batch::batch_error)?;
    db.execute("INSERT INTO Valid SELECT e.ID,s.Ordinal FROM Evidence e JOIN Source s ON s.Fingerprint=e.Fingerprint AND (s.ID IS NULL OR s.ID=e.ID) WHERE e.Provider=?1 AND e.Account=?2 AND e.Binding=?3 AND NOT EXISTS(SELECT 1 FROM Valid v WHERE v.ID=e.ID) AND ((s.Stamp=e.Stamp AND (SELECT count(*) FROM Source x WHERE x.Stamp=e.Stamp AND x.Fingerprint=e.Fingerprint AND (x.ID IS NULL OR x.ID=e.ID))=1) OR ((SELECT count(*) FROM Source x WHERE x.Stamp=e.Stamp AND x.Fingerprint=e.Fingerprint AND (x.ID IS NULL OR x.ID=e.ID))=0 AND (SELECT count(*) FROM Source x WHERE x.Fingerprint=e.Fingerprint AND (x.ID IS NULL OR x.ID=e.ID))=1))", rusqlite::params![account.provider, account.account, binding]).map_err(|error| { log::warn!("legacy identity revalidation conflict: {error}"); batch::conflict() })?;
    db.execute("UPDATE Evidence SET Binding=?1,Generation=?2,Ordinal=(SELECT Ordinal FROM Valid WHERE Valid.ID=Evidence.ID),Stamp=(SELECT Source.Stamp FROM Source JOIN Valid ON Source.Ordinal=Valid.Ordinal WHERE Valid.ID=Evidence.ID) WHERE Provider=?3 AND Account=?4 AND ID IN (SELECT ID FROM Valid)", rusqlite::params![binding, generation, account.provider, account.account]).map_err(batch::batch_error)?;
    db.execute_batch("UPDATE Source SET ID=(SELECT ID FROM Valid WHERE Valid.Ordinal=Source.Ordinal) WHERE Ordinal IN (SELECT Ordinal FROM Valid)").map_err(batch::batch_error)?;
    Ok(())
}

/// Invalid evidence only blocks incoming identities it affects after Batch suppression.
pub(super) fn check_affected_evidence(
    db: &rusqlite::Transaction<'_>,
    account: &AccountIdentity,
) -> Result<(), Error> {
    let affected: i64 = db.query_row("SELECT count(*) FROM Evidence e JOIN Batch b ON (b.ID=e.ID OR b.Fingerprint=e.Fingerprint) WHERE e.Provider=? AND e.Account=? AND NOT EXISTS(SELECT 1 FROM Valid v WHERE v.ID=e.ID)", rusqlite::params![account.provider, account.account], |row| row.get(0)).map_err(batch::batch_error)?;
    if affected != 0 {
        return Err(batch::conflict());
    }
    Ok(())
}

pub(super) fn assign(
    db: &rusqlite::Transaction<'_>,
    account: &AccountIdentity,
    binding: &str,
    generation: &str,
    id: &str,
    fingerprint: &str,
) -> Result<(), Error> {
    let known: i64 = db
        .query_row("SELECT count(*) FROM Source WHERE ID=?", [id], |row| {
            row.get(0)
        })
        .map_err(batch::batch_error)?;
    if known != 0 {
        return Ok(());
    }
    db.execute("INSERT INTO Evidence SELECT ?1,?2,?3,?4,?5,Ordinal,Stamp,Fingerprint FROM Source WHERE ID IS NULL AND Fingerprint=?6", rusqlite::params![account.provider, account.account, id, binding, generation, fingerprint]).map_err(batch::batch_error)?;
    // The same occurrence cannot satisfy another known ID later in this batch.
    db.execute(
        "UPDATE Source SET ID=? WHERE ID IS NULL AND Fingerprint=?",
        rusqlite::params![id, fingerprint],
    )
    .map_err(batch::batch_error)?;
    Ok(())
}
