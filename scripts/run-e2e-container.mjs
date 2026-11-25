#!/usr/bin/env node
// Runs the Playwright suite inside the pinned Playwright image, so the screenshot
// assertions do not depend on which machine runs them.
//
// Why this exists: on 2026-08-29 all eight screenshot specs failed on `tuxedo-atlas`
// with 47-680 differing pixels, every one of them along glyph edges only - every box,
// icon and control aligned to the pixel. That is text rasterization, not layout: the
// snapshots had been recorded elsewhere. Re-recording natively only moves the failure to
// the next machine, and a pixel tolerance wide enough to absorb the noise also absorbs a
// genuinely changed label. One canonical environment removes the machine from the
// measurement instead of widening the gate (`tasks/decisions.md`, d-20260829-01). The
// committed snapshots need no rewrite: all eight specs pass unchanged in this image.
//
// The image tag is derived from the installed @playwright/test version rather than
// written down twice, because a container one minor behind the library is exactly the
// silent drift this script exists to prevent.
// Subprocess tests may set E2E_TEST_DOCKER_INFO_TIMEOUT_MS to shorten the real entrypoint's preflight.

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "./entrypoint.mjs";
import {
  formatNestedError,
  installMultiChildSignalForwarding,
  runPassThroughChild,
  signalExitCode,
  superviseChild,
} from "./child-supervisor.mjs";
import { playwrightImage } from "./playwright-image.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOCKER_COMMAND_TERMINATION_TIMEOUT_MS = 2_000;
// Cap container removal at ten seconds so a stuck Docker daemon cannot hang cleanup indefinitely.
export const DOCKER_REMOVE_TIMEOUT_MS = 10_000;
// Docker daemon discovery should respond within ten seconds; this also bounds preflight cleanup
// after cancellation.
export const DOCKER_INFO_TIMEOUT_MS = 10_000;

// The former 4 GiB limit (sized from a 2.3 GiB peak on 2026-09-30, quantity unrecorded)
// OOM-killed Chromium renderers (`f-20261122-01`). Three full 490-case runs at `workers: 6` on
// 2026-11-22 measured max cgroup `anon + kernel` (not `memory.peak`, which includes page cache,
// d-20261002-03) of 4317294592, 4300824576 and 4240818176 bytes (~4.02, 4.01, 3.95 GiB);
// 1.2 x 4317294592 = 5180753510 bytes (~4.83 GiB), rounded up to 5 GiB so the container keeps
// headroom above the measured anon + kernel peak while fitting comfortably inside a 7 GiB usable
// fallback scope.
export const E2E_CONTAINER_MEMORY = "5g";

// A local run loads every core (six Playwright workers plus headless Chromium), so it queues for
// one machine-wide heavy-gate slot like the Rust gate commands instead of oversubscribing the host
// beside them (f-20261125-07). The entrypoint re-runs itself under `agent-gate` with this marker
// set; the marked inner run starts the container in place. CI has no slots and no launcher.
export const E2E_GATE_LAUNCHER = "agent-gate";
export const E2E_GATE_SLOT_MARKER = "CHESSFABLE_E2E_GATE_SLOT";

/** Whether this entrypoint run should take a heavy-gate slot before starting the container. */
export function takesGateSlot(env = process.env) {
  return !env.CI && !env[E2E_GATE_SLOT_MARKER];
}
export const E2E_CONTAINER_MEMORY_BYTES = 5 * 1024 ** 3;

/**
 * The arguments handed to `playwright test` for this script's own argv tail.
 *
 * pnpm keeps a `--` its caller writes: `pnpm test:e2e:update -- --project=x` reaches this
 * script as `["--update-snapshots", "--", "--project=x"]` (pnpm 10.34.5, measured
 * 2026-09-27). Playwright reads everything after `--` as test-file filters, so the
 * `--project` and `--grep` that should have narrowed the run matched no file argument and the
 * whole suite ran — a "scoped" snapshot update that could rewrite unrelated snapshots
 * (`f-20260910-07`). The first `--` is that pnpm artefact, never a Playwright separator, so it
 * is dropped; with or without it, the options reach Playwright as options.
 */
export function playwrightArguments(forwarded) {
  const separator = forwarded.indexOf("--");
  if (separator === -1) return [...forwarded];
  return [...forwarded.slice(0, separator), ...forwarded.slice(separator + 1)];
}

