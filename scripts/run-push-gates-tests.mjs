import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, writeSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  GATE_LAUNCHER,
  PRE_REVIEW_GATE_SCHEDULE,
  PUSH_GATE_SCHEDULE,
  RUST_SIZING_MODE_FLAG,
  buildRelatedTestCommands,
  discoverChangedPaths,
  heavyGateCommand,
  parsePushGateArguments,
  runPushGates,
  runRustCommand,
  selectPreReviewLanes,
  wrapHeavyGateCommand,
} from "./run-push-gates.mjs";
import { startNodeCli } from "./mutation-runner-test-harness.mjs";
import { superviseChild } from "./child-supervisor.mjs";
import { MAX_GATE_LOG_RUNS, writeLogChunk } from "./gate-logs.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runnerPath = join(repositoryRoot, "scripts/run-push-gates.mjs");
const GIB = 1024 ** 3;
// A broken process test must fail promptly instead of holding the contract gate indefinitely.
// Fake CLI events are polled with a finite deadline so missing progress cannot hang node:test.
const EVENT_WAIT_TIMEOUT_MS = 10_000;
// A missing marker exposes a scheduler concurrency regression within a bounded test run.
const BARRIER_TIMEOUT_MS = 10_000;

const FAKE_COMMAND = String.raw`
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const executablePath = process.argv[2];
const executable = basename(executablePath);
const args = process.argv.slice(3);
const command = [executable, ...args].join(" ");
const state = process.env.FAKE_STATE;
const config = JSON.parse(readFileSync(process.env.FAKE_CONFIG, "utf8"));
const behavior = config.commands?.[command] ?? {};
const at = () => process.hrtime.bigint().toString();
const eventPath = join(state, "events.jsonl");
const output = "fake-output:" + executable + ":" + args.join("|");
const record = (entry) => appendFileSync(
  eventPath,
  JSON.stringify({ ...entry, command, executable, args, cwd: process.cwd(), at: at(), pid: process.pid }) + "\n",
);

record({ type: "start", output, jobs: process.env.CARGO_BUILD_JOBS, testThreads: process.env.RUST_TEST_THREADS });
process.stdout.write(behavior.stdout ?? output + "\n");

for (const { path, contents, mode } of behavior.writeFiles ?? []) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
}

if (behavior.removeExecutable) {
  try { unlinkSync(join(process.env.FAKE_BIN, behavior.removeExecutable)); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function finish(code = 0) {
  if (finished) return;
  finished = true;
  record({ type: "finish", code, output });
  process.exit(code);
}

let finished = false;
process.on("SIGTERM", () => finish(behavior.signalExitCode ?? 0));
process.on("SIGINT", () => finish(behavior.signalExitCode ?? 0));

if (behavior.childCommand) {
  const [childExecutable, ...childArgs] = behavior.childCommand;
  const result = spawnSync(childExecutable, childArgs, { stdio: "inherit" });
  if (result.status !== 0) finish(result.status ?? 1);
}

if (behavior.signalRunner) process.kill(process.ppid, behavior.signalRunner);
if (behavior.killSelf) {
  setImmediate(() => process.kill(process.pid, behavior.killSelf));
} else if (behavior.barrierLane) {
  const markerDirectory = process.env.FAKE_BARRIER_DIR;
  const expected = behavior.barrierPeers ?? process.env.FAKE_BARRIER_LANES.split(",");
  mkdirSync(markerDirectory, { recursive: true });
  writeFileSync(join(markerDirectory, behavior.barrierLane), String(process.pid));
  const deadline = Date.now() + ${BARRIER_TIMEOUT_MS};
  const poll = () => {
    const markers = new Set(readdirSync(markerDirectory));
    if (expected.every((lane) => markers.has(lane))) finish(behavior.exitCode ?? 0);
    else if (Date.now() >= deadline) finish(92);
    else setTimeout(poll, 10);
  };
  poll();
} else if (behavior.hold) {
  setInterval(() => {}, 1_000);
} else if (behavior.delayMs) {
  setTimeout(() => finish(behavior.exitCode ?? 0), behavior.delayMs);
} else {
  setImmediate(() => finish(behavior.exitCode ?? 0));
}
`;

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function scheduledFakeCommands(blocks) {
  const selected = new Set(blocks);
  const commands = ["pnpm mutation:guard:check"];
  if (selected.has("rust") || selected.has("bindings")) {
    commands.push("pnpm rust:target:evict", "bash scripts/setup-rust.sh");
  }
  if (selected.size > 0) commands.push("pnpm build-vite");
  if (selected.has("bindings")) commands.push("pnpm bindings:check");
  if (selected.has("rust")) {
    commands.push(
      "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
      "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
      "pnpm rust:windows:check",
    );
  }
  commands.push("pnpm gates:contract:check", "pnpm findings:kit:check");
  if (selected.has("frontend")) {
    commands.push("pnpm bundle:check");
  }
  return commands;
}

async function makeHarness(
  t,
  {
    commands = {},
    omittedExecutables = [],
    extraExecutables = [],
    budgetBytes = 10 * GIB,
    barrierLanes = [],
    initGit = true,
    upstream = true,
  } = {},
) {
  const root = await mkdtemp(join("/tmp", "push-gates-cli-"));
  const bin = join(root, "bin");
  const state = join(root, "state");
  const configPath = join(root, "fake-config.json");
  await mkdir(bin);
  await mkdir(state);
  await writeFile(configPath, JSON.stringify({ commands }));
  const helperPath = join(root, "fake-command.mjs");
  await writeFile(helperPath, FAKE_COMMAND);
  await symlink("/usr/bin/env", join(bin, "env"));
  if (initGit) {
    await initializeUpstream(root, {
      upstream,
      files: {
        ".gitignore":
          "/bin/\n/state/\n/artifacts/\n/fake-config.json\n/fake-command.mjs\n/mingw/\n/cargo-home/\n/scripts/\n/dist/\n",
      },
    });
    await symlink("/usr/bin/git", join(bin, "git"));
    if (upstream) {
      // One unpublished commit: a push-gate run proves a range, and an empty one is refused.
      await writeFile(join(root, "CHANGELOG.md"), "unpublished\n");
      git(root, ["add", "CHANGELOG.md"]);
      git(root, ["commit", "--quiet", "-m", "unpublished"]);
    }
  }

  for (const executable of ["pnpm", "cargo", "bash", ...extraExecutables]) {
    if (omittedExecutables.includes(executable)) continue;
    const shimPath = join(bin, executable);
    await writeFile(
      shimPath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(helperPath)} "$0" "$@"\n`,
    );
    await chmod(shimPath, 0o755);
  }
  if (!omittedExecutables.includes(GATE_LAUNCHER)) {
    const gateShimPath = join(bin, GATE_LAUNCHER);
    await writeFile(gateShimPath, '#!/bin/sh\nexec "$@"\n');
    await chmod(gateShimPath, 0o755);
  }
  t.after(async () => rm(root, { recursive: true, force: true }));
  return {
    root,
    bin,
    state,
    budgetBytes,
    configPath,
    env: {
      ...process.env,
      PATH: bin,
      FAKE_BIN: bin,
      FAKE_STATE: state,
      FAKE_CONFIG: configPath,
      FAKE_BARRIER_DIR: join(state, "barrier"),
      FAKE_BARRIER_LANES: barrierLanes.join(","),
      GATE_MEMORY_BYTES: String(budgetBytes),
    },
  };
}

async function readEvents(harness) {
  try {
    const source = await readFile(join(harness.state, "events.jsonl"), "utf8");
    return source
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForEvent(harness, predicate, timeoutMs = EVENT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = (await readEvents(harness)).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for a fake gate event after ${timeoutMs} ms`);
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function startCli(t, harness, args = []) {
  return startNodeCli(t, runnerPath, harness.root, harness.env, {
    args,
    afterChildExit: async () => {
      const events = await readEvents(harness);
      const started = events.filter((event) => event.type === "start");
      const finishedPids = new Set(
        events.filter((event) => event.type === "finish").map((event) => event.pid),
      );
      for (const event of started) {
        if (finishedPids.has(event.pid) || !groupExists(event.pid)) continue;
        signalGroup(event.pid, "SIGTERM");
        signalGroup(event.pid, "SIGKILL");
      }
    },
  });
}

async function runCli(t, harness, args = []) {
  return startCli(t, harness, args).done;
}

function commandSet(events) {
  return events
    .filter((event) => event.type === "start")
    .map((event) => event.command)
    .sort();
}

function at(event) {
  return BigInt(event.at);
}

function sortedEvents(events, predicate) {
  return events.filter(predicate).sort((left, right) => (at(left) < at(right) ? -1 : 1));
}

function cliCommandStart(events, command) {
  return events.find((event) => event.type === "start" && event.command === command);
}

function cliCommandFinish(events, command) {
  return events.find((event) => event.type === "finish" && event.command === command);
}

function laneForCommand(command) {
  return new Map([
    ["pnpm gates:contract:check", "contract"],
    ["cargo fmt --manifest-path src-tauri/Cargo.toml -- --check", "rust-lint"],
    ["pnpm bundle:check", "bundle"],
  ]).get(command);
}

function wrappedHeavyCommand(command) {
  return wrapHeavyGateCommand(command).display;
}

/** The related-tests Vitest command as it starts: directly under `agent-gate`, no sizing mode. */
function slotVitestRelated(...paths) {
  return `${GATE_LAUNCHER} pnpm exec vitest related --run --passWithNoTests ${paths.join(" ")}`;
}

function makeMockSpawner({
  exits = {},
  events = [],
  stdout = "",
  beforeClose = async () => {},
} = {}) {
  return (executable, args, options) => {
    assert.equal(options.shell, undefined, "scheduled commands must spawn without a shell");
    const command = [executable, ...args].join(" ");
    events.push({ type: "start", executable, args: [...args], command, env: options.env, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => false;
    setImmediate(async () => {
      await beforeClose(command);
      const code = exits[command] ?? 0;
      child.exitCode = code;
      child.stdout.end(stdout);
      child.stderr.end();
      events.push({ type: "finish", command, code });
      child.emit("close", code, null);
    });
    return child;
  };
}

async function waitForMockEvent(events, type, command) {
  const deadline = Date.now() + EVENT_WAIT_TIMEOUT_MS;
  while (!events.some((event) => event.type === type && event.command === command)) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${type} ${command}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Let the supervisor and scheduler observe completion before releasing a sibling.
  await new Promise((resolve) => setImmediate(resolve));
}

async function temporarySchedulerRoot(t) {
  const root = await mkdtemp(join("/tmp", "push-gates-scheduler-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("scheduler startup prunes old runs before the first child starts", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  const base = join(cwd, "artifacts", "gates");
  await mkdir(base, { recursive: true });
  const oldNames = Array.from(
    { length: 105 },
    (_, index) => `20200101T${String(index).padStart(9, "0")}Z-1`,
  );
  for (const name of oldNames) await mkdir(join(base, name));
  let checked = false;
  const result = await runPushGates([], {
    cwd,
    env: { ...process.env },
    async beforeStep() {
      if (checked) return;
      checked = true;
      const names = await readdir(base);
      assert.equal(names.length, MAX_GATE_LOG_RUNS);
      assert.deepEqual(
        names.filter((name) => oldNames.includes(name)),
        oldNames.slice(6),
      );
    },
    spawnProcess: makeMockSpawner(),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(checked);
  assert.ok((await readdir(base)).includes(result.logDirectory.split("/").at(-1)));
});

test("failed schedules finish with all failed paths after their summary and tails", async (t) => {
  for (const preReview of [false, true]) {
    await t.test(preReview ? "pre-review" : "push", async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      const originalStdoutWrite = process.stdout.write;
      let stdout = "";
      process.stdout.write = function (chunk) {
        stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        return true;
      };
      let result;
      try {
        result = await runPushGates(preReview ? ["--pre-review"] : ["--rust"], {
          cwd,
          env: { ...process.env },
          discoverChangedPaths: () => ["src-tauri/src/lib.rs"],
          spawnProcess: makeMockSpawner({
            exits: {
              "pnpm gates:contract:check": 7,
              "pnpm coverage:mapping:backend": 8,
              "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check": 11,
            },
          }),
        });
      } finally {
        process.stdout.write = originalStdoutWrite;
      }
      assert.equal(result.exitCode, preReview ? 11 : 7);
      const failed = result.results.filter(({ status }) => status === "failed");
      assert.equal(failed.length, 2);
      const prefix = preReview ? "pre-review check failed" : "push gate failed";
      const trailers = failed.map(({ name, logPath }) => `${prefix}: ${name} — log: ${logPath}`);
      const lines = stdout.trimEnd().split("\n");
      assert.deepEqual(lines.slice(-trailers.length), trailers);
      assert.equal(lines.filter((line) => line.startsWith(`${prefix}:`)).length, failed.length);
      for (const task of failed) {
        assert.ok(stdout.includes(`${task.name} log tail (${task.logPath}):`));
        assert.ok(stdout.indexOf(`${task.name} log tail`) < stdout.indexOf(trailers[0]));
        await readFile(task.logPath, "utf8");
      }
    });
  }
});

function git(root, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr);
  return result;
}

async function initializeUpstream(root, { upstream = true, files = {} } = {}) {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "Gate fixture"]);
  git(root, ["config", "user.email", "gate-fixture@example.invalid"]);
  await writeFile(join(root, "README.md"), "base\n");
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  git(root, ["add", "README.md", ...Object.keys(files)]);
  git(root, ["commit", "--quiet", "-m", "base"]);
  if (!upstream) return;
  const remote = join(root, ".git", "upstream.git");
  git(root, ["init", "--bare", "--quiet", remote]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "--quiet", "--set-upstream", "origin", "HEAD"]);
}

test("pre-review changed-path selection covers every lane and excludes unrelated changes", async (t) => {
  const root = await temporarySchedulerRoot(t);
  await mkdir(join(root, "src/state"), { recursive: true });
  await mkdir(join(root, "src-tauri/src"), { recursive: true });
  await writeFile(join(root, "src/state/workspace.ts"), "export const workspace = 1;\n");
  await writeFile(join(root, "src-tauri/src/lib.rs"), "pub fn fixture() {}\n");
  await writeFile(join(root, "coverage-areas.json"), "{}\n");
  await writeFile(join(root, "backend-coverage-baselines.json"), "{}\n");
  const paths = ["src/state/workspace.ts", "src-tauri/src/lib.rs", "package.json"];
  const lanes = selectPreReviewLanes(paths, { root });
  assert.deepEqual(
    lanes.map(({ name }) => name),
    [
      "format-lint",
      "coverage-mapping-frontend",
      "coverage-mapping-backend",
      "windows-clippy",
      "bundle",
    ],
  );
  const formatCommands = lanes.find(({ name }) => name === "format-lint").commands;
  assert.deepEqual(
    formatCommands.map(({ display }) => display),
    [
      "pnpm exec oxfmt --check src/state/workspace.ts",
      "pnpm exec oxlint --deny-warnings src/state/workspace.ts",
      "pnpm exec tsgo --noEmit",
      "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
    ],
  );
  assert.deepEqual(selectPreReviewLanes(["README.md"], { root }), []);
  const tauriConfigLanes = selectPreReviewLanes(["src-tauri/tauri.conf.json"], { root });
  assert.ok(tauriConfigLanes.some(({ name }) => name === "windows-clippy"));
  assert.ok(!tauriConfigLanes.some(({ name }) => name === "format-lint"));
  assert.deepEqual(
    selectPreReviewLanes(["coverage-areas.json"], { root }).map(({ name }) => name),
    ["format-lint", "coverage-mapping-frontend"],
  );
  assert.deepEqual(
    selectPreReviewLanes(["backend-coverage-baselines.json"], { root }).map(({ name }) => name),
    ["format-lint", "coverage-mapping-backend"],
  );
});

test("root TypeScript config changes select the frontend bundle lane", () => {
  for (const path of ["tsconfig.json", "tsconfig.node.json"]) {
    assert.ok(
      selectPreReviewLanes([path], { root: repositoryRoot }).some(({ name }) => name === "bundle"),
      path,
    );
  }
});

test("untracked-only production input selects its pre-review lanes (CR-6)", async (t) => {
  const root = await temporarySchedulerRoot(t);
  await initializeUpstream(root);
  const sourcePath = "src/state/workspace.ts";
  await mkdir(dirname(join(root, sourcePath)), { recursive: true });
  await writeFile(join(root, sourcePath), "export const workspace = 1;\n");

  const changedPaths = discoverChangedPaths({ cwd: root }).paths;
  assert.deepEqual(changedPaths, [sourcePath]);
  assert.ok(
    selectPreReviewLanes(changedPaths, { root }).some(({ name }) => name === "format-lint"),
  );
  assert.ok(
    selectPreReviewLanes(changedPaths, { root }).some(
      ({ name }) => name === "coverage-mapping-frontend",
    ),
  );
});

test("changed-path discovery runs git in the C locale so missing upstream stays recognisable", () => {
  const calls = [];
  const localisedRunGit = (executable, args, options) => {
    calls.push(options.env?.LC_ALL);
    return options.env?.LC_ALL === "C"
      ? { status: 128, stdout: "", stderr: "fatal: no upstream configured for branch 'main'" }
      : {
          status: 128,
          stdout: "",
          stderr: "fatal: Kein Upstream-Branch für Branch 'main' konfiguriert.",
        };
  };
  assert.throws(
    () => discoverChangedPaths({ cwd: "/unused", runGit: localisedRunGit, headline: "H" }),
    /^Error: H: missing upstream: git merge-base HEAD @\{u\} failed/u,
  );
  assert.deepEqual(calls, ["C"]);
});

test("pre-review refuses a missing upstream and every failing git call", async (t) => {
  const root = await temporarySchedulerRoot(t);
  await initializeUpstream(root, { upstream: false });
  assert.throws(
    () =>
      discoverChangedPaths({ cwd: root, headline: "Cannot determine pre-review changed paths" }),
    /Cannot determine pre-review changed paths: missing upstream: git merge-base HEAD @\{u\} failed/u,
  );

  const failingRunGit = (executable, args) => {
    if (args[0] === "merge-base") return { status: 0, stdout: "base-commit\n" };
    return { status: 128, stdout: "", stderr: "injected diff failure" };
  };
  assert.throws(
    () =>
      discoverChangedPaths({
        cwd: root,
        runGit: failingRunGit,
        listUntracked: () => [],
        headline: "Cannot determine pre-review changed paths",
      }),
    /Cannot determine pre-review changed paths: git diff --name-only -z base-commit -- failed \(injected diff failure\)/u,
  );
});

test("pre-review selects no mutation lane for frontend tests or mutation production files", async (t) => {
  const root = await temporarySchedulerRoot(t);
  const sourcePath = "src/utils/treeReducer.ts";
  const testPath = "src/utils/treeReducer.test.ts";
  await mkdir(dirname(join(root, sourcePath)), { recursive: true });
  await writeFile(join(root, sourcePath), "export const reducer = 1;\n");
  await writeFile(join(root, testPath), 'import { reducer } from "./treeReducer";\n');
  for (const path of [testPath, sourcePath]) {
    const lanes = selectPreReviewLanes([path], { root });
    assert.ok(lanes.length > 0, path);
    assert.ok(
      lanes.every(({ name }) => !name.includes("mutation")),
      path,
    );
    assert.ok(
      lanes
        .flatMap(({ commands }) => commands)
        .every(
          (command) =>
            !(typeof command === "string" ? command : command.display).includes("mutation"),
        ),
      path,
    );
  }
});

test("Rust-only pre-review waits for the frontend build before Windows clippy", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  const events = [];
  const result = await runPushGates(["--pre-review"], {
    cwd,
    env: { ...process.env, GATE_MEMORY_BYTES: String(10 * GIB) },
    discoverChangedPaths: () => ["src-tauri/src/lib.rs"],
    spawnProcess: makeMockSpawner({ events }),
  });
  assert.equal(result.exitCode, 0);
  const commands = events.filter(({ type }) => type === "start").map(({ command }) => command);
  const windowsCommand = wrappedHeavyCommand("pnpm rust:windows:check");
  assert.deepEqual(commands, [
    "pnpm build-vite",
    "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
    "pnpm coverage:mapping:backend",
    windowsCommand,
  ]);
  assert.ok(
    PRE_REVIEW_GATE_SCHEDULE.p1[0].command === commands[0] &&
      commands.indexOf("pnpm build-vite") < commands.indexOf(windowsCommand),
  );
});

