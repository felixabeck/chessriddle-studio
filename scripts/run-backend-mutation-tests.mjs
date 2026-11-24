import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findExecutableOnPath } from "./executable-path.mjs";
import { durableWrite } from "./durable-write.mjs";
import {
  isAlive,
  runMutationRunner,
  startMutationRunner,
  waitFor,
  waitUntil,
  writeShim,
} from "./mutation-runner-test-harness.mjs";
import {
  encodingCargoArguments,
  fencePath,
  mutationCacheRelativePath,
  selectBackendMutationPackages,
} from "./run-backend-mutation.mjs";
import { parseRustHostMetadata } from "./rust-host.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(projectRoot, "scripts", "run-backend-mutation.mjs");
const fence = "mutants.out/backend/.mutation-in-progress";
const marker = "/* ~ changed by cargo-mutants ~ */";
const temporaryRoots = new Map();

async function temporaryRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.set(root, prefix);
  return root;
}

async function grantOwnerAccessForRemoval(path) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) return;
  await chmod(path, 0o700);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await grantOwnerAccessForRemoval(join(path, name));
  }
}

// Suite teardown runs after test hooks that still inspect fixtures or reap children.
after(async () => {
  const results = await Promise.allSettled(
    [...temporaryRoots].map(async ([root, prefix]) => {
      assert.equal(dirname(root), tmpdir(), "fixture escaped its temporary root");
      assert.ok(basename(root).startsWith(prefix), "fixture has an unexpected prefix");
      assert.match(basename(root).slice(prefix.length), /^[A-Za-z0-9]{6}$/u);
      await grantOwnerAccessForRemoval(root);
      await rm(root, { recursive: true, force: true });
      temporaryRoots.delete(root);
    }),
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Failed to remove mutation test fixtures");
});

function commandPath(command) {
  const executablePath = findExecutableOnPath(command, { pathValue: process.env.PATH });
  if (executablePath) return executablePath;
  throw new Error(`Test prerequisite is missing from PATH: ${command}`);
}

async function installContainmentTools(bin) {
  if (process.platform !== "linux") return;
  await symlink(commandPath("rustc"), join(bin, "rustc"));
  await symlink(commandPath("prlimit"), join(bin, "prlimit"));
  await symlink(commandPath("python3"), join(bin, "python3"));
}

function nativeRustHost(runCommand = spawnSync) {
  const result = runCommand("rustc", ["-vV"], { encoding: "utf8" });
  if (result.error) {
    throw new Error(`Test fixture native Rust host detection failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.signal) {
    throw new Error(
      `Test fixture native Rust host detection failed: rustc died with ${result.signal}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Test fixture native Rust host detection failed: rustc exited with status ${result.status}`,
    );
  }
  const host = parseRustHostMetadata(result.stdout ?? "");
  if (!host) {
    throw new Error("Test fixture native Rust host detection failed: rustc returned no valid host");
  }
  return host;
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function fixture() {
  const root = await temporaryRoot("backend-mutation-runner-");
  const bin = join(root, "bin");
  const state = join(root, "shim-state");
  await mkdir(join(root, "src-tauri", "src"), { recursive: true });
  await mkdir(bin);
  await mkdir(state);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "index.html"), "<html>fixture</html>");
  await writeFile(join(root, "src-tauri", "Cargo.toml"), '[package]\nname = "fixture"\n');
  await writeFile(join(root, "src-tauri", "src", "sample.rs"), "pub fn sample() {}\n");
  await writeShim(
    join(bin, "cargo"),
    `#!/bin/sh
echo $$ > "$SHIM_STATE/pid"
printf '%s' "$PWD" > "$SHIM_STATE/cwd"
printf '%s' "$CARGO_TARGET_DIR" > "$SHIM_STATE/target"
printf '%s\n' "$@" > "$SHIM_STATE/arguments"
printf '%s' "\${CHESSFABLE_ENCODING_MUTATION_SUPPRESS_CORE-}" > "$SHIM_STATE/core-suppression"
if [ -e "$LIVE_ROOT/mutants.out/backend/.mutation-in-progress" ]; then
  : > "$SHIM_STATE/fence-present-at-spawn"
fi
# Last marker: tests wait for it and then read every marker above.
: > "$SHIM_STATE/started"
output=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output" ]; then output="$argument"; fi
  previous="$argument"
done
case "$SHIM_MODE" in
  block)
    trap ': > "$SHIM_STATE/terminated"; exit 0' TERM INT
    while [ ! -e "$SHIM_STATE/release" ]; do /bin/sleep 0.05; done
    ;;
  ignore-term)
    trap '' TERM INT
    while :; do /bin/sleep 0.05; done
    ;;
  marker)
    printf '\n/* ~ changed by cargo-mutants ~ */\n' >> "$LIVE_ROOT/src-tauri/src/sample.rs"
    ;;
  edit)
    printf '\n// unrelated concurrent edit\n' >> src-tauri/src/sample.rs
    ;;
  nonzero)
    exit 7
    ;;
  baseline)
    echo 'cargo-mutants unmodified baseline failed' >&2
    exit 4
    ;;
  timeout)
    mkdir -p "$output/mutants.out"
    : > "$output/mutants.out/missed.txt"
    exit 3
    ;;
  survivor)
    mkdir -p "$output/mutants.out"
    echo survivor > "$output/mutants.out/missed.txt"
    exit 3
    ;;
