use pgn_reader::{BufferedReader, Nag, RawHeader, SanPlus, Skip, Visitor};
use serde::Serialize;
use specta::Type;
use tokio_util::sync::CancellationToken;

use crate::{cancellable_read::CancellableRead, error::Error, AppState};

struct Lexer {
    tokens: Vec<Token>,
    cancellation: Option<CancellationToken>,
    cancelled: bool,
}

impl Lexer {
    fn check_cancellation(&mut self) -> bool {
        if self.cancelled {
            return true;
        }
        if let Some(cancellation) = &self.cancellation {
            if cancellation.is_cancelled() {
                self.cancelled = true;
                return true;
            }
        }
        false
    }
}

#[derive(Serialize, Clone, Type, Debug, PartialEq)]
#[serde(tag = "type", content = "value")]
pub enum Token {
    ParenOpen,
    ParenClose,
    Comment(String),
    San(String),
    Header { tag: String, value: String },
    Nag(String),
    Outcome(String),
}

#[cfg(test)]
pub(crate) struct LexerTestHook {
    pub entered: std::sync::mpsc::SyncSender<()>,
    pub release: std::sync::mpsc::Receiver<()>,
}

#[cfg(test)]
std::thread_local! {
    static TEST_LEXER_HOOK: std::cell::RefCell<Option<LexerTestHook>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
pub(crate) fn set_test_lexer_hook(hook: Option<LexerTestHook>) {
    TEST_LEXER_HOOK.with(|current| *current.borrow_mut() = hook);
}

#[cfg(test)]
fn trigger_test_lexer_hook() {
    let hook = TEST_LEXER_HOOK.with(|current| current.borrow_mut().take());
    if let Some(hook) = hook {
        let _ = hook.entered.send(());
        let _ = hook.release.recv_timeout(std::time::Duration::from_secs(5));
    }
}

impl Visitor for Lexer {
    type Result = Result<Vec<Token>, Error>;

    fn san(&mut self, san: SanPlus) {
        #[cfg(test)]
        trigger_test_lexer_hook();
        if self.check_cancellation() {
            return;
        }
        self.tokens.push(Token::San(san.to_string()));
    }

    fn header(&mut self, key: &[u8], value: RawHeader<'_>) {
        if self.check_cancellation() {
            return;
        }
        self.tokens.push(Token::Header {
            tag: String::from_utf8_lossy(key).to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).to_string(),
        });
    }

    fn nag(&mut self, nag: Nag) {
        if self.check_cancellation() {
            return;
        }
        self.tokens.push(Token::Nag(nag.to_string()));
    }

    fn begin_variation(&mut self) -> Skip {
        if self.check_cancellation() {
            return Skip(true);
        }
        self.tokens.push(Token::ParenOpen);
        Skip(false)
    }

    fn end_variation(&mut self) {
        if self.check_cancellation() {
            return;
        }
        self.tokens.push(Token::ParenClose);
    }

    fn comment(&mut self, comment: pgn_reader::RawComment<'_>) {
        if self.check_cancellation() {
            return;
        }
        self.tokens.push(Token::Comment(
            String::from_utf8_lossy(comment.as_bytes()).to_string(),
        ));
    }

    fn end_headers(&mut self) -> Skip {
        if self.check_cancellation() {
            Skip(true)
        } else {
            Skip(false)
        }
    }

    fn end_game(&mut self) -> Self::Result {
        if self.check_cancellation() {
            return Err(Error::Cancellation);
        }
        Ok(self.tokens.clone())
    }

    fn outcome(&mut self, outcome: Option<shakmaty::Outcome>) {
        if self.check_cancellation() {
            return;
        }
        self.tokens.push(Token::Outcome(
            outcome.map(|o| o.to_string()).unwrap_or("*".to_string()),
        ));
    }
}

pub fn lex_pgn_cancellable(
    pgn: &str,
    cancellation: Option<&CancellationToken>,
) -> Result<Vec<Token>, Error> {
    if let Some(token) = cancellation {
        if token.is_cancelled() {
            return Err(Error::Cancellation);
        }
    }
    let never_cancelled = CancellationToken::new();
    let reader = CancellableRead::new(pgn.as_bytes(), cancellation.unwrap_or(&never_cancelled));
    let mut buffered = BufferedReader::new(reader);
    let mut lexer = Lexer {
        tokens: Vec::new(),
        cancellation: cancellation.cloned(),
        cancelled: false,
    };
    let outcome = crate::pgn::read_one_range_game(&mut buffered, &mut lexer);
    if !matches!(outcome, Ok(crate::pgn::RangeGame::One(_)))
        && (cancellation.is_some_and(|c| c.is_cancelled()) || lexer.cancelled)
    {
        return Err(Error::Cancellation);
    }
    match outcome {
        Ok(crate::pgn::RangeGame::One(result)) => result,
        Ok(crate::pgn::RangeGame::Empty) => Ok(Vec::new()),
        Ok(crate::pgn::RangeGame::Remainder) => {
            Err(Error::InvalidInput(crate::pgn::MORE_THAN_ONE_GAME.into()))
        }
        Err(e) => Err(Error::InvalidInput(format!("PGN parse error: {e:?}"))),
    }
}

