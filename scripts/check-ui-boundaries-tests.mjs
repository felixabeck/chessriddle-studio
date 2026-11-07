import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import test, { after } from "node:test";
import { testTempRoots } from "./test-temp-root.mjs";

const temporaryRoot = testTempRoots(after);

const checker = join(process.cwd(), "scripts", "check-ui-boundaries.mjs");

async function runChecker(listedPath, prepare) {
  const root = await temporaryRoot("ui-boundaries-");
  const bin = join(root, "bin");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(bin);
  await prepare(root);

  const fakeGit = join(bin, "git");
  await writeFile(
    fakeGit,
    `#!/bin/sh
case "$*" in
  *"--others"*|*"--deleted"*) ;;
  *)
    case " $* " in
      *" -z "*) printf '%s\\000' '${listedPath}' ;;
      *) printf '%s\\n' '${listedPath}' ;;
    esac
    ;;
esac
`,
  );
  const fakeGitSource = await readFile(fakeGit, "utf8");
  assert.equal(fakeGitSource.includes("\0"), false);
  assert.ok(fakeGitSource.includes("printf '%s\\000'"));
  await chmod(fakeGit, 0o755);

  return spawnSync(process.execPath, [checker], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    },
  });
}

test("skips a source file removed by an uncommitted deletion", async () => {
  const result = await runChecker("src/missing.ts", async () => {});

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});

test("rethrows a source read failure that is not ENOENT", async () => {
  const result = await runChecker("src/unreadable.ts", async (root) => {
    await mkdir(join(root, "src", "unreadable.ts"));
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EISDIR/);
});

test("rejects an unlayered Mantine stylesheet import", async () => {
  const result = await runChecker("src/App.tsx", async (root) => {
    await writeFile(join(root, "src", "App.tsx"), 'import "@mantine/core/styles.css";\n');
  });

  assert.notEqual(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /unlayered Mantine stylesheet import '@mantine\/core\/styles\.css'; use @mantine\/core\/styles\.layer\.css/,
  );
});

test("accepts a layered Mantine stylesheet import", async () => {
  const result = await runChecker("src/App.tsx", async (root) => {
    await writeFile(join(root, "src", "App.tsx"), 'import "@mantine/core/styles.layer.css";\n');
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});

test("rejects an unlayered per-component Mantine stylesheet import", async () => {
  const result = await runChecker("src/App.tsx", async (root) => {
    await writeFile(join(root, "src", "App.tsx"), 'import "@mantine/core/styles/Button.css";\n');
  });

  assert.notEqual(result.status, 0, result.stderr);
  assert.match(
    result.stderr,
    /unlayered Mantine stylesheet import '@mantine\/core\/styles\/Button\.css'; use @mantine\/core\/styles\/Button\.layer\.css/,
  );
});

test("accepts a layered per-component Mantine stylesheet import", async () => {
  const result = await runChecker("src/App.tsx", async (root) => {
    await writeFile(
      join(root, "src", "App.tsx"),
      'import "@mantine/core/styles/Button.layer.css";\n',
    );
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});
