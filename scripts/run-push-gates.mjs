#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, statSync } from "node:fs";
import { availableParallelism as defaultAvailableParallelism } from "node:os";
import { extname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { isEntrypoint } from "./entrypoint.mjs";
import {
  gateBudgetBytes,
  rustBuildEnvironment,
  VITEST_MINIMUM_BUDGET_BYTES,
} from "./gate-parallelism.mjs";
import {
  CHILD_TERMINATION_TIMEOUT_MS,
  E2E_LANE_TERMINATION_TIMEOUT_MS,
  formatNestedError,
  installMultiChildSignalForwarding,
  signalExitCode,
  superviseChild as defaultSuperviseChild,
} from "./child-supervisor.mjs";
import {
  GATE_LOG_DIRECTORY_ENV,
  createLogCapture,
  formatFailureTrailer,
  makeLogDirectory,
  readLogTail,
  writeLogChunk,
} from "./gate-logs.mjs";
import { E2E_CONTAINER_MEMORY_BYTES } from "./run-e2e-container.mjs";
import { mutationPackages } from "./frontend-mutation-packages.mjs";
import { matches } from "./coverage-scope.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";
import { importSpecifierBasePath } from "./import-path.mjs";

const GIB = 1024 ** 3;

// Shares apply after the selected e2e container reservation. Coverage gets half when
// concurrent mutation shares P2 and the full remainder otherwise. With e2e selected, it is raised
// to VITEST_MINIMUM_BUDGET_BYTES when the post-reservation budget can fund that floor.
export const P2_VITEST_SHARE = 0.5;

// Concurrent mutation gets 35% of the post-container remainder, leaving 15% beside coverage's
// 50% share for contract/receipt peaks. A coverage floor that raises its share consumes
// that nominal remainder. Below the one-wave budget, mutation runs after P2 with the full remainder.
export const P2_MUTATION_SHARE = 0.35;

// This is the raw gate budget threshold for two concurrent self-sizing lanes, before container
// reservation. Below it, including the 7 GiB agent budget, mutation follows P2 with the remainder.
export const ONE_WAVE_BYTES = 40 * GIB;

// Two self-sizing lanes split the available CPU evenly; one CPU cannot run both without
// oversubscribing its worker floors, so mutation follows P2 below this count.
const MIN_CONCURRENT_SELF_SIZING_CPUS = 2;

export const PUSH_GATE_SCHEDULE = Object.freeze({
  p0: Object.freeze([
    Object.freeze({ name: "mutation-guard", command: "pnpm mutation:guard:check", always: true }),
    Object.freeze({
      name: "rust-target-eviction",
      command: "pnpm rust:target:evict",
      blocks: Object.freeze(["rust", "bindings"]),
      advisory: true,
    }),
    Object.freeze({
      name: "setup-rust",
      command: "bash scripts/setup-rust.sh",
      blocks: Object.freeze(["rust", "bindings"]),
    }),
  ]),
  p1: Object.freeze([
    Object.freeze({
      name: "frontend-build",
      command: "pnpm gate:run frontend-build",
      blocks: Object.freeze(["rust", "frontend", "bindings"]),
    }),
    Object.freeze({
      name: "bindings-check",
      command: "pnpm bindings:check",
      blocks: Object.freeze(["bindings"]),
    }),
  ]),
  lanes: Object.freeze([
    Object.freeze({
      name: "contract",
      commands: Object.freeze([
        "pnpm gates:contract:check",
        "env -u KIT_ROOT pnpm findings:kit:check",
      ]),
      always: true,
    }),
    Object.freeze({
      name: "rust-lint",
      rustCompilation: true,
      commands: Object.freeze([
        "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
        "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
        "pnpm rust:windows:check",
      ]),
      blocks: Object.freeze(["rust"]),
      requires: Object.freeze(["setup-rust", "frontend-build"]),
    }),
    Object.freeze({
      name: "rust-test",
      rustCompilation: true,
      commands: Object.freeze(["pnpm gate:ensure backend-test"]),
      blocks: Object.freeze(["rust"]),
      requires: Object.freeze(["setup-rust", "frontend-build"]),
    }),
    Object.freeze({
      name: "rust-coverage",
      rustCompilation: true,
      commands: Object.freeze(["pnpm gate:ensure backend-coverage"]),
      blocks: Object.freeze(["rust"]),
      requires: Object.freeze(["setup-rust", "frontend-build"]),
    }),
    Object.freeze({
      name: "frontend-coverage",
      commands: Object.freeze(["pnpm gate:ensure frontend-coverage"]),
      blocks: Object.freeze(["frontend"]),
      selfSizing: "vitest",
    }),
    Object.freeze({
      name: "bundle",
      commands: Object.freeze(["pnpm bundle:check"]),
      blocks: Object.freeze(["frontend"]),
      requires: Object.freeze(["frontend-build"]),
    }),
    Object.freeze({
      name: "e2e",
      commands: Object.freeze(["pnpm gate:ensure e2e-container"]),
      blocks: Object.freeze(["frontend"]),
      after: Object.freeze(["rust-lint", "rust-test", "rust-coverage", "bundle"]),
    }),
    Object.freeze({
      name: "frontend-mutation",
      commands: Object.freeze(["pnpm gate:ensure frontend-mutation"]),
      blocks: Object.freeze(["frontend"]),
      selfSizing: "mutation",
    }),
  ]),
});

export const PRE_REVIEW_GATE_SCHEDULE = Object.freeze({
  p1: Object.freeze([
    Object.freeze({ name: "frontend-build", command: "pnpm gate:run frontend-build" }),
  ]),
  lanes: Object.freeze([
    Object.freeze({
      name: "format-lint",
      commands: Object.freeze([
        "pnpm exec oxfmt --check <changed-format-files>",
        "pnpm exec oxlint --deny-warnings <changed-js-ts-files>",
        "pnpm exec tsgo --noEmit",
        "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
      ]),
    }),
    Object.freeze({
      name: "coverage-mapping-frontend",
      commands: Object.freeze(["pnpm coverage:mapping:frontend"]),
    }),
    Object.freeze({
      name: "coverage-mapping-backend",
      commands: Object.freeze(["pnpm coverage:mapping:backend"]),
    }),
    Object.freeze({
      name: "frontend-mutation-changed-files",
      commands: Object.freeze([
        "pnpm mutation:frontend -- --files <comma-separated-production-files>",
      ]),
    }),
    Object.freeze({
      name: "windows-clippy",
      rustCompilation: true,
      commands: Object.freeze(["pnpm rust:windows:check"]),
      requires: Object.freeze(["frontend-build"]),
    }),
    Object.freeze({
      name: "bundle",
      commands: Object.freeze(["pnpm bundle:check"]),
      requires: Object.freeze(["frontend-build"]),
    }),
  ]),
});

export const FRONTEND_INPUTS = Object.freeze([
  "src/**",
  "public/**",
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vite.config.*",
  "stryker.config.mjs",
  "scripts/run-frontend-mutation.mjs",
  "scripts/frontend-mutation-packages.mjs",
  "i18next.config.*",
  "src/translation/**",
  "src/catalogs/**",
]);

const OXFMT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".jsonc",
  ".json5",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".astro",
  ".yaml",
  ".yml",
]);
const OXFMT_IGNORES = Object.freeze([
  "**/*.md",
  "public/**/*",
  "src-tauri/**/*",
  ".github/**/*",
  "src/catalogs/**/*",
  "src/bindings/generated.ts",
  "src/routeTree.gen.ts",
  "bunfig.toml",
]);
const OXLINT_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const OXLINT_IGNORES = Object.freeze([
  "public/**/*",
  "src-tauri/**/*",
  ".github/**/*",
  "src/bindings/generated.ts",
  "src/routeTree.gen.ts",
]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const WINDOWS_CLIPPY_INPUTS = Object.freeze([
  ".cargo/**",
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
  "rust-toolchain.toml",
  "tauri.conf.json",
]);
const RUST_FORMAT_CONFIGS = Object.freeze([
  ".cargo/**",
  "Cargo.toml",
  "src-tauri/Cargo.toml",
  "rust-toolchain.toml",
  "rustfmt.toml",
  ".rustfmt.toml",
]);

const BLOCK_FLAGS = Object.freeze({
  "--rust": "rust",
  "--frontend": "frontend",
  "--bindings": "bindings",
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function nestedErrorMessage(error) {
  return formatNestedError(error, (message, nested, depth) =>
    [`${"  ".repeat(depth)}${message}`, ...nested].join("\n"),
  );
}

function commandResult(result) {
  if (result.error) return { code: 127, error: result.error };
  if (result.code !== null) return { code: result.code, signal: result.signal };
  return { code: signalExitCode(result.signal), signal: result.signal };
}

function recordChildOutcome(task, result) {
  task.signal = result.signal;
  task.childExitCode = result.childExitCode;
  task.childSignal = result.childSignal;
  task.terminationError = result.terminationError;
}

export function parsePushGateArguments(argumentsList) {
  const args = [...argumentsList];
  if (args[0] === "--") args.shift();
  const blocks = new Set();
  for (const argument of args) {
    const block = BLOCK_FLAGS[argument];
    if (!block) {
      return {
        error: `Unknown argument ${JSON.stringify(argument)}. Usage: pnpm gates:push -- [--rust] [--frontend] [--bindings]`,
      };
    }
    blocks.add(block);
  }
  return { blocks };
}

export function pushGateScheduleCommands(schedule = PUSH_GATE_SCHEDULE) {
  return flattenGateSchedule(schedule, ["p0", "p1", "lanes"]);
}

export function preReviewGateScheduleCommands(schedule = PRE_REVIEW_GATE_SCHEDULE) {
  return flattenGateSchedule(schedule, ["p1", "lanes"]);
}

function flattenGateSchedule(schedule, phases) {
  return phases.flatMap((phase) =>
    schedule[phase].flatMap((entry) => entry.commands ?? [entry.command]),
  );
}

function gitFailure(args, result, headline = "Cannot determine pre-review changed paths") {
  const detail = result.error
    ? result.error.message
    : result.stderr?.trim() || `exit status ${result.status ?? "unknown"}`;
  return new Error(`${headline}: git ${args.join(" ")} failed (${detail})`, {
    cause: result.error ?? new Error(detail),
  });
}

export function discoverPreReviewChanges({
  cwd = process.cwd(),
  runGit = spawnSync,
  listUntracked = (workspaceRoot) =>
    listWorkingTreeFiles({ workspaceRoot, pathspec: ".", untrackedOnly: true }),
} = {}) {
  const run = (args) => {
    const result = runGit("git", args, { cwd, encoding: "utf8" });
    if (result.error || result.status !== 0) throw gitFailure(args, result);
    return String(result.stdout ?? "");
  };

  const mergeBaseArgs = ["merge-base", "HEAD", "@{u}"];
  const base = run(mergeBaseArgs).trim();
  if (!base) {
    throw new Error(
      `Cannot determine pre-review changed paths: git ${mergeBaseArgs.join(" ")} returned no merge base`,
    );
  }
  const tracked = run(["diff", "--name-only", "-z", base, "--"]).split("\0").filter(Boolean);
  const untracked = listUntracked(cwd);
  return { mergeBase: base, paths: [...new Set([...tracked, ...untracked])].sort() };
}

function commandDisplay(executable, args) {
  return [executable, ...args]
    .map((argument) => (/[\s'"\\]/u.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function commandSpec(executable, args) {
  return { executable, args, display: commandDisplay(executable, args) };
}

function hasExtension(path, extensions) {
  return extensions.has(extname(path).toLowerCase());
}

function isRustChanged(path) {
  return path.startsWith("src-tauri/") || matches(path, WINDOWS_CLIPPY_INPUTS);
}

function isRustFormatChanged(path) {
  return path.endsWith(".rs") || path === "build.rs" || matches(path, RUST_FORMAT_CONFIGS);
}

function isOxfmtOwned(path) {
  return hasExtension(path, OXFMT_EXTENSIONS) && !matches(path, OXFMT_IGNORES);
}

function isOxlintOwned(path) {
  return hasExtension(path, OXLINT_EXTENSIONS) && !matches(path, OXLINT_IGNORES);
}

function isTypeScriptChanged(path) {
  return hasExtension(path, TYPESCRIPT_EXTENSIONS) || /^tsconfig(?:\.[^/]*)?\.json$/u.test(path);
}

function importSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`]*?\s+from\s*)?['"]([^'"`]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  return [
    ...new Set(patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]))),
  ];
}

function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

function resolveLocalImport(root, importer, specifier, isFile = isRegularFile) {
  const basePath = importSpecifierBasePath(importer, specifier, { allowSourceRoot: true });
  if (basePath === undefined) return undefined;
  const base = resolve(root, basePath);

  const candidates = extname(base)
    ? [base]
    : [
        base,
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(
          (extension) => `${base}${extension}`,
        ),
        ...[".ts", ".tsx", ".js", ".jsx", ".json"].map((extension) =>
          resolve(base, `index${extension}`),
        ),
      ];
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    const path = relative(root, candidate).split(sep).join("/");
    if (!path.startsWith("../")) return path;
  }
  return undefined;
}

