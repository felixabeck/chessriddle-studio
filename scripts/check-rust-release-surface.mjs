import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { isEntrypoint } from "./entrypoint.mjs";
import { maskRustSource } from "./rust-source-mask.mjs";
import {
  classifyRustTestOnlySources,
  createRustTestOnlyStructuralCache,
  lineAt,
  lineAtFromStarts,
  sourceEntries,
  sourceLineStarts,
} from "./rust-test-only.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

// Owner: f-20260830-25. Emptied 2026-09-06 by the finding that owned it;
// any new entry is an R1 violation.
const INITIAL_DEAD_CODE_ALLOWLIST = Object.freeze([]);

export const DEAD_CODE_ALLOWLIST = new Set(INITIAL_DEAD_CODE_ALLOWLIST);

// Owner: f-20260830-23. Emptied 2026-10-05 by f-20260919-03;
// any new entry is an R3 violation. This allowlist may only shrink.
const INITIAL_FS_SURFACE_ALLOWLIST = Object.freeze([]);

export const FS_SURFACE_ALLOWLIST = new Set(INITIAL_FS_SURFACE_ALLOWLIST);

// Production R3+R4 match counts, measured by this checker. Shrink-only.
export const INITIAL_FS_SURFACE_COUNTS = Object.freeze({});

export const PATH_METHODS = Object.freeze([
  "canonicalize",
  "metadata",
  "symlink_metadata",
  "read_dir",
  "read_link",
  "exists",
  "try_exists",
  "is_file",
  "is_dir",
  "is_symlink",
]);

const PATH_METHOD_REASON =
  "pathname filesystem reach: route through src-tauri/src/infra (descriptor-relative outside infra); f-20260912-03";
export const EXPECTED_CLIPPY_TOML = `disallowed-methods = [\n${PATH_METHODS.map(
  (name) => `  { path = "std::path::Path::${name}", reason = "${PATH_METHOD_REASON}" },`,
).join("\n")}\n]\n`;

const CLIPPY_SUPPRESSING_LINTS = Object.freeze([
  "clippy::disallowed_methods",
  "clippy::style",
  "clippy::all",
  "warnings",
]);

const INITIAL_PATH_EXPECT_BASELINE = Object.freeze([]);
const PATH_EXPECT_BASELINE = Object.freeze([]);
const INITIAL_GATE_REGION_BASELINE = Object.freeze([
  Object.freeze({
    path: "src-tauri/src/main.rs",
    key: "root-windows-subsystem",
    attribute:
      '#![cfg_attr( all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows" )]',
    regionSha256: "d07a1672d2012b6a85aa65c87b4571931718b0899f4134f3ca9a29aadc6d5bbf",
  }),
  Object.freeze({
    path: "src-tauri/src/main.rs",
    key: "release-native-log-sinks",
    attribute: "#[cfg(not(debug_assertions))]",
    regionSha256: "666cf86646e54d42fd49038417112038dc15f6163cb2437f395649b5562d0f1e",
  }),
]);
const GATE_REGION_BASELINE = INITIAL_GATE_REGION_BASELINE;
const BUILD_SCRIPT_SHA256 = "487059eaf8a947b80f20a9aacac038a5047b2ad69d2401b827376c67d6fe847f";

