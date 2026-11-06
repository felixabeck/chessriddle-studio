import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerSource = join(projectRoot, "scripts/install-local.sh");

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture(
  t,
  { productName = "ChessRiddle Studio", binaryName = "chessriddle-studio" } = {},
) {
  const base = await mkdtemp(join(tmpdir(), "chessfable-install-"));
  const childRuns = [];
  t.after(async () => {
    for (const { child } of childRuns) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await Promise.allSettled(childRuns.map(({ result }) => result));
    await rm(base, { recursive: true, force: true });
  });
  const repo = join(base, "repo");
  const remote = join(base, "remote.git");
  const install = join(base, "install with spaces");
  const data = join(base, "data");
  const bin = join(base, "bin");
  await mkdir(join(repo, "scripts"), { recursive: true });
  await mkdir(join(repo, "src-tauri/target/release/sound"), { recursive: true });
  await mkdir(join(repo, "src-tauri/icons"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await cp(installerSource, join(repo, "scripts/install-local.sh"));
  await chmod(join(repo, "scripts/install-local.sh"), 0o755);
  await writeFile(
    join(repo, "src-tauri/tauri.conf.json"),
    JSON.stringify({ mainBinaryName: binaryName, productName }),
  );
  await writeFile(join(repo, "src-tauri/target/release", binaryName), "#!/bin/sh\nexit 0\n");
  await chmod(join(repo, "src-tauri/target/release", binaryName), 0o755);
  await writeFile(join(repo, "src-tauri/target/release/sound/move.mp3"), "sound");
  await writeFile(join(repo, "src-tauri/icons/icon.png"), "icon");
  await writeFile(join(repo, ".gitignore"), "/src-tauri/target/\n");
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.name", "Installer Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");
  execFileSync("git", ["init", "--bare", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "master");
  await writeFile(
    join(bin, "cp"),
    `#!/bin/sh
if [ -n "$INSTALL_CP_SEEN" ]; then /usr/bin/touch "$INSTALL_CP_SEEN"; fi
if [ "$INSTALL_BARRIER" = after-snapshot ]; then
  /usr/bin/touch "${join(base, "barrier-ready")}"
  while [ ! -e "${join(base, "barrier-release")}" ]; do /usr/bin/sleep 0.01; done
fi
if [ "$INSTALL_FAILURE" = copy ]; then echo "forced cp failure" >&2; exit 71; fi
exec /usr/bin/cp "$@"
`,
  );
  await writeFile(
    join(bin, "mv"),
    `#!/bin/sh
src=""; target=""
for arg do src="$target"; target="$arg"; done
marker="${join(base, "current-failed")}" 
if [ "$INSTALL_FAILURE" = promotion-collision ]; then
  case "$src" in
    */.staging-*)
      /usr/bin/mkdir -p "$target"
      echo foreign > "$target/foreign"
      ;;
  esac
fi
case "$INSTALL_FAILURE:$src:$target" in
  current-link:*.current-new-*:*/current)
    if [ ! -e "$marker" ]; then /usr/bin/touch "$marker"; echo "forced current mv failure" >&2; exit 72; fi ;;
  restore-previous:*.current-new-*:*/current)
    if [ ! -e "$marker" ]; then /usr/bin/touch "$marker"; echo "forced current mv failure" >&2; exit 72; fi ;;
  restore-previous:*.previous-new-*:*/previous)
    if [ -e "$marker" ]; then echo "forced previous restoration failure" >&2; exit 73; fi ;;
  desktop:*:*/${binaryName}.desktop) echo "forced desktop mv failure" >&2; exit 74 ;;
esac
/usr/bin/mv "$@"
mv_status="$?"
if [ "$mv_status" -ne 0 ]; then exit "$mv_status"; fi
if [ "$INSTALL_FAILURE" = interrupt-after-promotion ] && echo "$src" | /usr/bin/grep -q '/.staging-'; then
  kill -TERM "$PPID"
fi
if [ "$INSTALL_FAILURE" = interrupt-after-current-publication ] && [ "$target" = "${join(install, "current")}" ]; then
  kill -TERM "$PPID"
fi
`,
  );
  await writeFile(
    join(bin, "rm"),
    `#!/bin/sh
case "$INSTALL_FAILURE:$*" in
  retire-stale:*superseded.desktop*) echo "forced rm failure" >&2; exit 75 ;;
esac
exec /usr/bin/rm "$@"
`,
  );
  await writeFile(
    join(bin, "flock"),
    '#!/bin/sh\nif [ -n "$INSTALL_FLOCK_SEEN" ]; then /usr/bin/touch "$INSTALL_FLOCK_SEEN"; fi\nexec /usr/bin/flock "$@"\n',
  );
  await chmod(join(bin, "cp"), 0o755);
  await chmod(join(bin, "mv"), 0o755);
  await chmod(join(bin, "rm"), 0o755);
  await chmod(join(bin, "flock"), 0o755);
  return { base, repo, install, data, bin, productName, binaryName, childRuns };
}

async function seedPointers(install) {
  const releases = join(install, "releases");
  const a = join(releases, "A");
  const b = join(releases, "B");
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  await symlink(a, join(install, "current"));
  await symlink(b, join(install, "previous"));
  return { a, b };
}

function run({ repo, install, data, bin }, failure, extraArgs = ["--no-build", "--force"]) {
  return spawnSync("bash", [join(repo, "scripts/install-local.sh"), ...extraArgs], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      CHESSFABLE_INSTALL_DIR: install,
      XDG_DATA_HOME: data,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_FAILURE: failure ?? "",
    },
  });
}

function spawnRun(_t, { repo, install, data, bin, base, childRuns }, options = {}) {
  const child = spawn("bash", [join(repo, "scripts/install-local.sh"), "--no-build", "--force"], {
    cwd: repo,
    detached: true,
    env: {
      ...process.env,
      CHESSFABLE_INSTALL_DIR: install,
      XDG_DATA_HOME: data,
      PATH: `${bin}:${process.env.PATH}`,
      INSTALL_FAILURE: options.failure ?? "",
      INSTALL_BARRIER: options.barrier ? "after-snapshot" : "",
      INSTALL_CP_SEEN: options.cpSeen ?? "",
      INSTALL_FLOCK_SEEN: options.flockSeen ?? "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const runState = {
    child,
    result: new Promise((resolveResult, rejectResult) => {
      child.on("error", rejectResult);
      child.on("close", (status, signal) => resolveResult({ status, signal, stdout, stderr }));
    }),
    ready: join(base, "barrier-ready"),
    release: join(base, "barrier-release"),
  };
  childRuns.push(runState);
  return runState;
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  assert.fail(`timed out waiting for ${path}`);
}

async function provenanceLine(install) {
  const current = await readlink(join(install, "current"));
  const text = await readFile(join(current, "VERSION"), "utf8");
  const line = text.split("\n").find((entry) => entry.startsWith("provenance "));
  assert.ok(line, text);
  return line;
}

async function assertRefusedNothingInstalled(result, install, pattern) {
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, pattern);
  await assert.rejects(lstat(join(install, "current")), { code: "ENOENT" });
}

async function writePnpmStub(f, prelude = "", marker = "") {
  await writeFile(
    join(f.bin, "pnpm"),
    `#!/bin/sh
set -e
${prelude}
mkdir -p src-tauri/target/release/sound
printf '%s\\n' '#!/bin/sh' 'exit 0' > src-tauri/target/release/${f.binaryName}
${marker ? `printf '${marker}' >> src-tauri/target/release/${f.binaryName}` : ""}
chmod 755 src-tauri/target/release/${f.binaryName}
printf sound > src-tauri/target/release/sound/move.mp3
`,
  );
  await chmod(join(f.bin, "pnpm"), 0o755);
}

async function releaseNames(install) {
  return (await readdir(join(install, "releases"))).sort();
}

async function installerTemps({ install, data, binaryName }) {
  const rootEntries = await readdir(install);
  const releaseEntries = await readdir(join(install, "releases"));
  const applicationEntries = await readdir(join(data, "applications"));
  return [
    ...rootEntries.filter((name) => /^\.(current|previous)-new-/u.test(name)),
    ...releaseEntries.filter((name) => name.startsWith(".staging-")),
    ...applicationEntries.filter((name) => name.startsWith(`.${binaryName}.desktop.`)),
  ];
}

async function unmarkedRelease(install, name, commitCharacter) {
  const release = join(install, "releases", name);
  const short = name.slice(0, 7);
  const commit = commitCharacter.repeat(40);
  await mkdir(join(release, "bin"), { recursive: true });
  await mkdir(join(release, "lib/en-croissant/sound"), { recursive: true });
  await writeFile(join(release, "bin/en-croissant"), "#!/bin/sh\nexit 0\n");
  await chmod(join(release, "bin/en-croissant"), 0o755);
  await writeFile(join(release, "lib/en-croissant/sound/move.mp3"), "sound");
  await writeFile(join(release, "icon.png"), "icon");
  await writeFile(
    join(release, "VERSION"),
    `commit ${commit}\nshort ${short}\nsubject unmarked install\ninstalled 2026-09-01T01:01:01+02:00\nprovenance reviewed\n`,
  );
  return release;
}

test("installs the derived binary, resources, desktop entry and pointers", async (t) => {
  const f = await fixture(t);
  const { a } = await seedPointers(f.install);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const current = await readlink(join(f.install, "current"));
  assert.notEqual(current, a);
  assert.equal(await readlink(join(f.install, "previous")), a);
  await assert.rejects(lstat(join(current, "bin/en-croissant")), { code: "ENOENT" });
  assert.equal((await lstat(join(current, "bin/chessriddle-studio"))).isFile(), true);
  assert.equal(
    (await lstat(join(current, "lib/ChessRiddle Studio/sound/move.mp3"))).isFile(),
    true,
  );
  const desktop = await readFile(join(f.data, "applications/chessriddle-studio.desktop"), "utf8");
  assert.match(desktop, /Exec=".*install with spaces\/current\/bin\/chessriddle-studio"/u);
  assert.match(desktop, /Icon=.*install\\swith\\sspaces\/current\/icon\.png/u);
  assert.match(desktop, /^StartupWMClass=chessriddle-studio$/mu);
  assert.match(desktop, /^Name=ChessRiddle Studio$/mu);
  assert.match(desktop, /^Categories=Game;BoardGame;$/mu);
  assert.match(desktop, /^StartupNotify=true$/mu);
  assert.match(desktop, /^GenericName=Chess analysis and database$/mu);
  assert.match(desktop, /^Comment=Analyse games, search databases, play against engines$/mu);
  assert.match(desktop, /^GenericName\[de\]=Schachanalyse und Datenbank$/mu);
  assert.match(
    desktop,
    /^Comment\[de\]=Partien analysieren, Datenbanken durchsuchen, gegen Engines spielen$/mu,
  );
  assert.match(
    await readFile(join(current, ".chessriddle-studio-managed-release"), "utf8"),
    /^ChessRiddle Studio local installer release v1\ninvocation \.staging-[A-Za-z0-9]{8}\n$/u,
  );
  assert.equal((await lstat(join(f.install, ".install.lock"))).isFile(), true);
  assert.equal(await provenanceLine(f.install), "provenance UNREVIEWED (prebuilt binary, --force)");
  assert.deepEqual(await releaseNames(f.install), ["A", "B", current.split("/").at(-1)].sort());
  assert.deepEqual(await installerTemps(f), []);
});

test("defaults the install root to HOME/.local/opt/chessriddle-studio when CHESSFABLE_INSTALL_DIR is unset", async (t) => {
  const f = await fixture(t);
  const home = join(f.base, "home");
  await mkdir(home, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: f.data,
    PATH: `${f.bin}:${process.env.PATH}`,
    INSTALL_FAILURE: "",
  };
  delete env.CHESSFABLE_INSTALL_DIR;
  const result = spawnSync(
    "bash",
    [join(f.repo, "scripts/install-local.sh"), "--no-build", "--force"],
    {
      cwd: f.repo,
      encoding: "utf8",
      env,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const installRoot = join(home, ".local/opt/chessriddle-studio");
  const current = await readlink(join(installRoot, "current"));
  assert.ok(current.startsWith(`${installRoot}/`));
  assert.equal((await lstat(join(current, "bin/chessriddle-studio"))).isFile(), true);
  const desktop = await readFile(join(f.data, "applications/chessriddle-studio.desktop"), "utf8");
  assert.match(
    desktop,
    /Exec=".*\/\.local\/opt\/chessriddle-studio\/current\/bin\/chessriddle-studio"/u,
  );
  await assert.rejects(lstat(join(f.install, "current")), { code: "ENOENT" });
});

test("names resources after productName and the launcher after the binary", async (t) => {
  const f = await fixture(t, { productName: "KnightDesk", binaryName: "knightdesk" });
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const current = await readlink(join(f.install, "current"));
  assert.equal((await lstat(join(current, "lib/KnightDesk/sound/move.mp3"))).isFile(), true);
  await assert.rejects(lstat(join(f.data, "applications/KnightDesk.desktop")), { code: "ENOENT" });
  const desktop = await readFile(join(f.data, "applications/knightdesk.desktop"), "utf8");
  assert.match(desktop, /^Name=KnightDesk$/mu);
  assert.match(desktop, /^StartupWMClass=knightdesk$/mu);
  assert.match(desktop, /Exec=".*\/current\/bin\/knightdesk"/u);
  assert.deepEqual(await installerTemps(f), []);
});

test("retires superseded desktop entries and preserves foreign ones", async (t) => {
  const f = await fixture(t);
  const applications = join(f.data, "applications");
  await mkdir(applications, { recursive: true });
  const superseded = join(applications, "superseded.desktop");
  const foreign = join(applications, "unrelated.desktop");
  const linked = join(applications, "linked.desktop");
  const target = join(f.base, "linked-source.desktop");
  await writeFile(
    superseded,
    `[Desktop Entry]\nType=Application\nName=Old\nExec="${f.install}/current/bin/old-binary"\n`,
  );
  await writeFile(foreign, "[Desktop Entry]\nType=Application\nName=Other\nExec=/usr/bin/other\n");
  await writeFile(
    target,
    `[Desktop Entry]\nType=Application\nName=Linked\nExec="${f.install}/current/bin/old-binary"\n`,
  );
  await symlink(target, linked);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(lstat(superseded), { code: "ENOENT" });
  assert.equal((await lstat(foreign)).isFile(), true);
  assert.equal((await lstat(linked)).isSymbolicLink(), true);
  assert.match(result.stdout, /retired superseded desktop entry .*superseded\.desktop/u);
  assert.equal((await lstat(join(applications, "chessriddle-studio.desktop"))).isFile(), true);
  assert.deepEqual(await installerTemps(f), []);
});

test("a failed retirement is reported without failing the completed install", async (t) => {
  const f = await fixture(t);
  const applications = join(f.data, "applications");
  await mkdir(applications, { recursive: true });
  const superseded = join(applications, "superseded.desktop");
  await writeFile(
    superseded,
    `[Desktop Entry]\nType=Application\nName=Old\nExec="${f.install}/current/bin/old-binary"\n`,
  );
  const result = run(f, "retire-stale");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /could not retire superseded desktop entry .*superseded\.desktop/u);
  assert.equal((await lstat(superseded)).isFile(), true);
  assert.equal((await lstat(join(applications, "chessriddle-studio.desktop"))).isFile(), true);
  assert.equal((await lstat(await readlink(join(f.install, "current")))).isDirectory(), true);
  assert.deepEqual(await installerTemps(f), []);
});

test("fresh install publishes current without inventing a previous release", async (t) => {
  const f = await fixture(t);
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await lstat(await readlink(join(f.install, "current")))).isDirectory(), true);
  await assert.rejects(lstat(join(f.install, "previous")), { code: "ENOENT" });
  assert.deepEqual(await installerTemps(f), []);
});

for (const failure of ["copy", "current-link", "interrupt-after-promotion"]) {
  test(`${failure} failure restores both original pointers and removes invocation files`, async (t) => {
    const f = await fixture(t);
    const { a, b } = await seedPointers(f.install);
    const result = run(f, failure);
    assert.notEqual(result.status, 0);
    assert.equal(await readlink(join(f.install, "current")), a);
    assert.equal(await readlink(join(f.install, "previous")), b);
    assert.deepEqual(await releaseNames(f.install), ["A", "B"]);
    if (failure === "current-link") {
      assert.match(result.stderr, /current publication failed; installed state will be restored/u);
    }
    assert.deepEqual(await installerTemps(f), []);
  });
}

test("desktop publication failure reports the committed install and rollback", async (t) => {
  const f = await fixture(t);
  const { a } = await seedPointers(f.install);
  const result = run(f, "desktop");
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /desktop publication failed after install committed/u);
  assert.match(result.stderr, /rollback=/u);
  assert.equal(await readlink(join(f.install, "previous")), a);
  assert.notEqual(await readlink(join(f.install, "current")), a);
  assert.deepEqual(await installerTemps(f), []);
});

