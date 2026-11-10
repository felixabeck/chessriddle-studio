import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { gitDiscoveryStderr, gitInit, gitTrack } from "./test-git-init.mjs";
import { testTempRoots } from "./test-temp-root.mjs";

const temporaryRoot = testTempRoots(afterAll);

const parserSeam = vi.hoisted(() => ({ parseTsSource: null }));

vi.mock("./parse-ts-source.mjs", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    parseTsSource(...args) {
      return parserSeam.parseTsSource
        ? parserSeam.parseTsSource(...args)
        : actual.parseTsSource(...args);
    },
  };
});

const { checkUntranslatedJsx, findLiterals, listSourceFiles } =
  await import("./check-untranslated-jsx.mjs");

// Vitest serves this module from a non-file URL, so `import.meta.dirname` is
// the only stable way to name the checker for a subprocess run.
const checkerPath = join(import.meta.dirname, "check-untranslated-jsx.mjs");

function assertCli(result, status, stderr) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(status);
  expect(result.stderr).toBe(stderr);
}

async function workspace() {
  const root = await temporaryRoot("untranslated-jsx-");
  mkdirSync(join(root, "src", "components"), { recursive: true });
  writeFileSync(join(root, "src", "components", "Tracked.tsx"), "<Text>Tracked copy</Text>;\n");
  writeFileSync(join(root, "src", "components", "Tracked.test.tsx"), "<Text>Test copy</Text>;\n");
  writeFileSync(join(root, "src", "components", "Untracked.tsx"), '<Text>{t("a")}</Text>;\n');
  gitInit(root);
  gitTrack(root, "src/components/Tracked.tsx", "src/components/Tracked.test.tsx");
  return root;
}

describe("untranslated UI literal gate", () => {
  test("uses the extracted parser result", async () => {
    const root = await workspace();
    parserSeam.parseTsSource = () => ({ type: "JSXText", value: "Parser sentinel" });
    try {
      expect(await checkUntranslatedJsx(root)).toEqual([
        'src/components/Tracked.tsx: "Parser sentinel"',
        'src/components/Untracked.tsx: "Parser sentinel"',
      ]);
    } finally {
      parserSeam.parseTsSource = null;
    }
  });

  test("preserves the parser error on an unparseable source", () => {
    let thrown;
    try {
      findLiterals("const = ;", "src/bad.tsx");
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.message).toBe(
      `${join(process.cwd(), "src/bad.tsx")}: Unexpected token (1:6)\n\n> 1 | const = ;\n    |       ^`,
    );
  });

  test("rejects data, ternary, native-dialog, notification, and dynamic aria literals", () => {
    const source = `
      <Select data={[{ value: "white", label: "White" }]} aria-label={enabled ? "Disable" : "Enable"} />;
      ask("Clear saved data", { title: "Clear data" });
      notifications.show({ title: "Logs", message: \`Opened logs in \${path}\` });
    `;
    expect(findLiterals(source)).toEqual(
      expect.arrayContaining([
        "White",
        "Disable",
        "Enable",
        "Clear saved data",
        "Clear data",
        "Logs",
      ]),
    );
  });

  test("permits translated calls and documented technical notation", () => {
    expect(findLiterals(`<Button aria-label={t("Common.Open")}>PGN</Button>`)).toEqual([]);
  });

  test("rejects proper names outside their dedicated metadata registry", () => {
    expect(findLiterals(`<Text>California</Text>`, "src/components/home/Welcome.tsx")).toEqual([
      "California",
    ]);
  });

  test("permits only the wordmark parts in the title bar", () => {
    const wordmark = `<span><span>Chess</span><span>Riddle</span> <span>Studio</span></span>`;
    expect(findLiterals(wordmark, "src/components/TopBar.tsx")).toEqual([]);
    expect(findLiterals(`<Text>Window</Text>`, "src/components/TopBar.tsx")).toEqual(["Window"]);
    expect(findLiterals(wordmark, "src/components/home/Welcome.tsx")).toEqual([
      "Chess",
      "Riddle",
      "Studio",
    ]);
  });

  test("rejects additional accessible strings and confirmation props", () => {
    const source = `<Slider aria-valuetext="Engine strength" aria-description="Current strength" confirmLabel="Apply" cancelLabel="Dismiss" />`;
    expect(findLiterals(source)).toEqual(
      expect.arrayContaining(["Engine strength", "Current strength", "Apply", "Dismiss"]),
    );
  });

  test("does not mistake nested configuration for the label copy it styles", () => {
    expect(findLiterals(`const menu = { label: { fontWeight: "normal" } };`)).toEqual([]);
  });

  test.each([
    `<Radio classNames={{ label: "wrap-anywhere" }} />`,
    `<Radio classNames={{ label: ready ? "wrap-anywhere" : "other-class" }} />`,
    `const styles = { className: "wrap-anywhere" };`,
    `const styles = { classNames: { label: "wrap-anywhere", title: "title-class", description: "description-class", placeholder: "placeholder-class", alt: "alt-class" } };`,
    `<Radio classNames={ready ? { nested: { label: "wrap-anywhere" } } : { title: "other-class" }} />`,
    `const styles = { "className": { nested: { label: ready ? "wrap-anywhere" : "other-class" } } };`,
    `<Radio classNames={{ label: \`wrap-\${size}\` }} />`,
  ])("does not mistake CSS class configuration for copy: %s", (source) => {
    expect(findLiterals(source)).toEqual([]);
  });

  test.each([
    `<Text>Destination folder</Text>`,
    `<Radio label="Destination folder" />`,
    `const menu = { label: "Destination folder" };`,
    `<Radio aria-label="Destination folder" />`,
    `<Radio classNames={{ label: "wrap-anywhere" }} label="Destination folder" />`,
    `const menu = { classNames: { label: "wrap-anywhere" }, label: "Destination folder" };`,
  ])("still rejects user-facing copy outside class configuration: %s", (source) => {
    expect(findLiterals(source)).toEqual(["Destination folder"]);
  });

  test("does not exempt a class string when used as copy", () => {
    expect(findLiterals(`<Radio label="wrap-anywhere" />`)).toEqual(["wrap-anywhere"]);
  });

  test("does not treat a UI ternary's state discriminator as copy", () => {
    expect(
      findLiterals(
        `<Modal title={action === "rename" ? t("Files.Rename") : t("Files.CreateFolder")} />`,
      ),
    ).toEqual([]);
  });
});

