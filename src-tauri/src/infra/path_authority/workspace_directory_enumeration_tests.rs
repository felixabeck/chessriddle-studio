use super::*;
use crate::infra::blocking::source_scan::body_at_indent;
use crate::infra::path_authority::{
    set_capability_child_pre_open_hook, set_capability_directory_post_entries_hook,
    set_workspace_metadata_post_open_hook, set_workspace_metadata_pre_open_hook, SystemClock,
};
use std::sync::atomic::{AtomicBool, Ordering};

fn root_fixture(path: &Path) -> (tempfile::TempDir, PathAuthority, PathRef) {
    let directory = tempfile::tempdir().unwrap();
    if !path.exists() {
        fs::create_dir_all(path).unwrap();
    }
    let mut authority = PathAuthority::open_with_clock(
        directory.path().join("registry.json"),
        vec![],
        std::sync::Arc::new(SystemClock),
        2,
    )
    .unwrap();
    let id = authority
        .migrate_legacy_os_path(
            path.to_path_buf().into_os_string(),
            "root",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn],
        )
        .unwrap()
        .id;
    (directory, authority, id)
}
#[test]
fn capability_child_open_refuses_a_symlink_swap() {
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let child = root.join("child");
    let outside = directory.path().join("outside");
    fs::create_dir_all(&child).unwrap();
    fs::create_dir(&outside).unwrap();
    let (_registry, mut authority, id) = root_fixture(&root);
    let capability = authority
        .capability_directory(&id, PathOperation::ReadPgn)
        .unwrap();
    let entry = capability
        .entries(&CancellationToken::new(), &mut |_| true)
        .unwrap()
        .into_iter()
        .find(|entry| entry.name == "child")
        .unwrap();
    let old = root.join("child-old");
    let child_for_hook = child.clone();
    set_capability_child_pre_open_hook(Some(Box::new(move || {
        fs::rename(&child_for_hook, &old).unwrap();
        symlink(&outside, &child_for_hook).unwrap();
    })));
    let result = capability.open_child_directory(&entry);
    set_capability_child_pre_open_hook(None);
    assert!(matches!(result, Err(Error::Conflict(_))));
}

#[test]
fn capability_child_open_refuses_a_directory_swap() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let child = root.join("child");
    fs::create_dir_all(&child).unwrap();
    let (_registry, mut authority, id) = root_fixture(&root);
    let capability = authority
        .capability_directory(&id, PathOperation::ReadPgn)
        .unwrap();
    let entry = capability
        .entries(&CancellationToken::new(), &mut |_| true)
        .unwrap()
        .into_iter()
        .find(|entry| entry.name == "child")
        .unwrap();
    let old = root.join("child-old");
    let child_for_hook = child.clone();
    set_capability_child_pre_open_hook(Some(Box::new(move || {
        fs::rename(&child_for_hook, &old).unwrap();
        fs::create_dir(&child_for_hook).unwrap();
    })));
    let result = capability.open_child_directory(&entry);
    set_capability_child_pre_open_hook(None);
    assert!(matches!(result, Err(Error::Conflict(_))));
}

#[test]
fn capability_child_open_refuses_a_file_swap_and_a_removal() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    let child = root.join("child");
    fs::create_dir_all(&child).unwrap();
    let (_registry, mut authority, id) = root_fixture(&root);
    let capability = authority
        .capability_directory(&id, PathOperation::ReadPgn)
        .unwrap();
    let entry = capability
        .entries(&CancellationToken::new(), &mut |_| true)
        .unwrap()
        .into_iter()
        .find(|entry| entry.name == "child")
        .unwrap();
    fs::remove_dir(&child).unwrap();
    fs::write(&child, b"file").unwrap();
    assert!(matches!(
        capability.open_child_directory(&entry),
        Err(Error::Conflict(_))
    ));
    fs::remove_file(&child).unwrap();
    assert!(matches!(
        capability.open_child_directory(&entry),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn metadata_sidecar_is_read_from_the_enumerated_directory() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    fs::create_dir(&root).unwrap();
    let sub = root.join("sub");
    fs::create_dir(&sub).unwrap();
    fs::write(sub.join("a.pgn"), b"*").unwrap();
    fs::write(sub.join("a.info"), b"trusted").unwrap();
    let (_registry, mut authority, id) = root_fixture(&root);
    let root_capability = authority
        .capability_directory(&id, PathOperation::ReadPgn)
        .unwrap();
    let sub_entry = root_capability
        .entries(&CancellationToken::new(), &mut |name| {
            name == OsStr::new("sub")
        })
        .unwrap()
        .pop()
        .unwrap();
    let capability = root_capability.open_child_directory(&sub_entry).unwrap();
    let entry = capability
        .entries(&CancellationToken::new(), &mut |name| {
            name == OsStr::new("a.pgn")
        })
        .unwrap()
        .pop()
        .unwrap();
    let moved = directory.path().join("moved");
    fs::rename(&sub, &moved).unwrap();
    fs::create_dir(&sub).unwrap();
    fs::hard_link(moved.join("a.pgn"), sub.join("a.pgn")).unwrap();
    fs::write(sub.join("a.info"), b"attacker").unwrap();
    let mut sidecar = capability.open_metadata_sidecar(&entry).unwrap().unwrap();
    let mut bytes = Vec::new();
    sidecar.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"trusted");
}

