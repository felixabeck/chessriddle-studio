//! Native ChessRiddle feedback submission.
//!
//! The renderer supplies the type, message, optional email and an idempotency key. The API URL,
//! Studio marker, version and operating system are assembled here so the webview never passes a
//! URL or a token.

use crate::{error::Error, AppState};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use specta::Type;
use sysinfo::SystemExt;
use uuid::Uuid;

pub(crate) const FEEDBACK_URL: &str = "https://chessriddle.com/api/v1/feedback";
const STUDIO_PRODUCT: &str = "ChessRiddle Studio";
const MIN_MESSAGE_CHARS: usize = 10;
const MAX_MESSAGE_CHARS: usize = 5000;
const MAX_EMAIL_CHARS: usize = 254;
const MAX_OS_VERSION_CHARS: usize = 64;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const REASON_IN_PROGRESS: &str = "feedback_submission_in_progress";
const REASON_KEY_MISMATCH: &str = "idempotency_key_request_mismatch";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackType {
    Bug,
    Suggestion,
    Praise,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FeedbackOutcome {
    Sent,
    InProgress,
    KeyMismatch,
    InvalidInput,
    RateLimited,
    DeliveryFailed,
    ServiceUnavailable,
}

pub(crate) struct FeedbackIdentity<'a> {
    pub app_version: &'a str,
    pub platform: &'a str,
    pub os_version: &'a str,
}

pub(crate) struct FeedbackInput<'a> {
    pub feedback_type: FeedbackType,
    pub message: &'a str,
    pub contact_email: Option<&'a str>,
    pub idempotency_key: &'a str,
}

pub(crate) struct BuiltFeedbackRequest {
    pub url: &'static str,
    pub headers: HeaderMap,
    pub body: serde_json::Value,
}

#[derive(Serialize)]
struct FeedbackRequestBody<'a> {
    feedback_type: FeedbackType,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    contact_email: Option<&'a str>,
    user_agent: &'a str,
}

#[derive(Deserialize)]
struct ErrorEnvelope {
    error: Option<ErrorObject>,
}

#[derive(Deserialize)]
struct ErrorObject {
    details: Option<ErrorDetails>,
}

#[derive(Deserialize)]
struct ErrorDetails {
    reason: Option<String>,
}

pub(crate) fn client_platform_label(os: &str) -> Option<&'static str> {
    match os {
        "linux" => Some("linux"),
        "macos" => Some("macos"),
        "windows" => Some("windows"),
        _ => None,
    }
}

pub(crate) fn sanitize_os_version(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|ch| !ch.is_control())
        .take(MAX_OS_VERSION_CHARS)
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

fn current_os_version() -> String {
    sanitize_os_version(&sysinfo::System::new().os_version().unwrap_or_default())
}

fn email_plausible(email: &str) -> bool {
    if email.len() < 3 || email.len() > MAX_EMAIL_CHARS {
        return false;
    }
    if email.contains(char::is_whitespace)
        || !email
            .chars()
            .all(|ch| ch.is_ascii() && !ch.is_ascii_control())
    {
        return false;
    }
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    if local.is_empty() || local.len() > 64 || domain.is_empty() || !domain.contains('.') {
        return false;
    }
    if local.starts_with('.')
        || local.ends_with('.')
        || domain.starts_with('.')
        || domain.ends_with('.')
    {
        return false;
    }
    true
}

fn invalid_feedback() -> Error {
    Error::InvalidInput("invalid feedback request".into())
}

fn header_value(value: &str) -> Result<HeaderValue, Error> {
    HeaderValue::from_str(value).map_err(|_| invalid_feedback())
}