esac
`,
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "src-tauri"]);
  git(root, [
    "-c",
    "user.name=Runner Test",
    "-c",
    "user.email=runner@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  return { root, bin, state };
}

if (process.env.CHESSFABLE_FIXTURE_CLEANUP_PROBE === "1") {
  for (const outcome of ["pass", "fail"]) {
    test(`fixture cleanup probe ${outcome}`, async (t) => {
      const { root } = await fixture();
      if (outcome === "fail") {
        t.after(async () => {
          assert.equal(
            await readFile(join(root, "src-tauri", "src", "sample.rs"), "utf8"),
            "pub fn sample() {}\n",
          );
          process.stdout.write("fixture cleanup probe after hook read succeeded\n");
        });
        assert.fail("deliberate fixture cleanup probe failure");
      }
    });
  }
}

for (const outcome of ["pass", "fail"]) {
  test(`suite teardown removes fixtures after ${outcome} probe`, async (t) => {
    const privateTmpdir = await temporaryRoot("backend-mutation-cleanup-probe-");
    t.after(async () => {
      await rm(privateTmpdir, { recursive: true, force: true });
      temporaryRoots.delete(privateTmpdir);
    });
    const probeEnvironment = {
      ...process.env,
      TMPDIR: privateTmpdir,
      CHESSFABLE_FIXTURE_CLEANUP_PROBE: "1",
    };
    // A new test runner must not inherit the parent's worker context.
    delete probeEnvironment.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        `--test-name-pattern=^fixture cleanup probe ${outcome}$`,
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: projectRoot,
        env: probeEnvironment,
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.ifError(result.error);
    assert.equal(result.signal, null, output);
    if (outcome === "pass") assert.equal(result.status, 0, output);
    else {
      assert.notEqual(result.status, 0, output);
      assert.match(output, /deliberate fixture cleanup probe failure/u);
      assert.match(output, /fixture cleanup probe after hook read succeeded/u);
    }
    assert.deepEqual(
      (await readdir(privateTmpdir)).filter((name) => name.startsWith("backend-mutation-runner-")),
      [],
      `${outcome} probe leaked a fixture root`,
    );
  });
}

function environment({ bin, state, mode = "normal", path = `${bin}:${process.env.PATH}` }) {
  return {
    ...process.env,
    PATH: path,
    SHIM_MODE: mode,
    SHIM_STATE: state,
    LIVE_ROOT: dirname(bin),
    BACKEND_MUTATION_PACKAGE: "database-encoding",
  };
}

const run = (root, env, args = []) => runMutationRunner(runner, root, env, args);
const containmentScript = join(projectRoot, "scripts", "mutation-process-containment.py");

test("exported fence and cache constants are pinned and prepareCache uses the cache constant (CR-4)", async () => {
  assert.equal(fencePath, "mutants.out/backend/.mutation-in-progress");
  assert.equal(mutationCacheRelativePath, "mutants.out/backend/cargo-target");
  const source = await readFile(join(projectRoot, "scripts/run-backend-mutation.mjs"), "utf8");
  assert.match(source, /export const fencePath = /u);
  assert.match(source, /export const mutationCacheRelativePath = /u);
  assert.match(source, /const cache = join\(liveRoot, mutationCacheRelativePath\);/u);
});

test("containment treats processes vanishing during proc reads and pidfd signals as gone", () => {
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      `import importlib.util, os, signal, sys
from unittest.mock import patch
spec = importlib.util.spec_from_file_location("containment", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
pid = os.getpid() + 1000000
for failure in (FileNotFoundError, ProcessLookupError):
    # Reproduce an opened proc file whose process disappears before read().
    class VanishedStat:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self): raise failure("process disappeared during read")
    with patch("builtins.open", return_value=VanishedStat()), patch.object(module.os, "listdir", return_value=[str(pid)]):
        assert module.identity(pid) is None
        assert module.descendant(pid) is False
        module.signal_descendants(signal.SIGTERM)
        with patch.object(module.os, "pidfd_open", return_value=123), patch.object(module.os, "close"):
            module.signal_owned(pid, "start", signal.SIGTERM)
    with patch.object(module.os, "pidfd_open", side_effect=failure("process disappeared before pidfd_open")):
        module.signal_owned(pid, "start", signal.SIGTERM)
    with patch.object(module.os, "pidfd_open", return_value=123), patch.object(module.os, "close"), patch.object(module, "identity", return_value=(os.getpid(), "start")), patch.object(module.signal, "pidfd_send_signal", side_effect=failure("process disappeared before signal")):
        module.signal_owned(pid, "start", signal.SIGTERM)
with patch("builtins.open", side_effect=PermissionError("proc denied")):
    try: module.identity(pid)
    except PermissionError: pass
    else: raise AssertionError("non-vanishing proc errors must propagate")
print("proc read, ancestry scan and pidfd disappearance cases passed")
`,
      containmentScript,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proc read, ancestry scan and pidfd disappearance cases passed/u);
});

const start = (t, root, env, options = {}) =>
  startMutationRunner(t, runner, root, env, {
    containmentScript,
    terminalPath: join(env.SHIM_STATE, "test-terminal.json"),
    ...options,
  });

function fields(record) {
  return Object.fromEntries(
    record
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
}

function cleanupRetainedSnapshot(t, root, fallbackRecord = undefined) {
  t.after(async () => {
    for (const recordPath of [join(root, fence), fallbackRecord].filter(Boolean)) {
      let owner;
      try {
        owner = fields(await readFile(recordPath, "utf8"));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      if (!owner.snapshot) continue;
      assert.equal(
        dirname(owner.snapshot),
        tmpdir(),
        "fixture snapshot escaped its temporary root",
      );
      assert.match(basename(owner.snapshot), /^chessfable-backend-mutation-[A-Za-z0-9]{6}$/u);
      try {
        await chmod(owner.snapshot, 0o700);
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      await rm(owner.snapshot, { recursive: true });
      return;
    }
  });
}

async function completedOwner(root) {
  let owner;
  await waitUntil(
    async () => {
      try {
        owner = fields(await readFile(join(root, fence), "utf8"));
        return /^\d+$/u.test(owner.pid ?? "") && /^\d+$/u.test(owner.pidStartTime ?? "");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return false;
      }
    },
    "parent did not publish its completed owner record",
    10_000,
  );
  return owner;
}

async function launcherWith(root, hooks) {
  const launcher = join(root, "launcher.mjs");
  await writeFile(
    launcher,
    `import { writeFileSync, readFileSync, existsSync, unlinkSync, chmodSync } from "node:fs";
