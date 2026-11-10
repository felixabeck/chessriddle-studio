import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fencePath, mutationCacheRelativePath } from "./run-backend-mutation.mjs";
import {
  CARGO_LOCK_FILES,
  FLOCK_HELD_EXIT_CODE,
  IDLE_MAX_AGE_MS,
  OWN_CHECKOUT_CAP_BYTES,
  REMOVER_FAILURE_EXIT_CODE,
  UNIT_MTIME_CHILDREN,
  allocatedBytes,
  checkLockFile,
  evictRustTargets,
  scanSameUserExecutables,
} from "./rust-target-eviction.mjs";

const GIT_IDENTITY = Object.freeze([
  "-c",
  "user.name=ChessFable Fixture",
  "-c",
  "user.email=fixture@chessfable.test",
]);

function linuxFixtureSkip() {
  if (process.platform !== "linux") return "linux-only fixtures";
  if (!existsSync("/proc")) return "/proc is absent";
  const flock = spawnSync("flock", ["-V"], { encoding: "utf8" });
  if (flock.error || (flock.status !== 0 && flock.status !== null)) return "flock is absent";
  const dir = mkdtempSync(join(tmpdir(), "evict-exec-"));
  const probe = join(dir, "probe");
  writeFileSync(probe, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = spawnSync(probe, { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  if (result.error || result.status !== 0) return "os.tmpdir() is noexec";
  return undefined;
}

const linuxSkip = linuxFixtureSkip();
const skipAsRoot =
  process.getuid?.() === 0 ? "unremovable-entry fixture is skipped as root (CR-1)" : undefined;

function linuxTest(name, fn) {
  test(name, linuxSkip ? { skip: linuxSkip } : {}, fn);
}

function forceRemoveTree(root) {
  spawnSync("chmod", ["-R", "u+rwx", root], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}

function git(cwd, args) {
  const result = spawnSync("git", [...GIT_IDENTITY, ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  return result;
}

function waitUntil(predicate, timeoutMs = 3_000, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    const spin = Date.now() + 10;
    while (Date.now() < spin) {
      // Short spin so flock and /proc/exe probes become visible.
    }
  }
  const extra = typeof message === "function" ? message() : message;
  assert.fail(
    extra ? `timed out after ${timeoutMs} ms; ${extra}` : `timed out after ${timeoutMs} ms`,
  );
}

function stamp(path, mtimeMs) {
  const time = new Date(mtimeMs);
  utimesSync(path, time, time);
}

function stampUnit(unit, mtimeMs) {
  stamp(unit, mtimeMs);
  for (const child of UNIT_MTIME_CHILDREN) {
    const path = join(unit, child);
    if (existsSync(path)) stamp(path, mtimeMs);
  }
}

function writeLocks(unit) {
  for (const name of CARGO_LOCK_FILES) writeFileSync(join(unit, name), "");
}

function makeUnit(targetRoot, relativeUnit, { files, mtimeMs } = {}) {
  const unit = join(targetRoot, relativeUnit);
  mkdirSync(unit, { recursive: true });
  writeLocks(unit);
  for (const [relativePath, contents] of Object.entries(
    files ?? { "deps/artifact": "artifact\n" },
  )) {
    const path = join(unit, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  if (mtimeMs !== undefined) stampUnit(unit, mtimeMs);
  return unit;
}

function lockInodes(unit) {
  return Object.fromEntries(
    CARGO_LOCK_FILES.map((name) => {
      const stat = lstatSync(join(unit, name), { bigint: true });
      return [name, `${stat.dev}:${stat.ino}`];
    }),
  );
}

function artifactIntact(unit) {
  return existsSync(join(unit, "deps", "artifact"));
}

function twoCheckouts(t) {
  const parent = mkdtempSync(join(tmpdir(), "evict-wt-"));
  t.after(() => forceRemoveTree(parent));
  const main = join(parent, "main");
  const sibling = join(parent, "sibling");
  mkdirSync(main);
  git(main, ["init", "--quiet"]);
  writeFileSync(join(main, "README"), "fixture\n");
  git(main, ["add", "README"]);
  git(main, ["commit", "-q", "-m", "init"]);
  git(main, ["worktree", "add", "--quiet", sibling]);
  mkdirSync(join(main, "src-tauri"), { recursive: true });
  mkdirSync(join(sibling, "src-tauri"), { recursive: true });
  return { parent, main, sibling };
}

async function runEvict(cwd, options = {}) {
  const lines = [];
  const result = await evictRustTargets({
    cwd,
    log: (line) => lines.push(line),
    ...options,
  });
  return { ...result, lines };
}

async function holdLock(lockPath, t) {
  const held = String(FLOCK_HELD_EXIT_CODE);
  const child = spawn(
    "flock",
    ["-n", "-E", held, lockPath, "sh", "-c", "echo ready; exec sleep 60"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  });
  try {
    await new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const finish = (reason, code = child.exitCode, signal = child.signalCode) => {
        clearTimeout(timer);
        child.stdout.off("data", onStdout);
        child.stderr.off("data", onStderr);
        child.off("close", onClose);
        child.off("error", onError);
        if (reason) {
          reject(
            new assert.AssertionError({
              message: `lock holder for ${lockPath}: ${reason} (exit code=${code}, signal=${signal}, stderr=${JSON.stringify(stderr)})`,
            }),
          );
        } else {
          resolve();
        }
      };
      const onStdout = (chunk) => {
        stdout += chunk;
        if (stdout.includes("ready")) finish();
      };
      const onStderr = (chunk) => {
        stderr += chunk;
      };
      const onClose = (code, signal) => finish("exited before signalling ready", code, signal);
      const onError = (error) => finish(`failed before signalling ready: ${error.message}`);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish("timed out after 60000 ms waiting for ready, SIGKILL requested");
      }, 60_000);
      child.stdout.setEncoding("utf8").on("data", onStdout);
      child.stderr.setEncoding("utf8").on("data", onStderr);
      child.once("close", onClose);
      child.once("error", onError);
    });
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  assert.equal(
    spawnSync("flock", ["-n", "-E", held, lockPath, "true"]).status,
    FLOCK_HELD_EXIT_CODE,
    `lock holder signalled ready but confirming probe did not find ${lockPath} held`,
  );
  return child;
}

function writeFlockStub(dir, status) {
  const path = join(dir, `flock-exit-${status}`);
  writeFileSync(path, `#!/bin/sh\nexit ${status}\n`, { mode: 0o755 });
  return path;
}

const DELETED_EXE_SUFFIX = " (deleted)";

function normalizeExeTarget(exePath) {
  return exePath.endsWith(DELETED_EXE_SUFFIX)
    ? exePath.slice(0, -DELETED_EXE_SUFFIX.length)
    : exePath;
}

function isStrictlyInside(inner, outer) {
  const innerParts = inner.split(sep).filter(Boolean);
  const outerParts = outer.split(sep).filter(Boolean);
  if (innerParts.length <= outerParts.length) return false;
  return outerParts.every((part, index) => innerParts[index] === part);
}

function resolveScannedExe(exePath) {
  const spelled = normalizeExeTarget(exePath);
  try {
    return realpathSync(spelled);
  } catch (error) {
    return error && error.code === "ENOENT" ? spelled : undefined;
  }
}

function productSeesExeInside(containerPath) {
  const container = realpathSync(containerPath);
  const scan = scanSameUserExecutables();
  if (scan.undetermined) return false;
  return scan.executables.some((exe) => {
    const canonical = resolveScannedExe(exe);
    return canonical !== undefined && isStrictlyInside(canonical, container);
  });
}

function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close === -1) return undefined;
    return stat.slice(close + 1).trimStart()[0];
  } catch {
    return undefined;
  }
}

function childStillAlive(child) {
  if (child.exitCode !== null) return false;
  try {
    process.kill(child.pid, 0);
  } catch {
    return false;
  }
  const state = procState(child.pid);
  return state !== undefined && state !== "Z";
}

function describeInUseProbe(child) {
  const pid = child.pid;
  let exe = "unread";
  try {
    exe = readlinkSync(`/proc/${pid}/exe`);
  } catch (error) {
    exe = `error ${error.code ?? error.message}`;
  }
  let procUid = "unread";
  try {
    procUid = String(lstatSync(`/proc/${pid}`).uid);
  } catch (error) {
    procUid = `error ${error.code ?? error.message}`;
  }
  let inProc = "unread";
  try {
    inProc = String(readdirSync("/proc").includes(String(pid)));
  } catch (error) {
    inProc = `error ${error.code ?? error.message}`;
  }
  const scan = scanSameUserExecutables();
  const sleeping = (scan.executables ?? []).filter((path) => path.includes("sleeping-bin"));
  return [
    `uid=${process.getuid()}`,
    `pid=${pid}`,
    `exitCode=${child.exitCode}`,
    `state=${procState(pid) ?? "gone"}`,
    `exe=${exe}`,
    `procUid=${procUid}`,
    `inProc=${inProc}`,
    `undetermined=${scan.undetermined ?? ""}`,
    `sleeping=${sleeping.join(",")}`,
  ].join(" ");
}

function waitUntilProductSeesCopiedExe(containerPath, child) {
  waitUntil(
    () => {
      if (!childStillAlive(child)) assert.fail(describeInUseProbe(child));
      return productSeesExeInside(containerPath);
    },
    3_000,
    () => describeInUseProbe(child),
  );
  assert.equal(child.exitCode, null, describeInUseProbe(child));
  assert.doesNotThrow(() => process.kill(child.pid, 0), describeInUseProbe(child));
}

function startCopiedSleep(unit, t, staleMs) {
  // uutils coreutils (Ubuntu 26.04) dispatches on the executable's file name, so the copy must be named sleep.
  const exe = join(unit, "deps", "sleeping-bin", "sleep");
  mkdirSync(join(unit, "deps", "sleeping-bin"), { recursive: true });
  const source = existsSync("/usr/bin/sleep") ? "/usr/bin/sleep" : "/bin/sleep";
  copyFileSync(source, exe);
  chmodSync(exe, 0o755);
  const child = spawn(exe, ["60"], { stdio: "ignore" });
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  });
  child.unref();
  stampUnit(unit, staleMs);
  waitUntilProductSeesCopiedExe(unit, child);
  return { child, exe };
}

