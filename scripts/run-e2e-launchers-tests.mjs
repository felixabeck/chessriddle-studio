import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DOCKER_REMOVE_TIMEOUT_MS,
  DOCKER_COMMAND_TERMINATION_TIMEOUT_MS,
  DOCKER_INFO_TIMEOUT_MS,
  E2E_CONTAINER_MEMORY,
  E2E_CONTAINER_MEMORY_BYTES,
  playwrightArguments,
} from "./run-e2e-container.mjs";
import { E2E_LANE_TERMINATION_TIMEOUT_MS } from "./child-supervisor.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scripts, "..");
const launcherPath = join(scripts, "run-e2e-container.mjs");
const directoryTrash = "--grep=localizes directory-trash";
const EVENT_WAIT_TIMEOUT_MS = 5_000;

const FAKE_DOCKER = String.raw`#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const action = args[0];
const record = (entry) => appendFileSync(
  process.env.FAKE_DOCKER_RECORD,
  JSON.stringify({ ...entry, pid: process.pid }) + "\n",
);
record({ action, args });

if (action === "info") {
  if (process.env.FAKE_DOCKER_INFO_MODE === "hold") {
    const finish = () => process.exit(143);
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
    setInterval(() => {}, 1000);
  } else if (process.env.FAKE_DOCKER_INFO_EXIT) {
    process.stderr.write(process.env.FAKE_DOCKER_INFO_ERROR ?? "injected info failure\n");
    process.exit(Number(process.env.FAKE_DOCKER_INFO_EXIT));
  }
  process.stdout.write((process.env.FAKE_DOCKER_MEMORY_SUPPORT ?? "true") + "\n");
} else if (action === "run") {
  const mode = process.env.FAKE_DOCKER_RUN_MODE ?? "success";
  if (mode === "hold") {
    const finish = () => process.exit(143);
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
    setInterval(() => {}, 1000);
  } else if (mode === "delayed-term") {
    const finish = () => {
      setTimeout(() => {
        record({ action: "run-settled" });
        process.exit(143);
      }, 300);
    };
    process.on("SIGTERM", finish);
    process.on("SIGINT", finish);
    setInterval(() => {}, 1000);
  } else if (mode === "fail") {
    process.stderr.write("injected runner failure\n");
    process.exit(Number(process.env.FAKE_DOCKER_RUN_EXIT ?? 17));
  }
} else if (action === "rm") {
  if (process.env.FAKE_DOCKER_RM_MODE === "fail") {
    process.stderr.write("injected cleanup refusal\n");
    process.exit(23);
  } else if (process.env.FAKE_DOCKER_RM_MODE === "hold") {
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1000);
  }
}
`;

async function makeHarness(t, overrides = {}) {
  const root = await mkdtemp(join("/tmp", "e2e-launcher-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const docker = join(bin, "docker");
  const record = join(root, "docker.jsonl");
  await writeFile(docker, FAKE_DOCKER);
  await chmod(docker, 0o755);
  await writeFile(record, "");
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    record,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      FAKE_DOCKER_RECORD: record,
      ...overrides,
    },
  };
}