export function mutationFilesForChanges(
  changedPaths,
  {
    root = process.cwd(),
    readSource = (path) => readFileSync(path, "utf8"),
    exists = existsSync,
    isFile = isRegularFile,
    mergeBase = undefined,
    runGit = spawnSync,
  } = {},
) {
  const filesByPackage = new Map(
    Object.entries(mutationPackages).flatMap(([packageId, files]) =>
      files.map((path) => [path, packageId]),
    ),
  );
  const changed = new Set(changedPaths);
  const selectedFiles = new Set(
    [...changed].filter((path) => filesByPackage.has(path) && exists(resolve(root, path))),
  );

  const changedTests = [...changed].filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path));
  const scanTests = ({ readTreeSource, treeIsFile, treeExists, wrapReadError }) => {
    const scanQueue = changedTests
      .filter((path) => treeExists(resolve(root, path)))
      .map((importer) => ({ importer }));
    const scanned = new Set();
    while (scanQueue.length > 0) {
      const { importer } = scanQueue.pop();
      if (scanned.has(importer)) continue;
      scanned.add(importer);
      let source;
      try {
        source = readTreeSource(resolve(root, importer));
      } catch (error) {
        throw wrapReadError(importer, error);
      }
      for (const specifier of importSpecifiers(source)) {
        const dependency = resolveLocalImport(root, importer, specifier, treeIsFile);
        if (!dependency) continue;
        if (filesByPackage.has(dependency)) selectedFiles.add(dependency);
        if (dependency.startsWith("src/") && treeExists(resolve(root, dependency))) {
          scanQueue.push({ importer: dependency });
        }
      }
    }
  };
  const workingReadError = (importer, error) =>
    new Error(`Cannot read changed test ${importer} for mutation selection: ${error.message}`, {
      cause: error,
    });

  scanTests({
    readTreeSource: readSource,
    treeIsFile: isFile,
    treeExists: exists,
    wrapReadError: workingReadError,
  });

  if (mergeBase !== undefined) {
    const treeArgs = ["ls-tree", "-r", "-z", mergeBase];
    const treeResult = runGit("git", treeArgs, { cwd: root, encoding: "utf8" });
    if (treeResult.error || treeResult.status !== 0) {
      throw gitFailure(
        treeArgs,
        treeResult,
        `Cannot inspect merge-base tree ${mergeBase} for mutation selection`,
      );
    }
    const baseFiles = new Set(
      String(treeResult.stdout ?? "")
        .split("\0")
        .flatMap((entry) => {
          const [metadata, path] = entry.split("\t");
          return metadata?.split(" ")[1] === "blob" && path ? [path] : [];
        }),
    );
    const baseRelativePath = (absolutePath) => relative(root, absolutePath).split(sep).join("/");
    const baseIsFile = (absolutePath) => {
      const path = baseRelativePath(absolutePath);
      return !path.startsWith("../") && baseFiles.has(path);
    };
    const readBaseSource = (absolutePath) => {
      const path = baseRelativePath(absolutePath);
      const args = ["show", `${mergeBase}:${path}`];
      const result = runGit("git", args, { cwd: root, encoding: "utf8" });
      if (result.error || result.status !== 0) {
        throw gitFailure(
          args,
          result,
          `Cannot read ${path} at ${mergeBase} for mutation selection`,
        );
      }
      return String(result.stdout ?? "");
    };
    scanTests({
      readTreeSource: readBaseSource,
      treeIsFile: baseIsFile,
      treeExists: baseIsFile,
      wrapReadError: (_importer, error) => error,
    });
  }
  return [...selectedFiles].filter((path) => exists(resolve(root, path))).sort();
}