test("interruption after current publication preserves the committed install and rollback", async (t) => {
  const f = await fixture(t);
  const { a, b } = await seedPointers(f.install);
  const result = run(f, "interrupt-after-current-publication");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /install interrupted after current publication/u);
  assert.match(result.stderr, /rollback=/u);
  const current = await readlink(join(f.install, "current"));
  assert.notEqual(current, a);
  assert.notEqual(current, b);
  assert.equal(await readlink(join(f.install, "previous")), a);
  assert.equal((await lstat(current)).isDirectory(), true);
  assert.deepEqual(await installerTemps(f), []);
});

test("reports a failure to restore the original previous pointer", async (t) => {
  const f = await fixture(t);
  await seedPointers(f.install);
  const result = run(f, "restore-previous");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restoration failure: could not restore original previous link/u);
  assert.deepEqual(await installerTemps(f), []);
});

test("does not delete a preexisting target when promotion fails", async (t) => {
  const f = await fixture(t);
  const result = run(f, "promotion-collision");
  assert.notEqual(result.status, 0, result.stderr);
  const releases = await releaseNames(f.install);
  assert.equal(releases.length, 1);
  assert.equal(
    await readFile(join(f.install, "releases", releases[0], "foreign"), "utf8"),
    "foreign\n",
  );
  assert.deepEqual(await installerTemps(f), []);
});