#[test]
fn metadata_sidecar_refuses_a_pgn_replaced_before_the_sidecar_open() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    fs::create_dir(&root).unwrap();
    let pgn = root.join("a.pgn");
    let info = root.join("a.info");
    fs::write(&pgn, b"*").unwrap();
    fs::write(&info, b"trusted").unwrap();
    let (_registry, mut authority, id) = root_fixture(&root);
    let capability = authority
        .capability_directory(&id, PathOperation::ReadPgn)
        .unwrap();
    let entry = capability
        .entries(&CancellationToken::new(), &mut |name| {
            name == OsStr::new("a.pgn")
        })
        .unwrap()
        .pop()
        .unwrap();
    let post = std::sync::Arc::new(AtomicBool::new(false));
    let post_observed = std::sync::Arc::clone(&post);
    set_workspace_metadata_post_open_hook(Some(Box::new(move |_| {
        post_observed.store(true, Ordering::SeqCst);
    })));
    let pgn_for_hook = pgn.clone();
    let info_for_hook = info.clone();
    set_workspace_metadata_pre_open_hook(Some(Box::new(move || {
        fs::rename(&pgn_for_hook, root.join("old.pgn")).unwrap();
        fs::write(&pgn_for_hook, b"replacement").unwrap();
        fs::rename(&info_for_hook, root.join("old.info")).unwrap();
        fs::write(&info_for_hook, b"attacker").unwrap();
    })));
    let result = capability.open_metadata_sidecar(&entry);
    set_workspace_metadata_pre_open_hook(None);
    set_workspace_metadata_post_open_hook(None);
    assert!(matches!(result, Err(Error::Conflict(_))));
    assert!(post.load(Ordering::SeqCst));
}

#[derive(Clone, Copy)]
enum Db3ListingKind {
    Database,
    Puzzle,
}

enum Db3RootHandle {
    Database(DatabaseRootHandle),
    Puzzle(PuzzleRootHandle),
}

#[derive(Clone, Copy)]
enum Db3Replacement {
    RegularFile,
    Directory,
}

fn directory_listing_bound_list_db3(
    authority: &mut PathAuthority,
    root: &Db3RootHandle,
    token: &CancellationToken,
) -> Result<Vec<PathRef>, Error> {
    match root {
        Db3RootHandle::Database(root) => authority
            .list_database_children_cancellable(root, token)
            .map(|entries| {
                entries
                    .entries
                    .into_iter()
                    .map(|entry| entry.handle.path_ref().clone())
                    .collect()
            }),
        Db3RootHandle::Puzzle(root) => authority
            .list_puzzle_children_cancellable(root, token)
            .map(|entries| entries.into_iter().map(|entry| entry.file).collect()),
    }
}

#[test]
fn directory_listing_bound_database_and_puzzle_overflow_publish_no_child_ids() -> Result<(), Error>
{
    for kind in [Db3ListingKind::Database, Db3ListingKind::Puzzle] {
        let (_directory, root, mut authority, handle) = db3_root_fixture(kind);
        for index in 0..crate::infra::fs::MAX_DIRECTORY_LISTING_ENTRIES {
            fs::write(root.join(format!("{index}.txt")), b"")?;
        }
        let before = authority.persistent.clone();
        assert!(matches!(
            directory_listing_bound_list_db3(
                &mut authority,
                &handle,
                &CancellationToken::new()
            ),
            Err(ref error) if matches!(error.unlabelled(), Error::ResourceLimit(_))
        ));
        assert!(authority.persistent == before);
        fs::remove_file(root.join("0.txt"))?;
        assert_eq!(
            directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?
                .len(),
            1
        );
        fs::write(root.join("b.db3"), b"new")?;
        let before = authority.persistent.clone();
        assert!(matches!(
            directory_listing_bound_list_db3(
                &mut authority,
                &handle,
                &CancellationToken::new()
            ),
            Err(ref error) if matches!(error.unlabelled(), Error::ResourceLimit(_))
        ));
        assert!(authority.persistent == before);
    }
    Ok(())
}

#[test]
fn directory_listing_bound_database_and_puzzle_snapshots_retire_only_direct_children(
) -> Result<(), Error> {
    for kind in [Db3ListingKind::Database, Db3ListingKind::Puzzle] {
        let (_directory, root, mut authority, handle) = db3_root_fixture(kind);
        let ids =
            directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?;
        let child_id = ids
            .first()
            .ok_or_else(|| Error::Conflict("test child missing".into()))?;
        let mut nested = authority
            .persistent
            .get(&child_id.id)
            .cloned()
            .ok_or_else(|| Error::Conflict("test child missing".into()))?;
        nested.stored.id = PathRef::fresh();
        let nested_id = nested.stored.id.clone();
        nested.stored.path = NativePath::from_path(&root.join("nested/hidden.db3"));
        authority.persistent.insert(nested_id.id.clone(), nested);
        require_durable(authority.save()?)?;
        fs::remove_file(root.join("a.db3"))?;
        assert!(directory_listing_bound_list_db3(
            &mut authority,
            &handle,
            &CancellationToken::new()
        )?
        .is_empty());
        assert!(!authority.persistent.contains_key(&child_id.id));
        assert!(authority.persistent.contains_key(&nested_id.id));
    }
    Ok(())
}

