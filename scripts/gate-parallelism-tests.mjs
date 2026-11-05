import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  UNSIZED_PROCESS_RESERVE_BYTES,
  CONSERVATIVE_CGROUP_LIMIT_BYTES,
  CONSERVATIVE_STRYKER_RUNNERS,
  CONSERVATIVE_VITEST_WORKERS,
  gateBudgetBytes,
  memoryLimitBytes,
  STRYKER_PARENT_BYTES,
  STRYKER_RUNNER_BYTES,
  strykerSlots,
  VITEST_BASE_BYTES,
  vitestMaxWorkers,
  VITEST_WORKER_BYTES,
  workerCount,
  rustBuildEnvironment,
} from "./gate-parallelism.mjs";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const CGROUP_ROOT = "/sys/fs/cgroup";
const PROCESS_CGROUP_FILE = "/proc/self/cgroup";
const CGROUP_PATH = "/tenant/agent";
const CGROUP_DIRECTORY = resolve(CGROUP_ROOT, `.${CGROUP_PATH}`);
const CGROUP_PARENT = dirname(CGROUP_DIRECTORY);

test("Rust compiler jobs spend the measured envelope instead of CPU-only fan-out", () => {
  const allocation = (budget, cpus = 24, env = {}) =>
    rustBuildEnvironment({
      env,
      getGateBudgetBytes: () => budget,
      availableParallelism: () => cpus,
    });
  assert.equal(allocation(Math.floor(9.8 * GIB)).CARGO_BUILD_JOBS, "1");
  assert.equal(allocation(34 * GIB).CARGO_BUILD_JOBS, "4");
  assert.equal(allocation(90 * GIB, 2).CARGO_BUILD_JOBS, "2");
  assert.equal(allocation(90 * GIB, 24, { GATE_CPU_SHARE: "0.125" }).CARGO_BUILD_JOBS, "3");
  assert.equal(allocation(9 * GIB).CARGO_BUILD_JOBS, "1");
  for (const budget of [0, 7 * GIB, 9 * GIB - 1]) {
    assert.throws(
      () => allocation(budget),
      /Rust compilation refused:.*below the minimum.*9 GiB usable/u,
    );
  }
});

test("Rust fallback admits one job only for unavailable detection and retains the generic reserve", () => {
  for (const fixture of [
    linuxFixture(),
    linuxFixture({
      readFailures: { [join(CGROUP_PARENT, "memory.max")]: new Error("unreadable ancestor") },
    }),
  ]) {
    let stderr = "";
    const env = {};
    const allocation = rustBuildEnvironment({
      env,
      availableParallelism: () => 24,
      getGateBudgetBytes: (options) =>
        gateBudgetBytes({
          ...fixture,
          env,
          stderr: { write: (line) => (stderr += line) },
          ...options,
        }),
    });
    assert.equal(allocation.CARGO_BUILD_JOBS, "1");
    assert.match(stderr, /one-job Rust fallback.*9 GiB usable, 10 GiB with the reserve/u);
  }
  for (const limit of [10 * GIB - 1, 10 * GIB]) {
    const fixture = linuxFixture({ memory: { [CGROUP_DIRECTORY]: String(limit) } });
    let stderr = "";
    const allocate = () =>
      rustBuildEnvironment({
        env: {},
        availableParallelism: () => 24,
        getGateBudgetBytes: (options) =>
          gateBudgetBytes({
            ...fixture,
            env: {},
            stderr: { write: (line) => (stderr += line) },
            ...options,
          }),
      });
    if (limit < 10 * GIB) assert.throws(allocate, /Rust compilation refused/u);
    else assert.equal(allocate().CARGO_BUILD_JOBS, "1");
    assert.equal(stderr, "", "known insufficient memory must never become detection fallback");
  }
});

