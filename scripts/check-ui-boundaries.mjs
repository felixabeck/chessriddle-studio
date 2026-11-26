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
const mantineNamedImport =
  /\bimport\b(\s+type\b)?\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']@mantine\/core["']/g;
const wrapperImportRules = [
  {
    name: "ActionIcon",
    exemptFiles: new Set(["src/components/common/IconAction.tsx", "src/styles/theme.ts"]),
    message: "direct ActionIcon import; use IconAction instead",
  },
  {
    name: "Modal",
    exemptFiles: new Set(["src/components/common/AppModal.tsx"]),
    message: "direct Modal import; use AppModal instead",
  },
  {
    name: "Popover",
    exemptFiles: new Set(["src/components/common/AppPopover.tsx", "src/styles/theme.ts"]),
    message: "direct Popover import; use AppPopover instead",
  },
];
const unsafeFocusReset = /\b(all\s*:\s*unset|outline\s*:\s*(?:none|0(?:px)?))\b/;
const mantineStylesheetSpec =
  /(?:from|import)\s+["']((?:@mantine\/[\w-]+|mantine-contextmenu|mantine-datatable)\/(?:styles(?:\.layer)?\.css|styles\/[\w.-]+\.css))["']/;
const externalLinkOwner = "src/components/common/ExternalLink.tsx";
const blankTargetLiteral = /["']_blank["']/;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function inspectMantineImports(file, contents) {
  for (const match of contents.matchAll(mantineNamedImport)) {
    if (match[1]) continue;
    for (const raw of stripComments(match[2]).split(",")) {
      const spec = raw.trim();
      if (!spec || /^type\s+(?!as\b)/.test(spec)) continue;
      const imported = spec.match(/^([\w$]+)(?:\s+as\s+[\w$]+)?$/)?.[1];
      if (!imported) continue;
      for (const rule of wrapperImportRules) {
        if (imported === rule.name && !rule.exemptFiles.has(file)) {
          violations.push(`${file}: ${rule.message}`);
        }
      }
    }
  }
}

function inspectLine(file, line) {
  if (unsafeFocusReset.test(line)) {
    violations.push(`${file}: unsafe focus reset; preserve or restore :focus-visible`);
  }
  const stylesheet = line.match(mantineStylesheetSpec);
  if (stylesheet && !stylesheet[1].endsWith(".layer.css")) {
    const layered = `${stylesheet[1].slice(0, -".css".length)}.layer.css`;
    violations.push(
      `${file}: unlayered Mantine stylesheet import '${stylesheet[1]}'; use ${layered}`,
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
  if (!file.endsWith(".css")) {
    inspectMantineImports(file, contents);
    if (file !== externalLinkOwner && blankTargetLiteral.test(contents)) {
      violations.push(
        `${file}: direct _blank target; use ExternalLink or externalLinkProps from ${externalLinkOwner}`,
      );
    }
  }
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
