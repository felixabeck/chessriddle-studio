//! Where an API connection may send the user's key.
//!
//! Two classes exist (d-20261122-21). A public address is `https` and is reached through the
//! client whose resolver accepts only globally routable answers. A local address is plain `http`
//! to this machine or the home network, named by `localhost` or an IP literal, and is reached
//! through a client without that resolver. The class is derived from the stored text on every use.

use std::net::IpAddr;

use url::{Host, Url};

use super::error::CoachError;

pub(crate) const MAX_ADDRESS_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AddressClass {
    Public,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Address {
    url: Url,
    class: AddressClass,
}

fn local_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
        // Loopback and unique-local (fc00::/7). Link-local needs a zone and is excluded.
        IpAddr::V6(v6) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

fn host_ip(url: &Url) -> Option<IpAddr> {
    match url.host()? {
        Host::Ipv4(ip) => Some(IpAddr::V4(ip)),
        Host::Ipv6(ip) => Some(IpAddr::V6(ip)),
        Host::Domain(_) => None,
    }
}

impl Address {
    pub(crate) fn parse(input: &str) -> Result<Self, CoachError> {
        let input = input.trim();
        if input.is_empty() || input.len() > MAX_ADDRESS_BYTES {
            return Err(CoachError::InvalidAddressFormat);
        }
        let mut url = Url::parse(input).map_err(|_| CoachError::InvalidAddressFormat)?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(CoachError::InvalidAddressCredentials);
        }
        let Some(host) = url.host_str().map(str::to_owned) else {
            return Err(CoachError::InvalidAddressFormat);
        };
        let ip = host_ip(&url);
        let class = match url.scheme() {
            "https" => {
                let reachable = match ip {
                    Some(ip) => crate::infra::net::is_public_ip(ip),
                    None => !host.eq_ignore_ascii_case("localhost"),
                };
                if !reachable {
                    return Err(CoachError::InvalidAddressScheme);
                }
                AddressClass::Public
            }
            "http" => {
                let local = match ip {
                    Some(ip) => local_ip(ip),
                    None => host.eq_ignore_ascii_case("localhost"),
                };
                if !local {
                    return Err(CoachError::InvalidAddressScheme);
                }
                AddressClass::Local
            }
            _ => return Err(CoachError::InvalidAddressScheme),
        };
        let path = url.path().trim_end_matches('/').to_owned();
        url.set_path(&path);
        Ok(Self { url, class })
    }

    pub(crate) fn class(&self) -> AddressClass {
        self.class
    }

    pub(crate) fn as_str(&self) -> &str {
        self.url.as_str().trim_end_matches('/')
    }

    fn base_path(&self) -> &str {
        self.url.path().trim_end_matches('/')
    }

    /// The URL of `path` below this address, for example `models` or `chat/completions`.
    pub(crate) fn endpoint(&self, path: &str) -> Url {
        let mut url = self.url.clone();
        url.set_path(&format!("{}/{}", self.base_path(), path.trim_matches('/')));
        url
    }

    /// Same scheme, host and effective port: the rule for keeping a stored key across an edit.
    pub(crate) fn same_origin(&self, other: &Address) -> bool {
        self.url.scheme() == other.url.scheme()
            && self.url.host() == other.url.host()
            && self.url.port_or_known_default() == other.url.port_or_known_default()
    }

    /// Whether a bearer credential stored for this address may travel to `target`: the same
    /// origin without user info, and a path below this address at a segment boundary.
    pub(crate) fn owns(&self, target: &Url) -> bool {
        let base = self.base_path();
        target.scheme() == self.url.scheme()
            && target.host() == self.url.host()
            && target.port_or_known_default() == self.url.port_or_known_default()
            && target.username().is_empty()
            && target.password().is_none()
            && target
                .path()
                .strip_prefix(base)
                .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(input: &str) -> Address {
        Address::parse(input).unwrap()
    }

    #[test]
    fn public_addresses_are_https_and_never_local() {
        for input in [
            "https://api.openai.com/v1",
            "https://api.deepseek.com",
            "https://openrouter.ai/api/v1/",
            "https://8.8.8.8/v1",
        ] {
            assert_eq!(parsed(input).class(), AddressClass::Public, "{input}");
        }
        for input in [
            "https://localhost/v1",
            "https://127.0.0.1/v1",
            "https://192.168.1.10:8443/v1",
            "https://[::1]/v1",
        ] {
            assert_eq!(
                Address::parse(input),
                Err(CoachError::InvalidAddressScheme),
                "{input}"
            );
        }
    }

    #[test]
    fn local_addresses_are_http_to_localhost_or_a_loopback_or_private_literal() {
        for input in [
            "http://localhost:11434/v1",
            "http://LOCALHOST:1234/v1",
            "http://127.0.0.1:1234/v1",
            "http://192.168.1.10:11434/v1",
            "http://10.0.0.5:8080",
            "http://172.16.4.4:8080/v1",
            "http://[::1]:11434/v1",
            "http://[fd12:3456:789a::1]:11434/v1",
        ] {
            assert_eq!(parsed(input).class(), AddressClass::Local, "{input}");
        }
        for input in [
            "http://api.openai.com/v1",
            "http://example.local:11434/v1",
            "http://8.8.8.8/v1",
            "http://169.254.1.1/v1",
            "http://[fe80::1]/v1",
            "ftp://localhost/v1",
        ] {
            assert_eq!(
                Address::parse(input),
                Err(CoachError::InvalidAddressScheme),
                "{input}"
            );
        }
    }

    #[test]
    fn credentials_query_and_fragment_are_refused() {
        for input in [
            "https://user@api.openai.com/v1",
            "https://user:secret@api.openai.com/v1",
            "https://api.openai.com/v1?key=1",
            "https://api.openai.com/v1#models",
        ] {
            assert_eq!(
                Address::parse(input),
                Err(CoachError::InvalidAddressCredentials),
                "{input}"
            );
        }
    }

    #[test]
    fn malformed_empty_and_oversized_addresses_are_refused() {
        let oversized = format!("https://example.com/{}", "a".repeat(MAX_ADDRESS_BYTES));
        for input in [
            "",
            "   ",
            "api.openai.com/v1",
            "https://",
            "file:///etc/passwd",
            oversized.as_str(),
        ] {
            assert_eq!(
                Address::parse(input),
                Err(CoachError::InvalidAddressFormat),
                "{input}"
            );
        }
    }

    #[test]
    fn endpoints_extend_the_stored_path_without_a_double_slash() {
        assert_eq!(
            parsed("https://api.openai.com/v1/")
                .endpoint("/models")
                .as_str(),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            parsed("https://api.deepseek.com")
                .endpoint("chat/completions")
                .as_str(),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            parsed("https://api.openai.com/v1/").as_str(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            parsed("https://api.deepseek.com").as_str(),
            "https://api.deepseek.com"
        );
    }

    #[test]
    fn a_key_travels_only_to_its_own_origin_below_its_own_path() {
        let address = parsed("https://host.example/v1");
        let owned = |target: &str| address.owns(&Url::parse(target).unwrap());
        assert!(owned("https://host.example/v1"));
        assert!(owned("https://host.example/v1/models"));
        assert!(owned("https://host.example:443/v1/chat/completions"));
        // Look-alike host, look-alike path, other port, other scheme, user info.
        assert!(!owned("https://host.example.attacker.invalid/v1/models"));
        assert!(!owned("https://host.example/v10/models"));
        assert!(!owned("https://host.example:8443/v1/models"));
        assert!(!owned("http://host.example/v1/models"));
        assert!(!owned("https://user@host.example/v1/models"));
        assert!(!owned("https://host.example/"));

        let root = parsed("https://api.deepseek.com");
        assert!(root.owns(&Url::parse("https://api.deepseek.com/models").unwrap()));
        assert!(
            !root.owns(&Url::parse("https://api.deepseek.com.attacker.invalid/models").unwrap())
        );
    }

    #[test]
    fn an_edit_keeps_the_key_only_within_one_origin() {
        let stored = parsed("https://api.openai.com/v1");
        assert!(stored.same_origin(&parsed("https://api.openai.com/v2")));
        assert!(stored.same_origin(&parsed("https://api.openai.com:443/v1")));
        assert!(!stored.same_origin(&parsed("https://api.openai.com:8443/v1")));
        assert!(!stored.same_origin(&parsed("https://api.deepseek.com/v1")));
        assert!(
            !parsed("http://localhost:11434/v1").same_origin(&parsed("http://127.0.0.1:11434/v1"))
        );
    }
}
