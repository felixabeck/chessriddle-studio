//! Native provenance for catalog trees. Records confer no path capability.
use super::*;
use crate::infra::fs::{
    open_removal_directory_at, open_verified_directory, remove_entry_at, MAX_REMOVE_TREE_DEPTH,
};

const MAX_INVENTORY_ENTRIES: usize = 16_384;
const MAX_INVENTORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub(super) type CatalogUses = BTreeMap<(PathBuf, u64, u64), BTreeMap<String, bool>>;

/// Durable evidence of child use, independent of archive ownership or resource authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct CatalogUse {
    path: NativePath,
    identity: Identity,
    sessions: BTreeMap<String, bool>,
}

fn validate_use(
    path: &Path,
    a: u64,
    b: u64,
    sessions: &BTreeMap<String, bool>,
) -> Result<(), Error> {
    if !path.is_absolute()
        || (a == 0 && b == 0)
        || sessions.is_empty()
        || sessions
            .keys()
            .any(|session| Uuid::parse_str(session).is_err())
        || path.components().any(|part| {
            matches!(
                part,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err(Error::InvalidInput("invalid catalog use evidence".into()));
    }
    let components = path
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(name) => Some(name.to_os_string()),
            _ => None,
        })
        .collect::<Vec<_>>();
    validate_components(&components)
}

fn validate_uses(uses: &CatalogUses) -> Result<(), Error> {
    let mut count = uses.len();
    for ((path, a, b), sessions) in uses {
        count = count
            .checked_add(sessions.len())
            .ok_or_else(invalid_record)?;
        if count > MAX_AUTHORITY_IDS {
            return Err(Error::ResourceLimit(
                "catalog use evidence limit reached".into(),
            ));
        }
        validate_use(path, *a, *b, sessions)?;
    }
    Ok(())
}

pub(super) fn encode_uses(uses: &CatalogUses) -> Vec<CatalogUse> {
    uses.iter()
        .map(|((path, a, b), sessions)| CatalogUse {
            path: NativePath::from_path(path),
            identity: Identity { a: *a, b: *b },
            sessions: sessions.clone(),
        })
        .collect()
}

