//! The Responses wire format, as the sign-in providers speak it.
//!
//! Every request is stateless (`store: false`) and streamed. The history of a turn is therefore
//! sent again in `input` each round: what the model put out in an earlier round (its tool calls,
//! and its reasoning where the provider hands that out in a form that can be sent back) followed
//! by the results of the calls. A round counts as complete only when the provider says
//! `response.completed`.
//!
//! Where the providers of this format differ (how tools are declared, what a refusal means) is
//! decided by [`PlanProvider`].

use async_trait::async_trait;
use serde_json::{json, Map, Value};
use tokio_util::sync::CancellationToken;

use super::{
    accounts::BearerSource,
    backend::{
        Message, ModelBackend, Round, RoundFailure, RoundRequest, TextSink, ToolCall,
        MAX_ROUND_TEXT_BYTES, MAX_STREAMED_TOOL_CALLS, MAX_TOOL_ARGUMENT_BYTES,
    },
    error::CoachError,
    http::{classify_refusal, diagnostic, error_text, MAX_ERROR_BODY_BYTES},
    sse::SseStream,
};
use crate::infra::net::read_bounded_body;

/// The key under which a round keeps what the model put out, for the next request of its turn.
const OUTPUT: &str = "output";
/// Output items kept from one round.
const MAX_OUTPUT_ITEMS: usize = 64;
/// What one round's output may weigh when it is sent back (1 MiB).
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// Asks for reasoning in a form that can be sent back without the provider storing anything.
const ENCRYPTED_REASONING: &str = "reasoning.encrypted_content";
/// The line some providers end the stream with, after the events.
const DONE: &str = "[DONE]";

/// The namespace the tools are declared in where a provider wants them grouped.
const TOOL_NAMESPACE: &str = "chess";

/// The sign-in providers that speak this format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PlanProvider {
    /// Tools grouped in one namespace; a refusal names what it is about by its code.
    ChatGpt,
    /// Each tool on its own, at the top level; every 403 is about the subscription or its credits.
    Grok,
}

pub(crate) struct Responses<B> {
    client: reqwest::Client,
    url: String,
    tokens: B,
    provider: PlanProvider,
}

impl<B: BearerSource> Responses<B> {
    pub(crate) fn new(
        client: reqwest::Client,
        url: String,
        tokens: B,
        provider: PlanProvider,
    ) -> Self {
        Self {
            client,
            url,
            tokens,
            provider,
        }
    }
}

fn tools(request: &RoundRequest<'_>, provider: PlanProvider) -> Vec<Value> {
    let mut functions: Vec<Value> = request
        .tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
            })
        })
        .collect();
    match provider {
        PlanProvider::ChatGpt => {
            // The schemas have optional arguments, which the strict mode there does not allow.
            for function in &mut functions {
                function["strict"] = false.into();
            }
            vec![json!({
                "type": "namespace",
                "name": TOOL_NAMESPACE,
                "description": "Read-only chess tools: the engine and the reference database.",
                "tools": functions,
            })]
        }
        // The flat declaration is sent exactly as its provider documents it.
        PlanProvider::Grok => functions,
    }
}

/// An output item as it is sent back. A reasoning item can only be sent back in its encrypted
/// form; without that the round's items go back without their ids, which is what ties a tool call
/// to its reasoning.
fn resendable(items: &[Value]) -> Vec<Value> {
    let reasoning_complete = items
        .iter()
        .filter(|item| item["type"] == "reasoning")
        .all(|item| item.get("encrypted_content").is_some_and(Value::is_string));
    items
        .iter()
        .filter(|item| reasoning_complete || item["type"] != "reasoning")
        .map(|item| {
            let mut item = item.clone();
            if let Some(object) = item.as_object_mut() {
                object.remove("status");
                if !reasoning_complete {
                    object.remove("id");
                }
            }
            item
        })
        .collect()
}

fn request_body(request: &RoundRequest<'_>, provider: PlanProvider, with_reasoning: bool) -> Value {
    let mut input = Vec::new();
    for message in request.messages {
        match message {
            Message::User(text) => input.push(json!({ "role": "user", "content": text })),
            Message::UserWithImages { text, images } => {
                let mut parts = Vec::with_capacity(1 + images.len());
                parts.push(json!({ "type": "input_text", "text": text }));
                for url in images {
                    parts.push(json!({ "type": "input_image", "image_url": url }));
                }
                input.push(json!({ "role": "user", "content": parts }));
            }
            Message::Assistant {
                text,
                tool_calls,
                extra,
            } => match extra.get(OUTPUT).and_then(Value::as_array) {
                // A round of this turn: exactly what the model put out.
                Some(items) => input.extend(resendable(items)),
                // An answer of an earlier turn, or of another backend: its text and its calls.
                None => {
                    if !text.is_empty() {
                        input.push(json!({ "role": "assistant", "content": text }));
                    }
                    for call in tool_calls {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call.id,
                            "name": call.name,
                            "arguments": call.arguments,
                        }));
                    }
                }
            },
            Message::ToolResult { call_id, content } => input.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": content,
            })),
        }
    }
    let mut body = Map::new();
    body.insert("model".into(), request.model.into());
    // A system-role item is refused on the plan route; the instructions field is what it takes.
    body.insert("instructions".into(), request.system.into());
    body.insert("input".into(), input.into());
    body.insert("store".into(), false.into());
    body.insert("stream".into(), true.into());
    if !request.tools.is_empty() {
        body.insert("tools".into(), tools(request, provider).into());
    }
    if with_reasoning {
        body.insert("include".into(), json!([ENCRYPTED_REASONING]));
    }
    if let Some(effort) = request.effort {
        body.insert("reasoning".into(), json!({ "effort": effort }));
    }
    Value::Object(body)
}