#[test]
fn directory_listing_bound_database_identity_replacement_at_capacity() -> Result<(), Error> {
    let (_directory, root, mut authority, handle) = db3_root_fixture(Db3ListingKind::Database);
    let original =
        directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?;
    let Db3RootHandle::Database(database_root) = &handle else {
        return Err(Error::Conflict("test database root missing".into()));
    };
    let template = authority
        .persistent
        .get(&database_root.path_ref().id)
        .cloned()
        .ok_or_else(|| Error::Conflict("test root missing".into()))?;
    for index in authority.persistent.len()..MAX_AUTHORITY_IDS {
        let mut entry = template.clone();
        entry.stored.id.id = format!("unrelated-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    require_durable(authority.save()?)?;
    assert_eq!(
        directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?,
        original
    );
    fs::rename(root.join("a.db3"), root.with_extension("old-db3"))?;
    fs::write(root.join("a.db3"), b"replacement")?;
    let replacement =
        directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?;
    assert_ne!(replacement, original);
    assert_eq!(authority.persistent.len(), MAX_AUTHORITY_IDS);
    assert!(original
        .iter()
        .all(|id| !authority.persistent.contains_key(&id.id)));
    Ok(())
}

#[test]
fn listing_child_permission_is_unread_for_database_and_fatal_for_puzzle() {
    use std::os::unix::fs::PermissionsExt;
    for kind in [Db3ListingKind::Database, Db3ListingKind::Puzzle] {
        let (_directory, root, mut authority, handle) = db3_root_fixture(kind);
        let original =
            directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())
                .unwrap();
        let before = authority.persistent.clone();
        let disk = fs::read(&authority.registry_path).unwrap();
        fs::write(root.join("healthy.db3"), b"healthy").unwrap();
        fs::set_permissions(root.join("a.db3"), fs::Permissions::from_mode(0o000)).unwrap();
        match &handle {
            Db3RootHandle::Database(root_handle) => {
                let listing = authority
                    .list_database_children_cancellable(root_handle, &CancellationToken::new())
                    .unwrap();
                assert_eq!(listing.entries.len(), 1);
                assert_eq!(listing.entries[0].filename, "healthy.db3");
                assert_eq!(listing.unread.len(), 1);
                assert_eq!(listing.unread[0].category, ErrorCategory::Permission);
                assert!(authority.persistent.contains_key(&original[0].id));
                let payload = serde_json::to_value(listing).unwrap();
                assert!(payload["unread"][0].get("handle").is_none());
                assert!(payload["unread"][0].get("path").is_none());
                assert!(!payload.to_string().contains(root.to_str().unwrap()));
            }
            Db3RootHandle::Puzzle(root_handle) => {
                let error = authority
                    .list_puzzle_children_cancellable(root_handle, &CancellationToken::new())
                    .unwrap_err();
                assert_eq!(error.category(), ErrorCategory::Permission);
                assert!(authority.persistent == before);
                assert_eq!(fs::read(&authority.registry_path).unwrap(), disk);
            }
        }
        fs::set_permissions(root.join("a.db3"), fs::Permissions::from_mode(0o600)).unwrap();
    }
}

#[test]
fn listing_child_database_named_stat_permission_is_unread() {
    let (_directory, root, mut authority, handle) = db3_root_fixture(Db3ListingKind::Database);
    let Db3RootHandle::Database(root_handle) = handle else {
        unreachable!()
    };
    let before = authority
        .list_database_children_cancellable(&root_handle, &CancellationToken::new())
        .unwrap();
    let original = before.entries[0].handle.path_ref().clone();
    fs::write(root.join("healthy.db3"), b"healthy").unwrap();
    crate::infra::fs::set_listing_child_stat_hook(Some(Box::new(|name, kind| {
        (name == OsStr::new("a.db3")).then(|| (kind, std::io::ErrorKind::PermissionDenied.into()))
    })));
    let result =
        authority.list_database_children_cancellable(&root_handle, &CancellationToken::new());
    crate::infra::fs::set_listing_child_stat_hook(None);
    let listing = result.unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].filename, "healthy.db3");
    assert_eq!(listing.unread.len(), 1);
    assert_eq!(listing.unread[0].filename, "a.db3");
    assert_eq!(listing.unread[0].category, ErrorCategory::Permission);
    authority
        .resolve(&original, PathOperation::DatabaseRead, &[])
        .unwrap();
    let payload = serde_json::to_value(listing).unwrap();
    assert!(payload["unread"][0].get("handle").is_none());
    assert!(payload["unread"][0].get("path").is_none());
    assert!(!payload.to_string().contains(root.to_str().unwrap()));
}

#[cfg(not(target_os = "macos"))]
#[test]
fn listing_child_database_lossy_names_remain_distinct_without_paths() {
    use std::os::unix::{ffi::OsStringExt, fs::PermissionsExt};
    let (_directory, root, mut authority, handle) = db3_root_fixture(Db3ListingKind::Database);
    let Db3RootHandle::Database(root_handle) = handle else {
        unreachable!()
    };
    let names = [
        OsString::from_vec(b"\x80.db3".to_vec()),
        OsString::from_vec(b"\x81.db3".to_vec()),
    ];
    for name in &names {
        fs::write(root.join(name), b"db").unwrap();
        fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o000)).unwrap();
    }
    let listing = authority
        .list_database_children_cancellable(&root_handle, &CancellationToken::new())
        .unwrap();
    for name in &names {
        fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o600)).unwrap();
    }
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.unread.len(), 2);
    assert_eq!(listing.unread[0].filename, listing.unread[1].filename);
    let payload = serde_json::to_value(listing).unwrap();
    assert!(payload["unread"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row.as_object().unwrap().len() == 2));
}

#[test]
fn directory_listing_bound_puzzle_identity_change_mints_a_fresh_capability() -> Result<(), Error> {
    let (_directory, root, mut authority, handle) = db3_root_fixture(Db3ListingKind::Puzzle);
    fs::write(root.join("removed.db3"), b"old")?;
    let original =
        directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?;
    fs::remove_file(root.join("removed.db3"))?;
    fs::rename(root.join("a.db3"), root.with_extension("old-db3"))?;
    fs::write(root.join("a.db3"), b"replacement")?;
    let replacement =
        directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?;
    assert_eq!(replacement.len(), 1);
    assert_ne!(replacement, original);
    assert!(original
        .iter()
        .all(|id| !authority.persistent.contains_key(&id.id)));
    authority.resolve(&replacement[0], PathOperation::PuzzleRead, &[])?;
    Ok(())
}