function startNode(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function readEvents(harness) {
  const contents = await readFile(harness.record, "utf8");
  return contents
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForEvent(harness, predicate) {
  const deadline = Date.now() + EVENT_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const event = (await readEvents(harness)).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for fake Docker event after ${EVENT_WAIT_TIMEOUT_MS} ms`);
}

function pnpm(args, env = process.env) {
  return spawnSync("pnpm", ["--silent", ...args], { cwd: projectRoot, encoding: "utf8", env });
}

function killFailureSource(diagnostic, body) {
  return [
    "const fakePid = 987654321;",
    "const originalKill = process.kill;",
    "process.kill = function(pid, signal) {",
    "  if (pid === -fakePid && signal !== 0) {",
    `    const error = Object.assign(new Error(${JSON.stringify(diagnostic)}), { code: "EPERM" });`,
    "    throw error;",
    "  }",
    "  return Reflect.apply(originalKill, process, [pid, signal]);",
    "};",
    "try {",
    ...body,
    "} finally { process.kill = originalKill; }",
  ];
}

async function cleanupHeldDocker(running, dockerPidFile) {
  let dockerPid;
  try {
    dockerPid = Number(await readFile(dockerPidFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (Number.isInteger(dockerPid) && dockerPid > 0) {
    for (const pid of [-dockerPid, dockerPid]) {
      try {
        process.kill(pid, "SIGKILL");
        break;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  if (running.child.exitCode === null && running.child.signalCode === null) {
    running.child.kill("SIGKILL");
  }
  await running.done;
}

// pnpm retains a caller's `--` (measured 2026-09-27, pnpm 10.34.5); these are the argv tails
// the package scripts actually receive, not hypothetical inputs (`f-20260910-07`).
test("the separator pnpm retains is dropped so selection reaches Playwright as options", () => {
  assert.deepEqual(
    playwrightArguments(["--update-snapshots", "--", "--project=async-errors", "--grep=trash"]),
    ["--update-snapshots", "--project=async-errors", "--grep=trash"],
  );
  assert.deepEqual(playwrightArguments(["--", "--project=async-errors"]), [
    "--project=async-errors",
  ]);
});

test("a separator-free invocation is forwarded unchanged", () => {
  const forwarded = ["--update-snapshots", "--project=async-errors", "--grep=trash"];
  assert.deepEqual(playwrightArguments(forwarded), forwarded);
  assert.deepEqual(playwrightArguments([]), []);
});

test("only the first separator is pnpm's; a later one is the caller's own", () => {
  assert.deepEqual(playwrightArguments(["--", "--project=a", "--", "spec.ts"]), [
    "--project=a",
    "--",
    "spec.ts",
  ]);
});

test("a supported Docker launch uses the recorded limit, a unique name, and every existing flag", async (t) => {
  assert.equal(E2E_CONTAINER_MEMORY, "4g");
  assert.equal(E2E_CONTAINER_MEMORY_BYTES, 4 * 1024 ** 3);
  const harness = await makeHarness(t);
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath, "--project=async-errors"], {
      cwd: projectRoot,
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const events = await readEvents(harness);
  assert.deepEqual(
    events.map(({ action }) => action),
    ["info", "run"],
  );
  assert.deepEqual(events[0].args, ["info", "--format", "{{.MemoryLimit}}"]);
  const argv = events[1].args;
  assert.ok(argv.includes("--rm"));
  assert.equal(argv[argv.indexOf("--memory") + 1], "4g");
  assert.equal(argv[argv.indexOf("--memory") + 1], E2E_CONTAINER_MEMORY);
  const name = argv[argv.indexOf("--name") + 1];
  assert.match(name, /^chessfable-e2e-\d+-[0-9a-f-]{36}$/u);
  assert.equal(argv[argv.indexOf("--init")], "--init");
  assert.ok(argv.includes("--ipc=host"));
  assert.ok(argv.includes("--user"));
  assert.ok(argv.includes("--volume"));
  assert.ok(argv.includes("--workdir"));
  assert.ok(argv.includes("HOME=/tmp"));
  assert.ok(argv.includes("CI=1"));
  assert.deepEqual(argv.slice(argv.indexOf("test")), ["test", "--project=async-errors"]);
});

test("container names differ across launches from the same process", async (t) => {
  const harness = await makeHarness(t);
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    "const first = await runE2eContainer([]);",
    "const second = await runE2eContainer([]);",
    "process.exitCode = first.exitCode || second.exitCode;",
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  const runs = (await readEvents(harness)).filter((event) => event.action === "run");
  assert.equal(runs.length, 2);
  const names = runs.map((event) => event.args[event.args.indexOf("--name") + 1]);
  assert.notEqual(names[0], names[1]);
});

test("the package snapshot command forwards its selection after Docker memory preflight", async (t) => {
  const harness = await makeHarness(t);
  const run = pnpm(
    ["test:e2e:update", "--", "--project=async-errors", directoryTrash],
    harness.env,
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const events = await readEvents(harness);
  assert.equal(events[0].action, "info");
  assert.equal(events[1].action, "run");
  const argv = events[1].args;
  assert.equal(argv[argv.indexOf("--memory") + 1], E2E_CONTAINER_MEMORY);
  assert.deepEqual(argv.slice(argv.indexOf("test")), [
    "test",
    "--update-snapshots",
    "--project=async-errors",
    directoryTrash,
  ]);
});

test("Docker without memory-limit support is refused before any container is started", async (t) => {
  const harness = await makeHarness(t, { FAKE_DOCKER_MEMORY_SUPPORT: "false" });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath], {
      cwd: projectRoot,
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /does not support memory-limited containers/u);
  assert.deepEqual(
    (await readEvents(harness)).map(({ action }) => action),
    ["info"],
  );
});

test("invalid Docker info timeout values are refused before Docker is started", async (t) => {
  for (const timeout of ["-1", "abc"]) {
    await t.test(`E2E_TEST_DOCKER_INFO_TIMEOUT_MS=${timeout}`, async (subtest) => {
      const harness = await makeHarness(subtest, {
        E2E_TEST_DOCKER_INFO_TIMEOUT_MS: timeout,
      });
      const result = await startNode([launcherPath], harness.env).done;
      assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(
        result.stderr,
        /E2E_TEST_DOCKER_INFO_TIMEOUT_MS must be a finite non-negative number\./u,
      );
      assert.deepEqual(await readEvents(harness), []);
    });
  }
});

test("docker info preflight has a bounded timeout that refuses with its cause", async (t) => {
  assert.equal(DOCKER_INFO_TIMEOUT_MS, 10_000);
  // In the contract lane, 50 ms expires before the Node fake docker records info when this file runs concurrently; the production timeout stays 10 seconds.
  const harness = await makeHarness(t, { FAKE_DOCKER_INFO_MODE: "hold" });
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    "const result = await runE2eContainer([], { preflightTimeoutMs: 2000 });",
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Docker probe error: docker info preflight timed out after 2000 ms/u);
  assert.deepEqual(
    (await readEvents(harness)).map(({ action }) => action),
    ["info"],
  );
});

test("the entrypoint exits after a Docker kill failure and releases child pipes", async (t) => {
  const harness = await makeHarness(t);
  const dockerPidFile = join(harness.root, "docker.pid");
  const preloadPath = join(harness.root, "reject-docker-kill.mjs");
  const dockerPath = join(harness.root, "bin", "docker");
  await writeFile(
    dockerPath,
    String.raw`#!/bin/sh
if [ "$1" = info ]; then
  printf '%s\n' "$$" > "$FAKE_DOCKER_PID_FILE"
  exec sleep 300
fi
exit 0
`,
  );
  await chmod(dockerPath, 0o755);
  await writeFile(
    preloadPath,
    String.raw`import { readFileSync } from "node:fs";

const originalKill = process.kill;
process.kill = function (pid, signal) {
  let dockerPid;
  try {
    dockerPid = Number(readFileSync(process.env.FAKE_DOCKER_PID_FILE, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (dockerPid > 0 && (pid === dockerPid || pid === -dockerPid) && signal !== 0) {
    throw Object.assign(new Error("injected fake Docker EPERM"), { code: "EPERM" });
  }
  return Reflect.apply(originalKill, process, [pid, signal]);
};
`,
  );

  const running = startNode(["--import", preloadPath, launcherPath], {
    ...harness.env,
    E2E_TEST_DOCKER_INFO_TIMEOUT_MS: "50",
    FAKE_DOCKER_PID_FILE: dockerPidFile,
  });
  let timeout;
  try {
    const result = await Promise.race([
      running.done,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(undefined), 3_000);
      }),
    ]);
    assert.ok(result, "launcher did not exit within three seconds");
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /Docker probe error: docker info preflight timed out after 50 ms and could not be terminated: injected fake Docker EPERM/u,
    );
  } finally {
    clearTimeout(timeout);
    await cleanupHeldDocker(running, dockerPidFile);
  }
});

test("SIGTERM cancels a hung docker info preflight without starting the container", async (t) => {
  const harness = await makeHarness(t, { FAKE_DOCKER_INFO_MODE: "hold" });
  const running = startNode([launcherPath], harness.env);
  await waitForEvent(harness, (event) => event.action === "info");
  running.child.kill("SIGTERM");
  const result = await running.done;
  assert.equal(result.code, 143, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(
    (await readEvents(harness)).map(({ action }) => action),
    ["info"],
  );
});

test("preflight cancellation reports a rejected child termination and its cause", async (t) => {
  const harness = await makeHarness(t);
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { EventEmitter } from "node:events";`,
    `import { PassThrough } from "node:stream";`,
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    "const controller = new AbortController();",
    "controller.abort();",
    "const done = new Promise(() => {});",
    'const terminationError = new Error("injected termination failure");',
    'const outcome = Promise.resolve({ type: "termination-failed", error: terminationError });',
    "const result = await runE2eContainer([], {",
    "  abortSignal: controller.signal,",
    "  preflightTimeoutMs: 50,",
    "  spawnProcess: () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }),",
    "  superviseProcess: () => ({ done, exitOrTerminationFailure: () => outcome, terminate: () => Promise.reject(terminationError), unref() {} }),",
    "});",
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Failed to stop docker info preflight after cancellation/u);
  assert.match(result.stderr, /injected termination failure/u);
});

test("preflight cancellation bounds a child that never settles", async (t) => {
  const harness = await makeHarness(t);
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { EventEmitter } from "node:events";`,
    `import { PassThrough } from "node:stream";`,
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    "const controller = new AbortController();",
    "controller.abort();",
    "const started = Date.now();",
    "const done = new Promise(() => {});",
    "const outcome = new Promise(() => {});",
    "const result = await runE2eContainer([], {",
    "  abortSignal: controller.signal,",
    "  preflightTimeoutMs: 50,",
    "  spawnProcess: () => Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() }),",
    "  superviseProcess: () => ({ done, exitOrTerminationFailure: () => outcome, terminate: () => new Promise(() => {}), unref() {} }),",
    "});",
    "console.log(`elapsed=${Date.now() - started}`);",
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /Docker info preflight cancellation timed out after 50 ms/u);
  const elapsed = Number(result.stdout.match(/elapsed=(\d+)/u)?.[1]);
  assert.ok(Number.isFinite(elapsed) && elapsed < 1_000, result.stdout);
});

test("unavailable Docker prints the native-run guidance and starts no container", async (t) => {
  await t.test("probe spawn error", async (subtest) => {
    const harness = await makeHarness(subtest);
    const env = { ...harness.env, PATH: join(harness.root, "missing-bin") };
    const result = await startNode([launcherPath], env).done;
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /docker is required for the containerized e2e run/u);
    assert.match(
      result.stderr,
      /native `pnpm test:e2e` compares against snapshots recorded in the container/u,
    );
    assert.match(
      result.stderr,
      /font rasterization alone on most machines.*Install docker, or run\s+the suite in CI/u,
    );
    assert.match(result.stderr, /Docker probe error:.*ENOENT/u);
    assert.deepEqual(await readEvents(harness), []);
  });

  await t.test("probe non-zero exit", async (subtest) => {
    const harness = await makeHarness(subtest, {
      FAKE_DOCKER_INFO_EXIT: "42",
      FAKE_DOCKER_INFO_ERROR: "injected daemon refusal\n",
    });
    const result = await startNode([launcherPath], harness.env).done;
    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /docker is required for the containerized e2e run/u);
    assert.match(result.stderr, /Docker probe error: docker exited 42: injected daemon refusal/u);
    assert.deepEqual(
      (await readEvents(harness)).map(({ action }) => action),
      ["info"],
    );
  });
});

test("a failed runner removes exactly its named container", async (t) => {
  const harness = await makeHarness(t, { FAKE_DOCKER_RUN_MODE: "fail" });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath], {
      cwd: projectRoot,
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 17, `${result.stdout}\n${result.stderr}`);
  const events = await readEvents(harness);
  assert.deepEqual(
    events.map(({ action }) => action),
    ["info", "run", "rm"],
  );
  const name = events[1].args[events[1].args.indexOf("--name") + 1];
  assert.deepEqual(events[2].args, ["rm", "-f", name]);
});

test("SIGINT and SIGTERM stop and remove the active container before the launcher exits", async (t) => {
  for (const [signal, expectedCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    await t.test(signal, async (subtest) => {
      const harness = await makeHarness(subtest, { FAKE_DOCKER_RUN_MODE: "hold" });
      const running = startNode([launcherPath], harness.env);
      const runner = await waitForEvent(harness, (event) => event.action === "run");
      running.child.kill(signal);
      const result = await running.done;
      assert.equal(result.code, expectedCode, `${result.stdout}\n${result.stderr}`);
      const events = await readEvents(harness);
      assert.deepEqual(
        events.map(({ action }) => action),
        ["info", "run", "rm"],
      );
      const name = events[1].args[events[1].args.indexOf("--name") + 1];
      assert.deepEqual(events[2].args, ["rm", "-f", name]);
      assert.ok(runner.pid > 0);
    });
  }
});

test("container cleanup starts before the detached docker run client settles on cancellation", async (t) => {
  const harness = await makeHarness(t, { FAKE_DOCKER_RUN_MODE: "delayed-term" });
  const running = startNode([launcherPath], harness.env);
  const runner = await waitForEvent(harness, (event) => event.action === "run");
  running.child.kill("SIGTERM");
  const result = await running.done;
  assert.equal(result.code, 143, `${result.stdout}\n${result.stderr}`);
  const events = await readEvents(harness);
  const removeIndex = events.findIndex((event) => event.action === "rm");
  const settledIndex = events.findIndex((event) => event.action === "run-settled");
  assert.ok(removeIndex >= 0);
  assert.ok(settledIndex >= 0);
  assert.ok(removeIndex < settledIndex, JSON.stringify(events));
  const name = runner.args[runner.args.indexOf("--name") + 1];
  assert.deepEqual(events[removeIndex].args, ["rm", "-f", name]);
});

test("cancellation cleanup failure reports the named container and dirty retry status", async (t) => {
  const harness = await makeHarness(t, {
    FAKE_DOCKER_RUN_MODE: "delayed-term",
    FAKE_DOCKER_RM_MODE: "fail",
  });
  const running = startNode([launcherPath], harness.env);
  const runner = await waitForEvent(harness, (event) => event.action === "run");
  const containerName = runner.args[runner.args.indexOf("--name") + 1];
  running.child.kill("SIGTERM");
  const result = await running.done;
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    new RegExp(`Failed to stop and remove e2e container ${containerName}`),
  );
  assert.match(result.stderr, /injected cleanup refusal/u);
  assert.match(result.stderr, /retry is not known to be clean/u);
});

test("cancellation reports cleanup and Docker client termination failures", async (t) => {
  const harness = await makeHarness(t, {
    FAKE_DOCKER_RUN_MODE: "delayed-term",
    FAKE_DOCKER_RM_MODE: "fail",
  });
  const moduleUrl = pathToFileURL(launcherPath).href;
  const supervisorUrl = pathToFileURL(join(scripts, "child-supervisor.mjs")).href;
  const source = [
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    `import { superviseChild } from ${JSON.stringify(supervisorUrl)};`,
    "const result = await runE2eContainer([], {",
    "  superviseProcess(child, options) {",
    "    const supervisor = superviseChild(child, options);",
    '    if (child.spawnargs?.[1] !== "run") return supervisor;',
    "    return {",
    "      ...supervisor,",
    "      terminate() {",
    "        supervisor.terminate().catch(() => {});",
    '        return Promise.reject(new Error("injected Docker client termination failure"));',
    "      },",
    "    };",
    "  },",
    "});",
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const running = startNode(["--input-type=module", "-e", source], harness.env);
  const runner = await waitForEvent(harness, (event) => event.action === "run");
  const containerName = runner.args[runner.args.indexOf("--name") + 1];
  running.child.kill("SIGTERM");
  const result = await running.done;

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    new RegExp(
      `Failed to stop and remove e2e container ${containerName}.*injected cleanup refusal`,
      "u",
    ),
  );
  assert.match(result.stderr, /retry is not known to be clean/u);
  assert.match(result.stderr, /Failed to terminate e2e Docker client:/u);
  assert.match(result.stderr, /injected Docker client termination failure/u);
});

test("a Docker client kill failure still waits for named container cleanup", async (t) => {
  const harness = await makeHarness(t);
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { EventEmitter } from "node:events";`,
    `import { PassThrough } from "node:stream";`,
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    ...killFailureSource("injected docker client EPERM", [
      "const controller = new AbortController();",
      "const spawnProcess = (_command, args) => {",
      "  const action = args[0];",
      "  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });",
      '  child.pid = action === "run" ? fakePid : undefined;',
      "  child.exitCode = null;",
      "  child.signalCode = null;",
      '  if (action === "info") setImmediate(() => { child.stdout.write("true\\n"); child.stdout.end(); child.stderr.end(); child.exitCode = 0; child.emit("close", 0, null); });',
      '  if (action === "rm") setImmediate(() => { child.stderr.write("injected cleanup refusal\\n"); child.stdout.end(); child.stderr.end(); child.exitCode = 23; child.emit("close", 23, null); });',
      "  return child;",
      "};",
      "setTimeout(() => controller.abort(), 40);",
      "const started = Date.now();",
      "const result = await runE2eContainer([], { abortSignal: controller.signal, spawnProcess, preflightTimeoutMs: 500, removeTimeoutMs: 500 });",
      "console.log(`elapsed=${Date.now() - started}`);",
      "process.exitCode = result.exitCode;",
    ]),
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /Failed to stop and remove e2e container chessfable-e2e-.*docker exited 23: injected cleanup refusal/u,
  );
  assert.match(
    result.stderr,
    /Failed to terminate e2e Docker client:.*injected docker client EPERM/u,
  );
  const elapsed = Number(result.stdout.match(/elapsed=(\d+)/u)?.[1]);
  assert.ok(
    Number.isFinite(elapsed) && elapsed < E2E_LANE_TERMINATION_TIMEOUT_MS,
    `launcher elapsed ${elapsed} ms`,
  );
});

test("docker info timeout reports when a hung client cannot be terminated", async (t) => {
  const harness = await makeHarness(t);
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { EventEmitter } from "node:events";`,
    `import { PassThrough } from "node:stream";`,
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    ...killFailureSource("injected docker info EPERM", [
      "const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: fakePid, exitCode: null, signalCode: null });",
      "const started = Date.now();",
      "const result = await runE2eContainer([], { preflightTimeoutMs: 40, spawnProcess: () => child });",
      "console.log(`elapsed=${Date.now() - started}`);",
      "process.exitCode = result.exitCode;",
    ]),
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /Docker probe error: docker info preflight timed out after 40 ms and could not be terminated: injected docker info EPERM/u,
  );
  const elapsed = Number(result.stdout.match(/elapsed=(\d+)/u)?.[1]);
  assert.ok(Number.isFinite(elapsed) && elapsed < 1_000, `launcher elapsed ${elapsed} ms`);
});

test("docker rm timeout reports when a hung cleanup client cannot be terminated", async (t) => {
  const harness = await makeHarness(t);
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { EventEmitter } from "node:events";`,
    `import { PassThrough } from "node:stream";`,
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    ...killFailureSource("injected docker rm EPERM", [
      "const spawnProcess = (_command, args) => {",
      "  const action = args[0];",
      '  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: action === "rm" ? fakePid : undefined, exitCode: null, signalCode: null });',
      '  if (action !== "rm") setImmediate(() => { if (action === "info") child.stdout.write("true\\n"); else child.stderr.write("injected runner failure\\n"); child.stdout.end(); child.stderr.end(); child.exitCode = action === "info" ? 0 : 17; child.emit("close", child.exitCode, null); });',
      "  return child;",
      "};",
      "const started = Date.now();",
      "const result = await runE2eContainer([], { preflightTimeoutMs: 500, removeTimeoutMs: 40, spawnProcess });",
      "console.log(`elapsed=${Date.now() - started}`);",
      "process.exitCode = result.exitCode;",
    ]),
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;

  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /Failed to stop and remove e2e container chessfable-e2e-.*docker rm cleanup for e2e container .* timed out after 40 ms and could not be terminated: injected docker rm EPERM/u,
  );
  const elapsed = Number(result.stdout.match(/elapsed=(\d+)/u)?.[1]);
  assert.ok(Number.isFinite(elapsed) && elapsed < 1_000, `launcher elapsed ${elapsed} ms`);
});

test("an abort signal stops and removes the active container", async (t) => {
  const harness = await makeHarness(t, { FAKE_DOCKER_RUN_MODE: "hold" });
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { readFileSync } from "node:fs";`,
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    "const controller = new AbortController();",
    // A fixed delay lost to the fake docker's start under gate load and aborted before `run` was recorded.
    "const abortOnceRunning = setInterval(() => {",
    `  if (!readFileSync(process.env.FAKE_DOCKER_RECORD, "utf8").includes('"action":"run"')) return;`,
    "  clearInterval(abortOnceRunning);",
    "  controller.abort();",
    "}, 10);",
    "const result = await runE2eContainer([], { abortSignal: controller.signal });",
    "clearInterval(abortOnceRunning);",
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const running = startNode(["--input-type=module", "-e", source], harness.env);
  const result = await running.done;
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  const events = await readEvents(harness);
  assert.deepEqual(
    events.map(({ action }) => action),
    ["info", "run", "rm"],
  );
  const name = events[1].args[events[1].args.indexOf("--name") + 1];
  assert.deepEqual(events[2].args, ["rm", "-f", name]);
});

test("cleanup failure names the container and says a retry is not known to be clean", async (t) => {
  const harness = await makeHarness(t, {
    FAKE_DOCKER_RUN_MODE: "fail",
    FAKE_DOCKER_RM_MODE: "fail",
  });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcherPath], {
      cwd: projectRoot,
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Failed to stop and remove e2e container chessfable-e2e-/u);
  assert.match(result.stderr, /injected cleanup refusal/u);
  assert.match(result.stderr, /retry is not known to be clean/u);
});

test("a hung docker rm reports the named cleanup failure before the e2e lane window", async (t) => {
  assert.ok(
    DOCKER_REMOVE_TIMEOUT_MS + DOCKER_COMMAND_TERMINATION_TIMEOUT_MS <
      E2E_LANE_TERMINATION_TIMEOUT_MS,
  );
  const harness = await makeHarness(t, {
    FAKE_DOCKER_RUN_MODE: "fail",
    FAKE_DOCKER_RM_MODE: "hold",
  });
  const moduleUrl = pathToFileURL(launcherPath).href;
  const source = [
    `import { runE2eContainer } from ${JSON.stringify(moduleUrl)};`,
    "const started = Date.now();",
    "const result = await runE2eContainer([], { removeTimeoutMs: 40, dockerTerminationTimeoutMs: 40 });",
    "console.log(`elapsed=${Date.now() - started}`);",
    "process.exitCode = result.exitCode;",
  ].join("\n");
  const result = await startNode(["--input-type=module", "-e", source], harness.env).done;
  assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(
    result.stderr,
    /Failed to stop and remove e2e container chessfable-e2e-.*docker rm cleanup .* timed out after 40 ms/u,
  );
  assert.match(result.stderr, /retry is not known to be clean/u);
  const elapsed = Number(result.stdout.match(/elapsed=(\d+)/u)?.[1]);
  assert.ok(
    Number.isFinite(elapsed) && elapsed < E2E_LANE_TERMINATION_TIMEOUT_MS,
    `launcher elapsed ${elapsed} ms`,
  );
});

test("the native e2e command still selects only the named test through pnpm's separator", () => {
  // `--list` sits before the separator, so a regression lists the whole suite instead of
  // running it.
  const run = pnpm(["test:e2e", "--list", "--", "--project=async-errors", directoryTrash]);
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /\[async-errors\] › async-errors\.spec\.ts:\d+:\d+ › async-errors: localizes directory-trash/u,
  );
  assert.match(run.stdout, /Total: 1 test in 1 file/u);
});
