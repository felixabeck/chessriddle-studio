#[cfg(test)]
use std::path::PathBuf;
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::{self, Seek, SeekFrom, Write},
    path::Path,
    sync::Arc,
};

use memmap2::Mmap;
use rayon::prelude::*;
use rkyv::{Archive, Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::{
    error::Error,
    infra::fs::{atomic_replace_at, AtomicFileOutcome},
};

use crate::db::DatabaseIdentity;
use crate::error::DurabilityStage;
use std::io::Read;

// Only the test-only helpers below still replace an index by pathname; production
// writes go through the descriptor-relative `atomic_replace_at`.
#[cfg(test)]
use crate::infra::fs::atomic_replace;

const MAGIC: &[u8; 4] = b"ECSI";
const VERSION: u32 = 8;
const ARCHIVE_ALIGNMENT: usize = 16;
const HEADER_SIZE: usize = 32;
const CHUNK_HEADER_SIZE: usize = 16;
const MAX_SOURCE_BYTES: usize = 1024 * 1024;
pub(crate) const CHUNK_ENTRY_LIMIT: usize = 4_096;
pub(crate) const CHUNK_PAYLOAD_TARGET_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
struct ArchiveHeader {
    source_len: usize,
    entry_count: usize,
    chunk_count: usize,
}

fn invalid_data(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn read_u64(bytes: &[u8], offset: usize, name: &str) -> io::Result<u64> {
    let end = offset
        .checked_add(8)
        .ok_or_else(|| invalid_data(format!("{name} offset overflow")))?;
    let value = bytes
        .get(offset..end)
        .ok_or_else(|| invalid_data(format!("missing {name}")))?;
    Ok(u64::from_le_bytes(
        value
            .try_into()
            .map_err(|_| invalid_data(format!("invalid {name}")))?,
    ))
}

fn checked_usize(value: u64, name: &str) -> io::Result<usize> {
    usize::try_from(value).map_err(|_| invalid_data(format!("{name} exceeds platform limits")))
}

fn align_up(offset: usize) -> io::Result<usize> {
    offset
        .checked_add(ARCHIVE_ALIGNMENT - 1)
        .map(|value| value & !(ARCHIVE_ALIGNMENT - 1))
        .ok_or_else(|| invalid_data("archive offset overflow"))
}

fn verify_header(header: &[u8]) -> io::Result<ArchiveHeader> {
    if header.len() < HEADER_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "File too small for header",
        ));
    }

    if &header[0..4] != MAGIC {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid magic bytes",
        ));
    }

    let version = u32::from_le_bytes(
        header[4..8]
            .try_into()
            .map_err(|_| invalid_data("invalid version field"))?,
    );
    if version != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Unsupported version: {} (expected {})", version, VERSION),
        ));
    }

    Ok(ArchiveHeader {
        source_len: checked_usize(read_u64(header, 8, "source length")?, "source length")?,
        entry_count: checked_usize(read_u64(header, 16, "entry count")?, "entry count")?,
        chunk_count: checked_usize(read_u64(header, 24, "chunk count")?, "chunk count")?,
    })
}

fn decode_index_source<B: AsRef<[u8]>>(
    header_bytes: &[u8],
    read_source: impl FnOnce(usize) -> io::Result<B>,
) -> io::Result<(ArchiveHeader, IndexSource, usize)> {
    let header = verify_header(header_bytes)?;
    if header.source_len > MAX_SOURCE_BYTES {
        return Err(invalid_data("index source exceeds the metadata limit"));
    }
    if !header.source_len.is_multiple_of(ARCHIVE_ALIGNMENT) {
        return Err(invalid_data("misaligned index source length"));
    }
    let source_end = HEADER_SIZE
        .checked_add(header.source_len)
        .ok_or_else(|| invalid_data("source bounds overflow"))?;
    let source = read_source(header.source_len)?;
    let source_bytes = source.as_ref();
    if source_bytes.len() != header.source_len {
        return Err(invalid_data("truncated index source"));
    }
    if !(source_bytes.as_ptr() as usize).is_multiple_of(ARCHIVE_ALIGNMENT) {
        return Err(invalid_data("misaligned index source"));
    }
    let source = rkyv::from_bytes::<IndexSource, rkyv::rancor::Error>(source_bytes)
        .map_err(|error| invalid_data(format!("invalid index source archive: {error}")))?;
    Ok((header, source, source_end))
}

fn read_source_exact(reader: &mut impl Read, bytes: &mut [u8], truncation: &str) -> io::Result<()> {
    let result = reader.read_exact(bytes);
    #[cfg(test)]
    let result =
        super::inject_unlink_probe_fault(super::UnlinkProbeStage::SourceRead, None, result);
    result.map_err(|error| {
        if error.kind() == io::ErrorKind::UnexpectedEof {
            invalid_data(truncation)
        } else {
            error
        }
    })
}

/// Reads only the header and recorded source from an opened archive, without mapping it
/// or reading any chunks. The caller owns and closes the read handle before deletion.
pub(crate) fn read_index_source(reader: &mut impl Read) -> io::Result<IndexSource> {
    let mut header_bytes = [0; HEADER_SIZE];
    read_source_exact(reader, &mut header_bytes, "File too small for header")?;
    let (_, source, _) = decode_index_source(&header_bytes, |source_len| {
        let mut bytes = rkyv::util::AlignedVec::<ARCHIVE_ALIGNMENT>::with_capacity(source_len);
        bytes.resize(source_len, 0);
        read_source_exact(reader, &mut bytes, "truncated index source")?;
        Ok(bytes)
    })?;
    Ok(source)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Archive, Serialize, Deserialize)]
#[rkyv(compare(PartialEq), derive(Debug))]
#[repr(u8)]
pub enum GameResult {
    #[default]
    None = 0,
    WhiteWin = 1,
    BlackWin = 2,
    Draw = 3,
    Other = 4,
}

impl GameResult {
    pub fn from_str(s: Option<&str>) -> Self {
        match s {
            Some("1-0") => GameResult::WhiteWin,
            Some("0-1") => GameResult::BlackWin,
            Some("1/2-1/2") => GameResult::Draw,
            Some(_) => GameResult::Other,
            None => GameResult::None,
        }
    }

    pub fn to_str(self) -> Option<&'static str> {
        match self {
            GameResult::None => None,
            GameResult::WhiteWin => Some("1-0"),
            GameResult::BlackWin => Some("0-1"),
            GameResult::Draw => Some("1/2-1/2"),
            GameResult::Other => Some("*"),
        }
    }
}

#[derive(Debug, Clone, Archive, Serialize, Deserialize)]
#[rkyv(compare(PartialEq), derive(Debug))]
pub struct SearchGameEntry {
    pub id: i32,
    pub white_id: i32,
    pub black_id: i32,
    pub date: Option<String>,
    pub result: GameResult,
    pub pawn_home: u16,
    pub white_material: u8,
    pub black_material: u8,
    pub white_elo: i16,
    pub black_elo: i16,
    pub fen: Option<String>,
    pub moves: Vec<u8>,
}

#[derive(Clone, Debug, Archive, Serialize, Deserialize)]
pub struct SearchIndexChunk {
    pub entries: Vec<SearchGameEntry>,
}

/// Provenance recorded with every archive. The canonical database identity,
/// repository revision and filesystem freshness must agree before an archive
/// can be used for a query.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, Archive, Serialize, Deserialize)]
pub struct IndexSource {
    pub object: (u64, u64),
    pub revision: u64,
    pub database_length: u64,
    pub database_modified_nanos: u128,
}

impl IndexSource {
    fn index_source_from_parts(
        object: (u64, u64),
        revision: u64,
        length: u64,
        modified: std::time::SystemTime,
    ) -> Result<Self, Error> {
        let database_modified_nanos = modified
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_err(std::io::Error::other)?
            .as_nanos();
        Ok(Self {
            object,
            revision,
            database_length: length,
            database_modified_nanos,
        })
    }

    #[cfg(test)]
    pub fn from_database(database: &Path, revision: u64) -> Result<Self, Error> {
        let database = database.canonicalize()?;
        let metadata = database.metadata()?;
        Self::index_source_from_parts(
            crate::infra::path_authority::opened_file_identity(&File::open(&database)?)?,
            revision,
            metadata.len(),
            metadata.modified()?,
        )
    }

    pub fn from_database_identity(
        identity: &super::repository::DatabaseIdentity,
    ) -> Result<Self, Error> {
        Self::index_source_from_parts(
            identity.object,
            identity.data_revision,
            identity.length,
            identity.modified,
        )
    }
}

#[cfg(test)]
impl SearchIndexChunk {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            entries: Vec::with_capacity(capacity),
        }
    }

    pub fn push(&mut self, entry: SearchGameEntry) {
        self.entries.push(entry);
    }

    pub fn write_to<P: AsRef<Path>>(&self, path: P) -> Result<(), Error> {
        crate::infra::fs::require_durable(
            self.write_to_with_source(path, IndexSource::default())?,
            DurabilityStage::SearchIndexReplacement,
        )
    }

    pub fn write_to_with_source<P: AsRef<Path>>(
        &self,
        path: P,
        source: IndexSource,
    ) -> Result<AtomicFileOutcome, Error> {
        atomic_replace(path.as_ref(), |file| {
            write_chunked_archive(file, source, self.entries.iter().cloned().map(Ok))
        })
    }
}

