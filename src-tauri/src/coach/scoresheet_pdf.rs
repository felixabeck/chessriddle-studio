//! Isolated PDF page rendering helper for scoresheet intake.
//!
//! Untrusted PDFs are rendered inside a short-lived child process — the app's own executable
//! started with the hidden [`HELPER_ARG`] flag — before any Tauri, logging, instance-lock or
//! Specta setup runs. The child applies its own memory cap (Linux `RLIMIT_DATA`, Windows job
//! object; macOS relies on the deadline), suppresses core dumps / crash dialogs (Linux
//! `RLIMIT_CORE = 0` plus `PR_SET_DUMPABLE = 0` so piped `core_pattern` handlers also skip core
//! dumps; other Unix `RLIMIT_CORE = 0`; Windows `SetErrorMode`), and arms a wall-clock deadline
//! before parsing stdin. The parent enforces the same deadline, bounds stdout, kills and reaps
//! the child on every exit path, and validates every returned JPEG through
//! [`super::scoresheet_photo::process_image_bytes`].

use std::{
    ffi::OsStr,
    io::{Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use hayro::{
    hayro_interpret::{InterpreterSettings, InterpreterWarning},
    hayro_syntax::{
        object::{Array, Stream},
        page::Page,
        Pdf,
    },
    vello_cpu::color::palette::css::WHITE,
    PixmapSettings, RenderCache, RenderSettings,
};
use image::{Rgb, RgbImage};

use super::{
    error::CoachError,
    scoresheet_photo::{
        encode_rgb_jpeg_bounded, process_image_bytes, ScoresheetPhoto, MAX_INPUT_FILE_BYTES,
        MAX_LONG_EDGE, MAX_OUTPUT_JPEG_BYTES, MAX_SCORESHEET_PHOTOS,
    },
};

/// Hidden exact-match CLI argument that switches the app binary into PDF helper mode at the top
/// of `fn main()`. Never exposed as a user-facing CLI option.
pub(crate) const HELPER_ARG: &str = "--internal-scoresheet-pdf-render";

/// Maximum number of PDF pages rendered in one helper invocation (matches the intake image cap).
pub(crate) const MAX_PDF_PAGES_PER_CALL: usize = MAX_SCORESHEET_PHOTOS;

/// Per-process memory cap applied by the child before parsing (Linux `RLIMIT_DATA`, Windows
/// `JOB_OBJECT_LIMIT_PROCESS_MEMORY`).
///
/// Measured on Linux against the real `chessriddle-studio` binary in helper mode:
/// - Release binary: 5-page A4 300-dpi scan (4 rendered) ~95 MB peak RSS (0.25 s); one A4
///   600-dpi page (4960×7016 JPEG, 4.7 MB PDF) ~162 MB (0.19 s); four A4 600-dpi pages (18.8 MB
///   PDF) ~200 MB (0.67 s). 512 MiB leaves >2.5× headroom for 600-dpi 4-page scans while
///   aborting a 2 GiB-inflating Flate bomb (2.09 MB PDF, exit 134, SIGABRT).
/// - Debug binary: 5-page A4 300-dpi scan (4 rendered) ~116 MiB peak RSS (~13.1 s).
pub(crate) const HELPER_MEMORY_CAP_BYTES: usize = 512 * 1024 * 1024;

/// Wall-clock deadline enforced by both the child watchdog thread and the parent supervisor.
///
/// Measured on Linux against the real `chessriddle-studio` binary: a 5-page A4 300-dpi scan
/// (4 pages rendered) takes ~0.25 s in release and ~13.1 s in an unoptimized debug binary; 30 s
/// leaves ample margin across build profiles and slower machines while still bounding CPU-heavy
/// content streams and macOS memory bombs.
pub(crate) const HELPER_DEADLINE: Duration = Duration::from_secs(30);

/// Poll interval used by the parent supervisor while waiting for the helper child to exit under
/// [`HELPER_DEADLINE`]. Short enough to observe completion promptly without busy-spinning.
const HELPER_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Maximum bytes the parent will read from helper stdout:
/// 8-byte header (`total_pages: u32`, `rendered_count: u32`) plus at most
/// `MAX_PDF_PAGES_PER_CALL` pages, each prefixed with a 4-byte length and bounded by
/// `MAX_OUTPUT_JPEG_BYTES`.
pub(crate) const MAX_HELPER_STDOUT_BYTES: usize =
    8 + MAX_PDF_PAGES_PER_CALL * (4 + MAX_OUTPUT_JPEG_BYTES);

/// Minimum finite crop-box width/height accepted before rendering. Guards against `hayro-syntax`
/// silently substituting A4 dimensions when `width` or `height` is nearly zero.
const MIN_CROP_BOX_DIMENSION: f64 = 1e-3;

const EXIT_OK: i32 = 0;
const EXIT_LIMIT_SETUP_FAILED: i32 = 2;
const EXIT_PROTOCOL_ERROR: i32 = 3;
const EXIT_DECODE_FAILURE: i32 = 4;
const EXIT_DEADLINE: i32 = 124;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LimitError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PdfRenderError {
    LoadFailed,
    EmptyDocument,
    DegeneratePage,
    UnreadableContents,
    ImageDecodeFailure,
    EncodeFailed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderedPdfBytes {
    pub total_pages: usize,
    pub pages: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderedPdf {
    pub total_pages: usize,
    pub photos: Vec<ScoresheetPhoto>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HelperFailure {
    SpawnFailed {
        stage: &'static str,
        kind: Option<std::io::ErrorKind>,
    },
    Deadline,
    LimitSetupFailed,
    ExitStatus {
        code: Option<i32>,
        signal: Option<i32>,
    },
    WaitFailed {
        kind: std::io::ErrorKind,
    },
    DecodeFailure,
    MalformedOutput,
}

impl std::fmt::Display for HelperFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SpawnFailed {
                stage,
                kind: Some(kind),
            } => write!(f, "spawn_failed (stage={stage}, io={kind:?})"),
            Self::SpawnFailed { stage, kind: None } => {
                write!(f, "spawn_failed (stage={stage})")
            }
            Self::Deadline => f.write_str("deadline"),
            Self::LimitSetupFailed => f.write_str("limit_setup_failed"),
            Self::ExitStatus {
                code: Some(code), ..
            } => write!(f, "exit_status (code={code})"),
            Self::ExitStatus {
                signal: Some(signal),
                ..
            } => write!(f, "exit_status (signal={signal})"),
            Self::ExitStatus { .. } => f.write_str("exit_status (unknown)"),
            Self::WaitFailed { kind } => write!(f, "wait_failed (io={kind:?})"),
            Self::DecodeFailure => f.write_str("decode_failure"),
            Self::MalformedOutput => f.write_str("malformed_output"),
        }
    }
}

fn exit_signal(status: std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt as _;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

struct ChildGuard(Option<Child>);

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self(Some(child))
    }

    fn as_mut(&mut self) -> Option<&mut Child> {
        self.0.as_mut()
    }

    fn mark_reaped(&mut self) {
        self.0 = None;
    }

    fn kill_and_reap(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        self.kill_and_reap();
    }
}

/// Checks whether the process was launched with the hidden helper argument and, if so, executes
/// helper mode and returns its exit status.
///
/// Must be the very first statement of `fn main()`, before any Tauri, logging, instance-lock,
/// or Specta initialisation.
pub(crate) fn maybe_run_from_args() -> Option<i32> {
    let mut args = std::env::args_os();
    let _exe = args.next()?;
    let arg = args.next()?;
    if arg == OsStr::new(HELPER_ARG) && args.next().is_none() {
        Some(run_helper_stdio())
    } else {
        None
    }
}

fn run_helper_stdio() -> i32 {
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    run_helper_with_limits(
        || apply_child_limits(HELPER_MEMORY_CAP_BYTES, HELPER_DEADLINE),
        &mut stdin,
        &mut stdout,
    )
}

fn run_helper_with_limits<F, R, W>(apply_limits: F, reader: &mut R, writer: &mut W) -> i32
where
    F: FnOnce() -> Result<(), LimitError>,
    R: Read,
    W: Write,
{
    if apply_limits().is_err() {
        return EXIT_LIMIT_SETUP_FAILED;
    }
    let Ok((max_pages, pdf_bytes)) = read_request(reader) else {
        return EXIT_PROTOCOL_ERROR;
    };
    let Ok(rendered) = render_pdf_pages(&pdf_bytes, max_pages) else {
        return EXIT_DECODE_FAILURE;
    };
    if write_response(writer, &rendered).is_err() {
        return EXIT_PROTOCOL_ERROR;
    }
    EXIT_OK
}

fn apply_child_limits(memory_cap_bytes: usize, deadline: Duration) -> Result<(), LimitError> {
    #[cfg(unix)]
    disable_core_dumps()?;
    #[cfg(windows)]
    disable_error_dialogs();
    apply_memory_cap(memory_cap_bytes)?;
    spawn_deadline_watchdog(deadline)?;
    Ok(())
}

fn spawn_deadline_watchdog(deadline: Duration) -> Result<(), LimitError> {
    std::thread::Builder::new()
        .name("pdf-deadline".into())
        .spawn(move || {
            std::thread::sleep(deadline);
            std::process::exit(EXIT_DEADLINE);
        })
        .map(|_| ())
        .map_err(|_| LimitError)
}

#[cfg(unix)]
fn disable_core_dumps() -> Result<(), LimitError> {
    let zero = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `zero` is a valid initialized `libc::rlimit` passed to `setrlimit(RLIMIT_CORE)`.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &zero) } != 0 {
        return Err(LimitError);
    }
    // On Linux, piped `/proc/sys/kernel/core_pattern` handlers ignore `RLIMIT_CORE = 0`.
    // Marking the process non-dumpable prevents core dumps even with a pipe handler.
    #[cfg(target_os = "linux")]
    // SAFETY: `PR_SET_DUMPABLE` takes a single flag value (0 = SUID_DUMP_DISABLE).
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(LimitError);
    }
    Ok(())
}

