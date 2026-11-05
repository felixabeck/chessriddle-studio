import { readFileSync as defaultReadFileSync, statSync as defaultStatSync } from "node:fs";
import { availableParallelism as defaultAvailableParallelism } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";
const PROCESS_CGROUP_FILE = "/proc/self/cgroup";

// In a session scope (plain vitest), reserve 1 GiB for the agent sharing the cgroup
// (0.32 GB RSS measured 2026-09-29) plus headroom. Inside the agent-gate scope, it covers
// the scheduler (`node scripts/run-push-gates.mjs`), per-lane pnpm and sh parents, and
// gate-receipt processes, which no worker count sizes (d-20261002-03).
// On 2026-10-02 the all-blocks gate completed
// in a 28 GiB agent-gate scope without observed OOM events or swap use; that checks the
// whole run, not this reserve on its own.
export const UNSIZED_PROCESS_RESERVE_BYTES = 1024 * 1024 * 1024;

// Historical 2026-09-30/10-02 per-runner peak RSS was 0.80–1.13 GiB (1.2 GiB charge). Runners
// grow during a run; maxTestRunnerReuse 40 still used 6.53 GiB at 8. That 1.2 GiB figure failed
// after the suite grew to ~4300 tests (f-20261022-05): ordinary runs admitted 7 runners at
// memory.max 11596410880 and 13 at 19327352832 and were OOM-killed. Re-measured 2026-10-31 at
// e9ebec04 inside agent-gate (scope cap 11596410880, concurrency 4): max runner VmHWM
// tree-path 2002472960 (4313 tests), workspace-storage 2000359424 (3886),
// annotate-comment 1893363712 (1197), game-practice 1111965696 (343). d-20261031-06 applies
// 25% headroom: 2002472960 × 1.25 = 2503091200 (2387.05 MiB), rounded up to the next whole
// 64 MiB: 2432 MiB (38 × 64 MiB).
export const STRYKER_RUNNER_BYTES = 2432 * 1024 * 1024;

// The Stryker parent measured 0.34–0.39 GiB RSS plus a 0.11 GiB helper process during the
// 2026-09-30 dry run; 640 MiB covers both with headroom. Re-measured 2026-10-31: max parent
// VmHWM workspace-storage 506413056, annotate-comment 499204096 (+4.7 MB transient ps),
// tree-path 394031104, game-practice 393859072. d-20261031-06 applies 25% headroom:
// 506413056 × 1.25 = 633016320 (603.7 MiB), rounded up to the next whole 64 MiB: 640 MiB,
// the existing value.
export const STRYKER_PARENT_BYTES = 640 * 1024 * 1024;

// On 2026-09-30 in the 8 GiB agent scope, `vitest run --coverage.enabled` used 1.88 GiB above
// idle at 4 workers, 3.23 GiB at 12, and 4.58 GiB at 20: about 173 MiB per worker. 256 MiB keeps
// headroom above that measured slope.
export const VITEST_WORKER_BYTES = 256 * 1024 * 1024;

// The same 2026-09-30 Vitest measurements imply about 1.20 GiB of base memory; 1.5 GiB keeps
// headroom above that measured base.
export const VITEST_BASE_BYTES = 1536 * 1024 * 1024;
export const VITEST_MINIMUM_BUDGET_BYTES = VITEST_BASE_BYTES + VITEST_WORKER_BYTES;

// f-20261029-16, measured 2026-11-06 on AMD Ryzen AI 9 365 (10 physical cores, SMT, 20 logical):
// unloaded --maxWorkers=20: wall 69.2 s, slowest app test 2651 ms, 111 tests > 1 s;
// unloaded --maxWorkers=10: wall 62.8 s, slowest app test 1591 ms, 1 test > 2 s;
// 20 busy-loop processes --maxWorkers=20: 3 tests timed out at 5000 ms
// (workspace, EnginesPage.publication, Puzzles);
// same load --maxWorkers=10: 0 failures.
// One worker per two logical CPUs is one per physical core on SMT hosts. Without SMT the
// count is halved, the accepted cost.
export const VITEST_LOGICAL_CPUS_PER_WORKER = 2;

// A detected chain failure uses the measured-safe 8 GiB agent-scope configuration from
// d-20260930-03: after the 1 GiB agent reserve, Vitest gets 22 workers. d-20261031-06
// recomputed CONSERVATIVE_STRYKER_RUNNERS (2) as workerCount over the undivided 7 GiB
// usable budget; strykerSlots at that budget with three packages picks two slots of one.
export const CONSERVATIVE_CGROUP_LIMIT_BYTES = 8 * 1024 ** 3;
export const CONSERVATIVE_VITEST_WORKERS = 22;
export const CONSERVATIVE_STRYKER_RUNNERS = 2;

