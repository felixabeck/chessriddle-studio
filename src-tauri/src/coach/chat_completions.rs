//! The Chat Completions wire format, as OpenAI-compatible services and local runners speak it.

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::{
    address::Address,
    backend::{
        Message, ModelBackend, Round, RoundFailure, RoundRequest, TextSink, ToolCall,
        MAX_ROUND_TEXT_BYTES, MAX_STREAMED_TOOL_CALLS, MAX_TOOL_ARGUMENT_BYTES,
    },
    error::CoachError,
    http::{classify_refusal, diagnostic, error_text, MAX_ERROR_BODY_BYTES},
    sse::SseStream,
};
use crate::infra::net::read_bounded_body;

const DONE: &str = "[DONE]";

pub(crate) struct ChatCompletions {
    client: reqwest::Client,
    address: Address,
    key: Option<String>,
}

impl ChatCompletions {
    pub(crate) fn new(client: reqwest::Client, address: Address, key: Option<String>) -> Self {
        Self {
            client,
            address,
            key,
        }
    }

    /// The provider's own words about a failure, for the native log only.
    fn diagnostic(&self, text: &str) -> String {
        diagnostic(text, self.key.as_deref())
    }
}

fn request_body(request: &RoundRequest<'_>) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": request.system })];
    for message in request.messages {
        messages.push(match message {
            Message::User(text) => json!({ "role": "user", "content": text }),
            Message::Assistant {
                text,
                tool_calls,
                extra,
            } => {
                let mut object = extra.clone();
                object.insert("role".into(), "assistant".into());
                object.insert(
                    "content".into(),
                    if text.is_empty() && !tool_calls.is_empty() {
                        Value::Null
                    } else {
                        text.as_str().into()
                    },
                );
                if !tool_calls.is_empty() {
                    let calls: Vec<Value> = tool_calls
                        .iter()
                        .map(|call| {
                            json!({
                                "id": call.id,
                                "type": "function",
                                "function": { "name": call.name, "arguments": call.arguments },
                            })
                        })
                        .collect();
                    object.insert("tool_calls".into(), calls.into());
                }
                Value::Object(object)
            }
            Message::ToolResult { call_id, content } => {
                json!({ "role": "tool", "tool_call_id": call_id, "content": content })
            }
        });
    }
    let mut body = Map::new();
    body.insert("model".into(), request.model.into());
    body.insert("messages".into(), messages.into());
    body.insert("stream".into(), true.into());
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                })
            })
            .collect();
        body.insert("tools".into(), tools.into());
    }
    // `tool_choice` is never sent: some runners refuse the field, and "auto" is the default.
    if let Some(effort) = request.effort {
        body.insert("reasoning_effort".into(), effort.into());
    }
    Value::Object(body)
}

#[derive(Default)]
struct PendingCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

/// Collects the deltas of one streamed round.
#[derive(Default)]
struct Accumulator {
    text: String,
    reasoning: String,
    calls: Vec<PendingCall>,
    finish_reason: Option<String>,
}