import { runBackendMutation } from ${JSON.stringify(pathToFileURL(runner).href)};
process.exitCode = await runBackendMutation({ ${hooks} });\n`,
  );
  return launcher;
}

async function terminalEvidence(root) {
  const output = join(root, "mutants.out", "backend", "database-encoding");
  const names = (await readdir(output)).filter((name) => name === "terminal.json");
  assert.equal(names.length, 1, "expected one invocation-owned terminal evidence file");
  const path = join(output, names[0]);
  return { path, record: JSON.parse(await readFile(path, "utf8")) };
}

test("a normal clean run holds the fence for the run and removes it afterwards", async (t) => {
  const { root, bin, state } = await fixture();
  const running = start(t, root, environment({ bin, state, mode: "block" }));
  await completedOwner(root);
  await waitFor(join(state, "started"));
  await readFile(join(state, "fence-present-at-spawn"));
  assert.match(
    await readFile(join(root, fence), "utf8"),
    /^started=.*\nrunnerPid=\d+\nrunnerStartTime=\d+\nsnapshot=.+\ncache=.+\npid=\d+\npidStartTime=\d+\n$/,
  );
  await writeFile(join(state, "release"), "");
  const result = await running.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
  const argumentsList = (await readFile(join(state, "arguments"), "utf8")).trim().split("\n");
  assert.ok(argumentsList.includes("--baseline=run"));
  assert.ok(argumentsList.includes("--caught"));
  assert.ok(argumentsList.includes("--unviable"));
  if (process.platform === "linux") {
    const host = nativeRustHost();
    const containmentStart = argumentsList.indexOf("--cargo-arg=--target");
    assert.deepEqual(argumentsList.slice(containmentStart, containmentStart + 4), [
      "--cargo-arg=--target",
      `--cargo-arg=${host}`,
      "--cargo-arg=--config",
      `--cargo-arg=target.${host}.runner=["prlimit","--as=2147483648","--core=0","--"]`,
    ]);
    assert.equal(await readFile(join(state, "core-suppression"), "utf8"), "1");
  }
});

test("the production Cargo arguments enforce executable limits over file and environment config", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux /proc limits and prlimit are required");
    return;
  }
  const root = await temporaryRoot("backend-mutation-limits-");
  const host = nativeRustHost();
  await mkdir(join(root, ".cargo"));
  await mkdir(join(root, "tests"));
  await writeFile(
    join(root, "Cargo.toml"),
    '[package]\nname = "limits-fixture"\nversion = "0.0.0"\nedition = "2021"\n\n[[test]]\nname = "limits"\npath = "tests/limits.rs"\nharness = false\n',
  );
  await writeFile(
    join(root, "tests", "limits.rs"),
    `fn main() {
    let limits = std::fs::read_to_string("/proc/self/limits").unwrap();
    for line in limits.lines() {
        if line.starts_with("Max address space") || line.starts_with("Max core file size") {
            println!("{line}");
        }
    }
}
`,
  );
  await writeFile(
    join(root, ".cargo", "config.toml"),
    `[build]\ntarget = "invalid-file-target"\n[target.${host}]\nrunner = ["invalid-file-runner", "--from-file"]\n`,
  );
  const runnerKey = `CARGO_TARGET_${host.toUpperCase().replaceAll("-", "_")}_RUNNER`;
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.CARGO_BUILD_TARGET;
  delete baseEnvironment[runnerKey];
  const invokeFixture = (extraEnvironment = {}) =>
    spawnSync(
      "cargo",
      [
        "test",
        "--test",
        "limits",
        "--quiet",
        "--manifest-path",
        join(root, "Cargo.toml"),
        ...encodingCargoArguments(host),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...baseEnvironment, ...extraEnvironment },
      },
    );
  for (const result of [
    invokeFixture(),
    invokeFixture({
      CARGO_BUILD_TARGET: "invalid-environment-target",
      [runnerKey]: "invalid-environment-runner",
    }),
  ]) {
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Max address space\s+2147483648\s+2147483648\s+bytes/);
    assert.match(result.stdout, /Max core file size\s+0\s+0\s+bytes/);
  }
});

test("the real-Cargo fixture host helper rejects process and metadata failures clearly", () => {
  const processFailure = new Error("rustc unavailable");
  assert.throws(
    () => nativeRustHost(() => ({ error: processFailure })),
    /Test fixture native Rust host detection failed: rustc unavailable/,
  );
  assert.throws(
    () => nativeRustHost(() => ({ status: 0, stdout: "rustc without host\n" })),
    /Test fixture native Rust host detection failed: rustc returned no valid host/,
  );
});

test("encoding containment fails closed when host detection or prlimit setup fails", async (t) => {
  if (process.platform !== "linux") {
    t.skip("containment applies only to Linux encoding executables");
    return;
  }
  for (const failure of [
    "missing-host-tool",
    "invalid-host",
    "missing-prlimit",
    "broken-prlimit",
    "signalled-host",
    "signalled-prlimit",
  ]) {
    const { root, bin, state } = await fixture();
    const isolatedBin = join(root, failure);
    await mkdir(isolatedBin);
    await symlink("/usr/bin/git", join(isolatedBin, "git"));
    await symlink(join(bin, "cargo"), join(isolatedBin, "cargo"));
    if (failure !== "missing-host-tool") {
      await writeShim(
        join(isolatedBin, "rustc"),
        failure === "invalid-host"
          ? "#!/bin/sh\nprintf 'rustc fixture without host\\n'\n"
          : failure === "signalled-host"
            ? "#!/bin/sh\necho 'host shim terminating' >&2\nkill -TERM $$\n"
            : "#!/bin/sh\nprintf 'rustc 1.98.0\\nhost: x86_64-unknown-linux-gnu\\n'\n",
      );
    }
    if (
      failure !== "missing-prlimit" &&
      failure !== "missing-host-tool" &&
      failure !== "signalled-host"
    ) {
      await writeShim(
        join(isolatedBin, "prlimit"),
        failure === "broken-prlimit"
          ? "#!/bin/sh\nexit 9\n"
          : failure === "signalled-prlimit"
            ? "#!/bin/sh\necho 'prlimit shim terminating' >&2\nkill -TERM $$\n"
            : '#!/bin/sh\nexec "$@"\n',
      );
    }
    const result = run(root, environment({ bin, state, path: isolatedBin }));
    assert.equal(result.status, 1);
    if (failure === "missing-host-tool")
      assert.match(result.stderr, /host detection failed:.*ENOENT/s);
    if (failure === "invalid-host")
      assert.match(result.stderr, /host detection failed:.*no valid host/s);
    if (failure === "missing-prlimit")
      assert.match(result.stderr, /prlimit runner setup failed:.*ENOENT/s);
    if (failure === "broken-prlimit") {
      assert.match(result.stderr, /prlimit runner setup failed: prlimit exited with status 9/s);
    }
    if (failure === "signalled-host") {
      assert.match(
        result.stderr,
        /host detection failed: rustc died with SIGTERM: host shim terminating/s,
      );
    }
    if (failure === "signalled-prlimit") {
      assert.match(
        result.stderr,
        /prlimit runner setup failed: prlimit died with SIGTERM: prlimit shim terminating/s,
      );
    }
    await assert.rejects(() => readFile(join(state, "started")));
    assert.equal(existsSync(join(root, fence)), false);
  }
});

test("a selected non-encoding package runs without encoding containment tools", async () => {
  const { root, bin, state } = await fixture();
  const isolatedBin = join(root, "non-encoding-bin");
  await mkdir(isolatedBin);
  await symlink("/usr/bin/git", join(isolatedBin, "git"));
  await symlink(join(bin, "cargo"), join(isolatedBin, "cargo"));
  await symlink(commandPath("python3"), join(isolatedBin, "python3"));
  const env = {
    ...environment({ bin, state, path: isolatedBin }),
    BACKEND_MUTATION_PACKAGE: "database-search",
    CHESSFABLE_ENCODING_MUTATION_SUPPRESS_CORE: "ambient-contamination",
  };
  const result = run(root, env);
  assert.equal(result.status, 0, result.stderr);
  const argumentsList = (await readFile(join(state, "arguments"), "utf8")).trim().split("\n");
  assert.ok(argumentsList.includes("src/db/search.rs"));
  assert.equal(
    argumentsList.some((argument) => argument.includes("target.")),
    false,
  );
  assert.equal(
    argumentsList.some((argument) => argument.includes("prlimit")),
    false,
  );
  assert.equal(await readFile(join(state, "core-suppression"), "utf8"), "");
});

test("selection and side-effect-free routes do not require containment tools", async () => {
  const { root, bin, state } = await fixture();
  const isolatedBin = join(root, "empty-bin");
  await mkdir(isolatedBin);
  const env = environment({ bin, state, path: isolatedBin });

  const listed = run(root, env, ["--list-packages"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout).length, 8);

  const guarded = run(root, env, ["--check-guard"]);
  assert.equal(guarded.status, 0, guarded.stderr);

  const unknown = run(root, { ...env, BACKEND_MUTATION_PACKAGE: "unknown-package" });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown BACKEND_MUTATION_PACKAGE: unknown-package/);
  await assert.rejects(() => readFile(join(state, "started")));
  assert.equal(existsSync(join(root, fence)), false);
});

test("backend mutation selector rejects an unknown package id through the shared helper", () => {
  assert.throws(
    () => selectBackendMutationPackages("unknown-package"),
    /Unknown BACKEND_MUTATION_PACKAGE: unknown-package/u,
  );
});

test("an uncatchable mid-flight kill leaves the fence and makes the next run refuse", async (t) => {
  const { root, bin, state } = await fixture();
  const env = environment({ bin, state, mode: "block" });
  const running = start(t, root, env, { stdio: "ignore" });
  cleanupRetainedSnapshot(t, root);
  await waitFor(join(state, "started"));
  const owner = await completedOwner(root);
  const cargoPid = Number(await readFile(join(state, "pid"), "utf8"));
  process.kill(Number(owner.runnerPid), "SIGKILL");
  process.kill(cargoPid, "SIGTERM");
  const killed = await running.done;
  assert.equal(killed.code, 137);
  const retry = run(root, env);
  assert.notEqual(retry.status, 0);
  assert.match(retry.stderr, /Backend mutation fence exists/);
  await waitFor(join(state, "terminated"));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} terminates and reaps cargo before the finaliser clears the fence`, async (t) => {
    const { root, bin, state } = await fixture();
    const running = start(t, root, environment({ bin, state, mode: "ignore-term" }));
    await waitFor(join(state, "started"));
    const cargoPid = Number(await readFile(join(state, "pid"), "utf8"));
    const owner = await completedOwner(root);
    process.kill(Number(owner.runnerPid), signal);
    const result = await running.done;
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
    assert.equal(isAlive(cargoPid), false, `cargo pid ${cargoPid} still exists after runner exit`);
    assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
  });
}