test("Rust allocation respects lower inherited Cargo jobs and clamps positive, negative and default controls", () => {
  for (const [inherited, expected] of [
    [undefined, "4"],
    ["2", "2"],
    ["+2", "2"],
    ["64", "4"],
    ["-23", "1"],
    ["-22", "2"],
    ["-99", "1"],
    ["-1", "4"],
    ["default", "4"],
  ]) {
    const env = {
      RUST_TEST_THREADS: "7",
      ...(inherited === undefined ? {} : { CARGO_BUILD_JOBS: inherited }),
    };
    const result = rustBuildEnvironment({
      env,
      getGateBudgetBytes: () => 34 * GIB,
      availableParallelism: () => 24,
    });
    assert.equal(result.CARGO_BUILD_JOBS, expected, String(inherited));
    assert.equal(result.RUST_TEST_THREADS, "7");
    assert.equal(env.CARGO_BUILD_JOBS, inherited);
  }
  for (const value of ["0", "-0", "abc", "", "1.5"]) {
    assert.throws(
      () =>
        rustBuildEnvironment({
          env: { CARGO_BUILD_JOBS: value },
          getGateBudgetBytes: () => 34 * GIB,
          availableParallelism: () => 24,
        }),
      /CARGO_BUILD_JOBS/u,
    );
  }
  const result = rustBuildEnvironment({
    env: {},
    getGateBudgetBytes: () => 34 * GIB,
    availableParallelism: () => 24,
  });
  assert.equal(Object.hasOwn(result, "RUST_TEST_THREADS"), false);
});

function fakeFsError(code, path) {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function ancestors(directory) {
  const result = [];
  for (let current = directory; ; current = dirname(current)) {
    result.push(current);
    if (current === CGROUP_ROOT) return result;
  }
}

function linuxFixture({
  includeProc = true,
  procContents = `0::${CGROUP_PATH}\n`,
  directories = ancestors(CGROUP_DIRECTORY),
  memory = {},
  fileContents = {},
  missingFiles = [],
  readFailures = {},
} = {}) {
  const directorySet = new Set(directories);
  const files = new Map(Object.entries(fileContents));
  const failures = new Map(Object.entries(readFailures));
  if (includeProc) files.set(PROCESS_CGROUP_FILE, procContents);
  for (const directory of directories) {
    files.set(join(directory, "memory.high"), "max\n");
    files.set(join(directory, "memory.max"), "max\n");
  }
  for (const [directory, limits] of Object.entries(memory)) {
    const entries = typeof limits === "string" ? { max: limits } : limits;
    for (const [filename, contents] of Object.entries(entries)) {
      files.set(join(directory, `memory.${filename}`), `${contents}\n`);
    }
  }
  for (const path of missingFiles) files.delete(path);

  return {
    readFileSync(path) {
      if (failures.has(path)) throw failures.get(path);
      if (files.has(path)) return files.get(path);
      throw fakeFsError("ENOENT", path);
    },
    statSync(path) {
      if (!directorySet.has(path)) throw fakeFsError("ENOENT", path);
      return { isDirectory: () => true };
    },
    platform: "linux",
  };
}

function detectionErrorAt(path) {
  return (error) =>
    error instanceof Error &&
    error.message.includes(path) &&
    error.message.includes("GATE_MEMORY_BYTES");
}

test("memoryLimitBytes selects the minimum memory.high or memory.max along the whole chain", () => {
  const fixture = linuxFixture({
    memory: {
      [CGROUP_DIRECTORY]: { high: `${6 * GIB}`, max: `${7 * GIB}` },
      [CGROUP_PARENT]: { high: `${5 * GIB}`, max: `${8 * GIB}` },
      [CGROUP_ROOT]: { high: "max", max: `${12 * GIB}` },
    },
  });
  assert.equal(memoryLimitBytes(fixture), 5 * GIB);
});

test("memoryLimitBytes skips max and allows a missing limit file only at the mount root", () => {
  const fixture = linuxFixture({
    memory: {
      [CGROUP_DIRECTORY]: { high: "max", max: `${6 * GIB}` },
      [CGROUP_PARENT]: { high: `${5 * GIB}`, max: "max" },
      [CGROUP_ROOT]: { high: "max", max: "max" },
    },
    missingFiles: [join(CGROUP_ROOT, "memory.max")],
  });
  assert.equal(memoryLimitBytes(fixture), 5 * GIB);
});

test("memoryLimitBytes uses the cgroup limit without consulting physical memory", () => {
  const fixture = linuxFixture({
    memory: { [CGROUP_DIRECTORY]: { high: `${12 * GIB}`, max: `${14 * GIB}` } },
  });
  assert.equal(
    memoryLimitBytes({ ...fixture, totalmem: () => assert.fail("must not read total memory") }),
    12 * GIB,
  );
});

test("memoryLimitBytes reports ENOENT below the mount root as an incomplete chain", () => {
  const path = join(CGROUP_DIRECTORY, "memory.high");
  const fixture = linuxFixture({
    readFailures: { [path]: fakeFsError("ENOENT", path) },
  });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(path));
});

