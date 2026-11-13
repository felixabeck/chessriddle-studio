use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;

use super::GAME_ENGINE_KEY_PREFIX;
use crate::{
    error::Error,
    infra::path_authority::{EngineResourceHandle, EngineResourceHandleKind},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "kebab-case")]
pub enum EngineFailureKind {
    Disconnected,
    ProcessExit,
    ProtocolFailure,
}

/// Observed process status. Signals stay absent on platforms without Unix exit signals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineExitStatus {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum EngineTerminalEntry {
    InfoString(String),
    Stderr(String),
    Truncated,
}

/// Engine text is sanitized and bounded natively before entering this payload.
/// An absent reason asks the renderer to localize the failure kind/status.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineTerminalSnapshot {
    pub kind: EngineFailureKind,
    pub exit_status: Option<EngineExitStatus>,
    pub reason: Option<String>,
    pub entries: Vec<EngineTerminalEntry>,
}

/// A stable, exact identity for one interactive engine process.  In
/// particular, `tab == "a"` and `tab == "ab"` are different identities;
/// callers must never implement cleanup with prefix matching.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EngineKey {
    pub tab: String,
    pub engine: String,
}

impl EngineKey {
    pub fn new(tab: String, engine: String) -> Result<Self, Error> {
        if tab.starts_with(GAME_ENGINE_KEY_PREFIX) {
            return Err(Error::InvalidInput(format!(
                "tab prefix {GAME_ENGINE_KEY_PREFIX:?} is reserved for native game engines"
            )));
        }
        Self::validated(tab, engine)
    }

    pub(crate) fn game(
        game_id: &str,
        session: u64,
        side: &str,
        engine: &str,
    ) -> Result<Self, Error> {
        validate_uci_text("game id", game_id)?;
        validate_uci_text("side", side)?;
        Self::validated(
            format!("{GAME_ENGINE_KEY_PREFIX}{game_id}:{session}:{side}"),
            engine.into(),
        )
    }

    fn validated(tab: String, engine: String) -> Result<Self, Error> {
        validate_uci_text("tab", &tab)?;
        validate_uci_text("engine", &engine)?;
        Ok(Self { tab, engine })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineRequestId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineState {
    Idle,
    Searching { request_id: EngineRequestId },
    Stopping { request_id: EngineRequestId },
    Terminating,
}

/// All protocol waits are bounded. `stop` is a wall-clock budget for the
/// complete stop exchange, including its command write. `uciok` and `readyok`
/// bound their post-write drains; command writes retain `send`'s `readyok`
/// bound. `collect_engine_configuration` also applies a caller-side wall-clock
/// bound to its full `uciok` drain. `search` is a per-line stall bound. These
/// values are supplied so tests and game sessions can use shorter limits
/// without global mutable configuration.
#[derive(Debug, Clone)]
pub struct EngineDeadlines {
    pub spawn: Duration,
    pub uciok: Duration,
    pub readyok: Duration,
    pub search: Duration,
    pub stop: Duration,
    pub quit: Duration,
    /// Final bounded wait after force-kill. If reaping cannot be confirmed,
    /// the cleanup owner retains the original child handle and executable/resource
    /// leases for a later bounded attempt. Timeout does not confirm OS exit.
    pub kill_reap: Duration,
    pub resource_verify: Duration,
}

impl Default for EngineDeadlines {
    fn default() -> Self {
        Self {
            spawn: Duration::from_secs(10),
            uciok: Duration::from_secs(10),
            readyok: Duration::from_secs(10),
            search: Duration::from_secs(10 * 60),
            stop: Duration::from_secs(5),
            quit: Duration::from_secs(3),
            kill_reap: Duration::from_secs(2),
            resource_verify: Duration::from_secs(2),
        }
    }
}

pub const MAX_ENGINE_LIMIT: u32 = 24 * 60 * 60 * 1000;

pub fn validate_uci_text(field: &str, value: &str) -> Result<(), Error> {
    if value.is_empty() {
        return Err(Error::InvalidInput(format!("{field} must not be empty")));
    }
    if value.chars().any(|character| character.is_control()) {
        return Err(Error::InvalidInput(format!(
            "{field} contains a UCI control character"
        )));
    }
    Ok(())
}

/// Renderer-persisted option input. Native resources are opaque capabilities,
/// never UCI path strings.
#[derive(Deserialize, Serialize, Debug, Clone, Type, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EngineOption {
    String {
        name: String,
        value: String,
    },
    Resource {
        name: String,
        resources: Vec<EngineResourceHandle>,
    },
}
const MAX_ENGINE_OPTION_RESOURCES: usize = 32;

fn expected_resource_kind(name: &str) -> Option<EngineResourceHandleKind> {
    let name = name.to_ascii_lowercase();
    if name.contains("path") {
        Some(EngineResourceHandleKind::Directory)
    } else if name.contains("file") {
        Some(EngineResourceHandleKind::File)
    } else {
        None
    }
}

/// Reject path-shaped UCI strings globally, not only for names engines happen
/// to advertise as file options. A path is authority, so it must arrive as a
/// capability even for proprietary names such as `Book` or `TbDir`.
fn is_filesystem_path(value: &str) -> bool {
    let value = value.trim();
    value.starts_with('/')
        || value.starts_with("\\\\")
        || value.starts_with("./")
        || value.starts_with("../")
        || value.starts_with(".\\")
        || value.starts_with("..\\")
        || value.starts_with("~/")
        || value.starts_with("~\\")
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'/' | b'\\'))
}

