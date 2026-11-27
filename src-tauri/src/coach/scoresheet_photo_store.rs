//! Content-addressed native store for scoresheet photos.
//!
//! Photos live as regular JPEG files named by the 64-character lowercase hex SHA-256 digest of
//! their bytes inside the private app-owned `scoresheet-photos` root (`0o700` on Unix). All I/O
//! stays descriptor-relative through [`AuthorizedDir`], never follows symlinks, bounds reads to
//! [`MAX_OUTPUT_JPEG_BYTES`], and writes durably through atomic replacement.
//!
//! Store, read, and the background orphan sweep's delete step are serialized by one process-wide
//! lock ([`lock_store`]) acquired only inside synchronous blocking work, never across `.await`.

use std::{
    ffi::OsStr,
    fmt,
    io::Write,
    path::Path,
    sync::{Mutex, MutexGuard, PoisonError},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;
use tokio_util::sync::CancellationToken;

use super::scoresheet_photo::{encode_jpeg_data_url, MAX_OUTPUT_JPEG_BYTES, MAX_SCORESHEET_PHOTOS};
use crate::{
    error::Error,
    infra::{
        blocking::BLOCKING_GATEWAY,
        fs::{read_bounded_bytes, AtomicFileOutcome},
        path_authority::{
            ensure_app_owned_default_dir, AppDataDir, AppOwnedDefaultRoot, AuthorizedDir,
        },
        validation::{detect_allowed_raster_format, validate_image_data_url, RasterFormat},
    },
};

/// Exact length of a valid photo id: 32 SHA-256 bytes encoded as lowercase hex.
pub(crate) const PHOTO_ID_HEX_LEN: usize = 64;

/// PGN header tag name carrying a game's comma-separated scoresheet photo ids.
pub(crate) const SCORESHEET_PHOTOS_TAG: &str = "ScoresheetPhotos";

/// Maximum byte length of a valid `ScoresheetPhotos` PGN tag value (4 × 64 hex chars + 3 commas).
pub(crate) const MAX_SCORESHEET_PHOTOS_TAG_LEN: usize =
    MAX_SCORESHEET_PHOTOS * PHOTO_ID_HEX_LEN + (MAX_SCORESHEET_PHOTOS - 1);

/// Process-wide serialization lock shared by `store`, `read`, and the orphan sweep's delete step.
/// Never held across `.await`.
static PHOTO_STORE_LOCK: Mutex<()> = Mutex::new(());

/// Acquires the process-wide serialization lock shared by store, read, and sweep deletion.
pub(crate) fn lock_store() -> MutexGuard<'static, ()> {
    PHOTO_STORE_LOCK
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// Module-local, closed, path-free error type for the scoresheet photo store.
/// IPC commands map this to a closed `CoachError` variant without exposing filesystem paths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PhotoStoreError {
    /// Batch size is outside `1..=MAX_SCORESHEET_PHOTOS`, a data URL is malformed or not a
    /// bounded JPEG, or a photo id is not 64 lowercase hex characters.
    InvalidInput,
    /// The operation was cancelled via its cancellation token.
    Cancelled,
    /// Opening the app-owned root or durably writing a photo leaf failed.
    Storage,
}

impl fmt::Display for PhotoStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput => f.write_str("invalid scoresheet photo input"),
            Self::Cancelled => f.write_str("scoresheet photo operation cancelled"),
            Self::Storage => f.write_str("scoresheet photo storage failed"),
        }
    }
}

impl std::error::Error for PhotoStoreError {}

/// Outcome for one requested photo id in a [`read_photos`] batch.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum StoredPhotoRead {
    #[serde(rename_all = "camelCase")]
    Ok {
        data_url: String,
    },
    Missing,
    Unreadable,
}