#[cfg(windows)]
fn disable_error_dialogs() {
    use windows_sys::Win32::System::Diagnostics::Debug::{
        SetErrorMode, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX,
    };

    // SAFETY: Process-wide error mode flags suppress modal crash dialogs on abort.
    unsafe {
        SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
    }
}

#[cfg(target_os = "linux")]
fn apply_memory_cap(memory_cap_bytes: usize) -> Result<(), LimitError> {
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `current` is a valid mutable `libc::rlimit` pointer.
    if unsafe { libc::getrlimit(libc::RLIMIT_DATA, &mut current) } != 0 {
        return Err(LimitError);
    }
    let cap = memory_cap_bytes as libc::rlim_t;
    let new_max = if current.rlim_max == libc::RLIM_INFINITY {
        cap
    } else {
        current.rlim_max.min(cap)
    };
    let new_cur = if current.rlim_cur == libc::RLIM_INFINITY {
        new_max
    } else {
        current.rlim_cur.min(new_max)
    };
    let next = libc::rlimit {
        rlim_cur: new_cur,
        rlim_max: new_max,
    };
    // SAFETY: `next` is a valid `libc::rlimit` pointer and `new_cur <= new_max <= current.rlim_max`.
    if unsafe { libc::setrlimit(libc::RLIMIT_DATA, &next) } != 0 {
        return Err(LimitError);
    }
    Ok(())
}

#[cfg(windows)]
fn apply_memory_cap(memory_cap_bytes: usize) -> Result<(), LimitError> {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_PROCESS_MEMORY,
            },
            Threading::GetCurrentProcess,
        },
    };

    // SAFETY: Creating an unnamed job object with default security attributes.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(LimitError);
    }
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    info.ProcessMemoryLimit = memory_cap_bytes;
    let Ok(info_size) = u32::try_from(std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>())
    else {
        // SAFETY: `job` is a valid handle returned by `CreateJobObjectW`.
        unsafe { CloseHandle(job) };
        return Err(LimitError);
    };
    // SAFETY: `job` is a valid handle and `info` has matching size.
    let set_ok = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const info).cast(),
            info_size,
        )
    };
    if set_ok == 0 {
        // SAFETY: `job` is a valid handle returned by `CreateJobObjectW`.
        unsafe { CloseHandle(job) };
        return Err(LimitError);
    }
    // SAFETY: `job` is a valid handle and `GetCurrentProcess()` returns the current pseudo-handle.
    let assign_ok = unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) };
    if assign_ok == 0 {
        // SAFETY: `job` is a valid handle returned by `CreateJobObjectW`.
        unsafe { CloseHandle(job) };
        return Err(LimitError);
    }
    // Keep `job` open for the short-lived child lifetime so the process memory limit stays active.
    Ok(())
}

#[cfg(not(any(target_os = "linux", windows)))]
fn apply_memory_cap(_memory_cap_bytes: usize) -> Result<(), LimitError> {
    // macOS and other non-Linux Unix platforms have no enforceable per-process heap limit;
    // covered by the wall-clock deadline and child process isolation.
    Ok(())
}

fn read_u32_le<R: Read>(reader: &mut R) -> std::io::Result<u32> {
    let mut buf = [0u8; 4];
    reader.read_exact(&mut buf)?;
    Ok(u32::from_le_bytes(buf))
}

fn read_request<R: Read>(reader: &mut R) -> Result<(usize, Vec<u8>), ()> {
    let max_pages = read_u32_le(reader).map_err(|_| ())? as usize;
    if max_pages == 0 || max_pages > MAX_PDF_PAGES_PER_CALL {
        return Err(());
    }
    let pdf_len = read_u32_le(reader).map_err(|_| ())? as usize;
    if pdf_len == 0 || pdf_len > MAX_INPUT_FILE_BYTES {
        return Err(());
    }
    let mut pdf_bytes = Vec::new();
    pdf_bytes.try_reserve_exact(pdf_len).map_err(|_| ())?;
    pdf_bytes.resize(pdf_len, 0);
    reader.read_exact(&mut pdf_bytes).map_err(|_| ())?;
    Ok((max_pages, pdf_bytes))
}