function errorMessage(error) {
  return formatNestedError(error, (message, nested) =>
    nested.length ? `${message}: ${nested.join("; ")}` : message,
  );
}

function startDockerCommand(
  args,
  {
    spawnProcess = spawn,
    forwardOutput = false,
    terminationTimeoutMs = DOCKER_COMMAND_TERMINATION_TIMEOUT_MS,
    superviseProcess = superviseChild,
    timeoutMs = undefined,
    timeoutLabel = undefined,
  } = {},
) {
  const child = spawnProcess("docker", args, {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
    if (forwardOutput) process.stdout.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
    if (forwardOutput) process.stderr.write(chunk);
  });

  const supervisor = superviseProcess(child, {
    terminationTimeoutMs,
    killProcessGroup: true,
  });
  let timedOut = false;
  let timeout;
  let resolveTimeout;
  const timeoutRequested =
    timeoutMs === undefined
      ? undefined
      : new Promise((resolve) => {
          resolveTimeout = resolve;
          timeout = setTimeout(() => {
            timedOut = true;
            try {
              Promise.resolve(supervisor.terminate()).catch(() => {});
            } catch {}
            resolveTimeout();
          }, timeoutMs);
        });
  const commandLabel = timeoutLabel ?? `docker ${args[0]}`;
  const resultForExit = ({ code, signal, error }) => ({
    code: code ?? (signal ? signalExitCode(signal) : 1),
    signal,
    error:
      error ??
      (timedOut ? new Error(`${commandLabel} timed out after ${timeoutMs} ms`) : undefined),
    timedOut,
    stdout,
    stderr,
  });
  const done = (async () => {
    if (timeoutRequested === undefined) return resultForExit(await supervisor.done);

    const first = await Promise.race([
      supervisor.done.then((result) => ({ type: "exit", result })),
      timeoutRequested.then(() => ({ type: "timeout" })),
    ]);
    if (first.type === "exit") return resultForExit(first.result);

    const outcome = await supervisor.exitOrTerminationFailure();
    if (outcome.type === "termination-failed") {
      const error = new Error(
        `${commandLabel} timed out after ${timeoutMs} ms and could not be terminated: ${errorMessage(outcome.error)}`,
        { cause: outcome.error },
      );
      return { code: 1, signal: null, error, timedOut: true, stdout, stderr };
    }
    return resultForExit(outcome.result);
  })().finally(() => clearTimeout(timeout));
  return { done, supervisor };
}

function dockerError(result) {
  return result.error
    ? result.error.message.startsWith("docker ")
      ? result.error.message
      : `docker ${result.error.message}`
    : `docker exited ${result.code}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`;
}

function cancellationExitCode(reason) {
  return reason === "abort" ? 1 : signalExitCode(reason, 1);
}

async function cleanupContainer(containerName, options) {
  try {
    const result = await startDockerCommand(["rm", "-f", containerName], {
      ...options,
      timeoutMs: options.removeTimeoutMs ?? DOCKER_REMOVE_TIMEOUT_MS,
      timeoutLabel: `docker rm cleanup for e2e container ${containerName}`,
    }).done;
    if (result.code === 0) return undefined;
    if (/no such container/iu.test(`${result.stdout}\n${result.stderr}`)) return undefined;

    const detail = result.error ? errorMessage(result.error) : dockerError(result);
    return new Error(
      `Failed to stop and remove e2e container ${containerName}: ${detail}; a retry is not known to be clean.`,
    );
  } catch (error) {
    return new Error(
      `Failed to stop and remove e2e container ${containerName}: ${errorMessage(error)}; a retry is not known to be clean.`,
    );
  }
}

function reportCleanupFailure(error) {
  process.stderr.write(`${error.message}\n`);
}

