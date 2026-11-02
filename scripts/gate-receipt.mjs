#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  CHILD_TERMINATION_TIMEOUT_MS,
  E2E_LANE_TERMINATION_TIMEOUT_MS,
  installMultiChildSignalForwarding,
  signalExitCode,
  superviseChild,
} from "./child-supervisor.mjs";
import {
  createLogCapture,
  formatFailureTrailer,
  obtainLogDirectory,
  readLogTail,
  transcriptFileName,
  writeLogChunk,
} from "./gate-logs.mjs";
import { isEntrypoint } from "./entrypoint.mjs";
import { playwrightImage } from "./playwright-image.mjs";
import { RUST_COVERAGE_TOOLCHAIN } from "./toolchain-versions.mjs";

export const GATES = Object.freeze({
  "backend-test": "cargo test --manifest-path src-tauri/Cargo.toml --all-targets",
  "backend-coverage": "pnpm test:coverage:backend && pnpm coverage:backend:check",
  "frontend-coverage": "pnpm test:coverage && pnpm coverage:frontend:check",
  "frontend-mutation": "pnpm mutation:frontend",
  "frontend-build": "pnpm build-vite",
  "e2e-container": "pnpm test:e2e:container",
  "tauri-build": "pnpm build",
});

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECEIPT_DIRECTORY = ".gate-receipts";
const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const EXIT_MISS = 1;
const EXIT_USAGE = 2;
const EXIT_PROOF_NOT_ESTABLISHED = 3;
const GIT_ENVIRONMENT_KEYS = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

export const REQUIRED_TOOLS = Object.freeze({
  "backend-test": ["rustc", "cargo"],
  "backend-coverage": ["rustc", "cargo", "nightly", "cargo-llvm-cov", "node", "pnpm"],
  "frontend-coverage": ["node", "pnpm"],
  "frontend-mutation": ["node", "pnpm", "stryker"],
  "frontend-build": ["node", "pnpm"],
  "e2e-container": ["node", "pnpm", "playwright-image"],
  "tauri-build": ["rustc", "cargo", "node", "pnpm"],
});

function gitEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of GIT_ENVIRONMENT_KEYS) delete environment[key];
  return { ...environment, ...overrides };
}

function capture(command, argumentsList, cwd) {
  const result = spawnSync(command, argumentsList, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
  });
  if (result.error || result.status !== 0) return undefined;
  const output = result.stdout?.trim();
  return output || undefined;
}

export const TOOL_PROBES = Object.freeze({
  rustc: (repoRoot) => capture("rustc", ["--version"], repoRoot),
  cargo: (repoRoot) => capture("cargo", ["--version"], repoRoot),
  nightly: (repoRoot) => {
    const version = capture(
      "rustup",
      ["run", RUST_COVERAGE_TOOLCHAIN, "rustc", "--version"],
      repoRoot,
    );
    return version ? `${RUST_COVERAGE_TOOLCHAIN}\n${version}` : undefined;
  },
  "cargo-llvm-cov": (repoRoot) => capture("cargo", ["llvm-cov", "--version"], repoRoot),
  node: (repoRoot) => capture("node", ["--version"], repoRoot),
  pnpm: (repoRoot) => capture("pnpm", ["--version"], repoRoot),
  stryker: (repoRoot) => {
    try {
      const packageJson = JSON.parse(
        readFileSync(join(repoRoot, "node_modules", "@stryker-mutator", "core", "package.json")),
      );
      return typeof packageJson.version === "string" ? packageJson.version : undefined;
    } catch {
      return undefined;
    }
  },
  "playwright-image": () => {
    try {
      return playwrightImage();
    } catch {
      return undefined;
    }
  },
});

function toolchainFingerprint(gate, repoRoot) {
  const fingerprint = {};
  for (const name of REQUIRED_TOOLS[gate]) {
    const probe = TOOL_PROBES[name];
    if (!probe) return undefined;
    const value = probe(repoRoot);
    if (!value) return undefined;
    fingerprint[name] = value;
  }
  return fingerprint;
}