#[test]
fn directory_listing_bound_database_and_puzzle_cancellation_preserves_previous_snapshot(
) -> Result<(), Error> {
    for kind in [Db3ListingKind::Database, Db3ListingKind::Puzzle] {
        let (_directory, root, mut authority, handle) = db3_root_fixture(kind);
        fs::write(root.join("removed.db3"), b"old")?;
        directory_listing_bound_list_db3(&mut authority, &handle, &CancellationToken::new())?;
        fs::remove_file(root.join("removed.db3"))?;
        fs::write(root.join("b.db3"), b"new")?;
        let before = authority.persistent.clone();
        let token = CancellationToken::new();
        let cancel = token.clone();
        let hook: Box<dyn FnOnce()> = Box::new(move || cancel.cancel());
        match kind {
            Db3ListingKind::Database => {
                DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| *slot.borrow_mut() = Some(hook))
            }
            Db3ListingKind::Puzzle => {
                PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| *slot.borrow_mut() = Some(hook))
            }
        }
        let result = directory_listing_bound_list_db3(&mut authority, &handle, &token);
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| *slot.borrow_mut() = None);
        PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| *slot.borrow_mut() = None);
        assert!(matches!(result, Err(Error::Cancellation)));
        assert!(authority.persistent == before);
    }
    Ok(())
}

fn db3_root_fixture(
    kind: Db3ListingKind,
) -> (tempfile::TempDir, PathBuf, PathAuthority, Db3RootHandle) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join(match kind {
        Db3ListingKind::Database => "databases",
        Db3ListingKind::Puzzle => "puzzles",
    });
    fs::create_dir(&root).unwrap();
    fs::write(root.join("a.db3"), b"old").unwrap();
    let mut authority = PathAuthority::open_with_clock(
        directory.path().join("registry.json"),
        vec![],
        std::sync::Arc::new(SystemClock),
        2,
    )
    .unwrap();
    let root_handle = match kind {
        Db3ListingKind::Database => Db3RootHandle::Database(
            authority
                .get_or_create_database_root(&root, "Databases", None)
                .unwrap(),
        ),
        Db3ListingKind::Puzzle => Db3RootHandle::Puzzle(
            authority
                .get_or_create_puzzle_root(&root, "Puzzles", None)
                .unwrap(),
        ),
    };
    (directory, root, authority, root_handle)
}

fn assert_db3_listing_refuses_replacement(kind: Db3ListingKind, replacement_kind: Db3Replacement) {
    let (_directory, root, mut authority, root_handle) = db3_root_fixture(kind);
    let child = root.join("a.db3");
    let before = authority.persistent_snapshot_for_test();
    let child_for_hook = child.clone();
    set_capability_directory_post_entries_hook(Some(Box::new(move || match replacement_kind {
        Db3Replacement::RegularFile => {
            let replacement = child_for_hook.with_extension("replacement");
            fs::write(&replacement, b"replacement").unwrap();
            fs::rename(&replacement, &child_for_hook).unwrap();
        }
        Db3Replacement::Directory => {
            fs::rename(&child_for_hook, child_for_hook.with_extension("old")).unwrap();
            fs::create_dir(&child_for_hook).unwrap();
        }
    })));
    let result = match root_handle {
        Db3RootHandle::Database(root) => authority
            .list_database_children_cancellable(&root, &CancellationToken::new())
            .map(|_| ()),
        Db3RootHandle::Puzzle(root) => authority
            .list_puzzle_children_cancellable(&root, &CancellationToken::new())
            .map(|_| ()),
    };
    set_capability_directory_post_entries_hook(None);
    assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
    assert_eq!(authority.persistent_snapshot_for_test(), before);
}

#[test]
fn database_listing_refuses_a_db3_replaced_after_enumeration() {
    assert_db3_listing_refuses_replacement(Db3ListingKind::Database, Db3Replacement::RegularFile);
}

#[test]
fn puzzle_listing_refuses_a_db3_replaced_after_enumeration() {
    assert_db3_listing_refuses_replacement(Db3ListingKind::Puzzle, Db3Replacement::RegularFile);
}

#[test]
fn database_listing_refuses_a_db3_replaced_by_a_directory() {
    assert_db3_listing_refuses_replacement(Db3ListingKind::Database, Db3Replacement::Directory);
}

#[test]
fn enumeration_consumers_use_no_direct_pathname_producer() {
    let sources = [
        (
            include_str!("mod.rs"),
            concat!("fn map_db3_children_cancellable", "<T>("),
        ),
        (
            super::test_source_files::production_source(),
            concat!("pub(crate) fn open_child_directory(", "\n        &self"),
        ),
        (
            super::test_source_files::production_source(),
            concat!("pub(crate) fn confirm_entry", "(&self"),
        ),
        (
            super::test_source_files::production_source(),
            concat!("pub(crate) fn open_metadata_sidecar(", "\n        &self"),
        ),
        (
            include_str!("../fs.rs"),
            concat!("pub(crate) fn read_directory_entries_at(", "\n    dir:"),
        ),
        (
            include_str!("../../file_workspace.rs"),
            concat!("fn collect_tree_entries(", "\n    pgn_path_authority"),
        ),
        (
            include_str!("../../file_workspace.rs"),
            concat!("fn metadata_from(", "\n    directory"),
        ),
    ];
    let forbidden = [
        "Path::",
        "&Path",
        "PathBuf",
        "std::fs",
        "fs::metadata(",
        "fs::read(",
        "File::open",
        "OpenOptions",
        "timestamp(",
        "workspace_root(",
        "workspace_components(",
        "canonicalize",
        ".exists(",
        ".is_file(",
        ".is_dir(",
        "symlink_metadata",
        "read_dir(",
    ];
    for (source, signature) in sources {
        let body = body_at_indent(source, signature);
        for token in forbidden {
            if signature.starts_with("fn map_db3") && token == "Path::" {
                assert_eq!(body.matches(token).count(), 1);
            } else {
                assert!(!body.contains(token), "{signature} contains {token}");
            }
        }
    }
}

