import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  STRYKER_PARENT_BYTES,
  STRYKER_RUNNER_BYTES,
  strykerSlots,
  workerCount,
} from "./gate-parallelism.mjs";
import { mutationPackages } from "./frontend-mutation-packages.mjs";
import {
  isAlive,
  runMutationRunner,
  runMutationRunnerWithNodeArgs,
  startMutationRunner,
  waitFor,
  waitUntil,
  writeShim,
} from "./mutation-runner-test-harness.mjs";
import { fetchDailySweepResults, isRecentSweep } from "./frontend-mutation-baseline.mjs";
import { currentIdentity, identityForPid } from "./process-identity.mjs";
import {
  canSkipFrontendMutation,
  frontendMutationInputs,
  recoveryIsSafe,
} from "./run-frontend-mutation.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(projectRoot, "scripts", "run-frontend-mutation.mjs");
const fence = "mutants.out/frontend/.mutation-in-progress";
const packageNames = Object.keys(mutationPackages);
const budgetBytes = 90 * 1024 ** 3;
const requireFromProject = createRequire(import.meta.url);
const requireFromStryker = createRequire(
  requireFromProject.resolve("@stryker-mutator/core/package.json"),
);
const { Minimatch } = requireFromStryker("minimatch");

function strykerIgnoresFile(pattern, filePath) {
  const rule = new Minimatch(pattern, { dot: true, flipNegate: true, nocase: true });
  const directories = filePath.split("/").slice(0, -1);
  return directories.some((_, index) => {
    const entryName = directories[index];
    const entryPath = directories.slice(0, index + 1).join("/");
    return (
      rule.match(entryName) ||
      rule.match(entryPath) ||
      rule.match(`/${entryPath}`) ||
      rule.match(`/${entryPath}/`) ||
      rule.match(`${entryPath}/`)
    );
  });
}

// The quarter-CPU bias keeps floor(cpuCount × share) at the requested slots despite floating-point rounding.
const CPU_SHARE_ROUNDING_BIAS = 0.25;

function cpuShareForSlots(requestedSlots, cpuCount = availableParallelism()) {
  const slots = Math.min(requestedSlots, cpuCount);
  return slots === cpuCount ? "1" : String((slots + CPU_SHARE_ROUNDING_BIAS) / cpuCount);
}

