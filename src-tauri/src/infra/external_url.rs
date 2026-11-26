use crate::error::Error;

/// Maximum byte length accepted for an external URL opened from the renderer.
/// Well above any URL the app builds (the GitHub bug-report template is the longest fixed one).
pub(crate) const MAX_EXTERNAL_URL_BYTES: usize = 4096;

const ALLOWED_MAILTO_HEADERS: &[&str] = &["to", "cc", "bcc", "subject", "body", "in-reply-to"];

fn invalid(reason: &'static str) -> Error {
    Error::InvalidInput(reason.into())
}

/// Checks that a `mailto:` address part contains only characters RFC 6068 allows unencoded in an
/// address (plus valid `%HH` percent-escapes). Raw quotes, whitespace, angle brackets, backslashes
/// and other characters outside this set are refused because non-special URLs keep opaque paths
/// unencoded and could otherwise split arguments on Windows `"%1"` handler templates.
fn is_valid_mailto_address(address: &str) -> bool {
    if address.is_empty() {
        return false;
    }
    let bytes = address.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%' {
            if index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit()
            {
                return false;
            }
            index += 3;
            continue;
        }
        let allowed = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'@' | b'.'
                    | b'-'
                    | b'_'
                    | b'+'
                    | b','
                    | b'!'
                    | b'$'
                    | b'&'
                    | b'\''
                    | b'*'
                    | b'/'
                    | b'='
                    | b'^'
                    | b'~'
            );
        if !allowed {
            return false;
        }
        index += 1;
    }
    true
}

/// Validates an external URL from the renderer before it reaches the system URL handler.
///
/// Accepts only:
/// - `http` or `https` with a host and no username or password;
/// - `mailto` with no authority (`cannot_be_a_base`), a non-empty RFC 6068 address part, no
///   fragment, and query headers restricted to the RFC 6068 allowlist.
pub(crate) fn validate_external_url(raw: &str) -> Result<url::Url, Error> {
    if raw.is_empty() {
        return Err(invalid("external URL is empty"));
    }
    if raw.len() > MAX_EXTERNAL_URL_BYTES {
        return Err(invalid("external URL exceeds maximum length"));
    }

    let parsed = url::Url::parse(raw).map_err(|_| invalid("external URL is invalid"))?;
    match parsed.scheme() {
        "http" | "https" => {
            if parsed.host().is_none() {
                return Err(invalid("external URL must include a host"));
            }
            if !parsed.username().is_empty() || parsed.password().is_some() {
                return Err(invalid("external URL must not include user info"));
            }
            Ok(parsed)
        }
        "mailto" => {
            if !parsed.cannot_be_a_base() {
                return Err(invalid("mailto URL must not include an authority"));
            }
            if parsed.fragment().is_some() {
                return Err(invalid("mailto URL must not include a fragment"));
            }
            if !is_valid_mailto_address(parsed.path()) {
                return Err(invalid("mailto URL address is invalid"));
            }
            if let Some(query) = parsed.query() {
                if !query.is_empty() && query.split('&').any(str::is_empty) {
                    return Err(invalid("mailto URL query is invalid"));
                }
                for (name, _) in parsed.query_pairs() {
                    let lower = name.to_ascii_lowercase();
                    if !ALLOWED_MAILTO_HEADERS.contains(&lower.as_str()) {
                        return Err(invalid("mailto URL header is not allowed"));
                    }
                }
            }
            Ok(parsed)
        }
        _ => Err(invalid("external URL scheme is not allowed")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCategory;

    fn assert_rejected(input: &str) {
        let error = validate_external_url(input)
            .expect_err(&format!("expected external URL to be rejected: {input:?}"));
        assert_eq!(
            error.category(),
            ErrorCategory::InvalidInput,
            "unexpected category for {input:?}: {error:?}"
        );
    }

    #[test]
    fn accepts_http_and_https_with_host() {
        let http = validate_external_url("http://example.com/path?a=1#frag").unwrap();
        assert_eq!(http.as_str(), "http://example.com/path?a=1#frag");

        let https =
            validate_external_url("https://github.com/felixabeck/chessriddle-studio").unwrap();
        assert_eq!(
            https.as_str(),
            "https://github.com/felixabeck/chessriddle-studio"
        );
    }

    #[test]
    fn accepts_mailto_with_allowlisted_headers() {
        let bare = validate_external_url("mailto:user@example.com").unwrap();
        assert_eq!(bare.as_str(), "mailto:user@example.com");

        let with_headers = validate_external_url(
            "mailto:user+tag@sub.example.com?SUBJECT=Hello%20World&body=Line&cc=a@b.test&bcc=c@d.test&to=e@f.test&in-reply-to=%3Cid@host%3E",
        )
        .unwrap();
        assert_eq!(with_headers.scheme(), "mailto");
    }

    #[test]
    fn validates_mailto_address_percent_escapes() {
        let mid = validate_external_url("mailto:a%40b@example.com").unwrap();
        assert_eq!(mid.as_str(), "mailto:a%40b@example.com");

        let trailing = validate_external_url("mailto:user@example.co%6D").unwrap();
        assert_eq!(trailing.as_str(), "mailto:user@example.co%6D");

        for input in [
            "mailto:a%2",
            "mailto:a%",
            "mailto:a%zz@example.com",
            "mailto:a%2z@example.com",
            "mailto:a%z2@example.com",
        ] {
            assert_rejected(input);
        }
    }

    #[test]
    fn rejects_disallowed_schemes() {
        for input in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/plain,hello",
            "tel:+1234567890",
            "chessriddle-studio://open/game",
            "ms-settings:privacy",
            "ms-msdt:/id",
            "search-ms:query=foo",
            "ftp://example.com/file",
        ] {
            assert_rejected(input);
        }
    }

    #[test]
    fn rejects_mailto_authority_disallowed_headers_and_unsafe_address_chars() {
        for input in [
            "mailto://host/user@example.com",
            "mailto:user@example.com?attach=/etc/passwd",
            "mailto:user@example.com?attachment=/etc/passwd",
            "mailto:user@example.com?%61ttach=/etc/passwd",
            "mailto:user@example.com?X-Custom=1",
            "mailto:user@example.com?subject=ok&",
            "mailto:a@b\" -compose attachment=C:\\x",
            "mailto:a b@example.com",
            "mailto:a@b<c>",
            "mailto:a@b\\c",
            "mailto:a%2@example.com",
            "mailto:a@b.com#\" -compose x",
            "mailto:",
            "mailto:?subject=only",
        ] {
            assert_rejected(input);
        }
    }

    #[test]
    fn rejects_userinfo_relative_empty_and_over_bound_inputs() {
        for input in [
            "https://user@example.com/",
            "https://user:pass@example.com/",
            "https://:pass@example.com/",
            "http://user@example.com/",
            "/relative/path",
            "example.com",
            "",
        ] {
            assert_rejected(input);
        }

        let over_bound = format!("https://example.com/{}", "a".repeat(MAX_EXTERNAL_URL_BYTES));
        assert!(over_bound.len() > MAX_EXTERNAL_URL_BYTES);
        assert_rejected(&over_bound);
    }
}
