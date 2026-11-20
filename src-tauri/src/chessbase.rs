use std::path::{Path, PathBuf};
use tauri_specta::Event;

const EXTENSIONS: [&str; 6] = ["cbh", "2cbh", "cbone", "cbv", "cbz", "cbf"];

pub(crate) fn is_database(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            EXTENSIONS
                .iter()
                .any(|known| extension.eq_ignore_ascii_case(known))
        })
}

pub(crate) fn picker_extensions() -> Vec<String> {
    std::iter::once("pgn".to_owned())
        .chain(
            EXTENSIONS
                .iter()
                .flat_map(|extension| [extension.to_string(), extension.to_ascii_uppercase()]),
        )
        .collect()
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, specta::Type, Event)]
pub(crate) struct ChessBaseSelected {}

fn should_emit(paths: &[PathBuf]) -> bool {
    paths.iter().any(|path| is_database(path))
}

pub(crate) fn handle_drop<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::DragDropEvent,
) -> tauri::Result<()> {
    if window.label() == "main" {
        if let tauri::DragDropEvent::Drop { paths, .. } = event {
            if should_emit(paths) {
                ChessBaseSelected {}.emit_to(window, window.label())?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;
    use crate::workspace_commands::issue_pgn_workspace_blocking;
    use std::sync::{Arc, Mutex};

    #[test]
    fn chessbase_classifier_and_filter_list() {
        let filters = picker_extensions();
        assert_eq!(filters.len(), 13);
        assert_eq!(filters[0], "pgn");
        for extension in EXTENSIONS {
            for case in [
                extension.to_owned(),
                extension.to_ascii_uppercase(),
                extension
                    .chars()
                    .enumerate()
                    .map(|(index, value)| {
                        if index % 2 == 0 {
                            value.to_ascii_uppercase()
                        } else {
                            value
                        }
                    })
                    .collect(),
            ] {
                assert!(is_database(Path::new(&format!("games.{case}"))));
            }
            assert!(filters.contains(&extension.to_owned()));
            assert!(filters.contains(&extension.to_ascii_uppercase()));
        }
        for file in ["games.pgn", "games", "games.cbh.pgn"] {
            assert!(!is_database(Path::new(file)));
        }
    }

    #[test]
    fn chessbase_drop_decision() {
        assert!(should_emit(&["games.pgn".into(), "games.CbH".into()]));
        assert!(!should_emit(&["games.pgn".into(), "games.txt".into()]));
        assert!(!should_emit(&[]));
    }

    #[test]
    fn chessbase_drop_to_typed_event() -> Result<(), Box<dyn std::error::Error>> {
        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(ChessBaseSelected))
            .mount_events(&app);
        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build()?;
        let window = webview.as_ref().window();
        let received = Arc::new(Mutex::new(0));
        let observed = received.clone();
        let listener = ChessBaseSelected::listen(&window, move |_| {
            if let Ok(mut count) = observed.lock() {
                *count += 1;
            }
        });
        let drop = |paths| tauri::DragDropEvent::Drop {
            paths,
            position: tauri::PhysicalPosition::new(0.0, 0.0),
        };
        handle_drop(
            &window,
            &drop(vec!["games.CBH".into(), "archive.cbv".into()]),
        )?;
        assert_eq!(*received.lock().map_err(|_| "event lock poisoned")?, 1);
        handle_drop(&window, &drop(vec!["games.pgn".into()]))?;
        handle_drop(&window, &tauri::DragDropEvent::Leave)?;
        handle_drop(
            &window,
            &tauri::DragDropEvent::Enter {
                paths: vec!["games.cbh".into()],
                position: tauri::PhysicalPosition::new(0.0, 0.0),
            },
        )?;
        assert_eq!(*received.lock().map_err(|_| "event lock poisoned")?, 1);
        use tauri::Listener;
        window.unlisten(listener);
        Ok(())
    }

    #[test]
    fn chessbase_selection_refuses_before_authority_and_pgn_still_succeeds(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::infra::path_authority::{PathAuthority, SharedPathAuthority};
        let directory = tempfile::tempdir()?;
        let registry = directory.path().join("registry.json");
        let authority =
            SharedPathAuthority::installed(PathAuthority::open(registry.clone(), vec![])?);
        let before = authority
            .with_mut(|authority| serde_json::to_value(authority.descriptors()))
            .map_err(Error::from)??;
        for name in [
            "games.cbh",
            "games.2CbH",
            "games.CBONE",
            "games.cbv",
            "games.cbz",
            "games.cbf",
        ] {
            // The path need not exist: refusal must precede all file access and authority changes.
            let result = issue_pgn_workspace_blocking(&authority, directory.path().join(name));
            assert!(matches!(result, Err(Error::ChessBaseDatabase)));
            let after = authority
                .with_mut(|authority| serde_json::to_value(authority.descriptors()))
                .map_err(Error::from)??;
            assert_eq!(before, after);
            assert!(!registry.exists());
        }
        let pgn = directory.path().join("games.pgn");
        std::fs::write(&pgn, "*")?;
        let descriptor = issue_pgn_workspace_blocking(&authority, pgn)?;
        assert_eq!(descriptor.display_name, "games.pgn");
        assert!(registry.exists());
        let persisted = PathAuthority::open(registry, vec![])?.descriptors();
        assert_eq!(persisted.len(), 1);
        Ok(())
    }
}