async function fixture(t = undefined) {
  const root = await mkdtemp(join(tmpdir(), "frontend-mutation-runner-"));
  const state = join(root, "shim-state");
  await mkdir(state);
  if (t) t.after(() => rm(root, { recursive: true, force: true }));
  const packageDirectory = join(root, "node_modules", "@stryker-mutator", "core");
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({
      name: "@stryker-mutator/core",
      type: "module",
      exports: { "./package.json": "./package.json" },
    })}\n`,
  );
  await writeShim(
    join(packageDirectory, "bin", "stryker.js"),
    [
      "#!/usr/bin/env node",
      'import { spawn } from "node:child_process";',
      'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      "const state = process.env.SHIM_STATE;",
      "const name = process.env.STRYKER_PACKAGE;",
      "const mode = process.env.SHIM_MODE;",
      "const marker = (suffix) => join(state, `${suffix}-${name}`);",
      'writeFileSync(marker("booting"), "");',
      'if (mode === "startup-delay") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_000);',
      'appendFileSync(join(state, "packages"), `${name}\\n`);',
      'writeFileSync(marker("pid"), `${process.pid}\\n`);',
      'writeFileSync(marker("env"), JSON.stringify({',
      "  memory: process.env.STRYKER_MEMORY_BYTES,",
      "  cpuShare: process.env.GATE_CPU_SHARE,",
      "  incrementalFile: process.env.STRYKER_INCREMENTAL_FILE,",
      "  force: process.env.STRYKER_FORCE,",
      '  gateMemoryPresent: Object.hasOwn(process.env, "GATE_MEMORY_BYTES"),',
      "}));",
      "console.log(`known stdout from ${name}`);",
      "console.error(`known stderr from ${name}`);",
      'if (["block", "grandchild-exit", "ignore-term", "kill-after-peer"].includes(mode)) {',
      '  const grandchild = spawn("/bin/sleep", ["30"], { detached: false, stdio: "ignore" });',
      '  writeFileSync(marker("grandchild-pid"), `${grandchild.pid}\\n`);',
      "  grandchild.unref();",
      "}",
      'writeFileSync(marker("started"), "");',
      "if (name === process.env.FAIL_PACKAGE) {",
      "  const peerStarted = join(state, `started-${process.env.FAIL_PEER}`);",
      "  const failTimer = setInterval(() => { if (!process.env.FAIL_PEER || existsSync(peerStarted)) { clearInterval(failTimer); process.exit(7); } }, 5);",
      "}",
      "function recordTermination() {",
      '  if (existsSync("mutants.out/frontend/.mutation-in-progress")) writeFileSync(marker("terminated-with-fence"), "");',
      '  writeFileSync(marker("terminated"), "");',
      "  process.exit(0);",
      "}",
      'if (mode === "grandchild-exit") {',
      "  process.exit(0);",
      '} else if (mode === "kill-after-peer" && name === process.env.KILL_PACKAGE) {',
      '  const peerStarted = marker("unused").replace(`unused-${name}`, `started-${process.env.KILL_PEER}`);',
      "  const timer = setInterval(() => {",
      '    if (existsSync(peerStarted)) { clearInterval(timer); process.kill(process.pid, "SIGKILL"); }',
      "  }, 5);",
      '} else if (["block", "ignore-term", "kill-after-peer"].includes(mode)) {',
      '  if (mode === "ignore-term") { process.on("SIGTERM", () => {}); process.on("SIGINT", () => {}); }',
      '  else { process.on("SIGTERM", recordTermination); process.on("SIGINT", recordTermination); }',
      "  const timer = setInterval(() => {",
      '    if (existsSync(join(state, "release")) || existsSync(marker("release"))) { clearInterval(timer); process.exit(0); }',
      "  }, 20);",
      '} else if (mode === "record") {',
      "  process.exit(0);",
      "}",
      "",
    ].join("\n"),
  );
  return { root, state };
}

function environment({ state, mode = "normal", failPackage, requestedSlots = 3, ...extra }) {
  const env = {
    ...process.env,
    CI: "1",
    GATE_MEMORY_BYTES: String(budgetBytes),
    GATE_CPU_SHARE: cpuShareForSlots(requestedSlots),
    SHIM_MODE: mode,
    SHIM_STATE: state,
    ...(failPackage ? { FAIL_PACKAGE: failPackage } : {}),
    ...extra,
  };
  delete env.STRYKER_MEMORY_BYTES;
  return env;
}

const run = (root, env, args = []) => runMutationRunner(runner, root, env, args);
const start = (t, root, env, options = {}) => startMutationRunner(t, runner, root, env, options);

async function waitForRecordedChild(root, timeoutMs = 5_000) {
  const path = join(root, fence, "owner.json");
  return waitUntil(
    async () => {
      let source;
      try {
        source = await readFile(path, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") {
          return false;
        }
        throw error;
      }
      const owner = JSON.parse(source);
      return owner.children?.length > 0 && !owner.spawning ? owner : false;
    },
    `Timed out waiting for a child identity in ${path}`,
    timeoutMs,
  );
}

async function seedFence(root, owner) {
  const path = join(root, fence);
  await mkdir(path, { recursive: true });
  if (owner !== undefined) await writeFile(join(path, "owner.json"), `${JSON.stringify(owner)}\n`);
}

function deadIdentity(pid = 2_000_000_001) {
  return { pid, startTime: "1" };
}

function deadOwner(overrides = {}) {
  return {
    runner: deadIdentity(2_000_000_000),
    children: [deadIdentity()],
    ...overrides,
  };
}

async function writeCpuPreload(path) {
  await writeFile(
    path,
    [
      'import os from "node:os";',
      'import { syncBuiltinESMExports } from "node:module";',
      "os.availableParallelism = () => Number(process.env.TEST_AVAILABLE_CPUS);",
      "syncBuiltinESMExports();",
      "",
    ].join("\n"),
  );
}

function startInjectedRunner(t, root, env, source, nodeArgs = []) {
  const script = join(root, "injected-runner.mjs");
  return writeFile(script, source).then(async () => {
    await chmod(script, 0o755);
    return startMutationRunner(t, script, root, env, { nodeArgs });
  });
}

test("--list-packages prints the shared package map without creating a fence", async (t) => {
  const { root, state } = await fixture(t);
  const result = run(root, environment({ state }), ["--list-packages"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), packageNames);
  assert.equal(existsSync(join(root, fence)), false);
});

test("CI package selection runs exactly one complete package and rejects unknown ids", async (t) => {
  const { root, state } = await fixture(t);
  const env = environment({ state, mode: "record", FRONTEND_MUTATION_PACKAGE: "game-practice" });
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(state, "packages"), "utf8"), "game-practice\n");
  assert.equal(
    JSON.parse(await readFile(join(state, "env-game-practice"), "utf8")).files,
    undefined,
  );
  const invalid = run(root, { ...env, FRONTEND_MUTATION_PACKAGE: "unknown" });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Unknown FRONTEND_MUTATION_PACKAGE: unknown/u);
  assert.equal(existsSync(join(root, fence)), false);
});

const changeBase = "a".repeat(40);

function fakeChangeGit(paths, failure = undefined) {
  return (_command, args) => {
    if (failure) return failure;
    return {
      status: 0,
      stdout:
        args[0] === "rev-parse" ? `${changeBase}\n` : paths.map((path) => `${path}\0`).join(""),
    };
  };
}

test("change skip uses the frontend superset and transitive runner/config imports", async () => {
  const inputs = await frontendMutationInputs();
  for (const path of [
    "src/other.test.ts",
    "public/asset.png",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json",
    "pnpm-lock.yaml",
    "stryker.config.mjs",
    "scripts/run-frontend-mutation.mjs",
    "scripts/run-push-gates.mjs",
    "scripts/child-supervisor.mjs",
    "scripts/fsync-directory.mjs",
    "scripts/gate-parallelism.mjs",
    "scripts/process-identity.mjs",
    "scripts/mutation-package-selection.mjs",
    "scripts/parse-ts-source.mjs",
    ".github/workflows/test.yml",
    ".github/actions/setup-ci/action.yml",
    ".github/actions/other/helper.sh",
  ]) {
    assert.equal(
      await canSkipFrontendMutation(changeBase, {
        runGit: fakeChangeGit([path]),
        getInputs: () => inputs,
      }),
      false,
      path,
    );
  }
  for (const paths of [[], ["tasks/record.md", "src-tauri/src/main.rs"]]) {
    assert.equal(
      await canSkipFrontendMutation(changeBase, {
        runGit: fakeChangeGit(paths),
        getInputs: () => inputs,
      }),
      true,
    );
  }
});

test("change skip compares the base commit with HEAD in a real Git repository", async (t) => {
  for (const [path, expectedSkip] of [
    ["src/x.ts", false],
    ["tasks/notes.md", true],
    ["tsconfig.json", false],
  ]) {
    await t.test(path, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "frontend-mutation-git-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const git = (args) => {
        const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git(["init", "--quiet"]);
      git(["config", "user.name", "Mutation fixture"]);
      git(["config", "user.email", "mutation-fixture@example.invalid"]);
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "base\n");
      git(["add", "--", path]);
      git(["commit", "--quiet", "-m", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      await writeFile(join(root, path), "changed\n");
      git(["add", "--", path]);
      git(["commit", "--quiet", "-m", "change"]);

      assert.equal(await canSkipFrontendMutation(base, { cwd: root }), expectedSkip);
    });
  }
});

test("change skip fails open on invalid bases, failed Git and uncertain input discovery", async () => {
  for (const base of [undefined, "", "0".repeat(40), "garbage", "HEAD", "--help"]) {
    assert.equal(
      await canSkipFrontendMutation(base, {
        runGit: () => {
          throw new Error("must not query Git");
        },
      }),
      false,
    );
  }
  for (const failure of [
    { status: 128, stderr: "unreachable" },
    { status: null, error: new Error("git failed") },
  ]) {
    assert.equal(
      await canSkipFrontendMutation(changeBase, { runGit: fakeChangeGit([], failure) }),
      false,
    );
  }
  for (const output of [{ status: 1 }, { status: 0, stdout: "unparseable" }]) {
    assert.equal(
      await canSkipFrontendMutation(changeBase, {
        runGit: (command, args) => (args[0] === "diff" ? output : fakeChangeGit([])(command, args)),
      }),
      false,
    );
  }
  assert.equal(
    await canSkipFrontendMutation(changeBase, {
      runGit: fakeChangeGit([]),
      getInputs: () => {
        throw new Error("unreadable module");
      },
    }),
    false,
  );
});

test("CLI change skip prints the base before touching an existing fence or sandbox", async (t) => {
  const { root, state } = await fixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeShim(
    join(bin, "git"),
    `#!/usr/bin/env node\nprocess.stdout.write(process.argv[2] === "rev-parse" ? ${JSON.stringify(`${changeBase}\n`)} : "tasks/record.md\\0");\n`,
  );
  await seedFence(root, deadOwner());
  await mkdir(join(root, ".stryker-tmp"));
  await writeFile(join(root, ".stryker-tmp", "keep"), "keep");
  const result = run(
    root,
    environment({
      state,
      FRONTEND_MUTATION_CHANGED_SINCE: changeBase,
      PATH: `${bin}:${process.env.PATH}`,
    }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    `Frontend mutation skipped: no mutation inputs changed since ${changeBase}\n`,
  );
  assert.equal(existsSync(join(root, fence)), true);
  assert.equal(await readFile(join(root, ".stryker-tmp", "keep"), "utf8"), "keep");
  assert.equal(existsSync(join(state, "packages")), false);
});