/// Whether `id` is a valid content-addressed photo id (exactly 64 lowercase ASCII hex digits).
/// A photo reference is never treated as a path.
pub(crate) fn is_valid_photo_id(id: &str) -> bool {
    id.len() == PHOTO_ID_HEX_LEN
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Strictly validates an untrusted `ScoresheetPhotos` PGN tag value (1–4 comma-separated lowercase
/// 64-hex photo ids, bounded length). Returns `Some(raw)` when valid, or `None` when absent or
/// malformed.
pub(crate) fn validate_scoresheet_photos_tag(raw: &str) -> Option<&str> {
    if raw.is_empty() || raw.len() > MAX_SCORESHEET_PHOTOS_TAG_LEN {
        return None;
    }
    let mut count = 0usize;
    for part in raw.split(',') {
        count += 1;
        if count > MAX_SCORESHEET_PHOTOS || !is_valid_photo_id(part) {
            return None;
        }
    }
    Some(raw)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn validate_store_batch(photos: &[String]) -> Result<Vec<(String, Vec<u8>)>, PhotoStoreError> {
    if photos.is_empty() || photos.len() > MAX_SCORESHEET_PHOTOS {
        return Err(PhotoStoreError::InvalidInput);
    }
    let mut validated = Vec::with_capacity(photos.len());
    for photo in photos {
        let Some((RasterFormat::Jpeg, bytes)) =
            validate_image_data_url(photo, &[RasterFormat::Jpeg], MAX_OUTPUT_JPEG_BYTES)
        else {
            return Err(PhotoStoreError::InvalidInput);
        };
        let id = sha256_hex(&bytes);
        validated.push((id, bytes));
    }
    Ok(validated)
}

fn validate_read_ids(ids: &[String]) -> Result<(), PhotoStoreError> {
    if ids.is_empty() || ids.len() > MAX_SCORESHEET_PHOTOS {
        return Err(PhotoStoreError::InvalidInput);
    }
    if !ids.iter().all(|id| is_valid_photo_id(id)) {
        return Err(PhotoStoreError::InvalidInput);
    }
    Ok(())
}

fn open_photo_dir(app_data_dir: &AppDataDir) -> Result<AuthorizedDir, PhotoStoreError> {
    ensure_app_owned_default_dir(app_data_dir, AppOwnedDefaultRoot::ScoresheetPhotos).map_err(
        |error| {
            log::warn!("scoresheet photo store: could not open app-owned root: {error}");
            PhotoStoreError::Storage
        },
    )
}

fn open_app_photo_dir(app: &tauri::AppHandle) -> Result<AuthorizedDir, PhotoStoreError> {
    let data = AppDataDir::for_app(app).map_err(|error| {
        log::warn!("scoresheet photo store: could not resolve app data dir: {error}");
        PhotoStoreError::Storage
    })?;
    open_photo_dir(&data)
}

fn store_validated_in_dir(
    directory: &AuthorizedDir,
    validated: Vec<(String, Vec<u8>)>,
) -> Result<Vec<String>, PhotoStoreError> {
    let _guard = lock_store();
    let mut ids = Vec::with_capacity(validated.len());
    for (id, bytes) in validated {
        // Always rewrite through atomic replacement, even when the id already exists:
        // identical content makes the write idempotent and refreshes mtime on every platform
        // without needing a separate touch primitive.
        let (outcome, _) = directory
            .atomic_replace_leaf_identified(OsStr::new(&id), |file| {
                file.write_all(&bytes).map_err(Error::from)
            })
            .map_err(|error| {
                log::warn!("scoresheet photo store: atomic write failed for {id}: {error}");
                PhotoStoreError::Storage
            })?;
        match outcome {
            AtomicFileOutcome::DurableCommit => {}
            AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
                log::warn!("scoresheet photo store: parent sync failed for {id}: {error}");
                return Err(PhotoStoreError::Storage);
            }
        }
        ids.push(id);
    }
    Ok(ids)
}

fn read_single_photo(
    directory: &AuthorizedDir,
    id: &str,
    cancellation: &CancellationToken,
) -> Result<StoredPhotoRead, PhotoStoreError> {
    if cancellation.is_cancelled() {
        return Err(PhotoStoreError::Cancelled);
    }
    let mut file = match directory.open_regular_relative(Path::new(id)) {
        Ok(file) => file,
        Err(error) if error.is_missing_entry() => return Ok(StoredPhotoRead::Missing),
        Err(error) => {
            log::warn!("scoresheet photo store: unreadable leaf {id}: {error}");
            return Ok(StoredPhotoRead::Unreadable);
        }
    };
    let declared = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => {
            log::warn!("scoresheet photo store: metadata failed for {id}: {error}");
            return Ok(StoredPhotoRead::Unreadable);
        }
    };
    if declared > MAX_OUTPUT_JPEG_BYTES as u64 {
        log::warn!(
            "scoresheet photo store: leaf {id} exceeds maximum size ({declared} > {MAX_OUTPUT_JPEG_BYTES} bytes)"
        );
        return Ok(StoredPhotoRead::Unreadable);
    }
    let bytes = match read_bounded_bytes(
        &mut file,
        declared,
        MAX_OUTPUT_JPEG_BYTES,
        "scoresheet photo exceeds maximum size",
        || {
            if cancellation.is_cancelled() {
                Err(Error::Cancellation)
            } else {
                Ok(())
            }
        },
    ) {
        Ok(bytes) => bytes,
        Err(Error::Cancellation) => return Err(PhotoStoreError::Cancelled),
        Err(error) => {
            log::warn!("scoresheet photo store: bounded read failed for {id}: {error}");
            return Ok(StoredPhotoRead::Unreadable);
        }
    };
    if detect_allowed_raster_format(&bytes, &[RasterFormat::Jpeg]).is_none() {
        log::warn!("scoresheet photo store: leaf {id} is not a JPEG image");
        return Ok(StoredPhotoRead::Unreadable);
    }
    Ok(StoredPhotoRead::Ok {
        data_url: encode_jpeg_data_url(&bytes),
    })
}

fn read_validated_in_dir(
    directory: &AuthorizedDir,
    ids: &[String],
    cancellation: &CancellationToken,
) -> Result<Vec<StoredPhotoRead>, PhotoStoreError> {
    if cancellation.is_cancelled() {
        return Err(PhotoStoreError::Cancelled);
    }
    let _guard = lock_store();
    let mut results = Vec::with_capacity(ids.len());
    for id in ids {
        results.push(read_single_photo(directory, id, cancellation)?);
    }
    Ok(results)
}

/// Validates and stores 1–4 JPEG data URLs inside `app_data_dir`'s `scoresheet-photos` root,
/// returning their SHA-256 hex ids in input order.
#[cfg(test)]
fn store_photos_in_app_data(
    app_data_dir: &AppDataDir,
    photos: &[String],
) -> Result<Vec<String>, PhotoStoreError> {
    let validated = validate_store_batch(photos)?;
    let directory = open_photo_dir(app_data_dir)?;
    store_validated_in_dir(&directory, validated)
}

/// Validates 1–4 photo ids before touching the filesystem, then reads each leaf from
/// `app_data_dir`'s `scoresheet-photos` root.
#[cfg(test)]
fn read_photos_in_app_data(
    app_data_dir: &AppDataDir,
    ids: &[String],
    cancellation: &CancellationToken,
) -> Result<Vec<StoredPhotoRead>, PhotoStoreError> {
    validate_read_ids(ids)?;
    if cancellation.is_cancelled() {
        return Err(PhotoStoreError::Cancelled);
    }
    let directory = open_photo_dir(app_data_dir)?;
    read_validated_in_dir(&directory, ids, cancellation)
}

async fn store_photos_with<F>(
    open_dir: F,
    photos: Vec<String>,
) -> Result<Vec<String>, PhotoStoreError>
where
    F: FnOnce() -> Result<AuthorizedDir, PhotoStoreError> + Send + 'static,
{
    let validated = validate_store_batch(&photos)?;
    BLOCKING_GATEWAY
        .spawn(move || {
            let directory = match open_dir() {
                Ok(directory) => directory,
                Err(error) => return Ok(Err(error)),
            };
            Ok(store_validated_in_dir(&directory, validated))
        })
        .await
        .map_err(|error| {
            log::warn!("scoresheet photo store: blocking gateway store failed: {error}");
            PhotoStoreError::Storage
        })?
}

async fn read_photos_with<F>(
    open_dir: F,
    ids: Vec<String>,
    cancellation: CancellationToken,
) -> Result<Vec<StoredPhotoRead>, PhotoStoreError>
where
    F: FnOnce() -> Result<AuthorizedDir, PhotoStoreError> + Send + 'static,
{
    validate_read_ids(&ids)?;
    if cancellation.is_cancelled() {
        return Err(PhotoStoreError::Cancelled);
    }
    BLOCKING_GATEWAY
        .spawn_cancellable(cancellation, move |token| {
            let directory = match open_dir() {
                Ok(directory) => directory,
                Err(error) => return Ok(Err(error)),
            };
            match read_validated_in_dir(&directory, &ids, token) {
                Err(PhotoStoreError::Cancelled) => Err(Error::Cancellation),
                other => Ok(other),
            }
        })
        .await
        .map_err(|error| match error {
            Error::Cancellation => PhotoStoreError::Cancelled,
            other => {
                log::warn!("scoresheet photo store: blocking gateway read failed: {other}");
                PhotoStoreError::Storage
            }
        })?
}

/// Asynchronous entry point that validates 1–4 JPEG data URLs and stores them off the Tokio
/// worker pool through [`BLOCKING_GATEWAY`].
pub(crate) async fn store_photos(
    app: tauri::AppHandle,
    photos: Vec<String>,
) -> Result<Vec<String>, PhotoStoreError> {
    store_photos_with(move || open_app_photo_dir(&app), photos).await
}

/// Asynchronous entry point that validates 1–4 photo ids and reads them off the Tokio worker
/// pool through [`BLOCKING_GATEWAY`], honouring `cancellation`.
pub(crate) async fn read_photos(
    app: tauri::AppHandle,
    ids: Vec<String>,
    cancellation: CancellationToken,
) -> Result<Vec<StoredPhotoRead>, PhotoStoreError> {
    read_photos_with(move || open_app_photo_dir(&app), ids, cancellation).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use std::{
        fs,
        sync::{mpsc, Arc},
        time::{Duration, SystemTime},
    };

    fn make_jpeg_bytes(tag: u8) -> Vec<u8> {
        // Minimal valid JPEG SOI + APP0 header + distinguishing payload + EOI.
        vec![
            0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, b'J', b'F', b'I', b'F', tag, 0xFF, 0xD9,
        ]
    }

    fn png_data_url() -> String {
        let png = b"\x89PNG\r\n\x1a\nfake-png-body";
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        )
    }

    fn make_app_data() -> (tempfile::TempDir, AppDataDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let app_data = AppDataDir::for_test(dir.path());
        (dir, app_data)
    }

    #[test]
    fn store_returns_sha256_ids_in_input_order_and_round_trips() {
        let (_dir, app_data) = make_app_data();
        let b1 = make_jpeg_bytes(1);
        let b2 = make_jpeg_bytes(2);
        let b3 = make_jpeg_bytes(3);
        let u1 = encode_jpeg_data_url(&b1);
        let u2 = encode_jpeg_data_url(&b2);
        let u3 = encode_jpeg_data_url(&b3);

        // Independent SHA-256 hex vectors for `make_jpeg_bytes(1..=3)`.
        let expected = vec![
            "b723496a28c5af748a9df74c17ad796cdc1972cee256409ce957e46dd87e5a96".to_owned(),
            "204d6936bf9e72c129b64a3166a7c1f646009f87c020fb2b42ac273bc3ba78ef".to_owned(),
            "da963887d84397a25703896582bbfaeddf8fd0a5b6ca8c45c88a499c5450fa73".to_owned(),
        ];

        let ids = store_photos_in_app_data(&app_data, &[u1.clone(), u2.clone(), u3.clone()])
            .expect("store photos");
        assert_eq!(ids, expected);

        let token = CancellationToken::new();
        let read_back = read_photos_in_app_data(&app_data, &ids, &token).expect("read photos");
        assert_eq!(
            read_back,
            vec![
                StoredPhotoRead::Ok { data_url: u1 },
                StoredPhotoRead::Ok { data_url: u2 },
                StoredPhotoRead::Ok { data_url: u3 },
            ]
        );
    }

    #[test]
    fn storing_same_bytes_again_keeps_identical_content_and_refreshes_mtime() {
        let (dir, app_data) = make_app_data();
        let bytes = make_jpeg_bytes(42);
        let url = encode_jpeg_data_url(&bytes);

        let first_ids =
            store_photos_in_app_data(&app_data, std::slice::from_ref(&url)).expect("first store");
        let leaf_path = dir.path().join("scoresheet-photos").join(&first_ids[0]);
        assert_eq!(fs::read(&leaf_path).expect("read leaf"), bytes);

        // Backdate the leaf's mtime deterministically so the assertion does not rely on coarse
        // filesystem timestamp resolution or sleeping.
        let older = SystemTime::now() - Duration::from_secs(120);
        fs::OpenOptions::new()
            .write(true)
            .open(&leaf_path)
            .expect("open leaf for mtime backdate")
            .set_modified(older)
            .expect("set older mtime");
        let backdated_mtime = fs::metadata(&leaf_path)
            .expect("metadata after backdate")
            .modified()
            .expect("modified after backdate");

        let second_ids = store_photos_in_app_data(&app_data, &[url]).expect("second store");
        assert_eq!(second_ids, first_ids);
        assert_eq!(fs::read(&leaf_path).expect("read leaf again"), bytes);

        let refreshed_mtime = fs::metadata(&leaf_path)
            .expect("metadata after re-store")
            .modified()
            .expect("modified after re-store");
        assert!(
            refreshed_mtime > backdated_mtime,
            "re-storing must refresh mtime: {refreshed_mtime:?} <= {backdated_mtime:?}"
        );
    }

    #[test]
    fn store_refuses_invalid_data_url_non_jpeg_oversized_and_out_of_range_batch() {
        let (dir, app_data) = make_app_data();
        let valid = encode_jpeg_data_url(&make_jpeg_bytes(7));

        // Empty batch and > MAX_SCORESHEET_PHOTOS batch.
        assert_eq!(
            store_photos_in_app_data(&app_data, &[]),
            Err(PhotoStoreError::InvalidInput)
        );
        assert_eq!(
            store_photos_in_app_data(&app_data, &vec![valid.clone(); MAX_SCORESHEET_PHOTOS + 1]),
            Err(PhotoStoreError::InvalidInput)
        );

        // Non-JPEG (PNG data URL).
        assert_eq!(
            store_photos_in_app_data(&app_data, &[png_data_url()]),
            Err(PhotoStoreError::InvalidInput)
        );

        // JPEG MIME prefix wrapping non-JPEG bytes.
        let spoofed = encode_jpeg_data_url(b"\x89PNG\r\n\x1a\nnot-a-jpeg");
        assert_eq!(
            store_photos_in_app_data(&app_data, &[spoofed]),
            Err(PhotoStoreError::InvalidInput)
        );

        // Malformed URL / bad base64.
        assert_eq!(
            store_photos_in_app_data(&app_data, &["https://example.com/photo.jpg".into()]),
            Err(PhotoStoreError::InvalidInput)
        );
        assert_eq!(
            store_photos_in_app_data(&app_data, &["data:image/jpeg;base64,!!!".into()]),
            Err(PhotoStoreError::InvalidInput)
        );

        // Oversized JPEG (> MAX_OUTPUT_JPEG_BYTES).
        let mut oversized = vec![0u8; MAX_OUTPUT_JPEG_BYTES + 1];
        oversized[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        assert_eq!(
            store_photos_in_app_data(&app_data, &[encode_jpeg_data_url(&oversized)]),
            Err(PhotoStoreError::InvalidInput)
        );

        // Validation is atomic across the batch: a valid first photo is not written when the
        // second photo is invalid, and the root directory was never even created.
        assert_eq!(
            store_photos_in_app_data(&app_data, &[valid, png_data_url()]),
            Err(PhotoStoreError::InvalidInput)
        );
        assert!(
            !dir.path().join("scoresheet-photos").exists(),
            "refused store must not touch the filesystem"
        );
    }

    #[test]
    fn read_refuses_non_64_lowercase_hex_ids_before_touching_filesystem() {
        let (dir, app_data) = make_app_data();
        // Block the scoresheet-photos root with a regular file so any filesystem access would
        // fail with PhotoStoreError::Storage instead of InvalidInput.
        fs::write(dir.path().join("scoresheet-photos"), b"blocker").expect("write blocker");

        let valid_id = "a".repeat(PHOTO_ID_HEX_LEN);
        let uppercase_id = format!("A{}", "a".repeat(PHOTO_ID_HEX_LEN - 1));
        let slash_id = format!("{}/{}", "a".repeat(31), "b".repeat(32));
        let backslash_id = format!("{}\\{}", "a".repeat(31), "b".repeat(32));
        let dotdot_id = format!("..{}", "a".repeat(PHOTO_ID_HEX_LEN - 2));
        let short_id = "a".repeat(PHOTO_ID_HEX_LEN - 1);
        let long_id = "a".repeat(PHOTO_ID_HEX_LEN + 1);
        let non_hex_id = format!("g{}", "a".repeat(PHOTO_ID_HEX_LEN - 1));

        let token = CancellationToken::new();
        for bad in [
            String::new(),
            "..".into(),
            "../secret".into(),
            "a/b".into(),
            "a\\b".into(),
            uppercase_id,
            slash_id,
            backslash_id,
            dotdot_id,
            short_id,
            long_id,
            non_hex_id,
        ] {
            assert_eq!(
                read_photos_in_app_data(&app_data, std::slice::from_ref(&bad), &token),
                Err(PhotoStoreError::InvalidInput),
                "invalid id {bad:?} must be refused before touching the filesystem"
            );
            assert_eq!(
                read_photos_in_app_data(&app_data, &[valid_id.clone(), bad.clone()], &token),
                Err(PhotoStoreError::InvalidInput),
                "mixed batch [valid, {bad:?}] must be refused before touching the filesystem"
            );
            assert_eq!(
                read_photos_in_app_data(&app_data, &[bad.clone(), valid_id.clone()], &token),
                Err(PhotoStoreError::InvalidInput),
                "mixed batch [{bad:?}, valid] must be refused before touching the filesystem"
            );
        }

        // Empty and oversized id batches are also refused before filesystem access.
        assert_eq!(
            read_photos_in_app_data(&app_data, &[], &token),
            Err(PhotoStoreError::InvalidInput)
        );
        assert_eq!(
            read_photos_in_app_data(
                &app_data,
                &vec![valid_id.clone(); MAX_SCORESHEET_PHOTOS + 1],
                &token
            ),
            Err(PhotoStoreError::InvalidInput)
        );

        // Contrast: a valid 64-lowercase-hex id reaches the filesystem and hits the blocker.
        assert_eq!(
            read_photos_in_app_data(&app_data, &[valid_id], &token),
            Err(PhotoStoreError::Storage)
        );
    }

    #[test]
    fn read_distinguishes_missing_and_unreadable_leaves() {
        let (_dir, app_data) = make_app_data();
        let root_dir =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::ScoresheetPhotos)
                .expect("create root");
        let root_path = root_dir.path();

        let missing_id = "0".repeat(PHOTO_ID_HEX_LEN);
        let dir_id = "1".repeat(PHOTO_ID_HEX_LEN);
        let oversized_id = "2".repeat(PHOTO_ID_HEX_LEN);
        let non_jpeg_id = "3".repeat(PHOTO_ID_HEX_LEN);

        fs::create_dir(root_path.join(&dir_id)).expect("create directory leaf");
        let mut oversized = vec![0u8; MAX_OUTPUT_JPEG_BYTES + 1];
        oversized[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        fs::write(root_path.join(&oversized_id), &oversized).expect("write oversized leaf");
        fs::write(root_path.join(&non_jpeg_id), b"\x89PNG\r\n\x1a\nnot-jpeg")
            .expect("write non-jpeg leaf");

        let token = CancellationToken::new();
        let results = read_photos_in_app_data(
            &app_data,
            &[missing_id, dir_id, oversized_id, non_jpeg_id],
            &token,
        )
        .expect("read batch");
        assert_eq!(
            results,
            vec![
                StoredPhotoRead::Missing,
                StoredPhotoRead::Unreadable,
                StoredPhotoRead::Unreadable,
                StoredPhotoRead::Unreadable,
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn read_returns_unreadable_for_symlink_leaf() {
        let (dir, app_data) = make_app_data();
        let root_dir =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::ScoresheetPhotos)
                .expect("create root");
        let outside_jpeg = dir.path().join("outside.jpg");
        fs::write(&outside_jpeg, make_jpeg_bytes(99)).expect("write outside jpeg");

        let symlink_id = "4".repeat(PHOTO_ID_HEX_LEN);
        std::os::unix::fs::symlink(&outside_jpeg, root_dir.path().join(&symlink_id))
            .expect("create symlink leaf");

        let token = CancellationToken::new();
        let results =
            read_photos_in_app_data(&app_data, &[symlink_id], &token).expect("read symlink");
        assert_eq!(results, vec![StoredPhotoRead::Unreadable]);
    }

    #[cfg(unix)]
    #[test]
    fn scoresheet_photos_root_has_0o700_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, app_data) = make_app_data();
        let url = encode_jpeg_data_url(&make_jpeg_bytes(5));
        store_photos_in_app_data(&app_data, &[url]).expect("store creates root");

        let mode = fs::metadata(dir.path().join("scoresheet-photos"))
            .expect("root metadata")
            .permissions()
            .mode()
            & 0o7777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn errors_carry_no_filesystem_path() {
        let (dir, app_data) = make_app_data();
        fs::write(dir.path().join("scoresheet-photos"), b"not-a-dir").expect("write blocker");

        let storage_err =
            store_photos_in_app_data(&app_data, &[encode_jpeg_data_url(&make_jpeg_bytes(1))])
                .expect_err("blocked root must fail with Storage");
        assert_eq!(storage_err, PhotoStoreError::Storage);

        let invalid_err =
            store_photos_in_app_data(&app_data, &["not-a-url".into()]).expect_err("invalid input");
        assert_eq!(invalid_err, PhotoStoreError::InvalidInput);

        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let cancelled_err =
            read_photos_in_app_data(&app_data, &["a".repeat(PHOTO_ID_HEX_LEN)], &cancelled)
                .expect_err("cancelled read");
        assert_eq!(cancelled_err, PhotoStoreError::Cancelled);

        let tempdir_str = dir.path().to_string_lossy();
        for err in [storage_err, invalid_err, cancelled_err] {
            let display = format!("{err}");
            let debug = format!("{err:?}");
            for rendered in [&display, &debug] {
                assert!(
                    !rendered.contains(tempdir_str.as_ref()),
                    "error leaked tempdir path: {rendered}"
                );
                assert!(
                    !rendered.contains("scoresheet-photos"),
                    "error leaked root leaf name: {rendered}"
                );
                assert!(
                    !rendered.contains('/') && !rendered.contains('\\'),
                    "error leaked path separator: {rendered}"
                );
            }
        }
    }

    #[test]
    fn store_lock_serializes_concurrent_store_and_read() {
        let (_dir, app_data) = make_app_data();
        let url = encode_jpeg_data_url(&make_jpeg_bytes(11));
        let expected_id = sha256_hex(&make_jpeg_bytes(11));
        let app_data = Arc::new(app_data);

        // 1. Concurrent store blocks while PHOTO_STORE_LOCK is held.
        let guard = lock_store();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let store_data = Arc::clone(&app_data);
        let store_url = url.clone();

        let store_handle = std::thread::spawn(move || {
            started_tx.send(()).expect("signal store start");
            let ids = store_photos_in_app_data(&store_data, &[store_url]).expect("worker store");
            done_tx.send(ids).expect("signal store done");
        });

        started_rx.recv().expect("store worker started");
        assert!(
            done_rx.recv_timeout(Duration::from_millis(40)).is_err(),
            "store must wait while PHOTO_STORE_LOCK is held"
        );
        drop(guard);

        let ids = done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("store worker completes after unlock");
        assert_eq!(ids, vec![expected_id]);
        store_handle.join().expect("join store worker");

        // 2. Concurrent read blocks while PHOTO_STORE_LOCK is held.
        let guard = lock_store();
        let (read_started_tx, read_started_rx) = mpsc::channel();
        let (read_done_tx, read_done_rx) = mpsc::channel();
        let read_data = Arc::clone(&app_data);
        let read_ids = ids.clone();

        let read_handle = std::thread::spawn(move || {
            read_started_tx.send(()).expect("signal read start");
            let token = CancellationToken::new();
            let results =
                read_photos_in_app_data(&read_data, &read_ids, &token).expect("worker read");
            read_done_tx.send(results).expect("signal read done");
        });

        read_started_rx.recv().expect("read worker started");
        assert!(
            read_done_rx
                .recv_timeout(Duration::from_millis(40))
                .is_err(),
            "read must wait while PHOTO_STORE_LOCK is held"
        );
        drop(guard);

        let results = read_done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("read worker completes after unlock");
        assert_eq!(results, vec![StoredPhotoRead::Ok { data_url: url }]);
        read_handle.join().expect("join read worker");
    }

    #[tokio::test]
    async fn async_gateway_store_read_and_post_entry_cancellation() {
        let (_dir, app_data) = make_app_data();
        let app_data = Arc::new(app_data);
        let url = encode_jpeg_data_url(&make_jpeg_bytes(1));

        // Round-trip through BLOCKING_GATEWAY via store_photos_with and read_photos_with.
        let store_data = Arc::clone(&app_data);
        let ids = store_photos_with(move || open_photo_dir(&store_data), vec![url.clone()])
            .await
            .expect("async store");
        assert_eq!(
            ids,
            vec!["b723496a28c5af748a9df74c17ad796cdc1972cee256409ce957e46dd87e5a96"]
        );

        let read_data = Arc::clone(&app_data);
        let read_back = read_photos_with(
            move || open_photo_dir(&read_data),
            ids.clone(),
            CancellationToken::new(),
        )
        .await
        .expect("async read");
        assert_eq!(read_back, vec![StoredPhotoRead::Ok { data_url: url }]);

        // Storage error from opening the root propagates cleanly.
        assert_eq!(
            read_photos_with(
                || Err(PhotoStoreError::Storage),
                ids.clone(),
                CancellationToken::new(),
            )
            .await,
            Err(PhotoStoreError::Storage)
        );

        // Cancellation arriving *after* the async read enters BLOCKING_GATEWAY (while blocked on
        // the store lock) maps through Error::Cancellation => PhotoStoreError::Cancelled.
        // Hold the lock on a dedicated OS thread so the async test never holds a lock across .await.
        let (locked_tx, locked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let locker = std::thread::spawn(move || {
            let _guard = lock_store();
            locked_tx.send(()).expect("signal locked");
            let _ = release_rx.recv();
        });
        locked_rx.recv().expect("lock acquired");

        let token = CancellationToken::new();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let cancel_data = Arc::clone(&app_data);
        let read_future = tokio::spawn(read_photos_with(
            move || {
                let dir = open_photo_dir(&cancel_data)?;
                let _ = entered_tx.send(());
                Ok(dir)
            },
            ids,
            token.clone(),
        ));

        entered_rx.await.expect("blocking task entered");
        token.cancel();
        let _ = release_tx.send(());
        locker.join().expect("join locker");

        let result = read_future.await.expect("join read task");
        assert_eq!(result, Err(PhotoStoreError::Cancelled));
    }

    #[test]
    fn validate_scoresheet_photos_tag_accepts_one_to_four_ids_and_rejects_malformed() {
        let id1 = "a".repeat(PHOTO_ID_HEX_LEN);
        let id2 = "0123456789abcdef".repeat(4);
        let id3 = "f".repeat(PHOTO_ID_HEX_LEN);
        let id4 = "9".repeat(PHOTO_ID_HEX_LEN);

        assert_eq!(validate_scoresheet_photos_tag(&id1), Some(id1.as_str()));
        let two = format!("{id1},{id2}");
        assert_eq!(validate_scoresheet_photos_tag(&two), Some(two.as_str()));
        let four = format!("{id1},{id2},{id3},{id4}");
        assert_eq!(four.len(), MAX_SCORESHEET_PHOTOS_TAG_LEN);
        assert_eq!(validate_scoresheet_photos_tag(&four), Some(four.as_str()));

        let five = format!("{four},{id1}");
        for invalid in [
            "",
            "not-a-hash",
            &"A".repeat(PHOTO_ID_HEX_LEN),
            &"a".repeat(PHOTO_ID_HEX_LEN - 1),
            &"a".repeat(PHOTO_ID_HEX_LEN + 1),
            &format!("{id1},"),
            &format!(",{id1}"),
            &format!("{id1}, {id2}"),
            &format!("{id1},,{id2}"),
            &format!("../{id1}"),
            &five,
        ] {
            assert_eq!(validate_scoresheet_photos_tag(invalid), None, "{invalid}");
        }
    }
}
