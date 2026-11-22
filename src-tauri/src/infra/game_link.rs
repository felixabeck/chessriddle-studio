//! Game links: `chessriddle-studio://import?url=<game URL>`.
//!
//! The browser extension (`browser-extension/`) puts such a link on a finished chess.com or
//! Lichess game. The operating system hands the string to this process, so it is arbitrary
//! input: it is parsed here into a typed [`GameLink`], and only that typed value is ever given to
//! the renderer. `browser-extension/link-contract.json` is the contract both sides test against.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::error::Error;
use crate::AppState;

/// The URL scheme this application registers (`tauri.conf.json`, `scripts/install-local.sh`).
pub(crate) const SCHEME: &str = "chessriddle-studio";

/// A longer string is refused before it is parsed.
const MAX_LINK_BYTES: usize = 512;

/// How many accepted links may wait for the renderer. A further link is dropped.
pub(crate) const MAX_PENDING_LINKS: usize = 16;

const LICHESS_PREFIX: &str = "https://lichess.org/";
const LICHESS_ID_LENGTH: usize = 8;
const CHESS_COM_PREFIX: &str = "https://www.chess.com/game/";
const CHESS_COM_ID_MAX_DIGITS: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ChessComGameType {
    Live,
    Daily,
}

/// One game on a supported site, in the vocabulary of the native fetch commands.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(tag = "site", rename_all = "kebab-case")]
pub enum GameLink {
    Lichess {
        game_id: String,
    },
    ChessCom {
        game_type: ChessComGameType,
        game_id: String,
    },
}

/// Signals the main window that [`take_pending_game_links`] has something to return. It carries
/// nothing: a link that arrives before the renderer listens is found by the drain at startup.
#[derive(Clone, Debug, Serialize, Deserialize, Type, Event)]
pub(crate) struct GameLinkPending {}

/// Parses a complete link. Everything that is not exactly one of the two canonical game URLs
/// inside the one accepted outer form is refused.
pub(crate) fn parse(raw: &str) -> Option<GameLink> {
    if raw.len() > MAX_LINK_BYTES {
        return None;
    }
    let link = url::Url::parse(raw).ok()?;
    if link.scheme() != SCHEME
        || link.host_str() != Some("import")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.port().is_some()
        || !matches!(link.path(), "" | "/")
        || link.fragment().is_some()
    {
        return None;
    }
    let mut pairs = link.query_pairs();
    let (key, game_url) = pairs.next()?;
    if key != "url" || pairs.next().is_some() {
        return None;
    }
    parse_game_url(&game_url)
}

/// The inner URL is matched as text, never re-parsed: any port, user info, query, fragment,
/// case variation or trailing slash makes it differ from the canonical form and refuses it.
fn parse_game_url(game_url: &str) -> Option<GameLink> {
    if let Some(game_id) = game_url.strip_prefix(LICHESS_PREFIX) {
        let canonical = game_id.len() == LICHESS_ID_LENGTH
            && game_id.bytes().all(|byte| byte.is_ascii_alphanumeric());
        return canonical.then(|| GameLink::Lichess {
            game_id: game_id.to_owned(),
        });
    }
    let (game_type, game_id) = game_url.strip_prefix(CHESS_COM_PREFIX)?.split_once('/')?;
    let game_type = match game_type {
        "live" => ChessComGameType::Live,
        "daily" => ChessComGameType::Daily,
        _ => return None,
    };
    let canonical = !game_id.is_empty()
        && game_id.len() <= CHESS_COM_ID_MAX_DIGITS
        && !game_id.starts_with('0')
        && game_id.bytes().all(|byte| byte.is_ascii_digit());
    canonical.then(|| GameLink::ChessCom {
        game_type,
        game_id: game_id.to_owned(),
    })
}