test("incremental files are per-package, force needs a directory and defaults clear inherited Stryker modes", async (t) => {
  for (const mode of ["unset", "force-only", "incremental", "forced"]) {
    const { root, state } = await fixture(t);
    const directory = join(root, "cache");
    const useIncremental = ["incremental", "forced"].includes(mode);
    const result = run(
      root,
      environment({
        state,
        mode: "record",
        STRYKER_INCREMENTAL_FILE: "inherited.json",
        STRYKER_FORCE: "1",
        ...(useIncremental ? { FRONTEND_MUTATION_INCREMENTAL_DIR: directory } : {}),
        ...(["force-only", "forced"].includes(mode) ? { FRONTEND_MUTATION_FORCE: "1" } : {}),
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    for (const name of packageNames) {
      const childEnv = JSON.parse(await readFile(join(state, `env-${name}`), "utf8"));
      assert.equal(
        childEnv.incrementalFile,
        useIncremental ? join(directory, `${name}.json`) : undefined,
      );
      assert.equal(childEnv.force, mode === "forced" ? "1" : undefined);
      const config = runConfigImport({
        ...process.env,
        STRYKER_PACKAGE: name,
        STRYKER_MEMORY_BYTES: String(STRYKER_PARENT_BYTES + STRYKER_RUNNER_BYTES),
        PRINT_INCREMENTAL: "1",
        STRYKER_INCREMENTAL_FILE: childEnv.incrementalFile ?? "",
        STRYKER_FORCE: childEnv.force ?? "",
      });
      assert.equal(config.status, 0, config.stderr);
      assert.deepEqual(
        JSON.parse(config.stdout),
        useIncremental
          ? {
              incremental: true,
              incrementalFile: childEnv.incrementalFile,
              force: mode === "forced",
            }
          : {},
      );
    }
  }
});

test("incremental directories inside the purge root, including symlinks, are refused before the fence", async (t) => {
  const { root, state } = await fixture(t);
  await mkdir(join(root, ".stryker-tmp"));
  await symlink(join(root, ".stryker-tmp"), join(root, "alias"));
  for (const directory of [".stryker-tmp", ".stryker-tmp/cache", "alias/cache"]) {
    const result = run(root, environment({ state, FRONTEND_MUTATION_INCREMENTAL_DIR: directory }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must lie outside .stryker-tmp/u);
    assert.equal(existsSync(join(root, fence)), false);
    assert.equal(existsSync(join(state, "packages")), false);
  }
});

test("an invalid gate memory budget starts no Stryker package and removes its fence", async (t) => {
  const { root, state } = await fixture(t);
  const result = run(root, environment({ state, GATE_MEMORY_BYTES: "abc" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /GATE_MEMORY_BYTES/u);
  for (const name of packageNames) {
    assert.equal(existsSync(join(state, `booting-${name}`)), false);
  }
  assert.equal(existsSync(join(root, fence)), false);
});

test("PG-129/132/133/134/137: importing the runner is silent with and without --list-packages", async (t) => {
  const { root, state } = await fixture(t);
  const script = [
    'import { writeFileSync } from "node:fs";',
    "await import(process.env.RUNNER_URL);",
    'writeFileSync(process.env.IMPORT_MARKER, JSON.stringify({ exitCode: typeof process.exitCode === "undefined" ? "undefined" : process.exitCode }));',
    "",
  ].join("\n");
  for (const args of [[], ["--list-packages"]]) {
    const marker = join(state, `import-${args.length}.json`);
    const env = {
      ...process.env,
      RUNNER_URL: pathToFileURL(runner).href,
      IMPORT_MARKER: marker,
    };
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, ...(args.length > 0 ? ["--", ...args] : [])],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(marker, "utf8"), JSON.stringify({ exitCode: "undefined" }));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("PG-86/103: normal runs schedule every package and isolate child env and logs", async (t) => {
  const { root, state } = await fixture(t);
  const env = environment({ state, mode: "record" });
  const plan = strykerSlots({ budgetBytes, env, availableParallelism });
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    (await readFile(join(state, "packages"), "utf8")).trim().split("\n").sort(),
    [...packageNames].sort(),
  );
  assert.equal(
    result.stdout.split(/\r?\n/u).filter((line) => line.startsWith("Frontend mutation package:"))
      .length,
    packageNames.length,
  );
  for (const name of packageNames) {
    const childEnv = JSON.parse(await readFile(join(state, `env-${name}`), "utf8"));
    assert.equal(childEnv.memory, String(Math.floor(budgetBytes / plan.slots)));
    assert.equal(childEnv.cpuShare, String(plan.cpuShare));
    assert.equal(childEnv.gateMemoryPresent, false);
    const log = await readFile(
      join(root, "artifacts", "mutation", "frontend", name, "stryker.log"),
      "utf8",
    );
    assert.match(log, new RegExp(`known stdout from ${name}`, "u"));
    assert.match(log, new RegExp(`known stderr from ${name}`, "u"));
    assert.doesNotMatch(result.stdout, new RegExp(`known stdout from ${name}`, "u"));
  }
  assert.equal(existsSync(join(root, fence)), false);
});

test("PG-42/57: a one-CPU runner gives each queued child the entire budget", async (t) => {
  const { root, state } = await fixture(t);
  const preload = join(state, "one-cpu-preload.mjs");
  await writeCpuPreload(preload);
  const env = {
    ...environment({ state, mode: "record", requestedSlots: 1 }),
    TEST_AVAILABLE_CPUS: "1",
    GATE_CPU_SHARE: "1",
  };
  const result = runMutationRunnerWithNodeArgs(runner, root, env, ["--import", preload]);
  assert.equal(result.status, 0, result.stderr);
  for (const name of packageNames) {
    const childEnv = JSON.parse(await readFile(join(state, `env-${name}`), "utf8"));
    assert.equal(childEnv.memory, String(budgetBytes));
    assert.equal(childEnv.cpuShare, "1");
  }
});

test("PG-90/103: the first red package terminates active siblings and never starts queued work", async (t) => {
  const { root, state } = await fixture(t);
  const [failed, sibling, queued] = packageNames;
  const result = run(
    root,
    environment({
      state,
      mode: "block",
      failPackage: failed,
      FAIL_PEER: sibling,
      requestedSlots: 2,
    }),
  );
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stderr, new RegExp(`package ${failed} failed with exit 7`, "u"));
  assert.match(result.stderr, new RegExp(`known stdout from ${failed}`, "u"));
  const started = (await readFile(join(state, "packages"), "utf8")).trim().split("\n");
  assert.deepEqual(started.sort(), [failed, sibling].sort());
  assert.equal(existsSync(join(state, `terminated-${sibling}`)), true);
  assert.equal(isAlive(Number(await readFile(join(state, `pid-${sibling}`), "utf8"))), false);
  assert.equal(existsSync(join(state, `started-${queued}`)), false);
  assert.equal(existsSync(join(root, fence)), false);
});

test("a missing Stryker CLI is reported clearly and removes the fence", async (t) => {
  const { root, state } = await fixture(t);
  await rm(join(root, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js"));
  const result = run(root, environment({ state, requestedSlots: 1 }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot resolve the Stryker CLI.*stryker\.js does not exist/su);
  assert.equal(existsSync(join(root, fence)), false);
});

test("a concurrent runner refuses a live owner without touching its sandbox", async (t) => {
  const { root, state } = await fixture(t);
  const env = environment({ state, mode: "block", requestedSlots: 1 });
  const first = start(t, root, env);
  await waitFor(join(state, `started-${packageNames[0]}`));
  const childPid = Number(await readFile(join(state, `pid-${packageNames[0]}`), "utf8"));
  const owner = await waitForRecordedChild(root);
  assert.equal(owner.runner.pid, first.child.pid);
  assert.equal(owner.children[0].pid, childPid);
  assert.equal(typeof owner.children[0].startTime, "string");
  assert.equal(owner.spawning, undefined);
  await mkdir(join(root, ".stryker-tmp"));
  await writeFile(join(root, ".stryker-tmp", "live"), "keep\n");
  const second = run(root, env);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Frontend mutation fence exists: mutants\.out\/frontend/u);
  assert.equal(await readFile(join(root, ".stryker-tmp", "live"), "utf8"), "keep\n");
  await writeFile(join(state, "release"), "");
  assert.equal((await first.done).code, 0);
});

test("PG-112/113/114: waitForRecordedChild retries ENOENT and propagates owner parse errors", async (t) => {
  const { root } = await fixture(t);
  await seedFence(root);
  const waiting = waitForRecordedChild(root, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 25));
  await writeFile(
    join(root, fence, "owner.json"),
    `${JSON.stringify({ runner: deadIdentity(2_000_000_000), children: [deadIdentity()] })}\n`,
  );
  const owner = await waiting;
  assert.equal(owner.children.length, 1);
  await writeFile(join(root, fence, "owner.json"), "not json\n");
  await assert.rejects(waitForRecordedChild(root), SyntaxError);
});

test("PG-101/122: dead runners with mixed dead and live children withhold recovery", async (t) => {
  const { root, state } = await fixture(t);
  await seedFence(root, deadOwner({ children: [deadIdentity(), currentIdentity()] }));
  const result = run(root, environment({ state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recorded child 2 pid .*: alive/u);
  assert.doesNotMatch(result.stderr, /rm -rf mutants\.out\/frontend/u);
});

test("PG-105: a live legacy {runner, child} fence is refused as alive", async (t) => {
  const { root, state } = await fixture(t);
  await seedFence(root, {
    runner: deadIdentity(2_000_000_000),
    child: currentIdentity(),
  });
  const result = run(root, environment({ state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recorded runner pid 2000000000: dead/u);
  assert.match(result.stderr, /Recorded child 1 pid .*: alive/u);
  assert.doesNotMatch(result.stderr, /rm -rf mutants\.out\/frontend/u);
});

test("a missing owner record is treated as unknown and refused without recovery", async (t) => {
  const { root, state } = await fixture(t);
  await seedFence(root);
  const result = run(root, environment({ state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner record missing or malformed/u);
  assert.doesNotMatch(result.stderr, /rm -rf mutants\.out\/frontend/u);
  assert.equal(existsSync(join(root, fence)), true);
});

test("a malformed owner record is treated as unknown and refused without recovery", async (t) => {
  const { root, state } = await fixture(t);
  await seedFence(root);
  await writeFile(join(root, fence, "owner.json"), "not json\n");
  const result = run(root, environment({ state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /owner record missing or malformed/u);
  assert.doesNotMatch(result.stderr, /rm -rf mutants\.out\/frontend/u);
});

test("an unreadable owner record surfaces its cause and is refused", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses the file permission this test relies on");
    return;
  }
  const { root, state } = await fixture(t);
  await seedFence(root, deadOwner());
  const ownerPath = join(root, fence, "owner.json");
  await chmod(ownerPath, 0o000);
  const result = run(root, environment({ state }));
  await chmod(ownerPath, 0o600);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Cannot determine whether the fence owner is alive:.*(?:EACCES|permission denied)/su,
  );
  assert.doesNotMatch(result.stderr, /rm -rf mutants\.out\/frontend/u);
});

test("PG-101: a dead runner with no recorded children is refused with recovery", async (t) => {
  const { root, state } = await fixture(t);
  await seedFence(root, deadOwner({ children: [] }));
  const result = run(root, environment({ state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Recorded runner pid 2000000000: dead/u);
  assert.match(result.stderr, /Only after confirming no stryker process is running\./u);
  assert.match(result.stderr, /rm -rf mutants\.out\/frontend\/\.mutation-in-progress/u);
});

test("PG-106: a dead runner with spawning set or legacy child null withholds recovery", async (t) => {
  const { root, state } = await fixture(t);
  for (const owner of [
    { runner: deadIdentity(2_000_000_000), children: [], spawning: packageNames[0] },
    { runner: deadIdentity(2_000_000_000), child: null },
  ]) {
    await seedFence(root, owner);
    const result = run(root, environment({ state }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /may be starting or is not recorded/u);
    assert.doesNotMatch(result.stderr, /rm -rf mutants\.out\/frontend/u);
    await rm(join(root, fence), { recursive: true, force: true });
  }
});

for (const [name, failure] of [
  ["EPERM", Object.assign(new Error("permission denied"), { code: "EPERM" })],
  ["unexpected errors", new Error("unexpected probe failure")],
]) {
  test(`PG-125: recovery is withheld when a process-group probe fails with ${name}`, () => {
    const owner = {
      runner: deadIdentity(2_000_000_000),
      children: [deadIdentity()],
      unknownChild: false,
    };
    assert.equal(
      recoveryIsSafe(owner, {
        identityIsLive: () => false,
        processGroupProbe() {
          throw failure;
        },
      }),
      false,
    );
  });
}

test("PG-102: the finaliser preserves a replaced owner after the child identity is recorded", async (t) => {
  const { root, state } = await fixture(t);
  const running = start(t, root, environment({ state, mode: "block", requestedSlots: 1 }));
  await waitFor(join(state, `started-${packageNames[0]}`));
  const owner = await waitForRecordedChild(root);
  assert.equal(
    owner.children[0].pid,
    Number(await readFile(join(state, `pid-${packageNames[0]}`), "utf8")),
  );
  await writeFile(join(root, fence, "owner.json"), `${JSON.stringify(deadOwner())}\n`);
  await writeFile(join(state, "release"), "");
  const result = await running.done;
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /fence owner changed; leaving the fence in place/u);
  assert.equal(existsSync(join(root, fence)), true);
});

test("PG-102 regression: a foreign owner written inside spawn is preserved and stops the run", async (t) => {
  const { root, state } = await fixture(t);
  const firstPackage = packageNames[0];
  const foreignOwner = deadOwner();
  const shimPath = join(root, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js");
  await writeShim(
    shimPath,
    [
      'import { writeFileSync } from "node:fs";',
      "const state = process.env.SHIM_STATE;",
      "const name = process.env.STRYKER_PACKAGE;",
      'process.on("SIGTERM", () => { writeFileSync(`${state}/terminated-${name}`, ""); process.exit(0); });',
      'process.on("SIGINT", () => { writeFileSync(`${state}/terminated-${name}`, ""); process.exit(0); });',
      'writeFileSync(`${state}/ready-${name}`, "");',
      "setTimeout(() => process.exit(0), 3_000);",
      "",
    ].join("\n"),
  );
  const injectedSource = [
    'import { spawn } from "node:child_process";',
    'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
    "const { runFrontendMutation } = await import(process.env.RUNNER_URL);",
    "const result = await runFrontendMutation((command, args, options) => {",
    "  const name = options.env.STRYKER_PACKAGE;",
    '  appendFileSync(process.env.SHIM_STATE + "/spawned-packages", `${name}\\n`);',
    "  const child = spawn(command, args, options);",
    "  if (name === process.env.FOREIGN_OWNER_PACKAGE) {",
    '    const ready = process.env.SHIM_STATE + "/ready-" + name;',
    "    const deadline = Date.now() + 5_000;",
    "    const pause = new Int32Array(new SharedArrayBuffer(4));",
    "    while (!existsSync(ready) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 5);",
    '    if (!existsSync(ready)) { child.kill("SIGKILL"); throw new Error("fake child did not become ready"); }',
    '    writeFileSync("mutants.out/frontend/.mutation-in-progress/owner.json", `${process.env.FOREIGN_OWNER_JSON}\\n`);',
    '    writeFileSync(process.env.SHIM_STATE + "/foreign-child-pid", `${child.pid}\\n`);',
    "  }",
    "  return child;",
    "});",
    "process.exitCode = result;",
    "",
  ].join("\n");
  const env = environment({
    state,
    requestedSlots: 1,
    RUNNER_URL: pathToFileURL(runner).href,
    FOREIGN_OWNER_PACKAGE: firstPackage,
    FOREIGN_OWNER_JSON: JSON.stringify(foreignOwner),
  });
  const running = await startInjectedRunner(t, root, env, injectedSource);
  const result = await running.done;
  const childPid = Number(await readFile(join(state, "foreign-child-pid"), "utf8"));
  assert.notEqual(result.code, 0, result.stderr);
  assert.match(result.stderr, /fence owner changed/u);
  assert.equal(existsSync(join(root, fence)), true);
  assert.deepEqual(
    JSON.parse(await readFile(join(root, fence, "owner.json"), "utf8")),
    foreignOwner,
  );
  assert.equal(existsSync(join(state, `terminated-${firstPackage}`)), true);
  assert.equal(isAlive(childPid), false, `fake child pid ${childPid} is still alive`);
  assert.deepEqual((await readFile(join(state, "spawned-packages"), "utf8")).trim().split("\n"), [
    firstPackage,
  ]);
});

test("PG-122: recovery waits for a dead child leader's surviving process group", async (t) => {
  const { root, state } = await fixture(t);
  const leaderPath = join(state, "group-leader.mjs");
  await writeFile(
    leaderPath,
    [
      'import { spawn } from "node:child_process";',
      'import { existsSync, writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'const grandchild = spawn("/bin/sleep", ["30"], { detached: false, stdio: "ignore" });',
      'writeFileSync(join(process.env.SHIM_STATE, "group-grandchild"), `${grandchild.pid}\\n`);',
      'writeFileSync(join(process.env.SHIM_STATE, "group-ready"), "");',
      'const timer = setInterval(() => { if (existsSync(join(process.env.SHIM_STATE, "release-leader"))) { clearInterval(timer); process.exit(0); } }, 10);',
      "",
    ].join("\n"),
  );
  const leader = spawn(process.execPath, [leaderPath], {
    cwd: root,
    env: { ...process.env, SHIM_STATE: state },
    detached: true,
    stdio: "ignore",
  });
  const closed = new Promise((resolve) => leader.once("close", resolve));
  t.after(() => {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch {
      // The process group has already exited.
    }
  });
  await waitFor(join(state, "group-ready"));
  const identity = identityForPid(leader.pid);
  assert.ok(identity);
  const grandchildPid = Number(await readFile(join(state, "group-grandchild"), "utf8"));
  await writeFile(join(state, "release-leader"), "");
  await closed;
  await seedFence(root, deadOwner({ children: [identity] }));
  const blocked = run(root, environment({ state }));
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Recorded child 1 process group: not empty or unknown/u);
  assert.doesNotMatch(blocked.stderr, /rm -rf mutants\.out\/frontend/u);
  try {
    process.kill(-leader.pid, "SIGKILL");
  } catch {
    // The group may already be gone.
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isAlive(grandchildPid)) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const recoverable = run(root, environment({ state }));
  assert.equal(recoverable.status, 1);
  assert.match(recoverable.stderr, /rm -rf mutants\.out\/frontend\/\.mutation-in-progress/u);
});

test("PG-107/109/116: production fence records spawning before spawn and child identity after", async (t) => {
  const { root, state } = await fixture(t);
  const injectedSource = [
    'import assert from "node:assert/strict";',
    'import { spawn } from "node:child_process";',
    'import { appendFileSync, readFileSync } from "node:fs";',
    "const { runFrontendMutation } = await import(process.env.RUNNER_URL);",
    "const result = await runFrontendMutation((command, args, options) => {",
    '  const owner = JSON.parse(readFileSync("mutants.out/frontend/.mutation-in-progress/owner.json", "utf8"));',
    "  assert.equal(owner.spawning, options.env.STRYKER_PACKAGE);",
    '  appendFileSync(process.env.SHIM_STATE + "/spawn-observed", `${options.env.STRYKER_PACKAGE}\\n`);',
    "  return spawn(command, args, options);",
    "});",
    "process.exitCode = result;",
    "",
  ].join("\n");
  const env = environment({
    state,
    mode: "block",
    requestedSlots: 1,
    RUNNER_URL: pathToFileURL(runner).href,
  });
  const running = await startInjectedRunner(t, root, env, injectedSource);
  await waitFor(join(state, `started-${packageNames[0]}`));
  const owner = await waitForRecordedChild(root);
  assert.equal(owner.spawning, undefined);
  assert.equal(
    owner.children[0].pid,
    Number(await readFile(join(state, `pid-${packageNames[0]}`), "utf8")),
  );
  await writeFile(join(state, "release"), "");
  const result = await running.done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    (await readFile(join(state, "spawn-observed"), "utf8")).trim().split("\n"),
    packageNames,
  );
});

test("PG-108/110/111: an emitted spawn error exits 127, stops siblings, and leaves queued work idle", async (t) => {
  const { root, state } = await fixture(t);
  const [failed, sibling, queued] = packageNames;
  const injectedSource = [
    'import { EventEmitter } from "node:events";',
    'import { spawn } from "node:child_process";',
    'import { existsSync } from "node:fs";',
    "const { runFrontendMutation } = await import(process.env.RUNNER_URL);",
    "const result = await runFrontendMutation((command, args, options) => {",
    "  if (options.env.STRYKER_PACKAGE !== process.env.INJECT_ERROR_PACKAGE) return spawn(command, args, options);",
    "  const child = new EventEmitter(); child.pid = undefined; child.exitCode = null; child.signalCode = null; child.kill = () => false;",
    '  const peerStarted = process.env.SHIM_STATE + "/started-" + process.env.INJECT_ERROR_PEER;',
    '  const timer = setInterval(() => { if (existsSync(peerStarted)) { clearInterval(timer); child.emit("error", new Error("injected spawn error")); child.emit("close", null, null); } }, 5);',
    "  return child;",
    "});",
    "process.exitCode = result;",
    "",
  ].join("\n");
  const env = environment({
    state,
    mode: "block",
    requestedSlots: 2,
    RUNNER_URL: pathToFileURL(runner).href,
    INJECT_ERROR_PACKAGE: failed,
    INJECT_ERROR_PEER: sibling,
  });
  const running = await startInjectedRunner(t, root, env, injectedSource);
  await waitFor(join(state, `started-${sibling}`));
  const result = await running.done;
  assert.equal(result.code, 127, result.stderr);
  assert.match(result.stderr, new RegExp(`${failed} failed to spawn: injected spawn error`, "u"));
  assert.equal(existsSync(join(state, `terminated-${sibling}`)), true);
  assert.equal(existsSync(join(state, `started-${queued}`)), false);
  assert.equal(existsSync(join(root, fence)), false);
});

test("PG-108: an unresolved spawn error holds admission while another slot completes", async (t) => {
  const { root, state } = await fixture(t);
  const [failed, completed, queued] = packageNames;
  const injectedSource = [
    'import { EventEmitter } from "node:events";',
    'import { spawn } from "node:child_process";',
    'import { existsSync } from "node:fs";',
    "const { runFrontendMutation } = await import(process.env.RUNNER_URL);",
    "const result = await runFrontendMutation((command, args, options) => {",
    "  if (options.env.STRYKER_PACKAGE !== process.env.INJECT_ERROR_PACKAGE) return spawn(command, args, options);",
    "  const child = new EventEmitter(); child.pid = undefined; child.exitCode = null; child.signalCode = null; child.kill = () => false;",
    '  const peerStarted = process.env.SHIM_STATE + "/started-" + process.env.INJECT_ERROR_PEER;',
    '  const timer = setInterval(() => { if (existsSync(peerStarted)) { clearInterval(timer); setTimeout(() => { child.emit("error", new Error("delayed spawn error")); child.emit("close", null, null); }, 250); } }, 5);',
    "  return child;",
    "});",
    "process.exitCode = result;",
    "",
  ].join("\n");
  const env = environment({
    state,
    mode: "normal",
    requestedSlots: 2,
    RUNNER_URL: pathToFileURL(runner).href,
    INJECT_ERROR_PACKAGE: failed,
    INJECT_ERROR_PEER: completed,
  });
  const running = await startInjectedRunner(t, root, env, injectedSource);
  const result = await running.done;
  assert.equal(result.code, 127, result.stderr);
  assert.match(result.stderr, /delayed spawn error/u);
  assert.deepEqual((await readFile(join(state, "packages"), "utf8")).trim().split("\n"), [
    completed,
  ]);
  assert.equal(existsSync(join(state, `started-${queued}`)), false);
});

test("PG-53: a production owner-record write error terminates the spawned child", async (t) => {
  const { root, state } = await fixture(t);
  const target = packageNames[0];
  const injectedSource = [
    'import { spawn } from "node:child_process";',
    'import { mkdirSync, rmSync, writeFileSync } from "node:fs";',
    "const { runFrontendMutation } = await import(process.env.RUNNER_URL);",
    "const result = await runFrontendMutation((command, args, options) => {",
    "  const child = spawn(command, args, options);",
    "  if (options.env.STRYKER_PACKAGE === process.env.FAIL_OWNER_WRITE_PACKAGE) {",
    '    writeFileSync(process.env.SHIM_STATE + "/spawned-pid", `${child.pid}\\n`);',
    '    rmSync("mutants.out/frontend/.mutation-in-progress/owner.json");',
    '    mkdirSync("mutants.out/frontend/.mutation-in-progress/owner.json");',
    "  }",
    "  return child;",
    "});",
    "process.exitCode = result;",
    "",
  ].join("\n");
  const env = environment({
    state,
    mode: "block",
    requestedSlots: 1,
    RUNNER_URL: pathToFileURL(runner).href,
    FAIL_OWNER_WRITE_PACKAGE: target,
  });
  const running = await startInjectedRunner(t, root, env, injectedSource);
  await waitFor(join(state, "spawned-pid"));
  const childPid = Number(await readFile(join(state, "spawned-pid"), "utf8"));
  const result = await running.done;
  assert.notEqual(result.code, 0);
  assert.equal(isAlive(childPid), false);
  assert.equal(existsSync(join(root, fence)), true);
  assert.match(result.stderr, /EISDIR|illegal operation on a directory/u);
  try {
    process.kill(-childPid, "SIGKILL");
  } catch {
    // The child group is already gone.
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`PG-52: ${signal} fans out to every active child before removing the fence`, async (t) => {
    const { root, state } = await fixture(t);
    const active = packageNames.slice(0, 2);
    const running = start(t, root, environment({ state, mode: "block", requestedSlots: 2 }));
    await Promise.all(active.map((name) => waitFor(join(state, `started-${name}`))));
    const pids = await Promise.all(
      active.map(async (name) => Number(await readFile(join(state, `pid-${name}`), "utf8"))),
    );
    running.child.kill(signal);
    const result = await running.done;
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
    for (let index = 0; index < active.length; index += 1) {
      assert.equal(existsSync(join(state, `terminated-${active[index]}`)), true);
      assert.equal(isAlive(pids[index]), false, `Stryker pid ${pids[index]} still exists`);
    }
    assert.equal(existsSync(join(root, fence)), false);
  });
}

test("PG-92/94/96: SIGKILL reports 137, terminates its sibling, and leaves the third package queued", async (t) => {
  const { root, state } = await fixture(t);
  const [killed, sibling, queued] = packageNames;
  const preload = join(state, "two-cpu-preload.mjs");
  await writeCpuPreload(preload);
  const env = {
    ...environment({
      state,
      mode: "kill-after-peer",
      requestedSlots: 2,
      KILL_PACKAGE: killed,
      KILL_PEER: sibling,
    }),
    TEST_AVAILABLE_CPUS: "2",
    GATE_CPU_SHARE: "1",
  };
  const running = start(t, root, env, { nodeArgs: ["--import", preload] });
  await Promise.all([
    waitFor(join(state, `started-${killed}`)),
    waitFor(join(state, `started-${sibling}`)),
  ]);
  const result = await running.done;
  assert.equal(result.code, 137, result.stderr);
  assert.match(result.stderr, new RegExp(`${killed} was killed by SIGKILL`, "u"));
  assert.equal(existsSync(join(state, `terminated-${sibling}`)), true);
  assert.equal(existsSync(join(state, `started-${queued}`)), false);
});

test("PG-52: a signal during startup is forwarded before the shim advertises readiness", async (t) => {
  const { root, state } = await fixture(t);
  const running = start(t, root, environment({ state, mode: "startup-delay", requestedSlots: 1 }));
  await waitFor(join(state, `booting-${packageNames[0]}`));
  assert.equal(existsSync(join(state, `started-${packageNames[0]}`)), false);
  running.child.kill("SIGINT");
  const result = await running.done;
  assert.equal(result.code, 130, result.stderr);
  assert.equal(existsSync(join(root, fence)), false);
});

test("PG-52: SIGINT on one CPU latches admission before any queued package starts", async (t) => {
  const { root, state } = await fixture(t);
  const preload = join(state, "one-cpu-preload.mjs");
  await writeCpuPreload(preload);
  const env = {
    ...environment({ state, mode: "block", requestedSlots: 1 }),
    TEST_AVAILABLE_CPUS: "1",
    GATE_CPU_SHARE: "1",
  };
  const running = start(t, root, env, { nodeArgs: ["--import", preload] });
  await waitFor(join(state, `started-${packageNames[0]}`));
  running.child.kill("SIGINT");
  const result = await running.done;
  assert.equal(result.code, 130, result.stderr);
  assert.deepEqual((await readFile(join(state, "packages"), "utf8")).trim().split("\n"), [
    packageNames[0],
  ]);
  for (const queued of packageNames.slice(1)) {
    assert.equal(existsSync(join(state, `started-${queued}`)), false);
  }
});

test("a child that ignores SIGTERM is SIGKILLed before fence removal", async (t) => {
  const { root, state } = await fixture(t);
  const running = start(t, root, environment({ state, mode: "ignore-term", requestedSlots: 1 }));
  await waitFor(join(state, `started-${packageNames[0]}`));
  const childPid = Number(await readFile(join(state, `pid-${packageNames[0]}`), "utf8"));
  const grandchildPid = Number(
    await readFile(join(state, `grandchild-pid-${packageNames[0]}`), "utf8"),
  );
  running.child.kill("SIGTERM");
  const result = await running.done;
  assert.equal(result.code, 143, result.stderr);
  assert.equal(isAlive(childPid), false, `Stryker pid ${childPid} still exists`);
  assert.equal(isAlive(grandchildPid), false, `grandchild pid ${grandchildPid} still exists`);
  assert.equal(existsSync(join(root, fence)), false);
});

test("PG-52: a child termination failure does not skip siblings and keeps the fence", async (t) => {
  const { root, state } = await fixture(t);
  const [failed, stubborn] = packageNames;
  const injectedSource = [
    'import { spawn } from "node:child_process";',
    "const { runFrontendMutation } = await import(process.env.RUNNER_URL);",
    "const realKill = process.kill.bind(process);",
    "const result = await runFrontendMutation((command, args, options) => {",
    "  const child = spawn(command, args, options);",
    "  if (options.env.STRYKER_PACKAGE === process.env.STUBBORN_PACKAGE) {",
    "    const blockedPid = child.pid;",
    "    process.kill = (pid, signal) => {",
    '      if (pid === -blockedPid && signal === "SIGTERM") throw Object.assign(new Error("injected EPERM"), { code: "EPERM" });',
    "      return realKill(pid, signal);",
    "    };",
    "  }",
    "  return child;",
    "});",
    "process.exitCode = result;",
    "",
  ].join("\n");
  const env = environment({
    state,
    mode: "block",
    failPackage: failed,
    FAIL_PEER: stubborn,
    requestedSlots: 2,
    RUNNER_URL: pathToFileURL(runner).href,
    STUBBORN_PACKAGE: stubborn,
  });
  const running = await startInjectedRunner(t, root, env, injectedSource);
  await Promise.all([
    waitFor(join(state, `started-${failed}`)),
    waitFor(join(state, `started-${stubborn}`)),
  ]);
  const stubbornPid = Number(await readFile(join(state, `pid-${stubborn}`), "utf8"));
  const result = await running.done;
  assert.equal(result.code, 7, result.stderr);
  assert.match(
    result.stderr,
    new RegExp(`Failed to terminate frontend mutation child ${stubborn}: injected EPERM`, "u"),
  );
  assert.equal(isAlive(Number(await readFile(join(state, `pid-${failed}`), "utf8"))), false);
  assert.equal(isAlive(stubbornPid), true);
  assert.equal(existsSync(join(root, fence)), true);
  try {
    process.kill(-stubbornPid, "SIGKILL");
  } catch {
    // The test cleans up the intentionally surviving process group.
  }
});

test("the finaliser sweeps a surviving grandchild after its Stryker root exits", async (t) => {
  const { root, state } = await fixture(t);
  const result = run(root, environment({ state, mode: "grandchild-exit", requestedSlots: 1 }));
  const grandchildPid = Number(
    await readFile(join(state, `grandchild-pid-${packageNames[0]}`), "utf8"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(isAlive(grandchildPid), false, `grandchild pid ${grandchildPid} still exists`);
  assert.equal(existsSync(join(root, fence)), false);
});

function runConfigImport(env, preloadPath = undefined) {
  const script = `
    const config = await import(${JSON.stringify(pathToFileURL(join(projectRoot, "stryker.config.mjs")).href)});
    const { incremental, incrementalFile, force } = config.default;
    console.log(process.env.PRINT_INCREMENTAL ? JSON.stringify({ incremental, incrementalFile, force }) : process.env.PRINT_MUTATE ? JSON.stringify(config.default.mutate) : String(config.default.concurrency));
  `;
  return spawnSync(
    process.execPath,
    [...(preloadPath ? ["--import", preloadPath] : []), "--input-type=module", "-e", script],
    { cwd: projectRoot, encoding: "utf8", env },
  );
}

test("PG-84/87: Stryker config uses the shared map, memory budget, and temp-tree ignore", async () => {
  const previous = {
    package: process.env.STRYKER_PACKAGE,
    memory: process.env.STRYKER_MEMORY_BYTES,
    share: process.env.GATE_CPU_SHARE,
  };
  try {
    process.env.STRYKER_MEMORY_BYTES = String(STRYKER_PARENT_BYTES + 3 * STRYKER_RUNNER_BYTES);
    process.env.GATE_CPU_SHARE = "1";
    for (const [name, mutate] of Object.entries(mutationPackages)) {
      process.env.STRYKER_PACKAGE = name;
      const config = await import(`../stryker.config.mjs?package=${name}`);
      assert.deepEqual(config.default.mutate, mutate);
      assert.ok(config.default.concurrency >= 1);
      for (const sibling of packageNames.filter((other) => other !== name)) {
        const sandboxFile = `.stryker-tmp/${sibling}/sandbox-x/file`;
        assert.ok(
          config.default.ignorePatterns.some((pattern) => strykerIgnoresFile(pattern, sandboxFile)),
          `${name} config does not ignore sibling sandbox ${sandboxFile}`,
        );
      }
    }
  } finally {
    if (previous.package === undefined) delete process.env.STRYKER_PACKAGE;
    else process.env.STRYKER_PACKAGE = previous.package;
    if (previous.memory === undefined) delete process.env.STRYKER_MEMORY_BYTES;
    else process.env.STRYKER_MEMORY_BYTES = previous.memory;
    if (previous.share === undefined) delete process.env.GATE_CPU_SHARE;
    else process.env.GATE_CPU_SHARE = previous.share;
  }
});

test("PG-119: Stryker config rejects unset and invalid STRYKER_MEMORY_BYTES", () => {
  for (const value of [undefined, "", "abc", "0"]) {
    const env = {
      ...process.env,
      STRYKER_PACKAGE: packageNames[0],
      GATE_CPU_SHARE: "1",
    };
    if (value === undefined) delete env.STRYKER_MEMORY_BYTES;
    else env.STRYKER_MEMORY_BYTES = value;
    const result = runConfigImport(env);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr ?? result.error?.message ?? JSON.stringify(result),
      /STRYKER_MEMORY_BYTES/u,
    );
  }
});

test("PG-135/136: Stryker config concurrency follows injected CPUs and CPU share", async (t) => {
  const { state } = await fixture(t);
  const preload = join(state, "config-cpu-preload.mjs");
  await writeCpuPreload(preload);
  const cases = [
    [
      "24 CPUs, parent plus three runners",
      24,
      1,
      STRYKER_PARENT_BYTES + 3 * STRYKER_RUNNER_BYTES,
      3,
    ],
    ["24 CPUs, parent plus one runner", 24, 1, STRYKER_PARENT_BYTES + STRYKER_RUNNER_BYTES, 1],
    ["24 CPUs at one-third share", 24, 1 / 3, budgetBytes, 8],
    ["2 CPUs at one-half share", 2, 0.5, budgetBytes, 1],
  ];
  for (const [label, cpus, share, memory, expected] of cases) {
    const env = {
      ...process.env,
      STRYKER_PACKAGE: packageNames[0],
      STRYKER_MEMORY_BYTES: String(memory),
      GATE_CPU_SHARE: String(share),
      TEST_AVAILABLE_CPUS: String(cpus),
    };
    const result = runConfigImport(env, preload);
    assert.equal(
      result.status,
      0,
      `${label}: ${result.stderr ?? result.error?.message ?? JSON.stringify(result)}`,
    );
    assert.equal(Number(result.stdout.trim()), expected, label);
  }
});

test("the existing per-package budget is consumed by workerCount without a hard-coded cap", () => {
  const budget = STRYKER_PARENT_BYTES + 3 * STRYKER_RUNNER_BYTES;
  assert.equal(
    workerCount({
      perWorkerBytes: STRYKER_RUNNER_BYTES,
      baseBytes: STRYKER_PARENT_BYTES,
      budgetBytes: budget,
      availableParallelism: () => 24,
      env: {},
    }),
    3,
  );
});

const SWEEP_NOW = new Date("2026-11-08T12:00:00Z");

function sweepArtifact(overrides = {}) {
  const { head_branch = "master", id = 7, ...artifact } = overrides;
  return {
    expired: false,
    created_at: "2026-11-08T09:00:00Z",
    workflow_run: { id, head_branch },
    ...artifact,
  };
}

/** Fake git and gh: `download` writes the file a real artifact would contain. */
function sweepCommands({ artifacts, download, remote = "git@github.com:owner/repo.git" }) {
  const calls = [];
  const runCommand = (command, args) => {
    calls.push([command, ...args]);
    if (command === "git") return { status: 0, stdout: `${remote}\n` };
    if (args[0] === "api") return { status: 0, stdout: JSON.stringify({ artifacts }) };
    const directory = args[args.indexOf("-D") + 1];
    const name = args[args.indexOf("-n") + 1].replace("frontend-mutation-baseline-", "");
    writeFileSync(join(directory, `${name}.json`), download);
    return { status: 0, stdout: "" };
  };
  return { calls, runCommand };
}

const SWEEP_REPORT = JSON.stringify({ schemaVersion: "1.7", files: {} });

async function fetchSweep(t, commands, packageIds = ["tree-path"]) {
  const lines = [];
  const directory = await fetchDailySweepResults(packageIds, {
    now: SWEEP_NOW,
    runCommand: commands,
    log: (line) => lines.push(line),
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, lines };
}

test("only sweeps from today or yesterday by UTC date are recent", () => {
  assert.equal(isRecentSweep("2026-11-07T00:00:00Z", SWEEP_NOW), true);
  assert.equal(isRecentSweep("2026-11-08T23:59:59Z", SWEEP_NOW), true);
  assert.equal(isRecentSweep("2026-11-06T23:59:59Z", SWEEP_NOW), false);
  assert.equal(isRecentSweep("2026-11-09T00:00:00Z", SWEEP_NOW), false);
  assert.equal(isRecentSweep("not a date", SWEEP_NOW), false);
});

test("the newest recent master sweep is downloaded for each package", async (t) => {
  const { calls, runCommand } = sweepCommands({
    artifacts: [
      sweepArtifact({ id: 1, created_at: "2026-11-07T09:00:00Z" }),
      sweepArtifact({ id: 2 }),
      sweepArtifact({ id: 3, created_at: "2026-11-08T10:00:00Z", head_branch: "feature" }),
      sweepArtifact({ id: 4, created_at: "2026-11-08T11:00:00Z", expired: true }),
      sweepArtifact({ id: 5, created_at: "2026-11-05T09:00:00Z" }),
    ],
    download: SWEEP_REPORT,
  });
  const { directory, lines } = await fetchSweep(t, runCommand);
  assert.equal(readFileSync(join(directory, "tree-path.json"), "utf8"), SWEEP_REPORT);
  assert.deepEqual(lines, ["Frontend mutation: tree-path reuses daily sweep run 2"]);
  assert.deepEqual(calls.at(-1), [
    "gh",
    "run",
    "download",
    "2",
    "-R",
    "owner/repo",
    "-n",
    "frontend-mutation-baseline-tree-path",
    "-D",
    directory,
  ]);
});

test("every failure leaves that package without results, so it runs in full", async (t) => {
  const cases = [
    ["no artifact", sweepCommands({ artifacts: [], download: SWEEP_REPORT }).runCommand],
    [
      "only old artifacts",
      sweepCommands({
        artifacts: [sweepArtifact({ created_at: "2026-11-01T09:00:00Z" })],
        download: SWEEP_REPORT,
      }).runCommand,
    ],
    [
      "not GitHub",
      sweepCommands({
        artifacts: [sweepArtifact()],
        download: SWEEP_REPORT,
        remote: "git@example.com:owner/repo.git",
      }).runCommand,
    ],
    [
      "unparsable report",
      sweepCommands({ artifacts: [sweepArtifact()], download: "{" }).runCommand,
    ],
    ["not a report", sweepCommands({ artifacts: [sweepArtifact()], download: "{}" }).runCommand],
    [
      "download fails after writing part of the file",
      (() => {
        const { runCommand } = sweepCommands({ artifacts: [sweepArtifact()], download: "{" });
        return (command, args, options) => {
          const result = runCommand(command, args, options);
          return args[0] === "run" ? { status: 1, stdout: "" } : result;
        };
      })(),
    ],
    ["gh is missing", () => ({ error: new Error("ENOENT") })],
    ["command fails", () => ({ status: 1, stdout: "" })],
  ];
  for (const [name, commands] of cases) {
    const { directory, lines } = await fetchSweep(t, commands, ["tree-path", "game-practice"]);
    assert.deepEqual(await readdir(directory), [], name);
    assert.equal(lines.length, 2, name);
    for (const line of lines) assert.match(line, /runs in full \(.+\)$/u, name);
  }
});

test("a package with results keeps them when another package has none", async (t) => {
  const { runCommand } = sweepCommands({ artifacts: [sweepArtifact()], download: SWEEP_REPORT });
  const commands = (command, args, options) =>
    args.some((arg) => String(arg).includes("game-practice"))
      ? { status: 1, stdout: "" }
      : runCommand(command, args, options);
  const { directory, lines } = await fetchSweep(t, commands, ["tree-path", "game-practice"]);
  assert.equal(existsSync(join(directory, "tree-path.json")), true);
  assert.equal(existsSync(join(directory, "game-practice.json")), false);
  assert.match(lines[0], /tree-path reuses/u);
  assert.match(lines[1], /game-practice runs in full/u);
});

test("outside CI each package gets a results file and the directory is removed afterwards", async (t) => {
  const { root, state } = await fixture(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeShim(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  const result = run(
    root,
    environment({ state, mode: "record", CI: "", PATH: `${bin}:${process.env.PATH}` }),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /runs in full/u);
  const directories = new Set();
  for (const name of packageNames) {
    const { incrementalFile } = JSON.parse(await readFile(join(state, `env-${name}`), "utf8"));
    assert.equal(basename(incrementalFile), `${name}.json`);
    directories.add(dirname(incrementalFile));
  }
  assert.equal(directories.size, 1);
  assert.equal(existsSync([...directories][0]), false);
});

test("--full and CI never contact GitHub or use an incremental file", async (t) => {
  for (const [ci, args] of [
    ["", ["--full"]],
    ["1", []],
  ]) {
    const { root, state } = await fixture(t);
    const bin = join(root, "bin");
    await mkdir(bin);
    const marker = join(root, "gh-called");
    await writeShim(join(bin, "gh"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    const result = run(
      root,
      environment({ state, mode: "record", CI: ci, PATH: `${bin}:${process.env.PATH}` }),
      args,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(marker), false);
    for (const name of packageNames) {
      const childEnv = JSON.parse(await readFile(join(state, `env-${name}`), "utf8"));
      assert.equal(childEnv.incrementalFile, undefined);
    }
  }
});

test("a signal during the sweep download stops it, starts no package and removes the directory", async (t) => {
  const { root, state } = await fixture(t);
  const bin = join(root, "bin");
  const temporary = join(root, "temporary");
  const started = join(root, "gh-started");
  await mkdir(bin);
  await mkdir(temporary);
  await writeShim(join(bin, "git"), "#!/bin/sh\necho git@github.com:owner/repo.git\n");
  await writeShim(join(bin, "gh"), `#!/bin/sh\ntouch ${started}\nexec sleep 30\n`);
  const running = start(
    t,
    root,
    environment({
      state,
      mode: "record",
      CI: "",
      TMPDIR: temporary,
      PATH: `${bin}:${process.env.PATH}`,
    }),
  );
  await waitFor(started);
  running.child.kill("SIGTERM");
  const { code } = await running.done;
  assert.equal(code, 143);
  assert.deepEqual(await readdir(temporary), []);
  for (const name of packageNames) assert.equal(existsSync(join(state, `env-${name}`)), false);
});