pub(crate) fn build_feedback_request(
    input: FeedbackInput<'_>,
    identity: FeedbackIdentity<'_>,
) -> Result<BuiltFeedbackRequest, Error> {
    let key = Uuid::parse_str(input.idempotency_key.trim()).map_err(|_| invalid_feedback())?;
    let message = input.message.trim();
    if !(MIN_MESSAGE_CHARS..=MAX_MESSAGE_CHARS).contains(&message.chars().count()) {
        return Err(invalid_feedback());
    }
    let contact_email = match input.contact_email {
        None => None,
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else if email_plausible(trimmed) {
                Some(trimmed)
            } else {
                return Err(invalid_feedback());
            }
        }
    };
    let platform = client_platform_label(identity.platform).ok_or_else(invalid_feedback)?;
    if identity.app_version.is_empty()
        || !identity.app_version.is_ascii()
        || identity.app_version.chars().any(char::is_control)
    {
        return Err(invalid_feedback());
    }
    let os_version = sanitize_os_version(identity.os_version);
    let header_user_agent = format!("{STUDIO_PRODUCT}/{} ({platform})", identity.app_version);
    let body_user_agent = format!(
        "{STUDIO_PRODUCT}/{} ({platform} {os_version})",
        identity.app_version
    );
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, header_value(&header_user_agent)?);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("accept"),
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        HeaderName::from_static("idempotency-key"),
        header_value(&key.to_string())?,
    );
    headers.insert(
        HeaderName::from_static("x-client-surface"),
        HeaderValue::from_static("desktop"),
    );
    headers.insert(
        HeaderName::from_static("x-client-platform"),
        HeaderValue::from_static(platform),
    );
    headers.insert(
        HeaderName::from_static("x-client-app-version"),
        header_value(identity.app_version)?,
    );
    let body = serde_json::to_value(FeedbackRequestBody {
        feedback_type: input.feedback_type,
        message,
        contact_email,
        user_agent: &body_user_agent,
    })
    .map_err(|_| invalid_feedback())?;
    Ok(BuiltFeedbackRequest {
        url: FEEDBACK_URL,
        headers,
        body,
    })
}

fn conflict_reason(body: &[u8]) -> Option<&str> {
    let envelope: ErrorEnvelope = serde_json::from_slice(body).ok()?;
    match envelope.error?.details?.reason.as_deref() {
        Some(REASON_IN_PROGRESS) => Some(REASON_IN_PROGRESS),
        Some(REASON_KEY_MISMATCH) => Some(REASON_KEY_MISMATCH),
        _ => None,
    }
}

