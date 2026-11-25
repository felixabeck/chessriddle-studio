//! Pure wire parser and request vocabulary for the ChessRiddle Studio Library routes (W-3, W-5).

use crate::{
    chessriddle::AccountError, chessriddle_training::ErrorEnvelope,
    library_sync::LibrarySyncFileStatus,
};
use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Bounded response size for `GET /api/v1/library/studio-files` (100 files with 120-char names
/// exceed the default 64 KiB cap).
pub(crate) const LIBRARY_LIST_MAX_RESPONSE_BYTES: usize = 256 * 1024;
/// Server byte cap per uploaded PGN file (5 MiB).
pub(crate) const LIBRARY_MAX_BYTES: u64 = 5 * 1024 * 1024;

pub(crate) const RETRY_AFTER_DEFAULT: Duration = Duration::from_secs(3);
pub(crate) const RETRY_AFTER_FLOOR: Duration = Duration::from_secs(1);
pub(crate) const RETRY_AFTER_CAP: Duration = Duration::from_secs(60);

/// Accepts only a canonical hyphenated UUID (any ASCII hex case) so an arbitrary string can never
/// be interpolated into a URL path or persisted as a `studio_file_id`.
pub(crate) fn is_valid_studio_file_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id)
        .is_ok_and(|parsed| parsed.hyphenated().to_string().eq_ignore_ascii_case(id))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum LibraryFileKind {
    Repertoire,
    Games,
}

impl LibraryFileKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Repertoire => "repertoire",
            Self::Games => "games",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StudioLibraryFile {
    pub studio_file_id: String,
    pub name: String,
    pub kind: LibraryFileKind,
    pub version: u32,
    #[serde(default)]
    pub content_sha256: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct StudioLibraryList {
    pub account_id: String,
    pub files: Vec<StudioLibraryFile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum LibraryPrecondition {
    Create,
    Replace(u32),
}

impl LibraryPrecondition {
    pub(crate) fn header(&self) -> (&'static str, String) {
        match self {
            Self::Create => ("If-None-Match", "*".to_owned()),
            Self::Replace(version) => ("If-Match", format!("\"{version}\"")),
        }
    }
}

/// The thirteen server `LibraryErrorCode` values plus `Other` for unknown future codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LibraryRejectionCode {
    PgnTooLarge,
    EmptyPgn,
    TooManyGames,
    TooManyMoves,
    PgnTooComplex,
    CommentTooLong,
    InvalidPgn,
    UnsupportedVariant,
    AccountFileLimit,
    AccountStorageLimit,
    NameInvalid,
    ColourRequired,
    InvalidKind,
    Other,
}

impl LibraryRejectionCode {
    pub(crate) fn from_wire(code: Option<&str>) -> Self {
        match code {
            Some("pgn_too_large") => Self::PgnTooLarge,
            Some("empty_pgn") => Self::EmptyPgn,
            Some("too_many_games") => Self::TooManyGames,
            Some("too_many_moves") => Self::TooManyMoves,
            Some("pgn_too_complex") => Self::PgnTooComplex,
            Some("comment_too_long") => Self::CommentTooLong,
            Some("invalid_pgn") => Self::InvalidPgn,
            Some("unsupported_variant") => Self::UnsupportedVariant,
            Some("account_file_limit") => Self::AccountFileLimit,
            Some("account_storage_limit") => Self::AccountStorageLimit,
            Some("name_invalid") => Self::NameInvalid,
            Some("colour_required") => Self::ColourRequired,
            Some("invalid_kind") => Self::InvalidKind,
            _ => Self::Other,
        }
    }

    /// Only rejections that depend purely on the file's bytes are memoised against `content_sha256`.
    pub(crate) fn is_file_intrinsic(self) -> bool {
        matches!(
            self,
            Self::PgnTooLarge
                | Self::EmptyPgn
                | Self::TooManyGames
                | Self::TooManyMoves
                | Self::PgnTooComplex
                | Self::CommentTooLong
                | Self::InvalidPgn
                | Self::UnsupportedVariant
        )
    }

    pub(crate) fn is_account_capacity(self) -> bool {
        matches!(self, Self::AccountFileLimit | Self::AccountStorageLimit)
    }

    pub(crate) fn to_file_status(self, game_number: Option<u32>) -> LibrarySyncFileStatus {
        match self {
            Self::PgnTooLarge => LibrarySyncFileStatus::TooLarge,
            Self::EmptyPgn => LibrarySyncFileStatus::Empty,
            Self::TooManyGames => LibrarySyncFileStatus::TooManyGames,
            Self::TooManyMoves => LibrarySyncFileStatus::TooManyMoves,
            Self::PgnTooComplex => LibrarySyncFileStatus::TooComplex,
            Self::CommentTooLong => LibrarySyncFileStatus::CommentTooLong,
            Self::InvalidPgn => LibrarySyncFileStatus::InvalidPgn { game_number },
            Self::UnsupportedVariant => LibrarySyncFileStatus::UnsupportedVariant,
            Self::AccountFileLimit => LibrarySyncFileStatus::LibraryFull,
            Self::AccountStorageLimit => LibrarySyncFileStatus::StorageFull,
            Self::NameInvalid | Self::ColourRequired | Self::InvalidKind | Self::Other => {
                LibrarySyncFileStatus::Rejected
            }
        }
    }
}

/// Shared transport/protocol error vocabulary across list, put and delete requests.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LibraryRequestError {
    Busy { retry_after: Duration },
    RateLimited { retry_after: Duration },
    Unsupported,
    AccountChanged,
    Account(AccountError),
}