#[test]
fn database_and_puzzle_listing_skip_symlinked_and_non_db3_and_keep_order() {
    #[cfg(not(target_os = "macos"))]
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::symlink;
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("databases");
    let puzzle_path = directory.path().join("puzzles");
    fs::create_dir(&database_path).unwrap();
    fs::create_dir(&puzzle_path).unwrap();
    for root in [&database_path, &puzzle_path] {
        fs::write(root.join("b.db3"), b"b").unwrap();
        fs::write(root.join("a.db3"), b"a").unwrap();
        fs::write(root.join("C.db3"), b"C").unwrap();
        // APFS cannot store non-UTF-8 file names
        #[cfg(not(target_os = "macos"))]
        {
            let first = OsString::from_vec(b"\x81.db3".to_vec());
            let second = OsString::from_vec(b"\x80_.db3".to_vec());
            fs::write(root.join(&first), b"first").unwrap();
            fs::write(root.join(&second), b"second").unwrap();
            let raw_cmp = first.as_bytes().cmp(second.as_bytes());
            let lossy_cmp = first.to_string_lossy().cmp(&second.to_string_lossy());
            assert_ne!(raw_cmp, lossy_cmp);
        }
        fs::write(root.join("notes.txt"), b"notes").unwrap();
        symlink(root.join("a.db3"), root.join("d.db3")).unwrap();
    }
    let mut authority = PathAuthority::open_with_clock(
        directory.path().join("registry.json"),
        vec![],
        std::sync::Arc::new(SystemClock),
        2,
    )
    .unwrap();
    let database = authority
        .get_or_create_database_root(&database_path, "Databases", None)
        .unwrap();
    let puzzle = authority
        .get_or_create_puzzle_root(&puzzle_path, "Puzzles", None)
        .unwrap();
    let databases = authority
        .list_database_children_cancellable(&database, &CancellationToken::new())
        .unwrap();
    let puzzles = authority
        .list_puzzle_children_cancellable(&puzzle, &CancellationToken::new())
        .unwrap();
    // APFS cannot store non-UTF-8 file names
    #[cfg(not(target_os = "macos"))]
    let expected = ["C.db3", "a.db3", "b.db3", "�.db3", "�_.db3"];
    #[cfg(target_os = "macos")]
    let expected = ["C.db3", "a.db3", "b.db3"];
    assert_eq!(
        databases
            .entries
            .iter()
            .map(|entry| entry.filename.as_str())
            .collect::<Vec<_>>(),
        expected
    );
    assert_eq!(
        puzzles
            .iter()
            .map(|entry| entry.filename.as_str())
            .collect::<Vec<_>>(),
        expected
    );
    let database_parent = authority
        .capability_directory(database.path_ref(), PathOperation::DatabaseRead)
        .unwrap()
        .identity()
        .unwrap();
    let puzzle_parent = authority
        .capability_directory(puzzle.path_ref(), PathOperation::PuzzleRead)
        .unwrap()
        .identity()
        .unwrap();
    for entry in &databases.entries {
        assert_eq!(
            authority.parent_identity_for_test(entry.handle.path_ref()),
            Some(database_parent)
        );
        assert!(authority
            .resolve(entry.handle.path_ref(), PathOperation::DatabaseRead, &[])
            .is_ok());
    }
    for entry in &puzzles {
        assert_eq!(
            authority.parent_identity_for_test(&entry.file),
            Some(puzzle_parent)
        );
        assert!(authority
            .resolve(&entry.file, PathOperation::PuzzleRead, &[])
            .is_ok());
    }
}

#[test]
fn database_listing_cancels_after_an_empty_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("databases");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("notes.txt"), b"notes").unwrap();
    let mut authority = PathAuthority::open_with_clock(
        directory.path().join("registry.json"),
        vec![],
        std::sync::Arc::new(SystemClock),
        2,
    )
    .unwrap();
    let root_handle = authority
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap();
    let token = CancellationToken::new();
    let cancel = token.clone();
    set_capability_directory_post_entries_hook(Some(Box::new(move || cancel.cancel())));
    let result = authority.list_database_children_cancellable(&root_handle, &token);
    set_capability_directory_post_entries_hook(None);
    assert!(matches!(result, Err(Error::Cancellation)), "{result:?}");
}