test("memoryLimitBytes reports EACCES on memory.high with its path and override guidance", () => {
  const path = join(CGROUP_PARENT, "memory.high");
  const fixture = linuxFixture({
    readFailures: { [path]: fakeFsError("EACCES", path) },
  });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(path));
});

test("memoryLimitBytes rejects an unparsable memory.max value with its path", () => {
  const path = join(CGROUP_DIRECTORY, "memory.max");
  const fixture = linuxFixture({ memory: { [CGROUP_DIRECTORY]: { max: "not-a-number" } } });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(path));
});

test("memoryLimitBytes reports a missing /proc/self/cgroup with override guidance", () => {
  const fixture = linuxFixture({ includeProc: false });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(PROCESS_CGROUP_FILE));
});

test("memoryLimitBytes rejects a missing own cgroup directory when every directory is ENOENT", () => {
  const fixture = linuxFixture({ directories: [] });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(CGROUP_DIRECTORY));
});

test("memoryLimitBytes rejects a missing own cgroup directory even when an ancestor has a finite limit", () => {
  const fixture = linuxFixture({
    directories: [CGROUP_PARENT, CGROUP_ROOT],
    memory: { [CGROUP_PARENT]: `${4 * GIB}` },
  });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(CGROUP_DIRECTORY));
});

test("memoryLimitBytes rejects cgroup-v1 content without a 0:: line", () => {
  const fixture = linuxFixture({ procContents: "5:memory:/tenant/agent\n" });
  assert.throws(() => memoryLimitBytes(fixture), detectionErrorAt(PROCESS_CGROUP_FILE));
});

test("non-Linux cgroup detection fails instead of using physical memory", () => {
  let reads = 0;
  assert.throws(
    () =>
      memoryLimitBytes({
        platform: "darwin",
        totalmem: () => assert.fail("must not read total memory"),
        readFileSync() {
          reads += 1;
          throw new Error("must not read cgroup files");
        },
        statSync() {
          reads += 1;
          throw new Error("must not stat cgroup directories");
        },
      }),
    detectionErrorAt(PROCESS_CGROUP_FILE),
  );
  assert.equal(reads, 0);
});

test("gateBudgetBytes uses a valid GATE_MEMORY_BYTES override ahead of cgroup detection", () => {
  const fixture = linuxFixture({ memory: { [CGROUP_DIRECTORY]: "100" } });
  assert.equal(gateBudgetBytes({ ...fixture, env: { GATE_MEMORY_BYTES: "123456" } }), 123456);
});

for (const value of ["abc", "0", "-1", "1.5", ""]) {
  test(`gateBudgetBytes rejects GATE_MEMORY_BYTES=${JSON.stringify(value)}`, () => {
    assert.throws(
      () => gateBudgetBytes({ env: { GATE_MEMORY_BYTES: value } }),
      (error) => error instanceof Error && error.message.includes("GATE_MEMORY_BYTES"),
    );
  });
}