pub(super) fn decode_uses(records: Vec<CatalogUse>) -> Result<CatalogUses, Error> {
    if records.len() > MAX_AUTHORITY_IDS
        || records
            .iter()
            .try_fold(records.len(), |count, record| {
                count.checked_add(record.sessions.len())
            })
            .is_none_or(|count| count > MAX_AUTHORITY_IDS)
        || serde_json::to_vec(&records)
            .map_err(|error| Error::InvalidInput(error.to_string()))?
            .len()
            > MAX_REGISTRY_BYTES
    {
        return Err(Error::ResourceLimit(
            "catalog use evidence limit reached".into(),
        ));
    }
    let mut uses = CatalogUses::new();
    for record in records {
        let path = record.path.to_path()?;
        validate_use(
            &path,
            record.identity.a,
            record.identity.b,
            &record.sessions,
        )?;
        if uses
            .insert(
                (path, record.identity.a, record.identity.b),
                record.sessions,
            )
            .is_some()
        {
            return Err(Error::InvalidInput("duplicate catalog use binding".into()));
        }
    }
    Ok(uses)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Publication {
    Pending,
    Confirmed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct CatalogInstall {
    root: StoredEntry,
    destination: NativePath,
    identity: Identity,
    inventory: Vec<ManagedEntry>,
    /// Absence is older provenance, which still needs exact proof before confirmation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    publication: Option<Publication>,
    #[serde(default)]
    cleaning: bool,
    /// User changes after partial cleanup end automatic deletion, but cannot make the damaged
    /// destination adoptable. Retain the original inventory until the old tree is gone.
    #[serde(default)]
    preserved: bool,
    #[serde(default)]
    users: BTreeSet<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct ManagedEntry {
    relative: NativePath,
    identity: Identity,
    directory: bool,
    sha256: Option<String>,
}

fn invalid_record() -> Error {
    Error::InvalidInput("invalid catalog install provenance".into())
}

/// Only native absence below this exact held root can retire provenance or allow publication.
fn catalog_directory_identity(
    parent: &fs::File,
    leaf: &OsStr,
) -> Result<Option<(u64, u64)>, Error> {
    match crate::infra::fs::entry_identity_at(parent, leaf, true) {
        Ok(identity) => Ok(Some(identity)),
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(Error::Conflict(
            "catalog destination could not be confirmed".into(),
        )),
    }
}

fn relative_path(path: &NativePath) -> Result<PathBuf, Error> {
    let path = path.to_path()?;
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(invalid_record());
    }
    validate_components(&relative_components(&path))?;
    Ok(path)
}

pub(super) fn validate_records(records: &BTreeMap<String, CatalogInstall>) -> Result<(), Error> {
    if records.len() > MAX_AUTHORITY_IDS {
        return Err(invalid_record());
    }
    let mut targets = BTreeSet::new();
    for (id, record) in records {
        if Uuid::parse_str(id).is_err()
            || (record.preserved && !record.cleaning)
            || (record.cleaning && record.publication == Some(Publication::Pending))
            || record.inventory.len() > MAX_INVENTORY_ENTRIES
            || record.users.len() > MAX_AUTHORITY_IDS
            || record
                .users
                .iter()
                .any(|user| Uuid::parse_str(user).is_err())
        {
            return Err(invalid_record());
        }
        validate_persisted_shape(&record.root)?;
        let root = record.root.path.to_path()?;
        if !root.is_absolute()
            || record.root.purpose != Some(EntryPurpose::EngineRoot)
            || !record.root.target_is_dir
        {
            return Err(invalid_record());
        }
        let leaf = relative_path(&record.destination)?;
        if leaf.components().count() != 1
            || !targets.insert((
                root.join(&leaf),
                record.root.identity.a,
                record.root.identity.b,
            ))
        {
            return Err(invalid_record());
        }
        let mut paths = BTreeMap::new();
        for entry in &record.inventory {
            let path = relative_path(&entry.relative)?;
            if entry.directory != entry.sha256.is_none()
                || entry.sha256.as_ref().is_some_and(|digest| {
                    digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
                || path.components().count() >= MAX_REMOVE_TREE_DEPTH
                || paths.insert(path, entry.directory).is_some()
            {
                return Err(invalid_record());
            }
        }
        for path in paths.keys() {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                if paths.get(parent) != Some(&true) {
                    return Err(invalid_record());
                }
            }
        }
    }
    Ok(())
}

fn target(record: &CatalogInstall) -> Result<PathBuf, Error> {
    Ok(record
        .root
        .path
        .to_path()?
        .join(relative_path(&record.destination)?))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reachability {
    /// Identity-confirmed descendant, recursive ancestor or exact pending reservation.
    Member,
    Disjoint,
    Uncertain,
}

impl Reachability {
    fn protects(self) -> bool {
        self != Self::Disjoint
    }
}

// Workspace ancestors do not own their children. Explicit directory resources do.
fn reaches(
    record: &CatalogInstall,
    path: &Path,
    recursive: bool,
    bound_identity: Option<&Identity>,
) -> Result<Reachability, Error> {
    // Inspection failure requires conservative retention and durable use, but is never
    // positive membership for cleaning refusal. None of these views authorize deletion.
    let physical = filesystem_reaches(
        &target(record)?,
        &record.identity,
        &record.root.identity,
        path,
        recursive,
        bound_identity,
    )
    .unwrap_or(Reachability::Uncertain);
    if physical == Reachability::Member {
        return Ok(physical);
    }
    if let Some(binding) = bound_identity {
        if *binding == record.identity
            || record
                .inventory
                .iter()
                .any(|entry| entry.identity == *binding)
        {
            return Ok(Reachability::Member);
        }
        if !recursive {
            // A known node outside the complete managed identity set cannot own independent
            // managed objects merely because its old locator disappeared. Physical membership
            // above still covers added objects. Collection independently rejects any changed
            // inventory before deletion, so this negative evidence grants no deletion authority.
            return Ok(Reachability::Disjoint);
        }
    }
    Ok(physical)
}

struct ReachabilityBinding {
    path: PathBuf,
    existing: bool,
}

impl ReachabilityBinding {
    fn resolve(path: &Path) -> Result<Self, Error> {
        match fs::canonicalize(path) {
            Ok(path) => Ok(Self {
                path,
                existing: true,
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // Only a missing final leaf has a useful partial binding. A dangling link,
                // unavailable parent or other uncertainty must conservatively retain trees.
                match fs::symlink_metadata(path) {
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    _ => return Err(Error::Conflict("uncertain catalog reachability".into())),
                }
                let parent = fs::canonicalize(path.parent().ok_or_else(invalid_record)?)?;
                Ok(Self {
                    path: parent.join(path.file_name().ok_or_else(invalid_record)?),
                    existing: false,
                })
            }
            Err(error) => Err(error.into()),
        }
    }

    fn has_ancestor(&self, expected: &Identity) -> Result<bool, Error> {
        let start = if self.existing {
            self.path.as_path()
        } else {
            self.path.parent().ok_or_else(invalid_record)?
        };
        // Include the existing leaf. This also recognizes moved trees and aliases when
        // their original provenance locator is unavailable or now names a substitute.
        for ancestor in start.ancestors() {
            if identity(ancestor)? == *expected {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

fn filesystem_reaches(
    tree: &Path,
    expected_tree: &Identity,
    expected_root: &Identity,
    path: &Path,
    recursive: bool,
    bound_identity: Option<&Identity>,
) -> Result<Reachability, Error> {
    let current = ReachabilityBinding::resolve(path);
    let current_identity = match &current {
        Ok(binding) if binding.existing => identity(&binding.path).map(Some),
        _ => Ok(None),
    };
    let actual = current_identity.as_ref().ok().and_then(Option::as_ref);
    let binding = bound_identity.or(actual);
    let current_matches = bound_identity.is_none() || actual == bound_identity;
    if binding == Some(expected_tree) {
        return Ok(Reachability::Member);
    }
    if current_matches {
        if let Ok(path) = &current {
            if path.has_ancestor(expected_tree)? {
                return Ok(Reachability::Member);
            }
        }
    }
    let tree = ReachabilityBinding::resolve(tree)?;
    let original_target = if tree.existing {
        identity(&tree.path)? == *expected_tree
    } else {
        identity(tree.path.parent().ok_or_else(invalid_record)?)? == *expected_root
    };
    if original_target && recursive {
        if let Some(binding) = binding {
            if tree.has_ancestor(binding)? {
                return Ok(Reachability::Member);
            }
        }
    }
    // A different object at the old pathname says nothing about the historical binding.
    // Only the positive identity evidence above can confirm a relocated recursive use.
    if bound_identity.is_some() && !current_matches {
        return Ok(Reachability::Uncertain);
    }
    let path = current?;
    current_identity?;
    if tree.existing {
        if !original_target {
            // Identical spellings can name an independent replacement root or tree.
            // A recursive resource could still contain the displaced original elsewhere.
            return Ok(if recursive || !path.existing {
                Reachability::Uncertain
            } else {
                Reachability::Disjoint
            });
        }
        return Ok(if path.existing {
            Reachability::Disjoint
        } else {
            Reachability::Uncertain
        });
    }
    if !original_target {
        return Ok(if recursive || !path.existing {
            Reachability::Uncertain
        } else {
            Reachability::Disjoint
        });
    }
    if path.existing {
        return Ok(Reachability::Disjoint);
    }
    if identity(path.path.parent().ok_or_else(invalid_record)?)? == *expected_root {
        // An absent destination at its verified original root remains a pending reservation.
        // Different missing leaf spellings are uncertain, never confirmed filesystem aliases.
        return Ok(if tree.path.file_name() == path.path.file_name() {
            Reachability::Member
        } else {
            Reachability::Uncertain
        });
    }
    // A previously used resource can lose its final pathname before provenance is published.
    // Its existing parent cannot establish where that resource's original binding went.
    Ok(Reachability::Uncertain)
}

fn entry_reaches(record: &CatalogInstall, entry: &StoredEntry) -> Result<Reachability, Error> {
    reaches(
        record,
        &entry.path.to_path()?,
        entry.target_is_dir && entry.purpose == Some(EntryPurpose::EngineResource),
        Some(&entry.identity),
    )
}

fn inventory(directory: &fs::File, root_device: u64) -> Result<Vec<ManagedEntry>, Error> {
    let mut entries = Vec::new();
    let mut bytes = 0;
    let mut buffer = vec![0; 64 * 1024];
    walk(
        directory,
        Path::new(""),
        root_device,
        &mut bytes,
        &mut entries,
        &mut buffer,
    )?;
    Ok(entries)
}

fn walk(
    directory: &fs::File,
    relative: &Path,
    root_device: u64,
    bytes: &mut u64,
    inventory: &mut Vec<ManagedEntry>,
    buffer: &mut [u8],
) -> Result<(), Error> {
    let entries = read_directory_entries_at(
        directory,
        &CancellationToken::new(),
        Some(MAX_INVENTORY_ENTRIES),
        &mut |_| true,
    )?;
    for entry in entries {
        if inventory.len() >= MAX_INVENTORY_ENTRIES
            || relative.components().count() + 1 >= MAX_REMOVE_TREE_DEPTH
        {
            return Err(Error::ResourceLimit(
                "catalog inventory traversal limit reached".into(),
            ));
        }
        let path = relative.join(&entry.name);
        let directory_entry = entry.kind == DirectoryEntryKind::Directory;
        let digest = match entry.kind {
            DirectoryEntryKind::Directory => {
                if entry.identity.0 != root_device {
                    return Err(Error::InvalidInput(
                        "catalog inventory refuses a mount boundary".into(),
                    ));
                }
                None
            }
            DirectoryEntryKind::RegularFile => {
                let mut file =
                    open_regular_at(directory, &entry.name, RegularFileAccess::ReadOnly)?;
                if opened_file_identity(&file)? != entry.identity {
                    return Err(Error::Conflict("catalog inventory entry changed".into()));
                }
                let (_, digest) = sha256_read_core(
                    &mut file,
                    buffer,
                    || Ok(()),
                    |read| {
                        *bytes = bytes.checked_add(read).ok_or_else(|| {
                            Error::ResourceLimit("catalog inventory content limit reached".into())
                        })?;
                        if *bytes > MAX_INVENTORY_BYTES {
                            return Err(Error::ResourceLimit(
                                "catalog inventory content limit reached".into(),
                            ));
                        }
                        Ok(())
                    },
                )?;
                Some(digest)
            }
            DirectoryEntryKind::Other => {
                return Err(Error::Conflict(
                    "catalog inventory contains a foreign entry".into(),
                ));
            }
        };
        inventory.push(ManagedEntry {
            relative: NativePath::from_path(&path),
            identity: Identity {
                a: entry.identity.0,
                b: entry.identity.1,
            },
            directory: directory_entry,
            sha256: digest,
        });
        if directory_entry {
            let child =
                open_removal_directory_at(directory, &entry.name, entry.identity)?.into_file();
            walk(&child, &path, root_device, bytes, inventory, buffer)?;
        }
        assert_entry_identity(directory, &entry.name, entry.identity, directory_entry)?;
    }
    Ok(())
}

impl PathAuthority {
    /// Native completion ownership outlives every renderer document. Retain the root before
    /// publication, then the installed and previous executable until application is acknowledged.
    pub(crate) fn retain_completion_resources(
        &mut self,
        id: &str,
        resources: Vec<PathRef>,
    ) -> Result<(), Error> {
        if resources.len() > 3
            || (!self.completion_resources.contains_key(id)
                && self.completion_resources.len()
                    >= crate::infra::operations::MAX_ACCEPTED_OPERATIONS)
        {
            return Err(Error::ResourceLimit(
                "too many pending completion resources".into(),
            ));
        }
        if resources
            .iter()
            .any(|resource| !self.persistent.contains_key(&resource.id))
        {
            return Err(Error::Conflict("completion resource is unavailable".into()));
        }
        self.completion_resources.insert(id.to_owned(), resources);
        Ok(())
    }

    pub(crate) fn release_completion_resources(&mut self, id: &str) {
        self.completion_resources.remove(id);
    }

    fn catalog_destination_root(
        &self,
        destination: &PathRef,
        path: &Path,
    ) -> Result<StoredEntry, Error> {
        let root = self
            .persistent
            .get(&destination.id)
            .ok_or_else(invalid_record)?
            .stored
            .clone();
        if root.purpose != Some(EntryPurpose::EngineRoot)
            || path.parent() != Some(root.path.to_path()?.as_path())
        {
            return Err(invalid_record());
        }
        Ok(root)
    }

    /// The single publication-state transition used by publication, adoption and collection.
    /// A failed proof retains the original pending fence and never gains deletion authority.
    fn confirm_catalog_install(
        &mut self,
        id: &str,
        retained_root: Option<&fs::File>,
    ) -> Result<bool, Error> {
        self.confirm_catalog_install_with_probe(id, retained_root, &mut EngineRootProbe::default())
    }

    fn confirm_catalog_install_with_probe(
        &mut self,
        id: &str,
        retained_root: Option<&fs::File>,
        probe: &mut EngineRootProbe,
    ) -> Result<bool, Error> {
        let record = self
            .catalog_installs
            .get(id)
            .ok_or_else(invalid_record)?
            .clone();
        if record.publication == Some(Publication::Confirmed) || record.cleaning {
            return Ok(true);
        }
        let present = (|| {
            let opened_root;
            let root = if let Some(root) = retained_root {
                if probe.filesystem(opened_file_identity(root))?
                    != (record.root.identity.a, record.root.identity.b)
                {
                    return Err(Error::Conflict("catalog publication root changed".into()));
                }
                root
            } else {
                opened_root = probe
                    .filesystem(open_verified_directory(
                        &record.root.path.to_path()?,
                        (record.root.identity.a, record.root.identity.b),
                    ))?
                    .into_file();
                &opened_root
            };
            let leaf = relative_path(&record.destination)?;
            let Some(identity) =
                probe.filesystem(catalog_directory_identity(root, leaf.as_os_str()))?
            else {
                return Ok(false);
            };
            if identity != (record.identity.a, record.identity.b) {
                return Err(Error::Conflict(
                    "catalog publication could not be confirmed".into(),
                ));
            }
            let directory = probe
                .filesystem(open_removal_directory_at(root, leaf.as_os_str(), identity))?
                .into_file();
            let observed = inventory(&directory, record.root.identity.a)?;
            if observed.len() != record.inventory.len()
                || !observed
                    .iter()
                    .all(|entry| record.inventory.contains(entry))
            {
                return Err(Error::Conflict(
                    "catalog publication could not be confirmed".into(),
                ));
            }
            probe.filesystem(assert_entry_identity(
                root,
                leaf.as_os_str(),
                identity,
                true,
            ))?;
            // Recovery may observe a rename whose producer never reached its parent sync.
            // Only after exact proof may this failure be described as applied uncertainty.
            root.sync_all().map_err(|error| {
                log::warn!("catalog publication parent sync failed: {error}");
                Error::CommittedDurabilityUncertain(crate::error::DurabilityStage::DirectoryInstall)
            })?;
            Ok(true)
        })()
        .map_err(|error| match error {
            Error::ResourceLimit(_) | Error::CommittedDurabilityUncertain(_) => error,
            _ => Error::Conflict("catalog publication could not be confirmed".into()),
        })?;
        if !present {
            return Ok(false);
        }
        let previous = self.catalog_installs.clone();
        let mut records = previous.clone();
        records.get_mut(id).ok_or_else(invalid_record)?.publication = Some(Publication::Confirmed);
        if let Err(error) = self.commit_catalog(records) {
            // An uncertain registry commit is not positive in-memory confirmation. Its old
            // durable pending candidate remains the conservative recovery interpretation.
            self.catalog_installs = previous;
            log::warn!(
                "catalog publication confirmation persistence failed: {}",
                error.diagnostic()
            );
            return Err(Error::CommittedDurabilityUncertain(
                crate::error::DurabilityStage::RegistryReplacement,
            ));
        }
        Ok(true)
    }

    fn confirm_catalog_destination(
        &mut self,
        root: &StoredEntry,
        path: &Path,
        retained_root: Option<&fs::File>,
        retained_file: Option<(&Path, VerifiedIdentity)>,
        probe: &mut EngineRootProbe,
    ) -> Result<bool, Error> {
        let opened_root;
        let directory = if let Some(directory) = retained_root {
            directory
        } else {
            opened_root = probe.filesystem(engine_install_directory(root))?;
            &opened_root
        };
        if probe.filesystem(opened_file_identity(directory))? != (root.identity.a, root.identity.b)
        {
            return Err(Error::Conflict("catalog publication root changed".into()));
        }
        let leaf = path.file_name().ok_or_else(invalid_record)?;
        // Native file identity adds refusal scope for an alias of a pending wrong-kind target.
        // Publication and deletion still require the independent directory proof.
        let binding = |name: &OsStr| {
            crate::infra::fs::entry_identity_at(directory, name, true)
                .or_else(|_| crate::infra::fs::entry_identity_at(directory, name, false))
                .ok()
        };
        // Registration adopts the retained file, even when its locator has been replaced.
        // Other consumers still classify the current native destination. Neither observation
        // grants ownership, and an unrelated replacement cannot broaden a held file's scope.
        let current = retained_file
            .map(|(_, identity)| identity.pair())
            .or_else(|| binding(leaf));
        let mut ids = Vec::new();
        for (id, record) in &self.catalog_installs {
            if record.root.identity != root.identity {
                continue;
            }
            let recorded_leaf = relative_path(&record.destination)?;
            // Root spelling is diagnostic here. Only the authorized physical root and leaf
            // define scope. Existing filesystem aliases add scope without global case folding.
            let same_leaf = recorded_leaf.as_os_str() == leaf
                || current.is_some_and(|identity| {
                    binding(recorded_leaf.as_os_str()).is_some_and(|recorded| recorded == identity)
                });
            // Full retained context covers added descendants of a moved tree too. Only the
            // shared relation's positive membership adds refusal, never uncertain ancestry
            // or a different object later occupying the captured file's locator.
            let retained_member = if let Some((target, identity)) = retained_file {
                let (a, b) = identity.pair();
                reaches(record, target, false, Some(&Identity { a, b }))? == Reachability::Member
            } else {
                false
            };
            if same_leaf || retained_member {
                ids.push(id.clone());
            }
        }
        let mut confirmed = true;
        for id in ids {
            confirmed &= self.confirm_catalog_install_with_probe(&id, Some(directory), probe)?;
        }
        Ok(confirmed)
    }

    /// Confirms adoption without acquiring ownership of legacy trees. Pending provenance may
    /// require full inventory validation, parent sync and durable publication confirmation.
    #[cfg(test)]
    pub(crate) fn confirm_catalog_archive_adoption(
        &mut self,
        destination: &PathRef,
        resolved: &ResolvedPath,
    ) -> Result<bool, Error> {
        self.confirm_catalog_archive_adoption_with_probe(
            destination,
            resolved,
            &mut EngineRootProbe::default(),
        )
    }

    pub(crate) fn confirm_catalog_archive_adoption_with_probe(
        &mut self,
        destination: &PathRef,
        resolved: &ResolvedPath,
        probe: &mut EngineRootProbe,
    ) -> Result<bool, Error> {
        let path = resolved.target().ok_or_else(invalid_record)?;
        let root = self.catalog_destination_root(destination, path)?;
        self.protect_catalog_path(path, false, false, None)?;
        let confirmed = self.confirm_catalog_destination(&root, path, None, None, probe)?;
        let directory = probe.filesystem(engine_install_directory(&root))?;
        let leaf = path.file_name().ok_or_else(invalid_record)?;
        match probe.filesystem(catalog_directory_identity(&directory, leaf))? {
            None => Ok(false),
            Some(_) if confirmed => Ok(true),
            _ => Err(Error::Conflict(
                "archive destination is not a directory".into(),
            )),
        }
    }

    /// Adoption is valid only when registration's own resolver finds the executable. An empty
    /// leaf holds nothing to preserve, so it is cleared for a fresh install. Any other tree without
    /// the executable stays untouched and refuses, because it may hold foreign content.
    /// When it clears the leaf, it replaces `resolved` with a fresh resolution of the absent
    /// destination so the caller can publish through its retained parent.
    pub(crate) fn adopt_catalog_archive_with_probe(
        &mut self,
        destination: &PathRef,
        resolved: &mut ResolvedPath,
        executable: &str,
        probe: &mut EngineRootProbe,
    ) -> Result<bool, Error> {
        if !self.confirm_catalog_archive_adoption_with_probe(destination, resolved, probe)? {
            return Ok(false);
        }
        let path = resolved.target().ok_or_else(invalid_record)?;
        let leaf = path.file_name().ok_or_else(invalid_record)?.to_os_string();
        let mut components = vec![leaf.to_os_string()];
        components.extend(engine_relative_components(executable)?);
        match self.resolve_with_engine_probe(
            destination,
            PathOperation::EngineInstall,
            &components,
            probe,
        ) {
            Ok(found) if found.is_regular_file() => return Ok(true),
            Ok(_) => {}
            // Same preservation as publication confirmation: only these outcomes outrank the refusal.
            Err(error)
                if error.root_failure().is_some()
                    || matches!(
                        error.unlabelled(),
                        Error::ResourceLimit(_) | Error::CommittedDurabilityUncertain(_)
                    ) =>
            {
                return Err(error);
            }
            Err(error) => log::warn!(
                "catalog archive executable could not be confirmed: {}",
                error.diagnostic()
            ),
        }
        let root = self.catalog_destination_root(destination, path)?;
        let directory = probe.filesystem(engine_install_directory(&root))?;
        let Some(identity) = probe.filesystem(catalog_directory_identity(&directory, &leaf))?
        else {
            return Ok(false);
        };
        let empty = {
            let tree = probe
                .filesystem(open_removal_directory_at(&directory, &leaf, identity))?
                .into_file();
            probe
                .filesystem(read_directory_entries_at(
                    &tree,
                    &CancellationToken::new(),
                    Some(MAX_INVENTORY_ENTRIES),
                    &mut |_| true,
                ))?
                .is_empty()
        };
        if !empty {
            return Err(Error::Conflict(
                "archive destination does not contain the expected engine".into(),
            ));
        }
        resolved.release_directory();
        probe.filesystem(crate::infra::fs::remove_empty_directory_at(
            &directory, &leaf, identity,
        ))?;
        let cleared = self.resolve_with_engine_probe(
            destination,
            PathOperation::DownloadArchive,
            std::slice::from_ref(&leaf),
            probe,
        )?;
        *resolved = cleared;
        Ok(false)
    }

    /// Retain the root during the existing precheck, without consuming the terminal resolver's
    /// one-shot boundary. The post-resolution handoff must use this same native directory.
    pub(super) fn prepare_catalog_engine_registration(
        &mut self,
        root: &EngineRootHandle,
        components: &[OsString],
        probe: &mut EngineRootProbe,
    ) -> Result<(StoredEntry, PathBuf, fs::File), Error> {
        let stored = self
            .persistent
            .get(&root.id.id)
            .ok_or_else(invalid_record)?
            .stored
            .clone();
        let path = stored
            .path
            .to_path()?
            .join(components.first().ok_or_else(invalid_record)?);
        let stored = self.catalog_destination_root(root.path_ref(), &path)?;
        if !is_engine_root_use(&stored, PathOperation::EngineInstall) {
            return Err(invalid_record());
        }
        let directory = probe.filesystem(engine_install_directory(&stored))?;
        self.confirm_catalog_engine_registration(&stored, &path, &directory, None, probe)?;
        Ok((stored, path, directory))
    }

    pub(super) fn confirm_catalog_engine_registration(
        &mut self,
        root: &StoredEntry,
        path: &Path,
        retained_root: &fs::File,
        retained_file: Option<(&Path, VerifiedIdentity)>,
        probe: &mut EngineRootProbe,
    ) -> Result<(), Error> {
        if let Some((target, identity)) = retained_file {
            let (a, b) = identity.pair();
            self.protect_catalog_path(target, false, false, Some(&Identity { a, b }))?;
        } else {
            self.protect_catalog_path(path, false, false, None)?;
        }
        if self.confirm_catalog_destination(
            root,
            path,
            Some(retained_root),
            retained_file,
            probe,
        )? {
            Ok(())
        } else {
            Err(Error::Conflict(
                "catalog publication could not be confirmed".into(),
            ))
        }
    }

    pub(super) fn catalog_admission_count(&self) -> usize {
        self.catalog_installs.len()
            + self.catalog_uses.len()
            + self.catalog_uses.values().map(BTreeMap::len).sum::<usize>()
            + self
                .catalog_installs
                .values()
                .map(|record| record.users.len())
                .sum::<usize>()
    }

    fn commit_catalog(&mut self, records: BTreeMap<String, CatalogInstall>) -> Result<(), Error> {
        self.commit_catalog_state(records, self.catalog_uses.clone(), false)
    }

    /// One atomic lifecycle candidate owns both scope uses and their derived install markers.
    fn commit_catalog_state(
        &mut self,
        records: BTreeMap<String, CatalogInstall>,
        uses: CatalogUses,
        clearing: bool,
    ) -> Result<(), Error> {
        // Capture admission before changing either state, including the first zero-install use.
        let baseline = self.registry_admission_snapshot(
            &self.persistent,
            &self.active_database_root,
            &self.active_puzzle_root,
            &self.active_engine_root,
            &self.pending_artifacts,
            &self.provisional_attachments,
            &self.retired_attachments,
            &self.image_cleanup,
        )?;
        validate_records(&records)?;
        validate_uses(&uses)?;
        let previous = std::mem::replace(&mut self.catalog_installs, records);
        let previous_uses = std::mem::replace(&mut self.catalog_uses, uses);
        let result = self.commit_candidate_with_pending_baseline(
            self.persistent.clone(),
            self.pending_artifacts.clone(),
            None,
            Some(baseline),
        );
        match result {
            Ok(durability) => {
                if clearing && !matches!(durability, CommitDurability::Durable) {
                    // Unconfirmed clear is never positive in-memory evidence of child exit.
                    self.catalog_installs = previous;
                    self.catalog_uses = previous_uses;
                }
                self.catalog_protected
                    .retain(|id| self.catalog_installs.contains_key(id));
                require_durable(durability)
            }
            Err(error) => {
                self.catalog_installs = previous;
                self.catalog_uses = previous_uses;
                Err(error)
            }
        }
    }

    pub(super) fn protect_catalog_path(
        &mut self,
        path: &Path,
        recursive: bool,
        child_use: bool,
        bound_identity: Option<&Identity>,
    ) -> Result<(), Error> {
        self.protect_catalog_contexts(&[(path, recursive, bound_identity.cloned())], child_use)
    }

    pub(super) fn protect_catalog_contexts(
        &mut self,
        contexts: &[(&Path, bool, Option<Identity>)],
        child_use: bool,
    ) -> Result<(), Error> {
        let mut affected = BTreeSet::new();
        for (id, record) in &self.catalog_installs {
            for (path, recursive, binding) in contexts {
                let relation = reaches(record, path, *recursive, binding.as_ref())?;
                if record.cleaning && relation == Reachability::Member {
                    return Err(Error::Conflict(
                        "catalog install cleanup is in progress".into(),
                    ));
                }
                if relation.protects() {
                    affected.insert(id.clone());
                }
            }
        }
        if child_use {
            let mut uses = self.catalog_uses.clone();
            for (path, recursive, binding) in contexts {
                let binding = binding.as_ref().ok_or_else(|| {
                    Error::Conflict("resolved child use has no terminal binding".into())
                })?;
                let scope = uses
                    .entry((path.to_path_buf(), binding.a, binding.b))
                    .or_default()
                    .entry(self.catalog_session.clone())
                    .or_default();
                *scope |= *recursive;
            }
            let mut records = self.catalog_installs.clone();
            for id in &affected {
                records
                    .get_mut(id)
                    .ok_or_else(invalid_record)?
                    .users
                    .insert(self.catalog_session.clone());
            }
            if uses != self.catalog_uses
                || records != self.catalog_installs
                || self.registry_durability_pending
            {
                self.commit_catalog_state(records, uses, false)?;
            }
        } else if !affected.is_empty() && self.registry_durability_pending {
            self.retry_registry_durability()?;
        }
        self.catalog_protected.extend(affected);
        Ok(())
    }

    /// Called under authority serialization on the existing blocking worker.
    #[cfg(test)]
    pub(crate) fn publish_catalog_install(
        &mut self,
        destination: &PathRef,
        resolved: &ResolvedPath,
        staging: &mut crate::infra::fs::OwnedStagingDir,
    ) -> Result<(), Error> {
        self.publish_catalog_install_with_probe(
            destination,
            resolved,
            staging,
            &mut EngineRootProbe::default(),
        )
    }

    pub(crate) fn publish_catalog_install_with_probe(
        &mut self,
        destination: &PathRef,
        resolved: &ResolvedPath,
        staging: &mut crate::infra::fs::OwnedStagingDir,
        probe: &mut EngineRootProbe,
    ) -> Result<(), Error> {
        let path = resolved.target().ok_or_else(invalid_record)?;
        if self.confirm_catalog_archive_adoption_with_probe(destination, resolved, probe)? {
            return Err(Error::Conflict(
                "directory target was created concurrently".into(),
            ));
        }
        let root = self.catalog_destination_root(destination, path)?;
        if probe.filesystem(staging.parent_identity())? != (root.identity.a, root.identity.b) {
            return Err(Error::InvalidInput(
                "catalog staging must share the destination parent".into(),
            ));
        }
        let root_directory = probe.filesystem(engine_install_directory(&root))?;
        let (source_parent, source_leaf, (a, b)) = staging.binding();
        probe.filesystem(assert_entry_identity(
            source_parent,
            source_leaf,
            (a, b),
            true,
        ))?;
        let identity = Identity { a, b };
        let directory = staging.directory()?;
        let mut record = CatalogInstall {
            root: root.clone(),
            destination: NativePath::from_path(Path::new(
                path.file_name().ok_or_else(invalid_record)?,
            )),
            inventory: inventory(directory, identity.a)?,
            publication: Some(Publication::Pending),
            identity: identity.clone(),
            cleaning: false,
            preserved: false,
            users: BTreeSet::new(),
        };
        // A recursive resource may have been handed to a child before provenance existed.
        for ((used, a, b), sessions) in &self.catalog_uses {
            let binding = Identity { a: *a, b: *b };
            for (session, recursive) in sessions {
                if reaches(&record, used, *recursive, Some(&binding))?.protects() {
                    record.users.insert(session.clone());
                }
            }
        }
        let mut records = self.catalog_installs.clone();
        let mut replaced = Vec::new();
        for (id, existing) in &records {
            // A replacement root at this spelling is a different cleanup locator. Preserve its
            // predecessor's exact binding even if the native root entry has been retired.
            if existing.root.identity == record.root.identity
                && existing.destination == record.destination
            {
                replaced.push(id.clone());
            }
        }
        for id in replaced {
            let existing = records.remove(&id).ok_or_else(invalid_record)?;
            record.users.extend(existing.users);
        }
        let id = Uuid::new_v4().to_string();
        records.insert(id.clone(), record);
        self.commit_catalog(records)?;
        self.catalog_protected.insert(id.clone());
        probe.filesystem(assert_entry_identity(
            &root_directory,
            source_leaf,
            (identity.a, identity.b),
            true,
        ))?;
        probe.filesystem(resolved.atomic_install_download_dir(staging))?;
        self.confirm_catalog_install_with_probe(&id, Some(&root_directory), probe)?;
        if !self.confirm_catalog_destination(&root, path, Some(&root_directory), None, probe)? {
            return Err(Error::Conflict(
                "catalog publication could not be confirmed".into(),
            ));
        }
        Ok(())
    }

    /// The caller must first prove sealed admission, drained operations and successful reaping.
    pub(crate) fn clear_catalog_session_use(&mut self) -> Result<(), Error> {
        let mut records = self.catalog_installs.clone();
        for record in records.values_mut() {
            record.users.remove(&self.catalog_session);
        }
        let mut uses = self.catalog_uses.clone();
        for sessions in uses.values_mut() {
            sessions.remove(&self.catalog_session);
        }
        uses.retain(|_, sessions| !sessions.is_empty());
        self.commit_catalog_state(records, uses, true)
    }

    pub(crate) fn collect_catalog_installs(&mut self) -> Result<(), Error> {
        if !self
            .completed_owner_families
            .contains(&PathOwnerFamily::Engines)
        {
            return Ok(());
        }
        if self.registry_durability_pending {
            self.retry_registry_durability()?;
        }
        let mut failures = Vec::new();
        for id in self.catalog_installs.keys().cloned().collect::<Vec<_>>() {
            let record = self.catalog_installs[&id].clone();
            if self
                .completion_resources
                .values()
                .flatten()
                .any(|resource| {
                    self.persistent
                        .get(&resource.id)
                        .is_some_and(|entry| entry.stored == record.root)
                })
            {
                continue;
            }
            if !record.users.is_empty() {
                log::warn!(
                    "catalog install {id} retained for unresolved session use: {:?}",
                    record.users
                );
                continue;
            }
            if self.catalog_protected.contains(&id) {
                continue;
            }
            let mut live = false;
            'uses: for ((path, a, b), sessions) in &self.catalog_uses {
                let binding = Identity { a: *a, b: *b };
                for recursive in sessions.values() {
                    if reaches(&record, path, *recursive, Some(&binding))?.protects() {
                        live = true;
                        break 'uses;
                    }
                }
            }
            for entry in self
                .persistent
                .values()
                .chain(self.retired_attachments.values())
            {
                live |= entry_reaches(&record, &entry.stored)?.protects();
            }
            if live {
                continue;
            }
            if let Err(error) = self.collect_catalog_install(&id, &record) {
                log::warn!(
                    "catalog install {id} cleanup failed: {}",
                    error.diagnostic()
                );
                failures.push(error);
            }
        }
        failures.into_iter().next().map_or(Ok(()), Err)
    }

    fn forget_catalog_install(&mut self, id: &str) -> Result<(), Error> {
        let mut records = self.catalog_installs.clone();
        records.remove(id);
        self.commit_catalog(records)
    }

    fn collect_catalog_install(&mut self, id: &str, record: &CatalogInstall) -> Result<(), Error> {
        match self.confirm_catalog_install(id, None) {
            Ok(false) => return self.forget_catalog_install(id),
            Err(Error::Conflict(_)) => {
                log::warn!("catalog install {id} retained without confirmed publication");
                return Ok(());
            }
            Err(error) => return Err(error),
            Ok(true) => {}
        }
        let root = open_verified_directory(
            &record.root.path.to_path()?,
            (record.root.identity.a, record.root.identity.b),
        )?
        .into_file();
        let leaf = relative_path(&record.destination)?;
        let Some(identity) = catalog_directory_identity(&root, leaf.as_os_str())? else {
            return self.forget_catalog_install(id);
        };
        if identity != (record.identity.a, record.identity.b) {
            return self.forget_catalog_install(id);
        }
        if record.preserved {
            return Ok(());
        }
        let directory = open_removal_directory_at(&root, leaf.as_os_str(), identity)?.into_file();
        let observed = match inventory(&directory, record.root.identity.a) {
            Ok(entries) => entries,
            Err(Error::Conflict(_)) => return self.preserve_changed_catalog_install(id, record),
            Err(error) => return Err(error),
        };
        let matches = observed
            .iter()
            .all(|entry| record.inventory.contains(entry))
            && (record.cleaning || observed.len() == record.inventory.len());
        if !matches {
            log::info!("catalog install {id} relinquished after user modification");
            return self.preserve_changed_catalog_install(id, record);
        }
        if !record.cleaning {
            let mut records = self.catalog_installs.clone();
            records.get_mut(id).ok_or_else(invalid_record)?.cleaning = true;
            self.commit_catalog(records)?;
        }
        // Keep the complete original inventory through partial removal and uncertain parent sync.
        remove_entry_at(&root, leaf.as_os_str(), identity, true)?;
        self.forget_catalog_install(id)
    }

    fn preserve_changed_catalog_install(
        &mut self,
        id: &str,
        record: &CatalogInstall,
    ) -> Result<(), Error> {
        if !record.cleaning {
            return self.forget_catalog_install(id);
        }
        let mut records = self.catalog_installs.clone();
        records.get_mut(id).ok_or_else(invalid_record)?.preserved = true;
        self.commit_catalog(records)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::fs::{
        install_test_atomic_file_injector, set_test_atomic_dir_injector, AtomicDirFaultPoint,
        AtomicDirInjector, AtomicFileFaultPoint, AtomicWriterInjector, ParentSyncFault,
    };

    struct Fixture {
        temp: tempfile::TempDir,
        root: PathBuf,
        handle: EngineRootHandle,
        authority: PathAuthority,
    }

    #[test]
    fn reload_completion_retains_loaded_startup_capabilities_until_exact_release() {
        let mut f = Fixture::new();
        fs::write(f.root.join("old"), b"old engine").unwrap();
        fs::write(f.root.join("new"), b"new engine").unwrap();
        let old = f
            .authority
            .register_installed_engine_for_test(&f.handle, "old")
            .unwrap();
        let new = f
            .authority
            .register_installed_engine_for_test(&f.handle, "new")
            .unwrap();
        // A different selected root removes the independent active-root protection.
        select_unrelated_workspace_for_cleanup(&mut f);
        f.reopen();
        let resources = vec![old.id.clone(), new.id.clone()];
        for resource in &resources {
            assert!(f.authority.loaded_candidate_ids.contains(&resource.id));
            assert!(!f.authority.session_protected_ids.contains(&resource.id));
        }
        f.authority
            .retain_completion_resources("pending", resources.clone())
            .unwrap();
        f.reconcile(vec![], true).unwrap();
        // Use the same authority lookup and native target acquisition as execution, without
        // handing off a child or creating a second, session-owned resource lease.
        for (resource, expected) in [
            (&old.id, b"old engine".as_slice()),
            (&new.id, b"new engine".as_slice()),
        ] {
            let operation = PathOperation::EngineExecute;
            let entry = f.authority.persistent_entry_for(
                &FileWorkspaceHandle::new(resource.clone()), operation,
            ).expect("COMPLETION_RETAINS_LOADED_CAPABILITY: startup must keep each pending handle usable");
            let parent_access = parent_access_for_operations(&[operation]);
            let acquired = acquire_stored_target(
                &entry.stored,
                AcquireShape::File { parent_access },
                "retained completion target changed",
            )
            .unwrap();
            assert_eq!(fs::read(acquired.path).unwrap(), expected);
        }
        f.authority
            .release_completion_resources("another-operation");
        f.reconcile(vec![], true).unwrap();
        assert!(resources
            .iter()
            .all(|id| f.authority.persistent.contains_key(&id.id)));
        f.authority.release_completion_resources("pending");
        f.reconcile(vec![], true).unwrap();
        for resource in resources {
            assert!(
                f.authority
                    .persistent_entry_for(
                        &FileWorkspaceHandle::new(resource),
                        PathOperation::EngineExecute,
                    )
                    .is_err(),
                "released startup candidates must be collectible"
            );
        }
        assert!(!f.authority.persistent.contains_key(&old.id.id));
        assert!(!f.authority.persistent.contains_key(&new.id.id));
    }

    #[test]
    fn reload_completion_retains_otherwise_collectible_catalog_until_exact_release() {
        let mut f = Fixture::new();
        f.install("managed");
        // Reopen normally ends publication protection. Do not weaken catalog ownership.
        f.reopen();
        assert!(f.authority.catalog_protected.is_empty());
        assert!(f.authority.catalog_uses.is_empty());
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.is_empty()));
        f.authority
            .retain_completion_resources("pending", vec![f.handle.id.clone()])
            .unwrap();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(fs::read(f.root.join("managed/engine")).expect(
            "COMPLETION_RETAINS_CATALOG: pending completion must keep the managed executable usable",
        ), b"managed engine");
        assert_eq!(
            fs::read(f.root.join("managed/data/network")).unwrap(),
            b"managed network"
        );
        assert_eq!(f.authority.catalog_installs.len(), 1);
        f.authority
            .release_completion_resources("another-operation");
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("managed/engine").exists());
        f.authority.release_completion_resources("pending");
        f.reconcile(vec![], true).unwrap();
        assert!(!f.root.join("managed").exists());
        assert!(f.authority.catalog_installs.is_empty());
        assert!(
            f.authority.persistent.contains_key(&f.handle.id.id),
            "the selected root remains owned"
        );
    }

    struct StageFixture {
        path: PathBuf,
        owner: crate::infra::fs::OwnedStagingDir,
    }

    impl StageFixture {
        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let root = temp.path().join("engines");
            fs::create_dir(&root).unwrap();
            let mut authority =
                PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
            let handle = authority
                .get_or_create_engine_root(&root, "Engines", None)
                .unwrap();
            let root = authority.engine_root_path(&handle).unwrap();
            authority.set_active_engine_root(&handle).unwrap();
            Self {
                temp,
                root,
                handle,
                authority,
            }
        }

        fn reopen(&mut self) {
            self.authority =
                PathAuthority::open(self.temp.path().join("registry.json"), vec![]).unwrap();
        }

        fn stage(&self) -> StageFixture {
            let stage = tempfile::tempdir_in(&self.root).unwrap();
            fs::write(stage.path().join("engine"), b"managed engine").unwrap();
            fs::create_dir(stage.path().join("data")).unwrap();
            fs::write(stage.path().join("data/network"), b"managed network").unwrap();
            let owner = crate::infra::fs::OwnedStagingDir::adopt(&stage).unwrap();
            StageFixture {
                path: stage.keep(),
                owner,
            }
        }

        fn publish_stage(&mut self, name: &str, stage: &mut StageFixture) -> Result<(), Error> {
            let resolved = self.authority.resolve(
                self.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from(name)],
            )?;
            self.authority.publish_catalog_install(
                self.handle.path_ref(),
                &resolved,
                &mut stage.owner,
            )
        }

        fn install(&mut self, name: &str) {
            let mut stage = self.stage();
            self.publish_stage(name, &mut stage).unwrap();
        }

        fn pending_install(&mut self, name: &str) {
            let mut stage = self.stage();
            set_test_atomic_dir_injector(Some(Box::new(DirFault(AtomicDirFaultPoint::ParentSync))));
            let result = self.publish_stage(name, &mut stage);
            set_test_atomic_dir_injector(None);
            drop(stage);
            assert!(matches!(
                result,
                Err(Error::CommittedDurabilityUncertain(_))
            ));
        }

        fn pending_wrong_kind(&mut self) -> CatalogInstall {
            self.pending_install("managed");
            fs::rename(self.root.join("managed"), self.root.join("original")).unwrap();
            fs::write(self.root.join("managed"), b"unconfirmed file").unwrap();
            self.authority
                .catalog_installs
                .values()
                .next()
                .unwrap()
                .clone()
        }

        fn adopt(&mut self, name: &str) -> Result<bool, Error> {
            let resolved = self.authority.resolve(
                self.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from(name)],
            )?;
            self.authority
                .confirm_catalog_archive_adoption(self.handle.path_ref(), &resolved)
        }

        fn adopt_archive(&mut self, name: &str, executable: &str) -> Result<bool, Error> {
            let mut resolved = self.authority.resolve(
                self.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from(name)],
            )?;
            self.authority.adopt_catalog_archive_with_probe(
                self.handle.path_ref(),
                &mut resolved,
                executable,
                &mut EngineRootProbe::default(),
            )
        }

        fn engine(&mut self, name: &str) -> EngineHandle {
            self.authority
                .register_installed_engine_for_test(&self.handle, &format!("{name}/engine"))
                .unwrap()
        }

        fn reconcile(&mut self, retained_ids: Vec<PathRef>, trusted: bool) -> Result<(), Error> {
            require_durable(self.authority.reconcile_startup_owners(StartupPathOwners {
                retained_ids,
                trusted_families: if trusted {
                    vec![PathOwnerFamily::Engines]
                } else {
                    vec![]
                },
            })?)?;
            self.authority.collect_catalog_installs()
        }

        fn resource(&mut self, path: &Path, directory: bool) -> EngineResourceHandle {
            let kind = if directory {
                EngineResourceHandleKind::Directory
            } else {
                EngineResourceHandleKind::File
            };
            let grant = self
                .authority
                .grant_dialog(
                    path,
                    "Resource",
                    PathClass::BoundedDialogGrant,
                    PathOperation::EngineResourceRead,
                    Duration::from_secs(30),
                    2,
                )
                .unwrap();
            self.authority
                .promote_engine_resource(&grant, kind, "Resource")
                .unwrap()
        }
    }

    #[cfg(target_os = "linux")]
    async fn finish_session(authority: PathAuthority) {
        let authority = SharedPathAuthority::installed(authority);
        let supervisor = crate::engine::EngineSupervisor::default();
        let games = crate::game::GameManager::new();
        let operations = crate::infra::operations::OperationRegistry::default();
        assert!(
            crate::shutdown_with_catalog_authority(
                crate::shutdown_backend_with_attachments(
                    &supervisor,
                    &games,
                    None,
                    &operations,
                    std::future::ready(Ok(())),
                    std::future::ready(Ok(())),
                    Duration::from_secs(20),
                ),
                authority.clone(),
                Duration::from_secs(20),
            )
            .await
        );
    }

    struct FileFault(AtomicFileFaultPoint);
    impl AtomicWriterInjector for FileFault {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == self.0 {
                Err(std::io::Error::other("catalog registry fault"))
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn archive_adoption_requires_the_executable_of_a_published_tree() {
        let mut f = Fixture::new();
        f.install("managed");
        assert!(f.adopt_archive("managed", "engine").unwrap());
        assert!(!f.adopt_archive("missing", "engine").unwrap());
        assert!(matches!(
            f.adopt_archive("managed", "absent"),
            Err(Error::Conflict(_))
        ));
        assert_eq!(
            fs::read(f.root.join("managed/engine")).unwrap(),
            b"managed engine"
        );
        assert!(matches!(
            f.adopt_archive("managed", "data"),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            f.adopt_archive("managed", "engine/child"),
            Err(Error::Conflict(_))
        ));
        assert_eq!(
            fs::read(f.root.join("managed/engine")).unwrap(),
            b"managed engine"
        );
    }

    #[test]
    fn archive_adoption_clears_an_emptied_published_tree() {
        let mut f = Fixture::new();
        f.install("managed");
        fs::remove_file(f.root.join("managed/engine")).unwrap();
        fs::remove_dir_all(f.root.join("managed/data")).unwrap();
        assert!(!f.adopt_archive("managed", "engine").unwrap());
        assert!(!f.root.join("managed").exists());
        let mut stage = f.stage();
        f.publish_stage("managed", &mut stage).unwrap();
        assert_eq!(
            fs::read(f.root.join("managed/engine")).unwrap(),
            b"managed engine"
        );
        assert_eq!(f.authority.catalog_installs.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn archive_adoption_refuses_a_symlinked_executable() {
        let mut f = Fixture::new();
        let directory = f.root.join("engine.tar.gz-digest");
        fs::create_dir(&directory).unwrap();
        fs::write(f.root.join("foreign-engine"), b"foreign engine").unwrap();
        let executable = directory.join("engine");
        std::os::unix::fs::symlink(f.root.join("foreign-engine"), &executable).unwrap();
        assert!(matches!(
            f.adopt_archive("engine.tar.gz-digest", "engine"),
            Err(Error::Conflict(_))
        ));
        assert!(fs::symlink_metadata(&executable)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn catalog_install_r12_native_adoption_categories() {
        let mut f = Fixture::new();
        assert!(!f.adopt("missing").unwrap());
        fs::create_dir(f.root.join("directory")).unwrap();
        fs::write(f.root.join("directory/foreign"), b"legacy contents").unwrap();
        assert!(f.adopt("directory").unwrap());
        // Resolve before interference so these cases reach the real adoption/publication
        // consumer rather than the resolver's independent link refusal.
        let regular = f
            .authority
            .resolve(
                f.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from("regular")],
            )
            .unwrap();
        let link = f
            .authority
            .resolve(
                f.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from("link")],
            )
            .unwrap();
        fs::write(f.root.join("regular"), b"regular file").unwrap();
        assert!(matches!(
            f.authority
                .confirm_catalog_archive_adoption(f.handle.path_ref(), &regular),
            Err(Error::Conflict(_))
        ));
        #[cfg(unix)]
        std::os::unix::fs::symlink(f.root.join("directory"), f.root.join("link")).unwrap();
        #[cfg(windows)]
        crate::infra::fs::windows_test_junction(&f.root.join("link"), &f.root.join("directory"));
        assert!(matches!(
            f.authority
                .confirm_catalog_archive_adoption(f.handle.path_ref(), &link),
            Err(Error::Conflict(_))
        ));
        for resolved in [&regular, &link] {
            let mut stage = f.stage();
            assert!(matches!(
                f.authority.publish_catalog_install(
                    f.handle.path_ref(),
                    resolved,
                    &mut stage.owner
                ),
                Err(Error::Conflict(_))
            ));
        }
        assert_eq!(
            fs::read(f.root.join("directory/foreign")).unwrap(),
            b"legacy contents"
        );
        assert!(
            f.authority.catalog_installs.is_empty(),
            "legacy adoption must not mint provenance"
        );
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_r12_pending_file_alias_refuses_registration() {
        let mut f = Fixture::new();
        f.pending_install("managed");
        fs::rename(f.root.join("managed"), f.root.join("original")).unwrap();
        fs::write(f.root.join("managed"), b"unconfirmed file").unwrap();
        fs::hard_link(f.root.join("managed"), f.root.join("alias-engine")).unwrap();
        fs::write(f.root.join("independent-engine"), b"independent file").unwrap();
        let alias = f
            .authority
            .register_installed_engine_for_test(&f.handle, "alias-engine");
        let independent = f
            .authority
            .register_installed_engine_for_test(&f.handle, "independent-engine");
        let original = fs::read(f.root.join("original/engine"));
        let alias_bytes = fs::read(f.root.join("alias-engine"));
        let target_bytes = fs::read(f.root.join("managed"));
        let pending = f.authority.catalog_installs.len() == 1
            && f.authority
                .catalog_installs
                .values()
                .all(|record| record.publication == Some(Publication::Pending));
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        temp.close().unwrap();
        assert!(matches!(alias, Err(Error::Conflict(_))),
            "PENDING_NATIVE_FILE_ALIAS_MUST_REFUSE: a native alias of the known pending wrong-kind target must not mint a handle: {alias:?}");
        assert!(
            independent.is_ok(),
            "unrelated native file registration must remain available: {independent:?}"
        );
        assert!(pending);
        assert_eq!(original.unwrap(), b"managed engine");
        assert_eq!(alias_bytes.unwrap(), b"unconfirmed file");
        assert_eq!(target_bytes.unwrap(), b"unconfirmed file");
    }

    struct RegistrationHookCleanup;

    impl Drop for RegistrationHookCleanup {
        fn drop(&mut self) {
            RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow_mut().take());
            INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow_mut().take());
        }
    }

    fn registration_directory_substitution(
        alias: PathBuf,
        independent_original: PathBuf,
        managed: PathBuf,
        swaps: std::rc::Rc<std::cell::RefCell<Vec<std::io::Result<()>>>>,
    ) -> Box<dyn FnOnce()> {
        Box::new(move || {
            let first = fs::rename(&alias, independent_original);
            let moved = first.is_ok();
            swaps.borrow_mut().push(first);
            if moved {
                swaps.borrow_mut().push(fs::rename(managed, alias));
            }
        })
    }

    fn pending_registration_evidence(
        records: &BTreeMap<String, CatalogInstall>,
        original: &CatalogInstall,
    ) -> bool {
        records.len() == 1
            && records.values().all(|record| {
                record.publication == Some(Publication::Pending)
                    && !record.cleaning
                    && !record.preserved
                    && record.root == original.root
                    && record.destination == original.destination
                    && record.identity == original.identity
                    && record.inventory == original.inventory
                    && record.users.is_superset(&original.users)
            })
    }

    #[test]
    fn catalog_install_r15_registration_keeps_held_root_without_records() {
        registration_keeps_held_root(false);
    }

    #[test]
    fn catalog_install_r15_registration_keeps_held_root_with_pending_record() {
        registration_keeps_held_root(true);
    }

    fn registration_keeps_held_root(with_pending: bool) {
        use std::{cell::RefCell, rc::Rc};

        let mut f = Fixture::new();
        let original_record = with_pending.then(|| f.pending_wrong_kind());
        fs::write(f.root.join("independent"), b"independent held engine").unwrap();
        let expected_file = identity(&f.root.join("independent")).unwrap();
        let expected_parent = identity(&f.root).unwrap();
        let moved_root = f.temp.path().join("moved-root");
        let hook_root = f.root.clone();
        let hook_moved = moved_root.clone();
        let swaps = Rc::new(RefCell::new(Vec::new()));
        let hook_swaps = swaps.clone();
        let cleanup = RegistrationHookCleanup;
        INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    hook_swaps
                        .borrow_mut()
                        .push(fs::rename(hook_root, hook_moved));
                })))
                .is_none());
        });
        let result = f
            .authority
            .register_installed_engine_for_test(&f.handle, "independent");
        drop(cleanup);
        let moved = swaps.borrow().first().is_some_and(Result::is_ok);
        let actual_root = if moved { &moved_root } else { &f.root };
        let bytes = fs::read(actual_root.join("independent")).unwrap();
        let original_bytes = original_record.as_ref().map(|_| {
            (
                fs::read(actual_root.join("original/engine")).unwrap(),
                fs::read(actual_root.join("original/data/network")).unwrap(),
                fs::read(actual_root.join("managed")).unwrap(),
            )
        });
        let stored = result
            .as_ref()
            .ok()
            .and_then(|handle| f.authority.persistent.get(&handle.path_ref().id))
            .map(|entry| {
                (
                    entry.stored.identity.clone(),
                    entry.stored.parent_identity.clone(),
                )
            });
        let later_use = result.as_ref().ok().map(|handle| {
            f.authority
                .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
                .map(|_| ())
        });
        let evidence = original_record.as_ref().map_or_else(
            || f.authority.catalog_installs.is_empty(),
            |record| pending_registration_evidence(&f.authority.catalog_installs, record),
        );
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        let mut reopened = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let durable_stored = result
            .as_ref()
            .ok()
            .and_then(|handle| reopened.persistent.get(&handle.path_ref().id))
            .map(|entry| {
                (
                    entry.stored.identity.clone(),
                    entry.stored.parent_identity.clone(),
                )
            });
        let durable_use = result.as_ref().ok().map(|handle| {
            reopened
                .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
                .map(|_| ())
        });
        let durable_evidence = original_record.as_ref().map_or_else(
            || reopened.catalog_installs.is_empty(),
            |record| pending_registration_evidence(&reopened.catalog_installs, record),
        );
        drop(reopened);
        let temp_path = temp.path().to_path_buf();
        temp.close().unwrap();
        let hooks_empty = INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow().is_none())
            && RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow().is_none());
        eprintln!("REGISTRATION_HELD_ROOT_NATIVE: pending={with_pending}, swaps={:?}, result={result:?}, expected={expected_file:?}/{expected_parent:?}, stored={stored:?}/{durable_stored:?}, use={later_use:?}/{durable_use:?}, evidence={evidence}/{durable_evidence}, hooks_empty={hooks_empty}, removed={}", swaps.borrow(), !temp_path.exists());
        assert!(hooks_empty && !temp_path.exists());
        assert_eq!(swaps.borrow().len(), 1);
        assert!(evidence && durable_evidence);
        assert_eq!(bytes, b"independent held engine");
        if let Some((engine, network, pending)) = original_bytes {
            assert_eq!(engine, b"managed engine");
            assert_eq!(network, b"managed network");
            assert_eq!(pending, b"unconfirmed file");
        }
        if !moved {
            let code = swaps.borrow()[0].as_ref().unwrap_err().raw_os_error();
            assert!(
                cfg!(windows) && matches!(code, Some(5 | 32)),
                "actual native root-rename refusal: {:?}",
                swaps.borrow()
            );
        }
        assert!(result.is_ok(), "REGISTRATION_HELD_ROOT_SUCCESS: retain independent file/parent authorization after root rename, pending={with_pending}, actual={result:?}");
        let expected = Some((expected_file, Some(expected_parent)));
        assert_eq!(stored, expected);
        assert_eq!(durable_stored, expected);
        if moved {
            assert!(
                matches!(later_use, Some(Err(_))),
                "unavailable locator use: {later_use:?}"
            );
            assert!(
                matches!(durable_use, Some(Err(_))),
                "unavailable locator reload: {durable_use:?}"
            );
        } else {
            assert!(matches!(later_use, Some(Ok(()))));
            assert!(matches!(durable_use, Some(Ok(()))));
        }
    }

    #[test]
    fn catalog_install_r14_registration_keeps_independent_held_file_after_tree_swap() {
        use std::{cell::RefCell, rc::Rc};

        let mut f = Fixture::new();
        f.pending_install("managed");
        let original_record = f
            .authority
            .catalog_installs
            .values()
            .next()
            .unwrap()
            .clone();
        let managed = f.root.join("managed");
        let alias = f.root.join("alias-dir");
        let independent_original = f.root.join("independent-original");
        fs::create_dir(managed.join("extra")).unwrap();
        fs::write(managed.join("extra/added"), b"pending user executable").unwrap();
        fs::create_dir_all(alias.join("extra")).unwrap();
        fs::write(alias.join("extra/added"), b"independent good executable").unwrap();
        let good_identity = identity(&alias.join("extra/added")).unwrap();
        let bad_identity = identity(&managed.join("extra/added")).unwrap();
        let swaps = Rc::new(RefCell::new(Vec::new()));
        let cleanup = RegistrationHookCleanup;
        INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(registration_directory_substitution(
                    alias.clone(),
                    independent_original,
                    managed,
                    swaps.clone(),
                )))
                .is_none());
        });
        let result = f
            .authority
            .register_installed_engine_for_test(&f.handle, "alias-dir/extra/added");
        drop(cleanup);
        let first_moved = swaps.borrow().first().is_some_and(Result::is_ok);
        let completed = swaps.borrow().len() == 2 && swaps.borrow().iter().all(Result::is_ok);
        let good_path = if first_moved {
            f.root.join("independent-original")
        } else {
            alias.clone()
        };
        let pending_path = if completed {
            alias.clone()
        } else {
            f.root.join("managed")
        };
        let stored_identity = result.as_ref().ok().map(|handle| {
            f.authority.persistent[&handle.path_ref().id]
                .stored
                .identity
                .clone()
        });
        let later_use = result.as_ref().ok().map(|handle| {
            f.authority
                .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
                .map(|_| ())
        });
        let pending =
            pending_registration_evidence(&f.authority.catalog_installs, &original_record);
        let no_bad_capability = f
            .authority
            .persistent
            .values()
            .all(|entry| entry.stored.identity != bad_identity);
        let good_bytes = fs::read(good_path.join("extra/added")).unwrap();
        let pending_bytes = fs::read(pending_path.join("extra/added")).unwrap();
        let original_engine = fs::read(pending_path.join("engine")).unwrap();
        let original_network = fs::read(pending_path.join("data/network")).unwrap();
        let locator_bytes = fs::read(alias.join("extra/added"));
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        let mut reopened = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let durable_identity = result.as_ref().ok().map(|handle| {
            reopened.persistent[&handle.path_ref().id]
                .stored
                .identity
                .clone()
        });
        let durable_use = result.as_ref().ok().map(|handle| {
            reopened
                .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
                .map(|_| ())
        });
        let durable_pending =
            pending_registration_evidence(&reopened.catalog_installs, &original_record);
        let durable_no_bad = reopened
            .persistent
            .values()
            .all(|entry| entry.stored.identity != bad_identity);
        drop(reopened);
        let temp_path = temp.path().to_path_buf();
        temp.close().unwrap();
        let hooks_empty = RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow().is_none())
            && INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow().is_none());
        eprintln!("REGISTRATION_TREE_BOUND_CONTROL: swaps={:?}, completed={completed}, result={result:?}, held={good_identity:?}, stored={stored_identity:?}/{durable_identity:?}, use={later_use:?}/{durable_use:?}, pending={pending}/{durable_pending}, no_bad={no_bad_capability}/{durable_no_bad}, hooks_empty={hooks_empty}, removed={}", swaps.borrow(), !temp_path.exists());
        assert!(hooks_empty && !temp_path.exists());
        assert!(pending && durable_pending && no_bad_capability && durable_no_bad);
        assert_eq!(good_bytes, b"independent good executable");
        assert_eq!(pending_bytes, b"pending user executable");
        assert_eq!(original_engine, b"managed engine");
        assert_eq!(original_network, b"managed network");
        assert!(result.is_ok(), "REGISTRATION_TREE_HELD_INDEPENDENT_SUCCESS: register the original independent held file after a tree replaces its locator: {result:?}");
        assert_eq!(stored_identity, Some(good_identity.clone()));
        assert_eq!(durable_identity, Some(good_identity));
        if completed {
            assert_eq!(swaps.borrow().len(), 2);
            assert_eq!(locator_bytes.unwrap(), b"pending user executable");
            assert!(
                matches!(later_use, Some(Err(Error::Conflict(_)))),
                "changed locator use: {later_use:?}"
            );
            assert!(
                matches!(durable_use, Some(Err(Error::Conflict(_)))),
                "changed locator reload use: {durable_use:?}"
            );
        } else {
            assert!(
                cfg!(windows) && swaps.borrow().iter().any(Result::is_err),
                "native tree swaps must complete on this platform: {:?}",
                swaps.borrow()
            );
            for swap in swaps
                .borrow()
                .iter()
                .filter_map(|result| result.as_ref().err())
            {
                assert!(
                    matches!(swap.raw_os_error(), Some(5 | 32)),
                    "actual native refusal: {swap}"
                );
            }
            if first_moved {
                assert!(matches!(later_use, Some(Err(_))));
                assert!(matches!(durable_use, Some(Err(_))));
                assert!(locator_bytes.is_err());
            } else {
                assert_eq!(swaps.borrow().len(), 1);
                assert_eq!(locator_bytes.unwrap(), b"independent good executable");
                assert!(matches!(later_use, Some(Ok(()))));
                assert!(matches!(durable_use, Some(Ok(()))));
            }
        }
    }

    #[test]
    fn catalog_install_r14_registration_refuses_added_member_of_moved_pending_tree() {
        use std::{cell::RefCell, rc::Rc};

        let mut f = Fixture::new();
        f.pending_install("managed");
        let original_record = f
            .authority
            .catalog_installs
            .values()
            .next()
            .unwrap()
            .clone();
        let managed = f.root.join("managed");
        let alias = f.root.join("alias-dir");
        let independent_original = f.root.join("independent-original");
        fs::create_dir(managed.join("extra")).unwrap();
        fs::write(managed.join("extra/added"), b"user added executable").unwrap();
        #[cfg(unix)]
        let permissions_before = {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                managed.join("extra/added"),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
            fs::metadata(managed.join("extra/added"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        let added_identity = identity(&managed.join("extra/added")).unwrap();
        let absent_from_inventory = original_record
            .inventory
            .iter()
            .all(|entry| entry.identity != added_identity);
        fs::create_dir_all(alias.join("extra")).unwrap();
        fs::write(alias.join("extra/added"), b"independent executable").unwrap();
        let swaps = Rc::new(RefCell::new(Vec::new()));
        let cleanup = RegistrationHookCleanup;
        RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(registration_directory_substitution(
                    alias.clone(),
                    independent_original,
                    managed,
                    swaps.clone(),
                )))
                .is_none());
        });
        let result = f
            .authority
            .register_installed_engine_for_test(&f.handle, "alias-dir/extra/added");
        drop(cleanup);
        let stored_identity = result.as_ref().ok().map(|handle| {
            f.authority.persistent[&handle.path_ref().id]
                .stored
                .identity
                .clone()
        });
        let native_identity = identity(&alias.join("extra/added"));
        let no_added_capability = f
            .authority
            .persistent
            .values()
            .all(|entry| entry.stored.identity != added_identity);
        let pending =
            pending_registration_evidence(&f.authority.catalog_installs, &original_record);
        let original_engine = fs::read(alias.join("engine"));
        let original_network = fs::read(alias.join("data/network"));
        let added_bytes = fs::read(alias.join("extra/added"));
        let independent_bytes = fs::read(f.root.join("independent-original/extra/added"));
        #[cfg(unix)]
        let permissions_after = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(alias.join("extra/added"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        let reopened = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let durable_pending =
            pending_registration_evidence(&reopened.catalog_installs, &original_record);
        let durable_no_added = reopened
            .persistent
            .values()
            .all(|entry| entry.stored.identity != added_identity);
        drop(reopened);
        let temp_path = temp.path().to_path_buf();
        temp.close().unwrap();
        let hooks_empty = RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow().is_none())
            && INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow().is_none());
        eprintln!("REGISTRATION_ADDED_MEMBER_NATIVE: swaps={:?}, result={result:?}, expected={added_identity:?}, native={native_identity:?}, stored={stored_identity:?}, inventory_absent={absent_from_inventory}, pending={pending}/{durable_pending}, no_added={no_added_capability}/{durable_no_added}, hooks_empty={hooks_empty}, removed={}", swaps.borrow(), !temp_path.exists());
        #[cfg(unix)]
        eprintln!("REGISTRATION_ADDED_MEMBER_PERMISSIONS: before={permissions_before:o}, after={permissions_after:o}");
        assert!(hooks_empty && !temp_path.exists());
        assert_eq!(swaps.borrow().len(), 2);
        assert!(
            swaps.borrow().iter().all(Result::is_ok),
            "native moves: {:?}",
            swaps.borrow()
        );
        assert!(absent_from_inventory && pending && durable_pending);
        assert_eq!(native_identity.unwrap(), added_identity);
        assert_eq!(original_engine.unwrap(), b"managed engine");
        assert_eq!(original_network.unwrap(), b"managed network");
        assert_eq!(added_bytes.unwrap(), b"user added executable");
        assert_eq!(independent_bytes.unwrap(), b"independent executable");
        assert!(matches!(result, Err(Error::Conflict(_))), "REGISTRATION_ADDED_MEMBER_PENDING_REFUSAL: refuse the captured added descendant of the moved pending tree: {result:?}, stored={stored_identity:?}");
        assert!(no_added_capability && durable_no_added);
        #[cfg(unix)]
        assert_eq!(
            permissions_before, permissions_after,
            "added member permissions must be preserved"
        );
    }

    #[test]
    fn catalog_install_r13_registration_refuses_pending_moved_tree() {
        use std::{cell::RefCell, rc::Rc};

        let mut f = Fixture::new();
        f.pending_install("managed");
        let original_record = f
            .authority
            .catalog_installs
            .values()
            .next()
            .unwrap()
            .clone();
        let managed = f.root.join("managed");
        let alias = f.root.join("alias-dir");
        let independent_original = f.root.join("independent-original");
        fs::create_dir(&alias).unwrap();
        fs::write(alias.join("engine"), b"independent engine").unwrap();
        let managed_identity = identity(&managed.join("engine")).unwrap();
        let swaps = Rc::new(RefCell::new(Vec::new()));
        let cleanup = RegistrationHookCleanup;
        RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(registration_directory_substitution(
                    alias.clone(),
                    independent_original,
                    managed,
                    swaps.clone(),
                )))
                .is_none());
        });
        let result = f
            .authority
            .register_installed_engine_for_test(&f.handle, "alias-dir/engine");
        drop(cleanup);
        let stored_identity = result.as_ref().ok().map(|handle| {
            f.authority.persistent[&handle.path_ref().id]
                .stored
                .identity
                .clone()
        });
        let native_identity = identity(&alias.join("engine"));
        let no_managed_capability = f
            .authority
            .persistent
            .values()
            .all(|entry| entry.stored.identity != managed_identity);
        let pending =
            pending_registration_evidence(&f.authority.catalog_installs, &original_record);
        let engine_bytes = fs::read(alias.join("engine"));
        let network_bytes = fs::read(alias.join("data/network"));
        let independent_bytes = fs::read(f.root.join("independent-original/engine"));
        let old_destination_absent = !f.root.join("managed").exists();
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        let reopened = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let durable_pending =
            pending_registration_evidence(&reopened.catalog_installs, &original_record);
        let durable_no_managed = reopened
            .persistent
            .values()
            .all(|entry| entry.stored.identity != managed_identity);
        drop(reopened);
        let temp_path = temp.path().to_path_buf();
        temp.close().unwrap();
        let hooks_empty = RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow().is_none())
            && INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow().is_none());
        eprintln!("REGISTRATION_MOVED_TREE_NATIVE: swaps={:?}, result={result:?}, expected={managed_identity:?}, native={native_identity:?}, stored={stored_identity:?}, pending={pending}/{durable_pending}, no_managed={no_managed_capability}/{durable_no_managed}, engine={engine_bytes:?}, network={network_bytes:?}, independent={independent_bytes:?}, old_destination_absent={old_destination_absent}, hooks_empty={hooks_empty}, removed={}", swaps.borrow(), !temp_path.exists());
        assert!(hooks_empty && !temp_path.exists());
        assert_eq!(swaps.borrow().len(), 2);
        assert!(
            swaps.borrow().iter().all(Result::is_ok),
            "native directory substitutions: {:?}",
            swaps.borrow()
        );
        assert!(pending && durable_pending);
        assert!(old_destination_absent);
        assert_eq!(native_identity.unwrap(), managed_identity);
        assert_eq!(engine_bytes.unwrap(), b"managed engine");
        assert_eq!(network_bytes.unwrap(), b"managed network");
        assert_eq!(independent_bytes.unwrap(), b"independent engine");
        assert!(matches!(result, Err(Error::Conflict(_))), "REGISTRATION_MOVED_TREE_PENDING_REFUSAL: refuse the captured member of the moved pending tree: {result:?}, stored={stored_identity:?}");
        assert!(no_managed_capability && durable_no_managed);
    }

    #[test]
    fn catalog_install_r13_registration_boundary_refuses_pending_alias() {
        use std::{cell::RefCell, rc::Rc};

        let mut f = Fixture::new();
        let original_record = f.pending_wrong_kind();
        #[cfg(unix)]
        let permissions_before = {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(f.root.join("managed"), fs::Permissions::from_mode(0o600)).unwrap();
            fs::metadata(f.root.join("managed"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        fs::hard_link(f.root.join("managed"), f.root.join("direct-bad")).unwrap();
        fs::write(f.root.join("independent"), b"independent file").unwrap();
        let independent = f
            .authority
            .register_installed_engine_for_test(&f.handle, "independent");
        let direct_bad = f
            .authority
            .register_installed_engine_for_test(&f.handle, "direct-bad");
        let staged = f.root.join("staged-alias");
        let locator = f.root.join("alias-engine");
        fs::hard_link(f.root.join("managed"), &staged).unwrap();
        fs::write(&locator, b"good original file").unwrap();
        fs::hard_link(&locator, f.root.join("good-original")).unwrap();
        let bad_identity = identity(&staged).unwrap();
        let swap = Rc::new(RefCell::new(Vec::new()));
        let hook_swap = swap.clone();
        let cleanup = RegistrationHookCleanup;
        RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    hook_swap.borrow_mut().push(fs::rename(staged, locator));
                })))
                .is_none());
        });
        let result = f
            .authority
            .register_installed_engine_for_test(&f.handle, "alias-engine");
        drop(cleanup);
        let no_bad_capability = f
            .authority
            .persistent
            .values()
            .all(|entry| entry.stored.identity != bad_identity);
        let pending =
            pending_registration_evidence(&f.authority.catalog_installs, &original_record);
        let original_engine = fs::read(f.root.join("original/engine")).unwrap();
        let original_network = fs::read(f.root.join("original/data/network")).unwrap();
        let good_bytes = fs::read(f.root.join("good-original")).unwrap();
        let managed_bytes = fs::read(f.root.join("managed")).unwrap();
        let alias_bytes = fs::read(f.root.join("alias-engine")).unwrap();
        #[cfg(unix)]
        let permissions_after = {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(f.root.join("managed"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777
        };
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        let reopened = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let durable_no_bad = reopened
            .persistent
            .values()
            .all(|entry| entry.stored.identity != bad_identity);
        let durable_pending =
            pending_registration_evidence(&reopened.catalog_installs, &original_record);
        drop(reopened);
        let temp_path = temp.path().to_path_buf();
        temp.close().unwrap();
        let hooks_empty = RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow().is_none())
            && INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow().is_none());
        eprintln!("REGISTRATION_BOUNDARY_NATIVE: swap={:?}, result={result:?}, independent={independent:?}, direct_bad={direct_bad:?}, no_bad={no_bad_capability}/{durable_no_bad}, pending={pending}/{durable_pending}, hooks_empty={hooks_empty}, removed={}", swap.borrow(), !temp_path.exists());
        assert!(hooks_empty && !temp_path.exists());
        assert!(independent.is_ok(), "independent control: {independent:?}");
        assert!(
            matches!(direct_bad, Err(Error::Conflict(_))),
            "direct bad alias: {direct_bad:?}"
        );
        assert_eq!(swap.borrow().len(), 1);
        assert!(
            swap.borrow()[0].is_ok(),
            "native pre-resolution replacement: {:?}",
            swap.borrow()
        );
        assert!(pending && durable_pending);
        assert_eq!(original_engine, b"managed engine");
        assert_eq!(original_network, b"managed network");
        assert_eq!(good_bytes, b"good original file");
        assert_eq!(managed_bytes, b"unconfirmed file");
        assert_eq!(alias_bytes, b"unconfirmed file");
        assert!(matches!(result, Err(Error::Conflict(_))),
            "REGISTRATION_BOUNDARY_PENDING_ALIAS: refuse the pending alias captured after the precheck: {result:?}");
        assert!(
            no_bad_capability && durable_no_bad,
            "no bad capability may be persisted"
        );
        #[cfg(unix)]
        {
            eprintln!("REGISTRATION_PENDING_ALIAS_PERMISSIONS: before={permissions_before:o}, after={permissions_after:o}");
            assert_eq!(
                permissions_before, permissions_after,
                "REGISTRATION_PENDING_ALIAS_PERMISSIONS: refusal must precede executable marking"
            );
        }
    }

    #[test]
    fn catalog_install_r13_registration_keeps_independent_bound_file_with_pending_record() {
        use std::{cell::RefCell, rc::Rc};

        let mut f = Fixture::new();
        let original_record = f.pending_wrong_kind();
        let staged = f.root.join("staged-alias");
        let locator = f.root.join("independent");
        fs::hard_link(f.root.join("managed"), &staged).unwrap();
        fs::write(&locator, b"good original file").unwrap();
        fs::hard_link(&locator, f.root.join("good-original")).unwrap();
        let good_identity = identity(&locator).unwrap();
        let bad_identity = identity(&staged).unwrap();
        let swap = Rc::new(RefCell::new(Vec::new()));
        let hook_swap = swap.clone();
        let cleanup = RegistrationHookCleanup;
        INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| {
            assert!(slot
                .replace(Some(Box::new(move || {
                    hook_swap.borrow_mut().push(fs::rename(staged, locator));
                })))
                .is_none());
        });
        let result = f
            .authority
            .register_installed_engine_for_test(&f.handle, "independent");
        drop(cleanup);
        let stored_identity = result.as_ref().ok().map(|handle| {
            f.authority.persistent[&handle.path_ref().id]
                .stored
                .identity
                .clone()
        });
        let later_use = result.as_ref().ok().map(|handle| {
            f.authority
                .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
                .map(|_| ())
        });
        let no_bad_capability = f
            .authority
            .persistent
            .values()
            .all(|entry| entry.stored.identity != bad_identity);
        let pending =
            pending_registration_evidence(&f.authority.catalog_installs, &original_record);
        let original_engine = fs::read(f.root.join("original/engine")).unwrap();
        let original_network = fs::read(f.root.join("original/data/network")).unwrap();
        let good_bytes = fs::read(f.root.join("good-original")).unwrap();
        let managed_bytes = fs::read(f.root.join("managed")).unwrap();
        let locator_bytes = fs::read(f.root.join("independent")).unwrap();
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        let mut reopened = PathAuthority::open(temp.path().join("registry.json"), vec![]).unwrap();
        let durable_identity = result.as_ref().ok().map(|handle| {
            reopened.persistent[&handle.path_ref().id]
                .stored
                .identity
                .clone()
        });
        let durable_use = result.as_ref().ok().map(|handle| {
            reopened
                .resolve(handle.path_ref(), PathOperation::EngineExecute, &[])
                .map(|_| ())
        });
        let durable_no_bad = reopened
            .persistent
            .values()
            .all(|entry| entry.stored.identity != bad_identity);
        let durable_pending =
            pending_registration_evidence(&reopened.catalog_installs, &original_record);
        drop(reopened);
        let temp_path = temp.path().to_path_buf();
        temp.close().unwrap();
        let hooks_empty = RESOLVE_PRE_ROOT_OPEN_HOOK.with(|slot| slot.borrow().is_none())
            && INSTALLED_ENGINE_POST_RESOLVE_HOOK.with(|slot| slot.borrow().is_none());
        eprintln!("REGISTRATION_PR1_NATIVE: swap={:?}, result={result:?}, held={good_identity:?}, stored={stored_identity:?}/{durable_identity:?}, later_use={later_use:?}/{durable_use:?}, no_bad={no_bad_capability}/{durable_no_bad}, pending={pending}/{durable_pending}, hooks_empty={hooks_empty}, removed={}", swap.borrow(), !temp_path.exists());
        assert!(hooks_empty && !temp_path.exists());
        assert_eq!(swap.borrow().len(), 1);
        assert!(pending && durable_pending);
        assert_eq!(original_engine, b"managed engine");
        assert_eq!(original_network, b"managed network");
        assert_eq!(good_bytes, b"good original file");
        assert_eq!(managed_bytes, b"unconfirmed file");
        assert!(result.is_ok(), "REGISTRATION_PR1_HELD_INDEPENDENT_SUCCESS: persist the held independent file despite the pending replacement: {result:?}");
        assert_eq!(stored_identity, Some(good_identity.clone()));
        assert_eq!(durable_identity, Some(good_identity));
        assert!(no_bad_capability && durable_no_bad);
        if swap.borrow()[0].is_ok() {
            assert_eq!(locator_bytes, b"unconfirmed file");
            assert!(
                matches!(later_use, Some(Err(Error::Conflict(_)))),
                "replacement use: {later_use:?}"
            );
            assert!(
                matches!(durable_use, Some(Err(Error::Conflict(_)))),
                "reloaded replacement use: {durable_use:?}"
            );
        } else {
            // Windows' retained no-delete file can reject replacement. Record that actual
            // native refusal, rather than claiming that the opposite-order swap succeeded.
            let code = swap.borrow()[0].as_ref().unwrap_err().raw_os_error();
            assert!(
                cfg!(windows) && matches!(code, Some(5 | 32)),
                "native replacement failure: {:?}",
                swap.borrow()
            );
            assert_eq!(locator_bytes, b"good original file");
            assert!(matches!(later_use, Some(Ok(()))));
            assert!(matches!(durable_use, Some(Ok(()))));
        }
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_r12_unavailable_native_observation_is_not_absent() {
        use std::os::unix::fs::PermissionsExt;

        let mut f = Fixture::new();
        f.pending_install("managed");
        let resolved = f
            .authority
            .resolve(
                f.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from("managed")],
            )
            .unwrap();
        let held_root = open_verified_directory(
            &f.root,
            (
                f.authority
                    .catalog_installs
                    .values()
                    .next()
                    .unwrap()
                    .root
                    .identity
                    .a,
                f.authority
                    .catalog_installs
                    .values()
                    .next()
                    .unwrap()
                    .root
                    .identity
                    .b,
            ),
        )
        .unwrap()
        .into_file();
        let mut stage = f.stage();
        let permissions = fs::metadata(&f.root).unwrap().permissions();
        fs::set_permissions(&f.root, fs::Permissions::from_mode(0o400)).unwrap();
        let native = crate::infra::fs::entry_identity_at(&held_root, OsStr::new("managed"), true);
        let adoption = f
            .authority
            .confirm_catalog_archive_adoption(f.handle.path_ref(), &resolved);
        let publication =
            f.authority
                .publish_catalog_install(f.handle.path_ref(), &resolved, &mut stage.owner);
        let (id, record) = f
            .authority
            .catalog_installs
            .iter()
            .next()
            .map(|(id, record)| (id.clone(), record.clone()))
            .unwrap();
        let collection = f.authority.collect_catalog_install(&id, &record);
        fs::set_permissions(&f.root, permissions).unwrap();
        drop(held_root);
        drop(stage);
        f.reopen();
        let record_retained = f.authority.catalog_installs.len() == 1;
        let bytes = fs::read(f.root.join("managed/engine"));
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        temp.close().unwrap();
        assert!(
            matches!(native, Err(Error::Io(ref cause)) if cause.kind() == std::io::ErrorKind::PermissionDenied),
            "real native permission refusal must be exercised: {native:?}"
        );
        assert!(matches!(adoption, Err(Error::Conflict(_))),
            "NATIVE_ABSENCE_REQUIRES_NOT_FOUND: unavailable native observation cannot mean absent: {adoption:?}");
        assert!(
            matches!(publication, Err(Error::Conflict(_))),
            "{publication:?}"
        );
        assert!(
            collection.is_ok(),
            "unavailable pending evidence must be retained: {collection:?}"
        );
        assert!(record_retained);
        assert_eq!(bytes.unwrap(), b"managed engine");
    }

    #[test]
    fn catalog_install_r12_wrong_kind_retains_pending_and_confirmed_evidence() {
        for pending in [false, true] {
            for link in [false, true] {
                let mut f = Fixture::new();
                let resolved = f
                    .authority
                    .resolve(
                        f.handle.path_ref(),
                        PathOperation::DownloadArchive,
                        &[OsString::from("managed")],
                    )
                    .unwrap();
                if pending {
                    f.pending_install("managed");
                } else {
                    f.install("managed");
                }
                fs::rename(f.root.join("managed"), f.root.join("original")).unwrap();
                if link {
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(f.root.join("original"), f.root.join("managed"))
                        .unwrap();
                    #[cfg(windows)]
                    crate::infra::fs::windows_test_junction(
                        &f.root.join("managed"),
                        &f.root.join("original"),
                    );
                } else {
                    fs::write(f.root.join("managed"), b"foreign file").unwrap();
                }
                f.reopen();
                let result = f.reconcile(vec![], true);
                assert!(
                    result.is_ok() || matches!(result, Err(Error::Conflict(_))),
                    "{result:?}"
                );
                assert_eq!(f.authority.catalog_installs.len(), 1);
                assert!(matches!(
                    f.authority
                        .confirm_catalog_archive_adoption(f.handle.path_ref(), &resolved),
                    Err(Error::Conflict(_))
                ));
                assert_eq!(
                    fs::read(f.root.join("original/engine")).unwrap(),
                    b"managed engine"
                );
            }
        }
    }

    fn r12_native_case_alias_applicable(f: &Fixture) -> bool {
        use std::io::Write;
        let lower = f.root.join(".r12-case-probe");
        let upper = f.root.join(".R12-CASE-PROBE");
        fs::create_dir(&lower).unwrap();
        fs::write(lower.join("witness"), b"independent native alias witness").unwrap();
        let applicable = fs::read(upper.join("witness")).ok().as_deref()
            == Some(b"independent native alias witness".as_slice());
        fs::remove_dir_all(lower).unwrap();
        writeln!(
            std::io::stderr().lock(),
            "R12_NATIVE_CASE_ALIAS applicable={applicable} root={:?}",
            f.root
        )
        .unwrap();
        applicable
    }

    #[test]
    fn catalog_install_r12_native_alias_adoption_and_pending_confirmation() {
        for state in ["legacy", "confirmed", "pending"] {
            let mut f = Fixture::new();
            if !r12_native_case_alias_applicable(&f) {
                return;
            }
            match state {
                "legacy" => {
                    fs::create_dir(f.root.join("managed")).unwrap();
                    fs::write(f.root.join("managed/engine"), b"managed engine").unwrap();
                }
                "confirmed" => f.install("managed"),
                _ => f.pending_install("managed"),
            }
            let record_count = f.authority.catalog_installs.len();
            fs::rename(f.root.join("managed"), f.root.join("MANAGED")).unwrap();
            f.reopen();
            assert!(
                f.adopt("managed").unwrap(),
                "native {state} alias must adopt"
            );
            assert!(f.adopt("MANAGED").unwrap());
            assert_eq!(f.authority.catalog_installs.len(), record_count);
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.publication == Some(Publication::Confirmed)));
            f.reopen();
            let engine = f.engine("managed");
            f.reconcile(vec![engine.path_ref().clone()], true).unwrap();
            assert_eq!(
                fs::read(f.root.join("MANAGED/engine")).unwrap(),
                b"managed engine"
            );
            assert_eq!(f.authority.catalog_installs.len(), record_count);
        }
    }

    fn r12_assert_pending_archive_refusal<T: std::fmt::Debug>(
        result: Result<T, Error>,
        alteration: &str,
        name: &str,
        cycle: usize,
        operation: &str,
    ) {
        // Windows refuses a wrong-kind archive leaf in the resolver, before confirmation.
        let refused = if cfg!(windows) && alteration == "file" {
            matches!(&result, Err(Error::InvalidInput(message)) if message == "archive destination must be a directory")
        } else {
            matches!(&result, Err(Error::Conflict(_)))
        };
        assert!(
            refused,
            "pending {alteration} alias={name} cycle={cycle} {operation} refusal required: {result:?}"
        );
    }

    #[test]
    fn catalog_install_r12_native_alias_pending_mismatch_survives_startup() {
        for alteration in ["modified", "replacement", "file"] {
            let mut f = Fixture::new();
            if !r12_native_case_alias_applicable(&f) {
                return;
            }
            f.pending_install("managed");
            if alteration != "modified" {
                fs::rename(f.root.join("managed"), f.root.join("original")).unwrap();
                if alteration != "file" {
                    fs::create_dir(f.root.join("managed")).unwrap();
                }
            }
            let contents = if alteration == "file" {
                "managed"
            } else {
                "managed/engine"
            };
            fs::write(f.root.join(contents), b"unconfirmed foreign contents").unwrap();
            fs::rename(f.root.join("managed"), f.root.join("MANAGED")).unwrap();
            for cycle in 0..2 {
                f.reopen();
                f.reconcile(vec![], true).unwrap();
                assert_eq!(f.authority.catalog_installs.len(), 1);
                assert!(f
                    .authority
                    .catalog_installs
                    .values()
                    .all(|record| record.publication == Some(Publication::Pending)));
                for name in ["managed", "MANAGED"] {
                    r12_assert_pending_archive_refusal(
                        f.adopt(name),
                        alteration,
                        name,
                        cycle,
                        "adoption",
                    );
                    let executable = if alteration == "file" {
                        name.to_string()
                    } else {
                        format!("{name}/engine")
                    };
                    let registration = f
                        .authority
                        .register_installed_engine_for_test(&f.handle, &executable);
                    assert!(
                        matches!(&registration, Err(Error::Conflict(_))),
                        "pending {alteration} alias={name} cycle={cycle} registration refusal required: {registration:?}"
                    );
                    let mut stage = f.stage();
                    r12_assert_pending_archive_refusal(
                        f.publish_stage(name, &mut stage),
                        alteration,
                        name,
                        cycle,
                        "publication",
                    );
                }
                assert_eq!(
                    fs::read(f.root.join(if alteration == "file" {
                        "MANAGED"
                    } else {
                        "MANAGED/engine"
                    }))
                    .unwrap(),
                    b"unconfirmed foreign contents"
                );
            }
        }
    }

    #[test]
    fn catalog_install_r12_native_alias_confirmed_cleanup_completes() {
        let mut f = Fixture::new();
        if !r12_native_case_alias_applicable(&f) {
            return;
        }
        f.install("managed");
        fs::rename(f.root.join("managed"), f.root.join("MANAGED")).unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.authority.catalog_installs.is_empty());
        assert!(!f.root.join("MANAGED").exists());
    }

    #[test]
    fn catalog_install_r12_native_alias_partial_cleanup_and_preserved_refusal() {
        #[cfg(unix)]
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        for modified in [false, true] {
            let mut f = Fixture::new();
            if !r12_native_case_alias_applicable(&f) {
                return;
            }
            f.install("managed");
            let inventory = f
                .authority
                .catalog_installs
                .values()
                .next()
                .unwrap()
                .inventory
                .clone();
            f.reopen();
            #[cfg(unix)]
            let fault = scoped_test_removal_injector(Arc::new(RemovalFault(
                RemovalFaultPoint::AfterEntryRemoved,
            )));
            #[cfg(windows)]
            let fault = {
                use std::os::windows::fs::OpenOptionsExt;
                use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};

                let record = f.authority.catalog_installs.values().next().unwrap();
                let directory = open_verified_directory(
                    &f.root.join("managed"),
                    (record.identity.a, record.identity.b),
                )
                .unwrap()
                .into_file();
                let entries = read_directory_entries_at(
                    &directory,
                    &CancellationToken::new(),
                    None,
                    &mut |_| true,
                )
                .unwrap();
                // Block deletion in the last native top-level entry, allowing an earlier
                // entry to be physically removed before the real sharing refusal.
                let last = entries.last().unwrap();
                let blocked = if last.kind == DirectoryEntryKind::Directory {
                    f.root.join("managed").join(&last.name).join("network")
                } else {
                    f.root.join("managed").join(&last.name)
                };
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                    .open(blocked)
                    .unwrap()
            };
            let cleanup = f.reconcile(vec![], true);
            drop(fault);
            assert!(cleanup.is_err());
            let record = f.authority.catalog_installs.values().next().unwrap();
            assert!(record.cleaning);
            assert_eq!(record.inventory, inventory);
            let directory = open_verified_directory(
                &f.root.join("managed"),
                (record.identity.a, record.identity.b),
            )
            .unwrap()
            .into_file();
            let remaining = super::inventory(&directory, record.root.identity.a).unwrap();
            drop(directory);
            assert!(
                !remaining.is_empty() && remaining.len() < inventory.len(),
                "native cleanup must actually remove a strict part of the original inventory"
            );
            #[cfg(windows)]
            assert!(
                matches!(&cleanup, Err(Error::PartialRemoval { removed_entries, cause })
                    if *removed_entries > 0
                        && *removed_entries == inventory.len() - remaining.len()
                        && matches!(cause.as_ref(), Error::Conflict(message) if message == "Windows sharing violation")),
                "actual native delete-sharing partial refusal must account for the removed inventory: {cleanup:?}, original={}, remaining={}",
                inventory.len(),
                remaining.len()
            );
            fs::rename(f.root.join("managed"), f.root.join("MANAGED")).unwrap();
            if modified {
                fs::write(f.root.join("MANAGED/user"), b"preserved user addition").unwrap();
            }
            f.reopen();
            assert!(matches!(f.adopt("managed"), Err(Error::Conflict(_))));
            f.reconcile(vec![], true).unwrap();
            if modified {
                for _ in 0..2 {
                    f.reopen();
                    f.reconcile(vec![], true).unwrap();
                    let record = f.authority.catalog_installs.values().next().unwrap();
                    assert!(record.cleaning && record.preserved);
                    assert_eq!(record.inventory, inventory);
                    assert!(matches!(f.adopt("managed"), Err(Error::Conflict(_))));
                    assert!(matches!(
                        f.authority
                            .register_installed_engine_for_test(&f.handle, "managed/user"),
                        Err(Error::Conflict(_))
                    ));
                    assert_eq!(
                        fs::read(f.root.join("MANAGED/user")).unwrap(),
                        b"preserved user addition"
                    );
                }
            } else {
                assert!(f.authority.catalog_installs.is_empty());
                assert!(!f.root.join("MANAGED").exists());
            }
        }
    }

    #[test]
    fn catalog_install_publication_confirmation_valid_pending_recovers_durably() {
        let mut f = Fixture::new();
        f.pending_install("managed");
        f.reopen();
        assert!(f.adopt("managed").unwrap());
        let engine = f.engine("managed");
        f.reopen();
        f.reconcile(vec![engine.path_ref().clone()], true).unwrap();
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.publication == Some(Publication::Confirmed)));
        assert_eq!(
            fs::read(f.root.join("managed/engine")).unwrap(),
            b"managed engine"
        );
    }

    #[test]
    fn catalog_install_publication_confirmation_observation_error_is_hard_and_retryable() {
        struct ObservationFault;
        impl AtomicDirInjector for ObservationFault {
            fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
                if point == AtomicDirFaultPoint::InstallRename {
                    crate::infra::fs::set_entry_observation_fault(Some(Error::Io(Box::new(
                        std::io::Error::other("postcommit observation unavailable"),
                    ))));
                }
                Ok(())
            }
        }
        let mut f = Fixture::new();
        let mut stage = f.stage();
        set_test_atomic_dir_injector(Some(Box::new(ObservationFault)));
        let result = f.publish_stage("managed", &mut stage);
        set_test_atomic_dir_injector(None);
        crate::infra::fs::set_entry_observation_fault(None);
        drop(stage);
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "unconfirmable native commit must not be applied: {result:?}"
        );
        assert_eq!(
            fs::read(f.root.join("managed/engine")).unwrap(),
            b"managed engine"
        );
        f.reopen();
        assert!(f.adopt("managed").unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_publication_confirmation_missing_after_commit_is_hard() {
        use std::os::unix::fs::MetadataExt;

        struct MoveInstalled {
            installed: PathBuf,
            moved: PathBuf,
            moves: Arc<std::sync::atomic::AtomicUsize>,
        }
        impl AtomicDirInjector for MoveInstalled {
            fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
                if point == AtomicDirFaultPoint::ParentSync {
                    fs::rename(&self.installed, &self.moved)?;
                    self.moves.fetch_add(1, Ordering::SeqCst);
                }
                Ok(())
            }
        }

        let mut f = Fixture::new();
        let mut stage = f.stage();
        let accepted = stage.owner.binding().2;
        // Moving back to the former staging leaf makes disarming observable. An armed
        // owner would still recognize this exact original and delete it when dropped.
        let moved = stage.path().to_path_buf();
        let installed = f.root.join("managed");
        let moves = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        set_test_atomic_dir_injector(Some(Box::new(MoveInstalled {
            installed: installed.clone(),
            moved: moved.clone(),
            moves: moves.clone(),
        })));
        let result = f.publish_stage("managed", &mut stage);
        set_test_atomic_dir_injector(None);
        drop(stage);

        let identity_after_owner_drop =
            fs::metadata(&moved).map(|metadata| (metadata.dev(), metadata.ino()));
        let engine_after_owner_drop = fs::read(moved.join("engine"));
        let network_after_owner_drop = fs::read(moved.join("data/network"));
        f.reopen();
        let pending_after_reopen = f.authority.catalog_installs.len() == 1
            && f.authority.catalog_installs.values().all(|record| {
                record.publication == Some(Publication::Pending)
                    && (record.identity.a, record.identity.b) == accepted
            });
        let untrusted = f.reconcile(vec![], false);
        let retained_without_trusted_absence = f.authority.catalog_installs.len() == 1;
        let trusted = f.reconcile(vec![], true);
        let retired_after_trusted_absence = f.authority.catalog_installs.is_empty();
        let final_engine = fs::read(moved.join("engine"));
        let final_network = fs::read(moved.join("data/network"));
        let final_identity = fs::metadata(&moved).map(|metadata| (metadata.dev(), metadata.ino()));
        let target_absent = !installed.exists();
        let move_count = moves.load(Ordering::SeqCst);
        let Fixture {
            temp, authority, ..
        } = f;
        drop(authority);
        temp.close().unwrap();
        eprintln!(
            "MISSING_PUBLICATION_PROBE result={result:?} accepted={accepted:?} moves={move_count} identity_after_owner_drop={identity_after_owner_drop:?} final_identity={final_identity:?} pending_after_reopen={pending_after_reopen} retained_without_trusted_absence={retained_without_trusted_absence} retired_after_trusted_absence={retired_after_trusted_absence} target_absent={target_absent} all native cleanup completed before assertions"
        );

        assert!(matches!(result, Err(Error::Conflict(_))),
            "MISSING_PUBLICATION_MUST_NOT_SUCCEED: absent publication must be a hard conflict, never success or applied uncertainty: {result:?}");
        assert_eq!(move_count, 1);
        assert_eq!(identity_after_owner_drop.unwrap(), accepted);
        assert_eq!(engine_after_owner_drop.unwrap(), b"managed engine");
        assert_eq!(network_after_owner_drop.unwrap(), b"managed network");
        assert!(pending_after_reopen);
        untrusted.unwrap();
        assert!(retained_without_trusted_absence);
        trusted.unwrap();
        assert!(retired_after_trusted_absence);
        assert!(target_absent);
        assert_eq!(final_identity.unwrap(), accepted);
        assert_eq!(final_engine.unwrap(), b"managed engine");
        assert_eq!(final_network.unwrap(), b"managed network");
    }

    #[test]
    fn catalog_install_publication_confirmation_absent_pending_attempt_retires() {
        let mut f = Fixture::new();
        let mut stage = f.stage();
        set_test_atomic_dir_injector(Some(Box::new(DirFault(AtomicDirFaultPoint::InstallRename))));
        let result = f.publish_stage("managed", &mut stage);
        set_test_atomic_dir_injector(None);
        drop(stage);
        assert!(result.is_err());
        assert!(!f.root.join("managed").exists());
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.authority.catalog_installs.is_empty());
    }

    #[test]
    fn catalog_install_publication_confirmation_pending_and_legacy_mismatch_survive_startup() {
        for legacy in [false, true] {
            for alteration in ["replacement", "modified", "incomplete"] {
                let mut f = Fixture::new();
                f.pending_install("managed");
                if legacy {
                    let path = f.temp.path().join("registry.json");
                    let mut registry: serde_json::Value =
                        serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
                    for record in registry["catalog_installs"]
                        .as_object_mut()
                        .unwrap()
                        .values_mut()
                    {
                        record.as_object_mut().unwrap().remove("publication");
                    }
                    fs::write(path, serde_json::to_vec(&registry).unwrap()).unwrap();
                }
                match alteration {
                    "replacement" => {
                        fs::rename(f.root.join("managed"), f.root.join("original")).unwrap();
                        fs::create_dir(f.root.join("managed")).unwrap();
                        fs::write(f.root.join("managed/engine"), b"foreign engine").unwrap();
                    }
                    "modified" => {
                        fs::write(f.root.join("managed/engine"), b"foreign engine").unwrap()
                    }
                    _ => fs::remove_file(f.root.join("managed/data/network")).unwrap(),
                }
                f.reopen();
                f.reconcile(vec![], true).unwrap();
                assert_eq!(
                    f.authority.catalog_installs.len(),
                    1,
                    "pending mismatch fence must survive {alteration}"
                );
                assert!(matches!(f.adopt("managed"), Err(Error::Conflict(_))));
                assert!(matches!(
                    f.authority
                        .register_installed_engine_for_test(&f.handle, "managed/engine"),
                    Err(Error::Conflict(_))
                ));
                assert!(f.root.join("managed/engine").exists());
            }
        }
    }

    #[test]
    fn root_failure_catalog_registry_and_durability_errors_are_unlabelled() {
        for point in [
            AtomicFileFaultPoint::Write,
            AtomicFileFaultPoint::Rename,
            AtomicFileFaultPoint::ParentSync,
        ] {
            let f = Fixture::new();
            let mut staging = f.stage();
            let Fixture {
                temp: _temp,
                root,
                handle,
                mut authority,
            } = f;
            let resolved = authority
                .resolve(
                    handle.path_ref(),
                    PathOperation::DownloadArchive,
                    &["managed".into()],
                )
                .unwrap();
            let authority = SharedPathAuthority::installed(authority);
            let guard = install_test_atomic_file_injector(Arc::new(FileFault(point)));
            let error = crate::fs::publish_engine_archive_tree(
                &authority,
                handle.path_ref(),
                &resolved,
                &mut staging.owner,
            )
            .unwrap_err();
            drop(guard);
            assert_eq!(error.root_failure(), None, "{point:?}: {error:?}");
            assert!(!root.join("managed").exists());
        }
        let f = Fixture::new();
        let mut staging = f.stage();
        let Fixture {
            temp: _temp,
            root,
            handle,
            mut authority,
        } = f;
        let resolved = authority
            .resolve(
                handle.path_ref(),
                PathOperation::DownloadArchive,
                &["managed".into()],
            )
            .unwrap();
        let authority = SharedPathAuthority::installed(authority);
        set_test_atomic_dir_injector(Some(Box::new(DirFault(AtomicDirFaultPoint::ParentSync))));
        let result = crate::fs::publish_engine_archive_tree(
            &authority,
            handle.path_ref(),
            &resolved,
            &mut staging.owner,
        );
        set_test_atomic_dir_injector(None);
        let error = result.unwrap_err();
        assert_eq!(error.root_failure(), None);
        assert!(
            matches!(error, Error::CommittedDurabilityUncertain(_)),
            "{error:?}"
        );
        assert!(root.join("managed/engine").exists());
    }

    #[cfg(unix)]
    #[test]
    fn root_failure_catalog_registry_failure_with_root_read_loss_stays_unlabelled() {
        use std::os::unix::fs::PermissionsExt;
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        struct RegistryFault(PathBuf);
        impl AtomicWriterInjector for RegistryFault {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::Write {
                    fs::set_permissions(&self.0, fs::Permissions::from_mode(0o300))?;
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "registry fault with unreadable root",
                    ));
                }
                Ok(())
            }
        }
        let f = Fixture::new();
        let mut staging = f.stage();
        let Fixture {
            temp: _temp,
            root,
            handle,
            mut authority,
        } = f;
        let resolved = authority
            .resolve(
                handle.path_ref(),
                PathOperation::DownloadArchive,
                &["managed".into()],
            )
            .unwrap();
        let authority = SharedPathAuthority::installed(authority);
        let permissions = TestRootPermissionGuard::restrict(&root, 0o700);
        let guard = install_test_atomic_file_injector(Arc::new(RegistryFault(root.clone())));
        let result = crate::fs::publish_engine_archive_tree(
            &authority,
            handle.path_ref(),
            &resolved,
            &mut staging.owner,
        );
        drop(guard);
        assert!(
            fs::read_dir(&root).is_err(),
            "registry failure must coincide with actual read loss"
        );
        drop(permissions);
        let error = result.unwrap_err();
        assert_eq!(error.root_failure(), None);
        assert_eq!(error.category(), crate::error::ErrorCategory::Permission);
        assert!(error
            .diagnostic()
            .contains("registry fault with unreadable root"));
        assert!(!root.join("managed").exists());
    }

    #[test]
    fn catalog_install_publication_confirmation_registry_failure_keeps_pending_retry() {
        struct ConfirmationFault {
            point: AtomicFileFaultPoint,
            calls: std::sync::atomic::AtomicUsize,
        }
        impl AtomicWriterInjector for ConfirmationFault {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == self.point && self.calls.fetch_add(1, Ordering::SeqCst) >= 1 {
                    return Err(std::io::Error::other("confirmation persistence fault"));
                }
                Ok(())
            }
        }
        for point in [
            AtomicFileFaultPoint::Write,
            AtomicFileFaultPoint::ParentSync,
        ] {
            let mut f = Fixture::new();
            let mut stage = f.stage();
            let fault = install_test_atomic_file_injector(Arc::new(ConfirmationFault {
                point,
                calls: std::sync::atomic::AtomicUsize::new(0),
            }));
            let result = f.publish_stage("managed", &mut stage);
            drop(fault);
            drop(stage);
            assert!(
                matches!(
                    result,
                    Err(Error::CommittedDurabilityUncertain(
                        crate::error::DurabilityStage::RegistryReplacement
                    ))
                ),
                "{point:?}: {result:?}"
            );
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.publication == Some(Publication::Pending)));
            assert_eq!(
                fs::read(f.root.join("managed/engine")).unwrap(),
                b"managed engine"
            );
            assert!(f.adopt("managed").unwrap());
            f.reopen();
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.publication == Some(Publication::Confirmed)));
        }
    }

    #[test]
    fn catalog_install_publication_confirmation_legacy_exact_and_malformed_state() {
        let mut f = Fixture::new();
        f.install("managed");
        let path = f.temp.path().join("registry.json");
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for invalid in [
            serde_json::json!("unknown"),
            serde_json::json!({}),
            serde_json::json!([]),
            serde_json::json!(false),
        ] {
            let mut value = original.clone();
            for record in value["catalog_installs"]
                .as_object_mut()
                .unwrap()
                .values_mut()
            {
                record["publication"] = invalid.clone();
            }
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                PathAuthority::open(path.clone(), vec![]).is_err(),
                "malformed publication {invalid}"
            );
        }
        let mut value = original;
        for record in value["catalog_installs"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            record.as_object_mut().unwrap().remove("publication");
        }
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        f.reopen();
        assert!(f.adopt("managed").unwrap());
        f.reopen();
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.publication == Some(Publication::Confirmed)));
        let mut malformed = f.authority.catalog_installs.clone();
        let record = malformed.values_mut().next().unwrap();
        record.publication = Some(Publication::Pending);
        record.cleaning = true;
        assert!(validate_records(&malformed).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_publication_confirmation_absent_retry_carries_prior_users() {
        let mut f = Fixture::new();
        f.pending_install("managed");
        let resource = f.resource(&f.root.join("managed/engine"), false);
        let lease = f.authority.engine_resource(&resource).unwrap();
        let session = f.authority.catalog_session.clone();
        fs::remove_dir_all(f.root.join("managed")).unwrap();
        f.reopen();
        f.install("managed");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("managed/engine").exists());
        #[cfg(target_os = "linux")]
        assert_eq!(
            fs::read(lease.uci_value().unwrap()).unwrap(),
            b"managed engine"
        );
        drop(lease);
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_publication_confirmation_same_root_spelling_keeps_fence() {
        let mut f = Fixture::new();
        f.pending_install("managed");
        fs::write(f.root.join("managed/engine"), b"modified pending tree").unwrap();
        let moved = f.temp.path().join("moved-root");
        fs::rename(&f.root, &moved).unwrap();
        phase3_select_root(&mut f, &moved);
        let result = f.adopt("managed");
        assert!(matches!(result, Err(Error::Conflict(_))),
            "PHYSICAL_ROOT_PENDING_FENCE: a different spelling of the same authorized root cannot adopt a modified pending tree: {result:?}");
        assert!(matches!(
            f.authority
                .register_installed_engine_for_test(&f.handle, "managed/engine"),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn catalog_install_publication_confirmation_existing_leaf_alias_keeps_fence() {
        let mut f = Fixture::new();
        f.pending_install("managed");
        let alias = f.root.join("MANAGED");
        if !alias.exists() {
            eprintln!(
                "actual filesystem has distinct case-sensitive leaves, alias branch not applicable"
            );
            return;
        }
        fs::write(f.root.join("managed/engine"), b"modified pending tree").unwrap();
        assert!(
            matches!(f.adopt("MANAGED"), Err(Error::Conflict(_))),
            "actual existing filesystem aliases must consume the same pending fence"
        );
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_publication_confirmation_old_root_does_not_block_new_binding() {
        let mut f = Fixture::new();
        f.pending_install("managed");
        let root = f.root.clone();
        fs::rename(&root, f.temp.path().join("old-root")).unwrap();
        fs::create_dir(&root).unwrap();
        phase3_select_root(&mut f, &root);
        f.install("managed");
        assert_eq!(f.authority.catalog_installs.len(), 2);
        assert!(f.adopt("managed").unwrap());
        assert!(f
            .authority
            .catalog_installs
            .values()
            .any(|record| record.publication == Some(Publication::Pending)));
        assert!(f.temp.path().join("old-root/managed/engine").exists());
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_publication_confirmation_legacy_cleaning_keeps_partial_retry() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        for modified in [false, true] {
            let mut f = Fixture::new();
            f.install("managed");
            f.reopen();
            let fault = scoped_test_removal_injector(Arc::new(RemovalFault(
                RemovalFaultPoint::AfterEntryRemoved,
            )));
            assert!(f.reconcile(vec![], true).is_err());
            drop(fault);
            let path = f.temp.path().join("registry.json");
            let mut registry: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            for record in registry["catalog_installs"]
                .as_object_mut()
                .unwrap()
                .values_mut()
            {
                record.as_object_mut().unwrap().remove("publication");
            }
            fs::write(path, serde_json::to_vec(&registry).unwrap()).unwrap();
            if modified {
                fs::write(f.root.join("managed/foreign"), b"preserve").unwrap();
            }
            f.reopen();
            assert!(matches!(f.adopt("managed"), Err(Error::Conflict(_))));
            f.reconcile(vec![], true).unwrap();
            assert_eq!(f.root.join("managed").exists(), modified);
            if modified {
                assert!(f
                    .authority
                    .catalog_installs
                    .values()
                    .all(|record| record.cleaning && record.preserved));
                assert_eq!(
                    fs::read(f.root.join("managed/foreign")).unwrap(),
                    b"preserve"
                );
            }
        }
    }

    struct DirFault(AtomicDirFaultPoint);
    impl AtomicDirInjector for DirFault {
        fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
            if point == self.0 {
                Err(std::io::Error::other("catalog publication fault"))
            } else {
                Ok(())
            }
        }
    }
    struct DirFaultReset;
    impl Drop for DirFaultReset {
        fn drop(&mut self) {
            set_test_atomic_dir_injector(None);
        }
    }

    type InstallEntryCallback = Box<dyn FnOnce() -> std::io::Result<()>>;
    struct InstallEntryAction(std::cell::RefCell<Option<InstallEntryCallback>>);
    impl AtomicDirInjector for InstallEntryAction {
        fn inject(&self, point: AtomicDirFaultPoint) -> std::io::Result<()> {
            if point == AtomicDirFaultPoint::InstallerEntry {
                if let Some(action) = self.0.borrow_mut().take() {
                    return action();
                }
            }
            Ok(())
        }
    }

    type RegistryCommitCallback = Box<dyn FnOnce() + Send>;
    struct RegistryCommitAction(std::sync::Mutex<Option<RegistryCommitCallback>>);
    impl AtomicWriterInjector for RegistryCommitAction {
        fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
            if point == AtomicFileFaultPoint::ParentSync {
                if let Some(action) = self.0.lock().unwrap().take() {
                    action();
                }
            }
            Ok(())
        }
    }

    #[test]
    fn catalog_install_joiner_post_inventory_parent_substitution_keeps_owned_cleanup() {
        for fail in [false, true] {
            let mut f = Fixture::new();
            let mut stage = f.stage();
            let stage_leaf = stage.path().file_name().unwrap().to_os_string();
            let moved = f.temp.path().join("moved-root");
            let root = f.root.clone();
            let moved_at_hook = moved.clone();
            let renamed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let renamed_at_hook = renamed.clone();
            let _reset = DirFaultReset;
            set_test_atomic_dir_injector(Some(Box::new(InstallEntryAction(
                std::cell::RefCell::new(Some(Box::new(move || {
                    match fs::rename(&root, &moved_at_hook) {
                        Ok(()) => {
                            renamed_at_hook.store(true, Ordering::SeqCst);
                            fs::create_dir(&root).unwrap();
                            fs::create_dir(root.join(&stage_leaf)).unwrap();
                            fs::write(
                                root.join(&stage_leaf).join("foreign"),
                                b"preserve substitute",
                            )
                            .unwrap();
                        }
                        Err(error) => {
                            #[cfg(unix)]
                            panic!("Unix parent rename must succeed: {error}");
                            #[cfg(windows)]
                            {
                                assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
                                assert!(!moved_at_hook.exists());
                                assert_eq!(
                                    fs::read(root.join(&stage_leaf).join("engine")).unwrap(),
                                    b"managed engine"
                                );
                                assert_eq!(
                                    fs::read(root.join(&stage_leaf).join("data/network")).unwrap(),
                                    b"managed network"
                                );
                            }
                        }
                    }
                    if fail {
                        Err(std::io::Error::other("post-inventory refusal"))
                    } else {
                        Ok(())
                    }
                }))),
            ))));
            let result = f.publish_stage("installed", &mut stage);
            assert_eq!(result.is_err(), fail);
            let stage_path = stage.path().to_path_buf();
            drop(stage);
            #[cfg(unix)]
            assert!(renamed.load(Ordering::SeqCst));
            let installed_root = if renamed.load(Ordering::SeqCst) {
                assert_eq!(
                    fs::read(stage_path.join("foreign")).unwrap(),
                    b"preserve substitute"
                );
                assert!(!moved.join(stage_path.file_name().unwrap()).exists());
                &moved
            } else {
                assert!(!moved.exists());
                assert!(!stage_path.exists());
                &f.root
            };
            assert_eq!(installed_root.join("installed").exists(), !fail);
            if !fail {
                assert_eq!(
                    fs::read(installed_root.join("installed/engine")).unwrap(),
                    b"managed engine"
                );
                assert_eq!(
                    fs::read(installed_root.join("installed/data/network")).unwrap(),
                    b"managed network"
                );
            }
        }
    }

    #[test]
    fn catalog_install_joiner_destination_appearing_after_inventory_is_preserved() {
        let mut f = Fixture::new();
        let mut stage = f.stage();
        let target = f.root.join("installed");
        let target_at_commit = target.clone();
        let guard = install_test_atomic_file_injector(Arc::new(RegistryCommitAction(
            std::sync::Mutex::new(Some(Box::new(move || {
                fs::create_dir(&target_at_commit).unwrap();
                fs::write(target_at_commit.join("foreign"), b"user tree").unwrap();
            }))),
        )));
        let result = f.publish_stage("installed", &mut stage);
        drop(guard);
        assert!(
            matches!(result, Err(Error::Conflict(_))),
            "an appearing destination must be refused"
        );
        drop(stage);
        assert_eq!(fs::read(target.join("foreign")).unwrap(), b"user tree");
        assert!(!target.join("engine").exists());
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(fs::read(target.join("foreign")).unwrap(), b"user tree");
    }

    #[test]
    fn catalog_install_joiner_post_inventory_source_replacement_is_refused() {
        let mut f = Fixture::new();
        let mut stage = f.stage();
        let source = stage.path().to_path_buf();
        let moved = f.root.join("moved-source");
        let source_at_hook = source.clone();
        let moved_at_hook = moved.clone();
        let renamed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let renamed_at_hook = renamed.clone();
        let _reset = DirFaultReset;
        set_test_atomic_dir_injector(Some(Box::new(InstallEntryAction(std::cell::RefCell::new(
            Some(Box::new(move || {
                match fs::rename(&source_at_hook, &moved_at_hook) {
                    Ok(()) => {
                        renamed_at_hook.store(true, Ordering::SeqCst);
                        fs::create_dir(&source_at_hook).unwrap();
                        fs::write(source_at_hook.join("foreign"), b"foreign source").unwrap();
                    }
                    Err(error) => {
                        #[cfg(unix)]
                        panic!("Unix source rename must succeed: {error}");
                        #[cfg(windows)]
                        {
                            assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
                            assert!(!moved_at_hook.exists());
                            assert_eq!(
                                fs::read(source_at_hook.join("engine")).unwrap(),
                                b"managed engine"
                            );
                            assert_eq!(
                                fs::read(source_at_hook.join("data/network")).unwrap(),
                                b"managed network"
                            );
                        }
                    }
                }
                Ok(())
            })),
        )))));
        let result = f.publish_stage("installed", &mut stage);
        drop(stage);
        #[cfg(unix)]
        assert!(renamed.load(Ordering::SeqCst));
        if renamed.load(Ordering::SeqCst) {
            assert!(matches!(result, Err(Error::Conflict(_))));
            assert!(!f.root.join("installed").exists());
            assert_eq!(fs::read(source.join("foreign")).unwrap(), b"foreign source");
            assert_eq!(fs::read(moved.join("engine")).unwrap(), b"managed engine");
            assert_eq!(
                fs::read(moved.join("data/network")).unwrap(),
                b"managed network"
            );
        } else {
            assert!(result.is_ok());
            assert!(!source.exists());
            assert!(!moved.exists());
            assert_eq!(
                fs::read(f.root.join("installed/engine")).unwrap(),
                b"managed engine"
            );
            assert_eq!(
                fs::read(f.root.join("installed/data/network")).unwrap(),
                b"managed network"
            );
        }
    }

    fn cr6_cleaning_fixture() -> Fixture {
        let mut f = Fixture::new();
        f.install("managed");
        f.reopen();
        #[cfg(unix)]
        {
            use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
            let _guard = scoped_test_removal_injector(Arc::new(RemovalFault(
                RemovalFaultPoint::BeforeTopOpen,
            )));
            assert!(f.reconcile(vec![], true).is_err());
        }
        #[cfg(windows)]
        {
            // Seed the same durable pre-removal retry state. Unix additionally proves the
            // production removal failure above, while Windows exercises resolution below.
            let mut records = f.authority.catalog_installs.clone();
            records.values_mut().next().unwrap().cleaning = true;
            f.authority.commit_catalog(records).unwrap();
        }
        f.reopen();
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.cleaning && record.users.is_empty()));
        f
    }

    fn cr6_independent_engine(f: &mut Fixture) -> EngineHandle {
        let directory = f.temp.path().join("independent");
        fs::create_dir(&directory).unwrap();
        let executable = directory.join("engine");
        fs::write(&executable, b"independent engine").unwrap();
        f.authority
            .register_engine_file(&executable, "Independent")
            .unwrap()
    }

    #[test]
    fn catalog_install_cr6_unavailable_cleaning_root_marks_unrelated_handoff_durably() {
        let mut f = cr6_cleaning_fixture();
        let engine = cr6_independent_engine(&mut f);
        let original = f.authority.catalog_installs.clone();
        let moved = f.temp.path().join("moved-root");
        fs::rename(&f.root, &moved).unwrap();
        let session = f.authority.catalog_session.clone();
        drop(
            f.authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap(),
        );
        let persisted = PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
        for (id, record) in &original {
            assert!(!persisted.catalog_installs[id].users.contains(&session));
            assert_eq!(persisted.catalog_installs[id].root, record.root);
            assert!(persisted.catalog_installs[id].cleaning);
            assert!(!f.authority.catalog_protected.contains(id));
        }
        assert_eq!(persisted.catalog_uses.len(), 2);
        assert!(persisted
            .catalog_uses
            .values()
            .all(|sessions| sessions.get(&session) == Some(&false)));
        drop(persisted);
        f.reopen();
        assert!(matches!(
            f.reconcile(vec![engine.path_ref().clone()], true),
            Err(Error::Io(_))
        ));
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| !record.users.contains(&session)));
        assert!(moved.join("managed/data/network").exists());
    }

    #[test]
    fn catalog_install_cr6_uncertain_marker_failure_refuses_handoff() {
        for uncertain in [false, true] {
            let mut f = cr6_cleaning_fixture();
            let engine = cr6_independent_engine(&mut f);
            fs::rename(&f.root, f.temp.path().join("moved-root")).unwrap();
            let fault: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(ParentSyncFault("uncertain catalog use"))
            } else {
                Arc::new(FileFault(AtomicFileFaultPoint::Write))
            };
            let _guard = install_test_atomic_file_injector(fault);
            for _ in 0..2 {
                let error = match f
                    .authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                {
                    Ok(_) => panic!("uncertain session use must be durable before handoff"),
                    Err(error) => error,
                };
                assert!(
                    matches!(error, Error::Io(_) | Error::CommittedDurabilityUncertain(_)),
                    "{error:?}"
                );
            }
            drop(_guard);
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            let session = f.authority.catalog_session.clone();
            f.reopen();
            assert!(f
                .authority
                .catalog_uses
                .values()
                .all(|sessions| sessions.get(&session) == Some(&false)));
            assert_eq!(f.authority.catalog_uses.len(), 2);
        }
    }

    #[test]
    fn catalog_install_cr6_replacement_root_and_tree_allow_independent_engine() {
        for replace_root in [false, true] {
            let mut f = cr6_cleaning_fixture();
            let original = f.authority.catalog_installs.clone();
            let old_tree = f.root.join("managed");
            let moved = f.temp.path().join("original-binding");
            if replace_root {
                fs::rename(&f.root, &moved).unwrap();
                fs::create_dir(&f.root).unwrap();
                let binding = identity(&f.root).unwrap();
                f.handle = f
                    .authority
                    .get_or_create_engine_root(
                        &f.root,
                        "Replacement",
                        Some(VerifiedIdentity::from_pair((binding.a, binding.b))),
                    )
                    .unwrap();
                f.root = f.authority.engine_root_path(&f.handle).unwrap();
            } else {
                fs::rename(&old_tree, &moved).unwrap();
            }
            fs::create_dir(f.root.join("managed")).unwrap();
            let executable = f.root.join("managed/engine");
            fs::write(&executable, b"independent replacement").unwrap();
            let engine = f
                .authority
                .register_engine_file(&executable, "Replacement")
                .unwrap();
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            for (id, record) in &original {
                assert_eq!(&f.authority.catalog_installs[id], record);
            }
            assert_eq!(fs::read(&executable).unwrap(), b"independent replacement");
            assert!(moved
                .join(if replace_root {
                    "managed/data/network"
                } else {
                    "data/network"
                })
                .exists());
        }
    }

    #[test]
    fn catalog_install_cr6_moved_cleaning_descendants_are_refused() {
        for move_root in [false, true] {
            let mut f = Fixture::new();
            f.install("managed");
            let moved = f.temp.path().join("moved-binding");
            if move_root {
                fs::rename(&f.root, &moved).unwrap();
            } else {
                fs::rename(f.root.join("managed"), &moved).unwrap();
            }
            let tree = if move_root {
                moved.join("managed")
            } else {
                moved.clone()
            };
            #[cfg(unix)]
            let selected = {
                let alias = f.temp.path().join("alias");
                std::os::unix::fs::symlink(&tree, &alias).unwrap();
                alias.join("engine")
            };
            #[cfg(windows)]
            let selected = tree.join("engine");
            let engine = f
                .authority
                .register_engine_file(&selected, "Moved")
                .unwrap();
            let resource = f.resource(&tree, true);
            // Persist a retry state after acquiring handles at their moved filesystem binding.
            let mut records = f.authority.catalog_installs.clone();
            records.values_mut().next().unwrap().cleaning = true;
            f.authority.commit_catalog(records).unwrap();
            f.reopen();
            assert!(
                matches!(f.authority.engine_executable(&engine, PathOperation::EngineExecute), Err(Error::Conflict(message)) if message == "catalog install cleanup is in progress")
            );
            assert!(
                matches!(f.authority.engine_resource(&resource), Err(Error::Conflict(message)) if message == "catalog install cleanup is in progress")
            );
            assert!(tree.join("data/network").exists());
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users.is_empty()));
        }
    }

    #[test]
    fn catalog_install_cr6_missing_cleaning_reservation_refuses_reuse() {
        let mut f = cr6_cleaning_fixture();
        let moved = f.temp.path().join("moved-tree");
        fs::rename(f.root.join("managed"), &moved).unwrap();
        let mut stage = f.stage();
        assert!(
            matches!(f.publish_stage("managed", &mut stage), Err(Error::Conflict(message)) if message == "catalog install cleanup is in progress")
        );
        assert!(!f.root.join("managed").exists());
        assert!(stage.path().join("engine").exists());
        assert!(moved.join("engine").exists());
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.cleaning));
    }

    #[test]
    fn catalog_install_cr6_distinct_absent_leaf_is_not_cleaning_membership() {
        let mut f = cr6_cleaning_fixture();
        let moved = f.temp.path().join("moved-tree");
        fs::rename(f.root.join("managed"), &moved).unwrap();
        let original = f.authority.catalog_installs.clone();
        let mut stage = f.stage();
        f.publish_stage("other", &mut stage).unwrap();
        assert_eq!(f.authority.catalog_installs.len(), 2);
        for (id, record) in original {
            assert_eq!(f.authority.catalog_installs[&id], record);
            assert!(f.authority.catalog_protected.contains(&id));
        }
        assert!(!f.root.join("managed").exists());
        assert!(f.root.join("other/data/network").exists());
        assert!(moved.join("data/network").exists());
    }

    #[test]
    fn catalog_install_cr6_retained_uncertainty_keeps_unavailable_provenance() {
        let mut f = cr6_cleaning_fixture();
        let _engine = cr6_independent_engine(&mut f);
        let resource = f.resource(&f.temp.path().join("independent"), true);
        let original = f.authority.catalog_installs.clone();
        fs::rename(&f.root, f.temp.path().join("moved-root")).unwrap();
        f.reopen();
        f.reconcile(vec![resource.path_ref().clone()], true)
            .unwrap();
        assert_eq!(f.authority.catalog_installs, original);
    }

    #[test]
    fn catalog_install_cr6_unavailable_prepublication_resource_marks_new_tree() {
        let mut f = Fixture::new();
        let original_root = f.root.clone();
        let resource = f.resource(&original_root, true);
        drop(f.authority.engine_resource(&resource).unwrap());
        let moved = f.temp.path().join("moved-root");
        fs::rename(&f.root, &moved).unwrap();
        let moved = canonical_binding(&moved).unwrap();
        let binding = identity(&moved).unwrap();
        f.handle = f
            .authority
            .get_or_create_engine_root(
                &moved,
                "Moved root",
                Some(VerifiedIdentity::from_pair((binding.a, binding.b))),
            )
            .unwrap();
        f.root = f.authority.engine_root_path(&f.handle).unwrap();
        f.authority.set_active_engine_root(&f.handle).unwrap();
        assert!(f
            .authority
            .catalog_uses
            .keys()
            .any(|(path, _, _)| path == &original_root));
        f.install("later");
        let session = f.authority.catalog_session.clone();
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&session)));
        assert!(f.root.join("later/data/network").exists());
    }

    fn phase3_select_root(f: &mut Fixture, path: &Path) {
        let path = canonical_binding(path).unwrap();
        let binding = identity(&path).unwrap();
        f.handle = f
            .authority
            .get_or_create_engine_root(
                &path,
                "Moved root",
                Some(VerifiedIdentity::from_pair((binding.a, binding.b))),
            )
            .unwrap();
        f.root = f.authority.engine_root_path(&f.handle).unwrap();
        f.authority.set_active_engine_root(&f.handle).unwrap();
    }

    fn select_unrelated_workspace_for_cleanup(f: &mut Fixture) {
        // These locator tests must not retain a selected workspace's displaced historical
        // binding. Retire that selection natively, then let startup prune its unowned entry.
        let selected = f.temp.path().join("selected-workspace");
        fs::create_dir(&selected).unwrap();
        let handle = f
            .authority
            .get_or_create_engine_root(&selected, "Selected workspace", None)
            .unwrap();
        f.authority.set_active_engine_root(&handle).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn catalog_install_phase3_historical_directory_lease_retains_later_publication() {
        let mut f = Fixture::new();
        let original = f.root.clone();
        let resource = f.resource(&original, true);
        let lease = f.authority.engine_resource(&resource).unwrap();
        let leased = PathBuf::from(lease.uci_value().unwrap());
        let moved = f.temp.path().join("moved-root");
        fs::rename(&original, &moved).unwrap();
        fs::create_dir(&original).unwrap();
        phase3_select_root(&mut f, &moved);
        f.install("later");
        assert_eq!(
            fs::read(leased.join("later/data/network")).unwrap(),
            b"managed network"
        );
        let session = f.authority.catalog_session.clone();
        let persisted = PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
        assert!(persisted
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&session)));
        drop(persisted);
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(
            fs::read(leased.join("later/data/network")).unwrap(),
            b"managed network"
        );
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&session)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn catalog_install_phase3_repeated_path_bindings_are_distinct_and_admitted() {
        let mut f = Fixture::new();
        let spelling = f.root.clone();
        let first = f.resource(&spelling, true);
        let first_lease = f.authority.engine_resource(&first).unwrap();
        let first_moved = f.temp.path().join("first-root");
        fs::rename(&spelling, &first_moved).unwrap();
        fs::create_dir(&spelling).unwrap();
        let binding = identity(&spelling).unwrap();
        let id = f
            .authority
            .get_or_create_root(
                &spelling,
                "Second binding",
                vec![PathOperation::EngineResourceRead],
                "resource",
                Some(VerifiedIdentity::from_pair((binding.a, binding.b))),
            )
            .unwrap();
        let second = EngineResourceHandle::new(
            id,
            EngineResourceHandleKind::Directory,
            "Second binding".into(),
        );
        let before = f.authority.registry_admission_units();
        let second_lease = f.authority.engine_resource(&second).unwrap();
        assert_eq!(f.authority.catalog_uses.len(), 2);
        assert_eq!(f.authority.registry_admission_units(), before + 2);
        drop(f.authority.engine_resource(&second).unwrap());
        assert_eq!(
            f.authority.catalog_uses.len(),
            2,
            "same binding is deduplicated"
        );
        let second_moved = f.temp.path().join("second-root");
        fs::rename(&spelling, &second_moved).unwrap();
        fs::create_dir(&spelling).unwrap();
        phase3_select_root(&mut f, &first_moved);
        f.install("first");
        phase3_select_root(&mut f, &second_moved);
        f.install("second");
        let session = f.authority.catalog_session.clone();
        assert_eq!(f.authority.catalog_installs.len(), 2);
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(PathBuf::from(first_lease.uci_value().unwrap())
            .join("first/engine")
            .exists());
        assert!(PathBuf::from(second_lease.uci_value().unwrap())
            .join("second/engine")
            .exists());
    }

    #[test]
    fn catalog_install_phase3_terminal_component_identity_does_not_protect_sibling() {
        let mut f = Fixture::new();
        let root = f.root.clone();
        fs::create_dir(root.join("selected")).unwrap();
        let resource = f.resource(&root, true);
        let resolved = f
            .authority
            .resolve(
                resource.path_ref(),
                PathOperation::EngineResourceRead,
                &[OsString::from("selected")],
            )
            .unwrap();
        assert_eq!(
            opened_file_identity(resolved.directory().unwrap()).unwrap(),
            {
                let binding = identity(&root.join("selected")).unwrap();
                (binding.a, binding.b)
            }
        );
        f.install("sibling");
        assert!(
            f.authority
                .catalog_installs
                .values()
                .all(|record| record.users.is_empty()),
            "terminal directory use does not recursively own its workspace ancestor"
        );
    }

    #[test]
    fn catalog_install_phase3_file_resource_used_before_publication_gets_marker() {
        let mut f = Fixture::new();
        let mut stage = f.stage();
        let resource = f.resource(&stage.path().join("engine"), false);
        drop(f.authority.engine_resource(&resource).unwrap());
        f.publish_stage("later", &mut stage).unwrap();
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&f.authority.catalog_session)));
    }

    #[test]
    fn catalog_install_phase3_retained_binding_survives_path_replacement() {
        let mut f = Fixture::new();
        let original = f.root.clone();
        let resource = f.resource(&original, true);
        let moved = f.temp.path().join("moved-root");
        fs::rename(&original, &moved).unwrap();
        fs::create_dir(&original).unwrap();
        phase3_select_root(&mut f, &moved);
        f.install("later");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.is_empty()));
        f.reopen();
        f.reconcile(vec![resource.path_ref().clone()], true)
            .unwrap();
        assert!(f.root.join("later/data/network").exists());
        assert_eq!(f.authority.catalog_installs.len(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn catalog_install_phase3_historical_marker_failure_refuses_new_handoff() {
        for uncertain in [false, true] {
            let mut f = Fixture::new();
            let original = f.root.clone();
            let resource = f.resource(&original, true);
            let lease = f.authority.engine_resource(&resource).unwrap();
            let moved = f.temp.path().join("moved-root");
            fs::rename(&original, &moved).unwrap();
            fs::create_dir(&original).unwrap();
            phase3_select_root(&mut f, &moved);
            f.install("later");
            let origin = f.authority.catalog_session.clone();
            f.reopen();
            let nested = f.resource(&moved.join("later/data"), true);
            let fault: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(ParentSyncFault("historical marker sync"))
            } else {
                Arc::new(FileFault(AtomicFileFaultPoint::Write))
            };
            let guard = install_test_atomic_file_injector(fault);
            for _ in 0..2 {
                assert!(matches!(
                    f.authority.engine_resource(&nested),
                    Err(Error::Io(_) | Error::CommittedDurabilityUncertain(_))
                ));
            }
            drop(guard);
            drop(f.authority.engine_resource(&nested).unwrap());
            let current = f.authority.catalog_session.clone();
            f.reopen();
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users.contains(&origin) && record.users.contains(&current)));
            assert!(PathBuf::from(lease.uci_value().unwrap())
                .join("later/engine")
                .exists());
        }
    }

    #[test]
    fn catalog_install_phase3_existing_cleaning_tree_refuses_recursive_ancestor() {
        let mut f = cr6_cleaning_fixture();
        let root = f.root.clone();
        let resource = f.resource(&root, true);
        assert!(f.root.join("managed/engine").exists());
        assert!(
            matches!(f.authority.engine_resource(&resource), Err(Error::Conflict(message)) if message == "catalog install cleanup is in progress")
        );
    }

    #[cfg(target_os = "linux")]
    #[derive(Clone)]
    struct InheritedDirectoryChild {
        actor: Arc<crate::engine::EngineActor>,
        supervisor: Arc<crate::engine::EngineSupervisor>,
        value: String,
        resource: Option<EngineResourceHandle>,
    }

    #[cfg(target_os = "linux")]
    impl InheritedDirectoryChild {
        async fn spawn(f: &mut Fixture) -> Self {
            let path = f.root.clone();
            Self::spawn_resource(f, &path).await
        }

        async fn spawn_resource(f: &mut Fixture, path: &Path) -> Self {
            let resource = f.resource(path, true);
            let lease = Arc::new(f.authority.engine_resource(&resource).unwrap());
            let value = lease.uci_value().unwrap();
            let probe = f.temp.path().join("probe");
            fs::create_dir(&probe).unwrap();
            Self::spawn_image(
                f,
                &probe.join("resource-child"),
                Some((resource, lease)),
                value,
            )
            .await
        }

        async fn spawn_image(
            f: &mut Fixture,
            script: &Path,
            resource: Option<(EngineResourceHandle, Arc<EngineResourceLease>)>,
            value: String,
        ) -> Self {
            let (executable, engine) = Self::prepare_image(f, script);
            let executable = executable.with_resource_leases(
                resource
                    .as_ref()
                    .map(|(_, lease)| lease.clone())
                    .into_iter()
                    .collect(),
            );
            Self::spawn_prepared(
                executable,
                engine,
                resource.map(|(handle, _)| handle),
                value,
            )
            .await
        }

        fn prepare_image(f: &mut Fixture, script: &Path) -> (EngineExecutable, EngineHandle) {
            crate::infra::test_executable::publish_test_executable(script, b"#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) echo readyok;; setoption*) value=${line#*value }; cat \"$value\"; echo;; quit) exit 0;; esac; done\n", 0o700).unwrap();
            let engine = f
                .authority
                .register_engine_file(script, "Resource child")
                .unwrap();
            let executable = f
                .authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap();
            (executable, engine)
        }

        async fn spawn_prepared(
            executable: EngineExecutable,
            engine: EngineHandle,
            resource: Option<EngineResourceHandle>,
            value: String,
        ) -> Self {
            use crate::engine::{EngineActor, EngineDeadlines, EngineKey, EngineSupervisor};
            let key = EngineKey::new("historical-resource".into(), "child".into()).unwrap();
            let supervisor = Arc::new(EngineSupervisor::default());
            let actor = Arc::new(
                EngineActor::spawn_initialized(executable, EngineDeadlines::default())
                    .await
                    .unwrap(),
            );
            let registration = supervisor
                .replace_handle(
                    key,
                    actor.clone(),
                    "child".into(),
                    engine.path_ref().clone(),
                )
                .await;
            if let Err(error) = registration {
                let cleanup = actor.terminate().await;
                assert!(cleanup.is_ok(), "failed registration child must be reaped");
                panic!("resource child registration failed: {error:?}");
            }
            InheritedDirectoryChild {
                actor,
                supervisor,
                value,
                resource,
            }
        }

        async fn assert_network(&self) {
            self.assert_contents("later/data/network").await;
        }

        async fn assert_contents(&self, relative: &str) {
            self.assert_contents_equal(relative, "managed network")
                .await;
        }

        async fn assert_contents_equal(&self, relative: &str, expected: &str) {
            let value = format!("{}/{relative}", self.value);
            self.actor
                .set_option_with_resources("SyzygyPath", &value, std::slice::from_ref(&value))
                .await
                .unwrap();
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(2), self.actor.next_configuration_line())
                    .await
                    .unwrap()
                    .unwrap()
                    .as_deref(),
                Some(expected)
            );
        }

        async fn reap(&self) {
            let cleanup = self.supervisor.terminate_all().await;
            let fallback = self.actor.terminate().await;
            assert!(
                cleanup.is_ok(),
                "supervised child must be reaped: {cleanup:?}"
            );
            assert!(
                fallback.is_ok(),
                "actor reap must be confirmed: {fallback:?}"
            );
            eprintln!(
                "historical-resource child reaping confirmed before propagating test outcome"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_phase3_inherited_resource_child_survives_publication_and_restart() {
        let mut f = Fixture::new();
        let original = f.root.clone();
        let child = InheritedDirectoryChild::spawn(&mut f).await;
        // Observe worker panics only after the parent has confirmed physical child reaping.
        let outcome = tokio::spawn({
            let child = child.clone();
            async move {
                let moved = f.temp.path().join("moved-root");
                fs::rename(&original, &moved).unwrap();
                fs::create_dir(&original).unwrap();
                phase3_select_root(&mut f, &moved);
                f.install("later");
                child.assert_network().await;
                let session = f.authority.catalog_session.clone();
                assert!(f
                    .authority
                    .catalog_installs
                    .values()
                    .all(|record| record.users.contains(&session)));
                f.reopen();
                f.reconcile(vec![], true).unwrap();
                child.assert_network().await;
            }
        })
        .await;
        child.reap().await;
        outcome.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_phase4_three_sessions_preserve_prepublication_child_use() {
        let mut f = Fixture::new();
        let child = InheritedDirectoryChild::spawn(&mut f).await;
        let origin = f.authority.catalog_session.clone();
        assert!(f.authority.catalog_installs.is_empty());
        let outcome = tokio::spawn({
            let child = child.clone();
            async move {
                f.reopen();
                let publisher = f.authority.catalog_session.clone();
                assert_ne!(origin, publisher);
                f.authority
                    .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                        retained_ids: Some(vec![]),
                        abandoned_ids: vec![],
                        startup: true,
                    })
                    .unwrap();
                assert!(!f
                    .authority
                    .persistent
                    .contains_key(&child.resource.as_ref().unwrap().path_ref().id));
                assert!(f
                    .authority
                    .retired_attachments
                    .contains_key(&child.resource.as_ref().unwrap().path_ref().id));
                let image: serde_json::Value =
                    serde_json::from_slice(&fs::read(f.temp.path().join("registry.json")).unwrap())
                        .unwrap();
                assert!(!image["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(
                        |entry| entry["id"]["id"] == child.resource.as_ref().unwrap().path_ref().id
                    ));
                f.install("later");
                child.assert_network().await;
                finish_session(f.authority).await;
                f.authority =
                    PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
                assert_ne!(f.authority.catalog_session, publisher);
                assert!(!f
                    .authority
                    .persistent
                    .contains_key(&child.resource.as_ref().unwrap().path_ref().id));
                f.reconcile(vec![], true).unwrap();
                child.assert_network().await;
                assert_eq!(f.authority.catalog_installs.len(), 1);
                assert!(f
                    .authority
                    .catalog_installs
                    .values()
                    .all(|record| record.users.contains(&origin)
                        && !record.users.contains(&publisher)));
            }
        })
        .await;
        child.reap().await;
        outcome.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_repair5_replacement_before_spawn_uses_original_cwd() {
        let mut f = Fixture::new();
        f.install("replacement");
        let record = f
            .authority
            .catalog_installs
            .values()
            .next()
            .unwrap()
            .clone();
        let root_identity = identity(&f.root).unwrap();
        let root_parent_identity = identity(f.root.parent().unwrap()).unwrap();
        let original = f.temp.path().join("original-cwd");
        fs::create_dir_all(original.join("data")).unwrap();
        fs::write(original.join("data/network"), b"original cwd data").unwrap();
        let (executable, engine) =
            InheritedDirectoryChild::prepare_image(&mut f, &original.join("engine"));
        let original_binding = identity(&original).unwrap();
        assert!(f
            .authority
            .catalog_uses
            .iter()
            .any(
                |((_, a, b), sessions)| (*a, *b) == (original_binding.a, original_binding.b)
                    && sessions.get(&f.authority.catalog_session) == Some(&false)
            ));
        let moved = f.temp.path().join("moved-original");
        let replacement = f.root.join("replacement");
        fs::rename(&original, &moved).unwrap();
        fs::rename(&replacement, &original).unwrap();
        let child =
            InheritedDirectoryChild::spawn_prepared(executable, engine, None, ".".into()).await;
        let outcome = tokio::spawn({
            let child = child.clone();
            async move {
                assert!(child.resource.is_none());
                fs::rename(&original, &replacement).unwrap();
                fs::rename(&moved, &original).unwrap();
                assert_eq!(identity(&f.root).unwrap(), root_identity);
                assert_eq!(
                    identity(f.root.parent().unwrap()).unwrap(),
                    root_parent_identity
                );
                assert_eq!(identity(&replacement).unwrap(), record.identity);
                let directory =
                    open_verified_directory(&replacement, (record.identity.a, record.identity.b))
                        .unwrap()
                        .into_file();
                assert_eq!(
                    inventory(&directory, record.identity.a).unwrap(),
                    record.inventory
                );
                child
                    .assert_contents_equal("data/network", "original cwd data")
                    .await;
                f.reopen();
                f.authority
                    .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                        retained_ids: Some(vec![]),
                        abandoned_ids: vec![],
                        startup: true,
                    })
                    .unwrap();
                f.reconcile(vec![], true).unwrap();
                assert!(
                    !replacement.exists(),
                    "independent unchanged replacement must remain collectible"
                );
                child
                    .assert_contents_equal("data/network", "original cwd data")
                    .await;
                assert_eq!(
                    fs::read(original.join("data/network")).unwrap(),
                    b"original cwd data"
                );
            }
        })
        .await;
        child.reap().await;
        outcome.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_repair5_moved_missing_cwd_before_spawn_uses_original_object() {
        let mut f = Fixture::new();
        let original = f.temp.path().join("original-cwd");
        fs::create_dir_all(original.join("data")).unwrap();
        fs::write(original.join("data/network"), b"original cwd data").unwrap();
        let (executable, engine) =
            InheritedDirectoryChild::prepare_image(&mut f, &original.join("engine"));
        let moved = f.temp.path().join("moved-original");
        fs::rename(&original, &moved).unwrap();
        assert!(!original.exists());
        let child =
            InheritedDirectoryChild::spawn_prepared(executable, engine, None, ".".into()).await;
        let outcome = tokio::spawn({
            let child = child.clone();
            async move {
                child
                    .assert_contents_equal("data/network", "original cwd data")
                    .await
            }
        })
        .await;
        child.reap().await;
        outcome.unwrap();
    }

    #[test]
    fn catalog_install_phase4_zero_install_handoff_requires_durability_and_retry() {
        for uncertain in [false, true] {
            let mut f = Fixture::new();
            let root = f.root.clone();
            let resource = f.resource(&root, true);
            let fault: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(ParentSyncFault("zero-install use sync"))
            } else {
                Arc::new(FileFault(AtomicFileFaultPoint::Write))
            };
            let guard = install_test_atomic_file_injector(fault);
            for _ in 0..2 {
                assert!(matches!(
                    f.authority.engine_resource(&resource),
                    Err(Error::Io(_) | Error::CommittedDurabilityUncertain(_))
                ));
                assert!(f.authority.catalog_installs.is_empty());
            }
            drop(guard);
            drop(f.authority.engine_resource(&resource).unwrap());
            let origin = f.authority.catalog_session.clone();
            f.reopen();
            f.install("later");
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users.contains(&origin)));
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_context1_eligibility_rechecks_completed_ancestor_substitution() {
        let mut f = Fixture::new();
        let outer = f.temp.path().join("outer");
        let container = outer.join("container");
        let root = container.join("engines");
        fs::create_dir_all(&root).unwrap();
        phase3_select_root(&mut f, &root);
        let leased = f.temp.path().join("leased");
        fs::create_dir(&leased).unwrap();
        let child = InheritedDirectoryChild::spawn_resource(&mut f, &leased).await;
        let origin = f.authority.catalog_session.clone();
        let outcome = tokio::spawn({
            let child = child.clone();
            async move {
                f.reopen();
                f.authority
                    .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                        retained_ids: Some(vec![]),
                        abandoned_ids: vec![],
                        startup: true,
                    })
                    .unwrap();
                assert!(!f
                    .authority
                    .persistent
                    .contains_key(&child.resource.as_ref().unwrap().path_ref().id));
                f.install("later");
                let record = f
                    .authority
                    .catalog_installs
                    .values()
                    .next()
                    .unwrap()
                    .clone();
                assert!(
                    !record.users.contains(&origin),
                    "publication must be unrelated to A"
                );
                assert!(f
                    .authority
                    .catalog_uses
                    .iter()
                    .all(|((path, a, b), sessions)| {
                        !sessions.contains_key(&origin)
                            || reaches(
                                &record,
                                path,
                                sessions[&origin],
                                Some(&Identity { a: *a, b: *b }),
                            )
                            .unwrap()
                                == Reachability::Disjoint
                    }));
                let root_identity = identity(&f.root).unwrap();
                let parent_identity = identity(&container).unwrap();
                let original_path = f.root.clone();
                finish_session(f.authority).await;
                let displaced = f.temp.path().join("displaced-outer");
                fs::rename(&outer, &displaced).unwrap();
                fs::rename(&leased, &outer).unwrap();
                fs::rename(displaced.join("container"), &container).unwrap();
                assert_eq!(f.root, original_path);
                assert_eq!(identity(&f.root).unwrap(), root_identity);
                assert_eq!(identity(&container).unwrap(), parent_identity);
                assert_eq!(identity(&f.root.join("later")).unwrap(), record.identity);
                let directory = open_verified_directory(
                    &f.root.join("later"),
                    (record.identity.a, record.identity.b),
                )
                .unwrap()
                .into_file();
                assert_eq!(
                    inventory(&directory, record.identity.a).unwrap(),
                    record.inventory
                );
                f.authority =
                    PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
                assert!(f
                    .authority
                    .catalog_installs
                    .values()
                    .all(|r| !r.users.contains(&origin)));
                f.reconcile(vec![], true).unwrap();
                child
                    .assert_contents("container/engines/later/data/network")
                    .await;
                assert!(f.root.join("later/data/network").exists());
                assert_eq!(f.authority.catalog_installs.len(), 1);
            }
        })
        .await;
        child.reap().await;
        outcome.unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_context1_stale_file_nodes_do_not_own_unrelated_installs() {
        for replacement in [false, true] {
            let mut f = Fixture::new();
            let path = f.temp.path().join("network.nnue");
            fs::write(&path, b"original leased bytes").unwrap();
            let resource = f.resource(&path, false);
            let lease = f.authority.engine_resource(&resource).unwrap();
            let origin = f.authority.catalog_session.clone();
            f.reopen();
            f.authority
                .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                    retained_ids: Some(vec![]),
                    abandoned_ids: vec![],
                    startup: true,
                })
                .unwrap();
            fs::remove_file(&path).unwrap();
            if replacement {
                fs::write(&path, b"independent replacement").unwrap();
            }
            f.install("later");
            let projected = f
                .authority
                .catalog_installs
                .values()
                .any(|record| record.users.contains(&origin));
            finish_session(f.authority).await;
            f.authority = PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
            f.reconcile(vec![], true).unwrap();
            assert_eq!(
                fs::read(PathBuf::from(lease.uci_value().unwrap())).unwrap(),
                b"original leased bytes"
            );
            assert!(
                !f.root.join("later").exists(),
                "a stale file node retained an unrelated managed install"
            );
            assert!(
                !projected,
                "a stale file node cannot own unrelated managed objects"
            );
            assert!(f
                .authority
                .catalog_uses
                .values()
                .any(|sessions| sessions.contains_key(&origin)));
            assert_eq!(
                fs::read(PathBuf::from(lease.uci_value().unwrap())).unwrap(),
                b"original leased bytes"
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_context1_removed_image_cwd_keeps_relative_data_without_resource() {
        let mut f = Fixture::new();
        let mut stage = f.stage();
        let image = stage.path().join("engine");
        let child = InheritedDirectoryChild::spawn_image(&mut f, &image, None, ".".into()).await;
        let origin = f.authority.catalog_session.clone();
        let outcome = tokio::spawn({
            let child = child.clone();
            async move {
                assert!(child.resource.is_none());
                let image_identity = identity(&image).unwrap();
                let cwd_identity = identity(stage.path()).unwrap();
                fs::remove_file(&image).unwrap();
                f.publish_stage("later", &mut stage).unwrap();
                let record = f.authority.catalog_installs.values().next().unwrap();
                assert_eq!(record.identity, cwd_identity);
                assert!(record
                    .inventory
                    .iter()
                    .all(|entry| entry.identity != image_identity));
                f.reopen();
                f.authority
                    .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                        retained_ids: Some(vec![]),
                        abandoned_ids: vec![],
                        startup: true,
                    })
                    .unwrap();
                f.reconcile(vec![], true).unwrap();
                child.assert_contents("data/network").await;
                assert!(f
                    .authority
                    .catalog_installs
                    .values()
                    .all(|record| record.users.contains(&origin)));
                assert!(f
                    .authority
                    .catalog_uses
                    .iter()
                    .any(
                        |((_, a, b), sessions)| (*a, *b) == (cwd_identity.a, cwd_identity.b)
                            && sessions.get(&origin) == Some(&false)
                    ));
            }
        })
        .await;
        child.reap().await;
        outcome.unwrap();
    }

    #[test]
    fn catalog_install_context1_added_file_membership_still_refuses_cleaning() {
        let mut f = Fixture::new();
        f.install("managed");
        let added = f.root.join("managed/data/user-network");
        fs::write(&added, b"user data").unwrap();
        let resource = f.resource(&added, false);
        let mut records = f.authority.catalog_installs.clone();
        records.values_mut().next().unwrap().cleaning = true;
        f.authority.commit_catalog(records).unwrap();
        f.reopen();
        assert!(
            matches!(f.authority.engine_resource(&resource), Err(Error::Conflict(message)) if message == "catalog install cleanup is in progress")
        );
        assert_eq!(fs::read(&added).unwrap(), b"user data");
    }

    #[test]
    fn catalog_install_context1_image_and_cwd_are_one_durable_handoff() {
        struct CountWrites(std::sync::atomic::AtomicUsize);
        impl AtomicWriterInjector for CountWrites {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::Write {
                    self.0.fetch_add(1, Ordering::SeqCst);
                }
                Ok(())
            }
        }
        for fault in [None, Some(false), Some(true)] {
            let mut f = Fixture::new();
            let engine = cr6_independent_engine(&mut f);
            let registered = &f.authority.persistent[&engine.path_ref().id].stored;
            let image = registered.path.to_path().unwrap();
            let image_binding = registered.identity.clone();
            let cwd = image.parent().unwrap().to_path_buf();
            let cwd_binding = registered.parent_identity.clone().unwrap();
            let origin = f.authority.catalog_session.clone();
            let counter = Arc::new(CountWrites(std::sync::atomic::AtomicUsize::new(0)));
            let injector: Arc<dyn AtomicWriterInjector + Send + Sync> = match fault {
                None => counter.clone(),
                Some(false) => Arc::new(FileFault(AtomicFileFaultPoint::Write)),
                Some(true) => Arc::new(ParentSyncFault("multi-context use sync")),
            };
            let guard = install_test_atomic_file_injector(injector);
            if fault.is_some() {
                for _ in 0..2 {
                    assert!(matches!(
                        f.authority
                            .engine_executable(&engine, PathOperation::EngineExecute),
                        Err(Error::Io(_) | Error::CommittedDurabilityUncertain(_))
                    ));
                }
            } else {
                drop(
                    f.authority
                        .engine_executable(&engine, PathOperation::EngineExecute)
                        .unwrap(),
                );
                assert_eq!(
                    counter.0.load(Ordering::SeqCst),
                    1,
                    "all contexts must enter one atomic write"
                );
            }
            drop(guard);
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            let disk: Registry =
                serde_json::from_slice(&fs::read(f.temp.path().join("registry.json")).unwrap())
                    .unwrap();
            let uses = decode_uses(disk.catalog_uses).unwrap();
            for (path, binding) in [(&cwd, &cwd_binding), (&image, &image_binding)] {
                assert_eq!(identity(path).unwrap(), *binding);
                assert_eq!(
                    uses[&(path.clone(), binding.a, binding.b)].get(&origin),
                    Some(&false)
                );
            }
            assert_eq!(uses.len(), 2);
            assert!(disk.catalog_installs.is_empty());
        }
    }

    #[test]
    fn catalog_install_context1_directory_read_uses_actual_terminal_scope() {
        let mut f = Fixture::new();
        fs::create_dir(f.root.join("selected")).unwrap();
        let grant = f
            .authority
            .grant_dialog(
                &f.root,
                "Directory",
                PathClass::BoundedDialogGrant,
                PathOperation::EngineResourceRead,
                Duration::from_secs(30),
                2,
            )
            .unwrap();
        // A transient root has no EngineResource purpose. Its terminal directory still supplies
        // explicit resource contents, while the unselected workspace siblings remain independent.
        let resolved = f
            .authority
            .resolve(
                &grant,
                PathOperation::EngineResourceRead,
                &[OsString::from("selected")],
            )
            .unwrap();
        let binding = opened_file_identity(resolved.directory().unwrap()).unwrap();
        let key = (f.root.join("selected"), binding.0, binding.1);
        assert!(f.authority.catalog_uses[&key][&f.authority.catalog_session]);
        f.install("sibling");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.is_empty()));
        phase3_select_root(&mut f, &key.0);
        f.install("nested");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .filter(|record| target(record).unwrap() == f.root.join("nested"))
            .all(|record| record.users.contains(&f.authority.catalog_session)));
        assert_eq!(f.authority.catalog_installs.len(), 2);
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_context1_node_exclusion_still_preserves_changed_inventory() {
        let mut f = Fixture::new();
        let path = f.temp.path().join("network.nnue");
        fs::write(&path, b"original leased bytes").unwrap();
        let resource = f.resource(&path, false);
        let lease = f.authority.engine_resource(&resource).unwrap();
        let binding = identity(&path).unwrap();
        let origin = f.authority.catalog_session.clone();
        f.reopen();
        f.authority
            .reconcile_engine_attachments(EngineAttachmentAction::Reconcile {
                retained_ids: Some(vec![]),
                abandoned_ids: vec![],
                startup: true,
            })
            .unwrap();
        f.install("later");
        let record = f.authority.catalog_installs.values().next().unwrap();
        assert!(!record.users.contains(&origin));
        let added = f.root.join("later/data/user-network");
        fs::hard_link(&path, &added).unwrap();
        fs::remove_file(&path).unwrap();
        assert_eq!(
            reaches(record, &path, false, Some(&binding)).unwrap(),
            Reachability::Disjoint
        );
        finish_session(f.authority).await;
        f.authority = PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
        f.reconcile(vec![], true).unwrap();
        // Negative node evidence cannot bypass the independent complete-inventory check.
        assert!(f.authority.catalog_installs.is_empty());
        assert_eq!(fs::read(&added).unwrap(), b"original leased bytes");
        assert_eq!(
            fs::read(f.root.join("later/data/network")).unwrap(),
            b"managed network"
        );
        assert_eq!(
            fs::read(PathBuf::from(lease.uci_value().unwrap())).unwrap(),
            b"original leased bytes"
        );
    }

    #[test]
    fn catalog_install_phase4_recursive_broadening_is_durable_and_monotonic() {
        for uncertain in [false, true] {
            let mut f = Fixture::new();
            let image = f.root.join("probe-image");
            fs::write(&image, b"engine image").unwrap();
            let engine = f.authority.register_engine_file(&image, "Image").unwrap();
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            let origin = f.authority.catalog_session.clone();
            let binding = identity(&f.root).unwrap();
            let key = (f.root.clone(), binding.a, binding.b);
            assert!(!f.authority.catalog_uses[&key][&origin]);
            let resource = f.resource(&f.root.clone(), true);
            let fault: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(ParentSyncFault("recursive use sync"))
            } else {
                Arc::new(FileFault(AtomicFileFaultPoint::Write))
            };
            let guard = install_test_atomic_file_injector(fault);
            for _ in 0..2 {
                assert!(matches!(
                    f.authority.engine_resource(&resource),
                    Err(Error::Io(_) | Error::CommittedDurabilityUncertain(_))
                ));
            }
            drop(guard);
            drop(f.authority.engine_resource(&resource).unwrap());
            let count = f.authority.registry_admission_units();
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            assert_eq!(f.authority.registry_admission_units(), count);
            f.reopen();
            assert_eq!(f.authority.catalog_uses.len(), 2);
            assert!(f.authority.catalog_uses[&key][&origin]);
            f.install("later");
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users.contains(&origin)));
        }
    }

    #[test]
    fn catalog_install_phase4_clear_owns_only_its_session_and_rolls_back_both_states() {
        for uncertain in [false, true] {
            let mut f = Fixture::new();
            let resource = f.resource(&f.root.clone(), true);
            drop(f.authority.engine_resource(&resource).unwrap());
            let origin = f.authority.catalog_session.clone();
            f.reopen();
            let publisher = f.authority.catalog_session.clone();
            drop(f.authority.engine_resource(&resource).unwrap());
            f.install("later");
            let uses = f.authority.catalog_uses.clone();
            let records = f.authority.catalog_installs.clone();
            let fault: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(ParentSyncFault("session clear sync"))
            } else {
                Arc::new(FileFault(AtomicFileFaultPoint::Write))
            };
            let guard = install_test_atomic_file_injector(fault);
            assert!(matches!(
                f.authority.clear_catalog_session_use(),
                Err(Error::Io(_) | Error::CommittedDurabilityUncertain(_))
            ));
            assert_eq!(f.authority.catalog_uses, uses);
            assert_eq!(f.authority.catalog_installs, records);
            let disk: Registry =
                serde_json::from_slice(&fs::read(f.temp.path().join("registry.json")).unwrap())
                    .unwrap();
            let disk_uses = decode_uses(disk.catalog_uses).unwrap();
            let sessions = disk_uses.values().next().unwrap();
            assert!(sessions.contains_key(&origin));
            assert_eq!(sessions.contains_key(&publisher), !uncertain);
            assert!(disk
                .catalog_installs
                .values()
                .all(|record| record.users.contains(&origin)
                    && record.users.contains(&publisher) == !uncertain));
            drop(guard);
            f.authority.clear_catalog_session_use().unwrap();
            f.reopen();
            assert_eq!(
                f.authority
                    .catalog_uses
                    .values()
                    .next()
                    .unwrap()
                    .keys()
                    .collect::<Vec<_>>(),
                vec![&origin]
            );
            // C has no authority to discharge A, even after owner pruning.
            f.authority.clear_catalog_session_use().unwrap();
            f.reconcile(vec![], true).unwrap();
            f.reopen();
            assert!(f.root.join("later/data/network").exists());
            assert!(f.authority.catalog_uses.values().all(|sessions| sessions
                .contains_key(&origin)
                && !sessions.contains_key(&publisher)));
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users == BTreeSet::from([origin.clone()])));
        }
    }

    #[test]
    fn catalog_install_phase4_legacy_absence_preserves_unknown_install_users_without_grant() {
        let mut f = Fixture::new();
        f.install("old");
        let engine = f.engine("old");
        drop(
            f.authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap(),
        );
        let origin = f.authority.catalog_session.clone();
        let registry_path = f.temp.path().join("registry.json");
        let mut registry: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        registry.as_object_mut().unwrap().remove("catalog_uses");
        fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
        f.reopen();
        assert!(f.authority.catalog_uses.is_empty());
        f.authority.clear_catalog_session_use().unwrap();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("old/data/network").exists());
        assert!(f
            .authority
            .engine_executable(&engine, PathOperation::EngineExecute)
            .is_err());
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&origin)));
    }

    #[test]
    fn catalog_install_phase4_registry_rejects_malformed_and_oversized_use_evidence() {
        let mut f = Fixture::new();
        let resource = f.resource(&f.root.clone(), true);
        drop(f.authority.engine_resource(&resource).unwrap());
        let registry_path = f.temp.path().join("registry.json");
        let original: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        let template = encode_uses(&f.authority.catalog_uses).pop().unwrap();
        let mut cases = Vec::new();
        let mut record = template.clone();
        record.path = NativePath::from_path(Path::new("relative"));
        cases.push(("relative native path", vec![record]));
        let mut record = template.clone();
        let mut traversal = f.root.as_os_str().to_os_string();
        traversal.push(format!("{0}..{0}elsewhere", std::path::MAIN_SEPARATOR));
        record.path = NativePath::from_path(Path::new(&traversal));
        assert!(record
            .path
            .to_path()
            .unwrap()
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir)));
        cases.push(("raw native traversal", vec![record]));
        let mut record = template.clone();
        record.identity = Identity { a: 0, b: 0 };
        cases.push(("zero identity", vec![record]));
        let mut record = template.clone();
        record.sessions = BTreeMap::from([("invalid-session".into(), true)]);
        cases.push(("invalid session UUID", vec![record]));
        let mut record = template.clone();
        record.sessions.clear();
        cases.push(("empty sessions", vec![record]));
        #[cfg(unix)]
        {
            let mut record = template.clone();
            record.path = NativePath::Unix {
                bytes: "invalid!".into(),
            };
            cases.push(("invalid native base64 encoding", vec![record]));
        }
        let mut record = template.clone();
        let mut invalid_contents = f.root.as_os_str().to_os_string();
        invalid_contents.push(std::path::MAIN_SEPARATOR_STR);
        invalid_contents.push("invalid\0contents");
        record.path = NativePath::from_path(Path::new(&invalid_contents));
        cases.push(("invalid native NUL contents", vec![record]));
        let mut record = template.clone();
        #[cfg(windows)]
        {
            record.path = NativePath::Unix {
                bytes: "invalid!".into(),
            };
        }
        #[cfg(unix)]
        {
            record.path = NativePath::Windows {
                utf16: vec![b'C' as u16, b':' as u16, b'\\' as u16],
            };
        }
        cases.push(("foreign platform encoding", vec![record]));
        cases.push((
            "duplicate binding",
            vec![template.clone(), template.clone()],
        ));
        let mut record = template.clone();
        record.sessions = (0..MAX_AUTHORITY_IDS)
            .map(|_| (Uuid::new_v4().to_string(), true))
            .collect();
        cases.push(("excess session count", vec![record]));
        cases.push((
            "excess record count",
            vec![template.clone(); MAX_AUTHORITY_IDS + 1],
        ));
        let mut record = template;
        record.path = NativePath::from_path(&f.root.join("x".repeat(MAX_REGISTRY_BYTES)));
        cases.push(("excess encoded bytes", vec![record]));
        for (label, records) in cases {
            let mut registry = original.clone();
            registry["catalog_uses"] = serde_json::to_value(records).unwrap();
            fs::write(&registry_path, serde_json::to_vec(&registry).unwrap()).unwrap();
            let result = PathAuthority::open(registry_path.clone(), vec![]);
            assert!(
                matches!(
                    &result,
                    Err(Error::InvalidInput(_) | Error::ResourceLimit(_))
                ),
                "{label}: {:?}",
                result.as_ref().err()
            );
        }
    }

    #[test]
    fn catalog_install_phase4_shared_capacity_refuses_new_binding_and_reuses_durable_use() {
        let started = std::time::Instant::now();
        let mut f = Fixture::new();
        let resources = f.temp.path().join("resources");
        fs::create_dir(&resources).unwrap();
        let existing_path = resources.join("r0");
        fs::create_dir(&existing_path).unwrap();
        fs::write(existing_path.join("authorized"), b"durable contents").unwrap();
        let overflow_path = resources.join("overflow");
        fs::create_dir(&overflow_path).unwrap();
        fs::write(overflow_path.join("authorized"), b"new contents").unwrap();
        let _root = f.resource(&resources, true);
        let canonical_resources = f.authority.persistent[&_root.path_ref().id]
            .stored
            .path
            .to_path()
            .unwrap();
        let existing = f.resource(&existing_path, true);
        let overflow = f.resource(&overflow_path, true);
        let mut uses = f.authority.catalog_uses.clone();
        let available = MAX_AUTHORITY_IDS - f.authority.registry_admission_units();
        assert_eq!(available % 2, 0);
        for index in 0..available / 2 {
            let name = format!("r{index}");
            let path = canonical_resources.join(&name);
            if index != 0 {
                fs::create_dir(&path).unwrap();
            }
            let binding = identity(&path).unwrap();
            uses.insert(
                (path, binding.a, binding.b),
                BTreeMap::from([(f.authority.catalog_session.clone(), true)]),
            );
        }
        f.authority
            .commit_catalog_state(f.authority.catalog_installs.clone(), uses, false)
            .unwrap();
        let inspected = PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
        assert_eq!(inspected.catalog_uses, f.authority.catalog_uses);
        assert_eq!(inspected.registry_admission_units(), MAX_AUTHORITY_IDS);
        drop(inspected);
        eprintln!(
            "native capacity fixture: {} bindings, {} admission units, setup {:?}",
            f.authority.catalog_uses.len(),
            f.authority.registry_admission_units(),
            started.elapsed()
        );
        assert!(
            matches!(
                f.authority.engine_resource(&overflow),
                Err(Error::ResourceLimit(_))
            ),
            "new binding crossed shared admission at {}",
            f.authority.registry_admission_units()
        );
        let lease = f.authority.engine_resource(&existing).unwrap();
        assert_eq!(
            fs::read(PathBuf::from(lease.uci_value().unwrap()).join("authorized")).unwrap(),
            b"durable contents"
        );
        assert_eq!(f.authority.registry_admission_units(), MAX_AUTHORITY_IDS);
    }

    #[test]
    fn catalog_install_upgrade_restart_reclaims_only_unowned_versions_and_releases_capacity() {
        let mut f = Fixture::new();
        for version in 0..8 {
            let name = format!("digest-{version}");
            f.install(&name);
            let engine = f.engine(&name);
            f.reconcile(vec![], true).unwrap();
            assert!(
                f.root.join(&name).exists(),
                "installation is protected during this session"
            );
            f.authority.clear_catalog_session_use().unwrap();
            f.reopen();
            // Duplicate engines and either saved player's identical native handle retain the tree.
            f.reconcile(vec![engine.path_ref().clone(); 3], true)
                .unwrap();
            assert!(f.root.join(&name).exists());
            assert_eq!(f.authority.catalog_installs.len(), 1);
            assert!(f.authority.catalog_admission_count() <= 1);
        }
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.authority.catalog_installs.is_empty());
        assert!(fs::read_dir(&f.root).unwrap().next().is_none());
    }

    #[test]
    fn catalog_install_adoption_never_mints_or_replaces_provenance() {
        let mut f = Fixture::new();
        fs::create_dir(f.root.join("legacy")).unwrap();
        fs::write(f.root.join("legacy/keep"), b"user").unwrap();
        let mut stage = f.stage();
        assert!(matches!(
            f.publish_stage("legacy", &mut stage),
            Err(Error::Conflict(_))
        ));
        assert!(f.authority.catalog_installs.is_empty());
        f.install("managed");
        let original = f.authority.catalog_installs.clone();
        let mut stage = f.stage();
        assert!(matches!(
            f.publish_stage("managed", &mut stage),
            Err(Error::Conflict(_))
        ));
        assert_eq!(f.authority.catalog_installs, original);
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("legacy/keep").exists());
        assert!(!f.root.join("managed").exists());
    }

    #[test]
    fn catalog_install_untrusted_owners_and_explicit_resources_keep_trees() {
        for ancestor in [false, true] {
            let mut f = Fixture::new();
            f.install("old");
            f.reopen();
            f.reconcile(vec![], false).unwrap();
            assert!(f.root.join("old/data/network").exists());
            let path = if ancestor {
                f.root.clone()
            } else {
                f.root.join("old/data/network")
            };
            let resource = f.resource(&path, ancestor);
            f.reopen();
            f.reconcile(vec![resource.path_ref().clone()], true)
                .unwrap();
            assert!(f.root.join("old/data/network").exists());
        }
    }

    #[test]
    fn catalog_install_session_markers_survive_reopen_and_only_originating_session_clears() {
        let mut f = Fixture::new();
        f.install("old");
        let engine = f.engine("old");
        let origin = f.authority.catalog_session.clone();
        let executable = f
            .authority
            .engine_executable(&engine, PathOperation::EngineConfigure)
            .unwrap();
        f.install("new");
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("old/data/network").exists());
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(
            f.root.join("old/data/network").exists(),
            "unconfirmed shutdown cannot end child use"
        );
        f.authority.clear_catalog_session_use().unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(
            f.authority.catalog_installs.values().next().unwrap().users,
            BTreeSet::from([origin])
        );
        assert!(f.root.join("old/engine").exists());
        drop(executable);
    }

    #[test]
    fn catalog_install_successful_shutdown_clears_use_durably_for_next_restart() {
        let mut f = Fixture::new();
        f.install("old");
        let engine = f.engine("old");
        let executable = f
            .authority
            .engine_executable(&engine, PathOperation::EngineExecute)
            .unwrap();
        drop(executable);
        f.authority.clear_catalog_session_use().unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(!f.root.join("old").exists());
    }

    #[tokio::test]
    async fn catalog_install_production_shutdown_durably_clears_only_after_success() {
        for outcome in ["success", "failure", "timeout"] {
            let mut f = Fixture::new();
            f.install("old");
            let engine = f.engine("old");
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            let session = f.authority.catalog_session.clone();
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users.contains(&session)));
            let authority = SharedPathAuthority::installed(f.authority);
            let supervisor = crate::engine::EngineSupervisor::default();
            let games = crate::game::GameManager::new();
            let operations = crate::infra::operations::OperationRegistry::default();
            let budget = if outcome == "timeout" {
                Duration::from_millis(100)
            } else {
                Duration::from_secs(5)
            };
            let teardown = crate::shutdown_backend_with_attachments(
                &supervisor,
                &games,
                None,
                &operations,
                async {
                    match outcome {
                        "failure" => Err("catalog teardown refused".into()),
                        "timeout" => std::future::pending().await,
                        _ => Ok(()),
                    }
                },
                std::future::ready(Ok(())),
                budget,
            );
            assert_eq!(
                crate::shutdown_with_catalog_authority(teardown, authority.clone(), budget).await,
                outcome == "success"
            );
            assert!(operations.prepare_download("after-shutdown").is_err());
            drop(authority);
            f.authority = PathAuthority::open(f.temp.path().join("registry.json"), vec![]).unwrap();
            assert_eq!(
                f.authority
                    .catalog_installs
                    .values()
                    .any(|record| record.users.contains(&session)),
                outcome != "success"
            );
            f.reconcile(vec![], true).unwrap();
            assert_eq!(
                f.root.join("old/data/network").exists(),
                outcome != "success"
            );
        }
    }

    #[cfg(unix)]
    fn alias_catalog_locator(f: &mut Fixture) {
        let alias = f.temp.path().join("alias");
        std::os::unix::fs::symlink(f.temp.path().parent().unwrap(), &alias).unwrap();
        let root = alias
            .join(f.temp.path().file_name().unwrap())
            .join("engines");
        let binding = identity(&f.root).unwrap();
        assert_eq!(identity(&root).unwrap(), binding);
        // This is only supplemental retention evidence. Cleanup retains its independent
        // no-follow boundary and is never authorized through this alias.
        let mut records = f.authority.catalog_installs.clone();
        for record in records.values_mut() {
            record.root.path = NativePath::from_path(&root);
        }
        f.authority.commit_catalog(records).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_filesystem_alias_retained_executable_and_recursive_ancestor() {
        for recursive in [false, true] {
            let mut f = Fixture::new();
            f.install("old");
            let retained = if recursive {
                let root = f.root.clone();
                f.resource(&root, true).path_ref().clone()
            } else {
                f.engine("old").path_ref().clone()
            };
            f.authority.clear_catalog_session_use().unwrap();
            alias_catalog_locator(&mut f);
            f.reopen();
            let record = f.authority.catalog_installs.values().next().unwrap();
            let entry = &f.authority.persistent[&retained.id].stored;
            assert!(entry_reaches(record, entry).unwrap().protects());
            f.reconcile(vec![retained], true).unwrap();
            assert!(f.root.join("old/data/network").exists());
            assert_eq!(f.authority.catalog_installs.len(), 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_filesystem_alias_current_session_use_is_durable() {
        let mut f = Fixture::new();
        f.install("old");
        let engine = f.engine("old");
        f.authority.clear_catalog_session_use().unwrap();
        alias_catalog_locator(&mut f);
        f.reopen();
        drop(
            f.authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap(),
        );
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&f.authority.catalog_session)));
        f.reconcile(vec![], true).unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("old/data/network").exists());
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_filesystem_alias_prepublication_ancestor_use_is_durable() {
        let mut f = Fixture::new();
        let root = f.root.clone();
        let resource = f.resource(&root, true);
        let lease = f.authority.engine_resource(&resource).unwrap();
        let renamed = f.temp.path().join("renamed");
        fs::rename(&root, &renamed).unwrap();
        std::os::unix::fs::symlink(&renamed, &root).unwrap();
        assert_eq!(
            fs::canonicalize(&root).unwrap(),
            fs::canonicalize(&renamed).unwrap()
        );
        // Model the root's new spelling while preserving the earlier successful resource use.
        f.authority
            .persistent
            .get_mut(&f.handle.path_ref().id)
            .unwrap()
            .stored
            .path = NativePath::from_path(&renamed);
        f.root = renamed;
        f.install("later");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&f.authority.catalog_session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("later/data/network").exists());
        drop(lease);
    }

    #[test]
    fn catalog_install_filesystem_bindings_keep_disjoint_paths_and_uncertainty_conservative() {
        let temp = tempfile::tempdir().unwrap();
        let lower = temp.path().join("engines");
        let upper = temp.path().join("Engines");
        fs::create_dir(&lower).unwrap();
        let relation = |tree: &Path, path: &Path, recursive| {
            let expected_tree = identity(tree).unwrap_or(Identity { a: 0, b: 0 });
            let expected_root = identity(tree.parent().unwrap()).unwrap();
            filesystem_reaches(tree, &expected_tree, &expected_root, path, recursive, None)
                .unwrap_or(Reachability::Uncertain)
        };
        if !upper.exists() {
            fs::create_dir(&upper).unwrap();
            assert_eq!(relation(&lower, &upper, true), Reachability::Disjoint);
        }
        let unrelated = temp.path().join("unrelated");
        fs::create_dir(&unrelated).unwrap();
        assert_eq!(relation(&lower, &unrelated, true), Reachability::Disjoint);
        assert_eq!(
            relation(&lower.join("missing-install"), &lower, true),
            Reachability::Member
        );
        assert_eq!(
            relation(&lower.join("missing-install"), &unrelated, true),
            Reachability::Disjoint
        );
        assert_eq!(
            relation(&lower, &temp.path().join("unavailable/leaf"), false),
            Reachability::Uncertain
        );
        let file = lower.join("file");
        let alias = unrelated.join("file-alias");
        fs::write(&file, b"binding").unwrap();
        fs::hard_link(&file, &alias).unwrap();
        assert!(
            relation(&file, &alias, false) == Reachability::Member,
            "existing leaf aliases use identity, not canonical strings"
        );
    }

    #[test]
    fn catalog_install_inventory_digest_enforces_cumulative_cap_and_checked_accounting() {
        let f = Fixture::new();
        let stage = f.stage();
        let binding = identity(stage.path()).unwrap();
        let directory = open_verified_directory(stage.path(), (binding.a, binding.b))
            .unwrap()
            .into_file();
        for mut bytes in [MAX_INVENTORY_BYTES - 1, u64::MAX] {
            let error = walk(
                &directory,
                Path::new(""),
                binding.a,
                &mut bytes,
                &mut Vec::new(),
                &mut vec![0; 64 * 1024],
            )
            .unwrap_err();
            assert!(
                matches!(error, Error::ResourceLimit(ref message) if message == "catalog inventory content limit reached"),
                "{error:?}"
            );
        }
    }

    #[cfg(windows)]
    fn rename_case_alias(f: &mut Fixture) -> bool {
        let renamed = f.temp.path().join("Engines");
        fs::rename(&f.root, &renamed).unwrap();
        if !f.root.exists() {
            eprintln!("case-sensitive fixture filesystem, case-alias runtime scenario skipped");
            return false;
        }
        assert_eq!(identity(&f.root).unwrap(), identity(&renamed).unwrap());
        f.root = renamed;
        true
    }

    #[cfg(windows)]
    #[test]
    fn catalog_install_windows_case_rename_retained_executable_and_recursive_ancestor() {
        for recursive in [false, true] {
            let mut f = Fixture::new();
            f.install("old");
            let engine = f.engine("old");
            f.authority.clear_catalog_session_use().unwrap();
            if !rename_case_alias(&mut f) {
                continue;
            }
            let retained = if recursive {
                let root = f.root.clone();
                f.resource(&root, true).path_ref().clone()
            } else {
                engine.path_ref().clone()
            };
            f.reopen();
            f.reconcile(vec![retained], true).unwrap();
            assert!(f.root.join("old/data/network").exists());
        }
    }

    #[cfg(windows)]
    #[test]
    fn catalog_install_windows_case_rename_current_session_use() {
        let mut f = Fixture::new();
        f.install("old");
        let engine = f.engine("old");
        f.authority.clear_catalog_session_use().unwrap();
        if !rename_case_alias(&mut f) {
            return;
        }
        f.reopen();
        drop(
            f.authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap(),
        );
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&f.authority.catalog_session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("old/data/network").exists());
    }

    #[cfg(windows)]
    #[test]
    fn catalog_install_windows_case_rename_prepublication_ancestor_use() {
        let mut f = Fixture::new();
        let root = f.root.clone();
        let resource = f.resource(&root, true);
        let lease = f.authority.engine_resource(&resource).unwrap();
        // Windows pins the selected directory against rename while the descriptor is held.
        // Session reachability must outlive that descriptor for the rest of this process.
        drop(lease);
        if !rename_case_alias(&mut f) {
            return;
        }
        f.authority
            .persistent
            .get_mut(&f.handle.path_ref().id)
            .unwrap()
            .stored
            .path = NativePath::from_path(&f.root);
        f.install("later");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&f.authority.catalog_session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("later/data/network").exists());
    }

    #[test]
    fn catalog_install_ancestor_resource_used_before_publication_gets_durable_marker() {
        let mut f = Fixture::new();
        let root = f.root.clone();
        let resource = f.resource(&root, true);
        let lease = f.authority.engine_resource(&resource).unwrap();
        f.install("later");
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.users.contains(&f.authority.catalog_session)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("later/data/network").exists());
        drop(lease);
    }

    #[test]
    fn catalog_install_marker_write_failure_or_uncertainty_refuses_handoff() {
        for uncertain in [false, true] {
            let mut f = Fixture::new();
            f.install("managed");
            let engine = f.engine("managed");
            f.authority.clear_catalog_session_use().unwrap();
            f.reopen();
            let fault: Arc<dyn AtomicWriterInjector + Send + Sync> = if uncertain {
                Arc::new(ParentSyncFault("catalog marker sync"))
            } else {
                Arc::new(FileFault(AtomicFileFaultPoint::Write))
            };
            let guard = install_test_atomic_file_injector(fault);
            assert!(f
                .authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .is_err());
            if uncertain {
                assert!(
                    f.authority
                        .engine_executable(&engine, PathOperation::EngineExecute)
                        .is_err(),
                    "an uncertain marker cannot be reused without durable retry"
                );
            }
            drop(guard);
            let executable = f
                .authority
                .engine_executable(&engine, PathOperation::EngineExecute)
                .unwrap();
            drop(executable);
        }
    }

    #[test]
    fn catalog_install_registry_faults_abort_before_publication_and_reload_truthfully() {
        for point in [
            AtomicFileFaultPoint::Write,
            AtomicFileFaultPoint::Rename,
            AtomicFileFaultPoint::ParentSync,
        ] {
            let mut f = Fixture::new();
            let mut stage = f.stage();
            let guard = install_test_atomic_file_injector(Arc::new(FileFault(point)));
            assert!(f.publish_stage("managed", &mut stage).is_err());
            assert!(!f.root.join("managed").exists());
            drop(guard);
            f.reopen();
            assert_eq!(
                f.authority.catalog_installs.len(),
                usize::from(point == AtomicFileFaultPoint::ParentSync)
            );
            f.reconcile(vec![], true).unwrap();
            assert!(f.authority.catalog_installs.is_empty());
        }
    }

    #[test]
    fn catalog_install_publication_rename_and_sync_faults_keep_provenance() {
        for point in [
            AtomicDirFaultPoint::InstallRename,
            AtomicDirFaultPoint::ParentSync,
        ] {
            let mut f = Fixture::new();
            let mut stage = f.stage();
            let _reset = DirFaultReset;
            set_test_atomic_dir_injector(Some(Box::new(DirFault(point))));
            assert!(f.publish_stage("managed", &mut stage).is_err());
            assert_eq!(
                f.root.join("managed").exists(),
                point == AtomicDirFaultPoint::ParentSync
            );
            set_test_atomic_dir_injector(None);
            f.reopen();
            assert_eq!(f.authority.catalog_installs.len(), 1);
            f.reconcile(vec![], true).unwrap();
            assert!(f.authority.catalog_installs.is_empty());
            assert!(!f.root.join("managed").exists());
        }
    }

    #[test]
    fn catalog_install_user_changes_relinquish_ownership_without_removal() {
        for change in ["addition", "edit", "missing", "replacement"] {
            let mut f = Fixture::new();
            f.install("managed");
            let tree = f.root.join("managed");
            match change {
                "addition" => fs::write(tree.join("user-file"), b"keep").unwrap(),
                "edit" => fs::write(tree.join("data/network"), b"edited").unwrap(),
                "missing" => fs::remove_file(tree.join("engine")).unwrap(),
                _ => {
                    fs::rename(tree.join("engine"), f.root.join("old-inode")).unwrap();
                    fs::write(tree.join("engine"), b"managed engine").unwrap();
                }
            }
            f.reopen();
            f.reconcile(vec![], true).unwrap();
            assert!(tree.exists(), "{change}");
            assert!(f.authority.catalog_installs.is_empty(), "{change}");
        }
    }

    #[test]
    fn catalog_install_replacement_root_publication_preserves_each_exact_binding() {
        let mut f = Fixture::new();
        f.install("same");
        let old_binding = f
            .authority
            .catalog_installs
            .values()
            .next()
            .unwrap()
            .root
            .identity
            .clone();
        let detached = f.temp.path().join("original-root");
        fs::rename(&f.root, &detached).unwrap();
        fs::create_dir(&f.root).unwrap();
        let new_binding = validate_target(&f.root, PathClass::PersistentCustomRoot).unwrap();
        f.handle = f
            .authority
            .get_or_create_engine_root(
                &f.root,
                "Recovered engines",
                Some(VerifiedIdentity::from_pair((new_binding.a, new_binding.b))),
            )
            .unwrap();
        f.root = f.authority.engine_root_path(&f.handle).unwrap();
        f.authority.set_active_engine_root(&f.handle).unwrap();
        f.install("same");
        assert_eq!(f.authority.catalog_installs.len(), 2);
        assert!(f
            .authority
            .catalog_installs
            .values()
            .any(|record| record.root.identity == old_binding));
        f.reopen();
        assert!(
            f.reconcile(vec![], true).is_err(),
            "the unavailable original root remains retryable"
        );
        assert_eq!(f.authority.catalog_installs.len(), 1);
        assert!(!f.root.join("same").exists());
        assert!(detached.join("same/engine").exists());
        fs::remove_dir(&f.root).unwrap();
        fs::rename(detached, &f.root).unwrap();
        select_unrelated_workspace_for_cleanup(&mut f);
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(!f.root.join("same").exists());
        assert!(f.authority.catalog_installs.is_empty());
    }

    #[test]
    fn catalog_install_root_substitution_retains_locator_and_tree_substitution_completes_record() {
        let mut f = Fixture::new();
        f.install("managed");
        let detached = f.temp.path().join("detached-root");
        fs::rename(&f.root, &detached).unwrap();
        fs::create_dir(&f.root).unwrap();
        fs::create_dir(f.root.join("managed")).unwrap();
        fs::write(f.root.join("managed/foreign"), b"foreign").unwrap();
        select_unrelated_workspace_for_cleanup(&mut f);
        f.reopen();
        assert!(f.reconcile(vec![], true).is_err());
        assert_eq!(f.authority.catalog_installs.len(), 1);
        assert!(detached.join("managed/engine").exists());
        assert!(f.root.join("managed/foreign").exists());
        fs::remove_file(f.root.join("managed/foreign")).unwrap();
        fs::remove_dir(f.root.join("managed")).unwrap();
        fs::remove_dir(&f.root).unwrap();
        fs::rename(detached, &f.root).unwrap();
        fs::rename(f.root.join("managed"), f.root.join("original-tree")).unwrap();
        fs::create_dir(f.root.join("managed")).unwrap();
        fs::write(f.root.join("managed/foreign"), b"foreign").unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.authority.catalog_installs.is_empty());
        assert!(f.root.join("managed/foreign").exists());
        assert!(f.root.join("original-tree/engine").exists());
    }

    #[test]
    fn catalog_install_legacy_registry_and_malformed_records_are_checked() {
        let mut f = Fixture::new();
        let path = f.temp.path().join("registry.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("catalog_installs");
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        f.reopen();
        assert!(f.authority.catalog_installs.is_empty());
        f.install("managed");
        let valid = f.authority.catalog_installs.clone();
        for malformed in ["destination", "inventory", "root", "users"] {
            let mut records = valid.clone();
            let record = records.values_mut().next().unwrap();
            match malformed {
                "destination" => {
                    record.destination = NativePath::from_path(Path::new("../outside"))
                }
                "inventory" => {
                    record.inventory = vec![record.inventory[0].clone(); MAX_INVENTORY_ENTRIES + 1]
                }
                "root" => record.root.purpose = Some(EntryPurpose::EngineResource),
                _ => {
                    record.users.insert("not-a-session".into());
                }
            }
            assert!(validate_records(&records).is_err(), "{malformed}");
            let mut value = serde_json::to_value(&value).unwrap();
            value["catalog_installs"] = serde_json::to_value(&records).unwrap();
            fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(
                PathAuthority::open(path.clone(), vec![]).is_err(),
                "{malformed}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_partial_removal_refuses_reinstall_then_restart_retries_and_fresh_install_works(
    ) {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        let mut f = Fixture::new();
        f.install("managed");
        f.reopen();
        let guard = scoped_test_removal_injector(Arc::new(RemovalFault(
            RemovalFaultPoint::AfterEntryRemoved,
        )));
        assert!(matches!(
            f.reconcile(vec![], true),
            Err(Error::PartialRemoval { .. })
        ));
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.cleaning));
        drop(guard);
        let mut stage = f.stage();
        assert!(matches!(
            f.publish_stage("managed", &mut stage),
            Err(Error::Conflict(_))
        ));
        assert!(f
            .authority
            .persistent
            .values()
            .all(|entry| entry.stored.purpose != Some(EntryPurpose::EngineExecutable)));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(!f.root.join("managed").exists());
        f.install("managed");
        let engine = f.engine("managed");
        f.authority.clear_catalog_session_use().unwrap();
        f.reopen();
        f.reconcile(vec![engine.path_ref().clone()], true).unwrap();
        let executable = f
            .authority
            .engine_executable(&engine, PathOperation::EngineExecute)
            .unwrap();
        drop(executable);
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_deletion_and_parent_sync_failures_retain_retry_state() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        for point in [
            RemovalFaultPoint::BeforeTopOpen,
            RemovalFaultPoint::ParentSync,
        ] {
            let mut f = Fixture::new();
            f.install("managed");
            f.reopen();
            let guard = scoped_test_removal_injector(Arc::new(RemovalFault(point)));
            let error = f.reconcile(vec![], true).unwrap_err();
            assert_eq!(
                f.root.join("managed").exists(),
                point == RemovalFaultPoint::BeforeTopOpen
            );
            if point == RemovalFaultPoint::ParentSync {
                assert!(matches!(error, Error::CommittedDurabilityUncertain(_)));
            }
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.cleaning));
            drop(guard);
            f.reopen();
            f.reconcile(vec![], true).unwrap();
            assert!(f.authority.catalog_installs.is_empty());
        }
    }

    #[test]
    fn catalog_install_cleanup_state_write_failure_keeps_complete_tree() {
        let mut f = Fixture::new();
        f.install("managed");
        f.reopen();
        f.reconcile(vec![], false).unwrap();
        require_durable(
            f.authority
                .reconcile_startup_owners(StartupPathOwners {
                    retained_ids: vec![],
                    trusted_families: vec![PathOwnerFamily::Engines],
                })
                .unwrap(),
        )
        .unwrap();
        let guard =
            install_test_atomic_file_injector(Arc::new(FileFault(AtomicFileFaultPoint::Write)));
        assert!(f.authority.collect_catalog_installs().is_err());
        assert!(f.root.join("managed/engine").exists());
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| !record.cleaning));
        drop(guard);
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(!f.root.join("managed").exists());
    }

    #[test]
    fn catalog_install_retained_direct_consumer_and_failed_owner_commit_keep_tree() {
        let mut f = Fixture::new();
        f.install("managed");
        let book = f
            .authority
            .register_opening_book(&f.root.join("managed/data/network"), "Book")
            .unwrap();
        f.reopen();
        f.reconcile(vec![book.path_ref().clone()], true).unwrap();
        assert!(f.root.join("managed/engine").exists());
        f.reopen();
        let guard =
            install_test_atomic_file_injector(Arc::new(FileFault(AtomicFileFaultPoint::Write)));
        assert!(f
            .authority
            .reconcile_startup_owners(StartupPathOwners {
                retained_ids: vec![],
                trusted_families: vec![PathOwnerFamily::Engines, PathOwnerFamily::OpeningBook],
            })
            .is_err());
        f.authority.collect_catalog_installs().unwrap();
        assert!(f.root.join("managed/data/network").exists());
        drop(guard);
        require_durable(
            f.authority
                .reconcile_startup_owners(StartupPathOwners {
                    retained_ids: vec![],
                    trusted_families: vec![PathOwnerFamily::Engines, PathOwnerFamily::OpeningBook],
                })
                .unwrap(),
        )
        .unwrap();
        f.authority.collect_catalog_installs().unwrap();
        assert!(!f.root.join("managed").exists());
    }

    #[test]
    fn catalog_install_failed_or_uncertain_clear_retains_origin_markers_for_retry() {
        for point in [
            AtomicFileFaultPoint::Write,
            AtomicFileFaultPoint::ParentSync,
        ] {
            let mut f = Fixture::new();
            f.install("managed");
            let engine = f.engine("managed");
            drop(
                f.authority
                    .engine_executable(&engine, PathOperation::EngineExecute)
                    .unwrap(),
            );
            let guard = install_test_atomic_file_injector(Arc::new(FileFault(point)));
            assert!(f.authority.clear_catalog_session_use().is_err());
            assert!(f
                .authority
                .catalog_installs
                .values()
                .all(|record| record.users.contains(&f.authority.catalog_session)));
            drop(guard);
            f.authority.clear_catalog_session_use().unwrap();
            f.reopen();
            f.reconcile(vec![], true).unwrap();
            assert!(!f.root.join("managed").exists());
        }
    }

    #[test]
    fn catalog_install_completion_registry_failure_reopens_missing_tree_idempotently() {
        struct CompletionFault(std::sync::atomic::AtomicUsize);
        impl AtomicWriterInjector for CompletionFault {
            fn inject(&self, point: AtomicFileFaultPoint) -> std::io::Result<()> {
                if point == AtomicFileFaultPoint::Write
                    && self.0.fetch_add(1, Ordering::SeqCst) >= 1
                {
                    Err(std::io::Error::other("catalog completion write failed"))
                } else {
                    Ok(())
                }
            }
        }
        let mut f = Fixture::new();
        f.install("managed");
        f.reopen();
        let guard = install_test_atomic_file_injector(Arc::new(CompletionFault(
            std::sync::atomic::AtomicUsize::new(0),
        )));
        assert!(f.reconcile(vec![], true).is_err());
        assert!(!f.root.join("managed").exists());
        assert!(f
            .authority
            .catalog_installs
            .values()
            .all(|record| record.cleaning));
        drop(guard);
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.authority.catalog_installs.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_modified_partial_cleanup_preserves_files_and_refuses_both_adoption_paths() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalFault, RemovalFaultPoint};
        let mut f = Fixture::new();
        f.install("managed");
        // Preserve a resolution from before cleanup to exercise serialized publication adoption.
        let resolved = f
            .authority
            .resolve(
                f.handle.path_ref(),
                PathOperation::DownloadArchive,
                &[OsString::from("managed")],
            )
            .unwrap();
        f.reopen();
        let guard = scoped_test_removal_injector(Arc::new(RemovalFault(
            RemovalFaultPoint::AfterEntryRemoved,
        )));
        assert!(matches!(
            f.reconcile(vec![], true),
            Err(Error::PartialRemoval { .. })
        ));
        drop(guard);
        fs::write(f.root.join("managed/user-addition"), b"keep").unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(
            fs::read(f.root.join("managed/user-addition")).unwrap(),
            b"keep"
        );
        let mut stage = f.stage();
        assert!(matches!(
            f.publish_stage("managed", &mut stage),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            f.authority
                .publish_catalog_install(f.handle.path_ref(), &resolved, &mut stage.owner),
            Err(Error::Conflict(_))
        ));
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.root.join("managed/user-addition").exists());
        assert!(matches!(
            f.publish_stage("managed", &mut stage),
            Err(Error::Conflict(_))
        ));
    }

    #[cfg(windows)]
    #[test]
    fn catalog_install_reparse_addition_preserves_foreign_target() {
        let mut f = Fixture::new();
        f.install("managed");
        let foreign = f.temp.path().join("foreign");
        fs::create_dir(&foreign).unwrap();
        fs::write(foreign.join("keep"), b"keep").unwrap();
        crate::infra::fs::windows_test_junction(&f.root.join("managed/link"), &foreign);
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(fs::read(foreign.join("keep")).unwrap(), b"keep");
        assert!(f.root.join("managed/engine").exists());
        assert!(f.authority.catalog_installs.is_empty());
    }

    #[test]
    fn catalog_install_inventory_admission_refuses_excess_entries_before_publication() {
        let mut f = Fixture::new();
        let mut stage = f.stage();
        for index in 0..MAX_INVENTORY_ENTRIES {
            fs::write(stage.path().join(format!("entry-{index}")), b"").unwrap();
        }
        let error = f.publish_stage("too-large", &mut stage).unwrap_err();
        assert!(
            matches!(error.unlabelled(), Error::ResourceLimit(_)),
            "{}",
            error.diagnostic()
        );
        assert!(!f.root.join("too-large").exists());
        assert!(f.authority.catalog_installs.is_empty());
    }

    #[tokio::test]
    async fn catalog_install_startup_command_retains_unavailable_root_without_failing_reconciliation(
    ) {
        use tauri::Manager;
        let mut f = Fixture::new();
        f.install("managed");
        let detached = f.temp.path().join("detached");
        fs::rename(&f.root, &detached).unwrap();
        f.reopen();
        let state = crate::AppState::default();
        state.pgn_path_authority.install(f.authority).unwrap();
        let app = tauri::test::mock_app();
        app.manage(state.clone());
        crate::reconcile_startup_path_owners(
            StartupPathOwners {
                retained_ids: vec![],
                trusted_families: vec![PathOwnerFamily::Engines],
            },
            app.state::<crate::AppState>(),
        )
        .await
        .unwrap();
        assert!(detached.join("managed/data/network").exists());
        state
            .pgn_path_authority
            .with_mut(|authority| {
                assert_eq!(authority.catalog_installs.len(), 1);
                assert!(authority
                    .completed_owner_families
                    .contains(&PathOwnerFamily::Engines));
            })
            .unwrap();
        fs::rename(detached, &f.root).unwrap();
        crate::reconcile_startup_path_owners(
            StartupPathOwners {
                retained_ids: vec![],
                trusted_families: vec![PathOwnerFamily::Engines],
            },
            app.state::<crate::AppState>(),
        )
        .await
        .unwrap();
        assert!(!f.root.join("managed").exists());
    }

    #[test]
    fn catalog_install_admission_bounds_records_inventory_and_bytes_before_rename() {
        let mut f = Fixture::new();
        f.install("seed");
        let template = f
            .authority
            .catalog_installs
            .values()
            .next()
            .unwrap()
            .clone();
        let count = MAX_AUTHORITY_IDS - f.authority.persistent.len();
        let records = (0..count)
            .map(|index| {
                let mut record = template.clone();
                record.destination = NativePath::from_path(Path::new(&format!("reserved-{index}")));
                (Uuid::new_v4().to_string(), record)
            })
            .collect();
        f.authority.commit_catalog(records).unwrap();
        let mut stage = f.stage();
        assert!(matches!(
            f.publish_stage("overflow", &mut stage),
            Err(Error::ResourceLimit(_))
        ));
        assert!(!f.root.join("overflow").exists());
        f.authority.commit_catalog(BTreeMap::new()).unwrap();
        let mut oversized = template;
        oversized.root.display_name = "x".repeat(MAX_REGISTRY_BYTES);
        let records = BTreeMap::from([(Uuid::new_v4().to_string(), oversized)]);
        assert!(matches!(
            f.authority.commit_catalog(records),
            Err(Error::ResourceLimit(_))
        ));
        assert!(f.authority.catalog_installs.is_empty());
        f.install("after-capacity-release");
    }

    #[test]
    fn catalog_install_repeated_aborted_missing_target_publications_bound_protection() {
        let mut f = Fixture::new();
        for _ in 0..32 {
            let mut stage = f.stage();
            let _reset = DirFaultReset;
            set_test_atomic_dir_injector(Some(Box::new(DirFault(
                AtomicDirFaultPoint::InstallRename,
            ))));
            assert!(f.publish_stage("aborted", &mut stage).is_err());
            assert!(!f.root.join("aborted").exists());
            assert_eq!(f.authority.catalog_installs.len(), 1);
            assert_eq!(f.authority.catalog_protected.len(), 1);
            assert_eq!(f.authority.registry_admission_units(), 2);
        }
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert!(f.authority.catalog_installs.is_empty());
        assert!(f.authority.catalog_protected.is_empty());
        f.install("fresh");
        assert!(f.root.join("fresh/data/network").exists());
    }

    #[test]
    fn catalog_install_concurrent_publication_adopts_winner_identity() {
        let mut f = Fixture::new();
        let stages = [f.stage(), f.stage()];
        fs::write(stages[1].path().join("engine"), b"second staged engine").unwrap();
        let resolved = [0, 1].map(|_| {
            f.authority
                .resolve(
                    f.handle.path_ref(),
                    PathOperation::DownloadArchive,
                    &[OsString::from("same")],
                )
                .unwrap()
        });
        let authority = SharedPathAuthority::installed(f.authority);
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let threads = stages
            .into_iter()
            .zip(resolved)
            .map(|(mut stage, resolved)| {
                let authority = authority.clone();
                let destination = f.handle.path_ref().clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    crate::fs::publish_engine_archive_tree(
                        &authority,
                        &destination,
                        &resolved,
                        &mut stage.owner,
                    )
                })
            })
            .collect::<Vec<_>>();
        barrier.wait();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(Error::Conflict(_))))
                .count(),
            1
        );
        authority
            .with_mut(|authority| {
                assert_eq!(authority.catalog_installs.len(), 1);
                let record = authority.catalog_installs.values().next().unwrap();
                let directory = open_verified_directory(
                    &f.root.join("same"),
                    (record.identity.a, record.identity.b),
                )
                .unwrap()
                .into_file();
                assert_eq!(
                    inventory(&directory, record.identity.a).unwrap().len(),
                    record.inventory.len()
                );
                assert!(inventory(&directory, record.identity.a)
                    .unwrap()
                    .iter()
                    .all(|entry| record.inventory.contains(entry)));
            })
            .unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn catalog_install_mount_refusal_precedes_deletion_and_retains_record() {
        use crate::infra::fs::{scoped_test_removal_injector, RemovalInjector};
        struct Mount;
        impl RemovalInjector for Mount {
            fn statx_mount_attributes(
                &self,
                _: std::os::fd::RawFd,
            ) -> Option<std::io::Result<(u64, u64)>> {
                let mount = rustix::fs::StatxAttributes::MOUNT_ROOT.bits();
                Some(Ok((mount, mount)))
            }
        }
        let mut f = Fixture::new();
        f.install("managed");
        f.reopen();
        let guard = scoped_test_removal_injector(Arc::new(Mount));
        assert!(f.reconcile(vec![], true).is_err());
        assert!(f.root.join("managed/engine").exists());
        assert_eq!(f.authority.catalog_installs.len(), 1);
        drop(guard);
        f.reconcile(vec![], true).unwrap();
        assert!(!f.root.join("managed").exists());
    }

    #[test]
    fn catalog_install_depth_refusal_keeps_record_and_foreign_contents() {
        let mut f = Fixture::new();
        f.install("managed");
        let mut deep = f.root.join("managed");
        for _ in 0..MAX_REMOVE_TREE_DEPTH {
            deep = deep.join("deep");
            fs::create_dir(&deep).unwrap();
        }
        fs::write(deep.join("foreign"), b"keep").unwrap();
        f.reopen();
        assert!(matches!(
            f.reconcile(vec![], true),
            Err(Error::ResourceLimit(_))
        ));
        assert!(deep.join("foreign").exists());
        assert_eq!(f.authority.catalog_installs.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn catalog_install_symlink_addition_preserves_foreign_target() {
        let mut f = Fixture::new();
        f.install("managed");
        let foreign = f.temp.path().join("foreign");
        fs::write(&foreign, b"keep").unwrap();
        std::os::unix::fs::symlink(&foreign, f.root.join("managed/link")).unwrap();
        f.reopen();
        f.reconcile(vec![], true).unwrap();
        assert_eq!(fs::read(foreign).unwrap(), b"keep");
        assert!(f.root.join("managed/engine").exists());
        assert!(f.authority.catalog_installs.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn catalog_install_running_uci_game_survives_upgrade_and_unconfirmed_restart() {
        use crate::engine::{EngineActor, EngineDeadlines, EngineSupervisor, GoMode};
        let mut f = Fixture::new();
        let mut stage = f.stage();
        crate::infra::test_executable::publish_test_executable(stage.path().join("engine"),
            b"#!/bin/sh\nwhile IFS= read -r line; do case \"$line\" in uci) echo uciok;; isready) if [ -f data/network ]; then echo readyok; else exit 3; fi;; go*) echo 'bestmove e2e4';; quit) exit 0;; esac; done\n", 0o700).unwrap();
        f.publish_stage("old", &mut stage).unwrap();
        let old = f.engine("old");
        let executable = f
            .authority
            .engine_executable(&old, PathOperation::EngineExecute)
            .unwrap();
        let actor = Arc::new(
            EngineActor::spawn_initialized(executable, EngineDeadlines::default())
                .await
                .unwrap(),
        );
        let supervisor = EngineSupervisor::default();
        let key = crate::game::game_side_engine_key("catalog-game", 1, "white", "owner").unwrap();
        supervisor
            .replace_handle(
                key.clone(),
                actor.clone(),
                "owner".into(),
                old.path_ref().clone(),
            )
            .await
            .unwrap();
        f.install("new");
        let new = f.engine("new");
        supervisor
            .retire_engine_binary(
                "owner".into(),
                old.path_ref().clone(),
                new.path_ref().clone(),
            )
            .await
            .unwrap();
        f.reconcile(vec![new.path_ref().clone()], true).unwrap();
        f.reopen();
        f.reconcile(vec![new.path_ref().clone()], true).unwrap();
        assert!(f.root.join("old/data/network").exists());
        actor.ensure_ready().await.unwrap();
        let request = actor.start_search(&GoMode::Depth(1)).await.unwrap();
        assert_eq!(
            actor.next_search_line(request).await.unwrap().as_deref(),
            Some("bestmove e2e4")
        );
        assert!(supervisor.get_exact(&key).is_some());
        supervisor.terminate_all().await.unwrap();
        f.authority.clear_catalog_session_use().unwrap();
        f.reopen();
        f.reconcile(vec![new.path_ref().clone()], true).unwrap();
        assert!(
            f.root.join("old/data/network").exists(),
            "later sessions cannot erase unresolved origin use"
        );
    }
}
