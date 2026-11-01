import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";
import { workflowSteps } from "./check-gate-routing.mjs";
import { checkToolVersionParity, discoverToolVersions } from "./check-tool-version-parity.mjs";
import { gitInit } from "./test-git-init.mjs";
import { testTempRoots } from "./test-temp-root.mjs";

const temporaryRoot = testTempRoots(after);

const checkerPath = fileURLToPath(new URL("./check-tool-version-parity.mjs", import.meta.url));
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const rustContractPaths = [
  ".project.json",
  "CONTRIBUTING.md",
  "rust-toolchain.toml",
  "scripts/setup-rust.sh",
  "scripts/toolchain-versions.mjs",
  ".github/workflows/test.yml",
  ".github/workflows/mutation.yml",
  ".github/workflows/release.yml",
  ".claude/skills/push/SKILL.md",
];

async function put(root, path, contents) {
  const absolute = join(root, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, contents);
}

async function fixture() {
  const root = await temporaryRoot("tool-version-parity-");
  gitInit(root);
  const nightly = "nightly-" + "2025-06-01";
  await put(root, "scripts/rust-coverage.mjs", `const toolchain = "${nightly}";\n`);
  await put(
    root,
    ".github/workflows/test.yml",
    `jobs:
  rust-platform:
    runs-on: \${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-26-intel
            target: aarch64-apple-darwin
          - os: macos-26-intel
            target: x86_64-apple-darwin
          - os: windows-latest
            target: x86_64-pc-windows-msvc
    env:
      CARGO_BUILD_TARGET: \${{ matrix.target }}
    steps:
      - name: Install Rust toolchain
        shell: bash
        run: bash scripts/setup-rust.sh
      - name: Clippy all Rust targets
        run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
  rust-macos-test:
    runs-on: macos-26-intel
    steps:
      - name: Install Rust toolchain
        shell: bash
        run: bash scripts/setup-rust.sh
      - name: Run Rust tests
        run: cargo test --manifest-path src-tauri/Cargo.toml --all-targets
  rust-windows-test:
    runs-on: windows-latest
    steps:
      - name: Install Rust toolchain
        shell: bash
        run: bash scripts/setup-rust.sh
      - name: Run Rust tests
        run: cargo test --manifest-path src-tauri/Cargo.toml --all-targets
  frontend:
    steps:
      - name: Install Rust toolchain
        shell: bash
        run: bash scripts/setup-rust.sh
  rust:
    steps:
      - name: Install Rust toolchain
        shell: bash
        run: bash scripts/setup-rust.sh
      - name: Coverage tools
        run: |
          cargo install cargo-llvm-cov --version 0.8.7 --locked
          rustup toolchain install ${nightly}
      - name: Check and lint all Rust targets
        run: |
          cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings
`,
  );
  await put(
    root,
    ".github/workflows/mutation.yml",
    "jobs:\n  backend:\n    steps:\n      - name: Install Rust toolchain\n        shell: bash\n        run: bash scripts/setup-rust.sh\n      - name: Install mutation tool\n        run: cargo install cargo-mutants --version 27.1.0 --locked\n",
  );
  await put(
    root,
    ".github/workflows/release.yml",
    "jobs:\n  release:\n    strategy:\n      matrix:\n        include:\n          - platform: 'macos-latest'\n            args: '--target aarch64-apple-darwin --bundles dmg'\n          - platform: 'macos-latest'\n            args: '--target x86_64-apple-darwin --bundles dmg'\n          - platform: 'ubuntu-24.04'\n            args: ''\n          - platform: 'windows-latest'\n            args: '--bundles nsis'\n    steps:\n      - name: Install Rust toolchain\n        shell: bash\n        run: bash scripts/setup-rust.sh\n      - name: Install macOS Rust targets\n        if: runner.os == 'macOS'\n        shell: bash\n        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin\n",
  );
  await put(
    root,
    ".claude/skills/push/SKILL.md",
    `### Rust/Tauri backend\n\n\`\`\`bash\nbash scripts/setup-rust.sh\n\`\`\`\n\nUse the pinned \`${nightly}\` toolchain and \`cargo-llvm-cov\` 0.8.7.\n`,
  );
  await put(
    root,
    "rust-toolchain.toml",
    `[toolchain]\nchannel = "9.8.7"\ncomponents = ["rustfmt", "clippy", "llvm-tools"]\nprofile = "minimal"\n# Install ${nightly} for coverage.\n`,
  );
  await put(
    root,
    "scripts/setup-rust.sh",
    '#!/usr/bin/env bash\nset -euo pipefail\nif [[ ! -f rust-toolchain.toml ]]; then\n  echo "missing rust-toolchain.toml" >&2\n  exit 1\nfi\nrustup toolchain install --no-self-update\nrustup show active-toolchain\n',
  );
  for (const path of [".project.json", "CONTRIBUTING.md"]) {
    await put(root, path, await readFile(join(repositoryRoot, path), "utf8"));
  }
  return root;
}

async function checkedInRustFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "rust-toolchain-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  gitInit(root);
  for (const path of rustContractPaths) {
    await put(root, path, await readFile(join(repositoryRoot, path), "utf8"));
  }
  assert.deepEqual(await checkToolVersionParity(root), []);
  return root;
}

async function mutateCheckedInFile(t, path, mutate) {
  const root = await checkedInRustFixture(t);
  const original = await readFile(join(root, path), "utf8");
  const changed = mutate(original);
  assert.notEqual(changed, original, `mutation did not change ${path}`);
  await put(root, path, changed);
  assert.notDeepEqual(await checkToolVersionParity(root), []);
}

