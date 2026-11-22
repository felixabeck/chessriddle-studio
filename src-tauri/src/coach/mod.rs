//! Coach: an AI chat about the position (d-20261122-18 to d-20261122-21).
//!
//! The native side owns the connections, their secrets and all provider traffic. The renderer
//! sees connection summaries and model lists, never a key or a token.

pub(crate) mod address;
pub(crate) mod connections;
pub(crate) mod error;
pub(crate) mod http;
pub(crate) mod models;
#[cfg(test)]
pub(crate) mod test_server;

use std::sync::Arc;

use tokio_util::sync::CancellationToken;

use self::{
    address::Address,
    connections::{
        ApiConnectionInput, ConnectionRemoved, ConnectionSaved, ConnectionSummary, Connections,
        Secret,
    },
    error::CoachError,
    http::HttpClients,
    models::{ModelList, MAX_MODEL_LIST_BYTES},
};
use crate::{
    credentials::{CoachConnectionHandle, CoachCredentials},
    infra::{blocking::BLOCKING_GATEWAY, path_authority::AppDataDir},
};

/// Switch for release builds. The Coach stays hidden there until Felix's "release"; `.dev` builds
/// always have it.
pub(crate) const RELEASE_AVAILABLE: bool = false;

fn available_for(identifier: &str) -> bool {
    RELEASE_AVAILABLE || identifier.ends_with(".dev")
}

pub(crate) struct Coach {
    available: bool,
    connections: Connections,
    http: HttpClients,
}

impl Coach {
    fn new(available: bool, credentials: Arc<CoachCredentials>) -> Result<Self, CoachError> {
        Ok(Self {
            available,
            connections: Connections::new(credentials),
            http: HttpClients::new()?,
        })
    }

    async fn models(&self, handle: CoachConnectionHandle) -> Result<ModelList, CoachError> {
        let Secret::Api { address, key } = self.connections.secret(handle).await?;
        // The class is derived from the stored text on every use, never taken from the caller.
        let address = Address::parse(&address).map_err(|_| CoachError::NeedsRepair)?;
        let url = address.endpoint("models");
        let mut request = self.http.for_address(&address).get(url.clone());
        if let Some(key) = key.filter(|_| address.owns(&url)) {
            request = request.bearer_auth(key);
        }
        let (status, body) = http::send_bounded(request, MAX_MODEL_LIST_BYTES).await?;
        match status {
            200 => models::parse_model_list(&body),
            401 | 403 => Err(CoachError::KeyRejected),
            429 => Err(CoachError::RateLimited),
            _ => Err(CoachError::ProviderFailure),
        }
    }
}

pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<Coach, CoachError> {
    let identifier = app.config().identifier.clone();
    let credentials = Arc::new(CoachCredentials::new(&identifier));
    let worker_credentials = credentials.clone();
    let handle = app.clone();
    tauri::async_runtime::block_on(BLOCKING_GATEWAY.spawn_cancellable(
        CancellationToken::new(),
        move |_| {
            let data = AppDataDir::for_app(&handle)?;
            worker_credentials.initialize(&data)
        },
    ))
    .map_err(|_| CoachError::Storage)?;
    Coach::new(available_for(&identifier), credentials)
}

