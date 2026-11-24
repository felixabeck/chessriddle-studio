#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { availableParallelism as defaultAvailableParallelism } from "node:os";
import { extname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./entrypoint.mjs";
import { gateBudgetBytes, rustBuildEnvironment } from "./gate-parallelism.mjs";
import {
  CHILD_TERMINATION_TIMEOUT_MS,
  formatNestedError,
  installMultiChildSignalForwarding,
  signalExitCode,
  superviseChild as defaultSuperviseChild,
} from "./child-supervisor.mjs";
import {
  createLogCapture,
  formatFailureTrailer,
  makeLogDirectory,
  readLogTail,
  writeLogChunk,
} from "./gate-logs.mjs";
import { matches } from "./coverage-scope.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

export const GATE_LAUNCHER = "agent-gate";
export const RUST_SIZING_MODE_FLAG = "--run-rust-command";
const RUNNER_SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUST_COMMAND_FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

function commandDisplay(executable, args) {
  return [executable, ...args]
    .map((argument) => (/[\s'"\\]/u.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function commandSpec(executable, args, { heavyGateSlot = false } = {}) {
  return Object.freeze({
    executable,
    args: Object.freeze([...args]),
    display: commandDisplay(executable, args),
    heavyGateSlot,
  });
}

export function heavyGateCommand(command) {
  const [executable, ...args] = command.split(" ");
  return commandSpec(executable, args, { heavyGateSlot: true });
}

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
      command: "pnpm build-vite",
      blocks: Object.freeze(["rust", "frontend", "bindings"]),
    }),
    Object.freeze({
      name: "bindings-check",
      command: "pnpm bindings:check",
      blocks: Object.freeze(["bindings"]),
      heavyGateSlot: true,
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
      commands: Object.freeze([
        "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
        heavyGateCommand(
          "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
        ),
        heavyGateCommand("pnpm rust:windows:check"),
      ]),
      blocks: Object.freeze(["rust"]),
    }),
    Object.freeze({
      name: "bundle",
      commands: Object.freeze(["pnpm bundle:check"]),
      blocks: Object.freeze(["frontend"]),
    }),
    Object.freeze({
      name: "related-tests",
      commands: Object.freeze([]),
      blocks: Object.freeze(["rust", "frontend", "bindings"]),
    }),
  ]),
});

export const PRE_REVIEW_GATE_SCHEDULE = Object.freeze({
  p1: Object.freeze([Object.freeze({ name: "frontend-build", command: "pnpm build-vite" })]),
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
      name: "windows-clippy",
      commands: Object.freeze([heavyGateCommand("pnpm rust:windows:check")]),
      requires: Object.freeze(["frontend-build"]),
    }),
    Object.freeze({
      name: "bundle",
      commands: Object.freeze(["pnpm bundle:check"]),
      requires: Object.freeze(["frontend-build"]),
    }),
  ]),
});

const FRONTEND_INPUTS = Object.freeze([
  "src/**",
  "public/**",
  "index.html",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "vite.config.*",
  "tsconfig*.json",
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

const PUSH_GATE_USAGE =
  "Usage: pnpm gates:push -- [--rust] [--frontend] [--bindings] [--base <commit>]";

// `--base <commit>` selects related-tests paths from `merge-base HEAD <commit>` instead of
// `merge-base HEAD @{u}`. A gate proof of an already-published range (HEAD = @{u}) names the
// range's start here; without it the changed-path set is empty and related-tests runs nothing.
export function parsePushGateArguments(argumentsList) {
  const args = [...argumentsList];
  if (args[0] === "--") args.shift();
  const blocks = new Set();
  let base;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--base" || argument.startsWith("--base=")) {
      const value = argument === "--base" ? args[(index += 1)] : argument.slice("--base=".length);
      if (base !== undefined) return { error: `--base given more than once. ${PUSH_GATE_USAGE}` };
      if (!value || value.startsWith("-")) {
        return { error: `--base needs a commit. ${PUSH_GATE_USAGE}` };
      }
      base = value;
      continue;
    }
    const block = BLOCK_FLAGS[argument];
    if (!block) {
      return { error: `Unknown argument ${JSON.stringify(argument)}. ${PUSH_GATE_USAGE}` };
    }
    blocks.add(block);
  }
  return { blocks, base };
}