function writeHook(dir, name, source) {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

function fillAllocated(unit, minimum) {
  const payload = join(unit, "deps", "blob");
  mkdirSync(join(unit, "deps"), { recursive: true });
  let size = 4096;
  while (allocatedBytes(unit) < minimum) {
    writeFileSync(payload, Buffer.alloc(size, 1));
    size *= 2;
    if (size > 32 * 1024 * 1024) break;
  }
  return allocatedBytes(unit);
}

const PAYLOAD_MIN_BYTES = 4n * 1024n * 1024n;
const CAP_MARGIN_BYTES = 64n * 1024n;

function dump(result) {
  return result.lines.join("\n");
}

function skipUnitInteriors(units) {
  return (path) => {
    for (const unit of units) {
      if (path === unit) return false;
      if (!path.startsWith(`${unit}${sep}`)) continue;
      return !CARGO_LOCK_FILES.includes(relative(unit, path));
    }
    return false;
  };
}

function capAboveRemainder(root, units) {
  return allocatedBytes(root, { skip: skipUnitInteriors(units) }) + CAP_MARGIN_BYTES;
}

function capToEvictUnit(root, unit) {
  return allocatedBytes(root) - allocatedBytes(unit) + CAP_MARGIN_BYTES;
}

function makeSparse(path, apparentSize) {
  const fd = openSync(path, "w");
  ftruncateSync(fd, apparentSize);
  closeSync(fd);
  const stat = lstatSync(path, { bigint: true });
  assert.ok(
    stat.blocks * 512n < stat.size,
    "sparse fixture allocated bytes must be below apparent size (CR-6)",
  );
  return stat;
}

function injectedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

test("shipped cap and idle constants keep their measurement basis", () => {
  // Goes red against a stub that ships a different cap or idle window.
  assert.equal(OWN_CHECKOUT_CAP_BYTES, 40n * 1024n ** 3n);
  assert.equal(IDLE_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
  assert.equal(FLOCK_HELD_EXIT_CODE, 75);
  assert.equal(REMOVER_FAILURE_EXIT_CODE, 2);
  assert.notEqual(REMOVER_FAILURE_EXIT_CODE, FLOCK_HELD_EXIT_CODE);
});

test("exported mutation fence and cache constants stay aligned (CR-4)", () => {
  assert.equal(fencePath, "mutants.out/backend/.mutation-in-progress");
  assert.equal(mutationCacheRelativePath, "mutants.out/backend/cargo-target");
});

linuxTest("discovery walks real git worktrees and ignores missing or prunable paths", async (t) => {
  // Goes red against a stub that evicts only the own checkout or throws on a missing listing.
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const ownTarget = join(main, "src-tauri", "target");
  const siblingTarget = join(sibling, "src-tauri", "target");
  const ownUnit = makeUnit(ownTarget, "debug", { mtimeMs: stale });
  const siblingUnit = makeUnit(siblingTarget, "debug", { mtimeMs: stale });
  const vanished = join(parent, "vanished");
  git(main, ["worktree", "add", "--quiet", vanished]);
  rmSync(vanished, { recursive: true, force: true });
  const result = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    ownCapBytes: OWN_CHECKOUT_CAP_BYTES,
  });
  assert.equal(result.exitCode, 0, dump(result));
  assert.ok(artifactIntact(ownUnit), "own checkout is not idle-evicted");
  assert.equal(artifactIntact(siblingUnit), false, dump(result));
  assert.ok(
    result.lines.some((line) => line.startsWith(`evicted ${realpathSync(siblingUnit)} `)),
    dump(result),
  );
});