fn write_request<W: Write>(
    writer: &mut W,
    max_pages: usize,
    pdf_bytes: &[u8],
) -> std::io::Result<()> {
    let max_pages = u32::try_from(max_pages)
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "max_pages overflow"))?;
    let pdf_len = u32::try_from(pdf_bytes.len())
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "pdf_len overflow"))?;
    writer.write_all(&max_pages.to_le_bytes())?;
    writer.write_all(&pdf_len.to_le_bytes())?;
    writer.write_all(pdf_bytes)?;
    writer.flush()
}

fn write_response<W: Write>(writer: &mut W, rendered: &RenderedPdfBytes) -> std::io::Result<()> {
    let total_pages = u32::try_from(rendered.total_pages).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "total_pages overflow")
    })?;
    let rendered_count = u32::try_from(rendered.pages.len()).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "rendered_count overflow")
    })?;
    writer.write_all(&total_pages.to_le_bytes())?;
    writer.write_all(&rendered_count.to_le_bytes())?;
    for page in &rendered.pages {
        let len = u32::try_from(page.len()).map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "page len overflow")
        })?;
        writer.write_all(&len.to_le_bytes())?;
        writer.write_all(page)?;
    }
    writer.flush()
}

fn parse_response(buf: &[u8], max_pages: usize) -> Result<RenderedPdfBytes, HelperFailure> {
    if buf.len() < 8 {
        return Err(HelperFailure::MalformedOutput);
    }
    let total_pages = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    let rendered_count = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    if total_pages == 0 || rendered_count == 0 || rendered_count != total_pages.min(max_pages) {
        return Err(HelperFailure::MalformedOutput);
    }
    let mut cursor = 8usize;
    let mut pages = Vec::with_capacity(rendered_count);
    for _ in 0..rendered_count {
        let Some(len_bytes) = buf.get(cursor..cursor + 4) else {
            return Err(HelperFailure::MalformedOutput);
        };
        cursor += 4;
        let len =
            u32::from_le_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
        if len == 0 || len > MAX_OUTPUT_JPEG_BYTES {
            return Err(HelperFailure::MalformedOutput);
        }
        let Some(page_bytes) = buf.get(cursor..cursor + len) else {
            return Err(HelperFailure::MalformedOutput);
        };
        cursor += len;
        pages.push(page_bytes.to_vec());
    }
    if cursor != buf.len() {
        return Err(HelperFailure::MalformedOutput);
    }
    Ok(RenderedPdfBytes { total_pages, pages })
}

fn validate_page_contents(page: &Page<'_>) -> Result<(), PdfRenderError> {
    if !page.raw().contains_key(b"Contents") {
        return Ok(());
    }
    if let Some(stream) = page.raw().get::<Stream<'_>>(b"Contents") {
        if stream.decoded_data().is_err() {
            return Err(PdfRenderError::UnreadableContents);
        }
    } else if let Some(array) = page.raw().get::<Array<'_>>(b"Contents") {
        let raw_count = array.raw_iter().count();
        let mut decoded_count = 0usize;
        for stream in array.iter::<Stream<'_>>() {
            if stream.decoded_data().is_err() {
                return Err(PdfRenderError::UnreadableContents);
            }
            decoded_count += 1;
        }
        if decoded_count != raw_count {
            return Err(PdfRenderError::UnreadableContents);
        }
    } else {
        return Err(PdfRenderError::UnreadableContents);
    }
    if page.page_stream().is_none() {
        return Err(PdfRenderError::UnreadableContents);
    }
    Ok(())
}

/// Renders up to `max_pages` of a PDF in-process into bounded JPEG byte buffers.
///
/// Production callers must invoke this only inside the isolated helper process.
pub(crate) fn render_pdf_pages(
    pdf_bytes: &[u8],
    max_pages: usize,
) -> Result<RenderedPdfBytes, PdfRenderError> {
    if max_pages == 0 || max_pages > MAX_PDF_PAGES_PER_CALL || pdf_bytes.is_empty() {
        return Err(PdfRenderError::LoadFailed);
    }
    let pdf = Pdf::new(Arc::new(pdf_bytes.to_vec())).map_err(|_| PdfRenderError::LoadFailed)?;
    let pages = pdf.pages();
    let total_pages = pages.len();
    if total_pages == 0 {
        return Err(PdfRenderError::EmptyDocument);
    }

    let to_render = total_pages.min(max_pages);
    let cache = RenderCache::new();
    let render_settings = RenderSettings::default();
    let mut encoded_pages = Vec::with_capacity(to_render);

    for page in &pages[..to_render] {
        let crop_box = page.intersected_crop_box();
        let box_w = crop_box.width();
        let box_h = crop_box.height();
        if !crop_box.x0.is_finite()
            || !crop_box.y0.is_finite()
            || !crop_box.x1.is_finite()
            || !crop_box.y1.is_finite()
            || !box_w.is_finite()
            || !box_h.is_finite()
            || box_w <= MIN_CROP_BOX_DIMENSION
            || box_h <= MIN_CROP_BOX_DIMENSION
        {
            return Err(PdfRenderError::DegeneratePage);
        }

        validate_page_contents(page)?;

        let (render_w, render_h) = page.render_dimensions();
        if !render_w.is_finite() || !render_h.is_finite() || render_w <= 0.0 || render_h <= 0.0 {
            return Err(PdfRenderError::DegeneratePage);
        }

        let long_edge = render_w.max(render_h);
        let scale = (MAX_LONG_EDGE as f32) / long_edge;
        if !scale.is_finite() || scale <= 0.0 {
            return Err(PdfRenderError::DegeneratePage);
        }
        let scaled_w = (render_w * scale) as u32;
        let scaled_h = (render_h * scale) as u32;
        if scaled_w == 0 || scaled_h == 0 || scaled_w > MAX_LONG_EDGE || scaled_h > MAX_LONG_EDGE {
            return Err(PdfRenderError::DegeneratePage);
        }

        let image_decode_failed = Arc::new(AtomicBool::new(false));
        let warning_flag = Arc::clone(&image_decode_failed);
        let interpreter_settings = InterpreterSettings {
            warning_sink: Arc::new(move |warning| {
                if matches!(warning, InterpreterWarning::ImageDecodeFailure) {
                    warning_flag.store(true, Ordering::SeqCst);
                }
            }),
            ..InterpreterSettings::default()
        };

        let pixmap = hayro::render(
            page,
            &cache,
            &interpreter_settings,
            &render_settings,
            &PixmapSettings {
                x_scale: scale,
                y_scale: scale,
                bg_color: WHITE,
            },
        );

        if image_decode_failed.load(Ordering::SeqCst) {
            return Err(PdfRenderError::ImageDecodeFailure);
        }

        let width = u32::from(pixmap.width());
        let height = u32::from(pixmap.height());
        if width == 0 || height == 0 {
            return Err(PdfRenderError::DegeneratePage);
        }

        let mut rgb = RgbImage::new(width, height);
        for (dst, src) in rgb.pixels_mut().zip(pixmap.data()) {
            // Pixmap is rendered onto opaque WHITE; composite any residual premultiplied alpha
            // over white so transparent pixels never darken.
            let inv_a = 255u8.saturating_sub(src.a);
            *dst = Rgb([
                src.r.saturating_add(inv_a),
                src.g.saturating_add(inv_a),
                src.b.saturating_add(inv_a),
            ]);
        }

        let jpeg = encode_rgb_jpeg_bounded(&rgb, MAX_OUTPUT_JPEG_BYTES)
            .map_err(|_| PdfRenderError::EncodeFailed)?;
        encoded_pages.push(jpeg);
    }

    Ok(RenderedPdfBytes {
        total_pages,
        pages: encoded_pages,
    })
}

