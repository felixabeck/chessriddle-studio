//! Close fixture writers before any pthread fork can inherit their descriptors.

use std::{
    cell::Cell,
    ffi::CString,
    fs::File,
    io,
    os::{fd::AsRawFd, unix::ffi::OsStrExt},
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        OnceLock,
    },
};

static PUBLICATIONS: AtomicUsize = AtomicUsize::new(0);
static FORKS: AtomicUsize = AtomicUsize::new(0);
static INSTALL: OnceLock<i32> = OnceLock::new();

// Register before test threads can enter glibc's prepare-handler walk.
#[cfg(target_os = "linux")]
#[used]
#[unsafe(no_mangle)]
#[unsafe(link_section = ".init_array")]
static CHESSFABLE_TEST_EXECUTABLE_INIT: extern "C" fn() = {
    extern "C" fn initialize() {
        install_handlers();
    }
    initialize
};

// Only the proof's selected publisher stops. Other test threads can still publish.
static HOLD_PUBLICATION: AtomicBool = AtomicBool::new(false);
static PUBLICATION_HELD: AtomicBool = AtomicBool::new(false);
static HOLD_PREPARE: AtomicBool = AtomicBool::new(false);
static PREPARE_HELD: AtomicBool = AtomicBool::new(false);
static PUBLISHER_WAITING: AtomicBool = AtomicBool::new(false);
thread_local! {
    static INSTALL_FAILURE: Cell<i32> = const { Cell::new(0) };
    static PROOF_PUBLISHER: Cell<bool> = const { Cell::new(false) };
}

extern "C" fn prepare() {
    FORKS.fetch_add(1, Ordering::SeqCst);
    while PUBLICATIONS.load(Ordering::SeqCst) != 0 {
        std::hint::spin_loop();
    }
    if HOLD_PREPARE.load(Ordering::SeqCst) {
        PREPARE_HELD.store(true, Ordering::SeqCst);
        while HOLD_PREPARE.load(Ordering::SeqCst) {
            std::hint::spin_loop();
        }
    }
}

extern "C" fn parent() {
    FORKS.fetch_sub(1, Ordering::SeqCst);
}

extern "C" fn child() {
    FORKS.store(0, Ordering::SeqCst);
    PUBLICATIONS.store(0, Ordering::SeqCst);
}

fn install_handlers() -> i32 {
    // Registration returns an error number directly, rather than setting errno.
    *INSTALL
        .get_or_init(|| unsafe { libc::pthread_atfork(Some(prepare), Some(parent), Some(child)) })
}

fn install() -> io::Result<()> {
    let failure = INSTALL_FAILURE.get();
    if failure != 0 {
        return Err(io::Error::from_raw_os_error(failure));
    }
    let result = install_handlers();
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(result))
    }
}

struct Publication;

