mod process;
pub(crate) use process::EngineBinaryRetirement;
mod types;
mod uci;

pub(crate) const GAME_ENGINE_KEY_PREFIX: &str = "game:";

#[cfg(test)]
pub(crate) use process::CLEANUP_FAILURE_LOG;
#[cfg(all(test, unix))]
pub(crate) use process::REGISTRATION_GUARD_DROPS;
pub(crate) use process::{
    log_registration_cleanup_error, resolve_launch, resolve_option_leases, spawn_registered,
    verify_option_resources, AdmissionLease, RegistrationGuard,
};
pub use process::{EngineActor, EngineLog, EngineSupervisor, SupervisedEngine};
pub use types::*;
pub use uci::*;

pub(crate) fn resource_path_refs(
    options: &[EngineOption],
) -> Vec<crate::infra::path_authority::PathRef> {
    options
        .iter()
        .flat_map(|option| match option {
            EngineOption::Resource { resources, .. } => resources
                .iter()
                .map(|handle| handle.path_ref().clone())
                .collect::<Vec<_>>(),
            EngineOption::String { .. } => Vec::new(),
        })
        .collect()
}