// Cold calibration at e3aea1f3 (2026-10-28/29), under the unmodified agent-gate cap:
// bindings, native clippy/test, Windows GNU clippy and nightly coverage all passed at one job.
// Largest compiler/linker process HWM was native test at 6704693248 bytes (6.24 GiB).
// 8 GiB gives about 28% headroom, plus 1 GiB for Rust orchestration beside the generic reserve.
// Exclusive Rust admission avoids spending this same envelope in several target contexts.
// Cost: slower cold gates or explicit refusal below 9 GiB usable (10 GiB including the reserve).
// Replace these costs/admission only with comparable cold measurements and equivalent proof.
export const RUST_COMPILER_JOB_BYTES = 8 * 1024 ** 3;
export const RUST_OVERHEAD_BYTES = 1024 ** 3;
export const RUST_MINIMUM_BUDGET_BYTES = RUST_OVERHEAD_BYTES + RUST_COMPILER_JOB_BYTES;

function detectionError(path, detail, cause = undefined) {
  const error = new Error(
    `Cannot determine the gate memory limit from ${path}: ${detail}. ` +
      "Set GATE_MEMORY_BYTES to a positive decimal integer to override cgroup detection.",
  );
  if (cause !== undefined) error.cause = cause;
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function directoryChain(cgroupDirectory) {
  const chain = [];
  for (let directory = cgroupDirectory; ; directory = dirname(directory)) {
    chain.push(directory);
    if (directory === CGROUP_ROOT) return chain;
  }
}

function cgroupDirectoryFrom(contents) {
  if (typeof contents !== "string") {
    throw detectionError(PROCESS_CGROUP_FILE, "the file did not contain text");
  }
  const line = contents.split(/\r?\n/u).find((candidate) => candidate.startsWith("0::"));
  const cgroupPath = line?.slice(3);
  if (!cgroupPath?.startsWith("/")) {
    throw detectionError(PROCESS_CGROUP_FILE, "no valid cgroup-v2 0:: path was found");
  }

  const directory = resolve(CGROUP_ROOT, `.${cgroupPath}`);
  if (directory !== CGROUP_ROOT && !directory.startsWith(`${CGROUP_ROOT}${sep}`)) {
    throw detectionError(
      PROCESS_CGROUP_FILE,
      `cgroup path ${JSON.stringify(cgroupPath)} escaped the cgroup mount`,
    );
  }
  return directory;
}

function parseMemoryLimit(contents, path, filename) {
  if (typeof contents !== "string") {
    throw detectionError(path, `${filename} did not contain text`);
  }
  const value = contents.trim();
  if (value === "max") return undefined;
  if (!/^\d+$/u.test(value)) {
    throw detectionError(path, `unparsable ${filename} value ${JSON.stringify(value)}`);
  }
  const limit = BigInt(value);
  if (limit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw detectionError(path, `${filename} exceeds the safe integer byte range`);
  }
  return limit;
}

/**
 * Return the smallest finite memory.high or memory.max from the process cgroup through the
 * mount root. Dependencies are supplied in the options object for deterministic tests.
 */
export function memoryLimitBytes({
  readFileSync = defaultReadFileSync,
  statSync = defaultStatSync,
  platform = process.platform,
} = {}) {
  if (platform !== "linux") {
    throw detectionError(
      PROCESS_CGROUP_FILE,
      `cgroup-v2 memory limits are unavailable on ${platform}`,
    );
  }

  let cgroupContents;
  try {
    cgroupContents = readFileSync(PROCESS_CGROUP_FILE, "utf8");
  } catch (error) {
    throw detectionError(PROCESS_CGROUP_FILE, `could not be read: ${errorMessage(error)}`, error);
  }
  const processCgroupDirectory = cgroupDirectoryFrom(cgroupContents);
  let minimum;

  for (const directory of directoryChain(processCgroupDirectory)) {
    let directoryStats;
    try {
      directoryStats = statSync(directory);
    } catch (error) {
      throw detectionError(
        directory,
        `cgroup directory could not be checked: ${errorMessage(error)}`,
        error,
      );
    }
    if (!directoryStats?.isDirectory?.()) {
      throw detectionError(directory, "cgroup path is not a directory");
    }

    for (const filename of ["memory.high", "memory.max"]) {
      const memoryPath = join(directory, filename);
      let contents;
      try {
        contents = readFileSync(memoryPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT" && directory === CGROUP_ROOT) continue;
        throw detectionError(memoryPath, `could not be read: ${errorMessage(error)}`, error);
      }

      const limit = parseMemoryLimit(contents, memoryPath, filename);
      if (limit !== undefined && (minimum === undefined || limit < minimum)) minimum = limit;
    }
  }

  if (minimum === undefined) {
    throw detectionError(
      CGROUP_ROOT,
      "no finite memory.high or memory.max limit exists in the cgroup chain",
    );
  }
  return Number(minimum);
}

/** Parse a named environment variable as a positive safe integer byte count. */
export function positiveByteCountFromEnv(name, env = process.env) {
  const value = env?.[name];
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new Error(
      `${name} must be a positive decimal integer in bytes (received ${JSON.stringify(value)}).`,
    );
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(
      `${name} must be a positive decimal integer in bytes (received ${JSON.stringify(value)}).`,
    );
  }
  return bytes;
}

function configuredMemoryBudget(env) {
  if (env?.GATE_MEMORY_BYTES === undefined) return undefined;
  return positiveByteCountFromEnv("GATE_MEMORY_BYTES", env);
}

/** Return the available gate budget, honoring the override and using the recorded fallback. */
export function gateBudgetBytes({
  env = process.env,
  stderr = process.stderr,
  fallback = {
    budgetBytes: CONSERVATIVE_CGROUP_LIMIT_BYTES - UNSIZED_PROCESS_RESERVE_BYTES,
    description: "the conservative 8 GiB agent-scope configuration",
  },
  ...memoryOptions
} = {}) {
  const override = configuredMemoryBudget(env);
  if (override !== undefined) return override;
  try {
    return memoryLimitBytes(memoryOptions) - UNSIZED_PROCESS_RESERVE_BYTES;
  } catch (error) {
    const reason = errorMessage(error).replaceAll(/[\r\n]+/gu, " ");
    stderr.write(`Gate memory detection failed (${reason}). Using ${fallback.description}.\n`);
    return fallback.budgetBytes;
  }
}

function configuredCpuShare(env) {
  const value = env?.GATE_CPU_SHARE;
  if (value === undefined) return 1;
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) {
    throw new Error(
      `GATE_CPU_SHARE must be a decimal in (0, 1] (received ${JSON.stringify(value)}).`,
    );
  }
  const share = Number(value);
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error(
      `GATE_CPU_SHARE must be a decimal in (0, 1] (received ${JSON.stringify(value)}).`,
    );
  }
  return share;
}