for (const failure of ["current-link", "interrupt-after-promotion"]) {
  test(`serializes a waiting successful install behind an earlier ${failure} failure`, async (t) => {
    const f = await fixture(t);
    const { a, b } = await seedPointers(f.install);
    const first = spawnRun(t, f, { failure, barrier: true });
    await waitForPath(first.ready);

    const secondSeen = join(f.base, "second-copy-seen");
    const secondFlockSeen = join(f.base, "second-flock-seen");
    const second = spawnRun(t, f, { cpSeen: secondSeen, flockSeen: secondFlockSeen });
    await waitForPath(secondFlockSeen);
    await assert.rejects(access(secondSeen), { code: "ENOENT" });
    await writeFile(first.release, "continue");

    const firstResult = await first.result;
    const secondResult = await second.result;
    assert.notEqual(firstResult.status, 0);
    assert.equal(secondResult.status, 0, secondResult.stderr);
    await waitForPath(secondSeen);
    const current = await readlink(join(f.install, "current"));
    assert.notEqual(current, a);
    assert.notEqual(current, b);
    assert.equal(await readlink(join(f.install, "previous")), a);
    assert.deepEqual(await releaseNames(f.install), ["A", "B", current.split("/").at(-1)].sort());
    assert.deepEqual(await installerTemps(f), []);
  });
}

