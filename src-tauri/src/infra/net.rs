use futures_util::StreamExt;
use reqwest::dns::{Addrs, Name, Resolve};
use reqwest::header::HeaderMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

#[derive(Clone)]
pub struct SafeResolver;

impl Resolve for SafeResolver {
    fn resolve(&self, name: Name) -> reqwest::dns::Resolving {
        let name_str = name.as_str().to_string();
        Box::pin(async move {
            let addrs = tokio::net::lookup_host((name_str.as_str(), 0)).await?;
            let addresses = validate_resolved_addresses(addrs.collect())?;
            // A mixed DNS answer is not safe. Selecting only the public member makes this
            // policy depend on the client resolver/connection fallback and re-opens DNS-rebind
            // style ambiguity. Every address must be globally routable on every request.
            let result: Addrs = Box::new(
                addresses
                    .into_iter()
                    .map(|addr| std::net::SocketAddr::new(addr.ip(), 0)),
            );
            Ok(result)
        })
    }
}

fn validate_resolved_addresses(
    addresses: Vec<std::net::SocketAddr>,
) -> Result<Vec<std::net::SocketAddr>, std::io::Error> {
    if addresses.is_empty() || addresses.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "DNS answer contains a non-public address",
        ));
    }
    Ok(addresses)
}

/// Chess.com refuses requests without a User-Agent and asks clients to name a contact; every
/// native provider request identifies the app and carries the publisher's contact address.
/// User-Agent product tokens cannot contain spaces (RFC 9110), hence "ChessRiddleStudio" rather than the display name "ChessRiddle Studio" used in feedback.rs.
const STUDIO_USER_AGENT: &str = concat!(
    "ChessRiddleStudio/",
    env!("CARGO_PKG_VERSION"),
    " (contact: info@chessriddle.com)"
);

/// Shared provider client policy. Every native request, including credential-bearing OAuth and
/// account traffic, resolves only globally routable addresses, never follows redirects, and
/// identifies the app with [`STUDIO_USER_AGENT`].
pub fn safe_http_client(
    builder: reqwest::ClientBuilder,
    connect_timeout: Duration,
    read_timeout: Duration,
    request_timeout: Duration,
) -> Result<reqwest::Client, reqwest::Error> {
    builder
        .dns_resolver(Arc::new(SafeResolver))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(STUDIO_USER_AGENT)
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .timeout(request_timeout)
        .build()
}

const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest silence a model stream may have between two reads.
const STREAM_READ_TIMEOUT: Duration = Duration::from_secs(120);