function hasCoverageInputsChanged(changedPaths, { root, config, baseline }) {
  return changedPaths.some(
    (path) => path === config || path === baseline || path.startsWith(`${root}/`),
  );
}

export function selectPreReviewLanes(
  changedPaths,
  { root = process.cwd(), mergeBase = undefined, runGit = spawnSync } = {},
) {
  const paths = [...new Set(changedPaths)];
  const existing = (path) => existsSync(resolve(root, path));
  const formatFiles = paths.filter((path) => isOxfmtOwned(path) && existing(path)).sort();
  const lintFiles = paths.filter((path) => isOxlintOwned(path) && existing(path)).sort();
  const typescriptChanged = paths.some(isTypeScriptChanged);
  const rustChanged = paths.some(isRustChanged);
  const rustFormatChanged = paths.some(isRustFormatChanged);
  const commands = [];
  const selected = [];
  const addLane = (name, overrides = {}) => {
    const scheduled = PRE_REVIEW_GATE_SCHEDULE.lanes.find((lane) => lane.name === name);
    if (!scheduled) throw new Error(`Unknown pre-review lane: ${name}`);
    selected.push({ ...scheduled, ...overrides });
  };

  if (formatFiles.length) {
    commands.push(commandSpec("pnpm", ["exec", "oxfmt", "--check", ...formatFiles]));
  }
  if (lintFiles.length) {
    commands.push(commandSpec("pnpm", ["exec", "oxlint", "--deny-warnings", ...lintFiles]));
  }
  if (typescriptChanged) commands.push(commandSpec("pnpm", ["exec", "tsgo", "--noEmit"]));
  if (rustFormatChanged) {
    commands.push(
      commandSpec("cargo", ["fmt", "--manifest-path", "src-tauri/Cargo.toml", "--", "--check"]),
    );
  }

  if (commands.length) addLane("format-lint", { commands });
  if (
    hasCoverageInputsChanged(paths, {
      root: "src",
      config: "coverage-areas.json",
      baseline: "coverage-baselines.json",
    })
  ) {
    addLane("coverage-mapping-frontend");
  }
  if (
    hasCoverageInputsChanged(paths, {
      root: "src-tauri/src",
      config: "backend-coverage-areas.json",
      baseline: "backend-coverage-baselines.json",
    })
  ) {
    addLane("coverage-mapping-backend");
  }

  const mutationFiles = mutationFilesForChanges(paths, { root, mergeBase, runGit });
  if (mutationFiles.length) {
    addLane("frontend-mutation-changed-files", {
      files: mutationFiles,
      commands: [
        commandSpec("pnpm", ["mutation:frontend", "--", "--files", mutationFiles.join(",")]),
      ],
      selfSizing: "mutation",
    });
  }
  if (rustChanged) {
    addLane("windows-clippy");
  }
  if (paths.some((path) => matches(path, FRONTEND_INPUTS))) addLane("bundle");
  return selected;
}