/// The code and the parameter a structured error names.
fn error_fields(error: &Value) -> (&str, &str) {
    let field = |name: &str| error.get(name).and_then(Value::as_str).unwrap_or_default();
    (field("code"), field("param"))
}

/// What a provider's error code means for the user, where the code alone says it.
fn classify_code(code: &str) -> Option<CoachError> {
    match code {
        "subscription_sharing_usage_limit_exceeded" => Some(CoachError::UsageLimitReached),
        "subscription_sharing_user_not_eligible" => Some(CoachError::SubscriptionNotEligible),
        "subscription_sharing_usage_unavailable" | "subscription_sharing_user_unavailable" => {
            Some(CoachError::RateLimited)
        }
        "rate_limit_exceeded" => Some(CoachError::RateLimited),
        _ => None,
    }
}

/// A refused request of a signed-in connection. `param` is the request field the provider named.
pub(crate) fn classify_plan_refusal(
    provider: PlanProvider,
    status: u16,
    body: &[u8],
    effort_sent: bool,
    has_images: bool,
) -> (CoachError, String) {
    let message = error_text(body);
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let (code, param) = value.get("error").map_or(("", ""), error_fields);
    let error = classify_code(code).unwrap_or_else(|| match status {
        // The token itself was accepted as fresh a moment ago: this is no "sign in again".
        401 => CoachError::ProviderFailure,
        // Grok answers an account without credits with the same 403 and only says so in words.
        403 if provider == PlanProvider::Grok && message.to_lowercase().contains("credits") => {
            CoachError::CreditsExhausted
        }
        // Signed in, but this account, plan or region may not use the plan from other apps.
        403 if code.is_empty() || provider == PlanProvider::Grok => {
            CoachError::SubscriptionNotEligible
        }
        // On the ChatGPT route a 403 with another code is about how this app asks, not about
        // the account.
        403 => CoachError::ProviderFailure,
        429 | 503 => CoachError::RateLimited,
        400 if param.starts_with("reasoning") && effort_sent => CoachError::EffortRejected,
        400 if param.starts_with("tools") => CoachError::NoFunctionCalling,
        400 | 404 | 422 => match classify_refusal(status, &message, effort_sent, has_images) {
            // There is no key on this route.
            CoachError::KeyRejected => CoachError::ProviderFailure,
            other => other,
        },
        _ => CoachError::ProviderFailure,
    });
    (error, message)
}

/// Whether a refusal is about the request asking for encrypted reasoning.
fn refuses_reasoning_include(status: u16, body: &[u8]) -> bool {
    if status != 400 {
        return false;
    }
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let (_, param) = value.get("error").map_or(("", ""), error_fields);
    param.starts_with("include") || error_text(body).contains(ENCRYPTED_REASONING)
}

/// Collects the events of one streamed round.
#[derive(Default)]
struct Accumulator {
    text: String,
    items: Vec<Value>,
    items_bytes: usize,
    completed: bool,
}

impl Accumulator {
    fn keep(&mut self, item: &Value) -> Result<(), CoachError> {
        let bytes = item.to_string().len();
        if self.items.len() == MAX_OUTPUT_ITEMS || self.items_bytes + bytes > MAX_OUTPUT_BYTES {
            return Err(CoachError::LimitExceeded);
        }
        self.items_bytes += bytes;
        self.items.push(item.clone());
        Ok(())
    }

