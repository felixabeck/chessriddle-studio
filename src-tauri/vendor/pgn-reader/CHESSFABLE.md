# ChessFable patch to pgn-reader

Upstream: pgn-reader 0.26.0, from the Cargo registry. The complete crate is
retained except for Cargo.lock, including COPYING, Cargo.toml, Cargo.toml.orig,
README.md, rustfmt.toml, src/, docs/, examples/, and upstream metadata. Dependency
resolution uses the application's lockfile, no lockfile is kept in this crate.

The parser patch is in src/reader.rs; the header-decode correction is in
src/types.rs. Comments and headers that
outgrow the buffered window shift their retained bytes, double the buffer when
full, and read more before searching again. Header escapes crossing a read
boundary retain their meaning. The initial header delimiter and comment delimiter
scans share one private bounded-search helper. The existing InvalidData recovery remains for
EOF and tokens over the cap, including terminated tokens. The buffer remains
grown until the reader is dropped.

MAX_TOKEN_BYTES is 10 MiB, matching ChessFable's per-game MAX_PGN_BYTES without
coupling this crate to the application. Comments count their content bytes;
headers count the retained line from after `[` through the value, excluding
the terminating quote. One extra buffered byte permits recognizing a closing
delimiter at the cap. The private buffer uses Vec::reserve_exact before resize,
because circular::Buffer::grow's amortized reservation can exceed the cap. Each
growth requests min(2 × capacity, 10 MiB + 1); shifting and consumption preserve
the upstream buffer semantics. The app's allocation regression allows a fixed
64 KiB margin above the token cap and parses a 40 MiB fixture. The measured Rust
heap peak is 10,486,953 bytes (10 MiB plus 1,193 bytes).

The unpatched upstream version uses a fixed 16 KiB buffer and rejects a real
26,158-byte annotation in Mega Database 2025. Version 0.27 is reported to have
a stricter comment limit; that report is unverified and is not needed for this
patch. A future upstream upgrade must re-apply or demonstrate replacement of
this patch and pass the application's long_token_ regressions.

Header continuation accepts horizontal whitespace before tags and percent escape
lines, while leaving blank separators for movetext processing. Normal and skipped
movetext share one newline boundary lookahead, which accepts indented next-game
headers and leaves their opening bracket available to the next read_game. Percent
escape lines retain their terminating newline so the following header boundary
is recognized, including consecutive escape lines. These bounded transitions
preserve the scanner's established accepted boundaries without changing token
caps, long-token recovery, public APIs or the application's editing grammar.
A future upgrade must preserve these transitions or demonstrate an equivalent
replacement with the reader's header/boundary tests and the application's
pgn_scanner_pickup regressions. Those tests check real Event values in normal and
Skip(true) modes, game counts and exact scanner byte ranges across LF/CRLF,
BOM/no BOM, horizontal indentation and blank/whitespace separators. Retain the
application's leading-percent and semicolon preface range regression as well.

Header callback keys exclude all trailing ASCII spaces and tabs immediately
before the value quote, rather than only one literal space. This bounded
backwards scan preserves interior name bytes, non-ASCII bytes, raw values,
quote offsets, token caps and malformed-input recovery. Future upgrades must
preserve this correction with the reader's raw Event/FEN callback separator
regression and the application's pgn_scanner_pickup separator regression across
both parser modes, LF/CRLF and BOM/no BOM variants.

RawHeader::decode skips the escaped character after an escape, so consecutive
escaped backslashes each keep their literal backslash. Upstream decoded four
raw backslash bytes to one backslash. The borrowed path for unescaped values
is unchanged. Future upgrades must keep this with the crate's raw-header
decode test.

Gate scope: cargo fmt formats the app package only (no --all); backend LCOV
exports only src-tauri/src/**/*.rs and ratchets that same scope; cargo-mutants
selects explicit application source files; rust:surface:check scans only
src-tauri/src and permits only the exact reviewed pgn-reader patch entry in the
app manifest. Clippy and Windows clippy build this dependency through Cargo;
third-party diagnostics are excluded by `#![allow(warnings, clippy::all)]` in
src/lib.rs, keeping upstream code outside the application's lint ratchet.
All other upstream bytes are unchanged.