test("cargo exiting non-zero still runs the finaliser", async () => {
  const { root, bin, state } = await fixture();
  const result = run(root, environment({ bin, state, mode: "nonzero" }));
  assert.equal(result.status, 7, result.stderr);
  assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
});

test("an unmodified baseline failure is surfaced and clears the fence", async () => {
  const { root, bin, state } = await fixture();
  const result = run(root, environment({ bin, state, mode: "baseline" }));
  assert.equal(result.status, 4);
  assert.match(result.stderr, /cargo-mutants unmodified baseline failed/);
  assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
});

test("exit 3 remains successful only when missed.txt has no survivor", async () => {
  const timeout = await fixture();
  const timeoutResult = run(
    timeout.root,
    environment({ bin: timeout.bin, state: timeout.state, mode: "timeout" }),
  );
  assert.equal(timeoutResult.status, 0, timeoutResult.stderr);

  const survivor = await fixture();
  const survivorResult = run(
    survivor.root,
    environment({ bin: survivor.bin, state: survivor.state, mode: "survivor" }),
  );
  assert.equal(survivorResult.status, 3, survivorResult.stderr);
});

test("cargo failing to spawn runs the finaliser and surfaces the underlying error", async () => {
  const { root, bin, state } = await fixture();
  const isolatedBin = join(root, "git-only-bin");
  await mkdir(isolatedBin);
  await symlink("/usr/bin/git", join(isolatedBin, "git"));
  await installContainmentTools(isolatedBin);
  const result = run(root, environment({ bin, state, path: isolatedBin }));
  assert.equal(result.status, 127);
  assert.match(result.stderr, /could not spawn cargo:.*No such file/s);
  assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
});

test("a child-record failure terminates cargo and clears the fence promptly", async () => {
  const { root, bin, state } = await fixture();
  const launcher = join(root, "record-failure.mjs");
  await writeFile(
    launcher,
    `import { existsSync } from "node:fs";
import { runBackendMutation } from ${JSON.stringify(pathToFileURL(runner).href)};
process.exitCode = await runBackendMutation({
  recordChild() {
    const deadline = Date.now() + 2_000;
    while (!existsSync(${JSON.stringify(join(state, "started"))}) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    throw new Error("forced record failure");
  },
});
`,
  );
  const startedAt = Date.now();
  const result = runMutationRunner(launcher, root, environment({ bin, state, mode: "block" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forced record failure/u);
  assert.equal(existsSync(join(state, "terminated")), true);
  assert.ok(Date.now() - startedAt < 4_000, "record failure did not terminate cargo promptly");
  assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
});

test("a preparation hook failure removes the unspawned snapshot and fence", async () => {
  const { root, bin, state } = await fixture();
  const launcher = await launcherWith(
    root,
    `afterSnapshotCopy({ snapshot }) {
    writeFileSync(${JSON.stringify(join(state, "snapshot"))}, snapshot);
    throw new Error("forced preparation failure");
  }`,
  );
  const result = runMutationRunner(launcher, root, environment({ bin, state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forced preparation failure/u);
  assert.equal(existsSync(join(state, "started")), false);
  assert.equal(existsSync(join(root, fence)), false);
  assert.equal(existsSync(await readFile(join(state, "snapshot"), "utf8")), false);
});

test("a fence setup failure after the exclusive create removes the unowned fence", async (t) => {
  // Root ignores the directory permission this arranges, so the fence would be
  // created successfully and the run would proceed instead of failing.
  if (process.getuid?.() === 0) {
    t.skip("root bypasses the directory permission this test relies on");
    return;
  }
  const { root, bin, state } = await fixture();
  const env = environment({ bin, state });
  const fenceDirectory = join(root, dirname(fence));
  await mkdir(fenceDirectory, { recursive: true });
  // Write and execute but not read: creating the fence inside still succeeds, while
  // the directory fsync that follows it cannot open the directory. That puts the
  // failure *inside* fence setup, after the exclusive create has already happened —
  // a different path from a failure reading the fence back, and the one that would
  // otherwise strand a fence nobody can explain.
  await chmod(fenceDirectory, 0o300);
  const result = run(root, env);
  await chmod(fenceDirectory, 0o755);
  assert.notEqual(result.status, 0);
  await assert.rejects(() => readFile(join(state, "started")));
  assert.equal(run(root, env, ["--check-guard"]).status, 0);
});

test("entry refuses a dirty src-tauri and lists its path", async () => {
  const { root, bin, state } = await fixture();
  await writeFile(join(root, "src-tauri", "src", "sample.rs"), "dirty\n");
  const result = run(root, environment({ bin, state }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /src-tauri is dirty:[\s\S]*src-tauri\/src\/sample\.rs/);
  assert.doesNotMatch(result.stdout, /Backend mutation package/);
});

test("a pre-existing fence reports liveness and a per-file restore command", async () => {
  const { root, bin, state } = await fixture();
  await mkdir(join(root, dirname(fence)), { recursive: true });
  await writeFile(join(root, fence), `started=2026-08-30T00:00:00.000Z\npid=${process.pid}\n`);
  await writeFile(join(root, "src-tauri", "src", "sample.rs"), `pub fn sample() {}\n${marker}\n`);
  const result = run(root, environment({ bin, state }));
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(`Recorded cargo pid: ${process.pid}, currently alive: yes`),
  );
  assert.match(result.stderr, /git checkout -- 'src-tauri\/src\/sample\.rs'/);
  assert.ok(
    result.stderr.indexOf("1. Confirm") < result.stderr.indexOf("2. Restore") &&
      result.stderr.indexOf("2. Restore") < result.stderr.indexOf("3. Recorded"),
  );
  assert.doesNotMatch(result.stderr, /git checkout -- src-tauri(?:\s|$)/);
});

test("--check-guard treats a reused live pid with the wrong start time as stale", async () => {
  const { root, bin, state } = await fixture();
  await mkdir(join(root, dirname(fence)), { recursive: true });
  await writeFile(
    join(root, fence),
    `started=2026-08-30T00:00:00.000Z\npid=${process.pid}\npidStartTime=wrong\n`,
  );
  const result = run(root, environment({ bin, state }), ["--check-guard"]);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(`Recorded cargo pid: ${process.pid}, currently alive: no`),
  );
});

test("--check-guard surfaces an unreadable fence record and still refuses", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses the file permission this test relies on");
    return;
  }
  const { root, bin, state } = await fixture();
  await mkdir(join(root, dirname(fence)), { recursive: true });
  const fencePath = join(root, fence);
  await writeFile(fencePath, "started=2026-08-30T00:00:00.000Z\n");
  await chmod(fencePath, 0o000);
  const result = run(root, environment({ bin, state }), ["--check-guard"]);
  await chmod(fencePath, 0o600);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Fence owner record is unreadable:.*(?:EACCES|permission denied)/su);
});

