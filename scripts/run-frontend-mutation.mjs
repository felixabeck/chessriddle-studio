import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installMultiChildSignalForwarding,
  signalExitCode,
  superviseChild,
} from "./child-supervisor.mjs";
import { gateBudgetBytes, strykerSlots } from "./gate-parallelism.mjs";
import { fsyncDirectory } from "./fsync-directory.mjs";
import { durableWrite } from "./durable-write.mjs";
import { fetchDailySweepResults } from "./frontend-mutation-baseline.mjs";
import { mutationPackages } from "./frontend-mutation-packages.mjs";
import { isEntrypoint } from "./entrypoint.mjs";
import { selectMutationPackages } from "./mutation-package-selection.mjs";
import { FRONTEND_INPUTS } from "./run-push-gates.mjs";
import { matches } from "./coverage-scope.mjs";
import {
  currentIdentity,
  identityForPid,
  identityIsLive,
  isCompleteIdentity,
} from "./process-identity.mjs";

const fencePath = "mutants.out/frontend/.mutation-in-progress";
const ownerPath = join(fencePath, "owner.json");
// Give a Stryker child two seconds to honor SIGTERM before escalating to SIGKILL.
const terminationTimeoutMs = 2_000;
// Cap a diagnostic tail at 8 KiB so a failing mutation cannot flood the gate output.
const logTailBytes = 8 * 1024;
const packageRecords = Object.freeze(
  Object.entries(mutationPackages).map(([id, files]) => Object.freeze({ id, files })),
);
/** Include the runner/config's complete repository module closure in the CI skip scope. */
export async function frontendMutationInputs() {
  const { parseTsSource } = await import("./parse-ts-source.mjs");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const inputs = new Set([...FRONTEND_INPUTS, ".github/workflows/test.yml", ".github/actions/**"]);
  const pending = ["scripts/run-frontend-mutation.mjs", "stryker.config.mjs"];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    inputs.add(path);
    const ast = parseTsSource(readFileSync(resolve(root, path), "utf8"), path);
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      let specifier;
      if (
        ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type)
      ) {
        specifier = node.source?.value;
      } else if (node.type === "CallExpression" && node.callee?.type === "Import") {
        specifier = node.arguments[0]?.value;
        if (typeof specifier !== "string") throw new Error("Unresolved dynamic import");
      }
      if (specifier?.startsWith(".")) {
        const dependency = relative(root, resolve(root, dirname(path), specifier))
          .split(sep)
          .join("/");
        if (dependency.startsWith("scripts/")) pending.push(dependency);
        else throw new Error(`Import outside scripts: ${specifier}`);
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") visit(value);
      }
    };
    visit(ast);
  }
  return [...inputs];
}

/** Uncertain bases, Git failures and incomplete input discovery always retain the run. */
export async function canSkipFrontendMutation(
  base,
  { cwd = process.cwd(), runGit = spawnSync, getInputs = frontendMutationInputs } = {},
) {
  if (!base || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/iu.test(base) || /^0+$/u.test(base)) return false;
  try {
    const options = { cwd, encoding: "utf8" };
    const commit = runGit("git", ["rev-parse", "--verify", `${base}^{commit}`], options);
    if (
      commit.error ||
      commit.status !== 0 ||
      commit.stdout.trim().toLowerCase() !== base.toLowerCase()
    )
      return false;
    const diff = runGit("git", ["diff", "--name-only", "-z", base, "HEAD"], options);
    if (diff.error || diff.status !== 0 || typeof diff.stdout !== "string") return false;
    if (diff.stdout && !diff.stdout.endsWith("\0")) return false;
    const inputs = await getInputs();
    return !diff.stdout
      .split("\0")
      .filter(Boolean)
      .some((path) => matches(path, inputs));
  } catch {
    return false;
  }
}

