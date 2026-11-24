//! The refusal helper is pinned by `infra/platform_support/tests.rs`,
//! where their staged-failure record lives.
use crate::error::Error;

pub(crate) fn unsupported_plural(operations: &str) -> Error {
    Error::Conflict(format!("{operations} are unsupported on this platform"))
}

#[cfg(test)]
mod tests;