const INJECTION_NAME = /(?:FaultPoint|Injector|_with_injector)/i;
const PUBLIC_ITEM =
  /^\s*pub(?:\s*\(\s*(?:crate|super)\s*\))?\s+(?:(?:async|const|unsafe|extern(?:\s+"[^"]+")?)\s+)*(?:fn|struct|enum|trait|type|mod|static|const)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const USE_START = /^\s*(?:pub(?:\s*\(\s*(?:crate|super)\s*\))?\s+)?use\b/;

function isFileLevelDeadCodeAllowance(line) {
  return /^\s*#!\s*\[\s*allow\s*\(\s*dead_code\s*\)\s*\]/.test(line);
}

export function checkDeadCodeSurface(
  sources,
  allowlist = DEAD_CODE_ALLOWLIST,
  maskCache = new Map(),
) {
  const entries = sourceEntries(sources);
  const pathsWithAllowance = new Set(
    entries
      .filter(({ contents }) =>
        maskRustSource(contents, maskCache).split("\n").some(isFileLevelDeadCodeAllowance),
      )
      .map(({ path }) => path),
  );
  const allowedPaths = new Set(allowlist);
  const violations = [];

  for (const path of allowedPaths) {
    if (!INITIAL_DEAD_CODE_ALLOWLIST.includes(path)) {
      violations.push(`R1: allowlist entry ${path} is not part of the shrink-only baseline`);
    }
    if (!pathsWithAllowance.has(path)) {
      violations.push(`R1: allowlist entry ${path} no longer carries #![allow(dead_code)]`);
    }
  }

  for (const path of pathsWithAllowance) {
    if (!allowedPaths.has(path)) {
      violations.push(`R1: ${path} carries file-level #![allow(dead_code)] but is not allowlisted`);
    }
  }

  return violations;
}

function unclassifiableCfgViolation(error) {
  const message = error instanceof Error ? error.message : String(error);
  const location = message.match(/^(.*):(\d+): ([\s\S]*)$/);
  return location
    ? `${location[1]}:${location[2]}: R5: unclassifiable cfg (${location[3]})`
    : `R5: unclassifiable cfg (${message})`;
}

const FS_FN_NAMES = [
  "write",
  "read",
  "read_to_string",
  "read_dir",
  "copy",
  "create_dir",
  "create_dir_all",
  "remove_file",
  "remove_dir",
  "remove_dir_all",
  "rename",
  "hard_link",
  "symlink",
  "canonicalize",
  "metadata",
  "symlink_metadata",
  "set_permissions",
  "read_link",
  "OpenOptions",
  "DirBuilder",
];
const FS_FN = FS_FN_NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const FILE_CTOR = "open|create|create_new";
const PATHNAME_FNS = ["atomic_replace", "atomic_replace_with_precommit", "atomic_install_dir"];
const TURBOFISH_CALL = "(?:\\s*::\\s*<[^>]*>)?\\s*\\(";

function emptyImportState() {
  return {
    stdFsAliases: new Set(),
    tokioFsAliases: new Set(),
    infraFsAliases: new Set(),
    importedFileNames: new Set(),
    importedOpenOptionsNames: new Set(),
    importedDirBuilderNames: new Set(),
    importedFsFns: new Set(),
    importedPathnameFns: new Set(),
    globInfraFs: false,
  };
}

function mergeImportState(target, extra) {
  for (const name of extra.stdFsAliases) target.stdFsAliases.add(name);
  for (const name of extra.tokioFsAliases) target.tokioFsAliases.add(name);
  for (const name of extra.infraFsAliases) target.infraFsAliases.add(name);
  for (const name of extra.importedFileNames) target.importedFileNames.add(name);
  for (const name of extra.importedOpenOptionsNames) target.importedOpenOptionsNames.add(name);
  for (const name of extra.importedDirBuilderNames) target.importedDirBuilderNames.add(name);
  for (const name of extra.importedFsFns) target.importedFsFns.add(name);
  for (const name of extra.importedPathnameFns) target.importedPathnameFns.add(name);
  target.globInfraFs = target.globInfraFs || extra.globInfraFs;
}

function braceAwareSplit(text) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const character of text) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function applyUseTree(prefix, tree, state) {
  const trimmed = tree.trim();
  if (!trimmed) return;
  const groupStart = trimmed.indexOf("::{");
  if (groupStart !== -1 && !trimmed.slice(0, groupStart).includes("{")) {
    applyUseTree(
      prefix ? `${prefix}::${trimmed.slice(0, groupStart)}` : trimmed.slice(0, groupStart),
      trimmed.slice(groupStart + 2),
      state,
    );
    return;
  }
  if (trimmed.endsWith("::*")) {
    applyUseTree(prefix ? `${prefix}::${trimmed.slice(0, -3)}` : trimmed.slice(0, -3), "*", state);
    return;
  }
  if (trimmed === "*") {
    if (/(?:^|::)(?:std|tokio)::fs$/.test(prefix)) {
      /* glob of std::fs / tokio::fs: treat as importing every function name */
      for (const name of FS_FN_NAMES) state.importedFsFns.add(name);
      state.importedFileNames.add("File");
      state.importedOpenOptionsNames.add("OpenOptions");
      state.importedDirBuilderNames.add("DirBuilder");
    }
    if (/(?:infra|super)::fs$/.test(prefix) || prefix === "fs") state.globInfraFs = true;
    return;
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    for (const inner of braceAwareSplit(trimmed.slice(1, -1))) applyUseTree(prefix, inner, state);
    return;
  }
  const aliased = trimmed.match(/^(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/);
  const raw = (aliased ? aliased[1] : trimmed).trim();
  const local = aliased ? aliased[2] : raw.split("::").at(-1);
  const full = prefix ? `${prefix}::${raw}` : raw;
  if (raw === "self") {
    const bound = aliased ? local : prefix.split("::").at(-1);
    if (/(?:^|::)std::fs$/.test(prefix)) state.stdFsAliases.add(bound);
    if (/(?:^|::)tokio::fs$/.test(prefix)) state.tokioFsAliases.add(bound);
    if (/(?:infra|super)::fs$/.test(prefix)) state.infraFsAliases.add(bound);
    return;
  }
  if (/^(?:std|tokio)::fs$/.test(full) || /^(?:std|tokio)::fs$/.test(raw)) {
    const kind =
      (full.startsWith("tokio") || raw.startsWith("tokio") ? "tokio" : "std") + "FsAliases";
    state[kind].add(local === "fs" || aliased ? local : "fs");
    if (!aliased) state[kind].add("fs");
    return;
  }
  if (
    /^(?:crate::)?infra::fs$/.test(full) ||
    /^(?:crate::)?infra::fs$/.test(raw) ||
    raw === "super::fs"
  ) {
    state.infraFsAliases.add(local);
    return;
  }
  if (/(?:^|::)(?:std|tokio)::fs::File$/.test(full) || raw === "File") {
    state.importedFileNames.add(local);
  }
  if (/(?:^|::)(?:std|tokio)::fs::OpenOptions$/.test(full) || raw === "OpenOptions") {
    state.importedOpenOptionsNames.add(local);
  }
  if (/(?:^|::)(?:std|tokio)::fs::DirBuilder$/.test(full) || raw === "DirBuilder") {
    state.importedDirBuilderNames.add(local);
  }
  if (FS_FN_NAMES.includes(local) || FS_FN_NAMES.includes(raw.split("::").at(-1))) {
    if (/(?:std|tokio)::fs/.test(full) || FS_FN_NAMES.includes(raw)) state.importedFsFns.add(local);
  }
  if (PATHNAME_FNS.includes(raw.split("::").at(-1)) || PATHNAME_FNS.includes(local)) {
    if (/fs::/.test(full) || PATHNAME_FNS.includes(raw)) state.importedPathnameFns.add(local);
  }
}

function parseUseBindings(text) {
  const state = emptyImportState();
  const compact = text.replace(/\s+/g, " ").trim().replace(/;$/, "");
  const match = compact.match(/^(?:pub(?:\s*\(\s*(?:crate|super)\s*\))?\s+)?use\s+(.+)$/);
  if (!match) return state;
  applyUseTree("", match[1], state);
  return state;
}

function walkGatedLines(source, onLine, testOnlyLines, maskCache) {
  const lines = maskRustSource(source, maskCache).split("\n");
  let useStatement = null;

  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index];
    const gated = testOnlyLines.has(index + 1);

    const startsUse =
      USE_START.test(code) || USE_START.test(code.replace(/^\s*(?:#\[[^\]]*\]\s*)+/, ""));
    if (startsUse) {
      useStatement = { gated, text: code };
    } else if (useStatement) {
      useStatement.text += `\n${code}`;
    }

    const isUseComplete = Boolean(useStatement && code.includes(";"));

    onLine({
      index,
      code,
      gated,
      useText: isUseComplete ? useStatement.text : null,
      useGated: isUseComplete ? useStatement.gated : false,
    });

    if (isUseComplete) {
      useStatement = null;
    }
  }
}

function checkFaultInjectionSurfaceWithClassification(path, source, classification, maskCache) {
  const violations = [];
  const testOnlyLines = classification.excludedLines.get(path) ?? new Set();

  walkGatedLines(
    source,
    ({ index, code, gated, useText, useGated }) => {
      const publicItem = PUBLIC_ITEM.exec(code);
      if (publicItem && INJECTION_NAME.test(publicItem[1]) && !gated) {
        violations.push(
          `${path}:${index + 1}: R2: public fault-injection item ${publicItem[1]} must be inside #[cfg(test)]`,
        );
      }
      if (useText && INJECTION_NAME.test(useText) && !useGated) {
        violations.push(
          `${path}:${index + 1}: R2: use importing a fault-injection name must be inside #[cfg(test)]`,
        );
      }
    },
    testOnlyLines,
    maskCache,
  );

  return [...new Set(violations)];
}

export function checkFaultInjectionSurface(path, source) {
  const maskCache = new Map();
  let classification;
  try {
    classification = classifyRustTestOnlySources([{ path, contents: source }], undefined, {
      maskCache,
    });
  } catch (error) {
    return [unclassifiableCfgViolation(error)];
  }
  return checkFaultInjectionSurfaceWithClassification(path, source, classification, maskCache);
}

function isInfraPath(path) {
  return path.startsWith("src-tauri/src/infra/");
}

function qualifiedFsCall(prefix, code) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fn = new RegExp(`\\b${escaped}::(?:File::(?:${FILE_CTOR})|(?:${FS_FN}))\\b`);
  return fn.test(code);
}

function pathnameCall(name, code) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}${TURBOFISH_CALL}`).test(code);
}

function collectFilesystemMatches(path, source, classification, maskCache) {
  if (isInfraPath(path)) return [];
  const matches = [];
  const events = [];
  const testOnlyLines = classification.excludedLines.get(path) ?? new Set();
  walkGatedLines(source, (event) => events.push(event), testOnlyLines, maskCache);

  const imports = emptyImportState();
  for (const { useText, useGated } of events) {
    if (useText && !useGated) mergeImportState(imports, parseUseBindings(useText));
  }

  for (const { index, code, gated, useText, useGated } of events) {
    if (useText && !useGated) {
      const parsed = parseUseBindings(useText);
      if (
        parsed.importedPathnameFns.size > 0 ||
        parsed.globInfraFs ||
        parsed.infraFsAliases.size > 0
      ) {
        matches.push({ line: index + 1, rule: "R4", kind: "import" });
      }
    }
    if (gated) continue;

    if (qualifiedFsCall("std::fs", code) || qualifiedFsCall("tokio::fs", code)) {
      matches.push({ line: index + 1, rule: "R3", kind: "qualified" });
    }
    for (const alias of imports.stdFsAliases) {
      if (qualifiedFsCall(alias, code))
        matches.push({ line: index + 1, rule: "R3", kind: "alias" });
    }
    for (const alias of imports.tokioFsAliases) {
      if (qualifiedFsCall(alias, code))
        matches.push({ line: index + 1, rule: "R3", kind: "alias" });
    }
    for (const name of imports.importedFileNames) {
      if (new RegExp(`\\b${name}::(?:${FILE_CTOR})\\b`).test(code)) {
        matches.push({ line: index + 1, rule: "R3", kind: "file-ctor" });
      }
    }
    for (const name of imports.importedOpenOptionsNames) {
      if (new RegExp(`\\b${name}::`).test(code)) {
        matches.push({ line: index + 1, rule: "R3", kind: "open-options" });
      }
    }
    for (const name of imports.importedDirBuilderNames) {
      if (new RegExp(`\\b${name}::`).test(code)) {
        matches.push({ line: index + 1, rule: "R3", kind: "dir-builder" });
      }
    }
    for (const name of imports.importedFsFns) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(code)) {
        matches.push({ line: index + 1, rule: "R3", kind: "imported-fn" });
      }
    }

    for (const name of PATHNAME_FNS) {
      if (pathnameCall(name, code)) matches.push({ line: index + 1, rule: "R4", kind: "call" });
    }
    for (const name of imports.importedPathnameFns) {
      if (pathnameCall(name, code))
        matches.push({ line: index + 1, rule: "R4", kind: "imported-call" });
    }
  }

  const unique = [];
  const seen = new Set();
  for (const match of matches) {
    const key = `${match.line}:${match.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(match);
  }
  return unique;
}

