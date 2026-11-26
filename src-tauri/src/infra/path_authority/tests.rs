use super::database_test_support::replace_parent_with_same_inode_hard_link;
use super::portable_tests::{
    active_app_owned_test_root, authority, authority_at, get_or_create_app_owned_test_root,
    set_active_app_owned_test_root, TestClock,
};
use super::resolved::file_identity;
use super::*;
use crate::infra::blocking::source_scan::body_at_indent;
use crate::infra::fs::{
    set_test_atomic_file_injector, AtomicFileFaultPoint, AtomicInstalledFile, AtomicWriterInjector,
};
#[cfg(unix)]
use crate::infra::fs::{set_test_removal_injector, RemovalFault, RemovalFaultPoint};
use std::{
    os::unix::ffi::OsStringExt,
    sync::{atomic::Ordering, Mutex},
};

static CURRENT_DIR_TEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(unix)]
fn observed_identity(path: &Path) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    let metadata = fs::symlink_metadata(path).unwrap();
    (metadata.dev(), metadata.ino())
}

const _: fn(VerifiedFile, u64, usize) -> Result<Vec<u8>, Error> = read_engine_image_bytes;

enum SwapReplacement {
    Symlink,
    File,
    Directory,
    Removed,
}

enum SwapHookCleanup {
    Root,
    Directory,
    DatabaseChild,
}

impl Drop for SwapHookCleanup {
    fn drop(&mut self) {
        match self {
            Self::Root => RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow_mut().take()),
            Self::Directory => {
                RESOLVE_PRE_DIRECTORY_OPEN_HOOK.with(|slot| slot.borrow_mut().take())
            }
            Self::DatabaseChild => {
                DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| slot.borrow_mut().take())
            }
        };
    }
}

fn install_swap_replacement(path: &Path, symlink_target: &Path, swap: SwapReplacement) {
    match swap {
        SwapReplacement::Symlink => std::os::unix::fs::symlink(symlink_target, path).unwrap(),
        SwapReplacement::File => fs::write(path, b"replacement").unwrap(),
        SwapReplacement::Directory => fs::create_dir(path).unwrap(),
        SwapReplacement::Removed => {}
    }
}

enum DirectoryOpenBoundary {
    Root,
    FileParent,
    Component,
}

fn assert_directory_open_swap(boundary: DirectoryOpenBoundary, swap: SwapReplacement) {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    let retained = dir.path().join("retained");
    let symlink_target = dir.path().join("elsewhere");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(&symlink_target).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let (id, operation, components, swap_path) = match boundary {
        DirectoryOpenBoundary::FileParent => {
            let book_path = root_path.join("book.bin");
            fs::write(&book_path, b"book").unwrap();
            let book = authority.register_opening_book(&book_path, "book").unwrap();
            (
                book.path_ref().clone(),
                PathOperation::OpeningBookRead,
                vec![],
                root_path,
            )
        }
        DirectoryOpenBoundary::Root | DirectoryOpenBoundary::Component => {
            let root = authority
                .get_or_create_database_root(&root_path, "root", None)
                .unwrap();
            let (components, swap_path) = if matches!(boundary, DirectoryOpenBoundary::Component) {
                let child = root_path.join("child");
                fs::create_dir(&child).unwrap();
                (vec![OsString::from("child")], child)
            } else {
                (vec![], root_path)
            };
            (
                root.path_ref().clone(),
                PathOperation::DatabaseRead,
                components,
                swap_path,
            )
        }
    };
    let hook: Box<dyn FnOnce()> = Box::new(move || {
        if matches!(boundary, DirectoryOpenBoundary::FileParent) {
            fs::rename(&swap_path, retained).unwrap();
        } else {
            fs::remove_dir(&swap_path).unwrap();
        }
        install_swap_replacement(&swap_path, &symlink_target, swap);
    });
    let component = !components.is_empty();
    let cleanup = if component {
        let cleanup = SwapHookCleanup::Directory;
        RESOLVE_PRE_DIRECTORY_OPEN_HOOK.with(|slot| {
            assert!(slot.replace(Some(hook)).is_none());
        });
        cleanup
    } else {
        let cleanup = SwapHookCleanup::Root;
        RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
            assert!(slot.replace(Some(hook)).is_none());
        });
        cleanup
    };
    let result = authority.resolve(&id, operation, &components);
    assert!(
        matches!(&result, Err(Error::Conflict(message)) if message == if component {
            "directory changed while resolving"
        } else {
            "path authority is unavailable because its object changed"
        }),
        "unexpected resolution: {:?}",
        result.err()
    );
    drop(cleanup);
}

#[test]
fn directory_root_open_symlink_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::Root, SwapReplacement::Symlink);
}

#[test]
fn directory_root_open_enotdir_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::Root, SwapReplacement::File);
}

#[test]
fn directory_root_open_enoent_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::Root, SwapReplacement::Removed);
}

#[test]
fn file_parent_open_symlink_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::FileParent, SwapReplacement::Symlink);
}

#[test]
fn file_parent_open_enotdir_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::FileParent, SwapReplacement::File);
}

#[test]
fn file_parent_open_enoent_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::FileParent, SwapReplacement::Removed);
}

#[test]
fn directory_component_open_symlink_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::Component, SwapReplacement::Symlink);
}

#[test]
fn directory_component_open_enotdir_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::Component, SwapReplacement::File);
}

#[test]
fn directory_component_open_enoent_is_conflict() {
    assert_directory_open_swap(DirectoryOpenBoundary::Component, SwapReplacement::Removed);
}

#[test]
fn directory_root_open_eacces_stays_io() {
    use std::os::unix::fs::PermissionsExt;

    struct RestorePermissions(PathBuf);
    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "root", None)
        .unwrap();
    let restore = RestorePermissions(root_path.clone());
    let cleanup = SwapHookCleanup::Root;
    RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::set_permissions(&root_path, fs::Permissions::from_mode(0o000)).unwrap();
            })))
            .is_none());
    });
    let result = authority.resolve(root.path_ref(), PathOperation::DatabaseRead, &[]);
    assert!(
        matches!(&result, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::PermissionDenied),
        "unexpected resolution: {:?}",
        result.err()
    );
    drop(cleanup);
    drop(restore);
}

fn assert_database_child_swap(swap: SwapReplacement) {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let child = root_path.join("child.db3");
    let symlink_target = dir.path().join("target.db3");
    fs::write(&child, b"original").unwrap();
    fs::write(&symlink_target, b"target").unwrap();
    let original_identity = observed_identity(&child);
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let before = authority.persistent.len();
    let cleanup = SwapHookCleanup::DatabaseChild;
    DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::remove_file(&child).unwrap();
                install_swap_replacement(&child, &symlink_target, swap);
            })))
            .is_none());
    });
    let result = authority.register_database_child(
        &root,
        OsStr::new("child.db3"),
        "child.db3",
        original_identity,
    );
    assert!(
        matches!(&result, Err(Error::Conflict(message)) if message == VERIFIED_REGISTRATION_CONFLICT),
        "unexpected registration: {result:?}"
    );
    assert_eq!(authority.persistent.len(), before);
    assert!(!authority
        .persistent
        .values()
        .any(|entry| { entry.stored.purpose == Some(EntryPurpose::DatabaseFile) }));
    drop(cleanup);
}

#[test]
fn register_database_child_directory_swap_is_conflict() {
    assert_database_child_swap(SwapReplacement::Directory);
}

#[test]
fn register_database_child_symlink_swap_is_conflict() {
    assert_database_child_swap(SwapReplacement::Symlink);
}

#[test]
fn register_database_child_removal_is_conflict() {
    assert_database_child_swap(SwapReplacement::Removed);
}

#[test]
fn staged_hash_core_cancels_between_real_read_chunks() {
    struct HeldReader {
        entered: Option<std::sync::mpsc::SyncSender<()>>,
        release: std::sync::mpsc::Receiver<()>,
        finished: bool,
    }
    impl Read for HeldReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.finished {
                return Ok(0);
            }
            self.finished = true;
            if let Some(entered) = self.entered.take() {
                let _ = entered.send(());
            }
            let _ = self.release.recv_timeout(Duration::from_secs(5));
            buffer[..64].fill(7);
            Ok(64)
        }
    }

    let cancellation = tokio_util::sync::CancellationToken::new();
    let worker_cancellation = cancellation.clone();
    let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        sha256_reader_cancellable(
            &mut HeldReader {
                entered: Some(entered_tx),
                release: release_rx,
                finished: false,
            },
            &worker_cancellation,
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    cancellation.cancel();
    release_tx.send(()).unwrap();
    assert!(matches!(worker.join().unwrap(), Err(Error::Cancellation)));
}

type EngineImageReaderForFn = fn(
    &crate::infra::path_authority::SharedPathAuthority,
    &EngineImageHandle,
    usize,
) -> Result<(VerifiedFile, u64), Error>;
type RegisterEngineImageFn = fn(
    &mut PathAuthority,
    &AuthorizedDir,
    &OsStr,
    VerifiedIdentity,
    String,
) -> Result<EngineImageHandle, Error>;
/// Compile-time arity pins for the engine-image split (`d-20260903-08`). A typed binding
/// inside a test body is what both the ordinary and the branch-coverage build count as a
/// use of the aliases; an anonymous `const _` did not, and inlining the types trips
/// `clippy::type_complexity`.
#[test]
fn engine_image_split_arities_are_pinned() {
    let _: EngineImageReaderForFn = engine_image_reader_for;
    let _: RegisterEngineImageFn = PathAuthority::register_engine_image;
}
fn registered_engine_image(
    dir: &tempfile::TempDir,
    contents: &[u8],
) -> (
    crate::infra::path_authority::SharedPathAuthority,
    EngineImageHandle,
    PathBuf,
) {
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = OsStr::new("image.png");
    let (_, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| file.write_all(contents).map_err(Error::from))
        .unwrap();
    let image = image_dir.path().join(leaf);
    let mut authority = authority(dir, Arc::new(TestClock::new(0)));
    let handle = authority
        .register_engine_image(&image_dir, leaf, installed, "image".into())
        .expect("adopted image handle");
    (
        crate::infra::path_authority::SharedPathAuthority::installed(authority),
        handle,
        image,
    )
}

#[cfg(unix)]
#[test]
fn resolved_path_identity_reads_the_descriptor_not_the_pathname() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine");
    let original = dir.path().join("engine-original");
    fs::write(&path, b"original").unwrap();
    let expected_parent = descriptor_parent_identity(&path);
    let original_identity = validate_target(&path, PathClass::PersistentFile).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let registered = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "engine",
            PathClass::PersistentFile,
            vec![PathOperation::EngineInstall],
        )
        .unwrap();
    assert_eq!(
        authority.parent_identity_for_test(&registered.id),
        Some((expected_parent.a, expected_parent.b))
    );
    let resolved = authority
        .resolve(&registered.id, PathOperation::EngineInstall, &[])
        .unwrap();

    fs::rename(&path, &original).unwrap();
    fs::write(&path, b"replacement").unwrap();
    let replacement_identity = validate_target(&path, PathClass::PersistentFile).unwrap();

    assert_ne!(original_identity, replacement_identity);
    assert_eq!(
        resolved.identity().unwrap().pair(),
        (original_identity.a, original_identity.b)
    );
}

#[cfg(unix)]
#[test]
fn engine_image_install_uses_the_authorized_directory_after_pathname_swap() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let image_dir =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::EngineImages).unwrap();
    let original = dir.path().join("engine-images-original");
    fs::rename(image_dir.path(), &original).unwrap();
    fs::create_dir(image_dir.path()).unwrap();

    image_dir
        .atomic_replace_leaf_identified(OsStr::new("image.png"), |file| {
            file.write_all(b"descriptor bytes").map_err(Error::from)
        })
        .unwrap()
        .0
        .expect_durable();

    assert_eq!(
        fs::read(original.join("image.png")).unwrap(),
        b"descriptor bytes"
    );
    assert_eq!(fs::read_dir(image_dir.path()).unwrap().count(), 0);
}

#[test]
fn engine_image_registration_stores_the_installed_identity() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = OsStr::new("image.png");
    let (_, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| file.write_all(b"image").map_err(Error::from))
        .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    let handle = authority
        .register_engine_image(&image_dir, leaf, installed, "image".into())
        .unwrap();
    let stored = &authority.persistent[&handle.id.id].stored.identity;

    assert_eq!((stored.a, stored.b), installed.pair());
    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some(image_dir.identity().pair())
    );
    assert!(authority
        .resolve(handle.path_ref(), PathOperation::ImageRead, &[])
        .is_ok());
}

#[cfg(unix)]
#[test]
fn engine_image_registration_refuses_a_swap_and_stores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = OsStr::new("image.png");
    let (_, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| {
            file.write_all(b"installed").map_err(Error::from)
        })
        .unwrap();
    let original = dir.path().join("engine-images-original");
    fs::rename(image_dir.path(), &original).unwrap();
    fs::create_dir(image_dir.path()).unwrap();
    fs::write(image_dir.path().join(leaf), b"impostor").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    let error = authority
        .register_engine_image(&image_dir, leaf, installed, "image".into())
        .expect_err("the pathname replacement must not be registered");

    let Error::Conflict(message) = error else {
        panic!("unexpected refusal: {error:?}");
    };
    assert!(!message.contains('/'), "{message}");
    assert!(!message.contains("image.png"), "{message}");
    assert!(authority.persistent.is_empty());
    image_dir.remove_leaf_identified(leaf, installed).unwrap();
    assert!(!original.join(leaf).exists());
    assert_eq!(fs::read(image_dir.path().join(leaf)).unwrap(), b"impostor");
}

#[test]
fn engine_image_inner_registration_refuses_mismatch_and_orphan_is_removed() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let other_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    let leaf = OsStr::new("image.png");
    let (_, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| {
            file.write_all(b"installed").map_err(Error::from)
        })
        .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    let error = authority
        .register_engine_image(&image_dir, leaf, other_dir.identity(), "image".into())
        .expect_err("a mismatched required identity must be refused");
    image_dir.remove_leaf_identified(leaf, installed).unwrap();

    let Error::Conflict(message) = error else {
        panic!("unexpected refusal: {error:?}");
    };
    assert!(!message.contains('/'), "{message}");
    assert!(!message.contains("image.png"), "{message}");
    assert!(authority.persistent.is_empty());
    assert!(!image_dir.path().join(leaf).exists());
}

#[test]
fn register_engine_image_refuses_non_leaf_names_without_disclosure() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    for leaf in [
        OsStr::new("/private/image.png"),
        OsStr::new("nested/image.png"),
    ] {
        let error = authority
            .register_engine_image(&image_dir, leaf, image_dir.identity(), "image".into())
            .expect_err("non-leaf names must be refused before joining");
        let Error::InvalidInput(message) = error else {
            panic!("unexpected refusal: {error:?}");
        };
        assert!(!message.contains('/'), "{message}");
        assert!(
            !message.contains(leaf.to_string_lossy().as_ref()),
            "{message}"
        );
    }
    assert!(authority.persistent.is_empty());
}

#[test]
fn persistent_file_reuse_refuses_a_disagreeing_expected_identity() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    fs::write(&file, b"file").unwrap();
    let other_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    let operations = vec![PathOperation::PuzzleRead];
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    authority
        .get_or_create_persistent_file(&file, "file", operations.clone())
        .unwrap();

    let error = authority
        .get_or_create_persistent_file_verified(
            &file,
            "file",
            operations,
            other_dir.identity(),
            other_dir.identity(),
            RegistrationDoor::ExplicitReauthorization,
        )
        .expect_err("the reuse arm must compare the required identity");

    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    assert_eq!(authority.persistent.len(), 1);
}

#[cfg(unix)]
#[test]
fn collection_cache_acquisition_preserves_generic_immutable_file_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let root = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Collections,
    )
    .unwrap();
    let id = Uuid::new_v4();
    let path = root.path().join(format!("{id}.db3"));
    fs::write(&path, b"old cache").unwrap();
    let held = fs::File::open(&path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let first = authority
        .acquire_collection_cache(&root, id, None, "cache".into())
        .unwrap();
    let registry = dir.path().join("registry.json");
    let before = fs::read(&registry).unwrap();
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"new cache").unwrap();
    let current = opened_file_identity(&fs::File::open(&path).unwrap()).unwrap();
    assert_ne!(current, opened_file_identity(&held).unwrap());
    let generic = authority.get_or_create_persistent_file_verified(
        &path,
        "cache",
        vec![PathOperation::DatabaseRead, PathOperation::DatabaseExport],
        VerifiedIdentity::from_pair(current),
        root.identity(),
        RegistrationDoor::ExplicitReauthorization,
    );
    assert!(
        matches!(generic, Err(Error::Conflict(message)) if message == "persistent file changed; acquire a new capability")
    );
    assert_eq!(fs::read(&registry).unwrap(), before);
    assert_eq!(fs::read(&path).unwrap(), b"new cache");
    let recovered = authority
        .acquire_collection_cache(&root, id, None, "cache".into())
        .unwrap();
    assert_eq!(recovered, first);
    assert_eq!(authority.persistent.len(), 1);
    assert!(authority
        .database_file_target(&recovered, PathOperation::DatabaseRead)
        .is_ok());
    assert!(authority
        .database_file_target(&recovered, PathOperation::DatabaseMutate)
        .is_err());
    assert!(authority
        .database_file_target(&recovered, PathOperation::DatabaseCreate)
        .is_err());
    drop(authority);
    let mut reopened = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(
        reopened
            .acquire_collection_cache(&root, id, Some(&first), "cache".into())
            .unwrap(),
        first
    );
    assert_eq!(fs::read(&path).unwrap(), b"new cache");
}

#[cfg(unix)]
#[test]
fn collection_cache_acquisition_refuses_foreign_handles_and_incompatible_grants() {
    for operations in [
        vec![PathOperation::DatabaseRead, PathOperation::DatabaseExport],
        canonical_operations(EntryPurpose::DatabaseFile),
        vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        vec![PathOperation::DatabaseRead],
    ] {
        let dir = tempfile::tempdir().unwrap();
        let root = ensure_app_owned_default_dir(
            &AppDataDir::for_test(dir.path()),
            AppOwnedDefaultRoot::Collections,
        )
        .unwrap();
        let id = Uuid::new_v4();
        let path = root.path().join(format!("{id}.db3"));
        fs::write(&path, b"private cache").unwrap();
        let foreign = dir.path().join("user.db3");
        fs::write(&foreign, b"user database").unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
        let user = DatabaseHandle::new(
            authority
                .get_or_create_persistent_file(&foreign, "user database", operations.clone())
                .unwrap()
                .id,
        );
        let registry = dir.path().join("registry.json");
        let before = fs::read(&registry).unwrap();
        assert!(
            matches!(
                authority.acquire_collection_cache(&root, id, Some(&user), "cache".into()),
                Err(Error::Conflict(_))
            ),
            "FOREIGN_COLLECTION_CACHE_HANDLE_ACCEPTED {operations:?}"
        );
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert_eq!(fs::read(&foreign).unwrap(), b"user database");
        assert_eq!(fs::read(&path).unwrap(), b"private cache");
        if operations != vec![PathOperation::DatabaseRead, PathOperation::DatabaseExport] {
            authority
                .get_or_create_persistent_file(
                    &path,
                    "incompatible private grant",
                    operations.clone(),
                )
                .unwrap();
            let before = fs::read(&registry).unwrap();
            assert!(
                matches!(
                    authority.acquire_collection_cache(&root, id, None, "cache".into()),
                    Err(Error::Conflict(_))
                ),
                "INCOMPATIBLE_COLLECTION_CACHE_GRANT_ACCEPTED {operations:?}"
            );
            assert_eq!(fs::read(&registry).unwrap(), before);
            assert_eq!(fs::read(&path).unwrap(), b"private cache");
        }
    }
}

#[cfg(unix)]
#[test]
fn collection_cache_acquisition_refuses_changed_private_parent_and_ambiguous_authority() {
    let dir = tempfile::tempdir().unwrap();
    let root = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Collections,
    )
    .unwrap();
    let id = Uuid::new_v4();
    let path = root.path().join(format!("{id}.db3"));
    fs::write(&path, b"private cache").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let handle = authority
        .acquire_collection_cache(&root, id, None, "cache".into())
        .unwrap();
    let registry = dir.path().join("registry.json");
    let before = fs::read(&registry).unwrap();
    let moved = database_test_support::replace_parent_with_same_inode_hard_link(&path);
    let new_root = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Collections,
    )
    .unwrap();
    for supplied in [None, Some(&handle)] {
        assert!(
            matches!(
                authority.acquire_collection_cache(&new_root, id, supplied, "cache".into()),
                Err(Error::Conflict(_))
            ),
            "CHANGED_COLLECTION_CACHE_PARENT_ACCEPTED"
        );
        assert_eq!(fs::read(&registry).unwrap(), before);
        assert_eq!(fs::read(&path).unwrap(), b"private cache");
        assert_eq!(
            fs::read(moved.join(path.file_name().unwrap())).unwrap(),
            b"private cache"
        );
    }
    // A second genuine grant at the same private path must not let pending discovery guess
    // which capability to renew, even though one of the grants is a valid cache shape.
    authority
        .get_or_create_persistent_file(&path, "another grant", vec![PathOperation::DatabaseRead])
        .unwrap();
    let before = fs::read(&registry).unwrap();
    assert!(
        matches!(authority.acquire_collection_cache(&new_root, id, None, "cache".into()), Err(Error::Conflict(message)) if message == "collection cache authority is ambiguous")
    );
    assert_eq!(fs::read(&registry).unwrap(), before);
    assert_eq!(fs::read(&path).unwrap(), b"private cache");
}

#[test]
fn migrate_legacy_verified_identity_mismatch_is_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file");
    fs::write(&file, b"file").unwrap();
    let other_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    let error = authority
        .migrate_legacy_os_path_inner(
            file.into_os_string(),
            "file".into(),
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
            Some(other_dir.identity()),
            Some(other_dir.identity()),
        )
        .expect_err("the migrate arm must compare the required identity");

    let Error::Conflict(message) = error else {
        panic!("unexpected refusal: {error:?}");
    };
    assert!(!message.contains('/'), "{message}");
    assert!(!message.contains("file"), "{message}");
    assert!(authority.persistent.is_empty());
}

#[test]
fn database_child_identity_mismatch_is_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let databases = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    let engines = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Engines,
    )
    .unwrap();
    let validated = validate_target(databases.path(), PathClass::PersistentCustomRoot).unwrap();

    let error = verified_identity::database_child_identity(engines.identity(), &validated)
        .expect_err("the descriptor and pathname identities disagree");

    let Error::Conflict(message) = error else {
        panic!("unexpected refusal: {error:?}");
    };
    assert!(!message.contains('/'), "{message}");
    assert!(!message.contains("db"), "{message}");
}

#[cfg(unix)]
#[test]
fn register_database_child_identity_mismatch_is_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let child = root_path.join("child.db3");
    let replacement = dir.path().join("replacement.db3");
    fs::write(&child, b"original").unwrap();
    fs::write(&replacement, b"replacement").unwrap();
    let original_identity = observed_identity(&child);
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();

    DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(replacement, child).unwrap();
            })))
            .is_none());
    });
    let error = authority
        .register_database_child(
            &root,
            OsStr::new("child.db3"),
            "child.db3",
            original_identity,
        )
        .expect_err("the descriptor and joined pathname identities disagree");

    let Error::Conflict(message) = error else {
        panic!("unexpected refusal: {error:?}");
    };
    assert_eq!(message, VERIFIED_REGISTRATION_CONFLICT);
    assert!(!message.contains('/'), "{message}");
    assert!(!message.contains("child.db3"), "{message}");
}

#[cfg(unix)]
#[test]
fn create_database_child_uses_captured_identity_without_post_handoff_query() {
    use crate::infra::inode_ownership::{CreateTestControls, CREATE_TEST_CONTROLS};
    use std::os::unix::fs::MetadataExt;

    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let leaf = root_path.join("captured.db3");
    let created_identity = Arc::new(std::sync::OnceLock::new());
    let captured = created_identity.clone();
    let created_leaf = leaf.clone();
    CREATE_TEST_CONTROLS.with(|slot| {
        *slot.borrow_mut() = CreateTestControls {
            after_create: Some(Box::new(move || {
                let metadata = fs::metadata(&created_leaf).unwrap();
                let identity = (metadata.dev(), metadata.ino());
                captured.set(identity).unwrap();
                DATABASE_CREATE_IDENTITY_FAILURE.with(|slot| {
                    assert_eq!(slot.replace(Some(identity)), None);
                });
            })),
            ..Default::default()
        };
    });
    let captured = created_identity.clone();
    DATABASE_CHILD_POST_CREATE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                // Registration keeps its own later identity checks.
                DATABASE_CREATE_IDENTITY_FAILURE.with(|slot| {
                    assert_eq!(slot.take(), captured.get().copied());
                });
            })))
            .is_none());
    });

    let result = authority.create_database_child(&root, OsStr::new("captured.db3"));
    DATABASE_CREATE_IDENTITY_FAILURE.with(|slot| slot.set(None));
    DATABASE_CHILD_POST_CREATE_HOOK.with(|slot| slot.borrow_mut().take());
    let created = result.expect(
            "database creation must use the creator's captured identity without querying metadata again",
        );
    let expected = *created_identity.get().unwrap();
    let stored = &authority.persistent[&created.path_ref().id].stored.identity;
    assert_eq!((stored.a, stored.b), expected);
    assert_eq!(fs::read(&leaf).unwrap(), b"");

    let ordinary = fs::File::open(&leaf).unwrap();
    DATABASE_CREATE_IDENTITY_FAILURE.with(|slot| slot.set(Some(expected)));
    let error = opened_file_identity(&ordinary)
        .expect_err("ordinary verified identity acquisition still queries metadata");
    assert!(error
        .diagnostic()
        .contains("injected database-create post-handoff identity failure"));
    DATABASE_CREATE_IDENTITY_FAILURE.with(|slot| assert_eq!(slot.take(), None));
}

#[cfg(unix)]
#[test]
fn create_database_child_refuses_unicode_composition_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let original = authority
        .create_database_child(&root, OsStr::new("José.db3"))
        .unwrap();
    let registry = fs::read(dir.path().join("registry.json")).unwrap();
    let error = authority
        .create_database_child(&root, OsStr::new("Jose\u{301}.db3"))
        .unwrap_err();
    assert!(
        matches!(error, Error::Conflict(ref message) if message == "database filename already exists")
    );
    assert_eq!(fs::read_dir(&root_path).unwrap().count(), 1);
    assert_eq!(
        fs::read(dir.path().join("registry.json")).unwrap(),
        registry
    );
    let listing = authority
        .list_database_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(listing.entries.len(), 1);
    assert_eq!(listing.entries[0].handle, original);
}

#[cfg(target_os = "linux")]
#[test]
fn database_listing_refuses_unicode_composition_sibling_without_registering_it() {
    for registered in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("databases");
        fs::create_dir(&root_path).unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
        let root = authority
            .get_or_create_database_root(&root_path, "Databases", None)
            .unwrap();
        if registered {
            authority
                .create_database_child(&root, OsStr::new("José.db3"))
                .unwrap();
        } else {
            fs::write(root_path.join("José.db3"), b"original").unwrap();
        }
        fs::write(root_path.join("Jose\u{301}.db3"), b"external variant").unwrap();
        let registry = fs::read(dir.path().join("registry.json")).unwrap();
        let result = authority.list_database_children_cancellable(&root, &CancellationToken::new());
        assert!(
            matches!(result, Err(Error::Conflict(ref message)) if message == "database filename already exists")
        );
        assert_eq!(
            fs::read(dir.path().join("registry.json")).unwrap(),
            registry
        );
        assert_eq!(
            fs::read(root_path.join("Jose\u{301}.db3")).unwrap(),
            b"external variant"
        );
    }
}

#[cfg(target_os = "linux")]
#[test]
fn database_child_names_preserve_ascii_case_distinctions() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let upper = authority
        .create_database_child(&root, OsStr::new("Foo.db3"))
        .unwrap();
    let lower = authority
        .create_database_child(&root, OsStr::new("foo.db3"))
        .unwrap();
    assert_ne!(upper, lower);
    let listing = authority
        .list_database_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(fs::read_dir(&root_path).unwrap().count(), 2);
}

#[cfg(unix)]
#[test]
fn create_database_child_is_exclusive_listable_and_validates_names() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();

    let created = authority
        .create_database_child(&root, OsStr::new("created.db3"))
        .unwrap();
    assert_eq!(fs::read(root_path.join("created.db3")).unwrap(), b"");
    let listed = authority
        .list_database_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(listed.entries.len(), 1);
    assert_eq!(listed.entries[0].handle, created);
    let expected_parent = authority
        .capability_directory(root.path_ref(), PathOperation::DatabaseRead)
        .unwrap()
        .identity()
        .unwrap();
    assert_eq!(
        authority.parent_identity_for_test(listed.entries[0].handle.path_ref()),
        Some(expected_parent)
    );
    assert!(authority
        .resolve(
            listed.entries[0].handle.path_ref(),
            PathOperation::DatabaseRead,
            &[]
        )
        .is_ok());

    fs::write(root_path.join("existing.db3"), b"original").unwrap();
    let conflict = authority
        .create_database_child(&root, OsStr::new("existing.db3"))
        .expect_err("exclusive creation must preserve an existing database");
    assert!(matches!(conflict, Error::Conflict(_)));
    assert_eq!(
        fs::read(root_path.join("existing.db3")).unwrap(),
        b"original"
    );

    for filename in [
        OsStr::new("no-extension"),
        OsStr::new("nested/child.db3"),
        OsStr::new(""),
    ] {
        assert!(authority.create_database_child(&root, filename).is_err());
    }
}

#[cfg(unix)]
#[test]
fn directory_listing_bound_database_cancels_before_snapshot_publication() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    for name in ["one.db3", "two.db3", "three.db3"] {
        fs::write(root_path.join(name), b"database").unwrap();
    }
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let cancellation = CancellationToken::new();
    let cancel_after_first = cancellation.clone();
    DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || cancel_after_first.cancel())))
            .is_none());
    });

    assert!(matches!(
        authority.list_database_children_cancellable(&root, &cancellation),
        Err(Error::Cancellation)
    ));
    let registered = authority
        .persistent
        .values()
        .filter(|entry| entry.stored.purpose == Some(EntryPurpose::DatabaseFile))
        .count();
    assert_eq!(
        registered, 0,
        "a canceled listing publishes no fresh identities"
    );
}

#[cfg(unix)]
#[test]
fn directory_listing_bound_puzzle_cancels_before_snapshot_publication() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("puzzles");
    fs::create_dir(&root_path).unwrap();
    for name in ["one.db3", "two.db3", "three.db3"] {
        fs::write(root_path.join(name), b"database").unwrap();
    }
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_puzzle_root(&root_path, "Puzzles", None)
        .unwrap();
    let cancellation = CancellationToken::new();
    let cancel_after_first = cancellation.clone();
    PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || cancel_after_first.cancel())))
            .is_none());
    });

    assert!(matches!(
        authority.list_puzzle_children_cancellable(&root, &cancellation),
        Err(Error::Cancellation)
    ));
    let registered = authority
        .persistent
        .values()
        .filter(|entry| entry.stored.purpose == Some(EntryPurpose::PuzzleFile))
        .count();
    assert_eq!(
        registered, 0,
        "a canceled listing publishes no fresh identities"
    );
}

#[cfg(unix)]
#[test]
fn create_database_child_cleans_through_retained_root_after_path_swap() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    let moved_root = dir.path().join("databases-moved");
    let outside = dir.path().join("outside");
    fs::create_dir(&root_path).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("sentinel.db3"), b"outside").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let hook_root = root_path.clone();
    let hook_moved = moved_root.clone();
    let hook_outside = outside.clone();
    DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&hook_root, &hook_moved).unwrap();
                symlink(&hook_outside, &hook_root).unwrap();
            })))
            .is_none());
    });

    let error = authority
        .create_database_child(&root, OsStr::new("created.db3"))
        .expect_err("registration must reject the swapped logical root");
    assert!(matches!(error, Error::InvalidInput(_) | Error::Conflict(_)));
    assert!(!moved_root.join("created.db3").exists());
    assert!(!outside.join("created.db3").exists());
    assert_eq!(fs::read(outside.join("sentinel.db3")).unwrap(), b"outside");
}

#[cfg(unix)]
#[test]
fn create_database_child_refuses_late_file_and_symlink_substitution() {
    use std::os::unix::fs::symlink;

    for symlink_leaf in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("databases");
        let outside = dir.path().join("outside.db3");
        fs::create_dir(&root_path).unwrap();
        fs::write(&outside, b"outside").unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
        let root = authority
            .get_or_create_database_root(&root_path, "Databases", None)
            .unwrap();
        let leaf = root_path.join("late.db3");
        let hook_leaf = leaf.clone();
        let hook_outside = outside.clone();
        DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    if symlink_leaf {
                        symlink(&hook_outside, &hook_leaf).unwrap();
                    } else {
                        fs::write(&hook_leaf, b"original").unwrap();
                    }
                })))
                .is_none());
        });

        let error = authority
            .create_database_child(&root, OsStr::new("late.db3"))
            .expect_err("exclusive creation must refuse the late leaf");
        assert!(matches!(error, Error::Conflict(_)));
        if symlink_leaf {
            assert_eq!(fs::read(&outside).unwrap(), b"outside");
            assert!(fs::symlink_metadata(&leaf)
                .unwrap()
                .file_type()
                .is_symlink());
        } else {
            assert_eq!(fs::read(&leaf).unwrap(), b"original");
        }
    }
}

#[cfg(unix)]
#[test]
fn create_database_child_does_not_adopt_or_unlink_substituted_leaf() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    let original = root_path.join("original.db3");
    let replacement = root_path.join("created.db3");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let hook_original = original.clone();
    let hook_replacement = replacement.clone();
    DATABASE_CHILD_POST_CREATE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&hook_replacement, &hook_original).unwrap();
                fs::write(&hook_replacement, b"replacement").unwrap();
            })))
            .is_none());
    });

    let error = authority
        .create_database_child(&root, OsStr::new("created.db3"))
        .expect_err("registration must reject the substituted inode");
    assert!(matches!(error, Error::OperationAndCleanup { .. }));
    assert_eq!(fs::read(&replacement).unwrap(), b"replacement");
    assert_eq!(fs::read(&original).unwrap(), b"");
    assert!(authority
        .persistent
        .values()
        .all(|entry| entry.stored.path.to_path().ok().as_ref() != Some(&replacement)));
}

#[cfg(unix)]
#[test]
fn create_database_child_registry_failure_cleans_created_leaf_and_reports_cleanup_failure() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let error = authority
        .create_database_child(&root, OsStr::new("failed.db3"))
        .expect_err("registry failure must be returned");
    set_test_atomic_file_injector(None);
    assert!(matches!(error, Error::Io(_)));
    assert!(!root_path.join("failed.db3").exists());

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    set_test_removal_injector(Some(Arc::new(RemovalFault(
        RemovalFaultPoint::BeforeTopOpen,
    ))));
    let error = authority
        .create_database_child(&root, OsStr::new("cleanup-failed.db3"))
        .expect_err("cleanup failure must be surfaced with the registry failure");
    set_test_atomic_file_injector(None);
    set_test_removal_injector(None);
    assert!(matches!(error, Error::OperationAndCleanup { .. }));
    assert!(root_path.join("cleanup-failed.db3").exists());
    let diagnostic = error.diagnostic();
    assert!(diagnostic.contains("write failed"), "{diagnostic}");
    assert!(
        diagnostic.contains("injected removal failure"),
        "{diagnostic}"
    );
    let payload = serde_json::to_value(&error).unwrap();
    assert_eq!(payload["category"], "operation-and-cleanup");
    assert_eq!(
        payload["message"],
        "Operation failed; temporary cleanup also failed"
    );
    assert!(!payload.to_string().contains("write failed"));
    assert!(!payload.to_string().contains("/private/removal"));
}

#[test]
fn guarded_registrars_require_the_resolved_descriptor_identity() {
    let source = test_source_files::production_source();
    for signature in [
        "pub(crate) fn register_installed_engine(",
        "fn prepare_puzzle_listing_child(",
    ] {
        let body = body_at_indent(source, signature);
        assert!(body.contains("let resolved = self.resolve"), "{body}");
        assert!(body.contains("resolved.identity()?"), "{body}");
        assert!(!body.contains("let _ = self.resolve("), "{body}");
        assert!(!body.contains("validate_target("), "{body}");
    }
}

#[cfg(unix)]
#[test]
fn installed_engine_registration_persists_resolved_identity_across_a_path_swap() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("engines");
    fs::create_dir(&root_path).unwrap();
    let engine = root_path.join("engine");
    let replacement = root_path.join("replacement");
    let original = root_path.join("original");
    fs::write(&engine, b"original").unwrap();
    fs::write(&replacement, b"replacement").unwrap();
    let original_metadata = fs::metadata(&engine).unwrap();
    let original_identity = (original_metadata.dev(), original_metadata.ino());
    let clock = Arc::new(TestClock::new(0));
    let mut authority = authority(&dir, clock);
    let root = authority
        .get_or_create_engine_root(&root_path, "Engines", None)
        .unwrap();

    let swap_engine = engine.clone();
    INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&swap_engine, original).unwrap();
                fs::rename(replacement, swap_engine).unwrap();
            })))
            .is_none());
    });
    let handle = authority
        .register_installed_engine_for_test(&root, "engine")
        .expect("resolved descriptor identity is persisted despite pathname replacement");
    let stored = &authority.persistent[&handle.id.id].stored;
    assert_eq!((stored.identity.a, stored.identity.b), original_identity);
    let id = handle.id.id.clone();
    drop(authority);

    let mut reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let reopened_identity = &reopened.persistent[&id].stored.identity;
    assert_eq!(
        (reopened_identity.a, reopened_identity.b),
        original_identity
    );
    assert!(reopened
        .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
        .is_err());
}

#[test]
fn installed_engine_registration_reuses_id_and_refuses_invalid_paths_and_directories() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("engines");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("engine"), b"engine").unwrap();
    fs::create_dir(root_path.join("directory")).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_engine_root(&root_path, "Engines", None)
        .unwrap();
    let first = authority
        .register_installed_engine_for_test(&root, "engine")
        .unwrap();
    let expected_parent = authority
        .capability_directory(root.path_ref(), PathOperation::EngineInstall)
        .unwrap()
        .identity()
        .unwrap();
    assert_eq!(
        authority.parent_identity_for_test(first.path_ref()),
        Some(expected_parent)
    );
    assert!(authority
        .resolve(first.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .is_ok());
    let second = authority
        .register_installed_engine_for_test(&root, "engine")
        .unwrap();
    assert_eq!(first.id, second.id);
    for invalid in ["", "../engine", "/engine", "directory"] {
        assert!(
            authority
                .register_installed_engine_for_test(&root, invalid)
                .is_err(),
            "{invalid}"
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("engine", root_path.join("link")).unwrap();
        assert!(authority
            .register_installed_engine_for_test(&root, "link")
            .is_err());
    }
    drop(authority);
    let mut reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let after_restart = reopened
        .register_installed_engine_for_test(&root, "engine")
        .unwrap();
    assert_eq!(first.id, after_restart.id);

    let replacement = root_path.join("replacement");
    fs::write(&replacement, b"replacement").unwrap();
    fs::remove_file(root_path.join("engine")).unwrap();
    fs::rename(replacement, root_path.join("engine")).unwrap();
    let entries_before_refusal = reopened.persistent.len();
    let error = reopened
        .register_installed_engine_for_test(&root, "engine")
        .expect_err("a replaced engine must not reuse its stored capability");
    assert!(matches!(
        error,
        Error::Conflict(message)
            if message == "persistent file changed; acquire a new capability"
    ));
    assert_eq!(reopened.persistent.len(), entries_before_refusal);
}

#[test]
fn installed_engine_registration_keeps_registry_unchanged_on_persistence_failure() {
    struct RegistryFailure;
    impl AtomicWriterInjector for RegistryFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::TempfileCreate {
                Err(std::io::Error::other("registry failure"))
            } else {
                Ok(())
            }
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("engines");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("engine"), b"engine").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_engine_root(&root_path, "Engines", None)
        .unwrap();
    let before = authority.persistent.len();
    set_test_atomic_file_injector(Some(Arc::new(RegistryFailure)));
    let result = authority.register_installed_engine_for_test(&root, "engine");
    set_test_atomic_file_injector(None);
    assert!(result.is_err());
    assert_eq!(authority.persistent.len(), before);
}

#[cfg(unix)]
#[test]
fn resolve_regular_swap_to_fifo_is_prompt_for_read_and_write_access() {
    for operation in [PathOperation::ReadPgn, PathOperation::WritePgn] {
        let dir = tempfile::tempdir().unwrap();
        let root_path = dir.path().join("workspace");
        fs::create_dir(&root_path).unwrap();
        let file = root_path.join("game.pgn");
        let original = root_path.join("original.pgn");
        fs::write(&file, b"*").unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
        let grant = authority
            .grant_dialog_operations(
                &root_path,
                "Workspace",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                Duration::from_secs(60),
                1,
            )
            .unwrap();
        let root = authority
            .promote_dialog(
                &grant,
                PathClass::PersistentCustomRoot,
                "Workspace",
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap();
        let swap_file = file.clone();
        RESOLVE_PRE_REGULAR_OPEN_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    fs::rename(&swap_file, original).unwrap();
                    let status = std::process::Command::new("mkfifo")
                        .arg(swap_file)
                        .status()
                        .unwrap();
                    assert!(status.success());
                })))
                .is_none());
        });
        let release_fifo = file.clone();
        let (completed_tx, completed_rx) = std::sync::mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if completed_rx.recv_timeout(Duration::from_secs(2)).is_err() {
                let _ = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(release_fifo);
            }
        });
        let started = std::time::Instant::now();
        let result = authority.resolve(&root.id, operation, &[OsString::from("game.pgn")]);
        let elapsed = started.elapsed();
        let _ = completed_tx.send(());
        watchdog.join().unwrap();
        assert!(result.is_err());
        assert!(
            elapsed < Duration::from_secs(1),
            "FIFO open blocked for {elapsed:?}"
        );
    }
}

#[cfg(unix)]
#[test]
fn database_file_target_enforces_the_exact_stored_operation() {
    let dir = tempfile::tempdir().unwrap();
    let database = dir.path().join("readonly.db3");
    fs::write(&database, b"database").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let grant = authority
        .grant_dialog(
            &database,
            "readonly",
            PathClass::SingleDialogGrant,
            PathOperation::DatabaseRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let committed = authority
        .promote_dialog(
            &grant,
            PathClass::PersistentFile,
            "readonly",
            vec![PathOperation::DatabaseRead],
        )
        .unwrap();
    let handle = DatabaseHandle::new(committed.id);

    let target = authority
        .database_file_target(&handle, PathOperation::DatabaseRead)
        .unwrap();
    assert_eq!(target.leaf(), OsStr::new("readonly.db3"));
    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseMutate),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseExport),
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseCreate),
        Err(Error::InvalidInput(_))
    ));
}

#[cfg(unix)]
#[test]
fn is_database_file_operation_classifies_every_variant() {
    fn oracle(operation: PathOperation) -> bool {
        match operation {
            PathOperation::DatabaseRead
            | PathOperation::DatabaseMutate
            | PathOperation::DatabaseCreate
            | PathOperation::DatabaseExport => true,
            PathOperation::ReadPgn
            | PathOperation::WritePgn
            | PathOperation::PuzzleRead
            | PathOperation::PuzzleDelete
            | PathOperation::EngineExecute
            | PathOperation::EngineConfigure
            | PathOperation::EngineBinaryInspect
            | PathOperation::EngineResourceRead
            | PathOperation::OpeningBookRead
            | PathOperation::ImageRead
            | PathOperation::DownloadFile
            | PathOperation::DownloadArchive
            | PathOperation::EngineInstall
            | PathOperation::SnapshotWrite
            | PathOperation::LogWrite
            | PathOperation::OpenShell => false,
        }
    }

    let operations = [
        PathOperation::ReadPgn,
        PathOperation::WritePgn,
        PathOperation::DatabaseRead,
        PathOperation::DatabaseMutate,
        PathOperation::DatabaseCreate,
        PathOperation::DatabaseExport,
        PathOperation::PuzzleRead,
        PathOperation::PuzzleDelete,
        PathOperation::EngineExecute,
        PathOperation::EngineConfigure,
        PathOperation::EngineBinaryInspect,
        PathOperation::EngineResourceRead,
        PathOperation::OpeningBookRead,
        PathOperation::ImageRead,
        PathOperation::DownloadFile,
        PathOperation::DownloadArchive,
        PathOperation::EngineInstall,
        PathOperation::SnapshotWrite,
        PathOperation::LogWrite,
        PathOperation::OpenShell,
    ];
    for operation in operations {
        assert_eq!(is_database_file_operation(operation), oracle(operation));
    }
}

#[cfg(unix)]
#[test]
fn database_file_target_mints_all_database_operations_for_a_created_child() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let handle = authority
        .create_database_child(&root, OsStr::new("created.db3"))
        .unwrap();
    let expected_parent = authority
        .capability_directory(root.path_ref(), PathOperation::DatabaseRead)
        .unwrap()
        .identity()
        .unwrap();
    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some(expected_parent)
    );
    assert!(authority
        .resolve(handle.path_ref(), PathOperation::DatabaseRead, &[])
        .is_ok());
    let expected_path = root_path.canonicalize().unwrap().join("created.db3");
    let expected_identity = opened_file_identity(&fs::File::open(&expected_path).unwrap()).unwrap();
    authority.session_protected_ids.clear();

    for operation in [
        PathOperation::DatabaseRead,
        PathOperation::DatabaseMutate,
        PathOperation::DatabaseCreate,
        PathOperation::DatabaseExport,
    ] {
        let mut resolved = authority
            .resolve(handle.path_ref(), operation, &[])
            .unwrap();
        assert!(resolved.file().is_none());
        assert!(resolved.is_regular_file());
        assert_eq!(resolved.identity().unwrap().pair(), expected_identity);
        assert_eq!(resolved.parent_identity().unwrap(), expected_parent);
        assert_eq!(resolved.leaf(), Some(OsStr::new("created.db3")));
        assert!(resolved.directory().is_none());
        assert!(resolved.read_bytes().is_err());
        assert!(resolved.into_read_file().is_err());
        let target = authority.database_file_target(&handle, operation).unwrap();
        assert_eq!(target.identity(), expected_identity);
        assert_eq!(target.path(), expected_path);
        assert_eq!(target.leaf(), OsStr::new("created.db3"));
    }
    assert!(authority
        .session_protected_ids
        .contains(&handle.path_ref().id));
}

#[cfg(unix)]
#[test]
fn database_file_target_rejects_non_database_operations_before_path_access() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("pgn");
    let path = parent.join("study.pgn");
    fs::create_dir(&parent).unwrap();
    fs::write(&path, b"*").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let grant = authority
        .grant_dialog(
            &path,
            "study",
            PathClass::SingleDialogGrant,
            PathOperation::WritePgn,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let committed = authority
        .promote_dialog(
            &grant,
            PathClass::PersistentFile,
            "study",
            vec![PathOperation::WritePgn],
        )
        .unwrap();
    let handle = DatabaseHandle::new(committed.id);
    fs::remove_dir_all(&parent).unwrap();

    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::WritePgn),
        Err(Error::InvalidInput(message)) if message == "invalid database file operation"
    ));
    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DownloadFile),
        Err(Error::InvalidInput(message)) if message == "invalid database file operation"
    ));
}

#[cfg(unix)]
#[test]
fn database_file_target_rejects_directory_entries_before_path_access() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("directories");
    let path = parent.join("database.db3");
    fs::create_dir_all(&path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let committed = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "database",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::DatabaseRead],
        )
        .unwrap();
    let handle = DatabaseHandle::new(committed.id);
    fs::remove_dir_all(&parent).unwrap();

    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseRead),
        Err(Error::InvalidInput(message))
            if message == "database handle must identify a regular file"
    ));
}

#[cfg(unix)]
#[test]
fn database_file_target_refuses_a_verified_raw_spelling_and_mints_the_migrated_canonical_one() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    let path = link.join("x.db3");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("x.db3"), b"database").unwrap();
    symlink(&real, &link).unwrap();
    let real_directory = authorize_existing_dir(&real).unwrap();
    let verified_file = real_directory
        .open_leaf_identified(OsStr::new("x.db3"))
        .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let canonicalized = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "x",
            PathClass::PersistentFile,
            vec![
                PathOperation::DatabaseRead,
                PathOperation::DatabaseMutate,
                PathOperation::DatabaseCreate,
                PathOperation::DatabaseExport,
            ],
        )
        .unwrap();
    assert_eq!(
        authority.persistent[&canonicalized.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("x.db3")
    );
    let raw_spelling = authority
        .get_or_create_persistent_file_verified(
            &path,
            "x",
            canonical_operations(EntryPurpose::DatabaseFile),
            verified_file,
            real_directory.identity(),
            RegistrationDoor::ExplicitReauthorization,
        )
        .unwrap();
    assert_eq!(
        authority.persistent[&raw_spelling.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        path
    );
    // Test 10: the verified door stores the caller's raw spelling, which re-acquires under a
    // different pathname and is therefore refused; the migrated canonical entry still mints.
    let refused = authority
        .database_file_target(
            &DatabaseHandle::new(raw_spelling.id),
            PathOperation::DatabaseMutate,
        )
        .err()
        .expect("a verified raw spelling must not mint a target");
    assert!(matches!(refused, Error::Conflict(_)), "{refused:?}");
    let target = authority
        .database_file_target(
            &DatabaseHandle::new(canonicalized.id),
            PathOperation::DatabaseMutate,
        )
        .unwrap();
    assert_eq!(target.path(), real.join("x.db3"));
    assert_eq!(target.leaf(), OsStr::new("x.db3"));
}

#[cfg(unix)]
#[test]
fn database_file_target_rejects_a_replaced_leaf_before_minting() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("databases");
    let path = parent.join("database.db3");
    let moved = dir.path().join("moved.db3");
    fs::create_dir(&parent).unwrap();
    fs::write(&path, b"database").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let committed = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "database",
            PathClass::PersistentFile,
            canonical_operations(EntryPurpose::DatabaseFile),
        )
        .unwrap();
    let handle = DatabaseHandle::new(committed.id);
    fs::rename(&path, &moved).unwrap();
    symlink(&moved, &path).unwrap();

    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseRead),
        Err(Error::InvalidInput(_))
    ));
}

#[cfg(unix)]
#[test]
fn database_file_target_rejects_a_leaf_replaced_before_the_proof() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("databases");
    let path = parent.join("database.db3");
    let moved = dir.path().join("moved.db3");
    fs::create_dir(&parent).unwrap();
    fs::write(&path, b"database").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let committed = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "database",
            PathClass::PersistentFile,
            canonical_operations(EntryPurpose::DatabaseFile),
        )
        .unwrap();
    let handle = DatabaseHandle::new(committed.id);
    fs::hard_link(&path, &moved).unwrap();
    let hook_path = path.clone();
    let hook_moved = moved.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::remove_file(&hook_path).unwrap();
                symlink(&hook_moved, &hook_path).unwrap();
            })))
            .is_none());
    });

    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseRead),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn database_file_target_probe_current_returns_authorized_identity_and_length() {
    const CONFLICT: &str = "database changed after capability resolution";
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("database.db3");
    fs::write(&path, b"database").unwrap();
    let target = DatabaseFileTarget::for_test_path(&path).unwrap();

    let metadata = target.probe_current().unwrap();
    assert_eq!(metadata.identity, target.identity());
    assert_eq!(metadata.length, b"database".len() as u64);

    fs::remove_file(&path).unwrap();
    assert!(matches!(
        target.probe_current(),
        Err(Error::Conflict(message)) if message == CONFLICT
    ));
}

#[test]
fn database_file_target_probe_current_rejects_directory_and_parent_replacements() {
    const CONFLICT: &str = "database changed after capability resolution";
    let dir = tempfile::tempdir().unwrap();
    let directory_path = dir.path().join("directory-leaf");
    fs::create_dir(&directory_path).unwrap();
    let directory_file = fs::File::open(&directory_path).unwrap();
    let directory_target = DatabaseFileTarget::assemble(
        fs::File::open(dir.path()).unwrap(),
        OsStr::new("directory-leaf").to_os_string(),
        opened_file_identity(&directory_file).unwrap(),
        directory_path.clone(),
    );
    assert!(matches!(
        directory_target.probe_current(),
        Err(Error::Conflict(message)) if message == CONFLICT
    ));

    let parent = dir.path().join("parent");
    let child = parent.join("database.db3");
    fs::create_dir(&parent).unwrap();
    fs::write(&child, b"database").unwrap();
    let target = DatabaseFileTarget::for_test_path(&child).unwrap();
    let moved_parent = dir.path().join("moved-parent");
    fs::rename(&parent, &moved_parent).unwrap();
    fs::write(&parent, b"not a directory").unwrap();
    assert!(matches!(
        target.probe_current(),
        Err(Error::Conflict(message)) if message == CONFLICT
    ));

    let hardlink_parent = dir.path().join("hardlink-parent");
    let hardlink_child = hardlink_parent.join("database.db3");
    fs::create_dir(&hardlink_parent).unwrap();
    fs::write(&hardlink_child, b"database").unwrap();
    let hardlink_target = DatabaseFileTarget::for_test_path(&hardlink_child).unwrap();
    let moved_hardlink_parent = dir.path().join("moved-hardlink-parent");
    fs::rename(&hardlink_parent, &moved_hardlink_parent).unwrap();
    fs::create_dir(&hardlink_parent).unwrap();
    fs::hard_link(
        moved_hardlink_parent.join("database.db3"),
        hardlink_parent.join("database.db3"),
    )
    .unwrap();
    assert!(matches!(
        hardlink_target.probe_current(),
        Err(Error::Conflict(message)) if message == CONFLICT
    ));
}

#[test]
fn database_file_target_probe_current_preserves_pre_epoch_mtime() {
    use std::time::{Duration, UNIX_EPOCH};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("database.db3");
    fs::write(&path, b"database").unwrap();
    let target = DatabaseFileTarget::for_test_path(&path).unwrap();
    let expected = UNIX_EPOCH - Duration::new(86_400, 0) + Duration::from_nanos(250_000_000);

    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(expected)
        .unwrap();

    assert_eq!(
        target.probe_current().unwrap().modified,
        fs::metadata(&path).unwrap().modified().unwrap()
    );
}

#[cfg(unix)]
#[test]
fn database_file_target_probe_current_rejects_a_fifo_leaf_without_blocking() {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("database.db3");
    fs::write(&path, b"database").unwrap();
    let target = DatabaseFileTarget::for_test_path(&path).unwrap();
    fs::remove_file(&path).unwrap();
    let fifo_path = CString::new(path.as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(fifo_path.as_ptr(), 0o600) }, 0);

    assert!(matches!(target.probe_current(), Err(Error::Conflict(_))));
}

#[cfg(unix)]
#[test]
fn database_file_target_probe_current_rejects_swaps_between_access_and_second_stat() {
    use std::os::unix::fs::symlink;

    for replace_with_symlink in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("database.db3");
        let original = dir.path().join("database.original");
        let replacement = dir.path().join("replacement.db3");
        fs::write(&path, b"authorized database").unwrap();
        fs::write(&replacement, b"replacement database").unwrap();
        let target = DatabaseFileTarget::for_test_path(&path).unwrap();
        let hook_path = path.clone();
        let hook_original = original.clone();
        let hook_replacement = replacement.clone();
        crate::infra::fs::set_regular_file_probe_after_access_hook(Some(Box::new(move || {
            fs::rename(&hook_path, &hook_original).unwrap();
            if replace_with_symlink {
                symlink(&hook_replacement, &hook_path).unwrap();
            } else {
                fs::hard_link(&hook_replacement, &hook_path).unwrap();
            }
        })));

        let result = target.probe_current();
        assert!(matches!(result, Err(Error::Conflict(_))));
        fs::remove_file(&path).unwrap();
        fs::rename(original, path).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn database_file_target_test_door_binds_absent_relative_and_non_utf8_paths() {
    let dir = tempfile::tempdir().unwrap();
    let absent = dir.path().join("absent.db3");
    let target = DatabaseFileTarget::for_test_path(&absent).unwrap();
    assert_eq!(target.path(), absent.canonicalize().unwrap());
    assert_eq!(fs::metadata(&absent).unwrap().len(), 0);

    let _cwd_guard = CURRENT_DIR_TEST_LOCK.lock().unwrap();
    let old_cwd = std::env::current_dir().unwrap();
    std::env::set_current_dir(dir.path()).unwrap();
    let relative = DatabaseFileTarget::for_test_path(Path::new("database.db3")).unwrap();
    std::env::set_current_dir(old_cwd).unwrap();
    assert_eq!(
        relative.path(),
        dir.path().canonicalize().unwrap().join("database.db3")
    );

    assert!(matches!(
        DatabaseFileTarget::for_test_path(Path::new(".")),
        Err(Error::InvalidInput(message)) if message == "database path needs a leaf name"
    ));

    // APFS cannot store non-UTF-8 file names
    #[cfg(not(target_os = "macos"))]
    {
        let non_utf8 = dir.path().join(OsString::from_vec(b"caf\xe9.db3".to_vec()));
        let target = DatabaseFileTarget::for_test_path(&non_utf8).unwrap();
        assert_eq!(target.leaf(), non_utf8.file_name().unwrap());
    }
}

#[test]
fn database_file_target_production_surface_is_private_and_canonically_bound() {
    let production = test_source_files::production_source();
    let target = production
        .split("pub(crate) struct DatabaseFileTarget {")
        .nth(1)
        .unwrap()
        .split("\n}")
        .next()
        .unwrap();
    assert!(!target.contains("pub"));
    assert!(production.contains("pub(crate) enum DatabaseDeleteRecovery {"));
    assert!(!production.contains("pub enum DatabaseDeleteRecovery"));
    assert!(production.contains("fn assemble("));
    assert!(!production.contains("pub fn assemble("));
    assert!(!production.contains("pub(crate) fn assemble("));

    let predicate = production
        .split("fn is_database_file_operation")
        .nth(1)
        .unwrap()
        .split("fn canonical_binding")
        .next()
        .unwrap();
    assert!(!predicate.contains("_ =>"));
    assert!(!predicate.contains(".."));
    assert!(!production.contains("fn database_path("));
    let body = production.split("fn database_file_target(").nth(1).unwrap();
    let first_statement = body
        .split_once("{")
        .map(|(_, body)| body.trim_start())
        .unwrap();
    assert!(first_statement.starts_with("if !is_database_file_operation(operation)"));

    for (source, marker) in [
        (
            include_str!("../../db/mod.rs"),
            "#[cfg(all(test, unix))]\nmod tests",
        ),
        (
            include_str!("../../db/search.rs"),
            "#[cfg(all(test, unix))]\nmod tests",
        ),
    ] {
        let Some((production, _tests)) = source.split_once(marker) else {
            panic!("missing test-module marker {marker:?}");
        };
        assert!(!production.contains("DatabaseFileTarget {"));
        assert!(!production.contains("assemble("));
    }
    // The command modules split out of `db/mod.rs` carry no test module.
    for production in [
        include_str!("../../db/import.rs"),
        include_str!("../../db/queries.rs"),
        include_str!("../../db/player_statistics.rs"),
        include_str!("../../db/deletion.rs"),
        include_str!("../../db/export.rs"),
    ] {
        assert!(!production.contains("DatabaseFileTarget {"));
        assert!(!production.contains("assemble("));
    }
}

#[cfg(unix)]
#[test]
fn pgn_file_selected_through_symlinked_ancestor_is_stored_canonically_and_writable() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    let path = link.join("g.pgn");
    fs::write(real.join("g.pgn"), b"1. e4 *").unwrap();
    symlink(&real, &link).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let grant = authority
        .grant_dialog_operations(
            &path,
            "g.pgn",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    assert_eq!(
        authority.dialogs[&grant.id]
            .entry
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("g.pgn")
    );
    let committed = authority
        .promote_dialog(
            &grant,
            PathClass::PersistentFile,
            "g.pgn",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    assert_eq!(
        authority.persistent[&committed.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("g.pgn")
    );
    let mut resolved = authority
        .resolve(&committed.id, PathOperation::WritePgn, &[])
        .unwrap();
    let snapshot = resolved.pgn_snapshot().unwrap();
    let _ = resolved
        .replace_pgn_atomic(snapshot, &CancellationToken::new(), |_source, target| {
            target.write_all(b"1. d4 *").map_err(Error::from)
        })
        .unwrap();
    assert_eq!(fs::read(real.join("g.pgn")).unwrap(), b"1. d4 *");
}

#[cfg(unix)]
#[test]
fn picker_root_opening_book_and_migration_store_canonical_spellings() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    symlink(&real, &link).unwrap();
    fs::create_dir(real.join("db")).unwrap();
    fs::write(real.join("book.bin"), b"book").unwrap();
    fs::write(real.join("x.pgn"), b"*").unwrap();
    fs::create_dir(real.join("pz")).unwrap();
    fs::write(real.join("y.bin"), b"file").unwrap();

    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let database = authority
        .get_or_create_database_root(&link.join("db"), "Databases", None)
        .unwrap();
    assert_eq!(
        authority.persistent[&database.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("db")
    );
    let same_database = authority
        .get_or_create_database_root(&real.join("db"), "Databases", None)
        .unwrap();
    assert_eq!(same_database.id, database.id);
    authority
        .create_database_child(&database, OsStr::new("child.db3"))
        .unwrap();

    let opening_book = authority
        .register_opening_book(&link.join("book.bin"), "book")
        .unwrap();
    assert_eq!(
        authority.persistent[&opening_book.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("book.bin")
    );
    let same_book = authority
        .get_or_create_persistent_file(
            &real.join("book.bin"),
            "book",
            canonical_operations(EntryPurpose::OpeningBook),
        )
        .unwrap();
    assert_eq!(same_book.id, opening_book.id);

    let migrated = authority
        .migrate_legacy_os_path(
            link.join("x.pgn").into_os_string(),
            "x.pgn",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    assert_eq!(
        authority.persistent[&migrated.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("x.pgn")
    );

    let puzzle_real = authority
        .get_or_create_puzzle_root(&real.join("pz"), "Puzzles", None)
        .unwrap();
    let puzzle_link = authority
        .get_or_create_puzzle_root(&link.join("pz"), "Puzzles", None)
        .unwrap();
    assert_eq!(puzzle_link.id, puzzle_real.id);

    let file_real = authority
        .get_or_create_persistent_file(&real.join("y.bin"), "y.bin", vec![PathOperation::ReadPgn])
        .unwrap();
    let file_link = authority
        .get_or_create_persistent_file(&link.join("y.bin"), "y.bin", vec![PathOperation::ReadPgn])
        .unwrap();
    assert_eq!(file_link.id, file_real.id);
}

#[cfg(unix)]
#[test]
fn register_opening_book_mints_a_fresh_capability_for_a_replaced_file() {
    let dir = tempfile::tempdir().unwrap();
    let book = dir.path().join("book.bin");
    fs::write(&book, b"book").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let first = authority.register_opening_book(&book, "book").unwrap();
    let held = fs::File::open(&book).unwrap();
    let replacement = dir.path().join("book.replacement");
    fs::write(&replacement, b"replaced").unwrap();
    fs::rename(&replacement, &book).unwrap();
    let current = opened_file_identity(&fs::File::open(&book).unwrap()).unwrap();
    assert_ne!(current, opened_file_identity(&held).unwrap());
    let second = authority.register_opening_book(&book, "book").unwrap();
    assert_ne!(second, first);
    authority.opening_book_descriptor(&second).unwrap();
    let third = authority.register_opening_book(&book, "book").unwrap();
    assert_eq!(third, second);
}

#[cfg(unix)]
#[test]
fn root_failure_promotion_refuses_an_ancestor_swapped_after_grant() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    let moved = dir.path().join("moved");
    fs::create_dir(real.join("ws")).unwrap_or_else(|_| {
        fs::create_dir(&real).unwrap();
        fs::create_dir(real.join("ws")).unwrap();
    });
    symlink(&real, &link).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let grant = authority
        .grant_dialog_operations(
            &link.join("ws"),
            "Workspace",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    fs::rename(&real, &moved).unwrap();
    symlink(&moved, &real).unwrap();

    let error = authority
        .promote_dialog(
            &grant,
            PathClass::PersistentCustomRoot,
            "Workspace",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap_err();
    assert!(matches!(
        error.unlabelled(),
        Error::Conflict(message) if message == "dialog target changed before promotion"
    ));
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
    assert!(authority.persistent.is_empty());
}
#[test]
fn dialog_grants_enforce_operation_expiry_and_uses() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a");
    fs::write(&file, b"x").unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut a = authority(&dir, clock.clone());
    let id = a
        .grant_dialog(
            &file,
            "a",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(3),
            1,
        )
        .unwrap();
    let disallowed = a
        .resolve(&id, PathOperation::WritePgn, &[])
        .err()
        .expect("disallowed operation on a live grant must fail");
    assert!(
        matches!(disallowed, Error::InvalidInput(_)),
        "{disallowed:?}"
    );
    assert_eq!(disallowed.category(), ErrorCategory::InvalidInput);
    assert!(a.resolve(&id, PathOperation::ReadPgn, &[]).is_ok());
    assert!(a.resolve(&id, PathOperation::ReadPgn, &[]).is_err());
    let exp = a
        .grant_dialog(
            &file,
            "a",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(1),
            1,
        )
        .unwrap();
    clock.advance(1);
    assert!(a.resolve(&exp, PathOperation::ReadPgn, &[]).is_err());
}

#[test]
fn download_destination_is_operation_gated_and_never_exposes_a_path() {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(TestClock::new(1));
    let root = AppOwnedRoot::new(
        "downloads",
        dir.path().to_path_buf(),
        vec![PathOperation::DownloadFile],
    );
    let id = root.id.clone();
    let mut authority =
        PathAuthority::open_with_clock(dir.path().join("registry.json"), vec![root], clock, 2)
            .unwrap();
    assert!(authority
        .resolve(&id, PathOperation::ReadPgn, &["new.pgn".into()])
        .is_err());
    let destination = authority
        .resolve(&id, PathOperation::DownloadFile, &["new.pgn".into()])
        .unwrap();
    destination
        .atomic_replace_download(|file| file.write_all(b"download").map_err(Error::from))
        .unwrap()
        .expect_durable();
    assert_eq!(fs::read(dir.path().join("new.pgn")).unwrap(), b"download");
}

#[cfg(unix)]
#[test]
fn engine_install_marks_only_the_resolved_file_executable() {
    use std::os::unix::fs::MetadataExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("engine");
    fs::write(&path, b"engine").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let id = authority
        .grant_dialog(
            &path,
            "engine",
            PathClass::SingleDialogGrant,
            PathOperation::EngineInstall,
            Duration::from_secs(10),
            1,
        )
        .unwrap();
    authority
        .resolve(&id, PathOperation::EngineInstall, &[])
        .unwrap()
        .mark_engine_executable()
        .unwrap();
    assert_ne!(fs::metadata(&path).unwrap().mode() & 0o111, 0);
}

#[test]
fn pgn_atomic_precommit_reopens_target_and_rejects_external_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("game.pgn");
    fs::write(&path, b"old").unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut authority = authority(&dir, clock);
    let id = authority
        .grant_dialog(
            &path,
            "game",
            PathClass::SingleDialogGrant,
            PathOperation::WritePgn,
            Duration::from_secs(10),
            1,
        )
        .unwrap();
    let mut resolved = authority
        .resolve(&id, PathOperation::WritePgn, &[])
        .unwrap();
    let snapshot = resolved.pgn_snapshot().unwrap();
    let replacement = dir.path().join("replacement.pgn");
    fs::write(&replacement, b"external").unwrap();
    fs::rename(&replacement, &path).unwrap();
    assert!(resolved
        .replace_pgn_atomic(snapshot, &CancellationToken::new(), |_, temp| temp
            .write_all(b"new")
            .map_err(Error::from))
        .is_err());
    assert_eq!(fs::read(&path).unwrap(), b"external");
}

#[cfg(unix)]
#[test]
fn pgn_precommit_retains_parent_handle_and_intermediate_symlink_swap_cannot_overwrite() {
    let dir = tempfile::tempdir().unwrap();
    let slot = dir.path().join("slot");
    fs::create_dir(&slot).unwrap();
    let path = slot.join("game.pgn");
    fs::write(&path, b"old").unwrap();
    let attacker = dir.path().join("attacker");
    fs::create_dir(&attacker).unwrap();
    fs::write(attacker.join("game.pgn"), b"attacker").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let id = authority
        .grant_dialog(
            &path,
            "game",
            PathClass::SingleDialogGrant,
            PathOperation::WritePgn,
            Duration::from_secs(10),
            1,
        )
        .unwrap();
    let mut resolved = authority
        .resolve(&id, PathOperation::WritePgn, &[])
        .unwrap();
    let snapshot = resolved.pgn_snapshot().unwrap();
    fs::rename(&slot, dir.path().join("slot-old")).unwrap();
    std::os::unix::fs::symlink(&attacker, &slot).unwrap();
    assert!(resolved
        .replace_pgn_atomic(snapshot, &CancellationToken::new(), |_, temp| temp
            .write_all(b"new")
            .map_err(Error::from))
        .is_err());
    assert_eq!(fs::read(attacker.join("game.pgn")).unwrap(), b"attacker");
}

#[test]
fn pgn_workspace_grant_supports_count_read_and_mutate_lifecycle() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("game.pgn");
    fs::write(&path, b"[Event \"A\"]\n\n1. e4\n").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let id = authority
        .grant_dialog_operations(
            &path,
            "game",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(30),
            3,
        )
        .unwrap();
    assert!(authority.resolve(&id, PathOperation::ReadPgn, &[]).is_ok());
    assert!(authority.resolve(&id, PathOperation::ReadPgn, &[]).is_ok());
    assert!(authority.resolve(&id, PathOperation::WritePgn, &[]).is_ok());
    assert!(authority.resolve(&id, PathOperation::ReadPgn, &[]).is_err());
}

#[cfg(unix)]
#[test]
fn workspace_registry_never_binds_post_commit_replacements() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let path = workspace.join("game.pgn");
    fs::write(&path, b"original").unwrap();
    let original = identity(&path).unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog_operations(
            &workspace,
            "workspace",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let root = FileWorkspaceHandle::new(
        authority
            .promote_dialog(
                &grant,
                PathClass::PersistentCustomRoot,
                "workspace",
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap()
            .id,
    );

    fs::rename(&path, workspace.join("original.pgn")).unwrap();
    fs::write(&path, b"replacement").unwrap();
    let handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("game.pgn")],
            "game",
            (original.a, original.b),
            false,
            PathOperation::WritePgn,
        )
        .unwrap();

    assert!(matches!(
        authority.resolve(handle.path_ref(), PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));

    let source = workspace.join("source.pgn");
    fs::write(&source, b"move source").unwrap();
    let moved_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("source.pgn")],
            "source",
            observed_identity(&source),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let moved = workspace.join("moved.pgn");
    fs::rename(&source, &moved).unwrap();
    fs::rename(&moved, workspace.join("moved-original.pgn")).unwrap();
    fs::write(&moved, b"attacker replacement").unwrap();
    let moved_parent = crate::infra::fs::open_parent_no_follow(&moved).unwrap();
    authority
        .rebind_workspace_entry(
            &moved_handle,
            &moved,
            "moved",
            opened_file_identity(&moved_parent).unwrap(),
        )
        .unwrap();
    assert!(matches!(
        authority.resolve(moved_handle.path_ref(), PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
}

#[cfg(unix)]
#[test]
fn complete_workspace_directory_removal_prunes_descendants_even_when_commit_is_uncertain() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let victim = workspace.join("victim");
    fs::create_dir_all(victim.join("nested")).unwrap();
    fs::write(victim.join("nested/game.pgn"), b"*").unwrap();
    let executable = victim.join("nested/engine");
    fs::write(&executable, b"engine").unwrap();
    fs::write(workspace.join("sibling.pgn"), b"*").unwrap();
    let registry = dir.path().join("registry.json");
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let grant = authority
        .grant_dialog_operations(
            &workspace,
            "workspace",
            PathClass::BoundedDialogGrant,
            vec![
                PathOperation::ReadPgn,
                PathOperation::WritePgn,
                PathOperation::DatabaseRead,
                PathOperation::PuzzleRead,
                PathOperation::EngineInstall,
            ],
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let root = FileWorkspaceHandle::new(
        authority
            .promote_dialog(
                &grant,
                PathClass::PersistentCustomRoot,
                "workspace",
                vec![
                    PathOperation::ReadPgn,
                    PathOperation::WritePgn,
                    PathOperation::DatabaseRead,
                    PathOperation::PuzzleRead,
                    PathOperation::EngineInstall,
                ],
            )
            .unwrap()
            .id,
    );
    let victim_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("victim")],
            "victim",
            observed_identity(&victim),
            true,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let nested_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("victim"), OsString::from("nested")],
            "nested",
            observed_identity(&victim.join("nested")),
            true,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let game_handle = authority
        .register_workspace_child_observed(
            &root,
            &[
                OsString::from("victim"),
                OsString::from("nested"),
                OsString::from("game.pgn"),
            ],
            "game",
            observed_identity(&victim.join("nested/game.pgn")),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let sibling_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("sibling.pgn")],
            "sibling",
            observed_identity(&workspace.join("sibling.pgn")),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let engine_handle = authority
        .register_engine_file(&executable, "engine")
        .unwrap();
    fs::remove_dir_all(&victim).unwrap();

    authority.active_database_root = Some(victim_handle.path_ref().clone());
    authority.active_puzzle_root = Some(victim_handle.path_ref().clone());
    authority.active_engine_root = Some(victim_handle.path_ref().clone());
    authority.pending_artifacts.push(PendingArtifact {
        id: PathRef::fresh(),
        root: victim_handle.path_ref().clone(),
        filename: NativePath::from_path(Path::new("artifact.pgn")),
        display_name: "artifact".into(),
        operations: vec![PathOperation::ReadPgn],
        baseline: None,
        root_identity: None,
        payload_size: 0,
        payload_sha256: String::new(),
        payload_bound: false,
        installed_identity: None,
        installed_ctime_nanos: None,
    });

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "/private/registry: injected sync failure",
    ))));
    let mut dropped_engine_executables = Vec::new();
    let durability = authority
        .remove_workspace_entry(
            &victim_handle,
            WorkspaceRemovalStatus::Complete,
            &mut dropped_engine_executables,
        )
        .map(|(durability, _)| durability)
        .unwrap();
    set_test_atomic_file_injector(None);

    assert!(matches!(
        durability,
        CommitDurability::DurabilityUncertain(crate::error::DurabilityStage::RegistryReplacement)
    ));
    assert_eq!(dropped_engine_executables, vec![engine_handle.id]);
    for removed in [&victim_handle, &nested_handle, &game_handle] {
        assert!(!authority.persistent.contains_key(&removed.path_ref().id));
    }
    assert!(authority
        .persistent
        .contains_key(&sibling_handle.path_ref().id));

    let reloaded = PathAuthority::open(registry, vec![]).unwrap();
    for removed in [&victim_handle, &nested_handle, &game_handle] {
        assert!(!reloaded.persistent.contains_key(&removed.path_ref().id));
    }
    assert!(reloaded
        .persistent
        .contains_key(&sibling_handle.path_ref().id));
    assert_eq!(reloaded.active_database_root, None);
    assert_eq!(reloaded.active_puzzle_root, None);
    assert_eq!(reloaded.active_engine_root, None);
    assert!(reloaded.pending_artifacts.is_empty());
}

#[cfg(unix)]
#[test]
fn partial_workspace_directory_removal_keeps_survivors_and_prunes_missing_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("workspace");
    let victim = workspace.join("victim");
    fs::create_dir_all(&victim).unwrap();
    fs::write(victim.join("removed.pgn"), b"*").unwrap();
    fs::write(victim.join("survived.pgn"), b"*").unwrap();
    let removed_engine = victim.join("removed-engine");
    let survived_engine = victim.join("survived-engine");
    fs::write(&removed_engine, b"engine").unwrap();
    fs::write(&survived_engine, b"engine").unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog_operations(
            &workspace,
            "workspace",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let root = FileWorkspaceHandle::new(
        authority
            .promote_dialog(
                &grant,
                PathClass::PersistentCustomRoot,
                "workspace",
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap()
            .id,
    );
    let victim_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("victim")],
            "victim",
            observed_identity(&victim),
            true,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let removed_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("victim"), OsString::from("removed.pgn")],
            "removed",
            observed_identity(&victim.join("removed.pgn")),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let survived_handle = authority
        .register_workspace_child_observed(
            &root,
            &[OsString::from("victim"), OsString::from("survived.pgn")],
            "survived",
            observed_identity(&victim.join("survived.pgn")),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let removed_engine_handle = authority
        .register_engine_file(&removed_engine, "removed engine")
        .unwrap();
    let survived_engine_handle = authority
        .register_engine_file(&survived_engine, "survived engine")
        .unwrap();
    fs::remove_file(victim.join("removed.pgn")).unwrap();
    fs::remove_file(removed_engine).unwrap();

    let mut dropped_engine_executables = Vec::new();
    authority
        .remove_workspace_entry(
            &victim_handle,
            WorkspaceRemovalStatus::Partial,
            &mut dropped_engine_executables,
        )
        .map(|(durability, _)| durability)
        .unwrap();

    assert!(authority
        .persistent
        .contains_key(&victim_handle.path_ref().id));
    assert!(!authority
        .persistent
        .contains_key(&removed_handle.path_ref().id));
    assert!(authority
        .persistent
        .contains_key(&survived_handle.path_ref().id));
    assert_eq!(dropped_engine_executables, vec![removed_engine_handle.id]);
    assert!(authority
        .persistent
        .contains_key(&survived_engine_handle.id.id));
}

#[test]
fn candidate_commit_clears_removed_active_roots_and_their_pending_intents() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("root");
    fs::create_dir(&root_path).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .migrate_legacy_os_path(
            root_path.into_os_string(),
            "root",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::DownloadFile],
        )
        .unwrap();
    authority.active_database_root = Some(root.id.clone());
    authority.active_puzzle_root = Some(root.id.clone());
    authority.active_engine_root = Some(root.id.clone());
    authority.pending_artifacts.push(PendingArtifact {
        id: PathRef::fresh(),
        root: root.id.clone(),
        filename: NativePath::from_path(Path::new("artifact.pgn")),
        display_name: "artifact".into(),
        operations: vec![PathOperation::ReadPgn],
        baseline: None,
        root_identity: None,
        payload_size: 0,
        payload_sha256: String::new(),
        payload_bound: false,
        installed_identity: None,
        installed_ctime_nanos: None,
    });

    let mut dropped_engine_executables = Vec::new();
    authority
        .remove_workspace_entry(
            &FileWorkspaceHandle::new(root.id),
            WorkspaceRemovalStatus::Complete,
            &mut dropped_engine_executables,
        )
        .map(|(durability, _)| durability)
        .unwrap();

    assert_eq!(authority.active_database_root, None);
    assert_eq!(authority.active_puzzle_root, None);
    assert_eq!(authority.active_engine_root, None);
    assert!(authority.pending_artifacts.is_empty());
}

#[test]
fn serialized_handle_kinds_reject_cross_capability_deserialization() {
    let id = PathRef::fresh();
    let file = FileWorkspaceHandle::new(id.clone());
    let encoded = serde_json::to_value(file).unwrap();
    assert_eq!(encoded["kind"], "fileWorkspace");
    assert!(serde_json::from_value::<DatabaseHandle>(encoded).is_err());
}

#[test]
fn pgn_workspace_promotes_its_complete_granted_operation_set() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("game.pgn");
    fs::write(&path, b"game").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let id = authority
        .grant_dialog_operations(
            &path,
            "game",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(30),
            2,
        )
        .unwrap();
    let commit = authority
        .promote_dialog(
            &id,
            PathClass::PersistentFile,
            "game",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    assert!(authority
        .resolve(&commit.id, PathOperation::WritePgn, &[])
        .is_ok());
}

#[cfg(unix)]
#[test]
fn engine_resource_leases_pin_files_and_directories() {
    fn promote(
        authority: &mut PathAuthority,
        path: &Path,
        kind: EngineResourceHandleKind,
    ) -> EngineResourceHandle {
        let grant = authority
            .grant_dialog(
                path,
                "resource",
                PathClass::SingleDialogGrant,
                PathOperation::EngineResourceRead,
                Duration::from_secs(30),
                1,
            )
            .unwrap();
        authority
            .promote_engine_resource(&grant, kind, "resource")
            .unwrap()
    }

    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));

    let file = dir.path().join("network.nnue");
    fs::write(&file, b"original network").unwrap();
    let file_handle = promote(&mut authority, &file, EngineResourceHandleKind::File);
    let file_lease = authority.engine_resource(&file_handle).unwrap();
    fs::rename(&file, dir.path().join("network-original.nnue")).unwrap();
    fs::write(&file, b"attacker network").unwrap();
    #[cfg(target_os = "linux")]
    assert_eq!(
        fs::read(file_lease.uci_value().unwrap()).unwrap(),
        b"original network"
    );
    #[cfg(target_os = "macos")]
    {
        let launch_root = EngineLaunchRoot::for_test(dir.path()).unwrap();
        let mut leaf = launch_root
            .reserve_leaves(1, "resource-test", "resource")
            .unwrap()
            .pop()
            .unwrap();
        leaf.create_from(file_lease.file(), ENGINE_RESOURCE_LEAF_MODE, &|| false)
            .unwrap();
        file_lease.set_pinned_target(leaf.path()).unwrap();
        assert!(file_lease.verify_current().is_ok());
        let pinned_value = file_lease.uci_value().unwrap();
        let instance_path = launch_root.instance_path();
        assert!(Path::new(&pinned_value).starts_with(instance_path));
        assert_eq!(fs::read(pinned_value).unwrap(), b"original network");
        drop(leaf);
        assert_eq!(launch_root.reclaim().removed, 1);
    }
    assert!(matches!(
        authority.engine_resource(&file_handle),
        Err(Error::Conflict(_))
    ));

    let tables = dir.path().join("tables");
    fs::create_dir(&tables).unwrap();
    fs::write(tables.join("tablebase"), b"original table").unwrap();
    let directory_handle = promote(&mut authority, &tables, EngineResourceHandleKind::Directory);
    let directory_lease = authority.engine_resource(&directory_handle).unwrap();
    fs::rename(&tables, dir.path().join("tables-original")).unwrap();
    fs::create_dir(&tables).unwrap();
    fs::write(tables.join("tablebase"), b"attacker table").unwrap();
    #[cfg(target_os = "linux")]
    assert_eq!(
        fs::read(PathBuf::from(directory_lease.uci_value().unwrap()).join("tablebase")).unwrap(),
        b"original table"
    );
    #[cfg(target_os = "macos")]
    assert!(matches!(
        directory_lease.verify_current(),
        Err(Error::Conflict(message))
            if message == "engine resource changed after authorization"
    ));
    assert!(matches!(
        authority.engine_resource(&directory_handle),
        Err(Error::Conflict(_))
    ));
}

/// The child must be handed every resource lease *and* the engine image, and
/// the descriptors must be the ones the leases actually hold. Dropping the
/// image descriptor is what makes a wrapper-script engine fail to launch;
/// dropping a resource descriptor silently redirects the engine to whatever
/// the visible path now resolves to.
#[cfg(target_os = "linux")]
#[test]
fn inherited_descriptors_cover_every_resource_lease_and_the_engine_image() {
    use std::os::fd::AsRawFd;

    let dir = tempfile::tempdir().unwrap();
    let image = dir.path().join("engine");
    fs::write(&image, b"#!/bin/sh\n").unwrap();
    let first = dir.path().join("book.bin");
    fs::write(&first, b"book").unwrap();
    let second = dir.path().join("network.nnue");
    fs::write(&second, b"network").unwrap();

    let image_file = fs::File::open(&image).unwrap();
    let image_fd = image_file.as_raw_fd();
    let executable =
        EngineExecutable::test_fixture(image_file, dir.path().to_path_buf(), Vec::new());

    // No resource options configured: the image alone must still be inherited,
    // otherwise the interpreter cannot reopen a script engine.
    assert_eq!(executable.inherited_fds(), vec![image_fd]);
    let cwd_fd = executable.working_directory_fd();
    assert!(!executable.inherited_fds().contains(&cwd_fd));
    let flags = unsafe { libc::fcntl(cwd_fd, libc::F_GETFD) };
    assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);

    let leases = vec![
        EngineResourceLease::test_file(fs::File::open(&first).unwrap()),
        EngineResourceLease::test_file(fs::File::open(&second).unwrap()),
    ];
    let lease_fds: Vec<_> = leases.iter().map(|lease| lease.file.as_raw_fd()).collect();
    let executable = executable.with_resource_leases(leases.into_iter().map(Arc::new).collect());

    let inherited = executable.inherited_fds();
    assert_eq!(inherited, [lease_fds.as_slice(), &[image_fd]].concat());
    // Each inherited descriptor must still name the authorized inode.
    assert_eq!(
        fs::read(format!("/proc/self/fd/{}", inherited[0])).unwrap(),
        b"book"
    );
    assert_eq!(
        fs::read(format!("/proc/self/fd/{}", inherited[1])).unwrap(),
        b"network"
    );
}

#[test]
fn promoted_pgn_workspace_survives_restart_is_unbounded_and_rejects_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let path = dir.path().join("game.pgn");
    fs::write(&path, b"[Event \"A\"]\n\n1. e4\n").unwrap();

    let handle = {
        let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let grant = authority
            .grant_dialog_operations(
                &path,
                "game",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                Duration::from_secs(30 * 60),
                128,
            )
            .unwrap();
        FileWorkspaceHandle::new(
            authority
                .promote_dialog(
                    &grant,
                    PathClass::PersistentFile,
                    "game",
                    vec![PathOperation::ReadPgn, PathOperation::WritePgn],
                )
                .unwrap()
                .id,
        )
    };

    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    for _ in 0..129 {
        assert!(authority
            .resolve(handle.path_ref(), PathOperation::ReadPgn, &[])
            .is_ok());
    }
    assert!(authority
        .resolve(handle.path_ref(), PathOperation::WritePgn, &[])
        .is_ok());

    fs::rename(&path, dir.path().join("old-game.pgn")).unwrap();
    fs::write(&path, b"[Event \"replacement\"]\n\n1. d4\n").unwrap();
    assert!(matches!(
        authority.resolve(handle.path_ref(), PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
}

#[cfg(unix)]
#[test]
fn pgn_export_destination_through_symlinked_ancestor_is_stored_canonically() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    symlink(&real, &link).unwrap();
    let path = link.join("new.pgn");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    let destination = authority
        .create_pgn_export_destination(&path, "new.pgn")
        .unwrap();
    assert_eq!(
        authority.persistent[&destination.handle.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("new.pgn")
    );
    let mut resolved = authority
        .resolve(&destination.handle.id, PathOperation::WritePgn, &[])
        .unwrap();
    let snapshot = resolved.pgn_snapshot().unwrap();
    let _ = resolved
        .replace_pgn_atomic(snapshot, &CancellationToken::new(), |_source, target| {
            target.write_all(b"1. e4 *").map_err(Error::from)
        })
        .unwrap();
    assert_eq!(fs::read(real.join("new.pgn")).unwrap(), b"1. e4 *");
}

#[cfg(unix)]
#[test]
fn pgn_export_destination_reuses_an_existing_file_under_its_canonical_spelling() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("old.pgn"), b"sentinel").unwrap();
    symlink(&real, &link).unwrap();
    let path = link.join("old.pgn");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    let destination = authority
        .create_pgn_export_destination(&path, "old.pgn")
        .unwrap();
    assert_eq!(fs::read(real.join("old.pgn")).unwrap(), b"sentinel");
    assert_eq!(
        authority.persistent[&destination.handle.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("old.pgn")
    );
    let mut resolved = authority
        .resolve(&destination.handle.id, PathOperation::WritePgn, &[])
        .unwrap();
    let snapshot = resolved.pgn_snapshot().unwrap();
    let _ = resolved
        .replace_pgn_atomic(snapshot, &CancellationToken::new(), |_source, target| {
            target.write_all(b"1. c4 *").map_err(Error::from)
        })
        .unwrap();
    assert_eq!(fs::read(real.join("old.pgn")).unwrap(), b"1. c4 *");
}

#[cfg(unix)]
#[test]
fn descriptor_verified_registrations_keep_their_original_spelling_after_an_ancestor_swap() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let moved = dir.path().join("moved");
    fs::create_dir(real.join("db2")).unwrap_or_else(|_| {
        fs::create_dir(&real).unwrap();
        fs::create_dir(real.join("db2")).unwrap();
    });
    let database = authorize_existing_dir(&real.join("db2")).unwrap();
    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(0));
    fs::rename(&real, &moved).unwrap();
    symlink(&moved, &real).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(database.path(), "Databases", Some(database.identity()))
        .unwrap();
    assert_eq!(
        authority.persistent[&root.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        database.path()
    );
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 0);

    let image_dir_path = dir.path().join("image-real");
    let image_moved = dir.path().join("image-moved");
    fs::create_dir_all(&image_dir_path).unwrap();
    let image_dir = authorize_existing_dir(&image_dir_path).unwrap();
    let leaf = OsStr::new("uuid");
    fs::write(image_dir_path.join(leaf), b"image").unwrap();
    let installed = image_dir.open_leaf_identified(leaf).unwrap();
    fs::rename(&image_dir_path, &image_moved).unwrap();
    symlink(&image_moved, &image_dir_path).unwrap();
    let image = authority
        .register_engine_image(&image_dir, leaf, installed, "image".into())
        .unwrap();
    assert_eq!(
        authority.persistent[&image.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        image_dir.path().join(leaf)
    );
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 0);
}

#[cfg(unix)]
#[test]
fn leaf_symlinks_are_refused_for_dialog_grants() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real_file = dir.path().join("real-file");
    let real_dir = dir.path().join("real-dir");
    fs::write(&real_file, b"file").unwrap();
    fs::create_dir(&real_dir).unwrap();
    let file_link = dir.path().join("file-link");
    let dir_link = dir.path().join("dir-link");
    symlink(&real_file, &file_link).unwrap();
    symlink(&real_dir, &dir_link).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    for path in [&file_link, &dir_link] {
        assert!(matches!(
            authority.grant_dialog_operations(
                path,
                "selected",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn],
                Duration::from_secs(60),
                1,
            ),
            Err(Error::InvalidInput(_))
        ));
    }
}

#[cfg(unix)]
#[test]
fn leafless_dialog_selections_keep_their_original_spelling() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    fs::create_dir(&real).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    for path in [PathBuf::from("/"), real.join("..")] {
        let grant = authority
            .grant_dialog_operations(
                &path,
                "directory",
                PathClass::BoundedDialogGrant,
                vec![PathOperation::ReadPgn],
                Duration::from_secs(60),
                1,
            )
            .unwrap();
        let stored = &authority.dialogs[&grant.id].entry.stored;
        assert_eq!(stored.path.to_path().unwrap(), path);
        assert!(stored.target_is_dir);
    }
}

#[cfg(unix)]
#[test]
fn ancestor_swaps_during_acquisition_are_refused_before_registration() {
    use std::os::unix::fs::symlink;

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        let link = dir.path().join("link");
        let moved = dir.path().join("moved");
        fs::create_dir_all(real.join("ws")).unwrap();
        fs::create_dir(real.join("db")).unwrap();
        fs::write(real.join("x.pgn"), b"*").unwrap();
        symlink(&real, &link).unwrap();
        (dir, real, link, moved)
    }

    let (dir, real, link, moved) = fixture();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_real = real.clone();
    let hook_moved = moved.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&hook_real, &hook_moved).unwrap();
            symlink(&hook_moved, &hook_real).unwrap();
        })))
    });
    assert!(matches!(
        path_authority.grant_dialog_operations(
            &link.join("ws"),
            "Workspace",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn],
            Duration::from_secs(60),
            1,
        ),
        Err(Error::Io(_))
    ));
    assert!(path_authority.dialogs.is_empty());

    let (dir, real, link, moved) = fixture();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_real = real.clone();
    let hook_moved = moved.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&hook_real, &hook_moved).unwrap();
            symlink(&hook_moved, &hook_real).unwrap();
        })))
    });
    let error = path_authority
        .migrate_legacy_os_path(
            link.join("x.pgn").into_os_string(),
            "x.pgn",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap_err();
    assert!(matches!(error, Error::Io(_)));
    assert!(path_authority.persistent.is_empty());

    let (dir, real, link, moved) = fixture();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_real = real.clone();
    let hook_moved = moved.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&hook_real, &hook_moved).unwrap();
            symlink(&hook_moved, &hook_real).unwrap();
        })))
    });
    let error = path_authority
        .get_or_create_database_root(&link.join("db"), "Databases", None)
        .unwrap_err();
    assert!(matches!(error, Error::Io(_)));
    assert!(path_authority.persistent.is_empty());
}

#[cfg(unix)]
#[test]
fn promotion_refuses_a_different_leaf_inode_after_grant() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"original").unwrap();
    symlink(&real, &link).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let grant = authority
        .grant_dialog_operations(
            &link.join("g.pgn"),
            "g.pgn",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    // Create the replacement while the original still exists, so the filesystem cannot hand
    // the freed inode number back to it; the rename then swaps in a guaranteed different inode.
    let replacement = dir.path().join("replacement.pgn");
    fs::write(&replacement, b"replacement").unwrap();
    fs::rename(&replacement, real.join("g.pgn")).unwrap();
    assert!(matches!(
        authority.promote_dialog(
            &grant,
            PathClass::PersistentFile,
            "g.pgn",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        ),
        Err(ref error) if matches!(error.unlabelled(), Error::Conflict(message) if message == "dialog target changed before promotion")
    ));
    assert!(authority.persistent.is_empty());
}

#[cfg(unix)]
#[test]
fn promotion_conflict_removes_the_replaced_target_grant() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"original").unwrap();
    symlink(&real, &link).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let grant = authority
        .grant_dialog_operations(
            &link.join("g.pgn"),
            "g.pgn",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    let replacement = dir.path().join("replacement.pgn");
    fs::write(&replacement, b"replacement").unwrap();
    fs::rename(&replacement, real.join("g.pgn")).unwrap();

    assert!(matches!(
        authority.promote_dialog(
            &grant,
            PathClass::PersistentFile,
            "g.pgn",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        ),
        Err(ref error) if matches!(error.unlabelled(), Error::Conflict(message) if message == "dialog target changed before promotion")
    ));
    assert!(!authority.dialogs.contains_key(&grant.id));
}

#[cfg(unix)]
fn pgn_export_test_setup() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    let evil = dir.path().join("evil");
    fs::create_dir(&real).unwrap();
    fs::create_dir(&evil).unwrap();
    symlink(&real, &link).unwrap();
    (dir, real, link, evil)
}

#[cfg(unix)]
#[test]
fn pgn_export_refuses_a_parent_retargeted_before_canonicalisation() {
    use std::os::unix::fs::symlink;

    let (dir, _real, link, evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_link = link.clone();
    let hook_evil = evil.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::remove_file(&hook_link).unwrap();
            symlink(&hook_evil, &hook_link).unwrap();
        })))
    });
    assert!(matches!(
        auth.create_pgn_export_destination(&link.join("new2.pgn"), "new2.pgn"),
        Err(Error::Conflict(_))
    ));
    assert!(!evil.join("new2.pgn").exists());
}

#[cfg(unix)]
#[test]
fn pgn_export_refuses_a_parent_replaced_before_canonicalisation() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    let moved = dir.path().join("moved");
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_real = real.clone();
    let hook_moved = moved.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&hook_real, &hook_moved).unwrap();
            fs::create_dir(&hook_real).unwrap();
        })))
    });
    assert!(matches!(
        auth.create_pgn_export_destination(&link.join("new3.pgn"), "new3.pgn"),
        Err(Error::Conflict(_))
    ));
    assert!(!real.join("new3.pgn").exists());
    assert!(!moved.join("new3.pgn").exists());
}

#[cfg(unix)]
#[test]
fn pgn_export_reports_registration_and_removal_failures() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let before = auth.dialogs.len();
    let removal_guard = crate::infra::fs::scoped_test_removal_injector(Arc::new(RemovalFault(
        RemovalFaultPoint::BeforeTopOpen,
    )));
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let error = auth
        .create_pgn_export_destination(&link.join("cleanup-failed.pgn"), "cleanup-failed.pgn")
        .unwrap_err();
    set_test_atomic_file_injector(None);
    drop(removal_guard);

    assert!(real.join("cleanup-failed.pgn").exists());
    assert!(auth.persistent.is_empty());
    assert_eq!(auth.dialogs.len(), before);
    assert!(matches!(error, Error::OperationAndCleanup { .. }));
    let message = error.to_string();
    assert_eq!(message, "Operation failed; temporary cleanup also failed");
    assert!(!message.contains("/private/removal"));
    assert!(!message.contains(r"C:\private"));
    let diagnostic = error.diagnostic();
    let primary = Error::Io(Box::new(std::io::Error::other("write failed")));
    assert!(diagnostic.contains(&primary.diagnostic()), "{diagnostic}");
    assert!(
        diagnostic.contains("injected removal failure"),
        "{diagnostic}"
    );
}

#[cfg(unix)]
#[test]
fn pgn_export_returns_primary_after_removal_with_uncertain_parent_sync() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let before = auth.dialogs.len();
    let removal_guard = crate::infra::fs::scoped_test_removal_injector(Arc::new(RemovalFault(
        RemovalFaultPoint::ParentSync,
    )));
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let logs = crate::error::LogCaptureScope::start();
    let error = auth
        .create_pgn_export_destination(&link.join("parent-sync.pgn"), "parent-sync.pgn")
        .unwrap_err();
    set_test_atomic_file_injector(None);
    drop(removal_guard);

    assert!(!real.join("parent-sync.pgn").exists());
    assert!(auth.persistent.is_empty());
    assert_eq!(auth.dialogs.len(), before);
    assert!(matches!(error, Error::Io(_)));
    let records = logs.records();
    let export_warnings = records
        .iter()
        .filter(|record| {
            record.level == log::Level::Warn
                && record.message.contains("PGN export")
                && record.message.contains("parent sync is uncertain")
        })
        .collect::<Vec<_>>();
    assert_eq!(export_warnings.len(), 1, "{records:?}");
    assert!(export_warnings[0].message.contains("was removed"));
    assert!(
        records.iter().all(|record| {
            record.level != log::Level::Error || !record.message.contains("PGN export")
        }),
        "{records:?}"
    );
}

#[cfg(unix)]
#[test]
fn pgn_export_returns_primary_when_created_leaf_is_already_gone() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let before = auth.dialogs.len();
    let hook_path = real.join("already-gone.pgn");
    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::remove_file(hook_path).unwrap();
        })))
    });
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let error = auth
        .create_pgn_export_destination(&link.join("already-gone.pgn"), "already-gone.pgn")
        .unwrap_err();
    set_test_atomic_file_injector(None);
    set_test_removal_injector(None);

    assert!(matches!(error, Error::Io(_)));
    assert!(!matches!(error, Error::OperationAndCleanup { .. }));
    assert!(!real.join("already-gone.pgn").exists());
    assert!(auth.persistent.is_empty());
    assert_eq!(auth.dialogs.len(), before);
}

#[cfg(unix)]
#[test]
fn pgn_export_cleans_up_created_files_descriptor_relatively_after_failure() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let before = auth.dialogs.len();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let error = auth
        .create_pgn_export_destination(&link.join("new4.pgn"), "new4.pgn")
        .unwrap_err();
    set_test_atomic_file_injector(None);
    assert!(matches!(error, Error::Io(_)));
    assert!(!real.join("new4.pgn").exists());
    assert_eq!(auth.dialogs.len(), before);

    let (dir, real, link, _evil) = pgn_export_test_setup();
    let moved = dir.path().join("moved");
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_real = real.clone();
    let hook_moved = moved.clone();
    let hook_path = real.join("new4b.pgn");
    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&hook_real, &hook_moved).unwrap();
            fs::create_dir(&hook_real).unwrap();
            fs::write(hook_real.join("new4b.pgn"), b"sentinel").unwrap();
        })))
    });
    assert!(auth
        .create_pgn_export_destination(&link.join("new4b.pgn"), "new4b.pgn")
        .is_err());
    assert!(!moved.join("new4b.pgn").exists());
    assert_eq!(fs::read(&hook_path).unwrap(), b"sentinel");
}

#[cfg(unix)]
#[test]
fn pgn_export_preserves_an_existing_destination_after_promotion_failure() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    fs::write(real.join("keep.pgn"), b"sentinel").unwrap();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let before = auth.dialogs.len();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(auth
        .create_pgn_export_destination(&link.join("keep.pgn"), "keep.pgn")
        .is_err());
    set_test_atomic_file_injector(None);
    assert_eq!(fs::read(real.join("keep.pgn")).unwrap(), b"sentinel");
    assert_eq!(auth.dialogs.len(), before);
}

#[cfg(unix)]
#[test]
fn pgn_export_refuses_a_trailing_separator_destination() {
    let (dir, real, _link, _evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    assert!(matches!(
        auth.create_pgn_export_destination(&real.join("export.pgn/"), "export.pgn"),
        Err(Error::InvalidInput(message))
            if message == "PGN export destination must have a .pgn filename"
    ));
    assert!(!real.join("export.pgn").exists());
}

#[cfg(unix)]
#[test]
fn pgn_export_preserves_a_replaced_created_leaf_after_failure() {
    let (dir, real, link, _evil) = pgn_export_test_setup();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    let hook_path = real.join("new5.pgn");
    let replacement_path = hook_path.clone();
    let replacement = real.join("replacement.pgn");
    // Allocate the replacement before removing the original to prevent inode reuse.
    fs::write(&replacement, b"sentinel").unwrap();
    PGN_EXPORT_POST_CREATE_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&replacement, &replacement_path).unwrap();
        })))
    });
    let error = auth
        .create_pgn_export_destination(&link.join("new5.pgn"), "new5.pgn")
        .unwrap_err();
    set_test_atomic_file_injector(None);
    set_test_removal_injector(None);
    assert_eq!(fs::read(&hook_path).unwrap(), b"sentinel");
    assert!(auth.persistent.is_empty());
    assert!(auth.dialogs.is_empty());
    assert!(matches!(error, Error::OperationAndCleanup { .. }));
}

#[cfg(unix)]
#[test]
fn pgn_export_refuses_symlink_and_directory_leaves() {
    use std::os::unix::fs::symlink;

    let (dir, real, link, _evil) = pgn_export_test_setup();
    let target = real.join("target.pgn");
    fs::write(&target, b"target").unwrap();
    symlink(&target, real.join("sym.pgn")).unwrap();
    fs::create_dir(real.join("dir.pgn")).unwrap();
    let mut auth = authority(&dir, Arc::new(TestClock::new(0)));
    for leaf in ["sym.pgn", "dir.pgn"] {
        assert!(matches!(
            auth.create_pgn_export_destination(&link.join(leaf), leaf),
            Err(Error::InvalidInput(message))
                if message == "PGN export destination must be a regular file"
        ));
    }
    assert_eq!(fs::read(&target).unwrap(), b"target");
    assert!(auth.persistent.is_empty());
    assert!(auth.dialogs.is_empty());
}

#[cfg(unix)]
#[test]
fn root_registration_acquires_once_per_fresh_spelling() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::create_dir(real.join("db3")).unwrap();
    symlink(&real, &link).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(0));
    authority
        .get_or_create_database_root(&link.join("db3"), "Databases", None)
        .unwrap();
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 1);
    authority
        .get_or_create_database_root(&real.join("db3"), "Databases", None)
        .unwrap();
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 2);
}

#[cfg(unix)]
#[test]
fn shape_checks_precede_filesystem_access_for_all_acquisition_doors() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    let missing = dir.path().join("missing");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(0));
    assert!(matches!(
        authority.grant_dialog_operations(
            &missing,
            "missing",
            PathClass::SingleDialogGrant,
            vec![PathOperation::ReadPgn],
            Duration::from_secs(60),
            2,
        ),
        Err(Error::InvalidInput(message)) if message == "invalid dialog grant shape"
    ));
    assert!(matches!(
        authority.migrate_legacy_os_path(
            missing.clone().into_os_string(),
            "missing",
            PathClass::PersistentFile,
            vec![],
        ),
        Err(Error::InvalidInput(message)) if message == "persistent operations cannot be empty"
    ));
    assert!(matches!(
        authority.get_or_create_persistent_file(&missing, "missing", vec![]),
        Err(Error::InvalidInput(message)) if message == "persistent operations cannot be empty"
    ));
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 0);

    let grant = authority
        .grant_dialog_operations(
            &link.join("g.pgn"),
            "g.pgn",
            PathClass::BoundedDialogGrant,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    let calls_before_promotion = ACQUIRE_TARGET_CALLS.with(|calls| calls.get());
    fs::remove_file(real.join("g.pgn")).unwrap();
    assert!(matches!(
        authority.promote_dialog(
            &grant,
            PathClass::SingleDialogGrant,
            "g.pgn",
            vec![PathOperation::ReadPgn],
        ),
        Err(Error::InvalidInput(message)) if message == "promotion target must be persistent"
    ));
    assert!(matches!(
        authority.promote_dialog(
            &grant,
            PathClass::PersistentFile,
            "g.pgn",
            vec![],
        ),
        Err(Error::InvalidInput(message)) if message == "persistent operations cannot be empty"
    ));
    assert_eq!(
        ACQUIRE_TARGET_CALLS.with(|calls| calls.get()),
        calls_before_promotion
    );
}
#[test]
fn capacity_evicts_oldest_not_every_grant() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("a");
    fs::write(&f, b"x").unwrap();
    let c = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, c);
    let first = a
        .grant_dialog(
            &f,
            "1",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(9),
            2,
        )
        .unwrap();
    let second = a
        .grant_dialog(
            &f,
            "2",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(9),
            2,
        )
        .unwrap();
    let third = a
        .grant_dialog(
            &f,
            "3",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(9),
            2,
        )
        .unwrap();
    assert!(a.resolve(&first, PathOperation::ReadPgn, &[]).is_err());
    assert!(a.resolve(&second, PathOperation::ReadPgn, &[]).is_ok());
    assert!(a.resolve(&third, PathOperation::ReadPgn, &[]).is_ok());
}
// The non-UTF-8 name is the point of this test, and APFS cannot store non-UTF-8 file names.
#[cfg(not(target_os = "macos"))]
#[test]
fn persistent_identity_reload_and_native_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let name = OsString::from_vec(vec![b'f', 0x80]);
    let f = dir.path().join(&name);
    fs::write(&f, b"x").unwrap();
    let c = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, c.clone());
    let id = a
        .migrate_legacy_os_path(
            f.clone().into_os_string(),
            "non utf8",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    drop(a);
    let mut a = authority(&dir, c);
    assert!(a.resolve(&id, PathOperation::ReadPgn, &[]).is_ok());
    fs::rename(&f, dir.path().join("previous-object")).unwrap();
    fs::write(&f, b"replacement").unwrap();
    assert!(a.resolve(&id, PathOperation::ReadPgn, &[]).is_err());
    assert_eq!(
        a.descriptors()
            .into_iter()
            .find(|d| d.id == id)
            .unwrap()
            .availability,
        PathAvailability::Unavailable
    );
}

#[cfg(unix)]
#[test]
fn opened_file_identity_retains_the_original_directory_after_pathname_swap() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("directory");
    let original_path = dir.path().join("directory-original");
    fs::create_dir(&path).unwrap();
    let opened = fs::File::open(&path).unwrap();
    let original_identity = opened_file_identity(&opened).unwrap();

    fs::rename(&path, &original_path).unwrap();
    fs::create_dir(&path).unwrap();
    let replacement = fs::File::open(&path).unwrap();
    let replacement_identity = opened_file_identity(&replacement).unwrap();

    assert_ne!(original_identity, replacement_identity);
    assert_eq!(opened_file_identity(&opened).unwrap(), original_identity);
}
#[test]
fn unicode_promotion_consumes_the_exact_dialog_grant() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Schach ♞");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, clock);
    let dialog = a
        .grant_dialog(
            &root,
            "Schach ♞",
            PathClass::SingleDialogGrant,
            PathOperation::DatabaseRead,
            Duration::from_secs(10),
            1,
        )
        .unwrap();
    let promoted = a
        .promote_dialog(
            &dialog,
            PathClass::PersistentCustomRoot,
            "Schach ♞",
            vec![PathOperation::DatabaseRead],
        )
        .unwrap();
    assert!(a
        .resolve(&dialog, PathOperation::DatabaseRead, &[])
        .is_err());
    assert!(a
        .resolve(&promoted, PathOperation::DatabaseRead, &[])
        .is_ok());
    let reloaded = PathAuthority::open_with_clock(
        dir.path().join("registry.json"),
        vec![],
        Arc::new(TestClock::new(0)),
        2,
    )
    .unwrap();
    assert_eq!(
        reloaded.persistent[&promoted.id.id]
            .stored
            .path
            .to_path()
            .unwrap(),
        root
    );
}
#[test]
fn promotion_rejects_empty_or_escalating_operations_and_single_grants_cannot_be_multi_use() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a");
    fs::write(&file, b"x").unwrap();
    let clock = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, clock);
    assert!(a
        .grant_dialog(
            &file,
            "bad",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(1),
            2
        )
        .is_err());
    let id = a
        .grant_dialog(
            &file,
            "a",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(10),
            1,
        )
        .unwrap();
    assert!(a
        .promote_dialog(&id, PathClass::PersistentFile, "a", vec![])
        .is_err());
    assert!(a
        .promote_dialog(
            &id,
            PathClass::PersistentFile,
            "a",
            vec![PathOperation::WritePgn]
        )
        .is_err());
    assert!(!a.dialogs.contains_key(&id.id));
}
#[test]
fn invalid_grant_does_not_evict_live_capacity_and_descriptors_revalidate() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a");
    fs::write(&file, b"x").unwrap();
    let clock = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, clock.clone());
    let one = a
        .grant_dialog(
            &file,
            "one",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(2),
            2,
        )
        .unwrap();
    let two = a
        .grant_dialog(
            &file,
            "two",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(2),
            2,
        )
        .unwrap();
    assert!(a
        .grant_dialog(
            dir.path().join("missing").as_path(),
            "bad",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(2),
            2
        )
        .is_err());
    assert!(a.resolve(&one, PathOperation::ReadPgn, &[]).is_ok());
    assert!(a.resolve(&two, PathOperation::ReadPgn, &[]).is_ok());
    let exp = a
        .grant_dialog(
            &file,
            "exp",
            PathClass::BoundedDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(1),
            2,
        )
        .unwrap();
    clock.advance(1);
    assert!(!a.descriptors().iter().any(|d| d.id == exp));
    let persistent = a
        .migrate_legacy_os_path(
            file.clone().into_os_string(),
            "a",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    fs::remove_file(&file).unwrap();
    assert_eq!(
        a.descriptors()
            .into_iter()
            .find(|d| d.id == persistent)
            .unwrap()
            .availability,
        PathAvailability::Unavailable
    );
}
#[test]
fn failed_persistence_keeps_memory_and_consumes_dialog_grant() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a");
    fs::write(&file, b"x").unwrap();
    let clock = Arc::new(TestClock::new(0));
    let mut a = PathAuthority::open_with_clock(
        dir.path().join("missing-parent/registry.json"),
        vec![],
        clock,
        2,
    )
    .unwrap();
    assert!(a
        .migrate_legacy_os_path(
            file.clone().into_os_string(),
            "a",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn]
        )
        .is_err());
    assert!(a.persistent.is_empty());
    let dialog = a
        .grant_dialog(
            &file,
            "a",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(2),
            1,
        )
        .unwrap();
    assert!(a
        .promote_dialog(
            &dialog,
            PathClass::PersistentFile,
            "a",
            vec![PathOperation::ReadPgn]
        )
        .is_err());
    assert!(a.persistent.is_empty());
    assert!(!a.dialogs.contains_key(&dialog.id));
}
#[test]
fn rejects_traversal_symlink_and_special_components() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("ok"), b"x").unwrap();
    std::os::unix::fs::symlink("ok", root.join("link")).unwrap();
    let c = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, c);
    let id = a
        .migrate_legacy_os_path(
            root.into_os_string(),
            "root",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    assert!(a
        .resolve(&id, PathOperation::ReadPgn, &[OsString::from("..")])
        .is_err());
    assert!(a
        .resolve(&id, PathOperation::ReadPgn, &[OsString::from("bad/name")])
        .is_err());
    assert!(a
        .resolve(&id, PathOperation::ReadPgn, &[OsString::from("link")])
        .is_err());
    assert!(a
        .resolve(&id, PathOperation::ReadPgn, &[OsString::from("ok")])
        .is_ok());
}
#[test]
fn rejects_symlink_root_and_detects_leaf_replacement_after_resolution() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    fs::create_dir(&target).unwrap();
    let link = dir.path().join("root-link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let clock = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, clock);
    assert!(a
        .migrate_legacy_os_path(
            link.into_os_string(),
            "link",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn],
        )
        .is_err());
    let file = target.join("leaf");
    fs::write(&file, b"old").unwrap();
    let id = a
        .migrate_legacy_os_path(
            target.into_os_string(),
            "target",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let mut resolved = a
        .resolve(&id, PathOperation::ReadPgn, &[OsString::from("leaf")])
        .unwrap();
    fs::remove_file(&file).unwrap();
    fs::write(&file, b"replacement").unwrap();
    assert_eq!(resolved.read_bytes().unwrap(), b"old");
}
#[test]
fn read_capability_cannot_reach_a_sibling() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("readable");
    let sibling = dir.path().join("sibling");
    fs::write(&file, b"read").unwrap();
    fs::write(&sibling, b"sibling").unwrap();
    let mut a = authority(&dir, Arc::new(TestClock::new(0)));
    let id = a
        .migrate_legacy_os_path(
            file.into_os_string(),
            "readable",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let mut resolved = a.resolve(&id, PathOperation::ReadPgn, &[]).unwrap();
    assert_eq!(resolved.read_bytes().unwrap(), b"read");
    assert_eq!(fs::read(sibling).unwrap(), b"sibling");
}
#[test]
fn app_owned_descriptor_revalidates_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("app");
    fs::create_dir(&root).unwrap();
    let app = AppOwnedRoot::new("app", root.clone(), vec![PathOperation::LogWrite]);
    let id = app.id.clone();
    let mut a = PathAuthority::open_with_clock(
        dir.path().join("registry.json"),
        vec![app],
        Arc::new(TestClock::new(0)),
        2,
    )
    .unwrap();
    fs::rename(&root, dir.path().join("old-app")).unwrap();
    fs::create_dir(&root).unwrap();
    assert_eq!(
        a.descriptors()
            .into_iter()
            .find(|d| d.id == id)
            .unwrap()
            .availability,
        PathAvailability::Unavailable
    );
}
#[test]
fn unknown_schema_and_atomic_failure_preserve_old_registry() {
    let dir = tempfile::tempdir().unwrap();
    let reg = dir.path().join("registry.json");
    fs::write(&reg, b"{\"schema_version\":99,\"entries\":[]}").unwrap();
    assert!(PathAuthority::open(reg.clone(), vec![]).is_err());
    fs::remove_file(&reg).unwrap();
    let c = Arc::new(TestClock::new(0));
    let mut a = authority(&dir, c);
    let f = dir.path().join("a");
    fs::write(&f, b"x").unwrap();
    a.migrate_legacy_os_path(
        f.clone().into_os_string(),
        "a",
        PathClass::PersistentFile,
        vec![PathOperation::ReadPgn],
    )
    .unwrap();
    let before = fs::read(&reg).unwrap();
    struct Fail;
    impl AtomicWriterInjector for Fail {
        fn inject(&self, p: AtomicFileFaultPoint) -> std::io::Result<()> {
            if p == AtomicFileFaultPoint::Write {
                Err(std::io::Error::other("fail"))
            } else {
                Ok(())
            }
        }
    }
    set_test_atomic_file_injector(Some(Arc::new(Fail)));
    assert!(a.save().is_err());
    set_test_atomic_file_injector(None);
    assert_eq!(fs::read(&reg).unwrap(), before);
    struct Uncertain;
    impl AtomicWriterInjector for Uncertain {
        fn inject(&self, p: AtomicFileFaultPoint) -> std::io::Result<()> {
            if p == AtomicFileFaultPoint::ParentSync {
                Err(std::io::Error::other(
                    "/private/registry: raw operating system failure",
                ))
            } else {
                Ok(())
            }
        }
    }
    set_test_atomic_file_injector(Some(Arc::new(Uncertain)));
    let durability = a.save().expect("uncertain registry commit");
    set_test_atomic_file_injector(None);
    assert_eq!(
        serde_json::to_string(&durability).expect("serialize durability"),
        r#"{"DurabilityUncertain":"RegistryReplacement"}"#
    );
}
#[test]
fn persisted_transient_or_invalid_entries_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let reg = dir.path().join("registry.json");
    fs::write(&reg, br#"{"schema_version":1,"entries":[{"id":"forged","display_name":"forged","class":"singleDialogGrant","operations":["readPgn"],"path":{"platform":"unix","bytes":"L3RtcA"},"identity":{"a":1,"b":1},"target_is_dir":false}]}"#).unwrap();
    assert!(PathAuthority::open(reg, vec![]).is_err());
}
#[test]
fn zero_dialog_capacity_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    assert!(PathAuthority::open_with_clock(
        dir.path().join("registry.json"),
        vec![],
        Arc::new(TestClock::new(0)),
        0
    )
    .is_err());
}
#[test]
fn uncertain_commit_keeps_candidate_and_consumes_promoted_grant() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a");
    fs::write(&file, b"x").unwrap();
    let mut a = authority(&dir, Arc::new(TestClock::new(0)));
    let dialog = a
        .grant_dialog(
            &file,
            "a",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(5),
            1,
        )
        .unwrap();
    let id = PathRef::fresh();
    let stored = StoredEntry {
        id: id.clone(),
        display_name: "a".into(),
        class: PathClass::PersistentFile,
        purpose: None,
        operations: vec![PathOperation::ReadPgn],
        path: NativePath::from_path(&file),
        identity: identity(&file).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    let mut candidate = a.persistent.clone();
    candidate.insert(
        id.id.clone(),
        Entry {
            stored,
            availability: PathAvailability::Available,
        },
    );
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    assert!(matches!(
        a.commit_candidate(candidate, Some(&dialog)).unwrap(),
        CommitDurability::DurabilityUncertain(_)
    ));
    set_test_atomic_file_injector(None);
    assert!(a.persistent.contains_key(&id.id));
    assert!(!a.dialogs.contains_key(&dialog.id));
    assert!(a.resolve(&dialog, PathOperation::ReadPgn, &[]).is_err());
    let reloaded = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(reloaded.persistent.contains_key(&id.id));
}

#[test]
fn pending_download_artifact_recovers_an_atomic_install_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("downloads");
    fs::create_dir(&root).unwrap();
    let app_root = AppOwnedRoot::new("downloads", root.clone(), vec![PathOperation::DownloadFile]);
    let root_id = app_root.id.clone();
    let registry = dir.path().join("registry.json");
    let staged = dir.path().join("staged.pgn");
    fs::write(&staged, b"1. e4").unwrap();
    let reservation = {
        let mut authority = PathAuthority::open(registry.clone(), vec![app_root.clone()]).unwrap();
        let reservation = authority
            .reserve_download_artifact(
                &root_id,
                OsString::from("games.pgn"),
                sha256_file(&staged).unwrap(),
                "games.pgn",
                vec![PathOperation::ReadPgn],
            )
            .unwrap();
        authority
            .resolve(
                &root_id,
                PathOperation::DownloadFile,
                &[OsString::from("games.pgn")],
            )
            .unwrap()
            .atomic_replace_download(|file| file.write_all(b"1. e4").map_err(Error::from))
            .unwrap()
            .expect_durable();
        authority
            .mark_download_artifact_committed(
                &reservation,
                {
                    let identity = identity(&root.join("games.pgn")).unwrap();
                    (identity.a, identity.b)
                },
                {
                    use std::os::unix::fs::MetadataExt;
                    let metadata = fs::metadata(root.join("games.pgn")).unwrap();
                    i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec())
                },
            )
            .unwrap();
        reservation
    };
    let mut recovered = PathAuthority::open(registry, vec![app_root]).unwrap();
    let mut artifact = recovered
        .resolve(&reservation.id, PathOperation::ReadPgn, &[])
        .unwrap();
    assert_eq!(artifact.read_bytes().unwrap(), b"1. e4");
    assert!(recovered
        .resolve(&reservation.id, PathOperation::DownloadFile, &[])
        .is_err());
    assert!(recovered.pending_artifacts.is_empty());
}

#[test]
fn reserved_download_rejects_changed_payload_before_publication() {
    for replacement in [b"1. d4".as_slice(), b"1. d4 d5".as_slice()] {
        for existing in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root_path = dir.path().join("downloads");
            fs::create_dir(&root_path).unwrap();
            let app_root = AppOwnedRoot::new(
                "downloads",
                root_path.clone(),
                vec![PathOperation::DownloadFile],
            );
            let root = app_root.id.clone();
            let mut authority =
                PathAuthority::open(dir.path().join("registry.json"), vec![app_root]).unwrap();
            let target = root_path.join("games.pgn");
            if existing {
                fs::write(&target, b"previous bytes").unwrap();
            }
            let staged = dir.path().join("staged.pgn");
            fs::write(&staged, b"1. e4").unwrap();
            let reservation = authority
                .reserve_download_artifact(
                    &root,
                    OsString::from("games.pgn"),
                    sha256_file(&staged).unwrap(),
                    "games.pgn",
                    canonical_operations(EntryPurpose::PgnReadOnlyFile),
                )
                .unwrap();
            let resolved = authority
                .resolve(
                    &root,
                    PathOperation::DownloadFile,
                    &[OsString::from("games.pgn")],
                )
                .unwrap();
            let mut payload = tempfile::tempfile().unwrap();
            payload.write_all(replacement).unwrap();
            let result = resolved.atomic_install_reserved_download(&reservation, &mut payload);
            assert!(
                matches!(&result, Err(Error::Conflict(message))
                        if message == "staging payload changed after artifact reservation"),
                "replacement={replacement:?}, existing={existing}, result={result:?}"
            );
            if existing {
                assert_eq!(fs::read(&target).unwrap(), b"previous bytes");
            } else {
                assert!(!target.exists());
            }
        }
    }
}

fn install_read_only_download_fixture(
    authority: &mut PathAuthority,
    root: &PathRef,
    filename: &str,
    staged: &Path,
) -> PathRef {
    let reservation = authority
        .reserve_download_artifact(
            root,
            OsString::from(filename),
            sha256_file(staged).unwrap(),
            filename,
            canonical_operations(EntryPurpose::PgnReadOnlyFile),
        )
        .unwrap();
    let resolved = authority
        .resolve(
            root,
            PathOperation::DownloadFile,
            &[OsString::from(filename)],
        )
        .unwrap();
    let installed = resolved
        .atomic_install_reserved_download(&reservation, &mut fs::File::open(staged).unwrap())
        .unwrap();
    authority
        .mark_download_artifact_committed(&reservation, installed.identity, installed.ctime_nanos)
        .unwrap();
    authority
        .activate_download_artifact(&reservation)
        .unwrap()
        .handle
        .id
}

#[test]
fn finalized_read_only_pgn_downloads_reload_and_follow_startup_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("downloads");
    fs::create_dir(&root_path).unwrap();
    let app_root = AppOwnedRoot::new(
        "downloads",
        root_path.clone(),
        vec![PathOperation::DownloadFile],
    );
    let root = app_root.id.clone();
    let registry = dir.path().join("registry.json");
    let orphan_staged = dir.path().join("orphan-staged.pgn");
    let retained_staged = dir.path().join("retained-staged.pgn");
    fs::write(&orphan_staged, b"1. e4").unwrap();
    fs::write(&retained_staged, b"1. d4").unwrap();
    let (orphan, retained) = {
        let mut authority = PathAuthority::open(registry.clone(), vec![app_root.clone()]).unwrap();
        let orphan =
            install_read_only_download_fixture(&mut authority, &root, "orphan.pgn", &orphan_staged);
        let retained = install_read_only_download_fixture(
            &mut authority,
            &root,
            "retained.pgn",
            &retained_staged,
        );
        (orphan, retained)
    };

    let mut authority = PathAuthority::open(registry, vec![app_root]).unwrap();
    for id in [&orphan, &retained] {
        assert_eq!(
            authority.persistent[&id.id].stored.purpose,
            Some(EntryPurpose::PgnReadOnlyFile)
        );
        assert_eq!(
            authority.persistent[&id.id].stored.operations,
            canonical_operations(EntryPurpose::PgnReadOnlyFile)
        );
        assert!(authority.resolve(id, PathOperation::ReadPgn, &[]).is_ok());
        assert!(authority.resolve(id, PathOperation::WritePgn, &[]).is_err());
    }
    // Resolve marks successful use as session-owned. Reload once more so the ownership sweep
    // observes both records strictly as startup candidates.
    let registry = authority.registry_path.clone();
    drop(authority);
    let mut authority = PathAuthority::open(
        registry,
        vec![AppOwnedRoot::new(
            "downloads",
            root_path.clone(),
            vec![PathOperation::DownloadFile],
        )],
    )
    .unwrap();
    authority
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![retained.clone()],
            trusted_families: vec![
                PathOwnerFamily::FileWorkspace,
                PathOwnerFamily::RecentFiles,
                PathOwnerFamily::SessionWorkspace,
                PathOwnerFamily::ExpandedDirectories,
                PathOwnerFamily::PracticeDeck,
            ],
        })
        .unwrap();
    assert!(!authority.persistent.contains_key(&orphan.id));
    assert!(authority.persistent.contains_key(&retained.id));
    assert_eq!(fs::read(root_path.join("orphan.pgn")).unwrap(), b"1. e4");
    assert_eq!(fs::read(root_path.join("retained.pgn")).unwrap(), b"1. d4");
}

#[test]
fn pending_artifact_never_activates_a_substituted_payload_after_restart() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("downloads");
    fs::create_dir(&root).unwrap();
    let app_root = AppOwnedRoot::new("downloads", root.clone(), vec![PathOperation::DownloadFile]);
    let registry = dir.path().join("registry.json");
    let staged = dir.path().join("staged.pgn");
    fs::write(&staged, b"expected").unwrap();
    let reservation = {
        let mut authority = PathAuthority::open(registry.clone(), vec![app_root.clone()]).unwrap();
        authority
            .reserve_download_artifact(
                &app_root.id,
                OsString::from("games.pgn"),
                sha256_file(&staged).unwrap(),
                "games.pgn",
                vec![PathOperation::ReadPgn],
            )
            .unwrap()
    };
    fs::write(root.join("games.pgn"), b"substituted").unwrap();
    let mut recovered = PathAuthority::open(registry, vec![app_root]).unwrap();
    assert!(recovered
        .pending_artifacts
        .iter()
        .any(|item| item.id == reservation.id));
    assert!(recovered.activate_download_artifact(&reservation).is_err());
    assert!(!recovered.persistent.contains_key(&reservation.id.id));
}

#[test]
fn post_rename_marker_rejects_a_byte_identical_external_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("downloads");
    fs::create_dir(&root).unwrap();
    let app_root = AppOwnedRoot::new("downloads", root.clone(), vec![PathOperation::DownloadFile]);
    let registry = dir.path().join("registry.json");
    let staged = dir.path().join("staged.pgn");
    fs::write(&staged, b"same bytes").unwrap();
    let mut authority = PathAuthority::open(registry, vec![app_root.clone()]).unwrap();
    let reservation = authority
        .reserve_download_artifact(
            &app_root.id,
            OsString::from("games.pgn"),
            sha256_file(&staged).unwrap(),
            "games.pgn",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    authority
        .resolve(
            &app_root.id,
            PathOperation::DownloadFile,
            &[OsString::from("games.pgn")],
        )
        .unwrap()
        .atomic_install_reserved_download(&reservation, &mut fs::File::open(&staged).unwrap())
        .unwrap();
    authority
        .mark_download_artifact_committed(
            &reservation,
            {
                let identity = identity(&root.join("games.pgn")).unwrap();
                (identity.a, identity.b)
            },
            {
                use std::os::unix::fs::MetadataExt;
                let metadata = fs::metadata(root.join("games.pgn")).unwrap();
                i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec())
            },
        )
        .unwrap();
    fs::remove_file(root.join("games.pgn")).unwrap();
    fs::write(root.join("games.pgn"), b"same bytes").unwrap();
    assert!(authority.activate_download_artifact(&reservation).is_err());
}

#[test]
fn swap_between_rename_and_marker_persistence_is_quarantined_by_temp_fd_identity() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("downloads");
    fs::create_dir(&root).unwrap();
    let app_root = AppOwnedRoot::new("downloads", root.clone(), vec![PathOperation::DownloadFile]);
    let staged = dir.path().join("staged.pgn");
    fs::write(&staged, b"same bytes").unwrap();
    let mut authority =
        PathAuthority::open(dir.path().join("registry.json"), vec![app_root.clone()]).unwrap();
    let reservation = authority
        .reserve_download_artifact(
            &app_root.id,
            OsString::from("games.pgn"),
            sha256_file(&staged).unwrap(),
            "games.pgn",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let installed = authority
        .resolve(
            &app_root.id,
            PathOperation::DownloadFile,
            &[OsString::from("games.pgn")],
        )
        .unwrap()
        .atomic_install_reserved_download(&reservation, &mut fs::File::open(&staged).unwrap())
        .unwrap();
    fs::remove_file(root.join("games.pgn")).unwrap();
    fs::write(root.join("games.pgn"), b"same bytes").unwrap();
    authority
        .mark_download_artifact_committed(&reservation, installed.identity, installed.ctime_nanos)
        .unwrap();
    assert!(authority.activate_download_artifact(&reservation).is_err());
}

struct TestActivationObserver {
    authority: std::sync::Weak<crate::infra::path_authority::SharedPathAuthority>,
    caller_thread_id: std::thread::ThreadId,
    observed_stages: std::sync::Mutex<Vec<ActivationObserverStage>>,
}

impl ActivationObserver for TestActivationObserver {
    fn observe(&self, stage: ActivationObserverStage) {
        let current_thread = std::thread::current().id();
        assert_ne!(
            current_thread, self.caller_thread_id,
            "observer must execute on a blocking worker thread, not caller thread"
        );
        if matches!(
            stage,
            ActivationObserverStage::BeforeRead | ActivationObserverStage::PostVerification
        ) {
            let authority_arc = self
                .authority
                .upgrade()
                .expect("authority must exist during verification");
            let try_lock = authority_arc.raw_for_test().try_lock();
            assert!(
                try_lock.is_ok(),
                "authority mutex must be unlocked during stage {stage:?}"
            );
        }
        self.observed_stages.lock().unwrap().push(stage);
    }
}

struct InstalledArtifactFixture {
    authority: PathAuthority,
    app_root: AppOwnedRoot,
    reservation: PendingArtifactReservation,
    target_path: PathBuf,
    installed: AtomicInstalledFile,
    registry_path: PathBuf,
}

impl InstalledArtifactFixture {
    fn new(dir: &Path) -> Self {
        let mut fixture = Self::uncommitted(dir, b"1. e4 e5");
        fixture.mark_committed();
        fixture
    }

    fn with_payload(dir: &Path, payload: &[u8]) -> Self {
        let mut fixture = Self::uncommitted(dir, payload);
        fixture.mark_committed();
        fixture
    }

    fn uncommitted(dir: &Path, payload: &[u8]) -> Self {
        Self::uncommitted_at(dir, payload, dir.join("downloads"), true)
    }

    fn uncommitted_at(dir: &Path, payload: &[u8], root_path: PathBuf, app_owned: bool) -> Self {
        fs::create_dir_all(&root_path).unwrap();
        let mut app_root = AppOwnedRoot::new(
            "downloads",
            root_path.clone(),
            vec![PathOperation::DownloadFile],
        );
        let registry_path = dir.join("registry.json");
        let roots = if app_owned {
            vec![app_root.clone()]
        } else {
            vec![]
        };
        let mut authority = PathAuthority::open(registry_path.clone(), roots).unwrap();
        if !app_owned {
            app_root.id = authority
                .migrate_legacy_os_path(
                    root_path.clone().into_os_string(),
                    "downloads",
                    PathClass::PersistentCustomRoot,
                    vec![PathOperation::DownloadFile],
                )
                .unwrap()
                .id;
        }
        let staged = dir.join("staged.pgn");
        fs::write(&staged, payload).unwrap();
        let reservation = authority
            .reserve_download_artifact(
                &app_root.id,
                OsString::from("games.pgn"),
                sha256_file(&staged).unwrap(),
                "games.pgn",
                vec![PathOperation::ReadPgn],
            )
            .unwrap();
        let installed = authority
            .resolve(
                &app_root.id,
                PathOperation::DownloadFile,
                &[OsString::from("games.pgn")],
            )
            .unwrap()
            .atomic_install_reserved_download(&reservation, &mut fs::File::open(&staged).unwrap())
            .unwrap();
        let target_path = root_path.join("games.pgn");
        Self {
            authority,
            app_root,
            reservation,
            target_path,
            installed,
            registry_path,
        }
    }

    fn mark_committed(&mut self) {
        self.authority
            .mark_download_artifact_committed(
                &self.reservation,
                self.installed.identity,
                self.installed.ctime_nanos,
            )
            .unwrap();
    }

    fn prepare_and_verify(&mut self) -> ContentVerifiedArtifactActivation {
        let prepared = self
            .authority
            .prepare_download_artifact(&self.reservation)
            .expect("prepare must succeed");
        match prepared.verify() {
            Ok(v) => v,
            Err(e) => panic!("verify must succeed: {e:?}"),
        }
    }
}

fn canonical_spelling_fixture(dir: &Path, app_owned: bool) -> InstalledArtifactFixture {
    let mut fixture = InstalledArtifactFixture::uncommitted_at(
        dir,
        b"1. e4 e5",
        dir.join("real/downloads"),
        app_owned,
    );
    fixture.mark_committed();
    fixture
}

fn swap_canonical_spelling(dir: &Path) {
    let real = dir.join("real");
    let moved = dir.join("moved");
    fs::rename(&real, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &real).unwrap();
}

fn assert_canonical_spelling_activation_refused(
    fixture: &InstalledArtifactFixture,
    pending_before: &serde_json::Value,
    registry_before: &[u8],
) {
    assert!(!fixture
        .authority
        .persistent
        .contains_key(&fixture.reservation.id.id));
    assert!(!fixture
        .authority
        .session_protected_ids
        .contains(&fixture.reservation.id.id));
    assert_eq!(
        serde_json::to_value(&fixture.authority.pending_artifacts).unwrap(),
        *pending_before
    );
    assert_eq!(fs::read(&fixture.registry_path).unwrap(), registry_before);
}

#[test]
fn canonical_spelling_accepts_custom_and_app_owned_artifacts_and_entries() {
    for app_owned in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = canonical_spelling_fixture(dir.path(), app_owned);
        assert_eq!(
            fixture
                .authority
                .workspace_entry_path(
                    &FileWorkspaceHandle::new(fixture.app_root.id.clone()),
                    PathOperation::DownloadFile,
                )
                .unwrap(),
            fixture.app_root.path
        );
        let publication = fixture
            .authority
            .activate_download_artifact(&fixture.reservation)
            .unwrap();
        assert_eq!(
            fixture
                .authority
                .workspace_entry_path(&publication.handle, PathOperation::ReadPgn)
                .unwrap(),
            fixture.target_path
        );
        assert!(fixture.authority.pending_artifacts.is_empty());
        assert!(fixture
            .authority
            .persistent
            .contains_key(&fixture.reservation.id.id));
        let mut resolved = fixture
            .authority
            .resolve(publication.handle.path_ref(), PathOperation::ReadPgn, &[])
            .unwrap();
        assert_eq!(resolved.read_bytes().unwrap(), b"1. e4 e5");
    }
}

#[test]
fn canonical_spelling_reservation_refuses_same_inode_ancestor_before_journaling() {
    for app_owned in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = canonical_spelling_fixture(dir.path(), app_owned);
        let pending_before = serde_json::to_value(&fixture.authority.pending_artifacts).unwrap();
        let registry_before = fs::read(&fixture.registry_path).unwrap();
        let stored_identity = identity(&fixture.app_root.path).unwrap();
        swap_canonical_spelling(dir.path());
        assert_eq!(identity(&fixture.app_root.path).unwrap(), stored_identity);
        let result = fixture.authority.reserve_download_artifact(
            &fixture.app_root.id,
            OsString::from("other.pgn"),
            (
                fixture.reservation.payload_size,
                fixture.reservation.payload_sha256.clone(),
            ),
            "other.pgn",
            vec![PathOperation::ReadPgn],
        );
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "reservation must refuse changed canonical spelling"
        );
        assert_canonical_spelling_activation_refused(&fixture, &pending_before, &registry_before);
        assert!(!fixture.app_root.path.join("other.pgn").exists());
    }
}

#[test]
fn canonical_spelling_prepare_refuses_same_inode_ancestor_without_publication() {
    for app_owned in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = canonical_spelling_fixture(dir.path(), app_owned);
        let pending_before = serde_json::to_value(&fixture.authority.pending_artifacts).unwrap();
        let registry_before = fs::read(&fixture.registry_path).unwrap();
        swap_canonical_spelling(dir.path());
        let result = fixture
            .authority
            .prepare_download_artifact(&fixture.reservation);
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "prepare must refuse changed canonical spelling"
        );
        assert_canonical_spelling_activation_refused(&fixture, &pending_before, &registry_before);
    }
}

#[test]
fn canonical_spelling_commit_refuses_ancestor_swapped_after_prepare_or_verify() {
    for app_owned in [false, true] {
        for after_verify in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut fixture = canonical_spelling_fixture(dir.path(), app_owned);
            let pending_before =
                serde_json::to_value(&fixture.authority.pending_artifacts).unwrap();
            let registry_before = fs::read(&fixture.registry_path).unwrap();
            let prepared = fixture
                .authority
                .prepare_download_artifact(&fixture.reservation)
                .unwrap();
            let verified = if after_verify {
                let verified = prepared.verify().unwrap();
                swap_canonical_spelling(dir.path());
                verified
            } else {
                swap_canonical_spelling(dir.path());
                prepared.verify().unwrap()
            };
            let result = fixture.authority.commit_download_artifact(verified);
            assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
            assert_canonical_spelling_activation_refused(
                &fixture,
                &pending_before,
                &registry_before,
            );
        }
    }
}

struct CanonicalSpellingCommitSwapObserver {
    dir: PathBuf,
    fired: std::sync::atomic::AtomicBool,
}

impl ActivationObserver for CanonicalSpellingCommitSwapObserver {
    fn observe(&self, stage: ActivationObserverStage) {
        if stage == ActivationObserverStage::CommitBeforeRetainedDescriptorValidation
            && !self.fired.swap(true, Ordering::SeqCst)
        {
            swap_canonical_spelling(&self.dir);
        }
    }
}

#[test]
fn canonical_spelling_commit_refuses_ancestor_swapped_at_retained_descriptor_check() {
    for app_owned in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = canonical_spelling_fixture(dir.path(), app_owned);
        let observer = Arc::new(CanonicalSpellingCommitSwapObserver {
            dir: dir.path().to_path_buf(),
            fired: std::sync::atomic::AtomicBool::new(false),
        });
        fixture
            .authority
            .set_activation_observer(Some(observer.clone()));
        let verified = fixture.prepare_and_verify();
        let pending_before = serde_json::to_value(&fixture.authority.pending_artifacts).unwrap();
        let registry_before = fs::read(&fixture.registry_path).unwrap();
        let result = fixture.authority.commit_download_artifact(verified);
        assert!(observer.fired.load(Ordering::SeqCst));
        assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
        assert_canonical_spelling_activation_refused(&fixture, &pending_before, &registry_before);
    }
}

#[test]
fn canonical_spelling_workspace_entry_refuses_same_inode_ancestor_for_files_and_directories() {
    for app_owned in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = canonical_spelling_fixture(dir.path(), app_owned);
        let subdir = fixture.app_root.path.join("subdir");
        fs::create_dir(&subdir).unwrap();
        let mut entries = vec![(
            FileWorkspaceHandle::new(fixture.app_root.id.clone()),
            PathOperation::DownloadFile,
            fixture.app_root.path.clone(),
        )];
        for (path, class) in [
            (fixture.target_path.clone(), PathClass::PersistentFile),
            (subdir, PathClass::PersistentCustomRoot),
        ] {
            let entry = fixture
                .authority
                .migrate_legacy_os_path(
                    path.clone().into_os_string(),
                    "entry",
                    class,
                    vec![PathOperation::ReadPgn],
                )
                .unwrap();
            entries.push((
                FileWorkspaceHandle::new(entry.id),
                PathOperation::ReadPgn,
                path,
            ));
        }
        for (handle, operation, path) in &entries {
            assert_eq!(
                fixture
                    .authority
                    .workspace_entry_path(handle, *operation)
                    .unwrap(),
                *path
            );
            fixture
                .authority
                .session_protected_ids
                .remove(&handle.path_ref().id);
        }
        let registry_before = fs::read(&fixture.registry_path).unwrap();
        swap_canonical_spelling(dir.path());
        for (handle, operation, _) in &entries {
            let result = fixture.authority.workspace_entry_path(handle, *operation);
            assert!(matches!(result, Err(Error::Conflict(_))), "{result:?}");
            assert!(!fixture
                .authority
                .session_protected_ids
                .contains(&handle.path_ref().id));
        }
        assert_eq!(fs::read(&fixture.registry_path).unwrap(), registry_before);
    }
}

#[tokio::test]
async fn test_activation_runtime_helper_observes_hash_offload_and_lock_freedom() {
    let dir = tempfile::tempdir().unwrap();
    let payload_bytes = b"1. e4 e5 2. Nf3 Nc6 3. Bb5";
    let fixture = InstalledArtifactFixture::with_payload(dir.path(), payload_bytes);
    let authority = Arc::new(SharedPathAuthority::installed(fixture.authority));

    let observer = Arc::new(TestActivationObserver {
        authority: Arc::downgrade(&authority),
        caller_thread_id: std::thread::current().id(),
        observed_stages: std::sync::Mutex::new(Vec::new()),
    });

    authority
        .raw_for_test()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .set_activation_observer(Some(observer.clone()));

    let publication = activate_download_artifact_runtime(
        &authority,
        &fixture.reservation,
        fixture.installed.identity,
        fixture.installed.ctime_nanos,
    )
    .await
    .expect("runtime activation must succeed");

    let mut resolved = authority
        .raw_for_test()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .resolve(&publication.handle.id, PathOperation::ReadPgn, &[])
        .expect("publication handle must resolve");
    assert_eq!(resolved.read_bytes().unwrap(), payload_bytes);

    let recorded = observer.observed_stages.lock().unwrap().clone();
    assert!(!recorded.is_empty(), "observer must have fired");
    let before_read_count = recorded
        .iter()
        .filter(|s| **s == ActivationObserverStage::BeforeRead)
        .count();
    assert!(
        before_read_count >= 1,
        "must have observed at least one BeforeRead stage"
    );
    let post_pos = recorded
        .iter()
        .position(|s| *s == ActivationObserverStage::PostVerification)
        .expect("must contain PostVerification");
    let commit_pos = recorded
        .iter()
        .position(|s| *s == ActivationObserverStage::CommitBeforeRetainedDescriptorValidation)
        .expect("must contain commit stage");
    assert!(post_pos > 0 && commit_pos > post_pos);
    assert_eq!(
        *recorded.last().unwrap(),
        ActivationObserverStage::CommitBeforeRetainedDescriptorValidation,
        "last observed stage must be commit stage"
    );
}

#[test]
fn test_activation_rejects_byte_identical_replacement_on_different_inode_and_retains_pending() {
    let dir = tempfile::tempdir().unwrap();
    let content = b"1. d4 d5 2. c4 e6";
    let mut fixture = InstalledArtifactFixture::with_payload(dir.path(), content);

    let prepared = fixture
        .authority
        .prepare_download_artifact(&fixture.reservation)
        .expect("prepare must succeed");

    let verified = match prepared.verify() {
        Ok(v) => v,
        Err(e) => panic!("verify on retained descriptor succeeds: {e:?}"),
    };

    // Between verification and commit, replace target file with byte-identical content on different inode:
    fs::remove_file(&fixture.target_path).unwrap();
    fs::write(&fixture.target_path, content).unwrap();

    let err = fixture
        .authority
        .commit_download_artifact(verified)
        .expect_err("commit must reject byte-identical replacement on different inode");

    assert!(matches!(err, Error::Conflict(_)));
    assert!(fixture
        .authority
        .pending_artifacts
        .iter()
        .any(|p| p.id == fixture.reservation.id));
    assert!(!fixture
        .authority
        .persistent
        .contains_key(&fixture.reservation.id.id));
}

struct EofSameBytesRewriteObserver {
    target_path: PathBuf,
    payload: Vec<u8>,
    read_counter: std::sync::atomic::AtomicUsize,
    hook_fired: std::sync::atomic::AtomicBool,
    initial_stamp: i128,
    final_stamp: std::sync::Mutex<Option<i128>>,
}

impl ActivationObserver for EofSameBytesRewriteObserver {
    fn observe(&self, stage: ActivationObserverStage) {
        if stage != ActivationObserverStage::BeforeRead {
            return;
        }
        let count = self.read_counter.fetch_add(1, Ordering::SeqCst);
        // The first BeforeRead is before payload bytes are read.
        // The second BeforeRead is the EOF callback after payload was read.
        if count == 1 {
            let mut changed = false;
            for _ in 0..64 {
                {
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .open(&self.target_path)
                        .expect("target must open for rewrite");
                    file.write_all(&self.payload).expect("rewrite must succeed");
                    file.sync_all().expect("sync must succeed");
                }
                let reader = fs::File::open(&self.target_path)
                    .expect("target must open to read change stamp");
                let stamp = opened_file_change_stamp(&reader).expect("stamp must read");
                if stamp != self.initial_stamp {
                    *self.final_stamp.lock().unwrap() = Some(stamp);
                    changed = true;
                    break;
                }
            }
            assert!(
                changed,
                "must observe a changed real stamp within bounded rewrite attempts"
            );
            self.hook_fired.store(true, Ordering::SeqCst);
        }
    }
}

#[test]
fn test_activation_mutation_during_and_after_verification_rejects() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = InstalledArtifactFixture::new(dir.path());

    // Case a: Rewrite SAME bytes in the final BeforeRead callback (EOF callback after payload was read)
    let observer = Arc::new(EofSameBytesRewriteObserver {
        target_path: fixture.target_path.clone(),
        payload: b"1. e4 e5".to_vec(),
        read_counter: std::sync::atomic::AtomicUsize::new(0),
        hook_fired: std::sync::atomic::AtomicBool::new(false),
        initial_stamp: fixture.installed.ctime_nanos,
        final_stamp: std::sync::Mutex::new(None),
    });
    fixture
        .authority
        .set_activation_observer(Some(observer.clone()));

    let prepared = fixture
        .authority
        .prepare_download_artifact(&fixture.reservation)
        .expect("preparation must succeed");

    let verify_err = prepared
        .verify()
        .err()
        .expect("post-hash verification must reject when change stamp changed");
    assert!(matches!(verify_err, Error::Conflict(_)));
    assert!(
        observer.hook_fired.load(Ordering::SeqCst),
        "EOF read observer hook must have fired"
    );
    let final_stamp = observer
        .final_stamp
        .lock()
        .unwrap()
        .expect("final stamp must have been captured");
    assert_ne!(
        final_stamp, observer.initial_stamp,
        "change stamp must differ from initial stamp on real platform"
    );
    assert!(fixture
        .authority
        .pending_artifacts
        .iter()
        .any(|p| p.id == fixture.reservation.id));

    // Clear observer and restore file content and change stamp marker for case b
    fixture.authority.set_activation_observer(None);
    fs::write(&fixture.target_path, b"1. e4 e5").unwrap();
    let restored_file = fs::File::open(&fixture.target_path).unwrap();
    let (new_a, new_b) = opened_file_identity(&restored_file).unwrap();
    let new_change_stamp = opened_file_change_stamp(&restored_file).unwrap();
    fixture
        .authority
        .mark_download_artifact_committed(&fixture.reservation, (new_a, new_b), new_change_stamp)
        .unwrap();

    // Case b: Mutate/touch file after verification before commit
    let prepared2 = fixture
        .authority
        .prepare_download_artifact(&fixture.reservation)
        .unwrap();
    let verified2 = match prepared2.verify() {
        Ok(v) => v,
        Err(e) => panic!("verify must succeed: {e:?}"),
    };
    // Mutate the file on disk after verification
    {
        let mut f = fs::OpenOptions::new()
            .append(true)
            .open(&fixture.target_path)
            .unwrap();
        f.write_all(b" ").unwrap();
    }
    let commit_err = fixture
        .authority
        .commit_download_artifact(verified2)
        .expect_err("commit must reject post-verification modification");
    assert!(matches!(commit_err, Error::Conflict(_)));
    assert!(fixture
        .authority
        .pending_artifacts
        .iter()
        .any(|p| p.id == fixture.reservation.id));
}

struct CommitStageMutationObserver {
    target_path: PathBuf,
    fired: std::sync::atomic::AtomicBool,
}

struct CommitStageParentSwapObserver {
    root_path: PathBuf,
    old_root_path: PathBuf,
    leaf: OsString,
    fired: std::sync::atomic::AtomicBool,
}

impl ActivationObserver for CommitStageParentSwapObserver {
    fn observe(&self, stage: ActivationObserverStage) {
        if stage == ActivationObserverStage::CommitBeforeRetainedDescriptorValidation
            && !self.fired.swap(true, Ordering::SeqCst)
        {
            fs::rename(&self.root_path, &self.old_root_path)
                .expect("rename artifact root after parent resolution");
            fs::create_dir(&self.root_path).expect("create replacement artifact root");
            fs::hard_link(
                self.old_root_path.join(&self.leaf),
                self.root_path.join(&self.leaf),
            )
            .expect("link installed artifact into replacement root");
        }
    }
}

#[cfg(unix)]
#[test]
fn download_artifact_commit_refuses_a_late_root_swap_and_retains_pending() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = InstalledArtifactFixture::new(dir.path());
    assert!(fixture
        .authority
        .resolve(
            &fixture.app_root.id,
            PathOperation::DownloadFile,
            &[OsString::from("games.pgn")],
        )
        .is_ok());
    let observer = Arc::new(CommitStageParentSwapObserver {
        root_path: fixture.app_root.path.clone(),
        old_root_path: dir.path().join("downloads-old"),
        leaf: OsString::from("games.pgn"),
        fired: std::sync::atomic::AtomicBool::new(false),
    });
    fixture
        .authority
        .set_activation_observer(Some(observer.clone()));
    let verified = fixture.prepare_and_verify();
    let pending_before = serde_json::to_value(&fixture.authority.pending_artifacts).unwrap();
    let error = fixture
        .authority
        .commit_download_artifact(verified)
        .expect_err("the retained descriptor change stamp rejects the late hard link");

    assert!(observer.fired.load(Ordering::SeqCst));
    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    assert!(!fixture
        .authority
        .persistent
        .contains_key(&fixture.reservation.id.id));
    assert_eq!(
        serde_json::to_value(&fixture.authority.pending_artifacts).unwrap(),
        pending_before
    );
    assert_eq!(fs::read_dir(&fixture.app_root.path).unwrap().count(), 1);
}

#[test]
fn download_artifact_publication_resolves_with_its_retained_parent_identity() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = InstalledArtifactFixture::new(dir.path());
    let resolved = fixture
        .authority
        .resolve(
            &fixture.app_root.id,
            PathOperation::DownloadFile,
            &[OsString::from("games.pgn")],
        )
        .unwrap();
    let expected_parent = identity_from_open_file(resolved.parent().unwrap()).unwrap();
    let verified = fixture.prepare_and_verify();
    let publication = fixture
        .authority
        .commit_download_artifact(verified)
        .unwrap();

    assert_eq!(
        fixture
            .authority
            .parent_identity_for_test(publication.handle.path_ref()),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(fixture
        .authority
        .resolve(publication.handle.path_ref(), PathOperation::ReadPgn, &[])
        .is_ok());
}

impl ActivationObserver for CommitStageMutationObserver {
    fn observe(&self, stage: ActivationObserverStage) {
        if stage == ActivationObserverStage::CommitBeforeRetainedDescriptorValidation {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .open(&self.target_path)
                .expect("target must open for commit-stage mutation");
            f.write_all(b"mutated!").expect("write must succeed");
            f.sync_all().expect("sync must succeed");
            self.fired.store(true, Ordering::SeqCst);
        }
    }
}

#[test]
fn test_activation_commit_rejects_mutation_at_commit_observer_stage_and_retains_pending() {
    let dir = tempfile::tempdir().unwrap();
    let mut fixture = InstalledArtifactFixture::new(dir.path());

    let observer = Arc::new(CommitStageMutationObserver {
        target_path: fixture.target_path.clone(),
        fired: std::sync::atomic::AtomicBool::new(false),
    });
    fixture
        .authority
        .set_activation_observer(Some(observer.clone()));

    let prepared = fixture
        .authority
        .prepare_download_artifact(&fixture.reservation)
        .expect("prepare must succeed");
    let verified = prepared.verify().expect("verify must succeed");

    let commit_err = fixture
        .authority
        .commit_download_artifact(verified)
        .expect_err(
            "commit must reject mutation between current-leaf and retained-descriptor checks",
        );

    assert!(matches!(commit_err, Error::Conflict(_)));
    assert!(
        observer.fired.load(Ordering::SeqCst),
        "commit observer hook must have fired"
    );
    assert!(
        fixture
            .authority
            .pending_artifacts
            .iter()
            .any(|p| p.id == fixture.reservation.id),
        "pending intent must be retained"
    );
    assert!(
        !fixture
            .authority
            .persistent
            .contains_key(&fixture.reservation.id.id),
        "no grant must be published"
    );
}

struct ResetInjector;
impl Drop for ResetInjector {
    fn drop(&mut self) {
        set_test_atomic_file_injector(None);
    }
}

struct CountingObserver(std::sync::atomic::AtomicUsize);
impl ActivationObserver for CountingObserver {
    fn observe(&self, _stage: ActivationObserverStage) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn test_activation_runtime_marker_uncertain_durability_fails_with_archive_commit_marker() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = InstalledArtifactFixture::uncommitted(dir.path(), b"content");
    let authority = crate::infra::path_authority::SharedPathAuthority::installed(fixture.authority);

    let observer = Arc::new(CountingObserver(std::sync::atomic::AtomicUsize::new(0)));
    authority
        .raw_for_test()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .set_activation_observer(Some(observer.clone()));

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "injected parent sync failure",
    ))));
    let _reset = ResetInjector;

    let result = activate_download_artifact_runtime(
        &authority,
        &fixture.reservation,
        fixture.installed.identity,
        fixture.installed.ctime_nanos,
    )
    .await;

    match result {
        Err(Error::CommittedDurabilityUncertain(stage)) => {
            assert_eq!(stage, crate::error::DurabilityStage::ArchiveCommitMarker);
        }
        other => {
            panic!("expected CommittedDurabilityUncertain(ArchiveCommitMarker), got {other:?}")
        }
    }

    assert_eq!(
        observer.0.load(Ordering::SeqCst),
        0,
        "verification observer must not be called when marker durability fails"
    );

    let auth_guard = authority.raw_for_test().lock().unwrap();
    let auth = auth_guard.as_ref().unwrap();
    assert!(auth
        .pending_artifacts
        .iter()
        .any(|p| p.id == fixture.reservation.id));
    assert!(!auth.persistent.contains_key(&fixture.reservation.id.id));
}

#[tokio::test]
async fn test_activation_runtime_marker_write_failure_returns_io_category_and_retains_pending() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = InstalledArtifactFixture::uncommitted(dir.path(), b"content");
    let authority = crate::infra::path_authority::SharedPathAuthority::installed(fixture.authority);

    let observer = Arc::new(CountingObserver(std::sync::atomic::AtomicUsize::new(0)));
    authority
        .raw_for_test()
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .set_activation_observer(Some(observer.clone()));

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let _reset = ResetInjector;

    let result = activate_download_artifact_runtime(
        &authority,
        &fixture.reservation,
        fixture.installed.identity,
        fixture.installed.ctime_nanos,
    )
    .await;

    let error = result.expect_err("activation must fail on registry write error");
    assert_eq!(error.category(), crate::error::ErrorCategory::Io);

    assert_eq!(
        observer.0.load(Ordering::SeqCst),
        0,
        "verification observer must not be called when marker write fails"
    );

    {
        let auth_guard = authority.raw_for_test().lock().unwrap();
        let auth = auth_guard.as_ref().unwrap();
        assert!(auth
            .pending_artifacts
            .iter()
            .any(|p| p.id == fixture.reservation.id));
        assert!(!auth.persistent.contains_key(&fixture.reservation.id.id));
    }

    drop(_reset);
    set_test_atomic_file_injector(None);

    // Reopen to assert retained pending intent on disk
    let reopened = PathAuthority::open(fixture.registry_path, vec![fixture.app_root]).unwrap();
    assert!(reopened
        .pending_artifacts
        .iter()
        .any(|p| p.id == fixture.reservation.id));
    assert!(!reopened.persistent.contains_key(&fixture.reservation.id.id));
}

#[test]
fn test_activation_commit_rejects_abandoned_pending_or_changed_root() {
    // Abandon pending intent
    let dir1 = tempfile::tempdir().unwrap();
    let mut fixture1 = InstalledArtifactFixture::new(dir1.path());
    let verified1 = fixture1.prepare_and_verify();
    fixture1
        .authority
        .abandon_download_artifact(&fixture1.reservation);
    let err1 = fixture1
        .authority
        .commit_download_artifact(verified1)
        .expect_err("commit must reject abandoned intent");
    assert!(matches!(err1, Error::InvalidInput(_)));
    assert!(!fixture1
        .authority
        .pending_artifacts
        .iter()
        .any(|p| p.id == fixture1.reservation.id));
    assert!(!fixture1
        .authority
        .persistent
        .contains_key(&fixture1.reservation.id.id));

    // Remove root from persistent
    let dir2 = tempfile::tempdir().unwrap();
    let mut fixture2 = InstalledArtifactFixture::new(dir2.path());
    let verified2 = fixture2.prepare_and_verify();
    fixture2
        .authority
        .persistent
        .remove(&fixture2.app_root.id.id);
    let err2 = fixture2
        .authority
        .commit_download_artifact(verified2)
        .expect_err("commit must reject removed root");
    assert!(matches!(err2, Error::Conflict(_)));

    // Change root directory identity
    let dir3 = tempfile::tempdir().unwrap();
    let mut fixture3 = InstalledArtifactFixture::new(dir3.path());
    let verified3 = fixture3.prepare_and_verify();
    let target_backup = fs::read(&fixture3.target_path).unwrap();
    let root_dir = fixture3.target_path.parent().unwrap();
    fs::remove_dir_all(root_dir).unwrap();
    fs::create_dir(root_dir).unwrap();
    fs::write(&fixture3.target_path, target_backup).unwrap();
    let err3 = fixture3
        .authority
        .commit_download_artifact(verified3)
        .expect_err("commit must reject changed root identity");
    assert!(matches!(err3, Error::Conflict(_)));
}

#[test]
fn test_activation_commit_rejects_independent_pending_field_mutations() {
    // Parameterized test independently mutating each of the 11 grant-relevant fields
    for field_idx in 0..11 {
        let dir = tempfile::tempdir().unwrap();
        let mut fixture = InstalledArtifactFixture::new(dir.path());
        let verified = fixture.prepare_and_verify();

        let pending = &mut fixture.authority.pending_artifacts[0];
        match field_idx {
            0 => pending.operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            1 => pending.root = PathRef::fresh(),
            2 => pending.filename = NativePath::from_path(Path::new("mutated.pgn")),
            3 => pending.root_identity = Some(Identity { a: 99999, b: 88888 }),
            4 => pending.baseline = Some(Identity { a: 99999, b: 88888 }),
            5 => pending.payload_bound = false,
            6 => pending.payload_size += 1,
            7 => pending.payload_sha256 = "0".repeat(64),
            8 => pending.installed_identity = Some(Identity { a: 99999, b: 88888 }),
            9 => pending.installed_ctime_nanos = Some(0),
            10 => pending.display_name = "mutated display name".to_string(),
            _ => unreachable!(),
        }

        let err = fixture
            .authority
            .commit_download_artifact(verified)
            .unwrap_err();
        assert!(
            matches!(err, Error::Conflict(_)),
            "field mutation {field_idx} must be rejected with Conflict, got {err:?}"
        );
    }
}

#[test]
fn test_recovery_leaves_durable_pending_record_unchanged_on_verification_failure() {
    let dir = tempfile::tempdir().unwrap();
    let fixture = InstalledArtifactFixture::with_payload(dir.path(), b"expected content");

    // Corrupt file on disk
    fs::write(&fixture.target_path, b"corrupted bytes").unwrap();

    // First startup recovery
    let authority1 = PathAuthority::open(
        fixture.registry_path.clone(),
        vec![fixture.app_root.clone()],
    )
    .unwrap();
    assert!(
        authority1
            .pending_artifacts
            .iter()
            .any(|p| p.id == fixture.reservation.id),
        "pending record must be retained after recovery verification failure"
    );
    assert!(!authority1
        .persistent
        .contains_key(&fixture.reservation.id.id));

    // Reopen to verify durable registry file on disk still retains pending record
    let authority2 = PathAuthority::open(fixture.registry_path, vec![fixture.app_root]).unwrap();
    assert!(
        authority2
            .pending_artifacts
            .iter()
            .any(|p| p.id == fixture.reservation.id),
        "pending record must persist in registry on disk"
    );
    assert!(!authority2
        .persistent
        .contains_key(&fixture.reservation.id.id));
}

#[test]
fn active_database_root_is_atomic_persistent_and_becomes_unavailable_on_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("databases");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let handle = path_authority
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap();
    path_authority.set_active_database_root(&handle).unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    assert_eq!(
        reloaded.active_database_root().unwrap(),
        Some(handle.clone())
    );

    let replacement = dir.path().join("replacement");
    fs::create_dir(&replacement).unwrap();
    // POSIX atomically replaces an empty directory, whereas Windows
    // requires its target to be absent. The identity change, not either
    // platform's rename rule, is the invariant under test.
    #[cfg(windows)]
    fs::remove_dir(&root).unwrap();
    fs::rename(&replacement, &root).unwrap();
    assert_eq!(
        reloaded.active_database_root().unwrap_err().root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
}

/// Test 8: a raw app-owned spelling written before `AppDataDir` became canonical is rebound at
/// load like any other entry, and the default-root registration then reuses it lexically.
#[cfg(unix)]
#[test]
fn rebind_canonicalises_every_declared_app_owned_default_root() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real_app_data = dir.path().join("real-app-data");
    let app_data_link = dir.path().join("app-data-link");
    fs::create_dir(&real_app_data).unwrap();
    symlink(&real_app_data, &app_data_link).unwrap();
    let mut entries = Vec::new();
    for &(root, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        fs::create_dir(real_app_data.join(leaf)).unwrap();
        entries.push(stored_entry_for(
            &app_data_link.join(leaf),
            format!("app-owned-{leaf}"),
            None,
            vec![PathOperation::ReadPgn],
        ));
        assert_eq!(root.leaf(), leaf);
    }
    assert_eq!(
        APP_OWNED_DEFAULT_ROOT_LEAVES.len(),
        AppOwnedDefaultRoot::ALL.len()
    );
    for root in AppOwnedDefaultRoot::ALL {
        assert!(
            APP_OWNED_DEFAULT_ROOT_LEAVES
                .iter()
                .any(|(candidate, _)| candidate == root),
            "{root:?} is missing from the independent leaf table"
        );
    }
    for (root, _) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        assert!(AppOwnedDefaultRoot::ALL.contains(root));
    }
    entries.push(stored_entry_for(
        &app_data_link.join("db"),
        "database-root",
        Some(EntryPurpose::DatabaseRoot),
        canonical_operations(EntryPurpose::DatabaseRoot),
    ));
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(&registry, entries);
    let mut authority = authority_at(registry, vec![], Arc::new(TestClock::new(0)), 2).unwrap();
    let canonical_app_data = fs::canonicalize(&real_app_data).unwrap();
    for &(_, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        let entry = &authority.persistent[&format!("app-owned-{leaf}")];
        assert_eq!(
            entry.stored.path.to_path().unwrap(),
            canonical_app_data.join(leaf)
        );
        assert_eq!(entry.availability, PathAvailability::Available);
    }
    let databases = ensure_app_owned_default_dir(
        &AppDataDir::for_test(&app_data_link),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    assert_eq!(databases.path(), canonical_app_data.join("db"));
    let root = authority
        .get_or_create_database_root(databases.path(), "Databases", Some(databases.identity()))
        .unwrap();
    assert_eq!(root.path_ref().id, "database-root");
}

/// Test 9: a default root whose load-time rebinding failed stays `Unavailable`; the next
/// verified registration adopts the canonical path onto that same id, moves only its
/// component-wise descendants, and leaves a second `Available` same-identity entry alone.
#[cfg(unix)]
#[test]
fn rebind_failure_is_adopted_onto_the_same_root_id() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real_app_data = dir.path().join("real-app-data");
    let app_data_link = dir.path().join("app-data-link");
    fs::create_dir_all(real_app_data.join("db")).unwrap();
    fs::create_dir_all(real_app_data.join("db2")).unwrap();
    fs::write(real_app_data.join("db/x.db3"), b"database").unwrap();
    fs::write(real_app_data.join("db2/x.db3"), b"sibling").unwrap();
    symlink(&real_app_data, &app_data_link).unwrap();
    let canonical_app_data = fs::canonicalize(&real_app_data).unwrap();
    let raw_root = stored_entry_for(
        &app_data_link.join("db"),
        "raw-root",
        Some(EntryPurpose::DatabaseRoot),
        canonical_operations(EntryPurpose::DatabaseRoot),
    );
    let raw_child = stored_entry_for(
        &app_data_link.join("db/x.db3"),
        "raw-child",
        Some(EntryPurpose::DatabaseFile),
        canonical_operations(EntryPurpose::DatabaseFile),
    );
    let raw_sibling = stored_entry_for(
        &app_data_link.join("db2/x.db3"),
        "raw-sibling",
        Some(EntryPurpose::DatabaseFile),
        canonical_operations(EntryPurpose::DatabaseFile),
    );
    let available_twin = stored_entry_for(
        &canonical_app_data.join("db"),
        "available-twin",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    );
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(
        &registry,
        vec![raw_root, raw_child, raw_sibling, available_twin],
    );
    // The link is absent for the duration of the load, so every raw entry's rebinding fails
    // and leaves it `Unavailable` under its old spelling.
    let parked = dir.path().join("parked-link");
    fs::rename(&app_data_link, &parked).unwrap();
    let mut authority =
        authority_at(registry.clone(), vec![], Arc::new(TestClock::new(0)), 2).unwrap();
    fs::rename(&parked, &app_data_link).unwrap();
    for id in ["raw-root", "raw-child", "raw-sibling"] {
        assert_eq!(
            authority.persistent[id].availability,
            PathAvailability::Unavailable,
            "{id}"
        );
    }
    assert_eq!(
        authority.persistent["available-twin"].availability,
        PathAvailability::Available
    );

    let databases = ensure_app_owned_default_dir(
        &AppDataDir::for_test(&app_data_link),
        AppOwnedDefaultRoot::Databases,
    )
    .unwrap();
    let root = authority
        .get_or_create_database_root(databases.path(), "Databases", Some(databases.identity()))
        .unwrap();
    assert_eq!(root.path_ref().id, "raw-root");
    let path_of = |authority: &PathAuthority, id: &str| {
        authority.persistent[id].stored.path.to_path().unwrap()
    };
    assert_eq!(
        path_of(&authority, "raw-root"),
        canonical_app_data.join("db")
    );
    assert_eq!(
        authority.persistent["raw-root"].availability,
        PathAvailability::Available
    );
    assert_eq!(
        path_of(&authority, "raw-child"),
        canonical_app_data.join("db/x.db3")
    );
    assert_eq!(
        authority.persistent["raw-child"].availability,
        PathAvailability::Available
    );
    assert_eq!(
        path_of(&authority, "raw-sibling"),
        app_data_link.join("db2/x.db3")
    );
    assert_eq!(
        path_of(&authority, "available-twin"),
        canonical_app_data.join("db")
    );
    assert_eq!(
        authority
            .persistent
            .values()
            .filter(|entry| entry.stored.purpose == Some(EntryPurpose::DatabaseRoot))
            .count(),
        1
    );
    assert!(authority
        .database_file_target(
            &DatabaseHandle::new(PathRef {
                id: "raw-child".into()
            }),
            PathOperation::DatabaseRead
        )
        .is_ok());
    drop(authority);

    let reopened = authority_at(registry, vec![], Arc::new(TestClock::new(0)), 2).unwrap();
    assert_eq!(
        path_of(&reopened, "raw-root"),
        canonical_app_data.join("db")
    );
}

#[cfg(unix)]
#[test]
/// The owned entry is rebound at load and stays available through `descriptors()`'s refresh;
/// the second entry is quarantined because its object changed, not because of its spelling.
/// The spelling branch of `refresh_entry` is pinned directly by
/// `refresh_entry_rejects_a_legacy_spelling_even_when_identity_matches`.
fn rebind_then_descriptors_refresh_keeps_app_owned_entry_and_quarantines_a_changed_entry() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real_app_data = dir.path().join("real-app-data");
    let app_data_link = dir.path().join("app-data-link");
    let real_external = dir.path().join("real-external");
    let external_link = dir.path().join("external-link");
    fs::create_dir_all(real_app_data.join("db")).unwrap();
    fs::create_dir(&real_external).unwrap();
    fs::write(real_app_data.join("db/owned.pgn"), b"owned").unwrap();
    fs::write(real_external.join("changed.pgn"), b"old").unwrap();
    symlink(&real_app_data, &app_data_link).unwrap();
    symlink(&real_external, &external_link).unwrap();
    let owned = stored_entry_for(
        &app_data_link.join("db/owned.pgn"),
        "descriptor-owned",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    let changed = stored_entry_for(
        &external_link.join("changed.pgn"),
        "descriptor-changed",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    fs::write(real_external.join("replacement"), b"new").unwrap();
    fs::rename(
        real_external.join("replacement"),
        real_external.join("changed.pgn"),
    )
    .unwrap();
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(&registry, vec![owned, changed]);
    let mut authority = authority_at(registry, vec![], Arc::new(TestClock::new(0)), 2).unwrap();
    assert_eq!(
        authority.persistent["descriptor-owned"]
            .stored
            .path
            .to_path()
            .unwrap(),
        fs::canonicalize(&real_app_data)
            .unwrap()
            .join("db/owned.pgn")
    );
    let descriptors = authority.descriptors();
    let availability = |id: &str| {
        descriptors
            .iter()
            .find(|descriptor| descriptor.id.id == id)
            .map(|descriptor| descriptor.availability)
            .unwrap()
    };
    assert_eq!(
        availability("descriptor-owned"),
        PathAvailability::Available
    );
    assert_eq!(
        availability("descriptor-changed"),
        PathAvailability::Unavailable
    );
}

/// Test 7: every default root materialised through a symlinked app-data spelling, and every
/// database child, engine image and puzzle root derived from it, is stored canonical in the
/// same session, so the path-equal doors accept them and the lexical reuse and image cleanup
/// still match.
#[cfg(unix)]
#[test]
fn ensure_app_owned_default_dir_through_a_symlink_spelling_stores_canonical_children() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real_app_data = dir.path().join("real-app-data");
    let app_data_link = dir.path().join("app-data-link");
    fs::create_dir(&real_app_data).unwrap();
    symlink(&real_app_data, &app_data_link).unwrap();
    let canonical_app_data = fs::canonicalize(&real_app_data).unwrap();
    let app_data = AppDataDir::for_test(&app_data_link);
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let images =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::EngineImages).unwrap();
    let puzzles = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Puzzles).unwrap();
    assert_eq!(databases.path(), canonical_app_data.join("db"));
    let registry = dir.path().join("registry.json");
    let mut authority =
        authority_at(registry.clone(), vec![], Arc::new(TestClock::new(0)), 2).unwrap();
    let root = authority
        .get_or_create_database_root(databases.path(), "Databases", Some(databases.identity()))
        .unwrap();
    let child_path = databases.path().join("child.db3");
    fs::write(&child_path, b"database").unwrap();
    let child = authority
        .register_database_child(
            &root,
            OsStr::new("child.db3"),
            "child",
            observed_identity(&child_path),
        )
        .unwrap();
    let target = authority
        .database_file_target(
            &DatabaseHandle::new(child.path_ref().clone()),
            PathOperation::DatabaseRead,
        )
        .unwrap();
    assert_eq!(target.path(), canonical_app_data.join("db/child.db3"));
    let puzzle_root = authority
        .get_or_create_puzzle_root(puzzles.path(), "Puzzles", Some(puzzles.identity()))
        .unwrap();
    let image_leaf = OsString::from(Uuid::new_v4().to_string());
    let (_, installed) = images
        .atomic_replace_leaf_identified(&image_leaf, |file| {
            file.write_all(b"engine image").map_err(Error::from)
        })
        .unwrap();
    let image = authority
        .register_engine_image(&images, &image_leaf, installed, "image".into())
        .unwrap();
    for (id, expected) in [
        (root.path_ref().clone(), canonical_app_data.join("db")),
        (
            child.path_ref().clone(),
            canonical_app_data.join("db/child.db3"),
        ),
        (
            puzzle_root.path_ref().clone(),
            canonical_app_data.join("puzzles"),
        ),
        (
            image.path_ref().clone(),
            canonical_app_data.join("engine-images").join(&image_leaf),
        ),
    ] {
        assert_eq!(
            authority.persistent[&id.id].stored.path.to_path().unwrap(),
            expected
        );
        authority.refresh_persistent_id(&id);
        assert_eq!(
            authority.persistent[&id.id].availability,
            PathAvailability::Available
        );
    }
    drop(authority);

    let mut reopened = authority_at(registry, vec![], Arc::new(TestClock::new(0)), 2).unwrap();
    let app_data = AppDataDir::for_test(&app_data_link);
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let reused_root = reopened
        .get_or_create_database_root(databases.path(), "Databases", Some(databases.identity()))
        .unwrap();
    assert_eq!(reused_root.path_ref(), root.path_ref());
    let puzzles = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Puzzles).unwrap();
    let reused_puzzles = reopened
        .get_or_create_puzzle_root(puzzles.path(), "Puzzles", Some(puzzles.identity()))
        .unwrap();
    assert_eq!(reused_puzzles.path_ref(), puzzle_root.path_ref());
    assert!(reopened
        .database_file_target(
            &DatabaseHandle::new(child.path_ref().clone()),
            PathOperation::DatabaseRead
        )
        .is_ok());
    reopened
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![image.path_ref().clone()],
            startup: false,
        })
        .unwrap();
    let images =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::EngineImages).unwrap();
    reopened.cleanup_engine_images(&images, false).unwrap();
    assert!(!real_app_data
        .join("engine-images")
        .join(&image_leaf)
        .exists());
}

#[cfg(unix)]
#[test]
fn runtime_app_owned_root_is_exempt_by_class_and_not_by_path() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("runtime-real");
    let link = dir.path().join("runtime-link");
    fs::create_dir(&real).unwrap();
    fs::create_dir(real.join("managed")).unwrap();
    symlink(&real, &link).unwrap();
    let app = AppOwnedRoot::new(
        "runtime",
        link.join("managed"),
        vec![PathOperation::ReadPgn],
    );
    let id = app.id.clone();
    let mut authority = authority_at(
        dir.path().join("registry.json"),
        vec![app],
        Arc::new(TestClock::new(0)),
        2,
    )
    .unwrap();
    assert_eq!(
        authority.persistent[&id.id].stored.path.to_path().unwrap(),
        link.join("managed")
    );
    assert_eq!(
        authority.persistent[&id.id].availability,
        PathAvailability::Available
    );
    authority.refresh_persistent_id(&id);
    assert_eq!(
        authority.persistent[&id.id].availability,
        PathAvailability::Available
    );
    assert_eq!(
        authority.persistent[&id.id].stored.path.to_path().unwrap(),
        link.join("managed")
    );
}

#[cfg(unix)]
#[test]
fn reselecting_rebound_file_and_root_reuses_the_existing_ids() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir_all(real.join("workspace")).unwrap();
    fs::write(real.join("study.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    let file = stored_entry_for(
        &link.join("study.pgn"),
        "reselect-file",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    let root = stored_entry_for(
        &link.join("workspace"),
        "reselect-root",
        Some(EntryPurpose::DatabaseRoot),
        canonical_operations(EntryPurpose::DatabaseRoot),
    );
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(&registry, vec![file, root]);
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    let file_commit = authority
        .get_or_create_persistent_file(
            &link.join("study.pgn"),
            "study",
            canonical_operations(EntryPurpose::PgnFile),
        )
        .unwrap();
    let root_handle = authority
        .get_or_create_database_root(&link.join("workspace"), "workspace", None)
        .unwrap();
    assert_eq!(file_commit.id.id, "reselect-file");
    assert_eq!(root_handle.id.id, "reselect-root");
    assert_eq!(authority.persistent.len(), 2);
}

#[cfg(unix)]
#[test]
fn malformed_persistent_path_and_pending_root_do_not_abort_startup() {
    let dir = tempfile::tempdir().unwrap();
    let valid_path = dir.path().join("valid.pgn");
    fs::write(&valid_path, b"valid").unwrap();
    let malformed = StoredEntry {
        id: PathRef {
            id: "malformed-entry".into(),
        },
        display_name: "malformed".into(),
        class: PathClass::PersistentFile,
        purpose: Some(EntryPurpose::PgnFile),
        operations: canonical_operations(EntryPurpose::PgnFile),
        path: NativePath::Unix { bytes: "!".into() },
        identity: Identity { a: 0, b: 0 },
        parent_identity: None,
        target_is_dir: false,
        practice_key: None,
    };
    let valid = stored_entry_for(
        &valid_path,
        "valid-entry",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    let pending = pending_test_artifact(&malformed.id, "malformed-pending");
    let registry = dir.path().join("registry.json");
    write_registry(
        &registry,
        &Registry {
            schema_version: SCHEMA_VERSION,
            entries: vec![malformed, valid],
            active_database_root: None,
            active_puzzle_root: None,
            active_engine_root: None,
            pending_artifacts: vec![pending],
            provisional_attachments: BTreeSet::new(),
            image_cleanup: vec![],
            catalog_installs: BTreeMap::new(),
            catalog_uses: Vec::new(),
        },
    );
    let capture = crate::error::LogCaptureScope::start();
    let authority = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(
        authority.persistent["malformed-entry"].availability,
        PathAvailability::Unavailable
    );
    assert_eq!(
        authority.persistent["valid-entry"].availability,
        PathAvailability::Available
    );
    assert_eq!(authority.pending_artifacts.len(), 1);
    assert!(
        capture
            .messages()
            .iter()
            .filter(|message| message.contains("malformed-entry"))
            .count()
            >= 2
    );
}

#[cfg(unix)]
#[test]
fn pending_artifact_recovery_survives_legacy_root_rebinding() {
    use std::os::unix::fs::symlink;
    use std::os::unix::fs::MetadataExt;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    let downloads = real.join("downloads");
    fs::create_dir_all(&downloads).unwrap();
    symlink(&real, &link).unwrap();
    let root = stored_entry_for(
        &link.join("downloads"),
        "legacy-pending-root",
        Some(EntryPurpose::DownloadDestination),
        canonical_operations(EntryPurpose::DownloadDestination),
    );
    let artifact_path = downloads.join("artifact.pgn");
    fs::write(&artifact_path, b"artifact").unwrap();
    let artifact_identity = identity(&artifact_path).unwrap();
    let metadata = fs::metadata(&artifact_path).unwrap();
    let pending = PendingArtifact {
        id: PathRef {
            id: "recovered-artifact".into(),
        },
        root: root.id.clone(),
        filename: NativePath::from_path(Path::new("artifact.pgn")),
        display_name: "artifact".into(),
        operations: canonical_operations(EntryPurpose::PgnReadOnlyFile),
        baseline: None,
        root_identity: Some(root.identity.clone()),
        payload_size: 8,
        payload_sha256: sha256_file(&artifact_path).unwrap().1,
        payload_bound: true,
        installed_identity: Some(artifact_identity.clone()),
        installed_ctime_nanos: Some(
            i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec()),
        ),
    };
    let registry = dir.path().join("registry.json");
    write_registry(
        &registry,
        &Registry {
            schema_version: SCHEMA_VERSION,
            entries: vec![root],
            active_database_root: None,
            active_puzzle_root: None,
            active_engine_root: None,
            pending_artifacts: vec![pending],
            provisional_attachments: BTreeSet::new(),
            image_cleanup: vec![],
            catalog_installs: BTreeMap::new(),
            catalog_uses: Vec::new(),
        },
    );
    let authority = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(
        authority.persistent["legacy-pending-root"]
            .stored
            .path
            .to_path()
            .unwrap(),
        downloads
    );
    assert!(authority.pending_artifacts.is_empty());
    assert!(authority.persistent.contains_key("recovered-artifact"));
}

#[cfg(unix)]
#[test]
fn ensure_app_owned_default_dir_applies_only_declared_private_mode() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    for &(_, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        let path = dir.path().join(leaf);
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    for &(root, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        let directory =
            ensure_app_owned_default_dir(&AppDataDir::for_test(dir.path()), root).unwrap();
        let mode = fs::metadata(directory.path()).unwrap().permissions().mode() & 0o7777;
        let expected_mode = match root {
            AppOwnedDefaultRoot::Credentials
            | AppOwnedDefaultRoot::Collections
            | AppOwnedDefaultRoot::UnsavedGames
            | AppOwnedDefaultRoot::WorkspaceSession
            | AppOwnedDefaultRoot::LibrarySync
            | AppOwnedDefaultRoot::ScoresheetPhotos => 0o700,
            #[cfg(target_os = "macos")]
            AppOwnedDefaultRoot::EngineLaunch => 0o700,
            _ => 0o755,
        };
        assert_eq!(directory.path(), dir.path().join(leaf));
        assert_eq!(mode, expected_mode, "unexpected mode for {root:?}");
    }
}

/// Per variant, not once: the create-if-missing collides with a symlink to an existing
/// directory, and `EngineImages` and `Credentials` are the variants no `get_or_create_*_root`
/// — and therefore no `validate_target` — ever follows.
#[cfg(unix)]
#[test]
fn ensure_app_owned_default_dir_refuses_a_symlinked_leaf_for_every_root() {
    for &(root, leaf) in APP_OWNED_DEFAULT_ROOT_LEAVES {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app-data");
        let elsewhere = dir.path().join("elsewhere");
        fs::create_dir(&app_data).unwrap();
        fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, app_data.join(leaf)).unwrap();

        let error = ensure_app_owned_default_dir(&AppDataDir::for_test(&app_data), root)
            .expect_err("a symlinked leaf must be refused");
        assert!(
            matches!(error, Error::Io(ref inner) if inner.to_string().contains("reparse point")),
            "{root:?} must be refused as Error::Io mentioning a reparse point: {error:?}"
        );
        assert_eq!(
            fs::read_dir(&elsewhere).unwrap().count(),
            0,
            "{root:?} must not write through the symlink"
        );
    }
}

#[cfg(unix)]
#[test]
fn ensure_app_owned_default_dir_maps_descriptor_open_failure_to_io() {
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("db");
    fs::create_dir(&root).unwrap();
    fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();

    let result = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::Databases,
    );
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
    let error = result.expect_err("opening a permissionless directory must fail");
    assert!(matches!(error, Error::Io(_)), "{error:?}");
}

/// Test 1: once constructed, `AppDataDir` materialises a default root through its retained
/// descriptor. Swapping both the construction spelling and the canonical directory for
/// symlinks to an outside directory afterwards cannot redirect the create.
#[cfg(unix)]
#[test]
fn ensure_app_owned_default_dir_ignores_an_ancestor_swapped_after_construction() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    let moved = dir.path().join("moved");
    let outside = dir.path().join("outside");
    fs::create_dir(&real).unwrap();
    fs::create_dir(&outside).unwrap();
    symlink(&real, &link).unwrap();
    let app_data = AppDataDir::for_test(&link);

    fs::rename(&real, &moved).unwrap();
    symlink(&outside, &real).unwrap();
    fs::remove_file(&link).unwrap();
    symlink(&outside, &link).unwrap();

    ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    assert!(fs::symlink_metadata(moved.join("db")).unwrap().is_dir());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
}

/// Test 2: only `tmp` exists. After construction holds `tmp`'s descriptor and before the first
/// missing component is created, `tmp` is replaced by a symlink to an outside directory. Every
/// component is still created in the held directory.
#[cfg(unix)]
#[test]
fn ensure_directory_at_creates_missing_app_data_components_in_the_held_prefix() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let tmp = dir.path().join("tmp");
    let held = dir.path().join("tmp-held");
    let outside = dir.path().join("outside");
    fs::create_dir(&tmp).unwrap();
    fs::create_dir(&outside).unwrap();
    let (swap_tmp, swap_held, swap_outside) = (tmp.clone(), held.clone(), outside.clone());
    crate::infra::fs::set_ensure_directory_pre_create_hook(Some(Box::new(move || {
        fs::rename(&swap_tmp, &swap_held).unwrap();
        symlink(&swap_outside, &swap_tmp).unwrap();
    })));
    let app_data = AppDataDir::try_for_test(&tmp.join("a/b/app"));
    crate::infra::fs::set_ensure_directory_pre_create_hook(None);
    let app_data = app_data.unwrap();

    assert!(fs::symlink_metadata(held.join("a/b/app")).unwrap().is_dir());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Puzzles).unwrap();
    assert!(held.join("a/b/app/puzzles").is_dir());
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
}

/// Test 4: the prefix is swapped after it was canonicalised and its identity read, but before
/// it is opened against that identity. Construction fails as `Error::Io` with the fixed text,
/// and nothing is created on either side of the swap.
#[cfg(unix)]
#[test]
fn try_for_test_maps_a_prefix_swapped_before_its_verified_open_to_io() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let prefix = dir.path().join("prefix");
    let held = dir.path().join("prefix-held");
    let outside = dir.path().join("outside");
    fs::create_dir(&prefix).unwrap();
    fs::create_dir(&outside).unwrap();
    let (swap_prefix, swap_held, swap_outside) = (prefix.clone(), held.clone(), outside.clone());
    set_app_data_pre_open_hook(Some(Box::new(move || {
        fs::rename(&swap_prefix, &swap_held).unwrap();
        symlink(&swap_outside, &swap_prefix).unwrap();
    })));
    let result = AppDataDir::try_for_test(&prefix.join("app"));
    set_app_data_pre_open_hook(None);

    match result {
        Err(Error::Io(error)) => assert_eq!(
            error.to_string(),
            "application data directory could not be acquired"
        ),
        Err(other) => panic!("construction must fail as Error::Io: {other:?}"),
        Ok(_) => panic!("a swapped prefix must not be acquired"),
    }
    assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
    assert_eq!(fs::read_dir(&held).unwrap().count(), 0);
}

/// Test 5 (R3-05): the stored database file's ancestor is replaced by a symlink to the same
/// directory under another name. The inode still matches, the pathname does not.
#[cfg(unix)]
#[test]
fn database_file_target_refuses_a_same_inode_ancestor_swap() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let moved = dir.path().join("moved");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("x.db3"), b"database").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let stored = authority
        .migrate_legacy_os_path(
            real.join("x.db3").into_os_string(),
            "x",
            PathClass::PersistentFile,
            canonical_operations(EntryPurpose::DatabaseFile),
        )
        .unwrap();
    let handle = DatabaseHandle::new(stored.id);
    assert!(authority
        .database_file_target(&handle, PathOperation::DatabaseRead)
        .is_ok());

    fs::rename(&real, &moved).unwrap();
    symlink(&moved, &real).unwrap();
    let error = authority
        .database_file_target(&handle, PathOperation::DatabaseMutate)
        .err()
        .expect("a same-inode ancestor swap must not mint a target");
    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
}

#[test]
fn database_file_target_refuses_a_same_inode_parent_replacement_without_sidecars() {
    let dir = tempfile::tempdir().unwrap();
    let database_dir = dir.path().join("database");
    fs::create_dir(&database_dir).unwrap();
    let database = database_dir.join("games.db3");
    fs::write(&database, b"database").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let handle = DatabaseHandle::new(
        authority
            .get_or_create_persistent_file(
                &database,
                "games",
                canonical_operations(EntryPurpose::DatabaseFile),
            )
            .unwrap()
            .id,
    );
    assert!(authority
        .database_file_target(&handle, PathOperation::DatabaseRead)
        .is_ok());
    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some({
            let parent = identity(&database_dir).unwrap();
            (parent.a, parent.b)
        })
    );

    replace_parent_with_same_inode_hard_link(&database);
    let error = authority
        .database_file_target(&handle, PathOperation::DatabaseMutate)
        .err()
        .expect("the stored parent identity must reject a replacement directory");
    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    let children: Vec<_> = fs::read_dir(&database_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(children, vec![OsString::from("games.db3")]);
}

#[test]
fn resolve_refuses_a_same_inode_parent_replacement_for_pgn_read_and_write() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("pgn");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let handle = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "study",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap()
        .id;
    let authorized_parent = identity(&parent).unwrap();
    assert_eq!(
        authority.parent_identity_for_test(&handle),
        Some((authorized_parent.a, authorized_parent.b))
    );
    for operation in [PathOperation::ReadPgn, PathOperation::WritePgn] {
        assert!(authority.resolve(&handle, operation, &[]).is_ok());
    }

    replace_parent_with_same_inode_hard_link(&path);
    for operation in [PathOperation::ReadPgn, PathOperation::WritePgn] {
        assert!(matches!(
            authority.resolve(&handle, operation, &[]),
            Err(Error::Conflict(message))
                if message == "path authority is unavailable because its object changed"
        ));
    }
    assert_eq!(
        fs::read_dir(&parent).unwrap().count(),
        1,
        "resolution must not create a sidecar or replacement leaf"
    );
}

#[test]
fn resolve_refuses_a_retired_engine_attachment_after_a_same_inode_parent_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("resources");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("network.nnue");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let handle = attachment_resource(&mut authority, &path);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![handle.id.clone()],
            startup: false,
        })
        .unwrap();
    assert!(authority.retired_attachments.contains_key(&handle.id.id));
    assert!(authority
        .resolve(&handle.id, PathOperation::EngineResourceRead, &[])
        .is_ok());

    replace_parent_with_same_inode_hard_link(&path);
    assert!(matches!(
        authority.resolve(&handle.id, PathOperation::EngineResourceRead, &[]),
        Err(Error::Conflict(message))
            if message == "path authority is unavailable because its object changed"
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn workspace_mutation_target_and_workspace_entry_path_refuse_a_same_inode_parent_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("workspace");
    let parent = root_path.join("sub");
    fs::create_dir_all(&parent).unwrap();
    let path = parent.join("a.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .migrate_legacy_os_path(
            root_path.into_os_string(),
            "workspace",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap()
        .id;
    let workspace = FileWorkspaceHandle::new(root);
    let child_identity = identity(&path).unwrap();
    let parent_identity = identity(&parent).unwrap();
    let handle = authority
        .register_workspace_child_observed_with_parent(
            &workspace,
            &[OsString::from("sub"), OsString::from("a.pgn")],
            "a",
            IdentityBinding::from_pairs(
                (child_identity.a, child_identity.b),
                (parent_identity.a, parent_identity.b),
            ),
            false,
            PathOperation::WritePgn,
        )
        .unwrap();
    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some((parent_identity.a, parent_identity.b))
    );
    assert_eq!(
        authority
            .workspace_entry_path(&handle, PathOperation::ReadPgn)
            .unwrap(),
        path
    );
    assert!(authority.workspace_mutation_target(&handle).is_ok());

    replace_parent_with_same_inode_hard_link(&path);
    assert!(matches!(
        authority.workspace_entry_path(&handle, PathOperation::ReadPgn),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        authority.workspace_mutation_target(&handle),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn promote_dialog_refuses_a_parent_replaced_after_the_file_was_picked() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("picked");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
    let grant = authority
        .grant_dialog_operations(
            &path,
            "study",
            PathClass::BoundedDialogGrant,
            operations.clone(),
            Duration::from_secs(60),
            1,
        )
        .unwrap();

    replace_parent_with_same_inode_hard_link(&path);
    let error = authority
        .promote_dialog(&grant, PathClass::PersistentFile, "study", operations)
        .expect_err("promotion must reject a parent changed since the picker observed it");
    assert!(
        matches!(error.unlabelled(), Error::Conflict(message) if message == "dialog target changed before promotion")
    );
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
    assert!(authority.persistent.is_empty());
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn dialog_promotion_persists_the_parent_identity_observed_by_the_picker() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("picked");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let expected_parent = descriptor_parent_identity(&path);
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
    let grant = authority
        .grant_dialog_operations(
            &path,
            "study",
            PathClass::BoundedDialogGrant,
            operations.clone(),
            Duration::from_secs(60),
            1,
        )
        .unwrap();

    let promoted = authority
        .promote_dialog(&grant, PathClass::PersistentFile, "study", operations)
        .unwrap();

    assert_eq!(
        authority.parent_identity_for_test(&promoted.id),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(authority
        .resolve(&promoted.id, PathOperation::ReadPgn, &[])
        .is_ok());
}

#[cfg(unix)]
#[test]
fn dialog_promotion_keeps_its_acquired_parent_identity_across_registration_race() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("picked");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let expected_parent = descriptor_parent_identity(&path);
    let replacement = parent.clone();
    let old_parent = parent.with_file_name("picked.old");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
    let grant = authority
        .grant_dialog_operations(
            &path,
            "study",
            PathClass::BoundedDialogGrant,
            operations.clone(),
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    PROMOTE_DIALOG_POST_ACQUIRE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&replacement, &old_parent).unwrap();
                fs::create_dir(&replacement).unwrap();
                fs::hard_link(old_parent.join("study.pgn"), replacement.join("study.pgn")).unwrap();
            })))
            .is_none());
    });

    let promoted = authority
        .promote_dialog(&grant, PathClass::PersistentFile, "study", operations)
        .unwrap();

    assert_eq!(
        authority.parent_identity_for_test(&promoted.id),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(matches!(
        authority.resolve(&promoted.id, PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn legacy_migration_keeps_its_acquired_parent_identity_across_registration_race() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("pgn");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let expected_parent = descriptor_parent_identity(&path);
    let replacement = parent.clone();
    let old_parent = parent.with_file_name("pgn.old");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    PERSISTENT_FILE_POST_TARGET_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&replacement, &old_parent).unwrap();
                fs::create_dir(&replacement).unwrap();
                fs::hard_link(old_parent.join("study.pgn"), replacement.join("study.pgn")).unwrap();
            })))
            .is_none());
    });

    let migrated = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "study",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap();

    assert_eq!(
        authority.parent_identity_for_test(&migrated.id),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(matches!(
        authority.resolve(&migrated.id, PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn passive_workspace_listing_mints_a_fresh_id_after_a_parent_change() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("workspace");
    let parent = root_path.join("sub");
    fs::create_dir_all(&parent).unwrap();
    let path = parent.join("a.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .migrate_legacy_os_path(
            root_path.into_os_string(),
            "workspace",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap()
        .id;
    let workspace = FileWorkspaceHandle::new(root);
    let leaf_identity = identity(&path).unwrap();
    let old_parent_identity = identity(&parent).unwrap();
    let components = [OsString::from("sub"), OsString::from("a.pgn")];
    let old_handle = authority
        .register_workspace_child_observed_with_parent(
            &workspace,
            &components,
            "a",
            IdentityBinding::from_pairs(
                (leaf_identity.a, leaf_identity.b),
                (old_parent_identity.a, old_parent_identity.b),
            ),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    assert!(authority
        .resolve(old_handle.path_ref(), PathOperation::ReadPgn, &[])
        .is_ok());

    replace_parent_with_same_inode_hard_link(&path);
    assert!(matches!(
        authority.resolve(old_handle.path_ref(), PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
    let new_parent_identity = identity(&parent).unwrap();
    let new_handle = authority
        .register_workspace_child_observed_with_parent(
            &workspace,
            &components,
            "a",
            IdentityBinding::from_pairs(
                (leaf_identity.a, leaf_identity.b),
                (new_parent_identity.a, new_parent_identity.b),
            ),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    assert_ne!(old_handle, new_handle);
    assert!(authority.persistent.contains_key(&old_handle.path_ref().id));
    assert_eq!(
        authority.parent_identity_for_test(new_handle.path_ref()),
        Some((new_parent_identity.a, new_parent_identity.b))
    );
    assert!(authority
        .resolve(new_handle.path_ref(), PathOperation::ReadPgn, &[])
        .is_ok());
    assert!(matches!(
        authority.resolve(old_handle.path_ref(), PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn explicit_dialog_repick_rebinds_the_existing_file_id_after_a_parent_change() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("pgn");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let operations = vec![PathOperation::ReadPgn, PathOperation::WritePgn];
    let handle = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "study",
            PathClass::PersistentFile,
            operations.clone(),
        )
        .unwrap()
        .id;
    replace_parent_with_same_inode_hard_link(&path);
    assert!(matches!(
        authority.resolve(&handle, PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));

    let grant = authority
        .grant_dialog_operations(
            &path,
            "study",
            PathClass::BoundedDialogGrant,
            operations.clone(),
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    let rebound = authority
        .promote_dialog(&grant, PathClass::PersistentFile, "study", operations)
        .unwrap();
    assert_eq!(rebound.id, handle);
    let parent_identity = identity(&parent).unwrap();
    assert_eq!(
        authority.parent_identity_for_test(&handle),
        Some((parent_identity.a, parent_identity.b))
    );
    assert!(authority
        .resolve(&handle, PathOperation::ReadPgn, &[])
        .is_ok());
}

#[test]
fn explicit_engine_file_repick_rebinds_the_existing_id_after_a_parent_change() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("engines");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("engine");
    fs::write(&path, b"engine").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let handle = authority.register_engine_file(&path, "engine").unwrap();
    assert!(authority
        .resolve(handle.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .is_ok());
    let original_parent = identity(&parent).unwrap();
    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some((original_parent.a, original_parent.b))
    );

    replace_parent_with_same_inode_hard_link(&path);
    assert!(matches!(
        authority.resolve(handle.path_ref(), PathOperation::EngineBinaryInspect, &[]),
        Err(Error::Conflict(_))
    ));
    let rebound = authority.register_engine_file(&path, "engine").unwrap();
    assert_eq!(rebound.id, handle.id);
    let parent_identity = identity(&parent).unwrap();
    assert_eq!(
        authority.parent_identity_for_test(rebound.path_ref()),
        Some((parent_identity.a, parent_identity.b))
    );
    assert!(authority
        .resolve(rebound.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .is_ok());
}

#[test]
fn canonical_legacy_file_is_upgraded_at_startup_and_the_upgrade_is_persisted() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("pgn");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("legacy.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let registry = dir.path().join("registry.json");
    let mut entry = stored_entry_for(
        &path,
        "legacy-file",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    entry.parent_identity = None;
    write_registry_with_entries(&registry, vec![entry]);

    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let parent_identity = identity(&parent).unwrap();
    let handle = PathRef {
        id: "legacy-file".into(),
    };
    assert_eq!(
        authority.parent_identity_for_test(&handle),
        Some((parent_identity.a, parent_identity.b))
    );
    assert!(authority
        .resolve(&handle, PathOperation::ReadPgn, &[])
        .is_ok());
    let persisted: Registry = serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
    let upgraded = persisted
        .entries
        .iter()
        .find(|entry| entry.id == handle)
        .unwrap();
    assert_eq!(
        upgraded
            .parent_identity
            .as_ref()
            .map(|identity| (identity.a, identity.b)),
        Some((parent_identity.a, parent_identity.b))
    );

    replace_parent_with_same_inode_hard_link(&path);
    assert!(matches!(
        authority.resolve(&handle, PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
}

/// The producers' fail-closed refusals: a file entry is never registered without the
/// identity of the directory that observed it.
#[test]
fn file_registration_without_an_observed_parent_is_refused() {
    let retained_nothing = resolved::ResolvedPath::download_archive_test(PathBuf::from("x"));
    assert!(matches!(
        retained_nothing.parent_identity(),
        Err(Error::InvalidInput(_))
    ));

    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("book.bin");
    fs::write(&file, b"book").unwrap();
    let leaf = identity(&file).unwrap();
    assert!(matches!(
        PathAuthority::registration_target(
            &file,
            PathClass::PersistentFile,
            &[PathOperation::ReadPgn],
            Some(VerifiedIdentity::from_pair((leaf.a, leaf.b))),
            None,
        ),
        Err(Error::InvalidInput(_))
    ));

    let root_path = dir.path().join("workspace");
    fs::create_dir(&root_path).unwrap();
    let path = root_path.join("a.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let registry = dir.path().join("registry.json");
    let mut root_entry = stored_entry_for(
        &root_path,
        "workspace-root",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    );
    root_entry.target_is_dir = true;
    write_registry_with_entries(&registry, vec![root_entry]);
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    let workspace = FileWorkspaceHandle::new(PathRef {
        id: "workspace-root".into(),
    });
    let child = identity(&path).unwrap();
    assert!(matches!(
        authority.register_workspace_child_observed_with_parent(
            &workspace,
            &[OsString::from("a.pgn")],
            "a",
            IdentityBinding::new(child, None),
            false,
            PathOperation::ReadPgn,
        ),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn unverified_legacy_workspace_child_stays_refused_and_passive_listing_mints_a_new_id() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("workspace");
    let original_parent = root_path.join("sub");
    fs::create_dir_all(&original_parent).unwrap();
    let path = original_parent.join("a.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let backup = dir.path().join("authorized-inode.pgn");
    fs::hard_link(&path, &backup).unwrap();
    let registry = dir.path().join("registry.json");
    let mut root_entry = stored_entry_for(
        &root_path,
        "workspace-root",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    );
    root_entry.target_is_dir = true;
    let mut child_entry = stored_entry_for(
        &path,
        "legacy-child",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    child_entry.parent_identity = None;
    write_registry_with_entries(&registry, vec![root_entry, child_entry]);
    fs::remove_file(&path).unwrap();

    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    let old_handle = PathRef {
        id: "legacy-child".into(),
    };
    assert_eq!(authority.parent_identity_for_test(&old_handle), None);
    fs::rename(&original_parent, root_path.join("sub.old")).unwrap();
    fs::create_dir(&original_parent).unwrap();
    fs::hard_link(&backup, &path).unwrap();

    let leaf_identity = identity(&path).unwrap();
    let parent_identity = identity(&original_parent).unwrap();
    let workspace = FileWorkspaceHandle::new(PathRef {
        id: "workspace-root".into(),
    });
    let new_handle = authority
        .register_workspace_child_observed_with_parent(
            &workspace,
            &[OsString::from("sub"), OsString::from("a.pgn")],
            "a",
            IdentityBinding::from_pairs(
                (leaf_identity.a, leaf_identity.b),
                (parent_identity.a, parent_identity.b),
            ),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    assert_ne!(new_handle.path_ref(), &old_handle);
    assert!(matches!(
        authority.resolve(&old_handle, PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
    assert!(authority
        .resolve(new_handle.path_ref(), PathOperation::ReadPgn, &[])
        .is_ok());
}

#[cfg(unix)]
#[test]
fn register_engine_file_keeps_the_acquired_parent_identity_across_registration_race() {
    let dir = tempfile::tempdir().unwrap();
    let parent = dir.path().join("engines");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("engine");
    fs::write(&path, b"engine").unwrap();
    let expected_parent = descriptor_parent_identity(&path);
    let replacement = parent.clone();
    let old_parent = parent.with_file_name("engines.old");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    PERSISTENT_FILE_POST_TARGET_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&replacement, &old_parent).unwrap();
                fs::create_dir(&replacement).unwrap();
                fs::hard_link(old_parent.join("engine"), replacement.join("engine")).unwrap();
            })))
            .is_none());
    });

    let handle = authority.register_engine_file(&path, "engine").unwrap();

    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(matches!(
        authority.resolve(handle.path_ref(), PathOperation::EngineBinaryInspect, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn installed_engine_registration_keeps_its_resolved_parent_during_registration_race() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("engines");
    let sub = root_path.join("sub");
    fs::create_dir_all(&sub).unwrap();
    fs::write(sub.join("engine"), b"engine").unwrap();
    let expected_parent = descriptor_parent_identity(&sub.join("engine"));
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_engine_root(&root_path, "Engines", None)
        .unwrap();
    let replacement = sub.clone();
    let old_parent = sub.with_file_name("sub.old");
    INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&replacement, &old_parent).unwrap();
                fs::create_dir(&replacement).unwrap();
                fs::hard_link(old_parent.join("engine"), replacement.join("engine")).unwrap();
            })))
            .is_none());
    });

    let handle = authority
        .register_installed_engine_for_test(&root, "sub/engine")
        .unwrap();

    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some((expected_parent.a, expected_parent.b))
    );
    assert!(matches!(
        authority.resolve(handle.path_ref(), PathOperation::EngineBinaryInspect, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&sub).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn engine_image_registration_keeps_authorized_directory_identity_during_registration_race() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = OsStr::new("image.png");
    let (_, installed) = image_dir
        .atomic_replace_leaf_identified(leaf, |file| file.write_all(b"image").map_err(Error::from))
        .unwrap();
    let expected_parent = image_dir.identity();
    let moved = dir.path().join("engine-images.old");
    let path = image_dir.path().to_path_buf();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    ENGINE_IMAGE_PRE_REGISTRATION_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&path, &moved).unwrap();
                fs::create_dir(&path).unwrap();
                fs::hard_link(moved.join(leaf), path.join(leaf)).unwrap();
            })))
            .is_none());
    });

    let handle = authority
        .register_engine_image(&image_dir, leaf, installed, "image".into())
        .unwrap();

    assert_eq!(
        authority.parent_identity_for_test(handle.path_ref()),
        Some(expected_parent.pair())
    );
    assert!(matches!(
        authority.resolve(handle.path_ref(), PathOperation::ImageRead, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(image_dir.path()).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn database_child_registration_refuses_a_root_swap_before_inserting_an_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("child.db3"), b"database").unwrap();
    let child_identity = identity(&root_path.join("child.db3")).unwrap();
    let old_root = dir.path().join("databases.old");
    let old_root_for_hook = old_root.clone();
    let replacement = root_path.clone();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let entries_before = authority.persistent.len();
    DATABASE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&replacement, &old_root_for_hook).unwrap();
                fs::create_dir(&replacement).unwrap();
                fs::hard_link(
                    old_root_for_hook.join("child.db3"),
                    replacement.join("child.db3"),
                )
                .unwrap();
            })))
            .is_none());
    });

    let error = authority
        .register_database_child(&root, OsStr::new("child.db3"), "child.db3", {
            (child_identity.a, child_identity.b)
        })
        .expect_err("root revalidation must reject the replaced database root");

    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    assert_eq!(authority.persistent.len(), entries_before);
    assert!(!authority
        .persistent
        .values()
        .any(|entry| entry.stored.purpose == Some(EntryPurpose::DatabaseFile)));
    assert_eq!(fs::read_dir(&root_path).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn puzzle_child_registration_refuses_a_root_swap_before_inserting_an_entry() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("puzzles");
    fs::create_dir(&root_path).unwrap();
    fs::write(root_path.join("child.db3"), b"puzzles").unwrap();
    let old_root = dir.path().join("puzzles.old");
    let replacement = root_path.clone();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_puzzle_root(&root_path, "Puzzles", None)
        .unwrap();
    PUZZLE_CHILD_POST_RESOLVE_HOOK.with(|slot| {
        assert!(slot
            .replace(Some(Box::new(move || {
                fs::rename(&replacement, &old_root).unwrap();
                fs::create_dir(&replacement).unwrap();
                fs::hard_link(old_root.join("child.db3"), replacement.join("child.db3")).unwrap();
            })))
            .is_none());
    });

    let error = authority
        .list_puzzle_children_cancellable(&root, &CancellationToken::new())
        .expect_err("root revalidation must reject the replaced puzzle root");

    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    assert!(!authority
        .persistent
        .values()
        .any(|entry| entry.stored.purpose == Some(EntryPurpose::PuzzleFile)));
    assert_eq!(fs::read_dir(&root_path).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn puzzle_listing_mints_a_stable_capability_for_a_replaced_file() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("puzzles");
    fs::create_dir(&root_path).unwrap();
    let x = root_path.join("x.db3");
    let y = root_path.join("y.db3");
    fs::write(&x, b"puzzles-x").unwrap();
    fs::write(&y, b"puzzles-y").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_puzzle_root(&root_path, "Puzzles", None)
        .unwrap();
    let first = authority
        .list_puzzle_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(first.len(), 2);
    let old_x = first
        .iter()
        .find(|entry| entry.filename == "x.db3")
        .unwrap()
        .file
        .clone();
    let held = fs::File::open(&x).unwrap();
    let replacement = root_path.join("x.replacement");
    fs::write(&replacement, b"puzzles-x-new").unwrap();
    fs::rename(&replacement, &x).unwrap();
    let current = opened_file_identity(&fs::File::open(&x).unwrap()).unwrap();
    assert_ne!(current, opened_file_identity(&held).unwrap());
    let second = authority
        .list_puzzle_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    assert_eq!(second.len(), 2);
    let names: BTreeSet<_> = second.iter().map(|entry| entry.filename.as_str()).collect();
    assert_eq!(names, BTreeSet::from(["x.db3", "y.db3"]));
    let new_x = second
        .iter()
        .find(|entry| entry.filename == "x.db3")
        .unwrap()
        .file
        .clone();
    assert_ne!(new_x, old_x);
    authority
        .resolve(&new_x, PathOperation::PuzzleRead, &[])
        .unwrap();
    assert!(matches!(
        authority.resolve(&old_x, PathOperation::PuzzleRead, &[]),
        Err(Error::UnknownPathCapability)
    ));
    let third = authority
        .list_puzzle_children_cancellable(&root, &CancellationToken::new())
        .unwrap();
    let listed_again = third
        .iter()
        .find(|entry| entry.filename == "x.db3")
        .unwrap()
        .file
        .clone();
    assert_eq!(listed_again, new_x);
}

/// Test 6 (R3-06): the stored root's ancestor is replaced by a symlink to the same directory
/// under another name before activation reads the root.
#[cfg(unix)]
#[test]
fn workspace_root_refuses_a_same_inode_ancestor_swap() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let moved = dir.path().join("moved");
    fs::create_dir_all(real.join("root")).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .get_or_create_database_root(&real.join("root"), "Databases", None)
        .unwrap();
    let workspace = FileWorkspaceHandle::new(root.path_ref().clone());
    assert_eq!(
        authority
            .workspace_root(&workspace, PathOperation::DatabaseRead)
            .unwrap(),
        real.join("root")
    );

    fs::rename(&real, &moved).unwrap();
    symlink(&moved, &real).unwrap();
    let error = authority
        .workspace_root(&workspace, PathOperation::DatabaseRead)
        .unwrap_err();
    assert!(matches!(error, Error::Conflict(_)), "{error:?}");
    assert!(authority.set_active_database_root(&root).is_err());
}

#[cfg(unix)]
#[test]
fn open_app_owned_resource_dir_distinguishes_missing_and_symlinked_sound() {
    let missing_root = tempfile::tempdir().unwrap();
    let before = fs::read_dir(missing_root.path()).unwrap().count();
    let missing = open_app_owned_resource_dir(&ResourceDir::for_test(missing_root.path()))
        .expect_err("missing sound must be refused");
    let missing_kind = match missing {
        Error::Io(error) => error.kind(),
        other => panic!("missing sound must be Error::Io: {other:?}"),
    };
    assert_eq!(missing_kind, std::io::ErrorKind::NotFound);
    assert_eq!(fs::read_dir(missing_root.path()).unwrap().count(), before);

    let symlink_root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(outside.path(), symlink_root.path().join("sound")).unwrap();
    let before = fs::read_dir(symlink_root.path()).unwrap().count();
    let symlinked = open_app_owned_resource_dir(&ResourceDir::for_test(symlink_root.path()))
        .expect_err("symlinked sound must be refused");
    let symlink_kind = match symlinked {
        Error::Io(error) => error.kind(),
        other => panic!("symlinked sound must be Error::Io: {other:?}"),
    };
    assert_eq!(symlink_kind, std::io::ErrorKind::InvalidInput);
    assert_eq!(fs::read_dir(symlink_root.path()).unwrap().count(), before);
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn authorized_dir_opens_nested_regular_file() {
    use std::io::Read as _;
    let root = tempfile::tempdir().unwrap();
    let sound = root.path().join("sound");
    fs::create_dir_all(sound.join("a")).unwrap();
    fs::write(sound.join("a/b"), b"nested bytes").unwrap();
    let directory = open_app_owned_resource_dir(&ResourceDir::for_test(root.path())).unwrap();

    let mut opened = directory.open_regular_relative(Path::new("a/b")).unwrap();
    let mut bytes = Vec::new();
    opened.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"nested bytes");
}

#[cfg(unix)]
#[test]
fn authorized_dir_refuses_invalid_relative_components() {
    let root = tempfile::tempdir().unwrap();
    let sound = root.path().join("sound");
    fs::create_dir(&sound).unwrap();
    // Put a real file at the normalised target. If the walk used `Path::components()` it would
    // drop the empty segment and the interior `.`, find this file, and open it.
    fs::create_dir(sound.join("a")).unwrap();
    fs::write(sound.join("a/b"), b"must not open").unwrap();
    let directory = open_app_owned_resource_dir(&ResourceDir::for_test(root.path())).unwrap();
    for relative in ["../x", "./x", "a//b", "/absolute"] {
        assert!(
            directory
                .open_regular_relative(Path::new(relative))
                .is_err(),
            "{relative} must be refused"
        );
    }
    let nul = PathBuf::from(OsString::from_vec(b"name\0tail".to_vec()));
    assert!(directory.open_regular_relative(&nul).is_err());
}

#[cfg(unix)]
#[test]
fn authorized_dir_refuses_an_intermediate_symlink() {
    let root = tempfile::tempdir().unwrap();
    let sound = root.path().join("sound");
    let outside = root.path().join("outside");
    fs::create_dir(&sound).unwrap();
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("x.mp3"), b"outside").unwrap();
    std::os::unix::fs::symlink(&outside, sound.join("link")).unwrap();
    let directory = open_app_owned_resource_dir(&ResourceDir::for_test(root.path())).unwrap();

    assert!(directory
        .open_regular_relative(Path::new("link/x.mp3"))
        .is_err());
}

#[cfg(unix)]
#[test]
fn authorized_dir_removes_only_a_matching_installed_leaf() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("sound")).unwrap();
    let directory = open_app_owned_resource_dir(&ResourceDir::for_test(root.path())).unwrap();
    let (_, installed) = directory
        .atomic_replace_leaf_identified(OsStr::new("track.mp3"), |file| {
            file.write_all(b"track").map_err(Error::from)
        })
        .unwrap();

    let other_root = tempfile::tempdir().unwrap();
    fs::create_dir(other_root.path().join("sound")).unwrap();
    let other = open_app_owned_resource_dir(&ResourceDir::for_test(other_root.path())).unwrap();
    assert!(directory
        .remove_leaf_identified(OsStr::new("track.mp3"), other.identity())
        .is_err());
    assert!(root.path().join("sound/track.mp3").is_file());

    directory
        .remove_leaf_identified(OsStr::new("track.mp3"), installed)
        .unwrap();
    assert!(!root.path().join("sound/track.mp3").exists());
}

#[cfg(unix)]
#[test]
fn authorized_dir_remove_leaf_refuses_a_non_leaf_name() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("sound")).unwrap();
    let directory = open_app_owned_resource_dir(&ResourceDir::for_test(root.path())).unwrap();
    let leaf = OsStr::new("track.mp3");
    let (_, installed) = directory
        .atomic_replace_leaf_identified(leaf, |file| file.write_all(b"track").map_err(Error::from))
        .unwrap();

    for invalid in ["../outside", "", "nested/track.mp3", "/absolute"] {
        assert!(
            directory
                .remove_leaf_identified(OsStr::new(invalid), installed)
                .is_err(),
            "{invalid} must be refused"
        );
        assert!(
            root.path().join("sound/track.mp3").is_file(),
            "the installed leaf must survive refusal of {invalid}"
        );
    }
}

#[test]
fn authorized_dir_has_no_arbitrary_path_constructor() {
    let source = test_source_files::production_source();
    for signature in ["impl AuthorizedDir {", "impl super::AuthorizedDir {"] {
        let implementation = body_at_indent(source, signature);
        assert!(!implementation.contains("for_test"), "{implementation}");
        assert!(!implementation.contains("fn new("), "{implementation}");
        assert!(!implementation.contains("path: &Path"), "{implementation}");
        assert!(
            !implementation.contains("path: PathBuf"),
            "{implementation}"
        );
    }

    let private_authorizer = ["authorize_existing", "_dir(path: &Path)"].concat();
    let expected_authorizer_signature =
        format!("fn {private_authorizer} -> Result<AuthorizedDir, Error> {{");
    let authorize_signatures: Vec<_> = source
        .lines()
        .filter(|line| line.contains(&private_authorizer))
        .collect();
    assert_eq!(authorize_signatures.len(), 1, "{authorize_signatures:?}");
    assert!(authorize_signatures
        .iter()
        .all(|line| *line == expected_authorizer_signature));

    let mut signature = String::new();
    let mut signature_is_public = false;
    let mut public_producers = Vec::new();
    for line in source.lines() {
        if line.contains("fn ") {
            signature.clear();
            signature.push_str(line.trim());
            signature_is_public = line.trim_start().starts_with("pub ")
                || line.trim_start().starts_with("pub(crate) ");
        } else if !signature.is_empty() {
            signature.push_str(line.trim());
        }
        if !line.contains("-> Result<AuthorizedDir") {
            continue;
        }
        if signature_is_public {
            let name = signature
                .split_once("fn ")
                .expect("function signature")
                .1
                .split_once('(')
                .expect("function parameters")
                .0;
            let parameters_start = signature.find('(').expect("function parameters") + 1;
            let parameters_end = signature.find("->").expect("function return");
            let parameters = &signature[parameters_start..parameters_end];
            assert!(!parameters.contains("&Path"), "{signature}");
            assert!(!parameters.contains("PathBuf"), "{signature}");
            public_producers.push(name.to_owned());
        }
    }
    assert_eq!(
        public_producers
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        [
            "reacquire",
            "ensure_app_owned_default_dir",
            "ensure_home_owned_default_dir",
            "resolve_visible_default_dir",
            "open_app_owned_resource_dir"
        ]
    );
}

/// Tauri production path resolution cannot be exercised by a unit test. Keep the constructor
/// expression pinned so it cannot append `sound` (or any other component) twice.
#[test]
fn resource_dir_for_app_is_exactly_the_resource_root() {
    let source = include_str!("mod.rs");
    let resource = source
        .split_once("impl ResourceDir {")
        .expect("ResourceDir implementation")
        .1;
    let body = body_at_indent(resource, "pub(crate) fn for_app<R: tauri::Runtime>(");
    let expression = body.split_once('{').expect("constructor body").1;
    let compact: String = expression.split_whitespace().collect();
    assert_eq!(compact, "Ok(Self(app.path().resource_dir()?))", "{body}");
    assert!(!body.contains(".join("), "{body}");
    assert!(!body.contains("BaseDirectory::"), "{body}");
    assert!(!body.contains('"'), "{body}");
}

/// The default callers materialise their directory before registering it; the dialog
/// callers must not. An absent user-picked folder means the disk changed under the user,
/// and the answer is an error rather than a silently recreated empty root. One test per
/// method, because with only one covered the other two could be converted quietly.
#[test]
fn get_or_create_database_root_refuses_an_absent_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let absent = dir.path().join("absent-database-root");
    assert!(path_authority
        .get_or_create_database_root(&absent, "Databases", None)
        .is_err());
    assert!(!absent.exists(), "the absent root must not be created");
}

#[test]
fn get_or_create_engine_root_refuses_an_absent_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let absent = dir.path().join("absent-engine-root");
    assert!(path_authority
        .get_or_create_engine_root(&absent, "Engines", None)
        .is_err());
    assert!(!absent.exists(), "the absent root must not be created");
}

#[test]
fn get_or_create_puzzle_root_refuses_an_absent_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let absent = dir.path().join("absent-puzzle-root");
    assert!(path_authority
        .get_or_create_puzzle_root(&absent, "Puzzles", None)
        .is_err());
    assert!(!absent.exists(), "the absent root must not be created");
}

#[cfg(unix)]
#[test]
fn active_roots_label_an_unsearchable_parent_as_permission() {
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::geteuid() } == 0 {
        return;
    }
    for domain in [
        AppOwnedDefaultRoot::Databases,
        AppOwnedDefaultRoot::Engines,
        AppOwnedDefaultRoot::Puzzles,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("parent");
        fs::create_dir(&parent).unwrap();
        let directory =
            ensure_app_owned_default_dir(&AppDataDir::for_test(&parent), domain).unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
        let id = get_or_create_app_owned_test_root(
            &mut authority,
            domain,
            &directory,
            directory.identity(),
        )
        .unwrap();
        set_active_app_owned_test_root(&mut authority, domain, &id);
        let permissions = fs::metadata(&parent).unwrap().permissions();
        fs::set_permissions(&parent, fs::Permissions::from_mode(0o0)).unwrap();
        let result = active_app_owned_test_root(&mut authority, domain);
        fs::set_permissions(&parent, permissions).unwrap();
        assert_eq!(
            result.unwrap_err().root_failure(),
            Some(crate::error::RootFailure::Permission)
        );
        assert_eq!(
            active_app_owned_test_root(&mut authority, domain).unwrap(),
            Some(id)
        );
    }
}

#[cfg(unix)]
#[test]
fn undecodable_active_roots_are_unusable_and_keep_the_selection() {
    for domain in [
        AppOwnedDefaultRoot::Databases,
        AppOwnedDefaultRoot::Engines,
        AppOwnedDefaultRoot::Puzzles,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let directory =
            ensure_app_owned_default_dir(&AppDataDir::for_test(dir.path()), domain).unwrap();
        let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
        let id = get_or_create_app_owned_test_root(
            &mut authority,
            domain,
            &directory,
            directory.identity(),
        )
        .unwrap();
        set_active_app_owned_test_root(&mut authority, domain, &id);
        let registry_path = dir.path().join("registry.json");
        let mut reloaded = super::portable_tests::reload_with_undecodable_root(&registry_path);
        let before = fs::read(&registry_path).unwrap();
        assert_eq!(
            active_app_owned_test_root(&mut reloaded, domain)
                .unwrap_err()
                .root_failure(),
            Some(crate::error::RootFailure::Unusable)
        );
        let active = match domain {
            AppOwnedDefaultRoot::Databases => &reloaded.active_database_root,
            AppOwnedDefaultRoot::Engines => &reloaded.active_engine_root,
            AppOwnedDefaultRoot::Puzzles => &reloaded.active_puzzle_root,
            _ => unreachable!(),
        };
        assert_eq!(active, &Some(id));
        assert_eq!(fs::read(&registry_path).unwrap(), before);
    }
}

fn persist_test_entry(
    path_authority: &mut PathAuthority,
    path: &Path,
    id: &str,
    purpose: EntryPurpose,
) -> PathRef {
    let stored = stored_entry_for(path, id, Some(purpose), canonical_operations(purpose));
    let id = stored.id.clone();
    let mut candidate = path_authority.persistent.clone();
    candidate.insert(
        id.id.clone(),
        Entry {
            stored,
            availability: PathAvailability::Available,
        },
    );
    path_authority.commit_candidate(candidate, None).unwrap();
    id
}

fn pending_test_artifact(root: &PathRef, id: &str) -> PendingArtifact {
    PendingArtifact {
        id: PathRef { id: id.into() },
        root: root.clone(),
        filename: NativePath::from_path(Path::new("artifact")),
        display_name: id.into(),
        operations: vec![PathOperation::ReadPgn],
        baseline: None,
        root_identity: None,
        payload_size: 0,
        payload_sha256: String::new(),
        payload_bound: false,
        installed_identity: None,
        installed_ctime_nanos: None,
    }
}

fn assert_app_owned_root_recovers_after_deleted_directory(root: AppOwnedDefaultRoot) {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let initial = ensure_app_owned_default_dir(&app_data, root).unwrap();
    let old_identity = initial.identity();
    let old_path = initial.path().to_path_buf();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let old_id =
        get_or_create_app_owned_test_root(&mut path_authority, root, &initial, old_identity)
            .unwrap();
    set_active_app_owned_test_root(&mut path_authority, root, &old_id);

    fs::remove_dir_all(&old_path).unwrap();
    assert_eq!(
        active_app_owned_test_root(&mut path_authority, root)
            .unwrap_err()
            .root_failure(),
        Some(crate::error::RootFailure::Missing)
    );

    let replacement = ensure_app_owned_default_dir(&app_data, root).unwrap();
    assert_ne!(replacement.identity(), old_identity);
    let new_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        root,
        &replacement,
        replacement.identity(),
    )
    .unwrap();
    set_active_app_owned_test_root(&mut path_authority, root, &new_id);

    assert!(!path_authority.persistent.contains_key(&old_id.id));
    assert_eq!(
        path_authority.persistent[&new_id.id].availability,
        PathAvailability::Available
    );
    assert_eq!(
        path_authority.persistent[&new_id.id].stored.identity,
        Identity {
            a: replacement.identity().pair().0,
            b: replacement.identity().pair().1,
        }
    );

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(!reopened.persistent.contains_key(&old_id.id));
    assert_eq!(
        reopened.persistent[&new_id.id].availability,
        PathAvailability::Available
    );
    assert_eq!(
        reopened.persistent[&new_id.id].stored.identity,
        Identity {
            a: replacement.identity().pair().0,
            b: replacement.identity().pair().1,
        }
    );
    assert!(reopened
        .provisional_attachments
        .iter()
        .all(|id| reopened.persistent.contains_key(id)));
}

#[test]
fn app_owned_database_root_recovers_after_deleted_directory() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let engines = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Engines).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let old_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &databases,
        databases.identity(),
    )
    .unwrap();
    set_active_app_owned_test_root(&mut path_authority, AppOwnedDefaultRoot::Databases, &old_id);
    let engines_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Engines,
        &engines,
        engines.identity(),
    )
    .unwrap();
    let resource = engines.path().join("resource.nnue");
    let resource_handle = attachment_resource(&mut path_authority, &resource);
    assert!(path_authority
        .persistent
        .contains_key(&resource_handle.id.id));
    assert!(path_authority
        .provisional_attachments
        .contains(&resource_handle.id.id));
    assert!(path_authority.persistent.contains_key(&engines_id.id));

    let old_identity = databases.identity();
    fs::remove_dir_all(databases.path()).unwrap();
    assert_eq!(
        path_authority
            .active_database_root()
            .unwrap_err()
            .root_failure(),
        Some(crate::error::RootFailure::Missing)
    );
    let replacement =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    assert_ne!(replacement.identity(), old_identity);
    let new_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &replacement,
        replacement.identity(),
    )
    .unwrap();
    set_active_app_owned_test_root(&mut path_authority, AppOwnedDefaultRoot::Databases, &new_id);
    assert!(!path_authority.persistent.contains_key(&old_id.id));
    assert!(path_authority.persistent.contains_key(&engines_id.id));
    assert!(path_authority
        .persistent
        .contains_key(&resource_handle.id.id));
    assert!(path_authority
        .provisional_attachments
        .contains(&resource_handle.id.id));

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(!reopened.persistent.contains_key(&old_id.id));
    assert!(reopened.persistent.contains_key(&engines_id.id));
    assert!(reopened.persistent.contains_key(&resource_handle.id.id));
    assert!(reopened
        .provisional_attachments
        .contains(&resource_handle.id.id));
}

#[test]
fn app_owned_engine_root_recovers_after_deleted_directory() {
    assert_app_owned_root_recovers_after_deleted_directory(AppOwnedDefaultRoot::Engines);
}

#[test]
fn app_owned_puzzle_root_recovers_after_deleted_directory() {
    assert_app_owned_root_recovers_after_deleted_directory(AppOwnedDefaultRoot::Puzzles);
}

#[test]
fn app_owned_database_root_recovery_prunes_stale_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let old_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &databases,
        databases.identity(),
    )
    .unwrap();
    set_active_app_owned_test_root(&mut path_authority, AppOwnedDefaultRoot::Databases, &old_id);

    let nested = databases.path().join("nested");
    let nested_file = nested.join("child");
    fs::create_dir(&nested).unwrap();
    fs::write(&nested_file, b"child").unwrap();
    let nested_id = persist_test_entry(
        &mut path_authority,
        &nested,
        "stale-nested",
        EntryPurpose::PgnWorkspace,
    );
    let nested_file_id = persist_test_entry(
        &mut path_authority,
        &nested_file,
        "stale-nested-file",
        EntryPurpose::PgnFile,
    );
    let sibling_root = dir.path().join("surviving");
    let sibling_file = sibling_root.join("sibling");
    fs::create_dir(&sibling_root).unwrap();
    fs::write(&sibling_file, b"sibling").unwrap();
    let sibling_id = persist_test_entry(
        &mut path_authority,
        &sibling_root,
        "surviving-root",
        EntryPurpose::PgnWorkspace,
    );
    let sibling_file_id = persist_test_entry(
        &mut path_authority,
        &sibling_file,
        "surviving-file",
        EntryPurpose::PgnFile,
    );

    fs::remove_dir_all(databases.path()).unwrap();
    assert_eq!(
        path_authority
            .active_database_root()
            .unwrap_err()
            .root_failure(),
        Some(crate::error::RootFailure::Missing)
    );
    let replacement =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let new_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &replacement,
        replacement.identity(),
    )
    .unwrap();
    assert!(!path_authority.persistent.contains_key(&old_id.id));
    assert!(!path_authority.persistent.contains_key(&nested_id.id));
    assert!(!path_authority.persistent.contains_key(&nested_file_id.id));
    assert!(path_authority.persistent.contains_key(&new_id.id));
    assert!(path_authority.persistent.contains_key(&sibling_id.id));
    assert!(path_authority.persistent.contains_key(&sibling_file_id.id));

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(!reopened.persistent.contains_key(&old_id.id));
    assert!(!reopened.persistent.contains_key(&nested_id.id));
    assert!(!reopened.persistent.contains_key(&nested_file_id.id));
    assert!(reopened.persistent.contains_key(&sibling_id.id));
    assert!(reopened.persistent.contains_key(&sibling_file_id.id));
}

#[test]
fn app_owned_database_root_recovery_prunes_pending_artifacts() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let old_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &databases,
        databases.identity(),
    )
    .unwrap();
    let sibling_path = dir.path().join("surviving");
    fs::create_dir(&sibling_path).unwrap();
    let sibling_id = path_authority
        .migrate_legacy_os_path_inner(
            sibling_path.clone().into_os_string(),
            "Surviving".into(),
            PathClass::PersistentCustomRoot,
            vec![PathOperation::DownloadFile],
            None,
            None,
        )
        .unwrap()
        .id;
    let stale_pending = path_authority
        .reserve_download_artifact(
            &old_id,
            OsString::from("stale"),
            (0, String::new()),
            "stale",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let sibling_pending = path_authority
        .reserve_download_artifact(
            &sibling_id,
            OsString::from("surviving"),
            (0, String::new()),
            "surviving",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let quarantined = pending_test_artifact(
        &PathRef {
            id: "already-absent-root".into(),
        },
        "quarantined",
    );
    path_authority.pending_artifacts.push(quarantined.clone());
    path_authority.save().unwrap();

    fs::remove_dir_all(databases.path()).unwrap();
    assert_eq!(path_authority.active_database_root().unwrap(), None);
    let replacement =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let new_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &replacement,
        replacement.identity(),
    )
    .unwrap();
    assert!(path_authority
        .pending_artifacts
        .iter()
        .all(|pending| pending.id != stale_pending.id));
    assert!(path_authority
        .pending_artifacts
        .iter()
        .any(|pending| pending.id == sibling_pending.id));
    assert!(path_authority
        .pending_artifacts
        .iter()
        .any(|pending| pending.id == quarantined.id));
    assert!(path_authority.persistent.contains_key(&new_id.id));

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(reopened
        .pending_artifacts
        .iter()
        .all(|pending| pending.id != stale_pending.id));
    assert!(reopened
        .pending_artifacts
        .iter()
        .any(|pending| pending.id == sibling_pending.id));
    assert!(reopened
        .pending_artifacts
        .iter()
        .any(|pending| pending.id == quarantined.id));
}

#[test]
fn app_owned_engine_root_recovery_prunes_provisional_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let engines = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Engines).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let old_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Engines,
        &engines,
        engines.identity(),
    )
    .unwrap();
    let resource = engines.path().join("resource.nnue");
    let resource_handle = attachment_resource(&mut path_authority, &resource);
    assert!(path_authority
        .provisional_attachments
        .contains(&resource_handle.id.id));
    fs::remove_dir_all(engines.path()).unwrap();
    assert_eq!(path_authority.active_engine_root().unwrap(), None);
    let replacement =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Engines).unwrap();
    let new_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Engines,
        &replacement,
        replacement.identity(),
    )
    .unwrap();
    assert!(!path_authority.persistent.contains_key(&old_id.id));
    assert!(!path_authority
        .persistent
        .contains_key(&resource_handle.id.id));
    assert!(!path_authority
        .provisional_attachments
        .contains(&resource_handle.id.id));
    assert!(path_authority.persistent.contains_key(&new_id.id));

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(!reopened.persistent.contains_key(&old_id.id));
    assert!(!reopened.persistent.contains_key(&resource_handle.id.id));
    assert!(!reopened
        .provisional_attachments
        .contains(&resource_handle.id.id));
}

#[test]
fn app_owned_database_root_recovery_keeps_registry_unchanged_on_persistence_failure() {
    struct RegistryFailure;
    impl AtomicWriterInjector for RegistryFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::TempfileCreate {
                Err(std::io::Error::other("registry failure"))
            } else {
                Ok(())
            }
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let engines = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Engines).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let old_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &databases,
        databases.identity(),
    )
    .unwrap();
    set_active_app_owned_test_root(&mut path_authority, AppOwnedDefaultRoot::Databases, &old_id);
    let engines_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Engines,
        &engines,
        engines.identity(),
    )
    .unwrap();
    let resource = engines.path().join("resource.nnue");
    let resource_handle = attachment_resource(&mut path_authority, &resource);
    let pending = path_authority
        .reserve_download_artifact(
            &old_id,
            OsString::from("pending"),
            (0, String::new()),
            "pending",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    let child_path = databases.path().join("child.db3");
    fs::write(&child_path, b"child").unwrap();
    let child = path_authority
        .register_database_child(
            &DatabaseRootHandle::new(old_id.clone()),
            OsStr::new("child.db3"),
            "child",
            observed_identity(&databases.path().join("child.db3")),
        )
        .unwrap();
    assert!(path_authority.persistent.contains_key(&engines_id.id));
    assert!(path_authority
        .provisional_attachments
        .contains(&resource_handle.id.id));
    path_authority.save().unwrap();

    fs::remove_dir_all(databases.path()).unwrap();
    assert_eq!(
        path_authority
            .active_database_root()
            .unwrap_err()
            .root_failure(),
        Some(crate::error::RootFailure::Missing)
    );
    let replacement =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    assert_ne!(replacement.identity(), databases.identity());

    let persistent_before = path_authority.persistent.clone();
    let pending_before = serde_json::to_vec(&path_authority.pending_artifacts).unwrap();
    let provisional_before = path_authority.provisional_attachments.clone();
    let removals_before = path_authority.pending_unpersisted_removals.clone();
    let active_before = path_authority.active_database_root.clone();
    let bytes_before = fs::read(dir.path().join("registry.json")).unwrap();

    set_test_atomic_file_injector(Some(Arc::new(RegistryFailure)));
    let result = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &replacement,
        replacement.identity(),
    );
    set_test_atomic_file_injector(None);
    assert!(matches!(result, Err(Error::Io(_))), "{result:?}");
    assert!(path_authority.persistent == persistent_before);
    assert_eq!(
        serde_json::to_vec(&path_authority.pending_artifacts).unwrap(),
        pending_before
    );
    assert_eq!(path_authority.provisional_attachments, provisional_before);
    assert_eq!(path_authority.pending_unpersisted_removals, removals_before);
    assert_eq!(path_authority.active_database_root, active_before);
    assert_eq!(
        fs::read(dir.path().join("registry.json")).unwrap(),
        bytes_before
    );
    assert!(path_authority.persistent.contains_key(&old_id.id));
    assert!(path_authority.persistent.contains_key(&child.id.id));
    assert!(path_authority
        .pending_artifacts
        .iter()
        .any(|item| item.id == pending.id));

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(reopened.persistent.contains_key(&old_id.id));
    assert!(reopened.persistent.contains_key(&child.id.id));
    assert_eq!(
        fs::read(dir.path().join("registry.json")).unwrap(),
        bytes_before
    );
}

#[test]
fn app_owned_engine_root_recovery_drops_tombstoned_provisional_markers() {
    struct RegistryFailure;
    impl AtomicWriterInjector for RegistryFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::TempfileCreate {
                Err(std::io::Error::other("registry failure"))
            } else {
                Ok(())
            }
        }
    }

    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let engines = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Engines).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let _database_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &databases,
        databases.identity(),
    )
    .unwrap();
    let engines_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Engines,
        &engines,
        engines.identity(),
    )
    .unwrap();
    let resource = engines.path().join("resource.nnue");
    let resource_handle = attachment_resource(&mut path_authority, &resource);
    assert!(path_authority
        .provisional_attachments
        .contains(&resource_handle.id.id));
    set_test_atomic_file_injector(Some(Arc::new(RegistryFailure)));
    let mut dropped = Vec::new();
    assert!(path_authority
        .remove_workspace_entry(
            &FileWorkspaceHandle::new(engines_id.clone()),
            WorkspaceRemovalStatus::Complete,
            &mut dropped,
        )
        .map(|(durability, _)| durability)
        .is_err());
    set_test_atomic_file_injector(None);
    assert!(path_authority
        .pending_unpersisted_removals
        .contains(&engines_id.id));
    assert!(path_authority
        .pending_unpersisted_removals
        .contains(&resource_handle.id.id));
    assert!(path_authority
        .persistent
        .contains_key(&resource_handle.id.id));

    fs::remove_dir_all(databases.path()).unwrap();
    assert_eq!(path_authority.active_database_root().unwrap(), None);
    let replacement =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let new_id = get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &replacement,
        replacement.identity(),
    )
    .unwrap();
    assert!(path_authority.persistent.contains_key(&new_id.id));

    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(!reopened
        .provisional_attachments
        .contains(&resource_handle.id.id));
}

#[test]
fn app_owned_database_root_disagreeing_expected_identity_after_registration_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let app_data = AppDataDir::for_test(dir.path());
    let databases =
        ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Databases).unwrap();
    let engines = ensure_app_owned_default_dir(&app_data, AppOwnedDefaultRoot::Engines).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    get_or_create_app_owned_test_root(
        &mut path_authority,
        AppOwnedDefaultRoot::Databases,
        &databases,
        databases.identity(),
    )
    .unwrap();
    let error = path_authority
        .get_or_create_database_root(databases.path(), "Databases", Some(engines.identity()))
        .expect_err("a live identity from another path must be refused");
    assert!(matches!(
        error.unlabelled(),
        Error::Conflict(message)
            if message == "verified identity does not match registration target"
    ));
}

#[cfg(unix)]
fn assert_app_owned_root_swap_is_refused(root: AppOwnedDefaultRoot) {
    let dir = tempfile::tempdir().unwrap();
    let directory = ensure_app_owned_default_dir(&AppDataDir::for_test(dir.path()), root).unwrap();
    let original = dir.path().join(format!("{}-original", root.leaf()));
    fs::rename(directory.path(), &original).unwrap();
    fs::create_dir(directory.path()).unwrap();

    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let error = get_or_create_app_owned_test_root(
        &mut path_authority,
        root,
        &directory,
        directory.identity(),
    )
    .expect_err("a directory swapped after authorization must be refused");
    assert!(
        matches!(error.unlabelled(), Error::Conflict(_)),
        "{error:?}"
    );
    assert!(!error.to_string().contains('/'), "{error:?}");
    assert!(path_authority.persistent.is_empty());
}

#[cfg(unix)]
#[test]
fn app_owned_database_root_swap_before_registration_is_refused() {
    assert_app_owned_root_swap_is_refused(AppOwnedDefaultRoot::Databases);
}

#[cfg(unix)]
#[test]
fn app_owned_engine_root_swap_before_registration_is_refused() {
    assert_app_owned_root_swap_is_refused(AppOwnedDefaultRoot::Engines);
}

#[cfg(unix)]
#[test]
fn app_owned_puzzle_root_swap_before_registration_is_refused() {
    assert_app_owned_root_swap_is_refused(AppOwnedDefaultRoot::Puzzles);
}

fn assert_app_owned_root_reuses_descriptor_identity_after_reload(root: AppOwnedDefaultRoot) {
    let dir = tempfile::tempdir().unwrap();
    let directory = ensure_app_owned_default_dir(&AppDataDir::for_test(dir.path()), root).unwrap();
    let expected_identity = directory.identity();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let original =
        get_or_create_app_owned_test_root(&mut path_authority, root, &directory, expected_identity)
            .unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    let reused =
        get_or_create_app_owned_test_root(&mut reloaded, root, &directory, expected_identity)
            .unwrap();
    assert_eq!(reused, original);
    assert_eq!(reloaded.persistent.len(), 1);
}

#[test]
fn app_owned_database_root_reuses_descriptor_identity_after_reload() {
    assert_app_owned_root_reuses_descriptor_identity_after_reload(AppOwnedDefaultRoot::Databases);
}

#[test]
fn app_owned_engine_root_reuses_descriptor_identity_after_reload() {
    assert_app_owned_root_reuses_descriptor_identity_after_reload(AppOwnedDefaultRoot::Engines);
}

#[test]
fn app_owned_puzzle_root_reuses_descriptor_identity_after_reload() {
    assert_app_owned_root_reuses_descriptor_identity_after_reload(AppOwnedDefaultRoot::Puzzles);
}

#[test]
fn active_puzzle_root_is_restart_safe_and_rejects_a_replaced_custom_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("puzzles");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let handle = path_authority
        .get_or_create_puzzle_root(&root, "Puzzles", None)
        .unwrap();
    path_authority.set_active_puzzle_root(&handle).unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    assert_eq!(
        reloaded
            .active_puzzle_root()
            .unwrap()
            .map(|descriptor| descriptor.root),
        Some(handle)
    );
    let replacement = dir.path().join("replacement-puzzle-root");
    fs::create_dir(&replacement).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&root).unwrap();
    fs::rename(&replacement, &root).unwrap();
    assert_eq!(
        reloaded.active_puzzle_root().unwrap_err().root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
}

#[test]
fn active_engine_root_is_restart_safe_and_rejects_a_replaced_custom_root() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("engines");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let handle = path_authority
        .get_or_create_engine_root(&root, "Engines", None)
        .unwrap();
    path_authority.set_active_engine_root(&handle).unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    assert_eq!(reloaded.active_engine_root().unwrap(), Some(handle));
    let replacement = dir.path().join("replacement-engine-root");
    fs::create_dir(&replacement).unwrap();
    #[cfg(windows)]
    fs::remove_dir(&root).unwrap();
    fs::rename(&replacement, &root).unwrap();
    assert_eq!(
        reloaded.active_engine_root().unwrap_err().root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
}

#[test]
fn legacy_engine_file_is_backfilled_and_reused_after_reload() {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("engine");
    fs::write(&executable, b"engine").unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let legacy = path_authority
        .get_or_create_persistent_file(
            &executable,
            "engine",
            vec![
                PathOperation::EngineExecute,
                PathOperation::EngineConfigure,
                PathOperation::EngineInstall,
            ],
        )
        .unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    let registered = reloaded
        .register_engine_file(&executable, "engine")
        .unwrap();
    assert_eq!(registered.path_ref(), &legacy.id);
    assert_eq!(reloaded.persistent.len(), 1);
    assert_eq!(
        reloaded
            .persistent
            .get(&legacy.id.id)
            .unwrap()
            .stored
            .operations,
        vec![
            PathOperation::EngineExecute,
            PathOperation::EngineConfigure,
            PathOperation::EngineInstall,
            PathOperation::EngineBinaryInspect,
        ]
    );
}

#[test]
fn engine_root_is_not_backfilled_and_reuses_its_id_after_reload() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("engines");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let original = path_authority
        .get_or_create_engine_root(&root, "Engines", None)
        .unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    let reused = reloaded
        .get_or_create_engine_root(&root, "Engines", None)
        .unwrap();
    assert_eq!(reused, original);
    assert_eq!(reloaded.persistent.len(), 1);
    assert_eq!(
        reloaded
            .persistent
            .get(&original.path_ref().id)
            .unwrap()
            .stored
            .operations,
        vec![
            PathOperation::DownloadArchive,
            PathOperation::EngineInstall,
            PathOperation::EngineExecute,
            PathOperation::EngineConfigure,
        ]
    );
}

#[test]
fn database_root_is_not_backfilled_and_reuses_its_id_after_reload() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("databases");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let original = path_authority
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    let reused = reloaded
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap();
    assert_eq!(reused, original);
    assert_eq!(reloaded.persistent.len(), 1);
    assert_eq!(
        reloaded
            .persistent
            .get(&original.path_ref().id)
            .unwrap()
            .stored
            .operations,
        vec![
            PathOperation::DatabaseRead,
            PathOperation::DatabaseMutate,
            PathOperation::DatabaseCreate,
            PathOperation::DatabaseExport,
            PathOperation::DownloadFile,
        ]
    );
}

#[test]
fn puzzle_root_is_not_backfilled_and_reuses_its_id_after_reload() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("puzzles");
    fs::create_dir(&root).unwrap();
    let clock = Arc::new(TestClock::new(1));
    let mut path_authority = authority(&dir, clock.clone());
    let original = path_authority
        .get_or_create_puzzle_root(&root, "Puzzles", None)
        .unwrap();
    drop(path_authority);

    let mut reloaded = authority(&dir, clock);
    let reused = reloaded
        .get_or_create_puzzle_root(&root, "Puzzles", None)
        .unwrap();
    assert_eq!(reused, original);
    assert_eq!(reloaded.persistent.len(), 1);
    assert_eq!(
        reloaded
            .persistent
            .get(&original.path_ref().id)
            .unwrap()
            .stored
            .operations,
        vec![
            PathOperation::PuzzleRead,
            PathOperation::PuzzleDelete,
            PathOperation::DownloadFile,
        ]
    );
}

/// Replaces a registered root with a different directory of the same name,
/// so the reuse lookup still matches while the stored identity no longer
/// does. The noun in the message is asserted per root type: one shared noun
/// across the three methods would tell the renderer to re-select the wrong
/// root.
fn replace_root_directory(dir: &tempfile::TempDir, root: &Path, replacement_name: &str) {
    let replacement = dir.path().join(replacement_name);
    fs::create_dir(&replacement).unwrap();
    // POSIX atomically replaces an empty directory, whereas Windows
    // requires its target to be absent.
    #[cfg(windows)]
    fs::remove_dir(root).unwrap();
    fs::rename(&replacement, root).unwrap();
}

#[test]
fn database_root_reuse_rejects_a_replaced_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("databases");
    fs::create_dir(&root).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    path_authority
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap();
    replace_root_directory(&dir, &root, "replacement-database-root");

    let error = path_authority
        .get_or_create_database_root(&root, "Databases", None)
        .unwrap_err();
    assert!(
        matches!(error.unlabelled(), Error::Conflict(message)
                if message == "database root changed; select it again"),
        "unexpected error: {error:?}"
    );
}

#[test]
fn puzzle_root_reuse_rejects_a_replaced_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("puzzles");
    fs::create_dir(&root).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    path_authority
        .get_or_create_puzzle_root(&root, "Puzzles", None)
        .unwrap();
    replace_root_directory(&dir, &root, "replacement-puzzle-root");

    let error = path_authority
        .get_or_create_puzzle_root(&root, "Puzzles", None)
        .unwrap_err();
    assert!(
        matches!(&error, Error::Conflict(message)
                if message == "puzzle root changed; select it again"),
        "unexpected error: {error:?}"
    );
}

#[test]
fn engine_root_reuse_rejects_a_replaced_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("engines");
    fs::create_dir(&root).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    path_authority
        .get_or_create_engine_root(&root, "Engines", None)
        .unwrap();
    replace_root_directory(&dir, &root, "replacement-engine-root");

    let error = path_authority
        .get_or_create_engine_root(&root, "Engines", None)
        .unwrap_err();
    assert!(
        matches!(&error, Error::Conflict(message)
                if message == "engine root changed; select it again"),
        "unexpected error: {error:?}"
    );
}

#[test]
fn windows_resource_leaf_sealing_uses_the_shared_operation_policy() {
    assert!(
        !allows_delete_sharing_for_operation(PathOperation::EngineResourceRead, true),
        "an authorized engine resource leaf must deny delete sharing"
    );
    assert!(allows_delete_sharing_for_operation(
        PathOperation::EngineResourceRead,
        false
    ));
    assert!(allows_delete_sharing_for_operation(
        PathOperation::OpeningBookRead,
        true
    ));
}

#[test]
fn windows_launch_sealing_covers_execute_and_configure_engine_operations() {
    assert!(!allows_delete_sharing_for_operation(
        PathOperation::EngineExecute,
        true
    ));
    assert!(!allows_delete_sharing_for_operation(
        PathOperation::EngineConfigure,
        true
    ));
    assert!(allows_delete_sharing_for_operation(
        PathOperation::EngineExecute,
        false
    ));
    assert!(allows_delete_sharing_for_operation(
        PathOperation::OpeningBookRead,
        true
    ));
    assert!(!is_write_operation(PathOperation::EngineConfigure));
}

#[test]
fn write_operation_policy_is_exhaustive() {
    for operation in [
        PathOperation::WritePgn,
        PathOperation::DatabaseMutate,
        PathOperation::DatabaseCreate,
        PathOperation::DatabaseExport,
        PathOperation::PuzzleDelete,
        PathOperation::EngineInstall,
        PathOperation::SnapshotWrite,
        PathOperation::LogWrite,
    ] {
        assert!(is_write_operation(operation), "{operation:?}");
    }
    for operation in [
        PathOperation::ReadPgn,
        PathOperation::DatabaseRead,
        PathOperation::PuzzleRead,
        PathOperation::EngineExecute,
        PathOperation::EngineConfigure,
        PathOperation::EngineBinaryInspect,
        PathOperation::OpeningBookRead,
        PathOperation::ImageRead,
        PathOperation::DownloadFile,
        PathOperation::DownloadArchive,
        PathOperation::OpenShell,
    ] {
        assert!(!is_write_operation(operation), "{operation:?}");
    }
}

#[test]
fn relative_components_reject_dot_and_nul_independently() {
    assert!(validate_components(&[OsString::from(".")]).is_err());
    assert!(validate_components(&[OsString::from("..")]).is_err());
    assert!(validate_components(&[OsString::from_vec(b"name\0tail".to_vec())]).is_err());
    assert!(validate_components(&[OsString::from("regular")]).is_ok());
}

#[test]
fn persisted_entry_shape_validates_every_field_independently() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file.pgn");
    fs::write(&file, b"pgn").unwrap();
    let valid = stored_entry_for(&file, "valid", None, vec![PathOperation::ReadPgn]);
    assert!(validate_persisted_shape(&valid).is_ok());

    let invalid = [
        StoredEntry {
            class: PathClass::SingleDialogGrant,
            ..valid.clone()
        },
        StoredEntry {
            operations: vec![],
            ..valid.clone()
        },
        StoredEntry {
            id: PathRef { id: String::new() },
            ..valid.clone()
        },
        StoredEntry {
            display_name: String::new(),
            ..valid.clone()
        },
        StoredEntry {
            target_is_dir: true,
            ..valid.clone()
        },
        StoredEntry {
            class: PathClass::PersistentCustomRoot,
            target_is_dir: false,
            ..valid
        },
    ];
    for entry in invalid {
        assert!(validate_persisted_shape(&entry).is_err(), "{entry:?}");
    }
}

#[test]
fn persisted_purpose_accepts_canonical_historical_subset_and_legacy_engine_operations() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("engine");
    fs::write(&file, b"engine").unwrap();
    let base = stored_entry_for(
        &file,
        "canonical-engine",
        Some(EntryPurpose::EngineExecutable),
        vec![
            PathOperation::EngineExecute,
            PathOperation::EngineConfigure,
            PathOperation::EngineInstall,
            PathOperation::EngineBinaryInspect,
        ],
    );

    assert!(validate_persisted_shape(&base).is_ok());
    assert!(validate_persisted_shape(&StoredEntry {
        purpose: Some(EntryPurpose::DatabaseFile),
        operations: vec![PathOperation::DatabaseRead],
        ..base.clone()
    })
    .is_ok());
    assert!(validate_persisted_shape(&StoredEntry {
        operations: vec![
            PathOperation::EngineExecute,
            PathOperation::EngineConfigure,
            PathOperation::EngineInstall,
        ],
        ..base
    })
    .is_ok());
}

#[test]
fn persisted_purpose_rejects_wrong_purpose_class_and_operations() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("engine");
    fs::write(&file, b"engine").unwrap();
    let legacy_engine = stored_entry_for(
        &file,
        "legacy-engine",
        Some(EntryPurpose::EngineExecutable),
        vec![
            PathOperation::EngineExecute,
            PathOperation::EngineConfigure,
            PathOperation::EngineInstall,
        ],
    );

    let invalid = [
        StoredEntry {
            purpose: Some(EntryPurpose::EngineImage),
            ..legacy_engine.clone()
        },
        StoredEntry {
            class: PathClass::PersistentCustomRoot,
            target_is_dir: true,
            ..legacy_engine.clone()
        },
        StoredEntry {
            operations: vec![PathOperation::ImageRead],
            ..legacy_engine
        },
    ];

    for entry in invalid {
        assert!(validate_persisted_shape(&entry).is_err(), "{entry:?}");
    }
}

#[cfg(unix)]
#[test]
fn read_only_engine_can_be_resolved_for_configuration() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("engine");
    fs::write(&executable, b"engine").unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o555)).unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let handle = path_authority
        .register_engine_file(&executable, "engine")
        .unwrap();
    assert!(path_authority
        .engine_executable(&handle, PathOperation::EngineConfigure)
        .is_ok());
}

#[test]
fn engine_binary_inspection_cannot_read_bytes_or_become_a_read_file() {
    let dir = tempfile::tempdir().unwrap();
    let executable = dir.path().join("engine");
    fs::write(&executable, b"engine").unwrap();
    let mut path_authority = authority(&dir, Arc::new(TestClock::new(1)));
    let handle = path_authority
        .register_engine_file(&executable, "engine")
        .unwrap();

    let mut byte_reader = path_authority
        .resolve(handle.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .unwrap();
    assert!(byte_reader.read_bytes().is_err());
    let file_reader = path_authority
        .resolve(handle.path_ref(), PathOperation::EngineBinaryInspect, &[])
        .unwrap();
    assert!(file_reader.into_read_file().is_err());
}

fn writable_root(
    dir: &tempfile::TempDir,
    operations: Vec<PathOperation>,
) -> (PathAuthority, PathRef) {
    let root = dir.path().join("root");
    fs::create_dir(&root).unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let grant = authority
        .grant_dialog_operations(
            &root,
            "root",
            PathClass::BoundedDialogGrant,
            operations.clone(),
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    let root = authority
        .promote_dialog(&grant, PathClass::PersistentCustomRoot, "root", operations)
        .unwrap()
        .id;
    (authority, root)
}

#[test]
fn persist_workspace_parent_sync_surfaces_uncertain_and_keeps_candidate() {
    let dir = tempfile::tempdir().unwrap();
    let (mut authority, root) =
        writable_root(&dir, vec![PathOperation::ReadPgn, PathOperation::WritePgn]);
    fs::write(dir.path().join("root/game.pgn"), b"*").unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    let error = authority
        .register_workspace_child_observed(
            &FileWorkspaceHandle::new(root),
            &[OsString::from("game.pgn")],
            "game",
            observed_identity(&dir.path().join("root/game.pgn")),
            false,
            PathOperation::ReadPgn,
        )
        .expect_err("uncertain persistence must be surfaced");
    set_test_atomic_file_injector(None);
    assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
    assert!(authority
        .persistent
        .values()
        .any(|entry| entry.stored.display_name == "game"));
}

#[cfg(unix)]
#[test]
fn create_database_child_parent_sync_does_not_roll_back_completed_file() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(&root_path, "databases", None)
        .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    let error = authority
        .create_database_child(&root, OsStr::new("created.db3"))
        .expect_err("uncertain registry durability must be surfaced");
    set_test_atomic_file_injector(None);
    assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
    assert!(root_path.join("created.db3").exists());
    assert_eq!(
        authority
            .list_database_children_cancellable(&root, &CancellationToken::new())
            .unwrap()
            .entries
            .iter()
            .filter(|item| item.filename == "created.db3")
            .count(),
        1
    );
}

#[test]
fn engine_path_commit_wrappers_return_handle_on_uncertain_without_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let engine = dir.path().join("engine");
    let book = dir.path().join("book.bin");
    let resource = dir.path().join("resource.nnue");
    for path in [&engine, &book, &resource] {
        fs::write(path, b"data").unwrap();
    }
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let image_leaf = OsStr::new("image.png");
    let (_, installed_image) = image_dir
        .atomic_replace_leaf_identified(image_leaf, |file| {
            file.write_all(b"data").map_err(Error::from)
        })
        .unwrap();
    let image = image_dir.path().join(image_leaf);
    let book_parent = descriptor_parent_identity(&book);
    let resource_parent = descriptor_parent_identity(&resource);
    let grant = authority
        .grant_dialog(
            &resource,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    let engine_handle = authority
        .register_engine_file(&engine, "engine")
        .expect("adopted engine handle");
    let image_handle = authority
        .register_engine_image(&image_dir, image_leaf, installed_image, "image".into())
        .expect("adopted image handle");
    let book_handle = authority
        .register_opening_book(&book, "book")
        .expect("adopted book handle");
    let resource_handle = authority
        .promote_engine_resource(&grant, EngineResourceHandleKind::File, "resource")
        .expect("adopted resource handle");
    set_test_atomic_file_injector(None);
    for path in [&engine, &image, &book, &resource] {
        assert!(authority
            .persistent
            .values()
            .any(|entry| { entry.stored.path.to_path().ok().as_ref() == Some(path) }));
    }
    assert_eq!(
        authority.parent_identity_for_test(book_handle.path_ref()),
        Some((book_parent.a, book_parent.b))
    );
    assert!(authority
        .resolve(book_handle.path_ref(), PathOperation::OpeningBookRead, &[])
        .is_ok());
    assert_eq!(
        authority.parent_identity_for_test(resource_handle.path_ref()),
        Some((resource_parent.a, resource_parent.b))
    );
    let engine_again = authority
        .register_engine_file(&engine, "engine")
        .expect("lookup of adopted engine");
    let image_again = authority
        .register_engine_image(&image_dir, image_leaf, installed_image, "image".into())
        .expect("lookup of adopted image");
    let book_again = authority
        .register_opening_book(&book, "book")
        .expect("lookup of adopted book");
    assert_eq!(engine_handle, engine_again);
    assert_eq!(image_handle, image_again);
    assert_eq!(book_handle, book_again);
    authority
        .engine_resource(&resource_handle)
        .expect("adopted resource still resolves");
    assert_ne!(engine_handle.id, image_handle.id);
    assert_ne!(engine_handle.id, book_handle.id);
    assert_ne!(engine_handle.id, resource_handle.id);
}

#[test]
fn set_active_roots_parent_sync_returns_ok_and_keeps_handles_usable() {
    let dir = tempfile::tempdir().unwrap();
    let database_path = dir.path().join("databases");
    let puzzle_path = dir.path().join("puzzles");
    let engine_path = dir.path().join("engines");
    for path in [&database_path, &puzzle_path, &engine_path] {
        fs::create_dir(path).unwrap();
    }
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let database = authority
        .get_or_create_database_root(&database_path, "databases", None)
        .unwrap();
    let puzzle = authority
        .get_or_create_puzzle_root(&puzzle_path, "puzzles", None)
        .unwrap();
    let engine = authority
        .get_or_create_engine_root(&engine_path, "engines", None)
        .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    authority.set_active_database_root(&database).unwrap();
    authority.set_active_puzzle_root(&puzzle).unwrap();
    authority.set_active_engine_root(&engine).unwrap();
    set_test_atomic_file_injector(None);
    assert_eq!(authority.active_database_root().unwrap(), Some(database));
    assert_eq!(
        authority
            .active_puzzle_root()
            .unwrap()
            .map(|descriptor| descriptor.root),
        Some(puzzle)
    );
    assert_eq!(authority.active_engine_root().unwrap(), Some(engine));
}

#[test]
fn rebind_workspace_parent_sync_keeps_new_path() {
    let dir = tempfile::tempdir().unwrap();
    let (mut authority, root) =
        writable_root(&dir, vec![PathOperation::ReadPgn, PathOperation::WritePgn]);
    let old = dir.path().join("root/old.pgn");
    let new = dir.path().join("root/new.pgn");
    fs::write(&old, b"*").unwrap();
    let handle = authority
        .register_workspace_child_observed(
            &FileWorkspaceHandle::new(root),
            &[OsString::from("old.pgn")],
            "old",
            observed_identity(&old),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    fs::rename(&old, &new).unwrap();
    let new_parent = crate::infra::fs::open_parent_no_follow(&new).unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    let error = authority
        .rebind_workspace_entry(
            &handle,
            &new,
            "new",
            opened_file_identity(&new_parent).unwrap(),
        )
        .expect_err("uncertain registry durability must be surfaced");
    set_test_atomic_file_injector(None);
    assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
    assert_eq!(
        authority
            .workspace_entry_path(&handle, PathOperation::ReadPgn)
            .unwrap(),
        new
    );
}

#[test]
fn rebase_workspace_parent_sync_keeps_rebased_paths() {
    let dir = tempfile::tempdir().unwrap();
    let (mut authority, root) =
        writable_root(&dir, vec![PathOperation::ReadPgn, PathOperation::WritePgn]);
    let old = dir.path().join("root/old");
    let new = dir.path().join("root/new");
    fs::create_dir(&old).unwrap();
    let handle = authority
        .register_workspace_child_observed(
            &FileWorkspaceHandle::new(root),
            &[OsString::from("old")],
            "old",
            observed_identity(&old),
            true,
            PathOperation::ReadPgn,
        )
        .unwrap();
    fs::rename(&old, &new).unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    let error = authority
        .rebase_workspace_entries(&old, &new)
        .expect_err("uncertain registry durability must be surfaced");
    set_test_atomic_file_injector(None);
    assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
    assert_eq!(
        authority
            .workspace_entry_path(&handle, PathOperation::ReadPgn)
            .unwrap(),
        new
    );
}

#[test]
fn abandon_download_artifact_adopts_uncertain_but_not_failed_save() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("downloads");
    fs::create_dir(&root_path).unwrap();
    let staged = dir.path().join("staged");
    fs::write(&staged, b"payload").unwrap();
    let app = AppOwnedRoot::new("downloads", root_path, vec![PathOperation::DownloadFile]);
    let root = app.id.clone();
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![app]).unwrap();
    let first = authority
        .reserve_download_artifact(
            &root,
            OsString::from("first"),
            sha256_file(&staged).unwrap(),
            "first",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    authority.abandon_download_artifact(&first);
    set_test_atomic_file_injector(None);
    assert!(authority.pending_artifacts.is_empty());

    let second = authority
        .reserve_download_artifact(
            &root,
            OsString::from("second"),
            sha256_file(&staged).unwrap(),
            "second",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    authority.abandon_download_artifact(&second);
    set_test_atomic_file_injector(None);
    assert!(authority
        .pending_artifacts
        .iter()
        .any(|pending| pending.id == second.id));
}

struct AlwaysIo;

impl AtomicWriterInjector for AlwaysIo {
    fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
        if point == AtomicFileFaultPoint::Write {
            Err(std::io::Error::other("write failed"))
        } else {
            Ok(())
        }
    }
}

#[test]
fn registry_write_retries_once() {
    let dir = tempfile::tempdir().unwrap();
    let authority = authority(&dir, Arc::new(TestClock::new(0)));
    let attempts = std::rc::Rc::new(std::cell::Cell::new(0));
    let observed = attempts.clone();
    let durability = authority
        .save_entries_with(
            &authority.persistent,
            &None,
            &None,
            &None,
            &[],
            move |_target, write| {
                observed.set(observed.get() + 1);
                if observed.get() == 1 {
                    return Err(Error::Io(Box::new(std::io::Error::other("retry"))));
                }
                let mut sink: OwnedFile = tempfile::tempfile().unwrap().into();
                write(&mut sink)?;
                Ok(AtomicFileOutcome::DurableCommit)
            },
        )
        .unwrap();
    assert!(matches!(durability, CommitDurability::Durable));
    assert_eq!(attempts.get(), 2);
}

#[test]
fn parent_sync_is_not_retried() {
    let dir = tempfile::tempdir().unwrap();
    let authority = authority(&dir, Arc::new(TestClock::new(0)));
    let attempts = std::cell::Cell::new(0);
    let durability = authority
        .save_entries_with(
            &authority.persistent,
            &None,
            &None,
            &None,
            &[],
            |_target, _write| {
                attempts.set(attempts.get() + 1);
                Ok(AtomicFileOutcome::CommittedDurabilityUncertain(
                    std::io::Error::other("parent sync"),
                ))
            },
        )
        .unwrap();
    assert!(matches!(
        durability,
        CommitDurability::DurabilityUncertain(_)
    ));
    assert_eq!(attempts.get(), 1);
}

#[test]
fn post_rename_metadata_failure_is_uncertain_not_retried_io() {
    struct MetadataFailure(std::sync::Arc<std::sync::atomic::AtomicUsize>);
    impl AtomicWriterInjector for MetadataFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::PostRenameMetadata {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(std::io::Error::other("metadata failed"))
            } else {
                Ok(())
            }
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let attempts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    set_test_atomic_file_injector(Some(Arc::new(MetadataFailure(attempts.clone()))));
    let durability = authority.save().unwrap();
    set_test_atomic_file_injector(None);
    assert!(matches!(
        durability,
        CommitDurability::DurabilityUncertain(_)
    ));
    assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn registry_conflict_is_not_retried() {
    let dir = tempfile::tempdir().unwrap();
    let authority = authority(&dir, Arc::new(TestClock::new(0)));
    for error in [
        Error::Conflict("conflict".into()),
        Error::OperationAndCleanup {
            primary: "conflict".into(),
            cleanup: "cleanup".into(),
        },
    ] {
        let attempts = std::cell::Cell::new(0);
        let result = authority.save_entries_with(
            &authority.persistent,
            &None,
            &None,
            &None,
            &[],
            |_target, _write| {
                attempts.set(attempts.get() + 1);
                Err(match &error {
                    Error::Conflict(message) => Error::Conflict(message.clone()),
                    Error::OperationAndCleanup { primary, cleanup } => Error::OperationAndCleanup {
                        primary: primary.clone(),
                        cleanup: cleanup.clone(),
                    },
                    _ => unreachable!(),
                })
            },
        );
        assert!(result.is_err());
        assert_eq!(attempts.get(), 1);
    }
}

#[test]
fn unresolved_record_survives_reload() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("file.pgn");
    fs::write(&file, b"*").unwrap();
    let registry = dir.path().join("registry.json");
    let id = {
        let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
        authority
            .migrate_legacy_os_path(
                file.clone().into_os_string(),
                "file",
                PathClass::PersistentFile,
                vec![PathOperation::ReadPgn],
            )
            .unwrap()
            .id
    };
    fs::remove_file(file).unwrap();
    let authority = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(
        authority.persistent.get(&id.id).unwrap().availability,
        PathAvailability::Unavailable
    );
}

#[test]
fn pending_prune_stripped_on_later_artifact_save() {
    let dir = tempfile::tempdir().unwrap();
    let (mut authority, root) = writable_root(
        &dir,
        vec![
            PathOperation::ReadPgn,
            PathOperation::WritePgn,
            PathOperation::DownloadFile,
        ],
    );
    let removed_path = dir.path().join("root/removed");
    fs::create_dir(&removed_path).unwrap();
    let removed = authority
        .register_workspace_child_observed(
            &FileWorkspaceHandle::new(root.clone()),
            &[OsString::from("removed")],
            "removed",
            observed_identity(&removed_path),
            true,
            PathOperation::ReadPgn,
        )
        .unwrap();
    let executable = removed_path.join("engine");
    fs::write(&executable, b"engine").unwrap();
    let engine_handle = authority
        .register_engine_file(&executable, "engine")
        .unwrap();
    let staged = dir.path().join("staged");
    fs::write(&staged, b"payload").unwrap();
    let stale_pending = authority
        .reserve_download_artifact(
            removed.path_ref(),
            OsString::from("stale.pgn"),
            sha256_file(&staged).unwrap(),
            "stale.pgn",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    authority.active_database_root = Some(removed.path_ref().clone());
    authority.active_puzzle_root = Some(removed.path_ref().clone());
    authority.active_engine_root = Some(removed.path_ref().clone());
    authority.save().unwrap();

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let mut dropped_engine_executables = Vec::new();
    assert!(authority
        .remove_workspace_entry(
            &removed,
            WorkspaceRemovalStatus::Complete,
            &mut dropped_engine_executables,
        )
        .map(|(durability, _)| durability)
        .is_err());
    set_test_atomic_file_injector(None);
    assert_eq!(dropped_engine_executables, vec![engine_handle.id]);
    assert!(authority.persistent.contains_key(&removed.path_ref().id));
    assert!(authority
        .pending_artifacts
        .iter()
        .any(|pending| pending.id == stale_pending.id));

    authority
        .reserve_download_artifact(
            &root,
            OsString::from("sibling.pgn"),
            sha256_file(&staged).unwrap(),
            "sibling.pgn",
            vec![PathOperation::ReadPgn],
        )
        .unwrap();
    assert!(!authority.persistent.contains_key(&removed.path_ref().id));
    assert!(!authority
        .pending_artifacts
        .iter()
        .any(|pending| pending.root == *removed.path_ref()));
    assert_eq!(authority.active_database_root, None);
    assert_eq!(authority.active_puzzle_root, None);
    assert_eq!(authority.active_engine_root, None);

    let reloaded = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(!reloaded.persistent.contains_key(&removed.path_ref().id));
    assert!(!reloaded
        .pending_artifacts
        .iter()
        .any(|pending| pending.root == *removed.path_ref()));
}

const READ_TOKENS: [&str; 8] = [
    "read_to_end",
    "read_to_string",
    "read_bytes",
    "read_bounded_bytes",
    "sha256_open_file",
    "sha256_file",
    "fs::read",
    ".read(",
];

#[test]
fn engine_image_split_keeps_reads_off_the_opener_and_lock_wrapper() {
    let verified = include_str!("verified.rs");
    assert!(
        verified.contains("    pub(super) fn open_engine_image("),
        "open_engine_image must be pub(super)"
    );

    let open = body_at_indent(verified, "fn open_engine_image(");
    assert!(
        open.starts_with("    pub(super) fn open_engine_image("),
        "open_engine_image must be visible only to its parent module: {open}"
    );
    assert!(open.contains("max_bytes"));
    for token in READ_TOKENS {
        assert!(
            !open.contains(token),
            "open_engine_image must not contain {token:?}: {open}"
        );
    }

    let source = test_source_files::production_source();
    let reader = body_at_indent(source, "fn engine_image_reader_for(");
    assert!(
        reader.contains("open_engine_image"),
        "engine_image_reader_for must call open_engine_image: {reader}"
    );
    for token in READ_TOKENS {
        assert!(
            !reader.contains(token),
            "engine_image_reader_for must not contain {token:?}: {reader}"
        );
    }

    let bytes = body_at_indent(source, "fn read_engine_image_bytes(");
    assert!(!bytes.contains("File::open"), "{bytes}");
    assert!(!bytes.contains("resolve"), "{bytes}");
    assert!(!bytes.contains("pgn_path_authority"), "{bytes}");
}

#[test]
fn path_authority_module_split_proves_verified_file_provenance() {
    let module = include_str!("mod.rs");
    let resolved = include_str!("resolved.rs");
    let verified = include_str!("verified.rs");

    let public_resolved_struct = ["pub ", "struct ResolvedPath"].concat();
    assert!(resolved.contains(&public_resolved_struct));
    assert!(!module.contains(&public_resolved_struct));

    assert_eq!(verified.matches("impl VerifiedFile").count(), 1);
    let mint = body_at_indent(verified, "mod mint {");
    let mint_functions = [
        "from_resolved",
        "into_inner",
        "as_file",
        "sha256",
        "try_clone_inner",
    ];
    assert_eq!(mint.matches("fn ").count(), mint_functions.len(), "{mint}");
    for function in mint_functions {
        assert_eq!(
            mint.matches(&format!("fn {function}(")).count(),
            1,
            "{mint}"
        );
    }
    let from_resolved = body_at_indent(verified, "pub(super) fn from_resolved(");
    let compact_from_resolved: String = from_resolved.split_whitespace().collect();
    assert!(compact_from_resolved.contains("resolved.take_file().map(Self)"));
    assert!(!from_resolved.contains("pub(crate) fn from_resolved"));
    assert!(!from_resolved.contains("File::open"));

    let take_file = body_at_indent(resolved, "fn take_file(");
    let compact_take_file: String = take_file.split_whitespace().collect();
    assert!(
        compact_take_file.contains("self.file.take()"),
        "{take_file}"
    );

    let verified_struct = verified
        .lines()
        .find(|line| line.contains("struct VerifiedFile("))
        .expect("VerifiedFile tuple struct");
    let tuple_fields = verified_struct
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
        .map(|(fields, _)| fields)
        .expect("VerifiedFile tuple fields");
    assert!(!tuple_fields.contains("pub"), "{verified_struct}");

    let file_field = resolved
        .lines()
        .find(|line| line.trim_start().starts_with("file: Option<OwnedFile>"))
        .expect("ResolvedPath file field");
    assert!(!file_field.contains("pub"), "{file_field}");
    for forbidden in [
        "fn set_file",
        "fn replace_file",
        "self.file =",
        ".file.replace(",
        "fn from_file",
        "OpenOptions",
    ] {
        assert!(!resolved.contains(forbidden), "{forbidden}: {resolved}");
    }

    let mint_start = verified.find("mod mint {").expect("mint module");
    let mint_end = mint_start + mint.len();
    let verified_outside_mint = [&verified[..mint_start], &verified[mint_end..]].concat();
    assert!(!verified_outside_mint.contains("VerifiedFile("));

    let unix_resolver = body_at_indent(resolved, "fn resolve_unix(");
    let windows_resolver = body_at_indent(resolved, "fn resolve_windows(");
    let test_module =
        crate::infra::blocking::source_scan::braced_body(resolved, "#[cfg(test)]\nmod tests {");
    let production_resolved =
        [&resolved[..test_module.start], &resolved[test_module.end..]].concat();
    let constructor_count = production_resolved
        .lines()
        .filter(|line| {
            line.contains("ResolvedPath {")
                && !line.contains("pub struct")
                && !line.contains("impl ResolvedPath")
        })
        .count();
    // Six sites: unix keeps its two, and the Windows walk adds the archive-direction leaf
    // that returns the opened directory itself as the capability.
    assert_eq!(
        constructor_count,
        unix_resolver.matches("ResolvedPath {").count()
            + windows_resolver.matches("ResolvedPath {").count(),
        "every construction site must sit in a resolver"
    );
    assert_eq!(constructor_count, 6, "resolved path construction sites");
    assert!(unix_resolver.contains("crate::infra::fs::open_regular_at"));
    assert_eq!(resolved.matches("File::open").count(), 0);
    assert!(!body_at_indent(
        resolved,
        "pub(crate) fn atomic_install_reserved_download_cancellable("
    )
    .contains("File::open"));
    assert!(!body_at_indent(
        module,
        "pub(crate) async fn hash_staged_payload_cancellable("
    )
    .contains("File::open"));

    let mutants = include_str!("../../../.cargo/mutants.toml");
    let mutation_runner = include_str!("../../../../scripts/run-backend-mutation.mjs");
    let new_path = "src/infra/path_authority/mod.rs";
    let old_path = ["src/infra/path_authority", ".rs"].concat();
    assert!(mutants.contains(new_path));
    assert!(mutation_runner.contains(new_path));
    assert!(!mutants.contains(&old_path));
    assert!(!mutation_runner.contains(&old_path));
}

#[test]
fn engine_image_reader_then_bytes_returns_exact_contents() {
    let dir = tempfile::tempdir().unwrap();
    let contents = b"\x89PNG\r\n\x1a\nengine-image";
    let (mutex, handle, _) = registered_engine_image(&dir, contents);
    let (file, declared) = engine_image_reader_for(&mutex, &handle, 1024).unwrap();
    assert_eq!(declared, contents.len() as u64);
    let bytes = read_engine_image_bytes(file, declared, 1024).unwrap();
    assert_eq!(bytes, contents);
}

#[test]
fn opening_book_into_file_returns_the_opened_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("book.bin");
    fs::write(&path, b"book").unwrap();
    let descriptor = OpeningBookDescriptor {
        file_name: "book.bin".into(),
        file: fs::File::open(&path).unwrap().into(),
    };
    let mut file = descriptor.into_file();
    let mut bytes = Vec::new();
    use std::io::Read as _;
    file.read_to_end(&mut bytes).unwrap();
    assert_eq!(bytes, b"book");
}

#[test]
fn engine_image_reader_rejects_oversized_file_without_a_descriptor() {
    let dir = tempfile::tempdir().unwrap();
    let contents = b"0123456789";
    let (mutex, handle, _) = registered_engine_image(&dir, contents);
    match engine_image_reader_for(&mutex, &handle, 4) {
        Ok(_) => panic!("oversized image produced a VerifiedFile"),
        Err(error) => assert!(matches!(error, Error::ResourceLimit(_))),
    }
}

#[test]
fn engine_image_bytes_rejects_growth_past_max_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let contents = b"01234567";
    let (mutex, handle, image) = registered_engine_image(&dir, contents);
    let max_bytes = 10;
    let (file, declared) = engine_image_reader_for(&mutex, &handle, max_bytes).unwrap();
    let mut observed = file.try_clone_inner().unwrap();
    assert_eq!(declared, contents.len() as u64);
    let mut extra = fs::OpenOptions::new().append(true).open(&image).unwrap();
    extra.write_all(b"grown!").unwrap();
    drop(extra);
    let error = read_engine_image_bytes(file, declared, max_bytes).unwrap_err();
    assert!(matches!(error, Error::ResourceLimit(_)));
    use std::io::Seek;
    assert_eq!(observed.stream_position().unwrap(), 11);
}

#[test]
fn engine_image_bytes_accepts_growth_under_max_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let contents = b"01234567";
    let (mutex, handle, image) = registered_engine_image(&dir, contents);
    let max_bytes = 20;
    let (file, declared) = engine_image_reader_for(&mutex, &handle, max_bytes).unwrap();
    assert_eq!(declared, contents.len() as u64);
    let mut extra = fs::OpenOptions::new().append(true).open(&image).unwrap();
    extra.write_all(b"grown").unwrap();
    drop(extra);
    let bytes = read_engine_image_bytes(file, declared, max_bytes).unwrap();
    assert_eq!(bytes, b"01234567grown");
}

#[test]
fn semantic_file_reuse_survives_operation_reordering() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("study.pgn");
    fs::write(&file, b"pgn").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let first = authority
        .get_or_create_persistent_file(
            &file,
            "study",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    let second = authority
        .get_or_create_persistent_file(
            &file,
            "study",
            vec![PathOperation::WritePgn, PathOperation::ReadPgn],
        )
        .unwrap();
    set_test_atomic_file_injector(None);
    assert_eq!(first.id, second.id);
    assert_eq!(
        authority.persistent[&first.id.id].stored.operations,
        canonical_operations(EntryPurpose::PgnFile)
    );
}

#[test]
fn startup_reconciliation_preserves_retained_evidence_across_partial_calls() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("owned.pgn");
    let book = dir.path().join("orphan.bin");
    fs::write(&file, b"pgn").unwrap();
    fs::write(&book, b"book").unwrap();
    let registry = dir.path().join("registry.json");
    let (owned, orphan) = {
        let mut initial = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let owned = initial
            .get_or_create_persistent_file(
                &file,
                "owned",
                vec![PathOperation::ReadPgn, PathOperation::WritePgn],
            )
            .unwrap()
            .id;
        let orphan = initial.register_opening_book(&book, "book").unwrap();
        (owned, orphan)
    };
    let mut reloaded = PathAuthority::open(registry, vec![]).unwrap();
    reloaded
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![owned.clone()],
            trusted_families: vec![PathOwnerFamily::FileWorkspace],
        })
        .unwrap();
    reloaded
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![PathRef {
                id: "unknown-stale-reference".into(),
            }],
            trusted_families: vec![
                PathOwnerFamily::RecentFiles,
                PathOwnerFamily::SessionWorkspace,
                PathOwnerFamily::ExpandedDirectories,
                PathOwnerFamily::PracticeDeck,
            ],
        })
        .unwrap();
    assert!(reloaded
        .resolve(&owned, PathOperation::ReadPgn, &[])
        .is_ok());
    reloaded
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![],
            trusted_families: vec![PathOwnerFamily::OpeningBook],
        })
        .unwrap();
    assert!(reloaded
        .resolve(orphan.path_ref(), PathOperation::OpeningBookRead, &[])
        .is_err());
    assert_eq!(fs::read(book).unwrap(), b"book");
    reloaded
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![],
            trusted_families: vec![PathOwnerFamily::FileWorkspace],
        })
        .unwrap();
    assert!(reloaded
        .resolve(&owned, PathOperation::ReadPgn, &[])
        .is_ok());
}

#[cfg(unix)]
#[test]
fn final_directory_resolution_retains_the_child_descriptor() {
    let dir = tempfile::tempdir().unwrap();
    let child = dir.path().join("child");
    fs::create_dir(&child).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .migrate_legacy_os_path(
            dir.path().as_os_str().to_os_string(),
            "root",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    let mut resolved = authority
        .resolve(&root.id, PathOperation::ReadPgn, &[OsString::from("child")])
        .unwrap();
    let descriptor = resolved.take_directory().unwrap();
    assert_eq!(
        file_identity(&descriptor.metadata().unwrap()),
        identity(&child).unwrap()
    );
}

fn parent_identity_for_path(path: &Path) -> Result<Option<Identity>, Error> {
    let identity = identity(path)?;
    let path = canonical_binding(path)?;
    let (parent, _) = crate::infra::fs::open_verified_parent(
        &path,
        (identity.a, identity.b),
        false,
        ParentAccess::Readable,
    )?;
    Ok(Some(identity_from_open_file(&parent)?))
}

fn descriptor_parent_identity(path: &Path) -> Identity {
    let parent = crate::infra::fs::open_parent_no_follow(path).unwrap();
    identity_from_open_file(&parent).unwrap()
}

fn stored_entry_for(
    path: &Path,
    id: impl Into<String>,
    purpose: Option<EntryPurpose>,
    operations: Vec<PathOperation>,
) -> StoredEntry {
    let target_is_dir = path.is_dir();
    StoredEntry {
        id: PathRef { id: id.into() },
        display_name: "fixture".into(),
        class: if target_is_dir {
            PathClass::PersistentCustomRoot
        } else {
            PathClass::PersistentFile
        },
        operations,
        path: NativePath::from_path(path),
        identity: identity(path).unwrap(),
        parent_identity: if target_is_dir {
            None
        } else {
            parent_identity_for_path(path).unwrap()
        },
        target_is_dir,
        purpose,
        practice_key: None,
    }
}

#[test]
fn download_destination_is_known_matches_persistent_download_roots_only() {
    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));

    assert!(!authority.download_destination_is_known(&PathRef {
        id: "missing".into(),
    }));

    let dialog_path = dir.path().join("dialog");
    fs::create_dir(&dialog_path).unwrap();
    let dialog_id = authority
        .grant_dialog(
            &dialog_path,
            "dialog",
            PathClass::SingleDialogGrant,
            PathOperation::DownloadFile,
            Duration::from_secs(60),
            1,
        )
        .unwrap();
    assert!(!authority.download_destination_is_known(&dialog_id));

    let mut wrong_purpose_results = Vec::new();
    for (id, purpose) in [
        ("database", EntryPurpose::DatabaseRoot),
        ("puzzle", EntryPurpose::PuzzleRoot),
    ] {
        let path = dir.path().join(id);
        fs::create_dir(&path).unwrap();
        let stored = stored_entry_for(&path, id, Some(purpose), canonical_operations(purpose));
        authority.persistent.insert(
            id.into(),
            Entry {
                stored,
                availability: PathAvailability::Available,
            },
        );
        wrong_purpose_results
            .push(authority.download_destination_is_known(&PathRef { id: id.into() }));
    }
    assert_eq!(wrong_purpose_results, [false, false]);

    let file = dir.path().join("file.pgn");
    fs::write(&file, b"file").unwrap();
    let stored = stored_entry_for(
        &file,
        "file",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    authority.persistent.insert(
        "file".into(),
        Entry {
            stored,
            availability: PathAvailability::Available,
        },
    );
    assert!(!authority.download_destination_is_known(&PathRef { id: "file".into() }));

    let pending_path = dir.path().join("pending");
    fs::create_dir(&pending_path).unwrap();
    let pending = stored_entry_for(
        &pending_path,
        "pending",
        Some(EntryPurpose::DownloadDestination),
        canonical_operations(EntryPurpose::DownloadDestination),
    );
    authority.persistent.insert(
        "pending".into(),
        Entry {
            stored: pending,
            availability: PathAvailability::Available,
        },
    );
    authority
        .pending_unpersisted_removals
        .insert("pending".into());
    assert!(!authority.download_destination_is_known(&PathRef {
        id: "pending".into(),
    }));

    let destination_path = dir.path().join("destination");
    fs::create_dir(&destination_path).unwrap();
    let destination = stored_entry_for(
        &destination_path,
        "destination",
        Some(EntryPurpose::DownloadDestination),
        canonical_operations(EntryPurpose::DownloadDestination),
    );
    authority.persistent.insert(
        "destination".into(),
        Entry {
            stored: destination,
            availability: PathAvailability::Available,
        },
    );
    let destination_id = PathRef {
        id: "destination".into(),
    };
    assert!(authority.download_destination_is_known(&destination_id));
    fs::remove_dir(&destination_path).unwrap();
    assert!(authority.download_destination_is_known(&destination_id));
}

fn write_registry_with_entries(path: &Path, entries: Vec<StoredEntry>) {
    write_registry(
        path,
        &Registry {
            schema_version: SCHEMA_VERSION,
            entries,
            active_database_root: None,
            active_puzzle_root: None,
            active_engine_root: None,
            pending_artifacts: vec![],
            provisional_attachments: BTreeSet::new(),
            image_cleanup: vec![],
            catalog_installs: BTreeMap::new(),
            catalog_uses: Vec::new(),
        },
    );
}

pub(super) fn write_registry(path: &Path, registry: &Registry) {
    fs::write(path, serde_json::to_vec(registry).unwrap()).unwrap();
}

#[cfg(unix)]
#[test]
fn legacy_persistent_file_is_rebound_and_writable_after_open() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"1. e4 *").unwrap();
    symlink(&real, &link).unwrap();
    let path = link.join("g.pgn");
    let entry = stored_entry_for(
        &path,
        "legacy-file",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    write_registry_with_entries(&dir.path().join("registry.json"), vec![entry]);

    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let stored = &authority.persistent["legacy-file"].stored;
    assert_eq!(stored.path.to_path().unwrap(), real.join("g.pgn"));
    assert_eq!(
        authority.persistent["legacy-file"].availability,
        PathAvailability::Available
    );
    let mut resolved = authority
        .resolve(
            &PathRef {
                id: "legacy-file".into(),
            },
            PathOperation::WritePgn,
            &[],
        )
        .unwrap();
    let snapshot = resolved.pgn_snapshot().unwrap();
    let _ = resolved
        .replace_pgn_atomic(snapshot, &CancellationToken::new(), |_source, target| {
            target.write_all(b"1. d4 *").map_err(Error::from)
        })
        .unwrap();
    assert_eq!(fs::read(real.join("g.pgn")).unwrap(), b"1. d4 *");
}

#[cfg(unix)]
#[test]
fn legacy_persistent_root_is_rebound_and_supports_descriptor_mutation_after_open() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::create_dir(real.join("workspace")).unwrap();
    symlink(&real, &link).unwrap();
    let path = link.join("workspace");
    let entry = stored_entry_for(
        &path,
        "legacy-root",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    );
    write_registry_with_entries(&dir.path().join("registry.json"), vec![entry]);

    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    assert_eq!(
        authority.persistent["legacy-root"]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("workspace")
    );
    let target = authority
        .workspace_mutation_target(&FileWorkspaceHandle::new(PathRef {
            id: "legacy-root".into(),
        }))
        .unwrap();
    let directory = target.directory().unwrap();
    let _ = crate::infra::fs::atomic_replace_at(directory, OsStr::new("created.pgn"), |file| {
        file.write_all(b"1. e4 *").map_err(Error::from)
    })
    .unwrap();
    assert_eq!(
        fs::read(real.join("workspace/created.pgn")).unwrap(),
        b"1. e4 *"
    );
}

#[cfg(unix)]
#[test]
fn refresh_entry_rejects_a_legacy_spelling_even_when_identity_matches() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    let path = link.join("g.pgn");
    let mut entry = Entry {
        stored: stored_entry_for(
            &path,
            "legacy-refresh",
            Some(EntryPurpose::PgnFile),
            canonical_operations(EntryPurpose::PgnFile),
        ),
        availability: PathAvailability::Available,
    };
    refresh_entry(&mut entry);
    assert_eq!(entry.availability, PathAvailability::Unavailable);

    let mut refreshed_authority = authority(&dir, Arc::new(TestClock::new(0)));
    refreshed_authority
        .persistent
        .insert("legacy-refresh".into(), entry.clone());
    refreshed_authority.refresh_persistent_id(&PathRef {
        id: "legacy-refresh".into(),
    });
    assert_eq!(
        refreshed_authority.persistent["legacy-refresh"].availability,
        PathAvailability::Unavailable
    );

    fs::create_dir(real.join("workspace")).unwrap();
    fs::write(real.join("workspace/child.pgn"), b"*").unwrap();
    let root_entry = stored_entry_for(
        &link.join("workspace"),
        "legacy-refresh-root",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    );
    let child_entry = stored_entry_for(
        &link.join("workspace/child.pgn"),
        "legacy-refresh-child",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    let mut partial_authority = authority(&dir, Arc::new(TestClock::new(0)));
    partial_authority.persistent.insert(
        root_entry.id.id.clone(),
        Entry {
            stored: root_entry,
            availability: PathAvailability::Available,
        },
    );
    partial_authority.persistent.insert(
        child_entry.id.id.clone(),
        Entry {
            stored: child_entry,
            availability: PathAvailability::Available,
        },
    );
    let mut dropped = Vec::new();
    partial_authority
        .remove_workspace_entry(
            &FileWorkspaceHandle::new(PathRef {
                id: "legacy-refresh-root".into(),
            }),
            WorkspaceRemovalStatus::Partial,
            &mut dropped,
        )
        .map(|(durability, _)| durability)
        .unwrap();
    assert!(!partial_authority
        .persistent
        .contains_key("legacy-refresh-child"));
}

#[cfg(unix)]
#[test]
fn rebinding_is_persisted_and_second_open_does_not_acquire_again() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    write_registry_with_entries(
        &dir.path().join("registry.json"),
        vec![stored_entry_for(
            &link.join("g.pgn"),
            "reopen-file",
            Some(EntryPurpose::PgnFile),
            canonical_operations(EntryPurpose::PgnFile),
        )],
    );

    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(0));
    let first = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 1);
    assert_eq!(
        first.persistent["reopen-file"]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("g.pgn")
    );
    drop(first);
    let second = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 1);
    assert_eq!(
        second.persistent["reopen-file"]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("g.pgn")
    );
}

#[cfg(unix)]
#[test]
fn canonical_registry_is_not_rewritten_or_acquired() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("g.pgn");
    fs::write(&file, b"*").unwrap();
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(
        &registry,
        vec![stored_entry_for(
            &file,
            "canonical-file",
            Some(EntryPurpose::PgnFile),
            canonical_operations(EntryPurpose::PgnFile),
        )],
    );
    let before = observed_identity(&registry);
    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(0));
    let authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 0);
    assert_eq!(observed_identity(&registry), before);
    assert_eq!(
        authority.persistent["canonical-file"].availability,
        PathAvailability::Available
    );
}

#[cfg(unix)]
#[test]
fn changed_legacy_object_is_unavailable_while_other_entries_rebind() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("changed.pgn"), b"old").unwrap();
    fs::write(real.join("stable.pgn"), b"stable").unwrap();
    symlink(&real, &link).unwrap();
    let changed = stored_entry_for(
        &link.join("changed.pgn"),
        "changed-entry",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    let stable = stored_entry_for(
        &link.join("stable.pgn"),
        "stable-entry",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    fs::write(real.join("replacement"), b"new").unwrap();
    fs::rename(real.join("replacement"), real.join("changed.pgn")).unwrap();
    write_registry_with_entries(&dir.path().join("registry.json"), vec![changed, stable]);

    let capture = crate::error::LogCaptureScope::start();
    let authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    let warnings: Vec<_> = capture
        .records()
        .into_iter()
        .filter(|record| record.level == log::Level::Warn)
        .filter(|record| record.message.contains("changed-entry"))
        .collect();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].message.contains("identity changed"));
    assert_eq!(
        authority.persistent["changed-entry"]
            .stored
            .path
            .to_path()
            .unwrap(),
        link.join("changed.pgn")
    );
    assert_eq!(
        authority.persistent["changed-entry"].availability,
        PathAvailability::Unavailable
    );
    assert_eq!(
        authority.persistent["stable-entry"]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("stable.pgn")
    );
    assert_eq!(
        authority.persistent["stable-entry"].availability,
        PathAvailability::Available
    );
}

#[cfg(unix)]
#[test]
fn failed_canonical_proof_keeps_entry_unavailable_without_aborting_open() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    let moved = dir.path().join("moved");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("g.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    let entry = stored_entry_for(
        &link.join("g.pgn"),
        "proof-failure",
        Some(EntryPurpose::PgnFile),
        canonical_operations(EntryPurpose::PgnFile),
    );
    write_registry_with_entries(&dir.path().join("registry.json"), vec![entry]);

    let hook_real = real.clone();
    let hook_moved = moved.clone();
    ACQUIRE_TARGET_BEFORE_PROOF_HOOK.with(|slot| {
        slot.replace(Some(Box::new(move || {
            fs::rename(&hook_real, &hook_moved).unwrap();
            fs::create_dir(&hook_real).unwrap();
            fs::write(hook_real.join("g.pgn"), b"replacement").unwrap();
        })))
    });
    let capture = crate::error::LogCaptureScope::start();
    let authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert_eq!(
        authority.persistent["proof-failure"]
            .stored
            .path
            .to_path()
            .unwrap(),
        link.join("g.pgn")
    );
    assert_eq!(
        authority.persistent["proof-failure"].availability,
        PathAvailability::Unavailable
    );
    assert!(
        capture
            .messages()
            .iter()
            .filter(|message| message.contains("proof-failure"))
            .count()
            >= 1
    );
}

#[cfg(unix)]
#[test]
fn leafless_persistent_spelling_is_not_acquired() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let root = stored_entry_for(
        Path::new("/"),
        "leafless-root",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    );
    write_registry_with_entries(&registry, vec![root]);
    ACQUIRE_TARGET_CALLS.with(|calls| calls.set(0));
    let authority = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(ACQUIRE_TARGET_CALLS.with(|calls| calls.get()), 0);
    assert_eq!(
        authority.persistent["leafless-root"]
            .stored
            .path
            .to_path()
            .unwrap(),
        Path::new("/")
    );
    assert_eq!(
        authority.persistent["leafless-root"].availability,
        PathAvailability::Available
    );
}

#[cfg(unix)]
#[test]
fn hard_rebinding_commit_failure_is_retried_by_the_next_registration() {
    struct RenameFailure;
    impl AtomicWriterInjector for RenameFailure {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::Rename {
                Err(std::io::Error::other("injected registry rename failure"))
            } else {
                Ok(())
            }
        }
    }

    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("legacy.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(
        &registry,
        vec![stored_entry_for(
            &link.join("legacy.pgn"),
            "hard-failure",
            Some(EntryPurpose::PgnFile),
            canonical_operations(EntryPurpose::PgnFile),
        )],
    );

    let capture = crate::error::LogCaptureScope::start();
    set_test_atomic_file_injector(Some(Arc::new(RenameFailure)));
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    set_test_atomic_file_injector(None);
    assert_eq!(
        authority.persistent["hard-failure"]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("legacy.pgn")
    );
    assert_eq!(
        authority.persistent["hard-failure"].availability,
        PathAvailability::Available
    );
    assert!(!authority.registry_durability_pending);
    let warnings: Vec<_> = capture
        .records()
        .into_iter()
        .filter(|record| record.level == log::Level::Warn)
        .filter(|record| record.message.contains("hard-failure"))
        .collect();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].message.contains("I/O failure"));

    let fresh = dir.path().join("fresh.pgn");
    fs::write(&fresh, b"fresh").unwrap();
    authority
        .get_or_create_persistent_file(&fresh, "fresh", canonical_operations(EntryPurpose::PgnFile))
        .unwrap();
    drop(authority);
    // Read the registry file itself, not a reopened authority: the rebinding pass runs again
    // on every open, so a reopened authority shows the canonical spelling whether or not the
    // failed commit was ever flushed. Only the bytes on disk distinguish the two.
    let persisted: Registry =
        serde_json::from_str(&fs::read_to_string(&registry).unwrap()).unwrap();
    let stored = persisted
        .entries
        .iter()
        .find(|entry| entry.id.id == "hard-failure")
        .expect("the rebound entry stays in the registry");
    assert_eq!(
        stored.path.to_path().unwrap(),
        real.join("legacy.pgn"),
        "the next successful commit must flush the rebinding"
    );
}

#[cfg(unix)]
#[test]
fn uncertain_rebinding_commit_adopts_entry_and_marks_pending_durability() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("legacy.pgn"), b"*").unwrap();
    symlink(&real, &link).unwrap();
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(
        &registry,
        vec![stored_entry_for(
            &link.join("legacy.pgn"),
            "uncertain-rebind",
            Some(EntryPurpose::PgnFile),
            canonical_operations(EntryPurpose::PgnFile),
        )],
    );

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "injected parent sync failure",
    ))));
    let authority = PathAuthority::open(registry, vec![]).unwrap();
    set_test_atomic_file_injector(None);
    assert_eq!(
        authority.persistent["uncertain-rebind"]
            .stored
            .path
            .to_path()
            .unwrap(),
        real.join("legacy.pgn")
    );
    assert_eq!(
        authority.persistent["uncertain-rebind"].availability,
        PathAvailability::Available
    );
    assert!(authority.registry_durability_pending);
}

#[cfg(unix)]
#[test]
fn download_destination_rebind_is_canonical_and_usable() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir_all(real.join("downloads")).unwrap();
    symlink(&real, &link).unwrap();
    let id = "download-destination";
    let entry = stored_entry_for(
        &link.join("downloads"),
        id,
        Some(EntryPurpose::DownloadDestination),
        canonical_operations(EntryPurpose::DownloadDestination),
    );
    write_registry_with_entries(&dir.path().join("registry.json"), vec![entry]);
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert_eq!(
        authority.persistent[id].stored.path.to_path().unwrap(),
        real.join("downloads")
    );
    let resolved = authority
        .resolve(
            &PathRef { id: id.into() },
            PathOperation::DownloadFile,
            &[OsString::from("installed.pgn")],
        )
        .unwrap();
    let _ = resolved
        .atomic_replace_download(|file| file.write_all(b"download").map_err(Error::from))
        .unwrap();
    assert_eq!(
        fs::read(real.join("downloads/installed.pgn")).unwrap(),
        b"download"
    );
}

#[cfg(unix)]
#[test]
fn engine_resource_rebind_is_canonical_and_lease_usable() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real");
    let link = dir.path().join("link");
    fs::create_dir(&real).unwrap();
    fs::write(real.join("resource.nnue"), b"resource").unwrap();
    symlink(&real, &link).unwrap();
    let id = "engine-resource";
    let entry = stored_entry_for(
        &link.join("resource.nnue"),
        id,
        Some(EntryPurpose::EngineResource),
        canonical_operations(EntryPurpose::EngineResource),
    );
    write_registry_with_entries(&dir.path().join("registry.json"), vec![entry]);
    let mut authority = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert_eq!(
        authority.persistent[id].stored.path.to_path().unwrap(),
        real.join("resource.nnue")
    );
    let handle = EngineResourceHandle::new(
        PathRef { id: id.into() },
        EngineResourceHandleKind::File,
        "resource".into(),
    );
    let lease = authority.engine_resource(&handle).unwrap();
    #[cfg(target_os = "macos")]
    lease.pin_test_target_to_original().unwrap();
    assert!(!lease.uci_value().unwrap().is_empty());
}

#[test]
fn schema_one_backfills_every_exact_legacy_purpose_and_preserves_unknown_records() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("registry.json");
    let purposes = [
        EntryPurpose::PgnWorkspace,
        EntryPurpose::PgnFile,
        EntryPurpose::PgnReadOnlyFile,
        EntryPurpose::DownloadDestination,
        EntryPurpose::DatabaseRoot,
        EntryPurpose::DatabaseFile,
        EntryPurpose::PuzzleRoot,
        EntryPurpose::PuzzleFile,
        EntryPurpose::EngineRoot,
        EntryPurpose::EngineExecutable,
        EntryPurpose::EngineResource,
        EntryPurpose::OpeningBook,
        EntryPurpose::EngineImage,
    ];
    let mut entries = Vec::new();
    for (index, purpose) in purposes.into_iter().enumerate() {
        let path = dir.path().join(format!("purpose-{index}"));
        let is_dir = matches!(
            purpose,
            EntryPurpose::PgnWorkspace
                | EntryPurpose::DownloadDestination
                | EntryPurpose::DatabaseRoot
                | EntryPurpose::PuzzleRoot
                | EntryPurpose::EngineRoot
        );
        if is_dir {
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, b"fixture").unwrap();
        }
        let operations = if purpose == EntryPurpose::EngineExecutable {
            vec![
                PathOperation::EngineExecute,
                PathOperation::EngineConfigure,
                PathOperation::EngineInstall,
            ]
        } else {
            canonical_operations(purpose)
        };
        entries.push(stored_entry_for(
            &path,
            format!("purpose-{index}"),
            None,
            operations,
        ));
    }
    let unknown_path = dir.path().join("unknown");
    fs::write(&unknown_path, b"unknown").unwrap();
    entries.push(stored_entry_for(
        &unknown_path,
        "unknown",
        None,
        vec![PathOperation::SnapshotWrite],
    ));
    let mut json = serde_json::to_value(Registry {
        schema_version: SCHEMA_VERSION,
        entries,
        active_database_root: None,
        active_puzzle_root: None,
        active_engine_root: None,
        pending_artifacts: vec![],
        provisional_attachments: BTreeSet::new(),
        image_cleanup: vec![],
        catalog_installs: BTreeMap::new(),
        catalog_uses: Vec::new(),
    })
    .unwrap();
    for entry in json["entries"].as_array_mut().unwrap() {
        entry.as_object_mut().unwrap().remove("purpose");
    }
    fs::write(&registry_path, serde_json::to_vec(&json).unwrap()).unwrap();

    let mut authority = PathAuthority::open(registry_path.clone(), vec![]).unwrap();
    for (index, purpose) in purposes.into_iter().enumerate() {
        let entry = &authority.persistent[&format!("purpose-{index}")].stored;
        assert_eq!(entry.purpose, Some(purpose));
        assert_eq!(entry.operations, canonical_operations(purpose));
    }
    assert_eq!(authority.persistent["unknown"].stored.purpose, None);
    authority.save().unwrap();
    let reloaded = PathAuthority::open(registry_path, vec![]).unwrap();
    assert_eq!(reloaded.persistent["unknown"].stored.purpose, None);
    for (index, purpose) in purposes.into_iter().enumerate() {
        assert_eq!(
            reloaded.persistent[&format!("purpose-{index}")]
                .stored
                .purpose,
            Some(purpose)
        );
    }
}

#[test]
fn tagged_historical_operation_subsets_upgrade_under_same_root_and_file_ids() {
    let dir = tempfile::tempdir().unwrap();
    let registry_path = dir.path().join("registry.json");
    let root_path = dir.path().join("database-root");
    let file_path = dir.path().join("study.pgn");
    fs::create_dir(&root_path).unwrap();
    fs::write(&file_path, b"*").unwrap();
    let root_id = PathRef {
        id: "root-id".into(),
    };
    let file_id = PathRef {
        id: "file-id".into(),
    };
    let registry = Registry {
        schema_version: SCHEMA_VERSION,
        entries: vec![
            stored_entry_for(
                &root_path,
                root_id.id.clone(),
                Some(EntryPurpose::DatabaseRoot),
                vec![PathOperation::DatabaseRead],
            ),
            stored_entry_for(
                &file_path,
                file_id.id.clone(),
                Some(EntryPurpose::PgnFile),
                vec![PathOperation::ReadPgn],
            ),
        ],
        active_database_root: None,
        active_puzzle_root: None,
        active_engine_root: None,
        pending_artifacts: vec![],
        provisional_attachments: BTreeSet::new(),
        image_cleanup: vec![],
        catalog_installs: BTreeMap::new(),
        catalog_uses: Vec::new(),
    };
    fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
    let mut authority = PathAuthority::open(registry_path.clone(), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(&root_path, "root", None)
        .unwrap();
    let file = authority
        .get_or_create_persistent_file(
            &file_path,
            "study",
            vec![PathOperation::WritePgn, PathOperation::ReadPgn],
        )
        .unwrap();
    assert_eq!(root.path_ref(), &root_id);
    assert_eq!(file.id, file_id);
    assert_eq!(
        authority.persistent[&root_id.id].stored.operations,
        canonical_operations(EntryPurpose::DatabaseRoot)
    );
    assert_eq!(
        authority.persistent[&file_id.id].stored.operations,
        canonical_operations(EntryPurpose::PgnFile)
    );
    drop(authority);
    let reloaded = PathAuthority::open(registry_path, vec![]).unwrap();
    assert_eq!(
        reloaded.persistent[&root_id.id].stored.operations,
        canonical_operations(EntryPurpose::DatabaseRoot)
    );
    assert_eq!(
        reloaded.persistent[&file_id.id].stored.operations,
        canonical_operations(EntryPurpose::PgnFile)
    );
}

#[test]
fn semantic_reuse_does_not_broaden_an_unrelated_same_file_grant() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shared.bin");
    fs::write(&file, b"shared").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let book = authority.register_opening_book(&file, "book").unwrap();
    let pgn = authority
        .get_or_create_persistent_file(
            &file,
            "pgn",
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    assert_ne!(book.path_ref(), &pgn.id);
    assert_eq!(
        authority.persistent[&book.path_ref().id].stored.operations,
        canonical_operations(EntryPurpose::OpeningBook)
    );
}

#[test]
fn registry_admission_bounds_ids_pending_bytes_and_allow_non_growing_legacy() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("entry");
    fs::write(&file, b"entry").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let template = Entry {
        stored: stored_entry_for(
            &file,
            "template",
            Some(EntryPurpose::OpeningBook),
            canonical_operations(EntryPurpose::OpeningBook),
        ),
        availability: PathAvailability::Available,
    };
    for index in 0..=MAX_AUTHORITY_IDS {
        let mut entry = template.clone();
        entry.stored.id.id = format!("id-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    let same = authority.persistent.clone();
    assert!(authority
        .save_entries_with(&same, &None, &None, &None, &[], |_path, _write| {
            Ok(AtomicFileOutcome::DurableCommit)
        })
        .is_ok());
    let mut growth = same.clone();
    let mut extra = template.clone();
    extra.stored.id.id = "one-more".into();
    growth.insert(extra.stored.id.id.clone(), extra);
    let mut called = false;
    assert!(matches!(
        authority.save_entries_with(&growth, &None, &None, &None, &[], |_path, _write| {
            called = true;
            Ok(AtomicFileOutcome::DurableCommit)
        }),
        Err(Error::ResourceLimit(_))
    ));
    assert!(!called);

    authority.persistent.clear();
    let mut oversized = template;
    oversized.stored.id.id = "oversized".into();
    oversized.stored.display_name = "x".repeat(MAX_REGISTRY_BYTES + 1);
    let source = BTreeMap::from([(oversized.stored.id.id.clone(), oversized)]);
    assert!(matches!(
        authority.save_entries_with(&source, &None, &None, &None, &[], |_path, _write| {
            panic!("oversized bytes must be refused before replacement")
        }),
        Err(Error::ResourceLimit(_))
    ));
    authority.persistent = source.clone();
    assert!(authority
        .save_entries_with(&source, &None, &None, &None, &[], |_path, _write| {
            Ok(AtomicFileOutcome::DurableCommit)
        })
        .is_ok());
    let mut byte_growth = source;
    byte_growth
        .values_mut()
        .next()
        .unwrap()
        .stored
        .display_name
        .push('x');
    assert!(matches!(
        authority.save_entries_with(
            &byte_growth,
            &None,
            &None,
            &None,
            &[],
            |_path, _write| panic!("legacy byte growth must be refused"),
        ),
        Err(Error::ResourceLimit(_))
    ));

    let pending_template = PendingArtifact {
        id: PathRef {
            id: "pending".into(),
        },
        root: PathRef { id: "root".into() },
        filename: NativePath::from_path(Path::new("leaf")),
        display_name: "pending".into(),
        operations: vec![PathOperation::ReadPgn],
        baseline: None,
        root_identity: None,
        payload_size: 0,
        payload_sha256: String::new(),
        payload_bound: false,
        installed_identity: None,
        installed_ctime_nanos: None,
    };
    authority.pending_artifacts = (0..=MAX_PENDING_ARTIFACTS)
        .map(|index| {
            let mut pending = pending_template.clone();
            pending.id.id = format!("pending-{index}");
            pending
        })
        .collect();
    assert!(authority
        .save_entries_with(
            &BTreeMap::new(),
            &None,
            &None,
            &None,
            &authority.pending_artifacts,
            |_path, _write| Ok(AtomicFileOutcome::DurableCommit),
        )
        .is_ok());
    let mut pending_growth = authority.pending_artifacts.clone();
    let mut extra_pending = pending_template;
    extra_pending.id.id = "pending-more".into();
    pending_growth.push(extra_pending);
    assert!(matches!(
        authority.save_entries_with(
            &BTreeMap::new(),
            &None,
            &None,
            &None,
            &pending_growth,
            |_path, _write| panic!("pending growth must be refused"),
        ),
        Err(Error::ResourceLimit(_))
    ));
}

#[test]
fn unique_id_limit_counts_the_union_and_failed_promotion_consumes_its_dialog() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("entry");
    fs::write(&file, b"entry").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let template = Entry {
        stored: stored_entry_for(
            &file,
            "template",
            Some(EntryPurpose::OpeningBook),
            canonical_operations(EntryPurpose::OpeningBook),
        ),
        availability: PathAvailability::Available,
    };
    for index in 0..MAX_AUTHORITY_IDS {
        let mut entry = template.clone();
        entry.stored.id.id = format!("union-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    let duplicate_pending = PendingArtifact {
        id: PathRef {
            id: "union-0".into(),
        },
        root: PathRef {
            id: "union-1".into(),
        },
        filename: NativePath::from_path(Path::new("leaf")),
        display_name: "pending".into(),
        operations: vec![PathOperation::ReadPgn],
        baseline: None,
        root_identity: None,
        payload_size: 0,
        payload_sha256: String::new(),
        payload_bound: false,
        installed_identity: None,
        installed_ctime_nanos: None,
    };
    assert!(authority
        .save_entries_with(
            &authority.persistent,
            &None,
            &None,
            &None,
            std::slice::from_ref(&duplicate_pending),
            |_path, _write| Ok(AtomicFileOutcome::DurableCommit),
        )
        .is_ok());
    let mut unique_pending = duplicate_pending;
    unique_pending.id.id = "union-new".into();
    assert!(matches!(
        authority.save_entries_with(
            &authority.persistent,
            &None,
            &None,
            &None,
            &[unique_pending],
            |_path, _write| panic!("union growth must be refused"),
        ),
        Err(Error::ResourceLimit(_))
    ));

    let dialog_file = dir.path().join("dialog.pgn");
    fs::write(&dialog_file, b"*").unwrap();
    let dialog = authority
        .grant_dialog(
            &dialog_file,
            "dialog",
            PathClass::SingleDialogGrant,
            PathOperation::ReadPgn,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    assert!(matches!(
        authority.promote_dialog(
            &dialog,
            PathClass::PersistentFile,
            "dialog",
            vec![PathOperation::ReadPgn],
        ),
        Err(Error::ResourceLimit(_))
    ));
    assert!(!authority.dialogs.contains_key(&dialog.id));
    assert_eq!(authority.persistent.len(), MAX_AUTHORITY_IDS);
}

#[test]
fn oversized_startup_input_and_unknown_ids_do_not_mutate_or_accumulate() {
    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let oversized = (0..=authority.authority_id_input_limit() + MAX_OWNER_UNKNOWN_IDS)
        .map(|index| PathRef {
            id: format!("unknown-{index}"),
        })
        .collect();
    assert!(matches!(
        authority.reconcile_startup_owners(StartupPathOwners {
            retained_ids: oversized,
            trusted_families: vec![],
        }),
        Err(Error::ResourceLimit(_))
    ));
    for index in 0..20 {
        authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids: vec![PathRef {
                    id: format!("missing-{index}"),
                }],
                trusted_families: vec![],
            })
            .unwrap();
    }
    assert!(authority.startup_retained_ids.is_empty());
}

#[test]
fn registry_reader_consumes_only_ceiling_plus_detection_byte() {
    struct CountingReader(u64);
    impl Read for CountingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if buffer.is_empty() {
                return Ok(0);
            }
            self.0 += buffer.len() as u64;
            buffer.fill(0);
            Ok(buffer.len())
        }
    }
    let mut reader = CountingReader(0);
    assert!(matches!(
        read_registry_bytes(&mut reader),
        Err(Error::ResourceLimit(_))
    ));
    assert_eq!(reader.0, MAX_LEGACY_REGISTRY_BYTES + 1);
}

#[test]
fn single_id_getter_refreshes_only_the_queried_record() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let first = authority.register_opening_book(&first, "first").unwrap();
    authority.register_opening_book(&second, "second").unwrap();
    let observed = Arc::new(Mutex::new(Vec::<String>::new()));
    let captured = observed.clone();
    REFRESH_ENTRY_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move |id| captured.lock().unwrap().push(id.into())))
    });
    assert_eq!(authority.display_name(first.path_ref()).unwrap(), "first");
    REFRESH_ENTRY_HOOK.with(|slot| *slot.borrow_mut() = None);
    assert_eq!(
        observed.lock().unwrap().as_slice(),
        &[first.path_ref().id.clone()]
    );
}

#[cfg(unix)]
#[test]
fn final_directory_resolution_rejects_a_swap_between_stat_and_open() {
    let dir = tempfile::tempdir().unwrap();
    let child = dir.path().join("child");
    let original = dir.path().join("original");
    fs::create_dir(&child).unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .migrate_legacy_os_path(
            dir.path().as_os_str().to_os_string(),
            "root",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    let child_for_hook = child.clone();
    RESOLVE_PRE_DIRECTORY_OPEN_HOOK.with(|slot| {
        *slot.borrow_mut() = Some(Box::new(move || {
            fs::rename(&child_for_hook, &original).unwrap();
            fs::create_dir(&child_for_hook).unwrap();
        }))
    });
    assert!(matches!(
        authority.resolve(&root.id, PathOperation::ReadPgn, &[OsString::from("child")]),
        Err(Error::Conflict(_))
    ));
}

#[test]
fn startup_sweep_reclaims_each_non_attachment_purpose_but_preserves_native_owners_and_files() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let purposes = [
        EntryPurpose::PgnWorkspace,
        EntryPurpose::PgnFile,
        EntryPurpose::PgnReadOnlyFile,
        EntryPurpose::DownloadDestination,
        EntryPurpose::DatabaseFile,
        EntryPurpose::PuzzleFile,
        EntryPurpose::EngineExecutable,
        EntryPurpose::OpeningBook,
        EntryPurpose::DatabaseRoot,
        EntryPurpose::PuzzleRoot,
        EntryPurpose::EngineRoot,
    ];
    let mut entries = Vec::new();
    let mut paths = Vec::new();
    for (index, purpose) in purposes.into_iter().enumerate() {
        let path = dir.path().join(format!("stale-{index}"));
        if purpose_matches_shape(purpose, PathClass::PersistentCustomRoot, true) {
            fs::create_dir(&path).unwrap();
        } else {
            fs::write(&path, b"file").unwrap();
        }
        paths.push(path.clone());
        entries.push(stored_entry_for(
            &path,
            format!("stale-{index}"),
            Some(purpose),
            canonical_operations(purpose),
        ));
    }
    let active_path = dir.path().join("active-root");
    fs::create_dir(&active_path).unwrap();
    entries.push(stored_entry_for(
        &active_path,
        "active-root",
        Some(EntryPurpose::DatabaseRoot),
        canonical_operations(EntryPurpose::DatabaseRoot),
    ));
    let pending_path = dir.path().join("pending-root");
    fs::create_dir(&pending_path).unwrap();
    entries.push(stored_entry_for(
        &pending_path,
        "pending-root",
        Some(EntryPurpose::PgnWorkspace),
        canonical_operations(EntryPurpose::PgnWorkspace),
    ));
    let resource_path = dir.path().join("resource");
    fs::write(&resource_path, b"resource").unwrap();
    entries.push(stored_entry_for(
        &resource_path,
        "resource",
        Some(EntryPurpose::EngineResource),
        canonical_operations(EntryPurpose::EngineResource),
    ));
    let pending = PendingArtifact {
        id: PathRef {
            id: "pending-id".into(),
        },
        root: PathRef {
            id: "pending-root".into(),
        },
        filename: NativePath::from_path(Path::new("pending.pgn")),
        display_name: "pending".into(),
        operations: vec![PathOperation::ReadPgn],
        baseline: None,
        root_identity: None,
        payload_size: 0,
        payload_sha256: String::new(),
        payload_bound: false,
        installed_identity: None,
        installed_ctime_nanos: None,
    };
    fs::write(
        &registry,
        serde_json::to_vec(&Registry {
            schema_version: SCHEMA_VERSION,
            entries,
            active_database_root: Some(PathRef {
                id: "active-root".into(),
            }),
            active_puzzle_root: None,
            active_engine_root: None,
            pending_artifacts: vec![pending],
            provisional_attachments: BTreeSet::new(),
            image_cleanup: vec![],
            catalog_installs: BTreeMap::new(),
            catalog_uses: Vec::new(),
        })
        .unwrap(),
    )
    .unwrap();
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    authority
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![PathRef {
                id: "unrecognized-renderer-id".into(),
            }],
            trusted_families: vec![
                PathOwnerFamily::Engines,
                PathOwnerFamily::DownloadDestination,
                PathOwnerFamily::FileWorkspace,
                PathOwnerFamily::RecentFiles,
                PathOwnerFamily::ReferenceDatabase,
                PathOwnerFamily::PuzzleDatabase,
                PathOwnerFamily::OpeningBook,
                PathOwnerFamily::SessionWorkspace,
                PathOwnerFamily::ExpandedDirectories,
                PathOwnerFamily::DatabaseView,
                PathOwnerFamily::PracticeDeck,
            ],
        })
        .unwrap();
    for index in 0..purposes.len() {
        assert!(!authority.persistent.contains_key(&format!("stale-{index}")));
    }
    for kept in ["active-root", "pending-root", "resource"] {
        assert!(authority.persistent.contains_key(kept), "{kept}");
    }
    for path in paths
        .iter()
        .chain([&active_path, &pending_path, &resource_path])
    {
        assert!(path.exists(), "reclamation removed {}", path.display());
    }
    drop(authority);
    let reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert!(reloaded.persistent.contains_key("active-root"));
    assert!(reloaded.persistent.contains_key("pending-root"));
    assert!(reloaded.persistent.contains_key("resource"));
}

#[test]
fn startup_sweep_protects_database_capabilities_when_recent_files_are_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("recent.db3");
    fs::write(&path, b"database").unwrap();
    let registry = dir.path().join("registry.json");
    write_registry_with_entries(
        &registry,
        vec![stored_entry_for(
            &path,
            "recent-db",
            Some(EntryPurpose::DatabaseFile),
            canonical_operations(EntryPurpose::DatabaseFile),
        )],
    );
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    require_durable(
        authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids: vec![],
                trusted_families: vec![
                    PathOwnerFamily::ReferenceDatabase,
                    PathOwnerFamily::SessionWorkspace,
                    PathOwnerFamily::DatabaseView,
                ],
            })
            .unwrap(),
    )
    .unwrap();
    assert!(authority.has_persistent_id("recent-db"));
    require_durable(
        authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids: vec![],
                trusted_families: vec![PathOwnerFamily::RecentFiles],
            })
            .unwrap(),
    )
    .unwrap();
    assert!(!authority.has_persistent_id("recent-db"));
    assert!(path.exists());
}

#[test]
fn referenced_offline_record_survives_a_trusted_startup_sweep() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let path = dir.path().join("offline.book");
    fs::write(&path, b"book").unwrap();
    let handle = {
        let mut initial = PathAuthority::open(registry.clone(), vec![]).unwrap();
        initial.register_opening_book(&path, "offline").unwrap()
    };
    fs::remove_file(&path).unwrap();
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    authority
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![handle.id.clone()],
            trusted_families: vec![PathOwnerFamily::OpeningBook],
        })
        .unwrap();
    assert!(authority.persistent.contains_key(&handle.path_ref().id));
    assert_eq!(
        authority.persistent[&handle.path_ref().id].availability,
        PathAvailability::Unavailable
    );
}

#[test]
fn workspace_and_database_child_reuse_upgrade_canonical_operations_under_the_same_id() {
    let dir = tempfile::tempdir().unwrap();
    let (mut authority, workspace_root) =
        writable_root(&dir, canonical_operations(EntryPurpose::PgnWorkspace));
    let workspace_file = dir.path().join("root/study.pgn");
    fs::write(&workspace_file, b"*").unwrap();
    let workspace = FileWorkspaceHandle::new(workspace_root);
    let child = authority
        .register_workspace_child_observed(
            &workspace,
            &[OsString::from("study.pgn")],
            "study",
            observed_identity(&workspace_file),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    authority
        .persistent
        .get_mut(&child.path_ref().id)
        .unwrap()
        .stored
        .operations = vec![PathOperation::ReadPgn];
    authority.save().unwrap();
    let reused = authority
        .register_workspace_child_observed(
            &workspace,
            &[OsString::from("study.pgn")],
            "study",
            observed_identity(&workspace_file),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    assert_eq!(reused, child);
    assert_eq!(
        authority.persistent[&child.path_ref().id].stored.operations,
        canonical_operations(EntryPurpose::PgnFile)
    );

    let database_root_path = dir.path().join("databases");
    fs::create_dir(&database_root_path).unwrap();
    let database_path = database_root_path.join("child.db3");
    fs::write(&database_path, b"database").unwrap();
    let database_root = authority
        .get_or_create_database_root(&database_root_path, "databases", None)
        .unwrap();
    let database = authority
        .register_database_child(
            &database_root,
            OsStr::new("child.db3"),
            "child",
            observed_identity(&database_root_path.join("child.db3")),
        )
        .unwrap();
    authority
        .persistent
        .get_mut(&database.path_ref().id)
        .unwrap()
        .stored
        .operations = vec![PathOperation::DatabaseRead];
    authority.save().unwrap();
    let database_again = authority
        .register_database_child(
            &database_root,
            OsStr::new("child.db3"),
            "child",
            observed_identity(&database_root_path.join("child.db3")),
        )
        .unwrap();
    assert_eq!(database_again, database);
    assert_eq!(
        authority.persistent[&database.path_ref().id]
            .stored
            .operations,
        canonical_operations(EntryPurpose::DatabaseFile)
    );
}

#[test]
fn unknown_workspace_child_reuse_requires_the_parent_operation_set() {
    let dir = tempfile::tempdir().unwrap();
    let root_path = dir.path().join("unknown-root");
    let child_path = root_path.join("study.pgn");
    fs::create_dir(&root_path).unwrap();
    fs::write(&child_path, b"*").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let root = authority
        .migrate_legacy_os_path(
            root_path.into_os_string(),
            "unknown root",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn, PathOperation::SnapshotWrite],
        )
        .unwrap()
        .id;
    let unrelated = StoredEntry {
        id: PathRef {
            id: "unrelated-unknown".into(),
        },
        display_name: "unrelated".into(),
        class: PathClass::PersistentFile,
        operations: vec![PathOperation::ReadPgn, PathOperation::LogWrite],
        path: NativePath::from_path(&child_path),
        identity: identity(&child_path).unwrap(),
        parent_identity: None,
        target_is_dir: false,
        purpose: None,
        practice_key: None,
    };
    authority.persistent.insert(
        unrelated.id.id.clone(),
        Entry {
            stored: unrelated,
            availability: PathAvailability::Available,
        },
    );
    authority.save().unwrap();

    let registered = authority
        .register_workspace_child_observed(
            &FileWorkspaceHandle::new(root),
            &[OsString::from("study.pgn")],
            "study",
            observed_identity(&child_path),
            false,
            PathOperation::ReadPgn,
        )
        .unwrap();
    assert_ne!(registered.path_ref().id, "unrelated-unknown");
    assert_eq!(
        authority.persistent["unrelated-unknown"].stored.operations,
        vec![PathOperation::ReadPgn, PathOperation::LogWrite]
    );
    assert_eq!(
        authority.persistent[&registered.path_ref().id]
            .stored
            .operations,
        vec![PathOperation::ReadPgn, PathOperation::SnapshotWrite]
    );
}

#[test]
fn repeated_create_remove_cycles_prune_session_tracking() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("study.pgn");
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    for _ in 0..20 {
        fs::write(&path, b"*").unwrap();
        let handle = authority
            .get_or_create_persistent_file(
                &path,
                "study",
                canonical_operations(EntryPurpose::PgnFile),
            )
            .unwrap();
        fs::remove_file(&path).unwrap();
        let mut dropped = Vec::new();
        authority
            .remove_workspace_entry(
                &FileWorkspaceHandle::new(handle.id),
                WorkspaceRemovalStatus::Complete,
                &mut dropped,
            )
            .map(|(durability, _)| durability)
            .unwrap();
        assert!(authority.persistent.is_empty());
        assert!(authority.session_protected_ids.is_empty());
        assert!(authority.loaded_candidate_ids.is_empty());
        assert!(authority.startup_retained_ids.is_empty());
    }
}

#[test]
fn delayed_sweep_preserves_fresh_reissued_and_successfully_used_records() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let paths: Vec<_> = (0..4)
        .map(|index| dir.path().join(format!("book-{index}")))
        .collect();
    for path in &paths {
        fs::write(path, b"book").unwrap();
    }
    let loaded: Vec<_> = {
        let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
        paths[..3]
            .iter()
            .map(|path| authority.register_opening_book(path, "book").unwrap())
            .collect()
    };
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    let fresh = authority.register_opening_book(&paths[3], "fresh").unwrap();
    let reissued = authority
        .register_opening_book(&paths[0], "reissued")
        .unwrap();
    assert_eq!(reissued, loaded[0]);
    authority
        .resolve(loaded[1].path_ref(), PathOperation::OpeningBookRead, &[])
        .unwrap();
    authority
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![],
            trusted_families: vec![PathOwnerFamily::OpeningBook],
        })
        .unwrap();
    for kept in [&fresh, &loaded[0], &loaded[1]] {
        assert!(authority.persistent.contains_key(&kept.path_ref().id));
    }
    assert!(!authority.persistent.contains_key(&loaded[2].path_ref().id));
    assert!(authority.session_protected_ids.len() <= authority.persistent.len());
}

#[test]
fn startup_sweep_failure_is_retryable_and_uncertain_replacement_is_adopted_but_incomplete() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let first = dir.path().join("first.book");
    let second = dir.path().join("second.book");
    fs::write(&first, b"first").unwrap();
    fs::write(&second, b"second").unwrap();
    let (first_id, second_id) = {
        let mut initial = PathAuthority::open(registry.clone(), vec![]).unwrap();
        let first = initial.register_opening_book(&first, "first").unwrap();
        let second = initial.register_opening_book(&second, "second").unwrap();
        (first.id, second.id)
    };
    let disk_before = fs::read(&registry).unwrap();
    let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(authority
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![first_id.clone()],
            trusted_families: vec![PathOwnerFamily::OpeningBook],
        })
        .is_err());
    set_test_atomic_file_injector(None);
    assert!(authority.persistent.contains_key(&second_id.id));
    assert_eq!(fs::read(&registry).unwrap(), disk_before);
    assert!(!authority
        .completed_owner_families
        .contains(&PathOwnerFamily::OpeningBook));

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    let durability = authority
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![first_id.clone()],
            trusted_families: vec![PathOwnerFamily::OpeningBook],
        })
        .unwrap();
    set_test_atomic_file_injector(None);
    assert!(matches!(
        durability,
        CommitDurability::DurabilityUncertain(_)
    ));
    assert!(!authority.persistent.contains_key(&second_id.id));
    assert!(!authority
        .completed_owner_families
        .contains(&PathOwnerFamily::OpeningBook));
    assert_eq!(
        authority
            .reconcile_startup_owners(StartupPathOwners {
                // The candidate was already adopted before the uncertain parent sync. This
                // identical snapshot must retry the durability fence instead of reporting a
                // no-op as durable without another replacement.
                retained_ids: vec![first_id],
                trusted_families: vec![PathOwnerFamily::OpeningBook],
            })
            .unwrap(),
        CommitDurability::Durable
    );
    assert!(authority
        .completed_owner_families
        .contains(&PathOwnerFamily::OpeningBook));
}

#[test]
fn legacy_attachment_union_can_shrink_from_four_thousand_ninety_eight_ids() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let resource = dir.path().join("resource.nnue");
    fs::write(&resource, b"resource").unwrap();
    let template = Entry {
        stored: stored_entry_for(
            &resource,
            "legacy-0",
            Some(EntryPurpose::EngineResource),
            canonical_operations(EntryPurpose::EngineResource),
        ),
        availability: PathAvailability::Available,
    };
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    for index in 0..(MAX_AUTHORITY_IDS + 2) {
        let mut entry = template.clone();
        entry.stored.id.id = format!("legacy-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    authority.save().unwrap();
    let mut reopened = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let all = reopened
        .persistent
        .keys()
        .map(|id| PathRef { id: id.clone() })
        .collect::<Vec<_>>();
    assert_eq!(all.len(), MAX_AUTHORITY_IDS + 2);
    reopened
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: all.clone(),
        })
        .unwrap();
    let retained = all[..MAX_AUTHORITY_IDS + 1].to_vec();
    reopened
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(retained.clone()),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    assert_eq!(reopened.persistent.len(), MAX_AUTHORITY_IDS + 1);
    let reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(reloaded.persistent.len(), MAX_AUTHORITY_IDS + 1);
}

#[test]
fn legacy_startup_owner_union_can_shrink_from_four_thousand_ninety_eight_ids() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let executable = dir.path().join("engine");
    fs::write(&executable, b"engine").unwrap();
    let template = Entry {
        stored: stored_entry_for(
            &executable,
            "legacy-engine-0",
            Some(EntryPurpose::EngineExecutable),
            canonical_operations(EntryPurpose::EngineExecutable),
        ),
        availability: PathAvailability::Available,
    };
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    for index in 0..(MAX_AUTHORITY_IDS + 2) {
        let mut entry = template.clone();
        entry.stored.id.id = format!("legacy-engine-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    authority.save().unwrap();
    let mut reopened = PathAuthority::open(registry.clone(), vec![]).unwrap();
    let retained = reopened
        .persistent
        .keys()
        .take(MAX_AUTHORITY_IDS + 1)
        .map(|id| PathRef { id: id.clone() })
        .collect::<Vec<_>>();
    reopened
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: retained,
            trusted_families: vec![PathOwnerFamily::Engines],
        })
        .unwrap();
    assert_eq!(reopened.persistent.len(), MAX_AUTHORITY_IDS + 1);
    let reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert_eq!(reloaded.persistent.len(), MAX_AUTHORITY_IDS + 1);
}

#[tokio::test]
async fn active_image_issuance_lease_drains_before_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let lease = authority.begin_engine_image_issuance().unwrap();
    let tracker = authority.active_image_issuances();
    authority.seal_engine_attachments();
    assert!(matches!(
        authority.begin_engine_image_issuance(),
        Err(Error::Conflict(_))
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(10), tracker.wait_for_zero())
            .await
            .is_err()
    );
    drop(lease);
    tokio::time::timeout(Duration::from_secs(1), tracker.wait_for_zero())
        .await
        .unwrap();
}

fn attachment_resource(authority: &mut PathAuthority, path: &Path) -> EngineResourceHandle {
    portable_tests::attachment_resource(authority, path)
}

#[test]
fn attachment_prepare_adopts_new_provisional_without_downgrading_reused_owned_id() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.nnue");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let handle = attachment_resource(&mut authority, &path);
    assert!(authority.provisional_attachments.contains(&handle.id.id));
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![handle.id.clone()],
        })
        .unwrap();
    let reused = attachment_resource(&mut authority, &path);
    assert_eq!(reused.id, handle.id);
    assert!(!authority.provisional_attachments.contains(&handle.id.id));
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![handle.id.clone()],
        })
        .unwrap();
    set_test_atomic_file_injector(None);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![handle.id.clone()],
            startup: false,
        })
        .unwrap();
    assert!(authority.persistent.contains_key(&handle.id.id));
}

#[test]
fn sealed_attachments_refuse_image_registration_and_resource_promotion_without_consumption() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let image_leaf = uuid::Uuid::new_v4().to_string();
    let (_, image_identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&image_leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let resource_path = dir.path().join("resource.nnue");
    fs::write(&resource_path, b"resource").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let grant = authority
        .grant_dialog(
            &resource_path,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    authority.save().unwrap();
    let before = fs::read(dir.path().join("registry.json")).unwrap();
    let persistent_before = authority.persistent.clone();
    let provisional_before = authority.provisional_attachments.clone();
    let retired_before = authority.retired_attachments.clone();
    let cleanup_before = authority.image_cleanup.clone();
    authority.seal_engine_attachments();

    assert!(matches!(
        authority.register_engine_image(
            &image_dir,
            OsStr::new(&image_leaf),
            image_identity,
            "image".into(),
        ),
        Err(Error::Conflict(_))
    ));
    assert!(matches!(
        authority.promote_engine_resource(&grant, EngineResourceHandleKind::File, "resource",),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read(dir.path().join("registry.json")).unwrap(), before);
    assert!(authority.persistent == persistent_before);
    assert_eq!(authority.provisional_attachments, provisional_before);
    assert!(authority.retired_attachments == retired_before);
    assert_eq!(authority.image_cleanup, cleanup_before);
    assert!(authority.dialogs.contains_key(&grant.id));
    assert!(image_dir.path().join(&image_leaf).exists());

    let book_path = dir.path().join("book.bin");
    fs::write(&book_path, b"book").unwrap();
    assert!(authority.register_opening_book(&book_path, "book").is_ok());
}

#[test]
fn prepare_retry_reestablishes_uncertain_image_adoption_and_keeps_cleanup_cancelled() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let image = authority
        .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    assert!(authority.image_cleanup.contains_key(&image.id.id));
    let before_failed_prepare = fs::read(&registry).unwrap();

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .is_err());
    set_test_atomic_file_injector(None);
    assert_eq!(fs::read(&registry).unwrap(), before_failed_prepare);
    assert!(!authority.persistent.contains_key(&image.id.id));
    assert!(authority.retired_attachments.contains_key(&image.id.id));
    assert!(authority.image_cleanup.contains_key(&image.id.id));

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        }),
        Err(Error::CommittedDurabilityUncertain(_))
    ));
    set_test_atomic_file_injector(None);
    assert!(authority.persistent.contains_key(&image.id.id));
    assert!(!authority.retired_attachments.contains_key(&image.id.id));
    assert!(!authority.image_cleanup.contains_key(&image.id.id));
    assert!(authority.registry_durability_pending);

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .is_err());
    set_test_atomic_file_injector(None);
    assert!(authority.registry_durability_pending);

    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    assert!(!authority.registry_durability_pending);
    assert!(image_dir.path().join(&leaf).exists());
    let reopened = PathAuthority::open(registry, vec![]).unwrap();
    assert!(reopened.persistent.contains_key(&image.id.id));
    assert!(reopened.image_cleanup.is_empty());
}

#[test]
fn attachment_reconcile_retained_wins_and_retired_resource_resolves_only_this_session() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.nnue");
    let registry = dir.path().join("registry.json");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let handle = attachment_resource(&mut authority, &path);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![handle.id.clone()]),
            abandoned_ids: vec![handle.id.clone()],
            startup: false,
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    assert!(!authority.persistent.contains_key(&handle.id.id));
    assert!(authority
        .resolve(&handle.id, PathOperation::EngineResourceRead, &[])
        .is_ok());
    let mut reloaded = PathAuthority::open(registry, vec![]).unwrap();
    assert!(reloaded
        .resolve(&handle.id, PathOperation::EngineResourceRead, &[])
        .is_err());
    assert_eq!(fs::read(path).unwrap(), b"resource");
}

#[test]
fn attachment_abandon_only_retires_provisional_and_commit_boundaries_are_truthful() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.nnue");
    let registry = dir.path().join("registry.json");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let handle = attachment_resource(&mut authority, &path);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![handle.id.clone()],
            startup: false,
        })
        .unwrap();
    assert!(!authority.persistent.contains_key(&handle.id.id));
    assert!(authority.retired_attachments.contains_key(&handle.id.id));
    assert!(authority
        .resolve(&handle.id, PathOperation::EngineResourceRead, &[])
        .is_ok());

    let retry_path = dir.path().join("retry.nnue");
    let retry = attachment_resource(&mut authority, &retry_path);
    let before = fs::read(&registry).unwrap();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![retry.id.clone()],
            startup: false,
        })
        .is_err());
    set_test_atomic_file_injector(None);
    assert!(authority.persistent.contains_key(&retry.id.id));
    assert!(authority.provisional_attachments.contains(&retry.id.id));
    assert!(!authority.retired_attachments.contains_key(&retry.id.id));
    assert_eq!(fs::read(&registry).unwrap(), before);

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![retry.id.clone()],
            startup: false,
        }),
        Err(Error::CommittedDurabilityUncertain(_))
    ));
    set_test_atomic_file_injector(None);
    assert!(!authority.persistent.contains_key(&retry.id.id));
    assert!(authority.retired_attachments.contains_key(&retry.id.id));
    assert!(!authority.provisional_attachments.contains(&retry.id.id));
    let reopened = PathAuthority::open(registry, vec![]).unwrap();
    assert!(!reopened.persistent.contains_key(&retry.id.id));
}

#[test]
fn loaded_attachment_metadata_rejects_invalid_shapes_and_overlaps() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let resource = dir.path().join("resource.nnue");
    fs::write(&resource, b"resource").unwrap();
    let valid = stored_entry_for(
        &resource,
        "resource-id",
        Some(EntryPurpose::EngineResource),
        canonical_operations(EntryPurpose::EngineResource),
    );
    let mut invalid_provisional = serde_json::to_value(Registry {
        schema_version: SCHEMA_VERSION,
        entries: vec![valid.clone()],
        active_database_root: None,
        active_puzzle_root: None,
        active_engine_root: None,
        pending_artifacts: vec![],
        provisional_attachments: BTreeSet::from(["unknown".into()]),
        image_cleanup: vec![],
        catalog_installs: BTreeMap::new(),
        catalog_uses: Vec::new(),
    })
    .unwrap();
    fs::write(&registry, serde_json::to_vec(&invalid_provisional).unwrap()).unwrap();
    assert!(matches!(
        PathAuthority::open(registry.clone(), vec![]),
        Err(Error::InvalidInput(_))
    ));

    let image_leaf = uuid::Uuid::new_v4().to_string();
    let image = dir.path().join(&image_leaf);
    fs::write(&image, b"image").unwrap();
    let cleanup = stored_entry_for(
        &image,
        "resource-id",
        Some(EntryPurpose::EngineImage),
        canonical_operations(EntryPurpose::EngineImage),
    );
    invalid_provisional["provisional_attachments"] = serde_json::json!([]);
    invalid_provisional["image_cleanup"] = serde_json::json!([cleanup]);
    invalid_provisional["entries"] = serde_json::json!([valid]);
    fs::write(&registry, serde_json::to_vec(&invalid_provisional).unwrap()).unwrap();
    assert!(matches!(
        PathAuthority::open(registry, vec![]),
        Err(Error::InvalidInput(_))
    ));
}

#[test]
fn schema_one_legacy_attachments_without_lifecycle_fields_load_as_owned() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let resource_path = dir.path().join("resource.nnue");
    fs::write(&resource_path, b"resource").unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let (resource_id, image_id) = {
        let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
        let resource = attachment_resource(&mut authority, &resource_path);
        let image = authority
            .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
            .unwrap();
        (resource.id, image.id)
    };
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
    legacy
        .as_object_mut()
        .unwrap()
        .remove("provisional_attachments");
    legacy.as_object_mut().unwrap().remove("image_cleanup");
    for entry in legacy["entries"].as_array_mut().unwrap() {
        entry.as_object_mut().unwrap().remove("purpose");
    }
    fs::write(&registry, serde_json::to_vec(&legacy).unwrap()).unwrap();

    let mut reopened = PathAuthority::open(registry, vec![]).unwrap();
    assert!(reopened.persistent.contains_key(&resource_id.id));
    assert!(reopened.persistent.contains_key(&image_id.id));
    assert!(reopened.provisional_attachments.is_empty());
    reopened
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: None,
            abandoned_ids: vec![resource_id.clone(), image_id.clone()],
            startup: false,
        })
        .unwrap();
    assert!(reopened.persistent.contains_key(&resource_id.id));
    assert!(reopened.persistent.contains_key(&image_id.id));
    assert!(reopened.image_cleanup.is_empty());
    assert!(resource_path.exists());
    assert!(image_dir.path().join(&leaf).exists());
}

#[test]
fn delayed_attachment_startup_preserves_fresh_prepared_reissued_and_used_handles() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let paths: Vec<_> = (0..3)
        .map(|index| dir.path().join(format!("resource-{index}.nnue")))
        .collect();
    for path in &paths {
        fs::write(path, b"resource").unwrap();
    }
    let loaded = {
        let mut authority = PathAuthority::open(registry.clone(), vec![]).unwrap();
        paths
            .iter()
            .map(|path| attachment_resource(&mut authority, path))
            .collect::<Vec<_>>()
    };
    let mut authority = PathAuthority::open(registry, vec![]).unwrap();
    let reissued = attachment_resource(&mut authority, &paths[1]);
    let fresh_path = dir.path().join("fresh.nnue");
    let fresh = attachment_resource(&mut authority, &fresh_path);
    let prepared_path = dir.path().join("prepared.nnue");
    let prepared = attachment_resource(&mut authority, &prepared_path);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![prepared.id.clone()],
        })
        .unwrap();
    authority
        .resolve(&loaded[2].id, PathOperation::EngineResourceRead, &[])
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: true,
        })
        .unwrap();
    for id in [
        reissued.id.clone(),
        fresh.id.clone(),
        prepared.id.clone(),
        loaded[2].id.clone(),
    ] {
        assert!(authority.persistent.contains_key(&id.id));
    }
    assert!(!authority.persistent.contains_key(&loaded[0].id.id));
    assert!(authority.retired_attachments.contains_key(&loaded[0].id.id));
}

#[test]
fn quota_first_prepare_then_empty_owner_reload_reclaims_only_unowned_attachments() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let resource_prepared_path = dir.path().join("prepared.nnue");
    let resource_owned_path = dir.path().join("owned.nnue");
    let executable_prepared_path = dir.path().join("prepared-engine");
    let executable_owned_path = dir.path().join("owned-engine");
    fs::write(&executable_prepared_path, b"prepared").unwrap();
    fs::write(&executable_owned_path, b"owned").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(0)));
    let prepared_resource = attachment_resource(&mut authority, &resource_prepared_path);
    let owned_resource = attachment_resource(&mut authority, &resource_owned_path);
    let prepared_leaf = uuid::Uuid::new_v4().to_string();
    let owned_leaf = uuid::Uuid::new_v4().to_string();
    let (_, prepared_identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&prepared_leaf), |file| {
            file.write_all(b"prepared image").map_err(Error::from)
        })
        .unwrap();
    let (_, owned_identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&owned_leaf), |file| {
            file.write_all(b"owned image").map_err(Error::from)
        })
        .unwrap();
    let prepared_image = authority
        .register_engine_image(
            &image_dir,
            OsStr::new(&prepared_leaf),
            prepared_identity,
            "prepared image".into(),
        )
        .unwrap();
    let owned_image = authority
        .register_engine_image(
            &image_dir,
            OsStr::new(&owned_leaf),
            owned_identity,
            "owned image".into(),
        )
        .unwrap();
    let prepared_executable = authority
        .get_or_create_persistent_file(
            &executable_prepared_path,
            "prepared engine",
            canonical_operations(EntryPurpose::EngineExecutable),
        )
        .unwrap();
    let owned_executable = authority
        .get_or_create_persistent_file(
            &executable_owned_path,
            "owned engine",
            canonical_operations(EntryPurpose::EngineExecutable),
        )
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![
                prepared_resource.id.clone(),
                owned_resource.id.clone(),
                prepared_image.id.clone(),
                owned_image.id.clone(),
            ],
        })
        .unwrap();
    let mut reopened = PathAuthority::open(registry, vec![]).unwrap();
    reopened
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![owned_resource.id.clone(), owned_image.id.clone()]),
            abandoned_ids: vec![],
            startup: true,
        })
        .unwrap();
    reopened
        .reconcile_startup_owners(StartupPathOwners {
            retained_ids: vec![owned_executable.id.clone()],
            trusted_families: vec![PathOwnerFamily::Engines],
        })
        .unwrap();
    reopened.cleanup_engine_images(&image_dir, false).unwrap();
    assert!(!reopened.persistent.contains_key(&prepared_resource.id.id));
    assert!(!reopened.persistent.contains_key(&prepared_image.id.id));
    assert!(!reopened.persistent.contains_key(&prepared_executable.id.id));
    assert!(reopened.persistent.contains_key(&owned_resource.id.id));
    assert!(reopened.persistent.contains_key(&owned_image.id.id));
    assert!(reopened.persistent.contains_key(&owned_executable.id.id));
    assert!(resource_prepared_path.exists());
    assert!(image_dir.path().join(&owned_leaf).exists());
    assert!(!image_dir.path().join(&prepared_leaf).exists());
}

#[test]
fn attachment_admission_counts_retired_ids_on_real_issue_and_abandon_paths() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.nnue");
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    for _ in 0..4 {
        let handle = attachment_resource(&mut authority, &path);
        authority
            .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                retained_ids: None,
                abandoned_ids: vec![handle.id],
                startup: false,
            })
            .unwrap();
    }
    assert_eq!(authority.retired_attachments.len(), 4);

    let template = authority
        .retired_attachments
        .values()
        .next()
        .cloned()
        .expect("abandoning a real attachment must retain session resolution");
    for index in authority.retired_attachments.len()..MAX_AUTHORITY_IDS {
        let mut entry = template.clone();
        entry.stored.id.id = format!("retired-{index}");
        authority
            .retired_attachments
            .insert(entry.stored.id.id.clone(), entry);
    }
    let grant = authority
        .grant_dialog(
            &path,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    assert!(matches!(
        authority.promote_engine_resource(&grant, EngineResourceHandleKind::File, "resource",),
        Err(Error::ResourceLimit(_))
    ));
    assert!(!authority.dialogs.contains_key(&grant.id));
}

#[test]
fn attachment_prepare_allows_non_growing_readoption_from_an_overlimit_legacy_state() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("network.nnue");
    fs::write(&path, b"resource").unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let template = Entry {
        stored: stored_entry_for(
            &path,
            "persistent-0",
            Some(EntryPurpose::EngineResource),
            canonical_operations(EntryPurpose::EngineResource),
        ),
        availability: PathAvailability::Available,
    };
    for index in 0..MAX_AUTHORITY_IDS {
        let mut entry = template.clone();
        entry.stored.id.id = format!("persistent-{index}");
        authority
            .persistent
            .insert(entry.stored.id.id.clone(), entry);
    }
    let mut retired = template.clone();
    retired.stored.id.id = "retired-legacy".into();
    let retired_id = retired.stored.id.clone();
    authority
        .retired_attachments
        .insert(retired_id.id.clone(), retired);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![retired_id.clone()],
        })
        .unwrap();
    assert_eq!(authority.persistent.len(), MAX_AUTHORITY_IDS + 1);
    assert!(!authority.retired_attachments.contains_key(&retired_id.id));
}

#[test]
fn image_cleanup_keeps_intent_across_save_failure_and_completes_missing_retry() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let image = authority
        .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    assert!(authority.image_cleanup.contains_key(&image.id.id));

    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(authority.cleanup_engine_images(&image_dir, false).is_err());
    set_test_atomic_file_injector(None);
    assert!(authority.image_cleanup.contains_key(&image.id.id));
    assert!(!image_dir.path().join(&leaf).exists());

    set_test_atomic_file_injector(Some(Arc::new(crate::infra::fs::ParentSyncFault(
        "uncertain",
    ))));
    assert!(matches!(
        authority.cleanup_engine_images(&image_dir, false),
        Err(Error::CommittedDurabilityUncertain(_))
    ));
    set_test_atomic_file_injector(None);
    assert!(authority.image_cleanup.is_empty());
    drop(authority);
    let reopened = PathAuthority::open(dir.path().join("registry.json"), vec![]).unwrap();
    assert!(reopened.image_cleanup.is_empty());
}

#[cfg(unix)]
#[test]
fn image_cleanup_finishes_symlink_and_directory_substitutions_without_unlinking_them() {
    for directory_substitute in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let image_dir = ensure_app_owned_default_dir(
            &AppDataDir::for_test(dir.path()),
            AppOwnedDefaultRoot::EngineImages,
        )
        .unwrap();
        let leaf = uuid::Uuid::new_v4().to_string();
        let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
        let (_, identity) = image_dir
            .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
                file.write_all(b"image").map_err(Error::from)
            })
            .unwrap();
        let image = authority
            .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
            .unwrap();
        authority
            .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
                retained_ids: vec![image.id.clone()],
            })
            .unwrap();
        authority
            .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                retained_ids: Some(vec![]),
                abandoned_ids: vec![],
                startup: false,
            })
            .unwrap();
        let path = image_dir.path().join(&leaf);
        fs::remove_file(&path).unwrap();
        if directory_substitute {
            fs::create_dir(&path).unwrap();
        } else {
            let target = dir.path().join("substitute");
            fs::write(&target, b"substitute").unwrap();
            std::os::unix::fs::symlink(&target, &path).unwrap();
        }
        authority.cleanup_engine_images(&image_dir, false).unwrap();
        assert!(authority.image_cleanup.is_empty());
        assert!(path.exists());
        assert_eq!(path.is_dir(), directory_substitute);
    }
}

#[cfg(unix)]
#[test]
fn image_cleanup_finishes_regular_file_inode_substitution_without_unlinking_it() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let image = authority
        .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    let path = image_dir.path().join(&leaf);
    let substitute = dir.path().join("substitute");
    fs::write(&substitute, b"substitute").unwrap();
    fs::remove_file(&path).unwrap();
    fs::rename(&substitute, &path).unwrap();
    authority.cleanup_engine_images(&image_dir, false).unwrap();
    assert!(authority.image_cleanup.is_empty());
    assert_eq!(fs::read(path).unwrap(), b"substitute");
}

#[test]
fn image_cleanup_retains_intent_on_unrelated_io_failure() {
    let dir = tempfile::tempdir().unwrap();
    let registry = dir.path().join("registry.json");
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let image = authority
        .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    let before = fs::read(&registry).unwrap();
    crate::infra::fs::set_test_removal_injector(Some(Arc::new(crate::infra::fs::RemovalFault(
        crate::infra::fs::RemovalFaultPoint::BeforeTopOpen,
    ))));
    assert!(authority.cleanup_engine_images(&image_dir, false).is_err());
    crate::infra::fs::set_test_removal_injector(None);
    assert!(authority.image_cleanup.contains_key(&image.id.id));
    assert!(image_dir.path().join(&leaf).exists());
    assert_eq!(fs::read(&registry).unwrap(), before);
}

#[test]
fn empty_image_cleanup_does_not_write_under_injected_failure() {
    let dir = tempfile::tempdir().unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    authority.save().unwrap();
    let registry = dir.path().join("registry.json");
    let before = fs::read(&registry).unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    set_test_atomic_file_injector(Some(Arc::new(AlwaysIo)));
    assert!(authority.cleanup_engine_images(&image_dir, false).is_ok());
    set_test_atomic_file_injector(None);
    assert_eq!(fs::read(registry).unwrap(), before);
}

#[test]
fn image_cleanup_occupancy_counts_against_new_attachment_issuance() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let leaf = uuid::Uuid::new_v4().to_string();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let (_, identity) = image_dir
        .atomic_replace_leaf_identified(OsStr::new(&leaf), |file| {
            file.write_all(b"image").map_err(Error::from)
        })
        .unwrap();
    let image = authority
        .register_engine_image(&image_dir, OsStr::new(&leaf), identity, "image".into())
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![image.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    let template = authority.image_cleanup.values().next().cloned().unwrap();
    for index in authority.image_cleanup.len()..MAX_AUTHORITY_IDS {
        let mut entry = template.clone();
        entry.id.id = format!("cleanup-{index}");
        authority.image_cleanup.insert(entry.id.id.clone(), entry);
    }
    let resource_path = dir.path().join("resource.nnue");
    fs::write(&resource_path, b"resource").unwrap();
    let grant = authority
        .grant_dialog(
            &resource_path,
            "resource",
            PathClass::SingleDialogGrant,
            PathOperation::EngineResourceRead,
            Duration::from_secs(30),
            1,
        )
        .unwrap();
    assert!(matches!(
        authority.promote_engine_resource(&grant, EngineResourceHandleKind::File, "resource",),
        Err(Error::ResourceLimit(_))
    ));
    assert!(!authority.dialogs.contains_key(&grant.id));
}

#[test]
fn managed_image_cleanup_deletes_only_matching_uuid_leaf_and_preserves_retained_image() {
    let dir = tempfile::tempdir().unwrap();
    let image_dir = ensure_app_owned_default_dir(
        &AppDataDir::for_test(dir.path()),
        AppOwnedDefaultRoot::EngineImages,
    )
    .unwrap();
    let mut authority = authority(&dir, Arc::new(TestClock::new(1)));
    let issue = |authority: &mut PathAuthority, leaf: &str| {
        let (_, identity) = image_dir
            .atomic_replace_leaf_identified(OsStr::new(leaf), |file| {
                file.write_all(b"image").map_err(Error::from)
            })
            .unwrap();
        authority
            .register_engine_image(&image_dir, OsStr::new(leaf), identity, leaf.into())
            .unwrap()
    };
    let retired_leaf = uuid::Uuid::new_v4().to_string();
    let retained_leaf = uuid::Uuid::new_v4().to_string();
    let retired = issue(&mut authority, &retired_leaf);
    let retained = issue(&mut authority, &retained_leaf);
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![retired.id.clone(), retained.id.clone()],
        })
        .unwrap();
    authority
        .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
            retained_ids: Some(vec![retained.id.clone()]),
            abandoned_ids: vec![],
            startup: false,
        })
        .unwrap();
    assert!(image_dir.path().join(&retired_leaf).exists());
    authority.cleanup_engine_images(&image_dir, false).unwrap();
    assert!(!image_dir.path().join(&retired_leaf).exists());
    assert!(image_dir.path().join(&retained_leaf).exists());
    assert!(authority.image_cleanup.is_empty());
    authority.cleanup_engine_images(&image_dir, true).unwrap();
    assert!(matches!(
        authority.reconcile_engine_attachments(EngineAttachmentAction::Prepare {
            retained_ids: vec![retained.id]
        }),
        Err(Error::Conflict(_))
    ));
}