pub(crate) fn write_entries_to_at<I>(
    parent: &File,
    leaf: &OsStr,
    source: IndexSource,
    entries: I,
    cancellation: &CancellationToken,
) -> Result<AtomicFileOutcome, Error>
where
    I: IntoIterator<Item = Result<SearchGameEntry, Error>>,
{
    atomic_replace_at(parent, leaf, |file| {
        let mut entries = entries.into_iter();
        write_chunked_archive_cancellable(file, source, &mut entries, cancellation)
    })
}

fn write_header<W: Write + ?Sized>(
    file: &mut W,
    source_len: u64,
    entry_count: u64,
    chunk_count: u64,
) -> Result<(), Error> {
    file.write_all(MAGIC).map_err(Error::from)?;
    file.write_all(&VERSION.to_le_bytes())
        .map_err(Error::from)?;
    file.write_all(&source_len.to_le_bytes())?;
    file.write_all(&entry_count.to_le_bytes())?;
    file.write_all(&chunk_count.to_le_bytes())?;
    Ok(())
}

fn write_padding<W: Write + ?Sized>(file: &mut W, position: usize) -> Result<usize, Error> {
    let aligned = align_up(position).map_err(Error::from)?;
    file.write_all(&[0; ARCHIVE_ALIGNMENT][..aligned - position])?;
    Ok(aligned)
}

fn estimated_entry_bytes(entry: &SearchGameEntry) -> usize {
    std::mem::size_of::<SearchGameEntry>()
        .saturating_add(entry.date.as_ref().map_or(0, String::len))
        .saturating_add(entry.fen.as_ref().map_or(0, String::len))
        .saturating_add(entry.moves.len())
}

fn write_chunk<W: Write + ?Sized>(
    file: &mut W,
    entries: &mut Vec<SearchGameEntry>,
    cancellation: &CancellationToken,
) -> Result<u64, Error> {
    for entry in entries.iter() {
        crate::db::encoding::try_iter_mainline_move_bytes_cancellable(&entry.moves, cancellation)?;
    }
    let index = SearchIndexChunk {
        entries: std::mem::take(entries),
    };
    let bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&index).map_err(|error| {
        Error::InvalidInput(format!("search index serialization failed: {error}"))
    })?;
    rkyv::access::<ArchivedSearchIndexChunk, rkyv::rancor::Error>(&bytes).map_err(|error| {
        Error::InvalidInput(format!(
            "search index validation before publish failed: {error}"
        ))
    })?;
    let payload_len = u64::try_from(bytes.len())
        .map_err(|_| Error::ResourceLimit("search index chunk is too large".into()))?;
    let entry_count = u64::try_from(index.entries.len())
        .map_err(|_| Error::ResourceLimit("search index chunk has too many entries".into()))?;
    file.write_all(&payload_len.to_le_bytes())?;
    file.write_all(&entry_count.to_le_bytes())?;
    file.write_all(&bytes)?;
    Ok(entry_count)
}

#[cfg(test)]
fn write_chunked_archive<W, I>(file: &mut W, source: IndexSource, entries: I) -> Result<(), Error>
where
    W: Write + Seek,
    I: IntoIterator<Item = Result<SearchGameEntry, Error>>,
{
    let mut entries = entries.into_iter();
    write_chunked_archive_cancellable(file, source, &mut entries, &CancellationToken::new())
}

trait WriteSeek: Write + Seek {}

impl<W: Write + Seek + ?Sized> WriteSeek for W {}

fn write_chunked_archive_cancellable(
    file: &mut dyn WriteSeek,
    source: IndexSource,
    entries: &mut dyn Iterator<Item = Result<SearchGameEntry, Error>>,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let source_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&source).map_err(|error| {
        Error::InvalidInput(format!("index source serialization failed: {error}"))
    })?;
    rkyv::access::<ArchivedIndexSource, rkyv::rancor::Error>(&source_bytes).map_err(|error| {
        Error::InvalidInput(format!(
            "index source validation before publish failed: {error}"
        ))
    })?;
    let source_len = u64::try_from(source_bytes.len())
        .map_err(|_| Error::ResourceLimit("search index source is too large".into()))?;
    if source_bytes.len() > MAX_SOURCE_BYTES {
        return Err(Error::ResourceLimit(
            "search index source exceeds the metadata limit".into(),
        ));
    }
    if !source_bytes.len().is_multiple_of(ARCHIVE_ALIGNMENT) {
        return Err(Error::InvalidInput(
            "serialized index source has invalid alignment".into(),
        ));
    }
    write_header(file, source_len, 0, 0)?;
    file.write_all(&source_bytes)?;

    let mut chunk = Vec::with_capacity(CHUNK_ENTRY_LIMIT);
    let mut estimated_bytes = 0_usize;
    let mut total_entries = 0_u64;
    let mut chunk_count = 0_u64;
    for entry in entries {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let entry = entry?;
        crate::db::encoding::try_iter_mainline_move_bytes_cancellable(&entry.moves, cancellation)?;
        let entry_bytes = estimated_entry_bytes(&entry);
        if !chunk.is_empty()
            && (chunk.len() >= CHUNK_ENTRY_LIMIT
                || estimated_bytes.saturating_add(entry_bytes) > CHUNK_PAYLOAD_TARGET_BYTES)
        {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            total_entries = total_entries
                .checked_add(write_chunk(file, &mut chunk, cancellation)?)
                .ok_or_else(|| Error::ResourceLimit("search index entry count overflow".into()))?;
            chunk_count = chunk_count
                .checked_add(1)
                .ok_or_else(|| Error::ResourceLimit("search index chunk count overflow".into()))?;
            let position = usize::try_from(file.stream_position()?)
                .map_err(|_| Error::ResourceLimit("search index position overflow".into()))?;
            let _ = write_padding(file, position)?;
            estimated_bytes = 0;
        }
        estimated_bytes = estimated_bytes.saturating_add(entry_bytes);
        chunk.push(entry);
    }
    if !chunk.is_empty() {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        total_entries = total_entries
            .checked_add(write_chunk(file, &mut chunk, cancellation)?)
            .ok_or_else(|| Error::ResourceLimit("search index entry count overflow".into()))?;
        chunk_count = chunk_count
            .checked_add(1)
            .ok_or_else(|| Error::ResourceLimit("search index chunk count overflow".into()))?;
        let position = usize::try_from(file.stream_position()?)
            .map_err(|_| Error::ResourceLimit("search index position overflow".into()))?;
        let _ = write_padding(file, position)?;
    }
    file.seek(SeekFrom::Start(0))?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    write_header(file, source_len, total_entries, chunk_count)?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    Ok(())
}

#[cfg(test)]
impl Default for SearchIndexChunk {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SearchGameEntryRef<'a> {
    pub id: i32,
    pub white_id: i32,
    pub black_id: i32,
    pub date: Option<&'a str>,
    pub result: GameResult,
    pub pawn_home: u16,
    pub white_elo: i16,
    pub black_elo: i16,
    pub fen: Option<&'a str>,
    pub moves: &'a [u8],
}

impl<'a> From<&'a SearchGameEntry> for SearchGameEntryRef<'a> {
    fn from(entry: &'a SearchGameEntry) -> Self {
        Self {
            id: entry.id,
            white_id: entry.white_id,
            black_id: entry.black_id,
            date: entry.date.as_deref(),
            result: entry.result,
            pawn_home: entry.pawn_home,
            white_elo: entry.white_elo,
            black_elo: entry.black_elo,
            fen: entry.fen.as_deref(),
            moves: &entry.moves,
        }
    }
}

impl<'a> From<&'a ArchivedSearchGameEntry> for SearchGameEntryRef<'a> {
    fn from(entry: &'a ArchivedSearchGameEntry) -> Self {
        Self {
            id: entry.id.into(),
            white_id: entry.white_id.into(),
            black_id: entry.black_id.into(),
            date: entry.date.as_ref().map(|date| date.as_str()),
            result: match entry.result {
                ArchivedGameResult::None => GameResult::None,
                ArchivedGameResult::WhiteWin => GameResult::WhiteWin,
                ArchivedGameResult::BlackWin => GameResult::BlackWin,
                ArchivedGameResult::Draw => GameResult::Draw,
                ArchivedGameResult::Other => GameResult::Other,
            },
            pawn_home: entry.pawn_home.into(),
            white_elo: entry.white_elo.into(),
            black_elo: entry.black_elo.into(),
            fen: entry.fen.as_ref().map(|fen| fen.as_str()),
            moves: &entry.moves,
        }
    }
}

pub struct SearchGameData {
    pub id: i32,
    pub white_id: i32,
    pub black_id: i32,
    pub date: Option<String>,
    pub result: Option<String>,
    pub moves: Vec<u8>,
    pub fen: Option<String>,
    pub pawn_home: i32,
    pub white_material: i32,
    pub black_material: i32,
    pub white_elo: Option<i32>,
    pub black_elo: Option<i32>,
}

impl SearchGameEntry {
    pub fn from_game_data(data: SearchGameData) -> Result<Self, Error> {
        Self::from_game_data_cancellable(data, &CancellationToken::new())
    }