export function pushGateScheduleCommands(schedule = PUSH_GATE_SCHEDULE) {
  return flattenGateSchedule(schedule, ["p0", "p1", "lanes"]);
}

export function preReviewGateScheduleCommands(schedule = PRE_REVIEW_GATE_SCHEDULE) {
  return flattenGateSchedule(schedule, ["p1", "lanes"]);
}

function flattenGateSchedule(schedule, phases) {
  return phases.flatMap((phase) =>
    schedule[phase].flatMap((entry) =>
      (entry.commands ?? [entry.command]).map((command) => commandLabel(command)),
    ),
  );
}

// Git's own wording when `@{u}` cannot resolve (measured 2026-11-23 with git 2.43.0, LC_ALL=C;
// under a German locale the same failure reads "Kein Upstream-Branch ...").
const MISSING_UPSTREAM_STDERR = /no upstream configured|does not point to a branch/u;

function gitFailure(args, result, headline) {
  const detail = result.error
    ? result.error.message
    : result.stderr?.trim() || `exit status ${result.status ?? "unknown"}`;
  return new Error(`${headline}: git ${args.join(" ")} failed (${detail})`, {
    cause: result.error ?? new Error(detail),
  });
}

export function discoverChangedPaths({
  cwd = process.cwd(),
  runGit = spawnSync,
  listUntracked = (workspaceRoot) =>
    listWorkingTreeFiles({ workspaceRoot, pathspec: ".", untrackedOnly: true }),
  headline = "Cannot determine changed paths",
  base: baseRef = undefined,
} = {}) {
  const run = (args) => {
    // C locale: MISSING_UPSTREAM_STDERR matches git's untranslated wording.
    const result = runGit("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.error || result.status !== 0) {
      const missingUpstream =
        !result.error &&
        args[0] === "merge-base" &&
        baseRef === undefined &&
        MISSING_UPSTREAM_STDERR.test(result.stderr ?? "");
      throw gitFailure(args, result, missingUpstream ? `${headline}: missing upstream` : headline);
    }
    return String(result.stdout ?? "");
  };

  const mergeBaseArgs = ["merge-base", "HEAD", baseRef ?? "@{u}"];
  const base = run(mergeBaseArgs).trim();
  if (!base) {
    const reason = baseRef === undefined ? "missing upstream" : "no common history with --base";
    throw new Error(
      `${headline}: ${reason} (git ${mergeBaseArgs.join(" ")} returned no merge base)`,
    );
  }
  const tracked = run(["diff", "--name-only", "-z", base, "--"]).split("\0").filter(Boolean);
  const untracked = listUntracked(cwd);
  return { mergeBase: base, paths: [...new Set([...tracked, ...untracked])].sort() };
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

function hasCoverageInputsChanged(changedPaths, { root, config, baseline }) {
  return changedPaths.some(
    (path) => path === config || path === baseline || path.startsWith(`${root}/`),
  );
}

const RUST_FULL_SUITE_PATHS = new Set([
  "src-tauri/src/main.rs",
  "src-tauri/src/lib.rs",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "Cargo.toml",
  "Cargo.lock",
  "src-tauri/build.rs",
]);

function isVitestCoveredPath(path) {
  return (
    (path.startsWith("src/") && hasExtension(path, OXLINT_EXTENSIONS)) ||
    (path.startsWith("scripts/") && path.endsWith(".mjs") && !path.endsWith("-tests.mjs"))
  );
}

/** Build the exact Vitest and Cargo commands for the push gate's related-tests lane. */
export function buildRelatedTestCommands(changedPaths, { root = process.cwd() } = {}) {
  const existingPaths = [...new Set(changedPaths)]
    .filter((path) => existsSync(resolve(root, path)))
    .sort();
  const commands = [];

  const vitestPaths = existingPaths.filter(isVitestCoveredPath);
  if (vitestPaths.length > 0) {
    commands.push(
      commandSpec("pnpm", [
        "exec",
        "vitest",
        "related",
        "--run",
        "--passWithNoTests",
        ...vitestPaths,
      ]),
    );
  }

  let runFullRustBins = false;
  const rustFilters = new Set();
  for (const path of existingPaths) {
    if (RUST_FULL_SUITE_PATHS.has(path)) {
      runFullRustBins = true;
      continue;
    }
    const rustModule = /^src-tauri\/src\/(.+)\.rs$/u.exec(path)?.[1];
    if (!rustModule) continue;
    const modulePath = rustModule.endsWith("/mod")
      ? rustModule.slice(0, -4).replaceAll("/", "::")
      : rustModule.replaceAll("/", "::");
    if (modulePath) rustFilters.add(`${modulePath}::`);
  }

  if (runFullRustBins) {
    commands.push(
      commandSpec(
        "cargo",
        ["test", "--manifest-path", "src-tauri/Cargo.toml", "--locked", "--bins"],
        { heavyGateSlot: true },
      ),
    );
  } else if (rustFilters.size > 0) {
    commands.push(
      commandSpec(
        "cargo",
        [
          "test",
          "--manifest-path",
          "src-tauri/Cargo.toml",
          "--locked",
          "--bins",
          "--",
          ...[...rustFilters].sort(),
        ],
        { heavyGateSlot: true },
      ),
    );
  }

  return commands;
}

export function selectPreReviewLanes(
  changedPaths,
  { root = process.cwd(), schedule = PRE_REVIEW_GATE_SCHEDULE } = {},
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
    const scheduled = schedule.lanes.find((lane) => lane.name === name);
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

function isHeavyGateCommand(command) {
  return typeof command !== "string" && command.heavyGateSlot === true;
}

/** Wrap a Rust-compiling command so `agent-gate` acquires one heavy-gate slot and sizes inside that scope. */
export function wrapHeavyGateCommand(command) {
  const { executable, args } = commandArgv(command);
  return commandSpec(
    GATE_LAUNCHER,
    [process.execPath, RUNNER_SCRIPT_PATH, RUST_SIZING_MODE_FLAG, "--", executable, ...args],
    { heavyGateSlot: true },
  );
}

function createSlotAdmission() {
  let tail = Promise.resolve();
  return async function withSlot(run) {
    let release;
    const next = new Promise((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = tail.then(() => next);
    await previous;
    try {
      return await run();
    } finally {
      release();
    }
  };
}

function oneLineMessage(error) {
  return errorMessage(error).replaceAll(/[\r\n]+/gu, " ");
}

/**
 * In-scope sizing mode (`node scripts/run-push-gates.mjs --run-rust-command -- <cmd> [args...]`).
 * Sizes `CARGO_BUILD_JOBS` from the active gate scope's cgroup chain, then spawns `<cmd>` in the
 * same process group and forwards SIGINT/SIGTERM/SIGHUP until the child exits.
 */
export async function runRustCommand(
  argumentsList,
  {
    cwd = process.cwd(),
    env = process.env,
    stderr = process.stderr,
    spawnProcess = spawn,
    availableParallelism = defaultAvailableParallelism,
    getGateBudgetBytes = (options) => gateBudgetBytes({ env, stderr, ...options }),
    signalTarget = process,
  } = {},
) {
  const args = [...argumentsList];
  if (args[0] !== "--" || typeof args[1] !== "string" || args[1].length === 0) {
    stderr.write(
      `Usage: node scripts/run-push-gates.mjs ${RUST_SIZING_MODE_FLAG} -- <command> [args...]\n`,
    );
    return 2;
  }
  const executable = args[1];
  const commandArgs = args.slice(2);

  let rustEnv;
  try {
    rustEnv = rustBuildEnvironment({ env, availableParallelism, getGateBudgetBytes });
  } catch (error) {
    stderr.write(`${oneLineMessage(error)}\n`);
    return 1;
  }

  let child;
  try {
    child = spawnProcess(executable, commandArgs, {
      cwd,
      env: rustEnv,
      stdio: "inherit",
      detached: false,
    });
  } catch (error) {
    stderr.write(`spawn ${executable} failed: ${oneLineMessage(error)}\n`);
    return 127;
  }

  const forwardSignal = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        stderr.write(`Failed to forward ${signal} to ${executable}: ${oneLineMessage(error)}\n`);
      }
    }
  };
  const signalListeners = RUST_COMMAND_FORWARDED_SIGNALS.map((signal) => {
    const listener = () => forwardSignal(signal);
    signalTarget.on(signal, listener);
    return [signal, listener];
  });

  try {
    return await new Promise((resolveExit) => {
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        resolveExit(code);
      };
      child.once("error", (error) => {
        stderr.write(`spawn ${executable} failed: ${oneLineMessage(error)}\n`);
        finish(127);
      });
      child.once("close", (code, signal) => {
        if (signal !== null) {
          const exitCode = signalExitCode(signal);
          stderr.write(`${executable} terminated by signal ${signal} (exit ${exitCode})\n`);
          finish(exitCode);
          return;
        }
        finish(code ?? 1);
      });
    });
  } finally {
    for (const [signal, listener] of signalListeners) {
      signalTarget.off(signal, listener);
    }
  }
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
    terminationTimeoutMs: CHILD_TERMINATION_TIMEOUT_MS,
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
  if (context.firstRed.name) return `${context.firstRed.name} failed, so no further gate started`;
  return undefined;
}

