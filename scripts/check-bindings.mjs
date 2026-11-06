// Staged failures (2026-09-19, each exit 1): exporter failed ("failed to export TypeScript
// bindings: ..." from cargo, via a refused `..` path); stale binding ("were stale and have been
// refreshed", appended line); unchanged binding rewritten ("rewrote an unchanged", exporter
// temporarily reverted to `Builder::export`).
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const binding = resolve(root, "src/bindings/generated.ts");
const before = readFileSync(binding);
const mtimeBefore = statSync(binding, { bigint: true }).mtimeNs;
const generated = spawnSync(
  "cargo",
  [
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--bin",
    "chessriddle-studio",
    "--",
    "--export-bindings-only",
  ],
  { cwd: root, stdio: "inherit" },
);

if (generated.error) {
  throw generated.error;
}
if (generated.status !== 0) {
  process.exit(generated.status ?? 1);
}

const after = readFileSync(binding);
if (!before.equals(after)) {
  console.error(
    "Generated Tauri bindings were stale and have been refreshed. Review and include src/bindings/generated.ts, then run this check again.",
  );
  process.exit(1);
}
// An unchanged binding must not be rewritten: a new mtime refuses any gate receipt measured
// beside this check (f-20260906-06).
if (statSync(binding, { bigint: true }).mtimeNs !== mtimeBefore) {
  console.error(
    "The binding exporter rewrote an unchanged src/bindings/generated.ts; it must write only when the bytes differ.",
  );
  process.exit(1);
}