test("exclusive fence creation rejects a second concurrent runner", async (t) => {
  const { root, bin, state } = await fixture();
  const env = environment({ bin, state, mode: "block" });
  const first = start(t, root, env);
  await waitFor(join(state, "started"));
  const second = run(root, env);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Backend mutation fence exists/);
  await writeFile(join(state, "release"), "");
  assert.equal((await first.done).code, 0);
});

test("exit verification keeps the fence for a marker but ignores an unrelated edit", async (t) => {
  const marked = await fixture();
  cleanupRetainedSnapshot(t, marked.root);
  const markedResult = run(
    marked.root,
    environment({ bin: marked.bin, state: marked.state, mode: "marker" }),
  );
  assert.equal(markedResult.status, 1);
  assert.match(markedResult.stderr, /left cargo-mutants markers/);
  assert.notEqual(run(marked.root, environment(marked), ["--check-guard"]).status, 0);

  const edited = await fixture();
  const editResult = run(
    edited.root,
    environment({ bin: edited.bin, state: edited.state, mode: "edit" }),
  );
  assert.equal(editResult.status, 0, editResult.stderr);
  assert.equal(run(edited.root, environment(edited), ["--check-guard"]).status, 0);
});

test("a failed final marker scan keeps the fence and fails the run", async (t) => {
  const { root, bin, state } = await fixture();
  cleanupRetainedSnapshot(t, root);
  const failingBin = join(root, "grep-failing-git-bin");
  await mkdir(failingBin);
  await writeFile(
    join(failingBin, "git"),
    '#!/bin/sh\nif [ "$1" = "grep" ]; then exit 2; fi\nexec /usr/bin/git "$@"\n',
  );
  await chmod(join(failingBin, "git"), 0o755);
  await symlink(join(bin, "cargo"), join(failingBin, "cargo"));
  await installContainmentTools(failingBin);
  const result = run(root, environment({ bin, state, path: `${failingBin}:/bin` }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /finaliser could not verify the tree/);
  assert.notEqual(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
});

test("a failing git status is a refusal rather than a clean tree", async () => {
  const { root, bin, state } = await fixture();
  const failingBin = join(root, "failing-git-bin");
  await mkdir(failingBin);
  await writeFile(join(failingBin, "git"), "#!/bin/sh\nexit 2\n");
  await chmod(join(failingBin, "git"), 0o755);
  await symlink(join(bin, "cargo"), join(failingBin, "cargo"));
  const result = run(root, environment({ bin, state, path: `${failingBin}:/bin` }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /git status failed with exit 2/);
  await assert.rejects(() => readFile(join(state, "started")));
});

test("--list-packages preserves the manifest and creates no fence", async () => {
  const { root, bin, state } = await fixture();
  const result = run(root, environment({ bin, state }), ["--list-packages"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    "database-encoding",
    "database-search",
    "engine-protocol",
    "download-policy",
    "game-rules",
    "path-authority",
    "lexer",
    "pgn-parser",
  ]);
  assert.equal(run(root, environment({ bin, state }), ["--check-guard"]).status, 0);
});

test("--check-guard passes without a fence and fails with the recovery text when fenced", async () => {
  const { root, bin, state } = await fixture();
  const env = environment({ bin, state });
  assert.equal(run(root, env, ["--check-guard"]).status, 0);
  await mkdir(join(root, dirname(fence)), { recursive: true });
  await writeFile(join(root, fence), "started=2026-08-30T00:00:00.000Z\n");
  const guarded = run(root, env, ["--check-guard"]);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /1\. Confirm no `cargo mutants` process is running/);
});

// The wiring pin lives in check-gate-routing-tests.mjs, "the live repository pins one shared contract-gate list".

test("snapshot isolation keeps live source bytes and mtime unchanged during injected mutation", async (t) => {
  const { root, bin, state } = await fixture();
  const source = join(root, "src-tauri", "src", "sample.rs");
  const original = await readFile(source);
  const originalStat = await stat(source, { bigint: true });
  await writeShim(
    join(bin, "cargo"),
    `#!/bin/sh
printf '%s' "$PWD" > "$SHIM_STATE/cwd"
printf '%s' "$CARGO_TARGET_DIR" > "$SHIM_STATE/target"
printf '%s\\n' "$@" > "$SHIM_STATE/arguments"
cp src-tauri/src/sample.rs "$SHIM_STATE/original"
printf '\\n/* ~ changed by cargo-mutants ~ */\\n' >> src-tauri/src/sample.rs
cp src-tauri/src/sample.rs "$SHIM_STATE/mutated"
: > "$SHIM_STATE/edited"
while [ ! -e "$SHIM_STATE/release" ]; do /bin/sleep 0.02; done
cp "$SHIM_STATE/original" src-tauri/src/sample.rs
`,
  );
  const running = start(t, root, {
    ...environment({ bin, state }),
    CARGO_TARGET_DIR: join(root, "src-tauri", "target"),
  });
  let sampling = true;
  let samples = 0;
  const reader = (async () => {
    while (sampling) {
      assert.deepEqual(
        await readFile(source),
        original,
        "LIVE source bytes changed during snapshot mutation",
      );
      assert.equal(
        (await stat(source, { bigint: true })).mtimeNs,
        originalStat.mtimeNs,
        "LIVE source mtime changed during snapshot mutation",
      );
      samples += 1;
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
  // Observe rejection immediately, while retaining it for the assertion below.
  reader.catch(() => {});
  try {
    await waitFor(join(state, "edited"));
    await completedOwner(root);
    assert.deepEqual(
      await readFile(source),
      original,
      "LIVE source bytes changed during snapshot mutation",
    );
    assert.equal(
      (await stat(source, { bigint: true })).mtimeNs,
      originalStat.mtimeNs,
      "LIVE source mtime changed during snapshot mutation",
    );
    assert.match(
      await readFile(join(state, "mutated"), "utf8"),
      /changed by cargo-mutants/u,
      "mutant did not reach the copied source",
    );
    const cwd = await readFile(join(state, "cwd"), "utf8");
    assert.notEqual(cwd, root, "Cargo cwd is the live checkout");
    assert.equal(dirname(cwd), tmpdir(), "snapshot must be outside whole-tree gate scans");
    assert.equal(
      await readFile(join(state, "target"), "utf8"),
      join(root, "mutants.out", "backend", "cargo-target"),
    );
    const args = (await readFile(join(state, "arguments"), "utf8")).trim().split("\n");
    assert.equal(
      args[args.indexOf("--output") + 1],
      join(root, "mutants.out", "backend", "database-encoding"),
      "mutation report path must be absolute in the live checkout",
    );
    assert.equal(args[args.indexOf("--manifest-path") + 1], join(cwd, "src-tauri", "Cargo.toml"));
    assert.ok(samples > 0, "concurrent reader never sampled live input");
    await writeFile(join(state, "release"), "");
    const result = await running.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(cwd), false, "owned snapshot was not removed");
    assert.equal(
      existsSync(join(root, "mutants.out", "backend", "cargo-target")),
      true,
      "reusable mutation cache was removed",
    );
  } finally {
    sampling = false;
    await writeFile(join(state, "release"), "");
    await reader;
  }
});

test("snapshot preparation refuses missing dist, tracked symlinks and deterministic capture edits", async () => {
  for (const failure of [
    "missing-dist",
    "missing-index",
    "symlink",
    "capture-edit",
    "missing-tracked",
  ]) {
    const { root, bin, state } = await fixture();
    let launcher = runner;
    if (failure === "missing-dist") await rm(join(root, "dist"), { recursive: true });
    if (failure === "missing-index") await rm(join(root, "dist", "index.html"));
    if (failure === "symlink") {
      await symlink("src-tauri/src/sample.rs", join(root, "linked.rs"));
      git(root, ["add", "linked.rs"]);
    }
    if (failure === "missing-tracked") {
      await writeFile(join(root, "sibling.txt"), "input");
      git(root, ["add", "sibling.txt"]);
      await rm(join(root, "sibling.txt"));
    }
    if (failure === "capture-edit") {
      launcher = await launcherWith(
        root,
        `afterSnapshotCopy() {
        writeFileSync("src-tauri/src/sample.rs", "changed during capture");
      }`,
      );
    }
    const result = runMutationRunner(launcher, root, environment({ bin, state }));
    assert.equal(result.status, 1, `${failure}: ${result.stderr}`);
    assert.match(
      result.stderr,
      failure.startsWith("missing-d") || failure === "missing-index"
        ? /pnpm build-vite/u
        : failure === "symlink"
          ? /symlink/u
          : failure === "missing-tracked"
            ? /ENOENT.*sibling\.txt/su
            : /source changed during capture/u,
    );
    assert.equal(
      existsSync(join(state, "started")),
      false,
      `${failure}: Cargo spawned during refusal`,
    );
    assert.equal(existsSync(join(root, fence)), false, `${failure}: unspawned fence remained`);
  }
});

test("durable owner publication preserves old bytes on pre-publish crash and exclusive collision", async () => {
  const root = await temporaryRoot("durable-owner-test-");
  const target = join(root, "owner");
  const oldRecord = "started=old\nrunnerPid=123\nrunnerStartTime=456\n";
  const newRecord = "started=new\nrunnerPid=789\nrunnerStartTime=101\n";
  await writeFile(target, oldRecord);
  assert.throws(
    () =>
      durableWrite(target, newRecord, {
        beforePublish() {
          throw new Error("simulated pre-publish crash");
        },
      }),
    /simulated pre-publish crash/u,
  );
  assert.equal(
    await readFile(target, "utf8"),
    oldRecord,
    "pre-publish crash truncated the old owner record",
  );
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith(".owner.tmp-")),
    [],
    "pre-publish crash left a temporary owner record",
  );
  assert.throws(() => durableWrite(target, newRecord, { exclusive: true }), { code: "EEXIST" });
  assert.equal(
    await readFile(target, "utf8"),
    oldRecord,
    "exclusive collision changed the old owner record",
  );
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith(".owner.tmp-")),
    [],
    "exclusive collision left a temporary owner record",
  );
  durableWrite(target, newRecord);
  assert.equal(
    await readFile(target, "utf8"),
    newRecord,
    "successful replacement did not publish exactly the new bytes",
  );
});

