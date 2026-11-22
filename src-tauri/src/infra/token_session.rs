//! A rotating refresh token of one signed-in account.
//!
//! The session is plain state for a single owner (a worker task that serves its account's
//! requests one after the other): it holds no lock and does no I/O of its own. What reaches the
//! provider and the keyring goes through a [`TokenAuthority`].
//!
//! The order it keeps: a rotated refresh token is stored before the access token that came with
//! it is handed out, and a rotation that could not be stored is stored before anything else
//! happens. The rotated tokens stay in memory meanwhile, so a failed write costs one failed
//! request, not the sign-in.

use std::time::{Duration, Instant};

use async_trait::async_trait;

/// An access token with less than this left is replaced before it is handed out.
pub(crate) const REFRESH_MARGIN: Duration = Duration::from_secs(60);

/// What a provider issued. It must never implement `Debug` or `Serialize`.
pub(crate) struct IssuedTokens {
    pub access: String,
    pub refresh: String,
    pub expires_in: Duration,
}

pub(crate) enum RefreshError<E> {
    /// The provider ended the session: only a new sign-in helps.
    Terminal,
    Other(E),
}

/// The provider and the store behind one account's session.
#[async_trait]
pub(crate) trait TokenAuthority: Send {
    type Error: Send;

    /// Exchanges the refresh token for new tokens.
    async fn refresh(&mut self, refresh: &str) -> Result<IssuedTokens, RefreshError<Self::Error>>;

    /// Stores the refresh token where it survives a restart.
    async fn persist(&mut self, refresh: &str) -> Result<(), Self::Error>;

    /// Removes the stored refresh token after the provider ended the session.
    async fn forget(&mut self) -> Result<(), Self::Error>;
}

/// An access token and the generation it belongs to. A caller whose request was answered with
/// "unauthorized" reports that generation, see [`TokenSession::rejected`].
pub(crate) struct Bearer {
    pub token: String,
    pub generation: u64,
}

pub(crate) enum BearerError<E> {
    /// The provider ended the session and its stored token is gone. The owner drops the session.
    Ended,
    Failed(E),
}

/// The tokens a removed session leaves behind for one last use: the provider's revocation.
pub(crate) struct Revocable {
    pub refresh: String,
    /// The access token, if it has not expired.
    pub access: Option<String>,
}

pub(crate) struct TokenSession {
    refresh: String,
    access: Option<(String, Instant)>,
    /// The refresh token in memory is newer than the stored one.
    unsaved: bool,
    /// Counts the access tokens this session has held.
    generation: u64,
}

impl TokenSession {
    /// A session from a stored refresh token.
    pub(crate) fn restored(refresh: String) -> Self {
        Self {
            refresh,
            access: None,
            unsaved: false,
            generation: 0,
        }
    }

    /// A session from a sign-in. Its refresh token is not stored yet: [`Self::persist`].
    pub(crate) fn signed_in(tokens: IssuedTokens) -> Self {
        let mut session = Self::restored(String::new());
        session.rotate(tokens);
        session
    }

    /// A session from a sign-in whose refresh token the caller has stored already, together with
    /// what else belongs to the account.
    pub(crate) fn stored_sign_in(tokens: IssuedTokens) -> Self {
        let mut session = Self::signed_in(tokens);
        session.unsaved = false;
        session
    }

    fn rotate(&mut self, tokens: IssuedTokens) {
        self.refresh = tokens.refresh;
        self.access = Some((tokens.access, Instant::now() + tokens.expires_in));
        self.unsaved = true;
        self.generation += 1;
    }

    /// Stores the refresh token if the stored one is older.
    pub(crate) async fn persist<A: TokenAuthority>(
        &mut self,
        authority: &mut A,
    ) -> Result<(), A::Error> {
        if self.unsaved {
            authority.persist(&self.refresh).await?;
            self.unsaved = false;
        }
        Ok(())
    }

    /// An access token that is good for at least [`REFRESH_MARGIN`], refreshed if need be.
    pub(crate) async fn bearer<A: TokenAuthority>(
        &mut self,
        authority: &mut A,
    ) -> Result<Bearer, BearerError<A::Error>> {
        self.persist(authority).await.map_err(BearerError::Failed)?;
        let fresh = self
            .access
            .as_ref()
            .is_some_and(|(_, expiry)| *expiry > Instant::now() + REFRESH_MARGIN);
        if !fresh {
            match authority.refresh(&self.refresh).await {
                Ok(tokens) => {
                    self.rotate(tokens);
                    self.persist(authority).await.map_err(BearerError::Failed)?;
                }
                Err(RefreshError::Terminal) => {
                    // The session stays as it is until its stored token is gone, so a failed
                    // removal is tried again by the next request.
                    authority.forget().await.map_err(BearerError::Failed)?;
                    return Err(BearerError::Ended);
                }
                Err(RefreshError::Other(error)) => return Err(BearerError::Failed(error)),
            }
        }
        match &self.access {
            Some((token, _)) => Ok(Bearer {
                token: token.clone(),
                generation: self.generation,
            }),
            // Unreachable: the token is either fresh or was just rotated in. Asking the provider
            // again is the safe answer if that ever stops being true.
            None => Err(BearerError::Ended),
        }
    }

