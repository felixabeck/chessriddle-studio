//! The model list of a connection, reduced to what the selector needs.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::error::CoachError;

pub(crate) const MAX_MODEL_LIST_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_MODELS: usize = 500;
const MAX_MODEL_ID_CHARS: usize = 200;
const MAX_EFFORT_LEVELS: usize = 8;
const MAX_EFFORT_LEVEL_CHARS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelInfo {
    pub id: String,
    pub name: String,
    /// The effort levels the provider reports for this model; empty when it reports none.
    pub effort_levels: Vec<String>,
    pub default_effort: Option<String>,
    /// Whether the provider says the model accepts function calls; `None` when it does not say.
    pub supports_tools: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelList {
    pub models: Vec<ModelInfo>,
    /// The provider listed more than [`MAX_MODELS`] models and the rest was dropped.
    pub truncated: bool,
}

#[derive(Deserialize)]
struct WireList {
    data: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct WireEffort {
    #[serde(default)]
    supported_levels: Vec<String>,
    #[serde(default)]
    default_level: Option<String>,
}

#[derive(Deserialize)]
struct WireModel {
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    effort: Option<WireEffort>,
    #[serde(default)]
    supported_parameters: Option<Vec<String>>,
}

fn bounded(text: &str, max_chars: usize) -> Option<String> {
    let text = text.trim();
    (!text.is_empty() && text.chars().count() <= max_chars && !text.chars().any(char::is_control))
        .then(|| text.to_owned())
}

fn reduce(model: WireModel) -> Option<ModelInfo> {
    let id = bounded(&model.id, MAX_MODEL_ID_CHARS)?;
    let name = model
        .display_name
        .as_deref()
        .or(model.name.as_deref())
        .and_then(|name| bounded(name, MAX_MODEL_ID_CHARS))
        .unwrap_or_else(|| id.clone());
    let (effort_levels, default_effort) = match model.effort {
        Some(effort) => {
            let levels: Vec<String> = effort
                .supported_levels
                .iter()
                .filter_map(|level| bounded(level, MAX_EFFORT_LEVEL_CHARS))
                .take(MAX_EFFORT_LEVELS)
                .collect();
            let default = effort
                .default_level
                .as_deref()
                .and_then(|level| bounded(level, MAX_EFFORT_LEVEL_CHARS))
                .filter(|level| levels.contains(level));
            (levels, default)
        }
        None => (Vec::new(), None),
    };
    let supports_tools = model
        .supported_parameters
        .map(|parameters| parameters.iter().any(|parameter| parameter == "tools"));
    Some(ModelInfo {
        id,
        name,
        effort_levels,
        default_effort,
        supports_tools,
    })
}

/// Reduces an OpenAI-compatible `GET /models` body. An entry without a usable id is skipped; a
/// body that is not the list shape is a provider failure, never an empty list.
pub(crate) fn parse_model_list(body: &[u8]) -> Result<ModelList, CoachError> {
    let list: WireList = serde_json::from_slice(body).map_err(|_| CoachError::ProviderFailure)?;
    let truncated = list.data.len() > MAX_MODELS;
    let models = list
        .data
        .into_iter()
        .take(MAX_MODELS)
        .filter_map(|entry| serde_json::from_value::<WireModel>(entry).ok())
        .filter_map(reduce)
        .collect();
    Ok(ModelList { models, truncated })
}

/// A model of a signed-in ChatGPT account.
#[derive(Deserialize)]
struct PlanModel {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    visibility: Option<String>,
}

/// Reduces the model list of a ChatGPT sign-in: the models the provider lists for choosing, in
/// its order, by their slug. The provider reports no effort levels there. A body in the common
/// list shape is read as that instead.
pub(crate) fn parse_plan_models(body: &[u8]) -> Result<ModelList, CoachError> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| CoachError::ProviderFailure)?;
    let Some(listed) = value.get("models").and_then(serde_json::Value::as_array) else {
        return parse_model_list(body);
    };
    let mut models: Vec<ModelInfo> = listed
        .iter()
        .filter_map(|entry| serde_json::from_value::<PlanModel>(entry.clone()).ok())
        .filter(|model| {
            model
                .visibility
                .as_deref()
                .is_none_or(|shown| shown == "list")
        })
        .filter_map(|model| {
            let id = bounded(&model.slug, MAX_MODEL_ID_CHARS)?;
            let name = model
                .display_name
                .as_deref()
                .and_then(|name| bounded(name, MAX_MODEL_ID_CHARS))
                .unwrap_or_else(|| id.clone());
            Some(ModelInfo {
                id,
                name,
                effort_levels: Vec::new(),
                default_effort: None,
                supports_tools: None,
            })
        })
        .collect();
    let truncated = models.len() > MAX_MODELS;
    models.truncate(MAX_MODELS);
    Ok(ModelList { models, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_model_list_keeps_the_listed_models_in_the_providers_order() {
        let body = serde_json::json!({
            "models": [
                { "slug": "gpt-big", "display_name": "GPT Big", "visibility": "list" },
                { "slug": "gpt-hidden", "display_name": "Hidden", "visibility": "hide" },
                { "slug": "gpt-small", "visibility": "list" },
                { "slug": "  ", "visibility": "list" },
                { "display_name": "No slug" },
                { "slug": "gpt-plain" },
            ]
        });
        let list = parse_plan_models(body.to_string().as_bytes()).unwrap();
        assert!(!list.truncated);
        let shown: Vec<(&str, &str)> = list
            .models
            .iter()
            .map(|model| (model.id.as_str(), model.name.as_str()))
            .collect();
        assert_eq!(
            shown,
            [
                ("gpt-big", "GPT Big"),
                ("gpt-small", "gpt-small"),
                ("gpt-plain", "gpt-plain")
            ]
        );
        assert!(list
            .models
            .iter()
            .all(|model| model.effort_levels.is_empty()));

        // The common list shape is read as well; anything else is a failure, never an empty list.
        let common = serde_json::json!({ "data": [{ "id": "gpt-x" }] });
        assert_eq!(
            parse_plan_models(common.to_string().as_bytes())
                .unwrap()
                .models[0]
                .id,
            "gpt-x"
        );
        assert_eq!(
            parse_plan_models(b"{\"ok\":true}"),
            Err(CoachError::ProviderFailure)
        );
        assert_eq!(
            parse_plan_models(b"<html>"),
            Err(CoachError::ProviderFailure)
        );

        let many: Vec<_> = (0..MAX_MODELS + 3)
            .map(|index| serde_json::json!({ "slug": format!("m{index}") }))
            .collect();
        let list = parse_plan_models(serde_json::json!({ "models": many }).to_string().as_bytes())
            .unwrap();
        assert_eq!(list.models.len(), MAX_MODELS);
        assert!(list.truncated);
    }

    #[test]
    fn reduces_the_common_list_shapes() {
        let body = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-x", "object": "model", "owned_by": "openai" },
                { "id": "deepseek-flash", "name": "DeepSeek Flash",
                  "effort": { "supported_levels": ["low", "medium", "high"], "default_level": "high" } },
                { "id": "author/model", "name": "Routed", "supported_parameters": ["temperature", "tools"] },
                { "id": "author/plain", "supported_parameters": ["temperature"] },
            ]
        });
        let list = parse_model_list(body.to_string().as_bytes()).unwrap();
        assert!(!list.truncated);
        assert_eq!(
            list.models,
            vec![
                ModelInfo {
                    id: "gpt-x".into(),
                    name: "gpt-x".into(),
                    effort_levels: vec![],
                    default_effort: None,
                    supports_tools: None,
                },
                ModelInfo {
                    id: "deepseek-flash".into(),
                    name: "DeepSeek Flash".into(),
                    effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                    default_effort: Some("high".into()),
                    supports_tools: None,
                },
                ModelInfo {
                    id: "author/model".into(),
                    name: "Routed".into(),
                    effort_levels: vec![],
                    default_effort: None,
                    supports_tools: Some(true),
                },
                ModelInfo {
                    id: "author/plain".into(),
                    name: "author/plain".into(),
                    effort_levels: vec![],
                    default_effort: None,
                    supports_tools: Some(false),
                },
            ]
        );
    }

    #[test]
    fn a_default_effort_outside_the_reported_levels_is_dropped() {
        let body = serde_json::json!({
            "data": [{ "id": "m", "effort": { "supported_levels": ["low"], "default_level": "max" } }]
        });
        let list = parse_model_list(body.to_string().as_bytes()).unwrap();
        assert_eq!(list.models[0].effort_levels, vec!["low".to_owned()]);
        assert_eq!(list.models[0].default_effort, None);
    }

    #[test]
    fn unusable_entries_are_skipped_and_the_rest_is_kept() {
        let long = "x".repeat(MAX_MODEL_ID_CHARS + 1);
        let body = serde_json::json!({
            "data": [
                { "id": "" },
                { "id": long },
                { "id": "bad\u{7}id" },
                { "name": "no id" },
                "not an object",
                { "id": " kept " },
            ]
        });
        let list = parse_model_list(body.to_string().as_bytes()).unwrap();
        assert_eq!(list.models.len(), 1);
        assert_eq!(list.models[0].id, "kept");
    }

    #[test]
    fn more_than_the_cap_is_truncated_and_reported() {
        let data: Vec<_> = (0..MAX_MODELS + 3)
            .map(|index| serde_json::json!({ "id": format!("model-{index}") }))
            .collect();
        let body = serde_json::json!({ "data": data });
        let list = parse_model_list(body.to_string().as_bytes()).unwrap();
        assert!(list.truncated);
        assert_eq!(list.models.len(), MAX_MODELS);
        assert_eq!(
            list.models.last().unwrap().id,
            format!("model-{}", MAX_MODELS - 1)
        );
    }

    #[test]
    fn a_body_that_is_not_a_model_list_is_a_provider_failure() {
        for body in ["", "not json", "[]", r#"{"models":[]}"#, r#"{"data":{}}"#] {
            assert_eq!(
                parse_model_list(body.as_bytes()),
                Err(CoachError::ProviderFailure),
                "{body}"
            );
        }
    }
}
