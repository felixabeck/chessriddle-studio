// Historical evidence: docs/context/RULE-HISTORY.md → scripts/check-gate-routing.mjs.
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { globToRegExp, matches } from "./coverage-scope.mjs";
import { isEntrypoint } from "./entrypoint.mjs";
import { GATES } from "./gate-receipt.mjs";
import { preReviewGateScheduleCommands, pushGateScheduleCommands } from "./run-push-gates.mjs";
import { listWorkingTreeFiles } from "./working-tree-files.mjs";

const PUSH_SKILL = ".claude/skills/push/SKILL.md";
const PACKAGE_JSON = "package.json";
const TEST_WORKFLOW = ".github/workflows/test.yml";
const VITE_CONFIG = "vite.config.ts";
const CONTRACT_GATE = "gates:contract:check";
// The strict launcher takes the machine-wide heavy-gate lock and its own agents.slice scope;
// it fails closed, nests in place, and permits no command -v fallback (d-20261002-01).
const GATE_LAUNCHER = "agent-gate";
// The final push gate first takes agent-kit's cross-repository push lock, before the
// launcher queues for a machine slot (agent-kit d-20261105-01).
const PUSH_LOCK_GATE = 'bash "$HOME/.claude/scripts/push-lock.sh" gate --';
const GATE_RUNNER_SCRIPTS = Object.freeze({
  "gates:push": `${PUSH_LOCK_GATE} ${GATE_LAUNCHER} node scripts/run-push-gates.mjs`,
  "checks:pre-review": `${GATE_LAUNCHER} node scripts/run-push-gates.mjs --pre-review`,
  "gate:ensure": `${GATE_LAUNCHER} node scripts/gate-receipt.mjs ensure`,
  "gate:run": `${GATE_LAUNCHER} node scripts/gate-receipt.mjs run`,
});
// The kit-parity gate must run the RELEASED kit. `kit` on PATH resolves to
// $HOME/.local/share/agent-kit/current/bin/kit, an immutable release worktree
// that only a gated agent-kit push publishes. A script spelling out a path into
// ~/Projekte/agent-kit would run whatever is saved in that checkout right now,
// including half-written edits, which is what the release channel exists to keep
// out of this gate. Reachability alone does not catch that, so it is asserted here.
const KIT_PARITY_SCRIPT = "findings:kit:check";
const KIT_PARITY_COMMAND = "env -u KIT_ROOT kit sync --check .";
const KIT_WORKBENCH_PATH = "Projekte/agent-kit";
// CI membership is validated against executable scheduler routes.
const CI_REQUIRED_SCRIPTS = new Set([
  "test:coverage",
  "coverage:frontend:check",
  "build-vite",
  "bindings:check",
  "bundle:check",
  "test:e2e:container",
  "mutation:frontend",
  "test:coverage:backend",
  "coverage:backend:check",
]);

const ALLOWED_CARGO_COMMANDS = new Set(["fmt", "check", "clippy", "test"]);
// This closed list mirrors the repository's deliberate test naming conventions:
// node:test uses *-tests.mjs, Vitest uses *.test.mjs, Python uses *-tests.py or
// *_test.py, and shell tests use *-tests.sh. Keeping it closed prevents arbitrary
// script names from being silently treated as tests instead of routed tools.
const TEST_FILE_PATTERNS = [
  "scripts/*-tests.mjs",
  "scripts/*.test.mjs",
  "scripts/*-tests.py",
  "scripts/*_test.py",
  "scripts/*-tests.sh",
];
const SCRIPT_RUNNERS = new Set(["node", "python", "python3", "bash", "sh"]);

export function fencedBlocks(markdown) {
  const blocks = [];
  const pattern = /^```([^\n]*)\n([\s\S]*?)^```\s*$/gmu;
  for (const match of markdown.matchAll(pattern)) {
    blocks.push({ language: match[1].trim(), contents: match[2] });
  }
  return blocks;
}