test("pre-review frontend-build red skips every selected lane (R7, DC-06)", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  await mkdir(join(cwd, "src/state"), { recursive: true });
  await writeFile(join(cwd, "src/state/workspace.ts"), "export const workspace = 1;\n");
  const events = [];
  const result = await runPushGates(["--pre-review"], {
    cwd,
    env: { ...process.env, GATE_MEMORY_BYTES: String(7 * GIB) },
    discoverChangedPaths: () => ["src-tauri/src/lib.rs", "src/state/workspace.ts"],
    spawnProcess: makeMockSpawner({
      events,
      exits: { "pnpm build-vite": 9 },
    }),
  });
  assert.equal(result.exitCode, 9);
  const commands = commandSet(events);
  assert.ok(commands.includes("pnpm build-vite"));
  assert.deepEqual(commands, ["pnpm build-vite"]);
  for (const laneName of selectPreReviewLanes(["src-tauri/src/lib.rs", "src/state/workspace.ts"], {
    root: cwd,
  }).map(({ name }) => name)) {
    const lane = result.results.find(({ name }) => name === laneName);
    assert.equal(lane.status, "skipped");
    assert.match(lane.reason, /frontend-build failed/u);
  }
});

test("CLI selection matrix, leading delimiter, and phase ordering (PG-60, PG-64, PG-66, PG-78, PG-88, PG-104)", async (t) => {
  const cases = [
    { name: "no flags", flags: [], expected: scheduledFakeCommands([]) },
    { name: "rust", flags: ["--rust"], expected: scheduledFakeCommands(["rust"]) },
    { name: "frontend", flags: ["--frontend"], expected: scheduledFakeCommands(["frontend"]) },
    { name: "bindings", flags: ["--bindings"], expected: scheduledFakeCommands(["bindings"]) },
    {
      name: "rust plus frontend",
      flags: ["--rust", "--frontend"],
      expected: scheduledFakeCommands(["rust", "frontend"]),
    },
    {
      name: "rust plus bindings",
      flags: ["--rust", "--bindings"],
      expected: scheduledFakeCommands(["rust", "bindings"]),
    },
    {
      name: "frontend plus bindings",
      flags: ["--frontend", "--bindings"],
      expected: scheduledFakeCommands(["frontend", "bindings"]),
    },
    {
      name: "all blocks",
      flags: ["--rust", "--frontend", "--bindings"],
      expected: scheduledFakeCommands(["rust", "frontend", "bindings"]),
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async (subtest) => {
      const harness = await makeHarness(subtest);
      const result = await runCli(subtest, harness, entry.flags);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(commandSet(await readEvents(harness)), [...entry.expected].sort());

      const events = await readEvents(harness);
      const guardFinish = cliCommandFinish(events, "pnpm mutation:guard:check");
      if (entry.flags.includes("--rust")) {
        const clippy = events.find(
          (event) => event.type === "start" && event.command.startsWith("cargo clippy "),
        );
        assert.deepEqual(clippy.args, [
          "clippy",
          "--manifest-path",
          "src-tauri/Cargo.toml",
          "--all-targets",
          "--locked",
          "--",
          "-D",
          "warnings",
        ]);
      }
      const laneStart = sortedEvents(
        events,
        (event) => event.type === "start" && laneForCommand(event.command),
      )[0];
      const p1Commands =
        entry.flags.length > 0
          ? [
              "pnpm build-vite",
              ...(entry.flags.includes("--bindings") ? ["pnpm bindings:check"] : []),
            ]
          : [];
      if (entry.flags.includes("--rust") || entry.flags.includes("--bindings")) {
        const evictionStart = cliCommandStart(events, "pnpm rust:target:evict");
        const evictionFinish = cliCommandFinish(events, "pnpm rust:target:evict");
        const setupStart = cliCommandStart(events, "bash scripts/setup-rust.sh");
        const setupFinish = cliCommandFinish(events, "bash scripts/setup-rust.sh");
        const buildStart = cliCommandStart(events, "pnpm build-vite");
        assert.ok(at(guardFinish) < at(evictionStart));
        assert.ok(at(evictionFinish) < at(setupStart));
        assert.ok(at(setupFinish) < at(buildStart));
      } else if (entry.flags.includes("--frontend")) {
        assert.ok(at(guardFinish) < at(cliCommandStart(events, "pnpm build-vite")));
      }
      if (entry.flags.includes("--bindings")) {
        assert.ok(
          at(cliCommandFinish(events, "pnpm build-vite")) <
            at(cliCommandStart(events, "pnpm bindings:check")),
        );
      }
      if (laneStart && p1Commands.length) {
        for (const command of p1Commands) {
          const finished = cliCommandFinish(events, command);
          assert.ok(finished, `${command} should finish before P2 starts`);
          assert.ok(at(finished) < at(laneStart), `${command} overlapped the first P2 lane`);
        }
      } else if (laneStart) {
        assert.ok(at(guardFinish) < at(laneStart), "P0 guard must finish before the contract lane");
      }
    });
  }

  await t.test("leading pnpm delimiter", async (subtest) => {
    const harness = await makeHarness(subtest);
    const result = await runCli(subtest, harness, ["--", "--rust"]);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(commandSet(await readEvents(harness)), scheduledFakeCommands(["rust"]).sort());
  });

  await t.test(
    "bindings-only and rust-only rebuild dist despite an existing directory",
    async (subtest) => {
      for (const flags of [["--bindings"], ["--rust"]]) {
        const harness = await makeHarness(subtest);
        await mkdir(join(harness.root, "dist"));
        await writeFile(join(harness.root, "dist", "old-marker"), "from another tree");
        const result = await runCli(subtest, harness, flags);
        assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
        const events = await readEvents(harness);
        const buildFinish = cliCommandFinish(events, "pnpm build-vite");
        assert.ok(buildFinish, "the P1 frontend build must run");
        const consumer =
          flags[0] === "--bindings"
            ? "pnpm bindings:check"
            : "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check";
        assert.ok(at(buildFinish) < at(cliCommandStart(events, consumer)));
      }
    },
  );
});

