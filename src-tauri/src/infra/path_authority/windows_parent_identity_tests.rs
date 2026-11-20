use super::database_test_support::replace_parent_with_same_inode_hard_link;
use super::*;
use std::time::Duration;
use tempfile::TempDir;

fn workspace_with_file(
    directory: &TempDir,
    root_path: &Path,
    child_path: &Path,
) -> (PathAuthority, FileWorkspaceHandle, FileWorkspaceHandle) {
    fs::create_dir_all(root_path).unwrap();
    fs::create_dir_all(child_path.parent().unwrap()).unwrap();
    fs::write(child_path, b"1. e4 *").unwrap();
    let mut authority =
        PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .migrate_legacy_os_path(
            root_path.as_os_str().to_os_string(),
            "workspace",
            PathClass::PersistentCustomRoot,
            vec![PathOperation::ReadPgn, PathOperation::WritePgn],
        )
        .unwrap();
    let workspace = FileWorkspaceHandle::new(root.id);
    let relative = child_path.strip_prefix(root_path).unwrap();
    let components: Vec<_> = relative
        .components()
        .map(|component| component.as_os_str().to_os_string())
        .collect();
    let parent = crate::infra::fs::open_parent_no_follow(child_path).unwrap();
    let parent_identity = opened_file_identity(&parent).unwrap();
    let child_identity = identity(child_path).unwrap();
    // The registry stores the canonical spelling, which on Windows differs from `child_path`
    // (verbatim prefix), so callers use this handle rather than looking the path up.
    let child = authority
        .register_workspace_child_observed_with_parent(
            &workspace,
            &components,
            "a",
            IdentityBinding::from_pairs((child_identity.a, child_identity.b), parent_identity),
            false,
            PathOperation::WritePgn,
        )
        .unwrap();
    (authority, workspace, child)
}

#[test]
fn resolve_refuses_a_same_inode_parent_replacement_without_open_handles() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("pgn");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority =
        PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
    let handle = authority
        .migrate_legacy_os_path(
            path.clone().into_os_string(),
            "study",
            PathClass::PersistentFile,
            vec![PathOperation::ReadPgn],
        )
        .unwrap()
        .id;
    assert!(authority
        .resolve(&handle, PathOperation::ReadPgn, &[])
        .is_ok());

    replace_parent_with_same_inode_hard_link(&path);

    assert!(matches!(
        authority.resolve(&handle, PathOperation::ReadPgn, &[]),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&parent).unwrap().count(), 1);
}

#[test]
fn database_file_target_refuses_a_same_inode_parent_replacement_without_open_handles() {
    let directory = tempfile::tempdir().unwrap();
    let root_path = directory.path().join("databases");
    fs::create_dir(&root_path).unwrap();
    let mut authority =
        PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
    let root = authority
        .get_or_create_database_root(&root_path, "Databases", None)
        .unwrap();
    let handle = authority
        .create_database_child(&root, OsStr::new("child.db3"))
        .unwrap();
    let path = root_path.join("child.db3");
    assert!(authority
        .database_file_target(&handle, PathOperation::DatabaseRead)
        .is_ok());

    replace_parent_with_same_inode_hard_link(&path);

    assert!(matches!(
        authority.database_file_target(&handle, PathOperation::DatabaseRead),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(&root_path).unwrap().count(), 1);
}

#[test]
fn workspace_mutation_target_refuses_a_same_inode_parent_replacement_without_open_handles() {
    let directory = tempfile::tempdir().unwrap();
    let root_path = directory.path().join("workspace");
    let path = root_path.join("sub/a.pgn");
    let (mut authority, workspace, handle) = workspace_with_file(&directory, &root_path, &path);
    assert!(authority.workspace_mutation_target(&handle).is_ok());
    drop(workspace);

    replace_parent_with_same_inode_hard_link(&path);

    assert!(matches!(
        authority.workspace_mutation_target(&handle),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn workspace_entry_path_refuses_a_same_inode_parent_replacement_without_open_handles() {
    let directory = tempfile::tempdir().unwrap();
    let root_path = directory.path().join("workspace");
    let path = root_path.join("sub/a.pgn");
    let (mut authority, workspace, handle) = workspace_with_file(&directory, &root_path, &path);
    assert!(authority
        .workspace_entry_path(&handle, PathOperation::ReadPgn)
        .unwrap()
        .ends_with(Path::new("sub").join("a.pgn")));
    drop(workspace);

    replace_parent_with_same_inode_hard_link(&path);

    assert!(matches!(
        authority.workspace_entry_path(&handle, PathOperation::ReadPgn),
        Err(Error::Conflict(_))
    ));
    assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
}

#[test]
fn dialog_parent_replacement_fails_before_promotion_without_open_handles() {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("picked");
    fs::create_dir(&parent).unwrap();
    let path = parent.join("study.pgn");
    fs::write(&path, b"1. e4 *").unwrap();
    let mut authority =
        PathAuthority::open(directory.path().join("registry.json"), vec![]).unwrap();
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
        .unwrap_err();
    assert!(matches!(error.unlabelled(), Error::Conflict(_)));
    assert_eq!(
        error.root_failure(),
        Some(crate::error::RootFailure::Changed)
    );
}