test("owner publication exposes only whole parent records at deterministic initial and update barriers", async (t) => {
  const { root, bin, state } = await fixture();
  const launcher = await launcherWith(
    root,
    `beforeOwnerPublish({ exclusive }) {
    const stage = exclusive ? "initial" : "update";
    writeFileSync(${JSON.stringify(state)} + "/" + stage, "");
    const deadline = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(state)} + "/" + stage + "-release")) {
      if (Date.now() > deadline) throw new Error("publication barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }`,
  );
  const running = startMutationRunner(
    t,
    launcher,
    root,
    environment({ bin, state, mode: "block" }),
    {
      containmentScript,
      terminalPath: join(state, "test-terminal.json"),
    },
  );
  await waitFor(join(state, "initial"));
  assert.equal(
    existsSync(join(root, fence)),
    false,
    "initial fence appeared before whole record publication",
  );
  await writeFile(join(state, "initial-release"), "");
  await waitFor(join(state, "update"));
  const oldRecord = await readFile(join(root, fence), "utf8");
  const old = fields(oldRecord);
  assert.match(
    oldRecord,
    /^started=.+\nrunnerPid=\d+\nrunnerStartTime=\d+\nsnapshot=.+\ncache=.+\n$/u,
    "record is empty or partial before update publish",
  );
  assert.equal(existsSync(old.snapshot), true);
  for (let sample = 0; sample < 5; sample += 1) {
    assert.equal(
      await readFile(join(root, fence), "utf8"),
      oldRecord,
      "unpublished update changed the live record",
    );
  }
  await writeFile(join(state, "update-release"), "");
  const owner = await completedOwner(root);
  assert.equal(owner.runnerPid, old.runnerPid);
  assert.match(owner.pidStartTime, /^\d+$/u);
  await waitFor(join(state, "started"));
  await writeFile(join(state, "release"), "");
  assert.equal((await running.done).code, 0);
});

test("SIGKILL before owner update publication preserves the complete initial fence record", async (t) => {
  const { root, bin, state, protect } = await escapedDescendantFixture(t);
  const launcher = await launcherWith(
    root,
    `beforeOwnerPublish({ exclusive }) {
    if (exclusive) return;
    writeFileSync(${JSON.stringify(join(state, "update-paused"))}, "");
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    throw new Error("owner update barrier timed out");
  }`,
  );
  const running = startMutationRunner(t, launcher, root, environment({ bin, state }), {
    containmentScript,
    terminalPath: join(state, "test-terminal.json"),
  });
  protect(running);
  cleanupRetainedSnapshot(t, root);
  await waitFor(join(state, "update-paused"));
  await waitFor(join(state, "started"));
  const initial = await readFile(join(root, fence), "utf8");
  const initialPattern =
    /^started=.+\nrunnerPid=\d+\nrunnerStartTime=\d+\nsnapshot=.+\ncache=.+\n$/u;
  assert.match(initial, initialPattern, "paused update corrupted the complete initial record");
  const owner = fields(initial);
  process.kill(Number(owner.runnerPid), "SIGKILL");
  assert.equal((await running.done).code, 137);
  const recovered = await readFile(join(root, fence), "utf8");
  assert.match(recovered, initialPattern, "SIGKILL left an empty or partial owner record");
  assert.equal(recovered, initial, "SIGKILL changed the unpublished initial record");
  const recovery = run(root, environment({ bin, state }), ["--check-guard"]);
  assert.equal(recovery.status, 1);
  assert.match(recovery.stderr, /Backend mutation fence exists/u);
  assert.ok(recovery.stderr.includes(`rm -rf -- '${owner.snapshot}'`), recovery.stderr);
});

