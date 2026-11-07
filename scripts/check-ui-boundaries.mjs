import { readFileSync } from "node:fs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

let listedFiles;
try {
  listedFiles = listWorkingTreeFiles();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const violations = [];
const actionIconImport = /import\s*\{[^}]*\bActionIcon\b[^}]*\}\s*from\s*["']@mantine\/core["']/;
const modalImport = /import\s*\{[^}]*\bModal\b[^}]*\}\s*from\s*["']@mantine\/core["']/;
const unsafeFocusReset = /\b(all\s*:\s*unset|outline\s*:\s*(?:none|0(?:px)?))\b/;
const mantineStylesheetSpec =
  /(?:from|import)\s+["']((?:@mantine\/[\w-]+|mantine-contextmenu|mantine-datatable)\/(?:styles(?:\.layer)?\.css|styles\/[\w.-]+\.css))["']/;

function inspectLine(file, line) {
  if (
    actionIconImport.test(line) &&
    file !== "src/components/common/IconAction.tsx" &&
    file !== "src/styles/theme.ts"
  ) {
    violations.push(`${file}: direct ActionIcon import; use IconAction instead`);
  }
  if (unsafeFocusReset.test(line)) {
    violations.push(`${file}: unsafe focus reset; preserve or restore :focus-visible`);
  }
  if (modalImport.test(line) && file !== "src/components/common/AppModal.tsx") {
    violations.push(`${file}: direct Modal import; use AppModal instead`);
  }
  const stylesheet = line.match(mantineStylesheetSpec);
  if (stylesheet && !stylesheet[1].endsWith(".layer.css")) {
    violations.push(
      `${file}: unlayered Mantine stylesheet import '${stylesheet[1]}'; use styles.layer.css`,
    );
  }
}

function readWorkingTreeFile(file) {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    // `git ls-files` can include a tracked file removed by an uncommitted deletion;
    // that genuine absence is the one legitimate reason to skip the file.
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// `git ls-files` still lists a tracked file that the working tree has deleted, and the
// scan below reads the working tree, so an uncommitted deletion has no content to inspect.
// The read helper above tolerates that one legitimate absence while keeping every other
// filesystem failure loud.
const sourceFiles = new Set(listedFiles);

// Whole tree, not the diff. These two rules used to inspect only lines added in
// `git diff -- src` plus untracked files, which made them silently vacuous wherever the
// checkout is clean — every CI run, since CI checks out and never edits. The rules are
// invariants ("no direct ActionIcon import anywhere", "no unsafe focus reset anywhere"),
// not properties of a diff, so scanning the tree is both correct and strictly stronger:
// `readFileSync` reads the working tree, so uncommitted edits are still covered.
for (const file of sourceFiles) {
  if (!/\.(tsx?|css)$/.test(file)) continue;
  if (/\.test\.[jt]sx?$/.test(file)) continue;
  const contents = readWorkingTreeFile(file);
  if (contents === null) continue;
  for (const line of contents.split("\n")) {
    inspectLine(file, line);
  }
}

for (const file of sourceFiles) {
  if (!file.endsWith(".css")) continue;
  const contents = readWorkingTreeFile(file);
  if (contents === null) continue;
  for (const line of contents.split("\n")) {
    if (unsafeFocusReset.test(line)) {
      violations.push(
        `${file}: unsafe focus reset; use explicit reset properties and :focus-visible`,
      );
    }
  }
}

const unique = [...new Set(violations)];
violations.length = 0;
violations.push(...unique);

if (violations.length) {
  console.error("UI boundary violations:\n" + violations.join("\n"));
  process.exit(1);
}