linuxTest("idle rule keeps a unit when any one mtime signal is fresh", async (t) => {
  // Goes red against a mutant that reads only the unit directory mtime.
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const fresh = now - 1_000;
  const justUnder = now - idleMaxAgeMs + 1_000;
  const justOver = now - idleMaxAgeMs - 1_000;
  const signals = ["unit", ...UNIT_MTIME_CHILDREN];
  for (const signal of signals) {
    const target = join(sibling, "src-tauri", "target");
    rmSync(target, { recursive: true, force: true });
    const files = {
      "deps/artifact": "artifact\n",
      ".fingerprint/x": "fp\n",
      "build/x": "build\n",
      "incremental/x": "inc\n",
    };
    const unit = makeUnit(target, "debug", { files, mtimeMs: stale });
    if (signal === "unit") stamp(unit, fresh);
    else stamp(join(unit, signal), fresh);
    const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    assert.equal(result.exitCode, 0, `${signal}\n${dump(result)}`);
    assert.ok(artifactIntact(unit), `${signal} fresh must keep the unit`);
    assert.ok(
      result.lines.some((line) => line.includes(`skipped ${realpathSync(unit)} reason=not idle`)),
      `${signal}\n${dump(result)}`,
    );
  }

  const justUnderUnit = makeUnit(join(sibling, "src-tauri", "target"), "release", {
    mtimeMs: justUnder,
  });
  const justUnderResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.ok(artifactIntact(justUnderUnit), dump(justUnderResult));
  assert.ok(
    justUnderResult.lines.some((line) => line.includes("reason=not idle")),
    dump(justUnderResult),
  );

  const justOverUnit = makeUnit(join(sibling, "src-tauri", "target"), "llvm-cov-target/debug", {
    mtimeMs: justOver,
  });
  const justOverResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.equal(artifactIntact(justOverUnit), false, dump(justOverResult));
  assert.ok(
    justOverResult.lines.some((line) => line.startsWith(`evicted ${realpathSync(justOverUnit)} `)),
    dump(justOverResult),
  );
});

linuxTest("idle rule handles a unit without incremental and without build", async (t) => {
  // Goes red against a stub that treats an absent optional child as undetermined.
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const fresh = now - 1_000;
  for (const [missing, files] of [
    ["incremental", { "deps/artifact": "artifact\n", "build/x": "b\n", ".fingerprint/x": "f\n" }],
    ["build", { "deps/artifact": "artifact\n", "incremental/x": "i\n", ".fingerprint/x": "f\n" }],
  ]) {
    const target = join(sibling, "src-tauri", "target");
    rmSync(target, { recursive: true, force: true });
    const staleUnit = makeUnit(target, "debug", { files, mtimeMs: stale });
    const staleResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    assert.equal(staleResult.exitCode, 0, missing);
    assert.equal(artifactIntact(staleUnit), false, `${missing} absent still evicts when backdated`);

    rmSync(target, { recursive: true, force: true });
    const freshUnit = makeUnit(target, "debug", { files, mtimeMs: fresh });
    const freshResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    assert.equal(freshResult.exitCode, 0, missing);
    assert.ok(artifactIntact(freshUnit), `${missing} absent keeps a fresh unit`);
  }
});

linuxTest(
  "in-use executable keeps a unit under both rules, including prefix and symlink ancestors",
  async (t) => {
    // Goes red against a stub that matches path prefixes as strings or skips the executable test.
    const { parent, main, sibling } = twoCheckouts(t);
    const now = 1_700_000_000_000;
    const idleMaxAgeMs = 10_000;
    const stale = now - idleMaxAgeMs - 5_000;
    const siblingTarget = join(sibling, "src-tauri", "target");
    const unit = makeUnit(siblingTarget, "debug", { mtimeMs: stale });
    const { child: inUseChild } = startCopiedSleep(unit, t, stale);
    const inUse = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    const inUseDiag = `${dump(inUse)}\n${describeInUseProbe(inUseChild)}`;
    assert.equal(inUse.exitCode, 0, inUseDiag);
    assert.ok(artifactIntact(unit), inUseDiag);
    assert.ok(
      inUse.lines.some((line) =>
        line.includes(`skipped ${realpathSync(unit)} reason=in use (executable)`),
      ),
      inUseDiag,
    );

    const outside = join(parent, "outside-bin");
    mkdirSync(join(outside, "sleeping-bin"), { recursive: true });
    const outsideExe = join(outside, "sleeping-bin", "sleep");
    copyFileSync(existsSync("/usr/bin/sleep") ? "/usr/bin/sleep" : "/bin/sleep", outsideExe);
    chmodSync(outsideExe, 0o755);
    const outsideChild = spawn(outsideExe, ["60"], { stdio: "ignore" });
    t.after(() => outsideChild.kill("SIGKILL"));
    outsideChild.unref();
    waitUntilProductSeesCopiedExe(outside, outsideChild);
    const other = makeUnit(siblingTarget, "release", { mtimeMs: stale });
    const outsideResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    const outsideDiag = `${dump(outsideResult)}\n${describeInUseProbe(outsideChild)}`;
    assert.equal(outsideResult.exitCode, 0, outsideDiag);
    assert.equal(artifactIntact(other), false, outsideDiag);

    const prefixUnit = makeUnit(siblingTarget, "debug2", { mtimeMs: stale });
    const { child: prefixChild } = startCopiedSleep(prefixUnit, t, stale);
    const siblingName = makeUnit(siblingTarget, "debug2-extra", { mtimeMs: stale });
    // The running exe lives in debug2; debug2-extra only shares a name prefix.
    const prefixResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    const prefixDiag = `${dump(prefixResult)}\n${describeInUseProbe(prefixChild)}`;
    assert.ok(artifactIntact(prefixUnit), prefixDiag);
    assert.equal(artifactIntact(siblingName), false, prefixDiag);

    const linkedParent = join(parent, "link-to-main");
    symlinkSync(main, linkedParent);
    const ownTarget = join(main, "src-tauri", "target");
    const ownUnit = makeUnit(ownTarget, "debug", { mtimeMs: stale });
    const { child: ownChild } = startCopiedSleep(ownUnit, t, stale);
    const viaLink = await runEvict(linkedParent, {
      nowMs: now,
      idleMaxAgeMs,
      ownCapBytes: 1n,
    });
    const viaDiag = `${dump(viaLink)}\n${describeInUseProbe(ownChild)}`;
    assert.ok(artifactIntact(ownUnit), viaDiag);
    assert.ok(
      viaLink.lines.some((line) => line.includes("in use (executable)")),
      viaDiag,
    );
  },
);

linuxTest("both lock and executable report the lock reason (CR-4)", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  await holdLock(join(unit, ".cargo-lock"), t);
  const { child: lockChild } = startCopiedSleep(unit, t, stale);
  const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.ok(artifactIntact(unit), `${dump(result)}\n${describeInUseProbe(lockChild)}`);
  assert.ok(
    result.lines.some((line) =>
      line.includes(`skipped ${realpathSync(unit)} reason=in use (lock held)`),
    ),
    dump(result),
  );
  assert.ok(!result.lines.some((line) => line.includes("in use (executable)")), dump(result));
});

