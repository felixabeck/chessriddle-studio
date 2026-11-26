import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
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

async function writeListedFile(root, listedPath, source) {
  const fullPath = join(root, listedPath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, source);
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

test("rejects single-line direct Popover, Modal, and ActionIcon value imports", async () => {
  for (const [name, pattern] of [
    ["Popover", /direct Popover import; use AppPopover instead/],
    ["Modal", /direct Modal import; use AppModal instead/],
    ["ActionIcon", /direct ActionIcon import; use IconAction instead/],
  ]) {
    const result = await runChecker("src/App.tsx", (root) =>
      writeListedFile(root, "src/App.tsx", `import { Button, ${name} } from "@mantine/core";\n`),
    );

    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, pattern);
  }
});

test("rejects multi-line direct Popover, Modal, and ActionIcon value imports", async () => {
  for (const [name, pattern] of [
    ["Popover", /direct Popover import; use AppPopover instead/],
    ["Modal", /direct Modal import; use AppModal instead/],
    ["ActionIcon", /direct ActionIcon import; use IconAction instead/],
  ]) {
    const result = await runChecker("src/App.tsx", (root) =>
      writeListedFile(
        root,
        "src/App.tsx",
        `import {\n  Button,\n  ${name},\n  Text,\n} from "@mantine/core";\n`,
      ),
    );

    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, pattern);
  }
});

test("allows multi-line imports with type Modal and type Popover specifiers", async () => {
  const result = await runChecker("src/App.tsx", (root) =>
    writeListedFile(
      root,
      "src/App.tsx",
      'import {\n  Button,\n  type ActionIcon,\n  type Modal,\n  type Popover,\n} from "@mantine/core";\n',
    ),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});

test("allows import type { Popover } and PopoverProps", async () => {
  const result = await runChecker("src/App.tsx", (root) =>
    writeListedFile(
      root,
      "src/App.tsx",
      'import type { Popover } from "@mantine/core";\nimport { PopoverProps } from "@mantine/core";\n',
    ),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});

test("allows exempt wrapper files and theme.ts to import their wrapped components", async () => {
  for (const [listedPath, source] of [
    ["src/components/common/AppPopover.tsx", 'import {\n  Popover,\n} from "@mantine/core";\n'],
    ["src/components/common/AppModal.tsx", 'import { Modal } from "@mantine/core";\n'],
    ["src/components/common/IconAction.tsx", 'import {\n  ActionIcon,\n} from "@mantine/core";\n'],
    ["src/styles/theme.ts", 'import {\n  ActionIcon,\n  Popover,\n} from "@mantine/core";\n'],
  ]) {
    const result = await runChecker(listedPath, (root) =>
      writeListedFile(root, listedPath, source),
    );

    assert.equal(result.status, 0, `${listedPath}: ${result.stderr}`);
    assert.equal(result.error, undefined);
  }
});

test("rejects direct _blank target outside ExternalLink.tsx", async () => {
  for (const [label, source] of [
    [
      "JSX attribute",
      'export const A = () => <a href="https://example.com" target="_blank">x</a>;\n',
    ],
    ["object literal", 'export const props = { target: "_blank" };\n'],
  ]) {
    const result = await runChecker("src/components/Example.tsx", (root) =>
      writeListedFile(root, "src/components/Example.tsx", source),
    );

    assert.notEqual(result.status, 0, label);
    assert.match(
      result.stderr,
      /direct _blank target; use ExternalLink or externalLinkProps from src\/components\/common\/ExternalLink\.tsx/,
    );
  }
});

test("allows _blank target inside ExternalLink.tsx", async () => {
  const result = await runChecker("src/components/common/ExternalLink.tsx", (root) =>
    writeListedFile(
      root,
      "src/components/common/ExternalLink.tsx",
      'export const props = { target: "_blank" as const };\n',
    ),
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
});