fn configure_helper_env(command: &mut Command) {
    command.env_clear();
    #[cfg(target_os = "linux")]
    if let Some(value) = std::env::var_os("LD_LIBRARY_PATH") {
        command.env("LD_LIBRARY_PATH", value);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        for key in ["SystemRoot", "WINDIR"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

struct HelperCommandSpec {
    exe: PathBuf,
    args: Vec<String>,
    extra_env: Vec<(String, String)>,
}

/// Renders up to `max_pages` of a PDF in an isolated child process and validates every returned
/// page through [`process_image_bytes`].
///
/// Must be called from inside a blocking worker (e.g. `BLOCKING_GATEWAY`), never directly on a
/// Tokio worker thread.
pub(crate) fn render_pdf_in_helper(
    pdf_bytes: &[u8],
    max_pages: usize,
) -> Result<RenderedPdf, CoachError> {
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            let failure = HelperFailure::SpawnFailed {
                stage: "current_exe",
                kind: Some(error.kind()),
            };
            log::warn!("scoresheet pdf helper failed: {failure}");
            return Err(CoachError::PhotoUnreadable);
        }
    };
    let spec = HelperCommandSpec {
        exe,
        args: vec![HELPER_ARG.to_owned()],
        extra_env: Vec::new(),
    };
    render_pdf_with_command(
        pdf_bytes,
        max_pages,
        &spec,
        HELPER_DEADLINE,
        MAX_HELPER_STDOUT_BYTES,
    )
    .map_err(|failure| {
        log::warn!("scoresheet pdf helper failed: {failure}");
        CoachError::PhotoUnreadable
    })
}

fn render_pdf_with_command(
    pdf_bytes: &[u8],
    max_pages: usize,
    spec: &HelperCommandSpec,
    deadline: Duration,
    max_stdout_bytes: usize,
) -> Result<RenderedPdf, HelperFailure> {
    if max_pages == 0
        || max_pages > MAX_PDF_PAGES_PER_CALL
        || pdf_bytes.is_empty()
        || pdf_bytes.len() > MAX_INPUT_FILE_BYTES
    {
        return Err(HelperFailure::DecodeFailure);
    }

    let mut command = Command::new(&spec.exe);
    configure_helper_env(&mut command);
    for (key, value) in &spec.extra_env {
        command.env(key, value);
    }
    command
        .args(&spec.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut child = command
        .spawn()
        .map_err(|error| HelperFailure::SpawnFailed {
            stage: "spawn",
            kind: Some(error.kind()),
        })?;
    let stdin = child.stdin.take().ok_or(HelperFailure::SpawnFailed {
        stage: "stdin_pipe",
        kind: None,
    })?;
    let stdout = child.stdout.take().ok_or(HelperFailure::SpawnFailed {
        stage: "stdout_pipe",
        kind: None,
    })?;
    let mut guard = ChildGuard::new(child);

    let payload = pdf_bytes.to_vec();
    let writer_handle = std::thread::Builder::new()
        .name("pdf-helper-stdin".into())
        .spawn(move || {
            let mut stdin = stdin;
            let _ = write_request(&mut stdin, max_pages, &payload);
        })
        .map_err(|error| HelperFailure::SpawnFailed {
            stage: "stdin_thread",
            kind: Some(error.kind()),
        })?;

    let oversized = Arc::new(AtomicBool::new(false));
    let oversized_reader = Arc::clone(&oversized);
    let read_limit = (max_stdout_bytes as u64).saturating_add(1);
    let reader_handle = std::thread::Builder::new()
        .name("pdf-helper-stdout".into())
        .spawn(move || {
            let mut buf = Vec::new();
            let mut limited = stdout.take(read_limit);
            let read_res = limited.read_to_end(&mut buf);
            if buf.len() > max_stdout_bytes {
                oversized_reader.store(true, Ordering::Release);
            }
            read_res.map(|_| buf)
        })
        .map_err(|error| HelperFailure::SpawnFailed {
            stage: "stdout_thread",
            kind: Some(error.kind()),
        })?;

    let deadline_at = Instant::now() + deadline;
    let status = loop {
        if oversized.load(Ordering::Acquire) {
            guard.kill_and_reap();
            let _ = writer_handle.join();
            let _ = reader_handle.join();
            return Err(HelperFailure::MalformedOutput);
        }
        let waited = match guard.as_mut() {
            Some(child) => child.try_wait(),
            None => {
                return Err(HelperFailure::ExitStatus {
                    code: None,
                    signal: None,
                });
            }
        };
        match waited {
            Ok(Some(status)) => {
                guard.mark_reaped();
                break status;
            }
            Ok(None) => {
                if Instant::now() >= deadline_at {
                    guard.kill_and_reap();
                    let _ = writer_handle.join();
                    let _ = reader_handle.join();
                    return Err(HelperFailure::Deadline);
                }
                std::thread::sleep(HELPER_POLL_INTERVAL);
            }
            Err(error) => {
                guard.kill_and_reap();
                let _ = writer_handle.join();
                let _ = reader_handle.join();
                return Err(HelperFailure::WaitFailed { kind: error.kind() });
            }
        }
    };

    let _ = writer_handle.join();
    let stdout_bytes = match reader_handle.join() {
        Ok(Ok(bytes)) => bytes,
        _ => return Err(HelperFailure::MalformedOutput),
    };

    if oversized.load(Ordering::Acquire) || stdout_bytes.len() > max_stdout_bytes {
        return Err(HelperFailure::MalformedOutput);
    }

    if !status.success() {
        return Err(match status.code() {
            Some(EXIT_LIMIT_SETUP_FAILED) => HelperFailure::LimitSetupFailed,
            Some(EXIT_DECODE_FAILURE) => HelperFailure::DecodeFailure,
            Some(EXIT_DEADLINE) => HelperFailure::Deadline,
            Some(EXIT_PROTOCOL_ERROR) => HelperFailure::MalformedOutput,
            code => HelperFailure::ExitStatus {
                code,
                signal: exit_signal(status),
            },
        });
    }

    let rendered = parse_response(&stdout_bytes, max_pages)?;
    let mut photos = Vec::with_capacity(rendered.pages.len());
    for page_jpeg in &rendered.pages {
        let photo = process_image_bytes(page_jpeg).map_err(|_| HelperFailure::MalformedOutput)?;
        photos.push(photo);
    }

    Ok(RenderedPdf {
        total_pages: rendered.total_pages,
        photos,
    })
}

#[cfg(test)]
pub(crate) mod test_pdf {
    use crate::coach::scoresheet_photo::tests::make_rgb_jpeg;

    /// Minimal PDF builder with exact xref offsets.
    pub(crate) struct PdfBuilder {
        objects: Vec<Vec<u8>>,
    }

    impl PdfBuilder {
        pub(crate) fn new() -> Self {
            Self {
                objects: Vec::new(),
            }
        }

        pub(crate) fn add_object(&mut self, body: Vec<u8>) -> usize {
            self.objects.push(body);
            self.objects.len()
        }

        pub(crate) fn finish(self, root_id: usize, encrypt_id: Option<usize>) -> Vec<u8> {
            let mut out = Vec::new();
            out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
            let mut offsets = Vec::with_capacity(self.objects.len() + 1);
            offsets.push(0usize);
            for (index, body) in self.objects.iter().enumerate() {
                let id = index + 1;
                offsets.push(out.len());
                out.extend_from_slice(format!("{id} 0 obj\n").as_bytes());
                out.extend_from_slice(body);
                out.extend_from_slice(b"\nendobj\n");
            }
            let xref_offset = out.len();
            let count = self.objects.len() + 1;
            out.extend_from_slice(format!("xref\n0 {count}\n").as_bytes());
            out.extend_from_slice(b"0000000000 65535 f \n");
            for offset in offsets.iter().skip(1) {
                out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
            }
            let encrypt_entry = encrypt_id
                .map(|id| format!(" /Encrypt {id} 0 R"))
                .unwrap_or_default();
            out.extend_from_slice(
                format!(
                    "trailer\n<< /Size {count} /Root {root_id} 0 R{encrypt_entry} >>\nstartxref\n{xref_offset}\n%%EOF\n"
                )
                .as_bytes(),
            );
            out
        }
    }

    /// Builds a valid PDF with `page_count` pages, each drawing an embedded JPEG image XObject.
    pub(crate) fn make_jpeg_pages_pdf(page_count: usize, page_w: f32, page_h: f32) -> Vec<u8> {
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(Vec::new());
        let pages_id = builder.add_object(Vec::new());
        let mut kid_ids = Vec::with_capacity(page_count);

        for idx in 0..page_count {
            let color = [
                ((idx * 50 + 40) % 256) as u8,
                ((idx * 80 + 60) % 256) as u8,
                ((idx * 110 + 90) % 256) as u8,
            ];
            let jpeg = make_rgb_jpeg(64, 64, color);
            let mut img_obj = format!(
                "<< /Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
                jpeg.len()
            )
            .into_bytes();
            img_obj.extend_from_slice(&jpeg);
            img_obj.extend_from_slice(b"\nendstream");
            let img_id = builder.add_object(img_obj);

            let content = format!("q {page_w} 0 0 {page_h} 0 0 cm /Im0 Do Q");
            let content_obj = format!(
                "<< /Length {} >>\nstream\n{content}\nendstream",
                content.len()
            )
            .into_bytes();
            let content_id = builder.add_object(content_obj);

            let page_obj = format!(
                "<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {page_w} {page_h}] /Resources << /XObject << /Im0 {img_id} 0 R >> >> /Contents {content_id} 0 R >>"
            )
            .into_bytes();
            kid_ids.push(builder.add_object(page_obj));
        }

        let kids_str = kid_ids
            .iter()
            .map(|id| format!("{id} 0 R"))
            .collect::<Vec<_>>()
            .join(" ");
        builder.objects[catalog_id - 1] =
            format!("<< /Type /Catalog /Pages {pages_id} 0 R >>").into_bytes();
        builder.objects[pages_id - 1] =
            format!("<< /Type /Pages /Kids [{kids_str}] /Count {page_count} >>").into_bytes();
        builder.finish(catalog_id, None)
    }

    /// Builds a 2-page PDF where page 1 is valid and page 2 has a corrupt JPEG image XObject.
    pub(crate) fn make_second_page_corrupt_image_pdf() -> Vec<u8> {
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(Vec::new());
        let pages_id = builder.add_object(Vec::new());

        let good_jpeg = make_rgb_jpeg(32, 32, [30, 120, 200]);
        let mut img1 = format!(
            "<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            good_jpeg.len()
        )
        .into_bytes();
        img1.extend_from_slice(&good_jpeg);
        img1.extend_from_slice(b"\nendstream");
        let img1_id = builder.add_object(img1);

        let content1 = b"q 200 0 0 200 0 0 cm /Im0 Do Q";
        let mut c1 = format!("<< /Length {} >>\nstream\n", content1.len()).into_bytes();
        c1.extend_from_slice(content1);
        c1.extend_from_slice(b"\nendstream");
        let c1_id = builder.add_object(c1);
        let p1_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 {img1_id} 0 R >> >> /Contents {c1_id} 0 R >>"
            )
            .into_bytes(),
        );

        let bad_jpeg = b"not a valid jpeg payload at all";
        let mut img2 = format!(
            "<< /Type /XObject /Subtype /Image /Width 32 /Height 32 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {} >>\nstream\n",
            bad_jpeg.len()
        )
        .into_bytes();
        img2.extend_from_slice(bad_jpeg);
        img2.extend_from_slice(b"\nendstream");
        let img2_id = builder.add_object(img2);

        let p2_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 {img2_id} 0 R >> >> /Contents {c1_id} 0 R >>"
            )
            .into_bytes(),
        );

        builder.objects[catalog_id - 1] =
            format!("<< /Type /Catalog /Pages {pages_id} 0 R >>").into_bytes();
        builder.objects[pages_id - 1] =
            format!("<< /Type /Pages /Kids [{p1_id} 0 R {p2_id} 0 R] /Count 2 >>").into_bytes();
        builder.finish(catalog_id, None)
    }
}