describe("untranslated UI literal file discovery", () => {
  test("scans live components when another tracked component is deleted in the working tree", async () => {
    const root = await workspace();
    const deleted = "src/components/Deleted.tsx";
    writeFileSync(join(root, deleted), "<Text>Deleted copy</Text>;\n");
    gitTrack(root, deleted);
    rmSync(join(root, deleted));

    await expect(checkUntranslatedJsx(root)).resolves.toEqual([
      'src/components/Tracked.tsx: "Tracked copy"',
    ]);
  });

  test("scans tracked, untracked and symlinked components and skips test files", async () => {
    const root = await workspace();
    writeFileSync(join(root, "Linked.tsx"), "<Text>Linked copy</Text>;\n");
    symlinkSync(join(root, "Linked.tsx"), join(root, "src", "components", "Linked.tsx"));

    expect(listSourceFiles(root)).toEqual([
      "src/components/Linked.tsx",
      "src/components/Tracked.tsx",
      "src/components/Untracked.tsx",
    ]);
    expect(await checkUntranslatedJsx(root)).toEqual([
      'src/components/Linked.tsx: "Linked copy"',
      'src/components/Tracked.tsx: "Tracked copy"',
    ]);
  });

  test("the CLI reports violations as exit 1 and an enumeration failure as exit 2", async () => {
    const clean = await workspace();
    writeFileSync(join(clean, "src", "components", "Tracked.tsx"), '<Text>{t("a")}</Text>;\n');
    const green = spawnSync(process.execPath, [checkerPath], { cwd: clean, encoding: "utf8" });
    assertCli(green, 0, "");

    const root = await workspace();
    writeFileSync(join(root, "src", "components", "Loud.tsx"), "<Text>Loud copy</Text>;\n");
    const red = spawnSync(process.execPath, [checkerPath], { cwd: root, encoding: "utf8" });
    assertCli(
      red,
      1,
      'Untranslated UI literals found. Use t()/Trans; allowed technical exceptions are documented in this script.\nsrc/components/Loud.tsx: "Loud copy"\nsrc/components/Tracked.tsx: "Tracked copy"\n',
    );

    const outside = await temporaryRoot("untranslated-jsx-nogit-");
    mkdirSync(join(outside, "src"), { recursive: true });
    const broken = spawnSync(process.execPath, [checkerPath], { cwd: outside, encoding: "utf8" });
    assertCli(
      broken,
      2,
      `Cannot enumerate working-tree files: git ls-files --others --exclude-standard -z -- src failed (${gitDiscoveryStderr(outside)})\n`,
    );
  });
});