    /// Takes one event. `Err` carries the code and, for the log, what the provider said.
    fn accept(
        &mut self,
        data: &str,
        on_text: &mut TextSink<'_>,
    ) -> Result<(), (CoachError, Option<String>)> {
        let event: Value =
            serde_json::from_str(data).map_err(|_| (CoachError::ProviderFailure, None))?;
        let said = |error: &Value| {
            let (code, _) = error_fields(error);
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            (
                classify_code(code).unwrap_or(CoachError::ProviderFailure),
                Some(format!("{code}: {message}")),
            )
        };
        match event
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_text.delta" => {
                let text = event
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if self.text.len() + text.len() > MAX_ROUND_TEXT_BYTES {
                    return Err((CoachError::LimitExceeded, None));
                }
                self.text.push_str(text);
                if !text.is_empty() {
                    on_text(text);
                }
            }
            "response.output_item.done" => {
                if let Some(item) = event.get("item") {
                    self.keep(item).map_err(|error| (error, None))?;
                }
            }
            "response.completed" => {
                // A provider that streamed no items lists them here.
                if self.items.is_empty() {
                    let listed = event
                        .pointer("/response/output")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for item in &listed {
                        self.keep(item).map_err(|error| (error, None))?;
                    }
                }
                self.completed = true;
            }
            "response.failed" => {
                return Err(event
                    .pointer("/response/error")
                    .map_or((CoachError::ProviderFailure, None), said));
            }
            "response.incomplete" => {
                let reason = event
                    .pointer("/response/incomplete_details/reason")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                return Err((
                    match reason {
                        "max_output_tokens" => CoachError::AnswerCutOff,
                        "content_filter" => CoachError::ContentFiltered,
                        _ => CoachError::ProviderFailure,
                    },
                    Some(format!("incomplete: {reason}")),
                ));
            }
            // The top-level error event carries its fields itself or under `error`.
            "error" => return Err(said(event.get("error").unwrap_or(&event))),
            // Every other event repeats what the events above already told.
            _ => {}
        }
        Ok(())
    }

    /// The text of the message items, for a provider that sent no text deltas.
    fn listed_text(&self) -> String {
        self.items
            .iter()
            .filter(|item| item["type"] == "message")
            .filter_map(|item| item.get("content").and_then(Value::as_array))
            .flatten()
            .filter(|part| part["type"] == "output_text")
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect()
    }

    /// The round, if the provider said it is complete.
    fn finish(mut self) -> Result<Round, RoundFailure> {
        if !self.completed {
            // A stream that just ends is not a complete answer.
            return Err(RoundFailure {
                error: CoachError::ProviderFailure,
                text: self.text,
            });
        }
        if self.text.is_empty() {
            self.text = self.listed_text();
            if self.text.len() > MAX_ROUND_TEXT_BYTES {
                return Err(RoundFailure::new(CoachError::LimitExceeded));
            }
        }
        let mut tool_calls = Vec::new();
        for item in self
            .items
            .iter()
            .filter(|item| item["type"] == "function_call")
        {
            let field = |name: &str| item.get(name).and_then(Value::as_str).unwrap_or_default();
            let (id, name, arguments) = (field("call_id"), field("name"), field("arguments"));
            let failure = if id.is_empty() || name.is_empty() {
                Some(CoachError::ProviderFailure)
            } else if tool_calls.len() == MAX_STREAMED_TOOL_CALLS
                || arguments.len() > MAX_TOOL_ARGUMENT_BYTES
            {
                Some(CoachError::LimitExceeded)
            } else {
                None
            };
            if let Some(error) = failure {
                return Err(RoundFailure {
                    error,
                    text: self.text,
                });
            }
            tool_calls.push(ToolCall {
                id: id.to_owned(),
                name: name.to_owned(),
                arguments: arguments.to_owned(),
                extra_content: None,
            });
        }
        let mut extra = Map::new();
        extra.insert(OUTPUT.into(), self.items.into());
        Ok(Round {
            text: self.text,
            tool_calls,
            extra,
        })
    }
}

impl<B: BearerSource> Responses<B> {
    /// Sends one request and returns its answer once it is one to read: a request refused as
    /// unauthorized before anything of its answer was read is repeated once with a newer token.
    /// The token the answer belongs to is returned with it, so that nothing the provider says
    /// about the request reaches the log with that token in it.
    async fn send(
        &self,
        body: &Value,
        cancellation: &CancellationToken,
    ) -> Result<(reqwest::Response, String), CoachError> {
        let mut bearer = self.tokens.bearer().await?;
        for retry in [false, true] {
            let request = self
                .client
                .post(&self.url)
                .bearer_auth(&bearer.token)
                .json(body);
            let response = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(CoachError::Cancelled),
                response = request.send() => response.map_err(|_| CoachError::Network)?,
            };
            if response.status().as_u16() == 401 && !retry {
                bearer = self.tokens.rejected(bearer.generation).await?;
                continue;
            }
            return Ok((response, bearer.token));
        }
        Err(CoachError::ProviderFailure)
    }
}

