//! Native scoresheet photo intake: file picker, system clipboard, and window drag-and-drop.
//!
//! All three producers feed one bounded processor that validates magic bytes, applies EXIF
//! orientation, scales down to at most 2,048 px on the long edge, and re-encodes as JPEG from
//! pixels (stripping all metadata, including camera location).

use std::{
    collections::HashMap,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Mutex, PoisonError},
};

use base64::Engine as _;
use image::{
    codecs::jpeg::JpegEncoder, imageops::FilterType, metadata::Orientation, DynamicImage,
    ImageDecoder, ImageFormat, ImageReader, Limits, Rgb, RgbImage, RgbaImage,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager as _;
use tauri_plugin_dialog::DialogExt;
use tauri_specta::Event;
use uuid::Uuid;

use super::{coach, error::CoachError};
use crate::infra::{
    blocking::BLOCKING_GATEWAY,
    path_authority::{
        image_reader_for, read_verified_image_bytes, PathClass, PathOperation, PathRef,
        SharedPathAuthority, PICKER_DIALOG_GRANT_TTL,
    },
    validation::{detect_allowed_raster_format, RasterFormat},
};

pub(crate) const MAX_SCORESHEET_PHOTOS: usize = 4;
pub(crate) const MAX_INPUT_FILE_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const MAX_DECODE_DIMENSION: u32 = 12_000;
pub(crate) const MAX_DECODE_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
pub(crate) const MAX_LONG_EDGE: u32 = 2_048;
pub(crate) const MAX_OUTPUT_JPEG_BYTES: usize = 1_536 * 1024;
const JPEG_QUALITY_PRIMARY: u8 = 85;
const JPEG_QUALITY_FALLBACK: u8 = 70;
const JPEG_DATA_URL_PREFIX: &str = "data:image/jpeg;base64,";

const ACCEPTED_FORMATS: &[RasterFormat] =
    &[RasterFormat::Jpeg, RasterFormat::Png, RasterFormat::Webp];

const IMAGE_EXTENSIONS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];
/// GTK file filters are case-sensitive, so every extension is listed in lower and upper case.
const PICKER_EXTENSIONS: [&str; 8] = ["jpg", "JPG", "jpeg", "JPEG", "png", "PNG", "webp", "WEBP"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetPhoto {
    pub data_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetPhotoBatch {
    pub photos: Vec<ScoresheetPhoto>,
    pub skipped: u32,
    pub failed: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScoresheetPhotosDropped {
    pub drop: String,
}

struct DroppedPhotoSlot {
    id: String,
    grants: Vec<PathRef>,
    skipped: u32,
    failed: u32,
}

/// Per-window-label slot holding single-use dialog grants (never file bytes) for the most recent
/// image drop on that window.
#[derive(Default)]
pub(crate) struct DroppedPhotoSlots {
    slots: Mutex<HashMap<String, DroppedPhotoSlot>>,
}

impl DroppedPhotoSlots {
    fn put(&self, window: &str, slot: DroppedPhotoSlot) {
        self.slots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(window.to_owned(), slot);
    }

    fn take(&self, window: &str, drop_id: &str) -> Option<DroppedPhotoSlot> {
        let mut slots = self.slots.lock().unwrap_or_else(PoisonError::into_inner);
        let matches = slots.get(window).is_some_and(|slot| slot.id == drop_id);
        if matches {
            slots.remove(window)
        } else {
            None
        }
    }

    pub(crate) fn clear_window(&self, window: &str) {
        self.slots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(window);
    }
}

pub(crate) fn is_scoresheet_image_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            IMAGE_EXTENSIONS
                .iter()
                .any(|known| ext.eq_ignore_ascii_case(known))
        })
}

fn to_image_format(format: RasterFormat) -> Option<ImageFormat> {
    match format {
        RasterFormat::Jpeg => Some(ImageFormat::Jpeg),
        RasterFormat::Png => Some(ImageFormat::Png),
        RasterFormat::Webp => Some(ImageFormat::WebP),
        RasterFormat::Gif => None,
    }
}

/// Composites alpha over white before JPEG encoding so transparent regions do not turn black.
fn flatten_to_rgb8(image: DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.into_rgb8();
    }
    let rgba = image.into_rgba8();
    let (width, height) = rgba.dimensions();
    let mut rgb = RgbImage::new(width, height);
    for (dst, src) in rgb.pixels_mut().zip(rgba.pixels()) {
        let [r, g, b, a] = src.0;
        let alpha = u16::from(a);
        let inv = 255u16.saturating_sub(alpha);
        let blend = |channel: u8| -> u8 { ((u16::from(channel) * alpha + 255 * inv) / 255) as u8 };
        *dst = Rgb([blend(r), blend(g), blend(b)]);
    }
    rgb
}

fn encode_jpeg(rgb: &RgbImage, quality: u8) -> Result<Vec<u8>, CoachError> {
    let mut out = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode_image(rgb)
        .map_err(|_| CoachError::PhotoUnreadable)?;
    Ok(out)
}