#[cfg(test)]
pub fn lex_pgn_sync(pgn: &str) -> Result<Vec<Token>, String> {
    lex_pgn_cancellable(pgn, None).map_err(|e| e.to_string())
}

pub fn validate_pgn_len(pgn: &str) -> Result<(), Error> {
    if pgn.len() > 10 * 1024 * 1024 {
        return Err(Error::InvalidInput("PGN string too large".into()));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn lex_pgn(
    pgn: String,
    ticket: Option<String>,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Token>, Error> {
    validate_pgn_len(&pgn)?;

    let operation = crate::native_read_operation(ticket, &window, &state, "lex_pgn")?;
    let cancellation = operation.token();
    crate::infra::operations::run_native_operation(operation, "lex_pgn", async move {
        crate::infra::blocking::BLOCKING_GATEWAY
            .spawn_cancellable(cancellation, move |token| {
                lex_pgn_cancellable(&pgn, Some(token))
            })
            .await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_token_lex_returns_full_comment() {
        let comment = "c".repeat(26_158);
        let tokens = lex_pgn_sync(&format!("1. e4 {{{comment}}} e5 *")).unwrap();
        assert_eq!(tokens[1], Token::Comment(comment));
        assert_eq!(tokens.len(), 4);
    }

    #[test]
    fn long_token_tag_value_parses() {
        let value = "v".repeat(20 * 1024);
        let tokens = lex_pgn_sync(&format!("[Event \"{value}\"]\n\n1. e4 *")).unwrap();
        assert_eq!(
            tokens[0],
            Token::Header {
                tag: "Event".into(),
                value
            }
        );
        assert_eq!(tokens.len(), 3);
    }

    #[test]
    fn long_token_tag_name_parses() {
        let tag = "T".repeat(20 * 1024);
        let tokens = lex_pgn_sync(&format!("[{tag} \"value\"]\n\n1. e4 *")).unwrap();
        assert_eq!(
            tokens[0],
            Token::Header {
                tag,
                value: "value".into()
            }
        );
        assert_eq!(tokens.len(), 3);
    }

    #[test]
    fn long_token_tag_escape_across_read_boundary_parses() {
        struct ShortReads<'a>(&'a [u8]);
        impl std::io::Read for ShortReads<'_> {
            fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
                let size = output.len().min(self.0.len()).min(127);
                output[..size].copy_from_slice(&self.0[..size]);
                self.0 = &self.0[size..];
                Ok(size)
            }
        }
        let value = "a\\\"".repeat(10 * 1024);
        let pgn = format!("[Event \"{value}\"]\n\n1. e4 *");
        let mut lexer = Lexer {
            tokens: Vec::new(),
            cancellation: None,
            cancelled: false,
        };
        let tokens = BufferedReader::new(ShortReads(pgn.as_bytes()))
            .read_game(&mut lexer)
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(
            tokens[0],
            Token::Header {
                tag: "Event".into(),
                value
            }
        );
        assert_eq!(tokens.len(), 3);
    }

    #[test]
    fn test_lex_pgn_sync_representative() {
        let pgn = "[Event \"Test\"]\n\n1. e4 {Best by test} (1. d4) 1... e5 $1 1-0";
        let tokens = lex_pgn_sync(pgn).unwrap();
        assert_eq!(
            tokens,
            vec![
                Token::Header {
                    tag: "Event".to_string(),
                    value: "Test".to_string()
                },
                Token::San("e4".to_string()),
                Token::Comment("Best by test".to_string()),
                Token::ParenOpen,
                Token::San("d4".to_string()),
                Token::ParenClose,
                Token::San("e5".to_string()),
                Token::Nag("$1".to_string()),
                Token::Outcome("1-0".to_string()),
            ]
        );
    }

    #[test]
    fn test_lex_pgn_sync_lossless_nags() {
        let pgn = "1. e4 $8 $8 c6 $11 2. d4! $2 d5 $14 $1 3. Nc3 $220 dxe4?! $146 4. Nxe4 $0 Bf5 $255 5. a3!? *";
        let tokens = lex_pgn_sync(pgn).unwrap();
        assert_eq!(
            tokens,
            vec![
                Token::San("e4".to_string()),
                Token::Nag("$8".to_string()),
                Token::Nag("$8".to_string()),
                Token::San("c6".to_string()),
                Token::Nag("$11".to_string()),
                Token::San("d4".to_string()),
                Token::Nag("$1".to_string()),
                Token::Nag("$2".to_string()),
                Token::San("d5".to_string()),
                Token::Nag("$14".to_string()),
                Token::Nag("$1".to_string()),
                Token::San("Nc3".to_string()),
                Token::Nag("$220".to_string()),
                Token::San("dxe4".to_string()),
                Token::Nag("$6".to_string()),
                Token::Nag("$146".to_string()),
                Token::San("Nxe4".to_string()),
                Token::Nag("$0".to_string()),
                Token::San("Bf5".to_string()),
                Token::Nag("$255".to_string()),
                Token::San("a3".to_string()),
                Token::Nag("$5".to_string()),
                Token::Outcome("*".to_string()),
            ]
        );
    }

    #[test]
    fn test_lex_pgn_sync_empty() {
        let tokens = lex_pgn_sync("").unwrap();
        assert_eq!(tokens, vec![]);
    }

    #[test]
    fn test_lex_pgn_sync_malformed() {
        // pgn-reader tolerates malformed movetext and parses it deterministically
        let tokens = lex_pgn_sync("1. e4e5").unwrap();
        assert_eq!(tokens, vec![Token::San("e4e5".to_string())]);
    }

    #[test]
    fn test_lex_pgn_limit() {
        let pgn = " ".repeat(10 * 1024 * 1024 + 1);
        let result = validate_pgn_len(&pgn);
        assert!(
            matches!(result, Err(Error::InvalidInput(ref msg)) if msg == "PGN string too large")
        );
    }

    #[test]
    fn test_lex_pgn_cancels_with_checkpoints() {
        let pgn = "[Event \"Test\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 1-0";
        let token = CancellationToken::new();
        token.cancel();
        let result = lex_pgn_cancellable(pgn, Some(&token));
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn test_lex_pgn_cancels_while_running_mid_parse() {
        let pgn = "[Event \"Test\"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 1-0";
        let token = CancellationToken::new();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);

        let thread_token = token.clone();
        let pgn_str = pgn.to_string();
        let worker = std::thread::spawn(move || {
            // Install the ONE-SHOT thread-local hook INSIDE the actual worker thread
            set_test_lexer_hook(Some(LexerTestHook {
                entered: entered_tx,
                release: release_rx,
            }));
            struct Cleanup;
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    set_test_lexer_hook(None);
                }
            }
            let _cleanup = Cleanup;
            lex_pgn_cancellable(&pgn_str, Some(&thread_token))
        });

        // 1. Await entered hook: bounded by recv_timeout
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("worker must enter parser and reach SAN callback");

        // 2. Cancel the token while lexer is actively running
        token.cancel();

        // 3. Release the worker
        let _ = release_tx.send(());

        let result = worker.join().expect("worker thread must complete");
        assert!(matches!(result, Err(Error::Cancellation)));
    }

    #[test]
    fn test_lex_visitor_cancels_at_first_san_without_reader_error() {
        let pgn = "[Event \"Test\"]\n\n1. e4 e5 2. Nf3 Nc6 *";
        let token = CancellationToken::new();
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
        let thread_token = token.clone();
        let pgn_owned = pgn.to_string();
        let worker = std::thread::spawn(move || {
            set_test_lexer_hook(Some(LexerTestHook {
                entered: entered_tx,
                release: release_rx,
            }));
            struct Cleanup;
            impl Drop for Cleanup {
                fn drop(&mut self) {
                    set_test_lexer_hook(None);
                }
            }
            let _cleanup = Cleanup;
            let mut lexer = Lexer {
                tokens: Vec::new(),
                cancellation: Some(thread_token),
                cancelled: false,
            };
            // Plain reader: CancellableRead would return Interrupted after cancel, and
            // lex_pgn_cancellable would map that to Cancellation even if check_cancellation
            // were constantly false.
            let parsed = BufferedReader::new(pgn_owned.as_bytes()).read_game(&mut lexer);
            (parsed, lexer.tokens)
        });

        entered_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("worker must reach the first SAN callback");
        token.cancel();
        let _ = release_tx.send(());

        let (parsed, tokens) = worker.join().expect("worker thread must complete");
        assert!(
            matches!(parsed, Ok(Some(Err(Error::Cancellation)))),
            "visitor end_game must return Cancellation without a reader error, got {parsed:?}"
        );
        assert_eq!(
            tokens,
            vec![Token::Header {
                tag: "Event".to_string(),
                value: "Test".to_string(),
            }]
        );
    }
}
