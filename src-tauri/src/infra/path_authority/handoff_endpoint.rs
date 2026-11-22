//! The game-link handoff endpoint file.
//!
//! The instance that owns the application data directory publishes here where a later launch
//! can deliver a game link (`crate::infra::game_link_handoff`). Every access is relative to a
//! descriptor of that directory, opens no symlink and admits regular files only.

use std::ffi::OsStr;
use std::fs::File;
use std::io::Write as _;

use serde::{Deserialize, Serialize};

use super::AppDataDir;
use crate::error::Error;
use crate::infra::fs::{
    create_regular_at, created_leaf_error_after_cleanup, open_regular_at, read_bounded_bytes,
    remove_entry_at, remove_optional_regular_at, RegularFileAccess,
};

const ENDPOINT_LEAF: &str = "link-handoff.json";

/// A port and a 64-character token fit several times over; a larger file is not ours.
const MAX_ENDPOINT_BYTES: usize = 256;

/// Where the owning instance listens, and the secret a deliverer must present.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct HandoffEndpoint {
    pub(crate) port: u16,
    pub(crate) token: String,
}

/// A descriptor of the application data directory, held for the endpoint file alone.
#[derive(Debug)]
pub(crate) struct HandoffDirectory(File);

/// The file this process published, so that only that file is removed again. The file identity
/// alone does not name it: once a later owner has removed this file, the filesystem may hand
/// the same identity to the file that owner creates. The token is never issued twice.
#[derive(Debug)]
pub(crate) struct PublishedEndpoint {
    identity: (u64, u64),
    endpoint: HandoffEndpoint,
}

impl AppDataDir {
    pub(crate) fn handoff_directory(&self) -> Result<HandoffDirectory, Error> {
        Ok(HandoffDirectory(self.directory.try_clone()?))
    }
}