/// Application-level response outcomes of a Library PUT request.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LibraryPutResponse {
    Saved(StudioLibraryFile),
    PreconditionFailed {
        version: Option<u32>,
    },
    Rejected {
        code: LibraryRejectionCode,
        game_number: Option<u32>,
    },
}

pub(crate) type LibraryListOutcome = Result<(u64, StudioLibraryList), LibraryRequestError>;
pub(crate) type LibraryPutOutcome = Result<LibraryPutResponse, LibraryRequestError>;
pub(crate) type LibraryDeleteOutcome = Result<(), LibraryRequestError>;

pub(crate) fn parse_retry_after(headers: &HeaderMap) -> Duration {
    let parsed = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(Duration::from_secs);
    match parsed {
        Some(duration) => duration.clamp(RETRY_AFTER_FLOOR, RETRY_AFTER_CAP),
        None => RETRY_AFTER_DEFAULT,
    }
}

fn is_desktop_route_forbidden(status: u16, envelope: &ErrorEnvelope) -> bool {
    status == 403
        && (envelope.reason() == Some("desktop_route_forbidden")
            || envelope.code() == Some("desktop_route_forbidden"))
}

fn is_library_busy(status: u16, envelope: &ErrorEnvelope) -> bool {
    status == 503 && envelope.code() == Some("LIBRARY_BUSY")
}