/** Run one bounded e2e container and clean it after every failed or interrupted run. */
export async function runE2eContainer(
  forwarded = process.argv.slice(2),
  {
    spawnProcess = spawn,
    superviseProcess = superviseChild,
    abortSignal = undefined,
    preflightTimeoutMs = DOCKER_INFO_TIMEOUT_MS,
    removeTimeoutMs = DOCKER_REMOVE_TIMEOUT_MS,
    dockerTerminationTimeoutMs = DOCKER_COMMAND_TERMINATION_TIMEOUT_MS,
  } = {},
) {
  const cancellation = installMultiChildSignalForwarding({
    label: "e2e container launcher",
    abortSignal,
  });
  const spawnOptions = {
    spawnProcess,
    superviseProcess,
    terminationTimeoutMs: dockerTerminationTimeoutMs,
    removeTimeoutMs,
  };
  let exitCode = 0;
  let containerName;
  try {
    const preflight = startDockerCommand(["info", "--format", "{{.MemoryLimit}}"], {
      ...spawnOptions,
      timeoutMs: preflightTimeoutMs,
      timeoutLabel: "docker info preflight",
    });
    cancellation.attach(preflight.supervisor, "docker info preflight");
    const preflightOutcome = await Promise.race([
      preflight.done.then((result) => ({ result })),
      cancellation.signalRequested.then((reason) => ({ reason })),
    ]);
    if ("reason" in preflightOutcome) {
      let timer;
      const terminationError = await Promise.race([
        preflight.supervisor.exitOrTerminationFailure().then(
          (outcome) => (outcome.type === "termination-failed" ? outcome.error : undefined),
          (error) => error,
        ),
        new Promise((resolve) => {
          timer = setTimeout(
            () =>
              resolve(
                new Error(
                  `Docker info preflight cancellation timed out after ${preflightTimeoutMs} ms`,
                ),
              ),
            preflightTimeoutMs,
          );
        }),
      ]);
      clearTimeout(timer);
      if (terminationError) {
        process.stderr.write(
          `Failed to stop docker info preflight after cancellation: ${errorMessage(terminationError)}\n`,
        );
        return { exitCode: 1, containerName };
      }
      return { exitCode: cancellationExitCode(preflightOutcome.reason), containerName };
    }
    const support = preflightOutcome.result;
    if (support.error || support.code !== 0) {
      process.stderr.write(
        "docker is required for the containerized e2e run and is not available.\n" +
          "The native `pnpm test:e2e` compares against snapshots recorded in the container,\n" +
          "so it fails on font rasterization alone on most machines. Install docker, or run\n" +
          `the suite in CI.\nDocker probe error: ${dockerError(support)}\n`,
      );
      return { exitCode: 1, containerName };
    }
    if (support.stdout.trim() !== "true") {
      process.stderr.write(
        `Docker does not support memory-limited containers: docker info --format '{{.MemoryLimit}}' returned ${JSON.stringify(support.stdout.trim())}; refusing to start e2e.\n`,
      );
      return { exitCode: 1, containerName };
    }
    if (cancellation.requestedReason !== undefined) {
      return {
        exitCode: cancellationExitCode(cancellation.requestedReason),
        containerName,
      };
    }

    // Scope, stated honestly: this pins the RENDERING environment, which is what the snapshots
    // depend on. It does not make the run portable across host platforms — `node_modules` is
    // mounted from the host, so its native packages (esbuild, @swc/core, @parcel/watcher) must be
    // the ones Linux x64 needs. On a macOS or Windows host, install dependencies inside the
    // container instead of mounting a host tree built for another platform.
    if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
      process.stderr.write(
        "The containerized e2e run needs a POSIX host: it maps the container process to the\n" +
          "invoking uid/gid so nothing lands root-owned in the working tree, and process.getuid\n" +
          "is unavailable here (Windows). Run it under WSL, or in CI.\n",
      );
      return { exitCode: 1, containerName };
    }

    // Root-owned dist/, artifacts/ and snapshot files in the host tree are worse than a failed
    // run, so the container always runs as the invoking user. That user has no entry in the
    // image's /etc/passwd, hence an explicit writable HOME.
    const uid = process.getuid();
    const gid = process.getgid();
    containerName = `chessfable-e2e-${process.pid}-${randomUUID()}`;
    const run = startDockerCommand(
      [
        "run",
        "--rm",
        "--memory",
        E2E_CONTAINER_MEMORY,
        "--name",
        containerName,
        "--init",
        // Chromium exhausts the default 64 MB /dev/shm and crashes mid-suite.
        "--ipc=host",
        "--user",
        `${uid}:${gid}`,
        "--volume",
        `${projectRoot}:/work`,
        "--workdir",
        "/work",
        "--env",
        "HOME=/tmp",
        "--env",
        "CI=1",
        playwrightImage(),
        "node_modules/.bin/playwright",
        "test",
        ...playwrightArguments(forwarded),
      ],
      { ...spawnOptions, forwardOutput: true },
    );
    cancellation.attach(run.supervisor, "docker run client");

    const outcome = await Promise.race([
      run.done.then((result) => ({ result })),
      cancellation.signalRequested.then((reason) => ({ reason })),
    ]);
    let result;
    if ("reason" in outcome) {
      // Start removal as soon as cancellation is observed. It runs alongside termination of the
      // detached Docker client so the lane cannot wait for that client before asking Docker to
      // stop the container.
      const cleanupPromise = cleanupContainer(containerName, spawnOptions);
      const [runOutcome, cleanupOutcome, terminationOutcome] = await Promise.allSettled([
        run.supervisor.exitOrTerminationFailure(),
        cleanupPromise,
        cancellation.termination,
      ]);
      const cleanupError =
        cleanupOutcome.status === "fulfilled"
          ? cleanupOutcome.value
          : new Error(
              `Failed to stop and remove e2e container ${containerName}: ${errorMessage(cleanupOutcome.reason)}; a retry is not known to be clean.`,
            );
      let failed = false;
      if (cleanupError) {
        reportCleanupFailure(cleanupError);
        failed = true;
      }
      const runTerminationError =
        runOutcome.status === "fulfilled" && runOutcome.value.type === "termination-failed"
          ? runOutcome.value.error
          : undefined;
      if (terminationOutcome.status === "rejected" || runTerminationError) {
        process.stderr.write(
          `Failed to terminate e2e Docker client: ${errorMessage(terminationOutcome.reason ?? runTerminationError)}\n`,
        );
        failed = true;
      }
      if (runOutcome.status === "rejected") {
        process.stderr.write(`E2E container runner failed: ${errorMessage(runOutcome.reason)}\n`);
        failed = true;
      }
      if (failed) {
        exitCode = 1;
      } else {
        exitCode = cancellationExitCode(outcome.reason);
      }
    } else {
      result = outcome.result;
      if (result.error || result.code !== 0) exitCode = result.code || 1;
    }

    if (!("reason" in outcome) && exitCode !== 0) {
      const cleanupError = await cleanupContainer(containerName, spawnOptions);
      if (cleanupError) {
        reportCleanupFailure(cleanupError);
        exitCode = 1;
      } else if (result.error) {
        process.stderr.write(`E2E container runner failed: ${errorMessage(result.error)}\n`);
      }
    }
    return { exitCode, containerName };
  } catch (error) {
    if (containerName) {
      const cleanupError = await cleanupContainer(containerName, spawnOptions);
      if (cleanupError) {
        reportCleanupFailure(cleanupError);
        exitCode = 1;
      } else {
        process.stderr.write(`E2E container launcher failed: ${errorMessage(error)}\n`);
        exitCode = 1;
      }
      return { exitCode, containerName };
    }
    process.stderr.write(`E2E container launcher failed: ${errorMessage(error)}\n`);
    return { exitCode: 1, containerName };
  } finally {
    cancellation.uninstall();
  }
}