test("contract-only invocation, unknown flags, and P0 guard failure/spawn failure (PG-81, PG-82, PG-83, PG-89)", async (t) => {
  await t.test("no flags runs only the mutation guard and contract lane", async (subtest) => {
    const harness = await makeHarness(subtest);
    const result = await runCli(subtest, harness);
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(commandSet(await readEvents(harness)), scheduledFakeCommands([]).sort());
  });

  await t.test("unknown flag exits 2 before spawning anything", async (subtest) => {
    const harness = await makeHarness(subtest);
    const result = await runCli(subtest, harness, ["--unexpected"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Unknown argument .*--unexpected/u);
    assert.deepEqual(await readEvents(harness), []);
  });

  await t.test(
    "invalid GATE_MEMORY_BYTES refuses Rust compilation inside the gate scope without spawning cargo clippy",
    async (subtest) => {
      const harness = await makeHarness(subtest);
      harness.env.GATE_MEMORY_BYTES = "abc";
      const result = await runCli(subtest, harness, ["--rust"]);
      assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /GATE_MEMORY_BYTES/u);
      const started = commandSet(await readEvents(harness));
      assert.ok(
        !started.includes(
          "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
        ),
        "cargo clippy must not spawn when in-scope sizing rejects GATE_MEMORY_BYTES",
      );
      assert.ok(
        !started.includes("pnpm rust:windows:check"),
        "later Rust commands must not start after sizing refusal",
      );
    },
  );

  await t.test(
    "failed mutation guard stops all later commands with its exit code",
    async (subtest) => {
      const harness = await makeHarness(subtest, {
        commands: { "pnpm mutation:guard:check": { exitCode: 7 } },
      });
      const result = await runCli(subtest, harness, ["--rust", "--frontend", "--bindings"]);
      assert.equal(result.code, 7, `${result.stdout}\n${result.stderr}`);
      assert.deepEqual(commandSet(await readEvents(harness)), ["pnpm mutation:guard:check"]);
    },
  );

  await t.test(
    "missing mutation-guard executable exits 127 and starts nothing else",
    async (subtest) => {
      const harness = await makeHarness(subtest, { omittedExecutables: ["pnpm"] });
      const result = await runCli(subtest, harness, ["--rust", "--frontend", "--bindings"]);
      assert.equal(result.code, 127, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /spawn pnpm ENOENT/u);
      assert.deepEqual(await readEvents(harness), []);
    },
  );
});

test("P0/P1 reds skip every subsequent selected gate (R2, R8, PG-63, PG-75, PG-76, PG-80, PG-91)", async (t) => {
  for (const [name, command, code] of [
    ["mutation-guard", "pnpm mutation:guard:check", 7],
    ["setup-rust", "bash scripts/setup-rust.sh", 6],
    ["frontend-build", "pnpm build-vite", 9],
    ["bindings-check", wrappedHeavyCommand("pnpm bindings:check"), 5],
  ]) {
    await t.test(`${name} red reports each selected gate exactly once`, async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      const events = [];
      const result = await runPushGates(["--rust", "--frontend", "--bindings"], {
        cwd,
        env: { ...process.env },
        discoverChangedPaths: () => ["README.md"],
        spawnProcess: makeMockSpawner({ events, exits: { [command]: code } }),
      });
      assert.equal(result.exitCode, code);
      const selected = [
        ...PUSH_GATE_SCHEDULE.p0,
        ...PUSH_GATE_SCHEDULE.p1,
        ...PUSH_GATE_SCHEDULE.lanes,
      ];
      assert.deepEqual(
        result.results.map(({ name }) => name),
        selected.map(({ name }) => name),
      );
      const redIndex = selected.findIndex((entry) => entry.name === name);
      assert.equal(result.results[redIndex].status, "failed");
      for (const task of result.results.slice(redIndex + 1)) {
        assert.equal(task.status, "skipped", task.name);
        assert.match(task.reason, new RegExp(`${name} failed`, "u"));
        assert.equal(task.code, undefined);
      }
      assert.deepEqual(
        commandSet(events),
        selected
          .slice(0, redIndex + 1)
          .map((entry) =>
            entry.heavyGateSlot ? wrappedHeavyCommand(entry.command) : entry.command,
          )
          .sort(),
      );
    });
  }

  for (const missing of ["pnpm", "bash"]) {
    await t.test(
      `missing ${missing} executable stops subsequent gates with 127`,
      async (subtest) => {
        const harness = await makeHarness(
          subtest,
          missing === "bash"
            ? { omittedExecutables: ["bash"] }
            : { commands: { "pnpm mutation:guard:check": { removeExecutable: "pnpm" } } },
        );
        const result = await runCli(subtest, harness, ["--rust", "--frontend", "--bindings"]);
        assert.equal(result.code, 127, `${result.stdout}\n${result.stderr}`);
        assert.match(result.stdout, new RegExp(`spawn ${missing} ENOENT`, "u"));
        assert.ok(!commandSet(await readEvents(harness)).includes("pnpm gates:contract:check"));
      },
    );
  }
});

test("spawn failures, signals and SIGKILL codes propagate from P0, P1 and lanes (PG-55, PG-65, PG-68, PG-77, PG-80)", async (t) => {
  await t.test("missing lane executable fails its lane with 127", async (subtest) => {
    const harness = await makeHarness(subtest, {
      commands: { "pnpm build-vite": { removeExecutable: "cargo" } },
    });
    const result = await runCli(subtest, harness, ["--rust"]);
    assert.notEqual(result.code, 0);
    assert.equal(result.code, 127);
    assert.match(result.stdout, /spawn cargo ENOENT/u);
  });

  for (const [name, args, command] of [
    ["setup-rust P0", ["--rust"], "bash scripts/setup-rust.sh"],
    ["frontend-build P1", ["--frontend"], "pnpm build-vite"],
    ["rust-lint lane", ["--rust"], "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check"],
  ]) {
    await t.test(`${name} SIGKILL maps to 137`, async (subtest) => {
      const harness = await makeHarness(subtest, {
        commands: { [command]: { killSelf: "SIGKILL" } },
      });
      const result = await runCli(subtest, harness, args);
      assert.equal(result.code, 137, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /exit=137|\s137\s/u);
    });
  }

  for (const [signal, expectedCode, args, command] of [
    ["SIGTERM", 143, ["--rust"], "bash scripts/setup-rust.sh"],
    ["SIGTERM", 143, ["--frontend"], "pnpm build-vite"],
  ]) {
    await t.test(
      `${signal} during ${command} latches and starts no later command`,
      async (subtest) => {
        const harness = await makeHarness(subtest, { commands: { [command]: { hold: true } } });
        const running = startCli(subtest, harness, args);
        const started = await waitForEvent(
          harness,
          (event) => event.type === "start" && event.command === command,
        );
        running.child.kill(signal);
        const result = await running.done;
        assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`);
        const commands = commandSet(await readEvents(harness));
        assert.deepEqual(
          commands,
          (args[0] === "--rust"
            ? ["pnpm mutation:guard:check", "pnpm rust:target:evict", command]
            : ["pnpm mutation:guard:check", command]
          ).sort(),
        );
        assert.equal(
          groupExists(started.pid),
          false,
          "the signalled fake process group must be gone",
        );
      },
    );
  }

  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    await t.test(
      `${signal} sent by a P1 fake that exits 0 prevents every later step`,
      async (subtest) => {
        const command = "pnpm build-vite";
        const harness = await makeHarness(subtest, {
          commands: { [command]: { signalRunner: signal, signalExitCode: 0 } },
        });
        const result = await runCli(subtest, harness, ["--frontend"]);
        assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`);
        const events = await readEvents(harness);
        assert.deepEqual(commandSet(events), ["pnpm mutation:guard:check", command].sort());
        assert.equal(cliCommandFinish(events, command).code, 0);
      },
    );
  }

  for (const signal of ["SIGTERM", "SIGINT"]) {
    await t.test(
      `${signal} while light lanes run cancels queued related-tests`,
      async (subtest) => {
        const harness = await makeHarness(subtest, {
          commands: {
            "pnpm gates:contract:check": { hold: true },
            "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check": { hold: true },
            "pnpm bundle:check": { hold: true },
          },
        });
        await mkdir(join(harness.root, "src/utils"), { recursive: true });
        await writeFile(join(harness.root, "src/utils/annotation.ts"), "export const a = 1;\n");
        const running = startCli(subtest, harness, ["--rust", "--frontend", "--bindings"]);
        const heldCommands = [
          "pnpm gates:contract:check",
          "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
          "pnpm bundle:check",
        ];
        const held = await Promise.all(
          heldCommands.map((command) =>
            waitForEvent(harness, (event) => event.type === "start" && event.command === command),
          ),
        );
        running.child.kill(signal);
        const result = await running.done;
        assert.equal(
          result.code,
          signal === "SIGINT" ? 130 : 143,
          `${result.stdout}\n${result.stderr}`,
        );
        for (const event of held) {
          assert.equal(
            groupExists(event.pid),
            false,
            `${event.command} process group ${event.pid} must be gone`,
          );
        }
        const commands = commandSet(await readEvents(harness));
        assert.ok(
          !commands.some((command) => command.includes("vitest related")),
          "related-tests must remain queued after cancellation",
        );
      },
    );
  }
});

test("lane command order, exit precedence, logs, e2e ordering and all-lane completion (PG-55, PG-56, PG-69, PG-70, PG-72, PG-74)", async (t) => {
  await t.test(
    "rust-lint stops at its first failing command and preserves its code",
    async (subtest) => {
      const first = "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check";
      const harness = await makeHarness(subtest, { commands: { [first]: { exitCode: 11 } } });
      const result = await runCli(subtest, harness, ["--rust"]);
      assert.equal(result.code, 11, `${result.stdout}\n${result.stderr}`);
      const commands = commandSet(await readEvents(harness));
      assert.ok(commands.includes(first));
      assert.ok(
        !commands.includes(
          "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
        ),
      );
      assert.ok(!commands.includes("pnpm rust:windows:check"));
    },
  );

  for (const [name, command, code] of [
    ["bundle", "pnpm bundle:check", 8],
    ["rust-lint", "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check", 12],
  ]) {
    await t.test(`${name} red skips related-tests`, async (subtest) => {
      const harness = await makeHarness(subtest, { commands: { [command]: { exitCode: code } } });
      await mkdir(join(harness.root, "src/utils"), { recursive: true });
      await writeFile(join(harness.root, "src/utils/annotation.ts"), "export const a = 1;\n");
      const result = await runCli(subtest, harness, ["--rust", "--frontend"]);
      assert.equal(result.code, code, `${result.stdout}\n${result.stderr}`);
      const events = await readEvents(harness);
      assert.equal(cliCommandFinish(events, command).code, code);
      assert.ok(
        !events.some((event) => event.type === "start" && event.command.includes("vitest related")),
        "related-tests must not start after a red light lane",
      );
    });
  }

  await t.test("P0/P1 failures take exit precedence over lane failures", async (subtest) => {
    const harness = await makeHarness(subtest, {
      commands: {
        "bash scripts/setup-rust.sh": { exitCode: 4 },
        "pnpm gates:contract:check": { exitCode: 7 },
      },
    });
    const result = await runCli(subtest, harness, ["--rust"]);
    assert.equal(result.code, 4, `${result.stdout}\n${result.stderr}`);
  });

  await t.test(
    "P1 failure takes exit precedence and the first failed lane follows table order",
    async (subtest) => {
      const buildCommand = "pnpm build-vite";
      const contractCommand = "pnpm gates:contract:check";
      const cargoCommand = "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check";
      const harness = await makeHarness(subtest, {
        commands: {
          [buildCommand]: { exitCode: 4 },
          [contractCommand]: { exitCode: 7 },
          [cargoCommand]: { exitCode: 11 },
        },
      });
      const result = await runCli(subtest, harness, ["--rust", "--frontend"]);
      assert.equal(result.code, 4, `${result.stdout}\n${result.stderr}`);
      const events = await readEvents(harness);
      assert.equal(cliCommandFinish(events, contractCommand), undefined);
      assert.equal(
        cliCommandFinish(events, cargoCommand),
        undefined,
        "failed P1 skips cargo consumers",
      );

      const laneHarness = await makeHarness(subtest, {
        commands: {
          [contractCommand]: { exitCode: 7 },
          [cargoCommand]: { exitCode: 11 },
        },
      });
      const laneResult = await runCli(subtest, laneHarness, ["--rust"]);
      assert.equal(laneResult.code, 7, `${laneResult.stdout}\n${laneResult.stderr}`);
      const laneEvents = await readEvents(laneHarness);
      assert.equal(cliCommandFinish(laneEvents, contractCommand).code, 7);
      assert.equal(cliCommandFinish(laneEvents, cargoCommand).code, 11);
    },
  );

  await t.test(
    "logs contain command output, summary statuses, and failed-lane tails",
    async (subtest) => {
      const harness = await makeHarness(subtest, {
        commands: { "pnpm bundle:check": { exitCode: 13 } },
      });
      const result = await runCli(subtest, harness, ["--rust", "--frontend", "--bindings"]);
      assert.equal(result.code, 13);
      const directories = await readdir(join(harness.root, "artifacts", "gates"));
      assert.equal(directories.length, 1);
      const bundleLog = await readFile(
        join(harness.root, "artifacts", "gates", directories[0], "bundle.log"),
        "utf8",
      );
      assert.match(bundleLog, /fake-output:pnpm:bundle:check/u);
      for (const lane of ["contract", "rust-lint", "bundle", "related-tests"]) {
        assert.match(
          result.stdout,
          new RegExp(`${lane}\\s+(?:passed|failed|skipped|stopped)`, "u"),
        );
      }
      const logForCommand = new Map([
        ["pnpm mutation:guard:check", "mutation-guard"],
        ["pnpm rust:target:evict", "rust-target-eviction"],
        ["bash scripts/setup-rust.sh", "setup-rust"],
        ["pnpm build-vite", "frontend-build"],
        ["pnpm bindings:check", "bindings-check"],
        ["pnpm gates:contract:check", "contract"],
        ["pnpm findings:kit:check", "contract"],
        ["cargo fmt --manifest-path src-tauri/Cargo.toml -- --check", "rust-lint"],
        [
          "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
          "rust-lint",
        ],
        ["pnpm rust:windows:check", "rust-lint"],
        ["pnpm bundle:check", "bundle"],
      ]);
      for (const event of (await readEvents(harness)).filter((entry) => entry.type === "start")) {
        const taskName = logForCommand.get(event.command);
        assert.ok(taskName, `missing log mapping for ${event.command}`);
        const output = `fake-output:${event.executable}:${event.args.join("|")}`;
        const laneLog = await readFile(
          join(harness.root, "artifacts", "gates", directories[0], `${taskName}.log`),
          "utf8",
        );
        assert.ok(laneLog.includes(output), `${taskName}.log is missing ${output}`);
      }
      assert.match(result.stdout, /bundle log tail/u);
      assert.match(result.stdout, /fake-output:pnpm:bundle:check/u);
    },
  );
});

