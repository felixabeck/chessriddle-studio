//! The two HTTP clients of the Coach and the one way a provider response body is read.

use std::time::Duration;

use serde_json::Value;

use super::{
    address::{Address, AddressClass},
    error::CoachError,
};
use crate::infra::net::{read_bounded_body, BoundedBodyError};

/// Total time for every request that is not a model stream.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// What is read of an error response to tell the failures apart.
pub(crate) const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;
/// How much of a provider's error text reaches the native log.
const MAX_DIAGNOSTIC_CHARS: usize = 512;

pub(crate) struct HttpClients {
    public: reqwest::Client,
    local: reqwest::Client,
}

impl HttpClients {
    pub(crate) fn new() -> Result<Self, CoachError> {
        Ok(Self {
            public: crate::infra::net::native_streaming_http_client(reqwest::Client::builder())
                .map_err(|_| CoachError::Network)?,
            local: crate::infra::net::local_streaming_http_client(reqwest::Client::builder())
                .map_err(|_| CoachError::Network)?,
        })
    }

    /// The client for the fixed public hosts of the sign-in providers.
    pub(crate) fn public(&self) -> &reqwest::Client {
        &self.public
    }

    /// The client for an address. The class comes from the address itself, which the caller has
    /// just parsed from the stored text.
    pub(crate) fn for_address(&self, address: &Address) -> &reqwest::Client {
        match address.class() {
            AddressClass::Public => &self.public,
            AddressClass::Local => &self.local,
        }
    }
}

/// A bounded non-streaming exchange: status and body, or the typed transport failure.
pub(crate) async fn send_bounded(
    request: reqwest::RequestBuilder,
    max_bytes: usize,
) -> Result<(u16, Vec<u8>), CoachError> {
    let response = request
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| CoachError::Network)?;
    let status = response.status().as_u16();
    match read_bounded_body(response, max_bytes).await {
        Ok(body) => Ok((status, body)),
        Err(BoundedBodyError::Transport(_)) => Err(CoachError::Network),
        Err(BoundedBodyError::TooLarge) => Err(CoachError::ProviderFailure),
    }
}

/// The human-readable part of an error body, in the shapes providers use.
pub(crate) fn error_text(body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return String::from_utf8_lossy(body).into_owned();
    };
    // Gemini wraps the error object of a chat request in a list.
    let value = match value {
        Value::Array(mut items) if items.len() == 1 => items.remove(0),
        other => other,
    };
    match value.get("error") {
        Some(Value::String(message)) => message.clone(),
        Some(error) => error
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string()),
        None => value.to_string(),
    }
}

/// The provider's own words about a failure, for the native log only: cut short, and with the
/// connection's secret removed in case the provider echoed it.
pub(crate) fn diagnostic(text: &str, secret: Option<&str>) -> String {
    let text = match secret {
        Some(secret) if !secret.is_empty() => text.replace(secret, "[key]"),
        _ => text.to_owned(),
    };
    text.chars().take(MAX_DIAGNOSTIC_CHARS).collect()
}

/// Whether a refusal is about the connection's key. Most providers answer 401 or 403; Gemini
/// answers 400 and says so in words ("Please pass a valid API key", "Missing or invalid
/// Authorization header.").
pub(crate) fn key_refused(status: u16, message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    matches!(status, 401 | 403)
        || (status == 400 && (message.contains("api key") || message.contains("authorization")))
}

/// Tells apart the refusals a user can act on. Providers share no error codes for these, so the
/// status and the provider's wording decide; anything unclear is a plain provider failure.
pub(crate) fn classify_refusal(
    status: u16,
    message: &str,
    effort_sent: bool,
    has_images: bool,
) -> CoachError {
    if key_refused(status, message) {
        return CoachError::KeyRejected;
    }
    let message = message.to_ascii_lowercase();
    match status {
        429 => CoachError::RateLimited,
        400 | 404 | 422 => {
            if message.contains("tool") && message.contains("support") {
                CoachError::NoFunctionCalling
            } else if effort_sent && message.contains("effort") {
                CoachError::EffortRejected
            } else if has_images
                && (message.contains("image")
                    || message.contains("vision")
                    || message.contains("modalit"))
            {
                CoachError::ImagesUnsupported
            } else if status == 404
                || (message.contains("model")
                    && (message.contains("not found") || message.contains("not exist")))
            {
                CoachError::ModelUnavailable
            } else {
                CoachError::ProviderFailure
            }
        }
        _ => CoachError::ProviderFailure,
    }
}

