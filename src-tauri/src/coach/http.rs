//! The two HTTP clients of the Coach and the one way a provider response body is read.

use std::time::Duration;

use super::{
    address::{Address, AddressClass},
    error::CoachError,
};
use crate::infra::net::{read_bounded_body, BoundedBodyError};

/// Total time for every request that is not a model stream.
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

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