fn encode_processed_image(
    mut image: DynamicImage,
    max_output_bytes: usize,
) -> Result<ScoresheetPhoto, CoachError> {
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        return Err(CoachError::PhotoUnreadable);
    }
    if width > MAX_LONG_EDGE || height > MAX_LONG_EDGE {
        image = image.resize(MAX_LONG_EDGE, MAX_LONG_EDGE, FilterType::Lanczos3);
    }
    let rgb = flatten_to_rgb8(image);
    let mut jpeg = encode_jpeg(&rgb, JPEG_QUALITY_PRIMARY)?;
    if jpeg.len() > max_output_bytes {
        jpeg = encode_jpeg(&rgb, JPEG_QUALITY_FALLBACK)?;
    }
    if jpeg.len() > max_output_bytes {
        return Err(CoachError::PhotoUnreadable);
    }
    let mut data_url =
        String::with_capacity(JPEG_DATA_URL_PREFIX.len() + 4 * jpeg.len().div_ceil(3));
    data_url.push_str(JPEG_DATA_URL_PREFIX);
    base64::engine::general_purpose::STANDARD.encode_string(&jpeg, &mut data_url);
    Ok(ScoresheetPhoto { data_url })
}

/// Decodes JPEG/PNG/WebP bytes (by magic bytes, never extension), applies EXIF orientation,
/// scales down to at most 2,048 px on the long edge, and re-encodes as metadata-free JPEG.
pub(crate) fn process_image_bytes(bytes: &[u8]) -> Result<ScoresheetPhoto, CoachError> {
    if bytes.is_empty() || bytes.len() > MAX_INPUT_FILE_BYTES {
        return Err(CoachError::PhotoUnreadable);
    }
    let format = detect_allowed_raster_format(bytes, ACCEPTED_FORMATS)
        .and_then(to_image_format)
        .ok_or(CoachError::PhotoUnreadable)?;

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DECODE_DIMENSION);
    limits.max_image_height = Some(MAX_DECODE_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC_BYTES);
    reader.limits(limits);

    let mut decoder = reader
        .into_decoder()
        .map_err(|_| CoachError::PhotoUnreadable)?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder).map_err(|_| CoachError::PhotoUnreadable)?;
    image.apply_orientation(orientation);
    encode_processed_image(image, MAX_OUTPUT_JPEG_BYTES)
}

/// Processes raw RGBA pixels from the native clipboard through the same scaling and JPEG encoder.
pub(crate) fn process_rgba_image(
    width: usize,
    height: usize,
    bytes: &[u8],
) -> Result<ScoresheetPhoto, CoachError> {
    if width == 0
        || height == 0
        || width > MAX_DECODE_DIMENSION as usize
        || height > MAX_DECODE_DIMENSION as usize
    {
        return Err(CoachError::PhotoUnreadable);
    }
    let expected = width
        .checked_mul(height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or(CoachError::PhotoUnreadable)?;
    if bytes.len() != expected || (bytes.len() as u64) > MAX_DECODE_ALLOC_BYTES {
        return Err(CoachError::PhotoUnreadable);
    }
    let rgba = RgbaImage::from_raw(width as u32, height as u32, bytes.to_vec())
        .ok_or(CoachError::PhotoUnreadable)?;
    encode_processed_image(DynamicImage::ImageRgba8(rgba), MAX_OUTPUT_JPEG_BYTES)
}

fn grant_image_path(
    authority: &SharedPathAuthority,
    path: &Path,
) -> Result<PathRef, crate::error::Error> {
    let display_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Scoresheet photo".into());
    authority.with_mut(|authority| {
        authority.grant_dialog(
            path,
            display_name,
            PathClass::SingleDialogGrant,
            PathOperation::ImageRead,
            PICKER_DIALOG_GRANT_TTL,
            1,
        )
    })?
}

fn read_and_process_grant(
    authority: &SharedPathAuthority,
    grant: &PathRef,
) -> Result<ScoresheetPhoto, CoachError> {
    let (file, declared) = image_reader_for(authority, grant, MAX_INPUT_FILE_BYTES)
        .map_err(|_| CoachError::PhotoUnreadable)?;
    let bytes = read_verified_image_bytes(file, declared, MAX_INPUT_FILE_BYTES)
        .map_err(|_| CoachError::PhotoUnreadable)?;
    process_image_bytes(&bytes)
}

fn process_picked_selections<E>(
    authority: &SharedPathAuthority,
    selections: Vec<Result<PathBuf, E>>,
) -> ScoresheetPhotoBatch {
    let total = selections.len();
    let skipped = total.saturating_sub(MAX_SCORESHEET_PHOTOS) as u32;
    let mut photos = Vec::with_capacity(total.min(MAX_SCORESHEET_PHOTOS));
    let mut failed = 0u32;

    for selection in selections.into_iter().take(MAX_SCORESHEET_PHOTOS) {
        let Ok(path) = selection else {
            failed = failed.saturating_add(1);
            continue;
        };
        let grant = match grant_image_path(authority, &path) {
            Ok(grant) => grant,
            Err(_) => {
                failed = failed.saturating_add(1);
                continue;
            }
        };
        match read_and_process_grant(authority, &grant) {
            Ok(photo) => photos.push(photo),
            Err(_) => failed = failed.saturating_add(1),
        }
    }

    ScoresheetPhotoBatch {
        photos,
        skipped,
        failed,
    }
}

fn process_dropped_slot(
    authority: &SharedPathAuthority,
    slot: DroppedPhotoSlot,
) -> ScoresheetPhotoBatch {
    let mut photos = Vec::with_capacity(slot.grants.len());
    let mut failed = slot.failed;
    for grant in &slot.grants {
        match read_and_process_grant(authority, grant) {
            Ok(photo) => photos.push(photo),
            Err(_) => failed = failed.saturating_add(1),
        }
    }
    ScoresheetPhotoBatch {
        photos,
        skipped: slot.skipped,
        failed,
    }
}

/// Handles native window `DragDrop` events next to `chessbase::handle_drop`.
/// Grants up to 4 image paths at drop time, stores only the grants in the window's slot,
/// and emits `ScoresheetPhotosDropped` to that window.
pub(crate) fn handle_drop<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    event: &tauri::DragDropEvent,
) -> tauri::Result<()> {
    let tauri::DragDropEvent::Drop { paths, .. } = event else {
        return Ok(());
    };
    let Some(state) = window.app_handle().try_state::<crate::AppState>() else {
        return Ok(());
    };
    let Ok(coach_state) = coach(&state) else {
        return Ok(());
    };
    let Some(drop_id) = stage_dropped_paths(
        &coach_state.dropped_photos,
        &state.pgn_path_authority,
        window.label(),
        paths,
    ) else {
        return Ok(());
    };
    ScoresheetPhotosDropped { drop: drop_id }.emit_to(window, window.label())
}