#[test]
fn capability_directory_methods_refuse_non_leaf_names() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("safe"), b"safe").unwrap();
    let sibling = directory.path().join("sibling");
    fs::write(&sibling, b"untouched").unwrap();
    let (_registry, mut authority, id) = root_fixture(&root);
    let capability = authority
        .capability_directory(&id, PathOperation::ReadPgn)
        .unwrap();
    let regular = DirectoryEntry {
        name: OsString::from("safe"),
        kind: DirectoryEntryKind::RegularFile,
        identity: (0, 0),
        modified_seconds: 0,
    };
    assert!(matches!(
        capability.open_child_directory(&regular),
        Err(Error::InvalidInput(_))
    ));
    for name in ["..", "a/b", "/abs", ""] {
        let entry = DirectoryEntry {
            name: OsString::from(name),
            kind: DirectoryEntryKind::RegularFile,
            identity: (0, 0),
            modified_seconds: 0,
        };
        assert!(matches!(
            capability.open_child_directory(&entry),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(
            capability.confirm_entry(&entry),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(
            capability.open_metadata_sidecar(&entry),
            Err(Error::InvalidInput(_))
        ));
    }
    assert_eq!(fs::read(sibling).unwrap(), b"untouched");
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_root_initialization_holds_a_private_locked_instance() {
    use std::os::unix::fs::PermissionsExt;

    let directory = tempfile::tempdir().unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let instance = root.instance_path();
    let launch_dir = instance.parent().unwrap();
    let lock = launch_dir
        .read_dir()
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension == "lock")
        })
        .unwrap();
    assert_eq!(
        launch_dir.metadata().unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        instance.metadata().unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        lock.metadata().unwrap().permissions().mode() & 0o777,
        ENGINE_LAUNCH_LOCK_MODE
    );

    let competing = std::fs::File::open(lock).unwrap();
    assert!(matches!(
        rustix::fs::flock(
            &competing,
            rustix::fs::FlockOperation::NonBlockingLockExclusive
        ),
        Err(error)
            if error == rustix::io::Errno::AGAIN
                || error == rustix::io::Errno::WOULDBLOCK
    ));
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_lock_is_locked_before_a_competing_sweep() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    let directory = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(directory.path());
    let ran = Arc::new(AtomicBool::new(false));
    let ran_in_hook = ran.clone();
    set_engine_launch_lock_created_hook(Some(Box::new(move || {
        ran_in_hook.store(true, Ordering::SeqCst);
        let root =
            ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::EngineLaunch).unwrap();
        assert!(!root.path().read_dir().unwrap().any(|entry| entry
            .unwrap()
            .file_type()
            .unwrap()
            .is_dir()));
        sweep_engine_launch_root(&root, OsStr::new("not-own.lock"), OsStr::new("not-own")).unwrap();
    })));
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    set_engine_launch_lock_created_hook(None);

    assert!(ran.load(Ordering::SeqCst));
    assert!(root.instance_path().is_dir());
    assert!(root
        .instance_path()
        .parent()
        .unwrap()
        .read_dir()
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|extension| extension == "lock")));
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_sweep_reclaims_only_unowned_siblings() {
    let directory = tempfile::tempdir().unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let instance = root.instance_path();
    let launch_dir = instance.parent().unwrap();
    let own_id = instance.file_name().unwrap().to_os_string();
    let own_lock = OsString::from(format!("{}.lock", own_id.to_string_lossy()));

    let free_id = OsString::from("free-sibling");
    fs::create_dir(launch_dir.join(&free_id)).unwrap();
    fs::write(launch_dir.join(&free_id).join("payload"), b"payload").unwrap();
    fs::write(
        launch_dir.join(format!("{}.lock", free_id.to_string_lossy())),
        b"",
    )
    .unwrap();

    let held_id = OsString::from("held-sibling");
    fs::create_dir(launch_dir.join(&held_id)).unwrap();
    let held_lock_path = launch_dir.join(format!("{}.lock", held_id.to_string_lossy()));
    fs::write(&held_lock_path, b"").unwrap();
    let held_lock = std::fs::File::open(&held_lock_path).unwrap();
    rustix::fs::flock(&held_lock, rustix::fs::FlockOperation::LockExclusive).unwrap();

    let orphan_dir = OsString::from("orphan-directory");
    fs::create_dir(launch_dir.join(&orphan_dir)).unwrap();
    let orphan_lock = OsString::from("orphan-lock");
    fs::write(
        launch_dir.join(format!("{}.lock", orphan_lock.to_string_lossy())),
        b"",
    )
    .unwrap();

    let root_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(directory.path()),
        AppOwnedDefaultRoot::EngineLaunch,
    )
    .unwrap();
    sweep_engine_launch_root(&root_dir, &own_lock, &own_id).unwrap();

    assert!(!launch_dir.join(&free_id).exists());
    assert!(!launch_dir
        .join(format!("{}.lock", free_id.to_string_lossy()))
        .exists());
    assert!(launch_dir.join(&held_id).exists());
    assert!(held_lock_path.exists());
    assert!(!launch_dir.join(&orphan_dir).exists());
    assert!(!launch_dir
        .join(format!("{}.lock", orphan_lock.to_string_lossy()))
        .exists());
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_materialization_uses_the_held_source_descriptor() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source");
    fs::write(&source_path, b"authorized").unwrap();
    let source = fs::File::open(&source_path).unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let mut leaf = root
        .reserve_leaves(1, "test:engine", "engine-id")
        .unwrap()
        .pop()
        .unwrap();

    fs::rename(&source_path, directory.path().join("source-original")).unwrap();
    fs::write(&source_path, b"replacement").unwrap();
    leaf.create_from(&source, ENGINE_RESOURCE_LEAF_MODE, &|| false)
        .unwrap();
    assert_eq!(fs::read(leaf.path()).unwrap(), b"authorized");
    drop(leaf);
    let report = root.reclaim();
    assert_eq!(report.removed, 1);
    assert!(report.failed.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_clone_seam_runs_after_descriptor_acquisition() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source");
    fs::write(&source_path, b"authorized").unwrap();
    let source = fs::File::open(&source_path).unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let mut leaf = root
        .reserve_leaves(1, "test:engine", "engine-id")
        .unwrap()
        .pop()
        .unwrap();
    let replacement = source_path.clone();
    let swapped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let swapped_in_hook = swapped.clone();
    set_engine_launch_before_clone_hook(
        "test:engine",
        Some(Box::new(move || {
            fs::rename(&replacement, replacement.with_extension("original")).unwrap();
            fs::write(&replacement, b"replacement").unwrap();
            swapped_in_hook.store(true, std::sync::atomic::Ordering::SeqCst);
        })),
    );
    leaf.create_from(&source, ENGINE_RESOURCE_LEAF_MODE, &|| false)
        .unwrap();
    set_engine_launch_before_clone_hook("test:engine", None);
    // The descriptor was opened before the swap, so the bytes below read `authorized`
    // whether or not the hook fired. Without this the test proves nothing about the seam.
    assert!(
        swapped.load(std::sync::atomic::Ordering::SeqCst),
        "the before-clone hook armed for test:engine never ran, so no swap was staged"
    );
    assert_eq!(fs::read(leaf.path()).unwrap(), b"authorized");
    drop(leaf);
    assert_eq!(root.reclaim().removed, 1);
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_reservation_counts_overlapping_leaves() {
    let directory = tempfile::tempdir().unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let first = root.reserve_leaves(64, "test:first", "first").unwrap();
    assert!(matches!(
        root.reserve_leaves(1, "test:second", "second"),
        Err(Error::ResourceLimit(message)) if message == "engine launch leaf limit reached"
    ));
    assert_eq!(root.registry_snapshot_for_test().0, 64);
    drop(first);
    assert_eq!(root.registry_snapshot_for_test().0, 0);
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_clone_fallback_exdev_and_enotsup_preserve_authorized_bytes() {
    use std::os::unix::fs::PermissionsExt;

    for failure in [
        EngineLaunchFailure::CloneExdev,
        EngineLaunchFailure::CloneEnotsup,
    ] {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source");
        fs::write(&source_path, b"authorized-fallback-bytes").unwrap();
        fs::set_permissions(&source_path, fs::Permissions::from_mode(0o444)).unwrap();
        let source = fs::File::open(&source_path).unwrap();
        let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut leaf = root
            .reserve_leaves(1, "test:fallback", "fallback-engine")
            .unwrap()
            .pop()
            .unwrap();
        set_engine_launch_failure("test:fallback", Some(failure));
        leaf.create_from(&source, ENGINE_RESOURCE_LEAF_MODE, &|| false)
            .unwrap();
        // An unconsumed injection means the clone simply succeeded, and the assertions
        // below would then pass without the fallback ever being exercised.
        assert!(
            ENGINE_LAUNCH_FAILURES
                .take(&"test:fallback".to_owned())
                .is_none(),
            "the injected {failure:?} was never consumed, so no fallback was exercised"
        );
        assert_eq!(fs::read(leaf.path()).unwrap(), b"authorized-fallback-bytes");
        assert_eq!(
            fs::metadata(leaf.path()).unwrap().permissions().mode() & 0o777,
            ENGINE_RESOURCE_LEAF_MODE
        );
        drop(leaf);
        assert_eq!(root.reclaim().removed, 1);
    }
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_removes_entries_after_copy_fchmod_and_cancellation_failures() {
    fn run_failure(failure: EngineLaunchFailure, cancelled: impl Fn() -> bool) {
        let directory = tempfile::tempdir().unwrap();
        let source_path = directory.path().join("source");
        fs::write(&source_path, vec![b'x'; 128 * 1024]).unwrap();
        let source = fs::File::open(&source_path).unwrap();
        let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
        let mut leaf = root
            .reserve_leaves(1, "test:failure", "failure-engine")
            .unwrap()
            .pop()
            .unwrap();
        set_engine_launch_failure("test:failure", Some(failure));
        let result = leaf.create_from(&source, ENGINE_RESOURCE_LEAF_MODE, &cancelled);
        assert!(
            ENGINE_LAUNCH_FAILURES
                .take(&"test:failure".to_owned())
                .is_none(),
            "the injected {failure:?} was never consumed, so no failure path was exercised"
        );
        match (failure, result) {
            (EngineLaunchFailure::Copy, Err(Error::Io(error))) => assert!(error
                .to_string()
                .contains("injected engine launch copy failure")),
            (EngineLaunchFailure::Fchmod, Err(Error::Io(error))) => assert!(error
                .to_string()
                .contains("injected engine launch fchmod failure")),
            (EngineLaunchFailure::CloneExdev, Err(Error::Cancellation)) => {}
            (failure, result) => {
                panic!("unexpected engine launch failure result for {failure:?}: {result:?}")
            }
        }
        assert!(
            leaf.path().exists(),
            "the failed materialization must have created its leaf before cleanup"
        );
        assert!(leaf.remove().is_ok());
        assert_eq!(root.registry_snapshot_for_test().0, 0);
        assert!(root.instance_path().read_dir().unwrap().next().is_none());
    }

    run_failure(EngineLaunchFailure::Copy, || false);
    run_failure(EngineLaunchFailure::Fchmod, || false);
    let checks = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let checks_for_cancel = checks.clone();
    run_failure(EngineLaunchFailure::CloneExdev, move || {
        checks_for_cancel.fetch_add(1, std::sync::atomic::Ordering::SeqCst) >= 2
    });
}

#[cfg(target_os = "macos")]
#[test]
fn dropping_an_engine_launch_leaf_only_registers_it_for_later_reclaim() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source");
    fs::write(&source_path, b"bytes").unwrap();
    let source = fs::File::open(&source_path).unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let mut leaf = root
        .reserve_leaves(1, "test:drop", "drop-engine")
        .unwrap()
        .pop()
        .unwrap();
    leaf.create_from(&source, ENGINE_RESOURCE_LEAF_MODE, &|| false)
        .unwrap();
    let path = leaf.path();
    drop(leaf);
    assert!(path.exists());
    let (live, released) = root.registry_snapshot_for_test();
    assert_eq!(live, 1);
    assert_eq!(released.len(), 1);
    assert_eq!(released[0].engine_key, "test:drop");
    assert_eq!(released[0].engine_id, "drop-engine");
    assert_eq!(root.reclaim().removed, 1);
    assert!(!path.exists());
}

#[cfg(target_os = "macos")]
#[test]
fn apple_engine_launch_retries_failed_reclaim_and_keeps_the_cap() {
    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source");
    fs::write(&source_path, b"bytes").unwrap();
    let source = fs::File::open(&source_path).unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let mut leaf = root
        .reserve_leaves(1, "test:retry", "retry-engine")
        .unwrap()
        .pop()
        .unwrap();
    leaf.create_from(&source, ENGINE_RESOURCE_LEAF_MODE, &|| false)
        .unwrap();
    drop(leaf);
    crate::infra::fs::set_test_removal_injector(Some(Arc::new(crate::infra::fs::RemovalFault(
        crate::infra::fs::RemovalFaultPoint::BeforeTopOpen,
    ))));
    let report = root.reclaim();
    crate::infra::fs::set_test_removal_injector(None);
    assert_eq!(report.failed.len(), 1);
    assert_eq!(root.registry_snapshot_for_test().0, 1);
    assert!(matches!(
        root.reserve_leaves(64, "test:overflow", "overflow-engine"),
        Err(Error::ResourceLimit(message)) if message == "engine launch leaf limit reached"
    ));
    assert_eq!(root.reclaim().removed, 1);
    assert_eq!(root.registry_snapshot_for_test().0, 0);
}

#[cfg(target_os = "macos")]
#[test]
fn two_overlapping_engine_launches_are_bounded_to_one_success() {
    use std::sync::{Arc, Barrier};
    let directory = tempfile::tempdir().unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let start_barrier = Arc::new(Barrier::new(3));
    let attempted_barrier = Arc::new(Barrier::new(3));
    let results = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut threads = Vec::new();
    for index in 0..2 {
        let root = root.clone();
        let start_barrier = start_barrier.clone();
        let attempted_barrier = attempted_barrier.clone();
        let results = results.clone();
        threads.push(std::thread::spawn(move || {
            start_barrier.wait();
            let mut attempted_wait = false;
            let worker_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let result = root.reserve_leaves(33, &format!("test:{index}"), "bounded");
                let outcome = match &result {
                    Ok(_) => Ok(()),
                    Err(Error::ResourceLimit(message)) => Err(message.clone()),
                    Err(error) => Err(format!("unexpected: {error}")),
                };
                results.lock().unwrap().push(outcome);
                attempted_wait = true;
                attempted_barrier.wait();
                drop(result);
            }));
            if worker_result.is_err() && !attempted_wait {
                attempted_barrier.wait();
            }
            worker_result
        }));
    }
    start_barrier.wait();
    attempted_barrier.wait();
    for thread in threads {
        let worker_result = thread
            .join()
            .unwrap_or_else(|_| panic!("reservation worker panicked"));
        assert!(
            worker_result.is_ok(),
            "reservation worker panicked before reaching the attempt barrier"
        );
    }
    let results = results.lock().unwrap().clone();
    assert_eq!(results.iter().filter(|outcome| outcome.is_ok()).count(), 1);
    let failures: Vec<_> = results
        .iter()
        .filter_map(|outcome| outcome.as_ref().err())
        .collect();
    assert_eq!(failures.len(), 1);
    assert_eq!(failures[0], "engine launch leaf limit reached");
    assert_eq!(root.registry_snapshot_for_test().0, 0);
}