    /// A request with the access token of `generation` was refused as unauthorized. The token is
    /// dropped only if it is still the current one, so any number of requests that were refused
    /// with the same token cause one refresh.
    pub(crate) fn rejected(&mut self, generation: u64) {
        if generation == self.generation {
            self.access = None;
        }
    }

    pub(crate) fn into_revocable(self) -> Revocable {
        Revocable {
            refresh: self.refresh,
            access: self
                .access
                .filter(|(_, expiry)| *expiry > Instant::now())
                .map(|(token, _)| token),
        }
    }

    /// Test seam: the access token has run out.
    #[cfg(test)]
    pub(crate) fn expire_access(&mut self) {
        if let Some((_, expiry)) = self.access.as_mut() {
            *expiry = Instant::now() - Duration::from_secs(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A provider and a store that answer from a script and record the order of what they saw.
    #[derive(Default)]
    struct Scripted {
        log: Vec<String>,
        issued: u32,
        expires_in: Option<Duration>,
        terminal: bool,
        refresh_fails: bool,
        persist_fails: u32,
        forget_fails: bool,
    }

    #[async_trait]
    impl TokenAuthority for Scripted {
        type Error = &'static str;

        async fn refresh(
            &mut self,
            refresh: &str,
        ) -> Result<IssuedTokens, RefreshError<&'static str>> {
            self.log.push(format!("refresh:{refresh}"));
            if self.terminal {
                return Err(RefreshError::Terminal);
            }
            if self.refresh_fails {
                return Err(RefreshError::Other("network"));
            }
            self.issued += 1;
            Ok(IssuedTokens {
                access: format!("access-{}", self.issued),
                refresh: format!("refresh-{}", self.issued),
                expires_in: self.expires_in.unwrap_or(Duration::from_secs(3600)),
            })
        }

        async fn persist(&mut self, refresh: &str) -> Result<(), &'static str> {
            if self.persist_fails > 0 {
                self.persist_fails -= 1;
                self.log.push(format!("persist-failed:{refresh}"));
                return Err("storage");
            }
            self.log.push(format!("persist:{refresh}"));
            Ok(())
        }

        async fn forget(&mut self) -> Result<(), &'static str> {
            if self.forget_fails {
                self.log.push("forget-failed".into());
                return Err("storage");
            }
            self.log.push("forget".into());
            Ok(())
        }
    }

    async fn token(session: &mut TokenSession, authority: &mut Scripted) -> (String, u64) {
        match session.bearer(authority).await {
            Ok(bearer) => (bearer.token, bearer.generation),
            Err(BearerError::Ended) => panic!("the session ended"),
            Err(BearerError::Failed(error)) => panic!("the session failed: {error}"),
        }
    }

    #[tokio::test]
    async fn a_restored_session_refreshes_once_and_stores_the_rotation_before_the_token_is_out() {
        let mut authority = Scripted::default();
        let mut session = TokenSession::restored("stored".into());
        assert_eq!(
            token(&mut session, &mut authority).await,
            ("access-1".into(), 1)
        );
        // The stored token was exchanged, and its replacement stored, before anything was
        // handed out.
        assert_eq!(authority.log, ["refresh:stored", "persist:refresh-1"]);

        // A token with time left is handed out again without the provider or the store.
        assert_eq!(
            token(&mut session, &mut authority).await,
            ("access-1".into(), 1)
        );
        assert_eq!(authority.log.len(), 2);
    }

    #[tokio::test]
    async fn a_token_inside_the_margin_or_past_its_end_is_replaced() {
        let mut authority = Scripted {
            expires_in: Some(REFRESH_MARGIN - Duration::from_secs(1)),
            ..Default::default()
        };
        let mut session = TokenSession::restored("stored".into());
        assert_eq!(token(&mut session, &mut authority).await.0, "access-1");
        // Less than the margin is left: the next request gets a new one.
        assert_eq!(
            token(&mut session, &mut authority).await,
            ("access-2".into(), 2)
        );
        assert_eq!(
            authority.log,
            [
                "refresh:stored",
                "persist:refresh-1",
                "refresh:refresh-1",
                "persist:refresh-2"
            ]
        );

        authority.expires_in = None;
        token(&mut session, &mut authority).await;
        session.expire_access();
        assert_eq!(token(&mut session, &mut authority).await.0, "access-4");
    }