#[cfg(test)]
pub(super) fn render_pdf_in_test_helper(
    pdf_bytes: &[u8],
    max_pages: usize,
    mode: &str,
) -> Result<RenderedPdf, CoachError> {
    let spec = tests::helper_spec(mode);
    render_pdf_with_command(
        pdf_bytes,
        max_pages,
        &spec,
        HELPER_DEADLINE,
        MAX_HELPER_STDOUT_BYTES,
    )
    .map_err(|_| CoachError::PhotoUnreadable)
}

#[cfg(test)]
mod tests {
    use super::{test_pdf::*, *};

    const TEST_HELPER_MODE_ENV: &str = "CHESSFABLE_PDF_HELPER_TEST_MODE";
    const TEST_HELPER_DEADLINE_MS_ENV: &str = "CHESSFABLE_PDF_HELPER_TEST_DEADLINE_MS";

    #[test]
    fn render_pdf_pages_handles_single_and_multi_page_caps() {
        let one_page = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let rendered = render_pdf_pages(&one_page, 4).expect("one-page pdf");
        assert_eq!(rendered.total_pages, 1);
        assert_eq!(rendered.pages.len(), 1);
        let photo = process_image_bytes(&rendered.pages[0]).expect("valid jpeg");
        assert!(photo.data_url.starts_with("data:image/jpeg;base64,"));

        // Verify output scale (long edge == MAX_LONG_EDGE) and white background on a page with
        // only a small dark corner mark leaving the rest of the page blank.
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_vec());
        let stream = b"0 0 0 rg 10 10 20 20 re f";
        let mut content = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
        content.extend_from_slice(stream);
        content.extend_from_slice(b"\nendstream");
        let content_id = builder.add_object(content);
        let _page_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        let sparse_pdf = builder.finish(catalog_id, None);
        let sparse = render_pdf_pages(&sparse_pdf, 4).expect("sparse page pdf");
        let decoded =
            image::load_from_memory_with_format(&sparse.pages[0], image::ImageFormat::Jpeg)
                .expect("decode rendered jpeg")
                .into_rgb8();
        assert_eq!(
            decoded.width().max(decoded.height()),
            MAX_LONG_EDGE,
            "long edge must be scaled to MAX_LONG_EDGE, got {:?}",
            decoded.dimensions()
        );
        let blank_px = decoded
            .get_pixel(decoded.width() / 2, decoded.height() / 2)
            .0;
        assert!(
            blank_px[0] >= 250 && blank_px[1] >= 250 && blank_px[2] >= 250,
            "uncovered page area must be rendered on white background, got {blank_px:?}"
        );