/// The link this process was started with: exactly one argument after the binary name, and that
/// argument is an accepted link. Any other command line carries no link.
pub(crate) fn launch_link(arguments: impl IntoIterator<Item = OsString>) -> Option<String> {
    let mut arguments = arguments.into_iter().skip(1);
    let only = arguments.next()?;
    if arguments.next().is_some() {
        return None;
    }
    let raw = only.into_string().ok()?;
    parse(&raw).map(|_| raw)
}

/// What happened to one offered link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Intake {
    /// Accepted and waiting for the renderer.
    Queued,
    /// Not an accepted link.
    Refused,
    /// An accepted link, dropped because [`MAX_PENDING_LINKS`] are already waiting.
    Full,
}

/// The accepted links the renderer has not taken yet, oldest first. Owned by [`AppState`] for
/// the lifetime of the process and bounded by [`MAX_PENDING_LINKS`].
#[derive(Debug, Default)]
pub(crate) struct PendingGameLinks(Mutex<VecDeque<GameLink>>);

impl PendingGameLinks {
    /// Parses and enqueues. Neither refusal echoes the input into the log.
    pub(crate) fn offer(&self, raw: &str) -> Intake {
        let Some(link) = parse(raw) else {
            log::warn!("refused a game link: it is not a supported chess.com or Lichess game link");
            return Intake::Refused;
        };
        let mut pending = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if pending.len() >= MAX_PENDING_LINKS {
            log::warn!(
                "dropped a game link: {MAX_PENDING_LINKS} links are already waiting to be opened"
            );
            return Intake::Full;
        }
        pending.push_back(link);
        Intake::Queued
    }

    fn take_all(&self) -> Vec<GameLink> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .drain(..)
            .collect()
    }
}