function replaceRustChannel(text, channel) {
  const assignment = /^channel\s*=\s*["'][^"']+["']\s*$/mu;
  assert.match(text, assignment);
  return text.replace(assignment, `channel = "${channel}"`);
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8" });
}

function assertCliFailure(root, message) {
  const result = runChecker(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.ok(
    result.stderr.includes(message),
    `missing unique message: ${message}\n${result.stderr}`,
  );
  return result;
}

function assertCliSuccess(root) {
  const result = runChecker(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Tool version parity check: OK/u);
  assert.doesNotMatch(result.stderr, /Tool version parity check: FAIL/u);
}

async function mutateCheckedInFileAndRunCli(t, path, mutate, message) {
  const root = await checkedInRustFixture(t);
  const original = await readFile(join(root, path), "utf8");
  const changed = mutate(original);
  assert.notEqual(changed, original, `mutation did not change ${path}`);
  await put(root, path, changed);
  assertCliFailure(root, message);
}

function removeMatrixEntry(text, entryStart, nextEntryStart, listEnd) {
  const start = text.indexOf(entryStart);
  assert.ok(start >= 0, `missing matrix entry ${entryStart}`);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const next = text.indexOf(nextEntryStart, start + entryStart.length);
  const end =
    next >= 0 && next < text.indexOf(listEnd, start) ? next : text.indexOf(listEnd, start);
  assert.ok(end >= 0, `missing matrix list end ${listEnd}`);
  return text.slice(0, lineStart) + text.slice(end);
}

function removeReleaseEntry(text, target) {
  const entryStart = target.endsWith("windows-msvc")
    ? "          - platform: 'windows-latest'"
    : text.lastIndexOf("          - platform:", text.indexOf(`--target ${target}`));
  const start =
    typeof entryStart === "number"
      ? entryStart
      : text.indexOf(entryStart, text.indexOf(`--target ${target}`));
  assert.ok(start >= 0, `missing release entry for ${target}`);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const next = text.indexOf("\n          - platform:", start + 1);
  const listEnd = text.indexOf("\n    steps:", start);
  const end = next >= 0 && next < listEnd ? next + 1 : listEnd + 1;
  return text.slice(0, lineStart) + text.slice(end);
}

function removeRustPlatformEntry(text, target) {
  const os = target.endsWith("windows-msvc") ? "windows-latest" : "macos-26-intel";
  return removeMatrixEntry(
    text,
    `          - os: ${os}\n            target: ${target}`,
    "          - os:",
    "    env:",
  );
}

function replaceNamedJobText(
  workflow,
  jobName,
  from,
  to,
  missing = `missing ${from} in ${jobName}`,
) {
  const jobPattern = new RegExp(`(^  ${jobName}:\\n[\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, "mu");
  const job = workflow.match(jobPattern)?.[1];
  assert.ok(job, `missing ${jobName} job`);
  const changed = job.replace(from, to);
  assert.notEqual(changed, job, missing);
  return workflow.replace(job, changed);
}

function replaceNamedJobSetup(workflow, jobName, replacement) {
  return replaceNamedJobText(
    workflow,
    jobName,
    sharedSetupBlock,
    replacement,
    `missing setup block in ${jobName}`,
  );
}

test("accepts matching declarations and discovers every matching site", async () => {
  const root = await fixture();
  assert.deepEqual(await checkToolVersionParity(root), []);

  const families = await discoverToolVersions(root);
  assert.equal(families.find((family) => family.name === "nightly toolchain").sites.length, 4);
  assert.equal(families.find((family) => family.name === "cargo-llvm-cov").sites.length, 2);
  assert.equal(families.find((family) => family.name === "sccache").sites.length, 4);
  assert.equal(families.find((family) => family.name === "cargo-mutants").sites.length, 1);
});

test("reports sccache install, version-guard, and documentation drift through the CLI", async (t) => {
  const cases = [
    ["install", ".project.json", "sccache --version 0.18.0", "sccache --version 0.18.1"],
    ["version guard", ".project.json", "sccache 0.18.0", "sccache 0.18.1"],
    ["documentation", "CONTRIBUTING.md", "`sccache` 0.18.0", "`sccache` 0.18.1"],
    [
      "documentation install command",
      "CONTRIBUTING.md",
      "sccache --version 0.18.0",
      "sccache --version 0.18.1",
    ],
  ];
  for (const [name, path, original, replacement] of cases) {
    await t.test(name, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        path,
        (text) => text.replace(original, replacement),
        "sccache mismatch",
      ),
    );
  }
});

test("requires the sccache setup authority and documentation site through the CLI", async (t) => {
  await t.test("missing setup authority", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".project.json",
      (text) => text.replace("cargo install sccache --version 0.18.0 --locked", "false"),
      "sccache: expected exactly one authority; found 0",
    ),
  );
  await t.test("missing documentation", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "CONTRIBUTING.md",
      (text) => text.replace("`sccache` 0.18.0", "`sccache`"),
      "sccache: expected at least 4 declaration site(s)",
    ),
  );
});

test("rust-cache setup installs only a missing or different sccache and propagates failure", async (t) => {
  const project = JSON.parse(await readFile(join(repositoryRoot, ".project.json"), "utf8"));
  assert.deepEqual(project.worktreeBuilds?.setup, ["pnpm-deps", "rust-cache"]);
  const setup = project.environment.setup.find((step) => step.id === "rust-cache");
  assert.deepEqual(setup.creates, []);
  const stubShell = `
sccache() { printf '%s\\n' "$TEST_SCCACHE_VERSION"; return "$TEST_SCCACHE_STATUS"; }
cargo() { printf '%s\\n' "$*"; return "$TEST_CARGO_STATUS"; }
`;
  for (const [name, version, sccacheStatus, cargoStatus, installs] of [
    ["pinned version", "sccache 0.18.0", 0, 0, false],
    ["missing tool", "", 127, 0, true],
    ["different version", "sccache 0.17.0", 0, 0, true],
    ["failed install", "sccache 0.17.0", 0, 7, true],
  ]) {
    await t.test(name, () => {
      const result = spawnSync("bash", ["-c", stubShell + setup.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          TEST_SCCACHE_VERSION: version,
          TEST_SCCACHE_STATUS: String(sccacheStatus),
          TEST_CARGO_STATUS: String(cargoStatus),
        },
      });
      assert.equal(result.status, installs ? cargoStatus : 0, result.stderr);
      assert.equal(result.stdout, installs ? "install sccache --version 0.18.0 --locked\n" : "");
    });
  }
});

test("reports both cargo-llvm-cov sites and values when the authority differs", async () => {
  const root = await fixture();
  await put(
    root,
    ".github/workflows/test.yml",
    "run: cargo install cargo-llvm-cov --version 0.8.8 --locked\nrun: rustup toolchain install nightly-2025-06-01\n",
  );
  const findings = (await checkToolVersionParity(root)).join("\n");
  assert.match(findings, /cargo-llvm-cov mismatch/u);
  assert.match(findings, /.github\/workflows\/test.yml:1 declares "0.8.8"/u);
  assert.match(findings, /.claude\/skills\/push\/SKILL.md:\d+ declares "0.8.7"/u);
});

test("reports the executable nightly authority and every mismatching restatement", async () => {
  const root = await fixture();
  await put(root, "scripts/rust-coverage.mjs", 'const toolchain = "nightly-2025-06-02";\n');
  const findings = (await checkToolVersionParity(root)).join("\n");
  assert.match(findings, /nightly toolchain mismatch/u);
  assert.match(findings, /authority scripts\/rust-coverage.mjs:1 declares "nightly-2025-06-02"/u);
  assert.match(findings, /.github\/workflows\/test.yml:\d+ declares "nightly-2025-06-01"/u);
});

test("discovers a newly added matching declaration without a path registry", async () => {
  const root = await fixture();
  await put(
    root,
    ".github/workflows/extra.yaml",
    "run: rustup toolchain install nightly-2025-07-01\n",
  );
  const findings = (await checkToolVersionParity(root)).join("\n");
  assert.match(findings, /.github\/workflows\/extra.yaml:1 declares "nightly-2025-07-01"/u);
});

test("requires the single-site cargo-mutants authority to remain discoverable", async () => {
  const root = await fixture();
  await put(root, ".github/workflows/mutation.yml", "run: pnpm mutation:backend\n");
  const findings = (await checkToolVersionParity(root)).join("\n");
  assert.match(findings, /cargo-mutants: expected at least 1 declaration site/u);
  assert.match(findings, /cargo-mutants: expected exactly one authority; found 0/u);
});

test("CLI exits non-zero when a discovered declaration disagrees", async () => {
  const root = await fixture();
  await put(
    root,
    ".github/workflows/test.yml",
    "run: cargo install cargo-llvm-cov --version 0.8.8 --locked\nrun: rustup toolchain install nightly-2025-06-01\n",
  );
  const result = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tool version parity check: FAIL/u);
  assert.match(result.stderr, /.github\/workflows\/test.yml/u);
  assert.match(result.stderr, /.claude\/skills\/push\/SKILL.md/u);
});

test("keeps the nightly authority when the constant moves to a shared module", async () => {
  // The authority pattern once bound to the identifier `toolchain`. Extracting the pin
  // into scripts/toolchain-versions.mjs as RUST_COVERAGE_TOOLCHAIN made the authority
  // vanish - "expected exactly one authority; found 0" - so the family silently lost the
  // only executable declaration it ranks the others against.
  const root = await fixture();
  await put(root, "scripts/rust-coverage.mjs", 'import { PIN } from "./toolchain-versions.mjs";\n');
  await put(
    root,
    "scripts/toolchain-versions.mjs",
    'export const RUST_COVERAGE_TOOLCHAIN = "nightly-2025-06-01";\n',
  );
  assert.deepEqual(await checkToolVersionParity(root), []);

  await put(
    root,
    "scripts/toolchain-versions.mjs",
    'export const RUST_COVERAGE_TOOLCHAIN = "nightly-2025-06-02";\n',
  );
  const findings = (await checkToolVersionParity(root)).join("\n");
  assert.match(
    findings,
    /authority scripts\/toolchain-versions.mjs:1 declares "nightly-2025-06-02"/u,
  );
});

test("a vanished listed file is skipped rather than crashing the checker", async () => {
  const root = await fixture();
  await assert.doesNotReject(() =>
    discoverToolVersions(root, undefined, { listFiles: () => ["missing-file.rs"] }),
  );
});

test("accepts the checked-in Rust toolchain contract", async (t) => {
  await checkedInRustFixture(t);
});

test("accepts the complete Phase 3 fixture through the CLI", async (t) => {
  const root = await checkedInRustFixture(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  assertCliSuccess(root);
});

test("reports each release matrix target-coverage clause through the CLI", async (t) => {
  await t.test("(1a) missing include", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) => text.replace(/        include:\n[\s\S]*?(?=    steps:)/u, ""),
      "(1a) release job has no strategy.matrix.include",
    ),
  );
  await t.test("(1b) empty include", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) => text.replace(/        include:\n[\s\S]*?(?=    steps:)/u, "        include: []\n"),
      "(1b) release matrix.include is empty",
    ),
  );
  await t.test("(1c) missing platform", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) =>
        text.replace(
          /^          - platform:.*$/mu,
          "          - args: '--target aarch64-apple-darwin'",
        ),
      "(1c) release matrix entry 1 has no platform",
    ),
  );
  await t.test("(1d) non-string args", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) =>
        text.replace(
          "            args: '--target aarch64-apple-darwin --bundles dmg'",
          "            args: []",
        ),
      "(1d) release matrix entry 1 args must be a string",
    ),
  );
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]) {
    await t.test(`(1e) missing ${target}`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/release.yml",
        (text) => removeReleaseEntry(text, target),
        `(1e) required target ${target} is not derived from any release matrix entry`,
      ),
    );
  }
  await t.test("(1f) macOS entry carrying Windows target", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) =>
        text.replace(
          "            args: '--target aarch64-apple-darwin --bundles dmg'",
          "            args: '--target x86_64-pc-windows-msvc'",
        ),
      "(1f) derived target x86_64-pc-windows-msvc does not match release platform macos-latest",
    ),
  );
  await t.test("(1f) Windows entry carrying macOS target", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) =>
        text.replace(
          "          - platform: 'windows-latest'\n            args: '--bundles nsis'",
          "          - platform: 'windows-latest'\n            args: '--target aarch64-apple-darwin'\n          - platform: 'windows-latest'\n            args: '--bundles nsis'",
        ),
      "(1f) derived target aarch64-apple-darwin does not match release platform windows-latest",
    ),
  );
});

test("reports each rust-platform contract clause through the CLI", async (t) => {
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]) {
    await t.test(`(2) missing ${target}`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/test.yml",
        (text) => removeRustPlatformEntry(text, target),
        `(2) rust-platform matrix is missing target ${target}`,
      ),
    );
    if (target.endsWith("-apple-darwin")) {
      await t.test(`(2) rejects macos-latest for ${target}`, (subtest) =>
        mutateCheckedInFileAndRunCli(
          subtest,
          ".github/workflows/test.yml",
          (text) =>
            text.replace(
              `          - os: macos-26-intel\n            target: ${target}`,
              `          - os: macos-latest\n            target: ${target}`,
            ),
          `(2) rust-platform target ${target} must use os macos-26-intel`,
        ),
      );
    }
  }
  await t.test("(2) wrong target OS family", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "          - os: macos-26-intel\n            target: aarch64-apple-darwin",
          "          - os: windows-latest\n            target: aarch64-apple-darwin",
        ),
      "(2) rust-platform target aarch64-apple-darwin must use os macos-26-intel",
    ),
  );
  await t.test("(3) wrong runs-on", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) => text.replace("runs-on: ${{ matrix.os }}", "runs-on: macos-latest"),
      "(3) rust-platform must use runs-on: ${{ matrix.os }}",
    ),
  );
  await t.test("(4) wrong target environment", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace("CARGO_BUILD_TARGET: ${{ matrix.target }}", "CARGO_BUILD_TARGET: stable"),
      "(4) rust-platform must set CARGO_BUILD_TARGET: ${{ matrix.target }}",
    ),
  );
  await t.test("(5a) cargo check is absent while exact clippy remains", async (subtest) => {
    const root = await checkedInRustFixture(subtest);
    assertCliSuccess(root);
  });
  await t.test("(5a) does not match cargo checkout-like", async (subtest) => {
    const root = await checkedInRustFixture(subtest);
    const path = ".github/workflows/test.yml";
    const contents = await readFile(join(root, path), "utf8");
    const changed = contents.replace(
      "      - name: Check and lint all Rust targets\n        run: |\n          cargo clippy",
      "      - name: Check and lint all Rust targets\n        run: |\n          cargo checkout-like\n          cargo clippy",
    );
    assert.notEqual(changed, contents);
    await put(root, path, changed);
    assertCliSuccess(root);
  });
  await t.test("(5a) rejects cargo check restored as a rust-platform step", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "      - name: Clippy all Rust targets",
          "      - name: Check all Rust targets\n        run: cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked\n      - name: Clippy all Rust targets",
        ),
      "(5a) rust-platform must not contain a cargo check step",
    ),
  );
  await t.test("(5a) rejects cargo check restored inside the Linux lint step", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "      - name: Check and lint all Rust targets\n        run: |\n          cargo clippy",
          "      - name: Check and lint all Rust targets\n        run: |\n          cargo check --manifest-path src-tauri/Cargo.toml --all-targets --locked\n          cargo clippy",
        ),
      "(5a) Linux Rust-compiling job must not contain a cargo check step",
    ),
  );
  await t.test("(5a) detects cargo check after a directory change", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "      - name: Check and lint all Rust targets\n        run: |\n          cargo clippy",
          "      - name: Check and lint all Rust targets\n        run: |\n          cd src-tauri && cargo check --all-targets --locked\n          cargo clippy",
        ),
      "(5a) Linux Rust-compiling job must not contain a cargo check step",
    ),
  );
  await t.test("(5a) detects cargo +stable check", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "      - name: Check and lint all Rust targets\n        run: |\n          cargo clippy",
          "      - name: Check and lint all Rust targets\n        run: |\n          cargo +stable check --all-targets --locked\n          cargo clippy",
        ),
      "(5a) Linux Rust-compiling job must not contain a cargo check step",
    ),
  );
  await t.test("(5a) detects bash -c cargo check in the Linux lint step", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "      - name: Check and lint all Rust targets\n        run: |\n          cargo clippy",
          "      - name: Check and lint all Rust targets\n        run: |\n          bash -c 'cargo check --all-targets --locked'\n          cargo clippy",
        ),
      "(5a) Linux Rust-compiling job must not contain a cargo check step",
    ),
  );
  await t.test("(5a) detects sh -c cargo +stable check in a rust-platform step", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "      - name: Clippy all Rust targets",
          '      - name: Wrapped shell check\n        run: sh -c "cargo +stable check"\n      - name: Clippy all Rust targets',
        ),
      "(5a) rust-platform must not contain a cargo check step",
    ),
  );
  await t.test("(5b) missing cargo clippy", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) =>
        text.replace(
          "run: cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
          "run: :",
        ),
      "(5b) rust-platform is missing the exact cargo clippy step",
    ),
  );
});

const rustTestJobContracts = [
  { job: "rust-macos-test", runner: "macos-26-intel", runnerClause: "6a", commandClause: "6b" },
  {
    job: "rust-windows-test",
    runner: "windows-latest",
    runnerClause: "7a",
    commandClause: "7b",
  },
];

test("reports each Rust test-job contract clause through the CLI", async (t) => {
  for (const { job, runner, runnerClause, commandClause } of rustTestJobContracts) {
    await t.test(`(${runnerClause}) wrong runner`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/test.yml",
        (text) => replaceNamedJobText(text, job, `runs-on: ${runner}`, "runs-on: ubuntu-latest"),
        `.github/workflows/test.yml: (${runnerClause}) ${job} must use runs-on: ${runner}`,
      ),
    );
    if (job === "rust-macos-test") {
      await t.test(`(${runnerClause}) rejects macos-latest`, (subtest) =>
        mutateCheckedInFileAndRunCli(
          subtest,
          ".github/workflows/test.yml",
          (text) => replaceNamedJobText(text, job, `runs-on: ${runner}`, "runs-on: macos-latest"),
          `.github/workflows/test.yml: (${runnerClause}) ${job} must use runs-on: ${runner}`,
        ),
      );
    }
    await t.test(`(${commandClause}) missing cargo test`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/test.yml",
        (text) =>
          replaceNamedJobText(
            text,
            job,
            "run: cargo test --manifest-path src-tauri/Cargo.toml --all-targets",
            "run: :",
          ),
        `.github/workflows/test.yml: (${commandClause}) ${job} is missing the receipt command: cargo test --manifest-path src-tauri/Cargo.toml --all-targets`,
      ),
    );
  }
  // Each key is injected as a job key on its own. Wrapping `matrix` inside `strategy` would let
  // the `strategy` disjunct short-circuit, leaving the `matrix` check able to be deleted with
  // every test still green.
  for (const declaration of ["strategy:\n      fail-fast: false", "matrix:\n      os: []"]) {
    const key = declaration.slice(0, declaration.indexOf(":"));
    await t.test(`(7c) ${key} declaration`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/test.yml",
        (text) =>
          replaceNamedJobText(
            text,
            "rust-windows-test",
            "runs-on: windows-latest",
            `runs-on: windows-latest\n    ${declaration}`,
          ),
        ".github/workflows/test.yml: (7c) rust-windows-test must not declare strategy or matrix",
      ),
    );
  }
});

test("registers each new Rust job's setup step in the CLI contract", async (t) => {
  for (const jobName of [
    "frontend",
    "rust",
    "rust-platform",
    "rust-macos-test",
    "rust-windows-test",
  ]) {
    await t.test(jobName, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/test.yml",
        (text) => replaceNamedJobSetup(text, jobName, ""),
        `.github/workflows/test.yml: job ${jobName} must contain exactly one unconditional, failure-propagating bash scripts/setup-rust.sh step with shell bash`,
      ),
    );
  }
});

test("reports all pre-Phase-3 checker finding paths through CLI fixtures", async (t) => {
  await t.test("missing contract file", async (subtest) => {
    const root = await checkedInRustFixture(subtest);
    await rm(join(root, "rust-toolchain.toml"));
    assertCliFailure(root, "rust-toolchain.toml: required Rust toolchain contract file is missing");
  });

  for (const jobName of ["frontend", "rust", "rust-windows-test"]) {
    await t.test(`missing registered workflow job ${jobName}`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        ".github/workflows/test.yml",
        (text) => text.replace(`\n  ${jobName}:\n`, `\n  ${jobName}-missing:\n`),
        `.github/workflows/test.yml: required Rust job ${jobName} is missing`,
      ),
    );
  }

  await t.test("invalid Rust channel", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "rust-toolchain.toml",
      (text) => replaceRustChannel(text, "stable"),
      "rust-toolchain.toml: channel must be a complete stable numeric major.minor.patch pin",
    ),
  );
  for (const component of REQUIRED_COMPONENTS_FOR_CLI) {
    await t.test(`missing ${component}`, (subtest) =>
      mutateCheckedInFileAndRunCli(
        subtest,
        "rust-toolchain.toml",
        (text) => text.replace(`"${component}", `, "").replace(`"${component}"`, ""),
        `rust-toolchain.toml: required component ${component} is missing`,
      ),
    );
  }
  await t.test("non-minimal Rust profile", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "rust-toolchain.toml",
      (text) => text.replace('profile = "minimal"', 'profile = "default"'),
      'rust-toolchain.toml: profile must be "minimal"',
    ),
  );
  await t.test("setup strict-bash preamble", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "scripts/setup-rust.sh",
      (text) => text.replace("#!/usr/bin/env bash", "#!/usr/bin/env sh"),
      "scripts/setup-rust.sh: must start with the reviewed strict-bash preamble",
    ),
  );
  await t.test("setup toolchain guard", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "scripts/setup-rust.sh",
      (text) =>
        text.replace(
          "if [[ ! -f rust-toolchain.toml ]]; then",
          "if [[ -f rust-toolchain.toml ]]; then",
        ),
      "scripts/setup-rust.sh: missing nonzero rust-toolchain.toml guard and stderr diagnostic",
    ),
  );
  await t.test("setup install command", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "scripts/setup-rust.sh",
      (text) =>
        text.replace("rustup toolchain install --no-self-update", "rustup toolchain install"),
      "scripts/setup-rust.sh: must install from rust-toolchain.toml with rustup toolchain install --no-self-update and no channel argument",
    ),
  );
  await t.test("setup active-toolchain report", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "scripts/setup-rust.sh",
      (text) => text.replace("rustup show active-toolchain", "rustup show"),
      "scripts/setup-rust.sh: must report rustup show active-toolchain",
    ),
  );
  await t.test("workflow RUSTUP_TOOLCHAIN declaration", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) => text.replace("jobs:\n", "env:\n  RUSTUP_TOOLCHAIN: stable\n\njobs:\n"),
      ".github/workflows/test.yml: must not declare RUSTUP_TOOLCHAIN in repository workflow configuration",
    ),
  );
  await t.test("registered workflow setup contract", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) => replaceNamedJobSetup(text, workflowJobName(".github/workflows/test.yml"), ""),
      ".github/workflows/test.yml: job rust must contain exactly one unconditional, failure-propagating bash scripts/setup-rust.sh step with shell bash",
    ),
  );
  await t.test("forbidden floating Rust action", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) => text.replace("  rust:\n", "  rust:\n    uses: dtolnay/rust-toolchain@stable\n"),
      ".github/workflows/test.yml: job rust must not use dtolnay/rust-toolchain",
    ),
  );
  await t.test("release target setup contract", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/release.yml",
      (text) =>
        text.replace("run: rustup target add aarch64-apple-darwin x86_64-apple-darwin", "run: :"),
      ".github/workflows/release.yml: release must add both existing macOS targets in exactly one macOS-only, failure-propagating step with shell bash",
    ),
  );
  await t.test("push skill setup fence", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".claude/skills/push/SKILL.md",
      (text) => text.replace("bash scripts/setup-rust.sh", "bash scripts/setup-rust"),
      ".claude/skills/push/SKILL.md: Rust gate fence must contain bash scripts/setup-rust.sh exactly once",
    ),
  );
  await t.test("tool-version family minimum", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/mutation.yml",
      (text) => text.replace("cargo install cargo-mutants --version 27.1.0 --locked\n", ""),
      "cargo-mutants: expected at least 1 declaration site",
    ),
  );
  await t.test("tool-version family authority", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      "scripts/toolchain-versions.mjs",
      (text) =>
        text.replace(/RUST_COVERAGE_TOOLCHAIN = .*\n/u, "RUST_COVERAGE_TOOLCHAIN = undefined;\n"),
      "nightly toolchain: expected exactly one authority; found 0",
    ),
  );
  await t.test("tool-version family mismatch", (subtest) =>
    mutateCheckedInFileAndRunCli(
      subtest,
      ".github/workflows/test.yml",
      (text) => text.replace("cargo-llvm-cov --version 0.8.7", "cargo-llvm-cov --version 0.8.8"),
      "cargo-llvm-cov mismatch",
    ),
  );
});

const REQUIRED_COMPONENTS_FOR_CLI = ["rustfmt", "clippy", "llvm-tools"];

test("reports an unexpected checker error with status 2", async (t) => {
  const root = await checkedInRustFixture(t);
  await rm(join(root, "rust-toolchain.toml"));
  await mkdir(join(root, "rust-toolchain.toml"));
  const result = runChecker(root);
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /EISDIR|directory/u);
});

test("rejects a missing Rust toolchain file", async (t) => {
  const root = await checkedInRustFixture(t);
  await rm(join(root, "rust-toolchain.toml"));
  const findings = (await checkToolVersionParity(root)).join("\n");
  assert.match(findings, /rust-toolchain\.toml: required Rust toolchain contract file is missing/u);
});

test("accepts another exact stable Rust version from the toolchain file alone", async (t) => {
  const root = await checkedInRustFixture(t);
  const path = join(root, "rust-toolchain.toml");
  await put(
    root,
    "rust-toolchain.toml",
    replaceRustChannel(await readFile(path, "utf8"), "9.87.6"),
  );
  assert.deepEqual(await checkToolVersionParity(root), []);
});

test("rejects every floating, partial, nightly, or prerelease Rust channel", async (t) => {
  for (const channel of [
    "stable",
    "beta",
    "nightly",
    "1.98",
    "nightly-2025-06-01",
    "1.98.0-beta.1",
  ]) {
    await t.test(channel, (subtest) =>
      mutateCheckedInFile(subtest, "rust-toolchain.toml", (text) =>
        replaceRustChannel(text, channel),
      ),
    );
  }
});

test("rejects removal of every required Rust component", async (t) => {
  for (const component of ["rustfmt", "clippy", "llvm-tools"]) {
    await t.test(component, (subtest) =>
      mutateCheckedInFile(subtest, "rust-toolchain.toml", (text) =>
        text.replace(`"${component}", `, "").replace(`, "${component}"`, ""),
      ),
    );
  }
});

const workflowSetups = [
  {
    path: ".github/workflows/test.yml",
    original:
      "      - name: Install Rust toolchain\n        uses: dtolnay/rust-toolchain@stable\n        with:\n          components: rustfmt, clippy, llvm-tools-preview",
  },
  {
    path: ".github/workflows/mutation.yml",
    original: "      - name: Install Rust toolchain\n        uses: dtolnay/rust-toolchain@stable",
  },
  {
    path: ".github/workflows/release.yml",
    original:
      "      - name: Rust setup\n        uses: dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c # stable\n        with:\n          targets: ${{ matrix.platform == 'macos-latest' && 'aarch64-apple-darwin,x86_64-apple-darwin' || '' }}",
  },
];
const sharedSetupBlock =
  "      - name: Install Rust toolchain\n        shell: bash\n        run: bash scripts/setup-rust.sh";

function workflowJobName(path) {
  return path === ".github/workflows/test.yml"
    ? "rust"
    : path === ".github/workflows/mutation.yml"
      ? "backend"
      : "release";
}

function oldCheckerAcceptsSetup(workflow, path) {
  const jobName = workflowJobName(path);
  const jobPattern = new RegExp(`^  ${jobName}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, "mu");
  const job = workflow.match(jobPattern)?.[0] ?? "";
  const setupSteps = workflowSteps(job).filter(
    (step) => step.name === "Install Rust toolchain" && step.run === "bash scripts/setup-rust.sh",
  );
  const exactSetupBlock =
    /^      - name: Install Rust toolchain\n        shell: bash\n        run: bash scripts\/setup-rust\.sh(?=\n(?:\s*\n|      - )|$)/gmu;
  return setupSteps.length === 1 && [...job.matchAll(exactSetupBlock)].length === 1;
}

test("rejects every workflow reverted to its original floating action", async (t) => {
  for (const { path, original } of workflowSetups) {
    await t.test(path, (subtest) =>
      mutateCheckedInFile(subtest, path, (text) =>
        replaceNamedJobSetup(text, workflowJobName(path), original),
      ),
    );
  }
});

test("rejects deletion and no-op replacement of every workflow setup", async (t) => {
  for (const { path } of workflowSetups) {
    await t.test(`${path} deleted`, (subtest) =>
      mutateCheckedInFile(subtest, path, (text) =>
        replaceNamedJobSetup(text, workflowJobName(path), ""),
      ),
    );
    await t.test(`${path} no-op`, (subtest) =>
      mutateCheckedInFile(subtest, path, (text) =>
        replaceNamedJobSetup(
          text,
          workflowJobName(path),
          sharedSetupBlock.replace("        run: bash scripts/setup-rust.sh", "        run: :"),
        ),
      ),
    );
  }
});

test("rejects a setup without explicit bash shell in every workflow", async (t) => {
  for (const { path } of workflowSetups) {
    await t.test(path, (subtest) =>
      mutateCheckedInFile(subtest, path, (text) =>
        replaceNamedJobSetup(
          text,
          workflowJobName(path),
          sharedSetupBlock.replace("        shell: bash\n", ""),
        ),
      ),
    );
  }
});

test("accepts harmless setup names, reordered fields, and explicit failure propagation", async (t) => {
  for (const { path } of workflowSetups) {
    await t.test(path, async (subtest) => {
      const root = await checkedInRustFixture(subtest);
      const workflowPath = join(root, path);
      const workflow = await readFile(workflowPath, "utf8");
      const reordered =
        "      - run: bash scripts/setup-rust.sh\n        continue-on-error: false\n        name: Prepare pinned Rust\n        shell: bash";
      await put(root, path, replaceNamedJobSetup(workflow, workflowJobName(path), reordered));
      assert.deepEqual(await checkToolVersionParity(root), []);
    });
  }
});

test("rejects blank-line conditional and failure-tolerant setup bypasses in every workflow", async (t) => {
  for (const { path } of workflowSetups) {
    for (const declaration of ["if: false", "continue-on-error: true"]) {
      await t.test(`${path} ${declaration}`, async (subtest) => {
        const root = await checkedInRustFixture(subtest);
        const workflowPath = join(root, path);
        const workflow = await readFile(workflowPath, "utf8");
        const bypass = replaceNamedJobSetup(
          workflow,
          workflowJobName(path),
          `${sharedSetupBlock}\n\n        ${declaration}`,
        );
        assert.equal(oldCheckerAcceptsSetup(bypass, path), true);
        await put(root, path, bypass);
        assert.match(
          (await checkToolVersionParity(root)).join("\n"),
          /must contain exactly one unconditional, failure-propagating/u,
        );
      });
    }
  }
});

test("rejects repository RUSTUP_TOOLCHAIN declarations in all three workflows", async (t) => {
  for (const { path } of workflowSetups) {
    await t.test(path, async (subtest) => {
      const root = await checkedInRustFixture(subtest);
      const workflowPath = join(root, path);
      const workflow = await readFile(workflowPath, "utf8");
      await put(root, path, `env:\n  RUSTUP_TOOLCHAIN: stable\n${workflow}`);
      assert.match(
        (await checkToolVersionParity(root)).join("\n"),
        /must not declare RUSTUP_TOOLCHAIN/u,
      );
    });
  }
});

test("rejects RUSTUP_TOOLCHAIN declarations at workflow, job, step, and shell scope", async (t) => {
  const cases = [
    ["workflow env", (text) => `env:\n  RUSTUP_TOOLCHAIN: stable\n${text}`],
    [
      "job env",
      (text) => text.replace("  rust:\n", "  rust:\n    env:\n      RUSTUP_TOOLCHAIN: stable\n"),
    ],
    [
      "step env",
      (text) =>
        text.replace(
          "      - name: Install Rust toolchain\n",
          "      - name: Install Rust toolchain\n        env:\n          'RUSTUP_TOOLCHAIN': stable\n",
        ),
    ],
    [
      "shell assignment",
      (text) =>
        text.replace(
          "        run: bash scripts/setup-rust.sh",
          "        run: RUSTUP_TOOLCHAIN=stable bash scripts/setup-rust.sh",
        ),
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (subtest) => {
      const root = await checkedInRustFixture(subtest);
      const path = ".github/workflows/test.yml";
      const workflow = await readFile(join(root, path), "utf8");
      const changed = mutate(workflow);
      assert.notEqual(changed, workflow);
      await put(root, path, changed);
      assert.match(
        (await checkToolVersionParity(root)).join("\n"),
        /must not declare RUSTUP_TOOLCHAIN/u,
      );
    });
  }
});

test("rejects removal of either required setup command", async (t) => {
  for (const command of [
    "rustup toolchain install --no-self-update\n",
    "rustup show active-toolchain\n",
  ]) {
    await t.test(command.trim(), (subtest) =>
      mutateCheckedInFile(subtest, "scripts/setup-rust.sh", (text) => text.replace(command, "")),
    );
  }
});

test("rejects removal of either macOS release target", async (t) => {
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin"]) {
    await t.test(target, (subtest) =>
      mutateCheckedInFile(subtest, ".github/workflows/release.yml", (text) =>
        text.replace(
          "run: rustup target add aarch64-apple-darwin x86_64-apple-darwin",
          `run: rustup target add ${
            target === "aarch64-apple-darwin" ? "x86_64-apple-darwin" : "aarch64-apple-darwin"
          }`,
        ),
      ),
    );
  }
});

