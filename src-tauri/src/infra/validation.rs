use crate::error::Error;
use base64::Engine as _;

pub(crate) const PNG_SIGNATURE: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
pub(crate) const JPEG_SIGNATURE: &[u8] = &[0xFF, 0xD8, 0xFF];
const GIF87A_SIGNATURE: &[u8] = b"GIF87a";
const GIF89A_SIGNATURE: &[u8] = b"GIF89a";
pub(crate) const WEBP_RIFF: &[u8] = b"RIFF";
pub(crate) const WEBP_WEBP: &[u8] = b"WEBP";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RasterFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
}

impl RasterFormat {
    pub const fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
        }
    }

    pub fn from_mime_subtype(subtype: &str) -> Option<Self> {
        match subtype {
            "png" => Some(Self::Png),
            "jpeg" => Some(Self::Jpeg),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

/// Identifies a supported raster image format from its magic bytes.
pub fn detect_raster_format(bytes: &[u8]) -> Option<RasterFormat> {
    if bytes.starts_with(PNG_SIGNATURE) {
        Some(RasterFormat::Png)
    } else if bytes.starts_with(JPEG_SIGNATURE) {
        Some(RasterFormat::Jpeg)
    } else if bytes.starts_with(GIF87A_SIGNATURE) || bytes.starts_with(GIF89A_SIGNATURE) {
        Some(RasterFormat::Gif)
    } else if bytes.len() >= 12 && &bytes[..4] == WEBP_RIFF && &bytes[8..12] == WEBP_WEBP {
        Some(RasterFormat::Webp)
    } else {
        None
    }
}

/// Identifies a raster image format from its magic bytes, returning `None` if it is not in `allowed`.
pub fn detect_allowed_raster_format(
    bytes: &[u8],
    allowed: &[RasterFormat],
) -> Option<RasterFormat> {
    detect_raster_format(bytes).filter(|format| allowed.contains(format))
}

/// Validates a `data:image/<subtype>;base64,...` URL against an allowed format list and decoded
/// byte bound, verifying that the decoded bytes match the declared format's magic bytes.
pub fn validate_image_data_url(
    data_url: &str,
    allowed: &[RasterFormat],
    max_bytes: usize,
) -> Option<(RasterFormat, Vec<u8>)> {
    let rest = data_url.strip_prefix("data:image/")?;
    let (subtype, payload) = rest.split_once(";base64,")?;
    let format = RasterFormat::from_mime_subtype(subtype)?;
    if !allowed.contains(&format) {
        return None;
    }
    let max_base64_chars = 4usize.checked_mul(max_bytes.div_ceil(3))?;
    if payload.len() > max_base64_chars {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .ok()?;
    if bytes.len() > max_bytes || detect_raster_format(&bytes) != Some(format) {
        return None;
    }
    Some((format, bytes))
}

#[derive(Debug, Clone, Copy)]
pub struct ValidGameIndex(usize);

impl ValidGameIndex {
    pub fn new(idx: i32) -> Result<Self, Error> {
        if idx < 0 {
            Err(Error::InvalidInput("Invalid game index".into()))
        } else {
            Ok(Self(idx as usize))
        }
    }

    pub fn as_usize(&self) -> usize {
        self.0
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ValidGameRange {
    pub start: usize,
    pub count: usize,
}

impl ValidGameRange {
    pub fn new(start: i32, end: i32) -> Result<Self, Error> {
        if start < 0 || end < start {
            return Err(Error::InvalidInput("Invalid game range".into()));
        }
        let start_u = start as usize;
        let end_u = end as usize;
        let count = end_u
            .checked_sub(start_u)
            .and_then(|c| c.checked_add(1))
            .ok_or_else(|| Error::InvalidInput("Range count overflow".into()))?;
        Ok(Self {
            start: start_u,
            count,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data_url(subtype: &str, bytes: &[u8]) -> String {
        format!(
            "data:image/{subtype};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn detects_png_jpeg_gif_and_webp_signatures() {
        assert_eq!(
            detect_raster_format(b"\x89PNG\r\n\x1a\nrest"),
            Some(RasterFormat::Png)
        );
        assert_eq!(
            detect_raster_format(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(RasterFormat::Jpeg)
        );
        assert_eq!(detect_raster_format(b"GIF87a..."), Some(RasterFormat::Gif));
        assert_eq!(detect_raster_format(b"GIF89a..."), Some(RasterFormat::Gif));
        assert_eq!(
            detect_raster_format(b"RIFF\x00\x00\x00\x00WEBP"),
            Some(RasterFormat::Webp)
        );
        assert_eq!(detect_raster_format(b"RIFF\x00\x00\x00\x00WAVE"), None);
        assert_eq!(detect_raster_format(b"not an image"), None);
        assert_eq!(detect_raster_format(&[]), None);
    }

    #[test]
    fn allowed_format_filter_respects_caller_list() {
        let gif = b"GIF89a00";
        assert_eq!(
            detect_allowed_raster_format(
                gif,
                &[
                    RasterFormat::Png,
                    RasterFormat::Jpeg,
                    RasterFormat::Gif,
                    RasterFormat::Webp
                ]
            ),
            Some(RasterFormat::Gif)
        );
        assert_eq!(
            detect_allowed_raster_format(
                gif,
                &[RasterFormat::Png, RasterFormat::Jpeg, RasterFormat::Webp]
            ),
            None
        );
    }

    #[test]
    fn validates_image_data_urls_with_format_and_size_bounds() {
        let png = b"\x89PNG\r\n\x1a\nbody";
        let jpeg = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
        let webp = b"RIFF\x04\x00\x00\x00WEBP";

        assert_eq!(
            validate_image_data_url(&data_url("png", png), &[RasterFormat::Png], 64),
            Some((RasterFormat::Png, png.to_vec()))
        );
        assert_eq!(
            validate_image_data_url(&data_url("jpeg", jpeg), &[RasterFormat::Jpeg], 64),
            Some((RasterFormat::Jpeg, jpeg.to_vec()))
        );
        assert_eq!(
            validate_image_data_url(&data_url("webp", webp), &[RasterFormat::Webp], 64),
            Some((RasterFormat::Webp, webp.to_vec()))
        );

        // Declared subtype must match the decoded signature.
        assert_eq!(
            validate_image_data_url(
                &data_url("jpeg", png),
                &[RasterFormat::Jpeg, RasterFormat::Png],
                64
            ),
            None
        );
        // Unlisted format rejected even with matching signature.
        assert_eq!(
            validate_image_data_url(&data_url("png", png), &[RasterFormat::Jpeg], 64),
            None
        );
        // Size bound enforced both before and after base64 decoding.
        assert_eq!(
            validate_image_data_url(&data_url("png", png), &[RasterFormat::Png], png.len()),
            Some((RasterFormat::Png, png.to_vec()))
        );
        assert_eq!(
            validate_image_data_url(&data_url("png", png), &[RasterFormat::Png], png.len() - 1),
            None
        );
        // Malformed prefix or base64 rejected.
        assert_eq!(
            validate_image_data_url("https://example.com/a.png", &[RasterFormat::Png], 64),
            None
        );
        assert_eq!(
            validate_image_data_url("data:image/png;base64,!!!", &[RasterFormat::Png], 64),
            None
        );
    }
}
