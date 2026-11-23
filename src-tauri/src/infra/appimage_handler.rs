//! Linux AppImage self-registration for the `chessriddle-studio://` scheme handler.
//!
//! A `deb`/`rpm` package or `scripts/install-local.sh` installs a desktop entry that registers
//! `x-scheme-handler/chessriddle-studio`. A downloaded AppImage that the user only marks
//! executable and starts has no desktop entry unless integrated externally.
//!
//! On Linux, once per admitted startup, this module reconciles a single menu-hidden entry
//! (`chessriddle-studio-appimage-handler.desktop`) in `$XDG_DATA_HOME/applications` (or
//! `$HOME/.local/share/applications`):
//! - A genuine AppImage run (`APPIMAGE` valid regular file, `APPDIR` set, current executable
//!   inside `APPDIR`) writes or updates our entry only while no other active handler exists across
//!   the XDG data directories.
//! - Any start removes our owned entry when another active handler exists.
//! - A non-AppImage start also removes our owned entry when its `TryExec` target is provably
//!   missing (`NotFound`).
//! - It never reads or writes `mimeapps.list` and never runs `xdg-mime`.
//!
//! Ownership and exit paths: reconciliation runs once on a dedicated named thread
//! (`appimage-handler`) spawned from `.setup`, off the main thread and outside `BLOCKING_GATEWAY`.
//! It retains no registry entry or long-lived resource. Exit paths: normal completion (outcome
//! logged), typed error (logged, never a panic), or process exit mid-run (atomic `infra::fs`
//! doors keep visible desktop-entry state whole).

/// macOS and Windows register the `chessriddle-studio://` scheme through their installers.
#[cfg(not(target_os = "linux"))]
pub(crate) fn reconcile_in_background() {}