// pnpm subcommands that take a PACKAGE or a path, not a script name. Without this
// set, `pnpm dlx shellcheck@4.1.0` resolves as a nested script called "dlx" and the
// checker reports a missing script that was never referenced. Leading flags are
// skipped for the same reason: `pnpm -s lint:ci` must resolve to lint:ci, not "-s".
const PNPM_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "bin",
  "config",
  "create",
  "dedupe",
  "deploy",
  "dlx",
  "env",
  "exec",
  "fetch",
  "import",
  "init",
  "install",
  "licenses",
  "link",
  "ls",
  "list",
  "outdated",
  "pack",
  "patch",
  "patch-commit",
  "prune",
  "publish",
  "rebuild",
  "recursive",
  "remove",
  "root",
  "server",
  "setup",
  "store",
  "unlink",
  "update",
  "why",
]);

export function pnpmReferences(command) {
  const matches = [
    ...command.matchAll(/(?:^|[;&|]\s*|\s)pnpm((?:\s+-{1,2}[\w-]+)*)(?:\s+run)?\s+([\w:@.-]+)/gu),
  ];
  return matches
    .map((match) => match[2])
    .filter((name) => !PNPM_SUBCOMMANDS.has(name) && !name.startsWith("-"));
}

function unquoteYamlScalar(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    const scalar = value.slice(1, -1);
    const backslash = String.fromCodePoint(92);
    let decoded = "";
    for (let index = 0; index < scalar.length; index += 1) {
      if (scalar[index] !== backslash) {
        decoded += scalar[index];
        continue;
      }
      const escape = scalar[index + 1];
      if (escape === String.fromCodePoint(34) || escape === backslash) decoded += escape;
      else if (escape === "n") decoded += "\n";
      else if (escape === "t") decoded += "\t";
      else {
        const length = { x: 2, u: 4, U: 8 }[escape];
        const hexadecimal = scalar.slice(index + 2, index + 2 + (length ?? 0));
        const valid = length !== undefined && /^[0-9a-fA-F]+$/u.test(hexadecimal);
        if (!valid || hexadecimal.length !== length) {
          return {
            error: `unsupported YAML escape in run: ${backslash}${escape ?? ""}`,
            value,
          };
        }
        const codePoint = Number.parseInt(hexadecimal, 16);
        if (codePoint > 0x10ffff) {
          return {
            error: `unsupported YAML escape in run: ${backslash}${escape}${hexadecimal}`,
            value,
          };
        }
        decoded += String.fromCodePoint(codePoint);
        index += length;
      }
      index += 1;
    }
    return { value: decoded };
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return { value: value.slice(1, -1).replaceAll("''", "'") };
  }
  return { value };
}

export function workflowSteps(workflow) {
  const steps = [];
  const lines = workflow.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const item = /^(\s*)-\s+(.*)$/u.exec(lines[index]);
    if (!item) continue;
    const indentation = item[1].length;
    const block = [{ line: item[2], index }];
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() && next.match(/^\s*/u)[0].length <= indentation) break;
      block.push({ line: next.slice(indentation + 2), index: end });
      end += 1;
    }

    const name = block.find(({ line }) => /^name:\s*/u.test(line))?.line.replace(/^name:\s*/u, "");
    const runEntry = block.find(({ line }) => /^run:\s*/u.test(line));
    if (!runEntry) continue;
    const runValue = runEntry.line.replace(/^run:\s*/u, "");
    const decodedRun = unquoteYamlScalar(runValue);
    let run = decodedRun.value;
    const scalar = /^([|>])(?:[0-9][-+]?|[-+]?[0-9]?)$/u.exec(runValue);
    if (scalar) {
      const runLineIndentation = lines[runEntry.index].match(/^\s*/u)[0].length;
      const commandLines = [];
      for (let lineIndex = runEntry.index + 1; lineIndex < end; lineIndex += 1) {
        const line = lines[lineIndex];
        if (line.trim() && line.match(/^\s*/u)[0].length <= runLineIndentation) break;
        commandLines.push(line.trim());
      }
      run = commandLines.join(scalar[1] === "|" ? "\n" : " ").trim();
    }
    const ifValue = block
      .find(({ line }) => /^if:\s*/u.test(line))
      ?.line.replace(/^if:\s*/u, "")
      .trim();
    const continueOnError = block
      .find(({ line }) => /^continue-on-error:\s*/u.test(line))
      ?.line.replace(/^continue-on-error:\s*/u, "")
      .trim();
    const shell = block
      .find(({ line }) => /^shell:\s*/u.test(line))
      ?.line.replace(/^shell:\s*/u, "")
      .trim();
    steps.push({
      name: name ?? "",
      run,
      runError: decodedRun.error,
      hasIf: ifValue !== undefined,
      ifValue,
      continueOnError,
      shell,
    });
  }
  return steps;
}

