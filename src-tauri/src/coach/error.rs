//! The closed error vocabulary of the Coach. Only these codes cross to the renderer; provider
//! bodies and native causes stay in the native log.

use serde::Serialize;
use specta::Type;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CoachError {
    /// The Coach is switched off in this build.
    Unavailable,
    /// The connection does not exist (any more).
    NotFound,
    /// A label, key or other input is outside its bounds.
    InvalidInput,
    /// The address is not a URL, or too long.
    InvalidAddressFormat,
    /// The address carries user info, a query or a fragment.
    InvalidAddressCredentials,
    /// Not `https` to a public host, and not `http` to this machine or the home network.
    InvalidAddressScheme,
    /// The address moved to another host, so the key has to be entered again.
    KeyRequired,
    TooManyConnections,
    /// The stored connection cannot be read; it has to be entered again or removed.
    NeedsRepair,
    /// The provider refused the key.
    KeyRejected,
    Storage,
    Network,
    RateLimited,
    ProviderFailure,
    /// This tab already runs a turn, or too many turns run at once.
    Busy,
    /// The engine could not be started, crashed, or gave no result in time.
    EngineFailed,
    /// The provider does not know the chosen model.
    ModelUnavailable,
    /// The model cannot call tools, so it cannot ground its answer in the engine.
    NoFunctionCalling,
    /// The provider refused the chosen effort level.
    EffortRejected,
    /// The provider ended the answer at its length limit.
    AnswerCutOff,
    ContentFiltered,
    /// A bound of the turn was exceeded: rounds, text size, argument size or the deadline.
    LimitExceeded,
    Cancelled,
}