linuxTest("deleted exe suffix is compared without the suffix (CR-2)", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  const canonical = realpathSync(unit);
  const result = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    readdirProc: () => ["424242"],
    lstatProc: (path) => {
      if (path.endsWith(`${sep}424242`)) return { uid: BigInt(process.getuid()) };
      return lstatSync(path, { bigint: true });
    },
    readlinkExe: (path) => {
      if (path.endsWith(`${sep}exe`)) return `${canonical}/deps/artifact (deleted)`;
      return readlinkSync(path);
    },
  });
  assert.ok(artifactIntact(unit));
  assert.ok(result.lines.some((line) => line.includes("in use (executable)")));
});

linuxTest("size cap evicts largest-first and leaves non-unit content", async (t) => {
  // Goes red against a stub that idle-evicts the own checkout or removes non-unit files.
  const { main, sibling } = twoCheckouts(t);
  const root = join(main, "src-tauri", "target");
  const large = makeUnit(root, "debug");
  const medium = makeUnit(root, "release");
  const small = makeUnit(root, "llvm-cov-target/debug");
  fillAllocated(large, PAYLOAD_MIN_BYTES);
  fillAllocated(medium, PAYLOAD_MIN_BYTES / 2n);
  fillAllocated(small, PAYLOAD_MIN_BYTES / 8n);
  mkdirSync(join(root, "doc"), { recursive: true });
  writeFileSync(join(root, "doc", "index.html"), "docs\n");
  writeFileSync(join(root, "CACHEDIR.TAG"), "tag\n");
  const shared = join(root, "shared-blob");
  writeFileSync(shared, Buffer.alloc(64_000, 2));
  linkSync(shared, join(root, "shared-blob-link"));
  const cap = capToEvictUnit(root, large);
  const result = await runEvict(main, { ownCapBytes: cap });
  assert.equal(artifactIntact(large), false, dump(result));
  assert.ok(artifactIntact(medium), dump(result));
  assert.ok(artifactIntact(small), dump(result));
  assert.ok(existsSync(join(root, "doc", "index.html")), dump(result));
  assert.ok(existsSync(join(root, "CACHEDIR.TAG")), dump(result));
  assert.ok(
    result.lines.some((line) => line.startsWith(`total ${realpathSync(root)} bytes=`)),
    dump(result),
  );

  const foreign = makeUnit(join(sibling, "src-tauri", "target"), "debug");
  fillAllocated(foreign, PAYLOAD_MIN_BYTES);
  stampUnit(foreign, Date.now());
  const foreignResult = await runEvict(main, {
    ownCapBytes: cap,
    nowMs: Date.now(),
    idleMaxAgeMs: 10_000,
  });
  assert.ok(
    artifactIntact(foreign),
    `a recent oversize foreign unit is kept\n${dump(foreignResult)}`,
  );
  assert.ok(
    foreignResult.lines.some((line) =>
      line.includes(`skipped ${realpathSync(foreign)} reason=not idle`),
    ),
    dump(foreignResult),
  );
});

linuxTest("sparse allocated size does not trip the cap (CR-6, F7a)", async (t) => {
  // Goes red if size used st.size: a 1 GiB sparse file would exceed the 64 MiB cap.
  const { main } = twoCheckouts(t);
  const root = join(main, "src-tauri", "target");
  const unit = makeUnit(root, "debug");
  makeSparse(join(unit, "deps", "artifact"), 1024 ** 3);
  const cap = 64n * 1024n ** 2n;
  const result = await runEvict(main, { ownCapBytes: cap });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.ok(existsSync(join(unit, "deps", "artifact")));
  assert.ok(result.lines.some((line) => line.includes("reason=under the cap")));
});