function incrementalDirectory(directory) {
  if (!directory) return undefined;
  const target = resolve(directory);
  const temp = resolve(".stryker-tmp");
  const outsideTemp = (path, sandbox) => path !== sandbox && !path.startsWith(`${sandbox}${sep}`);
  if (!outsideTemp(target, temp))
    throw new Error("FRONTEND_MUTATION_INCREMENTAL_DIR must lie outside .stryker-tmp");
  // Resolve existing ancestors too, so a symlink cannot put the cache inside the purge root.
  const physicalPath = (path) => {
    if (existsSync(path)) return realpathSync(path);
    const parent = dirname(path);
    return parent === path ? path : join(physicalPath(parent), relative(parent, path));
  };
  if (!outsideTemp(physicalPath(target), physicalPath(temp)))
    throw new Error("FRONTEND_MUTATION_INCREMENTAL_DIR must lie outside .stryker-tmp");
  return target;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeOwner(owner) {
  if (!owner || typeof owner !== "object" || !isCompleteIdentity(owner.runner)) return undefined;
  if (Array.isArray(owner.children)) {
    if (!owner.children.every(isCompleteIdentity)) return undefined;
    if (
      owner.spawning !== undefined &&
      owner.spawning !== null &&
      (typeof owner.spawning !== "string" || owner.spawning.length === 0)
    ) {
      return undefined;
    }
    return {
      runner: owner.runner,
      children: owner.children,
      ...(owner.spawning ? { spawning: owner.spawning } : {}),
      unknownChild: false,
    };
  }
  if (!Object.hasOwn(owner, "child")) return undefined;
  if (owner.child === null) {
    return { runner: owner.runner, children: [], unknownChild: true };
  }
  if (!isCompleteIdentity(owner.child)) return undefined;
  return { runner: owner.runner, children: [owner.child], unknownChild: false, legacy: true };
}

function readOwner() {
  try {
    return normalizeOwner(JSON.parse(readFileSync(ownerPath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

function processGroupIsEmpty(identity, kill = process.kill.bind(process)) {
  try {
    kill(-identity.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

/** Decide whether a dead fence can be safely recovered; probes are injectable for refusal tests. */
export function recoveryIsSafe(
  owner,
  { identityIsLive: isLive = identityIsLive, processGroupProbe = processGroupIsEmpty } = {},
) {
  if (!owner || owner.unknownChild || owner.spawning) return false;
  try {
    if (isLive(owner.runner)) return false;
    return owner.children.every((child) => !isLive(child) && processGroupProbe(child));
  } catch {
    return false;
  }
}

function refuseFence(owner, reason = undefined) {
  const detail = owner
    ? ` (runner pid ${owner.runner.pid})`
    : " (owner record missing or malformed)";
  console.error(`Frontend mutation fence exists: ${fencePath}${detail}`);
  if (reason) console.error(`Cannot determine whether the fence owner is alive: ${reason}`);

  if (owner) {
    try {
      const runnerState = identityIsLive(owner.runner) ? "alive" : "dead";
      console.error(`Recorded runner pid ${owner.runner.pid}: ${runnerState}`);
    } catch (error) {
      console.error(`Recorded runner pid ${owner.runner.pid}: unknown (${errorMessage(error)})`);
    }
    for (const [index, child] of owner.children.entries()) {
      try {
        const childState = identityIsLive(child) ? "alive" : "dead";
        console.error(`Recorded child ${index + 1} pid ${child.pid}: ${childState}`);
        if (childState === "dead") {
          const groupState = processGroupIsEmpty(child) ? "empty" : "not empty or unknown";
          console.error(`Recorded child ${index + 1} process group: ${groupState}`);
        }
      } catch (error) {
        console.error(
          `Recorded child ${index + 1} pid ${child.pid}: unknown (${errorMessage(error)})`,
        );
      }
    }
  }

  if (owner?.spawning || owner?.unknownChild) {
    console.error(
      "A Stryker child may be starting or is not recorded; confirm no stryker process is running first.",
    );
  }
  if (recoveryIsSafe(owner)) {
    console.error("Only after confirming no stryker process is running.");
    console.error(`rm -rf ${fencePath}`);
  }
}

function publishFence(runnerIdentity) {
  const parent = dirname(fencePath);
  mkdirSync(parent, { recursive: true });
  const pending = mkdtempSync(`${fencePath}.pending-`);
  let published = false;
  try {
    writeFileSync(
      join(pending, "owner.json"),
      `${JSON.stringify({ runner: runnerIdentity, children: [] }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    fsyncDirectory(pending);
    renameSync(pending, fencePath);
    published = true;
    fsyncDirectory(parent);
  } catch (error) {
    try {
      rmSync(published ? fencePath : pending, { recursive: true, force: true });
    } catch (cleanupError) {
      console.error(
        `Secondary failure while cleaning frontend mutation fence publication: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

function acquireFence(runnerIdentity) {
  while (true) {
    if (!existsSync(fencePath)) {
      try {
        publishFence(runnerIdentity);
        return true;
      } catch (error) {
        if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
        continue;
      }
    }

    let owner;
    try {
      owner = readOwner();
    } catch (error) {
      refuseFence(undefined, errorMessage(error));
      return false;
    }
    refuseFence(owner);
    return false;
  }
}

function runnerOwnsFence(runnerIdentity) {
  const owner = readOwner();
  return (
    owner?.runner.pid === runnerIdentity.pid && owner.runner.startTime === runnerIdentity.startTime
  );
}

function writeOwner(runnerIdentity, children, spawning = undefined) {
  if (!runnerOwnsFence(runnerIdentity)) {
    throw new Error("Frontend mutation fence owner changed during the run");
  }
  const record = {
    runner: runnerIdentity,
    children,
    ...(spawning ? { spawning } : {}),
  };
  durableWrite(ownerPath, `${JSON.stringify(record, null, 2)}\n`);
}

function resolveStrykerEntry(cwd) {
  let packagePath;
  try {
    packagePath = createRequire(join(cwd, "package.json")).resolve(
      "@stryker-mutator/core/package.json",
    );
  } catch (error) {
    throw new Error(`Cannot resolve the Stryker CLI from ${cwd}: ${error.message}`, {
      cause: error,
    });
  }
  const entry = join(dirname(packagePath), "bin", "stryker.js");
  if (!existsSync(entry)) {
    throw new Error(`Cannot resolve the Stryker CLI from ${cwd}: ${entry} does not exist`);
  }
  return entry;
}

function childEnvironment(mutationPackage, memoryBytes, cpuShare, incrementalDir = undefined) {
  const env = {
    ...process.env,
    STRYKER_PACKAGE: mutationPackage,
    STRYKER_MEMORY_BYTES: String(memoryBytes),
    GATE_CPU_SHARE: String(cpuShare),
  };
  delete env.STRYKER_INCREMENTAL_FILE;
  delete env.STRYKER_FORCE;
  if (incrementalDir) {
    env.STRYKER_INCREMENTAL_FILE = join(incrementalDir, `${mutationPackage}.json`);
    if (process.env.FRONTEND_MUTATION_FORCE === "1") env.STRYKER_FORCE = "1";
  }
  delete env.GATE_MEMORY_BYTES;
  return env;
}

function packageLogPath(mutationPackage) {
  return join("artifacts", "mutation", "frontend", mutationPackage, "stryker.log");
}

function printLogTail(path) {
  let contents;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    console.error(`Could not read ${path}: ${errorMessage(error)}`);
    return;
  }
  const tail = contents.slice(-logTailBytes).trimEnd();
  if (tail) console.error(`--- ${path} (tail) ---\n${tail}\n--- end ${path} ---`);
}

function describePackageFailure(mutationPackage, result, logPath) {
  if (result.spawnError) {
    console.error(
      `Frontend mutation package ${mutationPackage} failed to spawn: ${errorMessage(result.spawnError)}`,
    );
    printLogTail(logPath);
    return { exitCode: 127, message: errorMessage(result.spawnError) };
  }
  if (result.signal) {
    const exitCode = signalExitCode(result.signal, 1);
    console.error(
      `Frontend mutation package ${mutationPackage} was killed by ${result.signal} (exit ${exitCode}).`,
    );
    printLogTail(logPath);
    return { exitCode, message: result.signal };
  }
  const exitCode = result.code ?? 1;
  console.error(`Frontend mutation package ${mutationPackage} failed with exit ${exitCode}.`);
  printLogTail(logPath);
  return { exitCode, message: `exit ${exitCode}` };
}

async function runPackage(
  mutationPackage,
  {
    runnerIdentity,
    children,
    memoryBytes,
    cpuShare,
    incrementalDir,
    spawnChild,
    signalForwarding,
    onSpawnError,
    onPendingSpawn,
    onResolvedSpawn,
  },
) {
  const logPath = packageLogPath(mutationPackage);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "w");
  let child;
  let supervisor;
  console.log(`Frontend mutation package: ${mutationPackage}`);
  try {
    if (!runnerOwnsFence(runnerIdentity)) {
      throw new Error("Frontend mutation fence owner changed during the run");
    }
    writeOwner(runnerIdentity, children, mutationPackage);
    const strykerEntry = resolveStrykerEntry(process.cwd());
    try {
      child = spawnChild(process.execPath, [strykerEntry, "run"], {
        detached: true,
        env: childEnvironment(mutationPackage, memoryBytes, cpuShare, incrementalDir),
        stdio: ["ignore", logFd, logFd],
      });
    } catch (error) {
      writeOwner(runnerIdentity, children);
      return { failure: describePackageFailure(mutationPackage, { spawnError: error }, logPath) };
    }

    supervisor = superviseChild(child, { terminationTimeoutMs, killProcessGroup: true });
    signalForwarding.attach(supervisor, mutationPackage);
    child.once("error", (error) => onSpawnError(mutationPackage, error));
    if (child.pid === undefined) {
      let unresolved = true;
      onPendingSpawn();
      const resolveSpawn = () => {
        if (!unresolved) return;
        unresolved = false;
        onResolvedSpawn();
      };
      child.once("spawn", resolveSpawn);
      child.once("error", resolveSpawn);
      child.once("close", resolveSpawn);
    }
    const childIdentity = child.pid === undefined ? undefined : identityForPid(child.pid);
    if (childIdentity) {
      children.push(childIdentity);
      writeOwner(runnerIdentity, children);
    }

    const result = await supervisor.done;
    if (!childIdentity && child.pid === undefined) writeOwner(runnerIdentity, children);
    if (result.error) {
      return {
        failure: describePackageFailure(mutationPackage, { spawnError: result.error }, logPath),
      };
    }
    if (result.code === 0 && !result.signal) return {};
    return { failure: describePackageFailure(mutationPackage, result, logPath) };
  } finally {
    closeSync(logFd);
  }
}

/** Run frontend mutation packages; `spawnChild` is injectable for deterministic scheduler tests. */
export async function runFrontendMutation(spawnChild = spawn, { resultsDirectory } = {}) {
  const packageId = process.env.FRONTEND_MUTATION_PACKAGE;
  const selectedPackages = selectMutationPackages(
    packageRecords,
    packageId ? [packageId] : undefined,
    "FRONTEND_MUTATION_PACKAGE",
  );
  if (selectedPackages.length === 0) return 0;
  const incrementalDir = incrementalDirectory(
    resultsDirectory ?? process.env.FRONTEND_MUTATION_INCREMENTAL_DIR,
  );
  const base = process.env.FRONTEND_MUTATION_CHANGED_SINCE;
  if (await canSkipFrontendMutation(base)) {
    console.log(`Frontend mutation skipped: no mutation inputs changed since ${base}`);
    return 0;
  }
  const runnerIdentity = currentIdentity();
  if (!acquireFence(runnerIdentity)) return 1;

  const signalForwarding = installMultiChildSignalForwarding({ label: "frontend mutation" });
  const children = [];
  let resolveStopped;
  const stopRequested = new Promise((resolve) => {
    resolveStopped = resolve;
  });
  const halted = Promise.race([stopRequested, signalForwarding.signalRequested]).then(() => ({
    halted: true,
  }));
  let exitCode = 0;
  let cleanupFailed = false;
  try {
    const budgetBytes = gateBudgetBytes();
    const { slots, cpuShare } = strykerSlots({
      budgetBytes,
      packageCount: selectedPackages.length,
    });
    const memoryBytes = Math.floor(budgetBytes / slots);

    // Stryker cannot clean a sandbox after SIGKILL; only the fence owner may purge it at start.
    rmSync(".stryker-tmp", { recursive: true, force: true });
    if (incrementalDir) mkdirSync(incrementalDir, { recursive: true });

    let nextPackage = 0;
    let admissionOpen = true;
    let firstFailure;
    let pendingSpawns = 0;
    const pendingSpawnWaiters = new Set();
    const onPendingSpawn = () => {
      pendingSpawns += 1;
    };
    const onResolvedSpawn = () => {
      pendingSpawns -= 1;
      if (pendingSpawns === 0) {
        for (const resolve of pendingSpawnWaiters) resolve();
        pendingSpawnWaiters.clear();
      }
    };
    const waitForPendingSpawns = () => {
      if (pendingSpawns === 0) return Promise.resolve();
      return new Promise((resolve) => pendingSpawnWaiters.add(resolve));
    };
    const reportCleanupFailure = (error) => {
      cleanupFailed = true;
      console.error(error);
      console.error(`The frontend mutation fence remains at ${fencePath}.`);
    };
    const stopForFailure = async (failure) => {
      if (!firstFailure) {
        firstFailure = failure;
        exitCode = failure.exitCode;
        admissionOpen = false;
        try {
          await signalForwarding.terminateAll();
        } catch (error) {
          reportCleanupFailure(error);
        } finally {
          resolveStopped();
        }
      }
    };

    const runSlot = async () => {
      while (admissionOpen && !signalForwarding.requestedSignal) {
        if (nextPackage >= slots) {
          await Promise.race([waitForPendingSpawns(), halted]);
          if (!admissionOpen || signalForwarding.requestedSignal) return;
        }
        const packageIndex = nextPackage;
        if (packageIndex >= selectedPackages.length) return;
        nextPackage += 1;
        const mutationPackage = selectedPackages[packageIndex];
        try {
          const runningPackage = runPackage(mutationPackage.id, {
            runnerIdentity,
            children,
            memoryBytes,
            cpuShare,
            incrementalDir,
            spawnChild,
            signalForwarding,
            onPendingSpawn,
            onResolvedSpawn,
            onSpawnError: (name, error) => {
              void stopForFailure({ exitCode: 127, message: `${name}: ${errorMessage(error)}` });
            },
          }).then(
            (result) => ({ result }),
            (error) => ({ error }),
          );
          const outcome = await Promise.race([runningPackage, halted]);
          if (outcome.halted) return;
          if (outcome.error) throw outcome.error;
          const { result } = outcome;
          if (signalForwarding.requestedSignal) return;
          if (result.failure) await stopForFailure(result.failure);
        } catch (error) {
          console.error(
            `Frontend mutation runner failed while starting ${mutationPackage}: ${errorMessage(error)}`,
          );
          await stopForFailure({ exitCode: 1, message: errorMessage(error) });
        }
      }
    };

    await Promise.all(Array.from({ length: slots }, () => runSlot()));
  } catch (error) {
    console.error(error);
    exitCode = 1;
    try {
      await signalForwarding.terminateAll();
    } catch (cleanupError) {
      cleanupFailed = true;
      console.error(cleanupError);
    } finally {
      resolveStopped();
    }
  } finally {
    try {
      await signalForwarding.termination;
    } catch (error) {
      cleanupFailed = true;
      console.error(error);
    }
    if (cleanupFailed) {
      console.error(`The frontend mutation fence remains at ${fencePath}.`);
      exitCode = exitCode || 1;
    } else {
      let fenceRemoved = false;
      try {
        if (runnerOwnsFence(runnerIdentity)) {
          rmSync(fencePath, { recursive: true });
          fenceRemoved = true;
        } else {
          console.error("Frontend mutation fence owner changed; leaving the fence in place.");
          exitCode = 1;
        }
      } catch (error) {
        console.error(
          `Cannot verify frontend mutation fence ownership; leaving the fence in place: ${errorMessage(error)}`,
        );
        exitCode = 1;
      }
      if (fenceRemoved) {
        try {
          fsyncDirectory(dirname(fencePath));
        } catch (error) {
          console.error(
            `Frontend mutation fence removed, directory sync failed: ${errorMessage(error)}`,
          );
          exitCode = 1;
        }
      }
    }
    signalForwarding.uninstall();
  }

  if (signalForwarding.requestedSignal) {
    return signalForwarding.requestedSignal === "SIGINT" ? 130 : 143;
  }
  return exitCode;
}

async function main() {
  if (process.argv.includes("--list-packages")) {
    console.log(JSON.stringify(Object.keys(mutationPackages)));
    return 0;
  }
  // CI brings its own bounded cache, and an explicit directory or --full names its own proof.
  if (
    process.env.CI ||
    process.env.FRONTEND_MUTATION_INCREMENTAL_DIR ||
    process.argv.includes("--full")
  )
    return runFrontendMutation();
  // The runner installs its own forwarding only once it starts, so a signal during the
  // download is handled here: it stops the commands and the directory is still removed.
  const controller = new AbortController();
  let requestedSignal;
  const onSignal = (signal) => {
    requestedSignal = signal;
    controller.abort();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const resultsDirectory = await fetchDailySweepResults(Object.keys(mutationPackages), {
    signal: controller.signal,
  });
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  try {
    if (requestedSignal) return requestedSignal === "SIGINT" ? 130 : 143;
    return await runFrontendMutation(spawn, { resultsDirectory });
  } finally {
    rmSync(resultsDirectory, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
