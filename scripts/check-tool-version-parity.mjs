import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { globToRegExp } from "./coverage-scope.mjs";
import { workflowJobs, workflowSteps } from "./check-gate-routing.mjs";
import { isEntrypoint } from "./entrypoint.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

/*
Failure-path map. Every finding below is exercised through the CLI fixture helper, which asserts
the named message and status 1 in the same run. The test names are the node:test subtests.
  contractFile(ENOENT) -> reports all pre-Phase-3 checker finding paths / missing contract file;
  requiredWorkflowJob -> ... / missing registered workflow job;
  channel -> ... / invalid Rust channel;
  required component (each loop value) -> ... / missing rustfmt, missing clippy, missing llvm-tools;
  profile -> ... / non-minimal Rust profile;
  setup preamble/guard/install/report -> ... / setup strict-bash preamble, setup toolchain guard,
    setup install command, setup active-toolchain report;
  workflow RUSTUP_TOOLCHAIN -> ... / workflow RUSTUP_TOOLCHAIN declaration;
  workflow setup contract -> ... / registered workflow setup contract and
    registers each new Rust job's setup step / frontend, rust, rust-platform, rust-macos-test, rust-windows-test;
  dtolnay action -> ... / forbidden floating Rust action;
  release target setup -> ... / release target setup contract;
  push-skill setup fence -> ... / push skill setup fence;
  family minimum/authority/mismatch -> ... / tool-version family minimum, tool-version family
    authority, tool-version family mismatch;
  sccache setup/guard/docs mismatch -> reports sccache install, version-guard, and documentation
    drift through the CLI;
  sccache missing authority/docs -> requires the sccache setup authority and documentation site
    through the CLI;
  release clauses (1a)-(1d) -> reports each release matrix target-coverage clause / matching clause;
  release (1e), one per required target -> ... / missing aarch64-apple-darwin, missing
    x86_64-apple-darwin, missing x86_64-pc-windows-msvc;
  release (1f), both family cases -> ... / macOS entry carrying Windows target, Windows entry
    carrying macOS target;
  rust-platform (2), three targets plus family -> reports each rust-platform contract clause /
    matching subtest;
  rust-platform (3)-(5b) -> ... / matching subtest;
  rust-macos-test (6a)-(6b) and rust-windows-test (7a)-(7c) -> reports each Rust test-job
    contract clause / (6a) wrong runner, (6b) missing cargo test, (7a) wrong runner,
    (7b) missing cargo test, (7c) strategy declaration, (7c) matrix declaration;
  requiredWorkflowJob -> ... / missing registered workflow jobs frontend and rust,
    missing registered workflow job rust-windows-test;
  main findings return 1 -> every status-1 fixture above;
  unexpected main error return 2 -> reports an unexpected checker error with status 2;
  unaltered fixture -> accepts the complete Phase 3 fixture through the CLI (status 0).
*/

const TEST_FILE_GLOBS = ["scripts/*-tests.mjs", "scripts/*.test.mjs"];
const REQUIRED_RUST_COMPONENTS = ["rustfmt", "clippy", "llvm-tools"];
const COMPLETE_NUMERIC_RUST_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
export const REQUIRED_NON_LINUX_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
];
const RUST_PLATFORM_CLIPPY =
  "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings";
const RUST_TEST_COMMAND = "cargo test --manifest-path src-tauri/Cargo.toml --all-targets";
const SCCACHE_INSTALL_COMMAND_PATTERN =
  /cargo\s+install\s+sccache\s+--version\s+(\d+\.\d+\.\d+)\b/gu;
const RUST_TEST_JOBS = [
  { job: "rust-macos-test", runner: "macos-26-intel", clauses: ["6a", "6b"] },
  { job: "rust-windows-test", runner: "windows-latest", clauses: ["7a", "7b", "7c"] },
];
const RUST_WORKFLOW_JOBS = [
  [".github/workflows/test.yml", "frontend"],
  [".github/workflows/test.yml", "rust"],
  [".github/workflows/test.yml", "rust-platform"],
  ...RUST_TEST_JOBS.map(({ job }) => [".github/workflows/test.yml", job]),
  [".github/workflows/mutation.yml", "backend"],
  [".github/workflows/release.yml", "release"],
];