test("hard links count once across independently measured directories (F7b)", () => {
  const parent = mkdtempSync(join(tmpdir(), "evict-hardlink-"));
  try {
    const fileOnly = join(parent, "file-only");
    const withLink = join(parent, "with-link");
    mkdirSync(fileOnly);
    mkdirSync(withLink);
    const payload = Buffer.alloc(64_000, 7);
    writeFileSync(join(fileOnly, "blob"), payload);
    writeFileSync(join(withLink, "blob"), payload);
    linkSync(join(withLink, "blob"), join(withLink, "blob-link"));
    assert.equal(
      allocatedBytes(withLink),
      allocatedBytes(fileOnly),
      "a second hard link must not add another copy of the file's allocated bytes",
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

linuxTest(
  "unreachable cap evicts nothing, including fenced and undetermined units (CR-6)",
  async (t) => {
    const { main } = twoCheckouts(t);
    const root = join(main, "src-tauri", "target");
    const evictable = makeUnit(root, "debug");
    const undetermined = makeUnit(root, "release");
    mkdirSync(join(root, "doc"), { recursive: true });
    writeFileSync(join(root, "doc", "huge"), Buffer.alloc(200_000, 3));
    const cacheRoot = join(main, mutationCacheRelativePath);
    const fenced = makeUnit(cacheRoot, "debug");
    mkdirSync(dirname(join(main, fencePath)), { recursive: true });
    writeFileSync(join(main, fencePath), "fence\n");
    const cap = 4096n;
    const result = await runEvict(main, {
      ownCapBytes: cap,
      checkLocks(lockPaths, options) {
        if (lockPaths.some((path) => path.includes(`${sep}release${sep}`))) {
          return { undetermined: "injected flock 42" };
        }
        for (const lockPath of lockPaths) {
          const status = checkLockFile(lockPath, options);
          if (status.undetermined || status.held) return status;
        }
        return { held: false };
      },
    });
    assert.equal(result.exitCode, 1, result.lines.join("\n"));
    assert.ok(artifactIntact(evictable));
    assert.ok(artifactIntact(undetermined));
    assert.ok(artifactIntact(fenced));
    assert.ok(existsSync(join(root, "doc", "huge")));
    assert.ok(
      result.lines.some((line) => line.startsWith(`unreachable cap ${realpathSync(root)} `)),
      dump(result),
    );
    assert.ok(
      result.lines.some((line) =>
        line.includes(`skipped ${realpathSync(undetermined)} undetermined:`),
      ),
      dump(result),
    );
    assert.ok(
      result.lines.some((line) =>
        line.includes(`skipped ${realpathSync(fenced)} reason=mutation fence`),
      ),
      dump(result),
    );
  },
);

linuxTest("an in-use unit alone can keep the root over the cap", async (t) => {
  const { main } = twoCheckouts(t);
  const root = join(main, "src-tauri", "target");
  const pinned = makeUnit(root, "debug");
  fillAllocated(pinned, PAYLOAD_MIN_BYTES);
  await holdLock(join(pinned, ".cargo-lock"), t);
  const extra = makeUnit(root, "release");
  const cap = 4096n;
  const result = await runEvict(main, { ownCapBytes: cap });
  assert.equal(result.exitCode, 1, dump(result));
  assert.ok(artifactIntact(pinned), dump(result));
  assert.ok(artifactIntact(extra), dump(result));
  assert.ok(
    result.lines.some((line) => line.includes("unreachable cap")),
    dump(result),
  );
});

linuxTest("a re-check in-use skip continues with the next-largest unit", async (t) => {
  const { main, parent } = twoCheckouts(t);
  const root = join(main, "src-tauri", "target");
  const largest = makeUnit(root, "debug");
  const next = makeUnit(root, "release");
  fillAllocated(largest, PAYLOAD_MIN_BYTES);
  fillAllocated(next, PAYLOAD_MIN_BYTES / 2n);
  const cap = capAboveRemainder(root, [largest, next]);
  const pidFile = join(parent, "pinned.pid");
  const hook = writeHook(
    parent,
    "after-lock.mjs",
    `import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export function afterLock(unitPath) {
  if (unitPath !== process.env.EVICT_TEST_PIN) return;
  const exe = join(unitPath, "deps", "sleeping-bin", "sleep");
  mkdirSync(join(unitPath, "deps", "sleeping-bin"), { recursive: true });
  const source = existsSync("/usr/bin/sleep") ? "/usr/bin/sleep" : "/bin/sleep";
  copyFileSync(source, exe);
  chmodSync(exe, 0o755);
  const child = spawn(exe, ["60"], { stdio: "ignore" });
  child.unref();
  writeFileSync(process.env.EVICT_TEST_PID, String(child.pid));
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      if (readlinkSync("/proc/" + child.pid + "/exe").includes("sleeping-bin")) return;
    } catch {
      // The process is not yet visible in /proc.
    }
  }
  throw new Error("pin process executable is not visible");
}
`,
  );
  t.after(() => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid) process.kill(pid, "SIGKILL");
    } catch {
      // The pin process never started or already exited.
    }
  });
  const result = await runEvict(main, {
    ownCapBytes: cap,
    afterLockModule: hook,
    env: {
      ...process.env,
      EVICT_TEST_PIN: realpathSync(largest),
      EVICT_TEST_PID: pidFile,
    },
  });
  assert.equal(result.exitCode, 1, dump(result));
  assert.ok(artifactIntact(largest), dump(result));
  assert.equal(artifactIntact(next), false, dump(result));
  assert.ok(
    result.lines.some((line) => line.includes("unreachable cap")),
    dump(result),
  );
});

linuxTest("own checkout is never idle-evicted", async (t) => {
  const { main } = twoCheckouts(t);
  const unit = makeUnit(join(main, "src-tauri", "target"), "debug", {
    mtimeMs: 1_000_000,
  });
  const result = await runEvict(main, { nowMs: Date.now(), idleMaxAgeMs: 10_000 });
  assert.ok(artifactIntact(unit));
  assert.ok(result.lines.some((line) => line.includes("reason=under the cap")));
});

linuxTest("each lock file, fence, in-use, and symlink skip leaves contents intact", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  for (const lockName of CARGO_LOCK_FILES) {
    const target = join(sibling, "src-tauri", "target");
    rmSync(target, { recursive: true, force: true });
    const unit = makeUnit(target, "debug", { mtimeMs: stale });
    await holdLock(join(unit, lockName), t);
    const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    assert.ok(artifactIntact(unit), `${lockName}\n${dump(result)}`);
    assert.ok(
      result.lines.some((line) =>
        line.includes(`skipped ${realpathSync(unit)} reason=in use (lock held)`),
      ),
      `${lockName}\n${dump(result)}`,
    );
  }

  const cache = join(sibling, mutationCacheRelativePath);
  const fenced = makeUnit(cache, "debug", { mtimeMs: stale });
  mkdirSync(dirname(join(sibling, fencePath)), { recursive: true });
  writeFileSync(join(sibling, fencePath), "fence\n");
  const fenceResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.ok(artifactIntact(fenced));
  assert.ok(fenceResult.lines.some((line) => line.includes("reason=mutation fence")));

  const external = join(parent, "external-target");
  mkdirSync(external, { recursive: true });
  const hiddenUnit = makeUnit(external, "debug", { mtimeMs: stale });
  mkdirSync(join(sibling, "src-tauri"), { recursive: true });
  rmSync(join(sibling, "src-tauri", "target"), { recursive: true, force: true });
  symlinkSync(external, join(sibling, "src-tauri", "target"));
  const rootResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.ok(artifactIntact(hiddenUnit));
  assert.ok(rootResult.lines.some((line) => line.includes("reason=symlink")));

  const siblingTarget = join(sibling, "src-tauri", "target");
  rmSync(siblingTarget, { recursive: true, force: true });
  mkdirSync(siblingTarget, { recursive: true });
  const realUnit = join(parent, "real-unit");
  makeUnit(dirname(realUnit), "real-unit", { mtimeMs: stale });
  symlinkSync(realUnit, join(siblingTarget, "debug"));
  const unitResult = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.ok(existsSync(join(realUnit, "deps", "artifact")));
  assert.ok(unitResult.lines.some((line) => line.includes("reason=symlink")));
});

linuxTest("locks stay held during removal and keep their inodes (CR-2, CR-3)", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  const before = lockInodes(unit);
  const probe = join(parent, "lock-probe.json");
  const hook = writeHook(
    parent,
    "during-removal.mjs",
    `import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
export function duringRemoval(_unitPath, lockPaths) {
  const results = lockPaths.map((lock) => ({
    lock,
    status: spawnSync("flock", ["-n", "-E", "${FLOCK_HELD_EXIT_CODE}", lock, "true"]).status,
  }));
  writeFileSync(process.env.EVICT_LOCK_PROBE, JSON.stringify(results));
}
`,
  );
  const result = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    duringRemovalModule: hook,
    env: { ...process.env, EVICT_LOCK_PROBE: probe },
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.equal(artifactIntact(unit), false);
  const probed = JSON.parse(readFileSync(probe, "utf8"));
  assert.equal(probed.length, CARGO_LOCK_FILES.length);
  for (const entry of probed) assert.equal(entry.status, FLOCK_HELD_EXIT_CODE);
  assert.deepEqual(lockInodes(unit), before);
});

linuxTest("re-check seams keep a refreshed, in-use, or newly fenced unit (CR-4)", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const target = join(sibling, "src-tauri", "target");
  const unit = makeUnit(target, "debug", { mtimeMs: stale });
  const beforeLock = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    async beforeLock(unitPath) {
      if (unitPath === unit) stampUnit(unitPath, now);
    },
  });
  assert.ok(artifactIntact(unit), beforeLock.lines.join("\n"));
  assert.ok(beforeLock.lines.some((line) => line.includes("reason=not idle")));

  stampUnit(unit, stale);
  const afterLockHook = writeHook(
    parent,
    "after-lock-refresh.mjs",
    `import { utimesSync } from "node:fs";
export function afterLock(unitPath, job) {
  const time = new Date(job.nowMs);
  utimesSync(unitPath, time, time);
}
`,
  );
  const afterLock = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    afterLockModule: afterLockHook,
  });
  assert.ok(artifactIntact(unit), afterLock.lines.join("\n"));

  stampUnit(unit, stale);
  const fenceHook = writeHook(
    parent,
    "after-lock-fence.mjs",
    `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
export function afterLock(_unitPath, job) {
  const path = join(job.checkoutPath, job.fenceRelative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "fence\\n");
}
`,
  );
  const cacheUnit = makeUnit(join(sibling, mutationCacheRelativePath), "debug", { mtimeMs: stale });
  const fenced = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    afterLockModule: fenceHook,
  });
  assert.ok(artifactIntact(cacheUnit), fenced.lines.join("\n"));
});

