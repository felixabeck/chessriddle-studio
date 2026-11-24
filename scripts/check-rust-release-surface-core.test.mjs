import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  checkDeadCodeSurface,
  checkFaultInjectionSurface,
  checkAllowlistResidency,
  checkFilesystemSurface,
  checkRustReleaseSurface,
  DEAD_CODE_ALLOWLIST,
  FS_SURFACE_ALLOWLIST,
  INITIAL_FS_SURFACE_COUNTS,
  listRustSources,
  runReleaseSurfaceCheck,
} from "./check-rust-release-surface.mjs";
import {
  allowedSource,
  BASELINE_RUST_FILES,
  CHECKOUT_MAIN,
  customExpectBaseline,
  expectCliStatus,
  expectR5Diagnostic,
  LEGACY_ALLOWED_FILE,
  pathMethodViolations,
  runCheckerOver,
  sources,
} from "./rust-release-surface-fixture.mjs";

describe("Rust release-surface gate", () => {
  test("R1 rejects a new file-level dead-code suppression", () => {
    const violations = checkDeadCodeSurface(
      sources(
        [LEGACY_ALLOWED_FILE, allowedSource()],
        ["src-tauri/src/infra/new_authority.rs", allowedSource()],
      ),
      new Set([...DEAD_CODE_ALLOWLIST, LEGACY_ALLOWED_FILE]),
    );

    expect(violations).toContain(
      "R1: src-tauri/src/infra/new_authority.rs carries file-level #![allow(dead_code)] but is not allowlisted",
    );
  });
  test("R1 rejects an added allowlist entry", () => {
    const added = "src-tauri/src/infra/new_authority.rs";
    const violations = checkDeadCodeSurface(
      sources([LEGACY_ALLOWED_FILE, allowedSource()], [added, allowedSource()]),
      new Set([...DEAD_CODE_ALLOWLIST, LEGACY_ALLOWED_FILE, added]),
    );

    expect(violations).toContain(
      `R1: allowlist entry ${added} is not part of the shrink-only baseline`,
    );
  });
  test("R1 rejects an allowlist entry whose file no longer carries the attribute", () => {
    const violations = checkDeadCodeSurface(
      sources([LEGACY_ALLOWED_FILE, "pub struct PathAuthority;"]),
      new Set([...DEAD_CODE_ALLOWLIST, LEGACY_ALLOWED_FILE]),
    );

    expect(violations).toContain(
      `R1: allowlist entry ${LEGACY_ALLOWED_FILE} no longer carries #![allow(dead_code)]`,
    );
  });
  test("R2 rejects an ungated public fault-injection item", () => {
    const violations = checkFaultInjectionSurface(
      "src-tauri/src/infra/fs.rs",
      "pub(crate) struct FaultPoint;\n",
    );

    expect(violations).toContain(
      "src-tauri/src/infra/fs.rs:1: R2: public fault-injection item FaultPoint must be inside #[cfg(test)]",
    );
  });
  test("R2 accepts fault-injection items inside an item cfg region and crate cfg region", () => {
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        `#[cfg(test)]
mod tests {
    pub(crate) struct FaultPoint;
    pub(crate) fn remove_with_injector() {}
}
`,
      ),
    ).toEqual([]);
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        "#[cfg(all(test, unix))] pub(crate) struct FaultPoint;\n",
      ),
    ).toEqual([]);
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        `#![cfg(test)]
pub(crate) trait AtomicWriterInjector {}
`,
      ),
    ).toEqual([]);
  });
  test("R2 uses the shared classifier for attributed items", () => {
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        '#[cfg(all(feature = "x", any(test, feature = "x")))]\npub struct FaultPoint;\n',
      ),
    ).toContain(
      "src-tauri/src/infra/fs.rs:2: R2: public fault-injection item FaultPoint must be inside #[cfg(test)]",
    );
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        "#[cfg(all(unix, not(not(test))))]\npub struct FaultPoint;\n",
      ),
    ).toEqual([]);
  });
  test("R2 rejects an ungated use importing a fault-injection name", () => {
    const violations = checkFaultInjectionSurface(
      "src-tauri/src/infra/file_workspace.rs",
      "use crate::infra::AtomicWriterInjector;\n",
    );

    expect(violations).toContain(
      "src-tauri/src/infra/file_workspace.rs:1: R2: use importing a fault-injection name must be inside #[cfg(test)]",
    );
  });
  test("the complete fixture surface accepts test-only fault seams", () => {
    expect(
      checkRustReleaseSurface(
        sources([
          "src-tauri/src/infra/fs.rs",
          `#[cfg(test)]
pub(crate) enum AtomicFileFaultPoint { Write }
#[cfg(test)]
pub(crate) trait AtomicWriterInjector {}
`,
        ]),
      ),
    ).toEqual([]);
  });
  test("the checker accepts a tracked Rust input deleted in the working tree", async () => {
    const result = await runCheckerOver([
      { path: "src-tauri/src/missing.rs", contents: "pub struct Gone;\n", removeAfterStage: true },
    ]);

    expectCliStatus(result, 0);
    expect(result.stderr).toBe("");
  });
  test("the checker rejects a listed Rust input that cannot be read", () => {
    expect(() =>
      runReleaseSurfaceCheck({
        workspaceRoot: "/fixture",
        listFiles: () => ["src-tauri/src/unreadable.rs"],
        readFile: () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      }),
    ).toThrow("Cannot read Rust source src-tauri/src/unreadable.rs: permission denied");
  });
  test("the CLI reports unparseable cfg predicates as R5 violations", async () => {
    const result = await runCheckerOver([
      {
        path: "src-tauri/src/invalid_cfg.rs",
        contents: "#[cfg(not(test, unix))]\nfn production() {}\n",
      },
    ]);

    expectCliStatus(result, 1);
    expect(result.output).toContain(
      "src-tauri/src/invalid_cfg.rs:1: R5: unclassifiable cfg (unparseable cfg predicate (not() requires one cfg predicate))",
    );
  });
  test("the checker rejects a failing git ls-files command", () => {
    expect(() =>
      listRustSources("/fixture", () => ({
        error: new Error("git unavailable"),
        status: null,
        stderr: "",
      })),
    ).toThrow("Cannot enumerate working-tree files");
  });
  test("the checker rejects a failure of the second git ls-files command", () => {
    let calls = 0;
    expect(() =>
      listRustSources("/fixture", () => {
        calls += 1;
        if (calls === 1) return { status: 0, stdout: "", stderr: "" };
        return { error: new Error("index unavailable"), status: null, stderr: "" };
      }),
    ).toThrow("Cannot enumerate working-tree files");
    expect(calls).toBe(2);
  });
  test("the release script is wired into package.json", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.scripts["rust:surface:check"]).toBe(
      "node scripts/check-rust-release-surface.mjs --check-allowlist-residency",
    );
  });
});