    pub(crate) fn from_game_data_cancellable(
        data: SearchGameData,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        crate::db::encoding::try_iter_mainline_move_bytes_cancellable(&data.moves, cancellation)?;
        Ok(Self {
            id: data.id,
            white_id: data.white_id,
            black_id: data.black_id,
            date: data.date,
            result: GameResult::from_str(data.result.as_deref()),
            pawn_home: u16::try_from(data.pawn_home).map_err(|_| {
                Error::InvalidInput(format!("pawn_home out of range: {}", data.pawn_home))
            })?,
            white_material: u8::try_from(data.white_material).map_err(|_| {
                Error::InvalidInput(format!(
                    "white_material out of range: {}",
                    data.white_material
                ))
            })?,
            black_material: u8::try_from(data.black_material).map_err(|_| {
                Error::InvalidInput(format!(
                    "black_material out of range: {}",
                    data.black_material
                ))
            })?,
            white_elo: i16::try_from(data.white_elo.unwrap_or(0)).map_err(|_| {
                Error::InvalidInput(format!("white_elo out of range: {:?}", data.white_elo))
            })?,
            black_elo: i16::try_from(data.black_elo.unwrap_or(0)).map_err(|_| {
                Error::InvalidInput(format!("black_elo out of range: {:?}", data.black_elo))
            })?,
            fen: data.fen,
            moves: data.moves,
        })
    }
}

#[derive(Clone, Debug)]
pub struct MmapSearchIndex {
    /// The mapping owns the bytes. Archive references are created only for an
    /// individual method call, never stored with a fabricated lifetime.
    mmap: Arc<Mmap>,
    entry_count: usize,
    source: IndexSource,
    chunks: Arc<[ChunkMetadata]>,
}

#[derive(Clone, Debug)]
struct ChunkMetadata {
    payload_offset: usize,
    payload_len: usize,
    #[cfg(test)]
    first_entry: usize,
    entry_count: usize,
}

#[cfg(test)]
type MoveValidationHook = Arc<dyn Fn(i32) + Send + Sync>;

#[cfg(test)]
thread_local! {
    static MOVE_VALIDATION_HOOK: std::cell::RefCell<Option<MoveValidationHook>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub(super) struct MoveValidationObserver(Option<MoveValidationHook>);

#[cfg(test)]
impl MoveValidationObserver {
    pub(super) fn install(hook: impl Fn(i32) + Send + Sync + 'static) -> Self {
        Self(MOVE_VALIDATION_HOOK.with(|slot| slot.replace(Some(Arc::new(hook)))))
    }
}

#[cfg(test)]
impl Drop for MoveValidationObserver {
    fn drop(&mut self) {
        MOVE_VALIDATION_HOOK.with(|slot| slot.replace(self.0.take()));
    }
}

impl MmapSearchIndex {
    #[cfg(test)]
    pub fn open<P: AsRef<Path>>(path: P) -> io::Result<Self> {
        Self::open_file(File::open(path)?)
    }

    pub(crate) fn open_file(
        file: impl Into<crate::infra::inode_ownership::OwnedFile>,
    ) -> io::Result<Self> {
        Self::open_file_inner(file.into(), None)
    }

    pub(crate) fn open_file_cancellable(
        file: impl Into<crate::infra::inode_ownership::OwnedFile>,
        cancellation: &CancellationToken,
    ) -> Result<Self, Error> {
        Self::open_file_inner(file.into(), Some(cancellation)).map_err(|error| {
            if error.kind() == io::ErrorKind::Interrupted && cancellation.is_cancelled() {
                Error::Cancellation
            } else {
                Error::from(error)
            }
        })
    }

    fn open_file_inner(
        file: crate::infra::inode_ownership::OwnedFile,
        cancellation: Option<&CancellationToken>,
    ) -> io::Result<Self> {
        let check = |cancellation: Option<&CancellationToken>| {
            if cancellation.is_some_and(CancellationToken::is_cancelled) {
                Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"))
            } else {
                Ok(())
            }
        };
        check(cancellation)?;
        let file_len = checked_usize(file.metadata()?.len(), "archive file length")?;
        if file_len < HEADER_SIZE {
            return Err(invalid_data("File too small for header"));
        }
        // `Mmap::map` is unsafe because callers must retain the mapping. This
        // type owns it, never exposes mutable bytes, and validates every rkyv
        // offset before any archive data is read.
        let mmap = Arc::new(unsafe { Mmap::map(&file)? });
        let (header, source, source_end) = decode_index_source(&mmap, |source_len| {
            mmap.get(HEADER_SIZE..HEADER_SIZE + source_len)
                .ok_or_else(|| invalid_data("truncated index source"))
        })?;

        let mut cursor = source_end;
        let minimum_chunk_bytes = CHUNK_HEADER_SIZE + ARCHIVE_ALIGNMENT;
        if header.chunk_count > mmap.len().saturating_sub(cursor) / minimum_chunk_bytes + 1 {
            return Err(invalid_data("declared chunk count exceeds archive bounds"));
        }
        let mut chunks = Vec::new();
        let mut archived_chunks = Vec::new();
        let mut counted_entries = 0_usize;
        for _ in 0..header.chunk_count {
            check(cancellation)?;
            if cursor % ARCHIVE_ALIGNMENT != 0 {
                return Err(invalid_data("misaligned chunk header"));
            }
            let payload_len = checked_usize(
                read_u64(&mmap, cursor, "chunk payload length")?,
                "chunk payload length",
            )?;
            let entry_count_offset = cursor
                .checked_add(8)
                .ok_or_else(|| invalid_data("chunk entry-count offset overflow"))?;
            let entry_count = checked_usize(
                read_u64(&mmap, entry_count_offset, "chunk entry count")?,
                "chunk entry count",
            )?;
            if payload_len == 0 || entry_count == 0 || entry_count > CHUNK_ENTRY_LIMIT {
                return Err(invalid_data("invalid chunk length or entry count"));
            }
            let payload_offset = cursor
                .checked_add(CHUNK_HEADER_SIZE)
                .ok_or_else(|| invalid_data("chunk payload offset overflow"))?;
            if payload_offset % ARCHIVE_ALIGNMENT != 0 {
                return Err(invalid_data("misaligned chunk payload"));
            }
            let payload_end = payload_offset
                .checked_add(payload_len)
                .ok_or_else(|| invalid_data("chunk payload bounds overflow"))?;
            let payload = mmap
                .get(payload_offset..payload_end)
                .ok_or_else(|| invalid_data("truncated search index chunk"))?;
            if !(payload.as_ptr() as usize).is_multiple_of(ARCHIVE_ALIGNMENT) {
                return Err(invalid_data("misaligned search index chunk"));
            }
            let archived = rkyv::access::<ArchivedSearchIndexChunk, rkyv::rancor::Error>(payload)
                .map_err(|error| {
                invalid_data(format!("invalid search index chunk: {error}"))
            })?;
            if archived.entries.len() != entry_count {
                return Err(invalid_data("chunk entry count does not match payload"));
            }
            archived_chunks.push(archived);
            chunks.push(ChunkMetadata {
                payload_offset,
                payload_len,
                #[cfg(test)]
                first_entry: counted_entries,
                entry_count,
            });
            counted_entries = counted_entries
                .checked_add(entry_count)
                .ok_or_else(|| invalid_data("total entry count overflow"))?;
            cursor = align_up(payload_end)?;
            let padding = mmap
                .get(payload_end..cursor)
                .ok_or_else(|| invalid_data("truncated chunk padding"))?;
            if padding.iter().any(|byte| *byte != 0) {
                return Err(invalid_data("non-zero chunk padding"));
            }
        }
        if counted_entries != header.entry_count {
            return Err(invalid_data("total entry count does not match chunks"));
        }
        if cursor != mmap.len() {
            return Err(invalid_data("trailing bytes after search index chunks"));
        }
        // Rayon stays in the caller's existing blocking job. Each chunk retains
        // sequential entry order, and find_first preserves the first failing
        // chunk while successful opens still validate every entry.
        #[cfg(test)]
        let validation_hook = MOVE_VALIDATION_HOOK.with(|slot| slot.borrow().clone());
        let failure = archived_chunks
            .par_iter()
            .map(|archived| -> io::Result<()> {
                check(cancellation)?;
                // is_cancelled locks token state. A child per active chunk keeps
                // byte-level checks independent while retaining parent cancellation.
                let chunk_cancellation = cancellation.map(CancellationToken::child_token);
                for entry in archived.entries.iter() {
                    #[cfg(test)]
                    if let Some(hook) = &validation_hook {
                        hook(entry.id.into());
                    }
                    check(chunk_cancellation.as_ref())?;
                    let validation = match chunk_cancellation.as_ref() {
                        Some(cancellation) => {
                            crate::db::encoding::try_iter_mainline_move_bytes_cancellable(
                                entry.moves.as_slice(),
                                cancellation,
                            )
                            .map(|_| ())
                        }
                        None => crate::db::encoding::try_iter_mainline_move_bytes(
                            entry.moves.as_slice(),
                        )
                        .map(|_| ()),
                    };
                    validation.map_err(|error| match error {
                        Error::Cancellation => io::Error::new(
                            io::ErrorKind::Interrupted,
                            "search index open cancelled",
                        ),
                        error => invalid_data(format!("invalid move stream: {error}")),
                    })?;
                }
                Ok(())
            })
            .find_first(Result::is_err);
        if let Some(failure) = failure {
            failure?;
        }
        check(cancellation)?;
        Ok(Self {
            mmap,
            entry_count: header.entry_count,
            source,
            chunks: chunks.into(),
        })
    }

    fn archived_chunk(&self, chunk: &ChunkMetadata) -> &ArchivedSearchIndexChunk {
        // `open` fully validates this immutable mapping. The checked access is
        // repeated to keep the lifetime local and avoid self-referential state.
        rkyv::access::<ArchivedSearchIndexChunk, rkyv::rancor::Error>(
            &self.mmap[chunk.payload_offset..chunk.payload_offset + chunk.payload_len],
        )
        .expect("validated immutable search archive")
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.entry_count
    }

    pub fn source(&self) -> &IndexSource {
        &self.source
    }

    // The mapping's borrow remains local to this test-facing accessor.
    #[cfg(test)]
    #[inline]
    pub fn get_entry_ref(&self, index: usize) -> Option<SearchGameEntryRef<'_>> {
        let chunk = self.chunks.iter().find(|chunk| {
            chunk
                .first_entry
                .checked_add(chunk.entry_count)
                .is_some_and(|end| index < end)
        })?;
        self.archived_chunk(chunk)
            .entries
            .get(index - chunk.first_entry)
            .map(SearchGameEntryRef::from)
    }

    // The caller's reference remains tied to the immutable mapping.
    #[cfg(test)]
    pub fn iter(&self) -> SearchIndexIter<'_> {
        SearchIndexIter {
            index: self,
            next: 0,
        }
    }

    pub fn par_iter(&self) -> impl ParallelIterator<Item = SearchGameEntryRef<'_>> + '_ {
        self.chunks.par_iter().flat_map_iter(|chunk| {
            self.archived_chunk(chunk)
                .entries
                .iter()
                .take(chunk.entry_count)
                .map(SearchGameEntryRef::from)
        })
    }

    #[cfg(test)]
    pub fn is_valid<P: AsRef<Path>>(path: P) -> bool {
        Self::open(path).is_ok()
    }
}