/// A link that may be handed to the system browser: `https`, no user info, the default port,
/// and a host the caller accepts. Anything else is `None`.
pub(crate) fn browser_link(value: &str, host_allowed: impl Fn(&str) -> bool) -> Option<url::Url> {
    let url = url::Url::parse(value).ok()?;
    // URL parsing drops an explicit default port, so the authority is looked at as written.
    let authority = value
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())?;
    let plain = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && !authority.contains(':')
        && !authority.contains('@');
    (plain && url.host_str().is_some_and(host_allowed)).then_some(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_https_links_on_an_accepted_host_reach_the_browser() {
        let openai = |host: &str| host == "auth.openai.com";
        assert!(
            browser_link("https://auth.openai.com/api/accounts/authorize?x=1", openai).is_some()
        );
        for refused in [
            "http://auth.openai.com/authorize",
            "https://auth.openai.com:443/authorize",
            "https://auth.openai.com:8443/authorize",
            "https://user@auth.openai.com/authorize",
            "https://user:secret@auth.openai.com/authorize",
            "https://auth.openai.com.evil.example/authorize",
            "https://evil.example/?next=https://auth.openai.com/",
            "auth.openai.com/authorize",
            "javascript:alert(1)",
            "",
        ] {
            assert!(browser_link(refused, openai).is_none(), "{refused}");
        }
        // A caller may accept a domain with its subdomains.
        let xai = |host: &str| host == "x.ai" || host.ends_with(".x.ai");
        assert!(browser_link("https://accounts.x.ai/device?code=1", xai).is_some());
        assert!(browser_link("https://notx.ai/device", xai).is_none());
    }

    #[test]
    fn an_error_text_is_read_from_every_shape_providers_use() {
        for (body, expected) in [
            (r#"{"error":{"message":"No such model"}}"#, "No such model"),
            (r#"{"error":"plain words"}"#, "plain words"),
            (
                r#"[{"error":{"code":400,"message":"Please pass a valid API key","status":"INVALID_ARGUMENT"}}]"#,
                "Please pass a valid API key",
            ),
            ("not json at all", "not json at all"),
        ] {
            assert_eq!(error_text(body.as_bytes()), expected, "{body}");
        }
        // Anything else is kept whole, so the log still shows what came.
        assert_eq!(error_text(br#"{"detail":"x"}"#), r#"{"detail":"x"}"#);
        assert_eq!(error_text(b"[1,2]"), "[1,2]");
    }

    #[test]
    fn a_key_refusal_is_told_by_status_or_by_the_providers_words() {
        assert!(key_refused(401, ""));
        assert!(key_refused(403, "no access"));
        assert!(key_refused(400, "Please pass a valid API key"));
        assert!(key_refused(
            400,
            "API key not valid. Please pass a valid API key."
        ));
        assert!(key_refused(400, "Missing or invalid Authorization header."));
        assert!(!key_refused(400, "The model `gone` does not exist"));
        // The words alone do not make another status a key refusal.
        assert!(!key_refused(404, "api key"));
        assert!(!key_refused(500, "api key"));
        assert!(!key_refused(429, "authorization"));
    }

    #[test]
    fn a_diagnostic_is_cut_short_and_never_carries_the_secret() {
        let text = format!("refused key sk-secret {}", "x".repeat(2000));
        let logged = diagnostic(&text, Some("sk-secret"));
        assert!(!logged.contains("sk-secret"));
        assert!(logged.starts_with("refused key [key]"));
        assert_eq!(logged.chars().count(), MAX_DIAGNOSTIC_CHARS);
        assert_eq!(diagnostic("plain", None), "plain");
        assert_eq!(diagnostic("plain", Some("")), "plain");
    }

    #[test]
    fn image_refusals_classify_only_when_images_were_sent_and_after_key_before_model_not_found() {
        for (status, msg) in [
            (400, "Model does not support image inputs"),
            (404, "No endpoints support vision"),
            (422, "Unsupported input modalities"),
        ] {
            assert_eq!(
                classify_refusal(status, msg, false, true),
                CoachError::ImagesUnsupported,
                "{status}: {msg}"
            );
        }
        // Without images, the same messages never classify as ImagesUnsupported.
        assert_eq!(
            classify_refusal(400, "Model does not support image inputs", false, false),
            CoachError::ProviderFailure
        );
        assert_eq!(
            classify_refusal(404, "No endpoints support vision", false, false),
            CoachError::ModelUnavailable
        );
        // Key refusal still wins over image wording even when images were sent.
        assert_eq!(
            classify_refusal(400, "Invalid API key for image endpoint", false, true),
            CoachError::KeyRejected
        );
        // Plain 404 without image/vision/modality wording still classifies as ModelUnavailable.
        assert_eq!(
            classify_refusal(404, "The model does not exist", false, true),
            CoachError::ModelUnavailable
        );
    }
}