function selectedByBlocks(entry, blocks) {
  if (entry.always) return true;
  return entry.blocks?.some((block) => blocks.has(block)) ?? false;
}

function p0Step(name) {
  const entry = PUSH_GATE_SCHEDULE.p0.find((step) => step.name === name);
  if (!entry) throw new Error(`Push gate P0 has no step named ${JSON.stringify(name)}`);
  return entry;
}

function formatDuration(durationMs) {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function logPathFor(logDirectory, name) {
  return join(logDirectory, `${name}.log`);
}

function commandArgv(command) {
  if (typeof command !== "string") {
    return { executable: command.executable, args: command.args };
  }
  const [executable, ...args] = command.split(" ");
  return { executable, args };
}

function commandLabel(command) {
  return typeof command === "string" ? command : command.display;
}

function createTaskResult(logDirectory, name, kind, fields = {}) {
  return {
    name,
    kind,
    status: "pending",
    code: undefined,
    durationMs: 0,
    logPath: logPathFor(logDirectory, name),
    ...fields,
  };
}

function writeTaskHeader(task, command, append = task.kind === "lane-step") {
  const fd = openSync(task.logPath, append ? "a" : "w");
  try {
    if (command) writeLogChunk(fd, `$ ${command}\n`);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // Preserve the header write error if closing the descriptor also fails.
    }
    throw error;
  }
  return fd;
}