/**
 * Re-run this entrypoint under `agent-gate` and resolve its exit code, or `undefined` when the
 * launcher is not installed (a contributor machine), where the caller runs in place without a slot.
 */
async function runInGateSlot() {
  const { exitCode, spawnErrorCode } = await runPassThroughChild(
    E2E_GATE_LAUNCHER,
    [
      process.execPath,
      ...process.execArgv,
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { env: { ...process.env, [E2E_GATE_SLOT_MARKER]: "1" } },
  );
  if (spawnErrorCode === "ENOENT") {
    process.stderr.write(
      `${E2E_GATE_LAUNCHER} is not on PATH: running the e2e container without a heavy-gate slot.\n`,
    );
    return undefined;
  }
  return exitCode;
}

async function main() {
  if (takesGateSlot()) {
    const slotExitCode = await runInGateSlot();
    if (slotExitCode !== undefined) {
      process.exitCode = slotExitCode;
      return;
    }
  }
  const options = {};
  const testTimeout = process.env.E2E_TEST_DOCKER_INFO_TIMEOUT_MS;
  if (testTimeout !== undefined) {
    const preflightTimeoutMs = Number(testTimeout);
    if (!Number.isFinite(preflightTimeoutMs) || preflightTimeoutMs < 0) {
      throw new Error("E2E_TEST_DOCKER_INFO_TIMEOUT_MS must be a finite non-negative number.");
    }
    options.preflightTimeoutMs = preflightTimeoutMs;
  }
  const result = await runE2eContainer(process.argv.slice(2), options);
  process.exitCode = result.exitCode;
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
