use crate::infra::blocking::source_scan::production_region;
use std::sync::OnceLock;

/// Every production Rust source file in `src-tauri/src/infra/path_authority/`, keyed by its
/// `src`-relative slash-joined path. Kept as one list so closed-world source scans,
/// `shebang_writer_audit`, `platform_support::tests::source_for`, and the directory-completeness
/// witness all read the exact same file set.
pub(crate) const PRODUCTION_FILES: &[(&str, &str)] = &[
    ("infra/path_authority/mod.rs", include_str!("mod.rs")),
    (
        "infra/path_authority/catalog_install.rs",
        include_str!("catalog_install.rs"),
    ),
    (
        "infra/path_authority/databases.rs",
        include_str!("databases.rs"),
    ),
    (
        "infra/path_authority/dialogs.rs",
        include_str!("dialogs.rs"),
    ),
    (
        "infra/path_authority/engine_attachments.rs",
        include_str!("engine_attachments.rs"),
    ),
    (
        "infra/path_authority/folder_switch.rs",
        include_str!("folder_switch.rs"),
    ),
    (
        "infra/path_authority/handoff_endpoint.rs",
        include_str!("handoff_endpoint.rs"),
    ),
    (
        "infra/path_authority/listing.rs",
        include_str!("listing.rs"),
    ),
    (
        "infra/path_authority/registry.rs",
        include_str!("registry.rs"),
    ),
    (
        "infra/path_authority/resolved.rs",
        include_str!("resolved.rs"),
    ),
    ("infra/path_authority/shared.rs", include_str!("shared.rs")),
    (
        "infra/path_authority/verified.rs",
        include_str!("verified.rs"),
    ),
    (
        "infra/path_authority/workspace.rs",
        include_str!("workspace.rs"),
    ),
];

pub(crate) fn source_for(key: &str) -> Option<&'static str> {
    PRODUCTION_FILES
        .iter()
        .find_map(|(entry_key, source)| (*entry_key == key).then_some(*source))
}

/// Concatenation of every production file in `PRODUCTION_FILES` with each file's inline
/// `#[cfg(test)]` module bodies blanked by `production_region`.
pub(crate) fn production_source() -> &'static str {
    static JOINED: OnceLock<String> = OnceLock::new();
    JOINED.get_or_init(|| {
        PRODUCTION_FILES
            .iter()
            .map(|(_, source)| production_region(source))
            .collect::<Vec<_>>()
            .join("\n")
    })
}