pub(crate) fn map_feedback_response(status: u16, body: &[u8]) -> FeedbackOutcome {
    match status {
        201 => FeedbackOutcome::Sent,
        409 => match conflict_reason(body) {
            Some(REASON_IN_PROGRESS) => FeedbackOutcome::InProgress,
            Some(REASON_KEY_MISMATCH) => FeedbackOutcome::KeyMismatch,
            _ => FeedbackOutcome::DeliveryFailed,
        },
        422 => FeedbackOutcome::InvalidInput,
        429 => FeedbackOutcome::RateLimited,
        401 => FeedbackOutcome::ServiceUnavailable,
        400 | 500..=599 => FeedbackOutcome::DeliveryFailed,
        _ => FeedbackOutcome::DeliveryFailed,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn submit_feedback(
    feedback_type: FeedbackType,
    message: String,
    contact_email: Option<String>,
    idempotency_key: String,
    state: tauri::State<'_, AppState>,
) -> Result<FeedbackOutcome, Error> {
    let platform = client_platform_label(std::env::consts::OS).ok_or_else(invalid_feedback)?;
    let request = build_feedback_request(
        FeedbackInput {
            feedback_type,
            message: &message,
            contact_email: contact_email.as_deref(),
            idempotency_key: &idempotency_key,
        },
        FeedbackIdentity {
            app_version: env!("CARGO_PKG_VERSION"),
            platform,
            os_version: &current_os_version(),
        },
    )?;
    let response = state
        .json_http_client
        .post(request.url)
        .headers(request.headers)
        .json(&request.body)
        .send()
        .await
        .map_err(|error| Error::Reqwest(Box::new(error)))?;
    let status = response.status().as_u16();
    if status == 201 {
        return Ok(FeedbackOutcome::Sent);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Ok(FeedbackOutcome::DeliveryFailed);
    }
    let body = response
        .bytes()
        .await
        .map_err(|error| Error::Reqwest(Box::new(error)))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Ok(FeedbackOutcome::DeliveryFailed);
    }
    Ok(map_feedback_response(status, &body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, AUTHORIZATION};

    const KEY: &str = "550e8400-e29b-41d4-a716-446655440000";
    const MESSAGE: &str = "A useful Studio report.";

    fn identity() -> FeedbackIdentity<'static> {
        FeedbackIdentity {
            app_version: "1.2.3",
            platform: "linux",
            os_version: "6.8.0",
        }
    }

    fn input<'a>(email: Option<&'a str>) -> FeedbackInput<'a> {
        FeedbackInput {
            feedback_type: FeedbackType::Bug,
            message: MESSAGE,
            contact_email: email,
            idempotency_key: KEY,
        }
    }

    fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
    }

    fn built(email: Option<&str>) -> BuiltFeedbackRequest {
        build_feedback_request(input(email), identity()).expect("valid request")
    }

    #[test]
    fn url_is_the_compile_time_chessriddle_endpoint() {
        assert_eq!(FEEDBACK_URL, "https://chessriddle.com/api/v1/feedback");
        assert_eq!(built(None).url, FEEDBACK_URL);
    }

    #[test]
    fn request_sends_every_identity_header_and_never_authorization() {
        let request = built(None);
        let headers = &request.headers;
        assert_eq!(
            header(headers, "user-agent"),
            "ChessRiddle Studio/1.2.3 (linux)"
        );
        assert_eq!(header(headers, "content-type"), "application/json");
        assert_eq!(header(headers, "accept"), "application/json");
        assert_eq!(header(headers, "idempotency-key"), KEY);
        assert_eq!(header(headers, "x-client-surface"), "desktop");
        assert_eq!(header(headers, "x-client-platform"), "linux");
        assert_eq!(header(headers, "x-client-app-version"), "1.2.3");
        assert!(headers.get(AUTHORIZATION).is_none());
        assert!(headers.keys().all(|name| name.as_str() != "authorization"));
    }

    #[test]
    fn body_shape_omits_email_until_provided() {
        let without = built(None).body;
        assert_eq!(without["feedback_type"], "bug");
        assert_eq!(without["message"], MESSAGE);
        assert_eq!(
            without["user_agent"],
            "ChessRiddle Studio/1.2.3 (linux 6.8.0)"
        );
        assert!(without.get("contact_email").is_none());
        assert!(without.get("page_url").is_none());
        assert!(without.get("image_base64").is_none());

        let with = built(Some("user@example.com")).body;
        assert_eq!(with["contact_email"], "user@example.com");
    }

    #[test]
    fn macos_and_windows_platform_labels_are_stable() {
        let macos = build_feedback_request(
            input(None),
            FeedbackIdentity {
                app_version: "1.2.3",
                platform: "macos",
                os_version: "14.0",
            },
        )
        .expect("macos request");
        assert_eq!(header(&macos.headers, "x-client-platform"), "macos");
        assert_eq!(
            header(&macos.headers, "user-agent"),
            "ChessRiddle Studio/1.2.3 (macos)"
        );
        assert_eq!(
            macos.body["user_agent"],
            "ChessRiddle Studio/1.2.3 (macos 14.0)"
        );

        let windows = build_feedback_request(
            input(None),
            FeedbackIdentity {
                app_version: "1.2.3",
                platform: "windows",
                os_version: "10.0.22631",
            },
        )
        .expect("windows request");
        assert_eq!(header(&windows.headers, "x-client-platform"), "windows");
        assert_eq!(
            windows.body["user_agent"],
            "ChessRiddle Studio/1.2.3 (windows 10.0.22631)"
        );
    }

    #[test]
    fn client_platform_labels_cover_the_three_desktop_targets() {
        assert_eq!(client_platform_label("linux"), Some("linux"));
        assert_eq!(client_platform_label("macos"), Some("macos"));
        assert_eq!(client_platform_label("windows"), Some("windows"));
        assert_eq!(client_platform_label("freebsd"), None);
    }

    #[test]
    fn local_validation_rejects_short_message_bad_email_and_bad_key() {
        let mut short = input(None);
        short.message = "too short";
        assert!(matches!(
            build_feedback_request(short, identity()),
            Err(Error::InvalidInput(_))
        ));

        assert!(matches!(
            build_feedback_request(input(Some("not-an-email")), identity()),
            Err(Error::InvalidInput(_))
        ));

        let mut bad_key = input(None);
        bad_key.idempotency_key = "not-a-uuid";
        assert!(matches!(
            build_feedback_request(bad_key, identity()),
            Err(Error::InvalidInput(_))
        ));
    }

    #[test]
    fn outcome_mapping_is_a_closed_set() {
        let in_progress = br#"{"error":{"code":"CONFLICT","message":"hidden","details":{"reason":"feedback_submission_in_progress","retryable":true}}}"#;
        let mismatch = br#"{"error":{"code":"CONFLICT","message":"hidden","details":{"reason":"idempotency_key_request_mismatch"}}}"#;
        let unknown_409 =
            br#"{"error":{"code":"CONFLICT","message":"hidden","details":{"reason":"other"}}}"#;
        let validation =
            br#"{"error":{"code":"VALIDATION_ERROR","message":"hidden","details":null}}"#;

        assert_eq!(
            map_feedback_response(201, br#"{"success":true,"message":"hidden"}"#),
            FeedbackOutcome::Sent
        );
        assert_eq!(
            map_feedback_response(409, in_progress),
            FeedbackOutcome::InProgress
        );
        assert_eq!(
            map_feedback_response(409, mismatch),
            FeedbackOutcome::KeyMismatch
        );
        assert_eq!(
            map_feedback_response(409, unknown_409),
            FeedbackOutcome::DeliveryFailed
        );
        assert_eq!(
            map_feedback_response(409, b"<html>nope</html>"),
            FeedbackOutcome::DeliveryFailed
        );
        assert_eq!(
            map_feedback_response(409, b"{"),
            FeedbackOutcome::DeliveryFailed
        );
        assert_eq!(
            map_feedback_response(422, validation),
            FeedbackOutcome::InvalidInput
        );
        assert_eq!(
            map_feedback_response(429, validation),
            FeedbackOutcome::RateLimited
        );
        assert_eq!(
            map_feedback_response(400, validation),
            FeedbackOutcome::DeliveryFailed
        );
        assert_eq!(
            map_feedback_response(401, validation),
            FeedbackOutcome::ServiceUnavailable
        );
        assert_eq!(
            map_feedback_response(500, b"oops"),
            FeedbackOutcome::DeliveryFailed
        );
        assert_eq!(
            map_feedback_response(503, validation),
            FeedbackOutcome::DeliveryFailed
        );
        assert_eq!(
            map_feedback_response(418, b"teapot"),
            FeedbackOutcome::DeliveryFailed
        );
    }

    #[test]
    fn mapping_never_requires_the_server_message_text() {
        let body = br#"{"error":{"code":"CONFLICT","details":{"reason":"feedback_submission_in_progress"}}}"#;
        assert_eq!(
            map_feedback_response(409, body),
            FeedbackOutcome::InProgress
        );
    }

    #[test]
    fn empty_email_is_omitted_and_whitespace_is_trimmed() {
        let mut padded = input(Some("  user@example.com  "));
        padded.message = "  A useful Studio report.  ";
        let request = build_feedback_request(padded, identity()).expect("trimmed request");
        assert_eq!(request.body["message"], MESSAGE);
        assert_eq!(request.body["contact_email"], "user@example.com");

        let blank = built(Some("   "));
        assert!(blank.body.get("contact_email").is_none());
    }

    #[test]
    fn header_value_helper_accepts_the_studio_user_agent() {
        assert!(HeaderValue::from_str("ChessRiddle Studio/1.2.3 (linux)").is_ok());
    }
}
