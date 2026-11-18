import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isEntrypoint } from "./entrypoint.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

export const CONTENTS_WRITE_WORKFLOWS = new Set(["release.yml"]);
export const WRITE_JOB_ALLOWED_ACTIONS = new Set([
  "actions/checkout",
  "actions/setup-node",
  "dtolnay/rust-toolchain",
  // Windows signing login and logout, read in full at the pinned commit (d-20261118-02).
  "jay0lee/certum-cloud-code-sign",
  "jay0lee/certum-cloud-code-sign/teardown",
  "pnpm/action-setup",
  "swatinem/rust-cache",
  "tauri-apps/tauri-action",
]);

const ACTIONLINT_PACKAGE = "github-actionlint@1.7.12";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/iu;
const PERMISSION_VALUES = new Set(["read", "write", "none"]);
const BLOCK_SCALAR = /^[>|][1-9]?[+-]?$/u;

function yamlError(path, line, message) {
  throw new Error(`${path}:${line}: cannot parse workflow YAML confidently: ${message}`);
}

function scanQuoted(text, path, line, visit) {
  let quote;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === '"' && character === "\\") index += 1;
    else if (quote === "'" && character === "'" && text[index + 1] === "'") index += 1;
    else if (quote && character === quote) quote = undefined;
    else if (!quote && (character === '"' || character === "'")) quote = character;
    else if (!quote) {
      const result = visit(character, index);
      if (result !== undefined) return result;
    }
  }
  if (quote) yamlError(path, line, "unterminated quoted string");
  return -1;
}

function stripComment(text, path, line) {
  const index = scanQuoted(text, path, line, (character, cursor) =>
    character === "#" && (cursor === 0 || /\s/u.test(text[cursor - 1])) ? cursor : undefined,
  );
  return (index < 0 ? text : text.slice(0, index)).trimEnd();
}

function mappingEntry(text, path, line) {
  const separator = scanQuoted(text, path, line, (character, cursor) =>
    character === ":" && (cursor === text.length - 1 || /\s/u.test(text[cursor + 1]))
      ? cursor
      : undefined,
  );
  if (separator < 0) return undefined;
  const key = parseScalar(text.slice(0, separator).trim(), path, line);
  if (!key) yamlError(path, line, "mapping key must not be empty");
  return { key, value: text.slice(separator + 1).trim() };
}

function parseScalar(text, path, line) {
  if (text.startsWith('"')) {
    if (!text.endsWith('"')) yamlError(path, line, "unterminated double-quoted string");
    try {
      return JSON.parse(text);
    } catch {
      yamlError(path, line, "unsupported escape in double-quoted string");
    }
  }
  if (text.startsWith("'")) {
    if (!text.endsWith("'")) yamlError(path, line, "unterminated single-quoted string");
    return text.slice(1, -1).replaceAll("''", "'");
  }
  if (/^(?:---|\.\.\.|%)/u.test(text)) {
    yamlError(path, line, "directives and document markers are unsupported");
  }
  return text;
}

function tokenizeYaml(source, path) {
  const tokens = [];
  const lines = source.split(/\r?\n/u);
  let blockIndent;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const whitespace = /^[ \t]*/u.exec(raw)[0];
    const indent = whitespace.length;
    if (blockIndent !== undefined) {
      if (!raw.trim() || indent > blockIndent) continue;
      blockIndent = undefined;
    }
    if (whitespace.includes("\t"))
      yamlError(path, index + 1, "tabs are not allowed for indentation");
    const text = stripComment(raw.slice(indent), path, index + 1);
    if (!text) continue;
    const item = text === "-" ? "" : text.startsWith("- ") ? text.slice(2) : text;
    if (BLOCK_SCALAR.test(mappingEntry(item, path, index + 1)?.value ?? "")) blockIndent = indent;
    tokens.push({ indent, line: index + 1, text });
  }
  return tokens;
}

function assignEntry(target, entry, tokens, cursor, parentIndent, path) {
  if (Object.hasOwn(target, entry.key)) {
    yamlError(path, tokens[cursor].line, `duplicate mapping key ${JSON.stringify(entry.key)}`);
  }
  if (entry.value) {
    target[entry.key] = parseScalar(entry.value, path, tokens[cursor].line);
    return cursor + 1;
  }
  const next = tokens[cursor + 1];
  if (next && next.indent > parentIndent) {
    const parsed = parseNode(tokens, cursor + 1, next.indent, path);
    target[entry.key] = parsed.value;
    return parsed.cursor;
  }
  target[entry.key] = null;
  return cursor + 1;
}