test("P2 light concurrency, related-tests ordering, and contract-only isolation", async (t) => {
  await t.test(
    "contract, rust-lint and bundle run concurrently before related-tests starts",
    async (subtest) => {
      const barrierLanes = ["contract", "rust-lint", "bundle"];
      const commands = {
        "pnpm gates:contract:check": { barrierLane: "contract" },
        "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check": { barrierLane: "rust-lint" },
        "pnpm bundle:check": { barrierLane: "bundle" },
      };
      const harness = await makeHarness(subtest, {
        barrierLanes,
        commands,
      });
      await mkdir(join(harness.root, "src/utils"), { recursive: true });
      await writeFile(join(harness.root, "src/utils/annotation.ts"), "export const a = 1;\n");
      const result = await runCli(subtest, harness, ["--rust", "--frontend", "--bindings"]);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const markers = await readdir(join(harness.state, "barrier"));
      assert.deepEqual(markers.sort(), [...barrierLanes].sort());
      const events = await readEvents(harness);
      const relatedStart = cliCommandStart(
        events,
        "pnpm exec vitest related --run --passWithNoTests src/utils/annotation.ts",
      );
      assert.ok(relatedStart, "related-tests vitest command must run");
      for (const lightFinishCommand of [
        "pnpm findings:kit:check",
        "pnpm rust:windows:check",
        "pnpm bundle:check",
      ]) {
        const finished = cliCommandFinish(events, lightFinishCommand);
        assert.ok(finished, `missing finish for ${lightFinishCommand}`);
        assert.ok(
          at(finished) < at(relatedStart),
          `related-tests must wait for ${lightFinishCommand}`,
        );
      }
    },
  );

  await t.test("contract-only runs spawn no agent-gate or Rust sizing command", async (subtest) => {
    const cwd = await temporarySchedulerRoot(subtest);
    const events = [];
    const env = { ...process.env, GATE_MEMORY_BYTES: "not-a-number" };
    delete env.CARGO_BUILD_JOBS;
    const result = await runPushGates([], {
      cwd,
      env,
      spawnProcess: makeMockSpawner({ events }),
    });
    assert.equal(result.exitCode, 0);
    const starts = events.filter((event) => event.type === "start");
    assert.ok(starts.length > 0);
    for (const event of starts) {
      assert.notEqual(event.executable, GATE_LAUNCHER);
      assert.ok(!event.args.includes(RUST_SIZING_MODE_FLAG));
      assert.equal(event.env.CARGO_BUILD_JOBS, undefined);
    }
  });
});

test("a passing lane retains its complete output line across a short final write", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  const line = "complete lane output ä\n";
  let shortWrites = 0;
  const result = await runPushGates([], {
    cwd,
    env: { ...process.env },
    spawnProcess: makeMockSpawner({ stdout: line }),
    writeCapturedOutput(fd, chunk) {
      writeLogChunk(fd, chunk, (descriptor, buffer, offset, length) => {
        const written = length > 1 ? length - 1 : length;
        if (written < length) shortWrites += 1;
        return writeSync(descriptor, buffer, offset, written);
      });
    },
  });
  const lane = result.results.find((task) => task.name === "contract");
  assert.ok(shortWrites > 0, "the captured-output writer must exercise short writes");
  assert.equal(result.exitCode, 0);
  assert.equal(lane.status, "passed");
  assert.equal(lane.logError, undefined);
  const commands = PUSH_GATE_SCHEDULE.lanes.find((entry) => entry.name === "contract").commands;
  assert.equal(
    await readFile(lane.logPath, "utf8"),
    commands.map((command) => `$ ${command}\n${line}`).join(""),
  );
});

test(
  "a lane header ENOSPC fails the task without leaking its descriptor",
  { skip: !existsSync("/dev/full") || !existsSync("/proc/self/fd") },
  async (t) => {
    const cwd = await temporarySchedulerRoot(t);
    const events = [];
    const descriptorsBefore = readdirSync("/proc/self/fd").length;
    const result = await runPushGates([], {
      cwd,
      env: { ...process.env },
      spawnProcess: makeMockSpawner({ events }),
      async beforeStep({ name, index }) {
        if (name !== "contract" || index !== 0) return;
        const base = join(cwd, "artifacts", "gates");
        const runs = await readdir(base);
        assert.equal(runs.length, 1);
        await symlink("/dev/full", join(base, runs[0], "contract.log"));
      },
    });
    const descriptorsAfter = readdirSync("/proc/self/fd").length;
    const lane = result.results.find((task) => task.name === "contract");
    assert.equal(result.exitCode, 1);
    assert.equal(lane.status, "failed");
    assert.equal(lane.code, 1);
    assert.equal(lane.error.code, "ENOSPC");
    assert.equal(lane.failedCommand, "pnpm gates:contract:check");
    assert.deepEqual(
      events.filter((event) => event.type === "start").map((event) => event.command),
      ["pnpm mutation:guard:check"],
    );
    assert.equal(
      descriptorsAfter,
      descriptorsBefore,
      "a failed header write must close its descriptor",
    );
  },
);

test("gate log write failures preserve command results and fail successful commands", async (t) => {
  for (const [commandCode, expectedCode] of [
    [17, 17],
    [0, 1],
  ]) {
    await t.test(
      `child exit ${commandCode} reports the log failure with exit ${expectedCode}`,
      async (subtest) => {
        const cwd = await temporarySchedulerRoot(subtest);
        const spawnProcess = () => {
          const child = new EventEmitter();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.pid = undefined;
          child.exitCode = null;
          child.signalCode = null;
          setImmediate(() => {
            child.stdout.write("child output\n");
            child.stdout.end();
            child.stderr.end();
            setImmediate(() => {
              child.exitCode = commandCode;
              child.emit("close", commandCode, null);
            });
          });
          return child;
        };
        const result = await runPushGates([], {
          cwd,
          env: { ...process.env },
          spawnProcess,
          writeCapturedOutput() {
            throw new Error("injected log EIO");
          },
        });
        const guard = result.results.find((task) => task.name === "mutation-guard");
        assert.equal(result.exitCode, expectedCode);
        assert.equal(guard.code, expectedCode);
        assert.equal(guard.logError.message, "injected log EIO");
        if (commandCode === 0) {
          assert.match(guard.error.message, /cannot write gate log: injected log EIO/u);
        } else {
          assert.equal(guard.error, undefined);
        }
      },
    );
  }
});

test("signal cleanup failure stops waiting on the child and reports nested termination errors", async (t) => {
  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    await t.test(
      `${signal} returns its signal code and names the child and cause`,
      async (subtest) => {
        const cwd = await temporarySchedulerRoot(subtest);
        const fakePid = 987_654_321;
        const originalKill = process.kill;
        const originalStderrWrite = process.stderr.write;
        let stderr = "";
        let child;
        process.kill = function (pid, childSignal) {
          if (pid === -fakePid && childSignal !== 0) {
            const error = new Error("injected EPERM");
            error.code = "EPERM";
            throw error;
          }
          return Reflect.apply(originalKill, process, [pid, childSignal]);
        };
        process.stderr.write = function (chunk) {
          stderr += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          return true;
        };
        try {
          const running = runPushGates([], {
            cwd,
            env: { ...process.env },
            spawnProcess() {
              child = new EventEmitter();
              child.stdout = new PassThrough();
              child.stderr = new PassThrough();
              child.pid = fakePid;
              child.exitCode = null;
              child.signalCode = null;
              child.unref = () => {};
              setImmediate(() => process.emit(signal, signal));
              return child;
            },
          });
          let timeout;
          const outcome = await Promise.race([
            running.then((result) => ({ result })),
            new Promise((resolve) => {
              timeout = setTimeout(() => resolve({ timedOut: true }), 1_000);
            }),
          ]);
          clearTimeout(timeout);
          if (outcome.timedOut) {
            child.exitCode = 0;
            child.stdout.end();
            child.stderr.end();
            child.emit("close", 0, null);
            await running;
            assert.fail("the scheduler waited for a child after termination failed");
          }
          assert.equal(outcome.result.exitCode, expectedCode);
        } finally {
          process.kill = originalKill;
          process.stderr.write = originalStderrWrite;
        }
        assert.match(stderr, /P0 step mutation-guard \(pnpm mutation:guard:check\)/u);
        assert.match(stderr, /injected EPERM/u);
      },
    );
  }
});

test("interrupted lanes retain shutdown output and record the child's exit", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  const interruptedCommand = "pnpm gates:contract:check";
  const cleanupOutput =
    "Failed to stop and remove e2e container fixture: injected cleanup refusal; a retry is not known to be clean.";
  const spawnProcess = (executable, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = undefined;
    child.exitCode = null;
    child.signalCode = null;
    child.command = [executable, ...args].join(" ");
    if (child.command === interruptedCommand) {
      setImmediate(() => process.emit("SIGTERM", "SIGTERM"));
    }
    return child;
  };
  const superviseProcess = (child) => {
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const exitOrTerminationFailure = () => done.then((result) => ({ type: "exit", result }));
    if (child.command === interruptedCommand) {
      let terminating = false;
      return {
        done,
        exitOrTerminationFailure,
        terminate() {
          if (!terminating) {
            terminating = true;
            child.stdout.write(`${cleanupOutput}\n`);
            child.stdout.end();
            child.stderr.end();
            child.exitCode = 1;
            setImmediate(() => resolveDone({ code: 1, signal: null }));
          }
          return done;
        },
        unref() {},
      };
    }
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.exitCode = 0;
      resolveDone({ code: 0, signal: null });
    });
    return {
      done,
      exitOrTerminationFailure,
      terminate: () => done,
      unref() {},
    };
  };

  let summary = "";
  const originalStdoutWrite = process.stdout.write;
  process.stdout.write = function (chunk, encoding, callback) {
    summary += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (typeof encoding === "function") encoding();
    if (typeof callback === "function") callback();
    return true;
  };
  let result;
  try {
    result = await runPushGates([], {
      cwd,
      env: { ...process.env },
      spawnProcess,
      superviseProcess,
    });
  } finally {
    process.stdout.write = originalStdoutWrite;
  }

  const contract = result.results.find((task) => task.name === "contract");
  assert.equal(result.exitCode, 143);
  assert.equal(contract.status, "interrupted");
  assert.equal(contract.code, 143);
  assert.equal(contract.childExitCode, 1);
  assert.equal(contract.childSignal, null);
  assert.match(summary, /contract\s+interrupted; child exit 1\s+143/u);
  assert.ok(summary.includes(`contract log tail (${contract.logPath}):`));
  assert.ok(summary.includes(cleanupOutput));
  assert.match(await readFile(contract.logPath, "utf8"), /injected cleanup refusal/u);
  assert.equal(
    summary.trimEnd().split("\n").at(-1),
    `push gate failed: contract — log: ${contract.logPath}`,
  );
});