impl Accumulator {
    /// Takes one event. `Err` carries the code only; the caller adds the text kept so far.
    fn accept(
        &mut self,
        data: &str,
        on_text: &mut TextSink<'_>,
    ) -> Result<(), (CoachError, Option<String>)> {
        let event: Value =
            serde_json::from_str(data).map_err(|_| (CoachError::ProviderFailure, None))?;
        if let Some(error) = event.get("error").filter(|error| !error.is_null()) {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .map_or_else(|| error.to_string(), str::to_owned);
            return Err((CoachError::ProviderFailure, Some(message)));
        }
        let Some(choice) = event.pointer("/choices/0") else {
            // Usage and keep-alive events carry no choice.
            return Ok(());
        };
        if let Some(delta) = choice.get("delta") {
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                if self.text.len() + text.len() > MAX_ROUND_TEXT_BYTES {
                    return Err((CoachError::LimitExceeded, None));
                }
                self.text.push_str(text);
                if !text.is_empty() {
                    on_text(text);
                }
            }
            if let Some(reasoning) = delta.get("reasoning_content").and_then(Value::as_str) {
                if self.reasoning.len() + reasoning.len() > MAX_ROUND_TEXT_BYTES {
                    return Err((CoachError::LimitExceeded, None));
                }
                self.reasoning.push_str(reasoning);
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    self.accept_call(call).map_err(|error| (error, None))?;
                }
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }
        Ok(())
    }

    fn accept_call(&mut self, delta: &Value) -> Result<(), CoachError> {
        // Deltas of one call share an index; a provider that sends none sends whole calls.
        let index = match delta.get("index").and_then(Value::as_u64) {
            Some(index) => usize::try_from(index).map_err(|_| CoachError::ProviderFailure)?,
            None => self.calls.len(),
        };
        if index >= MAX_STREAMED_TOOL_CALLS {
            return Err(CoachError::LimitExceeded);
        }
        while self.calls.len() <= index {
            self.calls.push(PendingCall::default());
        }
        let call = &mut self.calls[index];
        if let Some(id) = delta.get("id").and_then(Value::as_str) {
            call.id = Some(id.to_owned());
        }
        if let Some(function) = delta.get("function") {
            if let Some(name) = function.get("name").and_then(Value::as_str) {
                call.name.push_str(name);
            }
            // Most providers stream the arguments as text; some send the finished object.
            let piece = match function.get("arguments") {
                Some(Value::String(text)) => Some(text.clone()),
                Some(Value::Null) | None => None,
                Some(object) => Some(object.to_string()),
            };
            if let Some(piece) = piece {
                if call.arguments.len() + piece.len() > MAX_TOOL_ARGUMENT_BYTES {
                    return Err(CoachError::LimitExceeded);
                }
                call.arguments.push_str(&piece);
            }
        }
        Ok(())
    }

    /// The round, if the provider said it is complete.
    fn finish(self) -> Result<Round, RoundFailure> {
        let fail = |error, text| Err(RoundFailure { error, text });
        match self.finish_reason.as_deref() {
            Some("stop" | "tool_calls" | "function_call") => {}
            Some("length") => return fail(CoachError::AnswerCutOff, self.text),
            Some("content_filter") => return fail(CoachError::ContentFiltered, self.text),
            // A stream that ends without saying why is not a complete answer.
            _ => return fail(CoachError::ProviderFailure, self.text),
        }
        let mut tool_calls = Vec::with_capacity(self.calls.len());
        for (index, call) in self.calls.into_iter().enumerate() {
            if call.name.is_empty() {
                return fail(CoachError::ProviderFailure, self.text);
            }
            tool_calls.push(ToolCall {
                id: call.id.unwrap_or_else(|| format!("call_{index}")),
                name: call.name,
                arguments: call.arguments,
            });
        }
        let mut extra = Map::new();
        if !self.reasoning.is_empty() {
            extra.insert("reasoning_content".into(), self.reasoning.into());
        }
        Ok(Round {
            text: self.text,
            tool_calls,
            extra,
        })
    }
}