function parseMapping(tokens, start, indent, path) {
  const value = {};
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor].indent === indent) {
    const token = tokens[cursor];
    if (token.text === "-" || token.text.startsWith("- ")) break;
    const entry = mappingEntry(token.text, path, token.line);
    if (!entry) yamlError(path, token.line, "expected a mapping entry");
    cursor = assignEntry(value, entry, tokens, cursor, indent, path);
  }
  return { value, cursor };
}

function parseSequenceMapping(tokens, cursor, indent, itemText, path) {
  const token = tokens[cursor];
  const value = {};
  const first = mappingEntry(itemText, path, token.line);
  const mappingIndent = indent + 2;
  cursor = assignEntry(value, first, tokens, cursor, mappingIndent, path);
  while (cursor < tokens.length && tokens[cursor].indent === mappingIndent) {
    const continuation = tokens[cursor];
    const entry = mappingEntry(continuation.text, path, continuation.line);
    if (!entry) yamlError(path, continuation.line, "expected a mapping entry in sequence item");
    cursor = assignEntry(value, entry, tokens, cursor, mappingIndent, path);
  }
  return { value, cursor };
}

function parseSequence(tokens, start, indent, path) {
  const value = [];
  let cursor = start;
  while (cursor < tokens.length && tokens[cursor].indent === indent) {
    const token = tokens[cursor];
    if (!(token.text === "-" || token.text.startsWith("- "))) break;
    const itemText = token.text === "-" ? "" : token.text.slice(2).trim();
    if (!itemText) {
      const next = tokens[cursor + 1];
      if (!next || next.indent <= indent)
        yamlError(path, token.line, "sequence item must not be empty");
      const parsed = parseNode(tokens, cursor + 1, next.indent, path);
      value.push(parsed.value);
      cursor = parsed.cursor;
    } else if (mappingEntry(itemText, path, token.line)) {
      const parsed = parseSequenceMapping(tokens, cursor, indent, itemText, path);
      value.push(parsed.value);
      cursor = parsed.cursor;
    } else {
      value.push(parseScalar(itemText, path, token.line));
      cursor += 1;
    }
  }
  return { value, cursor };
}

function parseNode(tokens, start, indent, path) {
  const token = tokens[start];
  if (!token || token.indent !== indent) yamlError(path, token?.line ?? 1, "invalid indentation");
  return token.text === "-" || token.text.startsWith("- ")
    ? parseSequence(tokens, start, indent, path)
    : parseMapping(tokens, start, indent, path);
}

function parseWorkflowYaml(source, path) {
  const tokens = tokenizeYaml(source, path);
  if (tokens.length === 0) yamlError(path, 1, "workflow must not be empty");
  if (tokens[0].indent !== 0)
    yamlError(path, tokens[0].line, "top-level mapping must start at column 1");
  const parsed = parseNode(tokens, 0, 0, path);
  if (parsed.cursor !== tokens.length) {
    yamlError(
      path,
      tokens[parsed.cursor].line,
      "inconsistent indentation or mixed collection types",
    );
  }
  if (Array.isArray(parsed.value)) yamlError(path, tokens[0].line, "workflow must be a mapping");
  return parsed.value;
}