fn stage_dropped_paths(
    slots: &DroppedPhotoSlots,
    authority: &SharedPathAuthority,
    window_label: &str,
    paths: &[PathBuf],
) -> Option<String> {
    let image_paths: Vec<&PathBuf> = paths
        .iter()
        .filter(|path| is_scoresheet_image_path(path))
        .collect();
    if image_paths.is_empty() {
        return None;
    }
    let skipped = image_paths.len().saturating_sub(MAX_SCORESHEET_PHOTOS) as u32;
    let mut grants = Vec::with_capacity(image_paths.len().min(MAX_SCORESHEET_PHOTOS));
    let mut failed = 0u32;
    for path in image_paths.into_iter().take(MAX_SCORESHEET_PHOTOS) {
        match grant_image_path(authority, path) {
            Ok(grant) => grants.push(grant),
            Err(_) => failed = failed.saturating_add(1),
        }
    }
    let id = Uuid::new_v4().to_string();
    slots.put(
        window_label,
        DroppedPhotoSlot {
            id: id.clone(),
            grants,
            skipped,
            failed,
        },
    );
    Some(id)
}

pub(crate) fn clear_window_dropped_photos(state: &crate::AppState, window: &str) {
    if let Some(coach) = state.coach.get() {
        coach.dropped_photos.clear_window(window);
    }
}

/// Opens the native multi-file image picker and processes up to 4 selected photos.
pub(crate) async fn pick_photos(
    app: tauri::AppHandle,
    state: &crate::AppState,
) -> Result<ScoresheetPhotoBatch, CoachError> {
    let _ = coach(state)?;
    let picker_app = app.clone();
    // Picker runs on spawn_blocking outside BLOCKING_GATEWAY so an open dialog never holds a permit.
    let picked = tokio::task::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("Image", &PICKER_EXTENSIONS)
            .blocking_pick_files()
    })
    .await
    .map_err(|error| {
        log::error!("scoresheet photo picker task failed: {error}");
        CoachError::PhotoUnreadable
    })?;

    let Some(selections) = picked else {
        return Err(CoachError::Cancelled);
    };
    if selections.is_empty() {
        return Err(CoachError::Cancelled);
    }

    let selections: Vec<Result<PathBuf, _>> = selections
        .into_iter()
        .map(tauri_plugin_dialog::FilePath::into_path)
        .collect();

    let authority = state.pgn_path_authority.clone();
    BLOCKING_GATEWAY
        .spawn(move || Ok(process_picked_selections(&authority, selections)))
        .await
        .map_err(|_| CoachError::PhotoUnreadable)
}