test("gateBudgetBytes does not read an unreadable cgroup when GATE_MEMORY_BYTES is set", () => {
  let reads = 0;
  assert.equal(
    gateBudgetBytes({
      env: { GATE_MEMORY_BYTES: "987654" },
      platform: "linux",
      readFileSync() {
        reads += 1;
        throw fakeFsError("EACCES", "cgroup file");
      },
      statSync() {
        reads += 1;
        throw fakeFsError("EACCES", "cgroup directory");
      },
      totalmem() {
        reads += 1;
        throw new Error("must not read total memory");
      },
    }),
    987654,
  );
  assert.equal(reads, 0);
});

test("gateBudgetBytes subtracts UNSIZED_PROCESS_RESERVE_BYTES from the minimum high/max limit", () => {
  const fixture = linuxFixture({
    memory: { [CGROUP_DIRECTORY]: { high: `${7 * GIB}`, max: `${9 * GIB}` } },
  });
  assert.equal(gateBudgetBytes({ ...fixture, env: {} }), 7 * GIB - UNSIZED_PROCESS_RESERVE_BYTES);
});

test("an unreadable ancestor uses the conservative worker counts and prints its cause once", () => {
  const path = join(CGROUP_PARENT, "memory.max");
  const fixture = linuxFixture({
    memory: { [CGROUP_DIRECTORY]: { high: `${16 * GIB}`, max: `${16 * GIB}` } },
    readFailures: { [path]: fakeFsError("EACCES", path) },
  });
  let stderr = "";
  const budgetBytes = gateBudgetBytes({
    ...fixture,
    env: {},
    stderr: { write: (line) => (stderr += line) },
  });
  assert.equal(budgetBytes, CONSERVATIVE_CGROUP_LIMIT_BYTES - UNSIZED_PROCESS_RESERVE_BYTES);
  assert.equal(stderr.split("\n").filter(Boolean).length, 1);
  assert.match(stderr, /memory\.max/u);
  assert.equal(
    workerCount({
      perWorkerBytes: VITEST_WORKER_BYTES,
      baseBytes: VITEST_BASE_BYTES,
      budgetBytes,
      availableParallelism: () => 24,
      env: {},
    }),
    CONSERVATIVE_VITEST_WORKERS,
  );
  const slots = strykerSlots({ budgetBytes, availableParallelism: () => 24, env: {} });
  // slots.slots === 2 is the strykerSlots slot count at the 7 GiB fallback (s=1 gives 2
  // runners, s=2 gives 1 each, tie picks the larger s). The CONSERVATIVE_STRYKER_RUNNERS
  // assertion below is a different quantity: workerCount on the undivided 7 GiB budget
  // (floor(6528 MiB / 2432 MiB) = 2).
  assert.equal(slots.slots, 2);
  assert.equal(
    workerCount({
      perWorkerBytes: STRYKER_RUNNER_BYTES,
      baseBytes: STRYKER_PARENT_BYTES,
      budgetBytes,
      availableParallelism: () => 24,
      env: {},
    }),
    CONSERVATIVE_STRYKER_RUNNERS,
  );
});

test("an all-max chain uses the conservative worker counts instead of physical memory", () => {
  const fixture = linuxFixture();
  let stderr = "";
  const budgetBytes = gateBudgetBytes({
    ...fixture,
    env: {},
    stderr: { write: (line) => (stderr += line) },
  });
  assert.equal(budgetBytes, CONSERVATIVE_CGROUP_LIMIT_BYTES - UNSIZED_PROCESS_RESERVE_BYTES);
  assert.match(stderr, /no finite memory\.high or memory\.max limit/u);
  assert.equal(
    workerCount({
      perWorkerBytes: VITEST_WORKER_BYTES,
      baseBytes: VITEST_BASE_BYTES,
      budgetBytes,
      availableParallelism: () => 24,
      env: {},
    }),
    CONSERVATIVE_VITEST_WORKERS,
  );
  const slots = strykerSlots({ budgetBytes, availableParallelism: () => 24, env: {} });
  // slots.slots === 2 is the strykerSlots slot count at the 7 GiB fallback (s=1 gives 2
  // runners, s=2 gives 1 each, tie picks the larger s). The CONSERVATIVE_STRYKER_RUNNERS
  // assertion below is a different quantity: workerCount on the undivided 7 GiB budget
  // (floor(6528 MiB / 2432 MiB) = 2).
  assert.equal(slots.slots, 2);
  assert.equal(
    workerCount({
      perWorkerBytes: STRYKER_RUNNER_BYTES,
      baseBytes: STRYKER_PARENT_BYTES,
      budgetBytes,
      availableParallelism: () => 24,
      env: {},
    }),
    CONSERVATIVE_STRYKER_RUNNERS,
  );
});