// Splits the first `steps:` sequence of a job body or composite action into step blocks. Unlike
// `workflowSteps`, it keeps `uses:` steps, because step-scoped pins need them. Comment lines are
// left out of every block's text, so a comment can never satisfy a pin.
export function workflowStepBlocks(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const indentationOf = (line) => line.match(/^\s*/u)[0].length;
  const stepsIndex = lines.findIndex((line) => /^\s*steps:\s*$/u.test(line));
  if (stepsIndex < 0) return [];
  const stepsIndentation = indentationOf(lines[stepsIndex]);
  const blocks = [];
  let itemIndentation;
  for (let index = stepsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      blocks.at(-1)?.lines.push(line);
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    const indentation = indentationOf(line);
    if (indentation <= stepsIndentation) break;
    const isItem = /^\s*-\s/u.test(line);
    itemIndentation ??= isItem ? indentation : undefined;
    if (itemIndentation === undefined || indentation < itemIndentation) break;
    if (isItem && indentation === itemIndentation) blocks.push({ lines: [line] });
    else blocks.at(-1).lines.push(line);
  }
  // The first `2` is the width of the "- " item marker, so a step's keys sit that far right of the
  // marker. The second `2` further down is the two-space nesting of `with:` entries.
  return blocks.map(({ lines: blockLines }) => {
    const keyIndentation = itemIndentation + 2;
    const fields = new Map();
    const withValues = new Map();
    let inWith = false;
    for (const [position, line] of blockLines.entries()) {
      const text = position === 0 ? line.slice(itemIndentation + 2) : line.slice(keyIndentation);
      const indentation = position === 0 ? 0 : indentationOf(line) - keyIndentation;
      if (indentation === 0) {
        const field = /^([\w-]+):\s*(.*)$/u.exec(text);
        inWith = field?.[1] === "with";
        if (field && !fields.has(field[1])) fields.set(field[1], field[2].trim());
      } else if (inWith && indentation === 2) {
        const entry = /^\s*([\w-]+):\s*(.*)$/u.exec(text);
        if (entry) withValues.set(entry[1], entry[2].trim());
      }
    }
    return {
      name: fields.get("name") ?? "",
      id: fields.get("id"),
      uses: fields.get("uses"),
      ifValue: fields.get("if"),
      continueOnError: fields.get("continue-on-error"),
      withValues,
      text: blockLines.join("\n"),
    };
  });
}

export function workflowJobs(workflow) {
  const jobs = [];
  const lines = workflow.split(/\r?\n/u);
  const jobsIndex = lines.findIndex((line) => /^\s*jobs:\s*$/u.test(line));
  if (jobsIndex < 0) return jobs;
  const jobsIndentation = lines[jobsIndex].match(/^\s*/u)[0].length;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.match(/^\s*/u)[0].length <= jobsIndentation) break;
    const job = new RegExp(`^\\s{${jobsIndentation + 2}}([\\w.-]+):\\s*$`, "u").exec(line);
    if (!job) continue;
    const indentation = jobsIndentation + 2;
    let end = index + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() && next.match(/^\s*/u)[0].length <= indentation) break;
      end += 1;
    }
    const properties = lines
      .slice(index + 1, end)
      .filter(
        (candidate) => candidate.trim() && candidate.match(/^\s*/u)[0].length === indentation + 2,
      );
    const valueFor = (key) =>
      properties
        .find((property) => new RegExp(`^\\s+${key}:\\s*`, "u").test(property))
        ?.replace(new RegExp(`^\\s+${key}:\\s*`, "u"), "")
        .trim();
    jobs.push({
      name: job[1],
      body: lines.slice(index + 1, end).join("\n"),
      ifValue: valueFor("if"),
      continueOnError: valueFor("continue-on-error"),
    });
    index = end - 1;
  }
  return jobs;
}