test(
  "fingerprint-first stop rule leaves remaining entries (CR-1)",
  skipAsRoot || linuxSkip ? { skip: skipAsRoot || linuxSkip } : {},
  async (t) => {
    const { main, sibling } = twoCheckouts(t);
    const now = 1_700_000_000_000;
    const idleMaxAgeMs = 10_000;
    const stale = now - idleMaxAgeMs - 5_000;
    const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", {
      files: {
        "deps/artifact": "artifact\n",
        ".fingerprint/x": "fp\n",
        "build/x": "build\n",
      },
      mtimeMs: stale,
    });
    chmodSync(join(unit, ".fingerprint"), 0o555);
    t.after(() => {
      try {
        chmodSync(join(unit, ".fingerprint"), 0o755);
      } catch {
        // Restored or already removed.
      }
    });
    const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    assert.equal(result.exitCode, 1);
    assert.ok(existsSync(join(unit, ".fingerprint", "x")));
    assert.ok(existsSync(join(unit, "deps", "artifact")));
    assert.ok(existsSync(join(unit, "build", "x")));
    assert.ok(
      result.lines.some((line) => line.startsWith(`failed ${realpathSync(unit)}:`)),
      dump(result),
    );
    assert.ok(!result.lines.some((line) => line.includes("contents intact")));
  },
);

test(
  "second-pass unremovable entry leaves fingerprint gone and fails the unit (CR-1)",
  skipAsRoot || linuxSkip ? { skip: skipAsRoot || linuxSkip } : {},
  async (t) => {
    const { main, sibling } = twoCheckouts(t);
    const now = 1_700_000_000_000;
    const idleMaxAgeMs = 10_000;
    const stale = now - idleMaxAgeMs - 5_000;
    const first = makeUnit(join(sibling, "src-tauri", "target"), "debug", {
      files: { "deps/artifact": "artifact\n", ".fingerprint/x": "fp\n" },
      mtimeMs: stale,
    });
    const second = makeUnit(join(sibling, "src-tauri", "target"), "release", { mtimeMs: stale });
    chmodSync(join(first, "deps"), 0o555);
    t.after(() => {
      try {
        chmodSync(join(first, "deps"), 0o755);
      } catch {
        // Restored or already removed.
      }
    });
    const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
    assert.equal(result.exitCode, 1, result.lines.join("\n"));
    assert.equal(existsSync(join(first, ".fingerprint")), false);
    assert.ok(existsSync(join(first, "deps", "artifact")));
    assert.equal(artifactIntact(second), false);
    assert.ok(
      result.lines.some((line) => line.startsWith(`failed ${realpathSync(first)}:`)),
      dump(result),
    );
    assert.ok(
      result.lines.some((line) => line.startsWith(`evicted ${realpathSync(second)} `)),
      dump(result),
    );
    assert.ok(result.lines.some((line) => line.includes("partial removal")));
  },
);

linuxTest("an inner symlink is removed as a link and the external tree stays", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const external = join(parent, "external-tree");
  mkdirSync(external);
  writeFileSync(join(external, "keep"), "keep\n");
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  symlinkSync(external, join(unit, "out-link"));
  stampUnit(unit, stale);
  const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.equal(existsSync(join(unit, "out-link")), false);
  assert.equal(readFileSync(join(external, "keep"), "utf8"), "keep\n");
});

linuxTest("fail-direction skips keep contents and exit 1", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const resetUnit = () => {
    const target = join(sibling, "src-tauri", "target");
    rmSync(target, { recursive: true, force: true });
    rmSync(join(sibling, "mutants.out"), { recursive: true, force: true });
    return makeUnit(target, "debug", { mtimeMs: stale });
  };

  let unit = resetUnit();
  const flockExit = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    checkLocks: () => ({ undetermined: "flock exit 42" }),
  });
  assert.equal(flockExit.exitCode, 1);
  assert.ok(artifactIntact(unit));

  unit = resetUnit();
  const sizeWalk = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    allocatedBytes() {
      throw injectedError("EIO", "injected size walk");
    },
  });
  assert.equal(sizeWalk.exitCode, 1);
  assert.ok(artifactIntact(unit));

  unit = resetUnit();
  const cacheUnit = makeUnit(join(sibling, mutationCacheRelativePath), "debug", { mtimeMs: stale });
  const fenceError = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    lstat(path, options) {
      if (path.endsWith(fencePath)) throw injectedError("EIO", "injected fence");
      return lstatSync(path, options);
    },
  });
  assert.equal(fenceError.exitCode, 1);
  assert.ok(artifactIntact(cacheUnit));

  unit = resetUnit();
  const procList = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    procRoot: join(sibling, "missing-proc"),
  });
  assert.equal(procList.exitCode, 1);
  assert.ok(artifactIntact(unit));

  unit = resetUnit();
  const missingFlock = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    flockBinary: join(sibling, "no-such-flock"),
  });
  assert.equal(missingFlock.exitCode, 1);
  assert.ok(artifactIntact(unit));

  unit = resetUnit();
  const statAccess = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    readdirProc: () => ["424242"],
    lstatProc: (path, options) => {
      if (path.endsWith(`${sep}424242`)) throw injectedError("EACCES", "injected stat");
      return lstatSync(path, options);
    },
  });
  assert.equal(statAccess.exitCode, 1);
  assert.ok(artifactIntact(unit));

  unit = resetUnit();
  const ownRoot = join(main, "src-tauri", "target");
  const ownListed = makeUnit(ownRoot, "debug");
  fillAllocated(ownListed, PAYLOAD_MIN_BYTES);
  const listing = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    ownCapBytes: capToEvictUnit(ownRoot, ownListed),
    listCheckouts: (cwd) => ({
      error: "injected listing",
      checkouts: [{ path: cwd, prunable: false }],
    }),
  });
  assert.equal(listing.exitCode, 1, dump(listing));
  assert.ok(
    listing.lines.some((line) => line.startsWith("worktree listing failed:")),
    dump(listing),
  );
  assert.ok(
    artifactIntact(unit),
    `a sibling omitted from the fallback listing stays intact\n${dump(listing)}`,
  );
  assert.equal(artifactIntact(ownListed), false, dump(listing));
  assert.ok(
    listing.lines.some((line) => line.startsWith(`total ${realpathSync(ownRoot)} bytes=`)),
    dump(listing),
  );
});