        let five_pages = make_jpeg_pages_pdf(5, 595.0, 842.0);
        let rendered = render_pdf_pages(&five_pages, 4).expect("five-page pdf");
        assert_eq!(rendered.total_pages, 5);
        assert_eq!(rendered.pages.len(), 4);
    }

    #[test]
    fn render_pdf_pages_validates_contents_arrays() {
        // 1. Valid multi-stream /Contents [c1 c2] renders cleanly.
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [5 0 R] /Count 1 >>".to_vec());
        let c1_id = builder.add_object(b"<< /Length 8 >>\nstream\n0 0 0 rg\nendstream".to_vec());
        let c2_id =
            builder.add_object(b"<< /Length 18 >>\nstream\n10 10 40 40 re f  \nendstream".to_vec());
        let _page_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents [{c1_id} 0 R {c2_id} 0 R] >>"
            )
            .into_bytes(),
        );
        let valid_array = builder.finish(catalog_id, None);
        let rendered = render_pdf_pages(&valid_array, 4).expect("valid /Contents array");
        assert_eq!(rendered.total_pages, 1);
        assert_eq!(rendered.pages.len(), 1);

        // 2. Corrupt stream inside /Contents array fails with UnreadableContents.
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [5 0 R] /Count 1 >>".to_vec());
        let c1_id = builder.add_object(b"<< /Length 8 >>\nstream\n0 0 0 rg\nendstream".to_vec());
        let bad_id = builder.add_object(
            b"<< /Filter /DCTDecode /Length 8 >>\nstream\n12345678\nendstream".to_vec(),
        );
        let _page_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents [{c1_id} 0 R {bad_id} 0 R] >>"
            )
            .into_bytes(),
        );
        let corrupt_array = builder.finish(catalog_id, None);
        assert_eq!(
            render_pdf_pages(&corrupt_array, 4),
            Err(PdfRenderError::UnreadableContents)
        );

        // 3. Array with a dangling/non-stream element fails with UnreadableContents.
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_vec());
        let c1_id = builder.add_object(b"<< /Length 8 >>\nstream\n0 0 0 rg\nendstream".to_vec());
        let _page_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents [{c1_id} 0 R 99 0 R] >>"
            )
            .into_bytes(),
        );
        let dangling_array = builder.finish(catalog_id, None);
        assert_eq!(
            render_pdf_pages(&dangling_array, 4),
            Err(PdfRenderError::UnreadableContents)
        );
    }

    #[test]
    fn run_helper_with_limits_fails_closed_before_reading_stdin() {
        struct CountingReader {
            reads: usize,
        }
        impl Read for CountingReader {
            fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                Ok(0)
            }
        }

        let mut reader = CountingReader { reads: 0 };
        let mut writer = Vec::new();
        let code = run_helper_with_limits(|| Err(LimitError), &mut reader, &mut writer);
        assert_eq!(code, EXIT_LIMIT_SETUP_FAILED);
        assert_eq!(
            reader.reads, 0,
            "helper must not read stdin when limit setup fails"
        );
        assert!(writer.is_empty());
    }

    #[test]
    fn parse_response_rejects_malformed_frames() {
        // 1. Header < 8 bytes.
        assert_eq!(
            parse_response(&[1, 0, 0], 4),
            Err(HelperFailure::MalformedOutput)
        );

        // 2. total_pages == 0.
        let mut buf = Vec::new();
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));

        // 3. rendered_count == 0.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));

        // 4. rendered_count != min(total_pages, max_pages) (under and over).
        let mut under = Vec::new();
        under.extend_from_slice(&3u32.to_le_bytes());
        under.extend_from_slice(&2u32.to_le_bytes());
        assert_eq!(
            parse_response(&under, 4),
            Err(HelperFailure::MalformedOutput)
        );
        let mut over = Vec::new();
        over.extend_from_slice(&1u32.to_le_bytes());
        over.extend_from_slice(&2u32.to_le_bytes());
        assert_eq!(
            parse_response(&over, 4),
            Err(HelperFailure::MalformedOutput)
        );

        // 5. Truncated length prefix.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&[0x04, 0x00]);
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));

        // 6. Page len == 0.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));

        // 7. Page len > MAX_OUTPUT_JPEG_BYTES.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&((MAX_OUTPUT_JPEG_BYTES as u32) + 1).to_le_bytes());
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));

        // 8. Truncated payload.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&10u32.to_le_bytes());
        buf.extend_from_slice(&[1, 2, 3, 4]);
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));

        // 9. Trailing bytes after the last page.
        let mut buf = Vec::new();
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&1u32.to_le_bytes());
        buf.extend_from_slice(&3u32.to_le_bytes());
        buf.extend_from_slice(&[0xFF, 0xD8, 0xFF]);
        buf.push(0x00);
        assert_eq!(parse_response(&buf, 4), Err(HelperFailure::MalformedOutput));
    }

    #[test]
    fn helper_failure_display_includes_diagnostics() {
        assert_eq!(
            HelperFailure::SpawnFailed {
                stage: "spawn",
                kind: Some(std::io::ErrorKind::NotFound),
            }
            .to_string(),
            "spawn_failed (stage=spawn, io=NotFound)"
        );
        assert_eq!(
            HelperFailure::LimitSetupFailed.to_string(),
            "limit_setup_failed"
        );
        assert_eq!(
            HelperFailure::ExitStatus {
                code: Some(1),
                signal: None,
            }
            .to_string(),
            "exit_status (code=1)"
        );
        assert_eq!(
            HelperFailure::ExitStatus {
                code: None,
                signal: Some(6),
            }
            .to_string(),
            "exit_status (signal=6)"
        );
        assert_eq!(
            HelperFailure::WaitFailed {
                kind: std::io::ErrorKind::Interrupted,
            }
            .to_string(),
            "wait_failed (io=Interrupted)"
        );
    }

    #[test]
    fn render_pdf_pages_rejects_empty_degenerate_extreme_encrypted_truncated_and_corrupt() {
        // Zero-page PDF.
        let zero_pages = make_jpeg_pages_pdf(0, 595.0, 842.0);
        assert_eq!(
            render_pdf_pages(&zero_pages, 4),
            Err(PdfRenderError::EmptyDocument)
        );

        // Zero / degenerate crop box (hayro would otherwise substitute A4).
        let degenerate_crop = make_jpeg_pages_pdf(1, 0.0, 0.0);
        assert_eq!(
            render_pdf_pages(&degenerate_crop, 4),
            Err(PdfRenderError::DegeneratePage)
        );

        // Extreme aspect ratio where scaled height truncates to 0.
        let extreme = make_jpeg_pages_pdf(1, 100_000.0, 1.0);
        assert_eq!(
            render_pdf_pages(&extreme, 4),
            Err(PdfRenderError::DegeneratePage)
        );

        // Truncated PDF.
        let valid = make_jpeg_pages_pdf(1, 595.0, 842.0);
        assert_eq!(
            render_pdf_pages(&valid[..24], 4),
            Err(PdfRenderError::LoadFailed)
        );

        // Encrypted PDF (Standard security handler with /Encrypt dictionary).
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec());
        let _page_id =
            builder.add_object(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>".to_vec());
        let encrypt_id = builder.add_object(
            b"<< /Filter /Standard /V 1 /R 2 /O (12345678901234567890123456789012) /U (12345678901234567890123456789012) /P -4 >>".to_vec(),
        );
        let encrypted = builder.finish(catalog_id, Some(encrypt_id));
        assert_eq!(
            render_pdf_pages(&encrypted, 4),
            Err(PdfRenderError::LoadFailed)
        );

        // Page with declared /Contents stream that cannot be decoded (dangling reference and
        // unreadable stream filter).
        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec());
        let _page_id = builder.add_object(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 99 0 R >>".to_vec(),
        );
        let dangling_contents = builder.finish(catalog_id, None);
        assert_eq!(
            render_pdf_pages(&dangling_contents, 4),
            Err(PdfRenderError::UnreadableContents)
        );

        let mut builder = PdfBuilder::new();
        let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        let _pages_id = builder.add_object(b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_vec());
        let content_id = builder.add_object(
            b"<< /Filter /DCTDecode /Length 8 >>\nstream\n12345678\nendstream".to_vec(),
        );
        let _page_id = builder.add_object(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents {content_id} 0 R >>"
            )
            .into_bytes(),
        );
        let bad_contents = builder.finish(catalog_id, None);
        assert_eq!(
            render_pdf_pages(&bad_contents, 4),
            Err(PdfRenderError::UnreadableContents)
        );

        // Corrupt image XObject triggers warning_sink ImageDecodeFailure.
        let corrupt_img = make_second_page_corrupt_image_pdf();
        assert_eq!(
            render_pdf_pages(&corrupt_img, 4),
            Err(PdfRenderError::ImageDecodeFailure)
        );
    }

    pub(super) fn helper_spec(mode: &str) -> HelperCommandSpec {
        HelperCommandSpec {
            exe: std::env::current_exe().expect("current test executable"),
            args: Vec::new(),
            extra_env: vec![(TEST_HELPER_MODE_ENV.to_owned(), mode.to_owned())],
        }
    }

    // `ctor` emits a `cfg(used_linker)` inside its expansion, which is outside this crate's cfg list.
    #[allow(unexpected_cfgs)]
    mod test_helper_ctor {
        use super::*;

        /// Test-binary pre-main re-entry point used by the real-child helper tests.
        /// Runs before libtest prints its banner so stdout carries only the binary helper protocol.
        #[ctor::ctor]
        fn pdf_helper_test_entry() {
            let Ok(mode) = std::env::var(TEST_HELPER_MODE_ENV) else {
                return;
            };
            let code = match mode.as_str() {
                "normal" => run_helper_stdio(),
                "abort" => {
                    // Suppress core dumps / crash dialogs before simulating a parser abort.
                    #[cfg(unix)]
                    let _ = disable_core_dumps();
                    #[cfg(windows)]
                    disable_error_dialogs();
                    std::process::abort();
                }
                #[cfg(target_os = "linux")]
                "check_dumpable" => {
                    if apply_child_limits(HELPER_MEMORY_CAP_BYTES, HELPER_DEADLINE).is_err() {
                        EXIT_LIMIT_SETUP_FAILED
                    } else {
                        // SAFETY: `PR_GET_DUMPABLE` takes no pointer arguments and returns 0/1 or -1.
                        let dumpable = unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) };
                        if dumpable == 0 {
                            EXIT_OK
                        } else {
                            EXIT_PROTOCOL_ERROR
                        }
                    }
                }
                "hang" => {
                    std::thread::sleep(Duration::from_secs(30));
                    EXIT_OK
                }
                "hang_with_watchdog" => {
                    let deadline_ms = std::env::var(TEST_HELPER_DEADLINE_MS_ENV)
                        .ok()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(150);
                    if apply_child_limits(
                        HELPER_MEMORY_CAP_BYTES,
                        Duration::from_millis(deadline_ms),
                    )
                    .is_err()
                    {
                        EXIT_LIMIT_SETUP_FAILED
                    } else {
                        std::thread::sleep(Duration::from_secs(30));
                        EXIT_OK
                    }
                }
                "non_jpeg" => {
                    let mut stdout = std::io::stdout().lock();
                    let rendered = RenderedPdfBytes {
                        total_pages: 1,
                        pages: vec![b"not-a-valid-jpeg-payload".to_vec()],
                    };
                    if write_response(&mut stdout, &rendered).is_err() {
                        EXIT_PROTOCOL_ERROR
                    } else {
                        EXIT_OK
                    }
                }
                "oversized" => {
                    let mut stdout = std::io::stdout().lock();
                    let chunk = vec![0xAAu8; 64 * 1024];
                    loop {
                        if stdout.write_all(&chunk).is_err() {
                            break;
                        }
                    }
                    EXIT_OK
                }
                "fail_limits" => {
                    let mut stdin = std::io::stdin().lock();
                    let mut stdout = std::io::stdout().lock();
                    run_helper_with_limits(|| Err(LimitError), &mut stdin, &mut stdout)
                }
                _ => EXIT_PROTOCOL_ERROR,
            };
            std::process::exit(code);
        }
    }

    #[test]
    fn real_child_helper_round_trip_succeeds() {
        let pdf = make_jpeg_pages_pdf(2, 595.0, 842.0);
        let rendered = render_pdf_with_command(
            &pdf,
            4,
            &helper_spec("normal"),
            HELPER_DEADLINE,
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect("real-child round trip");
        assert_eq!(rendered.total_pages, 2);
        assert_eq!(rendered.photos.len(), 2);
    }

    #[test]
    fn real_child_helper_abort_fails_only_that_call() {
        let pdf = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let err = render_pdf_with_command(
            &pdf,
            4,
            &helper_spec("abort"),
            HELPER_DEADLINE,
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect_err("aborted child must fail");
        #[cfg(unix)]
        assert!(
            matches!(
                err,
                HelperFailure::ExitStatus {
                    code: None,
                    signal: Some(_)
                }
            ),
            "expected signal termination on unix, got {err:?}"
        );
        #[cfg(not(unix))]
        assert!(
            matches!(err, HelperFailure::ExitStatus { .. }),
            "expected exit status failure, got {err:?}"
        );

        // Subsequent normal call still succeeds.
        let ok = render_pdf_with_command(
            &pdf,
            4,
            &helper_spec("normal"),
            HELPER_DEADLINE,
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect("sibling call after abort");
        assert_eq!(ok.photos.len(), 1);
    }

    #[test]
    fn real_child_helper_deadline_kills_and_reaps_child() {
        let pdf = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let started = Instant::now();
        let err = render_pdf_with_command(
            &pdf,
            4,
            &helper_spec("hang"),
            Duration::from_millis(250),
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect_err("hanging child must time out");
        assert_eq!(err, HelperFailure::Deadline);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "deadline must kill child promptly"
        );
    }

    #[test]
    fn real_child_helper_watchdog_self_exits_before_parent_deadline() {
        let pdf = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let mut spec = helper_spec("hang_with_watchdog");
        spec.extra_env
            .push((TEST_HELPER_DEADLINE_MS_ENV.to_owned(), "150".to_owned()));
        let started = Instant::now();
        let err = render_pdf_with_command(
            &pdf,
            4,
            &spec,
            Duration::from_secs(10),
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect_err("watchdog must terminate hanging child");
        assert_eq!(err, HelperFailure::Deadline);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "child watchdog must exit well before the 10 s parent deadline, took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn real_child_helper_rejects_well_framed_non_jpeg_output() {
        let pdf = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let err = render_pdf_with_command(
            &pdf,
            4,
            &helper_spec("non_jpeg"),
            HELPER_DEADLINE,
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect_err("non-JPEG child output must be rejected by process_image_bytes");
        assert_eq!(err, HelperFailure::MalformedOutput);
    }

    #[test]
    fn real_child_helper_oversized_stdout_is_rejected() {
        let pdf = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let err =
            render_pdf_with_command(&pdf, 4, &helper_spec("oversized"), HELPER_DEADLINE, 4096)
                .expect_err("oversized stdout must fail");
        assert_eq!(err, HelperFailure::MalformedOutput);
    }

    #[test]
    fn real_child_helper_limit_setup_failure_exits_before_parsing() {
        let pdf = make_jpeg_pages_pdf(1, 595.0, 842.0);
        let err = render_pdf_with_command(
            &pdf,
            4,
            &helper_spec("fail_limits"),
            HELPER_DEADLINE,
            MAX_HELPER_STDOUT_BYTES,
        )
        .expect_err("limit-setup failure must fail closed");
        assert_eq!(err, HelperFailure::LimitSetupFailed);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn real_child_helper_marks_process_non_dumpable_on_linux() {
        let spec = helper_spec("check_dumpable");
        let mut command = Command::new(&spec.exe);
        configure_helper_env(&mut command);
        for (key, value) in &spec.extra_env {
            command.env(key, value);
        }
        let status = command
            .args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("spawn check_dumpable helper");
        assert!(
            status.success(),
            "helper child must report PR_GET_DUMPABLE == 0 after limit setup, got {status:?}"
        );
    }

    #[cfg(any(target_os = "linux", windows))]
    mod memory_bomb_tests {
        use super::*;
        use flate2::{Compress, Compression, FlushCompress};

        /// Uncompressed Flate content stream size (2 GiB = 4× `HELPER_MEMORY_CAP_BYTES`) that
        /// compresses to ~2.1 MiB and aborts the helper child under the 512 MiB memory cap.
        const FLATE_BOMB_BLOCK_BYTES: usize = 1024 * 1024;
        const FLATE_BOMB_BLOCKS: usize = 2048;

        fn adler32_spaces(total_bytes: usize) -> u32 {
            const MOD_ADLER: u64 = 65_521;
            let n = total_bytes as u64;
            let s1 = (1 + 32 * (n % MOD_ADLER)) % MOD_ADLER;
            // s2 = sum_{i=1..=n} (1 + 32*i) = n + 32 * n*(n+1)/2 = n + 16*n*(n+1)
            let n_mod = n % MOD_ADLER;
            let n1_mod = (n + 1) % MOD_ADLER;
            let s2 = (n_mod + 16 * ((n_mod * n1_mod) % MOD_ADLER)) % MOD_ADLER;
            ((s2 << 16) | s1) as u32
        }

        /// Builds a valid 2 GiB-inflating zlib stream cheaply by compressing one self-contained
        /// 1 MiB block with `FlushCompress::Full` (byte-aligned, no cross-block back-references)
        /// and repeating it 2048 times.
        fn make_flate_bomb_pdf() -> Vec<u8> {
            let block = vec![b' '; FLATE_BOMB_BLOCK_BYTES];
            let mut compressor = Compress::new(Compression::best(), false);
            let mut compressed_block = Vec::with_capacity(2048);
            compressor
                .compress_vec(&block, &mut compressed_block, FlushCompress::Full)
                .expect("compress single 1 MiB bomb block");

            let mut compressed =
                Vec::with_capacity(2 + compressed_block.len() * FLATE_BOMB_BLOCKS + 6);
            // Standard zlib header (CMF=0x78 deflate 32K window, FLG=0x9C).
            compressed.extend_from_slice(&[0x78, 0x9C]);
            for _ in 0..FLATE_BOMB_BLOCKS {
                compressed.extend_from_slice(&compressed_block);
            }
            // Final empty fixed-Huffman deflate block (BFINAL=1, BTYPE=01, EOB=0000000).
            compressed.extend_from_slice(&[0x03, 0x00]);
            let checksum = adler32_spaces(FLATE_BOMB_BLOCK_BYTES * FLATE_BOMB_BLOCKS);
            compressed.extend_from_slice(&checksum.to_be_bytes());

            let mut builder = PdfBuilder::new();
            let catalog_id = builder.add_object(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
            let _pages_id =
                builder.add_object(b"<< /Type /Pages /Kids [4 0 R] /Count 1 >>".to_vec());
            let mut stream_obj = format!(
                "<< /Filter /FlateDecode /Length {} >>\nstream\n",
                compressed.len()
            )
            .into_bytes();
            stream_obj.extend_from_slice(&compressed);
            stream_obj.extend_from_slice(b"\nendstream");
            let content_id = builder.add_object(stream_obj);
            let _page_id = builder.add_object(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents {content_id} 0 R >>"
                )
                .into_bytes(),
            );
            builder.finish(catalog_id, None)
        }

        #[test]
        fn real_child_helper_flate_bomb_fails_under_memory_cap() {
            let bomb = make_flate_bomb_pdf();
            assert!(
                bomb.len() < 4 * 1024 * 1024,
                "2 GiB flate bomb should be compact (~2.1 MiB), got {} bytes",
                bomb.len()
            );
            let err = render_pdf_with_command(
                &bomb,
                4,
                &helper_spec("normal"),
                HELPER_DEADLINE,
                MAX_HELPER_STDOUT_BYTES,
            )
            .expect_err("2 GiB flate bomb must fail under 512 MiB child memory cap");
            assert!(
                matches!(
                    err,
                    HelperFailure::ExitStatus { .. } | HelperFailure::DecodeFailure
                ),
                "expected child abort/OOM or decode failure, got {err:?}"
            );
        }
    }
}