#[cfg(target_os = "linux")]
pub(crate) use linux::reconcile_in_background;

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io::{ErrorKind, Write as _};
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::MetadataExt as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use rustix::fs::{self as rfs, Mode, OFlags};

    use crate::error::Error;
    use crate::infra::fs::{
        assert_entry_identity, atomic_create_at_identified, atomic_replace_at_with_precommit,
        ensure_directory_at, open_directory_at, open_regular_at, read_bounded_bytes,
        remove_entry_at, AtomicFileOutcome, RegularFileAccess,
    };
    use crate::infra::game_link::SCHEME;

    const PRODUCT_NAME: &str = "ChessRiddle Studio";
    const ENTRY_BASENAME: &str = "chessriddle-studio-appimage-handler.desktop";
    const OWNERSHIP_KEY: &str = "X-ChessRiddle-Studio-AppImage-Handler";
    const APPLICATIONS_DIR_NAME: &str = "applications";
    const DEFAULT_XDG_DATA_DIRS: &str = "/usr/local/share:/usr/share";
    const UPDATE_DESKTOP_DATABASE_BIN: &str = "update-desktop-database";

    /// Maximum directory entries scanned in a single `applications/` directory before treating
    /// the scan as incomplete.
    const MAX_DIRECTORY_ENTRIES: usize = 4096;

    /// Maximum size of a single `.desktop` file (1 MiB) before treating the scan as incomplete
    /// (foreign file) or refusing to touch our own entry.
    const MAX_DESKTOP_FILE_BYTES: usize = 1024 * 1024;

    /// Maximum wall-clock wait for `update-desktop-database` before killing and reaping it.
    const REFRESH_TIMEOUT: Duration = Duration::from_secs(10);

    const REFRESH_POLL_INTERVAL: Duration = Duration::from_millis(20);

    /// Starts the one-shot reconciliation on a dedicated background thread.
    pub(crate) fn reconcile_in_background() {
        let spawn = std::thread::Builder::new()
            .name("appimage-handler".into())
            .spawn(|| {
                let env = Environment::from_process();
                let current_exe = std::env::current_exe();
                let runner = CommandRefreshRunner::update_desktop_database();
                let outcome = reconcile(&env, current_exe, &runner);
                log_outcome(&outcome);
            });
        if let Err(error) = spawn {
            log::warn!("could not start AppImage scheme-handler reconciliation thread: {error}");
        }
    }

    #[derive(Clone, Debug, Default)]
    struct Environment {
        appimage: Option<OsString>,
        appdir: Option<OsString>,
        xdg_data_home: Option<OsString>,
        xdg_data_dirs: Option<OsString>,
        home: Option<OsString>,
        path: Option<OsString>,
    }

    impl Environment {
        fn from_process() -> Self {
            Self {
                appimage: std::env::var_os("APPIMAGE"),
                appdir: std::env::var_os("APPDIR"),
                xdg_data_home: std::env::var_os("XDG_DATA_HOME"),
                xdg_data_dirs: std::env::var_os("XDG_DATA_DIRS"),
                home: std::env::var_os("HOME"),
                path: std::env::var_os("PATH"),
            }
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum RunKind {
        AppImage(String),
        Other,
        Undetermined(UndeterminedReason),
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum UndeterminedReason {
        CurrentExeUnavailable(String),
        MalformedAppImage(&'static str),
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum ScanIncompleteReason {
        DirectoryOpenFailed { dir: PathBuf, error: String },
        DirectoryReadFailed { dir: PathBuf, error: String },
        TooManyEntries { dir: PathBuf, limit: usize },
        ForeignFileTooLarge { path: PathBuf, limit: usize },
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum SkipReason {
        Undetermined(UndeterminedReason),
        NoDataHome,
        DataHomeMissing(PathBuf),
        DataHomeOpenFailed { dir: PathBuf, error: String },
        OwnEntryUntouched(String),
        WriteFailed(String),
        RemoveFailed(String),
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Outcome {
        Written {
            durable: bool,
            refresh: RefreshOutcome,
        },
        Replaced {
            durable: bool,
            refresh: RefreshOutcome,
        },
        Removed {
            durable: bool,
            refresh: RefreshOutcome,
        },
        Unchanged,
        Skipped(SkipReason),
        ScanIncomplete(ScanIncompleteReason),
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum RefreshOutcome {
        Succeeded,
        ToolMissing,
        SpawnFailed(String),
        NonZeroExit {
            code: Option<i32>,
            signal: Option<i32>,
        },
        TimedOut {
            reaped: bool,
        },
        WaitFailed(String),
    }

    trait RefreshRunner {
        fn refresh(&self, applications_dir: &Path) -> RefreshOutcome;
    }

    struct CommandRefreshRunner {
        program: OsString,
        timeout: Duration,
    }

    impl CommandRefreshRunner {
        fn update_desktop_database() -> Self {
            Self {
                program: OsString::from(UPDATE_DESKTOP_DATABASE_BIN),
                timeout: REFRESH_TIMEOUT,
            }
        }
    }

    impl RefreshRunner for CommandRefreshRunner {
        fn refresh(&self, applications_dir: &Path) -> RefreshOutcome {
            let mut command = Command::new(&self.program);
            command
                .arg(applications_dir)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    log::info!(
                        "desktop database refresh skipped for {}: tool missing ({})",
                        applications_dir.display(),
                        self.program.to_string_lossy()
                    );
                    return RefreshOutcome::ToolMissing;
                }
                Err(error) => {
                    log::warn!(
                        "desktop database refresh failed to spawn for {}: {error}",
                        applications_dir.display()
                    );
                    return RefreshOutcome::SpawnFailed(error.to_string());
                }
            };

            let deadline = Instant::now() + self.timeout;
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if status.success() {
                            return RefreshOutcome::Succeeded;
                        }
                        let code = status.code();
                        let signal = status.signal();
                        log::warn!(
                            "desktop database refresh failed for {} (code={code:?}, signal={signal:?})",
                            applications_dir.display()
                        );
                        return RefreshOutcome::NonZeroExit { code, signal };
                    }
                    Ok(None) => {
                        let now = Instant::now();
                        if now >= deadline {
                            let _ = child.kill();
                            let reaped = child.wait().is_ok();
                            log::warn!(
                                "desktop database refresh timed out after {:?} for {}; killed (reaped={reaped})",
                                self.timeout,
                                applications_dir.display()
                            );
                            return RefreshOutcome::TimedOut { reaped };
                        }
                        let sleep_for = deadline
                            .saturating_duration_since(now)
                            .min(REFRESH_POLL_INTERVAL);
                        std::thread::sleep(sleep_for);
                    }
                    Err(error) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        log::warn!(
                            "desktop database refresh wait failed for {}: {error}",
                            applications_dir.display()
                        );
                        return RefreshOutcome::WaitFailed(error.to_string());
                    }
                }
            }
        }
    }

    fn log_outcome(outcome: &Outcome) {
        match outcome {
            Outcome::Written { durable, .. } => {
                log::info!("registered AppImage scheme handler (durable={durable})");
            }
            Outcome::Replaced { durable, .. } => {
                log::info!("updated AppImage scheme handler (durable={durable})");
            }
            Outcome::Removed { durable, .. } => {
                log::info!("removed AppImage scheme handler (durable={durable})");
            }
            Outcome::Unchanged => {}
            Outcome::Skipped(reason) => {
                log::warn!("AppImage scheme-handler reconciliation skipped: {reason:?}");
            }
            Outcome::ScanIncomplete(reason) => {
                log::warn!("AppImage scheme-handler scan incomplete; made no change: {reason:?}");
            }
        }
    }

    fn classify_run(env: &Environment, current_exe: Result<PathBuf, std::io::Error>) -> RunKind {
        let exe = match current_exe {
            Ok(exe) => exe,
            Err(error) => {
                return RunKind::Undetermined(UndeterminedReason::CurrentExeUnavailable(
                    error.to_string(),
                ));
            }
        };

        let Some(raw_appimage) = env.appimage.as_deref() else {
            return RunKind::Other;
        };

        let Some(appimage) = raw_appimage.to_str() else {
            return RunKind::Undetermined(UndeterminedReason::MalformedAppImage(
                "APPIMAGE is not valid UTF-8",
            ));
        };
        if appimage.is_empty() {
            return RunKind::Undetermined(UndeterminedReason::MalformedAppImage(
                "APPIMAGE is empty",
            ));
        }
        if appimage.chars().any(char::is_control) {
            return RunKind::Undetermined(UndeterminedReason::MalformedAppImage(
                "APPIMAGE contains control characters",
            ));
        }
        let appimage_path = Path::new(appimage);
        if !appimage_path.is_absolute() {
            return RunKind::Undetermined(UndeterminedReason::MalformedAppImage(
                "APPIMAGE is not an absolute path",
            ));
        }
        match std::fs::metadata(appimage_path) {
            Ok(meta) if meta.is_file() => {}
            _ => {
                return RunKind::Undetermined(UndeterminedReason::MalformedAppImage(
                    "APPIMAGE does not name an existing regular file",
                ));
            }
        }

        let Some(canon_appdir) = canonical_appdir(env) else {
            return RunKind::Other;
        };
        let canon_exe = std::fs::canonicalize(&exe).unwrap_or(exe);
        if canon_exe.starts_with(&canon_appdir) && canon_exe != canon_appdir {
            RunKind::AppImage(appimage.to_owned())
        } else {
            RunKind::Other
        }
    }

    fn canonical_appdir(env: &Environment) -> Option<PathBuf> {
        let raw = env.appdir.as_deref()?;
        let path = Path::new(raw);
        if raw.is_empty() || !path.is_absolute() {
            return None;
        }
        std::fs::canonicalize(path).ok()
    }

    fn resolve_data_home(env: &Environment) -> Option<PathBuf> {
        if let Some(xdg) = env.xdg_data_home.as_deref() {
            if !xdg.is_empty() && Path::new(xdg).is_absolute() {
                return Some(PathBuf::from(xdg));
            }
        }
        let home = env.home.as_deref()?;
        if !home.is_empty() && Path::new(home).is_absolute() {
            return Some(PathBuf::from(home).join(".local").join("share"));
        }
        None
    }

    fn resolve_data_dirs(env: &Environment) -> Vec<PathBuf> {
        let excluded_appdir = canonical_appdir(env);
        let dirs = match env.xdg_data_dirs.as_deref() {
            Some(raw) if !raw.is_empty() => std::env::split_paths(raw)
                .filter(|path| path.is_absolute())
                .collect::<Vec<_>>(),
            _ => std::env::split_paths(DEFAULT_XDG_DATA_DIRS)
                .filter(|path| path.is_absolute())
                .collect::<Vec<_>>(),
        };
        let Some(canon_appdir) = excluded_appdir else {
            return dirs;
        };
        // AppRun prepends `$APPDIR/usr/share` to `XDG_DATA_DIRS` and the packaged entry there
        // lists the scheme; that mount is never visible to the desktop (plan P-16).
        dirs.into_iter()
            .filter(|dir| match std::fs::canonicalize(dir) {
                Ok(canon_dir) => !canon_dir.starts_with(&canon_appdir),
                Err(_) => true,
            })
            .collect()
    }

    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    struct ParsedDesktopEntry {
        mime_types: Vec<String>,
        hidden: bool,
        try_exec: Option<String>,
        #[cfg(test)]
        exec: Option<String>,
        owned: bool,
    }

    impl ParsedDesktopEntry {
        fn lists_scheme_handler(&self, scheme: &str) -> bool {
            let target = format!("x-scheme-handler/{scheme}");
            self.mime_types.iter().any(|mime| mime == &target)
        }
    }

    /// Escapes a Desktop Entry Specification `string` value.
    fn escape_desktop_string(value: &str) -> String {
        let mut out = String::with_capacity(value.len());
        for (index, ch) in value.chars().enumerate() {
            match ch {
                '\\' => out.push_str("\\\\"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                ' ' if index == 0 => out.push_str("\\s"),
                _ => out.push(ch),
            }
        }
        out
    }

    fn push_desktop_escape(out: &mut String, next: Option<char>) {
        match next {
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }

    /// Unescapes a Desktop Entry Specification `string` value (`\s`, `\n`, `\t`, `\r`, `\\`).
    fn unescape_desktop_string(raw: &str) -> String {
        let mut out = String::with_capacity(raw.len());
        let mut chars = raw.chars();
        while let Some(ch) = chars.next() {
            if ch == '\\' {
                push_desktop_escape(&mut out, chars.next());
            } else {
                out.push(ch);
            }
        }
        out
    }

    /// Splits a Desktop Entry Specification semicolon-separated list (`string(s)`), respecting
    /// `\;` and string-value escapes.
    fn parse_desktop_string_list(raw: &str) -> Vec<String> {
        let mut items = Vec::new();
        let mut current = String::new();
        let mut chars = raw.chars();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => match chars.next() {
                    Some(';') => current.push(';'),
                    next => push_desktop_escape(&mut current, next),
                },
                ';' => {
                    let trimmed = current.trim();
                    if !trimmed.is_empty() {
                        items.push(trimmed.to_owned());
                    }
                    current.clear();
                }
                _ => current.push(ch),
            }
        }
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            items.push(trimmed.to_owned());
        }
        items
    }

    /// Quotes and escapes one argument for the Desktop Entry `Exec` key:
    /// 1. Inside double quotes, `"`, `` ` ``, `$` and `\` are backslash-escaped, and `%` is
    ///    doubled.
    /// 2. The resulting string is then passed through Desktop Entry string-value escaping.
    fn escape_exec_argument(arg: &str) -> String {
        let mut quoted = String::with_capacity(arg.len() + 2);
        quoted.push('"');
        for ch in arg.chars() {
            match ch {
                '"' | '`' | '$' | '\\' => {
                    quoted.push('\\');
                    quoted.push(ch);
                }
                '%' => quoted.push_str("%%"),
                _ => quoted.push(ch),
            }
        }
        quoted.push('"');
        escape_desktop_string(&quoted)
    }

    fn render_desktop_entry(appimage_path: &str) -> String {
        let exec_arg = escape_exec_argument(appimage_path);
        let try_exec = escape_desktop_string(appimage_path);
        format!(
            "[Desktop Entry]\n\
             Type=Application\n\
             Name={PRODUCT_NAME}\n\
             NoDisplay=true\n\
             Terminal=false\n\
             Exec={exec_arg} %u\n\
             TryExec={try_exec}\n\
             MimeType=x-scheme-handler/{SCHEME};\n\
             {OWNERSHIP_KEY}=true\n"
        )
    }

    fn parse_desktop_entry(content: &str) -> ParsedDesktopEntry {
        let mut entry = ParsedDesktopEntry::default();
        let mut in_desktop_entry = false;

        for raw_line in content.lines() {
            let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                in_desktop_entry = trimmed == "[Desktop Entry]";
                continue;
            }
            if !in_desktop_entry {
                continue;
            }
            let Some((raw_key, raw_value)) = line.split_once('=') else {
                continue;
            };
            let key = raw_key.trim();
            let value = raw_value.trim_start_matches([' ', '\t']);
            match key {
                "MimeType" => {
                    entry.mime_types = parse_desktop_string_list(value);
                }
                "Hidden" => {
                    entry.hidden = value.trim() == "true";
                }
                "TryExec" => {
                    entry.try_exec = Some(unescape_desktop_string(value));
                }
                #[cfg(test)]
                "Exec" => {
                    entry.exec = Some(unescape_desktop_string(value));
                }
                k if k == OWNERSHIP_KEY => {
                    entry.owned = value.trim() == "true";
                }
                _ => {}
            }
        }

        entry
    }

    /// Evaluates whether an already-unescaped `TryExec` value is provably missing (`NotFound`).
    fn try_exec_is_provably_missing(try_exec: &str, path_env: Option<&OsStr>) -> bool {
        if try_exec.is_empty() {
            return false;
        }
        let candidate = Path::new(try_exec);
        if candidate.is_absolute() {
            return match std::fs::metadata(candidate) {
                Ok(_) => false,
                Err(error) if error.kind() == ErrorKind::NotFound => true,
                Err(error) => {
                    log::warn!("TryExec metadata check indeterminate for {try_exec}: {error}");
                    false
                }
            };
        }
        if !try_exec.contains('/') {
            let Some(path_var) = path_env else {
                return false;
            };
            let mut checked_any = false;
            for dir in std::env::split_paths(path_var) {
                if dir.as_os_str().is_empty() {
                    continue;
                }
                checked_any = true;
                let joined = dir.join(try_exec);
                match std::fs::metadata(&joined) {
                    Ok(_) => return false,
                    Err(error) if error.kind() == ErrorKind::NotFound => continue,
                    Err(error) => {
                        log::warn!(
                            "TryExec PATH check indeterminate for {}: {error}",
                            joined.display()
                        );
                        return false;
                    }
                }
            }
            return checked_any;
        }
        false
    }

    fn scan_applications_dir(
        apps_dir: &Path,
        path_env: Option<&OsStr>,
    ) -> Result<bool, ScanIncompleteReason> {
        let entries = match std::fs::read_dir(apps_dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => {
                return Err(ScanIncompleteReason::DirectoryOpenFailed {
                    dir: apps_dir.to_path_buf(),
                    error: error.to_string(),
                });
            }
        };

        let mut count: usize = 0;
        let mut found_handler = false;

        for item in entries {
            let entry = item.map_err(|error| ScanIncompleteReason::DirectoryReadFailed {
                dir: apps_dir.to_path_buf(),
                error: error.to_string(),
            })?;
            count += 1;
            if count > MAX_DIRECTORY_ENTRIES {
                return Err(ScanIncompleteReason::TooManyEntries {
                    dir: apps_dir.to_path_buf(),
                    limit: MAX_DIRECTORY_ENTRIES,
                });
            }
            let file_name = entry.file_name();
            if file_name == OsStr::new(ENTRY_BASENAME) {
                continue;
            }
            if !file_name.as_bytes().ends_with(b".desktop") {
                continue;
            }

            let entry_path = entry.path();
            // Foreign entries are read following symlinks (a symlinked entry is a normal
            // installation); O_NOFOLLOW applies only to our own basename.
            let mut file = match File::open(&entry_path) {
                Ok(file) => file,
                Err(error) => {
                    log::debug!(
                        "skipping unreadable foreign desktop entry {}: {error}",
                        entry_path.display()
                    );
                    continue;
                }
            };
            let meta = match file.metadata() {
                Ok(meta) => meta,
                Err(error) => {
                    log::debug!(
                        "skipping foreign desktop entry without metadata {}: {error}",
                        entry_path.display()
                    );
                    continue;
                }
            };
            if !meta.is_file() {
                continue;
            }
            if meta.len() > MAX_DESKTOP_FILE_BYTES as u64 {
                return Err(ScanIncompleteReason::ForeignFileTooLarge {
                    path: entry_path,
                    limit: MAX_DESKTOP_FILE_BYTES,
                });
            }
            let bytes = match read_bounded_bytes(
                &mut file,
                meta.len(),
                MAX_DESKTOP_FILE_BYTES,
                "foreign desktop entry exceeds 1 MiB",
                || Ok(()),
            ) {
                Ok(bytes) => bytes,
                Err(Error::ResourceLimit(_)) => {
                    return Err(ScanIncompleteReason::ForeignFileTooLarge {
                        path: entry_path,
                        limit: MAX_DESKTOP_FILE_BYTES,
                    });
                }
                Err(error) => {
                    log::debug!(
                        "skipping unreadable foreign desktop entry {}: {error}",
                        entry_path.display()
                    );
                    continue;
                }
            };

            let text = String::from_utf8_lossy(&bytes);
            let parsed = parse_desktop_entry(&text);
            if parsed.lists_scheme_handler(SCHEME)
                && !parsed.hidden
                && parsed
                    .try_exec
                    .as_deref()
                    .is_none_or(|te| !try_exec_is_provably_missing(te, path_env))
            {
                found_handler = true;
            }
        }

        Ok(found_handler)
    }

    enum OwnEntry {
        Absent,
        Owned {
            identity: (u64, u64),
            bytes: Vec<u8>,
            parsed: ParsedDesktopEntry,
        },
        UnownedOrUnreadable(String),
    }

    fn open_data_home_dir(data_home: &Path) -> Result<Option<File>, std::io::Error> {
        match rfs::open(
            data_home,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        ) {
            Ok(fd) => Ok(Some(File::from(fd))),
            Err(rustix::io::Errno::NOENT) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn inspect_own_entry(apps_dir: &File) -> OwnEntry {
        let mut file = match open_regular_at(
            apps_dir,
            OsStr::new(ENTRY_BASENAME),
            RegularFileAccess::ReadOnly,
        ) {
            Ok(file) => file,
            Err(error) if error.is_missing_entry() => return OwnEntry::Absent,
            Err(error) => {
                return OwnEntry::UnownedOrUnreadable(format!(
                    "could not open {ENTRY_BASENAME} as a regular non-symlink file: {error}"
                ));
            }
        };

        let meta = match file.metadata() {
            Ok(meta) => meta,
            Err(error) => {
                return OwnEntry::UnownedOrUnreadable(format!(
                    "could not stat {ENTRY_BASENAME}: {error}"
                ));
            }
        };
        let identity = (meta.dev(), meta.ino());
        if meta.len() > MAX_DESKTOP_FILE_BYTES as u64 {
            return OwnEntry::UnownedOrUnreadable(format!(
                "{ENTRY_BASENAME} exceeds {MAX_DESKTOP_FILE_BYTES} bytes"
            ));
        }

        let bytes = match read_bounded_bytes(
            &mut file,
            meta.len(),
            MAX_DESKTOP_FILE_BYTES,
            "owned desktop entry exceeds 1 MiB",
            || Ok(()),
        ) {
            Ok(bytes) => bytes,
            Err(error) => {
                return OwnEntry::UnownedOrUnreadable(format!(
                    "could not read {ENTRY_BASENAME}: {error}"
                ));
            }
        };
        drop(file);

        let Ok(text) = std::str::from_utf8(&bytes) else {
            return OwnEntry::UnownedOrUnreadable(format!("{ENTRY_BASENAME} is not valid UTF-8"));
        };
        let parsed = parse_desktop_entry(text);
        if !parsed.owned {
            return OwnEntry::UnownedOrUnreadable(format!(
                "{ENTRY_BASENAME} lacks {OWNERSHIP_KEY}=true"
            ));
        }

        OwnEntry::Owned {
            identity,
            bytes,
            parsed,
        }
    }

    fn record_atomic_outcome(outcome: AtomicFileOutcome, verb: &'static str) -> bool {
        match outcome {
            AtomicFileOutcome::DurableCommit => true,
            AtomicFileOutcome::CommittedDurabilityUncertain(error) => {
                log::warn!("AppImage handler entry {verb} with uncertain durability: {error}");
                false
            }
        }
    }

    fn reconcile(
        env: &Environment,
        current_exe: Result<PathBuf, std::io::Error>,
        refresh: &dyn RefreshRunner,
    ) -> Outcome {
        let run_kind = classify_run(env, current_exe);
        if let RunKind::Undetermined(reason) = run_kind {
            return Outcome::Skipped(SkipReason::Undetermined(reason));
        }

        let Some(data_home) = resolve_data_home(env) else {
            return Outcome::Skipped(SkipReason::NoDataHome);
        };
        let data_dirs = resolve_data_dirs(env);
        let user_apps_path = data_home.join(APPLICATIONS_DIR_NAME);

        // Scan all XDG applications directories first so an incomplete scan never writes or
        // removes anything.
        let mut another_handler_exists = false;
        let scan_dirs = std::iter::once(user_apps_path.clone()).chain(
            data_dirs
                .into_iter()
                .map(|dir| dir.join(APPLICATIONS_DIR_NAME)),
        );
        for dir in scan_dirs {
            match scan_applications_dir(&dir, env.path.as_deref()) {
                Ok(found) => {
                    if found {
                        another_handler_exists = true;
                    }
                }
                Err(reason) => return Outcome::ScanIncomplete(reason),
            }
        }

        let data_home_fd = match open_data_home_dir(&data_home) {
            Ok(fd) => fd,
            Err(error) => {
                return Outcome::Skipped(SkipReason::DataHomeOpenFailed {
                    dir: data_home,
                    error: error.to_string(),
                });
            }
        };

        let existing_apps_fd = match data_home_fd.as_ref() {
            None => None,
            Some(home_fd) => {
                match open_directory_at(home_fd, OsStr::new(APPLICATIONS_DIR_NAME), false) {
                    Ok(fd) => Some(fd),
                    Err(error) if error.is_missing_entry() => None,
                    Err(error) => {
                        return Outcome::ScanIncomplete(
                            ScanIncompleteReason::DirectoryOpenFailed {
                                dir: user_apps_path,
                                error: error.to_string(),
                            },
                        );
                    }
                }
            }
        };

        let own_entry = match existing_apps_fd.as_ref() {
            Some(apps_fd) => inspect_own_entry(apps_fd),
            None => OwnEntry::Absent,
        };

        if let OwnEntry::UnownedOrUnreadable(reason) = own_entry {
            return Outcome::Skipped(SkipReason::OwnEntryUntouched(reason));
        }

        match (run_kind, another_handler_exists, own_entry) {
            (RunKind::AppImage(appimage), false, OwnEntry::Absent) => {
                let Some(home_fd) = data_home_fd.as_ref() else {
                    return Outcome::Skipped(SkipReason::DataHomeMissing(data_home));
                };
                let apps_fd = match existing_apps_fd {
                    Some(fd) => fd,
                    None => match ensure_directory_at(home_fd, OsStr::new(APPLICATIONS_DIR_NAME)) {
                        Ok(fd) => fd,
                        Err(error) => {
                            return Outcome::Skipped(SkipReason::WriteFailed(format!(
                                "could not ensure applications directory: {error}"
                            )));
                        }
                    },
                };
                let content = render_desktop_entry(&appimage);
                match atomic_create_at_identified(&apps_fd, OsStr::new(ENTRY_BASENAME), |file| {
                    file.write_all(content.as_bytes()).map_err(Error::from)
                }) {
                    Ok(installed) => {
                        let durable = record_atomic_outcome(installed.outcome, "created");
                        let refresh_outcome = refresh.refresh(&user_apps_path);
                        Outcome::Written {
                            durable,
                            refresh: refresh_outcome,
                        }
                    }
                    Err(error) => Outcome::Skipped(SkipReason::WriteFailed(error.to_string())),
                }
            }
            (
                RunKind::AppImage(appimage),
                false,
                OwnEntry::Owned {
                    identity, bytes, ..
                },
            ) => {
                let content = render_desktop_entry(&appimage);
                if bytes == content.as_bytes() {
                    return Outcome::Unchanged;
                }
                let Some(apps_fd) = existing_apps_fd.as_ref() else {
                    return Outcome::Skipped(SkipReason::WriteFailed(
                        "applications directory descriptor missing".into(),
                    ));
                };
                match atomic_replace_at_with_precommit(
                    apps_fd,
                    OsStr::new(ENTRY_BASENAME),
                    || assert_entry_identity(apps_fd, OsStr::new(ENTRY_BASENAME), identity, false),
                    |file| file.write_all(content.as_bytes()).map_err(Error::from),
                ) {
                    Ok(outcome) => {
                        let durable = record_atomic_outcome(outcome, "replaced");
                        let refresh_outcome = refresh.refresh(&user_apps_path);
                        Outcome::Replaced {
                            durable,
                            refresh: refresh_outcome,
                        }
                    }
                    Err(error) => Outcome::Skipped(SkipReason::WriteFailed(error.to_string())),
                }
            }
            (RunKind::AppImage(_), true, OwnEntry::Owned { identity, .. })
            | (RunKind::Other, true, OwnEntry::Owned { identity, .. }) => remove_owned_entry(
                existing_apps_fd.as_ref(),
                &user_apps_path,
                identity,
                refresh,
            ),
            (
                RunKind::Other,
                false,
                OwnEntry::Owned {
                    identity, parsed, ..
                },
            ) => {
                let missing = parsed
                    .try_exec
                    .as_deref()
                    .is_some_and(|te| try_exec_is_provably_missing(te, env.path.as_deref()));
                if missing {
                    remove_owned_entry(
                        existing_apps_fd.as_ref(),
                        &user_apps_path,
                        identity,
                        refresh,
                    )
                } else {
                    Outcome::Unchanged
                }
            }
            (_, _, OwnEntry::Absent) => Outcome::Unchanged,
            (RunKind::Undetermined(_), _, _) | (_, _, OwnEntry::UnownedOrUnreadable(_)) => {
                // Already returned above.
                Outcome::Unchanged
            }
        }
    }

    fn remove_owned_entry(
        apps_fd: Option<&File>,
        user_apps_path: &Path,
        identity: (u64, u64),
        refresh: &dyn RefreshRunner,
    ) -> Outcome {
        let Some(apps_fd) = apps_fd else {
            return Outcome::Skipped(SkipReason::RemoveFailed(
                "applications directory descriptor missing".into(),
            ));
        };
        match remove_entry_at(apps_fd, OsStr::new(ENTRY_BASENAME), identity, false) {
            Ok(()) => {
                let refresh_outcome = refresh.refresh(user_apps_path);
                Outcome::Removed {
                    durable: true,
                    refresh: refresh_outcome,
                }
            }
            Err(Error::CommittedDurabilityUncertain(stage)) => {
                log::warn!("AppImage handler entry removed with uncertain durability ({stage})");
                let refresh_outcome = refresh.refresh(user_apps_path);
                Outcome::Removed {
                    durable: false,
                    refresh: refresh_outcome,
                }
            }
            Err(error) => Outcome::Skipped(SkipReason::RemoveFailed(error.to_string())),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        use std::os::unix::ffi::OsStringExt as _;
        use std::os::unix::fs::{symlink, PermissionsExt as _};

        const MAIN_BINARY_NAME: &str = "chessriddle-studio";

        #[derive(Default)]
        struct RecordingRefresh {
            calls: RefCell<Vec<PathBuf>>,
            result: RefCell<Option<RefreshOutcome>>,
        }

        impl RecordingRefresh {
            fn returning(outcome: RefreshOutcome) -> Self {
                Self {
                    calls: RefCell::new(Vec::new()),
                    result: RefCell::new(Some(outcome)),
                }
            }

            fn calls(&self) -> Vec<PathBuf> {
                self.calls.borrow().clone()
            }
        }

        impl RefreshRunner for RecordingRefresh {
            fn refresh(&self, applications_dir: &Path) -> RefreshOutcome {
                self.calls.borrow_mut().push(applications_dir.to_path_buf());
                self.result
                    .borrow()
                    .clone()
                    .unwrap_or(RefreshOutcome::Succeeded)
            }
        }

        struct TestFixture {
            _root: tempfile::TempDir,
            data_home: PathBuf,
            system_data_dir: PathBuf,
            appdir: PathBuf,
            exe_in_appdir: PathBuf,
            exe_outside: PathBuf,
            appimage_file: PathBuf,
        }

        impl TestFixture {
            fn new() -> Self {
                let root = tempfile::tempdir().unwrap();
                let data_home = root.path().join("data-home");
                let system_data_dir = root.path().join("system-share");
                let appdir = root.path().join("appdir");
                let appdir_bin = appdir.join("usr/bin");
                let outside_bin = root.path().join("outside-bin");

                std::fs::create_dir_all(&data_home).unwrap();
                std::fs::create_dir_all(&system_data_dir).unwrap();
                std::fs::create_dir_all(&appdir_bin).unwrap();
                std::fs::create_dir_all(&outside_bin).unwrap();

                let exe_in_appdir = appdir_bin.join(MAIN_BINARY_NAME);
                let exe_outside = outside_bin.join(MAIN_BINARY_NAME);
                let appimage_file = root.path().join("ChessRiddle-Studio.AppImage");
                std::fs::write(&exe_in_appdir, b"bin").unwrap();
                std::fs::write(&exe_outside, b"bin").unwrap();
                std::fs::write(&appimage_file, b"appimage").unwrap();

                Self {
                    _root: root,
                    data_home,
                    system_data_dir,
                    appdir,
                    exe_in_appdir,
                    exe_outside,
                    appimage_file,
                }
            }

            fn appimage_env(&self) -> Environment {
                Environment {
                    appimage: Some(self.appimage_file.as_os_str().to_os_string()),
                    appdir: Some(self.appdir.as_os_str().to_os_string()),
                    xdg_data_home: Some(self.data_home.as_os_str().to_os_string()),
                    xdg_data_dirs: Some(self.system_data_dir.as_os_str().to_os_string()),
                    home: None,
                    path: None,
                }
            }

            fn other_env(&self) -> Environment {
                Environment {
                    appimage: None,
                    appdir: None,
                    xdg_data_home: Some(self.data_home.as_os_str().to_os_string()),
                    xdg_data_dirs: Some(self.system_data_dir.as_os_str().to_os_string()),
                    home: None,
                    path: None,
                }
            }

            fn own_entry_path(&self) -> PathBuf {
                self.data_home
                    .join(APPLICATIONS_DIR_NAME)
                    .join(ENTRY_BASENAME)
            }
        }

        fn write_foreign_handler(dir: &Path, name: &str, extra_lines: &str) -> PathBuf {
            let apps = dir.join(APPLICATIONS_DIR_NAME);
            std::fs::create_dir_all(&apps).unwrap();
            let path = apps.join(name);
            let content = format!(
                "[Desktop Entry]\n\
                 Type=Application\n\
                 Name=Other\n\
                 Exec=/usr/bin/chessriddle-studio %u\n\
                 MimeType=x-scheme-handler/{SCHEME};\n\
                 {extra_lines}"
            );
            std::fs::write(&path, content).unwrap();
            path
        }

        #[test]
        fn constants_match_tauri_conf() {
            let config: serde_json::Value =
                serde_json::from_str(include_str!("../../tauri.conf.json"))
                    .expect("tauri.conf.json is valid JSON");
            assert_eq!(config["mainBinaryName"].as_str(), Some(MAIN_BINARY_NAME));
            assert_eq!(config["productName"].as_str(), Some(PRODUCT_NAME));
            assert_eq!(
                ENTRY_BASENAME,
                format!("{MAIN_BINARY_NAME}-appimage-handler.desktop")
            );
        }

        #[test]
        fn appimage_run_writes_entry_and_is_idempotent_on_second_run() {
            let fx = TestFixture::new();
            let env = fx.appimage_env();
            let refresh = RecordingRefresh::default();

            let first = reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh);
            assert_eq!(
                first,
                Outcome::Written {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert_eq!(
                refresh.calls(),
                vec![fx.data_home.join(APPLICATIONS_DIR_NAME)]
            );
            let written = std::fs::read_to_string(fx.own_entry_path()).unwrap();
            assert_eq!(
                written,
                render_desktop_entry(fx.appimage_file.to_str().unwrap())
            );

            // Second run with identical content writes nothing and runs no refresh.
            let second = reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh);
            assert_eq!(second, Outcome::Unchanged);
            assert_eq!(refresh.calls().len(), 1);
        }

        #[test]
        fn appimage_run_replaces_owned_entry_when_path_changes() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            let first = reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh);
            assert!(matches!(first, Outcome::Written { .. }));

            let moved = fx._root.path().join("Moved-Studio.AppImage");
            std::fs::write(&moved, b"appimage2").unwrap();
            let mut env2 = fx.appimage_env();
            env2.appimage = Some(moved.as_os_str().to_os_string());

            let second = reconcile(&env2, Ok(fx.exe_in_appdir.clone()), &refresh);
            assert_eq!(
                second,
                Outcome::Replaced {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert_eq!(refresh.calls().len(), 2);
            let written = std::fs::read_to_string(fx.own_entry_path()).unwrap();
            assert_eq!(written, render_desktop_entry(moved.to_str().unwrap()));
        }

        #[test]
        fn appimage_and_other_runs_remove_owned_entry_when_another_handler_exists() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            // Write our entry first.
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Written { .. }
            ));
            assert!(fx.own_entry_path().exists());

            // Another handler appears in XDG_DATA_DIRS.
            write_foreign_handler(&fx.system_data_dir, "chessriddle-studio.desktop", "");

            // AppImage run removes our entry.
            let removed_by_appimage =
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh);
            assert_eq!(
                removed_by_appimage,
                Outcome::Removed {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert!(!fx.own_entry_path().exists());

            // Recreate our entry manually to test Other run removal when another handler exists.
            std::fs::write(
                fx.own_entry_path(),
                render_desktop_entry(fx.appimage_file.to_str().unwrap()),
            )
            .unwrap();
            let removed_by_other = reconcile(&fx.other_env(), Ok(fx.exe_outside.clone()), &refresh);
            assert_eq!(
                removed_by_other,
                Outcome::Removed {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert!(!fx.own_entry_path().exists());
        }

        #[test]
        fn other_run_keeps_owned_entry_when_try_exec_exists_and_removes_when_missing() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Written { .. }
            ));

            // AppImage still exists -> Other run leaves our entry alone.
            let kept = reconcile(&fx.other_env(), Ok(fx.exe_outside.clone()), &refresh);
            assert_eq!(kept, Outcome::Unchanged);
            assert!(fx.own_entry_path().exists());
            assert_eq!(refresh.calls().len(), 1);

            // Delete the AppImage -> Other run sees TryExec provably missing and removes our entry.
            std::fs::remove_file(&fx.appimage_file).unwrap();
            let removed = reconcile(&fx.other_env(), Ok(fx.exe_outside.clone()), &refresh);
            assert_eq!(
                removed,
                Outcome::Removed {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert!(!fx.own_entry_path().exists());
            assert_eq!(refresh.calls().len(), 2);
        }

        #[test]
        fn scan_or_removal_never_creates_applications_directory() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();
            let apps_dir = fx.data_home.join(APPLICATIONS_DIR_NAME);
            assert!(!apps_dir.exists());

            // Other run with absent applications/ does not create it.
            assert_eq!(
                reconcile(&fx.other_env(), Ok(fx.exe_outside.clone()), &refresh),
                Outcome::Unchanged
            );
            assert!(!apps_dir.exists());

            // AppImage run when another handler exists does not create applications/.
            write_foreign_handler(&fx.system_data_dir, "installed.desktop", "");
            assert_eq!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Unchanged
            );
            assert!(!apps_dir.exists());
            assert!(refresh.calls().is_empty());
        }

        #[test]
        fn run_classification_handles_inherited_and_malformed_appimage() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            // Inherited APPIMAGE with exe outside APPDIR -> Other.
            assert_eq!(
                classify_run(&fx.appimage_env(), Ok(fx.exe_outside.clone())),
                RunKind::Other
            );

            // Inherited APPIMAGE with APPDIR unset -> Other.
            let mut no_appdir = fx.appimage_env();
            no_appdir.appdir = None;
            assert_eq!(
                classify_run(&no_appdir, Ok(fx.exe_in_appdir.clone())),
                RunKind::Other
            );

            // Malformed APPIMAGE: relative, newline, non-UTF-8, missing file -> Undetermined, no change.
            for bad in [
                OsString::from("relative/path.AppImage"),
                OsString::from("/tmp/has\nnewline.AppImage"),
                OsString::from_vec(vec![b'/', 0xff, b'a']),
                OsString::from("/nonexistent/chessriddle.AppImage"),
                OsString::from(""),
            ] {
                let mut env = fx.appimage_env();
                env.appimage = Some(bad);
                assert!(matches!(
                    reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh),
                    Outcome::Skipped(SkipReason::Undetermined(
                        UndeterminedReason::MalformedAppImage(_)
                    ))
                ));
            }

            // Current exe unavailable -> Undetermined, no change.
            assert!(matches!(
                reconcile(
                    &fx.appimage_env(),
                    Err(std::io::Error::other("no procfs")),
                    &refresh
                ),
                Outcome::Skipped(SkipReason::Undetermined(
                    UndeterminedReason::CurrentExeUnavailable(_)
                ))
            ));
            assert!(!fx.own_entry_path().exists());
        }

        #[test]
        fn foreign_entry_rules_symlink_hidden_try_exec_and_unreadable() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            // Hidden foreign entry does not count.
            write_foreign_handler(&fx.system_data_dir, "hidden.desktop", "Hidden=true\n");
            // TryExec-missing foreign entry does not count.
            write_foreign_handler(
                &fx.system_data_dir,
                "missing-tryexec.desktop",
                "TryExec=/no/such/binary/anywhere\n",
            );
            // Bare-name TryExec missing from injected PATH does not count.
            write_foreign_handler(
                &fx.system_data_dir,
                "bare-missing.desktop",
                "TryExec=nonexistent-chess-bin\n",
            );
            // Unreadable foreign file does not count.
            let unreadable = write_foreign_handler(&fx.system_data_dir, "unreadable.desktop", "");
            std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();

            let bin_dir = fx._root.path().join("path-bin");
            std::fs::create_dir_all(&bin_dir).unwrap();
            let mut env = fx.appimage_env();
            env.path = Some(bin_dir.as_os_str().to_os_string());

            let outcome = reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh);
            // Restore permissions before asserting so tempdir cleanup succeeds even on failure.
            let _ = std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o644));
            assert!(matches!(outcome, Outcome::Written { .. }));

            // Now place the bare-name binary in injected PATH -> foreign entry now counts -> removes ours!
            std::fs::write(bin_dir.join("nonexistent-chess-bin"), b"bin").unwrap();
            let removed = reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh);
            assert!(matches!(removed, Outcome::Removed { .. }));
            assert!(!fx.own_entry_path().exists());

            // Remove the bare-name binary and add a symlinked foreign desktop entry -> counts!
            std::fs::remove_file(bin_dir.join("nonexistent-chess-bin")).unwrap();
            let target_desktop = fx._root.path().join("external.desktop");
            std::fs::write(
                &target_desktop,
                format!(
                    "[Desktop Entry]\nType=Application\nName=Sym\nMimeType=x-scheme-handler/{SCHEME};\n"
                ),
            )
            .unwrap();
            symlink(
                &target_desktop,
                fx.system_data_dir
                    .join(APPLICATIONS_DIR_NAME)
                    .join("symlinked.desktop"),
            )
            .unwrap();
            assert_eq!(
                reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Unchanged
            );
            assert!(!fx.own_entry_path().exists());
        }

        #[test]
        fn foreign_file_and_symlink_at_our_basename_are_left_untouched() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();
            let apps = fx.data_home.join(APPLICATIONS_DIR_NAME);
            std::fs::create_dir_all(&apps).unwrap();

            // Foreign regular file without ownership key.
            let foreign_content = "[Desktop Entry]\nName=Handcrafted\n";
            std::fs::write(fx.own_entry_path(), foreign_content).unwrap();
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Skipped(SkipReason::OwnEntryUntouched(_))
            ));
            assert_eq!(
                std::fs::read_to_string(fx.own_entry_path()).unwrap(),
                foreign_content
            );

            // Symlink at our basename (even pointing at a file with our ownership key).
            std::fs::remove_file(fx.own_entry_path()).unwrap();
            let target = fx._root.path().join("target.desktop");
            std::fs::write(
                &target,
                render_desktop_entry(fx.appimage_file.to_str().unwrap()),
            )
            .unwrap();
            symlink(&target, fx.own_entry_path()).unwrap();
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Skipped(SkipReason::OwnEntryUntouched(_))
            ));
            assert!(fx
                .own_entry_path()
                .symlink_metadata()
                .unwrap()
                .file_type()
                .is_symlink());

            // Directory at our basename (not a regular file).
            std::fs::remove_file(fx.own_entry_path()).unwrap();
            std::fs::create_dir(fx.own_entry_path()).unwrap();
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Skipped(SkipReason::OwnEntryUntouched(_))
            ));
            assert!(fx.own_entry_path().is_dir());
            std::fs::remove_dir(fx.own_entry_path()).unwrap();

            // Oversized file (> 1 MiB) at our basename.
            std::fs::write(fx.own_entry_path(), vec![b'x'; MAX_DESKTOP_FILE_BYTES + 1]).unwrap();
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Skipped(SkipReason::OwnEntryUntouched(_))
            ));
            std::fs::remove_file(fx.own_entry_path()).unwrap();

            // Unreadable file at our basename.
            std::fs::write(
                fx.own_entry_path(),
                render_desktop_entry(fx.appimage_file.to_str().unwrap()),
            )
            .unwrap();
            std::fs::set_permissions(fx.own_entry_path(), std::fs::Permissions::from_mode(0o000))
                .unwrap();
            let unreadable_outcome =
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh);
            let _ = std::fs::set_permissions(
                fx.own_entry_path(),
                std::fs::Permissions::from_mode(0o644),
            );
            assert!(matches!(
                unreadable_outcome,
                Outcome::Skipped(SkipReason::OwnEntryUntouched(_))
            ));
            assert!(refresh.calls().is_empty());
        }

        #[test]
        fn unreadable_applications_directory_yields_scan_incomplete() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();
            let apps = fx.system_data_dir.join(APPLICATIONS_DIR_NAME);
            std::fs::create_dir_all(&apps).unwrap();
            std::fs::set_permissions(&apps, std::fs::Permissions::from_mode(0o000)).unwrap();

            let outcome = reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh);
            let _ = std::fs::set_permissions(&apps, std::fs::Permissions::from_mode(0o755));
            assert!(matches!(
                outcome,
                Outcome::ScanIncomplete(ScanIncompleteReason::DirectoryOpenFailed { .. })
            ));
            assert!(!fx.own_entry_path().exists());
            assert!(refresh.calls().is_empty());
        }

        #[test]
        fn desktop_parser_ignores_keys_outside_desktop_entry_group_and_xdg_fallbacks() {
            let content = format!(
                "[Desktop Action Extra]\n\
                 MimeType=x-scheme-handler/{SCHEME};\n\
                 {OWNERSHIP_KEY}=true\n\
                 [Desktop Entry]\n\
                 Type=Application\n\
                 Name=Other\n"
            );
            let parsed = parse_desktop_entry(&content);
            assert!(!parsed.lists_scheme_handler(SCHEME));
            assert!(!parsed.owned);

            // Relative XDG_DATA_HOME falls back to HOME/.local/share; unset/relative HOME -> NoDataHome.
            let fx = TestFixture::new();
            let home_share = fx._root.path().join("home-root/.local/share");
            std::fs::create_dir_all(&home_share).unwrap();
            let mut env = fx.appimage_env();
            env.xdg_data_home = Some(OsString::from("relative/data"));
            env.home = Some(fx._root.path().join("home-root").into_os_string());
            env.xdg_data_dirs = Some(OsString::from("relative/dir"));
            assert_eq!(resolve_data_home(&env), Some(home_share));
            assert!(resolve_data_dirs(&env).is_empty());

            env.home = Some(OsString::from("relative/home"));
            assert_eq!(resolve_data_home(&env), None);
        }

        #[test]
        fn scan_bounds_4096_entries_and_1_mib_file_yield_scan_incomplete() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            // 1 MiB + 1 byte foreign .desktop file -> ScanIncomplete, no write.
            let apps = fx.system_data_dir.join(APPLICATIONS_DIR_NAME);
            std::fs::create_dir_all(&apps).unwrap();
            let huge = apps.join("huge.desktop");
            std::fs::write(&huge, vec![b'a'; MAX_DESKTOP_FILE_BYTES + 1]).unwrap();
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::ScanIncomplete(ScanIncompleteReason::ForeignFileTooLarge { .. })
            ));
            assert!(!fx.own_entry_path().exists());
            std::fs::remove_file(&huge).unwrap();

            // 4097 entries in one directory -> ScanIncomplete, no write.
            for index in 0..=MAX_DIRECTORY_ENTRIES {
                std::fs::write(apps.join(format!("e{index}.txt")), b"").unwrap();
            }
            assert!(matches!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::ScanIncomplete(ScanIncompleteReason::TooManyEntries {
                    limit: MAX_DIRECTORY_ENTRIES,
                    ..
                })
            ));
            assert!(!fx.own_entry_path().exists());
        }

        #[test]
        fn escaping_round_trip_for_special_characters_and_newline_refusal() {
            // Exact rendered bytes for a fixed path containing space, $, `, ", \ and %.
            let fixed_path = r#"/opt/My App/x$`"\%.AppImage"#;
            let expected = concat!(
                "[Desktop Entry]\n",
                "Type=Application\n",
                "Name=ChessRiddle Studio\n",
                "NoDisplay=true\n",
                "Terminal=false\n",
                r#"Exec="/opt/My App/x\\$\\`\\"\\\\%%.AppImage" %u"#,
                "\n",
                r#"TryExec=/opt/My App/x$`"\\%.AppImage"#,
                "\n",
                "MimeType=x-scheme-handler/chessriddle-studio;\n",
                "X-ChessRiddle-Studio-AppImage-Handler=true\n",
            );
            assert_eq!(render_desktop_entry(fixed_path), expected);

            // Raw escape/unescape assertion so identity implementations fail.
            let raw_val = r" a\b";
            let escaped = escape_desktop_string(raw_val);
            assert_eq!(escaped, r"\sa\\b");
            assert_eq!(unescape_desktop_string(&escaped), raw_val);

            let special = "/home/user/my \"app\" $1 `cmd` \\dir\\100%u.AppImage";
            let rendered = render_desktop_entry(special);
            let parsed = parse_desktop_entry(&rendered);
            assert!(parsed.owned);
            assert!(parsed.lists_scheme_handler(SCHEME));
            assert!(!parsed.hidden);
            assert_eq!(parsed.try_exec.as_deref(), Some(special));

            // Exec line after desktop string-value unescaping should have double-quoted arg with
            // ", `, $, \ backslash-escaped and % doubled, followed by " %u".
            assert_eq!(
                parsed.exec.as_deref(),
                Some("\"/home/user/my \\\"app\\\" \\$1 \\`cmd\\` \\\\dir\\\\100%%u.AppImage\" %u")
            );

            // Newline in APPIMAGE is refused before any write.
            let fx = TestFixture::new();
            let mut env = fx.appimage_env();
            env.appimage = Some(OsString::from("/tmp/bad\nname.AppImage"));
            assert!(matches!(
                classify_run(&env, Ok(fx.exe_in_appdir.clone())),
                RunKind::Undetermined(UndeterminedReason::MalformedAppImage(_))
            ));
        }

        #[test]
        fn xdg_data_home_missing_means_no_write() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();
            let mut env = fx.appimage_env();
            env.xdg_data_home = Some(fx._root.path().join("does-not-exist").into_os_string());
            assert!(matches!(
                reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Skipped(SkipReason::DataHomeMissing(_))
            ));
            assert!(refresh.calls().is_empty());
        }

        #[test]
        fn refresh_runner_handles_timeout_missing_tool_and_nonzero_exit_without_failing_reconcile()
        {
            let fx = TestFixture::new();

            // Timeout: kills and reaps child that outlives the 200 ms bound.
            let slow_script = fx._root.path().join("slow-refresh.sh");
            crate::infra::test_executable::publish_test_executable(
                &slow_script,
                b"#!/bin/sh\nexec sleep 30\n",
                0o755,
            )
            .expect("publish slow refresh test script");
            let slow_runner = CommandRefreshRunner {
                program: slow_script.into_os_string(),
                timeout: Duration::from_millis(200),
            };
            let start = Instant::now();
            let outcome = reconcile(
                &fx.appimage_env(),
                Ok(fx.exe_in_appdir.clone()),
                &slow_runner,
            );
            assert!(start.elapsed() < Duration::from_secs(5));
            assert_eq!(
                outcome,
                Outcome::Written {
                    durable: true,
                    refresh: RefreshOutcome::TimedOut { reaped: true },
                }
            );

            // Missing tool -> RefreshOutcome::ToolMissing, reconciliation still succeeds.
            let missing_runner = CommandRefreshRunner {
                program: OsString::from("/nonexistent/update-desktop-database-missing"),
                timeout: Duration::from_secs(1),
            };
            assert_eq!(
                missing_runner.refresh(&fx.data_home),
                RefreshOutcome::ToolMissing
            );

            // Non-zero exit -> RefreshOutcome::NonZeroExit, reconciliation still succeeds.
            let fail_script = fx._root.path().join("fail-refresh.sh");
            crate::infra::test_executable::publish_test_executable(
                &fail_script,
                b"#!/bin/sh\nexit 7\n",
                0o755,
            )
            .expect("publish failing refresh test script");
            let failing_runner = CommandRefreshRunner {
                program: fail_script.into_os_string(),
                timeout: Duration::from_secs(5),
            };
            assert_eq!(
                failing_runner.refresh(&fx.data_home),
                RefreshOutcome::NonZeroExit {
                    code: Some(7),
                    signal: None,
                }
            );

            // Recording runner returning a failure never fails reconciliation.
            let fx2 = TestFixture::new();
            let failing_mock = RecordingRefresh::returning(RefreshOutcome::NonZeroExit {
                code: Some(1),
                signal: None,
            });
            assert_eq!(
                reconcile(
                    &fx2.appimage_env(),
                    Ok(fx2.exe_in_appdir.clone()),
                    &failing_mock
                ),
                Outcome::Written {
                    durable: true,
                    refresh: RefreshOutcome::NonZeroExit {
                        code: Some(1),
                        signal: None,
                    },
                }
            );
        }

        #[test]
        fn foreign_handler_in_data_home_prevents_write_and_triggers_removal() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            // Foreign handler in $XDG_DATA_HOME/applications (e.g. from scripts/install-local.sh).
            write_foreign_handler(&fx.data_home, "chessriddle-studio.desktop", "");

            // Absent owned entry: AppImage run does not write our entry.
            assert_eq!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Unchanged
            );
            assert!(!fx.own_entry_path().exists());
            assert!(refresh.calls().is_empty());

            // Present owned entry: AppImage run removes our entry.
            std::fs::write(
                fx.own_entry_path(),
                render_desktop_entry(fx.appimage_file.to_str().unwrap()),
            )
            .unwrap();
            assert_eq!(
                reconcile(&fx.appimage_env(), Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Removed {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert!(!fx.own_entry_path().exists());
            assert_eq!(refresh.calls().len(), 1);
        }

        #[test]
        fn bare_name_try_exec_is_not_provably_missing_when_path_is_unset_or_empty() {
            assert!(!try_exec_is_provably_missing("nonexistent-bin", None));
            assert!(!try_exec_is_provably_missing(
                "nonexistent-bin",
                Some(OsStr::new(""))
            ));
            assert!(!try_exec_is_provably_missing(
                "nonexistent-bin",
                Some(OsStr::new("::"))
            ));
        }

        #[test]
        fn indeterminate_try_exec_permission_denied_is_not_provably_missing() {
            if rustix::process::geteuid().is_root() {
                return;
            }
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();
            let locked_dir = fx._root.path().join("locked");
            std::fs::create_dir_all(&locked_dir).unwrap();
            let hidden_target = locked_dir.join("target-app");
            std::fs::write(&hidden_target, b"bin").unwrap();

            // Write owned entry pointing inside locked_dir, then lock the directory.
            let apps = fx.data_home.join(APPLICATIONS_DIR_NAME);
            std::fs::create_dir_all(&apps).unwrap();
            std::fs::write(
                fx.own_entry_path(),
                render_desktop_entry(hidden_target.to_str().unwrap()),
            )
            .unwrap();

            std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o000)).unwrap();

            // Owned entry: PermissionDenied is indeterminate -> Other run keeps it.
            let owned_outcome = reconcile(&fx.other_env(), Ok(fx.exe_outside.clone()), &refresh);
            let owned_exists = fx.own_entry_path().exists();

            // Foreign entry: PermissionDenied is indeterminate -> still counts as a handler.
            let fx2 = TestFixture::new();
            let refresh2 = RecordingRefresh::default();
            write_foreign_handler(
                &fx2.system_data_dir,
                "foreign.desktop",
                &format!("TryExec={}\n", hidden_target.display()),
            );
            let foreign_outcome = reconcile(
                &fx2.appimage_env(),
                Ok(fx2.exe_in_appdir.clone()),
                &refresh2,
            );
            let foreign_own_exists = fx2.own_entry_path().exists();

            // Restore permissions before assertions / tempdir drop.
            let _ = std::fs::set_permissions(&locked_dir, std::fs::Permissions::from_mode(0o755));

            assert_eq!(owned_outcome, Outcome::Unchanged);
            assert!(owned_exists);
            assert_eq!(foreign_outcome, Outcome::Unchanged);
            assert!(!foreign_own_exists);
        }

        #[test]
        fn resolve_data_dirs_defaults_when_xdg_data_dirs_unset_or_empty() {
            let expected = vec![
                PathBuf::from("/usr/local/share"),
                PathBuf::from("/usr/share"),
            ];
            let unset = Environment::default();
            assert_eq!(resolve_data_dirs(&unset), expected);

            let empty = Environment {
                xdg_data_dirs: Some(OsString::from("")),
                ..Environment::default()
            };
            assert_eq!(resolve_data_dirs(&empty), expected);
        }

        #[test]
        fn data_dirs_inside_appdir_are_excluded_from_scan_while_external_dirs_still_count() {
            let fx = TestFixture::new();
            let refresh = RecordingRefresh::default();

            let appdir_share = fx.appdir.join("usr/share");
            write_foreign_handler(&appdir_share, "ChessRiddle Studio.desktop", "");

            // Mirror AppRun's XDG_DATA_DIRS: "$APPDIR/usr/share/:$APPDIR/usr/share:<system>:"
            let mut appdir_share_trailing = appdir_share.as_os_str().to_os_string();
            appdir_share_trailing.push("/");
            let mut xdg_data_dirs = OsString::new();
            xdg_data_dirs.push(&appdir_share_trailing);
            xdg_data_dirs.push(":");
            xdg_data_dirs.push(appdir_share.as_os_str());
            xdg_data_dirs.push(":");
            xdg_data_dirs.push(fx.system_data_dir.as_os_str());
            xdg_data_dirs.push(":");

            let mut env = fx.appimage_env();
            env.xdg_data_dirs = Some(xdg_data_dirs);

            // Packaged entry inside APPDIR is ignored -> AppImage writes our handler entry.
            assert_eq!(
                reconcile(&env, Ok(fx.exe_in_appdir.clone()), &refresh),
                Outcome::Written {
                    durable: true,
                    refresh: RefreshOutcome::Succeeded,
                }
            );
            assert!(fx.own_entry_path().exists());

            // The same entry placed in a data dir outside APPDIR counts -> does not write.
            let fx2 = TestFixture::new();
            let refresh2 = RecordingRefresh::default();
            write_foreign_handler(&fx2.system_data_dir, "ChessRiddle Studio.desktop", "");
            assert_eq!(
                reconcile(
                    &fx2.appimage_env(),
                    Ok(fx2.exe_in_appdir.clone()),
                    &refresh2
                ),
                Outcome::Unchanged
            );
            assert!(!fx2.own_entry_path().exists());
            assert!(refresh2.calls().is_empty());
        }
    }
}