pub(crate) fn validate_engine_option(option: &EngineOption) -> Result<(), Error> {
    match option {
        EngineOption::String { name, value } => {
            validate_uci_text("option name", name)?;
            validate_uci_text("option value", value)?;
            if is_filesystem_path(value) || expected_resource_kind(name).is_some() {
                return Err(Error::InvalidInput(format!(
                    "{name} must use an opaque engine resource"
                )));
            }
        }
        EngineOption::Resource { name, resources } => {
            validate_uci_text("option name", name)?;
            let expected = expected_resource_kind(name).ok_or_else(|| {
                Error::InvalidInput(format!("{name} is not a file or directory option"))
            })?;
            if resources.is_empty() || resources.len() > MAX_ENGINE_OPTION_RESOURCES {
                return Err(Error::ResourceLimit(format!(
                    "engine resource option requires 1 to {MAX_ENGINE_OPTION_RESOURCES} resources"
                )));
            }
            if resources.iter().any(|resource| resource.kind != expected) {
                return Err(Error::InvalidInput(format!(
                    "{name} received the wrong engine resource kind"
                )));
            }
        }
    }
    Ok(())
}
impl EngineOption {
    /// Display labels and materialized descriptor/path values are not resource identity.
    pub(crate) fn has_same_value(&self, other: &Self) -> bool {
        match (self, other) {
            (
                Self::Resource { name, resources },
                Self::Resource {
                    name: other_name,
                    resources: other_resources,
                },
            ) => {
                name == other_name
                    && resources.len() == other_resources.len()
                    && resources
                        .iter()
                        .zip(other_resources)
                        .all(|(left, right)| left.id == right.id && left.kind == right.kind)
            }
            _ => self == other,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::String { name, .. } | Self::Resource { name, .. } => name,
        }
    }
}

pub(crate) fn effective_engine_options(options: &[EngineOption]) -> Vec<EngineOption> {
    let mut effective: Vec<EngineOption> = Vec::new();
    for option in options {
        if let Some(previous) = effective
            .iter_mut()
            .find(|previous| previous.name() == option.name())
        {
            *previous = option.clone();
        } else {
            effective.push(option.clone());
        }
    }
    effective
}

pub(crate) fn resolve_engine_option_leases(
    authority: &mut crate::infra::path_authority::PathAuthority,
    options: &[EngineOption],
) -> Result<Vec<ResolvedEngineOption>, Error> {
    effective_engine_options(options)
        .iter()
        .map(|option| match option {
            EngineOption::String { name, value } => {
                validate_engine_option(option)?;
                Ok(ResolvedEngineOption {
                    name: name.clone(),
                    value: value.clone(),
                    resources: Vec::new(),
                    resource_values: Vec::new(),
                })
            }
            EngineOption::Resource { name, resources } => {
                validate_engine_option(option)?;
                let leases = resources
                    .iter()
                    .map(|resource| authority.engine_resource(resource).map(std::sync::Arc::new))
                    .collect::<Result<Vec<_>, _>>()?;
                // Keep the leases until the launch layer has pinned any file
                // resources and can construct their values from those pins.
                Ok(ResolvedEngineOption {
                    name: name.clone(),
                    value: String::new(),
                    resources: leases,
                    resource_values: Vec::new(),
                })
            }
        })
        .collect()
}