async function escapedDescendantFixture(t) {
  const fixtureState = await fixture();
  const { bin, state } = fixtureState;
  let cleanupError;
  const cleanup = () => {
    const result = spawnSync(
      "python3",
      [
        "-B",
        "-c",
        `import importlib.util, os, signal, sys
spec = importlib.util.spec_from_file_location("containment", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    with open(sys.argv[2] + "/descendant") as stream: pid = int(stream.read())
    with open(sys.argv[2] + "/descendant-startTime") as stream: start = stream.read()
except FileNotFoundError:
    sys.exit(0)
try: fd = os.pidfd_open(pid)
except (FileNotFoundError, ProcessLookupError): sys.exit(0)
try:
    current = module.identity(pid)
    if current is not None and current[1] == start:
        try: signal.pidfd_send_signal(fd, signal.SIGKILL)
        except (FileNotFoundError, ProcessLookupError): pass
finally: os.close(fd)
`,
        containmentScript,
        state,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    if (result.status !== 0) cleanupError = new Error(result.stderr || String(result.error));
  };
  // Register before the harness teardown. Also clean on guardian exit, because
  // an escaped process holding stdout can otherwise prevent the close event.
  t.after(() => {
    cleanup();
    if (cleanupError) throw cleanupError;
  });
  fixtureState.protect = (running) => running.child.once("exit", cleanup);
  await writeShim(
    join(bin, "cargo"),
    `#!${commandPath("python3")}
import os, signal, subprocess, sys, time
state = os.environ["SHIM_STATE"]
descendant = """import os, signal, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
signal.signal(signal.SIGINT, signal.SIG_IGN)
with open("/proc/self/stat") as stream:
    start = stream.read().rsplit(")", 1)[1].split()[19]
with open(os.environ["SHIM_STATE"] + "/descendant-startTime", "w") as stream:
    stream.write(start)
with open(os.environ["SHIM_STATE"] + "/descendant", "w") as stream:
    stream.write(str(os.getpid()))
while True:
    time.sleep(0.02)
"""
subprocess.Popen([sys.executable, "-c", descendant], start_new_session=True)
deadline = time.monotonic() + 5
while not os.path.exists(state + "/descendant"):
    if time.monotonic() > deadline: sys.exit(99)
    time.sleep(0.01)
with open(state + "/pid", "w") as stream: stream.write(str(os.getpid()))
with open(state + "/started", "w") as stream: stream.write("")
while not os.path.exists(state + "/release"):
    time.sleep(0.01)
`,
  );
  return fixtureState;
}

for (const action of ["exit", "SIGTERM", "SIGINT"]) {
  test(`containment reaps a SIGTERM-ignoring descendant in a new session before cleanup on ${action}`, async (t) => {
    const { root, bin, state, protect } = await escapedDescendantFixture(t);
    const launcher = await launcherWith(
      root,
      `async afterWrapperExit(terminal) {
      writeFileSync(${JSON.stringify(join(state, "terminal-before-cleanup"))}, terminal.path);
      const deadline = Date.now() + 10000;
      while (!existsSync(${JSON.stringify(join(state, "inspect-release"))})) {
        if (Date.now() > deadline) throw new Error("terminal barrier timed out");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }`,
    );
    const running = startMutationRunner(t, launcher, root, environment({ bin, state }), {
      containmentScript,
      terminalPath: join(state, "test-terminal.json"),
    });
    protect(running);
    const owner = await completedOwner(root);
    await waitFor(join(state, "started"));
    const descendant = Number(await readFile(join(state, "descendant"), "utf8"));
    assert.equal(isAlive(descendant), true);
    if (action === "exit") await writeFile(join(state, "release"), "");
    else process.kill(Number(owner.runnerPid), action);
    await waitFor(join(state, "terminal-before-cleanup"), 10_000);
    assert.equal(existsSync(`/proc/${descendant}`), false, "escaped descendant was not reaped");
    assert.equal(
      existsSync(join(root, fence)),
      true,
      "fence removed before terminal evidence inspection",
    );
    assert.equal(
      existsSync(owner.snapshot),
      true,
      "snapshot removed before terminal evidence inspection",
    );
    const evidence = await terminalEvidence(root);
    assert.equal(evidence.record["no-unwaited-children"], true);
    assert.equal(evidence.record.pid, Number(owner.pid));
    await writeFile(join(state, "inspect-release"), "");
    const result = await running.done;
    assert.equal(
      result.code,
      action === "exit" ? 0 : action === "SIGINT" ? 130 : 143,
      result.stderr,
    );
    assert.equal(existsSync(owner.snapshot), false);
    assert.equal(existsSync(join(root, fence)), false);
  });
}

for (const failure of [
  "missing",
  "failed",
  "wrong-pid",
  "wrong-start-time",
  "wrong-status",
  "wrong-signal",
  "invalid-json",
  "malformed-owner",
  "cleanup",
]) {
  test(`failed terminal/owner/cleanup state retains fence and snapshot: ${failure}`, async (t) => {
    if (failure === "cleanup" && process.getuid?.() === 0) {
      t.skip("root bypasses snapshot permissions");
      return;
    }
    const { root, bin, state } = await fixture();
    cleanupRetainedSnapshot(t, root, join(state, "owner"));
    const evidenceChanges = {
      "wrong-pid": "evidence.pid += 1;",
      "wrong-start-time": 'evidence.pidStartTime += "0";',
      "wrong-status": "evidence.status += 1;",
      "wrong-signal": "evidence.signal = 2;",
    };
    const launcher = await launcherWith(
      root,
      `afterWrapperExit(terminal) {
      const record = readFileSync(${JSON.stringify(join(root, fence))}, "utf8");
      writeFileSync(${JSON.stringify(join(state, "owner"))}, record);
      ${
        failure === "missing"
          ? "unlinkSync(terminal.path);"
          : failure === "failed"
            ? 'writeFileSync(terminal.path, JSON.stringify({ "no-unwaited-children": false }));'
            : failure === "malformed-owner"
              ? `writeFileSync(${JSON.stringify(join(root, fence))}, "malformed");`
              : failure === "cleanup"
                ? "chmodSync(record.match(/^snapshot=(.+)$/m)[1], 0o500);"
                : failure === "invalid-json"
                  ? 'writeFileSync(terminal.path, "{");'
                  : `const evidence = JSON.parse(readFileSync(terminal.path, "utf8"));
                     ${evidenceChanges[failure]}
                     writeFileSync(terminal.path, JSON.stringify(evidence));`
      }
    }`,
    );
    const result = runMutationRunner(launcher, root, environment({ bin, state }));
    assert.equal(result.status, 1, result.stderr);
    const owner = fields(await readFile(join(state, "owner"), "utf8"));
    assert.equal(existsSync(owner.snapshot), true, "unsafe cleanup removed snapshot");
    assert.equal(existsSync(join(root, fence)), true, "unsafe cleanup removed fence");
    assert.equal(
      run(root, environment({ bin, state })).status,
      1,
      "second owner reused unsafe cache",
    );
  });
}

test("finaliser reports snapshot already removed when fence unlink fails", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses fence directory permissions");
    return;
  }
  const { root, bin, state } = await fixture();
  const directory = join(root, dirname(fence));
  t.after(() => chmod(directory, 0o755));
  cleanupRetainedSnapshot(t, root);
  const launcher = await launcherWith(
    root,
    `afterWrapperExit() {
    chmodSync(${JSON.stringify(directory)}, 0o500);
  }`,
  );
  const result = runMutationRunner(launcher, root, environment({ bin, state }));
  assert.equal(result.status, 1, result.stderr);
  const owner = fields(await readFile(join(root, fence), "utf8"));
  assert.equal(existsSync(owner.snapshot), false);
  assert.equal(existsSync(join(root, fence)), true);
  assert.match(result.stderr, /Fence retained: mutants\.out\/backend\/\.mutation-in-progress/u);
  assert.ok(result.stderr.includes(`Snapshot already removed: ${owner.snapshot}`), result.stderr);
  assert.doesNotMatch(result.stderr, /Snapshot retained:/u);
});