#[cfg(test)]
pub struct SearchIndexIter<'a> {
    index: &'a MmapSearchIndex,
    next: usize,
}

#[cfg(test)]
impl<'a> Iterator for SearchIndexIter<'a> {
    type Item = SearchGameEntryRef<'a>;

    fn next(&mut self) -> Option<Self::Item> {
        let entry = self.index.get_entry_ref(self.next)?;
        self.next += 1;
        Some(entry)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        let remaining = self.index.len().saturating_sub(self.next);
        (remaining, Some(remaining))
    }
}

// The iterator's borrowed entries never outlive the mapping.
#[cfg(test)]
impl ExactSizeIterator for SearchIndexIter<'_> {}

#[cfg(test)]
pub fn get_index_path(db_path: &Path) -> PathBuf {
    let filename = db_path
        .file_name()
        .map(preferred_sidecar_leaf)
        .unwrap_or_else(|| "database.ecsi".into());
    db_path.with_file_name(filename)
}

pub(crate) fn preferred_sidecar_leaf(database_leaf: &OsStr) -> OsString {
    let mut leaf = database_leaf.to_os_string();
    leaf.push(".ecsi");
    leaf
}

pub(crate) fn integrity_stamp_leaf(database_leaf: &OsStr) -> OsString {
    let mut leaf = database_leaf.to_os_string();
    leaf.push(".integrity");
    leaf
}

/// Pre-2.0 builds replaced the database extension (`foo.db3` → `foo.ecsi`).
/// Keep discovery separate from new writes, which always use `foo.db3.ecsi`
/// and therefore cannot collide with a database whose base name differs only
/// by extension.
#[cfg(test)]
pub fn legacy_index_path(db_path: &Path) -> PathBuf {
    let filename = db_path
        .file_name()
        .map(legacy_sidecar_leaf)
        .unwrap_or_else(|| "database.ecsi".into());
    db_path.with_file_name(filename)
}

pub(crate) fn legacy_sidecar_leaf(database_leaf: &OsStr) -> OsString {
    Path::new(database_leaf)
        .with_extension("ecsi")
        .into_os_string()
}

pub(crate) struct LegacySidecarProbe {
    pub(crate) file: crate::infra::inode_ownership::OwnedFile,
    pub(crate) identity: (u64, u64),
    pub(crate) source_matches: bool,
}

pub(crate) fn probe_legacy_index_sidecar_at(
    parent: &File,
    leaf: &OsStr,
    expected_source: &IndexSource,
    cancellation: Option<&CancellationToken>,
) -> Result<LegacySidecarProbe, Error> {
    let file = crate::infra::fs::open_regular_at(
        parent,
        leaf,
        crate::infra::fs::RegularFileAccess::ReadOnly,
    )?;
    let identity = crate::infra::path_authority::opened_file_identity(&file)?;
    let archive = match cancellation {
        Some(cancellation) => {
            MmapSearchIndex::open_file_cancellable(file.try_clone()?, cancellation)?
        }
        None => MmapSearchIndex::open_file(file.try_clone()?).map_err(Error::from)?,
    };
    let source_matches = archive.source() == expected_source;
    drop(archive);
    Ok(LegacySidecarProbe {
        file,
        identity,
        source_matches,
    })
}

/// Promotes the pre-2.0 extension-replacing sidecar without ever overwriting
/// an appended sidecar. Only a validated current-version archive whose complete recorded
/// database provenance matches `db_path` is eligible. The new file is
/// atomically published and synced by `atomic_replace_at`; only then is the
/// legacy name removed. If both names are present, the appended name wins and
/// the legacy file is deliberately kept: it may belong to another database
/// with the same stem.
///
/// POSIX does not expose a pathname compare-and-unlink primitive. We retain
/// the opened legacy file and re-check its identity immediately before publish
/// and removal; an external rename in the final check-to-unlink window can
/// still replace that pathname. In that case provenance on every later load
/// forces regeneration, while this bounded filesystem race remains visible
/// rather than being misrepresented as atomic deletion.
#[cfg(all(test, unix))]
pub fn promote_legacy_index_sidecar(db_path: &Path) -> Result<Option<PathBuf>, Error> {
    let database = db_path.canonicalize()?;
    let metadata = database.metadata()?;
    let object = crate::infra::path_authority::opened_file_identity(&File::open(&database)?)?;
    let identity = DatabaseIdentity {
        data_revision: 0,
        object,
        length: metadata.len(),
        modified: metadata.modified()?,
    };
    let (parent, database_leaf) = crate::infra::fs::open_verified_parent(
        &database,
        object,
        false,
        crate::infra::fs::ParentAccess::Readable,
    )?;
    let preferred_leaf = preferred_sidecar_leaf(&database_leaf);
    let legacy_leaf = legacy_sidecar_leaf(&database_leaf);
    Ok(promote_legacy_index_sidecar_at(
        &parent,
        &preferred_leaf,
        &legacy_leaf,
        &identity,
        &CancellationToken::new(),
    )?
    .then(|| database.with_file_name(preferred_leaf)))
}