test("retains only current and previous managed releases while preserving foreign siblings", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.install, "releases", "foreign-data"), { recursive: true });
  for (let installNumber = 0; installNumber < 4; installNumber += 1) {
    const result = run(f);
    assert.equal(result.status, 0, result.stderr);
  }
  const current = await readlink(join(f.install, "current"));
  const previous = await readlink(join(f.install, "previous"));
  assert.deepEqual(
    await releaseNames(f.install),
    ["foreign-data", current.split("/").at(-1), previous.split("/").at(-1)].sort(),
  );
});

test("leaves unmarked historical layouts in the install root as foreign siblings", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.install, "releases"), { recursive: true });
  const historical = await unmarkedRelease(f.install, "bbbbbbb-20260901T020202", "b");
  const foreign = join(f.install, "releases", "ccccccc-20260901T030303");
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, "VERSION"), "not installer provenance\n");

  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await lstat(historical)).isDirectory(), true);
  assert.equal((await lstat(foreign)).isDirectory(), true);
});

test("refuses an invalid productName or mainBinaryName", async (t) => {
  const spacedBinary = await fixture(t, {
    productName: "ChessRiddle Studio",
    binaryName: "chess riddle",
  });
  await assertRefusedNothingInstalled(
    run(spacedBinary),
    spacedBinary.install,
    /invalid product identity in tauri.conf.json/u,
  );

  const leadingSpace = await fixture(t, { productName: " ChessRiddle" });
  await assertRefusedNothingInstalled(
    run(leadingSpace),
    leadingSpace.install,
    /invalid product identity in tauri.conf.json/u,
  );

  const doubleSpace = await fixture(t, { productName: "ChessRiddle  Studio" });
  await assertRefusedNothingInstalled(
    run(doubleSpace),
    doubleSpace.install,
    /invalid product identity in tauri.conf.json/u,
  );
});