/// Reads an image from the native system clipboard and processes it into a JPEG data URL.
pub(crate) async fn paste_photo(state: &crate::AppState) -> Result<ScoresheetPhoto, CoachError> {
    let _ = coach(state)?;
    // Always off the UI thread (required on Linux so reading our own clipboard cannot deadlock)
    // and off Tokio worker threads through the blocking gateway.
    BLOCKING_GATEWAY
        .spawn(|| Ok(read_clipboard_photo()))
        .await
        .map_err(|_| CoachError::ClipboardEmpty)?
}

fn map_clipboard_error(error: arboard::Error) -> CoachError {
    match error {
        arboard::Error::ContentNotAvailable => CoachError::ClipboardEmpty,
        arboard::Error::ConversionFailure => CoachError::PhotoUnreadable,
        other => {
            log::warn!("scoresheet clipboard image read failed: {other}");
            CoachError::ClipboardEmpty
        }
    }
}

fn read_clipboard_photo() -> Result<ScoresheetPhoto, CoachError> {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(clipboard) => clipboard,
        Err(error) => {
            log::warn!("scoresheet clipboard backend unavailable: {error}");
            return Err(CoachError::ClipboardEmpty);
        }
    };
    match clipboard.get_image() {
        Ok(image) => process_rgba_image(image.width, image.height, &image.bytes),
        Err(error) => Err(map_clipboard_error(error)),
    }
}