test("scheduler-level beforeStep cancellation and injected spawn failures (PG-51, PG-55, PG-58)", async (t) => {
  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    await t.test(
      `beforeStep ${signal} after guard completion prevents setup-rust spawn`,
      async (subtest) => {
        const cwd = await temporarySchedulerRoot(subtest);
        const events = [];
        const beforeStepNames = [];
        const result = await runPushGates(["--rust"], {
          cwd,
          env: { ...process.env },
          spawnProcess: makeMockSpawner({ events }),
          async beforeStep({ name }) {
            beforeStepNames.push(name);
            if (name === "setup-rust") process.emit(signal, signal);
          },
        });
        assert.equal(result.exitCode, expectedCode, JSON.stringify(result));
        assert.deepEqual(beforeStepNames, ["mutation-guard", "rust-target-eviction", "setup-rust"]);
        assert.deepEqual(
          events.filter((event) => event.type === "start").map((event) => event.command),
          ["pnpm mutation:guard:check", "pnpm rust:target:evict"],
        );
      },
    );
  }

  await t.test("injected spawn ENOENT is reported as 127 with no shell", async (subtest) => {
    const cwd = await temporarySchedulerRoot(subtest);
    const events = [];
    const spawnProcess = (executable, args, options) => {
      assert.equal(options.shell, undefined);
      const command = [executable, ...args].join(" ");
      events.push({ type: "start", command });
      if (command === "pnpm build-vite") {
        const error = new Error("injected ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return makeMockSpawner({ events })(executable, args, options);
    };
    const result = await runPushGates(["--frontend"], {
      cwd,
      env: { ...process.env, GATE_MEMORY_BYTES: String(7 * GIB) },
      discoverChangedPaths: () => ["README.md"],
      spawnProcess,
    });
    assert.equal(result.exitCode, 127);
    assert.ok(result.results.some((task) => task.name === "frontend-build" && task.code === 127));
    assert.ok(result.results.some((task) => task.name === "bundle" && task.status === "skipped"));
  });
});

test("push schedule excludes heavy lanes and uses direct pnpm build-vite in P1", () => {
  assert.equal(PUSH_GATE_SCHEDULE.p1[0].command, "pnpm build-vite");
  assert.equal(PRE_REVIEW_GATE_SCHEDULE.p1[0].command, "pnpm build-vite");
  const laneNames = PUSH_GATE_SCHEDULE.lanes.map(({ name }) => name);
  for (const removed of [
    "frontend-mutation",
    "rust-test",
    "rust-coverage",
    "frontend-coverage",
    "e2e",
  ]) {
    assert.equal(
      laneNames.includes(removed),
      false,
      `${removed} must not be in PUSH_GATE_SCHEDULE`,
    );
  }
  assert.deepEqual(laneNames, ["contract", "rust-lint", "bundle", "related-tests"]);
});

test("buildRelatedTestCommands returns exact vitest and cargo commands for changed paths", async (t) => {
  const root = await temporarySchedulerRoot(t);
  for (const path of [
    "src/utils/annotation.ts",
    "scripts/check-untranslated-jsx.mjs",
    "scripts/run-push-gates-tests.mjs",
    "src-tauri/src/lexer.rs",
    "src-tauri/src/db/mod.rs",
    "src-tauri/src/main.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "// fixture\n");
  }

  const filtered = buildRelatedTestCommands(
    [
      "src/utils/annotation.ts",
      "src-tauri/src/lexer.rs",
      "src-tauri/src/db/mod.rs",
      "src/utils/deleted.ts",
    ],
    { root },
  );
  assert.deepEqual(
    filtered.map(({ display, heavyGateSlot }) => ({ display, heavyGateSlot })),
    [
      {
        display: "pnpm exec vitest related --run --passWithNoTests src/utils/annotation.ts",
        heavyGateSlot: true,
      },
      {
        display: "cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- db:: lexer::",
        heavyGateSlot: true,
      },
    ],
  );

  assert.deepEqual(
    buildRelatedTestCommands(
      ["scripts/check-untranslated-jsx.mjs", "scripts/run-push-gates-tests.mjs"],
      { root },
    ).map(({ display, heavyGateSlot }) => ({ display, heavyGateSlot })),
    [
      {
        display:
          "pnpm exec vitest related --run --passWithNoTests scripts/check-untranslated-jsx.mjs",
        heavyGateSlot: true,
      },
    ],
  );

  const withMain = buildRelatedTestCommands(
    [
      "src/utils/annotation.ts",
      "src-tauri/src/lexer.rs",
      "src-tauri/src/db/mod.rs",
      "src/utils/deleted.ts",
      "src-tauri/src/main.rs",
    ],
    { root },
  );
  assert.deepEqual(
    withMain.map(({ display, heavyGateSlot }) => ({ display, heavyGateSlot })),
    [
      {
        display: "pnpm exec vitest related --run --passWithNoTests src/utils/annotation.ts",
        heavyGateSlot: true,
      },
      {
        display: "cargo test --manifest-path src-tauri/Cargo.toml --locked --bins",
        heavyGateSlot: true,
      },
    ],
  );

  for (const manifest of ["src-tauri/Cargo.toml", "src-tauri/Cargo.lock"]) {
    assert.deepEqual(
      buildRelatedTestCommands([manifest], { root }).map(({ display, heavyGateSlot }) => ({
        display,
        heavyGateSlot,
      })),
      [
        {
          display: "cargo test --manifest-path src-tauri/Cargo.toml --locked --bins",
          heavyGateSlot: true,
        },
      ],
    );
  }

  assert.deepEqual(buildRelatedTestCommands(["src/utils/deleted.ts", "README.md"], { root }), []);
});

test("related-tests runs Cargo through agent-gate with sizing mode and Vitest through agent-gate without it (f-20261125-07)", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  for (const path of ["src/utils/annotation.ts", "src-tauri/src/lexer.rs"]) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), "// fixture\n");
  }
  const events = [];
  const env = { ...process.env };
  delete env.CARGO_BUILD_JOBS;
  const result = await runPushGates(["--frontend"], {
    cwd,
    env,
    discoverChangedPaths: () => ["src/utils/annotation.ts", "src-tauri/src/lexer.rs"],
    spawnProcess: makeMockSpawner({ events }),
  });
  assert.equal(result.exitCode, 0);
  const expectedCargo = wrappedHeavyCommand(
    "cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- lexer::",
  );
  const cargoStart = cliCommandStart(events, expectedCargo);
  const vitestStart = cliCommandStart(events, slotVitestRelated("src/utils/annotation.ts"));
  assert.ok(cargoStart, "related-tests cargo command must run through agent-gate");
  assert.ok(vitestStart, "related-tests vitest command must take a slot through agent-gate");
  assert.equal(cargoStart.executable, GATE_LAUNCHER);
  assert.equal(cargoStart.env.CARGO_BUILD_JOBS, undefined);
  assert.equal(vitestStart.executable, GATE_LAUNCHER);
  assert.deepEqual(vitestStart.args, [
    "pnpm",
    "exec",
    "vitest",
    "related",
    "--run",
    "--passWithNoTests",
    "src/utils/annotation.ts",
  ]);
  assert.ok(!vitestStart.args.includes(RUST_SIZING_MODE_FLAG));
  assert.equal(vitestStart.env.CARGO_BUILD_JOBS, undefined);
  const starts = events.filter((event) => event.type === "start");
  assert.ok(
    starts.indexOf(vitestStart) < starts.indexOf(cargoStart),
    "related-tests runs its slot-taking commands one after the other",
  );
  assert.ok(
    events.findIndex((event) => event.type === "finish" && event.command === vitestStart.command) <
      events.indexOf(cargoStart),
    "the Cargo command must not start before the Vitest command released its slot",
  );
});

test("related-tests reports missing upstream separately from other git failures", async (t) => {
  await t.test("missing upstream names missing upstream", async (subtest) => {
    const harness = await makeHarness(subtest, { upstream: false });
    const result = await runCli(subtest, harness, ["--frontend"]);
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /related-tests\s+failed/u);
    assert.match(result.stdout, /Cannot determine related-tests changed paths: missing upstream/u);
  });

  await t.test("non-upstream git failure uses the neutral headline", async (subtest) => {
    const cwd = await temporarySchedulerRoot(subtest);
    const result = await runPushGates(["--frontend"], {
      cwd,
      env: { ...process.env },
      runGit: (_executable, args) =>
        args[0] === "merge-base"
          ? { status: 0, stdout: "base-commit\n" }
          : { status: 128, stdout: "", stderr: "injected diff failure" },
      spawnProcess: makeMockSpawner(),
    });
    assert.equal(result.exitCode, 1);
    const related = result.results.find((task) => task.name === "related-tests");
    assert.equal(related.status, "failed");
    assert.match(
      related.error.message,
      /^Cannot determine related-tests changed paths: git diff --name-only -z base-commit -- failed \(injected diff failure\)$/u,
    );
    assert.doesNotMatch(related.error.message, /missing upstream/iu);
  });
});

test("--base parsing accepts one commit and refuses a missing, flag-like or repeated value", () => {
  assert.deepEqual(parsePushGateArguments(["--", "--frontend", "--base", "abc123"]), {
    blocks: new Set(["frontend"]),
    base: "abc123",
  });
  assert.equal(parsePushGateArguments(["--base=abc123"]).base, "abc123");
  assert.equal(parsePushGateArguments(["--rust"]).base, undefined);
  assert.match(parsePushGateArguments(["--base"]).error, /--base needs a commit/u);
  assert.match(parsePushGateArguments(["--base", "--rust"]).error, /--base needs a commit/u);
  assert.match(parsePushGateArguments(["--base="]).error, /--base needs a commit/u);
  assert.match(
    parsePushGateArguments(["--base", "a", "--base", "b"]).error,
    /--base given more than once/u,
  );
});

test("a published range (HEAD = @{u}) selects its paths for related-tests only with --base (f-20261124-03)", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  await initializeUpstream(cwd, { files: { ".gitignore": "/artifacts/\n" } });
  const rangeStart = git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  const sourcePath = "src/utils/annotation.ts";
  await mkdir(dirname(join(cwd, sourcePath)), { recursive: true });
  await writeFile(join(cwd, sourcePath), "export const annotation = 1;\n");
  git(cwd, ["add", sourcePath]);
  git(cwd, ["commit", "--quiet", "-m", "range"]);
  git(cwd, ["push", "--quiet"]);
  assert.equal(
    git(cwd, ["rev-parse", "HEAD"]).stdout,
    git(cwd, ["rev-parse", "@{u}"]).stdout,
    "fixture must be fully published",
  );
  const vitest = slotVitestRelated(sourcePath);

  const withoutBase = [];
  const unscoped = await runPushGates(["--frontend"], {
    cwd,
    env: { ...process.env },
    spawnProcess: makeMockSpawner({ events: withoutBase }),
  });
  assert.equal(unscoped.exitCode, 1, "an empty published range must not pass vacuously");
  assert.equal(cliCommandStart(withoutBase, vitest), undefined);
  const refused = unscoped.results.find((task) => task.name === "related-tests");
  assert.equal(refused.status, "failed");
  assert.match(refused.error.message, /HEAD is already published\. Pass --base <commit>/u);

  const emptyRange = await runPushGates(["--frontend", "--base", "HEAD"], {
    cwd,
    env: { ...process.env },
    spawnProcess: makeMockSpawner(),
  });
  assert.equal(emptyRange.exitCode, 1);
  assert.match(
    emptyRange.results.find((task) => task.name === "related-tests").error.message,
    /No changed paths since merge-base HEAD HEAD: the range to prove is empty\./u,
  );

  for (const baseArguments of [["--base", rangeStart], [`--base=${rangeStart}`]]) {
    const events = [];
    const result = await runPushGates(["--", "--frontend", ...baseArguments], {
      cwd,
      env: { ...process.env },
      spawnProcess: makeMockSpawner({ events }),
    });
    assert.equal(result.exitCode, 0);
    assert.ok(cliCommandStart(events, vitest), `related-tests must test ${sourcePath}`);
  }
});

test("an unresolvable --base fails related-tests without calling it a missing upstream", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  await initializeUpstream(cwd, { upstream: false });
  const result = await runPushGates(["--frontend", "--base", "no-such-commit"], {
    cwd,
    env: { ...process.env },
    spawnProcess: makeMockSpawner(),
  });
  assert.equal(result.exitCode, 1);
  const related = result.results.find((task) => task.name === "related-tests");
  assert.equal(related.status, "failed");
  assert.match(
    related.error.message,
    /^Cannot determine related-tests changed paths: git merge-base HEAD no-such-commit failed/u,
  );
  assert.doesNotMatch(related.error.message, /missing upstream/iu);
});