function validateShrinkOnlyBaseline({
  rule,
  initialBaseline,
  baseline,
  counts,
  measure,
  measurePresentPaths,
  presentPaths,
  messages,
}) {
  const initial = new Set(initialBaseline);
  const present = presentPaths === undefined ? null : new Set(presentPaths);
  const measurable = measurePresentPaths === undefined ? present : new Set(measurePresentPaths);
  const violations = [];
  for (const key of baseline) {
    const path = messages.pathFor(key);
    if (!initial.has(key)) violations.push(messages.added(key, path));
    if (present && !present.has(path)) violations.push(messages.residency(key, path));
    if (measure && (!measurable || measurable.has(path))) {
      const measured = measure(key, path);
      const expected = counts?.[key] ?? 0;
      if (measured === 0) violations.push(messages.empty(key, path));
      else if (measured !== expected)
        violations.push(messages.mismatch(key, path, measured, expected));
    }
  }
  return violations.map((violation) =>
    violation.startsWith(`${rule}:`) ? violation : `${rule}: ${violation}`,
  );
}

const R3_BASELINE_MESSAGES = Object.freeze({
  pathFor: (path) => path,
  added: (_key, path) => `allowlist entry ${path} is not part of the shrink-only baseline`,
  residency: (_key, path) =>
    `allowlist entry ${path} is not present in the working tree and must be removed from the allowlist`,
  empty: (_key, path) =>
    `allowlist entry ${path} has no production filesystem reaches and must be removed from the allowlist`,
  mismatch: (_key, path, measured, expected) =>
    `${path} has ${measured} production filesystem reaches, allowlisted for ${expected}`,
});

function checkFilesystemSurfaceWithClassification(
  sources,
  allowlist = FS_SURFACE_ALLOWLIST,
  counts = INITIAL_FS_SURFACE_COUNTS,
  classification,
  maskCache,
) {
  const entries = sourceEntries(sources);
  const violations = [];
  const allowedPaths = new Set(allowlist);
  const matchesByPath = new Map();

  for (const { path, contents } of entries) {
    const matches = collectFilesystemMatches(path, contents, classification, maskCache);
    matchesByPath.set(path, matches);
    if (allowedPaths.has(path)) {
      continue;
    }
    for (const match of matches) {
      violations.push(
        `${path}:${match.line}: ${match.rule}: production filesystem reach (${match.kind}) must be inside infra/, #[cfg(test)], or the shrink-only allowlist`,
      );
    }
  }

  violations.unshift(
    ...validateShrinkOnlyBaseline({
      rule: "R3",
      initialBaseline: INITIAL_FS_SURFACE_ALLOWLIST,
      baseline: [...allowedPaths],
      counts,
      measurePresentPaths: matchesByPath.keys(),
      measure: (path) => matchesByPath.get(path)?.length ?? 0,
      messages: R3_BASELINE_MESSAGES,
    }),
  );

  return violations;
}

export function checkFilesystemSurface(
  sources,
  allowlist = FS_SURFACE_ALLOWLIST,
  counts = INITIAL_FS_SURFACE_COUNTS,
) {
  const entries = sourceEntries(sources);
  const maskCache = new Map();
  let classification;
  try {
    classification = classifyRustTestOnlySources(entries, undefined, { maskCache });
  } catch (error) {
    return [unclassifiableCfgViolation(error)];
  }
  return checkFilesystemSurfaceWithClassification(
    entries,
    allowlist,
    counts,
    classification,
    maskCache,
  );
}

// An allowlist entry whose file has left the working tree is stale: without this rule the entry
// survives the deletion for ever and every gate stays green.
export function checkAllowlistResidency(paths, allowlist = FS_SURFACE_ALLOWLIST) {
  return validateShrinkOnlyBaseline({
    rule: "R3",
    initialBaseline: INITIAL_FS_SURFACE_ALLOWLIST,
    baseline: [...allowlist],
    presentPaths: paths,
    messages: R3_BASELINE_MESSAGES,
  });
}

function normaliseRustText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function isTestOnlyOffset(path, source, offset, classification, lineStartsByPath) {
  const starts = lineStartsByPath?.get(path);
  const line = starts ? lineAtFromStarts(offset, starts) : lineAt(source, offset);
  return classification.excludedLines.get(path)?.has(line) ?? false;
}

function suppressionForms(attributeText, masked = maskRustSource(attributeText)) {
  const forms = [];
  for (const match of masked.matchAll(/\b(allow|expect)\s*\(([^)]*)\)/g)) {
    const names = CLIPPY_SUPPRESSING_LINTS.filter((name) =>
      new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`).test(match[2]),
    );
    if (names.length) forms.push({ level: match[1], names });
  }
  return forms;
}

function exactMainTestAllowance(path, innerAttribute, maskCache) {
  return (
    path === "src-tauri/src/main.rs" &&
    innerAttribute.root &&
    normaliseRustText(
      innerAttribute.attribute.maskedText ??
        maskRustSource(innerAttribute.attribute.text, maskCache),
    ).replaceAll(" ", "") === "cfg_attr(test,allow(clippy::disallowed_methods))"
  );
}

function isCountedPathExpect(path, attribute, maskCache) {
  const masked = attribute.maskedText ?? maskRustSource(attribute.text, maskCache);
  const meta = masked.trim();
  const direct = meta.match(/^expect\s*\(([^)]*)\)/);
  if (!direct) return false;
  const names = suppressionForms(attribute.text, masked)
    .filter(({ level }) => level === "expect")
    .flatMap(({ names: suppressions }) => suppressions);
  return (
    path === "src-tauri/src/main.rs" &&
    names.length === 1 &&
    names[0] === "clippy::disallowed_methods" &&
    /\bclippy\s*::\s*disallowed_methods\b/.test(direct[1])
  );
}

function methodTokens(text, maskCache) {
  const escaped = PATH_METHODS.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const expression = new RegExp(`\\b(?:${escaped.join("|")})\\b`, "g");
  const masked = maskRustSource(text, maskCache);
  return [...masked.matchAll(expression)]
    .filter((match) => {
      const before = masked.slice(0, match.index);
      return !/\blet\s+(?:mut\s+)?$/.test(before);
    })
    .map((match) => match[0]);
}

function hasDirectMethodCall(text, name, maskCache) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:\\.|::)\\s*${escaped}\\s*\\(`).test(maskRustSource(text, maskCache));
}