async function runCommand(
  command,
  task,
  {
    cwd,
    env,
    spawnProcess,
    signalForwarding,
    childCleanup,
    superviseProcess = defaultSuperviseChild,
    writeCapturedOutput = writeLogChunk,
  },
) {
  const { executable, args } = commandArgv(command);
  const label = commandLabel(command);
  const fd = writeTaskHeader(task, label);
  let child;
  try {
    child = spawnProcess(executable, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    const message = `spawn ${executable} failed: ${errorMessage(error)}\n`;
    const logCapture = createLogCapture(fd);
    logCapture.capture(message);
    closeSync(fd);
    return { code: 127, error, logError: logCapture.error };
  }

  const logCapture = createLogCapture(fd, writeCapturedOutput);
  const { capture } = logCapture;
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const supervisor = superviseProcess(child, {
    terminationTimeoutMs:
      task.name === "e2e" ? E2E_LANE_TERMINATION_TIMEOUT_MS : CHILD_TERMINATION_TIMEOUT_MS,
    killProcessGroup: true,
  });
  const childLabel =
    task.kind === "lane-step"
      ? `lane ${task.name} step ${label}`
      : `${task.phase} step ${task.name} (${label})`;
  signalForwarding.attach(supervisor, childLabel);

  let completion;
  try {
    completion = await Promise.race([
      supervisor.done.then((result) => ({ type: "completed", result })),
      signalForwarding.signalRequested.then(async () => {
        return { type: "interrupted", outcome: await supervisor.exitOrTerminationFailure() };
      }),
    ]);
  } catch (error) {
    // A rejected supervisor completion cannot confirm that the process group is gone.
    // Latch this across every queued lane before returning an ordinary task failure.
    childCleanup.error ??= error;
    return { code: 1, error, terminationError: error, logError: logCapture.error };
  } finally {
    closeSync(fd);
  }

  const logError = logCapture.error;
  if (completion.type === "interrupted") {
    if (completion.outcome.type === "termination-failed") {
      childCleanup.error ??= completion.outcome.error;
      return {
        code: 1,
        terminationError: completion.outcome.error,
        logError,
      };
    }
    const result = completion.outcome.result;
    return {
      ...commandResult(result),
      childExitCode: result.code,
      childSignal: result.signal,
      logError,
    };
  }
  const { result } = completion;
  const mappedResult = commandResult(result);

  if (logError && mappedResult.code === 0) {
    return {
      ...mappedResult,
      code: 1,
      error: new Error(`cannot write gate log: ${errorMessage(logError)}`),
      logError,
    };
  }
  return {
    ...mappedResult,
    childExitCode: result.code,
    childSignal: result.signal,
    logError,
  };
}

function skipTask(task, reason) {
  task.status = "skipped";
  task.reason = reason;
  task.code = undefined;
  const fd = writeTaskHeader(task);
  try {
    writeLogChunk(fd, `Skipped: ${reason}\n`);
  } finally {
    closeSync(fd);
  }
}

function blockedStartReason(context) {
  if (context.signalForwarding.requestedSignal) {
    return `cancelled by ${context.signalForwarding.requestedSignal}`;
  }
  if (context.childCleanup.error)
    return "child cleanup is unconfirmed, so no further work may start";
  return undefined;
}

function logProgress(task, phase, message) {
  const duration =
    task.startedAt === undefined ? "" : ` duration=${formatDuration(task.durationMs)}`;
  const code = task.code === undefined ? "" : ` exit=${task.code}`;
  process.stdout.write(`${phase} ${task.name}${duration}${code} ${message}\n`);
}

async function runStep(task, command, context) {
  if (blockedStartReason(context)) {
    skipTask(task, blockedStartReason(context));
    return task;
  }
  try {
    await context.beforeStep?.({
      phase: task.phase,
      name: task.name,
      command: commandLabel(command),
      index: task.commandIndex ?? 0,
    });
  } catch (error) {
    task.status = task.advisory && !task.terminationError ? "warning" : "failed";
    task.code = 1;
    task.error = error;
    const fd = writeTaskHeader(task, commandLabel(command));
    try {
      writeLogChunk(fd, `beforeStep failed: ${errorMessage(error)}\n`);
    } finally {
      closeSync(fd);
    }
    logProgress(task, "finish", `error=${errorMessage(error)}`);
    return task;
  }
  if (blockedStartReason(context)) {
    skipTask(task, blockedStartReason(context));
    return task;
  }

  task.startedAt = performance.now();
  logProgress(task, "start", `command=${commandLabel(command)}`);
  let result;
  try {
    result = await runCommand(command, task, context);
  } catch (error) {
    result = { code: 1, error };
  }
  task.durationMs = performance.now() - task.startedAt;
  task.error = result.error;
  task.logError = result.logError;
  recordChildOutcome(task, result);
  if (context.signalForwarding.requestedSignal) {
    task.code = signalExitCode(context.signalForwarding.requestedSignal);
    task.status = "interrupted";
  } else if (result.code === 0) {
    task.code = result.code;
    task.status = "passed";
  } else if (task.advisory && !result.terminationError) {
    task.code = result.code;
    task.status = "warning";
  } else {
    task.code = result.code;
    task.status = "failed";
  }
  logProgress(task, "finish", result.error ? `error=${errorMessage(result.error)}` : "");
  return task;
}

async function runLane(lane, env, context, results) {
  const task = createTaskResult(context.logDirectory, lane.name, "lane", {
    phase: "P2",
  });
  results.set(lane.name, task);
  if (blockedStartReason(context)) {
    skipTask(task, blockedStartReason(context));
    return task;
  }

  task.startedAt = performance.now();
  logProgress(task, "start", `commands=${lane.commands.length}`);
  let result = { code: 0 };
  for (const [index, command] of lane.commands.entries()) {
    if (blockedStartReason(context)) {
      result = {
        ...result,
        code: context.signalForwarding.requestedSignal
          ? signalExitCode(context.signalForwarding.requestedSignal)
          : 1,
      };
      break;
    }
    const step = createTaskResult(context.logDirectory, lane.name, "lane-step", {
      phase: "P2",
      commandIndex: index,
    });
    try {
      await context.beforeStep?.({
        phase: "P2",
        name: lane.name,
        command: commandLabel(command),
        index,
      });
      if (blockedStartReason(context)) {
        result = {
          code: context.signalForwarding.requestedSignal
            ? signalExitCode(context.signalForwarding.requestedSignal)
            : 1,
        };
        break;
      }
      result = await runCommand(command, step, { ...context, env });
    } catch (error) {
      result = { code: 1, error };
    }
    if (context.signalForwarding.requestedSignal) {
      result = {
        ...result,
        code: signalExitCode(context.signalForwarding.requestedSignal),
      };
      break;
    }
    if (result.code !== 0) {
      task.error = result.error;
      task.logError = result.logError;
      task.failedCommand = commandLabel(command);
      break;
    }
  }
  task.durationMs = performance.now() - task.startedAt;
  task.code = result.code;
  task.status = context.signalForwarding.requestedSignal
    ? "interrupted"
    : result.code === 0
      ? "passed"
      : "failed";
  task.error ??= result.error;
  task.logError ??= result.logError;
  recordChildOutcome(task, result);
  logProgress(task, "finish", result.error ? `error=${errorMessage(result.error)}` : "");
  return task;
}

function makeLaneEnvironment(env, laneName, budgetBytes, concurrentMutation, e2eSelected) {
  if (laneName === "frontend-coverage") {
    const memoryShare = concurrentMutation ? P2_VITEST_SHARE : 1;
    const cpuShare = concurrentMutation ? P2_CPU_SHARE : 1;
    const budgetAfterContainer = budgetBytes - (e2eSelected ? E2E_CONTAINER_MEMORY_BYTES : 0);
    const sharedBudget = Math.floor(budgetAfterContainer * memoryShare);
    const laneBudget =
      e2eSelected && budgetAfterContainer >= VITEST_MINIMUM_BUDGET_BYTES
        ? Math.max(sharedBudget, VITEST_MINIMUM_BUDGET_BYTES)
        : sharedBudget;
    return {
      ...env,
      GATE_MEMORY_BYTES: String(laneBudget),
      GATE_CPU_SHARE: String(cpuShare),
    };
  }
  if (laneName === "frontend-mutation") {
    const memoryShare = concurrentMutation ? P2_MUTATION_SHARE : 1;
    const cpuShare = concurrentMutation ? P2_CPU_SHARE : 1;
    const reserveContainer = e2eSelected && concurrentMutation;
    return {
      ...env,
      GATE_MEMORY_BYTES: String(
        Math.floor(
          (budgetBytes - (reserveContainer ? E2E_CONTAINER_MEMORY_BYTES : 0)) * memoryShare,
        ),
      ),
      GATE_CPU_SHARE: String(cpuShare),
    };
  }
  return env;
}

// The self-sizing Vitest and mutation lanes split CPU evenly when they share P2.
const P2_CPU_SHARE = 0.5;

function printSummary(results, logDirectory, preReviewMode = false) {
  const label = preReviewMode ? "Pre-review check" : "Push gate";
  process.stdout.write(`${label} logs: ${logDirectory}\n`);
  process.stdout.write("Task                 Status                       Exit   Duration\n");
  process.stdout.write("-------------------- ---------------------------- ------ --------\n");
  for (const task of results) {
    const status =
      task.status === "interrupted" &&
      task.childExitCode !== undefined &&
      task.childExitCode !== null &&
      task.childExitCode !== 0 &&
      !task.childSignal
        ? `interrupted; child exit ${task.childExitCode}`
        : task.status;
    process.stdout.write(
      `${task.name.padEnd(20)} ${status.padEnd(28)} ${String(task.code ?? "-").padEnd(6)} ${formatDuration(task.durationMs)}\n`,
    );
    if (task.reason) process.stdout.write(`  reason: ${task.reason}\n`);
  }
  for (const task of results) {
    if (task.status !== "failed" && task.status !== "interrupted" && task.status !== "warning") {
      continue;
    }
    process.stdout.write(`\n${task.name} log tail (${task.logPath}):\n`);
    const tail = readLogTail(task.logPath);
    process.stdout.write(tail || "(empty log)\n");
    if (!tail.endsWith("\n")) process.stdout.write("\n");
    if (task.error) process.stdout.write(`Spawn or runner error: ${errorMessage(task.error)}\n`);
    if (task.terminationError) {
      process.stdout.write(
        `Child termination failed:\n${nestedErrorMessage(task.terminationError)}\n`,
      );
    }
    if (task.logError) {
      process.stdout.write(`Gate log write failed: ${errorMessage(task.logError)}\n`);
    }
  }
  for (const task of results) {
    if (task.status !== "failed" && task.status !== "interrupted") continue;
    const prefix = preReviewMode ? "pre-review check failed" : "push gate failed";
    process.stdout.write(`${formatFailureTrailer(`${prefix}: ${task.name}`, task.logPath)}\n`);
  }
}

function firstFailure(tasks) {
  return tasks.find((task) => task.status === "failed" || task.status === "interrupted");
}

/** Run the selected push-gate schedule. Spawn, CPU count, and budget are injectable for scheduler tests. */
export async function runPushGates(
  argumentsList = [],
  {
    spawnProcess = spawn,
    superviseProcess = defaultSuperviseChild,
    cwd = process.cwd(),
    env = process.env,
    availableParallelism = defaultAvailableParallelism,
    getGateBudgetBytes = (options) => gateBudgetBytes({ env, ...options }),
    discoverChangedPaths = undefined,
    discoverChanges = discoverPreReviewChanges,
    runGit = spawnSync,
    beforeStep = undefined,
    writeCapturedOutput = writeLogChunk,
  } = {},
) {
  const args = [...argumentsList];
  const delimiterCount = args[0] === "--" ? 1 : 0;
  const preReviewMode = args[delimiterCount] === "--pre-review";
  const runnerArguments = preReviewMode ? args.slice(delimiterCount + 1) : argumentsList;
  if (preReviewMode && runnerArguments.length > 0) {
    const message = `Unknown pre-review argument ${JSON.stringify(runnerArguments[0])}. Usage: pnpm checks:pre-review`;
    process.stderr.write(`${message}\n`);
    return { exitCode: 2, results: [], logDirectory: undefined };
  }
  const parsed = preReviewMode ? { blocks: new Set() } : parsePushGateArguments(argumentsList);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    return { exitCode: 2, results: [], logDirectory: undefined };
  }
  const { blocks } = parsed;
  const logDirectory = makeLogDirectory(cwd);
  env = { ...env, [GATE_LOG_DIRECTORY_ENV]: logDirectory };
  const signalForwarding = installMultiChildSignalForwarding({
    label: preReviewMode ? "pre-review checks" : "push gate",
  });
  const resultsByName = new Map();
  const stepResults = [];
  let budgetBytes;
  let cpuCount;
  let exitCode = 0;
  let cleanupFailed = false;
  let fatalError;
  const selectedPreReviewLaneNames = new Set();
  const context = {
    cwd,
    env,
    spawnProcess,
    superviseProcess,
    signalForwarding,
    childCleanup: {},
    beforeStep,
    logDirectory,
    writeCapturedOutput,
  };
  const runSerialStep = async (entry, phase, stepEnv = env) => {
    const task = createTaskResult(logDirectory, entry.name, "step", {
      phase,
      advisory: entry.advisory === true,
    });
    stepResults.push(task);
    const finished = await runStep(task, entry.command, { ...context, env: stepEnv });
    if (!resultsByName.has(entry.name)) resultsByName.set(entry.name, finished);
    return finished;
  };
  let rustEnv;
  const getRustEnvironment = () => {
    if (blockedStartReason(context)) return env;
    rustEnv ??= rustBuildEnvironment({ env, availableParallelism, getGateBudgetBytes });
    return rustEnv;
  };

  try {
    if (preReviewMode) {
      const changes = discoverChangedPaths
        ? { paths: discoverChangedPaths({ cwd }), mergeBase: undefined }
        : discoverChanges({ cwd, runGit });
      const { paths: changedPaths, mergeBase } = changes;
      const lanes = selectPreReviewLanes(changedPaths, { root: cwd, mergeBase, runGit });
      for (const lane of lanes) selectedPreReviewLaneNames.add(lane.name);
      const laneNames = lanes.map(({ name }) => name);
      process.stdout.write(`Pre-review changed paths: ${changedPaths.length}\n`);
      process.stdout.write(
        `Pre-review selected lanes: ${laneNames.length ? laneNames.join(", ") : "none"}\n`,
      );

      const buildRequired = lanes.some((lane) => lane.requires?.includes("frontend-build"));
      let frontendBuild;
      if (buildRequired) {
        frontendBuild = await runSerialStep(PRE_REVIEW_GATE_SCHEDULE.p1[0], "P1");
      }
      const buildReady = !buildRequired || frontendBuild?.status === "passed";
      const runnableLanes = [];
      for (const lane of lanes) {
        if (!buildReady && lane.requires?.includes("frontend-build")) {
          const skipped = createTaskResult(logDirectory, lane.name, "lane", { phase: "P2" });
          skipTask(skipped, "frontend-build failed, so this dist/ consumer was skipped");
          resultsByName.set(lane.name, skipped);
        } else {
          runnableLanes.push(lane);
        }
      }

      const mutationLane = runnableLanes.find((lane) => lane.selfSizing === "mutation");
      const baseLanes = runnableLanes.filter((lane) => lane !== mutationLane);
      const rustLane = baseLanes.find((lane) => lane.rustCompilation);
      const compilerEnv = rustLane ? getRustEnvironment() : env;
      let concurrentMutation = false;
      if (mutationLane) {
        budgetBytes = getGateBudgetBytes();
        cpuCount = availableParallelism();
        concurrentMutation =
          budgetBytes >= ONE_WAVE_BYTES && cpuCount >= MIN_CONCURRENT_SELF_SIZING_CPUS;
      }
      const basePromises = baseLanes.map((lane) =>
        runLane(lane, lane.rustCompilation ? compilerEnv : env, context, resultsByName),
      );
      let mutationPromise;
      if (mutationLane && concurrentMutation) {
        const rustPromise = rustLane
          ? basePromises[baseLanes.indexOf(rustLane)]
          : Promise.resolve();
        mutationPromise = rustPromise.then(() => {
          const laneEnv = makeLaneEnvironment(
            env,
            "frontend-mutation",
            budgetBytes,
            !rustLane,
            false,
          );
          return runLane(mutationLane, laneEnv, context, resultsByName);
        });
      }
      await Promise.all(basePromises);
      if (mutationLane && !concurrentMutation) {
        const laneEnv = makeLaneEnvironment(env, "frontend-mutation", budgetBytes, false, false);
        mutationPromise = runLane(mutationLane, laneEnv, context, resultsByName);
      }
      if (mutationPromise) await mutationPromise;

      const failedStep = firstFailure(stepResults);
      if (failedStep) exitCode = failedStep.code;
      else {
        for (const lane of PRE_REVIEW_GATE_SCHEDULE.lanes) {
          const result = resultsByName.get(lane.name);
          if (result && (result.status === "failed" || result.status === "interrupted")) {
            exitCode = result.code;
            break;
          }
        }
      }
    } else {
      const guard = await runSerialStep(p0Step("mutation-guard"), "P0");
      if (guard.status !== "passed") {
        exitCode = signalForwarding.requestedSignal
          ? signalExitCode(signalForwarding.requestedSignal)
          : guard.code;
        for (const lane of PUSH_GATE_SCHEDULE.lanes) {
          if (!selectedByBlocks(lane, blocks)) continue;
          const skipped = createTaskResult(logDirectory, lane.name, "lane", { phase: "P2" });
          skipTask(skipped, "P0 mutation guard failed before any lane started");
          resultsByName.set(lane.name, skipped);
        }
      } else {
        const eviction = p0Step("rust-target-eviction");
        if (selectedByBlocks(eviction, blocks)) {
          await runSerialStep(eviction, "P0");
        }
        let setupRust;
        const setupRustEntry = p0Step("setup-rust");
        if (selectedByBlocks(setupRustEntry, blocks)) {
          setupRust = await runSerialStep(setupRustEntry, "P0");
        }

        const frontendBuildEntry = PUSH_GATE_SCHEDULE.p1[0];
        let frontendBuild;
        if (selectedByBlocks(frontendBuildEntry, blocks)) {
          frontendBuild = await runSerialStep(frontendBuildEntry, "P1");
        }

        const bindingsEntry = PUSH_GATE_SCHEDULE.p1[1];
        if (selectedByBlocks(bindingsEntry, blocks)) {
          if (setupRust?.status !== "passed") {
            const skipped = createTaskResult(logDirectory, bindingsEntry.name, "step", {
              phase: "P1",
            });
            skipTask(skipped, "setup-rust failed, so bindings:check was skipped");
            stepResults.push(skipped);
          } else if (frontendBuild?.status !== "passed") {
            const skipped = createTaskResult(logDirectory, bindingsEntry.name, "step", {
              phase: "P1",
            });
            skipTask(skipped, "frontend-build failed, so bindings:check was skipped");
            stepResults.push(skipped);
          } else {
            await runSerialStep(bindingsEntry, "P1", getRustEnvironment());
          }
        }

        const buildReady = !frontendBuild || frontendBuild.status === "passed";
        const setupReady = !setupRust || setupRust.status === "passed";
        const lanes = PUSH_GATE_SCHEDULE.lanes.filter((lane) => selectedByBlocks(lane, blocks));
        const runnableLanes = [];
        for (const lane of lanes) {
          if (lane.requires?.includes("setup-rust") && !setupReady) {
            const skipped = createTaskResult(logDirectory, lane.name, "lane", { phase: "P2" });
            skipTask(skipped, "setup-rust failed, so this Rust consumer was skipped");
            resultsByName.set(lane.name, skipped);
            continue;
          }
          if (lane.requires?.includes("frontend-build") && !buildReady) {
            const skipped = createTaskResult(logDirectory, lane.name, "lane", { phase: "P2" });
            skipTask(skipped, "frontend-build failed, so this dist/ consumer was skipped");
            resultsByName.set(lane.name, skipped);
            continue;
          }
          runnableLanes.push(lane);
        }

        if (blocks.has("frontend")) {
          budgetBytes = getGateBudgetBytes();
          cpuCount = availableParallelism();
        }
        const concurrentMutation =
          blocks.has("frontend") &&
          budgetBytes >= ONE_WAVE_BYTES &&
          cpuCount >= MIN_CONCURRENT_SELF_SIZING_CPUS;
        const laneByName = new Map(runnableLanes.map((lane) => [lane.name, lane]));
        const e2eSelected = laneByName.has("e2e");
        const rustLanes = runnableLanes.filter((lane) => lane.rustCompilation);
        const compilerEnv = rustLanes.length ? getRustEnvironment() : env;
        const baseLanes = runnableLanes.filter(
          (lane) => lane.name !== "e2e" && lane.name !== "frontend-mutation",
        );
        const p2Promises = new Map();
        // Cold native, cross-target and instrumented contexts own the same unpartitioned
        // compiler envelope. Ordinary failure releases admission after terminal cleanup.
        // Keep contract/bundle useful concurrency, then admit heavyweight frontend work.
        // Replace this ordering only after comparable cold proof supports partitioning.
        let rustDone = Promise.resolve();
        for (const lane of rustLanes) {
          rustDone = rustDone.then(() => runLane(lane, compilerEnv, context, resultsByName));
          p2Promises.set(lane.name, rustDone);
        }
        for (const lane of baseLanes) {
          if (lane.rustCompilation) continue;
          const laneEnv = lane.selfSizing
            ? makeLaneEnvironment(env, lane.name, budgetBytes, concurrentMutation, e2eSelected)
            : env;
          const lanePromise = lane.selfSizing
            ? rustDone.then(() => runLane(lane, laneEnv, context, resultsByName))
            : runLane(lane, laneEnv, context, resultsByName);
          p2Promises.set(lane.name, lanePromise);
        }

        const e2eLane = laneByName.get("e2e");
        let e2ePromise;
        if (e2eLane) {
          const dependencies = e2eLane.after.map((name) => p2Promises.get(name)).filter(Boolean);
          e2ePromise = Promise.all(dependencies).then(() =>
            runLane(e2eLane, env, context, resultsByName),
          );
        }

        const mutationLane = laneByName.get("frontend-mutation");
        let mutationPromise;
        if (mutationLane) {
          if (concurrentMutation) {
            const laneEnv = makeLaneEnvironment(
              env,
              mutationLane.name,
              budgetBytes,
              concurrentMutation,
              e2eSelected,
            );
            mutationPromise = rustDone.then(() =>
              runLane(mutationLane, laneEnv, context, resultsByName),
            );
            p2Promises.set(mutationLane.name, mutationPromise);
          } else {
            const dependencies = [
              ...baseLanes.map((lane) => p2Promises.get(lane.name)).filter(Boolean),
              ...(e2ePromise ? [e2ePromise] : []),
            ];
            mutationPromise = Promise.all(dependencies).then(() => {
              const laneEnv = makeLaneEnvironment(
                env,
                mutationLane.name,
                budgetBytes,
                false,
                e2eSelected,
              );
              return runLane(mutationLane, laneEnv, context, resultsByName);
            });
          }
        }

        await Promise.all([
          ...p2Promises.values(),
          ...(e2ePromise ? [e2ePromise] : []),
          ...(mutationPromise && !concurrentMutation ? [mutationPromise] : []),
        ]);

        const failedStep = firstFailure(stepResults);
        if (failedStep) exitCode = failedStep.code;
        else {
          for (const lane of PUSH_GATE_SCHEDULE.lanes) {
            const result = resultsByName.get(lane.name);
            if (result && (result.status === "failed" || result.status === "interrupted")) {
              exitCode = result.code;
              break;
            }
          }
        }
      }
    }
  } catch (error) {
    fatalError = error;
    process.stderr.write(
      `${preReviewMode ? "Pre-review" : "Push gate"} scheduler failed: ${errorMessage(error)}\n`,
    );
    exitCode = 1;
    try {
      await signalForwarding.terminateAll();
    } catch (cleanupError) {
      cleanupFailed = true;
      process.stderr.write(
        `Push gate child cleanup failed:\n${nestedErrorMessage(cleanupError)}\n`,
      );
    }
  } finally {
    try {
      await signalForwarding.termination;
    } catch (error) {
      cleanupFailed = true;
      process.stderr.write(`Push gate child cleanup failed:\n${nestedErrorMessage(error)}\n`);
    }
    signalForwarding.uninstall();
  }

  if (preReviewMode) {
    for (const lane of PRE_REVIEW_GATE_SCHEDULE.lanes) {
      if (resultsByName.has(lane.name)) continue;
      const skipped = createTaskResult(logDirectory, lane.name, "lane", { phase: "P2" });
      const reason = fatalError
        ? "pre-review scheduling stopped before this lane started"
        : selectedPreReviewLaneNames.has(lane.name)
          ? "cancelled before this lane started"
          : "no relevant changed paths";
      skipTask(skipped, reason);
      resultsByName.set(lane.name, skipped);
    }
  }

  if (signalForwarding.requestedSignal) {
    exitCode = signalExitCode(signalForwarding.requestedSignal);
  } else if (cleanupFailed) {
    exitCode = exitCode || 1;
  }
  const results = [...stepResults];
  for (const lane of preReviewMode ? PRE_REVIEW_GATE_SCHEDULE.lanes : PUSH_GATE_SCHEDULE.lanes) {
    const task = resultsByName.get(lane.name);
    if (task && task.kind === "lane") results.push(task);
  }
  if (fatalError) {
    const fatalTask = createTaskResult(logDirectory, "scheduler", "step", { phase: "runner" });
    fatalTask.status = "failed";
    fatalTask.code = 1;
    fatalTask.error = fatalError;
    const fd = writeTaskHeader(fatalTask);
    try {
      writeLogChunk(fd, `Scheduler error: ${errorMessage(fatalError)}\n`);
    } finally {
      closeSync(fd);
    }
    results.push(fatalTask);
  }
  printSummary(results, logDirectory, preReviewMode);
  return { exitCode, results, logDirectory, signal: signalForwarding.requestedSignal };
}

async function main() {
  const result = await runPushGates(process.argv.slice(2), { cwd: process.cwd() });
  return result.exitCode;
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`Push gate runner failed: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