test("Cargo allocation survives production bindings and Windows entrypoints", async (t) => {
  const exporter = [
    "cargo",
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--bin",
    "chessriddle-studio",
    "--",
    "--export-bindings-only",
  ];
  const windows = [
    "cargo",
    "clippy",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--target",
    "x86_64-pc-windows-gnu",
    "--all-targets",
    "--locked",
    "--",
    "-D",
    "warnings",
  ];
  for (const flags of [["--rust"], ["--bindings"], ["--rust", "--frontend", "--bindings"]]) {
    await t.test(flags.join(" "), async (subtest) => {
      const harness = await makeHarness(subtest, {
        extraExecutables: ["rustup", "rustc"],
      });
      const { root, bin } = harness;
      const scripts = join(root, "scripts");
      await mkdir(scripts, { recursive: true });
      for (const name of [
        "check-bindings.mjs",
        "rust-windows-check.mjs",
        "child-supervisor.mjs",
        "entrypoint.mjs",
        "gate-logs.mjs",
        "executable-path.mjs",
      ]) {
        await copyFile(join(repositoryRoot, "scripts", name), join(scripts, name));
      }
      await symlink(process.execPath, join(bin, "node"));
      const mingwBin = join(root, "mingw/usr/bin");
      await mkdir(mingwBin, { recursive: true });
      await symlink(join(bin, "cargo"), join(mingwBin, "x86_64-w64-mingw32-gcc"));
      const binding = join(root, "src/bindings/generated.ts");
      await mkdir(dirname(binding), { recursive: true });
      await writeFile(binding, "// fixture bindings\n");
      const entrypoint = (name, ...args) => ({
        childCommand: [process.execPath, join(scripts, name), ...args],
      });
      await writeFile(
        harness.configPath,
        JSON.stringify({
          commands: {
            "pnpm bindings:check": entrypoint("check-bindings.mjs"),
            "pnpm rust:windows:check": entrypoint("rust-windows-check.mjs"),
            "rustc --version": { stdout: "rustc fixture\n" },
            "cargo --version": { stdout: "cargo fixture\n" },
            "rustup target list --installed": { stdout: "x86_64-pc-windows-gnu\n" },
          },
        }),
      );
      harness.env.CARGO_BUILD_JOBS = "64";
      harness.env.CARGO_HOME = join(root, "cargo-home");
      harness.env.CARGO_TARGET_DIR = join(root, "src-tauri/target");
      harness.env.CHESSFABLE_MINGW_PREFIX = join(root, "mingw");
      delete harness.env.RUST_TEST_THREADS;
      const result = await runCli(subtest, harness, flags);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const events = await readEvents(harness);
      const expected = [
        ...(flags.includes("--bindings") ? [exporter] : []),
        ...(flags.includes("--rust") ? [windows] : []),
      ];
      for (const argv of expected) {
        const compiler = cliCommandStart(events, argv.join(" "));
        assert.ok(compiler, `missing compiler/exporter process ${argv.join(" ")}`);
        assert.equal(compiler.jobs, "1", compiler.command);
        assert.equal(compiler.cwd, root, compiler.command);
        assert.equal(
          compiler.testThreads,
          undefined,
          "compilation sizing must not set libtest concurrency",
        );
      }
    });
  }
});

test("known insufficient Rust memory refuses bindings-only and all-block exporters before spawn", async (t) => {
  for (const flags of [["--bindings"], ["--rust", "--frontend", "--bindings"]]) {
    const harness = await makeHarness(t, { budgetBytes: 9 * GIB - 1 });
    const result = await runCli(t, harness, flags);
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Rust compilation refused:.*below the minimum.*9 GiB usable/u);
    const commands = commandSet(await readEvents(harness));
    assert.deepEqual(
      commands,
      [
        "pnpm mutation:guard:check",
        "pnpm rust:target:evict",
        "bash scripts/setup-rust.sh",
        "pnpm build-vite",
      ].sort(),
    );
  }
});

test("rust-lint clippy red skips related-tests with its reason (R1)", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  await mkdir(join(cwd, "src/utils"), { recursive: true });
  await writeFile(join(cwd, "src/utils/annotation.ts"), "export const a = 1;\n");
  const events = [];
  const clippy = wrappedHeavyCommand(
    "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
  );
  const result = await runPushGates(["--rust", "--frontend"], {
    cwd,
    env: { ...process.env },
    discoverChangedPaths: () => ["src/utils/annotation.ts"],
    spawnProcess: makeMockSpawner({
      events,
      exits: { [clippy]: 11 },
    }),
  });
  assert.equal(result.exitCode, 11);
  const related = result.results.find((task) => task.name === "related-tests");
  assert.equal(related.status, "skipped");
  assert.match(related.reason, /rust-lint failed/u);
  assert.equal(cliCommandStart(events, slotVitestRelated("src/utils/annotation.ts")), undefined);
  assert.equal(cliCommandStart(events, wrappedHeavyCommand("pnpm rust:windows:check")), undefined);
});

test("a running contract command completes after rust-lint red and related-tests does not start (P3, R3)", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  await mkdir(join(cwd, "src/utils"), { recursive: true });
  await writeFile(join(cwd, "src/utils/annotation.ts"), "export const a = 1;\n");
  const events = [];
  const contractLast = "env -u KIT_ROOT pnpm findings:kit:check";
  const lint = wrappedHeavyCommand(
    "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
  );
  const result = await runPushGates(["--rust", "--frontend"], {
    cwd,
    env: { ...process.env },
    discoverChangedPaths: () => ["src/utils/annotation.ts"],
    spawnProcess: makeMockSpawner({
      events,
      exits: { [lint]: 11 },
      async beforeClose(command) {
        if (command === lint) await waitForMockEvent(events, "start", contractLast);
        if (command === contractLast) await waitForMockEvent(events, "finish", lint);
      },
    }),
  });
  assert.equal(result.exitCode, 11);
  assert.equal(result.results.find(({ name }) => name === "contract").status, "passed");
  assert.ok(cliCommandFinish(events, contractLast));
  assert.equal(result.results.find((task) => task.name === "related-tests").status, "skipped");
  assert.equal(cliCommandStart(events, slotVitestRelated("src/utils/annotation.ts")), undefined);
});

test("a running multi-command lane stops at its next boundary without an exit code (R4)", async (t) => {
  const cwd = await temporarySchedulerRoot(t);
  const events = [];
  const contract = "pnpm gates:contract:check";
  const fmt = "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check";
  const result = await runPushGates(["--rust"], {
    cwd,
    env: { ...process.env },
    discoverChangedPaths: () => ["README.md"],
    spawnProcess: makeMockSpawner({
      events,
      exits: { [contract]: 7 },
      async beforeClose(command) {
        if (command === contract) await waitForMockEvent(events, "start", fmt);
        if (command === fmt) await waitForMockEvent(events, "finish", contract);
      },
    }),
  });
  assert.equal(result.exitCode, 7);
  const lint = result.results.find(({ name }) => name === "rust-lint");
  assert.equal(lint.status, "stopped");
  assert.equal(lint.code, undefined);
  assert.match(lint.reason, /contract failed/u);
  assert.ok(cliCommandFinish(events, fmt));
  for (const command of PUSH_GATE_SCHEDULE.lanes
    .find(({ name }) => name === "rust-lint")
    .commands.slice(1)) {
    assert.equal(cliCommandStart(events, wrappedHeavyCommand(command)), undefined);
  }
});

test("light stage waits for held contract after rust-lint passes before related-tests starts (R9)", async (t) => {
  for (const flags of [["--rust", "--frontend"], ["--frontend"]]) {
    for (const contractCode of [0, 7]) {
      await t.test(`${flags.join(" ")} contract exits ${contractCode}`, async (subtest) => {
        const cwd = await temporarySchedulerRoot(subtest);
        await mkdir(join(cwd, "src/utils"), { recursive: true });
        await writeFile(join(cwd, "src/utils/annotation.ts"), "export const a = 1;\n");
        const events = [];
        const contractLast = "env -u KIT_ROOT pnpm findings:kit:check";
        const relatedCommand = slotVitestRelated("src/utils/annotation.ts");
        let startedWhileHeld;
        const result = await runPushGates(flags, {
          cwd,
          env: { ...process.env },
          discoverChangedPaths: () => ["src/utils/annotation.ts"],
          spawnProcess: makeMockSpawner({
            events,
            exits: { [contractLast]: contractCode },
            async beforeClose(command) {
              if (command === contractLast) {
                await waitForMockEvent(
                  events,
                  "finish",
                  flags.includes("--rust")
                    ? wrappedHeavyCommand("pnpm rust:windows:check")
                    : "pnpm bundle:check",
                );
                startedWhileHeld = cliCommandStart(events, relatedCommand);
              }
            },
          }),
        });
        assert.equal(result.exitCode, contractCode);
        assert.equal(
          startedWhileHeld,
          undefined,
          "related-tests started while contract was running",
        );
        const contractFinish = events.indexOf(cliCommandFinish(events, contractLast));
        const started = cliCommandStart(events, relatedCommand);
        if (contractCode) assert.equal(started, undefined);
        else assert.ok(events.indexOf(started) > contractFinish);
      });
    }
  }
});

test("unconfirmed process cleanup blocks queued related-tests starts after P1 or a Rust lane", async (t) => {
  for (const [command, spawnedCommand] of [
    ["pnpm bindings:check", wrappedHeavyCommand("pnpm bindings:check")],
    [
      "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
      "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
    ],
  ]) {
    await t.test(command, async (subtest) => {
      const harness = await makeHarness(subtest, { commands: { [command]: { hold: true } } });
      await mkdir(join(harness.root, "src/utils"), { recursive: true });
      await writeFile(join(harness.root, "src/utils/annotation.ts"), "export const a = 1;\n");
      const commandsByChild = new WeakMap();
      let heldSupervisor;
      let heldGroupPid;
      let heldEvent;
      subtest.after(async () => {
        await heldSupervisor?.terminate();
      });
      const result = await runPushGates(["--rust", "--frontend", "--bindings"], {
        cwd: harness.root,
        env: harness.env,
        spawnProcess(executable, args, options) {
          const child = spawn(executable, args, options);
          commandsByChild.set(child, [executable, ...args].join(" "));
          return child;
        },
        superviseProcess(child, options) {
          const supervisor = superviseChild(child, options);
          if (commandsByChild.get(child) !== spawnedCommand) return supervisor;
          heldSupervisor = supervisor;
          heldGroupPid = child.pid;
          return {
            ...supervisor,
            done: waitForEvent(
              harness,
              (event) => event.type === "start" && event.command === command,
            ).then((event) => {
              heldEvent = event;
              throw new Error("injected unconfirmed process-group cleanup");
            }),
          };
        },
      });
      try {
        assert.equal(result.exitCode, 1);
        assert.ok(
          groupExists(heldGroupPid),
          "the unconfirmed supervised process group must still be alive during the assertion",
        );
        assert.ok(
          processExists(heldEvent.pid),
          "the unconfirmed child must still be alive during the assertion",
        );
        const commands = commandSet(await readEvents(harness));
        assert.ok(
          !commands.some((entry) => entry.includes("vitest related")),
          "related-tests started beside unconfirmed cleanup",
        );
        const failed = result.results.find(({ terminationError }) => terminationError);
        assert.match(failed.terminationError.message, /unconfirmed process-group cleanup/u);
      } finally {
        await heldSupervisor?.terminate();
      }
      assert.equal(groupExists(heldGroupPid), false);
      assert.equal(processExists(heldEvent.pid), false);
    });
  }
});

test("pre-review Windows compilation uses Rust allocation at both budget sizes", async (t) => {
  const maxFive = String(Math.min(availableParallelism(), 5));
  for (const [budgetBytes, expectedJobs] of [
    [10 * GIB, "1"],
    [41 * GIB, maxFive],
  ]) {
    const windows = "pnpm rust:windows:check";
    const harness = await makeHarness(t, { budgetBytes, commands: { [windows]: { delayMs: 50 } } });
    await mkdir(join(harness.root, "src/state"), { recursive: true });
    await writeFile(join(harness.root, "src/state/workspace.ts"), "export const workspace = 1;\n");
    harness.env.CARGO_BUILD_JOBS = "64";
    delete harness.env.GATE_CPU_SHARE;
    const result = await runPushGates(["--pre-review"], {
      cwd: harness.root,
      env: harness.env,
      discoverChangedPaths: () => ["src-tauri/src/lib.rs", "src/state/workspace.ts"],
    });
    assert.equal(result.exitCode, 0);
    const events = await readEvents(harness);
    assert.equal(cliCommandStart(events, windows).jobs, expectedJobs);
  }
});