export const PARITY_FAMILIES = [
  {
    name: "nightly toolchain",
    minimumSites: 2,
    declarations: [
      {
        globs: ["scripts/*.mjs"],
        // Any exported or local const holding the pin, so extracting it into a shared
        // module keeps the authority rather than losing it. Binding to one identifier
        // name made the authority vanish the moment the constant moved.
        pattern: /\bconst\s+\w+\s*=\s*["'](nightly-\d{4}-\d{2}-\d{2})["']/gu,
        authority: true,
        exclude: TEST_FILE_GLOBS,
      },
      {
        globs: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
        pattern: /rustup\s+toolchain\s+install\s+(nightly-\d{4}-\d{2}-\d{2})\b/gu,
      },
      {
        globs: [".claude/skills/*/SKILL.md", "*.toml"],
        pattern: /\b(nightly-\d{4}-\d{2}-\d{2})\b/gu,
      },
    ],
  },
  {
    name: "cargo-llvm-cov",
    minimumSites: 2,
    declarations: [
      {
        globs: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
        pattern: /cargo\s+install\s+cargo-llvm-cov\s+--version\s+(\d+\.\d+\.\d+)\b/gu,
        authority: true,
      },
      {
        globs: [".claude/skills/*/SKILL.md"],
        pattern: /cargo-llvm-cov`?\s+(\d+\.\d+\.\d+)\b/gu,
      },
    ],
  },
  {
    name: "sccache",
    minimumSites: 4,
    declarations: [
      {
        globs: [".project.json"],
        pattern: SCCACHE_INSTALL_COMMAND_PATTERN,
        authority: true,
      },
      {
        globs: ["CONTRIBUTING.md"],
        pattern: SCCACHE_INSTALL_COMMAND_PATTERN,
      },
      {
        globs: [".project.json", "CONTRIBUTING.md"],
        pattern: /\bsccache`?\s+(\d+\.\d+\.\d+)\b/gu,
      },
    ],
  },
  {
    name: "cargo-mutants",
    minimumSites: 1,
    declarations: [
      {
        globs: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
        pattern: /cargo\s+install\s+cargo-mutants\s+--version\s+(\d+\.\d+\.\d+)\b/gu,
        authority: true,
      },
    ],
  },
];

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function siteLabel(site) {
  return `${site.path}:${site.line}`;
}

function defaultListFiles(repoRoot) {
  return listWorkingTreeFiles({ workspaceRoot: repoRoot, pathspec: "." });
}

async function contractFile(repoRoot, path, findings, contents) {
  const absolute = resolve(repoRoot, path);
  if (contents.has(absolute)) return contents.get(absolute);
  try {
    const text = await readFile(absolute, "utf8");
    contents.set(absolute, text);
    return text;
  } catch (error) {
    if (error?.code === "ENOENT") {
      findings.push(`${path}: required Rust toolchain contract file is missing`);
      return undefined;
    }
    throw error;
  }
}

function requiredWorkflowJob(jobs, path, jobName, findings) {
  const job = jobs.find((candidate) => candidate.name === jobName);
  if (job === undefined) findings.push(`${path}: required Rust job ${jobName} is missing`);
  return job;
}

function isFailureTolerant(value) {
  return value !== undefined && value !== "false";
}

// A job's own keys sit at exactly four spaces, so anchoring there keeps a `strategy:` written
// inside a multi-line `run:` block from reading as a job key. Quoted and space-before-colon
// spellings are accepted because YAML treats them as the same key.
function jobHasKey(body, key) {
  return new RegExp(`^ {4}["']?${key}["']?\\s*:`, "mu").test(body);
}

function declaresRustupToolchain(workflow) {
  if (/^[^#\n]*["']?RUSTUP_TOOLCHAIN["']?\s*:/mu.test(workflow)) return true;
  return workflowSteps(workflow).some((step) =>
    /(?:^|\n|[;&|])\s*(?:(?:export|env)\s+)?RUSTUP_TOOLCHAIN\s*=/u.test(step.run),
  );
}

function indentation(line) {
  return line.match(/^\s*/u)[0].length;
}

function jobLayout(body) {
  const lines = body.split(/\r?\n/u);
  const populated = lines.filter((line) => line.trim());
  const level = populated.length === 0 ? 0 : Math.min(...populated.map(indentation));
  return { lines, level };
}

function topLevelJobValue(body, key) {
  const { lines, level } = jobLayout(body);
  const prefix = new RegExp(`^\\s{${level}}${key}:\\s*(.*)$`, "u");
  return lines.find((line) => prefix.test(line))?.match(prefix)?.[1];
}

function nestedJobValue(body, parent, key) {
  const { lines, level } = jobLayout(body);
  const parentLine = lines.findIndex(
    (line) => indentation(line) === level && new RegExp(`^${parent}:\\s*$`, "u").test(line.trim()),
  );
  if (parentLine < 0) return undefined;
  const parentIndentation = indentation(lines[parentLine]);
  for (let index = parentLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentation(line) <= parentIndentation) break;
    const match = new RegExp(`^\\s+${key}:\\s*(.*)$`, "u").exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function yamlScalar(value) {
  if (value === undefined) return { present: false, isString: false, value: undefined };
  const trimmed = value.trim();
  if (trimmed === "") return { present: true, isString: false, value: undefined };
  if (trimmed.startsWith("'")) {
    const end = trimmed.indexOf("'", 1);
    if (end > 0) {
      return {
        present: true,
        isString: true,
        value: trimmed.slice(1, end).replaceAll("''", "'"),
      };
    }
  }
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return { present: true, isString: true, value: trimmed.slice(1, end) };
  }
  if (/^(?:\[|\{|true$|false$|null$|-?\d)/u.test(trimmed)) {
    return { present: true, isString: false, value: trimmed };
  }
  return { present: true, isString: true, value: trimmed };
}

function matrixIncludeEntries(body) {
  const { lines, level } = jobLayout(body);
  const strategyIndex = lines.findIndex(
    (line) => indentation(line) === level && line.trim() === "strategy:",
  );
  if (strategyIndex < 0) return undefined;
  const strategyIndentation = indentation(lines[strategyIndex]);
  const includeIndex = lines.findIndex((line, index) => {
    if (index <= strategyIndex || indentation(line) <= strategyIndentation) return false;
    return /^include:\s*(?:\[\])?\s*$/u.test(line.trim());
  });
  if (includeIndex < 0) return undefined;
  if (lines[includeIndex].trim() === "include: []") return [];
  const includeIndentation = indentation(lines[includeIndex]);
  const entries = [];
  let current;
  let entryIndentation;
  const addProperty = (entry, text) => {
    const match = /^(platform|args|os|target):\s*(.*)$/u.exec(text.trim());
    if (match) entry[match[1]] = yamlScalar(match[2]);
  };
  for (let index = includeIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && indentation(line) <= includeIndentation) break;
    if (line.trim().startsWith("-") && indentation(line) > includeIndentation) {
      if (current) entries.push(current);
      current = {};
      entryIndentation = indentation(line);
      addProperty(current, line.trim().slice(1).trim());
      continue;
    }
    if (current && line.trim() && indentation(line) > entryIndentation) {
      addProperty(current, line);
    }
  }
  if (current) entries.push(current);
  return entries;
}

function targetFamily(target) {
  if (target.endsWith("-apple-darwin")) return "macos";
  if (/-pc-windows-/u.test(target)) return "windows";
  return undefined;
}

function platformFamily(platform) {
  if (platform.startsWith("macos-")) return "macos";
  if (platform.startsWith("windows-")) return "windows";
  return undefined;
}

function targetsFromReleaseEntry(entry) {
  const platform = entry.platform?.value;
  if (!entry.platform?.isString || typeof platform !== "string") return [];
  if (!entry.args?.present) {
    return platform.startsWith("windows-") ? ["x86_64-pc-windows-msvc"] : [];
  }
  if (!entry.args.isString || typeof entry.args.value !== "string") return [];
  const targets = [...entry.args.value.matchAll(/--target\s+([^\s'"`]+)/gu)].map(
    (match) => match[1],
  );
  return targets.length === 0 && platform.startsWith("windows-")
    ? ["x86_64-pc-windows-msvc"]
    : targets;
}

function checkTargetCoverage(workflows, findings) {
  const release = workflows.get(".github/workflows/release.yml");
  const releaseJob = release?.jobs.find((job) => job.name === "release");
  if (releaseJob === undefined) return;
  const entries = matrixIncludeEntries(releaseJob.body);
  if (entries === undefined) {
    findings.push(".github/workflows/release.yml: (1a) release job has no strategy.matrix.include");
    return;
  }
  if (entries.length === 0) {
    findings.push(".github/workflows/release.yml: (1b) release matrix.include is empty");
    return;
  }

  const derived = [];
  for (const [index, entry] of entries.entries()) {
    if (
      !entry.platform?.present ||
      !entry.platform.isString ||
      typeof entry.platform.value !== "string" ||
      entry.platform.value === ""
    ) {
      findings.push(
        `.github/workflows/release.yml: (1c) release matrix entry ${index + 1} has no platform`,
      );
      continue;
    }
    if (entry.args?.present && !entry.args.isString) {
      findings.push(
        `.github/workflows/release.yml: (1d) release matrix entry ${index + 1} args must be a string`,
      );
      continue;
    }
    const platform = entry.platform.value;
    for (const target of targetsFromReleaseEntry(entry)) {
      derived.push({ target, platform });
      const targetOs = targetFamily(target);
      const platformOs = platformFamily(platform);
      if (targetOs !== undefined && targetOs !== platformOs) {
        findings.push(
          `.github/workflows/release.yml: (1f) derived target ${target} does not match release platform ${platform}`,
        );
      }
    }
  }
  for (const target of REQUIRED_NON_LINUX_TARGETS) {
    if (!derived.some((entry) => entry.target === target)) {
      findings.push(
        `.github/workflows/release.yml: (1e) required target ${target} is not derived from any release matrix entry`,
      );
    }
  }

  const platformJob = workflows
    .get(".github/workflows/test.yml")
    ?.jobs.find((job) => job.name === "rust-platform");
  if (platformJob === undefined) return;
  const platformEntries = matrixIncludeEntries(platformJob.body) ?? [];
  for (const targetEntry of derived.filter((entry) => targetFamily(entry.target) !== undefined)) {
    const family = targetFamily(targetEntry.target);
    const expectedOs = family === "macos" ? "macos-26-intel" : `${family}-latest`;
    const matching = platformEntries.find(
      (entry) => entry.target?.isString && entry.target.value === targetEntry.target,
    );
    if (matching === undefined) {
      findings.push(
        `.github/workflows/test.yml: (2) rust-platform matrix is missing target ${targetEntry.target}`,
      );
    } else if (matching.os?.value !== expectedOs) {
      findings.push(
        `.github/workflows/test.yml: (2) rust-platform target ${targetEntry.target} must use os ${expectedOs}`,
      );
    }
  }
  const runsOn = topLevelJobValue(platformJob.body, "runs-on");
  if (runsOn !== "${{ matrix.os }}") {
    findings.push(
      ".github/workflows/test.yml: (3) rust-platform must use runs-on: ${{ matrix.os }}",
    );
  }
  const buildTarget = nestedJobValue(platformJob.body, "env", "CARGO_BUILD_TARGET");
  if (buildTarget !== "${{ matrix.target }}") {
    findings.push(
      ".github/workflows/test.yml: (4) rust-platform must set CARGO_BUILD_TARGET: ${{ matrix.target }}",
    );
  }
  const platformSteps = workflowSteps(platformJob.body);
  if (platformSteps.some((step) => hasCargoCheck(step.run))) {
    findings.push(
      ".github/workflows/test.yml: (5a) rust-platform must not contain a cargo check step; clippy covers every target",
    );
  }
  if (!platformSteps.some((step) => step.run === RUST_PLATFORM_CLIPPY)) {
    findings.push(
      `.github/workflows/test.yml: (5b) rust-platform is missing the exact cargo clippy step: ${RUST_PLATFORM_CLIPPY}`,
    );
  }

  const linuxJob =
    workflows
      .get(".github/workflows/test.yml")
      ?.jobs.filter((job) => ["frontend", "rust"].includes(job.name)) ?? [];
  for (const job of linuxJob) {
    if (!workflowSteps(job.body).some((step) => hasCargoCheck(step.run))) continue;
    findings.push(
      ".github/workflows/test.yml: (5a) Linux Rust-compiling job must not contain a cargo check step; clippy covers every target",
    );
  }
}

function hasCargoCheck(run) {
  return /(^|[^\w-])cargo\s+(\+\S+\s+)?check(?![\w-])/u.test(run);
}

// Deliberately not part of checkTargetCoverage: that function returns early on four unrelated
// release.yml and rust-platform problems, and those early returns would silently skip every
// clause below, so a broken release matrix would disable the Windows job's enforcement.
function checkRustTestJobs(workflows, findings) {
  const testWorkflow = workflows.get(".github/workflows/test.yml");
  for (const { job: jobName, runner, clauses } of RUST_TEST_JOBS) {
    const rustTestJob = testWorkflow?.jobs.find((job) => job.name === jobName);
    if (rustTestJob === undefined) continue;
    if (topLevelJobValue(rustTestJob.body, "runs-on") !== runner) {
      findings.push(
        `.github/workflows/test.yml: (${clauses[0]}) ${jobName} must use runs-on: ${runner}`,
      );
    }
    if (!workflowSteps(rustTestJob.body).some((step) => step.run === RUST_TEST_COMMAND)) {
      findings.push(
        `.github/workflows/test.yml: (${clauses[1]}) ${jobName} is missing the receipt command: ${RUST_TEST_COMMAND}`,
      );
    }
    if (
      clauses.includes("7c") &&
      (jobHasKey(rustTestJob.body, "strategy") || jobHasKey(rustTestJob.body, "matrix"))
    ) {
      findings.push(
        `.github/workflows/test.yml: (7c) ${jobName} must not declare strategy or matrix`,
      );
    }
  }
}

export async function checkRustToolchainContract(repoRoot, { contents = new Map() } = {}) {
  const findings = [];
  const toolchain = await contractFile(repoRoot, "rust-toolchain.toml", findings, contents);
  if (toolchain !== undefined) {
    const channel = /^channel\s*=\s*["']([^"']+)["']\s*$/mu.exec(toolchain)?.[1];
    if (channel === undefined || !COMPLETE_NUMERIC_RUST_VERSION.test(channel)) {
      findings.push(
        `rust-toolchain.toml: channel must be a complete stable numeric major.minor.patch pin; found ${JSON.stringify(channel ?? "missing")}`,
      );
    }
    const componentLine = /^components\s*=\s*\[([^\]]*)\]\s*$/mu.exec(toolchain)?.[1];
    const components = componentLine
      ? [...componentLine.matchAll(/["']([^"']+)["']/gu)].map((match) => match[1])
      : [];
    for (const component of REQUIRED_RUST_COMPONENTS) {
      if (!components.includes(component)) {
        findings.push(`rust-toolchain.toml: required component ${component} is missing`);
      }
    }
    if (!/^profile\s*=\s*["']minimal["']\s*$/mu.test(toolchain)) {
      findings.push('rust-toolchain.toml: profile must be "minimal"');
    }
  }

  const setup = await contractFile(repoRoot, "scripts/setup-rust.sh", findings, contents);
  if (setup !== undefined) {
    if (!setup.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")) {
      findings.push("scripts/setup-rust.sh: must start with the reviewed strict-bash preamble");
    }
    if (
      !/^if \[\[ ! -f rust-toolchain\.toml \]\]; then\n  echo .*rust-toolchain\.toml.* >&2\n  exit 1\nfi$/mu.test(
        setup,
      )
    ) {
      findings.push(
        "scripts/setup-rust.sh: missing nonzero rust-toolchain.toml guard and stderr diagnostic",
      );
    }
    if (!/^rustup toolchain install --no-self-update$/mu.test(setup)) {
      findings.push(
        "scripts/setup-rust.sh: must install from rust-toolchain.toml with rustup toolchain install --no-self-update and no channel argument",
      );
    }
    if (!/^rustup show active-toolchain$/mu.test(setup)) {
      findings.push("scripts/setup-rust.sh: must report rustup show active-toolchain");
    }
  }

  const workflows = new Map();
  for (const [path] of RUST_WORKFLOW_JOBS) {
    const workflow = await contractFile(repoRoot, path, findings, contents);
    if (workflow !== undefined) workflows.set(path, { jobs: workflowJobs(workflow), workflow });
  }

  for (const [path, jobName] of RUST_WORKFLOW_JOBS) {
    const parsed = workflows.get(path);
    if (parsed === undefined) continue;
    const { jobs, workflow } = parsed;
    if (declaresRustupToolchain(workflow)) {
      findings.push(
        `${path}: must not declare RUSTUP_TOOLCHAIN in repository workflow configuration`,
      );
    }
    const job = requiredWorkflowJob(jobs, path, jobName, findings);
    if (job === undefined) continue;
    const setupSteps = workflowSteps(job.body).filter(
      (step) => step.run === "bash scripts/setup-rust.sh",
    );
    if (
      setupSteps.length !== 1 ||
      setupSteps[0].shell !== "bash" ||
      setupSteps[0].hasIf ||
      isFailureTolerant(setupSteps[0].continueOnError)
    ) {
      findings.push(
        `${path}: job ${jobName} must contain exactly one unconditional, failure-propagating bash scripts/setup-rust.sh step with shell bash`,
      );
    }
    if (/dtolnay\/rust-toolchain@/u.test(job.body)) {
      findings.push(`${path}: job ${jobName} must not use dtolnay/rust-toolchain`);
    }
  }

  checkTargetCoverage(workflows, findings);
  checkRustTestJobs(workflows, findings);

  const release = workflows.get(".github/workflows/release.yml");
  if (release !== undefined) {
    const releaseJob = release.jobs.find((job) => job.name === "release");
    const targetSteps =
      releaseJob === undefined
        ? []
        : workflowSteps(releaseJob.body).filter(
            (step) => step.run === "rustup target add aarch64-apple-darwin x86_64-apple-darwin",
          );
    if (
      releaseJob !== undefined &&
      (targetSteps.length !== 1 ||
        targetSteps[0].shell !== "bash" ||
        targetSteps[0].ifValue !== "runner.os == 'macOS'" ||
        isFailureTolerant(targetSteps[0].continueOnError))
    ) {
      findings.push(
        ".github/workflows/release.yml: release must add both existing macOS targets in exactly one macOS-only, failure-propagating step with shell bash",
      );
    }
  }

  const pushSkill = await contractFile(
    repoRoot,
    ".claude/skills/push/SKILL.md",
    findings,
    contents,
  );
  if (pushSkill !== undefined) {
    const rustSection = /### Rust\/Tauri backend\n([\s\S]*?)(?=\n### |\n## |$)/u.exec(
      pushSkill,
    )?.[1];
    const setupCommands = rustSection?.match(/^bash scripts\/setup-rust\.sh$/gmu) ?? [];
    if (setupCommands.length !== 1) {
      findings.push(
        ".claude/skills/push/SKILL.md: Rust gate fence must contain bash scripts/setup-rust.sh exactly once",
      );
    }
  }

  return findings.sort();
}

export async function discoverToolVersions(
  repoRoot,
  families = PARITY_FAMILIES,
  { contents = new Map(), listFiles = defaultListFiles } = {},
) {
  const root = resolve(repoRoot);
  const files = listFiles(root).map((relative) => ({
    absolute: resolve(root, relative),
    relative,
  }));
  const results = [];

  for (const family of families) {
    const sites = [];
    for (const declaration of family.declarations) {
      const includes = declaration.globs.map(globToRegExp);
      const excludes = (declaration.exclude ?? []).map(globToRegExp);
      for (const file of files) {
        if (!includes.some((matcher) => matcher.test(file.relative))) continue;
        if (excludes.some((matcher) => matcher.test(file.relative))) continue;
        if (!contents.has(file.absolute)) {
          let text;
          try {
            text = await readFile(file.absolute, "utf8");
          } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
          }
          contents.set(file.absolute, text);
        }
        const text = contents.get(file.absolute);
        for (const match of text.matchAll(declaration.pattern)) {
          sites.push({
            path: file.relative,
            line: lineNumber(text, match.index),
            value: match[1],
            authority: declaration.authority === true,
          });
        }
      }
    }
    results.push({ ...family, sites });
  }
  return results;
}

export async function checkToolVersionParity(repoRoot, families = PARITY_FAMILIES, options = {}) {
  const contents = options.contents ?? new Map();
  const findings = await checkRustToolchainContract(repoRoot, { contents });
  for (const family of await discoverToolVersions(repoRoot, families, { ...options, contents })) {
    if (family.sites.length < family.minimumSites) {
      const globs = family.declarations.flatMap((declaration) => declaration.globs).join(", ");
      findings.push(
        `${family.name}: expected at least ${family.minimumSites} declaration site(s) matching ${globs}; found ${family.sites.length}`,
      );
    }

    const authorities = family.sites.filter((site) => site.authority);
    if (authorities.length !== 1) {
      findings.push(
        `${family.name}: expected exactly one authority; found ${authorities.length}${
          authorities.length > 0
            ? ` (${authorities.map((site) => siteLabel(site)).join(", ")})`
            : ""
        }`,
      );
      continue;
    }

    const authority = authorities[0];
    for (const site of family.sites) {
      if (site === authority || site.value === authority.value) continue;
      findings.push(
        `${family.name} mismatch: authority ${siteLabel(authority)} declares ${JSON.stringify(authority.value)}; ${siteLabel(site)} declares ${JSON.stringify(site.value)}`,
      );
    }
  }
  return findings.sort();
}

async function main() {
  const findings = await checkToolVersionParity(process.cwd());
  if (findings.length > 0) {
    console.error("Tool version parity check: FAIL");
    for (const finding of findings) console.error(`  * ${finding}`);
    return 1;
  }
  console.log("Tool version parity check: OK");
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    });
}