test("rejects an unconditional macOS target step", async (t) => {
  await mutateCheckedInFile(t, ".github/workflows/release.yml", (text) =>
    text.replace("        if: runner.os == 'macOS'\n", ""),
  );
});

test("accepts a harmless macOS target name, reordered fields, and explicit failure propagation", async (t) => {
  const root = await checkedInRustFixture(t);
  const path = ".github/workflows/release.yml";
  const workflow = await readFile(join(root, path), "utf8");
  const original =
    "      - name: Install macOS Rust targets\n        if: runner.os == 'macOS'\n        shell: bash\n        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin";
  const reordered =
    "      - run: rustup target add aarch64-apple-darwin x86_64-apple-darwin\n        continue-on-error: false\n        shell: bash\n        name: Prepare Apple targets\n        if: runner.os == 'macOS'";
  assert.ok(workflow.includes(original));
  await put(root, path, workflow.replace(original, reordered));
  assert.deepEqual(await checkToolVersionParity(root), []);
});

test("rejects disabled and failure-tolerant macOS target setup", async (t) => {
  for (const [name, mutate] of [
    ["disabled", (text) => text.replace("        if: runner.os == 'macOS'", "        if: false")],
    [
      "failure tolerant",
      (text) =>
        text.replace(
          "        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin",
          "        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin\n        continue-on-error: true",
        ),
    ],
    [
      "implicit shell",
      (text) =>
        text.replace(
          "      - name: Install macOS Rust targets\n        if: runner.os == 'macOS'\n        shell: bash\n",
          "      - name: Install macOS Rust targets\n        if: runner.os == 'macOS'\n",
        ),
    ],
  ]) {
    await t.test(name, (subtest) =>
      mutateCheckedInFile(subtest, ".github/workflows/release.yml", mutate),
    );
  }
});