function hasMacroInvocation(text, maskCache) {
  return /\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*\s*!\s*[([{]/.test(
    maskRustSource(text, maskCache),
  );
}

function inspectAttributeControls({
  path,
  source,
  attribute,
  offset,
  isInner = false,
  isInfra,
  inMacroDefinition,
  skipCfgChecks = false,
  allowCountedExpect = false,
  allowCrateRootException = false,
  isCrateRootAttribute = false,
  maskCache,
  lineStartsByPath,
}) {
  const beforeCountViolations = [];
  const afterCountViolations = [];
  const starts = lineStartsByPath?.get(path);
  const line = starts ? lineAtFromStarts(offset, starts) : lineAt(source, offset);
  const maskedAttribute = attribute.maskedText ?? maskRustSource(attribute.text, maskCache);
  const forms = suppressionForms(attribute.text, maskedAttribute);
  if (maskedAttribute.includes("$")) {
    beforeCountViolations.push(
      `${path}:${line}: R5: attribute metavariable can generate an unreviewed rustc or clippy attribute`,
    );
  }

  const suppressionApplies = forms.length > 0 && (!isInfra || inMacroDefinition);
  const countedExpect =
    suppressionApplies && allowCountedExpect && isCountedPathExpect(path, attribute, maskCache);
  const crateRootException =
    suppressionApplies &&
    allowCrateRootException &&
    exactMainTestAllowance(
      path,
      {
        root: isCrateRootAttribute,
        attribute,
      },
      maskCache,
    );
  if (suppressionApplies && !countedExpect && !crateRootException) {
    const prefix = isInner ? "inner " : "";
    beforeCountViolations.push(
      `${path}:${line}: R5: ${prefix}${forms.map(({ level, names }) => `${level}(${names.join(", ")})`).join("; ")} can suppress disallowed Path methods`,
    );
  }

  if (!skipCfgChecks) {
    if (/\bclippy\b(?!\s*::)/.test(maskedAttribute)) {
      afterCountViolations.push(
        `${path}:${line}: R5: production cfg attribute may not use the clippy cfg atom`,
      );
    }
    if (
      !isInfra &&
      /^\s*cfg_attr\s*\(/.test(maskedAttribute) &&
      /\bcfg\s*\(/.test(maskedAttribute)
    ) {
      afterCountViolations.push(
        `${path}:${line}: R5: cfg_attr payload may not introduce a nested cfg predicate`,
      );
    }
  }

  return { beforeCountViolations, afterCountViolations, countedExpect };
}

function checkPathMethodExpectationsWithClassification(
  entries,
  classification,
  {
    initialBaseline = INITIAL_PATH_EXPECT_BASELINE,
    baseline = PATH_EXPECT_BASELINE,
    presentPaths,
    lineStartsByPath: suppliedLineStartsByPath,
    maskCache: suppliedMaskCache,
  } = {},
) {
  const lineStartsByPath =
    suppliedLineStartsByPath ??
    classification.lineStartsByPath ??
    new Map(entries.map(({ path, contents }) => [path, sourceLineStarts(contents)]));
  const maskCache = suppliedMaskCache ?? new Map();
  const violations = [];
  const analyses = classification.analysis;
  const observed = new Map();
  const candidateKeys = new Set();

  for (const { path, contents } of entries) {
    const analysis = analyses.get(path);
    if (!analysis) continue;
    const regionByStart = new Map(analysis.sourceRegions.map((region) => [region.start, region]));
    for (const group of analysis.groups) {
      if (isTestOnlyOffset(path, contents, group.start, classification, lineStartsByPath)) continue;
      const region = regionByStart.get(group.start);
      const isInfra = isInfraPath(path);
      for (const attribute of group.attributes) {
        const inMacroDefinition = analysis.macroRegions?.some(
          ({ start, end }) => start <= attribute.start && attribute.start < end,
        );
        const controls = inspectAttributeControls({
          path,
          source: contents,
          attribute,
          offset: attribute.start,
          isInfra,
          inMacroDefinition,
          skipCfgChecks: isTestOnlyOffset(
            path,
            contents,
            attribute.start,
            classification,
            lineStartsByPath,
          ),
          allowCountedExpect: true,
          maskCache,
          lineStartsByPath,
        });
        violations.push(...controls.beforeCountViolations);
        if (controls.countedExpect) {
          const row = region;
          const fn = row?.function;
          const key = fn ? `${path}::${fn.name}` : `${path}::<outside-function>`;
          candidateKeys.add(key);
          const maskedStatement = row
            ? maskRustSource(contents.slice(row.range.start, row.range.end), maskCache)
            : "";
          const statementStart = row
            ? maskRustSource(contents.slice(group.end, row.range.end), maskCache).trimStart()
            : "";
          const tokens = methodTokens(maskedStatement, maskCache);
          const direct =
            tokens.length === 1 && hasDirectMethodCall(maskedStatement, tokens[0], maskCache);
          const startsLet = /^let\b/.test(statementStart);
          const macro = hasMacroInvocation(maskedStatement, maskCache);
          if (!fn || !startsLet || tokens.length !== 1 || !direct || macro) {
            violations.push(
              `${path}:${lineAt(contents, attribute.start)}: R5: counted expect must annotate one direct Path method call in a single let statement without a macro`,
            );
          }
          if (fn) {
            const methods = observed.get(key) ?? [];
            if (tokens.length === 1) methods.push(tokens[0]);
            observed.set(key, methods);
            const itemHash = sha256(normaliseRustText(fn.text));
            const expected = baseline.find((entry) => `${entry.path}::${entry.function}` === key);
            if (!expected) {
              violations.push(
                `${path}:${lineAt(contents, attribute.start)}: R5: counted expect in ${fn.name} has no pinned baseline entry`,
              );
            } else if (itemHash !== expected.sha256) {
              violations.push(
                `${path}:${lineAt(contents, attribute.start)}: R5: pinned function ${fn.name} changed from its recorded text`,
              );
            }
          }
        }
        violations.push(...controls.afterCountViolations);
      }
    }
    for (const inner of analysis.innerAttributes) {
      if (isTestOnlyOffset(path, contents, inner.start, classification, lineStartsByPath)) continue;
      const isInfra = isInfraPath(path);
      const inMacroDefinition = analysis.macroRegions?.some(
        ({ start, end }) => start <= inner.start && inner.start < end,
      );
      const controls = inspectAttributeControls({
        path,
        source: contents,
        attribute: inner.attribute,
        offset: inner.start,
        isInner: true,
        isInfra,
        inMacroDefinition,
        allowCrateRootException: true,
        isCrateRootAttribute: inner.root,
        maskCache,
        lineStartsByPath,
      });
      violations.push(...controls.beforeCountViolations, ...controls.afterCountViolations);
    }

    const masked = maskRustSource(contents, maskCache);
    for (const [lineIndex, line] of masked.split("\n").entries()) {
      if (classification.excludedLines.get(path)?.has(lineIndex + 1)) continue;
      if (/\binclude\b/.test(line)) {
        violations.push(
          `${path}:${lineIndex + 1}: R5: production source may not name the include macro`,
        );
      }
    }
    for (const region of analysis.sourceRegions) {
      if (isTestOnlyOffset(path, contents, region.start, classification, lineStartsByPath))
        continue;
      if (/\bpath\s*=/.test(maskRustSource(region.text, maskCache))) {
        violations.push(
          `${path}:${lineAt(contents, region.start)}: R5: production source may not use a #[path] attribute`,
        );
      }
    }
  }

  const measuredCounts = Object.fromEntries(
    [...observed].map(([key, methods]) => [key, methods.length]),
  );
  const expectedCounts = Object.fromEntries(
    baseline.map((entry) => [
      `${entry.path}::${entry.function}`,
      Object.values(entry.methods).reduce((sum, count) => sum + count, 0),
    ]),
  );
  const siteMessages = {
    pathFor: (key) => key.slice(0, key.lastIndexOf("::")),
    added: (_key, path) => `pinned expect entry ${path} is not part of the shrink-only baseline`,
    residency: (_key, path) =>
      `pinned expect path ${path} is not present in the working tree and must be removed`,
    empty: (key) => `pinned expect entry ${key} has no counted reaches and must be removed`,
    mismatch: (key, _path, measured, expected) =>
      `pinned expect entry ${key} has ${measured} counted reaches, baseline ${expected}`,
  };
  violations.push(
    ...validateShrinkOnlyBaseline({
      rule: "R5",
      initialBaseline: initialBaseline.map((entry) => `${entry.path}::${entry.function}`),
      baseline: baseline.map((entry) => `${entry.path}::${entry.function}`),
      counts: expectedCounts,
      measure: (key) => measuredCounts[key] ?? 0,
      measurePresentPaths: entries.map(({ path }) => path),
      presentPaths,
      messages: siteMessages,
    }),
  );

  for (const key of candidateKeys) {
    if (!baseline.some((entry) => `${entry.path}::${entry.function}` === key)) continue;
    const actual = (observed.get(key) ?? []).sort();
    const expected = baseline.find((entry) => `${entry.path}::${entry.function}` === key).methods;
    const expectedMethods = Object.entries(expected)
      .flatMap(([method, count]) => Array.from({ length: count }, () => method))
      .sort();
    if (
      actual.length !== expectedMethods.length ||
      actual.some((method, index) => method !== expectedMethods[index])
    ) {
      violations.push(
        `R5: counted expect methods for ${key} differ from the pinned method multiset`,
      );
    }
  }
  for (const entry of baseline) {
    const key = `${entry.path}::${entry.function}`;
    const initial = initialBaseline.find(
      (candidate) => `${candidate.path}::${candidate.function}` === key,
    );
    if (!initial) continue;
    for (const [method, count] of Object.entries(entry.methods)) {
      if (count > (initial.methods[method] ?? 0)) {
        violations.push(
          `R5: counted ${method} expects in ${key} exceed the initial shrink-only baseline`,
        );
      }
    }
  }
  for (const [key, methods] of observed) {
    if (
      candidateKeys.has(key) &&
      !baseline.some((entry) => `${entry.path}::${entry.function}` === key)
    ) {
      violations.push(`R5: counted expect in ${key} has no pinned baseline entry`);
    }
    const initial = initialBaseline.find((entry) => `${entry.path}::${entry.function}` === key);
    if (initial) {
      const max = initial.methods;
      const actualCounts = Object.fromEntries(PATH_METHODS.map((method) => [method, 0]));
      for (const method of methods) actualCounts[method] += 1;
      for (const [method, count] of Object.entries(actualCounts)) {
        if (count > (max[method] ?? 0)) {
          violations.push(
            `R5: counted ${method} expects in ${key} exceed the initial shrink-only baseline`,
          );
        }
      }
    }
  }

  return [...new Set(violations)];
}

export function checkPathMethodExpectations(sources, options = {}) {
  const entries = sourceEntries(sources);
  const maskCache = options.maskCache ?? new Map();
  try {
    const classification = classifyRustTestOnlySources(entries, undefined, {
      includeAnalysis: true,
      maskCache,
    });
    return checkPathMethodExpectationsWithClassification(entries, classification, {
      ...options,
      maskCache,
    });
  } catch (error) {
    return [unclassifiableCfgViolation(error)];
  }
}

const GATE_TARGETS = Object.freeze([
  Object.freeze({
    triple: "x86_64-unknown-linux-gnu",
    values: Object.freeze({
      debug_assertions: true,
      overflow_checks: true,
      'panic="unwind"': true,
      unix: true,
      windows: false,
      desktop: true,
      mobile: false,
      'target_os="linux"': true,
      'target_family="unix"': true,
      'target_family="windows"': false,
      'target_arch="x86_64"': true,
      'target_env="gnu"': true,
      'target_env="msvc"': false,
      'target_env=""': false,
      'target_vendor="unknown"': true,
      'target_vendor="apple"': false,
      'target_vendor="pc"': false,
      'target_endian="little"': true,
      'target_pointer_width="64"': true,
    }),
  }),
  Object.freeze({
    triple: "x86_64-pc-windows-gnu",
    values: Object.freeze({
      debug_assertions: true,
      overflow_checks: true,
      'panic="unwind"': true,
      unix: false,
      windows: true,
      desktop: true,
      mobile: false,
      'target_os="windows"': true,
      'target_family="unix"': false,
      'target_family="windows"': true,
      'target_arch="x86_64"': true,
      'target_env="gnu"': true,
      'target_env="msvc"': false,
      'target_env=""': false,
      'target_vendor="unknown"': false,
      'target_vendor="apple"': false,
      'target_vendor="pc"': true,
      'target_endian="little"': true,
      'target_pointer_width="64"': true,
    }),
  }),
  Object.freeze({
    triple: "x86_64-pc-windows-msvc",
    values: Object.freeze({
      debug_assertions: true,
      overflow_checks: true,
      'panic="unwind"': true,
      unix: false,
      windows: true,
      desktop: true,
      mobile: false,
      'target_os="windows"': true,
      'target_family="unix"': false,
      'target_family="windows"': true,
      'target_arch="x86_64"': true,
      'target_env="gnu"': false,
      'target_env="msvc"': true,
      'target_env=""': false,
      'target_vendor="unknown"': false,
      'target_vendor="apple"': false,
      'target_vendor="pc"': true,
      'target_endian="little"': true,
      'target_pointer_width="64"': true,
    }),
  }),
  Object.freeze({
    triple: "aarch64-apple-darwin",
    values: Object.freeze({
      debug_assertions: true,
      overflow_checks: true,
      'panic="unwind"': true,
      unix: true,
      windows: false,
      desktop: true,
      mobile: false,
      'target_os="macos"': true,
      'target_family="unix"': true,
      'target_family="windows"': false,
      'target_arch="aarch64"': true,
      'target_env="gnu"': false,
      'target_env="msvc"': false,
      'target_env=""': true,
      'target_vendor="unknown"': false,
      'target_vendor="apple"': true,
      'target_vendor="pc"': false,
      'target_endian="little"': true,
      'target_pointer_width="64"': true,
    }),
  }),
  Object.freeze({
    triple: "x86_64-apple-darwin",
    values: Object.freeze({
      debug_assertions: true,
      overflow_checks: true,
      'panic="unwind"': true,
      unix: true,
      windows: false,
      desktop: true,
      mobile: false,
      'target_os="macos"': true,
      'target_family="unix"': true,
      'target_family="windows"': false,
      'target_arch="x86_64"': true,
      'target_env="gnu"': false,
      'target_env="msvc"': false,
      'target_env=""': true,
      'target_vendor="unknown"': false,
      'target_vendor="apple"': true,
      'target_vendor="pc"': false,
      'target_endian="little"': true,
      'target_pointer_width="64"': true,
    }),
  }),
]);

const KNOWN_BOOLEAN_CFG_ATOMS = new Set([
  "debug_assertions",
  "overflow_checks",
  "test",
  "unix",
  "windows",
  "desktop",
  "mobile",
]);
const KNOWN_STRING_CFG_ATOMS = new Set([
  "feature",
  "panic",
  "target_os",
  "target_family",
  "target_arch",
  "target_env",
  "target_vendor",
  "target_endian",
  "target_pointer_width",
]);

function cfgAtomDetails(atom) {
  const match = atom.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:=("(?:[^"\\]|\\.)*"))?$/);
  return match ? { name: match[1], value: match[2] } : null;
}

function defaultCargoFeatures(manifestText) {
  if (typeof manifestText !== "string") return new Set();
  const lines = manifestText.split("\n");
  const header = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  if (header < 0) return new Set();
  for (let index = header + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    const match = lines[index].match(/^\s*default\s*=\s*\[([^\]]*)\]\s*(?:#.*)?$/);
    if (!match) continue;
    return new Set([...match[1].matchAll(/"([^"\\]*)"/g)].map((item) => item[1]));
  }
  return new Set();
}

function cfgValuationForTarget(atoms, target, features) {
  const valuation = { test: false };
  for (const atom of atoms) {
    const detail = cfgAtomDetails(atom);
    if (!detail) continue;
    if (KNOWN_BOOLEAN_CFG_ATOMS.has(detail.name)) valuation[atom] = false;
    else if (KNOWN_STRING_CFG_ATOMS.has(detail.name)) valuation[atom] = false;
  }
  Object.assign(valuation, target.values);
  for (const atom of atoms) {
    const detail = cfgAtomDetails(atom);
    if (detail?.name === "feature" && detail.value) {
      const name = detail.value.slice(1, -1);
      valuation[atom] = features.has(name);
    }
  }
  return valuation;
}

function cfgAtomsInAnalysis(path, source, analysis, classification, lineStartsByPath, maskCache) {
  const atoms = new Set();
  const addAttribute = (attribute) => {
    for (const atom of attribute.details?.atoms ?? []) atoms.add(atom);
  };
  const regions = new Map(analysis.sourceRegions.map((region) => [region.start, region]));
  for (const group of analysis.groups) {
    const region = regions.get(group.start);
    if (
      group.testOnly ||
      isTestOnlyOffset(path, source, group.start, classification, lineStartsByPath) ||
      !region ||
      !gateScope(path, source, region, false, analysis, maskCache)
    )
      continue;
    for (const attribute of group.attributes) addAttribute(attribute);
  }
  for (const attribute of analysis.innerAttributes) {
    if (
      isTestOnlyOffset(path, source, attribute.start, classification, lineStartsByPath) ||
      !gateScope(path, source, attribute, true, analysis, maskCache)
    )
      continue;
    addAttribute(attribute.attribute);
  }
  return atoms;
}

function gateScope(path, source, region, inner = false, analysis, maskCache) {
  if (!isInfraPath(path)) return true;
  const text = inner ? region.text : source.slice(region.range.start, region.range.end);
  const masked = maskRustSource(text, maskCache);
  const insideMacro = analysis?.macroRegions?.some(
    ({ start, end }) => start <= region.start && region.start < end,
  );
  return (
    insideMacro || /\bmacro_rules\s*!/.test(masked) || /#\s*\[\s*macro_export\s*\]/.test(masked)
  );
}

function collectModuleRegionText(declaration, analyses, sourcesByPath) {
  const result = [];
  const visited = new Set();
  const visit = (currentPath) => {
    if (!currentPath || visited.has(currentPath)) return;
    visited.add(currentPath);
    const contents = sourcesByPath.get(currentPath);
    if (contents === undefined) return;
    result.push(contents);
    const analysis = analyses.get(currentPath);
    for (const child of analysis?.moduleItems ?? []) visit(child.targetPath);
  };
  visit(declaration.targetPath);
  return result.join("\n");
}

function regionIdentity(path, attributeText, regionText, maskCache) {
  const attribute = normaliseRustText(maskRustSource(attributeText, maskCache));
  const regionSha256 = sha256(normaliseRustText(regionText));
  return { path, attribute, regionSha256, id: `${path}|${attribute}|${regionSha256}` };
}

function gateInvisibleContentViolations(path, line, text, maskCache) {
  const violations = [];
  const masked = maskRustSource(text, maskCache);
  const methods = methodTokens(text, maskCache);
  if (methods.length) {
    violations.push(
      `${path}:${line}: R5: gate-invisible pinned region contains Path method name(s): ${[...new Set(methods)].join(", ")}`,
    );
  }
  if (hasMacroInvocation(text, maskCache)) {
    violations.push(
      `${path}:${line}: R5: gate-invisible pinned region may not contain a macro invocation`,
    );
  }
  if (/\bmod\s+[A-Za-z_][A-Za-z0-9_]*\s*;/.test(masked)) {
    violations.push(
      `${path}:${line}: R5: gate-invisible pinned region may not declare an out-of-line module`,
    );
  }
  return violations;
}

export function checkGateInvisibleRegions(
  entries,
  classification,
  {
    initialBaseline = INITIAL_GATE_REGION_BASELINE,
    baseline = GATE_REGION_BASELINE,
    workspaceRoot = process.cwd(),
    presentPaths,
    structuralCache,
    lineStartsByPath: suppliedLineStartsByPath,
    maskCache: suppliedMaskCache,
  } = {},
) {
  entries = sourceEntries(entries);
  const callStructuralCache = structuralCache ?? createRustTestOnlyStructuralCache();
  const lineStartsByPath =
    suppliedLineStartsByPath ??
    classification.lineStartsByPath ??
    new Map(entries.map(({ path, contents }) => [path, sourceLineStarts(contents)]));
  const maskCache = suppliedMaskCache ?? new Map();
  const violations = [];
  const sourceByPath = new Map(entries.map(({ path, contents }) => [path, contents]));
  const analyses = classification.analysis;
  const allAtoms = new Set();
  for (const { path, contents } of entries) {
    const analysis = analyses.get(path);
    if (!analysis) continue;
    for (const atom of cfgAtomsInAnalysis(
      path,
      contents,
      analysis,
      classification,
      lineStartsByPath,
      maskCache,
    ))
      allAtoms.add(atom);
  }
  const unknownAtoms = [];
  for (const atom of allAtoms) {
    const detail = cfgAtomDetails(atom);
    if (
      !detail ||
      (!KNOWN_BOOLEAN_CFG_ATOMS.has(detail.name) && !KNOWN_STRING_CFG_ATOMS.has(detail.name))
    ) {
      unknownAtoms.push(atom);
    }
  }
  if (unknownAtoms.length) {
    for (const atom of unknownAtoms.sort()) violations.push(`R5: unknown cfg atom ${atom}`);
  }

  for (const { path, contents } of entries) {
    const analysis = analyses.get(path);
    if (!analysis) continue;
    for (const group of analysis.groups) {
      if (isTestOnlyOffset(path, contents, group.start, classification, lineStartsByPath)) continue;
      const region = analysis.sourceRegions.find((item) => item.start === group.start);
      if (!region || !gateScope(path, contents, region, false, analysis, maskCache)) continue;
      for (const attribute of group.attributes) {
        if (attribute.details?.containsCfgPayload) {
          violations.push(
            `${path}:${lineAt(contents, attribute.start)}: R5: cfg_attr payload may not introduce a nested cfg predicate`,
          );
        }
      }
    }
    for (const inner of analysis.innerAttributes) {
      if (isTestOnlyOffset(path, contents, inner.start, classification, lineStartsByPath)) continue;
      if (
        gateScope(path, contents, inner, true, analysis, maskCache) &&
        inner.attribute.details?.containsCfgPayload
      ) {
        violations.push(
          `${path}:${lineAt(contents, inner.start)}: R5: cfg_attr payload may not introduce a nested cfg predicate`,
        );
      }
    }
  }

  const manifestPath = "src-tauri/Cargo.toml";
  let manifest = null;
  try {
    manifest = readFileSync(resolve(workspaceRoot, manifestPath), "utf8");
  } catch {
    // The filesystem check reports the missing or unreadable package manifest below.
  }
  const features = defaultCargoFeatures(manifest);
  const gateResults = [];
  for (const target of GATE_TARGETS) {
    const valuation = cfgValuationForTarget(allAtoms, target, features);
    try {
      gateResults.push(
        classifyRustTestOnlySources(entries, valuation, {
          includeAnalysis: true,
          structuralCache: callStructuralCache,
          maskCache,
        }),
      );
    } catch (error) {
      violations.push(unclassifiableCfgViolation(error));
      return [...new Set(violations)];
    }
  }

  const commonLines = new Map();
  const paths = new Set(gateResults.flatMap((result) => [...result.excludedLines.keys()]));
  for (const path of paths) {
    const sets = gateResults.map((result) => result.excludedLines.get(path) ?? new Set());
    commonLines.set(
      path,
      new Set([...sets[0]].filter((line) => sets.every((set) => set.has(line)))),
    );
  }

  const actualRegions = [];
  for (const { path, contents } of entries) {
    const analysis = analyses.get(path);
    if (!analysis) continue;
    for (const region of analysis.sourceRegions) {
      if (isTestOnlyOffset(path, contents, region.start, classification, lineStartsByPath))
        continue;
      if (!gateScope(path, contents, region, false, analysis, maskCache)) continue;
      const regionLine = lineAt(contents, region.start);
      const allExcluded = commonLines.get(path)?.has(regionLine) === true;
      if (!allExcluded) continue;

      const moduleOwner = gateResults
        .map((result) => ({
          analyses: result.analysis,
          declaration: result.analysis
            .get(path)
            ?.moduleItems.find(
              (item) => item.attributeGroupStarts.includes(region.start) && item.targetPath,
            ),
        }))
        .find(({ declaration }) => declaration);
      const moduleText = moduleOwner
        ? collectModuleRegionText(moduleOwner.declaration, moduleOwner.analyses, sourceByPath)
        : "";
      const regionText = contents.slice(region.range.start, region.range.end) + moduleText;
      actualRegions.push(regionIdentity(path, region.text, regionText, maskCache));
      violations.push(...gateInvisibleContentViolations(path, regionLine, regionText, maskCache));
    }

    for (const inner of analysis.innerAttributes) {
      if (isTestOnlyOffset(path, contents, inner.start, classification, lineStartsByPath)) continue;
      if (!gateScope(path, contents, inner, true, analysis, maskCache)) continue;
      const allExcluded = gateResults.every((result) => {
        const candidate = result.analysis
          .get(path)
          ?.innerAttributes.find((item) => item.start === inner.start);
        return (
          candidate?.attribute.details?.excluded === true &&
          result.excludedLines.get(path)?.has(lineAt(contents, inner.start))
        );
      });
      const pinnedRootAttribute =
        inner.root &&
        ["cfg", "cfg_attr"].includes(inner.attribute.details?.kind) &&
        !exactMainTestAllowance(path, inner, maskCache);
      if (!allExcluded && !pinnedRootAttribute) continue;
      const identity = regionIdentity(path, inner.text, inner.text, maskCache);
      actualRegions.push(identity);
      violations.push(
        ...gateInvisibleContentViolations(
          path,
          lineAt(contents, inner.start),
          inner.text,
          maskCache,
        ),
      );
    }
  }

  const actualCounts = new Map();
  for (const region of actualRegions)
    actualCounts.set(region.id, (actualCounts.get(region.id) ?? 0) + 1);
  const baselineId = (entry) =>
    `${entry.path}|${normaliseRustText(maskRustSource(entry.attribute, maskCache))}|${entry.regionSha256}`;
  const initialIds = initialBaseline.map(baselineId);
  const baselineIds = baseline.map(baselineId);
  const baselineCounts = Object.fromEntries(baselineIds.map((id) => [id, 1]));
  const regionMessages = {
    pathFor: (id) => id.split("|", 1)[0],
    added: (_id, path) => `pinned gate region at ${path} is not part of the shrink-only baseline`,
    residency: (_id, path) =>
      `pinned gate-region path ${path} is not present in the working tree and must be removed`,
    empty: (id) => `pinned gate region ${id} no longer exists and must be removed`,
    mismatch: (id, _path, measured, expected) =>
      `pinned gate region ${id} occurs ${measured} time(s), baseline ${expected}`,
  };
  violations.push(
    ...validateShrinkOnlyBaseline({
      rule: "R5",
      initialBaseline: initialIds,
      baseline: baselineIds,
      counts: baselineCounts,
      measure: (id) => actualCounts.get(id) ?? 0,
      measurePresentPaths: entries.map(({ path }) => path),
      presentPaths,
      messages: regionMessages,
    }),
  );
  for (const region of actualRegions) {
    if (!baselineIds.includes(region.id)) {
      violations.push(
        `R5: gate-invisible region ${region.path} is not in the pinned shrink-only baseline`,
      );
    }
  }
  return [...new Set(violations)];
}

function scanToml(contents, allowVendoredPatches = false) {
  const approvedVendoredPatches = [
    ["patch.crates-io", 'pgn-reader = { path = "vendor/pgn-reader" }'],
    [
      "patch.https://github.com/franciscoBSalgueiro/vampirc-uci",
      'vampirc-uci = { path = "vendor/vampirc-uci" }',
    ],
  ];
  const bareCode = [];
  const keySegments = [];
  const basicStringBackslashes = [];
  const lines = contents.split("\n");
  let multilineQuote = null;
  let tableSegments = [];

  const parseSegments = (text) => {
    const segments = [];
    let cursor = 0;
    while (cursor < text.length) {
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] === ".") {
        cursor += 1;
        continue;
      }
      const opening = text[cursor];
      if (opening === '"' || opening === "'") {
        const closing = text.indexOf(opening, cursor + 1);
        if (closing < 0) break;
        segments.push(text.slice(cursor + 1, closing));
        cursor = closing + 1;
      } else {
        const match = text.slice(cursor).match(/^[A-Za-z0-9_-]+/);
        if (!match) break;
        segments.push(match[0]);
        cursor += match[0].length;
      }
      while (/\s/.test(text[cursor] ?? "")) cursor += 1;
      if (text[cursor] !== ".") break;
    }
    return segments;
  };

  for (const line of lines) {
    const masked = line.split("");
    const startedInMultiline = multilineQuote !== null;
    let quote = multilineQuote;
    let triple = quote !== null;
    let escaped = false;
    let comment = line.length;
    const equalPositions = [];
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (quote) {
        masked[index] = " ";
        if (quote === '"' && character === "\\" && !escaped) {
          basicStringBackslashes.push(index);
          escaped = true;
          continue;
        }
        const closes = triple
          ? line.slice(index, index + 3) === quote.repeat(3) && !escaped
          : character === quote && !escaped;
        if (closes) {
          if (triple) {
            masked[index + 1] = " ";
            masked[index + 2] = " ";
            index += 2;
          }
          quote = null;
          triple = false;
          multilineQuote = null;
        }
        escaped = false;
      } else if (character === '"' || character === "'") {
        quote = character;
        triple = line.slice(index, index + 3) === character.repeat(3);
        if (triple) {
          masked[index] = " ";
          masked[index + 1] = " ";
          masked[index + 2] = " ";
          index += 2;
          multilineQuote = character;
        }
        escaped = false;
        masked[index] = " ";
      } else if (character === "#") {
        comment = index;
        for (let rest = index; rest < line.length; rest += 1) masked[rest] = " ";
        break;
      } else if (character === "=") {
        equalPositions.push(index);
      }
    }
    if (!triple) multilineQuote = null;
    bareCode.push(masked.join(""));

    if (!startedInMultiline) {
      const trimmed = line.slice(0, comment).trim();
      if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
        tableSegments = parseSegments(trimmed.slice(2, -2));
        keySegments.push(...tableSegments);
      } else if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        tableSegments = parseSegments(trimmed.slice(1, -1));
        keySegments.push(...tableSegments);
      }
    }

    if (!startedInMultiline) {
      for (const equal of equalPositions) {
        let startAt = equal - 1;
        while (startAt >= 0 && /\s/.test(line[startAt])) startAt -= 1;
        if (startAt < 0) continue;
        let endAt = startAt + 1;
        if (line[startAt] === '"' || line[startAt] === "'") {
          let openAt = startAt - 1;
          while (openAt >= 0) {
            if (
              line[openAt] === line[startAt] &&
              (line[startAt] !== '"' || line[openAt - 1] !== "\\")
            )
              break;
            openAt -= 1;
          }
          if (openAt >= 0) startAt = openAt;
        } else {
          while (startAt >= 0 && /[A-Za-z0-9_-]/.test(line[startAt])) startAt -= 1;
          startAt += 1;
        }
        while (startAt > 0 && /\s/.test(line[startAt - 1])) startAt -= 1;
        let boundary = startAt;
        while (boundary > 0 && !/[{,]/.test(line[boundary - 1])) boundary -= 1;
        const keyText = line.slice(boundary, endAt);
        const segments = parseSegments(keyText);
        // These reviewed third-party patches are outside the application's source scope.
        // Keep every other path key subject to R5, including changes to these destinations.
        const approvedPatchPath =
          allowVendoredPatches &&
          approvedVendoredPatches.some(
            ([table, entry]) => tableSegments.join(".") === table && line.trim() === entry,
          ) &&
          segments.length === 1 &&
          segments[0] === "path";
        if (!approvedPatchPath) keySegments.push(...segments);
      }
    }
  }

  const outsideStrings = bareCode.join("\n");
  return {
    bareManifestControlTokens: [...outsideStrings.matchAll(/\b(?:lints|cargo-features)\b/g)].map(
      (match) => match[0],
    ),
    keySegments,
    basicStringBackslashes,
  };
}

function manifestViolations(path, contents, packageManifest) {
  const violations = [];
  const scanned = scanToml(contents, packageManifest);
  const keys = new Set(scanned.keySegments);
  // scanToml records both bare and quoted TOML keys in keySegments.
  const hasManifestControlKey = scanned.keySegments.some(
    (key) => key === "lints" || key === "cargo-features",
  );
  if (
    scanned.bareManifestControlTokens.length ||
    hasManifestControlKey ||
    scanned.basicStringBackslashes.length
  ) {
    violations.push(
      `${path}: R5: Cargo manifests may not define lint levels or cargo-features, and basic strings may not contain backslash escapes`,
    );
  }
  if (keys.has("profile")) {
    violations.push(`${path}: R5: Cargo manifests may not override the gate compilation profile`);
  }
  if (keys.has("path")) {
    violations.push(
      `${path}: R5: Cargo manifest path keys may add Rust code outside the pinned target`,
    );
  }
  if (packageManifest) {
    if (keys.has("build")) {
      violations.push(`${path}: R5: src-tauri/Cargo.toml may not select a different build script`);
    }
    if (["bin", "lib", "autobins", "autolib", "workspace"].some((key) => keys.has(key))) {
      violations.push(`${path}: R5: may not change the production target roots`);
    }
  }
  return violations;
}

function lstatIfPresent(absolutePath) {
  try {
    return lstatSync(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function inspectGitTree(workspaceRoot, runGit) {
  const violations = [];
  const stageArgs = ["ls-files", "--stage", "-z", "--", "src-tauri"];
  const staged = runGit("git", stageArgs, { cwd: workspaceRoot, encoding: "utf8" });
  if (staged.error || staged.status !== 0) {
    throw new Error(
      `R5: cannot inspect gitlinks under src-tauri (${staged.error?.message ?? staged.stderr ?? staged.status})`,
    );
  }
  for (const entry of String(staged.stdout ?? "")
    .split("\0")
    .filter(Boolean)) {
    const match = entry.match(/^160000\s+[^\t]+\t(.+)$/);
    const path = match?.[1];
    if (
      path &&
      (path === "src-tauri" || path === "src-tauri/src" || path.startsWith("src-tauri/src/"))
    ) {
      violations.push(`${path}: R5: gitlink source trees are not allowed`);
    }
  }

  // Walk every real directory from the package root down through src-tauri/src: git reports an
  // untracked or ignored directory as one collapsed entry, so its listing cannot find a nested
  // repository deeper inside it.
  const visited = new Set();
  const inSourceTree = (path) =>
    path === "src-tauri" || path === "src-tauri/src" || path.startsWith("src-tauri/src/");
  const walkDirectory = (path) => {
    if (!inSourceTree(path) || visited.has(path)) return;
    const absolutePath = resolve(workspaceRoot, path);
    const stats = lstatIfPresent(absolutePath);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) return;
    visited.add(path);

    if (lstatIfPresent(join(absolutePath, ".git"))) {
      violations.push(
        `${path}: R5: untracked nested git repositories are not allowed in the Rust source tree`,
      );
    }

    for (const name of readdirSync(absolutePath)) {
      if (name === ".git") continue;
      const childPath = `${path}/${name}`;
      if (!inSourceTree(childPath)) continue;
      const childPathOnDisk = join(absolutePath, name);
      const childStats = lstatIfPresent(childPathOnDisk);
      if (childStats?.isDirectory() && !childStats.isSymbolicLink()) walkDirectory(childPath);
    }
  };
  walkDirectory("src-tauri");
  return violations;
}

function checkRepositoryInputs({ workspaceRoot, runGit = spawnSync }) {
  const violations = [];
  const fixedRoots = [
    ["src-tauri", "directory"],
    ["src-tauri/src", "directory"],
    ["src-tauri/Cargo.toml", "file"],
    ["src-tauri/build.rs", "file"],
    ["src-tauri/src/main.rs", "file"],
    ["src-tauri/clippy.toml", "file"],
  ];
  for (const [path, kind] of fixedRoots) {
    const absolutePath = resolve(workspaceRoot, path);
    const stats = lstatIfPresent(absolutePath);
    if (!stats) {
      violations.push(`${path}: R5: required pinned input is missing`);
      continue;
    }
    if (stats.isSymbolicLink()) {
      violations.push(`${path}: R5: pinned Rust roots and inputs may not be symbolic links`);
    } else if (kind === "directory" ? !stats.isDirectory() : !stats.isFile()) {
      violations.push(`${path}: R5: pinned Rust ${kind} has the wrong filesystem type`);
    }
  }

  const listedSourcePaths = listWorkingTreeFiles({
    workspaceRoot,
    pathspec: "src-tauri/src",
    runGit,
    includeIgnored: true,
  });
  for (const listedPath of listedSourcePaths) {
    const path = listedPath.replace(/\/$/, "");
    if (!path.startsWith("src-tauri/src/")) continue;
    const parts = path.split("/");
    let current = workspaceRoot;
    for (let index = 0; index < parts.length; index += 1) {
      current = join(current, parts[index]);
      const stats = lstatIfPresent(current);
      if (!stats?.isSymbolicLink()) continue;
      let targetIsDirectory = false;
      try {
        targetIsDirectory = statSync(current).isDirectory();
      } catch {
        // A dangling Rust path is also unreadable by the checker and is rejected below.
      }
      if (targetIsDirectory || (index === parts.length - 1 && extname(path) === ".rs")) {
        violations.push(
          `${path}: R5: symbolic links to Rust source files or directories are not allowed`,
        );
        break;
      }
    }
  }

  for (const path of [".cargo/config", ".cargo/config.toml"]) {
    if (lstatIfPresent(resolve(workspaceRoot, path))) {
      violations.push(`${path}: R5: repository Cargo configuration is not allowed`);
    }
  }
  if (lstatIfPresent(resolve(workspaceRoot, "src-tauri/.clippy.toml"))) {
    violations.push("src-tauri/.clippy.toml: R5: shadowing clippy configuration is not allowed");
  }

  const clippyPath = resolve(workspaceRoot, "src-tauri/clippy.toml");
  try {
    const contents = readFileSync(clippyPath);
    if (!contents.equals(Buffer.from(EXPECTED_CLIPPY_TOML))) {
      violations.push(
        `src-tauri/clippy.toml: R5: clippy configuration differs from the pinned text; expected exactly:\n${EXPECTED_CLIPPY_TOML}`,
      );
    }
  } catch (error) {
    violations.push(
      `src-tauri/clippy.toml: R5: cannot read pinned clippy configuration; expected exactly:\n${EXPECTED_CLIPPY_TOML} (${error.message})`,
    );
  }

  try {
    const buildScript = readFileSync(resolve(workspaceRoot, "src-tauri/build.rs"));
    const actualHash = sha256(buildScript);
    if (actualHash !== BUILD_SCRIPT_SHA256) {
      violations.push(`src-tauri/build.rs: R5: build script differs from its pinned SHA-256`);
    }
  } catch (error) {
    violations.push(`src-tauri/build.rs: R5: cannot read pinned build script (${error.message})`);
  }

  for (const [path, packageManifest] of [
    ["src-tauri/Cargo.toml", true],
    ["Cargo.toml", false],
  ]) {
    const absolutePath = resolve(workspaceRoot, path);
    const stats = lstatIfPresent(absolutePath);
    if (!stats) {
      if (packageManifest) violations.push(`${path}: R5: required pinned input is missing`);
      continue;
    }
    try {
      violations.push(
        ...manifestViolations(path, readFileSync(absolutePath, "utf8"), packageManifest),
      );
    } catch (error) {
      violations.push(`${path}: R5: cannot read Cargo manifest (${error.message})`);
    }
  }

  violations.push(...inspectGitTree(workspaceRoot, runGit));
  return [...new Set(violations)];
}

export function checkRustReleaseSurface(sources, allowlist = DEAD_CODE_ALLOWLIST, options = {}) {
  const entries = sourceEntries(sources);
  // Both mask and structural caches retain only inputs reachable during this checker invocation.
  const maskCache = new Map();
  const violations = checkDeadCodeSurface(entries, allowlist, maskCache);
  // Both the default classification and all gate-target evaluations share this call-bounded cache.
  const structuralCache = options.structuralCache ?? createRustTestOnlyStructuralCache();
  let classification;
  try {
    classification = classifyRustTestOnlySources(entries, undefined, {
      includeAnalysis: options.includeR5 === true,
      structuralCache,
      maskCache,
    });
  } catch (error) {
    return [...violations, unclassifiableCfgViolation(error)];
  }
  violations.push(
    ...entries.flatMap(({ path, contents }) =>
      checkFaultInjectionSurfaceWithClassification(path, contents, classification, maskCache),
    ),
    ...checkFilesystemSurfaceWithClassification(
      entries,
      FS_SURFACE_ALLOWLIST,
      INITIAL_FS_SURFACE_COUNTS,
      classification,
      maskCache,
    ),
  );
  if (options.includeR5) {
    violations.push(
      ...checkPathMethodExpectationsWithClassification(entries, classification, {
        presentPaths: options.checkResidency ? entries.map(({ path }) => path) : undefined,
        lineStartsByPath: classification.lineStartsByPath,
        maskCache,
      }),
      ...checkGateInvisibleRegions(entries, classification, {
        workspaceRoot: options.workspaceRoot,
        presentPaths: options.checkResidency ? entries.map(({ path }) => path) : undefined,
        structuralCache,
        lineStartsByPath: classification.lineStartsByPath,
        maskCache,
      }),
    );
    if (options.workspaceRoot) {
      violations.push(
        ...checkRepositoryInputs({
          workspaceRoot: options.workspaceRoot,
          runGit: options.runGit ?? spawnSync,
        }),
      );
    }
  }
  return [...new Set(violations)];
}

export function listRustSources(workspaceRoot, runGit = spawnSync) {
  return listWorkingTreeFiles({
    workspaceRoot,
    pathspec: "src-tauri/src",
    runGit,
    includeIgnored: true,
  }).filter((path) => path.startsWith("src-tauri/src/") && path.endsWith(".rs"));
}

export function runReleaseSurfaceCheck({
  workspaceRoot = process.cwd(),
  listFiles = listRustSources,
  readFile = (path) => readFileSync(path, "utf8"),
  checkResidency = false,
  paths = listFiles(workspaceRoot),
} = {}) {
  const sources = new Map();
  for (const path of paths) {
    const absolutePath = resolve(workspaceRoot, path);
    if (lstatIfPresent(absolutePath)?.isSymbolicLink()) {
      throw new Error(
        `${path}: R5: symbolic links to Rust source files or directories are not allowed`,
      );
    }
    try {
      sources.set(path, readFile(absolutePath));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read Rust source ${path}: ${detail}`);
    }
  }

  const violations = checkRustReleaseSurface(sources, DEAD_CODE_ALLOWLIST, {
    includeR5: true,
    workspaceRoot,
    checkResidency,
  });
  if (violations.length)
    throw new Error(`Rust release-surface violations:\n${violations.join("\n")}`);
  return paths;
}

if (isEntrypoint(import.meta.url)) {
  try {
    const paths = listRustSources(process.cwd());
    const residency = process.argv.includes("--check-allowlist-residency")
      ? checkAllowlistResidency(paths)
      : [];
    let surfaceFailure = null;
    try {
      runReleaseSurfaceCheck({
        paths,
        checkResidency: process.argv.includes("--check-allowlist-residency"),
      });
    } catch (error) {
      surfaceFailure = error instanceof Error ? error.message : String(error);
    }
    if (surfaceFailure) console.error(surfaceFailure);
    if (residency.length)
      console.error(`Rust release-surface violations:\n${residency.join("\n")}`);
    if (surfaceFailure || residency.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