test("workerCount rejects a budget below baseBytes plus one worker and names both byte counts", () => {
  assert.throws(
    () => workerCount({ perWorkerBytes: 40, baseBytes: 60, budgetBytes: 99 }),
    (error) =>
      error instanceof Error &&
      error.message.includes("99 bytes") &&
      error.message.includes("100 bytes"),
  );
});

test("workerCount returns 24 for the 24 CPU, 8 GiB Vitest budget fixture", () => {
  assert.equal(
    workerCount({
      perWorkerBytes: VITEST_WORKER_BYTES,
      baseBytes: VITEST_BASE_BYTES,
      budgetBytes: 8 * GIB,
      availableParallelism: () => 24,
      env: {},
    }),
    24,
  );
});

test("workerCount subtracts the base budget and returns 3 for 2 GiB workers", () => {
  assert.equal(
    workerCount({
      perWorkerBytes: 2 * GIB,
      baseBytes: VITEST_BASE_BYTES,
      budgetBytes: 8 * GIB,
      availableParallelism: () => 24,
      env: {},
    }),
    3,
  );
});

test("workerCount applies String(1 / 3) as an 8 worker cap on 24 CPUs", () => {
  assert.equal(
    workerCount({
      perWorkerBytes: MIB,
      budgetBytes: 100 * GIB,
      availableParallelism: () => 24,
      env: { GATE_CPU_SHARE: String(1 / 3) },
    }),
    8,
  );
});

for (const value of ["0", "1.5", "x", ""]) {
  test(`workerCount rejects GATE_CPU_SHARE=${JSON.stringify(value)}`, () => {
    assert.throws(
      () =>
        workerCount({
          perWorkerBytes: MIB,
          budgetBytes: 100 * GIB,
          availableParallelism: () => 24,
          env: { GATE_CPU_SHARE: value },
        }),
      (error) => error instanceof Error && error.message.includes("GATE_CPU_SHARE"),
    );
  });
}

test("workerCount stays between 1 and availableParallelism, including a single available CPU", () => {
  for (const cpuCount of [1, 2, 24]) {
    const count = workerCount({
      perWorkerBytes: MIB,
      budgetBytes: 100 * GIB,
      availableParallelism: () => cpuCount,
      env: {},
    });
    assert.ok(count >= 1);
    assert.ok(count <= cpuCount);
  }
});

test("the exported per-tool byte constants retain their measured budget values", () => {
  assert.equal(STRYKER_RUNNER_BYTES, 2432 * MIB);
  assert.equal(STRYKER_PARENT_BYTES, 640 * MIB);
  assert.equal(
    CONSERVATIVE_STRYKER_RUNNERS,
    Math.floor(
      (CONSERVATIVE_CGROUP_LIMIT_BYTES - UNSIZED_PROCESS_RESERVE_BYTES - STRYKER_PARENT_BYTES) /
        STRYKER_RUNNER_BYTES,
    ),
  );
  assert.equal(VITEST_WORKER_BYTES, 256 * MIB);
  assert.equal(VITEST_BASE_BYTES, 1.5 * GIB);
});

test("strykerSlots admits three 24-CPU packages with eight runners each from a large budget", () => {
  const budgetBytes = 90 * GIB;
  const plan = strykerSlots({ budgetBytes, availableParallelism: () => 24, env: {} });
  assert.equal(plan.slots, 3);
  const runnersPerPackage = workerCount({
    perWorkerBytes: STRYKER_RUNNER_BYTES,
    baseBytes: STRYKER_PARENT_BYTES,
    budgetBytes: Math.floor(budgetBytes / plan.slots),
    availableParallelism: () => 24,
    env: { GATE_CPU_SHARE: String(plan.cpuShare) },
  });
  assert.equal(runnersPerPackage, 8);
});