test("known insufficient pre-review Rust memory refuses before Windows compiler spawn", async (t) => {
  const harness = await makeHarness(t, { budgetBytes: 9 * GIB - 1 });
  harness.env.CARGO_BUILD_JOBS = "64";
  const result = await runPushGates(["--pre-review"], {
    cwd: harness.root,
    env: harness.env,
    discoverChangedPaths: () => ["src-tauri/src/lib.rs"],
  });
  assert.equal(result.exitCode, 1);
  const windowsTask = result.results.find(({ name }) => name === "windows-clippy");
  assert.equal(windowsTask.status, "failed");
  assert.equal(windowsTask.code, 1);
  assert.match(
    await readFile(windowsTask.logPath, "utf8"),
    /Rust compilation refused:.*below the minimum.*9 GiB usable/u,
  );
  assert.ok(!commandSet(await readEvents(harness)).includes("pnpm rust:windows:check"));
});

test("advisory rust-target-eviction is selected by name and never gates later work (O6, CR-6)", async (t) => {
  const byName = Object.fromEntries(PUSH_GATE_SCHEDULE.p0.map((step) => [step.name, step]));
  assert.equal(byName["mutation-guard"].command, "pnpm mutation:guard:check");
  assert.equal(byName["setup-rust"].command, "bash scripts/setup-rust.sh");
  assert.equal(byName["rust-target-eviction"].command, "pnpm rust:target:evict");
  assert.equal(byName["rust-target-eviction"].advisory, true);
  assert.equal(PRE_REVIEW_GATE_SCHEDULE.p0, undefined);
  const preReviewCommands = [
    PRE_REVIEW_GATE_SCHEDULE.p1[0].command,
    ...PRE_REVIEW_GATE_SCHEDULE.lanes.flatMap((lane) => lane.commands),
  ].map((command) => (typeof command === "string" ? command : command.display));
  assert.ok(!preReviewCommands.some((command) => command.includes("rust:target:evict")));

  for (const flags of [["--rust"], ["--bindings"]]) {
    await t.test(`ordering with ${flags.join(" ")}`, async (subtest) => {
      const harness = await makeHarness(subtest);
      const result = await runCli(subtest, harness, flags);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const events = await readEvents(harness);
      const guard = cliCommandFinish(events, "pnpm mutation:guard:check");
      const eviction = cliCommandStart(events, "pnpm rust:target:evict");
      const evictionDone = cliCommandFinish(events, "pnpm rust:target:evict");
      const setup = cliCommandStart(events, "bash scripts/setup-rust.sh");
      assert.ok(at(guard) < at(eviction));
      assert.ok(at(evictionDone) < at(setup));
    });
  }

  await t.test("absent from contract-only and frontend-only runs", async (subtest) => {
    for (const flags of [[], ["--frontend"]]) {
      const harness = await makeHarness(subtest);
      const result = await runCli(subtest, harness, flags);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const commands = commandSet(await readEvents(harness));
      assert.ok(!commands.includes("pnpm rust:target:evict"));
      assert.ok(commands.includes("pnpm mutation:guard:check"));
    }
  });

  const laterCommands = [
    "bash scripts/setup-rust.sh",
    "pnpm build-vite",
    "pnpm gates:contract:check",
    "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
  ];

  await t.test("non-zero exit is a warning and later steps still run", async (subtest) => {
    const cwd = await temporarySchedulerRoot(subtest);
    const events = [];
    const originalStdoutWrite = process.stdout.write;
    let stdout = "";
    process.stdout.write = function (chunk) {
      stdout += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      return true;
    };
    let result;
    try {
      result = await runPushGates(["--rust"], {
        cwd,
        env: { ...process.env, GATE_MEMORY_BYTES: String(10 * GIB) },
        discoverChangedPaths: () => ["README.md"],
        spawnProcess: makeMockSpawner({
          events,
          exits: { "pnpm rust:target:evict": 1 },
          stdout: "eviction-probe-line\n",
        }),
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
    }
    assert.equal(result.exitCode, 0);
    const eviction = result.results.find((task) => task.name === "rust-target-eviction");
    assert.equal(eviction.status, "warning");
    assert.equal(eviction.code, 1);
    assert.ok(!stdout.includes("push gate failed: rust-target-eviction"));
    assert.match(stdout, /rust-target-eviction log tail/u);
    assert.match(stdout, /eviction-probe-line/u);
    const started = events.filter((event) => event.type === "start").map((event) => event.command);
    for (const command of laterCommands) {
      assert.ok(started.includes(command), `${command} must still run`);
    }
  });

  await t.test("spawn failure is a warning and later steps still run", async (subtest) => {
    const cwd = await temporarySchedulerRoot(subtest);
    const events = [];
    const spawnProcess = (executable, args, options) => {
      const command = [executable, ...args].join(" ");
      if (command === "pnpm rust:target:evict") {
        const error = new Error("injected ENOENT");
        error.code = "ENOENT";
        throw error;
      }
      return makeMockSpawner({ events })(executable, args, options);
    };
    const result = await runPushGates(["--rust"], {
      cwd,
      env: { ...process.env, GATE_MEMORY_BYTES: String(10 * GIB) },
      discoverChangedPaths: () => ["README.md"],
      spawnProcess,
    });
    assert.equal(result.exitCode, 0);
    const eviction = result.results.find((task) => task.name === "rust-target-eviction");
    assert.equal(eviction.status, "warning");
    assert.equal(eviction.code, 127);
    const started = events.filter((event) => event.type === "start").map((event) => event.command);
    for (const command of laterCommands) {
      assert.ok(started.includes(command), `${command} must still run`);
    }
  });

  await t.test("a crash is a warning and later steps still run", async (subtest) => {
    const cwd = await temporarySchedulerRoot(subtest);
    const events = [];
    const spawnProcess = (executable, args, options) => {
      const command = [executable, ...args].join(" ");
      if (command === "pnpm rust:target:evict") {
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = undefined;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => false;
        setImmediate(() => {
          const error = new Error("injected crash");
          child.emit("error", error);
          child.stdout.end();
          child.stderr.end();
          child.exitCode = 1;
          child.emit("close", 1, null);
        });
        return child;
      }
      return makeMockSpawner({ events })(executable, args, options);
    };
    const result = await runPushGates(["--rust"], {
      cwd,
      env: { ...process.env, GATE_MEMORY_BYTES: String(10 * GIB) },
      discoverChangedPaths: () => ["README.md"],
      spawnProcess,
    });
    assert.equal(result.exitCode, 0);
    const eviction = result.results.find((task) => task.name === "rust-target-eviction");
    assert.equal(eviction.status, "warning");
    const started = events.filter((event) => event.type === "start").map((event) => event.command);
    for (const command of laterCommands) {
      assert.ok(started.includes(command), `${command} must still run`);
    }
  });

  await t.test("interrupt during the step keeps the existing outcome", async (subtest) => {
    const harness = await makeHarness(subtest, {
      commands: { "pnpm rust:target:evict": { hold: true } },
    });
    const running = startCli(subtest, harness, ["--rust"]);
    await waitForEvent(
      harness,
      (event) => event.type === "start" && event.command === "pnpm rust:target:evict",
    );
    running.child.kill("SIGTERM");
    const result = await running.done;
    assert.equal(result.code, 143, `${result.stdout}\n${result.stderr}`);
    const commands = commandSet(await readEvents(harness));
    assert.deepEqual(commands, ["pnpm mutation:guard:check", "pnpm rust:target:evict"].sort());
    assert.ok(!commands.includes("bash scripts/setup-rust.sh"));
  });

  await t.test(
    "unconfirmed termination stays failed, latches cleanup, and refuses later starts",
    async (subtest) => {
      const harness = await makeHarness(subtest, {
        commands: { "pnpm rust:target:evict": { hold: true } },
      });
      const commandsByChild = new WeakMap();
      let heldSupervisor;
      let heldEvent;
      const result = await runPushGates(["--rust"], {
        cwd: harness.root,
        env: harness.env,
        spawnProcess(executable, args, options) {
          const child = spawn(executable, args, options);
          commandsByChild.set(child, [executable, ...args].join(" "));
          return child;
        },
        superviseProcess(child, options) {
          const supervisor = superviseChild(child, options);
          if (commandsByChild.get(child) !== "pnpm rust:target:evict") return supervisor;
          heldSupervisor = supervisor;
          return {
            ...supervisor,
            done: waitForEvent(
              harness,
              (event) => event.type === "start" && event.command === "pnpm rust:target:evict",
            ).then((event) => {
              heldEvent = event;
              throw new Error("injected unconfirmed process-group cleanup");
            }),
          };
        },
      });
      try {
        assert.equal(result.exitCode, 1);
        const eviction = result.results.find((task) => task.name === "rust-target-eviction");
        assert.equal(eviction.status, "failed");
        assert.match(eviction.terminationError.message, /unconfirmed process-group cleanup/u);
        const commands = commandSet(await readEvents(harness));
        assert.ok(!commands.includes("bash scripts/setup-rust.sh"));
        assert.ok(!commands.includes("pnpm gates:contract:check"));
        assert.ok(groupExists(heldEvent.pid));
      } finally {
        await heldSupervisor?.terminate();
      }
      assert.equal(groupExists(heldEvent.pid), false);
    },
  );
});

test("per-command heavy-gate placement wraps only Rust-compiling commands and never sizes in the runner", async (t) => {
  const sizingPrefix = [process.execPath, runnerPath, RUST_SIZING_MODE_FLAG, "--"];

  await t.test(
    "push mode wraps exact Rust-compiling set plus related Vitest and leaves every other command direct",
    async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      for (const path of ["src/utils/annotation.ts", "src-tauri/src/lexer.rs"]) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), "// fixture\n");
      }
      const events = [];
      const env = { ...process.env, GATE_MEMORY_BYTES: "not-a-number" };
      delete env.CARGO_BUILD_JOBS;
      const result = await runPushGates(["--rust", "--frontend", "--bindings"], {
        cwd,
        env,
        discoverChangedPaths: () => ["src/utils/annotation.ts", "src-tauri/src/lexer.rs"],
        spawnProcess: makeMockSpawner({ events }),
      });
      assert.equal(result.exitCode, 0);
      const starts = events.filter((event) => event.type === "start");
      const launcherStarts = starts.filter((event) => event.executable === GATE_LAUNCHER);
      const selfSizedStarts = launcherStarts.filter(
        (event) => !event.args.includes(RUST_SIZING_MODE_FLAG),
      );
      const wrappedStarts = launcherStarts.filter((event) => !selfSizedStarts.includes(event));
      const directStarts = starts.filter((event) => event.executable !== GATE_LAUNCHER);

      assert.deepEqual(
        selfSizedStarts.map((event) => event.command),
        [slotVitestRelated("src/utils/annotation.ts")],
      );
      for (const event of wrappedStarts) {
        assert.deepEqual(event.args.slice(0, sizingPrefix.length), sizingPrefix);
        assert.equal(
          event.env.CARGO_BUILD_JOBS,
          undefined,
          "runner must not compute CARGO_BUILD_JOBS in its own process",
        );
      }
      assert.deepEqual(
        wrappedStarts.map((event) => event.args.slice(sizingPrefix.length).join(" ")).sort(),
        [
          "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
          "cargo test --manifest-path src-tauri/Cargo.toml --locked --bins -- lexer::",
          "pnpm bindings:check",
          "pnpm rust:windows:check",
        ],
      );
      for (const event of directStarts) {
        assert.notEqual(event.executable, GATE_LAUNCHER);
        assert.ok(!event.args.includes(RUST_SIZING_MODE_FLAG));
      }
      assert.deepEqual(directStarts.map((event) => event.command).sort(), [
        "bash scripts/setup-rust.sh",
        "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
        "env -u KIT_ROOT pnpm findings:kit:check",
        "pnpm build-vite",
        "pnpm bundle:check",
        "pnpm gates:contract:check",
        "pnpm mutation:guard:check",
        "pnpm rust:target:evict",
      ]);
    },
  );

  await t.test(
    "pre-review mode wraps only windows-clippy and leaves all other commands direct",
    async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      for (const path of ["src/state/workspace.ts", "src-tauri/src/lib.rs"]) {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), "// fixture\n");
      }
      const events = [];
      const env = { ...process.env, GATE_MEMORY_BYTES: "not-a-number" };
      delete env.CARGO_BUILD_JOBS;
      const result = await runPushGates(["--pre-review"], {
        cwd,
        env,
        discoverChangedPaths: () => ["src/state/workspace.ts", "src-tauri/src/lib.rs"],
        spawnProcess: makeMockSpawner({ events }),
      });
      assert.equal(result.exitCode, 0);
      const starts = events.filter((event) => event.type === "start");
      const wrappedStarts = starts.filter((event) => event.executable === GATE_LAUNCHER);
      const directStarts = starts.filter((event) => event.executable !== GATE_LAUNCHER);

      assert.equal(wrappedStarts.length, 1);
      assert.deepEqual(wrappedStarts[0].args.slice(0, sizingPrefix.length), sizingPrefix);
      assert.deepEqual(wrappedStarts[0].args.slice(sizingPrefix.length), [
        "pnpm",
        "rust:windows:check",
      ]);
      assert.equal(wrappedStarts[0].env.CARGO_BUILD_JOBS, undefined);
      assert.deepEqual(directStarts.map((event) => event.command).sort(), [
        "cargo fmt --manifest-path src-tauri/Cargo.toml -- --check",
        "pnpm build-vite",
        "pnpm bundle:check",
        "pnpm coverage:mapping:backend",
        "pnpm coverage:mapping:frontend",
        "pnpm exec oxfmt --check src/state/workspace.ts",
        "pnpm exec oxlint --deny-warnings src/state/workspace.ts",
        "pnpm exec tsgo --noEmit",
      ]);
    },
  );
});