#[async_trait]
impl<B: BearerSource> ModelBackend for Responses<B> {
    async fn round(
        &self,
        request: RoundRequest<'_>,
        on_text: &mut TextSink<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Round, RoundFailure> {
        let mut with_reasoning = true;
        let (response, token) = loop {
            let body = request_body(&request, self.provider, with_reasoning);
            let (response, token) = self
                .send(&body, cancellation)
                .await
                .map_err(RoundFailure::new)?;
            let status = response.status();
            if status.is_success() {
                break (response, token);
            }
            let refusal = tokio::select! {
                biased;
                () = cancellation.cancelled() => return Err(RoundFailure::new(CoachError::Cancelled)),
                body = read_bounded_body(response, MAX_ERROR_BODY_BYTES) => body.unwrap_or_default(),
            };
            // A provider that does not hand out encrypted reasoning is asked once more without.
            if with_reasoning && refuses_reasoning_include(status.as_u16(), &refusal) {
                with_reasoning = false;
                continue;
            }
            let (error, message) = classify_plan_refusal(
                self.provider,
                status.as_u16(),
                &refusal,
                request.effort.is_some(),
                request.has_images(),
            );
            log::warn!(
                "coach: responses refused with HTTP {}: {}",
                status.as_u16(),
                diagnostic(&message, Some(&token))
            );
            return Err(RoundFailure::new(error));
        };
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
                        "coach: responses stream failed: {}",
                        diagnostic(&message, Some(&token))
                    );
                }
                return Err(RoundFailure {
                    error,
                    text: round.text,
                });
            }
            if round.completed {
                break;
            }
        }
        round.finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        coach::{backend::ToolSpec, test_server},
        infra::token_session::Bearer,
    };
    use axum::{
        body::StreamBody,
        http::{header::AUTHORIZATION, header::CONTENT_TYPE, HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
        Json, Router,
    };
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    };

    type Seen = Arc<Mutex<Vec<(Option<String>, Value)>>>;

    /// A token source that counts how often a token was reported as refused.
    #[derive(Default)]
    struct Tokens {
        generation: AtomicU64,
        rejected: Mutex<Vec<u64>>,
        fail_with: Option<CoachError>,
    }

    #[async_trait]
    impl BearerSource for Arc<Tokens> {
        async fn bearer(&self) -> Result<Bearer, CoachError> {
            if let Some(error) = self.fail_with {
                return Err(error);
            }
            let generation = self.generation.load(Ordering::SeqCst);
            Ok(Bearer {
                token: format!("access-{generation}"),
                generation,
            })
        }

        async fn rejected(&self, generation: u64) -> Result<Bearer, CoachError> {
            self.rejected.lock().unwrap().push(generation);
            self.generation.store(generation + 1, Ordering::SeqCst);
            self.bearer().await
        }
    }

    fn sse(chunks: Vec<String>) -> impl IntoResponse {
        let stream =
            futures_util::stream::iter(chunks.into_iter().map(Ok::<_, std::convert::Infallible>));
        (
            [(CONTENT_TYPE, "text/event-stream")],
            StreamBody::new(stream),
        )
    }

    fn event(value: Value) -> String {
        // The event name line is what real streams send; the reader goes by the data's own type.
        format!(
            "event: {}\ndata: {value}\n\n",
            value["type"].as_str().unwrap()
        )
    }

    fn text_delta(text: &str) -> String {
        event(json!({ "type": "response.output_text.delta", "delta": text }))
    }

    fn item_done(item: Value) -> String {
        event(json!({ "type": "response.output_item.done", "item": item }))
    }

    fn completed() -> String {
        event(json!({ "type": "response.completed", "response": { "status": "completed" } }))
    }

    /// What the provider double answers one request with.
    enum Answer {
        Stream(Vec<String>),
        Refusal(StatusCode, Value),
    }

    /// A provider double that answers the requests in order and records what it was sent.
    fn provider(answers: Vec<Answer>) -> (test_server::TestServer, Seen) {
        let seen = Seen::default();
        let record = seen.clone();
        let answers = Arc::new(Mutex::new(answers.into_iter().rev().collect::<Vec<_>>()));
        let router = Router::new().route(
            "/v1/responses",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let (record, answers) = (record.clone(), answers.clone());
                async move {
                    let authorization = headers
                        .get(AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned);
                    record.lock().unwrap().push((authorization, body));
                    match answers.lock().unwrap().pop() {
                        Some(Answer::Stream(chunks)) => sse(chunks).into_response(),
                        Some(Answer::Refusal(status, body)) => (status, Json(body)).into_response(),
                        None => StatusCode::GONE.into_response(),
                    }
                }
            }),
        );
        (test_server::serve(router), seen)
    }

    fn backend(server: &test_server::TestServer, tokens: Arc<Tokens>) -> Responses<Arc<Tokens>> {
        Responses::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            server.url("/v1/responses"),
            tokens,
            PlanProvider::ChatGpt,
        )
    }

    #[tokio::test]
    async fn the_flat_layout_declares_each_tool_on_its_own_and_reads_past_the_end_marker() {
        let (server, seen) = provider(vec![
            Answer::Stream(vec![
                text_delta("Castle."),
                completed(),
                "data: [DONE]\n\n".into(),
            ]),
            // The marker alone does not make an answer complete.
            Answer::Stream(vec![text_delta("Half an"), "data: [DONE]\n\n".into()]),
        ]);
        let flat = Responses::new(
            reqwest::Client::builder().no_proxy().build().unwrap(),
            server.url("/v1/responses"),
            Arc::<Tokens>::default(),
            PlanProvider::Grok,
        );
        let (result, _) = ask(&flat, &question(), None).await;
        assert_eq!(result.unwrap().text, "Castle.");
        let (_, body) = seen.lock().unwrap()[0].clone();
        assert_eq!(
            body["tools"],
            json!([{
                "type": "function",
                "name": "analyse",
                "description": "Run the engine.",
                "parameters": { "type": "object", "properties": { "line": { "type": "string" } } },
            }])
        );
        assert_eq!(body["store"], false);
        assert!(body.get("reasoning").is_none());

        // Whatever a 403 names, on this route it is about the subscription or its credits.
        for body in [
            json!({ "code": "permission_denied", "error": "no access" }),
            json!({ "error": { "code": "forbidden", "message": "no access" } }),
        ] {
            assert_eq!(
                classify_plan_refusal(
                    PlanProvider::Grok,
                    403,
                    body.to_string().as_bytes(),
                    false,
                    false
                )
                .0,
                CoachError::SubscriptionNotEligible
            );
        }

        let (result, _) = ask(&flat, &question(), None).await;
        let Err(failure) = result else {
            panic!("an answer without its completion is no answer");
        };
        assert_eq!(failure.error, CoachError::ProviderFailure);
        assert_eq!(failure.text, "Half an");
    }

    fn tool() -> ToolSpec {
        ToolSpec {
            name: "analyse",
            description: "Run the engine.",
            parameters: json!({ "type": "object", "properties": { "line": { "type": "string" } } }),
        }
    }

    async fn ask(
        backend: &Responses<Arc<Tokens>>,
        messages: &[Message],
        effort: Option<&str>,
    ) -> (Result<Round, RoundFailure>, String) {
        let tools = [tool()];
        let mut streamed = String::new();
        let result = backend
            .round(
                RoundRequest {
                    model: "gpt-test",
                    effort,
                    system: "You are the Coach.",
                    messages,
                    tools: &tools,
                },
                &mut |delta| streamed.push_str(delta),
                &CancellationToken::new(),
            )
            .await;
        (result, streamed)
    }

    fn question() -> Vec<Message> {
        vec![Message::User("What is the plan?".into())]
    }

    #[tokio::test]
    async fn a_request_is_stateless_streamed_and_declares_its_tools_in_one_namespace() {
        let (server, seen) = provider(vec![Answer::Stream(vec![
            text_delta("Develop "),
            text_delta("first."),
            completed(),
        ])]);
        let (result, streamed) =
            ask(&backend(&server, Arc::default()), &question(), Some("high")).await;
        let round = result.unwrap();
        assert_eq!(round.text, "Develop first.");
        assert_eq!(streamed, "Develop first.");
        assert!(round.tool_calls.is_empty());

        let (authorization, body) = seen.lock().unwrap()[0].clone();
        assert_eq!(authorization.as_deref(), Some("Bearer access-0"));
        assert_eq!(body["model"], "gpt-test");
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "You are the Coach.");
        assert_eq!(
            body["input"],
            json!([{ "role": "user", "content": "What is the plan?" }])
        );
        assert_eq!(body["reasoning"], json!({ "effort": "high" }));
        assert_eq!(body["include"], json!(["reasoning.encrypted_content"]));
        assert_eq!(
            body["tools"],
            json!([{
                "type": "namespace",
                "name": "chess",
                "description": "Read-only chess tools: the engine and the reference database.",
                "tools": [{
                    "type": "function",
                    "name": "analyse",
                    "description": "Run the engine.",
                    "parameters": { "type": "object", "properties": { "line": { "type": "string" } } },
                    "strict": false,
                }],
            }])
        );
        // Fields the plan route refuses are never sent.
        for absent in [
            "previous_response_id",
            "temperature",
            "max_output_tokens",
            "tool_choice",
            "metadata",
            "user",
        ] {
            assert!(body.get(absent).is_none(), "{absent}");
        }
    }

    #[tokio::test]
    async fn without_an_effort_no_reasoning_field_is_sent() {
        let (server, seen) = provider(vec![Answer::Stream(vec![text_delta("Ok."), completed()])]);
        ask(&backend(&server, Arc::default()), &question(), None)
            .await
            .0
            .unwrap();
        assert!(seen.lock().unwrap()[0].1.get("reasoning").is_none());
    }

    #[tokio::test]
    async fn tool_calls_come_from_the_finished_items_and_go_back_with_their_reasoning() {
        let reasoning = json!({
            "type": "reasoning", "id": "rs_1", "summary": [], "encrypted_content": "sealed",
        });
        let call = json!({
            "type": "function_call", "id": "fc_1", "call_id": "call_1", "status": "completed",
            "name": "analyse", "namespace": "chess", "arguments": "{\"line\":\"Nf3\"}",
        });
        let (server, seen) = provider(vec![
            Answer::Stream(vec![
                event(json!({ "type": "response.created", "response": {} })),
                item_done(reasoning.clone()),
                event(json!({
                    "type": "response.function_call_arguments.delta", "delta": "{\"li",
                })),
                item_done(call.clone()),
                completed(),
            ]),
            Answer::Stream(vec![text_delta("Play [[Nf3]]."), completed()]),
        ]);
        let backend = backend(&server, Arc::default());
        let (first, _) = ask(&backend, &question(), None).await;
        let first = first.unwrap();
        assert_eq!(
            first.tool_calls,
            [ToolCall {
                id: "call_1".into(),
                name: "analyse".into(),
                arguments: "{\"line\":\"Nf3\"}".into(),
                extra_content: None,
            }]
        );

        let mut messages = question();
        messages.push(first.into_message());
        messages.push(Message::ToolResult {
            call_id: "call_1".into(),
            content: "{\"evaluation\":\"+0.30\"}".into(),
        });
        let (second, _) = ask(&backend, &messages, None).await;
        assert_eq!(second.unwrap().text, "Play [[Nf3]].");

        // The second request holds the first round's items as they were (without their status)
        // and then the result of the call.
        let mut sent_call = call;
        sent_call.as_object_mut().unwrap().remove("status");
        assert_eq!(
            seen.lock().unwrap()[1].1["input"],
            json!([
                { "role": "user", "content": "What is the plan?" },
                reasoning,
                sent_call,
                { "type": "function_call_output", "call_id": "call_1",
                  "output": "{\"evaluation\":\"+0.30\"}" },
            ])
        );
    }

    #[tokio::test]
    async fn reasoning_that_cannot_be_sent_back_is_left_out_and_the_calls_lose_their_ids() {
        let items = [
            json!({ "type": "reasoning", "id": "rs_1", "summary": [] }),
            json!({ "type": "function_call", "id": "fc_1", "call_id": "call_1",
                    "name": "analyse", "arguments": "{}" }),
        ];
        assert_eq!(
            resendable(&items),
            [json!({ "type": "function_call", "call_id": "call_1",
                     "name": "analyse", "arguments": "{}" })]
        );
    }

    #[tokio::test]
    async fn a_provider_that_refuses_encrypted_reasoning_is_asked_once_more_without_it() {
        let (server, seen) = provider(vec![
            Answer::Refusal(
                StatusCode::BAD_REQUEST,
                json!({ "error": { "code": "subscription_sharing_unsupported_capability",
                                   "param": "include", "message": "Unsupported." } }),
            ),
            Answer::Stream(vec![text_delta("Ok."), completed()]),
        ]);
        let (result, _) = ask(&backend(&server, Arc::default()), &question(), None).await;
        assert_eq!(result.unwrap().text, "Ok.");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].1.get("include").is_some());
        assert!(seen[1].1.get("include").is_none());
    }

    #[tokio::test]
    async fn history_from_earlier_turns_is_sent_as_plain_text() {
        let (server, seen) = provider(vec![Answer::Stream(vec![text_delta("Ok."), completed()])]);
        let messages = vec![
            Message::User("Earlier question".into()),
            Message::Assistant {
                text: "Earlier answer".into(),
                tool_calls: Vec::new(),
                extra: Map::new(),
            },
            Message::User("And now?".into()),
        ];
        ask(&backend(&server, Arc::default()), &messages, None)
            .await
            .0
            .unwrap();
        assert_eq!(
            seen.lock().unwrap()[0].1["input"],
            json!([
                { "role": "user", "content": "Earlier question" },
                { "role": "assistant", "content": "Earlier answer" },
                { "role": "user", "content": "And now?" },
            ])
        );
    }

    #[tokio::test]
    async fn a_refused_token_is_reported_and_the_request_repeated_once_with_a_newer_one() {
        let unauthorized = || Answer::Refusal(StatusCode::UNAUTHORIZED, json!({ "detail": "no" }));
        let (server, seen) = provider(vec![
            unauthorized(),
            Answer::Stream(vec![text_delta("Ok."), completed()]),
        ]);
        let tokens = Arc::new(Tokens::default());
        let (result, _) = ask(&backend(&server, tokens.clone()), &question(), None).await;
        assert_eq!(result.unwrap().text, "Ok.");
        assert_eq!(tokens.rejected.lock().unwrap().as_slice(), [0]);
        let sent: Vec<Option<String>> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|(authorization, _)| authorization.clone())
            .collect();
        assert_eq!(
            sent,
            [
                Some("Bearer access-0".into()),
                Some("Bearer access-1".into())
            ]
        );

        // A second refusal is final: no third request, and no "sign in again" either.
        let (server, seen) = provider(vec![unauthorized(), unauthorized()]);
        let tokens = Arc::new(Tokens::default());
        let (result, _) = ask(&backend(&server, tokens.clone()), &question(), None).await;
        assert_eq!(
            result.unwrap_err(),
            RoundFailure::new(CoachError::ProviderFailure)
        );
        assert_eq!(seen.lock().unwrap().len(), 2);
        assert_eq!(tokens.rejected.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_connection_without_a_token_never_reaches_the_provider() {
        let (server, seen) = provider(Vec::new());
        let tokens = Arc::new(Tokens {
            fail_with: Some(CoachError::SignInAgain),
            ..Default::default()
        });
        let (result, _) = ask(&backend(&server, tokens), &question(), None).await;
        assert_eq!(
            result.unwrap_err(),
            RoundFailure::new(CoachError::SignInAgain)
        );
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_grok_account_without_credits_is_told_apart_from_an_ineligible_one() {
        let refusal = |message: &str| {
            let body = json!({ "error": message }).to_string();
            classify_plan_refusal(PlanProvider::Grok, 403, body.as_bytes(), false, false).0
        };
        assert_eq!(
            refusal("You have run out of credits or need a Grok subscription. Add credits at https://grok.com/?_s=usage or upgrade at https://grok.com/supergrok."),
            CoachError::CreditsExhausted
        );
        assert_eq!(refusal("forbidden"), CoachError::SubscriptionNotEligible);
        // Only Grok says it in words; another provider's 403 keeps its meaning.
        let body = json!({ "error": "You have run out of credits" }).to_string();
        assert_eq!(
            classify_plan_refusal(PlanProvider::ChatGpt, 403, body.as_bytes(), false, false).0,
            CoachError::SubscriptionNotEligible
        );
    }

    #[tokio::test]
    async fn refusals_are_told_apart_by_their_code_status_and_named_field() {
        let coded = |code: &str, param: &str| json!({ "error": { "code": code, "param": param, "message": "refused" } });
        for (status, body, effort, expected) in [
            (
                StatusCode::TOO_MANY_REQUESTS,
                coded("subscription_sharing_usage_limit_exceeded", ""),
                None,
                CoachError::UsageLimitReached,
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                coded("", ""),
                None,
                CoachError::RateLimited,
            ),
            (
                StatusCode::FORBIDDEN,
                coded("subscription_sharing_user_not_eligible", ""),
                None,
                CoachError::SubscriptionNotEligible,
            ),
            (
                StatusCode::FORBIDDEN,
                json!({ "detail": "region" }),
                None,
                CoachError::SubscriptionNotEligible,
            ),
            (
                StatusCode::FORBIDDEN,
                coded("subscription_sharing_route_not_supported", ""),
                None,
                CoachError::ProviderFailure,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                coded("subscription_sharing_usage_unavailable", ""),
                None,
                CoachError::RateLimited,
            ),
            (
                StatusCode::BAD_REQUEST,
                coded(
                    "subscription_sharing_unsupported_capability",
                    "reasoning.effort",
                ),
                Some("high"),
                CoachError::EffortRejected,
            ),
            (
                StatusCode::BAD_REQUEST,
                coded("subscription_sharing_unsupported_capability", "tools"),
                None,
                CoachError::NoFunctionCalling,
            ),
            (
                StatusCode::BAD_REQUEST,
                json!({ "error": { "message": "The model gpt-test does not exist." } }),
                None,
                CoachError::ModelUnavailable,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Value::Null,
                None,
                CoachError::ProviderFailure,
            ),
        ] {
            let (server, _) = provider(vec![Answer::Refusal(status, body.clone())]);
            let (result, _) = ask(&backend(&server, Arc::default()), &question(), effort).await;
            assert_eq!(
                result.unwrap_err(),
                RoundFailure::new(expected),
                "{status} {body}"
            );
        }
    }

    #[tokio::test]
    async fn a_round_is_complete_only_when_the_provider_says_so() {
        let failed = |code: &str| {
            event(json!({
                "type": "response.failed",
                "response": { "error": { "code": code, "message": "failed" } },
            }))
        };
        let incomplete = |reason: &str| {
            event(json!({
                "type": "response.incomplete",
                "response": { "incomplete_details": { "reason": reason } },
            }))
        };
        for (chunks, expected) in [
            // The stream just ends.
            (vec![text_delta("Half")], CoachError::ProviderFailure),
            (
                vec![text_delta("Half"), failed("server_error")],
                CoachError::ProviderFailure,
            ),
            // The plan's limit can be hit while an answer is being written.
            (
                vec![
                    text_delta("Half"),
                    failed("subscription_sharing_usage_limit_exceeded"),
                ],
                CoachError::UsageLimitReached,
            ),
            (
                vec![text_delta("Half"), incomplete("max_output_tokens")],
                CoachError::AnswerCutOff,
            ),
            (
                vec![text_delta("Half"), incomplete("content_filter")],
                CoachError::ContentFiltered,
            ),
            (
                vec![
                    text_delta("Half"),
                    event(json!({ "type": "error", "code": "server_error", "message": "x" })),
                ],
                CoachError::ProviderFailure,
            ),
            (
                vec![text_delta("Half"), "data: not json\n\n".to_owned()],
                CoachError::ProviderFailure,
            ),
        ] {
            let (server, _) = provider(vec![Answer::Stream(chunks)]);
            let (result, streamed) =
                ask(&backend(&server, Arc::default()), &question(), None).await;
            assert_eq!(
                result.unwrap_err(),
                RoundFailure {
                    error: expected,
                    text: "Half".into()
                }
            );
            assert_eq!(streamed, "Half");
        }
    }

    #[tokio::test]
    async fn a_provider_that_only_lists_its_output_at_the_end_is_read_from_there() {
        let (server, _) = provider(vec![Answer::Stream(vec![event(json!({
            "type": "response.completed",
            "response": { "output": [
                { "type": "message", "role": "assistant",
                  "content": [{ "type": "output_text", "text": "Listed." }] },
                { "type": "function_call", "call_id": "call_9", "name": "analyse",
                  "arguments": "{}" },
            ] },
        }))])]);
        let (result, streamed) = ask(&backend(&server, Arc::default()), &question(), None).await;
        let round = result.unwrap();
        assert_eq!(round.text, "Listed.");
        assert_eq!(streamed, "", "nothing was streamed");
        assert_eq!(round.tool_calls[0].id, "call_9");
    }

    #[tokio::test]
    async fn the_bounds_of_a_round_hold_for_text_calls_and_arguments() {
        let call = |index: usize, arguments: String| {
            item_done(json!({
                "type": "function_call", "call_id": format!("call_{index}"),
                "name": "analyse", "arguments": arguments,
            }))
        };
        let mut too_many: Vec<String> = (0..=MAX_STREAMED_TOOL_CALLS)
            .map(|index| call(index, "{}".into()))
            .collect();
        too_many.push(completed());
        for chunks in [
            vec![text_delta(&"x".repeat(MAX_ROUND_TEXT_BYTES + 1))],
            vec![
                call(0, "x".repeat(MAX_TOOL_ARGUMENT_BYTES + 1)),
                completed(),
            ],
            too_many,
        ] {
            let (server, _) = provider(vec![Answer::Stream(chunks)]);
            let (result, _) = ask(&backend(&server, Arc::default()), &question(), None).await;
            assert_eq!(result.unwrap_err().error, CoachError::LimitExceeded);
        }
        // A call without a name or an id is not a call.
        let (server, _) = provider(vec![Answer::Stream(vec![
            item_done(json!({ "type": "function_call", "call_id": "call_1", "arguments": "{}" })),
            completed(),
        ])]);
        let (result, _) = ask(&backend(&server, Arc::default()), &question(), None).await;
        assert_eq!(result.unwrap_err().error, CoachError::ProviderFailure);
    }

    #[tokio::test]
    async fn cancellation_ends_a_round_at_once() {
        let (server, _) = provider(vec![Answer::Stream(vec![text_delta("Thinking")])]);
        let backend = backend(&server, Arc::default());
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let tools = [tool()];
        let result = backend
            .round(
                RoundRequest {
                    model: "gpt-test",
                    effort: None,
                    system: "",
                    messages: &question(),
                    tools: &tools,
                },
                &mut |_| {},
                &cancellation,
            )
            .await;
        assert_eq!(
            result.unwrap_err(),
            RoundFailure::new(CoachError::Cancelled)
        );
    }

    #[tokio::test]
    async fn user_message_with_images_serialises_input_array_without_detail_and_classifies_image_refusal(
    ) {
        let img1 = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
        let img2 = "data:image/jpeg;base64,/9j/4BBQSg==";
        let messages = vec![Message::UserWithImages {
            text: "Transcribe this sheet.".into(),
            images: vec![img1.into(), img2.into()],
        }];
        let (server, seen) = provider(vec![Answer::Stream(vec![text_delta("{}"), completed()])]);
        ask(&backend(&server, Arc::default()), &messages, None)
            .await
            .0
            .unwrap();
        let sent = seen.lock().unwrap()[0].1["input"][0].clone();
        assert_eq!(
            sent,
            json!({
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "Transcribe this sheet." },
                    { "type": "input_image", "image_url": img1 },
                    { "type": "input_image", "image_url": img2 },
                ],
            })
        );
        assert!(sent["content"][1].get("detail").is_none());

        // Refusal naming modalities/vision/images classifies as ImagesUnsupported only when images were sent.
        let refusal =
            json!({ "error": { "message": "Selected model does not support vision modalities." } });
        let (server, _) = provider(vec![
            Answer::Refusal(StatusCode::UNPROCESSABLE_ENTITY, refusal.clone()),
            Answer::Refusal(StatusCode::UNPROCESSABLE_ENTITY, refusal),
        ]);
        let b = backend(&server, Arc::default());
        assert_eq!(
            ask(&b, &messages, None).await.0.unwrap_err(),
            RoundFailure::new(CoachError::ImagesUnsupported)
        );
        assert_eq!(
            ask(&b, &question(), None).await.0.unwrap_err(),
            RoundFailure::new(CoachError::ProviderFailure)
        );
    }
}