test("strykerSlots gives a single-CPU package the full budget", () => {
  const budgetBytes = 90 * GIB;
  const plan = strykerSlots({ budgetBytes, availableParallelism: () => 1, env: {} });
  assert.equal(plan.slots, 1);
  assert.equal(Math.floor(budgetBytes / plan.slots), budgetBytes);
  assert.equal(plan.cpuShare, 1);
});

test("strykerSlots charges each package parent in the three-CPU discriminating budget", () => {
  const budgetBytes = 2 * STRYKER_RUNNER_BYTES + STRYKER_PARENT_BYTES;
  const plan = strykerSlots({ budgetBytes, availableParallelism: () => 3, env: {} });
  assert.equal(plan.slots, 1);
  assert.equal(Math.floor(budgetBytes / plan.slots), budgetBytes);
});

test("the observed-failure kernel caps admit at most 6 and 12 Stryker runners", () => {
  // 11596410880 and 19327352832 are the kernel caps that OOM-killed 7 and 13 runners
  // (f-20261022-05). Budget is each cap minus UNSIZED_PROCESS_RESERVE_BYTES.
  const env = {};
  const availableParallelism = () => 20;
  const budgetAt11596410880 = 11596410880 - UNSIZED_PROCESS_RESERVE_BYTES;
  assert.equal(
    strykerSlots({
      budgetBytes: budgetAt11596410880,
      packageCount: 1,
      availableParallelism,
      env,
    }).slots,
    1,
  );
  const countAt11596410880 = workerCount({
    perWorkerBytes: STRYKER_RUNNER_BYTES,
    baseBytes: STRYKER_PARENT_BYTES,
    budgetBytes: budgetAt11596410880,
    availableParallelism,
    env,
  });
  assert.ok(
    countAt11596410880 <= 6,
    `11596410880 must admit at most 6 runners (got ${countAt11596410880})`,
  );
  const budgetAt19327352832 = 19327352832 - UNSIZED_PROCESS_RESERVE_BYTES;
  assert.equal(
    strykerSlots({
      budgetBytes: budgetAt19327352832,
      packageCount: 1,
      availableParallelism,
      env,
    }).slots,
    1,
  );
  const countAt19327352832 = workerCount({
    perWorkerBytes: STRYKER_RUNNER_BYTES,
    baseBytes: STRYKER_PARENT_BYTES,
    budgetBytes: budgetAt19327352832,
    availableParallelism,
    env,
  });
  assert.ok(
    countAt19327352832 <= 12,
    `19327352832 must admit at most 12 runners (got ${countAt19327352832})`,
  );
});

test("strykerSlots chooses two slots of one runner each for the 7 GiB regression anchor", () => {
  const budgetBytes = 7 * GIB;
  const plan = strykerSlots({ budgetBytes, availableParallelism: () => 24, env: {} });
  // s=1: floor((7 GiB − 640 MiB) / 2432 MiB) = floor(6528 / 2432) = 2, total 2.
  // s=2: per-slot 3584 MiB → floor((3584 − 640) / 2432) = 1, total 2; tie to larger s.
  assert.equal(plan.slots, 2);
  assert.equal(
    workerCount({
      perWorkerBytes: STRYKER_RUNNER_BYTES,
      baseBytes: STRYKER_PARENT_BYTES,
      budgetBytes: Math.floor(budgetBytes / plan.slots),
      availableParallelism: () => 24,
      env: { GATE_CPU_SHARE: String(plan.cpuShare) },
    }),
    Math.floor((Math.floor(budgetBytes / 2) - STRYKER_PARENT_BYTES) / STRYKER_RUNNER_BYTES),
  );
});