    #[tokio::test]
    async fn a_sign_in_is_stored_once_and_its_token_is_used_without_a_refresh() {
        let mut authority = Scripted::default();
        let mut session = TokenSession::signed_in(IssuedTokens {
            access: "first-access".into(),
            refresh: "first-refresh".into(),
            expires_in: Duration::from_secs(3600),
        });
        session.persist(&mut authority).await.unwrap();
        session.persist(&mut authority).await.unwrap();
        assert_eq!(
            token(&mut session, &mut authority).await,
            ("first-access".into(), 1)
        );
        assert_eq!(authority.log, ["persist:first-refresh"]);
    }

    #[tokio::test]
    async fn a_sign_in_the_caller_stored_is_not_stored_again() {
        let mut authority = Scripted::default();
        let mut session = TokenSession::stored_sign_in(IssuedTokens {
            access: "first-access".into(),
            refresh: "first-refresh".into(),
            expires_in: Duration::from_secs(3600),
        });
        assert_eq!(
            token(&mut session, &mut authority).await,
            ("first-access".into(), 1)
        );
        assert!(authority.log.is_empty());
        // Its first rotation is stored like any other.
        session.expire_access();
        token(&mut session, &mut authority).await;
        assert_eq!(
            authority.log,
            ["refresh:first-refresh", "persist:refresh-1"]
        );
    }

    #[tokio::test]
    async fn a_rotation_that_could_not_be_stored_fails_the_request_and_is_stored_before_the_next() {
        let mut authority = Scripted {
            persist_fails: 1,
            ..Default::default()
        };
        let mut session = TokenSession::restored("stored".into());
        assert!(matches!(
            session.bearer(&mut authority).await,
            Err(BearerError::Failed("storage"))
        ));
        // The rotated tokens are still there: the next request stores them and needs no second
        // exchange, which the provider would refuse for the token it already replaced.
        assert_eq!(
            token(&mut session, &mut authority).await,
            ("access-1".into(), 1)
        );
        assert_eq!(
            authority.log,
            [
                "refresh:stored",
                "persist-failed:refresh-1",
                "persist:refresh-1"
            ]
        );
    }

    #[tokio::test]
    async fn a_provider_that_ended_the_session_has_its_stored_token_removed() {
        let mut authority = Scripted {
            terminal: true,
            forget_fails: true,
            ..Default::default()
        };
        let mut session = TokenSession::restored("stored".into());
        // A removal that failed is reported as that failure, and tried again by the next request.
        assert!(matches!(
            session.bearer(&mut authority).await,
            Err(BearerError::Failed("storage"))
        ));
        authority.forget_fails = false;
        assert!(matches!(
            session.bearer(&mut authority).await,
            Err(BearerError::Ended)
        ));
        assert_eq!(
            authority.log,
            [
                "refresh:stored",
                "forget-failed",
                "refresh:stored",
                "forget"
            ]
        );
    }

    #[tokio::test]
    async fn another_refresh_failure_keeps_the_session_and_stores_nothing() {
        let mut authority = Scripted {
            refresh_fails: true,
            ..Default::default()
        };
        let mut session = TokenSession::restored("stored".into());
        assert!(matches!(
            session.bearer(&mut authority).await,
            Err(BearerError::Failed("network"))
        ));
        authority.refresh_fails = false;
        assert_eq!(token(&mut session, &mut authority).await.0, "access-1");
        assert_eq!(
            authority.log,
            ["refresh:stored", "refresh:stored", "persist:refresh-1"]
        );
    }

    #[tokio::test]
    async fn requests_refused_with_the_same_token_cause_one_refresh() {
        let mut authority = Scripted::default();
        let mut session = TokenSession::restored("stored".into());
        let (_, first) = token(&mut session, &mut authority).await;
        // Two requests went out with the first token and both were refused.
        session.rejected(first);
        let (second_token, second) = token(&mut session, &mut authority).await;
        session.rejected(first);
        assert_eq!(
            token(&mut session, &mut authority).await,
            (second_token, second)
        );
        assert_eq!(second, first + 1);
        assert_eq!(
            authority
                .log
                .iter()
                .filter(|entry| entry.starts_with("refresh:"))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn what_a_removed_session_leaves_is_its_refresh_token_and_an_unexpired_access_token() {
        let mut authority = Scripted::default();
        let mut session = TokenSession::restored("stored".into());
        token(&mut session, &mut authority).await;
        let mut expired = TokenSession::restored("stored".into());
        token(&mut expired, &mut authority).await;
        expired.expire_access();

        let live = session.into_revocable();
        assert_eq!(live.refresh, "refresh-1");
        assert_eq!(live.access.as_deref(), Some("access-1"));
        let stale = expired.into_revocable();
        assert_eq!(stale.refresh, "refresh-2");
        assert_eq!(stale.access, None);
    }
}