/// Hands every waiting link to the renderer, oldest first, and forgets them.
#[tauri::command]
#[specta::specta]
pub(crate) async fn take_pending_game_links(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<GameLink>, Error> {
    Ok(state.game_links.take_all())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Contract {
        accepted: Vec<Accepted>,
        refused: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Accepted {
        link: String,
        game: GameLink,
    }

    fn contract() -> Contract {
        serde_json::from_str(include_str!(
            "../../../browser-extension/link-contract.json"
        ))
        .expect("the link contract is valid JSON in the documented shape")
    }

    const LICHESS_LINK: &str =
        "chessriddle-studio://import?url=https%3A%2F%2Flichess.org%2Fabcdefgh";

    #[test]
    fn every_contract_link_parses_to_its_typed_game() {
        let contract = contract();
        assert!(contract.accepted.len() >= 7);
        for accepted in contract.accepted {
            assert_eq!(
                parse(&accepted.link),
                Some(accepted.game),
                "{}",
                accepted.link
            );
        }
    }

    #[test]
    fn every_contract_refusal_is_refused() {
        let contract = contract();
        assert!(contract.refused.len() >= 40);
        for refused in contract.refused {
            assert_eq!(parse(&refused), None, "{refused}");
        }
    }

    #[test]
    fn a_root_path_and_an_unencoded_game_url_are_the_same_link() {
        let lichess = Some(GameLink::Lichess {
            game_id: "abcdefgh".into(),
        });
        assert_eq!(
            parse("chessriddle-studio://import/?url=https%3A%2F%2Flichess.org%2Fabcdefgh"),
            lichess
        );
        assert_eq!(
            parse("chessriddle-studio://import?url=https://lichess.org/abcdefgh"),
            lichess
        );
        assert_eq!(
            parse("CHESSRIDDLE-STUDIO://import?url=https%3A%2F%2Flichess.org%2Fabcdefgh"),
            lichess
        );
    }

    #[test]
    fn a_link_longer_than_the_bound_is_refused_before_parsing() {
        let padded = format!("{LICHESS_LINK}{}", "&".repeat(MAX_LINK_BYTES));
        assert!(padded.len() > MAX_LINK_BYTES);
        assert_eq!(parse(&padded), None);
        // The bound, not the padding, is what refuses: the same shape within it has one pair.
        let at_bound = format!(
            "chessriddle-studio://import?url={}",
            "x".repeat(MAX_LINK_BYTES - "chessriddle-studio://import?url=".len())
        );
        assert_eq!(at_bound.len(), MAX_LINK_BYTES);
        assert_eq!(parse(&at_bound), None);
    }

    #[test]
    fn the_typed_link_serializes_in_the_contract_vocabulary() {
        assert_eq!(
            serde_json::to_value(GameLink::ChessCom {
                game_type: ChessComGameType::Daily,
                game_id: "42".into(),
            })
            .unwrap(),
            serde_json::json!({ "site": "chess-com", "game_type": "daily", "game_id": "42" })
        );
        assert_eq!(
            serde_json::to_value(GameLink::Lichess {
                game_id: "abcdefgh".into(),
            })
            .unwrap(),
            serde_json::json!({ "site": "lichess", "game_id": "abcdefgh" })
        );
    }

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_a_single_accepted_link_argument_is_a_launch_link() {
        assert_eq!(
            launch_link(arguments(&["studio", LICHESS_LINK])),
            Some(LICHESS_LINK.to_owned())
        );
        assert_eq!(launch_link(arguments(&["studio"])), None);
        assert_eq!(launch_link(arguments(&[])), None);
        assert_eq!(
            launch_link(arguments(&["studio", LICHESS_LINK, "--flag"])),
            None
        );
        assert_eq!(
            launch_link(arguments(&["studio", "--flag", LICHESS_LINK])),
            None
        );
        assert_eq!(
            launch_link(arguments(&["studio", "/home/user/game.pgn"])),
            None
        );
        assert_eq!(
            launch_link(arguments(&[
                "studio",
                "chessriddle-studio://import?url=https%3A%2F%2Fevil.example%2Fabcdefgh"
            ])),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_non_unicode_argument_is_not_a_launch_link() {
        use std::os::unix::ffi::OsStringExt;
        let argument = OsString::from_vec(vec![0xff, 0xfe]);
        assert_eq!(launch_link([OsString::from("studio"), argument]), None);
    }

    #[test]
    fn offers_report_queued_refused_and_full_and_drain_in_order() {
        let pending = PendingGameLinks::default();
        assert_eq!(pending.offer("not a link"), Intake::Refused);
        assert!(pending.take_all().is_empty());

        let link = |index: usize| {
            format!("chessriddle-studio://import?url=https://www.chess.com/game/live/{index}")
        };
        for index in 1..=MAX_PENDING_LINKS {
            assert_eq!(pending.offer(&link(index)), Intake::Queued);
        }
        assert_eq!(pending.offer(&link(999)), Intake::Full);
        // A refusal at the bound stays a refusal.
        assert_eq!(pending.offer("not a link"), Intake::Refused);

        let taken = pending.take_all();
        assert_eq!(taken.len(), MAX_PENDING_LINKS);
        assert_eq!(
            taken.first(),
            Some(&GameLink::ChessCom {
                game_type: ChessComGameType::Live,
                game_id: "1".into(),
            })
        );
        assert_eq!(
            taken.last(),
            Some(&GameLink::ChessCom {
                game_type: ChessComGameType::Live,
                game_id: MAX_PENDING_LINKS.to_string(),
            })
        );
        // Taking empties the queue, so the dropped link is not resurrected and room returns.
        assert!(pending.take_all().is_empty());
        assert_eq!(pending.offer(&link(999)), Intake::Queued);
    }

    #[test]
    fn a_poisoned_queue_keeps_serving() {
        let pending = std::sync::Arc::new(PendingGameLinks::default());
        let poisoner = pending.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.0.lock().unwrap();
            panic!("poison the pending-links lock");
        })
        .join();
        assert_eq!(pending.offer(LICHESS_LINK), Intake::Queued);
        assert_eq!(pending.take_all().len(), 1);
    }
}