test("strykerSlots rejects a budget below one parent plus one runner with both byte counts", () => {
  const minimumBudget = STRYKER_PARENT_BYTES + STRYKER_RUNNER_BYTES;
  for (const budgetBytes of [minimumBudget - 1, minimumBudget - minimumBudget]) {
    assert.throws(
      () => strykerSlots({ budgetBytes, availableParallelism: () => 24, env: {} }),
      (error) =>
        error instanceof Error &&
        error.message.includes(String(budgetBytes)) &&
        error.message.includes(String(minimumBudget)),
    );
  }
});

test("strykerSlots keeps the aggregate runner count within 24, 2, and 1 available CPUs", () => {
  const budgetBytes = 90 * GIB;
  for (const cpuCount of [24, 2, 1]) {
    const plan = strykerSlots({ budgetBytes, availableParallelism: () => cpuCount, env: {} });
    const runnersPerPackage = workerCount({
      perWorkerBytes: STRYKER_RUNNER_BYTES,
      baseBytes: STRYKER_PARENT_BYTES,
      budgetBytes: Math.floor(budgetBytes / plan.slots),
      availableParallelism: () => cpuCount,
      env: { GATE_CPU_SHARE: String(plan.cpuShare) },
    });
    assert.ok(plan.slots * runnersPerPackage <= cpuCount);
  }
});

test("vitestMaxWorkers leaves the production config unset without reading cgroup files", () => {
  let reads = 0;
  assert.equal(
    vitestMaxWorkers({
      env: {},
      readFileSync() {
        reads += 1;
        throw new Error("must not read cgroup files");
      },
      statSync() {
        reads += 1;
        throw new Error("must not stat cgroup directories");
      },
    }),
    undefined,
  );
  assert.equal(reads, 0);
});

test("vitestMaxWorkers sizes one worker per two logical CPUs when memory is non-binding", () => {
  const env = { VITEST: "true", GATE_MEMORY_BYTES: String(100 * GIB) };
  assert.equal(
    vitestMaxWorkers({
      env,
      availableParallelism: () => 20,
    }),
    10,
  );
  assert.equal(
    vitestMaxWorkers({
      env: { ...env, GATE_CPU_SHARE: "0.5" },
      availableParallelism: () => 20,
    }),
    5,
  );
  assert.equal(
    vitestMaxWorkers({
      env,
      availableParallelism: () => 1,
    }),
    1,
  );
});

test("workerCount halves the CPU cap when logicalCpusPerWorker is 2", () => {
  assert.equal(
    workerCount({
      perWorkerBytes: MIB,
      budgetBytes: 100 * GIB,
      availableParallelism: () => 24,
      env: {},
      logicalCpusPerWorker: 2,
    }),
    12,
  );
});

for (const value of [0, 1.5, -1]) {
  test(`workerCount rejects logicalCpusPerWorker=${String(value)}`, () => {
    assert.throws(
      () =>
        workerCount({
          perWorkerBytes: MIB,
          budgetBytes: 100 * GIB,
          availableParallelism: () => 24,
          env: {},
          logicalCpusPerWorker: value,
        }),
      (error) => error instanceof Error && error.message.includes("logicalCpusPerWorker"),
    );
  });
}

test("vitestMaxWorkers returns one under Stryker without reading its budget or cgroup", () => {
  let reads = 0;
  assert.equal(
    vitestMaxWorkers({
      env: { VITEST: "true", STRYKER_MEMORY_BYTES: "256", GATE_MEMORY_BYTES: "" },
      readFileSync() {
        reads += 1;
        throw new Error("must not read cgroup files");
      },
      statSync() {
        reads += 1;
        throw new Error("must not stat cgroup directories");
      },
    }),
    1,
  );
  assert.equal(reads, 0);
});

test("Vite production config leaves test.maxWorkers undefined without VITEST", () => {
  const script = `
    import { loadConfigFromFile } from "vite";
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      "vite.config.ts",
      process.cwd(),
    );
    console.log(JSON.stringify(loaded.config.test.maxWorkers === undefined));
  `;
  const env = { ...process.env };
  delete env.GATE_MEMORY_BYTES;
  delete env.STRYKER_MEMORY_BYTES;
  delete env.VITEST;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout.trim().split(/\r?\n/u).at(-1), "true");
});