function testIncludes(viteConfig) {
  const testBlock = /test\s*:\s*\{[\s\S]*?include\s*:\s*\[([\s\S]*?)\]/u.exec(viteConfig);
  if (!testBlock) return [];
  return [...testBlock[1].matchAll(/["']([^"']+)["']/gu)].map((match) => match[1]);
}

function reviewPathGlobPatterns(pushSkill) {
  return fencedBlocks(pushSkill)
    .filter((block) => block.language === "text")
    .flatMap((block) =>
      block.contents
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#")),
    );
}

function receiptReferences(command) {
  return [
    ...command.matchAll(
      /(?:^|[;&|]\s*|\s)pnpm(?:\s+-{1,2}[\w-]+)*(?:\s+run)?\s+(gate:(?:ensure|run|check))\s+([\w.-]+)/gu,
    ),
  ].map((match) => ({ script: match[1], gate: match[2] }));
}

function routeCommands(commands, scripts, findings) {
  const routed = new Set();
  const pending = [];
  const enqueue = (command, source) => {
    pending.push(...pnpmReferences(command).map((name) => ({ name, source })));
    for (const { gate } of receiptReferences(command)) {
      if (!(gate in GATES)) {
        findings.push(
          `unknown receipt gate ${gate} in ${source}; register it in scripts/gate-receipt.mjs GATES or use a registered gate`,
        );
        continue;
      }
      pending.push(...pnpmReferences(GATES[gate]).map((name) => ({ name, source })));
    }
  };
  for (const { command, source } of commands) enqueue(command, source);

  while (pending.length > 0) {
    const { name, source } = pending.shift();
    if (!(name in scripts)) {
      findings.push(`${source} invokes missing package script ${name}`);
      continue;
    }
    if (routed.has(name)) continue;
    routed.add(name);
    enqueue(scripts[name], `package script ${name}`);
  }
  return routed;
}

function validateGateCommands(
  pushSkill,
  scripts,
  repoRoot,
  preReviewCommands = new Set(preReviewGateScheduleCommands()),
) {
  const findings = [];
  const directGateCommands = shellFencedCommandLines(pushSkill);
  const routedCommands = [];

  for (const line of directGateCommands) {
    const pnpmScripts = pnpmReferences(line);
    if (pnpmScripts.length > 0) {
      routedCommands.push({ command: line, source: `${PUSH_SKILL}: ${line}` });
      continue;
    }
    const cargo = /^cargo\s+(\w+)/u.exec(line);
    if (cargo && ALLOWED_CARGO_COMMANDS.has(cargo[1])) continue;
    if (/^pnpm\s+exec\s+/u.test(line) && preReviewCommands.has(line)) continue;
    const words = shellWords(line);
    if (SCRIPT_RUNNERS.has(words[0]) && words[1]) {
      const target = resolve(repoRoot, words[1]);
      const scriptsDirectory = resolve(repoRoot, "scripts");
      if (target !== scriptsDirectory && !target.startsWith(`${scriptsDirectory}${sep}`)) {
        findings.push(`gate command escapes scripts/: ${line}; use a path inside scripts/`);
      }
      continue;
    }
    findings.push(`unresolved gate command in ${PUSH_SKILL}: ${line}`);
  }

  const routed = routeCommands(routedCommands, scripts, findings);
  return { directGateCommands, findings, routed };
}

function shellFencedCommandLines(markdown, { includeCommentLines = false } = {}) {
  return fencedBlocks(markdown)
    .filter((block) => ["bash", "sh", "shell"].includes(block.language))
    .flatMap((block) =>
      block.contents
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line && (includeCommentLines || !line.startsWith("#"))),
    );
}