function isolatedRustupEnvironment(root, rustupHome) {
  const environment = {
    ...process.env,
    RUSTUP_DIST_SERVER: pathToFileURL(join(root, "absent-dist")).href,
    RUSTUP_HOME: rustupHome,
  };
  delete environment.RUSTUP_TOOLCHAIN;
  return environment;
}

test("real setup refuses a missing toolchain file with its diagnostic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rust-setup-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await put(
    root,
    "scripts/setup-rust.sh",
    await readFile(join(repositoryRoot, "scripts/setup-rust.sh"), "utf8"),
  );
  const result = spawnSync("bash", ["scripts/setup-rust.sh"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rust-toolchain\.toml/u);
});

test("real setup propagates an offline unavailable-toolchain failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rust-setup-offline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rustupHome = join(root, "rustup-home");
  await mkdir(rustupHome);
  const setup = await readFile(join(repositoryRoot, "scripts/setup-rust.sh"), "utf8");
  await put(root, "scripts/setup-rust.sh", setup);
  await put(
    root,
    "rust-toolchain.toml",
    '[toolchain]\nchannel = "0.0.0"\ncomponents = ["rustfmt", "clippy", "llvm-tools"]\nprofile = "minimal"\n',
  );
  const result = spawnSync("bash", ["scripts/setup-rust.sh"], {
    cwd: root,
    encoding: "utf8",
    env: isolatedRustupEnvironment(root, rustupHome),
  });
  assert.notEqual(result.status, 0);
});

test("negative control proves plain rustup show would hide the unavailable pin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "rust-setup-negative-control-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rustupHome = join(root, "rustup-home");
  await mkdir(rustupHome);
  const setup = await readFile(join(repositoryRoot, "scripts/setup-rust.sh"), "utf8");
  const negativeControl = setup.replace(
    "rustup toolchain install --no-self-update\nrustup show active-toolchain",
    "rustup show",
  );
  assert.notEqual(negativeControl, setup);
  await put(root, "scripts/setup-rust.sh", negativeControl);
  await put(
    root,
    "rust-toolchain.toml",
    '[toolchain]\nchannel = "0.0.0"\ncomponents = ["rustfmt", "clippy", "llvm-tools"]\nprofile = "minimal"\n',
  );
  const result = spawnSync("bash", ["scripts/setup-rust.sh"], {
    cwd: root,
    encoding: "utf8",
    env: isolatedRustupEnvironment(root, rustupHome),
  });
  assert.equal(result.status, 0, result.stderr);
});