/// Internal UCI option. This never crosses IPC or renderer persistence.
#[derive(Debug, Clone)]
pub(crate) struct ResolvedEngineOption {
    pub(crate) name: String,
    pub(crate) value: String,
    pub(crate) resources: Vec<std::sync::Arc<crate::infra::path_authority::EngineResourceLease>>,
    /// The individual native values that make up `value`. These are retained
    /// as provenance for transcript redaction even after leases move to the
    /// child executable.
    pub(crate) resource_values: Vec<String>,
}

impl ResolvedEngineOption {
    pub(crate) fn refresh_resource_values(&mut self) -> Result<(), Error> {
        if self.resources.is_empty() {
            return Ok(());
        }
        let values = self
            .resources
            .iter()
            .map(|resource| resource.uci_value())
            .collect::<Result<Vec<_>, _>>()?;
        self.resource_values = values;
        let separator = if cfg!(windows) { ";" } else { ":" };
        self.value = self.resource_values.join(separator);
        Ok(())
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Type, PartialEq, Eq)]
#[serde(tag = "t", content = "c")]
pub enum GoMode {
    PlayersTime(PlayersTime),
    Depth(u32),
    Time(u32),
    Nodes(u32),
    Infinite,
}

impl GoMode {
    pub fn validate(&self) -> Result<(), Error> {
        let validate_limit = |name: &str, value: u32| {
            if value == 0 || value > MAX_ENGINE_LIMIT {
                Err(Error::InvalidInput(format!(
                    "{name} must be between 1 and {MAX_ENGINE_LIMIT}"
                )))
            } else {
                Ok(())
            }
        };

        match self {
            Self::Depth(value) => validate_limit("depth", *value),
            Self::Time(value) => validate_limit("time", *value),
            Self::Nodes(value) => {
                if *value == 0 {
                    Err(Error::InvalidInput("nodes must be at least 1".into()))
                } else {
                    Ok(())
                }
            }
            Self::PlayersTime(time) => time.validate(),
            Self::Infinite => Ok(()),
        }
    }

    pub fn to_uci_string(&self) -> Result<String, Error> {
        self.validate()?;
        Ok(match self {
            Self::Depth(d) => format!("go depth {d}"),
            Self::Time(t) => format!("go movetime {t}"),
            Self::Nodes(n) => format!("go nodes {n}"),
            Self::PlayersTime(pt) => {
                format!(
                    "go wtime {} btime {} winc {} binc {}",
                    pt.white, pt.black, pt.winc, pt.binc
                )
            }
            Self::Infinite => "go infinite".to_string(),
        })
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Type, PartialEq, Eq)]
pub struct PlayersTime {
    pub white: u32,
    pub black: u32,
    pub winc: u32,
    pub binc: u32,
}

impl PlayersTime {
    pub fn new(white: u32, black: u32, winc: u32, binc: u32) -> Self {
        Self {
            white,
            black,
            winc,
            binc,
        }
    }