/// Process-lifetime client for long provider streams: the shared provider policy of
/// [`safe_http_client`] without a total request timeout. The caller owns the overall deadline of a
/// stream and sets a total timeout on every request that is not one.
pub fn native_streaming_http_client(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, reqwest::Error> {
    builder
        .dns_resolver(Arc::new(SafeResolver))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(STUDIO_USER_AGENT)
        .connect_timeout(STREAM_CONNECT_TIMEOUT)
        .read_timeout(STREAM_READ_TIMEOUT)
        .build()
}

/// Process-lifetime client for a model runner on this machine or the home network. It has no
/// [`SafeResolver`], so its caller must have established that the target is a local address, and it
/// never goes through a proxy.
pub fn local_streaming_http_client(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, reqwest::Error> {
    builder
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(STUDIO_USER_AGENT)
        .connect_timeout(STREAM_CONNECT_TIMEOUT)
        .read_timeout(STREAM_READ_TIMEOUT)
        .build()
}

pub(crate) enum BoundedBodyError {
    Transport(reqwest::Error),
    TooLarge,
}

/// Reads a response body up to `max_bytes` and fails beyond it without buffering the excess.
pub(crate) async fn read_bounded_body(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, BoundedBodyError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(BoundedBodyError::TooLarge);
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(BoundedBodyError::Transport)?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(BoundedBodyError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

const JSON_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const JSON_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(30);
const DOWNLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(3600);
pub(crate) const UPLOAD_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const UPLOAD_READ_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const UPLOAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// Process-lifetime client for bounded JSON and OAuth provider requests.
pub fn native_json_http_client(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, reqwest::Error> {
    safe_http_client(
        builder,
        JSON_CONNECT_TIMEOUT,
        JSON_READ_TIMEOUT,
        JSON_REQUEST_TIMEOUT,
    )
}

/// Process-lifetime client for feedback image uploads.
pub fn native_upload_http_client(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, reqwest::Error> {
    safe_http_client(
        builder,
        UPLOAD_CONNECT_TIMEOUT,
        UPLOAD_READ_TIMEOUT,
        UPLOAD_REQUEST_TIMEOUT,
    )
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            // Do not rely on the convenience predicates alone: their exact definitions have
            // changed between Rust releases and several ranges are not covered by `private`.
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_multicast()
                && !v4.is_broadcast()
                && !v4.is_documentation()
                && !v4.is_unspecified()
                // Carrier-grade NAT (RFC 6598), IETF protocol assignments and the local
                // "this network" range must never be download destinations.
                && !is_non_global_v4(v4)
        }
        IpAddr::V6(v6) => {
            !v6.is_loopback()
                && !v6.is_multicast()
                && !v6.is_unspecified()
                // unique-local, link-local, site-local (deprecated but routeable on old
                // networks), documentation and IPv4-mapped addresses.
                && (v6.segments()[0] & 0xfe00) != 0xfc00
                && (v6.segments()[0] & 0xffc0) != 0xfe80
                && (v6.segments()[0] & 0xffc0) != 0xfec0
                && !(v6.segments()[0] == 0x2001 && v6.segments()[1] == 0x0db8)
                && v6.to_ipv4_mapped().is_none()
                && !is_ipv4_compatible(v6)
        }
    }
}

fn is_non_global_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    a == 0
        || (a == 100 && (64..=127).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113)
        || a >= 240
}

fn is_ipv4_compatible(ip: Ipv6Addr) -> bool {
    // ::/96 is the unspecified family (already caught) and ::w.x.y.z is an
    // IPv4-compatible address. Treat it exactly like an IPv4 destination.
    let segments = ip.segments();
    segments[..6] == [0, 0, 0, 0, 0, 0] && segments[6] != 0 && segments[7] != 0
}

pub struct DownloadResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub content_length: Option<u64>,
    pub stream: Pin<
        Box<
            dyn futures_util::Stream<Item = Result<bytes::Bytes, crate::error::Error>>
                + Send
                + Sync,
        >,
    >,
}

#[async_trait::async_trait]
pub trait DownloadTransport: Send + Sync {
    async fn request(
        &self,
        url: &str,
        headers: HeaderMap,
    ) -> Result<DownloadResponse, crate::error::Error>;
}

pub struct ProdTransport {
    client: reqwest::Client,
}

impl ProdTransport {
    pub fn new(builder: reqwest::ClientBuilder) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: safe_http_client(
                builder,
                DOWNLOAD_CONNECT_TIMEOUT,
                DOWNLOAD_READ_TIMEOUT,
                DOWNLOAD_REQUEST_TIMEOUT,
            )?,
        })
    }
}