function validateGateRunnerScripts(scripts) {
  const findings = [];
  for (const [name, expected] of Object.entries(GATE_RUNNER_SCRIPTS)) {
    const actual = scripts[name];
    if (typeof actual === "string" && actual.trim() === expected) continue;
    findings.push(
      `package.json ${name} must invoke ${expected}; found ${JSON.stringify(actual ?? "<missing>")}`,
    );
  }
  return findings;
}

async function scriptFiles(repoRoot, listedPaths) {
  const files = [];
  for (const path of listedPaths) {
    if (!path.startsWith("scripts/")) continue;
    const absolute = resolve(repoRoot, path);
    let metadata;
    try {
      metadata = await stat(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!metadata.isFile()) continue;
    files.push({ executable: (metadata.mode & 0o111) !== 0, path });
  }
  return files;
}

function shellWords(command) {
  return [...command.matchAll(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/gu)].map((match) => {
    const word = match[0];
    return /^(["']).*\1$/su.test(word) ? word.slice(1, -1) : word;
  });
}

function commandSegments(command) {
  return command
    .split(/&&|\|\||[;|\n]/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function invokesGate(command, repoRoot) {
  if (pnpmReferences(command).length > 0) return true;
  const scriptsDirectory = resolve(repoRoot, "scripts");
  return commandSegments(command).some((segment) => {
    const words = shellWords(segment);
    if (words.length === 0) return false;
    const executable = words[0].replace(/^\.\//u, "");
    if (executable === "cargo" && ALLOWED_CARGO_COMMANDS.has(words[1])) return true;
    if (executable.startsWith("scripts/")) return true;
    if (!SCRIPT_RUNNERS.has(executable) || !words[1]) return false;
    const target = resolve(repoRoot, words[1]);
    return target === scriptsDirectory || target.startsWith(`${scriptsDirectory}${sep}`);
  });
}

function invokesScript(command, path) {
  for (const segment of commandSegments(command)) {
    const words = shellWords(segment);
    if (words.length === 0) continue;
    const executable = words[0].replace(/^\.\//u, "");
    if (executable === path) return true;
    if (SCRIPT_RUNNERS.has(executable) && words.slice(1).includes(path)) return true;
  }
  return false;
}

function defaultListFiles(repoRoot, pathspec = ".") {
  return listWorkingTreeFiles({ workspaceRoot: repoRoot, pathspec });
}

export async function checkGateRouting(
  repoRoot,
  { paths = undefined, listFiles = defaultListFiles } = {},
) {
  const listed = listFiles(repoRoot);
  const [packageText, pushSkill, workflow, viteConfig, files] = await Promise.all([
    readFile(resolve(repoRoot, PACKAGE_JSON), "utf8"),
    readFile(resolve(repoRoot, PUSH_SKILL), "utf8"),
    readFile(resolve(repoRoot, TEST_WORKFLOW), "utf8"),
    readFile(resolve(repoRoot, VITE_CONFIG), "utf8"),
    scriptFiles(repoRoot, listed),
  ]);
  const scripts = JSON.parse(packageText).scripts ?? {};
  const { directGateCommands, findings, routed } = validateGateCommands(
    pushSkill,
    scripts,
    repoRoot,
  );
  findings.push(...validateGateRunnerScripts(scripts));

  if (!(CONTRACT_GATE in scripts)) {
    findings.push(`package.json is missing ${CONTRACT_GATE}; add the shared contract chain`);
  }

  // Only the CONTENT is asserted here. A missing script is already caught by the
  // routing rule above: the push skill invokes `pnpm findings:kit:check`, and a
  // command naming a package script that does not exist is reported there. A
  // second missing-script rule would duplicate it and would fire on fixtures
  // that legitimately model only part of the manifest.
  const kitParity = scripts[KIT_PARITY_SCRIPT];
  if (typeof kitParity === "string") {
    if (kitParity.trim() !== KIT_PARITY_COMMAND) {
      findings.push(
        `${KIT_PARITY_SCRIPT} must be exactly ${KIT_PARITY_COMMAND}, not ${kitParity}; ` +
          "the gate runs the released kit on PATH",
      );
    }
    if (kitParity.includes(KIT_WORKBENCH_PATH)) {
      findings.push(
        `${KIT_PARITY_SCRIPT} names the kit workbench path ${KIT_WORKBENCH_PATH}; ` +
          "use the released kit on PATH so an unreleased edit cannot reach this gate",
      );
    }
  }
  if (pushSkill.includes(`${KIT_WORKBENCH_PATH}/bin/kit`)) {
    findings.push(
      `${PUSH_SKILL} names the kit workbench driver ${KIT_WORKBENCH_PATH}/bin/kit; ` +
        "the kit-parity gate runs the released kit on PATH",
    );
  }

  const steps = workflowSteps(workflow);
  for (const step of steps) {
    if (step.runError) findings.push(step.runError);
  }
  for (const job of workflowJobs(workflow)) {
    if (job.ifValue !== undefined) {
      findings.push(
        `${TEST_WORKFLOW} workflow job has if: ${JSON.stringify(job.ifValue)}: ${job.name}`,
      );
    }
    if (job.continueOnError !== undefined && job.continueOnError !== "false") {
      findings.push(
        `${TEST_WORKFLOW} workflow job has continue-on-error: ${JSON.stringify(job.continueOnError)}: ${job.name}`,
      );
    }
  }
  const workflowContractSteps = steps.filter((step) =>
    pnpmReferences(step.run).includes(CONTRACT_GATE),
  );
  if (workflowContractSteps.length !== 1) {
    findings.push(
      `${TEST_WORKFLOW} must run ${CONTRACT_GATE} exactly once; replace duplicate tooling steps with one contract-gate step`,
    );
  } else if (workflowContractSteps[0].run.trim() !== `pnpm ${CONTRACT_GATE}`) {
    findings.push(`${TEST_WORKFLOW} contract-gate step must be exactly pnpm ${CONTRACT_GATE}`);
  }

  const workflowCommands = steps.map((step) => step.run);
  const workflowFindings = [];
  const workflowRouted = routeCommands(
    workflowCommands.map((command) => ({ command, source: TEST_WORKFLOW })),
    scripts,
    workflowFindings,
  );
  findings.push(...workflowFindings);

  const contractFindings = [];
  const contractRouted =
    CONTRACT_GATE in scripts
      ? routeCommands(
          [{ command: `pnpm ${CONTRACT_GATE}`, source: `package script ${CONTRACT_GATE}` }],
          scripts,
          contractFindings,
        )
      : new Set();
  findings.push(...contractFindings);
  contractRouted.delete(CONTRACT_GATE);
  const pushCommands = pushGateScheduleCommands();
  const preReviewCommands = preReviewGateScheduleCommands();
  const scheduledCommands = [...pushCommands, ...preReviewCommands];
  const scheduledRouted = routeCommands(
    scheduledCommands.map((command) => ({ command, source: "gate scheduler" })),
    scripts,
    findings,
  );
  const pushRouted = routeCommands(
    pushCommands.map((command) => ({ command, source: "push gate scheduler" })),
    scripts,
    findings,
  );
  if (pnpmReferences(scripts[CONTRACT_GATE] ?? "")[0] !== "mutation:guard:check") {
    findings.push(`${CONTRACT_GATE} must run mutation:guard:check first`);
  }

  const directWorkflowScripts = new Set(steps.flatMap((step) => pnpmReferences(step.run)));
  for (const name of [...directWorkflowScripts].sort()) {
    if (pushRouted.has(name)) continue;
    findings.push(`workflow-routed package script ${name} is absent from the push gate scheduler`);
  }
  for (const name of CI_REQUIRED_SCRIPTS) {
    if (!directWorkflowScripts.has(name)) {
      findings.push(
        `CI_REQUIRED_SCRIPTS key ${name} is absent from ${TEST_WORKFLOW}; restore the workflow step`,
      );
    }
  }

  const gateLines = new Set([...directGateCommands, ...scheduledCommands]);
  const routedPackageSegments = new Set(
    [...new Set([...routed, ...scheduledRouted])].flatMap((name) =>
      commandSegments(scripts[name] ?? ""),
    ),
  );
  for (const command of gateLines) {
    for (const { gate } of receiptReferences(command)) {
      if (gate in GATES) {
        for (const segment of commandSegments(GATES[gate])) routedPackageSegments.add(segment);
      }
    }
  }
  for (const step of steps) {
    if (step.hasIf && invokesGate(step.run, repoRoot)) {
      findings.push(
        `${TEST_WORKFLOW} workflow step has if: ${JSON.stringify(step.ifValue)}: ${step.name || step.run}`,
      );
    }
    if (
      step.continueOnError !== undefined &&
      step.continueOnError !== "false" &&
      invokesGate(step.run, repoRoot)
    ) {
      findings.push(
        `${TEST_WORKFLOW} workflow step ignores the gate's exit status with continue-on-error: ${JSON.stringify(step.continueOnError)}: ${step.name || step.run}`,
      );
    }
    if (invokesGate(step.run, repoRoot) && /\|\||[;|]/u.test(step.run)) {
      findings.push(
        `${TEST_WORKFLOW} workflow step neutralises or chains gate exit codes: ${step.name || step.run}`,
      );
    }
    for (const segment of commandSegments(step.run)) {
      if (!invokesGate(segment, repoRoot)) continue;
      if (gateLines.has(segment) || routedPackageSegments.has(segment)) continue;
      findings.push(
        `workflow command must exactly match a scheduled command, skill command or routed package-script segment: ${segment}`,
      );
    }
  }

  for (const step of steps) {
    for (const name of pnpmReferences(step.run)) {
      if (contractRouted.has(name)) {
        findings.push(
          `contract-gate member ${name} is also invoked directly by ${TEST_WORKFLOW}; keep it only in ${CONTRACT_GATE}`,
        );
      }
    }
  }

  const allRouted = new Set([...routed, ...scheduledRouted, ...workflowRouted]);

  for (const name of Object.keys(scripts).sort()) {
    if (/:(?:check|test)$/u.test(name) && !allRouted.has(name)) {
      findings.push(
        `package script ${name} is not routed through ${PUSH_SKILL} or ${TEST_WORKFLOW}`,
      );
    }
  }

  const includes = testIncludes(viteConfig);
  const isRouted = (path) =>
    directGateCommands.some((command) => invokesScript(command, path)) ||
    Object.entries(scripts).some(
      ([name, command]) => allRouted.has(name) && invokesScript(command, path),
    );
  for (const { path } of files.filter((file) => matches(file.path, TEST_FILE_PATTERNS))) {
    if (!isRouted(path) && !matches(path, includes)) {
      findings.push(
        `test file ${path} is not reachable from a routed package script or Vitest include`,
      );
    }
  }

  for (const { path } of files.filter(
    (file) => file.executable || /^scripts\/check-.*\.mjs$/u.test(file.path),
  )) {
    if (!isRouted(path) && !matches(path, includes)) {
      findings.push(
        `checker file ${path} is not reachable from a routed package script or Vitest include`,
      );
    }
  }

  const repositoryPaths = paths ?? listed;
  for (const pattern of reviewPathGlobPatterns(pushSkill)) {
    const matcher = globToRegExp(pattern);
    if (!repositoryPaths.some((path) => matcher.test(path))) {
      findings.push(`sensitive-path glob ${pattern} matches no file`);
    }
  }

  return findings;
}

function parseArguments(argumentsList) {
  const options = { repoRoot: "." };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--repo-root") options.repoRoot = argumentsList[++index];
    else throw new Error(`Unknown argument: ${argument}`);
    if (!options.repoRoot) throw new Error(`Missing value for ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const findings = await checkGateRouting(resolve(process.cwd(), options.repoRoot));
  if (findings.length > 0) {
    console.error("Gate routing check: FAIL");
    for (const finding of findings) console.error(`  * ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log("Gate routing check: OK");
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