/// Consumes the calling window's pending dropped-photo grants if `drop` matches its slot.
pub(crate) async fn take_dropped_photos(
    drop: String,
    window: &tauri::WebviewWindow,
    state: &crate::AppState,
) -> Result<ScoresheetPhotoBatch, CoachError> {
    let coach_state = coach(state)?;
    let slot = coach_state
        .dropped_photos
        .take(window.label(), &drop)
        .ok_or(CoachError::NotFound)?;
    let authority = state.pgn_path_authority.clone();
    BLOCKING_GATEWAY
        .spawn(move || Ok(process_dropped_slot(&authority, slot)))
        .await
        .map_err(|_| CoachError::PhotoUnreadable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infra::path_authority::PathAuthority;
    use std::time::Duration;

    fn make_test_authority() -> (tempfile::TempDir, SharedPathAuthority) {
        let dir = tempfile::tempdir().expect("tempdir");
        let registry = dir.path().join("registry.json");
        let authority = SharedPathAuthority::installed(
            PathAuthority::open(registry, vec![]).expect("open path authority"),
        );
        (dir, authority)
    }

    fn make_rgb_jpeg(width: u32, height: u32, color: [u8; 3]) -> Vec<u8> {
        let img = RgbImage::from_pixel(width, height, Rgb(color));
        encode_jpeg(&img, 90).expect("encode test jpeg")
    }

    fn make_png(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let img = RgbaImage::from_pixel(width, height, image::Rgba(color));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .expect("encode test png");
        out
    }

    fn make_webp(width: u32, height: u32, color: [u8; 4]) -> Vec<u8> {
        let img = RgbaImage::from_pixel(width, height, image::Rgba(color));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::WebP)
            .expect("encode test webp");
        out
    }

    /// Inserts an APP1 EXIF segment right after the JPEG SOI marker (0xFF 0xD8).
    fn inject_jpeg_app1(jpeg: &[u8], exif_payload: &[u8]) -> Vec<u8> {
        assert!(jpeg.starts_with(&[0xFF, 0xD8]));
        let seg_len = (exif_payload.len() + 2) as u16;
        let mut out = Vec::with_capacity(jpeg.len() + exif_payload.len() + 4);
        out.extend_from_slice(&jpeg[..2]);
        out.extend_from_slice(&[0xFF, 0xE1]);
        out.extend_from_slice(&seg_len.to_be_bytes());
        out.extend_from_slice(exif_payload);
        out.extend_from_slice(&jpeg[2..]);
        out
    }

    /// Builds a minimal big-endian EXIF APP1 payload with Orientation = `orientation` and an
    /// optional GPSInfo marker / ASCII tag so we can test both orientation application and
    /// metadata stripping.
    fn build_exif_with_orientation_and_gps(orientation: u16, include_gps_marker: bool) -> Vec<u8> {
        let mut payload = Vec::new();
        payload.extend_from_slice(b"Exif\0\0");
        // TIFF header (big-endian "MM", magic 42, offset to IFD0 = 8)
        payload.extend_from_slice(b"MM");
        payload.extend_from_slice(&42u16.to_be_bytes());
        payload.extend_from_slice(&8u32.to_be_bytes());

        let entry_count: u16 = if include_gps_marker { 2 } else { 1 };
        payload.extend_from_slice(&entry_count.to_be_bytes());

        // Tag 0x0112 (Orientation), type SHORT (3), count 1, value in first 2 bytes of value field
        payload.extend_from_slice(&0x0112u16.to_be_bytes());
        payload.extend_from_slice(&3u16.to_be_bytes());
        payload.extend_from_slice(&1u32.to_be_bytes());
        payload.extend_from_slice(&orientation.to_be_bytes());
        payload.extend_from_slice(&0u16.to_be_bytes());

        if include_gps_marker {
            // Tag 0x010E (ImageDescription), ASCII, offset after IFD0
            let gps_text = b"GPS-LOC-52.5200N-13.4050E\0";
            let data_offset = (8 + 2 + usize::from(entry_count) * 12 + 4) as u32;
            payload.extend_from_slice(&0x010Eu16.to_be_bytes());
            payload.extend_from_slice(&2u16.to_be_bytes());
            payload.extend_from_slice(&(gps_text.len() as u32).to_be_bytes());
            payload.extend_from_slice(&data_offset.to_be_bytes());
            // Next IFD offset = 0
            payload.extend_from_slice(&0u32.to_be_bytes());
            payload.extend_from_slice(gps_text);
        } else {
            // Next IFD offset = 0
            payload.extend_from_slice(&0u32.to_be_bytes());
        }
        payload
    }

    fn decode_data_url(photo: &ScoresheetPhoto) -> (Vec<u8>, RgbImage) {
        let b64 = photo
            .data_url
            .strip_prefix(JPEG_DATA_URL_PREFIX)
            .expect("jpeg data url prefix");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .expect("valid base64");
        let img = image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
            .expect("decodable jpeg")
            .into_rgb8();
        (bytes, img)
    }

    #[test]
    fn exif_orientation_6_is_applied_and_location_metadata_is_stripped() {
        // Create a 40x20 image whose left half is red and right half is blue.
        // Orientation 6 = Rotate 90 degrees CW, so 40x20 becomes 20x40 with top half red and bottom half blue.
        let mut raw = RgbImage::new(40, 20);
        for y in 0..20 {
            for x in 0..40 {
                let px = if x < 20 {
                    Rgb([220, 20, 20])
                } else {
                    Rgb([20, 20, 220])
                };
                raw.put_pixel(x, y, px);
            }
        }
        let base_jpeg = encode_jpeg(&raw, 95).expect("base jpeg");
        let exif = build_exif_with_orientation_and_gps(6, true);
        let with_exif = inject_jpeg_app1(&base_jpeg, &exif);
        assert!(with_exif
            .windows(b"GPS-LOC-52.5200N-13.4050E".len())
            .any(|w| w == b"GPS-LOC-52.5200N-13.4050E"));

        let photo = process_image_bytes(&with_exif).expect("process exif jpeg");
        let (out_bytes, decoded) = decode_data_url(&photo);

        // Upright dimensions after 90 CW rotation: 20x40.
        assert_eq!(decoded.dimensions(), (20, 40));
        let top = decoded.get_pixel(10, 5).0;
        let bottom = decoded.get_pixel(10, 35).0;
        assert!(
            top[0] > 150 && top[2] < 80,
            "top should be red, got {top:?}"
        );
        assert!(
            bottom[2] > 150 && bottom[0] < 80,
            "bottom should be blue, got {bottom:?}"
        );

        // No EXIF APP1 or GPS string survives re-encoding.
        assert!(!out_bytes
            .windows(b"GPS-LOC-52.5200N-13.4050E".len())
            .any(|w| w == b"GPS-LOC-52.5200N-13.4050E"));
        assert!(!out_bytes.windows(6).any(|w| w == b"Exif\0\0"));
    }

    #[test]
    fn accepts_png_and_webp_and_scales_down_only() {
        let png = make_png(3000, 1500, [10, 120, 200, 255]);
        let photo = process_image_bytes(&png).expect("png");
        let (_, img) = decode_data_url(&photo);
        assert_eq!(img.dimensions(), (2048, 1024));

        let small_webp = make_webp(320, 240, [40, 180, 60, 255]);
        let photo = process_image_bytes(&small_webp).expect("webp");
        let (_, img) = decode_data_url(&photo);
        assert_eq!(img.dimensions(), (320, 240));
    }

    #[test]
    fn rejects_truncated_non_image_and_oversized_inputs() {
        let valid = make_rgb_jpeg(64, 64, [100, 150, 200]);
        // Truncated right after header.
        let truncated = &valid[..16];
        assert_eq!(
            process_image_bytes(truncated),
            Err(CoachError::PhotoUnreadable)
        );

        // Non-image text bytes.
        assert_eq!(
            process_image_bytes(b"this is definitely not a jpeg"),
            Err(CoachError::PhotoUnreadable)
        );

        // Oversized input (> 32 MiB).
        let mut oversized = vec![0u8; MAX_INPUT_FILE_BYTES + 1];
        oversized[..3].copy_from_slice(&[0xFF, 0xD8, 0xFF]);
        assert_eq!(
            process_image_bytes(&oversized),
            Err(CoachError::PhotoUnreadable)
        );
    }

    #[test]
    fn quality_fallback_and_output_cap_are_enforced() {
        let mut noisy = RgbImage::new(64, 64);
        for (i, px) in noisy.pixels_mut().enumerate() {
            *px = Rgb([
                ((i * 37) % 256) as u8,
                ((i * 73) % 256) as u8,
                ((i * 113) % 256) as u8,
            ]);
        }
        let q85_len = encode_jpeg(&noisy, JPEG_QUALITY_PRIMARY).unwrap().len();
        let q70_len = encode_jpeg(&noisy, JPEG_QUALITY_FALLBACK).unwrap().len();
        assert!(q70_len < q85_len, "q70 ({q70_len}) < q85 ({q85_len})");

        // Cap between q70 and q85 succeeds via fallback.
        let photo = encode_processed_image(DynamicImage::ImageRgb8(noisy.clone()), q70_len)
            .expect("q70 fallback succeeds");
        let (bytes, _) = decode_data_url(&photo);
        assert!(bytes.len() <= q70_len);

        // Cap below q70 fails with PhotoUnreadable.
        assert_eq!(
            encode_processed_image(DynamicImage::ImageRgb8(noisy), q70_len - 1),
            Err(CoachError::PhotoUnreadable)
        );
    }

    #[test]
    fn rgba_clipboard_processing_validates_bounds() {
        let rgba = vec![200u8; 30 * 10 * 4];
        let photo = process_rgba_image(30, 10, &rgba).expect("valid rgba");
        let (_, img) = decode_data_url(&photo);
        assert_eq!(img.dimensions(), (30, 10));

        assert_eq!(
            process_rgba_image(0, 10, &[]),
            Err(CoachError::PhotoUnreadable)
        );
        assert_eq!(
            process_rgba_image(30, 10, &[0u8; 10]),
            Err(CoachError::PhotoUnreadable)
        );
        assert_eq!(
            process_rgba_image((MAX_DECODE_DIMENSION + 1) as usize, 1, &[]),
            Err(CoachError::PhotoUnreadable)
        );
    }

    #[test]
    fn picked_batch_counts_skipped_and_failed_files_and_rejects_oversized_and_non_image() {
        let (dir, authority) = make_test_authority();
        let good_bytes = make_rgb_jpeg(24, 24, [10, 20, 30]);

        let p1 = dir.path().join("page1.jpg");
        let p2 = dir.path().join("fake.jpg");
        let p3 = dir.path().join("page2.png");
        let p4 = dir.path().join("truncated.jpg");
        let p5 = dir.path().join("extra1.jpg");
        let p6 = dir.path().join("extra2.JPG");

        std::fs::write(&p1, &good_bytes).unwrap();
        std::fs::write(&p2, b"plain text pretending to be jpeg").unwrap();
        std::fs::write(&p3, make_png(16, 16, [50, 60, 70, 255])).unwrap();
        std::fs::write(&p4, &good_bytes[..12]).unwrap();
        std::fs::write(&p5, &good_bytes).unwrap();
        std::fs::write(&p6, &good_bytes).unwrap();

        let batch = process_picked_selections::<()>(
            &authority,
            vec![Ok(p1), Ok(p2), Ok(p3), Ok(p4), Ok(p5), Ok(p6)],
        );
        assert_eq!(batch.photos.len(), 2);
        assert_eq!(batch.failed, 2);
        assert_eq!(batch.skipped, 2);

        // Oversized file on disk (> 32 MiB) is refused by the bounded reader and counted as failed.
        let huge = dir.path().join("huge.jpg");
        {
            let file = std::fs::File::create(&huge).unwrap();
            file.set_len((MAX_INPUT_FILE_BYTES + 1) as u64).unwrap();
        }
        let batch = process_picked_selections::<()>(&authority, vec![Ok(huge)]);
        assert!(batch.photos.is_empty());
        assert_eq!(batch.failed, 1);
        assert_eq!(batch.skipped, 0);
    }

    #[test]
    fn picked_selection_cap_applies_to_first_four_selections_including_conversion_failures() {
        let (dir, authority) = make_test_authority();
        let good_bytes = make_rgb_jpeg(24, 24, [15, 25, 35]);
        let p1 = dir.path().join("p1.jpg");
        let p3 = dir.path().join("p3.jpg");
        let p4 = dir.path().join("p4.jpg");
        let p5 = dir.path().join("p5.jpg");
        for p in [&p1, &p3, &p4, &p5] {
            std::fs::write(p, &good_bytes).unwrap();
        }

        // 6 selections: #2 fails into_path() inside the first 4; #5 and #6 (including a failure)
        // are beyond the 4-selection cap and counted only as skipped.
        let batch = process_picked_selections(
            &authority,
            vec![
                Ok(p1),
                Err("invalid uri 2"),
                Ok(p3),
                Ok(p4),
                Ok(p5),
                Err("invalid uri 6"),
            ],
        );
        assert_eq!(batch.photos.len(), 3);
        assert_eq!(batch.failed, 1);
        assert_eq!(batch.skipped, 2);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_refused_by_verified_reader() {
        let (dir, authority) = make_test_authority();
        let real = dir.path().join("real.jpg");
        std::fs::write(&real, make_rgb_jpeg(20, 20, [90, 90, 90])).unwrap();
        let link = dir.path().join("link.jpg");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let batch = process_picked_selections::<()>(&authority, vec![Ok(link)]);
        assert!(batch.photos.is_empty());
        assert_eq!(batch.failed, 1);
        assert_eq!(batch.skipped, 0);
    }

    #[test]
    fn drop_slot_lifecycle_replace_take_wrong_id_other_window_reload_destroy_and_expiry() {
        let (dir, authority) = make_test_authority();
        let img1 = dir.path().join("IMG_0001.JPG");
        let img2 = dir.path().join("IMG_0002.WebP");
        let note = dir.path().join("notes.txt");
        std::fs::write(&img1, make_rgb_jpeg(32, 32, [120, 40, 40])).unwrap();
        std::fs::write(&img2, make_webp(24, 24, [40, 120, 40, 255])).unwrap();
        std::fs::write(&note, b"ignored").unwrap();

        let slots = DroppedPhotoSlots::default();

        // Non-image drop stages nothing.
        assert!(
            stage_dropped_paths(&slots, &authority, "main", std::slice::from_ref(&note)).is_none()
        );

        // First drop on "main", then replaced by second drop.
        let id1 = stage_dropped_paths(&slots, &authority, "main", std::slice::from_ref(&img1))
            .expect("first drop id");
        let id2 = stage_dropped_paths(
            &slots,
            &authority,
            "main",
            &[img1.clone(), img2.clone(), note],
        )
        .expect("second drop id");
        assert_ne!(id1, id2);

        // Old id and wrong id are rejected without clearing the current slot.
        assert!(slots.take("main", &id1).is_none());
        assert!(slots.take("main", "not-a-valid-id").is_none());
        // Another window cannot take "main"'s drop.
        assert!(slots.take("secondary", &id2).is_none());

        // Right window + right id consumes the slot and processes the batch.
        let slot = slots.take("main", &id2).expect("take id2");
        let batch = process_dropped_slot(&authority, slot);
        assert_eq!(batch.photos.len(), 2);
        assert_eq!(batch.skipped, 0);
        assert_eq!(batch.failed, 0);
        // Second take with same id fails.
        assert!(slots.take("main", &id2).is_none());

        // Reload / window destroy clears the window's slot only.
        let id_main = stage_dropped_paths(&slots, &authority, "main", std::slice::from_ref(&img1))
            .expect("main drop");
        let id_other =
            stage_dropped_paths(&slots, &authority, "other", std::slice::from_ref(&img2))
                .expect("other drop");
        slots.clear_window("main");
        assert!(slots.take("main", &id_main).is_none());
        assert!(slots.take("other", &id_other).is_some());

        // Expired grant fails its file cleanly rather than returning bytes.
        let expired_grant = authority
            .with_mut(|auth| {
                auth.grant_dialog(
                    &img1,
                    "IMG_0001.JPG",
                    PathClass::SingleDialogGrant,
                    PathOperation::ImageRead,
                    Duration::ZERO,
                    1,
                )
            })
            .unwrap()
            .unwrap();
        std::thread::sleep(Duration::from_millis(2));
        slots.put(
            "main",
            DroppedPhotoSlot {
                id: "expired-id".into(),
                grants: vec![expired_grant],
                skipped: 0,
                failed: 0,
            },
        );
        let slot = slots.take("main", "expired-id").expect("take expired");
        let batch = process_dropped_slot(&authority, slot);
        assert!(batch.photos.is_empty());
        assert_eq!(batch.failed, 1);
    }

    #[test]
    fn image_extension_filter_is_ascii_case_insensitive_and_picker_has_both_cases() {
        for ext in IMAGE_EXTENSIONS {
            assert!(is_scoresheet_image_path(Path::new(&format!("a.{ext}"))));
            assert!(is_scoresheet_image_path(Path::new(&format!(
                "a.{}",
                ext.to_ascii_uppercase()
            ))));
            assert!(PICKER_EXTENSIONS.contains(&ext));
            assert!(PICKER_EXTENSIONS.contains(&ext.to_ascii_uppercase().as_str()));
        }
        assert!(!is_scoresheet_image_path(Path::new("a.gif")));
        assert!(!is_scoresheet_image_path(Path::new("a.cbh")));
        assert!(!is_scoresheet_image_path(Path::new("noext")));
    }

    #[test]
    fn stage_dropped_paths_caps_at_four_and_counts_skipped() {
        let (dir, authority) = make_test_authority();
        let bytes = make_rgb_jpeg(20, 20, [80, 90, 100]);
        let mut paths = Vec::new();
        for i in 1..=6 {
            let p = dir.path().join(format!("sheet{i}.jpg"));
            std::fs::write(&p, &bytes).unwrap();
            paths.push(p);
        }
        let note = dir.path().join("readme.txt");
        std::fs::write(&note, b"not an image").unwrap();
        paths.push(note);

        let slots = DroppedPhotoSlots::default();
        let drop_id = stage_dropped_paths(&slots, &authority, "main", &paths).expect("drop id");
        let slot = slots.take("main", &drop_id).expect("staged slot");
        assert_eq!(slot.grants.len(), 4);
        assert_eq!(slot.skipped, 2);
        assert_eq!(slot.failed, 0);

        let batch = process_dropped_slot(&authority, slot);
        assert_eq!(batch.photos.len(), 4);
        assert_eq!(batch.skipped, 2);
        assert_eq!(batch.failed, 0);
    }

    #[test]
    fn clipboard_error_mapping_covers_empty_unreadable_and_backend_errors() {
        assert_eq!(
            map_clipboard_error(arboard::Error::ContentNotAvailable),
            CoachError::ClipboardEmpty
        );
        assert_eq!(
            map_clipboard_error(arboard::Error::ConversionFailure),
            CoachError::PhotoUnreadable
        );
        assert_eq!(
            map_clipboard_error(arboard::Error::ClipboardOccupied),
            CoachError::ClipboardEmpty
        );
        assert_eq!(
            map_clipboard_error(arboard::Error::Unknown {
                description: "backend down".into()
            }),
            CoachError::ClipboardEmpty
        );
    }

    #[test]
    fn handle_drop_emits_typed_event_with_slot_id_and_coexists_with_chessbase(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use crate::{
            chessbase::{handle_drop as handle_chessbase_drop, ChessBaseSelected},
            coach::Coach,
            credentials::{CoachCredentials, MemoryCredentialStore},
        };
        use std::sync::Arc;
        use tauri::Listener;

        let (dir, authority) = make_test_authority();
        let img = dir.path().join("page1.JPG");
        std::fs::write(&img, make_rgb_jpeg(24, 24, [10, 80, 160]))?;

        let (credentials, _cred_dir) =
            CoachCredentials::for_test(Arc::new(MemoryCredentialStore::default()));
        let coach_state = Coach::new(true, Arc::new(credentials)).expect("coach");

        let app = tauri::test::mock_app();
        tauri_specta::Builder::<tauri::test::MockRuntime>::new()
            .events(tauri_specta::collect_events!(
                ChessBaseSelected,
                ScoresheetPhotosDropped
            ))
            .mount_events(&app);
        let state = crate::AppState {
            pgn_path_authority: authority,
            ..Default::default()
        };
        assert!(state.coach.set(coach_state).is_ok());
        app.manage(state);

        let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build()?;
        let window = webview.as_ref().window();

        let photo_drops: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let cb_drops = Arc::new(Mutex::new(0usize));
        let p_obs = photo_drops.clone();
        let c_obs = cb_drops.clone();
        let photo_listener = ScoresheetPhotosDropped::listen(&window, move |event| {
            if let Ok(mut list) = p_obs.lock() {
                list.push(event.payload.drop);
            }
        });
        let cb_listener = ChessBaseSelected::listen(&window, move |_| {
            if let Ok(mut count) = c_obs.lock() {
                *count += 1;
            }
        });

        let drop_event = |paths| tauri::DragDropEvent::Drop {
            paths,
            position: tauri::PhysicalPosition::new(0.0, 0.0),
        };

        // 1. Image drop emits ScoresheetPhotosDropped with the staged slot's id.
        handle_drop(&window, &drop_event(vec![img.clone()]))?;
        handle_chessbase_drop(&window, &drop_event(vec![img.clone()]))?;
        let emitted = photo_drops.lock().unwrap().clone();
        assert_eq!(emitted.len(), 1);
        assert_eq!(*cb_drops.lock().unwrap(), 0);
        let app_state = app.state::<crate::AppState>();
        let slot = app_state
            .coach
            .get()
            .unwrap()
            .dropped_photos
            .take("main", &emitted[0]);
        assert!(slot.is_some(), "emitted drop id must match the staged slot");

        // 2. Mixed ChessBase + image drop triggers both consumers independently.
        let mixed = drop_event(vec![dir.path().join("games.CBH"), img.clone()]);
        handle_chessbase_drop(&window, &mixed)?;
        handle_drop(&window, &mixed)?;
        assert_eq!(photo_drops.lock().unwrap().len(), 2);
        assert_eq!(*cb_drops.lock().unwrap(), 1);

        // 3. Non-image drop and non-Drop events emit nothing.
        handle_drop(&window, &drop_event(vec![dir.path().join("notes.txt")]))?;
        handle_drop(&window, &tauri::DragDropEvent::Leave)?;
        handle_drop(
            &window,
            &tauri::DragDropEvent::Enter {
                paths: vec![img],
                position: tauri::PhysicalPosition::new(0.0, 0.0),
            },
        )?;
        assert_eq!(photo_drops.lock().unwrap().len(), 2);

        window.unlisten(photo_listener);
        window.unlisten(cb_listener);
        Ok(())
    }
}