test("refuses dirty, unpushed and missing-upstream repositories", async (t) => {
  const dirty = await fixture(t);
  await writeFile(
    join(dirty.repo, "scripts/install-local.sh"),
    `${await readFile(installerSource, "utf8")}\n`,
  );
  const dirtyResult = run(dirty, undefined, ["--no-build"]);
  await assertRefusedNothingInstalled(
    dirtyResult,
    dirty.install,
    /the worktree has modified or untracked files/u,
  );

  const unpushed = await fixture(t);
  await writeFile(join(unpushed.repo, "new"), "new");
  git(unpushed.repo, "add", "new");
  git(unpushed.repo, "commit", "-m", "unpushed");
  const unpushedResult = run(unpushed, undefined, ["--no-build"]);
  await assertRefusedNothingInstalled(
    unpushedResult,
    unpushed.install,
    /not contained in origin\/master/u,
  );

  const missing = await fixture(t);
  git(missing.repo, "branch", "--unset-upstream");
  const missingResult = run(missing, undefined, ["--no-build"]);
  await assertRefusedNothingInstalled(
    missingResult,
    missing.install,
    /has no configured upstream/u,
  );
});

test("refuses to replace foreign current and previous files", async (t) => {
  for (const pointer of ["current", "previous"]) {
    const f = await fixture(t);
    await mkdir(f.install, { recursive: true });
    await writeFile(join(f.install, pointer), "foreign");
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${pointer} exists and is not a symlink`, "u"));
    assert.equal(await readFile(join(f.install, pointer), "utf8"), "foreign");
  }
});

test("refuses --no-build without --force on a clean tree", async (t) => {
  const f = await fixture(t);
  const result = run(f, undefined, ["--no-build"]);
  await assertRefusedNothingInstalled(result, f.install, /--no-build copies an unbound binary/u);
});

test("refuses an untracked non-ignored file without --force", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "stray.txt"), "stray");
  const result = run(f, undefined, ["--no-build"]);
  await assertRefusedNothingInstalled(
    result,
    f.install,
    /the worktree has modified or untracked files/u,
  );
});

test("records UNREVIEWED dirty provenance with --force and a stub build", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.repo, "scripts/install-local.sh"),
    `${await readFile(installerSource, "utf8")}\n`,
  );
  await writePnpmStub(f);
  const result = run(f, undefined, ["--force"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await provenanceLine(f.install), "provenance UNREVIEWED (dirty tree, --force)");
});

test("reviewed path requires this invocation's pnpm build marker", async (t) => {
  const f = await fixture(t);
  const marker = "PROVENANCE-BUILD-MARKER";
  await writePnpmStub(f, "", marker);
  const result = run(f, undefined, []);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await provenanceLine(f.install), "provenance reviewed");
  const current = await readlink(join(f.install, "current"));
  assert.match(await readFile(join(current, "bin", f.binaryName), "utf8"), new RegExp(marker, "u"));
});

test("refuses when a stub build writes an untracked file", async (t) => {
  const f = await fixture(t);
  await writePnpmStub(f, "printf stray > during-build.txt");
  const result = run(f, undefined, []);
  await assertRefusedNothingInstalled(result, f.install, /tree or HEAD changed during build/u);
});

const moveHeadPrelude = `printf extra > extra.txt
git add extra.txt
git commit -m extra
git push origin HEAD`;

test("refuses when a stub build moves HEAD onto @{upstream}", async (t) => {
  const f = await fixture(t);
  await writePnpmStub(f, moveHeadPrelude);
  const result = run(f, undefined, []);
  await assertRefusedNothingInstalled(result, f.install, /tree or HEAD changed during build/u);
});

test("records UNREVIEWED when --force and HEAD moves during build", async (t) => {
  const f = await fixture(t);
  await writePnpmStub(f, moveHeadPrelude);
  const result = run(f, undefined, ["--force"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await provenanceLine(f.install),
    "provenance UNREVIEWED (HEAD moved during build, --force)",
  );
});

test("never promotes a dirty --force build to reviewed after the stub reverts the file", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.repo, "scripts/install-local.sh"),
    `${await readFile(installerSource, "utf8")}\n`,
  );
  await writePnpmStub(f, "git checkout -- scripts/install-local.sh");
  const result = run(f, undefined, ["--force"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await provenanceLine(f.install), "provenance UNREVIEWED (dirty tree, --force)");
});

test("refuses when a stub build unsets upstream", async (t) => {
  const f = await fixture(t);
  await writePnpmStub(f, "git branch --unset-upstream");
  const result = run(f, undefined, []);
  await assertRefusedNothingInstalled(result, f.install, /has no configured upstream/u);
});
