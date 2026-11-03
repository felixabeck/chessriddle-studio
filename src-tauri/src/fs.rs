#[cfg(test)]
use std::ffi::OsStr;
use std::{
    future::Future,
    io::{Read, Seek, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use log::info;
use reqwest::header::HeaderMap;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use specta::Type;

use futures_util::StreamExt;
use tokio_util::sync::CancellationToken;

use crate::error::{Error, ErrorPayload};
use crate::progress::{
    begin_progress, publish_download_failure, update_progress_with_state, ProgressGeneration,
    ProgressLease, ProgressState,
};
use crate::AppState;

pub(crate) const MAX_ACTIVE_DOWNLOADS: usize = 32;
const DOWNLOAD_DEADLINE: Duration = Duration::from_secs(60 * 60);
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_DOWNLOAD_REDIRECTS: usize = 10;
const MAX_ARCHIVE_PATH_BYTES: usize = 1024;
const TAR_BLOCK_SIZE: usize = 512;
const USTAR_MAGIC_OFFSET: usize = 257;
const USTAR_MAGIC: &[u8; 5] = b"ustar";
const TAR_CHECKSUM_FIELD: std::ops::Range<usize> = 148..156;
#[cfg(unix)]
const MAX_ARCHIVE_PATH_COMPONENTS: usize = crate::infra::fs::MAX_REMOVE_TREE_DEPTH - 1;
/// Standard minisign public-key file of the fork release key: an `untrusted comment:` line, then
/// the `RW…` key line. Only the key line is handed to the verifier.
const RELEASE_MINISIGN_PUBLIC_KEY_FILE: &str = include_str!("../keys/release.minisign.pub");

/// Signals a staging producer at its deadline but keeps awaiting its real exit. The caller's
/// native lease therefore continues to account for a blocking extractor and its private cleanup.
/// This helper is used only before publication; committed durability tails have no deadline race.
async fn await_staging_deadline<T>(
    deadline: Duration,
    cancellation: &CancellationToken,
    timeout_message: &'static str,
    producer: impl Future<Output = Result<T, Error>>,
) -> Result<T, Error> {
    await_staging_deadline_with_admission(
        deadline,
        cancellation,
        timeout_message,
        producer,
        std::future::pending(),
    )
    .await
}

async fn await_staging_deadline_with_admission<T>(
    deadline: Duration,
    cancellation: &CancellationToken,
    timeout_message: &'static str,
    producer: impl Future<Output = Result<T, Error>>,
    admission: impl Future<Output = ()>,
) -> Result<T, Error> {
    tokio::pin!(producer);
    // Own the pinned admission future so its publication sender can be explicitly released
    // before awaiting a producer that may be blocked on that sender.
    let mut admission = Box::pin(admission);
    let timed_out = {
        tokio::select! {
            biased;
            result = &mut producer => return result,
            _ = &mut admission => false,
            _ = tokio::time::sleep(deadline) => true,
        }
    };
    drop(admission);
    if !timed_out {
        // No deadline competes with the admitted publication/durability tail.
        return producer.await;
    }
    cancellation.cancel();
    let _ = producer.await;
    Err(Error::EngineTimeout(timeout_message.into()))
}

fn download_target_durability(
    outcome: crate::infra::fs::AtomicFileOutcome,
) -> Option<crate::infra::path_authority::CommitDurability> {
    let stage = crate::infra::fs::map_atomic_file_outcome(
        outcome,
        crate::error::DurabilityStage::DownloadTargetReplacement,
        |error| log::warn!("download target replacement parent sync failed: {error}"),
    )?;
    Some(crate::infra::path_authority::CommitDurability::DurabilityUncertain(stage))
}

/// A release-key signed artifact digest. The signature binds URL and hash.
#[derive(Clone, Debug, Deserialize, Type)]
pub struct ArtifactIntegrity {
    pub sha256: String,
    pub signature: String,
}

type ArtifactIntegrityValidator =
    Box<dyn Fn(OpClass, &str, &ArtifactIntegrity) -> Result<(), Error> + Send + Sync + 'static>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpClass {
    Lichess,
    Engine,
    Db,
    PuzzleDb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PayloadFormat {
    PlainFile,
    Archive,
}

impl OpClass {
    fn from_operations(
        operations: &[crate::infra::path_authority::PathOperation],
    ) -> Result<Self, Error> {
        use crate::infra::path_authority::PathOperation;

        let engine = operations.iter().any(|operation| {
            matches!(
                operation,
                PathOperation::DownloadArchive
                    | PathOperation::EngineInstall
                    | PathOperation::EngineExecute
                    | PathOperation::EngineConfigure
            )
        });
        let database = operations.iter().any(|operation| {
            matches!(
                operation,
                PathOperation::DatabaseRead
                    | PathOperation::DatabaseMutate
                    | PathOperation::DatabaseCreate
                    | PathOperation::DatabaseExport
            )
        });
        let puzzle = operations.iter().any(|operation| {
            matches!(
                operation,
                PathOperation::PuzzleRead | PathOperation::PuzzleDelete
            )
        });
        let marker_classes = usize::from(engine) + usize::from(database) + usize::from(puzzle);
        if marker_classes > 1 {
            return Err(Error::InvalidInput(
                "download destination mixes operation classes".into(),
            ));
        }
        let only_engine = operations.iter().all(|operation| {
            matches!(
                operation,
                PathOperation::DownloadFile
                    | PathOperation::DownloadArchive
                    | PathOperation::EngineInstall
                    | PathOperation::EngineExecute
                    | PathOperation::EngineConfigure
            )
        });
        let only_database = operations.iter().all(|operation| {
            matches!(
                operation,
                PathOperation::DownloadFile
                    | PathOperation::DatabaseRead
                    | PathOperation::DatabaseMutate
                    | PathOperation::DatabaseCreate
                    | PathOperation::DatabaseExport
            )
        });
        let only_puzzle = operations.iter().all(|operation| {
            matches!(
                operation,
                PathOperation::DownloadFile
                    | PathOperation::PuzzleRead
                    | PathOperation::PuzzleDelete
            )
        });
        if engine && only_engine {
            Ok(Self::Engine)
        } else if database && only_database {
            Ok(Self::Db)
        } else if puzzle && only_puzzle {
            Ok(Self::PuzzleDb)
        } else if operations == [PathOperation::DownloadFile] {
            Ok(Self::Lichess)
        } else {
            Err(Error::InvalidInput(
                "download destination has no recognized operation class".into(),
            ))
        }
    }

    fn max_size(&self) -> u64 {
        match self {
            Self::Lichess => 100 * 1024 * 1024,
            Self::Engine => 500 * 1024 * 1024,
            Self::Db => 10 * 1024 * 1024 * 1024,
            Self::PuzzleDb => 5 * 1024 * 1024 * 1024,
        }
    }

    fn payload_format(&self) -> PayloadFormat {
        match self {
            Self::Engine => PayloadFormat::Archive,
            // A Lichess export and the database/puzzle data sets are all single files.
            Self::Lichess | Self::Db | Self::PuzzleDb => PayloadFormat::PlainFile,
        }
    }

    fn limits(&self) -> ArchiveLimits {
        ArchiveLimits {
            compressed: self.max_size(),
            expanded: match self {
                Self::Lichess => 100 * 1024 * 1024,
                Self::Engine => 2 * 1024 * 1024 * 1024,
                Self::Db => 10 * 1024 * 1024 * 1024,
                Self::PuzzleDb => 5 * 1024 * 1024 * 1024,
            },
            per_entry: match self {
                Self::Engine => 512 * 1024 * 1024,
                _ => self.max_size(),
            },
            entries: 100_000,
            ratio: 250,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ArchiveLimits {
    compressed: u64,
    expanded: u64,
    per_entry: u64,
    entries: usize,
    ratio: u64,
}

fn redact_url(url: &reqwest::Url) -> String {
    let mut redacted = url.clone();
    let _ = redacted.set_username("");
    let _ = redacted.set_password(None);
    redacted.set_query(None);
    redacted.set_fragment(None);
    redacted.to_string()
}

fn validate_download_url(url: &reqwest::Url) -> Result<(), Error> {
    if url.scheme() != "https" {
        return Err(Error::InvalidInput("Only HTTPS allowed".into()));
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err(Error::InvalidInput("Unsafe URL component".into()));
    }
    match url.host() {
        Some(url::Host::Domain(_)) => {}
        Some(url::Host::Ipv4(ip)) => {
            if !crate::infra::net::is_public_ip(std::net::IpAddr::V4(ip)) {
                return Err(Error::InvalidInput("Non-public download address".into()));
            }
        }
        Some(url::Host::Ipv6(ip)) => {
            if !crate::infra::net::is_public_ip(std::net::IpAddr::V6(ip)) {
                return Err(Error::InvalidInput("Non-public download address".into()));
            }
        }
        None => return Err(Error::InvalidInput("URL must have a host".into())),
    }
    Ok(())
}

fn validate_artifact_integrity(
    op: OpClass,
    url: &str,
    integrity: Option<&ArtifactIntegrity>,
) -> Result<(), Error> {
    validate_artifact_integrity_with(op, url, integrity, verify_release_signature)
}

/// `verify` is the production key in every non-test caller; tests inject a fixture key.
fn validate_artifact_integrity_with(
    op: OpClass,
    url: &str,
    integrity: Option<&ArtifactIntegrity>,
    verify: impl Fn(&[u8], &str) -> Result<(), Error>,
) -> Result<(), Error> {
    let required = matches!(op, OpClass::Engine | OpClass::Db | OpClass::PuzzleDb);
    let Some(integrity) = integrity else {
        return if required {
            Err(Error::InvalidInput(
                "signed artifact integrity metadata required".into(),
            ))
        } else {
            Ok(())
        };
    };
    if integrity.sha256.len() != 64
        || !integrity
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(Error::InvalidInput("invalid artifact SHA-256".into()));
    }
    let payload = format!("{url}\n{}", integrity.sha256.to_ascii_lowercase());
    verify(payload.as_bytes(), &integrity.signature)
}

/// Returns the `RW…` key line of the committed release public-key file.
fn release_public_key_line(file: &str) -> Result<&str, Error> {
    file.lines()
        .map(str::trim)
        .find(|line| line.starts_with("RW"))
        .ok_or_else(|| Error::InvalidInput("artifact verification key is invalid".into()))
}

/// Verifies a minisign signature over `payload` with the fork release key.
fn verify_release_signature(payload: &[u8], signature_text: &str) -> Result<(), Error> {
    let key_line = release_public_key_line(RELEASE_MINISIGN_PUBLIC_KEY_FILE)?;
    verify_minisign_signature(key_line, payload, signature_text)
}

/// Shared minisign check for per-entry artifact payloads and signed catalog documents.
pub(crate) fn verify_minisign_signature(
    key_line: &str,
    payload: &[u8],
    signature_text: &str,
) -> Result<(), Error> {
    let key = minisign_verify::PublicKey::from_base64(key_line)
        .map_err(|_| Error::InvalidInput("artifact verification key is invalid".into()))?;
    let signature = minisign_verify::Signature::decode(signature_text)
        .map_err(|_| Error::InvalidInput("invalid artifact manifest signature".into()))?;
    key.verify(payload, &signature, true)
        .map_err(|_| Error::InvalidInput("artifact manifest signature verification failed".into()))
}

/// Verifies a detached minisign signature over the exact UTF-8 bytes of a bundled catalog
/// document. It authenticates the bytes only; callers parse the document afterwards.
#[tauri::command]
#[specta::specta]
pub async fn verify_signed_bytes(payload: String, signature: String) -> Result<(), Error> {
    verify_release_signature(payload.as_bytes(), &signature)
}

fn is_bearer_origin(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some("lichess.org") | Some("database.lichess.org")
        )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
async fn download_file_core<F>(
    op: OpClass,
    url: &str,
    path: &Path,
    staging: Option<PathBuf>,
    transport: &dyn crate::infra::net::DownloadTransport,
    token: Option<&str>,
    total_size: Option<u32>,
    progress_updater: F,
) -> Result<(), Error>
where
    F: FnMut(f32) -> Result<(), Error>,
{
    download_file_core_control(
        op,
        url,
        path,
        staging,
        transport,
        token,
        total_size,
        CancellationToken::new(),
        progress_updater,
    )
    .await
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
async fn download_file_core_control<F>(
    op: OpClass,
    url: &str,
    path: &Path,
    staging: Option<PathBuf>,
    transport: &dyn crate::infra::net::DownloadTransport,
    token: Option<&str>,
    total_size: Option<u32>,
    cancellation: CancellationToken,
    progress_updater: F,
) -> Result<(), Error>
where
    F: FnMut(f32) -> Result<(), Error>,
{
    download_file_core_control_with_integrity(
        op,
        url,
        path,
        staging,
        transport,
        token,
        total_size,
        cancellation,
        None,
        progress_updater,
    )
    .await
}

/// Splits the staging a zip or tar download installs under into the extractor's parent and
/// leaf, refusing when `path` is not the directory that staging names.
#[cfg(test)]
fn archive_install_names<'a>(
    path: &Path,
    staging: &'a Option<PathBuf>,
) -> Result<(&'a Path, &'a OsStr), Error> {
    let mismatch = || Error::InvalidInput("archive target does not match its staging".into());
    match staging {
        None => Err(Error::InvalidInput(
            "archive extract needs process-owned staging".into(),
        )),
        Some(root) => {
            if path != root.as_path() {
                return Err(mismatch());
            }
            match (root.parent(), root.file_name()) {
                (Some(parent), Some(leaf)) => Ok((parent, leaf)),
                _ => Err(mismatch()),
            }
        }
    }
}

fn validate_download_request(
    op: OpClass,
    url: &str,
    token: Option<&str>,
    cancellation: &CancellationToken,
) -> Result<reqwest::Url, Error> {
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let parsed_url =
        reqwest::Url::parse(url).map_err(|_| Error::InvalidInput("Invalid URL".into()))?;
    validate_download_url(&parsed_url)?;

    if token.is_some() {
        match op {
            OpClass::Lichess => {
                if !is_bearer_origin(&parsed_url) {
                    return Err(Error::InvalidInput("Unauthorized origin".into()));
                }
            }
            _ => return Err(Error::InvalidInput("Token only allowed for Lichess".into())),
        }
    }
    Ok(parsed_url)
}

/// Writes the validated network body into the caller's open payload file and flushes it.
#[allow(clippy::too_many_arguments)]
async fn download_payload_network<F>(
    op: OpClass,
    parsed_url: reqwest::Url,
    file: &mut std::fs::File,
    transport: &dyn crate::infra::net::DownloadTransport,
    token: Option<&str>,
    total_size: Option<u32>,
    cancellation: CancellationToken,
    expected_sha256: Option<&str>,
    mut progress_updater: F,
) -> Result<(), Error>
where
    F: FnMut(f32) -> Result<(), Error>,
{
    info!("Downloading file from {}", redact_url(&parsed_url));
    let mut req_url = parsed_url;
    let mut redirects = 0;

    let mut res = loop {
        let mut headers = HeaderMap::new();
        if let Some(token) = token {
            if is_bearer_origin(&req_url) {
                if let Ok(auth_value) = format!("Bearer {token}").parse() {
                    headers.insert("Authorization", auth_value);
                }
            }
        }

        let authorization_sent = headers.contains_key(reqwest::header::AUTHORIZATION);
        let res = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancellation),
            response = tokio::time::timeout(DOWNLOAD_REQUEST_TIMEOUT, transport.request(req_url.as_str(), headers)) => response
                .map_err(|_| Error::EngineTimeout("download request timed out".into()))??,
        };

        if res.status >= 300 && res.status < 400 {
            if redirects >= MAX_DOWNLOAD_REDIRECTS {
                return Err(Error::InvalidInput("Too many redirects".into()));
            }
            redirects += 1;
            let loc = res
                .headers
                .get(reqwest::header::LOCATION)
                .ok_or_else(|| Error::InvalidInput("Redirect missing location".into()))?
                .to_str()
                .map_err(|_| Error::InvalidInput("Invalid location header".into()))?;
            let next_url = req_url
                .join(loc)
                .map_err(|_| Error::InvalidInput("Invalid redirect URL".into()))?;

            validate_download_url(&next_url)?;

            req_url = next_url;
            continue;
        }

        if !(200..300).contains(&res.status) {
            return Err(Error::RemoteHttpRejection(
                crate::error::RemoteHttpRejection {
                    status: res.status,
                    authorization_sent,
                },
            ));
        }

        break res;
    };

    let declared_size = res.content_length;
    let limits = op.limits();
    if let Some(ds) = declared_size {
        if ds > limits.compressed {
            return Err(Error::ResourceLimit("File too large".into()));
        }
    }

    if let Some(ts) = total_size {
        if let Some(ds) = declared_size {
            if ts as u64 != ds {
                return Err(Error::InvalidInput(
                    "Declared size and Content-Length mismatch".into(),
                ));
            }
        }
    }

    let expected_size = total_size.map(|s| s as u64).or(declared_size);

    let mut downloaded: u64 = 0;
    let mut digest = expected_sha256.map(|_| Sha256::new());

    loop {
        let item = tokio::select! {
            _ = cancellation.cancelled() => return Err(Error::Cancellation),
            item = res.stream.next() => item,
        };
        let Some(item) = item else { break };
        let chunk = item?;
        if let Some(digest) = digest.as_mut() {
            digest.update(&chunk);
        }
        downloaded += chunk.len() as u64;
        if downloaded > limits.compressed {
            return Err(Error::ResourceLimit("File too large".into()));
        }
        if let Some(expected) = expected_size {
            if downloaded > expected {
                return Err(Error::InvalidInput(
                    "Actual downloaded size exceeds expected size".into(),
                ));
            }
        }
        file.write_all(&chunk)?;
        if let Some(total_size) = total_size {
            let progress = ((downloaded as f64 / total_size as f64) * 100.0).min(100.0) as f32;
            progress_updater(progress)?;
        }
    }

    if let Some(expected) = expected_size {
        if downloaded != expected {
            return Err(Error::InvalidInput(
                "Actual downloaded size mismatch".into(),
            ));
        }
    }
    if let Some(expected_sha256) = expected_sha256 {
        let actual = format!(
            "{:x}",
            digest
                .expect("hash exists when hash is required")
                .finalize()
        );
        if !actual.eq_ignore_ascii_case(expected_sha256) {
            return Err(Error::InvalidInput("artifact SHA-256 mismatch".into()));
        }
    }
    file.flush()?;

    info!("Downloaded file to temporary location");

    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum DownloadPayloadKind {
    Plain,
    Zip,
    Tar,
    Gzip,
}

fn sniff_download_payload(file: &mut std::fs::File) -> Result<DownloadPayloadKind, Error> {
    file.rewind()?;
    let mut magic = [0u8; TAR_BLOCK_SIZE];
    let n = file.read(&mut magic)?;
    file.rewind()?;
    if n >= 4
        && matches!(
            &magic[..4],
            b"PK\x03\x04" | b"PK\x05\x06" | b"PK\x06\x06" | b"PK\x06\x07"
        )
    {
        Ok(DownloadPayloadKind::Zip)
    } else if n >= 2 && magic[0] == 0x1F && magic[1] == 0x8B {
        Ok(DownloadPayloadKind::Gzip)
    } else if is_ustar_header(&magic[..n]) {
        Ok(DownloadPayloadKind::Tar)
    } else {
        Ok(DownloadPayloadKind::Plain)
    }
}

fn accept_plain_download_payload(file: &mut std::fs::File) -> Result<(), Error> {
    if sniff_download_payload(file)? != DownloadPayloadKind::Plain {
        return Err(Error::InvalidInput(
            "Archive payload is not allowed for this operation".into(),
        ));
    }
    Ok(())
}

/// Installs only zip, tar or tar-in-gzip into process-owned `staging`, which must match `path`.
/// Its existing parent is pinned once for every archive install; missing parents are refused.
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
async fn download_file_core_control_with_integrity<F>(
    op: OpClass,
    url: &str,
    path: &Path,
    staging: Option<PathBuf>,
    transport: &dyn crate::infra::net::DownloadTransport,
    token: Option<&str>,
    total_size: Option<u32>,
    cancellation: CancellationToken,
    expected_sha256: Option<&str>,
    progress_updater: F,
) -> Result<(), Error>
where
    F: FnMut(f32) -> Result<(), Error>,
{
    validate_download_request(op, url, token, &cancellation)?;
    let target = path.to_path_buf();
    let setup_path = target.clone();
    let pin = crate::infra::blocking::BLOCKING_GATEWAY
        .spawn(move || crate::infra::fs::open_parent_no_follow(&setup_path))
        .await?;
    let creation_parent = pin.try_clone()?;
    prepare_archive_download(
        ArchiveDownloadRequest {
            op,
            url,
            transport,
            token,
            total_size,
            expected_sha256,
        },
        path,
        move |prefix| crate::infra::fs::OwnedStagingDir::create_in(&creation_parent, prefix),
        cancellation,
        progress_updater,
        move |source, _pin, cancellation| {
            let (parent, leaf) = archive_install_names(&target, &staging)?;
            let current = crate::infra::fs::open_parent_no_follow(&target)?;
            validate_prepared_tree(&source, &current, parent, cancellation)?;
            install_extracted_tree(source, &pin, parent, leaf, cancellation)
        },
    )
    .await
}

struct ArchiveDownloadRequest<'a> {
    op: OpClass,
    url: &'a str,
    transport: &'a dyn crate::infra::net::DownloadTransport,
    token: Option<&'a str>,
    total_size: Option<u32>,
    expected_sha256: Option<&'a str>,
}

/// Preparation and its consumer share one blocking worker. An owned tree never crosses an
/// async return or cleanup boundary, including when the producer is cancelled or times out.
async fn prepare_archive_download<F, C, S>(
    request: ArchiveDownloadRequest<'_>,
    path: &Path,
    create_staging: S,
    cancellation: CancellationToken,
    progress_updater: F,
    consume: C,
) -> Result<(), Error>
where
    F: FnMut(f32) -> Result<(), Error>,
    S: FnOnce(&str) -> Result<crate::infra::fs::OwnedStagingDir, Error> + Send + 'static,
    C: FnOnce(
            crate::infra::fs::OwnedStagingDir,
            &std::fs::File,
            &CancellationToken,
        ) -> Result<(), Error>
        + Send
        + 'static,
{
    let ArchiveDownloadRequest {
        op,
        url,
        transport,
        token,
        total_size,
        expected_sha256,
    } = request;
    let parsed_url = validate_download_request(op, url, token, &cancellation)?;
    let limits = op.limits();
    let path = path.to_path_buf();
    #[cfg(test)]
    let setup_path = path.clone();
    let mut file = crate::infra::blocking::BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |_| {
            #[cfg(test)]
            run_path_hook(&ARCHIVE_PAYLOAD_HOOKS, &setup_path);
            #[cfg(test)]
            run_archive_payload_create_fault(&setup_path)?;
            let file = tempfile::tempfile()?;
            #[cfg(test)]
            run_archive_payload_created_hook(&setup_path, &file);
            Ok(file)
        })
        .await?;
    let result = download_payload_network(
        op,
        parsed_url,
        &mut file,
        transport,
        token,
        total_size,
        cancellation.clone(),
        expected_sha256,
        progress_updater,
    )
    .await;
    #[cfg(test)]
    run_path_hook(&ARCHIVE_PAYLOAD_NETWORK_DONE_HOOKS, &path);
    // Accepted workflows own the file across the network await. Once it exists, admission
    // must drain even after cancellation so every network result closes it on this worker.
    crate::infra::blocking::BLOCKING_GATEWAY
        .spawn(move || {
            #[cfg(test)]
            let terminal_path = path.clone();
            let outcome = (move || {
                result?;
                if cancellation.is_cancelled() {
                    return Err(Error::Cancellation);
                }
                #[cfg(test)]
                run_path_hook(&CORE_AFTER_PIN_HOOKS, &path);
                let kind = sniff_download_payload(&mut file)?;
                let is_zip = kind == DownloadPayloadKind::Zip;
                let is_tar = kind == DownloadPayloadKind::Tar;
                let is_gz = kind == DownloadPayloadKind::Gzip;

                if is_zip || is_tar || is_gz {
                    if op.payload_format() != PayloadFormat::Archive {
                        return Err(Error::InvalidInput(
                            "Archive payload is not allowed for this operation".into(),
                        ));
                    }
                    let dest_parent = path.parent().unwrap_or_else(|| Path::new("."));
                    let staging = create_staging(if is_zip { ".zip" } else { ".tar" })?;
                    let pin = staging.binding().0.try_clone()?;
                    let source = if is_zip {
                        prepare_zip_cancellable(file, staging, limits, &cancellation)?
                    } else if is_tar {
                        prepare_tar_cancellable(file, staging, limits, &cancellation)?
                    } else {
                        if !gzip_is_tar(&mut file)? {
                            return Err(archive_payload_required());
                        }
                        prepare_gz_cancellable(file, dest_parent, staging, limits, &cancellation)?
                    };
                    validate_prepared_tree(&source, &pin, dest_parent, &cancellation)?;
                    consume(source, &pin, &cancellation)
                } else {
                    Err(archive_payload_required())
                }
            })();
            #[cfg(test)]
            run_path_hook(&ARCHIVE_PAYLOAD_CLEANUP_HOOKS, &terminal_path);
            outcome
        })
        .await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn download_file(
    id: String,
    url: String,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    total_size: Option<u32>,
    job_id: String,
    integrity: Option<ArtifactIntegrity>,
) -> Result<(), ErrorPayload> {
    download_file_runtime(
        id,
        url,
        destination,
        filename,
        &app,
        window.label(),
        state.inner(),
        total_size,
        job_id,
        integrity,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn download_file_runtime<R: tauri::Runtime>(
    id: String,
    url: String,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    app: &tauri::AppHandle<R>,
    owner: &str,
    state: &AppState,
    total_size: Option<u32>,
    job_id: String,
    integrity: Option<ArtifactIntegrity>,
) -> Result<(), ErrorPayload> {
    let lease = state
        .operations
        .claim_download(
            &job_id,
            owner,
            "download publication",
            &id,
            &id,
            false,
            MAX_ACTIVE_DOWNLOADS,
        )
        .map_err(|error| error.renderer_payload())?;
    // The native continuation owns publication after its command receiver disappears.
    // This per-call cell carries only the admitted generation back to a surviving receiver.
    let generation = std::sync::Arc::new(std::sync::OnceLock::new());
    download_to_destination_with_failure(
        &id,
        &url,
        destination,
        filename,
        app,
        state,
        None,
        total_size,
        job_id,
        lease,
        false,
        integrity.as_ref(),
        Some(generation.clone()),
        None,
    )
    .await
    .map(|_| ())
    .map_err(|error| {
        let mut payload = error.renderer_payload();
        payload.progress_generation = generation.get().copied();
        payload
    })
}

fn sanitize_download_error(error: Error) -> Error {
    match error {
        Error::Io(source) => sanitized_download_io_error(&source),
        error => error,
    }
}

fn sanitized_download_io_error(source: &std::io::Error) -> Error {
    Error::Io(Box::new(crate::error::sanitized_io_error(
        source,
        "I/O failure".into(),
    )))
}

type DownloadPublication = (
    Option<crate::infra::path_authority::ArtifactPublication>,
    Option<Vec<crate::lichess::CoverageHold>>,
);

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_to_destination<R: tauri::Runtime>(
    id: &str,
    url: &str,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    app: &tauri::AppHandle<R>,
    state: &AppState,
    bearer_token: Option<&str>,
    total_size: Option<u32>,
    job_id: String,
    lease: crate::infra::operations::OperationLease,
    register_pgn_artifact: bool,
    integrity: Option<&ArtifactIntegrity>,
    lichess_coverage_url: Option<reqwest::Url>,
) -> Result<DownloadPublication, Error> {
    download_to_destination_with_failure(
        id,
        url,
        destination,
        filename,
        app,
        state,
        bearer_token,
        total_size,
        job_id,
        lease,
        register_pgn_artifact,
        integrity,
        None,
        lichess_coverage_url,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn download_to_destination_with_failure<R: tauri::Runtime>(
    id: &str,
    url: &str,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    app: &tauri::AppHandle<R>,
    state: &AppState,
    bearer_token: Option<&str>,
    total_size: Option<u32>,
    job_id: String,
    lease: crate::infra::operations::OperationLease,
    register_pgn_artifact: bool,
    integrity: Option<&ArtifactIntegrity>,
    file_generation: Option<std::sync::Arc<std::sync::OnceLock<ProgressGeneration>>>,
    lichess_coverage_url: Option<reqwest::Url>,
) -> Result<DownloadPublication, Error> {
    let cancellation = lease.token();
    let commit_gate = lease.commit_gate();
    let id = id.to_owned();
    let url = url.to_owned();
    let app = app.clone();
    let state = state.clone();
    let bearer_token = bearer_token.map(str::to_owned);
    let integrity = integrity.cloned();
    crate::infra::operations::run_native_operation(lease, "download publication", async move {
        download_to_destination_inner(
            &id,
            &url,
            destination,
            filename,
            &app,
            &state,
            bearer_token.as_deref(),
            total_size,
            job_id,
            register_pgn_artifact,
            integrity.as_ref(),
            cancellation.clone(),
            commit_gate,
            file_generation.as_deref(),
            lichess_coverage_url,
        )
        .await
        .map_err(sanitize_download_error)
    })
    .await
}

fn cleanup_download_reservation_best_effort(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    reservation: &crate::infra::path_authority::PendingArtifactReservation,
) {
    if let Err(unavailable) = authority.with_mut(|authority| {
        authority.abandon_download_artifact(reservation);
    }) {
        let stage = match unavailable {
            crate::infra::path_authority::AuthorityUnavailable::Poisoned => "lock",
            crate::infra::path_authority::AuthorityUnavailable::Uninitialized => "initialization",
        };
        let category = Error::from(unavailable).category();
        log::warn!("download reservation cleanup failed at {stage}: {category}");
    }
}

fn report_download_terminal_progress<R: tauri::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    progress_lease: &ProgressLease,
    job_id: &str,
    progress: f32,
    terminal_state: ProgressState,
) {
    if let Err(secondary) = update_progress_with_state(
        &state.progress_state,
        app,
        progress_lease,
        progress,
        terminal_state,
    ) {
        let category = secondary.category();
        let generation = progress_lease.generation;
        log::warn!("download {job_id} progress report generation {generation} failed: {category}");
    }
}

fn report_download_error<R: tauri::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    progress_lease: &ProgressLease,
    job_id: &str,
    primary_error: &Error,
) {
    let terminal = if matches!(primary_error, Error::Cancellation) {
        ProgressState::Cancelled
    } else {
        ProgressState::Failed
    };
    report_download_terminal_progress(state, app, progress_lease, job_id, 0.0, terminal);
}

fn report_file_or_provider_download_error<R: tauri::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    progress_lease: &ProgressLease,
    job_id: &str,
    primary_error: &Error,
    file_download: bool,
) {
    if !file_download || matches!(primary_error, Error::Cancellation) {
        report_download_error(state, app, progress_lease, job_id, primary_error);
        return;
    }
    let payload = match primary_error {
        Error::Io(source) => sanitized_download_io_error(source).renderer_payload(),
        error => error.renderer_payload(),
    };
    if let Err(secondary) =
        publish_download_failure(&state.progress_state, app, progress_lease, payload)
    {
        log::warn!(
            "download {job_id} progress report generation {} failed: {}",
            progress_lease.generation,
            secondary.category()
        );
    }
}

fn report_download_success<R: tauri::Runtime>(
    state: &AppState,
    app: &tauri::AppHandle<R>,
    progress_lease: &ProgressLease,
    job_id: &str,
) {
    report_download_terminal_progress(
        state,
        app,
        progress_lease,
        job_id,
        100.0,
        ProgressState::Succeeded,
    );
}

#[allow(clippy::too_many_arguments)]
async fn download_to_destination_inner<R: tauri::Runtime>(
    id: &str,
    url: &str,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    app: &tauri::AppHandle<R>,
    state: &AppState,
    bearer_token: Option<&str>,
    total_size: Option<u32>,
    job_id: String,
    register_pgn_artifact: bool,
    integrity: Option<&ArtifactIntegrity>,
    cancellation: CancellationToken,
    commit_gate: crate::infra::operations::OperationCommitGate,
    file_generation: Option<&std::sync::OnceLock<ProgressGeneration>>,
    lichess_coverage_url: Option<reqwest::Url>,
) -> Result<DownloadPublication, Error> {
    // Validate and reserve all fallible producer prerequisites before starting
    // visible progress. No failed setup may leave a running progress entry.
    let filename = std::ffi::OsString::from(filename);
    let (op, resolved) = {
        state.pgn_path_authority.with_mut(|authority| {
            let operations = authority.download_operations(&destination)?;
            let op = OpClass::from_operations(&operations)?;
            if op.payload_format() != PayloadFormat::PlainFile {
                return Err(Error::InvalidInput(
                    "Payload download requires a plain-file operation".into(),
                ));
            }
            validate_artifact_integrity(op, url, integrity)?;
            let resolved = authority.resolve(
                &destination,
                crate::infra::path_authority::PathOperation::DownloadFile,
                std::slice::from_ref(&filename),
            )?;
            Ok::<_, Error>((op, resolved))
        })??
    };
    let mut staged_file = tempfile::tempfile().map_err(|error| Error::Io(Box::new(error)))?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let progress_lease = begin_progress(&state.progress_state, app, id.to_owned())?;
    if let Some(generation) = file_generation {
        let _ = generation.set(progress_lease.generation);
    }
    let report_error = |error: &Error| {
        report_file_or_provider_download_error(
            state,
            app,
            &progress_lease,
            &job_id,
            error,
            file_generation.is_some(),
        );
    };
    let result = await_staging_deadline(
        DOWNLOAD_DEADLINE,
        &cancellation,
        "download deadline exceeded",
        async {
            let parsed_url = validate_download_request(op, url, bearer_token, &cancellation)?;
            download_payload_network(
                op,
                parsed_url,
                &mut staged_file,
                state.http_transport.as_ref(),
                bearer_token,
                total_size,
                cancellation.clone(),
                integrity.map(|metadata| metadata.sha256.as_str()),
                |progress| {
                    update_progress_with_state(
                        &state.progress_state,
                        app,
                        &progress_lease,
                        progress,
                        ProgressState::Running,
                    )
                },
            )
            .await?;
            let coverage_holds = if let Some(url) = lichess_coverage_url {
                let token = bearer_token.ok_or_else(|| {
                    Error::OAuthFailure("authenticated Lichess account unavailable".into())
                })?;
                Some(
                    crate::lichess::download_coverage_holds(
                        url,
                        token,
                        state.http_transport.as_ref(),
                        &cancellation,
                    )
                    .await?,
                )
            } else {
                None
            };
            crate::infra::blocking::BLOCKING_GATEWAY
                .spawn_cancellable(cancellation.clone(), move |worker_cancellation| {
                    if worker_cancellation.is_cancelled() {
                        return Err(Error::Cancellation);
                    }
                    accept_plain_download_payload(&mut staged_file)?;
                    Ok((staged_file, coverage_holds))
                })
                .await
        },
    )
    .await;
    let (mut staged_file, coverage_holds) = match result {
        Ok(file) => file,
        Err(error) => {
            report_error(&error);
            return Err(error);
        }
    };

    let reservation = if register_pgn_artifact {
        let payload = match crate::infra::path_authority::hash_staged_payload_cancellable(
            staged_file,
            cancellation.clone(),
        )
        .await
        {
            Ok((file, payload)) => {
                staged_file = file;
                payload
            }
            Err(error) => {
                report_error(&error);
                return Err(error);
            }
        };
        let reservation_result = (|| {
            state.pgn_path_authority.with_mut(|authority| {
                authority.reserve_download_artifact(
                    &destination,
                    filename.clone(),
                    payload,
                    filename.to_string_lossy().into_owned(),
                    vec![crate::infra::path_authority::PathOperation::ReadPgn],
                )
            })?
        })();
        match reservation_result {
            Ok(reservation) => Some(reservation),
            Err(error) => {
                report_error(&error);
                return Err(error);
            }
        }
    } else {
        None
    };
    let install_reservation = reservation.clone();
    let commit_gate = commit_gate.clone();
    let install_result = crate::infra::blocking::BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |worker_cancellation| {
            match install_reservation.as_ref() {
                Some(reservation) => resolved
                    .atomic_install_reserved_download_cancellable(
                        reservation,
                        &mut staged_file,
                        worker_cancellation,
                        Some(&commit_gate),
                    )
                    .map(|installed| {
                        (
                            installed.outcome,
                            Some((installed.identity, installed.ctime_nanos)),
                        )
                    }),
                None => {
                    staged_file.rewind()?;
                    resolved
                        .atomic_replace_download_cancellable_with_commit_gate(
                            worker_cancellation,
                            &commit_gate,
                            |target| {
                                copy_cancellable(&mut staged_file, target, worker_cancellation)?;
                                Ok(())
                            },
                        )
                        .map(|outcome| (outcome, None))
                }
            }
        })
        .await;
    let (target_durability, installed_identity) = match install_result {
        Ok(outcome) => outcome,
        Err(error) => {
            if let Some(reservation) = reservation.as_ref() {
                cleanup_download_reservation_best_effort(&state.pgn_path_authority, reservation);
            }
            report_error(&error);
            return Err(error);
        }
    };
    let artifact = if let Some(reservation) = reservation.as_ref() {
        let target_durability = download_target_durability(target_durability);
        let Some((installed_identity, installed_ctime_nanos)) = installed_identity else {
            let error = Error::Conflict("artifact install has no inode marker".into());
            report_error(&error);
            return Err(error);
        };
        match crate::infra::path_authority::activate_download_artifact_runtime(
            &state.pgn_path_authority,
            reservation,
            installed_identity,
            installed_ctime_nanos,
        )
        .await
        {
            Ok(mut artifact) => {
                if let Some(durability) = target_durability {
                    artifact.durability = durability;
                }
                Some(artifact)
            }
            Err(error) => {
                report_error(&error);
                return Err(error);
            }
        }
    } else if let Some(crate::infra::path_authority::CommitDurability::DurabilityUncertain(stage)) =
        download_target_durability(target_durability)
    {
        let error = Error::CommittedDurabilityUncertain(stage);
        report_error(&error);
        return Err(error);
    } else {
        None
    };
    report_download_success(state, app, &progress_lease, &job_id);
    Ok((artifact, coverage_holds))
}

/// Installs a fully validated native-provider PGN staging file as one atomic artifact.
/// Callers may parse/concatenate many pages privately, but no partial file becomes visible.
pub(crate) async fn install_staged_pgn_artifact(
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    staged: tempfile::NamedTempFile,
    state: &AppState,
    cancellation: &CancellationToken,
    commit_gate: Option<&crate::infra::operations::OperationCommitGate>,
) -> Result<crate::infra::path_authority::ArtifactPublication, Error> {
    let staged = staged.into_file();
    let filename = std::ffi::OsString::from(filename);
    let (mut staged, payload) =
        crate::infra::path_authority::hash_staged_payload_cancellable(staged, cancellation.clone())
            .await?;
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    let resolved = state.pgn_path_authority.with_mut(|authority| {
        authority.resolve(
            &destination,
            crate::infra::path_authority::PathOperation::DownloadFile,
            std::slice::from_ref(&filename),
        )
    })??;
    let reservation = state.pgn_path_authority.with_mut(|authority| {
        authority.reserve_download_artifact(
            &destination,
            filename.clone(),
            payload,
            filename.to_string_lossy().into_owned(),
            vec![crate::infra::path_authority::PathOperation::ReadPgn],
        )
    })??;
    let installation_reservation = reservation.clone();
    let commit_gate = commit_gate.cloned();
    let install = crate::infra::blocking::BLOCKING_GATEWAY
        .spawn_cancellable(cancellation.clone(), move |worker_cancellation| {
            resolved.atomic_install_reserved_download_cancellable(
                &installation_reservation,
                &mut staged,
                worker_cancellation,
                commit_gate.as_ref(),
            )
        })
        .await;
    let target_durability = match install {
        Ok(installed) => installed,
        Err(error) => {
            cleanup_download_reservation_best_effort(&state.pgn_path_authority, &reservation);
            return Err(error);
        }
    };
    let durability = download_target_durability(target_durability.outcome);
    let mut artifact = crate::infra::path_authority::activate_download_artifact_runtime(
        &state.pgn_path_authority,
        &reservation,
        target_durability.identity,
        target_durability.ctime_nanos,
    )
    .await?;
    if let Some(durability) = durability {
        artifact.durability = durability;
    }
    Ok(artifact)
}

fn lichess_games_url(player: &str, since_ms: Option<i64>) -> Result<(reqwest::Url, String), Error> {
    let player = crate::lichess::lichess_user_segment(player)?.to_owned();
    if since_ms.is_some_and(|since_ms| since_ms < 0) {
        return Err(Error::InvalidInput(
            "invalid Lichess export timestamp".into(),
        ));
    }
    let mut url = reqwest::Url::parse("https://lichess.org/api/games/user/")
        .map_err(|_| Error::OAuthFailure("invalid Lichess endpoint".into()))?;
    url.path_segments_mut()
        .map_err(|_| Error::OAuthFailure("invalid Lichess endpoint".into()))?
        .push(&player);
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("perfType", &crate::lichess::ACCOUNT_EXPORT_PERFS.join(","));
        query.append_pair("rated", "true");
        query.append_pair("sort", "dateAsc");
        if let Some(since_ms) = since_ms {
            query.append_pair("since", &since_ms.to_string());
        }
    }
    Ok((url, player))
}

/// Authenticated Lichess export. The opaque handle is resolved in the native credential store;
/// neither its bearer token nor a native destination path crosses IPC.
#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)]
pub async fn download_lichess_games(
    handle: crate::credentials::LichessAccountHandle,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    player: String,
    since_ms: Option<i64>,
    job_id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::path_authority::ArtifactPublication, Error> {
    download_publication_result(
        download_lichess_games_runtime(
            handle,
            destination,
            filename,
            player,
            since_ms,
            job_id,
            window.label(),
            &app,
            state.inner(),
        )
        .await,
    )
    .map_err(sanitize_download_error)
}

pub(crate) fn download_publication_result(
    result: Result<crate::infra::operations::RuntimeDownload, Error>,
) -> Result<crate::infra::path_authority::ArtifactPublication, Error> {
    result.and_then(|downloaded| match downloaded.receipt_error {
        Some(error) => Err(error),
        None => Ok(downloaded.publication),
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn download_lichess_games_runtime<R: tauri::Runtime>(
    handle: crate::credentials::LichessAccountHandle,
    destination: crate::infra::path_authority::PathRef,
    filename: String,
    player: String,
    since_ms: Option<i64>,
    job_id: String,
    owner: &str,
    app: &tauri::AppHandle<R>,
    state: &AppState,
) -> Result<crate::infra::operations::RuntimeDownload, Error> {
    let admission_key = format!(
        "lichess_{}",
        crate::lichess::lichess_user_segment(&player)?.to_ascii_lowercase()
    );
    let lease = state.operations.claim_download(
        &job_id,
        owner,
        "download_lichess_games",
        &job_id,
        &admission_key,
        true,
        MAX_ACTIVE_DOWNLOADS,
    )?;
    let operations = state
        .pgn_path_authority
        .with_mut(|authority| authority.download_operations(&destination))??;
    if OpClass::from_operations(&operations)? != OpClass::Lichess {
        return Err(Error::InvalidInput(
            "Lichess download requires a Lichess destination".into(),
        ));
    }
    let (url, _) = lichess_games_url(&player, since_ms)?;
    let mut coverage_url = url.clone();
    coverage_url.set_query(None);
    {
        let mut query = coverage_url.query_pairs_mut();
        if let Some(since) = since_ms {
            query.append_pair("since", &since.to_string());
        }
        query.append_pair("ongoing", "true");
        for key in ["moves", "tags", "clocks", "evals", "opening"] {
            query.append_pair(key, "false");
        }
    }
    let token = state
        .credentials
        .token_async(handle)
        .await?
        .ok_or_else(|| Error::OAuthFailure("authenticated Lichess account unavailable".into()))?;
    let cancellation = lease.token();
    let (publication, coverage_holds) = download_to_destination(
        &job_id,
        url.as_str(),
        destination,
        filename,
        app,
        state,
        Some(&token),
        None,
        job_id.clone(),
        lease,
        true,
        None,
        Some(coverage_url),
    )
    .await?;
    let publication = publication
        .ok_or_else(|| Error::Conflict("Lichess download did not register an artifact".into()))?;
    let mut downloaded = crate::infra::operations::RuntimeDownload {
        publication,
        receipt_error: None,
        coverage_holds,
    };
    downloaded.receipt_error = crate::db::linked_collections::record_download_receipt(
        &state.pgn_path_authority,
        downloaded.publication.handle.clone(),
        "lichess",
        &player,
        since_ms,
        downloaded.coverage_holds.clone(),
        cancellation,
    )
    .await;
    Ok(downloaded)
}

#[cfg(test)]
fn resolve_engine_archive_destination(
    state: &AppState,
    destination: &crate::infra::path_authority::PathRef,
    directory_name: &std::ffi::OsStr,
) -> Result<(OpClass, crate::infra::path_authority::ResolvedPath), Error> {
    resolve_engine_archive_destination_cancellable(
        state,
        destination,
        directory_name,
        &CancellationToken::new(),
    )
}

fn resolve_engine_archive_destination_cancellable(
    state: &AppState,
    destination: &crate::infra::path_authority::PathRef,
    directory_name: &std::ffi::OsStr,
    cancellation: &CancellationToken,
) -> Result<(OpClass, crate::infra::path_authority::ResolvedPath), Error> {
    use crate::infra::path_authority::{with_engine_root_probe, PathOperation};
    with_engine_root_probe(
        &state.pgn_path_authority,
        destination,
        PathOperation::DownloadArchive,
        cancellation,
        |authority, probe| {
            let operations = authority.download_operations(destination)?;
            let op = OpClass::from_operations(&operations)?;
            if op != OpClass::Engine {
                return Err(Error::InvalidInput(
                    "engine archive requires an engine destination".into(),
                ));
            }
            let resolved = authority.resolve_with_engine_probe(
                destination,
                crate::infra::path_authority::PathOperation::DownloadArchive,
                &[directory_name.to_os_string()],
                probe,
            )?;
            Ok((op, resolved))
        },
    )
}

fn create_engine_archive_staging(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    destination: &crate::infra::path_authority::PathRef,
    resolved: &crate::infra::path_authority::ResolvedPath,
    cancellation: &CancellationToken,
) -> Result<crate::infra::fs::OwnedStagingDir, Error> {
    resolved.create_archive_staging().map_err(|error| {
        crate::infra::path_authority::probe_engine_root_failure(
            authority,
            destination,
            error,
            cancellation,
        )
    })
}

/// Downloads and atomically installs an engine archive into an authority-managed directory.
/// Archive extraction occurs entirely in a private staging directory; the sealed authority API
/// commits the completed tree only after all archive validation succeeds.
#[allow(clippy::too_many_arguments)]
async fn download_engine_archive_core<R: tauri::Runtime>(
    progress_lease: ProgressLease,
    url: String,
    destination: crate::infra::path_authority::PathRef,
    directory_name: String,
    job_id: String,
    integrity: ArtifactIntegrity,
    app: tauri::AppHandle<R>,
    state: AppState,
    cancellation: CancellationToken,
    commit_gate: crate::infra::operations::OperationCommitGate,
    validate_integrity: ArtifactIntegrityValidator,
) -> Result<(), Error> {
    let result = async {
        let directory_name = std::ffi::OsString::from(directory_name);
        let resolution_state = state.clone();
        let resolution_destination = destination.clone();
        let resolution_cancellation = cancellation.clone();
        let (op, resolved) = crate::infra::blocking::BLOCKING_GATEWAY
            .spawn(move || {
                resolve_engine_archive_destination_cancellable(
                    &resolution_state,
                    &resolution_destination,
                    &directory_name,
                    &resolution_cancellation,
                )
            })
            .await?;
        validate_integrity(op, &url, &integrity)?;
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        // A verified artefact has a stable directory name. Never replace an existing tree:
        // it may be registered already, and an engine may still be executing from it.
        let adoption_authority = state.pgn_path_authority.clone();
        let adoption_destination = destination.clone();
        let adoption_cancellation = cancellation.clone();
        let (adopted, resolved) = crate::infra::blocking::BLOCKING_GATEWAY
            .spawn(move || {
                let adopted = crate::infra::path_authority::with_engine_root_probe(
                    &adoption_authority,
                    &adoption_destination,
                    crate::infra::path_authority::PathOperation::DownloadArchive,
                    &adoption_cancellation,
                    |authority, probe| {
                        authority.confirm_catalog_archive_adoption_with_probe(
                            &adoption_destination,
                            &resolved,
                            probe,
                        )
                    },
                )?;
                Ok((adopted, resolved))
            })
            .await?;
        if adopted {
            commit_gate.begin_commit()?;
            return Ok(());
        }
        let archive_target = resolved
            .target()
            .ok_or_else(|| {
                Error::InvalidInput("archive destination needs a target directory".into())
            })?
            .to_path_buf();
        let resolved = std::sync::Arc::new(resolved);
        let staging_authority = resolved.clone();
        let staging_registry = state.pgn_path_authority.clone();
        let staging_destination = destination.clone();
        let staging_cancellation = cancellation.clone();
        let (prepared_tx, prepared_rx) = tokio::sync::oneshot::channel();
        let (publish_tx, publish_rx) = tokio::sync::oneshot::channel();
        let publication_authority = state.pgn_path_authority.clone();
        let producer = prepare_archive_download(
            ArchiveDownloadRequest {
                op,
                url: &url,
                transport: state.http_transport.as_ref(),
                token: None,
                total_size: None,
                expected_sha256: Some(&integrity.sha256),
            },
            &archive_target,
            move |_prefix| {
                create_engine_archive_staging(
                    &staging_registry,
                    &staging_destination,
                    &staging_authority,
                    &staging_cancellation,
                )
            },
            cancellation.clone(),
            |progress| {
                update_progress_with_state(
                    &state.progress_state,
                    &app,
                    &progress_lease,
                    progress * DOWNLOAD_PROGRESS_SHARE,
                    ProgressState::Running,
                )
            },
            move |mut staging, _pin, token| {
                // The worker retains the owner while the async side ends its preparation
                // deadline. A dropped/expired awaiter closes the permit and cleanup runs here.
                if prepared_tx.send(()).is_err()
                    || publish_rx.blocking_recv().is_err()
                    || token.is_cancelled()
                {
                    return Err(Error::Cancellation);
                }
                commit_gate.begin_commit()?;
                publish_engine_archive_tree(
                    &publication_authority,
                    &destination,
                    &resolved,
                    &mut staging,
                )
            },
        );
        let admission = async move {
            if prepared_rx.await.is_ok() {
                let _ = publish_tx.send(());
            } else {
                drop(publish_tx);
            }
        };
        let install_result = await_staging_deadline_with_admission(
            DOWNLOAD_DEADLINE,
            &cancellation,
            "engine archive download deadline exceeded",
            producer,
            admission,
        )
        .await;
        if let Err(error) = install_result {
            report_download_error(&state, &app, &progress_lease, &job_id, &error);
            return Err(error);
        }
        Ok(())
    }
    .await;
    result.map_err(sanitize_download_error)
}

#[tauri::command]
#[specta::specta]
pub async fn install_engine_workflow(
    id: String,
    request: crate::infra::operations::completions::EngineInstallRequest,
    job_id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<crate::infra::operations::completions::EngineCompletion, Error> {
    install_engine_workflow_runtime(
        id,
        request,
        job_id,
        app,
        window.label().to_owned(),
        state.inner().clone(),
    )
    .await
}

pub(crate) async fn install_engine_workflow_runtime<R: tauri::Runtime>(
    id: String,
    request: crate::infra::operations::completions::EngineInstallRequest,
    job_id: String,
    app: tauri::AppHandle<R>,
    owner: String,
    state: AppState,
) -> Result<crate::infra::operations::completions::EngineCompletion, Error> {
    let (snapshot, lease) = state.operations.admit_engine_completion(
        &id,
        &owner,
        &job_id,
        request,
        MAX_ACTIVE_DOWNLOADS,
    )?;
    let Some(lease) = lease else {
        return Ok(snapshot);
    };
    run_engine_install_completion(
        snapshot,
        lease,
        app,
        state.clone(),
        Box::new(|op, url, integrity| validate_artifact_integrity(op, url, Some(integrity))),
        owner.clone(),
    )
    .await
}

/// The command receiver owns no continuation. Both result retention and all native tails run
/// inside the accepted operation, including when that receiver disappears after publication.
async fn run_engine_install_completion<R: tauri::Runtime>(
    snapshot: crate::infra::operations::completions::EngineCompletion,
    lease: crate::infra::operations::OperationLease,
    app: tauri::AppHandle<R>,
    state: AppState,
    validate_integrity: ArtifactIntegrityValidator,
    owner: String,
) -> Result<crate::infra::operations::completions::EngineCompletion, Error> {
    use futures_util::FutureExt as _;
    use tauri_specta::Event as _;
    let cancellation = lease.token();
    let commit_gate = lease.commit_gate();
    crate::infra::operations::run_native_operation(lease, "install_engine_workflow", async move {
        let id = &snapshot.id;
        let request = &snapshot.request;
        let progress = begin_progress(&state.progress_state, &app, request.progress_id.clone());
        let result = match &progress {
            Ok(progress) => {
                state
                    .operations
                    .set_engine_completion_progress(id, progress.clone())?;
                match std::panic::AssertUnwindSafe(engine_install_workflow_core(
                    &snapshot,
                    &app,
                    &state,
                    cancellation,
                    commit_gate,
                    progress.clone(),
                    validate_integrity,
                ))
                .catch_unwind()
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(Error::Conflict("engine completion worker panicked".into())),
                }
            }
            Err(_) => Err(Error::Conflict(
                "engine completion progress unavailable".into(),
            )),
        };
        let terminal = state.operations.finish_engine_completion(id, &result)?;
        if let (Err(error), Ok(progress)) = (&result, &progress) {
            report_download_error(&state, &app, progress, id, error);
        }
        if let Err(error) =
            (crate::infra::operations::completions::CompletionChanged { id: id.clone() })
                .emit_to(&app, owner)
        {
            log::warn!("completion {id} notification failed: {error}");
        }
        // Errors retain the renderer-safe payload for recovery, and are fully logged natively.
        if let Err(error) = result {
            log::error!("engine completion {id} failed: {}", error.diagnostic());
        }
        Ok(terminal)
    })
    .await
}

const MAX_RETAINED_ENGINE_CONFIGURATION_BYTES: usize = 256 * 1024;
// Download reports occupy the first 90 percent of the bar. Configuration is marked at 95
// so the last slice stays available for renderer application.
const DOWNLOAD_PROGRESS_SHARE: f32 = 0.9;
const CONFIGURATION_READY_PROGRESS: f32 = 95.0;

async fn engine_install_workflow_core<R: tauri::Runtime>(
    snapshot: &crate::infra::operations::completions::EngineCompletion,
    app: &tauri::AppHandle<R>,
    state: &AppState,
    cancellation: CancellationToken,
    commit_gate: crate::infra::operations::OperationCommitGate,
    progress: ProgressLease,
    validate_integrity: ArtifactIntegrityValidator,
) -> Result<crate::infra::operations::completions::InstalledEngineResult, Error> {
    use crate::infra::operations::completions::EngineInstallIntent;
    let id = &snapshot.id;
    let request = &snapshot.request;
    let root = request.root.clone();
    let old = match &request.intent {
        EngineInstallIntent::Upgrade { expected, .. } => Some(expected.id.clone()),
        _ => None,
    };
    let authority = state.pgn_path_authority.clone();
    let workflow_id = id.to_owned();
    let destination = crate::infra::blocking::BLOCKING_GATEWAY
        .spawn(move || {
            let mut resources = vec![root.id.clone()];
            resources.extend(old);
            authority.with_mut(|authority| {
                authority.retain_completion_resources(&workflow_id, resources)
            })??;
            crate::engine_archive_destination_blocking(&authority, root)
        })
        .await?;
    let archive = request
        .url
        .rsplit('/')
        .next()
        .ok_or_else(|| Error::InvalidInput("engine archive URL unavailable".into()))?;
    let directory = format!("{archive}-{}", request.sha256.to_ascii_lowercase());
    download_engine_archive_core(
        progress.clone(),
        request.url.clone(),
        destination,
        directory.clone(),
        id.to_owned(),
        ArtifactIntegrity {
            sha256: request.sha256.clone(),
            signature: request.signature.clone(),
        },
        app.clone(),
        state.clone(),
        cancellation,
        commit_gate,
        validate_integrity,
    )
    .await?;
    // Publication is the irreversible commit gate. Registration and probing are its accepted tail.
    let authority = state.pgn_path_authority.clone();
    let root = request.root.clone();
    let relative = format!("{directory}/{}", request.relative_path);
    let workflow_id = id.to_owned();
    let old = match &request.intent {
        EngineInstallIntent::Upgrade { expected, .. } => Some(expected.id.clone()),
        _ => None,
    };
    let handle = crate::infra::blocking::BLOCKING_GATEWAY
        .spawn(move || {
            let handle =
                crate::register_installed_engine_blocking(&authority, root.clone(), relative)?;
            let mut resources = vec![root.id, handle.id.clone()];
            resources.extend(old);
            authority.with_mut(|authority| {
                authority.retain_completion_resources(&workflow_id, resources)
            })??;
            Ok(handle)
        })
        .await?;
    let config = crate::chess::get_engine_config_core(handle.clone(), state).await?;
    if serde_json::to_vec(&config)
        .map_err(|_| {
            Error::Conflict("engine completion configuration could not be encoded".into())
        })?
        .len()
        > MAX_RETAINED_ENGINE_CONFIGURATION_BYTES
    {
        return Err(Error::ResourceLimit(
            "engine completion configuration exceeds its limit".into(),
        ));
    }
    if let Err(error) = update_progress_with_state(
        &state.progress_state,
        app,
        &progress,
        CONFIGURATION_READY_PROGRESS,
        ProgressState::Running,
    ) {
        log::warn!(
            "engine completion {id} progress notification failed: {}",
            error.diagnostic()
        );
    }
    Ok(
        crate::infra::operations::completions::InstalledEngineResult {
            handle,
            config,
            filename: request
                .relative_path
                .rsplit('/')
                .next()
                .unwrap_or(&request.name)
                .to_owned(),
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn pending_engine_completions(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::infra::operations::completions::EngineCompletion>, Error> {
    state.operations.engine_completions(window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn retire_engine_completion(
    id: String,
    current: Option<crate::infra::path_authority::EngineHandle>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    retire_engine_completion_runtime(
        id,
        current,
        window.label().to_owned(),
        state.inner().clone(),
    )
    .await
}

pub(crate) async fn retire_engine_completion_runtime(
    id: String,
    current: Option<crate::infra::path_authority::EngineHandle>,
    owner: String,
    state: AppState,
) -> Result<(), Error> {
    use crate::infra::operations::completions::{
        CompletionOutcome, EngineApplicationStep, EngineInstallIntent,
    };
    let (application, start) = state.operations.begin_engine_application(
        &id,
        &owner,
        EngineApplicationStep::Retirement,
    )?;
    if let Some(start) = start {
        crate::infra::operations::run_completion_application(
            start.lease,
            start.result,
            "retire_engine_completion",
            async move {
                let (
                    EngineInstallIntent::Upgrade {
                        engine_id,
                        expected,
                    },
                    CompletionOutcome::Succeeded(installed),
                ) = (start.snapshot.request.intent, start.snapshot.outcome)
                else {
                    return Err(Error::Conflict(
                        "completion is not an installed upgrade".into(),
                    ));
                };
                let transition = current.as_ref() == Some(&installed.handle);
                let captured = start
                    .retirement
                    .get_or_try_init(|| {
                        state.engine_supervisor.capture_binary_retirement(
                            engine_id,
                            expected.id,
                            installed.handle.id,
                            transition,
                        )
                    })
                    .await?;
                state
                    .engine_supervisor
                    .resume_binary_retirement(captured)
                    .await?;
                state.operations.finish_engine_retirement(&id, &owner)
            },
        );
    }
    application.await.map_err(Error::Shared)
}

#[tauri::command]
#[specta::specta]
pub async fn acknowledge_engine_completion(
    id: String,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    acknowledge_engine_completion_runtime(id, app, window.label().to_owned(), state.inner().clone())
        .await
}

pub(crate) async fn acknowledge_engine_completion_runtime<R: tauri::Runtime>(
    id: String,
    app: tauri::AppHandle<R>,
    owner: String,
    state: AppState,
) -> Result<(), Error> {
    use crate::infra::operations::completions::EngineApplicationStep;
    let (application, start) = state.operations.begin_engine_application(
        &id,
        &owner,
        EngineApplicationStep::Acknowledgement,
    )?;
    if let Some(start) = start {
        crate::infra::operations::run_completion_application(
            start.lease,
            start.result,
            "acknowledge_engine_completion",
            async move {
                crate::infra::blocking::BLOCKING_GATEWAY
                    .spawn(move || {
                        let progress = state.pgn_path_authority.with_mut(|authority| {
                            let progress = state
                                .operations
                                .acknowledge_engine_completion(&id, &owner)?;
                            authority.release_completion_resources(&id);
                            Ok::<_, Error>(progress)
                        })??;
                        if let Some(progress) = progress {
                            // Failed/cancelled progress is terminal-sticky and cannot become success here.
                            if let Err(error) = update_progress_with_state(
                                &state.progress_state,
                                &app,
                                &progress,
                                100.0,
                                ProgressState::Succeeded,
                            ) {
                                log::warn!(
                                    "completion {id} final progress failed: {}",
                                    error.diagnostic()
                                );
                            }
                        }
                        Ok(())
                    })
                    .await
            },
        );
    }
    application.await.map_err(Error::Shared)
}

/// Publishes a fully extracted engine archive onto its authority-resolved destination. Split out
/// from `download_engine_archive` so ownership can pass directly from preparation into inventory
/// and the retained-parent commit. The caller keeps the owner on its blocking worker.
pub(crate) fn publish_engine_archive_tree(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    destination: &crate::infra::path_authority::PathRef,
    resolved: &crate::infra::path_authority::ResolvedPath,
    staging_dir: &mut crate::infra::fs::OwnedStagingDir,
) -> Result<(), Error> {
    crate::infra::path_authority::with_engine_root_probe(
        authority,
        destination,
        crate::infra::path_authority::PathOperation::DownloadArchive,
        &CancellationToken::new(),
        |authority, probe| {
            authority.publish_catalog_install_with_probe(destination, resolved, staging_dir, probe)
        },
    )
}

#[tauri::command]
#[specta::specta]
pub fn prepare_download(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<String, Error> {
    state.operations.prepare_download(window.label())
}

#[tauri::command]
#[specta::specta]
pub fn release_download(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<(), Error> {
    state.operations.release_download(&id, window.label())
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_download(
    id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    state.operations.cancel_download(&id, window.label())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_download_for_progress(
    progress_id: String,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    state
        .operations
        .cancel_download_for_progress(&progress_id, window.label())
}

#[cfg(test)]
fn private_tempdir_in(prefix: &str, parent: &Path) -> Result<tempfile::TempDir, Error> {
    let mut builder = tempfile::Builder::new();
    builder.prefix(prefix);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    builder
        .tempdir_in(parent)
        .map_err(|error| Error::Io(Box::new(error)))
}

fn validate_archive_path(path: &str) -> Result<PathBuf, Error> {
    if path.is_empty() || path.len() > MAX_ARCHIVE_PATH_BYTES {
        return Err(Error::InvalidInput("Invalid path length".into()));
    }
    let p = Path::new(path);
    if p.is_absolute() {
        return Err(Error::InvalidInput("Absolute path in archive".into()));
    }
    #[cfg(unix)]
    let mut normal_components = 0usize;
    for component in p.components() {
        match component {
            std::path::Component::Prefix(_) => {
                return Err(Error::InvalidInput("Prefix in path".into()))
            }
            std::path::Component::RootDir => {
                return Err(Error::InvalidInput("Root dir in path".into()))
            }
            std::path::Component::ParentDir => {
                return Err(Error::InvalidInput("Parent dir in path".into()))
            }
            std::path::Component::Normal(n) => {
                #[cfg(unix)]
                {
                    normal_components += 1;
                }
                let s = n.to_string_lossy();
                if s.contains('\0') {
                    return Err(Error::InvalidInput("Null byte in path".into()));
                }
            }
            std::path::Component::CurDir => {}
        }
    }
    #[cfg(unix)]
    if normal_components > MAX_ARCHIVE_PATH_COMPONENTS {
        // Experimentally, reinstall cleanup accepts one fewer archive component than
        // `MAX_REMOVE_TREE_DEPTH`: the installed staging root occupies removal depth zero.
        return Err(Error::ResourceLimit(
            "Archive path has too many components".into(),
        ));
    }
    // Only Normal names: Path::components keeps a leading CurDir (`./foo` stays `./foo`),
    // which the owned staging walk refuses. Middle `.` and trailing slashes are already dropped.
    Ok(p.components()
        .filter(|component| matches!(component, std::path::Component::Normal(_)))
        .collect())
}

fn map_zip_error(error: zip::result::ZipError, message: &str) -> Error {
    match error {
        zip::result::ZipError::Io(source) => Error::Io(Box::new(source)),
        _ => Error::InvalidInput(message.into()),
    }
}

#[cfg(test)]
fn create_test_archive_staging(
    pin: &std::fs::File,
    dest_parent: &Path,
    prefix: &str,
) -> Result<crate::infra::fs::OwnedStagingDir, Error> {
    // Standalone fixtures supply both a logical locator and a pin. Production's closed
    // resolution door makes this relationship structural instead.
    let logical_parent = crate::infra::fs::open_parent_no_follow(&dest_parent.join("installed"))?;
    if crate::infra::path_authority::opened_file_identity(&logical_parent)?
        != crate::infra::path_authority::opened_file_identity(pin)?
    {
        return Err(Error::Conflict(
            "archive staging parent changed concurrently".into(),
        ));
    }
    crate::infra::fs::OwnedStagingDir::create_in(pin, prefix)
}

#[cfg(test)]
fn extract_zip_cancellable(
    file: std::fs::File,
    pin: &std::fs::File,
    dest_parent: &Path,
    dest_leaf: &OsStr,
    limits: ArchiveLimits,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let staging = create_test_archive_staging(pin, dest_parent, ".zip")?;
    let source = prepare_zip_cancellable(file, staging, limits, cancellation)?;
    install_extracted_tree(source, pin, dest_parent, dest_leaf, cancellation)
}

fn prepare_zip_cancellable(
    file: std::fs::File,
    staging: crate::infra::fs::OwnedStagingDir,
    limits: ArchiveLimits,
    cancellation: &CancellationToken,
) -> Result<crate::infra::fs::OwnedStagingDir, Error> {
    let mut archive =
        zip::ZipArchive::new(file).map_err(|error| map_zip_error(error, "Invalid zip archive"))?;

    let mut total_expanded = 0u64;
    if archive.len() > limits.entries {
        return Err(Error::ResourceLimit("Too many entries in zip".into()));
    }

    for i in 0..archive.len() {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut file = archive
            .by_index(i)
            .map_err(|error| map_zip_error(error, "Invalid zip entry"))?;

        let validated_path = validate_archive_path(file.name())?;

        let size = file.size();
        if size > limits.per_entry {
            return Err(Error::ResourceLimit("Zip entry too large".into()));
        }

        let compressed_size = file.compressed_size();
        if compressed_size > 0 && size > compressed_size.saturating_mul(limits.ratio) {
            return Err(Error::ResourceLimit(
                "High compression ratio detected".into(),
            ));
        }

        if (*file.name()).ends_with('/') {
            staging.ensure_relative_directory(&validated_path)?;
        } else {
            write_regular_archive_entry(
                &mut file,
                &staging,
                &validated_path,
                size,
                &mut total_expanded,
                limits.expanded,
                cancellation,
            )?;
        }
    }

    Ok(staging)
}

#[cfg(test)]
fn extract_tar_cancellable(
    file: std::fs::File,
    pin: &std::fs::File,
    dest_parent: &Path,
    dest_leaf: &OsStr,
    limits: ArchiveLimits,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let staging = create_test_archive_staging(pin, dest_parent, ".tar")?;
    let source = prepare_tar_cancellable(file, staging, limits, cancellation)?;
    install_extracted_tree(source, pin, dest_parent, dest_leaf, cancellation)
}

fn prepare_tar_cancellable(
    file: std::fs::File,
    staging: crate::infra::fs::OwnedStagingDir,
    limits: ArchiveLimits,
    cancellation: &CancellationToken,
) -> Result<crate::infra::fs::OwnedStagingDir, Error> {
    let mut archive = tar::Archive::new(file);
    let mut entry_count = 0;
    let mut total_expanded = 0u64;

    for entry in archive.entries()? {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let mut entry = entry?;

        entry_count += 1;
        if entry_count > limits.entries {
            return Err(Error::ResourceLimit("Too many entries in tar".into()));
        }

        let path_cow = entry.path()?;
        let path_str = path_cow
            .to_str()
            .ok_or_else(|| Error::InvalidInput("Non-Unicode path in archive".into()))?;
        let validated_path = validate_archive_path(path_str)?;

        let header = entry.header();
        let entry_type = header.entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(Error::InvalidInput(
                "Special files/links not allowed in archive".into(),
            ));
        }

        let size = entry.size();
        if size > limits.per_entry {
            return Err(Error::ResourceLimit("Tar entry too large".into()));
        }

        if entry_type.is_dir() {
            staging.ensure_relative_directory(&validated_path)?;
        } else {
            write_regular_archive_entry(
                &mut entry,
                &staging,
                &validated_path,
                size,
                &mut total_expanded,
                limits.expanded,
                cancellation,
            )?;
        }
    }

    Ok(staging)
}

fn write_regular_archive_entry(
    input: &mut impl Read,
    staging: &crate::infra::fs::OwnedStagingDir,
    relative: &Path,
    per_entry_limit: u64,
    total_expanded: &mut u64,
    total_limit: u64,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(all(test, unix))]
    {
        let mut bytes = Vec::new();
        bounded_copy(
            input,
            &mut bytes,
            per_entry_limit,
            total_expanded,
            total_limit,
            cancellation,
        )?;
        staging.ensure_relative_directory(relative.parent().unwrap_or(Path::new("")))?;
        crate::infra::test_executable::publish_test_archive_entry(
            staging.directory()?,
            relative,
            &bytes,
        )?;
    }
    #[cfg(not(all(test, unix)))]
    {
        let mut outfile = staging.create_relative_regular(relative)?;
        bounded_copy(
            input,
            &mut outfile,
            per_entry_limit,
            total_expanded,
            total_limit,
            cancellation,
        )?;
    }
    Ok(())
}

#[cfg(test)]
type ArchivePreInstallHook = Box<dyn FnOnce(&Path)>;

#[cfg(test)]
std::thread_local! {
    static ARCHIVE_PRE_INSTALL_HOOK:
        std::cell::RefCell<Option<ArchivePreInstallHook>> =
        const { std::cell::RefCell::new(None) };
}

/// Sets a one-shot hook in the shared installer, before cancellation and parent identity checks.
#[cfg(test)]
fn set_archive_pre_install_hook(hook: Option<ArchivePreInstallHook>) {
    ARCHIVE_PRE_INSTALL_HOOK.with(|slot| *slot.borrow_mut() = hook);
}

#[cfg(test)]
fn run_archive_pre_install_hook(dest_parent: &Path) {
    let hook = ARCHIVE_PRE_INSTALL_HOOK.with(|slot| slot.borrow_mut().take());
    if let Some(hook) = hook {
        hook(dest_parent);
    }
}

#[cfg(test)]
type CoreAfterPinHook = Box<dyn FnOnce(&Path) + Send>;

#[cfg(test)]
static CORE_AFTER_PIN_HOOKS: std::sync::Mutex<
    std::collections::BTreeMap<PathBuf, CoreAfterPinHook>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
static ARCHIVE_GZIP_SCRATCH_HOOKS: std::sync::Mutex<
    std::collections::BTreeMap<PathBuf, CoreAfterPinHook>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
static ARCHIVE_PAYLOAD_HOOKS: std::sync::Mutex<
    std::collections::BTreeMap<PathBuf, CoreAfterPinHook>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
type ArchivePayloadCreatedHook = Box<dyn FnOnce(&std::fs::File) + Send>;

#[cfg(test)]
static ARCHIVE_PAYLOAD_CREATED_HOOKS: std::sync::Mutex<
    std::collections::BTreeMap<PathBuf, ArchivePayloadCreatedHook>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
static ARCHIVE_PAYLOAD_CREATE_FAULTS: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Error>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
static ARCHIVE_PAYLOAD_NETWORK_DONE_HOOKS: std::sync::Mutex<
    std::collections::BTreeMap<PathBuf, CoreAfterPinHook>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
static ARCHIVE_PAYLOAD_CLEANUP_HOOKS: std::sync::Mutex<
    std::collections::BTreeMap<PathBuf, CoreAfterPinHook>,
> = std::sync::Mutex::new(std::collections::BTreeMap::new());

#[cfg(test)]
fn run_archive_payload_create_fault(target: &Path) -> Result<(), Error> {
    match ARCHIVE_PAYLOAD_CREATE_FAULTS.lock().unwrap().remove(target) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

#[cfg(test)]
fn run_archive_payload_created_hook(target: &Path, file: &std::fs::File) {
    let hook = ARCHIVE_PAYLOAD_CREATED_HOOKS.lock().unwrap().remove(target);
    if let Some(hook) = hook {
        hook(file);
    }
}

/// Keyed by the unique test target so a different operation cannot consume the hook.
#[cfg(test)]
fn set_core_after_pin_hook(path: &Path, hook: Option<CoreAfterPinHook>) {
    let mut hooks = CORE_AFTER_PIN_HOOKS.lock().unwrap();
    if let Some(hook) = hook {
        assert!(hooks.insert(path.to_path_buf(), hook).is_none());
    } else {
        hooks.remove(path);
    }
}

#[cfg(test)]
fn run_path_hook(
    hooks: &std::sync::Mutex<std::collections::BTreeMap<PathBuf, CoreAfterPinHook>>,
    path: &Path,
) {
    let hook = hooks.lock().unwrap().remove(path);
    if let Some(hook) = hook {
        hook(path);
    }
}

fn archive_payload_required() -> Error {
    Error::InvalidInput("Download payload must be a zip, tar or tar.gz archive".into())
}

fn validate_prepared_tree(
    source: &crate::infra::fs::OwnedStagingDir,
    pin: &std::fs::File,
    _dest_parent: &Path,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    #[cfg(test)]
    run_archive_pre_install_hook(_dest_parent);
    if cancellation.is_cancelled() {
        return Err(Error::Cancellation);
    }
    if crate::infra::path_authority::opened_file_identity(pin)? != source.parent_identity()? {
        return Err(Error::Conflict(
            "archive staging parent changed concurrently".into(),
        ));
    }
    Ok(())
}

/// Installs an adopted tree only after the shared preparation checks.
#[cfg(test)]
fn install_extracted_tree(
    source: crate::infra::fs::OwnedStagingDir,
    pin: &std::fs::File,
    _dest_parent: &Path,
    dest_leaf: &OsStr,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    validate_prepared_tree(&source, pin, _dest_parent, cancellation)?;
    crate::infra::fs::install_owned_staging_dir(source, dest_leaf)
}

/// Recognizes a full ustar header using the POSIX unsigned checksum.
fn is_ustar_header(block: &[u8]) -> bool {
    let Some(block) = block.get(..TAR_BLOCK_SIZE) else {
        return false;
    };
    if &block[USTAR_MAGIC_OFFSET..USTAR_MAGIC_OFFSET + USTAR_MAGIC.len()] != USTAR_MAGIC {
        return false;
    }

    let field = &block[TAR_CHECKSUM_FIELD];
    let start = field
        .iter()
        .position(|&byte| byte != b' ')
        .unwrap_or(field.len());
    let field = &field[start..];
    let digits = field
        .iter()
        .take_while(|&&byte| matches!(byte, b'0'..=b'7'))
        .count();
    if digits == 0
        || field[digits..]
            .iter()
            .any(|&byte| !matches!(byte, 0 | b' '))
    {
        return false;
    }
    let stored_checksum = field[..digits]
        .iter()
        .fold(0_u32, |sum, &byte| sum * 8 + u32::from(byte - b'0'));
    let checksum: u32 = block
        .iter()
        .enumerate()
        .map(|(index, &byte)| {
            u32::from(if TAR_CHECKSUM_FIELD.contains(&index) {
                b' '
            } else {
                byte
            })
        })
        .sum();
    stored_checksum == checksum
}

/// Peeks at the decompressed header, leaving the compressed file rewound for extraction.
fn gzip_is_tar(file: &mut std::fs::File) -> Result<bool, Error> {
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))?;
    let mut head = Vec::with_capacity(TAR_BLOCK_SIZE);
    flate2::read::GzDecoder::new(&mut *file)
        .take(TAR_BLOCK_SIZE as u64)
        .read_to_end(&mut head)?;
    file.seek(SeekFrom::Start(0))?;
    Ok(is_ustar_header(&head))
}

#[cfg(test)]
fn extract_gz_cancellable(
    file: std::fs::File,
    pin: &std::fs::File,
    dest_parent: &Path,
    dest_leaf: &OsStr,
    limits: ArchiveLimits,
    cancellation: &CancellationToken,
) -> Result<(), Error> {
    let staging = create_test_archive_staging(pin, dest_parent, ".tar")?;
    let source = prepare_gz_cancellable(file, dest_parent, staging, limits, cancellation)?;
    install_extracted_tree(source, pin, dest_parent, dest_leaf, cancellation)
}

fn prepare_gz_cancellable(
    mut file: std::fs::File,
    dest_parent: &Path,
    staging: crate::infra::fs::OwnedStagingDir,
    limits: ArchiveLimits,
    cancellation: &CancellationToken,
) -> Result<crate::infra::fs::OwnedStagingDir, Error> {
    if !gzip_is_tar(&mut file)? {
        return Err(archive_payload_required());
    }
    use std::io::{Seek, SeekFrom};
    let compressed = file.metadata()?.len();
    let ratio_limit = compressed.saturating_mul(limits.ratio);
    let stream_limit = limits.expanded.min(ratio_limit);
    // Bound the entire decompressed stream (headers and padding included) before tar
    // publication. The tar extractor still enforces entry count and per-entry limits.
    #[cfg(test)]
    run_path_hook(&ARCHIVE_GZIP_SCRATCH_HOOKS, dest_parent);
    #[cfg(not(test))]
    let _ = dest_parent;
    let mut tar_file = tempfile::tempfile()?;
    let mut decoder = flate2::read::GzDecoder::new(file);
    let mut total = 0;
    bounded_copy(
        &mut decoder,
        &mut tar_file,
        u64::MAX,
        &mut total,
        stream_limit,
        cancellation,
    )
    .map_err(|error| match error {
        Error::ResourceLimit(_) if ratio_limit < limits.expanded => {
            Error::ResourceLimit("High tar-in-gzip compression ratio detected".into())
        }
        Error::ResourceLimit(_) => {
            Error::ResourceLimit("Tar-in-gzip expansion limit exceeded".into())
        }
        other => other,
    })?;
    tar_file.seek(SeekFrom::Start(0))?;
    prepare_tar_cancellable(tar_file, staging, limits, cancellation)
}

fn bounded_copy(
    input: &mut impl Read,
    output: &mut impl Write,
    per_entry_limit: u64,
    total_expanded: &mut u64,
    total_limit: u64,
    cancellation: &CancellationToken,
) -> Result<u64, Error> {
    let mut buffer = [0u8; 64 * 1024];
    let mut written = 0u64;
    loop {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let read = input.read(&mut buffer)?;
        if read == 0 {
            return Ok(written);
        }
        written = written
            .checked_add(read as u64)
            .ok_or_else(|| Error::ResourceLimit("Archive entry size overflow".into()))?;
        *total_expanded = total_expanded
            .checked_add(read as u64)
            .ok_or_else(|| Error::ResourceLimit("Archive expanded size overflow".into()))?;
        if written > per_entry_limit || *total_expanded > total_limit {
            return Err(Error::ResourceLimit(
                "Archive expansion limit exceeded".into(),
            ));
        }
        output.write_all(&buffer[..read])?;
    }
}

fn copy_cancellable(
    input: &mut impl Read,
    output: &mut impl Write,
    cancellation: &CancellationToken,
) -> Result<u64, Error> {
    let mut buffer = [0_u8; 64 * 1024];
    let mut copied = 0_u64;
    loop {
        if cancellation.is_cancelled() {
            return Err(Error::Cancellation);
        }
        let read = input.read(&mut buffer)?;
        if read == 0 {
            return Ok(copied);
        }
        output.write_all(&buffer[..read])?;
        copied = copied.checked_add(read as u64).ok_or_else(|| {
            Error::ResourceLimit("download payload exceeds supported size".into())
        })?;
    }
}

#[cfg(test)]
type ArchiveExtractor = fn(
    std::fs::File,
    &std::fs::File,
    &Path,
    &OsStr,
    ArchiveLimits,
    &CancellationToken,
) -> Result<(), Error>;

#[cfg(test)]
fn extract_archive_for_test(
    file: std::fs::File,
    target_path: &Path,
    limits: ArchiveLimits,
    extractor: ArchiveExtractor,
) -> Result<(), Error> {
    let (Some(dest_parent), Some(dest_leaf)) = (target_path.parent(), target_path.file_name())
    else {
        return Err(Error::InvalidInput(
            "archive target needs a parent and a leaf".into(),
        ));
    };
    let pin = crate::infra::fs::open_parent_no_follow(target_path)?;
    extractor(
        file,
        &pin,
        dest_parent,
        dest_leaf,
        limits,
        &CancellationToken::new(),
    )
}

#[cfg(test)]
fn extract_zip(
    file: std::fs::File,
    target_path: &Path,
    limits: ArchiveLimits,
) -> Result<(), Error> {
    extract_archive_for_test(file, target_path, limits, extract_zip_cancellable)
}

#[cfg(test)]
fn extract_tar(
    file: std::fs::File,
    target_path: &Path,
    limits: ArchiveLimits,
) -> Result<(), Error> {
    extract_archive_for_test(file, target_path, limits, extract_tar_cancellable)
}

#[cfg(test)]
fn extract_gz(file: std::fs::File, target_path: &Path, limits: ArchiveLimits) -> Result<(), Error> {
    extract_archive_for_test(file, target_path, limits, extract_gz_cancellable)
}

#[tauri::command]
#[specta::specta]
pub async fn file_exists(
    file: crate::infra::path_authority::PathRef,
    state: tauri::State<'_, AppState>,
) -> Result<bool, Error> {
    let authority = state.pgn_path_authority.clone();
    crate::infra::operations::run_accepted_blocking(&state.operations, "file_exists", move || {
        file_exists_blocking(&authority, file)
    })
    .await
}

fn file_exists_blocking(
    authority: &crate::infra::path_authority::SharedPathAuthority,
    file: crate::infra::path_authority::PathRef,
) -> Result<bool, Error> {
    authority.with_mut(|authority| file_exists_with_authority(authority, &file))?
}

fn resolve_engine_binary_for_inspection(
    authority: &mut crate::infra::path_authority::PathAuthority,
    file: &crate::infra::path_authority::PathRef,
) -> Result<Option<crate::infra::path_authority::ResolvedPath>, Error> {
    match authority.resolve(
        file,
        crate::infra::path_authority::PathOperation::EngineBinaryInspect,
        &[],
    ) {
        Ok(resolved) => Ok(Some(resolved)),
        Err(error) if error.is_missing_entry() => Ok(None),
        Err(Error::InvalidInput(_)) => Err(Error::InvalidInput(
            "engine binary inspection could not be authorized".into(),
        )),
        Err(error) => {
            log::warn!("engine binary inspection failed: {}", error.diagnostic());
            Err(Error::Conflict(
                "engine binary inspection could not be completed".into(),
            ))
        }
    }
}

fn file_exists_with_authority(
    authority: &mut crate::infra::path_authority::PathAuthority,
    file: &crate::infra::path_authority::PathRef,
) -> Result<bool, Error> {
    Ok(resolve_engine_binary_for_inspection(authority, file)?.is_some())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn catalog_install_publication_confirmation_deadline_drops_admission_before_join() {
        let cancellation = CancellationToken::new();
        let (permit_tx, permit_rx) = tokio::sync::oneshot::channel::<()>();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let finished_worker = finished.clone();
        let mut worker = tokio::task::spawn_blocking(move || {
            let _ = started_tx.send(());
            let _ = permit_rx.blocking_recv();
            finished_worker.store(true, Ordering::SeqCst);
            Ok(())
        });
        started_rx.await.unwrap();
        let producer = async { (&mut worker).await.unwrap() };
        let admission = async move {
            std::future::pending::<()>().await;
            drop(permit_tx);
        };
        let outcome = tokio::time::timeout(
            Duration::from_millis(300),
            await_staging_deadline_with_admission(
                Duration::from_millis(5),
                &cancellation,
                "preparation expired",
                producer,
                admission,
            ),
        )
        .await;
        if outcome.is_err() {
            // The bounded guard has dropped the helper and its sender. Reap the actual
            // worker before propagating the deliberately reversed-source assertion.
            worker.await.unwrap().unwrap();
        }
        assert!(
            finished.load(Ordering::SeqCst),
            "physical producer must finish before assertion"
        );
        assert!(matches!(outcome, Ok(Err(Error::EngineTimeout(_)))),
            "ADMISSION_DROP_BEFORE_JOIN: the helper must close the permit before awaiting its producer: {outcome:?}");
    }

    #[tokio::test]
    async fn catalog_install_publication_confirmation_admitted_tail_keeps_actual_result() {
        for uncertain in [false, true] {
            let cancellation = CancellationToken::new();
            let (prepared_tx, prepared_rx) = tokio::sync::oneshot::channel();
            let (permit_tx, permit_rx) = tokio::sync::oneshot::channel::<()>();
            let finished = Arc::new(AtomicBool::new(false));
            let finished_worker = finished.clone();
            let mut worker = tokio::task::spawn_blocking(move || {
                let _ = prepared_tx.send(());
                if permit_rx.blocking_recv().is_err() {
                    return Err(Error::Cancellation);
                }
                std::thread::sleep(Duration::from_millis(40));
                finished_worker.store(true, Ordering::SeqCst);
                if uncertain {
                    Err(Error::CommittedDurabilityUncertain(
                        crate::error::DurabilityStage::DirectoryInstall,
                    ))
                } else {
                    Ok(())
                }
            });
            let producer = async { (&mut worker).await.unwrap() };
            let admission = async move {
                prepared_rx.await.unwrap();
                let _ = permit_tx.send(());
            };
            let outcome = tokio::time::timeout(
                Duration::from_secs(2),
                await_staging_deadline_with_admission(
                    Duration::from_millis(5),
                    &cancellation,
                    "preparation expired",
                    producer,
                    admission,
                ),
            )
            .await;
            if outcome.is_err() {
                let _ = worker.await.unwrap();
            }
            assert!(
                finished.load(Ordering::SeqCst),
                "physical publication tail must finish before assertion"
            );
            let actual = if uncertain {
                matches!(
                    outcome,
                    Ok(Err(Error::CommittedDurabilityUncertain(
                        crate::error::DurabilityStage::DirectoryInstall
                    )))
                )
            } else {
                matches!(outcome, Ok(Ok(())))
            };
            assert!(actual, "ADMITTED_TAIL_ACTUAL_RESULT: preparation deadline must not replace publication outcome: {outcome:?}");
        }
    }

    use super::*;
    use crate::infra::blocking::source_scan::body_at_indent;
    use std::{
        future::Future,
        io::Write,
        pin::Pin,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        task::{Context, Poll},
    };
    use tempfile::tempdir;

    #[test]
    fn payload_download_staging_has_no_pathname() {
        let source = include_str!("fs.rs");
        let body = body_at_indent(source, "async fn download_to_destination_inner<");
        assert!(body.contains("tempfile::tempfile()"), "{body}");
        assert!(
            body.contains("atomic_replace_download_cancellable_with_commit_gate("),
            "{body}"
        );
        for forbidden in [
            "tempdir(",
            ".join(",
            "File::open",
            "create_dir_all",
            "atomic_replace(",
        ] {
            assert!(!body.contains(forbidden), "{forbidden}: {body}");
        }
        let installer = body_at_indent(source, "pub(crate) async fn install_staged_pgn_artifact(");
        assert!(installer.contains("into_file()"), "{installer}");
        assert!(!installer.contains(".path()"), "{installer}");
    }

    #[test]
    fn plain_download_acceptance_refuses_every_archive_kind() {
        let mut tar = Vec::new();
        flate2::read::GzDecoder::new(gzip_tar_payload(b"engine").as_slice())
            .read_to_end(&mut tar)
            .unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(b"plain gzip contents").unwrap();
        for bytes in [zip_payload(), tar, gzip.finish().unwrap()] {
            let mut file = tempfile::tempfile().unwrap();
            file.write_all(&bytes).unwrap();
            assert_eq!(
                accept_plain_download_payload(&mut file)
                    .unwrap_err()
                    .to_string(),
                "Invalid input: Archive payload is not allowed for this operation"
            );
        }
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"plain contents").unwrap();
        accept_plain_download_payload(&mut file).unwrap();
    }

    #[test]
    fn archive_copy_core_cancels_between_real_chunks_before_publication() {
        struct HeldReader {
            entered: Option<std::sync::mpsc::SyncSender<()>>,
            release: std::sync::mpsc::Receiver<()>,
            finished: bool,
        }
        impl Read for HeldReader {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                if self.finished {
                    return Ok(0);
                }
                self.finished = true;
                if let Some(entered) = self.entered.take() {
                    let _ = entered.send(());
                }
                let _ = self.release.recv_timeout(Duration::from_secs(5));
                buffer[..64].fill(3);
                Ok(64)
            }
        }

        let cancellation = CancellationToken::new();
        let worker_cancellation = cancellation.clone();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::spawn(move || {
            let mut output = Vec::new();
            let mut total = 0;
            bounded_copy(
                &mut HeldReader {
                    entered: Some(entered_tx),
                    release: release_rx,
                    finished: false,
                },
                &mut output,
                1024,
                &mut total,
                1024,
                &worker_cancellation,
            )
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        cancellation.cancel();
        release_tx.send(()).unwrap();
        assert!(matches!(worker.join().unwrap(), Err(Error::Cancellation)));
    }

    fn test_path_authority(dir: &tempfile::TempDir) -> crate::infra::path_authority::PathAuthority {
        crate::infra::path_authority::PathAuthority::open(
            dir.path().join("path-authority.json"),
            vec![],
        )
        .unwrap()
    }

    fn database_destination(
        dir: &tempfile::TempDir,
    ) -> (
        crate::infra::path_authority::PathAuthority,
        crate::infra::path_authority::PathRef,
    ) {
        let database_root = dir.path().join("databases");
        std::fs::create_dir(&database_root).unwrap();
        let mut authority = test_path_authority(dir);
        let root = authority
            .get_or_create_database_root(&database_root, "Databases", None)
            .unwrap();
        (authority, root.id)
    }

    fn engine_destination(
        dir: &tempfile::TempDir,
    ) -> (
        crate::infra::path_authority::PathAuthority,
        crate::infra::path_authority::PathRef,
        PathBuf,
        crate::infra::path_authority::EngineRootHandle,
    ) {
        let engine_root = engine_directory(dir);
        engine_destination_with_authority(engine_root, test_path_authority(dir))
    }

    fn engine_directory(dir: &tempfile::TempDir) -> PathBuf {
        let engine_root = dir.path().join("engines");
        std::fs::create_dir(&engine_root).unwrap();
        engine_root
    }

    fn engine_destination_with_authority(
        engine_root: PathBuf,
        mut authority: crate::infra::path_authority::PathAuthority,
    ) -> (
        crate::infra::path_authority::PathAuthority,
        crate::infra::path_authority::PathRef,
        PathBuf,
        crate::infra::path_authority::EngineRootHandle,
    ) {
        let root = authority
            .get_or_create_engine_root(&engine_root, "Engines", None)
            .unwrap();
        let engine_root = authority.engine_root_path(&root).unwrap();
        let destination = authority.engine_archive_destination(&root).unwrap();
        (authority, destination, engine_root, root)
    }

    fn unsigned_test_integrity(payload: &[u8]) -> ArtifactIntegrity {
        ArtifactIntegrity {
            sha256: format!("{:x}", Sha256::digest(payload)),
            signature: String::new(),
        }
    }

    fn accept_any_integrity(_: OpClass, _: &str, _: &ArtifactIntegrity) -> Result<(), Error> {
        Ok(())
    }

    fn test_download_lease(state: &AppState) -> (String, crate::infra::operations::OperationLease) {
        let ticket = state.operations.prepare_download("test").unwrap();
        let lease = state
            .operations
            .claim_download(
                &ticket,
                "test",
                "test download",
                &ticket,
                &ticket,
                false,
                MAX_ACTIVE_DOWNLOADS,
            )
            .unwrap();
        (ticket, lease)
    }

    #[cfg(feature = "catalog-network-tests")]
    mod catalog_network {
        use super::*;
        use futures_util::FutureExt;
        use serde::Deserialize;

        const FAILURE_CHARACTER_LIMIT: usize = 2048;
        const UCI_IDENTITY_CHARACTER_LIMIT: usize = 256;

        #[derive(Clone, Debug, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct CatalogEntry {
            name: String,
            version: String,
            os: String,
            bmi2: bool,
            download_link: String,
            sha256: String,
            signature: String,
            path: String,
        }

        impl CatalogEntry {
            fn label(&self, index: usize) -> String {
                format!(
                    "entry[{index}] {} {} os={} bmi2={} digest={} path={}",
                    self.name, self.version, self.os, self.bmi2, self.sha256, self.path
                )
            }

            fn same_executable(&self, other: &Self) -> bool {
                self.download_link == other.download_link
                    && self.sha256 == other.sha256
                    && self.signature == other.signature
                    && self.path == other.path
            }
        }

        fn failure(stage: &str, error: impl std::fmt::Display) -> String {
            // Native errors can contain untrusted engine or upstream text.
            format!(
                "{stage}: {}",
                error
                    .to_string()
                    .chars()
                    .take(FAILURE_CHARACTER_LIMIT)
                    .collect::<String>()
            )
        }

        fn retain_failed_cleanup(
            state: AppState,
            scratch: tempfile::TempDir,
            stage: &str,
            error: Error,
            outcome: &Result<(), String>,
        ) -> String {
            let retained = scratch.keep();
            // A completed failed termination attempt leaves ChildOwner and executable leases
            // in the supervisor. Keep their actual owner, plus operation and authority owners,
            // until process exit. At most one state is retained per selected unique executable.
            // Remove this retention if an existing guaranteed terminal owner replaces it.
            std::mem::forget(state);
            println!(
                "RETAINED {} reason={stage} owners=process-lifetime",
                retained.display()
            );
            failure(
                stage,
                format!(
                    "{} retained={} owners=process-lifetime case={outcome:?}",
                    error.diagnostic(),
                    retained.display()
                ),
            )
        }

        async fn verify_case(entry: &CatalogEntry) -> Result<(), String> {
            // macOS /var is an alias. Authority roots and all descendants must use /private/var.
            let temporary_root = std::env::temp_dir()
                .canonicalize()
                .map_err(|error| failure("scratch-root", error))?;
            let scratch = tempfile::Builder::new()
                .prefix("chessfable-catalog-")
                .tempdir_in(temporary_root)
                .map_err(|error| failure("scratch-create", error))?;
            let state = AppState::default(); // Unbound credentials and production HTTP transport.
            println!("SCRATCH {}", scratch.path().display());
            let outcome = std::panic::AssertUnwindSafe(async {
                let engine_root = engine_directory(&scratch);
                let authority = crate::infra::path_authority::PathAuthority::open_for_engine_test(
                    scratch.path(),
                )
                .map_err(|error| failure("authority", error.diagnostic()))?;
                let (authority, destination, engine_root, root) =
                    engine_destination_with_authority(engine_root, authority);
                state
                    .pgn_path_authority
                    .install(authority)
                    .map_err(|error| failure("authority", Error::from(error).diagnostic()))?;
                let archive_name = entry.download_link.rsplit('/').next().unwrap_or_default();
                if archive_name.is_empty() {
                    return Err(failure("directory-contract", "missing archive filename"));
                }
                let directory = format!("{archive_name}-{}", entry.sha256.to_lowercase());
                if engine_root
                    .join(&directory)
                    .try_exists()
                    .map_err(|error| failure("fresh-destination", error))?
                {
                    return Err(failure("fresh-destination", "artifact already exists"));
                }
                let app = test_progress_app();
                let (job, lease) = test_download_lease(&state);
                let cancellation = lease.token();
                let commit_gate = lease.commit_gate();
                crate::infra::operations::run_native_operation(
                    lease,
                    "real catalog verification",
                    download_engine_archive_core(
                        begin_progress(&state.progress_state, &app.handle().clone(), job.clone())
                            .unwrap(),
                        entry.download_link.clone(),
                        destination,
                        directory.clone(),
                        job,
                        ArtifactIntegrity {
                            sha256: entry.sha256.clone(),
                            signature: entry.signature.clone(),
                        },
                        app.handle().clone(),
                        state.clone(),
                        cancellation,
                        commit_gate,
                        Box::new(|op, url, integrity| {
                            validate_artifact_integrity(op, url, Some(integrity))
                        }),
                    ),
                )
                .await
                .map_err(|error| failure("install", error.diagnostic()))?;
                let authority = state.pgn_path_authority.clone();
                let relative_path = format!("{directory}/{}", entry.path);
                let handle = crate::infra::operations::run_accepted_blocking(
                    &state.operations,
                    "real catalog registration",
                    move || {
                        authority.with_mut(|authority| {
                            authority.register_installed_engine_for_test(&root, &relative_path)
                        })?
                    },
                )
                .await
                .map_err(|error| failure("registration", error.diagnostic()))?;
                println!("REGISTERED handle={handle:?}");
                let config = crate::chess::get_engine_config_core(handle, &state)
                    .await
                    .map_err(|error| failure("uci", error.diagnostic()))?;
                if config.name.trim().is_empty() {
                    return Err(failure("uci-identity", "empty engine name after uciok"));
                }
                println!(
                    "UCI_OK name={:?} options={}",
                    config
                        .name
                        .chars()
                        .take(UCI_IDENTITY_CHARACTER_LIMIT)
                        .collect::<String>(),
                    config.options.len()
                );
                Ok(())
            })
            .catch_unwind()
            .await;
            let outcome = match outcome {
                Ok(result) => result,
                Err(payload) => Err(failure(
                    "case-panic",
                    payload
                        .downcast_ref::<String>()
                        .map(String::as_str)
                        .or_else(|| payload.downcast_ref::<&str>().copied())
                        .unwrap_or("non-text panic payload"),
                )),
            };

            // Inspect physical reaping before any executable tree can be deleted, on every exit.
            if let Err(error) = state.engine_supervisor.terminate_all().await {
                return Err(retain_failed_cleanup(
                    state,
                    scratch,
                    "supervisor-cleanup",
                    error,
                    &outcome,
                ));
            }
            let operations = state.operations.clone();
            let drained = crate::infra::blocking::BLOCKING_GATEWAY
                .spawn(move || {
                    operations.seal_and_request_cancellation()?;
                    if !operations.wait_for_drain(Duration::ZERO)? {
                        return Err(Error::Conflict(format!(
                            "remaining operations: {:?}",
                            operations.outstanding_labels()?
                        )));
                    }
                    Ok(())
                })
                .await;
            if let Err(error) = drained {
                return Err(retain_failed_cleanup(
                    state,
                    scratch,
                    "operation-cleanup",
                    error,
                    &outcome,
                ));
            }
            let authority = state.pgn_path_authority.clone();
            let authority_cleanup = async {
                let catalog_authority = authority.clone();
                let initialized = crate::infra::blocking::BLOCKING_GATEWAY
                    .spawn(move || {
                        match catalog_authority
                            .with_mut(|authority| authority.clear_catalog_session_use())
                        {
                            Ok(result) => result.map(|()| true),
                            Err(
                                crate::infra::path_authority::AuthorityUnavailable::Uninitialized,
                            ) => Ok(false),
                            Err(error) => Err(error.into()),
                        }
                    })
                    .await?;
                if initialized {
                    crate::shutdown_engine_launch_root(authority).await?;
                }
                Ok::<_, Error>(initialized)
            }
            .await;
            let initialized = match authority_cleanup {
                Ok(initialized) => initialized,
                Err(error) => {
                    return Err(retain_failed_cleanup(
                        state,
                        scratch,
                        "authority-cleanup",
                        error,
                        &outcome,
                    ));
                }
            };
            let scratch_path = scratch.path().to_path_buf();
            scratch.close().map_err(|error| {
                failure(
                    "scratch-cleanup",
                    format!("{error} path={} case={outcome:?}", scratch_path.display()),
                )
            })?;
            println!("{}", cleanup_summary(initialized));
            outcome
        }

        fn cleanup_summary(initialized: bool) -> String {
            let session = if initialized {
                "cleared"
            } else {
                "skipped-uninitialized"
            };
            let launch_root = if cfg!(target_os = "macos") {
                if initialized {
                    "reclaimed"
                } else {
                    "skipped-uninitialized"
                }
            } else {
                "not-applicable"
            };
            format!("CLEANUP_OK supervisor=reaped operations=drained catalog-session={session} launch-root={launch_root} scratch=removed")
        }

        #[test]
        fn cleanup_summary_reports_authority_and_native_platform_status() {
            #[cfg(target_os = "macos")]
            let expected = [
                "CLEANUP_OK supervisor=reaped operations=drained catalog-session=cleared launch-root=reclaimed scratch=removed",
                "CLEANUP_OK supervisor=reaped operations=drained catalog-session=skipped-uninitialized launch-root=skipped-uninitialized scratch=removed",
            ];
            #[cfg(not(target_os = "macos"))]
            let expected = [
                "CLEANUP_OK supervisor=reaped operations=drained catalog-session=cleared launch-root=not-applicable scratch=removed",
                "CLEANUP_OK supervisor=reaped operations=drained catalog-session=skipped-uninitialized launch-root=not-applicable scratch=removed",
            ];
            assert_eq!(cleanup_summary(true), expected[0]);
            assert_eq!(cleanup_summary(false), expected[1]);
        }

        #[tokio::test]
        async fn cleanup_failure_retains_case_owners_until_process_exit() {
            use crate::engine::{EngineActor, EngineKey};

            for stage in [
                "supervisor-cleanup",
                "operation-cleanup",
                "authority-cleanup",
            ] {
                let state = AppState::default();
                let supervisor = Arc::downgrade(&state.engine_supervisor);
                let scratch = tempfile::tempdir().unwrap();
                let path = scratch.path().to_path_buf();
                let key = EngineKey::new("catalog-retention".into(), stage.into()).unwrap();
                state
                    .engine_supervisor
                    .replace_handle(
                        key,
                        EngineActor::failing_terminate_test_actor("catalog cleanup regression"),
                        stage.into(),
                        crate::infra::path_authority::PathRef {
                            id: "catalog-retention".into(),
                        },
                    )
                    .await
                    .unwrap();
                let error = state.engine_supervisor.terminate_all().await.unwrap_err();
                let outcome = Err("original case failure".into());
                let diagnostic = retain_failed_cleanup(state, scratch, stage, error, &outcome);
                assert!(
                    supervisor.upgrade().is_some(),
                    "CASE_OWNER_DROPPED stage={stage}"
                );
                assert!(path.is_dir(), "scratch must survive failed cleanup");
                assert!(diagnostic.starts_with(&format!("{stage}:")));
                assert!(diagnostic.contains(&format!("retained={}", path.display())));
                assert!(diagnostic.contains("owners=process-lifetime"));
                assert!(diagnostic.contains("original case failure"));
                // This fixture owns no native child or executable. Remove only its empty tree.
                std::fs::remove_dir(path).unwrap();
            }

            let state = AppState::default();
            let supervisor = Arc::downgrade(&state.engine_supervisor);
            let scratch = tempfile::tempdir().unwrap();
            let path = scratch.path().to_path_buf();
            state.engine_supervisor.terminate_all().await.unwrap();
            scratch.close().unwrap();
            drop(state);
            assert!(supervisor.upgrade().is_none());
            assert!(!path.exists());
        }

        #[tokio::test]
        async fn real_signed_catalog_engines_install_register_and_configure() -> Result<(), String>
        {
            let document = include_str!("../../src/catalogs/engines.json");
            let signature = include_str!("../../src/catalogs/engines.json.minisig");
            verify_signed_bytes(document.into(), signature.into())
                .await
                .map_err(|error| failure("catalog-signature", error.diagnostic()))?;
            let entries: Vec<CatalogEntry> =
                serde_json::from_str(document).map_err(|error| failure("catalog-parse", error))?;
            let os = std::env::consts::OS;
            let arch = std::env::consts::ARCH;
            if !matches!(
                (os, arch),
                ("linux" | "windows", "x86_64") | ("macos", "x86_64" | "aarch64")
            ) {
                return Err(failure(
                    "native-platform",
                    format!("unsupported native environment {os}/{arch}"),
                ));
            }
            let selected: Vec<_> = entries
                .iter()
                .enumerate()
                .filter(|(_, entry)| entry.os == os)
                .collect();
            if selected.is_empty() {
                return Err(failure(
                    "native-selection",
                    format!("zero catalog entries for {os}/{arch}"),
                ));
            }
            println!("CATALOG native={os}/{arch} selected={}", selected.len());
            let mut completed: Vec<(&CatalogEntry, Result<(), String>)> = Vec::new();
            let mut failures = Vec::new();
            for (index, entry) in selected {
                let label = entry.label(index);
                println!("VERIFY {label}");
                let result = if let Some((_, result)) = completed
                    .iter()
                    .find(|(prior, _)| entry.same_executable(prior))
                {
                    println!("ALIAS {label} shares exact signed executable result");
                    result.clone()
                } else {
                    let result = verify_case(entry).await;
                    completed.push((entry, result.clone()));
                    result
                };
                match result {
                    Ok(()) => println!("PASS {label}"),
                    Err(error) => {
                        println!("FAIL {label}: {error}");
                        failures.push(format!("{label}: {error}"));
                    }
                }
            }
            if failures.is_empty() {
                Ok(())
            } else {
                Err(failures.join("\n"))
            }
        }
    }

    #[test]
    fn from_operations_derives_exclusive_download_classes() {
        use crate::infra::path_authority::PathOperation::*;

        assert_eq!(
            OpClass::from_operations(&[DownloadFile]).unwrap(),
            OpClass::Lichess
        );
        assert_eq!(
            OpClass::from_operations(&[DownloadArchive, EngineInstall]).unwrap(),
            OpClass::Engine
        );
        assert_eq!(
            OpClass::from_operations(&[
                DatabaseRead,
                DatabaseMutate,
                DatabaseCreate,
                DatabaseExport,
                DownloadFile,
            ])
            .unwrap(),
            OpClass::Db
        );
        assert_eq!(
            OpClass::from_operations(&[PuzzleRead, PuzzleDelete, DownloadFile]).unwrap(),
            OpClass::PuzzleDb
        );
        assert_eq!(
            OpClass::from_operations(&[DownloadFile, EngineExecute]).unwrap(),
            OpClass::Engine
        );
        for operations in [
            vec![DatabaseRead, PuzzleRead],
            vec![EngineInstall, DatabaseRead],
            vec![EngineConfigure, PuzzleDelete],
            vec![],
            vec![ReadPgn],
        ] {
            assert!(matches!(
                OpClass::from_operations(&operations),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[tokio::test]
    async fn lichess_prefixed_id_cannot_skip_signature() {
        let dir = tempdir().unwrap();
        let (authority, destination) = database_destination(&dir);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = tauri::test::mock_app();

        let (job_id, lease) = test_download_lease(&state);
        let error = download_to_destination(
            "lichess_spoof",
            "https://www.encroissant.org/database.db3",
            destination,
            "database.db3".into(),
            app.handle(),
            &state,
            None,
            None,
            job_id,
            lease,
            false,
            None,
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "Invalid input: signed artifact integrity metadata required"
        );
    }

    #[tokio::test]
    async fn lichess_games_reject_database_destination() {
        let dir = tempdir().unwrap();
        let (authority, destination) = database_destination(&dir);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = tauri::test::mock_app();

        let job_id = state.operations.prepare_download("test").unwrap();
        let error = download_lichess_games_runtime(
            crate::credentials::LichessAccountHandle::new(),
            destination,
            "games.pgn".into(),
            "player".into(),
            None,
            job_id,
            "test",
            app.handle(),
            &state,
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::InvalidInput(_)));
    }

    #[test]
    fn download_engine_archive_rejects_database_destination() {
        let dir = tempdir().unwrap();
        let (authority, destination) = database_destination(&dir);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();

        let error = match resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("engine_1"),
        ) {
            Ok(_) => panic!("database destination must not resolve for an engine archive"),
            Err(error) => error,
        };
        assert!(matches!(error, Error::InvalidInput(_)));
    }

    #[test]
    fn download_file_command_publishes_on_windows() {
        let source = include_str!("fs.rs");
        let body = body_at_indent(source, "pub async fn download_file(");
        assert!(!body.contains("off_unix_refusal("), "{body}");
        assert_eq!(body.matches("download_file_runtime(").count(), 1, "{body}");
        let body = body_at_indent(source, "async fn download_file_runtime<");
        assert!(!body.contains("off_unix_refusal("), "{body}");
        assert_eq!(
            body.matches("download_to_destination_with_failure(")
                .count(),
            1,
            "{body}"
        );
    }

    #[test]
    fn download_lichess_games_runtime_publishes_on_windows() {
        let source = include_str!("fs.rs");
        let body = body_at_indent(source, "async fn download_lichess_games_runtime<");
        assert!(!body.contains("off_unix_refusal("), "{body}");
        assert_eq!(
            body.matches("download_to_destination(").count(),
            1,
            "{body}"
        );
    }

    #[test]
    fn download_engine_archive_stages_with_private_tempdir_in() {
        let source = include_str!("fs.rs");
        let body = body_at_indent(source, "async fn download_engine_archive_core<");
        assert!(!body.contains("off_unix_refusal("), "{body}");
        assert!(
            !body.contains("private_tempdir_in("),
            "catalog must keep the extractor owner without an outer pathname cleanup: {body}"
        );
        assert!(
            !body.contains("private_tempdir()"),
            "production staging must be a sibling of the destination: {body}"
        );
        assert!(
            body.contains("let archive_target = resolved") && body.contains("prepare_archive_download("),
            "shared preparation must derive its sibling parent from the resolved destination: {body}"
        );
        // The tree is only published after the cancellation check, so a cancelled job can never
        // leave a partially staged archive installed.
        let cancel = body
            .find("if cancellation.is_cancelled()")
            .expect("download must observe cancellation");
        let publish = body
            .find("publish_engine_archive_tree(")
            .expect("download must publish through the shared helper");
        assert!(
            cancel < publish,
            "cancellation must precede publication: {body}"
        );
    }

    #[test]
    fn install_dir_driver_refuses_parent_mismatch() {
        let root = tempfile::tempdir().expect("tempdir");
        let first = root.path().join("first");
        let second = root.path().join("second");
        std::fs::create_dir(&first).expect("first");
        std::fs::create_dir(&second).expect("second");
        let source = first.join("staging");
        std::fs::create_dir(&source).expect("staging");
        std::fs::write(source.join("engine"), b"new").expect("staged file");
        let target = second.join("installed");

        let error = crate::infra::fs::atomic_install_dir(&source, &target)
            .expect_err("a staging directory outside the target parent must be refused");

        assert!(matches!(error, Error::InvalidInput(_)), "{error:?}");
        assert!(!target.exists(), "the refusal installs nothing");
    }

    fn root_failure_engine_fixture() -> (
        tempfile::TempDir,
        AppState,
        crate::infra::path_authority::PathRef,
        PathBuf,
        crate::infra::path_authority::EngineRootHandle,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let (authority, destination, path, root) = engine_destination(&directory);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        crate::engine_archive_destination_blocking(&state.pgn_path_authority, root.clone())
            .unwrap();
        (directory, state, destination, path, root)
    }

    fn root_failure_assert_permission(error: &Error) {
        assert_eq!(
            error.root_failure(),
            Some(crate::error::RootFailure::Permission),
            "{error:?}"
        );
        assert_eq!(
            serde_json::to_value(error).unwrap()["rootFailure"],
            "permission"
        );
        assert_eq!(error.to_string(), error.unlabelled().to_string());
        assert_eq!(error.diagnostic(), error.unlabelled().diagnostic());
    }

    fn root_failure_engine_error_preserves_original<T>(
        destination: &crate::infra::path_authority::PathRef,
        action: impl FnOnce() -> Result<T, Error>,
    ) -> Error {
        use crate::infra::path_authority::{
            ListingRootFailureHookGuard, LISTING_ROOT_FAILURE_HOOKS,
        };
        let observed = std::sync::Arc::new(std::sync::Mutex::new(None));
        let hook_observed = observed.clone();
        let _hook = ListingRootFailureHookGuard(destination.id.clone());
        LISTING_ROOT_FAILURE_HOOKS.arm(
            destination.id.clone(),
            Box::new(move |error| {
                *hook_observed.lock().unwrap() =
                    Some((error.category(), error.to_string(), error.diagnostic()));
            }),
        );
        let error = action().err().expect("filesystem use must fail");
        let original = observed
            .lock()
            .unwrap()
            .take()
            .expect("filesystem failure must reach root probe");
        assert_eq!(
            (error.category(), error.to_string(), error.diagnostic()),
            original
        );
        error
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_engine_read_loss_at_destination_and_later_resolution() {
        use crate::infra::path_authority::TestRootPermissionGuard;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_directory, state, destination, path, root) = root_failure_engine_fixture();
        let permissions = TestRootPermissionGuard::restrict(&path, 0o300);
        let destination_error =
            crate::engine_archive_destination_blocking(&state.pgn_path_authority, root.clone())
                .unwrap_err();
        let resolution_error = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
        )
        .err()
        .unwrap();
        drop(permissions);
        for error in [destination_error, resolution_error] {
            root_failure_assert_permission(&error);
            assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
            assert_eq!(error.to_string(), "I/O failure");
            assert!(
                error.diagnostic().contains("Permission denied"),
                "{}",
                error.diagnostic()
            );
        }
        assert!(!path.join("installed").exists());
        crate::engine_archive_destination_blocking(&state.pgn_path_authority, root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_engine_retained_read_lost_search_at_resolution_and_staging() {
        use crate::infra::path_authority::TestRootPermissionGuard;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_directory, state, destination, path, _root) = root_failure_engine_fixture();
        let (_, resolved) = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
        )
        .unwrap();
        let permissions = TestRootPermissionGuard::restrict(&path, 0o400);
        assert!(
            std::fs::File::open(&path).is_ok(),
            "root read-open must still succeed"
        );
        let resolution_error = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
        )
        .err()
        .unwrap();
        let staging_error = create_engine_archive_staging(
            &state.pgn_path_authority,
            &destination,
            &resolved,
            &CancellationToken::new(),
        )
        .err()
        .unwrap();
        drop(permissions);
        for error in [resolution_error, staging_error] {
            root_failure_assert_permission(&error);
            assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
            assert_eq!(error.to_string(), "I/O failure");
        }
        assert_eq!(std::fs::read_dir(&path).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_engine_later_adoption_publication_and_registration() {
        use crate::infra::path_authority::{
            with_engine_root_probe, PathOperation, TestRootPermissionGuard,
        };
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        for mode in [0o300, 0o400] {
            let (_directory, state, destination, path, root) = root_failure_engine_fixture();
            std::fs::write(path.join("engine"), b"engine").unwrap();
            let (_, resolved) = resolve_engine_archive_destination(
                &state,
                &destination,
                std::ffi::OsStr::new("installed"),
            )
            .unwrap();
            let mut staging = resolved.create_archive_staging().unwrap();
            let permissions = TestRootPermissionGuard::restrict(&path, mode);
            let adoption_error = root_failure_engine_error_preserves_original(&destination, || {
                with_engine_root_probe(
                    &state.pgn_path_authority,
                    &destination,
                    PathOperation::DownloadArchive,
                    &CancellationToken::new(),
                    |authority, probe| {
                        authority.confirm_catalog_archive_adoption_with_probe(
                            &destination,
                            &resolved,
                            probe,
                        )
                    },
                )
            });
            let publication_error =
                root_failure_engine_error_preserves_original(&destination, || {
                    publish_engine_archive_tree(
                        &state.pgn_path_authority,
                        &destination,
                        &resolved,
                        &mut staging,
                    )
                });
            let registration_error =
                root_failure_engine_error_preserves_original(&destination, || {
                    crate::register_installed_engine_blocking(
                        &state.pgn_path_authority,
                        root,
                        "engine".into(),
                    )
                });
            drop(permissions);
            for error in [adoption_error, publication_error, registration_error] {
                root_failure_assert_permission(&error);
            }
            drop(staging);
            assert!(!path.join("installed").exists());
            assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
        }
    }

    #[test]
    fn root_failure_engine_healthy_root_child_and_authority_errors_are_unlabelled() {
        let (_directory, state, destination, path, root) = root_failure_engine_fixture();
        std::fs::write(path.join("engine"), b"engine").unwrap();
        let error = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("../invalid"),
        )
        .err()
        .unwrap();
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.category(), crate::error::ErrorCategory::InvalidInput);
        let error = root_failure_engine_error_preserves_original(&destination, || {
            crate::register_installed_engine_blocking(
                &state.pgn_path_authority,
                root.clone(),
                "missing".into(),
            )
        });
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.to_string(), "I/O failure");
        for poison in [false, true] {
            let authority = crate::infra::path_authority::SharedPathAuthority::uninitialized();
            if poison {
                authority.poison();
            }
            let error =
                crate::engine_archive_destination_blocking(&authority, root.clone()).unwrap_err();
            assert_eq!(error.root_failure(), None);
            assert_eq!(error.category(), crate::error::ErrorCategory::Conflict);
        }
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_engine_healthy_root_child_permission_denial_is_unlabelled() {
        use crate::infra::path_authority::TestRootPermissionGuard;
        use std::os::unix::fs::PermissionsExt;

        let uid = unsafe { libc::geteuid() };
        if uid == 0 {
            return;
        }
        let (_directory, state, destination, path, root) = root_failure_engine_fixture();
        let _root_permissions = TestRootPermissionGuard::restrict(&path, 0o700);
        let child = path.join("blocked-child");
        std::fs::create_dir(&child).unwrap();
        let engine = child.join("engine");
        std::fs::write(&engine, b"engine").unwrap();
        assert_eq!(
            std::fs::metadata(&engine).unwrap().permissions().mode() & 0o111,
            0
        );
        let child_permissions = TestRootPermissionGuard::restrict(&child, 0o000);
        crate::engine_archive_destination_blocking(&state.pgn_path_authority, root.clone())
            .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let error = root_failure_engine_error_preserves_original(&destination, || {
            crate::register_installed_engine_blocking(
                &state.pgn_path_authority,
                root,
                "blocked-child/engine".into(),
            )
        });
        drop(child_permissions);
        assert!(
            matches!(error.unlabelled(), Error::Io(cause)
            if cause.kind() == std::io::ErrorKind::PermissionDenied),
            "{error:?}"
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
        assert_eq!(error.to_string(), "I/O failure");
        assert_eq!(error.root_failure(), None);
        assert!(serde_json::to_value(&error)
            .unwrap()
            .get("rootFailure")
            .is_none());
        assert_eq!(std::fs::read(&engine).unwrap(), b"engine");
        assert_eq!(
            std::fs::metadata(&engine).unwrap().permissions().mode() & 0o111,
            0
        );
        eprintln!("ENGINE_CHILD_PERMISSION uid={uid} kind=PermissionDenied category=Permission message=I/O failure rootFailure=absent child_bytes=preserved");
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_engine_write_only_denial_stays_unlabelled_and_probe_cancels() {
        use crate::infra::path_authority::{
            ListingRootFailureHookGuard, TestRootPermissionGuard, LISTING_ROOT_FAILURE_HOOKS,
        };
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_directory, state, destination, path, _root) = root_failure_engine_fixture();
        let (_, resolved) = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
        )
        .unwrap();
        let permissions = TestRootPermissionGuard::restrict(&path, 0o500);
        let error = create_engine_archive_staging(
            &state.pgn_path_authority,
            &destination,
            &resolved,
            &CancellationToken::new(),
        )
        .err()
        .unwrap();
        drop(permissions);
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
        let cancellation = CancellationToken::new();
        let hook_cancellation = cancellation.clone();
        let _hook = ListingRootFailureHookGuard(destination.id.clone());
        LISTING_ROOT_FAILURE_HOOKS.arm(
            destination.id.clone(),
            Box::new(move |_| hook_cancellation.cancel()),
        );
        let permissions = TestRootPermissionGuard::restrict(&path, 0o400);
        let result = resolve_engine_archive_destination_cancellable(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
            &cancellation,
        );
        drop(permissions);
        let error = result.err().unwrap();
        assert!(matches!(error, Error::Cancellation));
        assert_eq!(error.root_failure(), None);
    }

    #[cfg(windows)]
    #[test]
    fn root_failure_engine_windows_read_denied_and_write_only_denied() {
        use windows_sys::Win32::{
            Foundation::GENERIC_READ,
            Storage::FileSystem::{
                FILE_ALL_ACCESS, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_READ_EA,
                READ_CONTROL, SYNCHRONIZE,
            },
        };
        for read_denied in [false, true] {
            let (_directory, state, destination, path, root) = root_failure_engine_fixture();
            let access = if read_denied {
                FILE_ALL_ACCESS & !(FILE_LIST_DIRECTORY | FILE_READ_EA | FILE_READ_ATTRIBUTES)
            } else {
                GENERIC_READ | READ_CONTROL | SYNCHRONIZE
            };
            let mut security =
                crate::infra::fs::TestTargetSecurityGuard::restrict(&path, access).unwrap();
            let result =
                crate::engine_archive_destination_blocking(&state.pgn_path_authority, root.clone());
            let resolution = resolve_engine_archive_destination(
                &state,
                &destination,
                std::ffi::OsStr::new("installed"),
            );
            security.restore().unwrap();
            for error in [result.unwrap_err(), resolution.err().unwrap()] {
                if read_denied {
                    root_failure_assert_permission(&error);
                }
                assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
                assert_eq!(
                    error.root_failure(),
                    read_denied.then_some(crate::error::RootFailure::Permission),
                    "{error:?}"
                );
                assert_eq!(error.to_string(), "I/O failure");
            }
            crate::engine_archive_destination_blocking(&state.pgn_path_authority, root).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_engine_listing_bound_is_inconclusive_without_install_limit() {
        use crate::infra::path_authority::TestRootPermissionGuard;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let (_directory, state, destination, path, _root) = root_failure_engine_fixture();
        for index in 0..=crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES {
            std::fs::write(path.join(format!("unrelated-{index}")), b"").unwrap();
        }
        let (_, resolved) = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
        )
        .unwrap();
        let mut staging = create_engine_archive_staging(
            &state.pgn_path_authority,
            &destination,
            &resolved,
            &CancellationToken::new(),
        )
        .unwrap();
        staging
            .create_relative_regular(Path::new("engine"))
            .unwrap()
            .write_all(b"engine")
            .unwrap();
        let permissions = TestRootPermissionGuard::restrict(&path, 0o500);
        let error = create_engine_archive_staging(
            &state.pgn_path_authority,
            &destination,
            &resolved,
            &CancellationToken::new(),
        )
        .err()
        .unwrap();
        drop(permissions);
        assert_eq!(
            error.root_failure(),
            None,
            "an enumeration bound is inconclusive for engine use"
        );
        assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
        publish_engine_archive_tree(
            &state.pgn_path_authority,
            &destination,
            &resolved,
            &mut staging,
        )
        .unwrap();
        assert_eq!(
            std::fs::read(path.join("installed/engine")).unwrap(),
            b"engine"
        );
    }

    #[test]
    fn publish_engine_archive_tree_installs_a_sibling_staging_dir() {
        let root = tempfile::tempdir().expect("tempdir");
        let (authority, destination, engine_root, _) = engine_destination(&root);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let staging = tempfile::tempdir_in(&engine_root).unwrap();
        let staging_path = staging.path().to_path_buf();
        std::fs::write(staging.path().join("engine"), b"staged").expect("staged file");
        let mut owner = crate::infra::fs::OwnedStagingDir::adopt(&staging).unwrap();
        let _ = staging.keep();
        let (_, resolved) = resolve_engine_archive_destination(
            &state,
            &destination,
            std::ffi::OsStr::new("installed"),
        )
        .unwrap();

        publish_engine_archive_tree(
            &state.pgn_path_authority,
            &destination,
            &resolved,
            &mut owner,
        )
        .expect("publish");

        assert!(
            !staging_path.exists(),
            "the staging name is consumed by the install"
        );
        assert_eq!(
            std::fs::read(engine_root.join("installed/engine")).expect("installed tree"),
            b"staged"
        );
    }

    /// `INSTALL_BACKUP_PREFIX` names a leftover after a failed rollback, so the installer must
    /// never sweep it (d-20260918-10). This pins the whole install path — the shared driver, both
    /// entry points, the Windows rollback, and the directory walk — as free of parent enumeration
    /// and name-prefix filtering, and pins the one creation site to the shared constant rather
    /// than a glob.
    #[test]
    fn install_dir_does_not_reap_install_backup_prefix() {
        let source = include_str!("infra/fs.rs");
        // The functions that choose a *name to delete* may neither match it by prefix nor list the
        // parent: a leftover backup is left where the user can see it, not swept.
        for signature in [
            "fn install_dir_driver<A: DirInstallAdapter>(",
            "pub(super) fn install_dir(source: &Path, target: &Path) -> Result<(), Error> {",
            "fn rollback_backup(",
            "fn directory_entry_at(dir: &File, name: &OsStr) -> Result<Option<WindowsDirEntry>, Error> {",
        ] {
            let body = body_at_indent(source, signature);
            for forbidden in [
                "starts_with",
                "trim_start_matches",
                "enumerate_directory",
                "read_directory_entries",
                "remove_dir_all",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "{signature} must not {forbidden}; a failed rollback's backup is not swept"
                );
            }
        }
        // The flush walk enumerates the staged tree it was handed, never a name filter over the
        // destination's parent.
        let flush = body_at_indent(
            source,
            "fn sync_windows_tree(dir: &File, depth: usize) -> Result<(), Error> {",
        );
        for forbidden in [
            "starts_with",
            "trim_start_matches",
            "filter(",
            "remove_dir_all",
        ] {
            assert!(
                !flush.contains(forbidden),
                "sync_windows_tree must not {forbidden}; it flushes its own handle"
            );
        }
        assert!(
            flush.contains("enumerate_directory(dir, &CancellationToken::new(), None)"),
            "the flush walks only the handle it was given: {flush}"
        );
        // The one backup leaf is built from the shared constant, never from a glob or a listing.
        let creation = body_at_indent(source, "let backup_name: OsString =");
        assert!(
            creation.contains("format!(\"{INSTALL_BACKUP_PREFIX}"),
            "the backup leaf must be built from the shared constant: {creation}"
        );
    }

    #[test]
    fn download_io_serializes_without_path() {
        for (source, category) in [
            (
                std::io::Error::other("/private/staging/payload: permission denied"),
                "io",
            ),
            (
                std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "/private/staging/payload: permission denied",
                ),
                "permission",
            ),
            (
                std::io::Error::from(std::io::ErrorKind::NotFound),
                "missing-resource",
            ),
        ] {
            let error = sanitize_download_error(Error::Io(Box::new(source)));
            let Error::Io(source) = &error else {
                panic!("sanitization must preserve the I/O error");
            };
            assert_eq!(source.to_string(), "I/O failure");
            let serialized = serde_json::to_string(&error).unwrap();
            let payload: serde_json::Value = serde_json::from_str(&serialized).unwrap();
            assert_eq!(payload["category"], category);
            assert_eq!(payload["message"], "I/O failure");
            assert!(!serialized.contains("staging"));
            assert!(!serialized.contains("private"));
        }
    }

    #[test]
    fn download_lichess_games_rejects_traversal_player_before_push() {
        assert!(matches!(
            lichess_games_url("../account", None),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn file_exists_rejects_a_capability_without_engine_inspection_authority() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("private-engine");
        std::fs::write(&executable, b"engine").unwrap();
        let mut authority = test_path_authority(&dir);
        let handle = authority
            .migrate_legacy_os_path(
                executable.as_os_str().to_os_string(),
                "engine",
                crate::infra::path_authority::PathClass::PersistentFile,
                vec![crate::infra::path_authority::PathOperation::EngineExecute],
            )
            .unwrap();

        let error = file_exists_with_authority(&mut authority, &handle.id).unwrap_err();
        let serialized = serde_json::to_string(&error).unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(payload["category"], "invalid-input");
        assert_eq!(payload["message"], error.to_string());
        assert!(!serialized.contains(&executable.display().to_string()));
        assert!(!serialized.contains("Permission denied"));
        assert!(!serialized.contains("os error"));
    }

    #[test]
    fn file_exists_returns_false_only_after_the_registered_file_is_deleted() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("engine");
        std::fs::write(&executable, b"engine").unwrap();
        let mut authority = test_path_authority(&dir);
        let handle = authority
            .register_engine_file(&executable, "engine")
            .unwrap();
        assert!(file_exists_with_authority(&mut authority, handle.path_ref()).unwrap());

        std::fs::remove_file(&executable).unwrap();
        assert!(!file_exists_with_authority(&mut authority, handle.path_ref()).unwrap());
    }

    #[test]
    fn engine_binary_inspection_rejects_a_capability_without_inspection_authority() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join("private-engine");
        std::fs::write(&executable, b"engine").unwrap();
        let mut authority = test_path_authority(&dir);
        let handle = authority
            .migrate_legacy_os_path(
                executable.as_os_str().to_os_string(),
                "engine",
                crate::infra::path_authority::PathClass::PersistentFile,
                vec![crate::infra::path_authority::PathOperation::EngineExecute],
            )
            .unwrap();

        let error = file_exists_with_authority(&mut authority, &handle.id).unwrap_err();
        let serialized = serde_json::to_string(&error).unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert!(matches!(error, Error::InvalidInput(_)));
        assert_eq!(payload["category"], "invalid-input");
        assert_eq!(payload["message"], error.to_string());
        assert!(!serialized.contains(&executable.display().to_string()));
        assert!(!serialized.contains("Permission denied"));
        assert!(!serialized.contains("os error"));
    }

    #[test]
    fn download_durability_mapper_serializes_only_its_closed_label() {
        let durability = download_target_durability(
            crate::infra::fs::AtomicFileOutcome::CommittedDurabilityUncertain(
                std::io::Error::other(r"C:\private\download: access denied"),
            ),
        )
        .expect("uncertain durability");
        assert_eq!(
            serde_json::to_string(&durability).expect("serialize durability"),
            r#"{"DurabilityUncertain":"DownloadTargetReplacement"}"#
        );
    }

    #[test]
    fn download_reservation_is_bounded_exact_and_cleans_up() {
        let operations = crate::infra::operations::OperationRegistry::default();
        let first = operations.prepare_download("owner").unwrap();
        assert!(operations.cancel_download(&first, "owner").unwrap());
        assert!(matches!(
            operations.claim_download(
                &first,
                "owner",
                "download",
                "progress",
                "progress",
                false,
                MAX_ACTIVE_DOWNLOADS,
            ),
            Err(Error::Cancellation)
        ));
        assert!(!operations.cancel_download(&first, "owner").unwrap());
    }

    #[test]
    fn test_extract_zip_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("test.zip");

        let file = std::fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);

        let options = zip::write::SimpleFileOptions::default();

        zip.start_file("/absolute/path.txt", options).unwrap();
        zip.write_all(b"content").unwrap();
        zip.start_file("../traversal.txt", options).unwrap();
        zip.write_all(b"content").unwrap();
        zip.finish().unwrap();

        let zip_file = std::fs::File::open(&zip_path).unwrap();
        let extract_path = dir.path().join("extracted");
        let result = extract_zip(zip_file, &extract_path, OpClass::Engine.limits());

        assert!(result.is_err());
    }

    #[test]
    fn test_extract_tar_limits() {
        let dir = tempdir().unwrap();
        let tar_path = dir.path().join("bomb.tar");
        let mut header = tar::Header::new_gnu();
        header.set_size(5);
        header.set_cksum();
        let mut tar = tar::Builder::new(std::fs::File::create(&tar_path).unwrap());
        tar.append_data(&mut header, "large.bin", b"12345".as_slice())
            .unwrap();
        tar.finish().unwrap();
        let limits = ArchiveLimits {
            compressed: 100,
            expanded: 4,
            per_entry: 4,
            entries: 1,
            ratio: 10,
        };
        let output = dir.path().join("output");
        assert!(extract_tar(std::fs::File::open(tar_path).unwrap(), &output, limits).is_err());
        assert!(!output.exists());
    }

    #[test]
    fn test_extract_tar_symlink_fault() {
        let dir = tempdir().unwrap();
        let tar_path = dir.path().join("symlink.tar");

        let mut header = tar::Header::new_gnu();
        header.set_size(0);
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_cksum();
        let mut tar = tar::Builder::new(std::fs::File::create(&tar_path).unwrap());
        tar.append_data(&mut header, "link.txt", "".as_bytes())
            .unwrap();
        tar.finish().unwrap();

        let tar_file = std::fs::File::open(&tar_path).unwrap();
        let extract_path = dir.path().join("extracted");
        let result = extract_tar(tar_file, &extract_path, OpClass::Engine.limits());

        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().to_string(),
            "Invalid input: Special files/links not allowed in archive"
        );
    }

    #[cfg(unix)]
    fn test_executable_archive(zip: bool, duplicate: bool) -> std::fs::File {
        let mut output = tempfile::tempfile().unwrap();
        if zip {
            let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
            for (name, bytes) in [
                ("engine", b"first".as_slice()),
                ("./engine", b"other".as_slice()),
            ]
            .into_iter()
            .take(if duplicate { 2 } else { 1 })
            {
                archive
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                archive.write_all(bytes).unwrap();
            }
            let bytes = archive.finish().unwrap().into_inner();
            // Identical ZIP names collapse in the reader. Keep distinct central-directory
            // names that validation maps to the same destination, so both opens are exercised.
            if duplicate {
                let mut reader = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
                assert_eq!(reader.len(), 2);
                for (index, (name, expected)) in [
                    ("engine", b"first".as_slice()),
                    ("./engine", b"other".as_slice()),
                ]
                .into_iter()
                .enumerate()
                {
                    let mut member = reader.by_index(index).unwrap();
                    assert!(member.is_file());
                    assert_eq!(member.name(), name);
                    assert_eq!(
                        validate_archive_path(member.name()).unwrap(),
                        Path::new("engine")
                    );
                    let mut body = Vec::new();
                    member.read_to_end(&mut body).unwrap();
                    assert_eq!(body, expected);
                }
            }
            output.write_all(&bytes).unwrap();
        } else {
            let mut archive = tar::Builder::new(&mut output);
            for bytes in [b"first".as_slice(), b"other".as_slice()]
                .into_iter()
                .take(if duplicate { 2 } else { 1 })
            {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_cksum();
                archive.append_data(&mut header, "engine", bytes).unwrap();
            }
            archive.finish().unwrap();
        }
        output.rewind().unwrap();
        output
    }

    #[cfg(unix)]
    fn test_executable_two_forks_archive(zip: bool) {
        let archive = test_executable_archive(zip, false);
        let directory = tempdir().unwrap();
        let staging = crate::infra::fs::OwnedStagingDir::adopt(&directory).unwrap();
        let path = directory.path().join("engine");
        crate::infra::test_executable::tests::two_fork_proof(&path, move || {
            let cancellation = CancellationToken::new();
            if zip {
                prepare_zip_cancellable(archive, staging, OpClass::Engine.limits(), &cancellation)
            } else {
                prepare_tar_cancellable(archive, staging, OpClass::Engine.limits(), &cancellation)
            }
            .unwrap()
        });
    }

    #[cfg(unix)]
    #[test]
    fn test_executable_two_fork_handler_sequence_blocks_zip_producer() {
        test_executable_two_forks_archive(true);
    }

    #[cfg(unix)]
    #[test]
    fn test_executable_two_fork_handler_sequence_blocks_tar_producer() {
        test_executable_two_forks_archive(false);
    }

    #[cfg(unix)]
    #[test]
    fn test_executable_duplicate_archive_members_preserve_first_inode() {
        for zip in [true, false] {
            let archive = test_executable_archive(zip, true);
            let directory = tempdir().unwrap();
            let staging = crate::infra::fs::OwnedStagingDir::adopt(&directory).unwrap();
            let path = directory.path().join("engine");
            crate::infra::test_executable::tests::duplicate_archive_proof(
                &path,
                b"first",
                move || {
                    let cancellation = CancellationToken::new();
                    if zip {
                        prepare_zip_cancellable(
                            archive,
                            staging,
                            OpClass::Engine.limits(),
                            &cancellation,
                        )
                    } else {
                        prepare_tar_cancellable(
                            archive,
                            staging,
                            OpClass::Engine.limits(),
                            &cancellation,
                        )
                    }
                    .map(drop)
                },
            );
        }
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(body).unwrap();
        }
        zip.finish().unwrap();
    }

    fn leaves(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    struct ResetArchiveHook;
    impl Drop for ResetArchiveHook {
        fn drop(&mut self) {
            set_archive_pre_install_hook(None);
        }
    }

    #[test]
    fn map_zip_error_preserves_io_and_uses_invalid_input_message() {
        let error = map_zip_error(
            zip::result::ZipError::Io(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)),
            "Invalid zip entry",
        );
        assert!(
            matches!(error, Error::Io(ref source) if source.kind() == std::io::ErrorKind::UnexpectedEof),
            "{error}"
        );
        let error = map_zip_error(
            zip::result::ZipError::InvalidArchive("untrusted detail"),
            "Invalid zip entry",
        );
        assert!(matches!(&error, Error::InvalidInput(message) if message == "Invalid zip entry"));
        assert_eq!(error.to_string(), "Invalid input: Invalid zip entry");
    }

    #[test]
    fn extract_zip_non_archive_returns_fixed_error() {
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"not a zip archive").unwrap();
        file.rewind().unwrap();
        let parent = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(&parent.path().join("payload")).unwrap();
        let error = extract_zip_cancellable(
            file,
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Invalid input: Invalid zip archive");
        assert!(leaves(parent.path()).is_empty());
    }

    // The fixture relies on a pipe refusing to seek (ESPIPE).
    #[test]
    #[cfg(unix)]
    fn extract_zip_io_error_is_preserved_and_sanitized() {
        let (reader, mut writer) = std::io::pipe().unwrap();
        writer.write_all(b"not a zip archive").unwrap();
        drop(writer);
        let handle = std::os::fd::OwnedFd::from(reader);
        let file = std::fs::File::from(handle);
        let parent = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(&parent.path().join("payload")).unwrap();
        let result = extract_zip_cancellable(
            file,
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &CancellationToken::new(),
        );
        assert!(matches!(&result, Err(Error::Io(_))));
        let error = result.unwrap_err();
        let diagnostic = std::error::Error::source(&error).unwrap().to_string();
        let sanitized = sanitize_download_error(error);
        let serialized = serde_json::to_string(&sanitized).unwrap();
        let payload: serde_json::Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(payload["message"], "I/O failure");
        assert!(!serialized.contains(&diagnostic));
        assert!(leaves(parent.path()).is_empty());
    }

    #[test]
    fn extract_zip_cancel_or_fail_leaves_no_inner_staging_leaf() {
        let archives = tempdir().unwrap();
        let good = archives.path().join("good.zip");
        write_zip(&good, &[("a.txt", b"a")]);
        let bad = archives.path().join("bad.zip");
        write_zip(&bad, &[("ok.txt", b"ok"), ("../escape.txt", b"x")]);

        let parent = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(&parent.path().join("payload")).unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = extract_zip_cancellable(
            std::fs::File::open(&good).unwrap(),
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &cancelled,
        )
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert!(
            leaves(parent.path()).is_empty(),
            "{:?}",
            leaves(parent.path())
        );

        let error = extract_zip_cancellable(
            std::fs::File::open(&bad).unwrap(),
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "Invalid input: Parent dir in path");
        assert!(
            leaves(parent.path()).is_empty(),
            "{:?}",
            leaves(parent.path())
        );
    }

    #[test]
    fn extract_tar_cancel_or_fail_leaves_no_inner_staging_leaf() {
        let archives = tempdir().unwrap();
        let tar_path = archives.path().join("good.tar");
        let mut header = tar::Header::new_gnu();
        header.set_size(3);
        header.set_cksum();
        let mut tar = tar::Builder::new(std::fs::File::create(&tar_path).unwrap());
        tar.append_data(&mut header, "ok.txt", b"abc".as_slice())
            .unwrap();
        tar.finish().unwrap();
        drop(tar);
        let limits = ArchiveLimits {
            compressed: 1 << 20,
            expanded: 2,
            per_entry: 1 << 20,
            entries: 8,
            ratio: 10,
        };

        let parent = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(&parent.path().join("payload")).unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let error = extract_tar_cancellable(
            std::fs::File::open(&tar_path).unwrap(),
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &cancelled,
        )
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert!(
            leaves(parent.path()).is_empty(),
            "{:?}",
            leaves(parent.path())
        );

        let error = extract_tar_cancellable(
            std::fs::File::open(&tar_path).unwrap(),
            &pin,
            parent.path(),
            OsStr::new("payload"),
            limits,
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert!(matches!(error, Error::ResourceLimit(_)), "{error}");
        assert!(
            leaves(parent.path()).is_empty(),
            "{:?}",
            leaves(parent.path())
        );
    }

    #[test]
    fn extract_tar_cancelled_before_install_leaves_no_inner_staging_leaf() {
        let _reset = ResetArchiveHook;
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(&raw_tar_payload()).unwrap();
        file.rewind().unwrap();
        let parent = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(&parent.path().join("payload")).unwrap();
        let cancellation = CancellationToken::new();
        let hook_token = cancellation.clone();
        set_archive_pre_install_hook(Some(Box::new(move |_| hook_token.cancel())));

        let error = extract_tar_cancellable(
            file,
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &cancellation,
        )
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation), "{error}");
        assert!(!parent.path().join("payload").exists());
        assert!(leaves(parent.path()).is_empty());
    }

    #[test]
    fn extract_zip_staging_outside_pinned_parent_is_conflict() {
        let archives = tempdir().unwrap();
        let archive = archives.path().join("engine.zip");
        write_zip(&archive, &[("engine.bin", b"engine")]);
        let root = tempdir().unwrap();
        let outer = private_tempdir_in(".archive", root.path()).unwrap();
        let outer_leaf = outer.path().file_name().unwrap().to_os_string();
        let elsewhere = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(outer.path()).unwrap();

        let error = extract_zip_cancellable(
            std::fs::File::open(&archive).unwrap(),
            &pin,
            elsewhere.path(),
            &outer_leaf,
            OpClass::Engine.limits(),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Conflict: archive staging parent changed concurrently"
        );
        assert!(!error.to_string().contains('/'));
        assert_eq!(
            leaves(root.path()),
            vec![outer_leaf.to_string_lossy().into_owned()]
        );
        assert!(leaves(outer.path()).is_empty());
        assert!(leaves(elsewhere.path()).is_empty());
    }

    #[test]
    fn extract_zip_inner_leaf_substitution_before_install_is_conflict() {
        let _reset = ResetArchiveHook;
        let archives = tempdir().unwrap();
        let archive = archives.path().join("payload.zip");
        write_zip(&archive, &[("real.txt", b"real")]);
        let parent = tempdir().unwrap();
        let pin = crate::infra::fs::open_parent_no_follow(&parent.path().join("payload")).unwrap();
        let moved = tempdir().unwrap();
        let moved_path = moved.path().join("original");
        set_archive_pre_install_hook(Some(Box::new(move |dest_parent| {
            let inner = std::fs::read_dir(dest_parent)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with(".zip")
                })
                .expect("inner staging leaf");
            std::fs::rename(&inner, &moved_path).unwrap();
            std::fs::create_dir(&inner).unwrap();
            std::fs::write(inner.join("planted.txt"), b"planted").unwrap();
        })));

        let error = extract_zip_cancellable(
            std::fs::File::open(&archive).unwrap(),
            &pin,
            parent.path(),
            OsStr::new("payload"),
            OpClass::Engine.limits(),
            &CancellationToken::new(),
        )
        .unwrap_err();
        assert!(matches!(error, Error::Conflict(_)), "{error}");
        assert!(!error.to_string().contains('/'), "{error}");
        assert!(!parent.path().join("payload").exists());
    }

    use crate::infra::net::{DownloadResponse, DownloadTransport};
    use reqwest::header::{HeaderMap, HeaderValue};

    pub struct MockTransport {
        pub responses: std::sync::Mutex<Vec<Result<DownloadResponse, Error>>>,
        pub requests_seen: std::sync::Mutex<Vec<(String, HeaderMap)>>,
    }

    fn coverage_response(body: &str) -> DownloadResponse {
        DownloadResponse {
            status: 200,
            headers: HeaderMap::new(),
            content_length: Some(body.len() as u64),
            stream: Box::pin(futures_util::stream::iter(vec![Ok(bytes::Bytes::from(
                body.to_owned(),
            ))])),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lichess_runtime_coverage_follows_export_and_holds_missing_finished_game() {
        use crate::db::linked_collections::tests::{game, Fixture};
        use crate::file_workspace::WorkspaceFileType;
        let fixture = Fixture::new();
        fixture.create("history", "", WorkspaceFileType::Game);
        let collection = fixture.list().pop().unwrap();
        fixture.account(&collection.id, "lichess");
        let start = chrono::NaiveDate::from_ymd_opt(2026, 10, 1)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp_millis();
        let since = start - 1000;
        fixture.set_coverage_cursor(&collection.id, since);
        let body = game(None, "e4 e5", "newer blitz")
            .replace("https://www.chess.com", "https://lichess.org/Blitz001")
            .replace("2026.10.01", "2026.10.10");
        let (state, app, account, transport) =
            authenticated_lichess_runtime_setup(&fixture, "player", coverage_response(&body));
        let export_finished = Arc::new(AtomicBool::new(false));
        let finished = export_finished.clone();
        let observed_transport = transport.clone();
        let mut body = Some(bytes::Bytes::from(body));
        transport.responses.lock().unwrap()[0] = Ok(DownloadResponse {
            status: 200,
            headers: HeaderMap::new(),
            content_length: None,
            stream: Box::pin(futures_util::stream::poll_fn(move |_| {
                if let Some(body) = body.take() {
                    return Poll::Ready(Some(Ok(body)));
                }
                assert_eq!(
                    observed_transport.requests_seen.lock().unwrap().len(),
                    1,
                    "coverage was requested before export EOF"
                );
                finished.store(true, Ordering::SeqCst);
                Poll::Ready(None)
            })),
        });
        // The old last move must never release a game which ended later by timeout.
        let line = serde_json::json!({"id":"Corresp1", "rated":true, "perf":"correspondence", "status":"outoftime", "createdAt":start, "lastMoveAt":start});
        transport.responses.lock().unwrap()[1] = Ok(coverage_response(&format!("{line}\n")));
        let job = state.operations.prepare_download("fixture-window").unwrap();
        let downloaded = download_lichess_games_runtime(
            account.handle,
            fixture.download_destination(),
            "coverage.pgn".into(),
            "player".into(),
            Some(since),
            job,
            "fixture-window",
            app.handle(),
            &state,
        )
        .await
        .unwrap();
        assert!(export_finished.load(Ordering::SeqCst));
        assert!(downloaded.receipt_error.is_none());
        let holds = downloaded.coverage_holds.as_ref().unwrap();
        assert_eq!(
            holds,
            &[crate::lichess::CoverageHold {
                id: "Corresp1".into(),
                created_at_ms: start,
                ongoing: false
            }]
        );
        {
            let requests = transport.requests_seen.lock().unwrap();
            assert_eq!(requests.len(), 2);
            let export = reqwest::Url::parse(&requests[0].0).unwrap();
            let coverage = reqwest::Url::parse(&requests[1].0).unwrap();
            assert_eq!(export.path(), coverage.path());
            let export_query: std::collections::HashMap<_, _> = export.query_pairs().collect();
            let query: std::collections::HashMap<_, _> = coverage.query_pairs().collect();
            assert_eq!(query.get("since"), export_query.get("since"));
            assert_eq!(query.get("since").unwrap().as_ref(), since.to_string());
            assert_eq!(query.get("ongoing").unwrap(), "true");
            for key in ["perfType", "rated", "finished"] {
                assert!(!query.contains_key(key));
            }
            for key in ["moves", "tags", "clocks", "evals", "opening"] {
                assert_eq!(query.get(key).unwrap(), "false");
            }
            assert_eq!(
                requests[1].1.get(reqwest::header::ACCEPT).unwrap(),
                "application/x-ndjson"
            );
            assert_eq!(
                requests[1].1.get(reqwest::header::AUTHORIZATION),
                requests[0].1.get(reqwest::header::AUTHORIZATION)
            );
        }
        fixture
            .service
            .clone()
            .append_batch(
                state.pgn_path_authority.clone(),
                uuid::Uuid::parse_str(&collection.id).unwrap(),
                downloaded.publication.handle,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            fixture.list().pop().unwrap().fetch_since_ms,
            Some((start - 1).to_string())
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lichess_runtime_coverage_failures_fail_download_without_publication() {
        use crate::db::linked_collections::tests::{game, Fixture};
        let valid = serde_json::json!({"id":"Corresp1", "rated":true, "perf":"correspondence", "status":"started", "createdAt":100});
        let mut failures = vec![
            coverage_response("not-json disposable-fixture-token"),
            DownloadResponse {
                status: 429,
                ..coverage_response("disposable-fixture-token")
            },
            DownloadResponse {
                content_length: Some(100),
                ..coverage_response("")
            },
            coverage_response(&"x".repeat(64 * 1024 + 1)),
        ];
        for field in ["id", "rated", "perf", "status", "createdAt"] {
            let mut line = valid.clone();
            line.as_object_mut().unwrap().remove(field);
            failures.push(coverage_response(&line.to_string()));
        }
        for failure in failures {
            let status = failure.status;
            let oversized = failure
                .content_length
                .is_some_and(|length| length > 64 * 1024);
            let fixture = Fixture::new();
            let (state, app, account, transport) = authenticated_lichess_runtime_setup(
                &fixture,
                "player",
                coverage_response(&game(None, "e4 e5", "export")),
            );
            transport.responses.lock().unwrap()[1] = Ok(failure);
            let job = state.operations.prepare_download("fixture-window").unwrap();
            let error = download_lichess_games_runtime(
                account.handle,
                fixture.download_destination(),
                "failed.pgn".into(),
                "player".into(),
                None,
                job.clone(),
                "fixture-window",
                app.handle(),
                &state,
            )
            .await
            .unwrap_err();
            if status == 429 {
                assert!(
                    matches!(&error, Error::RemoteHttpRejection(rejection) if rejection.status == 429 && rejection.authorization_sent)
                );
            } else if oversized {
                assert!(matches!(&error, Error::ResourceLimit(_)));
            } else {
                assert!(matches!(&error, Error::InvalidInput(_)));
            }
            assert!(!serde_json::to_string(&error)
                .unwrap()
                .contains("disposable-fixture-token"));
            assert_eq!(
                state.progress_state.get(&job).unwrap().unwrap().state,
                ProgressState::Failed
            );
            assert!(!fixture
                .directory
                .path()
                .join("app/collections/batches/failed.pgn")
                .exists());
            assert_eq!(transport.requests_seen.lock().unwrap().len(), 2);
        }
    }

    #[cfg(unix)]
    fn authenticated_lichess_runtime_setup(
        fixture: &crate::db::linked_collections::tests::Fixture,
        player: &str,
        response: DownloadResponse,
    ) -> (
        AppState,
        tauri::App<tauri::test::MockRuntime>,
        crate::credentials::LichessAccountMetadata,
        Arc<MockTransport>,
    ) {
        let transport = Arc::new(MockTransport {
            responses: Mutex::new(vec![Ok(response), Ok(coverage_response(""))]),
            requests_seen: Mutex::new(vec![]),
        });
        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                &fixture.directory.path().join("credentials-app"),
            ))
            .unwrap();
        let account = credentials
            .store_lichess_token(player.into(), "disposable-fixture-token".into())
            .unwrap()
            .account;
        let state = AppState {
            credentials,
            http_transport: transport.clone(),
            ..fixture.state.clone()
        };
        (state, test_progress_app(), account, transport)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reload_completion_lichess_runtime_retains_publication_after_receipt_failure() {
        use crate::db::linked_collections::{tests::Fixture, RECORD_DOWNLOAD_FAILURE};

        struct ResetReceiptFailure((String, String));
        impl Drop for ResetReceiptFailure {
            fn drop(&mut self) {
                RECORD_DOWNLOAD_FAILURE.clear(&self.0);
            }
        }

        let fixture = Fixture::new();
        let player = "reload-receipt-failure";
        let body = crate::db::linked_collections::tests::game(
            None,
            "e4 e5",
            "published before receipt failure",
        )
        .replace("https://www.chess.com", "https://lichess.org/AbCd1234");
        let length = body.len() as u64;
        let (state, app, account, _) = authenticated_lichess_runtime_setup(
            &fixture,
            player,
            DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: None,
                stream: Box::pin(futures_util::stream::iter(vec![Ok(bytes::Bytes::from(
                    body,
                ))])),
            },
        );
        let job = state.operations.prepare_download("fixture-window").unwrap();
        let key = ("lichess".into(), player.into());
        let _reset = ResetReceiptFailure(key.clone());
        RECORD_DOWNLOAD_FAILURE.arm(key, Error::Conflict("receipt recording failed".into()));

        let result = download_lichess_games_runtime(
            account.handle,
            fixture.download_destination(),
            "receipt-failure.pgn".into(),
            player.into(),
            None,
            job,
            "fixture-window",
            app.handle(),
            &state,
        )
        .await;
        assert!(
            result.is_ok(),
            "published download was discarded: {result:?}"
        );
        let downloaded = result.unwrap();
        assert!(matches!(
            downloaded.receipt_error,
            Some(Error::Conflict(ref message)) if message == "receipt recording failed"
        ));
        let snapshot = state
            .pgn_path_authority
            .with_mut(|authority| {
                authority
                    .resolve(
                        downloaded.publication.handle.path_ref(),
                        crate::infra::path_authority::PathOperation::ReadPgn,
                        &[],
                    )
                    .unwrap()
                    .pgn_snapshot()
            })
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.revision.size, length);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn linked_collections_lichess_runtime_downloads_differing_sizes_and_appends_genuine_artifact(
    ) {
        use crate::db::linked_collections::tests::{game, Fixture};
        use crate::file_workspace::WorkspaceFileType;
        for has_length in [false, true] {
            let fixture = Fixture::new();
            fixture.create("history", "", WorkspaceFileType::Game);
            let collection = fixture.list().pop().unwrap();
            fixture.account(&collection.id, "lichess");
            let body = game(None, "e4 e5", "a real export body, not a 900-byte estimate")
                .replace("https://www.chess.com", "https://lichess.org/AbCd1234");
            assert_ne!(body.len(), 900);
            let length = body.len() as u64;
            let (state, app, account, transport) = authenticated_lichess_runtime_setup(
                &fixture,
                "player",
                DownloadResponse {
                    status: 200,
                    headers: if has_length {
                        let mut headers = HeaderMap::new();
                        headers.insert(
                            reqwest::header::CONTENT_LENGTH,
                            HeaderValue::from_str(&length.to_string()).unwrap(),
                        );
                        headers
                    } else {
                        HeaderMap::new()
                    },
                    content_length: has_length.then_some(length),
                    stream: Box::pin(futures_util::stream::iter(vec![Ok(bytes::Bytes::from(
                        body.clone(),
                    ))])),
                },
            );
            let job = state.operations.prepare_download("fixture-window").unwrap();
            let publication = download_lichess_games_runtime(
                account.handle,
                fixture.download_destination(),
                "downloaded.pgn".into(),
                "player".into(),
                None,
                job,
                "fixture-window",
                app.handle(),
                &state,
            )
            .await
            .unwrap();
            assert!(publication.receipt_error.is_none());
            let publication = publication.publication;
            let snapshot = state
                .pgn_path_authority
                .with_mut(|authority| {
                    authority
                        .resolve(
                            publication.handle.path_ref(),
                            crate::infra::path_authority::PathOperation::ReadPgn,
                            &[],
                        )
                        .unwrap()
                        .pgn_snapshot()
                })
                .unwrap()
                .unwrap();
            assert_eq!(snapshot.revision.size, length);
            assert!(
                state
                    .pgn_path_authority
                    .with_mut(|authority| authority.resolve(
                        publication.handle.path_ref(),
                        crate::infra::path_authority::PathOperation::WritePgn,
                        &[]
                    ))
                    .unwrap()
                    .is_err(),
                "downloaded PGN received write authority"
            );
            let outcome = Arc::clone(&fixture.service)
                .append_batch(
                    state.pgn_path_authority.clone(),
                    uuid::Uuid::parse_str(&collection.id).unwrap(),
                    publication.handle.clone(),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(outcome.appended, 1);
            assert!(outcome.index_ready && outcome.committed);
            assert!(std::fs::read(fixture.path("history"))
                .unwrap()
                .ends_with(body.as_bytes()));
            let retry = Arc::clone(&fixture.service)
                .append_batch(
                    state.pgn_path_authority.clone(),
                    uuid::Uuid::parse_str(&collection.id).unwrap(),
                    publication.handle,
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(retry.appended, 0);
            assert_eq!(transport.requests_seen.lock().unwrap().len(), 2);
        }
    }

    #[async_trait::async_trait]
    impl DownloadTransport for MockTransport {
        async fn request(&self, url: &str, headers: HeaderMap) -> Result<DownloadResponse, Error> {
            self.requests_seen
                .lock()
                .unwrap()
                .push((url.to_string(), headers.clone()));
            let mut resps = self.responses.lock().unwrap();
            if resps.is_empty() {
                return Err(Error::InvalidInput("No more mock responses".into()));
            }
            resps.remove(0)
        }
    }

    struct BlockingChunkStream {
        first_chunk: Mutex<Option<bytes::Bytes>>,
        release: Arc<tokio::sync::Notify>,
        waiting: Mutex<Option<Pin<Box<dyn Future<Output = ()> + Send>>>>,
        first_seen: Arc<AtomicBool>,
        stopped: Arc<AtomicBool>,
    }

    impl BlockingChunkStream {
        fn new(first_seen: Arc<AtomicBool>, stopped: Arc<AtomicBool>) -> Self {
            Self {
                first_chunk: Mutex::new(Some(bytes::Bytes::from_static(b"first"))),
                release: Arc::new(tokio::sync::Notify::new()),
                waiting: Mutex::new(None),
                first_seen,
                stopped,
            }
        }
    }

    impl futures_util::Stream for BlockingChunkStream {
        type Item = Result<bytes::Bytes, Error>;

        fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
            let this = self.get_mut();
            if let Some(chunk) = this.first_chunk.lock().unwrap().take() {
                this.first_seen.store(true, Ordering::SeqCst);
                return Poll::Ready(Some(Ok(chunk)));
            }
            let mut waiting = this.waiting.lock().unwrap();
            if waiting.is_none() {
                *waiting = Some(Box::pin(this.release.clone().notified_owned()));
            }
            let Some(future) = waiting.as_mut() else {
                return Poll::Pending;
            };
            match future.as_mut().poll(cx) {
                Poll::Ready(()) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            }
        }
    }

    impl Drop for BlockingChunkStream {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
        }
    }

    struct BlockingChunkTransport {
        first_seen: Arc<AtomicBool>,
        stopped: Arc<AtomicBool>,
    }

    #[async_trait::async_trait]
    impl DownloadTransport for BlockingChunkTransport {
        async fn request(&self, _: &str, _: HeaderMap) -> Result<DownloadResponse, Error> {
            Ok(DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: Some(10),
                stream: Box::pin(BlockingChunkStream::new(
                    Arc::clone(&self.first_seen),
                    Arc::clone(&self.stopped),
                )),
            })
        }
    }

    #[tokio::test]
    async fn test_download_file_http_error() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("out.txt");
        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![Ok(DownloadResponse {
                status: 500,
                headers: HeaderMap::new(),
                content_length: None,
                stream: Box::pin(futures_util::stream::empty()),
            })]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };

        let res = download_file_core(
            OpClass::Lichess,
            "https://lichess.org/test",
            &target,
            None,
            &mock,
            None,
            None,
            |_| Ok(()),
        )
        .await;

        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err().to_string(),
            "Remote HTTP request rejected: status 500"
        );
    }

    fn rejected_response(status: u16, polled: Arc<AtomicBool>) -> DownloadResponse {
        DownloadResponse {
            status,
            headers: HeaderMap::new(),
            content_length: Some(u64::MAX),
            stream: Box::pin(futures_util::stream::poll_fn(move |_| {
                polled.store(true, Ordering::SeqCst);
                Poll::Ready(Some(Ok(bytes::Bytes::from_static(b"private remote body"))))
            })),
        }
    }

    #[tokio::test]
    async fn remote_http_rejection_uses_final_request_headers_before_polling_body() {
        for (status, category) in [
            (400, "network"),
            (401, "authentication"),
            (403, "permission"),
            (404, "missing-resource"),
            (429, "network"),
            (500, "network"),
            (503, "network"),
        ] {
            for (token, redirect, authorization_sent) in [
                (None, None, false),
                (Some("private_token"), None, true),
                (
                    Some("private_token"),
                    Some("https://lichess.org/other"),
                    true,
                ),
                (
                    Some("private_token"),
                    Some("https://example.com/other"),
                    false,
                ),
                // An invalid header is never sent, even when a token was supplied.
                (Some("private\ntoken"), None, false),
            ] {
                let mut file = tempfile::tempfile().unwrap();
                let polled = Arc::new(AtomicBool::new(false));
                let mut responses = vec![];
                if let Some(location) = redirect {
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        reqwest::header::LOCATION,
                        HeaderValue::from_static(location),
                    );
                    responses.push(Ok(DownloadResponse {
                        status: 302,
                        headers,
                        content_length: None,
                        stream: Box::pin(futures_util::stream::empty()),
                    }));
                }
                responses.push(Ok(rejected_response(status, polled.clone())));
                let mock = MockTransport {
                    responses: Mutex::new(responses),
                    requests_seen: Mutex::new(vec![]),
                };
                let error = download_payload_network(
                    OpClass::Lichess,
                    reqwest::Url::parse("https://lichess.org/private_account").unwrap(),
                    &mut file,
                    &mock,
                    token,
                    None,
                    CancellationToken::new(),
                    None,
                    |_| panic!("rejection must precede payload progress"),
                )
                .await
                .unwrap_err();
                assert!(!polled.load(Ordering::SeqCst));
                assert_eq!(file.metadata().unwrap().len(), 0);
                assert_eq!(
                    serde_json::to_value(&error).unwrap(),
                    serde_json::json!({
                        "tag": "backend-error", "category": category,
                        "message": format!("Remote HTTP request rejected: status {status}"),
                        "remoteHttpRejection": {"status": status, "authorizationSent": authorization_sent}
                    })
                );
                assert_eq!(
                    error.diagnostic(),
                    format!("Remote HTTP request rejected: status {status}")
                );
                let requests = mock.requests_seen.lock().unwrap();
                assert_eq!(requests.len(), if redirect.is_some() { 2 } else { 1 });
                assert_eq!(
                    requests
                        .last()
                        .unwrap()
                        .1
                        .contains_key(reqwest::header::AUTHORIZATION),
                    authorization_sent
                );
            }
        }
    }

    #[tokio::test]
    async fn test_download_file_interrupted_stream() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("out.txt");

        let stream = futures_util::stream::iter(vec![
            Ok(bytes::Bytes::from("hello")),
            Err(Error::InvalidInput("Network dropped".into())),
        ]);

        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![Ok(DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: None,
                stream: Box::pin(stream),
            })]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };

        let res = download_file_core(
            OpClass::Lichess,
            "https://lichess.org/test",
            &target,
            None,
            &mock,
            None,
            None,
            |_| Ok(()),
        )
        .await;

        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err().to_string(),
            "Invalid input: Network dropped"
        );
    }

    #[tokio::test]
    async fn test_download_file_cross_origin_token_stripping() {
        let mut file = tempfile::tempfile().unwrap();
        let cancellation = CancellationToken::new();
        let parsed_url = validate_download_request(
            OpClass::Lichess,
            "https://lichess.org/test",
            Some("my_secret_token"),
            &cancellation,
        )
        .unwrap();

        let mut redirect_headers = HeaderMap::new();
        redirect_headers.insert(
            reqwest::header::LOCATION,
            HeaderValue::from_static("https://evil.com/file"),
        );

        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![
                Ok(DownloadResponse {
                    status: 302,
                    headers: redirect_headers,
                    content_length: None,
                    stream: Box::pin(futures_util::stream::empty()),
                }),
                Ok(DownloadResponse {
                    status: 200,
                    headers: HeaderMap::new(),
                    content_length: Some(0),
                    stream: Box::pin(futures_util::stream::empty()),
                }),
            ]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };

        let res = download_payload_network(
            OpClass::Lichess,
            parsed_url,
            &mut file,
            &mock,
            Some("my_secret_token"),
            None,
            cancellation,
            None,
            |_| Ok(()),
        )
        .await;

        assert!(res.is_ok());

        let reqs = mock.requests_seen.lock().unwrap();
        assert_eq!(reqs.len(), 2);
        // First request to lichess should have the token
        assert!(reqs[0].1.contains_key("Authorization"));
        // Second request to evil.com should NOT have the token
        assert!(!reqs[1].1.contains_key("Authorization"));
    }

    #[tokio::test]
    async fn rejects_bearer_token_on_lookalike_port() {
        let dir = tempdir().unwrap();
        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };
        let error = download_file_core(
            OpClass::Lichess,
            "https://lichess.org:444/export",
            &dir.path().join("out.pgn"),
            None,
            &mock,
            Some("secret"),
            None,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), "Invalid input: Unauthorized origin");
        assert!(mock.requests_seen.lock().unwrap().is_empty());
    }

    #[test]
    fn download_url_rejects_private_literal_addresses() {
        for url in [
            "https://127.0.0.1/file",
            "https://[::1]/file",
            "https://100.64.0.1/file",
            "https://[::ffff:127.0.0.1]/file",
        ] {
            let parsed = reqwest::Url::parse(url).unwrap();
            assert!(validate_download_url(&parsed).is_err(), "{url}");
        }
    }

    #[test]
    fn download_url_component_policy_rejects_each_credential_and_fragment_independently() {
        for url in [
            "https://user@example.com/file",
            "https://user:password@example.com/file",
            "https://example.com/file#fragment",
        ] {
            assert!(validate_download_url(&reqwest::Url::parse(url).unwrap()).is_err());
        }
        assert!(validate_download_url(
            &reqwest::Url::parse("https://example.com/file?query=allowed").unwrap()
        )
        .is_ok());
    }

    #[test]
    fn archive_path_policy_enforces_exact_length_and_component_boundaries() {
        assert!(validate_archive_path("").is_err());
        assert_eq!(
            validate_archive_path("safe/directory/file.bin").unwrap(),
            PathBuf::from("safe/directory/file.bin")
        );
        assert_eq!(
            validate_archive_path("./bin/tool").unwrap(),
            PathBuf::from("bin/tool")
        );
        assert_eq!(
            validate_archive_path("a/./b.txt").unwrap(),
            PathBuf::from("a/b.txt")
        );
        assert_eq!(validate_archive_path("./").unwrap(), PathBuf::new());
        assert_eq!(
            validate_archive_path("explicit/").unwrap(),
            PathBuf::from("explicit")
        );
        assert!(validate_archive_path("../escape").is_err());
        assert!(validate_archive_path("/absolute").is_err());
        assert!(validate_archive_path("nul\0byte").is_err());

        let maximum = "a".repeat(1024);
        assert_eq!(
            validate_archive_path(&maximum).unwrap(),
            PathBuf::from(&maximum)
        );
        assert!(validate_archive_path(&"a".repeat(1025)).is_err());
    }

    #[test]
    fn extract_tar_dot_prefixed_members_install_at_normalised_paths() {
        let dir = tempdir().unwrap();
        let tar_path = dir.path().join("dot.tar");
        let mut tar = tar::Builder::new(std::fs::File::create(&tar_path).unwrap());
        for (name, body) in [("./bin/tool", &b"abc"[..]), ("a/./nested.txt", &b"xyz"[..])] {
            let mut header = tar::Header::new_gnu();
            header.set_size(body.len() as u64);
            header.set_cksum();
            tar.append_data(&mut header, name, body).unwrap();
        }
        tar.finish().unwrap();

        let output = dir.path().join("extracted");
        extract_tar(
            std::fs::File::open(&tar_path).unwrap(),
            &output,
            OpClass::Engine.limits(),
        )
        .unwrap();
        assert_eq!(std::fs::read(output.join("bin/tool")).unwrap(), b"abc");
        assert_eq!(std::fs::read(output.join("a/nested.txt")).unwrap(), b"xyz");
    }

    #[test]
    fn extract_zip_dot_prefixed_members_install_at_normalised_paths() {
        let dir = tempdir().unwrap();
        let zip_path = dir.path().join("dot.zip");
        write_zip(
            &zip_path,
            &[("./bin/tool", b"abc"), ("a/./nested.txt", b"xyz")],
        );
        let output = dir.path().join("extracted");
        extract_zip(
            std::fs::File::open(&zip_path).unwrap(),
            &output,
            OpClass::Engine.limits(),
        )
        .unwrap();
        assert_eq!(std::fs::read(output.join("bin/tool")).unwrap(), b"abc");
        assert_eq!(std::fs::read(output.join("a/nested.txt")).unwrap(), b"xyz");
    }

    #[cfg(unix)]
    struct UmaskGuard(libc::mode_t);

    #[cfg(unix)]
    impl UmaskGuard {
        fn zero() -> Self {
            // SAFETY: this test holds `UMASK_TEST_LOCK` for the guard's whole lifetime.
            Self(unsafe { libc::umask(0) })
        }
    }

    #[cfg(unix)]
    impl Drop for UmaskGuard {
        fn drop(&mut self) {
            // SAFETY: restoring the value returned by `umask` while the lock is still held.
            unsafe {
                libc::umask(self.0);
            }
        }
    }

    #[cfg(unix)]
    static UMASK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[cfg(unix)]
    fn assert_mode_700(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        assert_eq!(
            path.metadata().unwrap().permissions().mode() & 0o777,
            0o700,
            "unexpected mode for {}",
            path.display()
        );
    }

    #[cfg(unix)]
    #[test]
    fn archive_directory_creation_sites_are_private_with_zero_umask() {
        let _lock = UMASK_TEST_LOCK.lock().unwrap();
        let _umask = UmaskGuard::zero();
        let root = tempdir().unwrap();

        let zip_archive = root.path().join("archive.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        zip.add_directory("explicit/", options).unwrap();
        zip.start_file("implicit/file", options).unwrap();
        zip.write_all(b"zip").unwrap();
        zip.finish().unwrap();
        let zip_target = root.path().join("zip-target").join("installed");
        std::fs::create_dir(zip_target.parent().unwrap()).unwrap();
        extract_zip(
            std::fs::File::open(zip_archive).unwrap(),
            &zip_target,
            OpClass::Engine.limits(),
        )
        .unwrap();
        assert_mode_700(&zip_target);
        assert_mode_700(&zip_target.join("explicit"));
        assert_mode_700(&zip_target.join("implicit"));

        let tar_archive = root.path().join("archive.tar");
        let mut tar = tar::Builder::new(std::fs::File::create(&tar_archive).unwrap());
        let mut directory_header = tar::Header::new_gnu();
        directory_header.set_entry_type(tar::EntryType::Directory);
        directory_header.set_mode(0o777);
        directory_header.set_size(0);
        directory_header.set_cksum();
        tar.append_data(&mut directory_header, "explicit", std::io::empty())
            .unwrap();
        let mut file_header = tar::Header::new_gnu();
        file_header.set_mode(0o666);
        file_header.set_size(3);
        file_header.set_cksum();
        tar.append_data(&mut file_header, "implicit/file", b"tar".as_slice())
            .unwrap();
        tar.finish().unwrap();
        drop(tar);
        let tar_target = root.path().join("tar-target").join("installed");
        std::fs::create_dir(tar_target.parent().unwrap()).unwrap();
        extract_tar(
            std::fs::File::open(tar_archive).unwrap(),
            &tar_target,
            OpClass::Engine.limits(),
        )
        .unwrap();
        assert_mode_700(&tar_target);
        assert_mode_700(&tar_target.join("explicit"));
        assert_mode_700(&tar_target.join("implicit"));

        let gzip_archive = root.path().join("archive.gz");
        let mut encoder = flate2::write::GzEncoder::new(
            std::fs::File::create(&gzip_archive).unwrap(),
            flate2::Compression::default(),
        );
        encoder.write_all(b"gzip").unwrap();
        encoder.finish().unwrap();
        let gzip_target = root.path().join("gzip-target").join("installed");
        std::fs::create_dir(gzip_target.parent().unwrap()).unwrap();
        let error = extract_gz(
            std::fs::File::open(gzip_archive).unwrap(),
            &gzip_target,
            OpClass::Engine.limits(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), archive_payload_required().to_string());
        assert!(leaves(gzip_target.parent().unwrap()).is_empty());
    }

    /// Staged-failure matrix (2026-09-20; each run exited 101):
    /// - Removed `resolved.mark_engine_executable()?` from `register_installed_engine`: the
    ///   registration-mode assertion printed `installed engine execution permission check failed:
    ///   expected at least one execute bit, got 0o600`; the execution assertion printed
    ///   `installed engine execution check failed: kind=PermissionDenied, raw_os_error=Some(13),
    ///   Permission denied (os error 13)` (raw error 13 is EACCES).
    /// - Changed `Mode::from_raw_mode(0o600)` in `src-tauri/src/infra/fs.rs:4436` to `0o700`: the
    ///   extraction-mode assertion printed `archive extraction mode check failed: expected 0o600,
    ///   got 0o700`. This also reddens `owned_staging_dir_create_relative_regular_is_exclusive`'s
    ///   own `0o600` assertion at `src-tauri/src/infra/fs.rs:9385`; that collateral test was not
    ///   included in the filtered run.
    ///
    /// The first staged break was restored before the second; the mode constant was restored
    /// before the final full-suite run. The unstageable `fchmod`-failure branch is argued in the
    /// Phase 1 specification, not represented as a staged row here.
    #[cfg(unix)]
    #[test]
    fn installed_engine_archive_registration_makes_payload_executable() {
        use std::os::unix::fs::PermissionsExt;

        let _lock = UMASK_TEST_LOCK.lock().unwrap();
        let _umask = UmaskGuard::zero();
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("engine.zip");
        write_zip(&archive_path, &[("engine", b"#!/bin/sh\necho ok\n")]);
        let (mut authority, _destination, engine_root, root_handle) = engine_destination(&dir);
        let install_dir = engine_root.join("engine");
        let installed_path = install_dir.join("engine");

        extract_zip(
            std::fs::File::open(&archive_path).unwrap(),
            &install_dir,
            OpClass::Engine.limits(),
        )
        .unwrap();
        let extraction_mode = std::fs::metadata(&installed_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        authority
            .register_installed_engine_for_test(&root_handle, "engine/engine")
            .unwrap();
        let registration_mode = std::fs::metadata(&installed_path)
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        let execution = std::process::Command::new(&installed_path).output();

        let mut failures = Vec::new();
        if extraction_mode != 0o600 {
            failures.push(format!(
                "archive extraction mode check failed: expected 0o600, got {extraction_mode:#o}"
            ));
        }
        if registration_mode & 0o111 == 0 {
            failures.push(format!(
                "installed engine execution permission check failed: expected at least one execute bit, got {registration_mode:#o}"
            ));
        }
        match execution {
            Ok(output) if output.status.success() && output.stdout == b"ok\n" => {}
            Ok(output) => failures.push(format!(
                "installed engine execution check failed: status={}, stdout={:?}",
                output.status,
                String::from_utf8_lossy(&output.stdout)
            )),
            Err(error) => failures.push(format!(
                "installed engine execution check failed: kind={:?}, raw_os_error={:?}, {error}",
                error.kind(),
                error.raw_os_error()
            )),
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    #[cfg(unix)]
    #[test]
    fn archive_path_policy_matches_the_measured_removal_boundary() {
        let accepted = std::iter::repeat_n("a", MAX_ARCHIVE_PATH_COMPONENTS)
            .collect::<Vec<_>>()
            .join("/");
        let rejected = std::iter::repeat_n("a", crate::infra::fs::MAX_REMOVE_TREE_DEPTH)
            .collect::<Vec<_>>()
            .join("/");

        assert!(validate_archive_path(&accepted).is_ok());
        assert!(matches!(
            validate_archive_path(&rejected),
            Err(Error::ResourceLimit(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn near_cap_zip_installs_and_reinstalls_cleanly() {
        let root = tempdir().unwrap();
        let archive_path = root.path().join("near-cap.zip");
        let entry = std::iter::repeat_n("a", MAX_ARCHIVE_PATH_COMPONENTS)
            .collect::<Vec<_>>()
            .join("/");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&archive_path).unwrap());
        zip.start_file(entry, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"content").unwrap();
        zip.finish().unwrap();
        let target = root.path().join("installed");

        extract_zip(
            std::fs::File::open(&archive_path).unwrap(),
            &target,
            OpClass::Engine.limits(),
        )
        .unwrap();
        extract_zip(
            std::fs::File::open(&archive_path).unwrap(),
            &target,
            OpClass::Engine.limits(),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn over_cap_cleanup_failure_serializes_only_its_closed_label() {
        let root = tempdir().unwrap();
        let target = root.path().join("installed");
        let entry =
            std::iter::repeat_n("a", crate::infra::fs::MAX_REMOVE_TREE_DEPTH).collect::<PathBuf>();

        let first = root.path().join("first");
        std::fs::create_dir(&first).unwrap();
        std::fs::write(first.join("content"), b"content").unwrap();
        crate::infra::fs::atomic_install_dir(&first, &target).unwrap();

        std::fs::remove_dir_all(&target).unwrap();
        let output = target.join(&entry);
        std::fs::create_dir_all(output.parent().unwrap()).unwrap();
        std::fs::write(output, b"content").unwrap();

        let second = root.path().join("second");
        std::fs::create_dir(&second).unwrap();
        std::fs::write(second.join("content"), b"content").unwrap();
        let error = crate::infra::fs::atomic_install_dir(&second, &target).unwrap_err();
        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::OldDirectoryCleanup)
        ));
        let serialized = serde_json::to_string(&error).unwrap();
        let payload: serde_json::Value =
            serde_json::from_str(&serialized).expect("serialized error is a JSON object");
        assert_eq!(payload["category"], "durability");
        assert_eq!(
            payload["message"],
            "Committed but durability uncertain: old directory cleanup"
        );
        assert!(!serialized.contains(&root.path().display().to_string()));
        assert!(!serialized.contains("directory cleanup exceeded"));
    }

    #[test]
    fn database_and_engine_artifacts_require_a_signed_manifest() {
        for op in [OpClass::Db, OpClass::Engine] {
            let error = validate_artifact_integrity(op, "https://www.encroissant.org/file", None)
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Invalid input: signed artifact integrity metadata required"
            );
        }
    }

    #[test]
    fn puzzle_database_artifacts_require_valid_signed_manifest() {
        let url = "https://www.encroissant.org/puzzles/file.db3";
        let missing = validate_artifact_integrity(OpClass::PuzzleDb, url, None).unwrap_err();
        assert_eq!(
            missing.to_string(),
            "Invalid input: signed artifact integrity metadata required"
        );

        let invalid = ArtifactIntegrity {
            sha256: "a".repeat(64),
            signature: "invalid minisign signature".into(),
        };
        let invalid_signature =
            validate_artifact_integrity(OpClass::PuzzleDb, url, Some(&invalid)).unwrap_err();
        assert_eq!(
            invalid_signature.to_string(),
            "Invalid input: invalid artifact manifest signature"
        );
    }

    #[test]
    fn tampered_manifest_signature_is_rejected_before_download() {
        let integrity = ArtifactIntegrity {
            sha256: "a".repeat(64),
            signature: "untrusted comment: invalid\ninvalid\ntrusted comment: invalid\ninvalid"
                .into(),
        };
        assert!(validate_artifact_integrity(
            OpClass::Engine,
            "https://www.encroissant.org/engine.zip",
            Some(&integrity),
        )
        .is_err());
    }

    const FIXTURE_KEY_FILE: &str = "untrusted comment: minisign public key: 65C91D6C15CCA09E\nRWSeoMwVbB3JZcZPvs3BaTowDrUVLpnsrQ8HTgrJnKNZJAnA/6C6/IZr\n";
    const FIXTURE_DOCUMENT: &str = "[{\"fixture\":true}]\n";
    const FIXTURE_DOCUMENT_SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUSeoMwVbB3JZVkPIyrRxx59DReIPL/CsQ56EZEf2KF/YhjrawABTgv9gKWI7TUb/41yDxtJ8jgml8lYQebPdfpUfNO3tt0xYQY=\ntrusted comment: timestamp:1789770950\tfile:doc\nUBFgHQFDuFfx3UUtc3SaF3z4NuXsQADvIj3KwCf9/LhwgrbsYPqhqSccdJ/f+0oataIoP+Pqxxc2dulznzDNCw==\n";
    const FIXTURE_ENTRY_URL: &str = "https://example.com/engine.zip";
    const FIXTURE_ENTRY_SIGNATURE: &str = "untrusted comment: signature from tauri secret key\nRUSeoMwVbB3JZbcm4KridnLveV32EEC9lc/mn4QY/bJHitItGxgiVmDmoWTxW10ZFTIL1+JPBwLpP2a7qNNFMNCRd1rzbnEAzQo=\ntrusted comment: timestamp:1789770951\tfile:entry\nANuUX9ig1RReLQypPm6+UiPp0euvqQuhxD78u8yOjRe/l6Bl3eayMozJBPk9TRjGhcH+67Cqeuge6lDzKlyjDQ==\n";

    fn fixture_verify(payload: &[u8], signature: &str) -> Result<(), Error> {
        verify_minisign_signature(
            release_public_key_line(FIXTURE_KEY_FILE)?,
            payload,
            signature,
        )
    }

    #[test]
    fn catalog_minisign_fixture_round_trip_accepts_and_rejects_tampering() {
        fixture_verify(FIXTURE_DOCUMENT.as_bytes(), FIXTURE_DOCUMENT_SIGNATURE).unwrap();
        let tampered = FIXTURE_DOCUMENT.replace("true", "false");
        assert_eq!(
            fixture_verify(tampered.as_bytes(), FIXTURE_DOCUMENT_SIGNATURE)
                .unwrap_err()
                .to_string(),
            "Invalid input: artifact manifest signature verification failed"
        );
        // The fixture key is not the production key, so the command rejects fixture signatures.
        assert!(tauri::async_runtime::block_on(verify_signed_bytes(
            FIXTURE_DOCUMENT.into(),
            FIXTURE_DOCUMENT_SIGNATURE.into(),
        ))
        .is_err());
    }

    #[test]
    fn catalog_minisign_fixture_artifact_integrity_round_trip() {
        let integrity = ArtifactIntegrity {
            sha256: "AB".repeat(32),
            signature: FIXTURE_ENTRY_SIGNATURE.into(),
        };
        validate_artifact_integrity_with(
            OpClass::Engine,
            FIXTURE_ENTRY_URL,
            Some(&integrity),
            fixture_verify,
        )
        .unwrap();
        let tampered = ArtifactIntegrity {
            sha256: "ac".repeat(32),
            signature: FIXTURE_ENTRY_SIGNATURE.into(),
        };
        assert!(validate_artifact_integrity_with(
            OpClass::Engine,
            FIXTURE_ENTRY_URL,
            Some(&tampered),
            fixture_verify,
        )
        .is_err());
        assert!(validate_artifact_integrity_with(
            OpClass::Engine,
            "https://example.com/other.zip",
            Some(&integrity),
            fixture_verify,
        )
        .is_err());
    }

    #[tokio::test]
    async fn signed_raw_locator_uses_parsed_transport_and_rejects_wrong_digest_before_install() {
        // Public material from a disposable fixture key, never the release signing key.
        const KEY: &str = "RWTPLwEhRnUczKLsSeZvViQVJoMnBvfhEm4fMiur2aMd3MVDtDVi/4dD";
        const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\nRUTPLwEhRnUczFrYr8HpA/wuyHb59AIYxeK4n4Jcs6Ozt20wH/nR3dD28fzhLt0ENk25RrE7VSgJSJZZ9Sf/vOSKwcyBJ161DA4=\ntrusted comment: disposable signed locator regression fixture\n/MC4ktvIlO3Cq70Qc4Tb4/RgIil7pgnHIWNzhjHUUhifd9PyiUZWi4c8uYG7xFUbEO9mxUU6yExpp6OJrCw7DQ==\n";
        let raw_url = "https://EXAMPLE.com:443/engine.zip";
        let parsed_url = reqwest::Url::parse(raw_url).unwrap();
        assert_ne!(raw_url, parsed_url.as_str());
        let integrity = ArtifactIntegrity {
            sha256: "AB".repeat(32),
            signature: SIGNATURE.into(),
        };
        let verify =
            |payload: &[u8], signature: &str| verify_minisign_signature(KEY, payload, signature);
        validate_artifact_integrity_with(OpClass::Engine, raw_url, Some(&integrity), verify)
            .unwrap();
        let normalized_signature_error = validate_artifact_integrity_with(
            OpClass::Engine,
            parsed_url.as_str(),
            Some(&integrity),
            verify,
        )
        .unwrap_err();
        assert_eq!(
            normalized_signature_error.to_string(),
            "Invalid input: artifact manifest signature verification failed",
            "the signature must authenticate raw locator text, not its parsed replacement"
        );

        let dir = tempdir().unwrap();
        let staging = private_tempdir_in(".archive", dir.path()).unwrap();
        let sentinel = staging.path().join("previous");
        std::fs::write(&sentinel, b"previous installation").unwrap();
        let payload = zip_payload();
        assert_ne!(
            format!("{:x}", Sha256::digest(&payload)),
            integrity.sha256.to_ascii_lowercase()
        );
        let transport = zip_response(payload);
        let redirect = "https://CDN.example.com:443/engine.zip";
        let mut redirect_headers = HeaderMap::new();
        redirect_headers.insert(
            reqwest::header::LOCATION,
            HeaderValue::from_static(redirect),
        );
        transport.responses.lock().unwrap().insert(
            0,
            Ok(DownloadResponse {
                status: 302,
                headers: redirect_headers,
                content_length: None,
                stream: Box::pin(futures_util::stream::empty()),
            }),
        );
        let error = download_file_core_control_with_integrity(
            OpClass::Engine,
            raw_url,
            staging.path(),
            Some(staging.path().to_path_buf()),
            &transport,
            None,
            None,
            CancellationToken::new(),
            Some(&integrity.sha256),
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        let requests = transport.requests_seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].0, parsed_url.as_str());
        assert_eq!(requests[1].0, parsed_url.join(redirect).unwrap().as_str());
        assert_eq!(
            error.to_string(),
            "Invalid input: artifact SHA-256 mismatch"
        );
        assert_eq!(std::fs::read(sentinel).unwrap(), b"previous installation");
        assert_eq!(leaves(staging.path()), vec!["previous"]);
        assert_eq!(
            leaves(dir.path()).len(),
            1,
            "temporary payload must be cleaned up"
        );
    }

    #[test]
    fn catalog_minisign_production_verifies_committed_engine_catalog() {
        let public_key_file = include_str!("../keys/release.minisign.pub");
        assert_eq!(
            release_public_key_line(RELEASE_MINISIGN_PUBLIC_KEY_FILE).unwrap(),
            public_key_file.lines().nth(1).unwrap()
        );
        let document = include_str!("../../src/catalogs/engines.json");
        let signature = include_str!("../../src/catalogs/engines.json.minisig");
        tauri::async_runtime::block_on(verify_signed_bytes(document.into(), signature.into()))
            .unwrap();
        assert!(tauri::async_runtime::block_on(verify_signed_bytes(
            format!("{document} "),
            signature.into(),
        ))
        .is_err());

        let entries: Vec<serde_json::Value> = serde_json::from_str(document).unwrap();
        assert!(!entries.is_empty());
        for entry in entries {
            let integrity = ArtifactIntegrity {
                sha256: entry["sha256"].as_str().unwrap().into(),
                signature: entry["signature"].as_str().unwrap().into(),
            };
            validate_artifact_integrity(
                OpClass::Engine,
                entry["downloadLink"].as_str().unwrap(),
                Some(&integrity),
            )
            .unwrap();
        }
    }

    #[test]
    fn catalog_minisign_production_verifies_committed_database_catalog() {
        let public_key_file = include_str!("../keys/release.minisign.pub");
        assert_eq!(
            release_public_key_line(RELEASE_MINISIGN_PUBLIC_KEY_FILE).unwrap(),
            public_key_file.lines().nth(1).unwrap()
        );
        let document = include_str!("../../src/catalogs/databases.json");
        let signature = include_str!("../../src/catalogs/databases.json.minisig");
        tauri::async_runtime::block_on(verify_signed_bytes(document.into(), signature.into()))
            .unwrap();
        assert!(tauri::async_runtime::block_on(verify_signed_bytes(
            format!("{document} "),
            signature.into(),
        ))
        .is_err());

        let entries: Vec<serde_json::Value> = serde_json::from_str(document).unwrap();
        assert!(!entries.is_empty());
        for entry in entries {
            let integrity = ArtifactIntegrity {
                sha256: entry["sha256"].as_str().unwrap().into(),
                signature: entry["signature"].as_str().unwrap().into(),
            };
            validate_artifact_integrity(
                OpClass::Db,
                entry["downloadLink"].as_str().unwrap(),
                Some(&integrity),
            )
            .unwrap();
        }
    }

    #[test]
    fn catalog_minisign_production_verifies_committed_puzzle_catalog() {
        let public_key_file = include_str!("../keys/release.minisign.pub");
        assert_eq!(
            release_public_key_line(RELEASE_MINISIGN_PUBLIC_KEY_FILE).unwrap(),
            public_key_file.lines().nth(1).unwrap()
        );
        let document = include_str!("../../src/catalogs/puzzles.json");
        let signature = include_str!("../../src/catalogs/puzzles.json.minisig");
        tauri::async_runtime::block_on(verify_signed_bytes(document.into(), signature.into()))
            .unwrap();
        assert!(tauri::async_runtime::block_on(verify_signed_bytes(
            format!("{document} "),
            signature.into(),
        ))
        .is_err());

        let entries: Vec<serde_json::Value> = serde_json::from_str(document).unwrap();
        assert!(!entries.is_empty());
        for entry in entries {
            let integrity = ArtifactIntegrity {
                sha256: entry["sha256"].as_str().unwrap().into(),
                signature: entry["signature"].as_str().unwrap().into(),
            };
            validate_artifact_integrity(
                OpClass::PuzzleDb,
                entry["downloadLink"].as_str().unwrap(),
                Some(&integrity),
            )
            .unwrap();
        }
    }

    #[test]
    fn catalog_minisign_invalid_key_is_a_typed_error() {
        for key_line in ["RWnot-base64", "", "RW"] {
            assert_eq!(
                verify_minisign_signature(
                    key_line,
                    FIXTURE_DOCUMENT.as_bytes(),
                    FIXTURE_DOCUMENT_SIGNATURE,
                )
                .unwrap_err()
                .to_string(),
                "Invalid input: artifact verification key is invalid"
            );
        }
        for file in ["", "untrusted comment: no key line\n"] {
            assert_eq!(
                release_public_key_line(file).unwrap_err().to_string(),
                "Invalid input: artifact verification key is invalid"
            );
        }
    }

    fn zip_response(bytes: Vec<u8>) -> MockTransport {
        MockTransport {
            responses: std::sync::Mutex::new(vec![Ok(DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: Some(bytes.len() as u64),
                stream: Box::pin(futures_util::stream::iter(vec![Ok(bytes::Bytes::from(
                    bytes,
                ))])),
            })]),
            requests_seen: std::sync::Mutex::new(vec![]),
        }
    }

    fn zip_payload() -> Vec<u8> {
        let archives = tempdir().unwrap();
        let path = archives.path().join("payload.zip");
        write_zip(&path, &[("engine.bin", b"engine")]);
        std::fs::read(path).unwrap()
    }

    fn gzip_tar_payload(content: &[u8]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_ustar();
        header.set_size(content.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        archive
            .append_data(&mut header, "stockfish/engine", content)
            .unwrap();
        archive.into_inner().unwrap().finish().unwrap()
    }

    fn raw_tar_payload() -> Vec<u8> {
        let mut payload = Vec::new();
        flate2::read::GzDecoder::new(gzip_tar_payload(b"engine").as_slice())
            .read_to_end(&mut payload)
            .unwrap();
        payload
    }

    #[tokio::test]
    async fn core_download_missing_parent_is_io_and_does_not_create_it() {
        let root = tempdir().unwrap();
        let parent = root.path().join("missing");
        let target = parent.join("installed");
        let transport = zip_response(zip_payload());
        let error = download_file_core(
            OpClass::Engine,
            "https://example.com/engine.zip",
            &target,
            Some(target.clone()),
            &transport,
            None,
            None,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(error, Error::Io(ref source) if source.kind() == std::io::ErrorKind::NotFound),
            "{error}"
        );
        assert!(!parent.exists());
        assert!(leaves(root.path()).is_empty());
        assert!(transport.requests_seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn core_download_refuses_plain_and_plain_gzip_without_leaves() {
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(b"plain gzip contents").unwrap();
        for payload in [b"plain contents".to_vec(), gzip.finish().unwrap()] {
            let parent = tempdir().unwrap();
            let target = parent.path().join("installed");
            let transport = zip_response(payload);
            let error = download_file_core(
                OpClass::Engine,
                "https://example.com/engine",
                &target,
                Some(target.clone()),
                &transport,
                None,
                None,
                |_| Ok(()),
            )
            .await
            .unwrap_err();
            assert!(matches!(error, Error::InvalidInput(_)), "{error}");
            assert_eq!(
                error.to_string(),
                "Invalid input: Download payload must be a zip, tar or tar.gz archive"
            );
            assert!(!target.exists());
            assert!(leaves(parent.path()).is_empty());
            assert_eq!(transport.requests_seen.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn core_download_preserves_non_archive_operation_refusal_precedence() {
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(b"plain gzip contents").unwrap();
        for payload in [zip_payload(), raw_tar_payload(), gzip.finish().unwrap()] {
            let parent = tempdir().unwrap();
            let target = parent.path().join("installed");
            let error = download_file_core(
                OpClass::Lichess,
                "https://lichess.org/export",
                &target,
                None,
                &zip_response(payload),
                None,
                None,
                |_| Ok(()),
            )
            .await
            .unwrap_err();
            assert_eq!(
                error.to_string(),
                "Invalid input: Archive payload is not allowed for this operation"
            );
            assert!(leaves(parent.path()).is_empty());
        }
    }

    struct ResetCoreHook(PathBuf);

    impl Drop for ResetCoreHook {
        fn drop(&mut self) {
            set_core_after_pin_hook(&self.0, None);
        }
    }

    #[cfg(windows)]
    fn is_windows_sharing_or_lock_violation(code: i32) -> bool {
        use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};
        code == ERROR_SHARING_VIOLATION as i32 || code == ERROR_LOCK_VIOLATION as i32
    }

    async fn assert_core_parent_swap_conflict(payload: Vec<u8>, member: &str) {
        let root = tempdir().unwrap();
        let parent = root.path().join("parent");
        let moved = root.path().join("moved");
        std::fs::create_dir(&parent).unwrap();
        let target = parent.join("installed");
        let _reset = ResetCoreHook(target.clone());
        let rename_result = Arc::new(Mutex::new(None));
        let hook_result = Arc::clone(&rename_result);
        let hook_moved = moved.clone();
        set_core_after_pin_hook(
            &target,
            Some(Box::new(move |path| {
                let parent = path.parent().unwrap();
                let result = std::fs::rename(parent, &hook_moved);
                if result.is_ok() {
                    std::fs::create_dir(parent).unwrap();
                }
                *hook_result.lock().unwrap() = Some(result);
            })),
        );
        let result = download_file_core(
            OpClass::Engine,
            "https://example.com/engine.archive",
            &target,
            Some(target.clone()),
            &zip_response(payload),
            None,
            None,
            |_| Ok(()),
        )
        .await;
        match rename_result
            .lock()
            .unwrap()
            .take()
            .expect("after-pin hook ran")
        {
            Ok(()) => {
                let error = result.unwrap_err();
                assert_eq!(
                    error.to_string(),
                    "Conflict: archive staging parent changed concurrently"
                );
                assert!(!error.to_string().contains('/'));
                assert!(!target.exists());
                assert!(!moved.join("installed").exists());
                assert!(leaves(&parent).is_empty());
                assert!(leaves(&moved).is_empty());
            }
            Err(error) => {
                let rename_refused = matches!(
                    error.kind(),
                    std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock
                );
                #[cfg(windows)]
                let rename_refused = rename_refused
                    || error
                        .raw_os_error()
                        .is_some_and(is_windows_sharing_or_lock_violation);
                assert!(
                    rename_refused,
                    "parent rename must be refused by the held handle: {error}"
                );
                result.unwrap();
                assert_eq!(std::fs::read(target.join(member)).unwrap(), b"engine");
                assert_eq!(leaves(&parent), vec!["installed"]);
                assert!(!moved.exists());
            }
        };
    }

    #[tokio::test]
    async fn core_zip_parent_swap_after_pin_is_conflict() {
        assert_core_parent_swap_conflict(zip_payload(), "engine.bin").await;
    }

    #[tokio::test]
    async fn core_tar_parent_swap_after_pin_is_conflict() {
        assert_core_parent_swap_conflict(raw_tar_payload(), "stockfish/engine").await;
    }

    #[tokio::test]
    async fn core_tar_gzip_parent_swap_after_pin_is_conflict() {
        assert_core_parent_swap_conflict(gzip_tar_payload(b"engine"), "stockfish/engine").await;
    }

    #[test]
    fn ustar_header_requires_full_block_magic_and_valid_octal_checksum() {
        let mut header = tar::Header::new_ustar();
        header.set_size(0);
        header.set_mode(0o600);
        header.set_cksum();
        let block = *header.as_bytes();
        assert!(is_ustar_header(&block));
        assert!(!is_ustar_header(&block[..TAR_BLOCK_SIZE - 1]));

        let checksum = header.cksum().unwrap();
        for terminators in [*b"\0 ", *b"  ", *b"\0\0", *b" \0"] {
            let mut variant = block;
            variant[TAR_CHECKSUM_FIELD.start..TAR_CHECKSUM_FIELD.end - 2]
                .copy_from_slice(format!("{checksum:06o}").as_bytes());
            variant[TAR_CHECKSUM_FIELD.end - 2..TAR_CHECKSUM_FIELD.end]
                .copy_from_slice(&terminators);
            assert!(is_ustar_header(&variant), "{terminators:?}");
        }
        let mut leading_space = block;
        leading_space[TAR_CHECKSUM_FIELD].copy_from_slice(format!("{checksum:7o}\0").as_bytes());
        assert!(is_ustar_header(&leading_space));

        for field in [
            *b"000000\0 ",
            *b"        ",
            *b"\0       ",
            *b"000008\0 ",
            *b"0\x000000\0 ",
            *b"000000x ",
        ] {
            let mut invalid = block;
            invalid[TAR_CHECKSUM_FIELD].copy_from_slice(&field);
            assert!(!is_ustar_header(&invalid), "{field:?}");
        }
        let mut wrong_checksum = block;
        wrong_checksum[0] ^= 1;
        assert!(!is_ustar_header(&wrong_checksum));
        header.as_mut_bytes()[USTAR_MAGIC_OFFSET] = b'x';
        header.set_cksum();
        assert!(!is_ustar_header(header.as_bytes()));
    }

    #[tokio::test]
    async fn raw_tar_download_requires_valid_header_checksum() {
        let mut payload = Vec::new();
        flate2::read::GzDecoder::new(gzip_tar_payload(b"engine").as_slice())
            .read_to_end(&mut payload)
            .unwrap();
        for valid_checksum in [true, false] {
            let dir = tempdir().unwrap();
            let target = dir.path().join("installed");
            let mut bytes = payload.clone();
            if !valid_checksum {
                bytes[TAR_CHECKSUM_FIELD].copy_from_slice(b"000000\0 ");
            }
            let result = download_file_core(
                OpClass::Engine,
                "https://example.com/engine.tar",
                &target,
                valid_checksum.then(|| target.clone()),
                &zip_response(bytes.clone()),
                None,
                None,
                |_| Ok(()),
            )
            .await;
            if valid_checksum {
                result.unwrap();
                assert_eq!(
                    std::fs::read(target.join("stockfish/engine")).unwrap(),
                    b"engine"
                );
            } else {
                let error = result.unwrap_err();
                assert_eq!(error.to_string(), archive_payload_required().to_string());
                assert!(!target.exists());
                assert!(leaves(dir.path()).is_empty());
            }
        }
    }

    #[tokio::test]
    async fn gzip_tar_download_installs_and_registers_nested_executable() {
        let dir = tempdir().unwrap();
        let (mut authority, _, engine_root, root) = engine_destination(&dir);
        let target = engine_root.join("stockfish.tar.gz");
        let bytes = gzip_tar_payload(b"#!/bin/sh\necho fixture\n");
        let integrity = unsigned_test_integrity(&bytes);
        download_file_core_control_with_integrity(
            OpClass::Engine,
            "https://example.com/stockfish.tar.gz",
            &target,
            Some(target.clone()),
            &zip_response(bytes),
            None,
            None,
            CancellationToken::new(),
            Some(&integrity.sha256),
            |_| Ok(()),
        )
        .await
        .unwrap();
        let handle = authority
            .register_installed_engine_for_test(&root, "stockfish.tar.gz/stockfish/engine")
            .unwrap();
        assert_eq!(
            std::fs::read(target.join("stockfish/engine")).unwrap(),
            b"#!/bin/sh\necho fixture\n"
        );
        let adopted = authority
            .register_installed_engine_for_test(&root, "stockfish.tar.gz/stockfish/engine")
            .unwrap();
        assert_eq!(handle, adopted);
    }

    #[test]
    fn gzip_tar_ratio_rejection() {
        let dir = tempdir().unwrap();
        let archive = dir.path().join("archive.gz");
        std::fs::write(&archive, gzip_tar_payload(&vec![0; 64 * 1024])).unwrap();
        let limits = ArchiveLimits {
            ratio: 2,
            ..OpClass::Engine.limits()
        };
        let target = dir.path().join("target");
        let error = extract_gz(std::fs::File::open(archive).unwrap(), &target, limits).unwrap_err();
        assert!(
            matches!(error, Error::ResourceLimit(ref message) if message == "High tar-in-gzip compression ratio detected"),
            "{error}"
        );
        assert!(!target.exists());
    }

    #[test]
    fn gzip_tar_expanded_size_rejection() {
        let dir = tempdir().unwrap();
        let archive = dir.path().join("archive.gz");
        std::fs::write(&archive, gzip_tar_payload(&vec![0; 512])).unwrap();
        let limits = ArchiveLimits {
            expanded: 1024,
            ratio: u64::MAX,
            ..OpClass::Engine.limits()
        };
        let target = dir.path().join("target");
        let error = extract_gz(std::fs::File::open(archive).unwrap(), &target, limits).unwrap_err();
        assert!(
            matches!(error, Error::ResourceLimit(ref message) if message == "Tar-in-gzip expansion limit exceeded"),
            "{error}"
        );
        assert!(!target.exists());
    }

    #[test]
    fn single_file_gzip_is_refused() {
        let dir = tempdir().unwrap();
        let archive = dir.path().join("archive.gz");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(b"single engine payload").unwrap();
        std::fs::write(&archive, encoder.finish().unwrap()).unwrap();
        let target = dir.path().join("engine");
        let error = extract_gz(
            std::fs::File::open(archive).unwrap(),
            &target,
            OpClass::Engine.limits(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), archive_payload_required().to_string());
        assert!(!target.exists());
        assert_eq!(leaves(dir.path()), vec!["archive.gz"]);
    }

    #[test]
    fn single_file_gzip_with_ustar_magic_and_wrong_checksum_is_refused() {
        let dir = tempdir().unwrap();
        let archive = dir.path().join("archive.gz");
        let mut payload = [b'x'; 512];
        payload[257..262].copy_from_slice(b"ustar");
        payload[148..156].copy_from_slice(b"000000\0 ");
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&payload).unwrap();
        std::fs::write(&archive, encoder.finish().unwrap()).unwrap();
        let target = dir.path().join("engine");
        let error = extract_gz(
            std::fs::File::open(archive).unwrap(),
            &target,
            OpClass::Engine.limits(),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), archive_payload_required().to_string());
        assert!(!target.exists());
        assert_eq!(leaves(dir.path()), vec!["archive.gz"]);
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn catalog_install_publication_confirmation_actual_core_rejects_retry_and_reopen() {
        use crate::infra::fs::{
            set_test_atomic_dir_injector, AtomicDirFaultPoint, AtomicDirInjector,
        };
        type Swap = Box<dyn FnOnce() -> std::io::Result<()>>;
        struct FinalSwap(std::cell::RefCell<Option<Swap>>);
        impl AtomicDirInjector for FinalSwap {
            fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
                if point == AtomicDirFaultPoint::InstallRename {
                    if let Some(swap) = self.0.borrow_mut().take() {
                        return swap();
                    }
                }
                Ok(())
            }
        }
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, root) = engine_destination(&dir);
        let payload = zip_payload();
        let integrity = unsigned_test_integrity(&payload);
        let state = AppState {
            http_transport: Arc::new(zip_response(payload)),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let target = engine_root.join("managed");
        let moved = engine_root.join("moved-original");
        let registry_path = dir.path().join("path-authority.json");
        let pending_before_syscall = Arc::new(Mutex::new(None));
        let snapshot = pending_before_syscall.clone();
        let moved_at_hook = moved.clone();
        let registry_at_hook = registry_path.clone();
        set_core_after_pin_hook(
            &target,
            Some(Box::new(move |_| {
                set_archive_pre_install_hook(Some(Box::new(move |parent| {
                    let source = std::fs::read_dir(parent)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| {
                            path.is_dir()
                                && path
                                    .file_name()
                                    .unwrap()
                                    .to_string_lossy()
                                    .starts_with(".archive")
                        })
                        .expect("actual prepared ZIP owner");
                    set_test_atomic_dir_injector(Some(Box::new(FinalSwap(
                        std::cell::RefCell::new(Some(Box::new(move || {
                            *snapshot.lock().unwrap() = Some(std::fs::read(&registry_at_hook)?);
                            std::fs::rename(&source, &moved_at_hook)?;
                            std::fs::create_dir(&source)?;
                            std::fs::write(source.join("engine.bin"), b"unverified substitute")?;
                            Ok(())
                        }))),
                    ))));
                })));
            })),
        );
        for attempt in 0..3 {
            let (job, lease) = test_download_lease(&state);
            let result = download_engine_archive_core(
                begin_progress(
                    &state.progress_state,
                    &app.handle().clone(),
                    format!("confirmation-{attempt}"),
                )
                .unwrap(),
                "https://example.com/engine.zip".into(),
                destination.clone(),
                "managed".into(),
                job,
                integrity.clone(),
                app.handle().clone(),
                state.clone(),
                lease.token(),
                lease.commit_gate(),
                Box::new(accept_any_integrity),
            )
            .await;
            assert!(matches!(result, Err(Error::Conflict(_))),
                "PENDING_ADOPTION_FENCE: actual producer/retry/reopen must refuse the unverified tree at attempt {attempt}: {result:?}");
            assert_eq!(
                std::fs::read(target.join("engine.bin")).unwrap(),
                b"unverified substitute"
            );
            assert_eq!(std::fs::read(moved.join("engine.bin")).unwrap(), b"engine");
            assert!(
                matches!(
                    state
                        .pgn_path_authority
                        .with_mut(|authority| authority
                            .register_installed_engine_for_test(&root, "managed/engine.bin"))
                        .unwrap(),
                    Err(Error::Conflict(_))
                ),
                "pending catalog tree must not mint a substitute executable handle for probing"
            );
            if attempt == 0 {
                assert_eq!(std::fs::read(&registry_path).unwrap(),
                    *pending_before_syscall.lock().unwrap().as_ref().expect("durable evidence before syscall"),
                    "reopen must consume the exact pending evidence durable before native rejection");
            }
            if attempt == 1 {
                let mut reopened = test_path_authority(&dir);
                reopened
                    .reconcile_startup_owners(crate::infra::path_authority::StartupPathOwners {
                        retained_ids: vec![root.id.clone()],
                        trusted_families: vec![
                            crate::infra::path_authority::PathOwnerFamily::Engines,
                        ],
                    })
                    .unwrap();
                reopened.collect_catalog_installs().unwrap();
                *state.pgn_path_authority.raw_for_test().lock().unwrap() = Some(reopened);
            }
        }
    }

    struct HeldArchiveTransport {
        started: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Semaphore>,
        payload: Vec<u8>,
        network_failure: bool,
    }

    #[async_trait::async_trait]
    impl DownloadTransport for HeldArchiveTransport {
        async fn request(
            &self,
            _url: &str,
            _headers: HeaderMap,
        ) -> Result<DownloadResponse, Error> {
            let started = self.started.clone();
            let release = self.release.clone();
            let payload = self.payload.clone();
            let network_failure = self.network_failure;
            Ok(DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: Some(payload.len() as u64),
                stream: Box::pin(futures_util::stream::once(async move {
                    let _ = started.send(());
                    release.acquire_owned().await.unwrap().forget();
                    if network_failure {
                        Err(Error::Io(Box::new(std::io::Error::from(
                            std::io::ErrorKind::ConnectionReset,
                        ))))
                    } else {
                        Ok(bytes::Bytes::from(payload))
                    }
                })),
            })
        }
    }

    struct ReleaseArchiveStreams(Arc<tokio::sync::Semaphore>);

    impl Drop for ReleaseArchiveStreams {
        fn drop(&mut self) {
            self.0.add_permits(4);
        }
    }

    fn spawn_accepted_archive(
        state: AppState,
        destination: crate::infra::path_authority::PathRef,
        app: tauri::AppHandle<tauri::test::MockRuntime>,
        progress: &str,
        name: &str,
        integrity: ArtifactIntegrity,
    ) -> (
        tokio::task::JoinHandle<Result<(), Error>>,
        CancellationToken,
    ) {
        let job = state.operations.prepare_download("test").unwrap();
        let lease = state
            .operations
            .claim_download(
                &job,
                "test",
                "archive staging test",
                progress,
                progress,
                false,
                MAX_ACTIVE_DOWNLOADS,
            )
            .unwrap();
        let cancellation = lease.token();
        let commit_gate = lease.commit_gate();
        let workflow = download_engine_archive_core(
            begin_progress(&state.progress_state, &app, progress.into()).unwrap(),
            "https://example.com/engine.zip".into(),
            destination,
            name.into(),
            job,
            integrity,
            app,
            state,
            cancellation.clone(),
            commit_gate,
            Box::new(accept_any_integrity),
        );
        (
            tokio::spawn(crate::infra::operations::run_native_operation(
                lease,
                "archive staging test",
                workflow,
            )),
            cancellation,
        )
    }

    #[tokio::test]
    async fn archive_staging_authority_four_stalled_streams_leave_gateway_available() {
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, _) = engine_destination(&dir);
        let payload = zip_payload();
        let integrity = unsigned_test_integrity(&payload);
        let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let release_guard = ReleaseArchiveStreams(release.clone());
        let state = AppState {
            http_transport: Arc::new(HeldArchiveTransport {
                started,
                release: release.clone(),
                payload,
                network_failure: false,
            }),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let mut commands = Vec::new();
        for index in 0..4 {
            let name = format!("engine-{index}");
            commands.push(
                spawn_accepted_archive(
                    state.clone(),
                    destination.clone(),
                    app.handle().clone(),
                    &name,
                    &name,
                    integrity.clone(),
                )
                .0,
            );
        }
        for _ in 0..4 {
            tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
                .await
                .unwrap()
                .unwrap();
        }
        let probe_path = dir.path().join("unrelated-file");
        std::fs::write(&probe_path, b"gateway probe").unwrap();
        // Completion before stream release is the invariant, not a latency promise.
        // Ten seconds is only a bounded safety ceiling for the shared gateway.
        let probe = tokio::time::timeout(
            Duration::from_secs(10),
            crate::infra::blocking::BLOCKING_GATEWAY.spawn(move || Ok(std::fs::read(probe_path)?)),
        )
        .await;
        // Release and drain even for the deliberately restored waiting-worker red proof.
        drop(release_guard);
        for command in commands {
            tokio::time::timeout(Duration::from_secs(5), command)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
        assert!(matches!(&probe, Ok(Ok(bytes)) if bytes == b"gateway probe"),
            "ARCHIVE_STREAM_GATEWAY_AVAILABLE: unrelated filesystem work must finish before releasing four archive streams: {probe:?}");
        assert!(state.operations.wait_for_drain(Duration::ZERO).unwrap());
        for index in 0..4 {
            let name = format!("engine-{index}");
            assert_eq!(
                std::fs::read(engine_root.join(&name).join("engine.bin")).unwrap(),
                b"engine"
            );
            assert_eq!(
                state.progress_state.get(&name).unwrap().unwrap().state,
                ProgressState::Running
            );
        }
    }

    #[tokio::test]
    async fn archive_staging_authority_command_awaiter_drop_keeps_success_and_failure_tails() {
        for failure in ["none", "network", "publication"] {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let payload = zip_payload();
            let integrity = unsigned_test_integrity(&payload);
            let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
            let release = Arc::new(tokio::sync::Semaphore::new(0));
            let release_guard = ReleaseArchiveStreams(release.clone());
            let state = AppState {
                http_transport: Arc::new(HeldArchiveTransport {
                    started,
                    release,
                    payload,
                    network_failure: failure == "network",
                }),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let cleaned = Arc::new(AtomicBool::new(false));
            let cleanup_observed = cleaned.clone();
            ARCHIVE_PAYLOAD_CLEANUP_HOOKS.lock().unwrap().insert(
                engine_root.join("installed"),
                Box::new(move |_| {
                    cleanup_observed.store(true, Ordering::SeqCst);
                }),
            );
            let app = test_progress_app();
            let (command, _) = spawn_accepted_archive(
                state.clone(),
                destination,
                app.handle().clone(),
                "archive-caller-drop",
                "installed",
                integrity,
            );
            tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
                .await
                .unwrap()
                .unwrap();
            command.abort();
            assert!(command.await.unwrap_err().is_cancelled());
            assert!(!state.operations.wait_for_drain(Duration::ZERO).unwrap());
            if failure == "publication" {
                state.pgn_path_authority.uninstall();
            }
            drop(release_guard);
            tokio::time::timeout(Duration::from_secs(5), async {
                while !state.operations.wait_for_drain(Duration::ZERO).unwrap() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert!(
                cleaned.load(Ordering::SeqCst),
                "accepted archive must complete terminal cleanup after caller drop"
            );
            let item = state
                .progress_state
                .get("archive-caller-drop")
                .unwrap()
                .unwrap();
            if failure == "none" {
                assert!(
                    !item.finished,
                    "archive success still awaits workflow application"
                );
                assert_eq!(item.state, ProgressState::Running);
                assert_eq!(
                    std::fs::read(engine_root.join("installed/engine.bin")).unwrap(),
                    b"engine"
                );
                assert_eq!(leaves(&engine_root), vec!["installed"]);
            } else {
                assert!(item.finished);
                assert_eq!(item.state, ProgressState::Failed);
                assert!(leaves(&engine_root).is_empty());
            }
        }
    }

    #[tokio::test]
    async fn archive_staging_authority_payload_creation_failure_preserves_io_and_failed_progress() {
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, _) = engine_destination(&dir);
        let payload = zip_payload();
        let integrity = unsigned_test_integrity(&payload);
        let transport = Arc::new(zip_response(payload));
        let state = AppState {
            http_transport: transport.clone(),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        ARCHIVE_PAYLOAD_CREATE_FAULTS.lock().unwrap().insert(
            engine_root.join("installed"),
            Error::Io(Box::new(std::io::Error::from(
                std::io::ErrorKind::PermissionDenied,
            ))),
        );
        let app = test_progress_app();
        let (command, _) = spawn_accepted_archive(
            state.clone(),
            destination,
            app.handle().clone(),
            "archive-setup-failure",
            "installed",
            integrity,
        );
        let error = command.await.unwrap().unwrap_err();
        assert!(matches!(&error, Error::Io(error) if error.kind() == std::io::ErrorKind::PermissionDenied),
            "ARCHIVE_SETUP_TYPED_IO: anonymous payload setup must preserve its typed failure: {error:?}");
        assert!(transport.requests_seen.lock().unwrap().is_empty());
        assert!(leaves(&engine_root).is_empty());
        let item = state
            .progress_state
            .get("archive-setup-failure")
            .unwrap()
            .unwrap();
        assert_eq!(item.state, ProgressState::Failed);
        assert!(item.finished);
        assert!(state.operations.wait_for_drain(Duration::ZERO).unwrap());
    }

    struct ArchivePayloadTestState {
        active: bool,
        #[cfg(target_os = "linux")]
        observer: Option<std::fs::File>,
    }

    /// One test owns its keyed callbacks and independent payload description on every exit.
    struct ArchivePayloadTestOwner {
        target: PathBuf,
        state: Arc<Mutex<ArchivePayloadTestState>>,
    }

    impl ArchivePayloadTestOwner {
        fn new(target: PathBuf) -> Self {
            Self {
                target,
                state: Arc::new(Mutex::new(ArchivePayloadTestState {
                    active: true,
                    #[cfg(target_os = "linux")]
                    observer: None,
                })),
            }
        }

        fn on_created(&self, observe: impl FnOnce() + Send + 'static) {
            #[cfg(target_os = "linux")]
            let state = self.state.clone();
            ARCHIVE_PAYLOAD_CREATED_HOOKS.lock().unwrap().insert(
                self.target.clone(),
                Box::new(move |_file| {
                    observe();
                    #[cfg(target_os = "linux")]
                    {
                        let mut state = state.lock().unwrap();
                        if !state.active {
                            return;
                        }
                        use crate::infra::fs::{
                            lock_advisory_file, AdvisoryLockError, AdvisoryLockMode,
                        };
                        use std::os::fd::AsRawFd;

                        lock_advisory_file(_file, AdvisoryLockMode::NonBlocking).unwrap();
                        // Reopen only while the original is live. A clone would share its lock.
                        let observer = std::fs::File::options()
                            .read(true)
                            .write(true)
                            .open(format!("/proc/self/fd/{}", _file.as_raw_fd()))
                            .unwrap();
                        assert_eq!(
                            crate::infra::path_authority::opened_file_identity(&observer).unwrap(),
                            crate::infra::path_authority::opened_file_identity(_file).unwrap(),
                            "observer must bind to the live actual payload"
                        );
                        let contention =
                            lock_advisory_file(&observer, AdvisoryLockMode::NonBlocking);
                        assert!(
                            matches!(contention, Err(AdvisoryLockError::HeldElsewhere(_))),
                            "independent live payload observer must contend: {contention:?}"
                        );
                        assert!(state.observer.replace(observer).is_none());
                    }
                }),
            );
        }
    }

    impl Drop for ArchivePayloadTestOwner {
        fn drop(&mut self) {
            // Recover poisoned test state without a second panic during assertion unwinding.
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.active = false;
            #[cfg(target_os = "linux")]
            drop(state.observer.take());
            drop(state);
            let created = ARCHIVE_PAYLOAD_CREATED_HOOKS
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.target);
            let network = ARCHIVE_PAYLOAD_NETWORK_DONE_HOOKS
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.target);
            let cleanup = ARCHIVE_PAYLOAD_CLEANUP_HOOKS
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.target);
            // Drop captures outside the registries, just as dispatch invokes them outside locks.
            drop((created, network, cleanup));
        }
    }

    /// Waits for the prior holder to release, then acquires the exclusive lock for `file`.
    /// The lock remains with its open file description until unlocked or the last handle closes.
    #[cfg(target_os = "linux")]
    fn assert_archive_payload_description_released(file: &std::fs::File, message: &str) {
        use crate::infra::fs::{
            lock_advisory_file, retry_until_lock_released, AdvisoryLockError, AdvisoryLockMode,
        };

        retry_until_lock_released(|| {
            match lock_advisory_file(file, AdvisoryLockMode::NonBlocking) {
                Ok(()) => Some(Ok(())),
                Err(AdvisoryLockError::HeldElsewhere(_)) => None,
                Err(AdvisoryLockError::Io(error)) => Some(Err(error)),
            }
        })
        .unwrap_or_else(|| panic!("{message}"))
        .unwrap_or_else(|error| panic!("payload release observation I/O failure: {error}"));
    }

    #[cfg(target_os = "linux")]
    fn assert_archive_payload_owner_teardown(exit: &str) {
        use crate::infra::fs::{lock_advisory_file, AdvisoryLockError, AdvisoryLockMode};
        use std::os::fd::AsRawFd;

        let dir = tempdir().unwrap();
        let target = dir.path().join("payload-owner");
        let original = tempfile::tempfile().unwrap();
        let owner = ArchivePayloadTestOwner::new(target.clone());
        owner.on_created(|| {});
        run_archive_payload_created_hook(&target, &original);
        let state = owner.state.clone();
        let checker = {
            let state = state.lock().unwrap();
            let observer = state.observer.as_ref().unwrap();
            std::fs::File::options()
                .read(true)
                .write(true)
                .open(format!("/proc/self/fd/{}", observer.as_raw_fd()))
                .unwrap()
        };
        drop(original);
        {
            let state = state.lock().unwrap();
            assert_archive_payload_description_released(
                state.observer.as_ref().unwrap(),
                "teardown setup original release",
            );
        }
        assert!(matches!(
            lock_advisory_file(&checker, AdvisoryLockMode::NonBlocking),
            Err(AdvisoryLockError::HeldElsewhere(_))
        ));
        let callbacks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let created = callbacks.clone();
        ARCHIVE_PAYLOAD_CREATED_HOOKS.lock().unwrap().insert(
            target.clone(),
            Box::new(move |_| {
                created.fetch_add(1, Ordering::SeqCst);
            }),
        );
        for hooks in [
            &ARCHIVE_PAYLOAD_NETWORK_DONE_HOOKS,
            &ARCHIVE_PAYLOAD_CLEANUP_HOOKS,
        ] {
            let callbacks = callbacks.clone();
            hooks.lock().unwrap().insert(
                target.clone(),
                Box::new(move |_| {
                    callbacks.fetch_add(1, Ordering::SeqCst);
                }),
            );
        }
        let body = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _owner = owner;
            match exit {
                "normal" => Ok(()),
                "error" => Err("deliberate early body error"),
                "unwind" => panic!("deliberate body unwind"),
                _ => unreachable!(),
            }
        }));
        match exit {
            "normal" => assert_eq!(body.unwrap(), Ok(())),
            "error" => assert_eq!(body.unwrap(), Err("deliberate early body error")),
            "unwind" => assert!(body.is_err()),
            _ => unreachable!(),
        }
        // These observations are outside the deliberately failing body. Keep state alive so
        // a missing explicit disposal cannot accidentally pass through the last Arc dropping.
        assert_archive_payload_description_released(
            &checker,
            "post-exit observer description must be released",
        );
        run_archive_payload_created_hook(&target, &checker);
        run_path_hook(&ARCHIVE_PAYLOAD_NETWORK_DONE_HOOKS, &target);
        run_path_hook(&ARCHIVE_PAYLOAD_CLEANUP_HOOKS, &target);
        assert_eq!(
            callbacks.load(Ordering::SeqCst),
            0,
            "post-exit pending callbacks must not execute"
        );
        drop(state);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn archive_staging_authority_observer_teardown_normal() {
        assert_archive_payload_owner_teardown("normal");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn archive_staging_authority_observer_teardown_error() {
        assert_archive_payload_owner_teardown("error");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn archive_staging_authority_observer_teardown_unwind() {
        assert_archive_payload_owner_teardown("unwind");
    }

    async fn assert_archive_terminal_cleanup_waits_for_admission(network_failure: bool) {
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, _) = engine_destination(&dir);
        let payload = zip_payload();
        let integrity = unsigned_test_integrity(&payload);
        let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let release = Arc::new(tokio::sync::Semaphore::new(0));
        let release_guard = ReleaseArchiveStreams(release.clone());
        let state = AppState {
            http_transport: Arc::new(HeldArchiveTransport {
                started,
                release,
                payload,
                network_failure,
            }),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let target = engine_root.join("installed");
        let runtime_thread = std::thread::current().id();
        let payload_owner = ArchivePayloadTestOwner::new(target.clone());
        let created = Arc::new(AtomicBool::new(false));
        let creation_observed = created.clone();
        payload_owner.on_created(move || {
            assert_ne!(
                std::thread::current().id(),
                runtime_thread,
                "payload creation must leave the runtime worker"
            );
            creation_observed.store(true, Ordering::SeqCst);
        });
        let (network_done_tx, network_done_rx) = tokio::sync::oneshot::channel();
        ARCHIVE_PAYLOAD_NETWORK_DONE_HOOKS.lock().unwrap().insert(
            target.clone(),
            Box::new(move |_| {
                let _ = network_done_tx.send(());
            }),
        );
        let cleaned = Arc::new(AtomicBool::new(false));
        let cleanup_observed = cleaned.clone();
        let (cleanup_entered_tx, cleanup_entered_rx) = tokio::sync::oneshot::channel();
        let (cleanup_release_tx, cleanup_release_rx) = std::sync::mpsc::channel();
        let mut cleanup_guard = ExtractionTestGuard {
            release: Some(cleanup_release_tx),
        };
        #[cfg(target_os = "linux")]
        let cleanup_observer = payload_owner.state.clone();
        ARCHIVE_PAYLOAD_CLEANUP_HOOKS.lock().unwrap().insert(
            target,
            Box::new(move |_| {
                assert_ne!(
                    std::thread::current().id(),
                    runtime_thread,
                    "terminal payload cleanup must leave the runtime worker"
                );
                #[cfg(target_os = "linux")]
                {
                    let observer = cleanup_observer.lock().unwrap().observer.take().unwrap();
                    assert_archive_payload_description_released(
                        &observer,
                        "terminal cleanup must release the original payload description",
                    );
                    // Acquisition proves original-description release, not physical inode destruction.
                    drop(observer);
                }
                cleanup_observed.store(true, Ordering::SeqCst);
                let _ = cleanup_entered_tx.send(());
                cleanup_release_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("terminal cleanup release");
            }),
        );
        let app = test_progress_app();
        let (mut command, cancellation) = spawn_accepted_archive(
            state.clone(),
            destination,
            app.handle().clone(),
            "archive-terminal",
            "installed",
            integrity,
        );
        tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(created.load(Ordering::SeqCst));
        // Occupy all shared permits only after setup and network entry. Each guard releases
        // its worker on every test exit, including a failed assertion.
        let mut holders = Vec::new();
        let mut holder_guards = Vec::new();
        for _ in 0..4 {
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            holder_guards.push(ExtractionTestGuard {
                release: Some(release_tx),
            });
            holders.push(tokio::spawn(
                crate::infra::blocking::BLOCKING_GATEWAY.spawn(move || {
                    let _ = entered_tx.send(());
                    let _ = release_rx.recv_timeout(Duration::from_secs(5));
                    Ok(())
                }),
            ));
            tokio::time::timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap();
        }
        if !network_failure {
            cancellation.cancel();
        }
        drop(release_guard);
        tokio::time::timeout(Duration::from_secs(5), network_done_rx)
            .await
            .unwrap()
            .unwrap();
        // A captured network failure must still win a later cancellation at admission.
        cancellation.cancel();
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut command)
                .await
                .is_err(),
            "terminal admission must not skip payload cleanup after cancellation"
        );
        assert!(!cleaned.load(Ordering::SeqCst));
        assert!(
            !state.operations.wait_for_drain(Duration::ZERO).unwrap(),
            "accepted lease must retain queued terminal cleanup"
        );
        assert_eq!(
            state
                .progress_state
                .get("archive-terminal")
                .unwrap()
                .unwrap()
                .state,
            ProgressState::Running
        );
        #[cfg(target_os = "linux")]
        {
            use crate::infra::fs::{lock_advisory_file, AdvisoryLockError, AdvisoryLockMode};
            let state = payload_owner.state.lock().unwrap();
            let contention = lock_advisory_file(
                state.observer.as_ref().unwrap(),
                AdvisoryLockMode::NonBlocking,
            );
            assert!(
                matches!(contention, Err(AdvisoryLockError::HeldElsewhere(_))),
                "queued cleanup must retain the original payload description: {contention:?}"
            );
        }
        drop(holder_guards);
        tokio::time::timeout(Duration::from_secs(5), cleanup_entered_rx)
            .await
            .unwrap()
            .unwrap();
        assert!(cleaned.load(Ordering::SeqCst));
        assert!(
            !state.operations.wait_for_drain(Duration::ZERO).unwrap(),
            "lease must await terminal worker exit"
        );
        assert!(
            leaves(&engine_root).is_empty(),
            "cancelled or failed payload must not reach extraction/publication"
        );
        cleanup_guard.release();
        let error = tokio::time::timeout(Duration::from_secs(5), command)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        if network_failure {
            assert!(
                matches!(&error, Error::Io(error) if error.kind() == std::io::ErrorKind::ConnectionReset),
                "terminal cleanup must preserve original network failure: {error:?}"
            );
        } else {
            assert!(matches!(error, Error::Cancellation), "{error:?}");
        }
        let item = state
            .progress_state
            .get("archive-terminal")
            .unwrap()
            .unwrap();
        assert_eq!(
            item.state,
            if network_failure {
                ProgressState::Failed
            } else {
                ProgressState::Cancelled
            }
        );
        assert!(item.finished);
        assert!(state.operations.wait_for_drain(Duration::ZERO).unwrap());
        assert!(leaves(&engine_root).is_empty());
        for holder in holders {
            holder.await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn archive_staging_authority_cancelled_payload_waits_for_terminal_cleanup_and_lease() {
        assert_archive_terminal_cleanup_waits_for_admission(false).await;
    }

    #[tokio::test]
    async fn archive_staging_authority_network_failure_uses_terminal_cleanup_before_lease_release()
    {
        assert_archive_terminal_cleanup_waits_for_admission(true).await;
    }

    /// Retains native observation of child changes, including scratch removed before inspection.
    /// Self renames are excluded so moving the watched replacement into place is not a write.
    struct ArchiveWriteObserver {
        #[cfg(target_os = "linux")]
        inotify: std::fs::File,
        #[cfg(target_os = "macos")]
        queue: std::fs::File,
        #[cfg(target_os = "macos")]
        _directory: std::fs::File,
        // This notification handle must use FindCloseChangeNotification, not CloseHandle.
        // Its integer representation also lets the hook share the owned observer across workers.
        #[cfg(windows)]
        notification: isize,
    }

    impl ArchiveWriteObserver {
        #[cfg(target_os = "linux")]
        fn new(path: &Path) -> Self {
            use std::os::{fd::FromRawFd, unix::ffi::OsStrExt};
            let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
            assert!(
                fd >= 0,
                "inotify_init1: {}",
                std::io::Error::last_os_error()
            );
            let file = unsafe { std::fs::File::from_raw_fd(fd) };
            let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            let watch = unsafe {
                libc::inotify_add_watch(
                    fd,
                    path.as_ptr(),
                    libc::IN_CREATE
                        | libc::IN_MODIFY
                        | libc::IN_CLOSE_WRITE
                        | libc::IN_MOVED_TO
                        | libc::IN_DELETE,
                )
            };
            assert!(
                watch >= 0,
                "inotify_add_watch: {}",
                std::io::Error::last_os_error()
            );
            Self { inotify: file }
        }

        #[cfg(target_os = "macos")]
        fn new(path: &Path) -> Self {
            use std::os::{
                fd::{AsRawFd, FromRawFd},
                unix::ffi::OsStrExt,
            };
            let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            let fd = unsafe { libc::open(path.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC) };
            assert!(fd >= 0, "vnode open: {}", std::io::Error::last_os_error());
            let directory = unsafe { std::fs::File::from_raw_fd(fd) };
            let fd = unsafe { libc::kqueue() };
            assert!(fd >= 0, "kqueue: {}", std::io::Error::last_os_error());
            let queue = unsafe { std::fs::File::from_raw_fd(fd) };
            assert_eq!(
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
                0
            );
            let change = libc::kevent {
                ident: directory.as_raw_fd() as _,
                filter: libc::EVFILT_VNODE,
                flags: libc::EV_ADD | libc::EV_CLEAR,
                fflags: libc::NOTE_WRITE,
                data: 0,
                udata: std::ptr::null_mut(),
            };
            let result =
                unsafe { libc::kevent(fd, &change, 1, std::ptr::null_mut(), 0, std::ptr::null()) };
            assert_eq!(
                result,
                0,
                "vnode registration: {}",
                std::io::Error::last_os_error()
            );
            Self {
                queue,
                _directory: directory,
            }
        }

        #[cfg(windows)]
        fn new(path: &Path) -> Self {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::{
                Foundation::INVALID_HANDLE_VALUE,
                Storage::FileSystem::{
                    FindFirstChangeNotificationW, FILE_NOTIFY_CHANGE_DIR_NAME,
                    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
                    FILE_NOTIFY_CHANGE_SIZE,
                },
            };
            let path: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let handle = unsafe {
                FindFirstChangeNotificationW(
                    path.as_ptr(),
                    0,
                    FILE_NOTIFY_CHANGE_FILE_NAME
                        | FILE_NOTIFY_CHANGE_DIR_NAME
                        | FILE_NOTIFY_CHANGE_SIZE
                        | FILE_NOTIFY_CHANGE_LAST_WRITE,
                )
            };
            assert_ne!(
                handle,
                INVALID_HANDLE_VALUE,
                "directory notification: {}",
                std::io::Error::last_os_error()
            );
            Self {
                notification: handle as isize,
            }
        }

        #[cfg(target_os = "linux")]
        fn saw_writes(&self, timeout: Duration) -> bool {
            use std::os::fd::AsRawFd;
            let mut poll = libc::pollfd {
                fd: self.inotify.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let result =
                unsafe { libc::poll(&mut poll, 1, timeout.as_millis().try_into().unwrap()) };
            assert!(
                result >= 0,
                "inotify poll: {}",
                std::io::Error::last_os_error()
            );
            if result == 0 {
                return false;
            }
            let mut events = [0u8; 8192];
            let count = (&self.inotify).read(&mut events).unwrap();
            assert!(count > 0, "inotify must return the signalled child events");
            true
        }

        #[cfg(target_os = "macos")]
        fn saw_writes(&self, timeout: Duration) -> bool {
            use std::os::fd::AsRawFd;
            let timeout = libc::timespec {
                tv_sec: timeout.as_secs().try_into().unwrap(),
                tv_nsec: timeout.subsec_nanos().into(),
            };
            let mut event: libc::kevent = unsafe { std::mem::zeroed() };
            let count = unsafe {
                libc::kevent(
                    self.queue.as_raw_fd(),
                    std::ptr::null(),
                    0,
                    &mut event,
                    1,
                    &timeout,
                )
            };
            assert!(
                count >= 0,
                "vnode observation: {}",
                std::io::Error::last_os_error()
            );
            if count == 0 {
                return false;
            }
            let event_error = event.data;
            assert_eq!(
                event.flags & libc::EV_ERROR,
                0,
                "vnode event error: {}",
                event_error
            );
            assert_ne!(event.fflags & libc::NOTE_WRITE, 0);
            true
        }

        #[cfg(windows)]
        fn saw_writes(&self, timeout: Duration) -> bool {
            use windows_sys::Win32::{
                Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
                System::Threading::WaitForSingleObject,
            };
            match unsafe {
                WaitForSingleObject(
                    self.notification as HANDLE,
                    timeout.as_millis().try_into().unwrap(),
                )
            } {
                WAIT_OBJECT_0 => true,
                WAIT_TIMEOUT => false,
                result => panic!(
                    "directory observation failed: {result}, {}",
                    std::io::Error::last_os_error()
                ),
            }
        }

        fn assert_no_writes(&self) {
            assert!(
                !self.saw_writes(Duration::ZERO),
                "replacement root received temporary writes"
            );
        }
    }

    #[cfg(windows)]
    impl Drop for ArchiveWriteObserver {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::Storage::FileSystem::FindCloseChangeNotification(
                    self.notification as windows_sys::Win32::Foundation::HANDLE,
                );
            }
        }
    }

    #[test]
    fn archive_staging_authority_observer_detects_anonymous_scratch_write_and_drop() {
        let dir = tempdir().unwrap();
        let watched = dir.path().canonicalize().unwrap().join("replacement");
        std::fs::create_dir(&watched).unwrap();
        let observer = ArchiveWriteObserver::new(&watched);
        observer.assert_no_writes();
        let moved = watched.with_file_name("engine-root");
        std::fs::rename(&watched, &moved).unwrap();
        observer.assert_no_writes();
        let mut scratch = tempfile::tempfile_in(&moved).unwrap();
        scratch.write_all(b"transient anonymous payload").unwrap();
        scratch.sync_all().unwrap();
        drop(scratch);
        assert!(leaves(&moved).is_empty());
        assert!(
            observer.saw_writes(Duration::from_secs(5)),
            "native observer missed actual tempfile_in write/drop"
        );
    }

    #[test]
    fn archive_staging_authority_observer_detects_named_directory_create_and_drop() {
        let dir = tempdir().unwrap();
        let watched = dir.path().canonicalize().unwrap().join("replacement");
        std::fs::create_dir(&watched).unwrap();
        let observer = ArchiveWriteObserver::new(&watched);
        observer.assert_no_writes();
        let moved = watched.with_file_name("engine-root");
        std::fs::rename(&watched, &moved).unwrap();
        observer.assert_no_writes();
        drop(tempfile::tempdir_in(&moved).unwrap());
        assert!(leaves(&moved).is_empty());
        assert!(
            observer.saw_writes(Duration::from_secs(5)),
            "native observer missed actual named directory create/drop"
        );
    }

    #[test]
    fn archive_staging_authority_retained_parent_creates_only_in_moved_directory() {
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("root");
        let moved = root.with_file_name("moved");
        let replacement = root.with_file_name("replacement");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&replacement).unwrap();
        std::fs::write(replacement.join("foreign"), b"keep").unwrap();
        let observer = ArchiveWriteObserver::new(&replacement);
        let parent = crate::infra::fs::open_parent_no_follow(&root.join("installed")).unwrap();
        let identity = crate::infra::path_authority::opened_file_identity(&parent).unwrap();
        observer.assert_no_writes();
        std::fs::rename(&root, &moved).unwrap();
        std::fs::rename(&replacement, &root).unwrap();
        observer.assert_no_writes();

        let staging = crate::infra::fs::OwnedStagingDir::create_in(&parent, ".archive").unwrap();
        let (_, leaf, _) = staging.binding();
        assert_eq!(staging.parent_identity().unwrap(), identity);
        assert_eq!(leaves(&moved), vec![leaf.to_str().unwrap()]);
        assert!(moved.join(leaf).is_dir());
        assert_eq!(leaves(&root), vec!["foreign"]);
        assert_eq!(std::fs::read(root.join("foreign")).unwrap(), b"keep");
        observer.assert_no_writes();

        drop(staging);
        assert!(leaves(&moved).is_empty());
        assert_eq!(leaves(&root), vec!["foreign"]);
        assert_eq!(std::fs::read(root.join("foreign")).unwrap(), b"keep");
        observer.assert_no_writes();
    }

    #[derive(Clone, Copy, Debug)]
    enum ArchiveReplacementOutcome {
        Swapped,
        #[cfg(windows)]
        Protected(i32),
    }

    impl ArchiveReplacementOutcome {
        fn roots<'a>(
            self,
            root: &'a Path,
            moved: &'a Path,
            _replacement: &'a Path,
        ) -> (&'a Path, &'a Path) {
            match self {
                Self::Swapped => (moved, root),
                #[cfg(windows)]
                Self::Protected(code) => {
                    assert!(
                        is_windows_sharing_or_lock_violation(code),
                        "held authority must record an exact Windows sharing refusal: {code}"
                    );
                    assert!(!moved.exists(), "refused rename must leave no moved root");
                    (root, _replacement)
                }
            }
        }
    }

    struct ArchiveReplacementProbe {
        root: PathBuf,
        moved: PathBuf,
        replacement: PathBuf,
        root_identity: (u64, u64),
        watch: Arc<ArchiveWriteObserver>,
        outcome: Arc<Mutex<Option<ArchiveReplacementOutcome>>>,
        inspected_on: Arc<Mutex<Option<std::thread::ThreadId>>>,
    }

    impl ArchiveReplacementProbe {
        fn new(root: PathBuf) -> Self {
            let moved = root.with_file_name("authorized-moved");
            let replacement = root.with_file_name("replacement");
            std::fs::create_dir(&replacement).unwrap();
            std::fs::write(replacement.join("foreign"), b"keep").unwrap();
            let watch = Arc::new(ArchiveWriteObserver::new(&replacement));
            let root_identity = crate::infra::path_authority::opened_file_identity(
                &crate::infra::fs::open_parent_no_follow(&root.join("installed")).unwrap(),
            )
            .unwrap();
            Self {
                root,
                moved,
                replacement,
                root_identity,
                watch,
                outcome: Arc::new(Mutex::new(None)),
                inspected_on: Arc::new(Mutex::new(None)),
            }
        }

        fn install_hooks(&self, symlink: bool, during_gzip: bool, member: &'static str) {
            let hook_root = self.root.clone();
            let hook_moved = self.moved.clone();
            let hook_replacement = self.replacement.clone();
            let root_identity = self.root_identity;
            let outcome = self.outcome.clone();
            let hook_watch = Arc::downgrade(&self.watch);
            let inspected_on = self.inspected_on.clone();
            let arm_inspection: CoreAfterPinHook = Box::new(move |_| {
                set_archive_pre_install_hook(Some(Box::new(move |_| {
                    let outcome = outcome.lock().unwrap().expect("root rename was attempted");
                    let (authorized, outside) =
                        outcome.roots(&hook_root, &hook_moved, &hook_replacement);
                    assert_eq!(
                        crate::infra::path_authority::opened_file_identity(
                            &crate::infra::fs::open_parent_no_follow(&authorized.join("installed"))
                                .unwrap(),
                        )
                        .unwrap(),
                        root_identity,
                        "staging must remain in the original authorized root object"
                    );
                    assert_eq!(
                        leaves(outside),
                        vec!["foreign"],
                        "replacement root must contain no temporary entry before publication"
                    );
                    hook_watch.upgrade().unwrap().assert_no_writes();
                    let staging = leaves(authorized);
                    assert_eq!(
                        staging.len(),
                        1,
                        "only the retained authorized root receives staging"
                    );
                    assert!(staging[0].starts_with(".archive"));
                    assert_eq!(
                        std::fs::read(authorized.join(&staging[0]).join(member)).unwrap(),
                        b"engine"
                    );
                    *inspected_on.lock().unwrap() = Some(std::thread::current().id());
                })));
            });
            let hook_root = self.root.clone();
            let hook_moved = self.moved.clone();
            let hook_replacement = self.replacement.clone();
            let outcome = self.outcome.clone();
            let swap: CoreAfterPinHook = Box::new(move |_| {
                let observed = match std::fs::rename(&hook_root, &hook_moved) {
                    Ok(()) => {
                        if symlink {
                            #[cfg(unix)]
                            std::os::unix::fs::symlink(&hook_replacement, &hook_root).unwrap();
                            #[cfg(windows)]
                            unreachable!("symlink replacement cases are Unix-only");
                        } else {
                            std::fs::rename(&hook_replacement, &hook_root).unwrap();
                        }
                        ArchiveReplacementOutcome::Swapped
                    }
                    Err(error) => {
                        #[cfg(windows)]
                        {
                            assert!(
                                error
                                    .raw_os_error()
                                    .is_some_and(is_windows_sharing_or_lock_violation),
                                "unexpected authority root rename error: {error}"
                            );
                            ArchiveReplacementOutcome::Protected(error.raw_os_error().unwrap())
                        }
                        #[cfg(not(windows))]
                        panic!("authorized root rename must succeed: {error}");
                    }
                };
                *outcome.lock().unwrap() = Some(observed);
            });
            if during_gzip {
                ARCHIVE_GZIP_SCRATCH_HOOKS.lock().unwrap().insert(
                    self.root.clone(),
                    Box::new(move |path| {
                        swap(path);
                        arm_inspection(path);
                    }),
                );
            } else {
                ARCHIVE_PAYLOAD_HOOKS
                    .lock()
                    .unwrap()
                    .insert(self.root.join("installed"), swap);
                set_core_after_pin_hook(&self.root.join("installed"), Some(arm_inspection));
            }
        }

        fn assert_finished(
            &self,
            result: &Result<(), Error>,
            _member: &str,
        ) -> std::thread::ThreadId {
            let outcome = self
                .outcome
                .lock()
                .unwrap()
                .expect("root rename was attempted");
            let inspected_on = *self.inspected_on.lock().unwrap();
            assert!(
                inspected_on.is_some(),
                "pre-publication inspection was not executed"
            );
            let (authorized, outside) = outcome.roots(&self.root, &self.moved, &self.replacement);
            assert_eq!(
                crate::infra::path_authority::opened_file_identity(
                    &crate::infra::fs::open_parent_no_follow(&authorized.join("installed"))
                        .unwrap(),
                )
                .unwrap(),
                self.root_identity
            );
            match outcome {
                ArchiveReplacementOutcome::Swapped => {
                    let error = result
                        .as_ref()
                        .expect_err("replaced root must refuse publication");
                    assert!(
                        matches!(
                            error.unlabelled(),
                            Error::Conflict(_) | Error::InvalidInput(_)
                        ),
                        "replaced authority root must refuse publication: {result:?}"
                    );
                    assert_eq!(
                        error.root_failure(),
                        error.unlabelled().root_failure_reason()
                    );
                    assert!(
                        leaves(authorized).is_empty(),
                        "refused publication must clean the authorized staging entry"
                    );
                }
                #[cfg(windows)]
                ArchiveReplacementOutcome::Protected(_) => {
                    assert!(
                        result.is_ok(),
                        "protected authority must install: {result:?}"
                    );
                    assert_eq!(leaves(authorized), vec!["installed"]);
                    assert_eq!(
                        std::fs::read(authorized.join("installed").join(_member)).unwrap(),
                        b"engine"
                    );
                }
            }
            assert_eq!(leaves(outside), vec!["foreign"]);
            assert_eq!(std::fs::read(outside.join("foreign")).unwrap(), b"keep");
            self.watch.assert_no_writes();
            inspected_on.unwrap()
        }
    }

    impl Drop for ArchiveReplacementProbe {
        fn drop(&mut self) {
            let target = self.root.join("installed");
            for (hooks, key) in [
                (&CORE_AFTER_PIN_HOOKS, &target),
                (&ARCHIVE_PAYLOAD_HOOKS, &target),
                (&ARCHIVE_GZIP_SCRATCH_HOOKS, &self.root),
            ] {
                hooks
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(key);
            }
            ARCHIVE_PAYLOAD_CREATED_HOOKS
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&target);
        }
    }

    async fn assert_archive_staging_authority_replaced_root(symlink: bool, during_gzip: bool) {
        for (payload, member) in [
            (zip_payload(), "engine.bin"),
            (raw_tar_payload(), "stockfish/engine"),
            (gzip_tar_payload(b"engine"), "stockfish/engine"),
        ] {
            if during_gzip && !payload.starts_with(&[0x1f, 0x8b]) {
                continue;
            }
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let probe = ArchiveReplacementProbe::new(engine_root);
            probe.install_hooks(symlink, during_gzip, member);
            let integrity = unsigned_test_integrity(&payload);
            let state = AppState {
                http_transport: Arc::new(zip_response(payload)),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = test_progress_app();
            let (job, lease) = test_download_lease(&state);
            let result = download_engine_archive_core(
                begin_progress(
                    &state.progress_state,
                    &app.handle().clone(),
                    "authority-parent-swap".into(),
                )
                .unwrap(),
                "https://example.com/engine.archive".into(),
                destination,
                "installed".into(),
                job,
                integrity,
                app.handle().clone(),
                state,
                lease.token(),
                lease.commit_gate(),
                Box::new(accept_any_integrity),
            )
            .await;
            probe.assert_finished(&result, member);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_staging_authority_symlink_before_payload_has_zero_replacement_writes() {
        assert_archive_staging_authority_replaced_root(true, false).await;
    }

    #[tokio::test]
    async fn archive_staging_authority_different_directory_before_payload_has_zero_replacement_writes(
    ) {
        assert_archive_staging_authority_replaced_root(false, false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_staging_authority_symlink_during_gzip_has_zero_replacement_writes() {
        assert_archive_staging_authority_replaced_root(true, true).await;
    }

    #[tokio::test]
    async fn archive_staging_authority_different_directory_during_gzip_has_zero_replacement_writes()
    {
        assert_archive_staging_authority_replaced_root(false, true).await;
    }

    struct WorkerSwitchArchiveTransport {
        response: MockTransport,
        setup_thread: Arc<Mutex<Option<std::thread::ThreadId>>>,
        available_thread: Mutex<Option<std::thread::ThreadId>>,
        releases: Mutex<Vec<Option<std::sync::mpsc::Sender<()>>>>,
        workers: Mutex<Vec<tokio::task::JoinHandle<std::thread::ThreadId>>>,
    }

    impl WorkerSwitchArchiveTransport {
        fn release_all(&self) {
            self.releases
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clear();
        }

        async fn finish(&self) {
            self.release_all();
            let workers = std::mem::take(&mut *self.workers.lock().unwrap());
            for worker in workers {
                worker.await.unwrap();
            }
        }
    }

    // This guard releases both workers even if request, core execution or an assertion panics.
    // The test's private runtime then waits for the actual blocking jobs during shutdown.
    struct ReleaseArchiveWorkerHolds(Arc<WorkerSwitchArchiveTransport>);

    impl Drop for ReleaseArchiveWorkerHolds {
        fn drop(&mut self) {
            self.0.release_all();
        }
    }

    #[async_trait::async_trait]
    impl DownloadTransport for WorkerSwitchArchiveTransport {
        async fn request(&self, url: &str, headers: HeaderMap) -> Result<DownloadResponse, Error> {
            let setup_thread = self.setup_thread.lock().unwrap().unwrap();
            let mut starts = Vec::new();
            for _ in 0..2 {
                let (release, held) = std::sync::mpsc::channel();
                self.releases.lock().unwrap().push(Some(release));
                let (started, entered) = tokio::sync::oneshot::channel();
                self.workers
                    .lock()
                    .unwrap()
                    .push(tokio::task::spawn_blocking(move || {
                        let thread = std::thread::current().id();
                        let _ = started.send(thread);
                        let _ = held.recv();
                        thread
                    }));
                starts.push(entered);
            }
            let mut threads = Vec::new();
            for entered in starts {
                threads.push(
                    tokio::time::timeout(Duration::from_secs(5), entered)
                        .await
                        .unwrap()
                        .unwrap(),
                );
            }
            assert_ne!(threads[0], threads[1]);
            let held_setup = threads
                .iter()
                .position(|thread| *thread == setup_thread)
                .expect("the two occupied workers must include the actual setup thread");
            let other = 1 - held_setup;
            // Leave setup occupied. Join the released other worker before returning ZIP bytes,
            // so the terminal gateway job has exactly that worker available in this pool.
            drop(self.releases.lock().unwrap()[other].take());
            let released_worker = self.workers.lock().unwrap().remove(other);
            assert_eq!(released_worker.await.unwrap(), threads[other]);
            *self.available_thread.lock().unwrap() = Some(threads[other]);
            self.response.request(url, headers).await
        }
    }

    #[test]
    fn archive_staging_authority_worker_switch_keeps_pre_publication_inspection() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(2)
            .build()
            .unwrap();
        runtime.block_on(async {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let probe = ArchiveReplacementProbe::new(engine_root.clone());
            probe.install_hooks(false, false, "engine.bin");
            let payload = zip_payload();
            let integrity = unsigned_test_integrity(&payload);
            let setup_thread = Arc::new(Mutex::new(None));
            let setup_at_hook = setup_thread.clone();
            ARCHIVE_PAYLOAD_CREATED_HOOKS.lock().unwrap().insert(
                engine_root.join("installed"),
                Box::new(move |_| {
                    *setup_at_hook.lock().unwrap() = Some(std::thread::current().id());
                }),
            );
            let transport = Arc::new(WorkerSwitchArchiveTransport {
                response: zip_response(payload),
                setup_thread: setup_thread.clone(),
                available_thread: Mutex::new(None),
                releases: Mutex::new(Vec::new()),
                workers: Mutex::new(Vec::new()),
            });
            let _release_on_exit = ReleaseArchiveWorkerHolds(transport.clone());
            let state = AppState {
                http_transport: transport.clone(),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = test_progress_app();
            let (job, lease) = test_download_lease(&state);
            let result = download_engine_archive_core(
                begin_progress(&state.progress_state, &app.handle().clone(), "authority-worker-switch".into()).unwrap(),
                "https://example.com/engine.zip".into(),
                destination,
                "installed".into(),
                job,
                integrity,
                app.handle().clone(),
                state,
                lease.token(),
                lease.commit_gate(),
                Box::new(accept_any_integrity),
            ).await;
            transport.finish().await;
            let setup_thread = setup_thread.lock().unwrap().unwrap();
            let terminal_thread = transport.available_thread.lock().unwrap().unwrap();
            eprintln!("archive worker switch: setup={setup_thread:?}, available={terminal_thread:?}, inspection={:?}", probe.inspected_on.lock().unwrap());
            let inspected_on = probe.assert_finished(&result, "engine.bin");
            assert_eq!(inspected_on, terminal_thread, "inspection must run on the forced terminal worker");
            assert_ne!(inspected_on, setup_thread, "setup must stay on the other worker");
        });
    }

    #[tokio::test]
    async fn archive_staging_authority_actual_core_consumes_zip_tar_gzip_owners_and_failed_preparation(
    ) {
        for (payload, member, succeeds) in [
            (zip_payload(), "engine.bin", true),
            (raw_tar_payload(), "stockfish/engine", true),
            (gzip_tar_payload(b"engine"), "stockfish/engine", true),
            (b"PK\x03\x04invalid zip".to_vec(), "engine.bin", false),
        ] {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let integrity = unsigned_test_integrity(&payload);
            let state = AppState {
                http_transport: Arc::new(zip_response(payload)),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = test_progress_app();
            let (job, lease) = test_download_lease(&state);
            let result = download_engine_archive_core(
                begin_progress(
                    &state.progress_state,
                    &app.handle().clone(),
                    "joiner-format".into(),
                )
                .unwrap(),
                "https://example.com/engine.zip".into(),
                destination,
                "installed".into(),
                job,
                integrity,
                app.handle().clone(),
                state.clone(),
                lease.token(),
                lease.commit_gate(),
                Box::new(accept_any_integrity),
            )
            .await;
            assert_eq!(
                result.is_ok(),
                succeeds,
                "actual archive preparation/publication: {result:?}"
            );
            if succeeds {
                assert_eq!(
                    std::fs::read(engine_root.join("installed").join(member)).unwrap(),
                    b"engine"
                );
                assert_eq!(leaves(&engine_root), vec!["installed"]);
            } else {
                assert!(
                    leaves(&engine_root).is_empty(),
                    "failed producer must complete identity-bound cleanup"
                );
            }
        }
    }

    #[tokio::test]
    async fn archive_staging_authority_actual_core_preserves_substituted_leaf_before_inventory() {
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, _) = engine_destination(&dir);
        let moved = engine_root.join("moved-owner");
        let substituted = Arc::new(Mutex::new(None));
        let hook_substituted = substituted.clone();
        let hook_moved = moved.clone();
        set_core_after_pin_hook(
            &engine_root.join("installed"),
            Some(Box::new(move |_| {
                set_archive_pre_install_hook(Some(Box::new(move |parent| {
                    let leaf = leaves(parent)
                        .into_iter()
                        .find(|leaf| leaf.starts_with(".archive"))
                        .unwrap();
                    let path = parent.join(leaf);
                    std::fs::rename(&path, &hook_moved).unwrap();
                    std::fs::create_dir(&path).unwrap();
                    std::fs::write(path.join("foreign"), b"keep").unwrap();
                    *hook_substituted.lock().unwrap() = Some(path);
                })));
            })),
        );
        let payload = zip_payload();
        let integrity = unsigned_test_integrity(&payload);
        let state = AppState {
            http_transport: Arc::new(zip_response(payload)),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let (job, lease) = test_download_lease(&state);
        let result = download_engine_archive_core(
            begin_progress(
                &state.progress_state,
                &app.handle().clone(),
                "authority-leaf-swap".into(),
            )
            .unwrap(),
            "https://example.com/engine.zip".into(),
            destination,
            "installed".into(),
            job,
            integrity,
            app.handle().clone(),
            state,
            lease.token(),
            lease.commit_gate(),
            Box::new(accept_any_integrity),
        )
        .await;
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "substituted staging must refuse inventory/publication: {result:?}"
        );
        let substituted = substituted.lock().unwrap().take().unwrap();
        assert_eq!(std::fs::read(substituted.join("foreign")).unwrap(), b"keep");
        assert_eq!(std::fs::read(moved.join("engine.bin")).unwrap(), b"engine");
        assert!(!engine_root.join("installed").exists());
    }

    #[tokio::test]
    async fn archive_staging_authority_actual_core_deadline_and_cancel_await_owned_cleanup() {
        for deadline in [false, true] {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let payload = zip_payload();
            let integrity = unsigned_test_integrity(&payload);
            let state = AppState {
                http_transport: Arc::new(zip_response(payload)),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = test_progress_app();
            let (job, lease) = test_download_lease(&state);
            let cancellation = lease.token();
            let worker_cancellation = cancellation.clone();
            let commit_gate = lease.commit_gate();
            let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let mut guard = ExtractionTestGuard {
                release: Some(release_tx),
            };
            set_core_after_pin_hook(
                &engine_root.join("installed"),
                Some(Box::new(move |_| {
                    set_archive_pre_install_hook(Some(Box::new(move |_| {
                        let _ = entered_tx.send(());
                        release_rx
                            .recv_timeout(Duration::from_secs(10))
                            .expect("preparation release");
                    })));
                })),
            );
            let task_state = state.clone();
            let task = tokio::spawn(crate::infra::operations::run_native_operation(
                lease,
                "joiner owned preparation",
                download_engine_archive_core(
                    begin_progress(
                        &task_state.progress_state,
                        &app.handle().clone(),
                        "joiner-held".into(),
                    )
                    .unwrap(),
                    "https://example.com/engine.zip".into(),
                    destination,
                    "installed".into(),
                    job,
                    integrity,
                    app.handle().clone(),
                    task_state,
                    worker_cancellation,
                    commit_gate,
                    Box::new(accept_any_integrity),
                ),
            ));
            tokio::time::timeout(Duration::from_secs(5), entered_rx)
                .await
                .unwrap()
                .unwrap();
            assert!(leaves(&engine_root)
                .iter()
                .any(|leaf| leaf.starts_with(".archive")));
            if deadline {
                tokio::time::pause();
                tokio::time::advance(DOWNLOAD_DEADLINE + Duration::from_secs(1)).await;
                cancellation.cancelled().await;
                tokio::time::resume();
            } else {
                cancellation.cancel();
            }
            assert!(!state.operations.wait_for_drain(Duration::ZERO).unwrap());
            guard.release();
            let result = tokio::time::timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap();
            assert!(
                if deadline {
                    matches!(result, Err(Error::EngineTimeout(_)))
                } else {
                    matches!(result, Err(Error::Cancellation))
                },
                "completed preparation outcome: {result:?}"
            );
            assert!(leaves(&engine_root).is_empty());
            assert!(state
                .operations
                .wait_for_drain(Duration::from_secs(1))
                .unwrap());
        }
    }

    #[tokio::test]
    async fn catalog_install_publication_retains_provenance_without_registration() {
        use tauri::Manager;
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, _) = engine_destination(&dir);
        let payload = gzip_tar_payload(b"unregistered executable");
        let integrity = unsigned_test_integrity(&payload);
        let directory = format!("engine.tar.gz-{}", integrity.sha256);
        let state = AppState {
            http_transport: Arc::new(zip_response(payload)),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        app.manage(state.clone());
        let (job, lease) = test_download_lease(&state);
        download_engine_archive_core(
            begin_progress(
                &state.progress_state,
                &app.handle().clone(),
                directory.clone(),
            )
            .unwrap(),
            "https://example.com/engine.tar.gz".into(),
            destination,
            directory.clone(),
            job,
            integrity,
            app.handle().clone(),
            state.clone(),
            lease.token(),
            lease.commit_gate(),
            Box::new(accept_any_integrity),
        )
        .await
        .unwrap();
        assert!(engine_root
            .join(&directory)
            .join("stockfish/engine")
            .exists());
        let registry: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("path-authority.json")).unwrap())
                .unwrap();
        assert_eq!(
            registry["catalog_installs"]
                .as_object()
                .map(serde_json::Map::len),
            Some(1),
            "published bytes need durable native ownership even without registration"
        );
        drop(lease);
        state
            .pgn_path_authority
            .install(test_path_authority(&dir))
            .unwrap();
        crate::reconcile_startup_path_owners(
            crate::infra::path_authority::StartupPathOwners {
                retained_ids: vec![],
                trusted_families: vec![crate::infra::path_authority::PathOwnerFamily::Engines],
            },
            app.state::<AppState>(),
        )
        .await
        .unwrap();
        assert!(
            !engine_root.join(directory).exists(),
            "discarded installation is collected on trusted restart"
        );
    }

    #[tokio::test]
    async fn catalog_install_committed_cancel_and_refused_save_are_collected_by_startup_command() {
        use tauri::Manager;
        for committed_cancel in [false, true] {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, root) = engine_destination(&dir);
            let payload = gzip_tar_payload(b"discarded executable");
            let integrity = unsigned_test_integrity(&payload);
            let directory = format!("discarded-{}", integrity.sha256);
            let state = AppState {
                http_transport: Arc::new(zip_response(payload)),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = test_progress_app();
            app.manage(state.clone());
            let (job, lease) = test_download_lease(&state);
            if committed_cancel {
                let operations = state.operations.clone();
                let ticket = job.clone();
                crate::infra::operations::arm_commit_after_hook(
                    job.clone(),
                    Box::new(move || {
                        assert!(
                            !operations.cancel_download(&ticket, "test").unwrap(),
                            "committed download cannot be canceled"
                        );
                    }),
                );
            }
            let cancellation = lease.token();
            let commit_gate = lease.commit_gate();
            crate::infra::operations::run_native_operation(
                lease,
                "catalog discard proof",
                download_engine_archive_core(
                    begin_progress(
                        &state.progress_state,
                        &app.handle().clone(),
                        directory.clone(),
                    )
                    .unwrap(),
                    "https://example.com/engine.tar.gz".into(),
                    destination,
                    directory.clone(),
                    job,
                    integrity,
                    app.handle().clone(),
                    state.clone(),
                    cancellation,
                    commit_gate,
                    Box::new(accept_any_integrity),
                ),
            )
            .await
            .unwrap();
            if !committed_cancel {
                // Native registration happened, but no renderer owner was durably saved.
                state
                    .pgn_path_authority
                    .with_mut(|authority| {
                        authority
                            .register_installed_engine_for_test(
                                &root,
                                &format!("{directory}/stockfish/engine"),
                            )
                            .unwrap();
                        authority.clear_catalog_session_use()
                    })
                    .unwrap()
                    .unwrap();
            }
            assert!(engine_root.join(&directory).exists());
            state
                .pgn_path_authority
                .install(test_path_authority(&dir))
                .unwrap();
            crate::reconcile_startup_path_owners(
                crate::infra::path_authority::StartupPathOwners {
                    retained_ids: vec![],
                    trusted_families: vec![crate::infra::path_authority::PathOwnerFamily::Engines],
                },
                app.state::<AppState>(),
            )
            .await
            .unwrap();
            assert!(!engine_root.join(&directory).exists());
        }
    }

    #[tokio::test]
    async fn catalog_digest_directories_are_distinct_and_same_artifact_is_adopted() {
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, root) = engine_destination(&dir);
        let payloads = [
            gzip_tar_payload(b"first executable"),
            gzip_tar_payload(b"second executable"),
        ];
        let state = AppState {
            http_transport: Arc::new(zip_response(payloads[0].clone())),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let mut paths = Vec::new();
        let mut handles = Vec::new();
        for payload in payloads {
            let integrity = unsigned_test_integrity(&payload);
            let directory = format!("engine.tar.gz-{}", integrity.sha256);
            let state = AppState {
                http_transport: Arc::new(zip_response(payload)),
                ..state.clone()
            };
            let (job, lease) = test_download_lease(&state);
            download_engine_archive_core(
                begin_progress(
                    &state.progress_state,
                    &app.handle().clone(),
                    directory.clone(),
                )
                .unwrap(),
                "https://example.com/engine.tar.gz".into(),
                destination.clone(),
                directory.clone(),
                job,
                integrity.clone(),
                app.handle().clone(),
                state.clone(),
                lease.token(),
                lease.commit_gate(),
                Box::new(accept_any_integrity),
            )
            .await
            .unwrap();
            let relative = format!("{directory}/stockfish/engine");
            let handle = state
                .pgn_path_authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .register_installed_engine_for_test(&root, &relative)
                .unwrap();
            let installed_path = engine_root.join(&relative);
            let identity = crate::infra::path_authority::opened_file_identity(
                &std::fs::File::open(&installed_path).unwrap(),
            )
            .unwrap();
            let marker = engine_root.join(&directory).join("adoption-marker");
            std::fs::write(&marker, b"keep tree").unwrap();
            // Empty transport refuses if adoption tries to download or re-extract anything.
            let adoption = AppState {
                http_transport: Arc::new(MockTransport {
                    responses: Mutex::new(vec![]),
                    requests_seen: Mutex::new(vec![]),
                }),
                ..state.clone()
            };
            let (job, lease) = test_download_lease(&adoption);
            let verified = Arc::new(AtomicBool::new(false));
            let verify = Arc::clone(&verified);
            download_engine_archive_core(
                begin_progress(
                    &adoption.progress_state,
                    &app.handle().clone(),
                    directory.clone(),
                )
                .unwrap(),
                "https://example.com/engine.tar.gz".into(),
                destination.clone(),
                directory.clone(),
                job,
                integrity,
                app.handle().clone(),
                adoption,
                lease.token(),
                lease.commit_gate(),
                Box::new(move |_, _, _| {
                    verify.store(true, Ordering::SeqCst);
                    Ok(())
                }),
            )
            .await
            .unwrap();
            assert!(verified.load(Ordering::SeqCst));
            assert_eq!(std::fs::read(marker).unwrap(), b"keep tree");
            assert_eq!(
                crate::infra::path_authority::opened_file_identity(
                    &std::fs::File::open(&installed_path).unwrap()
                )
                .unwrap(),
                identity
            );
            let adopted = state
                .pgn_path_authority
                .raw_for_test()
                .lock()
                .unwrap()
                .as_mut()
                .unwrap()
                .register_installed_engine_for_test(&root, &relative)
                .unwrap();
            assert_eq!(handle, adopted);
            handles.push(handle);
            paths.push(installed_path);
        }
        assert_ne!(paths[0], paths[1]);
        assert_ne!(handles[0], handles[1]);
        assert_eq!(std::fs::read(&paths[0]).unwrap(), b"first executable");
        assert_eq!(std::fs::read(&paths[1]).unwrap(), b"second executable");
    }

    async fn download_zip_with_staging(path: &Path, staging: Option<PathBuf>) -> Error {
        download_file_core(
            OpClass::Engine,
            "https://github.com/owner/repo/releases/download/v1/engine.zip",
            path,
            staging,
            &zip_response(zip_payload()),
            None,
            None,
            |_| Ok(()),
        )
        .await
        .unwrap_err()
    }

    #[tokio::test]
    async fn download_archive_without_staging_is_invalid_input() {
        let root = tempdir().unwrap();
        let target = root.path().join("payload");
        let error = download_zip_with_staging(&target, None).await;
        assert_eq!(
            error.to_string(),
            "Invalid input: archive extract needs process-owned staging"
        );
        assert!(!target.exists());
        assert!(leaves(root.path()).is_empty(), "{:?}", leaves(root.path()));
    }

    #[tokio::test]
    async fn download_archive_staging_root_path_mismatch_is_invalid_input() {
        let root = tempdir().unwrap();
        let staging = private_tempdir_in(".archive", root.path()).unwrap();
        let other = root.path().join("other");
        let error = download_zip_with_staging(&other, Some(staging.path().to_path_buf())).await;
        assert_eq!(
            error.to_string(),
            "Invalid input: archive target does not match its staging"
        );
        assert!(!error.to_string().contains('/'));
        assert!(!other.exists());
        assert!(leaves(staging.path()).is_empty());
    }

    #[tokio::test]
    async fn checksum_mismatch_never_installs_the_downloaded_payload() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("payload.db3");
        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![Ok(DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: Some(4),
                stream: Box::pin(futures_util::stream::iter(vec![Ok(bytes::Bytes::from(
                    "data",
                ))])),
            })]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };
        let error = download_file_core_control_with_integrity(
            OpClass::Db,
            "https://www.encroissant.org/data.db3",
            &target,
            None,
            &mock,
            None,
            None,
            CancellationToken::new(),
            Some(&"0".repeat(64)),
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid input: artifact SHA-256 mismatch"
        );
        assert!(!target.exists());
    }

    #[tokio::test]
    async fn cancelled_download_never_starts_transport_or_touches_target() {
        let dir = tempdir().unwrap();
        let parent = dir.path().join("missing-parent");
        let target = parent.join("out.pgn");
        let token = CancellationToken::new();
        token.cancel();
        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };
        let error = download_file_core_control(
            OpClass::Lichess,
            "https://lichess.org/export",
            &target,
            None,
            &mock,
            None,
            None,
            token,
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert!(!parent.exists());
        assert!(!target.exists());
        assert!(mock.requests_seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn externally_cancelled_generic_download_drops_stream_without_publication() {
        let dir = tempdir().unwrap();
        let (authority, destination, download_root) = test_downloads_destination(&dir);
        let first_seen = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let state = Arc::new(AppState {
            http_transport: Arc::new(BlockingChunkTransport {
                first_seen: Arc::clone(&first_seen),
                stopped: Arc::clone(&stopped),
            }),
            ..AppState::default()
        });
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let app_handle = app.handle().clone();
        let (job_id, lease) = test_download_lease(&state);
        let cancel_id = job_id.clone();
        let task_state = Arc::clone(&state);
        let task = tokio::spawn(async move {
            download_to_destination(
                "external-cancel-generic",
                "https://example.com/download.pgn",
                destination,
                "download.pgn".into(),
                &app_handle,
                &task_state,
                None,
                None,
                job_id,
                lease,
                false,
                None,
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !first_seen.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(state
            .operations
            .cancel_download(&cancel_id, "test")
            .unwrap());
        let error = task.await.unwrap().unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert!(stopped.load(Ordering::SeqCst));
        assert!(!download_root.join("download.pgn").exists());
    }

    #[tokio::test]
    async fn externally_cancelled_engine_archive_drops_stream_without_installation() {
        let dir = tempdir().unwrap();
        let (authority, destination, engine_root, _) = engine_destination(&dir);
        let first_seen = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let state = Arc::new(AppState {
            http_transport: Arc::new(BlockingChunkTransport {
                first_seen: Arc::clone(&first_seen),
                stopped: Arc::clone(&stopped),
            }),
            ..AppState::default()
        });
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let (job_id, lease) = test_download_lease(&state);
        let cancel_id = job_id.clone();
        let cancellation = lease.token();
        let commit_gate = lease.commit_gate();
        let integrity = unsigned_test_integrity(b"not a complete archive");
        let task_state = (*state).clone();
        let task_app = app.handle().clone();
        let task_job_id = job_id;
        let task = tokio::spawn(crate::infra::operations::run_native_operation(
            lease,
            "download_engine_archive",
            download_engine_archive_core(
                begin_progress(
                    &task_state.progress_state,
                    &task_app,
                    "external-cancel-engine".into(),
                )
                .unwrap(),
                "https://example.com/engine.zip".into(),
                destination,
                "engine".into(),
                task_job_id,
                integrity,
                task_app,
                task_state,
                cancellation,
                commit_gate,
                Box::new(accept_any_integrity),
            ),
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while !first_seen.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(state
            .operations
            .cancel_download(&cancel_id, "test")
            .unwrap());
        let error = task.await.unwrap().unwrap_err();
        assert!(matches!(error, Error::Cancellation));
        assert!(stopped.load(Ordering::SeqCst));
        assert!(!engine_root.join("engine").exists());
    }

    #[tokio::test]
    async fn generic_download_commit_gate_race_preserves_linearized_outcome() {
        {
            let dir = tempdir().unwrap();
            let (authority, destination, download_root) = test_downloads_destination(&dir);
            let payload: &'static [u8] = b"committed generic download";
            let state = AppState {
                http_transport: mock_successful_transport(payload),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let state = Arc::new(state);
            let app = test_progress_app();
            let app_handle = app.handle().clone();
            let (job_id, lease) = test_download_lease(&state);
            let cancel_id = job_id.clone();
            let (entered, release) = hold_commit_hook(job_id.clone(), true);
            let task_state = Arc::clone(&state);
            let task = tokio::spawn(async move {
                download_to_destination(
                    "generic-commit-after",
                    "https://example.com/committed.pgn",
                    destination,
                    "committed.pgn".into(),
                    &app_handle,
                    &task_state,
                    None,
                    None,
                    job_id,
                    lease,
                    false,
                    None,
                    None,
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(2), entered)
                .await
                .unwrap()
                .unwrap();
            assert!(!state
                .operations
                .cancel_download(&cancel_id, "test")
                .unwrap());
            release.send(()).unwrap();
            assert!(task.await.unwrap().is_ok());
            assert_eq!(
                std::fs::read(download_root.join("committed.pgn")).unwrap(),
                payload
            );
        }

        {
            let dir = tempdir().unwrap();
            let (authority, destination, download_root) = test_downloads_destination(&dir);
            let payload: &'static [u8] = b"cancelled generic download";
            let state = AppState {
                http_transport: mock_successful_transport(payload),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let state = Arc::new(state);
            let app = test_progress_app();
            let app_handle = app.handle().clone();
            let (job_id, lease) = test_download_lease(&state);
            let cancel_id = job_id.clone();
            let (entered, release) = hold_commit_hook(job_id.clone(), false);
            let task_state = Arc::clone(&state);
            let task = tokio::spawn(async move {
                download_to_destination(
                    "generic-commit-before",
                    "https://example.com/cancelled.pgn",
                    destination,
                    "cancelled.pgn".into(),
                    &app_handle,
                    &task_state,
                    None,
                    None,
                    job_id,
                    lease,
                    false,
                    None,
                    None,
                )
                .await
            });
            tokio::time::timeout(Duration::from_secs(2), entered)
                .await
                .unwrap()
                .unwrap();
            assert!(state
                .operations
                .cancel_download(&cancel_id, "test")
                .unwrap());
            release.send(()).unwrap();
            assert!(matches!(
                task.await.unwrap().unwrap_err(),
                Error::Cancellation
            ));
            assert!(!download_root.join("cancelled.pgn").exists());
        }
    }

    #[tokio::test]
    async fn engine_archive_commit_gate_race_preserves_linearized_outcome() {
        {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let payload = zip_payload();
            let state = AppState {
                http_transport: Arc::new(zip_response(payload.clone())),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let state = Arc::new(state);
            let app = test_progress_app();
            let (job_id, lease) = test_download_lease(&state);
            let cancel_id = job_id.clone();
            let (entered, release) = hold_commit_hook(job_id.clone(), true);
            let cancellation = lease.token();
            let commit_gate = lease.commit_gate();
            let task = tokio::spawn(crate::infra::operations::run_native_operation(
                lease,
                "download_engine_archive",
                download_engine_archive_core(
                    begin_progress(
                        &state.progress_state,
                        &app.handle().clone(),
                        "engine-commit-after".into(),
                    )
                    .unwrap(),
                    "https://example.com/engine.zip".into(),
                    destination,
                    "engine".into(),
                    job_id,
                    unsigned_test_integrity(&payload),
                    app.handle().clone(),
                    (*state).clone(),
                    cancellation,
                    commit_gate,
                    Box::new(accept_any_integrity),
                ),
            ));
            tokio::time::timeout(Duration::from_secs(2), entered)
                .await
                .unwrap()
                .unwrap();
            assert!(!state
                .operations
                .cancel_download(&cancel_id, "test")
                .unwrap());
            release.send(()).unwrap();
            assert!(task.await.unwrap().is_ok());
            assert!(engine_root.join("engine").exists());
        }

        {
            let dir = tempdir().unwrap();
            let (authority, destination, engine_root, _) = engine_destination(&dir);
            let payload = zip_payload();
            let state = AppState {
                http_transport: Arc::new(zip_response(payload.clone())),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let state = Arc::new(state);
            let app = test_progress_app();
            let (job_id, lease) = test_download_lease(&state);
            let cancel_id = job_id.clone();
            let cancellation = lease.token();
            let commit_gate = lease.commit_gate();
            let (entered, release_tx) = hold_commit_hook(job_id.clone(), false);
            let task = tokio::spawn(crate::infra::operations::run_native_operation(
                lease,
                "download_engine_archive",
                download_engine_archive_core(
                    begin_progress(
                        &state.progress_state,
                        &app.handle().clone(),
                        "engine-commit-before".into(),
                    )
                    .unwrap(),
                    "https://example.com/engine.zip".into(),
                    destination,
                    "engine".into(),
                    job_id,
                    unsigned_test_integrity(&payload),
                    app.handle().clone(),
                    (*state).clone(),
                    cancellation,
                    commit_gate,
                    Box::new(accept_any_integrity),
                ),
            ));
            tokio::time::timeout(Duration::from_secs(2), entered)
                .await
                .unwrap()
                .unwrap();
            assert!(state
                .operations
                .cancel_download(&cancel_id, "test")
                .unwrap());
            release_tx.send(()).unwrap();
            assert!(matches!(
                task.await.unwrap().unwrap_err(),
                Error::Cancellation
            ));
            assert!(!engine_root.join("engine").exists());
        }
    }

    #[tokio::test]
    async fn test_download_file_length_mismatch() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("out.txt");

        let stream = futures_util::stream::iter(vec![Ok(bytes::Bytes::from("123"))]);

        let mock = MockTransport {
            responses: std::sync::Mutex::new(vec![Ok(DownloadResponse {
                status: 200,
                headers: HeaderMap::new(),
                content_length: Some(10), // Declared 10, actual 3
                stream: Box::pin(stream),
            })]),
            requests_seen: std::sync::Mutex::new(vec![]),
        };

        let res = download_file_core(
            OpClass::Lichess,
            "https://lichess.org/test",
            &target,
            None,
            &mock,
            None,
            None,
            |_| Ok(()),
        )
        .await;

        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err().to_string(),
            "Invalid input: Actual downloaded size mismatch"
        );
    }

    struct ResetAtomicInjectorGuard;
    impl Drop for ResetAtomicInjectorGuard {
        fn drop(&mut self) {
            crate::infra::fs::set_test_atomic_file_injector(None);
        }
    }

    struct TargetParentSyncFault {
        skip: std::sync::atomic::AtomicUsize,
    }

    impl crate::infra::fs::AtomicWriterInjector for TargetParentSyncFault {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == crate::infra::fs::AtomicFileFaultPoint::ParentSync
                && self.skip.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) == 0
            {
                return Err(std::io::Error::other("target parent sync failed"));
            }
            Ok(())
        }
    }

    struct HoldSecondPrecommit {
        seen: std::sync::atomic::AtomicUsize,
        entered: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl crate::infra::fs::AtomicWriterInjector for HoldSecondPrecommit {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == crate::infra::fs::AtomicFileFaultPoint::PreCommitRevalidate
                && self.seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
            {
                if let Some(entered) = self.entered.lock().unwrap().take() {
                    let _ = entered.send(());
                }
                let _ = self
                    .release
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5));
            }
            Ok(())
        }
    }

    fn hold_commit_hook(
        id: String,
        after: bool,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let hook = Box::new(move || {
            let _ = entered_tx.send(());
            let _ = release_rx.recv_timeout(Duration::from_secs(5));
        });
        if after {
            crate::infra::operations::arm_commit_after_hook(id, hook);
        } else {
            crate::infra::operations::arm_commit_before_hook(id, hook);
        }
        (entered_rx, release_tx)
    }

    struct CancelSecondParentSync {
        seen: std::sync::atomic::AtomicUsize,
        cancellation: CancellationToken,
    }

    impl crate::infra::fs::AtomicWriterInjector for CancelSecondParentSync {
        fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == crate::infra::fs::AtomicFileFaultPoint::ParentSync
                && self.seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1
            {
                self.cancellation.cancel();
            }
            Ok(())
        }
    }

    fn test_downloads_destination(
        dir: &tempfile::TempDir,
    ) -> (
        crate::infra::path_authority::PathAuthority,
        crate::infra::path_authority::PathRef,
        PathBuf,
    ) {
        let app_root = crate::infra::path_authority::AppOwnedRoot::canonical_for_test(
            "downloads",
            &dir.path().join("downloads"),
            vec![crate::infra::path_authority::PathOperation::DownloadFile],
        );
        let download_root = app_root.path.clone();
        let root_id = app_root.id.clone();
        let authority = crate::infra::path_authority::PathAuthority::open(
            dir.path().join("path-authority.json"),
            vec![app_root],
        )
        .unwrap();
        (authority, root_id, download_root)
    }

    #[test]
    fn reservation_cleanup_unavailability_keeps_the_reservation_and_exact_warning() {
        use crate::infra::path_authority::{AuthorityUnavailable, SharedPathAuthority};
        for unavailable in [
            AuthorityUnavailable::Poisoned,
            AuthorityUnavailable::Uninitialized,
        ] {
            let directory = tempdir().unwrap();
            let (mut authority, destination, _) = test_downloads_destination(&directory);
            let reservation = authority
                .reserve_download_artifact(
                    &destination,
                    std::ffi::OsString::from("reserved.pgn"),
                    (7, "digest".into()),
                    "reserved",
                    vec![crate::infra::path_authority::PathOperation::ReadPgn],
                )
                .unwrap();
            assert!(authority.has_pending_artifact_filename(Path::new("reserved.pgn")));
            let registry = directory.path().join("path-authority.json");
            let before = std::fs::read(&registry).unwrap();
            let owner = SharedPathAuthority::installed(authority);
            match unavailable {
                AuthorityUnavailable::Poisoned => owner.poison(),
                AuthorityUnavailable::Uninitialized => owner.uninstall(),
            }
            let capture = crate::error::LogCaptureScope::start();
            cleanup_download_reservation_best_effort(&owner, &reservation);
            let expected = match unavailable {
                AuthorityUnavailable::Poisoned => {
                    "download reservation cleanup failed at lock: conflict"
                }
                AuthorityUnavailable::Uninitialized => {
                    "download reservation cleanup failed at initialization: conflict"
                }
            };
            assert_eq!(capture.messages(), vec![expected]);
            assert_eq!(std::fs::read(&registry).unwrap(), before);
        }
    }

    fn test_progress_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                crate::progress::ProgressEvent,
                crate::infra::operations::completions::CompletionChanged
            ))
            .mount_events(&app);
        app
    }

    #[tokio::test]
    async fn file_download_install_error_publishes_sanitized_payload() {
        use tauri_specta::Event as _;

        const SECRET: &str = "fixture-install-secret";
        struct InstallWriteFault(Arc<AtomicBool>);
        impl crate::infra::fs::AtomicWriterInjector for InstallWriteFault {
            fn inject(&self, point: crate::infra::fs::AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == crate::infra::fs::AtomicFileFaultPoint::Write {
                    self.0.store(true, Ordering::SeqCst);
                    return Err(std::io::Error::other(format!(
                        "/native/private/download.pgn token={SECRET}"
                    )));
                }
                Ok(())
            }
        }

        let _guard = ResetAtomicInjectorGuard;
        let dir = tempdir().unwrap();
        let (authority, destination, root) = test_downloads_destination(&dir);
        let body = b"1. e4 c5 2. Nf3 d6";
        let state = AppState {
            http_transport: mock_successful_transport(body),
            ..Default::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let events = Arc::new(Mutex::new(Vec::<crate::progress::ProgressEvent>::new()));
        let observed = events.clone();
        let listener = crate::progress::ProgressEvent::listen(app.handle(), move |event| {
            observed.lock().unwrap().push(event.payload);
        });
        let job = state.operations.prepare_download("test").unwrap();
        let write_reached = Arc::new(AtomicBool::new(false));
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(InstallWriteFault(
            write_reached.clone(),
        ))));
        let error = download_file_runtime(
            "file-install-failure".into(),
            "https://example.com/download.pgn".into(),
            destination,
            "download.pgn".into(),
            app.handle(),
            "test",
            &state,
            Some(body.len() as u32),
            job,
            None,
        )
        .await
        .unwrap_err();
        assert!(write_reached.load(Ordering::SeqCst));
        let item = state
            .progress_state
            .get("file-install-failure")
            .unwrap()
            .unwrap();
        assert_eq!(item.state, ProgressState::Failed);
        assert_eq!(item.progress, 100.0);
        assert!(item.finished);
        let expected =
            serde_json::json!({"tag":"backend-error", "category":"io", "message":"I/O failure"});
        let failure = serde_json::to_value(item.failure.as_ref().unwrap()).unwrap();
        assert_eq!(failure, expected);
        assert!(!failure.to_string().contains(SECRET));
        let mut command_wire = expected.clone();
        command_wire["progressGeneration"] = serde_json::to_value(item.generation).unwrap();
        assert_eq!(serde_json::to_value(error).unwrap(), command_wire);
        let failed = events
            .lock()
            .unwrap()
            .iter()
            .find(|event| event.state == ProgressState::Failed)
            .cloned()
            .unwrap();
        assert_eq!(failed.failure, item.failure);
        assert_eq!(failed.generation, item.generation);
        assert_eq!(failed.progress, 100.0);
        assert_eq!(serde_json::to_value(&failed).unwrap()["failure"], expected);
        assert!(!serde_json::to_string(&failed).unwrap().contains(SECRET));
        assert!(!root.join("download.pgn").exists());
        tauri::Listener::unlisten(app.handle(), listener);
    }

    #[tokio::test]
    async fn file_download_failure_publishes_sanitized_payload() {
        use tauri_specta::Event as _;
        let dir = tempdir().unwrap();
        let (authority, destination, root) = test_downloads_destination(&dir);
        let transport = Arc::new(MockTransport {
            responses: Mutex::new(vec![
                Ok(DownloadResponse {
                    status: 200,
                    headers: HeaderMap::new(),
                    content_length: Some(10),
                    stream: Box::pin(futures_util::stream::iter(vec![
                        Ok(bytes::Bytes::from_static(b"part")),
                        Err(Error::Io(Box::new(std::io::Error::other(
                            "/native/private/download.pgn token=fixture-secret",
                        )))),
                    ])),
                }),
                Err(Error::Cancellation),
            ]),
            requests_seen: Mutex::new(vec![]),
        });
        let state = AppState {
            http_transport: transport.clone(),
            ..Default::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let events = Arc::new(Mutex::new(Vec::<crate::progress::ProgressEvent>::new()));
        let observed = events.clone();
        let listener = crate::progress::ProgressEvent::listen(app.handle(), move |event| {
            observed.lock().unwrap().push(event.payload);
        });
        let job = state.operations.prepare_download("test").unwrap();
        let error = download_file_runtime(
            "file-failure".into(),
            "https://example.com/download.pgn?token=fixture-secret".into(),
            destination.clone(),
            "download.pgn".into(),
            app.handle(),
            "test",
            &state,
            Some(10),
            job,
            None,
        )
        .await
        .unwrap_err();
        let item = state.progress_state.get("file-failure").unwrap().unwrap();
        assert_eq!(item.state, ProgressState::Failed);
        assert_eq!(item.progress, 40.0);
        assert!(item.finished);
        let expected =
            serde_json::json!({"tag":"backend-error", "category":"io", "message":"I/O failure"});
        assert_eq!(
            serde_json::to_value(item.failure.as_ref().unwrap()).unwrap(),
            expected
        );
        let mut command_wire = expected.clone();
        command_wire["progressGeneration"] = serde_json::to_value(item.generation).unwrap();
        assert_eq!(serde_json::to_value(error).unwrap(), command_wire);
        let failed = events
            .lock()
            .unwrap()
            .iter()
            .find(|event| event.state == ProgressState::Failed)
            .cloned()
            .unwrap();
        assert_eq!(failed.failure, item.failure);
        assert_eq!(failed.generation, item.generation);
        assert_eq!(failed.progress, 40.0);
        assert_eq!(serde_json::to_value(&failed).unwrap()["failure"], expected);
        assert!(!root.join("download.pgn").exists());

        // An admitted command can still fail validation before it owns a progress generation.
        let job = state.operations.prepare_download("test").unwrap();
        let before_begin = download_file_runtime(
            "pre-begin".into(),
            "https://example.com/download.pgn".into(),
            destination.clone(),
            "../invalid.pgn".into(),
            app.handle(),
            "test",
            &state,
            None,
            job,
            None,
        )
        .await
        .unwrap_err();
        assert!(serde_json::to_value(before_begin)
            .unwrap()
            .get("progressGeneration")
            .is_none());
        assert!(state.progress_state.get("pre-begin").unwrap().is_none());

        let refused = download_file_runtime(
            "refused".into(),
            "https://example.com/download.pgn".into(),
            destination.clone(),
            "refused.pgn".into(),
            app.handle(),
            "test",
            &state,
            None,
            "unprepared-ticket".into(),
            None,
        )
        .await
        .unwrap_err();
        assert!(serde_json::to_value(refused)
            .unwrap()
            .get("progressGeneration")
            .is_none());
        assert!(state.progress_state.get("refused").unwrap().is_none());

        let job = state.operations.prepare_download("test").unwrap();
        let cancelled = download_file_runtime(
            "file-cancelled".into(),
            "https://example.com/download.pgn".into(),
            destination.clone(),
            "cancelled.pgn".into(),
            app.handle(),
            "test",
            &state,
            None,
            job,
            None,
        )
        .await
        .unwrap_err();
        let cancelled_item = state.progress_state.get("file-cancelled").unwrap().unwrap();
        assert_eq!(cancelled_item.state, ProgressState::Cancelled);
        assert!(cancelled_item.failure.is_none());
        assert_eq!(
            cancelled.category,
            crate::error::ErrorCategory::Cancellation
        );
        assert_eq!(
            cancelled.progress_generation,
            Some(cancelled_item.generation)
        );

        let credentials = Arc::new(crate::credentials::CredentialManager::new(Arc::new(
            crate::credentials::MemoryCredentialStore::default(),
        )));
        credentials
            .initialize(&crate::infra::path_authority::AppDataDir::for_test(
                &dir.path().join("credentials-app"),
            ))
            .unwrap();
        let account = credentials
            .store_lichess_token("player".into(), "fixture-secret".into())
            .unwrap()
            .account;
        transport
            .responses
            .lock()
            .unwrap()
            .push(Err(Error::Io(Box::new(std::io::Error::other(
                "/native/private/lichess.pgn token=fixture-secret",
            )))));
        let state = AppState {
            credentials,
            ..state
        };
        let job = state.operations.prepare_download("test").unwrap();
        let result = download_lichess_games_runtime(
            account.handle,
            destination,
            "lichess.pgn".into(),
            "player".into(),
            None,
            job.clone(),
            "test",
            app.handle(),
            &state,
        )
        .await;
        let runtime_error = result.as_ref().unwrap_err();
        assert!(serde_json::to_value(runtime_error)
            .unwrap()
            .get("progressGeneration")
            .is_none());
        let item = state.progress_state.get(&job).unwrap().unwrap();
        assert_eq!(item.state, ProgressState::Failed);
        assert!(item.failure.is_none());
        let command_error = download_publication_result(result)
            .map_err(sanitize_download_error)
            .unwrap_err();
        assert!(serde_json::to_value(command_error)
            .unwrap()
            .get("progressGeneration")
            .is_none());
        let events = events.lock().unwrap();
        let failed = events
            .iter()
            .find(|event| event.id == job && event.state == ProgressState::Failed)
            .unwrap();
        assert!(failed.failure.is_none());
        tauri::Listener::unlisten(app.handle(), listener);
    }

    #[tokio::test]
    async fn engine_download_failure_progress_has_no_payload() {
        use crate::infra::operations::completions::{
            CompletionOutcome, EngineInstallIntent, EngineInstallRequest,
        };
        let dir = tempdir().unwrap();
        let (authority, destination, _, root) = engine_destination(&dir);
        let state = AppState {
            http_transport: Arc::new(MockTransport {
                responses: Mutex::new(vec![
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "archive transport failed",
                    )))),
                    Err(Error::Io(Box::new(std::io::Error::other(
                        "completion transport failed",
                    )))),
                ]),
                requests_seen: Mutex::new(vec![]),
            }),
            ..Default::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let progress =
            begin_progress(&state.progress_state, app.handle(), "engine-core".into()).unwrap();
        let (job, lease) = test_download_lease(&state);
        let integrity = unsigned_test_integrity(b"unused");
        let error = download_engine_archive_core(
            progress,
            "https://example.com/engine.zip".into(),
            destination,
            "engine".into(),
            job,
            integrity.clone(),
            app.handle().clone(),
            state.clone(),
            lease.token(),
            lease.commit_gate(),
            Box::new(accept_any_integrity),
        )
        .await
        .unwrap_err();
        assert!(serde_json::to_value(&error)
            .unwrap()
            .get("progressGeneration")
            .is_none());
        let item = state.progress_state.get("engine-core").unwrap().unwrap();
        assert_eq!(item.state, ProgressState::Failed);
        assert!(item.failure.is_none());
        drop(lease);

        let request = EngineInstallRequest {
            intent: EngineInstallIntent::Add {
                engine_id: uuid::Uuid::new_v4().to_string(),
            },
            root,
            progress_id: "engine-completion".into(),
            url: "https://example.com/engine.zip".into(),
            sha256: integrity.sha256,
            signature: integrity.signature,
            relative_path: "engine".into(),
            name: "Engine".into(),
            version: "1".into(),
            elo: None,
            download_size: None,
        };
        let job = state.operations.prepare_download("test").unwrap();
        let (snapshot, lease) = state
            .operations
            .admit_engine_completion(
                &uuid::Uuid::new_v4().to_string(),
                "test",
                &job,
                request,
                MAX_ACTIVE_DOWNLOADS,
            )
            .unwrap();
        let terminal = run_engine_install_completion(
            snapshot,
            lease.unwrap(),
            app.handle().clone(),
            state.clone(),
            Box::new(accept_any_integrity),
            "test".into(),
        )
        .await
        .unwrap();
        let CompletionOutcome::Failed(payload) = terminal.outcome else {
            panic!("engine completion must retain its failure")
        };
        assert!(serde_json::to_value(payload)
            .unwrap()
            .get("progressGeneration")
            .is_none());
        let item = state
            .progress_state
            .get("engine-completion")
            .unwrap()
            .unwrap();
        assert_eq!(item.state, ProgressState::Failed);
        assert!(item.failure.is_none());
    }

    fn mock_successful_response(payload: &'static [u8]) -> DownloadResponse {
        DownloadResponse {
            status: 200,
            headers: HeaderMap::new(),
            content_length: Some(payload.len() as u64),
            stream: Box::pin(futures_util::stream::iter(vec![Ok(
                bytes::Bytes::from_static(payload),
            )])),
        }
    }

    fn mock_successful_transport(
        payload: &'static [u8],
    ) -> Arc<dyn crate::infra::net::DownloadTransport> {
        Arc::new(MockTransport {
            responses: std::sync::Mutex::new(vec![Ok(mock_successful_response(payload))]),
            requests_seen: std::sync::Mutex::new(vec![]),
        })
    }

    #[tokio::test]
    async fn remote_http_rejection_leaves_account_export_unpublished_and_releases_operation() {
        let dir = tempdir().unwrap();
        let (authority, destination, root) = test_downloads_destination(&dir);
        let registry = dir.path().join("path-authority.json");
        assert!(!registry.try_exists().unwrap());
        let target = root.join("games.pgn");
        std::fs::write(&target, b"previous export").unwrap();
        let identity_before = std::fs::metadata(&target).unwrap();
        let polled = Arc::new(AtomicBool::new(false));
        let state = AppState {
            http_transport: Arc::new(MockTransport {
                responses: Mutex::new(vec![Ok(rejected_response(401, polled.clone()))]),
                requests_seen: Mutex::new(vec![]),
            }),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let (job_id, lease) = test_download_lease(&state);
        let error = download_to_destination(
            &job_id,
            "https://lichess.org/api/games/user/private_account",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            Some("private_token"),
            None,
            job_id.clone(),
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            serde_json::to_value(&error).unwrap(),
            serde_json::json!({
                "tag": "backend-error", "category": "authentication",
                "message": "Remote HTTP request rejected: status 401",
                "remoteHttpRejection": {"status": 401, "authorizationSent": true}
            })
        );
        assert!(!polled.load(Ordering::SeqCst));
        assert_eq!(std::fs::read(&target).unwrap(), b"previous export");
        assert_eq!(
            std::fs::metadata(&target).unwrap().modified().unwrap(),
            identity_before.modified().unwrap()
        );
        assert_eq!(leaves(&root), vec!["games.pgn"]);
        assert!(!registry.try_exists().unwrap());
        state
            .pgn_path_authority
            .with_mut(|authority| {
                assert!(!authority.has_pending_artifact_filename(Path::new("games.pgn")));
            })
            .unwrap();
        let progress = state.progress_state.get(&job_id).unwrap().unwrap();
        assert_eq!(progress.state, ProgressState::Failed);
        assert!(progress.finished);
        assert!(!state.operations.cancel_download(&job_id, "test").unwrap());
        let next = state.operations.prepare_download("test").unwrap();
        let next_lease = state
            .operations
            .claim_download(
                &next,
                "test",
                "test download",
                &job_id,
                &job_id,
                false,
                MAX_ACTIVE_DOWNLOADS,
            )
            .unwrap();
        drop(next_lease);
    }

    #[tokio::test]
    async fn payload_download_refuses_zip_without_publication_and_finishes_failed() {
        let dir = tempdir().unwrap();
        let (authority, destination, download_root) = test_downloads_destination(&dir);
        let state = AppState {
            http_transport: Arc::new(zip_response(zip_payload())),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let progress_id = "payload_zip_refused";
        let (job_id, lease) = test_download_lease(&state);
        let error = download_to_destination(
            progress_id,
            "https://example.com/games.zip",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            None,
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid input: Archive payload is not allowed for this operation"
        );
        assert!(leaves(&download_root).is_empty());
        let progress = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(progress.state, ProgressState::Failed);
        assert!(progress.finished);
    }

    #[tokio::test]
    async fn payload_download_refuses_engine_class_before_integrity_and_transport() {
        use crate::infra::path_authority::{AppOwnedRoot, PathAuthority, PathOperation};

        let dir = tempdir().unwrap();
        let download_root = dir.path().join("downloads");
        std::fs::create_dir(&download_root).unwrap();
        let root = AppOwnedRoot::new(
            "downloads",
            download_root.clone(),
            vec![PathOperation::DownloadFile, PathOperation::EngineExecute],
        );
        let destination = root.id.clone();
        let authority =
            PathAuthority::open(dir.path().join("path-authority.json"), vec![root]).unwrap();
        let transport = Arc::new(MockTransport {
            responses: Mutex::new(vec![Ok(mock_successful_response(b"plain bytes"))]),
            requests_seen: Mutex::new(vec![]),
        });
        let state = AppState {
            http_transport: transport.clone(),
            ..AppState::default()
        };
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let progress_id = "payload_engine_refused";
        let (job_id, lease) = test_download_lease(&state);
        let error = download_to_destination(
            progress_id,
            "https://example.com/engine",
            destination,
            "engine".into(),
            app.handle(),
            &state,
            None,
            None,
            job_id,
            lease,
            false,
            None,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Invalid input: Payload download requires a plain-file operation"
        );
        assert!(transport.requests_seen.lock().unwrap().is_empty());
        assert!(leaves(&download_root).is_empty());
        assert!(state.progress_state.get(progress_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn runtime_callers_pin_download_target_replacement_durability_override() {
        let _guard = ResetAtomicInjectorGuard;
        let dir = tempdir().unwrap();
        let (authority, destination, download_root) = test_downloads_destination(&dir);
        let mut state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();

        // 1. download_to_destination caller with temporary-file install and injected target parent-sync failure
        let pgn_content: &'static [u8] = b"1. e4 c5 2. Nf3 d6";
        state.http_transport = mock_successful_transport(pgn_content);

        // Skip reservation journal (1); fail target replacement parent sync (2).
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(TargetParentSyncFault {
            skip: std::sync::atomic::AtomicUsize::new(1),
        })));

        let (job_id, lease) = test_download_lease(&state);
        let result = download_to_destination(
            "progress_download_override",
            "https://example.com/games.pgn",
            destination.clone(),
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap()
        .0
        .expect("artifact publication");

        assert!(matches!(
            result.durability,
            crate::infra::path_authority::CommitDurability::DurabilityUncertain(
                crate::error::DurabilityStage::DownloadTargetReplacement
            )
        ));
        assert_eq!(
            std::fs::read(download_root.join("games.pgn")).unwrap(),
            pgn_content
        );
        {
            let auth = state.pgn_path_authority.raw_for_test().lock().unwrap();
            assert!(auth
                .as_ref()
                .unwrap()
                .has_persistent_id(&result.handle.id.id));
        }

        // 2. install_staged_pgn_artifact caller with actual temporary file and injected target parent-sync failure
        // Skip reservation journal (1); fail target replacement parent sync (2)
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(TargetParentSyncFault {
            skip: std::sync::atomic::AtomicUsize::new(1),
        })));

        let staged_content = b"1. d4 Nf6 2. c4 g6";
        let mut staged_file = tempfile::NamedTempFile::new().unwrap();
        staged_file.write_all(staged_content).unwrap();

        let staged_result = install_staged_pgn_artifact(
            destination.clone(),
            "staged_games.pgn".into(),
            staged_file,
            &state,
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

        assert!(matches!(
            staged_result.durability,
            crate::infra::path_authority::CommitDurability::DurabilityUncertain(
                crate::error::DurabilityStage::DownloadTargetReplacement
            )
        ));
        assert_eq!(
            std::fs::read(download_root.join("staged_games.pgn")).unwrap(),
            staged_content
        );
        {
            let auth = state.pgn_path_authority.raw_for_test().lock().unwrap();
            assert!(auth
                .as_ref()
                .unwrap()
                .has_persistent_id(&staged_result.handle.id.id));
        }
    }

    #[tokio::test]
    async fn no_reservation_uncertainty_reports_failed_progress() {
        let _guard = ResetAtomicInjectorGuard;
        let dir = tempdir().unwrap();
        let (authority, destination, download_root) = test_downloads_destination(&dir);
        let mut state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let pgn_content: &'static [u8] = b"1. e4 c5 2. Nf3 d6";
        state.http_transport = mock_successful_transport(pgn_content);

        // The ordinary target replacement is the first parent sync and must report
        // committed-but-uncertain durability terminally.
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(TargetParentSyncFault {
            skip: std::sync::atomic::AtomicUsize::new(0),
        })));

        let progress_id = "progress_no_reservation_uncertainty";
        let (job_id, lease) = test_download_lease(&state);
        let error = download_to_destination(
            progress_id,
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            false,
            None,
            None,
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::DownloadTargetReplacement
            )
        ));
        let progress = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(progress.state, ProgressState::Failed);
        assert!(progress.finished);
        assert_eq!(
            std::fs::read(download_root.join("games.pgn")).unwrap(),
            pgn_content
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn staged_artifact_resolution_refusal_leaves_no_additional_pending_state() {
        use crate::infra::path_authority::{set_resolve_pre_root_open_hook, PathOperation};

        struct ResetResolveHook;
        impl Drop for ResetResolveHook {
            fn drop(&mut self) {
                set_resolve_pre_root_open_hook(None);
            }
        }
        let _hook_owner = ResetResolveHook;
        let dir = tempdir().unwrap();
        let (mut authority, destination, download_root) = test_downloads_destination(&dir);
        authority
            .reserve_download_artifact(
                &destination,
                "existing.pgn".into(),
                (8, format!("{:x}", Sha256::digest(b"existing"))),
                "existing",
                vec![PathOperation::ReadPgn],
            )
            .unwrap();
        let registry = dir.path().join("path-authority.json");
        let before = std::fs::read(&registry).unwrap();
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let mut staged = tempfile::NamedTempFile::new().unwrap();
        staged.write_all(b"1. e4 e5 *").unwrap();

        let retained = dir.path().join("retained-downloads");
        let hook_root = download_root.clone();
        let hook_retained = retained.clone();
        let reached = std::rc::Rc::new(std::cell::Cell::new(false));
        let hook_reached = reached.clone();
        set_resolve_pre_root_open_hook(Some(Box::new(move || {
            // Identity validation has passed. Native root opening must reject the substitute.
            std::fs::rename(&hook_root, hook_retained).unwrap();
            std::fs::create_dir(&hook_root).unwrap();
            hook_reached.set(true);
        })));
        let result = install_staged_pgn_artifact(
            destination,
            "refused.pgn".into(),
            staged,
            &state,
            &CancellationToken::new(),
            None,
        )
        .await;
        assert!(
            reached.get(),
            "the real resolution boundary must be reached"
        );
        std::fs::remove_dir(&download_root).unwrap();
        std::fs::rename(&retained, &download_root).unwrap();
        assert!(
            matches!(result, Err(Error::Conflict(ref message)) if message == "root changed concurrently"),
            "expected native root identity refusal, got {result:?}"
        );
        let live_pending = state
            .pgn_path_authority
            .with_mut(|authority| {
                assert!(authority.has_pending_artifact_filename(Path::new("existing.pgn")));
                authority.has_pending_artifact_filename(Path::new("refused.pgn"))
            })
            .unwrap();
        let disk_unchanged = std::fs::read(&registry).unwrap() == before;
        let reopened = test_path_authority(&dir);
        assert!(reopened.has_pending_artifact_filename(Path::new("existing.pgn")));
        let reopened_pending = reopened.has_pending_artifact_filename(Path::new("refused.pgn"));
        assert!(
            !live_pending && disk_unchanged && !reopened_pending,
            "RESOLVE_BEFORE_RESERVE: refusal must add no pending state: live_pending={live_pending}, disk_unchanged={disk_unchanged}, reopened_pending={reopened_pending}"
        );
        assert!(
            leaves(&download_root).is_empty(),
            "refusal must not publish a PGN"
        );
    }

    #[tokio::test]
    async fn staged_artifact_cancels_at_real_install_precommit_without_publication() {
        let _guard = ResetAtomicInjectorGuard;
        let dir = tempdir().unwrap();
        let (authority, destination, download_root) = test_downloads_destination(&dir);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let state = Arc::new(state);
        let target = download_root.join("held-install.pgn");
        std::fs::write(&target, b"previous").unwrap();
        let mut staged = tempfile::NamedTempFile::new().unwrap();
        staged.write_all(b"replacement").unwrap();
        let cancellation = CancellationToken::new();
        let task_cancellation = cancellation.clone();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(HoldSecondPrecommit {
            seen: std::sync::atomic::AtomicUsize::new(0),
            entered: std::sync::Mutex::new(Some(entered_tx)),
            release: std::sync::Mutex::new(release_rx),
        })));
        let task_state = Arc::clone(&state);
        let task = tokio::spawn(async move {
            install_staged_pgn_artifact(
                destination,
                "held-install.pgn".into(),
                staged,
                &task_state,
                &task_cancellation,
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), entered_rx)
            .await
            .unwrap()
            .unwrap();
        cancellation.cancel();
        release_tx.send(()).unwrap();
        assert!(matches!(task.await.unwrap(), Err(Error::Cancellation)));
        assert_eq!(std::fs::read(target).unwrap(), b"previous");
    }

    #[tokio::test]
    async fn staged_artifact_keeps_postrename_result_and_activation_after_late_cancellation() {
        let _guard = ResetAtomicInjectorGuard;
        let dir = tempdir().unwrap();
        let (authority, destination, download_root) = test_downloads_destination(&dir);
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let cancellation = CancellationToken::new();
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(CancelSecondParentSync {
            seen: std::sync::atomic::AtomicUsize::new(0),
            cancellation: cancellation.clone(),
        })));
        let mut staged = tempfile::NamedTempFile::new().unwrap();
        staged.write_all(b"committed").unwrap();
        let artifact = install_staged_pgn_artifact(
            destination,
            "late-cancel.pgn".into(),
            staged,
            &state,
            &cancellation,
            None,
        )
        .await
        .unwrap();

        assert!(cancellation.is_cancelled());
        assert_eq!(
            std::fs::read(download_root.join("late-cancel.pgn")).unwrap(),
            b"committed"
        );
        assert!(state
            .pgn_path_authority
            .raw_for_test()
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .has_persistent_id(&artifact.handle.id.id));
    }

    type ObserverAction =
        Box<dyn Fn(crate::infra::path_authority::ActivationObserverStage) + Send + Sync>;

    struct SharedActivationObserver {
        corrupt_target: Option<PathBuf>,
        action: Option<ObserverAction>,
    }

    impl crate::infra::path_authority::ActivationObserver for SharedActivationObserver {
        fn observe(&self, stage: crate::infra::path_authority::ActivationObserverStage) {
            if stage == crate::infra::path_authority::ActivationObserverStage::BeforeRead {
                if let Some(target) = &self.corrupt_target {
                    std::fs::write(target, b"corrupted payload bytes that do not match")
                        .expect("fs::write must succeed in test observer");
                }
            }
            if let Some(action) = &self.action {
                action(stage);
            }
        }
    }

    #[track_caller]
    fn assert_activation_conflict_with_target_durability_warning(
        error: &Error,
        capture: &crate::error::LogCaptureScope,
    ) {
        match error {
            Error::Conflict(message) => {
                assert_eq!(
                    message,
                    "download artifact payload differs from its durable reservation"
                );
            }
            other => panic!("expected Error::Conflict with payload mismatch, got {other:?}"),
        }
        assert_eq!(
            capture
                .records()
                .iter()
                .filter(|record| {
                    record.level == log::Level::Warn
                        && record
                            .message
                            .contains("download target replacement parent sync failed")
                })
                .count(),
            1,
            "target durability uncertainty must be logged exactly once before activation fails"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn download_activation_failure_records_target_durability_uncertainty() {
        let _guard = ResetAtomicInjectorGuard;
        let capture = crate::error::LogCaptureScope::start();
        let dir = tempdir().unwrap();
        let (mut authority, destination, download_root) = test_downloads_destination(&dir);
        authority.set_activation_observer(Some(Arc::new(SharedActivationObserver {
            corrupt_target: Some(download_root.join("games.pgn")),
            action: None,
        })));
        let mut state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let pgn_content: &'static [u8] = b"1. e4 e5 2. Nf3 Nc6";
        state.http_transport = mock_successful_transport(pgn_content);

        // Skip the reservation journal sync; fail the target replacement sync.
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(TargetParentSyncFault {
            skip: std::sync::atomic::AtomicUsize::new(1),
        })));
        let progress_id = "progress_activation_failure_uncertainty";
        let (job_id, lease) = test_download_lease(&state);
        let error = download_to_destination(
            progress_id,
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();

        let progress = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(progress.state, ProgressState::Failed);
        assert!(progress.finished);
        assert_activation_conflict_with_target_durability_warning(&error, &capture);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn staged_artifact_activation_failure_records_target_durability_uncertainty() {
        let _guard = ResetAtomicInjectorGuard;
        let capture = crate::error::LogCaptureScope::start();
        let dir = tempdir().unwrap();
        let (mut authority, destination, download_root) = test_downloads_destination(&dir);
        authority.set_activation_observer(Some(Arc::new(SharedActivationObserver {
            corrupt_target: Some(download_root.join("staged_games.pgn")),
            action: None,
        })));
        let state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let mut staged = tempfile::NamedTempFile::new().unwrap();
        staged.write_all(b"1. d4 Nf6 2. c4 g6").unwrap();

        // Skip the reservation journal sync; fail the target replacement sync.
        crate::infra::fs::set_test_atomic_file_injector(Some(Arc::new(TargetParentSyncFault {
            skip: std::sync::atomic::AtomicUsize::new(1),
        })));
        let error = install_staged_pgn_artifact(
            destination,
            "staged_games.pgn".into(),
            staged,
            &state,
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap_err();

        assert_activation_conflict_with_target_durability_warning(&error, &capture);
    }

    #[tokio::test]
    async fn download_verification_failure_records_failed_progress_and_quarantines_intent() {
        let dir = tempdir().unwrap();
        let (mut authority, destination, download_root) = test_downloads_destination(&dir);
        let target_file = download_root.join("games.pgn");

        let observer = Arc::new(SharedActivationObserver {
            corrupt_target: Some(target_file),
            action: None,
        });
        authority.set_activation_observer(Some(observer));

        let mut state = AppState::default();
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();

        let pgn_content: &'static [u8] = b"1. e4 e5 2. Nf3 Nc6";
        state.http_transport = mock_successful_transport(pgn_content);

        let (job_id, lease) = test_download_lease(&state);
        let err = download_to_destination(
            "progress_verify_fail",
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, Error::Conflict(_)));
        let progress_item = state
            .progress_state
            .get("progress_verify_fail")
            .unwrap()
            .unwrap();
        assert_eq!(progress_item.state, ProgressState::Failed);
        assert!(progress_item.finished);

        let mut auth = state.pgn_path_authority.raw_for_test().lock().unwrap();
        let auth = auth.as_mut().unwrap();
        assert_eq!(auth.descriptors().len(), 1);
        assert!(auth.has_pending_artifact_filename(Path::new("games.pgn")));
    }

    #[tokio::test]
    async fn download_verification_failure_primary_error_survives_stale_or_cleared_lease() {
        let dir = tempdir().unwrap();
        let (mut authority, destination, download_root) = test_downloads_destination(&dir);
        let target_file = download_root.join("games.pgn");

        let mut state = AppState::default();
        let pgn_content: &'static [u8] = b"1. e4 e5 2. Nf3 Nc6";
        state.http_transport = mock_successful_transport(pgn_content);
        let state = Arc::new(state);

        let progress_id = "progress_stale_verify".to_string();
        let action_progress_id = progress_id.clone();
        let state_weak = Arc::downgrade(&state);
        let observer = Arc::new(SharedActivationObserver {
            corrupt_target: Some(target_file),
            action: Some(Box::new(move |stage| {
                if stage == crate::infra::path_authority::ActivationObserverStage::BeforeRead {
                    let state = state_weak
                        .upgrade()
                        .expect("state_weak upgrade must succeed");
                    state.progress_state.clear(&action_progress_id).unwrap();
                }
            })),
        });
        authority.set_activation_observer(Some(observer));
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();

        let (job_id, lease) = test_download_lease(&state);
        let err = download_to_destination(
            "progress_stale_verify",
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();

        match &err {
            Error::Conflict(msg) => {
                assert_eq!(
                    msg,
                    "download artifact payload differs from its durable reservation"
                );
            }
            other => panic!("expected Error::Conflict with payload mismatch, got {other:?}"),
        }
        assert_eq!(err.category(), crate::error::ErrorCategory::Conflict);
        assert!(state
            .progress_state
            .get("progress_stale_verify")
            .unwrap()
            .is_none());
    }

    struct AuthorityUnsetTransport {
        state_weak: std::sync::Mutex<std::sync::Weak<AppState>>,
        payload: &'static [u8],
    }

    #[async_trait::async_trait]
    impl crate::infra::net::DownloadTransport for AuthorityUnsetTransport {
        async fn request(
            &self,
            _url: &str,
            _headers: HeaderMap,
        ) -> Result<DownloadResponse, Error> {
            let weak = self.state_weak.lock().unwrap().clone();
            let state = weak
                .upgrade()
                .expect("state must be alive during transport request");
            state.pgn_path_authority.uninstall();
            Ok(mock_successful_response(self.payload))
        }
    }

    #[tokio::test]
    async fn download_authority_unavailable_after_transport_setup_records_failed_progress() {
        let dir = tempdir().unwrap();
        let (authority, destination, _) = test_downloads_destination(&dir);
        let mut state = AppState::default();
        let pgn_content: &'static [u8] = b"1. e4 e5 2. Nf3 Nc6";
        let transport = Arc::new(AuthorityUnsetTransport {
            state_weak: std::sync::Mutex::new(std::sync::Weak::new()),
            payload: pgn_content,
        });
        state.http_transport = transport.clone();
        let state = Arc::new(state);
        *transport.state_weak.lock().unwrap() = Arc::downgrade(&state);
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();

        let (job_id, lease) = test_download_lease(&state);
        let progress_id = "progress_authority_unavailable";
        let err = download_to_destination(
            progress_id,
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();

        assert!(matches!(err, Error::Conflict(_)));
        assert_eq!(err.category(), crate::error::ErrorCategory::Conflict);
        let progress_item = state.progress_state.get(progress_id).unwrap().unwrap();
        assert_eq!(progress_item.state, ProgressState::Failed);
        assert!(progress_item.finished);
    }

    async fn run_post_verification_lease_case(
        replace_with_new_lease: bool,
    ) -> (
        Option<crate::progress::ProgressItem>,
        crate::infra::path_authority::ArtifactPublication,
    ) {
        let dir = tempdir().unwrap();
        let (mut authority, destination, download_root) = test_downloads_destination(&dir);

        let mut state = AppState::default();
        let pgn_content: &'static [u8] = b"1. e4 e5 2. Nf3 Nc6";
        state.http_transport = mock_successful_transport(pgn_content);
        let state = Arc::new(state);

        let progress_id = "progress_post_verify";
        let action_progress_id = progress_id.to_string();
        let state_weak = Arc::downgrade(&state);
        let observer = Arc::new(SharedActivationObserver {
            corrupt_target: None,
            action: Some(Box::new(move |stage| {
                if stage == crate::infra::path_authority::ActivationObserverStage::PostVerification
                {
                    let state = state_weak
                        .upgrade()
                        .expect("state_weak upgrade must succeed");
                    if replace_with_new_lease {
                        state
                            .progress_state
                            .start(action_progress_id.clone())
                            .unwrap();
                    } else {
                        state.progress_state.clear(&action_progress_id).unwrap();
                    }
                }
            })),
        });
        authority.set_activation_observer(Some(observer));
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();

        let (job_id, lease) = test_download_lease(&state);
        let publication = download_to_destination(
            progress_id,
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            Some(pgn_content.len() as u32),
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .expect("download must succeed despite stale terminal progress")
        .0
        .expect("registered pgn artifact publication must be present");

        {
            let mut auth = state.pgn_path_authority.raw_for_test().lock().unwrap();
            let auth = auth.as_mut().unwrap();
            assert!(auth
                .resolve(
                    publication.handle.path_ref(),
                    crate::infra::path_authority::PathOperation::ReadPgn,
                    &[]
                )
                .is_ok());
            assert!(auth.has_persistent_id(&publication.handle.id.id));
        }

        assert_eq!(
            std::fs::read(download_root.join("games.pgn")).unwrap(),
            pgn_content
        );

        let item = state.progress_state.get(progress_id).unwrap();
        (item, publication)
    }

    #[tokio::test]
    async fn download_post_verification_stale_or_replaced_lease_preserves_published_artifact() {
        // Case 1: Replaced lease leaves replacement progress Running and preserves published capability
        let (item, publication) = run_post_verification_lease_case(true).await;
        assert_eq!(
            publication.durability,
            crate::infra::path_authority::CommitDurability::Durable
        );
        let item = item.expect("replacement progress must exist");
        assert_eq!(item.state, ProgressState::Running);
        assert!(!item.finished);
        assert_eq!(item.generation, 2);

        // Case 2: Cleared lease preserves published capability and leaves progress cleared
        let (item, publication) = run_post_verification_lease_case(false).await;
        assert_eq!(
            publication.durability,
            crate::infra::path_authority::CommitDurability::Durable
        );
        assert!(item.is_none());
    }

    struct CancellingTransport {
        job_id: String,
        progress_id: String,
        state_weak: std::sync::Mutex<std::sync::Weak<AppState>>,
        advance_generation: bool,
    }

    #[async_trait::async_trait]
    impl crate::infra::net::DownloadTransport for CancellingTransport {
        async fn request(
            &self,
            _url: &str,
            _headers: HeaderMap,
        ) -> Result<DownloadResponse, Error> {
            let weak = self.state_weak.lock().unwrap().clone();
            let state = weak
                .upgrade()
                .expect("state must be alive during transport request");
            let _ = state.operations.cancel_download(&self.job_id, "test");
            if self.advance_generation {
                state
                    .progress_state
                    .start(self.progress_id.clone())
                    .unwrap();
            }
            Err(Error::Cancellation)
        }
    }

    async fn run_cancellation_lease_case(
        advance_generation: bool,
    ) -> (crate::progress::ProgressItem, Error) {
        let dir = tempdir().unwrap();
        let (authority, destination, _) = test_downloads_destination(&dir);
        let mut state = AppState::default();
        let job_id = state.operations.prepare_download("test").unwrap();
        let progress_id = "progress_cancel";
        let transport = Arc::new(CancellingTransport {
            job_id: job_id.clone(),
            progress_id: progress_id.into(),
            state_weak: std::sync::Mutex::new(std::sync::Weak::new()),
            advance_generation,
        });
        state.http_transport = transport.clone();
        let state = Arc::new(state);
        *transport.state_weak.lock().unwrap() = Arc::downgrade(&state);
        state.pgn_path_authority.install(authority).unwrap();
        let app = test_progress_app();
        let lease = state
            .operations
            .claim_download(
                &job_id,
                "test",
                "test download",
                progress_id,
                progress_id,
                false,
                MAX_ACTIVE_DOWNLOADS,
            )
            .unwrap();

        let err = download_to_destination(
            progress_id,
            "https://example.com/games.pgn",
            destination,
            "games.pgn".into(),
            app.handle(),
            &state,
            None,
            None,
            job_id,
            lease,
            true,
            None,
            None,
        )
        .await
        .unwrap_err();

        let item = state.progress_state.get(progress_id).unwrap().unwrap();
        (item, err)
    }

    #[tokio::test]
    async fn download_cancellation_reporting_with_valid_and_stale_lease() {
        // Case 1: Valid lease cancellation transitions to Cancelled terminal state
        let (valid_item, valid_err) = run_cancellation_lease_case(false).await;
        assert!(matches!(valid_err, Error::Cancellation));
        assert_eq!(valid_item.state, ProgressState::Cancelled);
        assert!(valid_item.finished);

        // Case 2: Stale lease leaves replacement progress Running and returns original Error::Cancellation
        let (stale_item, stale_err) = run_cancellation_lease_case(true).await;
        assert!(matches!(stale_err, Error::Cancellation));
        assert_eq!(stale_item.state, ProgressState::Running);
        assert!(!stale_item.finished);
        assert_eq!(stale_item.progress, 0.0);
        assert_eq!(stale_item.generation, 2);
    }

    struct HeldTailTransport {
        started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: tokio::sync::Notify,
    }

    struct ReleaseHeldTransport(Arc<HeldTailTransport>);

    impl Drop for ReleaseHeldTransport {
        fn drop(&mut self) {
            self.0.release.notify_waiters();
        }
    }

    #[async_trait::async_trait]
    impl crate::infra::net::DownloadTransport for HeldTailTransport {
        async fn request(
            &self,
            _url: &str,
            _headers: HeaderMap,
        ) -> Result<DownloadResponse, Error> {
            if let Some(started) = self.started.lock().unwrap().take() {
                let _ = started.send(());
            }
            self.release.notified().await;
            Ok(mock_successful_response(b"caller-drop-tail"))
        }
    }

    #[tokio::test]
    async fn production_download_core_matrix_keeps_success_and_error_tails_after_caller_drop() {
        for publication_fail in [false, true] {
            let dir = tempdir().unwrap();
            let (authority, destination, download_root) = test_downloads_destination(&dir);
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let transport = Arc::new(HeldTailTransport {
                started: std::sync::Mutex::new(Some(started_tx)),
                release: tokio::sync::Notify::new(),
            });
            let _release_on_drop = ReleaseHeldTransport(transport.clone());
            let state = AppState {
                http_transport: transport.clone(),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let state = Arc::new(state);
            let app = test_progress_app();
            let app_handle = app.handle().clone();
            let owned_state = Arc::clone(&state);
            let job_id = state.operations.prepare_download("test").unwrap();
            let progress_id = format!("caller-drop-{publication_fail}");
            let lease = state
                .operations
                .claim_download(
                    &job_id,
                    "test",
                    "test download",
                    &progress_id,
                    &progress_id,
                    false,
                    MAX_ACTIVE_DOWNLOADS,
                )
                .unwrap();
            let filename = format!("caller-drop-{publication_fail}.bin");
            let task_progress = progress_id.clone();
            let task_filename = filename.clone();
            let operation = tokio::spawn(async move {
                download_to_destination(
                    &task_progress,
                    "https://example.com/held.bin",
                    destination,
                    task_filename,
                    &app_handle,
                    &owned_state,
                    None,
                    None,
                    job_id,
                    lease,
                    true,
                    None,
                    None,
                )
                .await
            });

            tokio::time::timeout(Duration::from_secs(1), started_rx)
                .await
                .unwrap()
                .unwrap();
            operation.abort();
            if publication_fail {
                state.pgn_path_authority.uninstall();
            }
            transport.release.notify_one();
            // Await native completion notification off the runtime thread before checking tails.
            let operations = state.operations.clone();
            let drained = tokio::task::spawn_blocking(move || {
                operations.wait_for_drain(Duration::from_secs(10))
            })
            .await
            .unwrap()
            .unwrap();
            assert!(
                drained,
                "CALLER_DROP_NATIVE_DRAIN: accepted download must finish after caller drop (publication_fail={publication_fail})"
            );

            let item = state.progress_state.get(&progress_id).unwrap().unwrap();
            if publication_fail {
                assert_eq!(item.state, ProgressState::Failed);
                assert!(!download_root.join(filename).exists());
            } else {
                assert_eq!(item.state, ProgressState::Succeeded);
                assert_eq!(
                    std::fs::read(download_root.join(filename)).unwrap(),
                    b"caller-drop-tail"
                );
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn reload_completion_actual_engine_workflow_retains_registered_configuration_after_receiver_drop(
    ) {
        use crate::infra::operations::completions::{
            CompletionOutcome, EngineInstallIntent, EngineInstallRequest,
        };
        for boundary in ["publication", "application", "acknowledgement"] {
            let dir = tempdir().unwrap();
            let authority =
                crate::infra::path_authority::PathAuthority::open_for_engine_test(dir.path())
                    .unwrap();
            let (authority, _, engine_root, root) =
                engine_destination_with_authority(engine_directory(&dir), authority);
            let probe_count = dir.path().join("probes");
            let script = format!("#!/bin/sh\nprintf 'probe\\n' >> '{}'\nwhile IFS= read -r line; do case \"$line\" in uci) echo 'id name Reload Engine'; echo uciok;; isready) echo readyok;; quit) exit 0;; esac; done\n", probe_count.display());
            let payload = gzip_tar_payload(script.as_bytes());
            let integrity = unsigned_test_integrity(&payload);
            let transport = Arc::new(zip_response(payload));
            let state = AppState {
                http_transport: transport.clone(),
                ..AppState::default()
            };
            state.pgn_path_authority.install(authority).unwrap();
            let app = test_progress_app();
            let request = EngineInstallRequest {
                intent: EngineInstallIntent::Add {
                    engine_id: uuid::Uuid::new_v4().to_string(),
                },
                root,
                progress_id: uuid::Uuid::new_v4().to_string(),
                url: "https://example.com/engine.tar.gz".into(),
                sha256: integrity.sha256.clone(),
                signature: integrity.signature.clone(),
                relative_path: "stockfish/engine".into(),
                name: "Engine".into(),
                version: "1".into(),
                elo: None,
                download_size: None,
            };
            let id = uuid::Uuid::new_v4().to_string();
            let ticket = state.operations.prepare_download("main").unwrap();
            let (admitted, lease) = state
                .operations
                .admit_engine_completion(
                    &id,
                    "main",
                    &ticket,
                    request.clone(),
                    MAX_ACTIVE_DOWNLOADS,
                )
                .unwrap();
            let (at_commit_tx, at_commit_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            if boundary == "publication" {
                crate::infra::operations::arm_commit_after_hook(
                    ticket,
                    Box::new(move || {
                        let _ = at_commit_tx.send(());
                        let _ = release_rx.recv_timeout(Duration::from_secs(10));
                    }),
                );
            }
            use tauri::Listener as _;
            use tauri_specta::Event as _;
            let acknowledged = Arc::new(AtomicBool::new(false));
            let observed = acknowledged.clone();
            let operations = state.operations.clone();
            let acknowledged_id = id.clone();
            let listener = app.listen_any(
                crate::infra::operations::completions::CompletionChanged::NAME,
                move |_| {
                    if boundary == "acknowledgement" {
                        operations
                            .acknowledge_engine_completion(&acknowledged_id, "main")
                            .unwrap();
                        observed.store(true, Ordering::SeqCst);
                    }
                },
            );
            let mut command_receiver = Box::pin(run_engine_install_completion(
                admitted,
                lease.unwrap(),
                app.handle().clone(),
                state.clone(),
                Box::new(accept_any_integrity),
                "main".into(),
            ));
            assert!(futures_util::poll!(&mut command_receiver).is_pending());
            if boundary == "acknowledgement" {
                let terminal = command_receiver.await.unwrap();
                app.unlisten(listener);
                assert!(acknowledged.load(Ordering::SeqCst));
                assert!(state.operations.engine_completion(&id, "main").is_err());
                assert!(matches!(terminal.outcome, CompletionOutcome::Succeeded(_)));
                state.engine_supervisor.terminate_all().await.unwrap();
                continue;
            }
            if boundary == "publication" {
                tokio::time::timeout(Duration::from_secs(5), at_commit_rx)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(matches!(
                    state
                        .operations
                        .engine_completion(&id, "main")
                        .unwrap()
                        .outcome,
                    CompletionOutcome::Running
                ));
                drop(command_receiver);
                state.operations.cancel_owner_reservations("main").unwrap();
                assert!(
                    !state
                        .operations
                        .cancel_download_for_progress(&request.progress_id, "main")
                        .unwrap(),
                    "publication already committed cancellation authority"
                );
                release_tx.send(()).unwrap();
            } else {
                tokio::time::timeout(Duration::from_secs(5), async {
                    while matches!(
                        state
                            .operations
                            .engine_completion(&id, "main")
                            .unwrap()
                            .outcome,
                        CompletionOutcome::Running
                    ) {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                drop(command_receiver);
            }
            let operations = state.operations.clone();
            assert!(tokio::task::spawn_blocking(
                move || operations.wait_for_drain(Duration::from_secs(5))
            )
            .await
            .unwrap()
            .unwrap());
            let snapshot = state.operations.engine_completion(&id, "main").unwrap();
            let CompletionOutcome::Succeeded(installed) = snapshot.outcome else {
                panic!("native engine workflow did not retain success: {snapshot:?}")
            };
            assert_eq!(installed.config.name, "Reload Engine");
            assert_eq!(installed.filename, "engine");
            assert_eq!(std::fs::read_to_string(&probe_count).unwrap(), "probe\n");
            assert_eq!(transport.requests_seen.lock().unwrap().len(), 1);
            let (rejoined, repeat) = state
                .operations
                .admit_engine_completion(
                    &id,
                    "main",
                    "no-ticket",
                    request.clone(),
                    MAX_ACTIVE_DOWNLOADS,
                )
                .unwrap();
            assert!(repeat.is_none());
            assert!(matches!(rejoined.outcome, CompletionOutcome::Succeeded(_)));
            assert!(state
                .operations
                .engine_completions("foreign")
                .unwrap()
                .is_empty());
            let authority = state.pgn_path_authority.clone();
            crate::infra::blocking::BLOCKING_GATEWAY
                .spawn(move || {
                    authority.with_mut(|authority| {
                        crate::infra::path_authority::require_durable(
                            authority.reconcile_startup_owners(
                                crate::infra::path_authority::StartupPathOwners {
                                    retained_ids: vec![],
                                    trusted_families: vec![
                                        crate::infra::path_authority::PathOwnerFamily::Engines,
                                    ],
                                },
                            )?,
                        )?;
                        authority.collect_catalog_installs()
                    })?
                })
                .await
                .unwrap();
            assert!(engine_root
                .join(format!("engine.tar.gz-{}/stockfish/engine", request.sha256))
                .exists());
            assert_eq!(
                state
                    .progress_state
                    .get(&request.progress_id)
                    .unwrap()
                    .unwrap()
                    .state,
                ProgressState::Running,
                "success covers renderer application too"
            );
            state
                .operations
                .acknowledge_engine_completion(&id, "main")
                .unwrap();
            state
                .pgn_path_authority
                .with_mut(|authority| authority.release_completion_resources(&id))
                .unwrap();
            assert!(state
                .operations
                .engine_completions("main")
                .unwrap()
                .is_empty());
            state.engine_supervisor.terminate_all().await.unwrap();
            app.unlisten(listener);
        }
    }

    struct ExtractionTestGuard {
        release: Option<std::sync::mpsc::Sender<()>>,
    }

    impl ExtractionTestGuard {
        fn release(&mut self) {
            if let Some(release) = self.release.take() {
                let _ = release.send(());
            }
        }
    }

    impl Drop for ExtractionTestGuard {
        fn drop(&mut self) {
            self.release();
        }
    }

    #[tokio::test]
    async fn staging_deadline_keeps_accepted_lease_until_real_extractor_cleanup() {
        let dir = tempdir().unwrap();
        let archive_path = dir.path().join("held.zip");
        let target = dir.path().join("published-engine");
        write_zip(&archive_path, &[("engine", b"held extraction payload")]);

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mut guard = ExtractionTestGuard {
            release: Some(release_tx),
        };

        let registry = crate::infra::operations::OperationRegistry::default();
        let lease = registry.accept("held engine extraction").unwrap();
        let cancellation = lease.token();
        let deadline_observer = cancellation.clone();
        let worker_cancellation = cancellation.clone();
        let producer = tokio::spawn(crate::infra::blocking::BLOCKING_GATEWAY.spawn_cancellable(
            worker_cancellation,
            move |token| {
                let _reset = ResetArchiveHook;
                set_archive_pre_install_hook(Some(Box::new(move |_| {
                    let _ = entered_tx.send(());
                    release_rx
                        .recv_timeout(Duration::from_secs(5))
                        .expect("extraction release");
                })));
                let pin = crate::infra::fs::open_parent_no_follow(&target)?;
                extract_zip_cancellable(
                    std::fs::File::open(archive_path)?,
                    &pin,
                    target.parent().unwrap(),
                    target.file_name().unwrap(),
                    OpClass::Engine.limits(),
                    token,
                )
            },
        ));

        tokio::time::timeout(Duration::from_secs(5), entered_rx)
            .await
            .unwrap()
            .unwrap();
        let task = tokio::spawn(crate::infra::operations::run_native_operation(
            lease,
            "held engine extraction",
            async move {
                await_staging_deadline(
                    Duration::from_millis(10),
                    &cancellation,
                    "test extraction deadline exceeded",
                    async move {
                        producer.await.map_err(|error| {
                            Error::Conflict(format!("extractor task failed: {error}"))
                        })?
                    },
                )
                .await
            },
        ));
        tokio::time::timeout(Duration::from_secs(1), deadline_observer.cancelled())
            .await
            .expect("the staging deadline must signal cancellation");
        assert!(!registry.wait_for_drain(Duration::ZERO).unwrap());
        assert!(registry
            .outstanding_labels()
            .unwrap()
            .contains(&"held engine extraction".to_owned()));
        assert!(!dir.path().join("published-engine").exists());

        guard.release();
        let result = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(result, Err(Error::EngineTimeout(_))));
        assert!(registry.wait_for_drain(Duration::from_secs(1)).unwrap());
        assert!(!dir.path().join("published-engine").exists());
        assert_eq!(leaves(dir.path()), vec!["held.zip"]);
    }
}