function parsePermissions(value, path, scope) {
  if (value === "read-all" || value === "write-all") return value;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${path}: ${scope}: permissions must be a flat mapping`);
  }
  for (const [name, permission] of Object.entries(value)) {
    if (!PERMISSION_VALUES.has(permission)) {
      throw new Error(`${path}: ${scope}: permission ${name} must be read, write, or none`);
    }
  }
  return value;
}

function permissionValue(permissions, name) {
  if (permissions === "write-all") return "write";
  if (permissions === "read-all") return "read";
  return permissions[name] ?? "none";
}

function allowedWriteAction(reference) {
  if (typeof reference !== "string") return false;
  const separator = reference.lastIndexOf("@");
  if (separator < 0) return false;
  return (
    WRITE_JOB_ALLOWED_ACTIONS.has(reference.slice(0, separator)) &&
    FULL_COMMIT_SHA.test(reference.slice(separator + 1))
  );
}

export function checkWorkflowText(text, path) {
  const workflow = parseWorkflowYaml(text, path);
  const findings = [];
  let workflowPermissions = {};
  if (!("permissions" in workflow))
    findings.push(`${path}: top-level permissions must be explicit`);
  else {
    workflowPermissions = parsePermissions(workflow.permissions, path, "workflow");
    if (permissionValue(workflowPermissions, "id-token") === "write") {
      findings.push(`${path}: workflow permissions must not grant id-token: write`);
    }
    if (
      permissionValue(workflowPermissions, "contents") === "write" &&
      !CONTENTS_WRITE_WORKFLOWS.has(basename(path))
    ) {
      findings.push(`${path}: workflow contents: write is not allowlisted`);
    }
  }

  if (!workflow.jobs || Array.isArray(workflow.jobs) || typeof workflow.jobs !== "object") {
    throw new Error(`${path}: jobs must be a non-empty mapping`);
  }
  const jobs = Object.entries(workflow.jobs);
  if (jobs.length === 0) throw new Error(`${path}: jobs must be a non-empty mapping`);
  for (const [label, job] of jobs) {
    if (!job || Array.isArray(job) || typeof job !== "object") {
      throw new Error(`${path}: every job must be a mapping`);
    }
    const explicit =
      "permissions" in job ? parsePermissions(job.permissions, path, `job ${label}`) : undefined;
    if (explicit && permissionValue(explicit, "id-token") === "write") {
      findings.push(`${path}: job ${label} must not grant id-token: write`);
    }
    if (permissionValue(explicit ?? workflowPermissions, "contents") !== "write") continue;
    if (!CONTENTS_WRITE_WORKFLOWS.has(basename(path))) {
      findings.push(`${path}: job ${label} has non-allowlisted contents: write`);
    }
    if ("steps" in job && !Array.isArray(job.steps)) {
      throw new Error(`${path}: job ${label}: steps must be a sequence`);
    }
    const references = "uses" in job ? [job.uses] : [];
    for (const step of job.steps ?? []) {
      if (!step || Array.isArray(step) || typeof step !== "object") {
        throw new Error(`${path}: job ${label}: every step must be a mapping`);
      }
      if ("uses" in step) references.push(step.uses);
    }
    for (const reference of references) {
      if (!allowedWriteAction(reference)) {
        findings.push(
          `${path}: job ${label}: Action ${JSON.stringify(reference)} is not an allowlisted action pinned to a 40-character commit SHA`,
        );
      }
    }
  }
  return findings;
}

const WORKFLOW_DIRECTORY = ".github/workflows";

/**
 * Enumerate through the shared working-tree walker rather than recursing here,
 * so ignore, symlink and untracked handling cannot drift away from the other
 * gate checkers (`f-20260901-16`). An untracked or symlinked workflow is
 * checked rather than silently skipped; nested directories are not workflow
 * files to GitHub and stay out.
 */
export async function workflowPaths(repoRoot) {
  return listWorkingTreeFiles({ workspaceRoot: repoRoot, pathspec: WORKFLOW_DIRECTORY })
    .filter(
      (path) =>
        dirname(path) === WORKFLOW_DIRECTORY && (path.endsWith(".yml") || path.endsWith(".yaml")),
    )
    .map((path) => resolve(repoRoot, path))
    .sort();
}

export async function checkWorkflowPermissions(repoRoot) {
  const findings = [];
  for (const path of await workflowPaths(repoRoot)) {
    findings.push(...checkWorkflowText(await readFile(path, "utf8"), path));
  }
  return findings.sort();
}

function actionlint(argumentsList, allowMissing) {
  const probe = spawnSync("pnpm", ["dlx", ACTIONLINT_PACKAGE, "--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    const reason =
      probe.error?.message ?? ((probe.stderr || probe.stdout).trim() || "fetch failed");
    const outcome = allowMissing ? "SKIP" : "FAIL";
    (allowMissing ? console.warn : console.error)(
      `actionlint: ${outcome} (${ACTIONLINT_PACKAGE} unavailable: ${reason})`,
    );
    return allowMissing ? 0 : 1;
  }
  const result = spawnSync("pnpm", ["dlx", ACTIONLINT_PACKAGE, ...argumentsList], {
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    const outcome = allowMissing ? "SKIP" : "FAIL";
    (allowMissing ? console.warn : console.error)(
      `actionlint: ${outcome} (${result.error.message})`,
    );
    return allowMissing ? 0 : 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  console.log(`actionlint: OK (${ACTIONLINT_PACKAGE})`);
  return 0;
}

async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--actionlint") {
    const actionlintArguments = argumentsList.slice(1);
    const flagIndex = actionlintArguments.indexOf("--allow-missing-actionlint");
    const allowMissing = flagIndex >= 0;
    if (allowMissing) actionlintArguments.splice(flagIndex, 1);
    return actionlint(actionlintArguments, allowMissing);
  }
  if (argumentsList.length > 0) throw new Error(`Unknown argument: ${argumentsList[0]}`);
  const findings = await checkWorkflowPermissions(process.cwd());
  if (findings.length > 0) {
    console.error("Workflow permissions check: FAIL");
    for (const finding of findings) console.error(`  * ${finding}`);
    return 1;
  }
  console.log("Workflow permissions check: OK");
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 2;
    });
}