#[async_trait::async_trait]
impl DownloadTransport for ProdTransport {
    async fn request(
        &self,
        url: &str,
        headers: HeaderMap,
    ) -> Result<DownloadResponse, crate::error::Error> {
        let req = self
            .client
            .get(url)
            .headers(headers)
            .build()
            .map_err(|e| crate::error::Error::InvalidInput(e.to_string()))?;
        let res = self
            .client
            .execute(req)
            .await
            .map_err(|e| crate::error::Error::Reqwest(Box::new(e)))?;

        let status = res.status().as_u16();
        let content_length = res.content_length();
        let headers = res.headers().clone();
        let stream = res
            .bytes_stream()
            .map(|r| r.map_err(|e| crate::error::Error::Reqwest(Box::new(e))));

        Ok(DownloadResponse {
            status,
            headers,
            content_length,
            stream: Box::pin(stream),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
    use std::str::FromStr;

    #[test]
    fn test_is_public_ip() {
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(172, 16, 0, 1))));
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::new(
            0, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::new(
            0xfc00, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 0, 8))));
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::new(
            0xfe80, 0, 0, 0, 0, 0, 0, 1
        ))));
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::new(
            0, 0, 0, 0, 0, 0xffff, 0x7f00, 1
        ))));

        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(is_public_ip(IpAddr::V6(Ipv6Addr::new(
            0x2001, 0x4860, 0x4860, 0, 0, 0, 0, 0x8888
        ))));
    }

    #[test]
    fn mixed_public_and_private_dns_answers_are_rejected() {
        let answers = vec![
            "8.8.8.8:443".parse().unwrap(),
            "127.0.0.1:443".parse().unwrap(),
        ];
        let error = validate_resolved_addresses(answers).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn empty_and_private_only_dns_answers_are_rejected() {
        let empty = validate_resolved_addresses(vec![]).unwrap_err();
        assert_eq!(empty.kind(), std::io::ErrorKind::PermissionDenied);

        let private = validate_resolved_addresses(vec![SocketAddr::from(([192, 168, 1, 5], 443))])
            .unwrap_err();
        assert_eq!(private.kind(), std::io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn wholly_public_dns_answer_is_preserved() {
        let answer = SocketAddr::from(([8, 8, 8, 8], 443));
        assert_eq!(
            validate_resolved_addresses(vec![answer]).unwrap(),
            vec![answer]
        );
    }

    #[test]
    fn shared_client_accepts_independent_connect_read_and_total_timeouts() {
        let client = safe_http_client(
            reqwest::Client::builder(),
            Duration::from_millis(5),
            Duration::from_millis(10),
            Duration::from_millis(15),
        );
        assert!(client.is_ok());
    }

    #[test]
    fn production_upload_client_is_built_through_safe_http_client_with_120s_timeouts() {
        assert_eq!(UPLOAD_CONNECT_TIMEOUT, Duration::from_secs(10));
        assert_eq!(UPLOAD_READ_TIMEOUT, Duration::from_secs(120));
        assert_eq!(UPLOAD_REQUEST_TIMEOUT, Duration::from_secs(120));
        assert!(native_upload_http_client(reqwest::Client::builder()).is_ok());
    }

    #[tokio::test]
    async fn test_safe_resolver() {
        let resolver = SafeResolver;

        if let Ok(name) = Name::from_str("localhost") {
            let result = resolver.resolve(name).await;
            assert!(
                result.is_err(),
                "Localhost should be blocked by SafeResolver"
            );
        }
    }

    #[tokio::test]
    async fn safe_http_client_sends_the_studio_user_agent() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = async {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut buf = [0; 512];
                let n = stream.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                request.extend_from_slice(&buf[..n]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            String::from_utf8(request).unwrap()
        };
        let client = safe_http_client(
            reqwest::Client::builder().no_proxy(),
            Duration::from_secs(2),
            Duration::from_secs(2),
            Duration::from_secs(2),
        )
        .unwrap();
        let url = format!("http://127.0.0.1:{}/", addr.port());
        let (captured, response) = tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client.get(url).send())
        })
        .await
        .expect("loopback request must finish");
        assert_eq!(response.unwrap().status().as_u16(), 200);
        let expected = format!("user-agent: {}", STUDIO_USER_AGENT.to_ascii_lowercase());
        assert!(
            captured
                .to_ascii_lowercase()
                .lines()
                .any(|line| line == expected),
            "{captured}"
        );
        // Chess.com asks API clients to name a way to reach their publisher. The comparison
        // above holds for any constant, so the shape of the contact part is pinned here; the
        // address itself is written in one place only.
        let transmitted = captured
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("user-agent")
                    .then(|| value.trim().to_owned())
            })
            .expect("the request carries a user agent");
        let contact = transmitted
            .strip_prefix(concat!(
                "ChessRiddleStudio/",
                env!("CARGO_PKG_VERSION"),
                " (contact: "
            ))
            .and_then(|rest| rest.strip_suffix(')'))
            .expect("the user agent is the product token followed by one contact part");
        let (mailbox, domain) = contact
            .split_once('@')
            .expect("the contact is a mail address");
        let labels: Vec<&str> = domain.split('.').collect();
        assert!(
            !mailbox.is_empty()
                && labels.len() >= 2
                && labels.iter().all(|label| !label.is_empty())
                && !domain.contains('@')
                && !contact.contains(|c: char| c.is_whitespace() || "(),;".contains(c)),
            "the contact must be one mail address without spaces, brackets or separators"
        );
    }
}