test("finaliser reports both resources already removed when fence directory fsync fails", async (t) => {
  const { root, bin, state } = await fixture();
  cleanupRetainedSnapshot(t, root, join(state, "owner"));
  const launcher = await launcherWith(
    root,
    `async afterWrapperExit() {
    writeFileSync(${JSON.stringify(join(state, "owner"))}, readFileSync(${JSON.stringify(join(root, fence))}, "utf8"));
    const fs = await import("node:fs");
    const { syncBuiltinESMExports } = await import("node:module");
    fs.default.fsyncSync = () => { throw new Error("injected fence directory fsync failure"); };
    syncBuiltinESMExports();
  }`,
  );
  const result = runMutationRunner(launcher, root, environment({ bin, state }));
  assert.equal(result.status, 1, result.stderr);
  const owner = fields(await readFile(join(state, "owner"), "utf8"));
  assert.equal(existsSync(owner.snapshot), false);
  assert.equal(existsSync(join(root, fence)), false);
  assert.match(result.stderr, /injected fence directory fsync failure/u);
  assert.match(
    result.stderr,
    /Fence already removed: mutants\.out\/backend\/\.mutation-in-progress/u,
  );
  assert.ok(result.stderr.includes(`Snapshot already removed: ${owner.snapshot}`), result.stderr);
  assert.doesNotMatch(result.stderr, /(?:Fence|Snapshot) retained:/u);
});

for (const killedOwner of ["runner", "containment"]) {
  test(`SIGKILL of ${killedOwner} retains owned state and reports safe recovery`, async (t) => {
    const { root, bin, state, protect } = await escapedDescendantFixture(t);
    const original = await readFile(join(root, "src-tauri", "src", "sample.rs"));
    const running = start(t, root, environment({ bin, state }));
    protect(running);
    cleanupRetainedSnapshot(t, root);
    const owner = await completedOwner(root);
    await waitFor(join(state, "started"));
    const descendant = Number(await readFile(join(state, "descendant"), "utf8"));
    process.kill(Number(killedOwner === "runner" ? owner.runnerPid : owner.pid), "SIGKILL");
    // The outer test subreaper owns survivors after either crash and reaps them.
    if (killedOwner === "runner") await writeFile(join(state, "release"), "");
    const result = await running.done;
    assert.equal(result.code, killedOwner === "runner" ? 137 : 1, result.stderr);
    assert.equal(
      existsSync(`/proc/${descendant}`),
      false,
      "test boundary leaked an escaped descendant",
    );
    assert.deepEqual(await readFile(join(root, "src-tauri", "src", "sample.rs")), original);
    assert.equal(existsSync(owner.snapshot), true);
    assert.equal(existsSync(join(root, fence)), true);
    const recovery = run(root, environment({ bin, state }), ["--check-guard"]);
    assert.equal(recovery.status, 1);
    assert.match(
      recovery.stderr,
      new RegExp(`Recorded containment-owner pid: ${owner.pid}, currently alive:`),
    );
    assert.ok(recovery.stderr.includes(`rm -rf -- '${owner.snapshot}'`), recovery.stderr);
    assert.equal(run(root, environment({ bin, state })).status, 1);
  });
}

test("Python unavailability and subreaper refusal fail before Cargo without a fence", async () => {
  for (const failure of ["missing-python", "subreaper"]) {
    const { root, bin, state } = await fixture();
    const isolatedBin = join(root, "capability-bin");
    await mkdir(isolatedBin);
    for (const name of ["git", "rustc", "prlimit"]) {
      await symlink(commandPath(name), join(isolatedBin, name));
    }
    await symlink(join(bin, "cargo"), join(isolatedBin, "cargo"));
    if (failure !== "missing-python")
      await symlink(commandPath("python3"), join(isolatedBin, "python3"));
    const result = run(root, {
      ...environment({ bin, state, path: isolatedBin }),
      CHESSFABLE_MUTATION_TEST_PRCTL_FAIL: failure === "subreaper" ? "1" : "",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Python 3\/subreaper capability check/u);
    assert.equal(existsSync(join(state, "started")), false);
    assert.equal(existsSync(join(root, fence)), false);
  }
});

test("malformed snapshot metadata never suggests arbitrary deletion", async () => {
  const { root, bin, state } = await fixture();
  await mkdir(join(root, dirname(fence)), { recursive: true });
  for (const snapshot of [
    root,
    "/tmp/arbitrary",
    "/tmp/chessfable-backend-mutation-../other",
    "relative",
    "",
  ]) {
    await writeFile(join(root, fence), `started=legacy\nsnapshot=${snapshot}\n`);
    const result = run(root, environment({ bin, state }), ["--check-guard"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown\/malformed/u);
    assert.doesNotMatch(result.stderr, /rm -rf/u);
  }
});

test("terminal publication failure after rename cannot authorize cleanup when Cargo also exits 125", async (t) => {
  const { root, bin, state } = await fixture();
  cleanupRetainedSnapshot(t, root);
  await writeShim(
    join(bin, "cargo"),
    `#!/bin/sh
: > "$SHIM_STATE/started"
exit 125
`,
  );
  const result = run(root, {
    ...environment({ bin, state }),
    CHESSFABLE_MUTATION_TEST_EVIDENCE_FAIL: "1",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(join(state, "started")), true, "Cargo never reached the failure fixture");
  assert.match(result.stderr, /injected terminal publication failure after rename/u);
  assert.equal(existsSync(join(root, fence)), true, "failed publication released the cache fence");
  const owner = fields(await readFile(join(root, fence), "utf8"));
  assert.equal(existsSync(owner.snapshot), true, "failed publication removed the snapshot");
  assert.equal(
    existsSync(join(root, "mutants.out", "backend", "database-encoding", "terminal.json")),
    false,
    "a failed terminal publication retained positive evidence",
  );
  assert.equal(
    run(root, environment({ bin, state })).status,
    1,
    "second runner reused an unsafe cache",
  );
});

for (const alias of ["cache-symlink", "cache-parent-symlink", "target-aliases-cache-ancestor"]) {
  test(`cache alias refusal preserves live target metadata before any Cargo spawn: ${alias}`, async () => {
    const { root, bin, state } = await fixture();
    await writeFile(join(root, ".gitignore"), "/src-tauri/target\n");
    const target = join(root, "src-tauri", "target");
    const output = join(root, "mutants.out", "backend");
    if (alias === "cache-parent-symlink") {
      await mkdir(target);
      await symlink(target, join(root, "mutants.out"));
    } else {
      await mkdir(output, { recursive: true });
    }
    if (alias === "cache-symlink") {
      await mkdir(target);
      await symlink(target, join(output, "cargo-target"));
    } else if (alias === "target-aliases-cache-ancestor") {
      await symlink(output, target);
    }
    const before = await stat(target, { bigint: true });
    const result = run(root, environment({ bin, state }));
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Mutation cache.*(?:unsafe ancestor|aliases src-tauri\/target)/u);
    assert.equal(
      (await stat(target, { bigint: true })).mtimeNs,
      before.mtimeNs,
      "cache preparation modified the aliased live target",
    );
    assert.equal(existsSync(join(state, "started")), false, "Cargo spawned with an aliased cache");
    assert.equal(existsSync(join(root, fence)), false, "cache refusal retained an unspawned fence");
    if (alias !== "cache-symlink")
      assert.equal(
        existsSync(join(output, "cargo-target")),
        false,
        "cache preparation created a directory inside the live target alias",
      );
  });
}

test("a temporary directory inside the checkout is refused before snapshot creation", async () => {
  const { root, bin, state } = await fixture();
  const temporary = join(root, "temporary");
  await mkdir(temporary);
  const result = run(root, { ...environment({ bin, state }), TMPDIR: temporary });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /temporary directory outside the checkout/u);
  assert.deepEqual(await readdir(temporary), [], "snapshot appeared inside whole-tree gate scans");
  assert.equal(existsSync(join(state, "started")), false);
  assert.equal(existsSync(join(root, fence)), false);
});