impl HandoffDirectory {
    fn leaf() -> &'static OsStr {
        OsStr::new(ENDPOINT_LEAF)
    }

    /// Removes an endpoint file an earlier run left behind. Only the holder of the application
    /// data lock calls this, so the file cannot belong to a live instance.
    pub(crate) fn remove_stale(&self) -> Result<(), Error> {
        remove_optional_regular_at(&self.0, Self::leaf())
    }

    /// Creates the endpoint file. It is never written over an existing entry, so its permissions
    /// are those of a fresh owner-only file whatever was there before; a failed write leaves no
    /// file behind.
    pub(crate) fn publish(&self, endpoint: &HandoffEndpoint) -> Result<PublishedEndpoint, Error> {
        let bytes = serde_json::to_vec(endpoint)
            .map_err(|_| Error::InvalidInput("the handoff endpoint cannot be encoded".into()))?;
        let (mut file, identity) = create_regular_at(&self.0, Self::leaf())?;
        if let Err(error) = file.write_all(&bytes).and_then(|()| file.flush()) {
            drop(file);
            // The half-written file is ours by identity; it has no readable token yet.
            return Err(created_leaf_error_after_cleanup(
                error.into(),
                remove_entry_at(&self.0, Self::leaf(), identity, false),
                "handoff endpoint",
                Self::leaf(),
            ));
        }
        Ok(PublishedEndpoint {
            identity,
            endpoint: endpoint.clone(),
        })
    }

    /// Reads the published endpoint; `None` when no file exists. A file that is too large, not
    /// regular or not a complete endpoint is an error, never a guess.
    pub(crate) fn read(&self) -> Result<Option<HandoffEndpoint>, Error> {
        let mut file = match open_regular_at(&self.0, Self::leaf(), RegularFileAccess::ReadOnly) {
            Ok(file) => file,
            Err(error) if error.is_missing_entry() => return Ok(None),
            Err(error) => return Err(error),
        };
        let bytes = read_bounded_bytes(
            &mut file,
            0,
            MAX_ENDPOINT_BYTES,
            "the handoff endpoint file is too large",
            || Ok(()),
        )?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| Error::InvalidInput("the handoff endpoint file is incomplete".into()))
    }

    /// Removes the endpoint file only while it is still the one this process published: it
    /// must carry this process's port and token, and be the same file. No file is no failure.
    pub(crate) fn remove(&self, published: &PublishedEndpoint) -> Result<(), Error> {
        match self.read()? {
            None => Ok(()),
            Some(current) if current == published.endpoint => {
                remove_entry_at(&self.0, Self::leaf(), published.identity, false)
            }
            Some(_) => Err(Error::InvalidInput(
                "the handoff endpoint belongs to another instance".into(),
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory(root: &std::path::Path) -> HandoffDirectory {
        AppDataDir::for_test(root)
            .handoff_directory()
            .expect("the application data directory can be duplicated")
    }

    fn endpoint() -> HandoffEndpoint {
        HandoffEndpoint {
            port: 45_123,
            token: "ab".repeat(32),
        }
    }

    #[test]
    fn a_published_endpoint_is_read_back_and_removed_by_its_publisher() {
        let root = tempfile::tempdir().unwrap();
        let directory = directory(root.path());
        assert_eq!(directory.read().unwrap(), None);

        let published = directory.publish(&endpoint()).unwrap();
        assert_eq!(directory.read().unwrap(), Some(endpoint()));
        // A second directory handle (the second process) reads the same file.
        assert_eq!(
            self::directory(root.path()).read().unwrap(),
            Some(endpoint())
        );

        directory.remove(&published).unwrap();
        assert_eq!(directory.read().unwrap(), None);
        assert!(!root.path().join(ENDPOINT_LEAF).exists());
    }

    #[cfg(unix)]
    #[test]
    fn publication_is_owner_only_even_after_a_wider_stale_file() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(ENDPOINT_LEAF);
        std::fs::write(&path, b"{\"port\":1,\"token\":\"stale\"}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let directory = directory(root.path());

        // Publishing never replaces: the stale file has to be removed first.
        assert!(directory.publish(&endpoint()).is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"{\"port\":1,\"token\":\"stale\"}"
        );

        directory.remove_stale().unwrap();
        directory.publish(&endpoint()).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(directory.read().unwrap(), Some(endpoint()));
    }

    #[test]
    fn removing_a_stale_endpoint_is_a_no_op_without_one() {
        let root = tempfile::tempdir().unwrap();
        directory(root.path()).remove_stale().unwrap();
    }

    #[test]
    fn removal_leaves_a_file_another_instance_published() {
        let root = tempfile::tempdir().unwrap();
        let directory = directory(root.path());
        let ours = directory.publish(&endpoint()).unwrap();
        // A later owner removed our stale file and published its own. Nothing keeps our file's
        // inode alive here, so the filesystem is free to give the new file the same identity.
        directory.remove_stale().unwrap();
        let theirs = HandoffEndpoint {
            port: 45_124,
            token: "cd".repeat(32),
        };
        directory.publish(&theirs).unwrap();

        assert!(directory.remove(&ours).is_err());
        assert_eq!(directory.read().unwrap(), Some(theirs));
    }

    #[test]
    fn removal_is_refused_for_the_same_file_rewritten_by_another_instance() {
        let root = tempfile::tempdir().unwrap();
        let directory = directory(root.path());
        let ours = directory.publish(&endpoint()).unwrap();
        let theirs = HandoffEndpoint {
            port: 45_124,
            token: "cd".repeat(32),
        };
        // Same file, same identity, another instance's token.
        std::fs::write(
            root.path().join(ENDPOINT_LEAF),
            serde_json::to_vec(&theirs).unwrap(),
        )
        .unwrap();

        assert!(directory.remove(&ours).is_err());
        assert_eq!(directory.read().unwrap(), Some(theirs));
    }

    #[test]
    fn removing_a_published_endpoint_that_is_already_gone_succeeds() {
        let root = tempfile::tempdir().unwrap();
        let directory = directory(root.path());
        let ours = directory.publish(&endpoint()).unwrap();
        directory.remove_stale().unwrap();

        directory.remove(&ours).unwrap();
        assert_eq!(directory.read().unwrap(), None);
    }

    #[test]
    fn an_oversized_or_incomplete_file_is_an_error_not_an_endpoint() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join(ENDPOINT_LEAF);
        let directory = directory(root.path());

        std::fs::write(&path, vec![b' '; MAX_ENDPOINT_BYTES + 1]).unwrap();
        assert!(directory.read().is_err());
        std::fs::write(&path, b"").unwrap();
        assert!(directory.read().is_err());
        std::fs::write(&path, b"{\"port\":45123").unwrap();
        assert!(directory.read().is_err());
        std::fs::write(&path, b"{\"port\":70000,\"token\":\"x\"}").unwrap();
        assert!(directory.read().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_or_directory_in_the_endpoint_place_is_never_followed_or_removed() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target.json");
        std::fs::write(&target, serde_json::to_vec(&endpoint()).unwrap()).unwrap();
        let path = root.path().join(ENDPOINT_LEAF);
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let directory = directory(root.path());

        assert!(directory.read().is_err());
        assert!(directory.remove_stale().is_err());
        assert!(directory.publish(&endpoint()).is_err());
        assert!(target.exists());
        assert!(path.symlink_metadata().unwrap().file_type().is_symlink());

        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(directory.read().is_err());
        assert!(directory.remove_stale().is_err());
        assert!(path.is_dir());
    }
}