#[async_trait]
impl ModelBackend for ChatCompletions {
    async fn round(
        &self,
        request: RoundRequest<'_>,
        on_text: &mut TextSink<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Round, RoundFailure> {
        let url = self.address.endpoint("chat/completions");
        let mut builder = self.client.post(url.clone()).json(&request_body(&request));
        if let Some(key) = self.key.as_deref().filter(|_| self.address.owns(&url)) {
            builder = builder.bearer_auth(key);
        }
        let response = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RoundFailure::new(CoachError::Cancelled)),
            response = builder.send() => response.map_err(|_| RoundFailure::new(CoachError::Network))?,
        };
        let status = response.status();
        if !status.is_success() {
            let body = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(RoundFailure::new(CoachError::Cancelled)),
                body = read_bounded_body(response, MAX_ERROR_BODY_BYTES) => body.unwrap_or_default(),
            };
            let message = error_text(&body);
            let error = classify_refusal(status.as_u16(), &message, request.effort.is_some());
            log::warn!(
                "coach: chat completions refused with HTTP {}: {}",
                status.as_u16(),
                self.diagnostic(&message)
            );
            return Err(RoundFailure::new(error));
        }
        let mut stream = SseStream::new(response);
        let mut round = Accumulator::default();
        loop {
            let data = match stream.next(cancellation).await {
                Ok(Some(data)) => data,
                Ok(None) => break,
                Err(error) => {
                    return Err(RoundFailure {
                        error,
                        text: round.text,
                    })
                }
            };
            if data.trim() == DONE {
                break;
            }
            if let Err((error, message)) = round.accept(&data, on_text) {
                if let Some(message) = message {
                    log::warn!(
                        "coach: chat completions stream failed: {}",
                        self.diagnostic(&message)
                    );
                }
                return Err(RoundFailure {
                    error,
                    text: round.text,
                });
            }
        }
        round.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coach::{backend::ToolSpec, test_server};
    use axum::{
        body::StreamBody,
        http::{header::AUTHORIZATION, header::CONTENT_TYPE, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    use std::sync::{Arc, Mutex};

    type Seen = Arc<Mutex<Vec<(Option<String>, Value)>>>;

    fn sse(chunks: Vec<String>) -> impl IntoResponse {
        let stream =
            futures_util::stream::iter(chunks.into_iter().map(Ok::<_, std::convert::Infallible>));
        (
            [(CONTENT_TYPE, "text/event-stream")],
            StreamBody::new(stream),
        )
    }

    fn event(value: Value) -> String {
        format!("data: {value}\n\n")
    }

    fn text_delta(text: &str) -> String {
        event(json!({ "choices": [{ "index": 0, "delta": { "content": text } }] }))
    }

    fn finish(reason: &str) -> String {
        event(json!({ "choices": [{ "index": 0, "delta": {}, "finish_reason": reason }] }))
    }

    /// A provider double that answers every round with `chunks` and records what it was sent.
    fn provider(chunks: Vec<String>) -> (test_server::TestServer, Seen) {
        let seen = Seen::default();
        let record = seen.clone();
        let router = Router::new().route(
            "/v1/chat/completions",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let authorization = headers
                    .get(AUTHORIZATION)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned);
                record.lock().unwrap().push((authorization, body));
                let chunks = chunks.clone();
                async move { sse(chunks) }
            }),
        );
        (test_server::serve(router), seen)
    }

    fn refusing(status: StatusCode, body: Value) -> test_server::TestServer {
        test_server::serve(Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let body = body.clone();
                async move { (status, Json(body)) }
            }),
        ))
    }

    fn backend(server: &test_server::TestServer, key: Option<&str>) -> ChatCompletions {
        ChatCompletions::new(
            crate::infra::net::local_streaming_http_client(reqwest::Client::builder()).unwrap(),
            Address::parse(&server.url("/v1")).unwrap(),
            key.map(str::to_owned),
        )
    }

    fn tools() -> Vec<ToolSpec> {
        vec![ToolSpec {
            name: "analyse",
            description: "Analyse a line.",
            parameters: json!({ "type": "object", "properties": {} }),
        }]
    }

    async fn run(
        backend: &ChatCompletions,
        messages: &[Message],
        effort: Option<&str>,
        tools: &[ToolSpec],
    ) -> (Result<Round, RoundFailure>, String) {
        let mut streamed = String::new();
        let result = backend
            .round(
                RoundRequest {
                    model: "test-model",
                    effort,
                    system: "You are a coach.",
                    messages,
                    tools,
                },
                &mut |text| streamed.push_str(text),
                &CancellationToken::new(),
            )
            .await;
        (result, streamed)
    }

    fn user() -> Vec<Message> {
        vec![Message::User("What is the plan?".into())]
    }

    #[tokio::test]
    async fn a_text_round_streams_and_completes_on_stop() {
        let (server, seen) = provider(vec![
            ": keep-alive\n\n".into(),
            text_delta("Play "),
            text_delta("[[Nf3]]."),
            event(json!({ "choices": [], "usage": { "total_tokens": 9 } })),
            finish("stop"),
            "data: [DONE]\n\n".into(),
        ]);
        let (result, streamed) =
            run(&backend(&server, Some("sk-test")), &user(), None, &tools()).await;
        let round = result.unwrap();
        assert_eq!(round.text, "Play [[Nf3]].");
        assert_eq!(streamed, "Play [[Nf3]].");
        assert!(round.tool_calls.is_empty());

        let seen = seen.lock().unwrap();
        let (authorization, body) = &seen[0];
        assert_eq!(authorization.as_deref(), Some("Bearer sk-test"));
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["stream"], true);
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "You are a coach." })
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "What is the plan?" })
        );
        assert_eq!(body["tools"][0]["function"]["name"], "analyse");
        // No effort is sent unless one was chosen, and `tool_choice` never is.
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("tool_choice").is_none());
    }

    #[tokio::test]
    async fn effort_is_sent_only_when_chosen_and_a_keyless_runner_gets_no_header() {
        let (server, seen) = provider(vec![text_delta("ok"), finish("stop")]);
        let backend = backend(&server, None);
        run(&backend, &user(), Some("high"), &[]).await.0.unwrap();
        let seen = seen.lock().unwrap();
        let (authorization, body) = &seen[0];
        assert!(authorization.is_none());
        assert_eq!(body["reasoning_effort"], "high");
        assert!(body.get("tools").is_none());
    }

    #[tokio::test]
    async fn tool_calls_split_across_chunks_are_joined_by_index() {
        let call = |index: u64, id: Option<&str>, name: Option<&str>, arguments: &str| {
            let mut function = Map::new();
            if let Some(name) = name {
                function.insert("name".into(), name.into());
            }
            function.insert("arguments".into(), arguments.into());
            let mut delta = Map::new();
            delta.insert("index".into(), index.into());
            if let Some(id) = id {
                delta.insert("id".into(), id.into());
            }
            delta.insert("function".into(), function.into());
            event(json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [delta] } }] }))
        };
        let (server, _) = provider(vec![
            call(0, Some("call_a"), Some("analyse"), "{\"line\":"),
            call(1, Some("call_b"), Some("analyse"), "{}"),
            call(0, None, None, "\"Nf3\"}"),
            finish("tool_calls"),
        ]);
        let round = run(&backend(&server, None), &user(), None, &tools())
            .await
            .0
            .unwrap();
        assert_eq!(
            round.tool_calls,
            [
                ToolCall {
                    id: "call_a".into(),
                    name: "analyse".into(),
                    arguments: "{\"line\":\"Nf3\"}".into()
                },
                ToolCall {
                    id: "call_b".into(),
                    name: "analyse".into(),
                    arguments: "{}".into()
                },
            ]
        );
    }

    #[tokio::test]
    async fn the_assistant_round_and_its_tool_results_are_sent_back_with_provider_fields() {
        let (server, seen) = provider(vec![
            event(
                json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "Think " } }] }),
            ),
            event(
                json!({ "choices": [{ "index": 0, "delta": { "reasoning_content": "hard." } }] }),
            ),
            event(json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "id": "c1", "function": { "name": "analyse", "arguments": { "line": "e4" } } }
            ] } }] })),
            finish("stop"),
        ]);
        let backend = backend(&server, None);
        let round = run(&backend, &user(), None, &tools()).await.0.unwrap();
        assert_eq!(round.extra["reasoning_content"], "Think hard.");
        assert_eq!(round.tool_calls[0].arguments, "{\"line\":\"e4\"}");

        let mut messages = user();
        messages.push(round.into_message());
        messages.push(Message::ToolResult {
            call_id: "c1".into(),
            content: "{\"lines\":[]}".into(),
        });
        run(&backend, &messages, None, &tools()).await.0.unwrap();
        let seen = seen.lock().unwrap();
        let sent = &seen[1].1["messages"];
        assert_eq!(sent[2]["role"], "assistant");
        assert_eq!(sent[2]["content"], Value::Null);
        assert_eq!(sent[2]["reasoning_content"], "Think hard.");
        assert_eq!(sent[2]["tool_calls"][0]["id"], "c1");
        assert_eq!(sent[2]["tool_calls"][0]["type"], "function");
        assert_eq!(
            sent[2]["tool_calls"][0]["function"]["arguments"],
            "{\"line\":\"e4\"}"
        );
        assert_eq!(
            sent[3],
            json!({ "role": "tool", "tool_call_id": "c1", "content": "{\"lines\":[]}" })
        );
    }

    #[tokio::test]
    async fn a_round_is_complete_only_when_the_provider_says_so() {
        for (chunks, expected) in [
            (vec![text_delta("Half an ans")], CoachError::ProviderFailure),
            (
                vec![text_delta("Half an ans"), finish("length")],
                CoachError::AnswerCutOff,
            ),
            (
                vec![text_delta("Half an ans"), finish("content_filter")],
                CoachError::ContentFiltered,
            ),
            (
                vec![
                    text_delta("Half an ans"),
                    event(json!({ "error": { "message": "upstream sk-test died", "code": 502 } })),
                ],
                CoachError::ProviderFailure,
            ),
            (
                vec![text_delta("Half an ans"), "data: not json\n\n".into()],
                CoachError::ProviderFailure,
            ),
        ] {
            let (server, _) = provider(chunks);
            let (result, streamed) =
                run(&backend(&server, Some("sk-test")), &user(), None, &tools()).await;
            // The text streamed so far is kept with the failure.
            assert_eq!(
                result.unwrap_err(),
                RoundFailure {
                    error: expected,
                    text: "Half an ans".into()
                }
            );
            assert_eq!(streamed, "Half an ans");
        }
    }

    #[tokio::test]
    async fn oversized_text_arguments_and_call_counts_end_the_round() {
        let big_text = "x".repeat(MAX_ROUND_TEXT_BYTES / 2 + 1);
        let big_argument = "y".repeat(MAX_TOOL_ARGUMENT_BYTES / 2 + 1);
        let argument = |text: &str| {
            event(json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
                { "index": 0, "id": "c", "function": { "name": "analyse", "arguments": text } }
            ] } }] }))
        };
        let too_many = event(json!({ "choices": [{ "index": 0, "delta": { "tool_calls": [
            { "index": MAX_STREAMED_TOOL_CALLS, "id": "c", "function": { "name": "analyse", "arguments": "{}" } }
        ] } }] }));
        for chunks in [
            vec![text_delta(&big_text), text_delta(&big_text), finish("stop")],
            vec![
                argument(&big_argument),
                argument(&big_argument),
                finish("tool_calls"),
            ],
            vec![too_many, finish("tool_calls")],
        ] {
            let (server, _) = provider(chunks);
            let error = run(&backend(&server, None), &user(), None, &tools())
                .await
                .0
                .unwrap_err();
            assert_eq!(error.error, CoachError::LimitExceeded);
        }
    }

    #[tokio::test]
    async fn refusals_are_told_apart_by_status_and_wording() {
        let message = |text: &str| json!({ "error": { "message": text } });
        for (status, body, effort, expected) in [
            (
                StatusCode::UNAUTHORIZED,
                message("Incorrect API key"),
                None,
                CoachError::KeyRejected,
            ),
            (
                StatusCode::FORBIDDEN,
                message("no access"),
                None,
                CoachError::KeyRejected,
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                message("slow down"),
                None,
                CoachError::RateLimited,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": "registry.ollama.ai/library/gemma:2b does not support tools" }),
                None,
                CoachError::NoFunctionCalling,
            ),
            (
                StatusCode::NOT_FOUND,
                message("No endpoints found that support tool use."),
                None,
                CoachError::NoFunctionCalling,
            ),
            (
                StatusCode::BAD_REQUEST,
                message("Unsupported parameter: 'reasoning_effort'"),
                Some("high"),
                CoachError::EffortRejected,
            ),
            // Without an effort in the request the same wording is not blamed on it.
            (
                StatusCode::BAD_REQUEST,
                message("Unsupported parameter: 'reasoning_effort'"),
                None,
                CoachError::ProviderFailure,
            ),
            (
                StatusCode::BAD_REQUEST,
                message("The model `gone` does not exist"),
                None,
                CoachError::ModelUnavailable,
            ),
            (
                StatusCode::NOT_FOUND,
                message("unknown"),
                None,
                CoachError::ModelUnavailable,
            ),
            (
                StatusCode::BAD_REQUEST,
                message("bad request"),
                None,
                CoachError::ProviderFailure,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!("oops"),
                None,
                CoachError::ProviderFailure,
            ),
        ] {
            let server = refusing(status, body.clone());
            let error = run(
                &backend(&server, Some("sk-test")),
                &user(),
                effort,
                &tools(),
            )
            .await
            .0
            .unwrap_err();
            assert_eq!(error, RoundFailure::new(expected), "{status} {body}");
        }
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_a_network_failure() {
        let server = test_server::serve(Router::new());
        let address = server.url("/v1");
        drop(server);
        tokio::task::yield_now().await;
        let backend = ChatCompletions::new(
            crate::infra::net::local_streaming_http_client(reqwest::Client::builder()).unwrap(),
            Address::parse(&address).unwrap(),
            None,
        );
        let error = run(&backend, &user(), None, &[]).await.0.unwrap_err();
        assert_eq!(error, RoundFailure::new(CoachError::Network));
    }

    #[tokio::test]
    async fn cancellation_ends_a_silent_stream_at_once_and_keeps_the_text() {
        let router = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                let first = futures_util::stream::iter([Ok::<_, std::convert::Infallible>(
                    text_delta("Thinking"),
                )]);
                let silent = futures_util::stream::pending();
                (
                    [(CONTENT_TYPE, "text/event-stream")],
                    StreamBody::new(futures_util::StreamExt::chain(first, silent)),
                )
            }),
        );
        let server = test_server::serve(router);
        let backend = backend(&server, None);
        let cancellation = CancellationToken::new();
        let (seen_text, mut text_seen) = tokio::sync::mpsc::unbounded_channel::<()>();
        let cancel = cancellation.clone();
        tokio::spawn(async move {
            text_seen.recv().await;
            cancel.cancel();
        });
        let messages = user();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            backend.round(
                RoundRequest {
                    model: "m",
                    effort: None,
                    system: "s",
                    messages: &messages,
                    tools: &[],
                },
                &mut |_| {
                    let _ = seen_text.send(());
                },
                &cancellation,
            ),
        )
        .await
        .expect("cancellation must end the round");
        assert_eq!(
            result.unwrap_err(),
            RoundFailure {
                error: CoachError::Cancelled,
                text: "Thinking".into()
            }
        );
    }

    #[test]
    fn a_diagnostic_of_this_backend_never_carries_its_key() {
        let backend = ChatCompletions::new(
            reqwest::Client::new(),
            Address::parse("http://localhost:1/v1").unwrap(),
            Some("sk-secret".into()),
        );
        let text = format!("Incorrect key sk-secret. {}", "z".repeat(2000));
        let diagnostic = backend.diagnostic(&text);
        assert!(!diagnostic.contains("sk-secret"));
        assert!(diagnostic.contains("[key]"));
        assert!(diagnostic.chars().count() < text.chars().count());
    }
}
