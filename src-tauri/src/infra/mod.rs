// infra/ is the sanctioned owner of pathname filesystem reaches (f-20260912-03).
#![allow(clippy::disallowed_methods)]

pub(crate) mod appimage_handler;
pub mod blocking;
pub mod cancellable_lock;
pub(crate) mod external_url;
pub mod fs;
pub(crate) mod game_link;
pub(crate) mod game_link_handoff;
pub(crate) mod inode_ownership;
pub(crate) mod keyed_locks;
pub mod net;
pub mod operations;
pub mod path_authority;
pub(crate) mod platform_support;
#[cfg(test)]
mod reload_completion_tests;
pub mod runtime;
#[cfg(all(test, unix))]
pub(crate) mod test_executable;
#[cfg(test)]
pub(crate) mod test_hooks;
pub(crate) mod token_session;
pub mod validation;