describe("Rust filesystem-surface gate", () => {
  test("a hash-less raw string ending in a backslash does not hide the production reach after it", () => {
    // `r"...\\"` is a raw string whose last character is a backslash. Read as an ordinary
    // string, its closing quote looks escaped and the masker never leaves the literal, so every
    // following line is blanked: the brace depth drifts, `#[cfg(test)]` region boundaries move,
    // and a real production filesystem reach after it is reported by nothing at all. The
    // false-negative is why this matters more than the noisy false-positives it also causes.
    const source = [
      "fn windows_prefix(path: &str) -> Option<&str> {",
      '    path.strip_prefix(r"\\\\?\\UNC\\")',
      "}",
      "",
      "fn reads_a_file() {",
      '    let _ = std::fs::read("probe");',
      "}",
      "",
    ].join("\n");

    expect(checkFilesystemSurface(sources(["src-tauri/src/db/probe.rs", source]))).toEqual([
      "src-tauri/src/db/probe.rs:6: R3: production filesystem reach (qualified) must be inside infra/, #[cfg(test)], or the shrink-only allowlist",
    ]);
  });
  const chess = "src-tauri/src/chess.rs";
  const LEAK_FIXTURE = [
    { path: "src-tauri/src/infra/path_authority.rs", contents: "#![allow(dead_code)]\n" },
    {
      path: "src-tauri/src/leak.rs",
      contents: 'fn f() { std::fs::write("x", b""); }\n',
      staged: false,
    },
  ];
  function fsHits(source, allowlist = new Set(), counts = {}) {
    return checkFilesystemSurface(sources([chess, source]), allowlist, counts);
  }
  test("R3 rejects std::fs::write in a non-allowlisted production file", () => {
    const violations = fsHits('fn f() { std::fs::write("x", b""); }\n');
    expect(violations.some((line) => line.includes("R3:") && line.includes(chess))).toBe(true);
  });
  test("R3 accepts the same call inside a cfg(test) region", () => {
    expect(
      fsHits(`#[cfg(test)]
mod tests {
    fn f() { std::fs::write("x", b""); }
}
`),
    ).toEqual([]);
  });
  test.each([
    '#[cfg(all(feature = "x", any(test, feature = "x")))]',
    "#[cfg(any(test, unix))]",
    "#[cfg(all(unix, not(any(test, windows))))]",
    "#[cfg(not(test))]",
  ])("R3 counts filesystem calls under production cfg %s", (attribute) => {
    expect(fsHits(`${attribute}\nfn f() { std::fs::write("x", b""); }\n`)).toContain(
      `${chess}:2: R3: production filesystem reach (qualified) must be inside infra/, #[cfg(test)], or the shrink-only allowlist`,
    );
  });
  test.each([
    "#[cfg(all(test, unix))]",
    '#[cfg(all(test, target_os = "macos"))]',
    "#[cfg(all(unix, all(test, windows)))]",
    "#[cfg(all(unix, not(not(test))))]",
    "#[cfg(not(any(not(test), windows)))]",
  ])("R3 excludes filesystem calls under test-only cfg %s", (attribute) => {
    expect(fsHits(`${attribute}\nfn f() { std::fs::write("x", b""); }\n`)).toEqual([]);
  });
  test("multiline cfg(test) does not leak into the next production item", () => {
    const violations = fsHits(`#[cfg(test)]
    pub async fn replace(
        &self,
        key: u8,
    ) -> u8 {
        1
    }

    pub fn replace_handle() {
        std::fs::write("x", b"");
    }
`);
    expect(violations.some((line) => line.includes("R3:") && line.includes(chess))).toBe(true);
  });
  test("statement-level cfg(test) does not leak into the next production statement", () => {
    const violations = fsHits(`fn f() {
    #[cfg(test)]
    let _ = 1;
    std::fs::write("x", b"");
}
`);
    expect(violations.some((line) => line.includes("R3:"))).toBe(true);
  });
  test("R3 accepts a File type import without allowlisting the file", () => {
    expect(fsHits("use std::fs::File;\nfn f(file: File) {}\n")).toEqual([]);
  });
  test("R3 rejects tokio::fs::File::open in production", () => {
    expect(
      fsHits('async fn f() { let _ = tokio::fs::File::open("x").await; }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 rejects fs::create_dir_all after use std::fs", () => {
    expect(
      fsHits('use std::fs;\nfn f() { fs::create_dir_all("."); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 rejects a std::fs module alias and does not flag AccountRecord::metadata", () => {
    expect(
      fsHits('use std::fs::{self as disk};\nfn f() { disk::write("x", b""); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
    expect(
      fsHits('use std::fs as disk;\nfn f() { disk::write("x", b""); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
    expect(
      fsHits(
        "struct AccountRecord;\nimpl AccountRecord { fn metadata(&self) {}\nfn f(r: AccountRecord) { r.metadata(); } }\n",
      ),
    ).toEqual([]);
  });
  test("R3 rejects std::fs::File::open and imported File::open", () => {
    expect(
      fsHits('fn f() { std::fs::File::open("x"); }\n').some((line) => line.includes("R3:")),
    ).toBe(true);
    expect(
      fsHits('use std::fs::File;\nfn f() { File::open("x"); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 does not treat clippy allow as an exemption", () => {
    expect(
      fsHits('#[allow(clippy::disallowed_methods)]\nfn f() { std::fs::write("x", b""); }\n').some(
        (line) => line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R4 rejects pathname atomic_replace and not atomic_replace_at", () => {
    expect(
      fsHits("fn f() { atomic_replace(&path, |_| Ok(())); }\n").some((line) =>
        line.includes("R4:"),
      ),
    ).toBe(true);
    expect(fsHits("fn f() { atomic_replace_at(parent, leaf, |_| Ok(())); }\n")).toEqual([]);
  });
  test("R4 rejects atomic_replace_with_precommit and atomic_install_dir", () => {
    expect(
      fsHits("fn f() { atomic_replace_with_precommit(&p, || Ok(()), |_| Ok(())); }\n").some(
        (line) => line.includes("R4:"),
      ),
    ).toBe(true);
    expect(
      fsHits("fn f() { atomic_install_dir(&a, &b); }\n").some((line) => line.includes("R4:")),
    ).toBe(true);
  });
  test("R4 rejects pathname imports, globs, FQN, turbofish and module aliases", () => {
    expect(
      fsHits("use crate::infra::fs::atomic_replace as publish;\n").some((line) =>
        line.includes("R4:"),
      ),
    ).toBe(true);
    expect(fsHits("use crate::infra::fs::*;\n").some((line) => line.includes("R4:"))).toBe(true);
    expect(
      fsHits("fn f() { crate::infra::fs::atomic_replace(&p, |_| Ok(())); }\n").some((line) =>
        line.includes("R4:"),
      ),
    ).toBe(true);
    expect(
      fsHits("fn f() { crate::infra::fs::atomic_replace::<_>(&p, |_| Ok(())); }\n").some((line) =>
        line.includes("R4:"),
      ),
    ).toBe(true);
    expect(
      fsHits(
        "use crate::infra::fs as disk;\nfn f() { disk::atomic_replace::<_>(&p, |_| Ok(())); }\n",
      ).some((line) => line.includes("R4:")),
    ).toBe(true);
  });
  test("R4-only fixtures fail the composer even without std::fs", () => {
    const source = "use crate::infra::fs::atomic_replace;\n";
    const composed = checkRustReleaseSurface(sources([chess, source]));
    expect(composed.some((line) => line.includes("R4:"))).toBe(true);
  });
  test("growing the filesystem allowlist fails", () => {
    const added = "src-tauri/src/chess.rs";
    const violations = checkFilesystemSurface(
      sources([added, 'fn f() { std::fs::write("x", b""); }\n']),
      new Set([...FS_SURFACE_ALLOWLIST, added]),
      { ...INITIAL_FS_SURFACE_COUNTS, [added]: 1 },
    );
    expect(violations).toContain(
      `R3: allowlist entry ${added} is not part of the shrink-only baseline`,
    );
  });
  test("filesystem-surface counts have no stale keys outside the allowlist", () => {
    expect(
      Object.keys(INITIAL_FS_SURFACE_COUNTS).filter((path) => !FS_SURFACE_ALLOWLIST.has(path)),
    ).toEqual([]);
  });
  // The allowlist may only shrink, and the shrink-only check compares a supplied allowlist
  // against the baseline rather than the baseline against itself. Re-adding a path to both
  // constants would therefore restore its exemption silently. f-20260905-02 emptied
  // credentials.rs, f-20260913-02 emptied file_workspace.rs and f-20260919-03 emptied
  // fs.rs; all stay empty.
  test("cleared files have left the filesystem-surface baseline for good", () => {
    const removed = [
      "src-tauri/src/credentials.rs",
      "src-tauri/src/file_workspace.rs",
      "src-tauri/src/fs.rs",
    ];
    expect(
      [...FS_SURFACE_ALLOWLIST, ...Object.keys(INITIAL_FS_SURFACE_COUNTS)].filter((path) =>
        removed.includes(path),
      ),
    ).toEqual([]);
  });
  // Every spawned fixture copies and analyses the seed, so a file the checker does not need
  // costs each case its full analysis time (f-20261120-02: two cleared 1.1 MB files pushed a
  // case past the 5 s budget). A seed file earns its place only if omitting it reddens the
  // otherwise clean fixture.
  test.each(BASELINE_RUST_FILES)("the fixture seed needs %s", async (path) => {
    const result = await runCheckerOver([], [], { omitPrefixes: [path] });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
  });
  test("an allowlisted file's production match count is pinned", () => {
    const path = "src-tauri/src/fs.rs";
    const violations = checkFilesystemSurface(
      sources([
        path,
        `fn f() {
    std::fs::write("x", b"");
    std::fs::read("y");
}
`,
      ]),
      new Set([path]),
      { [path]: 1 },
    );
    expect(
      violations.some((line) =>
        line.includes("has 2 production filesystem reaches, allowlisted for 1"),
      ),
    ).toBe(true);
  });
  test("R3 rejects use std::fs::{self} then fs::write", () => {
    expect(
      fsHits('use std::fs::{self};\nfn f() { fs::write("x", b""); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 rejects File imported under an alias", () => {
    expect(
      fsHits('use std::fs::File as F;\nfn f() { F::open("x"); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 sees a module-level use that follows the call", () => {
    expect(
      fsHits('fn f() { disk::write("x", b""); }\nuse std::fs as disk;\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 rejects std::fs::read_link", () => {
    expect(
      fsHits('fn f() { std::fs::read_link("x"); }\n').some((line) => line.includes("R3:")),
    ).toBe(true);
  });
  test("same-line cfg(test) item does not leak into the next production item", () => {
    expect(
      fsHits('#[cfg(test)] pub struct Fixture;\nfn f() { std::fs::write("x", b""); }\n').some(
        (line) => line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 rejects use std::fs::write then write()", () => {
    expect(
      fsHits('use std::fs::write;\nfn f() { write("x", b""); }\n').some((line) =>
        line.includes("R3:"),
      ),
    ).toBe(true);
  });
  test("R3 counts a filesystem call reached through a production-attributed import", () => {
    const violations = fsHits(
      '#[cfg(all(feature = "x", any(test, feature = "x")))]\n' +
        'use std::fs::write;\nfn f() { write("x", b""); }\n',
    );

    expect(violations).toContain(
      `${chess}:3: R3: production filesystem reach (imported-fn) must be inside infra/, #[cfg(test)], or the shrink-only allowlist`,
    );
  });
  test("R4 counts a production-attributed pathname import", () => {
    expect(fsHits("#[cfg(any(test, unix))]\nuse crate::infra::fs::atomic_replace;\n")).toContain(
      `${chess}:2: R4: production filesystem reach (import) must be inside infra/, #[cfg(test)], or the shrink-only allowlist`,
    );
  });
  test("R2 counts a fault-injection import under a production cfg", () => {
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        "#[cfg(any(test, unix))]\nuse crate::probe::FaultPoint;\n",
      ),
    ).toContain(
      "src-tauri/src/infra/fs.rs:2: R2: use importing a fault-injection name must be inside #[cfg(test)]",
    );
  });
  test("R2, R3, and R4 ignore test-only imports and preserve multiline use assembly", () => {
    const testOnly = "#[cfg(all(unix, not(not(test))))]\n";
    expect(
      checkFaultInjectionSurface(
        "src-tauri/src/infra/fs.rs",
        `${testOnly}use crate::probe::FaultPoint;\n`,
      ),
    ).toEqual([]);
    expect(fsHits(`${testOnly}use crate::infra::fs::atomic_replace;\n`)).toEqual([]);
    expect(
      fsHits(
        `${testOnly}use std::fs::write;\n#[cfg(test)]\nmod t { fn f() { write("x", b""); } }\n`,
      ),
    ).toEqual([]);
    expect(
      fsHits('#[cfg(test)]\nuse std::{\n    fs::write,\n};\nfn f() { write("x", b""); }\n'),
    ).toEqual([]);
  });
  test("whole-file test modules are excluded by the shared classifier", () => {
    expect(
      checkFilesystemSurface(
        sources(
          ["src-tauri/src/lib.rs", "#[cfg(test)]\nmod support;\n"],
          ["src-tauri/src/support.rs", 'fn f() { std::fs::write("x", b""); }\n'],
        ),
      ),
    ).toEqual([]);
  });
  test("a production line after a test-only parameter remains an R3 reach", () => {
    const violations = fsHits(
      "fn production(\n    #[cfg(test)]\n    _test: (),\n) {\n" +
        '    std::fs::write("x", b"");\n}\n',
    );

    expect(violations).toContain(
      `${chess}:5: R3: production filesystem reach (qualified) must be inside infra/, #[cfg(test)], or the shrink-only allowlist`,
    );
  });
  test("R3-only fixtures fail the composer even without pathname primitives", () => {
    const composed = checkRustReleaseSurface(
      sources([chess, 'fn f() { std::fs::write("x", b""); }\n']),
    );
    expect(composed.some((line) => line.includes("R3:"))).toBe(true);
  });
  test("an untracked leak.rs with std::fs::write fails the CLI with an R3 diagnostic", async () => {
    const result = await runCheckerOver(LEAK_FIXTURE);

    expectCliStatus(result, 1);
    expect(result.output).toContain("src-tauri/src/leak.rs");
    expect(result.output).toContain("R3:");
  });
  test("an allowlisted path with zero production matches must leave the allowlist", () => {
    const path = "src-tauri/src/fs.rs";
    const violations = checkFilesystemSurface(
      sources([path, "pub struct Credentials;\n"]),
      new Set([path]),
      { [path]: 3 },
    );

    expect(violations).toContain(
      `R3: allowlist entry ${path} has no production filesystem reaches and must be removed from the allowlist`,
    );
  });
  test("checkAllowlistResidency names an allowlisted path that left the working tree", () => {
    const violations = checkAllowlistResidency(
      ["src-tauri/src/main.rs"],
      new Set(["src-tauri/src/main.rs", "src-tauri/src/gone.rs"]),
    );

    expect(violations).toContain(
      "R3: allowlist entry src-tauri/src/gone.rs is not present in the working tree and must be removed from the allowlist",
    );
  });
  test("checkAllowlistResidency stays silent about a path that is present", () => {
    const violations = checkAllowlistResidency(
      ["src-tauri/src/main.rs"],
      new Set(["src-tauri/src/main.rs", "src-tauri/src/gone.rs"]),
    );

    expect(violations).not.toContain(
      "R3: allowlist entry src-tauri/src/main.rs is not present in the working tree and must be removed from the allowlist",
    );
  });
  test("an allowlisted path at its exact expected count raises neither stale-entry violation", () => {
    const path = "src-tauri/src/fs.rs";
    const violations = checkFilesystemSurface(
      sources([path, 'fn f() { std::fs::write("x", b""); }\n']),
      new Set([path]),
      { [path]: 1 },
    );

    expect(violations).not.toContain(
      `R3: allowlist entry ${path} has no production filesystem reaches and must be removed from the allowlist`,
    );
    expect(violations).not.toContain(
      `R3: allowlist entry ${path} is not present in the working tree and must be removed from the allowlist`,
    );
  });
  test("an allowlisted file measuring fewer reaches than allowlisted fails", () => {
    const path = "src-tauri/src/fs.rs";
    const violations = checkFilesystemSurface(
      sources([path, 'fn f() { std::fs::write("x", b""); }\n']),
      new Set([path]),
      { [path]: 2 },
    );

    expect(
      violations.some((line) =>
        line.includes("has 1 production filesystem reaches, allowlisted for 2"),
      ),
    ).toBe(true);
  });
  test("the residency flag accepts an empty default allowlist with no surface violation", async () => {
    const result = await runCheckerOver(
      [{ path: "src-tauri/src/infra/path_authority.rs", contents: "pub struct PathAuthority;\n" }],
      ["--check-allowlist-residency"],
    );

    expectCliStatus(result, 0);
    expect(result.output).not.toContain("is not present in the working tree");
  });
  test("the residency flag keeps an R3 leak visible with the empty default allowlist", async () => {
    const result = await runCheckerOver(LEAK_FIXTURE, ["--check-allowlist-residency"]);

    expectCliStatus(result, 1);
    expect(result.output).not.toContain("is not present in the working tree");
    expect(result.output).toContain("src-tauri/src/leak.rs");
    expect(result.output).toContain("R3:");
  });
});

describe("R5 suppression containment and counted statements", () => {
  const suppressionCases = [
    ["method allow", "#[allow(clippy::disallowed_methods)]\nfn probe() {}\n"],
    ["inner style allow", "#![allow(clippy::style)]\nfn probe() {}\n"],
    ["lint-group expect", "#[expect(clippy::all)]\nfn probe() {}\n"],
    ["warnings allow", "#[allow(warnings)]\nfn probe() {}\n"],
    [
      "conditional allow",
      "#[cfg_attr(not(test), allow(clippy::disallowed_methods))]\nfn probe() {}\n",
    ],
    ["multiline allow", "#[allow(\n    clippy::disallowed_methods\n)]\nfn probe() {}\n"],
  ];
  test.each(suppressionCases)("O3.1 rejects a production %s", (_name, contents) => {
    expectR5Diagnostic(pathMethodViolations(contents), "can suppress disallowed Path methods");
  });
  test("O3.1 accepts suppressions in test-only source and inside infra", () => {
    const testOnly = pathMethodViolations(
      "#[cfg(test)]\n#[allow(clippy::disallowed_methods)]\nfn probe() {}\n",
    );
    const infra = pathMethodViolations(
      "#[allow(clippy::disallowed_methods)]\nfn probe() {}\n",
      "src-tauri/src/infra/probe.rs",
    );
    expect(testOnly.some((line) => line.includes("can suppress disallowed Path methods"))).toBe(
      false,
    );
    expect(infra.some((line) => line.includes("can suppress disallowed Path methods"))).toBe(false);
  });
  test("O3.1 permits only the exact main crate-root test allowance", () => {
    expect(pathMethodViolations(CHECKOUT_MAIN, "src-tauri/src/main.rs")).toEqual([]);
    const altered = CHECKOUT_MAIN.replace(
      "#![cfg_attr(test, allow(clippy::disallowed_methods))]",
      "#![cfg_attr(test, allow(clippy::style))]",
    );
    expectR5Diagnostic(
      pathMethodViolations(altered, "src-tauri/src/main.rs"),
      "inner allow(clippy::style) can suppress disallowed Path methods",
    );
  });
  test("O3.1 does not count a main-file allow or an inner expect as a pinned site", () => {
    const source = CHECKOUT_MAIN.replace(
      "#![cfg_attr(test, allow(clippy::disallowed_methods))]",
      "#![cfg_attr(test, allow(clippy::disallowed_methods))]\n#![expect(clippy::disallowed_methods)]",
    ).replace("fn main() {", "#[allow(clippy::disallowed_methods)]\nfn main() {");
    const violations = pathMethodViolations(source, "src-tauri/src/main.rs");
    expectR5Diagnostic(violations, "inner expect(clippy::disallowed_methods)");
    expect(violations.some((line) => line.includes("pinned expect entry"))).toBe(false);
  });
  const malformedStatements = [
    [
      "function item",
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    fn nested() { let _ = p.exists(); }\n}\n",
    ],
    [
      "two method tokens",
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = p.exists() && p.is_file();\n}\n",
    ],
    [
      "multiline two method tokens",
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = p.exists()\n        && p.is_file();\n}\n",
    ],
    [
      "UFCS beside a method call",
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = p.exists() && Path::exists(p);\n}\n",
    ],
    [
      "macro invocation",
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = probe!(p.exists());\n}\n",
    ],
    [
      "method bound as a value",
      "fn for_database(_p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let check = Path::exists;\n}\n",
    ],
  ];
  test.each(malformedStatements)(
    "O3.2 rejects a counted expect followed by %s",
    (_name, contents) => {
      const entry = customExpectBaseline("src-tauri/src/main.rs", contents, "for_database", {
        exists: 1,
      });
      const violations = pathMethodViolations(contents, "src-tauri/src/main.rs", {
        initialBaseline: [entry],
        baseline: [entry],
      });
      expectR5Diagnostic(
        violations,
        "counted expect must annotate one direct Path method call in a single let statement without a macro",
      );
    },
  );
  test("O3.2 rejects a method swap against the counted multiset", () => {
    const contents =
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = p.is_dir();\n}\n";
    const entry = customExpectBaseline("src-tauri/src/main.rs", contents, "for_database", {
      exists: 1,
    });
    expectR5Diagnostic(
      pathMethodViolations(contents, "src-tauri/src/main.rs", {
        initialBaseline: [entry],
        baseline: [entry],
      }),
      "counted expect methods",
    );
  });
  test("O3.2 accepts the multiline invalidate_entries single-reach statement", () => {
    const contents =
      "fn invalidate_entries(database: &Path) {\n" +
      "    #[expect(clippy::disallowed_methods)]\n" +
      "    let database = database\n" +
      "        .canonicalize()\n" +
      "        .unwrap_or_else(|_| database.to_path_buf());\n" +
      "}\n";
    const entry = customExpectBaseline("src-tauri/src/main.rs", contents, "invalidate_entries", {
      canonicalize: 1,
    });
    expect(
      pathMethodViolations(contents, "src-tauri/src/main.rs", {
        initialBaseline: [entry],
        baseline: [entry],
      }),
    ).toEqual([]);
  });
  test("O3.2 pins each counted function and rejects an expectation outside its function", () => {
    const contents =
      "fn for_database(p: &Path) {\n" +
      "    #[expect(clippy::disallowed_methods)]\n    let _ = p.exists();\n}\n";
    const entry = customExpectBaseline("src-tauri/src/main.rs", contents, "for_database", {
      exists: 1,
    });
    const elsewhere =
      contents +
      "fn another(p: &Path) {\n" +
      "    #[expect(clippy::disallowed_methods)]\n    let _ = p.exists();\n}\n";
    expectR5Diagnostic(
      pathMethodViolations(elsewhere, "src-tauri/src/main.rs", {
        initialBaseline: [entry],
        baseline: [entry],
      }),
      "counted expect in another has no pinned baseline entry",
    );
  });
  test("O3.2 rejects a one-byte edit to a synthetic pinned function", () => {
    const contents =
      'fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods, reason = "stamp")]\n    let _ = p.exists();\n}\n';
    const entry = customExpectBaseline("src-tauri/src/main.rs", contents, "for_database", {
      exists: 1,
    });
    const edited = contents.replace("stamp", "stamP");
    expect(edited).not.toBe(contents);
    expectR5Diagnostic(
      pathMethodViolations(edited, "src-tauri/src/main.rs", {
        initialBaseline: [entry],
        baseline: [entry],
      }),
      "pinned function for_database changed from its recorded text",
    );
  });
  test("O3.2 CLI rejects a counted expectation added to the checkout with an empty baseline", async () => {
    const moved = `${CHECKOUT_MAIN}\nfn moved_site(path: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = path.canonicalize();\n}\n`;
    const result = await runCheckerOver([{ path: "src-tauri/src/main.rs", contents: moved }]);
    expectCliStatus(result, 1);
    expect(result.output).toContain(
      "R5: counted expect in moved_site has no pinned baseline entry",
    );
  });
  test("O3.3 shares count, addition, empty-entry, and residency validation for R5", () => {
    const path = "src-tauri/src/main.rs";
    const contents =
      "fn for_database(p: &Path) {\n    #[expect(clippy::disallowed_methods)]\n    let _ = p.exists();\n}\n";
    const entry = customExpectBaseline(path, contents, "for_database", { exists: 1 });
    expectR5Diagnostic(
      pathMethodViolations(contents, path, {
        initialBaseline: [entry],
        baseline: [{ ...entry, methods: { exists: 2 } }],
      }),
      "has 1 counted reaches, baseline 2",
    );

    const added = { ...entry, function: "not_initially_pinned", methods: { exists: 1 } };
    expectR5Diagnostic(
      pathMethodViolations(contents, path, {
        initialBaseline: [entry],
        baseline: [entry, added],
      }),
      "is not part of the shrink-only baseline",
    );

    const empty = { ...entry, function: "empty_entry", methods: {} };
    expectR5Diagnostic(
      pathMethodViolations(contents, path, {
        initialBaseline: [entry, empty],
        baseline: [entry, empty],
      }),
      "has no counted reaches and must be removed",
    );

    expectR5Diagnostic(
      pathMethodViolations(contents, path, {
        initialBaseline: [entry],
        baseline: [entry],
        presentPaths: [],
      }),
      "pinned expect path src-tauri/src/main.rs is not present",
    );
  });
});