fn extract_u32(value: Option<&serde_json::Value>) -> Option<u32> {
    value
        .and_then(serde_json::Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
}

fn parse_common_error(
    status: u16,
    headers: &HeaderMap,
    envelope: &ErrorEnvelope,
    not_found_is_unsupported: bool,
) -> LibraryRequestError {
    if is_desktop_route_forbidden(status, envelope)
        || status == 405
        || (not_found_is_unsupported && status == 404)
    {
        return LibraryRequestError::Unsupported;
    }
    if is_library_busy(status, envelope) {
        return LibraryRequestError::Busy {
            retry_after: parse_retry_after(headers),
        };
    }
    match status {
        429 => LibraryRequestError::RateLimited {
            retry_after: parse_retry_after(headers),
        },
        401 => LibraryRequestError::Account(AccountError::Authentication),
        _ => LibraryRequestError::Account(AccountError::Server),
    }
}

pub(crate) fn parse_list_response(
    epoch: u64,
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
) -> LibraryListOutcome {
    if status == 200 {
        return match serde_json::from_slice::<StudioLibraryList>(body) {
            Ok(mut list) if !list.account_id.trim().is_empty() => {
                let before = list.files.len();
                list.files
                    .retain(|file| is_valid_studio_file_id(&file.studio_file_id));
                if list.files.len() != before {
                    log::warn!(
                        "ignored {} library list entries with non-UUID studio_file_id",
                        before - list.files.len()
                    );
                }
                Ok((epoch, list))
            }
            _ => Err(LibraryRequestError::Account(AccountError::Server)),
        };
    }
    let envelope = ErrorEnvelope::parse(body);
    Err(parse_common_error(status, headers, &envelope, true))
}

pub(crate) fn parse_put_response(
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
) -> LibraryPutOutcome {
    if matches!(status, 200 | 201) {
        return match serde_json::from_slice::<StudioLibraryFile>(body) {
            Ok(file) if is_valid_studio_file_id(&file.studio_file_id) => {
                Ok(LibraryPutResponse::Saved(file))
            }
            _ => Err(LibraryRequestError::Account(AccountError::Server)),
        };
    }
    let envelope = ErrorEnvelope::parse(body);
    match status {
        412 => {
            let version = envelope
                .details()
                .and_then(|details| extract_u32(details.get("version")));
            Ok(LibraryPutResponse::PreconditionFailed { version })
        }
        422 => {
            let details = envelope.details();
            let code = LibraryRejectionCode::from_wire(
                details
                    .and_then(|d| d.get("error_code"))
                    .and_then(serde_json::Value::as_str),
            );
            let game_number = details.and_then(|d| extract_u32(d.get("game_number")));
            Ok(LibraryPutResponse::Rejected { code, game_number })
        }
        _ => Err(parse_common_error(status, headers, &envelope, true)),
    }
}

pub(crate) fn parse_delete_response(
    status: u16,
    headers: &HeaderMap,
    body: &[u8],
) -> LibraryDeleteOutcome {
    if matches!(status, 204 | 404) {
        return Ok(());
    }
    let envelope = ErrorEnvelope::parse(body);
    Err(parse_common_error(status, headers, &envelope, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::HeaderValue;
    use serde_json::json;

    #[test]
    fn retry_after_clamps_floor_cap_and_defaults() {
        let empty = HeaderMap::new();
        assert_eq!(parse_retry_after(&empty), Duration::from_secs(3));

        let mut zero = HeaderMap::new();
        zero.insert(reqwest::header::RETRY_AFTER, HeaderValue::from_static("0"));
        assert_eq!(parse_retry_after(&zero), Duration::from_secs(1));

        let mut large = HeaderMap::new();
        large.insert(
            reqwest::header::RETRY_AFTER,
            HeaderValue::from_static("3600"),
        );
        assert_eq!(parse_retry_after(&large), Duration::from_secs(60));

        let mut mid = HeaderMap::new();
        mid.insert(reqwest::header::RETRY_AFTER, HeaderValue::from_static("12"));
        assert_eq!(parse_retry_after(&mid), Duration::from_secs(12));

        let mut invalid = HeaderMap::new();
        invalid.insert(
            reqwest::header::RETRY_AFTER,
            HeaderValue::from_static("not-a-number"),
        );
        assert_eq!(parse_retry_after(&invalid), Duration::from_secs(3));
    }

    #[test]
    fn studio_file_id_validation_rejects_non_uuids_and_path_traversal() {
        assert!(is_valid_studio_file_id(
            "11111111-1111-4111-8111-111111111111"
        ));
        assert!(!is_valid_studio_file_id("../other"));
        assert!(!is_valid_studio_file_id("not-a-uuid"));
        assert!(!is_valid_studio_file_id("11111111111141118111111111111111"));
        assert!(!is_valid_studio_file_id(""));
    }

    #[test]
    fn list_response_handles_success_filters_invalid_ids_and_maps_failures() {
        let headers = HeaderMap::new();
        let ok_body = serde_json::to_vec(&json!({
            "account_id": "user-42",
            "files": [
                {
                    "studio_file_id": "11111111-1111-4111-8111-111111111111",
                    "name": "Sicilian",
                    "kind": "repertoire",
                    "version": 2,
                    "content_sha256": "abc"
                },
                {
                    "studio_file_id": "../evil",
                    "name": "Evil",
                    "kind": "games",
                    "version": 1,
                    "content_sha256": "def"
                }
            ]
        }))
        .unwrap();
        assert_eq!(
            parse_list_response(7, 200, &headers, &ok_body),
            Ok((
                7,
                StudioLibraryList {
                    account_id: "user-42".into(),
                    files: vec![StudioLibraryFile {
                        studio_file_id: "11111111-1111-4111-8111-111111111111".into(),
                        name: "Sicilian".into(),
                        kind: LibraryFileKind::Repertoire,
                        version: 2,
                        content_sha256: Some("abc".into()),
                    }],
                },
            ))
        );

        let forbidden = serde_json::to_vec(&json!({
            "error": { "code": "FORBIDDEN", "details": { "reason": "desktop_route_forbidden" } }
        }))
        .unwrap();
        assert_eq!(
            parse_list_response(7, 403, &headers, &forbidden),
            Err(LibraryRequestError::Unsupported)
        );
        assert_eq!(
            parse_list_response(7, 404, &headers, b""),
            Err(LibraryRequestError::Unsupported)
        );
        assert_eq!(
            parse_list_response(7, 405, &headers, b""),
            Err(LibraryRequestError::Unsupported)
        );

        let busy_body =
            serde_json::to_vec(&json!({ "error": { "code": "LIBRARY_BUSY" } })).unwrap();
        let mut busy_headers = HeaderMap::new();
        busy_headers.insert(reqwest::header::RETRY_AFTER, HeaderValue::from_static("5"));
        assert_eq!(
            parse_list_response(7, 503, &busy_headers, &busy_body),
            Err(LibraryRequestError::Busy {
                retry_after: Duration::from_secs(5),
            })
        );

        assert_eq!(
            parse_list_response(7, 429, &busy_headers, b""),
            Err(LibraryRequestError::RateLimited {
                retry_after: Duration::from_secs(5),
            })
        );
        assert_eq!(
            parse_list_response(7, 401, &headers, b""),
            Err(LibraryRequestError::Account(AccountError::Authentication))
        );
    }

    #[test]
    fn put_response_handles_precondition_rejections_and_statuses() {
        let headers = HeaderMap::new();
        let mismatch = serde_json::to_vec(&json!({
            "error": {
                "code": "PRECONDITION_FAILED",
                "details": { "error_code": "version_mismatch", "version": 4 }
            }
        }))
        .unwrap();
        assert_eq!(
            parse_put_response(412, &headers, &mismatch),
            Ok(LibraryPutResponse::PreconditionFailed { version: Some(4) })
        );

        let mismatch_absent = serde_json::to_vec(&json!({
            "error": {
                "code": "PRECONDITION_FAILED",
                "details": { "error_code": "version_mismatch", "version": null }
            }
        }))
        .unwrap();
        assert_eq!(
            parse_put_response(412, &headers, &mismatch_absent),
            Ok(LibraryPutResponse::PreconditionFailed { version: None })
        );

        let rejected = serde_json::to_vec(&json!({
            "error": {
                "code": "VALIDATION_ERROR",
                "details": { "error_code": "invalid_pgn", "game_number": 3 }
            }
        }))
        .unwrap();
        assert_eq!(
            parse_put_response(422, &headers, &rejected),
            Ok(LibraryPutResponse::Rejected {
                code: LibraryRejectionCode::InvalidPgn,
                game_number: Some(3),
            })
        );
    }

    #[test]
    fn delete_response_treats_204_and_404_as_deleted() {
        let headers = HeaderMap::new();
        assert_eq!(parse_delete_response(204, &headers, b""), Ok(()));
        assert_eq!(parse_delete_response(404, &headers, b""), Ok(()));
        assert_eq!(
            parse_delete_response(405, &headers, b""),
            Err(LibraryRequestError::Unsupported)
        );
    }

    #[test]
    fn rejection_code_classification_matches_plan() {
        for intrinsic in [
            LibraryRejectionCode::PgnTooLarge,
            LibraryRejectionCode::EmptyPgn,
            LibraryRejectionCode::TooManyGames,
            LibraryRejectionCode::TooManyMoves,
            LibraryRejectionCode::PgnTooComplex,
            LibraryRejectionCode::CommentTooLong,
            LibraryRejectionCode::InvalidPgn,
            LibraryRejectionCode::UnsupportedVariant,
        ] {
            assert!(intrinsic.is_file_intrinsic());
            assert!(!intrinsic.is_account_capacity());
        }
        for non_intrinsic in [
            LibraryRejectionCode::AccountFileLimit,
            LibraryRejectionCode::AccountStorageLimit,
            LibraryRejectionCode::NameInvalid,
            LibraryRejectionCode::ColourRequired,
            LibraryRejectionCode::InvalidKind,
            LibraryRejectionCode::Other,
        ] {
            assert!(!non_intrinsic.is_file_intrinsic());
        }
        assert!(LibraryRejectionCode::AccountFileLimit.is_account_capacity());
        assert!(LibraryRejectionCode::AccountStorageLimit.is_account_capacity());
    }

    #[test]
    fn shared_wire_samples_parse_into_expected_outcomes() {
        let headers = HeaderMap::new();

        let list = parse_list_response(
            9,
            200,
            &headers,
            include_str!("../library_sync_samples/list.json").as_bytes(),
        );
        assert_eq!(
            list,
            Ok((
                9,
                StudioLibraryList {
                    account_id: "11111111-1111-4111-8111-111111111111".into(),
                    files: vec![
                        StudioLibraryFile {
                            studio_file_id: "22222222-2222-4222-8222-222222222222".into(),
                            name: "Sicilian Najdorf".into(),
                            kind: LibraryFileKind::Repertoire,
                            version: 2,
                            content_sha256: Some(
                                "a3f5c9e1d2b4068795a1c3e5f7091b2d4f6a8c0e2a4c6e8f0123456789abcdef"
                                    .into()
                            ),
                        },
                        StudioLibraryFile {
                            studio_file_id: "33333333-3333-4333-8333-333333333333".into(),
                            name: "Autumn Open".into(),
                            kind: LibraryFileKind::Games,
                            version: 1,
                            content_sha256: Some(
                                "fedcba9876543210f8e6c4a2e0c8a6f4d2b1907f5e3c1a5978604b2d1e9c5f3a"
                                    .into()
                            ),
                        },
                    ],
                },
            ))
        );

        let created = parse_put_response(
            201,
            &headers,
            include_str!("../library_sync_samples/created.json").as_bytes(),
        );
        assert_eq!(
            created,
            Ok(LibraryPutResponse::Saved(StudioLibraryFile {
                studio_file_id: "22222222-2222-4222-8222-222222222222".into(),
                name: "Sicilian Najdorf".into(),
                kind: LibraryFileKind::Repertoire,
                version: 1,
                content_sha256: Some(
                    "a3f5c9e1d2b4068795a1c3e5f7091b2d4f6a8c0e2a4c6e8f0123456789abcdef".into()
                ),
            }))
        );

        let replaced = parse_put_response(
            200,
            &headers,
            include_str!("../library_sync_samples/replaced.json").as_bytes(),
        );
        assert_eq!(
            replaced,
            Ok(LibraryPutResponse::Saved(StudioLibraryFile {
                studio_file_id: "22222222-2222-4222-8222-222222222222".into(),
                name: "Sicilian Najdorf (updated)".into(),
                kind: LibraryFileKind::Games,
                version: 2,
                content_sha256: Some(
                    "fedcba9876543210f8e6c4a2e0c8a6f4d2b1907f5e3c1a5978604b2d1e9c5f3a".into()
                ),
            }))
        );

        let mismatch = parse_put_response(
            412,
            &headers,
            include_str!("../library_sync_samples/version_mismatch.json").as_bytes(),
        );
        assert_eq!(
            mismatch,
            Ok(LibraryPutResponse::PreconditionFailed { version: Some(3) })
        );

        let mismatch_absent = parse_put_response(
            412,
            &headers,
            include_str!("../library_sync_samples/version_mismatch_absent.json").as_bytes(),
        );
        assert_eq!(
            mismatch_absent,
            Ok(LibraryPutResponse::PreconditionFailed { version: None })
        );

        let rejected = parse_put_response(
            422,
            &headers,
            include_str!("../library_sync_samples/rejected_invalid_pgn.json").as_bytes(),
        );
        assert_eq!(
            rejected,
            Ok(LibraryPutResponse::Rejected {
                code: LibraryRejectionCode::InvalidPgn,
                game_number: Some(2),
            })
        );

        let mut busy_headers = HeaderMap::new();
        busy_headers.insert(reqwest::header::RETRY_AFTER, HeaderValue::from_static("3"));
        let busy = parse_put_response(
            503,
            &busy_headers,
            include_str!("../library_sync_samples/library_busy.json").as_bytes(),
        );
        assert_eq!(
            busy,
            Err(LibraryRequestError::Busy {
                retry_after: Duration::from_secs(3),
            })
        );
    }
}
