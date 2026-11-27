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
    /// The provider ended the sign-in of this connection: the user has to sign in again.
    SignInAgain,
    /// A sign-in was not completed: it was declined, ran out of time, or its answer did not fit.
    SignInFailed,
    /// The account's subscription does not include use from this app.
    SubscriptionNotEligible,
    /// The subscription's usage limit is reached.
    UsageLimitReached,
    /// The account has no credits left: they have to be bought, or the plan upgraded.
    CreditsExhausted,
    /// A scoresheet photo could not be read, decoded or encoded within the supported bounds.
    PhotoUnreadable,
    /// A scoresheet photo could not be saved to or read from this computer.
    PhotoStorage,
    /// The system clipboard does not currently contain a readable image.
    ClipboardEmpty,
    /// The chosen model does not accept image inputs.
    ImagesUnsupported,
    /// The photos could not be read as a chess scoresheet with any legal move.
    ScoresheetUnreadable,
}