/// Every Coach command goes through here, so a build with the switch off refuses all of them.
fn coach(state: &crate::AppState) -> Result<&Coach, CoachError> {
    state
        .coach
        .get()
        .filter(|coach| coach.available)
        .ok_or(CoachError::Unavailable)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_available(
    state: tauri::State<'_, crate::AppState>,
) -> Result<bool, CoachError> {
    Ok(coach(&state).is_ok())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_connections(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ConnectionSummary>, CoachError> {
    coach(&state)?.connections.list().await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_save_api_connection(
    connection: ApiConnectionInput,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ConnectionSaved, CoachError> {
    coach(&state)?.connections.save_api(connection).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_remove_connection(
    handle: CoachConnectionHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ConnectionRemoved, CoachError> {
    coach(&state)?.connections.remove(handle).await
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn coach_models(
    handle: CoachConnectionHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<ModelList, CoachError> {
    coach(&state)?.models(handle).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::MemoryCredentialStore;
    use axum::{
        http::{header::AUTHORIZATION, HeaderMap, StatusCode},
        routing::get,
        Router,
    };
    use std::sync::Mutex;
    use tauri::Manager;

    fn test_coach(available: bool) -> (Coach, tempfile::TempDir) {
        let (credentials, directory) =
            CoachCredentials::for_test(Arc::new(MemoryCredentialStore::default()));
        (
            Coach::new(available, Arc::new(credentials)).unwrap(),
            directory,
        )
    }

    async fn local_connection(
        coach: &Coach,
        address: &str,
        key: Option<&str>,
    ) -> CoachConnectionHandle {
        coach
            .connections
            .save_api(ApiConnectionInput {
                handle: None,
                label: "Test".into(),
                address: address.into(),
                key: key.map(str::to_owned),
            })
            .await
            .unwrap()
            .connection
            .handle
    }

    #[test]
    fn only_dev_builds_have_the_coach_while_the_release_switch_is_off() {
        assert!(available_for("com.chessriddle.studio.dev"));
        // Turning the Coach on for release builds is Felix's release decision.
        assert!(!available_for("com.chessriddle.studio"));
        assert!(!available_for("com.chessriddle.studio.developer"));
    }

    #[tokio::test]
    async fn every_command_refuses_when_the_coach_is_off_or_not_initialized() {
        let handle = || CoachConnectionHandle(uuid::Uuid::new_v4().to_string());
        let input = || ApiConnectionInput {
            handle: None,
            label: "Local".into(),
            address: "http://localhost:11434/v1".into(),
            key: None,
        };
        for coach in [None, Some(test_coach(false))] {
            let app = tauri::test::mock_app();
            let state = crate::AppState::default();
            let _directory = coach.map(|(coach, directory)| {
                assert!(state.coach.set(coach).is_ok());
                directory
            });
            app.manage(state);

            assert_eq!(coach_available(app.state()).await, Ok(false));
            assert_eq!(
                coach_connections(app.state()).await.unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_save_api_connection(input(), app.state())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_remove_connection(handle(), app.state())
                    .await
                    .unwrap_err(),
                CoachError::Unavailable
            );
            assert_eq!(
                coach_models(handle(), app.state()).await.unwrap_err(),
                CoachError::Unavailable
            );
        }
    }

    #[tokio::test]
    async fn an_available_coach_answers_its_commands() {
        let (coach, _directory) = test_coach(true);
        let app = tauri::test::mock_app();
        let state = crate::AppState::default();
        assert!(state.coach.set(coach).is_ok());
        app.manage(state);

        assert_eq!(coach_available(app.state()).await, Ok(true));
        assert_eq!(coach_connections(app.state()).await, Ok(vec![]));
    }

    #[tokio::test]
    async fn the_model_list_is_loaded_with_the_stored_key() {
        let seen = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
        let recorded = seen.clone();
        let server = test_server::serve(Router::new().route(
            "/v1/models",
            get(move |headers: HeaderMap| {
                let recorded = recorded.clone();
                async move {
                    recorded.lock().unwrap().push(
                        headers
                            .get(AUTHORIZATION)
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                    );
                    r#"{"data":[{"id":"local-model"}]}"#
                }
            }),
        ));
        let (coach, _directory) = test_coach(true);

        let with_key = local_connection(&coach, &server.url("/v1"), Some("sk-local")).await;
        let list = coach.models(with_key).await.unwrap();
        assert_eq!(list.models.len(), 1);
        assert_eq!(list.models[0].id, "local-model");

        let without_key = local_connection(&coach, &server.url("/v1/"), None).await;
        coach.models(without_key).await.unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            vec![Some("Bearer sk-local".to_owned()), None]
        );
    }

    #[tokio::test]
    async fn model_list_failures_are_typed_and_never_an_empty_list() {
        let oversized = "x".repeat(MAX_MODEL_LIST_BYTES + 1);
        let server = test_server::serve(
            Router::new()
                .route(
                    "/rejected/models",
                    get(|| async { StatusCode::UNAUTHORIZED }),
                )
                .route("/forbidden/models", get(|| async { StatusCode::FORBIDDEN }))
                .route(
                    "/limited/models",
                    get(|| async { StatusCode::TOO_MANY_REQUESTS }),
                )
                .route(
                    "/broken/models",
                    get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
                )
                .route(
                    "/html/models",
                    get(|| async { "<html>not a model list</html>" }),
                )
                .route("/huge/models", get(move || async move { oversized })),
        );
        let (coach, _directory) = test_coach(true);
        for (path, expected) in [
            ("/rejected", CoachError::KeyRejected),
            ("/forbidden", CoachError::KeyRejected),
            ("/limited", CoachError::RateLimited),
            ("/broken", CoachError::ProviderFailure),
            ("/missing", CoachError::ProviderFailure),
            ("/html", CoachError::ProviderFailure),
            ("/huge", CoachError::ProviderFailure),
        ] {
            let handle = local_connection(&coach, &server.url(path), Some("sk")).await;
            assert_eq!(coach.models(handle).await.unwrap_err(), expected, "{path}");
        }

        let closed = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/v1", listener.local_addr().unwrap())
        };
        let handle = local_connection(&coach, &closed, None).await;
        assert_eq!(coach.models(handle).await.unwrap_err(), CoachError::Network);

        let unknown = CoachConnectionHandle(uuid::Uuid::new_v4().to_string());
        assert_eq!(
            coach.models(unknown).await.unwrap_err(),
            CoachError::NotFound
        );
    }
}