function latchFailure(task, context) {
  if (task.status === "failed") context.firstRed.name ??= task.name;
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
  const heavy = isHeavyGateCommand(command);
  const effectiveCommand = heavy ? wrapHeavyGateCommand(command) : command;
  try {
    await context.beforeStep?.({
      phase: task.phase,
      name: task.name,
      command: commandLabel(effectiveCommand),
      index: task.commandIndex ?? 0,
    });
  } catch (error) {
    task.status = task.advisory && !task.terminationError ? "warning" : "failed";
    latchFailure(task, context);
    task.code = 1;
    task.error = error;
    const fd = writeTaskHeader(task, commandLabel(effectiveCommand));
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

  const execute = async () => {
    if (blockedStartReason(context)) {
      skipTask(task, blockedStartReason(context));
      return task;
    }
    task.startedAt = performance.now();
    logProgress(task, "start", `command=${commandLabel(effectiveCommand)}`);
    let result;
    try {
      result = await runCommand(effectiveCommand, task, context);
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
    latchFailure(task, context);
    logProgress(task, "finish", result.error ? `error=${errorMessage(result.error)}` : "");
    return task;
  };
  return heavy ? context.slotAdmission(execute) : execute();
}

async function runLane(lane, context, results) {
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
  let commandsStarted = 0;
  const stopAtBoundary = () => {
    const reason = blockedStartReason(context);
    if (!reason) return false;
    if (!context.signalForwarding.requestedSignal && !context.childCleanup.error) {
      if (commandsStarted) task.status = "stopped";
      else skipTask(task, reason);
      task.reason = reason;
      result = { ...result, code: undefined };
    } else {
      result = {
        ...result,
        code: context.signalForwarding.requestedSignal
          ? signalExitCode(context.signalForwarding.requestedSignal)
          : 1,
      };
    }
    return true;
  };
  for (const [index, command] of lane.commands.entries()) {
    if (stopAtBoundary()) break;
    const heavy = isHeavyGateCommand(command);
    const effectiveCommand = heavy ? wrapHeavyGateCommand(command) : command;
    const step = createTaskResult(context.logDirectory, lane.name, "lane-step", {
      phase: "P2",
      commandIndex: index,
    });
    let stoppedInSlot = false;
    try {
      await context.beforeStep?.({
        phase: "P2",
        name: lane.name,
        command: commandLabel(effectiveCommand),
        index,
      });
      if (stopAtBoundary()) break;
      const execute = async () => {
        if (stopAtBoundary()) return { stopped: true };
        commandsStarted += 1;
        let commandOutcome;
        try {
          commandOutcome = await runCommand(effectiveCommand, step, context);
        } catch (error) {
          commandOutcome = { code: 1, error };
        }
        if (!context.signalForwarding.requestedSignal && commandOutcome.code !== 0) {
          context.firstRed.name ??= lane.name;
        }
        return { stopped: false, result: commandOutcome };
      };
      const outcome = heavy ? await context.slotAdmission(execute) : await execute();
      if (outcome.stopped) {
        stoppedInSlot = true;
      } else {
        result = outcome.result;
      }
    } catch (error) {
      result = { code: 1, error };
    }
    if (stoppedInSlot) break;
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
      task.failedCommand = commandLabel(effectiveCommand);
      break;
    }
  }
  task.durationMs = performance.now() - task.startedAt;
  task.code = result.code;
  if (task.status !== "stopped" && task.status !== "skipped") {
    task.status = context.signalForwarding.requestedSignal
      ? "interrupted"
      : result.code === 0
        ? "passed"
        : "failed";
  }
  latchFailure(task, context);
  task.error ??= result.error;
  task.logError ??= result.logError;
  recordChildOutcome(task, result);
  logProgress(task, "finish", result.error ? `error=${errorMessage(result.error)}` : "");
  return task;
}

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

/** Run the selected push-gate schedule. Spawn and schedule are injectable for scheduler tests. */
export async function runPushGates(
  argumentsList = [],
  {
    spawnProcess = spawn,
    superviseProcess = defaultSuperviseChild,
    cwd = process.cwd(),
    env = process.env,
    discoverChangedPaths: customDiscoverChangedPaths = undefined,
    discoverChanges = discoverChangedPaths,
    runGit = spawnSync,
    beforeStep = undefined,
    writeCapturedOutput = writeLogChunk,
    schedule = undefined,
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
  const { blocks, base } = parsed;
  const activeSchedule =
    schedule ?? (preReviewMode ? PRE_REVIEW_GATE_SCHEDULE : PUSH_GATE_SCHEDULE);
  const logDirectory = makeLogDirectory(cwd);
  const signalForwarding = installMultiChildSignalForwarding({
    label: preReviewMode ? "pre-review checks" : "push gate",
  });
  const resultsByName = new Map();
  const stepResults = [];
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
    firstRed: {},
    slotAdmission: createSlotAdmission(),
    beforeStep,
    logDirectory,
    writeCapturedOutput,
  };
  const runSerialStep = async (entry, phase) => {
    const task = createTaskResult(logDirectory, entry.name, "step", {
      phase,
      advisory: entry.advisory === true,
    });
    stepResults.push(task);
    const stepCommand = entry.heavyGateSlot ? heavyGateCommand(entry.command) : entry.command;
    const finished = await runStep(task, stepCommand, context);
    if (!resultsByName.has(entry.name)) resultsByName.set(entry.name, finished);
    return finished;
  };

  try {
    if (preReviewMode) {
      const changes = customDiscoverChangedPaths
        ? { paths: customDiscoverChangedPaths({ cwd }), mergeBase: undefined }
        : discoverChanges({ cwd, runGit, headline: "Cannot determine pre-review changed paths" });
      const { paths: changedPaths } = changes;
      const lanes = selectPreReviewLanes(changedPaths, { root: cwd, schedule: activeSchedule });
      for (const lane of lanes) selectedPreReviewLaneNames.add(lane.name);
      const laneNames = lanes.map(({ name }) => name);
      process.stdout.write(`Pre-review changed paths: ${changedPaths.length}\n`);
      process.stdout.write(
        `Pre-review selected lanes: ${laneNames.length ? laneNames.join(", ") : "none"}\n`,
      );

      const buildRequired = lanes.some((lane) => lane.requires?.includes("frontend-build"));
      if (buildRequired) {
        await runSerialStep(activeSchedule.p1[0], "P1");
      }
      await Promise.all(lanes.map((lane) => runLane(lane, context, resultsByName)));

      const failedStep = firstFailure(stepResults);
      if (failedStep) exitCode = failedStep.code;
      else {
        for (const lane of activeSchedule.lanes) {
          const result = resultsByName.get(lane.name);
          if (result && (result.status === "failed" || result.status === "interrupted")) {
            exitCode = result.code;
            break;
          }
        }
      }
    } else {
      for (const entry of activeSchedule.p0 ?? []) {
        if (selectedByBlocks(entry, blocks)) await runSerialStep(entry, "P0");
      }
      for (const entry of activeSchedule.p1 ?? []) {
        if (!selectedByBlocks(entry, blocks)) continue;
        await runSerialStep(entry, "P1");
      }
      const runnableLanes = activeSchedule.lanes.filter((lane) => selectedByBlocks(lane, blocks));
      const laneByName = new Map(runnableLanes.map((lane) => [lane.name, lane]));
      const lightLanes = runnableLanes.filter((lane) => lane.name !== "related-tests");

      // Finish every selected light lane before starting related-tests (fail-fast order and
      // exclusive Rust admission: no other Rust compile runs beside related-tests).
      await Promise.all(lightLanes.map((lane) => runLane(lane, context, resultsByName)));

      const relatedTestsLane = laneByName.get("related-tests");
      if (relatedTestsLane) {
        if (blockedStartReason(context)) {
          await runLane(relatedTestsLane, context, resultsByName);
        } else {
          let changedPaths;
          try {
            const changes = customDiscoverChangedPaths
              ? { paths: customDiscoverChangedPaths({ cwd, base }), mergeBase: undefined }
              : discoverChanges({
                  cwd,
                  runGit,
                  headline: "Cannot determine related-tests changed paths",
                  base,
                });
            // An empty set means the range to prove was never selected (HEAD = @{u} after a
            // push), not that nothing needs testing: refuse rather than pass with zero commands.
            if (changes.paths.length === 0) {
              throw new Error(
                base === undefined
                  ? "No changed paths since merge-base HEAD @{u}: HEAD is already published. Pass --base <commit> naming the start of the range to prove."
                  : `No changed paths since merge-base HEAD ${base}: the range to prove is empty.`,
              );
            }
            changedPaths = changes.paths;
          } catch (error) {
            const failed = createTaskResult(logDirectory, relatedTestsLane.name, "lane", {
              phase: "P2",
            });
            resultsByName.set(relatedTestsLane.name, failed);
            failed.status = "failed";
            failed.code = 1;
            failed.error = error;
            latchFailure(failed, context);
            const fd = writeTaskHeader(failed);
            try {
              writeLogChunk(fd, `${errorMessage(error)}\n`);
            } finally {
              closeSync(fd);
            }
            logProgress(failed, "finish", `error=${errorMessage(error)}`);
          }
          if (changedPaths !== undefined) {
            const relatedCommands = buildRelatedTestCommands(changedPaths, { root: cwd });
            if (relatedCommands.length === 0) {
              const empty = createTaskResult(logDirectory, relatedTestsLane.name, "lane", {
                phase: "P2",
              });
              resultsByName.set(relatedTestsLane.name, empty);
              empty.status = "passed";
              empty.code = 0;
              const fd = writeTaskHeader(empty);
              try {
                writeLogChunk(fd, "No Vitest-covered or Rust paths changed.\n");
              } finally {
                closeSync(fd);
              }
              logProgress(empty, "finish", "commands=0");
            } else {
              await runLane(
                { ...relatedTestsLane, commands: relatedCommands },
                context,
                resultsByName,
              );
            }
          }
        }
      }

      const failedStep = firstFailure(stepResults);
      if (failedStep) exitCode = failedStep.code;
      else {
        for (const lane of activeSchedule.lanes) {
          const result = resultsByName.get(lane.name);
          if (result && (result.status === "failed" || result.status === "interrupted")) {
            exitCode = result.code;
            break;
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
    for (const lane of activeSchedule.lanes) {
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
  for (const lane of activeSchedule.lanes) {
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
  const args = process.argv.slice(2);
  if (args[0] === RUST_SIZING_MODE_FLAG) {
    return runRustCommand(args.slice(1), { cwd: process.cwd() });
  }
  const result = await runPushGates(args, { cwd: process.cwd() });
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