impl Publication {
    fn enter(proof: bool) -> Self {
        loop {
            while FORKS.load(Ordering::SeqCst) != 0 {
                if proof {
                    PUBLISHER_WAITING.store(true, Ordering::SeqCst);
                }
                std::hint::spin_loop();
            }
            PUBLICATIONS.fetch_add(1, Ordering::SeqCst);
            if FORKS.load(Ordering::SeqCst) == 0 {
                return Self;
            }
            PUBLICATIONS.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

impl Drop for Publication {
    fn drop(&mut self) {
        PUBLICATIONS.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Writer(libc::c_int);

impl Drop for Writer {
    fn drop(&mut self) {
        if self.0 >= 0 {
            // Never retry close: an interrupted close can already have released the fd.
            unsafe {
                libc::close(self.0);
            }
        }
    }
}

fn finish(mut writer: Writer, bytes: &[u8], mode: u32, proof: bool) -> io::Result<()> {
    if proof && HOLD_PUBLICATION.load(Ordering::SeqCst) {
        PUBLICATION_HELD.store(true, Ordering::SeqCst);
        while HOLD_PUBLICATION.load(Ordering::SeqCst) {
            std::hint::spin_loop();
        }
    }
    let written = unsafe { libc::write(writer.0, bytes.as_ptr().cast(), bytes.len()) };
    if written < 0 {
        return Err(io::Error::last_os_error());
    }
    if written as usize != bytes.len() {
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
    if unsafe { libc::fchmod(writer.0, mode as libc::mode_t) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let fd = writer.0;
    writer.0 = -1;
    if unsafe { libc::close(fd) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn publish_test_executable(
    path: impl AsRef<Path>,
    bytes: impl AsRef<[u8]>,
    mode: u32,
) -> io::Result<()> {
    let path = CString::new(path.as_ref().as_os_str().as_bytes())?;
    let bytes = bytes.as_ref().to_vec();
    install()?;
    let proof = PROOF_PUBLISHER.get();
    let _publication = Publication::enter(proof);
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_CREAT | libc::O_WRONLY | libc::O_TRUNC | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    finish(Writer(fd), &bytes, mode, proof)
}

/// The caller has validated the relative archive path and ensured its parent directories.
pub(crate) fn publish_test_archive_entry(
    directory: &File,
    relative: &Path,
    bytes: &[u8],
) -> io::Result<()> {
    let relative = CString::new(relative.as_os_str().as_bytes())?;
    let bytes = bytes.to_vec();
    install()?;
    let proof = PROOF_PUBLISHER.get();
    let _publication = Publication::enter(proof);
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            relative.as_ptr(),
            libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600 as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    finish(Writer(fd), &bytes, 0o600, proof)
}

pub(crate) mod tests {
    use super::*;
    use std::{
        io::Read,
        sync::Mutex,
        time::{Duration, Instant},
    };
    #[cfg(target_os = "linux")]
    use std::{io::Write, os::unix::fs::PermissionsExt};

    const SCRIPT: &[u8] = b"#!/bin/sh\nexit 0\n";
    static SERIAL: Mutex<()> = Mutex::new(());

    #[cfg(target_os = "linux")]
    #[test]
    fn test_executable_handlers_are_installed_before_test_threads() {
        assert_eq!(INSTALL.get(), Some(&0));
    }

    struct ResetHolds;
    impl Drop for ResetHolds {
        fn drop(&mut self) {
            HOLD_PUBLICATION.store(false, Ordering::SeqCst);
            HOLD_PREPARE.store(false, Ordering::SeqCst);
        }
    }

    fn reset() -> ResetHolds {
        PUBLICATION_HELD.store(false, Ordering::SeqCst);
        PREPARE_HELD.store(false, Ordering::SeqCst);
        PUBLISHER_WAITING.store(false, Ordering::SeqCst);
        ResetHolds
    }

    fn wait_for(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate() {
            assert!(Instant::now() < deadline, "publication proof timed out");
            std::thread::yield_now();
        }
    }

    struct ForkChild {
        pid: libc::pid_t,
        release: Option<std::io::PipeWriter>,
    }

    impl ForkChild {
        fn start() -> Self {
            let (reader, writer) = std::io::pipe().unwrap();
            let pid = unsafe { libc::fork() };
            assert!(pid >= 0, "fork: {}", io::Error::last_os_error());
            if pid == 0 {
                // Only async-signal-safe syscalls in the raw child. Keep the copied fd table
                // alive until the parent has checked exec, even on a slow test host.
                unsafe {
                    libc::close(writer.as_raw_fd());
                    libc::usleep(300_000);
                    let mut byte = 0u8;
                    libc::read(reader.as_raw_fd(), (&mut byte as *mut u8).cast(), 1);
                    libc::_exit(0);
                }
            }
            drop(reader);
            Self {
                pid,
                release: Some(writer),
            }
        }
    }

    impl Drop for ForkChild {
        fn drop(&mut self) {
            self.release.take();
            loop {
                let result = unsafe { libc::waitpid(self.pid, std::ptr::null_mut(), 0) };
                if result >= 0 || io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                    break;
                }
            }
        }
    }

    fn exec_succeeds(path: &Path) {
        assert!(std::process::Command::new(path).status().unwrap().success());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn busy_while_fork_child_retains_raw_writer() {
        let _serial = SERIAL.lock().unwrap();
        install().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("raw-script");
        let mut writer = File::create(&path).unwrap();
        writer.write_all(SCRIPT).unwrap();
        writer
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let child = ForkChild::start();
        drop(writer);
        let error = std::process::Command::new(&path).status().unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::ETXTBSY));
        drop(child);
        exec_succeeds(&path);
    }

    #[test]
    fn publication_first_fork_waits_until_writer_is_closed() {
        let _serial = SERIAL.lock().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("published-script");
        std::thread::scope(|scope| {
            let _reset = reset();
            HOLD_PUBLICATION.store(true, Ordering::SeqCst);
            let publisher = scope.spawn(|| {
                PROOF_PUBLISHER.set(true);
                publish_test_executable(&path, SCRIPT, 0o700).unwrap();
            });
            wait_for(|| PUBLICATION_HELD.load(Ordering::SeqCst));
            let forker = scope.spawn(ForkChild::start);
            wait_for(|| FORKS.load(Ordering::SeqCst) != 0);
            assert!(!forker.is_finished());
            HOLD_PUBLICATION.store(false, Ordering::SeqCst);
            publisher.join().unwrap();
            let child = forker.join().unwrap();
            exec_succeeds(&path);
            drop(child);
        });
    }

    #[test]
    fn fork_first_publication_waits_until_parent_handler() {
        let _serial = SERIAL.lock().unwrap();
        install().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("published-script");
        std::thread::scope(|scope| {
            let _reset = reset();
            HOLD_PREPARE.store(true, Ordering::SeqCst);
            let forker = scope.spawn(ForkChild::start);
            wait_for(|| PREPARE_HELD.load(Ordering::SeqCst));
            let publisher = scope.spawn(|| {
                PROOF_PUBLISHER.set(true);
                publish_test_executable(&path, SCRIPT, 0o700).unwrap();
            });
            wait_for(|| PUBLISHER_WAITING.load(Ordering::SeqCst));
            assert!(!path.exists());
            HOLD_PREPARE.store(false, Ordering::SeqCst);
            let child = forker.join().unwrap();
            publisher.join().unwrap();
            exec_succeeds(&path);
            drop(child);
        });
    }

    struct PreparedForks(usize);
    impl Drop for PreparedForks {
        fn drop(&mut self) {
            for _ in 0..self.0 {
                parent();
            }
        }
    }

    // The producer thread intentionally does not acquire SERIAL. Both direct prepares belong
    // to this test, while its publisher must run concurrently with their parent handlers.
    pub(crate) fn two_fork_proof<R: Send>(path: &Path, publish: impl FnOnce() -> R + Send) {
        let _serial = SERIAL.lock().unwrap();
        install().unwrap();
        std::thread::scope(|scope| {
            let _reset = reset();
            let mut prepared = PreparedForks(0);
            prepare();
            prepared.0 += 1;
            prepare();
            prepared.0 += 1;
            parent();
            prepared.0 -= 1;
            let publisher = scope.spawn(|| {
                PROOF_PUBLISHER.set(true);
                publish()
            });
            wait_for(|| PUBLISHER_WAITING.load(Ordering::SeqCst));
            assert!(
                !path.exists(),
                "parent A must not admit publication before parent B"
            );
            parent();
            prepared.0 -= 1;
            let _published = publisher.join().unwrap();
            assert!(path.exists());
        });
    }

    #[test]
    fn two_fork_handler_sequence_blocks_executable_producer() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("two-forks");
        two_fork_proof(&path, || {
            publish_test_executable(&path, SCRIPT, 0o700).unwrap()
        });
        exec_succeeds(&path);
    }

    pub(crate) fn duplicate_archive_proof(
        path: &Path,
        first_bytes: &[u8],
        publish: impl FnOnce() -> Result<(), crate::error::Error> + Send,
    ) {
        let _serial = SERIAL.lock().unwrap();
        std::thread::scope(|scope| {
            let _reset = reset();
            HOLD_PUBLICATION.store(true, Ordering::SeqCst);
            let publisher = scope.spawn(|| {
                PROOF_PUBLISHER.set(true);
                publish()
            });
            wait_for(|| PUBLICATION_HELD.load(Ordering::SeqCst));
            // Retain the first inode across the error path's staging cleanup.
            let mut first = File::open(path).unwrap();
            HOLD_PUBLICATION.store(false, Ordering::SeqCst);
            let error = publisher.join().unwrap().unwrap_err();
            assert!(
                matches!(error, crate::error::Error::Io(ref source)
                if source.kind() == io::ErrorKind::AlreadyExists),
                "{error}"
            );
            let mut bytes = Vec::new();
            first.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, first_bytes);
        });
    }

    #[test]
    fn install_failure_leaves_path_unwritten_and_other_threads_working() {
        struct ResetFailure;
        impl Drop for ResetFailure {
            fn drop(&mut self) {
                INSTALL_FAILURE.set(0);
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("must-not-exist");
        let _reset = ResetFailure;
        INSTALL_FAILURE.set(libc::EAGAIN);
        assert_eq!(
            publish_test_executable(&path, SCRIPT, 0o700)
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EAGAIN)
        );
        assert!(!path.exists());
        let held = File::open(directory.path()).unwrap();
        assert_eq!(
            publish_test_archive_entry(&held, Path::new("must-not-exist"), SCRIPT)
                .unwrap_err()
                .raw_os_error(),
            Some(libc::EAGAIN)
        );
        assert!(!path.exists());
        std::thread::scope(|scope| {
            scope
                .spawn(|| publish_test_executable(&path, SCRIPT, 0o700).unwrap())
                .join()
                .unwrap();
        });
    }

    #[test]
    fn archive_producer_uses_held_directory_after_root_rename() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("staging");
        std::fs::create_dir(&path).unwrap();
        let directory = File::open(&path).unwrap();
        let moved = root.path().join("moved");
        std::fs::rename(&path, &moved).unwrap();
        std::fs::create_dir(&path).unwrap();
        publish_test_archive_entry(&directory, Path::new("engine"), SCRIPT).unwrap();
        assert_eq!(std::fs::read(moved.join("engine")).unwrap(), SCRIPT);
        assert!(!path.join("engine").exists());
    }

    #[test]
    fn executable_copy_writer_audit() {
        for (source, function) in [
            (
                include_str!("../engine/process/tests.rs"),
                "copy_closed_cat_fixture",
            ),
            (
                include_str!("../chess.rs"),
                "warm_resource_and_executable_changes_relaunch_and_duplicate_ids_stay_separate",
            ),
        ] {
            // The fixture is top-level in `engine/process/tests.rs` and nested in `chess.rs`'s
            // test module, so the body ends at the signature's own indentation.
            let body = crate::infra::blocking::source_scan::body_at_indent(
                source,
                &format!("fn {function}("),
            );
            assert!(body.contains("publish_test_executable("), "{function}");
            assert!(body.contains("std::fs::read("), "{function}");
            assert!(!body.contains("std::fs::copy("), "{function}");
            if function == "copy_closed_cat_fixture" {
                assert!(!body.contains("set_permissions("));
            }
        }
    }

    #[test]
    fn shebang_writer_audit() {
        // These fixtures only resolve/pin and drop the image, or refuse before spawn.
        let resolution_only = [
            "earlier_duplicate_directory_replacement_is_ignored_when_effective_option_is_valid",
            "duplicate_evalfile_options_use_only_the_effective_resources_for_leaf_capacity",
            "launch_resolution_and_materialization_run_off_the_async_caller",
            "launch_without_an_initialized_root_is_refused_before_spawn",
            "launch_reports_a_failed_prior_reclaim_with_engine_identity",
            "launch_value_construction_failure_releases_pinned_leaves",
            "launch_pin_operation_and_cleanup_failure_logs_both_categories",
            "cancellation_after_pinning_releases_leaves_before_spawn",
            "sealed_game_engine_start_refuses_before_resolution",
            "inherited_descriptors_cover_every_resource_lease_and_the_engine_image",
            "terminal_snapshot_production_child_broken_pipe_keeps_unread_reason",
            "hold_original_waiting_script_open_for_writing",
        ];
        let mut sources = vec![
            ("process", include_str!("../engine/process.rs")),
            ("process-actor", include_str!("../engine/process/actor.rs")),
            ("process-child", include_str!("../engine/process/child.rs")),
            ("process-logs", include_str!("../engine/process/logs.rs")),
            (
                "process-registration",
                include_str!("../engine/process/registration.rs"),
            ),
            (
                "process-supervisor",
                include_str!("../engine/process/supervisor.rs"),
            ),
            (
                "process-test-doubles",
                include_str!("../engine/process/test_doubles.rs"),
            ),
            ("process-tests", include_str!("../engine/process/tests.rs")),
            ("chess", include_str!("../chess.rs")),
            ("game", include_str!("../game.rs")),
            ("authority-tests", include_str!("path_authority/tests.rs")),
            (
                "authority-portable-tests",
                include_str!("path_authority/portable_tests.rs"),
            ),
            (
                "authority-enumeration-tests",
                include_str!("path_authority/workspace_directory_enumeration_tests.rs"),
            ),
            (
                "authority-windows-tests",
                include_str!("path_authority/windows_tests.rs"),
            ),
            (
                "authority-windows-parent-tests",
                include_str!("path_authority/windows_parent_identity_tests.rs"),
            ),
            ("archives", include_str!("../fs.rs")),
        ];
        sources
            .extend_from_slice(crate::infra::path_authority::test_source_files::PRODUCTION_FILES);
        // An allowlisted fixture that moves to a file outside `sources` would leave this audit
        // reading nothing for it; every exemption must still name a scanned function.
        for function in resolution_only {
            let signature = format!("fn {function}(");
            assert!(
                sources
                    .iter()
                    .any(|(_, source)| source.contains(&signature)),
                "{function} is allowlisted but lives in no audited source"
            );
        }
        for (name, source) in sources {
            let mut function = "";
            let mut producer = "";
            for line in source.lines() {
                let trimmed = line.trim();
                if let Some((_, tail)) = trimmed.split_once("fn ") {
                    function = tail.split('(').next().unwrap();
                    producer = "";
                }
                if line.contains("publish_test_executable(") {
                    producer = "barrier";
                }
                if line.contains("fs::write(") || line.contains(".write_all(") {
                    producer = "direct";
                }
                if line.contains("#!/bin/sh") && producer == "direct" {
                    let replacement = line.contains("#!/bin/sh\\nexit 22\\n");
                    let archive = name == "archives"
                        && (line.contains("write_zip(")
                            || line.contains("gzip_tar_payload(")
                            || line.contains("b\"#!/bin/sh")
                            || line.contains("let script = format!"));
                    assert!(
                        resolution_only.contains(&function) || replacement || archive,
                        "{name}::{function} has an unguarded shebang writer: {line}"
                    );
                }
                // Variable-backed scripts must also be published, rather than passing the
                // literal check while writing responsive/black_source through std::fs::write.
                if name == "game"
                    && function == "test_game_engine_bundle"
                    && line.contains("fs::write(")
                {
                    panic!("game bundle bypasses publication: {line}");
                }
            }
        }
    }
}