    pub fn validate(&self) -> Result<(), Error> {
        for (name, value) in [
            ("white clock", self.white),
            ("black clock", self.black),
            ("white increment", self.winc),
            ("black increment", self.binc),
        ] {
            if value > MAX_ENGINE_LIMIT {
                return Err(Error::InvalidInput(format!(
                    "{name} must not exceed {MAX_ENGINE_LIMIT}"
                )));
            }
        }
        if self.white == 0 && self.black == 0 {
            return Err(Error::InvalidInput(
                "at least one player clock must be non-zero".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_key_rejects_reserved_game_prefix() {
        assert!(matches!(
            EngineKey::new("game:analysis".into(), "engine".into()),
            Err(Error::InvalidInput(message))
                if message.contains("reserved") && message.contains(GAME_ENGINE_KEY_PREFIX)
        ));
    }

    #[test]
    fn game_key_validates_native_identity_text() {
        for (game_id, side, engine) in [
            ("", "white", "engine"),
            ("game\nquit", "white", "engine"),
            ("game", "", "engine"),
            ("game", "white\nquit", "engine"),
            ("game", "white", ""),
            ("game", "white", "engine\nquit"),
        ] {
            assert!(matches!(
                EngineKey::game(game_id, 42, side, engine),
                Err(Error::InvalidInput(_))
            ));
        }
    }

    #[test]
    fn rejects_protocol_injection_and_invalid_limits() {
        assert!(validate_uci_text("option", "Threads\nquit").is_err());
        assert!(GoMode::Depth(0).to_uci_string().is_err());
        assert!(GoMode::Time(MAX_ENGINE_LIMIT + 1).to_uci_string().is_err());
        assert!(GoMode::PlayersTime(PlayersTime::new(0, 0, 0, 0))
            .to_uci_string()
            .is_err());
    }

    #[test]
    fn nodes_accept_the_full_u32_range() {
        assert_eq!(
            GoMode::Nodes(100_000_000).to_uci_string().unwrap(),
            "go nodes 100000000"
        );
        assert_eq!(
            GoMode::Nodes(u32::MAX).to_uci_string().unwrap(),
            format!("go nodes {}", u32::MAX)
        );
        assert!(GoMode::Nodes(0).to_uci_string().is_err());
        assert!(GoMode::Time(MAX_ENGINE_LIMIT + 1).to_uci_string().is_err());
    }

    #[test]
    fn path_and_file_options_require_bounded_matching_capabilities() {
        let resource = |kind| EngineResourceHandle {
            id: crate::infra::path_authority::PathRef {
                id: "test-resource".into(),
            },
            kind,
            display_name: "resource".into(),
        };
        assert!(validate_engine_option(&EngineOption::String {
            name: "SyzygyPath".into(),
            value: "/raw/path".into(),
        })
        .is_err());
        assert!(validate_engine_option(&EngineOption::Resource {
            name: "SyzygyPath".into(),
            resources: vec![resource(EngineResourceHandleKind::File)],
        })
        .is_err());
        assert!(validate_engine_option(&EngineOption::Resource {
            name: "EvalFile".into(),
            resources: vec![resource(EngineResourceHandleKind::File)],
        })
        .is_ok());
    }

    #[test]
    fn resource_option_names_are_classified_case_insensitively() {
        assert_eq!(
            expected_resource_kind("SyZyGyPaTh"),
            Some(EngineResourceHandleKind::Directory)
        );
        assert_eq!(
            expected_resource_kind("NNUEFile"),
            Some(EngineResourceHandleKind::File)
        );
        assert_eq!(expected_resource_kind("Threads"), None);
    }

    #[test]
    fn legacy_resource_strings_are_rejected_even_when_empty() {
        assert!(validate_engine_option(&EngineOption::String {
            name: "SyzygyPath".into(),
            value: String::new(),
        })
        .is_err());
        assert!(validate_engine_option(&EngineOption::String {
            name: "EvalFile".into(),
            value: "relative.nnue".into(),
        })
        .is_err());
    }

    #[test]
    fn resource_option_rejects_unknown_names_and_empty_resource_sets() {
        let directory = EngineResourceHandle {
            id: crate::infra::path_authority::PathRef {
                id: "directory".into(),
            },
            kind: EngineResourceHandleKind::Directory,
            display_name: "tablebases".into(),
        };
        assert!(validate_engine_option(&EngineOption::Resource {
            name: "Threads".into(),
            resources: vec![directory.clone()],
        })
        .is_err());
        assert!(validate_engine_option(&EngineOption::Resource {
            name: "SyzygyPath".into(),
            resources: Vec::new(),
        })
        .is_err());
    }

    #[test]
    fn resource_option_enforces_the_capability_count_limit() {
        let resource = EngineResourceHandle {
            id: crate::infra::path_authority::PathRef {
                id: "directory".into(),
            },
            kind: EngineResourceHandleKind::Directory,
            display_name: "tablebases".into(),
        };
        assert!(validate_engine_option(&EngineOption::Resource {
            name: "SyzygyPath".into(),
            resources: vec![resource; MAX_ENGINE_OPTION_RESOURCES + 1],
        })
        .is_err());
    }

    #[test]
    fn resolves_resource_options_with_individual_native_values() {
        use std::path::Path;

        let directory = tempfile::tempdir().unwrap();
        let first_path = directory.path().join("first.nnue");
        let second_path = directory.path().join("second.nnue");
        std::fs::write(&first_path, b"first").unwrap();
        std::fs::write(&second_path, b"second").unwrap();
        let mut authority = crate::infra::path_authority::PathAuthority::open(
            directory.path().join("registry.json"),
            vec![],
        )
        .unwrap();

        let promote = |authority: &mut crate::infra::path_authority::PathAuthority,
                       path: &Path,
                       display_name: &str| {
            let grant = authority
                .grant_dialog(
                    path,
                    display_name,
                    crate::infra::path_authority::PathClass::SingleDialogGrant,
                    crate::infra::path_authority::PathOperation::EngineResourceRead,
                    Duration::from_secs(30),
                    1,
                )
                .unwrap();
            authority
                .promote_engine_resource(&grant, EngineResourceHandleKind::File, display_name)
                .unwrap()
        };
        let first = promote(&mut authority, &first_path, "first");
        let second = promote(&mut authority, &second_path, "second");
        let options = [EngineOption::Resource {
            name: "EvalFile".into(),
            resources: vec![first, second],
        }];

        let mut resolved = resolve_engine_option_leases(&mut authority, &options).unwrap();
        #[cfg(target_os = "macos")]
        for resource in &resolved[0].resources {
            resource.pin_test_target_to_original().unwrap();
        }
        resolved[0].refresh_resource_values().unwrap();
        assert_eq!(resolved.len(), 1);
        let resolved = &resolved[0];
        assert_eq!(resolved.resources.len(), 2);
        assert_eq!(resolved.resource_values.len(), 2);
        let first_value = resolved.resource_values[0].clone();
        let second_value = resolved.resource_values[1].clone();
        assert_eq!(
            resolved.resource_values,
            vec![first_value.clone(), second_value.clone()]
        );
        let separator = if cfg!(windows) { ";" } else { ":" };
        assert_eq!(resolved.value, [first_value, second_value].join(separator));
        assert_ne!(resolved.resource_values[0], resolved.value);
    }

    /// Path syntax must be refused for *any* option name, including proprietary
    /// ones the authority cannot recognise as file or directory options. Every
    /// shape `is_filesystem_path` claims to reject is listed here, so removing
    /// one of its alternatives fails this test rather than silently opening a
    /// raw-path channel.
    #[test]
    fn rejects_every_path_form_for_proprietary_option_names() {
        for (name, value) in [
            // POSIX absolute, including the leading-whitespace evasion.
            ("Book", "/tmp/book.bin"),
            ("Network", "   /var/lib/weights.nnue"),
            // Windows drive-letter, both separators and either letter case.
            ("TbDir", r"C:\tablebases"),
            ("TbDir", "C:/tablebases"),
            ("Book", "d:/books/gm.bin"),
            // UNC.
            ("Book", r"\\server\share\book.bin"),
            // Home-relative.
            ("Network", "~/nets/weights.nnue"),
            ("Network", r"~\nets\weights.nnue"),
            // Explicitly relative, both separators and both depths.
            ("Network", "./weights.nnue"),
            ("Network", "../weights.nnue"),
            ("Network", r".\weights.nnue"),
            ("Network", r"..\weights.nnue"),
        ] {
            assert!(
                validate_engine_option(&EngineOption::String {
                    name: name.into(),
                    value: value.into(),
                })
                .is_err(),
                "{name} accepted a raw path: {value:?}",
            );
        }
    }

    /// The refusal above must not swallow ordinary configuration values. Each of
    /// these is a near miss for one of the path shapes and must stay valid.
    #[test]
    fn keeps_ordinary_option_strings_that_only_resemble_paths() {
        for (name, value) in [
            ("Style", "aggressive"),
            ("Url", "https://example.test"),
            // Bare relative names are not path-shaped: no leading ./ or ../.
            ("Book", "book.bin"),
            ("Network", "weights.nnue"),
            // A colon that is not a drive letter, and a drive letter without a
            // separator after it.
            ("Mode", "ratio:1/2"),
            ("Book", "C:book"),
            // Dots and tildes that do not begin a path.
            ("Style", "..."),
            ("Comment", "a~b"),
            ("Version", "1.2.3"),
        ] {
            assert!(
                validate_engine_option(&EngineOption::String {
                    name: name.into(),
                    value: value.into(),
                })
                .is_ok(),
                "{name} rejected an ordinary value: {value:?}",
            );
        }
    }
}