function git(repoRoot, argumentsList, environment = gitEnvironment()) {
  const result = spawnSync("git", ["-C", repoRoot, ...argumentsList], {
    encoding: "utf8",
    env: environment,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.trim();
}

// Frontend coverage runs check-ipc-command-consumers.test.mjs, which parses real tasks/findings.md.
const EXACT_TREE_GATES = ["frontend-coverage"];

function treeFingerprint(repoRoot, gate) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "gate-receipt-index-"));
  try {
    const indexName = git(repoRoot, ["rev-parse", "--git-path", "index"]);
    if (!indexName) return undefined;
    const indexPath = resolve(repoRoot, indexName);
    const temporaryIndex = join(temporaryDirectory, "index");
    copyFileSync(indexPath, temporaryIndex);
    const environment = gitEnvironment({ GIT_INDEX_FILE: temporaryIndex });
    if (git(repoRoot, ["add", "-A"], environment) === undefined) return undefined;
    if (
      !EXACT_TREE_GATES.includes(gate) &&
      git(
        repoRoot,
        ["rm", "-r", "--cached", "-q", "--ignore-unmatch", "--", "tasks"],
        environment,
      ) === undefined
    )
      return undefined;
    return git(repoRoot, ["write-tree"], environment);
  } catch {
    return undefined;
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function treeState(repoRoot, gate) {
  try {
    const statusBefore = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (statusBefore === undefined) return undefined;
    const tree = treeFingerprint(repoRoot, gate);
    if (!tree) return undefined;
    const statusAfter = git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (statusAfter === undefined) return undefined;
    return { clean: statusBefore === "" && statusAfter === "", tree };
  } catch {
    return undefined;
  }
}

function trackedFileMetadata(repoRoot) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z"], {
    encoding: "utf8",
    env: gitEnvironment(),
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    const paths = result.stdout.split("\0");
    if (paths.at(-1) === "") paths.pop();
    return JSON.stringify(
      paths.map((path) => {
        try {
          const stats = lstatSync(join(repoRoot, path), { bigint: true });
          return [path, stats.size.toString(), stats.mtimeNs.toString()];
        } catch (error) {
          if (error?.code === "ENOENT") return [path, null, null];
          throw error;
        }
      }),
    );
  } catch {
    return undefined;
  }
}

function receiptPath(repoRoot, gate) {
  return join(repoRoot, RECEIPT_DIRECTORY, `${gate}.json`);
}

