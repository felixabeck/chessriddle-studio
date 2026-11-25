# Signed download artifacts — and the unsigned manifest around them

## Authentication scope

One fork-owned Minisign key signs both layers. Its public key is the tracked file
`src-tauri/keys/release.minisign.pub`; `src-tauri/src/fs.rs` reads the `RW…` line from that file
at compile time. The private key never enters this repository.

**Engine catalog document.** The engine catalog is not fetched over HTTP. It ships in the app bundle
as `src/catalogs/engines.json` with a detached Minisign signature over that file's exact bytes in
`src/catalogs/engines.json.minisig` (no canonicalization, no JSON re-serialization). The renderer
passes both strings to the `verify_signed_bytes` command and parses the JSON only after the backend
verified it; a verification failure surfaces as a distinct error, not as an empty list. Changing a
single byte of `engines.json` requires re-signing the document.

**Database and puzzle catalog documents.** The default database and puzzle catalogs are bundled
the same way: `src/catalogs/databases.json` with `src/catalogs/databases.json.minisig`, and
`src/catalogs/puzzles.json` with `src/catalogs/puzzles.json.minisig`. Each detached Minisign
signature covers the exact file bytes (no canonicalization, no JSON re-serialization). Both go
through the same verify-then-parse path as the engine catalog, and a verification failure surfaces
as a distinct error, not as an empty list. The renderer no longer fetches any catalog from
`https://www.encroissant.org`; the artifacts themselves are downloaded natively from their
`downloadLink`.

**Per-entry payload.** For each entry, `signature` authenticates only `downloadLink` together with
`sha256`; `path`, `name`, `version`, `os`, `bmi2`, and image fields are covered only by the engine
document signature, not by the entry signature. The backend's `register_installed_engine`
`Component::Normal` check and `validate_components` in `src-tauri/src/infra/path_authority.rs`
remain the containment boundary.
For databases and puzzle databases, `title`, `description`, `credit`, and the count and size
fields are likewise covered only by the catalog document signature, not by the entry signature. The native
filename is `${title}.db3`, so it is document-signed in the same way the engine `path` is.

Every downloadable entry must contain:

- `sha256`: exactly 64 hexadecimal characters for the downloaded bytes.
- `signature`: a Minisign signature created by the fork release key whose public key is `src-tauri/keys/release.minisign.pub`.

The signed payload is the UTF-8 byte sequence below, with no trailing newline:

```text
${downloadLink}\n${sha256.toLowerCase()}
```

The signature authenticates the exact raw `downloadLink` text, including its spelling and escaping,
before URL parsing. It does not authenticate a canonicalized replacement. The initial transport
request uses the representation produced by `reqwest::Url` parsing, which can normalize that text,
for example by removing an explicit default port or lowercasing the hostname. Redirect locations
are resolved against the current parsed URL, individually checked against the download URL policy,
and followed within the redirect limit. Redirect targets are not separately signed by the entry
signature. The application validates the manifest schema before showing an entry, verifies the
Minisign signature before starting the transfer, streams the final response payload through SHA-256,
and commits it only when the downloaded digest matches the authenticated digest. These parser and
redirect behaviors do not change the signed payload or require existing catalogs to be re-signed.

Existing manifest fields remain required by their consumers. In addition to `sha256` and `signature`:

- Engines require `type: "local"`, `name`, `version`, `path`, `downloadLink`, `os`, and `bmi2`.
- Databases require `title`, `player_count`, `game_count`, `storage_size`, and `downloadLink`; `description` is optional and defaults to an empty string. The optional `credit` object is the attribution the source's licence requires: `author`, `website` (https), `license` (`name`, https `url`), and optionally `release` (`YYYY-MM`) and `convertedBy`; unknown keys are rejected. The Add Database card and the Library detail of the installed copy (matched by its `${title}.db3` leaf) show it with translated labels.
- Puzzle databases require `title`, `description`, `puzzleCount`, `storageSize`, and `downloadLink`.

Release automation must calculate the digest from the final hosted artifact, construct the exact payload, sign it with the protected release private key, JSON-escape the complete Minisign signature, and publish the manifest only after the artifact is immutable and reachable. The private key must never enter this repository or CI logs. For the engine, database, and puzzle catalogs, the signed entries and the detached document signature are committed together. Unsigned legacy entries are deliberately rejected rather than downloaded.
