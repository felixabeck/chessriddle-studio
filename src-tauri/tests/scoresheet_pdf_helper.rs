//! Integration test proving the real `chessriddle-studio` binary handles the hidden
//! scoresheet PDF helper argument at the very top of `fn main()`, before any Tauri setup.

use std::{
    io::{Read, Write},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const HELPER_ARG: &str = "--internal-scoresheet-pdf-render";

fn make_minimal_one_page_pdf() -> Vec<u8> {
    let mut objects: Vec<Vec<u8>> = Vec::new();
    // 1: Catalog
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    // 2: Pages
    objects.push(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec());
    // 3: Page (A4 with a simple filled rectangle so it renders non-trivially)
    objects
        .push(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>".to_vec());
    // 4: Content stream
    let stream = b"0 0 0 rg 50 50 100 100 re f";
    let mut content = format!("<< /Length {} >>\nstream\n", stream.len()).into_bytes();
    content.extend_from_slice(stream);
    content.extend_from_slice(b"\nendstream");
    objects.push(content);

    let mut out = Vec::new();
    out.extend_from_slice(b"%PDF-1.4\n");
    let mut offsets = vec![0usize];
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(body);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref_offset = out.len();
    let count = objects.len() + 1;
    out.extend_from_slice(format!("xref\n0 {count}\n0000000000 65535 f \n").as_bytes());
    for offset in offsets.iter().skip(1) {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

#[test]
fn real_app_binary_renders_one_page_pdf_in_helper_mode() {
    let bin = std::env::var("CARGO_BIN_EXE_chessriddle-studio")
        .expect("CARGO_BIN_EXE_chessriddle-studio must be set by Cargo");
    let pdf = make_minimal_one_page_pdf();

    let mut child = Command::new(bin)
        .arg(HELPER_ARG)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn chessriddle-studio in helper mode");

    let mut stdout_pipe = child.stdout.take().expect("helper stdout");
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        stdout_pipe
            .read_to_end(&mut buf)
            .expect("read helper stdout");
        buf
    });

    {
        let mut stdin = child.stdin.take().expect("helper stdin");
        stdin
            .write_all(&4u32.to_le_bytes())
            .expect("write max_pages");
        stdin
            .write_all(&(pdf.len() as u32).to_le_bytes())
            .expect("write pdf_len");
        stdin.write_all(&pdf).expect("write pdf bytes");
        stdin.flush().expect("flush stdin");
    }

    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait helper") {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("real-binary PDF helper timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    };

    let stdout = reader.join().expect("join stdout reader");

    assert!(status.success(), "helper exited with {status:?}");
    assert!(stdout.len() >= 12, "stdout too short: {}", stdout.len());

    let total_pages = u32::from_le_bytes([stdout[0], stdout[1], stdout[2], stdout[3]]);
    let rendered_count = u32::from_le_bytes([stdout[4], stdout[5], stdout[6], stdout[7]]);
    let jpeg_len = u32::from_le_bytes([stdout[8], stdout[9], stdout[10], stdout[11]]) as usize;

    assert_eq!(total_pages, 1);
    assert_eq!(rendered_count, 1);
    assert_eq!(stdout.len(), 12 + jpeg_len);
    let jpeg = &stdout[12..];
    assert!(
        jpeg.starts_with(&[0xFF, 0xD8, 0xFF]),
        "expected JPEG SOI header"
    );
}
