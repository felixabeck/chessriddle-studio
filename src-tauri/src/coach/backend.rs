//! What every model backend has in common: the conversation it is sent, the tools it may call,
//! and the one round it answers with.

use async_trait::async_trait;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use super::error::CoachError;

/// Text one round may stream before the turn is ended (256 KiB).
pub(crate) const MAX_ROUND_TEXT_BYTES: usize = 256 * 1024;
/// The largest argument document of one tool call (64 KiB).
pub(crate) const MAX_TOOL_ARGUMENT_BYTES: usize = 64 * 1024;
/// Tool calls kept from one round; a provider that streams more has its round ended.
pub(crate) const MAX_STREAMED_TOOL_CALLS: usize = 16;
/// The largest provider document that travels back with one tool call (256 KiB).
pub(crate) const MAX_TOOL_CALL_EXTRA_BYTES: usize = 256 * 1024;

/// A read-only tool as it is described to the model.
pub(crate) struct ToolSpec {
    pub name: &'static str,
    pub description: &'static str,
    /// JSON Schema of the arguments object.
    pub parameters: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ToolCall {
    pub id: String,
    pub name: String,
    /// The arguments as the model wrote them: untrusted text that should be a JSON object.
    pub arguments: String,
    /// What the provider attached to this call and wants back unchanged with it for the rest of
    /// the turn. Gemini puts the signature of its reasoning here and refuses the next round of a
    /// turn without it. It is never read, only returned to the provider it came from.
    pub extra_content: Option<Value>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Message {
    User(String),
    /// A user message that carries text together with one or more validated JPEG data URLs.
    UserWithImages {
        text: String,
        images: Vec<String>,
    },
    Assistant {
        text: String,
        tool_calls: Vec<ToolCall>,
        /// Provider fields that have to be sent back unchanged within the same turn.
        extra: Map<String, Value>,
    },
    ToolResult {
        call_id: String,
        content: String,
    },
}

pub(crate) struct RoundRequest<'a> {
    pub model: &'a str,
    /// `None` sends no effort: the provider's default applies.
    pub effort: Option<&'a str>,
    pub system: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
}

impl RoundRequest<'_> {
    pub(crate) fn has_images(&self) -> bool {
        self.messages
            .iter()
            .any(|message| matches!(message, Message::UserWithImages { images, .. } if !images.is_empty()))
    }
}

/// One completed model round: its text, and the tool calls it asks for (none ends the loop).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Round {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub extra: Map<String, Value>,
}

impl Round {
    pub(crate) fn into_message(self) -> Message {
        Message::Assistant {
            text: self.text,
            tool_calls: self.tool_calls,
            extra: self.extra,
        }
    }
}

/// A failed round together with the text it had streamed until then.
#[derive(Debug, PartialEq)]
pub(crate) struct RoundFailure {
    pub error: CoachError,
    pub text: String,
}

impl RoundFailure {
    pub(crate) fn new(error: CoachError) -> Self {
        Self {
            error,
            text: String::new(),
        }
    }
}

/// Receives the answer text of a round as it arrives.
pub(crate) type TextSink<'a> = dyn for<'text> FnMut(&'text str) + Send + 'a;

#[async_trait]
pub(crate) trait ModelBackend: Send + Sync {
    /// Runs one round. `on_text` receives the answer text as it arrives; a round only counts as
    /// complete when the provider said so, and cancellation ends it at once.
    async fn round(
        &self,
        request: RoundRequest<'_>,
        on_text: &mut TextSink<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Round, RoundFailure>;
}