function removeReceipt(repoRoot, gate) {
  try {
    unlinkSync(receiptPath(repoRoot, gate));
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

function readReceipt(repoRoot, gate) {
  try {
    const payload = JSON.parse(readFileSync(receiptPath(repoRoot, gate), "utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function writeReceipt(repoRoot, gate, payload) {
  const directory = join(repoRoot, RECEIPT_DIRECTORY);
  const path = receiptPath(repoRoot, gate);
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    return true;
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may never have been created.
    }
    return false;
  }
}

function receiptStatus({ gate, repoRoot, now, ttlMs, fingerprintToolchain, command }) {
  const state = treeState(repoRoot, gate);
  if (!state) return { hit: false, reason: "tree fingerprint unavailable" };
  if (!state.clean) return { hit: false, reason: "working tree is dirty" };
  const toolchain = fingerprintToolchain(gate, repoRoot);
  if (!toolchain) return { hit: false, reason: "toolchain fingerprint unavailable" };
  const payload = readReceipt(repoRoot, gate);
  if (!payload) return { hit: false, reason: "receipt is absent or unreadable" };
  const createdAt = Date.parse(payload.createdAt);
  const age = now() - createdAt;
  if (
    payload.schemaVersion !== SCHEMA_VERSION ||
    payload.gate !== gate ||
    payload.tree !== state.tree ||
    payload.command !== command ||
    payload.platform !== `${platform()}-${arch()}-${release()}` ||
    JSON.stringify(payload.toolchain) !== JSON.stringify(toolchain) ||
    !Number.isFinite(createdAt) ||
    age < 0 ||
    age > ttlMs
  ) {
    return { hit: false, reason: "receipt does not match the current receipt tree" };
  }
  const finalState = treeState(repoRoot, gate);
  if (!finalState?.clean || finalState.tree !== state.tree) {
    return { hit: false, reason: "tree changed while the receipt was checked" };
  }
  return { hit: true, reason: `receipt tree verified ${Math.floor(age / 60000)} minutes ago` };
}

// A caller's closed pipe must never cancel the gate or its retained transcript. Keep the
// error listener until every write callback and its subsequent error event have settled.
function forwardTo(stream) {
  let stopped = false;
  let pending = 0;
  let resolveDrained;
  const onError = () => {
    stopped = true;
  };
  stream.on("error", onError);
  return {
    write(chunk) {
      if (stopped) return;
      pending += 1;
      const settled = (error) => {
        if (error) stopped = true;
        pending -= 1;
        if (pending === 0) resolveDrained?.();
      };
      try {
        stream.write(chunk, settled);
      } catch (error) {
        settled(error);
      }
    },
    async flush() {
      if (pending > 0) await new Promise((resolve) => (resolveDrained = resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
    async dispose() {
      await this.flush();
      stream.off("error", onError);
    },
  };
}

async function runGate({
  gate,
  repoRoot,
  now,
  fingerprintToolchain,
  command,
  output,
  env,
  forwardedStdout,
  forwardedStderr,
  writeCapturedOutput,
}) {
  if (!removeReceipt(repoRoot, gate)) {
    output.error(`gate receipt unavailable: ${gate} — stale receipt could not be removed`);
    return EXIT_USAGE;
  }

  let transcriptPath;
  let fd;
  try {
    const directory = obtainLogDirectory(repoRoot, {
      env,
      warn: (message) => output.error(message),
    });
    transcriptPath = join(directory, transcriptFileName(gate));
    fd = openSync(transcriptPath, "wx", 0o600);
  } catch (error) {
    output.error(`gate transcript unavailable: ${gate} — ${error.message}`);
    return EXIT_USAGE;
  }

  const stdout = forwardTo(forwardedStdout);
  const stderr = forwardTo(forwardedStderr);
  if (output === console) {
    output = {
      log: (message) => stdout.write(`${message}\n`),
      error: (message) => stderr.write(`${message}\n`),
    };
  }
  const logCapture = createLogCapture(fd, writeCapturedOutput);
  const { capture } = logCapture;
  try {
    const before = treeState(repoRoot, gate);
    const toolchain = fingerprintToolchain(gate, repoRoot);
    const metadataBefore = trackedFileMetadata(repoRoot);
    output.log(`gate running: ${gate}`);
    output.log(`  command: ${command}`);
    const startedAt = performance.now();
    capture(
      `gate: ${gate}\ncommand: ${command}\ntree: ${before?.tree ?? "unavailable"}\nstarted: ${new Date(now()).toISOString()}\n\n`,
    );
    const signalForwarding = installMultiChildSignalForwarding({ label: "gate receipt" });
    let result;
    let runnerError;
    let supervisor;
    let child;
    const onStdout = (chunk) => {
      capture(chunk);
      stdout.write(chunk);
    };
    const onStderr = (chunk) => {
      capture(chunk);
      stderr.write(chunk);
    };
    try {
      child = spawn(command, {
        cwd: repoRoot,
        env: Object.fromEntries(
          Object.entries(env).filter(([key]) => !key.startsWith("FRONTEND_MUTATION_")),
        ),
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      supervisor = superviseChild(child, {
        killProcessGroup: false,
        terminationTimeoutMs:
          gate === "e2e-container" ? E2E_LANE_TERMINATION_TIMEOUT_MS : CHILD_TERMINATION_TIMEOUT_MS,
      });
      signalForwarding.attach(supervisor, gate);
      const completion = await Promise.race([
        supervisor.done.then((outcome) => ({ type: "exit", result: outcome })),
        signalForwarding.signalRequested.then(() => supervisor.exitOrTerminationFailure()),
      ]);
      if (completion.type === "termination-failed") runnerError = completion.error;
      else result = completion.result;
    } catch (error) {
      runnerError = error;
      if (supervisor) {
        try {
          await signalForwarding.terminateAll();
        } catch (cleanupError) {
          runnerError = cleanupError;
        }
      }
    } finally {
      try {
        await signalForwarding.termination;
      } catch (error) {
        runnerError ??= error;
      }
      signalForwarding.uninstall();
      child?.stdout?.off("data", onStdout);
      child?.stderr?.off("data", onStderr);
    }
    const signal = signalForwarding.requestedSignal ?? result?.signal;
    let status = signalForwarding.requestedSignal
      ? signalExitCode(signalForwarding.requestedSignal)
      : result?.error || !result
        ? EXIT_USAGE
        : (result.code ?? (signal ? signalExitCode(signal) : EXIT_USAGE));
    if (runnerError && status === 0) status = 1;
    capture(
      `\nexit: ${status}${signal ? `, signal ${signal}` : ""}\nduration: ${(performance.now() - startedAt).toFixed(1)} ms\n`,
    );
    let logError = logCapture.error;
    try {
      closeSync(fd);
    } catch (error) {
      logError ??= error;
    }
    fd = undefined;
    if (logError && status === 0) status = 1;
    const fail = async (exitStatus, failureSignal = signal, errors = []) => {
      await Promise.all([stdout.flush(), stderr.flush()]);
      output.error(readLogTail(transcriptPath));
      const detail = errors.length
        ? ` — ${errors.map((error) => error.message ?? String(error)).join("; ")}`
        : "";
      output.error(
        formatFailureTrailer(
          `gate failed: ${gate} (exit ${exitStatus}${failureSignal ? `, signal ${failureSignal}` : ""})${detail}`,
          transcriptPath,
          "transcript",
        ),
      );
      return exitStatus;
    };
    if (status !== 0) {
      const errors = [result?.error, runnerError, logError].filter(Boolean);
      return await fail(status, signal, errors);
    }

    const refuseReceipt = async (reason) => {
      await Promise.all([stdout.flush(), stderr.flush()]);
      output.error(
        formatFailureTrailer(
          `gate receipt refused: ${gate} — ${reason}`,
          transcriptPath,
          "transcript",
        ),
      );
      return EXIT_PROOF_NOT_ESTABLISHED;
    };
    output.log(`gate passed: ${gate}`);
    output.log(`gate transcript: ${transcriptPath}`);
    const after = treeState(repoRoot, gate);
    const metadataAfter = trackedFileMetadata(repoRoot);
    // Tree hashes detect persistent content changes; tracked-file size/mtime_ns snapshots also
    // detect a tracked file rewritten and restored when the filesystem records a new mtime.
    // Residual window: a mutation and revert entirely between the two samples, within one mtime
    // granularity tick, can remain undetected.
    if (!before || !after || !metadataBefore || !metadataAfter) {
      return await refuseReceipt("could not observe the tree");
    }
    if (before.tree !== after.tree || metadataBefore !== metadataAfter) {
      return await refuseReceipt("tree changed during the gate");
    }
    if (!before.clean || !after.clean) {
      output.log(`gate receipt not recorded: ${gate} — working tree is dirty`);
      return 0;
    }
    if (!toolchain) {
      output.log(`gate receipt not recorded: ${gate} — toolchain fingerprint unavailable`);
      return 0;
    }

    const finalState = treeState(repoRoot, gate);
    if (!finalState?.clean || finalState.tree !== before.tree) {
      return await refuseReceipt("tree changed before receipt writing");
    }
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      gate,
      tree: before.tree,
      command,
      platform: `${platform()}-${arch()}-${release()}`,
      toolchain,
      createdAt: new Date(now()).toISOString(),
    };
    if (!writeReceipt(repoRoot, gate, payload)) {
      output.log(`gate passed but receipt could not be written: ${gate}`);
      return 0;
    }
    output.log(`gate receipt recorded: ${gate} (${before.tree.slice(0, 12)})`);
    return 0;
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      await Promise.all([stdout.dispose(), stderr.dispose()]);
    }
  }
}

export async function executeAction({
  action,
  gate,
  repoRoot = projectRoot,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  fingerprintToolchain = toolchainFingerprint,
  command = GATES[gate],
  output = console,
  env = process.env,
  forwardedStdout = process.stdout,
  forwardedStderr = process.stderr,
  writeCapturedOutput = writeLogChunk,
}) {
  if (!Object.hasOwn(GATES, gate) || !["check", "ensure", "run"].includes(action)) {
    output.error("Usage: gate-receipt.mjs <check|ensure|run> <gate>");
    return EXIT_USAGE;
  }
  if (action !== "run") {
    const status = receiptStatus({
      gate,
      repoRoot,
      now,
      ttlMs,
      fingerprintToolchain,
      command,
    });
    output.log(`gate receipt ${status.hit ? "valid" : "miss"}: ${gate} — ${status.reason}`);
    if (status.hit) return 0;
    if (action === "check") return EXIT_MISS;
  }
  return runGate({
    gate,
    repoRoot,
    now,
    fingerprintToolchain,
    command,
    output,
    env,
    forwardedStdout,
    forwardedStderr,
    writeCapturedOutput,
  });
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = await executeAction({ action: process.argv[2], gate: process.argv[3] });
}