pub(crate) fn promote_legacy_index_sidecar_at(
    parent: &File,
    preferred_leaf: &OsStr,
    legacy_leaf: &OsStr,
    db_identity: &DatabaseIdentity,
    cancellation: &CancellationToken,
) -> Result<bool, Error> {
    match crate::infra::fs::entry_identity_at(parent, preferred_leaf, false) {
        Ok(_) => return Ok(false),
        Err(error) => {
            match crate::infra::path_authority::classify_probe_error(&error, parent, preferred_leaf)
            {
                crate::infra::path_authority::ProbeErrorClass::NotFound => {}
                crate::infra::path_authority::ProbeErrorClass::Reparse
                | crate::infra::path_authority::ProbeErrorClass::WrongKind
                | crate::infra::path_authority::ProbeErrorClass::Malformed => return Ok(false),
                crate::infra::path_authority::ProbeErrorClass::MappedFile
                | crate::infra::path_authority::ProbeErrorClass::Other => return Err(error),
            }
        }
    }
    let expected = IndexSource::from_database_identity(db_identity)?;
    let probe =
        match probe_legacy_index_sidecar_at(parent, legacy_leaf, &expected, Some(cancellation)) {
            Ok(probe) => probe,
            Err(error) => {
                match crate::infra::path_authority::classify_probe_error(
                    &error,
                    parent,
                    legacy_leaf,
                ) {
                    crate::infra::path_authority::ProbeErrorClass::NotFound
                    | crate::infra::path_authority::ProbeErrorClass::Reparse
                    | crate::infra::path_authority::ProbeErrorClass::WrongKind
                    | crate::infra::path_authority::ProbeErrorClass::Malformed => return Ok(false),
                    crate::infra::path_authority::ProbeErrorClass::MappedFile
                    | crate::infra::path_authority::ProbeErrorClass::Other => return Err(error),
                }
            }
        };
    if !probe.source_matches {
        return Ok(false);
    }
    let mut source = probe.file;
    let legacy_object = probe.identity;
    let outcome = atomic_replace_at(parent, preferred_leaf, |destination| {
        crate::infra::fs::assert_entry_identity(parent, legacy_leaf, legacy_object, false)?;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            if cancellation.is_cancelled() {
                return Err(Error::Cancellation);
            }
            let read = source.read(&mut buffer).map_err(Error::from)?;
            if read == 0 {
                break;
            }
            destination
                .write_all(&buffer[..read])
                .map_err(Error::from)?;
        }
        Ok(())
    })?;
    match outcome {
        AtomicFileOutcome::DurableCommit => {
            crate::infra::fs::remove_entry_at(parent, legacy_leaf, legacy_object, false)?;
            Ok(true)
        }
        AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
            log::warn!("search index parent sync failed: {error}");
            Err(Error::CommittedDurabilityUncertain(
                DurabilityStage::SearchIndexReplacement,
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::infra::fs::open_verified_parent;
    use crate::infra::fs::set_test_atomic_file_injector;
    use tempfile::tempdir;

    #[test]
    fn source_reader_reads_exactly_header_and_source_without_a_mapping_or_chunks() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("source-only.ecsi");
        let source = IndexSource {
            object: (17, 29),
            revision: 3,
            ..IndexSource::default()
        };
        SearchIndexChunk {
            entries: vec![test_entry(1, vec![12, 12])],
        }
        .write_to_with_source(&path, source.clone())
        .unwrap()
        .expect_durable();
        assert_eq!(
            read_index_source(&mut File::open(&path).unwrap()).unwrap(),
            source
        );
        let mut bytes = std::fs::read(&path).unwrap();
        let source_end = HEADER_SIZE + read_u64(&bytes, 8, "source").unwrap() as usize;
        // Corrupt the first chunk while leaving its header and source intact.
        bytes[source_end..source_end + 8].copy_from_slice(&0_u64.to_le_bytes());
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            read_index_source(&mut File::open(&path).unwrap()).unwrap(),
            source
        );
        assert_eq!(
            MmapSearchIndex::open_file(File::open(&path).unwrap())
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        // A cursor has no file handle to map. Its position measures actual bytes consumed.
        let mut reader = io::Cursor::new(bytes.clone());
        assert_eq!(read_index_source(&mut reader).unwrap(), source);
        assert_eq!(reader.position(), source_end as u64);
        bytes.truncate(source_end);
        let mut reader = io::Cursor::new(bytes);
        assert_eq!(read_index_source(&mut reader).unwrap(), source);
        assert_eq!(reader.position(), source_end as u64);
    }

    #[test]
    fn source_reader_rejects_the_same_header_and_source_defects_as_the_mapping() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("source-defects.ecsi");
        SearchIndexChunk::default()
            .write_to_with_source(&path, IndexSource::default())
            .unwrap()
            .expect_durable();
        let valid = std::fs::read(&path).unwrap();
        let mutations: [fn(&mut Vec<u8>); 7] = [
            |bytes| bytes.truncate(HEADER_SIZE - 1),
            |bytes| bytes[0..4].copy_from_slice(b"NOPE"),
            |bytes| bytes[4..8].copy_from_slice(&(VERSION + 1).to_le_bytes()),
            |bytes| {
                bytes.pop();
            },
            |bytes| bytes[8..16].copy_from_slice(&((MAX_SOURCE_BYTES + 1) as u64).to_le_bytes()),
            |bytes| bytes[8..16].copy_from_slice(&17_u64.to_le_bytes()),
            // Valid, aligned and in-bounds length, but too short for IndexSource.
            |bytes| bytes[8..16].copy_from_slice(&16_u64.to_le_bytes()),
        ];
        for mutate in mutations {
            let mut bytes = valid.clone();
            mutate(&mut bytes);
            std::fs::write(&path, &bytes).unwrap();
            let read_error = read_index_source(&mut io::Cursor::new(bytes)).unwrap_err();
            let mapped_error = MmapSearchIndex::open_file(File::open(&path).unwrap()).unwrap_err();
            assert_eq!(read_error.kind(), io::ErrorKind::InvalidData);
            assert_eq!(read_error.kind(), mapped_error.kind());
            let without_addresses = |message: &str| {
                let mut parts = message.split("0x");
                let mut result = parts.next().unwrap_or_default().to_string();
                for part in parts {
                    let digits = part.bytes().take_while(u8::is_ascii_hexdigit).count();
                    if digits == 0 {
                        result.push_str("0x");
                    }
                    result.push_str(&part[digits..]);
                }
                result
            };
            assert_eq!(
                without_addresses(&read_error.to_string()),
                without_addresses(&mapped_error.to_string())
            );
        }
    }

    #[test]
    fn source_reader_preserves_non_truncation_io_errors() {
        struct FailingReader {
            prefix: io::Cursor<Vec<u8>>,
            kind: io::ErrorKind,
        }
        impl Read for FailingReader {
            fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
                if self.prefix.position() == self.prefix.get_ref().len() as u64 {
                    Err(io::Error::new(self.kind, "read failed"))
                } else {
                    self.prefix.read(bytes)
                }
            }
        }
        let dir = tempdir().unwrap();
        let path = dir.path().join("read-errors.ecsi");
        SearchIndexChunk::default()
            .write_to_with_source(&path, IndexSource::default())
            .unwrap()
            .expect_durable();
        let bytes = std::fs::read(&path).unwrap();
        for prefix_len in [0, HEADER_SIZE, HEADER_SIZE + 1] {
            for kind in [io::ErrorKind::PermissionDenied, io::ErrorKind::Other] {
                let mut reader = FailingReader {
                    prefix: io::Cursor::new(bytes[..prefix_len].to_vec()),
                    kind,
                };
                assert_eq!(read_index_source(&mut reader).unwrap_err().kind(), kind);
            }
        }
    }

    #[test]
    fn test_roundtrip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("test.ecsi");

        // Create test entries
        let entries = vec![
            SearchGameEntry {
                id: 1,
                white_id: 100,
                black_id: 200,
                date: Some("2024.01.15".to_string()),
                result: GameResult::WhiteWin,
                pawn_home: 0xFFFF,
                white_material: 39,
                black_material: 39,
                white_elo: 2700,
                black_elo: 2650,
                fen: None,
                moves: vec![12, 12, 9, 9], // e4 e5 Nf3 Nc6
            },
            SearchGameEntry {
                id: 2,
                white_id: 150,
                black_id: 250,
                date: None,
                result: GameResult::Draw,
                pawn_home: 0xF0F0,
                white_material: 30,
                black_material: 28,
                white_elo: 0,
                black_elo: 2400,
                fen: Some(
                    "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2".to_string(),
                ),
                moves: vec![15, 10],
            },
        ];

        // Write
        let index = SearchIndexChunk {
            entries: entries.clone(),
        };
        index.write_to(&path).unwrap();

        // Verify valid
        assert!(MmapSearchIndex::is_valid(&path));

        // Read back using mmap
        let index = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(index.len(), entries.len());

        let archived = index.archived_chunk(&index.chunks[0]);
        for (i, original) in entries.iter().enumerate() {
            let loaded = index.get_entry_ref(i).unwrap();
            assert_eq!(loaded.id, original.id);
            assert_eq!(loaded.white_id, original.white_id);
            assert_eq!(loaded.black_id, original.black_id);
            assert_eq!(loaded.result, original.result);
            assert_eq!(loaded.pawn_home, original.pawn_home);
            assert_eq!(archived.entries[i].white_material, original.white_material);
            assert_eq!(archived.entries[i].black_material, original.black_material);
            assert_eq!(loaded.fen, original.fen.as_deref());
            assert_eq!(loaded.moves, original.moves);
        }

        // Test iterator
        let loaded_vec: Vec<_> = index.iter().collect();
        assert_eq!(loaded_vec.len(), entries.len());
    }

    #[test]
    fn test_game_result_encoding() {
        assert_eq!(GameResult::from_str(Some("1-0")), GameResult::WhiteWin);
        assert_eq!(GameResult::from_str(Some("0-1")), GameResult::BlackWin);
        assert_eq!(GameResult::from_str(Some("1/2-1/2")), GameResult::Draw);
        assert_eq!(GameResult::from_str(Some("*")), GameResult::Other);
        assert_eq!(GameResult::from_str(None), GameResult::None);

        assert_eq!(GameResult::WhiteWin.to_str(), Some("1-0"));
        assert_eq!(GameResult::BlackWin.to_str(), Some("0-1"));
        assert_eq!(GameResult::Draw.to_str(), Some("1/2-1/2"));
        assert_eq!(GameResult::None.to_str(), None);
    }

    #[test]
    fn test_large_index() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("large.ecsi");

        let results = [
            GameResult::None,
            GameResult::WhiteWin,
            GameResult::BlackWin,
            GameResult::Draw,
            GameResult::Other,
        ];

        // Create many entries
        let mut index = SearchIndexChunk::with_capacity(1000);
        for i in 0..1000 {
            index.push(SearchGameEntry {
                id: i,
                white_id: i * 2,
                black_id: i * 2 + 1,
                date: if i % 2 == 0 {
                    Some("2024.01.15".to_string())
                } else {
                    None
                },
                result: results[(i % 5) as usize],
                pawn_home: 0xFFFF,
                white_material: 39,
                black_material: 39,
                white_elo: 2000 + (i % 800) as i16,
                black_elo: 1900 + (i % 700) as i16,
                fen: if i % 3 == 0 {
                    Some("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1".to_string())
                } else {
                    None
                },
                moves: vec![12, 12, 9, 9],
            });
        }
        index.write_to(&path).unwrap();

        // Load with mmap
        let index = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(index.len(), 1000);

        // Verify random access
        let entry = index.get_entry_ref(500).unwrap();
        assert_eq!(entry.id, 500);
        assert_eq!(entry.white_id, 1000);
        assert_eq!(entry.black_id, 1001);
    }

    #[test]
    fn test_parallel_iteration() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("parallel.ecsi");

        let mut index = SearchIndexChunk::with_capacity(100);
        for i in 0..100 {
            index.push(SearchGameEntry {
                id: i,
                white_id: i,
                black_id: i,
                date: None,
                result: GameResult::None,
                pawn_home: 0,
                white_material: 0,
                black_material: 0,
                white_elo: 0,
                black_elo: 0,
                fen: None,
                moves: vec![],
            });
        }
        index.write_to(&path).unwrap();

        let mmap_index = MmapSearchIndex::open(&path).unwrap();

        // Test parallel iteration
        let sum: i32 = mmap_index.par_iter().map(|e| e.id).sum();
        assert_eq!(sum, (0..100i32).sum::<i32>());
    }

    fn test_entry(id: i32, moves: Vec<u8>) -> SearchGameEntry {
        SearchGameEntry {
            id,
            white_id: id.saturating_mul(2),
            black_id: id.saturating_mul(2).saturating_add(1),
            date: Some(format!("2026.09.{:02}", id.rem_euclid(30) + 1)),
            result: GameResult::Draw,
            pawn_home: 0x0f0f,
            white_material: 31,
            black_material: 30,
            white_elo: 2_100,
            black_elo: 2_000,
            fen: None,
            moves,
        }
    }

    #[test]
    fn chunked_roundtrip_preserves_sequential_and_parallel_order() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chunks.ecsi");
        let entries = (0..CHUNK_ENTRY_LIMIT + 17)
            .map(|id| test_entry(i32::try_from(id).unwrap(), vec![12, 12, 9, 9]))
            .collect::<Vec<_>>();
        SearchIndexChunk {
            entries: entries.clone(),
        }
        .write_to(&path)
        .unwrap();

        let mapped = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(mapped.chunks.len(), 2);
        assert!(mapped
            .chunks
            .iter()
            .all(|chunk| chunk.entry_count <= CHUNK_ENTRY_LIMIT));
        let sequential = mapped.iter().map(|entry| entry.id).collect::<Vec<_>>();
        let parallel = mapped.par_iter().map(|entry| entry.id).collect::<Vec<_>>();
        let expected = entries.iter().map(|entry| entry.id).collect::<Vec<_>>();
        assert_eq!(sequential, expected);
        assert_eq!(parallel, expected);
        let borrowed = mapped.get_entry_ref(CHUNK_ENTRY_LIMIT).unwrap().moves;
        let mapping =
            mapped.mmap.as_ptr() as usize..mapped.mmap.as_ptr() as usize + mapped.mmap.len();
        assert!(mapping.contains(&(borrowed.as_ptr() as usize)));
    }

    #[test]
    fn parallel_open_validates_every_entry_and_rejects_corruption_in_every_chunk() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = tempdir().unwrap();
        let path = dir.path().join("validation.ecsi");
        let total = CHUNK_ENTRY_LIMIT * 2 + 1;
        SearchIndexChunk {
            entries: (0..total)
                .map(|id| test_entry(id as i32, vec![12, 12]))
                .collect(),
        }
        .write_to(&path)
        .unwrap();
        let counts = Arc::new((0..total).map(|_| AtomicUsize::new(0)).collect::<Vec<_>>());
        let observed = Arc::clone(&counts);
        let observer = MoveValidationObserver::install(move |id| {
            observed[id as usize].fetch_add(1, Ordering::SeqCst);
        });
        let mapped = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(mapped.chunks.len(), 3);
        assert!(counts.iter().all(|count| count.load(Ordering::SeqCst) == 1));
        drop(observer);
        let original = std::fs::read(&path).unwrap();
        for chunk in mapped.chunks.iter() {
            let entry = mapped.get_entry_ref(chunk.first_entry).unwrap();
            let offset = entry.moves.as_ptr() as usize - mapped.mmap.as_ptr() as usize;
            let mut corrupt = original.clone();
            corrupt[offset..offset + 2].copy_from_slice(&[crate::db::encoding::NAG_MARKER, 1]);
            let broken = dir.path().join("broken.ecsi");
            std::fs::write(&broken, corrupt).unwrap();
            let error = MmapSearchIndex::open(&broken).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert!(error.to_string().starts_with("invalid move stream:"));
            assert!(matches!(
                MmapSearchIndex::open_file_cancellable(File::open(&broken).unwrap(), &CancellationToken::new()),
                Err(Error::Io(error)) if error.kind() == io::ErrorKind::InvalidData
            ));
        }
    }

    #[test]
    fn parallel_open_cancellation_interrupts_validation_without_publishing_a_mapping() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cancel.ecsi");
        SearchIndexChunk {
            entries: (0..CHUNK_ENTRY_LIMIT + 1)
                .map(|id| test_entry(id as i32, vec![12, 12]))
                .collect(),
        }
        .write_to(&path)
        .unwrap();
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let _observer = MoveValidationObserver::install(move |_| token.cancel());
        let interrupted = MmapSearchIndex::open_file_inner(
            File::open(&path).unwrap().into(),
            Some(&cancellation),
        )
        .unwrap_err();
        assert_eq!(interrupted.kind(), io::ErrorKind::Interrupted);
        let cancellation = CancellationToken::new();
        let token = cancellation.clone();
        let _observer = MoveValidationObserver::install(move |_| token.cancel());
        assert!(matches!(
            MmapSearchIndex::open_file_cancellable(File::open(path).unwrap(), &cancellation),
            Err(Error::Cancellation)
        ));
    }

    struct ObservedArchiveWriter {
        inner: std::io::Cursor<Vec<u8>>,
        produced: Arc<std::sync::atomic::AtomicUsize>,
        first_chunk_write_at: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Write for ObservedArchiveWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            let produced = self.produced.load(std::sync::atomic::Ordering::Relaxed);
            if produced > 0 {
                let _ = self.first_chunk_write_at.compare_exchange(
                    usize::MAX,
                    produced,
                    std::sync::atomic::Ordering::Relaxed,
                    std::sync::atomic::Ordering::Relaxed,
                );
            }
            self.inner.write(bytes)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.inner.flush()
        }
    }

    impl Seek for ObservedArchiveWriter {
        fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
            self.inner.seek(position)
        }
    }

    #[test]
    fn production_writer_publishes_a_chunk_before_exhausting_its_input() {
        let total = CHUNK_ENTRY_LIMIT * 2 + 1;
        let produced = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let first_chunk_write_at = Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX));
        let counter = Arc::clone(&produced);
        let rows = (0..total).map(move |id| {
            counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Ok(test_entry(i32::try_from(id).unwrap(), vec![]))
        });
        let mut writer = ObservedArchiveWriter {
            inner: std::io::Cursor::new(Vec::new()),
            produced: Arc::clone(&produced),
            first_chunk_write_at: Arc::clone(&first_chunk_write_at),
        };
        write_chunked_archive(&mut writer, IndexSource::default(), rows).unwrap();

        assert_eq!(produced.load(std::sync::atomic::Ordering::Relaxed), total);
        assert!(
            first_chunk_write_at.load(std::sync::atomic::Ordering::Relaxed)
                <= CHUNK_ENTRY_LIMIT + 1
        );
    }

    #[test]
    fn oversized_entry_gets_its_own_chunk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("oversized.ecsi");
        SearchIndexChunk {
            entries: vec![
                test_entry(1, vec![7; CHUNK_PAYLOAD_TARGET_BYTES + 1]),
                test_entry(2, vec![8]),
            ],
        }
        .write_to(&path)
        .unwrap();
        let mapped = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(mapped.chunks.len(), 2);
        assert_eq!(mapped.chunks[0].entry_count, 1);
        assert_eq!(
            mapped.get_entry_ref(0).unwrap().moves.len(),
            CHUNK_PAYLOAD_TARGET_BYTES + 1
        );
        assert_eq!(mapped.get_entry_ref(1).unwrap().moves, &[8]);
    }

    #[test]
    fn empty_archive_has_source_without_chunks() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty.ecsi");
        SearchIndexChunk::default().write_to(&path).unwrap();
        let mapped = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(mapped.len(), 0);
        assert!(mapped.chunks.is_empty());
        assert_eq!(mapped.iter().len(), 0);
    }

    #[test]
    fn framing_rejects_corrupt_counts_lengths_alignment_and_trailing_bytes() {
        fn mutate_valid(mutator: impl FnOnce(&mut Vec<u8>)) -> io::Error {
            let dir = tempdir().unwrap();
            let path = dir.path().join("mutated.ecsi");
            SearchIndexChunk {
                entries: vec![test_entry(1, vec![12, 12])],
            }
            .write_to(&path)
            .unwrap();
            let mut bytes = std::fs::read(&path).unwrap();
            mutator(&mut bytes);
            std::fs::write(&path, bytes).unwrap();
            MmapSearchIndex::open(&path).unwrap_err()
        }

        assert_eq!(
            mutate_valid(|bytes| bytes[4..8].copy_from_slice(&6_u32.to_le_bytes())).kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| bytes[8..16].copy_from_slice(&u64::MAX.to_le_bytes())).kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| {
                bytes[8..16].copy_from_slice(&((MAX_SOURCE_BYTES + 1) as u64).to_le_bytes())
            })
            .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| {
                let source_len = read_u64(bytes, 8, "source").unwrap() as usize;
                bytes[8..16].copy_from_slice(&((source_len + 1) as u64).to_le_bytes());
            })
            .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| bytes[16..24].copy_from_slice(&2_u64.to_le_bytes())).kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| {
                let source_len = read_u64(bytes, 8, "source").unwrap() as usize;
                let chunk = align_up(HEADER_SIZE + source_len).unwrap();
                bytes[chunk + 8..chunk + 16].copy_from_slice(&2_u64.to_le_bytes());
            })
            .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| {
                let source_len = read_u64(bytes, 8, "source").unwrap() as usize;
                let chunk = align_up(HEADER_SIZE + source_len).unwrap();
                bytes[chunk..chunk + 8].copy_from_slice(&u64::MAX.to_le_bytes());
            })
            .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| {
                bytes.pop();
            })
            .kind(),
            io::ErrorKind::InvalidData
        );
        assert_eq!(
            mutate_valid(|bytes| bytes.push(1)).kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn rejects_misaligned_source_length_from_an_emitted_archive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("source-alignment.ecsi");
        SearchIndexChunk::default().write_to(&path).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        let source_len = read_u64(&bytes, 8, "source").unwrap();
        assert_eq!(source_len % ARCHIVE_ALIGNMENT as u64, 0);
        bytes[8..16].copy_from_slice(&(source_len - 1).to_le_bytes());
        std::fs::write(&path, bytes).unwrap();

        assert_eq!(
            MmapSearchIndex::open(&path)
                .expect_err("misaligned source length must fail")
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn rejects_nonzero_chunk_padding_from_an_emitted_archive() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("chunk-padding.ecsi");
        let mut padding_offset = None;
        for move_bytes in 0..ARCHIVE_ALIGNMENT {
            SearchIndexChunk {
                entries: vec![test_entry(1, vec![0; move_bytes])],
            }
            .write_to(&path)
            .unwrap();
            let bytes = std::fs::read(&path).unwrap();
            let source_len = read_u64(&bytes, 8, "source").unwrap() as usize;
            let chunk_header = align_up(HEADER_SIZE + source_len).unwrap();
            let payload_len = read_u64(&bytes, chunk_header, "payload").unwrap() as usize;
            let payload_end = chunk_header + CHUNK_HEADER_SIZE + payload_len;
            if payload_end < align_up(payload_end).unwrap() {
                padding_offset = Some(payload_end);
                break;
            }
        }
        let padding_offset = padding_offset.expect("fixture must force chunk padding");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[padding_offset] = 1;
        std::fs::write(&path, bytes).unwrap();

        assert_eq!(
            MmapSearchIndex::open(&path)
                .expect_err("nonzero chunk padding must fail")
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn iterator_failure_preserves_the_previous_index() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("atomic.ecsi");
        SearchIndexChunk {
            entries: vec![test_entry(7, vec![])],
        }
        .write_to(&path)
        .unwrap();
        #[cfg(unix)]
        let parent = File::open(dir.path()).unwrap();
        #[cfg(windows)]
        let parent = crate::infra::fs::windows_test_parent(dir.path());
        let rows = vec![
            Ok(test_entry(8, vec![])),
            Err(Error::InvalidInput("injected row failure".into())),
        ];
        let result = write_entries_to_at(
            &parent,
            OsStr::new("atomic.ecsi"),
            IndexSource::default(),
            rows,
            &CancellationToken::new(),
        );
        assert!(matches!(result, Err(Error::InvalidInput(_))));
        let mapped = MmapSearchIndex::open(&path).unwrap();
        assert_eq!(mapped.get_entry_ref(0).unwrap().id, 7);
    }

    #[cfg(unix)]
    #[test]
    fn operational_open_failure_is_not_reclassified_as_invalid_archive() {
        let dir = tempdir().unwrap();
        let error = MmapSearchIndex::open(dir.path()).unwrap_err();
        assert_ne!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn rejects_truncated_or_corrupt_archives() {
        let dir = tempdir().unwrap();
        let truncated = dir.path().join("truncated.ecsi");
        std::fs::write(
            &truncated,
            [MAGIC.as_slice(), &VERSION.to_le_bytes()].concat(),
        )
        .unwrap();
        let error = MmapSearchIndex::open(&truncated).expect_err("truncated archive must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let corrupt = dir.path().join("corrupt.ecsi");
        std::fs::write(
            &corrupt,
            [MAGIC.as_slice(), &VERSION.to_le_bytes(), &[0xff; 32]].concat(),
        )
        .unwrap();
        let error = MmapSearchIndex::open(&corrupt).expect_err("corrupt archive must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(!MmapSearchIndex::is_valid(&corrupt));
    }

    #[test]
    fn rejects_out_of_range_database_values() {
        let error = SearchGameEntry::from_game_data(SearchGameData {
            id: 1,
            white_id: 2,
            black_id: 3,
            date: None,
            result: None,
            moves: vec![],
            fen: None,
            pawn_home: -1,
            white_material: 39,
            black_material: 39,
            white_elo: Some(2_000),
            black_elo: Some(2_000),
        })
        .unwrap_err();
        assert!(matches!(error, Error::InvalidInput(_)));
    }

    #[test]
    fn atomic_write_never_leaves_a_partial_replacement() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("atomic.ecsi");
        let first = SearchIndexChunk::default();
        first.write_to(&path).unwrap();
        let second = SearchIndexChunk::with_capacity(1);
        second.write_to(&path).unwrap();
        assert!(MmapSearchIndex::is_valid(&path));
    }

    #[test]
    fn sidecar_appends_instead_of_replacing_database_extension() {
        let database = Path::new("/tmp/opening.db3");
        assert_eq!(
            get_index_path(database),
            PathBuf::from("/tmp/opening.db3.ecsi")
        );
        assert_eq!(
            legacy_index_path(database),
            PathBuf::from("/tmp/opening.ecsi")
        );
        assert_ne!(
            get_index_path(Path::new("/tmp/opening.db")),
            get_index_path(database)
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_sidecar_is_atomically_promoted_without_overwriting_a_collision() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let database = dir.path().join("games.db3");
        std::fs::write(&database, b"database").unwrap();
        let legacy = legacy_index_path(&database);
        let source = IndexSource::from_database(&database, 0).unwrap();
        SearchIndexChunk::default()
            .write_to_with_source(&legacy, source)
            .unwrap()
            .expect_durable();
        let preferred = get_index_path(&database);
        assert_eq!(
            promote_legacy_index_sidecar(&database).unwrap(),
            Some(preferred.clone())
        );
        assert!(MmapSearchIndex::open(&preferred).is_ok());
        assert!(!legacy.exists());

        let collision_database = dir.path().join("other.db3");
        std::fs::write(&collision_database, b"database").unwrap();
        let collision_legacy = legacy_index_path(&collision_database);
        let collision_preferred = get_index_path(&collision_database);
        SearchIndexChunk::default()
            .write_to_with_source(
                &collision_legacy,
                IndexSource::from_database(&collision_database, 0).unwrap(),
            )
            .unwrap()
            .expect_durable();
        std::fs::write(&collision_preferred, b"preferred").unwrap();
        assert_eq!(
            promote_legacy_index_sidecar(&collision_database).unwrap(),
            None
        );
        assert_eq!(std::fs::read(&collision_preferred).unwrap(), b"preferred");
        assert!(collision_legacy.exists());

        for preferred_kind in ["directory", "symlink"] {
            let database = dir.path().join(format!("{preferred_kind}.db3"));
            std::fs::write(&database, b"database").unwrap();
            let legacy = legacy_index_path(&database);
            SearchIndexChunk::default()
                .write_to_with_source(&legacy, IndexSource::from_database(&database, 0).unwrap())
                .unwrap()
                .expect_durable();
            let preferred = get_index_path(&database);
            if preferred_kind == "directory" {
                std::fs::create_dir(&preferred).unwrap();
            } else {
                let outside = dir.path().join("preferred-target");
                std::fs::write(&outside, b"preferred").unwrap();
                symlink(&outside, &preferred).unwrap();
            }

            assert_eq!(promote_legacy_index_sidecar(&database).unwrap(), None);
            assert!(preferred.exists());
            assert!(legacy.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn search_index_promotion_parent_sync_keeps_legacy_sidecar() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("uncertain.db3");
        std::fs::write(&database, b"database").unwrap();
        let metadata = database.metadata().unwrap();
        let object =
            crate::infra::path_authority::opened_file_identity(&File::open(&database).unwrap())
                .unwrap();
        let identity = DatabaseIdentity {
            data_revision: 0,
            object,
            length: metadata.len(),
            modified: metadata.modified().unwrap(),
        };
        let legacy = legacy_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(
                &legacy,
                IndexSource::from_database_identity(&identity).unwrap(),
            )
            .unwrap()
            .expect_durable();
        let (parent, database_leaf) = open_verified_parent(
            &database,
            object,
            false,
            crate::infra::fs::ParentAccess::Readable,
        )
        .unwrap();
        let preferred_leaf = preferred_sidecar_leaf(&database_leaf);
        let legacy_leaf = legacy_sidecar_leaf(&database_leaf);

        set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
            "injected parent sync failure",
        ))));
        let result = promote_legacy_index_sidecar_at(
            &parent,
            &preferred_leaf,
            &legacy_leaf,
            &identity,
            &CancellationToken::new(),
        );
        set_test_atomic_file_injector(None);

        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                DurabilityStage::SearchIndexReplacement
            ))
        ));
        assert!(database.with_file_name(preferred_leaf).exists());
        assert!(legacy.exists());
    }

    #[test]
    fn search_index_write_to_reports_uncertain_parent_sync() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("uncertain.ecsi");
        set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
            "injected parent sync failure",
        ))));
        let result = SearchIndexChunk::default().write_to(&path);
        set_test_atomic_file_injector(None);

        assert!(matches!(
            result,
            Err(Error::CommittedDurabilityUncertain(
                DurabilityStage::SearchIndexReplacement
            ))
        ));
        assert!(path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn search_index_write_to_at_refuses_substituted_symlink() {
        use std::os::unix::fs::symlink;

        let dir = tempdir().unwrap();
        let outside = dir.path().join("outside");
        std::fs::write(&outside, b"outside").unwrap();
        let parent = File::open(dir.path()).unwrap();
        let leaf = OsStr::new("database.db3.ecsi");
        symlink(&outside, dir.path().join(leaf)).unwrap();

        let result = write_entries_to_at(
            &parent,
            leaf,
            IndexSource::default(),
            std::iter::empty(),
            &CancellationToken::new(),
        );
        assert!(matches!(result, Err(Error::InvalidInput(_))));
        assert_eq!(std::fs::read(&outside).unwrap(), b"outside");
    }

    #[cfg(unix)]
    #[test]
    fn same_stem_legacy_sidecar_is_not_promoted_for_another_database_object() {
        let dir = tempdir().unwrap();
        let db3 = dir.path().join("foo.db3");
        let sqlite = dir.path().join("foo.sqlite");
        std::fs::write(&db3, b"db3").unwrap();
        std::fs::write(&sqlite, b"sqlite").unwrap();
        let shared_legacy = legacy_index_path(&db3);
        assert_eq!(shared_legacy, legacy_index_path(&sqlite));
        SearchIndexChunk::default()
            .write_to_with_source(&shared_legacy, IndexSource::from_database(&db3, 0).unwrap())
            .unwrap()
            .expect_durable();

        assert_eq!(promote_legacy_index_sidecar(&sqlite).unwrap(), None);
        assert!(shared_legacy.exists());
        assert!(!get_index_path(&sqlite).exists());
    }

    #[cfg(unix)]
    #[test]
    fn promote_skips_a_legacy_directory_and_unreadable_bytes() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("games.db3");
        std::fs::write(&database, b"database").unwrap();
        let legacy = legacy_index_path(&database);
        std::fs::create_dir(&legacy).unwrap();
        assert_eq!(promote_legacy_index_sidecar(&database).unwrap(), None);
        std::fs::remove_dir(&legacy).unwrap();
        std::fs::write(&legacy, b"not an archive").unwrap();
        assert_eq!(promote_legacy_index_sidecar(&database).unwrap(), None);
        assert!(legacy.exists());
        assert!(!get_index_path(&database).exists());
    }

    #[cfg(unix)]
    #[test]
    fn unprovenanced_legacy_sidecar_is_left_for_regeneration() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("old.db3");
        std::fs::write(&database, b"database").unwrap();
        let legacy = legacy_index_path(&database);
        std::fs::write(&legacy, b"pre-v5 archive").unwrap();
        assert_eq!(promote_legacy_index_sidecar(&database).unwrap(), None);
        assert!(legacy.exists());
        assert!(!get_index_path(&database).exists());
    }

    #[test]
    fn archive_source_roundtrips_with_the_index() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("source.db3");
        std::fs::write(&database, b"database").unwrap();
        let source = IndexSource::from_database(&database, 9).unwrap();
        let path = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&path, source.clone())
            .unwrap()
            .expect_durable();
        assert_eq!(MmapSearchIndex::open(&path).unwrap().source(), &source);
    }

    #[test]
    fn replacement_database_has_a_distinct_object_identity() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("replacement.db3");
        let replacement = dir.path().join("replacement.tmp");
        std::fs::write(&database, b"same-size").unwrap();
        let before = IndexSource::from_database(&database, 0).unwrap();
        std::fs::write(&replacement, b"same-size").unwrap();
        std::fs::rename(&replacement, &database).unwrap();
        let after = IndexSource::from_database(&database, 0).unwrap();
        assert_eq!(before.database_length, after.database_length);
        assert_ne!(before.object, after.object);
        assert_ne!(before, after);
    }

    #[cfg(unix)]
    #[test]
    fn sources_with_the_same_identity_are_equal_without_a_pathname() {
        let first = IndexSource {
            object: (1, 2),
            revision: 7,
            database_length: 42,
            database_modified_nanos: 99,
        };
        let second = first.clone();
        assert_eq!(first, second);
    }

    #[test]
    fn version_7_header_is_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("v7.ecsi");
        SearchIndexChunk::default().write_to(&path).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[4..8], &8_u32.to_le_bytes());
        bytes[4..8].copy_from_slice(&7_u32.to_le_bytes());
        std::fs::write(&path, bytes).unwrap();
        let error = MmapSearchIndex::open(&path).expect_err("v7 must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        assert!(error.to_string().contains("Unsupported version"));
    }

    struct MappedSidecarCase {
        _dir: tempfile::TempDir,
        database: PathBuf,
        sidecar: PathBuf,
    }

    impl MappedSidecarCase {
        fn new() -> Self {
            let dir = tempdir().unwrap();
            let database = dir.path().join("games.db3");
            std::fs::write(&database, b"database").unwrap();
            let sidecar = get_index_path(&database);
            SearchIndexChunk {
                entries: vec![test_entry(1, vec![])],
            }
            .write_to(&sidecar)
            .unwrap();
            Self {
                _dir: dir,
                database,
                sidecar,
            }
        }

        fn parent(&self) -> File {
            #[cfg(unix)]
            let parent = File::open(self.database.parent().unwrap()).unwrap();
            #[cfg(windows)]
            let parent = crate::infra::fs::windows_test_parent(self.database.parent().unwrap());
            parent
        }

        fn leaf(&self) -> OsString {
            self.sidecar.file_name().unwrap().to_owned()
        }

        /// A mapping of the sidecar, standing in for a mapper outside this process,
        /// with the bytes it mapped. The file handle is returned for its identity.
        fn mapped_external(&self) -> (File, Mmap, Vec<u8>) {
            let before = std::fs::read(&self.sidecar).unwrap();
            let external = File::open(&self.sidecar).unwrap();
            let mapped = unsafe { Mmap::map(&external) }.unwrap();
            (external, mapped, before)
        }

        fn first_id(&self) -> i32 {
            MmapSearchIndex::open(&self.sidecar)
                .unwrap()
                .get_entry_ref(0)
                .unwrap()
                .id
        }
    }

    /// Runs a single descriptor-relative generation mutation.
    fn plain_generation(
        parent: &File,
        leaf: &OsStr,
        token: &CancellationToken,
    ) -> Result<AtomicFileOutcome, Error> {
        write_entries_to_at(
            parent,
            leaf,
            IndexSource::default(),
            vec![Ok(test_entry(2, vec![]))],
            token,
        )
    }

    /// The replace is a rename onto the leaf (POSIX semantics on Windows too), so it commits in one
    /// attempt and the mapper keeps the generation it mapped. `ERROR_USER_MAPPED_FILE` was the
    /// assumed Windows outcome until the runner measured a durable commit (`f-20260918-03`).
    #[test]
    fn search_index_external_mapper_keeps_its_generation_across_one_replace() {
        struct MutateAttempts(std::sync::atomic::AtomicUsize);

        impl crate::infra::fs::AtomicWriterInjector for MutateAttempts {
            fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> io::Result<()> {
                if point == crate::infra::fs::AtomicFileFaultPoint::TempfileCreate {
                    self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
                Ok(())
            }
        }

        let case = MappedSidecarCase::new();
        let (_external, mapped, before) = case.mapped_external();
        let attempts = Arc::new(MutateAttempts(std::sync::atomic::AtomicUsize::new(0)));
        set_test_atomic_file_injector(Some(attempts.clone()));
        let result = plain_generation(&case.parent(), &case.leaf(), &CancellationToken::new());
        set_test_atomic_file_injector(None);

        assert!(result.is_ok(), "{result:?}");
        assert_eq!(attempts.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(&mapped[..], before.as_slice());
        assert_ne!(std::fs::read(&case.sidecar).unwrap(), before);
        assert_eq!(case.first_id(), 2);
    }

    /// The delete counterpart: removing the leaf under a live mapping unlinks the name and
    /// leaves the mapper its bytes.
    #[test]
    fn search_index_external_mapper_keeps_its_generation_across_unlink() {
        let case = MappedSidecarCase::new();
        let (external, mapped, before) = case.mapped_external();
        let object = crate::infra::path_authority::opened_file_identity(&external).unwrap();

        let removed =
            crate::infra::fs::remove_entry_at(&case.parent(), &case.leaf(), object, false);

        assert!(removed.is_ok(), "{removed:?}");
        assert!(!case.sidecar.exists());
        assert_eq!(&mapped[..], before.as_slice());

        let recreated = plain_generation(&case.parent(), &case.leaf(), &CancellationToken::new());
        assert!(recreated.is_ok(), "{recreated:?}");
        assert_eq!(case.first_id(), 2);
        assert_eq!(&mapped[..], before.as_slice());
    }

    #[test]
    fn v8_archive_contains_no_pathname_bytes() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("PATHMARK-v8-test.db3");
        std::fs::write(&database, b"database").unwrap();
        let path = get_index_path(&database);
        SearchIndexChunk::default()
            .write_to_with_source(&path, IndexSource::from_database(&database, 4).unwrap())
            .unwrap()
            .expect_durable();
        let bytes = std::fs::read(path).unwrap();
        assert!(!bytes
            .windows(b"PATHMARK-v8-test".len())
            .any(|window| window == b"PATHMARK-v8-test"));
    }
}
