import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect } from "vitest";
import {
  checkPathMethodExpectations,
  checkRustReleaseSurface,
  DEAD_CODE_ALLOWLIST,
} from "./check-rust-release-surface.mjs";
import { classifyRustTestOnlySources } from "./rust-test-only.mjs";

export const LEGACY_ALLOWED_FILE = "src-tauri/src/infra/path_authority.rs";

export const CHECKER = join(process.cwd(), "scripts/check-rust-release-surface.mjs");

// main.rs carries the pinned gate regions, so the checker needs its real text. fs.rs and
// file_workspace.rs were seeded while they sat on the filesystem-surface allowlist; both left it
// (f-20260913-02, f-20260919-03) and seeding their ~1.1 MB made every spawned case analyse it
// for nothing (f-20261120-02).
export const BASELINE_RUST_FILES = ["src-tauri/src/main.rs"];

export const FIXED_INPUTS = [
  "Cargo.toml",
  "src-tauri/Cargo.toml",
  "src-tauri/build.rs",
  "src-tauri/clippy.toml",
];

export const CHECKOUT_FILES = await (async () => {
  const rustFiles = await Promise.all(
    BASELINE_RUST_FILES.map(async (path) => [
      path,
      await readFile(join(process.cwd(), path), "utf8"),
    ]),
  );
  const inputs = [];
  for (const path of FIXED_INPUTS) {
    try {
      inputs.push([path, await readFile(join(process.cwd(), path), "utf8")]);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return [...rustFiles, ...inputs];
})();

export function sources(...entries) {
  return new Map(entries);
}

export function allowedSource() {
  return "#![allow(dead_code)]\n";
}

// Spawns the checker over a throwaway git repository built from `files`. Each entry is
// { path, contents, staged = true, removeAfterStage = false }: `staged` keeps untracked fixtures
// untracked, and `removeAfterStage` leaves a tracked-but-absent file behind.
export async function runCheckerOver(
  files,
  args = [],
  { seedBase = true, omitPrefixes = [], prepare } = {},
) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "rust-release-surface-"));
  try {
    const fixtureFiles = new Map();
    if (seedBase) {
      for (const [path, contents] of CHECKOUT_FILES) {
        if (!omitPrefixes.some((prefix) => path.startsWith(prefix))) {
          fixtureFiles.set(path, { path, contents, staged: true });
        }
      }
    }
    for (const file of files) fixtureFiles.set(file.path, { ...file });

    const staged = [];
    const stagedSymlinks = [];
    const removed = [];
    for (const {
      path,
      contents,
      symlinkTo,
      staged: isStaged = true,
      removeAfterStage = false,
    } of fixtureFiles.values()) {
      const absolutePath = join(fixtureRoot, path);
      await mkdir(dirname(absolutePath), { recursive: true });
      if (symlinkTo) await symlink(symlinkTo, absolutePath);
      else await writeFile(absolutePath, contents ?? "");
      if (isStaged) (symlinkTo ? stagedSymlinks : staged).push(path);
      if (removeAfterStage) removed.push(absolutePath);
    }
    expect(spawnSync("git", ["init", "--quiet"], { cwd: fixtureRoot }).status).toBe(0);
    const stagePaths = (paths) => {
      const add = spawnSync("git", ["add", "--", ...paths], {
        cwd: fixtureRoot,
        encoding: "utf8",
      });
      expect(add.status).toBe(0);
      expect(add.error).toBeUndefined();
    };
    if (staged.length) stagePaths(staged);
    for (const path of stagedSymlinks) stagePaths([path]);
    if (prepare) await prepare(fixtureRoot, "before-remove");
    for (const absolutePath of removed) await unlink(absolutePath);
    if (prepare) await prepare(fixtureRoot, "after-remove");

    const result = spawnSync(process.execPath, [CHECKER, ...args], {
      cwd: fixtureRoot,
      encoding: "utf8",
    });
    return {
      error: result.error,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: `${result.stdout}${result.stderr}`,
    };
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

// Replaces live manifest text, refusing when the target is absent so a fixture cannot silently
// fall back to testing the unmodified manifest.
export function replaceExisting(text, target, replacement) {
  const found = typeof target === "string" ? text.includes(target) : target.test(text);
  if (!found) {
    throw new Error(`fixture target ${String(target)} is not in the live text`);
  }
  return text.replace(target, replacement);
}

export function withPackageDescription(manifest, descriptionLine) {
  return replaceExisting(manifest, /^description = "[^"\n]*"$/mu, descriptionLine);
}

export function expectCliStatus(result, expectedStatus) {
  expect(result.status).toBe(expectedStatus);
  expect(result.error).toBeUndefined();
}

export const CHECKOUT_MAIN = new Map(CHECKOUT_FILES).get("src-tauri/src/main.rs");

export function pathMethodViolations(contents, path = "src-tauri/src/probe.rs", options = {}) {
  return checkPathMethodExpectations(new Map([[path, contents]]), options);
}

export function r5Violations(path, contents, extraSources = []) {
  const entries = new Map([["src-tauri/src/main.rs", CHECKOUT_MAIN]]);
  if (path === "src-tauri/src/main.rs") entries.set(path, contents);
  else entries.set(path, contents);
  for (const [extraPath, extraContents] of extraSources) entries.set(extraPath, extraContents);
  return checkRustReleaseSurface(entries, DEAD_CODE_ALLOWLIST, { includeR5: true }).filter((line) =>
    line.includes("R5:"),
  );
}

export function customExpectBaseline(path, contents, functionName, methods) {
  const analysis = classifyRustTestOnlySources(new Map([[path, contents]]), undefined, {
    includeAnalysis: true,
  }).analysis.get(path);
  const item = analysis.functionItems.find((candidate) => candidate.name === functionName);
  const normalised = item.text.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  return {
    path,
    function: functionName,
    sha256: createHash("sha256").update(normalised).digest("hex"),
    methods,
  };
}

export function expectR5Diagnostic(violations, diagnostic) {
  expect(violations.some((line) => line.includes("R5:") && line.includes(diagnostic))).toBe(true);
}