test("agent-gate exit 125 refusal and missing launcher fail the lane and latch with no fallback", async (t) => {
  await t.test(
    "exit 125 from agent-gate fails rust-lint and skips related-tests",
    async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      await mkdir(join(cwd, "src/utils"), { recursive: true });
      await writeFile(join(cwd, "src/utils/annotation.ts"), "export const a = 1;\n");
      const events = [];
      const clippy = wrappedHeavyCommand(
        "cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings",
      );
      const result = await runPushGates(["--rust", "--frontend"], {
        cwd,
        env: { ...process.env },
        discoverChangedPaths: () => ["src/utils/annotation.ts"],
        spawnProcess: makeMockSpawner({
          events,
          exits: { [clippy]: 125 },
          stdout: "agent-gate: REFUSED — lock failed\n",
        }),
      });
      assert.equal(result.exitCode, 125);
      const rustLint = result.results.find((task) => task.name === "rust-lint");
      assert.equal(rustLint.status, "failed");
      assert.equal(rustLint.code, 125);
      const related = result.results.find((task) => task.name === "related-tests");
      assert.equal(related.status, "skipped");
      assert.match(related.reason, /rust-lint failed/u);
      assert.equal(
        cliCommandStart(events, wrappedHeavyCommand("pnpm rust:windows:check")),
        undefined,
      );
      assert.equal(
        cliCommandStart(events, slotVitestRelated("src/utils/annotation.ts")),
        undefined,
      );
    },
  );

  await t.test(
    "missing agent-gate executable exits 127 and latches with no in-place fallback",
    async (subtest) => {
      const harness = await makeHarness(subtest, { omittedExecutables: [GATE_LAUNCHER] });
      const result = await runCli(subtest, harness, ["--bindings"]);
      assert.equal(result.code, 127, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /spawn agent-gate ENOENT/u);
      const started = commandSet(await readEvents(harness));
      assert.ok(!started.includes("pnpm bindings:check"));
      assert.ok(!started.includes("pnpm gates:contract:check"));
    },
  );
});

test("run-wide slot admission serialises concurrent slot-taking lanes while non-slot lanes keep running (PR-9)", async (t) => {
  await t.test(
    "two concurrent slot-taking lanes never overlap while a light lane overlaps freely",
    async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      const heavySchedule = {
        p0: [],
        p1: [],
        lanes: [
          {
            name: "heavy-a",
            always: true,
            commands: [heavyGateCommand("pnpm heavy-a")],
          },
          {
            name: "heavy-b",
            always: true,
            commands: [heavyGateCommand("pnpm heavy-b")],
          },
          {
            name: "light-c",
            always: true,
            commands: ["pnpm light-c"],
          },
        ],
      };
      const events = [];
      let activeHeavy = 0;
      let maxActiveHeavy = 0;
      let lightRanDuringHeavy = false;
      let signalFirstHeavyStarted;
      let releaseFirstHeavy;
      const firstHeavyStarted = new Promise((resolve) => {
        signalFirstHeavyStarted = resolve;
      });
      const firstHeavyHeld = new Promise((resolve) => {
        releaseFirstHeavy = resolve;
      });
      const heavyA = wrappedHeavyCommand("pnpm heavy-a");
      const heavyB = wrappedHeavyCommand("pnpm heavy-b");

      const spawnProcess = (executable, args) => {
        const command = [executable, ...args].join(" ");
        const isHeavy = executable === GATE_LAUNCHER;
        if (isHeavy) {
          activeHeavy += 1;
          maxActiveHeavy = Math.max(maxActiveHeavy, activeHeavy);
          if (command === heavyA) signalFirstHeavyStarted();
        }
        events.push({ type: "start", command });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.pid = undefined;
        child.exitCode = null;
        child.signalCode = null;
        child.kill = () => false;
        setImmediate(async () => {
          try {
            if (command === heavyA) await firstHeavyHeld;
            if (command === "pnpm light-c") {
              await firstHeavyStarted;
              if (activeHeavy === 1) lightRanDuringHeavy = true;
              releaseFirstHeavy();
            }
          } finally {
            if (isHeavy) activeHeavy -= 1;
            child.exitCode = 0;
            child.stdout.end();
            child.stderr.end();
            events.push({ type: "finish", command, code: 0 });
            child.emit("close", 0, null);
          }
        });
        return child;
      };

      try {
        const result = await runPushGates([], {
          cwd,
          env: { ...process.env },
          schedule: heavySchedule,
          spawnProcess,
        });
        assert.equal(result.exitCode, 0);
        assert.equal(maxActiveHeavy, 1, "at most one agent-gate child may be alive at once");
        assert.equal(
          lightRanDuringHeavy,
          true,
          "non-slot lanes must continue running concurrently",
        );
        assert.ok(cliCommandFinish(events, heavyA));
        assert.ok(cliCommandStart(events, heavyB));
        assert.ok(
          events.indexOf(cliCommandFinish(events, heavyA)) <
            events.indexOf(cliCommandStart(events, heavyB)),
          "second slot-taking command must not start until first has exited",
        );
      } finally {
        signalFirstHeavyStarted();
        releaseFirstHeavy();
      }
    },
  );

  await t.test(
    "a failed slot-taking lane prevents a peer waiting on the slot from spawning",
    async (subtest) => {
      const cwd = await temporarySchedulerRoot(subtest);
      const heavySchedule = {
        p0: [],
        p1: [],
        lanes: [
          {
            name: "heavy-a",
            always: true,
            commands: [heavyGateCommand("pnpm heavy-a")],
          },
          {
            name: "heavy-b",
            always: true,
            commands: [heavyGateCommand("pnpm heavy-b")],
          },
        ],
      };
      const events = [];
      const heavyA = wrappedHeavyCommand("pnpm heavy-a");
      const heavyB = wrappedHeavyCommand("pnpm heavy-b");
      const result = await runPushGates([], {
        cwd,
        env: { ...process.env },
        schedule: heavySchedule,
        spawnProcess: makeMockSpawner({
          events,
          exits: { [heavyA]: 125 },
        }),
      });
      assert.equal(result.exitCode, 125);
      assert.equal(cliCommandStart(events, heavyB), undefined);
      const peer = result.results.find((task) => task.name === "heavy-b");
      assert.equal(peer.status, "skipped");
      assert.match(peer.reason, /heavy-a failed/u);
    },
  );
});

test("in-scope Rust sizing mode propagates CARGO_BUILD_JOBS, fails closed, maps spawn errors and signals", async (t) => {
  await t.test(
    "computes CARGO_BUILD_JOBS inside the entry and passes it to the child without detached",
    async () => {
      for (const [budgetBytes, expectedJobs] of [
        [10 * GIB, "1"],
        [41 * GIB, "5"],
      ]) {
        let spawned;
        let stderr = "";
        const code = await runRustCommand(["--", "cargo", "clippy", "--locked"], {
          cwd: "/tmp",
          env: { CARGO_BUILD_JOBS: "64", RUST_TEST_THREADS: "3" },
          stderr: { write: (chunk) => (stderr += chunk) },
          availableParallelism: () => 24,
          getGateBudgetBytes: () => budgetBytes,
          spawnProcess(executable, args, options) {
            spawned = { executable, args, options };
            const child = new EventEmitter();
            child.exitCode = null;
            child.signalCode = null;
            setImmediate(() => {
              child.exitCode = 0;
              child.emit("close", 0, null);
            });
            return child;
          },
        });
        assert.equal(code, 0, stderr);
        assert.equal(stderr, "");
        assert.equal(spawned.executable, "cargo");
        assert.deepEqual(spawned.args, ["clippy", "--locked"]);
        assert.equal(spawned.options.env.CARGO_BUILD_JOBS, expectedJobs);
        assert.equal(spawned.options.env.RUST_TEST_THREADS, "3");
        assert.equal(spawned.options.detached, false);
        assert.equal(spawned.options.stdio, "inherit");
      }
    },
  );

  await t.test(
    "refuses budgets below 9 GiB usable and invalid sizing env vars before spawning",
    async () => {
      const cases = [
        {
          label: "budget below 9 GiB usable",
          env: {},
          getGateBudgetBytes: () => 9 * GIB - 1,
          expected: /Rust compilation refused:.*below the minimum.*9 GiB usable/u,
        },
        {
          label: "invalid CARGO_BUILD_JOBS",
          env: { CARGO_BUILD_JOBS: "0" },
          getGateBudgetBytes: () => 10 * GIB,
          expected: /CARGO_BUILD_JOBS/u,
        },
        {
          label: "invalid GATE_MEMORY_BYTES",
          env: { GATE_MEMORY_BYTES: "not-bytes" },
          getGateBudgetBytes: undefined,
          expected: /GATE_MEMORY_BYTES/u,
        },
        {
          label: "invalid GATE_CPU_SHARE",
          env: { GATE_CPU_SHARE: "0" },
          getGateBudgetBytes: () => 10 * GIB,
          expected: /GATE_CPU_SHARE/u,
        },
      ];
      for (const { label, env, getGateBudgetBytes, expected } of cases) {
        let spawned = false;
        let stderr = "";
        const code = await runRustCommand(["--", "cargo", "test"], {
          env,
          stderr: { write: (chunk) => (stderr += chunk) },
          availableParallelism: () => 24,
          ...(getGateBudgetBytes ? { getGateBudgetBytes } : {}),
          spawnProcess() {
            spawned = true;
            throw new Error("must not spawn");
          },
        });
        assert.equal(code, 1, label);
        assert.equal(spawned, false, label);
        assert.match(stderr, expected, label);
        assert.equal(stderr.trimEnd().split("\n").length, 1, `${label} must be one-line stderr`);
      }
    },
  );

  await t.test("rejects missing or malformed command arguments before spawning", async () => {
    for (const badArgs of [[], ["cargo"], ["--"], ["--", ""], ["extra", "--", "cargo"]]) {
      let spawned = false;
      let stderr = "";
      const code = await runRustCommand(badArgs, {
        env: {},
        stderr: { write: (chunk) => (stderr += chunk) },
        getGateBudgetBytes: () => 10 * GIB,
        spawnProcess() {
          spawned = true;
          throw new Error("must not spawn");
        },
      });
      assert.equal(code, 2, JSON.stringify(badArgs));
      assert.equal(spawned, false, JSON.stringify(badArgs));
      assert.match(stderr, /Usage:.*--run-rust-command/u);
      assert.equal(stderr.trimEnd().split("\n").length, 1);
    }
  });

  await t.test("maps spawn failure to exit 127 with a diagnostic naming the command", async () => {
    let stderr = "";
    const code = await runRustCommand(["--", "nonexistent-rust-tool-xyz"], {
      env: {},
      stderr: { write: (chunk) => (stderr += chunk) },
      getGateBudgetBytes: () => 10 * GIB,
      availableParallelism: () => 24,
    });
    assert.equal(code, 127);
    assert.match(stderr, /spawn nonexistent-rust-tool-xyz failed:.*ENOENT/u);
  });

  await t.test(
    "maps signal-terminated child (OOM SIGKILL) to 128 + signum and logs the signal",
    async () => {
      const result = spawnSync(
        process.execPath,
        [
          runnerPath,
          RUST_SIZING_MODE_FLAG,
          "--",
          process.execPath,
          "-e",
          "process.kill(process.pid, 'SIGKILL')",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, GATE_MEMORY_BYTES: String(10 * GIB) },
        },
      );
      assert.equal(result.status, 137, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /terminated by signal SIGKILL \(exit 137\)/u);
    },
  );

  await t.test(
    "forwards SIGINT, SIGTERM and SIGHUP to the child and exits only after child exit",
    async () => {
      for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        const signalTarget = new EventEmitter();
        const forwarded = [];
        let childClosed = false;
        const code = await runRustCommand(["--", "cargo", "clippy"], {
          env: {},
          stderr: { write() {} },
          getGateBudgetBytes: () => 10 * GIB,
          availableParallelism: () => 24,
          signalTarget,
          spawnProcess() {
            const child = new EventEmitter();
            child.exitCode = null;
            child.signalCode = null;
            child.kill = (received) => {
              forwarded.push(received);
              setTimeout(() => {
                childClosed = true;
                child.signalCode = received;
                child.emit("close", null, received);
              }, 20);
              return true;
            };
            setImmediate(() => signalTarget.emit(signal, signal));
            return child;
          },
        });
        assert.equal(childClosed, true, `${signal} must wait for child exit`);
        assert.deepEqual(forwarded, [signal]);
        assert.ok(code > 128, `${signal} must map to 128 + signum`);
        assert.equal(signalTarget.listenerCount(signal), 0, "signal listener must be uninstalled");
      }
    },
  );
});