function validateByteCount(name, value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer byte count.`,
    );
  }
}

/**
 * Choose a worker count bounded by the gate memory budget, the CPU share, and optional
 * logicalCpusPerWorker (default 1: one worker per logical CPU after GATE_CPU_SHARE).
 */
export function workerCount({
  perWorkerBytes,
  baseBytes = 0,
  budgetBytes,
  env = process.env,
  availableParallelism = defaultAvailableParallelism,
  logicalCpusPerWorker = 1,
  ...memoryOptions
} = {}) {
  validateByteCount("perWorkerBytes", perWorkerBytes);
  validateByteCount("baseBytes", baseBytes, { allowZero: true });
  if (!Number.isSafeInteger(logicalCpusPerWorker) || logicalCpusPerWorker < 1) {
    throw new Error("logicalCpusPerWorker must be a positive safe integer.");
  }
  const budget =
    budgetBytes === undefined ? gateBudgetBytes({ env, ...memoryOptions }) : budgetBytes;
  validateByteCount("budgetBytes", budget, { allowZero: true });

  const minimumBudget = baseBytes + perWorkerBytes;
  if (!Number.isSafeInteger(minimumBudget)) {
    throw new Error("baseBytes + perWorkerBytes must be a safe integer byte count.");
  }
  if (budget < minimumBudget) {
    throw new Error(
      `Gate memory budget ${budget} bytes is below the minimum ${minimumBudget} bytes ` +
        `(baseBytes ${baseBytes} + perWorkerBytes ${perWorkerBytes}).`,
    );
  }

  const cpuCount = availableParallelism();
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1) {
    throw new Error(`os.availableParallelism() returned an invalid CPU count ${String(cpuCount)}.`);
  }
  const share = configuredCpuShare(env);
  const cpuCap = Math.max(1, Math.floor((cpuCount * share) / logicalCpusPerWorker));
  const memoryCap = Math.floor((budget - baseBytes) / perWorkerBytes);
  return Math.max(1, Math.min(cpuCap, memoryCap));
}

/** One compiler allowance for push lanes, P1 bindings and pre-review Windows compilation. */
export function rustBuildEnvironment({
  env = process.env,
  availableParallelism = defaultAvailableParallelism,
  getGateBudgetBytes = (options) => gateBudgetBytes({ env, ...options }),
} = {}) {
  const budgetBytes = getGateBudgetBytes({
    // Detection failure is not evidence of sufficient memory. This fallback assumes the
    // supported minimum and admits one job, without changing frontend's 7 GiB usable fallback.
    fallback: {
      budgetBytes: RUST_MINIMUM_BUDGET_BYTES,
      description: "the one-job Rust fallback (requires 9 GiB usable, 10 GiB with the reserve)",
    },
  });
  const cpuCount = availableParallelism();
  let jobs;
  try {
    jobs = workerCount({
      perWorkerBytes: RUST_COMPILER_JOB_BYTES,
      baseBytes: RUST_OVERHEAD_BYTES,
      budgetBytes,
      env,
      availableParallelism: () => cpuCount,
    });
  } catch (error) {
    throw new Error(
      `Rust compilation refused: ${error.message} Provide at least 9 GiB usable gate memory.`,
      {
        cause: error,
      },
    );
  }
  const inherited = env.CARGO_BUILD_JOBS;
  if (inherited !== undefined && inherited !== "default") {
    const value = /^[+-]?\d+$/u.test(inherited) ? Number(inherited) : NaN;
    if (!Number.isSafeInteger(value) || value === 0) {
      throw new Error(
        `CARGO_BUILD_JOBS must be a nonzero integer or default (received ${JSON.stringify(inherited)}).`,
      );
    }
    // Cargo's negative values subtract from available CPUs, with a one-job floor.
    const inheritedJobs = value < 0 ? Math.max(1, cpuCount + value) : value;
    jobs = Math.min(jobs, inheritedJobs);
  }
  // Environment takes precedence over ordinary Cargo build.jobs configuration. Never change
  // RUST_TEST_THREADS here, this allowance governs compilation rather than libtest execution.
  return { ...env, CARGO_BUILD_JOBS: String(jobs) };
}

/** Select package slots that maximize total Stryker runners without oversubscribing CPU or memory. */
export function strykerSlots({
  budgetBytes,
  packageCount = 3,
  env = process.env,
  availableParallelism = defaultAvailableParallelism,
} = {}) {
  validateByteCount("packageCount", packageCount);
  const minimumBudget = STRYKER_PARENT_BYTES + STRYKER_RUNNER_BYTES;
  if (!Number.isSafeInteger(budgetBytes)) {
    throw new Error(`Gate memory budget ${String(budgetBytes)} bytes must be a safe integer.`);
  }
  if (budgetBytes < minimumBudget) {
    throw new Error(
      `Gate memory budget ${budgetBytes} bytes is below the minimum ${minimumBudget} bytes ` +
        `(STRYKER_PARENT_BYTES ${STRYKER_PARENT_BYTES} + STRYKER_RUNNER_BYTES ${STRYKER_RUNNER_BYTES}).`,
    );
  }
  const cpuCount = availableParallelism();
  if (!Number.isSafeInteger(cpuCount) || cpuCount < 1) {
    throw new Error(`os.availableParallelism() returned an invalid CPU count ${String(cpuCount)}.`);
  }
  const share = configuredCpuShare(env);
  const maximumSlots = Math.min(packageCount, Math.max(1, Math.floor(cpuCount * share)));
  let bestSlots = 0;
  let bestRunnerCount = 0;

  for (let slots = 1; slots <= maximumSlots; slots += 1) {
    const perSlotBudget = Math.floor(budgetBytes / slots);
    if (perSlotBudget < minimumBudget) continue;
    const runnerShare = share / slots;
    const runnersPerSlot = workerCount({
      perWorkerBytes: STRYKER_RUNNER_BYTES,
      baseBytes: STRYKER_PARENT_BYTES,
      budgetBytes: perSlotBudget,
      env: { ...env, GATE_CPU_SHARE: String(runnerShare) },
      availableParallelism,
    });
    const totalRunners = slots * runnersPerSlot;
    if (totalRunners > bestRunnerCount || (totalRunners === bestRunnerCount && slots > bestSlots)) {
      bestSlots = slots;
      bestRunnerCount = totalRunners;
    }
  }

  if (bestSlots === 0) {
    throw new Error(
      `Gate memory budget ${budgetBytes} bytes is below the minimum ${minimumBudget} bytes ` +
        `(STRYKER_PARENT_BYTES ${STRYKER_PARENT_BYTES} + STRYKER_RUNNER_BYTES ${STRYKER_RUNNER_BYTES}).`,
    );
  }
  return { slots: bestSlots, cpuShare: share / bestSlots };
}

/** Size Vitest workers only while Vitest evaluates the config; production builds leave it unset. */
export function vitestMaxWorkers({ env = process.env, ...injectables } = {}) {
  if (env?.VITEST !== "true") return undefined;
  if (env?.STRYKER_MEMORY_BYTES !== undefined) return 1;

  return workerCount({
    perWorkerBytes: VITEST_WORKER_BYTES,
    baseBytes: VITEST_BASE_BYTES,
    env,
    ...injectables,
    logicalCpusPerWorker: VITEST_LOGICAL_CPUS_PER_WORKER,
  });
}