linuxTest("ENOENT, ESRCH and exe EACCES still evict an otherwise idle unit", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const cases = [
    ["exe EACCES", "EACCES", "exe"],
    ["exe ENOENT", "ENOENT", "exe"],
    ["exe ESRCH", "ESRCH", "exe"],
    ["stat ENOENT", "ENOENT", "stat"],
    ["stat ESRCH", "ESRCH", "stat"],
  ];
  for (const [label, code, kind] of cases) {
    const target = join(sibling, "src-tauri", "target");
    rmSync(target, { recursive: true, force: true });
    const unit = makeUnit(target, "debug", { mtimeMs: stale });
    const result = await runEvict(main, {
      nowMs: now,
      idleMaxAgeMs,
      readdirProc: () => ["424242"],
      lstatProc: (path, options) => {
        if (kind === "stat" && path.endsWith(`${sep}424242`)) throw injectedError(code, label);
        if (path.endsWith(`${sep}424242`)) return { uid: BigInt(process.getuid()) };
        return lstatSync(path, options);
      },
      readlinkExe: (path) => {
        if (kind === "exe" && path.endsWith(`${sep}exe`)) throw injectedError(code, label);
        return readlinkSync(path);
      },
    });
    assert.equal(result.exitCode, 0, `${label}\n${result.lines.join("\n")}`);
    assert.equal(artifactIntact(unit), false, label);
  }
});

linuxTest("post-loop re-walk failure is undetermined with no total line (CR-5)", async (t) => {
  const { main } = twoCheckouts(t);
  const unit = makeUnit(join(main, "src-tauri", "target"), "debug");
  const result = await runEvict(main, {
    measureRootAfterEviction() {
      throw injectedError("EIO", "injected re-walk");
    },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(artifactIntact(unit));
  assert.ok(
    result.lines.some(
      (line) => line.includes("undetermined") && line.includes("cannot measure total"),
    ),
  );
  assert.ok(!result.lines.some((line) => line.startsWith("total ")));
});

linuxTest("top-level errors exit 1 and name the checkout (CR-5)", async (t) => {
  const { main } = twoCheckouts(t);
  const result = await runEvict(main, {
    listCheckouts() {
      const error = new Error("injected top-level");
      error.location = main;
      throw error;
    },
  });
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines.some((line) => line === `error ${main}: injected top-level`));
});

linuxTest("failed git worktree list still processes the own checkout (F1)", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const root = join(main, "src-tauri", "target");
  const ownUnit = makeUnit(root, "debug");
  fillAllocated(ownUnit, PAYLOAD_MIN_BYTES);
  const siblingUnit = makeUnit(join(sibling, "src-tauri", "target"), "debug", {
    mtimeMs: 1_000_000,
  });
  const result = await runEvict(main, {
    git: join(parent, "no-such-git"),
    ownCapBytes: capToEvictUnit(root, ownUnit),
  });
  assert.equal(result.exitCode, 1, dump(result));
  assert.ok(
    result.lines.some((line) => line.startsWith("worktree listing failed:")),
    dump(result),
  );
  assert.ok(
    result.lines.some((line) => line.startsWith(`total ${realpathSync(root)} bytes=`)),
    dump(result),
  );
  assert.equal(artifactIntact(ownUnit), false, dump(result));
  assert.ok(artifactIntact(siblingUnit), dump(result));
});

linuxTest("units three levels below a root are found and four levels are not (F2)", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const target = join(sibling, "src-tauri", "target");
  const three = makeUnit(target, "a/b/c", { mtimeMs: stale });
  const four = makeUnit(target, "w/x/y/z", { mtimeMs: stale });
  const result = await runEvict(main, { nowMs: now, idleMaxAgeMs });
  assert.equal(artifactIntact(three), false, result.lines.join("\n"));
  assert.ok(artifactIntact(four), result.lines.join("\n"));
  assert.ok(result.lines.some((line) => line.startsWith(`evicted ${realpathSync(three)} `)));
  assert.ok(!result.lines.some((line) => line.includes(realpathSync(four))));
});

linuxTest("a throw during eviction of one unit still evicts the next (F3)", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const target = join(sibling, "src-tauri", "target");
  const first = makeUnit(target, "debug", { mtimeMs: stale });
  const second = makeUnit(target, "release", { mtimeMs: stale });
  const firstCanonical = realpathSync(first);
  const seen = new Set();
  const result = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    allocatedBytes(path, extra) {
      if (path === first || path === firstCanonical) {
        if (seen.has("first")) throw injectedError("EIO", "injected during eviction");
        seen.add("first");
      }
      return allocatedBytes(path, extra);
    },
  });
  assert.equal(result.exitCode, 1, result.lines.join("\n"));
  assert.ok(artifactIntact(first));
  assert.equal(artifactIntact(second), false);
  assert.ok(
    result.lines.some((line) =>
      line.startsWith(`skipped ${firstCanonical} undetermined: evict ${firstCanonical}:`),
    ),
  );
  assert.ok(result.lines.some((line) => line.startsWith(`evicted ${realpathSync(second)} `)));
});

linuxTest("realpath failures skip a unit or abort the cwd (F4)", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  const other = makeUnit(join(sibling, "src-tauri", "target"), "release", { mtimeMs: stale });
  const unitCanonical = realpathSync(unit);
  const unitResult = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    realpath(path) {
      if (path === unit || path === unitCanonical) {
        throw injectedError("EIO", "injected realpath unit");
      }
      return realpathSync(path);
    },
  });
  assert.equal(unitResult.exitCode, 1, unitResult.lines.join("\n"));
  assert.ok(artifactIntact(unit));
  assert.equal(artifactIntact(other), false);
  assert.ok(
    unitResult.lines.some((line) => line.startsWith(`skipped ${unitCanonical} undetermined:`)),
  );

  const cwdUnit = makeUnit(join(main, "src-tauri", "target"), "debug");
  fillAllocated(cwdUnit, 80_000n);
  const cwdResult = await runEvict(main, {
    realpath(path) {
      if (path === main) throw injectedError("EIO", "injected realpath cwd");
      return realpathSync(path);
    },
  });
  assert.equal(cwdResult.exitCode, 1, cwdResult.lines.join("\n"));
  assert.ok(
    cwdResult.lines.some(
      (line) => line === `error ${main}: realpath ${main}: injected realpath cwd`,
    ),
  );
  assert.ok(artifactIntact(cwdUnit));
  assert.ok(!cwdResult.lines.some((line) => line.startsWith("evicted ")));
  assert.ok(!cwdResult.lines.some((line) => line.startsWith("total ")));
});

linuxTest("checkLockFile maps flock 42 to undetermined and 75 to held (F7c)", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const lockPath = join(parent, "probe.lock");
  writeFileSync(lockPath, "");
  const exit42 = writeFlockStub(parent, 42);
  const exitHeld = writeFlockStub(parent, FLOCK_HELD_EXIT_CODE);
  assert.deepEqual(checkLockFile(lockPath, { flockBinary: exit42 }), {
    undetermined: `flock ${lockPath} exit 42`,
  });
  assert.deepEqual(checkLockFile(lockPath, { flockBinary: exitHeld }), { held: true });

  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  const result = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    flockBinary: exit42,
  });
  assert.equal(result.exitCode, 1, result.lines.join("\n"));
  assert.ok(artifactIntact(unit));
  assert.ok(result.lines.some((line) => line.includes("undetermined:")));
});