#[cfg(target_os = "macos")]
#[test]
fn poisoned_engine_launch_registry_preserves_drop_and_reclaim_accounting() {
    use std::panic::AssertUnwindSafe;

    let directory = tempfile::tempdir().unwrap();
    let source_path = directory.path().join("source");
    fs::write(&source_path, b"released").unwrap();
    let root = EngineLaunchRoot::for_test(directory.path()).unwrap();
    let mut leaf = root
        .reserve_leaves(1, "test:poisoned", "poisoned-engine")
        .unwrap()
        .pop()
        .unwrap();
    leaf.create_from(
        &fs::File::open(&source_path).unwrap(),
        ENGINE_RESOURCE_LEAF_MODE,
        &|| false,
    )
    .unwrap();

    let poisoned = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _registry = root.inner.registry.lock().unwrap();
        panic!("poison the engine launch registry");
    }));
    assert!(poisoned.is_err());
    drop(leaf);
    assert_eq!(root.registry_snapshot_for_test().0, 1);
    assert_eq!(root.registry_snapshot_for_test().1.len(), 1);
    let report = root.reclaim();
    assert_eq!(report.removed, 1);
    assert_eq!(root.registry_snapshot_for_test().0, 0);
    assert!(root.registry_snapshot_for_test().1.is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn unpinned_file_resource_value_construction_is_a_typed_conflict() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    fs::write(&source, b"resource").unwrap();
    let lease = EngineResourceLease::test_file(fs::File::open(&source).unwrap());
    assert!(matches!(
        lease.uci_value(),
        Err(Error::Conflict(message))
            if message == "engine file resource was not pinned before value construction"
    ));
}