linuxTest(
  "own-root total measurement failure still reports each evictable unit (F8)",
  async (t) => {
    const { main } = twoCheckouts(t);
    const root = join(main, "src-tauri", "target");
    const debug = makeUnit(root, "debug");
    const release = makeUnit(root, "release");
    const canonicalRoot = realpathSync(root);
    const result = await runEvict(main, {
      allocatedBytes(path, extra) {
        if (path === root || path === canonicalRoot) {
          throw injectedError("EIO", "injected own-root total");
        }
        return allocatedBytes(path, extra);
      },
    });
    assert.equal(result.exitCode, 1, result.lines.join("\n"));
    assert.ok(artifactIntact(debug));
    assert.ok(artifactIntact(release));
    assert.ok(result.lines.some((line) => line.startsWith(`undetermined ${canonicalRoot}:`)));
    assert.ok(
      result.lines.some((line) => line.startsWith(`skipped ${realpathSync(debug)} undetermined:`)),
    );
    assert.ok(
      result.lines.some((line) =>
        line.startsWith(`skipped ${realpathSync(release)} undetermined:`),
      ),
    );
  },
);

linuxTest("exe realpath EIO is undetermined; deleted ENOENT stays in use (G1)", async (t) => {
  const { parent, main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  const alias = join(parent, "exe-alias");
  symlinkSync(join(unit, "deps", "artifact"), alias);
  const eioResult = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    readdirProc: () => ["424242"],
    lstatProc: (path) => {
      if (path.endsWith(`${sep}424242`)) return { uid: BigInt(process.getuid()) };
      return lstatSync(path, { bigint: true });
    },
    readlinkExe: (path) => {
      if (path.endsWith(`${sep}exe`)) return alias;
      return readlinkSync(path);
    },
    realpath(path) {
      if (path === alias) throw injectedError("EIO", "injected realpath exe");
      return realpathSync(path);
    },
  });
  assert.equal(eioResult.exitCode, 1, eioResult.lines.join("\n"));
  assert.ok(artifactIntact(unit));
  assert.ok(
    eioResult.lines.some(
      (line) =>
        line.startsWith(`skipped ${realpathSync(unit)} undetermined:`) &&
        line.includes(`realpath ${alias}: injected realpath exe`),
    ),
  );

  const goneUnit = makeUnit(join(sibling, "src-tauri", "target"), "release", { mtimeMs: stale });
  const gone = `${realpathSync(goneUnit)}/deps/gone`;
  const enoentResult = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    readdirProc: () => ["424242"],
    lstatProc: (path) => {
      if (path.endsWith(`${sep}424242`)) return { uid: BigInt(process.getuid()) };
      return lstatSync(path, { bigint: true });
    },
    readlinkExe: (path) => {
      if (path.endsWith(`${sep}exe`)) return `${gone} (deleted)`;
      return readlinkSync(path);
    },
  });
  assert.equal(enoentResult.exitCode, 0, enoentResult.lines.join("\n"));
  assert.ok(artifactIntact(goneUnit));
  assert.ok(
    enoentResult.lines.some((line) =>
      line.includes(`skipped ${realpathSync(goneUnit)} reason=in use (executable)`),
    ),
  );
});

linuxTest("remainder and in-loop total failures skip remaining evictable units (G2)", async (t) => {
  const { main } = twoCheckouts(t);
  const root = join(main, "src-tauri", "target");
  const debug = makeUnit(root, "debug");
  const release = makeUnit(root, "release");
  fillAllocated(debug, PAYLOAD_MIN_BYTES);
  fillAllocated(release, PAYLOAD_MIN_BYTES / 2n);
  const canonicalRoot = realpathSync(root);
  const debugCanonical = realpathSync(debug);
  const releaseCanonical = realpathSync(release);
  const cap = capAboveRemainder(root, [debug, release]);

  const remainder = await runEvict(main, {
    ownCapBytes: cap,
    allocatedBytes(path, extra) {
      if ((path === root || path === canonicalRoot) && extra?.skip) {
        throw injectedError("EIO", "injected remainder");
      }
      return allocatedBytes(path, extra);
    },
  });
  assert.equal(remainder.exitCode, 1, dump(remainder));
  assert.ok(artifactIntact(debug), dump(remainder));
  assert.ok(artifactIntact(release), dump(remainder));
  assert.ok(
    remainder.lines.some((line) => line.startsWith(`undetermined ${canonicalRoot}:`)),
    dump(remainder),
  );
  assert.ok(
    remainder.lines.some((line) => line.startsWith(`skipped ${debugCanonical} undetermined:`)),
    dump(remainder),
  );
  assert.ok(
    remainder.lines.some((line) => line.startsWith(`skipped ${releaseCanonical} undetermined:`)),
    dump(remainder),
  );

  let rootTotals = 0;
  const inLoop = await runEvict(main, {
    ownCapBytes: cap,
    allocatedBytes(path, extra) {
      if (path === root || path === canonicalRoot) {
        if (extra?.skip) return allocatedBytes(path, extra);
        rootTotals += 1;
        if (rootTotals >= 3) throw injectedError("EIO", "injected in-loop total");
      }
      return allocatedBytes(path, extra);
    },
  });
  assert.equal(inLoop.exitCode, 1, dump(inLoop));
  assert.equal(artifactIntact(debug), false, dump(inLoop));
  assert.ok(artifactIntact(release), dump(inLoop));
  assert.ok(
    inLoop.lines.some((line) => line.startsWith(`evicted ${debugCanonical} `)),
    dump(inLoop),
  );
  assert.ok(
    inLoop.lines.some((line) => line.startsWith(`skipped ${releaseCanonical} undetermined:`)),
    dump(inLoop),
  );
});

linuxTest("post-eviction size walk failure reports freed=unknown (G3)", async (t) => {
  const { main, sibling } = twoCheckouts(t);
  const now = 1_700_000_000_000;
  const idleMaxAgeMs = 10_000;
  const stale = now - idleMaxAgeMs - 5_000;
  const unit = makeUnit(join(sibling, "src-tauri", "target"), "debug", { mtimeMs: stale });
  const unitCanonical = realpathSync(unit);
  let unitCalls = 0;
  const result = await runEvict(main, {
    nowMs: now,
    idleMaxAgeMs,
    allocatedBytes(path, extra) {
      if (path === unit || path === unitCanonical) {
        unitCalls += 1;
        if (unitCalls >= 3) throw injectedError("EIO", "injected post-eviction size");
      }
      return allocatedBytes(path, extra);
    },
  });
  assert.equal(result.exitCode, 0, result.lines.join("\n"));
  assert.equal(artifactIntact(unit), false);
  assert.ok(result.lines.some((line) => line === `evicted ${unitCanonical} freed=unknown`));
});
